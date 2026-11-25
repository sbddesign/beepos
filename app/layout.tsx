import type { Metadata, Viewport } from 'next';
import { Manrope } from 'next/font/google';
import { Liquid } from './fx/liquid';
import './globals.css';

// Manrope carries the ₿ sign (U+20BF) in its latin-ext subset, so amounts are set in one face.
const manrope = Manrope({
  subsets: ['latin', 'latin-ext'],
  variable: '--font-manrope',
  display: 'swap',
});

// Share images need absolute addresses. Previews and other hosts can set their own.
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://beepos.sbd.design';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'beepos',
  description: 'The cash register from the future. Start receiving Bitcoin today.',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icon.svg' },
  appleWebApp: { capable: true, title: 'beepos', statusBarStyle: 'black-translucent' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#04121c',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={manrope.variable}>
      <body>
        <Liquid />
        {children}
      </body>
    </html>
  );
}
