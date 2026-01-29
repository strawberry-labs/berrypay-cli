import { EventEmitter } from "events";
import { BerryPayWallet } from "./wallet.js";
import { BlockLatticeMonitor, PaymentEvent } from "./monitor.js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export type ChargeStatus = "pending" | "partial" | "completed" | "expired" | "swept";

export interface Charge {
  id: string;
  address: string;
  accountIndex: number;
  amountRaw: string;
  amountNano: string;
  receivedRaw: string;
  receivedNano: string;
  status: ChargeStatus;
  transactions: PaymentTransaction[];
  createdAt: Date;
  expiresAt: Date;
  completedAt?: Date;
  sweptAt?: Date;
  sweepTxHash?: string;
  webhookUrl?: string;
  webhookSent?: boolean;
  metadata?: Record<string, unknown>;
}

export interface PaymentTransaction {
  hash: string;
  from: string;
  amountRaw: string;
  amountNano: string;
  timestamp: Date;
}

export interface ProcessorConfig {
  wallet: BerryPayWallet;
  mainAddress?: string;
  mainAccountIndex?: number;
  startingIndex?: number;
  autoSweep?: boolean;
  wsUrl?: string;
  persistPath?: string; // Path to persist charges
}

// Persistence helpers
const DEFAULT_PERSIST_PATH = path.join(os.homedir(), ".berrypay", "charges.json");

interface PersistedState {
  nextAccountIndex: number;
  charges: Charge[];
  updatedAt: string;
}

function loadPersistedState(filePath: string): PersistedState | null {
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, "utf-8");
      const state = JSON.parse(data) as PersistedState;
      // Convert date strings back to Date objects
      state.charges = state.charges.map((c) => ({
        ...c,
        createdAt: new Date(c.createdAt),
        expiresAt: new Date(c.expiresAt),
        completedAt: c.completedAt ? new Date(c.completedAt) : undefined,
        sweptAt: c.sweptAt ? new Date(c.sweptAt) : undefined,
        transactions: c.transactions.map((t) => ({
          ...t,
          timestamp: new Date(t.timestamp),
        })),
      }));
      return state;
    }
  } catch (err) {
    console.error("Failed to load persisted state:", err);
  }
  return null;
}

function savePersistedState(filePath: string, state: PersistedState): void {
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error("Failed to save persisted state:", err);
  }
}

export interface CreateChargeOptions {
  amountNano: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  webhookUrl?: string;
}

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export class PaymentProcessor extends EventEmitter {
  private wallet: BerryPayWallet;
  private monitor: BlockLatticeMonitor;
  private charges: Map<string, Charge> = new Map();
  private addressToChargeId: Map<string, string> = new Map();
  private nextAccountIndex: number;
  private mainAccountIndex: number;
  private autoSweep: boolean;
  private isRunning = false;
  private expiryCheckInterval: NodeJS.Timeout | null = null;
  private persistPath: string;
  private saveDebounceTimer: NodeJS.Timeout | null = null;

  constructor(config: ProcessorConfig) {
    super();
    this.wallet = config.wallet;
    this.mainAccountIndex = config.mainAccountIndex ?? 0;
    this.autoSweep = config.autoSweep ?? true;
    this.persistPath = config.persistPath ?? DEFAULT_PERSIST_PATH;

    // Load persisted state
    const persisted = loadPersistedState(this.persistPath);
    if (persisted) {
      this.nextAccountIndex = persisted.nextAccountIndex;
      for (const charge of persisted.charges) {
        this.charges.set(charge.id, charge);
        this.addressToChargeId.set(charge.address, charge.id);
      }
      this.emit("state:loaded", { chargeCount: persisted.charges.length });
    } else {
      this.nextAccountIndex = config.startingIndex ?? 1000; // Start ephemeral at high index
    }

    this.monitor = new BlockLatticeMonitor({
      wsUrl: config.wsUrl,
    });

    this.setupMonitorListeners();
  }

  private persistState(): void {
    // Debounce saves to avoid excessive disk writes
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
    }
    this.saveDebounceTimer = setTimeout(() => {
      const state: PersistedState = {
        nextAccountIndex: this.nextAccountIndex,
        charges: Array.from(this.charges.values()),
        updatedAt: new Date().toISOString(),
      };
      savePersistedState(this.persistPath, state);
      this.saveDebounceTimer = null;
    }, 500);
  }

  // Force immediate save (for critical updates)
  private persistStateNow(): void {
    if (this.saveDebounceTimer) {
      clearTimeout(this.saveDebounceTimer);
      this.saveDebounceTimer = null;
    }
    const state: PersistedState = {
      nextAccountIndex: this.nextAccountIndex,
      charges: Array.from(this.charges.values()),
      updatedAt: new Date().toISOString(),
    };
    savePersistedState(this.persistPath, state);
  }

  private setupMonitorListeners(): void {
    this.monitor.on("payment", (payment: PaymentEvent) => {
      this.handlePayment(payment);
    });

    this.monitor.on("connected", () => {
      this.emit("connected");
    });

    this.monitor.on("disconnected", () => {
      this.emit("disconnected");
    });

    this.monitor.on("error", (error) => {
      this.emit("error", error);
    });
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // Re-subscribe to all active charges (from persisted state)
    const activeCharges = this.listActiveCharges();
    for (const charge of activeCharges) {
      this.monitor.addAccount(charge.address);
    }

    // Check for missed payments on startup (poll blockchain)
    await this.checkMissedPayments();

    // Start WebSocket monitor
    await this.monitor.start();

    // Start expiry checker
    this.expiryCheckInterval = setInterval(() => {
      this.checkExpiredCharges();
    }, 10000); // Check every 10 seconds

    this.emit("started", { resumedCharges: activeCharges.length });
  }

  /**
   * Check blockchain for any payments that occurred while offline
   */
  private async checkMissedPayments(): Promise<void> {
    const activeCharges = this.listActiveCharges();

    for (const charge of activeCharges) {
      try {
        // Check for pending blocks on this ephemeral address
        const pending = await this.wallet.getPendingBlocks(charge.accountIndex);

        if (pending.length > 0) {
          this.emit("recovery:found", { chargeId: charge.id, pendingCount: pending.length });

          // Receive all pending
          for (const p of pending) {
            try {
              await this.wallet.receive(p.hash, p.amount, charge.accountIndex);

              // Update charge state
              const tx: PaymentTransaction = {
                hash: p.hash,
                from: p.source,
                amountRaw: p.amount,
                amountNano: BerryPayWallet.rawToNano(p.amount),
                timestamp: new Date(),
              };
              charge.transactions.push(tx);

              const newReceived = BigInt(charge.receivedRaw) + BigInt(p.amount);
              charge.receivedRaw = newReceived.toString();
              charge.receivedNano = BerryPayWallet.rawToNano(charge.receivedRaw);

              this.emit("charge:payment", { charge, transaction: tx });
            } catch (err) {
              this.emit("error", err);
            }
          }

          // Check if now fully paid
          if (BigInt(charge.receivedRaw) >= BigInt(charge.amountRaw)) {
            charge.status = "completed";
            charge.completedAt = new Date();
            this.persistStateNow();
            this.emit("charge:completed", charge);

            if (this.autoSweep) {
              await this.sweepCharge(charge.id);
            }
          } else if (BigInt(charge.receivedRaw) > BigInt(0)) {
            charge.status = "partial";
            this.persistState();
          }
        }
      } catch (err) {
        this.emit("error", err);
      }
    }
  }

  stop(): void {
    this.isRunning = false;
    this.monitor.stop();

    if (this.expiryCheckInterval) {
      clearInterval(this.expiryCheckInterval);
      this.expiryCheckInterval = null;
    }

    this.emit("stopped");
  }

  async createCharge(options: CreateChargeOptions): Promise<Charge> {
    const id = this.generateChargeId();
    const accountIndex = this.nextAccountIndex++;
    const address = this.wallet.deriveAccount(accountIndex);
    const amountRaw = BerryPayWallet.nanoToRaw(options.amountNano);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const charge: Charge = {
      id,
      address,
      accountIndex,
      amountRaw,
      amountNano: options.amountNano,
      receivedRaw: "0",
      receivedNano: "0",
      status: "pending",
      transactions: [],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + timeoutMs),
      webhookUrl: options.webhookUrl,
      metadata: options.metadata,
    };

    this.charges.set(id, charge);
    this.addressToChargeId.set(address, id);

    // Subscribe to this address for payment notifications
    this.monitor.addAccount(address);

    // Persist state
    this.persistState();

    this.emit("charge:created", charge);
    return charge;
  }

  getCharge(id: string): Charge | undefined {
    return this.charges.get(id);
  }

  getChargeByAddress(address: string): Charge | undefined {
    const id = this.addressToChargeId.get(address);
    return id ? this.charges.get(id) : undefined;
  }

  listCharges(status?: ChargeStatus): Charge[] {
    const charges = Array.from(this.charges.values());
    if (status) {
      return charges.filter((c) => c.status === status);
    }
    return charges;
  }

  listActiveCharges(): Charge[] {
    return this.listCharges().filter(
      (c) => c.status === "pending" || c.status === "partial"
    );
  }

  private async handlePayment(payment: PaymentEvent): Promise<void> {
    const charge = this.getChargeByAddress(payment.to);
    if (!charge) return;

    // Ignore if already completed or expired
    if (charge.status === "completed" || charge.status === "expired" || charge.status === "swept") {
      return;
    }

    // Record the transaction
    const tx: PaymentTransaction = {
      hash: payment.hash,
      from: payment.from,
      amountRaw: payment.amount,
      amountNano: payment.amountNano,
      timestamp: payment.timestamp,
    };

    charge.transactions.push(tx);

    // Update received amount
    const previousReceived = BigInt(charge.receivedRaw);
    const newReceived = previousReceived + BigInt(payment.amount);
    charge.receivedRaw = newReceived.toString();
    charge.receivedNano = BerryPayWallet.rawToNano(charge.receivedRaw);

    this.emit("charge:payment", { charge, transaction: tx });

    // Check if fully paid
    const requiredAmount = BigInt(charge.amountRaw);
    if (newReceived >= requiredAmount) {
      charge.status = "completed";
      charge.completedAt = new Date();
      this.persistStateNow(); // Critical update - save immediately
      this.emit("charge:completed", charge);

      // Auto-sweep if enabled
      if (this.autoSweep) {
        await this.sweepCharge(charge.id);
      }
    } else {
      charge.status = "partial";
      this.persistState();
      this.emit("charge:partial", charge);
    }
  }

  private async callWebhook(charge: Charge, sweepHash: string, amountRaw: string): Promise<void> {
    if (!charge.webhookUrl) return;

    const payload = {
      event: "charge.completed",
      charge: {
        id: charge.id,
        address: charge.address,
        amountNano: charge.amountNano,
        amountRaw: charge.amountRaw,
        receivedNano: charge.receivedNano,
        receivedRaw: charge.receivedRaw,
        status: charge.status,
        sweepTxHash: sweepHash,
        sweptAmountNano: BerryPayWallet.rawToNano(amountRaw),
        sweptAmountRaw: amountRaw,
        completedAt: charge.completedAt?.toISOString(),
        sweptAt: charge.sweptAt?.toISOString(),
        metadata: charge.metadata,
      },
      timestamp: new Date().toISOString(),
    };

    try {
      const response = await fetch(charge.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        charge.webhookSent = true;
        this.persistStateNow();
        this.emit("webhook:sent", { chargeId: charge.id, url: charge.webhookUrl });
      } else {
        this.emit("webhook:failed", {
          chargeId: charge.id,
          url: charge.webhookUrl,
          status: response.status,
          statusText: response.statusText,
        });
      }
    } catch (error) {
      this.emit("webhook:error", {
        chargeId: charge.id,
        url: charge.webhookUrl,
        error: (error as Error).message,
      });
    }
  }

  async sweepCharge(chargeId: string): Promise<{ hash: string; amount: string } | null> {
    const charge = this.charges.get(chargeId);
    if (!charge) {
      throw new Error("Charge not found");
    }

    // Already swept
    if (charge.status === "swept") {
      return null;
    }

    try {
      // First receive any pending transactions on the ephemeral address
      await this.wallet.receivePending(charge.accountIndex);

      // Get the balance after receiving
      const { balance } = await this.wallet.getBalance(charge.accountIndex);

      if (balance === "0" || BigInt(balance) === BigInt(0)) {
        // Nothing to sweep
        return null;
      }

      // Send all funds to main address
      const mainAddress = this.wallet.getAddress(this.mainAccountIndex);
      const result = await this.wallet.send(mainAddress, balance, charge.accountIndex);

      charge.status = "swept";
      charge.sweptAt = new Date();
      charge.sweepTxHash = result.hash;

      // Cleanup: remove from address map (keep charge for history)
      this.addressToChargeId.delete(charge.address);
      this.monitor.removeAccount(charge.address);

      // Persist immediately after sweep
      this.persistStateNow();

      this.emit("charge:swept", {
        charge,
        hash: result.hash,
        amount: balance,
        amountNano: BerryPayWallet.rawToNano(balance),
      });

      // Call webhook if configured
      if (charge.webhookUrl && !charge.webhookSent) {
        await this.callWebhook(charge, result.hash, balance);
      }

      return { hash: result.hash, amount: balance };
    } catch (error) {
      this.emit("error", error);
      throw error;
    }
  }

  async checkChargeStatus(chargeId: string): Promise<{
    charge: Charge;
    isPaid: boolean;
    remainingRaw: string;
    remainingNano: string;
  }> {
    const charge = this.charges.get(chargeId);
    if (!charge) {
      throw new Error("Charge not found");
    }

    // Also check blockchain for any missed payments
    const pending = await this.wallet.getPendingBlocks(charge.accountIndex);
    const { balance } = await this.wallet.getBalance(charge.accountIndex);

    const totalReceived = BigInt(balance) +
      pending.reduce((sum, p) => sum + BigInt(p.amount), BigInt(0));

    const required = BigInt(charge.amountRaw);
    const remaining = required > totalReceived ? required - totalReceived : BigInt(0);
    const isPaid = totalReceived >= required;

    return {
      charge,
      isPaid,
      remainingRaw: remaining.toString(),
      remainingNano: BerryPayWallet.rawToNano(remaining.toString()),
    };
  }

  private checkExpiredCharges(): void {
    const now = new Date();
    let stateChanged = false;

    for (const charge of this.charges.values()) {
      if (
        (charge.status === "pending" || charge.status === "partial") &&
        charge.expiresAt < now
      ) {
        charge.status = "expired";
        stateChanged = true;
        this.emit("charge:expired", charge);

        // If there was partial payment, we should still sweep it
        if (BigInt(charge.receivedRaw) > BigInt(0) && this.autoSweep) {
          this.sweepCharge(charge.id).catch((err) => {
            this.emit("error", err);
          });
        } else {
          // Cleanup address tracking for empty expired charges
          this.addressToChargeId.delete(charge.address);
          this.monitor.removeAccount(charge.address);
        }
      }
    }

    if (stateChanged) {
      this.persistState();
    }
  }

  deleteCharge(chargeId: string): boolean {
    const charge = this.charges.get(chargeId);
    if (!charge) return false;

    // Only allow deleting swept or expired (with no funds) charges
    if (charge.status !== "swept" &&
        !(charge.status === "expired" && BigInt(charge.receivedRaw) === BigInt(0))) {
      throw new Error("Cannot delete charge with pending funds. Sweep first.");
    }

    this.addressToChargeId.delete(charge.address);
    this.charges.delete(chargeId);
    this.monitor.removeAccount(charge.address);

    this.persistState();
    this.emit("charge:deleted", charge);
    return true;
  }

  cleanupSweptCharges(): number {
    let count = 0;
    for (const [id, charge] of this.charges.entries()) {
      if (charge.status === "swept") {
        this.charges.delete(id);
        count++;
      }
    }
    if (count > 0) {
      this.persistState();
    }
    return count;
  }

  getMainAddress(): string {
    return this.wallet.getAddress(this.mainAccountIndex);
  }

  private generateChargeId(): string {
    return `chg_${crypto.randomBytes(12).toString("hex")}`;
  }

  // Export charges for persistence (optional)
  exportCharges(): Charge[] {
    return Array.from(this.charges.values());
  }

  // Import charges (for restoring state)
  importCharges(charges: Charge[]): void {
    for (const charge of charges) {
      this.charges.set(charge.id, charge);
      this.addressToChargeId.set(charge.address, charge.id);

      // Re-subscribe to active charges
      if (charge.status === "pending" || charge.status === "partial") {
        this.monitor.addAccount(charge.address);
      }
    }
  }
}

export function createProcessor(config: ProcessorConfig): PaymentProcessor {
  return new PaymentProcessor(config);
}
