// Asking for the passkey again before money or the seed words leave the register.
//
// The prompt alone proves nothing: any passkey for this site would satisfy it.
// What counts is the PRF output. It must derive the same keys as the open
// register, so only the passkey that opened it passes.
//
// This is a gate in the browser, for the person who walks up to an unlocked
// terminal and taps buttons. It does not stop someone who can run code in the
// tab: the keys are already in memory while the register is open.

import { deriveKeys, type RegisterKeys } from './keys';
import { PasskeyError, unlock } from './passkey';

/** Proof of one fresh passkey check for one register. Good for a single use. */
export type Approval = { readonly accountId: string };

const unused = new WeakSet<Approval>();

/**
 * Runs the passkey ceremony (user verification required) and checks that the
 * passkey is the one this register was opened with. Rejects with a
 * PasskeyError when the prompt is dismissed or another passkey answers.
 */
export async function approve(
  keys: RegisterKeys,
  prompt: () => Promise<Uint8Array> = unlock,
): Promise<Approval> {
  const prf = await prompt();
  let same = false;
  try {
    same = deriveKeys(prf).accountId === keys.accountId;
  } catch {
    // A malformed PRF output is not this register's passkey.
  }
  if (!same) {
    throw new PasskeyError(
      'wrong-passkey',
      'That passkey belongs to a different register. Use the one this register was opened with.',
    );
  }
  const approval: Approval = Object.freeze({ accountId: keys.accountId });
  unused.add(approval);
  return approval;
}

/** Uses up an approval. Throws unless it is unused and was given for these keys. */
export function redeem(approval: Approval, keys: RegisterKeys): void {
  if (!unused.delete(approval) || approval.accountId !== keys.accountId) {
    throw new Error('Confirm with your passkey first.');
  }
}
