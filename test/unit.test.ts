import { describe, expect, it } from 'vitest';
import { formatBitcoin } from '@/lib/format';
import { deriveKeys } from '@/lib/keys';
import { PasskeyError } from '@/lib/passkey';
import { approve, redeem } from '@/lib/reauth';
import { emptyState, merge, sameState, type RegisterState } from '@/lib/state';
import { contentSecurityPolicy, securityHeaders } from '@/lib/security-headers';
import { signRequest, verifyRequest } from '@/lib/vault-auth';
import { open, seal } from '@/lib/vault-crypto';
import { ACCOUNT_LIMIT, IP_LIMIT, MemoryRateLimiter, clientAddress } from '@/lib/vault-limit';
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

describe('asking for the passkey again', () => {
  const keys = deriveKeys(prf);
  const other = new Uint8Array(32).fill(8);

  it('approves the passkey that opened the register, once', async () => {
    const approval = await approve(keys, async () => prf.slice());
    expect(() => redeem(approval, keys)).not.toThrow();
    expect(() => redeem(approval, keys)).toThrow('Confirm with your passkey');
  });

  it('refuses another passkey even though its prompt succeeded', async () => {
    const err = await approve(keys, async () => other).catch((e) => e);
    expect(err).toBeInstanceOf(PasskeyError);
    expect(err.kind).toBe('wrong-passkey');
    await expect(approve(keys, async () => new Uint8Array(5))).rejects.toMatchObject({
      kind: 'wrong-passkey',
    });
  });

  it('passes a dismissed prompt through and approves nothing', async () => {
    const dismissed = new PasskeyError('cancelled', 'Passkey prompt was dismissed.');
    await expect(
      approve(keys, async () => {
        throw dismissed;
      }),
    ).rejects.toBe(dismissed);
  });

  it('refuses a forged approval and one given for another register', async () => {
    expect(() => redeem({ accountId: keys.accountId }, keys)).toThrow();
    const theirs = await approve(deriveKeys(other), async () => other);
    expect(() => redeem(theirs, keys)).toThrow();
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

describe('the cap on remembered spent secrets (#17)', () => {
  const proof = (secret: string, amount = 1) => ({ id: 'k', amount, secret, C: 'c' });
  const many = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(5, '0')}`);

  it('two devices over the cap agree on what to forget', () => {
    const a = { ...emptyState('m'), spent: many('a', 3000) };
    const b = { ...emptyState('m'), spent: many('b', 3000) };
    expect(merge(a, b).spent).toHaveLength(5000);
    expect(merge(a, b)).toEqual(merge(b, a));
    expect(sameState(merge(a, b), merge(b, a))).toBe(true);
    expect(merge(merge(a, b), merge(a, b))).toEqual(merge(a, b));
  });

  it('never brings back ecash that is out in an unredeemed token', () => {
    const token = {
      id: 'c1',
      amount: 1,
      createdAt: 1,
      token: 'cashuB…',
      status: 'out' as const,
      secrets: ['a-token'],
    };
    // 'a-token' sorts first, so it is what the cap forgets.
    const now = { ...emptyState('m'), spent: ['a-token', ...many('z', 5000)], cashouts: [token] };
    const stale = { ...emptyState('m'), proofs: [proof('a-token')] };
    expect(merge(now, now).spent).not.toContain('a-token');
    for (const merged of [merge(now, stale), merge(stale, now)]) {
      expect(merged.proofs).toEqual([]);
    }
    // Taken back or redeemed, the old secret is no longer held by the record.
    const back = { ...now, spent: [], cashouts: [{ ...token, status: 'reclaimed' as const }] };
    expect(merge(back, stale).proofs).toHaveLength(1);
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

  it('limits requests per address before checking the signature', async () => {
    const from = (ip: string) =>
      GET(new Request('http://localhost/api/vault', { headers: { 'x-forwarded-for': `${ip}, 10.0.0.1` } }));
    for (let i = 0; i < IP_LIMIT; i++) expect((await from('203.0.113.7')).status).toBe(401);
    const over = await from('203.0.113.7');
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('60');
    // Somebody else is not affected.
    expect((await from('203.0.113.8')).status).toBe(401);
  });

  it('limits requests per account, whatever address they come from', async () => {
    const key = deriveKeys(new Uint8Array(32).fill(41)).authPrivkey;
    const from = (i: number) =>
      GET(
        new Request('http://localhost/api/vault', {
          headers: { Authorization: signRequest(key, 'GET', ''), 'x-forwarded-for': `198.51.100.${i}` },
        }),
      );
    for (let i = 0; i < ACCOUNT_LIMIT; i++) expect((await from(i)).status).toBe(200);
    expect((await from(200)).status).toBe(429);
    // Another account from one of those addresses still gets through.
    const other = deriveKeys(new Uint8Array(32).fill(42)).authPrivkey;
    const res = await GET(
      new Request('http://localhost/api/vault', {
        headers: { Authorization: signRequest(other, 'GET', ''), 'x-forwarded-for': '198.51.100.1' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('refuses an oversized body without reading it all', async () => {
    // Declared too long: not read at all.
    let pulled = 0;
    const declared = await PUT(
      new Request('http://localhost/api/vault', {
        method: 'PUT',
        headers: { 'content-length': String(10 * 1024 * 1024), 'x-forwarded-for': '192.0.2.1' },
        body: new ReadableStream({
          pull(c) {
            pulled++;
            c.enqueue(new Uint8Array(1024));
          },
        }),
        duplex: 'half',
      } as RequestInit),
    );
    expect(declared.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(1);

    // No length declared: reading stops soon after the cap, not at the end.
    let sent = 0;
    const endless = await PUT(
      new Request('http://localhost/api/vault', {
        method: 'PUT',
        headers: { 'x-forwarded-for': '192.0.2.2' },
        body: new ReadableStream({
          pull(c) {
            sent += 64 * 1024;
            if (sent > 64 * 1024 * 1024) c.close();
            else c.enqueue(new Uint8Array(64 * 1024));
          },
        }),
        duplex: 'half',
      } as RequestInit),
    );
    expect(endless.status).toBe(413);
    expect(sent).toBeLessThan(1024 * 1024);
  });

  it('counts a window and then starts a new one', async () => {
    let now = 1_000;
    const limiter = new MemoryRateLimiter(() => now);
    expect(await limiter.hit('k', 2)).toBe(true);
    expect(await limiter.hit('k', 2)).toBe(true);
    expect(await limiter.hit('k', 2)).toBe(false);
    expect(await limiter.hit('other', 2)).toBe(true);
    now += 60_001;
    expect(await limiter.hit('k', 2)).toBe(true);
    expect(clientAddress(new Headers({ 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' }))).toBe('1.2.3.4');
    expect(clientAddress(new Headers({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
    expect(clientAddress(new Headers())).toBe('unknown');
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

describe('security headers', () => {
  const policy = (dev: boolean) =>
    Object.fromEntries(
      contentSecurityPolicy(dev)
        .split('; ')
        .map((d) => [d.split(' ')[0], d.split(' ').slice(1)]),
    );

  it('keeps scripts, frames and plugins to this origin in production', () => {
    const p = policy(false);
    expect(p['default-src']).toEqual(["'self'"]);
    expect(p['script-src']).toEqual(["'self'", "'unsafe-inline'"]);
    expect(p['object-src']).toEqual(["'none'"]);
    expect(p['frame-src']).toEqual(["'none'"]);
    expect(p['frame-ancestors']).toEqual(["'none'"]);
    expect(p['base-uri']).toEqual(["'self'"]);
    expect(p['form-action']).toEqual(["'self'"]);
    // The mint, the price hosts and Lightning address hosts: any https, nothing plainer.
    expect(p['connect-src']).toEqual(["'self'", 'https:']);
    expect(p).toHaveProperty('upgrade-insecure-requests');
    expect(contentSecurityPolicy(false)).not.toMatch(/unsafe-eval|\*|http:|ws:/);
  });

  it('loosens only what the dev server needs', () => {
    const p = policy(true);
    expect(p['script-src']).toContain("'unsafe-eval'");
    expect(p['connect-src']).toEqual(["'self'", 'https:', 'ws:', 'http://localhost:*']);
    expect(p).not.toHaveProperty('upgrade-insecure-requests');
    expect(p['frame-ancestors']).toEqual(["'none'"]);
  });

  it('sends the other headers too', () => {
    const headers = Object.fromEntries(securityHeaders(false).map((h) => [h.key, h.value]));
    expect(headers['X-Frame-Options']).toBe('DENY');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Permissions-Policy']).not.toMatch(/publickey-credentials/);
  });
});
