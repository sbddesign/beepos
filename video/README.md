# beepos video

The product video, built with [Remotion](https://www.remotion.dev/). It is a package of its own: the app does not depend on it, the app's typecheck skips it, and Vercel does not upload it (`.vercelignore`). Only the rendered files in `public/video/` are part of the site.

The film uses the app's real look. It imports `app/globals.css` for the glass, `app/fx/shader.ts` for the liquid, `lib/fiat.ts` and `lib/format.ts` for amounts, and `public/icon.svg` for the mark. Change those and the next render follows.

## Render

```sh
cd video
npm install
npm run render
```

That writes the three files the `/about` page uses:

| File | What |
| --- | --- |
| `public/video/beepos.mp4` | H.264, 1280×720 |
| `public/video/beepos.webm` | VP9, 1280×720 |
| `public/video/beepos-poster.jpg` | The end card, 1280×720 |

A 1080p master is kept in `video/out/` (not committed). A render takes several minutes and needs about 1 GB of free disk.

## Music

Put the track at `video/public/music.mp3` and run `npm run render` again. The film fades it in and out. With no file there, the film is silent.

## Edit

```sh
npm run dev      # Remotion Studio, to scrub the timeline
```

Everything is in `src/Film.tsx`. The film is one 55-second timeline at 30 fps:

- `TAPS` lists every touch. Each one presses its control, shows a disc of light, and sends a ring through the liquid from wherever that control is on screen.
- Captions are the `<Caption>` lines; `from` and `to` are frame numbers.
- All motion comes from the frame number. CSS animations and transitions are switched off inside the film so every render is identical.

The words on screen follow `PRODUCT.md` and `DESIGN.md`: BIP-177 amounts, the app's own labels, and no claims the product cannot keep.

## Licence

Remotion is free for individuals and small teams and needs a company licence above that. See https://www.remotion.dev/license.
