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

// ---- natural rock faces ---------------------------------------------------------------------------
// A cliff is painted from a relief: a height field (how far the rock sticks out toward the viewer)
// built from big tilted planes (a domain-warped Voronoi of slabs), broken ledges (a sawtooth per slab:
// a lit lip on top, a face that recedes into shadow below it), broad bulges and fine chisel marks.
// It is lit from the upper left, darkened in its cavities, and then painted over: moss and grass on
// the lips, rain stains running down from them, cracks and lichen. Strata biomes colour the same
// relief by height in bands (the y axis is world height, so the bands stay level in the world).

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

// The height field for massive rock (meadow, fields): a few big slabs at different depths (the
// joints), terraced noise for natural, irregular ledges that follow its contours, broad bulges.
function rockRelief(s, rnd, P) {
  const N = s * s, H = new Float32Array(N), SLAB = new Int32Array(N), TOP = new Float32Array(N);
  const [cx, cy] = P.cells;
  const slabs = jitterSeeds(rnd, s, cx, cy, 0.9, 0.8, r => ({ d: r() * P.depth, tx: range(r, -P.tilt, P.tilt), ty: range(r, -0.2, 0.6) * P.tilt, dome: range(r, 0.3, 1) * P.dome }));
  const WX = fbmField(rnd, s, 3, 3), WY = fbmField(rnd, s, 3, 3);
  const T = fbmField(rnd, s, 3, P.terrG, 0.42, P.terrAniso);
  const BU = fbmField(rnd, s, 3, 2, 0.5);
  const DET = fbmField(rnd, s, 2, 28, 0.5, 0.7);
  const o = [0, 0, 0, 0, 0], cw = s / cx, ch = s / cy;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x;
    const u = ((x + WX[k] * P.warp) % s + s) % s, v = ((y + WY[k] * P.warp * 0.6) % s + s) % s;
    voronoiAt(slabs, cx, cy, s, u, v, P.aniso, o);
    const sl = slabs[o[0]];
    SLAB[k] = o[0];
    const nx = o[3] / cw, ny = o[4] / ch;
    TOP[k] = Math.max(0, Math.min(1, -ny * 1.6 - 0.15)) * Math.max(0, 1 - Math.abs(nx) * 0.9);
    let h = sl.d + sl.tx * nx + sl.ty * ny + sl.dome * (1 - Math.min(1, (nx * nx + ny * ny) * 1.2));
    // terraces: flat faces broken by short steep risers along the noise's contours
    const l = (T[k] * 0.5 + 0.5 + sl.d * 0.3) * P.terr;
    const f = l - Math.floor(l);
    h += (Math.floor(l) + sst(0.62, 1, f) * 0.85 + f * 0.15) * P.terrAmp;
    h += BU[k] * P.bulge + DET[k] * P.detail;
    H[k] = h;
  }
  return { H, SLAB, TOP };
}

// The height field and colour bands for strata (badlands, desert): y maps (with a noisy warp) onto
// a list of bands; hard bands bulge out with a lit top and a shaded underside, soft bands recede;
// vertical flutes run down the face and a few big blocks have slumped forward.
function strataRelief(s, rnd, P) {
  const N = s * s, H = new Float32Array(N), SLAB = new Int32Array(N), FB = new Float32Array(N);
  // band boundaries (in y), thick and thin, each with a colour and a hardness
  const ys = [0]; let tot = 0; const th = [];
  while (tot < s) { const t = range(rnd, P.band[0], P.band[1]) * (rnd() < 0.3 ? 0.45 : 1); th.push(t); tot += t; }
  const kk = s / tot; for (const t of th) ys.push(ys[ys.length - 1] + t * kk); ys[ys.length - 1] = s;
  const nb = th.length, bands = [];
  let last = -1;
  for (let i = 0; i < nb; i++) {
    let ci; do { ci = Math.floor(rnd() * P.colors.length); } while (ci === last && P.colors.length > 1);
    last = ci;
    bands.push({ c: hex(jitter(P.colors[ci], rnd, 0.04)), hard: rnd() < P.hardP ? range(rnd, 0.7, 1.1) : 0 });
  }
  const WY = fbmField(rnd, s, 3, 4, 0.5, 0.5), WY2 = fbmField(rnd, s, 2, 12, 0.5, 0.4);
  const FL = fbmField(rnd, s, 3, P.flutes, 0.55, 0.22);
  const BU = fbmField(rnd, s, 3, 2, 0.5);
  const DET = fbmField(rnd, s, 2, 24, 0.5, 0.4);
  const blocks = jitterSeeds(rnd, s, P.cells[0], P.cells[1], 0.9, 0.8, r => ({ d: r() * P.depth, tx: range(r, -P.tilt, P.tilt) }));
  const o = [0, 0, 0, 0, 0];
  const band = new Int32Array(N), frac = new Float32Array(N);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x;
    const yy = (((y + WY[k] * P.bandWarp + WY2[k] * P.bandWarp * 0.25) % s) + s) % s;
    let i = 0; while (i < nb - 1 && yy >= ys[i + 1]) i++;
    const f = (yy - ys[i]) / (ys[i + 1] - ys[i]);
    band[k] = i; frac[k] = f;
    const b = bands[i];
    let h = b.hard ? b.hard * P.ledge * (0.35 + Math.sin(Math.PI * Math.min(1, f * 1.05)) * 0.65) : P.ledge * (-0.05 - 0.2 * f);
    voronoiAt(blocks, P.cells[0], P.cells[1], s, x, y, P.aniso, o);
    const bl = blocks[o[0]];
    h += bl.d + bl.tx * o[3] / (s / P.cells[0]);
    h += FL[k] * P.flute * (b.hard ? 0.5 : 1) + BU[k] * P.bulge + DET[k] * P.detail;
    H[k] = h; SLAB[k] = i;
  }
  return { H, SLAB, bands, band, frac };
}

function paintRockFace(g, s, rnd, P, cv) {
  const N = s * s;
  // -- 1. the relief, and the colour layer under the light
  const R = P.strata ? strataRelief(s, rnd, P) : rockRelief(s, rnd, P);
  const { H, SLAB } = R;
  fill(g, s, s, P.colors[0]);
  if (!P.strata) {
    mottle(g, s, rnd, { colors: P.colors, count: 40, rmin: 50, rmax: 150, alpha: 0.5, hard: 0.1 });
    mottle(g, s, rnd, { colors: P.blot, count: 70, rmin: 14, rmax: 50, alpha: 0.22, hard: 0.2, stretch: 1.6, rot: 0 });
  } else {
    mottle(g, s, rnd, { colors: ['#000000', '#ffffff'], count: 120, rmin: 14, rmax: 60, alpha: 0.12, hard: 0.15, stretch: 2.6, rot: 0 });
  }
  const base = g.getImageData(0, 0, s, s), B = base.data;
  if (P.strata) {      // the band colours, modulated by the painted light/dark blotches
    for (let k = 0; k < N; k++) {
      const c = R.bands[R.band[k]].c, m = B[k * 4] / 127.5;
      B[k * 4] = c.r * (0.85 + 0.15 * m); B[k * 4 + 1] = c.g * (0.85 + 0.15 * m); B[k * 4 + 2] = c.b * (0.85 + 0.15 * m);
    }
  }
  const slabTint = new Float32Array(4096).map(() => range(rnd, -1, 1));
  const slabMoss = new Float32Array(4096).map(() => rnd());
  const Hs = blurField(Float32Array.from(H), s, P.soft ?? 2, 2);
  const Hb = blurField(Float32Array.from(H), s, 10, 2);
  const MOSS = fbmField(rnd, s, 3, 4, 0.55);
  // -- 2. light it from the upper left, a little in front; cavities darken and cool
  const Lx = -0.48, Ly = -0.66, Lz = 0.58, Ll = Math.hypot(Lx, Ly, Lz);
  const lit = hex(P.light), shd = hex(P.shadow), deep = hex(shadowOf(P.shadow, 0.35));
  const moss = hex(P.moss), mossLit = hex(lightOf(P.moss, 0.5)), mossDk = hex(shadowOf(P.moss, 0.3));
  const NY = new Float32Array(N);
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
    const tk = 1 + slabTint[SLAB[k] & 4095] * P.slabVar;
    r *= tk; gg *= tk; b *= tk;
    const t = (dif - 0.58) * 1.8 + cav * 0.45;
    if (t < 0) { const a = Math.min(0.88, -t * 0.95); const c = a > 0.6 ? deep : shd; r += (c.r - r) * a; gg += (c.g - gg) * a; b += (c.b - b) * a; }
    else { const a = Math.min(0.72, t * 0.8); r += (lit.r - r) * a; gg += (lit.g - gg) * a; b += (lit.b - b) * a; }
    // moss / dry grass on whatever faces up
    if (P.mossAmt > 0) {
      const up = Math.max(0, -ny - 0.12) * 3.4 + (R.TOP ? R.TOP[k] * 0.75 : 0);
      const nzM = MOSS[k] * 0.9 + 0.5 + (slabMoss[SLAB[k] & 4095] - 0.5) * 0.5;
      let m = up * P.mossAmt * sst(0.4, 0.75, nzM);
      if (m > 0.01) {
        m = Math.min(0.9, m) * sst(0, 0.5, m);
        // moss takes the light too: dark and cool in shade, yellow-green where lit
        const lt = Math.max(0, Math.min(1, t * 1.2 + 0.4));
        const mr = mossDk.r + (mossLit.r - mossDk.r) * lt, mg = mossDk.g + (mossLit.g - mossDk.g) * lt, mb = mossDk.b + (mossLit.b - mossDk.b) * lt;
        r += (mr - r) * m; gg += (mg - gg) * m; b += (mb - b) * m;
      }
    }
    B[k * 4] = r; B[k * 4 + 1] = gg; B[k * 4 + 2] = b; B[k * 4 + 3] = 255;
  }
  g.putImageData(base, 0, 0);
  // -- 3. painted details on top
  const lips = [];
  for (let i = 0; i < 6000 && lips.length < 220; i++) {
    const x = Math.floor(rnd() * s), y = Math.floor(rnd() * s), k = y * s + x;
    if (NY[k] < -0.42) lips.push([x, y]);
  }
  // rain stains running down from the lips
  for (const [x, y] of lips.slice(0, P.stains ?? 50)) {
    const L = range(rnd, 24, 100), w = range(rnd, 3, 8);
    const pts = []; let px = 0; for (let i = 0; i <= 5; i++) { pts.push([px, 4 + L * i / 5]); px += range(rnd, -1.5, 1.5); }
    wrap(s, x, y + L / 2, L, (X, Y) => stroke(g, pts.map(([u, v]) => [X + u, Y - L / 2 + v]), w, w * 0.3, P.stain, 0.12));
  }
  if (P.crackN) cracks(g, s, rnd, { color: shadowOf(P.shadow, 0.3), count: P.crackN, len: [26, 70], width: [1, 2], alpha: 0.35, branch: 0.4 });
  // grass clinging to the lips
  if (P.tuft) for (const [x, y] of lips.slice(60, 60 + (P.tuftN ?? 40))) {
    const n = 5 + Math.floor(rnd() * 7);
    wrap(s, x, y, 22, (X, Y) => {
      blob(g, X + 2, Y + 5, 10, 4, 0, '#1e2418', 0.28, 0.3);
      for (let i = 0; i < n; i++) blade(g, X + range(rnd, -8, 8), Y + 3, range(rnd, 6, 13), range(rnd, -0.9, 0.9), range(rnd, 1.6, 2.8), pick(rnd, P.tuft), 0.9, range(rnd, -0.5, 0.5));
    });
  }
  if (P.lichen) for (let i = 0; i < 36; i++) {
    const x = rnd() * s, y = rnd() * s, c = pick(rnd, P.lichen);
    for (let j = 0; j < 6; j++) { const xx = x + range(rnd, -9, 9), yy = y + range(rnd, -6, 6), r = range(rnd, 1.5, 3.8); wrap(s, xx, yy, r, (X, Y) => blob(g, X, Y, r, r * 0.8, 0, c, 0.5, 0.5)); }
  }
  glaze(g, s, s, P.glaze || '#ffe2b0', 0.1, 'soft-light');
  blurTile(cv, 0.55);
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
    fill(g, s, s, '#557a2c');
    mottle(g, s, rnd, { colors: ['#46692a', '#6a8f36', '#7f9c3c', '#4f7329', '#8c973a', '#3c5e26'], count: 50, rmin: 50, rmax: 150, alpha: 0.42, hard: 0.08 });
    mottle(g, s, rnd, { colors: ['#3c6522', '#74a03c', '#5d8a30', '#8a9a40'], count: 150, rmin: 10, rmax: 34, alpha: 0.3, hard: 0.3, stretch: 1.3 });
    // a few bare earthy spots peeking through
    mottle(g, s, rnd, { colors: ['#6a5a30', '#5e5a2c'], count: 12, rmin: 8, rmax: 20, alpha: 0.28, hard: 0.4 });
    bladePass(g, s, rnd, 1400, ['#2f5419', '#3a611f'], [7, 15], [1.6, 2.6], 0.55);
    bladePass(g, s, rnd, 1500, ['#5b8c2f', '#66983a', '#527f2b'], [7, 14], [1.4, 2.4], 0.6);
    bladePass(g, s, rnd, 700, ['#a4bc55', '#b8c862', '#94ae4a', '#c8c46a'], [5, 10], [1.1, 1.8], 0.55);
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
    sandRipples(g, s, rnd, '#ecd6a8', '#a8805a', 18, 0.16);
    mottle(g, s, rnd, { colors: ['#d8b480', '#c09464'], count: 60, rmin: 20, rmax: 70, alpha: 0.3, hard: 0.2 });
    dryCracks(g, s, rnd, { n: 40, len: [20, 50], w: [0.9, 1.6], color: '#9a7048', lip: '#f6e2b8', alpha: 0.3 });
    stones(g, s, rnd, { colors: ['#d8c09a', '#b89a74', '#e8d4ae', '#9c8268', '#a07a5a'], count: 220, rmin: 1.3, rmax: 3.2, ground: '#cba26c', sink: 0.35 });
    stones(g, s, rnd, { colors: ['#c4a47c', '#9c8268'], count: 18, rmin: 4, rmax: 8, ground: '#cba26c', sink: 0.2 });
    bladePass(g, s, rnd, 30, ['#8a7448', '#b8a468'], [5, 9], [1, 1.5], 0.45);
    glaze(g, s, s, '#ffe8b8', 0.1, 'soft-light');
    blurTile(cv, 0.4);
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
        sandRipples(g, s, rnd, '#f0dcb0', '#b08a5c', 14, 0.14);
      } });
  },
});

// ---- cliffs ------------------------------------------------------------------------------------

register('cliff_meadow', {
  family: 'terrain', size: 512, note: 'Elwynn: gray granite masses with natural ledges, moss and grass on top (~14 m tile)',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      colors: ['#85817a', '#77746e', '#9a9286', '#7a7468', '#8e8a80', '#8a7c6c'], blot: ['#6d7a4a', '#a8977e', '#66667a', '#8a7a68', '#9a8a72'],
      light: '#f6e4bc', shadow: '#47405e', moss: '#5f7c2e', mossAmt: 1.5, stain: '#3c3a44', glaze: '#ffe6b8',
      cells: [3, 3], aniso: 1.3, warp: 40, depth: 0.75, dome: 0.5, tilt: 0.45,
      terr: 3, terrG: 2, terrAniso: 2.5, terrAmp: 0.6, bulge: 0.5, detail: 0.05, relief: 9, cavity: 1.3, slabVar: 0.09,
      crackN: 6, tuft: ['#4e7a28', '#6a9a34', '#8cb24a', '#a6c45a'], tuftN: 44, lichen: ['#b8b878', '#c8b070', '#9aa070'],
    }, cv);
  },
});
register('cliff_fields', {
  family: 'terrain', size: 512, note: 'Westfall: warm brown-gray rock, dry grass on top',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      colors: ['#8e8472', '#9a907c', '#80786a', '#a49884', '#887c68'], blot: ['#a08a5a', '#6e665a', '#b0a488', '#8a7058'],
      light: '#f8e8c2', shadow: '#504258', moss: '#a8964a', mossAmt: 0.85, stain: '#4a4048', glaze: '#ffe2a8',
      cells: [3, 3], aniso: 1.4, warp: 36, depth: 0.9, dome: 0.4, tilt: 0.4,
      terr: 3.5, terrG: 2, terrAniso: 2.5, terrAmp: 0.6, bulge: 0.5, detail: 0.05, relief: 9, cavity: 1.3, slabVar: 0.09,
      crackN: 5, tuft: ['#9a8a40', '#c2a654', '#e2c56a'], tuftN: 34, lichen: ['#c8b070', '#d0a860'],
    }, cv);
  },
});
register('cliff_badlands', {
  family: 'terrain', size: 512, note: 'Thousand Needles: red-orange strata, jutting hard bands, vertical erosion flutes',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      strata: true, band: [26, 70], hardP: 0.55, bandWarp: 10, colors: ['#9a4426', '#b4552f', '#cf7a45', '#e3a066', '#a8492a', '#c26437', '#d88c55', '#e8b07a'],
      light: '#ffe4b8', shadow: '#5a2a40', moss: '#c89058', mossAmt: 0, stain: '#5a2a2a', glaze: '#ffcf98',
      cells: [4, 2], aniso: 0.6, depth: 0.35, tilt: 0.25, ledge: 0.9, flutes: 6, flute: 0.4, bulge: 0.3, detail: 0.04,
      relief: 9, cavity: 1.1, slabVar: 0, stains: 70, crackN: 0, lichen: null,
    }, cv);
  },
});
register('cliff_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: pale sandstone strata, wind-softened',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      strata: true, band: [24, 64], hardP: 0.45, bandWarp: 14, colors: ['#c09060', '#d4ab7c', '#c49a6c', '#e0bf92', '#b08058', '#cba076'],
      light: '#fff2d4', shadow: '#74505e', moss: '#d8b888', mossAmt: 0, stain: '#7a5a4a', glaze: '#ffe6b8',
      cells: [3, 2], aniso: 0.6, depth: 0.3, tilt: 0.25, ledge: 0.7, flutes: 5, flute: 0.4, bulge: 0.45, detail: 0.03,
      relief: 8, cavity: 1.0, slabVar: 0, stains: 36, crackN: 0, lichen: null,
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
  family: 'terrain', w: 2048, h: 512, alpha: true, note: 'cloud band around the sky dome (bottom = horizon); only luminance and alpha are used',
  paint(g, w, rnd, h) {
    const VX = 2.2, VW = w * VX;   // paint in "round" virtual space, squashed into the band
    g.setTransform(1 / VX, 0, 0, 1, 0, 0);
    const at = (x, r, fn) => { for (const o of [-VW, 0, VW]) if (x + o > -r && x + o < VW + r) fn(x + o); };
    // high feathery cirrus: chains of soft elongated dabs along gentle curves
    for (let i = 0; i < 8; i++) {
      const x0 = rnd() * VW, y0 = range(rnd, 30, 230), L = range(rnd, 500, 1300), bend = range(rnd, -60, 60), th = range(rnd, 10, 26);
      const n = Math.round(L / 40);
      at(x0, L, X => {
        for (let k = 0; k < n; k++) {
          const t = k / (n - 1), x = X + (t - 0.5) * L, y = y0 + Math.sin(t * Math.PI) * bend + range(rnd, -6, 6);
          const a = 0.11 * Math.sin(t * Math.PI) * range(rnd, 0.5, 1.2);
          blob(g, x, y, range(rnd, 50, 110), th * range(rnd, 0.5, 1.1), range(rnd, -0.08, 0.08), '#f6f4f0', a, 0.15);
        }
      });
    }
    // cumulus: soft clusters; nearer (higher in the band) ones are bigger
    const clusters = [];
    for (let i = 0; i < 10; i++) {
      const yb = i < 6 ? range(rnd, 420, 495) : range(rnd, 300, 420);
      const sz = 0.45 + (495 - yb) / 205 * 0.8;
      clusters.push({ x: (i + rnd() * 0.7) / 10 * VW, yb, w: range(rnd, 700, 1400) * sz });
    }
    clusters.sort((a, b) => a.yb - b.yb);
    for (const C of clusters) {
      const n = 13 + Math.floor(rnd() * 9);
      const puffs = [];
      for (let k = 0; k < n; k++) {
        const t = (k + rnd() * 0.9) / n, mid = 1 - Math.abs(t - 0.5) * 1.6;
        const r = C.w * range(rnd, 0.08, 0.15) * (0.5 + mid * 0.75);
        puffs.push({ x: C.x + (t - 0.5) * C.w * 0.95, y: C.yb - r * 0.45 - mid * C.w * 0.07 * range(rnd, 0.4, 1.3), r });
      }
      for (let k = 0; k < 4; k++) puffs.push({ x: C.x + range(rnd, -0.25, 0.22) * C.w, y: C.yb - C.w * range(rnd, 0.13, 0.24), r: C.w * range(rnd, 0.09, 0.15) });
      at(C.x, C.w, X => {
        const dx = X - C.x;
        // the flat, shaded underside and a soft body
        blob(g, X, C.yb - C.w * 0.02, C.w * 0.55, C.w * 0.05, 0, '#9ea6c0', 0.55, 0.3);
        for (const p of puffs) blob(g, p.x + dx + p.r * 0.12, p.y + p.r * 0.12, p.r * 1.08, p.r * 1.0, 0, '#a8b0c8', 0.85, 0.3);
        for (const p of puffs) blob(g, p.x + dx - p.r * 0.08, p.y - p.r * 0.15, p.r * 0.92, p.r * 0.82, 0, '#dedfe8', 0.85, 0.28);
        for (const p of puffs) blob(g, p.x + dx - p.r * 0.25, p.y - p.r * 0.32, p.r * 0.55, p.r * 0.45, 0, '#fffaf0', 0.75, 0.25);
        // ragged wisps at the edges
        for (let k = 0; k < 10; k++) {
          const side = rnd() < 0.5 ? -1 : 1, x = X + side * C.w * range(rnd, 0.35, 0.6), y = C.yb - C.w * range(rnd, 0.0, 0.1);
          blob(g, x, y, C.w * range(rnd, 0.06, 0.14), C.w * range(rnd, 0.015, 0.035), range(rnd, -0.15, 0.15), '#e8e8ee', 0.3, 0.2);
        }
        blob(g, X, C.yb - C.w * 0.015, C.w * 0.48, C.w * 0.03, 0, '#8e96b4', 0.4, 0.3);
      });
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
    // fade out toward the very bottom so clouds sink into the horizon haze
    g.save(); g.globalCompositeOperation = 'destination-out';
    const gr = g.createLinearGradient(0, h - 60, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr; g.fillRect(0, h - 60, w, 60);
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
  desert: [
    { col: '#c4a07e', lo: 0.20, hi: 0.70, kind: 'mesa', n: 12 },
    { col: '#d0ac84', lo: 0.14, hi: 0.40, kind: 'dune', n: 16 },
    { col: '#c49a6a', lo: 0.10, hi: 0.28, kind: 'dune', n: 22 },
  ],
};

function mtnRow(rnd, L, w, rowH) {
  const peaks = [];
  for (let i = 0; i < L.n; i++) {
    const hgt = range(rnd, 0.25, 1) ** (L.kind === 'forest' ? 0.6 : 1.2);
    const wid = L.kind === 'forest' ? range(rnd, 10, 26) : L.kind === 'mesa' ? range(rnd, 90, 260) : range(rnd, 0.8, 1.6) * w / L.n * (0.6 + hgt);
    peaks.push({ x: rnd() * w, h: (L.lo + (L.hi - L.lo) * hgt) * rowH, wid, gam: range(rnd, 0.75, 1.1), skew: range(rnd, -0.35, 0.35), ph: rnd() * 6, k: L.spurs || 3, strat: rnd() });
  }
  return peaks;
}
function peakAt(P, kind, x, w) {        // height of peak P at x (wrapped), or -1
  let d = x - P.x; if (d > w / 2) d -= w; if (d < -w / 2) d += w;
  const u = d / P.wid;
  if (u <= -1 || u >= 1) return [-1, u];
  if (kind === 'forest' || kind === 'hill' && false) return [P.h * Math.sqrt(1 - u * u), u];
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
        const baseH = x => (L.lo * 0.75 + (L.hi - L.lo) * (0.16 + 0.12 * roll(x / w))) * rowH;
        const BASE = { h: 0, wid: 1, skew: 0, k: 2, ph: 0, strat: 0.3 };
        for (let x = 0; x < w; x++) {
          // the front-most peak at this column, and the silhouette (a rolling base fills the gaps)
          let top = 0, best = null, bu = 0;
          for (const P of peaks) { const [ph, u] = peakAt(P, L.kind, x, w); if (ph > top) { top = ph; best = P; bu = u; } }
          const bh = baseH(x);
          if (bh > top) { top = bh; best = BASE; BASE.h = bh; bu = (baseH(x + 3) - baseH(x - 3)) < 0 ? -0.3 : 0.3; }
          top += rough(x / w) * (L.kind === 'forest' ? 1.5 : 3);
          for (let yy = 0; yy < rowH; yy++) {
            const hb = rowH - 1 - yy;
            const a = Math.max(0, Math.min(1, top - hb + 0.5));
            const k = ((row * rowH + yy) * w + x) * 4;
            if (a <= 0 || !best) { D[k] = base.r; D[k + 1] = base.g; D[k + 2] = base.b; D[k + 3] = 0; continue; }
            const depth = Math.max(0, (top - hb) / Math.max(8, top));   // 0 at the ridge → 1 at the base
            let f;                                                        // facing: + lit, - shaded
            if (L.kind === 'forest') {
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
              const sp = Math.sin(ang * best.k * 2.2 + best.ph + depth * 1.5);
              f = (bu < best.skew ? 0.45 : -0.45) * (0.6 + 0.4 * (1 - depth)) + sp * 0.45 * (1 - depth * 0.6);
            }
            let c = f > 0 ? mixRGB(base, lit, Math.min(1, f) * 0.85) : mixRGB(base, dark, Math.min(1, -f) * 0.85);
            if (L.kind === 'mesa') c = mixRGB(c, bandC[Math.floor(hb / 9 + best.strat * 4) % 4], 0.35);
            c = mixRGB(c, haze, Math.min(1, depth * 0.8));                // valley haze toward the base
            if (top - hb < 2.2) c = mixRGB(c, lit, 0.3);                    // a lit rim along the ridge
            D[k] = c.r; D[k + 1] = c.g; D[k + 2] = c.b; D[k + 3] = Math.round(a * 255);
          }
        }
      });
      g.putImageData(img, 0, 0);
      // soften: a painted look, not a rendered one
      const cv2 = makeCanvas(w, h), g2 = cv2.getContext('2d');
      g2.filter = 'blur(0.8px)'; g2.drawImage(g.canvas, 0, 0);
      g.clearRect(0, 0, w, h); g.drawImage(cv2, 0, 0);
    },
  });
}
function mixRGB(a, b, t) { return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }; }
