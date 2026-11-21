'use client';

import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatBitcoin, timeAgo } from '@/lib/format';
import { deriveKeys } from '@/lib/keys';
import { PasskeyError, register as createPasskey, unlock } from '@/lib/passkey';
import { Register, browserEnv } from '@/lib/register';
import type { Cashout, Sale } from '@/lib/state';
import { keyClick } from './fx/feel';
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
        <p className="muted">Take Lightning. Keep ecash. Your passkey is the only key.</p>
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
      </div>
    </main>
  );
}

type View = { name: 'keypad' } | { name: 'invoice'; saleId: string } | { name: 'paid'; saleId: string };

function Till({ register: reg, onLock }: { register: Register; onLock: () => void }) {
  const register = useRegister(reg);
  const [view, setView] = useState<View>({ name: 'keypad' });
  const [walletOpen, setWalletOpen] = useState(false);

  // Keep in step with other devices and settle invoices paid while nobody was looking.
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'visible') return;
      void register.pull().then(() => register.settlePending());
    };
    void register.settlePending();
    const timer = setInterval(tick, 20_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [register]);

  const sale =
    view.name === 'keypad' ? undefined : register.state.sales.find((s) => s.id === view.saleId);

  return (
    <div className="app">
      <header className="bar">
        <span className="brand">beepos</span>
        <button
          className="balance"
          onClick={() => setWalletOpen(true)}
          aria-label={`Register holds ${formatBitcoin(register.balance)}. Open the register.`}
        >
          <SyncDot status={register.sync} />
          <span data-testid="balance">{formatBitcoin(register.balance)}</span>
        </button>
      </header>
      <div className="panes">
        <main className="pane main">
          {view.name === 'keypad' && (
            <Keypad
              register={register}
              onCharged={(s) => setView({ name: 'invoice', saleId: s.id })}
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
        <aside className={`pane side${walletOpen ? ' open' : ''}`}>
          <WalletPanel register={register} onClose={() => setWalletOpen(false)} onLock={onLock} />
        </aside>
      </div>
    </div>
  );
}

function SyncDot({ status }: { status: Register['sync'] }) {
  const label = {
    synced: 'Backed up',
    syncing: 'Saving…',
    offline: 'Offline: saved on this device',
    local: 'Saved on this device only',
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
  const [digits, setDigits] = useState('');
  const [memo, setMemo] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const amount = Number(digits || '0');
  const limits = useMemo(() => mintLimits(register), [register]);
  const tooBig = amount > limits.max;
  const ready = amount >= limits.min && !tooBig && !busy;

  const press = useCallback((key: string) => {
    setError('');
    setDigits((d) => {
      if (key === 'back') return d.slice(0, -1);
      const next = (d + key).replace(/^0+/, '');
      return next.length > MAX_DIGITS ? d : next;
    });
  }, []);

  const charge = useCallback(async () => {
    if (!ready) return;
    setBusy(true);
    setError('');
    try {
      onCharged(await register.charge(amount, memo));
    } catch (err) {
      setError(`Could not make the invoice. ${message(err)}`);
      setBusy(false);
    }
  }, [ready, register, amount, memo, onCharged]);

  // A desktop keyboard works as the keypad unless the memo field has focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
        {formatBitcoin(amount)}
      </output>
      <p className="hint" role={error || tooBig ? 'alert' : undefined}>
        {error || (tooBig ? `The most one sale can take is ${formatBitcoin(limits.max)}.` : ' ')}
      </p>
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
            onPointerDown={keyClick}
            onClick={() => press(key)}
            aria-label={key === 'back' ? 'Delete last digit' : key}
          >
            <span className="face" aria-hidden>
              <span className="turn" />
            </span>
            <span className="legend">{key === 'back' ? '⌫' : key}</span>
          </button>
        ))}
      </div>
      <button className="btn primary charge" disabled={!ready} onClick={charge}>
        {busy ? 'Making invoice…' : amount ? `Charge ${formatBitcoin(amount)}` : 'Charge'}
      </button>
    </section>
  );
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
      {sale.memo && <p className="muted">{sale.memo}</p>}
      <button className="btn primary" onClick={onDone} autoFocus>
        New sale
      </button>
    </section>
  );
}

type Entry =
  | { kind: 'sale'; at: number; sale: Sale }
  | { kind: 'cashout'; at: number; cashout: Cashout };

function WalletPanel({
  register,
  onClose,
  onLock,
}: {
  register: Register;
  onClose: () => void;
  onLock: () => void;
}) {
  const [mode, setMode] = useState<'list' | 'cashout' | 'backup'>('list');
  const [token, setToken] = useState<Cashout | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void register.refreshCashouts().catch(() => {});
  }, [register]);

  const entries = useMemo<Entry[]>(() => {
    const sales = register.state.sales
      .filter((s) => s.status !== 'expired')
      .map((sale) => ({ kind: 'sale' as const, at: sale.paidAt ?? sale.createdAt, sale }));
    const outs = register.state.cashouts.map((cashout) => ({
      kind: 'cashout' as const,
      at: cashout.createdAt,
      cashout,
    }));
    return [...sales, ...outs].sort((a, b) => b.at - a.at).slice(0, 100);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [register.state.sales, register.state.cashouts]);

  const act = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setNote('');
    try {
      setNote((await work()) ?? '');
    } catch (err) {
      setNote(message(err));
    } finally {
      setBusy(false);
    }
  };

  const syncText = {
    synced: 'Backed up. Any device with your passkey can open this register.',
    syncing: 'Saving…',
    offline: 'Offline. Saved on this device; it will back up when the connection returns.',
    local: 'Saved on this device only. No backup server is set up.',
  }[register.sync];

  return (
    <div className="wallet">
      <div className="wallet-head">
        <h2>Register</h2>
        <button className="btn ghost close" onClick={onClose}>
          Done
        </button>
      </div>
      <p className="amount small" data-testid="wallet-balance">
        {formatBitcoin(register.balance)}
      </p>
      <p className="muted sync-line">
        <SyncDot status={register.sync} /> {syncText}
      </p>

      {mode === 'list' && (
        <>
          <div className="row">
            <button
              className="btn primary"
              disabled={register.balance === 0}
              onClick={() => {
                setToken(null);
                setNote('');
                setMode('cashout');
              }}
            >
              Cash out
            </button>
            <button className="btn ghost" onClick={() => setMode('backup')}>
              Backup
            </button>
            <button className="btn ghost" onClick={onLock}>
              Lock
            </button>
          </div>
          {note && (
            <p className="muted" role="status">
              {note}
            </p>
          )}
          <h3>Activity</h3>
          {entries.length === 0 && <p className="muted">No sales yet.</p>}
          <ul className="activity">
            {entries.map((entry) =>
              entry.kind === 'sale' ? (
                <li key={entry.sale.id}>
                  <span>
                    <strong>{entry.sale.memo || 'Sale'}</strong>
                    <small>
                      {entry.sale.status === 'pending' ? 'Waiting for payment' : timeAgo(entry.at)}
                    </small>
                  </span>
                  <span className={entry.sale.status === 'paid' ? 'in' : 'dim'}>
                    {entry.sale.status === 'paid' ? '+' : ''}
                    {formatBitcoin(entry.sale.amount)}
                  </span>
                </li>
              ) : (
                <li key={entry.cashout.id}>
                  <span>
                    <strong>Cash out</strong>
                    <small>
                      {entry.cashout.status === 'out' && (
                        <>
                          Not redeemed yet ·{' '}
                          <button
                            className="link"
                            onClick={() => {
                              setToken(entry.cashout);
                              setMode('cashout');
                            }}
                          >
                            Show token
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
              ),
            )}
          </ul>
        </>
      )}

      {mode === 'cashout' && (
        <CashOut
          register={register}
          token={token}
          busy={busy}
          note={note}
          onToken={(amount) =>
            act(async () => {
              setToken(await register.cashOut(amount));
            })
          }
          onReclaim={(id) =>
            act(async () => {
              await register.reclaim(id);
              setMode('list');
              return 'Token taken back into the register.';
            })
          }
          onBack={() => {
            setNote('');
            setMode('list');
          }}
        />
      )}

      {mode === 'backup' && (
        <div className="stack">
          <h3>Backup</h3>
          <p className="muted">
            Your passkey opens this register on any device it syncs to. If you ever lose the
            passkey, these 12 words restore the money in any Cashu wallet that supports seed
            restore, using this mint:
          </p>
          <p className="mint-url">{register.state.mintUrl}</p>
          <details>
            <summary>Show the 12 words</summary>
            <p className="words" data-testid="words">
              {register.keys.mnemonic}
            </p>
            <p className="muted">Anyone with these words can take the money. Keep them offline.</p>
          </details>
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
          <button
            className="btn ghost"
            onClick={() => {
              setNote('');
              setMode('list');
            }}
          >
            Back
          </button>
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
  onToken,
  onReclaim,
  onBack,
}: {
  register: Register;
  token: Cashout | null;
  busy: boolean;
  note: string;
  onToken: (amount: number) => void;
  onReclaim: (id: string) => void;
  onBack: () => void;
}) {
  const [value, setValue] = useState(String(register.balance));
  const amount = Number(value || '0');

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

  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        onToken(amount);
      }}
    >
      <h3>Cash out</h3>
      <p className="muted">Turn money in the register into a Cashu token for another wallet.</p>
      <label className="field">
        Amount
        <span className="prefixed">
          <span aria-hidden>₿</span>
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={value}
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
          disabled={busy || amount < 1 || amount > register.balance}
          type="submit"
        >
          {busy ? 'Making token…' : `Make ${formatBitcoin(amount)} token`}
        </button>
        <button className="btn ghost" type="button" onClick={onBack}>
          Back
        </button>
      </div>
    </form>
  );
}
