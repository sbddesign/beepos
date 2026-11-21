import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { entropyToMnemonic, mnemonicToSeedSync } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

const enc = new TextEncoder();

function derive(prf: Uint8Array, label: string, length: number): Uint8Array {
  return hkdf(sha256, prf, undefined, enc.encode(`beepos/v1/${label}`), length);
}

export type RegisterKeys = {
  /** 12 words. Restores the ecash in any NUT-13 wallet if the passkey is lost. */
  mnemonic: string;
  /** 64-byte BIP-39 seed: the Cashu wallet seed (NUT-13). */
  walletSeed: Uint8Array;
  /** Account id on the vault server: x-only schnorr pubkey, hex. */
  accountId: string;
  authPrivkey: Uint8Array;
  /** AES-256-GCM key for the vault blob. Never leaves the browser. */
  vaultKey: Uint8Array;
  /** NUT-20 key: mint quotes are locked to it so only this register can mint them. */
  quotePrivkey: string;
  quotePubkey: string;
};

/** Everything the register needs, from the 32 bytes the passkey's PRF returns. */
export function deriveKeys(prf: Uint8Array): RegisterKeys {
  if (prf.length !== 32) throw new Error('PRF output must be 32 bytes');
  const mnemonic = entropyToMnemonic(derive(prf, 'mnemonic', 16), wordlist);
  const authPrivkey = derive(prf, 'auth', 32);
  const quotePriv = derive(prf, 'quote', 32);
  return {
    mnemonic,
    walletSeed: mnemonicToSeedSync(mnemonic),
    accountId: bytesToHex(schnorr.getPublicKey(authPrivkey)),
    authPrivkey,
    vaultKey: derive(prf, 'vault', 32),
    quotePrivkey: bytesToHex(quotePriv),
    quotePubkey: bytesToHex(secp256k1.getPublicKey(quotePriv, true)),
  };
}
