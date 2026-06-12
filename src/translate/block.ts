export interface BlockUpdate {
  slot: number;
  blockhash: string;
  parentSlot: number;
  parentBlockhash: string;
  blockTime?: number;
  blockHeight?: number;
  executedTransactionCount: number;
  entryCount: number;
}

export function makeBlockMeta(block: any, slot: number): BlockUpdate {
  return {
    slot,
    blockhash: block.blockhash,
    parentSlot: block.parentSlot,
    parentBlockhash: block.previousBlockhash,
    blockTime: block.blockTime ?? undefined,
    blockHeight: block.blockHeight ?? undefined,
    executedTransactionCount: block.transactions?.length ?? 0,
    entryCount: 0,
  };
}
