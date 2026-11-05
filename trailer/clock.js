// Injected into the game iframe for the trailer. Replaces the browser's clock
// with a virtual one that only moves when the trailer calls __advance(ms), so
// every frame of gameplay is rendered at an exact moment, independent of how
// fast the machine records. It also renders the game at 3x pixel density so
// zoomed-in shots stay sharp.
(() => {
  let now = 0;
  const epoch = Date.now();
  const timers = new Map();
  let nextTimer = 1;
  let rafs = new Map();
  let nextRaf = 1;

  Object.defineProperty(window, 'devicePixelRatio', { get: () => 3 });

  // seeded randomness so every recording of the trailer is identical
  let seed = 20261103;
  Math.random = () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let r = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
  Date.now = () => epoch + now;
  performance.now = () => now;

  window.setTimeout = (fn, ms = 0, ...args) => {
    const id = nextTimer++;
    timers.set(id, { at: now + Math.max(0, ms), fn, args });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.setInterval = (fn, ms = 0, ...args) => {
    const id = nextTimer++;
    const tick = () => {
      fn(...args);
      if (timers.has(id)) timers.set(id, { at: now + Math.max(1, ms), fn: tick, args: [] });
    };
    timers.set(id, { at: now + Math.max(1, ms), fn: tick, args: [] });
    return id;
  };
  window.clearInterval = window.clearTimeout;
  window.requestAnimationFrame = (cb) => {
    const id = nextRaf++;
    rafs.set(id, cb);
    return id;
  };
  window.cancelAnimationFrame = (id) => rafs.delete(id);

  window.__advance = (ms) => {
    const target = now + ms;
    for (;;) {
      let due = null;
      for (const [id, t] of timers) {
        if (t.at <= target && (!due || t.at < due[1].at)) due = [id, t];
      }
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      try { due[1].fn(...due[1].args); } catch (e) { console.error(e); }
    }
    now = target;
    const callbacks = rafs;
    rafs = new Map();
    for (const cb of callbacks.values()) {
      try { cb(now); } catch (e) { console.error(e); }
    }
    // CSS animations and transitions follow the virtual clock too
    for (const anim of document.getAnimations()) {
      if (anim.__t0 === undefined) {
        anim.__t0 = now - (anim.currentTime || 0);
        anim.pause();
      }
      anim.currentTime = now - anim.__t0;
    }
  };
})();
