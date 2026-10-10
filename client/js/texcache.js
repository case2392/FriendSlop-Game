// The persistent painted-texture cache (IndexedDB). The paint workers (paint/worker.js) do all the
// reading and writing, so a busy page never holds it up; the page (texprep.js) only hashes the
// sources the keys are made of. One record per texture name: { name, key, w, h, deps, blob (PNG), at }.
//
// A record is good only while its key still matches. The key hashes everything that can change the
// pixels: the full source text of paint/core.js and of the texture's family module, the family
// sources of every texture its paint read (its recorded dependencies, absent ones included), its
// size and alpha flag, and an environment hash: CACHE_VERSION, the browser (its rasterizer paints the
// pixels), paint/worker.js (its exactness rules decide what a worker may hand over), the bytes of the
// page's web fonts, and how this machine draws the system font faces the families name.
// PNG, because it round-trips a canvas exactly, transparent texels included (lossless WebP does not).
//
// Everything fails safe: no IndexedDB (private windows), a blocked upgrade, a full quota (writes stop,
// reads go on), a corrupt or truncated record, another tab writing the same record. The caller paints
// instead.

// Bump CACHE_VERSION with any change that makes records written before it wrong in a way the key
// can't see: the record format or the key recipe here; what texprep.js lets the page snapshot and
// store (fontsSettled, leftAlone); or a paint that reads anything besides core.js, its family module,
// other textures and fonts. (A family module must import only ./core.js: test/logic.mjs checks.)
export const CACHE_VERSION = 2;
const DB = 'nmd-textures', STORE = 'tex';

// 53-bit hash (cyrb53) of a string or a byte array, as 14 hex digits
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  const text = typeof str === 'string';
  for (let i = 0; i < str.length; i++) {
    const ch = text ? str.charCodeAt(i) : str[i];
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// The source hashes the keys are made of: { core, fam: { family: hash }, env }. fonts: the page's web
// fonts (texprep.js fontList()). Fetched through the HTTP cache (the module loader and the page's fonts
// have filled most of it), hashed off the critical path.
export async function sourceHashes(families, fonts = []) {
  const base = new URL('./paint/', import.meta.url);
  const get = async (url, bytes) => {
    const r = await fetch(url, { cache: 'force-cache' });
    if (!r.ok) throw new Error(`${url}: ${r.status}`);
    return bytes ? new Uint8Array(await r.arrayBuffer()) : r.text();
  };
  const h = s => hash53(s) + s.length.toString(16);
  const urls = [...new Set(fonts.map(f => f.url))].sort();
  const [core, worker, ...rest] = await Promise.all(['core', 'worker', ...families].map(f => get(new URL(`${f}.js`, base))));
  const faces = await Promise.all(urls.map(u => get(u, true).then(b => `${u}:${h(b)}`, () => `${u}:missing`)));
  const fam = {};
  families.forEach((f, i) => { fam[f] = h(rest[i]); });
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const web = new Set(fonts.map(f => f.family.toLowerCase()));
  const sys = systemFaces(rest.join('\n')).filter(n => !web.has(n.toLowerCase()));   // web fonts: their bytes, above
  return { core: h(core), fam, env: hash53([CACHE_VERSION, ua, h(worker), ...faces, measureFaces(sys)].join('|')) };
}

// The system font faces the families' font stacks name ("bold 20px Georgia, 'DejaVu Serif', serif"):
// every comma list that ends in a generic family, plus the generic families themselves
export function systemFaces(src) {
  const out = new Set(['serif', 'sans-serif', 'monospace']);
  for (const m of src.matchAll(/((?:(?:'[^'\n]+'|"[^"\n]+"|[A-Za-z][\w -]*?)\s*,\s*)+)(?:sans-serif|serif|monospace)\b/g)) {
    for (const part of m[1].split(',')) { const n = part.trim().replace(/^.*px\s+/, '').replace(/^['"]|['"]$/g, '').trim(); if (n) out.add(n); }
  }
  return [...out].sort();
}
// How this machine sets those faces: the advance and the ink box of a few runs of glyphs in each,
// regular and bold. A face installed, removed or updated changes them (one that isn't installed sets
// in its fallback; a metric-compatible stand-in still has other ink). Measured, not read back as
// pixels: anti-fingerprinting canvas noise would make every session a cache miss.
function measureFaces(names) {
  try {
    const g = (typeof document !== 'undefined' ? document.createElement('canvas') : new OffscreenCanvas(1, 1)).getContext('2d');
    const generic = new Set(['serif', 'sans-serif', 'monospace']);
    return names.map(n => {
      const out = [];
      for (const w of ['', 'bold ']) {
        g.font = `${w}40px ${generic.has(n) ? n : JSON.stringify(n)}`;
        for (const s of ['Hamburgefonstiv', 'QR&$@gjy', '0123456789']) {
          const m = g.measureText(s);
          out.push(m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent);
        }
      }
      return `${n}:${out.join(' ')}`;
    }).join(',');
  } catch (e) { return `no probe: ${e?.message}`; }
}

// The key for a texture painted with these dependencies, under these source hashes. null when the
// texture (or a family it depends on) isn't one the hashes cover: never cached then.
export function keyOf(name, deps, H, meta) {
  const t = meta(name);
  if (!t || !H || !H.fam[t.family]) return null;
  const parts = [H.env, H.core, `${name}:${t.w}x${t.h}:${t.alpha ? 1 : 0}:${H.fam[t.family]}`];
  for (const d of deps || []) {
    const m = meta(d);
    if (!m) { parts.push(`${d}:absent`); continue; }
    if (!H.fam[m.family]) return null;
    parts.push(`${d}:${m.w}x${m.h}:${H.fam[m.family]}`);
  }
  return hash53(parts.join('|')) + hash53(parts.join('|'), 7);
}

// ---- IndexedDB, wrapped so nothing throws and nothing waits forever ----

let dbp = null, broken = false;
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);
// Opening can take a while (the first visit creates the database; a busy page delays its events): no
// time limit here, the reads below just stop waiting for it.
function open() {
  if (broken) return Promise.resolve(null);
  if (dbp) return dbp;
  dbp = new Promise((res, rej) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
    req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'name' }); };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { try { db.close(); } catch {} dbp = null; };   // a newer tab upgrades: let it
      res(db);
    };
    req.onerror = () => rej(req.error || new Error('open failed'));
    req.onblocked = () => rej(new Error('open blocked by another tab'));
  }).catch(e => { broken = true; note('off', e); return null; });
  return dbp;
}
let lastErr = '', full = false;
function note(what, e) { lastErr = `${what}: ${e?.message || e}`; }
// broken: no cache at all this session; full: the quota ran out, so no more writes (reads go on)
export function status() { return { broken, full, lastErr }; }

function tx(db, mode, fn) {
  return new Promise((res, rej) => {
    let t, out;
    try { t = db.transaction(STORE, mode); out = fn(t.objectStore(STORE)); } catch (e) { rej(e); return; }
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error || new Error('transaction failed'));
    t.onabort = () => rej(t.error || new Error('transaction aborted'));
  });
}
const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

// The records for these names (a Map; missing and unreadable ones are left out).
// A slow database is a miss this time (painted instead), not a broken cache.
export async function getMany(names, waitMs = 5000) {
  const out = new Map();
  if (!names.length) return out;
  let db;
  try { db = await withTimeout(open(), waitMs, 'texture cache open'); } catch (e) { note('slow', e); return out; }
  if (!db) return out;
  try {
    await withTimeout(tx(db, 'readonly', st => {
      for (const n of names) {
        const r = st.get(n);
        r.onsuccess = () => { const v = r.result; if (v && v.name === n && v.blob instanceof Blob && v.blob.size > 0) out.set(n, v); };
      }
    }), 8000, 'texture cache read');
  } catch (e) { note('read', e); }
  return out;
}
const opened = () => withTimeout(open(), 30000, 'texture cache open').catch(e => { note('slow', e); return null; });
export async function put(rec) {
  if (full) return false;
  const db = await opened();
  if (!db) return false;
  try { await withTimeout(tx(db, 'readwrite', st => st.put(rec)), 15000, 'texture cache write'); return true; } catch (e) {
    note('write', e);
    if (/quota/i.test(String(e?.name) + String(e?.message))) full = true;   // full: stop writing this session
    return false;
  }
}
export async function remove(names) {
  const db = await opened();
  if (!db || !names.length) return;
  try { await withTimeout(tx(db, 'readwrite', st => { for (const n of names) st.delete(n); }), 8000, 'texture cache delete'); } catch (e) { note('delete', e); }
}
export async function names() {
  const db = await opened();
  if (!db) return [];
  try { return await withTimeout(tx(db, 'readonly', st => reqP(st.getAllKeys())), 8000, 'texture cache keys'); } catch (e) { note('keys', e); return []; }
}
