// Records the looping gameplay clip shown on the main menu (assets/demo.gif).
//   node demo.mjs
// Plays one real level in the real game under the trailer's virtual clock, so
// every frame is exact, then turns the frames into a small palette GIF.
// Needs the game served at http://localhost:8780 (python serve.py 8780).
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TRAILER_BASE || 'http://localhost:8780';
const OUT = path.join(here, '..', 'assets', 'demo.gif');
const FRAMES = path.join(here, 'demo-frames');
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);
const FPS = 15;
const SIZE = { width: 960, height: 600 };
const LEVEL = { startX: -2.5, startY: 6, portalX: 9, portalY: 5.1 };
const EQUATION = '0.1x^2 - 3';

// same virtual clock as the trailer, but at 2x density (crisp, not huge)
const clock = readFileSync(path.join(here, 'clock.js'), 'utf8')
  .replace("get: () => 3", "get: () => 2");

rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio']
});
try {
  const page = await browser.newPage();
  await page.setViewport({ ...SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.evaluateOnNewDocument(clock);
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => document.fonts.ready);

  let n = 0;
  const shot = async () => {
    await page.screenshot({ path: path.join(FRAMES, `f${String(n++).padStart(4, '0')}.png`) });
  };
  const step = (frames = 1) => page.evaluate((ms) => window.__advance(ms), (1000 / FPS) * frames);
  const hold = async (seconds) => {
    for (let i = 0; i < Math.round(seconds * FPS); i++) {
      await step();
      await shot();
    }
  };

  await page.evaluate((L) => {
    startScreen.hidden = true;
    round = 1;
    level = L;
    beginLevel('Enter an equation and press Start');
    eqInput.focus();
  }, LEVEL);
  await hold(0.6);

  // type it a character at a time, so the typeset preview builds up live
  for (let k = 1; k <= EQUATION.length; k++) {
    await page.evaluate((v) => {
      eqInput.value = v;
      eqInput.dispatchEvent(new Event('input'));
    }, EQUATION.slice(0, k));
    await step(2);
    await shot();
  }
  await hold(0.5);

  await page.evaluate(() => startBtn.click());
  for (let i = 0; i < FPS * 8; i++) {
    await step();
    await shot();
    if (await page.evaluate(() => !resultEl.hidden)) break;
  }
  await hold(1.4);
  console.log(`${n} frames`);
} finally {
  await browser.close();
}

await new Promise((resolve, reject) => {
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(FRAMES, 'f%04d.png'),
    '-vf', 'scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    '-loop', '0', OUT
  ], { stdio: 'inherit' });
  ff.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});
rmSync(FRAMES, { recursive: true, force: true });
console.log('wrote', OUT);
