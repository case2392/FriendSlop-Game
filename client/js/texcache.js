// The persistent painted-texture cache (IndexedDB), shared by the page (texprep.js) and the paint
// workers (paint/worker.js). One record per texture name: { name, key, w, h, deps, blob (PNG), at }.
//
// A record is good only while its key still matches. The key hashes everything that can change the
// pixels: the full source text of paint/core.js and of the texture's family module, the family
// sources of every texture its paint read (its recorded dependencies, absent ones included), its
// size and alpha flag, CACHE_VERSION, and the browser (its rasterizer and fonts paint the pixels).
// PNG, because it round-trips a canvas exactly, transparent texels included (lossless WebP does not).
//
// Everything fails safe: no IndexedDB (private windows), a blocked upgrade, a full quota, a corrupt
// or truncated record, another tab writing the same record. The caller paints instead.

export const CACHE_VERSION = 1;
const DB = 'nmd-textures', STORE = 'tex';

// 53-bit string hash (cyrb53), as 14 hex digits
export function hash53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

// The source hashes the keys are made of: { core, fam: { family: hash }, env }. Fetched from the HTTP
// cache the module loader just filled (no second download), hashed off the critical path.
export async function sourceHashes(families) {
  const base = new URL('./paint/', import.meta.url);
  const text = async f => {
    const r = await fetch(new URL(`${f}.js`, base), { cache: 'force-cache' });
    if (!r.ok) throw new Error(`${f}.js: ${r.status}`);
    return r.text();
  };
  const [core, ...rest] = await Promise.all(['core', ...families].map(text));
  const fam = {};
  families.forEach((f, i) => { fam[f] = hash53(rest[i]) + rest[i].length.toString(16); });
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return { core: hash53(core) + core.length.toString(16), fam, env: hash53(`${CACHE_VERSION}|${ua}`) };
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
function open() {
  if (broken) return Promise.resolve(null);
  if (dbp) return dbp;
  dbp = withTimeout(new Promise((res, rej) => {
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
  }), 4000, 'texture cache open').catch(e => { broken = true; note('off', e); return null; });
  return dbp;
}
let lastErr = '';
function note(what, e) { lastErr = `${what}: ${e?.message || e}`; }
export function status() { return { broken, lastErr }; }
export function disable(why = 'disabled') { broken = true; lastErr = why; }

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
export async function getMany(names) {
  const out = new Map();
  const db = await open();
  if (!db || !names.length) return out;
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
export async function put(rec) {
  const db = await open();
  if (!db) return false;
  try { await withTimeout(tx(db, 'readwrite', st => st.put(rec)), 15000, 'texture cache write'); return true; } catch (e) {
    note('write', e);
    if (/quota/i.test(String(e?.name) + String(e?.message))) broken = true;   // full: stop writing this session
    return false;
  }
}
export async function remove(names) {
  const db = await open();
  if (!db || !names.length) return;
  try { await withTimeout(tx(db, 'readwrite', st => { for (const n of names) st.delete(n); }), 8000, 'texture cache delete'); } catch (e) { note('delete', e); }
}
export async function names() {
  const db = await open();
  if (!db) return [];
  try { return await withTimeout(tx(db, 'readonly', st => reqP(st.getAllKeys())).then(p => p), 8000, 'texture cache keys'); } catch (e) { note('keys', e); return []; }
}
