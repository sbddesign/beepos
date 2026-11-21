import {
  MintOperationError,
  MintQuoteState,
  Wallet,
  getEncodedToken,
  type Proof,
} from '@cashu/cashu-ts';
import type { RegisterKeys } from './keys';
import {
  balance,
  emptyState,
  merge,
  parseState,
  sameState,
  type Cashout,
  type RegisterState,
  type Sale,
  type StoredProof,
} from './state';
import { signRequest } from './vault-auth';
import { open, seal } from './vault-crypto';

/** 'local' = no vault server configured; the state lives in this browser only. */
export type SyncStatus = 'syncing' | 'synced' | 'offline' | 'local';

type VaultRecord = { version: number; blob: string | null };

/** Where the register keeps its encrypted blob. Injectable so tests can fake it. */
export type RegisterEnv = {
  loadLocal(accountId: string): string | null;
  saveLocal(accountId: string, value: string): void;
  /** Resolves with the HTTP status and parsed JSON body. */
  vault(method: 'GET' | 'PUT', authorization: string, body: string): Promise<{
    status: number;
    body: VaultRecord & { error?: string };
  }>;
};

// NUT error codes (https://github.com/cashubtc/nuts/blob/main/error_codes.md)
const OUTPUT_ALREADY_SIGNED = 10002;
const QUOTE_ALREADY_ISSUED = 20002;

function toStored(p: Proof): StoredProof {
  return { id: p.id, amount: p.amount.toNumber(), secret: p.secret, C: p.C, dleq: p.dleq };
}

function dedupe(proofs: StoredProof[]): StoredProof[] {
  return [...new Map(proofs.map((p) => [p.secret, p])).values()];
}

function isMintError(err: unknown, code: number): boolean {
  return err instanceof MintOperationError && err.code === code;
}

export class Register {
  state: RegisterState;
  sync: SyncStatus = 'syncing';
  private version = 0;
  private listeners = new Set<() => void>();
  private dirty = false;
  private pushing: Promise<void> | null = null;
  private settling = new Map<string, Promise<Sale>>();

  private constructor(
    readonly keys: RegisterKeys,
    readonly wallet: Wallet,
    private env: RegisterEnv,
    state: RegisterState,
  ) {
    this.state = state;
  }

  static async open(keys: RegisterKeys, mintUrl: string, env: RegisterEnv): Promise<Register> {
    let state = emptyState(mintUrl);
    let version = 0;
    const cached = env.loadLocal(keys.accountId);
    if (cached) {
      try {
        const rec = JSON.parse(cached) as { version: number; blob: string };
        state = parseState(await open(keys.vaultKey, rec.blob), mintUrl);
        version = rec.version;
      } catch {
        // An unreadable cache is dropped; the server copy and the mint can rebuild it.
      }
    }
    const wallet = new Wallet(mintUrl, {
      unit: 'sat',
      bip39seed: keys.walletSeed,
      counterInit: state.counters,
    });
    const register = new Register(keys, wallet, env, state);
    register.version = version;
    wallet.on.countersReserved(({ keysetId, next }) => {
      register.commit((s) => ({
        ...s,
        counters: { ...s.counters, [keysetId]: Math.max(s.counters[keysetId] ?? 0, next) },
      }));
    });
    await Promise.all([wallet.loadMint(), register.pull()]);
    await register.syncCounters();
    return register;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  get balance(): number {
    return balance(this.state);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  private setSync(status: SyncStatus) {
    if (this.sync !== status) {
      this.sync = status;
      this.notify();
    }
  }

  private commit(change: (s: RegisterState) => RegisterState) {
    this.state = change(this.state);
    this.notify();
    this.schedulePush();
  }

  private async syncCounters() {
    for (const [id, n] of Object.entries(this.state.counters)) {
      await this.wallet.counters.advanceToAtLeast(id, n);
    }
  }

  // ---- vault sync -------------------------------------------------------

  private schedulePush() {
    this.dirty = true;
    this.pushing ??= this.pushLoop().finally(() => {
      this.pushing = null;
    });
  }

  /** Resolves when every change made so far is stored (or the push failed). */
  async flush(): Promise<void> {
    while (this.pushing) await this.pushing;
  }

  private async pushLoop() {
    let attempts = 0;
    while (this.dirty && attempts++ < 8) {
      this.dirty = false;
      await this.pushOnce();
    }
  }

  private async pushOnce() {
    const snapshot = this.state;
    const blob = await seal(this.keys.vaultKey, JSON.stringify(snapshot));
    this.env.saveLocal(this.keys.accountId, JSON.stringify({ version: this.version, blob }));
    if (this.sync === 'local') return;
    const body = JSON.stringify({ baseVersion: this.version, blob });
    try {
      const res = await this.env.vault('PUT', signRequest(this.keys.authPrivkey, 'PUT', body), body);
      if (res.status === 200) {
        this.version = res.body.version;
        this.env.saveLocal(this.keys.accountId, JSON.stringify({ version: this.version, blob }));
        this.setSync('synced');
      } else if (res.status === 409) {
        await this.absorb(res.body);
        this.dirty = true;
      } else if (res.status === 503) {
        this.setSync('local');
      } else {
        this.setSync('offline');
      }
    } catch {
      this.setSync('offline');
    }
  }

  /** Merges a server record into the local state. */
  private async absorb(record: VaultRecord) {
    this.version = record.version;
    if (!record.blob) return;
    const remote = parseState(await open(this.keys.vaultKey, record.blob), this.state.mintUrl);
    const merged = merge(this.state, remote);
    if (!sameState(merged, this.state)) {
      this.state = merged;
      await this.syncCounters();
      this.notify();
    }
    if (!sameState(merged, remote)) this.dirty = true;
  }

  /** Fetches the server copy and merges it in. Safe to call any time. */
  async pull(): Promise<void> {
    try {
      const res = await this.env.vault('GET', signRequest(this.keys.authPrivkey, 'GET', ''), '');
      if (res.status === 503) return this.setSync('local');
      if (res.status !== 200) return this.setSync('offline');
      await this.absorb(res.body);
      const unsaved = !res.body.blob && !sameState(this.state, emptyState(this.state.mintUrl));
      if (this.dirty || unsaved) this.schedulePush();
      else this.setSync('synced');
    } catch {
      this.setSync('offline');
    }
  }

  // ---- sales ------------------------------------------------------------

  /** Creates a Lightning invoice for `amount`. The quote is locked to this register (NUT-20). */
  async charge(amount: number, memo: string): Promise<Sale> {
    const description = memo.trim() || undefined;
    let quote;
    try {
      quote = await this.wallet.createLockedMintQuote(amount, this.keys.quotePubkey, description);
    } catch (err) {
      if (!description || err instanceof MintOperationError) throw err;
      // A mint without invoice descriptions still gets the memo in our history.
      quote = await this.wallet.createLockedMintQuote(amount, this.keys.quotePubkey);
    }
    const sale: Sale = {
      id: quote.quote,
      amount,
      memo: memo.trim(),
      request: quote.request,
      createdAt: Date.now(),
      expiry: quote.expiry,
      status: 'pending',
    };
    this.commit((s) => ({ ...s, sales: [...s.sales, sale] }));
    return sale;
  }

  private updateSale(id: string, patch: Partial<Sale>, proofs: StoredProof[] = []) {
    this.commit((s) => ({
      ...s,
      proofs: [...s.proofs, ...proofs],
      sales: s.sales.map((sale) => (sale.id === id ? { ...sale, ...patch } : sale)),
    }));
    return this.state.sales.find((s) => s.id === id)!;
  }

  /** Asks the mint about one sale and mints the ecash once the invoice is paid. */
  settle(id: string): Promise<Sale> {
    let run = this.settling.get(id);
    if (!run) {
      run = this.settleOnce(id).finally(() => this.settling.delete(id));
      this.settling.set(id, run);
    }
    return run;
  }

  private async settleOnce(id: string): Promise<Sale> {
    const sale = this.state.sales.find((s) => s.id === id);
    if (!sale) throw new Error('Unknown sale');
    if (sale.status !== 'pending') return sale;

    const quote = await this.wallet.checkMintQuoteBolt11(id);
    if (quote.state === MintQuoteState.UNPAID) {
      const expired = sale.expiry != null && sale.expiry * 1000 < Date.now();
      return expired ? this.updateSale(id, { status: 'expired' }) : sale;
    }
    if (quote.state === MintQuoteState.PAID) {
      const mint = () =>
        this.wallet.mintProofsBolt11(sale.amount, quote, { privkey: this.keys.quotePrivkey });
      try {
        let proofs: Proof[];
        try {
          proofs = await mint();
        } catch (err) {
          if (!isMintError(err, OUTPUT_ALREADY_SIGNED)) throw err;
          // Our counter is behind (another device minted). Find the real one and retry.
          await this.recover();
          proofs = await mint();
        }
        return this.updateSale(id, { status: 'paid', paidAt: Date.now() }, proofs.map(toStored));
      } catch (err) {
        if (!isMintError(err, QUOTE_ALREADY_ISSUED)) throw err;
      }
    }
    // ISSUED: the ecash exists but this copy of the state may not have it
    // (crash after minting, or another device minted). The mint can replay it.
    await this.recover();
    return this.updateSale(id, { status: 'paid', paidAt: Date.now() });
  }

  /** Settles every open sale. Errors on one sale do not stop the others. */
  async settlePending(): Promise<void> {
    const open = this.state.sales.filter((s) => s.status === 'pending');
    await Promise.allSettled(open.map((s) => this.settle(s.id)));
  }

  // ---- recovery ---------------------------------------------------------

  /**
   * Rebuilds the ecash from the mint using only the seed (NUT-09 restore), and
   * drops proofs the mint says are spent. Returns the balance afterwards.
   */
  async recover(): Promise<number> {
    const restored: Proof[] = [];
    for (const keyset of this.wallet.keyChain.getKeysets()) {
      // Stop after 100 unused counters, asking for 100 at a time.
      const { proofs, lastCounterWithSignature } = await this.wallet.batchRestore(
        100,
        100,
        0,
        keyset.id,
      );
      restored.push(...proofs);
      if (lastCounterWithSignature != null) {
        const next = lastCounterWithSignature + 1;
        await this.wallet.counters.advanceToAtLeast(keyset.id, next);
        this.commit((s) => ({
          ...s,
          counters: { ...s.counters, [keyset.id]: Math.max(s.counters[keyset.id] ?? 0, next) },
        }));
      }
    }
    const found = restored.map(toStored);
    const candidates = dedupe([...this.state.proofs, ...found]);
    const { spent } = candidates.length
      ? await this.wallet.groupProofsByState(candidates)
      : { spent: [] as StoredProof[] };
    this.commit((s) => {
      const gone = new Set([...s.spent, ...spent.map((p) => p.secret)]);
      return {
        ...s,
        spent: [...gone],
        proofs: dedupe([...s.proofs, ...found]).filter((p) => !gone.has(p.secret)),
      };
    });
    return this.balance;
  }

  // ---- cash out ---------------------------------------------------------

  /** Moves `amount` out of the register into a Cashu token any wallet can redeem. */
  async cashOut(amount: number): Promise<Cashout> {
    if (amount <= 0 || amount > this.balance) throw new Error('Not enough in the register');
    const inputs = this.state.proofs;
    const { keep, send } = await this.wallet.send(amount, inputs);
    const sent = send.map(toStored);
    const cashout: Cashout = {
      id: crypto.randomUUID(),
      amount: sent.reduce((sum, p) => sum + p.amount, 0),
      createdAt: Date.now(),
      // Without the DLEQ proofs the token is about half the size, so its QR code scans.
      token: getEncodedToken(
        { mint: this.state.mintUrl, proofs: send, unit: 'sat' },
        { removeDleq: true },
      ),
      status: 'out',
    };
    // `keep` is the change plus every input the swap did not use.
    const kept = keep.map(toStored).filter((p) => !sent.some((x) => x.secret === p.secret));
    const keptSecrets = new Set(kept.map((p) => p.secret));
    const used = inputs.filter((p) => !keptSecrets.has(p.secret));
    this.commit((s) => {
      const gone = new Set([...s.spent, ...[...used, ...sent].map((p) => p.secret)]);
      return {
        ...s,
        spent: [...gone],
        proofs: dedupe([...s.proofs, ...kept]).filter((p) => !gone.has(p.secret)),
        cashouts: [...s.cashouts, cashout],
      };
    });
    return cashout;
  }

  /** Takes an unredeemed cash-out token back into the register. */
  async reclaim(id: string): Promise<void> {
    const cashout = this.state.cashouts.find((c) => c.id === id);
    if (!cashout || cashout.status !== 'out') return;
    const proofs = (await this.wallet.receive(cashout.token)).map(toStored);
    this.commit((s) => ({
      ...s,
      proofs: [...s.proofs, ...proofs],
      cashouts: s.cashouts.map((c) => (c.id === id ? { ...c, status: 'reclaimed' } : c)),
    }));
  }

  /** Marks cash-out tokens that somebody has redeemed. */
  async refreshCashouts(): Promise<void> {
    for (const cashout of this.state.cashouts.filter((c) => c.status === 'out')) {
      const { proofs } = this.wallet.decodeToken(cashout.token);
      const { spent } = await this.wallet.groupProofsByState(proofs);
      if (spent.length === proofs.length) {
        this.commit((s) => ({
          ...s,
          cashouts: s.cashouts.map((c) => (c.id === cashout.id ? { ...c, status: 'claimed' } : c)),
        }));
      }
    }
  }
}

/** The real environment: localStorage and the app's own /api/vault. */
export const browserEnv: RegisterEnv = {
  loadLocal: (accountId) => localStorage.getItem(`beepos:vault:${accountId}`),
  saveLocal: (accountId, value) => localStorage.setItem(`beepos:vault:${accountId}`, value),
  async vault(method, authorization, body) {
    const res = await fetch('/api/vault', {
      method,
      headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: method === 'PUT' ? body : undefined,
      cache: 'no-store',
    });
    return { status: res.status, body: await res.json() };
  },
};
