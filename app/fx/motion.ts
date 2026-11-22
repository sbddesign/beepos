// Where the light comes from: device tilt on phones, the pointer on desktops,
// and a slow drift of its own when there is neither (a till sitting on a counter).

const clamp = (n: number) => Math.max(-1, Math.min(1, n));

type IOSOrientation = typeof DeviceOrientationEvent & {
  requestPermission?: () => Promise<'granted' | 'denied'>;
};

export class Motion {
  /** Smoothed tilt, each axis in -1..1. */
  x = 0;
  y = 0;
  private targetX = 0;
  private targetY = 0;
  private lastInput = -Infinity;
  private base: { beta: number; gamma: number } | null = null;
  private stop: (() => void)[] = [];

  start() {
    const onPointer = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      this.targetX = clamp((e.clientX / window.innerWidth) * 2 - 1);
      this.targetY = clamp((e.clientY / window.innerHeight) * 2 - 1);
      this.lastInput = performance.now();
    };
    const onTilt = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      // However the phone is held becomes level; the baseline follows slowly.
      if (!this.base) this.base = { beta: e.beta, gamma: e.gamma };
      this.base.beta += (e.beta - this.base.beta) * 0.01;
      this.base.gamma += (e.gamma - this.base.gamma) * 0.01;
      let dx = (e.gamma - this.base.gamma) / 25;
      let dy = (e.beta - this.base.beta) / 25;
      const angle = screen.orientation?.angle ?? 0;
      if (angle === 90) [dx, dy] = [dy, -dx];
      else if (angle === 270) [dx, dy] = [-dy, dx];
      else if (angle === 180) [dx, dy] = [-dx, -dy];
      this.targetX = clamp(dx);
      this.targetY = clamp(dy);
      this.lastInput = performance.now();
    };
    const listenTilt = () => window.addEventListener('deviceorientation', onTilt);

    // iOS only hands out orientation after a tap, through its own prompt. Ask on the
    // first tap inside the till, not on the lock screen, where that tap opens the
    // passkey sheet. A refusal just means no tilt.
    const ios = (globalThis.DeviceOrientationEvent as IOSOrientation | undefined)?.requestPermission;
    const onFirstTap = (e: MouseEvent) => {
      if (!(e.target as Element | null)?.closest?.('.app')) return;
      window.removeEventListener('click', onFirstTap, true);
      ios?.call(DeviceOrientationEvent).then(
        (answer) => answer === 'granted' && listenTilt(),
        () => {},
      );
    };
    if (ios) window.addEventListener('click', onFirstTap, true);
    else if ('DeviceOrientationEvent' in window) listenTilt();
    window.addEventListener('pointermove', onPointer, { passive: true });

    this.stop = [
      () => window.removeEventListener('deviceorientation', onTilt),
      () => window.removeEventListener('click', onFirstTap, true),
      () => window.removeEventListener('pointermove', onPointer),
    ];
  }

  end() {
    this.stop.forEach((fn) => fn());
    this.stop = [];
  }

  /** Advance the smoothing by `dt` seconds. */
  step(now: number, dt: number) {
    let tx = this.targetX;
    let ty = this.targetY;
    // Nothing moving it: wander slowly instead of freezing.
    const idle = Math.min(1, Math.max(0, (now - this.lastInput - 2500) / 2500));
    if (idle > 0) {
      const t = now / 1000;
      tx += (Math.sin(t * 0.23) * 0.45 - tx) * idle;
      ty += (Math.cos(t * 0.17) * 0.35 - ty) * idle;
    }
    const k = 1 - Math.exp(-dt * 6);
    this.x += (tx - this.x) * k;
    this.y += (ty - this.y) * k;
  }
}
