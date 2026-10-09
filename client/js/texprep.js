// Getting painted textures ready before the world build asks for them (docs/DESIGN.md, load time).
//
//   init()                    start the paint workers and hash the paint sources (cache keys)
//   prepare(names, opts)      make these textures ready: read and decoded from the persistent cache
//                             (texcache.js, by the workers) where a good record exists, else painted
//                             by a pool of module workers (paint/worker.js) running the same family
//                             modules. Results go to paint/core.js (adopt): canvasFor then copies
//                             instead of painting.
//                             opts.page: also paint, on this thread while the workers work, the ones
//                             a worker can't paint exactly (see PAGE_ONLY); 'idle': only in long idle
//                             stretches while opts.idleOk() (the menu); false for a background
//                             prefetch, which never paints here. opts.prio >= 1 (a prefetch) gets one
//                             worker at a time. Resolves when all are ready or failed.
//   dayList(biome)            the textures a day in this biome asks for, in build order: the shipped
//                             list (texmanifest.js) plus what this browser saw such a build ask for
//   record(on, biome)         learn what a build asks for
//   flush()                   after the world is up (and after a prefetch): what was painted this
//                             session goes into the cache, PNG-encoded and written by two workers at
//                             most (the page only hands over a snapshot); anything a build needs
//                             goes first
//   keepOnly(names)           let go of pictures readied for a different day
//   building(on)              a world build is under way: no cache writes until it is off (a flush
//                             in progress hands its work back)
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
  snaps: new Map(),             // name -> { deps, cv }: painted here, to store
  good: new Set(),              // names whose cache record is known good (decoded or written this session)
  stats: { cacheHits: 0, cacheMiss: 0, decodeMs: 0, workerPaints: 0, workerMs: 0, pagePaints: 0, pageMs: 0, inexact: 0, stored: 0, storedKB: 0, storeErr: '', fails: 0 },
  seq: 0, rec: null, recBiome: null, flushing: false, cacheOff: '',
  pageNames: [],                // what the page painted itself, for the harness ("name ms")
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
  if (S.pageNames.length < 400) S.pageNames.push(`${name} ${Math.round(p.ms)}`);
  // kept for the cache; the snapshot is taken at flush time, after the world is up, so it costs nothing
  // now (a snapshot makes the canvas finish rasterizing, which the first frames would do anyway). A
  // paint made before the web fonts were in is never cached. (Nothing draws on a texture's canvas
  // after its paint except rv3d, which repaints its body the same way once Cinzel is in.)
  if (!CACHE_ON || S.cacheOff || !fontsSettled() || S.good.has(name) || leftAlone(name) || p.deps.some(leftAlone)) return;
  S.snaps.set(name, { deps: p.deps, cv: p.cv });
  lateFlush();
};
P.hooks.requested = name => { if (S.rec) S.rec.add(name); };

// ---- the worker pool ----

let initP = null;
export function init() {
  if (initP) return initP;
  if (!CACHE_ON) S.cacheOff = 'off (?texcache=0)';
  S.hashP = CACHE_ON ? TC.sourceHashes(P.FAMILIES).then(h => (S.H = h), e => { S.cacheOff = `hashes: ${e.message}`; return null; }) : Promise.resolve(null);
  initP = (async () => {
    if (!WANT || typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') { S.failed = 'no workers'; return; }
    const fonts = fontList();
    const H = await S.hashP;
    const starts = [];
    for (let i = 0; i < WANT; i++) {
      let w;
      try { w = new Worker(new URL('./paint/worker.js', import.meta.url), { type: 'module' }); } catch (e) { S.failed = e.message; break; }
      const W = { w, i, busy: null, alive: false, storeCb: null, loads: new Map() };
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
      w.postMessage({ t: 'init', fonts, hashes: H, breakStorage: q.get('texcache') === 'broken' });
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
  for (const cb of W.loads.values()) cb({ hits: [], bmps: [], bad: [], err: 'worker died' });
  W.loads.clear();
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
  } else if (m.t === 'loaded') {
    if (m.cache?.broken) { S.cacheOff = m.cache.lastErr || 'unavailable'; }
    const cb = W.loads.get(m.id); W.loads.delete(m.id);
    cb?.(m);
  }
}

// Cache reads go to the workers (their event loops aren't held up by a busy page): the names split
// across them, each reply a set of decoded bitmaps. -> Map name -> ImageBitmap
async function loadFromCache(names) {
  const out = new Map();
  await init();
  if (!S.ready || S.cacheOff || !names.length) return out;
  const ws = S.workers.slice().sort((a, b) => (a.busy ? 1 : 0) - (b.busy ? 1 : 0));
  const per = Math.ceil(names.length / ws.length);
  const t0 = now();
  await Promise.all(ws.map((W, i) => {
    const part = names.slice(i * per, (i + 1) * per);
    if (!part.length) return null;
    const id = ++S.seq;
    return new Promise(res => {
      const t = setTimeout(() => { W.loads.delete(id); res(); }, 30000);   // a worker that never answers: paint instead
      W.loads.set(id, m => { clearTimeout(t); m.hits.forEach((n, k) => out.set(n, m.bmps[k])); if (m.err) S.stats.storeErr = `read: ${m.err}`; res(); });
      W.w.postMessage({ t: 'load', id, names: part });
    });
  }));
  S.stats.decodeMs += now() - t0;
  return out;
}

function settle(name, v) {
  const j = S.jobs.get(name);
  if (j) { S.jobs.delete(name); j.resolve(v); }
}

// Background work (a prefetch: prio >= 1) gets one worker at a time, so it never takes more than a
// core from the game it runs behind; a build that is waiting (prio 0) gets them all.
function pump() {
  if (!S.ready) return;
  S.queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
  for (const W of S.workers) {
    if (W.busy || W.storeCb || !W.alive) continue;
    while (S.queue.length && P.ready(S.queue[0].name)) settle(S.queue.shift().name, true);   // the page got there first
    const j = S.queue[0];
    if (!j) break;
    if (j.prio >= 1 && S.workers.some(x => x.busy && x.busy.prio >= 1)) break;
    S.queue.shift();
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

// opts.page 'idle': the page paints its share only in long idle stretches, and only while idleOk()
// says so (true: go, false: not now, null: never mind). A build that wants one promotes it to paintHere.
const idleQ = [];
let idleRunning = false;
function paintIdle(name, ok) {
  if (typeof requestIdleCallback !== 'function') return Promise.resolve(false);
  return new Promise(res => {
    idleQ.push({ name, res, ok });
    if (idleRunning) return;
    idleRunning = true;
    const step = dl => {
      // done already, or no longer wanted (ok() says null: the menu has gone)
      while (idleQ.length && (P.ready(idleQ[0].name) || idleQ[0].ok() === null)) { const j = idleQ.shift(); j.res(P.ready(j.name)); }
      const j = idleQ[0];
      if (!j) { idleRunning = false; return; }
      if (j.ok() && !dl.didTimeout && dl.timeRemaining() >= 8) {   // a paint can outlast the slot: ok() only says yes while nobody is typing
        idleQ.shift();
        try { P.canvasFor(j.name); } catch (e) { console.warn('texture', j.name, e.message); }
        j.res(P.ready(j.name));
      }
      requestIdleCallback(step, { timeout: 1000 });   // a page that is never idle still gets to notice ok() giving up
    };
    requestIdleCallback(step, { timeout: 1000 });
  });
}
function promote(name) {
  const i = idleQ.findIndex(j => j.name === name);
  if (i < 0) return;
  const [j] = idleQ.splice(i, 1);
  paintHere(name).then(j.res);
}

// ---- prepare ----

// Make these textures ready. opts.prio: lower is sooner (a build waiting beats a prefetch);
// opts.page: paint the page-only ones here meanwhile. Resolves to { ready, total, ms }.
export async function prepare(names, { prio = 0, page = true, idleOk = () => true, onProgress = null } = {}) {
  const t0 = now();
  init();
  const want = [...new Set(names)].filter(n => P.has(n) && !P.ready(n) && !leftAlone(n));
  const total = want.length;
  let done = 0;
  const step = () => { done++; onProgress?.(done, total); };
  if (!total) return { ready: 0, total: 0, ms: 0 };
  const H = S.hashP ? await S.hashP : null;
  const lookup = want.filter(n => !S.waiting.has(n));
  // what the cache has goes in as it arrives. A browser that has stored textures before waits for the
  // lookup (it will have most of them); a first visit doesn't: painting starts at once, and anything
  // the cache does turn up just saves that paint.
  const loaded = (H ? loadFromCache(lookup) : Promise.resolve(new Map())).then(hits => {
    for (const [name, bmp] of hits) if (P.adopt(name, bmp)) { S.good.add(name); S.stats.cacheHits++; }
  });
  let warm = false, tw = t0, tp = t0, bumped = false;
  try { warm = !!localStorage.getItem('nmdTexStored'); } catch { warm = false; }
  if (warm) await loaded;
  const tasks = want.map((name, k) => {
    if (S.waiting.has(name)) {   // already on its way (a night prefetch, say): wait for it, then paint here if it couldn't
      if (page === true) promote(name);
      const qd = S.queue.find(j => j.name === name);   // still queued at a background priority: it's wanted now
      if (qd && prio + k * 1e-6 < qd.prio) { qd.prio = prio + k * 1e-6; bumped = true; }
      return S.waiting.get(name).then(async () => { if (!P.ready(name) && page === true && !ALONE.has(name)) await paintHere(name); }).then(step);
    }
    const p = (async () => {
      if (P.ready(name)) return true;
      S.stats.cacheMiss++;
      let r = PAGE_ONLY.has(name) ? 'page' : await paintInWorker(name, prio + k * 1e-6);
      if (r === true) tw = now();
      if (r === 'page' || (r === false && page && !ALONE.has(name))) { r = page === 'idle' ? await paintIdle(name, idleOk) : page ? await paintHere(name) : false; tp = now(); }
      return r === true;
    })().finally(() => S.waiting.delete(name));
    S.waiting.set(name, p);
    return p.then(step);
  });
  if (bumped) pump();
  await Promise.all(tasks);
  await loaded;
  const r = { ready: want.filter(n => P.ready(n)).length, total, ms: Math.round(now() - t0), workersDone: Math.round(Math.max(0, tw - t0)), pageDone: Math.round(Math.max(0, tp - t0)) };
  S.lastPrep = r;
  return r;
}

// Pictures got ready for a day that isn't the one being built (the menu readied day 1, a player joined
// on day 3): let them go, they're only memory. What this day asks for stays.
export function keepOnly(names) {
  const keep = new Set(names);
  P.release(P.adopted().filter(n => !keep.has(n)));
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

let flushWanted = false, flushedOnce = false, lateT = 0;
export function flush() { flushWanted = flushedOnce = true; maybeFlush(); }
export function building(on) {
  S.building = !!on;
  if (!on) maybeFlush();
}
// a texture the page paints once the world is up (a view that asks for it late, or one painted while
// a flush was already under way) is stored by a flush of its own a little later; a build's own paints
// wait for the flush after the build
function lateFlush() {
  if (!flushedOnce || S.building) return;
  clearTimeout(lateT);
  lateT = setTimeout(() => { if (!S.building) flush(); }, 2000);
}
function maybeFlush() {
  if (!flushWanted || S.flushing || S.building) return;
  if (S.queue.length || S.workers.some(W => W.busy)) return;   // painting for a build or a prefetch comes first
  flushWanted = false;
  S.flushing = true;
  runFlush().catch(e => { S.stats.storeErr = e.message; }).finally(() => { S.flushing = false; if (flushWanted) maybeFlush(); });
}
async function runFlush() {
  if (!S.ready) { S.snaps.clear(); return; }
  const H = S.hashP ? await S.hashP : null;
  const cacheOK = !!H && !S.cacheOff;
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
  for (const [name, s] of S.snaps) if (cacheOK && !S.good.has(name) && !items.some(it => it.name === name)) items.push({ name, snap: s });
  S.snaps.clear();
  // In batches, a texture per worker at a time (two workers at most, so the game keeps its cores): the
  // encoding and the write happen in the workers; the page's only part is a snapshot of each of its own
  // paints, taken in an idle slot (or after a tenth of a second at most).
  const want = () => S.building || S.queue.length || S.workers.some(W => W.busy) || !S.ready;   // a build or a prefetch needs the workers
  while (items.length) {
    if (want()) {   // hand back the rest; a later flush picks it up
      for (const r of items) { if (r.W) S.held.set(r.name, r.W.i); else S.snaps.set(r.name, r.snap); }
      flushWanted = true;
      return;
    }
    await new Promise(r => (typeof requestIdleCallback === 'function' ? requestIdleCallback(r, { timeout: 100 }) : setTimeout(r, 20)));
    if (want()) continue;
    const free = S.workers.filter(W => !W.storeCb), jobs = [];
    for (let j = 0; j < items.length && free.length && jobs.length < 2; j++) {
      const it = items[j];
      const W = it.W ? (free.includes(it.W) ? it.W : null) : free[0];
      if (it.W && !S.workers.includes(it.W)) { items.splice(j--, 1); continue; }   // its worker is gone
      if (!W) continue;
      free.splice(free.indexOf(W), 1);
      items.splice(j--, 1);
      jobs.push((async () => {
        let msg, tr = [];
        if (it.snap) {
          let bmp = null;
          try { bmp = await createImageBitmap(it.snap.cv); } catch { /* gone: not cached */ }
          if (!bmp) return;
          msg = { t: 'store', id: 0, names: [it.name], bmps: [bmp], deps: [it.snap.deps] }; tr = [bmp];
        } else msg = { t: 'store', id: 0, names: [it.name] };
        const res = await new Promise(r => { W.storeCb = r; W.w.postMessage(msg, tr); });
        if (res.n) {
          S.good.add(it.name); S.stats.stored += res.n; S.stats.storedKB += Math.round(res.bytes / 1024);
          if (!S.markedStored) { S.markedStored = true; try { localStorage.setItem('nmdTexStored', '1'); } catch { /* fine */ } }
        }
        if (res.err) S.stats.storeErr = res.err;
        if (res.cache?.broken) S.cacheOff = res.cache.lastErr || 'unavailable';
      })());
    }
    await Promise.all(jobs);
    if (S.cacheOff) { flushWanted = false; return; }   // full, or gone: stop writing this session
    if (!jobs.length) await tick();
  }
  if (cacheOK && !S.pruned && S.workers.length) { S.pruned = true; S.workers[0].w.postMessage({ t: 'prune' }); }   // records of textures that no longer exist
}

// for the harness and the tests
// idle: nothing being made ready, and nothing painted this session left to store (if it can be stored)
export function idle() {
  if (idleQ.length) return false;
  const unstored = S.ready && !S.cacheOff && (S.held.size || S.snaps.size);
  return !S.flushing && !flushWanted && !unstored && !S.queue.length && !S.workers.some(W => W.busy) && !S.waiting.size && !S.pageQ.length;
}
export function pagePainted() { return S.pageNames.slice(); }
export function stats() {
  const r = { workers: S.workers.length, failed: S.failed, cache: { broken: !!S.cacheOff, lastErr: S.cacheOff }, pageOnly: PAGE_ONLY.size, lastPrep: S.lastPrep || null, ...S.stats,
    pending: { queue: S.queue.length, busy: S.workers.filter(W => W.busy).length, waiting: S.waiting.size, pageQ: S.pageQ.length, idleQ: idleQ.length, held: S.held.size, snaps: S.snaps.size, flushing: S.flushing, flushWanted } };
  for (const k of ['pageMs', 'workerMs', 'decodeMs']) r[k] = Math.round(r[k]);
  return r;
}
