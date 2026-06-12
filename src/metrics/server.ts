import http from 'http';
import { ConnectionPool } from '../solana/pool';
import { GeyserService } from '../services/geyser';
import { getLogger } from '../utils/logger';
import { Config } from '../config';

export interface MetricsReporter {
  incrementRPCCall(method: string): void;
  incrementRPCSuccess(method: string): void;
  incrementRPCFailure(method: string): void;
  streamOpened(): void;
  streamClosed(): void;
}

export class MetricsServer {
  private server: http.Server;
  private startTime: number;
  private rpcCalls: Map<string, { total: number; success: number; failure: number }> = new Map();
  private streamsOpenedTotal = 0;
  private streamsActive = 0;
  private geyserService: GeyserService | null = null;

  constructor(
    private config: Config,
    private pool: ConnectionPool,
  ) {
    this.startTime = Date.now();
    this.server = http.createServer((req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: this.uptimeSeconds }));
        return;
      }
      if (req.url === '/metrics') {
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(this.generatePrometheus());
        return;
      }
      res.writeHead(404);
      res.end();
    });
  }

  get reporter(): MetricsReporter {
    return {
      incrementRPCCall: (method) => {
        let entry = this.rpcCalls.get(method);
        if (!entry) { entry = { total: 0, success: 0, failure: 0 }; this.rpcCalls.set(method, entry); }
        entry.total++;
      },
      incrementRPCSuccess: (method) => {
        const entry = this.rpcCalls.get(method);
        if (entry) entry.success++;
      },
      incrementRPCFailure: (method) => {
        const entry = this.rpcCalls.get(method);
        if (entry) entry.failure++;
      },
      streamOpened: () => { this.streamsOpenedTotal++; this.streamsActive++; },
      streamClosed: () => { this.streamsActive = Math.max(0, this.streamsActive - 1); },
    };
  }

  private get uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startTime) / 1000);
  }

  setGeyserService(service: GeyserService): void {
    this.geyserService = service;
  }

  start(): void {
    this.server.listen(this.config.metricsPort, '0.0.0.0', () => {
      getLogger().info({ port: this.config.metricsPort }, 'Metrics server listening');
    });
  }

  stop(): void {
    this.server.close();
  }

  private generatePrometheus(): string {
    const lines: string[] = [];
    lines.push('# HELP geyser_start_time_seconds Unix timestamp of server start');
    lines.push('# TYPE geyser_start_time_seconds gauge');
    lines.push(`geyser_start_time_seconds ${Math.floor(this.startTime / 1000)}`);

    lines.push('# HELP geyser_uptime_seconds Server uptime in seconds');
    lines.push('# TYPE geyser_uptime_seconds gauge');
    lines.push(`geyser_uptime_seconds ${this.uptimeSeconds}`);

    lines.push('# HELP geyser_rpc_calls_total Total RPC calls by method');
    lines.push('# TYPE geyser_rpc_calls_total counter');
    for (const [method, counts] of this.rpcCalls) {
      lines.push(`geyser_rpc_calls_total{method="${method}"} ${counts.total}`);
    }

    lines.push('# HELP geyser_rpc_calls_success Successful RPC calls by method');
    lines.push('# TYPE geyser_rpc_calls_success counter');
    for (const [method, counts] of this.rpcCalls) {
      lines.push(`geyser_rpc_calls_success{method="${method}"} ${counts.success}`);
    }

    lines.push('# HELP geyser_rpc_calls_failure Failed RPC calls by method');
    lines.push('# TYPE geyser_rpc_calls_failure counter');
    for (const [method, counts] of this.rpcCalls) {
      lines.push(`geyser_rpc_calls_failure{method="${method}"} ${counts.failure}`);
    }

    lines.push('# HELP geyser_streams_opened_total Total subscribe streams opened');
    lines.push('# TYPE geyser_streams_opened_total counter');
    lines.push(`geyser_streams_opened_total ${this.streamsOpenedTotal}`);

    lines.push('# HELP geyser_streams_active Current active subscribe streams');
    lines.push('# TYPE geyser_streams_active gauge');
    lines.push(`geyser_streams_active ${this.streamsActive}`);

    lines.push('# HELP geyser_subscribers_total Current subscriber count');
    lines.push('# TYPE geyser_subscribers_total gauge');
    lines.push(`geyser_subscribers_total ${this.geyserService?.subscriberCount ?? 0}`);

    lines.push('# HELP geyser_pool_connections Total connections in pool');
    lines.push('# TYPE geyser_pool_connections gauge');
    lines.push(`geyser_pool_connections ${this.pool.size}`);

    lines.push('# HELP geyser_pool_load Total subscription count across all connections');
    lines.push('# TYPE geyser_pool_load gauge');
    lines.push(`geyser_pool_load ${this.pool.load}`);

    return lines.join('\n') + '\n';
  }
}
