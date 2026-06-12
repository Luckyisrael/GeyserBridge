export interface AccountUpdate {
  pubkey: Buffer;
  lamports: number;
  owner: Buffer;
  executable: boolean;
  rentEpoch: number;
  data: Buffer;
  writeVersion: number;
  txnSignature?: Buffer;
  slot: number;
}

export function makeAccountUpdate(
  pubkey: any,
  info: any,
  contextSlot: number,
  writeVersion?: number,
): AccountUpdate {
  return {
    pubkey: Buffer.from(pubkey.toBytes()),
    lamports: info.lamports,
    owner: Buffer.from(info.owner.toBytes()),
    executable: info.executable,
    rentEpoch: info.rentEpoch,
    data: info.data,
    writeVersion: writeVersion ?? 0,
    slot: contextSlot,
  };
}
