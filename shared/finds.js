// Where the day's Road Card tins lie (shared/cards.js has what's in them). The server puts them out each
// morning (server/sim.js opts.finds); the pages keep grass off the lookout spot (terrain3d.js). Worked out
// from the generated world alone, with no random draws: generateLeg never calls this and nothing in it
// moves, so a fixed-seed world is the same world with or without its tins.
//
//   LOOKOUT  every day, the climber's reward: on top of the day's first crash butte; else up on the rim
//            past the gate code's painted slab; else off the road past the grade's winch posts
//   DEN      days 2-5: beside the stash of the day's first ringtail den that isn't the Hoard (theirs, till
//            somebody picks it up)
//   GOLD     day 5: beside the Hoard's pile (three cards, one of them a kit card)
//
// A spot: { kind, type ('tin' | 'goldtin'), x, y (the tin's bottom), z, ry, den (a den's id, or null) }

import { LOOT } from './loot.js';

const CLEAR = 0.6;          // m between a tin and anything solid or any loot
const ROAD = 4;             // m at least from the road's middle (the grade's fallback aside)
const TIN_HALF = 0.045;     // the tin's half height (shared/loot.js)

const halfOf = type => { const s = LOOT[type]?.shape; return !s ? 0.3 : s[0] === 'box' ? Math.max(s[1], s[3]) : s[0] === 'cyl' ? s[2] : s[1]; };
// the top of a convex rock (world.js hulls: points about its foot)
const hullTop = h => { let y = -1e9; for (let i = 1; i < h.pts.length; i += 3) y = Math.max(y, h.pts[i]); return h.y + y; };

// nothing solid or loose within CLEAR of a tin at (x, y, z): a box, a post or a trunk standing at that
// height, a rock rising above it, a thing lying there
export function clearAt(W, x, y, z, clear = CLEAR) {
  for (const s of W.statics) {
    if (s.mat === 'invisible' || s.y + s.hy < y - 0.3 || s.y - s.hy > y + 1.5) continue;
    const c = Math.cos(s.ry || 0), sn = Math.sin(s.ry || 0), dx = x - s.x, dz = z - s.z;
    const lx = dx * c - dz * sn, lz = dx * sn + dz * c;
    if (Math.hypot(Math.max(0, Math.abs(lx) - s.hx), Math.max(0, Math.abs(lz) - s.hz)) < clear) return false;
  }
  for (const c of W.cyls) {
    if (c.y + c.hh < y - 0.3 || c.y - c.hh > y + 1.5) continue;
    if (Math.hypot(x - c.x, z - c.z) < c.r + clear) return false;
  }
  // (a rock whose top is under the tin is what it stands on: a butte's own body)
  for (const h of W.hulls || []) if (hullTop(h) > y + 0.05 && Math.hypot(x - h.x, z - h.z) < h.r + clear) return false;
  for (const p of W.props) if (Math.abs(p.y - y) < 1.5 && Math.hypot(x - p.x, z - p.z) < halfOf(p.type) + clear) return false;
  return true;
}

// flat enough for a tin to sit on (no more than 0.25 m of rise over a metre round it)
function flat(W, x, z, y, top) {
  for (const [dx, dz] of [[0.5, 0], [-0.5, 0], [0, 0.5], [0, -0.5]]) {
    const h = top ? W.topAt(x + dx, z + dz) : W.heightAt(x + dx, z + dz);
    if (Math.abs(h - y) > 0.125) return false;
  }
  return true;
}

// on the day's first crash butte: a ring of candidates round the wreck, the inner ones first
function onButte(W) {
  const p = W.pois.filter(q => q.type === 'crash' && q.mesa).sort((a, b) => a.z - b.z)[0];
  if (!p) return null;
  const M = p.mesa, top = M.base + M.h;
  for (const r of [3, 4, 2.2, 5, 6]) for (let k = 0; k < 12; k++) {
    const a = k / 12 * Math.PI * 2 + r, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
    const t = M.topAt(x, z);
    if (t == null || Math.abs(t - top) > 0.05 || !flat(W, x, z, t, true)) continue;
    if (Math.abs(x - W.roadX(z)) < ROAD || !clearAt(W, x, t, z)) continue;
    return { x, y: t, z, ry: a };
  }
  return null;
}
// up past the gate code's slab, away from the road
function byCode(W) {
  const o = W.obstacles.find(q => q.codeAt);
  if (!o) return null;
  const c = o.codeAt, side = Math.sign(c.x - W.roadX(c.z)) || 1;
  for (const d of [2.4, 3, 3.6, 2]) for (const dz of [0, 1, -1, 2, -2]) {
    const x = c.x + side * d, z = c.z + dz, y = W.heightAt(x, z);
    if (Math.abs(x - W.roadX(z)) < ROAD || !flat(W, x, z, y, false) || !clearAt(W, x, y, z)) continue;
    return { x, y, z, ry: side > 0 ? Math.PI / 2 : -Math.PI / 2 };
  }
  return null;
}
// off the road past the grade's posts (they stand 12 m past its top, 3.4 m either side)
function pastGrade(W) {
  const o = W.obstacles.find(q => q.type === 'grade');
  if (!o) return null;
  for (const dz of [9, 7, 11, 5]) for (const side of [1, -1]) for (const off of [5.5, 6.5, 4.5]) {
    const z = o.z1 + dz, x = W.roadX(z) + side * off, y = W.heightAt(x, z);
    if (!clearAt(W, x, y, z)) continue;
    return { x, y, z, ry: 0 };
  }
  return null;
}
// beside one of a den's stash (its facing: ry, toward the stop): to one side of it, then the other
function besideStash(W, den, item) {
  const it = W.props.find(p => p.id === item);
  if (!it) return null;
  const sx = Math.cos(den.ry), sz = -Math.sin(den.ry), fx = Math.sin(den.ry), fz = Math.cos(den.ry);
  for (const d of [0.9, 1.2, 0.7, 1.5]) for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [1, 1], [-1, 1]]) {
    const x = it.x + (sx * a + fx * b) * d, z = it.z + (sz * a + fz * b) * d, y = W.heightAt(x, z);
    if (Math.abs(x - W.roadX(z)) < ROAD || !flat(W, x, z, y, false)) continue;
    if (!clearAt(W, x, y, z, 0.5)) continue;
    return { x, y, z, ry: den.ry };
  }
  return null;
}

export function findSpots(W) {
  const out = [];
  const look = onButte(W) || byCode(W) || pastGrade(W);
  if (look) out.push({ kind: 'lookout', type: 'tin', ...look, den: null });
  if (W.day >= 2) {
    const den = (W.dens || []).find(d => !d.hoard && d.stash?.length);
    const s = den && besideStash(W, den, den.stash[0]);
    if (s) out.push({ kind: 'den', type: 'tin', ...s, den: den.id });
  }
  if (W.day >= 5) {
    const h = (W.dens || []).find(d => d.hoard && d.stash?.length);
    const s = h && besideStash(W, h, h.stash[h.stash.length - 1]);
    if (s) out.push({ kind: 'gold', type: 'goldtin', ...s, den: h.id });
  }
  return out;
}
export const TIN_Y = TIN_HALF;
