# GeyserBridge

> Yellowstone gRPC-compatible server backed by free Solana RPC WebSockets.
> Same proto. Same client library. Zero validator hardware.

Drop-in replacement for the Yellowstone Geyser gRPC plugin that runs anywhere — no Solana validator, no $499/mo QuickNode add-on, just Node.js and a free RPC URL.

## Why

Yellowstone Geyser gRPC has become the standard protocol for real-time Solana data streaming. Trading bots, indexers, dashboards, and monitoring tools all use it. But every hosted provider charges:

| Provider | Price |
|----------|-------|
| Chainstack | $49/mo (1 stream) |
| QuickNode | $299/mo |
| Solana Tracker | €200/mo |
| Alchemy | Custom quote |

**GeyserBridge** implements the exact same protobuf service definition (`geyser.Geyser`) backed by `@solana/web3.js` WebSocket subscriptions. Any code using `@triton-one/yellowstone-grpc` or the raw proto works by changing one URL.

## Service Implementation

| gRPC Method | Type | Status |
|-------------|------|--------|
| `Subscribe` | bidirectional stream | ✅ Accounts, slots, transactions, blocks, blocks_meta |
| `GetSlot` | unary | ✅ |
| `GetBlockHeight` | unary | ✅ |
| `GetLatestBlockhash` | unary | ✅ |
| `IsBlockhashValid` | unary | ✅ |
| `GetVersion` | unary | ✅ |
| `Ping` | unary | ✅ |
| `SubscribeReplayInfo` | unary | ✅ |
| `SubscribeDeshred` | stream | ❌ (rarely used, planned v2) |

## Quick Start

```bash
git clone <repo>
cd geyser-bridge
cp .env.example .env
# Set ADMIN_KEY to a random secret
npm install
npm run dev
```

The gRPC server starts on `0.0.0.0:10000`.

## Connection from Any Yellowstone Client

### TypeScript (@triton-one/yellowstone-grpc)

```typescript
const Client = require('@triton-one/yellowstone-grpc').default;

const client = new Client('http://localhost:10000', 'your-admin-key', {
  'grpc.max_receive_message_length': 64 * 1024 * 1024,
});

const stream = await client.subscribe();
stream.write({
  slots: { all: {} },
  commitment: 1, // CONFIRMED
});

stream.on('data', (data) => {
  if (data.slot) {
    console.log('Slot:', data.slot.slot, 'Status:', data.slot.status);
  }
});

// Keep alive: reply to server pings
stream.on('data', (data) => {
  if (data.ping) stream.write({ ping: { id: data.ping.id } });
});
```

### grpcurl

```bash
grpcurl -proto proto/geyser.proto -d '{}' \
  -H 'x-token: your-admin-key' \
  localhost:10000 geyser.Geyser/GetVersion

grpcurl -proto proto/geyser.proto -d '{"commitment": 1}' \
  -H 'x-token: your-admin-key' \
  localhost:10000 geyser.Geyser/GetSlot
```

### Subscribe to Slots (grpcurl)

```bash
echo '{"slots": {"s1": {}}, "commitment": 1}' | \
grpcurl -proto proto/geyser.proto \
  -H 'x-token: your-admin-key' \
  -d @ \
  localhost:10000 geyser.Geyser/Subscribe
```

## Architecture

```
Client (gRPC) ──→ GeyserBridge ──→ Solana Public RPC
                                      │
                                 ├─ onSlotChange
                                 ├─ onProgramAccountChange
                                 ├─ onAccountChange
                                 ├─ onLogs
                                 └─ getTransaction / getBlock
```

- **Connection pool** — manages up to `MAX_CONNECTIONS` RPC connections, each supporting `MAX_STREAMS_PER_CONNECTION` WebSocket subscriptions
- **Subscription manager** — deduplicates overlapping subscriptions (2 clients watching same program = 1 WebSocket sub, fan-out to both streams)
- **Filter engine** — applies memcmp, datasize, lamport, and account include/exclude/required filters client-side after receiving WebSocket data
- **Ping/pong** — server sends pings every `PING_INTERVAL_MS` (default 15s), terminates idle streams after `PING_TIMEOUT_MS` (default 60s)
- **Ring buffer** — keeps last `SLOT_BUFFER_SIZE` slot updates (default 500) for `from_slot` replay

## Limitations

- **Latency** — Real Geyser pushes from validator memory (~sub-ms). GeyserBridge adds RPC round-trip time (~200-500ms for `getTransaction`, `getBlock`). Fine for indexers, dashboards, most bots. Not suitable for HFT/MEV.
- **`processed` commitment** — `getTransaction` and `getBlock` require `confirmed`. Transaction data at `processed` level won't have full meta until confirmed.
- **`from_slot` buffer** — limited to last 500 slots (~3 min). Use JSON-RPC for historical backfill.
- **No `entry` subscriptions** — Real Yellowstone has the same limitation (bug in Solana's BlockMeta).
- **No `SubscribeDeshred`** — Returns `UNIMPLEMENTED`. Planned for v2.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `10000` | gRPC server port |
| `HOST` | `0.0.0.0` | Bind address |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `ADMIN_KEY` | (required) | Secret key for `x-token` auth |
| `TLS_CERT_PATH` | (empty) | TLS cert file path (empty = insecure) |
| `TLS_KEY_PATH` | (empty) | TLS key file path |
| `LOG_LEVEL` | `info` | Pino log level |
| `MAX_STREAMS_PER_CONNECTION` | `100` | Max WebSocket subs per connection |
| `MAX_CONNECTIONS` | `10` | Max RPC connections in pool |
| `PING_INTERVAL_MS` | `15000` | Server ping interval |
| `PING_TIMEOUT_MS` | `60000` | Stream timeout without response |
| `SLOT_BUFFER_SIZE` | `500` | Ring buffer size for `from_slot` |

## Deployment

### Docker

```bash
docker build -t geyser-bridge .
docker run -d --name geyser-bridge -p 10000:10000 \
  -e ADMIN_KEY=your-secret \
  geyser-bridge
```

### Docker Compose

```bash
ADMIN_KEY=your-secret docker compose up -d
```

### VPS (DigitalOcean / Hetzner / any)

```bash
# Node.js 20+
npm ci
npm run build
ADMIN_KEY=your-secret node dist/index.js
```

## License

MIT
