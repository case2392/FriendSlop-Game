// Texture family: terrain. See docs/ART.md for the style rules.
//
// Per biome b in meadow | fields | badlands | desert:
//   ground_<b>    the main ground (512, world-space, ~6 m a tile)
//   ground2_<b>   a second ground, blended in by large-scale noise
//   dirt_<b>      bare packed dirt (camp clearings, yards, the town square)
//   road_<b>      the dirt road in ROAD SPACE: x runs across the road (edge to edge,
//                 plus a grassy shoulder), y runs along it, so the wheel ruts follow the road
//   cliff_<b>     steep faces, projected from the side (y = world height, so strata stay level)
//   clutter_<b>   2×2 alpha atlas of ground-clutter cards (grass tufts, flowers, wheat, twigs)
//   sky_mtn_<b>   3 rows of distant mountain silhouettes (far, mid, near) for the horizon ring
// Shared: mud, terrain_macro (RGB low-frequency variation, not color), sky_clouds (alpha).
import {
  register, fill, mottle, blade, stroke, pebbles, cracks, glaze, blurTile, range, pick, wrap, blob, ellipse,
  mix, shade, lightOf, shadowOf, jitter, hex, rgba, makeCanvas, worley, paintCells, streaks,
} from './core.js';

const TAU = Math.PI * 2;

// ---- shared helpers ------------------------------------------------------------------------

// A periodic 1D function on [0, 1): sum of sines with integer frequencies (tiles seamlessly).
function periodic(rnd, terms = 6, falloff = 1.2, k0 = 1) {
  const T = [];
  for (let k = k0; k < k0 + terms; k++) T.push([k, rnd() * TAU, (0.5 + rnd()) / Math.pow(k, falloff)]);
  const norm = T.reduce((a, t) => a + t[2], 0);
  return t => { let v = 0; for (const [k, p, a] of T) v += Math.sin(TAU * k * t + p) * a; return v / norm; };
}

// Grass blades scattered everywhere: n blades, colors, length/width ranges.
function bladePass(g, s, rnd, n, cols, len, wid, alpha, ang = [-0.45, 0.55], bend = [-0.3, 0.4], where = null) {
  for (let i = 0; i < n; i++) {
    let x = rnd() * s, y = rnd() * s;
    if (where && !where(x, y)) continue;
    const L = range(rnd, len[0], len[1]), a = range(rnd, ang[0], ang[1]), w = range(rnd, wid[0], wid[1]), c = pick(rnd, cols), b = range(rnd, bend[0], bend[1]);
    wrap(s, x, y, L + 2, (xx, yy) => blade(g, xx, yy, L, a, w, c, alpha, b));
  }
}

// Clumps of grass: a soft cool shadow, then blades fanning up from a base, dark → mid → lit.
function grassClumps(g, s, rnd, n, { r = [8, 20], dark, mid, lit, len = [8, 16], wid = [1.4, 2.6], dens = 0.35, shadow = 0.22, where = null }) {
  for (let i = 0; i < n; i++) {
    const cx = rnd() * s, cy = rnd() * s;
    if (where && !where(cx, cy)) continue;
    const R = range(rnd, r[0], r[1]);
    const k = Math.max(4, Math.round(R * R * dens * 0.25));
    wrap(s, cx, cy, R + len[1] + 4, (X, Y) => {
      blob(g, X + R * 0.25, Y + R * 0.2, R * 1.15, R * 0.75, 0, '#1d2a14', shadow, 0.25);
    });
    const layers = [[dark, 1.0, 0.75], [mid, 0.85, 0.8], [lit, 0.6, 0.75]];
    for (const [cols, lenK, a] of layers) {
      for (let j = 0; j < k; j++) {
        const t = Math.sqrt(rnd()), th = rnd() * TAU;
        const bx = cx + Math.cos(th) * R * t, by = cy + Math.sin(th) * R * 0.6 * t + R * 0.15;
        const L = range(rnd, len[0], len[1]) * lenK * (1.15 - t * 0.4);
        const ang = (bx - cx) / R * 0.5 + range(rnd, -0.25, 0.25);
        const w = range(rnd, wid[0], wid[1]), c = pick(rnd, cols);
        wrap(s, bx, by, L + 3, (xx, yy) => blade(g, xx, yy, L, ang, w, c, a, range(rnd, -0.25, 0.3)));
      }
    }
  }
}

// Pebbles with a density function (reject-sampled), lit top-left, cool shadow bottom-right.
function pebblesWhere(g, s, rnd, n, cols, rmin, rmax, where, alpha = 1) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s;
    if (where && rnd() > where(x, y)) continue;
    const r = range(rnd, rmin, rmax), ry = r * range(rnd, 0.6, 0.95), rot = rnd() * Math.PI, c = pick(rnd, cols);
    wrap(s, x, y, r * 2, (xx, yy) => {
      blob(g, xx + r * 0.35, yy + r * 0.45, r * 1.3, ry * 1.3, rot, '#1e1626', 0.4 * alpha, 0.2);
      ellipse(g, xx, yy, r, ry, rot, c, alpha);
      blob(g, xx - r * 0.3, yy - r * 0.35, r * 0.62, ry * 0.5, rot, lightOf(c, 0.55), 0.75 * alpha, 0.3);
      blob(g, xx + r * 0.3, yy + r * 0.3, r * 0.6, ry * 0.5, rot, shadowOf(c, 0.4), 0.5 * alpha, 0.3);
    });
  }
}

// Packed dirt: base, big soft color fields, small clods, pebbles, a few cracks.
function dirtGround(g, s, rnd, P, { pebbleN = 260, crackN = 5, clods = 160 } = {}) {
  fill(g, s, s, P.base);
  mottle(g, s, rnd, { colors: P.blot, count: 56, rmin: 40, rmax: 140, alpha: 0.38, hard: 0.08 });
  mottle(g, s, rnd, { colors: P.small, count: clods, rmin: 5, rmax: 20, alpha: 0.24, hard: 0.35, stretch: 1.5 });
  // trodden flat spots: soft lighter blotches with a darker rim on the lower right
  for (let i = 0; i < 10; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 18, 40);
    wrap(s, x, y, r * 1.4, (X, Y) => {
      blob(g, X + r * 0.15, Y + r * 0.18, r * 1.05, r * 0.7, 0.2, shadowOf(P.base, 0.35), 0.18, 0.4);
      blob(g, X, Y, r, r * 0.65, 0.2, lightOf(P.base, 0.25), 0.2, 0.5);
    });
  }
  pebbles(g, s, rnd, { colors: P.peb, count: pebbleN, rmin: 1.4, rmax: 4.2 });
  pebbles(g, s, rnd, { colors: P.peb, count: Math.round(pebbleN / 8), rmin: 4.5, rmax: 8.5 });
  if (crackN) cracks(g, s, rnd, { color: shadowOf(P.base, 0.6), count: crackN, len: [16, 44], width: [0.8, 1.6], alpha: 0.4 });
}

// Wheel ruts running along y at x = x0 (road space). Compacted, darker, shadowed left wall, lit right wall.
function rut(g, s, rnd, x0, w, P) {
  const wob = periodic(rnd, 4, 1.4, 1), wob2 = periodic(rnd, 3, 1, 3);
  const pts = k => { const out = []; for (let y = -24; y <= s + 24; y += 12) out.push([x0 + k + wob(y / s) * 7 + wob2(y / s) * 2, y]); return out; };
  stroke(g, pts(0), w * 1.5, w * 1.5, P.rut, 0.22);
  stroke(g, pts(0), w, w, P.rut, 0.4);
  stroke(g, pts(-w * 0.42), w * 0.22, w * 0.22, P.rutDark, 0.42);
  stroke(g, pts(w * 0.45), w * 0.16, w * 0.16, P.rutLit, 0.38);
  for (let i = 0; i < 3; i++) { const o = range(rnd, -w * 0.25, w * 0.25); stroke(g, pts(o), 1.2, 1.2, i % 2 ? P.rutLit : P.rutDark, 0.16); }
  // dark wet spots in the ruts
  for (let i = 0; i < 7; i++) {
    const y = rnd() * s, L = range(rnd, 12, 34);
    wrap(s, x0, y, L, (X, Y) => blob(g, X + wob(Y / s) * 7, Y, w * 0.45, L, Math.PI / 2, P.rutDark, 0.22, 0.3));
  }
}

// The road, in road space. P: palette, opts: center ('grass' | 'dry' | 'sand' | 'gravel'), shoulder colors.
// Across: x = 0 and x = s are 5 m from the centerline; the driven surface ends ~3.3 m out (x ≈ 87 / 425).
function paintRoad(g, s, rnd, P) {
  fill(g, s, s, P.base);
  mottle(g, s, rnd, { colors: P.blot, count: 60, rmin: 36, rmax: 120, alpha: 0.36, hard: 0.1, stretch: 1.8, rot: Math.PI / 2 });
  mottle(g, s, rnd, { colors: P.small, count: 170, rmin: 5, rmax: 18, alpha: 0.22, hard: 0.35, stretch: 1.6 });
  // cross profile: the crown is lighter and drier, the edges darker and softer
  const gr = g.createLinearGradient(0, 0, s, 0);
  gr.addColorStop(0, rgba(P.edge, 0.55)); gr.addColorStop(0.17, rgba(P.edge, 0.12)); gr.addColorStop(0.3, rgba(P.base, 0));
  gr.addColorStop(0.7, rgba(P.base, 0)); gr.addColorStop(0.83, rgba(P.edge, 0.12)); gr.addColorStop(1, rgba(P.edge, 0.55));
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  const crown = g.createLinearGradient(0, 0, s, 0);
  crown.addColorStop(0.36, rgba(P.crown, 0)); crown.addColorStop(0.5, rgba(P.crown, 0.28)); crown.addColorStop(0.64, rgba(P.crown, 0));
  g.fillStyle = crown; g.fillRect(0, 0, s, s);
  // ruts at ±1.05 m
  const c = s / 2, mpx = s / 10;
  rut(g, s, rnd, c - 1.05 * mpx, 0.55 * mpx, P);
  rut(g, s, rnd, c + 1.05 * mpx, 0.55 * mpx, P);
  // gravel: heavier on the crown and the shoulders, sparse in the ruts
  const dens = x => { const d = Math.abs(x - c) / mpx; return d < 0.6 ? 0.9 : d < 1.4 ? 0.2 : d < 3.0 ? 0.7 : 1; };
  pebblesWhere(g, s, rnd, 900, P.peb, 1.3, 3.8, dens);
  pebblesWhere(g, s, rnd, 90, P.peb, 4, 7.5, x => dens(x) * 0.8);
  cracks(g, s, rnd, { color: shadowOf(P.base, 0.6), count: 4, len: [14, 36], width: [0.7, 1.4], alpha: 0.35 });
  // the center strip
  const inStrip = (x) => Math.abs(x - c) < 0.42 * mpx;
  if (P.center === 'grass' || P.center === 'dry') {
    grassClumps(g, s, rnd, 70, { r: [3, 8], dark: P.gDark, mid: P.gMid, lit: P.gLit, len: [5, 11], wid: [1.2, 2], dens: 0.5, shadow: 0.18,
      where: (x) => inStrip(x) });
  } else if (P.center === 'sand') {
    for (let y = -20; y < s + 20; y += 6) {
      const w = 0.35 * mpx * (0.6 + 0.4 * Math.sin(y / s * TAU * 3 + 1.3));
      wrap(s, c, y, 30, (X, Y) => blob(g, X, Y, w, 9, 0, P.crown, 0.18, 0.3));
    }
  }
  // the shoulders: ground creeps in from the edges in ragged clumps
  const edgeW = 1.75 * mpx;
  const nearEdge = (x) => x < edgeW * (0.6 + rnd() * 0.6) || x > s - edgeW * (0.6 + rnd() * 0.6);
  if (P.gDark) grassClumps(g, s, rnd, 260, { r: [5, 14], dark: P.gDark, mid: P.gMid, lit: P.gLit, len: [6, 13], wid: [1.3, 2.3], dens: 0.45, shadow: 0.2, where: nearEdge });
  if (P.extra) P.extra(g, s, rnd);
  glaze(g, s, s, '#ffdca0', 0.08, 'soft-light');
  blurTile(g.canvas, 0.35);
}

// Rock faces for cliffs: big angular stones with lit/shadowed bevels, cracks, rain streaks,
// and moss/dry grass on the upward-facing edges.
function paintRock(g, s, rnd, P) {
  const F = worley(s, P.cells || 4, rnd, 0.95);
  paintCells(g, F, { colors: P.colors, grout: P.grout, groutW: 2.4, bevel: 16, dome: 0.22, light: 0.5, varAmt: 0.1, rnd });
  // a per-stone facet tilt: one side of each stone a bit lighter (upper-left light)
  const img = g.getImageData(0, 0, s, s), D = img.data;
  const tilt = F.seeds.map(() => [range(rnd, -0.35, 0.15), range(rnd, -0.45, 0.1)]);
  const mossC = hex(P.moss), mossD = hex(shadowOf(P.moss, 0.35));
  const wob = periodic(rnd, 6, 1, 2), wob2 = periodic(rnd, 5, 1, 3);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x, id = F.id[k], sd = F.seeds[id];
    let dx = x - sd.x, dy = y - sd.y;
    if (dx > s / 2) dx -= s; if (dx < -s / 2) dx += s; if (dy > s / 2) dy -= s; if (dy < -s / 2) dy += s;
    const [tx, ty] = tilt[id];
    const m = 1 + (dx * tx + dy * ty) / (s / (P.cells || 4)) * 0.5;
    let r = D[k * 4] * m, gg = D[k * 4 + 1] * m, b = D[k * 4 + 2] * m;
    // moss on the top rim of each stone (pixel above its seed, close to the border)
    const e = F.edge[k];
    const top = -F.diry[k];
    const band = (P.mossW || 14) * (0.6 + 0.5 * wob(x / s) + 0.3 * wob2((x + y) / s));
    if (top > 0.35 && e < band && e > 1.8) {
      const t = Math.min(1, (top - 0.35) * 2.2) * Math.min(1, (band - e) / 6) * (P.mossAmt ?? 0.85);
      const mc = e < band * 0.45 ? mossC : mossD;
      r = r * (1 - t) + mc.r * t; gg = gg * (1 - t) + mc.g * t; b = b * (1 - t) + mc.b * t;
    }
    D[k * 4] = r; D[k * 4 + 1] = gg; D[k * 4 + 2] = b;
  }
  g.putImageData(img, 0, 0);
  blurTile(g.canvas, 0.8);
  // rain streaks and vertical cracks
  streaks(g, s, rnd, { colors: [shadowOf(P.colors[0], 0.45), shadowOf(P.colors[1], 0.3)], count: 60, len: [40, 150], width: [2, 6], angle: Math.PI, wobble: 0.08, alpha: 0.18 });
  streaks(g, s, rnd, { colors: [lightOf(P.colors[0], 0.4)], count: 24, len: [20, 70], width: [1.5, 3], angle: Math.PI, wobble: 0.1, alpha: 0.14 });
  cracks(g, s, rnd, { color: shadowOf(P.grout, 0.2), count: 10, len: [30, 80], width: [1, 2.2], alpha: 0.5, branch: 0.4 });
  mottle(g, s, rnd, { colors: P.blot, count: 30, rmin: 30, rmax: 110, alpha: 0.16, hard: 0.1 });
  // tufts of moss / grass clinging in clumps
  if (P.tuft) for (let i = 0; i < 26; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 4, 11);
    wrap(s, x, y, r * 2, (X, Y) => {
      blob(g, X + 1.5, Y + 2, r * 1.2, r * 0.7, 0, '#22261a', 0.3, 0.3);
      blob(g, X, Y, r, r * 0.6, 0, P.tuft[0], 0.85, 0.5);
      blob(g, X - r * 0.3, Y - r * 0.25, r * 0.55, r * 0.32, 0, P.tuft[1], 0.75, 0.45);
    });
  }
  glaze(g, s, s, '#ffe2b0', 0.08, 'soft-light');
}

// Horizontal strata (Thousand Needles / Tanaris): bands of rock, each lit on its lip and
// casting a cool shadow on the band beneath; harder bands stick out, softer ones recede.
function paintStrata(g, s, rnd, P) {
  const th = [];
  let tot = 0;
  while (tot < s) { const t = range(rnd, P.band[0], P.band[1]) * (rnd() < 0.25 ? 0.45 : 1); th.push(t); tot += t; }
  const k = s / tot;
  const bands = [];
  let y = 0;
  let last = -1;
  for (let i = 0; i < th.length; i++) {
    let ci; do { ci = Math.floor(rnd() * P.colors.length); } while (ci === last && P.colors.length > 1);
    last = ci;
    bands.push({ y, h: th[i] * k, c: jitter(P.colors[ci], rnd, 0.05), hard: rnd() < 0.55, wob: periodic(rnd, 5, 1.1, 1), amp: range(rnd, 2, 7) });
    y += th[i] * k;
  }
  const top = (i, x) => { const b = bands[(i + bands.length) % bands.length]; return b.y + b.wob(x / s) * b.amp + (i >= bands.length ? s : 0); };
  fill(g, s, s, P.colors[0]);
  for (const dy of [-s, 0, s]) {
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const y0 = b.y + dy, y1 = b.y + b.h + dy;
      g.beginPath();
      for (let x = -8; x <= s + 8; x += 8) { const yy = top(i, x) + dy; x === -8 ? g.moveTo(x, yy) : g.lineTo(x, yy); }
      for (let x = s + 8; x >= -8; x -= 8) { const yy = (i + 1 < bands.length ? top(i + 1, x) : top(0, x) + s) + dy; g.lineTo(x, yy); }
      g.closePath();
      const gr = g.createLinearGradient(0, y0 - 6, 0, y1 + 6);
      if (b.hard) { gr.addColorStop(0, lightOf(b.c, 0.3)); gr.addColorStop(0.35, b.c); gr.addColorStop(1, shadowOf(b.c, 0.28)); }
      else { gr.addColorStop(0, shadowOf(b.c, 0.42)); gr.addColorStop(0.4, shadowOf(b.c, 0.12)); gr.addColorStop(1, b.c); }
      g.fillStyle = gr; g.fill();
    }
  }
  // texture inside the bands: soft blotches stretched horizontally, sandy specks
  mottle(g, s, rnd, { colors: P.blot, count: 90, rmin: 14, rmax: 60, alpha: 0.18, hard: 0.15, stretch: 2.6, rot: 0 });
  // lips and under-ledge shadows
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    const lip = [], under = [];
    for (let x = -10; x <= s + 10; x += 6) { lip.push([x, top(i, x)]); under.push([x, top(i + 1, x)]); }
    for (const dy of [-s, 0, s]) {
      const L = lip.map(([x, yy]) => [x, yy + dy]);
      if (b.hard) {
        // a jutting band: lit lip on top, and it shades the top of the band beneath it
        const nb = bands[(i + 1) % bands.length];
        stroke(g, under.map(([x, yy]) => [x, yy + dy + 4]), 8, 8, shadowOf(nb.c, 0.55), 0.35);
        stroke(g, L, 3.2, 3.2, lightOf(b.c, 0.65), 0.55);
      } else {
        stroke(g, L.map(([x, yy]) => [x, yy + 4]), 9, 9, P.deep, 0.35);
      }
    }
  }
  // vertical erosion: gullies and cracks crossing the bands
  streaks(g, s, rnd, { colors: [P.deep, shadowOf(P.colors[1], 0.4)], count: 70, len: [30, 140], width: [2, 7], angle: Math.PI, wobble: 0.1, alpha: 0.16 });
  streaks(g, s, rnd, { colors: [lightOf(P.colors[2], 0.4)], count: 40, len: [16, 60], width: [1.5, 3], angle: Math.PI, wobble: 0.12, alpha: 0.14 });
  for (let i = 0; i < 16; i++) {
    const x = rnd() * s, y0 = rnd() * s, L = range(rnd, 30, 110);
    const pts = []; let px = x;
    for (let yy = 0; yy <= L; yy += 8) { px += range(rnd, -2.5, 2.5); pts.push([px, y0 + yy]); }
    wrap(s, x, y0 + L / 2, L, (X, Y) => {
      const sh = pts.map(([u, v]) => [u - x + X, v - (y0 + L / 2) + Y]);
      stroke(g, sh.map(([u, v]) => [u + 1.6, v]), 2.2, 0.8, lightOf(P.colors[2], 0.5), 0.3);
      stroke(g, sh, 2.0, 0.6, P.deep, 0.55);
    });
  }
  // rubble resting on the hard ledges
  for (let i = 0; i < bands.length; i++) if (bands[i].hard) {
    const n = Math.round(range(rnd, 4, 12));
    for (let j = 0; j < n; j++) {
      const x = rnd() * s, yy = top(i, x) - range(rnd, 1, 4), r = range(rnd, 1.5, 4);
      const c = jitter(bands[i].c, rnd, 0.12);
      wrap(s, x, yy, r * 2, (X, Y) => { blob(g, X + 1, Y + 1.5, r * 1.3, r * 0.8, 0, P.deep, 0.35, 0.3); ellipse(g, X, Y, r, r * 0.7, 0, c); blob(g, X - r * 0.3, Y - r * 0.3, r * 0.55, r * 0.35, 0, lightOf(c, 0.5), 0.7, 0.4); });
    }
  }
  glaze(g, s, s, P.glaze || '#ffd9a8', 0.1, 'soft-light');
  blurTile(g.canvas, 0.55);
}

// ---- palettes ------------------------------------------------------------------------------

const BIO = {
  meadow: {
    dirt: { base: '#7a5a3a', blot: ['#6c4f33', '#8c6a45', '#9a7650', '#5e4530', '#84653f'], small: ['#5a4130', '#a8865c', '#6a5038'], peb: ['#b39a77', '#9c8466', '#c7b394', '#80695a', '#a89a88'] },
    grass: { dark: ['#2f5419', '#3a611f', '#2c4c1c'], mid: ['#5b8c2f', '#66983a', '#527f2b'], lit: ['#9cbf55', '#b2cc63', '#8db24a'] },
    road: { base: '#86663f', blot: ['#755636', '#987650', '#a48459', '#6a4e32', '#8f7448'], small: ['#5f4530', '#b0926a'], peb: ['#b39a77', '#9c8466', '#c7b394', '#80695a', '#a89a88'],
      edge: '#5f4a2c', crown: '#b39570', rut: '#5e4330', rutDark: '#3b2a22', rutLit: '#b89670', center: 'grass' },
  },
  fields: {
    dirt: { base: '#94704a', blot: ['#86643f', '#a8845a', '#b18c5c', '#7a5a3a', '#9c7a50'], small: ['#6e5236', '#c09a6a', '#8a6844'], peb: ['#c4ab84', '#a8916e', '#d6c19a', '#8c7660', '#b6a488'] },
    grass: { dark: ['#6b5f2a', '#5d5a26', '#706430'], mid: ['#b49a4c', '#c2a654', '#a89246', '#9a9a48'], lit: ['#e2c56a', '#ecd486', '#d8bd62'] },
    road: { base: '#a8845a', blot: ['#98744c', '#b8946a', '#c09c70', '#8a6844', '#a6845a'], small: ['#7a5a3a', '#c8a678'], peb: ['#c4ab84', '#a8916e', '#d6c19a', '#8c7660', '#b6a488'],
      edge: '#7a6234', crown: '#cdb084', rut: '#7a5a3c', rutDark: '#4e3a2a', rutLit: '#d0b080', center: 'dry' },
  },
  badlands: {
    dirt: { base: '#a8704a', blot: ['#9a6240', '#b97e52', '#c48a5c', '#8a5638', '#b47448'], small: ['#7a4a30', '#cf9a6a', '#9a5a38'], peb: ['#c48a62', '#a86a48', '#d8a478', '#8a5a44', '#b98a6a'] },
    grass: { dark: ['#6a5230', '#5e4a2c'], mid: ['#a88a50', '#b89858', '#9a7a48'], lit: ['#d8bc7a', '#e2c88a'] },
    road: { base: '#a77650', blot: ['#966646', '#b8845a', '#c08c62', '#8a5a3c', '#a87048'], small: ['#7a4a30', '#c89a6e'], peb: ['#c48a62', '#a86a48', '#d8a478', '#8a5a44', '#b98a6a', '#9a8a80'],
      edge: '#8a5636', crown: '#c8946a', rut: '#7e5038', rutDark: '#4e2e24', rutLit: '#d4a072', center: 'gravel' },
  },
  desert: {
    dirt: { base: '#c49c68', blot: ['#b88e5c', '#d4ac78', '#c79c62', '#ad8452', '#d8b480'], small: ['#9c7a4c', '#e0c08e', '#b08858'], peb: ['#d8c09a', '#b89a74', '#e8d4ae', '#9c8268', '#c4b08e'] },
    grass: { dark: ['#7a6a40', '#6e6038'], mid: ['#b8a468', '#c4ae72'], lit: ['#e4d29a', '#ecdcaa'] },
    road: { base: '#bf9a68', blot: ['#b08c5c', '#ccaa78', '#d4b282', '#a07c50', '#c4a070'], small: ['#9c7a4c', '#e0c08e'], peb: ['#d8c09a', '#b89a74', '#e8d4ae', '#9c8268'],
      edge: '#a6845a', crown: '#e2c896', rut: '#9c7a52', rutDark: '#6a4e36', rutLit: '#ecd2a2', center: 'sand' },
  },
};

// ---- ground: meadow (Elwynn) ----------------------------------------------------------------

register('ground_meadow', {
  family: 'terrain', size: 512, note: 'anchor: Elwynn grass',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#557f2e');
    mottle(g, s, rnd, { colors: ['#466f27', '#68973a', '#7ba43f', '#517a2b', '#8c9c3c'], count: 46, rmin: 50, rmax: 150, alpha: 0.38, hard: 0.08 });
    mottle(g, s, rnd, { colors: ['#3c6522', '#74a43c', '#5d8a30'], count: 140, rmin: 10, rmax: 34, alpha: 0.3, hard: 0.3, stretch: 1.3 });
    // a few bare earthy spots peeking through
    mottle(g, s, rnd, { colors: ['#6a5a30', '#5e5a2c'], count: 12, rmin: 8, rmax: 20, alpha: 0.28, hard: 0.4 });
    bladePass(g, s, rnd, 1400, ['#2f5419', '#3a611f'], [7, 15], [1.6, 2.6], 0.55);
    bladePass(g, s, rnd, 1500, ['#5b8c2f', '#66983a', '#527f2b'], [7, 14], [1.4, 2.4], 0.6);
    bladePass(g, s, rnd, 700, ['#9cbf55', '#b2cc63', '#8db24a'], [5, 10], [1.1, 1.8], 0.55);
    grassClumps(g, s, rnd, 26, { r: [8, 16], dark: ['#2c4c1c'], mid: ['#6a9c36', '#5e8f31'], lit: ['#b6d06a', '#c4d878'], len: [8, 15], dens: 0.3 });
    for (let i = 0; i < 28; i++) {
      const x = rnd() * s, y = rnd() * s, c = pick(rnd, ['#f4e7a1', '#fffbe6', '#e7c2e8']);
      wrap(s, x, y, 4, (xx, yy) => { blob(g, xx, yy, 2.6, 2.2, 0, c, 0.9, 0.6); blob(g, xx - 0.6, yy - 0.6, 1.2, 1, 0, '#ffffff', 0.7, 0.5); });
    }
    glaze(g, s, s, '#ffe7a0', 0.1, 'soft-light');
    blurTile(cv, 0.35);
  },
});

register('ground2_meadow', {
  family: 'terrain', size: 512, note: 'Elwynn: grass worn through to red-brown earth',
  paint(g, s, rnd, h, cv) {
    const P = BIO.meadow;
    dirtGround(g, s, rnd, P.dirt, { pebbleN: 160, crackN: 3, clods: 120 });
    // islands of grass: clumps cluster around a handful of big patches, so dirt shows in lanes between them
    const cores = []; for (let i = 0; i < 16; i++) cores.push([rnd() * s, rnd() * s, range(rnd, 40, 95)]);
    const near = (x, y) => cores.some(([cx, cy, r]) => { let dx = Math.abs(x - cx), dy = Math.abs(y - cy); dx = Math.min(dx, s - dx); dy = Math.min(dy, s - dy); return dx * dx + dy * dy < r * r; });
    for (const [cx, cy, r] of cores) wrap(s, cx, cy, r * 1.2, (X, Y) => blob(g, X, Y, r * 1.05, r * 0.9, rnd() * 3, '#4a6a26', 0.55, 0.45));
    grassClumps(g, s, rnd, 520, { r: [6, 16], dark: P.grass.dark, mid: P.grass.mid, lit: P.grass.lit, len: [7, 14], dens: 0.42, where: near });
    grassClumps(g, s, rnd, 70, { r: [3, 7], dark: P.grass.dark, mid: ['#6a8a30', '#7a8f36'], lit: ['#a8b858', '#bcc468'], len: [5, 10], dens: 0.5 });
    bladePass(g, s, rnd, 900, ['#9cbf55', '#b2cc63', '#c6c86a'], [4, 9], [1, 1.7], 0.5, undefined, undefined, near);
    glaze(g, s, s, '#ffe0a0', 0.08, 'soft-light');
    blurTile(cv, 0.35);
  },
});

// ---- ground: fields (Westfall) --------------------------------------------------------------

register('ground_fields', {
  family: 'terrain', size: 512, note: 'Westfall: golden dry grass',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#a48f45');
    mottle(g, s, rnd, { colors: ['#b39a4a', '#8e7f3a', '#c9ac52', '#7d7a35', '#a6a048'], count: 50, rmin: 50, rmax: 150, alpha: 0.4, hard: 0.08 });
    mottle(g, s, rnd, { colors: ['#6e6630', '#c4a656', '#8a8a3c'], count: 140, rmin: 10, rmax: 30, alpha: 0.28, hard: 0.3, stretch: 1.3 });
    bladePass(g, s, rnd, 1300, ['#5e5426', '#6b5f2a', '#56562a'], [8, 16], [1.6, 2.6], 0.55, [-0.35, 0.45]);
    bladePass(g, s, rnd, 1500, ['#b49a4c', '#c2a654', '#a89246', '#9a9a48'], [8, 15], [1.4, 2.3], 0.6, [-0.35, 0.45]);
    bladePass(g, s, rnd, 800, ['#e2c56a', '#ecd486', '#d8bd62', '#f0dc98'], [5, 11], [1.1, 1.8], 0.58, [-0.35, 0.45]);
    bladePass(g, s, rnd, 180, ['#7f9a3e', '#8aa246'], [5, 10], [1.2, 2], 0.5);
    glaze(g, s, s, '#ffe6a0', 0.12, 'soft-light');
    blurTile(cv, 0.35);
  },
});

register('ground2_fields', {
  family: 'terrain', size: 512, note: 'Westfall: green-gold pasture with clover',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7f8a3a');
    mottle(g, s, rnd, { colors: ['#6f7e34', '#949a44', '#a89a48', '#5f7030', '#8a8a3c'], count: 50, rmin: 50, rmax: 150, alpha: 0.4, hard: 0.08 });
    mottle(g, s, rnd, { colors: ['#4f6026', '#a4a050', '#7a8436'], count: 150, rmin: 8, rmax: 26, alpha: 0.3, hard: 0.3, stretch: 1.3 });
    bladePass(g, s, rnd, 1300, ['#40501f', '#4c5a24'], [7, 14], [1.6, 2.6], 0.55);
    bladePass(g, s, rnd, 1400, ['#7f9a3e', '#8f9c44', '#a49c4a'], [7, 13], [1.4, 2.3], 0.6);
    bladePass(g, s, rnd, 700, ['#d4c46a', '#c8c870', '#e2d080'], [5, 10], [1.1, 1.8], 0.55);
    // clover leaves
    for (let i = 0; i < 60; i++) {
      const x = rnd() * s, y = rnd() * s;
      wrap(s, x, y, 6, (X, Y) => { for (let k = 0; k < 3; k++) { const a = k * 2.1 + rnd(); blob(g, X + Math.cos(a) * 2.2, Y + Math.sin(a) * 2.2, 2.4, 1.8, a, '#5f7a2e', 0.8, 0.6); } blob(g, X - 1, Y - 1, 1.3, 1, 0, '#a8c060', 0.6, 0.5); });
    }
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s, y = rnd() * s, c = pick(rnd, ['#f6e8b0', '#fff8e0', '#e8b8c8']);
      wrap(s, x, y, 4, (xx, yy) => { blob(g, xx, yy, 2.4, 2, 0, c, 0.9, 0.6); });
    }
    glaze(g, s, s, '#ffe6a0', 0.12, 'soft-light');
    blurTile(cv, 0.35);
  },
});

// ---- ground: badlands -----------------------------------------------------------------------

register('ground_badlands', {
  family: 'terrain', size: 512, note: 'Badlands: ochre dust over cracked hardpan',
  paint(g, s, rnd, h, cv) {
    // hardpan plates
    const F = worley(s, 7, rnd, 0.9);
    paintCells(g, F, { colors: ['#c08a5a', '#c99462', '#b98457', '#cf9a62', '#b47c50'], grout: '#6e3e2a', groutW: 1.3, bevel: 6, dome: 0.12, light: 0.3, varAmt: 0.06, rnd });
    blurTile(cv, 0.6);
    // dust drifts bury the cracks in big soft areas
    mottle(g, s, rnd, { colors: ['#cf9a62', '#d8a873', '#c48e5c', '#b98457'], count: 44, rmin: 50, rmax: 140, alpha: 0.5, hard: 0.15 });
    mottle(g, s, rnd, { colors: ['#a87048', '#d8a873', '#9a6240'], count: 140, rmin: 6, rmax: 22, alpha: 0.2, hard: 0.35, stretch: 1.6 });
    streaks(g, s, rnd, { colors: ['#e2b884', '#b07a50'], count: 60, len: [30, 90], width: [2, 5], angle: 1.2, wobble: 0.15, alpha: 0.14 });
    pebbles(g, s, rnd, { colors: ['#c48a62', '#a86a48', '#d8a478', '#8a5a44', '#9a8a80'], count: 200, rmin: 1.3, rmax: 3.8 });
    pebbles(g, s, rnd, { colors: ['#b47c58', '#8a5a44', '#a89080'], count: 22, rmin: 4, rmax: 8 });
    bladePass(g, s, rnd, 90, ['#7a6238', '#a88a50', '#c8a868'], [5, 10], [1, 1.6], 0.55);
    glaze(g, s, s, '#ffd29a', 0.1, 'soft-light');
    blurTile(cv, 0.3);
  },
});

register('ground2_badlands', {
  family: 'terrain', size: 512, note: 'Badlands: red scree and gravel',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#9e5e3a');
    mottle(g, s, rnd, { colors: ['#8e5034', '#b06a42', '#a65f3a', '#7e462e', '#bf7a4c'], count: 50, rmin: 40, rmax: 130, alpha: 0.42, hard: 0.1 });
    mottle(g, s, rnd, { colors: ['#6e3a26', '#c8865a'], count: 160, rmin: 5, rmax: 16, alpha: 0.24, hard: 0.35 });
    pebbles(g, s, rnd, { colors: ['#b8744c', '#9a5a3c', '#cf8e62', '#7e4a34', '#a88270', '#c49a7a'], count: 900, rmin: 1.5, rmax: 4.5 });
    pebbles(g, s, rnd, { colors: ['#b06a46', '#8e5238', '#c4865e', '#9a8070'], count: 110, rmin: 5, rmax: 11 });
    pebbles(g, s, rnd, { colors: ['#a86444', '#c08060'], count: 12, rmin: 12, rmax: 18 });
    glaze(g, s, s, '#ffcf98', 0.1, 'soft-light');
    blurTile(cv, 0.35);
  },
});

// ---- ground: desert (Tanaris) ---------------------------------------------------------------

function sandRipples(g, s, rnd, light, dark, n = 34, alpha = 0.3) {
  for (let i = 0; i < n; i++) {
    const y0 = (i + rnd() * 0.6) / n * s;
    const wob = periodic(rnd, 4, 1.1, 1), ph = rnd();
    const pts = []; for (let x = -16; x <= s + 16; x += 8) pts.push([x, y0 + wob(x / s + ph) * 14]);
    for (const dy of [-s, 0, s]) {
      stroke(g, pts.map(([x, y]) => [x, y + dy + 2.5]), 3.4, 3.4, dark, alpha * 0.9);
      stroke(g, pts.map(([x, y]) => [x, y + dy]), 2.4, 2.4, light, alpha);
    }
  }
}

register('ground_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: wind-rippled sand',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#dcb985');
    mottle(g, s, rnd, { colors: ['#e8cc96', '#d2ad74', '#c79c62', '#efd6a4', '#d8b47e'], count: 50, rmin: 50, rmax: 160, alpha: 0.42, hard: 0.08 });
    sandRipples(g, s, rnd, '#f3e2b8', '#b48a5a', 30, 0.28);
    mottle(g, s, rnd, { colors: ['#e8cc96', '#dcb985'], count: 60, rmin: 20, rmax: 60, alpha: 0.3, hard: 0.2 });
    mottle(g, s, rnd, { colors: ['#c49a68', '#f0dcb0'], count: 160, rmin: 3, rmax: 9, alpha: 0.2, hard: 0.4 });
    pebbles(g, s, rnd, { colors: ['#c4a47c', '#a88a68', '#e0caa0', '#9a7e64'], count: 70, rmin: 1.3, rmax: 3.4 });
    glaze(g, s, s, '#ffe8b8', 0.12, 'soft-light');
    blurTile(cv, 0.45);
  },
});

register('ground2_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: coarse crusted sand and grit',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#c9a06a');
    mottle(g, s, rnd, { colors: ['#b88e5c', '#d4ac78', '#c79c62', '#ad8452', '#ddb886'], count: 50, rmin: 40, rmax: 140, alpha: 0.42, hard: 0.1 });
    const F = worley(s, 6, rnd, 0.9);
    const cv2 = makeCanvas(s); const g2 = cv2.getContext('2d');
    paintCells(g2, F, { colors: ['#d4ac78', '#c79c62', '#ddb886'], grout: '#8a6440', groutW: 1.1, bevel: 5, dome: 0.1, light: 0.3, varAmt: 0.05, rnd });
    g.save(); g.globalAlpha = 0.45; g.drawImage(cv2, 0, 0); g.restore();
    mottle(g, s, rnd, { colors: ['#d8b480', '#c79c62'], count: 40, rmin: 30, rmax: 90, alpha: 0.35, hard: 0.2 });
    pebbles(g, s, rnd, { colors: ['#d8c09a', '#b89a74', '#e8d4ae', '#9c8268', '#a07a5a'], count: 380, rmin: 1.3, rmax: 3.6 });
    pebbles(g, s, rnd, { colors: ['#c4a47c', '#9c8268'], count: 30, rmin: 4, rmax: 8 });
    bladePass(g, s, rnd, 40, ['#8a7448', '#b8a468'], [5, 9], [1, 1.5], 0.5);
    glaze(g, s, s, '#ffe8b8', 0.1, 'soft-light');
    blurTile(cv, 0.35);
  },
});

// ---- dirt, per biome ---------------------------------------------------------------------------

for (const b of ['meadow', 'fields', 'badlands', 'desert']) {
  register(`dirt_${b}`, {
    family: 'terrain', size: 512, note: `${b}: bare packed dirt for clearings`,
    paint(g, s, rnd, h, cv) {
      const P = BIO[b];
      dirtGround(g, s, rnd, P.dirt, { pebbleN: 300, crackN: b === 'badlands' || b === 'desert' ? 8 : 4 });
      // a scatter of straw, twigs or blades trodden into it
      bladePass(g, s, rnd, b === 'desert' ? 20 : 70, [...P.grass.mid, ...P.grass.dark], [5, 10], [1, 1.6], 0.45, [-1.6, 1.6]);
      glaze(g, s, s, '#ffdca0', 0.08, 'soft-light');
      blurTile(cv, 0.3);
    },
  });
}

// ---- roads (road space) -----------------------------------------------------------------------

register('road_meadow', {
  family: 'terrain', size: 512, note: 'anchor: Elwynn dirt road (road space: across × along) with ruts and a grassy crown',
  paint(g, s, rnd) {
    paintRoad(g, s, rnd, { ...BIO.meadow.road, gDark: BIO.meadow.grass.dark, gMid: BIO.meadow.grass.mid, gLit: BIO.meadow.grass.lit });
  },
});
register('road_fields', {
  family: 'terrain', size: 512, note: 'Westfall dusty road with straw',
  paint(g, s, rnd) {
    paintRoad(g, s, rnd, { ...BIO.fields.road, gDark: BIO.fields.grass.dark, gMid: BIO.fields.grass.mid, gLit: BIO.fields.grass.lit,
      extra(g, s, rnd) { bladePass(g, s, rnd, 160, ['#e2c56a', '#c9a64e', '#f0dc98'], [6, 14], [1, 1.6], 0.5, [-1.6, 1.6], [-0.1, 0.1]); } });
  },
});
register('road_badlands', {
  family: 'terrain', size: 512, note: 'Badlands red packed road with gravel',
  paint(g, s, rnd) {
    paintRoad(g, s, rnd, { ...BIO.badlands.road, gDark: ['#6a4a30'], gMid: ['#a07a48', '#8a6a40'], gLit: ['#cfae72'],
      extra(g, s, rnd) {
        const c = s / 2, mpx = s / 10;
        pebblesWhere(g, s, rnd, 400, BIO.badlands.road.peb, 1.5, 4, x => Math.abs(x - c) < 0.5 * mpx ? 1 : 0);
      } });
  },
});
register('road_desert', {
  family: 'terrain', size: 512, note: 'Tanaris sandy track, sand drifting into the crown',
  paint(g, s, rnd) {
    paintRoad(g, s, rnd, { ...BIO.desert.road, gDark: null,
      extra(g, s, rnd) {
        // sand drifting across the edges
        for (let i = 0; i < 26; i++) {
          const side = rnd() < 0.5, x = side ? range(rnd, 0, 110) : range(rnd, s - 110, s), y = rnd() * s, r = range(rnd, 20, 50);
          wrap(s, x, y, r * 1.6, (X, Y) => blob(g, X, Y, r * 1.6, r * 0.7, range(rnd, -0.3, 0.3), '#e4c896', 0.35, 0.3));
        }
        sandRipples(g, s, rnd, '#f0dcb0', '#b08a5c', 14, 0.14);
      } });
  },
});

// ---- cliffs ------------------------------------------------------------------------------------

register('cliff_meadow', {
  family: 'terrain', size: 512, note: 'Elwynn gray stone, moss on the ledges',
  paint(g, s, rnd) {
    paintRock(g, s, rnd, { cells: 4, colors: ['#8a867e', '#77746e', '#97918a', '#6f6d68', '#a29b90'], grout: '#3c3640', moss: '#5e7a34', mossW: 16, mossAmt: 0.85,
      blot: ['#6d7a4a', '#9a958c', '#6a6670'], tuft: ['#4e6a2a', '#8cae4a'] });
  },
});
register('cliff_fields', {
  family: 'terrain', size: 512, note: 'Westfall brown-gray rock with dry grass on the ledges',
  paint(g, s, rnd) {
    paintRock(g, s, rnd, { cells: 4, colors: ['#8a8170', '#9a907c', '#7a7262', '#a89d86', '#857a66'], grout: '#43363a', moss: '#a89448', mossW: 13, mossAmt: 0.75,
      blot: ['#a08a5a', '#6e665a', '#b0a488'], tuft: ['#8a7a38', '#d8c070'] });
  },
});
register('cliff_badlands', {
  family: 'terrain', size: 512, note: 'Thousand Needles red strata',
  paint(g, s, rnd) {
    paintStrata(g, s, rnd, { band: [22, 64], colors: ['#8e3e22', '#b4552f', '#cf7a45', '#e3a066', '#a8492a', '#c26437', '#9c4a2c'],
      blot: ['#7a3420', '#d88a52', '#b4552f', '#e8b080'], deep: '#4a2230', glaze: '#ffcf98' });
  },
});
register('cliff_desert', {
  family: 'terrain', size: 512, note: 'Tanaris pale sandstone strata',
  paint(g, s, rnd) {
    paintStrata(g, s, rnd, { band: [18, 56], colors: ['#b7895e', '#d4ab7c', '#c49a6c', '#e0bf92', '#a97d55', '#cba076'],
      blot: ['#a07450', '#e8caa0', '#c49a6c'], deep: '#6a4a44', glaze: '#ffe6b8' });
  },
});

// ---- mud ---------------------------------------------------------------------------------------

register('mud', {
  family: 'terrain', size: 512, note: 'wet churned mud with sky-lit puddles',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#55402c');
    mottle(g, s, rnd, { colors: ['#4a3626', '#634a32', '#3e2e22', '#6e5438', '#58432e'], count: 60, rmin: 30, rmax: 120, alpha: 0.42, hard: 0.12 });
    // churned ridges: short lit/shadowed smears
    for (let i = 0; i < 260; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 8, 26), a = range(rnd, -0.5, 0.5) + (rnd() < 0.5 ? 0 : Math.PI / 2), w = range(rnd, 2, 5);
      const pts = [[x, y], [x + Math.cos(a) * L * 0.5, y + Math.sin(a) * L * 0.5 + range(rnd, -2, 2)], [x + Math.cos(a) * L, y + Math.sin(a) * L]];
      wrap(s, x, y, L + 6, (X, Y) => {
        const P = pts.map(([u, v]) => [u - x + X, v - y + Y]);
        stroke(g, P.map(([u, v]) => [u + 1.5, v + 2]), w * 1.3, w * 0.6, '#2a1e18', 0.35);
        stroke(g, P, w, w * 0.5, pick(rnd, ['#7a6044', '#86684a', '#6e563c']), 0.6);
        stroke(g, P.map(([u, v]) => [u - 0.8, v - 0.9]), w * 0.45, w * 0.2, '#b09878', 0.35);
      });
    }
    // puddles: dark rim, sky reflection, a bright glint on the upper left
    for (let i = 0; i < 16; i++) {
      const x = rnd() * s, y = rnd() * s, rx = range(rnd, 14, 46), ry = rx * range(rnd, 0.4, 0.7), rot = range(rnd, -0.4, 0.4);
      wrap(s, x, y, rx * 1.3, (X, Y) => {
        blob(g, X, Y, rx * 1.2, ry * 1.25, rot, '#2c2018', 0.6, 0.5);
        ellipse(g, X, Y, rx, ry, rot, '#5e6a70', 0.95);
        blob(g, X + rx * 0.1, Y + ry * 0.15, rx * 0.95, ry * 0.85, rot, '#7f9098', 0.8, 0.4);
        blob(g, X - rx * 0.35, Y - ry * 0.3, rx * 0.4, ry * 0.18, rot, '#e4eef0', 0.55, 0.3);
        blob(g, X + rx * 0.3, Y + ry * 0.35, rx * 0.5, ry * 0.3, rot, '#3e4a52', 0.4, 0.3);
      });
    }
    pebbles(g, s, rnd, { colors: ['#8a7660', '#6e5c4a', '#a08c74'], count: 60, rmin: 1.5, rmax: 4 });
    glaze(g, s, s, '#ffd8a0', 0.06, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// ---- macro variation (data, not color: R = huge blotches, G = big, B = medium) ------------------

register('terrain_macro', {
  family: 'terrain', size: 256, note: 'R/G/B = low/mid/high-frequency soft noise (data)',
  paint(g, s, rnd) {
    const chan = (count, rmin, rmax, blur, alpha) => {
      const c = makeCanvas(s), cg = c.getContext('2d');
      fill(cg, s, s, '#808080');
      mottle(cg, s, rnd, { colors: ['#000000', '#ffffff'], count, rmin, rmax, alpha, hard: 0.05 });
      blurTile(c, blur);
      return cg.getImageData(0, 0, s, s).data;
    };
    const R = chan(70, 30, 90, 8, 0.5), G = chan(160, 14, 40, 4, 0.45), B = chan(500, 4, 12, 1.5, 0.5);
    const img = g.getImageData(0, 0, s, s), D = img.data;
    // stretch each channel's contrast to fill 0..255
    const norm = A => { let lo = 255, hi = 0; for (let i = 0; i < A.length; i += 4) { lo = Math.min(lo, A[i]); hi = Math.max(hi, A[i]); } return v => (v - lo) / Math.max(1, hi - lo) * 255; };
    const nr = norm(R), ng = norm(G), nb = norm(B);
    for (let i = 0; i < D.length; i += 4) { D[i] = nr(R[i]); D[i + 1] = ng(G[i]); D[i + 2] = nb(B[i]); D[i + 3] = 255; }
    g.putImageData(img, 0, 0);
  },
});

// ---- ground-clutter atlases (2×2 cells of 256; base of each card at the cell's bottom) ---------

// A tuft of blades fanning up from (cx, by). Each blade shades from a dark cool base to a lit tip.
function tuft(g, cx, by, rnd, { n = 40, spread = 60, len = [110, 220], wid = [7, 12], fan = 0.7, cols, tip, base = '#1f3214', bend = 0.35 }) {
  const order = [];
  for (let i = 0; i < n; i++) order.push(i);
  for (const i of order) {
    const bx = cx + range(rnd, -spread, spread) * (0.4 + 0.6 * rnd());
    const a = (bx - cx) / spread * fan * 0.8 + range(rnd, -0.25, 0.25);
    const L = range(rnd, len[0], len[1]) * (1 - Math.abs(bx - cx) / spread * 0.35);
    const w = range(rnd, wid[0], wid[1]);
    const c = pick(rnd, cols);
    const b = range(rnd, -bend, bend) + a * 0.4;
    const gr = g.createLinearGradient(0, by, 0, by - L);
    gr.addColorStop(0, base); gr.addColorStop(0.35, shadowOf(c, 0.2)); gr.addColorStop(0.75, c); gr.addColorStop(1, tip ? pick(rnd, tip) : lightOf(c, 0.4));
    const pts = [];
    for (let k = 0; k <= 6; k++) { const t = k / 6, aa = a + b * t * t; pts.push([bx + Math.sin(aa) * L * t, by - Math.cos(aa) * L * t]); }
    stroke(g, pts, w, w * 0.12, gr, 1);
    // a lit edge on the left side of each blade
    stroke(g, pts.slice(2).map(([x, y]) => [x - w * 0.22, y]), w * 0.3, 0.5, lightOf(c, 0.5), 0.35);
  }
}

function flowerHead(g, x, y, r, petal, center, rnd, petals = 5) {
  const rot = rnd() * TAU;
  blob(g, x + r * 0.25, y + r * 0.3, r * 1.25, r, 0, '#1e2a14', 0.35, 0.3);
  for (let k = 0; k < petals; k++) {
    const a = rot + k / petals * TAU;
    const px = x + Math.cos(a) * r * 0.55, py = y + Math.sin(a) * r * 0.45;
    ellipse(g, px, py, r * 0.55, r * 0.34, a, shadowOf(petal, 0.18));
    ellipse(g, px - 0.6, py - 0.8, r * 0.45, r * 0.26, a, petal);
  }
  blob(g, x - r * 0.3, y - r * 0.3, r * 0.6, r * 0.45, 0, lightOf(petal, 0.6), 0.6, 0.4);
  ellipse(g, x, y, r * 0.28, r * 0.24, 0, center);
  blob(g, x - r * 0.08, y - r * 0.1, r * 0.13, r * 0.1, 0, lightOf(center, 0.7), 0.9, 0.5);
}

function stem(g, x, by, h, lean, col, w = 4) {
  const pts = []; for (let k = 0; k <= 5; k++) { const t = k / 5; pts.push([x + Math.sin(lean) * h * t + Math.sin(t * 3) * 3, by - h * t]); }
  stroke(g, pts, w, w * 0.6, col, 1);
  return pts[pts.length - 1];
}

function flowersCell(g, ox, oy, rnd, { petals, centers, leaf, grass }) {
  tuft(g, ox + 128, oy + 250, rnd, { n: 22, spread: 70, len: [70, 140], wid: [6, 10], cols: grass.mid, tip: grass.lit, base: grass.dark[0] });
  const n = 7;
  for (let i = 0; i < n; i++) {
    const x = ox + 128 + range(rnd, -80, 80), h = range(rnd, 90, 190), lean = range(rnd, -0.25, 0.25);
    const [tx, ty] = stem(g, x, oy + 250, h, lean, leaf, 4.5);
    // two leaves
    for (const s of [-1, 1]) { const ly = oy + 250 - h * range(rnd, 0.2, 0.5); ellipse(g, x + s * 12, ly, 14, 5, s * 0.6, leaf); ellipse(g, x + s * 11 - 1, ly - 1.5, 9, 2.5, s * 0.6, lightOf(leaf, 0.4), 0.7); }
    flowerHead(g, tx, ty, range(rnd, 15, 22), pick(rnd, petals), pick(rnd, centers), rnd);
  }
}

function wheatCell(g, ox, oy, rnd, { stalk, head, headLit, n = 18 }) {
  for (let i = 0; i < n; i++) {
    const x = ox + 128 + range(rnd, -90, 90), h = range(rnd, 170, 240), lean = range(rnd, -0.12, 0.12) + (x - ox - 128) / 90 * 0.1;
    const [tx, ty] = stem(g, x, oy + 252, h * 0.72, lean, pick(rnd, stalk), 3.5);
    // the head: a column of kernels with awns
    const hl = h * 0.3, ang = lean * 1.6;
    for (let k = 0; k < 8; k++) {
      const t = k / 7, kx = tx + Math.sin(ang) * hl * t, ky = ty - Math.cos(ang) * hl * t;
      for (const s of [-1, 1]) {
        const ex = kx + s * 4.5, ey = ky;
        ellipse(g, ex, ey, 4.2 * (1 - t * 0.3), 7 * (1 - t * 0.3), ang + s * 0.35, shadowOf(head, 0.15));
        ellipse(g, ex - 0.8, ey - 1, 2.8 * (1 - t * 0.3), 5 * (1 - t * 0.3), ang + s * 0.35, s < 0 ? headLit : head);
        stroke(g, [[ex, ey - 3], [ex + s * 7 + Math.sin(ang) * 14, ey - 18]], 1.1, 0.4, headLit, 0.7);
      }
    }
  }
}

function twigsCell(g, ox, oy, rnd, { col, lit, n = 6 }) {
  const branch = (x, y, a, L, w, d) => {
    const x2 = x + Math.sin(a) * L, y2 = y - Math.cos(a) * L;
    stroke(g, [[x, y], [(x + x2) / 2 + range(rnd, -3, 3), (y + y2) / 2], [x2, y2]], w, w * 0.55, col, 1);
    stroke(g, [[x - w * 0.25, y], [x2 - w * 0.2, y2]], w * 0.3, w * 0.15, lit, 0.5);
    if (d < 3) { const k = 1 + Math.floor(rnd() * 2.2); for (let i = 0; i < k; i++) branch(x2, y2, a + range(rnd, -0.8, 0.8), L * range(rnd, 0.5, 0.75), w * 0.62, d + 1); }
  };
  for (let i = 0; i < n; i++) branch(ox + 128 + range(rnd, -40, 40), oy + 252, range(rnd, -0.5, 0.5), range(rnd, 60, 100), range(rnd, 6, 9), 0);
}

function sageCell(g, ox, oy, rnd, { leaf, lit, wood }) {
  twigsCell(g, ox, oy, rnd, { col: wood, lit: lightOf(wood, 0.4), n: 5 });
  for (let i = 0; i < 90; i++) {
    const a = rnd() * Math.PI - Math.PI / 2, r = Math.sqrt(rnd()) * 100;
    const x = ox + 128 + Math.sin(a) * r, y = oy + 250 - Math.abs(Math.cos(a)) * r * 1.4 - 10;
    const c = jitter(pick(rnd, leaf), rnd, 0.08);
    ellipse(g, x + 1.5, y + 2, 9, 5, rnd() * 3, shadowOf(c, 0.4), 0.8);
    ellipse(g, x, y, 8, 4.5, rnd() * 3, c);
    blob(g, x - 2, y - 1.5, 4, 2, 0, pick(rnd, lit), 0.7, 0.4);
  }
}

function clutterAtlas(cells) {
  return (g, s, rnd) => {
    cells.forEach((fn, i) => {
      const ox = (i % 2) * 256, oy = Math.floor(i / 2) * 256;
      g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, 252, 252); g.clip();
      fn(g, ox, oy, rnd);
      g.restore();
    });
  };
}

const MG = BIO.meadow.grass;
register('clutter_meadow', {
  family: 'terrain', size: 512, alpha: true, note: 'cells: grass tuft, tall grass, buttercups+daisies, peacebloom (purple)',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 252, rnd, { n: 46, spread: 78, len: [100, 200], wid: [8, 13], cols: ['#4f8a2a', '#5b9a30', '#6aa236', '#46802a'], tip: ['#b8d468', '#c8dc78', '#a6c85a'], base: '#1f3a14' }),
    (g, ox, oy, rnd) => {
      tuft(g, ox + 128, oy + 252, rnd, { n: 30, spread: 70, len: [150, 240], wid: [6, 10], cols: ['#5f9030', '#709a36', '#7fa23c'], tip: ['#d4d878', '#e0d488'], base: '#22401a' });
      for (let i = 0; i < 6; i++) { const x = ox + 128 + range(rnd, -60, 60); const [tx, ty] = stem(g, x, oy + 250, range(rnd, 170, 235), range(rnd, -0.2, 0.2), '#7a9a3a', 2.5); ellipse(g, tx, ty - 6, 4, 12, 0, '#c8b868'); ellipse(g, tx - 1, ty - 8, 2, 7, 0, '#f0e4a0'); }
    },
    (g, ox, oy, rnd) => flowersCell(g, ox, oy, rnd, { petals: ['#f6d84a', '#fbe36a', '#fff8ec', '#f8f2e0'], centers: ['#e8a030', '#d88a28'], leaf: '#4a7a28', grass: MG }),
    (g, ox, oy, rnd) => flowersCell(g, ox, oy, rnd, { petals: ['#b48ad8', '#9a78d0', '#c8a0e0', '#e8a0b8'], centers: ['#f4d860', '#fff0a0'], leaf: '#3e6e28', grass: MG }),
  ]),
});
const FG = BIO.fields.grass;
register('clutter_fields', {
  family: 'terrain', size: 512, alpha: true, note: 'cells: golden tuft, wheat, green-gold tuft, poppies',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 252, rnd, { n: 44, spread: 80, len: [110, 210], wid: [7, 11], cols: ['#b49a4c', '#c2a654', '#a89246', '#9c8a40'], tip: ['#f0dc98', '#ecd486', '#f6e4a8'], base: '#4a4020', fan: 0.6 }),
    (g, ox, oy, rnd) => wheatCell(g, ox, oy, rnd, { stalk: ['#b8963e', '#c8a44a', '#a8883a'], head: '#d8b05a', headLit: '#f4dc90', n: 16 }),
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 252, rnd, { n: 42, spread: 76, len: [90, 180], wid: [7, 12], cols: ['#8a9a40', '#9c9c48', '#7f9038', '#a8a04c'], tip: ['#e0d07a', '#d8d888'], base: '#2e3a18' }),
    (g, ox, oy, rnd) => flowersCell(g, ox, oy, rnd, { petals: ['#d8483a', '#e45a40', '#c83a30', '#f0d060'], centers: ['#2a2020', '#3a2a20'], leaf: '#5a7a2a', grass: { dark: FG.dark, mid: ['#9c9c48', '#8a9a40'], lit: FG.lit } }),
  ]),
});
register('clutter_badlands', {
  family: 'terrain', size: 512, alpha: true, note: 'cells: dry tuft, dead twigs, sage, thin dry grass',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 252, rnd, { n: 30, spread: 70, len: [80, 170], wid: [6, 10], cols: ['#b89858', '#a88a50', '#c8a868', '#9a7a48'], tip: ['#ead4a0', '#e2c88a'], base: '#5a4028', fan: 0.9, bend: 0.6 }),
    (g, ox, oy, rnd) => twigsCell(g, ox, oy, rnd, { col: '#6a4a36', lit: '#a88a70', n: 6 }),
    (g, ox, oy, rnd) => sageCell(g, ox, oy, rnd, { leaf: ['#8a9a78', '#7a8a6a', '#9aa888'], lit: ['#c8d4b0', '#b8c8a0'], wood: '#5e4636' }),
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 252, rnd, { n: 18, spread: 60, len: [60, 140], wid: [5, 8], cols: ['#c8a868', '#b89858'], tip: ['#f0dcae'], base: '#6a4a30', fan: 1.1, bend: 0.8 }),
  ]),
});
register('clutter_desert', {
  family: 'terrain', size: 512, alpha: true, note: 'cells: dry tuft, bleached twigs, desert sage, tiny desert flowers',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 252, rnd, { n: 24, spread: 66, len: [70, 150], wid: [5, 9], cols: ['#c4ae72', '#b8a468', '#d4bc80'], tip: ['#f2e2b4', '#ecdcaa'], base: '#7a6440', fan: 1.0, bend: 0.7 }),
    (g, ox, oy, rnd) => twigsCell(g, ox, oy, rnd, { col: '#8a7058', lit: '#d8c8b0', n: 5 }),
    (g, ox, oy, rnd) => sageCell(g, ox, oy, rnd, { leaf: ['#9aa488', '#8a9a7c', '#aab496'], lit: ['#d8e0c4'], wood: '#7a6048' }),
    (g, ox, oy, rnd) => {
      sageCell(g, ox, oy, rnd, { leaf: ['#7a8a5c', '#6a7a50'], lit: ['#b8c890'], wood: '#6a5040' });
      for (let i = 0; i < 9; i++) flowerHead(g, ox + 128 + range(rnd, -70, 70), oy + 250 - range(rnd, 40, 130), range(rnd, 8, 12), pick(rnd, ['#f0a0c0', '#f8d070', '#f4f0e0']), '#c87a30', rnd, 5);
    },
  ]),
});

// ---- the sky: painted cumulus band (x = azimuth, y = elevation; bottom row = the horizon) -----

register('sky_clouds', {
  family: 'terrain', w: 2048, h: 512, alpha: true, note: 'cloud band around the sky dome (bottom = horizon)',
  paint(g, w, rnd, h) {
    const VX = 2.2, VW = w * VX;   // paint in "round" virtual space, squashed into the band
    g.setTransform(1 / VX, 0, 0, 1, 0, 0);
    const at = (x, fn) => { for (const o of [-VW, 0, VW]) if (x + o > -900 && x + o < VW + 900) fn(x + o); };
    // high thin streaks first
    for (let i = 0; i < 26; i++) {
      const x = rnd() * VW, y = range(rnd, 40, 300), L = range(rnd, 300, 900), th = range(rnd, 6, 18);
      at(x, X => { for (let k = 0; k < 6; k++) blob(g, X + (k - 2.5) * L / 7 + range(rnd, -30, 30), y + range(rnd, -5, 5), L / 5, th, range(rnd, -0.04, 0.04), '#f4f2ee', 0.16, 0.2); });
    }
    const clusters = [];
    for (let i = 0; i < 22; i++) {
      const yb = range(rnd, 300, 500);
      const sz = 0.35 + (500 - yb) / 200 * 0.75;   // bigger higher up (nearer)
      clusters.push({ x: rnd() * VW, yb, w: range(rnd, 380, 900) * sz, sz });
    }
    clusters.sort((a, b) => a.yb - b.yb);
    for (const C of clusters) {
      const n = 7 + Math.floor(rnd() * 8);
      const puffs = [];
      for (let k = 0; k < n; k++) {
        const t = (k + rnd() * 0.8) / n;
        const mid = 1 - Math.abs(t - 0.5) * 1.5;
        const r = C.w * range(rnd, 0.1, 0.17) * (0.55 + mid * 0.7);
        puffs.push({ x: C.x + (t - 0.5) * C.w, y: C.yb - r * 0.55 - mid * C.w * 0.08 * range(rnd, 0.5, 1.2), r });
      }
      for (let k = 0; k < 3; k++) puffs.push({ x: C.x + range(rnd, -0.2, 0.2) * C.w, y: C.yb - C.w * range(rnd, 0.16, 0.26), r: C.w * range(rnd, 0.11, 0.16) });
      at(C.x, X => {
        const dx = X - C.x;
        // flat shaded base
        blob(g, X, C.yb - C.w * 0.03, C.w * 0.52, C.w * 0.06, 0, '#a7aec8', 0.75, 0.55);
        for (const p of puffs) blob(g, p.x + dx, p.y, p.r, p.r, 0, '#aeb5cf', 0.95, 0.62);
        for (const p of puffs) blob(g, p.x + dx - p.r * 0.1, p.y - p.r * 0.18, p.r * 0.86, p.r * 0.8, 0, '#e9e8ee', 0.95, 0.55);
        for (const p of puffs) blob(g, p.x + dx - p.r * 0.22, p.y - p.r * 0.34, p.r * 0.52, p.r * 0.46, 0, '#fffaf0', 0.85, 0.45);
        // cool shade along the underside
        blob(g, X, C.yb - C.w * 0.02, C.w * 0.45, C.w * 0.035, 0, '#9098b8', 0.5, 0.4);
      });
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    // fade everything out toward the very bottom so clouds sink into the horizon haze
    g.save(); g.globalCompositeOperation = 'destination-out';
    const gr = g.createLinearGradient(0, h - 40, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr; g.fillRect(0, h - 40, w, 40);
    g.restore();
  },
});

// ---- the horizon: three rows of mountain silhouettes (far / mid / near), alpha -----------------

const MTN = {
  meadow: [
    { col: '#8a9aa6', lo: 0.30, hi: 0.95, peaks: 'jagged' },
    { col: '#6f8a7e', lo: 0.22, hi: 0.62, peaks: 'round' },
    { col: '#4f6c48', lo: 0.18, hi: 0.42, peaks: 'forest' },
  ],
  fields: [
    { col: '#9c9a8a', lo: 0.25, hi: 0.70, peaks: 'round' },
    { col: '#a29a66', lo: 0.18, hi: 0.45, peaks: 'round' },
    { col: '#8a8a4c', lo: 0.14, hi: 0.32, peaks: 'forest' },
  ],
  badlands: [
    { col: '#b07a5c', lo: 0.25, hi: 0.80, peaks: 'mesa' },
    { col: '#a8603e', lo: 0.20, hi: 0.60, peaks: 'mesa' },
    { col: '#94523a', lo: 0.14, hi: 0.40, peaks: 'jagged' },
  ],
  desert: [
    { col: '#c4a07e', lo: 0.20, hi: 0.70, peaks: 'mesa' },
    { col: '#d0ac84', lo: 0.14, hi: 0.40, peaks: 'dune' },
    { col: '#c49a6a', lo: 0.10, hi: 0.28, peaks: 'dune' },
  ],
};

function profile(rnd, kind, w) {
  const a = periodic(rnd, 7, 1.1, 2), b = periodic(rnd, 10, 0.8, 9), c = periodic(rnd, 6, 0.6, 40);
  const P = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const t = x / w;
    let v;
    if (kind === 'jagged') v = 0.5 + 0.38 * a(t) + 0.22 * (1 - Math.abs(b(t)) * 2) * 0.6 + 0.05 * c(t);
    else if (kind === 'round') v = 0.5 + 0.42 * a(t) + 0.1 * b(t) + 0.02 * c(t);
    else if (kind === 'forest') v = 0.5 + 0.38 * a(t) + 0.08 * b(t) + 0.06 * Math.sqrt(Math.abs(Math.sin(t * TAU * 160 + 3 * b(t))));
    else if (kind === 'mesa') { const m = 0.5 + 0.5 * a(t); v = 0.15 + 0.35 * smooth(0.42, 0.5, m) + 0.35 * smooth(0.62, 0.68, m) + 0.04 * b(t) + 0.015 * c(t); }
    else { const u = (t * 9 + 0.3 * a(t)) % 1; v = 0.4 + 0.3 * a(t) + 0.18 * (u < 0.7 ? u / 0.7 : (1 - u) / 0.3) * 0.8; }
    P[x] = v;
  }
  return P;
}
const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

for (const b of Object.keys(MTN)) {
  register(`sky_mtn_${b}`, {
    family: 'terrain', w: 2048, h: 768, alpha: true, note: `${b}: distant ranges, rows far/mid/near (fog-tinted in the shader)`,
    paint(g, w, rnd, h) {
      const img = g.createImageData(w, h), D = img.data;
      const rowH = h / 3;
      MTN[b].forEach((L, row) => {
        const P = profile(rnd, L.peaks, w);
        const base = hex(L.col), lit = hex(lightOf(L.col, 0.35)), dark = hex(shadowOf(L.col, 0.3)), haze = hex(mix(L.col, '#e8eef0', 0.25));
        const rel = periodic(rnd, 9, 0.7, 6), rel2 = periodic(rnd, 6, 0.9, 20);
        for (let x = 0; x < w; x++) {
          const top = (L.lo + (L.hi - L.lo) * P[x]) * rowH;     // height in px from the row bottom
          const sl = (P[(x + 6) % w] - P[(x - 6 + w) % w]) * (L.hi - L.lo) * rowH / 12;   // >0: rising to the right → faces the light
          for (let yy = 0; yy < rowH; yy++) {
            const hb = rowH - 1 - yy;                            // height of this pixel above the row bottom
            const a = Math.max(0, Math.min(1, top - hb + 0.5));
            const k = ((row * rowH + yy) * w + x) * 4;
            if (a <= 0) { D[k] = base.r; D[k + 1] = base.g; D[k + 2] = base.b; D[k + 3] = 0; continue; }
            const depth = (top - hb) / Math.max(8, top);         // 0 at the ridge → 1 at the bottom
            // facets: light on slopes that face left, ridged relief inside the silhouette
            const facet = Math.max(-1, Math.min(1, sl * 1.4 + (rel(x / w + hb / w * 2.2) * 0.9 + rel2(x / w - hb / w * 1.4) * 0.5) * (1 - depth * 0.5)));
            let c = facet > 0 ? mixRGB(base, lit, facet * 0.85) : mixRGB(base, dark, -facet * 0.8);
            c = mixRGB(c, haze, Math.min(1, depth * 0.85));     // valley haze toward the base
            if (top - hb < 2.5) c = mixRGB(c, lit, 0.35);         // a lit rim along the ridge
            D[k] = c.r; D[k + 1] = c.g; D[k + 2] = c.b; D[k + 3] = Math.round(a * 255);
          }
        }
      });
      g.putImageData(img, 0, 0);
    },
  });
}
function mixRGB(a, b, t) { return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }; }
