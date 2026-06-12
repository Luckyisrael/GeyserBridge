/**
 * E2E test: starts the full GeyserBridge server in-process,
 * connects a real gRPC client, exercises all RPCs, then shuts down.
 *
 * Requires: ADMIN_KEY env var (set to 'test' or whatever your .env has).
 * Contacts the real Solana RPC from your .env or defaults to mainnet-beta.
 *
 * Run: npx vitest run src/e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { EventEmitter } from 'events';

const PROTO_PATH = path.resolve(__dirname, '../proto/geyser.proto');
const PROTO_DIR = path.resolve(__dirname, '../proto');

// ----- helpers to load the server in-process -----
// We import and call bootstrap directly (it's async and binds a port).
// Since the server uses random ports isn't easy, we pre-choose a fixed test port.
process.env.PORT = '19001';
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'test-e2e-key';
process.env.LOG_LEVEL = 'warn';

const TEST_PORT = 19001;
const TEST_HOST = '127.0.0.1';

describe('GeyserBridge E2E', () => {
  let client: any;
  let server: any;

  beforeAll(async () => {
    // Dynamically load & start server
    const { loadConfig } = await import('../src/config');
    const { initLogger, getLogger } = await import('../src/utils/logger');
    const { RingBuffer } = await import('../src/utils/ring-buffer');
    const { ConnectionPool } = await import('../src/solana/pool');
    const { SubscriptionManager } = await import('../src/subscriptions/manager');
    const { GeyserService } = await import('../src/services/geyser');
    const { SolanaBridge } = await import('../src/bridge/solana-bridge');
    const { statusFromCommitment } = await import('../src/translate/slot');

    const config = { ...loadConfig(), port: TEST_PORT, host: TEST_HOST };
    initLogger(config);
    const log = getLogger();

    const pool = new ConnectionPool(config.solanaRpcUrl, config.solanaRpcWsUrl, 100, 5);
    const subManager = new SubscriptionManager();
    const slotBuffer = new RingBuffer<{ slot: number; parent: number | null; status: number }>(500, (u) => u.slot);
    const geyserService = new GeyserService(pool, subManager, slotBuffer, config);
    const solanaBridge = new SolanaBridge(pool, subManager, config);
    geyserService.connectBridge(solanaBridge);

    const packageDef = protoLoader.loadSync(PROTO_PATH, {
      keepCase: false, longs: Number, enums: Number, defaults: false, oneofs: true,
      includeDirs: [PROTO_DIR],
    });
    const proto = grpc.loadPackageDefinition(packageDef) as any;

    server = new grpc.Server({ 'grpc.max_receive_message_length': 64 * 1024 * 1024 });
    server.addService(proto.geyser.Geyser.service, {
      Subscribe: geyserService.subscribe.bind(geyserService),
      Ping: geyserService.ping.bind(geyserService),
      GetSlot: geyserService.getSlot.bind(geyserService),
      GetBlockHeight: geyserService.getBlockHeight.bind(geyserService),
      GetLatestBlockhash: geyserService.getLatestBlockhash.bind(geyserService),
      IsBlockhashValid: geyserService.isBlockhashValid.bind(geyserService),
      GetVersion: geyserService.getVersion.bind(geyserService),
      SubscribeDeshred: (_c: any, cb: any) => cb({ code: grpc.status.UNIMPLEMENTED }),
      SubscribeReplayInfo: (_c: any, cb: any) => cb(null, { first_available: null }),
    });

    await new Promise<void>((resolve, reject) => {
      server.bindAsync(`${TEST_HOST}:${TEST_PORT}`, grpc.ServerCredentials.createInsecure(), (err: any) => {
        if (err) { reject(err); return; }
        server.start();
        resolve();
      });
    });

    geyserService.start();
    solanaBridge.start();

    // Set up slot listener so we pump data
    const pc = pool.acquire();
    pc.connection.onSlotChange((si: any) => {
      const st = statusFromCommitment(1);
      geyserService.emitSlotUpdate(Number(si.slot), si.parent ? Number(si.parent) : null, st);
    });
    pool.release(pc.id);

    // Create gRPC client
    const Client = proto.geyser.Geyser;
    client = new Client(`${TEST_HOST}:${TEST_PORT}`, grpc.credentials.createInsecure());
  }, 15_000);

  afterAll(() => {
    if (server) server.tryShutdown(() => {});
    if (client) client.close();
  });

  it('GetVersion returns version string', async () => {
    const resp = await new Promise<any>((resolve, reject) => {
      client.GetVersion({}, (err: any, r: any) => (err ? reject(err) : resolve(r)));
    });
    expect(resp).toHaveProperty('version');
    expect(typeof resp.version).toBe('string');
  });

  it('GetSlot returns a slot number', async () => {
    const resp = await new Promise<any>((resolve, reject) => {
      client.GetSlot({ commitment: 1 }, (err: any, r: any) => (err ? reject(err) : resolve(r)));
    });
    expect(resp).toHaveProperty('slot');
    expect(Number(resp.slot)).toBeGreaterThan(0);
  });

  it('GetBlockHeight returns a block height', async () => {
    const resp = await new Promise<any>((resolve, reject) => {
      client.GetBlockHeight({ commitment: 1 }, (err: any, r: any) => (err ? reject(err) : resolve(r)));
    });
    expect(resp).toHaveProperty('blockHeight');
    expect(Number(resp.blockHeight)).toBeGreaterThan(0);
  });

  it('GetLatestBlockhash returns blockhash + last valid height', async () => {
    const resp = await new Promise<any>((resolve, reject) => {
      client.GetLatestBlockhash({ commitment: 1 }, (err: any, r: any) => (err ? reject(err) : resolve(r)));
    });
    expect(resp).toHaveProperty('blockhash');
    expect(typeof resp.blockhash).toBe('string');
    expect(resp.blockhash.length).toBeGreaterThan(30);
    expect(resp).toHaveProperty('lastValidBlockHeight');
    expect(resp).toHaveProperty('slot');
  });

  it('IsBlockhashValid validates a known blockhash', async () => {
    // First get a real blockhash
    const bh = await new Promise<any>((resolve, reject) => {
      client.GetLatestBlockhash({ commitment: 1 }, (err: any, r: any) => (err ? reject(err) : resolve(r)));
    });
    const resp = await new Promise<any>((resolve, reject) => {
      client.IsBlockhashValid({ blockhash: bh.blockhash, commitment: 1 }, (err: any, r: any) =>
        err ? reject(err) : resolve(r),
      );
    });
    expect(resp).toHaveProperty('valid');
    expect(resp.valid).toBe(true);
  });

  it('Ping returns count', async () => {
    const resp = await new Promise<any>((resolve, reject) => {
      client.Ping({ count: 42 }, (err: any, r: any) => (err ? reject(err) : resolve(r)));
    });
    expect(resp.count).toBe(42);
  });

  it('Subscribe receives slot updates', async () => {
    const stream = client.Subscribe();

    const updates = await new Promise<any[]>((resolve, reject) => {
      const msgs: any[] = [];
      const timeout = setTimeout(() => resolve(msgs), 10_000);

      stream.on('data', (data: any) => {
        if (data.slot) {
          msgs.push(data);
          if (msgs.length >= 3) {
            clearTimeout(timeout);
            resolve(msgs);
          }
        }
      });
      stream.on('error', reject);

      // Register slot filter
      stream.write({ slots: { all: {} }, commitment: 1 });
    });

    expect(updates.length).toBeGreaterThanOrEqual(3);
    for (const u of updates) {
      expect(u.slot).toHaveProperty('slot');
      expect(Number(u.slot.slot)).toBeGreaterThan(0);
      expect(u.slot).toHaveProperty('status');
    }

    stream.end();
  }, 20_000);

  it('Subscribe handles ping/pong', async () => {
    const stream = client.Subscribe();
    const pongs: any[] = [];

    const result = await new Promise<any>((resolve, reject) => {
      const timeout = setTimeout(() => resolve(pongs), 8_000);

      stream.on('data', (data: any) => {
        if (data.pong) {
          pongs.push(data);
          clearTimeout(timeout);
          resolve(pongs);
        }
      });
      stream.on('error', reject);

      stream.write({ ping: { id: 7 } });
    });

    expect(pongs.length).toBeGreaterThanOrEqual(1);
    expect(pongs[0].pong.id).toBe(7);
    stream.end();
  });
});
