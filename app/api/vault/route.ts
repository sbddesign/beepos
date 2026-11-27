import { NextResponse } from 'next/server';
import { verifyRequest } from '@/lib/vault-auth';
import { ACCOUNT_LIMIT, IP_LIMIT, WINDOW_SECONDS, clientAddress, readCapped } from '@/lib/vault-limit';
import { getRateLimiter, getVaultStore } from '@/lib/vault-store';

export const dynamic = 'force-dynamic';

const MAX_BLOB_CHARS = 512 * 1024;

// The request body is JSON around the blob; anything longer is refused unread.
const MAX_BODY_BYTES = MAX_BLOB_CHARS + 200;

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
}

function slowDown() {
  return json({ error: 'Too many requests' }, 429, { 'Retry-After': String(WINDOW_SECONDS) });
}

/** By address, before any signature work. */
function addressAllowed(req: Request) {
  return getRateLimiter().hit(`ip:${clientAddress(req.headers)}`, IP_LIMIT);
}

/** By account, once the signature has shown whose request it is. */
function accountAllowed(accountId: string) {
  return getRateLimiter().hit(`account:${accountId}`, ACCOUNT_LIMIT);
}

export async function GET(req: Request) {
  const store = getVaultStore();
  if (!store) return json({ error: 'Vault storage is not configured' }, 503);
  if (!(await addressAllowed(req))) return slowDown();
  const accountId = verifyRequest(req.headers.get('authorization'), 'GET', '');
  if (!accountId) return json({ error: 'Bad signature' }, 401);
  if (!(await accountAllowed(accountId))) return slowDown();
  const record = await store.get(accountId);
  return json(record ?? { version: 0, blob: null });
}

export async function PUT(req: Request) {
  const store = getVaultStore();
  if (!store) return json({ error: 'Vault storage is not configured' }, 503);
  if (!(await addressAllowed(req))) return slowDown();
  const body = await readCapped(req, MAX_BODY_BYTES);
  if (body === null) return json({ error: 'Vault too large' }, 413);
  const accountId = verifyRequest(req.headers.get('authorization'), 'PUT', body);
  if (!accountId) return json({ error: 'Bad signature' }, 401);
  if (!(await accountAllowed(accountId))) return slowDown();

  let parsed: { baseVersion?: unknown; blob?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: 'Bad JSON' }, 400);
  }
  const { baseVersion, blob } = parsed;
  if (
    typeof baseVersion !== 'number' ||
    !Number.isInteger(baseVersion) ||
    baseVersion < 0 ||
    typeof blob !== 'string' ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(blob) ||
    blob.length > MAX_BLOB_CHARS
  ) {
    return json({ error: 'Bad request' }, 400);
  }

  const result = await store.put(accountId, baseVersion, blob);
  if (!result.ok) {
    return json({ error: 'Version conflict', ...(result.current ?? { version: 0, blob: null }) }, 409);
  }
  return json({ version: result.version });
}
