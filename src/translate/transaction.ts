import bs58 from 'bs58';

export interface TransactionUpdate {
  signature: Buffer;
  isVote: boolean;
  slot: number;
  index: number;
  transaction: {
    signatures: Buffer[];
    message: {
      header: { numRequiredSignatures: number; numReadonlySignedAccounts: number; numReadonlyUnsignedAccounts: number };
      accountKeys: Buffer[];
      recentBlockhash: Buffer;
      instructions: { programIdIndex: number; accounts: Buffer; data: Buffer }[];
      versioned: boolean;
      addressTableLookups: { accountKey: Buffer; writableIndexes: Buffer; readonlyIndexes: Buffer }[];
    };
  };
  meta: {
    err: Buffer | null;
    fee: number;
    preBalances: number[];
    postBalances: number[];
    innerInstructions: { index: number; instructions: { programIdIndex: number; accounts: Buffer; data: Buffer; stackHeight?: number }[] }[];
    logMessages: string[];
    preTokenBalances: any[];
    postTokenBalances: any[];
    loadedWritableAddresses: Buffer[];
    loadedReadonlyAddresses: Buffer[];
    computeUnitsConsumed?: number;
  };
}

function isVote(tx: any): boolean {
  const progId = tx.transaction.message.accountKeys[0]?.pubkey?.toBase58();
  return progId === 'Vote111111111111111111111111111111111111111';
}

export function makeTransactionUpdate(sig: string, tx: any): TransactionUpdate | null {
  if (!tx.meta) return null;
  const msg = tx.transaction.message;
  const versioned = tx.version !== undefined && tx.version !== 'legacy';

  const instructions = (msg.instructions || []).map((ix: any) => {
    const progIdx = msg.accountKeys.findIndex(
      (k: any) => k.pubkey?.toBase58() === ix.programId?.toBase58(),
    );
    return {
      programIdIndex: progIdx >= 0 ? progIdx : 0,
      accounts: ix.accounts
        ? Buffer.concat((ix.accounts as any[]).map((a: any) => Buffer.from(a.toBytes())))
        : Buffer.alloc(0),
      data: ix.data ? Buffer.from(bs58.decode(ix.data)) : Buffer.alloc(0),
    };
  });

  const meta = tx.meta;

  return {
    signature: Buffer.from(bs58.decode(sig)),
    isVote: isVote(tx),
    slot: tx.slot,
    index: instructions.length,
    transaction: {
      signatures: (tx.transaction.signatures || []).map((s: string) => Buffer.from(bs58.decode(s))),
      message: {
        header: {
          numRequiredSignatures: msg.header?.numRequiredSignatures ?? 0,
          numReadonlySignedAccounts: msg.header?.numReadonlySignedAccounts ?? 0,
          numReadonlyUnsignedAccounts: msg.header?.numReadonlyUnsignedAccounts ?? 0,
        },
        accountKeys: msg.accountKeys.map((k: any) => Buffer.from((k.pubkey ?? k).toBytes())),
        recentBlockhash: Buffer.from(bs58.decode(msg.recentBlockhash)),
        instructions,
        versioned,
        addressTableLookups: (msg.addressTableLookups || []).map((l: any) => ({
          accountKey: Buffer.from(l.accountKey.toBytes()),
          writableIndexes: Buffer.from(l.writableIndexes),
          readonlyIndexes: Buffer.from(l.readonlyIndexes),
        })),
      },
    },
    meta: {
      err: meta.err ? Buffer.from(JSON.stringify(meta.err)) : Buffer.alloc(0),
      fee: meta.fee ?? 0,
      preBalances: meta.preBalances ?? [],
      postBalances: meta.postBalances ?? [],
      innerInstructions: (meta.innerInstructions || []).map((ii: any) => ({
        index: ii.index,
        instructions: (ii.instructions || []).map((inst: any) => ({
          programIdIndex:
            msg.accountKeys.findIndex((k: any) => k.pubkey?.toBase58() === inst.programId?.toBase58()) ?? 0,
          accounts: Buffer.concat((inst.accounts || []).map((a: any) => Buffer.from(a.toBytes()))),
          data: Buffer.from(bs58.decode(inst.data || '')),
          stackHeight: inst.stackHeight,
        })),
      })),
      logMessages: meta.logMessages ?? [],
      preTokenBalances: meta.preTokenBalances ?? [],
      postTokenBalances: meta.postTokenBalances ?? [],
      loadedWritableAddresses: (meta.loadedWritableAddresses || []).map((a: any) =>
        Buffer.from((a.toBytes ? a.toBytes() : a)),
      ),
      loadedReadonlyAddresses: (meta.loadedReadonlyAddresses || []).map((a: any) =>
        Buffer.from((a.toBytes ? a.toBytes() : a)),
      ),
      computeUnitsConsumed: meta.computeUnitsConsumed ?? undefined,
    },
  };
}
