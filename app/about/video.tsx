'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * The product video. While it plays, the page around it goes dark: the film is made
 * of the same liquid as the background, and the two would compete. The state lives
 * on <html data-watching> so plain CSS can answer it (see "About page" in globals.css).
 *
 * Until it is started, and again once it has ended, the video is a faded poster under
 * one big play button, with no controls. Starting it brings the browser's own controls,
 * which stay through a pause.
 */
export function AboutVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [started, setStarted] = useState(false);
  // A double click (or a second tap) on the big button would land on the video that
  // takes its place, and the browser's own click-to-pause would stop it at once. So the
  // video ignores the pointer for a moment after it is started.
  const [settling, setSettling] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const root = document.documentElement;
    const sync = () => {
      const watching = !video.paused && !video.ended;
      // However it was started (the button, a keyboard, a script), it has started.
      if (watching) setStarted(true);
      else if (video.ended) setStarted(false);
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

  const play = () => {
    const video = ref.current;
    if (!video) return;
    if (video.ended) video.currentTime = 0;
    setStarted(true);
    setSettling(true);
    window.setTimeout(() => setSettling(false), 700);
    // Refused or failed (no network, no codec): back to the poster and the button.
    video.play().then(
      () => video.focus(),
      () => setStarted(false),
    );
  };

  return (
    <div className={`about-player${started ? ' started' : ''}`}>
      <video
        ref={ref}
        className="about-video"
        controls={started}
        playsInline
        preload="metadata"
        poster="/video/beepos-poster.jpg"
        aria-label="A one-minute video about beepos"
        tabIndex={started ? 0 : -1}
        style={settling ? { pointerEvents: 'none' } : undefined}
      >
        <source src="/video/beepos.webm" type="video/webm" />
        <source src="/video/beepos.mp4" type="video/mp4" />
      </video>
      {!started && (
        <button className="about-play" onClick={play} aria-label="Play the video">
          <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden>
            <path d="M8.5 5.6v12.8a1 1 0 0 0 1.5.86l10.6-6.4a1 1 0 0 0 0-1.72L10 4.74a1 1 0 0 0-1.5.86z" fill="currentColor" />
          </svg>
        </button>
      )}
    </div>
  );
}
