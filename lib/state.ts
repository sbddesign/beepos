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
};

const MAX_SPENT = 5000;
const MAX_HISTORY = 500;

export function emptyState(mintUrl: string): RegisterState {
  return { v: 1, mintUrl, counters: {}, proofs: [], spent: [], sales: [], cashouts: [] };
}

export function balance(state: RegisterState): number {
  return state.proofs.reduce((sum, p) => sum + p.amount, 0);
}

const SALE_RANK: Record<SaleStatus, number> = { pending: 0, expired: 1, paid: 2 };
const CASHOUT_RANK: Record<CashoutStatus, number> = { out: 0, claimed: 1, reclaimed: 2 };

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

/** Combines two copies of the state. Commutative, and merge(a, a) equals a. */
export function merge(a: RegisterState, b: RegisterState): RegisterState {
  const spent = [...new Set([...a.spent, ...b.spent])].slice(-MAX_SPENT);
  const gone = new Set(spent);
  const proofs = new Map<string, StoredProof>();
  for (const p of [...a.proofs, ...b.proofs]) {
    if (!gone.has(p.secret)) proofs.set(p.secret, p);
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
