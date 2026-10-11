// The crash mesas' bodies (part of the terrain art pass). World gen makes each crash mesa a butte: two
// solid cylinders in W.cyls with mat 'mesa' (the main body, flat-topped where the wreck and its loot
// lie, and a lower bench tier on one end, seen side-on from the road), standing on a talus mound in the
// heightfield. Here each is drawn as natural rock fitted to its collider, never as a drum:
//   - the wall: the biome's own valley-wall rock (cliff_<biome>) wrapped round the body a whole number of
//     tiles (no seam). It is a stack of beds, each an irregular polygon of flat faces (its own tone each)
//     stepping in or out a little over the one below (a ledge, a shadow; now and then a soft bed set
//     back); vertical joints cut it into pillars (dark clefts, some notching the cap); between two joints
//     that run its whole height the blocks settled on their own (the beds jog up or down, so no band runs
//     round unbroken); the painting's own relief (its lit masses stand out, its seams sink back) and a
//     slight batter on top. All of it stays within [WALL_IN, WALL_OUT] of the collider's radius, so a
//     climber hugs the rock. The shader weathers it: desert varnish and rain streaks down from the rim,
//     a paler, sun-bleached cap bed, AO in the joints and under the ledges;
//   - the foot: below ~1.5 m the rock flares out onto the mound in buttresses (clear of the road's
//     ditch), and a bank laps up it (drifted sand or snow, deepest on the side world gen's wind comes
//     from, or the terrain's scree), so no clean circle meets the ground; terrain_talus.js heaps fallen
//     blocks on it;
//   - the caprock: a thick hard top bed, a polygon of its own, standing out 0.03-LIP past the collider
//     over a cool undercut (only where it stands well above head height), its edge rounded over, notched
//     where joints reach it and broken back where a piece of it fell (its slabs lie on the talus below);
//     the walkable top inside the collider's radius is exactly flat at the collider's top;
//   - the cover: turf, golden grass, snow (on the ledges too), red dust or drifted sand on whatever faces
//     up, and hanging a little way over the rim (Dun Morogh: a snow cornice);
//   - the bench: a lower step of the same rock round the main body's end, its cap overhanging only where
//     it stands well above head height.
// Everything (both tiers of every butte on the leg, their banks and their talus) is one mesh with one
// material: one draw call a day.
//
//   buildButtes(W, { form, macro, scree, tint }) -> { mesh, dispose() } | null   (null: no crash mesas)
//   butteForms(W) -> [{ p, main, bench, roadA, bank }]   the shapes (pure maths), for the talus and the crash
//   butteGeometry(W, { tint }) -> BufferGeometry   the merged mesh alone (userData.tiers: each tier's
//     vertex range), for a fit check
//   butteGround(W, p) -> (x, z) => y   the drawn top of p's butte where it stands (its rounded rim,
//     a sheer drop past the lip), else the ground: what the wreck's dressing drapes over
//   bankAt(F, x, z) -> m   how deep the bank lies over the heightfield at (x, z)
import { THREE, tex } from './gfx.js';
import { canvasFor } from './paint/index.js';
import { talusInto } from './terrain_talus.js';

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
// the wall's offset from the collider's radius kept inside [lo, hi], smoothly (never a flat clipped band)
const softClamp = (f, lo, hi) => { const c = (lo + hi) / 2, w = (hi - lo) / 2; return c + w * Math.tanh((f - c) / w); };

// The wall stays within [IN, OUT] of the collider's radius from ~1.5 m above the ground to the cap; the
// cap's edge stands 0.03 to LIP past it; the main body's wall is left out where the bench stands round it
// by more than SHORT_IN (it starts on the bench's top there).
export const WALL_IN = -0.345, WALL_OUT = 0.1, LIP = 0.43;   // (the cap's face swells up to 0.02 more; a face between two columns lies a few mm in)
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

// ---- the shapes -------------------------------------------------------------------------------------

// One tier: a body standing on the collider (cx, cz, R, yT). Its wall offset wall(th, y), the cap's
// overhang ov(th), thickness capT(th), the undercut's height ucH(th) and depth ucD(th), the foot's flare
// flare(th) and height hF(th), joints and broken notches, the texture's wrap radius Rref.
function bodyForm(W, S, rnd, o) {
  const { cx, cz, R, yT, kind, roadA } = o;
  const main = kind === 'main';
  const B = { cx, cz, R, yT, kind };
  const g = (th, r) => W.heightAt(cx + Math.cos(th) * r, cz + Math.sin(th) * r);
  B.g = g;
  // the bench's wall runs round its far end only (the rest lies inside the main body)
  B.arc = main ? null : [o.benchA - ARC_B, o.benchA + ARC_B];
  // (a bearing as the bench's arc counts it: within half a turn of its middle, whatever atan2 gave)
  B.inArc = th => (B.arc ? o.benchA + Math.atan2(Math.sin(th - o.benchA), Math.cos(th - o.benchA)) : th);
  const C = TAU * R;
  // the texture wraps a whole number of tiles round the main body (no seam); the bench's open arc keeps
  // its true scale
  if (!main) B.Rref = R;
  else if (S.turn) { const b = Math.max(1, Math.round(C * TURN[1] / S.tile)); B.Rref = b * S.tile / TURN[1] / TAU; }
  else { const n = Math.max(1, Math.round(C / S.tile)); B.Rref = n * S.tile / TAU; }
  // the mean ground round it
  let gm = 0; for (let k = 0; k < 16; k++) gm += g(k / 16 * TAU, R + 0.3); gm /= 16;
  B.gm = gm;
  // headroom: a cap may overhang only well above head height (the bench can be low)
  B.head = th => sstep(2.4, 3.4, yT - g(th, R + 0.3));
  const capN = periodicA(rnd, 2, 7, 0.9), ucN = periodicA(rnd, 3, 8, 0.8), buttP = periodicA(rnd, 3, 7, 0.6);
  // The plan: the wall is a stack of beds, each an irregular polygon of flat rock faces (~3-5 m across, its
  // corners a hair outside the collider's radius, the faces' middles ~0.25 m in) turned its own
  // way, so the wall breaks into lit and shaded faces like stacked blocks of jointed rock (each bed stepping
  // in or out a little over the one under it: a ledge, a shadow), never a turned drum. The cap is a polygon
  // too, standing out past the top bed's corners by its own amount at each. Joints: clefts that cut the
  // wall into pillars (some its whole height, notching the cap, some down from the cap, a few up from the
  // foot).
  const span = B.arc ? B.arc[1] - B.arc[0] : TAU;
  const dA = 2 * Math.acos(1 - 0.3 / R);                  // (a face whose middle lies ~0.3 m in from its corners)
  const nF = Math.max(B.arc ? 3 : 7, Math.round(span / dA));
  const polygon = (rIn, rOut) => {
    const wts = []; for (let k = 0; k < nF; k++) wts.push(0.62 + rnd() * 0.76);
    const wsum = wts.reduce((p, q) => p + q, 0), CA = [], CR = [], TN = [];
    let ca = B.arc ? B.arc[0] : rnd() * TAU;
    for (let k = 0; k <= nF; k++) { CA.push(ca); CR.push(lerp(rIn, rOut, rnd())); TN.push(0.93 + rnd() * 0.14); if (k < nF) ca += wts[k] / wsum * span; }
    if (!B.arc) CR[nF] = CR[0];                             // (a closed ring: the last corner is the first, a turn on)
    const face = th => {
      const t = B.arc ? Math.max(CA[0], Math.min(CA[nF], B.inArc(th))) : ((th - CA[0]) % TAU + TAU) % TAU + CA[0];
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
    return { CA, CR, at, tone, corners: B.arc ? CA.slice() : CA.slice(0, nF) };
  };
  // the beds, from the foot to the cap, 1.6-3.4 m each (the lowest runs down into the ground)
  const H = yT - gm, yCapLo = yT - S.capT[1] - 0.6, beds = [];
  for (let y = gm + 1.2 + rnd() * 1.4; y < yCapLo - 1.0; y += 1.6 + rnd() * 1.8) beds.push(y);
  // (a soft bed, now and then, stands back ~0.12 m under the harder one over it: a ledge and its shadow)
  B.beds = [-1e9, ...beds, 1e9].map((y0, k, A) => { if (k >= A.length - 1) return null; const o = k > 0 && rnd() < 0.45 ? -0.1 : 0; return { y0, y1: A[k + 1], P: polygon(R + 0.05 + o, R + 0.11 + o) }; }).filter(Boolean);
  const capP = polygon(R + Math.max(0.26, S.ov[0]), R + S.ov[1]);
  B.corners = [...new Set(B.beds.flatMap(b => b.P.corners).concat(capP.corners))];
  B.plan = (th, y) => {
    let k = 0; while (k < B.beds.length - 1 && y > B.beds[k].y1) k++;
    const b = B.beds[k], v = b.P.at(th) - R;
    // (a soft step, 0.3 m, into the bed above or below)
    if (k + 1 < B.beds.length && y > b.y1 - 0.15) return lerp(v, B.beds[k + 1].P.at(th) - R, sstep(b.y1 - 0.15, b.y1 + 0.15, y));
    if (k > 0 && y < b.y0 + 0.15) return lerp(B.beds[k - 1].P.at(th) - R, v, sstep(b.y0 - 0.15, b.y0 + 0.15, y));
    return v;
  };
  const polyAt = (th, P) => P.at(th);
  B.tone = (th, y) => { let k = 0; while (k < B.beds.length - 1 && y > B.beds[k].y1) k++; return B.beds[k].P.tone(th); };
  B.capTone = th => capP.tone(th) * cbC(th);
  const J = [];
  const nJ = Math.max(B.arc ? 2 : 5, Math.round(span * R / (3.8 + rnd() * 2.2)));
  const ja0 = rnd() * TAU;
  for (let k = 0; k < nJ; k++) {
    const f = (k + 0.5 + (rnd() - 0.5) * 0.6) / nJ, a = B.arc ? lerp(B.arc[0] + 0.25, B.arc[1] - 0.25, f) : ja0 + f * TAU;
    const q = rnd(), full = q < 0.55, top = q >= 0.55 && q < 0.85;
    J.push({ a, w: 0.26 + rnd() * 0.26, d: 0.2 + rnd() * 0.14,
      y0: full || top ? (full ? -1e9 : yT - H * (0.35 + rnd() * 0.35)) : -1e9,
      y1: full || top ? 1e9 : gm + H * (0.3 + rnd() * 0.3), cap: full || top });
  }
  B.joints = J;
  // A value of its own for each block of rock between two joints (Js, sorted), blended across each
  // joint's cleft (the step hides in it); the bench's arc: arcV before its first joint
  const bySeg = (Js, vals, arcV) => th => {
    const n = Js.length;
    if (!n) return arcV;
    if (!B.arc && n < 2) return vals[0];
    const t = B.arc ? B.inArc(th) : ((th - Js[0].a) % TAU + TAU) % TAU + Js[0].a;
    let k = B.arc ? -1 : n - 1;
    for (let i = 0; i < n; i++) if (t >= Js[i].a) k = i;
    const val = i => (B.arc ? (i < 0 ? arcV : vals[i]) : vals[(i + n) % n]);
    for (let i = 0; i < n; i++) {
      for (const turn of B.arc ? [0] : [-TAU, 0, TAU]) {
        const d = (t - Js[i].a - turn) * R, w = Js[i].w * 0.6;
        if (Math.abs(d) < w) return lerp(val(i - 1), val(i), sstep(-w, w, d));
      }
    }
    return val(k);
  };
  // Faults: between two joints that run the wall's whole height its blocks settled on their own, the beds
  // a little higher or lower (+-0.4 m), so no band runs round the butte unbroken
  const fulls = J.filter(j => j.y0 < -1e8 && j.y1 > 1e8).sort((p, q) => p.a - q.a);
  B.vOff = bySeg(fulls, fulls.map(() => (rnd() - 0.5) * 0.8), (rnd() - 0.5) * 0.8);
  // The cap is blocks too, split by the joints that reach it: each its own thickness (its underside steps
  // +-0.2 m at a cleft), overhang (x0.7-1.1) and tone, so it never reads as one turned lid
  const capJ = J.filter(j => j.cap).sort((p, q) => p.a - q.a);
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
  // the buttresses at the foot: three to five spurs
  const spurs = [];
  const nS = main ? 3 + Math.floor(rnd() * 3) : 1 + Math.floor(rnd() * 2);
  for (let k = 0; k < nS; k++) spurs.push({ a: B.arc ? lerp(B.arc[0] + 0.4, B.arc[1] - 0.4, rnd()) : rnd() * TAU, w: 0.25 + rnd() * 0.25, k: 0.6 + rnd() * 0.6 });
  // how deep in a joint (0..1) at (th, y), and how far it cuts (m)
  const jointAt = (th, y) => {
    let best = 0, cut = 0;
    for (const j of J) {
      const s = angDiff(th, j.a) * R;
      if (s > j.w * 1.2) continue;
      const across = 1 - sstep(j.w * 0.3, j.w, s);
      const along = sstep(j.y0 - 0.7, j.y0 + 0.5, y) * (1 - sstep(j.y1 - 0.5, j.y1 + 0.7, y));
      const k = across * along;
      if (k > best) { best = k; cut = j.d * k; }
    }
    return [best, cut];
  };
  B.joint = jointAt;
  const notchAt = th => { let k = 0; for (const n of notch) k = Math.max(k, n.k * (1 - sstep(n.w * 0.55, n.w, angDiff(th, n.a) * R))); return k; };
  B.notch = notchAt;
  const relief = S.form ? reliefMap('cliff_snow_form', 1) : reliefMap(S.rock);
  const yU0 = yT - (S.capT[0] + S.capT[1]) / 2 - 0.4;
  B.wall = (th, y) => {
    const t = clamp01((y - gm - 1.2) / Math.max(1, yU0 - gm - 1.2));
    let f = 0.03 - 0.1 * t;                                         // a slight batter
    f += B.plan(th, y);
    const [tu, tv] = texUV(S, th * B.Rref, y + B.vOff(th));
    f += S.rel * relief(tu, tv);
    f -= jointAt(th, y)[1];
    return softClamp(f, WALL_IN, WALL_OUT);
  };
  B.ov = th => {
    let v = polyAt(th, capP) - R;
    for (const j of J) if (j.cap) { const s = angDiff(th, j.a) * R; if (s < j.w * 1.4) v -= (0.6 + j.d * 2) * (1 - sstep(j.w * 0.3, j.w * 1.4, s)) * 0.3; }
    v = lerp(v * cbO(th), 0.03, notchAt(th));
    return Math.max(0.03, Math.min(LIP, v * (main ? (B.overK ? B.overK(th) : 1) : B.head(th))));
  };
  B.capT = th => {
    let t = (lerp(S.capT[0], S.capT[1], 0.5 + 0.5 * capN(th)) + cbT(th)) * (main ? 1 : 0.75);
    t *= 1 - 0.45 * notchAt(th);
    if (!main) t = Math.min(t, Math.max(0.35, yT - g(th, R + 0.3) - 2.3));
    return t;
  };
  B.ucH = th => (0.3 + 0.25 * (0.5 + 0.5 * ucN(th))) * (main ? 1 : 0.4 + 0.6 * B.head(th));
  B.ucD = th => (main ? 0.06 + 0.27 * (B.overK ? B.overK(th) : 1) : 0.06 + 0.27 * B.head(th)) * (1 - 0.6 * notchAt(th));
  B.flare = th => {
    let sp = 0; for (const s of spurs) sp = Math.max(sp, s.k * (1 - sstep(s.w * 0.4, s.w, angDiff(th, s.a))));
    let F = S.flare[0] * (0.75 + 0.25 * buttP(th)) + S.flare[1] * sp;
    // never into the road's ditch: the foot keeps 6.9 m from the road's centre line
    const x = cx + Math.cos(th) * R, z = cz + Math.sin(th) * R, dR = Math.abs(x - W.roadX(z));
    F = Math.min(F, Math.max(0.05, dR - 6.9));
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
    const x = cx + Math.cos(th) * R, z = cz + Math.sin(th) * R, dR = Math.abs(x - W.roadX(z));
    h *= sstep(7.4, 9.5, dR);
    if (B.benchIn) h *= 1 - sstep(-1.2, 0.3, B.benchIn(th));
    // (the bench's bank tapers away toward its arc's ends, where its wall runs into the main body's:
    // never a cut end standing up off the mound like a plank)
    if (B.arc) h *= sstep(0.15, 0.7, ARC_B - angDiff(th, o.benchA));
    return Math.max(0, Math.min(1.35, h));
  };
  B.bankR = th => {
    const x = cx + Math.cos(th) * R, z = cz + Math.sin(th) * R, dR = Math.abs(x - W.roadX(z));
    return Math.max(0.5, Math.min(2.4 + 1.8 * B.bankH(th) + 0.6 * reachN(th), dR - 7.0));
  };
  B.hF = th => {
    let sp = 0; for (const s of spurs) sp = Math.max(sp, s.k * (1 - sstep(s.w * 0.4, s.w, angDiff(th, s.a))));
    const room = yT - B.capT(th) - B.ucH(th) - g(th, R + 0.2);
    return Math.max(0.3, Math.min(0.75 + 0.35 * sp, room * 0.55));
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
    // (world gen's two cylinders, from p.mesa: the main body and the bench)
    const cm = { x: p.x, z: p.z, r: M.R ?? M.r, top: M.base + M.h };
    const cb = M.bench ? { x: M.bench.x, z: M.bench.z, r: M.bench.r, top: M.bench.top } : null;
    const rnd = rng32((Math.round(p.z * 977) ^ Math.imul(W.seed | 0, 0x2C1B3C6D) ^ 0x51ED27) >>> 0);
    const roadA = Math.atan2(0, W.roadX(p.z) - p.x);       // toward the road (x, z: cos, sin)
    const main = bodyForm(W, S, rnd, { cx: cm.x, cz: cm.z, R: cm.r, yT: cm.top, kind: 'main', roadA, lobes: M.lobes, ph: M.ph });
    let bench = null;
    if (cb) {
      const benchA = Math.atan2(cb.z - cm.z, cb.x - cm.x);
      bench = bodyForm(W, S, rnd, { cx: cb.x, cz: cb.z, R: cb.r, yT: cb.top, kind: 'bench', roadA, benchA });
      bench.benchA = benchA;
      // the main body's cap overhangs the bench's top only where it stands well above head height over it
      main.overK = th => {
        const x = cm.x + Math.cos(th) * (cm.r + LIP), z = cm.z + Math.sin(th) * (cm.r + LIP);
        if (Math.hypot(x - cb.x, z - cb.z) > cb.r + LIP + 0.3) return 1;
        return sstep(2.4, 3.2, main.yT - main.capT(th) - main.ucH(th) - bench.yT);
      };
      // how far inside the bench the main body's wall stands at a bearing; its wall starts on the bench's
      // top wherever the bench stands round it
      main.benchIn = th => cb.r - Math.hypot(cm.x + Math.cos(th) * cm.r - cb.x, cm.z + Math.sin(th) * cm.r - cb.z);
      main.shortY = th => main.benchIn(th) > SHORT_IN ? bench.yT - 0.3 : null;
    }
    const F = { p, main, bench, roadA };
    F.bank = (x, z) => bankAt(F, x, z);      // (the banks' height over the ground: the talus lies on them)
    out.push(F);
  }
  FORMS.set(W, out);
  return out;
}

// ---- the drawn top, for the wreck's dressing ---------------------------------------------------------
// The rim's rounded edge: from (R, yT) round a quarter ellipse to the cap's face at R + ov, e below.
const rimDrop = ov => Math.min(0.26, ov * 0.6 + 0.04);
function topOf(B, x, z) {
  const dx = x - B.cx, dz = z - B.cz, r = Math.hypot(dx, dz);
  if (r <= B.R) return B.yT;
  const th = Math.atan2(dz, dx);
  if (B.arc && angDiff(th, (B.arc[0] + B.arc[1]) / 2) > ARC_B) return null;
  const ov = B.ov(th);
  if (r > B.R + ov) return null;
  const e = rimDrop(ov), q = (r - B.R) / ov;
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
  const R = B.R, yT = B.yT, P = [];
  const add = (r, y, ao, cap = 0, dup = false) => { P.push({ r, y, ao, cap, dup }); };
  const ov = B.ov(th), capT = B.capT(th), ucH = B.ucH(th), ucD = B.ucD(th);
  const yCapB = yT - capT, yUc = yCapB - ucH;
  const F = B.flare(th), hF = B.hF(th);
  // (heights from the lowest ground just outside the wall: where the road's ditch cuts into the mound the
  // ground falls away from the foot, and nothing stands out past the wall more than ~1.5 m above it)
  const gW = Math.min(B.g(th, R + 0.25), B.g(th, R + 0.3 + F * 0.6));
  // (darker in a joint's cleft, and under a bed that steps out over the one below)
  const jAO = y => (1 - 0.74 * B.joint(th, y)[0]) * (1 - Math.min(0.3, Math.max(0, B.plan(th, y + 0.35) - B.plan(th, y)) * 2.4));
  // the foot, hugging the mound: the rock flares out onto it (buttresses where the spurs are)
  for (const k of [-0.6, -0.05, 0.2, 0.45, 0.72, 1.0]) {
    const h = k * hF, x = k <= 0 ? F + (-k) * 0.6 : F * Math.pow(1 - k, 1.7);
    const r = R + B.wall(th, gW + Math.max(0, h)) + x;
    const y = Math.min(B.g(th, r), gW) + h;
    add(r, y, lerp(0.62, 0.92, clamp01(k)) * jAO(y) * B.tone(th, y));
  }
  // the wall
  const yF = P[P.length - 1].y;
  for (let k = 1; k <= nBody; k++) {
    const y = yF + (yUc - yF) * k / nBody, t = k / nBody;
    add(R + B.wall(th, y), y, lerp(0.92, 1.0, t) * (1 - 0.12 * sstep(0.85, 1, t)) * jAO(y) * B.tone(th, y));
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

// the bearings of a tier's columns: ~0.45 m apart, closer round each joint
function columns(B) {
  const R = B.R, out = [];
  const [a0, a1] = B.arc || [0, TAU];
  const n = Math.max(12, Math.ceil((a1 - a0) * R / 0.45));
  for (let i = 0; i < n; i++) out.push(a0 + (a1 - a0) * i / n);
  if (B.arc) out.push(a1);
  // (each corner crisp: a column on it and one either side; a joint's cleft in seven)
  const extra = [];
  for (const c of B.corners) for (const k of [-0.12, 0, 0.12]) extra.push(c + k / R);
  for (const j of B.joints) for (const k of [-1.25, -0.8, -0.4, 0.4, 0.8, 1.25]) extra.push(j.a + k * j.w / R);
  for (let a of extra) {
    if (B.arc) { if (a <= a0 || a >= a1) continue; }
    else a = ((a % TAU) + TAU) % TAU;
    out.push(a);
  }
  out.sort((p, q) => p - q);
  const A = out.filter((a, i) => i === 0 || a - out[i - 1] > 0.004);
  if (!B.arc) A.push(A[0] + TAU);     // the seam: the first column again, a turn on (its u runs on)
  return A;
}

// The bank: a smooth skirt round a tier's foot from just inside its wall, bankH up, falling (concave) onto
// the mound bankR out, its outer edge sunk into the ground; the cover's (sand, snow) or the scree's colour.
function bankInto(acc, W, S, B) {
  const [a0, a1] = B.arc ? [B.arc[0] + 0.15, B.arc[1] - 0.15] : [0, TAU];
  const n = Math.max(16, Math.ceil((a1 - a0) * B.R / 0.45)), T = [0, 0.1, 0.24, 0.42, 0.64, 0.86, 1.0];
  const v0 = acc.n, i0 = acc.I.length, ids = [];
  for (let i = 0; i <= n; i++) {
    const th = a0 + (a1 - a0) * i / n, c = Math.cos(th), s = Math.sin(th), h = B.bankH(th), reach = B.bankR(th);
    const row = [];
    for (const t of T) {
      const r0 = B.R + B.wall(th, B.g(th, B.R + 0.3) + h * 0.5) - 0.12, r = r0 + reach * t;
      const x = B.cx + c * r, z = B.cz + s * r, g = W.heightAt(x, z);
      const y = g + h * Math.pow(1 - t, 1.7) - (t >= 1 ? 0.12 : 0);
      row.push(acc.v(x, y, z, 0, 1, 0, aoColor(S, lerp(0.86, 1, t)), [th * B.Rref, 0], [0, y - g, S.bank[3] ? -2 : -1, 0]));
    }
    ids.push(row);
    if (!B.arc && i === n) break;
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
    const r0 = B.R + 0.05, reach = B.bankR(th), t = (r - r0) / reach;
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
    const P = profile(W, S, B, th, nBody), c = Math.cos(th), s = Math.sin(th), vo = B.vOff(th), bank = B.bankH(th);
    if (L < 0) L = P.length;
    const row = [];
    for (const q of P) {
      const x = B.cx + c * q.r, z = B.cz + s * q.r;
      row.push({ id: acc.v(x, q.y, z, 0, 1, 0, aoColor(S, q.ao), [th * B.Rref, vo], [0, q.y - W.heightAt(x, z) - bank, B.yT - q.y, q.cap]), dup: q.dup });
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
      const a = F.roadA + Math.PI, R = F.main.R + 3.5, t = tint(F.main.cx + Math.cos(a) * R, F.main.cz + Math.sin(a) * R);
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
