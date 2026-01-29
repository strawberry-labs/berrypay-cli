import * as nanocurrency from "nanocurrency";
import { wallet as nanoWallet, block, tools } from "nanocurrency-web";

export interface WalletConfig {
  seed?: string;
  rpcUrl?: string;
}

export interface AccountInfo {
  address: string;
  balance: string;
  balanceNano: string;
  pending: string;
  representative: string;
  frontier: string;
}

export interface PendingBlock {
  hash: string;
  amount: string;
  source: string;
}

export interface SendResult {
  hash: string;
  block: object;
}

export interface ReceiveResult {
  hash: string;
  amount: string;
}

const DEFAULT_RPC_URL = "https://uk1.public.xnopay.com/proxy";
const DEFAULT_REPRESENTATIVE =
  "nano_1xnopay1bfmyx5eit8ut4gg1j488kt8bjukijerbn37jh3wdm81y6mxjg8qj";

export class BerryPayWallet {
  private seed: string;
  private rpcUrl: string;
  private accounts: Map<number, { privateKey: string; publicKey: string; address: string }> =
    new Map();

  constructor(config: WalletConfig = {}) {
    this.seed = config.seed ?? this.generateSeed();
    this.rpcUrl = config.rpcUrl ?? DEFAULT_RPC_URL;
    // Derive account 0 by default
    this.deriveAccount(0);
  }

  private generateSeed(): string {
    const wallet = nanoWallet.generate();
    return wallet.seed;
  }

  getSeed(): string {
    return this.seed;
  }

  deriveAccount(index: number): string {
    if (this.accounts.has(index)) {
      return this.accounts.get(index)!.address;
    }

    const accounts = nanoWallet.accounts(this.seed, index, index);
    const account = accounts[0];

    this.accounts.set(index, {
      privateKey: account.privateKey,
      publicKey: account.publicKey,
      address: account.address,
    });

    return account.address;
  }

  getAddress(index = 0): string {
    return this.deriveAccount(index);
  }

  private getPrivateKey(index = 0): string {
    this.deriveAccount(index);
    return this.accounts.get(index)!.privateKey;
  }

  private async rpcCall(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = await fetch(this.rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...params }),
    });

    if (!response.ok) {
      throw new Error(`RPC error: ${response.statusText}`);
    }

    const data = await response.json();

    if (data.error) {
      throw new Error(`RPC error: ${data.error}`);
    }

    return data;
  }

  async getBalance(accountIndex = 0): Promise<{ balance: string; pending: string }> {
    const address = this.getAddress(accountIndex);

    try {
      const result = (await this.rpcCall("account_balance", { account: address })) as {
        balance: string;
        pending: string;
        receivable?: string;
      };

      return {
        balance: result.balance,
        pending: result.receivable ?? result.pending,
      };
    } catch {
      // Account might not be opened yet
      return { balance: "0", pending: "0" };
    }
  }

  async getAccountInfo(accountIndex = 0): Promise<AccountInfo | null> {
    const address = this.getAddress(accountIndex);

    try {
      const result = (await this.rpcCall("account_info", {
        account: address,
        representative: true,
      })) as {
        balance: string;
        pending: string;
        representative: string;
        frontier: string;
      };

      return {
        address,
        balance: result.balance,
        balanceNano: tools.convert(result.balance, "RAW", "NANO"),
        pending: result.pending,
        representative: result.representative,
        frontier: result.frontier,
      };
    } catch {
      return null;
    }
  }

  async getPendingBlocks(accountIndex = 0, count = 10): Promise<PendingBlock[]> {
    const address = this.getAddress(accountIndex);

    try {
      const result = (await this.rpcCall("pending", {
        account: address,
        count: count.toString(),
        source: true,
      })) as {
        blocks: Record<string, { amount: string; source: string } | string> | string;
      };

      if (!result.blocks || typeof result.blocks === "string") {
        return [];
      }

      // Handle both formats: { hash: { amount, source } } and { hash: amount }
      return Object.entries(result.blocks).map(([hash, info]) => {
        if (typeof info === "string") {
          // Old format: { hash: amount }
          return { hash, amount: info, source: "" };
        }
        return {
          hash,
          amount: info.amount,
          source: info.source,
        };
      });
    } catch {
      return [];
    }
  }

  async send(toAddress: string, amountRaw: string, accountIndex = 0): Promise<SendResult> {
    const fromAddress = this.getAddress(accountIndex);
    const privateKey = this.getPrivateKey(accountIndex);

    // Get current account info
    const info = await this.getAccountInfo(accountIndex);
    if (!info) {
      throw new Error("Account not opened. Receive some Nano first.");
    }

    // Check balance
    const balance = BigInt(info.balance);
    const amount = BigInt(amountRaw);

    if (amount > balance) {
      throw new Error(
        `Insufficient balance. Have: ${tools.convert(info.balance, "RAW", "NANO")} XNO`
      );
    }

    // Create send block
    const sendBlock = block.send({
      walletBalanceRaw: info.balance,
      fromAddress: fromAddress,
      toAddress: toAddress,
      representativeAddress: info.representative,
      frontier: info.frontier,
      amountRaw: amountRaw,
      work: await this.getWork(info.frontier),
    }, privateKey);

    // Process block
    const result = (await this.rpcCall("process", {
      json_block: "true",
      subtype: "send",
      block: sendBlock,
    })) as { hash: string };

    return {
      hash: result.hash,
      block: sendBlock,
    };
  }

  async receive(pendingHash: string, amountRaw: string, accountIndex = 0): Promise<ReceiveResult> {
    const address = this.getAddress(accountIndex);
    const privateKey = this.getPrivateKey(accountIndex);

    // Get current account info
    const info = await this.getAccountInfo(accountIndex);

    let receiveBlock;
    let workHash: string;

    if (info) {
      // Existing account - create receive block
      workHash = info.frontier;
      receiveBlock = block.receive({
        walletBalanceRaw: info.balance,
        toAddress: address,
        representativeAddress: info.representative,
        frontier: info.frontier,
        transactionHash: pendingHash,
        amountRaw: amountRaw,
        work: await this.getWork(workHash),
      }, privateKey);
    } else {
      // New account - create open block
      const publicKey = this.accounts.get(accountIndex)!.publicKey;
      workHash = publicKey;

      receiveBlock = block.receive({
        walletBalanceRaw: "0",
        toAddress: address,
        representativeAddress: DEFAULT_REPRESENTATIVE,
        frontier: "0".repeat(64),
        transactionHash: pendingHash,
        amountRaw: amountRaw,
        work: await this.getWork(workHash),
      }, privateKey);
    }

    // Process block
    const result = (await this.rpcCall("process", {
      json_block: "true",
      subtype: info ? "receive" : "open",
      block: receiveBlock,
    })) as { hash: string };

    return {
      hash: result.hash,
      amount: amountRaw,
    };
  }

  async receivePending(accountIndex = 0): Promise<ReceiveResult[]> {
    const pending = await this.getPendingBlocks(accountIndex);
    const results: ReceiveResult[] = [];

    if (pending.length === 0) {
      // Debug: check if there's actually pending via balance check
      const { pending: pendingRaw } = await this.getBalance(accountIndex);
      if (BigInt(pendingRaw) > BigInt(0)) {
        console.error(`Warning: Balance shows ${pendingRaw} pending but getPendingBlocks returned empty`);
      }
    }

    for (const pendingBlock of pending) {
      try {
        const result = await this.receive(pendingBlock.hash, pendingBlock.amount, accountIndex);
        results.push(result);
      } catch (error) {
        // Re-throw to make errors visible
        throw new Error(`Failed to receive ${pendingBlock.hash}: ${(error as Error).message}`);
      }
    }

    return results;
  }

  private async getWork(hash: string): Promise<string> {
    // Use the xnopay node to generate work
    const result = (await this.rpcCall("work_generate", {
      hash,
    })) as { work: string };

    return result.work;
  }

  static validateAddress(address: string): boolean {
    return nanocurrency.checkAddress(address);
  }

  static rawToNano(raw: string): string {
    return tools.convert(raw, "RAW", "NANO");
  }

  static nanoToRaw(nano: string): string {
    return tools.convert(nano, "NANO", "RAW");
  }
}

export function createWallet(seed?: string): BerryPayWallet {
  return new BerryPayWallet({ seed });
}
