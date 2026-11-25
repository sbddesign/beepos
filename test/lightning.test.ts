import { bech32 } from '@scure/base';
import { describe, expect, it } from 'vitest';
import { invoiceMsat, parseDestination } from '@/lib/destination';
import { LnurlError, lnurlInvoice } from '@/lib/lnurl';
import { emptyState, merge, parseState, type Payout, type RegisterState } from '@/lib/state';

const DATA = 'pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypq';
const invoice = (amount: string) => `lnbc${amount}1${DATA}`;

describe('reading a cash-out destination', () => {
  it('reads a BOLT11 invoice and its amount', () => {
    expect(parseDestination(invoice('2500u'))).toEqual({
      kind: 'bolt11',
      invoice: invoice('2500u'),
      amount: 250_000,
    });
    expect(parseDestination(invoice('10n'))).toMatchObject({ amount: 1 });
    expect(parseDestination(invoice('20m'))).toMatchObject({ amount: 2_000_000 });
    expect(parseDestination(invoice('1'))).toMatchObject({ amount: 100_000_000 });
    expect(parseDestination(invoice('10000p'))).toMatchObject({ amount: 1 });
  });

  it('accepts the forms a wallet copies: upper case, a lightning: prefix, spaces around', () => {
    const want = parseDestination(invoice('2500u'));
    expect(parseDestination(`  LIGHTNING:${invoice('2500u').toUpperCase()}\n`)).toEqual(want);
  });

  it('keeps an invoice without an amount open', () => {
    expect(parseDestination(invoice(''))).toMatchObject({ kind: 'bolt11', amount: null });
  });

  it('refuses an invoice for a fraction of the base unit, or for nothing', () => {
    expect(parseDestination(invoice('1500p'))).toBeNull(); // 150 millisats
    expect(parseDestination(invoice('15p'))).toBeNull(); // not a whole millisat
    expect(parseDestination(invoice('0u'))).toBeNull();
    expect(invoiceMsat(invoice('1500p'))).toBe(150n);
  });

  it('reads a BOLT12 offer', () => {
    const offer = 'lno1pqps7sjqpgtyzm3qv4uxzmtsd3jjqer9wd3hy6tsw35k7msjzfpy7nz5yqcn';
    expect(parseDestination(offer.toUpperCase())).toEqual({ kind: 'bolt12', offer });
  });

  it('reads a Lightning address as an https LNURL-pay link', () => {
    expect(parseDestination('Satoshi@Example.com')).toEqual({
      kind: 'lnurl',
      url: 'https://example.com/.well-known/lnurlp/satoshi',
      label: 'satoshi@example.com',
    });
  });

  it('reads a bech32 LNURL, and only when it points at https', () => {
    const encode = (url: string) =>
      bech32.encode('lnurl', bech32.toWords(new TextEncoder().encode(url)), 2000);
    expect(parseDestination(encode('https://pay.example.com/lnurlp/abc?x=1'))).toEqual({
      kind: 'lnurl',
      url: 'https://pay.example.com/lnurlp/abc?x=1',
      label: 'pay.example.com',
    });
    expect(parseDestination(encode('http://pay.example.com/lnurlp/abc'))).toBeNull();
    expect(parseDestination(encode('https://user:pw@pay.example.com/x'))).toBeNull();
    expect(parseDestination(encode('javascript:alert(1)'))).toBeNull();
  });

  it('refuses everything else', () => {
    for (const junk of [
      '',
      'hello',
      'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
      'cashuBo2FteCJodHRwczovL21pbnQ',
      'two words@example.com',
      'name@localhost',
      'name@exa mple.com',
      'name@evil.com/path',
      'https://example.com',
      'lnbc2500u1',
      'lnbc2500u1bbbb', // "b" is not in the bech32 alphabet
    ]) {
      expect(parseDestination(junk), junk).toBeNull();
    }
  });
});

describe('getting an invoice from a Lightning address', () => {
  const URL_ = 'https://example.com/.well-known/lnurlp/satoshi';
  const info = {
    tag: 'payRequest',
    callback: 'https://example.com/cb?id=7',
    minSendable: 1000,
    maxSendable: 1_000_000_000,
    metadata: '[]',
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  function server(answers: Record<string, () => Response | Promise<Response>>) {
    const seen: string[] = [];
    const fetcher = async (url: string) => {
      seen.push(url);
      const hit = answers[url];
      if (!hit) throw new TypeError('Failed to fetch');
      return hit();
    };
    return { seen, fetcher };
  }

  it('asks for the amount in millisats and returns the invoice', async () => {
    const { seen, fetcher } = server({
      [URL_]: () => json(info),
      'https://example.com/cb?id=7&amount=250000000': () => json({ pr: invoice('2500u').toUpperCase() }),
    });
    expect(await lnurlInvoice(URL_, 250_000, fetcher)).toBe(invoice('2500u'));
    expect(seen).toEqual([URL_, 'https://example.com/cb?id=7&amount=250000000']);
  });

  it('never returns an invoice for a different amount', async () => {
    for (const pr of [invoice('2600u'), invoice(''), 'not an invoice', undefined]) {
      const { fetcher } = server({
        [URL_]: () => json(info),
        'https://example.com/cb?id=7&amount=250000000': () => json({ pr }),
      });
      await expect(lnurlInvoice(URL_, 250_000, fetcher)).rejects.toThrow('different amount');
    }
  });

  it('respects the recipient limits without asking for an invoice', async () => {
    const { seen, fetcher } = server({ [URL_]: () => json({ ...info, maxSendable: 5_000_000 }) });
    await expect(lnurlInvoice(URL_, 250_000, fetcher)).rejects.toThrow('between 1 and 5000');
    expect(seen).toEqual([URL_]);
  });

  it('refuses a callback that is not https, and answers that are not LNURL-pay', async () => {
    for (const bad of [
      { ...info, callback: 'http://example.com/cb' },
      { ...info, callback: 'nope' },
      { ...info, tag: 'withdrawRequest' },
      { ...info, minSendable: 0 },
      [],
    ]) {
      const { fetcher } = server({ [URL_]: () => json(bad) });
      await expect(lnurlInvoice(URL_, 250_000, fetcher)).rejects.toBeInstanceOf(LnurlError);
    }
  });

  it('says what to do when the browser cannot reach the host', async () => {
    const { fetcher } = server({});
    await expect(lnurlInvoice(URL_, 250_000, fetcher)).rejects.toThrow('paste that instead');
  });

  it('passes on a refusal from the recipient and a missing address', async () => {
    let { fetcher } = server({ [URL_]: () => json({ status: 'ERROR', reason: 'User not found' }) });
    await expect(lnurlInvoice(URL_, 250_000, fetcher)).rejects.toThrow('User not found');
    ({ fetcher } = server({ [URL_]: () => new Response('nope', { status: 404 }) }));
    await expect(lnurlInvoice(URL_, 250_000, fetcher)).rejects.toThrow('does not exist');
  });
});

describe('Lightning cash-outs in the register state', () => {
  const proof = (secret: string, amount = 1) => ({ id: 'k', amount, secret, C: 'c' });
  const payout = (patch: Partial<Payout>): Payout => ({
    id: 'q1',
    method: 'bolt11',
    to: 'satoshi@example.com',
    amount: 10,
    feeReserve: 2,
    createdAt: 1,
    expiry: 2,
    status: 'pending',
    inputs: [proof('a', 8), proof('b', 4)],
    ...patch,
  });
  const state = (patch: Partial<RegisterState>): RegisterState => ({ ...emptyState('m'), ...patch });

  it('opens a register saved before Lightning cash-outs existed', () => {
    const { payouts: _, ...old } = emptyState('m');
    expect(parseState(JSON.stringify(old), 'm').payouts).toEqual([]);
  });

  it('a payment that failed on one device gives the ecash back on both', () => {
    const waiting = state({ payouts: [payout({})] });
    const failed = state({
      proofs: [proof('a', 8), proof('b', 4)],
      payouts: [payout({ status: 'failed', inputs: [] })],
    });
    for (const merged of [merge(waiting, failed), merge(failed, waiting)]) {
      expect(merged.payouts).toEqual([payout({ status: 'failed', inputs: [] })]);
      expect(merged.proofs.map((p) => p.secret)).toEqual(['a', 'b']);
    }
  });

  it('a payment that went through never gives the ecash back', () => {
    const paid = state({
      spent: ['a', 'b'],
      proofs: [proof('change')],
      payouts: [payout({ status: 'paid', inputs: [], fee: 1 })],
    });
    const stale = state({
      proofs: [proof('a', 8), proof('b', 4)],
      payouts: [payout({ status: 'failed', inputs: [] })],
    });
    for (const merged of [merge(paid, stale), merge(stale, paid)]) {
      expect(merged.payouts[0].status).toBe('paid');
      expect(merged.proofs.map((p) => p.secret)).toEqual(['change']);
    }
  });
});
