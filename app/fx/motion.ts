// One light source for the whole terminal. Device tilt moves it on a phone, the
// pointer moves it on a desktop, and with neither it drifts slowly so a register
// left on a counter still looks alive. The result is two CSS custom properties,
// --tilt-x and --tilt-y, each in [-1, 1], written at most once per frame.

type OrientationPermission = { requestPermission?: () => Promise<'granted' | 'denied'> };

const TILT_RANGE = 28; // degrees of tilt that move the light all the way across
const IDLE_MS = 2500; // after this long without input the drift takes over

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

export function startMotion(root: HTMLElement): () => void {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  let targetX = 0;
  let targetY = 0;
  let x = 0;
  let y = 0;
  let lastInput = -Infinity;
  let frame = 0;
  // The angle the device is usually held at reads as "level".
  let restBeta: number | null = null;
  let restGamma: number | null = null;

  const write = (tx: number, ty: number) => {
    root.style.setProperty('--tilt-x', tx.toFixed(3));
    root.style.setProperty('--tilt-y', ty.toFixed(3));
  };

  const onOrientation = (e: DeviceOrientationEvent) => {
    if (e.beta === null || e.gamma === null) return;
    if (restBeta === null || restGamma === null) {
      restBeta = e.beta;
      restGamma = e.gamma;
    }
    restBeta += (e.beta - restBeta) * 0.004;
    restGamma += (e.gamma - restGamma) * 0.004;
    targetX = clamp((e.gamma - restGamma) / TILT_RANGE);
    targetY = clamp((e.beta - restBeta) / TILT_RANGE);
    lastInput = performance.now();
  };

  const onPointer = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    targetX = clamp((e.clientX / window.innerWidth) * 2 - 1);
    targetY = clamp((e.clientY / window.innerHeight) * 2 - 1);
    lastInput = performance.now();
  };

  // iOS only hands out orientation after a tap, and asks the person first. We wait
  // for a tap inside the open register so the system prompt never lands on top of
  // the passkey sheet. Saying no just means the light drifts instead.
  const onFirstTap = (e: Event) => {
    if (!(e.target instanceof Element) || !e.target.closest('.app')) return;
    document.removeEventListener('click', onFirstTap, true);
    const ask = (window.DeviceOrientationEvent as unknown as OrientationPermission | undefined)
      ?.requestPermission;
    if (!ask) return;
    ask()
      .then((answer) => {
        if (answer === 'granted') window.addEventListener('deviceorientation', onOrientation);
      })
      .catch(() => {});
  };

  const tick = (now: number) => {
    frame = requestAnimationFrame(tick);
    let tx = targetX;
    let ty = targetY;
    if (now - lastInput > IDLE_MS) {
      const t = now / 1000;
      tx = Math.sin(t * 0.23) * 0.55;
      ty = Math.cos(t * 0.17) * 0.4;
    }
    const nx = x + (tx - x) * 0.07;
    const ny = y + (ty - y) * 0.07;
    if (Math.abs(nx - x) < 0.0005 && Math.abs(ny - y) < 0.0005) return;
    x = nx;
    y = ny;
    write(x, y);
  };

  const run = () => {
    cancelAnimationFrame(frame);
    if (reduced.matches) {
      // A fixed lamp, slightly up and to the left.
      x = -0.25;
      y = -0.25;
      write(x, y);
      return;
    }
    if (document.visibilityState === 'visible') frame = requestAnimationFrame(tick);
  };

  const needsAsk =
    typeof (window.DeviceOrientationEvent as unknown as OrientationPermission | undefined)
      ?.requestPermission === 'function';
  if (needsAsk) document.addEventListener('click', onFirstTap, true);
  else window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('pointermove', onPointer, { passive: true });
  document.addEventListener('visibilitychange', run);
  reduced.addEventListener('change', run);
  run();

  return () => {
    cancelAnimationFrame(frame);
    document.removeEventListener('click', onFirstTap, true);
    window.removeEventListener('deviceorientation', onOrientation);
    window.removeEventListener('pointermove', onPointer);
    document.removeEventListener('visibilitychange', run);
    reduced.removeEventListener('change', run);
  };
}
