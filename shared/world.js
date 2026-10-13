// The road. Every day is a fresh leg generated from (seed, day): the server
// and every client run this same code and get the same world, down to the
// last float — no meshes ever cross the network.
//
//   z < 0            the morning camp (the RV, a campfire, the crew)
//   0 .. LEN         the road: canyon walls, mesas, obstacles, stops with loot
//   LEN .. LEN+TOWN  the town: pawn shop, casino, store, the Repo Man, RV lot

import { mulberry32, fbm, noise2, smoothstep, clamp, lerp } from './rng.js';
import { LOOT, POI_LOOT } from './loot.js';
import { butteParts, butteMains, polyExit, sdPoly, partHull } from './butte.js';
import { PLAN as MOB_PLAN } from './mobs.js';

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
    // an open erg, not a canyon (erg: dunes on the floor, broad dune banks for walls, bigger dunes beyond;
    // sheer sandstone only where an obstacle's narrows pinch the valley)
    name: 'The Lost Wages Flats', town: 'adobe', erg: true,
    wallSoft: 38, wallH: [10, 4], wallDist: [60, 14], bumps: 0.7,
    decor: [['cactus', 30], ['palm', 8], ['rock', 26], ['bones', 12], ['bush', 10]],
    density: 1 / 8,
  },
};

const TALUS_P = 1.8;   // how concave a crash butte's talus apron is (its height falls as (1 - e / reach)^P)

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

// opts.mobs === false: the same world without its wildlife (dens, beds and what they add: test/mobs.mjs
// checks nothing else moves)
export function generateLeg(seed, day, opts = {}) {
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
    for (const o of narrows) wd = lerp(wd, o.type === 'gate' ? 8.6 : 7.0, 1 - smoothstep(14, 42, Math.abs(z - o.z)));
    return lerp(wd, 85, flatZone(z));
  }
  // Tanaris's dunes (B.erg): transverse dunes across the wind, each with a long gentle windward back and a
  // short lee face near sand's angle of repose (~30 degrees, so they paint as sand, not rock), crest and
  // trough rounded over a few metres (the 2.5 m grid draws a sharp crest as a row of teeth), crest lines
  // that wander and break up into separate dunes
  const WIND = 0.62, cwd = Math.cos(WIND), swd = Math.sin(WIND);
  function dune(x, z, lam, amp, k) {
    const u = (x * swd + z * cwd) / lam + 0.35 * fbm(x / (lam * 3), z / (lam * 3), S + k, 2);
    const p = u - Math.floor(u), C = 0.72;
    const prof = p < C ? smoothstep(0, C, p) : 1 - smoothstep(C, 1, p);
    const along = (x * cwd - z * swd) / (lam * 1.6);
    return amp * prof * (0.5 + 0.5 * smoothstep(-0.4, 0.4, noise2(along, Math.floor(u) * 1.93, S + k + 1)));
  }
  // the road, the narrows and the camp and town pads stay clear; small dunes on the floor fade up the
  // banks, where the big ones (draa) take over
  function ergDunes(x, z, ad, wd) {
    const open = (1 - narrowK(z)) * smoothstep(11, 26, ad);
    if (open <= 0) return 0;
    const bank = smoothstep(wd + 12, wd + 48, ad);   // the big dunes start past the bank's brow, not on its face
    return open * (dune(x, z, 44, 2.8, 81) * (1 - 0.6 * bank) + dune(x, z, 96, 7, 91) * bank);
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

  // ---- the height function (bare: without the crash buttes' talus aprons) ------------
  function H(x, z, bare = false) {
    const rx = roadX(z), ry = roadY(z);
    const d = x - rx, ad = Math.abs(d);
    const flat = flatZone(z);
    let h = ry;
    // road crown + shallow ditches
    h -= 0.22 * smoothstep(4.6, 6.4, ad) * (1 - smoothstep(8, 12, ad)) * (1 - flat);
    // valley floor bumps
    h += fbm(x / 34, z / 34, S + 11, 3) * B.bumps * smoothstep(7, 22, ad) * (1 - flat);
    // canyon walls (Tanaris: dune banks)
    const side = d >= 0 ? 1 : 0;
    const wd = wallDist(side, z);
    if (B.erg) h += ergDunes(x, z, ad, wd) * (1 - flat);
    const jag = fbm(x / 9, z / 9, S + 21, 2) * (B.erg ? 0.8 : 2.4);   // (a dune bank's foot is smooth, a cliff's is broken)
    // the face, then a rounded shoulder easing over the lip (a crease sharper than the 2.5 m grid would
    // show as a sawtooth of triangle teeth along the rim)
    const ws = wallSoft(z), q = ad + jag;
    const t = 0.85 * smoothstep(wd, wd + 0.85 * ws, q) + 0.15 * smoothstep(wd + 0.6 * ws, wd + ws + 5, q);   // face as steep as ever
    h += t * (wallH(side, z) + fbm(x / 22, z / 22, S + 31, 2) * (B.erg ? 1.2 : 3.2));
    // beyond the rim: rolling plateau (Tanaris: more dunes), then the world's edge rises
    if (!B.erg) h += smoothstep(wd + 8, wd + 60, ad) * 6 * (fbm(x / 60, z / 60, S + 41, 2) + 0.6);
    h += smoothstep(HALF_W - 22, HALF_W - 2, Math.abs(x)) * 30;
    // flat pads under the stops
    for (const p of pois) {
      if (p.type === 'crash') continue;
      const dp = Math.hypot(x - p.x, z - p.z);
      if (dp < 15) h = lerp(h, p.padY, smoothstep(15, 9.5, dp));
    }
    // crash mesas are buttes: their bodies are solid convex masses (W.hulls, mat 'mesa': a flat top and steep
    // walls, which the 2.5 m heightfield could only draw as a cone), standing on their talus here: a
    // concave scree apron, ~31 degrees at the wall's foot (you walk up to it) and flattening out. Its
    // reach wanders (fans of debris); toward the road it shortens and lowers so it meets the ditch at
    // nothing, and the mound still stops at the ditch wherever the road bends toward one.
    if (!bare) for (const p of mesas) {
      const M = p.mesa;
      if (Math.hypot(x - p.x, z - p.z) > M.bound + M.reach * 1.2 + 1) continue;
      // how far outside the butte's foot (its body, lobes and bench, where the talus meets the wall)
      let e = M.footDist(x, z);
      e += noise2(x / 3, z / 3, S + 51) * 0.6;
      // (ad + e: about how far from the road the foot stands, straight across). Short of room it runs
      // straighter, so the side you see from the road still stands tall against the foot
      const room = Math.max(3, ad + e - 7.5), P = 1 + (TALUS_P - 1) * smoothstep(4, 12, room);
      const reach = Math.min(M.reach * (1 + 0.2 * noise2(x / 9, z / 9, S + 53)), room);
      const tal = Math.min(M.talus, 0.62 * reach / P);
      // (debris lying on the ground: in a hollow lower than the butte's foot it fills less and less toward
      // its toe, so it never ends in a step there)
      const floor = lerp(Math.min(h, M.base), M.base, smoothstep(reach, 0.3 * reach, e));
      const mound = floor + tal * Math.pow(1 - clamp(e / reach, 0, 1), P);
      h = Math.max(h, lerp(h, mound, smoothstep(6.4, 8.9, ad)));
    }
    return h;
  }
  // POI pads are flattened so buildings sit on the ground; mesa centers need roadX
  for (const p of pois) { p.x = roadX(p.z) + p.side * p.off; p.padY = roadY(p.z) + 0.05; }
  for (const p of mesas) {
    const M = p.mesa;
    M.base = roadY(p.z) - 0.2;
    // shape from a hash of the stop's z (no rng: the layout stays put)
    const hz = Math.abs(Math.sin(p.z * 12.9898) * 43758.5453) % 1, hz2 = Math.abs(Math.sin(p.z * 78.233) * 12543.123) % 1;
    // the top's radius (the wreck and its loot need ~5 m), its wall kept a metre clear of the road's ditch
    M.r = M.R = Math.min(M.r, p.off - 7.6);
    // a lower tier (the bench) on one end, along the road so it shows side-on from it, turned a little
    // away from the road; it is where a climber rests half-way up
    M.benchA = hz < 0.5 ? Math.PI / 2 - p.side * 0.35 : -Math.PI / 2 + p.side * 0.35;   // (x: cos, z: sin; the road is at -side)
    M.benchK = 0.55 + hz2 * 0.15;
    // the talus: its own debris buries the lower third of the butte (a cliff band standing on a scree
    // apron, as a real butte stands, not a drum on the sand), the bench still 2.5 m clear of it; it
    // reaches far enough out that it is ~31 degrees at the foot (walkable) and flattens from there
    const h3 = Math.abs(Math.sin(p.z * 63.7) * 3571.9) % 1;
    M.talus = Math.min(M.h * (0.32 + 0.08 * h3), M.h * M.benchK - 2.5);
    M.reach = M.talus * TALUS_P / 0.62;
    M.bench = { x: p.x + Math.cos(M.benchA) * 0.8 * M.R, z: p.z + Math.sin(M.benchA) * 0.8 * M.R, r: 0.55 * M.R, top: M.base + M.h * M.benchK };
    // two lobes swell the main body's outline (one round drum reads as a tank from the road), each laid out
    // as a circle at the top's height (butteParts below makes the rock from these): one in profile from the
    // road (along it, at the end away from the bench, so the butte's silhouette widens there), one round
    // the back; both well off the bench (>= 1.1 rad, or it would swallow it). Each holds the centre, so the
    // outline stays a single radius per bearing (butteRadius() below), what the renderer wraps the wall round.
    const away = p.side > 0 ? 0 : Math.PI;   // the bearing straight away from the road
    const toBench = Math.sign(Math.sin(M.benchA - away)) || 1;   // which way round from 'away' the bench lies
    const h1 = Math.abs(Math.sin(p.z * 31.7) * 9631.7) % 1, h2 = Math.abs(Math.sin(p.z * 49.1) * 7177.3) % 1;
    M.lobes = [
      [away - toBench * (1.1 + 0.4 * h1), h1],          // in profile, at the far end from the bench
      [away + toBench * (-0.45 + 0.5 * h2), h2],        // round the back
    ].map(([a, hk]) => {
      const d = M.R * (0.48 + 0.14 * hk), r = M.R * (0.62 + 0.1 * hk);   // d < r: it holds the centre
      return { x: p.x + Math.cos(a) * d, z: p.z + Math.sin(a) * d, r };
    });
    // and from those circles the rock itself: angular masses whose walls lean in (shared/butte.js)
    butteParts(p, M, roadX);
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
  relaxAprons();
  // The talus aprons stay walkable wherever they changed the ground. Where an apron's wander steepens it, or
  // it runs down into a crease against the road's band, a few of the 2.5 m grid's triangles (either
  // diagonal) would stand steeper than the 38 degrees a player can walk. Debris settles there: the lowest
  // corner of such a triangle rises until it is walkable again (by the road's band, which never moves, its
  // highest corner sinks instead, never below the bare ground). Only triangles the apron made steep: the
  // bare land's own steep faces (the canyon walls) stay as they are. Done before anything reads the heights,
  // in a fixed order with plain arithmetic: the same on the server and every client.
  function relaxAprons() {
    const N1 = nz + 1, LIM2 = Math.tan(37.9 * Math.PI / 180) ** 2, T2 = Math.tan(37.4 * Math.PI / 180) ** 2;
    // a cell's four triangles (Rapier's diagonal and the other one): corner offsets [di, dk] as the
    // gradient's x leg (from, to) and z leg (from, to); its corners are the legs' ends
    const TRI = [[[0, 0], [1, 0], [0, 0], [0, 1]], [[0, 1], [1, 1], [1, 0], [1, 1]], [[0, 0], [1, 0], [1, 0], [1, 1]], [[0, 1], [1, 1], [0, 0], [0, 1]]];
    for (const p of mesas) {
      const M = p.mesa, rad = M.bound + M.reach * 1.2 + 1 + CELL;
      const i0 = Math.max(0, Math.floor((p.x - rad - X0) / CELL)), i1 = Math.min(nx, Math.ceil((p.x + rad - X0) / CELL));
      const k0 = Math.max(0, Math.floor((p.z - rad - Z0) / CELL)), k1 = Math.min(nz, Math.ceil((p.z + rad - Z0) / CELL));
      // the bare ground (no apron) under each vertex here, and which may move (none in the road's band)
      const D = k1 - k0 + 1, bare = new Float64Array((i1 - i0 + 1) * D), free = new Uint8Array(bare.length);
      for (let i = i0; i <= i1; i++) for (let k = k0; k <= k1; k++) {
        const x = X0 + i * CELL, z = Z0 + k * CELL, j = (i - i0) * D + (k - k0);
        bare[j] = H(x, z, true);
        free[j] = Math.abs(x - roadX(z)) > 8.9 ? 1 : 0;
      }
      const hv = [0, 0, 0], bv = [0, 0, 0], fv = [0, 0, 0], iv = [0, 0, 0], wx = [0, 0, 0], wz = [0, 0, 0];
      for (let pass = 0, moved = 1; moved && pass < 32; pass++) {
        moved = 0;
        for (let i = i0; i < i1; i++) for (let k = k0; k < k1; k++) for (const [xa, xb, za, zb] of TRI) {
          const gx = (heights[(i + xb[0]) * N1 + k + xb[1]] - heights[(i + xa[0]) * N1 + k + xa[1]]) / CELL;
          const gz = (heights[(i + zb[0]) * N1 + k + zb[1]] - heights[(i + za[0]) * N1 + k + za[1]]) / CELL;
          const gg = gx * gx + gz * gz;
          if (gg <= LIM2) continue;
          // its three corners: height, bare ground, free, index, and weight in each leg
          let n = 0;
          for (const c of [xa, xb, za, zb]) {
            const id = (i + c[0]) * N1 + k + c[1];
            let m = 0; while (m < n && iv[m] !== id) m++;
            if (m === n) { const j = (i + c[0] - i0) * D + (k + c[1] - k0); iv[n] = id; hv[n] = heights[id]; bv[n] = bare[j]; fv[n] = free[j]; wx[n] = 0; wz[n] = 0; n++; }
            if (c === xa) wx[m] -= 1; else if (c === xb) wx[m] += 1; else if (c === za) wz[m] -= 1; else wz[m] += 1;
          }
          // (steep on the bare ground too: the land's own face)
          const bx = wx[0] * bv[0] + wx[1] * bv[1] + wx[2] * bv[2], bz = wz[0] * bv[0] + wz[1] * bv[1] + wz[2] * bv[2];
          if ((bx * bx + bz * bz) / (CELL * CELL) > LIM2) continue;
          // raise the lowest free corner just enough (|g + t w|^2 = T2, t = dh / CELL, its smaller root)
          let lo = -1, hi = -1;
          for (let m = 0; m < 3; m++) if (fv[m]) { if (lo < 0 || hv[m] < hv[lo]) lo = m; if (hi < 0 || hv[m] > hv[hi]) hi = m; }
          if (lo < 0) continue;
          let m = lo, ww = wx[m] * wx[m] + wz[m] * wz[m], gw = gx * wx[m] + gz * wz[m], disc = gw * gw - ww * (gg - T2);
          let t = gw < 0 ? (disc >= 0 ? (-gw - Math.sqrt(disc)) / ww : -gw / ww) : 0;
          if (!(t > 0)) {
            // (no: its lowest corner lies in the road's band) sink the highest free one, never below the bare ground
            m = hi; ww = wx[m] * wx[m] + wz[m] * wz[m]; gw = gx * wx[m] + gz * wz[m]; disc = gw * gw - ww * (gg - T2);
            t = gw > 0 ? (disc >= 0 ? (-gw + Math.sqrt(disc)) / ww : -gw / ww) : 0;
            t = Math.max(t, (bv[m] - hv[m]) / CELL);
            if (!(t < 0)) continue;
          }
          heights[iv[m]] = hv[m] + t * CELL + (t > 0 ? 1e-4 : -1e-4);
          moved++;
        }
      }
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
  const hulls = [];         // convex rocks with colliders, {x,y,z,r,pts (about x,y,z),mat}: the crash buttes and their fallen blocks
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
  // The slab of rim rock a gate code is brushed on (town3d's rimCode draws it from the same numbers): a
  // plane fitted to the ground under it, lifted clear of the bumps, its top 0.24 m up. Its collider is a
  // 4 x 3 grid of boxes stepping along that plane, so nobody stands ankle-deep in the rock.
  const slabFit = (sx, sz, w, h) => {
    const yaw = Math.atan2(sx - roadX(sz), 0) + Math.PI;
    const F = frame(sx, 0, sz, yaw), gy = (lx, lz) => { const p = F(lx, 0, lz); return heightAt(p.x, p.z); };
    const hx = w / 2 + 0.5, hz = h / 2 + 0.45;
    let n = 0, sy = 0, sxy = 0, szy = 0, sxx = 0, szz = 0;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const lx = (i / 4 - 0.5) * 2.2 * hx, lz = (j / 4 - 0.5) * 2.2 * hz, y = gy(lx, lz);
      n++; sy += y; sxy += lx * y; szy += lz * y; sxx += lx * lx; szz += lz * lz;
    }
    const a0 = sy / n, bx = sxy / sxx, bz = szy / szz;
    let lift = 0;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) { const lx = (i / 4 - 0.5) * (w + 0.3), lz = (j / 4 - 0.5) * (h + 0.3); lift = Math.max(lift, gy(lx, lz) - (a0 + bx * lx + bz * lz)); }
    return { yaw, F, gy, hx, hz, a0, bx, bz, lift };
  };
  const rimSlab = (sx, sz, w, h) => {
    const { yaw, F, gy, hx, hz, a0, bx, bz, lift } = slabFit(sx, sz, w, h);
    const top0 = a0 + Math.min(lift, 0.6) + 0.24, NX = 4, NZ = 3, cw = hx * 0.95 / NX, cd = hz * 0.95 / NZ;
    for (let i = 0; i < NX; i++) for (let j = 0; j < NZ; j++) {
      const lx = -hx * 0.95 + cw * (2 * i + 1), lz = -hz * 0.95 + cd * (2 * j + 1), t = top0 + bx * lx + bz * lz;
      let lo = t - 0.3;
      for (const [dx, dz] of [[-cw, -cd], [cw, -cd], [-cw, cd], [cw, cd]]) lo = Math.min(lo, gy(lx + dx, lz + dz) - 0.2);
      const p = F(lx, 0, lz);
      box(p.x, (t + lo) / 2, p.z, cw, (t - lo) / 2, cd, yaw, 'rock', null, 'rim_slab');
    }
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
      // (12 m past the top: the crest rounds off over 4-5 m, and the winch can only drag the RV's nose up to
      // the posts. At 9 m it left the back wheels on the curve, where the RV can't pull itself over (it climbs
      // about 6 degrees on its own) and rolled back down once unhooked; and the cable still reaches from the
      // foot: 41 m of its 42 on the longest grade)
      const zt = o.z1 + 12;
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
      // the warning sign, on the first flat ground short of the narrows (the walls close in at the boulder)
      let sx = roadX(o.z - 18) - 4.6, sz = o.z - 18;
      find: for (let dz = 18; dz <= 34; dz += 4) for (const off of [5.2, 4.6]) {
        const z = o.z - dz, x = roadX(z) - off, h = heightAt(x, z);
        if (Math.abs(h - roadY(z)) < 0.3 && Math.abs(heightAt(x - 0.6, z) - heightAt(x + 0.6, z)) < 0.3 && Math.abs(heightAt(x, z - 0.6) - heightAt(x, z + 0.6)) < 0.3) { sx = x; sz = z; break find; }
      }
      signs.push({ x: sx, y: heightAt(sx, sz) + 2.1, z: sz, ry: 0, w: 2.8, h: 1.3,
        lines: ['ROCKFALL', 'SHOVE IT ASIDE', 'OR WINCH IT'], bg: '#f2c14e', fg: '#1d1d1d', post: true });
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
      // on the flattest rim rock near where it was meant to go: a slab on a bump or a 50-degree face would
      // have the ground poke through the digits. How badly: the slab's top (0.24 m over the fitted plane,
      // lifted by up to 0.6 m) against the ground on a fine grid under the paint, and the plane's slope.
      const cz0 = o.z - 14 - rng() * 10;
      let cx = 0, cz = cz0, best = Infinity;
      scan: for (const dz of [0, -3, 3, -6, 6]) for (const dd of [9.5, 8, 11, 12.5, 6.5, 14]) {
        const z = Math.min(cz0 + dz, o.z - 9), x = roadX(z) + side * (wallDist(side > 0 ? 1 : 0, z) + dd);
        const f = slabFit(x, z, 3.4, 2.0), top0 = f.a0 + Math.min(f.lift, 0.6) + 0.24;
        let poke = -1;
        for (let i = 0; i <= 12; i++) for (let j = 0; j <= 8; j++) {
          const lx = (i / 12 - 0.5) * 3.4, lz = (j / 8 - 0.5) * 2.0;
          poke = Math.max(poke, f.gy(lx, lz) - (top0 + f.bx * lx + f.bz * lz));
        }
        const score = Math.max(0, poke + 0.08) * 4 + Math.max(0, Math.hypot(f.bx, f.bz) - 0.4);
        if (score < best - 1e-6) { best = score; cx = x; cz = z; }
        if (best === 0) break scan;
      }
      const cy = heightAt(cx, cz);
      o.codeAt = { x: cx, y: cy, z: cz };
      signs.push({ x: cx, y: cy + 0.06, z: cz, ry: side > 0 ? Math.PI / 2 : -Math.PI / 2, w: 3.4, h: 2.0,
        lines: [o.code], bg: 'rgba(0,0,0,0)', fg: biome === 'snow' ? '#9a2a22' : '#ffffff', flat: true, near: 10, painted: true });
      rimSlab(cx, cz, 3.4, 2.0);
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
      const M = p.mesa, y0 = M.base + M.h; p.y = y0;
      // the butte's body, lobes and bench tier as convex hulls (sunk 0.6 m below the foot, so no gap shows
      // under the mound)
      for (const q of M.parts) hulls.push(partHull(q, p.id));
      const F = frame(px, y0, p.z, ry + 0.8);
      decor.push({ k: 'plane', x: px, y: y0, z: p.z, ry: ry + 0.8 });
      lbox(F, ry + 0.8, 0, 0.7, 0, 0.7, 0.7, 3.2, 'metal', '#f1f1f1', 'fuselage');
      lbox(F, ry + 0.8, 0, 0.7, 0.4, 4.2, 0.08, 0.8, 'metal', '#d83a3a', 'wing');
      for (let i = 0; i < 3; i++) {
        const w = F(-2 + i * 2, 0, -3.5 - rng());
        placeLoot(POI_LOOT.crash[Math.floor(rng() * POI_LOOT.crash.length)], w.x, y0, w.z, rng() * 6, 1.15);   // on the flat top
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
      lbox(F, ry, 0, 1.625, -5.2, 1.5, 1.625, 1.2, 'junk', '#6b5a4a', 'junk_heap');
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

  // ---- the crash buttes' talus: what fell off each butte, lying on its apron ----------------------------
  // Big blocks lodged against the wall's foot on the sides seen in profile from the road, heaps of them
  // round the back, slabs of the caprock under each notch where a piece of the cap broke away (the notches
  // are picked here too: M.notches, M.bench.notches), and a skirt of smaller blocks round the foot, bigger
  // and closer in near the wall. Every one is solid: world gen shapes it (Elwynn: a rounded granite boulder;
  // Westfall, the Badlands, Tanaris: a tabular block of the bedded rock, a lumpy ball cut flat by fracture
  // planes; Dun Morogh: a cut granite slab) and the physics takes its points as one convex hull (W.hulls),
  // so the server, every client and the renderer (terrain_talus.js draws these very points) agree on every
  // rock. Only the rubble, too small to trip on, is the renderer's own. Each site draws from its own stream
  // (nothing else on the leg moves), and nothing lies inside either tier, on the road or in its ditch.
  const talus = [];
  {
    const CAP_T = { meadow: 0.9, fields: 1.0, snow: 0.95, badlands: 1.3, desert: 1.4 }[biome] || 1.0;
    const snowy = biome === 'snow', round = biome === 'meadow', tabular = !snowy && !round;
    const ARC_B = 1.75, TAU = Math.PI * 2;
    const angD = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    for (const p of mesas) {
      const M = p.mesa, r = mulberry32((Math.round(p.z * 977) ^ 0x2545F491 ^ Math.imul(seed, 0x27D4EB2F) ^ Math.imul(day, 0x165667B1)) >>> 0);
      const roadA = Math.atan2(0, roadX(p.z) - p.x), bA = M.benchA;
      // the tiers (each: its centre, its outline's radius along a bearing from it, the bearings its wall shows on)
      // (the tiers' outlines where the talus meets the walls, which lean out lower down)
      const yC = M.base + M.talus, mains = butteMains(p), PB = M.parts.find(q => q.part === 'butte_bench');
      const mainFoot = a => { let r = 0; for (const q of mains) r = Math.max(r, polyExit(q.polyAt(yC), p.x, p.z, a)); return r; };
      const main = { x: p.x, z: p.z, R: a => butteRadius(p, a), main: true };
      const bench = { x: PB.cx, z: PB.cz, R: a => polyExit(PB.top, PB.cx, PB.cz, a), main: false };
      const inMain = (x, z) => { let d = -1e9; for (const q of mains) d = Math.max(d, -sdPoly(q.polyAt(yC), x, z)); return d; };
      const inBench = (x, z) => -sdPoly(PB.polyAt(yC), x, z);
      // where a tier's foot shows along bearing a (null: none there, the bench's arc ends or the bench stands
      // round the main wall), a little out from its colliders (the drawn wall and its flare)
      const footOf = (T, a) => {
        if (T.main) { const R = mainFoot(a); if (inBench(p.x + Math.cos(a) * R, p.z + Math.sin(a) * R) > 0.45) return null; return R + 0.15; }
        return angD(a, bA) > ARC_B - 0.35 ? null : polyExit(PB.polyAt(yC), PB.cx, PB.cz, a) + 0.15;
      };
      const at = (T, a, d) => [T.x + Math.cos(a) * d, T.z + Math.sin(a) * d];
      const roadClear = (x, z, pad) => Math.abs(x - roadX(z)) > 6.7 + pad;
      // the cap's broken notches (terrain_butte draws the cap broken back there): one or two round the main
      // tier, now and then one on the bench's arc, never facing the road (the wreck's gas bag hangs there)
      const notches = T => {
        const out = [], n = T.main ? 1 + (r() < 0.55 ? 1 : 0) : (r() < 0.45 ? 1 : 0);
        for (let k = 0; k < n; k++) for (let t = 0; t < 16; t++) {
          const a = T.main ? r() * TAU : lerp(bA - ARC_B + 0.5, bA + ARC_B - 0.5, r());
          if (angD(a, roadA) < 1.25 || out.some(q => angD(q.a, a) < 1.3)) continue;
          out.push({ a, w: 0.8 + r() * 0.9, k: 0.75 + r() * 0.25 });
          break;
        }
        return out;
      };
      M.notches = notches(main); M.bench.notches = notches(bench);
      // one block: size s (m), yaw, tilt [x, z] (rad), a fraction `sink` of its height buried; it rests on the
      // ground under its footprint, tipped most of the way with the slope
      const block = (T, x, z, s, yaw, tilt, sink, cap = 0) => {
        if ((T.main ? inBench(x, z) : inMain(x, z)) > 0.2) return;           // (inside the other tier)
        const e = Math.max(0.3, Math.max(s[0], s[2]) * 0.6);
        const gE = heightAt(x + e, z), gW = heightAt(x - e, z), gN = heightAt(x, z + e), gS = heightAt(x, z - e), gC = heightAt(x, z);
        const y = (gE + gW + gN + gS + 2 * gC) / 6 + s[1] * (1 - 1.55 * sink);
        const q = qMul(qUp(-(gE - gW) / (2 * e) * 0.8, -(gN - gS) / (2 * e) * 0.8), qEuler(tilt[0], yaw, tilt[1]));
        const rs = mulberry32((r() * 4294967296) >>> 0);
        const shape = snowy ? slabShape(rs) : round ? ballShape(rs, 2 + Math.floor(rs() * 2), 0.3) : ballShape(rs, 6 + Math.floor(rs() * 3), 0.18);
        // its points about its centre, scaled and turned: the mesh's (a slab's snow cap: C), and all of them
        // the collider's (you stand on a slab's snow, not in it)
        const turn = U => { const out = new Float32Array(U.length); for (let i = 0; i < U.length; i += 3) { const v = qRot(q, U[i] * s[0], U[i + 1] * s[1], U[i + 2] * s[2]); out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2]; } return out; };
        const P = turn(shape.P), C = shape.C ? { P: turn(shape.C.P), I: shape.C.I } : null;
        const pts = C ? Float32Array.from([...P, ...C.P]) : P;
        let rr = 0; for (let i = 0; i < pts.length; i += 3) rr = Math.max(rr, Math.hypot(pts[i], pts[i + 2]));
        talus.push({ poi: p.id, x, y, z, P, I: shape.I, C, kind: snowy ? 'slab' : round ? 'round' : 'tabular', cap });
        hulls.push({ x, y, z, r: rr, pts, mat: 'talus', poi: p.id });
      };
      // shoulders: one or two big blocks lodged against the wall's foot, on the sides seen from the road
      const side0 = r() < 0.5 ? 1 : -1;
      for (let k = 0, n = 1 + (r() < 0.6 ? 1 : 0); k < n; k++) for (let t = 0; t < 10; t++) {
        const a = roadA + (k ? -side0 : side0) * (Math.PI / 2 + (r() - 0.5) * 1.0), d0 = footOf(main, a);
        if (d0 == null) continue;
        const s = [1.5 + r() * 0.6, 1.0 + r() * 0.25, 1.1 + r() * 0.5], [x, z] = at(main, a, d0 + s[2] * 0.25);
        if (!roadClear(x, z, s[0])) continue;
        block(main, x, z, s, -a + (r() - 0.5) * 0.4, [(r() - 0.5) * 0.18, (r() - 0.5) * 0.18], 0.36);
        break;
      }
      // heaps: two or three piles of big blocks against the foot, away from the road
      for (let k = 0, nP = 2 + (r() < 0.5 ? 1 : 0); k < nP; k++) for (let t = 0; t < 12; t++) {
        const a = roadA + Math.PI + (r() - 0.5) * 3.8, d0 = footOf(main, a);
        if (d0 == null || angD(a, roadA) < 1.15) continue;
        for (let j = 0, n = 3 + Math.floor(r() * 3); j < n; j++) {
          const aj = a + (r() - 0.5) * 2.6 / butteRadius(p, a), dj = d0 - 0.3 + r() * 1.7, k0 = 0.85 + r() * 0.75, [x, z] = at(main, aj, dj);
          if (!roadClear(x, z, k0)) continue;
          const s = tabular ? [k0 * (1.05 + r() * 0.4), k0 * (0.55 + r() * 0.3), k0 * (0.85 + r() * 0.35)] : [k0 * (0.95 + r() * 0.35), k0 * (0.7 + r() * 0.2), k0 * (0.9 + r() * 0.35)];
          block(main, x, z, s, r() * TAU, [(r() - 0.5) * 0.6, (r() - 0.5) * 0.6], 0.36);
        }
        break;
      }
      // the caprock's slabs, fallen under each notch
      for (const [T, list] of [[main, M.notches], [bench, M.bench.notches]]) for (const nt of list) {
        for (let k = 0, n = 2 + (r() < 0.5 ? 1 : 0); k < n; k++) {
          const a = nt.a + (r() - 0.5) * nt.w / T.R(nt.a) * 1.6, d0 = footOf(T, a);
          if (d0 == null) continue;
          const [x, z] = at(T, a, d0 + 0.6 + r() * 2.6), th = CAP_T * (T.main ? 1 : 0.75);   // (the cap bed's thickness)
          const s = [1.0 + r() * 0.7, Math.min(0.9, th * (0.45 + r() * 0.2)), 0.8 + r() * 0.5];
          if (!roadClear(x, z, s[0])) continue;
          block(T, x, z, s, r() * TAU, [(r() - 0.5) * 0.7, (r() - 0.5) * 0.7], 0.38, 1);
        }
      }
      // the skirt: fallen blocks round the foot (the road side's fewer, smaller and closer in)
      for (const T of [main, bench]) {
        const n = Math.round((T.main ? 20 : 6) + r() * 5);
        for (let k = 0; k < n; k++) {
          const a = T.main ? (k + r() * 0.8) / n * TAU : bA - ARC_B + (k + r() * 0.8) / n * 2 * ARC_B, d0 = footOf(T, a);
          if (d0 == null) continue;
          const roadSide = angD(a, roadA) < 0.9, qd = Math.pow(r(), 1.4), d = d0 - 0.1 + qd * (roadSide ? 3.2 : 4.6);
          const big = !roadSide && r() < 0.35 * (1 - qd), k0 = big ? 0.85 + r() * 0.6 : roadSide ? 0.3 + r() * 0.3 : 0.4 + r() * 0.45;
          const [x, z] = at(T, a, d);
          if (!roadClear(x, z, k0)) continue;
          const s = tabular ? [k0 * (1.0 + r() * 0.4), k0 * (0.42 + r() * 0.25), k0 * (0.8 + r() * 0.35)]
            : round ? [k0 * (0.9 + r() * 0.35), k0 * (0.65 + r() * 0.25), k0 * (0.85 + r() * 0.35)]
            : [k0 * (0.85 + r() * 0.4), k0 * (0.55 + r() * 0.3), k0 * (0.85 + r() * 0.4)];
          block(T, x, z, s, r() * TAU, [(r() - 0.5) * (tabular ? 0.8 : 0.45), (r() - 0.5) * (tabular ? 0.8 : 0.45)], round ? 0.42 : 0.4);
        }
      }
    }
  }

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
  // Westfall: cultivated plots beside the road (terrain paints their strips: standing wheat, stubble or
  // fresh furrows, running along or across the plot), each with a rail fence along its road edge and a
  // gap for a gate; nothing else grows inside one. Plots sit on flat valley floor, clear of stops and
  // obstacles. And a windmill on its own knoll you can see from the road (it has a collider).
  const fields = [], clearSpots = [];
  const inField = (f, x, z, pad = 0) => {
    const dx = x - f.x, dz = z - f.z, sn = Math.sin(f.ry), c = Math.cos(f.ry);
    return Math.abs(dx * sn + dz * c) < f.hl + pad && Math.abs(dx * c - dz * sn) < f.hd + pad;
  };
  if (biome === 'fields') {
    for (let z = 40 + rngD() * 30; z < LEN - 70; z += 75 + rngD() * 55) {
      const side = rngD() < 0.5 ? -1 : 1, len = 22 + rngD() * 18, off = 11 + rngD() * 4, kind = ['wheat', 'stubble', 'furrow'][Math.floor(rngD() * 3)], along = rngD() < 0.5;
      const zc = z + len / 2, wd = wallDist(side > 0 ? 1 : 0, zc), dep = Math.min(14 + rngD() * 12, wd - 4 - off);
      if (dep < 10) continue;
      if (pois.some(p => Math.abs(p.z - zc) < len / 2 + 16) || obstacles.some(o => Math.abs(o.z - zc) < len / 2 + 24)) continue;
      const ry = Math.atan2(W_roadDx(zc), 1), cx = roadX(zc) + side * (off + dep / 2);
      const f = { x: cx, z: zc, ry, hl: len / 2, hd: dep / 2, kind, along, side };
      let lo = Infinity, hi = -Infinity;
      for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [0, 0], [0, 1], [0, -1]]) {
        const sn = Math.sin(ry), c = Math.cos(ry), px = cx + sn * u * f.hl + c * v * f.hd, pz = zc + c * u * f.hl - sn * v * f.hd, h = heightAt(px, pz);
        lo = Math.min(lo, h); hi = Math.max(hi, h);
      }
      if (hi - lo > 2.5) continue;
      fields.push(f);
      // round bales left lying on a stubble plot, and a scarecrow in some wheat and furrow plots facing the
      // road (so a plot reads as a farm from the road, not just a strip of paint). They draw from their own
      // random stream: adding them moves nothing else on the leg.
      const rf = mulberry32((seed ^ Math.imul(day * 131 + fields.length, 0x27D4EB2F)) >>> 0);
      const fsn = Math.sin(ry), fc = Math.cos(ry), inPlot = (u, v) => [cx + fsn * u + fc * v, zc + fc * u - fsn * v];
      if (kind === 'stubble') {
        const n = 3 + Math.floor(rf() * 4);
        for (let i = 0, t = 0; i < n && t < 40; t++) {
          const [bx, bz] = inPlot((rf() * 2 - 1) * (f.hl - 3), (rf() * 2 - 1) * (f.hd - 3));
          if (cyls.some(q => Math.hypot(q.x - bx, q.z - bz) < q.r + 2.4)) continue;
          const by = heightAt(bx, bz);
          cyls.push({ x: bx, y: by + 0.6, z: bz, r: 0.75, hh: 0.6, mat: 'haybale' });
          decor.push({ k: 'haybale', x: bx, y: by, z: bz, s: 1, ry: ry + (along ? Math.PI / 2 : 0) + (rf() - 0.5) * 0.6, variant: 0, field: fields.length - 1 });
          i++;
        }
      } else if (rf() < 0.6) {
        const [sx, sz] = inPlot((rf() * 2 - 1) * f.hl * 0.5, -side * f.hd * (0.15 + rf() * 0.3));
        decor.push({ k: 'scarecrow', x: sx, y: heightAt(sx, sz), z: sz, s: 1, ry: Math.atan2(roadX(sz) - sx, 0) + (rf() - 0.5) * 0.5, field: fields.length - 1 });
      }
      // the fence along the road edge, in two runs either side of a 3 m gate
      const fx = roadX(zc) + side * (off - 0.6), runLen = len / 2 - 1.5, posts = Math.max(3, Math.round(runLen / 1.9) + 1);
      for (const sd of [-1, 1]) {
        const rz = zc + sd * (runLen / 2 + 1.5), rx = fx + Math.sin(ry) * sd * (runLen / 2 + 1.5);
        decor.push({ k: 'fence', x: rx, y: heightAt(rx, rz), z: rz, s: 1, ry, len: posts, field: fields.length - 1 });
      }
    }
    // the windmill: on a knoll beside the road, out where the road views look
    for (let t = 0; t < 12; t++) {
      const z = 140 + rngD() * 120, side = rngD() < 0.5 ? -1 : 1, off = 19 + rngD() * 6, x = roadX(z) + side * off;
      if (pois.some(p => Math.hypot(p.x - x, p.z - z) < 22) || obstacles.some(o => Math.abs(o.z - z) < 30)) continue;
      if (fields.some(f => inField(f, x, z, 6)) || off > wallDist(side > 0 ? 1 : 0, z) - 6) continue;
      const y = heightAt(x, z);
      cyls.push({ x, y: y + 6, z, r: 2.7, hh: 6, mat: 'windmill' });
      cyls.push({ x, y: y + 13.25, z, r: 2.6, hh: 1.25, mat: 'windmill' });   // the cap's base: climbers can't stand inside the roof
      decor.push({ k: 'windmill', x, y, z, s: 1, ry: Math.atan2(roadX(z) - x, 0) });   // ry: its sails face the road
      clearSpots.push({ x, z, r: 7 });
      break;
    }
  }
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
    if (fields.some(f => inField(f, x, z, 1.5)) || clearSpots.some(c => Math.hypot(c.x - x, c.z - z) < c.r)) return false;   // plots, the windmill
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
      box(d.x, d.y + (under + top) / 2, d.z, 1.5 * S, (top - under) / 2, 0.62 * S, d.ry, 'invisible', null, 'arch_span');   // the lintel is 1.24 S wide
    } else if (biome === 'badlands') {
      // a ledge: a long 2:1 mesa block yawed with the rock (nature3d fills this box), top at 1.35 S
      box(d.x, d.y + 0.6 * S, d.z, 1.3 * S, 0.75 * S, 0.7 * S, d.ry, 'rock', null, 'rock_ledge');
    } else if (green) {
      // low Elwynn/Westfall/Dun Morogh boulders and outcrops, about 0.7 S tall (the renderer follows the top)
      cyls.push({ x: d.x, y: d.y + S * 0.3, z: d.z, r: S * 0.8, hh: S * 0.4, mat: 'rock' });
    } else {
      cyls.push({ x: d.x, y: d.y + S * 0.36, z: d.z, r: S * 0.95, hh: S * 0.45, mat: 'rock' });   // a desert mound
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
      // Dun Morogh: valley-floor pines often stand in dark clumps of three (they give the white long views their darks)
      if (k === 'pine' && biome === 'snow' && off < wd - 4 && rngD() < 0.3) {
        for (let j = 0; j < 2; j++) {
          const a = rngD() * 6.283, dd = 2.4 + rngD() * 2.2, gx = x + Math.cos(a) * dd, gz = z + Math.sin(a) * dd;
          if (!decorOk(gx, gz, Math.abs(gx - roadX(gz))) || cyls.some(c => c.mat === 'tree' && Math.hypot(c.x - gx, c.z - gz) < 2.2)) continue;
          tree('pine', gx, gz, (0.7 + rngD() * 0.5) * s, rngD() * 6.283);
        }
      }
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
      const fe = { k, x, y, z, s, ry: Math.atan2(W_roadDx(z), 1) + (rng() - 0.5) * 0.2, len: 4 + Math.floor(rng() * 4) };
      decor.push(fe);
      // Westfall: now and then a lone oak just past one end of a fence, a little further from the road
      if (biome === 'fields' && rngD() < 0.34) {
        const reach = (fe.len - 1) / 2 * 1.9 + 2.5 + rngD(), sd = rngD() < 0.5 ? -1 : 1, away = Math.sign(x - roadX(z)) || 1;
        const tx = x + Math.sin(fe.ry) * reach * sd + away * (1 + rngD()), tz = z + Math.cos(fe.ry) * reach * sd;
        if (decorOk(tx, tz, Math.abs(tx - roadX(tz))) && !cyls.some(c => c.mat === 'tree' && Math.hypot(c.x - tx, c.z - tz) < 3.2)) tree('oak', tx, tz, 0.8 + rngD() * 0.35, rngD() * 6.283);
      }
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
  // Dun Morogh and Tanaris: a big boulder (snow: granite; desert: a wind-cut sandstone mound) at the foot of
  // the canyon wall every 40-60 m, alternating sides, so the line where the wall meets the floor breaks up.
  // d.foot marks them for the renderer.
  if (biome === 'snow' || biome === 'desert') {
    let sd = rngD() < 0.5 ? -1 : 1;
    for (let z = 30 + rngD() * 20; z < LEN - 30; z += 40 + rngD() * 20) {
      sd = -sd;
      const wd = wallDist(sd > 0 ? 1 : 0, z), off = wd - 0.5 + rngD() * 1.5, x = roadX(z) + sd * off;
      const s = 1.25 + rngD() * 0.45, ry = rngD() * 6.283;
      if (!decorOk(x, z, off) || cyls.some(c => Math.hypot(c.x - x, c.z - z) < c.r + 2.5 + s)) continue;
      const d = { k: 'rock', x, y: heightAt(x, z), z, s, ry, foot: true };
      const R = s * 1.1;   // the renderer's own steepness test
      let lo = Infinity, hi = -Infinity;
      for (const [dx, dz] of [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R]]) { const h = heightAt(x + dx, z + dz); lo = Math.min(lo, h); hi = Math.max(hi, h); }
      const steep = hi - lo > 0.8 * s;
      if (biome === 'desert') d.variant = 'mound';
      decor.push(d);
      rockCollide(d, steep);
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
    // Ed's loading zone: the street in front of his door. With the RV parked here the bell sells the
    // RV's whole load too, sight unseen, at DOCK_RATE (carry the good stuff in for the full price)
    const dock = F(0, 0, 4.5 + 7.5);
    town.dock = { x: dock.x, z: dock.z, r: 7 };
    const ds = F(-1.4, 0, 4.5 + 4.2);
    signs.push({ x: ds.x, y: heightAt(ds.x, ds.z) + 2.0, z: ds.z, ry: Math.PI / 2, w: 2.8, h: 1.3,
      lines: ['ED\'S LOADING ZONE', 'PARK THE RV HERE', 'RING: HE BUYS THE LOT'], bg: '#f4d35e', fg: '#2b2d42', post: true });
  }
  // general store
  {
    const { F, y0, id } = building(-17, T + 78, Math.PI / 2, 10, 8, 3.4, 'stucco', '#7fb7be', townY, 'store');
    tagNow = { town: 'store' }; shelfCollider(id, F, y0); tagNow = null;
    const counter = F(0, 0.5, -1.6);
    tagNow = { town: 'store' };
    box(counter.x, y0 + 0.5, counter.z, 2.6, 0.5, 0.5, Math.PI / 2, 'wood', '#a0743c', 'counter');
    tagNow = null;
    const w = F(-1.4, 1.1, -1.5); use('buy', w.x, y0 + 1.1, w.z, 'Walkie-talkie: talk to anyone else with one, at any range', 'walkie', 0.3);
    const d = F(0.2, 1.1, -1.5); use('buy', d.x, y0 + 1.1, d.z, 'Energy drink', 'drink', 0.3);
    const r = F(1.6, 1.1, -1.5); use('buy', r.x, y0 + 1.1, r.z, 'Bungee cords', 'bungee', 0.3);
    const hh = F(-2.3, 1.1, -1.5); use('buy', hh.x, y0 + 1.1, hh.z, 'Hard hat: your next knockout is only a knock', 'hardhat', 0.3);
    const ch = F(2.4, 1.1, -1.5); use('buy', ch.x, y0 + 1.1, ch.z, 'Cheese wheel: ringtails can\'t resist it', 'cheese', 0.3);
    // (where a bought cheese wheel is put down: the bare counter between the drink and the bungees, clear of
    // every buy spot: inside one's ball the crosshair saw only the spot, and E bought another)
    const shelf = F(0.9, 1.1, -1.5);
    town.store = { walkie: w, drink: d, bungee: r, hardhat: hh, cheese: ch, shelf: { x: shelf.x, y: y0 + 1.1, z: shelf.z } };
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

  // Gus's Garage: a workbench by the RV lot (10 m from where the RV parks at night) and his sign; he fixes the
  // RV once the day's payment is made, for cash or on the loan (server/room.js repair)
  {
    const gx = -7.5, gz = T + 131, ry = Math.PI / 2;
    town.gus = { x: gx, z: gz, y: townY, ry };
    tagNow = { town: 'gus' };
    box(gx, townY + 0.45, gz, 0.6, 0.45, 0.3, ry, 'wood', '#7a5a3a', 'gus_bench');
    tagNow = null;
    signs.push({ x: gx - 1.2, y: townY + 2.3, z: gz, ry: Math.PI / 2, w: 2.6, h: 1.1, lines: ["GUS'S GARAGE", 'WE FIX RVs. MOSTLY.'], bg: '#2b2d42', fg: '#f4d35e', post: true });
    // (his two buttons sit on the front of the bench's top, 0.4 m apart: small targets, so they never overlap)
    use('repair', gx + 0.12, townY + 0.99, gz - 0.2, 'Gus: fix 25% (cash)', 'cash', 0.18);
    use('repair', gx + 0.12, townY + 0.99, gz + 0.2, 'Gus: fix 25% (on the loan)', 'loan', 0.18);
  }

  // world edges
  const zMid = (Z0 + Z1) / 2, zHalf = (Z1 - Z0) / 2;
  box(-HALF_W + 1, 80, zMid, 1, 120, zHalf, 0, 'invisible');
  box(HALF_W - 1, 80, zMid, 1, 120, zHalf, 0, 'invisible');
  box(0, 80, Z0 + 1, HALF_W, 120, 1, 0, 'invisible');
  box(0, 80, Z1 - 1, HALF_W, 120, 1, 0, 'invisible');

  // the walkable top at (x, z): the ground, or a butte's flat top where one stands
  function topAt(x, z) {
    let y = heightAt(x, z);
    for (const p of mesas) {
      const M = p.mesa;
      if (Math.hypot(x - p.x, z - p.z) > M.bound) continue;
      const t = M.topAt(x, z);
      if (t != null) y = Math.max(y, t);
    }
    return y;
  }

  // ---- the wildlife (shared/mobs.js): where the grumphorns sleep and the ringtails den ----------------------
  // Its own random stream, drawn last: nothing generated before it moves, and generateLeg(seed, day,
  // {mobs:false}) is the same world without it (test/mobs.mjs checks).
  function placeWildlife() {
    const rngM = mulberry32((seed ^ Math.imul(day + 31, 0xC2B2AE35)) >>> 0);
    // (the stones by the signs and the Hoard's pile draw from their own stream: the dens and beds come out
    // where they did before those were added)
    const rngX = mulberry32((seed ^ Math.imul(day + 57, 0x27D4EB2F)) >>> 0);
    const P = MOB_PLAN[Math.min(day, MOB_PLAN.length) - 1];
    // flat enough to stand on, and near the height given
    const flatAt = (x, z, ref, tol) => {
      const h = heightAt(x, z);
      if (Math.abs(h - ref) > tol) return false;
      let s = 0;
      for (const [dx, dz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) s = Math.max(s, Math.abs(heightAt(x + dx, z + dz) - h) / 1.2);
      return s <= 0.36;
    };
    const beds = [];
    for (const b of P.beds) {
      const o = obstacles.find(q => q.type === b.ob);
      if (!o) continue;
      const z = (b.from === 'z1' ? o.z1 : o.z) + b.dz, x = roadX(z);
      // asleep across the road, slantwise
      const head = Math.atan2(roadX(z + 2) - roadX(z - 2), 4);
      const ry = head + (rngM() < 0.5 ? -1 : 1) * (0.7 + 0.5 * rngM());
      // where it walks off to when it has had enough (bedExit)
      const exit = bedExit({ heightAt, roadX, roadY, LEN, statics, cyls, hulls }, z);
      beds.push({ id: beds.length, ob: o.type, obz: o.z, type: 'grumphorn', x, y: heightAt(x, z), z, ry, exit });
      // the warning, short of the obstacle and across the road from that obstacle's own sign (the boulder's
      // stands on the right, the mud's and the gate's on the left: a driver heading +z has +x on the left)
      const side = o.type === 'boulder' ? 1 : -1;
      let sx = roadX(o.z - 26) + side * 5.2, sz = o.z - 26;
      find2: for (let dz = 26; dz <= 42; dz += 4) for (const off of [5.2, 4.6, 6]) {
        const zz = o.z - dz, xx = roadX(zz) + side * off;
        if (flatAt(xx, zz, roadY(zz), 0.4)) { sx = xx; sz = zz; break find2; }
      }
      signs.push({ x: sx, y: heightAt(sx, sz) + 2.1, z: sz, ry: 0, w: 2.8, h: 1.3,
        lines: ['GRUMPHORN', 'CROSSING', 'LET IT SLEEP'], bg: '#f2c14e', fg: '#1d1d1d', post: true, beast: true });
      // ammunition: a heap of stones at the foot of the sign (to carry up and throw at it, from a safe way off)
      for (let k = 0, n = 0; k < 16 && n < 5; k++) {
        const a = rngX() * 6.283, r = 0.9 + rngX() * 1.6, x = sx + Math.cos(a) * r, z = sz + Math.sin(a) * r;
        if (Math.abs(x - roadX(z)) < 3.6 || !flatAt(x, z, roadY(z), 1)) continue;
        if (statics.some(b => b.mat !== 'invisible' && Math.hypot(b.x - x, b.z - z) < Math.max(b.hx, b.hz) + 0.5)) continue;
        if (cyls.some(c => Math.hypot(c.x - x, c.z - z) < c.r + 0.3) || hulls.some(c => Math.hypot(c.x - x, c.z - z) < (c.r || 2) + 0.3)) continue;   // (a cairn, a rock)
        props.push({ id: propId++, type: 'stone', x, y: heightAt(x, z) + LOOT.stone.shape[2] + 0.03, z, ry: rngX() * 6.283, value: 0 });
        n++;
      }
    }
    // ringtail dens: beside the ground stops (never up a crash butte), 10-18 m past the stop on the side away
    // from the road (out of voice range of a parked RV). The stops with the most light loot about them are
    // likelier to have one; on day 1 never the first stop
    const dens = [];
    let stops = pois.filter(p => p.type !== 'crash').sort((a, b) => a.z - b.z);
    if (day === 1) stops = stops.slice(1);
    const light = p => props.reduce((a, q) => a + (LOOT[q.type] && !LOOT[q.type].tool && LOOT[q.type].mass <= 15 && Math.hypot(q.x - p.x, q.z - p.z) < 12 ? q.value : 0), 0);
    const pool = stops.map(p => ({ p, w: light(p) + 50 }));
    const denSpot = p => {
      const away = Math.sign(p.x - roadX(p.z)) || 1;
      for (const r of [12, 14, 10, 16, 18]) for (const a of [0, -0.45, 0.45, -0.8, 0.8]) {
        const x = p.x + away * Math.cos(a) * r, z = p.z + Math.sin(a) * r;
        if (Math.abs(x - roadX(z)) < 14 || !flatAt(x, z, p.padY, 2.5)) continue;
        if (statics.some(b => b.mat !== 'invisible' && Math.hypot(b.x - x, b.z - z) < Math.max(b.hx, b.hz) + 2)) continue;
        if (cyls.some(c => Math.hypot(c.x - x, c.z - z) < c.r + 2)) continue;
        if (hulls.some(c => Math.hypot(c.x - x, c.z - z) < (c.r || 2) + 2)) continue;
        if (obstacles.some(o => Math.abs(o.z - z) < 30)) continue;
        if (pois.some(q => q !== p && Math.hypot(q.x - x, q.z - z) < 14)) continue;
        return { x, y: heightAt(x, z), z, ry: Math.atan2(p.x - x, p.z - z) };   // (facing the stop)
      }
      return null;
    };
    const green = biome === 'meadow' || biome === 'fields' || biome === 'snow';
    // day 5's Hoard: the junkyard's den (else the stop with the most light loot about it), its pile the
    // ringtails' haul of the week (four good things, about $2,500), and all of them at home to guard it
    if (P.hoard) {
      const order = pool.slice().sort((a, b) => (b.p.type === 'junk') - (a.p.type === 'junk') || b.w - a.w);
      for (const c of order) {
        const sp = denSpot(c.p);
        if (!sp) continue;
        pool.splice(pool.indexOf(c), 1);
        const fx = Math.sin(sp.ry), fz = Math.cos(sp.ry), sx = fz, sz = -fx, stash = [];
        P.hoard.stash.forEach((type, k) => {
          // a fan of them in front of the den, toward the stop
          const L = LOOT[type], a = (k - (P.hoard.stash.length - 1) / 2) * 1.05, half = L.shape[0] === 'box' ? L.shape[2] : L.shape[1];
          const ix = sp.x + fx * (1.2 + Math.abs(a) * 0.3) + sx * a, iz = sp.z + fz * (1.2 + Math.abs(a) * 0.3) + sz * a, id = propId++;
          const value = Math.round(L.value * (1 + 0.22 * (day - 1)) * (0.9 + rngX() * 0.2) / 5) * 5;
          props.push({ id, type, x: ix, y: heightAt(ix, iz) + half + 0.06, z: iz, ry: rngX() * 6.283, value });
          stash.push(id);
        });
        dens.push({ id: dens.length, poi: c.p.id, poiType: c.p.type, x: sp.x, y: sp.y, z: sp.z, ry: sp.ry, stash, hoard: true });
        // dressed like a den, and then some: bones and rocks about it
        for (const [k, dx, dz, s] of [['bones', -1.0, -0.6, 1], ['rock', -0.9, 0.8, 0.8], ['bones', 1.2, -0.9, 0.8], ['rock', 0.2, -1.4, 0.6], ['rock', -1.6, 0.1, 0.5]]) {
          const x = sp.x + sx * dx - fx * (0.8 - dz), z = sp.z + sz * dx - fz * (0.8 - dz);
          decor.push({ k, x, y: heightAt(x, z), z, s, ry: rngX() * 6.283, den: true });
        }
        break;
      }
    }
    while (dens.length < P.dens && pool.length) {
      let r = rngM() * pool.reduce((a, c) => a + c.w, 0), i = 0;
      for (; i < pool.length - 1; i++) { r -= pool[i].w; if (r < 0) break; }
      const { p } = pool.splice(i, 1)[0];
      const sp = denSpot(p);
      if (!sp) continue;
      // the den's stash: one light thing of the stop's kind, already dragged home, a step toward the stop
      const kinds = (POI_LOOT[p.type] || ['gnome']).filter(k => LOOT[k].mass <= 15);
      const type = kinds[Math.floor(rngM() * kinds.length)], L = LOOT[type];
      const value = Math.round(L.value * (1 + 0.22 * (day - 1)) * (0.85 + rngM() * 0.4) / 5) * 5;
      const fx = Math.sin(sp.ry), fz = Math.cos(sp.ry), half = L.shape[0] === 'box' ? L.shape[2] : L.shape[1];
      const ix = sp.x + fx * 0.9, iz = sp.z + fz * 0.9, id = propId++;
      props.push({ id, type, x: ix, y: heightAt(ix, iz) + half + 0.06, z: iz, ry: rngM() * 6.283, value });
      dens.push({ id: dens.length, poi: p.id, poiType: p.type, x: sp.x, y: sp.y, z: sp.z, ry: sp.ry, stash: [id] });
      // dressing (to look at only): a big stump and a bush, or bones and a rock out in the dry country
      const bx = sp.x - fx * 0.9, bz = sp.z - fz * 0.9, sx = fz, sz = -fx;
      if (green) {
        decor.push({ k: 'stump', x: bx, y: heightAt(bx, bz), z: bz, s: 1.4, ry: rngM() * 6.283, den: true });
        decor.push({ k: 'bush', x: bx + sx * 1.3, y: heightAt(bx + sx * 1.3, bz + sz * 1.3), z: bz + sz * 1.3, s: 0.9, ry: rngM() * 6.283, den: true });
      } else {
        decor.push({ k: 'bones', x: bx + sx * 0.8, y: heightAt(bx + sx * 0.8, bz + sz * 0.8), z: bz + sz * 0.8, s: 1, ry: rngM() * 6.283, den: true });
        decor.push({ k: 'rock', x: bx, y: heightAt(bx, bz), z: bz, s: 0.7, ry: rngM() * 6.283, den: true });
      }
    }
    // loose rock up on a rim of each narrows (the boulder's and the gate's), days 3-5: where a rockfall comes
    // down from (server/mobs.js: the RV coming close, or the boulder disturbed, brings it down on whoever is
    // there; a honk well back brings it down early, on nobody). Five or six rocks strung along the lip short
    // of the obstacle, and a warning sign back down the road
    const rockfalls = [];
    if (P.rocks) for (const o of obstacles) {
      if (o.type !== 'boulder' && o.type !== 'gate') continue;
      const side = rngM() < 0.5 ? -1 : 1, n = 5 + (rngM() < 0.5 ? 1 : 0), rim = [];
      for (let k = 0; k < n; k++) {
        const z = o.z - 5 - k * 2.4 - rngM() * 1.2, ry = roadY(z);
        // loose on the face itself, two thirds of the way up the wall, a hand's width out from it
        const top = heightAt(roadX(z) + side * 25, z) - ry;
        if (top < 6) continue;
        let at = null;
        for (let d = 6.5; d <= 25; d += 0.25) {
          const x = roadX(z) + side * d;
          if (heightAt(x, z) - ry > 0.66 * top) { at = { x: roadX(z) + side * (d - 0.5), z }; break; }
        }
        if (!at) continue;
        rim.push({ x: at.x, y: heightAt(at.x, at.z) + 0.6, z: at.z });
      }
      if (rim.length < 3) continue;
      const beast = beds.some(b => b.obz === o.z);
      rockfalls.push({ id: rockfalls.length, ob: o.type, obz: o.z, side, rim, beast });
      // the warning, back down the road on the same side as the loose rock
      let sx = roadX(o.z - 40) + side * 5.2, sz = o.z - 40;
      find: for (let dz = 40; dz <= 56; dz += 4) for (const off of [5.2, 4.6, 6]) {
        const zz = o.z - dz, xx = roadX(zz) + side * off;
        if (flatAt(xx, zz, roadY(zz), 0.4) && !signs.some(q => Math.hypot(q.x - xx, q.z - zz) < 4)) { sx = xx; sz = zz; break find; }
      }
      signs.push({ x: sx, y: heightAt(sx, sz) + 2.1, z: sz, ry: 0, w: 2.8, h: 1.3,
        lines: ['LOOSE ROCK', beast ? 'HONK FROM HERE' : 'HONK FIRST', 'KEEP MOVING'], bg: '#f2c14e', fg: '#1d1d1d', post: true, rock: true });
    }
    return { dens, beds, rockfalls };
  }
  const wild = opts.mobs === false ? { dens: [], beds: [], rockfalls: [] } : placeWildlife();

  return {
    seed, day, LEN, Z0, Z1, X0, nx, nz, cell: CELL, heights, fields,
    roadX, roadY, heightAt, topAt, townY,
    obstacles, pois, mesas, statics, cyls, hulls, talus, decor, signs, uses, anchors, mud, gates, props,
    landmarks, camp, town, buildings, biome, biomeName: B.name, quota: null,
    dens: wild.dens, beds: wild.beds, rockfalls: wild.rockfalls,
  };
}

// A butte's main tier outline at its top (its body and lobes, convex masses that each hold the centre): how
// far from the centre (p.x, p.z) its rim lies along bearing a (x: cos a, z: sin a), one radius per bearing.
// (Lower down the wall leans out: at height y it is this times part.sAt(y).)
export { butteMains, polyExit };
export function butteRadius(p, a) {
  const M = p.mesa;
  if (M.parts) {
    // (from a table of 2048 bearings, made on first use: linear between them is within 0.01 mm of the
    // exact outline, and the renderer asks this a great many times)
    let T = M.rTable;
    if (!T) {
      const mains = butteMains(p), N = 2048;
      T = M.rTable = new Float64Array(N + 1);
      for (let k = 0; k <= N; k++) { const th = k / N * Math.PI * 2; let r = 0; for (const q of mains) r = Math.max(r, polyExit(q.top, p.x, p.z, th)); T[k] = r; }
    }
    let f = a / (Math.PI * 2); f = (f - Math.floor(f)) * 2048;
    const k = Math.min(2047, Math.floor(f));
    return T[k] + (T[k + 1] - T[k]) * (f - k);
  }
  const ux = Math.cos(a), uz = Math.sin(a);
  let r = M.R;
  for (const c of M.lobes || []) {
    const cx = c.x - p.x, cz = c.z - p.z, b = ux * cx + uz * cz, q = c.r * c.r - (cx * cx + cz * cz) + b * b;
    if (q > 0) r = Math.max(r, b + Math.sqrt(q));
  }
  return r;
}

// ---- the talus blocks' shapes and turns (pure maths: world gen shapes every fallen block, the physics takes
// its points as a convex hull, terrain_talus.js draws them) -------------------------------------------------
// the unit icosphere subdivided once (42 points, 80 faces, wound outward)
const ICO = (() => {
  const t = (1 + Math.sqrt(5)) / 2;
  const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
  const F0 = [0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8, 3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1];
  const mid = new Map(), I = [];
  const m = (a, b) => { const k = a < b ? a * 64 + b : b * 64 + a; if (!mid.has(k)) { mid.set(k, V.length); V.push([(V[a][0] + V[b][0]) / 2, (V[a][1] + V[b][1]) / 2, (V[a][2] + V[b][2]) / 2]); } return mid.get(k); };
  for (let i = 0; i < F0.length; i += 3) {
    const a = F0[i], b = F0[i + 1], c = F0[i + 2], ab = m(a, b), bc = m(b, c), ca = m(c, a);
    I.push(a, ab, ca, ab, b, bc, ca, bc, c, ab, bc, ca);
  }
  const P = new Float64Array(V.length * 3);
  V.forEach((v, i) => { const l = Math.hypot(v[0], v[1], v[2]); P[i * 3] = v[0] / l; P[i * 3 + 1] = v[1] / l; P[i * 3 + 2] = v[2] / l; });
  return { P, I: Uint16Array.from(I) };
})();
// a fallen block, unit-ish (y up): the icosphere made lumpy, then cut by a flattened top and `cuts` random
// fracture planes (a point past a plane moves onto it)
function ballShape(r, cuts, lump) {
  const P = Float64Array.from(ICO.P);
  for (let i = 0; i < P.length; i += 3) { const k = 1 - lump / 2 + r() * lump; P[i] *= k; P[i + 1] *= k; P[i + 2] *= k; }
  const planes = [];
  { const nx = (r() - 0.5) * 0.25, nz = (r() - 0.5) * 0.25, l = Math.hypot(nx, 1, nz); planes.push([nx / l, 1 / l, nz / l, 0.5 + r() * 0.15]); }
  for (let k = 0; k < cuts; k++) { const a = r() * Math.PI * 2, e = (r() - 0.35) * 1.1; planes.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.55 + r() * 0.3]); }
  for (const [nx, ny, nz, d] of planes) for (let i = 0; i < P.length; i += 3) {
    const t = P[i] * nx + P[i + 1] * ny + P[i + 2] * nz;
    if (t > d) { P[i] += nx * (d - t); P[i + 1] += ny * (d - t); P[i + 2] += nz * (d - t); }
  }
  return { P, I: ICO.I };
}
// a cut granite slab, unit-ish (radius ~1 in x and z, y from -1 to its flat top at 0.5): an irregular n-sided
// outline, faces leaning out a little toward the top, a chamfer round the top edge, the top ring shifted a
// little; and the soft snow cap it wears (C: its points and faces), which the collider takes in too
function slabShape(r) {
  const n = 6 + Math.floor(r() * 3), ang = [], rad = [];
  for (let k = 0; k < n; k++) { ang.push((k + (r() - 0.5) * 0.7) / n * Math.PI * 2); rad.push(0.74 + r() * 0.36); }
  const ox = (r() - 0.5) * 0.12, oz = (r() - 0.5) * 0.12, cy = 0.27 + r() * 0.08;
  const rings = [[-1.0, 0.86, 0], [-0.3, 0.95, 0.4], [cy, 1.0, 0.8], [0.5, 0.82 - r() * 0.06, 1]];
  const jy = ang.map(() => (r() - 0.5) * 0.07);
  const P = [], I = [];
  for (let ri = 0; ri < rings.length; ri++) for (let k = 0; k < n; k++) {
    const [y, sc, sh] = rings[ri], rr = rad[k] * sc;
    P.push(Math.cos(ang[k]) * rr + ox * sh, y + (ri === 2 ? jy[k] : 0), Math.sin(ang[k]) * rr + oz * sh);
  }
  const T = rings.length - 1, top = P.length / 3, bot = top + 1;
  P.push(ox, 0.5, oz, 0, -1.0, 0);
  for (let ri = 0; ri < T; ri++) for (let k = 0; k < n; k++) {
    const a = ri * n + k, b = ri * n + (k + 1) % n, c = (ri + 1) * n + (k + 1) % n, d = (ri + 1) * n + k;
    I.push(a, c, b, a, d, c);
  }
  for (let k = 0; k < n; k++) { I.push(top, T * n + (k + 1) % n, T * n + k); I.push(bot, k, (k + 1) % n); }
  return { P: Float64Array.from(P), I: Uint16Array.from(I), C: capShape(r, { ang, rad, top: rings[T][1], ox, oz }) };
}
// the snow cap over a slab's top (its frame): it follows the outline, a little wider, so it hangs over the
// edge in a lip that droops further in places; a rounded crown
function capShape(r, S) {
  const n = S.ang.length, pts = [];
  for (let k = 0; k < n; k++) {
    const a0 = S.ang[k], a1 = S.ang[(k + 1) % n] + (k === n - 1 ? Math.PI * 2 : 0), r0 = S.rad[k], r1 = S.rad[(k + 1) % n];
    const x0 = Math.cos(a0) * r0, z0 = Math.sin(a0) * r0, x1 = Math.cos(a1) * r1, z1 = Math.sin(a1) * r1;
    for (let j = 0; j < 3; j++) pts.push([x0 + (x1 - x0) * j / 3, z0 + (z1 - z0) * j / 3, 1.04 + r() * 0.12, 0.07 + r() * r() * 0.3]);
  }
  const N = pts.length, P = [], I = [];
  for (const [sc, y] of [[0.78, 0.47], [-1, 0], [-2, 0.56], [0.9, 0.665], [0.55, 0.71]]) for (const [x, z, o, d] of pts) {
    if (sc === -1) P.push(x * o + S.ox, 0.5 - d, z * o + S.oz);                                  // (the lip's droop)
    else if (sc === -2) P.push(x * (o + 0.03) + S.ox, y + d * 0.15, z * (o + 0.03) + S.oz);      // (its rim)
    else P.push(x * sc * S.top / 0.82 + S.ox, y + (sc > 0.8 ? 0.02 * (o - 1.1) : 0), z * sc * S.top / 0.82 + S.oz);
  }
  for (let ri = 0; ri < 4; ri++) for (let k = 0; k < N; k++) { const a = ri * N + k, b = ri * N + (k + 1) % N, c = (ri + 1) * N + (k + 1) % N, d = (ri + 1) * N + k; I.push(a, c, b, a, d, c); }
  const ci = P.length / 3; P.push(S.ox, 0.73, S.oz);
  for (let k = 0; k < N; k++) I.push(ci, 4 * N + (k + 1) % N, 4 * N + k);
  return { P: Float64Array.from(P), I: Uint16Array.from(I) };
}
// quaternions [x, y, z, w] (three.js's conventions: Euler order XYZ; the turn taking +y onto (nx, 1, nz)
// normalised; a * b turns by b, then a)
function qEuler(x, y, z) {
  const c1 = Math.cos(x / 2), c2 = Math.cos(y / 2), c3 = Math.cos(z / 2), s1 = Math.sin(x / 2), s2 = Math.sin(y / 2), s3 = Math.sin(z / 2);
  return [s1 * c2 * c3 + c1 * s2 * s3, c1 * s2 * c3 - s1 * c2 * s3, c1 * c2 * s3 + s1 * s2 * c3, c1 * c2 * c3 - s1 * s2 * s3];
}
function qUp(nx, nz) {
  const l = Math.hypot(nx, 1, nz), x = nx / l, y = 1 / l, z = nz / l;
  const q = [z, 0, -x, 1 + y], m = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / m, q[1] / m, q[2] / m, q[3] / m];
}
function qMul(a, b) {
  return [a[0] * b[3] + a[3] * b[0] + a[1] * b[2] - a[2] * b[1], a[1] * b[3] + a[3] * b[1] + a[2] * b[0] - a[0] * b[2],
    a[2] * b[3] + a[3] * b[2] + a[0] * b[1] - a[1] * b[0], a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]];
}
function qRot(q, x, y, z) {
  const tx = 2 * (q[1] * z - q[2] * y), ty = 2 * (q[2] * x - q[0] * z), tz = 2 * (q[0] * y - q[1] * x);
  return [x + q[3] * tx + q[1] * tz - q[2] * ty, y + q[3] * ty + q[2] * tx - q[0] * tz, z + q[3] * tz + q[0] * ty - q[1] * tx];
}

// Is a world point inside a mud patch?
// Where a grumphorn walks off the road for good, from its bed at z (server/mobs.js LEAVE): the first flat
// ground off the road abreast of it or further on (in a canyon there's none beside it: past the narrows the
// walls open out), with a way to it straight out from the road that it can walk (no bank steeper than ~30
// degrees, nothing solid in the way). None within 45 m: the wall's foot, as far off the road as it goes.
// near: the nearest such ground to z either way along the road (a beast that can't get back to its own way
// off, say past the boulder). W needs heightAt, roadX, roadY, LEN, statics, cyls, hulls.
export function bedExit(W, z, near = false) {
  const solid = (x, zz) => W.statics.some(b => b.mat !== 'invisible' && Math.abs(b.x - x) < Math.max(b.hx, b.hz) + 1.1 && Math.abs(b.z - zz) < Math.max(b.hx, b.hz) + 1.1)
    || W.cyls.some(c => Math.hypot(c.x - x, c.z - zz) < c.r + 1.1) || W.hulls.some(c => Math.hypot(c.x - x, c.z - zz) < (c.r || 2) + 1.1);
  const flat = (x, zz, ref) => {
    const h = W.heightAt(x, zz);
    if (Math.abs(h - ref) > 1.5) return false;
    let sl = 0;
    for (const [dx, dz] of [[1.2, 0], [-1.2, 0], [0, 1.2], [0, -1.2]]) sl = Math.max(sl, Math.abs(W.heightAt(x + dx, zz + dz) - h) / 1.2);
    return sl <= 0.36;
  };
  // out from the road's edge to off m on side sd: every half metre no steeper than ~30 degrees, and clear
  const walk = (zz, sd, off) => {
    let h0 = W.heightAt(W.roadX(zz) + sd * 3, zz);
    for (let k = 3.5; k <= off + 0.01; k += 0.5) {
      const x = W.roadX(zz) + sd * k, h = W.heightAt(x, zz);
      if (Math.abs(h - h0) > 0.3 || solid(x, zz)) return false;
      h0 = h;
    }
    return true;
  };
  for (const dz of near ? [0, 4, -4, 8, -8, 13, -13, 19, -19, 26, -26] : [6, 10, 15, 21, 28, 36, 45]) {
    const ez = z + dz;
    if (ez > W.LEN - 40) { if (near) continue; break; }   // (never into town)
    for (const off of [8, 9, 7.5, 10, 12, 16, 22]) for (const sd of [1, -1]) {
      const ex = W.roadX(ez) + sd * off;
      if (flat(ex, ez, W.roadY(ez)) && walk(ez, sd, off)) return { x: ex, y: W.heightAt(ex, ez), z: ez };
    }
  }
  // the wall's foot: as far off the road as it can walk, beside its bed
  const ez = z + (near ? 0 : 6);
  let best = { off: 5, sd: 1 };
  for (const sd of [1, -1]) for (let off = 5; off <= 22; off += 0.5) { if (!walk(ez, sd, off)) break; if (off > best.off) best = { off, sd }; }
  const ex = W.roadX(ez) + best.sd * best.off;
  return { x: ex, y: W.heightAt(ex, ez), z: ez };
}

export function inMud(W, x, z) {
  for (const m of W.mud) {
    if (z >= m.z0 && z <= m.z1 && Math.abs(x - W.roadX(z)) < m.hw) return true;
  }
  return false;
}
