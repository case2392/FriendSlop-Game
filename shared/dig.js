// Buried metal: the day's caches under the ground, found with a metal detector and dug up with a shovel (both
// from the general store: shared/shop.js). Worked out from the generated world alone, from their own random
// stream: generateLeg never calls this, so the world is the same world with or without them. The server digs
// them (server/room.js onDig), every page works out the same list for its detector (client/js/main.js).
//
// A cache: { id, x, z, deep (down a side road: richer), kind, items: [{ type, value }] }

import { LOOT } from './loot.js';
import { clearAt } from './finds.js';
import { nearTrack } from './tracks.js';

export const DIG = {
  R: 1.2,          // m from a hole (or a cache) a stroke must land to dig it
  STROKES: 6,      // strokes of the shovel to the bottom of a hole (LMB held: one each CD)
  REACH: 3,        // m from your feet a stroke lands at most
  RANGE: 9,        // m the detector first hears one
  CD: 0.45,        // s between strokes
  DEPTH: 0.75,     // m deep a hole is at the bottom (the page draws it going down a stroke at a time)
  PULL_T: 2.4,     // s of one pair of hands holding E to pull a cache's chest up out of its hole
  PULL_HANDS: 3,   // hands that share the pulling
  PULL_TAP: 0.06,  // of the pull, each press of E (mashing it is a little quicker than holding it)
  PULL_R: 2.4,     // m from the hole the pullers stand at most
  BARE: 30,        // holes in bare ground the server keeps track of a day (the oldest go)
};
// a hole's state on the wire ([id, x, z, n, st, pileX, pileZ]): st DUG (going down), CHEST (a cache's chest at
// the bottom), PULLED (the chest out on the lip), EMPTY (bare ground at the bottom: nothing)
export const HOLE = { DUG: 0, CHEST: 1, PULLED: 2, EMPTY: 3 };

// what's down there, by weight, and what each holds (a few of a cheap thing, one of a dear one)
const KINDS = [
  ['scrap', 34, [['scrap', 2, 3]]],
  ['copper', 24, [['copper', 1, 2], ['scrap', 0, 1]]],
  ['silver', 15, [['silver', 1, 2], ['scrap', 0, 1]]],
  ['coins', 11, [['coins', 1, 1]]],
  ['gold', 8, [['gold', 1, 1], ['silver', 0, 1]]],
  ['lockbox', 8, [['lockbox', 1, 1]]],
];
// down a side road the cheap ones are rarer (a cache there is worth about half as much again as one by the road)
const DEEP_W = { scrap: 0.25, copper: 0.5, silver: 1.3, coins: 1.5, gold: 2.2, lockbox: 2.2 };

export function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// not on the road, nor in its mud, nor under anything, on ground gentle enough to dig (r: how much clear room)
export function diggable(W, x, z, r = 1.2) {
  if (Math.abs(x) > 105 || z < 40 || z > W.LEN - 40) return false;
  if (Math.abs(x - W.roadX(z)) < 6) return false;
  for (const m of W.mud || []) if (z > m.z0 - 2 && z < m.z1 + 2 && Math.abs(x - W.roadX(z)) < m.hw + 2) return false;
  for (const T of W.tracks || []) if (nearTrack(T, x, z).d < T.hw + 1.5) return false;
  const y = W.heightAt(x, z);
  for (const [dx, dz] of [[0.8, 0], [-0.8, 0], [0, 0.8], [0, -0.8]]) if (Math.abs(W.heightAt(x + dx, z + dz) - y) > 0.4) return false;
  return clearAt(W, x, y, z, r);
}

// the day's caches: 6 + day of them. About half by the stops (where people dropped things; a stop down a side
// road three times as likely, and its caches richer), the rest out along the canyon floor
export function buriedSpots(W) {
  const R = mulberry32(((W.seed ?? 0) ^ Math.imul((W.day ?? 1) + 91, 0x2545F491)) >>> 0);
  const n = 6 + (W.day ?? 1), out = [];
  const apart = (x, z) => out.every(c => Math.hypot(c.x - x, c.z - z) > 9);
  const stops = (W.pois || []).filter(p => p.type !== 'crash'), stopW = stops.reduce((a, p) => a + (p.deep ? 3 : 1), 0);
  for (let tries = 0; out.length < n && tries < 400; tries++) {
    let x, z, deep = false;
    const r = R();
    if (r < 0.5 && stops.length) {
      let pick = R() * stopW, p = stops[0];
      for (const q of stops) { pick -= q.deep ? 3 : 1; if (pick < 0) { p = q; break; } }
      const a = R() * Math.PI * 2, d = (p.deep ? 9 : 7) + R() * 14;
      x = p.x + Math.cos(a) * d; z = p.z + Math.sin(a) * d; deep = !!p.deep;
    } else {
      z = 60 + R() * (W.LEN - 120);
      const side = R() < 0.5 ? -1 : 1;
      x = W.roadX(z) + side * (8 + R() * 22);
    }
    if (!diggable(W, x, z) || !apart(x, z)) continue;
    // what's in it (day's prices, as the loot's: 22% a day)
    const w = KINDS.map(([k, wt]) => wt * (deep ? DEEP_W[k] : 1)), tot = w.reduce((a, b) => a + b, 0);
    let pick = R() * tot, ki = 0;
    for (; ki < KINDS.length - 1; ki++) { pick -= w[ki]; if (pick < 0) break; }
    const [kind, , holds] = KINDS[ki], items = [];
    for (const [type, lo, hi] of holds) {
      const c = lo + Math.floor(R() * (hi - lo + 1));
      for (let k = 0; k < c; k++) items.push({ type, value: Math.round(LOOT[type].value * (1 + 0.22 * ((W.day ?? 1) - 1)) * (0.85 + R() * 0.3) / 5) * 5 });
    }
    out.push({ id: out.length, x, z, deep, kind, items });
  }
  return out;
}

// the nearest cache not dug yet to (x, z) -> { c, d } (c null if none)
export function nearestCache(list, x, z, dug) {
  let c = null, d = Infinity;
  for (const q of list) {
    if (dug?.has?.(q.id) || (Array.isArray(dug) && dug.includes(q.id))) continue;
    const e = Math.hypot(q.x - x, q.z - z);
    if (e < d) { d = e; c = q; }
  }
  return { c, d };
}
