// The register's whole state. It is encrypted and stored as one blob, locally
// and on the vault server. Two devices can edit it at once, so every change
// must survive `merge`.

import type { SerializedDLEQ } from '@cashu/cashu-ts';

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
};

export type CashoutStatus = 'out' | 'claimed' | 'reclaimed';

export type Cashout = {
  id: string;
  amount: number;
  createdAt: number;
  /** cashuB token. Bearer money until someone redeems it. */
  token: string;
  status: CashoutStatus;
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

/** Combines two copies of the state. Commutative, and merge(a, a) equals a. */
export function merge(a: RegisterState, b: RegisterState): RegisterState {
  const spent = [...new Set([...a.spent, ...b.spent])].slice(-MAX_SPENT);
  const gone = new Set(spent);
  // Payouts first: ecash a pending payout holds must not come back as spendable
  // from a copy that predates the payout.
  const payouts = mergeById(a.payouts, b.payouts, (x, y) =>
    PAYOUT_RANK[y.status] > PAYOUT_RANK[x.status] ? y : x,
  );
  const held = reserved(payouts);
  const proofs = new Map<string, StoredProof>();
  for (const p of [...a.proofs, ...b.proofs]) {
    if (!gone.has(p.secret) && !held.has(p.secret)) proofs.set(p.secret, p);
  }
  const counters: Record<string, number> = { ...a.counters };
  for (const [id, n] of Object.entries(b.counters)) {
    counters[id] = Math.max(counters[id] ?? 0, n);
  }
  return {
    v: 1,
    mintUrl: a.mintUrl,
    counters,
    proofs: [...proofs.values()].sort((x, y) => (x.secret < y.secret ? -1 : 1)),
    spent: spent.sort(),
    sales: mergeById(a.sales, b.sales, (x, y) =>
      SALE_RANK[y.status] > SALE_RANK[x.status] ? y : x,
    ),
    cashouts: mergeById(a.cashouts, b.cashouts, (x, y) =>
      CASHOUT_RANK[y.status] > CASHOUT_RANK[x.status] ? y : x,
    ),
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
