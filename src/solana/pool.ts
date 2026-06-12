import { Connection, Commitment } from '@solana/web3.js';
import { EventEmitter } from 'events';
import { getLogger } from '../utils/logger';

export interface PoolConnection {
  id: number;
  connection: Connection;
  subscriptionCount: number;
  healthy: boolean;
}

export class ConnectionPool extends EventEmitter {
  private connections: PoolConnection[] = [];
  private rpcUrl: string;
  private wsUrl: string;
  private maxPerConn: number;
  private maxConn: number;
  private nextId: number = 0;

  constructor(
    rpcUrl: string,
    wsUrl: string,
    maxPerConn: number,
    maxConn: number,
  ) {
    super();
    this.rpcUrl = rpcUrl;
    this.wsUrl = wsUrl;
    this.maxPerConn = maxPerConn;
    this.maxConn = maxConn;
  }

  private createConnection(): PoolConnection {
    const conn = new Connection(this.rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: this.wsUrl,
      confirmTransactionInitialTimeout: 120_000,
    });
    const entry: PoolConnection = {
      id: this.nextId++,
      connection: conn,
      subscriptionCount: 0,
      healthy: true,
    };
    this.connections.push(entry);
    getLogger().debug({ poolId: entry.id, poolSize: this.connections.length }, 'Connection created');
    return entry;
  }

  acquire(): PoolConnection {
    let best = this.connections.find(
      (c) => c.healthy && c.subscriptionCount < this.maxPerConn,
    );
    if (!best && this.connections.length < this.maxConn) {
      best = this.createConnection();
    }
    if (!best) {
      best = this.connections.reduce((a, b) =>
        a.subscriptionCount <= b.subscriptionCount ? a : b,
      );
    }
    best.subscriptionCount++;
    return best;
  }

  release(poolId: number): void {
    const entry = this.connections.find((c) => c.id === poolId);
    if (entry) {
      entry.subscriptionCount = Math.max(0, entry.subscriptionCount - 1);
    }
  }

  markUnhealthy(poolId: number): void {
    const entry = this.connections.find((c) => c.id === poolId);
    if (entry) {
      entry.healthy = false;
      getLogger().warn({ poolId }, 'Connection marked unhealthy');
    }
  }

  async reconnectAll(): Promise<void> {
    for (const entry of this.connections) {
      entry.healthy = true;
      entry.subscriptionCount = 0;
    }
  }

  getConnection(id: number): PoolConnection | undefined {
    return this.connections.find((c) => c.id === id);
  }

  get size(): number {
    return this.connections.length;
  }

  get load(): number {
    return this.connections.reduce(
      (sum, c) => sum + c.subscriptionCount,
      0,
    );
  }
}
