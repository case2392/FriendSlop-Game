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
//   → { t: 'load', id, names }           read these from the texture cache: key check, decode
//   ← { t: 'loaded', id, hits, bmps, bad, err, cache }
//   → { t: 'prune' }                     delete records of textures that no longer exist
import { canvasFor, depsOf, forget, meta, hooks, has } from './index.js';
import { keyOf, put, getMany, remove, names as cachedNames, status as cacheStatus } from '../texcache.js';
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
  // Text set in one of the page's web fonts that this worker couldn't load (a failed fetch, or a
  // browser without fonts in workers) would come out in a fallback face, and be cached that way: a
  // paint that sets such text is inexact too, and the page paints it.
  for (const k of ['fillText', 'strokeText', 'measureText']) wrap(k, ctx => { if (NOFONT.size && NOFONT.has(fontFamily(ctx.font))) clipped = true; });
}
const post = (m, tr) => self.postMessage(m, tr || []);

// the families of the page's web fonts that didn't load here (lower case)
const NOFONT = new Set();
const fontFamily = f => String(f).replace(/^.*?\d[\d.]*px(\/\S+)?\s+/, '').split(',')[0].replace(/["']/g, '').trim().toLowerCase();
async function loadFonts(list) {
  if (!list?.length) return;
  if (!self.fonts || typeof FontFace === 'undefined') { for (const f of list) NOFONT.add(f.family.toLowerCase()); return; }
  await Promise.all(list.map(async f => {
    try {
      const ff = new FontFace(f.family, `url(${f.url})`, { weight: f.weight || 'normal', style: f.style || 'normal', unicodeRange: f.unicodeRange || 'U+0-10FFFF' });
      self.fonts.add(ff);
      await ff.load();
    } catch { NOFONT.add(f.family.toLowerCase()); }
  }));
}

async function store(names, bmps = null, depsList = null) {
  let n = 0, bytes = 0, err = '';
  for (const [i, name] of names.entries()) {
    try {
      if (cacheStatus().full) { bmps?.[i]?.close(); err = 'cache full'; forget(name); continue; }   // the quota ran out: no more writes
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
        const had = (await getMany([name], 15000)).get(name);
        if (had && had.key === key && had.w === cv.width && had.h === cv.height) { n++; forget(name); continue; }   // already there (another tab, an earlier session)
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
      // test hooks (tools/texfaults.mjs): storage that throws, the way a private window's can; or a
      // full one, whose writes fail on quota
      if (m.breakStorage) Object.defineProperty(self, 'indexedDB', { get() { throw new DOMException('storage denied', 'SecurityError'); } });
      if (m.fullStorage) IDBObjectStore.prototype.put = () => { throw new DOMException('quota exceeded', 'QuotaExceededError'); };
      await loadFonts(m.fonts);
      post({ t: 'ready', ok: true });
    } catch (e) { post({ t: 'ready', ok: false, err: e.message }); }
  } else if (m.t === 'paint') {
    let got = [];
    try {
      fresh = []; clipped = false;
      const cv = canvasFor(m.name);
      got = fresh; fresh = [];
      if (clipped) for (const f of got) INEXACT.add(f.name);
      // a paint that read a texture whose pixels depend on paint order (texmanifest IN_ORDER) is left to
      // the game to paint in its own order (alone)
      const deps = depsOf(m.name) || [];
      const alone = deps.some(d => IN_ORDER.includes(meta(d)?.family));
      const exact = !alone && !INEXACT.has(m.name) && !deps.some(d => INEXACT.has(d));
      if (!exact) { for (const f of got) forget(f.name); post({ t: 'done', id: m.id, name: m.name, bmp: null, exact, alone, fresh: [] }); return; }
      const bmp = await createImageBitmap(cv);
      post({ t: 'done', id: m.id, name: m.name, bmp, exact, fresh: got }, [bmp]);
    } catch (e) {
      for (const f of [...got, ...fresh]) forget(f.name);   // what it painted on the way: the page never hears of it
      fresh = [];
      post({ t: 'fail', id: m.id, name: m.name, err: e.message });
    }
  } else if (m.t === 'load') {
    // cache reads happen here, not on the page: a busy page can't delay them. Each record's key must
    // still match its texture's sources; it is decoded (off every thread that matters) and handed
    // back; a stale or unreadable record is deleted (this session's paint replaces it)
    const hits = [], bmps = [], bad = [];
    let err = '';
    try {
      if (!H) throw new Error('no source hashes');   // can't tell good records from stale ones: read nothing, delete nothing
      const recs = await getMany(m.names, 15000);
      await Promise.all(m.names.map(async name => {
        const rec = recs.get(name), t = meta(name);
        if (!rec) return;
        try {   // one malformed record (deps not a list, say) is just bad, not the whole batch
          if (t && rec.w === t.w && rec.h === t.h && Array.isArray(rec.deps) && rec.key === keyOf(name, rec.deps, H, meta)) {
            const bmp = await createImageBitmap(rec.blob, { premultiplyAlpha: 'default', colorSpaceConversion: 'none' });
            if (bmp.width === t.w && bmp.height === t.h) { hits.push(name); bmps.push(bmp); return; }
            bmp.close();
          }
        } catch { /* unreadable */ }
        bad.push(name);
      }));
      if (bad.length) await remove(bad);
    } catch (e) { err = e.message; }
    post({ t: 'loaded', id: m.id, hits, bmps, bad, err, cache: cacheStatus() }, bmps);
  } else if (m.t === 'prune') {
    // records of textures that no longer exist
    try { const gone = (await cachedNames()).filter(n => !has(n)); if (gone.length) await remove(gone); } catch { /* next time */ }
  } else if (m.t === 'store') {
    post({ t: 'stored', id: m.id, ...(await store(m.names, m.bmps, m.deps)), cache: cacheStatus() });
  } else if (m.t === 'drop') {
    for (const n of m.names) forget(n);
  }
};
