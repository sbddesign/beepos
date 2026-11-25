// LNURL-pay (LUD-06) and Lightning addresses (LUD-16): ask the recipient's
// server for an invoice of a chosen amount. Runs in the browser, so the
// recipient's host must allow cross-origin requests; when it does not, the
// owner is told to paste an invoice instead. Nothing about the register is sent.

import { invoiceMsat } from './destination';

export class LnurlError extends Error {}

const TIMEOUT_MS = 10_000;
const BLOCKED =
  'Could not reach that Lightning address from the browser. Ask for a Lightning invoice and paste that instead.';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

async function getJson(url: string, fetcher: FetchLike): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetcher(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  } catch {
    // The browser does not say why: a CORS refusal, no network and a timeout look alike.
    throw new LnurlError(BLOCKED);
  }
  if (res.status === 404) throw new LnurlError('That Lightning address does not exist.');
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new LnurlError('That Lightning address did not give a usable answer.');
  }
  if (!body || typeof body !== 'object') {
    throw new LnurlError('That Lightning address did not give a usable answer.');
  }
  const data = body as Record<string, unknown>;
  if (data.status === 'ERROR') {
    const reason = typeof data.reason === 'string' ? data.reason.slice(0, 200) : 'no reason given';
    throw new LnurlError(`The recipient's service refused: ${reason}`);
  }
  if (!res.ok) throw new LnurlError('That Lightning address did not give a usable answer.');
  return data;
}

/** Gets a BOLT11 invoice for exactly `amount` (sats) from an LNURL-pay endpoint. */
export async function lnurlInvoice(
  url: string,
  amount: number,
  fetcher: FetchLike = fetch,
): Promise<string> {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new LnurlError('Enter an amount.');
  const info = await getJson(url, fetcher);
  const min = Number(info.minSendable);
  const max = Number(info.maxSendable);
  if (info.tag !== 'payRequest' || typeof info.callback !== 'string' || !(min > 0) || !(max >= min)) {
    throw new LnurlError('That is not a Lightning address that can be paid.');
  }
  const msat = amount * 1000;
  if (msat < min || msat > max) {
    throw new LnurlError(
      `This recipient takes between ${Math.ceil(min / 1000)} and ${Math.floor(max / 1000)} per payment.`,
    );
  }
  let callback: URL;
  try {
    callback = new URL(info.callback);
  } catch {
    throw new LnurlError('That is not a Lightning address that can be paid.');
  }
  if (callback.protocol !== 'https:') {
    throw new LnurlError('That is not a Lightning address that can be paid.');
  }
  callback.searchParams.set('amount', String(msat));

  const answer = await getJson(callback.toString(), fetcher);
  const invoice = typeof answer.pr === 'string' ? answer.pr.trim().toLowerCase() : '';
  let invoiced: bigint | null = null;
  try {
    invoiced = invoiceMsat(invoice);
  } catch {
    // Handled below with the amount check.
  }
  // The recipient's server picks the invoice. Never pay one for a different amount.
  if (invoiced !== BigInt(msat)) {
    throw new LnurlError('The recipient returned an invoice for a different amount. Nothing was paid.');
  }
  return invoice;
}
