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

// What to try, said after every message for a passkey that could not be made or
// used, so no failure leaves the owner without a next step. Android hands passkeys
// to whichever manager is chosen in Settings; a phone without Google Play has none
// until one is installed and chosen (issue #45).
const NEXT_STEP =
  'On Android, choose a passkey manager such as Proton Pass or 1Password under Settings › Passwords, passkeys & accounts, then try again. Or open beepos on an iPhone, iPad or computer.';

const NO_ANSWER = `No passkey came back. If nothing asked you for one, this browser has no passkey manager it can use. ${NEXT_STEP}`;
// Chrome is not named: on a phone without Google Play it fails the way Brave does.
const UNSUPPORTED =
  'This browser cannot use passkeys on this device. Try another browser. On GrapheneOS or another Android phone without Google Play, use Vanadium, with a passkey manager such as Proton Pass or 1Password chosen under Settings › Passwords, passkeys & accounts.';
const BROKEN = `This browser could not reach a passkey manager. ${NEXT_STEP}`;
/** For a browser that takes the request and then never answers it. */
export const NO_PROMPT = `Nothing asking for your passkey? This browser may have no passkey manager it can use. ${NEXT_STEP}`;
const WRONG_PLACE = 'Passkeys do not work at this address. Open beepos at its own address, over https.';

/**
 * Turns whatever the browser threw into words for the owner. Browsers word these
 * themselves ("Not implemented", "An unknown error occurred while talking to the
 * credential manager"), so the browser's own text goes to the console and never
 * to the screen.
 */
function wrap(err: unknown, signal?: AbortSignal): PasskeyError {
  if (err instanceof PasskeyError) return err;
  const name = (err as { name?: string })?.name;
  // Our own signal closed the prompt: the owner left the view.
  if (name === 'AbortError' && signal?.aborted) {
    return new PasskeyError('cancelled', 'Passkey prompt was closed.');
  }
  console.warn('passkey:', name, (err as Error)?.message);
  // Browsers answer NotAllowedError (Firefox on Android: AbortError) for a prompt
  // the owner closed and also when they had nobody to ask, and do not say which.
  if (name === 'NotAllowedError' || name === 'AbortError') {
    return new PasskeyError('cancelled', NO_ANSWER);
  }
  if (name === 'NotSupportedError') return new PasskeyError('unsupported', UNSUPPORTED);
  if (name === 'SecurityError') return new PasskeyError('failed', WRONG_PLACE);
  return new PasskeyError('failed', BROKEN);
}

function assertSupported() {
  if (
    typeof window === 'undefined' ||
    !window.PublicKeyCredential ||
    !navigator.credentials?.create ||
    !navigator.credentials?.get
  ) {
    throw new PasskeyError('unsupported', UNSUPPORTED);
  }
}

const NO_PRF =
  'This passkey manager made a passkey that cannot open a register (it has no PRF support). Use iCloud Keychain, Google Password Manager, 1Password or Proton Pass on an up-to-date browser.';

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
    if (!cred) throw new PasskeyError('cancelled', NO_ANSWER);
    const first = prfOf(cred).results?.first;
    if (!first) throw new PasskeyError('no-prf', NO_PRF);
    return toBytes(first);
  } catch (err) {
    throw wrap(err, signal);
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
    if (!cred) throw new PasskeyError('cancelled', NO_ANSWER);
    const prf = prfOf(cred);
    if (prf.results?.first) return toBytes(prf.results.first);
    if (prf.enabled === false) throw new PasskeyError('no-prf', NO_PRF);
    // Some authenticators enable PRF at creation but only evaluate it on sign-in.
    return await unlock(new Uint8Array(cred.rawId));
  } catch (err) {
    throw wrap(err);
  }
}
