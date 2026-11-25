import React from 'react';
import { useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react';
import {
  AbsoluteFill,
  Audio,
  Easing,
  Img,
  continueRender,
  delayRender,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { loadFont } from '@remotion/google-fonts/Manrope';
import QRCode from 'qrcode';
import { MAX_RIPPLES, createLiquid, type Frame } from '../../app/fx/shader';
import { formatFiat, toBitcoin } from '../../lib/fiat';
import { formatBitcoin } from '../../lib/format';
import icon from '../../public/icon.svg';

export const FPS = 30;
export const DURATION = 55 * FPS;
export const POSTER_FRAME = 1560;

const W = 1920;
const H = 1080;
// What the owner saw on the day: $1.00 is about ₿1,677.
const RATE = 59_630;
const SITE = 'https://beepos.sbd.design';

const { fontFamily } = loadFont('normal', {
  weights: ['200', '300', '500', '600', '700', '800'],
  subsets: ['latin', 'latin-ext'],
});

const ease = Easing.bezier(0.2, 0.8, 0.2, 1);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
/** 0 before `a`, 1 after `b`, eased between. */
const ramp = (f: number, a: number, b: number) => interpolate(f, [a, b], [0, 1], { ...clamp, easing: ease });
/** Eased keyframes. */
const keys = (f: number, at: number[], values: number[]) =>
  interpolate(f, at, values, { ...clamp, easing: Easing.inOut(Easing.cubic) });
/** Fades in over 10 frames from `a` and out over 10 frames from `b`. */
const vis = (f: number, a: number, b: number) => Math.min(ramp(f, a, a + 10), 1 - ramp(f, b, b + 10));

// ---- the timeline -------------------------------------------------------

type Tap = { f: number; sel: string; at?: [number, number]; quiet?: boolean };
// The music is 100 BPM and its downbeats fall on frames 5 + 18n (see README).
// Touches sit on those beats, and PAID_AT is the track's big lift.
/** Every touch in the film. Each one presses its control and rings the liquid. */
const TAPS: Tap[] = [
  { f: 20, sel: '', at: [W / 2, H / 2], quiet: true },
  { f: 167, sel: 'p:create' },
  { f: 347, sel: 'p:key-1' },
  { f: 383, sel: 'p:key-2' },
  { f: 419, sel: 'p:key-5' },
  { f: 455, sel: 'p:key-0' },
  { f: 491, sel: 'p:charge' },
  { f: 689, sel: 'p:preset-Oat latte' },
  { f: 761, sel: 'p:charge', at: [1340, 968] },
  { f: 1190, sel: '', at: [1255, 540], quiet: true },
  { f: 1301, sel: 't:till' },
  { f: 1462, sel: '', at: [W / 2, H / 2], quiet: true },
];
const DRAG = { from: 610, to: 650, sel: 'p:presets', dx: -270 };
const PAID_AT = 905;
const RIPPLE_FRAMES = 2.6 * FPS;

const ITEMS: [string, number][] = [
  ['Flat white', 450],
  ['Cortado', 400],
  ['Croissant', 375],
  ['Oat latte', 525],
  ['Cold brew', 475],
  ['Cookie', 250],
];

// ---- pieces of the product, wearing the app's own classes -----------------

function Logo({ size }: { size: number }) {
  return <Img src={icon} width={size} height={size} style={{ display: 'block' }} />;
}

function Qr({ value, style }: { value: string; style?: CSSProperties }) {
  const { size, d } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
    let path = '';
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.data[y * modules.size + x]) path += `M${x + 2} ${y + 2}h1v1h-1z`;
      }
    }
    return { size: modules.size + 4, d: path };
  }, [value]);
  return (
    <div className="qr" style={style}>
      <svg viewBox={`0 0 ${size} ${size}`} shapeRendering="crispEdges">
        <path d={d} fill="#000" />
      </svg>
    </div>
  );
}

function TillIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <rect x="7" y="3.5" width="10" height="5" rx="1.5" />
      <path d="M5.5 8.5h13l1.5 6.5H4z" />
      <rect x="3" y="15" width="18" height="5.5" rx="1.5" />
      <path d="M10 17.75h4" />
    </svg>
  );
}

const ICONS: Record<string, ReactNode> = {
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
};

function Icon({ name }: { name: string }) {
  return (
    <svg className="icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

/** The passkey moment: a face is recognised, then a tick. `p` runs 0 to 1. */
function PasskeyGlyph({ p, size = 96 }: { p: number; size?: number }) {
  const done = p >= 0.7;
  const pulse = 0.55 + 0.45 * Math.sin(p * Math.PI * 5);
  const pop = interpolate(p, [0.7, 0.85, 1], [0.6, 1.08, 1], clamp);
  return (
    <svg width={size} height={size} viewBox="0 0 96 96" fill="none" strokeLinecap="round" strokeLinejoin="round">
      <g stroke={done ? '#74e2a8' : '#f3f8f7'} strokeWidth="5" opacity={done ? 1 : pulse}>
        <path d="M8 30V18a10 10 0 0 1 10-10h12M66 8h12a10 10 0 0 1 10 10v12M88 66v12a10 10 0 0 1-10 10H66M30 88H18A10 10 0 0 1 8 78V66" />
      </g>
      {done ? (
        <path d="M30 50l13 13 24-28" stroke="#74e2a8" strokeWidth="7" transform={`translate(48 48) scale(${pop}) translate(-48 -48)`} />
      ) : (
        <g stroke="#f3f8f7" strokeWidth="5">
          <path d="M34 36v8M62 36v8M48 38v14h-5M35 62c8 7 18 7 26 0" />
        </g>
      )}
    </svg>
  );
}

function Bar({ dev, on }: { dev: string; on: (sel: string) => string }) {
  return (
    <header className="bar">
      <span className="brand">beepos</span>
      <span className={`till-btn${on(`${dev}:till`)}`} data-tap={`${dev}:till`}>
        <span className="dot synced" />
        <TillIcon />
      </span>
    </header>
  );
}

function Keypad({
  dev,
  on,
  cents,
  memo = '',
  busy = false,
  scroll = 0,
  picked = '',
}: {
  dev: string;
  on: (sel: string) => string;
  cents: number;
  memo?: string;
  busy?: boolean;
  scroll?: number;
  picked?: string;
}) {
  const shown = formatFiat(cents, 'USD');
  return (
    <section className="keypad-view">
      <output className={`amount${cents ? '' : ' zero'}`}>{shown}</output>
      <p className="convert">{formatBitcoin(toBitcoin(cents, 'USD', RATE))} · price from just now</p>
      <p className="hint">&nbsp;</p>
      <ul className="presets" data-tap={`${dev}:presets`}>
        {ITEMS.map(([name, price]) => (
          <li key={name} style={{ transform: `translateX(${scroll}px)` }}>
            <span
              className={`preset${on(`${dev}:preset-${name}`)}`}
              data-tap={`${dev}:preset-${name}`}
              aria-pressed={picked === name}
            >
              <span>{name}</span>
              <span className="preset-price">{formatFiat(price, 'USD')}</span>
            </span>
          </li>
        ))}
      </ul>
      <div className="memo" style={{ display: 'flex', alignItems: 'center', color: memo ? undefined : 'var(--muted)' }}>
        {memo || 'Memo (optional)'}
      </div>
      <div className="keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'].map((key) => (
          <span
            key={key}
            className={`key${on(`${dev}:key-${key}`)}`}
            data-tap={`${dev}:key-${key}`}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            {key}
          </span>
        ))}
      </div>
      <span
        className={`btn primary charge${on(`${dev}:charge`)}`}
        data-tap={`${dev}:charge`}
        style={{ display: 'grid', placeItems: 'center', opacity: cents && !busy ? 1 : 0.45 }}
      >
        {busy ? 'Making invoice…' : cents ? `Charge ${shown}` : 'Charge'}
      </span>
    </section>
  );
}

function LockCard({ dev, on, children }: { dev: string; on: (sel: string) => string; children?: ReactNode }) {
  return (
    <main className="lock">
      <div className="lock-card">
        <Logo size={72} />
        <h1>beepos</h1>
        {children ?? (
          <>
            <p className="muted">The cash register from the future. Start receiving Bitcoin today.</p>
            <div className="stack">
              <span className={`btn primary${on(`${dev}:create`)}`} data-tap={`${dev}:create`} style={{ display: 'grid', placeItems: 'center' }}>
                Create a passkey
              </span>
              <span className="btn ghost" style={{ display: 'grid', placeItems: 'center' }}>
                I already have a passkey
              </span>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function Device({
  kind,
  cx,
  cy,
  scale,
  ax,
  ay,
  opacity = 1,
  rotate = 0,
  children,
}: {
  kind: 'phone' | 'tablet';
  cx: number;
  cy: number;
  scale: number;
  ax?: number;
  ay?: number;
  opacity?: number;
  rotate?: number;
  children: ReactNode;
}) {
  if (opacity <= 0.001) return null;
  const w = kind === 'phone' ? 390 : 1180;
  const h = kind === 'phone' ? 844 : 820;
  const x = ax ?? w / 2;
  const y = ay ?? h / 2;
  return (
    <div
      className={`device ${kind}`}
      style={{
        left: cx - x * scale,
        top: cy - y * scale,
        width: w,
        height: h,
        opacity,
        transform: `scale(${scale}) rotate(${rotate}deg)`,
      }}
    >
      {kind === 'phone' && <div className="island" />}
      {children}
    </div>
  );
}

function Screen({ o, children }: { o: number; children: ReactNode }) {
  return o > 0.001 ? (
    <div className="screen" style={{ opacity: o }}>
      {children}
    </div>
  ) : null;
}

function Finder({ scan, qr, glyph }: { scan: number; qr?: boolean; glyph?: number }) {
  return (
    <div className="finder">
      <div style={{ position: 'relative', width: 230, height: 230, display: 'grid', placeItems: 'center' }}>
        {glyph !== undefined && glyph > 0 ? (
          <PasskeyGlyph p={glyph} size={150} />
        ) : (
          <>
            {qr && <Qr value={SITE} style={{ width: 170, margin: 0, opacity: 0.9, boxShadow: 'none' }} />}
            <svg width="230" height="230" viewBox="0 0 96 96" fill="none" stroke="#f3f8f7" strokeWidth="3" strokeLinecap="round" style={{ position: 'absolute', inset: 0 }}>
              <path d="M6 28V16A10 10 0 0 1 16 6h12M68 6h12a10 10 0 0 1 10 10v12M90 68v12a10 10 0 0 1-10 10H68M28 90H16A10 10 0 0 1 6 80V68" />
            </svg>
            {scan > 0 && scan < 1 && (
              <div
                style={{
                  position: 'absolute',
                  left: 18,
                  right: 18,
                  top: 20 + scan * 190,
                  height: 3,
                  borderRadius: 3,
                  background: 'var(--accent)',
                  boxShadow: '0 0 18px 4px rgba(245,183,0,.7)',
                }}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Caption({ f, from, to, x, y, size = 92, width = 640, align = 'left', children }: {
  f: number;
  from: number;
  to: number;
  x: number;
  y: number;
  size?: number;
  width?: number;
  align?: 'left' | 'center';
  children: ReactNode;
}) {
  const o = Math.min(ramp(f, from, from + 16), 1 - ramp(f, to - 12, to));
  if (o <= 0.001) return null;
  const rise = (1 - ramp(f, from, from + 22)) * 26;
  return (
    <div
      className="caption"
      style={{
        left: align === 'center' ? x - width / 2 : x,
        top: y + rise,
        width,
        fontSize: size,
        textAlign: align,
        opacity: o,
      }}
    >
      {children}
    </div>
  );
}

// ---- the film -------------------------------------------------------------

export function Film({ music, at }: { music: string | null; at?: number }) {
  const live = useCurrentFrame();
  const f = at ?? live;
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const gl = useRef<HTMLCanvasElement | null>(null);
  const draw = useRef<((frame: Frame) => void) | null>(null);
  const dots = useRef<(HTMLDivElement | null)[]>([]);
  const dragDot = useRef<HTMLDivElement>(null);

  const t = f / FPS;
  // The light drifts the way it does on a till left alone on a counter.
  const tiltX = Math.sin(t * 0.23 + 0.6) * 0.45;
  const tiltY = Math.cos(t * 0.17) * 0.35;

  const on = (sel: string) => (TAPS.some((tap) => tap.sel === sel && f >= tap.f - 1 && f < tap.f + 5) ? ' on' : '');

  // One pass per frame, after layout: find where each touch lands, place its
  // disc of light there, and hand the same points to the liquid as ripples.
  useLayoutEffect(() => {
    const paint = (): boolean => {
    const el = root.current;
    const cv = canvas.current;
    if (!el || !cv) return true;
    const box = el.getBoundingClientRect();
    // Not laid out yet (the renderer keeps the page hidden until fonts are in).
    if (!box.width) return false;
    const k = W / box.width;
    const find = (sel: string): [number, number] | null => {
      const hit = sel && el.querySelector(`[data-tap="${sel}"]`);
      if (!hit) return null;
      const b = hit.getBoundingClientRect();
      return [(b.left + b.width / 2 - box.left) * k, (b.top + b.height / 2 - box.top) * k];
    };

    const ripples = new Float32Array(MAX_RIPPLES * 3).fill(-1);
    let n = 0;
    TAPS.forEach((tap, i) => {
      const age = f - tap.f;
      const p = age > -9 && age < RIPPLE_FRAMES ? (find(tap.sel) ?? tap.at ?? null) : null;
      const dot = dots.current[i];
      if (dot) {
        const shown = p && !tap.quiet && age >= -8 && age <= 10;
        dot.style.opacity = shown ? String(age < 0 ? (age + 8) / 8 : 1 - age / 10) : '0';
        if (shown && p) {
          dot.style.left = `${p[0]}px`;
          dot.style.top = `${p[1]}px`;
          dot.style.transform = `scale(${age < 0 ? 1.3 - 0.4 * ((age + 8) / 8) : 0.9 + age * 0.03})`;
        }
      }
      if (p && age >= 0 && n < MAX_RIPPLES) {
        ripples[n * 3] = (p[0] / W - 0.5) * (W / H);
        ripples[n * 3 + 1] = 0.5 - p[1] / H;
        ripples[n * 3 + 2] = age / FPS;
        n++;
      }
    });

    const drag = dragDot.current;
    if (drag) {
      const p = f >= DRAG.from - 8 && f <= DRAG.to + 8 ? find(DRAG.sel) : null;
      const go = ramp(f, DRAG.from, DRAG.to);
      drag.style.opacity = p ? String(Math.min(ramp(f, DRAG.from - 8, DRAG.from), 1 - ramp(f, DRAG.to, DRAG.to + 8))) : '0';
      if (p) {
        drag.style.left = `${p[0] + 130 - go * 230}px`;
        drag.style.top = `${p[1]}px`;
      }
    }

    if (!gl.current) {
      // The shader draws off screen and each frame is copied to a plain canvas, so
      // the picture the renderer takes never depends on how WebGL is composited.
      gl.current = document.createElement('canvas');
      gl.current.width = cv.width;
      gl.current.height = cv.height;
      gl.current.getContext('webgl', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: true });
      draw.current = createLiquid(gl.current);
    }
    const sincePaid = (f - PAID_AT) / FPS;
    draw.current?.({
      time: 21 + t,
      tiltX,
      tiltY,
      breath: ramp(f, 780, 805) * (1 - ramp(f, PAID_AT - 4, PAID_AT + 6)),
      calm: ramp(f, PAID_AT, PAID_AT + 24) * (1 - ramp(f, 1020, 1070)),
      flood: sincePaid >= 0 && sincePaid < 6 ? sincePaid : -1,
      ripples,
    });
    cv.getContext('2d')?.drawImage(gl.current, 0, 0);
    return true;
    };
    if (paint()) return;
    const hold = delayRender('Waiting for layout');
    let timer: ReturnType<typeof setTimeout>;
    const retry = () => {
      if (paint()) continueRender(hold);
      else timer = setTimeout(retry, 10);
    };
    timer = setTimeout(retry, 10);
    return () => {
      clearTimeout(timer);
      continueRender(hold);
    };
  });

  // -- phone ----------------------------------------------------------------
  const typed = ['1', '2', '5', '0'].filter((_, i) => f >= [347, 383, 419, 455][i]).join('');
  const inShot3 = f < 520;
  // After the sale is paid the phone is back on an empty keypad.
  const picked = !inShot3 && f >= 689 && f < PAID_AT;
  const cents = inShot3 ? Number(typed || '0') : picked ? 525 : 0;
  const memo = picked ? 'Oat latte' : '';
  const busy = (f >= 491 && f < 520) || (f >= 761 && f < 790);
  const scroll = DRAG.dx * ramp(f, DRAG.from, DRAG.to);
  const sale = 525;

  const phone = {
    cx: keys(f, [1020, 1065], [1340, 330]),
    cy: 540 + (1 - ramp(f, 120, 165)) * 150,
    scale: keys(f, [300, 338, 520, 565, 1020, 1065], [1.1, 1.4, 1.4, 1.1, 1.1, 0.8]),
    ay: keys(f, [300, 338, 520, 565], [422, 450, 450, 422]),
    opacity: Math.min(ramp(f, 120, 150), 1 - ramp(f, 1290, 1320)),
  };
  const tablet = {
    cx: keys(f, [1290, 1330], [1255, 1300]),
    cy: 540 + (1 - ramp(f, 1030, 1075)) * 150 + ramp(f, 1440, 1475) * 120,
    opacity: Math.min(ramp(f, 1030, 1060), 1 - ramp(f, 1440, 1470)),
  };
  const customer = {
    cx: 930 + (1 - ramp(f, 805, 850)) * 500 - ramp(f, 965, 1005) * 200,
    opacity: Math.min(ramp(f, 805, 835), 1 - ramp(f, 965, 1000)),
  };
  const sheet = Math.min(ramp(f, 176, 192), 1 - ramp(f, 236, 248));
  const drawer = ramp(f, 1307, 1325);
  const glow = 0.5 + 0.5 * Math.sin((f - 1360) / 9);
  const end = ramp(f, 1458, 1490);

  return (
    <AbsoluteFill>
      <div
        ref={root}
        className="film"
        style={{ ['--font-manrope' as string]: fontFamily, ['--tilt-x' as string]: tiltX.toFixed(3), ['--tilt-y' as string]: tiltY.toFixed(3) }}
      >
        <canvas ref={canvas} className="liquid" width={1280} height={720} style={{ inset: 0, width: '100%', height: '100%' }} />

        {/* 1. The mark surfaces. */}
        {f < 130 && (
          <div className="endcard" style={{ opacity: Math.min(ramp(f, 14, 40), 1 - ramp(f, 100, 124)), flexDirection: 'row', gap: 36 }}>
            <div style={{ transform: `scale(${0.8 + 0.2 * ramp(f, 14, 50)})`, filter: 'drop-shadow(0 20px 50px rgba(245,183,0,.35))' }}>
              <Logo size={168} />
            </div>
            <div className="caption" style={{ position: 'static', fontSize: 168, opacity: ramp(f, 30, 58) }}>
              beepos
            </div>
          </div>
        )}

        <Caption f={f} from={136} to={296} x={150} y={420}>
          Set up in one tap.
        </Caption>
        <Caption f={f} from={312} to={512} x={150} y={420}>
          Type the price.
        </Caption>
        <Caption f={f} from={572} to={776} x={150} y={372}>
          Or tap what you sell most.
        </Caption>
        <Caption f={f} from={PAID_AT + 8} to={1016} x={150} y={420} size={150}>
          Paid.
        </Caption>
        <Caption f={f} from={1080} to={1286} x={W / 2} y={930} size={76} width={1400} align="center">
          One passkey opens it on your other devices.
        </Caption>
        <Caption f={f} from={1336} to={1440} x={130} y={372} width={620}>
          Cash out when you like.
        </Caption>

        {/* The customer's phone, for the scan. */}
        <Device kind="phone" cx={customer.cx} cy={610} scale={0.52} rotate={-6} opacity={customer.opacity}>
          <Finder scan={ramp(f, 852, PAID_AT - 6)} qr glyph={f >= PAID_AT ? 0.7 + 0.3 * ramp(f, PAID_AT, PAID_AT + 14) : 0} />
        </Device>

        {/* The owner's phone. */}
        <Device kind="phone" cx={phone.cx} cy={phone.cy} scale={phone.scale} ay={phone.ay} opacity={phone.opacity}>
          <Screen o={1 - ramp(f, 244, 256)}>
            <LockCard dev="p" on={on} />
            {sheet > 0.001 && (
              <div className="sheet" style={{ opacity: sheet, transform: `translateY(${(1 - sheet) * 60}px)` }}>
                <PasskeyGlyph p={ramp(f, 188, 232)} />
                <p className="muted">Passkey</p>
              </div>
            )}
          </Screen>
          <Screen o={Math.max(vis(f, 246, 505), vis(f, 520, 778), ramp(f, 1196, 1208))}>
            <div className="app">
              <Bar dev="p" on={on} />
              <main className="pane">
                <Keypad dev="p" on={on} cents={cents} memo={memo} busy={busy} scroll={inShot3 ? 0 : scroll} picked={memo} />
              </main>
            </div>
          </Screen>
          <Screen o={vis(f, 782, PAID_AT - 4)}>
            <div className="app">
              <Bar dev="p" on={on} />
              <main className="pane">
                <section className="center-view">
                  <p className="amount small">{formatBitcoin(toBitcoin(sale, 'USD', RATE))}</p>
                  <p className="muted">{formatFiat(sale, 'USD')} · Oat latte</p>
                  <div className="qr-link">
                    <Qr value={SITE} />
                  </div>
                  <p className="waiting">
                    <span className="pulse" style={{ opacity: 0.6 + 0.4 * Math.sin(f / 5.7) }} /> Waiting for payment…
                  </p>
                </section>
              </main>
            </div>
          </Screen>
          <Screen o={vis(f, PAID_AT, 1078)}>
            <div className="app">
              <Bar dev="p" on={on} />
              <main className="pane">
                <section className="center-view paid">
                  <div
                    className="check"
                    style={{ transform: `scale(${interpolate(f, [PAID_AT, PAID_AT + 10, PAID_AT + 18], [0.6, 1.08, 1], clamp)})` }}
                  >
                    ✓
                  </div>
                  <h2>Paid</h2>
                  <p className="amount small">{formatBitcoin(toBitcoin(sale, 'USD', RATE))}</p>
                  <p className="muted">{formatFiat(sale, 'USD')} · Oat latte</p>
                  <span className="btn primary" style={{ display: 'grid', placeItems: 'center' }}>
                    New sale
                  </span>
                </section>
              </main>
            </div>
          </Screen>
          <Screen o={vis(f, 1084, 1192)}>
            <Finder scan={ramp(f, 1100, 1142)} glyph={f >= 1146 ? ramp(f, 1146, 1186) : 0} />
          </Screen>
        </Device>

        {/* The second device: the same register, opened with the same passkey. */}
        <Device kind="tablet" cx={tablet.cx} cy={tablet.cy} scale={0.8} opacity={tablet.opacity}>
          <Screen o={1 - ramp(f, 1188, 1200)}>
            <LockCard dev="t" on={on}>
              <p className="muted">Use the passkey on your phone.</p>
              <Qr value={SITE} style={{ width: 210 }} />
            </LockCard>
          </Screen>
          <Screen o={ramp(f, 1190, 1204)}>
            <div className="app">
              <Bar dev="t" on={on} />
              <main className="pane">
                <Keypad dev="t" on={on} cents={0} />
              </main>
              {drawer > 0.001 && (
                <>
                  <div className="scrim" style={{ opacity: drawer }} />
                  <div className="vdrawer" style={{ transform: `translateX(${(1 - drawer) * 100}%)` }}>
                    <div className="wallet">
                      <div className="wallet-head">
                        <h2>Register</h2>
                        <span className="btn ghost" style={{ display: 'grid', placeItems: 'center' }}>
                          Done
                        </span>
                      </div>
                      <p className="amount small">{formatBitcoin(184_300)}</p>
                      <p className="muted sync-line">
                        <span className="dot synced" /> Backed up
                      </p>
                      <nav className="tiles">
                        {(['activity', 'items', 'settings'] as const).map((name) => (
                          <span key={name} className="tile">
                            <Icon name={name} />
                            {{ activity: 'Activity', items: 'Saved items', settings: 'Settings' }[name]}
                          </span>
                        ))}
                        <span
                          className="tile primary"
                          style={{
                            boxShadow: `inset 0 1px 0 rgba(255,255,255,.7), inset 0 -2px 0 rgba(120,78,0,.45), 0 10px ${28 + 26 * glow * ramp(f, 1350, 1370)}px -8px rgba(245,183,0,${0.6 + 0.35 * glow * ramp(f, 1350, 1370)})`,
                          }}
                        >
                          <Icon name="cashout" />
                          Cash out
                        </span>
                        <span className="tile wide">
                          <Icon name="lock" />
                          Lock
                        </span>
                      </nav>
                    </div>
                  </div>
                </>
              )}
            </div>
          </Screen>
        </Device>

        {/* 8. The end card. */}
        {end > 0.001 && (
          <div className="endcard" style={{ opacity: end, gap: 30 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 26, transform: `translateY(${(1 - end) * 24}px)` }}>
              <div style={{ filter: 'drop-shadow(0 16px 40px rgba(245,183,0,.35))' }}>
                <Logo size={112} />
              </div>
              <div className="caption" style={{ position: 'static', fontSize: 112 }}>
                beepos
              </div>
            </div>
            <div className="caption" style={{ position: 'static', fontSize: 66, opacity: ramp(f, 1484, 1512) }}>
              The cash register from the future.
              <br />
              Start receiving Bitcoin today.
            </div>
            <div style={{ fontSize: 36, fontWeight: 600, color: 'var(--accent)', opacity: ramp(f, 1506, 1530) }}>beepos.sbd.design</div>
            <div className="runs-on" style={{ opacity: ramp(f, 1524, 1548), marginTop: 18 }}>
              Lightning in · Cashu ecash · one passkey
            </div>
          </div>
        )}

        {TAPS.map((tap, i) => (
          <div key={i} ref={(el) => void (dots.current[i] = el)} className="touch" />
        ))}
        <div ref={dragDot} className="touch" />
      </div>
      {music && (
        <Audio
          src={staticFile(music)}
          volume={(frame) => Math.min(1, frame / 20) * Math.min(1, (DURATION - frame) / 45)}
        />
      )}
    </AbsoluteFill>
  );
}
