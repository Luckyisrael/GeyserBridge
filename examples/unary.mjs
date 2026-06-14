/**
 * GeyserBridge demo — exercises all unary RPCs against a running server.
 *
 * Usage: node examples/unary.mjs
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

function call(name, req, meta) {
  return new Promise((resolve, reject) => {
    client[name](req, meta, (err, r) => (err ? reject(err) : resolve(r)));
  });
}

async function main() {
  console.log(`\nGeyserBridge unary RPCs — ${HOST}:${PORT}\n`);

  // 1. Ping (no auth needed)
  const ping = await new Promise((resolve, reject) => {
    client.Ping({ count: 42 }, (err, r) => (err ? reject(err) : resolve(r)));
  });
  console.log(`✓ Ping                    count=${ping.count}`);

  // 2. GetVersion
  const ver = await call('GetVersion', {}, md);
  console.log(`✓ GetVersion              version=${ver.version}`);

  // 3. GetSlot
  const slot = await call('GetSlot', { commitment: 1 }, md);
  console.log(`✓ GetSlot                 slot=${slot.slot}`);

  // 4. GetBlockHeight
  const bh = await call('GetBlockHeight', { commitment: 1 }, md);
  console.log(`✓ GetBlockHeight          height=${bh.blockHeight}`);

  // 5. GetLatestBlockhash
  const lbh = await call('GetLatestBlockhash', { commitment: 1 }, md);
  console.log(`✓ GetLatestBlockhash      hash=${lbh.blockhash}`);
  console.log(`                           lastValid=${lbh.lastValidBlockHeight}  slot=${lbh.slot}`);

  // 6. IsBlockhashValid
  const valid = await call('IsBlockhashValid', { blockhash: lbh.blockhash, commitment: 1 }, md);
  console.log(`✓ IsBlockhashValid        valid=${valid.valid}`);

  // 7. Test auth rejection
  const noAuthMd = new grpc.Metadata();
  const authErr = await new Promise((resolve) => {
    client.GetVersion({}, noAuthMd, (err) => resolve(err));
  });
  console.log(`✓ Auth rejection          code=${authErr.code} (expected UNAUTHENTICATED)`);

  client.close();
  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
