import {
  MeltQuoteState,
  MintOperationError,
  MintQuoteState,
  Wallet,
  getEncodedToken,
  type MeltQuoteBolt11Response,
  type Proof,
} from '@cashu/cashu-ts';
import type { Destination } from './destination';
import { lnurlInvoice } from './lnurl';
import { DEFAULT_CURRENCY, isCurrency, type Currency } from './fiat';
import type { RegisterKeys } from './keys';
import { redeem, type Approval } from './reauth';
import {
  balance,
  emptyState,
  merge,
  parseState,
  reserved,
  sameState,
  type Cashout,
  type Payout,
  type SaleFiat,
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

/** How long after a melt quote runs out before its ecash is released, in case a request is in flight. */
const PAYOUT_GRACE_SECONDS = 120;

/** What a Lightning cash-out will cost, from the mint, before anything is paid. */
export type PayoutQuote = {
  id: string;
  method: 'bolt11' | 'bolt12';
  to: string;
  /** Amount the recipient gets. */
  amount: number;
  /** The most the mint may keep for routing; what is not used comes back. */
  feeReserve: number;
  /** The least that stays in the register: balance - amount - feeReserve. */
  left: number;
  /** Unix seconds. */
  expiry: number;
  raw: MeltQuoteBolt11Response;
};

function short(text: string): string {
  return text.length > 24 ? `${text.slice(0, 14)}…${text.slice(-6)}` : text;
}

function total(proofs: { amount: number }[]): number {
  return proofs.reduce((sum, p) => sum + p.amount, 0);
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
  /** Lightning cash-outs this tab is asking the mint to pay right now. */
  private melting = new Set<string>();

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

  // ---- settings ---------------------------------------------------------

  /** Currency the keypad takes: a code from ./fiat, or null for bitcoin only. Default USD. */
  get fiat(): Currency | null {
    const set = this.state.settings;
    if (!set) return DEFAULT_CURRENCY;
    return isCurrency(set.fiat) ? set.fiat : null;
  }

  setFiat(fiat: Currency | null) {
    this.commit((s) => ({ ...s, settings: { fiat, at: Date.now() } }));
  }

  // ---- sales ------------------------------------------------------------

  /** Creates a Lightning invoice for `amount`. The quote is locked to this register (NUT-20). */
  async charge(amount: number, memo: string, fiat?: SaleFiat): Promise<Sale> {
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
      ...(fiat ? { fiat } : {}),
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
      // A restore also finds ecash set aside for a pending Lightning cash-out. It stays set aside.
      const held = reserved(s.payouts);
      return {
        ...s,
        spent: [...gone],
        proofs: dedupe([...s.proofs, ...found]).filter(
          (p) => !gone.has(p.secret) && !held.has(p.secret),
        ),
      };
    });
    return this.balance;
  }

  // ---- cash out ---------------------------------------------------------

  /**
   * Moves `amount` out of the register into a Cashu token any wallet can redeem.
   * Needs a fresh passkey approval (see ./reauth), which it uses up.
   */
  async cashOut(amount: number, approval: Approval): Promise<Cashout> {
    if (amount <= 0 || amount > this.balance) throw new Error('Not enough in the register');
    redeem(approval, this.keys);
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

  /** The 12 backup words. Needs a fresh passkey approval, which it uses up. */
  backupWords(approval: Approval): string {
    redeem(approval, this.keys);
    return this.keys.mnemonic;
  }

  /** An unredeemed cash-out token: bearer money, so it needs a fresh passkey approval. */
  cashoutToken(id: string, approval: Approval): Cashout {
    const cashout = this.state.cashouts.find((c) => c.id === id);
    if (!cashout) throw new Error('Unknown cash out');
    redeem(approval, this.keys);
    return cashout;
  }

  // ---- cash out over Lightning --------------------------------------------

  /** Whether the mint can pay BOLT12 offers. Minibits cannot (2026-11). */
  get paysOffers(): boolean {
    const methods = this.wallet.getMintInfo().cache.nuts?.['5']?.methods ?? [];
    return methods.some((m) => m.method === 'bolt12' && m.unit === 'sat');
  }

  /**
   * Asks the mint what paying `to` would cost. Nothing moves. `amount` is needed
   * for a Lightning address, and for an invoice or offer that leaves it open.
   */
  async quotePayout(to: Destination, amount?: number): Promise<PayoutQuote> {
    const open = amount != null ? amount * 1000 : undefined;
    const needAmount = () => {
      if (!amount || !Number.isSafeInteger(amount) || amount <= 0) throw new Error('Enter an amount.');
    };
    let raw: MeltQuoteBolt11Response;
    let method: PayoutQuote['method'] = 'bolt11';
    let label: string;
    if (to.kind === 'bolt12') {
      if (!this.paysOffers) throw new Error('This mint cannot pay BOLT12 offers yet. Use an invoice or a Lightning address.');
      method = 'bolt12';
      label = short(to.offer);
      try {
        // An offer that names its amount must be quoted without one.
        raw = await this.wallet.createMeltQuoteBolt12(to.offer);
        amount = undefined;
      } catch (err) {
        if (!(err instanceof MintOperationError) || open == null) throw err;
        raw = await this.wallet.createMeltQuoteBolt12(to.offer, open);
      }
    } else if (to.kind === 'lnurl') {
      needAmount();
      label = to.label;
      raw = await this.wallet.createMeltQuoteBolt11(await lnurlInvoice(to.url, amount!));
    } else if (to.amount == null) {
      needAmount();
      label = short(to.invoice);
      raw = await this.wallet.createMeltQuoteBolt11(to.invoice, open);
    } else {
      label = short(to.invoice);
      raw = await this.wallet.createMeltQuoteBolt11(to.invoice);
    }
    const quoted = raw.amount.toNumber();
    // The mint names the amount. It must be the one asked for, not more.
    const expected = to.kind === 'bolt11' && to.amount != null ? to.amount : amount;
    if (expected != null && quoted !== expected) {
      throw new Error('The mint quoted a different amount than asked. Nothing was paid.');
    }
    const feeReserve = raw.fee_reserve.toNumber();
    return {
      id: raw.quote,
      method,
      to: label,
      amount: quoted,
      feeReserve,
      left: this.balance - quoted - feeReserve,
      expiry: raw.expiry,
      raw,
    };
  }

  /**
   * Pays a quote over Lightning. Needs a fresh passkey approval, which it uses up.
   *
   * The ecash for the payment is set aside and saved before the mint is asked
   * to pay, so a crash or a lost connection at any point leaves either the
   * payment made or the ecash recoverable by `settlePayout`. It stays set aside
   * until the mint says paid, the mint refuses the payment to our face, or the
   * quote has run out and can no longer be paid.
   */
  async payOut(quote: PayoutQuote, approval: Approval): Promise<Payout> {
    const need = quote.amount + quote.feeReserve;
    if (quote.expiry * 1000 < Date.now()) throw new Error('That quote expired. Check the cost again.');
    if (need > this.balance) throw new Error('Not enough in the register for the amount and the fee reserve.');
    if (this.state.payouts.some((p) => p.id === quote.id)) throw new Error('That payment was already started.');
    redeem(approval, this.keys);

    // Swap for ecash worth exactly the amount, the reserve and the mint's input fee.
    const inputs = this.state.proofs;
    const { keep, send } = await this.wallet.send(need, inputs, { includeFees: true });
    const aside = send.map(toStored);
    const kept = keep.map(toStored).filter((p) => !aside.some((x) => x.secret === p.secret));
    const keptSecrets = new Set(kept.map((p) => p.secret));
    const asideSecrets = new Set(aside.map((p) => p.secret));
    const used = inputs.filter((p) => !keptSecrets.has(p.secret) && !asideSecrets.has(p.secret));
    const payout: Payout = {
      id: quote.id,
      method: quote.method,
      to: quote.to,
      amount: quote.amount,
      feeReserve: quote.feeReserve,
      createdAt: Date.now(),
      expiry: quote.expiry,
      status: 'pending',
      inputs: aside,
    };
    this.commit((s) => {
      const gone = new Set([...s.spent, ...used.map((p) => p.secret)]);
      return {
        ...s,
        spent: [...gone],
        proofs: dedupe([...s.proofs, ...kept]).filter(
          (p) => !gone.has(p.secret) && !asideSecrets.has(p.secret),
        ),
        payouts: [...s.payouts, payout],
      };
    });
    this.melting.add(quote.id);
    try {
      await this.flush();
      const res =
        quote.method === 'bolt12'
          ? await this.wallet.meltProofsBolt12(quote.raw, send)
          : await this.wallet.meltProofsBolt11(quote.raw, send);
      if (res.quote.state === MeltQuoteState.PAID) {
        return this.closePayout(quote.id, res.change, aside);
      }
    } catch (err) {
      // Only an answer from the mint itself ends the attempt. A lost connection does
      // not: the request may still arrive, so the ecash stays set aside.
      const refused = err instanceof MintOperationError;
      const settled = await this.resolvePayout(quote.id, refused, aside).catch(() => null);
      if (settled?.status === 'failed') {
        const why = err instanceof Error && err.message ? ` (${err.message})` : '';
        throw new Error(`The payment did not go through${why}. The money is back in the register.`);
      }
      if (settled) return settled;
    } finally {
      this.melting.delete(quote.id);
    }
    return this.state.payouts.find((p) => p.id === quote.id)!;
  }

  /**
   * Records that the mint paid. The mint's word is final: this also corrects a
   * record that some copy of the state had already written off as failed.
   */
  private closePayout(id: string, change: Proof[] | null, inputs?: StoredProof[]): Payout {
    const payout = this.state.payouts.find((p) => p.id === id)!;
    if (payout.status === 'paid') return payout;
    const used = inputs ?? payout.inputs;
    const back = (change ?? []).map(toStored);
    const fee = change && used.length ? total(used) - payout.amount - total(back) : undefined;
    this.commit((s) => {
      const gone = new Set([...s.spent, ...used.map((p) => p.secret)]);
      return {
        ...s,
        spent: [...gone],
        proofs: dedupe([...s.proofs, ...back]).filter((p) => !gone.has(p.secret)),
        payouts: s.payouts.map((p) =>
          p.id === id ? { ...p, status: 'paid', paidAt: Date.now(), inputs: [], fee } : p,
        ),
      };
    });
    return this.state.payouts.find((p) => p.id === id)!;
  }

  /**
   * Asks the mint how a pending Lightning cash-out ended. Paid: the change is
   * restored from the seed. Not paid: the ecash set aside returns to the register.
   */
  settlePayout(id: string): Promise<Payout> {
    return this.resolvePayout(id, false);
  }

  /**
   * `refused` is true only when the mint itself has just turned the payment down in
   * this tab. Otherwise "unpaid" may only mean "not asked yet": another tab or device
   * may be about to ask, so the ecash is released only after the quote has run out.
   */
  private async resolvePayout(id: string, refused: boolean, inputs?: StoredProof[]): Promise<Payout> {
    const payout = this.state.payouts.find((p) => p.id === id);
    if (!payout) throw new Error('Unknown payment');
    if (payout.status !== 'pending') return payout;
    if (this.melting.has(id) && !refused) return payout;
    const quote =
      payout.method === 'bolt12'
        ? await this.wallet.checkMeltQuoteBolt12(id)
        : await this.wallet.checkMeltQuoteBolt11(id);
    if (quote.state === MeltQuoteState.PAID) {
      const paid = this.closePayout(id, null, inputs);
      // The change was signed for outputs made from the seed, so a restore finds it.
      await this.recover().catch(() => {});
      return paid;
    }
    if (quote.state !== MeltQuoteState.UNPAID) return payout;
    const lapsed = (payout.expiry + PAYOUT_GRACE_SECONDS) * 1000 < Date.now();
    if (!refused && !lapsed) return payout;
    // Even then, "unpaid" is only acted on when the mint holds none of the ecash as
    // spent or in flight. Otherwise wait and ask again.
    if (payout.inputs.length) {
      const { unspent } = await this.wallet.groupProofsByState(payout.inputs);
      if (unspent.length !== payout.inputs.length) return payout;
    }
    this.commit((s) => ({
      ...s,
      proofs: dedupe([...s.proofs, ...payout.inputs]).filter((p) => !s.spent.includes(p.secret)),
      payouts: s.payouts.map((p) => (p.id === id ? { ...p, status: 'failed', inputs: [] } : p)),
    }));
    return this.state.payouts.find((p) => p.id === id)!;
  }

  /** Settles every pending Lightning cash-out. Errors on one do not stop the others. */
  async settlePayouts(): Promise<void> {
    const open = this.state.payouts.filter((p) => p.status === 'pending');
    await Promise.allSettled(open.map((p) => this.settlePayout(p.id)));
  }

  /** Takes an unredeemed cash-out token back into the register. Safe: no approval needed. */
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
