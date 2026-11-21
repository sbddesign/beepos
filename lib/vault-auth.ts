import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { schnorr } from '@noble/curves/secp256k1.js';

// The vault server never sees a passkey. A request proves it comes from the
// account by a schnorr signature from a key derived from the passkey.
// Header: `Authorization: Beepos <accountId>:<unix seconds>:<signature>`

const enc = new TextEncoder();
export const MAX_SKEW_SECONDS = 300;

function digest(method: string, accountId: string, timestamp: number, body: string): Uint8Array {
  const bodyHash = bytesToHex(sha256(enc.encode(body)));
  return sha256(
    enc.encode(`beepos-vault-v1\n${method.toUpperCase()}\n${accountId}\n${timestamp}\n${bodyHash}`),
  );
}

export function signRequest(
  authPrivkey: Uint8Array,
  method: string,
  body: string,
  now = Date.now(),
): string {
  const accountId = bytesToHex(schnorr.getPublicKey(authPrivkey));
  const timestamp = Math.floor(now / 1000);
  const sig = schnorr.sign(digest(method, accountId, timestamp, body), authPrivkey);
  return `Beepos ${accountId}:${timestamp}:${bytesToHex(sig)}`;
}

/** Returns the account id when the header is a valid, fresh signature; else null. */
export function verifyRequest(
  header: string | null,
  method: string,
  body: string,
  now = Date.now(),
): string | null {
  const m = /^Beepos ([0-9a-f]{64}):(\d{1,12}):([0-9a-f]{128})$/.exec(header ?? '');
  if (!m) return null;
  const [, accountId, ts, sig] = m;
  const timestamp = Number(ts);
  if (Math.abs(now / 1000 - timestamp) > MAX_SKEW_SECONDS) return null;
  try {
    const ok = schnorr.verify(
      hexToBytes(sig),
      digest(method, accountId, timestamp, body),
      hexToBytes(accountId),
    );
    return ok ? accountId : null;
  } catch {
    return null;
  }
}
