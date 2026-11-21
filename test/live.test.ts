import { describe, expect, it } from 'vitest';
import { deriveKeys } from '@/lib/keys';
import { Register, type RegisterEnv } from '@/lib/register';
import { verifyRequest } from '@/lib/vault-auth';
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
    const keys = deriveKeys(crypto.getRandomValues(new Uint8Array(32)));
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

    const cashout = await phone.cashOut(5);
    expect(cashout.token).toMatch(/^cashuB/);
    expect(cashout.amount).toBe(5);
    // The test mint charges a swap fee; Minibits does not.
    const afterCashout = phone.balance;
    expect(afterCashout).toBeLessThanOrEqual(28);
    expect(afterCashout).toBeGreaterThanOrEqual(26);
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
});
