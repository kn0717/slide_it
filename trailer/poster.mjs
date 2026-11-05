// Renders the 630x500 poster: "Slide It Poster.png" (exact size) and
// "Slide It Poster@2x.png" (1260x1000, same layout at double resolution).
// Needs the project served at http://localhost:8780.
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.TRAILER_BASE || 'http://localhost:8780';
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(existsSync);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--force-color-profile=srgb'] });
try {
  // --layers: each art piece as its own full-frame 2x PNG (transparent except
  // the background), for rebuilding the poster as an editable Canva design
  if (process.argv.includes('--layers')) {
    const dir = path.join(here, 'canva-layers');
    mkdirSync(dir, { recursive: true });
    for (const layer of ['bg', 'portal', 'cube', 'title']) {
      const page = await browser.newPage();
      await page.setViewport({ width: 630, height: 500, deviceScaleFactor: 2 });
      await page.goto(`${BASE}/trailer/poster.html?layer=${layer}`, { waitUntil: 'networkidle0' });
      await page.waitForFunction('window.__posterReady === true');
      const out = path.join(dir, `${layer}.png`);
      await (await page.$('#poster')).screenshot({ path: out, type: 'png', omitBackground: true });
      console.log('wrote', out);
      await page.close();
    }
    process.exit(0);
  }
  for (const [scale, name] of [[1, 'Slide It Poster.png'], [2, 'Slide It Poster@2x.png']]) {
    const page = await browser.newPage();
    await page.setViewport({ width: 630, height: 500, deviceScaleFactor: scale });
    await page.goto(`${BASE}/trailer/poster.html`, { waitUntil: 'networkidle0' });
    await page.waitForFunction('window.__posterReady === true');
    const poster = await page.$('#poster');
    const out = path.join(here, '..', name);
    await poster.screenshot({ path: out, type: 'png' });
    console.log('wrote', out);
    await page.close();
  }
} finally {
  await browser.close();
}
