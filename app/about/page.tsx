import type { Metadata } from 'next';
import Link from 'next/link';
import { AboutVideo } from './video';

// A public page: what beepos is, on video, and the way in. It opens no register
// and reads nothing from the device.

const TITLE = 'What is beepos?';
const DESCRIPTION =
  'The cash register from the future. Watch how it works, then start receiving Bitcoin today.';

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  openGraph: { title: TITLE, description: DESCRIPTION, type: 'website', url: '/about' },
  twitter: { card: 'summary_large_image', title: TITLE, description: DESCRIPTION },
};

export default function About() {
  return (
    <main className="about">
      <article className="about-card">
        <header className="about-head">
          <img src="/icon.svg" alt="" width={44} height={44} />
          <span className="brand">beepos</span>
        </header>
        <h1>The cash register from the future.</h1>
        <AboutVideo />
        <p className="muted">
          Take Bitcoin payments in seconds. One passkey sets it up, and opens your register on
          another compatible device.
        </p>
        <Link className="btn primary about-go" href="/">
          Get started
        </Link>
        <p className="about-fine">Lightning payments. Cashu ecash. Open source.</p>
      </article>
    </main>
  );
}
