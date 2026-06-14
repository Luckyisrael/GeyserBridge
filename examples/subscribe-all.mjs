/**
 * GeyserBridge demo — comprehensive demo with slots, accounts, transactions, blocks.
 *
 * Usage: node examples/subscribe-all.mjs
 * Requires: ADMIN_KEY env var (set to match the server's key)
 */
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.resolve(__dirname, '../proto/geyser.proto');
const HOST = process.env.HOST || 'localhost';
const PORT = process.env.PORT || '10000';
const TOKEN = process.env.ADMIN_KEY || 'my-secret';

const packageDef = protoLoader.loadSync(PROTO_PATH, {
  keepCase: false, longs: Number, enums: Number, defaults: false, oneofs: true,
  includeDirs: [path.resolve(__dirname, '../proto')],
});
const proto = grpc.loadPackageDefinition(packageDef);

const md = new grpc.Metadata();
md.add('x-token', TOKEN);

const client = new proto.geyser.Geyser(`${HOST}:${PORT}`, grpc.credentials.createInsecure());
const stream = client.Subscribe(md);

let slotCount = 0;
let txCount = 0;
let accountCount = 0;
let blockCount = 0;

stream.on('data', (data) => {
  if (data.slot) {
    slotCount++;
    console.log(`📡 Slot ${String(data.slot.slot).padEnd(10)}  parent=${data.slot.parent}  status=${data.slot.status}`);
  }
  if (data.transaction) {
    txCount++;
    const sig = Buffer.isBuffer(data.transaction.signature)
      ? data.transaction.signature.toString('base64').slice(0, 16)
      : String(data.transaction.signature).slice(0, 16);
    console.log(`📝 Tx   ${sig}...  slot=${data.transaction.slot}  vote=${data.transaction.isVote}`);
  }
  if (data.account) {
    accountCount++;
    const pubkey = Buffer.isBuffer(data.account.account.pubkey)
      ? data.account.account.pubkey.toString('base64').slice(0, 16)
      : '?';
    console.log(`👤 Acct ${pubkey}...  slot=${data.account.slot}  lamports=${data.account.account.lamports}`);
  }
  if (data.blockMeta) {
    blockCount++;
    const time = data.blockMeta.blockTime
      ? new Date(Number(data.blockMeta.blockTime) * 1000).toISOString()
      : '?';
    console.log(`🧱 Block ${String(data.blockMeta.slot).padEnd(10)}  txs=${data.blockMeta.executedTransactionCount}  time=${time}`);
  }
  if (data.block) {
    console.log(`🧱 Full  slot=${data.block.slot}  txs=${data.block.executedTransactionCount}  hash=${data.block.blockhash?.slice(0, 16)}`);
  }
  if (data.ping) {
    stream.write({ ping: { id: data.ping.id } });
  }
  if (data.pong) {
    // ignore pong responses
  }
});

stream.on('error', (e) => console.error('stream error:', e.message));
stream.on('close', () => {
  console.log(`\nSummary: ${slotCount} slots, ${txCount} txs, ${accountCount} accounts, ${blockCount} blocks`);
  console.log('stream closed');
});

// Subscribe to everything
stream.write({
  slots: { all: {} },
  transactions: { all: { vote: false, failed: false } },
  blocks_meta: { summary: {} },
  commitment: 1,
});

console.log(`\nListening for everything from ${HOST}:${PORT}...`);
console.log('Showing slots, transactions, blocks_meta, and accounts');
console.log('(Add a program account filter via accounts to see account updates)');
console.log('Ctrl+C to stop\n');
