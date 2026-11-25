// Ringing up in local currency. The bitcoin price comes from a public API with
// no key; the request is the same for every register and carries nothing about
// this one (no credentials, no referrer, no amounts).

/** Currencies both price sources quote. USD first: it is the default. */
export const CURRENCIES = [
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'MXN', 'BRL', 'ARS', 'CLP', 'PEN',
  'INR', 'KRW', 'PHP', 'THB', 'SGD', 'HKD', 'TWD', 'MYR', 'NGN', 'GHS', 'ZAR', 'TRY',
  'SEK', 'DKK', 'PLN', 'CZK', 'HUF', 'RON',
] as const;
export type Currency = (typeof CURRENCIES)[number];
export const DEFAULT_CURRENCY: Currency = 'USD';

export function isCurrency(code: unknown): code is Currency {
  return typeof code === 'string' && (CURRENCIES as readonly string[]).includes(code);
}

/** Price of one whole bitcoin (100,000,000 base units) in each currency, and when it was fetched. */
export type Rates = { at: number; source: string; perBitcoin: Partial<Record<Currency, number>> };

/** Refetch after this long. */
export const FRESH_MS = 60_000;
/** Refuse to price a sale with a rate older than this. */
export const STALE_MS = 10 * 60_000;
const TIMEOUT_MS = 8_000;
const UNITS_PER_BITCOIN = 100_000_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Decimal places the currency is written with: 2 for USD, 0 for JPY. */
export function decimals(code: Currency): number {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).resolvedOptions()
    .maximumFractionDigits ?? 2;
}

/** Formats an amount held in the currency's smallest unit (cents for USD, yen for JPY). */
export function formatFiat(minor: number, code: Currency): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(
    minor / 10 ** decimals(code),
  );
}

/**
 * Bitcoin base units for a fiat amount in its smallest unit, at `perBitcoin`.
 * Rounded to the nearest unit; at least 1 for any amount above zero.
 */
export function toBitcoin(minor: number, code: Currency, perBitcoin: number): number {
  if (!(minor > 0) || !(perBitcoin > 0)) return 0;
  const units = (minor / 10 ** decimals(code) / perBitcoin) * UNITS_PER_BITCOIN;
  return Math.max(1, Math.round(units));
}

function keep(source: string, at: number, pairs: Iterable<[string, unknown]>): Rates {
  const perBitcoin: Rates['perBitcoin'] = {};
  for (const [code, value] of pairs) {
    const n = Number(value);
    if (isCurrency(code) && Number.isFinite(n) && n > 0) perBitcoin[code] = n;
  }
  if (!Object.keys(perBitcoin).length) throw new Error(`No prices from ${source}`);
  return { at, source, perBitcoin };
}

async function getJson(url: string, fetcher: FetchLike): Promise<unknown> {
  const res = await fetcher(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`Price source answered ${res.status}`);
  return res.json();
}

const SOURCES: { name: string; load(fetcher: FetchLike, now: number): Promise<Rates> }[] = [
  {
    name: 'Coinbase',
    async load(fetcher, now) {
      const body = (await getJson(
        'https://api.coinbase.com/v2/exchange-rates?currency=BTC',
        fetcher,
      )) as { data?: { rates?: Record<string, unknown> } };
      return keep('Coinbase', now, Object.entries(body.data?.rates ?? {}));
    },
  },
  {
    name: 'Blockchain.com',
    async load(fetcher, now) {
      const body = (await getJson('https://blockchain.info/ticker', fetcher)) as Record<
        string,
        { last?: unknown }
      >;
      return keep(
        'Blockchain.com',
        now,
        Object.entries(body ?? {}).map(([code, v]) => [code, v?.last] as [string, unknown]),
      );
    },
  },
];

/** Fetches prices from the first source that answers. Rejects when none does. */
export async function fetchRates(fetcher: FetchLike = fetch, now = Date.now()): Promise<Rates> {
  let last: unknown;
  for (const source of SOURCES) {
    try {
      return await source.load(fetcher, now);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('No price source answered');
}

/** The price to use for `code` right now, or null when there is none fresh enough. */
export function usableRate(rates: Rates | null, code: Currency, now = Date.now()): number | null {
  if (!rates || now - rates.at > STALE_MS || now < rates.at - 60_000) return null;
  return rates.perBitcoin[code] ?? null;
}
