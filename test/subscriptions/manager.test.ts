import { describe, it, expect, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { SubscriptionManager, AccountFilter, TxFilter } from '../../src/subscriptions/manager';

describe('SubscriptionManager', () => {
  let mgr: SubscriptionManager;

  beforeEach(() => {
    mgr = new SubscriptionManager();
  });

  describe('register / unregister', () => {
    it('registers a slot subscriber', () => {
      mgr.register('s1', {
        id: 's1',
        filters: { accounts: new Map(), slots: new Map([['all', {}]]), transactions: new Map(), transactionsStatus: new Map(), blocks: new Map(), blocksMeta: new Map(), entry: new Map() },
        commitment: 1,
      });
      expect(mgr.totalSubscribers).toBe(1);
      expect(mgr.getSlotSubscribers()).toEqual(['s1']);
    });

    it('registers an account subscriber', () => {
      const filters = new Map<string, AccountFilter>();
      filters.set('a1', { accounts: ['11111111111111111111111111111111'] });
      mgr.register('s1', {
        id: 's1',
        filters: { accounts: filters, slots: new Map(), transactions: new Map(), transactionsStatus: new Map(), blocks: new Map(), blocksMeta: new Map(), entry: new Map() },
        commitment: 1,
      });
      expect(mgr.getAccountSubscribers('11111111111111111111111111111111')).toEqual(['s1']);
    });

    it('registers a program subscriber', () => {
      const filters = new Map<string, AccountFilter>();
      filters.set('a1', { owners: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] });
      mgr.register('s1', {
        id: 's1',
        filters: { accounts: filters, slots: new Map(), transactions: new Map(), transactionsStatus: new Map(), blocks: new Map(), blocksMeta: new Map(), entry: new Map() },
        commitment: 1,
      });
      expect(mgr.getProgramSubscribers('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toEqual(['s1']);
    });

    it('unregisters a subscriber', () => {
      mgr.register('s1', {
        id: 's1',
        filters: { accounts: new Map(), slots: new Map([['all', {}]]), transactions: new Map(), transactionsStatus: new Map(), blocks: new Map(), blocksMeta: new Map(), entry: new Map() },
        commitment: 1,
      });
      mgr.unregister('s1');
      expect(mgr.totalSubscribers).toBe(0);
      expect(mgr.hasSlotSubscribers()).toBe(false);
    });
  });

  describe('shouldSendAccount', () => {
    const mkAcct = (overrides: any = {}) => ({
      pubkey: Buffer.from(new PublicKey('11111111111111111111111111111111').toBytes()),
      lamports: 1000,
      owner: Buffer.from(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes()),
      executable: false,
      rentEpoch: 0,
      data: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]),
      writeVersion: 1,
      slot: 100,
      ...overrides,
    });

    it('passes with empty filter', () => {
      expect(mgr.shouldSendAccount(mkAcct(), {})).toBe(true);
    });

    it('filters by account pubkey', () => {
      const filter: AccountFilter = { accounts: ['11111111111111111111111111111111'] };
      expect(mgr.shouldSendAccount(mkAcct(), filter)).toBe(true);

      const wrong: AccountFilter = { accounts: ['22222222222222222222222222222222'] };
      expect(mgr.shouldSendAccount(mkAcct(), wrong)).toBe(false);
    });

    it('filters by owner', () => {
      const filter: AccountFilter = { owners: ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] };
      expect(mgr.shouldSendAccount(mkAcct(), filter)).toBe(true);

      const wrong: AccountFilter = { owners: ['11111111111111111111111111111111'] };
      expect(mgr.shouldSendAccount(mkAcct(), wrong)).toBe(false);
    });

    it('filters by datasize', () => {
      const filter: AccountFilter = { datasize: 8 };
      expect(mgr.shouldSendAccount(mkAcct(), filter)).toBe(true);

      const wrong: AccountFilter = { datasize: 99 };
      expect(mgr.shouldSendAccount(mkAcct(), wrong)).toBe(false);
    });

    it('filters by memcmp', () => {
      const filter: AccountFilter = { memcmp: [{ offset: 0, bytes: Buffer.from([0, 1, 2]) }] };
      expect(mgr.shouldSendAccount(mkAcct(), filter)).toBe(true);

      const wrong: AccountFilter = { memcmp: [{ offset: 0, bytes: Buffer.from([9, 9]) }] };
      expect(mgr.shouldSendAccount(mkAcct(), wrong)).toBe(false);
    });

    it('filters by lamports eq', () => {
      const filter: AccountFilter = { lamports: { eq: 1000 } };
      expect(mgr.shouldSendAccount(mkAcct(), filter)).toBe(true);

      const wrong: AccountFilter = { lamports: { eq: 999 } };
      expect(mgr.shouldSendAccount(mkAcct(), wrong)).toBe(false);
    });

    it('filters by lamports ne', () => {
      const filter: AccountFilter = { lamports: { ne: 999 } };
      expect(mgr.shouldSendAccount(mkAcct(), filter)).toBe(true);

      const wrong: AccountFilter = { lamports: { ne: 1000 } };
      expect(mgr.shouldSendAccount(mkAcct(), wrong)).toBe(false);
    });

    it('filters by lamports lt/gt', () => {
      expect(mgr.shouldSendAccount(mkAcct(), { lamports: { lt: 2000 } })).toBe(true);
      expect(mgr.shouldSendAccount(mkAcct(), { lamports: { lt: 1000 } })).toBe(false);
      expect(mgr.shouldSendAccount(mkAcct(), { lamports: { gt: 500 } })).toBe(true);
      expect(mgr.shouldSendAccount(mkAcct(), { lamports: { gt: 1000 } })).toBe(false);
    });

    it('filters by nonemptyTxnSignature', () => {
      expect(mgr.shouldSendAccount(mkAcct(), { nonemptyTxnSignature: false })).toBe(true);
      expect(mgr.shouldSendAccount(mkAcct(), { nonemptyTxnSignature: true })).toBe(false);
      expect(mgr.shouldSendAccount(mkAcct({ txnSignature: Buffer.from([1]) }), { nonemptyTxnSignature: true })).toBe(true);
    });
  });

  describe('shouldSendTransaction', () => {
    const mkTx = (overrides: any = {}) => ({
      signature: Buffer.from([1, 2, 3]),
      isVote: false,
      slot: 100,
      index: 0,
      transaction: {
        signatures: [Buffer.from([1, 2, 3])],
        message: {
          header: { numRequiredSignatures: 1, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 1 },
          accountKeys: [
            Buffer.from(new PublicKey('11111111111111111111111111111111').toBytes()),
            Buffer.from(new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA').toBytes()),
          ],
          recentBlockhash: Buffer.alloc(32),
          instructions: [{ programIdIndex: 0, accounts: Buffer.alloc(0), data: Buffer.alloc(0) }],
          versioned: false,
          addressTableLookups: [],
        },
      },
      meta: {
        err: null,
        fee: 5000,
        preBalances: [],
        postBalances: [],
        innerInstructions: [],
        logMessages: [],
        preTokenBalances: [],
        postTokenBalances: [],
        loadedWritableAddresses: [],
        loadedReadonlyAddresses: [],
      },
      ...overrides,
    });

    it('passes with empty filter', () => {
      expect(mgr.shouldSendTransaction(mkTx(), {} as TxFilter)).toBe(true);
    });

    it('filters by vote', () => {
      const voteTx = mkTx({ isVote: true });
      expect(mgr.shouldSendTransaction(voteTx, { vote: false } as TxFilter)).toBe(false);
      expect(mgr.shouldSendTransaction(voteTx, { vote: true } as TxFilter)).toBe(true);
      expect(mgr.shouldSendTransaction(mkTx(), { vote: false } as TxFilter)).toBe(true);
    });

    it('filters by failed', () => {
      const failedTx = mkTx({ meta: { err: Buffer.from([1]), fee: 0, preBalances: [], postBalances: [], innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [], loadedWritableAddresses: [], loadedReadonlyAddresses: [] } });
      expect(mgr.shouldSendTransaction(failedTx, { failed: false } as TxFilter)).toBe(false);
      expect(mgr.shouldSendTransaction(failedTx, { failed: true } as TxFilter)).toBe(true);
      expect(mgr.shouldSendTransaction(mkTx(), { failed: false } as TxFilter)).toBe(true);
    });

    it('filters by signature', () => {
      const sig = bs58.encode(Buffer.from([1, 2, 3]));
      expect(mgr.shouldSendTransaction(mkTx(), { signature: sig } as TxFilter)).toBe(true);
      expect(mgr.shouldSendTransaction(mkTx(), { signature: 'wrong' } as TxFilter)).toBe(false);
    });

    it('filters by accountInclude', () => {
      const filter: TxFilter = { accountInclude: ['11111111111111111111111111111111'] };
      expect(mgr.shouldSendTransaction(mkTx(), filter)).toBe(true);

      const wrong: TxFilter = { accountInclude: ['22222222222222222222222222222222'] };
      expect(mgr.shouldSendTransaction(mkTx(), wrong)).toBe(false);
    });

    it('filters by accountExclude', () => {
      const filter: TxFilter = { accountExclude: ['22222222222222222222222222222222'] };
      expect(mgr.shouldSendTransaction(mkTx(), filter)).toBe(true);

      const match: TxFilter = { accountExclude: ['11111111111111111111111111111111'] };
      expect(mgr.shouldSendTransaction(mkTx(), match)).toBe(false);
    });

    it('filters by accountRequired', () => {
      const filter: TxFilter = { accountRequired: ['11111111111111111111111111111111', 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'] };
      expect(mgr.shouldSendTransaction(mkTx(), filter)).toBe(true);

      const wrong: TxFilter = { accountRequired: ['11111111111111111111111111111111', '22222222222222222222222222222222'] };
      expect(mgr.shouldSendTransaction(mkTx(), wrong)).toBe(false);
    });
  });
});
