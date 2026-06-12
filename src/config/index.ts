import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

export interface Config {
  port: number;
  host: string;
  solanaRpcUrl: string;
  solanaRpcWsUrl: string;
  tlsCertPath: string;
  tlsKeyPath: string;
  adminKey: string;
  logLevel: string;
  metricsPort: number;
  maxStreamsPerConnection: number;
  maxConnections: number;
  pingIntervalMs: number;
  pingTimeoutMs: number;
  slotBufferSize: number;
  blockPollIntervalMs: number;
  grpcMaxMessageLength: number;
  version: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const n = parseInt(raw, 10);
  return isNaN(n) ? fallback : n;
}

export function loadConfig(): Config {
  const rpcUrl = optionalEnv(
    'SOLANA_RPC_URL',
    'https://api.mainnet-beta.solana.com',
  );

  const wsUrl =
    process.env['SOLANA_RPC_WS_URL'] ||
    rpcUrl.replace(/^https?:\/\//, (m) =>
      m === 'https://' ? 'wss://' : 'ws://',
    );

  return {
    port: optionalInt('PORT', 10000),
    host: optionalEnv('HOST', '0.0.0.0'),
    solanaRpcUrl: rpcUrl,
    solanaRpcWsUrl: wsUrl,
    tlsCertPath: optionalEnv('TLS_CERT_PATH', ''),
    tlsKeyPath: optionalEnv('TLS_KEY_PATH', ''),
    adminKey: requireEnv('ADMIN_KEY'),
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
    metricsPort: optionalInt('METRICS_PORT', 10001),
    maxStreamsPerConnection: optionalInt('MAX_STREAMS_PER_CONNECTION', 100),
    maxConnections: optionalInt('MAX_CONNECTIONS', 10),
    pingIntervalMs: optionalInt('PING_INTERVAL_MS', 15_000),
    pingTimeoutMs: optionalInt('PING_TIMEOUT_MS', 60_000),
    slotBufferSize: optionalInt('SLOT_BUFFER_SIZE', 500),
    blockPollIntervalMs: optionalInt('BLOCK_POLL_INTERVAL_MS', 500),
    grpcMaxMessageLength: optionalInt('GRPC_MAX_MESSAGE_LENGTH', 64 * 1024 * 1024),
    version: '1.0.0',
  };
}
