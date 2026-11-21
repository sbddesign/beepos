import { NextResponse } from 'next/server';
import { verifyRequest } from '@/lib/vault-auth';
import { getVaultStore } from '@/lib/vault-store';

export const dynamic = 'force-dynamic';

const MAX_BLOB_CHARS = 512 * 1024;

function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(req: Request) {
  const store = getVaultStore();
  if (!store) return json({ error: 'Vault storage is not configured' }, 503);
  const accountId = verifyRequest(req.headers.get('authorization'), 'GET', '');
  if (!accountId) return json({ error: 'Bad signature' }, 401);
  const record = await store.get(accountId);
  return json(record ?? { version: 0, blob: null });
}

export async function PUT(req: Request) {
  const store = getVaultStore();
  if (!store) return json({ error: 'Vault storage is not configured' }, 503);
  const body = await req.text();
  if (body.length > MAX_BLOB_CHARS + 200) return json({ error: 'Vault too large' }, 413);
  const accountId = verifyRequest(req.headers.get('authorization'), 'PUT', body);
  if (!accountId) return json({ error: 'Bad signature' }, 401);

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
