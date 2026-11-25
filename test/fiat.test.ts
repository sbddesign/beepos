import { describe, expect, it } from 'vitest';
import {
  CURRENCIES,
  STALE_MS,
  decimals,
  fetchRates,
  formatFiat,
  isCurrency,
  toBitcoin,
  usableRate,
} from '@/lib/fiat';
import { emptyState, merge, parseState, sameState, type RegisterState } from '@/lib/state';

const COINBASE = 'https://api.coinbase.com/v2/exchange-rates?currency=BTC';
const BLOCKCHAIN = 'https://blockchain.info/ticker';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('fiat amounts', () => {
  it('knows how each currency is written', () => {
    expect(decimals('USD')).toBe(2);
    expect(decimals('JPY')).toBe(0);
    expect(decimals('KRW')).toBe(0);
    expect(decimals('CLP')).toBe(0);
    for (const code of CURRENCIES) expect([0, 2]).toContain(decimals(code));
    expect(isCurrency('USD')).toBe(true);
    expect(isCurrency('usd')).toBe(false);
    expect(isCurrency('XXX')).toBe(false);
    expect(isCurrency(null)).toBe(false);
  });

  it('turns the smallest unit into bitcoin base units at the price given', () => {
    // At 50,000 per bitcoin, 1.00 is 2,000 and 12.50 is 25,000.
    expect(toBitcoin(100, 'USD', 50_000)).toBe(2_000);
    expect(toBitcoin(1250, 'USD', 50_000)).toBe(25_000);
    // Yen has no cents: 1,000 yen at 10,000,000 per bitcoin is 10,000.
    expect(toBitcoin(1000, 'JPY', 10_000_000)).toBe(10_000);
    // Rounds to the nearest unit: 0.01 at 58,183.24 is 17.19 units.
    expect(toBitcoin(1, 'USD', 58_183.24)).toBe(17);
    expect(toBitcoin(3, 'USD', 58_183.24)).toBe(52);
  });

  it('never prices a real amount at zero, and nothing at nothing', () => {
    expect(toBitcoin(1, 'ARS', 93_670_585)).toBe(1);
    expect(toBitcoin(0, 'USD', 50_000)).toBe(0);
    expect(toBitcoin(100, 'USD', 0)).toBe(0);
    expect(toBitcoin(100, 'USD', NaN)).toBe(0);
  });

  it('formats with the currency sign and its own decimals', () => {
    expect(formatFiat(1250, 'USD')).toMatch(/12\.50/);
    expect(formatFiat(1000, 'JPY')).toMatch(/1,000$/);
    expect(formatFiat(1000, 'JPY')).not.toMatch(/\./);
  });
});

describe('bitcoin price', () => {
  function sources(answers: Record<string, () => Response>) {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetcher = async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      const hit = answers[url];
      if (!hit) throw new TypeError('Failed to fetch');
      return hit();
    };
    return { seen, fetcher };
  }

  it('reads the first source and keeps only known currencies with real prices', async () => {
    const { seen, fetcher } = sources({
      [COINBASE]: () =>
        json({ data: { rates: { USD: '58183.24', JPY: '9261596.9', DOGE: '1', EUR: '-4', GBP: 'x' } } }),
    });
    const rates = await fetchRates(fetcher, 1000);
    expect(rates).toEqual({
      at: 1000,
      source: 'Coinbase',
      perBitcoin: { USD: 58183.24, JPY: 9261596.9 },
    });
    expect(seen).toHaveLength(1);
  });

  it('sends nothing about the register with the request', async () => {
    const { seen, fetcher } = sources({ [COINBASE]: () => json({ data: { rates: { USD: '1' } } }) });
    await fetchRates(fetcher);
    expect(seen[0].url).toBe(COINBASE);
    expect(seen[0].init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(seen[0].init?.headers).toBeUndefined();
    expect(seen[0].init?.body).toBeUndefined();
  });

  it('falls back to the second source when the first fails or is empty', async () => {
    for (const first of [() => json({}, 500), () => json({ data: { rates: {} } }), undefined]) {
      const { fetcher } = sources({
        ...(first ? { [COINBASE]: first } : {}),
        [BLOCKCHAIN]: () => json({ USD: { last: 58163.16 }, EUR: { last: 53000 } }),
      });
      const rates = await fetchRates(fetcher, 5);
      expect(rates.source).toBe('Blockchain.com');
      expect(rates.perBitcoin).toEqual({ USD: 58163.16, EUR: 53000 });
    }
  });

  it('rejects when no source answers', async () => {
    await expect(fetchRates(sources({}).fetcher)).rejects.toThrow();
  });

  it('refuses a missing, old or future-dated price', () => {
    const rates = { at: 1_000_000, source: 'x', perBitcoin: { USD: 50_000 } };
    expect(usableRate(rates, 'USD', 1_000_000)).toBe(50_000);
    expect(usableRate(rates, 'USD', 1_000_000 + STALE_MS)).toBe(50_000);
    expect(usableRate(rates, 'USD', 1_000_000 + STALE_MS + 1)).toBeNull();
    expect(usableRate(rates, 'USD', 1_000_000 - 120_000)).toBeNull();
    expect(usableRate(rates, 'EUR', 1_000_000)).toBeNull();
    expect(usableRate(null, 'USD')).toBeNull();
  });
});

describe('the currency setting in the register state', () => {
  const state = (patch: Partial<RegisterState>): RegisterState => ({ ...emptyState('m'), ...patch });

  it('is absent in a register saved before it existed, and survives a round trip', () => {
    expect(parseState(JSON.stringify(emptyState('m')), 'm').settings).toBeUndefined();
    const set = state({ settings: { fiat: 'EUR', at: 5 } });
    expect(parseState(JSON.stringify(set), 'm').settings).toEqual({ fiat: 'EUR', at: 5 });
  });

  it('the later change wins on both devices, including turning fiat off', () => {
    const eur = state({ settings: { fiat: 'EUR', at: 5 } });
    const off = state({ settings: { fiat: null, at: 9 } });
    const untouched = state({});
    expect(merge(eur, off).settings).toEqual({ fiat: null, at: 9 });
    expect(merge(off, eur).settings).toEqual({ fiat: null, at: 9 });
    expect(merge(eur, untouched).settings).toEqual({ fiat: 'EUR', at: 5 });
    expect(merge(untouched, eur).settings).toEqual({ fiat: 'EUR', at: 5 });
    expect(merge(untouched, untouched).settings).toBeUndefined();
    expect(sameState(merge(eur, off), merge(off, eur))).toBe(true);
    const tie = state({ settings: { fiat: 'JPY', at: 5 } });
    expect(merge(eur, tie)).toEqual(merge(tie, eur));
  });

  it('keeps what a sale was rung up as', () => {
    const sale = {
      id: 'q',
      amount: 25_000,
      memo: '',
      request: 'ln',
      createdAt: 1,
      expiry: null,
      status: 'paid' as const,
      fiat: { currency: 'USD', amount: 1250, perBitcoin: 50_000 },
    };
    const merged = merge(state({ sales: [sale] }), state({ sales: [{ ...sale, status: 'pending' }] }));
    expect(merged.sales[0]).toEqual(sale);
  });
});
