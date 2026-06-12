import crypto from 'crypto';
import { getLogger } from '../utils/logger';

export interface ApiKey {
  id: string;
  label: string;
  keyHash: string;
  createdAt: number;
  enabled: boolean;
  rateLimitPerMinute: number;
}

export class ApiKeyStore {
  private keys: Map<string, ApiKey> = new Map();
  private rateLimitBuckets: Map<string, { window: number; count: number }> =
    new Map();

  constructor(adminKey: string) {
    const hash = this.hashKey(adminKey);
    this.keys.set(hash, {
      id: 'admin',
      label: 'admin',
      keyHash: hash,
      createdAt: Date.now(),
      enabled: true,
      rateLimitPerMinute: 10000,
    });
  }

  private hashKey(key: string): string {
    return crypto.createHash('sha256').update(key).digest('hex');
  }

  validate(key: string): ApiKey | null {
    const hash = this.hashKey(key);
    const entry = this.keys.get(hash);
    if (!entry || !entry.enabled) return null;
    if (!this.checkRateLimit(hash, entry.rateLimitPerMinute)) return null;
    return entry;
  }

  private checkRateLimit(keyHash: string, limit: number): boolean {
    const now = Date.now();
    const windowMs = 60_000;
    const bucket = this.rateLimitBuckets.get(keyHash);
    if (!bucket || now - bucket.window > windowMs) {
      this.rateLimitBuckets.set(keyHash, { window: now, count: 1 });
      return true;
    }
    if (bucket.count >= limit) return false;
    bucket.count++;
    return true;
  }

  addKey(label: string, rateLimitPerMinute: number): string {
    const raw = crypto.randomBytes(32).toString('hex');
    const hash = this.hashKey(raw);
    this.keys.set(hash, {
      id: crypto.randomUUID(),
      label,
      keyHash: hash,
      createdAt: Date.now(),
      enabled: true,
      rateLimitPerMinute,
    });
    getLogger().info({ label }, 'API key created');
    return raw;
  }

  revokeKey(keyHash: string): boolean {
    const entry = this.keys.get(keyHash);
    if (!entry) return false;
    entry.enabled = false;
    getLogger().info({ label: entry.label }, 'API key revoked');
    return true;
  }
}
