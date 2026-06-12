import { describe, it, expect } from 'vitest';
import { makeBlockMeta } from '../../src/translate/block';

describe('block translation', () => {
  it('creates block meta from valid block data', () => {
    const block = {
      blockhash: '11111111111111111111111111111111',
      parentSlot: 100,
      previousBlockhash: '22222222222222222222222222222222',
      blockTime: 1700000000,
      blockHeight: 300000000,
      transactions: [{}, {}],
    };
    const meta = makeBlockMeta(block, 101);
    expect(meta.slot).toBe(101);
    expect(meta.blockhash).toBe('11111111111111111111111111111111');
    expect(meta.parentSlot).toBe(100);
    expect(meta.parentBlockhash).toBe('22222222222222222222222222222222');
    expect(meta.blockTime).toBe(1700000000);
    expect(meta.blockHeight).toBe(300000000);
    expect(meta.executedTransactionCount).toBe(2);
  });

  it('handles missing optional fields', () => {
    const block = {
      blockhash: 'aaa',
      parentSlot: 0,
      previousBlockhash: 'bbb',
    };
    const meta = makeBlockMeta(block, 5);
    expect(meta.blockTime).toBeUndefined();
    expect(meta.blockHeight).toBeUndefined();
    expect(meta.executedTransactionCount).toBe(0);
  });
});
