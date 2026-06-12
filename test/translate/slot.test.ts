import { describe, it, expect } from 'vitest';
import { SlotStatus, statusFromCommitment } from '../../src/translate/slot';

describe('slot', () => {
  it('maps commitment number to SlotStatus', () => {
    expect(statusFromCommitment(0)).toBe(SlotStatus.SLOT_PROCESSED);
    expect(statusFromCommitment(1)).toBe(SlotStatus.SLOT_CONFIRMED);
    expect(statusFromCommitment(2)).toBe(SlotStatus.SLOT_FINALIZED);
    expect(statusFromCommitment(99)).toBe(SlotStatus.SLOT_PROCESSED);
  });
});
