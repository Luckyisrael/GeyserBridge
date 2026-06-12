import { Commitment } from '@solana/web3.js';

export enum CommitmentLevel {
  PROCESSED = 0,
  CONFIRMED = 1,
  FINALIZED = 2,
}

export function commitmentToSolana(level: CommitmentLevel): Commitment {
  switch (level) {
    case CommitmentLevel.PROCESSED:
      return 'processed';
    case CommitmentLevel.CONFIRMED:
      return 'confirmed';
    case CommitmentLevel.FINALIZED:
      return 'finalized';
  }
}

export function commitmentFromOptional(
  value: number | null | undefined,
): CommitmentLevel {
  if (value === 0) return CommitmentLevel.PROCESSED;
  if (value === 2) return CommitmentLevel.FINALIZED;
  return CommitmentLevel.CONFIRMED;
}
