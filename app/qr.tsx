'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

export function Qr({ value, label }: { value: string; label: string }) {
  const [svg, setSvg] = useState('');
  useEffect(() => {
    let live = true;
    QRCode.toString(value, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' }).then(
      (out) => live && setSvg(out),
      () => live && setSvg(''),
    );
    return () => {
      live = false;
    };
  }, [value]);
  return (
    <div
      className="qr"
      role="img"
      aria-label={label}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
