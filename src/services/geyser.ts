import { EventEmitter } from 'events';
import { sendUnaryData, ServerUnaryCall } from '@grpc/grpc-js';
import { Connection } from '@solana/web3.js';
import bs58 from 'bs58';
import { ConnectionPool } from '../solana/pool';
import { SubscriptionManager, SubscriberFilters, SubscriberState } from '../subscriptions/manager';
import { RingBuffer } from '../utils/ring-buffer';
import { getLogger } from '../utils/logger';
import { Config } from '../config';
import { CommitmentLevel, commitmentFromOptional, commitmentToSolana } from '../translate/commitment';
import { SlotStatus, statusFromCommitment } from '../translate/slot';
import { AccountUpdate } from '../translate/account';
import { TransactionUpdate } from '../translate/transaction';
import { BlockUpdate, makeBlockMeta } from '../translate/block';
import { SolanaBridge, StreamWriter } from '../bridge/solana-bridge';

interface SlotUpdate {
  slot: number;
  parent: number | null;
  status: SlotStatus;
}

export class GeyserService extends EventEmitter {
  private pool: ConnectionPool;
  private subManager: SubscriptionManager;
  private slotBuffer: RingBuffer<SlotUpdate>;
  private config: Config;
  private running = false;
  private pingTimers: Map<string, NodeJS.Timeout> = new Map();
  private streams: Map<string, StreamWriter> = new Map();

  constructor(pool: ConnectionPool, subManager: SubscriptionManager, slotBuffer: RingBuffer<SlotUpdate>, config: Config) {
    super();
    this.pool = pool;
    this.subManager = subManager;
    this.slotBuffer = slotBuffer;
    this.config = config;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    getLogger().info('Geyser service started');
  }

  stop(): void {
    this.running = false;
    for (const t of this.pingTimers.values()) clearInterval(t);
    this.pingTimers.clear();
    this.streams.clear();
  }

  /** Connect to SolanaBridge to fan out data to subscriber streams */
  connectBridge(bridge: SolanaBridge): void {
    bridge.on('accountUpdate', (update: AccountUpdate) => this.pushAccountUpdate(update));
    bridge.on('transactionStatus', (status: { slot: number; signature: Buffer; isVote: boolean; index: number; err: Buffer | null }) =>
      this.pushTransactionStatus(status),
    );
    bridge.on('transactionUpdate', (update: TransactionUpdate) => this.pushTransactionUpdate(update));
  }

  /** Push an account update to matching subscriber streams */
  pushAccountUpdate(update: AccountUpdate): void {
    for (const [sid, state] of this.subManager.getAllSubscribers()) {
      for (const filter of state.filters.accounts.values()) {
        if (this.subManager.shouldSendAccount(update, filter)) {
          const stream = this.streams.get(sid);
          if (!stream) continue;
          const accountMsg = {
            account: {
              account: {
                pubkey: update.pubkey,
                lamports: update.lamports,
                owner: update.owner,
                executable: update.executable,
                rentEpoch: update.rentEpoch,
                data: update.data,
                writeVersion: update.writeVersion,
                txnSignature: update.txnSignature ?? null,
              },
              slot: Number(update.slot),
              isStartup: false,
            },
            filters: [sid],
          };
          try { stream.write(accountMsg); } catch { this.streams.delete(sid); }
          break;
        }
      }
    }
  }

  /** Push a transaction status update to matching subscriber streams */
  pushTransactionStatus(status: { slot: number; signature: Buffer; isVote: boolean; index: number; err: Buffer | null }): void {
    for (const [sid, state] of this.subManager.getAllSubscribers()) {
      const filters = state.filters.transactionsStatus;
      if (filters.size === 0) continue;
      const txUpdate: TransactionUpdate = {
        signature: status.signature,
        isVote: status.isVote,
        slot: status.slot,
        index: status.index,
        transaction: {
          signatures: [status.signature],
          message: {
            header: { numRequiredSignatures: 0, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 },
            accountKeys: [],
            recentBlockhash: Buffer.alloc(32),
            instructions: [],
            versioned: false,
            addressTableLookups: [],
          },
        },
        meta: {
          err: status.err,
          fee: 0,
          preBalances: [],
          postBalances: [],
          innerInstructions: [],
          logMessages: [],
          preTokenBalances: [],
          postTokenBalances: [],
          loadedWritableAddresses: [],
          loadedReadonlyAddresses: [],
        },
      };
      for (const filter of filters.values()) {
        if (this.subManager.shouldSendTransaction(txUpdate, filter)) {
          const stream = this.streams.get(sid);
          if (!stream) continue;
          const statusMsg = {
            transactionStatus: {
              slot: Number(status.slot),
              signature: status.signature,
              isVote: status.isVote,
              index: Number(status.index),
              err: status.err ?? null,
            },
            filters: [sid],
          };
          try { stream.write(statusMsg); } catch { this.streams.delete(sid); }
          break;
        }
      }
    }
  }

  /** Push a full transaction update to matching subscriber streams */
  pushTransactionUpdate(update: TransactionUpdate): void {
    for (const [sid, state] of this.subManager.getAllSubscribers()) {
      for (const filter of state.filters.transactions.values()) {
        if (this.subManager.shouldSendTransaction(update, filter)) {
          const stream = this.streams.get(sid);
          if (!stream) continue;
          const txMsg = {
            transaction: {
              signature: update.signature,
              isVote: update.isVote,
              transaction: {
                signatures: update.transaction.signatures.map((s) => Buffer.from(s)),
                message: {
                  header: update.transaction.message.header,
                  accountKeys: update.transaction.message.accountKeys.map((k) => Buffer.from(k)),
                  recentBlockhash: Buffer.from(update.transaction.message.recentBlockhash),
                  instructions: update.transaction.message.instructions.map((ix) => ({
                    programIdIndex: ix.programIdIndex,
                    accounts: Buffer.from(ix.accounts),
                    data: Buffer.from(ix.data),
                  })),
                  versioned: update.transaction.message.versioned,
                  addressTableLookups: update.transaction.message.addressTableLookups.map((l) => ({
                    accountKey: Buffer.from(l.accountKey),
                    writableIndexes: Buffer.from(l.writableIndexes),
                    readonlyIndexes: Buffer.from(l.readonlyIndexes),
                  })),
                },
              },
              meta: {
                err: update.meta.err && update.meta.err.length > 0 ? update.meta.err : null,
                fee: Number(update.meta.fee),
                preBalances: update.meta.preBalances.map((b) => Number(b)),
                postBalances: update.meta.postBalances.map((b) => Number(b)),
                innerInstructions: update.meta.innerInstructions.map((ii) => ({
                  index: ii.index,
                  instructions: ii.instructions.map((inst) => ({
                    programIdIndex: inst.programIdIndex,
                    accounts: Buffer.from(inst.accounts),
                    data: Buffer.from(inst.data),
                    stackHeight: inst.stackHeight ?? null,
                  })),
                })),
                logMessages: update.meta.logMessages,
                preTokenBalances: update.meta.preTokenBalances,
                postTokenBalances: update.meta.postTokenBalances,
                loadedWritableAddresses: update.meta.loadedWritableAddresses.map((a) => Buffer.from(a)),
                loadedReadonlyAddresses: update.meta.loadedReadonlyAddresses.map((a) => Buffer.from(a)),
                computeUnitsConsumed: update.meta.computeUnitsConsumed ?? null,
              },
              slot: Number(update.slot),
            },
            filters: [sid],
          };
          try { stream.write(txMsg); } catch { this.streams.delete(sid); }
          break;
        }
      }
    }
  }

  /** Emit slot / block updates to subscriber streams */
  emitSlotUpdate(slot: number, parent: number | null, status: SlotStatus): void {
    this.slotBuffer.push({ slot, parent, status });
    this.emit('slotUpdate', { slot, parent, status });

    const slotMsg: any = {
      slot: {
        slot: Number(slot),
        parent: parent != null ? Number(parent) : null,
        status: Number(status),
      },
    };

    for (const [sid, state] of this.subManager.getAllSubscribers()) {
      if (state.filters.slots.size > 0) {
        const stream = this.streams.get(sid);
        if (!stream) continue;
        const msg = { ...slotMsg, filters: [sid] };
        try { stream.write(msg); } catch { this.streams.delete(sid); }
      }
    }

    // If any subscriber wants blocks_meta, fetch the block
    for (const [sid, state] of this.subManager.getAllSubscribers()) {
      if (state.filters.blocksMeta.size > 0) {
        this.fetchAndPushBlockMeta(slot, sid);
        break;
      }
    }
  }

  private async fetchAndPushBlockMeta(slot: number, sid: string): Promise<void> {
    const stream = this.streams.get(sid);
    if (!stream) return;
    try {
      const entry = this.pool.acquire();
      const block = await entry.connection.getBlock(slot, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0,
      });
      this.pool.release(entry.id);
      if (!block) return;
      const meta = makeBlockMeta(block, slot);
      const msg = {
        blockMeta: {
          slot: Number(meta.slot),
          blockhash: meta.blockhash,
          blockTime: meta.blockTime ? Number(meta.blockTime) : null,
          blockHeight: meta.blockHeight ? Number(meta.blockHeight) : null,
          parentSlot: Number(meta.parentSlot),
          parentBlockhash: meta.parentBlockhash,
          executedTransactionCount: Number(meta.executedTransactionCount),
          entriesCount: Number(meta.entryCount),
        },
        filters: [sid],
      };
      try { stream.write(msg); } catch { this.streams.delete(sid); }
    } catch {
      // Block not yet available
    }
  }

  getVersion(_call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>): void {
    callback(null, { version: this.config.version });
  }

  getSlot(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>): void {
    const commitment = commitmentFromOptional(call.request?.commitment);
    this.doWithConn((conn) =>
      conn.getSlot(commitmentToSolana(commitment)).then((s) => callback(null, { slot: Number(s) })),
    );
  }

  getBlockHeight(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>): void {
    const commitment = commitmentFromOptional(call.request?.commitment);
    this.doWithConn((conn) =>
      conn.getBlockHeight(commitmentToSolana(commitment)).then((h) => callback(null, { blockHeight: Number(h) })),
    );
  }

  getLatestBlockhash(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>): void {
    const commitment = commitmentFromOptional(call.request?.commitment);
    this.doWithConn((conn) =>
      conn.getLatestBlockhashAndContext(commitmentToSolana(commitment)).then((r) =>
        callback(null, {
          slot: Number(r.context.slot),
          blockhash: r.value.blockhash,
          lastValidBlockHeight: Number(r.value.lastValidBlockHeight),
        }),
      ),
    );
  }

  isBlockhashValid(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>): void {
    const commitment = commitmentFromOptional(call.request?.commitment);
    this.doWithConn((conn) =>
      conn.isBlockhashValid(call.request.blockhash, { commitment: commitmentToSolana(commitment) }).then((r) =>
        callback(null, { slot: Number(r.context.slot), valid: r.value }),
      ),
    );
  }

  ping(call: ServerUnaryCall<any, any>, callback: sendUnaryData<any>): void {
    callback(null, { count: call.request?.count ?? 0 });
  }

  subscribe(stream: any): void {
    const clientId = `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    let committed: CommitmentLevel = CommitmentLevel.CONFIRMED;
    const filters: SubscriberFilters = {
      accounts: new Map(), slots: new Map(), transactions: new Map(),
      transactionsStatus: new Map(), blocks: new Map(), blocksMeta: new Map(), entry: new Map(),
    };
    let timeout: NodeJS.Timeout | null = null;

    const rt = () => {
      if (timeout) clearTimeout(timeout);
      timeout = setTimeout(() => {
        getLogger().warn({ clientId }, 'Ping timeout');
        try { stream.destroy(); } catch { /* */ }
      }, this.config.pingTimeoutMs);
    };
    rt();

    stream.on('data', (req: any) => {
      rt();
      if (req.ping) {
        try { stream.write({ pong: { id: req.ping.id }, filters: [] }); } catch { /* */ }
        return;
      }
      if (req.commitment != null) committed = commitmentFromOptional(req.commitment);

      if (req.slots) {
        filters.slots.clear();
        for (const k of Object.keys(req.slots)) {
          const f = req.slots[k];
          filters.slots.set(k, {
            filterByCommitment: f.filterByCommitment ?? false,
            interslotUpdates: f.interslotUpdates ?? false,
          });
        }
      }

      if (req.accounts) {
        filters.accounts.clear();
        for (const k of Object.keys(req.accounts)) {
          const f = req.accounts[k];
          filters.accounts.set(k, {
            accounts: f.account || undefined,
            owners: f.owner || undefined,
            memcmp: (f.filters || []).filter((fl: any) => fl.memcmp).map((fl: any) => ({
              offset: Number(fl.memcmp.offset),
              bytes: fl.memcmp.bytes ? Buffer.from(fl.memcmp.bytes)
                : fl.memcmp.base58 ? Buffer.from(bs58.decode(fl.memcmp.base58))
                : fl.memcmp.base64 ? Buffer.from(fl.memcmp.base64, 'base64') : Buffer.alloc(0),
            })),
            datasize: (f.filters || []).find((fl: any) => fl.datasize != null)?.datasize,
            lamports: (f.filters || []).find((fl: any) => fl.lamports)?.lamports,
            nonemptyTxnSignature: f.nonemptyTxnSignature ?? undefined,
          });
        }
      }

      if (req.transactions) {
        filters.transactions.clear();
        for (const k of Object.keys(req.transactions)) {
          const f = req.transactions[k];
          filters.transactions.set(k, {
            vote: f.vote ?? undefined, failed: f.failed ?? undefined,
            signature: f.signature ?? undefined,
            accountInclude: f.account_include || undefined,
            accountExclude: f.account_exclude || undefined,
            accountRequired: f.account_required || undefined,
          });
        }
      }

      if (req.transactions_status) {
        filters.transactionsStatus.clear();
        for (const k of Object.keys(req.transactions_status)) {
          const f = req.transactions_status[k];
          filters.transactionsStatus.set(k, {
            vote: f.vote ?? undefined, failed: f.failed ?? undefined,
            signature: f.signature ?? undefined,
            accountInclude: f.account_include || undefined,
            accountExclude: f.account_exclude || undefined,
            accountRequired: f.account_required || undefined,
          });
        }
      }

      if (req.blocks) {
        filters.blocks.clear();
        for (const k of Object.keys(req.blocks)) {
          const f = req.blocks[k];
          filters.blocks.set(k, {
            accountInclude: f.account_include || undefined,
            includeTransactions: f.include_transactions ?? false,
            includeAccounts: f.include_accounts ?? false,
            includeEntries: f.include_entries ?? false,
          });
        }
      }

      if (req.blocks_meta) {
        filters.blocksMeta.clear();
        for (const k of Object.keys(req.blocks_meta)) filters.blocksMeta.set(k, {});
      }
      if (req.entry) {
        filters.entry.clear();
        for (const k of Object.keys(req.entry)) filters.entry.set(k, {});
      }

      const sid = `${clientId}_sub`;
      this.subManager.unregister(sid);
      this.subManager.register(sid, {
        id: sid,
        filters: {
          accounts: new Map(filters.accounts), slots: new Map(filters.slots),
          transactions: new Map(filters.transactions), transactionsStatus: new Map(filters.transactionsStatus),
          blocks: new Map(filters.blocks), blocksMeta: new Map(filters.blocksMeta), entry: new Map(filters.entry),
        },
        commitment: committed,
        fromSlot: req.from_slot ?? undefined,
      });
      this.streams.set(sid, stream);
    });

    stream.on('close', () => {
      this.subManager.unregister(`${clientId}_sub`);
      this.streams.delete(`${clientId}_sub`);
      if (timeout) clearTimeout(timeout);
    });
    stream.on('error', () => {
      this.subManager.unregister(`${clientId}_sub`);
      this.streams.delete(`${clientId}_sub`);
      if (timeout) clearTimeout(timeout);
    });

    const timer = setInterval(() => {
      try { stream.write({ ping: {}, filters: [] }); } catch { clearInterval(timer); }
    }, this.config.pingIntervalMs);
    this.pingTimers.set(clientId, timer);
    stream.on('close', () => { clearInterval(timer); this.pingTimers.delete(clientId); });
  }

  private doWithConn(fn: (conn: Connection) => Promise<void>): void {
    const entry = this.pool.acquire();
    fn(entry.connection).catch((err: Error) => {
      getLogger().error({ err: err.message }, 'RPC call failed');
      this.pool.markUnhealthy(entry.id);
    }).finally(() => this.pool.release(entry.id));
  }

  get subscriberCount(): number { return this.subManager.totalSubscribers; }
}
