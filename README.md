# BerryPay CLI

Nano (XNO) cryptocurrency wallet CLI designed for AI agents and automated payment processing.

## Features

- **No passwords** - Designed for automation, no interactive prompts
- **Environment variables** - Configure via `BERRYPAY_SEED` for AI agents
- **JSON output** - All commands output JSON for easy parsing
- **Payment processor** - Ephemeral addresses, auto-sweep to main wallet
- **Webhooks** - Get notified when payments complete
- **Auto-receive** - Pending funds received automatically
- **Real-time** - WebSocket-based payment confirmations
- **Persistent** - Charges survive restarts

## Installation

```bash
npm install -g berrypay
```

## Quick Start

```bash
# Create wallet (no password, stored in ~/.berrypay/)
berrypay init

# Or use environment variable (for AI agents)
export BERRYPAY_SEED=your64charhexseed

# Show address
berrypay address

# Check balance (auto-receives pending)
berrypay balance

# Send XNO (use --yes to skip confirmation)
berrypay send nano_1abc... 0.1 --yes

# Receive pending
berrypay receive
```

## Environment Variables

```bash
BERRYPAY_SEED      # 64-char hex seed (overrides config file)
BERRYPAY_RPC_URL   # RPC node URL
BERRYPAY_WS_URL    # WebSocket URL
```

## Payment Processor

Accept payments with auto-generated ephemeral addresses:

```bash
# Create a charge with webhook
berrypay charge create 0.5 --webhook http://localhost:3000/callback

# With metadata for your webhook
berrypay charge create 0.5 \
  --webhook http://localhost:3000/callback \
  --metadata '{"orderId": "123"}'

# With QR code image
berrypay charge create 0.5 --qr --output /tmp/payment.png

# Check status (auto-receives and sweeps if paid)
berrypay charge status chg_abc123

# List all charges
berrypay charge list

# Check listener status
berrypay charge listener

# Stop listener
berrypay charge stop
```

### Flow

```
1. charge create 1.0  →  Ephemeral address generated, listener auto-starts
2. Customer pays      →  WebSocket detects payment
3. Auto-receive       →  Pending blocks received
4. Auto-sweep         →  Funds sent to main wallet (index 0)
5. Webhook called     →  Your server notified with charge details
6. Auto-stop          →  Listener stops when no active charges
```

### Webhook Payload

```json
{
  "event": "charge.completed",
  "charge": {
    "id": "chg_abc123",
    "address": "nano_3ephemeral...",
    "amountNano": "0.5",
    "sweepTxHash": "ABC123...",
    "metadata": {"orderId": "123"}
  },
  "timestamp": "2026-01-30T12:00:00.000Z"
}
```

## All Commands

```bash
berrypay init                    # Create new wallet
berrypay import <seed>           # Import from seed
berrypay address [--qr]          # Show address
berrypay balance [--json]        # Check balance (auto-receives)
berrypay send <addr> <amt> [-y]  # Send XNO (auto-receives first)
berrypay receive                 # Receive pending
berrypay watch                   # Watch for payments
berrypay export                  # Show seed
berrypay delete [-y]             # Delete wallet
berrypay config                  # Show/set config

berrypay charge create <amt>     # Create charge (auto-starts listener)
berrypay charge status <id>      # Check charge (auto-sweeps if paid)
berrypay charge sweep <id>       # Manually sweep to main wallet
berrypay charge list             # List charges
berrypay charge listener         # Check if listener running
berrypay charge stop             # Stop background listener
berrypay charge cleanup          # Remove swept charges
```

## Programmatic Usage

```typescript
import { BerryPayWallet, PaymentProcessor } from 'berrypay';

const wallet = new BerryPayWallet({ seed: process.env.BERRYPAY_SEED });

// Send
await wallet.send('nano_1...', BerryPayWallet.nanoToRaw('0.1'));

// Payment processor
const processor = new PaymentProcessor({ wallet, autoSweep: true });
processor.on('charge:completed', (charge) => console.log('Paid!', charge.id));
processor.on('charge:swept', ({ hash }) => console.log('Swept:', hash));
await processor.start();

const charge = await processor.createCharge({
  amountNano: '1.0',
  webhookUrl: 'http://localhost:3000/callback',
  metadata: { orderId: '123' }
});
// charge.address - send payment here
```

## AI Agent Skill Guide

See [skills/berrypay/SKILL.md](./skills/berrypay/SKILL.md) for a comprehensive guide on using BerryPay CLI as an AI agent.

## Storage

- Config: `~/.berrypay/config.json`
- Charges: `~/.berrypay/charges.json`
- Listener PID: `~/.berrypay/listener.pid`

## License

MIT
