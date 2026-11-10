// Records the promo trailer frame by frame from the real game (headless Chrome + GPU), then
// encodes MP4s with ffmpeg. Needs the game server running (npm start) and, once:
//   npm i -D puppeteer-core ffmpeg-static
// Usage: node tools/record-trailer.mjs <v|h> <it|en> [--frames=0,120,300] [--out=promo]
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const aspect = args[0] || 'v';
const lang = args[1] || 'it';
const opt = Object.fromEntries(args.filter(a => a.startsWith('--')).map(a => a.slice(2).split('=')));
const outDir = path.resolve(opt.out || 'promo', `frames_${aspect}_${lang}`);
fs.mkdirSync(outDir, { recursive: true });
const vp = aspect === 'v' ? { width: 540, height: 960, deviceScaleFactor: 2 } : { width: 1280, height: 720, deviceScaleFactor: 1.5 };
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  args: ['--headless=new', '--enable-gpu', '--use-angle=gl', '--ignore-gpu-blocklist', '--no-sandbox', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage();
await page.setViewport(vp);
page.on('console', m => { if (m.type() === 'error') console.log('[page]', m.text()); });
page.on('pageerror', e => console.log('[pageerror]', e.message));
await page.goto(`${process.env.SNOWLINE_URL || 'http://localhost:8787'}/?record`, { waitUntil: 'networkidle0', timeout: 120000 });
await page.evaluate(() => document.fonts.ready);
const info = await page.evaluate(async l => {
  localStorage.setItem('snowline.lang', l);
  const d = await import('./js/promo/director.js');
  window.__dir = d;
  return d.setup({ lang: l });
}, lang);
console.log('setup', info);
const list = opt.frames ? opt.frames.split(',').map(Number) : Array.from({ length: info.frames }, (_, i) => i);
const t0 = Date.now();
for (let i = 0; i < list.length; i++) {
  const f = list[i];
  // in preview mode, play the frames in between so stateful scenes (construction) still happen
  if (opt.frames) {
    const prev = i ? list[i - 1] + 1 : 0;
    for (let g = prev; g < f; g++) await page.evaluate(n => window.__dir.frame(n), g);
  }
  const r = await page.evaluate(n => window.__dir.frame(n), f);
  await page.screenshot({ path: path.join(outDir, `f${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 93 });
  if (i % 60 === 0) console.log(`frame ${f} (${r.scene}) ${Math.round((Date.now() - t0) / 1000)} s`);
}
await browser.close();
console.log('done', list.length, 'frames in', Math.round((Date.now() - t0) / 1000), 's ->', outDir);
if (!opt.frames) {
  // encode: with the soundtrack (npm run music) and a silent version for in-app trending audio
  const { default: ffmpeg } = await import('ffmpeg-static');
  const { execFileSync } = await import('node:child_process');
  const name = path.resolve(opt.out || 'promo', `snowline_trailer_${aspect === 'v' ? '9x16' : '16x9'}_${lang}`);
  const music = path.resolve(opt.out || 'promo', 'music.wav');
  const v = ['-framerate', '30', '-i', path.join(outDir, 'f%05d.jpg')];
  const enc = ['-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-movflags', '+faststart'];
  if (fs.existsSync(music)) execFileSync(ffmpeg, ['-loglevel', 'error', '-y', ...v, '-i', music, '-map', '0:v', '-map', '1:a', ...enc, '-c:a', 'aac', '-b:a', '192k', '-shortest', `${name}.mp4`]);
  execFileSync(ffmpeg, ['-loglevel', 'error', '-y', ...v, ...enc, `${name}_senza_musica.mp4`]);
  console.log('encoded', name);
}
