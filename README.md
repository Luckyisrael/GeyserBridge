# GeyserBridge

> Yellowstone gRPC-compatible server backed by free Solana RPC WebSockets.
> Same proto. Same client library. Zero validator hardware.

**GeyserBridge** implements the exact same protobuf service definition (`geyser.Geyser`) backed by `@solana/web3.js` WebSocket subscriptions. Any code using `@triton-one/yellowstone-grpc` or the raw proto works by changing one URL.

---

## Table of Contents

- [Why GeyserBridge](#why-geyserbridge)
- [Service Implementation](#service-implementation)
- [Quick Start](#quick-start)
- [Testing](#testing)
- [Architecture](#architecture)
- [Connection Examples](#connection-examples)
  - [@triton-one/yellowstone-grpc Client](#triton-oneyellowstone-grpc-client)
  - [grpcurl](#grpcurl)
  - [Raw gRPC-js](#raw-grpc-js)
- [Authentication](#authentication)
- [Subscribe Filters](#subscribe-filters)
- [Environment Variables](#environment-variables)
- [Deployment](#deployment)
- [Limitations](#limitations)

---

## Why GeyserBridge

Yellowstone Geyser gRPC has become the standard protocol for real-time Solana data streaming. Trading bots, indexers, dashboards, and monitoring tools all use it. But every hosted provider charges a premium:

| Provider | Price |
|----------|-------|
| Chainstack | $49/mo (1 stream) |
| QuickNode | $299/mo |
| Solana Tracker | €200/mo |
| Alchemy | Custom quote |

GeyserBridge runs on any $5 VPS (or your laptop) — no Solana validator, no expensive add-ons.

---

## Service Implementation

| gRPC Method | Type | Auth | Status |
|-------------|------|------|--------|
| `Subscribe` | bidirectional stream | ✅ `x-token` | ✅ Accounts, slots, transactions, blocks (incl. transactions), blocks_meta, `from_slot` replay |
| `GetSlot` | unary | ✅ `x-token` | ✅ |
| `GetBlockHeight` | unary | ✅ `x-token` | ✅ |
| `GetLatestBlockhash` | unary | ✅ `x-token` | ✅ |
| `IsBlockhashValid` | unary | ✅ `x-token` | ✅ |
| `GetVersion` | unary | ✅ `x-token` | ✅ |
| `Ping` | unary | ❌ (open) | ✅ |
| `SubscribeReplayInfo` | unary | ✅ `x-token` | ✅ |
| `SubscribeDeshred` | stream | ✅ `x-token` | ❌ (requires validator shred data) |

### Subscribe stream features

| Filter | Status | Details |
|--------|--------|---------|
| `slots` | ✅ | Real-time slot updates via `onSlotChange` WebSocket |
| `accounts` | ✅ | Program account changes via `onProgramAccountChange` + client-side memcmp/datasize/lamports filtering |
| `transactions` | ✅ | Full transaction data fetched via `getTransaction` after `onLogs` notification |
| `transactions_status` | ✅ | Lightweight status (slot, signature, isVote, index, err) from `onLogs` |
| `blocks` | ✅ | Full block data with `include_transactions` support via `getBlock` |
| `blocks_meta` | ✅ | Lightweight block metadata (slot, blockhash, blockTime, parent, tx count) |
| `entry` | ✅ Parsed | Entry data not available from RPC (same limitation as real Yellowstone) |
| `from_slot` | ✅ | Replays buffered slot history (last `SLOT_BUFFER_SIZE` slots) on connect |
| `accounts_data_slice` | ❌ | Not yet supported |
| `cuckoo_filter` | ❌ | Not yet supported |

---

## Quick Start

```bash
# Clone and configure
git clone <repo-url> geyser-bridge
cd geyser-bridge
cp .env.example .env
# EDIT .env: set ADMIN_KEY to a secure random string

# Install and run
npm install
npm run dev
```

The server starts on `0.0.0.0:10000` (configurable via `PORT` and `HOST`).

> **Windows users:** If `npm install` emits deprecation warnings about `start()`, these are harmless and from the `@solana/web3.js` dependency.

### Build for Production

```bash
npm run build
ADMIN_KEY=your-secret node dist/index.js
```

---

## Testing

### Run All Tests

```bash
npm test
```

This runs **59 tests** across **9 test files**:
- 4 unit tests — `RingBuffer`
- 20 unit tests — `SubscriptionManager` (register, unregister, filters, `updateSubscriber`)
- 3 unit tests — transaction translation
- 4 unit tests — account translation, block translation, commitment/slot mapping
- 11 unit tests — `GeyserService` (subscribe, ping/pong, account push, slot emit, connectBridge, `from_slot` replay, unary RPCs)
- 4 + 9 + 4 E2E tests — full server lifecycle against real Solana mainnet

### Run Specific Tests

```bash
# Unit tests only
npx vitest run test/services/geyser.test.ts

# E2E tests only (contacts real Solana RPC)
npx vitest run test/e2e.test.ts

# Single test file with verbose output
npx vitest run test/subscriptions/manager.test.ts --reporter=verbose

# Watch mode
npx vitest
```

### Test Coverage

The test suite covers:

- **Unit:** Ring buffer push/evict/dedup, subscription register/unregister/filter logic, transaction/account/block translation, GeyserService subscribe/ping/push/emit/from_slot flow
- **E2E:** Full gRPC server start/stop, authentication (valid key, invalid key, no key, Ping bypass), all unary RPCs (GetVersion, GetSlot, GetBlockHeight, GetLatestBlockhash, IsBlockhashValid, Ping), Subscribe stream (slot updates, ping/pong)

---

## Architecture

```
                    ┌──────────────────────────────────────────────────┐
                    │                   GeyserBridge                    │
                    │                                                  │
  ┌──────────┐      │  ┌──────────────┐    ┌──────────────────────┐   │     ┌──────────────────┐
  │          │  gRPC  │  │              │    │    GeyserService      │   │     │                  │
  │  Client  │◄─────►│  │   Auth       │───►│  ┌────────────────┐  │   │     │  Solana RPC      │
  │(proto)   │      │  │ Interceptor   │    │  │ pushAccount    │  │   │     │  (mainnet-beta)  │
  └──────────┘      │  └──────────────┘    │  │ pushTransaction │  │   │     │                  │
                    │                      │  │ emitSlot        │  │   │     ├──────────────────┤
                    │  ┌──────────────────┐│  │ fetchBlock      │  │   │     │ onSlotChange     │
                    │  │  SolanaBridge     ││  │ fetchBlockMeta  │  │   │     │ onLogs           │
                    │  │  ┌────────────┐   ││  └────────────────┘  │   │     │ onProgramAccount │
                    │  │  │ reconcile │   ││                      │   │     │ getTransaction   │
                    │  │  │ (10s)     │──►││  ┌────────────────┐  │   │     │ getBlock         │
                    │  │  └────────────┘   ││  │ Subscription   │  │   │     │ getSlot          │
                    │  │  onLogs           ││  │ Manager        │  │   │     └──────────────────┘
                    │  │  onProgramAccount ││  │ (dedup, filter)│  │   │
                    │  │  getTransaction   ││  └────────────────┘  │   │
                    │  └──────────────────┘│                      │   │
                    │                      │  ┌────────────────┐  │   │
                    │                      │  │  ConnectionPool │  │   │
                    │                      │  │  (acquire/      │  │   │
                    │                      │  │   release)      │  │   │
                    │                      │  └────────────────┘  │   │
                    │                      │                      │   │
                    │                      │  ┌────────────────┐  │   │
                    │                      │  │  RingBuffer    │  │   │
                    │                      │  │  (slot history) │  │   │
                    │                      │  └────────────────┘  │   │
                    └──────────────────────┴──────────────────────┘   │
                                                                      │
                                                                      │
```

### Key Components

| Component | File | Responsibility |
|-----------|------|----------------|
| **Auth Interceptor** | `src/auth/interceptor.ts` | Validates `x-token` metadata on every RPC except `Ping`. Uses SHA256-hashed key store. |
| **ApiKeyStore** | `src/auth/store.ts` | Manages admin key with SHA256 hashing, rate-limit tracking. |
| **GeyserService** | `src/services/geyser.ts` | Core gRPC handler logic: subscribe streams, unary RPCs, push account/tx/slot updates to subscriber streams, fetch blocks with dedup cache. |
| **SolanaBridge** | `src/bridge/solana-bridge.ts` | Manages Solana WebSocket subscriptions (`onLogs`, `onProgramAccountChange`). 10-second reconcile loop. Emits events that GeyserService fans out. |
| **SubscriptionManager** | `src/subscriptions/manager.ts` | Deduplicates overlapping subscriber filters. Client-side filtering engine (memcmp, datasize, lamports, account include/exclude). Atomic `updateSubscriber` for race-free filter changes. |
| **ConnectionPool** | `src/solana/pool.ts` | Manages up to `MAX_CONNECTIONS` RPC connections. Tracks subscription count per connection for load balancing. |
| **RingBuffer** | `src/utils/ring-buffer.ts` | Fixed-capacity slot history buffer. Supports `getRange(from, to)` for `from_slot` replay. |

### Data Flow

```
1. Client opens Subscribe stream with filters

2. GeyserService registers filters in SubscriptionManager

3. SolanaBridge reconcile() (every 10s):
   - Checks SubscriptionManager for desired account owners / tx subs
   - Calls onProgramAccountChange / onLogs on Solana RPC
   - Deduplicates: same owner across 2 clients = 1 WebSocket sub

4. Solana emits WebSocket event → SolanaBridge:
   - onProgramAccountChange → emit('accountUpdate')
   - onLogs → emit('transactionStatus') + fetchAndEmitTransaction()

5. GeyserService push* methods:
   - Iterate all subscribers
   - Check filters via SubscriptionManager.shouldSend*
   - Write matching update to subscriber's gRPC stream

6. Slot loop (index.ts):
   - onSlotChange from primary connection
   - emitSlotUpdate() → buffer + push to slot subscribers
   - Fan out blocksMeta and blocks subscribers with dedup cache
```

---

## Connection Examples

### @triton-one/yellowstone-grpc Client

```typescript
const { default: Client } = require('@triton-one/yellowstone-grpc');

const client = new Client('http://localhost:10000', 'your-admin-key', {
  'grpc.max_receive_message_length': 64 * 1024 * 1024,
});

async function demo() {
  const stream = await client.subscribe();

  // Subscribe to slots + accounts
  stream.write({
    slots: { all: {} },
    accounts: {
      token_holders: { owner: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] },
    },
    commitment: 1, // CONFIRMED
  });

  stream.on('data', (data) => {
    if (data.slot)
      console.log('Slot:', data.slot.slot, 'Status:', data.slot.status);
    if (data.account)
      console.log('Account:', data.account.account.pubkey.toString('base64'));
    if (data.transaction)
      console.log('Transaction:', data.transaction.signature.toString('base64'));
    if (data.ping)
      stream.write({ ping: { id: data.ping.id } }); // reply to server ping
  });
}
```

### grpcurl

```bash
# Set auth token
TOKEN=your-admin-key

# Unary calls
grpcurl -proto proto/geyser.proto -d '{}' \
  -H "x-token: $TOKEN" \
  localhost:10000 geyser.Geyser/GetVersion

grpcurl -proto proto/geyser.proto -d '{"commitment": 1}' \
  -H "x-token: $TOKEN" \
  localhost:10000 geyser.Geyser/GetSlot

grpcurl -proto proto/geyser.proto -d '{"commitment": 1}' \
  -H "x-token: $TOKEN" \
  localhost:10000 geyser.Geyser/GetLastBlockhash

# Subscribe to slots (live stream)
echo '{"slots": {"s1": {}}, "commitment": 1}' | \
grpcurl -proto proto/geyser.proto \
  -H "x-token: $TOKEN" \
  -d @ \
  localhost:10000 geyser.Geyser/Subscribe

# Subscribe with from_slot replay
echo '{"slots": {"s1": {}}, "from_slot": 420000000}' | \
grpcurl -proto proto/geyser.proto \
  -H "x-token: $TOKEN" \
  -d @ \
  localhost:10000 geyser.Geyser/Subscribe

# Ping (no auth needed)
grpcurl -proto proto/geyser.proto -d '{"count": 42}' \
  localhost:10000 geyser.Geyser/Ping
```

### Raw gRPC-js

```typescript
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const packageDef = protoLoader.loadSync('proto/geyser.proto', {
  keepCase: false, longs: Number, enums: Number, defaults: false, oneofs: true,
  includeDirs: ['proto'],
});
const proto = grpc.loadPackageDefinition(packageDef) as any;

const md = new grpc.Metadata();
md.add('x-token', 'your-admin-key');

const client = new proto.geyser.Geyser(
  'localhost:10000',
  grpc.credentials.createInsecure(),
);

// Unary call
client.GetVersion({}, md, (err, res) => {
  if (err) console.error('Error:', err.message);
  else console.log('Version:', res.version);
});

// Streaming call
const stream = client.Subscribe(md);
stream.on('data', (data) => {
  if (data.slot) console.log('Slot:', data.slot.slot);
});
stream.write({ slots: { all: {} }, commitment: 1 });
```

---

## Authentication

All RPCs **require** an `x-token` metadata header except `Ping`. The token is the `ADMIN_KEY` environment variable value (sent as-is, no hashing on the wire).

| Scenario | Result |
|----------|--------|
| Missing `x-token` | `UNAUTHENTICATED (code 16)` |
| Wrong `x-token` | `UNAUTHENTICATED (code 16)` |
| Correct `x-token` | Request proceeds |
| `Ping` without token | Always allowed |

The `ADMIN_KEY` is SHA256-hashed in memory for storage. The raw value is validated on each request.

---

## Subscribe Filters

### Accounts filter with memcmp

```typescript
stream.write({
  accounts: {
    my_program: {
      owner: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'],
      filters: [
        { memcmp: { offset: 0, bytes: Buffer.from([1,2,3]) } },
        { datasize: 165 },
        { lamports: { gt: 1000000 } },
      ],
      nonempty_txn_signature: true,
    },
  },
});
```

### Transaction filter with account include/exclude

```typescript
stream.write({
  transactions: {
    defi_tx: {
      vote: false,
      failed: false,
      account_include: ['JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'],
      account_required: ['So11111111111111111111111111111111111111112'],
    },
  },
});
```

### Block filter with transactions

```typescript
stream.write({
  blocks: {
    full_block: {
      include_transactions: true,
    },
  },
  blocks_meta: {
    summary: {},
  },
});
```

---

## Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `PORT` | `10000` | No | gRPC server port |
| `HOST` | `0.0.0.0` | No | Bind address |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | No | Solana JSON-RPC HTTP endpoint |
| `SOLANA_RPC_WS_URL` | Auto-derived from RPC URL | No | Solana WebSocket endpoint (auto-computed if omitted) |
| `ADMIN_KEY` | — | **Yes** | Secret key for `x-token` authentication. Must be a secure random value. |
| `TLS_CERT_PATH` | (empty) | No | Path to TLS certificate file. Empty = insecure gRPC. |
| `TLS_KEY_PATH` | (empty) | No | Path to TLS key file. |
| `LOG_LEVEL` | `info` | No | Pino log level (`fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`) |
| `MAX_STREAMS_PER_CONNECTION` | `100` | No | Max WebSocket subscriptions per RPC connection |
| `MAX_CONNECTIONS` | `10` | No | Max concurrent RPC connections in the pool |
| `PING_INTERVAL_MS` | `15000` | No | Server ping interval (ms). Server pings idle streams. |
| `PING_TIMEOUT_MS` | `60000` | No | Stream timeout (ms). Stream destroyed if no client response. |
| `SLOT_BUFFER_SIZE` | `500` | No | Ring buffer capacity for `from_slot` replay (~3 min at ~400ms slots) |
| `GRPC_MAX_MESSAGE_LENGTH` | `67108864` | No | Max gRPC message size in bytes (64 MB) |
| `METRICS_PORT` | `10001` | No | Internal metrics HTTP port |
| `BLOCK_POLL_INTERVAL_MS` | `500` | No | Block polling interval (reserved for future use) |

---

## Deployment

### Docker (multi-stage build)

The project includes a production-ready `Dockerfile` with multi-stage build:

- **Stage 1 (builder):** Installs all dependencies, compiles TypeScript to `dist/`
- **Stage 2 (runner):** Installs only production dependencies, copies compiled JS. Runs as non-root `appuser`. Exposes ports 10000 (gRPC) and 10001 (metrics).

```bash
docker build -t geyser-bridge .
docker run -d --name geyser-bridge -p 10000:10000 -p 10001:10001 \
  -e ADMIN_KEY=$(openssl rand -hex 32) \
  -e SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
  geyser-bridge
```

### Docker Compose (recommended)

```bash
cp .env.example .env
# EDIT .env: set ADMIN_KEY and any other overrides
docker compose up --build -d
```

The `docker-compose.yml` includes:

- Port mapping for gRPC (10000) and metrics (10001)
- `.env` file loading
- `restart: unless-stopped` for automatic recovery
- Health check against the metrics `/healthz` endpoint

### VPS (DigitalOcean / Hetzner / Railway / Fly.io)

```bash
# Prerequisites: Node.js 20+
git clone <repo> ~/geyser-bridge
cd ~/geyser-bridge
npm ci
npm run build

# Run with systemd, screen, or tmux
ADMIN_KEY=$(openssl rand -hex 32) node dist/index.js

# Or use environment file
cat > .env <<EOF
ADMIN_KEY=your-secure-key
LOG_LEVEL=info
EOF
node dist/index.js
```

### Health Check

```bash
# Ping is unauthenticated — always works
grpcurl -proto proto/geyser.proto -d '{}' \
  localhost:10000 geyser.Geyser/Ping

# Metrics HTTP endpoint
curl http://localhost:10001/healthz
curl http://localhost:10001/metrics
```

## Metrics

A built-in HTTP metrics server listens on `METRICS_PORT` (default `10001`) with two endpoints:

### `GET /healthz`

Simple liveness check — returns `{"status":"ok","uptime":N}`:

```bash
curl http://localhost:10001/healthz
# {"status":"ok","uptime":1234}
```

### `GET /metrics`

Prometheus-formatted text with counters and gauges:

```prometheus
# HELP geyser_rpc_calls_total Total RPC calls by method
# TYPE geyser_rpc_calls_total counter
geyser_rpc_calls_total{method="GetSlot"} 42
geyser_rpc_calls_total{method="GetVersion"} 7

# HELP geyser_streams_active Current active subscribe streams
# TYPE geyser_streams_active gauge
geyser_streams_active 3

# HELP geyser_subscribers_total Current subscriber count
# TYPE geyser_subscribers_total gauge
geyser_subscribers_total 5

# HELP geyser_pool_connections Total connections in pool
# TYPE geyser_pool_connections gauge
geyser_pool_connections 2

# HELP geyser_pool_load Total subscription count across all connections
# TYPE geyser_pool_load gauge
geyser_pool_load 12
```

Available metrics:

| Metric | Type | Description |
|--------|------|-------------|
| `geyser_start_time_seconds` | gauge | Unix timestamp of server start |
| `geyser_uptime_seconds` | gauge | Seconds since server start |
| `geyser_rpc_calls_total` | counter | Total RPC calls by `method` label |
| `geyser_rpc_calls_success` | counter | Successful calls by `method` label |
| `geyser_rpc_calls_failure` | counter | Failed calls by `method` label |
| `geyser_streams_opened_total` | counter | Total subscribe streams opened |
| `geyser_streams_active` | gauge | Currently active subscribe streams |
| `geyser_subscribers_total` | gauge | Current subscriber count (filter sets) |
| `geyser_pool_connections` | gauge | Total RPC connections in pool |
| `geyser_pool_load` | gauge | Sum of active subscriptions across all connections |

Point Prometheus at `http://<host>:10001/metrics` and add a Grafana dashboard to visualize. The metrics server is minimal (pure `node:http`, zero dependencies) and starts/stops with the main process.

---

## Limitations

- **Latency** — Real Geyser pushes from validator memory (~sub-ms). GeyserBridge adds RPC round-trip time (~200-500ms for `getTransaction`, `getBlock`). Fine for indexers, dashboards, most bots. Not suitable for HFT/MEV.
- **`processed` commitment** — `getTransaction` and `getBlock` require `confirmed`. Transaction data at `processed` level won't have full meta until confirmed.
- **`from_slot`** — replayed from the last `SLOT_BUFFER_SIZE` slots (default 500, ~3 min at ~400ms slot times). Slot data only; use JSON-RPC for historical account/transaction backfill.
- **No `entry` subscriptions** — Real Yellowstone has the same limitation (bug in Solana's BlockMeta). Entry data is not available from RPC.
- **`include_accounts` / `include_entries` in blocks filter** — Not supported. Full transaction data is pushed when `include_transactions: true`, but per-account-update and entry data require validator-level access.
- **No `SubscribeDeshred`** — Requires validator shred data not available from RPC `getBlock`.
- **`accounts_data_slice`** — Not yet supported in the account filter parser.

---

## License

MIT
