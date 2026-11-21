import { describe, expect, it } from 'vitest';
import { formatBitcoin } from '@/lib/format';
import { deriveKeys } from '@/lib/keys';
import { emptyState, merge, sameState, type RegisterState } from '@/lib/state';
import { signRequest, verifyRequest } from '@/lib/vault-auth';
import { open, seal } from '@/lib/vault-crypto';
import { MemoryVaultStore, parseRecord } from '@/lib/vault-store';
import { GET, PUT } from '@/app/api/vault/route';

const prf = new Uint8Array(32).fill(7);

describe('BIP-177 formatting', () => {
  it('writes whole bitcoin with the symbol and no sats', () => {
    expect(formatBitcoin(0)).toBe('₿0');
    expect(formatBitcoin(21)).toBe('₿21');
    expect(formatBitcoin(1234567)).toBe('₿1,234,567');
  });
});

describe('keys from the passkey secret', () => {
  it('is deterministic and gives a 12-word phrase', () => {
    const a = deriveKeys(prf);
    const b = deriveKeys(prf);
    expect(a.mnemonic.split(' ')).toHaveLength(12);
    expect(a.mnemonic).toBe(b.mnemonic);
    expect(a.accountId).toBe(b.accountId);
    expect(a.walletSeed).toHaveLength(64);
    expect(a.quotePubkey).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it('gives unrelated keys for another passkey and for each purpose', () => {
    const a = deriveKeys(prf);
    const b = deriveKeys(new Uint8Array(32).fill(8));
    expect(a.accountId).not.toBe(b.accountId);
    expect(a.mnemonic).not.toBe(b.mnemonic);
    expect(Buffer.from(a.vaultKey).toString('hex')).not.toBe(
      Buffer.from(a.authPrivkey).toString('hex'),
    );
  });
});

describe('vault encryption', () => {
  it('round-trips and rejects the wrong key or a changed blob', async () => {
    const { vaultKey } = deriveKeys(prf);
    const blob = await seal(vaultKey, 'hello ₿');
    expect(await open(vaultKey, blob)).toBe('hello ₿');
    expect(blob).not.toContain('hello');
    await expect(open(deriveKeys(new Uint8Array(32)).vaultKey, blob)).rejects.toThrow();
    const flipped = (blob[0] === 'A' ? 'B' : 'A') + blob.slice(1);
    await expect(open(vaultKey, flipped)).rejects.toThrow();
  });
});

describe('vault request signatures', () => {
  const { authPrivkey, accountId } = deriveKeys(prf);
  const now = 1_800_000_000_000;

  it('accepts a fresh signature and names the account', () => {
    const header = signRequest(authPrivkey, 'PUT', '{"a":1}', now);
    expect(verifyRequest(header, 'PUT', '{"a":1}', now)).toBe(accountId);
  });

  it('rejects a changed body, method, account or a stale timestamp', () => {
    const header = signRequest(authPrivkey, 'PUT', '{"a":1}', now);
    expect(verifyRequest(header, 'PUT', '{"a":2}', now)).toBeNull();
    expect(verifyRequest(header, 'GET', '{"a":1}', now)).toBeNull();
    expect(verifyRequest(header, 'PUT', '{"a":1}', now + 301_000)).toBeNull();
    const other = deriveKeys(new Uint8Array(32).fill(9)).accountId;
    expect(verifyRequest(header.replace(accountId, other), 'PUT', '{"a":1}', now)).toBeNull();
    expect(verifyRequest(null, 'PUT', '', now)).toBeNull();
    expect(verifyRequest('Beepos garbage', 'PUT', '', now)).toBeNull();
  });
});

describe('state merge', () => {
  const proof = (secret: string, amount = 1) => ({ id: 'k', amount, secret, C: 'c' });
  const sale = (id: string, status: 'pending' | 'paid' | 'expired', createdAt = 1) => ({
    id,
    amount: 5,
    memo: '',
    request: 'lnbc',
    createdAt,
    expiry: null,
    status,
  });
  const base = (over: Partial<RegisterState>): RegisterState => ({ ...emptyState('m'), ...over });

  it('unions proofs, keeps the highest counter and the furthest sale status', () => {
    const a = base({ proofs: [proof('a')], counters: { k: 5 }, sales: [sale('s1', 'pending')] });
    const b = base({ proofs: [proof('b')], counters: { k: 9 }, sales: [sale('s1', 'paid')] });
    const m = merge(a, b);
    expect(m.proofs.map((p) => p.secret)).toEqual(['a', 'b']);
    expect(m.counters.k).toBe(9);
    expect(m.sales).toHaveLength(1);
    expect(m.sales[0].status).toBe('paid');
  });

  it('never brings back a proof the other device spent', () => {
    const a = base({ proofs: [proof('a'), proof('b')] });
    const b = base({ proofs: [proof('b')], spent: ['a'] });
    expect(merge(a, b).proofs.map((p) => p.secret)).toEqual(['b']);
    expect(merge(b, a).proofs.map((p) => p.secret)).toEqual(['b']);
  });

  it('is commutative and idempotent', () => {
    const a = base({ proofs: [proof('a')], spent: ['x'], sales: [sale('s2', 'expired', 2)] });
    const b = base({ proofs: [proof('b')], counters: { k: 2 }, sales: [sale('s1', 'paid', 1)] });
    expect(merge(a, b)).toEqual(merge(b, a));
    expect(sameState(merge(a, a), a)).toBe(true);
    expect(sameState(a, b)).toBe(false);
  });
});

describe('vault API', () => {
  const { authPrivkey } = deriveKeys(prf);
  const call = (method: 'GET' | 'PUT', body = '', key = authPrivkey) =>
    (method === 'GET' ? GET : PUT)(
      new Request('http://localhost/api/vault', {
        method,
        headers: { Authorization: signRequest(key, method, body) },
        body: method === 'PUT' ? body : undefined,
      }),
    );

  it('stores a blob per account with compare-and-swap', async () => {
    expect(await (await call('GET')).json()).toEqual({ version: 0, blob: null });

    const first = await call('PUT', JSON.stringify({ baseVersion: 0, blob: 'AAAA' }));
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ version: 1 });

    const stale = await call('PUT', JSON.stringify({ baseVersion: 0, blob: 'BBBB' }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ version: 1, blob: 'AAAA' });

    expect(await (await call('GET')).json()).toEqual({ version: 1, blob: 'AAAA' });

    const stranger = deriveKeys(new Uint8Array(32).fill(3)).authPrivkey;
    expect(await (await call('GET', '', stranger)).json()).toEqual({ version: 0, blob: null });
  });

  it('rejects unsigned and malformed writes', async () => {
    const unsigned = await PUT(
      new Request('http://localhost/api/vault', { method: 'PUT', body: '{}' }),
    );
    expect(unsigned.status).toBe(401);
    expect((await call('PUT', JSON.stringify({ baseVersion: 0, blob: 'not base64!' }))).status).toBe(400);
    expect((await call('PUT', JSON.stringify({ baseVersion: -1, blob: 'AAAA' }))).status).toBe(400);
    expect((await call('PUT', 'nope')).status).toBe(400);
  });

  it('memory store refuses a write from a stale version', async () => {
    const store = new MemoryVaultStore();
    expect(await store.put('x', 0, 'a')).toEqual({ ok: true, version: 1 });
    expect(await store.put('x', 0, 'b')).toEqual({ ok: false, current: { version: 1, blob: 'a' } });
  });

  it('reads the stored record format', () => {
    expect(parseRecord('12:AAAA+/==')).toEqual({ version: 12, blob: 'AAAA+/==' });
    expect(parseRecord(null)).toBeNull();
    expect(parseRecord(['version', '1'])).toBeNull();
  });
});
