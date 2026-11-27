// One command: renders the film and writes the three files the /about page uses.
//   npm run render
// Put a track at video/public/music.mp3 first to render with music; without it
// the film is silent.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const out = path.join(here, '..', 'public', 'video');
const master = path.join(here, 'out', 'beepos-master.mp4');
const music = existsSync(path.join(here, 'public', 'music.mp3')) ? 'music.mp3' : null;
const run = (args) => execFileSync('npx', ['remotion', ...args], { cwd: here, stdio: 'inherit' });

mkdirSync(out, { recursive: true });
mkdirSync(path.dirname(master), { recursive: true });
console.log(music ? 'Rendering with public/music.mp3' : 'Rendering silent (no public/music.mp3)');

// A near-lossless 1080p master, then the two web files from it at 720p.
run(['render', 'Beepos', master, '--codec=h264', '--crf=14', `--props=${JSON.stringify({ music })}`]);
const audio = music ? [] : ['-an'];
run(['ffmpeg', '-y', '-i', master, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'slow',
  '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-map_metadata', '-1',
  ...(music ? ['-c:a', 'aac', '-b:a', '128k'] : audio), path.join(out, 'beepos.mp4')]);
run(['ffmpeg', '-y', '-i', master, '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libvpx-vp9', '-b:v', '0',
  '-crf', '36', '-row-mt', '1', '-map_metadata', '-1',
  ...(music ? ['-c:a', 'libopus', '-b:a', '96k'] : audio), path.join(out, 'beepos.webm')]);
run(['still', 'Poster', path.join(out, 'beepos-poster.jpg'), '--image-format=jpeg', '--jpeg-quality=88', '--scale=0.6667']);
// The link preview, used by / and /about.
const app = path.join(here, '..', 'app');
const share = path.join(app, 'opengraph-image.jpg');
run(['still', 'Share', share, '--image-format=jpeg', '--jpeg-quality=88', '--scale=0.625']);
for (const copy of ['twitter-image.jpg', 'about/opengraph-image.jpg', 'about/twitter-image.jpg']) {
  execFileSync('cp', [share, path.join(app, copy)]);
}
console.log(`Wrote ${out}/beepos.mp4, beepos.webm, beepos-poster.jpg and the share images in app/`);
