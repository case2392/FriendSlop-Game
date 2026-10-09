// Getting painted textures ready before the world build asks for them (docs/DESIGN.md, load time).
//
//   init()                    start the paint workers and hash the paint sources (cache keys)
//   prepare(names, opts)      make these textures ready: decoded from the persistent cache (texcache.js)
//                             where a good record exists, else painted by a pool of module workers
//                             (paint/worker.js) running the same family modules. Results go to
//                             paint/core.js (adopt): canvasFor then copies instead of painting.
//                             opts.page: also paint, on this thread while the workers work, the ones
//                             a worker can't paint exactly (see PAGE_ONLY); off for a background
//                             prefetch, which never paints here. Resolves when all are ready or failed.
//   dayList(biome)            the textures a day in this biome asks for, in build order: the shipped
//                             list (texmanifest.js) plus what this browser saw such a build ask for
//   record(on, biome)         learn what a build asks for
//   flush()                   after the world is up: what was painted this session goes into the cache,
//                             PNG-encoded and written by the workers, one texture per idle slot
//
// None of it is needed for correctness. With no workers, no OffscreenCanvas, no IndexedDB, or any
// error, canvasFor paints on the main thread exactly as it always did.
import * as P from './paint/index.js';
import * as TC from './texcache.js';
import { DAY_TEXTURES, PAGE_ONLY as SHIPPED_PAGE_ONLY, IN_ORDER } from './texmanifest.js';

const q = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); } })();
const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
const WANT = q.has('paintWorkers') ? Math.max(0, Math.min(8, +q.get('paintWorkers') | 0)) : Math.max(0, Math.min(4, hc - 1));
const CACHE_ON = q.get('texcache') !== '0';
const now = () => performance.now();
const idleCb = typeof requestIdleCallback === 'function' ? (f, ms = 2000) => requestIdleCallback(f, { timeout: ms }) : f => setTimeout(f, 50);
const tick = () => new Promise(r => setTimeout(r, 0));
const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode, full: fine */ } };

// Textures a worker can't paint pixel for pixel: their paint clips, and an OffscreenCanvas clips
// without antialiasing where the page's canvas antialiases. The page paints these (and caches its own
// result). Shipped with the manifest, learned when a worker reports one.
const PAGE_ONLY = new Set([...(SHIPPED_PAGE_ONLY || []), ...lsGet('nmdTexPageOnly')]);
// Families whose paints come out differently depending on what was painted before them (characters.js
// strokes through a scratch canvas whose size depends on history): left alone entirely, so the game
// paints them when it asks for them, in the order it always has. Registered-at-run-time textures
// (families texcache doesn't hash) are left alone too.
const ALONE = new Set(lsGet('nmdTexAlone'));   // ...and what reads them (learned from the workers)
const leftAlone = name => { const f = P.meta(name)?.family; return !f || (IN_ORDER || []).includes(f) || !P.FAMILIES.includes(f) || ALONE.has(name); };

const S = {
  workers: [], ready: false, initDone: false, failed: '', H: null, hashP: null,
  queue: [],                    // [{ name, prio, seq }] waiting for a worker
  jobs: new Map(),              // name -> { resolve, promise }: queued or in-flight worker paints
  waiting: new Map(),           // name -> promise: being made ready by some prepare()
  pageQ: [], pageRunning: false,
  held: new Map(),              // name -> worker index: painted by that worker this session, not stored yet
  snaps: new Map(),             // name -> { deps, bmp: Promise<ImageBitmap> }: painted here, to store
  good: new Set(),              // names whose cache record is known good (decoded or written this session)
  stats: { cacheHits: 0, cacheMiss: 0, decodeMs: 0, workerPaints: 0, workerMs: 0, pagePaints: 0, pageMs: 0, inexact: 0, stored: 0, storedKB: 0, storeErr: '', fails: 0 },
  seq: 0, rec: null, recBiome: null, flushing: false,
};

// ---- fonts: the workers load the page's own faces; the page's paints are cached only once they're in

export function fontList() {
  const out = [];
  try {
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch { continue; }
      for (const r of rules) {
        if (!(r instanceof CSSFontFaceRule)) continue;
        const st = r.style, m = /url\(["']?([^"')]+)["']?\)/.exec(st.getPropertyValue('src'));
        if (!m) continue;
        out.push({ family: st.getPropertyValue('font-family').replace(/["']/g, '').trim(), url: new URL(m[1], sh.href || location.href).href, weight: st.getPropertyValue('font-weight') || 'normal', style: st.getPropertyValue('font-style') || 'normal', unicodeRange: st.getPropertyValue('unicode-range') || undefined });
      }
    }
  } catch { /* none */ }
  return out;
}
let fontsIn = false;
function fontsSettled() {
  if (fontsIn) return true;
  try {
    const fs = document.fonts;
    if (!fs) return (fontsIn = true);
    if (fs.status !== 'loaded') return false;
    // every face the page declares for plain Latin is loaded (not just "nothing is loading right now")
    const faces = fontList().filter(f => !f.unicodeRange || /U\+0+-|U\+0-/i.test(f.unicodeRange));
    if (!faces.every(f => fs.check(`${f.style === 'normal' ? '' : f.style + ' '}${f.weight} 16px "${f.family}"`))) return false;
    return (fontsIn = true);
  } catch { return (fontsIn = true); }
}

// ---- what the page paints itself (core.js hooks) ----

P.hooks.painted = (name, p) => {
  S.stats.pagePaints++; S.stats.pageMs += p.ms;
  // a snapshot now, before anything else draws on the canvas (rv3d repaints its body when Cinzel
  // lands); a paint made before the web fonts were in is never cached
  if (!CACHE_ON || TC.status().broken || !fontsSettled() || S.good.has(name) || leftAlone(name) || p.deps.some(leftAlone)) return;
  try { S.snaps.set(name, { deps: p.deps, bmp: createImageBitmap(p.cv).catch(() => null) }); } catch { /* no snapshot: not cached */ }
};
P.hooks.requested = name => { if (S.rec) S.rec.add(name); };

// ---- the worker pool ----

let initP = null;
export function init() {
  if (initP) return initP;
  if (!CACHE_ON) TC.disable('off (?texcache=0)');
  S.hashP = CACHE_ON ? TC.sourceHashes(P.FAMILIES).then(h => (S.H = h), e => { TC.disable(`hashes: ${e.message}`); return null; }) : Promise.resolve(null);
  initP = (async () => {
    if (!WANT || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') { S.failed = 'no workers'; return; }
    const fonts = fontList();
    const H = await S.hashP;
    const starts = [];
    for (let i = 0; i < WANT; i++) {
      let w;
      try { w = new Worker(new URL('./paint/worker.js', import.meta.url), { type: 'module' }); } catch (e) { S.failed = e.message; break; }
      const W = { w, i, busy: null, alive: false, storeCb: null };
      starts.push(new Promise(res => {
        const t = setTimeout(() => res(false), 15000);
        w.onmessage = ({ data: m }) => {
          if (m.t !== 'ready') return;
          clearTimeout(t); W.alive = !!m.ok; if (!m.ok) S.failed = m.err;
          w.onmessage = e => onMessage(W, e.data);
          res(W.alive);
        };
        w.onerror = e => { clearTimeout(t); S.failed = e.message || 'a paint worker failed to start'; res(false); };
      }));
      w.postMessage({ t: 'init', fonts, hashes: H });
      S.workers.push(W);
    }
    const ok = await Promise.all(starts);
    S.workers = S.workers.filter((W, k) => { if (!ok[k]) { try { W.w.terminate(); } catch {} } return ok[k]; });
    for (const W of S.workers) { W.w.onerror = () => workerDied(W); W.w.onmessageerror = () => workerDied(W); }
    S.ready = S.workers.length > 0;
  })().catch(e => { S.failed = e.message; }).finally(() => {
    S.initDone = true;
    if (!S.ready) for (const j of S.queue.splice(0)) settle(j.name, false);
    pump();
  });
  return initP;
}

function workerDied(W) {
  if (!S.workers.includes(W)) return;
  W.alive = false;
  try { W.w.terminate(); } catch {}
  S.workers = S.workers.filter(x => x !== W);
  if (W.busy) { const j = W.busy; W.busy = null; settle(j.name, false); }
  if (W.storeCb) { const cb = W.storeCb; W.storeCb = null; cb({ n: 0, bytes: 0, err: 'worker died' }); }
  for (const [n, wi] of S.held) if (wi === W.i) S.held.delete(n);
  if (!S.workers.length) { S.ready = false; for (const j of S.queue.splice(0)) settle(j.name, false); }
  pump();
}

function onMessage(W, m) {
  if (m.t === 'done' || m.t === 'fail') {
    W.busy = null;
    if (m.t === 'fail') { S.stats.fails++; settle(m.name, false); }
    else if (m.alone) {
      if (!ALONE.has(m.name)) { ALONE.add(m.name); lsSet('nmdTexAlone', [...ALONE]); }
      settle(m.name, false);
    } else if (!m.exact) {
      S.stats.inexact++;
      if (!PAGE_ONLY.has(m.name)) { PAGE_ONLY.add(m.name); lsSet('nmdTexPageOnly', [...PAGE_ONLY]); }
      settle(m.name, 'page');
    } else {
      for (const f of m.fresh || []) { S.held.set(f.name, W.i); S.stats.workerPaints++; S.stats.workerMs += f.ms; }
      P.adopt(m.name, m.bmp);
      settle(m.name, true);
    }
    pump();
  } else if (m.t === 'stored') {
    const cb = W.storeCb; W.storeCb = null;
    cb?.(m);
    pump();
  }
}

function settle(name, v) {
  const j = S.jobs.get(name);
  if (j) { S.jobs.delete(name); j.resolve(v); }
}

function pump() {
  if (!S.ready) return;
  S.queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
  for (const W of S.workers) {
    if (W.busy || W.storeCb || !W.alive) continue;
    let j;
    while ((j = S.queue.shift()) && P.ready(j.name)) settle(j.name, true);   // the page got there first
    if (!j) break;
    W.busy = j;
    W.w.postMessage({ t: 'paint', id: j.seq, name: j.name });
  }
  if (!S.queue.length && !S.workers.some(W => W.busy)) maybeFlush();
}

// -> true (adopted), 'page' (a worker can't paint it exactly), false (failed, or no workers)
function paintInWorker(name, prio) {
  if (S.initDone && !S.ready) return Promise.resolve(false);
  const had = S.jobs.get(name);
  if (had) { const qd = S.queue.find(j => j.name === name); if (qd && prio < qd.prio) qd.prio = prio; return had.promise; }
  let resolve;
  const promise = new Promise(r => (resolve = r));
  S.jobs.set(name, { resolve, promise });
  S.queue.push({ name, prio, seq: ++S.seq });
  pump();
  return promise;
}

// the page's own paints while it waits on the workers: one texture per task, so worker results land
function paintHere(name) {
  return new Promise(res => {
    S.pageQ.push({ name, res });
    if (S.pageRunning) return;
    S.pageRunning = true;
    (async () => {
      while (S.pageQ.length) {
        const j = S.pageQ.shift();
        try { if (!P.ready(j.name)) P.canvasFor(j.name); } catch (e) { console.warn('texture', j.name, e.message); }
        j.res(P.ready(j.name));
        await tick();
      }
      S.pageRunning = false;
    })();
  });
}

// ---- prepare ----

async function decode(rec) {
  const t0 = now();
  try {
    const bmp = await createImageBitmap(rec.blob, { premultiplyAlpha: 'default', colorSpaceConversion: 'none' });
    S.stats.decodeMs += now() - t0;
    return bmp;
  } catch { return null; }
}

// Make these textures ready. opts.prio: lower is sooner (a build waiting beats a prefetch);
// opts.page: paint the page-only ones here meanwhile. Resolves to { ready, total, ms }.
export async function prepare(names, { prio = 0, page = true, onProgress = null } = {}) {
  const t0 = now();
  init();
  const want = [...new Set(names)].filter(n => P.has(n) && !P.ready(n) && !leftAlone(n));
  const total = want.length;
  let done = 0;
  const step = () => { done++; onProgress?.(done, total); };
  if (!total) return { ready: 0, total: 0, ms: 0 };
  const H = S.hashP ? await S.hashP : null;
  const lookup = want.filter(n => !S.waiting.has(n));
  const recs = H && lookup.length ? await TC.getMany(lookup) : new Map();
  const bad = [];
  const tasks = want.map((name, k) => {
    if (S.waiting.has(name)) return S.waiting.get(name).then(step);
    const rec = recs.get(name), t = P.meta(name);
    const p = (async () => {
      if (rec) {
        if (t && rec.w === t.w && rec.h === t.h && rec.key === TC.keyOf(name, rec.deps, H, P.meta)) {
          const bmp = await decode(rec);
          if (bmp && P.adopt(name, bmp)) { S.good.add(name); S.stats.cacheHits++; return true; }
        }
        if (!P.ready(name)) bad.push(name);
      }
      if (P.ready(name)) return true;
      S.stats.cacheMiss++;
      let r = PAGE_ONLY.has(name) ? 'page' : await paintInWorker(name, prio + k * 1e-6);
      if (r === 'page' || (r === false && page && !ALONE.has(name))) r = page ? await paintHere(name) : false;
      return r === true;
    })().finally(() => S.waiting.delete(name));
    S.waiting.set(name, p);
    return p.then(step);
  });
  await Promise.all(tasks);
  if (bad.length) TC.remove(bad);   // stale or unreadable: rewritten from this session's paints
  return { ready: want.filter(n => P.ready(n)).length, total, ms: Math.round(now() - t0) };
}

// ---- which textures a day asks for ----

const LS = 'nmdTexDay:';
export function dayList(biome) {
  return [...new Set([...(DAY_TEXTURES[biome] || []), ...lsGet(LS + biome)])].filter(n => P.has(n));
}
export function record(on, biome = null) {
  if (on) { if (S.rec) record(false); S.rec = new Set(); S.recBiome = biome; return; }
  const got = S.rec; S.rec = null;
  if (!got || !S.recBiome) return;
  const ship = new Set(DAY_TEXTURES[S.recBiome] || []);
  // only what the shipped list doesn't have already, newest first
  lsSet(LS + S.recBiome, [...new Set([...[...got].filter(n => !ship.has(n)), ...lsGet(LS + S.recBiome)])].slice(0, 1500));
}
export function recorded() { return S.rec ? [...S.rec] : null; }

// ---- persisting this session's paints, in idle time ----

let flushWanted = false;
export function flush() { flushWanted = true; maybeFlush(); }
function maybeFlush() {
  if (!flushWanted || S.flushing) return;
  if (S.queue.length || S.workers.some(W => W.busy)) return;   // painting for a build or a prefetch comes first
  flushWanted = false;
  S.flushing = true;
  runFlush().catch(e => { S.stats.storeErr = e.message; }).finally(() => { S.flushing = false; if (flushWanted) maybeFlush(); });
}
async function runFlush() {
  if (!S.ready) { for (const s of S.snaps.values()) s.bmp.then(b => b?.close()); S.snaps.clear(); return; }
  const H = S.hashP ? await S.hashP : null;
  const cacheOK = !!H && !TC.status().broken;
  // what the workers hold: store it, or let it go
  const items = [];
  const drop = new Map();
  for (const [name, wi] of S.held) {
    const W = S.workers.find(x => x.i === wi);
    if (!W) continue;
    if (cacheOK && !S.good.has(name)) items.push({ name, W });
    else { if (!drop.has(W)) drop.set(W, []); drop.get(W).push(name); }
  }
  S.held.clear();
  for (const [W, names] of drop) W.w.postMessage({ t: 'drop', names });
  // and the page's own paints, from their snapshots
  for (const [name, s] of S.snaps) {
    if (cacheOK && !S.good.has(name) && !items.some(it => it.name === name)) items.push({ name, snap: s });
    else s.bmp.then(b => b?.close());
  }
  S.snaps.clear();
  let k = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (S.queue.length || S.workers.some(W => W.busy) || !S.ready) {   // a build or a prefetch wants the workers: hand back the rest
      for (const r of items.slice(i)) { if (r.W) S.held.set(r.name, r.W.i); else S.snaps.set(r.name, r.snap); }
      flushWanted = true;
      return;
    }
    await new Promise(r => idleCb(r));
    if (S.queue.length || S.workers.some(W => W.busy || W.storeCb)) { i--; await tick(); continue; }   // checked again at the top
    let W = it.W && S.workers.includes(it.W) ? it.W : null, msg, tr = [];
    if (it.snap) {
      const bmp = await it.snap.bmp;
      if (!bmp) continue;
      W = S.workers[k++ % S.workers.length];
      msg = { t: 'store', id: 0, names: [it.name], bmps: [bmp], deps: [it.snap.deps] }; tr = [bmp];
    } else msg = { t: 'store', id: 0, names: [it.name] };
    if (!W) continue;
    const res = await new Promise(r => { W.storeCb = r; W.w.postMessage(msg, tr); });
    if (res.n) { S.good.add(it.name); S.stats.stored += res.n; S.stats.storedKB += Math.round(res.bytes / 1024); }
    if (res.err) S.stats.storeErr = res.err;
  }
  if (cacheOK && !S.pruned) {   // records of textures that no longer exist
    S.pruned = true;
    const gone = (await TC.names()).filter(n => !P.has(n));
    if (gone.length) await TC.remove(gone);
  }
}

// for the harness and the tests
// idle: nothing being made ready, and nothing painted this session left to store (if it can be stored)
export function idle() {
  const unstored = S.ready && !TC.status().broken && (S.held.size || S.snaps.size);
  return !S.flushing && !flushWanted && !unstored && !S.queue.length && !S.workers.some(W => W.busy) && !S.waiting.size && !S.pageQ.length;
}
export function stats() {
  const r = { workers: S.workers.length, failed: S.failed, cache: TC.status(), pageOnly: PAGE_ONLY.size, ...S.stats };
  for (const k of ['pageMs', 'workerMs', 'decodeMs']) r[k] = Math.round(r[k]);
  return r;
}
