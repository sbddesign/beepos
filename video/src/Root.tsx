import React from 'react';
import { Composition, Still } from 'remotion';
// The app's own stylesheet: the video wears the same glass as the product.
import '../../app/globals.css';
import './video.css';
import { DURATION, FPS, Film, POSTER_FRAME } from './Film';

export function Root() {
  return (
    <>
      <Composition
        id="Beepos"
        component={Film}
        width={1920}
        height={1080}
        fps={FPS}
        durationInFrames={DURATION}
        defaultProps={{ music: null as string | null }}
      />
      <Still id="Poster" component={Film} width={1920} height={1080} defaultProps={{ music: null, at: POSTER_FRAME }} />
      {/* The link preview for the site: 1200×630 once rendered at 0.625. */}
      <Still id="Share" component={Film} width={1920} height={1008} defaultProps={{ music: null, at: POSTER_FRAME, share: true }} />
    </>
  );
}
