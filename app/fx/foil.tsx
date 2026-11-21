import type { CSSProperties, ReactNode } from 'react';

/** An amount with the ₿ set as its own mark, so the display face never has to supply it. */
export function Amount({ text }: { text: string }) {
  if (!text.startsWith('₿')) return <>{text}</>;
  return (
    <>
      <span className="bmark">₿</span>
      {text.slice(1)}
    </>
  );
}

/** Lets the amount shrink to fit: CSS reads the character count. */
export function lenStyle(text: string): CSSProperties {
  return { '--len': text.length } as CSSProperties;
}

const MICRO = 'BEEPOS · LIGHTNING · ECASH · '.repeat(12);

/** The mount for a QR code: a foil-edged ticket with a ring of microprint. */
export function Ticket({ children }: { children: ReactNode }) {
  return (
    <span className="ticket">
      {(['top', 'right', 'bottom', 'left'] as const).map((side) => (
        <span key={side} className={`micro ${side}`} aria-hidden>
          {MICRO}
        </span>
      ))}
      {children}
    </span>
  );
}

// A guilloché rosette, the lathe-work on banknotes and passports: bands of sine waves
// wrapped around a circle, each band drawn several times at stepped phases.
function band(radius: number, depth: number, lobes: number, phase: number): string {
  const steps = 360;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const r = radius + depth * Math.sin(lobes * a + phase);
    d += `${i ? 'L' : 'M'}${(100 + r * Math.cos(a)).toFixed(2)} ${(100 + r * Math.sin(a)).toFixed(2)}`;
  }
  return `${d}Z`;
}

function rosette(): string {
  const paths: string[] = [];
  const bands = [
    { radius: 86, depth: 9, lobes: 24, copies: 6, width: 0.7 },
    { radius: 68, depth: 7, lobes: 16, copies: 6, width: 0.65 },
    { radius: 52, depth: 5, lobes: 12, copies: 4, width: 0.65 },
  ];
  for (const b of bands) {
    for (let i = 0; i < b.copies; i++) {
      const d = band(b.radius, b.depth, b.lobes, (i / b.copies) * Math.PI * 2);
      paths.push(`<path d="${d}" stroke-width="${b.width}"/>`);
    }
  }
  paths.push('<circle cx="100" cy="100" r="97.5" stroke-width="1.2"/>');
  paths.push('<circle cx="100" cy="100" r="76.5" stroke-width="0.6"/>');
  paths.push('<circle cx="100" cy="100" r="41" fill="#000" stroke="none"/>');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200" fill="none" stroke="#000">${paths.join('')}</svg>`;
}

let sealMask: string | undefined;

/** The paid seal: the rosette cut out of foil, with the check struck into its centre. */
export function Seal() {
  sealMask ??= `url("data:image/svg+xml,${encodeURIComponent(rosette())}")`;
  const style: CSSProperties = { maskImage: sealMask, WebkitMaskImage: sealMask };
  return (
    <div className="seal" aria-hidden>
      <span className="seal-foil" style={style} />
      <span className="seal-sweep" style={style} />
      <span className="seal-check">✓</span>
    </div>
  );
}
