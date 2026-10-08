// The road. Every day is a fresh leg generated from (seed, day): the server
// and every client run this same code and get the same world, down to the
// last float — no meshes ever cross the network.
//
//   z < 0            the morning camp (the RV, a campfire, the crew)
//   0 .. LEN         the road: canyon walls, mesas, obstacles, stops with loot
//   LEN .. LEN+TOWN  the town: pawn shop, casino, store, the Repo Man, RV lot

import { mulberry32, fbm, noise2, smoothstep, clamp, lerp } from './rng.js';
import { LOOT, POI_LOOT } from './loot.js';

export const CELL = 2.5;
export const HALF_W = 150;
export const CAMP_LEN = 90;
export const TOWN_LEN = 175;
const GRADE_DEG = 35;

const OBSTACLE_PLAN = [
  ['gate', 'grade'],
  ['mud', 'boulder', 'grade'],
  ['gate', 'mud', 'boulder', 'grade'],
  ['boulder', 'gate', 'mud', 'grade'],
  ['mud', 'gate', 'boulder', 'grade', 'grade'],
];

// One biome per day, all five different, each with its own town style. The trip
// runs like a cross-country drive through WoW Classic zones: green meadows
// (Elwynn), golden farmland (Westfall), a snowy mountain pass (Dun Morogh), red
// canyons (the Badlands), and the desert (Tanaris) where Lost Wages sits.
// Biomes change the terrain's shape, the decor, the towns and the art;
// obstacles and their narrows stay steep everywhere.
export const BIOME_BY_DAY = ['meadow', 'fields', 'snow', 'badlands', 'desert'];
export const BIOMES = {
  meadow: {
    name: 'The Westmeadow Road', town: 'timber',
    wallSoft: 12, wallH: [10, 6], wallDist: [42, 14], bumps: 2.2,
    decor: [['oak', 12], ['bush', 22], ['rock', 12], ['flowers', 22], ['stump', 5], ['fence', 4], ['pine', 5]],   // oaks come in groves of 3-6
    density: 1 / 4.5,
  },
  fields: {
    name: 'Goldenfield Pike', town: 'farm',
    wallSoft: 16, wallH: [7, 5], wallDist: [46, 14], bumps: 1.6,
    decor: [['oak', 10], ['haybale', 14], ['bush', 16], ['rock', 8], ['wheat', 30], ['scarecrow', 3], ['fence', 10], ['flowers', 9]],
    density: 1 / 4.5,
  },
  snow: {
    name: 'Frostpeak Pass', town: 'alpine',
    wallSoft: 7, wallH: [16, 9], wallDist: [38, 14], bumps: 2.4,
    decor: [['pine', 44], ['rock', 22], ['bush', 10], ['stump', 8], ['deadtree', 4], ['fence', 5]],
    density: 1 / 5,
  },
  badlands: {
    name: 'The Redrock Badlands', town: 'frontier',
    wallSoft: 5.5, wallH: [15, 8], wallDist: [36, 16], bumps: 1.7,
    decor: [['cactus', 34], ['deadtree', 10], ['rock', 40], ['bones', 6], ['bush', 10]],
    density: 1 / 7,
  },
  desert: {
    name: 'The Lost Wages Flats', town: 'adobe',
    wallSoft: 10, wallH: [9, 6], wallDist: [44, 14], bumps: 2.6,
    decor: [['cactus', 30], ['palm', 8], ['rock', 26], ['bones', 12], ['bush', 10]],
    density: 1 / 8,
  },
};

const POI_WEIGHTS = [['gas', 3], ['semi', 3], ['yard', 3], ['crash', 2], ['junk', 2], ['dino', 1]];

const BILLBOARDS = [
  ['LOST WAGES', '— 900 MILES —', '#e8473f'],
  ['DESPERATE?', 'EZ LOANS NO QUESTIONS', '#2d7dd2'],
  ['LUCKY SLOP', 'LOOSEST SLOTS IN THE DESERT', '#b8336a'],
  ['GAS $8.99', 'JESUS SAVES · WE DON\'T', '#f4a259'],
  ['SLOPMASTER RVs', 'NO MONEY DOWN!!!', '#3fae52'],
  ['THE REPO MAN', 'KNOWS WHERE YOU PARK', '#333333'],
  ['WORLD\'S LARGEST', 'GARDEN GNOME — EXIT 4', '#9b5de5'],
];

function pickWeighted(rng, table) {
  const total = table.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [k, w] of table) { if ((r -= w) < 0) return k; }
  return table[0][0];
}

export function generateLeg(seed, day) {
  const rng = mulberry32((seed ^ Math.imul(day, 0x9E3779B1)) >>> 0);
  // dressing that came later (groves, rock shapes, town framing, junk fences, cairns) draws from its own
  // stream, so the original layout does not shift
  const rngD = mulberry32((seed ^ Math.imul(day + 17, 0x85EBCA6B)) >>> 0);
  const S = (seed + day * 7919) % 1000003;
  const LEN = 820 + day * 80;
  const biome = BIOME_BY_DAY[Math.min(day, BIOME_BY_DAY.length) - 1];
  const B = BIOMES[biome];
  const Z0 = -CAMP_LEN, Z1 = LEN + TOWN_LEN;
  const TOWN_Z = LEN;

  // ---- the road's line --------------------------------------------------------
  const ax1 = 16 + rng() * 14, l1 = 70 + rng() * 40, p1 = rng() * 6.28;
  const ax2 = 5 + rng() * 6, l2 = 26 + rng() * 14, p2 = rng() * 6.28;
  const taper = z => smoothstep(0, 70, z) * (1 - smoothstep(LEN - 70, LEN, z));
  const roadXraw = z => ax1 * Math.sin(z / l1 + p1) + ax2 * Math.sin(z / l2 + p2);

  // ---- obstacles along the way -------------------------------------------------
  const plan = OBSTACLE_PLAN[Math.min(day, OBSTACLE_PLAN.length) - 1];
  const obstacles = [];
  const span = LEN - 330;
  plan.forEach((type, i) => {
    const z = Math.round(165 + span * (i + 0.5) / plan.length + (rng() - 0.5) * 40);
    obstacles.push({ type, z, id: i });
  });

  // straighten the road through obstacles (and the town gate) so they're fair
  const calm = z => {
    let c = 1;
    for (const o of obstacles) c = Math.min(c, smoothstep(18, 55, Math.abs(z - (o.z + (o.type === 'grade' ? 10 : 0)))));
    return c;
  };
  // integrate a calmed road so it doesn't kink: sample roadX on a 1 m grid
  const nRoad = Z1 - Z0 + 1;
  const RX = new Float64Array(nRoad), RY = new Float64Array(nRoad);
  for (let i = 0; i < nRoad; i++) {
    const z = Z0 + i;
    RX[i] = roadXraw(z) * taper(z);
  }
  // smooth through calm zones: blend toward a moving average
  {
    const tmp = RX.slice();
    for (let i = 0; i < nRoad; i++) {
      const z = Z0 + i;
      const c = calm(z);
      if (c >= 1) continue;
      let s = 0, n = 0;
      for (let k = -45; k <= 45; k++) { const j = clamp(i + k, 0, nRoad - 1); s += tmp[j]; n++; }
      RX[i] = lerp(s / n, tmp[i], c);
    }
  }

  // height profile: gentle hills, then the grades as hard steps
  const tanG = Math.tan(GRADE_DEG * Math.PI / 180);
  for (const o of obstacles) {
    if (o.type !== 'grade') continue;
    o.h = 8.5 + day * 0.9 + rng() * 1.5;
    o.z0 = o.z;
    o.z1 = o.z + o.h / tanG + 0.5;
  }
  {
    let y = 0;
    for (let i = 0; i < nRoad; i++) {
      const z = Z0 + i;
      let slope = 0.045 * fbm(z / 110, 3.3, S + 5, 2) * taper(z) * calm(z);
      // the grade, with a rounded toe and crest so an RV can get over the lip (breakover angle)
      for (const o of obstacles) if (o.type === 'grade' && z >= o.z0 - 4 && z < o.z1 + 6) slope = Math.max(slope, tanG * smoothstep(o.z0 - 4, o.z0 + 2, z) * (1 - smoothstep(o.z1 - 3, o.z1 + 6, z)));
      y += slope;
      RY[i] = y;
    }
  }
  const sampleArr = (A, z) => {
    const f = clamp(z - Z0, 0, nRoad - 1.0001);
    const i = Math.floor(f);
    return A[i] + (A[i + 1] - A[i]) * (f - i);
  };
  const roadX = z => sampleArr(RX, z);
  const roadY = z => sampleArr(RY, z);
  const townY = roadY(TOWN_Z);

  // ---- canyon walls -------------------------------------------------------------
  const narrows = obstacles.filter(o => o.type === 'boulder' || o.type === 'gate');
  const flatZone = z => Math.max(1 - smoothstep(-25, 15, z), smoothstep(LEN - 15, LEN + 25, z));
  const narrowK = z => { let k = 0; for (const o of narrows) k = Math.max(k, 1 - smoothstep(14, 42, Math.abs(z - o.z))); return k; };
  const wallSoft = z => lerp(B.wallSoft, 5.5, narrowK(z));
  function wallDist(side, z) {
    let wd = B.wallDist[0] + B.wallDist[1] * fbm(z / 140, side * 7.7, S + 3, 2);
    for (const o of narrows) wd = lerp(wd, o.type === 'gate' ? 8.6 : 6.2, 1 - smoothstep(14, 42, Math.abs(z - o.z)));
    return lerp(wd, 85, flatZone(z));
  }
  function wallH(side, z) {
    let wh = lerp(B.wallH[0] + B.wallH[1] * fbm(z / 90, side * 3.1 + 40, S + 9, 2), 15 + 6 * fbm(z / 90, side * 3.1 + 40, S + 9, 2), narrowK(z));
    for (const o of narrows) if (o.type === 'gate') wh = lerp(wh, 9.5, 1 - smoothstep(20, 45, Math.abs(z - o.z)));
    return wh;
  }

  // ---- mesas (and their crash sites) --------------------------------------------
  const mesas = [];

  // ---- points of interest ------------------------------------------------------
  const pois = [];
  const nPoi = Math.min(8, 4 + day);
  let guard = 0;
  while (pois.length < nPoi && guard++ < 400) {
    const z = 60 + rng() * (LEN - 110);
    if (obstacles.some(o => Math.abs(z - o.z) < 48)) continue;
    if (pois.some(p => Math.abs(z - p.z) < 55)) continue;
    const type = pickWeighted(rng, POI_WEIGHTS);
    const side = rng() < 0.5 ? -1 : 1;
    const wd = Math.min(wallDist(side > 0 ? 1 : 0, z), 40);
    const off = type === 'crash' ? Math.min(wd - 8, 20 + rng() * 4) : Math.min(wd - 9, 14 + rng() * 6);
    if (off < 11) continue;
    const p = { type, z, side, off, id: pois.length, x: 0 };
    if (type === 'crash') {
      p.mesa = { r: 6.5 + rng() * 1.5, h: 7 + rng() * 3.5 + day * 0.4 };
      mesas.push(p);
    }
    pois.push(p);
  }

  // ---- the height function -------------------------------------------------------
  function H(x, z) {
    const rx = roadX(z), ry = roadY(z);
    const d = x - rx, ad = Math.abs(d);
    const flat = flatZone(z);
    let h = ry;
    // road crown + shallow ditches
    h -= 0.22 * smoothstep(4.6, 6.4, ad) * (1 - smoothstep(8, 12, ad)) * (1 - flat);
    // valley floor bumps
    h += fbm(x / 34, z / 34, S + 11, 3) * B.bumps * smoothstep(7, 22, ad) * (1 - flat);
    // canyon walls
    const side = d >= 0 ? 1 : 0;
    const wd = wallDist(side, z);
    const jag = fbm(x / 9, z / 9, S + 21, 2) * 2.4;
    const t = smoothstep(wd, wd + wallSoft(z), ad + jag);
    h += t * (wallH(side, z) + fbm(x / 22, z / 22, S + 31, 2) * 3.2);
    // beyond the rim: rolling plateau, then the world's edge rises
    h += smoothstep(wd + 8, wd + 60, ad) * 6 * (fbm(x / 60, z / 60, S + 41, 2) + 0.6);
    h += smoothstep(HALF_W - 22, HALF_W - 2, Math.abs(x)) * 30;
    // flat pads under the stops
    for (const p of pois) {
      if (p.type === 'crash') continue;
      const dp = Math.hypot(x - p.x, z - p.z);
      if (dp < 15) h = lerp(h, p.padY, smoothstep(15, 9.5, dp));
    }
    // mesas: a lobed, irregular footprint with steep sides (they paint as cliff), a bench part-way up on
    // one side, and a flat top round the wreck (it sits at base + h)
    for (const p of mesas) {
      const M = p.mesa, mx = p.x, mz = p.z, dx = x - mx, dz = z - mz, d0 = Math.hypot(dx, dz);
      if (d0 > M.r * 1.4 + 6) continue;
      const a = Math.atan2(dz, dx);
      const lobe = 1 + 0.25 * (0.65 * Math.sin(a * M.lobes + M.ph) + 0.35 * Math.sin(a * (M.lobes + 2) + M.ph * 1.7));
      const R = M.r * (d0 < M.r * 0.6 ? 1 : lobe);
      const dm = d0 + noise2(x / 3, z / 3, S + 51) * 0.5;
      const ff = smoothstep(R + 1.5, R, dm);
      const benchSide = smoothstep(0.5, 0.87, Math.cos(a - M.benchA));
      const bR = R + 3 * benchSide, fb = smoothstep(bR + 1.5, bR, dm) * benchSide;
      const top = M.base + M.h + fbm(x / 6, z / 6, S + 61, 2) * 0.35 * smoothstep(M.r * 0.6, M.r, d0);
      if (fb > 0) h = Math.max(h, lerp(h, M.base + M.h * M.benchK, fb));
      if (ff > 0) h = Math.max(h, lerp(h, top, ff));
    }
    return h;
  }
  // POI pads are flattened so buildings sit on the ground; mesa centers need roadX
  for (const p of pois) { p.x = roadX(p.z) + p.side * p.off; p.padY = roadY(p.z) + 0.05; }
  for (const p of mesas) {
    p.mesa.base = roadY(p.z) - 0.2;
    // shape from a hash of the stop's z (no rng: the layout stays put)
    const hz = Math.abs(Math.sin(p.z * 12.9898) * 43758.5453) % 1, hz2 = Math.abs(Math.sin(p.z * 78.233) * 12543.123) % 1;
    p.mesa.lobes = 3 + Math.floor(hz * 3);
    p.mesa.ph = hz2 * 6.283;
    p.mesa.benchA = hz * 6.283;
    p.mesa.benchK = 0.55 + hz2 * 0.15;
  }

  // ---- the heightfield ------------------------------------------------------------
  const X0 = -HALF_W;
  const nx = Math.round((2 * HALF_W) / CELL);
  const nz = Math.ceil((Z1 - Z0) / CELL);
  const heights = new Float32Array((nx + 1) * (nz + 1));
  for (let ix = 0; ix <= nx; ix++) {
    const x = X0 + ix * CELL;
    for (let iz = 0; iz <= nz; iz++) {
      heights[ix * (nz + 1) + iz] = H(x, Z0 + iz * CELL);
    }
  }

  // Height exactly as the physics engine sees it (Rapier splits each cell
  // along the (+x,-z)/(-x,+z) diagonal).
  function heightAt(x, z) {
    const fx = clamp((x - X0) / CELL, 0, nx - 1e-6), fz = clamp((z - Z0) / CELL, 0, nz - 1e-6);
    const ix = Math.floor(fx), iz = Math.floor(fz);
    const u = fx - ix, v = fz - iz;
    const h00 = heights[ix * (nz + 1) + iz], h10 = heights[(ix + 1) * (nz + 1) + iz];
    const h01 = heights[ix * (nz + 1) + iz + 1], h11 = heights[(ix + 1) * (nz + 1) + iz + 1];
    if (u + v <= 1) return h00 + u * (h10 - h00) + v * (h01 - h00);
    return h11 + (1 - u) * (h01 - h11) + (1 - v) * (h10 - h11);
  }

  // ---- static stuff: buildings, posts, gates, signs ---------------------------------
  const statics = [];       // boxes with colliders: {x,y,z,hx,hy,hz,ry,mat,col}
  const cyls = [];          // cylinders with colliders: {x,y,z,r,hh,mat}
  const decor = [];         // visual-only bits the renderer knows how to draw
  const signs = [];         // text panels: {x,y,z,ry,w,h,lines,bg,fg,flat,near}
  const uses = [];          // interactables: {id,kind,x,y,z,r,label,arg}
  const anchors = [];       // winch anchor points: {x,y,z,id}
  const mud = [];
  const gates = [];
  const props = [];
  let propId = 1;

  const buildings = [];      // whole buildings, for the renderer: {id,kind,x,y,z,ry,w,dep,h,door}
  let tagNow = null;        // statics created while this is set belong to a building / stop
  const box = (x, y, z, hx, hy, hz, ry = 0, mat = 'wall', col = null, part = null) => {
    statics.push({ x, y, z, hx, hy, hz, ry, mat, col, part, ...(tagNow || {}) });
  };
  const use = (kind, x, y, z, label, arg = null, r = 0.35) => {
    uses.push({ id: uses.length, kind, x, y, z, r, label, arg });
  };
  // local frame helper: origin (ox, oy, oz), yaw ry (local +z -> (sin ry, cos ry))
  const frame = (ox, oy, oz, ry) => {
    const s = Math.sin(ry), c = Math.cos(ry);
    return (lx, ly, lz) => ({ x: ox + lx * c + lz * s, y: oy + ly, z: oz - lx * s + lz * c });
  };
  const lbox = (F, ry, lx, ly, lz, hx, hy, hz, mat, col, part = null) => {
    const p = F(lx, ly, lz);
    box(p.x, p.y, p.z, hx, hy, hz, ry, mat, col, part);
  };
  // a walk-in building: front wall (local +z) has a door gap. Returns its frame.
  function building(ox, oz, ry, w, dep, h, mat, col, oy = null, kind = 'house') {
    const y0 = oy ?? heightAt(ox, oz);
    const F = frame(ox, y0, oz, ry);
    const t = 0.15, door = 1.6;
    const id = buildings.length;
    buildings.push({ id, kind, x: ox, y: y0, z: oz, ry, w, dep, h, door, style: B.town });
    const prevTag = tagNow;
    tagNow = { bld: id };
    lbox(F, ry, 0, -0.5, 0, w / 2, 0.6, dep / 2, 'floor', null);          // slab
    lbox(F, ry, 0, h / 2, -dep / 2, w / 2, h / 2, t, mat, col);           // back
    lbox(F, ry, -w / 2, h / 2, 0, t, h / 2, dep / 2, mat, col);           // sides
    lbox(F, ry, w / 2, h / 2, 0, t, h / 2, dep / 2, mat, col);
    const segW = (w - door) / 2;
    lbox(F, ry, -(door / 2 + segW / 2), h / 2, dep / 2, segW / 2, h / 2, t, mat, col);
    lbox(F, ry, (door / 2 + segW / 2), h / 2, dep / 2, segW / 2, h / 2, t, mat, col);
    lbox(F, ry, 0, h - 0.4, dep / 2, door / 2, 0.4, t, mat, col);       // over the door
    lbox(F, ry, 0, h + 0.1, 0, w / 2 + 0.3, 0.1, dep / 2 + 0.3, 'roof', null);
    tagNow = prevTag;
    return { F, y0, id };
  }
  const placeLoot = (type, x, y, z, ry = 0, mult = 1) => {
    const L = LOOT[type];
    const dayMult = 1 + 0.22 * (day - 1);
    const value = L.value ? Math.round(L.value * dayMult * mult * (0.85 + rng() * 0.4) / 5) * 5 : 0;
    const half = L.shape[0] === 'box' ? L.shape[2] : L.shape[0] === 'cyl' ? L.shape[1] : L.shape[1];
    props.push({ id: propId++, type, x, y: y + half + 0.06, z, ry, value });
  };

  // ---- obstacles' furniture ------------------------------------------------------
  for (const o of obstacles) {
    const rx = roadX(o.z);
    if (o.type === 'grade') {
      const zt = o.z1 + 9;
      const xt = roadX(zt);
      for (const s of [-1, 1]) {
        const ax = xt + s * 3.4, az = zt, ay = heightAt(ax, az);
        cyls.push({ x: ax, y: ay + 0.7, z: az, r: 0.17, hh: 0.7, mat: 'post' });
        anchors.push({ id: anchors.length, x: ax, y: ay + 1.25, z: az });
      }
      const sx = roadX(o.z - 14) - 5.4, sz = o.z - 14;
      signs.push({ x: sx, y: heightAt(sx, sz) + 2.1, z: sz, ry: 0, w: 3.0, h: 1.4,
        lines: ['ROAD WASHED OUT', 'WINCH IT ↑'], bg: '#f2c14e', fg: '#1d1d1d', post: true });
    } else if (o.type === 'mud') {
      o.z0 = o.z; o.z1 = o.z + 42;
      mud.push({ z0: o.z0, z1: o.z1, hw: 70 });
      const az = o.z1 + 20, ax = roadX(az) + 5.2, ay = heightAt(ax, az);
      cyls.push({ x: ax, y: ay + 1.6, z: az, r: 0.3, hh: 1.6, mat: 'deadtree' });
      anchors.push({ id: anchors.length, x: ax, y: ay + 1.1, z: az });
      const sx = roadX(o.z - 12) + 5.2, sz = o.z - 12;
      signs.push({ x: sx, y: heightAt(sx, sz) + 2.1, z: sz, ry: 0, w: 2.6, h: 1.2,
        lines: ['SOFT SHOULDER', 'AND ROAD', 'AND EVERYTHING'], bg: '#f2c14e', fg: '#1d1d1d', post: true });
    } else if (o.type === 'boulder') {
      const y = roadY(o.z);
      props.push({ id: propId++, type: 'boulder', x: rx + (rng() - 0.5) * 0.8, y: y + LOOT.boulder.shape[2] + 0.05, z: o.z, ry: (rng() - 0.5) * 0.3, value: 0 });
      // a dead tree past the boulder, for winching it out of the way
      const az = o.z + 26, ax = roadX(o.z + 26) + (rng() < 0.5 ? -1 : 1) * 5.0, ay = heightAt(ax, az);
      cyls.push({ x: ax, y: ay + 1.6, z: az, r: 0.3, hh: 1.6, mat: 'deadtree' });
      anchors.push({ id: anchors.length, x: ax, y: ay + 1.1, z: az });
    } else if (o.type === 'gate') {
      const y = roadY(o.z);
      o.code = String(1000 + Math.floor(rng() * 9000));
      o.gate = gates.length;
      gates.push({ id: gates.length, x: rx, y: y + 1.6, z: o.z, hx: 11, hy: 1.6, hz: 0.18, code: o.code });
      const kx = rx - 5.0, kz = o.z - 2.2, ky = heightAt(kx, kz);
      box(kx, ky + 0.6, kz, 0.12, 0.6, 0.12, 0, 'post', null, 'keypad_post');
      use('keypad', kx, ky + 1.3, kz - 0.14, 'Enter gate code', gates.length - 1, 0.32);
      // the code is painted on the rock up top — readable only from up there
      const side = rng() < 0.5 ? -1 : 1;
      // a driver heading +z has +x on the left
      signs.push({ x: rx + 5.4, y: heightAt(rx + 5.4, o.z - 6) + 2.2, z: o.z - 6, ry: 0, w: 3.2, h: 1.4,
        lines: ['RANGER STATION 7', side > 0 ? 'CODE ON THE LEFT RIM' : 'CODE ON THE RIGHT RIM'], bg: '#3a6b35', fg: '#f6efd6', post: true });
      const cz = o.z - 14 - rng() * 10;
      const cx = roadX(cz) + side * (wallDist(side > 0 ? 1 : 0, cz) + 9.5);
      const cy = heightAt(cx, cz);
      o.codeAt = { x: cx, y: cy, z: cz };
      signs.push({ x: cx, y: cy + 0.06, z: cz, ry: side > 0 ? Math.PI / 2 : -Math.PI / 2, w: 3.4, h: 2.0,
        lines: [o.code], bg: 'rgba(0,0,0,0)', fg: biome === 'snow' ? '#9a2a22' : '#ffffff', flat: true, near: 10, painted: true });
    }
  }

  // ---- points of interest: the buildings and the loot ---------------------------------
  for (const p of pois) {
    const px = p.x;
    const ry = p.side > 0 ? -Math.PI / 2 : Math.PI / 2;   // front faces the road
    p.ry = ry;
    tagNow = { poi: p.id, poiType: p.type };
    if (p.type === 'gas') {
      const { F, y0 } = building(px, p.z, ry, 8, 6, 3.2, 'stucco', '#e9d8b4', null, 'gas');
      p.y = y0;
      const pump = F(-1.5, 0.75, 6.2); box(pump.x, pump.y, pump.z, 0.35, 0.75, 0.25, ry, 'pump', '#d64545', 'pump');
      const pump2 = F(1.5, 0.75, 6.2); box(pump2.x, pump2.y, pump2.z, 0.35, 0.75, 0.25, ry, 'pump', '#d64545', 'pump');
      const canopy = F(0, 4.2, 6.2); decor.push({ k: 'canopy', x: canopy.x, y: canopy.y, z: canopy.z, ry });
      const cnt = F(1.8, 0.5, -1.8); box(cnt.x, cnt.y, cnt.z, 1.6, 0.5, 0.5, ry, 'wood', null, 'counter');
      const sg = F(0, 4.2, 3.2); signs.push({ x: sg.x, y: sg.y, z: sg.z, ry, w: 4.2, h: 0.9, lines: ['GAS · FOOD · REGRET'], bg: '#d64545', fg: '#fff' });
      const spots = [[1.6, 1.0, -1.8], [-2.5, 0, -1.6], [-2.6, 0, 1.2], [2.8, 0, 1.4], [-0.6, 0, -2.0], [0.4, 0, 5.0], [-3.2, 0, 4.4]];
      for (let i = 0; i < 5 + Math.floor(rng() * 2); i++) {
        const [lx, ly, lz] = spots[i];
        const type = i === 0 ? 'register' : POI_LOOT.gas[Math.floor(rng() * POI_LOOT.gas.length)];
        const w = F(lx, ly, lz);
        placeLoot(type, w.x, ly > 0 ? y0 + ly : heightAt(w.x, w.z), w.z, ry + rng());
      }
    } else if (p.type === 'semi') {
      const y0 = heightAt(px, p.z); p.y = y0;
      const F = frame(px, y0, p.z, ry + 0.35);
      const r2 = ry + 0.35;
      // trailer: floor, two sides, roof, front; open rear
      p.trailer = { x: px, y: y0, z: p.z, ry: r2 };
      lbox(F, r2, 0, 0.75, 0, 1.3, 0.12, 6, 'metal', '#c9ccd1', 'trailer_floor');
      lbox(F, r2, -1.3, 2.2, 0, 0.06, 1.35, 6, 'metal', '#e9ecef', 'trailer_side');
      lbox(F, r2, 1.3, 2.2, 0, 0.06, 1.35, 6, 'metal', '#e9ecef', 'trailer_side');
      lbox(F, r2, 0, 3.55, 0, 1.36, 0.06, 6, 'metal', '#dfe3e8', 'trailer_roof');
      lbox(F, r2, 0, 2.2, 6, 1.3, 1.35, 0.06, 'metal', '#e9ecef', 'trailer_front');
      lbox(F, r2, 0, 1.6, 7.6, 1.2, 1.6, 1.2, 'metal', '#2f6db5', 'cab');   // the cab, nose in the dirt
      const ramp = F(0, 0.35, -6.9); box(ramp.x, ramp.y, ramp.z, 1.1, 0.06, 1.3, r2, 'wood', null, 'ramp');
      decor.push({ k: 'wheels', x: px, y: y0, z: p.z, ry: r2 });
      for (let i = 0; i < 5; i++) {
        const lz = -4.5 + i * 2.0, w = F((rng() - 0.5) * 1.4, 0.87, lz);
        placeLoot(POI_LOOT.semi[Math.floor(rng() * POI_LOOT.semi.length)], w.x, y0 + 0.87, w.z, r2 + rng());
      }
      for (let i = 0; i < 2; i++) {
        const w = F((rng() - 0.5) * 6, 0, -9 - rng() * 3);
        placeLoot(POI_LOOT.semi[Math.floor(rng() * POI_LOOT.semi.length)], w.x, heightAt(w.x, w.z), w.z, rng() * 6);
      }
    } else if (p.type === 'yard') {
      const y0 = heightAt(px, p.z); p.y = y0;
      const F = frame(px, y0, p.z, ry);
      for (const lx of [-2.2, 2.2]) {
        const t = F(lx, 0.72, 0); box(t.x, t.y, t.z, 1.1, 0.04, 0.55, ry, 'wood', '#b07a45', 'table');
        const l = F(lx, 0.35, 0); box(l.x, l.y, l.z, 0.9, 0.35, 0.05, ry, 'wood', '#8a5a30', 'table_legs');
        for (let i = 0; i < 2; i++) {
          const w = F(lx - 0.5 + i * 1.0, 0, 0);
          placeLoot(POI_LOOT.yard[Math.floor(rng() * POI_LOOT.yard.length)], w.x, y0 + 0.76, w.z, ry + rng() * 0.6);
        }
      }
      for (let i = 0; i < 3; i++) {
        const w = F(-3 + rng() * 6, 0, 1.6 + rng() * 1.5);
        placeLoot(POI_LOOT.yard[Math.floor(rng() * POI_LOOT.yard.length)], w.x, heightAt(w.x, w.z), w.z, rng() * 6);
      }
      const s = F(0, 1.4, 3.6);
      signs.push({ x: s.x, y: s.y, z: s.z, ry, w: 2.2, h: 0.9, lines: ['YARD SALE', 'EVERYTHING MUST GO'], bg: '#ffffff', fg: '#d0342c', post: true });
      decor.push({ k: 'umbrella', x: F(4.5, 0, -1).x, y: y0, z: F(4.5, 0, -1).z, ry });
    } else if (p.type === 'crash') {
      const y0 = p.mesa.base + p.mesa.h; p.y = y0;
      const F = frame(px, y0, p.z, ry + 0.8);
      decor.push({ k: 'plane', x: px, y: y0, z: p.z, ry: ry + 0.8 });
      lbox(F, ry + 0.8, 0, 0.7, 0, 0.7, 0.7, 3.2, 'metal', '#f1f1f1', 'fuselage');
      lbox(F, ry + 0.8, 0, 0.7, 0.4, 4.2, 0.08, 0.8, 'metal', '#d83a3a', 'wing');
      for (let i = 0; i < 3; i++) {
        const w = F(-2 + i * 2, 0, -3.5 - rng());
        placeLoot(POI_LOOT.crash[Math.floor(rng() * POI_LOOT.crash.length)], w.x, heightAt(w.x, w.z), w.z, rng() * 6, 1.15);
      }
    } else if (p.type === 'junk') {
      const y0 = heightAt(px, p.z); p.y = y0;
      const F = frame(px, y0, p.z, ry);
      for (let i = 0; i < 6; i++) {
        const w = F(-3 + rng() * 6, 0, -3 + rng() * 3);
        box(w.x, y0 + 0.4 + rng() * 0.4, w.z, 0.5 + rng() * 0.6, 0.4 + rng() * 0.4, 0.5 + rng() * 0.6, rng() * 3, 'junk', ['#7a6e64', '#8c3b2e', '#4f5d75', '#6b705c'][i % 4], ['crate', 'barrel', 'scrap', 'crate', 'scrap', 'barrel'][i]);
      }
      for (let i = 0; i < 4; i++) {
        const w = F(-3.5 + rng() * 7, 0, 1.0 + rng() * 2.5);
        placeLoot(POI_LOOT.junk[Math.floor(rng() * POI_LOOT.junk.length)], w.x, heightAt(w.x, w.z), w.z, rng() * 6);
      }
      // a tall scrap heap behind the pile (the stop's silhouette from the road), and a fence run at a flank
      lbox(F, ry, 0, 1.6, -5.2, 1.5, 1.6, 1.2, 'junk', '#6b5a4a', 'junk_heap');
      for (let k = 0; k < 1 + (rngD() < 0.5 ? 1 : 0); k++) {
        const sd = k === 0 ? (rngD() < 0.5 ? -1 : 1) : -1, f = F(sd * (4.6 + rngD()), 0, -1.5 + rngD() * 2);
        decor.push({ k: 'fence', x: f.x, y: heightAt(f.x, f.z), z: f.z, s: 1, ry: ry + (rngD() - 0.5) * 0.2, len: 3 + Math.floor(rngD() * 2) });
      }
    } else if (p.type === 'dino') {
      const y0 = heightAt(px, p.z); p.y = y0;
      const F = frame(px, y0, p.z, ry);
      p.dino = { x: px, y: y0, z: p.z, ry };
      lbox(F, ry, 0, 0.55, -1.5, 1.6, 0.55, 3.0, 'dino', '#5aa469', 'dino_body');       // the stone plinth (the renderer sizes it from this)
      lbox(F, ry, 0, 3.0, -1.5, 1.36, 1.2, 2.55, 'dino', '#5aa469', 'dino_torso');      // the pear-shaped body above it
      lbox(F, ry, 0, 3.6, -5.6, 0.5, 0.5, 2.2, 'dino', '#5aa469', 'dino_tail');
      for (const lx of [-1.1, 1.1]) for (const lz of [-3.4, 0.4]) lbox(F, ry, lx, 0.9, lz, 0.4, 0.9, 0.4, 'dino', '#4b8a58', 'dino_leg');
      lbox(F, ry, 0, 5.2, 1.4, 0.45, 1.3, 0.45, 'dino', '#5aa469', 'dino_neck');     // headless neck. the head is loot.
      const h = F(1.5, 0, 3.4);
      placeLoot('dino', h.x, heightAt(h.x, h.z), h.z, ry + 0.4);
      for (let i = 0; i < 2; i++) {
        const w = F(-3 + rng() * 6, 0, 3 + rng() * 2);
        placeLoot(POI_LOOT.dino[1 + Math.floor(rng() * 2)], w.x, heightAt(w.x, w.z), w.z, rng() * 6);
      }
      const s = F(3.6, 1.6, 4.0);
      signs.push({ x: s.x, y: s.y, z: s.z, ry, w: 2.8, h: 1.1, lines: ['DINO WORLD', 'HEAD MISSING — REWARD'], bg: '#5aa469', fg: '#fff', post: true });
    }
  }

  tagNow = null;

  // ---- billboards & landmarks (they're on the map, so you can navigate by them) --------
  const landmarks = [];
  for (let i = 0; i < 3 + Math.floor(day / 2); i++) {
    const z = 40 + rng() * (LEN - 80);
    if (obstacles.some(o => Math.abs(z - o.z) < 25) || pois.some(p => Math.abs(z - p.z) < 25)) continue;
    const side = rng() < 0.5 ? -1 : 1;
    const x = roadX(z) + side * (9.5 + rng() * 3);
    const b = BILLBOARDS[Math.floor(rng() * BILLBOARDS.length)];
    const y = heightAt(x, z);
    signs.push({ x, y: y + 4.2, z, ry: side > 0 ? -0.35 : 0.35, w: 6.4, h: 2.6, lines: [b[0], b[1]], bg: b[2], fg: '#fff', billboard: true });
    landmarks.push({ kind: 'billboard', x, z, label: b[0] });
  }
  {
    const z = 120 + rng() * (LEN - 240), side = rng() < 0.5 ? -1 : 1;
    const x = roadX(z) + side * 12;
    if (!obstacles.some(o => Math.abs(z - o.z) < 30) && !pois.some(p => Math.abs(z - p.z) < 30)) {
      decor.push({ k: 'skull', x, y: heightAt(x, z), z, ry: rng() * 6 });
      landmarks.push({ kind: 'skull', x, z, label: 'cow skull' });
    }
  }

  // ---- biome decor: trees, bushes, rocks, flowers, cacti... ----------------------------
  // Trees and haybales get colliders (an oak WILL stop the RV); cacti are flimsy
  // (people bump them, the RV mows them down); everything else is visual.
  const nDecor = Math.floor(LEN * B.density);
  const decorTotal = B.decor.reduce((a, [, w]) => a + w, 0);
  const pickDecor = () => { let r = rng() * decorTotal; for (const [k, w] of B.decor) if ((r -= w) < 0) return k; return B.decor[0][0]; };
  const decorOk = (x, z, off) => {
    const inCamp = z < 0, inTown = z > LEN - 5;
    if (Math.abs(x) > HALF_W - 25 || off < 8.5) return false;
    if (pois.some(p => Math.hypot(p.x - x, p.z - z) < 14)) return false;
    if (obstacles.some(o => Math.abs(o.z - z) < 22 && off < 16)) return false;
    if ((inCamp || inTown) && (Math.abs(x) < 26 || (inTown && x > 8 && x < 34))) return false;   // keep the camp, street and lots clear
    if (obstacles.some(o => o.codeAt && Math.hypot(o.codeAt.x - x, o.codeAt.z - z) < 3.5)) return false;   // keep the rim code readable
    return true;
  };
  // hero: the big Elwynn oak at a grove's centre (a ~1.5 m bole); other oaks are the nature pass's satellites.
  // The renderer sizes each bole from its collider here (0.97 x r), so these radii are the trees' girth.
  const tree = (k, x, z, s, ry, hero = false) => {
    const y = heightAt(x, z), hh = k === 'palm' ? 2.6 : 1.8;
    const r = k === 'oak' ? (hero ? 0.6 + 0.15 * s : 0.55 * s) : 0.3 * s;
    cyls.push({ x, y: y + hh, z, r, hh, mat: 'tree' });   // bole and root flare
    decor.push({ k, x, y, z, s, ry, ...(hero ? { hero: true } : {}) });
  };
  // Big rocks: the renderer draws the shape world gen picks here (d.variant), so its collider can match.
  // Badlands: a cluster of hoodoos (3.5-5 m) or a stepped ledge stack; desert: a sandstone arch on two
  // feet (along d.ry) or a buried mound; elsewhere a boulder or outcrop. Hoodoos are always solid (they
  // stand 3-5 m whatever s is); other rocks over s 1.2 are fitted to their colliders by the renderer, and
  // the knee-to-waist boulders of the green and snowy days (s 0.9-1.2) get a collider tucked inside them.
  const rockCollide = (d, steep) => {
    const strata = biome === 'badlands', S0 = d.s * (strata ? 1.25 : 1), S = steep ? S0 * 0.75 : S0;
    const green = biome === 'meadow' || biome === 'fields' || biome === 'snow';
    if (d.s <= 1.2 && d.variant !== 'hoodoo') {
      if (green && d.s > 0.9) cyls.push({ x: d.x, y: d.y + S * 0.4, z: d.z, r: S * 0.75, hh: S * 0.4, mat: 'rock' });
      return;
    }
    if (biome === 'badlands' && d.variant === 'hoodoo') {
      const Ht = 4.25 * Math.max(0.7, Math.min(1.2, S / 1.8)), r = Math.max(0.55, Ht * 0.19) * 0.9;
      cyls.push({ x: d.x, y: d.y + Ht / 2 - 0.3, z: d.z, r, hh: Ht / 2, mat: 'rock' });
    } else if (biome === 'desert' && d.variant === 'arch') {
      const span = S * 1.9, r = S * 0.36 * 1.1, c = Math.cos(d.ry), sn = Math.sin(d.ry);
      for (const sd of [-1, 1]) {
        // local +x of the rock's frame (yaw d.ry) in world axes: (cos ry, -sin ry)
        const fx = d.x + c * span * sd, fz = d.z - sn * span * sd;
        cyls.push({ x: fx, y: heightAt(fx, fz) + S * 0.7, z: fz, r, hh: S * 0.9, mat: 'rock' });
      }
      // the span: players walk under it (2.35 m+ clear) but the RV, roof cargo and all, must not drive through
      const under = Math.max(1.7 * S, 2.35 + 0.36 * S) - 0.25 * S, top = Math.max(1.7 * S, 2.35 + 0.36 * S) + 0.35 * S;
      box(d.x, d.y + (under + top) / 2, d.z, 1.5 * S, (top - under) / 2, 0.45 * S, d.ry, 'invisible', null, 'arch_span');
    } else if (green) {
      // low Elwynn/Westfall/Dun Morogh boulders and outcrops, about 0.7 S tall (the renderer follows the top)
      cyls.push({ x: d.x, y: d.y + S * 0.3, z: d.z, r: S * 0.8, hh: S * 0.4, mat: 'rock' });
    } else {
      const tall = biome === 'badlands' ? 0.75 : 0.45;
      cyls.push({ x: d.x, y: d.y + S * tall * 0.8, z: d.z, r: S * (biome === 'desert' ? 0.95 : 0.8), hh: S * tall, mat: 'rock' });
    }
  };
  for (let i = 0; i < nDecor; i++) {
    const z = Z0 + 10 + rng() * (Z1 - Z0 - 20);
    const side = rng() < 0.5 ? -1 : 1;
    const wd = wallDist(side > 0 ? 1 : 0, z);
    const k = pickDecor();
    // trees and rocks also go up on the hills and the rims; small stuff stays on the valley floor
    const tall = k === 'oak' || k === 'pine' || k === 'palm' || k === 'rock' || k === 'deadtree';
    const reach = tall && rng() < 0.45 ? wd + 6 + rng() * 40 : Math.max(1, wd - 10);
    const off = 8.5 + rng() * reach;
    const x = roadX(z) + side * off;
    if (!decorOk(x, z, off)) continue;
    const y = heightAt(x, z);
    const ry = rng() * 6.283;
    const s = 0.75 + rng() * 0.6;
    if (k === 'oak' && (biome === 'meadow' || biome === 'fields')) {
      // Elwynn oaks stand in groves (3-6 within ~12 m); Westfall's in pairs
      // (a crowded spot, within a hero's crown of another oak, gets one plain oak and no grove)
      const crowded = biome === 'meadow' && cyls.some(c => c.mat === 'tree' && Math.hypot(c.x - x, c.z - z) < 5.5);
      if (crowded) {
        if (!decor.some(o => o.hero && Math.hypot(o.x - x, o.z - z) < 5.5) && !cyls.some(c => c.mat === 'tree' && Math.hypot(c.x - x, c.z - z) < 3.2)) tree('oak', x, z, s, ry);
        continue;
      }
      const n = biome === 'meadow' ? 3 + Math.floor(rngD() * 4) : 2;
      tree('oak', x, z, s, ry, biome === 'meadow');
      for (let j = 1; j < n; j++) {
        const a = rngD() * 6.283, dd = 5.5 + rngD() * 6.5;
        const gx = x + Math.cos(a) * dd, gz = z + Math.sin(a) * dd, goff = Math.abs(gx - roadX(gz));
        if (!decorOk(gx, gz, goff)) continue;
        if (cyls.some(c => c.mat === 'tree' && Math.hypot(c.x - gx, c.z - gz) < 3.2)) continue;   // room for the canopies
        if (decor.some(o => o.hero && Math.hypot(o.x - gx, o.z - gz) < 5.5)) continue;          // a hero's crown is ~7 m across
        tree('oak', gx, gz, 0.75 + rngD() * 0.6, rngD() * 6.283);
      }
    } else if (k === 'oak' || k === 'pine' || k === 'palm') {
      tree(k, x, z, s, ry);
    } else if (k === 'cactus') {
      const hh = 0.9 + rng() * 0.9;
      cyls.push({ x, y: y + hh, z, r: biome === 'badlands' ? 0.45 : 0.24, hh, mat: 'cactus' });   // badlands cacti are organ-pipe clumps
      decor.push({ k, x, y, z, h: hh * 2, s, ry });
    } else if (k === 'haybale') {
      cyls.push({ x, y: y + 0.6, z, r: 0.75, hh: 0.6, mat: 'haybale' });
      decor.push({ k, x, y, z, s: 1, ry });
    } else if (k === 'deadtree') {
      cyls.push({ x, y: y + 1.6, z, r: 0.25, hh: 1.6, mat: 'deadtree_decor' });
      decor.push({ k, x, y, z, s, ry });
    } else if (k === 'fence') {
      decor.push({ k, x, y, z, s, ry: Math.atan2(W_roadDx(z), 1) + (rng() - 0.5) * 0.2, len: 4 + Math.floor(rng() * 4) });
    } else if (k === 'rock') {
      const d = { k, x, y, z, s: 0.5 + rng() * 1.4, ry };
      // the renderer's own steepness test: ground under the rock rising more than 0.8 x its size
      const S = d.s * (biome === 'badlands' ? 1.25 : 1), R = S * 1.1;
      let lo = Infinity, hi = -Infinity;
      for (const [dx, dz] of [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R]]) { const h = heightAt(x + dx, z + dz); lo = Math.min(lo, h); hi = Math.max(hi, h); }
      const steep = hi - lo > 0.8 * S;
      if (biome === 'badlands') d.variant = S > 1.3 && !steep && rngD() < 0.35 ? 'hoodoo' : 'ledge';
      else if (biome === 'desert') d.variant = S > 1.2 && !steep && rngD() < 0.3 ? 'arch' : 'mound';
      decor.push(d);
      rockCollide(d, steep);
    } else {
      decor.push({ k, x, y, z, s, ry });
    }
  }
  // the desert road fades into the sand: stone cairns mark its edges every ~25 m, alternating sides
  if (biome === 'desert') {
    let sd = 1;
    for (let z = 12; z < LEN - 12; z += 22 + rngD() * 6) {
      sd = -sd;
      if (pois.some(p => Math.abs(p.z - z) < 16) || obstacles.some(o => Math.abs(o.z - z) < 18)) continue;
      const x = roadX(z) + sd * (6.1 + rngD() * 0.6);
      if (obstacles.some(o => o.codeAt && Math.hypot(o.codeAt.x - x, o.codeAt.z - z) < 3.5)) continue;
      const y = heightAt(x, z);
      cyls.push({ x, y: y + 0.4, z, r: 0.35, hh: 0.4, mat: 'cairn' });   // flimsy: people bump them, the RV knocks through
      decor.push({ k: 'cairn', x, y, z, s: 0.85 + rngD() * 0.3, ry: rngD() * 6.283 });
    }
  }
  function W_roadDx(z) { return roadX(z + 0.5) - roadX(z - 0.5); }

  // ---- the camp -------------------------------------------------------------------
  const camp = {
    rv: { x: 0, z: -42, yaw: 0 },
    fire: { x: -7.5, z: -50 },
    spawns: [],
    exitZ: -6,
  };
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2;
    camp.spawns.push({ x: camp.fire.x + Math.cos(a) * 3.2, z: camp.fire.z + Math.sin(a) * 3.2 });
  }
  decor.push({ k: 'fire', x: camp.fire.x, y: heightAt(camp.fire.x, camp.fire.z), z: camp.fire.z });
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * Math.PI * 2 + 0.4;
    const lx = camp.fire.x + Math.cos(a) * 2.2, lz = camp.fire.z + Math.sin(a) * 2.2;
    // seats lie around the fire (tangent to the ring), each a little askew, not pointing at it like spokes
    const askew = (Math.abs(Math.sin((i + 1) * 91.7 + day * 13.1) * 437.58) % 1 - 0.5) * 0.5;
    box(lx, heightAt(lx, lz) + 0.2, lz, 0.6, 0.2, 0.18, -a + Math.PI / 2 + askew, 'log', '#6b4a2e', 'log_seat');
  }
  signs.push({ x: 7, y: heightAt(7, -8) + 2.3, z: -8, ry: 0, w: 3.6, h: 1.4,
    lines: [`DAY ${day}`, `TOWN ${Math.round(LEN)} m →`], bg: '#2f4858', fg: '#fff', post: true });

  // ---- the town ---------------------------------------------------------------------
  const T = TOWN_Z;
  const town = { z: T, y: townY };
  signs.push({ x: 7.5, y: townY + 3, z: T + 6, ry: 0, w: 4.6, h: 1.8,
    lines: [['PAYDIRT', 'BUSTED FLATS', 'LAST CHANCE', 'SNAKE EYES', 'LOST WAGES'][day - 1], 'POP. 41 · EST. 1971'], bg: '#3a6b35', fg: '#fff', post: true });

  // the back-wall shelves the renderer fills with goods: solid, so nobody walks into the stock
  const shelfCollider = (bid, F, y0) => {
    const b = buildings[bid], ix = b.w / 2 - 0.15, iz = b.dep / 2 - 0.15;
    lbox(F, b.ry, 0, 1.25, -iz + 0.17, ix - 0.4, 1.1, 0.15, 'wood', null, 'shop_shelf');
  };
  // pawn shop (left of the street, door facing the street)
  {
    const { F, y0, id } = building(-17, T + 42, Math.PI / 2, 12, 9, 3.6, 'stucco', '#c97b63', townY, 'pawn');
    const counter = F(0, 0.5, -1.8);
    tagNow = { town: 'pawn' };
    shelfCollider(id, F, y0);
    box(counter.x, y0 + 0.5, counter.z, 3.2, 0.5, 0.55, Math.PI / 2, 'wood', '#7b4b2a', 'counter');
    tagNow = null;
    town.pawn = { x: counter.x, y: y0 + 1.0, z: counter.z, hx: 0.6, hz: 3.2 };   // in world axes
    const bell = F(-2.6, 1.08, -1.6);
    use('pawnBell', bell.x, y0 + 1.08, bell.z, 'Ring to sell what\'s on the counter', null, 0.28);
    const sg = F(0, 4.4, 4.6);
    signs.push({ x: sg.x, y: y0 + 4.4, z: sg.z, ry: Math.PI / 2, w: 5, h: 1.3, lines: ['HONEST ED\'S PAWN', 'WE BUY ANYTHING'], bg: '#f4d35e', fg: '#2b2d42' });
    town.pawnKeeper = F(0, 0, -3.4); town.pawnKeeper.y = y0; town.pawnKeeper.ry = Math.PI / 2;
  }
  // general store
  {
    const { F, y0, id } = building(-17, T + 78, Math.PI / 2, 10, 8, 3.4, 'stucco', '#7fb7be', townY, 'store');
    tagNow = { town: 'store' }; shelfCollider(id, F, y0); tagNow = null;
    const counter = F(0, 0.5, -1.6);
    tagNow = { town: 'store' };
    box(counter.x, y0 + 0.5, counter.z, 2.6, 0.5, 0.5, Math.PI / 2, 'wood', '#a0743c', 'counter');
    tagNow = null;
    const w = F(-1.4, 1.1, -1.5); use('buy', w.x, y0 + 1.1, w.z, 'Walkie-talkie', 'walkie', 0.3);
    const d = F(0.2, 1.1, -1.5); use('buy', d.x, y0 + 1.1, d.z, 'Energy drink', 'drink', 0.3);
    const r = F(1.6, 1.1, -1.5); use('buy', r.x, y0 + 1.1, r.z, 'Bungee cords', 'bungee', 0.3);
    town.store = { walkie: w, drink: d, bungee: r };
    const sg = F(0, 4.2, 4.1);
    signs.push({ x: sg.x, y: y0 + 4.2, z: sg.z, ry: Math.PI / 2, w: 4.4, h: 1.2, lines: ['GENERAL STORE', 'OPEN 24/7 (NOT 7)'], bg: '#ffffff', fg: '#1b4965' });
    town.clerk = F(0, 0, -3.0); town.clerk.y = y0; town.clerk.ry = Math.PI / 2;
  }
  // the casino
  {
    const ry = -Math.PI / 2;
    const { F, y0 } = building(21, T + 58, ry, 22, 18, 5.2, 'casino', '#6a2c70', townY, 'casino');
    tagNow = { town: 'casino' };
    // blackjack table
    const tbl = F(-5, 0.45, -3);
    box(tbl.x, y0 + 0.45, tbl.z, 1.8, 0.45, 1.0, ry, 'felt', '#1f7a4d', 'bj_table');
    const dealer = F(-5, 0, -4.6); dealer.y = y0;
    const hit = F(-7.2, 0.02, 0.6), stand = F(-2.8, 0.02, 0.6);
    town.bj = { table: { ...tbl, y: y0 + 0.92 }, dealer, ry, hit: { x: hit.x, z: hit.z, r: 1.35 }, stand: { x: stand.x, z: stand.z, r: 1.35 } };
    const btn = (lx, label, arg) => { const b = F(lx, 1.0, -2.0); use('bj', b.x, y0 + 1.0, b.z, label, arg, 0.26); };
    btn(-6.6, 'Bet +$100', '+100'); btn(-5.9, 'Bet +$500', '+500'); btn(-5.2, 'ALL IN', 'all'); btn(-4.5, 'Clear bet', 'clear'); btn(-3.5, 'DEAL', 'deal');
    // double-or-nothing machine
    const m = F(5.5, 1.1, -6.5);
    box(m.x, y0 + 1.1, m.z, 1.0, 1.1, 0.6, ry, 'machine', '#d4af37', 'flip_machine');
    town.flip = { x: m.x, y: y0, z: m.z, ry };
    const fb = (lx, label, arg) => { const b = F(lx, 1.15, -5.8); use('flip', b.x, y0 + 1.15, b.z, label, arg, 0.24); };
    fb(4.9, 'Stake +$100', '+100'); fb(5.5, 'Stake +$500', '+500'); fb(6.1, 'ALL IN', 'all');
    const lever = F(6.9, 1.4, -6.3); use('flip', lever.x, y0 + 1.4, lever.z, 'PULL — double or nothing', 'pull', 0.3);
    // decor slot banks
    for (let i = 0; i < 5; i++) {
      const s = F(-9 + i * 1.3, 1.0, -8.3);
      box(s.x, y0 + 1.0, s.z, 0.45, 1.0, 0.4, ry, 'machine', ['#e63946', '#f1c40f', '#2a9d8f', '#e76f51', '#8338ec'][i], 'slot_bank');
    }
    tagNow = null;
    const sg = F(0, 6.4, 9.2);
    signs.push({ x: sg.x, y: y0 + 6.4, z: sg.z, ry, w: 9, h: 2.4, lines: ['LUCKY SLOP', 'CASINO · NO CLOCKS'], bg: '#ff2e88', fg: '#fff9c4', neon: true });
    town.casino = { x: 21, z: T + 58, y: y0 };
  }
  // the Repo Man's tow truck parks out front
  town.repo = { x: 7.5, z: T + 24, y: townY, ry: Math.PI };
  use('pay', 7.5 - 2.4, townY + 1.2, T + 24.6, 'Pay the Repo Man', null, 0.6);
  // RV lot + campfire
  town.lot = { x: 0, z: T + 138, yaw: 0 };
  town.fire = { x: -9, z: T + 150 };
  decor.push({ k: 'fire', x: town.fire.x, y: townY, z: town.fire.z });
  for (let i = 0; i < 3; i++) {
    const x = 14 + i * 0.3, z = T + 125 + i * 14;
    box(x, townY + 1.5, z, 1.25, 1.5, 4, 0.05 * i, 'rvjunk', ['#e0d6c8', '#cbd5c0', '#d8c3a5'][i], 'parked_rv');
  }
  for (let i = 0; i < 6; i++) decor.push({ k: 'lamp', x: (i % 2 ? 6 : -6), y: townY, z: T + 15 + i * 22 });

  // ---- town dressing: framing trees, street fences, yard props (the town renderer draws each yard box) ----
  const townKinds = ['pawn', 'store', 'casino'];
  const lots = buildings.filter(b => townKinds.includes(b.kind));
  const treeKind = { timber: 'oak', farm: 'oak', alpine: 'pine', frontier: 'deadtree', adobe: 'palm' }[B.town];
  const clearOfTown = (x, z, r) => !lots.some(b => Math.hypot(b.x - x, b.z - z) < Math.hypot(b.w, b.dep) / 2 + r)
    && !cyls.some(c => Math.hypot(c.x - x, c.z - z) < 3.2) && !statics.some(st => st.mat !== 'invisible' && Math.hypot(st.x - x, st.z - z) < Math.max(st.hx, st.hz) + r);
  const townTree = (x, z) => {
    if (!clearOfTown(x, z, 2.5) || decor.some(o => o.hero && Math.hypot(o.x - x, o.z - z) < 5.5)) return;
    const s = 1.0 + rngD() * 0.3, ry = rngD() * 6.283;
    if (treeKind === 'deadtree') {
      const y = heightAt(x, z);
      cyls.push({ x, y: y + 1.6, z, r: 0.25, hh: 1.6, mat: 'deadtree_decor' });
      decor.push({ k: 'deadtree', x, y, z, s, ry });
    } else tree(treeKind, x, z, s, ry);
  };
  // a grove behind each building (away from the street), 4-6 trees
  for (const b of lots) {
    const sn = Math.sin(b.ry), cs = Math.cos(b.ry);
    const back = b.dep / 2 + 9 + rngD() * 4;
    const gx = b.x - sn * back, gz = b.z - cs * back;
    const n = 4 + Math.floor(rngD() * 3);
    for (let k = 0; k < n; k++) { const a = rngD() * 6.283, d = k === 0 ? 0 : 3.5 + rngD() * 5; townTree(gx + Math.cos(a) * d, gz + Math.sin(a) * d); }
  }
  // trees flanking the town sign, clear of the road and the Repo Man
  for (const [x, z] of [[13.5, T + 2], [-10.5, T + 5], [16, T + 10]]) townTree(x + (rngD() - 0.5), z + (rngD() - 0.5));
  // rail fences along both sides of the main street, between the buildings (visual only)
  const fenceRun = (x, z0, z1) => {
    for (let z = z0; z < z1 - 3; ) {
      const n = Math.min(7, Math.max(2, Math.round((z1 - z) / 1.9) + 1)), L = (n - 1) * 1.9, zc = z + L / 2;
      decor.push({ k: 'fence', x: x + (rngD() - 0.5) * 0.3, y: heightAt(x, zc), z: zc, s: 1, ry: (rngD() - 0.5) * 0.06, len: n });
      z += L + 2.4;   // a gap between runs
    }
  };
  fenceRun(-10, T + 14, T + 34); fenceRun(-10, T + 50, T + 71); fenceRun(-10, T + 86, T + 105);
  fenceRun(9.5, T + 30, T + 44); fenceRun(9.5, T + 72, T + 100);
  // yard props in front of each building, beside the door path (the renderer draws them at exactly these boxes)
  const YARD = {
    timber: [['yard_well', 0.8, 0.5, 0.8], ['yard_barrels', 0.6, 0.5, 0.6]],
    farm: [['yard_trough', 1.0, 0.3, 0.35], ['yard_cart', 1.3, 0.6, 0.75]],
    alpine: [['yard_brazier', 0.35, 0.6, 0.35], ['yard_brazier', 0.35, 0.6, 0.35]],
    frontier: [['yard_hitch', 1.2, 0.5, 0.06], ['yard_barrels', 0.6, 0.5, 0.6]],
    adobe: [['yard_pots', 0.6, 0.35, 0.6], ['yard_barrels', 0.6, 0.5, 0.6]],
  }[B.town];
  for (const b of lots) {
    const F = frame(b.x, b.y, b.z, b.ry);
    tagNow = { town: b.kind };
    if (B.town === 'alpine') {
      // braziers flank the door
      for (const sd of [-1, 1]) lbox(F, b.ry, sd * 1.8, 0.6, b.dep / 2 + 2.5, 0.35, 0.6, 0.35, 'yard', null, 'yard_brazier');
      lbox(F, b.ry, b.w / 2 - 1.2, 0.5, b.dep / 2 + 3.0, 0.6, 0.5, 0.6, 'yard', null, 'yard_barrels');
    } else {
      const [A, Bp] = YARD;
      const item = b.kind === 'store' ? Bp : A;
      lbox(F, b.ry, -(b.w / 2 - 1.6), item[2], b.dep / 2 + 3.2, item[1], item[2], item[3], 'yard', null, item[0]);
      lbox(F, b.ry, b.w / 2 - 1.2, 0.5, b.dep / 2 + 3.0, 0.6, 0.5, 0.6, 'yard', null, 'yard_barrels');
    }
    if (B.town === 'frontier' && b.kind === 'casino') lbox(F, b.ry, -(b.w / 2 + 2.2), 2.5, b.dep / 2 - 1.5, 1.2, 2.5, 1.2, 'yard', null, 'yard_tower');   // a lookout tower beside the casino
    tagNow = null;
  }
  // the casino's empty front-right quarter gets a bar along the side wall (long axis along the wall)
  {
    const c = lots.find(b => b.kind === 'casino');
    if (c) { const F = frame(c.x, c.y, c.z, c.ry); tagNow = { town: 'casino' }; lbox(F, c.ry + Math.PI / 2, 9.6, 0.55, 2.5, 2.5, 0.55, 0.35, 'wood', null, 'casino_bar'); tagNow = null; }
  }

  // world edges
  const zMid = (Z0 + Z1) / 2, zHalf = (Z1 - Z0) / 2;
  box(-HALF_W + 1, 80, zMid, 1, 120, zHalf, 0, 'invisible');
  box(HALF_W - 1, 80, zMid, 1, 120, zHalf, 0, 'invisible');
  box(0, 80, Z0 + 1, HALF_W, 120, 1, 0, 'invisible');
  box(0, 80, Z1 - 1, HALF_W, 120, 1, 0, 'invisible');

  return {
    seed, day, LEN, Z0, Z1, X0, nx, nz, cell: CELL, heights,
    roadX, roadY, heightAt, townY,
    obstacles, pois, mesas, statics, cyls, decor, signs, uses, anchors, mud, gates, props,
    landmarks, camp, town, buildings, biome, biomeName: B.name, quota: null,
  };
}

// Is a world point inside a mud patch?
export function inMud(W, x, z) {
  for (const m of W.mud) {
    if (z >= m.z0 && z <= m.z1 && Math.abs(x - W.roadX(z)) < m.hw) return true;
  }
  return false;
}
