// Texture family: terrain. See docs/ART.md for the style rules.
//
// Per biome b in meadow | fields | snow | badlands | desert:
//   ground_<b>    the main ground (512, world-space, ~6 m a tile)
//   ground2_<b>   a second ground, blended in by large-scale noise
//   dirt_<b>      bare packed dirt (camp clearings, yards, the town square)
//   road_<b>      the dirt road in ROAD SPACE: x runs across the road (edge to edge,
//                 plus a grassy shoulder), y runs along it, so the wheel ruts follow the road
//   cliff_<b>     steep faces, projected from the side (y = world height, so strata stay level)
//   clutter_<b>   2×2 alpha atlas of ground-clutter cards (grass tufts, flowers, wheat, twigs)
//   sky_mtn_<b>   3 rows of distant mountain silhouettes (far, mid, near) for the horizon ring
// Shared: mud (slush on the snow day), terrain_macro (RGB low-frequency variation, not color),
// sky_clouds (alpha).
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
// Each pass is painted at full strength into a layer and laid down once at alpha, so a blade's
// overlapping segments never bead up into dots.
function bladePass(g, s, rnd, n, cols, len, wid, alpha, ang = [-0.45, 0.55], bend = [-0.3, 0.4], where = null) {
  const Ly = makeCanvas(s), lg = Ly.getContext('2d');
  for (let i = 0; i < n; i++) {
    let x = rnd() * s, y = rnd() * s;
    if (where && !where(x, y)) continue;
    const L = range(rnd, len[0], len[1]), a = range(rnd, ang[0], ang[1]), w = range(rnd, wid[0], wid[1]), c = pick(rnd, cols), b = range(rnd, bend[0], bend[1]);
    wrap(s, x, y, L + 2, (xx, yy) => blade(lg, xx, yy, L, a, w, c, 1, b));
  }
  g.save(); g.globalAlpha = alpha; g.drawImage(Ly, 0, 0); g.restore();
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

// Half-buried stones: each one is mixed toward the ground it sits in (so it never reads as a white
// grain of rice), lit on the upper left, with a soft cool contact shadow and a little ring of dust.
// where(x, y) → 0..1 density (reject-sampled).
function stones(g, s, rnd, { colors, count, rmin, rmax, ground = null, sink = 0.3, where = null, alpha = 1 }) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * s, y = rnd() * s;
    if (where && rnd() > where(x, y)) continue;
    const r = range(rnd, rmin, rmax), ry = r * range(rnd, 0.55, 0.85), rot = range(rnd, -0.5, 0.5);
    let c = pick(rnd, colors);
    if (ground) c = mix(c, ground, sink * range(rnd, 0.6, 1.3));
    wrap(s, x, y, r * 2.2, (X, Y) => {
      if (ground) blob(g, X, Y + ry * 0.3, r * 1.6, ry * 1.4, rot, lightOf(ground, 0.12), 0.25 * alpha, 0.3);
      blob(g, X + r * 0.3, Y + ry * 0.45, r * 1.2, ry * 1.1, rot, '#2a2030', 0.32 * alpha, 0.25);
      ellipse(g, X, Y, r, ry, rot, c, alpha);
      blob(g, X + r * 0.25, Y + ry * 0.3, r * 0.75, ry * 0.6, rot, shadowOf(c, 0.3), 0.45 * alpha, 0.35);
      blob(g, X - r * 0.28, Y - ry * 0.32, r * 0.5, ry * 0.4, rot, lightOf(c, 0.35), 0.55 * alpha, 0.35);
    });
  }
}
function pebblesWhere(g, s, rnd, n, cols, rmin, rmax, where, alpha = 1, ground = null) {
  stones(g, s, rnd, { colors: cols, count: n, rmin, rmax, where: where ? (x, y) => where(x, y) : null, alpha, ground, sink: 0.3 });
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
  stones(g, s, rnd, { colors: P.peb, count: Math.round(pebbleN * 0.55), rmin: 1.4, rmax: 3.6, ground: P.base, sink: 0.4 });
  stones(g, s, rnd, { colors: P.peb, count: Math.round(pebbleN / 12), rmin: 4, rmax: 8, ground: P.base, sink: 0.3 });
  if (crackN) cracks(g, s, rnd, { color: shadowOf(P.base, 0.6), count: crackN, len: [16, 44], width: [0.8, 1.6], alpha: 0.4 });
}

// Wheel ruts running along y at x = x0 (road space). Compacted, darker, shadowed left wall, lit right wall.
function rut(g, s, rnd, x0, w, P) {
  const wob = periodic(rnd, 4, 1.4, 1), wob2 = periodic(rnd, 3, 1, 3);
  const pts = k => { const out = []; for (let y = -24; y <= s + 24; y += 12) out.push([x0 + k + wob(y / s) * 7 + wob2(y / s) * 2, y]); return out; };
  stroke(g, pts(0), w * 1.9, w * 1.9, P.rut, 0.1);
  stroke(g, pts(0), w * 1.1, w * 1.1, P.rut, 0.13);
  stroke(g, pts(-w * 0.4), w * 0.3, w * 0.3, P.rutDark, 0.12);
  stroke(g, pts(w * 0.45), w * 0.25, w * 0.25, P.rutLit, 0.14);
  // dark damp spots in the ruts
  for (let i = 0; i < 6; i++) {
    const y = rnd() * s, L = range(rnd, 14, 40);
    wrap(s, x0, y, L, (X, Y) => blob(g, X + wob(Y / s) * 7, Y, w * 0.5, L, Math.PI / 2, P.rutDark, 0.12, 0.3));
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
  blurTile(g.canvas, 2.2);
  // gravel: heavier on the crown and the shoulders, sparse in the ruts
  const dens = x => { const d = Math.abs(x - c) / mpx; return d < 0.6 ? 0.9 : d < 1.4 ? 0.2 : d < 3.0 ? 0.7 : 1; };
  pebblesWhere(g, s, rnd, 420, P.peb, 1.3, 3.4, dens, 1, P.base);
  pebblesWhere(g, s, rnd, 40, P.peb, 3.5, 6.5, x => dens(x) * 0.8, 1, P.base);
  cracks(g, s, rnd, { color: shadowOf(P.base, 0.6), count: 4, len: [14, 36], width: [0.7, 1.4], alpha: 0.35 });
  // the center strip
  const inStrip = (x) => Math.abs(x - c) < 0.42 * mpx;
  if (P.center === 'grass' || P.center === 'dry') {
    const strip = (x, y) => inStrip(x) && rnd() < 0.75 - Math.abs(x - c) / (0.42 * mpx) * 0.5;
    bladePass(g, s, rnd, 900, P.gDark, [5, 11], [1.3, 2.2], 0.42, [-0.5, 0.5], [-0.2, 0.3], strip);
    bladePass(g, s, rnd, 900, P.gMid, [4, 10], [1.2, 2], 0.7, [-0.5, 0.5], [-0.2, 0.3], strip);
    bladePass(g, s, rnd, 380, P.gLit, [3, 7], [1, 1.6], 0.5, [-0.5, 0.5], [-0.2, 0.3], strip);
  } else if (P.center === 'sand') {
    for (let y = -20; y < s + 20; y += 6) {
      const w = 0.35 * mpx * (0.6 + 0.4 * Math.sin(y / s * TAU * 3 + 1.3));
      wrap(s, c, y, 30, (X, Y) => blob(g, X, Y, w, 9, 0, P.crown, 0.18, 0.3));
    }
  }
  // the shoulders: ground creeps in from the edges in ragged clumps
  const edgeW = 1.75 * mpx;
  const nearEdge = (x) => x < edgeW * (0.6 + rnd() * 0.6) || x > s - edgeW * (0.6 + rnd() * 0.6);
  if (P.gDark) {
    bladePass(g, s, rnd, 2200, P.gDark, [6, 13], [1.4, 2.4], 0.45, [-0.5, 0.5], [-0.2, 0.3], nearEdge);
    bladePass(g, s, rnd, 2200, P.gMid, [5, 12], [1.2, 2.1], 0.75, [-0.5, 0.5], [-0.2, 0.3], nearEdge);
    bladePass(g, s, rnd, 900, P.gLit, [4, 8], [1, 1.6], 0.55, [-0.5, 0.5], [-0.2, 0.3], nearEdge);
  }
  if (P.extra) P.extra(g, s, rnd);
  glaze(g, s, s, '#ffdca0', 0.08, 'soft-light');
  blurTile(g.canvas, 0.35);
}

// ---- natural rock faces ---------------------------------------------------------------------------
// A cliff is painted in two parts. The rock is a mosaic of planes of very different sizes (a
// power diagram, so a few big planes and many small chips), each painted as one tone from its own
// normal, with cracks along only some of their borders. Under that sits a relief (how far the rock
// sticks out toward the viewer): partial shelves, each a lit top over a soft shaded underside,
// broad bulges, fine chisel marks, and for strata biomes level bands that bulge or recede. The
// relief is lit from the upper left and darkened in its cavities, then painted over: moss, dry
// grass or snow on whatever faces up (snow pillows and icicles in the pass), rain or snow streaks
// running down from the lips, chisel strokes and lichen. The y axis is world height, so shelves
// and strata stay level in the world.

// A tileable 1D table: f((a·x + b·y) mod s) tiles for integer a, b.
function ptable(rnd, s, terms, falloff, k0 = 1) {
  const f = periodic(rnd, terms, falloff, k0), T = new Float32Array(s);
  for (let i = 0; i < s; i++) T[i] = f(i / s);
  return T;
}
// separable box blur with wrap (in place), r px, n passes
function blurField(F, s, r, n = 2) {
  const tmp = new Float32Array(s * s), k = 1 / (2 * r + 1);
  for (let p = 0; p < n; p++) {
    for (let y = 0; y < s; y++) {
      let acc = 0; const row = y * s;
      for (let i = -r; i <= r; i++) acc += F[row + ((i + s) % s)];
      for (let x = 0; x < s; x++) { tmp[row + x] = acc * k; acc += F[row + (x + r + 1) % s] - F[row + (x - r + s) % s]; }
    }
    for (let x = 0; x < s; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += tmp[((i + s) % s) * s + x];
      for (let y = 0; y < s; y++) { F[y * s + x] = acc * k; acc += tmp[((y + r + 1) % s) * s + x] - tmp[((y - r + s) % s) * s + x]; }
    }
  }
  return F;
}

// Tileable value noise: a gx × gy lattice of random values, quintic-interpolated, wrapped.
function vnoise(rnd, s, gx, gy = gx) {
  const L = new Float32Array(gx * gy);
  for (let i = 0; i < L.length; i++) L[i] = rnd() * 2 - 1;
  const F = new Float32Array(s * s);
  const q = t => t * t * t * (t * (t * 6 - 15) + 10);
  for (let y = 0; y < s; y++) {
    const fy = y / s * gy, j0 = Math.floor(fy), ty = q(fy - j0), j1 = (j0 + 1) % gy;
    for (let x = 0; x < s; x++) {
      const fx = x / s * gx, i0 = Math.floor(fx), tx = q(fx - i0), i1 = (i0 + 1) % gx;
      const a = L[j0 * gx + i0], b = L[j0 * gx + i1], c = L[j1 * gx + i0], d = L[j1 * gx + i1];
      F[y * s + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return F;
}
function fbmField(rnd, s, oct, g0, gain = 0.5, aniso = 1) {
  const F = new Float32Array(s * s);
  let a = 1, gx = g0;
  for (let o = 0; o < oct; o++) {
    const N = vnoise(rnd, s, gx, Math.max(1, Math.round(gx * aniso)));
    for (let i = 0; i < F.length; i++) F[i] += N[i] * a;
    a *= gain; gx *= 2;
  }
  return F;
}

// Nearest seed in a wrapped, jittered cx × cy grid. Returns [id, d1, d2, dx, dy].
function voronoiAt(seeds, cx, cy, s, u, v, aniso, out) {
  const cw = s / cx, ch = s / cy;
  const ci = Math.floor(u / cw), cj = Math.floor(v / ch);
  let b1 = 1e9, b2 = 1e9, bid = 0, bdx = 0, bdy = 0;
  for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
    let ii = ci + di, jj = cj + dj, ox = 0, oy = 0;
    if (ii < 0) { ii += cx; ox = -s; } else if (ii >= cx) { ii -= cx; ox = s; }
    if (jj < 0) { jj += cy; oy = -s; } else if (jj >= cy) { jj -= cy; oy = s; }
    const sd = seeds[jj * cx + ii];
    const dx = u - (sd.x + ox), dy = (v - (sd.y + oy)) * aniso;
    const d = dx * dx + dy * dy;
    if (d < b1) { b2 = b1; b1 = d; bid = jj * cx + ii; bdx = dx; bdy = dy / aniso; } else if (d < b2) b2 = d;
  }
  out[0] = bid; out[1] = Math.sqrt(b1); out[2] = Math.sqrt(b2); out[3] = bdx; out[4] = bdy;
  return out;
}
function jitterSeeds(rnd, s, cx, cy, jx, jy, extra) {
  const cw = s / cx, ch = s / cy, out = [];
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) out.push({ x: (i + 0.5 + (rnd() - 0.5) * jx) * cw, y: (j + 0.5 + (rnd() - 0.5) * jy) * ch, ...extra(rnd) });
  return out;
}

const sst = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// Power-diagram cells on a wrapped, jittered grid: straight borders like Voronoi, but each seed
// carries a weight, so cells come in very different sizes (a few big planes, many small chips).
function powerCells(rnd, s, cx, cy, jit, wmax, extra) {
  const cw = s / cx, ch = s / cy, seeds = [];
  for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) {
    const r = Math.pow(rnd(), 1.6) * wmax * Math.min(cw, ch);
    seeds.push({ x: (i + 0.5 + (rnd() - 0.5) * jit) * cw, y: (j + 0.5 + (rnd() - 0.5) * jit) * ch, w2: r * r, ...extra(rnd) });
  }
  return { seeds, cx, cy, cw, ch };
}
// → out = [id, id2, edge distance (px), dx, dy] (dx, dy: from the cell's seed)
function powerAt(C, s, u, v, out) {
  const { seeds, cx, cy, cw, ch } = C;
  const ci = Math.floor(u / cw), cj = Math.floor(v / ch);
  let b1 = 1e18, b2 = 1e18, i1 = 0, i2 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    let ii = ci + di, jj = cj + dj, ox = 0, oy = 0;
    if (ii < 0) { ii += cx; ox = -s; } else if (ii >= cx) { ii -= cx; ox = s; }
    if (jj < 0) { jj += cy; oy = -s; } else if (jj >= cy) { jj -= cy; oy = s; }
    const k = jj * cx + ii, sd = seeds[k];
    const sx = sd.x + ox, sy = sd.y + oy, dx = u - sx, dy = v - sy;
    const d = dx * dx + dy * dy - sd.w2;
    if (d < b1) { b2 = b1; i2 = i1; x2 = x1; y2 = y1; b1 = d; i1 = k; x1 = sx; y1 = sy; }
    else if (d < b2) { b2 = d; i2 = k; x2 = sx; y2 = sy; }
  }
  out[0] = i1; out[1] = i2; out[2] = (b2 - b1) / (2 * (Math.hypot(x2 - x1, y2 - y1) || 1)); out[3] = u - x1; out[4] = v - y1;
  return out;
}
const pairHash = (a, b) => { const lo = Math.min(a, b), hi = Math.max(a, b); let h = Math.imul(lo + 1, 374761393) ^ Math.imul(hi + 7, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };

// The relief of a natural rock face: big tilted planes (a power diagram, so the planes come in
// very different sizes), a second, smaller generation of chips only in the broken areas, a few
// partial shelves (each a lit top and a soft shaded underside, never a full row across the tile),
// broad bulges and fine chisel marks. Strata biomes add level bands that bulge (hard rock) or
// recede (soft rock); their colour comes from the band table. Returns the height field plus what
// the painter needs: the big plane id (tint), crack strength along some borders, shelf tops.
function rockRelief(s, rnd, P) {
  const N = s * s, H = new Float32Array(N), SLAB = new Int32Array(N), CRK = new Float32Array(N), TOP = new Float32Array(N), FN = new Float32Array(N), FU = new Float32Array(N);
  // each facet is painted as a plane of one tone: its light from its own normal (no height step,
  // so the borders between planes are value changes, not outlines)
  const Lx = -0.48, Ly = -0.66, Lz = 0.58, Ll = Math.hypot(Lx, Ly, Lz);
  const facetLight = (gx, gy) => { const l = Math.hypot(gx, gy, 1); return (-gx * Lx - gy * Ly + Lz) / (l * Ll); };
  const F0 = P.facets[0], F1 = P.facets[1];
  const lean = F => r => ({ d: r(), gx: range(r, -F.tilt, F.tilt), gy: range(r, F.lean[0], F.lean[1]) * F.tilt, cr: r() });
  const C0 = powerCells(rnd, s, F0.cells[0], F0.cells[1], 0.95, F0.w, lean(F0));
  const C1 = F1 ? powerCells(rnd, s, F1.cells[0], F1.cells[1], 0.95, F1.w, lean(F1)) : null;
  const WX = fbmField(rnd, s, 3, 3, 0.5), WY = fbmField(rnd, s, 3, 3, 0.5);
  const WX2 = fbmField(rnd, s, 2, 9, 0.5), WY2 = fbmField(rnd, s, 2, 9, 0.5);
  const BROKEN = fbmField(rnd, s, 3, 3, 0.55), CFADE = fbmField(rnd, s, 3, 6, 0.55);
  const BU = fbmField(rnd, s, 3, 2, 0.5);
  const DET = fbmField(rnd, s, 2, 26, 0.5, 0.6);
  // partial shelves: each spans part of the width, wanders up and down, has its own depth
  const shelves = [];
  for (let i = 0; i < (P.shelfN ?? 0); i++) shelves.push({
    y: (i + rnd() * 0.8) / P.shelfN * s, wob: periodic(rnd, 4, 1.1, 1), wob2: periodic(rnd, 3, 0.9, 5), amp: range(rnd, 6, 22),
    cx: (i * 0.618 + rnd() * 0.25) % 1, span: range(rnd, 0.16, 0.42), h: range(rnd, 0.5, 1) * P.shelfH, w: range(rnd, 1.5, 3.5), th: range(rnd, 8, 26) });
  // strata bands
  let bands = null, ys = null, band = null;
  const WB = P.strata ? fbmField(rnd, s, 3, 4, 0.5, 0.5) : null, WB2 = P.strata ? fbmField(rnd, s, 2, 12, 0.5, 0.4) : null;
  if (P.strata) {
    ys = [0]; let tot = 0; const th = [];
    while (tot < s) { const t = range(rnd, P.band[0], P.band[1]) * (rnd() < 0.3 ? 0.45 : 1); th.push(t); tot += t; }
    const kk = s / tot; for (const t of th) ys.push(ys[ys.length - 1] + t * kk); ys[ys.length - 1] = s;
    bands = []; let last = -1;
    for (let i = 0; i < th.length; i++) {
      let ci; do { ci = Math.floor(rnd() * P.bandColors.length); } while (ci === last && P.bandColors.length > 1);
      last = ci;
      bands.push({ c: hex(jitter(P.bandColors[ci], rnd, 0.035)), hard: rnd() < P.hardP ? range(rnd, 0.6, 1.1) : 0 });
    }
    band = new Int32Array(N);
  }
  const o = [0, 0, 0, 0, 0];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x;
    const u = ((x + WX[k] * P.warp + WX2[k] * P.warp * 0.18) % s + s) % s, v = ((y + WY[k] * P.warp * 0.7 + WY2[k] * P.warp * 0.12) % s + s) % s;
    powerAt(C0, s, u, v, o);
    const a = C0.seeds[o[0]];
    let h = F0.amp * a.d * (P.step ?? 0.25);         // a small step between some planes
    let fl = facetLight(a.gx, a.gy) + (a.gx * o[3] + a.gy * o[4]) / (C0.cw * 6);
    // how much the plane faces up (gy > 0: the lower edge sticks out), fading toward its lower edge
    FU[k] = Math.max(0, a.gy / Math.hypot(a.gx, a.gy, 1)) * (1 - sst(-0.1, 0.5, o[4] / C0.ch)) * (0.6 + 0.8 * a.cr);
    SLAB[k] = o[0];
    // cracks only along some of the big borders, each with its own strength
    const ph = pairHash(o[0], o[1]);
    if (ph < P.crackFrac) CRK[k] = Math.max(0, 1 - o[2] / (P.crackW * (0.6 + ph / P.crackFrac * 0.8))) * (0.55 + 0.45 * ph / P.crackFrac) * sst(-0.35, 0.15, CFADE[k]);
    // small chips, only where the rock is broken up
    if (C1) {
      const br = Math.max(P.chipMin ?? 0, sst(-0.05, 0.35, BROKEN[k]));
      if (br > 0) {
        powerAt(C1, s, u, v, o);
        const b = C1.seeds[o[0]];
        h += br * F1.amp * b.d * (P.step ?? 0.25);
        fl += br * 0.6 * (facetLight(b.gx, b.gy) - facetLight(0, 0));
        if (pairHash(o[0] + 9000, o[1] + 9000) < P.crackFrac * 0.6) CRK[k] = Math.max(CRK[k], br * 0.5 * Math.max(0, 1 - o[2] / (P.crackW * 0.6)) * sst(-0.2, 0.3, -CFADE[k]));
      }
    }
    // shelves
    for (const L of shelves) {
      let dxw = x / s - L.cx; dxw -= Math.round(dxw);
      const win = sst(L.span, L.span * 0.45, Math.abs(dxw));
      if (win <= 0) continue;
      let dy = y - (L.y + L.wob(x / s) * L.amp + L.wob2(x / s) * L.amp * 0.35); dy -= Math.round(dy / s) * s;
      if (dy < -L.w * 3 || dy > L.th + L.w * 4) continue;
      const shelf = sst(-L.w, L.w, dy) * (1 - sst(L.th - L.w * 2, L.th + L.w * 3, dy));
      h += shelf * L.h * win;
      TOP[k] = Math.max(TOP[k], win * sst(-L.w, 0, dy) * (1 - sst(L.w * 1.5, L.w * 4, dy)));
    }
    if (P.strata) {
      const yy = (((y + WB[k] * P.bandWarp + WB2[k] * P.bandWarp * 0.25) % s) + s) % s;
      let i = 0; while (i < bands.length - 1 && yy >= ys[i + 1]) i++;
      const f = (yy - ys[i]) / (ys[i + 1] - ys[i]);
      band[k] = i;
      const bd = bands[i];
      h += bd.hard ? bd.hard * P.ledge * (0.3 + Math.sin(Math.PI * Math.min(1, f * 1.04)) * 0.7) : P.ledge * (-0.08 - 0.22 * f);
      if (bd.hard && f < 0.12) TOP[k] = Math.max(TOP[k], 1 - f / 0.12);
    }
    h += BU[k] * P.bulge + DET[k] * P.detail;
    H[k] = h; FN[k] = fl;
  }
  blurField(FN, s, 1, 2);
  blurField(FU, s, 3, 2);
  return { H, SLAB, CRK, TOP, FN, FU, bands, band };
}

function paintRockFace(g, s, rnd, P, cv) {
  const N = s * s;
  // -- 1. the relief, and the colour layer under the light
  const R = rockRelief(s, rnd, P);
  const { H, SLAB, CRK, TOP, FN, FU } = R;
  fill(g, s, s, P.colors[0]);
  mottle(g, s, rnd, { colors: P.colors, count: 36, rmin: 60, rmax: 170, alpha: 0.5, hard: 0.1 });
  mottle(g, s, rnd, { colors: P.blot, count: 60, rmin: 14, rmax: 50, alpha: 0.2, hard: 0.2, stretch: 1.5, rot: P.strata ? 0 : Math.PI / 2 });
  const base = g.getImageData(0, 0, s, s), B = base.data;
  if (P.strata) {      // the band colours, modulated by the painted blotches
    const c0 = hex(P.colors[0]);
    for (let k = 0; k < N; k++) {
      const c = R.bands[R.band[k]].c;
      const m = (B[k * 4] + B[k * 4 + 1] + B[k * 4 + 2]) / (c0.r + c0.g + c0.b + 1);
      const mm = 0.86 + 0.14 * m;
      B[k * 4] = c.r * mm; B[k * 4 + 1] = c.g * mm; B[k * 4 + 2] = c.b * mm;
    }
  }
  const slabTint = Array.from({ length: 4096 }, () => range(rnd, -1, 1));
  const slabHue = Array.from({ length: 4096 }, () => hex(pick(rnd, P.colors)));
  const Hs = blurField(Float32Array.from(H), s, P.soft ?? 2, 2);
  const Hb = blurField(Float32Array.from(H), s, 12, 2);
  const COV = fbmField(rnd, s, 3, 4, 0.55);
  // -- 2. light it from the upper left, a little in front; cavities darken and cool
  const Lx = -0.48, Ly = -0.66, Lz = 0.58, Ll = Math.hypot(Lx, Ly, Lz);
  const lit = hex(P.light), shd = hex(P.shadow), deep = hex(shadowOf(P.shadow, 0.3)), crack = hex(P.crack || shadowOf(P.shadow, 0.15));
  const cov = P.cover ? { lo: hex(P.cover.shade), mid: hex(P.cover.mid), hi: hex(P.cover.lit) } : null;
  const NY = new Float32Array(N), LT = new Float32Array(N), CV = new Float32Array(N);
  const rs = P.relief * s / 512;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x;
    const hx = (Hs[y * s + (x + 1) % s] - Hs[y * s + (x - 1 + s) % s]) * 0.5 * rs;
    const hy = (Hs[((y + 1) % s) * s + x] - Hs[((y - 1 + s) % s) * s + x]) * 0.5 * rs;
    let nx = -hx, ny = -hy, nz = 1; const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
    NY[k] = ny;
    const dif = (nx * Lx + ny * Ly + nz * Lz) / Ll;           // ≈ 0.58 on a face turned square to us
    const cav = Math.max(-1.2, Math.min(0.8, (H[k] - Hb[k]) * P.cavity));
    let r = B[k * 4], gg = B[k * 4 + 1], b = B[k * 4 + 2];
    if (!P.strata && P.hueMix) { const hc = slabHue[SLAB[k] & 4095]; r += (hc.r - r) * P.hueMix; gg += (hc.g - gg) * P.hueMix; b += (hc.b - b) * P.hueMix; }
    const tk = 1 + slabTint[SLAB[k] & 4095] * P.slabVar;
    r *= tk; gg *= tk; b *= tk;
    const t = (dif - 0.58) * P.contrast + cav * 0.4 + (FN[k] - 0.58) * (P.facetK ?? 1.2);
    LT[k] = t;
    if (t < 0) { const a = Math.min(0.85, -t * 0.95); const c = a > 0.55 ? deep : shd; r += (c.r - r) * a; gg += (c.g - gg) * a; b += (c.b - b) * a; }
    else { const a = Math.min(0.7, t * 0.85); r += (lit.r - r) * a; gg += (lit.g - gg) * a; b += (lit.b - b) * a; }
    // painted cracks: a soft cool-dark line with a lit lip on its lower right
    const ck = CRK[k];
    if (ck > 0) { const a = Math.min(0.75, ck * 0.85); r += (crack.r - r) * a; gg += (crack.g - gg) * a; b += (crack.b - b) * a; }
    else { const ck2 = CRK[((y - 2 + s) % s) * s + (x - 2 + s) % s]; if (ck2 > 0.2) { const a = Math.min(0.3, ck2 * 0.35); r += (lit.r - r) * a; gg += (lit.g - gg) * a; b += (lit.b - b) * a; } }
    // moss, dry grass or snow on whatever faces up and along shelf tops
    if (cov) {
      const up = Math.max(0, -ny - P.cover.minUp) * P.cover.slope + TOP[k] * P.cover.top + FU[k] * (P.cover.facet ?? 0);
      const nz2 = COV[k] * 0.9 + 0.5;
      const raw = up * P.cover.amt * sst(P.cover.patch[0], P.cover.patch[1], nz2);
      const m = sst(P.cover.edge[0], P.cover.edge[1], raw) * P.cover.max;
      CV[k] = m;
      if (m > 0.005) {
        const l2 = Math.max(0, Math.min(1, t * 1.2 + 0.32 + Math.min(1, raw * 0.7) * 0.4));      // deep cover is brighter, its fringe darker
        const lo = l2 < 0.5 ? cov.lo : cov.mid, hi = l2 < 0.5 ? cov.mid : cov.hi, f = l2 < 0.5 ? l2 * 2 : l2 * 2 - 1;
        const cr = lo.r + (hi.r - lo.r) * f, cg = lo.g + (hi.g - lo.g) * f, cb = lo.b + (hi.b - lo.b) * f;
        r += (cr - r) * m; gg += (cg - gg) * m; b += (cb - b) * m;
      }
    }
    B[k * 4] = r; B[k * 4 + 1] = gg; B[k * 4 + 2] = b; B[k * 4 + 3] = 255;
  }
  // a cool shadow line right under each covered lip (snow and moss overhang a little)
  if (cov && P.cover.lipShadow) {
    const sh = hex(P.cover.lipShadow);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const k = y * s + x, above = CV[((y - 3 + s) % s) * s + x], here = CV[k];
      const a = Math.max(0, above - here * 1.2) * 0.5;
      if (a > 0.01) { B[k * 4] += (sh.r - B[k * 4]) * a; B[k * 4 + 1] += (sh.g - B[k * 4 + 1]) * a; B[k * 4 + 2] += (sh.b - B[k * 4 + 2]) * a; }
    }
  }
  g.putImageData(base, 0, 0);
  // -- 3. painted details on top
  const lips = [], unders = [];
  for (let i = 0; i < 9000 && (lips.length < 260 || unders.length < 120); i++) {
    const x = Math.floor(rnd() * s), y = Math.floor(rnd() * s), k = y * s + x;
    if (NY[k] < -0.4 && lips.length < 260) lips.push([x, y, CV[k]]);
    else if (NY[k] > 0.45 && unders.length < 120) unders.push([x, y]);
  }
  // chisel strokes: short directional dabs of light and shade that make the planes read as painted stone
  if (P.chisel) {
    streaks(g, s, rnd, { colors: [P.light], count: P.chisel, len: [6, 22], width: [1.5, 3.5], angle: 1.2, wobble: 0.3, alpha: 0.12 });
    streaks(g, s, rnd, { colors: [P.shadow], count: P.chisel, len: [6, 22], width: [1.5, 3.5], angle: 1.35, wobble: 0.3, alpha: 0.1 });
  }
  // streaks running down from the lips: rain stains, or wind-blown snow
  for (const [x, y] of lips.slice(0, P.stains ?? 40)) {
    const L = range(rnd, 24, 110), w = range(rnd, 3, 9);
    const pts = []; let px = 0; for (let i = 0; i <= 5; i++) { pts.push([px, 4 + L * i / 5]); px += range(rnd, -1.5, 1.5); }
    wrap(s, x, y + L / 2, L, (X, Y) => stroke(g, pts.map(([u, v]) => [X + u, Y - L / 2 + v]), w, w * 0.3, P.stain, P.stainA ?? 0.1));
  }
  // grass clinging to the lips
  if (P.tuft) for (const [x, y] of lips.slice(60, 60 + (P.tuftN ?? 40))) {
    const n = 5 + Math.floor(rnd() * 7);
    wrap(s, x, y, 22, (X, Y) => {
      blob(g, X + 2, Y + 5, 10, 4, 0, '#1e2418', 0.25, 0.3);
      for (let i = 0; i < n; i++) blade(g, X + range(rnd, -8, 8), Y + 3, range(rnd, 6, 13), range(rnd, -0.9, 0.9), range(rnd, 1.6, 2.8), pick(rnd, P.tuft), 0.9, range(rnd, -0.5, 0.5));
    });
  }
  // snow pillows along the lips: lumpy white with a blue underside
  if (P.pillows) for (const [x, y, c] of lips.slice(0, 160)) {
    if (c < 0.3) continue;
    const r = range(rnd, 5, 12);
    wrap(s, x, y, r * 2, (X, Y) => {
      blob(g, X + r * 0.15, Y + r * 0.35, r * 1.3, r * 0.55, 0, P.pillows[2], 0.35, 0.35);
      blob(g, X, Y, r * 1.2, r * 0.5, 0, P.pillows[1], 0.7, 0.55);
      blob(g, X - r * 0.3, Y - r * 0.15, r * 0.8, r * 0.3, 0, P.pillows[0], 0.65, 0.5);
    });
  }
  // icicles under overhangs
  if (P.icicles) for (const [x, y] of unders.slice(0, P.icicles)) {
    const n = 2 + Math.floor(rnd() * 5);
    for (let i = 0; i < n; i++) {
      const xx = x + range(rnd, -9, 9), L = range(rnd, 6, 20), w = range(rnd, 2, 3.6);
      wrap(s, xx, y + L / 2, L, (X, Y) => {
        const Y0 = Y - L / 2;
        stroke(g, [[X + 1, Y0 + 1], [X + 1.2, Y0 + L + 1]], w, 0.4, '#3a4660', 0.25);
        stroke(g, [[X, Y0], [X + 0.2, Y0 + L]], w, 0.4, '#c8dcef', 0.9);
        stroke(g, [[X - w * 0.25, Y0], [X - w * 0.2, Y0 + L * 0.7]], w * 0.35, 0.3, '#ffffff', 0.8);
      });
    }
  }
  if (P.lichen) for (let i = 0; i < 40; i++) {
    const x = rnd() * s, y = rnd() * s, c = pick(rnd, P.lichen);
    for (let j = 0; j < 6; j++) { const xx = x + range(rnd, -9, 9), yy = y + range(rnd, -6, 6), r = range(rnd, 1.5, 3.8); wrap(s, xx, yy, r, (X, Y) => blob(g, X, Y, r, r * 0.8, 0, c, 0.45, 0.5)); }
  }
  glaze(g, s, s, P.glaze || '#ffe2b0', 0.1, 'soft-light');
  blurTile(cv, 0.6);
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
  snow: {
    grass: { dark: ['#5a5040', '#4e4a3e'], mid: ['#8e7f56', '#9c8c5e'], lit: ['#c8b884', '#d8c896'] },
    road: { base: '#a39e94', blot: ['#8e897e', '#b4afa4', '#c6c8c8', '#9a948a', '#d0d4d8'], small: ['#7a746a', '#dadee2'], peb: ['#8e96a0', '#a4a8ac', '#6f7682', '#b8b4ac', '#7a7068'],
      edge: '#d6dde6', crown: '#d8dde2', rut: '#6a665e', rutDark: '#44424a', rutLit: '#c4d0dc', center: 'snow' },
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
  family: 'terrain', size: 512, note: 'anchor: Elwynn grass: big soft tone fields, then directional blade strokes dark → mid → lit',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#557a2d');
    mottle(g, s, rnd, { colors: ['#46692a', '#6a8f36', '#82a03e', '#3c6026', '#78983a', '#5a7e2e', '#8c9a3c'], count: 54, rmin: 50, rmax: 160, alpha: 0.48, hard: 0.08 });
    mottle(g, s, rnd, { colors: ['#3c6522', '#74a03c', '#5d8a30', '#8a9a40'], count: 120, rmin: 10, rmax: 34, alpha: 0.26, hard: 0.3, stretch: 1.4, rot: 0.5 });
    mottle(g, s, rnd, { colors: ['#6a5a30', '#5e5a2c', '#74643a'], count: 14, rmin: 6, rmax: 16, alpha: 0.26, hard: 0.4 });
    blurTile(cv, 2);
    // blades: they all lean a little the same way (the wind), dark under, lit on top
    const lean = [-0.15, 0.75];
    bladePass(g, s, rnd, 2000, ['#2c4e19', '#36591e', '#2f5320'], [8, 17], [1.5, 2.5], 0.42, lean, [-0.15, 0.35]);
    bladePass(g, s, rnd, 2100, ['#5a8a2e', '#66963a', '#527f2b', '#6e9a36'], [7, 15], [1.3, 2.2], 0.6, lean, [-0.15, 0.35]);
    bladePass(g, s, rnd, 1000, ['#9cba52', '#b0c660', '#8eae48', '#bcc46a'], [5, 11], [1.0, 1.7], 0.5, lean, [-0.15, 0.35]);
    for (let i = 0; i < 14; i++) {
      const x = rnd() * s, y = rnd() * s, c = pick(rnd, ['#f4e7a1', '#fffbe6', '#e7c2e8']);
      wrap(s, x, y, 4, (xx, yy) => { blob(g, xx, yy, 2.2, 1.9, 0, c, 0.8, 0.6); blob(g, xx - 0.6, yy - 0.6, 1, 0.8, 0, '#ffffff', 0.6, 0.5); });
    }
    glaze(g, s, s, '#ffe7a0', 0.1, 'soft-light');
    blurTile(cv, 0.35);
  },
});

register('ground2_meadow', {
  family: 'terrain', size: 512, note: 'Elwynn: grass worn through to red-brown earth, blades thinning out into dirt lanes',
  paint(g, s, rnd, h, cv) {
    const P = BIO.meadow;
    dirtGround(g, s, rnd, P.dirt, { pebbleN: 160, crackN: 3, clods: 120 });
    // islands of grass around a handful of cores; density falls off softly into the bare lanes
    const cores = []; for (let i = 0; i < 14; i++) cores.push([rnd() * s, rnd() * s, range(rnd, 50, 110)]);
    const dens = (x, y) => { let b = 0; for (const [cx, cy, r] of cores) { let dx = Math.abs(x - cx), dy = Math.abs(y - cy); dx = Math.min(dx, s - dx); dy = Math.min(dy, s - dy); b = Math.max(b, 1 - Math.hypot(dx, dy) / r); } return Math.min(1, b * 1.8); };
    for (const [cx, cy, r] of cores) wrap(s, cx, cy, r * 1.2, (X, Y) => blob(g, X, Y, r * 0.95, r * 0.8, rnd() * 3, '#4e6a28', 0.45, 0.3));
    const lean = [-0.15, 0.75];
    const where = (x, y) => rnd() < dens(x, y);
    bladePass(g, s, rnd, 2600, ['#2c4e19', '#36591e', '#3e5a20'], [7, 15], [1.4, 2.4], 0.62, lean, [-0.15, 0.35], where);
    bladePass(g, s, rnd, 2800, ['#5a8a2e', '#66963a', '#6e8f34', '#7a9238'], [6, 13], [1.2, 2.1], 0.8, lean, [-0.15, 0.35], where);
    bladePass(g, s, rnd, 1200, ['#9cb44e', '#aec05c', '#c2c26a'], [4, 9], [1, 1.6], 0.62, lean, [-0.15, 0.35], where);
    // a few stray blades out in the dirt
    bladePass(g, s, rnd, 260, ['#6a8a30', '#8a9a3e', '#5a6a2a'], [4, 9], [1, 1.6], 0.5, lean);
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

// A loose network of dry cracks, only where mask(x, y) allows: each crack is a wandering, tapering
// stroke with a lit lip; they meet in irregular plates, never a tiled grid.
function dryCracks(g, s, rnd, { n, len, w, color, lip, alpha = 0.5, mask = null }) {
  for (let i = 0; i < n; i++) {
    let x = rnd() * s, y = rnd() * s;
    if (mask && rnd() > mask(x, y)) continue;
    let a = rnd() * TAU;
    const L = range(rnd, len[0], len[1]), W = range(rnd, w[0], w[1]);
    const pts = [[x, y]];
    const segs = 6 + Math.floor(rnd() * 5);
    for (let k = 0; k < segs; k++) { a += range(rnd, -0.7, 0.7); x += Math.cos(a) * L / segs; y += Math.sin(a) * L / segs; pts.push([x, y]); }
    const [x0, y0] = pts[0];
    wrap(s, x0, y0, L + 6, (X, Y) => {
      const P = pts.map(([u, v]) => [u - x0 + X, v - y0 + Y]);
      stroke(g, P.map(([u, v]) => [u + 1.1, v + 1.2]), W * 1.4, W * 0.4, lip, alpha * 0.45);
      stroke(g, P, W, W * 0.25, color, alpha);
    });
  }
}

register('ground_badlands', {
  family: 'terrain', size: 512, note: 'Badlands: ochre dust, half-buried red stones, a few dry cracks',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#c08a58');
    mottle(g, s, rnd, { colors: ['#cf9a62', '#b47a4c', '#d8a873', '#a86c44', '#c4865a', '#9e5c3a'], count: 50, rmin: 50, rmax: 150, alpha: 0.5, hard: 0.1 });
    mottle(g, s, rnd, { colors: ['#9a5a38', '#a86440'], count: 14, rmin: 30, rmax: 70, alpha: 0.35, hard: 0.35, stretch: 1.6 });
    mottle(g, s, rnd, { colors: ['#9a6240', '#dcae7a', '#b0744a'], count: 170, rmin: 8, rmax: 26, alpha: 0.26, hard: 0.35, stretch: 1.8, rot: 0.5 });
    // wind-laid dust: long soft streaks all leaning one way
    streaks(g, s, rnd, { colors: ['#e2b884', '#b07a50', '#d4a070'], count: 90, len: [40, 120], width: [3, 9], angle: 1.25, wobble: 0.12, alpha: 0.12 });
    // cracked hardpan shows through in a few patches
    const cores = []; for (let i = 0; i < 5; i++) cores.push([rnd() * s, rnd() * s, range(rnd, 60, 120)]);
    const near = (x, y) => { let best = 0; for (const [cx, cy, r] of cores) { let dx = Math.abs(x - cx), dy = Math.abs(y - cy); dx = Math.min(dx, s - dx); dy = Math.min(dy, s - dy); best = Math.max(best, 1 - Math.hypot(dx, dy) / r); } return Math.max(0, best); };
    for (const [cx, cy, r] of cores) wrap(s, cx, cy, r, (X, Y) => blob(g, X, Y, r * 0.9, r * 0.75, rnd() * 3, '#d8a670', 0.4, 0.3));
    dryCracks(g, s, rnd, { n: 220, len: [26, 64], w: [1.8, 3.2], color: '#6e3a28', lip: '#f4cc94', alpha: 0.6, mask: (x, y) => near(x, y) * 1.5 });
    dryCracks(g, s, rnd, { n: 30, len: [14, 34], w: [1, 1.8], color: '#80482e', lip: '#f0c890', alpha: 0.4 });
    stones(g, s, rnd, { colors: ['#b8704a', '#9a5a3c', '#c88a5e', '#8a5a44', '#a08070'], count: 170, rmin: 1.4, rmax: 3.6, ground: '#c08a58', sink: 0.3 });
    stones(g, s, rnd, { colors: ['#a86444', '#8a5a44', '#b48c74'], count: 14, rmin: 4.5, rmax: 9, ground: '#c08a58', sink: 0.2 });
    bladePass(g, s, rnd, 70, ['#7a6238', '#a88a50', '#c8a868'], [5, 10], [1, 1.6], 0.5);
    glaze(g, s, s, '#ffd29a', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('ground2_badlands', {
  family: 'terrain', size: 512, note: 'Badlands: red scree and gravel washed down from the walls',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#a8643e');
    mottle(g, s, rnd, { colors: ['#9a5636', '#b8724a', '#a65f3a', '#8a4e32', '#c4825a'], count: 50, rmin: 40, rmax: 130, alpha: 0.42, hard: 0.1 });
    mottle(g, s, rnd, { colors: ['#7a4230', '#cc8c60'], count: 150, rmin: 5, rmax: 16, alpha: 0.22, hard: 0.35 });
    stones(g, s, rnd, { colors: ['#b8744c', '#9a5a3c', '#cf8e62', '#7e4a34', '#a88270', '#c49a7a'], count: 520, rmin: 1.6, rmax: 4.2, ground: '#a8643e', sink: 0.3 });
    stones(g, s, rnd, { colors: ['#b06a46', '#8e5238', '#c4865e', '#9a8070'], count: 70, rmin: 5, rmax: 10, ground: '#a8643e', sink: 0.15 });
    stones(g, s, rnd, { colors: ['#a86444', '#c08060'], count: 8, rmin: 11, rmax: 16, ground: '#a8643e', sink: 0.1 });
    glaze(g, s, s, '#ffcf98', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// ---- ground: desert (Tanaris) ---------------------------------------------------------------

register('ground_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: wind-rippled sand',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#dcb985');
    mottle(g, s, rnd, { colors: ['#e8cc96', '#d2ad74', '#c79c62', '#efd6a4', '#d8b47e'], count: 50, rmin: 50, rmax: 160, alpha: 0.42, hard: 0.08 });
    windRipples(g, s, rnd, { n: 46, len: [90, 280], amp: [3, 9], lit: '#f6e6c0', lee: '#b08a5a', alpha: 0.42, wid: [2.5, 5] });
    mottle(g, s, rnd, { colors: ['#e8cc96', '#dcb985'], count: 60, rmin: 20, rmax: 60, alpha: 0.3, hard: 0.2 });
    mottle(g, s, rnd, { colors: ['#c49a68', '#f0dcb0'], count: 160, rmin: 3, rmax: 9, alpha: 0.2, hard: 0.4 });
    stones(g, s, rnd, { colors: ['#c4a47c', '#a88a68', '#e0caa0', '#9a7e64'], count: 50, rmin: 1.3, rmax: 3, ground: '#dcb985', sink: 0.4 });
    glaze(g, s, s, '#ffe8b8', 0.12, 'soft-light');
    blurTile(cv, 0.45);
  },
});

register('ground2_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: coarse wind-packed sand with grit and a little crust',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#cba26c');
    mottle(g, s, rnd, { colors: ['#b88e5c', '#d4ac78', '#c79c62', '#ad8452', '#ddb886'], count: 50, rmin: 40, rmax: 140, alpha: 0.42, hard: 0.1 });
    windRipples(g, s, rnd, { n: 20, len: [70, 200], amp: [3, 8], lit: '#eed8aa', lee: '#a47e56', alpha: 0.28, wid: [2, 4] });
    mottle(g, s, rnd, { colors: ['#d8b480', '#c09464'], count: 60, rmin: 20, rmax: 70, alpha: 0.3, hard: 0.2 });
    dryCracks(g, s, rnd, { n: 40, len: [20, 50], w: [0.9, 1.6], color: '#9a7048', lip: '#f6e2b8', alpha: 0.3 });
    stones(g, s, rnd, { colors: ['#d8c09a', '#b89a74', '#e8d4ae', '#9c8268', '#a07a5a'], count: 220, rmin: 1.3, rmax: 3.2, ground: '#cba26c', sink: 0.35 });
    stones(g, s, rnd, { colors: ['#c4a47c', '#9c8268'], count: 18, rmin: 4, rmax: 8, ground: '#cba26c', sink: 0.2 });
    bladePass(g, s, rnd, 30, ['#8a7448', '#b8a468'], [5, 9], [1, 1.5], 0.45);
    glaze(g, s, s, '#ffe8b8', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// ---- ground: snow (Dun Morogh) ----------------------------------------------------------------
// Snow is painted, not white: a cool blue-gray base, big warm sunlit fields, soft blue shadows in
// the hollows, drifts lit on the upper left, broken wind ripples, a few things poking through.

// Broken wind ripples (snow and sand): wavy crests of different lengths, each a lit crest over
// a cool lee shadow.
// Lee and crest strokes go into two layers at full strength and are laid down once at alpha
// (alpha strokes overlapping at their joints would otherwise bead up).
function windRipples(g0, s, rnd, { n, len, amp, lit, lee, alpha, wid = [4, 9] }) {
  const lees = makeCanvas(s), lits = makeCanvas(s), gl = lees.getContext('2d'), gt = lits.getContext('2d');
  for (let i = 0; i < n; i++) {
    const x0 = rnd() * s, y0 = rnd() * s, L = range(rnd, len[0], len[1]), ph = rnd() * TAU, A = range(rnd, amp[0], amp[1]), tilt = range(rnd, -0.12, 0.12);
    const pts = [];
    for (let t = 0; t <= 1.0001; t += 1 / 12) pts.push([x0 + (t - 0.5) * L, y0 + Math.sin(t * Math.PI * 1.3 + ph) * A + (t - 0.5) * L * tilt]);
    const w = range(rnd, wid[0], wid[1]);
    wrap(s, x0, y0, L / 2 + A + 8, (X, Y) => {
      const P = pts.map(([u, v]) => [u - x0 + X, v - y0 + Y]);
      // taper the ends by drawing the middle twice
      stroke(gl, P.map(([u, v]) => [u + 1.5, v + w * 0.8]), w * 1.5, w * 0.5, lee, 1);
      stroke(gt, P, w, w * 0.35, lit, 1);
    });
  }
  for (const [cv, a] of [[lees, alpha * 0.7], [lits, alpha * 0.8]]) {
    blurTile(cv, 1.5);
    g0.save(); g0.globalAlpha = a; g0.drawImage(cv, 0, 0); g0.restore();
  }
}

// Soft drifts: a lit upper-left face and a blue lower-right lee.
function drifts(g, s, rnd, n, r, lit, lee, a = 1) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s, R = range(rnd, r[0], r[1]), rot = range(rnd, -0.6, 0.4);
    wrap(s, x, y, R * 1.8, (X, Y) => {
      blob(g, X + R * 0.4, Y + R * 0.32, R * 1.1, R * 0.55, rot, lee, 0.32 * a, 0.3);
      blob(g, X - R * 0.12, Y - R * 0.1, R * 0.95, R * 0.5, rot, lit, 0.5 * a, 0.35);
    });
  }
}

// Something poking out of the snow: a small dark stone with a snow cap and a blue contact shadow.
function cappedStones(g, s, rnd, n, cols, r) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s, R = range(rnd, r[0], r[1]), ry = R * range(rnd, 0.55, 0.8), c = pick(rnd, cols);
    wrap(s, x, y, R * 2.4, (X, Y) => {
      blob(g, X + R * 0.5, Y + ry * 0.7, R * 1.6, ry * 1.1, 0, '#7a8cae', 0.35, 0.3);
      ellipse(g, X, Y, R, ry, 0, c);
      blob(g, X + R * 0.3, Y + ry * 0.3, R * 0.8, ry * 0.6, 0, shadowOf(c, 0.35), 0.5, 0.35);
      blob(g, X - R * 0.1, Y - ry * 0.45, R * 0.95, ry * 0.5, 0, '#f2f4f6', 0.95, 0.6);   // the cap
      blob(g, X - R * 0.35, Y - ry * 0.6, R * 0.45, ry * 0.25, 0, '#ffffff', 0.8, 0.5);
    });
  }
}

// Painted glints: a few tiny bright crosses (the shader adds live sparkle on top).
function glints(g, s, rnd, n) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 0.8, 1.8);
    wrap(s, x, y, 5, (X, Y) => {
      blob(g, X, Y, r * 2.2, r * 2.2, 0, '#ffffff', 0.35, 0.3);
      ellipse(g, X, Y, r, r, 0, '#ffffff', 0.95);
    });
  }
}

register('ground_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: wind-packed snow with soft blue shadows, drifts and ripples',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#d9e1ec');
    mottle(g, s, rnd, { colors: ['#f4f0e4', '#cad6e6', '#bccbe0', '#eceff0', '#d6dfeb', '#f8f2e2'], count: 46, rmin: 60, rmax: 170, alpha: 0.55, hard: 0.08 });
    mottle(g, s, rnd, { colors: ['#b0c2da', '#bfcde2'], count: 14, rmin: 30, rmax: 90, alpha: 0.4, hard: 0.2, stretch: 2, rot: 0.25 });
    drifts(g, s, rnd, 34, [20, 60], '#fcf8ee', '#9fb3d0', 1.1);
    windRipples(g, s, rnd, { n: 26, len: [90, 240], amp: [5, 16], lit: '#fbf8f0', lee: '#a8bad4', alpha: 0.4, wid: [5, 10] });
    mottle(g, s, rnd, { colors: ['#c4d0e0', '#f6f4ee'], count: 140, rmin: 4, rmax: 14, alpha: 0.18, hard: 0.35, stretch: 1.6, rot: 0.3 });
    blurTile(cv, 1.2);
    // things poking through: dry grass tips, a few capped stones, twigs
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s, y = rnd() * s, n = 3 + Math.floor(rnd() * 5);
      wrap(s, x, y, 16, (X, Y) => {
        blob(g, X + 2, Y + 2, 7, 3, 0, '#9aaccc', 0.35, 0.3);
        for (let k = 0; k < n; k++) blade(g, X + range(rnd, -4, 4), Y, range(rnd, 5, 11), range(rnd, -0.7, 0.7), range(rnd, 1.1, 1.8), pick(rnd, ['#a8946a', '#c4b07c', '#8a7a58', '#d6c48e']), 0.9, range(rnd, -0.4, 0.4));
      });
    }
    cappedStones(g, s, rnd, 16, ['#6f7682', '#7e8694', '#5e6472'], [2.2, 5.5]);
    glints(g, s, rnd, 50);
    glaze(g, s, s, '#e8f0ff', 0.1, 'soft-light');
    blurTile(cv, 0.35);
  },
});

register('ground2_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: thin windswept snow, frozen tundra grass and stones showing through',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#d8e0ea');
    mottle(g, s, rnd, { colors: ['#eeece4', '#cdd8e6', '#e2e8ee', '#c4d0e0'], count: 40, rmin: 50, rmax: 150, alpha: 0.45, hard: 0.08 });
    // bare patches: frozen earth and dead grass, clustered in lanes the wind scoured
    const cores = [];
    for (let i = 0; i < 9; i++) {          // each scoured lane is a chain of overlapping lobes along the wind
      const x = rnd() * s, y = rnd() * s, n = 3 + Math.floor(rnd() * 4), dir = range(rnd, -0.25, 0.25);
      for (let k = 0; k < n; k++) cores.push([x + k * range(rnd, 20, 40), y + k * range(rnd, 20, 40) * dir + range(rnd, -10, 10), range(rnd, 14, 34)]);
    }
    const near = (x, y) => { let b = 0; for (const [cx, cy, r] of cores) { let dx = Math.abs(x - cx), dy = Math.abs(y - cy); dx = Math.min(dx, s - dx); dy = Math.min(dy, s - dy); b = Math.max(b, 1 - Math.hypot(dx * 0.7, dy * 1.4) / r); } return Math.max(0, b); };
    for (const [cx, cy, r] of cores) {
      wrap(s, cx, cy, r * 1.8, (X, Y) => {
        blob(g, X, Y, r * 1.4, r * 0.7, range(rnd, -0.2, 0.2), '#857a66', 0.7, 0.3);
        blob(g, X - r * 0.2, Y - r * 0.1, r * 0.9, r * 0.45, 0.1, '#9a8c6a', 0.5, 0.3);
      });
    }
    grassClumps(g, s, rnd, 420, { r: [4, 11], dark: ['#5a5040', '#4e4a3e'], mid: ['#8e7f56', '#9c8c5e', '#7a7050'], lit: ['#c8b884', '#d8c896', '#bcae80'], len: [5, 11], wid: [1.1, 2], dens: 0.45, shadow: 0.2, where: (x, y) => rnd() < near(x, y) * 1.6 });
    stones(g, s, rnd, { colors: ['#6f7682', '#7e8694', '#8a8e96', '#5e6472'], count: 90, rmin: 1.4, rmax: 3.5, ground: '#7d7464', sink: 0.2, where: (x, y) => Math.min(1, near(x, y) * 2) });
    // snow lips around the bare patches and drifts between them
    drifts(g, s, rnd, 34, [10, 30], '#fbf8f0', '#a8bad2', 0.9);
    windRipples(g, s, rnd, { n: 14, len: [70, 180], amp: [4, 12], lit: '#fbf8f0', lee: '#a8bad4', alpha: 0.3, wid: [4, 8] });
    cappedStones(g, s, rnd, 10, ['#6f7682', '#7e8694'], [3, 6]);
    glints(g, s, rnd, 30);
    glaze(g, s, s, '#eaf0ff', 0.08, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('dirt_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: trampled snow churned with frozen mud and straw (camps, doorsteps)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#b8bec6');
    mottle(g, s, rnd, { colors: ['#c8ced6', '#a4a8ae', '#d6dce2', '#9a958c', '#b0b2b2'], count: 50, rmin: 40, rmax: 140, alpha: 0.45, hard: 0.1 });
    mottle(g, s, rnd, { colors: ['#7e7468', '#8a8070', '#6e665c'], count: 40, rmin: 12, rmax: 40, alpha: 0.4, hard: 0.3, stretch: 1.4 });
    // trodden prints: small dimples, blue-shadowed on the upper left wall, lit on the lower right
    for (let i = 0; i < 160; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 4, 8), rot = rnd() * TAU;
      wrap(s, x, y, r * 2, (X, Y) => {
        blob(g, X, Y, r, r * 0.6, rot, '#8494ae', 0.35, 0.4);
        blob(g, X + r * 0.3, Y + r * 0.3, r * 0.7, r * 0.4, rot, '#eef0f2', 0.35, 0.4);
      });
    }
    drifts(g, s, rnd, 18, [12, 34], '#f4f4f0', '#9eaec6', 0.8);
    stones(g, s, rnd, { colors: ['#7e8694', '#8a8e96', '#6a6460', '#9a948a'], count: 120, rmin: 1.3, rmax: 3.4, ground: '#b8bec6', sink: 0.25 });
    bladePass(g, s, rnd, 110, ['#c8b07a', '#b09860', '#d8c48e'], [5, 11], [1, 1.6], 0.6, [-1.6, 1.6], [-0.15, 0.15]);
    glaze(g, s, s, '#eef2ff', 0.08, 'soft-light');
    blurTile(cv, 0.35);
  },
});

register('road_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: packed snow and gravel road, dark slushy wheel ruts, plowed banks (road space)',
  paint(g, s, rnd) {
    paintRoad(g, s, rnd, { ...BIO.snow.road, gDark: null,
      extra(g, s, rnd) {
        const c = s / 2, mpx = s / 10;
        // packed snow over the crown, between the ruts
        for (let y = -20; y < s + 20; y += 4) {
          const w = 0.45 * mpx * (0.6 + 0.4 * Math.sin(y / s * TAU * 3 + 0.7)), xo = Math.sin(y / s * TAU * 2 + 1.1) * 5;
          wrap(s, c + xo, y, 40, (X, Y) => blob(g, X, Y, w, 14, 0, '#dfe5eb', 0.1, 0.3));
        }
        // glassy ice in the ruts
        for (const side of [-1, 1]) for (let i = 0; i < 22; i++) {
          const y = rnd() * s, L = range(rnd, 12, 40), x = c + side * 1.05 * mpx + range(rnd, -5, 5);
          wrap(s, x, y, L, (X, Y) => {
            blob(g, X, Y, 9, L, 0, '#5a6276', 0.18, 0.3);
            blob(g, X - 3, Y - L * 0.2, 5, L * 0.6, 0, '#c8d6e8', 0.25, 0.3);
          });
        }
        // plowed banks along both edges: lumpy, lit on top, blue on the road side
        for (const side of [-1, 1]) for (let i = 0; i < 46; i++) {
          const y = rnd() * s, x = c + side * range(rnd, 3.4, 4.9) * mpx, r = range(rnd, 9, 18), L = r * range(rnd, 2.5, 4.5);
          wrap(s, x, y, L * 1.2, (X, Y) => {
            blob(g, X - side * r * 0.7, Y, r * 0.8, L, 0, '#7e90ac', 0.2, 0.25);
            blob(g, X, Y, r, L, 0, '#e2e8f0', 0.7, 0.35);
            blob(g, X - r * 0.35, Y - L * 0.1, r * 0.5, L * 0.7, 0, '#fbf8f0', 0.55, 0.3);
          });
        }
        glints(g, s, rnd, 24);
      } });
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
        pebblesWhere(g, s, rnd, 160, BIO.badlands.road.peb, 1.5, 3.6, x => Math.abs(x - c) < 0.5 * mpx ? 1 : 0, 1, BIO.badlands.road.base);
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
        windRipples(g, s, rnd, { n: 16, len: [60, 160], amp: [3, 8], lit: '#f0dcb0', lee: '#a8845a', alpha: 0.22, wid: [2, 4] });
      } });
  },
});

// ---- cliffs ------------------------------------------------------------------------------------
// Big planes of rock in very different sizes, cracks along only some of their borders, a few
// partial shelves with moss / dry grass / snow on top. Light from the upper left.

const GRANITE = {
  facets: [{ cells: [4, 7], w: 0.75, amp: 0.9, tilt: 0.45, lean: [-0.5, 0.9] }, { cells: [12, 16], w: 0.6, amp: 0.35, tilt: 0.35, lean: [-0.5, 0.9] }],
  warp: 22, crackFrac: 0.42, crackW: 2.4, facetK: 0.75, chipMin: 0.5, shelfN: 8, shelfH: 1.25, bulge: 3.2, detail: 0.14, relief: 8, cavity: 0.5, contrast: 1.6,
  slabVar: 0.07, hueMix: 0.3, soft: 3, chisel: 260,
};

register('cliff_meadow', {
  family: 'terrain', size: 512, note: 'Elwynn: gray granite planes, a few cracks and shelves, moss and grass on top (~14 m tile)',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      ...GRANITE,
      colors: ['#7c7a78', '#72716f', '#8a8580', '#767270', '#827e7a', '#7e7670'], blot: ['#6d7a4a', '#a09484', '#66667a', '#86786c', '#929086'],
      light: '#f2e0b8', shadow: '#433c5c', crack: '#342e44', glaze: '#ffe6b8', facetK: 0.85,
      cover: { shade: '#3a4a2e', mid: '#55683a', lit: '#7c8e4a', minUp: 0.12, slope: 3, top: 1.0, facet: 0.8, amt: 1.2, patch: [0.4, 0.9], edge: [0.2, 0.7], max: 0.78, lipShadow: '#3a3c48' },
      stains: 46, stain: '#3e3c46', stainA: 0.1, tuft: ['#4e7a28', '#6a9a34', '#8cb24a', '#a6c45a'], tuftN: 46, lichen: ['#b8b878', '#c8b070', '#9aa070'],
    }, cv);
  },
});
register('cliff_fields', {
  family: 'terrain', size: 512, note: 'Westfall: warm tan-brown sandstone planes, dry grass on top',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      ...GRANITE, shelfN: 9, shelfH: 1.1,
      colors: ['#9a7e62', '#a88a6a', '#8a7058', '#b09272', '#947658'], blot: ['#b0946a', '#7a6454', '#c0a482', '#8a6a52'],
      light: '#fcecc6', shadow: '#54445e', crack: '#45384a', glaze: '#ffe2a8', facetK: 0.8,
      cover: { shade: '#6a5a30', mid: '#8e7a3c', lit: '#c0a656', minUp: 0.12, slope: 3, top: 1.2, facet: 0.6, amt: 1.0, patch: [0.45, 0.85], edge: [0.2, 0.65], max: 0.8, lipShadow: '#4a4048' },
      stains: 36, stain: '#4a4048', stainA: 0.1, tuft: ['#9a8a40', '#c2a654', '#e2c56a'], tuftN: 40, lichen: ['#c8b070', '#d0a860'],
    }, cv);
  },
});
register('cliff_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: blue-gray granite, snow piled on every lip and shelf, icicles under the overhangs',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      ...GRANITE, facets: [{ cells: [4, 7], w: 0.75, amp: 1.0, tilt: 0.45, lean: [-0.4, 0.9] }, { cells: [12, 16], w: 0.6, amp: 0.4, tilt: 0.3, lean: [-0.5, 0.9] }],
      shelfN: 9, shelfH: 1.3, crackFrac: 0.45,
      colors: ['#6f7682', '#7e8694', '#666c7a', '#8a92a0', '#727888'], blot: ['#5c6274', '#9aa2b0', '#7a7a88', '#6a7484'],
      light: '#f2ecdc', shadow: '#363c5e', crack: '#2c3048', glaze: '#e4ecff', facetK: 1.1,
      cover: { shade: '#a6b4ca', mid: '#d8e0ea', lit: '#fbf8f0', minUp: 0.06, slope: 4, top: 2.4, facet: 0.45, amt: 1.6, patch: [0.15, 0.55], edge: [0.12, 0.45], max: 1, lipShadow: '#3a4466' },
      pillows: ['#ffffff', '#e8eef6', '#8496b8'], icicles: 26,
      stains: 40, stain: '#eef2f8', stainA: 0.14, lichen: ['#a8b0a0', '#c0c4b0'],
    }, cv);
  },
});
register('cliff_badlands', {
  family: 'terrain', size: 512, note: 'Thousand Needles: red-orange strata, jutting hard bands, vertical joints',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      ...GRANITE, strata: true, band: [26, 70], hardP: 0.5, bandWarp: 9, ledge: 1.6,
      bandColors: ['#9a4426', '#b4552f', '#cf7a45', '#e3a066', '#a8492a', '#c26437', '#d88c55', '#e8b07a'],
      facets: [{ cells: [6, 2], w: 0.5, amp: 0.5, tilt: 0.3, lean: [-0.2, 0.4] }, { cells: [14, 6], w: 0.5, amp: 0.25, tilt: 0.25, lean: [-0.3, 0.5] }],
      warp: 14, crackFrac: 0.35, crackW: 2, shelfN: 0, bulge: 2.4, detail: 0.1, cavity: 0.45, contrast: 1.45, slabVar: 0.05,
      colors: ['#b4552f', '#c26437', '#a8492a'], blot: ['#000000', '#ffffff'],
      light: '#ffe2b4', shadow: '#6e3442', crack: '#5a2a30', glaze: '#ffcf98',
      cover: { shade: '#9a6a44', mid: '#c89a64', lit: '#ecc890', minUp: 0.3, slope: 2, top: 0.5, amt: 0.9, patch: [0.4, 0.8], edge: [0.3, 0.6], max: 0.6 },
      stains: 60, stain: '#6a3028', stainA: 0.12,
    }, cv);
  },
});
register('cliff_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: pale sandstone strata, wind-softened, sand on the ledges',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      ...GRANITE, strata: true, band: [24, 64], hardP: 0.42, bandWarp: 13, ledge: 1.3,
      bandColors: ['#c09060', '#d4ab7c', '#c49a6c', '#e0bf92', '#b08058', '#cba076'],
      facets: [{ cells: [5, 2], w: 0.5, amp: 0.4, tilt: 0.25, lean: [-0.2, 0.4] }, { cells: [12, 5], w: 0.5, amp: 0.2, tilt: 0.2, lean: [-0.3, 0.5] }],
      warp: 18, crackFrac: 0.25, crackW: 1.8, shelfN: 0, bulge: 3.4, detail: 0.08, cavity: 0.4, contrast: 1.35, slabVar: 0.04, soft: 4,
      colors: ['#c49a6c', '#d4ab7c', '#c09060'], blot: ['#000000', '#ffffff'],
      light: '#fff2d4', shadow: '#7a5662', crack: '#6a4a4c', glaze: '#ffe6b8',
      cover: { shade: '#c4a074', mid: '#e0c294', lit: '#f6e2b8', minUp: 0.25, slope: 2.5, top: 0.8, amt: 1.1, patch: [0.35, 0.75], edge: [0.25, 0.55], max: 0.8 },
      stains: 34, stain: '#7a5a4a', stainA: 0.1,
    }, cv);
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

register('slush', {
  family: 'terrain', size: 512, note: 'Dun Morogh mud: gray-brown slush, churned snow clumps, icy puddles',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7e7a74');
    mottle(g, s, rnd, { colors: ['#6e6862', '#8e8c88', '#5e5854', '#a2a6aa', '#76706a'], count: 60, rmin: 30, rmax: 120, alpha: 0.42, hard: 0.12 });
    // churned lumps of wet snow: shadowed below, lit above
    for (let i = 0; i < 150; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 14), rot = range(rnd, -0.6, 0.6), c = pick(rnd, ['#9a9ca0', '#a8acb2', '#8e8a84', '#b4b8bc']);
      wrap(s, x, y, r * 2, (X, Y) => {
        blob(g, X + r * 0.3, Y + r * 0.35, r * 1.2, r * 0.6, rot, '#4a464c', 0.25, 0.3);
        blob(g, X, Y, r, r * 0.55, rot, c, 0.55, 0.45);
        blob(g, X - r * 0.3, Y - r * 0.2, r * 0.55, r * 0.25, rot, '#e0e6ec', 0.35, 0.4);
      });
    }
    // clumps of dirty snow
    drifts(g, s, rnd, 26, [6, 18], '#e6eaee', '#7e8aa0', 0.9);
    // icy puddles: dark rim, pale sky reflection, a glint
    for (let i = 0; i < 8; i++) {
      const x = rnd() * s, y = rnd() * s, rx = range(rnd, 18, 50), ry = rx * range(rnd, 0.35, 0.6), rot = range(rnd, -0.4, 0.4);
      wrap(s, x, y, rx * 1.3, (X, Y) => {
        blob(g, X, Y, rx * 1.25, ry * 1.3, rot, '#4a4a50', 0.35, 0.5);
        ellipse(g, X, Y, rx, ry, rot, '#808a94', 0.9);
        ellipse(g, X + rx * 0.45, Y + ry * 0.2, rx * 0.6, ry * 0.7, rot + 0.3, '#808a94', 0.9);
        blob(g, X + rx * 0.1, Y + ry * 0.1, rx * 1.1, ry * 0.8, rot, '#9eaab6', 0.6, 0.4);
        blob(g, X - rx * 0.35, Y - ry * 0.3, rx * 0.5, ry * 0.18, rot, '#e6ecf2', 0.4, 0.3);
      });
    }
    pebbles(g, s, rnd, { colors: ['#8a8e96', '#6e6c6a', '#a09c98'], count: 60, rmin: 1.5, rmax: 4 });
    glaze(g, s, s, '#e8f0ff', 0.06, 'soft-light');
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

// A half-buried snow mound at the base of a card: lit on the upper left, blue below.
function snowMound(g, cx, by, w, h) {
  blob(g, cx + w * 0.08, by - h * 0.3, w * 1.02, h * 0.95, 0, '#8a9cbc', 0.5, 0.55);
  ellipse(g, cx, by - h * 0.05, w, h, 0, '#dfe6ee');
  blob(g, cx - w * 0.2, by - h * 0.45, w * 0.75, h * 0.55, 0, '#fbf8f0', 0.9, 0.5);
  blob(g, cx + w * 0.35, by - h * 0.1, w * 0.5, h * 0.4, 0, '#a8b8d2', 0.45, 0.4);
}
register('clutter_snow', {
  family: 'terrain', size: 512, alpha: true, note: 'cells: dry grass through snow, frosted heather twigs, snowy juniper sprig, snow tussock',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => {
      tuft(g, ox + 128, oy + 250, rnd, { n: 30, spread: 66, len: [80, 170], wid: [5, 9], cols: ['#a8946a', '#bca878', '#8e8456', '#c4b282'], tip: ['#eadcae', '#f2e6c0'], base: '#5a5040', fan: 0.9, bend: 0.5 });
      snowMound(g, ox + 128, oy + 254, 84, 34);
    },
    (g, ox, oy, rnd) => {
      twigsCell(g, ox, oy, rnd, { col: '#5a4448', lit: '#9a8a90', n: 6 });
      for (let i = 0; i < 70; i++) {          // frost on the twig tips
        const x = ox + 128 + range(rnd, -90, 90), y = oy + range(rnd, 40, 200);
        const d = g.getImageData(Math.max(0, Math.min(511, Math.round(x))), Math.max(0, Math.min(511, Math.round(y))), 1, 1).data;
        if (d[3] > 100) { blob(g, x, y - 2, 5, 3.5, 0, '#f4f6fa', 0.9, 0.5); blob(g, x + 1, y, 3, 2, 0, '#9fb0cc', 0.4, 0.4); }
      }
      snowMound(g, ox + 128, oy + 254, 70, 22);
    },
    (g, ox, oy, rnd) => {
      // a low juniper: dark blue-green needle sprays fanning out, snow caps on the upper sides
      for (let i = 0; i < 16; i++) {
        const a = range(rnd, -1.2, 1.2), L = range(rnd, 70, 130), x0 = ox + 128 + range(rnd, -20, 20), y0 = oy + 248;
        const x1 = x0 + Math.sin(a) * L, y1 = y0 - Math.cos(a) * L * 0.75;
        stroke(g, [[x0, y0], [(x0 + x1) / 2, (y0 + y1) / 2 - 6], [x1, y1]], 6, 2, '#3a2e2a', 1);
        for (let k = 0; k < 14; k++) {
          const t = 0.25 + k / 14 * 0.75, px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * 6;
          const c = pick(rnd, ['#2e4a40', '#36564a', '#3e5e4e', '#284036']);
          for (const sd of [-1, 1]) stroke(g, [[px, py], [px + sd * range(rnd, 8, 16) + Math.sin(a) * 6, py - range(rnd, 4, 12)]], 4, 1, c, 1);
        }
        for (let k = 0; k < 4; k++) {
          const t = 0.4 + k / 4 * 0.6, px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * 6 - 6;
          blob(g, px, py, range(rnd, 10, 18), range(rnd, 4, 7), a * 0.3, '#eef2f6', 0.95, 0.6);
          blob(g, px - 3, py - 2, 7, 3, a * 0.3, '#ffffff', 0.8, 0.5);
        }
      }
      snowMound(g, ox + 128, oy + 254, 80, 26);
    },
    (g, ox, oy, rnd) => {
      snowMound(g, ox + 128, oy + 254, 100, 62);
      tuft(g, ox + 128, oy + 210, rnd, { n: 16, spread: 60, len: [40, 90], wid: [4, 7], cols: ['#a8946a', '#bca878', '#8e8456'], tip: ['#eadcae'], base: '#8a7a5a', fan: 1.0, bend: 0.5 });
      blob(g, ox + 110, oy + 206, 50, 14, 0, '#f6f6f2', 0.9, 0.6);
    },
  ]),
});

// ---- the sky: painted cumulus band (x = azimuth, y = elevation; bottom row = the horizon) -----

register('sky_clouds', {
  family: 'terrain', w: 2048, h: 512, alpha: true, note: 'cloud band around the sky dome (bottom = horizon); luminance = shading, alpha = density (per-cluster, so a biome can thin the sky)',
  paint(g, w, rnd, h) {
    const VX = 2.2, VW = w * VX;   // paint in "round" virtual space, squashed into the band
    // each cloud is painted at full strength into a layer, then laid down at its own density
    const L = makeCanvas(w, h), lg = L.getContext('2d');
    const lay = (density, fn) => {
      lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, w, h);
      lg.setTransform(1 / VX, 0, 0, 1, 0, 0);
      fn(lg);
      g.save(); g.globalAlpha = density; g.drawImage(L, 0, 0); g.restore();
    };
    const at = (x, r, fn) => { for (const o of [-VW, 0, VW]) if (x + o > -r && x + o < VW + r) fn(x + o); };
    // high cirrus: faint chains of long soft dabs (they vanish first when a biome thins the sky)
    for (let i = 0; i < 7; i++) {
      const x0 = rnd() * VW, y0 = range(rnd, 30, 200), Ln = range(rnd, 600, 1400), bend = range(rnd, -50, 50), th = range(rnd, 8, 20);
      const n = Math.round(Ln / 36);
      lay(range(rnd, 0.22, 0.36), cg => at(x0, Ln, X => {
        for (let k = 0; k < n; k++) {
          const t = k / (n - 1), x = X + (t - 0.5) * Ln, y = y0 + Math.sin(t * Math.PI) * bend + range(rnd, -5, 5);
          blob(cg, x, y, range(rnd, 50, 120), th * range(rnd, 0.5, 1.1) * Math.sin(0.15 + t * 2.8), range(rnd, -0.06, 0.06), '#f2f2f4', range(rnd, 0.4, 0.8), 0.2);
        }
      }));
    }
    // cumulus: clusters of crisp-edged puffs, a flat shaded base; near the horizon they are smaller
    const clusters = [];
    for (let i = 0; i < 10; i++) clusters.push({ x: (i + rnd() * 0.7) / 10 * VW, yb: range(rnd, 300, 470), big: true });
    for (let i = 0; i < 16; i++) clusters.push({ x: rnd() * VW, yb: range(rnd, 440, 500), big: false });
    for (const C of clusters) {
      const near = (500 - C.yb) / 200;                       // 0 at the horizon → 1 high up
      C.w = (C.big ? range(rnd, 260, 480) : range(rnd, 90, 180)) * (0.6 + near * 0.8);
      C.h = C.w * range(rnd, 0.24, 0.34) * (C.big ? 1 : 0.75);
      C.d = C.big ? range(rnd, 0.55, 1) : range(rnd, 0.35, 0.8);
    }
    clusters.sort((a, b) => a.yb - b.yb);
    for (const C of clusters) {
      const n = Math.round(C.big ? range(rnd, 16, 26) : range(rnd, 7, 12));
      const puffs = [];
      for (let k = 0; k < n; k++) {
        const t = (k + rnd() * 0.9) / n, mid = 1 - Math.abs(t - 0.5) * 1.7;
        const r = C.h * range(rnd, 0.32, 0.55) * (0.5 + mid * 0.7);
        puffs.push({ x: C.x + (t - 0.5) * C.w * 0.92, y: C.yb - r * 0.55 - Math.max(0, mid) * C.h * range(rnd, 0.1, 0.5), r });
      }
      // a few towers on top
      for (let k = 0; k < (C.big ? 3 : 1); k++) puffs.push({ x: C.x + range(rnd, -0.3, 0.3) * C.w, y: C.yb - C.h * range(rnd, 0.6, 0.85), r: C.h * range(rnd, 0.3, 0.42) });
      puffs.sort((a, b) => b.y - a.y);
      lay(C.d, cg => at(C.x, C.w, X => {
        const dx = X - C.x;
        cg.save();
        cg.beginPath(); cg.rect(X - C.w, C.yb - C.h * 3, C.w * 2, C.h * 3 + 2); cg.clip();      // the flat base
        for (const p of puffs) blob(cg, p.x + dx + p.r * 0.1, p.y + p.r * 0.14, p.r * 1.04, p.r * 1.0, 0, '#9ca4c0', 1, 0.72);
        for (const p of puffs) blob(cg, p.x + dx - p.r * 0.07, p.y - p.r * 0.12, p.r * 0.9, p.r * 0.86, 0, '#d2d6e4', 1, 0.7);
        for (const p of puffs) blob(cg, p.x + dx - p.r * 0.24, p.y - p.r * 0.3, p.r * 0.6, p.r * 0.56, 0, '#fffaf0', 0.95, 0.62);
        // the shaded underside
        const gr = cg.createLinearGradient(0, C.yb - C.h * 0.45, 0, C.yb);
        gr.addColorStop(0, 'rgba(140,148,180,0)'); gr.addColorStop(1, 'rgba(140,148,180,0.65)');
        cg.globalCompositeOperation = 'source-atop';
        cg.fillStyle = gr; cg.fillRect(X - C.w, C.yb - C.h * 0.45, C.w * 2, C.h * 0.45 + 2);
        cg.restore();
      }));
    }
    // soften a touch: painted, not cut out
    blurWrapX(g, w, h, 1.2);
    // fade out toward the very bottom so clouds sink into the horizon haze
    g.save(); g.globalCompositeOperation = 'destination-out';
    const gr = g.createLinearGradient(0, h - 50, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr; g.fillRect(0, h - 50, w, 50);
    g.restore();
  },
});

// ---- the horizon: three rows of distant land (far / mid / near), alpha --------------------------
// Each row is a chain of individual peaks (tileable around the ring). A peak is lit on its left
// faces and shaded on its right, with spurs radiating down from the summit that alternate light and
// shade; domes are lit like spheres (tree canopies, rounded hills); mesas carry strata.

const MTN = {
  meadow: [
    { col: '#7d92a4', lo: 0.30, hi: 0.95, kind: 'peak', n: 16, spurs: 4 },
    { col: '#5f8070', lo: 0.22, hi: 0.62, kind: 'hill', n: 22, spurs: 3 },
    { col: '#4a6a3e', lo: 0.20, hi: 0.45, kind: 'forest', n: 260 },
  ],
  fields: [
    { col: '#94978a', lo: 0.25, hi: 0.70, kind: 'hill', n: 18, spurs: 4 },
    { col: '#a29a66', lo: 0.18, hi: 0.45, kind: 'hill', n: 22, spurs: 2 },
    { col: '#6f7e40', lo: 0.14, hi: 0.32, kind: 'forest', n: 170 },
  ],
  badlands: [
    { col: '#b07a5c', lo: 0.25, hi: 0.85, kind: 'mesa', n: 16 },
    { col: '#a8603e', lo: 0.20, hi: 0.62, kind: 'mesa', n: 20 },
    { col: '#94523a', lo: 0.14, hi: 0.40, kind: 'peak', n: 24, spurs: 3 },
  ],
  snow: [
    { col: '#8494ae', lo: 0.38, hi: 1.0, kind: 'peak', n: 15, spurs: 5, snow: 0.55 },
    { col: '#6c7c96', lo: 0.26, hi: 0.72, kind: 'peak', n: 20, spurs: 4, snow: 0.42 },
    { col: '#34504e', lo: 0.20, hi: 0.46, kind: 'pines', n: 300, snow: 0.35 },
  ],
  desert: [
    { col: '#c4a07e', lo: 0.20, hi: 0.70, kind: 'mesa', n: 12 },
    { col: '#d0ac84', lo: 0.14, hi: 0.40, kind: 'dune', n: 16 },
    { col: '#c49a6a', lo: 0.10, hi: 0.28, kind: 'dune', n: 22 },
  ],
};

function mtnRow(rnd, L, w, rowH) {
  const peaks = [];
  for (let i = 0; i < L.n; i++) {
    const tree = L.kind === 'forest' || L.kind === 'pines';
    const hgt = range(rnd, 0.25, 1) ** (tree ? 0.6 : 1.2);
    const wid = L.kind === 'pines' ? range(rnd, 6, 13) : L.kind === 'forest' ? range(rnd, 10, 26) : L.kind === 'mesa' ? range(rnd, 90, 260) : range(rnd, 0.8, 1.6) * w / L.n * (0.6 + hgt);
    peaks.push({ x: rnd() * w, h: (L.lo + (L.hi - L.lo) * hgt) * rowH, wid, gam: range(rnd, 0.75, 1.1), skew: range(rnd, -0.35, 0.35), ph: rnd() * 6, k: L.spurs || 3, strat: rnd() });
  }
  return peaks;
}
function peakAt(P, kind, x, w) {        // height of peak P at x (wrapped), or -1
  let d = x - P.x; if (d > w / 2) d -= w; if (d < -w / 2) d += w;
  const u = d / P.wid;
  if (u <= -1 || u >= 1) return [-1, u];
  if (kind === 'forest') return [P.h * Math.sqrt(1 - u * u), u];
  if (kind === 'pines') { const e = Math.abs(u); return [P.h * Math.pow(1 - e, 0.85) * (1 - 0.12 * (Math.floor((1 - e) * 4) % 2)), u]; }
  if (kind === 'mesa') { const e = Math.abs(u); return [P.h * (e < 0.62 ? 1 : 1 - Math.pow((e - 0.62) / 0.38, 0.6)), u]; }
  if (kind === 'dune') { const v = u < P.skew ? (u + 1) / (P.skew + 1) : (1 - u) / (1 - P.skew); return [P.h * Math.pow(Math.max(0, v), 1.3) , u]; }
  const v = u < P.skew ? (u + 1) / (P.skew + 1) : (1 - u) / (1 - P.skew);
  return [P.h * Math.pow(Math.max(0, v), kind === 'hill' ? 0.7 : P.gam) * (kind === 'hill' ? 1 : 1), u];
}

for (const b of Object.keys(MTN)) {
  register(`sky_mtn_${b}`, {
    family: 'terrain', w: 2048, h: 768, alpha: true, note: `${b}: distant land in rows far/mid/near (fog-tinted in the shader)`,
    paint(g, w, rnd, h) {
      const img = g.createImageData(w, h), D = img.data;
      const rowH = h / 3;
      MTN[b].forEach((L, row) => {
        const peaks = mtnRow(rnd, L, w, rowH);
        const base = hex(L.col), lit = hex(lightOf(L.col, 0.4)), dark = hex(shadowOf(L.col, 0.32)), haze = hex(mix(L.col, '#e8eef0', 0.3));
        const bandC = [hex(shade(L.col, 0.86)), hex(lightOf(L.col, 0.2)), hex(shadowOf(L.col, 0.15)), hex(lightOf(L.col, 0.35))];
        const rough = periodic(rnd, 9, 0.6, 30), roll = periodic(rnd, 6, 1.1, 2);
        const snowLit = hex('#f4f6fa'), snowShd = hex('#aebfd8'), snowRough = periodic(rnd, 8, 0.7, 12);
        const baseH = x => (L.lo * 0.75 + (L.hi - L.lo) * (0.16 + 0.12 * roll(x / w))) * rowH;
        const BASE = { h: 0, wid: 1, skew: 0, k: 2, ph: 0, strat: 0.3 };
        for (let x = 0; x < w; x++) {
          // the front-most peak at this column, and the silhouette (a rolling base fills the gaps)
          let top = 0, best = null, bu = 0;
          for (const P of peaks) { const [ph, u] = peakAt(P, L.kind, x, w); if (ph > top) { top = ph; best = P; bu = u; } }
          const bh = baseH(x);
          if (bh > top) { top = bh; best = BASE; BASE.h = bh; bu = (baseH(x + 3) - baseH(x - 3)) < 0 ? -0.3 : 0.3; }
          top += rough(x / w) * (L.kind === 'forest' || L.kind === 'pines' ? 1.5 : 3);
          for (let yy = 0; yy < rowH; yy++) {
            const hb = rowH - 1 - yy;
            const a = Math.max(0, Math.min(1, top - hb + 0.5));
            const k = ((row * rowH + yy) * w + x) * 4;
            if (a <= 0 || !best) { D[k] = base.r; D[k + 1] = base.g; D[k + 2] = base.b; D[k + 3] = 0; continue; }
            const depth = Math.max(0, (top - hb) / Math.max(8, top));   // 0 at the ridge → 1 at the base
            let f;                                                        // facing: + lit, - shaded
            let sp = 0;
            if (L.kind === 'forest' || L.kind === 'pines') {
              const vy = Math.min(1, (top - hb) / Math.max(4, best.h));
              f = -bu * 0.9 + (1 - vy) * 0.5 - 0.15;
            } else if (L.kind === 'mesa') {
              const e = Math.abs(bu);
              f = e < 0.62 ? (hb > best.h - 3 ? 0.8 : 0.1 - depth * 0.3) : (bu < 0 ? 0.55 : -0.6);
              f += (Math.sin(hb * 0.35 + best.strat * 6) > 0.6 ? 0.18 : 0);
            } else {
              // spurs radiate from the summit; their faces alternate, the left side of the peak is lit
              const dy = (best.h - hb) + 2, dx = bu * best.wid;
              const ang = Math.atan2(dx, dy);
              sp = Math.sin(ang * best.k * 2.2 + best.ph + depth * 1.5);
              f = (bu < best.skew ? 0.45 : -0.45) * (0.6 + 0.4 * (1 - depth)) + sp * 0.45 * (1 - depth * 0.6);
            }
            let c = f > 0 ? mixRGB(base, lit, Math.min(1, f) * 0.85) : mixRGB(base, dark, Math.min(1, -f) * 0.85);
            if (L.kind === 'mesa') c = mixRGB(c, bandC[Math.floor(hb / 9 + best.strat * 4) % 4], 0.35);
            if (L.snow && best !== BASE) {                                  // snow caps, lower along the spurs
              const rel = hb / Math.max(1, best.h);
              const line = 1 - L.snow * (0.7 + 0.6 * best.strat) - sp * 0.1 + snowRough(x / w) * 0.08 - (L.kind === 'pines' ? 0.15 : 0);
              if (rel > line) c = mixRGB(c, f > -0.05 ? mixRGB(snowShd, snowLit, Math.min(1, 0.4 + f)) : snowShd, Math.min(1, (rel - line) * 12) * 0.95);
            }
            c = mixRGB(c, haze, Math.min(1, depth * 0.8));                // valley haze toward the base
            if (top - hb < 2.2) c = mixRGB(c, lit, 0.3);                    // a lit rim along the ridge
            D[k] = c.r; D[k + 1] = c.g; D[k + 2] = c.b; D[k + 3] = Math.round(a * 255);
          }
        }
      });
      g.putImageData(img, 0, 0);
      // soften: a painted look, not a rendered one
      blurWrapX(g, w, h, 0.8);
    },
  });
}
// Blur a band that wraps around the sky horizontally (no seam at u = 0 / 1).
function blurWrapX(g, w, h, px) {
  const big = makeCanvas(w * 3, h), bg = big.getContext('2d');
  for (let i = 0; i < 3; i++) bg.drawImage(g.canvas, i * w, 0);
  const out = makeCanvas(w * 3, h), og = out.getContext('2d');
  og.filter = `blur(${px}px)`; og.drawImage(big, 0, 0);
  g.clearRect(0, 0, w, h); g.drawImage(out, w, 0, w, h, 0, 0, w, h);
}
function mixRGB(a, b, t) { return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }; }
