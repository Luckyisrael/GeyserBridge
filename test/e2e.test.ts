/**
 * E2E test: starts the full GeyserBridge server in-process,
 * connects a real gRPC client, exercises all RPCs, then shuts down.
 *
 * Also tests auth: unauthenticated requests are rejected, valid admin key succeeds.
 *
 * Requires: ADMIN_KEY env var (set to 'test-e2e-key' by default).
 * Contacts real Solana RPC from your .env or defaults to mainnet-beta.
 *
 * Run: npx vitest run test/e2e.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';

const PROTO_PATH = path.resolve(__dirname, '../proto/geyser.proto');
const PROTO_DIR = path.resolve(__dirname, '../proto');

process.env.PORT = '19001';
process.env.ADMIN_KEY = process.env.ADMIN_KEY || 'test-e2e-key';
process.env.LOG_LEVEL = 'warn';

const TEST_PORT = 19001;
const TEST_HOST = '127.0.0.1';
const TEST_ADMIN_KEY = process.env.ADMIN_KEY;

function makeMetadata(key?: string): grpc.Metadata | undefined {
  if (!key) return undefined;
  const md = new grpc.Metadata();
  md.add('x-token', key);
  return md;
}

describe('GeyserBridge E2E', () => {
  let client: any;
  let clientNoAuth: any;
  let server: any;

  beforeAll(async () => {
    const { loadConfig } = await import('../src/config');
    const { initLogger, getLogger } = await import('../src/utils/logger');
    const { RingBuffer } = await import('../src/utils/ring-buffer');
    const { ConnectionPool } = await import('../src/solana/pool');
    const { SubscriptionManager } = await import('../src/subscriptions/manager');
    const { GeyserService } = await import('../src/services/geyser');
    const { SolanaBridge } = await import('../src/bridge/solana-bridge');
    const { statusFromCommitment } = await import('../src/translate/slot');
    const { ApiKeyStore } = await import('../src/auth/store');
    const { requireAuth, requireAuthStream } = await import('../src/auth/interceptor');

    const config = { ...loadConfig(), port: TEST_PORT, host: TEST_HOST };
    initLogger(config);

    const apiKeyStore = new ApiKeyStore(config.adminKey);
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
      Subscribe: requireAuthStream(apiKeyStore, geyserService.subscribe.bind(geyserService)),
      Ping: geyserService.ping.bind(geyserService),
      GetSlot: requireAuth(apiKeyStore, geyserService.getSlot.bind(geyserService)),
      GetBlockHeight: requireAuth(apiKeyStore, geyserService.getBlockHeight.bind(geyserService)),
      GetLatestBlockhash: requireAuth(apiKeyStore, geyserService.getLatestBlockhash.bind(geyserService)),
      IsBlockhashValid: requireAuth(apiKeyStore, geyserService.isBlockhashValid.bind(geyserService)),
      GetVersion: requireAuth(apiKeyStore, geyserService.getVersion.bind(geyserService)),
      SubscribeDeshred: requireAuthStream(apiKeyStore, (_c: any) => {
        _c.emit('error', { code: grpc.status.UNIMPLEMENTED });
        _c.destroy();
      }),
      SubscribeReplayInfo: requireAuth(apiKeyStore, (_c: any, cb: any) => cb(null, { first_available: null })),
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

    const pc = pool.acquire();
    pc.connection.onSlotChange((si: any) => {
      const st = statusFromCommitment(1);
      geyserService.emitSlotUpdate(Number(si.slot), si.parent ? Number(si.parent) : null, st);
    });
    pool.release(pc.id);

    const Client = proto.geyser.Geyser;
    client = new Client(`${TEST_HOST}:${TEST_PORT}`, grpc.credentials.createInsecure());
    clientNoAuth = new Client(`${TEST_HOST}:${TEST_PORT}`, grpc.credentials.createInsecure());
  }, 15_000);

  afterAll(() => {
    if (server) server.tryShutdown(() => {});
    if (client) client.close();
    if (clientNoAuth) clientNoAuth.close();
  });

  describe('authentication', () => {
    it('rejects unauthenticated requests with UNAUTHENTICATED', async () => {
      const err = await new Promise<any>((resolve) => {
        clientNoAuth.GetVersion({}, (err: any) => resolve(err));
      });
      expect(err).not.toBeNull();
      expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
    });

    it('allows Ping without auth', async () => {
      const resp = await new Promise<any>((resolve, reject) => {
        clientNoAuth.Ping({ count: 1 }, (err: any, r: any) => (err ? reject(err) : resolve(r)));
      });
      expect(resp.count).toBe(1);
    });

    it('accepts valid admin key', async () => {
      const resp = await new Promise<any>((resolve, reject) => {
        client.GetVersion({}, makeMetadata(TEST_ADMIN_KEY), (err: any, r: any) =>
          err ? reject(err) : resolve(r),
        );
      });
      expect(resp).toHaveProperty('version');
    });

    it('rejects invalid x-token', async () => {
      const err = await new Promise<any>((resolve) => {
        clientNoAuth.GetVersion({}, makeMetadata('wrong-key'), (err: any) => resolve(err));
      });
      expect(err).not.toBeNull();
      expect(err.code).toBe(grpc.status.UNAUTHENTICATED);
    });
  });

  describe('unary RPCs', () => {
    const meta = makeMetadata(TEST_ADMIN_KEY);

    it('GetVersion returns version string', async () => {
      const resp = await new Promise<any>((resolve, reject) => {
        client.GetVersion({}, meta, (err: any, r: any) => (err ? reject(err) : resolve(r)));
      });
      expect(resp).toHaveProperty('version');
      expect(typeof resp.version).toBe('string');
    });

    it('GetSlot returns a slot number', async () => {
      const resp = await new Promise<any>((resolve, reject) => {
        client.GetSlot({ commitment: 1 }, meta, (err: any, r: any) => (err ? reject(err) : resolve(r)));
      });
      expect(resp).toHaveProperty('slot');
      expect(Number(resp.slot)).toBeGreaterThan(0);
    });

    it('GetBlockHeight returns a block height', async () => {
      const resp = await new Promise<any>((resolve, reject) => {
        client.GetBlockHeight({ commitment: 1 }, meta, (err: any, r: any) => (err ? reject(err) : resolve(r)));
      });
      expect(resp).toHaveProperty('blockHeight');
      expect(Number(resp.blockHeight)).toBeGreaterThan(0);
    });

    it('GetLatestBlockhash returns blockhash + last valid height', async () => {
      const resp = await new Promise<any>((resolve, reject) => {
        client.GetLatestBlockhash({ commitment: 1 }, meta, (err: any, r: any) => (err ? reject(err) : resolve(r)));
      });
      expect(resp).toHaveProperty('blockhash');
      expect(typeof resp.blockhash).toBe('string');
      expect(resp.blockhash.length).toBeGreaterThan(30);
      expect(resp).toHaveProperty('lastValidBlockHeight');
      expect(resp).toHaveProperty('slot');
    });

    it('IsBlockhashValid validates a known blockhash', async () => {
      const bh = await new Promise<any>((resolve, reject) => {
        client.GetLatestBlockhash({ commitment: 1 }, meta, (err: any, r: any) =>
          err ? reject(err) : resolve(r),
        );
      });
      const resp = await new Promise<any>((resolve, reject) => {
        client.IsBlockhashValid({ blockhash: bh.blockhash, commitment: 1 }, meta, (err: any, r: any) =>
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
  });

  describe('subscribe stream', () => {
    const meta = makeMetadata(TEST_ADMIN_KEY);

    it('receives slot updates', async () => {
      const stream = client.Subscribe(meta);
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

    it('handles ping/pong', async () => {
      const stream = client.Subscribe(meta);
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

    it('rejects unauthenticated Subscribe', async () => {
      const stream = clientNoAuth.Subscribe();
      const err = await new Promise<any>((resolve) => {
        stream.on('error', resolve);
        stream.write({ slots: { all: {} } });
      });
      expect(err).toBeDefined();
      stream.destroy();
    });
  });
});
