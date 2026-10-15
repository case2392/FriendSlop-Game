// Dynamite (a stick at a time from the general store's hardware rack: shared/shop.js GEAR) and what it's for:
// rock seamed with metal. Pure: the server (server/room.js) lights, times and sets off each stick and works out
// what a blast does; the pages see the seamed rocks as props (LOOT seamCopper...) and draw the bang.
//
// A seamed rock: { id, x, z, ry, kind ('copper' | 'silver' | 'gold'), type (its prop: LOOT seamCopper...),
// items: [{ type, value }] (the ore that comes out of it) }

import { LOOT } from './loot.js';
import { mulberry32, diggable, buriedSpots } from './dig.js';

export const BLAST = {
  FUSE: 4,          // s from lighting a stick to the bang
  R: 5.5,           // m: whoever's on foot within it is knocked off their feet
  KO_R: 2.6,        // m: and within this, knocked out
  PUSH: 9,          // m/s a loose thing right by it is thrown (less, further out, to nothing at R)
  BREAK_R: 3.2,     // m from a seamed rock's middle (or the boulder's) it's blown apart
  RV_R: 6.5,        // m from the RV's body it's dented, up to RV_HIT% right against it
  RV_HIT: 18,
  ROCKFALL_R: 18,   // m: loose rock up on a rim this close comes down
  CHAIN_R: 2.2,     // m: another stick this close goes off with it
  CHAIN_T: 0.15,    // s after
};

// what's in each kind of rock (a few of a cheap ore, one or two of a dear one), and how likely each is
const KINDS = [
  ['copper', 50, [['copperOre', 3, 4]]],
  ['silver', 33, [['silverOre', 2, 2], ['copperOre', 0, 1]]],
  ['gold', 17, [['goldOre', 1, 2], ['silverOre', 1, 1]]],
];
const TYPE = { copper: 'seamCopper', silver: 'seamSilver', gold: 'seamGold' };

// the day's seamed rocks: 2 + day of them, from their own random stream (generateLeg never calls this, so the
// world is the same with or without them), off the road a way, on open ground clear of everything (the caches
// too: none sits on one), apart from each other, and on ground level enough to bed one in (no more than
// FALL m from high to low round it: steeper, its uphill side would be under ground: seamY)
const FALL = 0.45;
function fall(W, x, z, r) {
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < 8; k++) { const h = W.heightAt(x + r * Math.cos(k * Math.PI / 4), z + r * Math.sin(k * Math.PI / 4)); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  return hi - lo;
}
export function oreRocks(W) {
  const R = mulberry32(((W.seed ?? 0) ^ Math.imul((W.day ?? 1) + 57, 0x51ED270B)) >>> 0);
  const n = 2 + (W.day ?? 1), out = [], caches = buriedSpots(W);
  const dayX = 1 + 0.22 * ((W.day ?? 1) - 1);
  for (let tries = 0; out.length < n && tries < 400; tries++) {
    const z = 80 + R() * (W.LEN - 160), side = R() < 0.5 ? -1 : 1, x = W.roadX(z) + side * (9 + R() * 20);
    if (!diggable(W, x, z, 2.2) || out.some(o => Math.hypot(o.x - x, o.z - z) < 25) || caches.some(c => Math.hypot(c.x - x, c.z - z) < 4) || fall(W, x, z, 1.1) > FALL) continue;
    let pick = R() * 100, ki = 0;
    for (; ki < KINDS.length - 1; ki++) { pick -= KINDS[ki][1]; if (pick < 0) break; }
    const [kind, , holds] = KINDS[ki], items = [];
    for (const [type, lo, hi] of holds) {
      const c = lo + Math.floor(R() * (hi - lo + 1));
      for (let k = 0; k < c; k++) items.push({ type, value: Math.round(LOOT[type].value * dayX * (0.85 + R() * 0.3) / 5) * 5 });
    }
    out.push({ id: out.length, x, z, ry: R() * Math.PI * 2, kind, type: TYPE[kind], items });
  }
  return out;
}

// the height a seamed rock's middle is bedded at: its bottom BED m below the lowest ground under its corners
// and middle (a box turned ry), so it sits in the ground on a slope rather than standing off it on a corner
export const BED = 0.15;
export function seamY(W, o) {
  const [, hx, hy, hz] = LOOT[o.type].shape, c = Math.cos(o.ry), s = Math.sin(o.ry);
  let low = W.heightAt(o.x, o.z);
  for (const [a, b] of [[hx, hz], [hx, -hz], [-hx, hz], [-hx, -hz]]) low = Math.min(low, W.heightAt(o.x + a * c + b * s, o.z - a * s + b * c));
  return low + hy - BED;
}

// how hard a blast at distance d reaches (1 right by it, 0 at r and beyond)
export const falloff = (d, r) => Math.max(0, 1 - d / r);
