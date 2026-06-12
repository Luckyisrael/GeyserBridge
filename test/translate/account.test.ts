import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { makeAccountUpdate } from '../../src/translate/account';

describe('account translation', () => {
  const pubkey = new PublicKey('11111111111111111111111111111111');
  const owner = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

  it('creates account update from valid inputs', () => {
    const update = makeAccountUpdate(pubkey, {
      lamports: 1000000,
      owner,
      executable: false,
      rentEpoch: 0,
      data: Buffer.from([1, 2, 3]),
    }, 12345, 1);

    expect(Buffer.isBuffer(update.pubkey)).toBe(true);
    expect(update.lamports).toBe(1000000);
    expect(update.owner).toBeDefined();
    expect(update.executable).toBe(false);
    expect(update.data).toEqual(Buffer.from([1, 2, 3]));
    expect(update.slot).toBe(12345);
    expect(update.writeVersion).toBe(1);
  });

  it('defaults writeVersion to 0', () => {
    const update = makeAccountUpdate(pubkey, {
      lamports: 0,
      owner,
      executable: false,
      rentEpoch: 0,
      data: Buffer.alloc(0),
    }, 0);
    expect(update.writeVersion).toBe(0);
  });
});
