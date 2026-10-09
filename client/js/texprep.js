// Getting painted textures ready before the world build asks for them (see docs/DESIGN.md, load time).
//
//   init()                    boot: start the paint workers, hash the paint sources for cache keys
//   prepare(names, opts)      make these textures ready off the main thread: decoded from the
//                             persistent cache (texcache.js) where a good record exists, else painted
//                             by a pool of module workers (paint/worker.js); the results are handed
//                             to paint/core.js (adopt), so canvasFor copies instead of painting.
//                             Resolves when every name is ready or has failed (a failed one is just
//                             painted on the main thread when it's asked for, as before).
//   dayList(biome)            the textures a day in this biome asks for, in build order: what this
//                             browser saw last time (learned) plus the shipped list (texmanifest.js)
//   record(on, biome)         learn the textures a build asks for
//   flush()                   idle time after the world is up: the workers PNG-encode what was painted
//                             this session and write it to the cache, one texture per idle slot
//
// Nothing here is needed for correctness: with no workers, no OffscreenCanvas, no IndexedDB, or any
// error, canvasFor paints on the main thread exactly as it always did.
import * as P from './paint/index.js';
import * as TC from './texcache.js';
import { DAY_TEXTURES } from './texmanifest.js';

const q = (() => { try { return new URLSearchParams(location.search); } catch { return new URLSearchParams(); } })();
const hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
const WANT = q.has('paintWorkers') ? Math.max(0, Math.min(8, +q.get('paintWorkers') | 0)) : Math.max(0, Math.min(4, hc - 1));
const CACHE_ON = q.get('texcache') !== '0';
const now = () => performance.now();
const idleCb = (typeof requestIdleCallback === 'function') ? (f, ms = 2000) => requestIdleCallback(f, { timeout: ms }) : (f) => setTimeout(f, 50);

const S = {
  workers: [], ready: false, failed: '', H: null, hashP: null,
  queue: [],                    // [{ name, prio, seq }] waiting for a worker
  jobs: new Map(),              // name -> { resolve, promise } for queued / in-flight paints
  waiting: new Map(),           // name -> promise of the name being ready (cache or paint)
  held: new Map(),              // name -> { w: worker index, deps } painted by a worker this session, not stored yet
  mainPainted: new Map(),       // name -> deps, painted on the main thread this session
  good: new Set(),              // names whose cache record is known good (decoded or stored this session)
  stats: { cacheHits: 0, cacheMiss: 0, decodeMs: 0, workerPaints: 0, workerMs: 0, mainPaints: 0, mainMs: 0, stored: 0, storedBytes: 0, storeErr: '', fails: 0, adopted: 0 },
  seq: 0, rec: null, flushing: false, flushQ: [],
};
export const texPrep = S;

// main-thread paints and requests (paint/core.js hooks)
P.hooks.painted = (name, p) => { S.mainPainted.set(name, p.deps); S.stats.mainPaints++; S.stats.mainMs += p.ms; };
P.hooks.requested = name => { if (S.rec) S.rec.add(name); };

// ---- the worker pool ----

export function fontList() {
  // the page's own @font-face rules, so a worker paints letters in the same faces
  const out = [];
  try {
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch { continue; }
      for (const r of rules) {
        if (!(r instanceof CSSFontFaceRule)) continue;
        const st = r.style, src = st.getPropertyValue('src'), m = /url\(["']?([^"')]+)["']?\)/.exec(src);
        if (!m) continue;
        out.push({ family: st.getPropertyValue('font-family').replace(/["']/g, '').trim(), url: new URL(m[1], sh.href || location.href).href, weight: st.getPropertyValue('font-weight') || 'normal', style: st.getPropertyValue('font-style') || 'normal', unicodeRange: st.getPropertyValue('unicode-range') || undefined });
      }
    }
  } catch { /* no fonts: letters fall back, and texhash would show it */ }
  return out;
}

let initP = null;
export function init() {
  if (initP) return initP;
  initP = (async () => {
    S.hashP = CACHE_ON ? TC.sourceHashes(P.FAMILIES).then(h => (S.H = h), e => { TC.disable(`hashes: ${e.message}`); return null; }) : Promise.resolve(null);
    if (!CACHE_ON) TC.disable('off (?texcache=0)');
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
          if (m.t === 'ready') { clearTimeout(t); W.alive = !!m.ok; if (!m.ok) S.failed = m.err; res(W.alive); w.onmessage = e => onMessage(W, e.data); }
        };
        w.onerror = e => { clearTimeout(t); S.failed = e.message || 'worker failed to start'; res(false); };
      }));
      w.postMessage({ t: 'init', fonts, hashes: H });
      S.workers.push(W);
    }
    const ok = await Promise.all(starts);
    S.workers = S.workers.filter((W, k) => { if (!ok[k]) { try { W.w.terminate(); } catch {} } return ok[k]; });
    for (const W of S.workers) W.w.onerror = () => workerDied(W);
    S.ready = S.workers.length > 0;
  })().catch(e => { S.failed = e.message; }).finally(() => {
    S.initDone = true;
    if (!S.ready) for (const j of S.queue.splice(0)) settle(j.name, false);
    pump();
  });
  return initP;
}

function workerDied(W) {
  W.alive = false;
  try { W.w.terminate(); } catch {}
  S.workers = S.workers.filter(x => x !== W);
  if (W.busy) { const j = W.busy; W.busy = null; settle(j.name, false); }
  if (W.storeCb) { const cb = W.storeCb; W.storeCb = null; cb({ n: 0, bytes: 0, err: 'worker died' }); }
  for (const [n, h] of S.held) if (h.w === W.i) S.held.delete(n);
  if (!S.workers.length) { S.ready = false; for (const j of S.queue.splice(0)) settle(j.name, false); }
  pump();
}

function onMessage(W, m) {
  if (m.t === 'done' || m.t === 'fail') {
    W.busy = null;
    if (m.t === 'done') {
      for (const f of m.fresh || []) { S.held.set(f.name, { w: W.i, deps: f.deps }); S.stats.workerPaints++; S.stats.workerMs += f.ms; }
      const ok = P.adopt(m.name, m.bmp);
      if (ok) S.stats.adopted++;
      settle(m.name, true);
    } else { S.stats.fails++; settle(m.name, false); }
    pump();
  } else if (m.t === 'stored') {
    const cb = W.storeCb; W.storeCb = null;
    cb?.(m);
  }
}

function settle(name, ok) {
  const j = S.jobs.get(name);
  if (j) { S.jobs.delete(name); j.resolve(ok); }
}

function pump() {
  if (!S.ready) return;
  S.queue.sort((a, b) => a.prio - b.prio || a.seq - b.seq);
  for (const W of S.workers) {
    if (W.busy || W.storeCb || !W.alive) continue;
    let j;
    while ((j = S.queue.shift()) && P.ready(j.name)) settle(j.name, true);   // painted meanwhile (the main thread got there first)
    if (!j) break;
    W.busy = j;
    W.w.postMessage({ t: 'paint', id: j.seq, name: j.name });
  }
  if (!S.queue.length && !S.workers.some(W => W.busy)) maybeFlush();
}

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

// ---- prepare ----

async function decode(rec) {
  const t0 = now();
  try {
    const bmp = await createImageBitmap(rec.blob, { premultiplyAlpha: 'default', colorSpaceConversion: 'none' });
    S.stats.decodeMs += now() - t0;
    return bmp;
  } catch { return null; }
}

// Make these textures ready. opts.prio: lower is sooner (a build waiting beats a prefetch).
// Resolves to { ready, total, ms }.
export async function prepare(names, { prio = 0, onProgress = null } = {}) {
  const t0 = now();
  init();
  const want = [...new Set(names)].filter(n => P.has(n) && !P.ready(n));
  const total = want.length;
  let done = 0;
  const tick = () => { done++; onProgress?.(done, total); };
  if (!total) return { ready: 0, total: 0, ms: 0 };
  // the cache first (one read for all of them), then the workers for the rest
  const H = S.hashP ? await S.hashP : null;
  const fresh = want.filter(n => !S.waiting.has(n));
  let recs = new Map();
  if (H && fresh.length) recs = await TC.getMany(fresh);
  const bad = [];
  const tasks = want.map((name, k) => {
    if (S.waiting.has(name)) return S.waiting.get(name).then(tick);
    const rec = recs.get(name), t = P.meta(name);
    const p = (async () => {
      if (rec && t && rec.w === t.w && rec.h === t.h && rec.key === TC.keyOf(name, rec.deps, H, P.meta)) {
        const bmp = await decode(rec);
        if (bmp && P.adopt(name, bmp)) { S.good.add(name); S.stats.cacheHits++; S.stats.adopted++; return true; }
        if (P.ready(name)) return true;
        bad.push(name);
      } else if (rec) bad.push(name);
      S.stats.cacheMiss++;
      if (P.ready(name)) return true;
      return paintInWorker(name, prio + k * 1e-6);
    })().finally(() => S.waiting.delete(name));
    S.waiting.set(name, p);
    return p.then(tick);
  });
  await Promise.all(tasks);
  if (bad.length) TC.remove(bad);   // stale or unreadable records: gone, they get rewritten after this session
  const ready = want.filter(n => P.ready(n)).length;
  return { ready, total, ms: Math.round(now() - t0) };
}

// ---- which textures a day asks for ----

const LS = 'nmdTexDay:';
export function dayList(biome) {
  let learned = [];
  try { learned = JSON.parse(localStorage.getItem(LS + biome) || '[]'); } catch { learned = []; }
  const ship = DAY_TEXTURES[biome] || [];
  return [...new Set([...ship, ...learned])].filter(n => P.has(n));
}
export function record(on, biome = null) {
  if (on) { S.rec = new Set(); S.recBiome = biome; return; }
  const got = S.rec; S.rec = null;
  if (!got || !S.recBiome) return;
  try {
    const prev = JSON.parse(localStorage.getItem(LS + S.recBiome) || '[]');
    const all = [...new Set([...got, ...prev])].slice(0, 2000);
    localStorage.setItem(LS + S.recBiome, JSON.stringify(all));
  } catch { /* private mode or full: the shipped list still applies */ }
}

// ---- persisting what was painted, in idle time ----

let flushWanted = false;
// Ask for a flush once the pool has nothing to paint; it then runs one texture per idle slot.
export function flush() { flushWanted = true; maybeFlush(); }
function maybeFlush() {
  if (!flushWanted || S.flushing) return;
  if (S.queue.length || S.workers.some(W => W.busy)) return;   // painting for a build or a prefetch comes first
  flushWanted = false;
  S.flushing = true;
  runFlush().finally(() => { S.flushing = false; if (flushWanted) maybeFlush(); });
}
async function runFlush() {
  if (!S.ready) return;
  const H = S.hashP ? await S.hashP : null;
  const cacheOK = !!H && !TC.status().broken;
  // what each worker holds: store it, or let it go
  const byWorker = new Map();
  for (const [name, h] of S.held) {
    if (!byWorker.has(h.w)) byWorker.set(h.w, []);
    byWorker.get(h.w).push(name);
  }
  S.held.clear();
  const items = [];
  for (const [wi, names] of byWorker) {
    const W = S.workers.find(x => x.i === wi);
    if (!W) continue;
    const keep = [], drop = [];
    for (const n of names) (cacheOK && !S.good.has(n) ? keep : drop).push(n);
    if (drop.length) W.w.postMessage({ t: 'drop', names: drop });
    for (const n of keep) items.push({ W, name: n });
  }
  // and what the main thread painted (a worker paints it again, fresh, to store it)
  if (cacheOK) {
    let k = 0;
    for (const n of S.mainPainted.keys()) if (!S.good.has(n) && !items.some(it => it.name === n)) items.push({ W: null, name: n, k: k++ });
  }
  S.mainPainted.clear();
  for (const it of items) {
    if (S.queue.length || S.workers.some(W => W.busy)) {   // a build or prefetch wants the workers: hand back the rest
      for (const rest of items.slice(items.indexOf(it))) { if (rest.W) S.held.set(rest.name, { w: rest.W.i, deps: [] }); else S.mainPainted.set(rest.name, []); }
      flushWanted = true;
      return;
    }
    await new Promise(r => idleCb(r));
    const W = it.W && S.workers.includes(it.W) ? it.W : S.workers[(it.k || 0) % S.workers.length];
    if (!W) return;
    const res = await new Promise(r => { W.storeCb = r; W.w.postMessage({ t: 'store', id: 0, names: [it.name] }); });
    if (res.n) { S.good.add(it.name); S.stats.stored += res.n; S.stats.storedBytes += res.bytes; }
    if (res.err) S.stats.storeErr = res.err;
    pump();
  }
  if (cacheOK && !S.pruned) {
    S.pruned = true;
    const gone = (await TC.names()).filter(n => !P.has(n));
    if (gone.length) await TC.remove(gone);
  }
}

// for the harness and the tests: is everything painted and stored?
export function idle() { return !S.flushing && !flushWanted && !S.queue.length && !S.workers.some(W => W.busy) && !S.waiting.size; }
export function stats() { return { workers: S.workers.length, failed: S.failed, cache: TC.status(), ...S.stats, mainMs: Math.round(S.stats.mainMs), workerMs: Math.round(S.stats.workerMs), decodeMs: Math.round(S.stats.decodeMs) }; }
