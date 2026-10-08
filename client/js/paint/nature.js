// Texture family: nature. See docs/ART.md for the style rules.
//
// Bark & wood (tile; u runs around a trunk, v up it):
//   bark_oak      Elwynn oak: warm gray-brown plates of varied width, lit left edges, deep soft furrows
//                 that wander, split and merge (one continuous stroke each, no beading)
//   bark_pine     red-brown scaly plates (stretch v ×2 on the mesh)
//   bark_dead     bleached deadwood: long grain, splits with lit lips, knots
//   bark_palm     stacked leaf-base rings: lit lips, dark creases, frayed edges and fibre hairs
//   wood_fence    split-rail wood: warm brown, sun-bleached streaks, dark crevices with lit lips, knots
// Foliage (alpha atlases; canvas top-left = cell 0, cells laid out left to right, top to bottom):
//   leaves_oak    2×2: 0 canopy clump (solid lobes, scalloped leaf edge) · 1 hanging skirt · 2 dense core mass · 3 bush clump
//   leaves_autumn 2×2, Westfall: the same cells in olive, gold and rust
//   leaves_scrub  2×2: 0 sage brush · 1 dry tangle (solid core) · 2 dense sage mass · 3 juniper spray
//   needles_pine  2×2: 0, 1 drooping boughs (base at the bottom, tip at the top) · 2 dense needles · 3 tip
//   needles_snow  4×2, Dun Morogh: snowy cells on the left half, the same cells without snow on the right
//                 half (a card's underside shows ~60% of the bare copy): 0, 1 snowy boughs · 4 a snowy
//                 shrub mound · 5 snowy tip; 2, 3, 7 the bare boughs, 6 dense needles (inner cones)
//   palm_frond    two 256×512 fronds side by side (green, dry), rachis from the bottom up
//   straw_tuft    2×2: 0, 1 straw tufts fanning up · 2 ragged straw fringe · 3 loose wisps
// Rock (tile; world-space triplanar, so v = height and strata stay level):
//   rock_gray (meadow) rock_warm (fields) rock_granite (snow): big soft value planes, long fractures
//     with a lit lip and a cool crease, chips, lichen
//   rock_red (badlands) / rock_sand (desert): bedded rock in the canyon walls' language: soft beds pale
//     and deep by turns (wandering sub-beds, a few broken ledgelets) between hard beds at the fixed
//     heights in STRATA_BEDS (exported: nature3d puts its ledges' lips on them), each with a lit lip, a
//     purple-brown undercut and rain stains; joints, vertical washes; the sand one paler and softer,
//     with wind pits and grooves. Both seamless in both directions
// Top cover (tile; alpha = thickness mask, blended on up-facing surfaces by the nature shader):
//   cover_moss cover_lichen cover_snow cover_dust cover_sand · snow_pack (opaque snow for snow caps)
// Props: cactus_skin / cactus_dusty (tiles, 4 ribs), hay (tiles), hay_end (disc), stump_top (disc), bone_bleached (tiles),
//   scarecrow (atlas), iron (tiles), coals (disc), flame (alpha, 2×2 frames), smoke (alpha), spark
import {
  register, fill, mottle, blade, stroke, cracks, glaze, blurTile, range, pick, wrap, blob, ellipse,
  mix, shade, lightOf, shadowOf, jitter, hex, rgba, makeCanvas, worley, paintCells, streaks,
} from './core.js';

const TAU = Math.PI * 2;
const F = 'nature';

// ---- helpers ---------------------------------------------------------------------------------

// A periodic function on [0, 1): integer-frequency sines (tiles seamlessly).
function periodic(rnd, terms = 5, falloff = 1.2, k0 = 1) {
  const T = [];
  for (let k = k0; k < k0 + terms; k++) T.push([k, rnd() * TAU, (0.5 + rnd()) / Math.pow(k, falloff)]);
  const norm = T.reduce((a, t) => a + t[2], 0);
  return t => { let v = 0; for (const [k, p, a] of T) v += Math.sin(TAU * k * t + p) * a; return v / norm; };
}
const fract01 = (v, s) => (((v % s) + s) % s) / s;

// Draw fn three times, shifted by -s, 0, +s in x (and optionally y), for things that run off an edge.
function tiled(s, fn, both = false) {
  for (const dx of [-s, 0, s]) for (const dy of both ? [-s, 0, s] : [0]) fn(dx, dy);
}

// A seamless (wrap-around) gaussian-ish blur in plain JS on the canvas pixels: no canvas filters and
// no GPU round trips (those stall badly on software GL). Premultiplied, so soft edges don't go dark.
function jsBlur(cv, px) {
  if (!(px > 0)) return cv;
  const w = cv.width, h = cv.height, g = cv.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, w, h), d = img.data, n = w * h;
  let A = new Float32Array(n * 4), B = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const a = d[i * 4 + 3] / 255; A[i * 4] = d[i * 4] * a; A[i * 4 + 1] = d[i * 4 + 1] * a; A[i * 4 + 2] = d[i * 4 + 2] * a; A[i * 4 + 3] = d[i * 4 + 3]; }
  const pass = (src, dst, horiz, r, k) => {
    const L = horiz ? w : h, M = horiz ? h : w;
    for (let m = 0; m < M; m++) {
      const at = q => { q = ((q % L) + L) % L; return (horiz ? m * w + q : q * w + m) * 4; };
      if (k) {   // 3-tap kernel for sub-pixel blurs
        for (let q = 0; q < L; q++) { const i0 = at(q - 1), i1 = at(q), i2 = at(q + 1); for (let c = 0; c < 4; c++) dst[i1 + c] = src[i0 + c] * k + src[i1 + c] * (1 - 2 * k) + src[i2 + c] * k; }
      } else {   // running box sum
        const s = [0, 0, 0, 0], inv = 1 / (2 * r + 1);
        for (let q = -r; q <= r; q++) { const i = at(q); for (let c = 0; c < 4; c++) s[c] += src[i + c]; }
        for (let q = 0; q < L; q++) {
          const o = at(q); for (let c = 0; c < 4; c++) dst[o + c] = s[c] * inv;
          const ia = at(q + r + 1), ib = at(q - r); for (let c = 0; c < 4; c++) s[c] += src[ia + c] - src[ib + c];
        }
      }
    }
  };
  if (px < 1) { const k = Math.min(0.25, px * px / 2); pass(A, B, true, 0, k); pass(B, A, false, 0, k); }
  else {
    const r = Math.max(1, Math.round(px * 1.2 - 0.4));
    for (let it = 0; it < 2; it++) { pass(A, B, true, r, 0); pass(B, A, false, r, 0); }
  }
  for (let i = 0; i < n; i++) {
    const a = A[i * 4 + 3], k = a > 0.01 ? 255 / a : 0;
    d[i * 4] = A[i * 4] * k; d[i * 4 + 1] = A[i * 4 + 1] * k; d[i * 4 + 2] = A[i * 4 + 2] * k; d[i * 4 + 3] = a;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

// Paint on a scratch layer at full strength, then lay it down at `alpha` (no beading where marks
// overlap), optionally blurred (seamlessly) first.
function layer(g, w, h, fn, { alpha = 1, mode = 'source-over', blur = 0 } = {}) {
  const tmp = makeCanvas(w, h), tg = tmp.getContext('2d', { willReadFrequently: true });
  fn(tg, tmp);
  if (blur) jsBlur(tmp, blur);
  g.save(); g.globalAlpha = alpha; g.globalCompositeOperation = mode; g.drawImage(tmp, 0, 0); g.restore();
}

// One continuous path: round joins and caps, constant width.
function line(g, pts, w, color, alpha = 1) {
  if (pts.length < 2) return;
  g.save();
  g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke(); g.restore();
}
// Call fn(shiftedPts) for every wrapped copy of a polyline that crosses an edge.
function wrapPts(s, pts, pad, fn) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const xs = [0], ys = [0];
  if (x0 - pad < 0) xs.push(s); if (x1 + pad > s) xs.push(-s);
  if (y0 - pad < 0) ys.push(s); if (y1 + pad > s) ys.push(-s);
  for (const dx of xs) for (const dy of ys) fn(dx || dy ? pts.map(([x, y]) => [x + dx, y + dy]) : pts);
}
function poly(g, pts, color, alpha = 1) {
  g.save(); g.globalAlpha *= alpha; g.fillStyle = color;
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); g.fill();
  g.restore();
}

// Paint into cells of an atlas, clipped (cells are w × h, laid out left to right, top to bottom).
function atlas(cells, cw = null, ch = null) {
  return (g, s, rnd, h) => {
    const W = cw || s / 2, H = ch || (h || s) / 2;
    const per = Math.round(s / W);
    cells.forEach((fn, i) => {
      const ox = (i % per) * W, oy = Math.floor(i / per) * H;
      g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, W - 4, H - 4); g.clip();
      fn(g, ox, oy, W, H, rnd);
      g.restore();
    });
  };
}
// A layer local to one atlas cell (cheap: a cell-sized scratch canvas, blurred as it's laid down).
function cellLayer(g, ox, oy, w, h, fn, { alpha = 1, blur = 0 } = {}) {
  const p = Math.ceil(blur * 3) + 2, tmp = makeCanvas(w + 2 * p, h + 2 * p), tg = tmp.getContext('2d', { willReadFrequently: true });
  tg.translate(p - ox, p - oy);
  fn(tg);
  // a cheap soft edge without canvas filters (slow on software GL): the layer stamped round a ring
  const taps = blur ? [[0, 0], ...[0, 1, 2, 3, 4, 5, 6, 7].map(k => [Math.cos(k * Math.PI / 4) * blur, Math.sin(k * Math.PI / 4) * blur])] : [[0, 0]];
  g.save(); g.globalAlpha = alpha / (blur ? 4 : 1);
  for (const [dx, dy] of taps) g.drawImage(tmp, ox - p + dx, oy - p + dy);
  g.restore();
}
function clipCell(g, ox, oy, w, h, fn) { g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, w - 4, h - 4); g.clip(); fn(); g.restore(); }

// RGB from one canvas, alpha from the red channel of a mask canvas (lo..hi).
function withMask(g, s, colorCv, maskCv, lo = 0.15, hi = 1) {
  const C = colorCv.getContext('2d').getImageData(0, 0, s, s).data;
  const M = maskCv.getContext('2d').getImageData(0, 0, s, s).data;
  const img = g.createImageData(s, s), D = img.data;
  for (let k = 0; k < s * s; k++) {
    D[k * 4] = C[k * 4]; D[k * 4 + 1] = C[k * 4 + 1]; D[k * 4 + 2] = C[k * 4 + 2];
    D[k * 4 + 3] = Math.round(255 * (lo + (hi - lo) * M[k * 4] / 255));
  }
  g.putImageData(img, 0, 0);
}

// A wavy line (periodic in t) as a polyline across [-pad, s + pad].
function wavy(s, f, amp, at, vertical = true, pad = 24, step = 6) {
  const pts = [];
  for (let u = -pad; u <= s + pad; u += step) {
    const o = at + f(fract01(u, s)) * amp;
    pts.push(vertical ? [o, u] : [u, o]);
  }
  return pts;
}

// Lit/shadowed little bump (a pebble-ish lump) at x, y.
function lump(g, x, y, r, c, a = 1) {
  blob(g, x + r * 0.3, y + r * 0.35, r * 1.2, r * 0.9, 0, '#1e1626', 0.3 * a, 0.25);
  ellipse(g, x, y, r, r * 0.8, 0, c, a);
  blob(g, x - r * 0.3, y - r * 0.3, r * 0.6, r * 0.45, 0, lightOf(c, 0.5), 0.7 * a, 0.3);
  blob(g, x + r * 0.3, y + r * 0.3, r * 0.6, r * 0.45, 0, shadowOf(c, 0.35), 0.5 * a, 0.3);
}

// Soft blotches inside a rect (no wrapping).
function mottle0(g, ox, oy, w, h, rnd, colors, count, rmin, rmax, alpha = 0.3, hard = 0.2) {
  for (let i = 0; i < count; i++) {
    const r = range(rnd, rmin, rmax);
    blob(g, ox + rnd() * w, oy + rnd() * h, r * range(rnd, 0.8, 1.4), r, rnd() * Math.PI, pick(rnd, colors), alpha * range(rnd, 0.6, 1), hard);
  }
}

// ---- foliage painting --------------------------------------------------------------------------
//
// WoW canopies are big solid masses of leaf clusters: each clump is 3-6 round lobes, painted solid
// (no holes, so the alpha test never speckles), a scalloped edge of large leaves, lit cream-green
// on the upper left and a cool blue-violet underside, and a lime rim only where the light grazes.

// One painted leaf, stem at (x, y), pointing along ang (0 = up): a soft lit half toward the
// upper-left light, a shaded half, and a faint vein. `k` sets the contrast (low inside a mass).
function leaf(g, x, y, L, W, ang, base, alpha = 1, k = 1) {
  const litLeft = Math.cos(ang) + Math.sin(ang) > 0;
  const sx = litLeft ? -1 : 1;
  g.save();
  g.translate(x, y); g.rotate(ang);
  g.globalAlpha = alpha;
  g.beginPath(); g.moveTo(0, 0);
  g.bezierCurveTo(W * 0.95, -L * 0.18, W * 0.75, -L * 0.78, 0, -L);
  g.bezierCurveTo(-W * 0.75, -L * 0.78, -W * 0.95, -L * 0.18, 0, 0);
  g.fillStyle = base; g.fill();
  g.beginPath(); g.moveTo(0, 0);
  g.bezierCurveTo(sx * W * 0.95, -L * 0.18, sx * W * 0.75, -L * 0.78, 0, -L);
  g.quadraticCurveTo(sx * W * 0.12, -L * 0.5, 0, 0);
  g.globalAlpha = alpha * 0.5 * k; g.fillStyle = lightOf(base, 0.35); g.fill();
  g.beginPath(); g.moveTo(0, 0);
  g.bezierCurveTo(-sx * W * 0.95, -L * 0.18, -sx * W * 0.75, -L * 0.78, 0, -L);
  g.quadraticCurveTo(-sx * W * 0.5, -L * 0.45, 0, 0);
  g.globalAlpha = alpha * 0.4 * k; g.fillStyle = shadowOf(base, 0.3); g.fill();
  g.globalAlpha = alpha * 0.22 * k; g.strokeStyle = shadowOf(base, 0.4); g.lineWidth = Math.max(0.7, W * 0.12);
  g.beginPath(); g.moveTo(0, -L * 0.08); g.lineTo(0, -L * 0.8); g.stroke();
  g.restore();
}

// a cell-sized scratch canvas positioned at (ox, oy)
function scratch(ox, oy, w, h) {
  const cv = makeCanvas(w, h), g = cv.getContext('2d', { willReadFrequently: true });
  g.translate(-ox, -oy);
  return { cv, g };
}
// the alpha of `cv` filled with a flat colour
function silhouetteOf(cv, color) {
  const out = makeCanvas(cv.width, cv.height), g = out.getContext('2d');
  g.drawImage(cv, 0, 0); g.globalCompositeOperation = 'source-in'; g.fillStyle = color; g.fillRect(0, 0, cv.width, cv.height);
  return out;
}

// One lobe of a canopy mass, painted on its own layer: a solid body, a scalloped rim of big leaves
// pointing outward, then (inside the silhouette only) the form: a lit cream-green cap on the upper
// left, a cool blue-violet underside, leaf clusters that follow the form, and a lime rim light.
function lobe(g, ox, oy, w, h, x, y, r, rnd, P, { L: L0 = [24, 34], W: W0 = [13, 18], clusters = 9, rim = 1, sq = 0.92, droop = 0.5 } = {}) {
  const ks = Math.max(0.7, Math.min(1.1, r / 50)), L = [L0[0] * ks, L0[1] * ks], W = [W0[0] * ks, W0[1] * ks];
  const { cv, g: lg } = scratch(ox, oy, w, h);
  const tone = (px, py) => clampT(((x - px) * 0.6 + (y - py) * 0.8) / r * 0.5 + 0.5);   // 1 = upper left (lit)
  // the body
  ellipse(lg, x, y, r * 0.86, r * 0.86 * sq, 0, P.mid[0]);
  // the scalloped rim: big leaves round the outline pointing outward (drooping on the underside)
  const nE = Math.max(8, Math.round(TAU * r / (W[1] * 1.05)));
  for (let k = 0; k < nE; k++) {
    const a = k / nE * TAU + range(rnd, -0.12, 0.12), ca = Math.cos(a), sa = Math.sin(a);
    const bx = x + ca * r * 0.7, by = y + sa * r * 0.7 * sq;
    let ang = Math.atan2(ca, -sa);                                   // pointing outward
    if (droop && sa > 0) ang += droop * sa * (ca > 0 ? 0.6 : -0.6);
    const t = tone(bx - ca * r, by - sa * r);
    const cols = t > 0.72 ? P.lit : t > 0.42 ? P.mid : P.dark;
    leaf(lg, bx, by, range(rnd, L[0], L[1]) * (sa > 0.3 ? 1.08 : 1), range(rnd, W[0], W[1]), ang + range(rnd, -0.35, 0.35), jitter(pick(rnd, cols), rnd, 0.04), 1, 0.7);
  }
  lg.save();
  lg.globalCompositeOperation = 'source-atop';
  // form: a broad warm lit cap on the upper left, a cool violet underside on the lower right
  blob(lg, x - r * 0.3, y - r * 0.38, r * 0.95, r * 0.8, -0.5, P.lit[0], 0.34, 0.2);
  blob(lg, x + r * 0.4, y + r * 0.55, r * 1.0, r * 0.7, 0.3, P.dark[0], 0.7, 0.3);
  blob(lg, x + r * 0.35, y + r * 0.75, r * 0.85, r * 0.45, 0.2, P.deep, 0.65, 0.3);
  // leaf clusters: fans of 4-6 overlapping leaves; each takes its tone from where it sits on the
  // lobe, its own upper-left leaves a step lighter, a soft shadow under it
  const pts = [];
  for (let i = 0; i < clusters; i++) {
    const a = rnd() * TAU, d = Math.sqrt(rnd()) * r * 0.78;
    pts.push([x + Math.cos(a) * d, y + Math.sin(a) * d * sq]);
  }
  pts.sort((p, q) => (q[0] + q[1]) - (p[0] + p[1]));               // lower right first, lit ones on top
  for (const [px, py] of pts) {
    const t = tone(px, py), cr = range(rnd, 0.3, 0.42) * r;
    const cols = t > 0.86 ? P.tip : t > 0.62 ? P.lit : t > 0.34 ? P.mid : P.dark;
    blob(lg, px + cr * 0.25, py + cr * 0.4, cr * 1.05, cr * 0.75, 0, P.deep, 0.22, 0.35);
    const n = 4 + Math.floor(rnd() * 3), out = Math.atan2(px - x, -(py - y)) + range(rnd, -0.4, 0.4);
    for (let k = 0; k < n; k++) {
      const ang = out + (k / (n - 1) - 0.5) * 1.9 + range(rnd, -0.2, 0.2);
      const c = jitter(k < n / 2 && t > 0.55 ? pick(rnd, t > 0.75 ? P.tip : P.lit) : pick(rnd, cols), rnd, 0.04);
      leaf(lg, px - Math.sin(ang) * cr * 0.15, py + Math.cos(ang) * cr * 0.15, range(rnd, L[0], L[1]) * 0.9, range(rnd, W[0], W[1]) * 0.95, ang, c, 0.95, 0.6);
    }
  }
  // the lime rim light where the light grazes the upper-left edge
  if (rim) {
    blob(lg, x - r * 0.62, y - r * 0.6, r * 0.5, r * 0.32, -0.75, P.rim, 0.28 * rim, 0.3);
    blob(lg, x - r * 0.78, y - r * 0.2, r * 0.22, r * 0.4, -0.2, P.rim, 0.18 * rim, 0.3);
  }
  lg.restore();
  // lay it down: its shadow falls (only) on the lobes already painted, then the lobe itself
  g.save();
  g.globalCompositeOperation = 'source-atop'; g.globalAlpha = 0.45;
  g.drawImage(silhouetteOf(cv, P.deep), ox + r * 0.08, oy + r * 0.16);
  g.restore();
  g.drawImage(cv, ox, oy);
}
const clampT = v => Math.max(0, Math.min(1, v));

// A canopy mass: 3-6 lobes of varied size (one big one near the top), painted bottom first so the
// lit upper lobes overlap the shaded ones under them.
function canopy(g, ox, oy, w, h, cx, cy, R, rnd, P, { lobes = 5, squash = 0.8, spread = [0.38, 0.52], lobeR = [0.32, 0.5], top = 0.62, palettes = null, ...o } = {}) {
  const lob = [[cx + range(rnd, -0.08, 0.08) * R, cy - R * 0.12, R * top, P]];
  const a0 = rnd() * TAU;
  for (let i = 1; i < lobes; i++) {
    const a = a0 + (i - 1) / (lobes - 1) * TAU + range(rnd, -0.35, 0.35), d = R * range(rnd, spread[0], spread[1]);
    lob.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * squash + R * 0.08, R * range(rnd, lobeR[0], lobeR[1]), palettes ? pick(rnd, palettes) : P]);
  }
  lob.sort((p, q) => (q[1] - q[2] * 0.3) - (p[1] - p[2] * 0.3));
  for (const [x, y, r, LP] of lob) lobe(g, ox, oy, w, h, x, y, r, rnd, LP, { clusters: Math.round(5 + 9 * (r / R) ** 2 * 2), ...o });
  // a subtle unifying glaze: warm from the top, cool toward the bottom
  g.save();
  g.globalCompositeOperation = 'source-atop';
  const gr = g.createLinearGradient(cx, cy - R, cx + R * 0.3, cy + R);
  gr.addColorStop(0, 'rgba(255,236,170,0.10)'); gr.addColorStop(0.5, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(40,44,78,0.22)');
  g.fillStyle = gr; g.fillRect(ox, oy, w, h);
  g.restore();
}

// A hanging skirt: the leaves that droop off a canopy's underside. A solid band at the top (it tucks
// up into the clump), then strands of downward-pointing leaves of uneven length with ragged ends:
// cool and dark up under the canopy, catching a little bounce light toward the tips.
function skirt(g, ox, oy, w, h, rnd, P) {
  // a shade palette: the fringe hangs in the crown's shadow, a step darker than the lobes above
  const S = { deep: P.deep, dark: P.dark, mid: [...P.dark, ...P.mid], lit: P.mid, tip: P.lit, rim: P.lit[0] };
  const hangs = [];
  // the top: a lumpy row of lobes (it tucks up into the clump), then smaller ones hanging below at
  // uneven depths; painted top first, so each hanging lobe overlaps the row above it
  for (let x = ox + 46; x < ox + w - 40; x += range(rnd, 30, 42)) hangs.push([x + range(rnd, -6, 6), oy + h * range(rnd, 0.26, 0.34), range(rnd, 30, 38)]);
  const nH = 5 + Math.floor(rnd() * 3);
  for (let i = 0; i < nH; i++) hangs.push([ox + 50 + (i + range(rnd, -0.35, 0.35)) / (nH - 1) * (w - 100), oy + h * range(rnd, 0.42, 0.66), range(rnd, 20, 30)]);
  for (const [x, y, r] of hangs) lobe(g, ox, oy, w, h, x, y, r, rnd, S, { clusters: 4, rim: 0.3, sq: 1.1, droop: 1.2, L: [20, 28], W: [11, 15] });
}

// Elwynn oak: a deep mid green (#3f6a2a), cool blue-violet shadow (#263f2a), yellow-green lit tips
// (#8fae3e); lime only as the rim light.
const OAK = {
  deep: '#28383c',
  dark: ['#2e4a2a', '#31502c', '#2c4628'],
  mid: ['#3f6a2a', '#44702e', '#3b6328', '#48742f'],
  lit: ['#5c8832', '#669236', '#5a8430'],
  tip: ['#8fae3e', '#98b444', '#88a83c'],
  rim: '#bcd468',
};
const BUSH = {
  deep: '#26383a',
  dark: ['#31502a', '#35562c'],
  mid: ['#467a2e', '#4e8032', '#43742c'],
  lit: ['#689838', '#72a23c'],
  tip: ['#98ba46', '#a2c24e'],
  rim: '#c4d870',
};
// Westfall: olive and sun-baked gold, with rust autumn clumps
const GOLD = {
  deep: '#4a3a2a',
  dark: ['#6c5a2a', '#74602e'],
  mid: ['#9a8a3a', '#a2903e', '#948436'],
  lit: ['#c8a848', '#d0b050'],
  tip: ['#e0c464', '#e8ce70'],
  rim: '#f4de8c',
};
const RUST = {
  deep: '#3c2c2a',
  dark: ['#5c3420', '#663a22'],
  mid: ['#98522a', '#a45c2e'],
  lit: ['#c47836', '#ce863e'],
  tip: ['#e09c4e', '#e8aa5a'],
  rim: '#f4c878',
};
const OLIVE = {
  deep: '#3e3a2a',
  dark: ['#585626', '#5e5c2a'],
  mid: ['#808238', '#888a3c', '#7a7c36'],
  lit: ['#aca848', '#b4ae4e'],
  tip: ['#ccc25e', '#d4ca66'],
  rim: '#e4dc80',
};
const SAGE = {
  deep: '#3a3e40',
  dark: ['#4a5444', '#465040'],
  mid: ['#64725a', '#6c7a60', '#606e56'],
  lit: ['#8a9a78', '#94a280'],
  tip: ['#b0bc98', '#b8c4a0'],
  rim: '#d4dcbc',
};

// the atlas cells every broadleaf foliage texture shares: 0 canopy clump · 1 hanging skirt ·
// 2 dense core mass · 3 bush clump
const foliage = (P, B, pal = null, bpal = null) => atlas([
  (g, ox, oy, w, h, rnd) => canopy(g, ox, oy, w, h, ox + w / 2, oy + h / 2 + 6, 88, rnd, P, { lobes: 5, palettes: pal }),
  (g, ox, oy, w, h, rnd) => skirt(g, ox, oy, w, h, rnd, P),
  (g, ox, oy, w, h, rnd) => canopy(g, ox, oy, w, h, ox + w / 2, oy + h / 2 + 2, 100, rnd, P, { lobes: 7, spread: [0.36, 0.5], lobeR: [0.36, 0.48], top: 0.66, palettes: pal, rim: 0.6 }),
  (g, ox, oy, w, h, rnd) => canopy(g, ox, oy, w, h, ox + w / 2, oy + h / 2 + 10, 92, rnd, B, { lobes: 6, squash: 0.7, spread: [0.4, 0.56], lobeR: [0.3, 0.44], top: 0.5, L: [18, 26], W: [10, 14], palettes: bpal }),
]);

register('leaves_oak', {
  family: F, size: 512, alpha: true, note: 'Elwynn foliage atlas: canopy clump, hanging skirt, dense core mass, bush clump (solid lobes, scalloped leaf edges)',
  paint: foliage(OAK, BUSH),
});

register('leaves_autumn', {
  family: F, size: 512, alpha: true, note: 'Westfall foliage: olive-gold clump (some rust), skirt, dense core, olive-gold bush',
  paint: foliage(GOLD, OLIVE, [GOLD, GOLD, GOLD, OLIVE, RUST], [OLIVE, GOLD, GOLD]),
});

// sage / scrub: small narrow gray-green leaves in solid clumps on a few visible brown twigs
function twigFan(g, cx, by, rnd, { n = 9, len = [70, 120], col = '#5e4636', lit = '#9a7e64', spread = 1.1, w = 4 } = {}) {
  const tips = [];
  for (let i = 0; i < n; i++) {
    const a = range(rnd, -spread, spread), L = range(rnd, len[0], len[1]);
    const x1 = cx + Math.sin(a) * L, y1 = by - Math.cos(a) * L;
    const mx = (cx + x1) / 2 + range(rnd, -8, 8), my = (by + y1) / 2;
    stroke(g, [[cx + range(rnd, -6, 6), by], [mx, my], [x1, y1]], w, w * 0.4, col, 1);
    stroke(g, [[cx - 1, by], [mx - 1, my], [x1 - 1, y1]], w * 0.4, 0.5, lit, 0.6);
    tips.push([x1, y1, a]);
  }
  return tips;
}

register('leaves_scrub', {
  family: F, size: 512, alpha: true, note: 'dry-land shrubs: sage brush, dry tangle, dense sage mass, juniper spray (solid clumps)',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => {
      // sage brush: a woody base, then 4-6 solid gray-green clumps making one rounded bush
      twigFan(g, ox + w / 2, oy + h - 10, rnd, { n: 6, len: [60, 100], spread: 0.9, w: 6 });
      canopy(g, ox, oy, w, h, ox + w / 2, oy + h / 2 - 4, 88, rnd, SAGE, { lobes: 6, squash: 0.72, spread: [0.42, 0.58], lobeR: [0.28, 0.4], top: 0.46, L: [14, 20], W: [7, 10], rim: 0.7 });
    },
    (g, ox, oy, w, h, rnd) => {
      // a dry tangle: a solid dark-brown core of packed twigs, thick crooked twigs round the edge
      const cx = ox + w / 2, cy = oy + h / 2 + 10;
      ellipse(g, cx, cy, 64, 54, 0, '#4e3a2e');
      blob(g, cx - 18, cy - 20, 44, 34, 0, '#7a6048', 0.7, 0.3);
      blob(g, cx + 22, cy + 22, 46, 30, 0, '#34262a', 0.6, 0.3);
      for (let i = 0; i < 46; i++) {
        const a = rnd() * TAU, r0 = range(rnd, 20, 58);
        let x = cx + Math.cos(a) * r0, y = cy + Math.sin(a) * r0 * 0.85;
        const pts = [[x, y]];
        let b = a + range(rnd, -0.8, 0.8);
        for (let k = 0; k < 3; k++) { b += range(rnd, -0.7, 0.7); x += Math.cos(b) * range(rnd, 10, 18); y += Math.sin(b) * range(rnd, 10, 18) * 0.85; pts.push([x, y]); }
        const lit = Math.cos(a) * -0.6 + Math.sin(a) * -0.8 > 0.2;
        stroke(g, pts, 5, 3, lit ? pick(rnd, ['#8a6e54', '#9a7e62']) : pick(rnd, ['#5a4232', '#6a503e']), 1);
        if (lit) stroke(g, pts.map(([u, v]) => [u - 1, v - 1]), 1.6, 1, '#c4a888', 0.6);
      }
      for (let i = 0; i < 26; i++) { const a = rnd() * TAU, d = range(rnd, 10, 60); leaf(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.85, range(rnd, 12, 16), range(rnd, 6, 8), a + Math.PI / 2, pick(rnd, ['#9a8a5a', '#a8946a', '#8a7a4e']), 1, 0.6); }
    },
    (g, ox, oy, w, h, rnd) => canopy(g, ox, oy, w, h, ox + w / 2, oy + h / 2 + 2, 100, rnd, SAGE, { lobes: 7, top: 0.6, lobeR: [0.36, 0.48], L: [14, 20], W: [7, 10], rim: 0.5 }),
    (g, ox, oy, w, h, rnd) => {
      // juniper: dark blue-green scale-leaf sprays fanning out of a low woody base
      const cx = ox + w / 2, by = oy + h - 10;
      for (let i = 0; i < 30; i++) {
        const a = range(rnd, -1.3, 1.3), L = range(rnd, 70, 125), x0 = cx + range(rnd, -24, 24), y0 = by - range(rnd, 0, 40);
        const x1 = x0 + Math.sin(a) * L, y1 = y0 - Math.cos(a) * L * 0.85;
        stroke(g, [[x0, y0], [(x0 + x1) / 2, (y0 + y1) / 2 - 6], [x1, y1]], 5, 1.5, '#3a2e2a', 1);
        for (let k = 0; k < 16; k++) {
          const t = 0.2 + k / 16 * 0.8, px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * 6;
          const lit = Math.sin(a) < 0.2 && k % 3 === 0;
          const c = lit ? pick(rnd, ['#5e8070', '#6a8c78']) : pick(rnd, ['#2e4a40', '#36564a', '#3e5e4e', '#284036']);
          for (const sd of [-1, 1]) stroke(g, [[px, py], [px + sd * range(rnd, 8, 15) + Math.sin(a) * 6, py - range(rnd, 4, 11)]], 4.2, 1.2, c, 1);
        }
      }
    },
  ]),
});

// ---- pine boughs -------------------------------------------------------------------------------

// Elwynn: a fresh mid green with warm lit tips (never near-black or teal)
const NEEDLE = {
  core: '#2c4a2e',
  dark: ['#345a34', '#3a6236', '#325432'],
  mid: ['#4a7a3a', '#528240', '#467238', '#56863e'],
  lit: ['#7aa04a', '#84a850', '#72984a'],
  hi: ['#a8c060', '#b4c86a'],
};
// Dun Morogh: a darker blue-green under the snow
const NEEDLE_SNOW = {
  core: '#1c302c',
  dark: ['#24403a', '#2c4a3c', '#223c36'],
  mid: ['#3f6650', '#467058', '#3a5e4c'],
  lit: ['#5e8a6a', '#6a9472', '#58826a'],
  hi: ['#88aa84', '#94b48c'],
};

// Needle spray along a polyline: short strokes angled forward on both sides; the ones pointing
// up (toward the light) are lit, the ones hanging down are dark.
function needles(g, pts, rnd, { len = [12, 19], w = 2.6, dens = 2.4, P = NEEDLE, forward = 0.6 } = {}) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
    const dirA = Math.atan2(dx, -dy);
    const steps = Math.max(1, Math.round(l / dens));
    const tipK = 1 - i / (pts.length - 1) * 0.4;
    for (let k = 0; k < steps; k++) {
      const t = k / steps, x = ax + dx * t, y = ay + dy * t;
      for (const sd of [-1, 1]) {
        const a = dirA + sd * range(rnd, forward * 0.7, forward * 1.4);
        const L = range(rnd, len[0], len[1]) * tipK;
        const upness = -Math.cos(a) - Math.sin(a) * 0.5;
        const cols = upness > 0.35 ? (rnd() < 0.3 ? P.hi : P.lit) : upness > -0.2 ? P.mid : P.dark;
        blade(g, x, y, L, a, w, pick(rnd, cols), 1, range(rnd, -0.2, 0.2));
      }
    }
  }
}

// A drooping bough, base at the bottom of the cell, tip at the top. Returns its skeleton so a snow
// cap can be painted along it.
function bough(g, ox, oy, w, h, rnd, { spread = 0.47, n = 14, P = NEEDLE } = {}) {
  const cx = ox + w / 2, by = oy + h - 6, ty = oy + 14;
  const bend = periodic(rnd, 2, 1, 1);
  const main = [];
  for (let k = 0; k <= 10; k++) { const t = k / 10; main.push([cx + bend(t * 0.5) * 8, by + (ty - by) * t]); }
  const sides = [];
  for (let i = 0; i < n; i++) {
    const t = 0.08 + i / n * 0.86 + range(rnd, -0.015, 0.015);
    const k = Math.min(9, Math.floor(t * 10)), f = t * 10 - k;
    const bx = main[k][0] + (main[k + 1][0] - main[k][0]) * f, byy = main[k][1] + (main[k + 1][1] - main[k][1]) * f;
    const sd = i % 2 ? 1 : -1;
    const prof = Math.pow(Math.sin(Math.PI * Math.min(1, 0.22 + t * 0.85)), 0.6);
    const L = w * spread * prof * range(rnd, 0.85, 1.05);
    const a = sd * range(rnd, 0.95, 1.2);
    const pts = [];
    for (let j = 0; j <= 5; j++) { const u = j / 5; const aa = a - sd * u * 0.35; pts.push([bx + Math.sin(aa) * L * u, byy - Math.cos(aa) * L * u + u * u * 10]); }
    sides.push([pts, L, t]);
  }
  for (const [pts, L] of sides) stroke(g, pts, Math.max(10, L * 0.42), 6, P.core, 1);
  stroke(g, main, 30, 12, P.core, 1);
  for (const [pts, L] of sides) stroke(g, pts.map(([x, y]) => [x, y + 3]), Math.max(8, L * 0.3), 4, P.dark[0], 0.8);
  for (const [pts] of sides) stroke(g, pts, 2.6, 1, '#4a3428', 1);
  stroke(g, main, 4.5, 1.5, '#5a3e2c', 1);
  for (const [pts] of sides) needles(g, pts, rnd, { P });
  needles(g, main, rnd, { len: [13, 20], P });
  for (const [pts] of sides) {
    const [x, y] = pts[pts.length - 1];
    for (let k = 0; k < 5; k++) blade(g, x, y, range(rnd, 6, 11), range(rnd, -1.2, 1.2), 2.2, pick(rnd, P.hi), 0.85, 0);
  }
  return { main, sides };
}
function denseNeedles(g, ox, oy, w, h, rnd, P) {
  g.fillStyle = P.dark[0]; g.fillRect(ox, oy, w, h);
  mottle0(g, ox, oy, w, h, rnd, [P.core, P.mid[0], P.dark[1]], 14, 20, 60, 0.5);
  for (let r = 0; r < 40; r++) {
    const x = ox + rnd() * w, y = oy + rnd() * h, a = range(rnd, -0.5, 0.5), L = range(rnd, 40, 90);
    needles(g, [[x, y + L / 2], [x + Math.sin(a) * L, y - L / 2]], rnd, { len: [10, 16], dens: 3, P });
  }
}

register('needles_pine', {
  family: F, size: 512, alpha: true, note: 'pine atlas: two drooping boughs, dense needles, tip spray (Elwynn green)',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.47, n: 15 }),
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.42, n: 13 }),
    (g, ox, oy, w, h, rnd) => denseNeedles(g, ox, oy, w, h, rnd, NEEDLE),
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.36, n: 14 }),
  ]),
});

// Snow lying on a bough: 3-5 soft irregular clumps sitting along the main stem and the inner side
// branches (about half the bough), needles left showing below them and at every tip. Each clump: a
// soft lavender shadow under its lower-right edge, a body that is never flat white, a cream rim on its
// upper left, and 2-3 soft blue shadow strokes under it. Painted on layers so each stays one shape.
const SNOW = { lit: '#fffaf0', body: '#e8eef4', mid: '#cfdbe8', shadow: '#b8c8e0', deep: '#8aa0bc' };
function snowClumps(sk, rnd) {
  const { main, sides } = sk, out = [];
  const nC = 3 + Math.floor(rnd() * 3);
  const pt = t => { const f = t * 10, k = Math.min(9, Math.floor(f)), u = f - k; return [main[k][0] + (main[k + 1][0] - main[k][0]) * u, main[k][1] + (main[k + 1][1] - main[k][1]) * u]; };
  for (let c = 0; c < nC; c++) {
    const tc = 0.1 + (c + range(rnd, 0.15, 0.85)) / nC * 0.68, parts = [];
    const [mx, my] = pt(tc), big = 1.25 - tc * 0.6;
    parts.push([mx + range(rnd, -4, 4), my, range(rnd, 18, 26) * big, range(rnd, 11, 16) * big, range(rnd, -0.3, 0.3)]);
    // spill onto the side branches near this height, along their inner half
    for (const [pts, L, t] of sides) {
      if (Math.abs(t - tc) > 0.09 || rnd() < 0.25) continue;
      const m = Math.min(pts.length - 1, 1 + Math.floor(rnd() * 2));
      for (let j = 1; j <= m; j++) { const [x, y] = pts[j]; parts.push([x + range(rnd, -3, 3), y + range(rnd, -3, 2), range(rnd, 11, 18) * big * (1.1 - j * 0.2), range(rnd, 7, 11) * big, Math.atan2(pts[j][1] - pts[j - 1][1], pts[j][0] - pts[j - 1][0])]); }
    }
    // a lump or two on top so the outline is never a smooth oval
    for (let k = 0; k < 2; k++) parts.push([mx + range(rnd, -14, 14) * big, my - range(rnd, 4, 10), range(rnd, 8, 13) * big, range(rnd, 6, 9) * big, range(rnd, -0.6, 0.6)]);
    out.push(parts);
  }
  return out;
}
function snowCap(g, sk, ox, oy, w, h, rnd) {
  const clumps = snowClumps(sk, rnd);
  const shape = (tg, color, dx = 0, dy = 0, k = 1) => { for (const parts of clumps) for (const [x, y, rx, ry, rot] of parts) ellipse(tg, x + dx, y + dy, rx * k, ry * k, rot, color, 1); };
  clipCell(g, ox, oy, w, h, () => {
    cellLayer(g, ox, oy, w, h, tg => shape(tg, SNOW.deep, 3, 5, 1.08), { alpha: 0.55, blur: 2.5 });
    cellLayer(g, ox, oy, w, h, tg => {
      shape(tg, SNOW.body);
      tg.save(); tg.globalCompositeOperation = 'source-atop';
      for (const parts of clumps) for (const [x, y, rx, ry] of parts) {
        blob(tg, x + rx * 0.35, y + ry * 0.5, rx * 0.9, ry * 0.7, 0, SNOW.mid, 0.75, 0.3);              // the cool lower right
        blob(tg, x - rx * 0.3, y - ry * 0.4, rx * 0.65, ry * 0.45, 0, SNOW.lit, 0.95, 0.4);             // the cream lit top left
      }
      // 2-3 soft blue shadow strokes under each clump
      for (const parts of clumps) {
        const [x, y, rx, ry] = parts[0];
        for (let k = 0; k < 2 + Math.floor(rnd() * 2); k++) {
          const yy = y + ry * range(rnd, 0.2, 0.6), x0 = x - rx * range(rnd, 0.2, 0.6), x1 = x + rx * range(rnd, 0.3, 0.8);
          line(tg, [[x0, yy], [(x0 + x1) / 2, yy + range(rnd, 1, 3)], [x1, yy - range(rnd, 0, 2)]], range(rnd, 1.6, 2.6), pick(rnd, [SNOW.shadow, SNOW.deep]), 0.5);
        }
      }
      tg.restore();
    }, { alpha: 1, blur: 0.9 });
    // needle tips poking out of the lower edge of each clump
    for (const parts of clumps) for (const [x, y, rx, ry] of parts) {
      for (let k = 0; k < 2; k++) blade(g, x + range(rnd, -rx, rx) * 0.7, y + ry * range(rnd, 0.5, 0.9), range(rnd, 5, 9), Math.PI + range(rnd, -0.7, 0.7), 2, pick(rnd, NEEDLE_SNOW.mid), 0.9, 0);
    }
  });
}

// A snowy shrub clump: a low lumpy mound of dark needle sprays under a soft snow blanket, with a ragged
// needle edge all round (no straight card edges anywhere).
function snowMound(g, ox, oy, w, h, rnd) {
  const cx = ox + w / 2, cy = oy + h * 0.56, R = w * 0.4;
  const lobes = [[cx, cy, R * 0.62]];
  for (let i = 0; i < 7; i++) { const a = range(rnd, -Math.PI, 0.3), d = R * range(rnd, 0.3, 0.55); lobes.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.75, R * range(rnd, 0.3, 0.45)]); }
  for (const [x, y, r] of lobes) blob(g, x, y, r, r * 0.85, 0, NEEDLE_SNOW.core, 0.95, 0.7);
  // needle sprays fanning out of the mound edge
  for (let i = 0; i < 70; i++) {
    const [x, y, r] = pick(rnd, lobes), a = rnd() * TAU, t = range(rnd, 0.5, 1.05);
    const px = x + Math.cos(a) * r * t, py = y + Math.sin(a) * r * t * 0.85;
    const L = range(rnd, 18, 34), ang = Math.atan2(Math.cos(a), -Math.sin(a)) + range(rnd, -0.5, 0.5);
    needles(g, [[px, py], [px + Math.sin(ang) * L, py - Math.cos(ang) * L]], rnd, { len: [8, 13], dens: 3, P: NEEDLE_SNOW });
  }
  // the snow blanket over the upper part of every lobe
  const rots = lobes.map(() => range(rnd, -0.2, 0.2));
  const cap = tg => { lobes.forEach(([x, y, r], i) => ellipse(tg, x - r * 0.05, y - r * 0.25, r * 0.85, r * 0.55, rots[i], '#ffffff', 1)); };
  clipCell(g, ox, oy, w, h, () => {
    cellLayer(g, ox, oy, w, h, tg => { tg.translate(3, 6); cap(tg); }, { alpha: 0.5, blur: 3 });
    cellLayer(g, ox, oy, w, h, tg => {
      tg.save(); tg.globalAlpha = 1; cap(tg);
      tg.globalCompositeOperation = 'source-in'; tg.fillStyle = SNOW.body; tg.fillRect(ox, oy, w, h);
      tg.globalCompositeOperation = 'source-atop';
      for (const [x, y, r] of lobes) { blob(tg, x + r * 0.3, y, r * 0.8, r * 0.4, 0, SNOW.mid, 0.8, 0.3); blob(tg, x - r * 0.3, y - r * 0.45, r * 0.55, r * 0.3, 0, SNOW.lit, 0.95, 0.4); }
      for (const [x, y, r] of lobes) line(tg, [[x - r * 0.5, y + r * 0.1], [x, y + r * 0.2], [x + r * 0.5, y + r * 0.08]], 2.2, SNOW.shadow, 0.5);
      tg.restore();
    }, { alpha: 1, blur: 0.9 });
  });
}

register('needles_snow', {
  family: F, w: 1024, h: 512, size: 1024, alpha: true,
  note: 'Dun Morogh pine atlas, 4×2: snowy boughs (0, 1), snowy shrub mound (4), snowy tip (5); bare copies at +2 columns (2, 3, 7) and dense needles (6)',
  paint(g, s, rnd, h, cv) {
    const C = 256;
    const at = i => [(i % 4) * C, Math.floor(i / 4) * C];
    const sk = {};
    // the bare cells first (right half)
    const bare = [[2, { spread: 0.47, n: 15 }], [3, { spread: 0.42, n: 13 }], [7, { spread: 0.36, n: 14 }]];
    for (const [i, o] of bare) { const [ox, oy] = at(i); clipCell(g, ox, oy, C, C, () => { sk[i] = bough(g, ox, oy, C, C, rnd, { ...o, P: NEEDLE_SNOW }); }); }
    { const [ox, oy] = at(6); clipCell(g, ox, oy, C, C, () => denseNeedles(g, ox, oy, C, C, rnd, NEEDLE_SNOW)); }
    // the snowy copies (left half): the same bough, then the snow
    for (const [src, dst] of [[2, 0], [3, 1], [7, 5]]) {
      const [sx, sy] = at(src), [dx, dy] = at(dst);
      g.drawImage(cv, sx, sy, C, C, dx, dy, C, C);
      const shift = ([x, y]) => [x - sx + dx, y - sy + dy];
      const S = { main: sk[src].main.map(shift), sides: sk[src].sides.map(([pts, L, t]) => [pts.map(shift), L, t]) };
      snowCap(g, S, dx, dy, C, C, rnd);
    }
    { const [ox, oy] = at(4); clipCell(g, ox, oy, C, C, () => snowMound(g, ox, oy, C, C, rnd)); }
  },
});

// ---- palm fronds ---------------------------------------------------------------------------------

function frond(g, ox, oy, w, h, rnd, P) {
  const cx = ox + w / 2, by = oy + h - 8, ty = oy + 10;
  const rach = [];
  for (let k = 0; k <= 12; k++) { const t = k / 12; rach.push([cx + Math.sin(t * 2.2) * 10, by + (ty - by) * t]); }
  const at = t => { const k = Math.min(11, Math.floor(t * 12)), f = t * 12 - k; return [rach[k][0] + (rach[k + 1][0] - rach[k][0]) * f, rach[k][1] + (rach[k + 1][1] - rach[k][1]) * f]; };
  for (let pass = 0; pass < 2; pass++) {
    for (let t = 0.04; t < 0.98; t += 0.016) {
      const [x, y] = at(t);
      const prof = Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.95)), 0.6);
      for (const sd of [-1, 1]) {
        if (pass === 0 && sd < 0) continue;
        if (pass === 1 && sd > 0) continue;
        const L = w * 0.47 * prof * range(rnd, 0.85, 1.05);
        const a = sd * range(rnd, 0.5, 0.7);
        const lit = sd < 0;
        const c = jitter(pick(rnd, lit ? P.lit : P.mid), rnd, 0.06);
        blade(g, x + 1.5, y + 2, L, a, 7, P.dark, 0.7, sd * 0.5);
        blade(g, x, y, L, a, 6.5, c, 1, sd * 0.5);
        blade(g, x - sd * 0.8, y - 0.8, L * 0.8, a, 2, lightOf(c, 0.4), 0.5, sd * 0.5);
        if (rnd() < P.dryTip) blade(g, x + Math.sin(a) * L * 0.75, y - Math.cos(a) * L * 0.75, L * 0.25, a + sd * 0.35, 3, pick(rnd, P.tip), 0.8, sd * 0.3);
      }
    }
  }
  stroke(g, rach.map(([x, y]) => [x + 1.5, y + 1]), 9, 2.5, P.dark, 0.6);
  stroke(g, rach, 7, 2, P.rib, 1);
  stroke(g, rach.map(([x, y]) => [x - 1.4, y]), 2, 0.8, lightOf(P.rib, 0.5), 0.7);
}

register('palm_frond', {
  family: F, w: 512, h: 512, size: 512, alpha: true, note: 'two fronds (green, dry), each 256×512, rachis bottom → tip',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => frond(g, ox, oy, w, h, rnd, { lit: ['#9cbc4a', '#a8c456', '#8cb042'], mid: ['#5e9032', '#6a9a36', '#548a30'], dark: '#2e4e20', rib: '#c4b070', tip: ['#c8a850', '#b89448'], dryTip: 0.18 }),
    (g, ox, oy, w, h, rnd) => frond(g, ox, oy, w, h, rnd, { lit: ['#c8aa62', '#d4b670', '#bca058'], mid: ['#9a7e46', '#a8884e', '#8a7040'], dark: '#4e3a26', rib: '#d4be8a', tip: ['#7a5e3a', '#6a5034'], dryTip: 0.5 }),
  ], 256, 512),
});

// ---- straw -----------------------------------------------------------------------------------------

const STRAW = ['#e8c878', '#f4dc98', '#d4ac58', '#c09848', '#a88038', '#f8e8b0'];
function strawTuft(g, cx, by, rnd, { n = 60, len = [60, 120], spread = 0.9, w = [2.4, 4.2] } = {}) {
  for (let i = 0; i < n; i++) {
    const a = range(rnd, -spread, spread), L = range(rnd, len[0], len[1]), x = cx + range(rnd, -14, 14);
    const c = i < n * 0.35 ? pick(rnd, ['#8a6a30', '#a88038', '#7a5a28']) : pick(rnd, STRAW);
    blade(g, x, by, L, a, range(rnd, w[0], w[1]), c, 1, range(rnd, -0.4, 0.4));
    if (i >= n * 0.35 && rnd() < 0.5) blade(g, x - 1, by - 1, L * 0.8, a, 1, '#fff4d0', 0.5, 0);
  }
}
register('straw_tuft', {
  family: F, size: 256, alpha: true, note: 'straw: two tufts fanning up, a ragged fringe, loose wisps',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => strawTuft(g, ox + w / 2, oy + h - 4, rnd, { n: 70, len: [50, 110] }),
    (g, ox, oy, w, h, rnd) => strawTuft(g, ox + w / 2, oy + h - 4, rnd, { n: 60, len: [40, 90], spread: 1.25 }),
    (g, ox, oy, w, h, rnd) => { for (let x = ox + 6; x < ox + w - 6; x += 5) strawTuft(g, x, oy + h - 4, rnd, { n: 3, len: [40, 100], spread: 0.35, w: [2.2, 3.6] }); },
    (g, ox, oy, w, h, rnd) => { for (let i = 0; i < 40; i++) { const x = ox + range(rnd, 16, w - 16), y = oy + range(rnd, 30, h - 10); blade(g, x, y, range(rnd, 30, 60), range(rnd, -1.8, 1.8), range(rnd, 2, 3.2), pick(rnd, STRAW), 1, range(rnd, -0.6, 0.6)); } },
  ]),
});

// ---- bark ------------------------------------------------------------------------------------------

register('bark_oak', {
  family: F, size: 256, note: 'Elwynn oak: warm gray-brown plates of varied width, lit left edges, deep soft furrows that split and merge',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7e6a58');
    mottle(g, s, rnd, { colors: ['#97806a', '#6a5848', '#8a7660', '#76624f', '#a28c70', '#6e6452', '#7e7058'], count: 28, rmin: 30, rmax: 84, alpha: 0.45, hard: 0.06, stretch: 2.4, rot: Math.PI / 2 });
    jsBlur(cv, 4);
    // 5 plates of varied width between wandering furrows
    const nP = 5, ws = []; for (let i = 0; i < nP; i++) ws.push(range(rnd, 0.6, 1.6));
    const sum = ws.reduce((a, b) => a + b, 0);
    let acc = rnd() * s * 0.2;
    const fur = ws.map(wd => { const x0 = acc; acc += wd / sum * s; return { x0, f: periodic(rnd, 3, 1.1, 1), f2: periodic(rnd, 2, 1, 3), sway: rnd() * TAU, wd: wd / sum * s }; });
    const X = (fu, y) => fu.x0 + fu.f(fract01(y, s)) * 9 + fu.f2(fract01(y, s)) * 3 + Math.sin(TAU * y / s + fu.sway) * 7;
    const path = (fu, dx = 0, off = 0) => { const p = []; for (let y = -24; y <= s + 24; y += 4) p.push([X(fu, y) + dx + off, y]); return p; };
    // Y-splits: a branch leaves one furrow and runs diagonally into the next
    const splits = [];
    for (let i = 0; i < 5; i++) {
      const k = Math.floor(rnd() * nP), a = fur[k], b = fur[(k + 1) % nP], y0 = rnd() * s, len = range(rnd, 40, 80);
      const pts = []; for (let j = 0; j <= 8; j++) { const t = j / 8, y = y0 + t * len; let xb = X(b, y); const xa = X(a, y); if (xb < xa) xb += s; pts.push([xa + (xb - xa) * (t * t * (3 - 2 * t)) + Math.sin(t * 6 + i) * 2, y]); }
      splits.push(pts);
    }
    // plate shading: a cool shadow on each plate's right edge, a warm lit band on its left edge
    layer(g, s, s, tg => tiled(s, dx => { for (const fu of fur) line(tg, path(fu, dx, -8), 14, '#463a46'); }, false), { alpha: 0.38, blur: 4 });
    layer(g, s, s, tg => tiled(s, dx => { for (const fu of fur) line(tg, path(fu, dx, 9), 10, '#d8c29c'); for (const p of splits) line(tg, p.map(([x, y]) => [x + dx + 6, y - 4]), 6, '#d8c29c'); }, false), { alpha: 0.42, blur: 3 });
    // plate middles: soft mid-tone variation, stretched along the trunk
    mottle(g, s, rnd, { colors: ['#7c6a56', '#8c7862', '#70604e'], count: 30, rmin: 8, rmax: 22, alpha: 0.25, hard: 0.1, stretch: 3, rot: Math.PI / 2 });
    // the furrows: a soft wide dark pass, then a narrow deep core (one continuous path each)
    layer(g, s, s, tg => tiled(s, dx => {
      for (const fu of fur) line(tg, path(fu, dx), 11, '#3a2c32');
      for (const p of splits) line(tg, p.map(([x, y]) => [x + dx, y]), 8, '#3a2c32');
    }, false), { alpha: 0.6, blur: 2.6 });
    layer(g, s, s, tg => tiled(s, dx => {
      for (const fu of fur) line(tg, path(fu, dx, 0.8), 3.4, '#261c24');
      for (const p of splits) line(tg, p.map(([x, y]) => [x + dx, y]), 2.4, '#261c24');
    }, false), { alpha: 0.6, blur: 1 });
    // short shallow cracks and rough patches inside the plates
    layer(g, s, s, tg => {
      for (let i = 0; i < 40; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 10, 30), a = range(rnd, -0.25, 0.25);
        const pts = [[x, y], [x + Math.sin(a) * L * 0.5 + range(rnd, -2, 2), y + L * 0.5], [x + Math.sin(a) * L, y + L]];
        wrapPts(s, pts, 4, Q => { line(tg, Q.map(([u, v]) => [u + 1.8, v]), 2, '#ccb490'); line(tg, Q, 1.6, '#463a3e'); });
      }
    }, { alpha: 0.45, blur: 0.6 });
    mottle(g, s, rnd, { colors: ['#64544a', '#a89276', '#544640'], count: 60, rmin: 3, rmax: 9, alpha: 0.18, hard: 0.3, stretch: 2, rot: Math.PI / 2 });
    // a few short horizontal breaks across plates
    layer(g, s, s, tg => {
      for (let i = 0; i < 6; i++) {
        const k = Math.floor(rnd() * nP), a = fur[k], b = fur[(k + 1) % nP], y = rnd() * s;
        let xa = X(a, y), xb = X(b, y + 3); if (xb < xa) xb += s;
        const x0 = xa + (xb - xa) * range(rnd, 0, 0.3), x1 = xa + (xb - xa) * range(rnd, 0.55, 1), dy = range(rnd, -5, 5);
        const pts = [[x0, y], [(x0 + x1) / 2, y + dy * 0.5 + range(rnd, -2, 2)], [x1, y + dy]];
        wrapPts(s, pts, 6, P => { line(tg, P.map(([u, v]) => [u, v - 2.4]), 2.4, '#d0ba94'); line(tg, P, 3.6, '#30242c'); });
      }
    }, { alpha: 0.45, blur: 1.2 });
    // grain
    streaks(g, s, rnd, { colors: ['#5e4e40', '#54463a', '#a08a70', '#b49e80'], count: 90, len: [12, 40], width: [0.8, 1.6], angle: 0, wobble: 0.1, alpha: 0.22 });
    // each plate's value drifts along its length: big soft light and dark stretches, not even stripes
    layer(g, s, s, tg => {
      for (const fu of fur) for (let k = 0; k < 3; k++) {
        const y = rnd() * s, x = X(fu, y) + fu.wd * 0.5, light = rnd() < 0.5;
        wrap(s, x, y, 70, (X2, Y2) => blob(tg, X2, Y2, fu.wd * 0.42, range(rnd, 40, 80), 0, light ? '#c0aa8a' : '#544640', 0.8, 0.1));
      }
    }, { alpha: 0.3, blur: 3 });
    // 2-3 burls: a long swollen knot the grain bends round, a lit lip on its upper left and a narrow
    // dark almond hollow (never a round eye)
    const nB = 2 + (rnd() < 0.5 ? 1 : 0);
    for (let i = 0; i < nB; i++) {
      const fu = fur[Math.floor(rnd() * nP)], y = (i + range(rnd, 0.1, 0.8)) * s / nB, x = X(fu, y) + fu.wd * range(rnd, 0.3, 0.6), rx = range(rnd, 6, 10), ry = rx * range(rnd, 2.2, 3);
      wrap(s, x, y, ry * 2.5, (X2, Y2) => {
        blob(g, X2, Y2, rx * 2.6, ry * 1.5, 0, '#a08a6c', 0.4, 0.3);                                      // the swelling
        layer(g, s, s, tg => {
          for (const sd of [-1, 1]) { const q = []; for (let k = 0; k <= 8; k++) { const t = k / 8 - 0.5; q.push([X2 + sd * rx * (1.6 + 0.4 * Math.cos(t * Math.PI)) * Math.cos(t * 2.4), Y2 + t * ry * 2.6]); } line(tg, q, 2, sd < 0 ? '#d2bc98' : '#463a3c'); }
        }, { alpha: 0.4, blur: 1.4 });
        blob(g, X2 - rx * 0.5, Y2 - ry * 0.25, rx * 1.3, ry * 0.75, 0, '#dccaa8', 0.45, 0.35);              // lit lip
        g.save(); g.fillStyle = '#3a3030'; g.globalAlpha = 0.85; g.beginPath(); g.moveTo(X2, Y2 - ry * 0.75);
        g.quadraticCurveTo(X2 + rx * 0.7, Y2, X2 + rx * 0.05, Y2 + ry * 0.7); g.quadraticCurveTo(X2 - rx * 0.55, Y2, X2, Y2 - ry * 0.75); g.fill(); g.restore();
        blob(g, X2 + rx * 0.15, Y2 + ry * 0.15, rx * 0.35, ry * 0.4, 0, '#2a2226', 0.7, 0.4);
      });
    }
    mottle(g, s, rnd, { colors: ['#8e9a6a', '#7a8a58', '#a4a88a', '#b4b090'], count: 26, rmin: 2, rmax: 6, alpha: 0.4, hard: 0.6 });
    glaze(g, s, s, '#ffe8b8', 0.12, 'soft-light');
    jsBlur(cv, 0.45);
  },
});

register('bark_pine', {
  family: F, size: 256, note: 'red-brown scaly plates with dark seams (stretch v on the mesh)',
  paint(g, s, rnd, h, cv) {
    const f = worley(s, 6, rnd, 0.9);
    paintCells(g, f, { colors: ['#7a4c36', '#8a5a3e', '#6c4232', '#93634a', '#7f5442'], grout: '#33242a', groutW: 2.6, bevel: 7, dome: 0.25, light: 0.55, varAmt: 0.08, rnd });
    mottle(g, s, rnd, { colors: ['#a06a4a', '#5e3a2c', '#8a6450', '#6e5048'], count: 30, rmin: 10, rmax: 40, alpha: 0.25, hard: 0.2 });
    streaks(g, s, rnd, { colors: ['#3a2628', '#4a3030'], count: 30, len: [20, 60], width: [1, 2], angle: 0, wobble: 0.1, alpha: 0.45 });
    mottle(g, s, rnd, { colors: ['#c08a62', '#b47c58'], count: 40, rmin: 3, rmax: 8, alpha: 0.35, hard: 0.4 });
    mottle(g, s, rnd, { colors: ['#8a9468', '#9aa078'], count: 10, rmin: 4, rmax: 10, alpha: 0.3, hard: 0.5 });
    glaze(g, s, s, '#ffd8a8', 0.1, 'soft-light');
    jsBlur(cv, 0.45);
  },
});

register('bark_dead', {
  family: F, size: 256, note: 'bleached deadwood: long grain, dark splits with lit lips, knots',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8e877c');
    mottle(g, s, rnd, { colors: ['#a29c90', '#766e64', '#aea898', '#86796a', '#6a6664', '#9a8a7a'], count: 30, rmin: 20, rmax: 70, alpha: 0.5, hard: 0.08, stretch: 3, rot: Math.PI / 2 });
    jsBlur(cv, 2.5);
    streaks(g, s, rnd, { colors: ['#564e48', '#625a52', '#6e6458'], count: 120, len: [50, 170], width: [0.8, 2.2], angle: 0, wobble: 0.07, alpha: 0.42 });
    streaks(g, s, rnd, { colors: ['#bcb6a8', '#cac2b2', '#d8d0c0'], count: 100, len: [40, 150], width: [0.8, 2], angle: 0, wobble: 0.07, alpha: 0.42 });
    layer(g, s, s, tg => {
      for (let i = 0; i < 9; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 50, 140), f = periodic(rnd, 2, 1, 1), wd = range(rnd, 2, 3.4);
        const pts = []; for (let k = 0; k <= 10; k++) pts.push([x + f(k / 10) * 5, y + L * k / 10]);
        wrapPts(s, pts, 6, P => { line(tg, P.map(([u, v]) => [u + 2, v]), 2.5, '#e4dccc'); line(tg, P, wd, '#2e2830'); });
      }
    }, { alpha: 0.7, blur: 0.5 });
    for (let i = 0; i < 2; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 6, 10);
      wrap(s, x, y, r * 2.2, (X, Y) => {
        ellipse(g, X, Y, r * 0.8, r * 1.8, 0, '#5a524c', 0.8);
        ellipse(g, X, Y, r * 0.45, r, 0, '#2e2830', 0.85);
        blob(g, X - r * 0.5, Y - r * 0.8, r * 0.5, r * 0.9, 0, '#e0d8c8', 0.35, 0.4);
      });
    }
    glaze(g, s, s, '#ffe8c0', 0.1, 'soft-light');
    jsBlur(cv, 0.4);
  },
});

// Palm trunk: stacked rings of old leaf bases, 7-9 per tile and never even. Each ring: a lit cream top
// lip, a dark cool crease right under it, a body that darkens downward, and a frayed lower edge with
// brown fibre hairs hanging over the next ring. The mesh squeezes v toward the crown.
register('bark_palm', {
  family: F, size: 256, note: 'palm trunk: stacked leaf-base rings, lit lips, dark creases, frayed edges and fibre hairs',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#6e5840');
    const n = 7 + Math.floor(rnd() * 3), hs = []; let tot = 0;
    for (let i = 0; i < n; i++) { const hh = range(rnd, 0.6, 1.5); hs.push(hh); tot += hh; }
    const rings = []; let y = 0;
    for (const hh of hs) { const H = hh / tot * s; rings.push({ y, H, f: periodic(rnd, 3, 1.1, 1), tilt: range(rnd, -4, 4), c: pick(rnd, ['#8a6e4c', '#7a6042', '#9a7c56', '#86684a', '#6e5840', '#a08460']) }); y += H; }
    const top = (r, x) => r.y + r.f(fract01(x, s)) * 3 + r.tilt * Math.sin(TAU * x / s);
    // per ring, fixed in advance so every wrapped copy is identical: the jagged lower edge (periodic in
    // x) and the fibre hairs
    const NJ = s / 4;
    for (const r of rings) {
      const jf = periodic(rnd, 6, 0.7, 3); r.jag = []; for (let k = 0; k < NJ; k++) r.jag.push(2.5 + jf(k / NJ) * 3.5 + range(rnd, -0.6, 0.6));
      r.hair = []; for (let x = rnd() * 5; x < s; x += range(rnd, 2, 6)) r.hair.push([x, range(rnd, 1, 4), range(rnd, 3, 12) * (rnd() < 0.15 ? 1.8 : 1), range(rnd, -2.5, 2.5), range(rnd, 0.9, 1.8), pick(rnd, ['#6a5034', '#5a4430', '#7a6040', '#8a7050'])]);
    }
    // each ring drawn from the bottom of the trunk up, so every ring's frayed lower edge laps over the
    // ring below; every ring also drawn shifted by ±s (and its hairs by ±s in x) so the wrap is seamless
    for (const dy of [s, 0, -s]) for (let i = rings.length - 1; i >= 0; i--) {
      const r = rings[i];
      const yb = x => (i + 1 < rings.length ? top(rings[i + 1], x) : top(rings[0], x) + s);
      const pts = []; for (let x = -8; x <= s + 8; x += 4) pts.push([x, top(r, x) + dy]);
      const bot = []; for (let x = s + 8; x >= -8; x -= 4) bot.push([x, yb(x) + dy + r.jag[((Math.round(x / 4) % NJ) + NJ) % NJ]]);
      g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const [x, yy] of pts) g.lineTo(x, yy); for (const [x, yy] of bot) g.lineTo(x, yy); g.closePath();
      const gr = g.createLinearGradient(0, r.y + dy, 0, r.y + r.H + dy + 3);
      gr.addColorStop(0, lightOf(r.c, 0.35)); gr.addColorStop(0.25, r.c); gr.addColorStop(0.75, shadowOf(r.c, 0.18)); gr.addColorStop(1, shadowOf(r.c, 0.4));
      g.fillStyle = gr; g.fill();
      // the fibre hairs hanging off its lower edge onto the ring below
      for (const [x0, up, L, dx, w, c] of r.hair) for (const sx of [-s, 0, s]) {
        const x = x0 + sx; if (x < -12 || x > s + 12) continue;
        const y0 = yb(x0) + dy - up;
        stroke(g, [[x, y0], [x + dx, y0 + L]], w, 0.4, c, 0.85);
      }
      // the crease under its lip and the lit lip itself
      line(g, pts.map(([x, yy]) => [x, yy + 4.5]), 3.2, '#4a3a30', 0.55);
      line(g, pts.map(([x, yy]) => [x, yy + 1.2]), 2.4, '#c8b08a', 0.85);
    }
    // vertical fibre grain and a few splits inside the rings
    streaks(g, s, rnd, { colors: ['#5a4632', '#9a8260'], count: 90, len: [6, 18], width: [0.8, 1.4], angle: 0, wobble: 0.2, alpha: 0.35 });
    mottle(g, s, rnd, { colors: ['#a08a64', '#6e5a40', '#9a9070'], count: 24, rmin: 10, rmax: 36, alpha: 0.16, hard: 0.2 });
    glaze(g, s, s, '#ffe0a8', 0.12, 'soft-light');
    jsBlur(cv, 0.5);
  },
});

register('wood_fence', {
  family: F, size: 256, note: 'split-rail wood: warm brown, sun-bleached streaks, long dark crevices with lit lips, knots',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7a5a3e');
    mottle(g, s, rnd, { colors: ['#86664a', '#6e5036', '#8e6e4e', '#74563c', '#9a8268'], count: 34, rmin: 20, rmax: 60, alpha: 0.5, hard: 0.12, stretch: 4, rot: Math.PI / 2 });
    jsBlur(cv, 2);
    streaks(g, s, rnd, { colors: ['#5e4430', '#6a4e36', '#4e3828'], count: 110, len: [60, 200], width: [1.2, 3.2], angle: 0, wobble: 0.05, alpha: 0.55 });
    // sun-bleached gray only in a few long streaks (the tops of the rails catch it)
    streaks(g, s, rnd, { colors: ['#a49a88', '#b0a694', '#968a76'], count: 40, len: [50, 180], width: [2, 6], angle: 0, wobble: 0.04, alpha: 0.4 });
    streaks(g, s, rnd, { colors: ['#c8b496', '#d4c0a0'], count: 60, len: [30, 120], width: [0.8, 1.6], angle: 0, wobble: 0.05, alpha: 0.4 });
    layer(g, s, s, tg => {
      for (let i = 0; i < 7; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 60, 170), f = periodic(rnd, 2, 1, 1);
        const pts = []; for (let k = 0; k <= 10; k++) pts.push([x + f(k / 10) * 3, y + L * k / 10]);
        wrapPts(s, pts, 6, P => { line(tg, P.map(([u, v]) => [u + 2.2, v]), 2.2, '#d0b896'); line(tg, P, 2.6, '#3a2a22'); });
      }
    }, { alpha: 0.8, blur: 0.4 });
    for (let i = 0; i < 3; i++) {
      const x = rnd() * s, y = (i + range(rnd, 0.1, 0.9)) * s / 3, r = range(rnd, 5, 8);
      wrap(s, x, y, r * 3, (X, Y) => {
        layer(g, s, s, tg => { for (let k = 3; k >= 1; k--) { tg.lineWidth = 1.6; tg.strokeStyle = k % 2 ? '#4a3626' : '#a88a66'; tg.beginPath(); tg.ellipse(X, Y, r * (0.6 + k * 0.4), r * (1.2 + k * 0.9), 0, 0, TAU); tg.stroke(); } }, { alpha: 0.4, blur: 0.8 });
        ellipse(g, X, Y, r * 0.9, r * 1.4, 0, '#4a3426', 0.9); ellipse(g, X + 0.5, Y + 0.6, r * 0.45, r * 0.75, 0, '#2c1e1a', 0.9);
        blob(g, X - r * 0.5, Y - r * 0.7, r * 0.5, r * 0.8, 0, '#e0c8a0', 0.45, 0.4);
      });
    }
    mottle(g, s, rnd, { colors: ['#8a9a6a', '#a4a070'], count: 6, rmin: 3, rmax: 7, alpha: 0.25, hard: 0.5 });
    glaze(g, s, s, '#ffd8a0', 0.12, 'soft-light');
    jsBlur(cv, 0.4);
  },
});

// ---- rock -----------------------------------------------------------------------------------------

// A rock face the WoW way: no cells. Big soft value planes, then a few long fractures (a cool dark
// crease with a lit lip on the upper-left side), chipped angular patches lit on their upper-left
// edges, lichen colonies and rain stains. Form comes from the mesh's planes and its vertex AO.
function rockPaint(g, s, rnd, cv, P) {
  fill(g, s, s, P.base);
  mottle(g, s, rnd, { colors: P.big, count: 9, rmin: 110, rmax: 220, alpha: 0.55, hard: 0.04 });
  mottle(g, s, rnd, { colors: P.blot, count: 30, rmin: 30, rmax: 90, alpha: 0.22, hard: 0.08 });
  jsBlur(cv, 5);
  // chipped planes: soft angular patches, lighter or darker, lit on the upper-left edges
  layer(g, s, s, tg => {
    for (let i = 0; i < (P.planes ?? 11); i++) {
      const cx = rnd() * s, cy = rnd() * s, r = range(rnd, 60, 150), n = 4 + Math.floor(rnd() * 3), a0 = rnd() * TAU, sq = range(rnd, 0.55, 0.9);
      const pts = []; for (let k = 0; k < n; k++) { const a = a0 + (k + range(rnd, -0.25, 0.25)) / n * TAU, rr = r * range(rnd, 0.6, 1.1); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * sq]); }
      const lighter = rnd() < 0.55, c = lighter ? lightOf(P.base, 0.3) : shadowOf(P.base, 0.25);
      wrapPts(s, pts, 4, Q => {
        poly(tg, Q, c, 0.5);
        for (let k = 0; k < n; k++) {
          const A = Q[k], B = Q[(k + 1) % n], nx = B[1] - A[1], ny = -(B[0] - A[0]), l = Math.hypot(nx, ny) || 1;
          const up = (-nx - ny) / l / Math.SQRT2;       // edge normal toward the upper left
          if (up > 0.25) line(tg, [A, B], 5, P.lip, 0.9 * up);
          else if (up < -0.25) line(tg, [A, B], 6, P.crease, 0.8 * -up);
        }
      });
    }
  }, { alpha: 0.6, blur: 2.6 });
  // long fractures
  const frac = [];
  layer(g, s, s, tg => {
    for (let i = 0; i < (P.fractures ?? 7); i++) {
      let x = rnd() * s, y = rnd() * s, a = range(rnd, 0.6, 2.5) * (rnd() < 0.5 ? 1 : -1);
      const pts = [[x, y]], segs = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < segs; k++) { a += range(rnd, -0.5, 0.5); const L = range(rnd, 28, 70); x += Math.cos(a) * L; y += Math.sin(a) * L; pts.push([x, y]); }
      const br = []; if (rnd() < 0.3) { const [bx, by] = pts[1 + Math.floor(rnd() * (pts.length - 1))], ba = a + range(rnd, 0.6, 1.2) * (rnd() < 0.5 ? 1 : -1), bl = range(rnd, 18, 40); br.push([bx, by], [bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl]); }
      frac.push(pts); if (br.length) frac.push(br);
    }
  }, { alpha: 0, blur: 0 });
  // each fracture: a wide soft cool shadow, a lit lip on its upper-left side, a dark core
  layer(g, s, s, tg => { for (const pts of frac) wrapPts(s, pts, 10, Q => line(tg, Q.map(([u, v]) => [u + 3, v + 3.5]), 14, P.crease)); }, { alpha: 0.5, blur: 4 });
  layer(g, s, s, tg => { for (const pts of frac) wrapPts(s, pts, 10, Q => line(tg, Q.map(([u, v]) => [u - 2.4, v - 2.4]), 2.2, P.lip)); }, { alpha: 0.32, blur: 1.4 });
  layer(g, s, s, tg => { for (const pts of frac) wrapPts(s, pts, 10, Q => line(tg, Q, 3.2, P.deep)); }, { alpha: 0.6, blur: 1.1 });
  // chips
  for (let i = 0; i < 40; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 3, 8), a0 = rnd() * TAU;
    const pts = []; for (let k = 0; k < 4; k++) { const a = a0 + k / 4 * TAU + range(rnd, -0.3, 0.3); pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 0.75]); }
    wrapPts(s, pts, 2, Q => { poly(g, Q.map(([u, v]) => [u + 1.2, v + 1.4]), P.crease, 0.35); poly(g, Q, lightOf(P.base, 0.35), 0.5); });
  }
  if (P.fleck) mottle(g, s, rnd, { colors: P.fleck, count: P.fleckN ?? 120, rmin: 1.2, rmax: 3, alpha: 0.5, hard: 0.6 });
  if (P.lichen) {
    for (let c = 0; c < 14; c++) {
      const cx = rnd() * s, cy = rnd() * s, col = pick(rnd, P.lichen);
      for (let k = 0; k < 14; k++) { const x = cx + range(rnd, -14, 14), y = cy + range(rnd, -10, 10), r = range(rnd, 1.8, 5); wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 0.8, 0, col, 0.6); blob(g, X - r * 0.3, Y - r * 0.3, r * 0.5, r * 0.4, 0, lightOf(col, 0.4), 0.5, 0.4); }); }
    }
  }
  streaks(g, s, rnd, { colors: [P.stain], count: 22, len: [40, 120], width: [4, 12], angle: Math.PI, wobble: 0.08, alpha: 0.1 });
  glaze(g, s, s, P.glaze, 0.12, 'soft-light');
  jsBlur(cv, 0.6);
}

register('rock_gray', {
  family: F, size: 512, note: 'Elwynn rock: warm-cool gray planes, long fractures with lit lips, chips, lichen (moss comes from the cover)',
  paint: (g, s, rnd, h, cv) => rockPaint(g, s, rnd, cv, {
    base: '#88847a', big: ['#a29c8e', '#6c6a66', '#8a8c7c', '#9a9284', '#767472'], blot: ['#a09a8e', '#6a6764', '#7c866c', '#8c8070', '#a8a294'],
    lip: '#e2d8bc', crease: '#4a4652', deep: '#36323e', stain: '#4a4650',
    fleck: ['#b4ae9e', '#5e5a58'], lichen: ['#a8ac7a', '#8e9a66', '#b8b08a', '#c2a868'], glaze: '#ffe2b0',
  }),
});
register('rock_warm', {
  family: F, size: 512, note: 'Westfall rock: sun-warmed tan-gray, yellow and orange lichen',
  paint: (g, s, rnd, h, cv) => rockPaint(g, s, rnd, cv, {
    base: '#958a76', big: ['#aea08a', '#786e60', '#a49478', '#8a7e6a'], blot: ['#ab9e84', '#776c5e', '#a08860', '#8a7a62'],
    lip: '#ecdcb8', crease: '#54484a', deep: '#3e3432', stain: '#5a4a3e',
    fleck: ['#c0b498', '#665a4e'], lichen: ['#c8b45a', '#d09848', '#b8a858', '#a8a860', '#d8a040'], glaze: '#ffdca0',
  }),
});
register('rock_granite', {
  family: F, size: 512, note: 'Dun Morogh granite: blue-gray planes, pale feldspar flecks, cold fractures',
  paint: (g, s, rnd, h, cv) => rockPaint(g, s, rnd, cv, {
    base: '#868e9c', big: ['#a6b0c0', '#66707e', '#909aa8', '#76808e'], blot: ['#a4acb8', '#646a7a', '#848a9a', '#94969f'],
    lip: '#e4ecf4', crease: '#3e4256', deep: '#2c2e40', stain: '#3c4050',
    fleck: ['#c8ccd6', '#d8dce2', '#4a4e5c', '#a8acb8'], fleckN: 260, glaze: '#e0ecff', fractures: 9,
  }),
});

// The hard beds of the layered rocks, as [v0, v1] (bottom and top, fractions of the tile height with v
// up = world up; the rocks are mapped in world space, so a bed lies at the same world heights on every
// rock of the day). nature3d puts its ledges' jutting lips and undercuts exactly on these, so the paint
// and the shape tell the same story. Spacing and thickness are uneven on purpose.
export const STRATA_BEDS = {
  rock_red: [[0.03, 0.085], [0.13, 0.15], [0.33, 0.39], [0.5, 0.52], [0.565, 0.6], [0.76, 0.81]],
  rock_sand: [[0.03, 0.062], [0.19, 0.21], [0.33, 0.372], [0.52, 0.54], [0.66, 0.694], [0.83, 0.85]],
};

// Bedded rock in the canyon walls' language (it must look broken off them): soft beds that alternate
// between a pale peach family and a deep red-orange one, each with a lens or two of another shade that
// pinches out across the tile (a thin broken ledgelet over it), between hard beds that stand proud: a
// lit lip of varying strength along each top, chipped here and there, and a strong soft purple-brown
// undercut under each foot with rain stains dripping from it. Big soft blotches break the horizontals;
// a few angular joints of uneven length (some on through a hard bed). No fault steps, no pock holes, no
// evenly spaced lines. Seamless both ways (boundaries periodic in x, everything drawn wrapped).
function bedded(g, s, rnd, cv, P) {
  const beds = P.beds.map(([v0, v1]) => ({ yT: (1 - v1) * s, yB: (1 - v0) * s })).sort((a, b) => a.yT - b.yT);
  const n = beds.length, aT = P.hardWob ?? 2.2, aB = aT * 1.5;
  for (const b of beds) { b.fT = periodic(rnd, 5, 1.1, 1); b.fB = periodic(rnd, 5, 1.1, 1); b.fL = periodic(rnd, 3, 1, 1); b.c = pick(rnd, P.hard); }
  const bT = (i, x) => { const b = beds[((i % n) + n) % n]; return b.yT + Math.floor(i / n) * s + b.fT(fract01(x, s)) * aT; };
  const bB = (i, x) => { const b = beds[((i % n) + n) % n]; return b.yB + Math.floor(i / n) * s + b.fB(fract01(x, s)) * aB; };
  const run = (fn, off = 0, x0 = -8, x1 = s + 8) => { const o = []; for (let x = x0; x <= x1; x += 4) o.push([x, fn(x) + off]); return o; };
  const band = (top, bot, dy, fillS) => {
    g.beginPath();
    for (let x = -8; x <= s + 8; x += 4) g.lineTo(x, top(x) + dy);
    for (let x = s + 8; x >= -8; x -= 4) g.lineTo(x, bot(x) + dy + 0.6);
    g.closePath(); g.fillStyle = fillS; g.fill();
  };
  fill(g, s, s, P.deep[0]);
  // the soft beds, pale and deep by turns (a coin decides where to start), each lit down its middle
  const fam0 = rnd() < 0.5 ? 0 : 1, soft = [];
  for (let i = 0; i < n; i++) {
    const fam = (i + fam0) % 2 ? P.pale : P.deep, other = (i + fam0) % 2 ? P.deep : P.pale;
    const y0 = beds[i].yB, y1 = beds[(i + 1) % n].yT + (i + 1 >= n ? s : 0), c = pick(rnd, fam);
    soft.push({ i, y0, y1, c, other });
    for (const dy of [-s, 0, s]) {
      const gr = g.createLinearGradient(0, y0 + dy, 0, y1 + dy);
      gr.addColorStop(0, shadowOf(c, 0.2)); gr.addColorStop(0.3, c); gr.addColorStop(0.75, lightOf(c, 0.1)); gr.addColorStop(1, c);
      band(x => bB(i, x), x => bT(i + 1, x), dy, gr);
    }
  }
  // sub-beds: each soft bed split by one or two full-width boundaries that wander up and down (a
  // related shade either side, no line), and over some of them a thin broken ledgelet that fades in
  // and out along its length
  for (const S of soft) {
    const H = S.y1 - S.y0; if (H < 34) continue;
    const m = H > 100 ? 2 : 1;
    let prevTop = null;
    for (let q = 0; q < m; q++) {
      const yc = S.y0 + H * (m === 1 ? range(rnd, 0.38, 0.62) : q ? range(rnd, 0.62, 0.78) : range(rnd, 0.28, 0.42));
      const f = periodic(rnd, 4, 1.25, 1), amp = Math.min(H * 0.18, range(rnd, 6, 12));
      const top = x => yc + f(fract01(x, s)) * amp;
      const c = rnd() < 0.55 ? pick(rnd, S.other) : (rnd() < 0.5 ? lightOf(S.c, 0.22) : shadowOf(S.c, 0.18));
      const bot = q === m - 1 ? x => bT(S.i + 1, x) : null;
      S.sub = S.sub || [];
      S.sub.push({ top, c, bot });
      prevTop = top;
    }
    for (let q = 0; q < S.sub.length; q++) if (!S.sub[q].bot) S.sub[q].bot = S.sub[q + 1].top;
    for (const sb of S.sub) for (const dy of [-s, 0, s]) {
      const gr = g.createLinearGradient(0, S.y0 + dy, 0, S.y1 + dy);
      gr.addColorStop(0, lightOf(sb.c, 0.06)); gr.addColorStop(0.6, sb.c); gr.addColorStop(1, shadowOf(sb.c, 0.06));
      g.save(); g.globalAlpha = 0.9; band(sb.top, sb.bot, dy, gr); g.restore();
    }
    layer(g, s, s, tg => {
      for (const sb of S.sub) {
        if (rnd() > (P.ledgelets ?? 0.65)) continue;
        const fa = periodic(rnd, 3, 1, 1), ph = range(rnd, -0.3, 0.2);
        for (let x0 = -8; x0 < s + 8; x0 += 16) {
          const k = Math.max(0, Math.min(1, fa(fract01(x0 + 8, s)) * 1.8 + ph));
          if (k < 0.04) continue;
          for (const dy of [-s, 0, s]) {
            line(tg, run(sb.top, dy + 3.2, x0, x0 + 20), 4.5, P.under, 0.6 * k);
            line(tg, run(sb.top, dy - 0.4, x0, x0 + 20), 1.8, lightOf(sb.c, 0.5), k);
          }
        }
      }
    }, { alpha: 0.42, blur: 1.2 });
  }
  // big soft blotches: long ones along the bedding and a few round ones across it
  mottle(g, s, rnd, { colors: P.blot, count: 26, rmin: 26, rmax: 90, alpha: 0.16, hard: 0.08, stretch: 2.4, rot: 0 });
  mottle(g, s, rnd, { colors: P.blot, count: 8, rmin: 60, rmax: 130, alpha: 0.1, hard: 0.05 });
  // long soft vertical washes, light and dark (rain runs down the face): they break the horizontals
  layer(g, s, s, tg => {
    for (let q = 0; q < 9; q++) {
      const x = rnd() * s, y = rnd() * s, w = range(rnd, 14, 46), L = range(rnd, 120, 320), c = q % 3 ? P.lit : P.under;
      wrap(s, x, y, Math.max(w, L), (X, Y) => { const gr = tg.createLinearGradient(0, Y - L / 2, 0, Y + L / 2); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.3, c); gr.addColorStop(1, 'rgba(0,0,0,0)'); tg.fillStyle = gr; tg.beginPath(); tg.ellipse(X, Y, w / 2, L / 2, 0, 0, TAU); tg.fill(); });
    }
  }, { alpha: 0.1, blur: 6 });
  // the hard beds: lit top, the bed colour, a shaded foot
  for (const dy of [-s, 0, s]) for (let i = 0; i < n; i++) {
    const b = beds[i];
    const gr = g.createLinearGradient(0, b.yT + dy - aT, 0, b.yB + dy + aB);
    gr.addColorStop(0, lightOf(b.c, 0.22)); gr.addColorStop(0.35, b.c); gr.addColorStop(0.8, b.c); gr.addColorStop(1, shadowOf(b.c, 0.16));
    band(x => bT(i, x), x => bB(i, x), dy, gr);
    // the bed's colour drifts along it (a warmer or paler stretch here and there)
    g.save(); g.beginPath();
    for (let x = -8; x <= s + 8; x += 4) g.lineTo(x, bT(i, x) + dy);
    for (let x = s + 8; x >= -8; x -= 4) g.lineTo(x, bB(i, x) + dy);
    g.closePath(); g.clip();
    for (let q = 0; q < 5; q++) { const x = rnd() * s, c = pick(rnd, P.hard.concat(P.pale)); wrap(s, x, (b.yT + b.yB) / 2 + dy, 80, (X, Y) => blob(g, X, Y, range(rnd, 30, 80), (b.yB - b.yT) * 0.8, 0, c, 0.35, 0.1)); }
    g.restore();
  }
  // under every hard bed: a strong soft purple-brown undercut that deepens and thins along it, a dark
  // crease at its foot
  layer(g, s, s, tg => {
    tg.fillStyle = P.under;
    for (const dy of [-s, 0, s]) for (let i = 0; i < n; i++) {
      const fw = periodic(rnd, 3, 1, 1), W = P.underW;
      tg.beginPath();
      for (let x = -8; x <= s + 8; x += 4) tg.lineTo(x, bB(i, x) + dy - 1);
      for (let x = s + 8; x >= -8; x -= 4) tg.lineTo(x, bB(i, x) + dy + W * (0.75 + 0.45 * fw(fract01(x, s))));
      tg.closePath(); tg.fill();
    }
  }, { alpha: P.underA ?? 0.6, blur: P.underW * 0.3 });
  layer(g, s, s, tg => { for (const dy of [-s, 0, s]) for (let i = 0; i < n; i++) line(tg, run(x => bB(i, x), dy + 1.2), 2.6, P.crack); }, { alpha: 0.5, blur: 0.8 });
  // on every hard bed's top: a lit lip whose strength wanders along it, a faint crease over it, and a
  // few chips knocked out of it
  layer(g, s, s, tg => {
    for (const dy of [-s, 0, s]) for (let i = 0; i < n; i++) {
      const b = beds[i];
      line(tg, run(x => bT(i, x), dy - 1.2), 1.8, P.under, 0.35);
      for (let x0 = -8; x0 < s + 8; x0 += 24) {
        const k = 0.55 + 0.45 * b.fL(fract01(x0 + 12, s));
        line(tg, run(x => bT(i, x), dy + 1.4, x0, x0 + 28), 2.2, lightOf(b.c, 0.6), Math.max(0.1, k * k));
      }
    }
  }, { alpha: P.lipA ?? 0.7, blur: 0.9 });
  for (let i = 0; i < n; i++) for (let q = 0; q < 3; q++) {
    const x = rnd() * s, y = bT(i, x), w = range(rnd, 6, 16), d = range(rnd, 3, 6);
    const pts = [[x - w / 2, y - 0.5], [x + w / 2, y - 0.5], [x + w * 0.3, y + d], [x - w * 0.2, y + d * 0.8]];
    wrapPts(s, pts, 2, Q => { for (const dy of [-s, 0, s]) { const QQ = Q.map(([u, v]) => [u, v + dy]); poly(g, QQ, shadowOf(beds[i].c, 0.4), 0.55); poly(g, QQ.map(([u, v]) => [u - 1.2, v + 1.4]), lightOf(beds[i].c, 0.3), 0.25); } });
  }
  // rain stains dripping from the hard beds' feet, and pale washed streaks
  layer(g, s, s, tg => {
    for (let i = 0; i < n; i++) for (let q = 0; q < (P.dripN ?? 5); q++) {
      const x = rnd() * s, L = range(rnd, 18, 80), w = range(rnd, 3, 7), y0 = bB(i, x) + 2;
      for (const dy of [-s, 0, s]) wrap(s, x, y0 + dy + L / 2, Math.max(w, L), (X, Y) => { tg.save(); const gr = tg.createLinearGradient(0, Y - L / 2, 0, Y + L / 2); gr.addColorStop(0, P.streak[0]); gr.addColorStop(1, 'rgba(0,0,0,0)'); tg.fillStyle = gr; tg.beginPath(); tg.ellipse(X, Y, w / 2, L / 2, 0, 0, TAU); tg.fill(); tg.restore(); });
    }
  }, { alpha: P.dripA ?? 0.22, blur: 1.5 });
  streaks(g, s, rnd, { colors: [P.lit], count: P.streakN ?? 14, len: [30, 110], width: [2, 5], angle: Math.PI, wobble: 0.05, alpha: 0.12 });
  // joints: angular cracks of uneven length down a soft bed (some on through the hard bed under it):
  // a soft shadow to one side, a dark crease, a lit lip on the other
  layer(g, s, s, tg => {
    for (let q = 0; q < P.fissN; q++) {
      const i = Math.floor(rnd() * n), x0 = rnd() * s, yA = bB(i, x0) + 1, through = rnd() < 0.3;
      const yZ = bT(i + 1, x0) + (through ? beds[(i + 1) % n].yB - beds[(i + 1) % n].yT + 4 : 0);
      const L = (yZ - yA) * range(rnd, 0.4, 1), o = [[x0, yA]], segs = 2 + Math.floor(rnd() * 3);
      let x = x0, y = yA, a = range(rnd, -0.35, 0.35);
      for (let k = 0; k < segs; k++) { a = Math.max(-0.5, Math.min(0.5, a + range(rnd, -0.45, 0.45))); const l = L / segs; x += Math.sin(a) * l; y += Math.cos(a) * l; o.push([x, y]); }
      for (const dy of [-s, 0, s]) wrapPts(s, o, 8, Q => {
        const QQ = Q.map(([u, v]) => [u, v + dy]);
        line(tg, QQ.map(([u, v]) => [u + 2.2, v]), 5, P.under, 0.4); line(tg, QQ, 1.7, P.crack); line(tg, QQ.map(([u, v]) => [u - 1.7, v]), 1.2, P.lit, 0.5);
      });
    }
  }, { alpha: 0.55, blur: 0.7 });
  // chips: small angular patches lit on the upper left
  for (let q = 0; q < (P.chipN ?? 22); q++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 3, 7), a0 = rnd() * TAU, pts = [];
    for (let k = 0; k < 4; k++) { const a = a0 + k / 4 * TAU + range(rnd, -0.3, 0.3); pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 0.7]); }
    wrapPts(s, pts, 2, Q => { poly(g, Q.map(([u, v]) => [u + 1.2, v + 1.4]), P.under, 0.2); poly(g, Q, P.lit, 0.2); });
  }
  if (P.extra) P.extra(g, s, rnd, beds, bT, bB);
  glaze(g, s, s, P.glaze, 0.12, 'soft-light');
  jsBlur(cv, 0.7);
}
register('rock_red', {
  family: F, size: 512, note: 'Badlands strata: thick red and orange soft beds between thin cream hard beds (lit lips, cool undercuts, rain stains) at fixed heights the ledges follow; irregular joints (seamless)',
  paint: (g, s, rnd, h, cv) => bedded(g, s, rnd, cv, {
    beds: STRATA_BEDS.rock_red,
    pale: ['#e0a272', '#d89462', '#e6b084'], deep: ['#bc5c2e', '#ae4e2a', '#c66a38', '#a64828'], hard: ['#f0c89c', '#e8b686', '#dc9c6c', '#eab27e'],
    blot: ['#e2a070', '#8a3a22', '#c06a40', '#f0c090'], streak: ['#5a2418'], under: '#5a2830', crack: '#44202a', lit: '#f6d2a4',
    underW: 13, fissN: 7, glaze: '#ffd0a0',
  }),
});
// Tanaris sandstone: the same bedded language, paler and softer: tan and honey soft beds between thin
// cream hard beds, warm brown undercuts, wind-scoured pits in loose clusters and a few soft wind grooves.
register('rock_sand', {
  family: F, size: 512, note: 'Tanaris sandstone: pale tan soft beds between thin cream hard beds (lit lips, warm undercuts) at fixed heights the mounds follow; wind pits and grooves (seamless)',
  paint: (g, s, rnd, h, cv) => bedded(g, s, rnd, cv, {
    beds: STRATA_BEDS.rock_sand,
    pale: ['#e2c494', '#e8cc9e', '#dab886'], deep: ['#c09666', '#b88c5e', '#c8a070'], hard: ['#ecd4aa', '#e4c89a', '#f0dcb4'],
    blot: ['#ead0a2', '#b08a5e', '#d8b080', '#a8805a'], streak: ['#8a6444'], under: '#6e4c44', crack: '#5a3e36', lit: '#fbeccc',
    underW: 10, underA: 0.42, lipA: 0.5, ledgelets: 0.3, fissN: 4, dripN: 2, dripA: 0.14, streakN: 5, chipN: 14, hardWob: 1.8, glaze: '#fff0c8',
    extra(g, s, rnd, beds, bT, bB) {
      // soft wind grooves along the soft beds (short, wavy, broken)
      layer(g, s, s, tg => {
        for (let q = 0; q < 16; q++) {
          const i = Math.floor(rnd() * beds.length), x0 = rnd() * s, t = range(rnd, 0.3, 0.75), L = range(rnd, 50, 160), f = periodic(rnd, 3, 1, 1), o = [];
          for (let x = 0; x <= L; x += 6) { const X = x0 + x; o.push([X, bB(i, X) * (1 - t) + bT(i + 1, X) * t + f(fract01(X, s)) * 2.5]); }
          for (const dy of [-s, 0, s]) wrapPts(s, o, 6, Q => { const QQ = Q.map(([u, v]) => [u, v + dy]); line(tg, QQ, 2.4, '#a07850'); line(tg, QQ.map(([u, v]) => [u, v + 2.2]), 1.6, '#f4e2bc', 0.8); });
        }
      }, { alpha: 0.28, blur: 1.1 });
      // wind-scoured pits, in a few loose clusters: a dark warm hollow, a lit lower lip
      for (let c = 0; c < 6; c++) {
        const cx = rnd() * s, cy = rnd() * s, m = 2 + Math.floor(rnd() * 4);
        for (let k = 0; k < m; k++) {
          const x = cx + range(rnd, -30, 30), y = cy + range(rnd, -16, 16), r = range(rnd, 3, 10) * (k ? 0.75 : 1), ry = r * range(rnd, 0.55, 0.8);
          wrap(s, x, y, r * 2, (X, Y) => {
            blob(g, X, Y - ry * 0.3, r * 1.25, ry * 1.15, 0, '#a88258', 0.22, 0.3);
            blob(g, X, Y, r, ry, 0, '#9c7650', 0.45, 0.55);
            blob(g, X, Y + ry * 0.85, r * 0.95, ry * 0.32, 0, '#f0dcb4', 0.5, 0.45);
          });
        }
      }
    },
  }),
});

// ---- top cover (moss, snow, dust...) ---------------------------------------------------------------

function cover(paintColor, paintMask, lo = 0.15) {
  return (g, s, rnd) => {
    const C = makeCanvas(s), M = makeCanvas(s);
    const cg = C.getContext('2d', { willReadFrequently: true }), mg = M.getContext('2d', { willReadFrequently: true });
    paintColor(cg, s, rnd, C);
    fill(mg, s, s, '#000');
    paintMask(mg, s, rnd, M);
    withMask(g, s, C, M, lo, 1);
  };
}
// thickness: soft white patches; `stipple` small dark specks fray the edges (no big round holes)
const lumpyMask = (n, r0, r1, a = 0.6, blur = 3, stipple = 0, base = null, holes = 0) => (g, s, rnd, cv) => {
  if (base) fill(g, s, s, base);
  mottle(g, s, rnd, { colors: ['#ffffff'], count: n, rmin: r0, rmax: r1, alpha: a, hard: 0.55 });
  if (holes) mottle(g, s, rnd, { colors: ['#000000'], count: holes, rmin: r0, rmax: r1 * 1.2, alpha: 0.75, hard: 0.5 });
  if (stipple) mottle(g, s, rnd, { colors: ['#000000'], count: stipple, rmin: 1.2, rmax: 3.5, alpha: 0.7, hard: 0.7 });
  jsBlur(cv, blur);
};

register('cover_moss', {
  family: F, size: 256, alpha: true, note: 'moss: dark olive, stippled clumps and tiny tufts (alpha = thickness)',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#465c26');
    mottle(g, s, rnd, { colors: ['#3a4e20', '#56682e', '#62723a', '#425624', '#5a6630'], count: 50, rmin: 8, rmax: 34, alpha: 0.5, hard: 0.2 });
    for (let i = 0; i < 700; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.2, 3), c = pick(rnd, ['#5a7030', '#66783a', '#4c6428', '#728440', '#40561f']);
      wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X + 0.6, Y + 0.7, r, r * 0.8, 0, '#2e3c1c', 0.35); ellipse(g, X, Y, r, r * 0.8, 0, c, 0.9); });
    }
    for (let i = 0; i < 160; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 8, (X, Y) => blade(g, X, Y, range(rnd, 3, 7), range(rnd, -0.6, 0.6), 1.3, pick(rnd, ['#8c9a4a', '#7a8c40', '#9aa458']), 0.85, range(rnd, -0.3, 0.3))); }
    glaze(g, s, s, '#ffe7a0', 0.08, 'soft-light');
  }, lumpyMask(50, 10, 34, 0.6, 1.8, 450, '#6c6c6c', 22)),
});
register('cover_lichen', {
  family: F, size: 256, alpha: true, note: 'Westfall: dry golden lichen and grass on rock tops',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#a89848');
    mottle(g, s, rnd, { colors: ['#c0ae58', '#8a8a40', '#b8a050', '#988a3e'], count: 50, rmin: 8, rmax: 30, alpha: 0.5, hard: 0.3 });
    mottle(g, s, rnd, { colors: ['#d08a40', '#c87a38', '#e0b060'], count: 60, rmin: 3, rmax: 8, alpha: 0.6, hard: 0.6 });
    for (let i = 0; i < 300; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 12, (X, Y) => blade(g, X, Y, range(rnd, 5, 10), range(rnd, -0.6, 0.6), 1.4, pick(rnd, ['#d8c47a', '#b8a050', '#8a7a3a']), 0.8)); }
  }, lumpyMask(80, 6, 24, 0.55, 1.6, 400, '#8a8a8a')),
});
const paintSnow = (g, s, rnd) => {
  fill(g, s, s, '#e6edf4');
  mottle(g, s, rnd, { colors: ['#f6f7f4', '#dce5f0', '#cfdbe8', '#fbfaf4'], count: 60, rmin: 14, rmax: 50, alpha: 0.6, hard: 0.25 });
  for (let i = 0; i < 70; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 6, 16);
    wrap(s, x, y, r * 2, (X, Y) => { blob(g, X + r * 0.4, Y + r * 0.5, r * 1.1, r * 0.6, 0, '#b4c6dc', 0.45, 0.35); blob(g, X - r * 0.2, Y - r * 0.25, r * 0.8, r * 0.55, 0, '#ffffff', 0.7, 0.45); });
  }
  for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 3, (X, Y) => blob(g, X, Y, 1.6, 1.6, 0, '#ffffff', 0.9, 0.7)); }
};
register('cover_snow', {
  family: F, size: 256, alpha: true, note: 'snow on every ledge: white lumps, blue shadow pockets, sparkle (no holes)',
  paint: cover(paintSnow, lumpyMask(70, 16, 48, 0.7, 4), 0.35),
});
register('snow_pack', {
  family: F, size: 256, note: 'opaque packed snow for the snow caps on rocks: soft blue hollows, sparkle',
  paint(g, s, rnd, h, cv) { paintSnow(g, s, rnd); jsBlur(cv, 0.8); },
});
register('cover_dust', {
  family: F, size: 256, alpha: true, note: 'Badlands: ochre dust and grit settled on ledges',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#b8784a');
    mottle(g, s, rnd, { colors: ['#c88a58', '#a86a40', '#d09460', '#9a5e3a'], count: 50, rmin: 10, rmax: 40, alpha: 0.45, hard: 0.2 });
    for (let i = 0; i < 160; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.5, 3.5); wrap(s, x, y, r * 2, (X, Y) => lump(g, X, Y, r, pick(rnd, ['#a86a44', '#d8a070', '#8a5236']), 0.8)); }
  }, lumpyMask(50, 18, 50, 0.6, 5)),
});
register('cover_sand', {
  family: F, size: 256, alpha: true, note: 'Tanaris: pale sand drifted onto rock tops, with ripples',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#d8b884');
    mottle(g, s, rnd, { colors: ['#e2c696', '#c8a872', '#ead2a4', '#c0a06c'], count: 40, rmin: 12, rmax: 50, alpha: 0.45, hard: 0.15 });
    for (let k = 0; k < 18; k++) {
      const f = periodic(rnd, 3, 1, 1), y0 = k * s / 18 + range(rnd, -3, 3);
      const pts = wavy(s, f, 5, y0, false, 10, 6);
      stroke(g, pts.map(([x, y]) => [x, y + 1.6]), 2.2, 2.2, '#b8945e', 0.35);
      stroke(g, pts, 1.6, 1.6, '#fbecc8', 0.5);
    }
  }, lumpyMask(40, 22, 60, 0.6, 6)),
});

// ---- props ------------------------------------------------------------------------------------------

function cactusSkin(g, s, rnd, cv, P) {
    const rib = s / 4;
    for (let x = 0; x < s; x++) {
      const t = ((x % rib) + rib) % rib / rib;                 // 0 crest, 0.5 groove, 1 crest
      const d = Math.abs(t - 0.5) * 2;                         // 1 at crest, 0 in the groove
      const left = t > 0.5;                                    // left flank of the next crest faces the light
      let c = mix(P.groove, P.body, Math.pow(d, 0.75));
      if (d > 0.62) c = mix(c, left ? P.lit : P.side, (d - 0.62) / 0.38 * (left ? 0.95 : 0.5));
      if (d > 0.9 && left) c = mix(c, '#d8d4a0', (d - 0.9) / 0.1 * 0.35);
      g.fillStyle = c; g.fillRect(x, 0, 1, s);
    }
    mottle(g, s, rnd, { colors: P.blot, count: 40, rmin: 10, rmax: 40, alpha: 0.2, hard: 0.15, stretch: 2.5, rot: Math.PI / 2 });
    for (let i = 0; i < 5; i++) { const y = rnd() * s; wrap(s, s / 2, y, s, (X, Y) => blob(g, X, Y, s * 0.7, 5, 0, P.groove, 0.1, 0.3)); }
    // areoles + spines along each crest, hand-placed (jittered, varied)
    for (let k = 0; k < 4; k++) {
      const x0 = k * rib;
      for (let y = range(rnd, 0, 10); y < s - 4; y += range(rnd, 16, 27)) {
        const X0 = x0 + range(rnd, -5, 5), sz = range(rnd, 0.7, 1.25);
        wrap(s, X0, y, 14, (X, Y) => {
          for (let j = 0; j < 3 + Math.floor(rnd() * 4); j++) {
            const a = range(rnd, -2.4, 2.4), L = range(rnd, 4, 10) * sz;
            stroke(g, [[X, Y], [X + Math.sin(a) * L, Y - Math.cos(a) * L]], 1.2, 0.3, '#e8dcb0', 0.8);
          }
          blob(g, X + 0.8, Y + 0.8, 3.2 * sz, 2.6 * sz, 0, '#24382a', 0.4, 0.4);
          ellipse(g, X, Y, 2.4 * sz, 2 * sz, 0, '#cfc29c', 1);
          blob(g, X - 0.6, Y - 0.6, 1.3 * sz, 1.1 * sz, 0, '#fff8e0', 0.8, 0.5);
        });
      }
    }
    glaze(g, s, s, '#fff0c0', 0.1, 'soft-light');
    jsBlur(cv, 0.4);
}
register('cactus_skin', {
  family: F, size: 256, note: 'saguaro: sage-green, 4 ribs per tile (crests at x = 0, 64, 128, 192), areoles with pale spines',
  paint: (g, s, rnd, h, cv) => cactusSkin(g, s, rnd, cv, { groove: '#2c4434', body: '#5e7c48', lit: '#9cb46a', side: '#7a9658', blot: ['#58764a', '#6e8a52', '#4a663e', '#7a9058', '#6a7a4a'] }),
});
register('cactus_dusty', {
  family: F, size: 256, note: 'Badlands organ-pipe cactus: dusty olive with lit crests and cool grooves (same rib layout)',
  paint: (g, s, rnd, h, cv) => cactusSkin(g, s, rnd, cv, { groove: '#424a30', body: '#76824f', lit: '#a6b070', side: '#8a9460', blot: ['#808a56', '#6a7448', '#8e9662', '#74784e', '#9a9a6a'] }),
});

register('hay', {
  family: F, size: 256, note: 'straw: clumped bundles of strands in three values, dark gaps between (strands run across, u)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#9a7834');
    mottle(g, s, rnd, { colors: ['#8a6a30', '#6e5226', '#b08a40', '#c09848'], count: 40, rmin: 16, rmax: 50, alpha: 0.5, hard: 0.1 });
    streaks(g, s, rnd, { colors: ['#6a4e22', '#5e4420'], count: 90, len: [20, 60], width: [1.5, 3], angle: Math.PI / 2, wobble: 0.2, alpha: 0.5 });
    // bundles: a run of parallel strands at a shared slant, lit on top, shadowed under
    const bundle = (x, y, L, a, n, cols) => {
      for (let i = 0; i < n; i++) {
        const oy = (i - n / 2) * 2.2 + range(rnd, -0.6, 0.6), ox = range(rnd, -6, 6), l = L * range(rnd, 0.7, 1.1);
        const pts = []; for (let k = 0; k <= 4; k++) { const t = k / 4; pts.push([x + ox + Math.cos(a) * l * t, y + oy + Math.sin(a) * l * t + Math.sin(t * 3 + i) * 1.2]); }
        const c = i < n * 0.3 ? cols[2] : i > n * 0.75 ? cols[0] : cols[1];
        wrapPts(s, pts, 4, Q => line(g, Q, range(rnd, 1.4, 2.4), jitter(c, rnd, 0.06), 0.95));
      }
    };
    for (let i = 0; i < 130; i++) bundle(rnd() * s, rnd() * s, range(rnd, 40, 90), range(rnd, -0.25, 0.25) + (rnd() < 0.5 ? 0 : Math.PI), 4 + Math.floor(rnd() * 6), [shadowOf('#b88c40', 0.35), '#c49c4c', '#f0d488']);
    for (let i = 0; i < 40; i++) bundle(rnd() * s, rnd() * s, range(rnd, 30, 60), range(rnd, -0.3, 0.3), 3 + Math.floor(rnd() * 3), ['#8a6a30', '#d8b460', '#fff0c0']);
    for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s, a = rnd() * TAU, L = range(rnd, 8, 20); wrapPts(s, [[x, y], [x + Math.cos(a) * L, y + Math.sin(a) * L]], 4, Q => line(g, Q, 1.2, pick(rnd, ['#e8c878', '#7a5a28']), 0.6)); }
    glaze(g, s, s, '#ffd890', 0.12, 'soft-light');
    jsBlur(cv, 0.4);
  },
});

register('hay_end', {
  family: F, size: 256, note: 'round-bale end: a hand-jittered straw spiral, darker core, lit upper-left rim',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8a6a30');
    const c = s / 2, R = s * 0.49, turns = 6.5;
    const gr = g.createRadialGradient(c, c, 0, c, c, R);
    gr.addColorStop(0, '#7a5a28'); gr.addColorStop(0.25, '#b08a40'); gr.addColorStop(0.85, '#c8a050'); gr.addColorStop(1, '#8a6a30');
    g.fillStyle = gr; g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
    const rn = periodic(rnd, 5, 0.9, 2);
    const rad = t => { const f = t / (turns * TAU); return (8 + f * (R - 12)) * (1 + rn((t / TAU) % 1) * 0.08 * Math.min(1, f * 3)); };
    // the spiral's dark gap, broken here and there
    layer(g, s, s, tg => {
      let pts = [];
      for (let t = 0; t < turns * TAU; t += 0.05) {
        pts.push([c + Math.cos(t) * rad(t), c + Math.sin(t) * rad(t)]);
        if (rnd() < 0.012 && pts.length > 4) { line(tg, pts, range(rnd, 2.5, 4), '#4e3818'); pts = []; t += range(rnd, 0.1, 0.4); }
      }
      if (pts.length > 1) line(tg, pts, 3, '#4e3818');
    }, { alpha: 0.6, blur: 0.8 });
    for (let i = 0; i < 1100; i++) {
      const t = rnd() * turns * TAU, r = rad(t) + range(rnd, 2, 9), a = t + range(rnd, -0.05, 0.05);
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r, L = range(rnd, 6, 18);
      const tx = -Math.sin(a), ty = Math.cos(a), lit = -(Math.cos(a) + Math.sin(a)) > 0.3;
      stroke(g, [[x, y], [x + tx * L, y + ty * L]], range(rnd, 1, 2.2), 0.6, pick(rnd, lit ? ['#e8c878', '#f4dc98', '#d8b460', '#fff0c0'] : ['#c09848', '#a88038', '#d8b460', '#8a6a30']), 0.8);
    }
    for (let i = 0; i < 30; i++) {   // broken strands sticking out
      const a = rnd() * TAU, r = range(rnd, 0.3, 0.95) * R, x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      stroke(g, [[x, y], [x + range(rnd, -12, 12), y + range(rnd, -12, 12)]], 1.6, 0.6, pick(rnd, ['#f4dc98', '#c09848']), 0.9);
    }
    const lg = g.createLinearGradient(c - R, c - R, c + R, c + R);
    lg.addColorStop(0, 'rgba(255,240,190,0.3)'); lg.addColorStop(0.5, 'rgba(255,240,190,0)'); lg.addColorStop(1, 'rgba(40,30,60,0.32)');
    g.fillStyle = lg; g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
    glaze(g, s, s, '#ffd890', 0.1, 'soft-light');
    jsBlur(cv, 0.4);
  },
});

register('stump_top', {
  family: F, size: 256, note: 'cut stump: growth rings, sapwood, radial cracks, bark rim; lit upper left',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#4e3a2c');
    const c = s / 2, R = s * 0.43;
    const wob = periodic(rnd, 4, 1.1, 2);
    const ringPath = (r, k = 1) => { g.beginPath(); for (let i = 0; i <= 72; i++) { const a = i / 72 * TAU, rr = r * (1 + wob(i / 72) * 0.05 * k); g.lineTo(c + Math.cos(a) * rr, c + Math.sin(a) * rr); } g.closePath(); };
    ringPath(R * 1.14); g.fillStyle = '#4a3628'; g.fill();
    const gr = g.createRadialGradient(c, c, 0, c, c, R);
    gr.addColorStop(0, '#c8a070'); gr.addColorStop(0.7, '#d4b082'); gr.addColorStop(0.92, '#e0c090'); gr.addColorStop(1, '#a88458');
    ringPath(R); g.fillStyle = gr; g.fill();
    for (let k = 1; k < 16; k++) {
      ringPath(R * k / 16 * range(rnd, 0.97, 1.03), k / 16);
      g.strokeStyle = rgba(k % 3 ? '#9a7448' : '#7a5636', range(rnd, 0.25, 0.45)); g.lineWidth = range(rnd, 1, 2.2); g.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const a = rnd() * TAU, r0 = R * range(rnd, 0.1, 0.4), r1 = R * range(rnd, 0.7, 1.02);
      const pts = []; for (let k = 0; k <= 6; k++) { const r = r0 + (r1 - r0) * k / 6, aa = a + range(rnd, -0.04, 0.04); pts.push([c + Math.cos(aa) * r, c + Math.sin(aa) * r]); }
      stroke(g, pts.map(([x, y]) => [x + 1.2, y + 1.2]), 2.5, 1, '#f0d8a8', 0.4);
      stroke(g, pts, 3, 0.8, '#3e2a22', 0.75);
    }
    blob(g, c, c, 6, 6, 0, '#6a4a30', 0.9, 0.6);
    ringPath(R * 1.07); g.strokeStyle = rgba('#5e4430', 1); g.lineWidth = 11; g.stroke();
    g.save(); ringPath(R * 1.14); g.clip();
    const lg = g.createLinearGradient(c - R, c - R, c + R, c + R);
    lg.addColorStop(0, 'rgba(255,236,190,0.3)'); lg.addColorStop(0.5, 'rgba(255,236,190,0)'); lg.addColorStop(1, 'rgba(40,28,60,0.35)');
    g.fillStyle = lg; g.fillRect(0, 0, s, s); g.restore();
    mottle(g, s, rnd, { colors: ['#8a9a5a', '#6e7e44'], count: 8, rmin: 4, rmax: 10, alpha: 0.3, hard: 0.5 });
    glaze(g, s, s, '#ffe0a8', 0.1, 'soft-light');
    jsBlur(cv, 0.5);
  },
});

register('bone_bleached', {
  family: F, size: 256, note: 'sun-bleached bone (not the town\'s ringed ivory "bone"): cream, fine grain along the bone (v), soft ochre stains, chips with dark edges, faint wavy sutures',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e4d8bc');
    mottle(g, s, rnd, { colors: ['#f2e8cc', '#d4c6a2', '#e8dcc0', '#cdbd98', '#f6eedc'], count: 26, rmin: 24, rmax: 70, alpha: 0.4, hard: 0.08, stretch: 2.5, rot: Math.PI / 2 });
    jsBlur(cv, 3);
    // soft ochre stains, long along the bone
    layer(g, s, s, tg => {
      for (let i = 0; i < 6; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 70, 200), f = periodic(rnd, 2, 1, 1);
        const pts = []; for (let k = 0; k <= 10; k++) pts.push([x + f(k / 10) * 8, y + L * k / 10]);
        wrapPts(s, pts, 16, Q => line(tg, Q, range(rnd, 10, 22), pick(rnd, ['#b89a6a', '#c4a676', '#a88a5e'])));
      }
    }, { alpha: 0.3, blur: 6 });
    // fine grain along the bone
    streaks(g, s, rnd, { colors: ['#c8b894', '#f8f0dc', '#d4c4a0'], count: 140, len: [30, 110], width: [0.7, 1.4], angle: 0, wobble: 0.03, alpha: 0.28 });
    // two faint wavy sutures
    layer(g, s, s, tg => {
      for (let i = 0; i < 2; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 50, 90), f = periodic(rnd, 4, 0.8, 2);
        const pts = []; for (let k = 0; k <= 20; k++) pts.push([x + L * k / 20, y + f(k / 20) * 4]);
        wrapPts(s, pts, 6, Q => { line(tg, Q.map(([u, v]) => [u, v - 1.2]), 1.6, '#fff8e8'); line(tg, Q, 1.4, '#8a765a'); });
      }
    }, { alpha: 0.4, blur: 0.6 });
    // pits
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.2, 2.8);
      wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 1.3, 0, '#9a8466', 0.55); blob(g, X + r * 0.3, Y + r * 0.9, r, r * 0.4, 0, '#fff8e8', 0.45, 0.5); });
    }
    // chips: a lit flake with a dark lower edge
    for (let i = 0; i < 8; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 10), a0 = rnd() * TAU;
      const pts = []; for (let k = 0; k < 5; k++) { const a = a0 + k / 5 * TAU + range(rnd, -0.3, 0.3); pts.push([x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 1.2]); }
      wrapPts(s, pts, 2, Q => { poly(g, Q.map(([u, v]) => [u + 1.2, v + 1.8]), '#6e5a44', 0.5); poly(g, Q, '#f4ead2', 0.7); });
    }
    cracks(g, s, rnd, { color: '#6e5a44', count: 4, len: [16, 40], width: [0.8, 1.4], alpha: 0.4 });
    glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
    jsBlur(cv, 0.45);
  },
});

register('scarecrow', {
  family: F, size: 256, note: 'atlas: burlap head (top half; face at u = 0.5) · plaid shirt · felt hat · rope · patched trousers · straw',
  paint(g, s, rnd, h, cv) {
    // burlap head wrap: rows 0..127, the whole circumference; face centered at x = 128
    g.save(); g.beginPath(); g.rect(0, 0, 256, 128); g.clip();
    fill(g, 256, 128, '#9a7c54');
    mottle0(g, 0, 0, 256, 128, rnd, ['#ac8e62', '#866a46', '#94784e', '#7a6040'], 30, 10, 40, 0.4);
    for (let y = 1; y < 128; y += 3.2) { const pts = []; for (let x = -4; x <= 260; x += 8) pts.push([x, y + Math.sin(x * 0.2 + y) * 0.6]); stroke(g, pts, 1.1, 1.1, '#6a5034', 0.3); }
    for (let x = 1; x < 256; x += 3.2) stroke(g, [[x, 0], [x + 0.6, 128]], 1, 1, '#c4aa7c', 0.18);
    // a sewn-on patch at the back, with its seam
    g.fillStyle = '#7a6a4a'; g.fillRect(14, 30, 34, 30);
    for (let k = 0; k < 34; k += 4) { stroke(g, [[14 + k, 28], [16 + k, 32]], 1.2, 1.2, '#3a2a20', 0.8); stroke(g, [[14 + k, 58], [16 + k, 62]], 1.2, 1.2, '#3a2a20', 0.8); }
    // the face, a little lopsided: one sewn-on button eye, one stitched X
    const ex1 = 108, ey1 = 52;
    ellipse(g, ex1 + 1, ey1 + 2, 10, 10, 0, '#2a2024', 0.45);
    ellipse(g, ex1, ey1, 9, 8.4, 0, '#3a3034', 1);
    blob(g, ex1 - 3, ey1 - 3, 3.5, 2.6, 0, '#8a8080', 0.6, 0.5);
    for (const [dx, dy] of [[-2.5, -2], [2.5, -2], [-2.5, 2], [2.5, 2]]) ellipse(g, ex1 + dx, ey1 + dy, 1.1, 1.1, 0, '#1e1618', 0.9);
    stroke(g, [[ex1 - 2.5, ey1 - 2], [ex1 + 2.5, ey1 + 2]], 1, 1, '#c8b890', 0.8);
    const ex2 = 151, ey2 = 50;
    stroke(g, [[ex2 - 8, ey2 - 7], [ex2 + 8, ey2 + 8]], 3.4, 3.4, '#2a1e1c', 0.95);
    stroke(g, [[ex2 + 8, ey2 - 8], [ex2 - 7, ey2 + 7]], 3.4, 3.4, '#2a1e1c', 0.95);
    // a darker stitched nose patch, off-center grin with cross-stitches
    g.fillStyle = '#6a4a30'; g.beginPath(); g.moveTo(130, 62); g.lineTo(124, 73); g.lineTo(136, 72); g.closePath(); g.fill();
    const grin = []; for (let k = 0; k <= 12; k++) { const t = k / 12; grin.push([106 + t * 44, 86 + Math.sin(t * Math.PI) * 7 + t * 5]); }
    stroke(g, grin, 2.6, 2.6, '#2e2226', 0.95);
    for (let k = 1; k < 12; k += 1.5) { const i = Math.floor(k), [x, y] = grin[i]; stroke(g, [[x - 1.5, y - 5], [x + 1.5, y + 5]], 1.5, 1.5, '#2e2226', 0.85); }
    stroke(g, [[0, 120], [256, 122]], 8, 8, '#7a5e38', 0.9);    // rope at the neck
    for (let x = 0; x < 256; x += 7) stroke(g, [[x, 116], [x + 5, 126]], 2, 2, '#4e3a22', 0.6);
    g.restore();
    // plaid shirt: x 0..128, y 128..192 (u 0..0.5, v 0.25..0.5)
    g.save(); g.beginPath(); g.rect(0, 128, 128, 64); g.clip();
    fill(g, 256, 256, '#9a4636');
    for (let x = 4; x < 128; x += 22) { g.fillStyle = rgba('#542824', 0.45); g.fillRect(x, 128, 8, 64); g.fillStyle = rgba('#e0b080', 0.25); g.fillRect(x + 12, 128, 2, 64); }
    for (let y = 132; y < 192; y += 22) { g.fillStyle = rgba('#542824', 0.4); g.fillRect(0, y, 128, 8); g.fillStyle = rgba('#e0b080', 0.25); g.fillRect(0, y + 12, 128, 2); }
    g.fillStyle = '#5a7088'; g.fillRect(70, 146, 26, 24);
    for (let k = 0; k < 26; k += 5) { stroke(g, [[70 + k, 144], [72 + k, 148]], 1.4, 1.4, '#e8d8b0', 0.8); stroke(g, [[70 + k, 168], [72 + k, 172]], 1.4, 1.4, '#e8d8b0', 0.8); }
    mottle0(g, 0, 128, 128, 64, rnd, ['#6a3a2a', '#c87a5a', '#8a5a3a'], 20, 6, 20, 0.25);
    g.restore();
    // felt hat: x 128..256, y 128..192
    g.save(); g.beginPath(); g.rect(128, 128, 128, 64); g.clip();
    fill(g, 256, 256, '#5a4636');
    mottle0(g, 128, 128, 128, 64, rnd, ['#6e5a48', '#4a3a2e', '#7a6450', '#3e3028'], 30, 6, 22, 0.4);
    g.fillStyle = rgba('#2e2420', 0.85); g.fillRect(128, 174, 128, 10);
    g.restore();
    // rope: x 0..64, y 192..256
    g.save(); g.beginPath(); g.rect(0, 192, 64, 64); g.clip();
    fill(g, 256, 256, '#a88a58');
    for (let x = -64; x < 64; x += 7) { stroke(g, [[x, 256], [x + 64, 192]], 4, 4, '#7a6038', 0.7); stroke(g, [[x + 2, 256], [x + 66, 192]], 1.5, 1.5, '#d8bc88', 0.6); }
    g.restore();
    // patched trousers: x 64..128, y 192..256
    g.save(); g.beginPath(); g.rect(64, 192, 64, 64); g.clip();
    fill(g, 256, 256, '#4e5a6a');
    for (let x = 64; x < 128; x += 2.5) stroke(g, [[x, 192], [x + 3, 256]], 1, 1, '#3a4452', 0.35);
    mottle0(g, 64, 192, 64, 64, rnd, ['#5e6a7a', '#3e4856', '#6a6a5a'], 14, 5, 14, 0.35);
    g.fillStyle = '#8a6a44'; g.fillRect(78, 214, 18, 16);
    for (let k = 0; k < 18; k += 4) { stroke(g, [[78 + k, 212], [80 + k, 216]], 1.2, 1.2, '#e8d8b0', 0.8); stroke(g, [[78 + k, 228], [80 + k, 232]], 1.2, 1.2, '#e8d8b0', 0.8); }
    g.restore();
    // straw: x 128..256, y 192..256
    g.save(); g.beginPath(); g.rect(128, 192, 128, 64); g.clip();
    fill(g, 256, 256, '#b89040');
    for (let i = 0; i < 200; i++) { const x = 128 + rnd() * 128, y = 188 + rnd() * 64; stroke(g, [[x, y], [x + range(rnd, -3, 3), y + range(rnd, 10, 24)]], range(rnd, 1.2, 2.4), 0.6, pick(rnd, ['#e8c878', '#f4dc98', '#a88038', '#7a5a28']), 0.8); }
    g.restore();
    glaze(g, s, s, '#ffe0a8', 0.1, 'soft-light');
  },
});

register('iron', {
  family: F, size: 128, note: 'dark wrought iron, warm: rust blooms and runs, lit scratches (no blue)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a5048');
    mottle(g, s, rnd, { colors: ['#665a50', '#463e3a', '#6e6258'], count: 20, rmin: 8, rmax: 30, alpha: 0.5, hard: 0.15 });
    mottle(g, s, rnd, { colors: ['#8a5a3a', '#9a643c', '#7a4a30'], count: 16, rmin: 4, rmax: 16, alpha: 0.55, hard: 0.3 });
    streaks(g, s, rnd, { colors: ['#8a5a3a'], count: 10, len: [10, 30], width: [2, 4], angle: Math.PI, wobble: 0.1, alpha: 0.35 });
    streaks(g, s, rnd, { colors: ['#a49a8c', '#b8ac98'], count: 14, len: [6, 18], width: [0.6, 1.2], angle: 1.2, wobble: 0.3, alpha: 0.45 });
    jsBlur(cv, 0.5);
  },
});

register('coals', {
  family: F, size: 256, note: 'fire bed: an orange glow pool under chunky charcoal, thin glowing seams in the middle, pale ash at the rim',
  paint(g, s, rnd, h, cv) {
    const c = s / 2;
    fill(g, s, s, '#8a8480');
    // the glow pool
    const gp = g.createRadialGradient(c, c, 0, c, c, s * 0.34);
    gp.addColorStop(0, '#ff9a40'); gp.addColorStop(0.3, '#e8702a'); gp.addColorStop(0.65, '#a03810'); gp.addColorStop(1, 'rgba(60,34,28,0)');
    g.fillStyle = gp; g.fillRect(0, 0, s, s);
    // charcoal lumps, darker and denser toward the middle, each lit on its upper left
    for (let i = 0; i < 150; i++) {
      const a = rnd() * TAU, d = Math.sqrt(rnd()) * s * 0.4, x = c + Math.cos(a) * d, y = c + Math.sin(a) * d, r = range(rnd, 7, 17) * (1 - d / s * 0.6);
      const n = 5 + Math.floor(rnd() * 3), a0 = rnd() * TAU, pts = [];
      for (let k = 0; k < n; k++) { const aa = a0 + k / n * TAU, rr = r * range(rnd, 0.7, 1.1); pts.push([x + Math.cos(aa) * rr, y + Math.sin(aa) * rr * 0.8]); }
      const col = pick(rnd, ['#2a2220', '#3a2e28', '#322824', '#46382e']);
      poly(g, pts, col, 0.95);
      blob(g, x - r * 0.3, y - r * 0.35, r * 0.6, r * 0.4, 0, '#6a5a50', 0.5, 0.3);
      if (d < s * 0.22) blob(g, x + r * 0.2, y + r * 0.3, r * 0.5, r * 0.35, 0, '#c85a1c', 0.35, 0.4);
    }
    // thin soft glowing seams, only near the centre
    g.save(); g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      let x = c + range(rnd, -40, 40), y = c + range(rnd, -34, 34), a = rnd() * TAU; const pts = [[x, y]];
      for (let k = 0; k < 4; k++) { a += range(rnd, -0.8, 0.8); x += Math.cos(a) * range(rnd, 6, 14); y += Math.sin(a) * range(rnd, 6, 14); pts.push([x, y]); }
      line(g, pts, 1.8, '#ff7a24', 0.35); line(g, pts, 0.8, '#ffd080', 0.4);
    }
    for (let i = 0; i < 10; i++) blob(g, c + range(rnd, -30, 30), c + range(rnd, -26, 26), range(rnd, 5, 10), range(rnd, 4, 8), 0, pick(rnd, ['#ff9a30', '#ffc860']), 0.18, 0.3);
    g.restore();
    // pale ash toward the rim
    const ash = g.createRadialGradient(c, c, s * 0.24, c, c, s * 0.5);
    ash.addColorStop(0, 'rgba(138,132,128,0)'); ash.addColorStop(0.55, 'rgba(138,132,128,0.7)'); ash.addColorStop(1, 'rgba(110,104,100,1)');
    g.fillStyle = ash; g.fillRect(0, 0, s, s);
    mottle(g, s, rnd, { colors: ['#9a948e', '#6a6462', '#b0aaa4', '#4a4442'], count: 70, rmin: 2, rmax: 7, alpha: 0.4, hard: 0.5 });
  },
});

// Broad teardrop tongues (never a porcupine of spikes): a deep red-brown outer flame, orange, then a
// yellow-white core, each a fat rounded body narrowing to a curling tip.
function tongue(g, x, by, W, H, lean, curl, color, alpha) {
  g.save(); g.globalAlpha = alpha; g.fillStyle = color;
  g.beginPath(); g.moveTo(x - W * 0.5, by);
  g.bezierCurveTo(x - W * 0.62, by - H * 0.35, x - W * 0.2 + lean * H * 0.3, by - H * 0.7, x + lean * H + curl, by - H);
  g.bezierCurveTo(x + W * 0.25 + lean * H * 0.3, by - H * 0.65, x + W * 0.62, by - H * 0.35, x + W * 0.5, by);
  g.closePath(); g.fill(); g.restore();
}
register('flame', {
  family: F, size: 256, alpha: true, note: 'campfire flame: 4 frames (2×2), broad teardrop tongues: red-brown tips → orange → yellow-white core, additive',
  paint(g, s, rnd) {
    for (let fi = 0; fi < 4; fi++) {
      const ox = (fi % 2) * 128, oy = Math.floor(fi / 2) * 128, cx = ox + 64, by = oy + 124;
      g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, 124, 124); g.clip();
      blob(g, cx, by - 20, 52, 34, 0, '#a03a1a', 0.35, 0.05);
      const T = [[-20, 0.75, -0.18], [18, 0.8, 0.16], [0, 1, 0.02 * (fi - 1.5)]];
      if (fi % 2) T.push([-6, 0.6, -0.3]); else T.push([10, 0.55, 0.3]);
      for (const [dx, hk, lean] of T) {
        const x = cx + dx + range(rnd, -3, 3), H = 112 * hk * range(rnd, 0.88, 1.05), curl = range(rnd, -8, 8);
        tongue(g, x, by, 46 * (0.6 + 0.4 * hk), H, lean, curl, '#a03a1a', 0.7);
        tongue(g, x + 1, by - 2, 36 * (0.6 + 0.4 * hk), H * 0.82, lean * 0.9, curl * 0.8, '#e06a24', 0.8);
        tongue(g, x + 1, by - 3, 28 * (0.6 + 0.4 * hk), H * 0.62, lean * 0.8, curl * 0.6, '#f0902c', 0.85);
        tongue(g, x + 1, by - 4, 18 * (0.6 + 0.4 * hk), H * 0.42, lean * 0.6, curl * 0.4, '#ffd070', 0.9);
        tongue(g, x + 1, by - 4, 10 * (0.6 + 0.4 * hk), H * 0.25, lean * 0.5, 0, '#fff2c0', 0.95);
      }
      g.restore();
    }
  },
});

register('smoke', {
  family: F, size: 128, alpha: true, note: 'a faint smoke wisp rising from the fire (normal blend)',
  paint(g, s, rnd) {
    for (let i = 0; i < 26; i++) {
      const t = i / 26, x = s / 2 + Math.sin(t * 5) * 14 * t + range(rnd, -6, 6), y = s - 10 - t * (s - 24), r = 8 + t * 22;
      blob(g, x, y, r, r * 0.8, 0, pick(rnd, ['#5a5452', '#6a6462', '#4a4644']), 0.12 * (1 - t * 0.6), 0.1);
    }
  },
});

register('spark', {
  family: F, size: 32, alpha: true, note: 'a soft glowing dot (embers)',
  paint(g, s) {
    blob(g, s / 2, s / 2, s * 0.48, s * 0.48, 0, '#ffb050', 0.6, 0.1);
    blob(g, s / 2, s / 2, s * 0.22, s * 0.22, 0, '#fff0c0', 1, 0.4);
  },
});
