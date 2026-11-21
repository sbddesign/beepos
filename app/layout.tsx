import type { Metadata, Viewport } from 'next';
import { Barlow_Semi_Condensed, Tektur } from 'next/font/google';
import { MotionRoot } from './fx/motion-root';
import './globals.css';

// Legends are set in a DIN-like face; the readout gets a squared display face.
// Tektur carries the ₿ sign and Barlow does not, so Tektur is the fallback for it.
const legend = Barlow_Semi_Condensed({
  subsets: ['latin'],
  weight: ['500', '600', '700'],
  variable: '--font-legend',
});
const readout = Tektur({ subsets: ['latin'], weight: ['500', '700'], variable: '--font-readout' });

export const metadata: Metadata = {
  title: 'beepos',
  description: 'A point of sale that takes Lightning and keeps ecash. Your passkey is the only key.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
  appleWebApp: { capable: true, title: 'beepos', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#c6c9cd',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${legend.variable} ${readout.variable}`}>
      <body>
        <MotionRoot />
        {children}
      </body>
    </html>
  );
}
