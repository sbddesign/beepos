'use client';

import { useEffect, useRef } from 'react';

/**
 * The product video. While it plays, the page around it goes dark: the film is made
 * of the same liquid as the background, and the two would compete. The state lives
 * on <html data-watching> so plain CSS can answer it (see "About page" in globals.css).
 */
export function AboutVideo() {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const root = document.documentElement;
    const sync = () => {
      const watching = !video.paused && !video.ended;
      if (watching) root.dataset.watching = '';
      else delete root.dataset.watching;
    };
    const events = ['play', 'playing', 'pause', 'ended', 'emptied'] as const;
    events.forEach((name) => video.addEventListener(name, sync));
    sync();
    return () => {
      events.forEach((name) => video.removeEventListener(name, sync));
      delete root.dataset.watching;
    };
  }, []);

  return (
    <video
      ref={ref}
      className="about-video"
      controls
      playsInline
      preload="metadata"
      poster="/video/beepos-poster.jpg"
      aria-label="A one-minute video about beepos"
    >
      <source src="/video/beepos.webm" type="video/webm" />
      <source src="/video/beepos.mp4" type="video/mp4" />
    </video>
  );
}
