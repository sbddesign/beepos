import { Redis } from '@upstash/redis';

// One record per account: an opaque encrypted blob and a version number.
// Writes are compare-and-swap on the version.

export type VaultRecord = { version: number; blob: string };
export type PutResult = { ok: true; version: number } | { ok: false; current: VaultRecord | null };

export interface VaultStore {
  get(accountId: string): Promise<VaultRecord | null>;
  put(accountId: string, baseVersion: number, blob: string): Promise<PutResult>;
}

export class MemoryVaultStore implements VaultStore {
  private records = new Map<string, VaultRecord>();

  async get(accountId: string) {
    return this.records.get(accountId) ?? null;
  }

  async put(accountId: string, baseVersion: number, blob: string): Promise<PutResult> {
    const current = this.records.get(accountId) ?? null;
    if ((current?.version ?? 0) !== baseVersion) return { ok: false, current };
    const version = baseVersion + 1;
    this.records.set(accountId, { version, blob });
    return { ok: true, version };
  }
}

// Each record is one string, "<version>:<blob>". (A hash would not do: with
// automatic deserialization off, HGETALL comes back as a flat array.)
const CAS = `
local cur = redis.call('GET', KEYS[1])
local v = 0
if cur then v = tonumber(string.match(cur, '^(%d+):')) end
if v ~= tonumber(ARGV[1]) then return -1 end
redis.call('SET', KEYS[1], (v + 1) .. ':' .. ARGV[2])
return v + 1
`;

export function parseRecord(raw: unknown): VaultRecord | null {
  const m = typeof raw === 'string' ? /^(\d+):(.*)$/s.exec(raw) : null;
  return m ? { version: Number(m[1]), blob: m[2] } : null;
}

export class RedisVaultStore implements VaultStore {
  constructor(private redis: Redis) {}

  private key(accountId: string) {
    return `beepos:v1:vault:${accountId}`;
  }

  async get(accountId: string) {
    return parseRecord(await this.redis.get(this.key(accountId)));
  }

  async put(accountId: string, baseVersion: number, blob: string): Promise<PutResult> {
    const result = await this.redis.eval(CAS, [this.key(accountId)], [String(baseVersion), blob]);
    const version = Number(result);
    if (version === -1) return { ok: false, current: await this.get(accountId) };
    return { ok: true, version };
  }
}

let store: VaultStore | null | undefined;

/** null means no vault storage is configured: the register runs local-only. */
export function getVaultStore(): VaultStore | null {
  if (store !== undefined) return store;
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    // Blobs are base64 strings; automatic JSON decoding would mangle them.
    store = new RedisVaultStore(new Redis({ url, token, automaticDeserialization: false }));
  } else if (process.env.NODE_ENV !== 'production' || process.env.BEEPOS_MEMORY_VAULT === '1') {
    store = new MemoryVaultStore();
  } else {
    store = null;
  }
  return store;
}
