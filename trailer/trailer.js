// Slide It !! — 60 second trailer.
// Every frame is a pure function of its frame number: __renderFrame(i) sets
// up the scene for time i/30 s, steps the real game (running inside the
// iframe on a virtual clock) and positions the title cards. build.mjs calls
// it frame by frame and screenshots each one; opening this page normally
// plays a real-time preview.

const FPS = 30;
const DURATION = 60;
const FRAMES = FPS * DURATION;
const PARAMS = new URLSearchParams(location.search);
const CAPTURE = PARAMS.has('capture');

// 'wide' = 1920x1080 trailer, 'reel' = 1080x1920 for Instagram Reels / Shorts.
// The reel runs the game itself in portrait so its clips are real vertical
// gameplay, and keeps text out of Instagram's top bar, bottom caption area
// and right-hand button column.
const REEL = PARAMS.get('format') === 'reel';
const SW = REEL ? 1080 : 1920;
const SH = REEL ? 1920 : 1080;
if (REEL) document.documentElement.classList.add('reel');

const COL = {
  thistle: '#cdb4db',
  thistleDeep: '#b497c9',
  petal: '#ffc8dd',
  pink: '#ffafcc',
  icy: '#bde0fe',
  sky: '#a2d2ff',
  ink: '#3b2a4a',
  paper: '#fff3f8'
};

const stage = document.getElementById('stage');
const iframe = document.getElementById('game');
const gameWrap = document.getElementById('gameWrap');
const fxCanvas = document.getElementById('fx');
const fx = fxCanvas.getContext('2d');
const wipeCtx = document.getElementById('wipe').getContext('2d');
const el = {
  story: document.getElementById('story'),
  big: document.getElementById('big'),
  feature: document.getElementById('feature'),
  caption: document.getElementById('caption'),
  captionText: document.getElementById('captionText'),
  logo: document.getElementById('logo'),
  logoTitle: document.getElementById('logoTitle'),
  tagline: document.getElementById('tagline'),
  cta: document.getElementById('cta'),
  fade: document.getElementById('fade')
};

// ---------- small helpers ----------
const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
const prog = (t, a, b) => clamp((t - a) / (b - a));
const easeOutCubic = (k) => 1 - (1 - k) ** 3;
const easeInCubic = (k) => k * k * k;
const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2);
const easeOutBack = (k) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
};
const easeOutBounce = (x) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (x < 1 / d1) return n1 * x * x;
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75;
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375;
  return n1 * (x -= 2.625 / d1) * x + 0.984375;
};

// ---------- event log (drives the sound effects in music.py) ----------
window.__events = [];
let tNow = 0;
let tPrev = -1;
const crossed = (T) => T > tPrev && T <= tNow;
function event(type, at = tNow) {
  window.__events.push({ t: Math.round(at * 1000) / 1000, type });
}
function eventAt(T, type) {
  if (crossed(T)) event(type, T);
}

// ---------- the game inside the iframe ----------
let gw = null;
const gEval = (code) => gw.eval(code);
const GAME_W = REEL ? 720 : 1280;
const GAME_H = REEL ? 1280 : 720;
const GAME_PX = 32;
const BASE_SCALE = SW / GAME_W;
iframe.style.width = `${GAME_W}px`;
iframe.style.height = `${GAME_H}px`;
for (const c of [fxCanvas, document.getElementById('wipe')]) {
  c.width = SW;
  c.height = SH;
  c.style.width = `${SW}px`;
  c.style.height = `${SH}px`;
}

async function loadGame() {
  const html = await (await fetch('../index.html', { cache: 'no-store' })).text();
  const injected = html.replace(
    '<head>',
    '<head><base href="../"><script src="trailer/clock.js"></script>'
  );
  await new Promise((resolve) => {
    iframe.onload = resolve;
    iframe.srcdoc = injected;
  });
  gw = iframe.contentWindow;
  await gw.document.fonts.ready;
  gEval('startScreen.hidden = true;');
  if (REEL) {
    // keep the panel's title and level badge below Instagram's top bar
    gw.document.head.insertAdjacentHTML('beforeend', '<style>.panel { top: 150px !important; }</style>');
  }
  gw.__advance(1000 / FPS);
}

// The game's camera (camX/camY). The reel nudges it up so each level sits in
// the middle of the tall frame instead of the top half.
const CAM = { x: 0, y: 0 };
const REEL_CAM_Y = 2;
function setGameCamera(x, y) {
  CAM.x = x;
  CAM.y = y;
  gEval(`camX = ${x}; camY = ${y};`);
}

const worldToGame = (x, y) => ({
  x: GAME_W / 2 + (x - CAM.x) * GAME_PX,
  y: GAME_H / 2 - (y - CAM.y) * GAME_PX
});

// Frame the game on the stage: zoom 1 shows all of it, higher zooms move in
// on (fx, fy) given in game pixels.
function viewGame(zoom, fxp, fyp) {
  const s = BASE_SCALE * zoom;
  let tx = SW / 2 - fxp * s;
  let ty = SH / 2 - fyp * s;
  tx = clamp(tx, SW - GAME_W * s, 0);
  ty = clamp(ty, SH - GAME_H * s, 0);
  iframe.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
}

// same, but aimed at a point in graph coordinates, so it works in both formats
function viewWorld(zoom, wx, wy) {
  const p = worldToGame(wx, wy);
  viewGame(zoom, p.x, p.y);
}

let gamePrev = null;
function stepGame(speed = 1) {
  gw.__advance((1000 / FPS) * speed);
  const s = JSON.parse(gEval(
    'JSON.stringify({ x: getCubePose().x, y: getCubePose().y, on: onCurve, ab: !!absorb, pop: !resultEl.hidden, ok: resultSuccess, run: running })'
  ));
  if (gamePrev) {
    if (s.on && !gamePrev.on) event('land');
    if (s.ab && !gamePrev.ab) event('portal');
    if (s.pop && !gamePrev.pop) event(s.ok ? 'win' : 'lose');
  }
  gamePrev = s;
  return s;
}

function setupLevel(L, roundNo, eq = '') {
  gEval(`
    clearTimeout(resultTimer);
    round = ${roundNo};
    level = ${JSON.stringify(L)};
    beginLevel('Enter an equation and press Start');
    eqInput.value = ${JSON.stringify(eq)};
    equationFn = null;
  `);
  setGameCamera(0, REEL ? REEL_CAM_Y : 0);
  gamePrev = null;
}

// zoom 1 framing of the whole game screen, wherever its camera points
const viewFull = (zoom = 1) => viewGame(zoom, GAME_W / 2, GAME_H / 2);

// visible = the press happens on screen (gets a click sound); montage shots
// start their runs off-screen during a cut
function pressStart(visible = true) {
  gEval(`
    startBtn.style.transform = 'translateY(5px)';
    startBtn.style.boxShadow = '0 0 0 #3b2a4a';
    startBtn.click();
  `);
  if (visible) event('press');
}

function releaseStart() {
  gEval(`startBtn.style.transform = ''; startBtn.style.boxShadow = '';`);
}

// fast-forward the game without drawing anything to the stage
function preRoll(seconds) {
  const n = Math.round(seconds * FPS);
  for (let i = 0; i < n; i++) gw.__advance(1000 / FPS);
  gamePrev = null;
}

function typeInto(text, startT, perChar) {
  for (let k = 1; k <= text.length; k++) eventAt(startT + (k - 1) * perChar, 'type');
  const n = clamp(Math.floor((tNow - startT) / perChar) + 1, 0, text.length);
  gEval(`eqInput.value = ${JSON.stringify(text.slice(0, n))};`);
}

// ---------- canvas art (ported from the game's own drawing code) ----------
function rrect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function circle(c, x, y, r) {
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
}

const blinking = (t) => (t * 1000) % 3200 < 140;

function drawCube(c, x, y, s, angle, mood, t) {
  const r = s * 0.16;
  c.save();
  c.translate(x, y);
  c.rotate(angle);
  c.fillStyle = 'rgba(0, 0, 0, 0.18)';
  rrect(c, -s / 2 + s * 0.06, -s / 2 + s * 0.08, s, s, r);
  c.fill();
  c.fillStyle = COL.pink;
  rrect(c, -s / 2, -s / 2, s, s, r);
  c.fill();
  c.fillStyle = COL.petal;
  rrect(c, -s / 2 + s * 0.12, -s / 2 + s * 0.12, s * 0.76, s * 0.5, r * 0.7);
  c.fill();
  c.fillStyle = 'rgba(255, 255, 255, 0.85)';
  rrect(c, -s / 2 + s * 0.16, -s / 2 + s * 0.12, s * 0.2, s * 0.08, s * 0.04);
  c.fill();
  c.lineWidth = Math.max(2, s * 0.08);
  c.strokeStyle = COL.ink;
  rrect(c, -s / 2, -s / 2, s, s, r);
  c.stroke();
  drawFace(c, s, mood, t);
  c.restore();
}

function drawFace(c, s, mood, t) {
  const eyeY = -s * 0.02;
  const eyeDX = s * 0.17;
  const mouthY = s * 0.22;
  const line = Math.max(1.5, s * 0.055);
  c.lineCap = 'round';
  c.lineJoin = 'round';
  c.strokeStyle = COL.ink;
  c.lineWidth = line;

  c.fillStyle = 'rgba(255, 120, 170, 0.45)';
  for (const side of [-1, 1]) {
    c.beginPath();
    c.ellipse(side * s * 0.3, s * 0.12, s * 0.08, s * 0.05, 0, 0, Math.PI * 2);
    c.fill();
  }

  if (mood === 'happy') {
    for (const side of [-1, 1]) {
      c.beginPath();
      c.arc(side * eyeDX, eyeY + s * 0.05, s * 0.08, Math.PI * 1.1, Math.PI * 1.9);
      c.stroke();
    }
    c.fillStyle = COL.ink;
    c.beginPath();
    c.arc(0, mouthY - s * 0.06, s * 0.15, 0, Math.PI);
    c.closePath();
    c.fill();
    c.fillStyle = '#ff7fa8';
    c.beginPath();
    c.ellipse(0, mouthY + s * 0.04, s * 0.07, s * 0.04, 0, 0, Math.PI * 2);
    c.fill();
    return;
  }

  c.fillStyle = COL.ink;
  for (const side of [-1, 1]) {
    if (blinking(t)) {
      c.beginPath();
      c.moveTo(side * eyeDX - s * 0.06, eyeY);
      c.lineTo(side * eyeDX + s * 0.06, eyeY);
      c.stroke();
    } else {
      c.beginPath();
      c.ellipse(side * eyeDX, eyeY, s * 0.05, s * 0.075, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = '#ffffff';
      circle(c, side * eyeDX + s * 0.015, eyeY - s * 0.03, s * 0.018);
      c.fill();
      c.fillStyle = COL.ink;
    }
  }
  c.beginPath();
  c.arc(0, mouthY - s * 0.08, s * 0.09, Math.PI * 0.2, Math.PI * 0.8);
  c.stroke();
}

function drawPortal(c, x, y, radius, t, scale = 1) {
  if (scale <= 0) return;
  const R = radius * scale * (1 + Math.sin(t * 3) * 0.04);
  const inner = R * 0.76;
  c.save();
  c.translate(x, y);

  const glow = c.createRadialGradient(0, 0, R * 0.7, 0, 0, R * 1.7);
  glow.addColorStop(0, 'rgba(205, 180, 219, 0.6)');
  glow.addColorStop(1, 'rgba(205, 180, 219, 0)');
  c.fillStyle = glow;
  circle(c, 0, 0, R * 1.7);
  c.fill();

  c.fillStyle = 'rgba(0, 0, 0, 0.18)';
  circle(c, R * 0.08, R * 0.1, R);
  c.fill();
  c.fillStyle = COL.thistle;
  circle(c, 0, 0, R);
  c.fill();

  c.fillStyle = COL.petal;
  for (let k = 0; k < 8; k++) {
    const a = t * 0.6 + (k / 8) * Math.PI * 2;
    circle(c, Math.cos(a) * (R + inner) / 2, Math.sin(a) * (R + inner) / 2, R * 0.06);
    c.fill();
  }

  c.save();
  circle(c, 0, 0, inner);
  c.clip();
  c.fillStyle = COL.ink;
  c.fillRect(-inner, -inner, inner * 2, inner * 2);
  c.rotate(-t * 2.4);
  const arms = [COL.sky, COL.pink, COL.icy, COL.petal];
  c.lineCap = 'round';
  c.lineWidth = inner * 0.24;
  for (let k = 0; k < arms.length; k++) {
    const base = (k / arms.length) * Math.PI * 2;
    c.strokeStyle = arms[k];
    c.beginPath();
    for (let sx = 0; sx <= 1.0001; sx += 0.05) {
      const r = inner * (0.14 + 0.95 * sx);
      const a = base + sx * 2.4;
      if (sx === 0) c.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else c.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    c.stroke();
  }
  const core = c.createRadialGradient(0, 0, 0, 0, 0, inner * 0.32);
  core.addColorStop(0, COL.ink);
  core.addColorStop(0.7, 'rgba(59, 42, 74, 0.9)');
  core.addColorStop(1, 'rgba(59, 42, 74, 0)');
  c.fillStyle = core;
  circle(c, 0, 0, inner * 0.32);
  c.fill();
  c.restore();

  c.strokeStyle = COL.ink;
  c.lineWidth = Math.max(3, R * 0.08);
  circle(c, 0, 0, inner);
  c.stroke();
  circle(c, 0, 0, R);
  c.stroke();
  c.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  c.lineWidth = Math.max(3, R * 0.07);
  c.lineCap = 'round';
  c.beginPath();
  c.arc(0, 0, R * 0.88, Math.PI * 1.1, Math.PI * 1.4);
  c.stroke();
  c.restore();
}

// The storybook grid. reveal 0..1 grows the lines out from the origin.
const GRID_ORIGIN_Y = REEL ? 1000 : 600;

function drawGrid(c, { reveal = 1, zoom = 1, panX = 0, alpha = 1 } = {}) {
  c.save();
  c.fillStyle = COL.paper;
  c.fillRect(0, 0, SW, SH);
  c.globalAlpha = alpha;
  c.translate(SW / 2, SH / 2);
  c.scale(zoom, zoom);
  c.translate(-SW / 2, -SH / 2);
  const u = 48;
  const ox = SW / 2 + panX;
  const oy = GRID_ORIGIN_Y;
  const maxK = REEL ? 30 : 26;
  const reach = Math.max(SW, SH) * 1.2;
  for (let k = -maxK; k <= maxK; k++) {
    const vis = clamp((reveal * (maxK + 6) - Math.abs(k)) / 4);
    if (vis <= 0) continue;
    const major = k % 5 === 0;
    if (k === 0) continue;
    c.strokeStyle = major ? COL.thistleDeep : COL.sky;
    c.lineWidth = major ? 2 : 1;
    const len = reach * easeOutCubic(vis);
    const x = Math.round(ox + k * u) + (major ? 0 : 0.5);
    c.beginPath();
    c.moveTo(x, oy - len);
    c.lineTo(x, oy + len);
    c.stroke();
    const y = Math.round(oy + k * u) + (major ? 0 : 0.5);
    c.beginPath();
    c.moveTo(ox - len, y);
    c.lineTo(ox + len, y);
    c.stroke();
  }
  const axis = easeInOut(prog(reveal, 0.35, 1));
  if (axis > 0) {
    c.strokeStyle = COL.ink;
    c.lineWidth = 4;
    c.beginPath();
    c.moveTo(ox - reach * axis, oy);
    c.lineTo(ox + reach * axis, oy);
    c.moveTo(ox, oy - reach * axis);
    c.lineTo(ox, oy + reach * axis);
    c.stroke();
  }
  c.restore();
}

// ---------- text layers ----------
function show(node, opacity, transform = '') {
  node.style.opacity = String(clamp(opacity));
  node.style.transform = transform;
}

function setWords(node, words, key) {
  if (node.dataset.key !== key) {
    node.dataset.key = key;
    node.innerHTML = words.map((w) => `<span>${w}</span>`).join('');
  }
  return [...node.children];
}

// words pop in one after another; returns overall opacity handling to caller
function popWords(node, words, key, times, outStart, outEnd) {
  const spans = setWords(node, words, key);
  spans.forEach((sp, i) => {
    const k = prog(tNow, times[i], times[i] + 0.38);
    const s = k > 0 ? easeOutBack(k) : 0;
    sp.style.transform = `scale(${s}) rotate(${(1 - k) * -8}deg)`;
    sp.style.opacity = k > 0 ? '1' : '0';
    eventAt(times[i], 'pop');
  });
  const out = prog(tNow, outStart, outEnd);
  show(node, 1 - out, `scale(${1 - 0.15 * easeInCubic(out)})`);
}

function storyText(text, tIn, tOut, top = REEL ? 1360 : 820) {
  if (el.story.textContent !== text) el.story.textContent = text;
  el.story.style.top = `${top}px`;
  const a = prog(tNow, tIn, tIn + 0.6);
  const b = prog(tNow, tOut, tOut + 0.45);
  show(el.story, easeOutCubic(a) * (1 - b), `translateY(${(1 - easeOutCubic(a)) * 30 - b * 20}px)`);
  eventAt(tIn, 'chime');
}

// Wide: lower-left chip, or centred at the top with 'top'. Reel: always
// centred, either just above Instagram's caption area or below its top bar.
function caption(text, tIn, tOut, where = 'corner') {
  if (el.captionText.textContent !== text) el.captionText.textContent = text;
  const a = prog(tNow, tIn, tIn + 0.45);
  const b = prog(tNow, tOut, tOut + 0.35);
  if (REEL) {
    el.caption.style.left = '50%';
    el.caption.style.top = where === 'top' ? '330px' : 'auto';
    el.caption.style.bottom = where === 'top' ? 'auto' : '470px';
    show(el.caption, a * (1 - b), `translateX(-50%) translateY(${(1 - easeOutBack(a)) * 40 + b * 20}px)`);
  } else if (where === 'top') {
    el.caption.style.left = '50%';
    el.caption.style.bottom = 'auto';
    el.caption.style.top = '64px';
    show(el.caption, a * (1 - b), `translateX(-50%) translateY(${(1 - easeOutBack(a)) * -40 - b * 20}px)`);
  } else {
    el.caption.style.left = '72px';
    el.caption.style.bottom = '72px';
    el.caption.style.top = 'auto';
    show(el.caption, a * (1 - b), `translateX(${(1 - easeOutBack(a)) * -60 + b * -40}px)`);
  }
  eventAt(tIn, 'pop');
}

// ---------- transitions ----------
const CUTS = [12.5, 20, 22.5, 30, 32.5, 40, 45, 52.5];

function drawWipes() {
  const c = wipeCtx;
  c.clearRect(0, 0, SW, SH);
  for (const T of CUTS) {
    eventAt(T - 0.3, 'whoosh');
    const p = prog(tNow, T - 0.3, T + 0.3);
    if (p <= 0 || p >= 1) continue;
    const S = REEL ? 560 : 420;
    const W = SW + 2 * S;
    const L = p < 0.5
      ? lerp(-W - 140, -S / 2, easeOutCubic(p * 2))
      : lerp(-S / 2, SW + S + 140, easeInCubic((p - 0.5) * 2));
    const band = (offset, width, color) => {
      c.fillStyle = color;
      c.beginPath();
      c.moveTo(L + offset, 0);
      c.lineTo(L + offset + width, 0);
      c.lineTo(L + offset + width - S, SH);
      c.lineTo(L + offset - S, SH);
      c.closePath();
      c.fill();
    };
    band(-120, 120, COL.sky);
    band(-60, 60, COL.pink);
    band(0, W, COL.thistle);
    band(W - 18, 18, COL.ink);
    // the mascot rides along in the middle of the wipe
    const cover = 1 - Math.abs(p - 0.5) * 2;
    if (cover > 0.55) {
      const mid = L + W / 2 - S / 2;
      drawCube(c, clamp(mid, 200, SW - 200), SH / 2, 150, Math.sin(tNow * 8) * 0.08, 'happy', tNow);
    }
  }
}

// ---------- level layouts used in the clips ----------
const LV = {
  clip1: { startX: -4, startY: 7, portalX: 6, portalY: -3.5 },
  clip2: { startX: -7, startY: 7, portalX: 6, portalY: 3 },
  sine: { startX: -8, startY: 7, portalX: 8, portalY: -0.4 },
  hill: { startX: -7, startY: 7, portalX: 7, portalY: -3.5 },
  miss: { startX: 3, startY: 5, portalX: -6, portalY: -3 },
  hero: { startX: -6, startY: 7, portalX: 5, portalY: -2.6 }
};

function followCube(state, zoom, bias = { x: 0, y: 0 }) {
  const p = worldToGame(state.x, state.y);
  viewGame(zoom, p.x + bias.x, p.y + bias.y);
}

// where the storybook cube and portal sit; in the reel they stack diagonally
const STORY = REEL
  ? { cubeX: 300, cubeY: 760, cube: 200, portalX: 770, portalY: 1160, portalR: 140, bend: 300 }
  : { cubeX: 540, cubeY: 490, cube: 220, portalX: 1380, portalY: 600, portalR: 150, bend: 230 };

// ---------- shots ----------
const shots = [
  {
    // 0–12.5s storybook: grid draws itself, the cube and the portal arrive
    start: 0, end: 12.5, game: false,
    frame(t) {
      const zoom = 1.06 - 0.06 * easeInOut(prog(t, 0, 12.5));
      drawGrid(fx, { reveal: easeInOut(prog(t, 0.2, 3.4)), zoom });
      fx.save();
      fx.translate(SW / 2, SH / 2);
      fx.scale(zoom, zoom);
      fx.translate(-SW / 2, -SH / 2);

      eventAt(5.0, 'drop');
      eventAt(5.33, 'thud');
      eventAt(7.5, 'appear');
      eventAt(10.0, 'path');

      const L = STORY;
      // dotted path from the cube to the portal
      const pathK = easeInOut(prog(t, 10.0, 11.6));
      if (pathK > 0) {
        fx.save();
        fx.setLineDash([22, 18]);
        fx.lineDashOffset = -t * 40;
        fx.strokeStyle = COL.ink;
        fx.lineWidth = 7;
        fx.lineCap = 'round';
        fx.beginPath();
        const x0 = L.cubeX + L.cube / 2;
        const y0 = L.cubeY + L.cube / 2;
        for (let k = 0; k <= pathK + 0.0001; k += 0.02) {
          const x = lerp(x0, L.portalX, k);
          const y = (1 - k) ** 2 * y0 + 2 * (1 - k) * k * (y0 + L.bend) + k * k * L.portalY;
          if (k === 0) fx.moveTo(x, y);
          else fx.lineTo(x, y);
        }
        fx.stroke();
        fx.restore();
      }

      // portal
      const pk = prog(t, 7.5, 8.2);
      if (pk > 0) drawPortal(fx, L.portalX, L.portalY, L.portalR, t, easeOutBack(pk));

      // cube drops in and bounces
      const ck = prog(t, 5.0, 5.9);
      if (ck > 0) {
        const y = lerp(-200, L.cubeY, easeOutBounce(ck));
        const breathe = ck >= 1 ? 1 + Math.sin(t * 2.4) * 0.015 : 1;
        drawCube(fx, L.cubeX, y + (ck >= 1 ? Math.sin(t * 2.4) * 6 : 0), L.cube * breathe, Math.sin(t * 1.3) * 0.03, 'idle', t);
      }
      fx.restore();

      if (t < 5) storyText('Somewhere on a graph…', 1.2, 4.3);
      else if (t < 7.5) storyText('lives a little cube,', 5.5, 7.1);
      else if (t < 10) storyText('and one way home.', 8.0, 9.6);
      else storyText('All it needs is the right line.', 10.4, 12.2);
    }
  },
  {
    // 12.5–20s gameplay: a straight line
    start: 12.5, end: 20, game: true,
    enter() {
      gEval('eqInput.focus();');
      setupLevel(LV.clip1, 1);
    },
    frame(t) {
      typeInto('-x + 2', 13.0, 0.2);
      if (crossed(14.4)) pressStart();
      if (crossed(14.6)) releaseStart();
      const s = stepGame(1);
      const k = easeInOut(prog(t, 12.5, 20));
      if (REEL) {
        // whole screen while typing, then push in on the slide
        const push = easeInOut(prog(t, 14.7, 16.2));
        viewWorld(lerp(1, 1.3, push), lerp(CAM.x, 1, push), lerp(CAM.y, 1.75, push));
      } else {
        viewWorld(1 + 0.1 * k, lerp(0, 1.56, k), lerp(0, -0.94, k));
      }
      caption('Type an equation', 12.9, 15.8);
      return s;
    }
  },
  {
    // 20–22.5s title card
    start: 20, end: 22.5, game: false,
    frame(t) {
      drawGrid(fx, { zoom: 1.12 - 0.04 * prog(t, 20, 22.5), panX: -60 * prog(t, 20, 22.5) });
      drawCube(fx, REEL ? 800 : 1500, REEL ? 1440 : 840, REEL ? 150 : 130, -0.12, 'happy', t);
      el.big.style.fontSize = REEL ? '210px' : '168px';
      popWords(el.big, ['Draw', 'the', 'line.'], 'draw', [20.05, 20.25, 20.45], 22.05, 22.35);
    }
  },
  {
    // 22.5–30s gameplay: a parabola carries the cube uphill
    start: 22.5, end: 30, game: true,
    enter() {
      setupLevel(LV.clip2, 2);
    },
    frame(t) {
      typeInto('0.2x^2 - 4', 23.0, 0.17);
      if (crossed(25.0)) pressStart();
      if (crossed(25.2)) releaseStart();
      const s = stepGame(1);
      const k = easeInOut(prog(t, 22.5, 30));
      if (REEL) {
        const push = easeInOut(prog(t, 25.3, 26.8));
        viewWorld(lerp(1, 1.25, push), lerp(CAM.x, 0, push), lerp(CAM.y, 1.5, push));
      } else {
        viewWorld(1 + 0.12 * k, lerp(0, 2.35, k), lerp(0, 0.78, k));
      }
      caption('Curves make it climb', 23.2, 26.6);
      return s;
    }
  },
  {
    // 30–32.5s title card
    start: 30, end: 32.5, game: false,
    frame(t) {
      drawGrid(fx, { zoom: 1.0 + 0.05 * prog(t, 30, 32.5), panX: 80 * prog(t, 30, 32.5) });
      drawPortal(fx, REEL ? 250 : 330, REEL ? 1440 : 860, REEL ? 110 : 90, t);
      el.big.style.fontSize = REEL ? '190px' : '146px';
      popWords(el.big, ['Lines.', 'Curves.', 'Waves.'], 'lcw', [30.0, 30.625, 31.25], 32.1, 32.4);
    }
  },
  // 32.5–40s montage: six quick shots
  montage(32.5, 'sine', () => {
    setupLevel(LV.sine, 5, 'sin(x) - 2');
    pressStart(false); releaseStart();
    preRoll(2.2);
  }, (s) => followCube(s, REEL ? 1.05 : 1.35, { x: REEL ? 90 : 40, y: -20 })),
  montage(33.75, 'hill', () => {
    setupLevel(LV.hill, 9, '-0.08x^2 + 1');
    pressStart(false); releaseStart();
    preRoll(2.6);
  }, (s) => followCube(s, REEL ? 1.05 : 1.3, { x: REEL ? 110 : 30, y: 0 })),
  montage(35.0, 'miss', () => {
    setupLevel(LV.miss, 12, '0.9x + 4');
    pressStart(false); releaseStart();
    preRoll(0.12);
    event('fall', 35.0);
  }, (s) => followCube(s, 1.55, { x: 0, y: 60 })),
  montage(36.25, 'tryagain', () => {
    gEval(`
      running = false;
      failed = true;
      showResult(false, "The cube fell straight down. Your line wasn't under it.");
    `);
  }, () => viewFull(REEL ? 1.3 : 1.45)),
  montage(37.5, 'absorb', () => {
    setupLevel(LV.clip1, 18, '-x + 2');
    pressStart(false); releaseStart();
    preRoll(1.55);
  }, () => {
    const p = worldToGame(LV.clip1.portalX, LV.clip1.portalY);
    viewGame(2.3, p.x - 30, p.y - 20);
  }),
  montage(38.75, 'levels', () => {
    gEval('round = 23; setupRound();');
    setGameCamera(0, REEL ? REEL_CAM_Y : 0);
  }, () => {
    const k = prog(tNow, 38.75, 40);
    const step = Math.floor(k * 5);
    const shown = Number(gEval('round'));
    const want = 23 + step * 6;
    if (shown !== want) {
      gEval(`round = ${want}; setupRound();`);
      setGameCamera(0, REEL ? REEL_CAM_Y : 0);
      event('tick');
    }
    viewFull(1.0 + 0.08 * k);
  }),
  {
    // 40–45s feature cards over drifting, blurred gameplay
    start: 40, end: 45, game: true,
    enter() {
      setupLevel(LV.clip2, 30, '0.2x^2 - 4');
      gEval('equationFn = compileEquation(eqInput.value);');
      iframe.style.filter = 'blur(10px) saturate(0.9) brightness(1.04)';
    },
    leave() {
      iframe.style.filter = '';
    },
    frame(t) {
      setGameCamera(+(-4 + 8 * prog(t, 40, 45)).toFixed(3), REEL ? REEL_CAM_Y : 0);
      stepGame(1);
      viewFull(1.12);
      const cards = [
        [40.0, 'Endless levels'],
        [41.67, 'Real slope physics'],
        [43.33, 'Pure math, pure fun']
      ];
      let idx = 0;
      for (let i = 0; i < cards.length; i++) if (t >= cards[i][0]) idx = i;
      const [t0, text] = cards[idx];
      const t1 = idx < cards.length - 1 ? cards[idx + 1][0] : 45;
      if (el.feature.dataset.key !== text) {
        el.feature.dataset.key = text;
        el.feature.innerHTML = `<span class="pill">${text}</span>`;
      }
      eventAt(t0, 'pop');
      const a = prog(t, t0, t0 + 0.35);
      const b = prog(t, t1 - 0.22, t1);
      show(el.feature, 1 - b, `scale(${easeOutBack(a) * (1 - 0.2 * b)}) rotate(${(idx % 2 ? 1.5 : -1.5)}deg)`);
    }
  },
  {
    // 45–52.5s slow-motion hero shot into the portal
    start: 45, end: 52.5, game: true,
    enter() {
      setupLevel(LV.hero, 31, '-0.75x + 1.5');
      pressStart(false); releaseStart();
    },
    frame(t) {
      if (crossed(46.5)) event('slowmo');
      const s = stepGame(t < 46.5 ? 1 : 0.22);
      const k = easeInOut(prog(t, 45.3, 48.4));
      const cube = worldToGame(s.x, s.y);
      const portalP = worldToGame(LV.hero.portalX, LV.hero.portalY);
      viewGame(lerp(1.05, 2.45, k), lerp(cube.x, portalP.x - 40, k), lerp(cube.y, portalP.y - 30, k));
      caption('Every equation is a path.', 49.9, 52.0, 'top');
    }
  },
  {
    // 52.5–60s end card
    start: 52.5, end: 60, game: false,
    frame(t) {
      drawGrid(fx, { zoom: 1.04 - 0.04 * prog(t, 52.5, 60), alpha: 0.75 });
      const pk = prog(t, 52.5, 53.1);
      eventAt(52.5, 'appear');
      const logoY = REEL ? 700 : 330;
      drawPortal(fx, SW / 2, logoY, REEL ? 200 : 170, t, easeOutBack(pk));
      eventAt(52.75, 'drop');
      eventAt(53.05, 'thud');
      const ck = prog(t, 52.75, 53.55);
      if (ck > 0) {
        const y = lerp(-180, logoY, easeOutBounce(ck)) + (ck >= 1 ? Math.sin(t * 3) * 8 : 0);
        drawCube(fx, SW / 2, y, REEL ? 200 : 170, Math.sin(t * 2) * 0.05, 'happy', t);
      }
      eventAt(53.4, 'logo');
      const lk = prog(t, 53.4, 53.9);
      el.logoTitle.style.transform = `scale(${lk > 0 ? easeOutBack(lk) : 0})`;
      el.logoTitle.style.opacity = lk > 0 ? '1' : '0';
      const tk = prog(t, 54.2, 54.8);
      el.tagline.style.opacity = String(tk);
      el.tagline.style.transform = `translateY(${(1 - easeOutCubic(tk)) * 24}px)`;
      eventAt(54.2, 'chime');
      const ak = prog(t, 55.0, 55.45);
      eventAt(55.0, 'pop');
      el.cta.style.opacity = ak > 0 ? '1' : '0';
      el.cta.style.transform = `scale(${ak > 0 ? easeOutBack(ak) * (1 + Math.sin(t * 4) * 0.02 * prog(t, 55.5, 56)) : 0})`;
      show(el.logo, 1);
    }
  }
];

// six 1.25s montage shots, each with a white flash on the cut
function montage(start, name, enter, view) {
  return {
    start, end: start + 1.25, game: true, name,
    enter() {
      enter();
      if (start > 32.5) event('cut', start);
    },
    frame(t) {
      const s = stepGame(1);
      view(s);
      const flash = start > 32.5 ? 1 - prog(t, start, start + 0.16) : 0;
      el.fade.style.background = '#ffffff';
      el.fade.style.opacity = String(flash * 0.7);
    }
  };
}

// ---------- frame driver ----------
let current = null;

function resetLayers() {
  for (const node of [el.story, el.big, el.feature, el.caption, el.logo]) node.style.opacity = '0';
  el.fade.style.opacity = '0';
  el.fade.style.background = COL.paper;
}

window.__renderFrame = (i) => {
  tPrev = (i - 1) / FPS;
  tNow = i / FPS;
  const shot = shots.find((s) => tNow >= s.start && tNow < s.end) || shots[shots.length - 1];
  if (shot !== current) {
    if (current && current.leave) current.leave();
    current = shot;
    gameWrap.style.visibility = shot.game ? 'visible' : 'hidden';
    fxCanvas.style.visibility = shot.game ? 'hidden' : 'visible';
    if (shot.enter) shot.enter();
  }
  resetLayers();
  if (!shot.game) fx.clearRect(0, 0, SW, SH);
  shot.frame(tNow);
  drawWipes();
  // final fade to paper
  const end = prog(tNow, 59.0, 59.95);
  if (end > 0) {
    el.fade.style.background = COL.paper;
    el.fade.style.opacity = String(easeInOut(end));
  }
};

window.__FRAMES = FRAMES;

async function init() {
  await document.fonts.ready;
  await loadGame();
  window.__renderFrame(0);
  window.__ready = true;
  if (!CAPTURE) startPreview();
}

// ---------- real-time preview (not used for the recording) ----------
function fitStage() {
  const s = Math.min(innerWidth / SW, innerHeight / SH);
  stage.style.transform = `translate(${(innerWidth - SW * s) / 2}px, ${(innerHeight - SH * s) / 2}px) scale(${s})`;
}

function startPreview() {
  fitStage();
  addEventListener('resize', fitStage);
  const btn = document.getElementById('playPreview');
  const audio = document.getElementById('music');
  btn.hidden = false;
  btn.onclick = () => {
    btn.hidden = true;
    let last = 0;
    const t0 = performance.now();
    audio.currentTime = 0;
    audio.play().catch(() => {});
    const tick = () => {
      const t = audio.duration && !audio.paused ? audio.currentTime : (performance.now() - t0) / 1000;
      const target = Math.min(FRAMES - 1, Math.floor(t * FPS));
      while (last < target) window.__renderFrame(++last);
      if (last < FRAMES - 1) requestAnimationFrame(tick);
      else btn.hidden = false;
    };
    requestAnimationFrame(tick);
  };
}

init();
