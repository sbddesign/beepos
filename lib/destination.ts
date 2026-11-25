// Where a Lightning cash-out can go: what the owner pastes or scans.

import { bech32 } from '@scure/base';

export type Destination =
  /** `amount` is in bitcoin's base unit (sats); null when the invoice leaves it open. */
  | { kind: 'bolt11'; invoice: string; amount: number | null }
  | { kind: 'bolt12'; offer: string }
  /** A Lightning address or an LNURL-pay link. `url` is always https. */
  | { kind: 'lnurl'; url: string; label: string };

const MSAT_PER: Record<string, bigint> = {
  '': 100_000_000_000n,
  m: 100_000_000n,
  u: 100_000n,
  n: 100n,
};

/** Amount in millisats from a BOLT11 invoice's prefix; null when it has none. */
export function invoiceMsat(invoice: string): bigint | null {
  const s = invoice.toLowerCase();
  const m = /^ln(?:bcrt|tbs|bc|tb)(?:(\d+)([munp]?))?$/.exec(s.slice(0, s.lastIndexOf('1')));
  if (!m) throw new Error('Not a Lightning invoice');
  if (!m[1]) return null;
  const n = BigInt(m[1]);
  if (m[2] === 'p') {
    if (n % 10n !== 0n) throw new Error('Invoice amount is not a whole millisat');
    return n / 10n;
  }
  return n * MSAT_PER[m[2]];
}

function httpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Recognises an invoice, an offer, a Lightning address or an LNURL. Null for anything else. */
export function parseDestination(input: string): Destination | null {
  const text = input.trim().replace(/^lightning:/i, '').trim();
  const lower = text.toLowerCase();
  if (!text || /\s/.test(text)) return null;

  if (/^ln(bcrt|tbs|bc|tb)\d*[munp]?1[02-9ac-hj-np-z]+$/.test(lower)) {
    try {
      const msat = invoiceMsat(lower);
      // Ecash here is whole sats, so an invoice for a fraction of one cannot be paid exactly.
      if (msat !== null && (msat === 0n || msat % 1000n !== 0n)) return null;
      return { kind: 'bolt11', invoice: lower, amount: msat === null ? null : Number(msat / 1000n) };
    } catch {
      return null;
    }
  }

  if (/^lno1[02-9ac-hj-np-z+]+$/.test(lower)) return { kind: 'bolt12', offer: lower };

  if (/^lnurl1[02-9ac-hj-np-z]+$/.test(lower)) {
    try {
      const url = httpsUrl(new TextDecoder().decode(bech32.decodeToBytes(lower, 2000).bytes));
      return url ? { kind: 'lnurl', url, label: new URL(url).hostname } : null;
    } catch {
      return null;
    }
  }

  const address = /^([a-z0-9._+-]{1,64})@([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/.exec(lower);
  if (address) {
    const url = httpsUrl(`https://${address[2]}/.well-known/lnurlp/${address[1]}`);
    return url ? { kind: 'lnurl', url, label: lower } : null;
  }
  return null;
}
