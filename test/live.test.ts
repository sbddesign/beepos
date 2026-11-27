import { describe, expect, it } from 'vitest';
import { parseDestination } from '@/lib/destination';
import { deriveKeys } from '@/lib/keys';
import { approve } from '@/lib/reauth';
import { Register, type RegisterEnv } from '@/lib/register';
import { verifyRequest } from '@/lib/vault-auth';
import { balance, merge, parseState } from '@/lib/state';
import { open, seal } from '@/lib/vault-crypto';
import { MemoryVaultStore } from '@/lib/vault-store';

// Talks to a real test mint (fake Lightning: invoices pay themselves).
// Run with BEEPOS_LIVE=1 npm test.
const MINT = process.env.BEEPOS_TEST_MINT ?? 'https://testnut.cashu.space';

function device(store: MemoryVaultStore | null): RegisterEnv {
  const local = new Map<string, string>();
  return {
    loadLocal: (id) => local.get(id) ?? null,
    saveLocal: (id, v) => void local.set(id, v),
    async vault(method, authorization, body) {
      if (!store) return { status: 503, body: { version: 0, blob: null } };
      const accountId = verifyRequest(authorization, method, body);
      if (!accountId) return { status: 401, body: { version: 0, blob: null } };
      if (method === 'GET') {
        return { status: 200, body: (await store.get(accountId)) ?? { version: 0, blob: null } };
      }
      const { baseVersion, blob } = JSON.parse(body);
      const res = await store.put(accountId, baseVersion, blob);
      return res.ok
        ? { status: 200, body: { version: res.version, blob: null } }
        : { status: 409, body: res.current ?? { version: 0, blob: null } };
    },
  };
}

async function untilPaid(register: Register, id: string) {
  for (let i = 0; i < 30; i++) {
    // The UI polls the same way: a failed attempt is retried on the next tick.
    const sale = await register.settle(id).catch(() => null);
    if (sale?.status === 'paid') return sale;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('invoice was never paid');
}

describe.runIf(process.env.BEEPOS_LIVE === '1')('register against a live mint', () => {
  it('sells, syncs to a second device, cashes out, and recovers from the seed alone', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeys(prf);
    const passkey = async () => prf;
    const server = new MemoryVaultStore();

    const till = await Register.open(keys, MINT, device(server));
    expect(till.sync).toBe('synced');
    const sale = await till.charge(21, 'Flat white');
    expect(sale.request).toMatch(/^ln/);
    expect((await untilPaid(till, sale.id)).status).toBe('paid');
    expect(till.balance).toBe(21);
    await till.flush();

    // A second device has nothing but the passkey.
    const phone = await Register.open(keys, MINT, device(server));
    expect(phone.balance).toBe(21);
    expect(phone.state.sales[0]).toMatchObject({ memo: 'Flat white', status: 'paid' });

    // Both devices sell at once; neither loses the other's sale.
    const [a, b] = await Promise.all([till.charge(8, 'a'), phone.charge(4, 'b')]);
    await Promise.all([untilPaid(till, a.id), untilPaid(phone, b.id)]);
    await till.flush();
    await phone.flush();
    await till.pull();
    await till.flush();
    await phone.pull();
    expect(till.balance).toBe(33);
    expect(phone.balance).toBe(33);

    // Cash out needs a passkey approval, and each approval works once.
    const approval = await approve(keys, passkey);
    const cashout = await phone.cashOut(5, approval);
    await expect(phone.cashOut(5, approval)).rejects.toThrow('Confirm with your passkey');
    expect(cashout.token).toMatch(/^cashuB/);
    expect(cashout.amount).toBe(5);
    // The test mint charges a swap fee; Minibits does not.
    const afterCashout = phone.balance;
    expect(afterCashout).toBeLessThanOrEqual(28);
    expect(afterCashout).toBeGreaterThanOrEqual(26);
    expect(phone.state.cashouts).toHaveLength(1);
    await phone.flush();
    await till.pull();
    expect(till.balance).toBe(afterCashout);

    // Disaster: no local data and no server. Only the seed and the mint.
    const fresh = await Register.open(keys, MINT, device(null));
    expect(fresh.sync).toBe('local');
    expect(fresh.balance).toBe(0);
    // The unredeemed cash-out token is still ours, so the mint returns it too.
    expect(await fresh.recover()).toBe(afterCashout + 5);

    await phone.reclaim(cashout.id);
    expect(phone.balance).toBeGreaterThanOrEqual(afterCashout + 4);
    expect(phone.state.cashouts[0].status).toBe('reclaimed');
    // Recovering again on the phone finds nothing new and loses nothing.
    const settled = phone.balance;
    expect(await phone.recover()).toBe(settled);
  }, 240_000);

  it('cashes out over Lightning and gets the unused fee reserve back', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeys(prf);
    const passkey = async () => prf;
    const server = new MemoryVaultStore();
    const till = await Register.open(keys, MINT, device(server));
    const sale = await till.charge(200, '');
    await untilPaid(till, sale.id);
    expect(till.balance).toBe(200);

    // Someone else's invoice: another register on the same test mint.
    const other = await Register.open(
      deriveKeys(crypto.getRandomValues(new Uint8Array(32))),
      MINT,
      device(null),
    );
    const bill = await other.charge(50, '');
    const to = parseDestination(bill.request)!;
    expect(to).toMatchObject({ kind: 'bolt11', amount: 50 });

    const quote = await till.quotePayout(to);
    expect(quote.amount).toBe(50);
    expect(quote.left).toBe(200 - 50 - quote.feeReserve);
    expect(till.balance).toBe(200); // a quote moves nothing

    // No approval, no payment.
    await expect(till.payOut(quote, { accountId: keys.accountId })).rejects.toThrow(
      'Confirm with your passkey',
    );
    expect(till.balance).toBe(200);
    expect(till.state.payouts).toHaveLength(0);

    const paid = await till.payOut(quote, await approve(keys, passkey));
    expect(paid).toMatchObject({ status: 'paid', amount: 50, inputs: [] });
    expect(paid.fee).toBeGreaterThanOrEqual(0);
    expect(paid.fee).toBeLessThanOrEqual(quote.feeReserve + 2);
    // Everything not paid or charged as a fee is still in the register.
    expect(till.balance).toBeGreaterThanOrEqual(quote.left - 4); // the test mint's swap fees
    expect(till.balance).toBeLessThanOrEqual(150);
    console.log('payout', { feeReserve: quote.feeReserve, fee: paid.fee, balance: till.balance });

    // The same quote cannot be paid twice.
    await expect(till.payOut(quote, await approve(keys, passkey))).rejects.toThrow('already started');

    // A second device sees the payment and the same balance; the seed alone agrees.
    await till.flush();
    const phone = await Register.open(keys, MINT, device(server));
    expect(phone.balance).toBe(till.balance);
    expect(phone.state.payouts[0]).toMatchObject({ id: quote.id, status: 'paid' });
    const fresh = await Register.open(keys, MINT, device(null));
    expect(await fresh.recover()).toBe(till.balance);
  }, 240_000);

  it('gives the ecash back when a Lightning cash-out was set aside but never paid', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeys(prf);
    const server = new MemoryVaultStore();
    const till = await Register.open(keys, MINT, device(server));
    const sale = await till.charge(100, '');
    await untilPaid(till, sale.id);
    const other = await Register.open(
      deriveKeys(crypto.getRandomValues(new Uint8Array(32))),
      MINT,
      device(null),
    );
    const quote = await till.quotePayout(parseDestination((await other.charge(40, '')).request)!);

    // The tab dies after the ecash is set aside and before the mint is asked to pay.
    const melt = till.wallet.meltProofsBolt11.bind(till.wallet);
    let reached = false;
    till.wallet.meltProofsBolt11 = async () => {
      reached = true;
      return new Promise(() => {});
    };
    void till.payOut(quote, await approve(keys, async () => prf));
    for (let i = 0; i < 100 && !reached; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    await till.flush();
    expect(till.state.payouts[0].status).toBe('pending');
    const during = till.balance;
    expect(during).toBeLessThanOrEqual(100 - 40 - quote.feeReserve);
    till.wallet.meltProofsBolt11 = melt;

    // Reopened on another device. The mint says unpaid, but the first device may
    // still be about to ask, so the ecash stays set aside: through a settle, a
    // restore from the seed, and a merge with the server copy.
    const phone = await Register.open(keys, MINT, device(server));
    expect(phone.balance).toBe(during);
    await phone.settlePayouts();
    expect(phone.state.payouts[0].status).toBe('pending');
    expect(await phone.recover()).toBe(during);
    await phone.pull();
    expect(phone.balance).toBe(during);

    // Once the quote has run out nobody can pay it any more, and the ecash returns.
    phone.state = {
      ...phone.state,
      payouts: phone.state.payouts.map((p) => ({ ...p, expiry: Math.floor(Date.now() / 1000) - 600 })),
    };
    await phone.settlePayouts();
    expect(phone.state.payouts[0]).toMatchObject({ status: 'failed', inputs: [] });
    expect(phone.balance).toBeGreaterThanOrEqual(96); // 100 less the test mint's swap fee
    const fresh = await Register.open(keys, MINT, device(null));
    expect(await fresh.recover()).toBe(phone.balance);
  }, 240_000);

  it('pays a BOLT12 offer on a mint that supports them', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeys(prf);
    const till = await Register.open(keys, MINT, device(null));
    if (!till.paysOffers) return;
    await untilPaid(till, (await till.charge(100, '')).id);
    const other = await Register.open(
      deriveKeys(crypto.getRandomValues(new Uint8Array(32))),
      MINT,
      device(null),
    );
    const offer = await other.wallet.createMintQuoteBolt12(other.keys.quotePubkey, { amount: 30 });
    const to = parseDestination(offer.request)!;
    expect(to.kind).toBe('bolt12');
    const quote = await till.quotePayout(to, 30);
    expect(quote).toMatchObject({ method: 'bolt12', amount: 30 });
    const paid = await till.payOut(quote, await approve(keys, async () => prf));
    expect(paid.status).toBe('paid');
    expect(till.balance).toBeLessThanOrEqual(70);
    expect(till.balance).toBeGreaterThanOrEqual(70 - quote.feeReserve - 4);
  }, 240_000);

  it('a check that runs while the payment is being sent does not write it off', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeys(prf);
    const server = new MemoryVaultStore();
    const till = await Register.open(keys, MINT, device(server));
    await untilPaid(till, (await till.charge(100, '')).id);
    const other = await Register.open(
      deriveKeys(crypto.getRandomValues(new Uint8Array(32))),
      MINT,
      device(null),
    );
    const quote = await till.quotePayout(parseDestination((await other.charge(40, '')).request)!);

    // Just before the mint is asked: this tab's timer and a second device both look.
    const melt = till.wallet.meltProofsBolt11.bind(till.wallet);
    let phone!: Register;
    till.wallet.meltProofsBolt11 = async (...args) => {
      await till.settlePayouts();
      phone = await Register.open(keys, MINT, device(server));
      await phone.settlePayouts();
      await phone.recover();
      await phone.flush();
      expect(phone.state.payouts[0].status).toBe('pending');
      return melt(...args);
    };
    const paid = await till.payOut(quote, await approve(keys, async () => prf));
    expect(paid.status).toBe('paid');
    // After the mint has paid, the second device (still holding "pending") asks and agrees.
    await phone.settlePayouts();
    expect(phone.state.payouts[0]).toMatchObject({ status: 'paid', inputs: [] });
    await till.flush();
    await phone.pull();
    await phone.flush();
    await till.pull();
    expect(till.state.payouts[0].status).toBe('paid');
    expect(phone.balance).toBe(till.balance);
    const fresh = await Register.open(keys, MINT, device(null));
    expect(await fresh.recover()).toBe(till.balance);
  }, 240_000);

  it('an unredeemed cash-out token is not counted again after recovery or sync (#17)', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeys(prf);
    const server = new MemoryVaultStore();
    const till = await Register.open(keys, MINT, device(server));
    await untilPaid(till, (await till.charge(64, '')).id);
    const stale = JSON.parse(JSON.stringify(till.state));
    const cashout = await till.cashOut(20, await approve(keys, async () => prf));
    expect(cashout.status).toBe('out');
    const after = till.balance;
    expect(after).toBeLessThanOrEqual(44);
    await till.flush();

    // Recover from the mint on the device that made the token.
    expect(await till.recover()).toBe(after);
    // A second device that opens from the vault, then recovers.
    const phone = await Register.open(keys, MINT, device(server));
    expect(phone.balance).toBe(after);
    expect(await phone.recover()).toBe(after);
    await phone.pull();
    expect(phone.balance).toBe(after);
    // A copy of the state from before the cash-out, merged back in.
    expect(balance(merge(till.state, stale))).toBe(after);
    expect(balance(merge(stale, till.state))).toBe(after);

    // Taking it back still works.
    await phone.reclaim(cashout.id);
    expect(phone.balance).toBeGreaterThanOrEqual(after + 18);
  }, 240_000);

  it('never writes over a server copy it could not read (#16)', async () => {
    const keys = deriveKeys(crypto.getRandomValues(new Uint8Array(32)));
    const server = new MemoryVaultStore();
    const env = device(server);
    const till = await Register.open(keys, MINT, env);
    await till.charge(5, 'first');
    await till.flush();
    expect(till.sync).toBe('synced');
    const mine = (await server.get(keys.accountId))!;

    // The server now holds something this build cannot read: a newer format, or damage.
    for (const foreign of [
      await seal(keys.vaultKey, JSON.stringify({ v: 2, future: true })),
      'not a vault blob',
    ]) {
      const base = (await server.get(keys.accountId))!.version;
      expect((await server.put(keys.accountId, base, foreign)).ok).toBe(true);
      const theirs = (await server.get(keys.accountId))!;

      // Three rounds of changes and syncs. None may replace it.
      for (const memo of ['a', 'b', 'c']) {
        await till.charge(5, memo);
        await till.flush();
        await till.pull();
        await till.flush();
        expect(await server.get(keys.accountId)).toEqual(theirs);
        expect(till.sync).toBe('unreadable');
      }
    }
    expect(mine.version).toBeLessThan((await server.get(keys.accountId))!.version);

    // The local encrypted copy still has every sale, and reopens.
    const saved = JSON.parse(env.loadLocal(keys.accountId)!);
    const local = parseState(await open(keys.vaultKey, saved.blob), MINT);
    expect(local.sales.map((x) => x.memo)).toEqual(['first', 'a', 'b', 'c', 'a', 'b', 'c']);
    const again = await Register.open(keys, MINT, env);
    expect(again.state.sales).toHaveLength(7);
    expect(again.sync).toBe('unreadable');

    // A plain network failure is still just "offline", and a readable copy clears it.
    const down = { ...env, vault: async () => Promise.reject(new TypeError('Failed to fetch')) };
    expect((await Register.open(keys, MINT, down)).sync).toBe('offline');
    const base = (await server.get(keys.accountId))!.version;
    await server.put(keys.accountId, base, saved.blob);
    await again.pull();
    await again.flush();
    expect(again.sync).toBe('synced');
  }, 240_000);

  it('a write that overlaps a read never drops what the server had (#16)', async () => {
    const keys = deriveKeys(crypto.getRandomValues(new Uint8Array(32)));
    const server = new MemoryVaultStore();
    const sales = async () => {
      const rec = await server.get(keys.accountId);
      return rec?.blob ? parseState(await open(keys.vaultKey, rec.blob), MINT).sales.map((x) => x.memo) : [];
    };

    // The till's connection: a hook runs when a read's answer arrives, before the
    // register sees it, and every accepted write is checked against what it replaced.
    const inner = device(server);
    let onRead: (() => void) | null = null;
    const dropped: string[][] = [];
    const env: typeof inner = {
      ...inner,
      async vault(method, authorization, body) {
        const before = method === 'PUT' ? await sales() : [];
        const res = await inner.vault(method, authorization, body);
        if (method === 'PUT' && res.status === 200) {
          const after = await sales();
          const lost = before.filter((m) => !after.includes(m));
          if (lost.length) dropped.push(lost);
        }
        if (method === 'GET') onRead?.();
        return res;
      },
    };
    const till = await Register.open(keys, MINT, env);
    await till.charge(5, 'till');
    await till.flush();
    const phone = await Register.open(keys, MINT, device(server));

    for (let round = 0; round < 5; round++) {
      await phone.charge(5, `phone ${round}`);
      await phone.flush();
      // The till changes something at the instant its read comes back.
      onRead = () => {
        onRead = null;
        till.setFiat(round % 2 ? 'EUR' : null);
      };
      await till.pull();
      await till.flush();
      await phone.pull();
      await phone.flush();
    }
    expect(dropped).toEqual([]);
    expect(await sales()).toHaveLength(6);
    expect(till.state.sales).toHaveLength(6);
    expect(till.sync).toBe('synced');
  }, 240_000);

  it('saves on this device while a read from the server is stalled (#16)', async () => {
    const keys = deriveKeys(crypto.getRandomValues(new Uint8Array(32)));
    const inner = device(new MemoryVaultStore());
    let stall: Promise<void> | null = null;
    const env: typeof inner = {
      ...inner,
      async vault(method, authorization, body) {
        if (method === 'GET' && stall) await stall;
        return inner.vault(method, authorization, body);
      },
    };
    const till = await Register.open(keys, MINT, env);
    await till.flush();
    const savedMemos = async () => {
      const saved = env.loadLocal(keys.accountId);
      if (!saved) return [];
      return parseState(await open(keys.vaultKey, JSON.parse(saved).blob), MINT).sales.map((x) => x.memo);
    };

    let release!: () => void;
    stall = new Promise((r) => (release = r));
    const reading = till.pull();
    await till.charge(5, 'during the stall');
    // The sale has to reach local storage without the read ever finishing.
    for (let i = 0; i < 40 && !(await savedMemos()).length; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(await savedMemos()).toEqual(['during the stall']);
    // A register opened from that local copy alone has the sale.
    const offline: typeof inner = { ...inner, vault: async () => ({ status: 503, body: { version: 0, blob: null } }) };
    expect((await Register.open(keys, MINT, offline)).state.sales).toHaveLength(1);

    release();
    stall = null;
    await reading;
    await till.flush();
    expect(till.sync).toBe('synced');
  }, 240_000);

  it('does not pay out when the record of it could be saved nowhere (#16)', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeys(prf);
    const inner = device(new MemoryVaultStore());
    let diskFull = false;
    let serverDown = false;
    const env: typeof inner = {
      ...inner,
      saveLocal(id, value) {
        if (diskFull) throw new Error('QuotaExceededError');
        inner.saveLocal(id, value);
      },
      async vault(method, authorization, body) {
        if (serverDown) throw new TypeError('Failed to fetch');
        return inner.vault(method, authorization, body);
      },
    };
    const till = await Register.open(keys, MINT, env);
    await untilPaid(till, (await till.charge(100, '')).id);
    await till.flush();
    const other = await Register.open(
      deriveKeys(crypto.getRandomValues(new Uint8Array(32))),
      MINT,
      device(null),
    );
    const bill = async () => parseDestination((await other.charge(30, '')).request)!;
    const melt = till.wallet.meltProofsBolt11.bind(till.wallet);
    let asked = 0;
    till.wallet.meltProofsBolt11 = async (...args) => {
      asked++;
      return melt(...args);
    };

    // Nowhere to save: refused before the mint is asked, and the ecash is back.
    diskFull = serverDown = true;
    const quote = await till.quotePayout(await bill());
    const before = till.state;
    await expect(till.payOut(quote, await approve(keys, async () => prf))).rejects.toThrow(
      'nothing was paid',
    );
    expect(asked).toBe(0);
    expect(till.state.payouts).toHaveLength(0);
    expect(till.state).toBe(before); // no swap, no ecash moved
    expect(till.balance).toBe(100);

    // The server alone is enough.
    serverDown = false;
    const paid = await till.payOut(await till.quotePayout(await bill()), await approve(keys, async () => prf));
    expect(paid.status).toBe('paid');
    expect(asked).toBe(1);
  }, 240_000);

  it('fetches the change later when the mint could not be reached right after paying (#18)', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const keys = deriveKeys(prf);
    const server = new MemoryVaultStore();
    const till = await Register.open(keys, MINT, device(server));
    await untilPaid(till, (await till.charge(100, '')).id);
    const other = await Register.open(
      deriveKeys(crypto.getRandomValues(new Uint8Array(32))),
      MINT,
      device(null),
    );
    const quote = await till.quotePayout(parseDestination((await other.charge(40, '')).request)!);

    // The mint pays, but its answer is lost; and when the register then asks how it
    // ended, the restore that would bring the change back fails too.
    const melt = till.wallet.meltProofsBolt11.bind(till.wallet);
    till.wallet.meltProofsBolt11 = async (...args) => {
      await melt(...args);
      throw new TypeError('Failed to fetch');
    };
    const restore = till.wallet.batchRestore.bind(till.wallet);
    let down = true;
    till.wallet.batchRestore = async (...args) => {
      if (down) throw new TypeError('Failed to fetch');
      return restore(...args);
    };
    // With the answer lost, the payout waits for the next check.
    const sent = await till.payOut(quote, await approve(keys, async () => prf));
    expect(sent.status).toBe('pending');
    await till.settlePayouts();
    expect(till.state.payouts[0]).toMatchObject({ status: 'paid', changeDue: true, inputs: [] });
    const without = till.balance;

    // Still unreachable: it stays owed. Another device is told so too.
    await till.settlePayouts();
    expect(till.state.payouts[0].changeDue).toBe(true);
    await till.flush();
    down = false;
    const phone = await Register.open(keys, MINT, device(server));
    expect(phone.state.payouts[0].changeDue).toBe(true);

    // What the seed alone says the register holds.
    const truth = await (await Register.open(keys, MINT, device(null))).recover();
    expect(truth).toBeGreaterThanOrEqual(without);

    // The next settle, here on the other device, fetches it and clears the mark.
    await phone.settlePayouts();
    expect(phone.state.payouts[0].changeDue).toBe(false);
    expect(phone.balance).toBe(truth);
    await phone.flush();
    await till.pull();
    expect(till.state.payouts[0].changeDue).toBe(false);
    expect(till.balance).toBe(truth);
    console.log('change retry', { without, truth, reserve: quote.feeReserve });
  }, 240_000);
});
