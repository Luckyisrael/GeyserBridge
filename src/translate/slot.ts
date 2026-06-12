export enum SlotStatus {
  SLOT_PROCESSED = 0,
  SLOT_CONFIRMED = 1,
  SLOT_FINALIZED = 2,
  SLOT_FIRST_SHRED_RECEIVED = 3,
  SLOT_COMPLETED = 4,
  SLOT_CREATED_BANK = 5,
  SLOT_DEAD = 6,
}

export function statusFromCommitment(commitment: number): SlotStatus {
  switch (commitment) {
    case 0: return SlotStatus.SLOT_PROCESSED;
    case 1: return SlotStatus.SLOT_CONFIRMED;
    case 2: return SlotStatus.SLOT_FINALIZED;
    default: return SlotStatus.SLOT_PROCESSED;
  }
}
