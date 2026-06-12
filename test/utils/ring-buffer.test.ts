import { describe, it, expect } from 'vitest';
import { RingBuffer } from '../../src/utils/ring-buffer';

describe('RingBuffer', () => {
  it('pushes and retrieves items', () => {
    const buf = new RingBuffer<{ id: number }>(5, (x) => x.id);
    buf.push({ id: 1 });
    buf.push({ id: 2 });
    buf.push({ id: 3 });
    expect(buf.oldestKey()).toBe(1);
  });

  it('returns undefined oldestKey when empty', () => {
    const buf = new RingBuffer<{ id: number }>(5, (x) => x.id);
    expect(buf.oldestKey()).toBeUndefined();
  });

  it('evicts oldest on overflow', () => {
    const buf = new RingBuffer<{ id: number }>(3, (x) => x.id);
    buf.push({ id: 1 });
    buf.push({ id: 2 });
    buf.push({ id: 3 });
    buf.push({ id: 4 });
    expect(buf.oldestKey()).toBe(2);
  });

  it('deduplicates by key', () => {
    const buf = new RingBuffer<{ id: number }>(3, (x) => x.id);
    buf.push({ id: 1 });
    buf.push({ id: 1 });
    expect(buf.oldestKey()).toBe(1);
  });
});
