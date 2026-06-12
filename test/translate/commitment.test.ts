import { describe, it, expect } from 'vitest';
import {
  CommitmentLevel,
  commitmentToSolana,
  commitmentFromOptional,
} from '../../src/translate/commitment';

describe('commitment', () => {
  it('maps CommitmentLevel to Solana Commitment', () => {
    expect(commitmentToSolana(CommitmentLevel.PROCESSED)).toBe('processed');
    expect(commitmentToSolana(CommitmentLevel.CONFIRMED)).toBe('confirmed');
    expect(commitmentToSolana(CommitmentLevel.FINALIZED)).toBe('finalized');
  });

  it('maps optional number to CommitmentLevel', () => {
    expect(commitmentFromOptional(0)).toBe(CommitmentLevel.PROCESSED);
    expect(commitmentFromOptional(1)).toBe(CommitmentLevel.CONFIRMED);
    expect(commitmentFromOptional(2)).toBe(CommitmentLevel.FINALIZED);
    expect(commitmentFromOptional(null)).toBe(CommitmentLevel.CONFIRMED);
    expect(commitmentFromOptional(undefined)).toBe(CommitmentLevel.CONFIRMED);
    expect(commitmentFromOptional(99)).toBe(CommitmentLevel.CONFIRMED);
  });
});
