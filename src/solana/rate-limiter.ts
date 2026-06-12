import https from 'https';
import http from 'http';

const agent = new https.Agent({ keepAlive: true, maxSockets: 4 });

export function getHttpsAgent(): https.Agent {
  return agent;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private maxTokens: number = 10,
    private refillPerSec: number = 10,
  ) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
    return this.acquire();
  }
}
