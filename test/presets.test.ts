import { describe, expect, it } from 'vitest';
import { MAX_PRESETS, cleanPresets, parsePrice, priceText, type Preset } from '@/lib/presets';
import { emptyState, merge, parseState, sameState, type RegisterState } from '@/lib/state';

const item = (id: string, patch: Partial<Preset> = {}): Preset => ({
  id,
  name: `Item ${id}`,
  currency: 'USD',
  amount: 450,
  ...patch,
});

describe('saved item prices', () => {
  it('reads a fiat price in the currency\'s own decimals', () => {
    expect(parsePrice('4.50', 'USD')).toBe(450);
    expect(parsePrice('4,5', 'USD')).toBe(450);
    expect(parsePrice('4', 'USD')).toBe(400);
    expect(parsePrice(' 0.05 ', 'USD')).toBe(5);
    expect(parsePrice('1000', 'JPY')).toBe(1000);
  });

  it('refuses what is not a price in that unit', () => {
    expect(parsePrice('4.505', 'USD')).toBeNull();
    expect(parsePrice('10.5', 'JPY')).toBeNull();
    expect(parsePrice('2100.5', null)).toBeNull();
    expect(parsePrice('0', 'USD')).toBeNull();
    expect(parsePrice('0.00', 'USD')).toBeNull();
    expect(parsePrice('', 'USD')).toBeNull();
    expect(parsePrice('-4', 'USD')).toBeNull();
    expect(parsePrice('1e3', null)).toBeNull();
    expect(parsePrice('$4', 'USD')).toBeNull();
    // More digits than the keypad can hold.
    expect(parsePrice('99999999.99', 'USD')).toBeNull();
    expect(parsePrice('1000000000', null)).toBeNull();
  });

  it('reads bitcoin as whole units and writes a price back as typed', () => {
    expect(parsePrice('2100', null)).toBe(2100);
    expect(priceText(item('a'))).toBe('4.50');
    expect(priceText(item('a', { currency: 'JPY', amount: 1000 }))).toBe('1000');
    expect(priceText(item('a', { currency: null, amount: 2100 }))).toBe('2100');
    expect(parsePrice(priceText(item('a', { amount: 5 })), 'USD')).toBe(5);
  });
});

describe('saved items in the register state', () => {
  it('drops anything malformed and keeps at most the cap', () => {
    expect(cleanPresets(undefined)).toEqual([]);
    expect(cleanPresets('nope')).toEqual([]);
    const good = item('a');
    expect(
      cleanPresets([
        good,
        null,
        item('a', { name: 'duplicate id' }),
        item('b', { name: '   ' }),
        item('c', { amount: 0 }),
        item('d', { amount: 1.5 }),
        item('e', { amount: 1_000_000_000 }),
        item('f', { currency: 'XXX' as never }),
        { ...item('g'), amount: '450' },
        item('h', { name: 'x'.repeat(200), currency: null }),
      ]),
    ).toEqual([good, item('h', { name: 'x'.repeat(40), currency: null })]);
    const many = Array.from({ length: 40 }, (_, i) => item(String(i)));
    expect(cleanPresets(many)).toHaveLength(MAX_PRESETS);
  });

  const state = (patch: Partial<RegisterState>): RegisterState => ({ ...emptyState('m'), ...patch });

  it('is absent in a register saved before it existed, and survives a round trip', () => {
    expect(parseState(JSON.stringify(emptyState('m')), 'm').presets).toBeUndefined();
    const set = state({ presets: { at: 5, items: [item('a')] } });
    expect(parseState(JSON.stringify(set), 'm').presets).toEqual({ at: 5, items: [item('a')] });
  });

  it('the later list wins on both devices, including an emptied one', () => {
    const two = state({ presets: { at: 5, items: [item('a'), item('b')] } });
    const none = state({ presets: { at: 9, items: [] } });
    const untouched = state({});
    expect(merge(two, none).presets).toEqual({ at: 9, items: [] });
    expect(merge(none, two).presets).toEqual({ at: 9, items: [] });
    expect(merge(two, untouched).presets).toEqual(two.presets);
    expect(merge(untouched, two).presets).toEqual(two.presets);
    expect(merge(untouched, untouched).presets).toBeUndefined();
    expect(sameState(merge(two, none), merge(none, two))).toBe(true);
    const tie = state({ presets: { at: 5, items: [item('c')] } });
    expect(merge(two, tie)).toEqual(merge(tie, two));
  });

  it('does not disturb the currency setting, and the currency does not disturb it', () => {
    const items = state({ presets: { at: 5, items: [item('a')] } });
    const yen = state({ settings: { fiat: 'JPY', at: 9 } });
    const merged = merge(items, yen);
    expect(merged.presets).toEqual(items.presets);
    expect(merged.settings).toEqual(yen.settings);
  });
});
