import type { Redis } from '@upstash/redis';

// Request limits for the vault API: a fixed window per key. They exist so one
// client cannot run up the storage bill or hammer signature checks; an honest
// register makes a handful of requests a minute.

export const WINDOW_SECONDS = 60;
/** Per IP address, counted before the signature is checked. */
export const IP_LIMIT = 120;
/** Per account, counted after the signature is checked. */
export const ACCOUNT_LIMIT = 60;

export interface RateLimiter {
  /** Counts one request against `key`. Resolves false when the key is over `limit`. */
  hit(key: string, limit: number): Promise<boolean>;
}

export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { until: number; count: number }>();

  constructor(private now: () => number = Date.now) {}

  async hit(key: string, limit: number) {
    const now = this.now();
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) if (w.until <= now) this.windows.delete(k);
    }
    const open = this.windows.get(key);
    if (!open || open.until <= now) {
      this.windows.set(key, { until: now + WINDOW_SECONDS * 1000, count: 1 });
      return limit >= 1;
    }
    open.count++;
    return open.count <= limit;
  }
}

const COUNT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return n
`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private redis: Redis) {}

  async hit(key: string, limit: number) {
    try {
      const n = await this.redis.eval(COUNT, [`beepos:v1:rate:${key}`], [String(WINDOW_SECONDS)]);
      return Number(n) <= limit;
    } catch {
      // If the counter cannot be reached the vault read or write will fail too;
      // do not turn a storage hiccup into a lockout.
      return true;
    }
  }
}

/** The caller's address as the platform reports it; one shared bucket when it does not. */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (forwarded || headers.get('x-real-ip')?.trim() || 'unknown').slice(0, 64);
}

/**
 * Reads a request body, giving up as soon as it is longer than `maxBytes`.
 * Returns null when it is too long, without holding the rest in memory.
 */
export async function readCapped(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
