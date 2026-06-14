/**
 * GeyserBridge demo — streams live slot updates to the console.
 *
 * Usage: node examples/stream-slots.mjs
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

// --- Subscribe to slots ---
const stream = client.Subscribe(md);
stream.on('data', (data) => {
  if (data.slot) {
    console.log(`📡 slot=${data.slot.slot}  parent=${data.slot.parent}  status=${data.slot.status}`);
  }
  if (data.ping) {
    stream.write({ ping: { id: data.ping.id } }); // respond to server pings
  }
  if (data.pong) {
    console.log(`🏓 pong id=${data.pong.id}`);
  }
});
stream.on('error', (e) => console.error('stream error:', e.message));
stream.on('close', () => console.log('stream closed'));

stream.write({
  slots: { all: {} },
  commitment: 1, // CONFIRMED
});

console.log(`\nListening for slot updates from ${HOST}:${PORT}... (Ctrl+C to stop)\n`);
