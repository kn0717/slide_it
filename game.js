// ---------- Setup ----------
const canvas = document.getElementById('graph');
const ctx = canvas.getContext('2d');

const COLORS = {
  thistle: '#cdb4db',
  thistleDeep: '#b497c9',
  petal: '#ffc8dd',
  pink: '#ffafcc',
  icy: '#bde0fe',
  sky: '#a2d2ff',
  ink: '#3b2a4a',
  inkSoft: '#6b5a7b',
  paper: '#ffeef4',
  // a soft pink sheet with deeper pink grid lines
  gridMinor: 'rgba(222, 110, 156, 0.16)',
  gridMajor: 'rgba(200, 80, 135, 0.3)',
  portalRing: '#a2d2ff',
  portalArms: ['#a2d2ff', '#ffffff', '#6fa9e6', '#d3e9ff']
};

// viewW/viewH are in CSS pixels; the backing store is scaled by the device
// pixel ratio so lines and text stay sharp on high-DPI screens
let viewW = 0;
let viewH = 0;

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  viewW = canvas.clientWidth;
  viewH = canvas.clientHeight;
  canvas.width = Math.round(viewW * dpr);
  canvas.height = Math.round(viewH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);
const eqInput = document.getElementById('eqInput');
const startBtn = document.getElementById('startBtn');
const resetBtn = document.getElementById('resetBtn');
const statusMsg = document.getElementById('statusMsg');
const roundNumEl = document.getElementById('roundNum');

const GRID_MIN = -1000;
const GRID_MAX = 1000;
const PX = 32; // pixels per unit, constant regardless of pan

// camera center, in world units (where the view is currently looking)
let camX = 0;
let camY = 0;

function toPx(x, y) {
  return {
    px: viewW / 2 + (x - camX) * PX,
    py: viewH / 2 - (y - camY) * PX
  };
}

function toWorld(px, py) {
  return {
    x: camX + (px - viewW / 2) / PX,
    y: camY - (py - viewH / 2) / PX
  };
}

let round = 1;
let equationFn = null;
let running = false;
let ball = null;
let portal = null;
let gravity = 9.8;
let onCurve = false;
let absorb = null; // { startTime, duration, pose } while the cube is being pulled into the portal
let failed = false; // missed the portal; the cube stays scared until the level restarts
let ballAngle = 0; // cube tilt (radians) kept while airborne after leaving the curve

// ---------- Equation parsing ----------
// Only digits, x, + - * / ^ ( ) , . and a small function whitelist are allowed,
// so the expression handed to new Function can't contain arbitrary code.
const ALLOWED_FNS = ['sqrt', 'sin', 'cos', 'tan', 'abs', 'log', 'pow', 'min', 'max'];
const FN_LIST_TEXT = 'sin, cos, tan, sqrt, abs, log';

function compileEquation(raw) {
  // accept a typed "y =" prefix, superscript powers like x² / x³, and pi
  let expr = raw.trim()
    .replace(/^y\s*=\s*/i, '')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/X/g, 'x')
    .replace(/π|pi/gi, `(${Math.PI})`);
  if (expr === '') throw new Error('Type an equation first, like 0.5x + 2.');

  // swap function names for #A#-style tokens so their letters (the x in
  // "max", say) can't confuse the x and implicit-multiplication rules below
  ALLOWED_FNS.forEach((fn, i) => {
    expr = expr.replace(new RegExp(fn, 'gi'), `#${String.fromCharCode(65 + i)}#`);
  });

  const leftover = expr.replace(/#[A-I]#/g, '').match(/[a-z]*[a-wyz][a-z]*/i);
  if (leftover) {
    throw new Error(`"${leftover[0]}" isn't allowed. Use x, numbers and ${FN_LIST_TEXT}.`);
  }
  const bareFn = expr.match(/#([A-I])#(?!\s*\()/);
  if (bareFn) {
    const name = ALLOWED_FNS[bareFn[1].charCodeAt(0) - 65];
    throw new Error(`Put brackets after ${name}, like ${name}(x).`);
  }
  if (!/^[0-9x+\-*/^().,\s#A-I]+$/.test(expr)) {
    throw new Error('Only numbers, x, + - * / ^ and brackets are allowed.');
  }
  let depth = 0;
  for (const ch of expr) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
    if (depth < 0) throw new Error('There is an extra ")" in the equation.');
  }
  if (depth > 0) throw new Error('A closing bracket ")" is missing.');

  // JS rejects a unary sign right before ** (e.g. -x**2), so turn a leading
  // or post-operator "-" into "(-1)*" and drop a unary "+"; a sign right after
  // ^ is left alone because "2**-x" is valid
  expr = expr
    .replace(/(^|[+\-*/(,])(\s*)-/g, '$1$2(-1)*')
    .replace(/(^|[+\-*/(,])(\s*)\+/g, '$1$2');

  expr = expr.replace(/\^/g, '**');

  // implicit multiplication: 2x, 2(, x(, )x, )(, xx, and 2sin( / xsin( / )sin(
  expr = expr
    .replace(/(\d)\s*(x)/g, '$1*$2')
    .replace(/x(?=\s*x)/g, 'x*')
    .replace(/(\d|x)\s*\(/g, '$1*(')
    .replace(/\)\s*(x|\d)/g, ')*$1')
    .replace(/\)\s*\(/g, ')*(')
    .replace(/(\d|x|\))\s*#/g, '$1*#');

  const body = expr.replace(/#([A-I])#/g, (_, c) => 'Math.' + ALLOWED_FNS[c.charCodeAt(0) - 65]);

  let f;
  try {
    // eslint-disable-next-line no-new-func
    f = new Function('x', `"use strict"; return (${body});`);
  } catch (e) {
    throw new Error('That equation looks incomplete. Check for a missing number or bracket.');
  }

  // it only needs to exist somewhere on the playfield, so sample a wide range
  // instead of a single point (sqrt(x - 5) is undefined at x = 1, which is fine)
  let defined = false;
  for (let x = -40; x <= 40 && !defined; x += 0.25) {
    let y;
    try {
      y = f(x);
    } catch (e) {
      throw new Error('That equation looks incomplete. Check for a missing number or bracket.');
    }
    if (typeof y === 'number' && Number.isFinite(y)) defined = true;
  }
  if (!defined) throw new Error('That equation has no points on the graph. Try another one.');
  return f;
}

// ---------- Drawing ----------
function drawGrid() {
  ctx.clearRect(0, 0, viewW, viewH);
  ctx.fillStyle = COLORS.paper;
  ctx.fillRect(0, 0, viewW, viewH);

  // visible world bounds, so the grid tiles infinitely as the camera pans
  const worldLeft = camX - viewW / 2 / PX;
  const worldRight = camX + viewW / 2 / PX;
  const worldTop = camY + viewH / 2 / PX;
  const worldBottom = camY - viewH / 2 / PX;

  const xStart = Math.floor(worldLeft) - 1;
  const xEnd = Math.ceil(worldRight) + 1;
  const yStart = Math.floor(worldBottom) - 1;
  const yEnd = Math.ceil(worldTop) + 1;

  // snap to the pixel grid so 1px lines render crisp instead of blurred over two pixels
  const crisp = (v, width) => (width % 2 === 1 ? Math.round(v) + 0.5 : Math.round(v));

  function strokeGridLines(predicate, color, width) {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = xStart; i <= xEnd; i++) {
      if (!predicate(i)) continue;
      const x = crisp(toPx(i, 0).px, width);
      ctx.moveTo(x, 0);
      ctx.lineTo(x, viewH);
    }
    for (let i = yStart; i <= yEnd; i++) {
      if (!predicate(i)) continue;
      const y = crisp(toPx(0, i).py, width);
      ctx.moveTo(0, y);
      ctx.lineTo(viewW, y);
    }
    ctx.stroke();
  }

  strokeGridLines((i) => i % 5 !== 0, COLORS.gridMinor, 1);
  strokeGridLines((i) => i % 5 === 0 && i !== 0, COLORS.gridMajor, 1);

  // axes
  const origin = toPx(0, 0);
  const axisX = crisp(origin.px, 3);
  const axisY = crisp(origin.py, 3);
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 3;
  ctx.beginPath();
  if (origin.px >= 0 && origin.px <= viewW) {
    ctx.moveTo(axisX, 0);
    ctx.lineTo(axisX, viewH);
  }
  if (origin.py >= 0 && origin.py <= viewH) {
    ctx.moveTo(0, axisY);
    ctx.lineTo(viewW, axisY);
  }
  ctx.stroke();

  drawAxisLabels(origin, xStart, xEnd, yStart, yEnd);
}

// plain small numerals like printed graph paper, with a thin paper-coloured
// halo so grid lines don't cut through them; when an axis scrolls off screen
// its numbers stick to the nearest edge
function drawAxisLabels(origin, xStart, xEnd, yStart, yEnd) {
  const EDGE = 12;
  const TICK = 4;
  ctx.font = '500 11.5px Fredoka, sans-serif';
  ctx.textBaseline = 'middle';

  const chipWidth = (text) => ctx.measureText(text).width + 6;

  function chip(text, cx, cy) {
    ctx.textAlign = 'center';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = COLORS.paper;
    ctx.strokeText(text, cx, cy + 0.5);
    ctx.fillStyle = COLORS.inkSoft;
    ctx.fillText(text, cx, cy + 0.5);
  }

  const xAxisVisible = origin.py >= 0 && origin.py <= viewH;
  const yAxisVisible = origin.px >= 0 && origin.px <= viewW;

  // the floating panel covers part of the canvas; a number that would land
  // under it is moved to the other side of its axis so it stays readable
  const panelRect = panelEl.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const hidden = (cx, cy, w, h) =>
    cx + w / 2 > panelRect.left - canvasRect.left &&
    cx - w / 2 < panelRect.right - canvasRect.left &&
    cy + h / 2 > panelRect.top - canvasRect.top &&
    cy - h / 2 < panelRect.bottom - canvasRect.top;
  const clampY = (y) => Math.min(Math.max(y, EDGE), viewH - EDGE);

  // x-axis numbers: positives above the axis (quadrant I), negatives below it
  // (quadrant III), so the two signs always sit on opposite sides
  for (let i = xStart; i <= xEnd; i++) {
    if (i === 0) continue;
    const px = toPx(i, 0).px;
    if (px < EDGE || px > viewW - EDGE) continue;
    const w = chipWidth(String(i));
    let xLabelY = clampY(origin.py + (i > 0 ? -14 : 14));
    if (hidden(px, xLabelY, w, 16)) xLabelY = clampY(origin.py + (i > 0 ? 14 : -14));
    if (xAxisVisible) {
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(Math.round(px), origin.py - TICK);
      ctx.lineTo(Math.round(px), origin.py + TICK);
      ctx.stroke();
    }
    chip(String(i), px, xLabelY);
  }

  // y-axis numbers: positives left of the axis (quadrant II), negatives right
  // of it (quadrant IV)
  for (let i = yStart; i <= yEnd; i++) {
    if (i === 0) continue;
    const py = toPx(0, i).py;
    if (py < EDGE || py > viewH - EDGE) continue;
    const w = chipWidth(String(i));
    const half = w / 2;
    const offset = 8 + half;
    const clampX = (x) => Math.min(Math.max(x, EDGE / 2 + half), viewW - EDGE / 2 - half);
    let yLabelX = clampX(origin.px + (i > 0 ? -offset : offset));
    if (hidden(yLabelX, py, w, 16)) yLabelX = clampX(origin.px + (i > 0 ? offset : -offset));
    if (yAxisVisible) {
      ctx.strokeStyle = COLORS.ink;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(origin.px - TICK, Math.round(py));
      ctx.lineTo(origin.px + TICK, Math.round(py));
      ctx.stroke();
    }
    chip(String(i), yLabelX, py);
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

// ---------- Maths typesetting ----------
// Turns what the player typed ("0.2x^2 - 4") into runs of properly set
// maths: italic x, raised exponents, a real minus sign, √ and π, implied
// multiplication left implicit. Used for the label beside the curve and the
// live preview under the input.
const TYPESET_FNS = { sqrt: '√', sin: 'sin', cos: 'cos', tan: 'tan', abs: 'abs', log: 'log', pow: 'pow', min: 'min', max: 'max', pi: 'π' };

function mathRuns(raw) {
  const s = raw.trim().replace(/^y\s*=\s*/i, '').replace(/\*\*/g, '^').replace(/²/g, '^2').replace(/³/g, '^3');
  const runs = [];
  const push = (t, opts = {}) => runs.push({ t, it: !!opts.it, sup: !!opts.sup });
  let prevOperand = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '^') {
      // exponent: a number, x, or a bracketed group
      let j = i + 1;
      let exp = '';
      if (s[j] === '(') {
        let depth = 0;
        for (; j < s.length; j++) {
          if (s[j] === '(') depth++;
          if (s[j] === ')') depth--;
          exp += s[j];
          if (depth === 0) { j++; break; }
        }
        if (/^\([\d.x\-]+\)$/.test(exp)) exp = exp.slice(1, -1);
      } else {
        const m = s.slice(j).match(/^-?[\d.]+|^-?x/i);
        exp = m ? m[0] : '';
        j += exp.length;
      }
      for (const part of exp.replace(/-/g, '−').split(/(x)/i)) {
        if (part) push(part, { sup: true, it: /^x$/i.test(part) });
      }
      i = j;
      prevOperand = true;
      continue;
    }
    if (ch === '*') { i++; continue; }
    if (ch === '-' || ch === '+') {
      if (prevOperand) push(ch === '-' ? ' − ' : ' + ');
      else push(ch === '-' ? '−' : '');
      prevOperand = false;
      i++;
      continue;
    }
    if (ch === '/') { push(' / '); prevOperand = false; i++; continue; }
    if (/[a-zπ]/i.test(ch)) {
      const word = s.slice(i).match(/^[a-zπ]+/i)[0].toLowerCase();
      const fn = Object.keys(TYPESET_FNS).find((f) => word.startsWith(f));
      if (fn) {
        push(TYPESET_FNS[fn]);
        i += fn.length;
        prevOperand = fn === 'pi';
        continue;
      }
      if (ch === 'π') { push('π'); i++; prevOperand = true; continue; }
      push(ch, { it: true });
      i++;
      prevOperand = true;
      continue;
    }
    push(ch === ',' ? ', ' : ch);
    prevOperand = ch !== '(' && ch !== ',';
    i++;
  }
  return runs;
}

function typesetHTML(raw) {
  const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return mathRuns(raw).map((r) => {
    let h = esc(r.t);
    if (r.it) h = `<i>${h}</i>`;
    if (r.sup) h = `<sup>${h}</sup>`;
    return h;
  }).join('');
}

const MATH_FONT = '"STIX Two Text", "Times New Roman", serif';

// draws "y = <equation>" in a maths serif and returns its width; with a halo
// colour it first strokes a paper-coloured outline so grid lines don't cut it
function drawMath(raw, x, y, size, { measureOnly = false, halo = null } = {}) {
  const runs = [{ t: 'y', it: true, sup: false }, { t: ' = ', it: false, sup: false }, ...mathRuns(raw)];
  let cx = x;
  for (const r of runs) {
    const fs = r.sup ? size * 0.68 : size;
    ctx.font = `${r.it ? 'italic ' : ''}400 ${fs}px ${MATH_FONT}`;
    const w = ctx.measureText(r.t).width;
    if (!measureOnly) {
      const ry = r.sup ? y - size * 0.38 : y;
      if (halo) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = 5;
        ctx.strokeStyle = halo;
        ctx.strokeText(r.t, cx, ry);
      }
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(r.t, cx, ry);
    }
    cx += w + (r.it ? size * 0.04 : 0);
  }
  return cx - x;
}

let equationText = '';

// writes the equation beside the curve, textbook style, at a spot towards
// the right that's on screen and clear of the panel
function drawCurveLabel() {
  if (!equationText || !equationFn) return;
  const size = 20;
  const width = drawMath(equationText, 0, 0, size, { measureOnly: true });
  const panelRect = panelEl.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const underPanel = (x, y) =>
    x + width > panelRect.left - canvasRect.left && x < panelRect.right - canvasRect.left + 10 &&
    y + 8 > panelRect.top - canvasRect.top && y - size < panelRect.bottom - canvasRect.top + 10;
  for (let frac = 0.84; frac >= 0.3; frac -= 0.04) {
    const x = toWorld(viewW * frac, 0).x;
    const y = curveAt(x);
    if (!Number.isFinite(y)) continue;
    const p = toPx(x, y);
    if (p.py < 50 || p.py > viewH - 30) continue;
    const lx = Math.min(p.px + 12, viewW - width - 14);
    const ly = p.py - 16;
    if (underPanel(lx, ly)) continue;
    drawMath(equationText, lx, ly, size, { halo: COLORS.paper });
    ctx.textBaseline = 'alphabetic';
    return;
  }
}

function drawCurve() {
  if (!equationFn) return;
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 4;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let started = false;
  for (let px = 0; px <= viewW; px += 2) {
    const x = toWorld(px, 0).x;
    let y;
    try {
      y = equationFn(x);
    } catch (e) {
      continue;
    }
    if (typeof y !== 'number' || Number.isNaN(y) || !Number.isFinite(y)) {
      started = false;
      continue;
    }
    const { px: cx, py: cy } = toPx(x, y);
    if (cy < -50 || cy > viewH + 50) {
      started = false;
      continue;
    }
    if (!started) {
      ctx.moveTo(cx, cy);
      started = true;
    } else {
      ctx.lineTo(cx, cy);
    }
  }
  ctx.stroke();
}

const PORTAL_RADIUS = 38;
const CUBE_SIZE = 50;

function getCubeHalfWorld() {
  return CUBE_SIZE / 2 / PX;
}

function circle(x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
}

function drawPortal() {
  if (!portal) return;
  const { px, py } = toPx(portal.x, portal.y);
  const t = Date.now() / 1000;
  const pull = absorb ? Math.min((Date.now() - absorb.startTime) / absorb.duration, 1) : 0;
  const R = PORTAL_RADIUS * (1 + Math.sin(t * 3) * 0.04 + pull * 0.12);
  const inner = R * 0.76;

  ctx.save();
  ctx.translate(px, py);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  circle(3, 4, R);
  ctx.fill();

  ctx.fillStyle = COLORS.portalRing;
  circle(0, 0, R);
  ctx.fill();

  // studs around the rim, turning slowly
  ctx.fillStyle = '#ffffff';
  for (let k = 0; k < 8; k++) {
    const a = t * 0.6 + (k / 8) * Math.PI * 2;
    circle(Math.cos(a) * (R + inner) / 2, Math.sin(a) * (R + inner) / 2, R * 0.06);
    ctx.fill();
  }

  // the swirl: four blue arms spinning inside a dark well
  ctx.save();
  circle(0, 0, inner);
  ctx.clip();
  ctx.fillStyle = COLORS.ink;
  ctx.fillRect(-inner, -inner, inner * 2, inner * 2);
  ctx.rotate(-t * 2.4 - pull * 6);
  const arms = COLORS.portalArms;
  ctx.lineCap = 'round';
  ctx.lineWidth = inner * 0.24;
  for (let k = 0; k < arms.length; k++) {
    const base = (k / arms.length) * Math.PI * 2;
    ctx.strokeStyle = arms[k];
    ctx.beginPath();
    for (let s = 0; s <= 1.0001; s += 0.05) {
      const r = inner * (0.14 + 0.95 * s);
      const a = base + s * 2.4;
      if (s === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r);
      else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.stroke();
  }
  const core = ctx.createRadialGradient(0, 0, 0, 0, 0, inner * 0.32);
  core.addColorStop(0, COLORS.ink);
  core.addColorStop(0.7, 'rgba(59, 42, 74, 0.9)');
  core.addColorStop(1, 'rgba(59, 42, 74, 0)');
  ctx.fillStyle = core;
  circle(0, 0, inner * 0.32);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 3;
  circle(0, 0, inner);
  ctx.stroke();
  circle(0, 0, R);
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.88, Math.PI * 1.1, Math.PI * 1.4);
  ctx.stroke();

  ctx.restore();
}

// the cube's physics position is the midpoint of its bottom face on the
// curve; its center sits half a side up along the curve's normal
function getCubePose() {
  if (onCurve && equationFn) {
    const raw = numericSlope(equationFn, ball.x);
    const slope = Number.isFinite(raw) ? raw : Math.tan(ballAngle);
    const norm = Math.sqrt(1 + slope * slope);
    const half = getCubeHalfWorld();
    return {
      x: ball.x + (-slope / norm) * half,
      y: ball.y + (1 / norm) * half,
      angle: Math.atan(slope)
    };
  }
  return { x: ball.x, y: ball.y + getCubeHalfWorld(), angle: ballAngle };
}

function roundRectPath(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawCube() {
  if (!ball) return;

  let drawX, drawY, angle;
  let scale = 1;
  const pose = absorb ? absorb.pose : getCubePose();

  if (absorb) {
    const t = Math.min((Date.now() - absorb.startTime) / absorb.duration, 1);
    const ease = t * t;
    drawX = pose.x + (portal.x - pose.x) * ease;
    drawY = pose.y + (portal.y - pose.y) * ease;
    angle = pose.angle + ease * Math.PI * 2; // spins as it's pulled in
    scale = 1 - ease;
  } else {
    drawX = pose.x;
    drawY = pose.y;
    angle = pose.angle;
  }

  if (scale <= 0) return;

  const { px, py } = toPx(drawX, drawY);
  const s = CUBE_SIZE * scale;
  const r = s * 0.16;

  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-angle); // world y is up, canvas y is down

  // squash on landing, anchored at the bottom face so it stays on the line
  const squash = landingSquash();
  if (squash) {
    ctx.translate(0, s / 2);
    ctx.scale(1 + squash * 0.9, 1 - squash);
    ctx.translate(0, -s / 2);
  }

  ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
  roundRectPath(-s / 2 + 3, -s / 2 + 4, s, s, r);
  ctx.fill();

  ctx.fillStyle = '#ffafcc';
  roundRectPath(-s / 2, -s / 2, s, s, r);
  ctx.fill();

  ctx.fillStyle = '#ffc8dd';
  roundRectPath(-s / 2 + s * 0.12, -s / 2 + s * 0.12, s * 0.76, s * 0.5, r * 0.7);
  ctx.fill();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  roundRectPath(-s / 2 + s * 0.16, -s / 2 + s * 0.12, s * 0.2, s * 0.08, s * 0.04);
  ctx.fill();

  ctx.lineWidth = Math.max(2, s * 0.08);
  ctx.strokeStyle = '#3b2a4a';
  roundRectPath(-s / 2, -s / 2, s, s, r);
  ctx.stroke();

  const mood = absorb ? 'happy' : (running || failed) ? 'scared' : 'idle';
  drawCubeFace(s, mood);

  ctx.restore();
}

function isBlinking() {
  return Date.now() % 3200 < 140;
}

// draws the face in the cube's local (rotated) space; s is the cube side
function drawCubeFace(s, mood) {
  const t = Date.now() / 1000;
  const eyeY = -s * 0.02;
  const eyeDX = s * 0.17;
  const mouthY = s * 0.22;
  const line = Math.max(1.5, s * 0.055);

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = COLORS.ink;
  ctx.fillStyle = COLORS.ink;
  ctx.lineWidth = line;

  // rosy cheeks
  ctx.fillStyle = 'rgba(255, 120, 170, 0.45)';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(side * s * 0.3, s * 0.12, s * 0.08, s * 0.05, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  if (mood === 'happy') {
    // ^ ^ eyes
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(side * eyeDX, eyeY + s * 0.05, s * 0.08, Math.PI * 1.1, Math.PI * 1.9);
      ctx.stroke();
    }
    // big open grin with a tongue
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(0, mouthY - s * 0.06, s * 0.15, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ff7fa8';
    ctx.beginPath();
    ctx.ellipse(0, mouthY + s * 0.04, s * 0.07, s * 0.04, 0, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  if (mood === 'scared') {
    const shake = Math.sin(t * 45) * s * 0.012;
    // worried brows, raised in the middle
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(side * (eyeDX + s * 0.1), eyeY - s * 0.13);
      ctx.lineTo(side * (eyeDX - s * 0.06), eyeY - s * 0.2);
      ctx.stroke();
    }
    if (isBlinking()) {
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * eyeDX - s * 0.08, eyeY);
        ctx.lineTo(side * eyeDX + s * 0.08, eyeY);
        ctx.stroke();
      }
    } else {
      // wide white eyes with tiny trembling pupils
      for (const side of [-1, 1]) {
        ctx.fillStyle = '#ffffff';
        circle(side * eyeDX, eyeY, s * 0.1);
        ctx.fill();
        ctx.lineWidth = line * 0.8;
        ctx.stroke();
        ctx.fillStyle = COLORS.ink;
        circle(side * eyeDX + shake, eyeY + s * 0.01, s * 0.04);
        ctx.fill();
      }
      ctx.lineWidth = line;
    }
    // small "o" mouth
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.ellipse(0, mouthY, s * 0.06, s * 0.08, 0, 0, Math.PI * 2);
    ctx.fill();
    // sweat drop
    const dropY = -s * 0.3 + Math.sin(t * 6) * s * 0.03;
    const dropX = s * 0.36;
    ctx.fillStyle = COLORS.icy;
    ctx.beginPath();
    ctx.moveTo(dropX, dropY - s * 0.1);
    ctx.quadraticCurveTo(dropX + s * 0.07, dropY, dropX, dropY + s * 0.05);
    ctx.quadraticCurveTo(dropX - s * 0.07, dropY, dropX, dropY - s * 0.1);
    ctx.fill();
    ctx.lineWidth = line * 0.6;
    ctx.stroke();
    return;
  }

  // idle: oval eyes that blink, gentle smile
  ctx.fillStyle = COLORS.ink;
  for (const side of [-1, 1]) {
    if (isBlinking()) {
      ctx.beginPath();
      ctx.moveTo(side * eyeDX - s * 0.06, eyeY);
      ctx.lineTo(side * eyeDX + s * 0.06, eyeY);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(side * eyeDX, eyeY, s * 0.05, s * 0.075, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      circle(side * eyeDX + s * 0.015, eyeY - s * 0.03, s * 0.018);
      ctx.fill();
      ctx.fillStyle = COLORS.ink;
    }
  }
  ctx.beginPath();
  ctx.arc(0, mouthY - s * 0.08, s * 0.09, Math.PI * 0.2, Math.PI * 0.8);
  ctx.stroke();
}

// ---------- Sound ----------
// small effects synthesised live with Web Audio, no sound files needed. The
// audio context starts on the first click or key press (browsers require a
// gesture), and the mute choice is remembered.
const sound = (() => {
  let ac = null;
  let master = null;
  let enabled = true;
  try {
    enabled = localStorage.getItem('slideit-sound') !== 'off';
  } catch (e) {
    enabled = true;
  }

  function audio() {
    if (!ac) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ac = new AC();
      master = ac.createGain();
      master.gain.value = 0.55;
      master.connect(ac.destination);
    }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }

  function tone({ freq, to = freq, dur = 0.15, type = 'sine', gain = 0.2, delay = 0, attack = 0.005 }) {
    if (!enabled) return;
    const a = audio();
    if (!a) return;
    const t0 = a.currentTime + delay;
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to !== freq) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function noise({ dur = 0.05, gain = 0.1, delay = 0, highpass = 2000 }) {
    if (!enabled) return;
    const a = audio();
    if (!a) return;
    const t0 = a.currentTime + delay;
    const len = Math.ceil(a.sampleRate * dur);
    const buf = a.createBuffer(1, len, a.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = a.createBufferSource();
    src.buffer = buf;
    const filter = a.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = highpass;
    const g = a.createGain();
    g.gain.value = gain;
    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(t0);
  }

  const bell = (midi, delay = 0, gain = 0.08) =>
    tone({ freq: 440 * 2 ** ((midi - 69) / 12), dur: 0.6, gain, delay });

  return {
    get enabled() {
      return enabled;
    },
    toggle() {
      enabled = !enabled;
      try {
        localStorage.setItem('slideit-sound', enabled ? 'on' : 'off');
      } catch (e) {
        // storage blocked: the choice just won't be remembered
      }
      if (enabled) this.click();
      return enabled;
    },
    unlock() {
      if (enabled) audio();
    },
    type() {
      noise({ dur: 0.025, gain: 0.07, highpass: 3000 });
      tone({ freq: 2300 + Math.random() * 500, dur: 0.03, gain: 0.025 });
    },
    click() {
      tone({ freq: 520, to: 760, dur: 0.07, gain: 0.08, type: 'triangle' });
    },
    press() {
      tone({ freq: 180, to: 80, dur: 0.1, gain: 0.25 });
      noise({ dur: 0.02, gain: 0.06, highpass: 1200 });
    },
    land() {
      tone({ freq: 130, to: 55, dur: 0.16, gain: 0.3 });
    },
    portal() {
      tone({ freq: 300, to: 1400, dur: 0.5, gain: 0.08, type: 'triangle' });
      [84, 88, 91, 96].forEach((m, i) => bell(m, 0.08 + i * 0.06, 0.06));
    },
    win() {
      bell(79, 0, 0.1);
      bell(84, 0.13, 0.11);
      bell(91, 0.26, 0.07);
    },
    lose() {
      tone({ freq: 659, dur: 0.16, gain: 0.08, type: 'triangle' });
      tone({ freq: 523, to: 494, dur: 0.3, gain: 0.08, type: 'triangle', delay: 0.18 });
    },
    fall() {
      tone({ freq: 1000, to: 260, dur: 0.75, gain: 0.05 });
    }
  };
})();

// ---------- Juice: pencil trail and landing squash ----------
// the trail is the stretch of line the cube has slid over, kept in world
// coordinates so it stays put when the graph is dragged
let trail = [];
let landedAt = 0;
const TRAIL_LENGTH = 70;

function recordTrail() {
  if (!onCurve || !ball) return;
  const last = trail[trail.length - 1];
  if (last && Math.hypot(last.x - ball.x, last.y - ball.y) < 0.08) return;
  trail.push({ x: ball.x, y: ball.y });
  if (trail.length > TRAIL_LENGTH) trail.shift();
}

// soft graphite shading just above the line, fading out towards the tail
function drawTrail() {
  if (trail.length < 2) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let k = 1; k < trail.length; k++) {
    const a = toPx(trail[k - 1].x, trail[k - 1].y);
    const b = toPx(trail[k].x, trail[k].y);
    const fade = k / trail.length;
    ctx.strokeStyle = `rgba(59, 42, 74, ${0.22 * fade})`;
    ctx.lineWidth = 3 + 6 * fade;
    ctx.beginPath();
    ctx.moveTo(a.px, a.py - 5);
    ctx.lineTo(b.px, b.py - 5);
    ctx.stroke();
  }
}

// how squashed the cube is right now: a quick bounce just after it lands
function landingSquash() {
  if (!landedAt || absorb) return 0;
  const k = (Date.now() - landedAt) / 300;
  if (k >= 1) return 0;
  return Math.sin(k * Math.PI) * 0.24 * (1 - k * 0.6);
}

function render() {
  drawGrid();
  drawCurve();
  drawTrail();
  drawPortal();
  drawCurveLabel();
  drawCube();
}

// ---------- Round setup ----------
function randRange(min, max) {
  return Math.random() * (max - min) + min;
}

// the current level's fixed start/portal positions, kept across retries
let level = null;

const START_Y = 7;
const panelEl = document.querySelector('.panel');

// true if world point (x, y) would be drawn under the floating panel,
// assuming the camera is at the origin (as it is at the start of a level)
function isUnderPanel(x, y, marginPx) {
  const rect = panelEl.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  const sx = canvasRect.left + viewW / 2 + x * PX;
  const sy = canvasRect.top + viewH / 2 - y * PX;
  return (
    sx > rect.left - marginPx && sx < rect.right + marginPx &&
    sy > rect.top - marginPx && sy < rect.bottom + marginPx
  );
}

// keeps a dropped-from-below-the-panel cube (phones) high enough above the
// bottom of the screen to leave room for a line under it
const PORTAL_HEADROOM = 2.5;

// where a portal may appear: anywhere in x -23..23, y -10..10. The cube never
// drops below MIN_SLIDE_SPEED, so it can climb up to a portal above it too.
const PORTAL_AREA = { x: 23, y: 10 };

// Levels are laid out inside the area visible at the start of a level
// (camera at the origin), less a margin, so nothing spawns off-screen on
// narrow windows such as phones.
function playBounds() {
  const margin = 1.2;
  const halfW = viewW / 2 / PX - margin;
  const halfH = viewH / 2 / PX - margin;
  return {
    xMax: Math.min(8, halfW),
    yTop: Math.min(START_Y, halfH),
    yBottom: Math.max(-7, -halfH),
    // the portal's area, cut down to what's on screen on smaller windows
    portalX: Math.min(PORTAL_AREA.x, halfW),
    portalY: Math.min(PORTAL_AREA.y, halfH)
  };
}

// Drop the cube from as high as possible at a spot the panel doesn't cover.
// When the panel spans the whole width (phones), drop it from just below
// the panel instead.
function pickStart(b) {
  for (let t = 0; t < 80; t++) {
    const x = randRange(-b.xMax, b.xMax);
    if (!isUnderPanel(x, b.yTop, CUBE_SIZE)) return { x, y: b.yTop };
  }
  const x = randRange(-b.xMax, b.xMax);
  let y = b.yTop;
  while (y > b.yBottom + PORTAL_HEADROOM + 2 && isUnderPanel(x, y, CUBE_SIZE)) y -= 0.25;
  return { x, y };
}

function newLevel() {
  const b = playBounds();
  const start = pickStart(b);
  let best = null;
  for (let tries = 0; tries < 300; tries++) {
    const portalX = randRange(-b.portalX, b.portalX);
    const portalY = randRange(-b.portalY, b.portalY);
    if (Math.abs(portalX - start.x) < 3) continue;
    best = { startX: start.x, startY: start.y, portalX, portalY };
    if (!isUnderPanel(portalX, portalY, PORTAL_RADIUS * 1.5)) break;
  }
  if (!best) {
    // only possible on an extremely narrow window: put the portal on the far side
    const portalX = start.x > 0 ? -b.portalX : b.portalX;
    best = { startX: start.x, startY: start.y, portalX, portalY: start.y - PORTAL_HEADROOM - 1 };
  }
  level = best;
}

function beginLevel(message, keepEquation = false) {
  clearTimeout(resultTimer);
  hideResult();
  running = false;
  onCurve = false;
  absorb = null;
  ballAngle = 0;
  failed = false;
  equationFn = null;
  camX = 0;
  camY = 0;
  if (!keepEquation) eqInput.value = '';
  equationText = '';
  trail = [];
  landedAt = 0;
  updateEqPreview();
  eqInput.disabled = false;
  startBtn.disabled = false;
  resetBtn.disabled = false;

  ball = { x: level.startX, y: level.startY, vx: 0, vy: 0, v: 0 };
  portal = { x: level.portalX, y: level.portalY };
  stoppedFor = 0;
  slideTime = 0;
  runTime = 0;

  statusMsg.textContent = message;
  roundNumEl.textContent = round;
  render();
}

// a brand new layout (first load and after "Next level")
function setupRound() {
  newLevel();
  beginLevel('Enter an equation and press Start');
}

// same start and portal: used by Reset and "Try again". The last equation
// stays in the box so it can be tweaked instead of retyped.
function retryLevel() {
  beginLevel('Same level. Adjust your equation and press Start', true);
  try {
    equationFn = compileEquation(eqInput.value);
    equationText = eqInput.value;
  } catch (e) {
    equationFn = null;
  }
}

// ---------- Physics ----------
// the curve's height at x, or NaN where it's undefined (sqrt of a negative,
// log of 0, division by zero...)
function curveAt(x) {
  try {
    const y = equationFn(x);
    return typeof y === 'number' && Number.isFinite(y) ? y : NaN;
  } catch (e) {
    return NaN;
  }
}

// slope of f at x; falls back to a one-sided difference right at the edge of
// a curve's domain (e.g. the end of sqrt(5 - x)), and is NaN only when the
// curve isn't defined on either side
function numericSlope(f, x, h = 0.001) {
  const at = (v) => {
    try {
      const y = f(v);
      return typeof y === 'number' && Number.isFinite(y) ? y : NaN;
    } catch (e) {
      return NaN;
    }
  };
  const y0 = at(x);
  const yl = at(x - h);
  const yr = at(x + h);
  const central = (yr - yl) / (2 * h);
  if (Number.isFinite(central)) return central;
  const back = (y0 - yl) / h;
  if (Number.isFinite(back)) return back;
  const fwd = (yr - y0) / h;
  return Number.isFinite(fwd) ? fwd : NaN;
}

const MAX_ROLL_SPEED = 16;
const MIN_SLIDE_SPEED = 3;
const FRICTION = 0.04;
const MAX_SLIDE_SECONDS = 15;
const MAX_RUN_SECONDS = 25;

// measured against the level's own view (camera at the origin), so dragging
// the graph around mid-run can't make the cube "fall off the screen"
function isOffScreen() {
  const px = viewW / 2 + ball.x * PX;
  const py = viewH / 2 - ball.y * PX;
  const margin = 160;
  return px < -margin || px > viewW + margin || py < -margin || py > viewH + margin;
}

function stepPhysics(dt) {
  if (!onCurve) {
    // free fall (with any sideways speed it had) until it reaches the curve
    const prevX = ball.x;
    const prevY = ball.y;
    ball.vy -= gravity * dt;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // only land when coming down onto the curve from above it; a curve that
    // is above the cube is something it falls past, not a floor to snap up to
    const before = curveAt(prevX);
    const curveY = curveAt(ball.x);
    const wasAbove = Number.isFinite(before) ? prevY >= before : prevY >= curveY;
    if (Number.isFinite(curveY) && ball.y <= curveY && wasAbove) {
      // The cube always heads for the portal's side, whichever way the line
      // tilts. It keeps whatever part of its falling speed already points that
      // way, but never less than a steady crawl.
      const slope = numericSlope(equationFn, ball.x);
      const angle = Number.isFinite(slope) ? Math.atan(slope) : 0;
      ball.dir = Math.sign(portal.x - ball.x) || 1;
      const along = (ball.vx * Math.cos(angle) + ball.vy * Math.sin(angle)) * ball.dir;
      ball.v = ball.dir * Math.min(MAX_ROLL_SPEED, Math.max(MIN_SLIDE_SPEED, along));
      ball.y = curveY;
      ball.vy = 0;
      onCurve = true;
      everLanded = true;
      landedAt = Date.now();
      sound.land();
      statusMsg.textContent = 'Sliding to the portal...';
    }
  } else {
    // sliding along the curve towards the portal. ball.v is speed along the
    // tangent (positive = towards +x). Going downhill speeds it up, uphill and
    // friction slow it down, but it never drops below MIN_SLIDE_SPEED, so it
    // can climb any slope that leads to the portal.
    const slope = numericSlope(equationFn, ball.x);
    if (!Number.isFinite(slope)) {
      // no usable slope here: leave the curve with the velocity it had
      onCurve = false;
      ball.vx = ball.v * Math.cos(ballAngle);
      ball.vy = ball.v * Math.sin(ballAngle);
      return;
    }
    const angle = Math.atan(slope);
    ballAngle = angle;
    const dir = ball.dir;
    let speed = ball.v * dir;
    speed += -gravity * Math.sin(angle) * dir * dt;
    speed -= FRICTION * gravity * Math.cos(angle) * dt;
    speed = Math.min(MAX_ROLL_SPEED, Math.max(MIN_SLIDE_SPEED, speed));
    ball.v = speed * dir;
    ball.vx = ball.v * Math.cos(angle);
    ball.x += ball.vx * dt;

    const curveY = curveAt(ball.x);
    if (Number.isFinite(curveY)) {
      ball.y = curveY;
    } else {
      // the curve is undefined here (e.g. a gap/asymptote): it flies off the end
      onCurve = false;
      ball.vy = ball.v * Math.sin(angle);
    }
  }
}

// The cube counts as in once its middle is inside the portal ring (plus a
// little slack), measured from the drawn cube rather than the point where it
// touches the line, so a win always looks like one. Checked on the line and
// in the air.
const PORTAL_CATCH = PORTAL_RADIUS / PX + 0.35;

function checkPortal() {
  const pose = getCubePose();
  if (Math.hypot(pose.x - portal.x, pose.y - portal.y) >= PORTAL_CATCH) return;
  running = false;
  statusMsg.textContent = 'Portal reached!';
  absorb = { startTime: Date.now(), duration: 550, pose };
  sound.portal();
  resetBtn.disabled = true;
  resultTimer = setTimeout(() => showResult(true), absorb.duration + 250);
}

function update(dt) {
  if (!running || !ball || !equationFn) return;

  // sub-step the integration so a fast-moving cube can't tunnel through a
  // steep part of the curve, and sliding stays smooth rather than jumpy
  const substeps = 6;
  const subDt = dt / substeps;
  for (let i = 0; i < substeps; i++) {
    if (!running) break;
    stepPhysics(subDt);
    recordTrail();
    checkPortal();

    // last line of defence: never leave a run going with a cube that has no
    // real position (it would vanish and the game would never end)
    if (running && !(Number.isFinite(ball.x) && Number.isFinite(ball.y))) {
      failLevel('The cube flew off the curve.');
      break;
    }
    if (running && isOffScreen()) {
      // a line that isn't under the cube (above it, missing there, or below
      // the screen) never catches it, so it just drops straight down
      failLevel(everLanded
        ? 'The cube fell off the screen.'
        : 'The cube fell straight down. Your line wasn\'t under it.');
      break;
    }
  }

  if (running && onCurve && Math.abs(ball.v) < 0.02) {
    stoppedFor += dt;
    if (stoppedFor > 1.5) failLevel('The cube got stuck on the line.');
  } else {
    stoppedFor = 0;
  }

  if (running) {
    runTime += dt;
    if (onCurve) slideTime += dt;
    if (slideTime > MAX_SLIDE_SECONDS || runTime > MAX_RUN_SECONDS) {
      failLevel('The cube ran out of steam.');
    }
  }
}

let slideTime = 0;
let runTime = 0;
let everLanded = false;

let stoppedFor = 0;

function failLevel(reason) {
  running = false;
  failed = true;
  stoppedFor = 0;
  statusMsg.textContent = reason;
  if (!everLanded) sound.fall();
  resultTimer = setTimeout(() => showResult(false, reason), 700);
}

let resultTimer = null;

// ---------- Result pop-up ----------
const resultEl = document.getElementById('result');
const resultTitle = document.getElementById('resultTitle');
const resultText = document.getElementById('resultText');
const resultPrimary = document.getElementById('resultPrimary');
let resultSuccess = false;

function showResult(success, reason) {
  resultSuccess = success;
  resultEl.classList.toggle('is-success', success);
  resultTitle.textContent = success ? 'Well done!' : 'So close!';
  resultText.textContent = success
    ? `Level ${round} cleared! The cube made it into the portal.`
    : `${reason} Try a different equation.`;
  resultPrimary.textContent = success ? 'Next level' : 'Try again';
  resultEl.hidden = false;
  resultPrimary.focus();
  if (success) sound.win();
  else sound.lose();
}

function hideResult() {
  resultEl.hidden = true;
}

resultPrimary.addEventListener('click', () => {
  if (resultSuccess) {
    round += 1;
    setupRound();
  } else {
    retryLevel();
  }
  eqInput.focus();
  eqInput.setSelectionRange(eqInput.value.length, eqInput.value.length);
});

// ---------- Main loop ----------
let lastTime = performance.now();
function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.033);
  lastTime = now;
  update(dt);
  render();
  requestAnimationFrame(loop);
}

// ---------- Events ----------
startBtn.addEventListener('click', () => {
  try {
    equationFn = compileEquation(eqInput.value);
  } catch (e) {
    statusMsg.textContent = e.message;
    sound.lose();
    return;
  }
  equationText = eqInput.value;
  trail = [];
  landedAt = 0;
  sound.press();
  everLanded = false;
  eqInput.disabled = true;
  startBtn.disabled = true;
  onCurve = false;
  ball.vy = 0;
  statusMsg.textContent = 'Cube is falling...';
  running = true;
});

resetBtn.addEventListener('click', () => {
  if (absorb) return; // the cube is already going into the portal
  retryLevel();
});

eqInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startBtn.click();
  else if (e.key.length === 1 || e.key === 'Backspace') sound.type();
});

// live typeset preview under the box, so x^2 reads as x² before Start
const eqPreview = document.getElementById('eqPreview');
function updateEqPreview() {
  const raw = eqInput.value.trim();
  eqPreview.innerHTML = raw ? `<i>y</i> = ${typesetHTML(raw)}` : '';
}
eqInput.addEventListener('input', updateEqPreview);

// any button gets a soft click; the first gesture also unlocks audio
document.addEventListener('pointerdown', () => sound.unlock(), { once: true });
document.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (btn && btn !== startBtn && btn !== soundToggle) sound.click();
});

const soundToggle = document.getElementById('soundToggle');
function syncSoundToggle() {
  soundToggle.setAttribute('aria-pressed', String(sound.enabled));
  soundToggle.title = sound.enabled ? 'Sound on' : 'Sound off';
}
soundToggle.addEventListener('click', () => {
  sound.toggle();
  syncSoundToggle();
});
syncSoundToggle();

// ---------- Main menu ----------
const startScreen = document.getElementById('startScreen');
document.getElementById('newGameBtn').addEventListener('click', () => {
  round = 1;
  setupRound();
  startScreen.classList.add('is-leaving');
  setTimeout(() => {
    startScreen.hidden = true;
    startScreen.classList.remove('is-leaving');
    eqInput.focus();
  }, 250);
});

function openSheet(id) {
  const sheet = document.getElementById(id);
  sheet.hidden = false;
  sheet.querySelector('button').focus();
}
document.getElementById('creditsBtn').addEventListener('click', () => openSheet('creditsSheet'));
// a page can only close a window it opened itself, so when that's refused
// show a goodbye card instead
document.getElementById('quitBtn').addEventListener('click', () => {
  window.close();
  openSheet('quitSheet');
});
document.querySelectorAll('[data-close-sheet]').forEach((btn) => {
  btn.addEventListener('click', () => {
    btn.closest('.menu-sheet').hidden = true;
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.menu-sheet:not([hidden])').forEach((sheet) => { sheet.hidden = true; });
});

// ---------- Drag to pan ----------
let dragging = false;
let dragStart = null; // { px, py, camX, camY }

canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  const rect = canvas.getBoundingClientRect();
  dragStart = {
    px: (e.clientX - rect.left) * (viewW / rect.width),
    py: (e.clientY - rect.top) * (viewH / rect.height),
    camX,
    camY
  };
  canvas.style.cursor = 'grabbing';
});

window.addEventListener('mousemove', (e) => {
  if (!dragging || !dragStart) return;
  const rect = canvas.getBoundingClientRect();
  const px = (e.clientX - rect.left) * (viewW / rect.width);
  const py = (e.clientY - rect.top) * (viewH / rect.height);
  camX = dragStart.camX - (px - dragStart.px) / PX;
  camY = dragStart.camY + (py - dragStart.py) / PX;
});

window.addEventListener('mouseup', () => {
  dragging = false;
  dragStart = null;
  canvas.style.cursor = 'grab';
});

// touch support
canvas.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  dragging = true;
  const rect = canvas.getBoundingClientRect();
  dragStart = {
    px: (t.clientX - rect.left) * (viewW / rect.width),
    py: (t.clientY - rect.top) * (viewH / rect.height),
    camX,
    camY
  };
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
  if (!dragging || !dragStart) return;
  const t = e.touches[0];
  const rect = canvas.getBoundingClientRect();
  const px = (t.clientX - rect.left) * (viewW / rect.width);
  const py = (t.clientY - rect.top) * (viewH / rect.height);
  camX = dragStart.camX - (px - dragStart.px) / PX;
  camY = dragStart.camY + (py - dragStart.py) / PX;
}, { passive: true });

canvas.addEventListener('touchend', () => {
  dragging = false;
  dragStart = null;
});

// ---------- Init ----------
setupRound();
requestAnimationFrame(loop);
