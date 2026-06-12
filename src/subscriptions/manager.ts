import { EventEmitter } from 'events';
import bs58 from 'bs58';
import { PublicKey } from '@solana/web3.js';
import { CommitmentLevel } from '../translate/commitment';
import { getLogger } from '../utils/logger';
import { AccountUpdate } from '../translate/account';
import { TransactionUpdate } from '../translate/transaction';

export interface AccountFilter {
  accounts?: string[];
  owners?: string[];
  memcmp?: { offset: number; bytes: Buffer }[];
  datasize?: number;
  lamports?: { eq?: number; ne?: number; lt?: number; gt?: number };
  nonemptyTxnSignature?: boolean;
}

export interface SlotFilter {
  filterByCommitment?: boolean;
  interslotUpdates?: boolean;
}

export interface TxFilter {
  vote?: boolean;
  failed?: boolean;
  signature?: string;
  accountInclude?: string[];
  accountExclude?: string[];
  accountRequired?: string[];
}

export interface BlockFilter {
  accountInclude?: string[];
  includeTransactions?: boolean;
  includeAccounts?: boolean;
  includeEntries?: boolean;
}

export interface SubscriberFilters {
  accounts: Map<string, AccountFilter>;
  slots: Map<string, SlotFilter>;
  transactions: Map<string, TxFilter>;
  transactionsStatus: Map<string, TxFilter>;
  blocks: Map<string, BlockFilter>;
  blocksMeta: Map<string, {}>;
  entry: Map<string, {}>;
}

export interface SubscriberState {
  id: string;
  filters: SubscriberFilters;
  commitment: CommitmentLevel;
  fromSlot?: number;
}

export class SubscriptionManager extends EventEmitter {
  private subscribers: Map<string, SubscriberState> = new Map();
  private slotSubscriptions: Set<string> = new Set();
  private accountSubscriptions: Map<string, Set<string>> = new Map();
  private programSubscriptions: Map<string, Set<string>> = new Map();

  register(id: string, state: SubscriberState): void {
    this.subscribers.set(id, state);
    if (state.filters.slots.size > 0) {
      this.slotSubscriptions.add(id);
    }
    for (const [key, filter] of state.filters.accounts) {
      if (filter.accounts) {
        for (const acct of filter.accounts) {
          const set = this.accountSubscriptions.get(acct) ?? new Set();
          set.add(id);
          this.accountSubscriptions.set(acct, set);
        }
      }
      if (filter.owners) {
        for (const owner of filter.owners) {
          const set = this.programSubscriptions.get(owner) ?? new Set();
          set.add(id);
          this.programSubscriptions.set(owner, set);
        }
      }
    }
  }

  unregister(id: string): void {
    this.subscribers.delete(id);
    this.slotSubscriptions.delete(id);
    for (const [acct, set] of this.accountSubscriptions) {
      set.delete(id);
      if (set.size === 0) this.accountSubscriptions.delete(acct);
    }
    for (const [prog, set] of this.programSubscriptions) {
      set.delete(id);
      if (set.size === 0) this.programSubscriptions.delete(prog);
    }
  }

  /** Atomically replace a subscriber's state without a remove-then-add window */
  updateSubscriber(id: string, state: SubscriberState): void {
    if (!this.subscribers.has(id)) {
      this.register(id, state);
      return;
    }
    this.slotSubscriptions.delete(id);
    for (const [, set] of this.accountSubscriptions) {
      set.delete(id);
    }
    for (const [, set] of this.programSubscriptions) {
      set.delete(id);
    }
    // (empty sets accumulate until unregister cleans them; acceptable)

    this.subscribers.set(id, state);

    if (state.filters.slots.size > 0) {
      this.slotSubscriptions.add(id);
    }
    for (const [, filter] of state.filters.accounts) {
      if (filter.accounts) {
        for (const acct of filter.accounts) {
          const set = this.accountSubscriptions.get(acct) ?? new Set();
          set.add(id);
          this.accountSubscriptions.set(acct, set);
        }
      }
      if (filter.owners) {
        for (const owner of filter.owners) {
          const set = this.programSubscriptions.get(owner) ?? new Set();
          set.add(id);
          this.programSubscriptions.set(owner, set);
        }
      }
    }
  }

  hasSlotSubscribers(): boolean {
    return this.slotSubscriptions.size > 0;
  }

  getSlotSubscribers(): string[] {
    return Array.from(this.slotSubscriptions);
  }

  getAccountSubscribers(pubkey: string): string[] {
    return Array.from(this.accountSubscriptions.get(pubkey) ?? []);
  }

  getProgramSubscribers(owner: string): string[] {
    return Array.from(this.programSubscriptions.get(owner) ?? []);
  }

  shouldSendAccount(
    update: AccountUpdate,
    filter: AccountFilter,
  ): boolean {
    const pubkeyBs58 = new PublicKey(update.pubkey).toBase58();
    const ownerBs58 = new PublicKey(update.owner).toBase58();

    if (filter.accounts && filter.accounts.length > 0) {
      if (!filter.accounts.includes(pubkeyBs58)) return false;
    }
    if (filter.owners && filter.owners.length > 0) {
      if (!filter.owners.includes(ownerBs58)) return false;
    }
    if (filter.datasize !== undefined && update.data.length !== filter.datasize) {
      return false;
    }
    if (filter.memcmp) {
      for (const m of filter.memcmp) {
        const slice = update.data.subarray(
          m.offset,
          m.offset + m.bytes.length,
        );
        if (!slice.equals(m.bytes)) return false;
      }
    }
    if (filter.lamports) {
      const l = update.lamports;
      if (filter.lamports.eq !== undefined && l !== filter.lamports.eq)
        return false;
      if (filter.lamports.ne !== undefined && l === filter.lamports.ne)
        return false;
      if (filter.lamports.lt !== undefined && l >= filter.lamports.lt)
        return false;
      if (filter.lamports.gt !== undefined && l <= filter.lamports.gt)
        return false;
    }
    if (filter.nonemptyTxnSignature && !update.txnSignature) return false;
    return true;
  }

  shouldSendTransaction(
    update: TransactionUpdate,
    filter: TxFilter,
  ): boolean {
    if (filter.vote === false && update.isVote) return false;
    if (filter.vote === true && !update.isVote) return false;
    if (filter.failed === false && update.meta.err && update.meta.err.length > 0)
      return false;
    if (filter.failed === true && (!update.meta.err || update.meta.err.length === 0))
      return false;
    if (filter.signature) {
      const sigBs58 = bs58.encode(update.signature);
      if (sigBs58 !== filter.signature) return false;
    }
    if (
      filter.accountInclude &&
      filter.accountInclude.length > 0
    ) {
      const txKeys = update.transaction.message.accountKeys.map((k) =>
        new PublicKey(k).toBase58(),
      );
      const hasInclude = filter.accountInclude.some((inc) =>
        txKeys.includes(inc),
      );
      if (!hasInclude) return false;
    }
    if (
      filter.accountExclude &&
      filter.accountExclude.length > 0
    ) {
      const txKeys = update.transaction.message.accountKeys.map((k) =>
        new PublicKey(k).toBase58(),
      );
      const hasExclude = filter.accountExclude.some((exc) =>
        txKeys.includes(exc),
      );
      if (hasExclude) return false;
    }
    if (
      filter.accountRequired &&
      filter.accountRequired.length > 0
    ) {
      const txKeys = update.transaction.message.accountKeys.map((k) =>
        new PublicKey(k).toBase58(),
      );
      const hasAll = filter.accountRequired.every((req) =>
        txKeys.includes(req),
      );
      if (!hasAll) return false;
    }
    return true;
  }

  getAllSubscribers(): Map<string, SubscriberState> {
    return this.subscribers;
  }

  get totalSubscribers(): number {
    return this.subscribers.size;
  }
}
