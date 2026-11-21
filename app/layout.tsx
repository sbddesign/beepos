import type { Metadata, Viewport } from 'next';
import { Martian_Mono, Unbounded } from 'next/font/google';
import { Motion } from './fx/motion';
import './globals.css';

// Unbounded for the brand and the numerals, Martian Mono (condensed) for everything read.
const display = Unbounded({ subsets: ['latin'], variable: '--font-display', display: 'swap' });
const mono = Martian_Mono({
  subsets: ['latin'],
  axes: ['wdth'],
  variable: '--font-mono',
  display: 'swap',
});

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
  themeColor: '#08070f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${mono.variable}`}>
      <body>
        <Motion />
        {children}
      </body>
    </html>
  );
}
