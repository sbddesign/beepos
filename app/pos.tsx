'use client';

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseDestination, type Destination } from '@/lib/destination';
import {
  CURRENCIES,
  FRESH_MS,
  decimals,
  fetchRates,
  formatFiat,
  isCurrency,
  toBitcoin,
  usableRate,
  type Currency,
  type Rates,
} from '@/lib/fiat';
import { formatBitcoin, timeAgo } from '@/lib/format';
import { deriveKeys } from '@/lib/keys';
import { PasskeyError, register as createPasskey, unlock } from '@/lib/passkey';
import {
  MAX_PRESETS,
  MAX_PRESET_NAME,
  parsePrice,
  priceText,
  type Preset,
} from '@/lib/presets';
import { approve } from '@/lib/reauth';
import { Register, browserEnv, type PayoutQuote } from '@/lib/register';
import type { Cashout, Payout, Sale } from '@/lib/state';
import { setMood } from './fx/liquid';
import { Qr } from './qr';

const SESSION_KEY = 'beepos:session';
const KNOWN_KEY = 'beepos:known';
const MAX_DIGITS = 9;

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Something went wrong.';
}

function beep() {
  try {
    const ctx = new AudioContext();
    [880, 1320].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, ctx.currentTime + i * 0.12);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.12 + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + i * 0.12);
      osc.stop(ctx.currentTime + i * 0.12 + 0.2);
    });
  } catch {
    // No sound is fine.
  }
}

// One copy of the prices for the whole page, so opening the drawer does not fetch again.
let lastRates: Rates | null = null;
let ratesInFlight: Promise<Rates | null> | null = null;

function loadRates(): Promise<Rates | null> {
  if (lastRates && Date.now() - lastRates.at < FRESH_MS) return Promise.resolve(lastRates);
  ratesInFlight ??= fetchRates()
    .then((rates) => (lastRates = rates))
    .catch(() => lastRates)
    .finally(() => {
      ratesInFlight = null;
    });
  return ratesInFlight;
}

/**
 * Bitcoin prices while a fiat currency is set, refreshed every minute the page is
 * visible. `loading` is true until the first answer or failure. Re-renders twice a
 * minute so an old price is noticed and its age reads right.
 */
function useRates(enabled: boolean): {
  rates: Rates | null;
  loading: boolean;
  refresh: () => void;
} {
  const [rates, setRates] = useState<Rates | null>(lastRates);
  const [loading, setLoading] = useState(enabled && !lastRates);
  const [, setTick] = useState(0);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(() => {
    void loadRates().then((next) => {
      if (!mounted.current) return;
      setRates(next);
      setLoading(false);
      setTick((n) => n + 1);
    });
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      void loadRates().then((next) => {
        if (!live) return;
        setRates(next);
        setLoading(false);
        setTick((n) => n + 1);
      });
    };
    refresh();
    const timer = setInterval(refresh, 30_000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [enabled]);
  return { rates, loading, refresh };
}

function saleFiat(sale: Sale): string | null {
  return sale.fiat && isCurrency(sale.fiat.currency)
    ? formatFiat(sale.fiat.amount, sale.fiat.currency)
    : null;
}

/** Re-renders whenever the register's state or sync status changes. */
function useRegister(register: Register) {
  const [, setTick] = useState(0);
  useEffect(() => register.subscribe(() => setTick((n) => n + 1)), [register]);
  return register;
}

export function Pos({ mintUrl }: { mintUrl: string }) {
  const [register, setRegister] = useState<Register | null>(null);
  const [busy, setBusy] = useState<'unlock' | 'create' | 'open' | null>('open');
  const [error, setError] = useState('');
  const [known, setKnown] = useState(false);

  const open = useCallback(
    async (prf: Uint8Array) => {
      setBusy('open');
      const opened = await Register.open(deriveKeys(prf), mintUrl, browserEnv);
      sessionStorage.setItem(SESSION_KEY, bytesToHex(prf));
      localStorage.setItem(KNOWN_KEY, '1');
      setRegister(opened);
    },
    [mintUrl],
  );

  const run = useCallback(
    async (kind: 'unlock' | 'create', quiet = false) => {
      setError('');
      setBusy(kind);
      try {
        await open(await (kind === 'create' ? createPasskey() : unlock()));
      } catch (err) {
        const cancelled = err instanceof PasskeyError && err.kind === 'cancelled';
        if (!quiet && !cancelled) setError(message(err));
      } finally {
        setBusy(null);
      }
    },
    [open],
  );

  // A reload keeps the session; a returning visitor gets the passkey prompt straight away.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const isKnown = localStorage.getItem(KNOWN_KEY) === '1';
    setKnown(isKnown);
    const session = sessionStorage.getItem(SESSION_KEY);
    if (session) {
      open(hexToBytes(session))
        .catch((err) => setError(message(err)))
        .finally(() => setBusy(null));
    } else if (isKnown) {
      void run('unlock', true);
    } else {
      setBusy(null);
    }
  }, [open, run]);

  const lock = useCallback(() => {
    sessionStorage.removeItem(SESSION_KEY);
    setRegister(null);
  }, []);

  if (register) return <Till register={register} onLock={lock} />;

  return (
    <main className="lock">
      <div className="lock-card">
        <img src="/icon.svg" alt="" width={72} height={72} />
        <h1>beepos</h1>
        <p className="muted">The cash register from the future. Start receiving Bitcoin today.</p>
        {busy === 'open' ? (
          <p className="muted" role="status">
            Opening the register…
          </p>
        ) : (
          <div className="stack">
            <button
              className="btn primary"
              disabled={busy !== null}
              onClick={() => run(known ? 'unlock' : 'create')}
            >
              {known ? 'Unlock with passkey' : 'Create a passkey'}
            </button>
            <button
              className="btn ghost"
              disabled={busy !== null}
              onClick={() => run(known ? 'create' : 'unlock')}
            >
              {known ? 'Set up a new register' : 'I already have a passkey'}
            </button>
          </div>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <Link className="quiet-link" href="/about">
          What is beepos?
        </Link>
      </div>
    </main>
  );
}

type View = { name: 'keypad' } | { name: 'invoice'; saleId: string } | { name: 'paid'; saleId: string };

function Till({ register: reg, onLock }: { register: Register; onLock: () => void }) {
  const register = useRegister(reg);
  const [view, setView] = useState<View>({ name: 'keypad' });
  // The drawer total is private: it is only in the page while the owner has the drawer open.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    opener.current?.focus();
  }, []);

  // Keep in step with other devices and settle invoices paid while nobody was looking.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void register
        .pull()
        .then(() => Promise.all([register.settlePending(), register.settlePayouts()]));
    };
    void register.settlePending();
    void register.settlePayouts();
    const timer = setInterval(tick, 20_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [register]);

  // The liquid behind the glass breathes while an invoice waits and floods when it is paid.
  useEffect(() => {
    setMood(view.name === 'invoice' ? 'waiting' : view.name === 'paid' ? 'paid' : 'idle');
    return () => setMood('idle');
  }, [view.name]);

  const sale =
    view.name === 'keypad' ? undefined : register.state.sales.find((s) => s.id === view.saleId);

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">beepos</span>
        <button
          ref={opener}
          className="till-btn"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open the register"
          aria-haspopup="dialog"
        >
          <SyncDot status={register.sync} />
          <RegisterIcon />
        </button>
      </header>
      <main className="pane">
        {view.name === 'keypad' && (
          <Keypad
            register={register}
            onCharged={(s) => {
              setDrawerOpen(false);
              setView({ name: 'invoice', saleId: s.id });
            }}
          />
        )}
        {view.name === 'invoice' && sale && (
          <Invoice
            register={register}
            sale={sale}
            onPaid={() => setView({ name: 'paid', saleId: sale.id })}
            onCancel={() => setView({ name: 'keypad' })}
          />
        )}
        {view.name === 'paid' && sale && (
          <Paid sale={sale} onDone={() => setView({ name: 'keypad' })} />
        )}
      </main>
      {drawerOpen && (
        <Drawer onClose={closeDrawer}>
          <WalletPanel register={register} onClose={closeDrawer} onLock={onLock} />
        </Drawer>
      )}
    </div>
  );
}

/** A till with its drawer: says "register" without saying how much is in it. */
function RegisterIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="7" y="3.5" width="10" height="5" rx="1.5" />
      <path d="M5.5 8.5h13l1.5 6.5H4z" />
      <rect x="3" y="15" width="18" height="5.5" rx="1.5" />
      <path d="M10 17.75h4" />
    </svg>
  );
}

/**
 * The register slides in from the right over everything else. A modal dialog, so
 * the keypad behind it cannot be pressed, Escape closes it, and it leaves the
 * page (taking the total with it) the moment it closes.
 */
function Drawer({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-label="Register"
      onClose={onClose}
      // A tap on the dimmed page beside the drawer lands on the dialog itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      {children}
    </dialog>
  );
}

function SyncDot({ status }: { status: Register['sync'] }) {
  const label = {
    synced: 'Backed up',
    syncing: 'Saving…',
    offline: 'Offline: saved on this device',
    local: 'Saved on this device only',
    unreadable: 'Backup cannot be read: saved on this device only',
  }[status];
  return <span className={`dot ${status}`} title={label} aria-label={label} role="img" />;
}

function mintLimits(register: Register): { min: number; max: number } {
  const methods = register.wallet.getMintInfo().cache.nuts?.['4']?.methods ?? [];
  const bolt11 = methods.find((m) => m.method === 'bolt11' && m.unit === 'sat');
  return {
    min: Number(bolt11?.min_amount ?? 1) || 1,
    max: Number(bolt11?.max_amount ?? 1_000_000) || 1_000_000,
  };
}

function Keypad({ register, onCharged }: { register: Register; onCharged: (s: Sale) => void }) {
  // What was typed, and the unit it was typed in. Digits typed as one unit are
  // never read as another: when the unit changes they count as nothing.
  const [entry, setEntry] = useState({ unit: '', digits: '' });
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // With a fiat currency set and a current price, the keys type that currency
  // (in its smallest unit) and the invoice is for the bitcoin it is worth now.
  // Without a current price the keypad takes bitcoin: it never guesses.
  const currency = register.fiat;
  const { rates, loading, refresh } = useRates(currency !== null);
  const rate = currency ? usableRate(rates, currency) : null;
  const inFiat = currency !== null && rate !== null;
  const unit = inFiat ? currency : '';
  const digits = entry.unit === unit ? entry.digits : '';
  const typed = Number(digits || '0');
  const amount = inFiat ? toBitcoin(typed, currency, rate) : typed;
  const shown = inFiat ? formatFiat(typed, currency) : formatBitcoin(amount);
  const limits = useMemo(() => mintLimits(register), [register]);
  const tooBig = amount > limits.max;
  const ready = amount >= limits.min && !tooBig && !busy;
  // Saved items priced in what the keypad is taking right now. An item priced in
  // another unit is left out: its price is never converted or read as this unit.
  const presets = register.presets.filter((p) => (p.currency ?? '') === unit);
  const pick = (preset: Preset) => {
    setError('');
    setEntry({ unit, digits: String(preset.amount) });
    setMemo(preset.name);
  };

  const press = useCallback((key: string) => {
    setError('');
    setEntry((e) => {
      const d = e.unit === unit ? e.digits : '';
      if (key === 'back') return { unit, digits: d.slice(0, -1) };
      const next = (d + key).replace(/^0+/, '');
      return { unit, digits: next.length > MAX_DIGITS ? d : next };
    });
  }, [unit]);

  const charge = useCallback(async () => {
    if (!ready) return;
    // The price on screen is from the last render. A tab that was asleep can wake
    // with it long out of date, so it is checked again at the moment of charging.
    if (inFiat && usableRate(rates, currency) !== rate) {
      setEntry({ unit: '', digits: '' });
      setError('The price is out of date. Nothing was charged. Enter the amount again.');
      refresh();
      return;
    }
    setBusy(true);
    setError('');
    try {
      onCharged(
        await register.charge(
          amount,
          memo,
          inFiat ? { currency, amount: typed, perBitcoin: rate } : undefined,
        ),
      );
    } catch (err) {
      setError(`Could not make the invoice. ${message(err)}`);
      setBusy(false);
    }
  }, [ready, register, amount, memo, onCharged, inFiat, currency, typed, rate, rates, refresh]);

  // A desktop keyboard works as the keypad unless the memo field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Typing in the open register must not ring up a sale behind it.
      if ((e.target as Element | null)?.closest?.('dialog')) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const inField = tag === 'INPUT';
      if (e.key === 'Enter' && tag !== 'BUTTON') {
        e.preventDefault();
        void charge();
      } else if (!inField && /^\d$/.test(e.key)) press(e.key);
      else if (!inField && e.key === 'Backspace') press('back');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [press, charge]);

  return (
    <section className="keypad-view" aria-label="New sale">
      <output className={`amount${digits ? '' : ' zero'}`} data-testid="amount" aria-live="polite">
        {shown}
      </output>
      {currency !== null && (
        <p className="convert" role="status" data-testid="convert">
          {inFiat
            ? `${formatBitcoin(amount)} · price from ${timeAgo(rates!.at)}`
            : loading
              ? 'Getting the price…'
              : `No current price for ${currency}. Enter the amount in bitcoin.`}
        </p>
      )}
      <p className="hint" role={error || tooBig ? 'alert' : undefined}>
        {error || (tooBig ? `The most one sale can take is ${formatBitcoin(limits.max)}.` : ' ')}
      </p>
      {presets.length > 0 && (
        <ul className="presets" aria-label="Saved items">
          {presets.map((preset) => (
            <li key={preset.id}>
              <button
                className="preset"
                onClick={() => pick(preset)}
                aria-pressed={memo === preset.name && typed === preset.amount}
              >
                <span>{preset.name}</span>
                <span className="preset-price">{presetPrice(preset)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        className="memo"
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        placeholder="Memo (optional)"
        aria-label="Memo (optional)"
        maxLength={80}
        enterKeyHint="done"
        autoComplete="off"
      />
      <div className="keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'].map((key) => (
          <button
            key={key}
            className="key"
            onClick={() => press(key)}
            aria-label={key === 'back' ? 'Delete last digit' : key}
          >
            {key === 'back' ? '⌫' : key}
          </button>
        ))}
      </div>
      <button className="btn primary charge" disabled={!ready} onClick={charge}>
        {busy ? 'Making invoice…' : amount ? `Charge ${shown}` : 'Charge'}
      </button>
    </section>
  );
}

function presetPrice(preset: Preset): string {
  return preset.currency ? formatFiat(preset.amount, preset.currency) : formatBitcoin(preset.amount);
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn ghost"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

function Invoice({
  register,
  sale,
  onPaid,
  onCancel,
}: {
  register: Register;
  sale: Sale;
  onPaid: () => void;
  onCancel: () => void;
}) {
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await register.settle(sale.id);
        if (live) setProblem('');
      } catch (err) {
        if (live) setProblem(`Still checking. ${message(err)}`);
      }
      if (live) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [register, sale.id]);

  useEffect(() => {
    if (sale.status === 'paid') {
      beep();
      onPaid();
    }
  }, [sale.status, onPaid]);

  if (sale.status === 'expired') {
    return (
      <section className="center-view">
        <h2>Invoice expired</h2>
        <p className="muted">Nobody paid it in time. Nothing was charged.</p>
        <button className="btn primary" onClick={onCancel}>
          New sale
        </button>
      </section>
    );
  }

  return (
    <section className="center-view" aria-label="Waiting for payment">
      <p className="amount small" data-testid="invoice-amount">
        {formatBitcoin(sale.amount)}
      </p>
      {saleFiat(sale) && (
        <p className="muted" data-testid="invoice-fiat">
          {saleFiat(sale)}
        </p>
      )}
      {sale.memo && <p className="muted">{sale.memo}</p>}
      <a href={`lightning:${sale.request}`} className="qr-link" aria-label="Open in a wallet">
        <Qr value={`lightning:${sale.request}`.toUpperCase()} label="Lightning invoice QR code" />
      </a>
      <p className="waiting" role="status">
        <span className="pulse" aria-hidden /> {problem || 'Waiting for payment…'}
      </p>
      <div className="row">
        <CopyButton text={sale.request} label="Copy invoice" />
        <button className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <textarea readOnly hidden data-testid="invoice" value={sale.request} />
    </section>
  );
}

function Paid({ sale, onDone }: { sale: Sale; onDone: () => void }) {
  return (
    <section className="center-view paid" aria-label="Paid">
      <div className="check" aria-hidden>
        ✓
      </div>
      <h2 role="status">Paid</h2>
      <p className="amount small">{formatBitcoin(sale.amount)}</p>
      {saleFiat(sale) && <p className="muted">{saleFiat(sale)}</p>}
      {sale.memo && <p className="muted">{sale.memo}</p>}
      <button className="btn primary" onClick={onDone} autoFocus>
        New sale
      </button>
    </section>
  );
}

function currencyName(code: Currency): string {
  try {
    return new Intl.DisplayNames(undefined, { type: 'currency' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The saved items the keypad offers. Add, change and remove. */
function SavedItems({ register }: { register: Register }) {
  const items = register.presets;
  const fiat = register.fiat;
  // null: the form is closed. An id that is not in the list: a new item.
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [currency, setCurrency] = useState<Currency | null>(fiat);
  const [error, setError] = useState('');

  const openForm = (preset?: Preset) => {
    setEditing(preset?.id ?? crypto.randomUUID());
    setName(preset?.name ?? '');
    setPrice(preset ? priceText(preset) : '');
    setCurrency(preset ? preset.currency : fiat);
    setError('');
  };
  // A price can be in bitcoin, the register's currency, or the one the item already has.
  const units = [...new Set<Currency | null>([fiat, currency, null])].filter(
    (u): u is Currency | null => u === null || isCurrency(u),
  );
  const offKeypad = items.filter((p) => p.currency !== fiat).length;

  return (
    <div className="saved">
      {items.length === 0 && editing === null && (
        <p className="muted setting-note">
          Things you charge for often. One tap on the keypad fills the price and the memo.
        </p>
      )}
      <ul className="saved-list" aria-label="Saved items">
        {items.map((preset) => (
          <li key={preset.id}>
            <span className="saved-name">{preset.name}</span>
            <span className="saved-price">{presetPrice(preset)}</span>
            <button
              className="link"
              onClick={() => openForm(preset)}
              aria-label={`Change ${preset.name}`}
            >
              Change
            </button>
            <button
              className="link"
              onClick={() => {
                if (editing === preset.id) setEditing(null);
                register.removePreset(preset.id);
              }}
              aria-label={`Remove ${preset.name}`}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      {offKeypad > 0 && (
        <p className="muted setting-note">
          The keypad shows the items priced in{' '}
          {fiat ? `${fiat}. With no current price it shows the bitcoin ones.` : 'bitcoin.'}
        </p>
      )}
      {items.length >= MAX_PRESETS && editing === null && (
        <p className="muted setting-note">
          That is all {MAX_PRESETS} the register keeps. Remove one to add another.
        </p>
      )}
      {editing === null && items.length < MAX_PRESETS && (
        <button className="btn ghost saved-add" onClick={() => openForm()}>
          Add an item
        </button>
      )}
      {editing !== null && (
        <form
          className="stack saved-form"
          onSubmit={(e) => {
            e.preventDefault();
            const amount = parsePrice(price, currency);
            if (!name.trim()) return setError('Give the item a name.');
            if (amount === null) {
              return setError(
                currency ? `Enter a price in ${currency}, like 4.50.` : 'Enter a whole bitcoin amount.',
              );
            }
            try {
              register.savePreset({ id: editing, name: name.trim(), currency, amount });
              setEditing(null);
            } catch (err) {
              setError(message(err));
            }
          }}
        >
          <label className="field">
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={MAX_PRESET_NAME}
              autoComplete="off"
              autoFocus
            />
          </label>
          <div className="saved-price-row">
            <label className="field">
              Price
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode={currency && decimals(currency) ? 'decimal' : 'numeric'}
                autoComplete="off"
              />
            </label>
            <label className="field">
              In
              <select
                value={currency ?? ''}
                onChange={(e) => setCurrency(isCurrency(e.target.value) ? e.target.value : null)}
                aria-label="Price is in"
              >
                {units.map((u) => (
                  <option key={u ?? ''} value={u ?? ''}>
                    {u ?? 'Bitcoin (₿)'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <div className="row">
            <button className="btn primary" type="submit">
              Save item
            </button>
            <button className="btn ghost" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

type Mode = 'menu' | 'activity' | 'items' | 'settings' | 'backup' | 'cashout';

const ICONS = {
  activity: <path d="M6 3.5h12v17l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6" />,
  items: (
    <>
      <path d="M3.5 12.5V4.5h8l9 9-8 8z" />
      <circle cx="8" cy="9" r="1.3" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  cashout: <path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4 14v4.5a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5V14" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
    </>
  ),
  back: <path d="M14.5 5 8 12l6.5 7" />,
  forward: <path d="M9.5 5 16 12l-6.5 7" />,
};

/** Line icons for the register menu, drawn like the till icon in the header. */
function Icon({ name }: { name: keyof typeof ICONS }) {
  return (
    <svg
      className="icon"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {ICONS[name]}
    </svg>
  );
}

type Entry =
  | { kind: 'sale'; at: number; sale: Sale }
  | { kind: 'cashout'; at: number; cashout: Cashout }
  | { kind: 'payout'; at: number; payout: Payout };

function WalletPanel({
  register,
  onClose,
  onLock,
}: {
  register: Register;
  onClose: () => void;
  onLock: () => void;
}) {
  const [mode, setMode] = useState<Mode>('menu');
  // Where Cash out returns to: the menu, or Activity when a token was opened from there.
  const [from, setFrom] = useState<Mode>('menu');
  const [token, setToken] = useState<Cashout | null>(null);
  const [quote, setQuote] = useState<PayoutQuote | null>(null);
  const [words, setWords] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void register.refreshCashouts().catch(() => {});
  }, [register]);

  // One passkey question at a time. Leaving the view (Back, Done, Lock, closing the
  // drawer) withdraws it: an answer that arrives afterwards shows and moves nothing.
  // The prompt itself is closed too, where the browser allows it.
  const asked = useRef(0);
  const prompt = useRef<AbortController | null>(null);
  const leave = useCallback(() => {
    asked.current++;
    prompt.current?.abort();
    prompt.current = null;
  }, []);
  useEffect(() => leave, [leave]);
  const confirm = async () => {
    leave();
    const mine = asked.current;
    const open = (prompt.current = new AbortController());
    const approval = await approve(register.keys, () => unlock(undefined, open.signal));
    if (mine !== asked.current) {
      throw new PasskeyError('cancelled', 'Left before the passkey answered.');
    }
    return { approval, current: () => mine === asked.current };
  };

  /** Moves to another view. Whatever was being asked or shown in this one is dropped. */
  const go = (next: Mode) => {
    leave();
    setWords('');
    setToken(null);
    setQuote(null);
    setNote('');
    setMode(next);
  };

  const entries = useMemo<Entry[]>(() => {
    const sales = register.state.sales
      .filter((s) => s.status !== 'expired')
      .map((sale) => ({ kind: 'sale' as const, at: sale.paidAt ?? sale.createdAt, sale }));
    const outs = register.state.cashouts.map((cashout) => ({
      kind: 'cashout' as const,
      at: cashout.createdAt,
      cashout,
    }));
    const paid = register.state.payouts.map((payout) => ({
      kind: 'payout' as const,
      at: payout.paidAt ?? payout.createdAt,
      payout,
    }));
    return [...sales, ...outs, ...paid].sort((a, b) => b.at - a.at).slice(0, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register.state.sales, register.state.cashouts, register.state.payouts]);

  const act = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setNote('');
    try {
      setNote((await work()) ?? '');
    } catch (err) {
      // A dismissed passkey prompt changes nothing and needs no message.
      setNote(err instanceof PasskeyError && err.kind === 'cancelled' ? '' : message(err));
    } finally {
      setBusy(false);
    }
  };

  const syncText = {
    synced: 'Backed up. Your passkey opens this register on your other compatible devices.',
    syncing: 'Saving…',
    offline: 'Offline. Saved on this device; it will back up when the connection returns.',
    local: 'Saved on this device only. No backup server is set up.',
    unreadable:
      'The backup on the server cannot be read by this version of beepos, so it was left alone. Sales are saved on this device only. Reload the page to get the latest version.',
  }[register.sync];

  const titles: Record<Mode, string> = {
    menu: 'Register',
    activity: 'Activity',
    items: 'Saved items',
    settings: 'Settings',
    backup: 'Backup',
    cashout: 'Register',
  };
  // Activity, Saved items and Settings go back to the menu; Backup goes back to Settings.
  // Cash out has its own Back, because where it leads depends on the step.
  const up: Partial<Record<Mode, Mode>> = {
    activity: 'menu',
    items: 'menu',
    settings: 'menu',
    backup: 'settings',
  };

  return (
    <div className="wallet">
      <div className="wallet-head">
        {up[mode] && (
          <button className="btn ghost back" onClick={() => go(up[mode]!)} aria-label="Back">
            <Icon name="back" />
          </button>
        )}
        <h2>{titles[mode]}</h2>
        <button
          className="btn ghost close"
          onClick={() => {
            leave();
            setWords('');
            onClose();
          }}
        >
          Done
        </button>
      </div>
      {(mode === 'menu' || mode === 'cashout') && (
        <p className="amount small" data-testid="wallet-balance">
          {formatBitcoin(register.balance)}
        </p>
      )}

      {mode === 'menu' && (
        <>
          <p className="muted sync-line">
            <SyncDot status={register.sync} /> {syncText}
          </p>
          {note && (
            <p className="muted" role="status">
              {note}
            </p>
          )}
          <nav className="tiles" aria-label="Register">
            <button className="tile" onClick={() => go('activity')}>
              <Icon name="activity" />
              Activity
            </button>
            <button className="tile" onClick={() => go('items')}>
              <Icon name="items" />
              Saved items
            </button>
            <button className="tile" onClick={() => go('settings')}>
              <Icon name="settings" />
              Settings
            </button>
            <button
              className="tile primary"
              disabled={register.balance === 0}
              onClick={() => {
                setFrom('menu');
                go('cashout');
              }}
            >
              <Icon name="cashout" />
              Cash out
            </button>
            <button
              className="tile wide"
              onClick={() => {
                leave();
                onLock();
              }}
            >
              <Icon name="lock" />
              Lock
            </button>
          </nav>
        </>
      )}

      {mode === 'activity' && (
        <>
          {note && (
            <p className="muted" role="status">
              {note}
            </p>
          )}
          {entries.length === 0 && <p className="muted">No sales yet.</p>}
          <ul className="activity">
            {entries.map((entry) =>
              entry.kind === 'sale' ? (
                <li key={entry.sale.id}>
                  <span>
                    <strong>{entry.sale.memo || 'Sale'}</strong>
                    <small>
                      {entry.sale.status === 'pending' ? 'Waiting for payment' : timeAgo(entry.at)}
                      {saleFiat(entry.sale) && ` · ${saleFiat(entry.sale)}`}
                    </small>
                  </span>
                  <span className={entry.sale.status === 'paid' ? 'in' : 'dim'}>
                    {entry.sale.status === 'paid' ? '+' : ''}
                    {formatBitcoin(entry.sale.amount)}
                  </span>
                </li>
              ) : entry.kind === 'cashout' ? (
                <li key={entry.cashout.id}>
                  <span>
                    <strong>Cash out</strong>
                    <small>
                      {entry.cashout.status === 'out' && (
                        <>
                          Not redeemed yet ·{' '}
                          <button
                            className="link"
                            disabled={busy}
                            onClick={() =>
                              act(async () => {
                                const { approval } = await confirm();
                                setToken(register.cashoutToken(entry.cashout.id, approval));
                                setFrom('activity');
                                setMode('cashout');
                              })
                            }
                          >
                            Show token
                          </button>
                          {' · '}
                          <button
                            className="link"
                            disabled={busy}
                            onClick={() =>
                              act(async () => {
                                await register.reclaim(entry.cashout.id);
                                return 'Token taken back into the register.';
                              })
                            }
                          >
                            Take it back
                          </button>
                        </>
                      )}
                      {entry.cashout.status === 'claimed' && `Redeemed · ${timeAgo(entry.at)}`}
                      {entry.cashout.status === 'reclaimed' && 'Taken back'}
                    </small>
                  </span>
                  <span className={entry.cashout.status === 'reclaimed' ? 'dim' : 'out'}>
                    −{formatBitcoin(entry.cashout.amount)}
                  </span>
                </li>
              ) : (
                <li key={entry.payout.id}>
                  <span>
                    <strong>Cash out to {entry.payout.to}</strong>
                    <small>
                      {entry.payout.status === 'pending' && 'Waiting for the mint to confirm'}
                      {entry.payout.status === 'failed' && 'Not paid. The money came back'}
                      {entry.payout.status === 'paid' &&
                        `Paid · ${timeAgo(entry.at)}${
                          entry.payout.fee != null ? ` · fee ${formatBitcoin(entry.payout.fee)}` : ''
                        }`}
                    </small>
                  </span>
                  <span className={entry.payout.status === 'failed' ? 'dim' : 'out'}>
                    −{formatBitcoin(entry.payout.amount + (entry.payout.fee ?? 0))}
                  </span>
                </li>
              ),
            )}
          </ul>
        </>
      )}

      {mode === 'items' && <SavedItems register={register} />}

      {mode === 'settings' && (
        <section className="settings">
          <div className="setting">
            <label htmlFor="currency">Currency</label>
            <select
              id="currency"
              value={register.fiat ?? ''}
              onChange={(e) => register.setFiat(isCurrency(e.target.value) ? e.target.value : null)}
            >
              <option value="">Bitcoin only</option>
              {CURRENCIES.map((code) => (
                <option key={code} value={code}>
                  {code} · {currencyName(code)}
                </option>
              ))}
            </select>
          </div>
          <dl className="setting">
            <dt>Mint</dt>
            <dd className="mint-url">{register.state.mintUrl.replace(/^https?:\/\//, '')}</dd>
          </dl>
          <button className="setting setting-link" onClick={() => go('backup')}>
            <span className="setting-label">Backup</span>
            <span className="muted">
              12 words <Icon name="forward" />
            </span>
          </button>
        </section>
      )}

      {mode === 'cashout' && (
        <CashOut
          register={register}
          token={token}
          busy={busy}
          note={note}
          quote={quote}
          onQuote={(to, amount) =>
            act(async () => {
              leave();
              const mine = asked.current;
              const priced = await register.quotePayout(to, amount);
              if (mine === asked.current) setQuote(priced);
            })
          }
          onEdit={() => {
            leave();
            setQuote(null);
            setNote('');
          }}
          onPay={(priced) =>
            act(async () => {
              const { approval, current } = await confirm();
              const payout = await register.payOut(priced, approval);
              if (!current()) return;
              setQuote(null);
              setMode('menu');
              return payout.status === 'paid'
                ? `Paid ${formatBitcoin(payout.amount)} to ${payout.to}.`
                : 'Not confirmed yet. The money for it stays set aside until the mint answers; Activity will show how it ends.';
            })
          }
          onToken={(amount) =>
            act(async () => {
              const { approval, current } = await confirm();
              const made = await register.cashOut(amount, approval);
              // Made after leaving: it stays in Activity, where showing it asks again.
              if (current()) setToken(made);
            })
          }
          onReclaim={(id) =>
            act(async () => {
              await register.reclaim(id);
              setToken(null);
              setMode('activity');
              return 'Token taken back into the register.';
            })
          }
          onBack={() => go(from)}
        />
      )}

      {mode === 'backup' && (
        <div className="stack">
          <p className="muted">
            Your passkey opens this register on other devices it syncs to, when the browser and
            passkey provider there support it. If you ever lose the
            passkey, these 12 words restore the money in any Cashu wallet that supports seed
            restore, using this mint:
          </p>
          <p className="mint-url">{register.state.mintUrl}</p>
          {words ? (
            <>
              <p className="words" data-testid="words">
                {words}
              </p>
              <p className="muted">Anyone with these words can take the money. Keep them offline.</p>
            </>
          ) : (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() =>
                act(async () => setWords(register.backupWords((await confirm()).approval)))
              }
            >
              Show the 12 words
            </button>
          )}
          <button
            className="btn ghost"
            disabled={busy}
            onClick={() =>
              act(async () => `Checked with the mint: ${formatBitcoin(await register.recover())}.`)
            }
          >
            {busy ? 'Checking the mint…' : 'Recover from the mint'}
          </button>
          {note && (
            <p className="muted" role="status">
              {note}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CashOut({
  register,
  token,
  busy,
  note,
  quote,
  onQuote,
  onEdit,
  onPay,
  onToken,
  onReclaim,
  onBack,
}: {
  register: Register;
  token: Cashout | null;
  busy: boolean;
  note: string;
  quote: PayoutQuote | null;
  onQuote: (to: Destination, amount?: number) => void;
  onEdit: () => void;
  onPay: (quote: PayoutQuote) => void;
  onToken: (amount: number) => void;
  onReclaim: (id: string) => void;
  onBack: () => void;
}) {
  const [value, setValue] = useState(String(register.balance));
  const [to, setTo] = useState('');
  const typed = Number(value || '0');
  const dest = useMemo(() => parseDestination(to), [to]);
  // An invoice that names its amount decides it; otherwise the owner does.
  const fixed = dest?.kind === 'bolt11' ? dest.amount : null;
  const amount = fixed ?? typed;
  const unread = to.trim() !== '' && !dest;
  const noOffers = dest?.kind === 'bolt12' && !register.paysOffers;

  if (token) {
    return (
      <div className="stack">
        <h3>{formatBitcoin(token.amount)} token</h3>
        <p className="muted">
          This token is the money. Paste or scan it into any Cashu wallet to receive it.
        </p>
        {token.token.length <= 1200 && <Qr value={token.token} label="Cashu token QR code" />}
        <textarea className="token" readOnly value={token.token} data-testid="token" rows={4} />
        <div className="row">
          <CopyButton text={token.token} label="Copy token" />
          {token.status === 'out' && (
            <button className="btn ghost" disabled={busy} onClick={() => onReclaim(token.id)}>
              {busy ? 'Taking back…' : 'Take it back'}
            </button>
          )}
          <button className="btn ghost" onClick={onBack}>
            Done
          </button>
        </div>
        {note && (
          <p className="error" role="alert">
            {note}
          </p>
        )}
      </div>
    );
  }

  if (quote) {
    const short = quote.left < 0;
    return (
      <div className="stack">
        <h3>Pay {formatBitcoin(quote.amount)}</h3>
        <div>
          <dl className="setting">
            <dt>To</dt>
            <dd className="mint-url">{quote.to}</dd>
          </dl>
          <dl className="setting">
            <dt>Fee, at most</dt>
            <dd data-testid="fee-reserve">{formatBitcoin(quote.feeReserve)}</dd>
          </dl>
          <dl className="setting">
            <dt>Left in the register, at least</dt>
            <dd data-testid="left">{formatBitcoin(Math.max(quote.left, 0))}</dd>
          </dl>
        </div>
        <p className="muted">
          The mint holds the fee aside while it pays. Whatever it does not use comes back to the
          register.
        </p>
        {(note || short) && (
          <p className="error" role="alert">
            {note ||
              `Not enough for the amount and the fee. The most this register can send here is about ${formatBitcoin(
                Math.max(quote.amount + quote.left, 0),
              )}.`}
          </p>
        )}
        <div className="row">
          <button className="btn primary" disabled={busy || short} onClick={() => onPay(quote)}>
            {busy ? 'Paying…' : `Pay ${formatBitcoin(quote.amount)}`}
          </button>
          <button className="btn ghost" onClick={onEdit}>
            Change
          </button>
          <button className="btn ghost" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        if (dest) onQuote(dest, fixed == null ? typed : undefined);
        else onToken(amount);
      }}
    >
      <h3>Cash out</h3>
      <p className="muted">
        Pay a Lightning invoice or address from the register, or leave that empty to make a Cashu
        token for another wallet.
      </p>
      <label className="field">
        Pay to (optional)
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="Lightning invoice or address"
          aria-label="Lightning invoice or address to pay"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          inputMode="email"
        />
      </label>
      {(unread || noOffers) && (
        <p className="muted" role="status">
          {noOffers
            ? 'This mint cannot pay BOLT12 offers yet. Use an invoice or a Lightning address.'
            : 'That is not a Lightning invoice or address the register can pay.'}
        </p>
      )}
      <label className="field">
        Amount
        <span className="prefixed">
          <span aria-hidden>₿</span>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={fixed ?? value}
            readOnly={fixed != null}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, MAX_DIGITS))}
            aria-label="Amount to cash out"
          />
        </span>
      </label>
      {note && (
        <p className="error" role="alert">
          {note}
        </p>
      )}
      <div className="row">
        <button
          className="btn primary"
          disabled={busy || unread || noOffers || amount < 1 || amount > register.balance}
          type="submit"
        >
          {dest
            ? busy
              ? 'Checking the cost…'
              : 'Check the cost'
            : busy
              ? 'Making token…'
              : `Make ${formatBitcoin(amount)} token`}
        </button>
        <button className="btn ghost" type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}
