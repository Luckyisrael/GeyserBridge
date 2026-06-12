import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { makeTransactionUpdate } from '../../src/translate/transaction';

describe('transaction translation', () => {
  const sig = '5KtPn3G8b6k7y7A6i1KQKJKx7TnvzCJMY1oPxqo1K9QpGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGqGq';

  const makeMockTx = (overrides: any = {}) => ({
    transaction: {
      signatures: [sig],
      message: {
        accountKeys: [
          { pubkey: new PublicKey('11111111111111111111111111111111'), signer: true, writable: true },
          { pubkey: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), signer: false, writable: false },
        ],
        instructions: [
          { programId: new PublicKey('11111111111111111111111111111111'), accounts: [], data: '' },
        ],
        recentBlockhash: '11111111111111111111111111111111',
        header: {
          numRequiredSignatures: 1,
          numReadonlySignedAccounts: 0,
          numReadonlyUnsignedAccounts: 1,
        },
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1000000, 2000000],
      postBalances: [995000, 2000000],
      innerInstructions: [],
      logMessages: ['Program log: test'],
      preTokenBalances: [],
      postTokenBalances: [],
      loadedWritableAddresses: [],
      loadedReadonlyAddresses: [],
      computeUnitsConsumed: 150,
    },
    slot: 12345,
    ...overrides,
  });

  it('creates transaction update from valid data', () => {
    const tx = makeMockTx();
    const update = makeTransactionUpdate(sig, tx);
    expect(update).not.toBeNull();
    expect(update!.signature).toEqual(Buffer.from(bs58.decode(sig)));
    expect(update!.slot).toBe(12345);
    expect(update!.meta.fee).toBe(5000);
    expect(update!.meta.logMessages[0]).toBe('Program log: test');
  });

  it('returns null when meta is null', () => {
    const tx = makeMockTx({ meta: null });
    const update = makeTransactionUpdate(sig, tx);
    expect(update).toBeNull();
  });

  it('detects vote transactions', () => {
    const tx = makeMockTx({
      transaction: {
        message: {
          accountKeys: [
            { pubkey: new PublicKey('Vote111111111111111111111111111111111111111'), signer: true, writable: true },
          ],
          instructions: [
            { programId: new PublicKey('Vote111111111111111111111111111111111111111'), accounts: [], data: '' },
          ],
          recentBlockhash: '11111111111111111111111111111111',
        },
      },
    });
    const update = makeTransactionUpdate(sig, tx);
    expect(update).not.toBeNull();
    expect(update!.isVote).toBe(true);
  });
});
