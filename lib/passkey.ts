// Passkey = the only credential. The WebAuthn PRF extension makes the passkey
// return the same 32 secret bytes every time, on every device it syncs to.
// No server takes part: the challenge is random and nothing verifies the
// assertion, because the PRF output itself is the proof.

const PRF_SALT = new TextEncoder().encode('beepos/v1/prf');

export class PasskeyError extends Error {
  constructor(
    public kind: 'unsupported' | 'no-prf' | 'cancelled' | 'failed' | 'wrong-passkey',
    message: string,
  ) {
    super(message);
  }
}

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };

function prfOf(cred: PublicKeyCredential): PrfResults {
  return (cred.getClientExtensionResults() as { prf?: PrfResults }).prf ?? {};
}

function toBytes(src: BufferSource): Uint8Array {
  return src instanceof ArrayBuffer
    ? new Uint8Array(src)
    : new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
}

function wrap(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new PasskeyError('cancelled', 'Passkey prompt was dismissed.');
  }
  return new PasskeyError('failed', (err as Error)?.message ?? 'Passkey failed.');
}

function assertSupported() {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) {
    throw new PasskeyError('unsupported', 'This browser does not support passkeys.');
  }
}

const NO_PRF =
  'This passkey provider cannot derive keys (no PRF support). Try iCloud Keychain, Google Password Manager, 1Password or Bitwarden on an up-to-date browser.';

/**
 * Unlocks with an existing passkey. Returns the 32-byte PRF secret.
 * Aborting `signal` closes the prompt and rejects as cancelled.
 */
export async function unlock(credentialId?: Uint8Array, signal?: AbortSignal): Promise<Uint8Array> {
  assertSupported();
  try {
    const cred = (await navigator.credentials.get({
      signal,
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId: location.hostname,
        userVerification: 'required',
        allowCredentials: credentialId
          ? [{ type: 'public-key', id: credentialId as BufferSource }]
          : [],
        extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError('cancelled', 'No passkey chosen.');
    const first = prfOf(cred).results?.first;
    if (!first) throw new PasskeyError('no-prf', NO_PRF);
    return toBytes(first);
  } catch (err) {
    throw wrap(err);
  }
}

/** Creates a new passkey, which is a new, empty register. */
export async function register(): Promise<Uint8Array> {
  assertSupported();
  try {
    const label = `Register ${new Date().toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })}`;
    const cred = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'beepos', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: label, displayName: label },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: { eval: { first: PRF_SALT } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null;
    if (!cred) throw new PasskeyError('cancelled', 'Passkey was not created.');
    const prf = prfOf(cred);
    if (prf.results?.first) return toBytes(prf.results.first);
    if (prf.enabled === false) throw new PasskeyError('no-prf', NO_PRF);
    // Some authenticators enable PRF at creation but only evaluate it on sign-in.
    return await unlock(new Uint8Array(cred.rawId));
  } catch (err) {
    throw wrap(err);
  }
}
