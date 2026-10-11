// The crash mesas' bodies (part of the terrain art pass). World gen makes each crash mesa a butte of
// solid cylinders in W.cyls with mat 'mesa': the main tier (its body plus one or two lobe cylinders at the
// same height, each holding the centre, so their union is star-shaped about it: butteRadius), flat-topped
// where the wreck and its loot lie, and a lower bench tier on one end, seen side-on from the road; it
// stands on a talus mound in the heightfield. Here each is drawn as natural rock fitted to its colliders'
// outline (the main tier's: the union, arcs of its circles meeting in concave cusps), never as a drum:
//   - the wall: the biome's own valley-wall rock (cliff_<biome>) wrapped round the outline by arc length
//     a whole number of tiles (no stretch on a lobe, the seam in a cusp's cleft). It is a stack of beds,
//     each an irregular polygon of flat faces (its own tone each) stepping in or out a little over the
//     one below (a ledge, a shadow; now and then a soft bed set back); every cusp is a corner of every
//     bed, so no face fills the re-entrant; vertical joints cut it into pillars (dark clefts, some
//     notching the cap), and a cleft runs the whole height of every cusp, where two masses (the body, a
//     lobe: each a bastion of the same rock, weathered a little differently, the beds running on across)
//     meet; between two other joints that run its whole height the blocks settled on their own (the
//     beds jog up or down, so no band runs round unbroken); the painting's own relief (its lit masses
//     stand out, its seams sink back) and a slight batter on top. All of it stays within [WALL_IN,
//     WALL_OUT] of the outline's radius (a cusp is rounded by at most CUSP_K / 4 and cut back by its
//     cleft), so a climber hugs the rock. The shader weathers it: desert varnish and rain streaks down
//     from the rim, the cap bed's own tint, AO in the joints and under the ledges;
//   - the foot: below ~1.5 m the rock flares out onto the mound in buttresses (broadest under each lobe;
//     clear of the road's ditch), and a bank laps up it (drifted sand or snow, deepest on the side world
//     gen's wind comes from, or the terrain's scree), so no clean circle meets the ground;
//     terrain_talus.js heaps fallen blocks on it;
//   - the caprock: a thick hard top bed, a polygon of its own split into blocks at the joints (each its
//     own thickness, overhang and tone), standing out 0.03-LIP past the outline over a cool undercut (only
//     where it stands well above head height), its edge rounded over, notched where joints reach it (a V
//     at every cusp) and broken back where a piece of it fell (its slabs lie on the talus below); the
//     walkable top inside the outline is exactly flat at the colliders' top, lobes and all;
//   - the cover: turf, golden grass, snow (on the ledges too), red dust or drifted sand on whatever faces
//     up, and hanging a little way over the rim (Dun Morogh: a snow cornice);
//   - the bench: a lower step of the same rock round the main tier's end, its cap overhanging only where
//     it stands well above head height.
// Everything (both tiers of every butte on the leg, their banks and their talus) is one mesh with one
// material: one draw call a day.
//
//   buildButtes(W, { form, macro, scree, tint }) -> { mesh, dispose() } | null   (null: no crash mesas)
//   butteForms(W) -> [{ p, main, bench, roadA, bank, inside }]   the shapes (pure maths), for the talus,
//     the terrain and the crash (each tier: Rb(th) its outline's radius along a bearing from its centre)
//   butteGeometry(W, { tint }) -> BufferGeometry   the merged mesh alone (userData.tiers: each tier's
//     vertex range), for a fit check
//   butteGround(W, p) -> (x, z) => y   the drawn top of p's butte where it stands (its rounded rim,
//     a sheer drop past the lip), else the ground: what the wreck's dressing drapes over
//   bankAt(F, x, z) -> m   how deep the bank lies over the heightfield at (x, z)
import { THREE, tex } from './gfx.js';
import { canvasFor } from './paint/index.js';
import { talusInto } from './terrain_talus.js';
import { butteRadius } from '/shared/world.js';

const TAU = Math.PI * 2;
const clamp01 = v => Math.max(0, Math.min(1, v));
const sstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
export function rng32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// a smooth periodic function of the bearing, about -1..1
function periodicA(rnd, k0, k1, fall = 1) {
  const T = []; let norm = 0;
  for (let k = k0; k <= k1; k++) { const a = (0.5 + rnd()) / Math.pow(k, fall); T.push([k, rnd() * TAU, a]); norm += a; }
  return th => { let v = 0; for (const [k, p, a] of T) v += Math.sin(k * th + p) * a; return Math.max(-1, Math.min(1, v / norm * 1.7)); };
}
// the wall's offset from the outline's radius kept inside [lo, hi], smoothly (never a flat clipped band)
const softClamp = (f, lo, hi) => { const c = (lo + hi) / 2, w = (hi - lo) / 2; return c + w * Math.tanh((f - c) / w); };

// The wall stays within [IN, OUT] of the colliders' outline (the main tier: its body and lobes' union)
// from ~1.5 m above the ground to the cap; the cap's edge stands 0.03 to LIP past it; the main tier's
// wall is left out where the bench stands round it by more than SHORT_IN (it starts on the bench's top
// there).
export const WALL_IN = -0.345, WALL_OUT = 0.1, LIP = 0.41;   // (the cap's face swells up to 0.02 more, to 0.43; a face between two columns lies a few mm in)
const SHORT_IN = 0.45, ARC_B = 1.75;   // (the bench's wall: +-100 degrees round its far end; the rest lies in the main body)

// Per biome: the rock (texture, metres a tile; snow: the walls' granite turned 26.6 degrees, 7.96 m a tile,
// as the valley walls' second sample), the cover on top (texture, metres a tile), what laps up the foot
// (the scree the terrain paints round it), the cap's thickness [min, max], the lip's overhang [min, max],
// how strongly the painting's own relief shapes the wall (m), the foot's flare [base, buttress] (m),
// how far the cover hangs over a rim [m, wander], the cover on what faces up [from n.y, to n.y, noise,
// most]; tints (linear): the rock, the caprock's own bed (rgb, how much: paler in the strata, darker
// and varnished on Tanaris' sandstone), the AO's darkest (cool), the foot's buried shade; the bank at the
// foot [m, more upwind, wander, scree (1) or cover (0)]; broad weathering patches (rgb); varnish streaks
// (how dark); bed: how much of the painting's bed contrast the wall keeps (Tanaris' cream hard beds,
// wrapped round a lone butte, read as a layer cake at full strength); moss: the fallen blocks' cover in
// patches, not over every top. (What laps up the foot is the scree the terrain paints round it: buildButtes'
// `scree`, from terrain3d.)
const STYLE = {
  meadow: { rock: 'cliff_meadow', tile: 15, cover: 'ground_meadow', ctile: 7,
    capT: [0.75, 1.05], ov: [0.12, 0.36], rel: 0.11, flare: [0.3, 0.8], streak: 0.12, lip: [0.26, 0.16], cov: [0.5, 0.74, 0.5, 1.0],
    tint: [1.0, 1.0, 0.98], bank: [0.35, 0.12, 0.25, 1], weather: [0.84, 0.9, 0.8], cap: [0.62, 0.6, 0.56, 0.0], ao: [0.5, 0.54, 0.64], buried: [0.66, 0.66, 0.68],  lift: 0, moss: 1 },
  fields: { rock: 'cliff_fields', tile: 15, cover: 'ground_fields', ctile: 7,
    capT: [0.85, 1.15], ov: [0.14, 0.4], rel: 0.1, flare: [0.3, 0.8], streak: 0.16, lip: [0.2, 0.12], cov: [0.52, 0.76, 0.45, 1.0],
    tint: [1.0, 0.99, 0.96], bank: [0.4, 0.15, 0.25, 1], weather: [0.84, 0.78, 0.7], cap: [0.84, 0.72, 0.52, 0.4], ao: [0.52, 0.5, 0.58], buried: [0.7, 0.66, 0.64],  lift: 0, moss: 1 },
  snow: { rock: 'cliff_snow', tile: 7.96, turn: true, form: true, cover: 'ground_snow', ctile: 8,
    capT: [0.8, 1.1], ov: [0.15, 0.4], rel: 0.1, flare: [0.3, 0.8], streak: 0.1, lip: [0.5, 0.28], cov: [0.22, 0.42, 0.45, 1.0],
    tint: [1.06, 1.07, 1.1], bank: [0.45, 0.6, 0.3, 0], weather: [0.86, 0.88, 0.95], cap: [0.7, 0.72, 0.78, 0.0], ao: [0.5, 0.56, 0.72], buried: [0.8, 0.84, 0.94],  lift: 1 },
  badlands: { rock: 'cliff_badlands', tile: 17, cover: 'ground_badlands', ctile: 7,
    capT: [1.1, 1.5], ov: [0.2, 0.43], rel: 0.09, flare: [0.3, 0.8], streak: 0.3, lip: [0.08, 0.06], cov: [0.72, 0.9, 0.35, 0.85],
    tint: [1.0, 1.0, 1.0], bank: [0.45, 0.2, 0.3, 1], weather: [0.78, 0.66, 0.66], cap: [0.88, 0.66, 0.5, 0.6], ao: [0.5, 0.36, 0.42], buried: [0.72, 0.6, 0.58],  lift: 0 },
  desert: { rock: 'cliff_desert', tile: 16, cover: 'ground_desert', ctile: 8,
    capT: [1.2, 1.6], ov: [0.22, 0.44], rel: 0.08, flare: [0.3, 0.8], streak: 0.36, lip: [0.12, 0.08], cov: [0.7, 0.88, 0.35, 0.95],
    tint: [1.02, 1.0, 0.97], bank: [0.5, 0.65, 0.3, 0], weather: [0.8, 0.7, 0.66], cap: [0.41, 0.23, 0.125, 0.42], ao: [0.54, 0.42, 0.44], buried: [0.74, 0.66, 0.62],  lift: 0, bed: 0.62 },
};
export const butteStyle = biome => STYLE[biome] || STYLE.meadow;

// ---- the painting's own relief ----------------------------------------------------------------------
// The rock texture's luminance (snow: its form map's height), blurred over ~0.25 m and normalised to
// about -1..1: the lit masses, hard beds and blocks of the painting stand out, its dark seams, soft
// beds and undercuts sink back. Sampled at the wall's own texture coordinates, so the relief and the
// painting agree.
const RELIEF = new Map();
function boxBlur(A, w, h, r, passes) {
  let src = A, dst = new Float32Array(A.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + ((k % w) + w) % w];
      for (let x = 0; x < w; x++) { dst[y * w + x] = s / (2 * r + 1); s += src[y * w + (x + r + 1) % w] - src[y * w + ((x - r) % w + w) % w]; }
    }
    [src, dst] = [dst, src];
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[(((k % h) + h) % h) * w + x];
      for (let y = 0; y < h; y++) { dst[y * w + x] = s / (2 * r + 1); s += src[((y + r + 1) % h) * w + x] - src[(((y - r) % h + h) % h) * w + x]; }
    }
    [src, dst] = [dst, src];
  }
  return src;
}
function reliefMap(name, channel = -1) {
  const key = name + '|' + channel;
  if (RELIEF.has(key)) return RELIEF.get(key);
  let fn = () => 0;
  try {
    const cv = canvasFor(name), w = cv.width, h = cv.height;
    const d = cv.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
    let A = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) A[i] = channel < 0 ? (0.3 * d[i * 4] + 0.55 * d[i * 4 + 1] + 0.15 * d[i * 4 + 2]) / 255 : d[i * 4 + channel] / 255;
    A = boxBlur(A, w, h, Math.max(1, Math.round(w / 512 * 4)), 2);
    let m = 0; for (let i = 0; i < A.length; i++) m += A[i]; m /= A.length;
    let s = 0; for (let i = 0; i < A.length; i++) s += (A[i] - m) ** 2; s = Math.sqrt(s / A.length) || 1;
    for (let i = 0; i < A.length; i++) A[i] = Math.max(-1, Math.min(1, (A[i] - m) / (2.2 * s)));
    // (u, v) in tiles; v up (a canvas texture is flipped: its top row is v = 1)
    fn = (u, v) => {
      const fx = (u - Math.floor(u)) * w - 0.5, fy = (1 - (v - Math.floor(v))) * h - 0.5;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
      const X0 = ((x0 % w) + w) % w, X1 = (X0 + 1) % w, Y0 = ((y0 % h) + h) % h, Y1 = (Y0 + 1) % h;
      return (A[Y0 * w + X0] * (1 - tx) + A[Y0 * w + X1] * tx) * (1 - ty) + (A[Y1 * w + X0] * (1 - tx) + A[Y1 * w + X1] * tx) * ty;
    };
  } catch (e) { fn = () => 0; }
  RELIEF.set(key, fn);
  return fn;
}
// the wall's texture coordinate (in tiles) at arc length u and height y, as the shader takes it
const TURN = [0.894427, 0.447214];
function texUV(S, u, y) {
  if (S.turn) return [(TURN[0] * u - TURN[1] * y) / S.tile + 0.31, (TURN[1] * u + TURN[0] * y) / S.tile + 0.11];
  return [u / S.tile, y / S.tile];
}

// ---- the outline -------------------------------------------------------------------------------------
// A tier's foot round its centre, one radius per bearing. The main tier's is the union of world gen's
// body cylinder and its lobes: each lobe holds the centre, so the union is star-shaped about it
// (butteRadius gives its radius along a bearing), its boundary arcs of those circles meeting in concave
// cusps. The bench's is its own circle, along the arc that stands clear of the main body. The wall's own
// coordinate is the arc length s round it from t0 (the main tier: from a cusp, so the seam hides in the
// cleft there).
//   Rb(th)       the exact radius there (the colliders')
//   fill(th)     how far the drawn wall's rounding of a cusp stands out past it (<= CUSP_K / 4)
//   s(th, raw)   the arc length from t0 (raw: th already in [t0, t0 + a turn], as the mesh's columns are)
//   th(s)        its inverse; perim: the length round it (the bench: along its arc)
//   segs         [{ s0, s1, rho, lobe }]: the arcs between cusps, each its circle's radius (a lobe's or
//                the body's); cusps: [bearing]
//   arcD(th, a)  how far apart two bearings lie along it (m); sArc: the same, signed (th past a: > 0)
const OL_N = 2048, CUSP_K = 0.28;
function mainOutline(p) {
  const M = p.mesa, C = [{ x: 0, z: 0, r: M.R ?? M.r }, ...(M.lobes || []).map(c => ({ x: c.x - p.x, z: c.z - p.z, r: c.r }))];
  // how far out along th the ray from the centre leaves each circle (each holds the centre)
  const exits = th => {
    const ux = Math.cos(th), uz = Math.sin(th);
    return C.map(c => { const b = ux * c.x + uz * c.z, q = c.r * c.r - (c.x * c.x + c.z * c.z) + b * b; return q > 0 ? b + Math.sqrt(q) : -1e9; });
  };
  const own = th => { const e = exits(th); let k = 0; for (let i = 1; i < e.length; i++) if (e[i] > e[k]) k = i; return k; };
  // the cusps: where the boundary passes from one circle to the next (a fine scan, then bisection)
  const cusps = [];
  let prev = own(0);
  for (let k = 1; k <= 1440; k++) {
    const b1 = k / 1440 * TAU, o = own(b1);
    if (o === prev) continue;
    let a = (k - 1) / 1440 * TAU, b = b1;
    for (let it = 0; it < 30; it++) { const m = (a + b) / 2; if (own(m) === prev) a = m; else b = m; }
    cusps.push((a + b) / 2);
    prev = o;
  }
  const t0 = cusps.length ? cusps[0] : 0;
  const Rb = th => butteRadius(p, th);
  // the arc-length table, from t0 once round
  const S = new Float64Array(OL_N + 1);
  let px = Math.cos(t0) * Rb(t0), pz = Math.sin(t0) * Rb(t0);
  for (let k = 1; k <= OL_N; k++) {
    const th = t0 + k / OL_N * TAU, r = Rb(th), x = Math.cos(th) * r, z = Math.sin(th) * r;
    S[k] = S[k - 1] + Math.hypot(x - px, z - pz); px = x; pz = z;
  }
  const perim = S[OL_N];
  const s = (th, raw = false) => {
    let t = th - t0;
    if (!raw) t = ((t % TAU) + TAU) % TAU;
    const f = Math.max(0, Math.min(OL_N, t / TAU * OL_N)), k = Math.min(OL_N - 1, Math.floor(f));
    return S[k] + (S[k + 1] - S[k]) * (f - k);
  };
  const thOf = sv => {
    sv = ((sv % perim) + perim) % perim;
    let lo = 0, hi = OL_N;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m] <= sv) lo = m; else hi = m; }
    return t0 + (lo + (sv - S[lo]) / Math.max(1e-9, S[lo + 1] - S[lo])) / OL_N * TAU;
  };
  // the arcs between the cusps (none: the body's own circle, no lobe standing out past it)
  const cs = cusps.map(a => s(a));
  const segs = cusps.length ? cs.map((s0, i) => { const s1 = i + 1 < cs.length ? cs[i + 1] : perim, o = own(thOf((s0 + s1) / 2)); return { s0, s1, rho: C[o].r, lobe: o > 0 }; })
    : [{ s0: 0, s1: perim, rho: C[0].r, lobe: false }];
  // a cusp rounded: the smooth maximum of the two circles' radii there (it fills the V by <= CUSP_K / 4)
  const fill = th => {
    if (!cusps.length) return 0;
    const e = exits(th).sort((a, b) => b - a), h = Math.max(0, CUSP_K - (e[0] - e[1])) / CUSP_K;
    return h * h * CUSP_K / 4;
  };
  const sArc = (th, a) => { let d = s(th) - s(a); d -= perim * Math.round(d / perim); return d; };
  let area = 0; for (let k = 0; k < 360; k++) area += 0.5 * Rb(k / 360 * TAU) ** 2 * TAU / 360;
  return { ring: true, t0, span: TAU, Rb, fill, s, th: thOf, perim, segs, cusps, sArc, arcD: (th, a) => Math.abs(sArc(th, a)), area, inArc: th => th, circles: C };
}
// the bench: its circle, along the arc round its far end (mid +- half)
function arcOutline(R, mid, half) {
  const a0 = mid - half, perim = 2 * half * R;
  const inArc = th => mid + Math.atan2(Math.sin(th - mid), Math.cos(th - mid));
  const sArc = (th, a) => (inArc(th) - inArc(a)) * R;
  return { ring: false, t0: a0, span: 2 * half, Rb: () => R, fill: () => 0, s: th => (inArc(th) - a0) * R, th: sv => a0 + sv / R, perim,
    segs: [{ s0: 0, s1: perim, rho: R }], cusps: [], sArc, arcD: (th, a) => Math.abs(sArc(th, a)), area: Math.PI * R * R, inArc };
}

// ---- the shapes -------------------------------------------------------------------------------------

// One tier: a body standing on its colliders (centre cx, cz; top yT; outline OL). Its wall offset
// wall(th, y) from the outline's radius, the cap's overhang ov(th), thickness capT(th), the undercut's
// height ucH(th) and depth ucD(th), the foot's flare flare(th) and height hF(th), joints and broken
// notches, the wall's texture coordinate U(th).
function bodyForm(W, S, rnd, o) {
  const { cx, cz, R, yT, kind, roadA, OL } = o;
  const main = kind === 'main';
  const B = { cx, cz, R, yT, kind, OL, Rb: OL.Rb };
  const Rb = OL.Rb;
  const g = (th, r) => W.heightAt(cx + Math.cos(th) * r, cz + Math.sin(th) * r);
  B.g = g;
  // the bench's wall runs round its far end only (the rest lies inside the main body)
  B.arc = main ? null : [OL.t0, OL.t0 + OL.span];
  // (a bearing as the bench's arc counts it: within half a turn of its middle, whatever atan2 gave)
  B.inArc = OL.inArc;
  // the texture wraps a whole number of tiles round the main tier (no seam); the bench's open arc keeps
  // its true scale. U: the wall's own coordinate along it (m)
  let uK = 1;
  if (main) {
    const P = OL.perim;
    if (S.turn) uK = Math.max(1, Math.round(P * TURN[1] / S.tile)) * S.tile / TURN[1] / P;
    else uK = Math.max(1, Math.round(P / S.tile)) * S.tile / P;
  }
  B.U = (th, raw = false) => (main ? OL.s(th, raw) * uK : OL.s(th) + OL.t0 * R);
  // the mean ground round it
  let gm = 0; for (let k = 0; k < 16; k++) { const th = k / 16 * TAU; gm += g(th, Rb(th) + 0.3); } gm /= 16;
  B.gm = gm;
  // headroom: a cap may overhang only well above head height (the bench can be low)
  B.head = th => sstep(2.4, 3.4, yT - g(th, Rb(th) + 0.3));
  const capN = periodicA(rnd, 2, 7, 0.9), ucN = periodicA(rnd, 3, 8, 0.8), buttP = periodicA(rnd, 3, 7, 0.6);
  // The plan: the wall is a stack of beds, each an irregular polygon of flat rock faces (~3-5 m across, its
  // corners a hair outside the outline, the faces' middles ~0.25 m in) turned its own way, so the wall
  // breaks into lit and shaded faces like stacked blocks of jointed rock (each bed stepping in or out a
  // little over the one under it: a ledge, a shadow), never a turned drum. Every cusp of the outline is a
  // corner of every bed (no face spans a re-entrant, so none fills it), and the faces along each arc are
  // as long as its circle allows for that ~0.3 m. The cap is a polygon too, standing out past the top
  // bed's corners by its own amount at each. Joints: clefts that cut the wall into pillars (some its whole
  // height, notching the cap, some down from the cap, a few up from the foot), and one in every cusp.
  const polygon = (oIn, oOut) => {
    const SS = [];
    for (const sg of OL.segs) {
      const len = sg.s1 - sg.s0;
      const n = Math.max(OL.ring ? (OL.cusps.length ? 1 : 7) : 3, Math.round(len / Math.sqrt(2.4 * sg.rho)));
      const wts = []; for (let k = 0; k < n; k++) wts.push(0.62 + rnd() * 0.76);
      const wsum = wts.reduce((p, q) => p + q, 0);
      // (a ring with no cusp: its first corner anywhere round it; otherwise a corner on each cusp)
      let sv = sg.s0 + (OL.ring && !OL.cusps.length ? rnd() * len : 0);
      for (let k = 0; k < n; k++) { SS.push(sv); sv += wts[k] / wsum * len; }
      if (!OL.ring) SS.push(sg.s1);                       // (the bench's arc: a corner at each end)
    }
    let CA = SS.map(sv => OL.th(sv));
    if (OL.ring) { const c0 = CA[0]; CA = CA.map(a => c0 + (((a - c0) % TAU) + TAU) % TAU).sort((p, q) => p - q); }
    const nF = OL.ring ? CA.length : CA.length - 1;
    const CR = CA.map(a => Rb(a) + lerp(oIn, oOut, rnd())), TN = CA.map(() => 0.93 + rnd() * 0.14);
    if (OL.ring) { CA.push(CA[0] + TAU); CR.push(CR[0]); TN.push(TN[0]); }   // (closed: the last corner is the first, a turn on)
    const face = th => {
      const t = OL.ring ? ((th - CA[0]) % TAU + TAU) % TAU + CA[0] : Math.max(CA[0], Math.min(CA[nF], OL.inArc(th)));
      let k = 0; while (k < nF - 1 && t >= CA[k + 1]) k++;
      return [k, t];
    };
    // the polygon at bearing th (each face a chord, in polar form)
    const at = th => {
      const [k, t] = face(th), a0 = CA[k], a1 = CA[k + 1], r0 = CR[k], r1 = CR[k + 1];
      return r0 * r1 * Math.sin(a1 - a0) / (r0 * Math.sin(t - a0) + r1 * Math.sin(a1 - t));
    };
    // (each face its own tone, +-7%: the faces read as separate planes of rock even in flat light)
    const tone = th => TN[face(th)[0]];
    return { CA, CR, at, tone, corners: OL.ring ? CA.slice(0, nF) : CA.slice() };
  };
  // the beds, from the foot to the cap, 1.6-3.4 m each (the lowest runs down into the ground)
  const H = yT - gm, yCapLo = yT - S.capT[1] - 0.6, beds = [];
  for (let y = gm + 1.2 + rnd() * 1.4; y < yCapLo - 1.0; y += 1.6 + rnd() * 1.8) beds.push(y);
  // (a soft bed, now and then, stands back ~0.1 m under the harder one over it: a ledge and its shadow)
  B.beds = [-1e9, ...beds, 1e9].map((y0, k, A) => { if (k >= A.length - 1) return null; const o = k > 0 && rnd() < 0.45 ? -0.1 : 0; return { y0, y1: A[k + 1], P: polygon(0.05 + o, 0.11 + o) }; }).filter(Boolean);
  const capP = polygon(Math.max(0.26, S.ov[0]), S.ov[1]);
  B.corners = [...new Set(B.beds.flatMap(b => b.P.corners).concat(capP.corners))];
  B.plan = (th, y) => {
    let k = 0; while (k < B.beds.length - 1 && y > B.beds[k].y1) k++;
    const b = B.beds[k], r0 = Rb(th), v = b.P.at(th) - r0;
    // (a soft step, 0.3 m, into the bed above or below)
    if (k + 1 < B.beds.length && y > b.y1 - 0.15) return lerp(v, B.beds[k + 1].P.at(th) - r0, sstep(b.y1 - 0.15, b.y1 + 0.15, y));
    if (k > 0 && y < b.y0 + 0.15) return lerp(B.beds[k - 1].P.at(th) - r0, v, sstep(b.y0 - 0.15, b.y0 + 0.15, y));
    return v;
  };
  B.tone = (th, y) => { let k = 0; while (k < B.beds.length - 1 && y > B.beds[k].y1) k++; return B.beds[k].P.tone(th); };
  B.capTone = th => capP.tone(th) * cbC(th);
  const J = [];
  const P = OL.perim;
  const nJ = Math.max(B.arc ? 2 : 5, Math.round(P / (3.8 + rnd() * 2.2)));
  const js0 = rnd() * P;
  for (let k = 0; k < nJ; k++) {
    const f = (k + 0.5 + (rnd() - 0.5) * 0.6) / nJ, a = OL.th(OL.ring ? js0 + f * P : lerp(0.25 * R, P - 0.25 * R, f));
    const q = rnd(), full = q < 0.55, top = q >= 0.55 && q < 0.85;
    const j = { a, w: 0.26 + rnd() * 0.26, d: 0.2 + rnd() * 0.14,
      y0: full || top ? (full ? -1e9 : yT - H * (0.35 + rnd() * 0.35)) : -1e9,
      y1: full || top ? 1e9 : gm + H * (0.3 + rnd() * 0.3), cap: full || top };
    // (none crowding a cusp: the cusp has its own)
    if (!OL.cusps.some(c => OL.arcD(a, c) < 1.2)) J.push(j);
  }
  // a cleft in every cusp, where two of the butte's masses meet: the whole height, through the cap (the
  // beds run on across it: no fault there)
  // (a broad gully, the deepest and darkest of them: erosion works hardest in a re-entrant)
  for (const c of OL.cusps) J.push({ a: c, w: 0.55 + rnd() * 0.3, d: 0.3 + rnd() * 0.05, y0: -1e9, y1: 1e9, cap: true, cusp: true, dark: 0.86 });
  B.joints = J;
  // A value of its own for each block of rock between two joints (Js), blended across each joint's cleft
  // (the step hides in it); the bench's arc: arcV before its first joint
  const bySeg = (Js, vals, arcV) => {
    const L = Js.map((j, i) => ({ s: OL.s(j.a), w: j.w, v: vals[i] })).sort((p, q) => p.s - q.s), n = L.length;
    const val = i => (OL.ring ? L[(i + n) % n].v : (i < 0 ? arcV : L[i].v));
    return th => {
      if (!n) return arcV;
      if (OL.ring && n < 2) return L[0].v;
      const sv = OL.s(th);
      for (let i = 0; i < n; i++) {
        let d = sv - L[i].s;
        if (OL.ring) d -= P * Math.round(d / P);
        const w = L[i].w * 0.6;
        if (Math.abs(d) < w) return lerp(val(i - 1), val(i), sstep(-w, w, d));
      }
      let k = OL.ring ? n - 1 : -1;
      for (let i = 0; i < n; i++) if (sv >= L[i].s) k = i;
      return val(k);
    };
  };
  // each of the butte's masses (the body, each lobe: between two cusps) weathered a little differently
  const cuspJ = J.filter(j => j.cusp);
  B.massTone = bySeg(cuspJ, cuspJ.map(() => 0.92 + rnd() * 0.16), 1);
  // Faults: between two joints that run the wall's whole height its blocks settled on their own, the beds
  // a little higher or lower (+-0.4 m), so no band runs round the butte unbroken
  const fulls = J.filter(j => j.y0 < -1e8 && j.y1 > 1e8 && !j.cusp);
  B.vOff = bySeg(fulls, fulls.map(() => (rnd() - 0.5) * 0.8), (rnd() - 0.5) * 0.8);
  // The cap is blocks too, split by the joints that reach it: each its own thickness (its underside steps
  // +-0.2 m at a cleft), overhang (x0.7-1.1) and tone, so it never reads as one turned lid
  const capJ = J.filter(j => j.cap);
  const cbT = bySeg(capJ, capJ.map(() => (rnd() - 0.5) * 0.4), (rnd() - 0.5) * 0.4);
  const cbO = bySeg(capJ, capJ.map(() => 0.7 + rnd() * 0.4), 0.7 + rnd() * 0.4);
  const cbC = bySeg(capJ, capJ.map(() => 0.9 + rnd() * 0.18), 0.9 + rnd() * 0.18);
  // one or two places where a piece of the cap broke away (its slabs lie on the talus below), never on
  // the side facing the road (the wreck's gas bag hangs over that lip)
  const notch = [];
  const nN = main ? 1 + (rnd() < 0.55 ? 1 : 0) : (rnd() < 0.45 ? 1 : 0);
  for (let k = 0; k < nN; k++) for (let t = 0; t < 16; t++) {
    const a = B.arc ? lerp(B.arc[0] + 0.5, B.arc[1] - 0.5, rnd()) : rnd() * TAU;
    if (angDiff(a, roadA) < 1.25 || notch.some(n => angDiff(n.a, a) < 1.3)) continue;
    notch.push({ a, w: 0.8 + rnd() * 0.9, k: 0.75 + rnd() * 0.25 });
    break;
  }
  B.notches = notch;
  // the buttresses at the foot: three to five spurs (w: m along the outline)
  const spurs = [];
  const nS = main ? 3 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < nS; k++) spurs.push({ a: B.arc ? lerp(B.arc[0] + 0.4, B.arc[1] - 0.4, rnd()) : rnd() * TAU, w: (0.25 + rnd() * 0.25) * R, k: 0.6 + rnd() * 0.6 });
  // (and a broad one under the middle of each lobe: a bastion's foot)
  for (const sg of OL.segs) if (sg.lobe) spurs.push({ a: OL.th((sg.s0 + sg.s1) / 2), w: Math.min(3.2, 0.4 * (sg.s1 - sg.s0)), k: 0.8 + rnd() * 0.4 });
  const spurAt = th => { let sp = 0; for (const s of spurs) sp = Math.max(sp, s.k * (1 - sstep(s.w * 0.4, s.w, OL.arcD(th, s.a)))); return sp; };
  // how deep in a joint (0..1) at (th, y), how far it cuts (m), and how dark its shade is there
  const jointAt = (th, y) => {
    let best = 0, cut = 0, dark = 0;
    for (const j of J) {
      const s = OL.arcD(th, j.a);
      if (s > j.w * 1.2) continue;
      const across = 1 - sstep(j.w * 0.3, j.w, s);
      const along = sstep(j.y0 - 0.7, j.y0 + 0.5, y) * (1 - sstep(j.y1 - 0.5, j.y1 + 0.7, y));
      const k = across * along;
      if (k > best) { best = k; cut = j.d * k; dark = (j.dark || 0.74) * k; }
    }
    return [best, cut, dark];
  };
  B.joint = jointAt;
  const notchAt = th => { let k = 0; for (const n of notch) k = Math.max(k, n.k * (1 - sstep(n.w * 0.55, n.w, OL.arcD(th, n.a)))); return k; };
  B.notch = notchAt;
  const relief = S.form ? reliefMap('cliff_snow_form', 1) : reliefMap(S.rock);
  const yU0 = yT - (S.capT[0] + S.capT[1]) / 2 - 0.4;
  B.wall = (th, y) => {
    const t = clamp01((y - gm - 1.2) / Math.max(1, yU0 - gm - 1.2));
    let f = 0.03 - 0.1 * t + OL.fill(th);                         // a slight batter; a cusp rounded
    f += B.plan(th, y);
    const [tu, tv] = texUV(S, B.U(th), y + B.vOff(th));
    f += S.rel * relief(tu, tv);
    f -= jointAt(th, y)[1];
    return softClamp(f, WALL_IN, WALL_OUT);
  };
  B.ov = th => {
    let v = capP.at(th) - Rb(th);
    for (const j of J) if (j.cap) { const s = OL.arcD(th, j.a); if (s < j.w * 1.4) v -= (0.6 + j.d * 2) * (1 - sstep(j.w * 0.3, j.w * 1.4, s)) * 0.3; }
    v = lerp(v * cbO(th), 0.03, notchAt(th));
    return Math.max(0.03, Math.min(LIP, v * (main ? (B.overK ? B.overK(th) : 1) : B.head(th))));
  };
  B.capT = th => {
    let t = (lerp(S.capT[0], S.capT[1], 0.5 + 0.5 * capN(th)) + cbT(th)) * (main ? 1 : 0.75);
    t *= 1 - 0.45 * notchAt(th);
    if (!main) t = Math.min(t, Math.max(0.35, yT - g(th, Rb(th) + 0.3) - 2.3));
    return t;
  };
  B.ucH = th => (0.3 + 0.25 * (0.5 + 0.5 * ucN(th))) * (main ? 1 : 0.4 + 0.6 * B.head(th));
  B.ucD = th => (main ? 0.06 + 0.27 * (B.overK ? B.overK(th) : 1) : 0.06 + 0.27 * B.head(th)) * (1 - 0.6 * notchAt(th));
  // (the road's distance from the foot at a bearing)
  const roadD = th => { const r = Rb(th), x = cx + Math.cos(th) * r, z = cz + Math.sin(th) * r; return Math.abs(x - W.roadX(z)); };
  B.flare = th => {
    let F = S.flare[0] * (0.75 + 0.25 * buttP(th)) + S.flare[1] * spurAt(th);
    // never into the road's ditch: the foot keeps 6.9 m from the road's centre line
    F = Math.min(F, Math.max(0.05, roadD(th) - 6.9));
    // (and none where the main body's wall runs into the bench: its foot is the bench's there)
    return B.benchIn ? F * (1 - sstep(-1.6, 0.2, B.benchIn(th))) : F;
  };
  // the bank lapping up the foot: drifted sand or snow (deepest on the side the wind comes from: world gen's
  // WIND, 0.62 rad) or the scree; up to ~1.35 m against the wall, out 2.2-5 m onto the mound, none where
  // the road's ditch is near or the bench stands round the wall
  const bankN = periodicA(rnd, 3, 9, 0.7), reachN = periodicA(rnd, 2, 6, 0.8);
  B.bankH = th => {
    const up = Math.max(0, -(Math.cos(th) * 0.58104 + Math.sin(th) * 0.81388));
    let h = S.bank[0] + S.bank[1] * up + S.bank[2] * bankN(th);
    h *= sstep(7.4, 9.5, roadD(th));
    if (B.benchIn) h *= 1 - sstep(-1.2, 0.3, B.benchIn(th));
    // (the bench's bank tapers away toward its arc's ends, where its wall runs into the main body's:
    // never a cut end standing up off the mound like a plank; and none where it runs into a lobe)
    if (B.arc) h *= sstep(0.15, 0.7, ARC_B - angDiff(th, (B.arc[0] + B.arc[1]) / 2)) * (B.mainIn ? 1 - sstep(-1.2, 0.3, B.mainIn(th)) : 1);
    return Math.max(0, Math.min(1.35, h));
  };
  B.bankR = th => Math.max(0.5, Math.min(2.4 + 1.8 * B.bankH(th) + 0.6 * reachN(th), roadD(th) - 7.0));
  B.hF = th => {
    const room = yT - B.capT(th) - B.ucH(th) - g(th, Rb(th) + 0.2);
    return Math.max(0.3, Math.min(0.75 + 0.35 * spurAt(th), room * 0.55));
  };
  return B;
}

const FORMS = new WeakMap();
export function butteForms(W) {
  if (FORMS.has(W)) return FORMS.get(W);
  const S = butteStyle(W.biome), out = [];
  for (const p of W.mesas || []) {
    const M = p.mesa;
    if (!M) continue;
    // (world gen's cylinders, from p.mesa: the main body and its lobes (one outline), and the bench)
    const cm = { x: p.x, z: p.z, r: M.R ?? M.r, top: M.base + M.h };
    const cb = M.bench ? { x: M.bench.x, z: M.bench.z, r: M.bench.r, top: M.bench.top } : null;
    const rnd = rng32((Math.round(p.z * 977) ^ Math.imul(W.seed | 0, 0x2C1B3C6D) ^ 0x51ED27) >>> 0);
    const roadA = Math.atan2(0, W.roadX(p.z) - p.x);       // toward the road (x, z: cos, sin)
    const main = bodyForm(W, S, rnd, { cx: cm.x, cz: cm.z, R: cm.r, yT: cm.top, kind: 'main', roadA, OL: mainOutline(p) });
    let bench = null;
    if (cb) {
      const benchA = Math.atan2(cb.z - cm.z, cb.x - cm.x);
      // (how far inside the main tier's outline a point stands)
      const inMain = (x, z) => main.Rb(Math.atan2(z - cm.z, x - cm.x)) - Math.hypot(x - cm.x, z - cm.z);
      bench = bodyForm(W, S, rnd, { cx: cb.x, cz: cb.z, R: cb.r, yT: cb.top, kind: 'bench', roadA, OL: arcOutline(cb.r, benchA, ARC_B) });
      bench.benchA = benchA;
      // how far inside the main tier the bench's wall stands at a bearing (a lobe can stand round it)
      bench.mainIn = th => inMain(cb.x + Math.cos(th) * cb.r, cb.z + Math.sin(th) * cb.r);
      // the main body's cap overhangs the bench's top only where it stands well above head height over it
      main.overK = th => {
        const r = main.Rb(th) + LIP, x = cm.x + Math.cos(th) * r, z = cm.z + Math.sin(th) * r;
        if (Math.hypot(x - cb.x, z - cb.z) > cb.r + LIP + 0.3) return 1;
        return sstep(2.4, 3.2, main.yT - main.capT(th) - main.ucH(th) - bench.yT);
      };
      // how far inside the bench the main tier's wall stands at a bearing; its wall starts on the bench's
      // top wherever the bench stands round it
      main.benchIn = th => { const r = main.Rb(th); return cb.r - Math.hypot(cm.x + Math.cos(th) * r - cb.x, cm.z + Math.sin(th) * r - cb.z); };
      main.shortY = th => main.benchIn(th) > SHORT_IN ? bench.yT - 0.3 : null;
    }
    const F = { p, main, bench, roadA };
    F.bank = (x, z) => bankAt(F, x, z);      // (the banks' height over the ground: the talus lies on them)
    // how far inside the butte (either tier) a point stands (< 0: outside)
    F.inside = (x, z) => {
      let d = main.Rb(Math.atan2(z - cm.z, x - cm.x)) - Math.hypot(x - cm.x, z - cm.z);
      if (cb) d = Math.max(d, cb.r - Math.hypot(x - cb.x, z - cb.z));
      return d;
    };
    out.push(F);
  }
  FORMS.set(W, out);
  return out;
}

// ---- the drawn top, for the wreck's dressing ---------------------------------------------------------
// The rim's rounded edge: from (R, yT) round a quarter ellipse to the cap's face at R + ov, e below.
const rimDrop = ov => Math.min(0.26, ov * 0.6 + 0.04);
function topOf(B, x, z) {
  const dx = x - B.cx, dz = z - B.cz, r = Math.hypot(dx, dz), th = Math.atan2(dz, dx), R = B.Rb(th);
  if (r <= R) return B.yT;
  if (B.arc && angDiff(th, (B.arc[0] + B.arc[1]) / 2) > ARC_B) return null;
  const ov = B.ov(th);
  if (r > R + ov) return null;
  const e = rimDrop(ov), q = (r - R) / ov;
  return B.yT - e + e * Math.sqrt(Math.max(0, 1 - q * q));
}
export function butteGround(W, p) {
  const F = butteForms(W).find(f => f.p === p || f.p.id === p.id);
  if (!F) return (x, z) => W.heightAt(x, z);
  return (x, z) => {
    let y = topOf(F.main, x, z);
    if (y == null && F.bench) y = topOf(F.bench, x, z);
    return y ?? W.heightAt(x, z);
  };
}

// ---- the mesh ----------------------------------------------------------------------------------------

// Everything is gathered here: positions, normals, colours (AO), aU (the wall's arc length and its beds'
// fault offset, m) and aK
// (x: 0 a butte's body, 1 a loose block; y: height above the ground under it; z: depth below its tier's
// top (-1: snow cap, cover all over; 99: none); w: caprock, 0..1), indexed.
export class Acc {
  constructor() { this.P = []; this.N = []; this.C = []; this.U = []; this.K = []; this.I = []; }
  get n() { return this.P.length / 3; }
  v(x, y, z, nx, ny, nz, c, u, k) {
    this.P.push(x, y, z); this.N.push(nx, ny, nz); this.C.push(c[0], c[1], c[2]); this.U.push(u[0], u[1]); this.K.push(k[0], k[1], k[2], k[3]);
    return this.n - 1;
  }
  // smooth normals over faces I[i0..] (area weighted), for vertices v0..
  normals(v0, i0) {
    const P = this.P, N = this.N, I = this.I;
    for (let v = v0; v < this.n; v++) { N[v * 3] = 0; N[v * 3 + 1] = 0; N[v * 3 + 2] = 0; }
    for (let i = i0; i < I.length; i += 3) {
      const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      for (const q of [a, b, c]) { N[q] += nx; N[q + 1] += ny; N[q + 2] += nz; }
    }
    for (let v = v0; v < this.n; v++) { const l = Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) || 1; N[v * 3] /= l; N[v * 3 + 1] /= l; N[v * 3 + 2] /= l; }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aU', new THREE.Float32BufferAttribute(this.U, 2));
    g.setAttribute('aK', new THREE.Float32BufferAttribute(this.K, 4));
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return g;
  }
}
export const aoColor = (S, ao) => [lerp(S.ao[0], 1, ao), lerp(S.ao[1], 1, ao), lerp(S.ao[2], 1, ao)];

// One column of a tier from its buried foot to its top's middle: [{ r, y, ao, cap, dup }] (dup: the same
// point again, with no faces between them: a crease). Every column of a tier has the same number of points.
function profile(W, S, B, th, nBody) {
  const R = B.Rb(th), yT = B.yT, P = [];
  const add = (r, y, ao, cap = 0, dup = false) => { P.push({ r, y, ao, cap, dup }); };
  const ov = B.ov(th), capT = B.capT(th), ucH = B.ucH(th), ucD = B.ucD(th);
  const yCapB = yT - capT, yUc = yCapB - ucH;
  const F = B.flare(th), hF = B.hF(th), mT = B.massTone(th);
  // (heights from the lowest ground just outside the wall: where the road's ditch cuts into the mound the
  // ground falls away from the foot, and nothing stands out past the wall more than ~1.5 m above it)
  const gW = Math.min(B.g(th, R + 0.25), B.g(th, R + 0.3 + F * 0.6));
  // (darker in a joint's cleft, and under a bed that steps out over the one below)
  const jAO = y => (1 - B.joint(th, y)[2]) * (1 - Math.min(0.3, Math.max(0, B.plan(th, y + 0.35) - B.plan(th, y)) * 2.4));
  // the foot, hugging the mound: the rock flares out onto it (buttresses where the spurs are)
  for (const k of [-0.6, -0.05, 0.2, 0.45, 0.72, 1.0]) {
    const h = k * hF, x = k <= 0 ? F + (-k) * 0.6 : F * Math.pow(1 - k, 1.7);
    const r = R + B.wall(th, gW + Math.max(0, h)) + x;
    const y = Math.min(B.g(th, r), gW) + h;
    add(r, y, lerp(0.62, 0.92, clamp01(k)) * jAO(y) * B.tone(th, y) * mT);
  }
  // the wall
  const yF = P[P.length - 1].y;
  for (let k = 1; k <= nBody; k++) {
    const y = yF + (yUc - yF) * k / nBody, t = k / nBody;
    add(R + B.wall(th, y), y, lerp(0.92, 1.0, t) * (1 - 0.12 * sstep(0.85, 1, t)) * jAO(y) * B.tone(th, y) * mT);
  }
  // the undercut under the cap (cool, in shadow), the cap's underside, its face, its rounded rim
  const rU = R - ucD;
  add(lerp(R + B.wall(th, yUc), rU, 0.6), yUc + ucH * 0.45, 0.62);
  add(rU, yCapB - 0.03, 0.5);
  add(rU, yCapB - 0.03, 0.42, 1, true);
  const rc = R + ov, e = rimDrop(ov);
  add(rc - 0.1, yCapB, 0.5, 1);
  add(rc - 0.1, yCapB, 0.78, 1, true);
  // (the cap's own tone, darker where a joint splits it)
  const ct = B.capTone(th) * (1 - 0.5 * B.joint(th, yT - 0.4)[0]);
  add(rc - 0.02, yCapB + 0.09, 0.86 * ct, 1);
  add(rc + 0.02 * Math.sin(th * 7 + B.R), yCapB + Math.max(0.12, (capT - e) * 0.5), 0.98 * ct, 1);
  add(rc, yT - e - 0.05, ct, 1);
  for (const a of [0.35, 0.7]) add(R + ov * Math.cos(a * Math.PI / 2), yT - e + e * Math.sin(a * Math.PI / 2), 1, 1);
  add(R, yT, 1, 1);
  // the top, flat to its middle
  for (const f of [R - 0.03, R - 0.3, R * 0.72, R * 0.45, R * 0.2]) add(f, yT, 1, 1);
  // the main body round the bench: below the bench's top it lies inside the bench (collapsed there)
  const sy = B.shortY ? B.shortY(th) : null;
  if (sy != null) for (const q of P) if (q.y < sy) { q.y = sy; q.r = R + B.wall(th, sy); }
  return P;
}

// the bearings of a tier's columns: ~0.45 m apart along its outline, closer round each corner and joint
// (the main tier's from its seam t0 once round, so their raw arc length runs 0..perim, and the seam's
// column again at the end, a turn on: its u runs on)
function columns(B) {
  const OL = B.OL, P = OL.perim, out = [];
  const n = Math.max(12, Math.ceil(P / 0.45));
  for (let i = 0; i < n; i++) out.push(P * i / n);
  if (!OL.ring) out.push(P);
  // (each corner crisp: a column on it and one either side; a joint's cleft in seven)
  for (const c of B.corners) { const s = OL.s(c); for (const k of [-0.12, 0, 0.12]) out.push(s + k); }
  for (const j of B.joints) { const s = OL.s(j.a); for (const k of [-1.25, -0.8, -0.4, 0, 0.4, 0.8, 1.25]) out.push(s + k * j.w); }
  const L = [];
  for (let s of out) {
    if (OL.ring) s = ((s % P) + P) % P;
    else if (s < 0 || s > P) continue;
    L.push(s);
  }
  L.sort((p, q) => p - q);
  const A = L.filter((s, i) => i === 0 || s - L[i - 1] > 0.02);
  const th = A.map(s => (OL.ring ? OL.t0 + (((OL.th(s) - OL.t0) % TAU) + TAU) % TAU : OL.th(s)));
  if (OL.ring) th.push(OL.t0 + TAU);
  return th;
}

// The bank: a smooth skirt round a tier's foot from just inside its wall, bankH up, falling (concave) onto
// the mound bankR out, its outer edge sunk into the ground; the cover's (sand, snow) or the scree's colour.
function bankInto(acc, W, S, B) {
  const OL = B.OL;
  // (round the main tier from its seam once round; along the bench's arc, stopping 0.15 rad short of its ends)
  const [s0, s1] = OL.ring ? [0, OL.perim] : [0.15 * B.R, OL.perim - 0.15 * B.R];
  const n = Math.max(16, Math.ceil((s1 - s0) / 0.45)), T = [0, 0.1, 0.24, 0.42, 0.64, 0.86, 1.0];
  const v0 = acc.n, i0 = acc.I.length, ids = [];
  for (let i = 0; i <= n; i++) {
    const sv = s0 + (s1 - s0) * i / n;
    const th = !OL.ring ? OL.th(sv) : i === n ? OL.t0 + TAU : OL.t0 + (((OL.th(sv) - OL.t0) % TAU) + TAU) % TAU;
    const c = Math.cos(th), s = Math.sin(th), h = B.bankH(th), reach = B.bankR(th), R = B.Rb(th), u = B.U(th, true);
    const row = [];
    for (const t of T) {
      const r0 = R + B.wall(th, B.g(th, R + 0.3) + h * 0.5) - 0.12, r = r0 + reach * t;
      const x = B.cx + c * r, z = B.cz + s * r, g = W.heightAt(x, z);
      const y = g + h * Math.pow(1 - t, 1.7) - (t >= 1 ? 0.12 : 0);
      row.push(acc.v(x, y, z, 0, 1, 0, aoColor(S, lerp(0.86, 1, t)), [u, 0], [0, y - g, S.bank[3] ? -2 : -1, 0]));
    }
    ids.push(row);
  }
  for (let i = 0; i < n; i++) for (let k = 0; k + 1 < T.length; k++) {
    const a = ids[i][k], b = ids[i][k + 1], c = ids[i + 1][k + 1], d = ids[i + 1][k];
    acc.I.push(a, d, b, b, d, c);
  }
  acc.normals(v0, i0);
}
// how high the banks round crash site F stand at (x, z), above the ground
export function bankAt(F, x, z) {
  let h = 0;
  for (const B of [F.main, F.bench]) {
    if (!B) continue;
    const dx = x - B.cx, dz = z - B.cz, r = Math.hypot(dx, dz), th = Math.atan2(dz, dx);
    if (B.arc && angDiff(th, (B.arc[0] + B.arc[1]) / 2) > (B.arc[1] - B.arc[0]) / 2) continue;
    const r0 = B.Rb(th) + 0.05, reach = B.bankR(th), t = (r - r0) / reach;
    if (t < -0.2 || t > 1) continue;
    h = Math.max(h, B.bankH(th) * Math.pow(1 - Math.max(0, t), 1.7));
  }
  return h;
}

function bodyInto(acc, W, S, B) {
  const cols = columns(B);
  const nBody = Math.max(6, Math.ceil((B.yT - B.gm - 2.2) / 0.3));
  const v0 = acc.n, i0 = acc.I.length;
  const ids = [];
  let L = -1;
  for (const th of cols) {
    const P = profile(W, S, B, th, nBody), c = Math.cos(th), s = Math.sin(th), vo = B.vOff(th), bank = B.bankH(th), u = B.U(th, true);
    if (L < 0) L = P.length;
    const row = [];
    for (const q of P) {
      const x = B.cx + c * q.r, z = B.cz + s * q.r;
      row.push({ id: acc.v(x, q.y, z, 0, 1, 0, aoColor(S, q.ao), [u, vo], [0, q.y - W.heightAt(x, z) - bank, B.yT - q.y, q.cap]), dup: q.dup });
    }
    ids.push(row);
  }
  const mid = acc.v(B.cx, B.yT, B.cz, 0, 1, 0, aoColor(S, 1), [0, 0], [0, B.yT - W.heightAt(B.cx, B.cz), 0, 1]);
  // faces: outward (the columns run counter-clockwise seen from above: x cos, z sin)
  for (let j = 0; j + 1 < ids.length; j++) {
    const A = ids[j], Bq = ids[j + 1];
    for (let k = 0; k + 1 < L; k++) {
      if (A[k + 1].dup) continue;
      const a = A[k].id, b = A[k + 1].id, c = Bq[k + 1].id, d = Bq[k].id;
      acc.I.push(a, b, d, b, c, d);
    }
    acc.I.push(A[L - 1].id, mid, Bq[L - 1].id);
  }
  // wind every triangle outward/up (the bearings run one way round, so the order above is consistent:
  // check once and flip all if needed)
  {
    const P = acc.P, I = acc.I;
    let s = 0;
    for (let i = i0; i < I.length; i += 3) {
      const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3;
      const ux = P[b] - P[a], uz = P[b + 2] - P[a + 2], uy = P[b + 1] - P[a + 1], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const mx = (P[a] + P[b] + P[c]) / 3 - B.cx, mz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3 - B.cz;
      s += nx * mx + nz * mz + ny * 0.001;
    }
    if (s < 0) for (let i = i0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
  }
  acc.normals(v0, i0);
}

// ---- the material ------------------------------------------------------------------------------------

const MATS = new Map();
function butteMaterial(biome, { form = null, macro = null, scree = null } = {}) {
  const S = butteStyle(biome), useForm = !!(S.form && form);
  const Q = { dirt: `dirt_${biome}`, g2: `ground2_${biome}`, sDirt: 6, sG2: 9, tint: [1, 1, 1], share: 0, k: 0.8, ...(scree || {}) };
  const key = biome + (useForm ? 'f' : '');
  if (MATS.has(key)) {
    const m = MATS.get(key), U = m.userData.U;
    if (useForm) U.tForm.value = form;
    if (macro) U.tMacro.value = macro;
    U.uScr.value.set(...Q.tint, Q.share); U.uScrK.value.set(1 / Q.sDirt, 1 / Q.sG2, Q.k);
    return m;
  }
  const f3 = v => v.map(x => x.toFixed(3)).join(', ');
  const U = {
    tRock: { value: tex(S.rock) }, tCover: { value: tex(S.cover) }, tScree: { value: tex(Q.dirt) }, tScree2: { value: tex(Q.g2) }, tMacro: { value: macro },
    uRT: { value: new THREE.Vector4(1 / S.tile, 1 / S.ctile, 0, 0) },
    uScr: { value: new THREE.Vector4(...Q.tint, Q.share) }, uScrK: { value: new THREE.Vector3(1 / Q.sDirt, 1 / Q.sG2, Q.k) },
  };
  if (useForm) U.tForm = { value: form };
  const m = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
  m.userData.U = U;
  m.customProgramCacheKey = () => 'terrain-butte-v3-' + key;
  m.onBeforeCompile = sh => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aU; attribute vec4 aK; varying vec3 vBW; varying vec3 vBN; varying vec2 vBU; varying vec4 vBK;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBW = (modelMatrix * vec4(transformed, 1.0)).xyz; vBN = normalize(mat3(modelMatrix) * objectNormal); vBU = aU; vBK = aK;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D tRock, tCover, tScree, tScree2, tMacro; uniform vec4 uRT, uScr; uniform vec3 uScrK;
        ${useForm ? 'uniform sampler2D tForm;' : ''}
        varying vec3 vBW; varying vec3 vBN; varying vec2 vBU; varying vec4 vBK;
        float bLum(vec3 c) { return dot(c, vec3(0.3, 0.55, 0.15)); }
        ${S.turn ? `const mat2 BT = mat2(0.894427, 0.447214, -0.447214, 0.894427);
        vec2 formTurnB(vec3 f) { return vec2(0.5 + 0.5 * (0.894427 * (f.r * 2.0 - 1.0) - 0.447214 * (f.b * 2.0 - 1.0)), f.g); }` : 'const mat2 BT = mat2(1.0, 0.0, 0.0, 1.0);'}`)
      .replace('#include <map_fragment>', `
        {
          vec3 n = normalize(vBN);
          float body = 1.0 - clamp(vBK.x, 0.0, 1.0);
          // noise: on a wall laid on the wall (arc, height), elsewhere from above
          float wallK = (1.0 - smoothstep(0.45, 0.8, abs(n.y))) * body;
          vec4 nA = texture2D(tMacro, vec2(vBU.x, vBW.y) / 9.0 + vec2(0.13, 0.71));
          vec4 nB = texture2D(tMacro, vBW.xz / 9.0 + vec2(0.61, 0.27));
          vec4 nz = mix(nB, nA, wallK);
          // the rock: a body's wall wrapped round it (arc length, height), from above on what faces up;
          // a loose block on three axes (the beds level on its sides)
          vec3 bw = pow(abs(n), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
          vec2 pC = BT * vec2(vBU.x, vBW.y + vBU.y) * uRT.x + ${S.turn ? 'vec2(0.31, 0.11)' : 'vec2(0.0)'};
          vec2 pX = BT * vec2(vBW.z, vBW.y) * uRT.x + 0.31, pY = vBW.xz * uRT.x + 0.57, pZ = BT * vec2(-vBW.x, vBW.y) * uRT.x + 0.13;
          vec3 rC = texture2D(tRock, pC).rgb, rX = texture2D(tRock, pX).rgb, rY = texture2D(tRock, pY).rgb, rZ = texture2D(tRock, pZ).rgb;
          float upK = smoothstep(0.62, 0.92, n.y);
          vec3 rk = mix(rX * bw.x + rY * bw.y + rZ * bw.z, mix(rC, rY, upK), body);
          rk *= vec3(${f3(S.tint)});
          ${S.bed ? `// (the beds' contrast eased toward the painting's own mean, its smallest mip)
          rk = mix(texture2D(tRock, vec2(0.5), 12.0).rgb * vec3(${f3(S.tint)}), rk, ${S.bed.toFixed(3)});` : ''}
          ${S.lift ? `// (the granite never darker than its own palette, as on the valley walls)
          rk += max(vec3(0.0), vec3(0.11, 0.125, 0.165) - rk) * 0.6;` : ''}
          // streaks down the wall from under the cap (desert varnish, rain stains), fading downward
          float vs = texture2D(tMacro, vec2(vBU.x / 4.0, vBW.y / 45.0) + vec2(0.71, 0.37)).b + (nA.g - 0.5) * 0.2;
          rk *= 1.0 - ${S.streak.toFixed(3)} * smoothstep(0.52, 0.74, vs) * (1.0 - smoothstep(1.0, 9.0, vBK.z - 1.2)) * wallK * (1.0 - vBK.w);
          // broad weathering round the butte: patches darker (varnish, lichen) or paler (scoured), so no bed
          // runs round it in one tone
          vec4 nW = texture2D(tMacro, vec2(vBU.x / 21.0, vBW.y / 17.0) + vec2(0.43, 0.09));
          rk *= mix(vec3(${f3(S.weather)}), vec3(1.0), smoothstep(0.28, 0.66, nW.r + (nA.b - 0.5) * 0.2)) * (0.93 + 0.14 * nW.g) * body + (1.0 - body);
          // the caprock: the hard top bed, paler and plainer than the soft rock under it
          float capK = vBK.w * ${S.cap[3].toFixed(3)};
          rk = mix(rk, vec3(${f3(S.cap.slice(0, 3))}) * (0.72 + 0.55 * bLum(rk)), capK);
          // the cover on what faces up, broken by noise
          vec3 cv = texture2D(tCover, vBW.xz * uRT.y).rgb;
          float cn = (nz.g - 0.5) + (nz.b - 0.5) * 0.6;
          float cov = smoothstep(${S.cov[0].toFixed(3)}, ${S.cov[1].toFixed(3)}, n.y + cn * ${S.cov[2].toFixed(3)});
          ${useForm ? `// (snow: also on whatever the painted granite turns up, read from its form map)
          vec2 fm = mix(texture2D(tForm, pX).rg * bw.x + texture2D(tForm, pY).rg * bw.y + texture2D(tForm, pZ).rg * bw.z, formTurnB(texture2D(tForm, pC).rgb), body);
          float fUp = ((fm.x - 0.55) * 1.3 - (fm.y - 0.5) * 0.3) * (1.0 - smoothstep(0.6, 0.9, n.y));
          cov = max(cov, smoothstep(${S.cov[0].toFixed(3)}, ${S.cov[1].toFixed(3)}, n.y + cn * 0.35 + fUp));` : ''}
          // over a rim the cover hangs a little way down (turf, a snow cornice, drifted sand), its edge wandering
          float hang = ${S.lip[0].toFixed(3)} + (nz.r - 0.5) * ${(2 * S.lip[1]).toFixed(3)};
          cov = max(cov, (1.0 - smoothstep(hang - 0.05, hang + 0.05, vBK.z)) * step(-0.5, vBK.z) * body);
          cov = max(cov, 1.0 - step(-0.5, vBK.z));
          cov *= ${S.cov[3].toFixed(3)};
          ${S.moss ? `// (a fallen block's top: its cover in patches)
          cov *= mix(1.0, smoothstep(0.42, 0.6, texture2D(tMacro, vBW.xz / 2.3 + vec2(0.37, 0.81)).r), clamp(vBK.x, 0.0, 1.0) * step(-0.5, vBK.z));` : ''}
          // the rock right under the cover lies in its shadow
          rk *= mix(vec3(1.0), vec3(0.78, 0.8, 0.88), smoothstep(0.0, 0.6, cov) * (1.0 - cov) * 0.8);
          vec3 c = mix(rk, cv${S.lift ? ' * mix(vec3(0.78, 0.84, 0.97), vec3(1.0), smoothstep(-0.2, 0.8, n.y + cn * 0.3))' : ''}, cov);
          // the foot: darker low down, then the ground the terrain paints round it (its scree over the
          // ground, as the splat lays it: the same textures, scales and turn) lapping up the very foot
          float sk = vBK.y;
          c *= mix(vec3(${f3(S.buried)}), vec3(1.0), smoothstep(-0.1, 0.9, sk));
          vec2 xr = mat2(0.8, -0.6, 0.6, 0.8) * vBW.xz;
          vec3 sc = mix(texture2D(tScree, xr * uScrK.x).rgb, texture2D(tScree2, xr * uScrK.y).rgb, uScr.w) * uScr.rgb;
          c = mix(c, mix(cv, sc, uScrK.z), max((1.0 - smoothstep(0.0, 0.16 + 0.3 * nz.g, sk)) * 0.92, 1.0 - step(-1.5, vBK.z)));
          diffuseColor.rgb *= c;
        }`);
  };
  MATS.set(key, m);
  return m;
}

// ---- assembly ----------------------------------------------------------------------------------------

// The geometry of every butte on the leg (both tiers and their talus), in world space.
export function butteGeometry(W, { tint = null } = {}) {
  const forms = butteForms(W);
  if (!forms.length) return null;
  const S = butteStyle(W.biome), acc = new Acc(), tiers = [];
  for (const F of forms) {
    const v0 = acc.n;
    for (const B of [F.main, F.bench]) if (B) { const a = acc.n; bodyInto(acc, W, S, B); tiers.push({ poi: F.p.id, kind: B.kind, v0: a, v1: acc.n }); }
    for (const B of [F.main, F.bench]) if (B) bankInto(acc, W, S, B);
    talusInto(acc, W, S, [F]);
    // the splat's broad warm/cool tint and value drift where it stands (40-80 m fields: one per butte),
    // read on the open mound beside it, so the rock and the ground round it are tinted alike
    if (tint) {
      const a = F.roadA + Math.PI, R = F.main.Rb(a) + 3.5, t = tint(F.main.cx + Math.cos(a) * R, F.main.cz + Math.sin(a) * R);
      for (let i = v0 * 3; i < acc.C.length; i += 3) { acc.C[i] *= t.r; acc.C[i + 1] *= t.g; acc.C[i + 2] *= t.b; }
    }
  }
  const geo = acc.geometry();
  geo.userData.tiers = tiers;     // (each tier's vertices: the fit check tells them apart)
  return geo;
}

export function buildButtes(W, { form = null, macro = null, scree = null, tint = null } = {}) {
  const geo = butteGeometry(W, { tint });
  if (!geo) return null;
  if (!macro) {
    macro = new THREE.CanvasTexture(canvasFor('terrain_macro'));
    macro.wrapS = macro.wrapT = THREE.RepeatWrapping; macro.colorSpace = THREE.NoColorSpace;
  }
  const mesh = new THREE.Mesh(geo, butteMaterial(W.biome, { form, macro, scree }));
  mesh.name = 'terrain:buttes';
  mesh.castShadow = true; mesh.receiveShadow = true;
  return { mesh, dispose() { geo.dispose(); } };
}
