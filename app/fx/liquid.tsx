'use client';

import { useEffect, useRef } from 'react';
import { Motion } from './motion';
import { MAX_RIPPLES, createLiquid, type Frame } from './shader';

export type Mood = 'idle' | 'waiting' | 'paid';

const RIPPLE_LIFE = 2.6;
// The liquid is soft and sits under glass, so it is drawn well below screen resolution.
const RESOLUTION = 0.66;
const MAX_DPR = 1.5;
const STILL_TIME = 21;

type Ripple = { x: number; y: number; born: number };

const state = {
  mood: 'idle' as Mood,
  floodAt: -1,
  ripples: [] as Ripple[],
  /** Set while a canvas is mounted; redraws a still frame when motion is reduced. */
  poke: () => {},
};

/** What the till is doing, so the liquid can answer it. */
export function setMood(mood: Mood) {
  if (mood === state.mood) return;
  if (mood === 'paid') state.floodAt = performance.now();
  state.mood = mood;
  state.poke();
}

function ripple(el: Element) {
  const box = el.getBoundingClientRect();
  state.ripples.push({
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    born: performance.now(),
  });
  if (state.ripples.length > MAX_RIPPLES) state.ripples.shift();
}

export function Liquid() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const root = document.documentElement;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const motion = new Motion();
    let draw: ReturnType<typeof createLiquid> = null;
    let raf = 0;
    let last = 0;
    let breath = 0;
    let calm = 0;
    let shownX = NaN;
    let shownY = NaN;
    const ripples = new Float32Array(MAX_RIPPLES * 3);

    const setup = () => {
      draw = createLiquid(canvas);
      root.classList.toggle('no-liquid', !draw);
    };

    const resize = () => {
      const scale = Math.min(devicePixelRatio || 1, MAX_DPR) * RESOLUTION;
      canvas.width = Math.max(2, Math.round(innerWidth * scale));
      canvas.height = Math.max(2, Math.round(innerHeight * scale));
    };

    const render = (now: number, still: boolean) => {
      const w = innerWidth;
      const h = innerHeight;
      const live = state.ripples.filter((r) => now - r.born < RIPPLE_LIFE * 1000);
      state.ripples = live;
      ripples.fill(-1);
      if (!still) {
        live.forEach((r, i) => {
          ripples[i * 3] = (r.x / w - 0.5) * (w / h);
          ripples[i * 3 + 1] = 0.5 - r.y / h;
          ripples[i * 3 + 2] = (now - r.born) / 1000;
        });
      }
      const flood = state.mood === 'paid' && !still ? (now - state.floodAt) / 1000 : -1;
      const frame: Frame = {
        time: still ? STILL_TIME : now / 1000,
        tiltX: motion.x,
        tiltY: motion.y,
        breath: still ? 0 : breath,
        calm: still ? (state.mood === 'paid' ? 1 : 0) : calm,
        flood: flood >= 0 && flood < 6 ? flood : -1,
        ripples,
      };
      draw?.(frame);
    };

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000 || 0);
      last = now;
      motion.step(now, dt);
      const k = 1 - Math.exp(-dt * 2.2);
      breath += ((state.mood === 'waiting' ? 1 : 0) - breath) * k;
      calm += ((state.mood === 'paid' ? 1 : 0) - calm) * k;
      // One style write per frame, and only when the light has actually moved.
      if (Math.abs(motion.x - shownX) > 0.002 || Math.abs(motion.y - shownY) > 0.002) {
        shownX = motion.x;
        shownY = motion.y;
        root.style.setProperty('--tilt-x', shownX.toFixed(3));
        root.style.setProperty('--tilt-y', shownY.toFixed(3));
      }
      render(now, false);
      raf = requestAnimationFrame(tick);
    };

    const run = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      if (document.hidden) return;
      if (reduced.matches) {
        root.style.setProperty('--tilt-x', '0');
        root.style.setProperty('--tilt-y', '0');
        motion.x = motion.y = 0;
        render(performance.now(), true);
      } else {
        last = performance.now();
        raf = requestAnimationFrame(tick);
      }
    };

    const onResize = () => {
      resize();
      if (reduced.matches) run();
    };
    const onLost = (e: Event) => {
      e.preventDefault();
      draw = null;
      root.classList.add('no-liquid');
    };
    const onRestored = () => {
      setup();
      run();
    };
    const onPress = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('.key, .btn');
      if (!el || (el as HTMLButtonElement).disabled) return;
      if (!reduced.matches) ripple(el);
      if (el.classList.contains('key')) navigator.vibrate?.(8);
    };
    const onKey = (e: KeyboardEvent) => {
      if (reduced.matches || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as Element | null)?.tagName === 'INPUT') return;
      const label = /^\d$/.test(e.key) ? e.key : e.key === 'Backspace' ? 'Delete last digit' : '';
      const el = label && document.querySelector(`.key[aria-label="${label}"]`);
      if (el) ripple(el);
    };

    setup();
    resize();
    motion.start();
    state.poke = () => reduced.matches && run();
    run();

    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
    window.addEventListener('resize', onResize);
    window.addEventListener('pointerdown', onPress, { passive: true });
    window.addEventListener('keydown', onKey);
    document.addEventListener('visibilitychange', run);
    reduced.addEventListener('change', run);

    return () => {
      cancelAnimationFrame(raf);
      motion.end();
      state.poke = () => {};
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', onPress);
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('visibilitychange', run);
      reduced.removeEventListener('change', run);
    };
  }, []);

  return <canvas ref={ref} className="liquid" aria-hidden />;
}
