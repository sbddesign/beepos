// The register's whole state. It is encrypted and stored as one blob, locally
// and on the vault server. Two devices can edit it at once, so every change
// must survive `merge`.

import type { SerializedDLEQ } from '@cashu/cashu-ts';
import type { Presets } from './presets';

export type StoredProof = {
  id: string;
  amount: number;
  secret: string;
  C: string;
  dleq?: SerializedDLEQ;
};

export type SaleStatus = 'pending' | 'expired' | 'paid';

export type Sale = {
  /** Mint quote id. */
  id: string;
  amount: number;
  memo: string;
  /** BOLT11 invoice. */
  request: string;
  createdAt: number;
  /** Unix seconds, from the mint. */
  expiry: number | null;
  status: SaleStatus;
  paidAt?: number;
  /** Set when the sale was rung up in fiat: what was typed and the price used. */
  fiat?: SaleFiat;
};

export type SaleFiat = {
  /** ISO 4217 code. */
  currency: string;
  /** In the currency's smallest unit (cents for USD). */
  amount: number;
  /** Price of one whole bitcoin in that currency when the invoice was made. */
  perBitcoin: number;
};

/** Per-register settings. They follow the passkey to every device. */
export type Settings = {
  /** Currency the keypad takes, or null for bitcoin only. */
  fiat: string | null;
  /** When it was last changed; the later change wins a merge. */
  at: number;
};

export type CashoutStatus = 'out' | 'claimed' | 'reclaimed';

export type Cashout = {
  id: string;
  amount: number;
  createdAt: number;
  /** cashuB token. Bearer money until someone redeems it. */
  token: string;
  status: CashoutStatus;
  /**
   * Secrets of the ecash inside the token. While the token is out they are never
   * spendable here, whatever `spent` has forgotten. Absent on older records.
   */
  secrets?: string[];
};

export type PayoutStatus = 'pending' | 'failed' | 'paid';

/** A cash-out paid over Lightning by the mint (a melt, NUT-05). */
export type Payout = {
  /** Melt quote id. */
  id: string;
  method: 'bolt11' | 'bolt12';
  /** What the owner entered: a Lightning address, or the start of an invoice or offer. */
  to: string;
  /** Amount the recipient gets. */
  amount: number;
  /** The most the mint may keep for routing. Unused reserve comes back as change. */
  feeReserve: number;
  createdAt: number;
  /** Unix seconds, from the mint. */
  expiry: number;
  status: PayoutStatus;
  /**
   * Ecash set aside for this payment. Out of `proofs` so nothing else spends it,
   * kept here so it returns to the register if the payment fails. Empty once settled.
   */
  inputs: StoredProof[];
  /** What it cost on top of `amount`, when known. */
  fee?: number;
  paidAt?: number;
  /**
   * Set when the payment is known to be paid but its change (the unused fee
   * reserve) has not been fetched from the mint yet. Cleared once it has.
   */
  changeDue?: boolean;
};

export type RegisterState = {
  v: 1;
  mintUrl: string;
  /** Next deterministic counter per keyset (NUT-13). */
  counters: Record<string, number>;
  proofs: StoredProof[];
  /** Secrets that left the wallet. Stops a merge from bringing them back. */
  spent: string[];
  sales: Sale[];
  cashouts: Cashout[];
  payouts: Payout[];
  /** Absent until the owner changes a setting; the defaults apply. */
  settings?: Settings;
  /** Saved items for the keypad. Absent until the owner adds one. */
  presets?: Presets;
};

const MAX_SPENT = 5000;
const MAX_HISTORY = 500;

export function emptyState(mintUrl: string): RegisterState {
  return { v: 1, mintUrl, counters: {}, proofs: [], spent: [], sales: [], cashouts: [], payouts: [] };
}

export function balance(state: RegisterState): number {
  return state.proofs.reduce((sum, p) => sum + p.amount, 0);
}

const SALE_RANK: Record<SaleStatus, number> = { pending: 0, expired: 1, paid: 2 };
const CASHOUT_RANK: Record<CashoutStatus, number> = { out: 0, claimed: 1, reclaimed: 2 };
const PAYOUT_RANK: Record<PayoutStatus, number> = { pending: 0, failed: 1, paid: 2 };

function mergeById<T extends { id: string; createdAt: number }>(
  a: T[],
  b: T[],
  pick: (x: T, y: T) => T,
): T[] {
  const byId = new Map<string, T>();
  for (const item of [...a, ...b]) {
    const seen = byId.get(item.id);
    byId.set(item.id, seen ? pick(seen, item) : item);
  }
  return [...byId.values()].sort((x, y) => x.createdAt - y.createdAt).slice(-MAX_HISTORY);
}

/** Secrets of ecash set aside for Lightning cash-outs that have not ended. Not spendable. */
export function reserved(payouts: Payout[]): Set<string> {
  return new Set(
    payouts.filter((p) => p.status === 'pending').flatMap((p) => p.inputs.map((i) => i.secret)),
  );
}

/** Secrets of ecash handed out in a cash-out token nobody has redeemed yet. Not spendable. */
export function outstanding(cashouts: Cashout[]): Set<string> {
  return new Set(cashouts.filter((c) => c.status === 'out').flatMap((c) => c.secrets ?? []));
}

/** Combines two copies of the state. Commutative, and merge(a, a) equals a. */
export function merge(a: RegisterState, b: RegisterState): RegisterState {
  // Sorted before the cap is applied, so both devices forget the same secrets.
  const spent = [...new Set([...a.spent, ...b.spent])].sort().slice(-MAX_SPENT);
  const gone = new Set(spent);
  // Payouts first: ecash a pending payout holds must not come back as spendable
  // from a copy that predates the payout.
  const payouts = mergeById(a.payouts, b.payouts, (x, y) => {
    if (PAYOUT_RANK[y.status] !== PAYOUT_RANK[x.status]) {
      return PAYOUT_RANK[y.status] > PAYOUT_RANK[x.status] ? y : x;
    }
    // Same outcome on both: the copy that has already fetched its change wins,
    // whichever order the two are merged in.
    return !!x.changeDue === !!y.changeDue ? x : x.changeDue ? y : x;
  });
  const cashouts = mergeById(a.cashouts, b.cashouts, (x, y) =>
    CASHOUT_RANK[y.status] > CASHOUT_RANK[x.status] ? y : x,
  );
  const held = new Set([...reserved(payouts), ...outstanding(cashouts)]);
  const proofs = new Map<string, StoredProof>();
  for (const p of [...a.proofs, ...b.proofs]) {
    if (!gone.has(p.secret) && !held.has(p.secret)) proofs.set(p.secret, p);
  }
  const counters: Record<string, number> = { ...a.counters };
  for (const [id, n] of Object.entries(b.counters)) {
    counters[id] = Math.max(counters[id] ?? 0, n);
  }
  const settings = [a.settings, b.settings]
    .filter((s): s is Settings => !!s)
    .sort((x, y) => y.at - x.at || (String(x.fiat) < String(y.fiat) ? -1 : 1))[0];
  // The list is replaced whole; the later change wins, with a fixed order for a tie.
  const presets = [a.presets, b.presets]
    .filter((p): p is Presets => !!p)
    .sort((x, y) => y.at - x.at || (JSON.stringify(x.items) < JSON.stringify(y.items) ? -1 : 1))[0];
  return {
    v: 1,
    mintUrl: a.mintUrl,
    ...(settings ? { settings } : {}),
    ...(presets ? { presets } : {}),
    counters,
    proofs: [...proofs.values()].sort((x, y) => (x.secret < y.secret ? -1 : 1)),
    spent,
    sales: mergeById(a.sales, b.sales, (x, y) =>
      SALE_RANK[y.status] > SALE_RANK[x.status] ? y : x,
    ),
    cashouts,
    payouts,
  };
}

export function sameState(a: RegisterState, b: RegisterState): boolean {
  return JSON.stringify(merge(a, a)) === JSON.stringify(merge(b, b));
}

export function parseState(json: string, mintUrl: string): RegisterState {
  const raw = JSON.parse(json) as Partial<RegisterState>;
  if (raw.v !== 1) throw new Error('Unknown vault version');
  return { ...emptyState(mintUrl), ...raw, mintUrl: raw.mintUrl ?? mintUrl };
}
