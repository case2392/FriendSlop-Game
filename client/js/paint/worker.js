// A paint worker (module worker; texprep.js runs a few). It imports the same family modules as the
// page and paints with the same toolkit on OffscreenCanvas (core.makeCanvas makes one when there is
// no document), so its pixels are the page's pixels (tools/texhash.mjs checks every texture).
//
//   → { t: 'init', fonts, hashes }       load the page's web fonts here, keep the cache key hashes
//   ← { t: 'ready', ok, err }
//   → { t: 'paint', id, name }           paint it (and whatever it reads); send back an ImageBitmap
//   ← { t: 'done', id, name, bmp, exact, fresh: [{ name, deps, ms }] } | { t: 'fail', id, name, err }
//                                        exact false: no bitmap; the page paints this one (it clips), or
//                                        with alone, the game paints it when it asks (paint-order deps)
//                                        fresh: what this job painted here (the texture and anything
//                                        its paint read that this worker hadn't painted yet)
//   → { t: 'store', id, names, bmps?, deps? }  PNG-encode these and write them to the texture cache,
//                                        then forget them: the page's snapshots (bmps, with the deps
//                                        its paint recorded) or this worker's paints (painted now if
//                                        it hasn't yet; an inexact one is refused)
//   ← { t: 'stored', id, n, bytes, err }
//   → { t: 'drop', names }               forget these canvases (nothing to store, memory back)
import { canvasFor, depsOf, forget, meta, hooks } from './index.js';
import { keyOf, put } from '../texcache.js';
import { IN_ORDER } from '../texmanifest.js';

let H = null, fresh = [];
hooks.painted = (name, p) => fresh.push({ name, deps: p.deps, ms: p.ms });

// An OffscreenCanvas context clips without antialiasing; the page's canvas antialiases its clips. The
// two agree only where a clip's edges fall on pixel edges: a path of axis-aligned rects at whole-pixel
// corners. A paint that clips to anything else (or reads a texture that did) can't come out the same
// here: it is reported as inexact, never stored, and the page paints it itself.
const C2D = self.OffscreenCanvasRenderingContext2D?.prototype;
let clipped = false;
const INEXACT = new Set();
if (C2D?.clip) {
  const aligned = new WeakMap();   // context -> its current path is only whole-pixel rects (no entry: empty path)
  const whole = v => Math.abs(v - Math.round(v)) < 1e-9;
  const wrap = (k, f) => { const o = C2D[k]; if (o) C2D[k] = function (...a) { f(this, a); return o.apply(this, a); }; };
  wrap('beginPath', ctx => aligned.set(ctx, true));
  wrap('rect', (ctx, [x, y, w, h]) => {
    if (aligned.get(ctx) === false) return;
    const m = ctx.getTransform();
    const ok = m.b === 0 && m.c === 0 && [m.a * x + m.e, m.d * y + m.f, m.a * (x + w) + m.e, m.d * (y + h) + m.f].every(whole);
    aligned.set(ctx, ok);
  });
  for (const k of ['moveTo', 'lineTo', 'arc', 'arcTo', 'bezierCurveTo', 'quadraticCurveTo', 'ellipse', 'roundRect']) wrap(k, ctx => aligned.set(ctx, false));
  wrap('clip', (ctx, a) => { if ((a.length && typeof a[0] === 'object') || aligned.get(ctx) === false) clipped = true; });
}
const post = (m, tr) => self.postMessage(m, tr || []);

async function loadFonts(list) {
  if (!list?.length || !self.fonts || typeof FontFace === 'undefined') return;
  await Promise.all(list.map(async f => {
    try {
      const ff = new FontFace(f.family, `url(${f.url})`, { weight: f.weight || 'normal', style: f.style || 'normal', unicodeRange: f.unicodeRange || 'U+0-10FFFF' });
      self.fonts.add(ff);
      await ff.load();
    } catch { /* a font that won't load here: the texture texprep paints with it is checked by texhash */ }
  }));
}

async function store(names, bmps = null, depsList = null) {
  let n = 0, bytes = 0, err = '';
  for (const [i, name] of names.entries()) {
    try {
      let cv;
      if (bmps?.[i]) {   // the page's own paint, snapshotted right after it was painted
        const b = bmps[i];
        cv = new OffscreenCanvas(b.width, b.height);
        const g = cv.getContext('2d', { willReadFrequently: true });
        g.globalCompositeOperation = 'copy'; g.drawImage(b, 0, 0); b.close();
      } else {
        clipped = false;
        cv = canvasFor(name);
        if (clipped || INEXACT.has(name)) { INEXACT.add(name); forget(name); err = 'inexact'; continue; }
      }
      const deps = bmps?.[i] ? (depsList?.[i] || []) : (depsOf(name) || []);
      const key = keyOf(name, deps, H, meta);
      if (key) {
        const blob = await cv.convertToBlob({ type: 'image/png' });
        if (await put({ name, key, w: cv.width, h: cv.height, deps, blob, at: Date.now() })) { n++; bytes += blob.size; }
        else err = 'write failed';
      }
    } catch (e) { err = e.message; }
    forget(name);
  }
  return { n, bytes, err };
}

self.onmessage = async ({ data: m }) => {
  if (m.t === 'init') {
    try {
      if (typeof OffscreenCanvas === 'undefined') throw new Error('no OffscreenCanvas');
      const probe = new OffscreenCanvas(4, 4).getContext('2d', { willReadFrequently: true });
      if (!probe) throw new Error('no 2d context on OffscreenCanvas');
      H = m.hashes || null;
      await loadFonts(m.fonts);
      post({ t: 'ready', ok: true });
    } catch (e) { post({ t: 'ready', ok: false, err: e.message }); }
  } else if (m.t === 'hashes') {
    H = m.hashes;
  } else if (m.t === 'paint') {
    try {
      fresh = []; clipped = false;
      const cv = canvasFor(m.name);
      const got = fresh; fresh = [];
      if (clipped) for (const f of got) INEXACT.add(f.name);
      // a paint that read a texture whose pixels depend on paint order (texmanifest IN_ORDER) is left to
      // the game to paint in its own order (alone)
      const deps = depsOf(m.name) || [];
      const alone = deps.some(d => IN_ORDER.includes(meta(d)?.family));
      const exact = !alone && !INEXACT.has(m.name) && !deps.some(d => INEXACT.has(d));
      if (!exact) { for (const f of got) forget(f.name); post({ t: 'done', id: m.id, name: m.name, bmp: null, exact, alone, fresh: [] }); return; }
      const bmp = await createImageBitmap(cv);
      post({ t: 'done', id: m.id, name: m.name, bmp, exact, fresh: got }, [bmp]);
    } catch (e) { post({ t: 'fail', id: m.id, name: m.name, err: e.message }); }
  } else if (m.t === 'store') {
    post({ t: 'stored', id: m.id, ...(await store(m.names, m.bmps, m.deps)) });
  } else if (m.t === 'drop') {
    for (const n of m.names) forget(n);
  }
};
