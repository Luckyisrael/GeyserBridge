import path from 'path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import fs from 'fs';
import { loadConfig } from './config';
import { initLogger, getLogger } from './utils/logger';
import { RingBuffer } from './utils/ring-buffer';
import { ConnectionPool } from './solana/pool';
import { SubscriptionManager } from './subscriptions/manager';
import { GeyserService } from './services/geyser';
import { SolanaBridge } from './bridge/solana-bridge';
import { SlotStatus, statusFromCommitment } from './translate/slot';

const PROTO_PATH = path.resolve(__dirname, '..', 'proto', 'geyser.proto');
const PROTO_DIR = path.resolve(__dirname, '..', 'proto');

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  initLogger(config);
  const log = getLogger();

  log.info({ version: config.version, solanaRpc: config.solanaRpcUrl }, 'GeyserBridge starting');

  const pool = new ConnectionPool(
    config.solanaRpcUrl,
    config.solanaRpcWsUrl,
    config.maxStreamsPerConnection,
    config.maxConnections,
  );

  const subManager = new SubscriptionManager();
  const slotBuffer = new RingBuffer<{ slot: number; parent: number | null; status: SlotStatus }>(
    config.slotBufferSize,
    (u) => u.slot,
  );

  const geyserService = new GeyserService(pool, subManager, slotBuffer, config);
  const solanaBridge = new SolanaBridge(pool, subManager, config);

  // Connect bridge events => geyser service fan-out
  geyserService.connectBridge(solanaBridge);

  const packageDef = protoLoader.loadSync(PROTO_PATH, {
    keepCase: false,
    longs: Number,
    enums: Number,
    defaults: false,
    oneofs: true,
    includeDirs: [PROTO_DIR],
  });
  const proto = grpc.loadPackageDefinition(packageDef) as any;

  const server = new grpc.Server({
    'grpc.max_receive_message_length': config.grpcMaxMessageLength,
    'grpc.max_send_message_length': config.grpcMaxMessageLength,
  });

  server.addService(proto.geyser.Geyser.service, {
    Subscribe: geyserService.subscribe.bind(geyserService),
    SubscribeDeshred: (_call: any, callback: any) => {
      callback({ code: grpc.status.UNIMPLEMENTED, message: 'Not implemented' });
    },
    SubscribeReplayInfo: (_call: any, callback: any) => {
      callback(null, { first_available: slotBuffer.oldestKey() ?? null });
    },
    Ping: geyserService.ping.bind(geyserService),
    GetSlot: geyserService.getSlot.bind(geyserService),
    GetBlockHeight: geyserService.getBlockHeight.bind(geyserService),
    GetLatestBlockhash: geyserService.getLatestBlockhash.bind(geyserService),
    IsBlockhashValid: geyserService.isBlockhashValid.bind(geyserService),
    GetVersion: geyserService.getVersion.bind(geyserService),
  });

  const credentials = config.tlsCertPath && config.tlsKeyPath
    ? grpc.ServerCredentials.createSsl(
        null,
        [{ cert_chain: fs.readFileSync(config.tlsCertPath), private_key: fs.readFileSync(config.tlsKeyPath) }],
        false,
      )
    : grpc.ServerCredentials.createInsecure();

  const bindAddr = `${config.host}:${config.port}`;
  await new Promise<void>((resolve, reject) => {
    server.bindAsync(bindAddr, credentials, (err, port) => {
      if (err) { reject(err); return; }
      server.start();
      log.info({ address: bindAddr, port }, 'gRPC server listening');
      resolve();
    });
  });

  geyserService.start();
  solanaBridge.start();

  const primaryConn = pool.acquire();
  const conn = primaryConn.connection;

  conn.onSlotChange((slotInfo: any) => {
    const status = statusFromCommitment(1);
    geyserService.emitSlotUpdate(
      Number(slotInfo.slot),
      slotInfo.parent ? Number(slotInfo.parent) : null,
      status,
    );
  });

  pool.release(primaryConn.id);

  process.on('SIGINT', () => shutdown(server, geyserService, solanaBridge, log));
  process.on('SIGTERM', () => shutdown(server, geyserService, solanaBridge, log));

  log.info('GeyserBridge ready');
}

function shutdown(
  server: grpc.Server,
  geyserService: GeyserService,
  solanaBridge: SolanaBridge,
  log: any,
): void {
  log.info('Shutting down');
  geyserService.stop();
  solanaBridge.stop();
  const timeout = setTimeout(() => process.exit(1), 10000).unref();
  server.tryShutdown(() => {
    clearTimeout(timeout);
    log.info('Shutdown complete');
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error('Startup error:', err);
  process.exit(1);
});
