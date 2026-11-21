'use client';

import { useEffect } from 'react';

// Where the "light" falls on the foil. Writes --tx and --ty (each -1..1) on <html>
// once per frame, from the best source available:
//   1. device tilt (phones and tablets),
//   2. the mouse pointer (desktops),
//   3. a slow drift when neither has moved lately, so a register on a counter stays alive.
// With prefers-reduced-motion it writes nothing and the CSS defaults give a still foil.

type OrientationCtor = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

const TILT_RANGE = 28; // degrees of tilt that take the light from centre to edge
const IDLE_MS = 3500;
const PRESSABLE = '.key, .btn, .balance';

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

export function Motion() {
  useEffect(() => {
    const root = document.documentElement;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)');

    // The foil flares under the finger, with or without motion.
    const onDown = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.(PRESSABLE) as HTMLElement | null;
      if (!el || (el as HTMLButtonElement).disabled) return;
      const box = el.getBoundingClientRect();
      el.style.setProperty('--px', `${((e.clientX - box.left) / box.width) * 100}%`);
      el.style.setProperty('--py', `${((e.clientY - box.top) / box.height) * 100}%`);
      if (el.classList.contains('key')) navigator.vibrate?.(8);
    };
    document.addEventListener('pointerdown', onDown, { passive: true });

    if (still.matches) {
      return () => document.removeEventListener('pointerdown', onDown);
    }

    let targetX = 0;
    let targetY = 0;
    let x = 0;
    let y = 0;
    let lastInput = -Infinity;
    let frame = 0;
    // The resting posture of the hand counts as level: the baseline follows slowly.
    let baseBeta: number | null = null;
    let baseGamma: number | null = null;

    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      if (baseBeta == null || baseGamma == null) {
        baseBeta = e.beta;
        baseGamma = e.gamma;
      }
      baseBeta += (e.beta - baseBeta) * 0.004;
      baseGamma += (e.gamma - baseGamma) * 0.004;
      const nx = clamp((e.gamma - baseGamma) / TILT_RANGE);
      const ny = clamp((e.beta - baseBeta) / TILT_RANGE);
      // A phone lying flat reports noise; only real movement counts as input.
      if (Math.abs(nx - targetX) + Math.abs(ny - targetY) > 0.01) lastInput = performance.now();
      targetX = nx;
      targetY = ny;
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      targetX = clamp((e.clientX / window.innerWidth) * 2 - 1);
      targetY = clamp((e.clientY / window.innerHeight) * 2 - 1);
      lastInput = performance.now();
    };

    // Listening is harmless where tilt is withheld: no events arrive. Browsers that gate
    // tilt (iOS, newer Chrome) open it after a system prompt, which has to come from a
    // tap. Ask on the first tap inside the unlocked register, never on the lock screen, so
    // the prompt can't land on top of the passkey sheet. A refusal just means no tilt.
    const Orientation = window.DeviceOrientationEvent as OrientationCtor | undefined;
    const askOnTap = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.app')) return;
      document.removeEventListener('click', askOnTap, true);
      Orientation?.requestPermission?.().catch(() => {});
    };
    if (Orientation) {
      window.addEventListener('deviceorientation', onTilt);
      if (typeof Orientation.requestPermission === 'function') {
        document.addEventListener('click', askOnTap, true);
      }
    }
    window.addEventListener('pointermove', onMove, { passive: true });

    const tick = (now: number) => {
      let gx = targetX;
      let gy = targetY;
      if (now - lastInput > IDLE_MS) {
        const t = now / 1000;
        gx = Math.sin(t * 0.31) * 0.75;
        gy = Math.cos(t * 0.23) * 0.5;
      }
      const nx = x + (gx - x) * 0.07;
      const ny = y + (gy - y) * 0.07;
      if (Math.abs(nx - x) + Math.abs(ny - y) > 0.0004) {
        x = nx;
        y = ny;
        root.style.setProperty('--tx', x.toFixed(4));
        root.style.setProperty('--ty', y.toFixed(4));
      }
      frame = requestAnimationFrame(tick);
    };
    const onVisible = () => {
      cancelAnimationFrame(frame);
      if (document.visibilityState === 'visible') frame = requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', onVisible);
    onVisible();

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('click', askOnTap, true);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('deviceorientation', onTilt);
      window.removeEventListener('pointermove', onMove);
      root.style.removeProperty('--tx');
      root.style.removeProperty('--ty');
    };
  }, []);

  return null;
}
