// Records the trailer.
//   node build.mjs stills 3 14.9 27   -> PNGs of those moments in ./stills
//   node build.mjs video              -> events.json, music.wav, then "Slide It Trailer.mp4"
// Add --reel for the 9:16 Instagram version ("Slide It Reel.mp4").
// Needs the game served at http://localhost:8780 (python -m http.server 8780
// from the project folder) and Chrome installed.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const REEL = process.argv.includes('--reel');
const BASE = process.env.TRAILER_BASE || 'http://localhost:8780';
const URL = `${BASE}/trailer/index.html?capture=1${REEL ? '&format=reel' : ''}`;
const SIZE = REEL ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
const OUT_NAME = REEL ? 'Slide It Reel.mp4' : 'Slide It Trailer.mp4';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);
const FPS = 30;

async function openPage(browser) {
  const page = await browser.newPage();
  await page.setViewport({ ...SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text()); });
  await page.goto(URL, { waitUntil: 'networkidle0' });
  await page.waitForFunction('window.__ready === true', { timeout: 60000 });
  return page;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', cwd: here });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
  });
}

async function stills(browser, seconds) {
  const page = await openPage(browser);
  const cdp = await page.createCDPSession();
  mkdirSync(path.join(here, 'stills'), { recursive: true });
  let frame = 0;
  for (const s of seconds.sort((a, b) => a - b)) {
    const target = Math.round(s * FPS);
    await page.evaluate((from, to) => { for (let i = from + 1; i <= to; i++) window.__renderFrame(i); }, frame, target);
    frame = target;
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    const file = path.join(here, 'stills', `t${s.toFixed(2).padStart(5, '0')}.png`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    console.log('saved', file);
  }
}

// dry run: collect the exact moment of every sound effect, then build the music
async function music(browser) {
  const page = await openPage(browser);
  const frames = await page.evaluate(() => window.__FRAMES);
  const events = await page.evaluate((n) => {
    for (let i = 1; i < n; i++) window.__renderFrame(i);
    return window.__events;
  }, frames);
  writeFileSync(path.join(here, 'events.json'), JSON.stringify(events, null, 1));
  console.log(`events: ${events.length}`);
  await page.close();
  await run('python', ['music.py', 'events.json', 'music.wav']);
}

async function video(browser) {
  await music(browser);

  // record every frame and encode with the music
  const page = await openPage(browser);
  const frames = await page.evaluate(() => window.__FRAMES);
  const cdp = await page.createCDPSession();
  const out = path.join(here, '..', OUT_NAME);
  const ff = spawn('ffmpeg', [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-i', 'music.wav',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    out
  ], { cwd: here, stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => ff.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('ffmpeg ' + c)))));

  const started = Date.now();
  for (let i = 0; i < frames; i++) {
    if (i > 0) await page.evaluate((k) => window.__renderFrame(k), i);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 95 });
    if (!ff.stdin.write(Buffer.from(data, 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 150 === 0) console.log(`frame ${i}/${frames}  ${((Date.now() - started) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end();
  await done;
  console.log('wrote', out);
}

const [mode, ...rest] = process.argv.slice(2).filter((a) => a !== '--reel');
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio']
});
try {
  if (mode === 'stills') await stills(browser, rest.map(Number));
  else if (mode === 'music') await music(browser);
  else if (mode === 'video') await video(browser);
  else console.log('usage: node build.mjs stills <seconds...> | music | video');
} finally {
  await browser.close();
}
