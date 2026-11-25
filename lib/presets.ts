// Saved items: things the owner charges for often, each with a name and a price.
// One tap on the keypad fills the amount and the memo. They live in the encrypted
// register state, so the list is kept short.

import { decimals, isCurrency, type Currency } from './fiat';

/** How many items a register keeps. */
export const MAX_PRESETS = 12;
export const MAX_PRESET_NAME = 40;
/** The keypad takes at most this many digits, so a price cannot be longer. */
const MAX_AMOUNT = 999_999_999;

export type Preset = {
  id: string;
  /** Shown on the keypad and used as the sale's memo. */
  name: string;
  /** Currency the price is in, or null for bitcoin. */
  currency: Currency | null;
  /** In the currency's smallest unit (cents for USD), or bitcoin base units. */
  amount: number;
};

/** The whole list, replaced as one. The later change wins a merge. */
export type Presets = { at: number; items: Preset[] };

/** Keeps only well-formed items, at most MAX_PRESETS. Anything else in the blob is dropped. */
export function cleanPresets(items: unknown): Preset[] {
  if (!Array.isArray(items)) return [];
  const out: Preset[] = [];
  const seen = new Set<string>();
  for (const raw of items as Partial<Preset>[]) {
    if (out.length >= MAX_PRESETS) break;
    if (!raw || typeof raw.id !== 'string' || !raw.id || seen.has(raw.id)) continue;
    const name = typeof raw.name === 'string' ? raw.name.trim().slice(0, MAX_PRESET_NAME) : '';
    const currency = raw.currency == null ? null : isCurrency(raw.currency) ? raw.currency : undefined;
    const amount = raw.amount;
    if (!name || currency === undefined) continue;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 1 || amount > MAX_AMOUNT) continue;
    seen.add(raw.id);
    out.push({ id: raw.id, name, currency, amount });
  }
  return out;
}

/**
 * Reads a typed price. Fiat takes the currency's decimals ("4.50", "4,5", "4");
 * bitcoin takes whole units. Returns the smallest-unit amount, or null when it
 * is not a price.
 */
export function parsePrice(text: string, currency: Currency | null): number | null {
  const places = currency ? decimals(currency) : 0;
  const match = /^(\d{1,9})(?:[.,](\d*))?$/.exec(text.trim());
  if (!match) return null;
  const fraction = match[2] ?? '';
  if (fraction.length > places) return null;
  const amount = Number(match[1]) * 10 ** places + Number(fraction.padEnd(places, '0') || '0');
  return amount >= 1 && amount <= MAX_AMOUNT ? amount : null;
}

/** The price as the owner would type it, for the edit form. */
export function priceText(preset: Preset): string {
  const places = preset.currency ? decimals(preset.currency) : 0;
  return places ? (preset.amount / 10 ** places).toFixed(places) : String(preset.amount);
}
