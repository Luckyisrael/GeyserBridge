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
import { MetricsServer } from './metrics/server';
import { SlotStatus, statusFromCommitment } from './translate/slot';
import { ApiKeyStore } from './auth/store';
import { requireAuth, requireAuthStream } from './auth/interceptor';

const PROTO_PATH = path.resolve(__dirname, '..', 'proto', 'geyser.proto');
const PROTO_DIR = path.resolve(__dirname, '..', 'proto');

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  initLogger(config);
  const log = getLogger();

  if (!config.adminKey || config.adminKey === 'change-me-to-a-random-secret') {
    log.fatal('ADMIN_KEY must be set to a secure random value');
    process.exit(1);
  }
  log.info({ version: config.version, solanaRpc: config.solanaRpcUrl }, 'GeyserBridge starting');

  const apiKeyStore = new ApiKeyStore(config.adminKey);

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

  const metricsServer = new MetricsServer(config, pool);
  const geyserService = new GeyserService(pool, subManager, slotBuffer, config, metricsServer.reporter);
  metricsServer.setGeyserService(geyserService);
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
    Subscribe: requireAuthStream(apiKeyStore, geyserService.subscribe.bind(geyserService)),
    SubscribeDeshred: requireAuthStream(apiKeyStore, (_call: any) => {
      _call.emit('error', { code: grpc.status.UNIMPLEMENTED, message: 'Not implemented' });
      _call.destroy();
    }),
    SubscribeReplayInfo: requireAuth(apiKeyStore, (_call: any, callback: any) => {
      callback(null, { first_available: slotBuffer.oldestKey() ?? null });
    }),
    Ping: geyserService.ping.bind(geyserService),
    GetSlot: requireAuth(apiKeyStore, geyserService.getSlot.bind(geyserService)),
    GetBlockHeight: requireAuth(apiKeyStore, geyserService.getBlockHeight.bind(geyserService)),
    GetLatestBlockhash: requireAuth(apiKeyStore, geyserService.getLatestBlockhash.bind(geyserService)),
    IsBlockhashValid: requireAuth(apiKeyStore, geyserService.isBlockhashValid.bind(geyserService)),
    GetVersion: requireAuth(apiKeyStore, geyserService.getVersion.bind(geyserService)),
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
  metricsServer.start();

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

  process.on('SIGINT', () => shutdown(server, geyserService, solanaBridge, metricsServer, log));
  process.on('SIGTERM', () => shutdown(server, geyserService, solanaBridge, metricsServer, log));

  log.info('GeyserBridge ready');
}

function shutdown(
  server: grpc.Server,
  geyserService: GeyserService,
  solanaBridge: SolanaBridge,
  metricsServer: MetricsServer,
  log: any,
): void {
  log.info('Shutting down');
  geyserService.stop();
  solanaBridge.stop();
  metricsServer.stop();
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
