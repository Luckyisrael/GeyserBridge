import { EventEmitter } from 'events';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { ConnectionPool } from '../solana/pool';
import { SubscriptionManager } from '../subscriptions/manager';
import { getLogger } from '../utils/logger';
import { Config } from '../config';
import { makeAccountUpdate } from '../translate/account';
import { makeTransactionUpdate } from '../translate/transaction';

export interface StreamWriter {
  write(data: any): boolean;
  destroy(): void;
}

interface ManagedAccountSub {
  subscriptionId: number;
  owner: string;
  poolEntryId: number;
}

interface ManagedLogsSub {
  subscriptionId: number;
  poolEntryId: number;
}

export class SolanaBridge extends EventEmitter {
  private pool: ConnectionPool;
  private subManager: SubscriptionManager;
  private config: Config;

  private reconcileTimer: NodeJS.Timeout | null = null;
  private running = false;

  private accountSubs: Map<string, ManagedAccountSub> = new Map();
  private logsSub: ManagedLogsSub | null = null;
  private pendingTxFetches: Map<string, Promise<void>> = new Map();

  constructor(pool: ConnectionPool, subManager: SubscriptionManager, config: Config) {
    super();
    this.pool = pool;
    this.subManager = subManager;
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    getLogger().info('SolanaBridge starting');
    this.reconcileTimer = setInterval(() => this.reconcile(), 10_000);
    this.reconcile();
  }

  stop(): void {
    this.running = false;
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = null; }
    this.unsubscribeAll();
  }

  private getAccountOwners(): Set<string> {
    const owners = new Set<string>();
    for (const state of this.subManager.getAllSubscribers().values()) {
      for (const filter of state.filters.accounts.values()) {
        if (filter.owners) for (const o of filter.owners) owners.add(o);
      }
    }
    return owners;
  }

  private hasTxSubs(): boolean {
    for (const state of this.subManager.getAllSubscribers().values()) {
      if (state.filters.transactions.size > 0 || state.filters.transactionsStatus.size > 0) return true;
    }
    return false;
  }

  private reconcile(): void {
    if (!this.running) return;

    const desiredOwners = this.getAccountOwners();
    const desiredTx = this.hasTxSubs();

    for (const [owner, sub] of this.accountSubs) {
      if (!desiredOwners.has(owner)) {
        this.unsubscribeAccount(owner, sub);
      }
    }
    for (const owner of desiredOwners) {
      if (!this.accountSubs.has(owner)) {
        this.subscribeAccount(owner);
      }
    }

    if (desiredTx && !this.logsSub) {
      this.subscribeLogs();
    } else if (!desiredTx && this.logsSub) {
      this.unsubscribeLogs();
    }
  }

  private subscribeAccount(owner: string): void {
    try {
      const ownerPubkey = new PublicKey(owner);
      const entry = this.pool.acquire();
      const conn = entry.connection;
      const subId = conn.onProgramAccountChange(
        ownerPubkey,
        (keyedAccountInfo: any, context: any) => {
          if (!this.running) return;
          const update = makeAccountUpdate(
            keyedAccountInfo.accountId,
            keyedAccountInfo.accountInfo,
            context.slot,
          );
          this.emit('accountUpdate', update);
        },
        'confirmed',
      );
      this.accountSubs.set(owner, { subscriptionId: subId, owner, poolEntryId: entry.id });
      getLogger().debug({ owner, subId }, 'Subscribed to program account changes');
    } catch (err: any) {
      getLogger().error({ owner, err: err.message }, 'Failed to subscribe to program accounts');
    }
  }

  private unsubscribeAccount(owner: string, sub: ManagedAccountSub): void {
    try {
      const entry = this.pool.getConnection(sub.poolEntryId);
      if (entry) {
        entry.connection.removeProgramAccountChangeListener(sub.subscriptionId);
        this.pool.release(sub.poolEntryId);
      }
    } catch (err: any) {
      getLogger().error({ owner, err: err.message }, 'Failed to unsubscribe from program accounts');
    }
    this.accountSubs.delete(owner);
  }

  private subscribeLogs(): void {
    try {
      const entry = this.pool.acquire();
      const conn = entry.connection;
      const subId = conn.onLogs(
        'all' as any,
        (logInfo: any, context: any) => {
          if (!this.running) return;
          const sig = logInfo.signature;
          const slot = context.slot;
          const err = logInfo.err;
          const isVote = !!(logInfo.logs && logInfo.logs.some((l: string) => l.includes('Program Vote111111111111111111111111111111111111111')));
          this.emit('transactionStatus', {
            slot: Number(slot),
            signature: Buffer.from(bs58.decode(sig)),
            isVote,
            index: 0,
            err: err ? Buffer.from(JSON.stringify(err)) : null,
          });
          this.fetchAndEmitTransaction(sig, slot);
        },
        'confirmed',
      );
      this.logsSub = { subscriptionId: subId, poolEntryId: entry.id };
      getLogger().debug({ subId }, 'Subscribed to logs');
    } catch (err: any) {
      getLogger().error({ err: err.message }, 'Failed to subscribe to logs');
    }
  }

  private unsubscribeLogs(): void {
    if (!this.logsSub) return;
    try {
      const entry = this.pool.getConnection(this.logsSub.poolEntryId);
      if (entry) {
        entry.connection.removeOnLogsListener(this.logsSub.subscriptionId);
        this.pool.release(this.logsSub.poolEntryId);
      }
    } catch (err: any) {
      getLogger().error({ err: err.message }, 'Failed to unsubscribe from logs');
    }
    this.logsSub = null;
  }

  private async fetchAndEmitTransaction(sig: string, slot: number): Promise<void> {
    if (this.pendingTxFetches.has(sig)) return;
    const entry = await this.pool.acquireRateLimited();
    const promise = entry.connection.getTransaction(sig, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    }).finally(() => this.pool.release(entry.id));
    this.pendingTxFetches.set(sig, promise.then(() => {}));
    try {
      const tx = await promise;
      if (!tx) return;
      const update = makeTransactionUpdate(sig, { ...tx, slot });
      if (update) {
        this.emit('transactionUpdate', update);
      }
    } catch (err: any) {
      getLogger().debug({ sig, err: err?.message }, 'Transaction fetch failed (may be too recent)');
    } finally {
      this.pendingTxFetches.delete(sig);
    }
  }

  private unsubscribeAll(): void {
    for (const [owner, sub] of this.accountSubs) {
      this.unsubscribeAccount(owner, sub);
    }
    this.unsubscribeLogs();
  }
}
