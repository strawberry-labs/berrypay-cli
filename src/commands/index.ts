import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import * as path from "path";
import QRCode from "qrcode";
import { BerryPayWallet } from "../wallet.js";
import { BlockLatticeMonitor } from "../monitor.js";
import { PaymentProcessor, Charge } from "../processor.js";
import {
  saveSeed,
  getSeed,
  hasSeed,
  clearSeed,
  getRpcUrl,
  getWsUrl,
  setRpcUrl,
  setWsUrl,
  getConfigPath,
} from "../config.js";

const program = new Command();

function getWallet(): BerryPayWallet {
  const seed = getSeed();
  if (!seed) {
    console.error(chalk.red("No wallet found."));
    console.error(chalk.gray("Run 'berrypay init' to create one, or set BERRYPAY_SEED env var."));
    process.exit(1);
  }

  return new BerryPayWallet({ seed, rpcUrl: getRpcUrl() });
}

program
  .name("berrypay")
  .description("Nano (XNO) wallet CLI for AI agents and payment processing")
  .version("0.1.0");

program
  .command("init")
  .description("Create a new wallet")
  .option("--force", "Overwrite existing wallet")
  .action(async (options) => {
    if (hasSeed() && !options.force) {
      console.log(chalk.yellow("Wallet already exists. Use --force to overwrite."));
      const seed = getSeed();
      const wallet = new BerryPayWallet({ seed: seed! });
      console.log(chalk.cyan("Address:"), wallet.getAddress());
      return;
    }

    const wallet = new BerryPayWallet();
    const seed = wallet.getSeed();
    const address = wallet.getAddress();

    saveSeed(seed);

    console.log(chalk.green("\nWallet created!\n"));
    console.log(chalk.cyan("Seed:"), seed);
    console.log(chalk.cyan("Address:"), address);
    console.log(chalk.gray("\nStored at:"), getConfigPath());
    console.log(chalk.yellow("\nBackup your seed! Anyone with it can access your funds."));

    // JSON output for programmatic use
    console.log(chalk.gray("\nJSON:"));
    console.log(JSON.stringify({ seed, address }, null, 2));
  });

program
  .command("import")
  .description("Import existing wallet from seed")
  .argument("<seed>", "64-character hex seed")
  .action(async (seed: string) => {
    if (seed.length !== 64 || !/^[0-9a-fA-F]+$/.test(seed)) {
      console.error(chalk.red("Invalid seed format. Must be 64 hex characters."));
      process.exit(1);
    }

    const wallet = new BerryPayWallet({ seed: seed.toUpperCase() });
    const address = wallet.getAddress();

    saveSeed(seed.toUpperCase());

    console.log(chalk.green("Wallet imported!\n"));
    console.log(chalk.cyan("Address:"), address);
    console.log(JSON.stringify({ address }, null, 2));
  });

program
  .command("address")
  .description("Show receiving address")
  .option("-i, --index <index>", "Account index", "0")
  .option("-q, --qr", "Display QR code in terminal and save as image")
  .option("-o, --output <path>", "Output path for QR image", "./nano-address-qr.png")
  .action(async (options) => {
    const wallet = getWallet();
    const index = parseInt(options.index);
    const address = wallet.getAddress(index);

    console.log(chalk.cyan("Address:"), address);

    if (options.qr) {
      const terminalQR = await QRCode.toString(address, {
        type: "terminal",
        small: true,
      });
      console.log("\n" + terminalQR);

      const outputPath = path.resolve(options.output);
      await QRCode.toFile(outputPath, address, {
        type: "png",
        width: 400,
        margin: 2,
        color: { dark: "#000000", light: "#ffffff" },
      });

      console.log(chalk.green("QR saved:"), outputPath);
    }

    // JSON output
    console.log(JSON.stringify({ address, index, ...(options.qr ? { qrPath: path.resolve(options.output) } : {}) }, null, 2));
  });

program
  .command("balance")
  .description("Show balance")
  .option("-i, --index <index>", "Account index", "0")
  .option("--json", "Output only JSON")
  .action(async (options) => {
    const wallet = getWallet();
    const index = parseInt(options.index);
    const address = wallet.getAddress(index);

    const spinner = options.json ? null : ora("Fetching balance...").start();

    try {
      const { balance, pending } = await wallet.getBalance(index);
      spinner?.stop();

      const balanceNano = BerryPayWallet.rawToNano(balance);
      const pendingNano = BerryPayWallet.rawToNano(pending);

      if (!options.json) {
        console.log(chalk.cyan("Address:"), address);
        console.log(chalk.green("Balance:"), balanceNano, "XNO");
        console.log(chalk.yellow("Pending:"), pendingNano, "XNO");
      }

      console.log(JSON.stringify({
        address,
        balance: balanceNano,
        balanceRaw: balance,
        pending: pendingNano,
        pendingRaw: pending,
      }, null, 2));
    } catch (error) {
      spinner?.fail("Failed to fetch balance");
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

program
  .command("send")
  .description("Send XNO to an address")
  .argument("<address>", "Recipient address")
  .argument("<amount>", "Amount in XNO")
  .option("-i, --index <index>", "Account index", "0")
  .option("-y, --yes", "Skip confirmation")
  .action(async (address: string, amount: string, options) => {
    if (!BerryPayWallet.validateAddress(address)) {
      console.error(chalk.red("Invalid Nano address."));
      process.exit(1);
    }

    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      console.error(chalk.red("Invalid amount."));
      process.exit(1);
    }

    const wallet = getWallet();
    const index = parseInt(options.index);
    const amountRaw = BerryPayWallet.nanoToRaw(amount);

    if (!options.yes) {
      console.log(chalk.cyan("Sending:"), amount, "XNO");
      console.log(chalk.cyan("To:"), address);
      console.log(chalk.cyan("From:"), wallet.getAddress(index));
      console.log(chalk.yellow("\nUse --yes flag to skip this confirmation"));
    }

    const spinner = ora("Sending...").start();

    try {
      const result = await wallet.send(address, amountRaw, index);
      spinner.succeed("Sent!");

      console.log(chalk.green("Hash:"), result.hash);
      console.log(JSON.stringify({
        hash: result.hash,
        to: address,
        amount,
        amountRaw,
      }, null, 2));
    } catch (error) {
      spinner.fail("Failed");
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

program
  .command("receive")
  .description("Receive all pending transactions")
  .option("-i, --index <index>", "Account index", "0")
  .action(async (options) => {
    const wallet = getWallet();
    const index = parseInt(options.index);

    const spinner = ora("Checking pending...").start();

    try {
      const pending = await wallet.getPendingBlocks(index);

      if (pending.length === 0) {
        spinner.succeed("No pending transactions.");
        console.log(JSON.stringify({ received: [] }, null, 2));
        return;
      }

      spinner.text = `Receiving ${pending.length} transaction(s)...`;

      const results = await wallet.receivePending(index);
      spinner.succeed(`Received ${results.length} transaction(s)!`);

      const received = results.map((r) => ({
        hash: r.hash,
        amount: BerryPayWallet.rawToNano(r.amount),
        amountRaw: r.amount,
      }));

      for (const r of received) {
        console.log(chalk.green("  +"), r.amount, "XNO");
      }

      console.log(JSON.stringify({ received }, null, 2));
    } catch (error) {
      spinner.fail("Failed");
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

program
  .command("watch")
  .description("Watch for incoming payments")
  .option("-i, --index <index>", "Account index", "0")
  .action(async (options) => {
    const wallet = getWallet();
    const index = parseInt(options.index);
    const address = wallet.getAddress(index);

    console.log(chalk.cyan("Watching:"), address);
    console.log(chalk.gray("Press Ctrl+C to stop.\n"));

    const monitor = new BlockLatticeMonitor({
      wsUrl: getWsUrl(),
      accounts: [address],
    });

    monitor.on("connected", () => {
      console.log(chalk.green("Connected to Nano network"));
    });

    monitor.on("disconnected", () => {
      console.log(chalk.yellow("Disconnected"));
    });

    monitor.on("payment", async (payment) => {
      console.log(chalk.green("\nPayment received!"));
      console.log(chalk.cyan("  Amount:"), payment.amountNano, "XNO");
      console.log(chalk.cyan("  From:"), payment.from);
      console.log(chalk.cyan("  Hash:"), payment.hash);

      // Auto-receive
      try {
        await wallet.receive(payment.hash, payment.amount, index);
        console.log(chalk.green("  Received!"));
      } catch (error) {
        console.log(chalk.red("  Failed to receive:"), (error as Error).message);
      }

      // JSON output for each payment
      console.log(JSON.stringify({
        event: "payment",
        hash: payment.hash,
        from: payment.from,
        amount: payment.amountNano,
        amountRaw: payment.amount,
      }));
    });

    monitor.on("error", (error) => {
      console.error(chalk.red("Error:"), error.message);
    });

    await monitor.start();

    process.on("SIGINT", () => {
      monitor.stop();
      process.exit(0);
    });
  });

program
  .command("export")
  .description("Export wallet seed")
  .action(async () => {
    const seed = getSeed();
    if (!seed) {
      console.error(chalk.red("No wallet found."));
      process.exit(1);
    }

    const wallet = new BerryPayWallet({ seed });

    console.log(chalk.cyan("Seed:"), seed);
    console.log(chalk.cyan("Address:"), wallet.getAddress());
    console.log(JSON.stringify({ seed, address: wallet.getAddress() }, null, 2));
  });

program
  .command("delete")
  .description("Delete wallet from this device")
  .option("-y, --yes", "Skip confirmation")
  .action(async (options) => {
    if (!hasSeed()) {
      console.log(chalk.yellow("No wallet to delete."));
      return;
    }

    if (!options.yes) {
      console.log(chalk.red("This will delete your wallet. Use --yes to confirm."));
      console.log(chalk.yellow("Make sure you have backed up your seed!"));
      return;
    }

    clearSeed();
    console.log(chalk.green("Wallet deleted."));
  });

program
  .command("config")
  .description("Show or update configuration")
  .option("--rpc <url>", "Set RPC node URL")
  .option("--ws <url>", "Set WebSocket URL")
  .action((options) => {
    if (options.rpc) {
      setRpcUrl(options.rpc);
      console.log(chalk.green("RPC URL set."));
    }
    if (options.ws) {
      setWsUrl(options.ws);
      console.log(chalk.green("WebSocket URL set."));
    }

    console.log(JSON.stringify({
      configPath: getConfigPath(),
      rpcUrl: getRpcUrl(),
      wsUrl: getWsUrl(),
      hasWallet: hasSeed(),
    }, null, 2));
  });

// ============================================
// Payment Processor Commands
// ============================================

const charge = program
  .command("charge")
  .description("Payment processor - create and manage charges");

charge
  .command("create")
  .description("Create a new payment charge")
  .argument("<amount>", "Amount in XNO")
  .option("-t, --timeout <minutes>", "Timeout in minutes", "30")
  .option("--qr", "Show QR code")
  .option("-o, --output <path>", "Save QR image")
  .action(async (amount: string, options) => {
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      console.error(chalk.red("Invalid amount."));
      process.exit(1);
    }

    const wallet = getWallet();
    const processor = new PaymentProcessor({ wallet, autoSweep: true });

    const timeoutMs = parseInt(options.timeout) * 60 * 1000;
    const chargeData = await processor.createCharge({ amountNano: amount, timeoutMs });

    console.log(chalk.green("Charge created!\n"));
    console.log(chalk.cyan("  ID:"), chargeData.id);
    console.log(chalk.cyan("  Amount:"), chargeData.amountNano, "XNO");
    console.log(chalk.cyan("  Address:"), chargeData.address);
    console.log(chalk.cyan("  Expires:"), chargeData.expiresAt.toLocaleString());

    if (options.qr) {
      const terminalQR = await QRCode.toString(chargeData.address, { type: "terminal", small: true });
      console.log("\n" + terminalQR);

      if (options.output) {
        const outputPath = path.resolve(options.output);
        await QRCode.toFile(outputPath, chargeData.address, { type: "png", width: 400, margin: 2 });
        console.log(chalk.green("QR saved:"), outputPath);
      }
    }

    console.log(JSON.stringify({
      id: chargeData.id,
      address: chargeData.address,
      amount: chargeData.amountNano,
      amountRaw: chargeData.amountRaw,
      expiresAt: chargeData.expiresAt.toISOString(),
    }, null, 2));
  });

charge
  .command("listen")
  .description("Start payment processor and listen for payments")
  .option("--no-auto-sweep", "Disable auto-sweep")
  .action(async (options) => {
    const wallet = getWallet();
    const mainAddress = wallet.getAddress(0);

    console.log(chalk.cyan("Payment Processor"));
    console.log(chalk.gray("  Main wallet:"), mainAddress);
    console.log(chalk.gray("  Auto-sweep:"), options.autoSweep ? "Yes" : "No");
    console.log(chalk.gray("\nListening... Ctrl+C to stop.\n"));

    const processor = new PaymentProcessor({
      wallet,
      autoSweep: options.autoSweep,
      wsUrl: getWsUrl(),
    });

    processor.on("state:loaded", ({ chargeCount }) => {
      if (chargeCount > 0) console.log(chalk.blue(`Loaded ${chargeCount} charge(s) from disk`));
    });

    processor.on("started", ({ resumedCharges }) => {
      if (resumedCharges > 0) console.log(chalk.blue(`Resumed ${resumedCharges} active charge(s)`));
    });

    processor.on("recovery:found", ({ chargeId, pendingCount }) => {
      console.log(chalk.yellow(`\nRecovering ${pendingCount} missed payment(s) for ${chargeId}`));
    });

    processor.on("connected", () => console.log(chalk.green("Connected")));
    processor.on("disconnected", () => console.log(chalk.yellow("Disconnected")));

    processor.on("charge:created", (c: Charge) => {
      console.log(chalk.blue(`\nCharge created: ${c.id}`));
      console.log(JSON.stringify({ event: "charge:created", id: c.id, address: c.address, amount: c.amountNano }));
    });

    processor.on("charge:payment", ({ charge, transaction }) => {
      console.log(chalk.yellow(`\nPayment for ${charge.id}: ${transaction.amountNano} XNO`));
      console.log(JSON.stringify({ event: "charge:payment", chargeId: charge.id, amount: transaction.amountNano, hash: transaction.hash }));
    });

    processor.on("charge:completed", (c: Charge) => {
      console.log(chalk.green(`\nCharge COMPLETED: ${c.id}`));
      console.log(JSON.stringify({ event: "charge:completed", id: c.id, received: c.receivedNano }));
    });

    processor.on("charge:swept", ({ charge, hash, amountNano }) => {
      console.log(chalk.green(`\nSwept to main wallet: ${amountNano} XNO`));
      console.log(JSON.stringify({ event: "charge:swept", chargeId: charge.id, amount: amountNano, hash, to: mainAddress }));
    });

    processor.on("charge:expired", (c: Charge) => {
      console.log(chalk.red(`\nCharge EXPIRED: ${c.id}`));
      console.log(JSON.stringify({ event: "charge:expired", id: c.id, received: c.receivedNano }));
    });

    processor.on("error", (err) => console.error(chalk.red("Error:"), err.message));

    await processor.start();

    process.on("SIGINT", () => {
      processor.stop();
      process.exit(0);
    });
  });

charge
  .command("status")
  .description("Check charge status (polls blockchain, auto-receives and sweeps if paid)")
  .argument("<id>", "Charge ID")
  .option("--no-sweep", "Don't auto-sweep if paid")
  .action(async (id: string, options: { sweep: boolean }) => {
    const wallet = getWallet();
    const processor = new PaymentProcessor({ wallet, autoSweep: false }); // We'll handle sweep manually

    const chargeData = processor.getCharge(id);
    if (!chargeData) {
      console.error(chalk.red("Charge not found:", id));
      process.exit(1);
    }

    const spinner = ora("Checking blockchain...").start();

    try {
      // Check blockchain for actual balance and pending
      let { balance, pending } = await wallet.getBalance(chargeData.accountIndex);
      const pendingBlocks = await wallet.getPendingBlocks(chargeData.accountIndex);

      const totalOnChain = BigInt(balance) + BigInt(pending);
      const required = BigInt(chargeData.amountRaw);
      const isPaid = totalOnChain >= required;
      const remaining = required > totalOnChain ? required - totalOnChain : BigInt(0);

      let swept = false;
      let sweepHash: string | undefined;

      // If there are pending blocks, receive them
      if (pendingBlocks.length > 0) {
        spinner.text = "Receiving pending blocks...";
        await wallet.receivePending(chargeData.accountIndex);
        // Refresh balance after receiving
        const refreshed = await wallet.getBalance(chargeData.accountIndex);
        balance = refreshed.balance;
        pending = refreshed.pending;
      }

      // If fully paid and sweep enabled, sweep to main
      if (isPaid && options.sweep && chargeData.status !== "swept") {
        spinner.text = "Sweeping to main wallet...";
        try {
          const result = await processor.sweepCharge(id);
          if (result) {
            swept = true;
            sweepHash = result.hash;
          }
        } catch (sweepError) {
          spinner.warn("Sweep failed: " + (sweepError as Error).message);
          // Continue to show status even if sweep failed
        }
      }

      spinner.stop();

      const finalStatus = swept ? "swept" : (isPaid ? "completed" : chargeData.status);

      console.log(chalk.cyan("Charge:"), chargeData.id);
      console.log(chalk.gray("  Status:"), finalStatus);
      console.log(chalk.gray("  Address:"), chargeData.address);
      console.log(chalk.gray("  Required:"), chargeData.amountNano, "XNO");
      console.log(chalk.gray("  On-chain balance:"), BerryPayWallet.rawToNano(balance), "XNO");
      console.log(chalk.gray("  On-chain pending:"), BerryPayWallet.rawToNano(pending), "XNO");
      console.log(isPaid ? chalk.green("  PAID: Yes") : chalk.yellow("  PAID: No"));
      if (!isPaid) {
        console.log(chalk.yellow("  Remaining:"), BerryPayWallet.rawToNano(remaining.toString()), "XNO");
      }
      if (swept) {
        console.log(chalk.green("  Swept to main wallet"));
        console.log(chalk.gray("  Sweep hash:"), sweepHash);
      }

      console.log(JSON.stringify({
        id: chargeData.id,
        address: chargeData.address,
        status: finalStatus,
        required: chargeData.amountNano,
        requiredRaw: chargeData.amountRaw,
        onChainBalance: BerryPayWallet.rawToNano(balance),
        onChainPending: BerryPayWallet.rawToNano(pending),
        isPaid,
        remaining: BerryPayWallet.rawToNano(remaining.toString()),
        swept,
        sweepHash,
      }, null, 2));
    } catch (error) {
      spinner.fail("Failed to check blockchain");
      console.error(chalk.red((error as Error).message));
      process.exit(1);
    }
  });

charge
  .command("list")
  .description("List charges")
  .option("-s, --status <status>", "Filter by status")
  .action(async (options) => {
    const wallet = getWallet();
    const processor = new PaymentProcessor({ wallet });

    const charges = options.status
      ? processor.listCharges(options.status)
      : processor.listCharges();

    if (charges.length === 0) {
      console.log(chalk.gray("No charges found"));
      console.log(JSON.stringify({ charges: [] }, null, 2));
      return;
    }

    console.log(chalk.cyan(`${charges.length} charge(s):\n`));
    for (const c of charges) {
      console.log(`  ${c.id}  ${c.status.padEnd(9)}  ${c.receivedNano}/${c.amountNano} XNO`);
    }

    console.log(JSON.stringify({ charges: charges.map(c => ({ id: c.id, status: c.status, amount: c.amountNano, received: c.receivedNano })) }, null, 2));
  });

charge
  .command("sweep")
  .description("Manually sweep funds from a charge to main wallet")
  .argument("<id>", "Charge ID")
  .action(async (id: string) => {
    const wallet = getWallet();
    const processor = new PaymentProcessor({ wallet });

    const charge = processor.getCharge(id);
    if (!charge) {
      console.error(chalk.red("Charge not found"));
      console.log(JSON.stringify({ error: "Charge not found" }, null, 2));
      process.exit(1);
    }

    const spinner = ora("Sweeping funds to main wallet...").start();

    try {
      // First receive any pending blocks
      await wallet.receivePending(charge.accountIndex);

      const result = await processor.sweepCharge(id);

      if (result) {
        spinner.succeed(chalk.green("Funds swept to main wallet"));
        console.log(JSON.stringify({
          success: true,
          hash: result.hash,
          amount: BerryPayWallet.rawToNano(result.amount),
          mainAddress: processor.getMainAddress(),
        }, null, 2));
      } else {
        spinner.warn(chalk.yellow("No funds to sweep"));
        console.log(JSON.stringify({ success: false, reason: "No funds to sweep" }, null, 2));
      }
    } catch (err) {
      spinner.fail(chalk.red("Sweep failed"));
      console.error(err);
      process.exit(1);
    }
  });

charge
  .command("cleanup")
  .description("Remove swept charges from history")
  .action(async () => {
    const wallet = getWallet();
    const processor = new PaymentProcessor({ wallet });
    const count = processor.cleanupSweptCharges();
    console.log(chalk.green(`Cleaned up ${count} charge(s)`));
    console.log(JSON.stringify({ cleaned: count }, null, 2));
  });

export { program };
