import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import { GeyserService } from '../../src/services/geyser';
import { ConnectionPool } from '../../src/solana/pool';
import { SubscriptionManager } from '../../src/subscriptions/manager';
import { RingBuffer } from '../../src/utils/ring-buffer';
import { SlotStatus } from '../../src/translate/slot';
import { Config } from '../../src/config';
import { SolanaBridge } from '../../src/bridge/solana-bridge';

class FakeStream extends EventEmitter {
  public written: any[] = [];
  public destroyed = false;

  write(data: any): boolean {
    this.written.push(data);
    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function makeConfig(): Config {
  return {
    port: 10000,
    host: '0.0.0.0',
    solanaRpcUrl: 'http://localhost:8899',
    solanaRpcWsUrl: 'ws://localhost:8900',
    adminKey: 'test-key',
    tlsCertPath: '',
    tlsKeyPath: '',
    logLevel: 'silent',
    metricsPort: 10001,
    blockPollIntervalMs: 500,
    maxStreamsPerConnection: 100,
    maxConnections: 10,
    pingIntervalMs: 15000,
    pingTimeoutMs: 60000,
    slotBufferSize: 500,
    grpcMaxMessageLength: 64 * 1024 * 1024,
    version: '1.0.0-test',
  };
}

describe('GeyserService', () => {
  let pool: ConnectionPool;
  let subManager: SubscriptionManager;
  let slotBuffer: RingBuffer<{ slot: number; parent: number | null; status: SlotStatus }>;
  let service: GeyserService;

  beforeEach(() => {
    pool = new ConnectionPool('http://localhost:8899', 'ws://localhost:8900', 100, 10);
    subManager = new SubscriptionManager();
    slotBuffer = new RingBuffer(500, (u) => u.slot);
    service = new GeyserService(pool, subManager, slotBuffer, makeConfig());
    service.start();
  });

  describe('subscribe', () => {
    it('registers subscriber and stores stream', () => {
      const stream = new FakeStream();
      service.subscribe(stream);

      // Send filter request
      stream.emit('data', {
        slots: { all: {} },
        commitment: 1,
      });

      expect(subManager.totalSubscribers).toBe(1);
    });

    it('replies to ping with pong', () => {
      const stream = new FakeStream();
      service.subscribe(stream);

      stream.emit('data', { ping: { id: 42 } });

      expect(stream.written).toHaveLength(1);
      expect(stream.written[0]).toHaveProperty('pong');
      expect(stream.written[0].pong.id).toBe(42);
    });

    it('sends periodic pings', () => {
      vi.useFakeTimers();
      const config = makeConfig();
      config.pingIntervalMs = 100;
      const localService = new GeyserService(pool, subManager, slotBuffer, config);
      localService.start();

      const stream = new FakeStream();
      localService.subscribe(stream);

      vi.advanceTimersByTime(250);
      expect(stream.written.filter((m: any) => m.ping).length).toBe(2);

      vi.useRealTimers();
      localService.stop();
    });
  });

  describe('pushAccountUpdate', () => {
    it('writes to matching subscriber streams', () => {
      const stream = new FakeStream();
      service.subscribe(stream);

      // Register account filter
      stream.emit('data', {
        accounts: { a1: { account: ['11111111111111111111111111111111'] } },
      });

      const update = {
        pubkey: Buffer.from(new PublicKey('11111111111111111111111111111111').toBytes()),
        lamports: 1000,
        owner: Buffer.from(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes()),
        executable: false,
        rentEpoch: 0,
        data: Buffer.from([1, 2, 3]),
        writeVersion: 1,
        txnSignature: undefined as Buffer | undefined,
        slot: 12345,
      };

      service.pushAccountUpdate(update);

      const accountMsgs = stream.written.filter((m: any) => m.account);
      expect(accountMsgs.length).toBeGreaterThanOrEqual(1);
      expect(accountMsgs[0].account.account.lamports).toBe(1000);
      expect(accountMsgs[0].account.slot).toBe(12345);
    });

    it('does not write to non-matching subscribers', () => {
      const stream = new FakeStream();
      service.subscribe(stream);

      stream.emit('data', {
        accounts: { a1: { account: ['22222222222222222222222222222222'] } },
      });

      const update = {
        pubkey: Buffer.from(new PublicKey('11111111111111111111111111111111').toBytes()),
        lamports: 1000,
        owner: Buffer.from(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes()),
        executable: false,
        rentEpoch: 0,
        data: Buffer.from([1, 2, 3]),
        writeVersion: 1,
        txnSignature: undefined as Buffer | undefined,
        slot: 12345,
      };

      service.pushAccountUpdate(update);
      expect(stream.written.filter((m: any) => m.account)).toHaveLength(0);
    });
  });

  describe('emitSlotUpdate', () => {
    it('pushes slot updates to subscriber streams', () => {
      const stream = new FakeStream();
      service.subscribe(stream);

      stream.emit('data', {
        slots: { all: {} },
        commitment: 1,
      });

      service.emitSlotUpdate(100, 99, SlotStatus.SLOT_CONFIRMED);

      const slotMsgs = stream.written.filter((m: any) => m.slot);
      expect(slotMsgs.length).toBeGreaterThanOrEqual(1);
      expect(slotMsgs[0].slot.slot).toBe(100);
      expect(slotMsgs[0].slot.parent).toBe(99);
      expect(slotMsgs[0].slot.status).toBe(SlotStatus.SLOT_CONFIRMED);
    });

    it('does not push slot updates to non-slot subscribers', () => {
      const stream = new FakeStream();
      service.subscribe(stream);

      // Only account filter, no slot filter
      stream.emit('data', {
        accounts: { a1: { account: ['11111111111111111111111111111111'] } },
      });

      service.emitSlotUpdate(100, 99, SlotStatus.SLOT_CONFIRMED);
      expect(stream.written.filter((m: any) => m.slot)).toHaveLength(0);
    });
  });

  describe('connectBridge', () => {
    it('forwards account updates from bridge to subscriber streams', () => {
      const stream = new FakeStream();
      service.subscribe(stream);

      stream.emit('data', {
        accounts: { a1: { account: ['11111111111111111111111111111111'] } },
      });

      // Create a minimal bridge and connect
      const bridge = new SolanaBridge(pool, subManager, makeConfig());
      service.connectBridge(bridge);

      // Simulate bridge emitting an account update
      bridge.emit('accountUpdate', {
        pubkey: Buffer.from(new PublicKey('11111111111111111111111111111111').toBytes()),
        lamports: 500,
        owner: Buffer.from(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes()),
        executable: false,
        rentEpoch: 0,
        data: Buffer.from([1, 2, 3]),
        writeVersion: 1,
        txnSignature: undefined as Buffer | undefined,
        slot: 200,
      });

      const accountMsgs = stream.written.filter((m: any) => m.account);
      expect(accountMsgs.length).toBeGreaterThanOrEqual(1);
      expect(accountMsgs[accountMsgs.length - 1].account.account.lamports).toBe(500);
    });
  });

  describe('unary RPCs', () => {
    it('getVersion returns config version', () => {
      return new Promise<void>((done) => {
        service.getVersion({} as any, (err: any, resp: any) => {
          expect(resp.version).toBe('1.0.0-test');
          done();
        });
      });
    });
  });
});
