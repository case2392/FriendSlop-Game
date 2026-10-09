// A paint worker (module worker; texprep.js runs a few). It imports the same family modules as the
// page and paints with the same toolkit on OffscreenCanvas (core.makeCanvas makes one when there is
// no document), so its pixels are the page's pixels (tools/texhash.mjs checks every texture).
//
//   → { t: 'init', fonts, hashes }       load the page's web fonts here, keep the cache key hashes
//   ← { t: 'ready', ok, err }
//   → { t: 'paint', id, name }           paint it (and whatever it reads); send back an ImageBitmap
//   ← { t: 'done', id, name, bmp, fresh: [{ name, deps, ms }] } | { t: 'fail', id, name, err }
//                                        fresh: what this job painted here (the texture and anything
//                                        its paint read that this worker hadn't painted yet)
//   → { t: 'store', id, names }          PNG-encode these (painting them first if this worker hasn't)
//                                        and write them to the texture cache; then forget them
//   ← { t: 'stored', id, n, bytes, err }
//   → { t: 'drop', names }               forget these canvases (nothing to store, memory back)
import { canvasFor, depsOf, forget, meta, hooks } from './index.js';
import { keyOf, put } from '../texcache.js';

let H = null, fresh = [];
hooks.painted = (name, p) => fresh.push({ name, deps: p.deps, ms: p.ms });
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

async function store(names) {
  let n = 0, bytes = 0, err = '';
  for (const name of names) {
    try {
      const cv = canvasFor(name);
      const key = keyOf(name, depsOf(name) || [], H, meta);
      if (key) {
        const blob = await cv.convertToBlob({ type: 'image/png' });
        if (await put({ name, key, w: cv.width, h: cv.height, deps: depsOf(name) || [], blob, at: Date.now() })) { n++; bytes += blob.size; }
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
      fresh = [];
      const cv = canvasFor(m.name);
      const got = fresh; fresh = [];
      const bmp = await createImageBitmap(cv);
      post({ t: 'done', id: m.id, name: m.name, bmp, fresh: got }, [bmp]);
    } catch (e) { post({ t: 'fail', id: m.id, name: m.name, err: e.message }); }
  } else if (m.t === 'store') {
    post({ t: 'stored', id: m.id, ...(await store(m.names)) });
  } else if (m.t === 'drop') {
    for (const n of m.names) forget(n);
  }
};
