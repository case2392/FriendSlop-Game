// Texture family: terrain. See docs/ART.md for the style rules.
//
// Per biome b in meadow | fields | snow | badlands | desert:
//   ground_<b>    the main ground (512, world-space, ~7 m a tile)
//   ground2_<b>   a second ground, blended in by large-scale noise
//   dirt_<b>      bare packed dirt (camp clearings, yards, the town square)
//   road_<b>      the dirt road in ROAD SPACE: x runs across the road (edge to edge, plus a
//                 grassy shoulder), y runs along it; each biome's road is painted differently
//   cliff_<b>     steep faces, projected from the side (y = world height, so strata stay level):
//                 rounded granite masses (meadow, fields), angular fractured granite (snow; the crash
//                 mesas keep rounded blocks in cliff_snow_mesa), strata (badlands), thick sandstone
//                 beds (desert); cliff_snow_form / cliff_snow_mesa_form hold the granites' form
//   clutter_<b>   4×2 alpha atlas of ground-clutter cards (tufts, flowers, wheat, twigs, drifts)
//   sky_clouds_<b> the painted cloud band around the sky dome (alpha), its own sky per biome
//   sky_mtn_<b>   3 rows of distant land silhouettes (far, mid, near) for the horizon rings
// Shared: mud (slush, mud_badlands, mud_desert: road space, puddles along the wheel tracks),
// terrain_macro (RGB low-frequency variation, not color), terrain_detail (RGB near-field detail
// multiplied in at the camera's feet: grass blades, grit and pebbles, fine ripples and crust).
// Packed earth (roads, clearings, worn ground) is a soft painted relief with lengthwise streaks,
// never a mosaic of cells; hardpan cracks into plates only in a few soft-edged patches.
//
// The readable unit of a ground is the CLUMP (20-40 cm: a cluster of blades, a clod, a drift, a
// ripple), painted with value contrast so it survives the mipmaps at 10-40 m. Stones come in
// clusters, cracks as open networks, grass as V-shaped clusters of short blades.
import {
  register, fill, mottle, blade, stroke, cracks, glaze, blurTile, range, pick, wrap, blob, ellipse,
  mix, shade, lightOf, shadowOf, jitter, hex, rgba, makeCanvas, worley, streaks, canvasFor,
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

// A tapered, curved blade as ONE filled polygon (fast; core's blade() fills every segment).
function blade2(g, x, y, len, ang, w, color, bend = 0.25) {
  const n = 5, Lp = [], Rp = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = ang + bend * t * t, hw = w * 0.5 * (1 - t * 0.88);
    const px = x + Math.sin(a) * len * t, py = y - Math.cos(a) * len * t, nx = Math.cos(a), ny = Math.sin(a);
    Lp.push(px + nx * hw, py + ny * hw); Rp.push(px - nx * hw, py - ny * hw);
  }
  g.fillStyle = color; g.beginPath(); g.moveTo(Lp[0], Lp[1]);
  for (let i = 2; i < Lp.length; i += 2) g.lineTo(Lp[i], Lp[i + 1]);
  for (let i = Rp.length - 2; i >= 0; i -= 2) g.lineTo(Rp[i], Rp[i + 1]);
  g.closePath(); g.fill();
}

// Grass blades scattered everywhere: n blades, colors, length/width ranges.
// Each pass is painted at full strength into a layer and laid down once at alpha, so a blade's
// overlapping segments never bead up into dots.
function bladePass(g, s, rnd, n, cols, len, wid, alpha, ang = [-0.45, 0.55], bend = [-0.3, 0.4], where = null) {
  const Ly = makeCanvas(s), lg = Ly.getContext('2d');
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s;
    if (where && !where(x, y)) continue;
    const L = range(rnd, len[0], len[1]), a = range(rnd, ang[0], ang[1]), w = range(rnd, wid[0], wid[1]), c = pick(rnd, cols), b = range(rnd, bend[0], bend[1]);
    wrap(s, x, y, L + 2, (xx, yy) => blade2(lg, xx, yy, L, a, w, c, b));
  }
  g.save(); g.globalAlpha = alpha; g.drawImage(Ly, 0, 0); g.restore();
}

// Lay a full-strength layer down at alpha (strokes painted into it never bead where they overlap).
function layered(g, s, alpha, fn) {
  const Ly = makeCanvas(s), lg = Ly.getContext('2d');
  fn(lg);
  g.save(); g.globalAlpha = alpha; g.drawImage(Ly, 0, 0); g.restore();
}

// Wrapped separable box blur on the pixel data (running sums), n passes of radius r, mixed in by k.
// Stands in for blurTile (a canvas filter over a 3×3 tiling), which costs ten times as much.
function blurWrap(cv, r, n = 2, k = 1) {
  const s = cv.width, h = cv.height, g = cv.getContext('2d'), img = g.getImageData(0, 0, s, h), D = img.data;
  const A = new Float32Array(D.length), B = new Float32Array(D.length);
  for (let i = 0; i < D.length; i++) A[i] = D[i];
  const inv = 1 / (2 * r + 1);
  for (let p = 0; p < n; p++) {
    for (let y = 0; y < h; y++) {                      // rows: A -> B
      const row = y * s * 4;
      for (let c = 0; c < 4; c++) {
        let acc = 0;
        for (let i = -r; i <= r; i++) acc += A[row + (((i % s) + s) % s) * 4 + c];
        for (let x = 0; x < s; x++) {
          B[row + x * 4 + c] = acc * inv;
          let xa = x + r + 1, xb = x - r; if (xa >= s) xa -= s; if (xb < 0) xb += s;
          acc += A[row + xa * 4 + c] - A[row + xb * 4 + c];
        }
      }
    }
    const W4 = s * 4, acc = new Float32Array(W4);         // columns: B -> A, row-major with a running row of sums
    for (let i = -r; i <= r; i++) { const row = (((i % h) + h) % h) * W4; for (let q = 0; q < W4; q++) acc[q] += B[row + q]; }
    for (let y = 0; y < h; y++) {
      const row = y * W4;
      let ya = y + r + 1, yb = y - r; if (ya >= h) ya -= h; if (yb < 0) yb += h;
      const ra = ya * W4, rb = yb * W4;
      for (let q = 0; q < W4; q++) { A[row + q] = acc[q] * inv; acc[q] += B[ra + q] - B[rb + q]; }
    }
  }
  for (let i = 0; i < D.length; i++) D[i] += (A[i] - D[i]) * k;
  g.putImageData(img, 0, 0);
  return cv;
}
// A light final softening (one radius-1 pass, half strength): blurTile at sub-pixel radii.
const soften = (cv, k = 0.5) => blurWrap(cv, 1, 1, k);

// Wrapped distance-falloff mask around a set of [x, y, r] cores: 0..1.
function coreMask(s, cores, sx = 1, sy = 1) {
  return (x, y) => {
    let b = 0;
    for (const [cx, cy, r] of cores) {
      let dx = Math.abs(x - cx), dy = Math.abs(y - cy); dx = Math.min(dx, s - dx); dy = Math.min(dy, s - dy);
      b = Math.max(b, 1 - Math.hypot(dx * sx, dy * sy) / r);
    }
    return Math.max(0, b);
  };
}

// An irregular lump seen from above (a clod, a pebble, a plate, a lump of snow) with the light
// painted in: a soft cast shadow to the lower right, the body, a lit upper-left side and a shaded
// lower-right side, clipped to its own outline so the light never spills.
function lump(g, s, x, y, r, rnd, { color, lit = null, shade: dk = null, shadow = '#2a1e22', shadowA = 0.45, sq = 0.8, sides = 7, jag = 0.28, litA = 0.8, shadeA = 0.65 }) {
  const rot = rnd() * TAU, pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (i + range(rnd, -0.3, 0.3)) / sides * TAU, rr = r * (1 - jag + rnd() * jag * 2);
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr * sq;
    pts.push([px * Math.cos(rot) - py * Math.sin(rot), px * Math.sin(rot) + py * Math.cos(rot)]);
  }
  const L = lit || lightOf(color, 0.45), D = dk || shadowOf(color, 0.4);
  wrap(s, x, y, r * 1.8, (X, Y) => {
    if (shadowA > 0) blob(g, X + r * 0.3, Y + r * 0.38, r * 1.2, r * 1.05, 0, shadow, shadowA, 0.4);
    g.save();
    g.beginPath(); pts.forEach(([u, v], i) => (i ? g.lineTo(X + u, Y + v) : g.moveTo(X + u, Y + v))); g.closePath();
    g.fillStyle = color; g.fill();
    g.clip();
    blob(g, X + r * 0.55, Y + r * 0.6, r * 1.05, r * 0.95, 0, D, shadeA, 0.35);
    blob(g, X - r * 0.45, Y - r * 0.5, r * 0.9, r * 0.8, 0, L, litA, 0.3);
    g.restore();
  });
}
function lumps(g, s, rnd, n, { r, colors, where = null, ...o }) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s;
    if (where && rnd() > where(x, y)) continue;
    lump(g, s, x, y, range(rnd, r[0], r[1]), rnd, { color: jitter(pick(rnd, colors), rnd, 0.06), ...o });
  }
}

// Clumped grass. Each clump is a fan of wide blades from a dark root to a lit tip (lighter on its
// upper-left side, darker on its right), over a soft cool shadow cast to the lower right. All the
// shadows go down first (one layer), then the clumps back to front.
function grassTufts(g, s, rnd, n, { r = [9, 20], blades = [6, 12], len = [12, 26], wid = [3, 5], root, body, tip, shadow = '#24361a', shadowA = 0.35, lean = [-0.15, 0.45], where = null, bend = 0.3, at = null }) {
  const C = [];
  if (at) for (const [x, y] of at) C.push({ x, y, R: range(rnd, r[0], r[1]), b: pick(rnd, body), t: pick(rnd, tip), lean: range(rnd, lean[0], lean[1]) });
  else for (let i = 0; i < n * 4 && C.length < n; i++) {
    const x = rnd() * s, y = rnd() * s;
    if (where && rnd() > where(x, y)) continue;
    C.push({ x, y, R: range(rnd, r[0], r[1]), b: pick(rnd, body), t: pick(rnd, tip), lean: range(rnd, lean[0], lean[1]) });
  }
  C.sort((a, b) => a.y - b.y);
  if (shadowA > 0) layered(g, s, shadowA, lg => {
    for (const c of C) wrap(s, c.x, c.y, c.R * 2.2, (X, Y) => blob(lg, X + c.R * 0.45, Y + c.R * 0.2, c.R * 1.3, c.R * 0.75, 0.3, shadow, 1, 0.45));
  });
  for (const c of C) {
    const k = Math.round(range(rnd, blades[0], blades[1])), B = [];
    for (let j = 0; j < k; j++) {
      const t = range(rnd, -1, 1);
      B.push({ t, dy: range(rnd, -0.25, 0.25) * c.R, a: c.lean + t * 0.55 + range(rnd, -0.15, 0.15), L: range(rnd, len[0], len[1]), w: range(rnd, wid[0], wid[1]), bend: range(rnd, -bend, bend) });
    }
    B.sort((a, b) => a.dy - b.dy);
    for (const bl of B) {
      const bx = c.x + bl.t * c.R * 0.8, by = c.y + bl.dy + c.R * 0.2;
      const L = bl.L * (1 - Math.abs(bl.t) * 0.3) * (0.6 + 0.5 * c.R / r[1]);
      const bc = bl.t > 0.35 ? shadowOf(c.b, 0.2) : c.b;
      const tc = mix(c.b, c.t, Math.max(0.12, Math.min(1, 0.62 - bl.t * 0.5)));
      const ex = Math.sin(bl.a) * L, ey = -Math.cos(bl.a) * L;
      wrap(s, bx, by, L + bl.w, (X, Y) => {
        const gr = g.createLinearGradient(X, Y, X + ex, Y + ey);
        gr.addColorStop(0, root); gr.addColorStop(0.42, bc); gr.addColorStop(1, tc);
        blade2(g, X, Y, L, bl.a, bl.w, gr, bl.bend);
      });
    }
  }
}

// A mid-scale mass field (0..1): where the clumps crowd together and catch the light (1), and the
// dark hollows between them (0). Features of ~40-90 px, so they survive the mipmaps.
function massField(rnd, s, g0 = 6, sharp = 2.2) {
  const F = fbmLo(rnd, s, 3, g0, 0.55);
  for (let i = 0; i < F.length; i++) F[i] = sst(-0.5 / sharp, 0.5 / sharp, F[i]);
  const f = (x, y) => F[(((Math.floor(y) % s) + s) % s) * s + (((Math.floor(x) % s) + s) % s)];
  f.F = F;
  return f;
}
// Tone the canvas by a 0..1 field: toward `dark` where it is low, toward `lit` where it is high.
function toneBy(g, s, F, dark, lit, da, la) {
  const img = g.getImageData(0, 0, s, s), D = img.data, Dk = hex(dark), Lt = hex(lit);
  for (let i = 0; i < F.length; i++) {
    const m = F[i], o = i * 4, a = (1 - m) * da, b = m * la;
    D[o] += (Dk.r - D[o]) * a; D[o + 1] += (Dk.g - D[o + 1]) * a; D[o + 2] += (Dk.b - D[o + 2]) * a;
    D[o] += (Lt.r - D[o]) * b; D[o + 1] += (Lt.g - D[o + 1]) * b; D[o + 2] += (Lt.b - D[o + 2]) * b;
  }
  g.putImageData(img, 0, 0);
}

// Bilinear, wrapped upsample of an n×n field to s×s (low-frequency fields are computed small).
function upsample(F, n, s) {
  if (n === s) return F;
  const O = new Float32Array(s * s), k = n / s;
  for (let y = 0; y < s; y++) {
    const fy = y * k, j0 = Math.floor(fy), ty = fy - j0, j1 = (j0 + 1) % n;
    for (let x = 0; x < s; x++) {
      const fx = x * k, i0 = Math.floor(fx), tx = fx - i0, i1 = (i0 + 1) % n;
      const a = F[j0 * n + i0], b = F[j0 * n + i1], c = F[j1 * n + i0], d = F[j1 * n + i1];
      O[y * s + x] = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
    }
  }
  return O;
}
// A low-frequency tileable fbm field, computed at n px and upsampled (same randoms as fbmField).
function fbmLo(rnd, s, oct, g0, gain = 0.5, aniso = 1, n = 128) {
  const m = Math.min(s, n);
  return upsample(fbmField(rnd, m, oct, g0, gain, aniso), m, s);
}

// Per-pixel shading of a height field H (s×s, wrapped) into the canvas: lit toward `lit` on
// faces turned to the upper-left light, toward `dark` on faces turned away. mask (0..1) scales it.
function shadeHeight(g, s, H, { k = 1, lit, dark, litA = 0.7, darkA = 0.8, mask = null, flatLit = 0 }) {
  const img = g.getImageData(0, 0, s, s), D = img.data;
  const Lc = hex(lit), Dc = hex(dark);
  const Lx = -0.5, Ly = -0.62, Lz = 0.6, Ll = Math.hypot(Lx, Ly, Lz);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = y * s + x;
    const hx = (H[y * s + (x + 1) % s] - H[y * s + (x - 1 + s) % s]) * 0.5 * k;
    const hy = (H[((y + 1) % s) * s + x] - H[((y - 1 + s) % s) * s + x]) * 0.5 * k;
    const nl = Math.hypot(hx, hy, 1);
    const dif = (-hx * Lx - hy * Ly + Lz) / (nl * Ll) - Lz / Ll + flatLit;   // 0 on flat ground
    const m = mask ? mask[i] : 1;
    const o = i * 4;
    if (dif > 0) { const a = Math.min(litA, dif * 2.2) * m; D[o] += (Lc.r - D[o]) * a; D[o + 1] += (Lc.g - D[o + 1]) * a; D[o + 2] += (Lc.b - D[o + 2]) * a; }
    else { const a = Math.min(darkA, -dif * 2.2) * m; D[o] += (Dc.r - D[o]) * a; D[o + 1] += (Dc.g - D[o + 1]) * a; D[o + 2] += (Dc.b - D[o + 2]) * a; }
  }
  g.putImageData(img, 0, 0);
}

// Wind ripples as a height field: broad windward faces rising to a sharp crest, then a short steep
// lee. Bent by low-frequency warp, faded in and out by a mask so crests break and end.
// period divides s, so the field tiles; tilt = whole periods of drift across the tile.
function rippleHeight(rnd, s, { per = 18, warp = 22, warp2 = 5, tilt = 1, lee = 0.24, fade = [-0.35, 0.3], floor = 0.12 }) {
  const P = s / per;
  const W1 = fbmLo(rnd, s, 3, 3, 0.5), W2 = fbmLo(rnd, s, 2, 10, 0.5), M = fbmLo(rnd, s, 3, 4, 0.55);
  const H = new Float32Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = y * s + x;
    const ph = (y + W1[i] * warp + W2[i] * warp2 + x * tilt * P / s) / P;
    const f = ph - Math.floor(ph);
    const p = f < 1 - lee ? Math.pow(f / (1 - lee), 1.4) : Math.pow(1 - (f - (1 - lee)) / lee, 1.5);
    H[i] = p * (floor + (1 - floor) * sst(fade[0], fade[1], M[i])) * P * 0.5;
  }
  return H;
}

// Snow drifts as a height field: crescent ridges with a long windward slope and a short steep lee,
// so the lit face meets the blue lee in a crisp crest line.
function driftHeight(rnd, s, n, { len = [80, 200], wind = [30, 80], lee = [8, 16], amp = [8, 16], ang = [-0.35, 0.35], curve = 1, endTaper = 30 }) {
  const H = new Float32Array(s * s);
  for (let d = 0; d < n; d++) {
    const cx = rnd() * s, cy = rnd() * s, Lc = range(rnd, len[0], len[1]) / 2, Lw = range(rnd, wind[0], wind[1]), Ll = range(rnd, lee[0], lee[1]);
    const A = range(rnd, amp[0], amp[1]), th = range(rnd, ang[0], ang[1]), cu = range(rnd, -1, 1) * 0.6 * curve / Lc;
    const c = Math.cos(th), sn = Math.sin(th);
    const R = Math.ceil(Math.max(Lc, Lw) + 4);
    for (let oy = -R; oy <= R; oy++) for (let ox = -R; ox <= R; ox++) {
      const v = ox * c + oy * sn, u0 = -ox * sn + oy * c;      // v along the crest, u across (+u = lee side)
      if (Math.abs(v) >= Lc) continue;
      const u = u0 - cu * v * v;
      // an elliptic footprint (rounded ends, never a thin tail), the height tapering over the last endTaper px
      const ef = Math.sqrt(Math.max(0, 1 - (v / Lc) * (v / Lc))), lw = Lw * (0.35 + 0.65 * ef), ll = Ll * (0.5 + 0.5 * ef);
      if (u < -lw || u > ll) continue;
      const p = u < 0 ? Math.pow(1 + u / lw, 1.6) : Math.pow(1 - u / ll, 2);
      const wv = sst(Lc, Lc - Math.min(endTaper, Lc * 0.6), Math.abs(v)) * (0.7 + 0.3 * ef);
      const x = ((Math.round(cx) + ox) % s + s) % s, y = ((Math.round(cy) + oy) % s + s) % s;
      H[y * s + x] += A * p * wv;
    }
  }
  return H;
}

// Wheel ruts running along y at x = x0 (road space): a soft compacted band, a dark wet bottom, a
// shaded left wall and a lit right rim (light from the upper left), wobbling on two octaves.
function rut(g, s, rnd, x0, w, P) {
  const wob = periodic(rnd, 3, 1.3, 1), wob2 = periodic(rnd, 4, 0.9, 4);
  const pts = k => { const out = []; for (let y = -24; y <= s + 24; y += 8) out.push([x0 + k + wob(y / s) * 8 + wob2(y / s) * 3, y]); return out; };
  layered(g, s, 0.32, lg => stroke(lg, pts(0), w * 1.9, w * 1.9, P.rut, 1));
  layered(g, s, 0.45, lg => stroke(lg, pts(0.1 * w), w * 0.95, w * 0.95, P.rut, 1));
  layered(g, s, 0.5, lg => stroke(lg, pts(0.05 * w), w * 0.42, w * 0.42, P.rutDark, 1));
  layered(g, s, 0.38 * (P.rimA ?? 1), lg => stroke(lg, pts(-w * 0.42), w * 0.3, w * 0.3, shadowOf(P.rutDark, 0.2), 1));
  layered(g, s, 0.55 * (P.rimA ?? 1), lg => stroke(lg, pts(w * 0.58), w * 0.34, w * 0.34, P.rutLit, 1));
  return y => x0 + wob(y / s) * 8 + wob2(y / s) * 3;
}

// The road, in road space. Across: x = 0 and x = s are 5 m from the centerline; the driven
// surface ends ~3 m out (x ≈ 102 / 410). Packed dirt is painted as clods, not airbrush.
function paintRoad(g, s, rnd, P) {
  const c = s / 2, mpx = s / 10;
  fill(g, s, s, P.base);
  mottle(g, s, rnd, { colors: P.blot, count: 50, rmin: 36, rmax: 120, alpha: 0.4, hard: 0.12, stretch: 1.8, rot: Math.PI / 2 });
  // cross profile: the crown is lighter and drier, the edges darker and softer
  const gr = g.createLinearGradient(0, 0, s, 0);
  gr.addColorStop(0, rgba(P.edge, 0.6)); gr.addColorStop(0.18, rgba(P.edge, 0.15)); gr.addColorStop(0.3, rgba(P.base, 0));
  gr.addColorStop(0.7, rgba(P.base, 0)); gr.addColorStop(0.82, rgba(P.edge, 0.15)); gr.addColorStop(1, rgba(P.edge, 0.6));
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  const crown = g.createLinearGradient(0, 0, s, 0);
  crown.addColorStop(0.36, rgba(P.crown, 0)); crown.addColorStop(0.5, rgba(P.crown, 0.3)); crown.addColorStop(0.64, rgba(P.crown, 0));
  g.fillStyle = crown; g.fillRect(0, 0, s, s);
  blurWrap(g.canvas, 2);
  // where clods and grit gather: on the crown and toward the edges, little in the ruts
  const ruts = [c - 1.05 * mpx, c + 1.05 * mpx];
  const dens = x => { const d = Math.abs(x - c) / mpx; return d < 0.5 ? 0.85 : d < 1.45 ? 0.25 : d < 3.2 ? 0.75 : 0.9; };
  if (P.clods !== 0) {
    // a mid-scale lie of the surface: worn lighter tracks and darker damp patches
    const M = massField(rnd, s, 6, 1.4);
    toneBy(g, s, M.F, shadowOf(P.base, 0.3), lightOf(P.base, 0.25), 0.35, 0.3);
    lumps(g, s, rnd, P.clods ?? 380, { r: P.clodR || [4, 10], colors: P.clod, where: x => dens(x), shadow: P.gap, shadowA: 0.6, sq: 0.7, litA: 0.85, shadeA: 0.7 });
  }
  if (P.before) P.before(g, s, rnd, c, mpx);
  const rx = ruts.map(x0 => rut(g, s, rnd, x0, (P.rutW ?? 0.55) * mpx, P));
  // grit and pebbles, each with its own little shadow
  lumps(g, s, rnd, P.pebN ?? 260, { r: [1.2, 2.6], colors: P.peb, where: x => dens(x), shadow: P.gap, shadowA: 0.55, sides: 6, litA: 0.85, shadeA: 0.55 });
  lumps(g, s, rnd, P.stoneN ?? 22, { r: [3.5, 6.5], colors: P.peb, where: x => dens(x) * 0.9, shadow: P.gap, shadowA: 0.5, sides: P.angular ? 5 : 7, jag: P.angular ? 0.35 : 0.25 });
  if (P.extra) P.extra(g, s, rnd, c, mpx, rx);
  glaze(g, s, s, P.glaze || '#ffdca0', 0.08, 'soft-light');
  soften(g.canvas, 0.5);
}

// Ragged grass creeping in from the road's edges (and a grassy crown strip between the ruts).
function roadGrass(g, s, rnd, c, mpx, G, { crown = true, edgeN = 150, crownN = 70, fine = true, fineN = 900, crownOn = 1 } = {}) {
  const ragL = periodic(rnd, 6, 0.8, 2), ragR = periodic(rnd, 6, 0.8, 2), ragC = periodic(rnd, 5, 0.8, 3), onC = periodic(rnd, 4, 0.8, 1);
  const edge = (x, y) => {
    const l = c - (2.85 + ragL(y / s) * 0.5) * mpx, r = c + (2.85 + ragR(y / s) * 0.5) * mpx;
    return x < l ? 1 : x > r ? 1 : x < l + 18 || x > r - 18 ? 0.35 : 0;
  };
  const strip = (x, y) => { const w = (0.32 + ragC(y / s) * 0.14) * mpx, on = sst(1 - crownOn * 2 - 0.1, 1 - crownOn * 2 + 0.1, onC(y / s)); return Math.abs(x - c) < w ? (1 - Math.abs(x - c) / w * 0.5) * on : 0; };
  grassTufts(g, s, rnd, edgeN, { r: [8, 16], blades: [6, 10], len: [12, 22], wid: [2.6, 4.2], root: G.root, body: G.body, tip: G.tip, shadow: G.shadow, shadowA: 0.35, where: edge, lean: [-0.4, 0.4] });
  if (crown) grassTufts(g, s, rnd, crownN, { r: [6, 12], blades: [5, 9], len: [10, 18], wid: [2.4, 3.8], root: G.root, body: G.body, tip: G.tip, shadow: G.shadow, shadowA: 0.3, where: strip, lean: [-0.4, 0.4] });
  if (fine) bladePass(g, s, rnd, fineN, G.body, [6, 12], [1.6, 2.6], 0.7, [-0.5, 0.5], [-0.2, 0.3], (x, y) => edge(x, y) > 0.3 || (crown && strip(x, y) > 0.5));
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
function powerAt(C, s, u, v, out, rad = 2) {
  const { seeds, cx, cy, cw, ch } = C;
  const ci = Math.floor(u / cw), cj = Math.floor(v / ch);
  let b1 = 1e18, b2 = 1e18, i1 = 0, i2 = 0, x1 = 0, y1 = 0, x2 = 0, y2 = 0;
  for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
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
  const PV = new Float32Array(N), CAP = new Float32Array(N), CAPSH = new Float32Array(N);
  // each facet is painted as a plane of one tone: its light from its own normal (no height step,
  // so the borders between planes are value changes, not outlines)
  const Lx = -0.48, Ly = -0.66, Lz = 0.58, Ll = Math.hypot(Lx, Ly, Lz);
  const facetLight = (gx, gy) => { const l = Math.hypot(gx, gy, 1); return (-gx * Lx - gy * Ly + Lz) / (l * Ll); };
  const F0 = P.facets[0], F1 = P.facets[1];
  const lean = F => r => ({ d: r(), gx: range(r, -F.tilt, F.tilt), gy: range(r, F.lean[0], F.lean[1]) * F.tilt, cr: r() });
  const C0 = powerCells(rnd, s, F0.cells[0], F0.cells[1], 0.95, F0.w, lean(F0));
  const C1 = F1 ? powerCells(rnd, s, F1.cells[0], F1.cells[1], 0.95, F1.w, lean(F1)) : null;
  // the low-frequency fields are computed at 128 px and upsampled (most of the paint time otherwise)
  const WX = fbmLo(rnd, s, 3, 3, 0.5), WY = fbmLo(rnd, s, 3, 3, 0.5);
  const WX2 = fbmLo(rnd, s, 2, 9, 0.5), WY2 = fbmLo(rnd, s, 2, 9, 0.5);
  const BROKEN = fbmLo(rnd, s, 3, 3, 0.55), CFADE = fbmLo(rnd, s, 3, 6, 0.55);
  const BU = fbmLo(rnd, s, 3, 2, 0.5);
  const DET = fbmField(rnd, s, 2, 26, 0.5, 0.6);
  // partial shelves: each spans part of the width, wanders up and down, has its own depth
  const shelves = [];
  for (let i = 0; i < (P.shelfN ?? 0); i++) shelves.push({
    y: (i + rnd() * 0.8) / P.shelfN * s, wob: periodic(rnd, 4, 1.1, 1), wob2: periodic(rnd, 3, 0.9, 5), amp: range(rnd, 6, 22),
    cx: (i * 0.618 + rnd() * 0.25) % 1, span: range(rnd, P.span?.[0] ?? 0.16, P.span?.[1] ?? 0.42), h: range(rnd, 0.5, 1) * P.shelfH, w: range(rnd, 1.5, 3.5), th: range(rnd, 8, 26),
    cap: P.cap ? range(rnd, P.cap[0], P.cap[1]) : 0, lumpy: periodic(rnd, 6, 0.7, 3) });
  for (const L of shelves) {           // everything about a shelf that depends only on x, per column
    L.Y = new Float32Array(s); L.WIN = new Float32Array(s); L.CH = new Float32Array(s);
    for (let x = 0; x < s; x++) {
      let dxw = x / s - L.cx; dxw -= Math.round(dxw);
      const win = sst(L.span, L.span * 0.45, Math.abs(dxw));
      L.WIN[x] = win; L.Y[x] = L.y + L.wob(x / s) * L.amp + L.wob2(x / s) * L.amp * 0.35;
      L.CH[x] = L.cap * (0.62 + 0.38 * L.lumpy(x / s)) * Math.sqrt(win);
    }
  }
  // strata bands
  let bands = null, ys = null, band = null, BF = null, BD = null, bcol = null, OFF = null, nb = 0;
  const faults = []; let R_FX = null;
  const WB = P.strata ? fbmLo(rnd, s, 3, 4, 0.5, 0.5) : null, WB2 = P.strata ? fbmLo(rnd, s, 2, 12, 0.5, 0.4) : null;
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
    band = new Int32Array(N); BF = new Float32Array(N); BD = new Float32Array(N);
    // each band boundary wanders up and down along the wall; where two meet, the band between
    // them pinches out
    nb = ys.length;
    const wav = ys.map(() => periodic(rnd, 3, 1, 1)), amp = ys.map((_, i) => (i === 0 || i === nb - 1 ? 0 : range(rnd, 0, P.pinch ?? 0)));
    bcol = new Float32Array(s * nb);
    for (let x = 0; x < s; x++) {
      let prev = 0;
      for (let i = 0; i < nb; i++) {
        const b = i === 0 ? 0 : i === nb - 1 ? s : Math.max(prev, Math.min(s, ys[i] + amp[i] * wav[i](x / s)));
        bcol[x * nb + i] = b; prev = b;
      }
    }
    // faults: the whole stack steps up or down at a few vertical breaks (the steps sum to zero, so it tiles)
    // each fault wanders sideways with height (a periodic wobble, so it tiles) and its step ramps over a few px
    OFF = new Float32Array(N);
    const nF = P.faults ?? 0, jumps = [], fw = [];
    for (let i = 0; i < nF; i++) { faults.push((i + 0.2 + rnd() * 0.6) / nF * s); jumps.push(range(rnd, 3, 10) * (rnd() < 0.5 ? -1 : 1)); fw.push(periodic(rnd, 4, 0.9, 1)); }
    const mean = jumps.reduce((a, b) => a + b, 0) / Math.max(1, nF);
    const FX = new Float32Array(nF * s);
    for (let i = 0; i < nF; i++) for (let y = 0; y < s; y++) FX[i * s + y] = faults[i] + fw[i](y / s) * 16;
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      let o2 = 0;
      for (let i = 0; i < nF; i++) { let dx = x - FX[i * s + y]; dx -= Math.round(dx / s) * s; o2 += (jumps[i] - mean) * (dx > 2.5 ? 1 : dx < -2.5 ? 0 : sst(-2.5, 2.5, dx)) * (x >= FX[i * s + y] - s / 2 ? 1 : 1); }
      OFF[y * s + x] = o2;
    }
    R_FX = { FX, nF };
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
    PV[k] = o[4] / C0.ch;                              // where in its plane: -0.5 near the top, +0.5 near the bottom
    // cracks only along some of the big borders, each with its own strength
    const ph = pairHash(o[0], o[1]);
    if (ph < P.crackFrac) CRK[k] = Math.max(0, 1 - o[2] / (P.crackW * (0.6 + ph / P.crackFrac * 0.8))) * (0.55 + 0.45 * ph / P.crackFrac) * sst(-0.35, 0.15, CFADE[k]);
    // small chips, only where the rock is broken up
    if (C1) {
      const br = Math.max(P.chipMin ?? 0, sst(-0.05, 0.35, BROKEN[k]));
      if (br > 0) {
        powerAt(C1, s, u, v, o, 1);
        const b = C1.seeds[o[0]];
        h += br * F1.amp * b.d * (P.step ?? 0.25);
        fl += br * 0.6 * (facetLight(b.gx, b.gy) - facetLight(0, 0));
        if (pairHash(o[0] + 9000, o[1] + 9000) < P.crackFrac * 0.6) CRK[k] = Math.max(CRK[k], br * 0.5 * Math.max(0, 1 - o[2] / (P.crackW * 0.6)) * sst(-0.2, 0.3, -CFADE[k]));
      }
    }
    // shelves
    for (const L of shelves) {
      const win = L.WIN[x];
      if (win <= 0) continue;
      let dy = y - L.Y[x]; dy -= Math.round(dy / s) * s;
      if (dy < -L.w * 3 || dy > L.th + L.w * 4) continue;
      const shelf = sst(-L.w, L.w, dy) * (1 - sst(L.th - L.w * 2, L.th + L.w * 3, dy));
      h += shelf * L.h * win;
      TOP[k] = Math.max(TOP[k], win * sst(-L.w, 0, dy) * (1 - sst(L.w * 1.5, L.w * 4, dy)));
      if (L.cap) {          // a cap of snow on the ledge: a lumpy top, thinning toward the ledge's ends
        const ch = L.CH[x];
        CAP[k] = Math.max(CAP[k], sst(-ch - 2, -ch + 2, dy) * (1 - sst(L.w * 0.4, L.w * 0.9 + 1, dy)) * sst(0.05, 0.3, win));
        CAPSH[k] = Math.max(CAPSH[k], sst(L.w * 0.5, L.w + 1.5, dy) * (1 - sst(L.w + 3, L.w + 7, dy)) * sst(0.1, 0.4, win));
      }
    }
    if (P.strata) {
      const yy = (((y + OFF[k] + WB[k] * P.bandWarp + WB2[k] * P.bandWarp * 0.25) % s) + s) % s;
      const bc = x * nb;
      let i = 0; while (i < nb - 2 && yy >= bcol[bc + i + 1]) i++;
      const b0 = bcol[bc + i], b1 = bcol[bc + i + 1], f = b1 > b0 + 0.01 ? (yy - b0) / (b1 - b0) : 0;
      band[k] = i; BF[k] = f; BD[k] = yy - b0;
      const bd = bands[i];
      h += bd.hard ? bd.hard * P.ledge * (0.3 + Math.sin(Math.PI * Math.min(1, f * 1.04)) * 0.7) : P.ledge * (-0.08 - 0.22 * f);
      if (bd.hard && f < 0.12) TOP[k] = Math.max(TOP[k], 1 - f / 0.12);
    }
    h += BU[k] * P.bulge + DET[k] * P.detail;
    H[k] = h; FN[k] = fl;
  }
  blurField(FN, s, 1, 2);
  blurField(FU, s, 3, 2);
  return { H, SLAB, CRK, TOP, FN, FU, PV, CAP, CAPSH, bands, band, BF, BD, faults, FX: R_FX };
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
  const COV = fbmLo(rnd, s, 3, 4, 0.55);
  const PWN = P.powder ? fbmLo(rnd, s, 3, 5, 0.55) : null;
  // -- 2. light it from the upper left, a little in front; cavities darken and cool
  const Lx = -0.48, Ly = -0.66, Lz = 0.58, Ll = Math.hypot(Lx, Ly, Lz);
  const lit = hex(P.light), shd = hex(P.shadow), deep = hex(shadowOf(P.shadow, 0.3)), crack = hex(P.crack || shadowOf(P.shadow, 0.15));
  const cov = P.cover ? { lo: hex(P.cover.shade), mid: hex(P.cover.mid), hi: hex(P.cover.lit) } : null;
  const NY = new Float32Array(N), LT = new Float32Array(N), CV = new Float32Array(N);
  const C_UNDER = P.undercut ? hex(P.undercut) : null, C_LIP = P.lipLit ? hex(P.lipLit) : null, C_POW = hex(P.powderC || '#e6ecf4');
  const C_CAP1 = hex(P.capC?.[0] || '#f4f6f8'), C_CAP2 = hex(P.capC?.[1] || '#d6dfea'), C_CAPSH = hex(P.capShadow || '#9fb0c8');
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
    // strata: a lit lip along the top of each hard band, a deep undercut shadow under it
    if (P.strata && P.lipLit) {
      const i = R.band[k], bd = R.bands[i], above = R.bands[(i - 1 + R.bands.length) % R.bands.length], dy = R.BD[k];
      let a = 0, C = null;
      if (above.hard && dy < 9) { a = (1 - dy / 9) * 0.75; C = C_UNDER; }
      else if (bd.hard && dy < 5) { a = (1 - dy / 5) * 0.6; C = C_LIP; }
      if (a > 0) { r += (C.r - r) * a; gg += (C.g - gg) * a; b += (C.b - b) * a; }
    }
    // powder: snow dusted down over the upper part of each plane, densest at its top edge
    if (P.powder) {
      const a = P.powder * sst(0.2, -0.4, R.PV[k]) * sst(-0.35, 0.2, PWN[k]) * (t > -0.3 ? 1 : 0.55);
      if (a > 0.005) { r += (C_POW.r - r) * a; gg += (C_POW.g - gg) * a; b += (C_POW.b - b) * a; }
    }
    // snow caps on the ledges: lit lumpy top, a little bluer at the bottom; a cool line under the lip
    if (R.CAP[k] > 0.005) {
      const m = R.CAP[k], above = R.CAP[((y - 3 + s) % s) * s + x], topEdge = Math.max(0, m - above);
      const c1 = C_CAP1, c2 = C_CAP2;
      const below = R.CAP[((y + 3) % s) * s + x], bot = Math.max(0, m - below);
      const cr = c1.r + (c2.r - c1.r) * bot * 0.8, cg = c1.g + (c2.g - c1.g) * bot * 0.8, cb = c1.b + (c2.b - c1.b) * bot * 0.8;
      r += (cr - r) * m; gg += (cg - gg) * m; b += (cb - b) * m;
      if (topEdge > 0.2) { r = Math.min(255, r + 6); gg = Math.min(255, gg + 6); b = Math.min(255, b + 4); }
    }
    if (R.CAPSH[k] > 0.005 && R.CAP[k] < 0.5) {
      const sc = C_CAPSH, a = R.CAPSH[k] * 0.7 * (1 - R.CAP[k]);
      r += (sc.r - r) * a; gg += (sc.g - gg) * a; b += (sc.b - b) * a;
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
  // vertical fissures (and the fault lines): a dark wandering joint with a lit left lip
  if (P.fissures) {
    const xs = R.faults.map((x, i) => [x, 1, i]), FIS = [];
    let x = rnd() * 40;
    while (x < s - 20) { xs.push([x, 0]); x += range(rnd, P.fissures[0], P.fissures[1]); }
    for (const [x0, fault, fi] of xs) {
      const L = fault ? range(rnd, 0.45, 0.8) * s : range(rnd, 0.12, 0.4) * s, y0 = rnd() * s, n = Math.ceil(L / 12), pts = [];
      let px = x0;
      for (let i = 0; i <= n; i++) {
        const yy = y0 + i * L / n;
        pts.push([fault ? R.FX.FX[fi * s + ((Math.floor(yy) % s) + s) % s] + range(rnd, -1, 1) : px, yy]);
        px += range(rnd, -3, 3);
      }
      const w = fault ? range(rnd, 2.6, 3.6) : range(rnd, 1.4, 2.6);
      FIS.push({ pts, w, x0, y0, L, fault });
    }
    // all the lips in one layer, all the dark joints in another (faults a little stronger)
    const draw = (lg, dxK, wK, col, onlyFault) => {
      for (const F of FIS) {
        if (onlyFault != null && F.fault !== onlyFault) continue;
        for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
          if (F.x0 + ox < -10 || F.x0 + ox > s + 10) continue;
          if (F.y0 + oy > s + 10 || F.y0 + oy + F.L < -10) continue;
          stroke(lg, F.pts.map(([u, v]) => [u + ox + F.w * dxK, v + oy]), F.w * wK, F.w * wK * 0.5, col, 1);
        }
      }
    };
    layered(g, s, 0.28, lg => draw(lg, -0.8, 0.8, P.light, null));
    layered(g, s, 0.55, lg => draw(lg, 0, 1, P.fissureC || P.crack, false));
    layered(g, s, 0.7, lg => draw(lg, 0, 1, P.fissureC || P.crack, true));
  }
  // streaks running down from the lips: rain stains, or wind-blown snow
  for (const [x, y] of lips.slice(0, P.stains ?? 40)) {
    const L = range(rnd, 24, 110), w = range(rnd, 3, 9);
    const pts = []; let px = 0; for (let i = 0; i <= 5; i++) { pts.push([px, 4 + L * i / 5]); px += range(rnd, -1.5, 1.5); }
    wrap(s, x, y + L / 2, L, (X, Y) => stroke(g, pts.map(([u, v]) => [X + u, Y - L / 2 + v]), w, w * 0.3, P.stain, P.stainA ?? 0.1));
  }
  // grass clinging to the lips
  if (P.tuft) for (const [x, y] of lips.slice(60, 60 + (P.tuftN ?? 40))) {
    const n = 5 + Math.floor(rnd() * 7), B2 = [];
    for (let i = 0; i < n; i++) B2.push([range(rnd, -8, 8), range(rnd, 6, 13), range(rnd, -0.9, 0.9), range(rnd, 1.6, 2.8), pick(rnd, P.tuft), range(rnd, -0.5, 0.5)]);
    wrap(s, x, y, 22, (X, Y) => {
      blob(g, X + 2, Y + 5, 10, 4, 0, '#1e2418', 0.25, 0.3);
      for (const [dx, L, a, w, c, bd] of B2) blade2(g, X + dx, Y + 3, L, a, w, c, bd);
    });
  }
  // dry grass hanging over the lips in tufted fringes
  if (P.fringe) for (const [x, y] of lips.slice(0, P.fringeN ?? 40)) {
    const n = 5 + Math.floor(rnd() * 6), B2 = [];
    for (let i = 0; i < n; i++) B2.push([range(rnd, -9, 9), range(rnd, 7, 15), Math.PI + range(rnd, -0.5, 0.5), range(rnd, 1.8, 3), pick(rnd, P.fringe), range(rnd, -0.3, 0.3)]);
    wrap(s, x, y, 26, (X, Y) => {
      blob(g, X + 2, Y + 7, 11, 5, 0, '#2a2024', 0.25, 0.3);
      for (const [dx, L, a, w, c, bd] of B2) blade2(g, X + dx, Y - 1, L, a, w, c, bd);
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
  // icicles: a few small groups hanging from under the snow caps (never a comb)
  const capPts = [];
  if (P.icicles) for (let i = 0; i < 20000 && capPts.length < P.icicles; i++) {
    const x = Math.floor(rnd() * s), y = Math.floor(rnd() * s);
    if (R.CAPSH[y * s + x] > 0.6 && R.CAP[y * s + x] < 0.2 && !capPts.some(([a, b2]) => Math.hypot(a - x, b2 - y) < 60)) capPts.push([x, y]);
  }
  for (const [x, y] of capPts) {
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const xx = x + i * range(rnd, 4, 8), L = range(rnd, 6, 18) * (1 - i * 0.18), w = range(rnd, 2, 3.4);
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
  soften(cv, 0.75);
}

// ---- packed dirt, stones and cracks --------------------------------------------------------------

// Cobbled packed dirt: soft Worley cells (borders warped, so no cell is a clean polygon), each lit on
// its upper left and a little shaded on its lower right, parted by soft grout. Laid over what is
// already painted at partial strength, so the big blotches show through.
function cellDirt(g, s, rnd, { cells = 16, warp = 12, grout, groutA = 0.35, groutW = 3.4, lit, litA = 0.4, shade: dk, shadeA = 0.3, where = null, varA = 0.06 }) {
  const F = worley(s, cells, rnd, 0.95);
  const WX = fbmLo(rnd, s, 3, 5, 0.6), WY = fbmLo(rnd, s, 3, 5, 0.6), GN = fbmLo(rnd, s, 3, 9, 0.55);
  const tone = F.seeds.map(() => range(rnd, -1, 1));
  const G = hex(grout), L = hex(lit), Dk = hex(dk);
  const img = g.getImageData(0, 0, s, s), D = img.data;
  const R = s / cells * 0.62;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x;
    const m = where ? where(x, y) : 1;
    if (m <= 0.01) continue;
    const u = ((Math.round(x + WX[k] * warp) % s) + s) % s, v = ((Math.round(y + WY[k] * warp) % s) + s) % s, q = v * s + u;
    const e = F.edge[q], id = F.id[q], o = k * 4;
    // lit toward the upper left of each cell, shaded toward its lower right, a domed middle
    const f = -(F.dirx[q] * 0.7 + F.diry[q] * 0.72) * Math.min(1, F.d1[q] / R);
    const tk = 1 + tone[id] * varA;
    D[o] *= tk; D[o + 1] *= tk; D[o + 2] *= tk;
    if (f > 0) { const a = f * litA * m; D[o] += (L.r - D[o]) * a; D[o + 1] += (L.g - D[o + 1]) * a; D[o + 2] += (L.b - D[o + 2]) * a; }
    else { const a = -f * shadeA * m; D[o] += (Dk.r - D[o]) * a; D[o + 1] += (Dk.g - D[o + 1]) * a; D[o + 2] += (Dk.b - D[o + 2]) * a; }
    const gt = sst(groutW, 0.3, e) * groutA * m * sst(-0.25, 0.3, GN[k]);     // grout along only some of the borders
    if (gt > 0) { D[o] += (G.r - D[o]) * gt; D[o + 1] += (G.g - D[o + 1]) * gt; D[o + 2] += (G.b - D[o + 2]) * gt; }
  }
  g.putImageData(img, 0, 0);
}

// Packed earth as a soft relief: a smooth low-frequency height field (stretched along y when
// aniso < 1, so a road's lumps run with it), lit from the upper left. Undulations, never cells.
function softRelief(g, s, rnd, { g0 = 9, oct = 3, gain = 0.55, aniso = 1, k = 34, lit, dark, litA = 0.3, darkA = 0.3, mask = null }) {
  const H = fbmLo(rnd, s, oct, g0, gain, aniso);
  shadeHeight(g, s, H, { k, lit, dark, litA, darkA, mask });
}

// One stone seen from above: a flat slab or an angular chip (aspect 0.4-1), lit on its upper-left
// edge, with only a thin dark contact line along its lower right (no cast-shadow ellipse).
function stone(g, s, x, y, r, rnd, { color, contact = '#4a3424', contactA = 0.5, sides = 5, asp = [0.4, 1] }) {
  const rot = rnd() * TAU, sq = range(rnd, asp[0], asp[1]), pts = [];
  for (let i = 0; i < sides; i++) {
    const a = (i + range(rnd, -0.25, 0.25)) / sides * TAU, rr = r * range(rnd, 0.75, 1.15);
    const px = Math.cos(a) * rr, py = Math.sin(a) * rr * sq;
    pts.push([px * Math.cos(rot) - py * Math.sin(rot), px * Math.sin(rot) + py * Math.cos(rot)]);
  }
  const path = (X, Y, ox = 0, oy = 0) => { g.beginPath(); pts.forEach(([u, v], i) => (i ? g.lineTo(X + u + ox, Y + v + oy) : g.moveTo(X + u + ox, Y + v + oy))); g.closePath(); };
  const lit = lightOf(color, 0.45), dk = shadowOf(color, 0.3);
  wrap(s, x, y, r * 1.6, (X, Y) => {
    g.save(); g.globalAlpha = contactA; g.fillStyle = contact; path(X, Y, 1.1, 1.3); g.fill(); g.restore();
    g.fillStyle = color; path(X, Y); g.fill();
    g.save(); path(X, Y); g.clip();
    blob(g, X + r * 0.5, Y + r * 0.55, r * 0.95, r * 0.8, 0, dk, 0.55, 0.35);
    blob(g, X - r * 0.45, Y - r * 0.5, r * 0.85, r * 0.7, 0, lit, 0.75, 0.35);
    g.restore();
  });
}

// Stones gathered in clusters of 3-8 (one bigger, the rest small), at given spots or where a mask
// allows, leaving most of the ground empty.
function stoneClusters(g, s, rnd, n, { colors, r = [1.6, 4.2], k = [3, 8], spread = [5, 14], at = null, where = null, contact = '#4a3424', contactA = 0.5, sides = [4, 6], asp = [0.4, 1], sy = 0.7 }) {
  const C = at ? at.slice() : [];
  for (let i = 0; i < n * 8 && C.length < n; i++) { const x = rnd() * s, y = rnd() * s; if (!where || rnd() < where(x, y)) C.push([x, y]); }
  for (const [cx, cy] of C.slice(0, n)) {
    const m = Math.round(range(rnd, k[0], k[1])), sp = range(rnd, spread[0], spread[1]), a0 = rnd() * TAU;
    const list = [];
    for (let j = 0; j < m; j++) {
      const t = rnd() * TAU, d = Math.sqrt(rnd()) * sp * (j ? 1 : 0.3);
      list.push([cx + Math.cos(t + a0) * d, cy + Math.sin(t + a0) * d * sy, (j ? range(rnd, r[0], (r[0] + r[1]) / 2) : range(rnd, (r[0] + r[1]) / 2, r[1]))]);
    }
    list.sort((p, q) => p[1] - q[1]);
    for (const [x, y, rr] of list) stone(g, s, x, y, rr, rnd, { color: jitter(pick(rnd, colors), rnd, 0.06), contact, contactA, sides: Math.round(range(rnd, sides[0], sides[1])), asp });
  }
  return C;
}

// Open crack networks: a few long wandering cracks that branch, 1-2 px wide, with a 1 px lit lip on
// their upper-left side. Returns points along them (for stones to gather at).
function crackNet(g, s, rnd, n, { color, lit, alpha = 0.5, litA = 0.45, len = [90, 220], width = [1, 2], branch = 0.4 }) {
  const along = [];
  const lines = [];
  const one = (x, y, a, L, W, depth) => {
    const pts = [[x, y]], segs = Math.max(4, Math.round(L / 10));
    let px = x, py = y;
    for (let i = 0; i < segs; i++) {
      a += range(rnd, -0.45, 0.45);
      px += Math.cos(a) * L / segs; py += Math.sin(a) * L / segs; pts.push([px, py]);
      if (rnd() < 0.15) along.push([px, py]);
      if (depth < 2 && rnd() < branch / segs * 3) one(px, py, a + (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.6, 1.3), L * range(rnd, 0.25, 0.5), W * 0.7, depth + 1);
    }
    lines.push({ pts, W, x, y, L });
  };
  for (let i = 0; i < n; i++) one(rnd() * s, rnd() * s, rnd() * TAU, range(rnd, len[0], len[1]), range(rnd, width[0], width[1]), 0);
  layered(g, s, litA, lg => { for (const l of lines) wrap(s, l.x, l.y, l.L + 4, (X, Y) => stroke(lg, l.pts.map(([u, v]) => [u - l.x + X - 0.9, v - l.y + Y - 0.9]), l.W * 0.8, l.W * 0.3, lit, 1)); });
  layered(g, s, alpha, lg => { for (const l of lines) wrap(s, l.x, l.y, l.L + 4, (X, Y) => stroke(lg, l.pts.map(([u, v]) => [u - l.x + X, v - l.y + Y]), l.W, l.W * 0.35, color, 1)); });
  return along;
}

// Shallow wheel tracks as broken soft bands along y at x0 (each w px wide, no lines), present over
// part of the length; strength fades in and out along the road.
function softRuts(g, s, rnd, xs, { w, color, alpha = 0.25, presence = 0.6, wob = 6 }) {
  const img = g.getImageData(0, 0, s, s), D = img.data, C = hex(color);
  for (const x0 of xs) {
    const on = periodic(rnd, 4, 0.8, 1), on2 = periodic(rnd, 3, 0.7, 5), wb = periodic(rnd, 3, 1.1, 1), wd = periodic(rnd, 3, 1, 2);
    const cut = 1 - presence * 2;      // periodic() spans about -1..1
    for (let y = 0; y < s; y++) {
      const pres = sst(cut - 0.15, cut + 0.15, on(y / s) * 0.8 + on2(y / s) * 0.35);
      if (pres <= 0) continue;
      const cx = x0 + wb(y / s) * wob, hw = w * (0.5 + 0.12 * wd(y / s));
      for (let x = Math.max(0, Math.floor(cx - hw)); x <= Math.min(s - 1, Math.ceil(cx + hw)); x++) {
        const u = (x - cx) / hw, a = Math.cos(u * Math.PI / 2) ** 2 * alpha * pres, o = (y * s + x) * 4;
        D[o] += (C.r - D[o]) * a; D[o + 1] += (C.g - D[o + 1]) * a; D[o + 2] += (C.b - D[o + 2]) * a;
      }
    }
  }
  g.putImageData(img, 0, 0);
}

// The cross profile of a road: darker, softer toward the edges, a slightly paler crown.
function roadProfile(g, s, edge, crown, base) {
  const gr = g.createLinearGradient(0, 0, s, 0);
  gr.addColorStop(0, rgba(edge, 0.6)); gr.addColorStop(0.18, rgba(edge, 0.15)); gr.addColorStop(0.3, rgba(edge, 0));
  gr.addColorStop(0.7, rgba(edge, 0)); gr.addColorStop(0.82, rgba(edge, 0.15)); gr.addColorStop(1, rgba(edge, 0.6));
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  const cr = g.createLinearGradient(0, 0, s, 0);
  cr.addColorStop(0.36, rgba(crown, 0)); cr.addColorStop(0.5, rgba(crown, 0.22)); cr.addColorStop(0.64, rgba(crown, 0));
  g.fillStyle = cr; g.fillRect(0, 0, s, s);
}
// Lighter worn patches, long along the road.
function worn(g, s, rnd, n, xs, color, a, w = [12, 28], l = [40, 120]) {
  layered(g, s, 1, lg => {
    for (let i = 0; i < n; i++) {
      const x = pick(rnd, xs) + range(rnd, -14, 14), y = rnd() * s, rx = range(rnd, w[0], w[1]), ry = range(rnd, l[0], l[1]), al = range(rnd, a[0], a[1]), rot = range(rnd, -0.12, 0.12);
      wrap(s, x, y, ry * 1.2, (X, Y) => blob(lg, X, Y, rx, ry, rot, color, al, 0.2));
    }
  });
}

// ---- rounded rock masses (granite, sandstone) -------------------------------------------------
// Granite is painted as big rounded, lumpy masses: 5-8 big ones per tile over a fill of medium
// ones (sizes vary three to one), each a low dome with its own tilt. The domes are joined by a
// smooth maximum, so most borders between masses are only a change of value; about a third of the
// seams get a soft dark crease. Light from the upper left (and above: the canvas top is up in the
// world): the upper-left of every mass is cream-lit, its underside cool, and it casts a soft
// shadow on what lies behind it. Outlines are warped on two octaves and lobed, so nothing runs
// straight. Then moss or snow settles on whatever faces up, rain streaks run down, a few short
// cracks and lichen.

// A convex polygon's support function: n sides at jittered bearings, each pushed in or out a little;
// r(lx, ly) = max over the sides of (lx, ly)·n_k / d_k is 1 on the outline (straight edges, sharp corners).
function polySides(rnd, [n0, n1]) {
  const n = n0 + Math.floor(rnd() * (n1 - n0 + 1)), a0 = rnd() * TAU, out = [];
  for (let k = 0; k < n; k++) { const a = a0 + (k + range(rnd, -0.28, 0.28)) / n * TAU; out.push([Math.cos(a), Math.sin(a), range(rnd, 0.82, 1.12)]); }
  return out;
}
function rockMasses(s, rnd, P) {
  const M = [];
  const add = (x, y, rx, ry, z, kind, rot = range(rnd, -P.rot, P.rot)) => {
    M.push({ id: M.length, x, y, rx, ry, c: Math.cos(rot), sn: Math.sin(rot), z, kind, tone: range(rnd, -1, 1), hue: hex(pick(rnd, P.colors)),
      lob: ptable(rnd, 256, 5, 0.8, 2), lobA: range(rnd, 0.12, 0.24), dome: range(rnd, 0.7, 1.25), gx: range(rnd, -1, 1) * P.tilt, gy: range(rnd, -0.6, 1) * P.tilt, r2: rnd(), r3: rnd(),
      poly: P.poly ? polySides(rnd, P.poly) : null });
  };
  const [fx, fy] = P.fill, cw = s / fx, ch = s / fy;
  for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) {
    add((i + 0.5 + range(rnd, -0.4, 0.4) + (j % 2) * 0.37) * cw, (j + 0.5 + range(rnd, -0.3, 0.3)) * ch, cw * range(rnd, 0.55, 0.8), ch * range(rnd, 0.5, 0.75), rnd() * 0.45, 1);
  }
  for (let i = 0; i < P.big; i++) {
    const R = range(rnd, P.bigR[0], P.bigR[1]), asp = range(rnd, P.asp[0], P.asp[1]);
    add((i + rnd() * 0.8) / P.big * s, rnd() * s, R * Math.sqrt(asp) * P.sx, R / Math.sqrt(asp) * P.sy, 0.45 + rnd() * 0.55, 2);
  }
  for (let i = 0; i < (P.ledgeN || 0); i++) add(rnd() * s, (i + 0.2 + rnd() * 0.6) / P.ledgeN * s, range(rnd, P.ledgeL[0], P.ledgeL[1]), range(rnd, 13, 22), 1.0 + rnd() * 0.2, 3, range(rnd, -0.05, 0.05));
  for (let i = 0; i < (P.small || 0); i++) { const R = range(rnd, 22, 42); add(rnd() * s, rnd() * s, R * P.sx, R * 0.8 * P.sy, -0.3 + rnd() * 0.3, 0); }
  return M;
}

const FORM = new Map();     // name -> the painted rock's form fields (see cliff_snow_form)
function massRock(g, s, rnd, P, cv) {
  const N = s * s;
  const M = rockMasses(s, rnd, P);
  const REACH = 1.35;
  // bins of 32 px, each holding the (wrapped copies of the) masses that can reach it
  const BS = 32, NB = s / BS, bins = Array.from({ length: NB * NB }, () => []);
  for (const m of M) {
    const R = Math.max(m.rx, m.ry) * (1 + m.lobA) * REACH + 3;
    for (const ox of [-s, 0, s]) for (const oy of [-s, 0, s]) {
      const cx = m.x + ox, cy = m.y + oy;
      if (cx + R < 0 || cx - R > s || cy + R < 0 || cy - R > s) continue;
      const bx0 = Math.max(0, Math.floor((cx - R) / BS)), bx1 = Math.min(NB - 1, Math.floor((cx + R) / BS));
      const by0 = Math.max(0, Math.floor((cy - R) / BS)), by1 = Math.min(NB - 1, Math.floor((cy + R) / BS));
      for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) bins[by * NB + bx].push({ m, cx, cy });
    }
  }
  const WX = fbmLo(rnd, s, 2, 4, 0.5), WY = fbmLo(rnd, s, 2, 4, 0.5), WX2 = fbmLo(rnd, s, 2, 13, 0.5), WY2 = fbmLo(rnd, s, 2, 13, 0.5);
  const BU = fbmLo(rnd, s, 3, 3, 0.5);
  const TOP = new Int32Array(N), H = new Float32Array(N), CR = new Float32Array(N), RIM = new Float32Array(N), DYN = new Float32Array(N);
  const D = P.dome, ZS = P.zs, K = P.smooth, ex = P.exp ?? 2.4;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x;
    let u = x + WX[k] * P.warp + WX2[k] * P.warp * 0.38, v = y + WY[k] * P.warp + WY2[k] * P.warp * 0.38;
    u = ((u % s) + s) % s; v = ((v % s) + s) % s;
    const list = bins[Math.min(NB - 1, Math.floor(v / BS)) * NB + Math.min(NB - 1, Math.floor(u / BS))];
    let h1 = -1e9, h2 = -1e9, i1 = -1, i2 = -1, acc = 0, rim = 0, dyn = 0;
    // pass 1: the top two heights; pass 2 (folded in): a running log-sum-exp for the smooth union
    for (const e of list) {
      const m = e.m, dx = u - e.cx, dy = v - e.cy;
      const lx = (dx * m.c + dy * m.sn) / m.rx, ly = (-dx * m.sn + dy * m.c) / m.ry;
      let r = lx * lx + ly * ly;
      if (r > REACH * REACH * 1.6) continue;
      if (m.poly) { let q = 0; for (const [cx, cy, d] of m.poly) { const t = (lx * cx + ly * cy) / d; if (t > q) q = t; } r = q; }
      else r = Math.sqrt(r) / (1 + m.lobA * m.lob[((Math.atan2(ly, lx) / TAU + 0.5) * 255) | 0]);
      if (r > REACH) continue;
      const h = m.z * ZS + D * m.dome * (1 - Math.pow(r, ex)) + (m.gx * dx + m.gy * dy);
      if (h > h1) { acc = acc * Math.exp(K * (h1 - h)) + 1; h2 = h1; i2 = i1; h1 = h; i1 = m.id; const dd = Math.hypot(dx, dy) || 1; rim = dd / Math.max(r, 1e-3) - dd; dyn = dy / dd; }
      else { acc += Math.exp(K * (h - h1)); if (h > h2) { h2 = h; i2 = m.id; } }
    }
    if (i1 < 0) { TOP[k] = -1; H[k] = -D * 1.2 + BU[k] * P.bulge; CR[k] = 1; continue; }
    TOP[k] = i1; RIM[k] = rim; DYN[k] = dyn;
    H[k] = h1 + Math.log(acc) / K + BU[k] * P.bulge;
    if (h1 < 0) CR[k] = Math.max(CR[k], sst(0, -D * 0.8, h1) * 0.7);                       // a gap between masses
    if (i2 >= 0 && M[i1].kind && M[i2].kind && pairHash(i1, i2) < P.crease) CR[k] = Math.max(CR[k], sst(P.creaseW, 0, h1 - h2));
  }
  blurField(CR, s, 1, 2);
  for (let k = 0; k < N; k++) H[k] -= CR[k] * P.creaseD;
  const Hs = blurField(Float32Array.from(H), s, P.soft ?? 2, 2);
  // -- colour: painted blotches under the light
  fill(g, s, s, P.colors[0]);
  mottle(g, s, rnd, { colors: P.colors, count: 34, rmin: 60, rmax: 170, alpha: 0.45, hard: 0.1 });
  mottle(g, s, rnd, { colors: P.blot, count: 70, rmin: 12, rmax: 46, alpha: 0.18, hard: 0.2, stretch: 1.4 });
  blurWrap(cv, 2);
  const base = g.getImageData(0, 0, s, s), B = base.data;
  const Lx = -0.5, Ly = -0.64, Lz = 0.58, Ll = Math.hypot(Lx, Ly, Lz), dif0 = Lz / Ll;
  const lit = hex(P.light), shd = hex(P.shadow), deep = hex(P.deep || shadowOf(P.shadow, 0.3)), crc = hex(P.creaseC), cast = hex(P.cast || P.shadow);
  const rs = P.relief, UP = new Float32Array(N), LT = new Float32Array(N), UX = P.upName ? new Float32Array(N) : null;
  const SH = [[4, 0.7], [9, 0.8], [16, 0.9], [26, 1]];
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x, o = k * 4;
    const hx = (Hs[y * s + (x + 1) % s] - Hs[y * s + (x - 1 + s) % s]) * 0.5 * rs;
    const hy = (Hs[((y + 1) % s) * s + x] - Hs[((y - 1 + s) % s) * s + x]) * 0.5 * rs;
    const nl = Math.hypot(hx, hy, 1);
    UP[k] = hy / nl;                                                // > 0: the surface faces up (the canvas top is up)
    if (UX) UX[k] = -hx / nl;
    const dif = (-hx * Lx - hy * Ly + Lz) / (nl * Ll);              // n = (-hx, -hy, 1) / nl
    let r = B[o], gg = B[o + 1], b = B[o + 2];
    const id = TOP[k];
    if (id >= 0) {
      const m = M[id], h = m.hue, tk = 1 + m.tone * P.tone;
      r = (r * (1 - P.hueMix) + h.r * P.hueMix) * tk; gg = (gg * (1 - P.hueMix) + h.g * P.hueMix) * tk; b = (b * (1 - P.hueMix) + h.b * P.hueMix) * tk;
    }
    let t = (dif - dif0) * P.contrast;
    LT[k] = t;
    t = t * (1 - P.planes) + P.planes * Math.round(t * 3) / 3;      // painted in broad planes of light
    // a soft shadow cast by whatever stands up toward the light
    let occ = 0;
    for (const [d, f] of SH) {
      const sx = ((x - Math.round(d * 0.62)) % s + s) % s, sy = ((y - Math.round(d * 0.78)) % s + s) % s;
      occ = Math.max(occ, Hs[sy * s + sx] - Hs[k] - d * P.shSlope * f);
    }
    const sh = sst(0, D * 0.4, occ) * P.castA;
    if (t > 0) { const a = Math.min(0.85, t) * (1 - sh); r += (lit.r - r) * a; gg += (lit.g - gg) * a; b += (lit.b - b) * a; }
    else { const a = Math.min(0.85, -t); r += (shd.r - r) * a; gg += (shd.g - gg) * a; b += (shd.b - b) * a; }
    if (sh > 0) { r += (cast.r - r) * sh; gg += (cast.g - gg) * sh; b += (cast.b - b) * sh; }
    if (id < 0) { const a = 0.5; r += (deep.r - r) * a; gg += (deep.g - gg) * a; b += (deep.b - b) * a; }
    const c = CR[k] * P.creaseA;
    if (c > 0.005) { r += (crc.r - r) * c; gg += (crc.g - gg) * c; b += (crc.b - b) * c; }
    B[o] = r; B[o + 1] = gg; B[o + 2] = b; B[o + 3] = 255;
  }
  g.putImageData(base, 0, 0);
  // (kept for a companion map: which way the painted rock faces, its height, its creases)
  if (P.upName) {
    let h0 = Infinity, h1 = -Infinity;
    for (let k = 0; k < N; k++) { if (Hs[k] < h0) h0 = Hs[k]; if (Hs[k] > h1) h1 = Hs[k]; }
    const Hn = new Float32Array(N);
    for (let k = 0; k < N; k++) Hn[k] = (Hs[k] - h0) / (h1 - h0 || 1);
    FORM.set(P.upName, { up: blurField(Float32Array.from(UP), s, 2, 2), h: Hn, cr: Float32Array.from(CR), ux: P.formUX ? blurField(UX, s, 2, 2) : null });
  }
  // -- painted details on the faces: soft chisel strokes, a few short cracks with a lit lip
  if (P.chisel) {
    streaks(g, s, rnd, { colors: [P.light], count: P.chisel, len: [8, 26], width: [2, 4.5], angle: P.chiselA ?? 1.3, wobble: 0.3, alpha: 0.1 });
    streaks(g, s, rnd, { colors: [P.shadow], count: P.chisel, len: [8, 26], width: [2, 4.5], angle: (P.chiselA ?? 1.3) + 0.15, wobble: 0.3, alpha: 0.09 });
  }
  const ptsTop = [], ptsFace = [];
  for (let i = 0; i < 30000 && (ptsTop.length < 300 || ptsFace.length < 200); i++) {
    const x = Math.floor(rnd() * s), y = Math.floor(rnd() * s), k = y * s + x;
    if (TOP[k] < 0) continue;
    if (UP[k] > 0.45 && UP[((y + 3) % s) * s + x] < 0.3 && ptsTop.length < 300) ptsTop.push([x, y, TOP[k]]);     // the lip where a top turns down into a face
    else if (Math.abs(UP[k]) < 0.15 && CR[k] < 0.1 && ptsFace.length < 200) ptsFace.push([x, y, TOP[k]]);
  }
  for (const [x, y] of ptsFace.slice(0, P.cracks ?? 10)) {
    const L = range(rnd, 18, 54), a0 = range(rnd, -0.6, 0.6) + (rnd() < 0.5 ? Math.PI / 2 : 0), pts = [];
    let px = 0, py = 0, a = a0;
    for (let i = 0; i <= 6; i++) { pts.push([px, py]); a += range(rnd, -0.5, 0.5); px += Math.cos(a) * L / 6; py += Math.sin(a) * L / 6; }
    wrap(s, x, y, L + 4, (X, Y) => {
      stroke(g, pts.map(([u, v]) => [X + u + 1.1, Y + v + 1.2]), 2.2, 0.6, P.light, 0.3);
      stroke(g, pts.map(([u, v]) => [X + u, Y + v]), 2, 0.5, P.creaseC, 0.45);
    });
  }
  // rain streaks running down the faces from the lips
  for (const [x, y] of ptsTop.slice(0, P.stains ?? 30)) {
    const L = range(rnd, 26, 100), w = range(rnd, 3, 8), pts = [];
    let px = 0; for (let i = 0; i <= 5; i++) { pts.push([px, 3 + L * i / 5]); px += range(rnd, -1.5, 1.5); }
    wrap(s, x, y + L / 2, L, (X, Y) => stroke(g, pts.map(([u, v]) => [X + u, Y - L / 2 + v]), w, w * 0.3, P.stain, P.stainA ?? 0.12));
  }
  // -- what settles on whatever faces up: moss pads or dry grass, a powder dusting, and on a few
  // masses a thick lumpy snow pillow that bulges down past the lip, with a blue shadow line and a
  // soft stain under it. (UP > 0: the surface faces up; the canvas top is up in the world.)
  const img = g.getImageData(0, 0, s, s), I = img.data;
  const PATCH = fbmLo(rnd, s, 3, 5, 0.55), PATCH2 = fbmLo(rnd, s, 2, 14, 0.5);
  const mixP = (o, c, a) => { I[o] += (c.r - I[o]) * a; I[o + 1] += (c.g - I[o + 1]) * a; I[o + 2] += (c.b - I[o + 2]) * a; };
  const mixC = (a, b, f) => ({ r: a.r + (b.r - a.r) * f, g: a.g + (b.g - a.g) * f, b: a.b + (b.b - a.b) * f });
  const cov = P.cover ? { lo: hex(P.cover.shade), mid: hex(P.cover.mid), hi: hex(P.cover.lit), lip: hex(P.cover.lip || P.shadow) } : null;
  const lumpA = ptable(rnd, s, 8, 0.7, 3), lumpB = ptable(rnd, s, 6, 0.6, 11), drip = ptable(rnd, s, 9, 0.5, 6);
  const capT = new Float32Array(M.length);
  const S0 = new Float32Array(N);
  if (P.caps) {        // thick caps on a few masses only (the ones with the broadest tops)
    const area = new Float32Array(M.length);
    for (let k = 0; k < N; k++) if (TOP[k] >= 0 && UP[k] > P.caps.up) area[TOP[k]]++;
    const order = M.filter(m => m.kind >= 1).sort((a, b) => area[b.id] - area[a.id]);
    for (const m of order.slice(0, P.caps.n)) capT[m.id] = range(rnd, P.caps.T[0], P.caps.T[1]);
    const UPb = blurField(Float32Array.from(UP), s, 3, 2);
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const k = y * s + x, id = TOP[k];
      if (id >= 0 && capT[id] > 0) S0[k] = sst(P.caps.up - 0.04, P.caps.up + 0.04, UPb[k] + lumpA[x] * 0.07 + PATCH2[k] * 0.04 - CR[k] * 0.8);
    }
  }
  // per column: how far below the last up-facing snow pixel (the pillow overhangs that far), and how
  // far into the current run of snow from its top (for the lit crest)
  const BL = new Float32Array(N).fill(999), RUN = new Float32Array(N), TL = new Float32Array(N);
  if (P.caps) for (let x = 0; x < s; x++) {
    let d = 999, run = 0, T = 0;
    for (let yy = 0; yy < 2 * s; yy++) {
      const y = yy % s, k = y * s + x;
      if (S0[k] > 0.5) { if (d > 0) { run = 0; } d = 0; T = capT[TOP[k]] || T; } else d += 1;
      run += 1;
      if (yy >= s) { BL[k] = d; RUN[k] = run; TL[k] = T * (0.65 + 0.35 * lumpB[(x * 2) % s] + 0.15 * lumpA[x]); }
    }
  }
  const SN1 = hex('#f7f4ec'), SN2 = hex('#e8edf3'), SN3 = hex('#c9d4e4'), SNSH = hex(P.capShadow || '#9fb0c8'), POW = hex(P.powderC || '#e6ecf4');
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x, id = TOP[k], o = k * 4;
    if (id < 0) continue;
    const m = M[id], up = UP[k];
    if (cov && m.r2 < P.cover.p) {        // moss pads on the tops: lit where they face up most, darker at a ragged lower edge
      const a = sst(P.cover.up, P.cover.up + 0.28, up + PATCH[k] * 0.32 + PATCH2[k] * 0.22 + (m.r3 - 0.5) * 0.2);
      if (a > 0.01) {
        const q = Math.max(0, Math.min(1, (up - P.cover.up) * 2.4 + 0.2));
        mixP(o, q > 0.5 ? mixC(cov.mid, cov.hi, (q - 0.5) * 2) : mixC(cov.lo, cov.mid, q * 2), a * P.cover.max);
      }
    }
    if (P.powder) {      // a powder dusting on every top, thinning out down the face
      const a = sst(P.powder.up, P.powder.up + 0.3, up + PATCH[k] * 0.12 + PATCH2[k] * 0.12) * P.powder.a;
      if (a > 0.01) mixP(o, POW, a);
    }
    if (P.caps) {
      const bl = BL[k], T = TL[k];
      if (bl < T) {          // the pillow: crisp lit crest at the top of the run, cooler toward its bulging lower edge
        // snow takes the light of the rock under it (so the pillow has form), rounds off cooler toward its
        // bulging lower edge; the first rows of a run are the lit crest, laid on softly
        const q = Math.max(0, Math.min(1, 0.42 + LT[k] * 0.55 + PATCH2[k] * 0.15 - bl / Math.max(4, T) * 0.4));
        const run = RUN[k];
        if (run < 3 && bl === 0) mixP(o, SN1, 0.55 + run * 0.15);
        else mixP(o, q > 0.5 ? mixC(SN2, SN1, (q - 0.5) * 2) : mixC(SN3, SN2, q * 2), 0.96);
      } else if (bl < T + 4.5 && T > 2) mixP(o, SNSH, 0.75 * (1 - (bl - T) / 4.5));
      else if (bl < T + 20 && T > 4 && drip[x] > 0.5) mixP(o, SNSH, 0.14 * (1 - (bl - T - 4.5) / 15.5));
    }
  }
  g.putImageData(img, 0, 0);
  // grass clinging to the lips, or dry grass hanging over them
  if (P.tuft) for (const [x, y] of ptsTop.slice(40, 40 + (P.tuftN ?? 16))) {
    const n = 5 + Math.floor(rnd() * 6), B2 = [];
    for (let i = 0; i < n; i++) B2.push([range(rnd, -8, 8), range(rnd, 6, 13), range(rnd, -0.9, 0.9), range(rnd, 1.8, 3), pick(rnd, P.tuft), range(rnd, -0.5, 0.5)]);
    wrap(s, x, y, 22, (X, Y) => { blob(g, X + 2, Y + 5, 10, 4, 0, '#1e2418', 0.25, 0.3); for (const [dx, L, a, w, c, bd] of B2) blade2(g, X + dx, Y + 3, L, a, w, c, bd); });
  }
  if (P.fringe) for (const [x, y] of ptsTop.slice(80, 80 + (P.fringeN ?? 20))) {
    const n = 5 + Math.floor(rnd() * 6), B2 = [];
    for (let i = 0; i < n; i++) B2.push([range(rnd, -9, 9), range(rnd, 7, 15), Math.PI + range(rnd, -0.5, 0.5), range(rnd, 1.8, 3), pick(rnd, P.fringe), range(rnd, -0.3, 0.3)]);
    wrap(s, x, y, 26, (X, Y) => { blob(g, X + 2, Y + 7, 11, 5, 0, '#2a2024', 0.22, 0.3); for (const [dx, L, a, w, c, bd] of B2) blade2(g, X + dx, Y - 1, L, a, w, c, bd); });
  }
  // icicles: a few small groups under the caps
  if (P.icicles) {
    let n = 0;
    const done = [];
    for (let i = 0; i < 60000 && n < P.icicles; i++) {
      const x = Math.floor(rnd() * s), y = Math.floor(rnd() * s), k = y * s + x;
      if (Math.abs(BL[k] - TL[k] - 1) > 0.5 || done.some(([a, b]) => Math.hypot(a - x, b - y) < 50)) continue;
      n++; done.push([x, y]);
      const cnt = 2 + Math.floor(rnd() * 3);
      for (let j = 0; j < cnt; j++) {
        const xx = x + j * range(rnd, 4, 8), L = range(rnd, 6, 16) * (1 - j * 0.18), w = range(rnd, 2, 3.2);
        wrap(s, xx, y + L / 2, L, (X, Y) => {
          const Y0 = Y - L / 2;
          stroke(g, [[X + 1, Y0 + 1], [X + 1.2, Y0 + L + 1]], w, 0.4, '#3a4660', 0.22);
          stroke(g, [[X, Y0], [X + 0.2, Y0 + L]], w, 0.4, '#c8dcef', 0.9);
          stroke(g, [[X - w * 0.25, Y0], [X - w * 0.2, Y0 + L * 0.7]], w * 0.35, 0.3, '#ffffff', 0.75);
        });
      }
    }
  }
  if (P.lichen) for (let i = 0; i < 34; i++) {
    const x = rnd() * s, y = rnd() * s, c = pick(rnd, P.lichen);
    for (let j = 0; j < 6; j++) { const xx = x + range(rnd, -9, 9), yy = y + range(rnd, -6, 6), r = range(rnd, 1.5, 3.6); wrap(s, xx, yy, r, (X, Y) => blob(g, X, Y, r, r * 0.8, 0, c, 0.4, 0.5)); }
  }
  // vertical joints (sandstone): a few dark wandering lines with a lit left lip
  if (P.joints) for (let i = 0; i < P.joints; i++) {
    const x0 = rnd() * s, y0 = rnd() * s, L = range(rnd, 50, 160), pts = [];
    let px = x0; for (let j = 0; j <= 8; j++) { pts.push([px, y0 + L * j / 8]); px += range(rnd, -2.5, 2.5); }
    wrap(s, x0, y0 + L / 2, L, (X, Y) => {
      const dx = X - x0, dy = Y - (y0 + L / 2);
      stroke(g, pts.map(([u, v]) => [u + dx - 2, v + dy]), 2.4, 1, P.light, 0.3);
      stroke(g, pts.map(([u, v]) => [u + dx, v + dy]), 2.6, 1, P.creaseC, 0.5);
    });
  }
  if (P.undercut) {     // one irregular dark hollow under a ledge
    const ms = M.filter(m => m.kind === 3);
    const m = ms.length ? pick(rnd, ms) : pick(rnd, M);
    const x = m.x + range(rnd, -0.4, 0.4) * m.rx, y = m.y + m.ry * 1.1;
    wrap(s, x, y, 60, (X, Y) => { for (let j = 0; j < 4; j++) blob(g, X + range(rnd, -26, 26), Y + range(rnd, 0, 10), range(rnd, 14, 30), range(rnd, 6, 12), range(rnd, -0.2, 0.2), P.undercut, 0.2, 0.4); });
  }
  glaze(g, s, s, P.glaze || '#ffe2b0', 0.1, 'soft-light');
  soften(cv, 0.7);
}

// ---- palettes ------------------------------------------------------------------------------

// grass: tuft palettes (root at the ground, body, lit tips, the cast shadow under a clump)
const GRASS = {
  meadow: { root: '#33502a', body: ['#5f8a32', '#679236', '#58822e', '#6e8c34'], tip: ['#b4c45c', '#c2c866', '#a8c052'], shadow: '#24361a' },
  meadowDry: { root: '#4a4a24', body: ['#8a8a3a', '#968e40', '#7e823a'], tip: ['#d8cc78', '#e2d488'], shadow: '#2e3018' },
  fields: { root: '#6a5e2a', body: ['#c8a24a', '#b8963e', '#c4a450', '#ac8e3e'], tip: ['#f0d890', '#ecd486', '#f6e2a4'], shadow: '#4a3e1e' },
  fieldsGreen: { root: '#4a4c22', body: ['#8a8e3c', '#969440', '#7e8a38'], tip: ['#d8d07a', '#e0d488'], shadow: '#34341a' },
  fieldsFringe: { root: '#3e4220', body: ['#7e8a44', '#8a9446', '#6f7e40', '#a08e48'], tip: ['#c8c070', '#d8cc78', '#b8b860'], shadow: '#2e3018' },
  badlands: { root: '#6a4a2c', body: ['#b0905a', '#a08050', '#bc9c62'], tip: ['#ecd29a', '#e4c88a'], shadow: '#6a3a22' },
  desert: { root: '#7a6440', body: ['#c4ae72', '#b8a468', '#ccb47c'], tip: ['#f2e2b4', '#ecdcaa'], shadow: '#8a6a44' },
  snow: { root: '#5a5040', body: ['#a8946a', '#b4a274', '#9a8a60'], tip: ['#e6d8aa', '#f0e4bc'], shadow: '#8c9cba' },
};

const BIO = {
  meadow: {
    grass: { dark: ['#2f5419', '#3a611f', '#2c4c1c'], mid: ['#5b8c2f', '#66983a', '#527f2b'], lit: ['#9cbf55', '#b2cc63', '#8db24a'] },
    dirt: { base: '#76583c', blot: ['#6a4e34', '#86643f', '#8e6c48', '#5e4630', '#7c6040'], clod: ['#7e5e40', '#8a6a48', '#6e5238', '#947454'], peb: ['#a89478', '#94826a', '#b4a488', '#7a6a5c'], gap: '#2e2018' },
    road: { base: '#86603e', blot: ['#7a5436', '#986e48', '#a07652', '#6e4c32', '#8e6644'], clod: ['#8c6442', '#98704c', '#7a5638', '#a27a54'], peb: ['#b09a7a', '#9a8468', '#c0aa8a', '#80705e'],
      gap: '#3a2618', edge: '#5f4430', crown: '#b08e68', rut: '#5e4030', rutDark: '#3e2a20', rutLit: '#c8a878' },
  },
  fields: {
    grass: { dark: ['#6b5f2a', '#5d5a26', '#706430'], mid: ['#b49a4c', '#c2a654', '#a89246', '#9a9a48'], lit: ['#e2c56a', '#ecd486', '#d8bd62'] },
    dirt: { base: '#98784e', blot: ['#8a6a44', '#a8865a', '#b08c5e', '#80603e', '#9c7c52'], clod: ['#a07e54', '#b08e62', '#8a6a46', '#b89a6e'], peb: ['#c4ae88', '#ac9672', '#d4c09c', '#8c7a62'], gap: '#4a3420' },
    road: { base: '#b4966a', blot: ['#a88a5e', '#c4a678', '#caae80', '#9c7e56', '#b89a6e'], clod: ['#bc9e72', '#c8ac80', '#a88a60', '#d0b68a'], peb: ['#d4c0a0', '#bca888', '#e0d0b0', '#9c8a70'],
      gap: '#5a4430', edge: '#8a7040', crown: '#d8c094', rut: '#8a6c48', rutDark: '#5e4834', rutLit: '#e2cca0' },
  },
  snow: {
    road: { base: '#d0d6de', blot: ['#c4ccd6', '#dce2e8', '#e6eaee', '#b8c0cc', '#d6dce4'], clod: ['#dfe4ea', '#eaeef2', '#c8d0da', '#f2f4f6'], peb: ['#7a7470', '#8e8880', '#6a6670', '#9a948a'],
      gap: '#7c8aa6', edge: '#a8b6ca', crown: '#eef2f6', rut: '#8e8c8a', rutDark: '#5a5650', rutLit: '#f0f2f4' },
  },
  badlands: {
    dirt: { base: '#b4865e', blot: ['#a87850', '#c09068', '#c89a70', '#9c6e48', '#b88a60'], clod: ['#bc8c62', '#c89a70', '#a87a52', '#d0a47a'], peb: ['#b07454', '#9a6448', '#c48c68', '#8a6a5a'], gap: '#5a3020' },
    road: { base: '#94583a', blot: ['#8a5034', '#a2623e', '#9c5c3c', '#7e4a32', '#a86a46'], clod: ['#9a5c3c', '#a86a46', '#8a5034', '#b47450'], peb: ['#b07858', '#8e5a42', '#c48a64', '#7a5a4c', '#a08070'],
      gap: '#3e1e16', edge: '#7a4430', crown: '#b07a56', rut: '#6e3e2a', rutDark: '#4a2418', rutLit: '#c88c64' },
  },
  desert: {
    dirt: { base: '#c4a070', blot: ['#b89060', '#d0ac7c', '#c89c68', '#ac8656', '#d4b484'], clod: ['#caa676', '#d6b484', '#b8925e', '#dcbc8c'], peb: ['#d8c4a0', '#bca07c', '#e6d4b0', '#a08a70'], gap: '#7a5a3a' },
    road: { base: '#d0aa76', blot: ['#c49c6a', '#dab886', '#e0c08e', '#b89060', '#d4b080'], clod: ['#d6b282', '#e0c090', '#c4a070', '#e8cc9c'], peb: ['#dccaa6', '#c0a682', '#e8d8b6', '#a89070'],
      gap: '#8a6a44', edge: '#b89060', crown: '#ead0a0', rut: '#b08a5e', rutDark: '#8a6a48', rutLit: '#f2dcae' },
  },
};

// ---- grass in clusters ----------------------------------------------------------------------------

// Short grass the way Elwynn's is painted: clusters of 3-6 blades of 6-14 px fanning out of one
// root (within about 35 degrees of straight up, the whole cluster turned a little at random), each
// blade from a dark root through its body colour to a lit tip. Painted at full strength into a
// layer and laid down once at alpha.
function vTufts(g, s, rnd, n, { root, body, tip, len = [6, 14], wid = [1.8, 2.8], k = [3, 6], fan = 0.6, turn = 0.45, where = null, alpha = 1, bend = 0.25, shadow = null, shadowA = 0.3 }) {
  const C = [];
  for (let i = 0; i < n * 4 && C.length < n; i++) { const x = rnd() * s, y = rnd() * s; if (!where || rnd() < where(x, y)) C.push([x, y]); }
  C.sort((a, b) => a[1] - b[1]);
  if (shadow) layered(g, s, shadowA, lg => { for (const [x, y] of C) wrap(s, x, y, 12, (X, Y) => blob(lg, X + 3, Y + 1, 6, 3, 0.2, shadow, 1, 0.4)); });
  layered(g, s, alpha, lg => {
    for (const [x, y] of C) {
      const m = Math.round(range(rnd, k[0], k[1])), rot = range(rnd, -turn, turn), b = pick(rnd, body), tp = pick(rnd, tip);
      const B = [];
      for (let j = 0; j < m; j++) B.push({ a: rot + range(rnd, -fan, fan), L: range(rnd, len[0], len[1]), w: range(rnd, wid[0], wid[1]), bd: range(rnd, -bend, bend), dx: range(rnd, -1.5, 1.5) });
      B.sort((p, q) => Math.abs(q.a - rot) - Math.abs(p.a - rot));            // outer blades first
      wrap(s, x, y, len[1] + 4, (X, Y) => {
        for (const bl of B) {
          const ex = X + bl.dx + Math.sin(bl.a) * bl.L, ey = Y - Math.cos(bl.a) * bl.L;
          const gr = lg.createLinearGradient(X + bl.dx, Y, ex, ey);
          gr.addColorStop(0, root); gr.addColorStop(0.45, b); gr.addColorStop(1, (bl.a - rot) > 0.25 ? mix(tp, b, 0.4) : tp);
          blade2(lg, X + bl.dx, Y, bl.L, bl.a, bl.w, gr, bl.bd);
        }
      });
    }
  });
}

// A few small daisy clusters (4-6 heads of 3-5 px), never single specks.
function daisies(g, s, rnd, n, petal = ['#fbf6e8', '#f8f0d8'], eye = '#e8b030') {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s, m = 4 + Math.floor(rnd() * 3);
    for (let j = 0; j < m; j++) {
      const px = x + range(rnd, -9, 9), py = y + range(rnd, -6, 6), r = range(rnd, 1.8, 2.6), c = pick(rnd, petal);
      wrap(s, px, py, 8, (X, Y) => {
        blob(g, X + 1.2, Y + 1.4, r * 1.6, r * 1.3, 0, '#1e2a14', 0.35, 0.4);
        ellipse(g, X, Y, r * 1.3, r * 1.1, 0, c);
        ellipse(g, X + 0.2, Y + 0.2, r * 0.45, r * 0.4, 0, eye);
      });
    }
  }
}

// Soft scuffs and boot smears: a dark smear with a lit far edge.
function scuffs(g, s, rnd, n, base, r = [6, 11]) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s, rr = range(rnd, r[0], r[1]), rot = rnd() * TAU;
    wrap(s, x, y, rr * 2, (X, Y) => { blob(g, X, Y, rr, rr * 0.45, rot, shadowOf(base, 0.35), 0.3, 0.5); blob(g, X + 1.5, Y + 2, rr * 0.8, rr * 0.3, rot, lightOf(base, 0.3), 0.26, 0.5); });
  }
}

// One or two shallow dried-puddle hollows: a pale silt fill cracked into small plates, a dark damp rim.
function driedPuddles(g, s, rnd, n, { silt, crack, rim, r = [34, 60] }) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s, R = range(rnd, r[0], r[1]), rot = rnd() * TAU, sq = range(rnd, 0.55, 0.8);
    const L = makeCanvas(s), lg = L.getContext('2d');
    wrap(s, x, y, R * 1.4, (X, Y) => { blob(lg, X, Y, R * 1.12, R * sq * 1.12, rot, rim, 0.5, 0.5); blob(lg, X, Y, R, R * sq, rot, silt, 1, 0.82); });
    // small plates: short cracks inside the hollow only
    lg.globalCompositeOperation = 'source-atop';
    const F = worley(s, 30, rnd, 0.9), img = lg.getImageData(0, 0, s, s), D = img.data, C = hex(crack), Lt = hex(lightOf(silt, 0.3));
    for (let k = 0; k < s * s; k++) {
      if (D[k * 4 + 3] < 200) continue;
      const e = F.edge[k];
      if (e < 1.2) { const a = 0.65; D[k * 4] += (C.r - D[k * 4]) * a; D[k * 4 + 1] += (C.g - D[k * 4 + 1]) * a; D[k * 4 + 2] += (C.b - D[k * 4 + 2]) * a; }
      else if (e < 3 && F.dirx[k] + F.diry[k] < 0) { const a = 0.35; D[k * 4] += (Lt.r - D[k * 4]) * a; D[k * 4 + 1] += (Lt.g - D[k * 4 + 1]) * a; D[k * 4 + 2] += (Lt.b - D[k * 4 + 2]) * a; }
    }
    lg.putImageData(img, 0, 0);
    g.drawImage(L, 0, 0);
  }
}

// Hardpan cracked into plates, but only in two or three soft-edged patches per tile (at most a
// quarter of it): plates of very different sizes (a power diagram, three to one), soft grout along
// their borders and a thin lit lip on the upper-left side of each crack, faded out at the patch edge.
function crackPatches(g, s, rnd, { n = [2, 3], r = [44, 72], cells = 9, grout, lit, groutA = 0.12, litA = 0.22, tone = 0.05 }) {
  const cores = [], k = Math.round(range(rnd, n[0], n[1] + 0.99));
  for (let i = 0; i < Math.min(n[1], k); i++) {
    let x = rnd() * s, y = rnd() * s; const a = rnd() * TAU, m = 2 + Math.floor(rnd() * 2), R = range(rnd, r[0], r[1]);
    for (let j = 0; j < m; j++) { cores.push([x, y, R * range(rnd, 0.6, 1)]); x += Math.cos(a + range(rnd, -0.7, 0.7)) * R * 0.7; y += Math.sin(a + range(rnd, -0.7, 0.7)) * R * 0.7; }
  }
  const M0 = coreMask(s, cores), WN = fbmLo(rnd, s, 3, 8, 0.6);
  const C = powerCells(rnd, s, cells, cells, 0.9, 0.55, () => ({ t: range(rnd, -1, 1) }));
  const G = hex(grout), L = hex(lit), out = [0, 0, 0, 0, 0];
  const img = g.getImageData(0, 0, s, s), D = img.data;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const i = y * s + x, m = sst(0.05, 0.45, M0(x, y) + WN[i] * 0.25);
    if (m <= 0.01) continue;
    powerAt(C, s, x, y, out);
    const e = out[2], o = i * 4, tk = 1 + C.seeds[out[0]].t * tone * m;
    D[o] *= tk; D[o + 1] *= tk; D[o + 2] *= tk;
    const ga = sst(2.2, 0.3, e) * groutA * m;
    if (ga > 0) { D[o] += (G.r - D[o]) * ga; D[o + 1] += (G.g - D[o + 1]) * ga; D[o + 2] += (G.b - D[o + 2]) * ga; }
    else if (e < 4 && out[3] + out[4] < 0) { const la = sst(4, 2, e) * litA * m; D[o] += (L.r - D[o]) * la; D[o + 1] += (L.g - D[o + 1]) * la; D[o + 2] += (L.b - D[o + 2]) * la; }
  }
  g.putImageData(img, 0, 0);
}

// ---- ground: meadow (Elwynn) ----------------------------------------------------------------

register('ground_meadow', {
  family: 'terrain', size: 512, note: 'anchor: Elwynn grass: tone fields, dry yellow and brown patches, dark hollows, short V-shaped blade clusters with yellow tips, a few lit clumps',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#506e2c');
    mottle(g, s, rnd, { colors: ['#4a6a2a', '#60822f', '#6c8a34', '#52722c', '#768a38', '#5a7a2e'], count: 40, rmin: 60, rmax: 170, alpha: 0.5, hard: 0.1 });
    const dry = []; for (let i = 0; i < 9; i++) dry.push([rnd() * s, rnd() * s, range(rnd, 60, 110)]);
    for (const [x, y, r] of dry) wrap(s, x, y, r * 1.3, (X, Y) => blob(g, X, Y, r, r * 0.8, 0.4, '#8e8a3c', 0.45, 0.25));
    for (let i = 0; i < 4; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 30, 60); wrap(s, x, y, r * 1.3, (X, Y) => blob(g, X, Y, r, r * 0.75, 0.2, '#86683e', 0.4, 0.3)); }
    for (let i = 0; i < 7; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 50, 90); wrap(s, x, y, r * 1.3, (X, Y) => blob(g, X, Y, r, r * 0.8, 0.6, '#3e5a30', 0.42, 0.25)); }
    blurWrap(cv, 3);
    const isDry = coreMask(s, dry), M = massField(rnd, s, 7, 0.9);
    toneBy(g, s, M.F, '#34522a', '#7e9c40', 0.4, 0.3);
    // short blade clusters in three values: dark ones under, mid ones, lit yellow tips in the masses
    vTufts(g, s, rnd, 520, { root: '#22381a', body: ['#2c4a1c', '#32521f', '#2a441c'], tip: ['#4a6e2a', '#527a2c'], len: [10, 19], wid: [2.4, 3.6], alpha: 0.7, where: (x, y) => 1.1 - M(x, y) * 0.7 });
    vTufts(g, s, rnd, 600, { root: '#3f5a22', body: ['#5e8a32', '#6a9238', '#58842e', '#66903a'], tip: ['#9cb447', '#a8bc4c', '#8eac42'], len: [9, 17], wid: [2.2, 3.2], alpha: 0.85, where: (x, y) => 0.3 + M(x, y) * 0.7 });
    vTufts(g, s, rnd, 160, { root: '#4a4a24', body: ['#8a8a3a', '#968e40'], tip: ['#d8cc78', '#e2d488'], len: [7, 13], wid: [2, 2.8], alpha: 0.85, where: (x, y) => Math.min(1, isDry(x, y) * 2.5) });
    grassTufts(g, s, rnd, 120, { ...GRASS.meadow, r: [9, 18], blades: [6, 10], len: [12, 24], wid: [3, 4.6], lean: [-0.35, 0.35], where: (x, y) => (0.15 + M(x, y) * 0.85) * (1 - isDry(x, y) * 0.9) });
    vTufts(g, s, rnd, 380, { root: '#4a6a28', body: ['#7aa040', '#86a844'], tip: ['#b8c850', '#d0c860', '#c2c866'], len: [8, 15], wid: [2, 2.8], alpha: 0.85, where: (x, y) => 0.15 + M(x, y) * M(x, y) * 0.85 });
    glaze(g, s, s, '#ffe7a0', 0.1, 'soft-light');
    soften(cv, 0.25);
  },
});

register('ground2_meadow', {
  family: 'terrain', size: 512, note: 'Elwynn: red-brown earth worn through the grass: soft cobbly clods and scuffs, stones in a few clusters, islands of grass thinning into the dirt',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7a5438');
    mottle(g, s, rnd, { colors: ['#8a5e3c', '#6a4630', '#946844', '#70503a', '#865a38', '#9a6440'], count: 46, rmin: 40, rmax: 140, alpha: 0.45, hard: 0.1 });
    blurWrap(cv, 2);
    softRelief(g, s, rnd, { g0: 9, k: 30, lit: '#a87a52', dark: '#54382a', litA: 0.3, darkA: 0.3 });
    streaks(g, s, rnd, { colors: ['#9a6a44', '#6a4630', '#a87a52'], count: 60, len: [30, 90], width: [3, 8], angle: 0.3, wobble: 0.3, alpha: 0.16 });
    scuffs(g, s, rnd, 30, '#7a5438');
    const cracksAt = crackNet(g, s, rnd, 3, { color: '#4a3022', lit: '#b08458', alpha: 0.3, litA: 0.3, len: [60, 150], width: [1, 1.6] });
    stoneClusters(g, s, rnd, 8, { colors: ['#a89478', '#94826a', '#b4a488', '#7a6a5c'], at: cracksAt.filter(() => rnd() < 0.4) });
    // islands of grass around a handful of cores, thinning into the dirt
    const cores = [];
    for (let i = 0; i < 9; i++) {            // each island a ragged chain of lobes
      let x = rnd() * s, y = rnd() * s; const a = rnd() * TAU, n = 2 + Math.floor(rnd() * 4);
      for (let k = 0; k < n; k++) { cores.push([x, y, range(rnd, 26, 62)]); x += Math.cos(a + range(rnd, -0.8, 0.8)) * range(rnd, 30, 60); y += Math.sin(a + range(rnd, -0.8, 0.8)) * range(rnd, 30, 60); }
    }
    const DN = fbmLo(rnd, s, 3, 8, 0.6), dens0 = coreMask(s, cores), dens = (x, y) => Math.max(0, dens0(x, y) + DN[(((Math.floor(y) % s) + s) % s) * s + (((Math.floor(x) % s) + s) % s)] * 0.35 - 0.05);
    for (const [cx, cy, r] of cores) { const rot = rnd() * 3; wrap(s, cx, cy, r * 1.2, (X, Y) => blob(g, X, Y, r * 0.8, r * 0.65, rot, '#3e5222', 0.45, 0.3)); }
    vTufts(g, s, rnd, 760, { root: '#22381a', body: ['#2c4a1c', '#32521f'], tip: ['#4a6e2a'], len: [8, 15], wid: [2.2, 3.2], alpha: 0.8, where: (x, y) => Math.min(1, dens(x, y) * 2.4) });
    vTufts(g, s, rnd, 760, { root: '#3f5a22', body: ['#5e8a32', '#6a9238', '#58842e'], tip: ['#9cb447', '#b8c850', '#c8d060'], len: [7, 13], wid: [2, 3], alpha: 0.9, where: (x, y) => Math.min(1, dens(x, y) * 2) });
    bladePass(g, s, rnd, 700, ['#6a4a30', '#8a6644', '#5e8a32', '#7a8a3a'], [5, 10], [1.2, 2], 0.5, [-0.6, 0.6], [-0.2, 0.3]);   // grain and stray blades over the dirt
    grassTufts(g, s, rnd, 110, { ...GRASS.meadow, r: [8, 16], blades: [5, 10], len: [12, 22], wid: [3, 4.4], lean: [-0.35, 0.35], where: (x, y) => Math.min(1, dens(x, y) * 2.2) });
    vTufts(g, s, rnd, 150, { root: '#4a4a24', body: ['#8a8a3a', '#7e823a'], tip: ['#d8cc78', '#c8c868'], len: [6, 12], wid: [1.8, 2.6], alpha: 0.85, where: (x, y) => (dens(x, y) > 0.0 && dens(x, y) < 0.3 ? 1 : 0.12) });
    glaze(g, s, s, '#ffe0a0', 0.08, 'soft-light');
    soften(cv, 0.25);
  },
});

// ---- ground: fields (Westfall) --------------------------------------------------------------

register('ground_fields', {
  family: 'terrain', size: 512, note: 'Westfall: golden dry grass, short straw clusters with pale tips over dark gaps, golden clumps',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#b4944a');
    mottle(g, s, rnd, { colors: ['#c4a24e', '#a88a40', '#d2b05a', '#9e8642', '#b89848', '#c8a456'], count: 44, rmin: 60, rmax: 160, alpha: 0.45, hard: 0.1 });
    // olive and green-gold patches (about a quarter of the ground, the rest stays gold), and darker
    // straw in the hollows, so the fields are amber with olive, never one sepia wash
    const green = []; for (let i = 0; i < 7; i++) green.push([rnd() * s, rnd() * s, range(rnd, 48, 86)]);
    for (const [x, y, r] of green) wrap(s, x, y, r * 1.3, (X, Y) => { blob(g, X, Y, r, r * 0.8, 0.3, pick(rnd, ['#8a9446', '#6f7e40', '#7e8a44']), 0.55, 0.3); blob(g, X + r * 0.2, Y - r * 0.1, r * 0.55, r * 0.45, 0.3, '#6f7e40', 0.35, 0.3); });
    for (let i = 0; i < 8; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 40, 80); wrap(s, x, y, r * 1.3, (X, Y) => blob(g, X, Y, r, r * 0.7, 0.4, pick(rnd, ['#7a6a34', '#8a6e3a']), 0.4, 0.3)); }
    blurWrap(cv, 3);
    const isGreen = coreMask(s, green), M = massField(rnd, s, 7, 0.9);
    toneBy(g, s, M.F, '#7a6230', '#e0c070', 0.4, 0.32);
    vTufts(g, s, rnd, 420, { root: '#4a3e1c', body: ['#6a5a28', '#5e5024', '#705e2c'], tip: ['#9a8442'], len: [10, 19], wid: [2.2, 3.2], alpha: 0.7, fan: 0.5, where: (x, y) => 1.1 - M(x, y) * 0.7 });
    vTufts(g, s, rnd, 560, { root: '#8a7a3a', body: ['#c8a24a', '#bc9a44', '#d0ac52'], tip: ['#f0d888', '#ecd486'], len: [9, 17], wid: [2, 3], alpha: 0.85, fan: 0.5, where: (x, y) => (0.25 + M(x, y) * 0.75) * (1 - isGreen(x, y)) });
    grassTufts(g, s, rnd, 150, { ...GRASS.fields, r: [10, 20], blades: [7, 12], len: [14, 28], wid: [2.6, 4.2], lean: [-0.3, 0.3], where: (x, y) => (0.2 + M(x, y) * 0.8) * (1 - isGreen(x, y)) });
    vTufts(g, s, rnd, 260, { root: '#3e4220', body: ['#7e8a44', '#8a9446', '#6f7e40'], tip: ['#c8c070', '#d8d07a'], len: [7, 14], wid: [2, 2.8], alpha: 0.88, where: (x, y) => Math.min(1, isGreen(x, y) * 3) });
    vTufts(g, s, rnd, 300, { root: '#a08a44', body: ['#e2c56a', '#d8bc60'], tip: ['#f6e4a4', '#f0d888'], len: [6, 12], wid: [1.6, 2.4], alpha: 0.85, fan: 0.5, where: (x, y) => M(x, y) * M(x, y) });
    glaze(g, s, s, '#ffe6a0', 0.12, 'soft-light');
    soften(cv, 0.25);
  },
});

register('ground2_fields', {
  family: 'terrain', size: 512, note: 'Westfall: grazed dusty pasture, short olive-gold tufts over pale dust, soft clods, loose straw',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#a8895a');
    mottle(g, s, rnd, { colors: ['#b4966a', '#9c7e52', '#c0a274', '#94784e', '#a88a5c'], count: 44, rmin: 40, rmax: 140, alpha: 0.45, hard: 0.1 });
    blurWrap(cv, 2);
    softRelief(g, s, rnd, { g0: 9, k: 30, lit: '#d0b488', dark: '#7a5e3c', litA: 0.28, darkA: 0.26 });
    scuffs(g, s, rnd, 24, '#a8895a');
    stoneClusters(g, s, rnd, 7, { colors: ['#c4ae88', '#ac9672', '#d4c09c', '#8c7a62'], contact: '#5a4430' });
    const cores = []; for (let i = 0; i < 16; i++) cores.push([rnd() * s, rnd() * s, range(rnd, 40, 90)]);
    const dens = coreMask(s, cores);
    vTufts(g, s, rnd, 320, { root: '#4a4220', body: ['#5e5426', '#6a5e2a'], tip: ['#8a7e3a'], len: [8, 15], wid: [2, 3], alpha: 0.75, where: (x, y) => Math.min(1, dens(x, y) * 2) });
    vTufts(g, s, rnd, 320, { root: '#4a4c22', body: ['#8a8e3c', '#969440', '#7e8a38'], tip: ['#d8d07a', '#e0d488'], len: [7, 13], wid: [1.8, 2.8], alpha: 0.85, where: (x, y) => Math.min(1, dens(x, y) * 2.2) });
    grassTufts(g, s, rnd, 70, { ...GRASS.fields, r: [8, 16], blades: [6, 10], len: [12, 22], wid: [2.4, 3.8], where: (x, y) => Math.min(1, dens(x, y) * 3) });
    bladePass(g, s, rnd, 220, ['#e2c56a', '#c9a64e', '#f0dc98'], [6, 14], [1.2, 1.8], 0.6, [-1.6, 1.6], [-0.1, 0.1]);   // loose straw
    glaze(g, s, s, '#ffe6a0', 0.1, 'soft-light');
    soften(cv, 0.25);
  },
});

// ---- ground: badlands -----------------------------------------------------------------------

// A gravel wash: a wandering band of small red stones, as if washed down from the walls.
function gravelWash(g, s, rnd, n, { colors, ground, contact, width = [14, 30], count = 26 }) {
  for (let i = 0; i < n; i++) {
    const x0 = rnd() * s, y0 = rnd() * s, a0 = range(rnd, -0.6, 0.6) + Math.PI / 2, L = range(rnd, 160, 360), W = range(rnd, width[0], width[1]);
    const wob = periodic(rnd, 3, 1, 1);
    const at = t => [x0 + Math.cos(a0) * (t - 0.5) * L + Math.sin(a0) * wob(t) * 30, y0 + Math.sin(a0) * (t - 0.5) * L - Math.cos(a0) * wob(t) * 30];
    for (let k = 0; k < 12; k++) { const [x, y] = at(k / 11); wrap(s, x, y, W * 1.6, (X, Y) => blob(g, X, Y, W * 1.2, W * 0.8, a0, ground, 0.22, 0.3)); }
    const spots = [];
    for (let k = 0; k < count; k++) { const t = rnd(), [x, y] = at(t), off = (rnd() - 0.5) * W * 1.6 * (1 - Math.abs(t - 0.5)); spots.push([x + Math.sin(a0) * off, y - Math.cos(a0) * off]); }
    stoneClusters(g, s, rnd, spots.length, { colors, at: spots, r: [1.4, 3.4], k: [3, 7], spread: [5, 11], sides: [4, 5], contact });
  }
}

register('ground_badlands', {
  family: 'terrain', size: 512, note: 'Badlands: pale ochre dust in soft tonal patches, open networks of wandering cracks, one or two dried-puddle hollows, red gravel washes',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#c89a6a');
    mottle(g, s, rnd, { colors: ['#d2a676', '#bc8c5e', '#d8b080', '#b48458', '#c49464'], count: 44, rmin: 50, rmax: 150, alpha: 0.45, hard: 0.1 });
    mottle(g, s, rnd, { colors: ['#b98457', '#cf9a62'], count: 30, rmin: 60, rmax: 150, alpha: 0.35, hard: 0.12 });
    mottle(g, s, rnd, { colors: ['#a86e48', '#9e6644'], count: 10, rmin: 30, rmax: 70, alpha: 0.3, hard: 0.25, stretch: 1.6 });
    blurWrap(cv, 6);
    streaks(g, s, rnd, { colors: ['#e2b884', '#b88456', '#d4a070'], count: 50, len: [30, 90], width: [5, 12], angle: 1.25, wobble: 0.15, alpha: 0.1 });
    blurWrap(cv, 2);
    const M = massField(rnd, s, 10, 2);
    toneBy(g, s, M.F, '#b07a50', '#dcb486', 0.3, 0.3);
    driedPuddles(g, s, rnd, 1, { silt: '#dcb48a', crack: '#a06a44', rim: '#a87048', r: [36, 54] });
    const along = crackNet(g, s, rnd, 5, { color: '#8a5a3a', lit: '#e8c096', alpha: 0.6, litA: 0.6, len: [120, 260], width: [1.4, 2.4] });
    gravelWash(g, s, rnd, 3, { colors: ['#a8583a', '#8e4a30', '#b86a44', '#9a6450'], ground: '#a86a44', contact: '#5a2a1a' });
    stoneClusters(g, s, rnd, 10, { colors: ['#b8704a', '#9a5a3c', '#c88a5e', '#8a5a44'], at: along.filter(() => rnd() < 0.3), r: [1.6, 4], sides: [4, 5], contact: '#5a2a1a' });
    grassTufts(g, s, rnd, 8, { ...GRASS.badlands, r: [7, 12], blades: [5, 9], len: [10, 18], wid: [2, 3.2], lean: [-0.6, 0.6], where: (x, y) => 1 - M(x, y) });
    glaze(g, s, s, '#ffd29a', 0.08, 'soft-light');
    soften(cv, 0.25);
  },
});

register('ground2_badlands', {
  family: 'terrain', size: 512, note: 'Badlands: angular red scree washed down from the walls, in drifts and dusty gaps',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#ae7a54');
    mottle(g, s, rnd, { colors: ['#a46e4a', '#bc8a60', '#a8724c', '#986444', '#c49268'], count: 44, rmin: 40, rmax: 130, alpha: 0.42, hard: 0.1 });
    blurWrap(cv, 2);
    const M = massField(rnd, s, 8, 1.4);
    toneBy(g, s, M.F, '#cc9c6c', '#904e32', 0.3, 0.35);
    layered(g, s, 0.4, lg => { for (let i = 0; i < 220; i++) { const x = rnd() * s, y = rnd() * s; if (M(x, y) < 0.5) continue; const r = range(rnd, 12, 26); wrap(s, x, y, r * 1.3, (X, Y) => blob(lg, X, Y, r, r * 0.7, 0.3, '#8a4a30', 1, 0.45)); } });
    softRelief(g, s, rnd, { g0: 10, k: 30, lit: '#c8885c', dark: '#6e3a24', litA: 0.26, darkA: 0.26 });
    const scree = ['#8e3e22', '#b4552f', '#a24a2a', '#c4683e', '#9a6450'];
    stoneClusters(g, s, rnd, 46, { colors: scree, r: [2, 5.4], k: [4, 9], spread: [7, 18], sides: [4, 5], asp: [0.4, 0.9], contact: '#4a2216', where: (x, y) => 0.1 + M(x, y) * 0.9 });
    stoneClusters(g, s, rnd, 30, { colors: scree, r: [1, 2], k: [3, 7], spread: [5, 12], sides: [4, 5], contact: '#4a2216', contactA: 0.4, where: (x, y) => 0.2 + M(x, y) * 0.8 });
    stoneClusters(g, s, rnd, 4, { colors: ['#a86444', '#b8805c'], r: [7, 12], k: [1, 3], spread: [10, 20], sides: [5, 6], contact: '#4a2216' });
    glaze(g, s, s, '#ffcf98', 0.08, 'soft-light');
    soften(cv, 0.25);
  },
});

// ---- ground: desert (Tanaris) ---------------------------------------------------------------

register('ground_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: wind-rippled sand, broad lit windward faces and short dark lees',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#dab682');
    mottle(g, s, rnd, { colors: ['#e6c894', '#d0aa72', '#c89e66', '#ecd2a0', '#d6b07c'], count: 40, rmin: 60, rmax: 170, alpha: 0.42, hard: 0.08 });
    blurWrap(cv, 3);
    mottle(g, s, rnd, { colors: ['#c49664', '#f0d8a8', '#caa070'], count: 16, rmin: 50, rmax: 110, alpha: 0.35, hard: 0.2, stretch: 1.8, rot: 0.1 });
    const H = rippleHeight(rnd, s, { per: 10, warp: 34, warp2: 7, tilt: 1, lee: 0.3, fade: [-0.25, 0.35], floor: 0.06 });
    shadeHeight(g, s, H, { k: 0.45, lit: '#f6e6c0', dark: '#b48a5e', litA: 0.6, darkA: 0.68 });
    mottle(g, s, rnd, { colors: ['#e8cc96', '#d8b47e'], count: 30, rmin: 30, rmax: 70, alpha: 0.18, hard: 0.2 });
    stoneClusters(g, s, rnd, 4, { colors: ['#c4a47c', '#a88a68', '#e0caa0', '#9a7e64'], r: [1.4, 3.2], contact: '#8a6440', contactA: 0.4 });
    glaze(g, s, s, '#ffe8b8', 0.1, 'soft-light');
    soften(cv, 0.25);
  },
});

register('ground2_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: coarse wind-packed sand, a thin crust broken by open cracks, a dried silt hollow, grit in a few clusters',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#caa06a');
    mottle(g, s, rnd, { colors: ['#b88e5c', '#d4ac78', '#c79c62', '#ad8452', '#ddb886'], count: 44, rmin: 40, rmax: 140, alpha: 0.42, hard: 0.1 });
    blurWrap(cv, 2);
    const H = rippleHeight(rnd, s, { per: 11, warp: 30, warp2: 6, tilt: -1, lee: 0.3, fade: [-0.2, 0.5], floor: 0.05 });
    shadeHeight(g, s, H, { k: 0.5, lit: '#eed6a6', dark: '#a87e54', litA: 0.45, darkA: 0.55 });
    driedPuddles(g, s, rnd, 1, { silt: '#e2c494', crack: '#a8845a', rim: '#b08a5e', r: [30, 48] });
    const along = crackNet(g, s, rnd, 4, { color: '#9a7048', lit: '#f6e2b8', alpha: 0.45, litA: 0.5, len: [100, 220], width: [1, 1.8] });
    stoneClusters(g, s, rnd, 10, { colors: ['#d8c09a', '#b89a74', '#e8d4ae', '#9c8268', '#a07a5a'], at: along.filter(() => rnd() < 0.3), r: [1.3, 3], contact: '#7a5636', contactA: 0.45 });
    grassTufts(g, s, rnd, 6, { ...GRASS.desert, r: [6, 10], blades: [5, 8], len: [8, 14], wid: [2, 3], lean: [-0.6, 0.6] });
    glaze(g, s, s, '#ffe8b8', 0.08, 'soft-light');
    soften(cv, 0.25);
  },
});

// ---- ground: snow (Dun Morogh) ----------------------------------------------------------------
// Snow is painted, not white: large faint warm and cool value fields, a few broad drifts lit on the
// upper left with a short crisp crest and a soft blue lee, faint ripples, a few things poking
// through with cool shadow rings.

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

// Something poking out of the snow: a dark stone with a snow cap, in a cool hollow.
function cappedStones(g, s, rnd, n, cols, r) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * s, y = rnd() * s, R = range(rnd, r[0], r[1]), c = pick(rnd, cols);
    wrap(s, x, y, R * 2.6, (X, Y) => blob(g, X + R * 0.2, Y + R * 0.2, R * 2, R * 1.5, 0, '#b8c6d6', 0.6, 0.45));
    stone(g, s, x, y, R, rnd, { color: c, contact: '#5a6886', contactA: 0.5, sides: 6, asp: [0.6, 0.9] });
    wrap(s, x, y, R * 2, (X, Y) => {
      blob(g, X - R * 0.15, Y - R * 0.4, R * 0.95, R * 0.45, 0, '#f2f4f6', 0.95, 0.65);   // the cap
      blob(g, X - R * 0.35, Y - R * 0.55, R * 0.45, R * 0.22, 0, '#ffffff', 0.8, 0.5);
    });
  }
}

// Dry grass poking through the snow, each tuft in a little cool hollow.
function snowGrass(g, s, rnd, n, where = null) {
  const C = [];
  for (let i = 0; i < n * 4 && C.length < n; i++) { const x = rnd() * s, y = rnd() * s; if (!where || rnd() < where(x, y)) C.push([x, y, range(rnd, 6, 12)]); }
  for (const [x, y, r] of C) wrap(s, x, y, r * 2.4, (X, Y) => {
    blob(g, X + r * 0.25, Y + r * 0.3, r * 1.8, r * 1.0, 0, '#b8c6d6', 0.7, 0.45);
    blob(g, X - r * 0.4, Y - r * 0.4, r * 1.2, r * 0.6, 0, '#9fb0c8', 0.35, 0.4);
  });
  grassTufts(g, s, rnd, C.length, { ...GRASS.snow, r: [6, 11], blades: [5, 9], len: [9, 18], wid: [1.8, 3], shadowA: 0, lean: [-0.5, 0.5], at: C });
}

register('ground_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: wind-packed snow in big faint warm and cool fields, a few broad drifts with short crisp crests and soft blue lees, faint ripples, grass tips poking through',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e6ecf2');
    mottle(g, s, rnd, { colors: ['#f7f4ec', '#e8eef4', '#dde6f0', '#f4f2ea', '#e2e9f2'], count: 26, rmin: 110, rmax: 230, alpha: 0.55, hard: 0.06 });
    mottle(g, s, rnd, { colors: ['#f7f4ec', '#d6e0ec'], count: 30, rmin: 40, rmax: 100, alpha: 0.3, hard: 0.08 });
    blurWrap(cv, 4);
    const H = driftHeight(rnd, s, 7, { len: [120, 220], wind: [60, 110], lee: [16, 28], amp: [16, 26], ang: [-0.3, 0.3], curve: 0.9, endTaper: 40 });
    const R = rippleHeight(rnd, s, { per: 16, warp: 30, warp2: 6, tilt: 1, lee: 0.3, fade: [-0.1, 0.5], floor: 0 });
    for (let i = 0; i < H.length; i++) H[i] += R[i] * 0.12;
    shadeHeight(g, s, H, { k: 0.9, lit: '#fbfaf6', dark: '#b8c8dc', litA: 0.6, darkA: 0.42 });
    snowGrass(g, s, rnd, 14);
    cappedStones(g, s, rnd, 7, ['#6f7682', '#7e8694', '#5e6472'], [2.5, 5.5]);
    glints(g, s, rnd, 40);
    glaze(g, s, s, '#e8f0ff', 0.06, 'soft-light');
    soften(cv, 0.25);
  },
});

register('ground2_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: thin windswept snow, frozen tundra grass and stones in scoured lanes',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#dce4ec');
    mottle(g, s, rnd, { colors: ['#eeece4', '#cdd8e6', '#e2e8ee', '#d4dee8'], count: 40, rmin: 50, rmax: 150, alpha: 0.45, hard: 0.08 });
    blurWrap(cv, 3);
    const Hd = driftHeight(rnd, s, 6, { len: [90, 180], wind: [40, 70], lee: [12, 22], amp: [8, 14], curve: 0.9, endTaper: 34 });
    shadeHeight(g, s, Hd, { k: 0.8, lit: '#fbf8ef', dark: '#b4c4d8', litA: 0.55, darkA: 0.42 });
    // bare lanes the wind scoured: each a chain of lobes along the wind, in a cool rim
    const cores = [];
    for (let i = 0; i < 7; i++) {
      const x = rnd() * s, y = rnd() * s, n = 3 + Math.floor(rnd() * 4), dir = range(rnd, -0.25, 0.25);
      for (let k = 0; k < n; k++) cores.push([x + k * range(rnd, 20, 40), y + k * range(rnd, 20, 40) * dir + range(rnd, -10, 10), range(rnd, 14, 28)]);
    }
    const near = coreMask(s, cores, 0.7, 1.4);
    for (const [cx, cy, r] of cores) wrap(s, cx, cy, r * 1.8, (X, Y) => {
      blob(g, X - r * 0.12, Y - r * 0.18, r * 1.55, r * 0.85, 0, '#a8b8cc', 0.45, 0.55);
      blob(g, X + r * 0.1, Y + r * 0.12, r * 1.45, r * 0.75, 0, '#f6f4ee', 0.55, 0.6);
    });
    for (const [cx, cy, r] of cores) wrap(s, cx, cy, r * 1.6, (X, Y) => { blob(g, X, Y, r * 1.2, r * 0.58, 0, '#c4bea8', 0.32, 0.5); blob(g, X - r * 0.2, Y - r * 0.1, r * 0.8, r * 0.36, 0, '#d4cebc', 0.28, 0.5); });
    vTufts(g, s, rnd, 150, { root: '#5a5040', body: ['#a8946a', '#b4a274', '#9a8a60'], tip: ['#e6d8aa', '#f0e4bc'], len: [9, 16], wid: [2, 2.8], where: (x, y) => Math.min(1, near(x, y) * 3) });
    stoneClusters(g, s, rnd, 8, { colors: ['#6f7682', '#7e8694', '#8a8e96', '#5e6472'], where: (x, y) => Math.min(1, near(x, y) * 3), contact: '#3a3e4a', contactA: 0.45 });
    snowGrass(g, s, rnd, 8);
    cappedStones(g, s, rnd, 6, ['#6f7682', '#7e8694'], [3, 6]);
    glints(g, s, rnd, 26);
    glaze(g, s, s, '#eaf0ff', 0.08, 'soft-light');
    soften(cv, 0.25);
  },
});

register('dirt_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: trampled snow churned with frozen mud and straw (camps, doorsteps): soft trodden patches, a few boot-print trails',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#bcc2ca');
    mottle(g, s, rnd, { colors: ['#c8ced6', '#a8acb2', '#d6dce2', '#9e9890', '#b4b6b6'], count: 50, rmin: 40, rmax: 140, alpha: 0.45, hard: 0.1 });
    mottle(g, s, rnd, { colors: ['#7e7468', '#8a8070', '#6e665c'], count: 22, rmin: 16, rmax: 50, alpha: 0.2, hard: 0.15, stretch: 1.4 });
    blurWrap(cv, 3);
    softRelief(g, s, rnd, { g0: 8, k: 30, lit: '#f2f4f6', dark: '#98a4b8', litA: 0.32, darkA: 0.3 });
    // trodden patches: soft cool hollows with a lit far rim
    for (let i = 0; i < 34; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 14, 34), rot = rnd() * TAU;
      wrap(s, x, y, r * 1.6, (X, Y) => { blob(g, X, Y, r, r * 0.6, rot, '#98a6bc', 0.22, 0.3); blob(g, X + r * 0.25, Y + r * 0.3, r * 0.7, r * 0.35, rot, '#f2f4f6', 0.24, 0.35); });
    }
    // a few trails of boot prints: pairs, left and right, walking somewhere
    for (let t = 0; t < 4; t++) {
      let x = rnd() * s, y = rnd() * s; const a = rnd() * TAU, n = 6 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) {
        const side = i % 2 ? 1 : -1, px = x + Math.cos(a + Math.PI / 2) * side * 5, py = y + Math.sin(a + Math.PI / 2) * side * 5;
        wrap(s, px, py, 14, (X, Y) => {
          blob(g, X, Y, 7.5, 3.4, a, '#76849e', 0.55, 0.6);
          blob(g, X + 1.2, Y + 1.4, 5, 2, a, '#eef0f2', 0.35, 0.5);
          blob(g, X + Math.cos(a) * 7, Y + Math.sin(a) * 7, 3.2, 2.6, a, '#7e8ca6', 0.38, 0.55);
        });
        x += Math.cos(a) * 18; y += Math.sin(a) * 18;
      }
    }
    stoneClusters(g, s, rnd, 6, { colors: ['#7e8694', '#8a8e96', '#6a6460', '#9a948a'], contact: '#3a3e4a', contactA: 0.4 });
    bladePass(g, s, rnd, 110, ['#c8b07a', '#b09860', '#d8c48e'], [5, 11], [1.2, 1.8], 0.7, [-1.6, 1.6], [-0.15, 0.15]);
    glaze(g, s, s, '#eef2ff', 0.08, 'soft-light');
    soften(cv, 0.45);
  },
});

// ---- dirt, per biome ---------------------------------------------------------------------------

for (const b of ['meadow', 'fields', 'badlands', 'desert']) {
  register(`dirt_${b}`, {
    family: 'terrain', size: 512, note: `${b}: bare packed dirt for clearings: soft cobbly clods, scuffs, stones in a few clusters, trodden straw`,
    paint(g, s, rnd, h, cv) {
      const P = BIO[b].dirt;
      fill(g, s, s, P.base);
      mottle(g, s, rnd, { colors: P.blot, count: 50, rmin: 40, rmax: 140, alpha: 0.4, hard: 0.1 });
      blurWrap(cv, 2);
      const M = massField(rnd, s, 5, 0.8);
      toneBy(g, s, M.F, shadowOf(P.base, 0.3), lightOf(P.base, 0.25), 0.36, 0.28);
      const hard = b === 'badlands' || b === 'desert';
      // a faint lumpy grain only (no cobbles); the hardpan cracks into plates in a few patches
      softRelief(g, s, rnd, { g0: 8, k: 24, lit: lightOf(P.base, 0.35), dark: shadowOf(P.base, 0.3), litA: 0.22, darkA: 0.2 });
      if (hard) {
        streaks(g, s, rnd, { colors: [lightOf(P.base, 0.25), shadowOf(P.base, 0.2), lightOf(P.base, 0.4)], count: 120, len: [40, 140], width: [3, 10], angle: 1.25, wobble: 0.12, alpha: 0.14 });   // wind-streaked dust
        crackPatches(g, s, rnd, { n: [2, 3], cells: 9, grout: shadowOf(P.base, 0.6), lit: lightOf(P.base, 0.5), groutA: 0.12, litA: 0.3 });
      } else {
        streaks(g, s, rnd, { colors: [lightOf(P.base, 0.25), shadowOf(P.base, 0.2)], count: 70, len: [30, 90], width: [3, 8], angle: 0.4, wobble: 0.4, alpha: 0.14 });
      }
      scuffs(g, s, rnd, 40, P.base);
      stoneClusters(g, s, rnd, hard ? 14 : 9, { colors: P.peb, r: [1.4, 3.6], contact: P.gap, contactA: 0.45 });
      lumps(g, s, rnd, 220, { r: [0.9, 1.9], colors: P.peb, shadow: P.gap, shadowA: 0.45, sides: 6, litA: 0.8, shadeA: 0.5 });
      const G = GRASS[b];
      bladePass(g, s, rnd, b === 'desert' ? 16 : 60, [...G.body, G.root], [6, 12], [1.2, 1.9], 0.6, [-1.6, 1.6]);
      glaze(g, s, s, '#ffdca0', 0.06, 'soft-light');
      soften(cv, 0.45);
    },
  });
}

// ---- roads (road space) -----------------------------------------------------------------------

register('road_meadow', {
  family: 'terrain', size: 512, note: 'anchor: Elwynn red-brown packed dirt road: packed earth streaked along its length, lighter wheel-polished tracks, darker damp patches, broken shallow ruts, pebble clusters, a broken grassy crown, ragged grass at the edges',
  paint(g, s, rnd) {
    const c = s / 2, mpx = s / 10;
    fill(g, s, s, '#8a5a3a');
    // big soft blotches stretched 3-4x along the road
    mottle(g, s, rnd, { colors: ['#a0603a', '#9a7650', '#7e5034', '#94643e', '#a86c44', '#8c6a48'], count: 60, rmin: 26, rmax: 90, alpha: 0.45, hard: 0.1, stretch: 3.6, rot: Math.PI / 2 });
    roadProfile(g, s, '#6a4630', '#b08a64');
    blurWrap(g.canvas, 2);
    // the packed surface: only a faint lumpy grain (no cobbles)
    softRelief(g, s, rnd, { g0: 10, aniso: 0.4, k: 22, lit: '#bc8e62', dark: '#5e3c26', litA: 0.2, darkA: 0.17 });
    // lengthwise character: long soft streaks, lighter polished tracks, darker damp patches
    streaks(g, s, rnd, { colors: ['#a87a52', '#b48a62', '#6e4a30', '#7a5236', '#9a6a44'], count: 110, len: [70, 220], width: [3, 10], angle: 0, wobble: 0.06, alpha: 0.2 });
    worn(g, s, rnd, 22, [c - 1.1 * mpx, c, c + 1.1 * mpx], '#bc946c', [0.3, 0.55], [10, 22], [50, 140]);
    worn(g, s, rnd, 9, [c - 1.1 * mpx, c + 1.15 * mpx], '#5a3a26', [0.22, 0.36], [10, 20], [30, 90]);
    softRuts(g, s, rnd, [c - 1.1 * mpx, c + 1.15 * mpx], { w: 1.2 * mpx, color: '#64422c', alpha: 0.4, presence: 0.62 });
    streaks(g, s, rnd, { colors: ['#4e3022', '#c09068'], count: 40, len: [40, 120], width: [1.2, 2.4], angle: 0, wobble: 0.1, alpha: 0.22 });   // wheel scratches
    const along = crackNet(g, s, rnd, 2, { color: '#4e3022', lit: '#c8986a', alpha: 0.22, litA: 0.24, len: [60, 140], width: [1, 1.6] });
    stoneClusters(g, s, rnd, 16, { colors: ['#b09a7a', '#9a8468', '#c0aa8a', '#80705e'], r: [1.4, 3.6], at: along.filter(() => rnd() < 0.35), where: x => (Math.abs(x - c) < 2.8 * mpx ? (Math.abs(Math.abs(x - c) - 1.1 * mpx) < 0.4 * mpx ? 0.2 : 1) : 0.15) });
    lumps(g, s, rnd, 160, { r: [1, 2.2], colors: ['#b09a7a', '#9a8468', '#c0aa8a'], where: x => (Math.abs(x - c) < 3 * mpx ? 0.7 : 0.2), shadow: '#3a2618', shadowA: 0.5, sides: 6, litA: 0.8, shadeA: 0.5 });
    roadGrass(g, s, rnd, c, mpx, GRASS.meadow, { crown: true, edgeN: 150, crownN: 30, fineN: 360, crownOn: 0.4 });
    glaze(g, s, s, '#ffdca0', 0.08, 'soft-light');
    soften(g.canvas, 0.35);
  },
});
register('road_fields', {
  family: 'terrain', size: 512, note: 'Westfall: a darker dusty cart road between the gold: hoof-churned middle, two soft ruts, straw, an olive grass fringe at the edges and a few tufts on the crown',
  paint(g, s, rnd) {
    const c = s / 2, mpx = s / 10;
    fill(g, s, s, '#94704a');
    mottle(g, s, rnd, { colors: ['#8a6844', '#a2805a', '#a88660', '#7e5e3e', '#9a7852'], count: 56, rmin: 26, rmax: 100, alpha: 0.42, hard: 0.1, stretch: 3.2, rot: Math.PI / 2 });
    roadProfile(g, s, '#6e5034', '#c0a27a');
    blurWrap(g.canvas, 2);
    softRelief(g, s, rnd, { g0: 10, aniso: 0.4, k: 22, lit: '#c4a47c', dark: '#6a4c30', litA: 0.2, darkA: 0.17 });
    streaks(g, s, rnd, { colors: ['#b49470', '#c2a47e', '#6e5034', '#7e6040'], count: 100, len: [60, 200], width: [3, 9], angle: 0, wobble: 0.06, alpha: 0.2 });
    worn(g, s, rnd, 16, [c - 1.4 * mpx, c + 1.4 * mpx], '#c8aa80', [0.25, 0.42]);
    softRuts(g, s, rnd, [c - 1.15 * mpx, c + 1.1 * mpx], { w: 1.1 * mpx, color: '#6e5034', alpha: 0.38, presence: 0.65 });
    // the middle, churned by hooves: scuffs and hoofprints, densest on the crown
    for (let i = 0; i < 110; i++) {
      const x = c + range(rnd, -1, 1) * range(rnd, 0, 0.8) * mpx, y = rnd() * s, r = range(rnd, 4, 7), rot = range(rnd, -0.5, 0.5) + Math.PI / 2;
      wrap(s, x, y, r * 2, (X, Y) => { blob(g, X, Y, r, r * 0.55, rot, '#6e5034', 0.3, 0.5); blob(g, X + 1.2, Y + 1.6, r * 0.8, r * 0.3, rot, '#c8aa80', 0.3, 0.5); });
    }
    for (let i = 0; i < 26; i++) {
      const x = c + range(rnd, -0.6, 0.6) * mpx, y = rnd() * s, r = range(rnd, 3.5, 5.5);
      wrap(s, x, y, r * 2, (X, Y) => {
        g.save(); g.lineCap = 'round';
        g.strokeStyle = rgba('#5e4430', 0.36); g.lineWidth = 2.6; g.beginPath(); g.arc(X, Y, r, Math.PI * 0.85, Math.PI * 2.15); g.stroke();
        g.strokeStyle = rgba('#d0b48a', 0.28); g.lineWidth = 1.2; g.beginPath(); g.arc(X + 1, Y + 1.2, r, Math.PI * 1.1, Math.PI * 1.9); g.stroke();
        g.restore();
      });
    }
    stoneClusters(g, s, rnd, 8, { colors: ['#c4ae88', '#ac9672', '#d4c09c', '#8c7a62'], where: x => (Math.abs(x - c) < 2.6 * mpx ? 1 : 0.1), contact: '#5a4430' });
    bladePass(g, s, rnd, 200, ['#e2c56a', '#c9a64e', '#f0dc98', '#b8963e'], [7, 15], [1.3, 2], 0.7, [-1.6, 1.6], [-0.1, 0.1]);   // loose straw
    roadGrass(g, s, rnd, c, mpx, GRASS.fieldsFringe, { crown: true, edgeN: 170, crownN: 22, fineN: 520, crownOn: 0.35 });
    glaze(g, s, s, '#ffe2a8', 0.07, 'soft-light');
    soften(g.canvas, 0.35);
  },
});
register('road_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh: trampled packed snow, gravel and slush only in the ruts, snow berms along both edges (road space)',
  paint(g, s, rnd) {
    paintRoad(g, s, rnd, { ...BIO.snow.road, clods: 180, clodR: [3, 7], pebN: 0, stoneN: 0, rutW: 0.6, rimA: 0.45, glaze: '#e8f0ff',
      extra(g, s, rnd, c, mpx, ruts) {
        // gravel and grit thrown into the ruts
        for (const rx of ruts) for (let i = 0; i < 170; i++) {
          const y = rnd() * s, x = rx(y) + range(rnd, -0.3, 0.3) * mpx;
          lump(g, s, x, y, range(rnd, 1.2, 2.8), rnd, { color: jitter(pick(rnd, BIO.snow.road.peb), rnd, 0.06), shadow: '#3a3634', shadowA: 0.5, sides: 5, jag: 0.35 });
        }
        // glassy ice in the ruts
        for (const rx of ruts) for (let i = 0; i < 8; i++) {
          const y = rnd() * s, L = range(rnd, 14, 36);
          wrap(s, rx(y), y, L, (X, Y) => { blob(g, X, Y, 8, L, 0, '#5a6276', 0.3, 0.55); blob(g, X - 2.5, Y - L * 0.25, 3, L * 0.55, 0, '#d8e4f0', 0.45, 0.45); });
        }
        // tread marks across the packed snow between the ruts
        for (const rx of ruts) for (let y = 0; y < s; y += 7) wrap(s, rx(y), y, 14, (X, Y) => blob(g, X, Y, 9, 1.6, 0, '#9aa8bc', 0.25, 0.6));
        // berms: a continuous bank along each edge, lit left flank, crisp crest, blue right flank
        for (const side of [-1, 1]) {
          const wob = periodic(rnd, 5, 1, 1), wid = periodic(rnd, 4, 1, 2);
          const H = new Float32Array(s * s);
          for (let y = 0; y < s; y++) {
            const x0 = c + side * (3.25 + wob(y / s) * 0.25) * mpx, w = (0.75 + wid(y / s) * 0.2) * mpx;
            for (let x = 0; x < s; x++) { const u = (x - x0) / w; if (Math.abs(u) < 1.6) H[y * s + x] = Math.max(0, 1 - u * u * (u * side > 0 ? 0.5 : 1)) * 20; }
          }
          const M = new Float32Array(s * s); for (let i = 0; i < M.length; i++) M[i] = Math.min(1, H[i] / 4);
          const img = g.getImageData(0, 0, s, s), D = img.data;
          const W = hex('#e6ebf0');
          for (let i = 0; i < M.length; i++) { const a = M[i] * 0.9; D[i * 4] += (W.r - D[i * 4]) * a; D[i * 4 + 1] += (W.g - D[i * 4 + 1]) * a; D[i * 4 + 2] += (W.b - D[i * 4 + 2]) * a; }
          g.putImageData(img, 0, 0);
          shadeHeight(g, s, H, { k: 1.4, lit: '#f6f6f4', dark: '#a8b8cc', litA: 0.8, darkA: 0.85, mask: M });
        }
        lumps(g, s, rnd, 70, { r: [3, 7], colors: ['#eef2f6', '#e2e8ee'], lit: '#ffffff', shade: '#b4c2d4', shadow: '#8494b0', shadowA: 0.35, where: x => (Math.abs(Math.abs(x - c) - 3.2 * mpx) < 0.8 * mpx ? 1 : 0) });
        glints(g, s, rnd, 24);
      } });
  },
});
register('road_badlands', {
  family: 'terrain', size: 512, note: 'Badlands: dark red compacted gravel, one wandering track, angular gravel in clusters, dust blown onto the shoulders',
  paint(g, s, rnd) {
    const c = s / 2, mpx = s / 10;
    fill(g, s, s, '#94583a');
    mottle(g, s, rnd, { colors: ['#8a5034', '#a2623e', '#9c5c3c', '#7e4a32', '#a86a46'], count: 50, rmin: 40, rmax: 150, alpha: 0.42, hard: 0.1, stretch: 1.6, rot: Math.PI / 2 });
    roadProfile(g, s, '#7a4430', '#b07a56');
    blurWrap(g.canvas, 2);
    softRelief(g, s, rnd, { g0: 11, aniso: 0.4, k: 22, lit: '#c48460', dark: '#5e2e1e', litA: 0.2, darkA: 0.17 });
    streaks(g, s, rnd, { colors: ['#a86a46', '#b47a54', '#6e3a26', '#7e4630'], count: 90, len: [60, 200], width: [3, 9], angle: 0, wobble: 0.06, alpha: 0.18 });
    softRuts(g, s, rnd, [c], { w: 1.6 * mpx, color: '#6a3a26', alpha: 0.3, presence: 0.8, wob: 34 });
    worn(g, s, rnd, 10, [c - 1.5 * mpx, c + 1.5 * mpx], '#b8805c', [0.12, 0.2]);
    const along = crackNet(g, s, rnd, 3, { color: '#4a2418', lit: '#d09068', alpha: 0.28, litA: 0.3, len: [60, 160], width: [1, 1.6] });
    const peb = ['#b07858', '#8e5a42', '#c48a64', '#7a5a4c', '#a08070'];
    stoneClusters(g, s, rnd, 26, { colors: peb, r: [1.6, 3.8], k: [4, 9], spread: [6, 16], sides: [4, 5], asp: [0.45, 0.95], at: along.filter(() => rnd() < 0.4), where: x => (Math.abs(x - c) < 3 * mpx ? 0.8 : 0.4), contact: '#3e1e16' });
    stoneClusters(g, s, rnd, 30, { colors: peb, r: [0.9, 1.7], k: [3, 7], spread: [4, 10], sides: [4, 5], contact: '#3e1e16', contactA: 0.4 });
    for (let i = 0; i < 20; i++) {           // dust blown onto the shoulders
      const side = rnd() < 0.5, x = side ? range(rnd, 0, 100) : range(rnd, s - 100, s), y = rnd() * s, r = range(rnd, 20, 46);
      const rot = range(rnd, -0.3, 0.3); wrap(s, x, y, r * 1.6, (X, Y) => blob(g, X, Y, r * 1.4, r * 0.7, rot, '#b88a5e', 0.25, 0.3));
    }
    grassTufts(g, s, rnd, 14, { ...GRASS.badlands, r: [6, 11], blades: [5, 8], len: [9, 16], wid: [2, 3], where: x => (x < 80 || x > s - 80 ? 1 : 0) });
    glaze(g, s, s, '#ffcf98', 0.08, 'soft-light');
    soften(g.canvas, 0.5);
  },
});
register('road_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: a packed caravan track, darker and warmer than the sand: two faint wheel ruts, a firm crown, flat stones kicked to the edges, a little sand blown across',
  paint(g, s, rnd) {
    const c = s / 2, mpx = s / 10;
    fill(g, s, s, '#ae8858');
    mottle(g, s, rnd, { colors: ['#a98457', '#b48c5c', '#a07a4e', '#bc9464', '#9c784c'], count: 56, rmin: 26, rmax: 100, alpha: 0.42, hard: 0.1, stretch: 3.4, rot: Math.PI / 2 });
    // the shoulders fade back toward the loose sand
    const sh = g.createLinearGradient(0, 0, s, 0);
    sh.addColorStop(0, rgba('#d6b47e', 0.85)); sh.addColorStop(0.17, rgba('#d0ae78', 0.35)); sh.addColorStop(0.27, rgba('#c8a470', 0));
    sh.addColorStop(0.73, rgba('#c8a470', 0)); sh.addColorStop(0.83, rgba('#d0ae78', 0.35)); sh.addColorStop(1, rgba('#d6b47e', 0.85));
    g.fillStyle = sh; g.fillRect(0, 0, s, s);
    const cr = g.createLinearGradient(0, 0, s, 0);
    cr.addColorStop(0.38, rgba('#c69e6c', 0)); cr.addColorStop(0.5, rgba('#c69e6c', 0.35)); cr.addColorStop(0.62, rgba('#c69e6c', 0));
    g.fillStyle = cr; g.fillRect(0, 0, s, s);
    blurWrap(g.canvas, 2);
    softRelief(g, s, rnd, { g0: 10, aniso: 0.4, k: 22, lit: '#d0aa78', dark: '#86643e', litA: 0.2, darkA: 0.17 });
    streaks(g, s, rnd, { colors: ['#c49c6a', '#cca676', '#8e6a44', '#9a7650'], count: 100, len: [60, 200], width: [3, 9], angle: 0, wobble: 0.06, alpha: 0.2 });
    worn(g, s, rnd, 14, [c - 1.05 * mpx, c, c + 1.05 * mpx], '#c8a274', [0.22, 0.38]);
    // two faint wheel ruts, like the snow road's
    softRuts(g, s, rnd, [c - 1.05 * mpx, c + 1.05 * mpx], { w: 0.85 * mpx, color: '#86603c', alpha: 0.42, presence: 0.8, wob: 5 });
    streaks(g, s, rnd, { colors: ['#7a5636'], count: 30, len: [50, 140], width: [1.2, 2.2], angle: 0, wobble: 0.08, alpha: 0.2 });
    // flat stones kicked to the edges, grit on the crown
    const edgeW = x => { const d = Math.abs(x - c) / mpx; return d > 2.2 && d < 3.4 ? 1 : d < 0.6 ? 0.25 : 0.06; };
    stoneClusters(g, s, rnd, 16, { colors: ['#c8b08a', '#b09470', '#dccaa6', '#a08468', '#bca07c'], r: [2.4, 5.4], k: [2, 5], spread: [6, 14], sides: [5, 7], asp: [0.45, 0.8], where: edgeW, contact: '#6e4e30', contactA: 0.5 });
    lumps(g, s, rnd, 140, { r: [1, 2], colors: ['#d4bc96', '#b89c78', '#a08462'], where: x => (Math.abs(x - c) < 3 * mpx ? 0.6 : 0.15), shadow: '#6e4e30', shadowA: 0.45, sides: 6, litA: 0.8, shadeA: 0.5 });
    grassTufts(g, s, rnd, 8, { ...GRASS.desert, r: [6, 10], blades: [5, 8], len: [8, 14], wid: [2, 3], lean: [-0.6, 0.6], where: x => (x < 70 || x > s - 70 ? 1 : 0) });
    glaze(g, s, s, '#ffe6b8', 0.07, 'soft-light');
    soften(g.canvas, 0.4);
  },
});

// ---- cliffs ------------------------------------------------------------------------------------
// A few big planes of rock that read from 30 m (separated by value, not outlines), cracks along
// only some borders, partial shelves of different lengths. Light from the upper left.

const GRANITE = {
  facets: [{ cells: [4, 7], w: 0.75, amp: 0.9, tilt: 0.45, lean: [-0.5, 0.9] }, { cells: [12, 16], w: 0.6, amp: 0.35, tilt: 0.35, lean: [-0.5, 0.9] }],
  warp: 22, crackFrac: 0.42, crackW: 2.4, facetK: 0.75, chipMin: 0.5, shelfN: 8, shelfH: 1.25, bulge: 3.2, detail: 0.14, relief: 8, cavity: 0.5, contrast: 1.6,
  slabVar: 0.07, hueMix: 0.3, soft: 3, chisel: 260,
};
const BIG_PLANES = [{ cells: [3, 3], w: 0.85, amp: 1.0, tilt: 0.7, lean: [-0.3, 0.9] }, { cells: [9, 11], w: 0.6, amp: 0.35, tilt: 0.35, lean: [-0.5, 0.9] }];

register('cliff_meadow', {
  family: 'terrain', size: 512, note: 'Elwynn: big rounded gray granite masses, cream-lit upper-left, cool undersides, moss pads on the tops, rain streaks (~11 m tile)',
  paint(g, s, rnd, h, cv) {
    massRock(g, s, rnd, {
      fill: [3, 4], big: 5, bigR: [85, 135], asp: [0.55, 1.8], small: 0, sx: 1, sy: 1, rot: 1.2, warp: 20, tilt: 0.1,
      dome: 38, zs: 20, smooth: 0.17, exp: 2.3, bulge: 10, soft: 2, relief: 0.8, contrast: 2.3, planes: 0.5, shSlope: 0.5, castA: 0.45, tone: 0.12, hueMix: 0.35,
      crease: 0.32, creaseW: 5, creaseD: 4, creaseA: 0.5, creaseC: '#4a4650',
      colors: ['#8a847a', '#827d74', '#908a80', '#7f7b74', '#948c80'], blot: ['#6d7a4a', '#a29a8e', '#6e6e7a', '#8e8070'],
      light: '#dccfae', shadow: '#5a5c6a', cast: '#5e5e6c', deep: '#4c4852', glaze: '#ffe6b8',
      cover: { p: 0.45, up: 0.24, shade: '#4a5634', mid: '#66744a', lit: '#869650', max: 0.78 },
      stains: 26, stain: '#3a3844', stainA: 0.16, tuft: ['#4e7a28', '#6a9a34', '#8cb24a'], tuftN: 14, lichen: ['#b8b878', '#c8b070', '#9aa070'], chisel: 150, cracks: 10,
    }, cv);
  },
});
register('cliff_fields', {
  family: 'terrain', size: 512, note: 'Westfall: warm ochre and umber sandstone in long, softly eroded slabs and ledges, sandy cream-lit tops, cool violet-brown undersides, vertical joints, dry grass tufts on the lips and ledges',
  paint(g, s, rnd, h, cv) {
    massRock(g, s, rnd, {
      fill: [3, 7], big: 5, bigR: [80, 120], asp: [3, 6.5], ledgeN: 5, ledgeL: [100, 240], small: 0, sx: 1, sy: 1, rot: 0.08, warp: 15, tilt: 0.05,
      dome: 26, zs: 14, smooth: 0.2, exp: 3.4, bulge: 6, soft: 3, relief: 0.95, contrast: 2.2, planes: 0.25, shSlope: 0.5, castA: 0.45, tone: 0.09, hueMix: 0.45,
      crease: 0.3, creaseW: 6, creaseD: 4, creaseA: 0.38, creaseC: '#5e3e2a',
      colors: ['#9e7a52', '#a8845a', '#906c4a', '#b08c5e', '#98744e'], blot: ['#ba9462', '#7e5e42', '#a88258', '#8c6a4c'],
      light: '#efd8a6', shadow: '#76626c', cast: '#6c5462', deep: '#523e48', glaze: '#ffe0a0',
      cover: { p: 0.5, up: 0.3, shade: '#8a7034', mid: '#a88c42', lit: '#ccae58', max: 0.6 },
      stains: 20, stain: '#6a4630', stainA: 0.12, fringe: ['#c8a85a', '#b8963e', '#e2c56a', '#8a7a3a', '#d8bc6a', '#a88c48'], fringeN: 40, lichen: ['#c8b070', '#d6b068', '#b8a060'],
      chisel: 90, chiselA: 0.08, cracks: 3, joints: 4, undercut: '#4a2e22',
    }, cv);
  },
});
register('cliff_snow', {
  family: 'terrain', size: 512, note: 'Dun Morogh valley walls: angular blue-gray granite, flat fractured facets with straight edges, blocks from 1 to 3 m and long slabs, cream-lit planes, cool undersides, dark joints, a light powder; the shader lays snow shelves from its form map (10.5 m tile)',
  paint(g, s, rnd, h, cv) {
    massRock(g, s, rnd, {
      fill: [3, 5], big: 7, bigR: [44, 150], asp: [1.2, 4.2], ledgeN: 2, ledgeL: [110, 220], small: 12, sx: 1, sy: 1, rot: 0.35, warp: 9, tilt: 0.32, poly: [5, 7],
      dome: 30, zs: 26, smooth: 0.26, exp: 5.5, bulge: 5, soft: 1, relief: 0.95, contrast: 2.4, planes: 0.7, shSlope: 0.4, castA: 0.55, tone: 0.13, hueMix: 0.4,
      crease: 0.6, creaseW: 4, creaseD: 6, creaseA: 0.7, creaseC: '#323a50',
      colors: ['#7a8292', '#848c9c', '#8e95a4', '#727a8a', '#8a90a2'], blot: ['#6e7686', '#9aa2b2', '#7c7a8c', '#88909e'],
      light: '#e6e0d0', shadow: '#5a6482', cast: '#5c6786', deep: '#444e68', glaze: '#e8ecf8',
      powder: { up: 0.42, a: 0.18 }, powderC: '#eef2f8',
      stains: 22, stain: '#363e54', stainA: 0.13, lichen: ['#a8b0a0', '#c0c4b0', '#b8a88a'], chisel: 160, chiselA: 0.4, cracks: 24, upName: 'cliff_snow', formUX: true,
    }, cv);
  },
});
// The crash mesas keep their own granite: chunky rounded blue-gray blocks (the shader samples it smaller)
register('cliff_snow_mesa', {
  family: 'terrain', size: 512, note: 'Dun Morogh crash mesas: chunky blue-gray granite blocks (1-3 m), cream-lit tops, cool undersides, soft dark creases, a light powder; the terrain shader lays the snow from its form map',
  paint(g, s, rnd, h, cv) {
    massRock(g, s, rnd, {
      fill: [4, 6], big: 6, bigR: [66, 120], asp: [1.0, 2.6], small: 0, sx: 1, sy: 1, rot: 0.4, warp: 18, tilt: 0.14,
      dome: 34, zs: 22, smooth: 0.2, exp: 3.4, bulge: 6, soft: 2, relief: 0.95, contrast: 2.4, planes: 0.55, shSlope: 0.45, castA: 0.5, tone: 0.11, hueMix: 0.4,
      crease: 0.55, creaseW: 5, creaseD: 5, creaseA: 0.62, creaseC: '#353b52',
      colors: ['#7a8292', '#848c9c', '#8e95a4', '#767e8e', '#8a90a2'], blot: ['#6e7686', '#9aa2b2', '#7c7a8c', '#88909e'],
      light: '#e6e0d0', shadow: '#55607c', cast: '#5a6584', deep: '#3e465e', glaze: '#e8ecf8',
      powder: { up: 0.45, a: 0.16 }, powderC: '#eef2f8',
      stains: 24, stain: '#363e54', stainA: 0.14, lichen: ['#a8b0a0', '#c0c4b0', '#b8a88a'], chisel: 200, cracks: 18, upName: 'cliff_snow_mesa',
    }, cv);
  },
});
// Not colour: the FORM of a granite texture, texel for texel (linear data for the terrain shader,
// which lays its snow on whatever the painted rock turns up to the sky). R: how far the surface faces
// up (0.5 + 0.5 * up), G: its height (0..1), B: how far it faces right (0.5 + 0.5 * x; lets the
// shader turn the form with a rotated sample), or the creases between masses for the mesa granite.
for (const [name, src] of [['cliff_snow_form', 'cliff_snow'], ['cliff_snow_mesa_form', 'cliff_snow_mesa']]) register(name, {
  family: 'terrain', size: 512, note: `data, not colour: the form of ${src} (R faces up, G height, B faces right or creases) for the snow shader`,
  paint(g, s) {
    canvasFor(src);
    const F = FORM.get(src), img = g.getImageData(0, 0, s, s), D = img.data;
    for (let k = 0; k < s * s; k++) {
      const o = k * 4;
      D[o] = F ? Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * F.up[k]))) : 128;
      D[o + 1] = F ? Math.round(255 * F.h[k]) : 128;
      D[o + 2] = F ? (F.ux ? Math.max(0, Math.min(255, Math.round(127.5 + 127.5 * F.ux[k]))) : Math.round(255 * Math.min(1, F.cr[k]))) : 128;
      D[o + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  },
});
register('cliff_badlands', {
  family: 'terrain', size: 512, note: 'Thousand Needles: red-orange strata that pinch out and step at faults, jutting hard bands with lit lips and undercuts, vertical fissures',
  paint(g, s, rnd, h, cv) {
    paintRockFace(g, s, rnd, {
      ...GRANITE, strata: true, band: [26, 70], hardP: 0.45, bandWarp: 7, ledge: 1.8, pinch: 24, faults: 4, fissures: [40, 120], fissureC: '#5a2418', lipLit: '#f0b880', undercut: '#5a2a26',
      bandColors: ['#9a4426', '#b4552f', '#cf7a45', '#e3a066', '#a8492a', '#c26437', '#d88c55', '#e8b07a'],
      facets: [{ cells: [6, 2], w: 0.5, amp: 0.5, tilt: 0.3, lean: [-0.2, 0.4] }, { cells: [14, 6], w: 0.5, amp: 0.25, tilt: 0.25, lean: [-0.3, 0.5] }],
      warp: 14, crackFrac: 0.3, crackW: 2, shelfN: 0, bulge: 2.4, detail: 0.1, cavity: 0.45, contrast: 1.45, slabVar: 0.05,
      colors: ['#b4552f', '#c26437', '#a8492a'], blot: ['#000000', '#ffffff'],
      light: '#ffe2b4', shadow: '#6e3442', crack: '#5a2a30', glaze: '#ffcf98',
      cover: { shade: '#9a6a44', mid: '#c89a64', lit: '#ecc890', minUp: 0.3, slope: 2, top: 0.5, amt: 0.9, patch: [0.4, 0.8], edge: [0.3, 0.6], max: 0.6 },
      stains: 50, stain: '#6a3028', stainA: 0.12,
    }, cv);
  },
});
// Tanaris sandstone: a few thick beds (2.5-5 m on the 16 m tile) of tan, rust and honey, and lens-shaped
// cream hard beds between them that thicken, thin and pinch out along the face. The form is a relief lit
// from the upper left: a hard bed bulges (a lit rounded top, a shaded foot) and casts a soft warm shadow
// into the soft bed under it, which is scooped out under the overhang and rises to the next ledge, with
// faint sub-beds and wind flutes. Joints break the hard beds into blocks of their own tone; sand lies in
// drifts on the ledges, dark varnish streaks run down from the hard beds' feet, wind pits gather in
// clusters. The palette matches nature's rock_sand (the wall-foot mounds), so those read as blocks fallen
// from these walls.
function sandstone(g, s, rnd, cv, P) {
  const N = s * s;
  // -- the beds: soft and hard alternating (soft beds now and then in pairs), each its own colour
  const th = [], hardB = [];
  let tot = 0, h = false;
  while (tot < s * 0.98) {
    const t = h ? range(rnd, P.hardT[0], P.hardT[1]) : range(rnd, P.softT[0], P.softT[1]);
    th.push(t); hardB.push(h); tot += t;
    h = h ? false : rnd() < 0.75;
  }
  const n = th.length, ys = [0];
  for (let j = 0; j < n; j++) ys.push(ys[j] + th[j] * s / tot);
  const beds = [];
  let lastC = '';
  let dark = rnd() < 0.5;
  for (let j = 0; j < n; j++) {
    if (!hardB[j]) dark = !dark;
    const pal = hardB[j] ? P.hardC : dark ? P.softC.slice(0, 2) : P.softC.slice(2);
    let c; do { c = pick(rnd, pal); } while (c === lastC && pal.length > 1);
    lastC = c;
    beds.push({ hard: hardB[j], c: hex(jitter(c, rnd, 0.025)), c2: hex(jitter(pick(rnd, pal), rnd, 0.03)), wob: periodic(rnd, 4, 1.1, 1), wob2: periodic(rnd, 3, 0.8, 6),
      amp: range(rnd, P.wob[0], P.wob[1]) * (rnd() < (P.wavy ?? 0) ? 2.2 : 1), sp: range(rnd, 16, 30), lens: periodic(rnd, 3, 0.9, 1), lensK: range(rnd, ...(P.lensK || [0.15, 0.6])), lip: periodic(rnd, 3, 1, 2), sand: periodic(rnd, 6, 0.8, 2), sand2: periodic(rnd, 3, 1, 1),
      flute: periodic(rnd, 8, 0.6, 9), joints: [], tone: [], A: range(rnd, 0.75, 1.25) });
  }
  // the boundaries per column (top of each bed; the last is the first one tile further down). A hard
  // bed's thickness swells and thins along the face (a lens), and now and then pinches out entirely.
  const NB = n + 1, B = new Float32Array(s * NB);
  for (let x = 0; x < s; x++) {
    const u = x / s, o = x * NB;
    for (let j = 0; j < n; j++) B[o + j] = ys[j] + beds[j].amp * beds[j].wob(u) + 1.5 * beds[j].wob2(u);
    B[o + n] = B[o] + s;
    for (let j = 0; j < n - 1; j++) if (beds[j].hard) {
      const b = beds[j], lens = Math.max(0, Math.min(1.25, 0.78 + b.lensK * b.lens(u) * 1.6));
      B[o + j + 1] = B[o + j] + (ys[j + 1] - ys[j]) * lens;
    }
    for (let j = 1; j < n; j++) B[o + j] = Math.max(B[o + j], B[o + j - 1] + (beds[j - 1].hard ? 0 : 3));
    for (let j = n - 1; j >= 1; j--) B[o + j] = Math.min(B[o + j], B[o + j + 1] - (beds[j].hard ? 0 : 3));
  }
  // joints in the hard beds: blocks 60-200 px wide, each with its own tone; some joints only part-way
  for (const b of beds) if (b.hard) {
    let x = rnd() * 60;
    const x0 = x;
    while (x < x0 + s - 50) { b.joints.push({ x, wob: periodic(rnd, 2, 1, 1), a: range(rnd, 0.5, 1), f0: rnd() < 0.35 ? range(rnd, 0.25, 0.6) : 0, lean: range(rnd, -6, 6) }); b.tone.push(range(rnd, -1, 1)); x += range(rnd, 60, 200); }
  }
  const DET = fbmField(rnd, s, 2, 24, 0.5, 0.7), M1 = fbmLo(rnd, s, 3, 4, 0.55), M2 = fbmLo(rnd, s, 2, 6, 0.5, 2.5), M3 = fbmLo(rnd, s, 3, 3, 0.5), ML = fbmLo(rnd, s, 2, 8, 0.5, 0.5);
  const H = new Float32Array(N), BED = new Int16Array(N), F = new Float32Array(N), DY = new Float32Array(N), DB = new Float32Array(N), SAND = new Float32Array(N), JT = new Float32Array(N), BLK = new Int16Array(N).fill(-1);
  for (let x = 0; x < s; x++) {
    const o = x * NB, u = x / s;
    for (let y = 0; y < s; y++) {
      const k = y * s + x;
      let yy = y < B[o] ? y + s : y;
      if (yy >= B[o + n]) yy -= s;
      let j = 0; while (j < n - 1 && yy >= B[o + j + 1]) j++;
      const b = beds[j], ab = beds[(j - 1 + n) % n], bb = beds[(j + 1) % n];
      const y0 = B[o + j], y1 = B[o + j + 1], t = Math.max(1, y1 - y0), dy = yy - y0, db = y1 - yy, f = Math.max(0, Math.min(1, dy / t));
      BED[k] = j; F[k] = f; DY[k] = dy; DB[k] = db;
      let hh;
      if (b.hard) {
        // a rounded bulge: a short steep top, a long rounded foot; thin beds bulge less
        const A = P.hardA * b.A * Math.min(1, 0.45 + t / 60);
        hh = A * sst(-0.02, 0.24, f) * (1 - 0.85 * sst(0.5, 1.02, f));
        // the joints: a groove with rounded block edges either side
        for (let i = 0; i < b.joints.length; i++) {
          const J = b.joints[i];
          if (f < J.f0) continue;
          let dx = x - (J.x + J.wob(f * 0.5) * 3 + J.lean * f); dx -= Math.round(dx / s) * s;
          const ad = Math.abs(dx);
          if (ad < 7) { const gq = (1 - ad / 7); hh -= A * 0.55 * gq * gq * J.a * sst(J.f0, J.f0 + 0.12, f); JT[k] = Math.max(JT[k], (ad < 1.3 ? 1 : 0) * J.a * sst(J.f0, J.f0 + 0.12, f)); }
        }
        let bi = -1, bd = 1e9;
        for (let i = 0; i < b.joints.length; i++) { const d = ((x - b.joints[i].x) % s + s) % s; if (d < bd) { bd = d; bi = i; } }
        BLK[k] = bi;
      } else {
        // scooped out under an overhang, rising to the ledge below; faint sub-beds and wind flutes
        const deep = ab.hard ? 1 : 0.35;
        hh = -P.softA * deep * Math.pow(1 - f, 1.6) - P.softA * 0.18 * (1 - deep);
        const nL = Math.max(2, Math.round(t / b.sp)), pres = sst(-0.25, 0.35, ML[k]);
        hh += P.softA * (P.subA ?? 0.035) * Math.sin(f * nL * TAU) * pres;
        hh -= P.softA * 0.14 * (0.5 + 0.5 * b.flute(u + f * 0.03)) * sst(0.15, 0.6, f) * sst(-0.1, 0.4, M2[k]);
        // a drift of sand on the ledge of the hard bed below: a ramp up against it
        if (bb.hard) {
          const sh = P.sandH * sst(-0.25, 0.5, b.sand(u)) * (0.5 + 0.5 * (0.5 + 0.5 * b.sand2(u)));
          if (sh > 1.5 && db < sh + 1.5) {
            const e = sh - db, a = sst(-1.2, 1.2, e);
            SAND[k] = a;
            hh = hh * (1 - a) + a * (P.sandRise * Math.min(e, sh) / sh * 0.9 - 1.5);
          }
        }
      }
      H[k] = hh + DET[k] * P.detail;
    }
  }
  const Hs = blurField(Float32Array.from(H), s, 1, 2);
  // -- colour, lit from the upper left, with the overhangs' cast shadow
  const lit = hex(P.light), shd = hex(P.shadow), cast = hex(P.cast), crease = hex(P.crease), sand = hex(P.sand), sandLit = hex(P.sandLit), sandSh = hex(P.sandShade);
  const Lx = -0.42, Ly = -0.72, Lz = 0.55, Ll = Math.hypot(Lx, Ly, Lz), dif0 = Lz / Ll;
  const SH = [[3, 0.6], [6, 0.75], [10, 0.85], [15, 0.95], [22, 1]];
  const img = g.getImageData(0, 0, s, s), D = img.data;
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const k = y * s + x, p = k * 4, b = beds[BED[k]];
    const hx = (Hs[y * s + (x + 1) % s] - Hs[y * s + (x - 1 + s) % s]) * 0.5 * P.relief;
    const hy = (Hs[((y + 1) % s) * s + x] - Hs[((y - 1 + s) % s) * s + x]) * 0.5 * P.relief;
    const nl = Math.hypot(hx, hy, 1), dif = (hx * Lx + hy * Ly + Lz) / (nl * Ll);
    // (the canvas y runs down the face, so a surface whose height grows downward faces up, into the light)
    const hm = sst(-0.35, 0.35, M3[k]) * 0.4;
    let r = b.c.r + (b.c2.r - b.c.r) * hm, gg = b.c.g + (b.c2.g - b.c.g) * hm, bl = b.c.b + (b.c2.b - b.c.b) * hm;
    let v = 1 + M1[k] * 0.05 + M2[k] * 0.03;
    if (BLK[k] >= 0) v *= 1 + b.tone[BLK[k]] * 0.04;
    r *= v; gg *= v; bl *= v;
    const mixC = (c, a) => { r += (c.r - r) * a; gg += (c.g - gg) * a; bl += (c.b - bl) * a; };
    const sa = SAND[k];
    if (sa > 0) {
      const q = Math.min(1, DB[k] / Math.max(4, P.sandH));
      mixC({ r: sand.r + (sandSh.r - sand.r) * (1 - q) * 0.25, g: sand.g + (sandSh.g - sand.g) * (1 - q) * 0.25, b: sand.b + (sandSh.b - sand.b) * (1 - q) * 0.25 }, sa * 0.92);
    }
    let tl = (dif - dif0) * P.contrast;
    tl = tl * (1 - P.planes) + P.planes * Math.round(tl * 3) / 3;
    let occ = 0;
    for (const [d, fk] of SH) {
      const sx = ((x - Math.round(d * 0.5)) % s + s) % s, sy = ((y - d) % s + s) % s;
      occ = Math.max(occ, Hs[sy * s + sx] - Hs[k] - d * P.shSlope * fk);
    }
    const shd2 = sst(0, P.hardA * 0.35, occ) * P.castA;
    if (tl > 0) { const a = Math.min(P.litMax, tl) * (1 - shd2); mixC(sa > 0.5 ? sandLit : lit, a); }
    else mixC(shd, Math.min(0.8, -tl));
    if (shd2 > 0) mixC(cast, shd2);
    if (JT[k] > 0) mixC(crease, JT[k] * 0.5);
    if (DY[k] < 1.2 && !b.hard && sa < 0.3) mixC(crease, 0.3 * (1 - DY[k] / 1.2));     // the soft crease where a bed meets the one above
    D[p] = r; D[p + 1] = gg; D[p + 2] = bl; D[p + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const Bat = (x, j) => { const xi = ((Math.round(x) % s) + s) % s; return B[xi * NB + j]; };
  // dark varnish streaks running down from the hard beds' feet
  layered(g, s, P.varnishA, lg => {
    for (let j = 0; j < n; j++) if (beds[j].hard) for (let q = 0; q < P.varnishN; q++) {
      const x = rnd() * s, y0 = Bat(x, j + 1) + 2, L = range(rnd, 16, 80), w = range(rnd, 3, 8);
      const pts = []; let px = 0; for (let i = 0; i <= 5; i++) { pts.push([px, L * i / 5]); px += range(rnd, -1.2, 1.2); }
      wrap(s, x, y0 + L / 2, L, (X, Y) => stroke(lg, pts.map(([a, b2]) => [X + a, Y - L / 2 + b2]), w, w * 0.25, P.varnish, range(rnd, 0.4, 1)));
    }
  });
  // wind pits in loose clusters on the soft beds (a dark hollow, a lit lower lip)
  for (let c = 0; c < 8; c++) {
    const cx = rnd() * s, cy = rnd() * s, m = 2 + Math.floor(rnd() * 4);
    for (let k2 = 0; k2 < m; k2++) {
      const x = cx + range(rnd, -30, 30), y = cy + range(rnd, -14, 14), r = range(rnd, 3, 9) * (k2 ? 0.75 : 1), ry = r * range(rnd, 0.55, 0.8);
      const kk = ((Math.round(y) % s + s) % s) * s + ((Math.round(x) % s + s) % s);
      if (SAND[kk] > 0.2 || beds[BED[kk]].hard) continue;
      wrap(s, x, y, r * 2, (X, Y) => {
        blob(g, X, Y, r, ry, 0, P.pit, 0.4, 0.55);
        blob(g, X, Y + ry * 0.85, r * 0.95, ry * 0.32, 0, P.light, 0.35, 0.45);
      });
    }
  }
  // (optional) pale wind-scoured streaks running down the face, long and soft, gathered in a few
  // vertical bands so the face reads as weathered from above rather than ruled into stripes
  if (P.scourN) layered(g, s, P.scourA, lg => {
    const bands = []; for (let i = 0; i < 4; i++) bands.push(rnd() * s);
    for (let q = 0; q < P.scourN; q++) {
      const x = pick(rnd, bands) + range(rnd, -40, 40), y0 = rnd() * s, L = range(rnd, ...(P.scourL || [60, 220])), w = range(rnd, 4, 14);
      const pts = []; let px = 0; for (let i = 0; i <= 6; i++) { pts.push([px, L * i / 6]); px += range(rnd, -1.5, 1.5); }
      wrap(s, x, y0 + L / 2, L + w, (X, Y) => stroke(lg, pts.map(([a, b2]) => [X + a, Y - L / 2 + b2]), w, w * 0.2, pick(rnd, P.scour), range(rnd, 0.35, 1)));
    }
  });
  streaks(g, s, rnd, { colors: [P.light], count: 60, len: [8, 26], width: [1.5, 3.5], angle: 0.05, wobble: 0.2, alpha: 0.06 });
  glaze(g, s, s, P.glaze, 0.1, 'soft-light');
  soften(cv, 0.6);
}
register('cliff_desert', {
  family: 'terrain', size: 512, note: 'Tanaris: tan, rust and honey sandstone beds of very different thickness between lens-shaped cream hard beds (some wavy, some pinching out; rounded lit tops, cast shadows, joints), sand on the ledges, dark varnish and pale wind-scour streaks down the face (16 m tile)',
  paint(g, s, rnd, h, cv) {
    sandstone(g, s, rnd, cv, {
      softT: [56, 190], hardT: [26, 92], wob: [2, 12], wavy: 0.35, lensK: [0.15, 0.95], subA: 0.01, hardA: 20, softA: 11, detail: 0.6, relief: 0.95, contrast: 2.3, planes: 0.25, litMax: 0.5, shSlope: 0.14, castA: 0.72,
      softC: ['#a8764c', '#9e6c45', '#cc9e6c', '#c4955f'], hardC: ['#e6cea0', '#ddc290', '#e9d3a8'],
      light: '#f0dab0', shadow: '#8a5e52', cast: '#7a5048', crease: '#5e4038',
      sand: '#e0c08c', sandLit: '#f0d8a8', sandShade: '#c49e70', sandH: 16, sandRise: 9,
      varnish: '#5a3c32', varnishA: 0.2, varnishN: 9, pit: '#946c4c', glaze: '#ffe6b8', scour: ['#f2dcb0', '#ecd2a2'], scourA: 0.09, scourN: 40, scourL: [40, 150],
    });
  },
});

// ---- mud and slush (road space: x across the road, 10 m; y along it) ---------------------------
// Puddles are cut from a domain-warped noise field by a threshold (so no outline is a union of
// circles), drawn to the wheel tracks and stretched along the road. The water reflects the sky at
// its far (upper) edge and darkens toward the near edge; a brown sediment rim rings it. Churned
// clods, soft wheel tracks and boot smears around them.

function puddles(g, s, rnd, { far, near, sediment, cover = 0.17, ice = null, glint = '#eef4f8' }) {
  const N = s * s, c = s / 2, mpx = s / 10;
  const F = fbmLo(rnd, s, 3, 5, 0.55, 0.5), WX = fbmLo(rnd, s, 2, 6, 0.5), WY = fbmLo(rnd, s, 2, 6, 0.5);
  const ruts = [c - 1.05 * mpx + range(rnd, -6, 6), c + 1.05 * mpx + range(rnd, -6, 6)];
  const V = new Float32Array(N);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    const u = ((Math.round(x + WX[y * s + x] * 22) % s) + s) % s, v = ((Math.round(y + WY[y * s + x] * 40) % s) + s) % s;
    let aff = 0; for (const rx of ruts) aff = Math.max(aff, Math.exp(-(((x - rx) / (0.6 * mpx)) ** 2)));
    V[y * s + x] = F[v * s + u] + aff * 0.45 - (Math.abs(x - c) > 2.5 * mpx ? 0.6 : 0);
  }
  // the threshold that leaves `cover` of the tile under water
  const sorted = Float32Array.from(V).sort(), thr = sorted[Math.floor(N * (1 - cover))];
  const M = new Float32Array(N);
  for (let k = 0; k < N; k++) M[k] = sst(thr - 0.012, thr + 0.012, V[k]);
  const Mb = blurField(Float32Array.from(M), s, 3, 2);
  // rows since the puddle began, per column (the far edge is the top)
  const RT = new Float32Array(N);
  for (let x = 0; x < s; x++) { let r = 0; for (let yy = 0; yy < 2 * s; yy++) { const y = yy % s, k = y * s + x; r = M[k] > 0.5 ? r + 1 : 0; if (yy >= s) RT[k] = r; } }
  const IC = ice ? fbmLo(rnd, s, 3, 9, 0.6) : null;
  const img = g.getImageData(0, 0, s, s), D = img.data;
  const Fa = hex(far), Ne = hex(near), Se = hex(sediment), Ic = ice ? hex(ice) : null, Gl = hex(glint);
  const mixD = (o, c2, a) => { D[o] += (c2.r - D[o]) * a; D[o + 1] += (c2.g - D[o + 1]) * a; D[o + 2] += (c2.b - D[o + 2]) * a; };
  const gl = periodic(rnd, 11, 0.4, 8);
  for (let k = 0; k < N; k++) {
    const o = k * 4, m = M[k], ring = Math.max(0, Math.min(1, (Mb[k] - m) * 3.2));
    if (ring > 0.01) mixD(o, Se, ring * 0.6);
    if (m > 0.01) {
      const f = sst(0, 56, RT[k]);
      const w = { r: Fa.r + (Ne.r - Fa.r) * f, g: Fa.g + (Ne.g - Fa.g) * f, b: Fa.b + (Ne.b - Fa.b) * f };
      mixD(o, w, m * 0.92);
      if (RT[k] > 1 && RT[k] < 5 && gl((k % s) / s) > 0.35) mixD(o, Gl, 0.55);     // a glint along the far edge
      if (ice && IC[k] > 0.15) mixD(o, Ic, m * sst(0.15, 0.2, IC[k]) * 0.75);       // skins of ice
    }
  }
  g.putImageData(img, 0, 0);
}

function churn(g, s, rnd, P) {
  const c = s / 2, mpx = s / 10;
  fill(g, s, s, P.base);
  mottle(g, s, rnd, { colors: P.blot, count: 54, rmin: 30, rmax: 120, alpha: 0.42, hard: 0.12, stretch: 1.6, rot: Math.PI / 2 });
  blurWrap(g.canvas, 2);
  cellDirt(g, s, rnd, { cells: 16, warp: 20, grout: P.gap, groutA: 0.08, lit: P.clodLit, litA: 0.22, shade: P.clodDark, shadeA: 0.2 });
  softRuts(g, s, rnd, [c - 1.05 * mpx, c + 1.05 * mpx], { w: 1.5 * mpx, color: P.rut, alpha: 0.32, presence: 0.9, wob: 8 });
  softRuts(g, s, rnd, [c - 1.05 * mpx, c + 1.05 * mpx], { w: 0.75 * mpx, color: P.wet, alpha: 0.4, presence: 0.75, wob: 9 });
  scuffs(g, s, rnd, 60, P.base, [5, 10]);
  stoneClusters(g, s, rnd, 6, { colors: P.peb, contact: P.gap, contactA: 0.45 });
  puddles(g, s, rnd, P.puddle);
  if (P.extra) P.extra(g, s, rnd);
  glaze(g, s, s, P.glaze, 0.06, 'soft-light');
  soften(g.canvas, 0.55);
}

register('mud', {
  family: 'terrain', size: 512, note: 'wet churned mud in road space: soft wheel tracks, clods, puddles along the tracks reflecting the sky, a sediment rim',
  paint(g, s, rnd) {
    churn(g, s, rnd, {
      base: '#56402c', blot: ['#4a3626', '#634a32', '#3e2e22', '#6e5438', '#58432e'], rut: '#3e2c20', wet: '#2e2018',
      clodLit: '#8a6a48', clodDark: '#3a2818', gap: '#241810', peb: ['#8a7660', '#6e5c4a', '#a08c74'],
      puddle: { far: '#a9c6d6', near: '#5a6a78', sediment: '#6a5034', cover: 0.18 }, glaze: '#ffd8a0',
    });
  },
});

register('slush', {
  family: 'terrain', size: 512, note: 'Dun Morogh mud: gray-white mush, lumps of dirty snow, gray slush pools with skins of ice (road space)',
  paint(g, s, rnd) {
    churn(g, s, rnd, {
      base: '#8a8884', blot: ['#7e7a74', '#9a9a98', '#6e6a66', '#aeb2b6', '#868480'], rut: '#68645e', wet: '#56524e',
      clodLit: '#e2e6ea', clodDark: '#727680', gap: '#4a4650', peb: ['#8a8e96', '#6e6c6a', '#a09c98'],
      puddle: { far: '#c4ccd4', near: '#7c848c', sediment: '#6a6660', cover: 0.16, ice: '#e2e8ee', glint: '#f6f8fa' }, glaze: '#e8f0ff',
      extra(g, s, rnd) { lumps(g, s, rnd, 16, { r: [10, 18], colors: ['#d6dadf', '#c8ced6'], lit: '#f0f2f4', shade: '#9aa0a8', shadow: '#6a6e78', shadowA: 0.3, sq: 0.6 }); },
    });
  },
});

register('mud_badlands', {
  family: 'terrain', size: 512, note: 'Badlands mud: red clay churned wet, rusty puddles along the tracks (road space)',
  paint(g, s, rnd) {
    churn(g, s, rnd, {
      base: '#7a4430', blot: ['#6e3c2a', '#8a5034', '#5e3424', '#94583a', '#7e4630'], rut: '#5a2e20', wet: '#3e2018',
      clodLit: '#b8785a', clodDark: '#4a2418', gap: '#2e140e', peb: ['#a07058', '#8a5a44', '#b48870'],
      puddle: { far: '#9c8a88', near: '#5e3e34', sediment: '#5a2a1c', cover: 0.15 }, glaze: '#ffcf98',
    });
  },
});
register('mud_desert', {
  family: 'terrain', size: 512, note: 'Tanaris wash: dark wet sand churned along the track, a few shallow pools in the tracks (road space)',
  paint(g, s, rnd) {
    churn(g, s, rnd, {
      base: '#9c7a52', blot: ['#8e6e48', '#a8865c', '#86663e', '#b08e62', '#987650'], rut: '#7a5a3a', wet: '#5e4430',
      clodLit: '#d4b486', clodDark: '#6a4e32', gap: '#4a3420', peb: ['#c8b08c', '#a88e6c', '#dcc8a4'],
      puddle: { far: '#bccad2', near: '#7a7a70', sediment: '#6a4e34', cover: 0.12 }, glaze: '#ffe6b8',
    });
  },
});

// ---- macro variation (data, not color: R = huge blotches, G = big, B = medium) ------------------

// Near-field detail (data, 128 = no change), tiled every ~1.8 m and multiplied in only within ~20 m
// of the camera so the ground at your feet stays crisp: R = grass blades (lit tips, dark roots),
// G = grit and pebbles with a lit upper-left side and a soft shadow, B = fine wind ripples and crust.
register('terrain_detail', {
  family: 'terrain', size: 256, note: 'near-field detail, data: R grass blades, G grit and pebbles, B fine ripples and crust (128 = neutral)',
  paint(g, s, rnd) {
    const chan = fn => { const c = makeCanvas(s), cg = c.getContext('2d'); fill(cg, s, s, '#808080'); fn(cg); blurWrap(c, 1, 1, 0.35); return cg.getImageData(0, 0, s, s).data; };
    const R = chan(cg => {
      bladePass(cg, s, rnd, 520, ['#4a4a4a', '#545454', '#5e5e5e'], [14, 30], [3, 6], 0.75, [-0.5, 0.5], [-0.3, 0.4]);
      bladePass(cg, s, rnd, 620, ['#b4b4b4', '#c6c6c6', '#a8a8a8'], [12, 26], [2.6, 5], 0.8, [-0.5, 0.5], [-0.3, 0.4]);
      bladePass(cg, s, rnd, 240, ['#dadada', '#e6e6e6'], [8, 16], [2, 3.4], 0.75, [-0.4, 0.4], [-0.2, 0.3]);
    });
    const G = chan(cg => {
      mottle(cg, s, rnd, { colors: ['#6a6a6a', '#989898'], count: 70, rmin: 10, rmax: 30, alpha: 0.35, hard: 0.15 });
      lumps(cg, s, rnd, 90, { r: [3, 8], colors: ['#a0a0a0', '#8c8c8c', '#b0b0b0'], lit: '#d8d8d8', shade: '#4c4c4c', shadow: '#2c2c2c', shadowA: 0.5, sides: 6, jag: 0.3 });
      lumps(cg, s, rnd, 380, { r: [1.2, 2.8], colors: ['#a8a8a8', '#787878'], lit: '#d0d0d0', shade: '#505050', shadow: '#383838', shadowA: 0.45, sides: 5, jag: 0.35 });
      streaks(cg, s, rnd, { colors: ['#5a5a5a', '#a8a8a8'], count: 60, len: [10, 30], width: [1, 2], angle: 0.6, wobble: 0.8, alpha: 0.4 });
    });
    const B = chan(cg => {
      const H = rippleHeight(rnd, s, { per: 16, warp: 14, warp2: 4, tilt: 1, lee: 0.3, fade: [-0.3, 0.4], floor: 0.1 });
      shadeHeight(cg, s, H, { k: 0.5, lit: '#c8c8c8', dark: '#505050', litA: 0.6, darkA: 0.6 });
      lumps(cg, s, rnd, 140, { r: [1.5, 3.5], colors: ['#b4b4b4', '#9a9a9a'], lit: '#e0e0e0', shade: '#606060', shadow: '#484848', shadowA: 0.35, sides: 7, jag: 0.25 });
    });
    const img = g.getImageData(0, 0, s, s), D = img.data;
    for (let i = 0; i < D.length; i += 4) { D[i] = R[i]; D[i + 1] = G[i]; D[i + 2] = B[i]; D[i + 3] = 255; }
    g.putImageData(img, 0, 0);
  },
});

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
// ---- ground-clutter atlases (2×2 cells of 256; base of each card at the cell's bottom) ---------

// A chunky tuft: a few WIDE blades fanning up from (cx, by), each shading from the ground's own
// mid tone at the root (so the tuft grows out of the ground, not on top of it) to a lit tip; the
// left side of each blade catches the light, blades on the right of the tuft sit in its shade.
function tuft(g, cx, by, rnd, { n = 9, spread = 60, len = [110, 220], wid = [14, 22], fan = 0.8, cols, tip, base = '#4f7a2c', bend = 0.35, back = 2 }) {
  const B = [];
  for (let i = 0; i < n; i++) {
    const t = range(rnd, -1, 1) * (0.35 + 0.65 * rnd());
    B.push({ t, a: t * fan * 0.9 + range(rnd, -0.18, 0.18), L: range(rnd, len[0], len[1]) * (1 - Math.abs(t) * 0.35), w: range(rnd, wid[0], wid[1]), c: pick(rnd, cols), tp: tip ? pick(rnd, tip) : null, b: range(rnd, -bend, bend) });
  }
  // one or two darker blades behind, for depth
  for (let i = 0; i < back; i++) {
    const t = (i % 2 ? 1 : -1) * range(rnd, 0.3, 0.9), a = t * fan + range(rnd, -0.15, 0.15), L = range(rnd, len[0], len[1]) * 0.95, w = range(rnd, wid[0], wid[1]) * 1.1;
    const c0 = shadowOf(pick(rnd, cols), 0.38), bx = cx + t * spread * 0.7, b = range(rnd, -bend, bend) + a * 0.4;
    const gr = g.createLinearGradient(bx, by, bx + Math.sin(a + b) * L, by - Math.cos(a + b) * L);
    gr.addColorStop(0, shadowOf(base, 0.2)); gr.addColorStop(0.5, c0); gr.addColorStop(1, mix(c0, tip ? tip[0] : c0, 0.35));
    blade2(g, bx, by, L, a, w, gr, b);
  }
  B.sort((a, b) => Math.abs(b.t) - Math.abs(a.t));          // outer blades first, the centre ones on top
  for (const bl of B) {
    const bx = cx + bl.t * spread, a = bl.a, b = bl.b + a * 0.4;
    const body = bl.t > 0.25 ? shadowOf(bl.c, 0.22) : bl.c, tipC = bl.tp ? (bl.t > 0.25 ? mix(bl.tp, body, 0.45) : bl.tp) : lightOf(bl.c, 0.4);
    const ex = bx + Math.sin(a + b) * bl.L, ey = by - Math.cos(a + b) * bl.L;
    const gr = g.createLinearGradient(bx, by, ex, ey);
    gr.addColorStop(0, base); gr.addColorStop(0.3, mix(base, body, 0.6)); gr.addColorStop(0.7, body); gr.addColorStop(1, tipC);
    blade2(g, bx, by, bl.L, a, bl.w, gr, b);
    // the lit left edge
    blade2(g, bx - bl.w * 0.22, by - bl.L * 0.12, bl.L * 0.82, a, bl.w * 0.34, rgba(lightOf(body, 0.5), 0.45), b);
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

function flowersCell(g, ox, oy, rnd, { petals, centers, leaf, grass, n = 7 }) {
  tuft(g, ox + 128, oy + 252, rnd, { n: 7, spread: 62, len: [80, 140], wid: [13, 19], cols: grass.body, tip: grass.tip, base: grass.root });
  for (let i = 0; i < n; i++) {
    const x = ox + 128 + range(rnd, -80, 80), h = range(rnd, 90, 190), lean = range(rnd, -0.25, 0.25);
    const [tx, ty] = stem(g, x, oy + 250, h, lean, leaf, 5);
    for (const s of [-1, 1]) { const ly = oy + 250 - h * range(rnd, 0.2, 0.5); ellipse(g, x + s * 13, ly, 16, 6, s * 0.6, leaf); ellipse(g, x + s * 12 - 1, ly - 1.5, 10, 3, s * 0.6, lightOf(leaf, 0.4), 0.7); }
    flowerHead(g, tx, ty, range(rnd, 16, 24), pick(rnd, petals), pick(rnd, centers), rnd);
  }
}

// A dense patch of wheat: a thicket of stalks, heads crowding together at the top.
function wheatCell(g, ox, oy, rnd, { stalk, head, headLit, n = 26, base = '#8a7034', h = [170, 244], spread = 100 }) {
  const S = [];
  for (let i = 0; i < n; i++) S.push({ x: ox + 128 + range(rnd, -spread, spread) * Math.sqrt(rnd()), h: range(rnd, h[0], h[1]) });
  S.sort((a, b) => a.h - b.h);
  // the dark mass of stalks at the bottom
  for (const st of S) stroke(g, [[st.x, oy + 254], [st.x + range(rnd, -6, 6), oy + 254 - st.h * 0.55]], 7, 4, base, 1);
  for (const st of S) {
    const lean = range(rnd, -0.1, 0.1) + (st.x - ox - 128) / 100 * 0.12;
    const [tx, ty] = stem(g, st.x, oy + 252, st.h * 0.72, lean, pick(rnd, stalk), 4);
    const hl = st.h * 0.3, ang = lean * 1.6;
    for (let k = 0; k < 7; k++) {
      const t = k / 6, kx = tx + Math.sin(ang) * hl * t, ky = ty - Math.cos(ang) * hl * t;
      for (const s of [-1, 1]) {
        const ex = kx + s * 5, ey = ky;
        ellipse(g, ex, ey, 5 * (1 - t * 0.3), 8 * (1 - t * 0.3), ang + s * 0.35, shadowOf(head, 0.2));
        ellipse(g, ex - 1, ey - 1, 3.4 * (1 - t * 0.3), 5.6 * (1 - t * 0.3), ang + s * 0.35, s < 0 ? headLit : head);
      }
    }
    stroke(g, [[tx, ty - hl], [tx + Math.sin(ang) * 26, ty - hl - 22]], 1.4, 0.4, headLit, 0.7);
  }
}

function twigsCell(g, ox, oy, rnd, { col, lit, n = 6 }) {
  const branch = (x, y, a, L, w, d) => {
    const x2 = x + Math.sin(a) * L, y2 = y - Math.cos(a) * L;
    stroke(g, [[x, y], [(x + x2) / 2 + range(rnd, -3, 3), (y + y2) / 2], [x2, y2]], w, w * 0.55, col, 1);
    stroke(g, [[x - w * 0.25, y], [x2 - w * 0.2, y2]], w * 0.3, w * 0.15, lit, 0.5);
    if (d < 3) { const k = 1 + Math.floor(rnd() * 2.2); for (let i = 0; i < k; i++) branch(x2, y2, a + range(rnd, -0.8, 0.8), L * range(rnd, 0.5, 0.75), w * 0.62, d + 1); }
  };
  for (let i = 0; i < n; i++) branch(ox + 128 + range(rnd, -40, 40), oy + 252, range(rnd, -0.5, 0.5), range(rnd, 60, 100), range(rnd, 7, 10), 0);
}

function sageCell(g, ox, oy, rnd, { leaf, lit, wood }) {
  twigsCell(g, ox, oy, rnd, { col: wood, lit: lightOf(wood, 0.4), n: 5 });
  for (let i = 0; i < 80; i++) {
    const a = rnd() * Math.PI - Math.PI / 2, r = Math.sqrt(rnd()) * 100;
    const x = ox + 128 + Math.sin(a) * r, y = oy + 250 - Math.abs(Math.cos(a)) * r * 1.4 - 10;
    const c = jitter(pick(rnd, leaf), rnd, 0.08);
    ellipse(g, x + 1.5, y + 2, 11, 6, rnd() * 3, shadowOf(c, 0.4), 0.8);
    ellipse(g, x, y, 10, 5.5, rnd() * 3, c);
    blob(g, x - 2, y - 1.5, 5, 2.5, 0, pick(rnd, lit), 0.7, 0.4);
  }
}

function clutterAtlas(cells) {
  return (g, s, rnd) => {
    cells.forEach((fn, i) => {
      const ox = (i % 4) * 256, oy = Math.floor(i / 4) * 256;
      g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, 252, 252); g.clip();
      fn(g, ox, oy, rnd);
      g.restore();
    });
  };
}

// A broadleaf clump (plantain, dock): a rosette of broad leaves, each lit along its upper-left half.
function leafCell(g, ox, oy, rnd, { leaf, lit, vein, n = 9 }) {
  const L = [];
  for (let i = 0; i < n; i++) L.push({ a: range(rnd, -1.25, 1.25), len: range(rnd, 70, 130), w: range(rnd, 22, 34), c: jitter(pick(rnd, leaf), rnd, 0.06) });
  L.sort((p, q) => Math.abs(q.a) - Math.abs(p.a));
  for (const l of L) {
    const x0 = ox + 128 + l.a * 18, y0 = oy + 250, ex = x0 + Math.sin(l.a) * l.len, ey = y0 - Math.cos(l.a) * l.len * 0.8;
    const mx = (x0 + ex) / 2, my = (y0 + ey) / 2, rot = Math.atan2(ey - y0, ex - x0);
    ellipse(g, mx + 2, my + 3, l.len * 0.5, l.w * 0.5, rot, shadowOf(l.c, 0.45), 0.8);
    ellipse(g, mx, my, l.len * 0.5, l.w * 0.5, rot, l.c);
    blob(g, mx - Math.sin(rot) * l.w * 0.15 - 4, my - 4, l.len * 0.38, l.w * 0.22, rot, pick(rnd, lit), 0.55, 0.4);
    stroke(g, [[x0, y0], [mx, my - 2], [ex, ey]], 2.2, 0.8, vein, 0.6);
  }
}

register('clutter_meadow', {
  family: 'terrain', w: 1024, h: 512, alpha: true, note: 'cells: chunky tuft, short bushy tuft, buttercups+daisies, peacebloom, tall grass with seed heads, broadleaf clump, dark leaning tuft, clover with white flowers',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 9, spread: 66, len: [120, 210], wid: [16, 24], cols: ['#5b8a2e', '#66923a', '#6e9a36', '#548230'], tip: ['#b8cc5c', '#c6d06a', '#a8c452'], base: '#3f5a22' }),
    (g, ox, oy, rnd) => { tuft(g, ox + 128, oy + 254, rnd, { n: 14, spread: 80, len: [80, 140], wid: [16, 24], fan: 1.1, cols: ['#5e8a32', '#6a9238', '#58842e'], tip: ['#9cb447', '#c8d060'], base: '#3f5a22', back: 3 }); },
    (g, ox, oy, rnd) => flowersCell(g, ox, oy, rnd, { petals: ['#f6d84a', '#fbe36a', '#fff8ec', '#f8f2e0'], centers: ['#e8a030', '#d88a28'], leaf: '#4a7a28', grass: GRASS.meadow }),
    (g, ox, oy, rnd) => flowersCell(g, ox, oy, rnd, { petals: ['#b48ad8', '#9a78d0', '#c8a0e0', '#e8a0b8'], centers: ['#f4d860', '#fff0a0'], leaf: '#3e6e28', grass: GRASS.meadow }),
    (g, ox, oy, rnd) => {
      tuft(g, ox + 128, oy + 254, rnd, { n: 8, spread: 60, len: [150, 236], wid: [14, 20], cols: ['#62902e', '#709a36', '#7aa03c'], tip: ['#d4d878', '#e0d488'], base: '#3f5a22' });
      for (let i = 0; i < 4; i++) { const x = ox + 128 + range(rnd, -60, 60); const [tx, ty] = stem(g, x, oy + 250, range(rnd, 170, 235), range(rnd, -0.2, 0.2), '#7a9a3a', 4); ellipse(g, tx, ty - 8, 7, 16, 0, '#b8a860'); ellipse(g, tx - 2, ty - 10, 3.4, 9, 0, '#e8dc98'); }
    },
    (g, ox, oy, rnd) => { tuft(g, ox + 128, oy + 254, rnd, { n: 5, spread: 70, len: [70, 120], wid: [12, 18], cols: ['#5e8a32', '#6a9238'], tip: ['#a8bc4c'], base: '#3f5a22', back: 1 }); leafCell(g, ox, oy, rnd, { leaf: ['#4e7e2c', '#5a8a30', '#46742a'], lit: ['#8cb04a', '#9cbc52'], vein: '#a8c070' }); },
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 10, spread: 62, len: [110, 190], wid: [14, 21], fan: 0.7, cols: ['#4a7a28', '#548230', '#4e7a2a'], tip: ['#8eac42', '#a8bc4c'], base: '#33501f', bend: 0.55 }),
    (g, ox, oy, rnd) => {
      for (let i = 0; i < 26; i++) {           // clover: little three-leaf clusters
        const x = ox + 128 + range(rnd, -95, 95), y = oy + 250 - range(rnd, 6, 70), c = pick(rnd, ['#4e7e2c', '#5a8a30', '#629236']);
        for (let k = 0; k < 3; k++) { const a = k / 3 * TAU + rnd(); ellipse(g, x + Math.cos(a) * 7 + 1, y + Math.sin(a) * 5 + 2, 8, 6, a, shadowOf(c, 0.4), 0.8); ellipse(g, x + Math.cos(a) * 7, y + Math.sin(a) * 5, 8, 6, a, c); blob(g, x + Math.cos(a) * 6 - 2, y + Math.sin(a) * 4 - 2, 4, 3, a, '#a8c860', 0.5, 0.4); }
      }
      for (let i = 0; i < 8; i++) flowerHead(g, ox + 128 + range(rnd, -80, 80), oy + 250 - range(rnd, 50, 100), range(rnd, 9, 13), pick(rnd, ['#fff8ec', '#f8f0e0', '#f4e8f0']), '#e8c040', rnd, 7);
    },
  ]),
});
register('clutter_fields', {
  family: 'terrain', w: 1024, h: 512, alpha: true, note: 'cells: golden tuft, a dense tall wheat patch, a sparse short wheat patch, green-gold tuft, poppies, wispy golden tuft, golden seed grass, cut stubble',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 10, spread: 70, len: [120, 216], wid: [13, 20], cols: ['#b49a4c', '#c2a654', '#a89246', '#bca050'], tip: ['#f0dc98', '#ecd486', '#f6e4a8'], base: '#8a7a3a', fan: 0.65 }),
    (g, ox, oy, rnd) => wheatCell(g, ox, oy, rnd, { stalk: ['#b8963e', '#c8a44a', '#a8883a'], head: '#d8b05a', headLit: '#f4dc90', n: 26 }),
    (g, ox, oy, rnd) => wheatCell(g, ox, oy, rnd, { stalk: ['#c09a44', '#b08c3e', '#caa650'], head: '#dcb862', headLit: '#f8e4a0', n: 13, h: [130, 200], spread: 80 }),
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 9, spread: 66, len: [100, 190], wid: [13, 19], cols: ['#8a9a40', '#9c9c48', '#a8a04c'], tip: ['#e0d07a', '#d8d888'], base: '#6a6630' }),
    (g, ox, oy, rnd) => flowersCell(g, ox, oy, rnd, { petals: ['#d8483a', '#e45a40', '#c83a30', '#f0d060'], centers: ['#2a2020', '#3a2a20'], leaf: '#5a7a2a', grass: GRASS.fieldsGreen }),
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 12, spread: 74, len: [130, 230], wid: [9, 14], cols: ['#c8a24a', '#d0ac52', '#bc9a44'], tip: ['#f6e4a4', '#f0d888'], base: '#8a7a3a', fan: 1.0, bend: 0.6 }),
    (g, ox, oy, rnd) => {
      tuft(g, ox + 128, oy + 254, rnd, { n: 7, spread: 60, len: [90, 160], wid: [11, 16], cols: ['#b49a4c', '#c2a654'], tip: ['#f0dc98'], base: '#8a7a3a' });
      for (let i = 0; i < 7; i++) { const x = ox + 128 + range(rnd, -70, 70); const [tx, ty] = stem(g, x, oy + 250, range(rnd, 150, 230), range(rnd, -0.25, 0.25), '#b8a050', 3); for (let k = 0; k < 6; k++) { const s2 = k % 2 ? 1 : -1; ellipse(g, tx + s2 * 5, ty - k * 5, 4, 6, s2 * 0.5, k % 3 ? '#e2c87a' : '#c8a656'); } }
    },
    (g, ox, oy, rnd) => {
      // cut stubble: short stiff stalks in a loose row, flat cut tops catching the light, loose straw
      // fallen at their feet (the stubble plots' rows; elsewhere a straw clump)
      for (let i = 0; i < 34; i++) { const x = ox + 128 + range(rnd, -100, 100), y = oy + 252 - range(rnd, 0, 26); const a = range(rnd, -1.45, 1.45), L = range(rnd, 30, 80); stroke(g, [[x, y], [x + Math.sin(a) * L, y - Math.abs(Math.cos(a)) * L * 0.35]], 4, 3, pick(rnd, ['#c8a456', '#b8963e', '#d8bc6c', '#a07e3c']), 1); }
      const S = [];
      for (let i = 0; i < 34; i++) S.push({ x: ox + 128 + range(rnd, -104, 104), h: range(rnd, 60, 165), lean: range(rnd, -0.14, 0.14) });
      S.sort((a, b) => b.h - a.h);
      for (const st of S) {
        const x2 = st.x + Math.sin(st.lean) * st.h, y2 = oy + 252 - st.h;
        stroke(g, [[st.x + 1.8, oy + 253], [x2 + 1.8, y2 + 1]], 5.5, 4.5, '#8a6c34', 1);
        stroke(g, [[st.x, oy + 253], [x2, y2]], 4.6, 3.8, pick(rnd, ['#c8a250', '#d4b05e', '#b8923e', '#ccaa5a']), 1);
        stroke(g, [[st.x - 0.8, oy + 240], [x2 - 0.8, y2 + 6]], 1.4, 1, '#ecd490', 0.6);
        ellipse(g, x2, y2, 2.6, 1.3, st.lean, '#f4dc9c');
      }
    },
  ]),
});
register('clutter_badlands', {
  family: 'terrain', w: 1024, h: 512, alpha: true, note: 'cells: dry tuft, dead twigs, sage, thin dry grass, red dry tuft, a small dead bush, gray sage, a tiny dry tuft',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 10, spread: 64, len: [80, 170], wid: [9, 14], cols: ['#b89858', '#a88a50', '#c8a868', '#9a7a48'], tip: ['#ead4a0', '#e2c88a'], base: '#7a5a38', fan: 1.0, bend: 0.6 }),
    (g, ox, oy, rnd) => twigsCell(g, ox, oy, rnd, { col: '#6a4a36', lit: '#a88a70', n: 6 }),
    (g, ox, oy, rnd) => sageCell(g, ox, oy, rnd, { leaf: ['#8a9a78', '#7a8a6a', '#9aa888'], lit: ['#c8d4b0', '#b8c8a0'], wood: '#5e4636' }),
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 8, spread: 60, len: [60, 140], wid: [8, 12], cols: ['#c8a868', '#b89858'], tip: ['#f0dcae'], base: '#8a6440', fan: 1.2, bend: 0.8 }),
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 9, spread: 60, len: [70, 150], wid: [9, 13], cols: ['#b07850', '#a06c48', '#bc8a5c'], tip: ['#e8c090', '#dcb080'], base: '#6a4430', fan: 1.0, bend: 0.7 }),
    (g, ox, oy, rnd) => { twigsCell(g, ox, oy, rnd, { col: '#5a4030', lit: '#9a7a62', n: 9 }); },
    (g, ox, oy, rnd) => sageCell(g, ox, oy, rnd, { leaf: ['#98a090', '#88907e', '#a8ae9c'], lit: ['#d4dac4'], wood: '#5a4636' }),
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 7, spread: 44, len: [40, 90], wid: [8, 12], cols: ['#b89858', '#c8a868'], tip: ['#ecd6a4'], base: '#8a6440', fan: 1.1, bend: 0.5, back: 1 }),
  ]),
});
register('clutter_desert', {
  family: 'terrain', w: 1024, h: 512, alpha: true, note: 'cells: dry tuft, bleached twigs, desert sage, tiny desert flowers, pale dune grass, bleached twigs, small sage, a tiny dry tuft',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 9, spread: 60, len: [70, 150], wid: [8, 13], cols: ['#c4ae72', '#b8a468', '#d4bc80'], tip: ['#f2e2b4', '#ecdcaa'], base: '#a07a50', fan: 1.0, bend: 0.7 }),
    (g, ox, oy, rnd) => twigsCell(g, ox, oy, rnd, { col: '#8a7058', lit: '#d8c8b0', n: 5 }),
    (g, ox, oy, rnd) => sageCell(g, ox, oy, rnd, { leaf: ['#9aa488', '#8a9a7c', '#aab496'], lit: ['#d8e0c4'], wood: '#7a6048' }),
    (g, ox, oy, rnd) => {
      sageCell(g, ox, oy, rnd, { leaf: ['#7a8a5c', '#6a7a50'], lit: ['#b8c890'], wood: '#6a5040' });
      for (let i = 0; i < 9; i++) flowerHead(g, ox + 128 + range(rnd, -70, 70), oy + 250 - range(rnd, 40, 130), range(rnd, 8, 12), pick(rnd, ['#f0a0c0', '#f8d070', '#f4f0e0']), '#c87a30', rnd, 5);
    },
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 12, spread: 70, len: [140, 230], wid: [7, 11], cols: ['#d4c088', '#c8b47a', '#dcc894'], tip: ['#f6ecc8'], base: '#a88a5a', fan: 1.0, bend: 0.8 }),
    (g, ox, oy, rnd) => twigsCell(g, ox, oy, rnd, { col: '#9a8068', lit: '#e8dcc4', n: 4 }),
    (g, ox, oy, rnd) => sageCell(g, ox, oy, rnd, { leaf: ['#a4ac90', '#949e84'], lit: ['#dce4cc'], wood: '#7a6048' }),
    (g, ox, oy, rnd) => tuft(g, ox + 128, oy + 254, rnd, { n: 7, spread: 44, len: [40, 90], wid: [7, 11], cols: ['#c4ae72', '#d4bc80'], tip: ['#f2e2b4'], base: '#a07a50', fan: 1.1, bend: 0.5, back: 1 }),
  ]),
});

// A lumpy snow mound at the base of a card: 3-5 overlapping lumps lit on the upper left, blue
// underneath, fading out over its bottom fifth so it settles into the snow on the ground.
function snowMound(g, cx, by, w, h, rnd) {
  const L = makeCanvas(256), lg = L.getContext('2d');
  const X = 128, n = 3 + Math.floor(rnd() * 3), lumpsL = [];
  for (let i = 0; i < n; i++) lumpsL.push([X + (i / (n - 1) - 0.5) * w * 1.1 + range(rnd, -6, 6), range(rnd, 0.55, 1) * h, w * range(rnd, 0.3, 0.45)]);
  for (const [x, hh, r] of lumpsL) blob(lg, x + r * 0.12, 250 - hh * 0.45, r * 1.05, hh * 0.62, 0, '#8a9cbc', 0.9, 0.8);
  for (const [x, hh, r] of lumpsL) ellipse(lg, x, 252 - hh * 0.5, r, hh * 0.55, 0, '#dfe6ee');
  for (const [x, hh, r] of lumpsL) blob(lg, x - r * 0.25, 250 - hh * 0.72, r * 0.72, hh * 0.32, 0, '#fbf8f0', 0.95, 0.6);
  for (const [x, hh, r] of lumpsL) blob(lg, x + r * 0.35, 252 - hh * 0.22, r * 0.6, hh * 0.3, 0, '#a8b8d2', 0.55, 0.45);
  lg.globalCompositeOperation = 'destination-out';
  const gr = lg.createLinearGradient(0, 256 - h * 0.25, 0, 256); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
  lg.fillStyle = gr; lg.fillRect(0, 256 - h * 0.25, 256, h * 0.25);
  g.drawImage(L, cx - 128, by - 256 + 2);
}
register('clutter_snow', {
  family: 'terrain', w: 1024, h: 512, alpha: true, note: 'cells: dry grass through snow, frosted heather twigs, snowy juniper sprig, snow tussock, a snow drift with grass tips, short dry grass, a dead frosted shrub, a small drift',
  paint: clutterAtlas([
    (g, ox, oy, rnd) => {
      tuft(g, ox + 128, oy + 254, rnd, { n: 9, spread: 60, len: [80, 170], wid: [8, 13], cols: ['#a8946a', '#bca878', '#8e8456', '#c4b282'], tip: ['#eadcae', '#f2e6c0'], base: '#8a7c60', fan: 0.9, bend: 0.5 });
      snowMound(g, ox + 128, oy + 256, 60, 16, rnd);
    },
    (g, ox, oy, rnd) => {
      twigsCell(g, ox, oy, rnd, { col: '#5a4448', lit: '#9a8a90', n: 6 });
      for (let i = 0; i < 70; i++) {          // frost on the twig tips
        const x = ox + 128 + range(rnd, -90, 90), y = oy + range(rnd, 40, 200);
        const d = g.getImageData(Math.max(0, Math.min(1023, Math.round(x))), Math.max(0, Math.min(511, Math.round(y))), 1, 1).data;
        if (d[3] > 100) { blob(g, x, y - 2, 5, 3.5, 0, '#f4f6fa', 0.9, 0.5); blob(g, x + 1, y, 3, 2, 0, '#9fb0cc', 0.4, 0.4); }
      }
      snowMound(g, ox + 128, oy + 256, 50, 14, rnd);
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
      snowMound(g, ox + 128, oy + 256, 60, 14, rnd);
    },
    (g, ox, oy, rnd) => {
      // a tall frosted tussock: dry grass bowed under a little snow
      tuft(g, ox + 128, oy + 254, rnd, { n: 11, spread: 66, len: [110, 200], wid: [8, 12], cols: ['#a8946a', '#bca878', '#8e8456'], tip: ['#eadcae', '#f4ead0'], base: '#8a7a5a', fan: 1.1, bend: 0.7 });
      for (let i = 0; i < 18; i++) { const x = ox + 128 + range(rnd, -70, 70), y = oy + range(rnd, 70, 200); const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; if (d[3] > 100) { blob(g, x, y - 2, 7, 4, 0, '#f4f6fa', 0.9, 0.55); blob(g, x + 1, y + 1, 4, 2, 0, '#9fb0cc', 0.4, 0.4); } }
      snowMound(g, ox + 128, oy + 256, 56, 14, rnd);
    },
    (g, ox, oy, rnd) => {
      tuft(g, ox + 128, oy + 254, rnd, { n: 6, spread: 60, len: [50, 100], wid: [8, 12], cols: ['#a8946a', '#bca878'], tip: ['#eadcae'], base: '#8a7a5a', fan: 1.0, bend: 0.5, back: 1 });
      snowMound(g, ox + 128, oy + 256, 104, 60, rnd);
    },
    (g, ox, oy, rnd) => { tuft(g, ox + 128, oy + 254, rnd, { n: 8, spread: 50, len: [60, 120], wid: [8, 12], cols: ['#b4a274', '#a8946a', '#c4b282'], tip: ['#f0e4bc'], base: '#8a7c60', fan: 1.1, bend: 0.6, back: 1 }); snowMound(g, ox + 128, oy + 256, 50, 12, rnd); },
    (g, ox, oy, rnd) => {
      twigsCell(g, ox, oy, rnd, { col: '#4e3c3a', lit: '#8a7a7c', n: 8 });
      for (let i = 0; i < 90; i++) {
        const x = ox + 128 + range(rnd, -100, 100), y = oy + range(rnd, 30, 220);
        const d = g.getImageData(Math.max(0, Math.min(1023, Math.round(x))), Math.max(0, Math.min(511, Math.round(y))), 1, 1).data;
        if (d[3] > 100) { blob(g, x, y - 2, 6, 3.5, 0, '#f4f6fa', 0.9, 0.5); blob(g, x + 1, y, 3, 2, 0, '#9fb0cc', 0.4, 0.4); }
      }
      snowMound(g, ox + 128, oy + 256, 60, 18, rnd);
    },
    (g, ox, oy, rnd) => { snowMound(g, ox + 128, oy + 256, 90, 40, rnd); tuft(g, ox + 110, oy + 236, rnd, { n: 4, spread: 26, len: [30, 60], wid: [6, 9], cols: ['#a8946a'], tip: ['#eadcae'], base: '#8a7a5a', back: 0 }); },
  ]),
});
// ---- the sky: painted cloud bands, one per biome (x = azimuth, y = elevation; bottom = horizon) --
// Luminance is the shading (the sky shader maps it between the hour's cloud shade and light
// colours), alpha is density. Each biome has its own sky: towering cumulus over Elwynn, rows of
// fair-weather cumulus low over Westfall, cirrus and a gray overcast cap over Dun Morogh, long
// streaky cirrus and haze over the Badlands, a nearly clear sky over Tanaris.

function cloudBand(spec) {
  return (g, w, rnd, h) => {
    const VX = 2.2, VW = w * VX;   // paint in "round" virtual space, squashed into the band
    const L = makeCanvas(w, h), lg = L.getContext('2d');
    const lay = (density, fn) => {
      lg.setTransform(1, 0, 0, 1, 0, 0); lg.clearRect(0, 0, w, h);
      lg.setTransform(1 / VX, 0, 0, 1, 0, 0);
      fn(lg);
      g.save(); g.globalAlpha = density; g.drawImage(L, 0, 0); g.restore();
    };
    const at = (x, r, fn) => { for (const o of [-VW, 0, VW]) if (x + o > -r && x + o < VW + r) fn(x + o); };
    // an overcast cap: a gray-blue stratus deck with a lumpy lit top, lying along the horizon
    if (spec.overcast) {
      const O = spec.overcast, top = periodic(rnd, 8, 0.8, 2), lumpsN = Math.round(VW / 120);
      lay(O.d, cg => {
        cg.fillStyle = O.base;
        cg.beginPath(); cg.moveTo(0, h);
        for (let i = 0; i <= 200; i++) { const x = i / 200 * VW; cg.lineTo(x, O.y + top(i / 200) * O.amp); }
        cg.lineTo(VW, h); cg.closePath(); cg.fill();
        for (let i = 0; i < lumpsN; i++) {
          const x = rnd() * VW, r = range(rnd, 24, 110), y = O.y + top(x / VW) * O.amp + range(rnd, -0.1, 0.35) * r;
          at(x, r, X => { blob(cg, X, y + r * 0.3, r * 1.2, r * 0.6, 0, O.base, 1, 0.85); blob(cg, X - r * 0.2, y + r * 0.05, r * 0.8, r * 0.35, 0, O.lit, 0.8, 0.8); });
        }
        const gr = cg.createLinearGradient(0, O.y, 0, h); gr.addColorStop(0, rgba(O.base, 0)); gr.addColorStop(0.5, rgba(O.under, 0.5)); gr.addColorStop(1, rgba(O.under, 0.8));
        cg.globalCompositeOperation = 'source-atop'; cg.fillStyle = gr; cg.fillRect(0, O.y, VW, h - O.y); cg.globalCompositeOperation = 'source-over';
      });
    }
    // cirrus: each streak is 3-6 short feathered strokes in a loose echelon, tapered at both ends,
    // bent a little, never one long smooth arc
    const C = spec.cirrus;
    if (C) for (let i = 0; i < C.n; i++) {
      const x0 = rnd() * VW, y0 = range(rnd, C.y[0], C.y[1]), m = 3 + Math.floor(rnd() * 4), th = range(rnd, C.th[0], C.th[1]), slope = range(rnd, -0.08, 0.08);
      lay(range(rnd, C.d[0], C.d[1]), cg => {
        let sx = x0, sy = y0;
        for (let j = 0; j < m; j++) {
          const Ln = range(rnd, 220, 600) * (C.len[1] / 1700), n = Math.max(5, Math.round(Ln / 40)), bend = range(rnd, -18, 18), tw = th * range(rnd, 0.6, 1.1);
          const strands = 2 + Math.floor(rnd() * 3);
          at(sx, Ln, X => {
            for (let q = 0; q < strands; q++) {
              const oy = (q - (strands - 1) / 2) * tw * 0.9 + range(rnd, -2, 2), ox = range(rnd, -0.15, 0.15) * Ln, lk = range(rnd, 0.55, 1);
              for (let k = 0; k < n; k++) {
                const t2 = k / (n - 1), x = X + ox + (t2 - 0.5) * Ln * lk, y = sy + oy + Math.sin(t2 * Math.PI) * bend + (t2 - 0.5) * Ln * slope + range(rnd, -2, 2);
                const taper = Math.sin(Math.PI * (0.06 + t2 * 0.88));
                blob(cg, x, y, range(rnd, 30, 60), Math.max(1.2, tw * 0.45 * taper * range(rnd, 0.7, 1.1)), range(rnd, -0.05, 0.05), pick(rnd, ['#f4f4f6', '#e8ecf2']), range(rnd, 0.3, 0.55) * taper, 0.2);
              }
            }
          });
          sx += Ln * range(rnd, 0.55, 0.95); sy += range(rnd, -14, 14) + Ln * slope * 0.6;
        }
      });
    }
    // cumulus: puffs of very different sizes merged into one silhouette, shaded per pixel from the
    // merged form (light from the upper left and in front), so only the lower-right side of each
    // bulge turns cool and nothing outside the white is ever shaded; feathered edges, a flat
    // slightly cooler base, a few torn wisps
    const clusters = spec.clusters(rnd, VW);
    clusters.sort((a, b) => a.yb - b.yb);
    const CU = new Float32Array(w * h * 4);          // premultiplied rgba, composited back to front
    const Lc = [-0.5, -0.55, 0.67], Ln = Math.hypot(...Lc), LIT = hex('#fffaf2'), MID = hex('#eceef4'), SHD = hex('#b4bcd4'), BASE = hex('#a8b0cc');
    for (const K of clusters) {
      const n = Math.round(K.puffs ?? range(rnd, 10, 18)), puffs = [];
      for (let k = 0; k < n; k++) {
        const t2 = (k + rnd() * 0.9) / n, mid = 1 - Math.abs(t2 - 0.5) * 1.8;
        const r = K.h * range(rnd, 0.16, 0.5) * (0.55 + mid * 0.65);          // sizes vary three to one
        puffs.push({ x: K.x + (t2 - 0.5) * K.w * 0.9, y: K.yb - r * 0.45 - Math.max(0, mid) * K.h * range(rnd, 0.05, 0.42), r });
      }
      for (let k = 0; k < (K.towers ?? 1); k++) {
        const r = K.h * range(rnd, 0.22, 0.36);
        puffs.push({ x: K.x + range(rnd, -0.28, 0.28) * K.w, y: K.yb - K.h + r * range(rnd, 0.9, 1.3), r });
      }
      const X0 = Math.floor((K.x - K.w * 0.8) / VX), X1 = Math.ceil((K.x + K.w * 0.8) / VX), Y0 = Math.max(0, Math.floor(K.yb - K.h * 1.4)), Y1 = Math.min(h - 1, Math.ceil(K.yb + 2));
      const cx = K.x, cyc = K.yb - K.h * 0.45, gw = K.w * 0.55, gh = K.h * 0.6, fe = (spec.fe ?? 5) * VX, planes = spec.planes ?? 0.35, Lf = spec.lFloor ?? 0;
      for (let y = Y0; y <= Y1; y++) for (let xx = X0; xx <= X1; xx++) {
        const vx = xx * VX + 0.5 * VX;
        let best = -1, bh = 0, nx = 0, ny = 0, cov = 0;
        for (const p of puffs) {
          const dx = vx - p.x, dy = y - p.y, d2 = dx * dx + dy * dy;
          if (d2 >= p.r * p.r) continue;
          const hh = Math.sqrt(p.r * p.r - d2);
          cov = Math.max(cov, Math.min(1, (p.r - Math.sqrt(d2)) / fe));
          if (hh + p.r * 0.15 > bh) { bh = hh + p.r * 0.15; best = p; nx = dx / p.r; ny = dy / p.r; }
        }
        if (!best || cov <= 0) continue;
        // blend the puff's own normal with the whole cloud's, so bulges read but never ring
        const gx = (vx - cx) / gw, gy = (y - cyc) / gh;
        let mx = nx * 0.6 + gx * 0.4 * 0.7, my = ny * 0.6 + gy * 0.4 * 0.7;
        const mz = Math.sqrt(Math.max(0.05, 1 - mx * mx - my * my)), ml = Math.hypot(mx, my, mz);
        let L = (mx * Lc[0] + my * Lc[1] + mz * Lc[2]) / (ml * Ln);
        L = Math.max(0, Math.min(1, (L - 0.15) / 0.8));
        L = L * (1 - planes) + planes * Math.round(L * 3) / 3;                     // a few painted planes (none on the soft skies)
        L = Lf + (1 - Lf) * L;                                                      // the soft skies keep their shade light
        const c = L > 0.55 ? mixRGB(MID, LIT, (L - 0.55) / 0.45) : mixRGB(SHD, MID, L / 0.55);
        const base = sst(K.yb - K.h * 0.3, K.yb, y) * 0.5;                      // the flat base, a little cooler
        const cr = c.r + (BASE.r - c.r) * base, cg = c.g + (BASE.g - c.g) * base, cb = c.b + (BASE.b - c.b) * base;
        const a = cov * K.d * sst(K.yb + 1, K.yb - 3, y);
        const X = ((xx % w) + w) % w, o = (y * w + X) * 4;
        CU[o] = cr * a + CU[o] * (1 - a); CU[o + 1] = cg * a + CU[o + 1] * (1 - a); CU[o + 2] = cb * a + CU[o + 2] * (1 - a); CU[o + 3] = a + CU[o + 3] * (1 - a);
      }
      // torn wisps trailing off the sides and the base
      lay(K.d * 0.8, cg => at(K.x, K.w, X => {
        const dx = X - K.x;
        for (let k = 0; k < 3 + Math.floor(rnd() * 3); k++) {
          const wx = K.x + range(rnd, -0.5, 0.5) * K.w + dx, wy = K.yb - range(rnd, 0.02, 0.3) * K.h, L2 = range(rnd, 0.2, 0.45) * K.w, th = range(rnd, 0.04, 0.08) * K.h, dir = wx > X ? 1 : -1;
          for (let q = 0; q < 6; q++) { const t2 = q / 5; blob(cg, wx + dir * t2 * L2, wy + t2 * th * 1.5, L2 * 0.22 * (1 - t2 * 0.6), th * (1 - t2 * 0.7), 0, '#eef0f4', 0.45 * (1 - t2 * 0.8), 0.2); }
        }
      }));
    }
    {
      const cu = makeCanvas(w, h), cgx = cu.getContext('2d'), img = cgx.createImageData(w, h), D = img.data;
      for (let i = 0; i < w * h; i++) { const a = CU[i * 4 + 3]; if (a <= 0) continue; D[i * 4] = CU[i * 4] / a; D[i * 4 + 1] = CU[i * 4 + 1] / a; D[i * 4 + 2] = CU[i * 4 + 2] / a; D[i * 4 + 3] = Math.round(a * 255); }
      cgx.putImageData(img, 0, 0);
      g.drawImage(cu, 0, 0);
    }
    feather(g, w, h, spec.feather ?? 1.6);
    // a haze band low along the horizon
    if (spec.haze) {
      const gr = g.createLinearGradient(0, h - spec.haze.h, 0, h);
      gr.addColorStop(0, 'rgba(240,236,230,0)'); gr.addColorStop(1, `rgba(240,236,230,${spec.haze.a})`);
      g.fillStyle = gr; g.fillRect(0, h - spec.haze.h, w, spec.haze.h);
    }
    g.save(); g.globalCompositeOperation = 'destination-out';
    const gr = g.createLinearGradient(0, h - 40, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.fillStyle = gr; g.fillRect(0, h - 40, w, 40);
    g.restore();
  };
}

const CLOUDS = {
  meadow: {
    note: 'Elwynn: big soft towering cumulus all round the sky (one every ~45 degrees, so two or three are always in view), a few flat banks low on the horizon, faint cirrus',
    cirrus: { n: 5, y: [40, 200], len: [600, 1300], th: [8, 16], d: [0.2, 0.34] },
    fe: 6, planes: 0.18, lFloor: 0.12, feather: 2.4,
    clusters: (rnd, VW) => {
      const o = [];
      // the big ones, evenly round the band (the band drifts, so any view always holds two or three)
      for (let i = 0; i < 8; i++) {
        const W = range(rnd, 290, 430);
        o.push({ x: (i + 0.2 + rnd() * 0.6) / 8 * VW, yb: range(rnd, 285, 330), w: W, h: W * range(rnd, 0.44, 0.6), d: range(rnd, 0.8, 0.95), towers: 2 + Math.floor(rnd() * 3), puffs: range(rnd, 15, 22) });
      }
      // a flat lobe or two trailing off some of them
      for (let i = 0; i < 6; i++) { const W = range(rnd, 160, 260); o.push({ x: (i + rnd()) / 6 * VW, yb: range(rnd, 335, 360), w: W, h: W * range(rnd, 0.26, 0.34), d: range(rnd, 0.55, 0.75), towers: 0, puffs: range(rnd, 8, 12) }); }
      for (let i = 0; i < 8; i++) { const W = range(rnd, 100, 200); o.push({ x: rnd() * VW, yb: range(rnd, 362, 395), w: W, h: W * range(rnd, 0.28, 0.38), d: range(rnd, 0.45, 0.7), towers: 1, puffs: range(rnd, 7, 10) }); }
      return o;
    },
  },
  fields: {
    note: 'Westfall: rows of flat-bottomed fair-weather cumulus low over the horizon',
    cirrus: { n: 2, y: [60, 200], len: [500, 1000], th: [6, 14], d: [0.2, 0.3] },
    clusters: (rnd, VW) => {
      const o = [];
      for (const [row, n, W0, W1] of [[335, 14, 140, 300], [380, 18, 90, 200]]) for (let i = 0; i < n; i++) {
        const W = range(rnd, W0, W1);
        o.push({ x: (i + rnd() * 0.8) / n * VW, yb: row + range(rnd, -8, 8), w: W, h: W * range(rnd, 0.3, 0.4), d: range(rnd, 0.7, 0.95), towers: rnd() < 0.5 ? 1 : 0, puffs: range(rnd, 8, 13) });
      }
      for (let i = 0; i < 4; i++) { const W = range(rnd, 200, 320); o.push({ x: rnd() * VW, yb: range(rnd, 250, 300), w: W, h: W * 0.38, d: 0.8, towers: 1, puffs: 12 }); }
      return o;
    },
  },
  snow: {
    note: 'Dun Morogh: high cirrus and a gray-blue overcast cap lying over the peaks',
    overcast: { y: 355, amp: 30, base: '#c4ccda', lit: '#eef0f6', under: '#9aa4b8', d: 0.85 },
    cirrus: { n: 10, y: [30, 300], len: [700, 1700], th: [8, 20], d: [0.3, 0.5] },
    clusters: (rnd, VW) => { const o = []; for (let i = 0; i < 4; i++) { const W = range(rnd, 220, 380); o.push({ x: rnd() * VW, yb: range(rnd, 300, 340), w: W, h: W * 0.4, d: 0.85, towers: 2, puffs: 14 }); } return o; },
  },
  badlands: {
    note: 'Badlands: long streaky cirrus and dusty haze, a few small cumulus far off',
    cirrus: { n: 8, y: [30, 300], len: [1000, 2200], th: [14, 30], d: [0.3, 0.5] },
    clusters: (rnd, VW) => { const o = []; for (let i = 0; i < 3; i++) { const W = range(rnd, 120, 200); o.push({ x: rnd() * VW, yb: range(rnd, 360, 390), w: W, h: W * 0.35, d: 0.6, towers: 1, puffs: 9 }); } return o; },
    haze: { h: 120, a: 0.35 },
  },
  desert: {
    note: 'Tanaris: a nearly clear sky, one or two wisps',
    cirrus: { n: 3, y: [80, 260], len: [500, 900], th: [6, 12], d: [0.3, 0.45] },
    clusters: (rnd, VW) => [{ x: rnd() * VW, yb: 380, w: 150, h: 50, d: 0.55, towers: 1, puffs: 8 }],
    haze: { h: 80, a: 0.2 },
  },
};
for (const b of Object.keys(CLOUDS)) {
  register(`sky_clouds_${b}`, { family: 'terrain', w: 2048, h: 512, alpha: true, note: CLOUDS[b].note, paint: cloudBand(CLOUDS[b]) });
}

// ---- the horizon: three rows of distant land (far / mid / near), alpha --------------------------
// Each row is a chain of shapes (tileable around the ring). Peaks have rounded shoulders and two or
// three broad lit and shaded planes per side; forests and pines grow in clumps with gaps between;
// mesas stand on a flared talus apron under a notched caprock. Each row also carries hero shapes
// at the azimuths straight down the road (the ring's u = 0 and 0.5), so the far end of the valley
// always shows painted land, never a gap of fog.

const MTN = {
  meadow: [
    { col: '#7d92a4', lo: 0.30, hi: 0.95, kind: 'peak', n: 13, hero: [[0.0, 0.07, 1], [0.5, 0.06, 0.95]] },
    { col: '#5f8070', lo: 0.22, hi: 0.62, kind: 'hill', n: 16, hero: [[0.37, 0.09, 1], [0.87, 0.08, 0.95]], dots: 120, dotC: '#3a5a40' },
    { col: '#4a6a3e', lo: 0.20, hi: 0.5, kind: 'forest', n: 30, hero: [[0.71, 0.05, 1]] },
  ],
  fields: [
    { col: '#94978a', lo: 0.25, hi: 0.70, kind: 'hill', n: 15, hero: [[0.0, 0.08, 1], [0.5, 0.07, 0.9]] },
    { col: '#a29a66', lo: 0.18, hi: 0.48, kind: 'hill', n: 18, hero: [[0.37, 0.08, 1], [0.87, 0.08, 1]], dots: 40, dotC: '#6a7040' },
    { col: '#6f7e40', lo: 0.14, hi: 0.36, kind: 'forest', n: 18, hero: [[0.71, 0.04, 1]] },
  ],
  // (tiers: stepped flanks, flat benches and level strata bands, Thousand Needles style)
  badlands: [
    { col: '#b07a5c', lo: 0.25, hi: 0.85, kind: 'mesa', tiers: true, n: 12, bands: ['#b4684a', '#c98a64', '#a05a40', '#d8a27a'], hero: [[0.0, 0.03, 1], [0.025, 0.022, 0.72], [-0.03, 0.026, 0.84], [0.5, 0.028, 0.92], [0.527, 0.02, 0.66], [0.47, 0.024, 0.78]] },
    { col: '#a8603e', lo: 0.20, hi: 0.62, kind: 'mesa', tiers: true, n: 14, bands: ['#a4522f', '#c4703f', '#8e4428', '#d8945a'], hero: [[0.37, 0.07, 1], [0.87, 0.06, 0.95]] },
    { col: '#94523a', lo: 0.14, hi: 0.42, kind: 'mesa', tiers: true, n: 15, bands: ['#984a2c', '#b8663a', '#7e3a24', '#cc8650'], hero: [[0.71, 0.05, 1], [0.74, 0.03, 0.7]] },
  ],
  snow: [
    { col: '#8494ae', lo: 0.38, hi: 1.0, kind: 'peak', n: 13, snow: 0.55, hero: [[0.0, 0.07, 1], [0.5, 0.06, 0.95]] },
    { col: '#6c7c96', lo: 0.26, hi: 0.72, kind: 'peak', n: 16, snow: 0.42, hero: [[0.37, 0.07, 1], [0.87, 0.07, 0.95]] },
    { col: '#34504e', lo: 0.20, hi: 0.5, kind: 'pines', n: 34, snow: 0.35, hero: [[0.71, 0.045, 1]] },
  ],
  desert: [
    { col: '#c4a07e', lo: 0.20, hi: 0.70, kind: 'mesa', n: 10, hero: [[0.0, 0.03, 1], [0.028, 0.022, 0.7], [-0.03, 0.026, 0.82], [0.5, 0.028, 0.9], [0.53, 0.02, 0.64], [0.47, 0.024, 0.76]] },
    { col: '#d0ac84', lo: 0.14, hi: 0.42, kind: 'dune', n: 14, hero: [[0.37, 0.09, 1], [0.87, 0.08, 0.95]] },
    { col: '#c49a6a', lo: 0.10, hi: 0.30, kind: 'dune', n: 18, hero: [[0.71, 0.08, 1]] },
  ],
};

function mtnRow(rnd, L, w, rowH) {
  const out = [];
  const tree = L.kind === 'forest' || L.kind === 'pines';
  const add = (x, wid, hgt, extra = {}) => out.push({ x: ((x % w) + w) % w, h: (L.lo + (L.hi - L.lo) * hgt) * rowH, wid, gam: range(rnd, 0.75, 1.1), skew: range(rnd, -0.35, 0.35), ph: rnd() * 6, strat: rnd(), notch: periodic(rnd, 5, 0.6, 3), gul: periodic(rnd, 6, 0.75, 3), z: rnd(), ...extra });
  if (tree) {
    // clumps of trees with gaps between them; canopy sizes vary three to one
    const groups = L.n;
    for (let gI = 0; gI < groups; gI++) {
      const gx = (gI + rnd() * 0.7) / groups * w, k = 3 + Math.floor(rnd() * 7), r0 = L.kind === 'pines' ? range(rnd, 5, 9) : range(rnd, 9, 18), gh = range(rnd, 0.45, 1);
      for (let i = 0; i < k; i++) { const r = r0 * range(rnd, 0.5, 1.5); add(gx + range(rnd, -1.4, 1.4) * r0 * Math.sqrt(k), r, Math.min(1, gh * range(rnd, 0.55, 1.05) * (0.55 + 0.45 * r / (r0 * 1.5)))); }
    }
    for (const [hx, , hh] of L.hero || []) {       // a big clump straight down the road
      for (let i = 0; i < 22; i++) { const r = (L.kind === 'pines' ? 8 : 16) * range(rnd, 0.6, 1.5); add(hx * w + range(rnd, -1, 1) * w * 0.03, r, Math.min(1, hh * range(rnd, 0.75, 1.05))); }
    }
  } else {
    for (let i = 0; i < L.n; i++) {
      const hgt = range(rnd, 0.25, 1) ** 1.2;
      const wid = L.kind === 'mesa' ? range(rnd, 90, 240) : range(rnd, 0.8, 1.6) * w / L.n * (0.6 + hgt);
      add(rnd() * w, wid, hgt);
    }
    for (const [hx, hw, hh] of L.hero || []) add(hx * w + range(rnd, -8, 8), hw * w, hh, { hero: true, z: -1 + rnd() * 0.1 });
  }
  return out;
}
const PU = [0];
function peakAt(P, kind, x, w, tiers = false) {        // height of shape P at column x (wrapped); its u (-1..1) goes to PU[0]
  let d = x - P.x; if (d > w / 2) d -= w; if (d < -w / 2) d += w;
  const u = d / P.wid; PU[0] = u;
  if (u <= -1 || u >= 1) return -1;
  const e = Math.abs(u);
  if (kind === 'mesa' && tiers) {
    // a flat caprock, then the flank stepping down in one to three tiers (a steep riser, a flat
    // bench), then a short talus; each side has its own number of tiers
    const cap = P.h - 3 - P.notch(x / w) * 3 - P.notch(x / w * 3.7 + 0.3) * 1.5;
    const nT = 1 + Math.floor(((u < 0 ? P.strat : P.z) * 2.99 + (P.hero ? 1 : 0)) % 3);
    if (e < 0.38) return cap;
    if (e < 0.8) {
      const f = (e - 0.38) / 0.42, t = Math.min(nT - 1, Math.floor(f * nT)), ft = f * nT - t;
      const hi = cap * (1 - t * 0.58 / nT), lo = cap * (1 - (t + 1) * 0.58 / nT);
      return hi + (lo - hi) * sst(0, 0.28, ft);
    }
    return cap * 0.42 * Math.pow(1 - (e - 0.8) / 0.2, 1.5);
  }
  if (kind === 'forest') return P.h * Math.sqrt(1 - u * u);
  if (kind === 'pines') return P.h * Math.pow(1 - e, 0.9) * (1 - 0.1 * (Math.floor((1 - e) * 4) % 2));
  if (kind === 'mesa') {
    // a caprock with a jittered top and rounded shoulders, one side stepped down to a lower bench,
    // a cliff whose sides taper (never vertical), then a flared talus apron
    const cap = P.h - 4 - P.notch(x / w) * 6 - P.notch(x / w * 3.7 + 0.3) * 3;
    const bench = (P.strat < 0.5 ? u > 0.12 : u < -0.12) ? P.h * (0.14 + 0.1 * P.strat) * sst(0.1, 0.16, e) : 0;
    const sh = sst(0.3, 0.4, e);
    if (e < 0.4) return cap - sh * 5 - bench;
    if (e < 0.6) { const f = (e - 0.4) / 0.2; return cap - 5 - bench - ((cap - bench) * 0.38) * (f * f * 0.4 + f * 0.6); }
    return P.h * 0.6 * Math.pow(1 - (e - 0.6) / 0.4, 1.6);
  }
  const v = u < P.skew ? (u + 1) / (P.skew + 1) : (1 - u) / (1 - P.skew);
  if (kind === 'dune') return P.h * Math.pow(Math.max(0, v), 1.3);
  if (kind === 'hill') return P.h * Math.pow(Math.max(0, Math.sin(v * Math.PI / 2)), 1.3);
  // peak: rounded shoulders, a firm summit
  const tri = Math.max(0, v), dome = Math.sin(tri * Math.PI / 2);
  return P.h * (0.45 * Math.pow(tri, P.gam) + 0.55 * dome * dome);
}

for (const b of Object.keys(MTN)) {
  register(`sky_mtn_${b}`, {
    family: 'terrain', w: 2048, h: 768, alpha: true, note: `${b}: distant land in rows far/mid/near (fog-tinted in the shader), hero shapes straight down the road`,
    paint(g, w, rnd, h) {
      const img = g.createImageData(w, h), D = img.data;
      const rowH = h / 3;
      MTN[b].forEach((L, row) => {
        const peaks = mtnRow(rnd, L, w, rowH);
        const tree = L.kind === 'forest' || L.kind === 'pines';
        const base = hex(L.col), lit = hex(mix(lightOf(L.col, 0.45), '#fff0d0', 0.15)), dark = hex(mix(shadowOf(L.col, 0.36), L.cool || '#6a7aa4', 0.3)), haze = hex(mix(L.col, '#e8eef0', 0.3));
        const bandC = [hex(shade(L.col, 0.88)), hex(lightOf(L.col, 0.18)), hex(shadowOf(L.col, 0.12))];
        const rough = periodic(rnd, 9, 0.6, 30), roll = periodic(rnd, 6, 1.1, 2);
        const snowLit = hex('#f4f6fa'), snowShd = hex('#aebfd8'), snowRough = periodic(rnd, 8, 0.7, 12);
        const baseH = x => (tree ? 0.35 : 0.75) * (L.lo * 0.75 + (L.hi - L.lo) * (0.14 + 0.12 * roll(x / w))) * rowH;
        const BASE = { h: 0, wid: 1, skew: 0, ph: 0, strat: 0.3 };
        // which shapes can cover each column (so a column only looks at its own few)
        const cols = Array.from({ length: w }, () => []);
        for (const P of peaks) { const x0 = Math.floor(P.x - P.wid), x1 = Math.ceil(P.x + P.wid); for (let x = x0; x <= x1; x++) cols[((x % w) + w) % w].push(P); }
        for (const C0 of cols) C0.sort((p, q) => p.z - q.z);
        let r = 0, gg = 0, bb = 0;
        const mixTo = (c, t) => { r += (c.r - r) * t; gg += (c.g - gg) * t; bb += (c.b - bb) * t; };
        for (let x = 0; x < w; x++) {
          // every shape covering this column, front first: a pixel belongs to the front-most shape
          // that reaches it, so overlapping shapes overlap along their slopes, never at a vertical cut
          const cov = [];
          for (const P of cols[x]) { const ph = peakAt(P, L.kind, x, w, L.tiers); if (ph > 0) cov.push([P, ph, PU[0]]); }
          const rgh = rough(x / w) * (tree ? 1.2 : 2.5), bh = baseH(x);
          let top = bh; for (const c of cov) top = Math.max(top, c[1]);
          top += rgh;
          const bdir = (baseH(x + 3) - baseH(x - 3)) < 0 ? -0.3 : 0.3, sr = snowRough(x / w);
          for (let yy = 0; yy < rowH; yy++) {
            const hb = rowH - 1 - yy;
            const a = Math.max(0, Math.min(1, top - hb + 0.5));
            const k = ((row * rowH + yy) * w + x) * 4;
            if (a <= 0) { D[k] = base.r; D[k + 1] = base.g; D[k + 2] = base.b; D[k + 3] = 0; continue; }
            let best = BASE, bu = bdir, ptop = bh + rgh;
            for (const c of cov) if (c[1] + rgh >= hb) { best = c[0]; bu = c[2]; ptop = c[1] + rgh; break; }
            if (best === BASE) BASE.h = bh;
            const depth = Math.max(0, (ptop - hb) / Math.max(8, ptop));   // 0 at its ridge → 1 at the base
            let f;                                                          // facing: + lit, - shaded
            if (tree) {
              const vy = Math.min(1, (ptop - hb) / Math.max(4, best.h));
              f = -bu * 0.9 + (1 - vy) * 0.5 - 0.15;
            } else if (L.kind === 'mesa' && L.tiers) {
              // faces lit on the left, shaded on the right; every flat top (the cap, each bench) lit
              const e = Math.abs(bu), pa = best === BASE ? 1 : Math.abs(peakAt(best, 'mesa', x + 2, w, true) - peakAt(best, 'mesa', x - 2, w, true)) / 4;
              f = e >= 0.8 ? (bu < 0 ? 0.42 : -0.26) : (bu < 0 ? 0.4 : -0.42) - depth * 0.1;
              if (pa < 0.3 && ptop - hb < 2.4 && best !== BASE) f = 0.85;
            } else if (L.kind === 'mesa') {
              const e = Math.abs(bu);
              if (e < 0.4) f = hb > best.h - 9 ? 0.75 : (bu < 0 ? 0.42 : -0.38) - depth * 0.15;          // caprock: lit top, its two faces
              else if (e < 0.6) f = bu < 0 ? 0.55 : -0.7;                                                // the tapered cliff
              else f = (bu < 0 ? 0.32 : -0.38) + 0.12;                                                   // the talus, paler
            } else {
              // two or three broad planes per side, divided by the angle from the summit, the crest a
              // soft turn (never a ruled bevel), and gullies fanning down from the summit
              const ang = Math.atan2(bu * best.wid, (best.h - hb) + 2);
              const side = Math.tanh((best.skew - bu) * (best === BASE ? 2 : 5));
              f = side * 0.58 * (0.7 + 0.3 * (1 - depth)) + Math.tanh(Math.sin(ang * 1.3 + best.ph) * 2) * 0.16;
              if (best.gul) f += best.gul(ang / Math.PI + 0.5) * 0.22 * Math.min(1, depth * 3) * (1 - depth * 0.6);
            }
            r = base.r; gg = base.g; bb = base.b;
            if (f > 0) mixTo(lit, Math.min(1, f) * 0.85); else mixTo(dark, Math.min(1, -f) * 0.85);
            if (L.tiers && best !== BASE && Math.abs(bu) < 0.8) {          // level strata bands, the same height across neighbours
              const q = (hb + 3) / 11, bi = Math.floor(q), bc = hex(L.bands[((bi % L.bands.length) + L.bands.length) % L.bands.length]);
              mixTo(bc, 0.5);
              if (q - bi < 0.16) mixTo(dark, 0.32); else if (q - bi > 0.88) mixTo(lit, 0.18);
            } else if (L.kind === 'mesa' && Math.abs(bu) < 0.6 && best !== BASE) { mixTo(bandC[Math.floor((hb / Math.max(1, best.h)) * 3 + best.strat * 3) % 3], 0.3); const sp = (hb + best.strat * 40) / (5 + best.strat * 4); if (sp - Math.floor(sp) < 0.22) mixTo(dark, 0.2); }
            if (L.snow && best !== BASE) {                                   // snow caps, lower on the lit planes
              const rel = hb / Math.max(1, best.h);
              const line = 1 - L.snow * (0.7 + 0.6 * best.strat) - (f > 0 ? 0.08 : 0) + sr * 0.08 - (tree ? 0.15 : 0);
              if (rel > line) {
                const t = Math.min(1, (rel - line) * 12) * 0.95, q = f > -0.05 ? Math.min(1, 0.4 + f) : 0;
                const sR = snowShd.r + (snowLit.r - snowShd.r) * q, sG = snowShd.g + (snowLit.g - snowShd.g) * q, sB = snowShd.b + (snowLit.b - snowShd.b) * q;
                r += (sR - r) * t; gg += (sG - gg) * t; bb += (sB - bb) * t;
              }
            }
            mixTo(haze, Math.min(1, depth * 0.8));                           // valley haze toward the base
            if (row > 0 && ptop - hb < 2.2) mixTo(lit, 0.3 * (ptop - hb < 1.2 ? 1 : 0.5));   // a lit rim along each ridge (not on the far row)
            D[k] = r; D[k + 1] = gg; D[k + 2] = bb; D[k + 3] = Math.round(a * 255);
          }
        }
      });
      g.putImageData(img, 0, 0);
      // dark tree clumps dotted over the hills (only where there is land: source-atop)
      MTN[b].forEach((L, row) => {
        if (!L.dots) return;
        g.save(); g.globalCompositeOperation = 'source-atop';
        const rowH = h / 3, y0 = row * rowH;
        for (let i = 0; i < L.dots; i++) {
          const x = rnd() * w, y = y0 + rowH * range(rnd, 0.35, 0.92), k = 3 + Math.floor(rnd() * 5), r0 = range(rnd, 2.2, 4.2);
          for (let j = 0; j < k; j++) {
            const xx = x + range(rnd, -9, 9), yy = y + range(rnd, -3, 3), r = r0 * range(rnd, 0.6, 1.2);
            for (const X of [xx - w, xx, xx + w]) { blob(g, X + 0.6, yy + 0.6, r * 1.1, r, 0, shadowOf(L.dotC, 0.3), 0.9, 0.6); blob(g, X, yy, r, r * 0.9, 0, L.dotC, 0.95, 0.6); blob(g, X - r * 0.3, yy - r * 0.35, r * 0.5, r * 0.4, 0, lightOf(L.dotC, 0.3), 0.6, 0.5); }
          }
        }
        g.restore();
      });
      // soften every row (the far one most: it is the haziest), keeping the land solid down to the
      // row's bottom so no base ever fades out over the sky
      [1.9, 1.2, 0.8].forEach((px, row) => blurRowX(g, w, row * h / 3, h / 3, px));
    },
  });
}
// Blur one row of a band that wraps horizontally; the bottom line is carried on below the row
// first, so the blur never eats into the base of the land.
function blurRowX(g, w, y0, rh, px) {
  const m = Math.ceil(px * 3) + 2, big = makeCanvas(w + 2 * m, rh + 2 * m), bg = big.getContext('2d'), src = g.canvas;
  bg.drawImage(src, 0, y0, w, rh, m, m, w, rh);
  bg.drawImage(src, w - m, y0, m, rh, 0, m, m, rh);
  bg.drawImage(src, 0, y0, m, rh, w + m, m, m, rh);
  bg.drawImage(big, 0, m + rh - 1, w + 2 * m, 1, 0, m + rh, w + 2 * m, m);
  const out = makeCanvas(w + 2 * m, rh + 2 * m), og = out.getContext('2d');
  og.filter = `blur(${px}px)`; og.drawImage(big, 0, 0);
  g.clearRect(0, y0, w, rh); g.drawImage(out, m, m, w, rh, 0, y0, w, rh);
}
// Feather a band (alpha and colour) that wraps around the sky horizontally.
function feather(g, w, h, px) { blurWrapX(g, w, h, px); }
// Blur a band that wraps around the sky horizontally (no seam at u = 0 / 1).
function blurWrapX(g, w, h, px) {
  const m = Math.ceil(px * 4) + 2, big = makeCanvas(w + 2 * m, h), bg = big.getContext('2d');
  bg.drawImage(g.canvas, m, 0); bg.drawImage(g.canvas, w - m, 0, m, h, 0, 0, m, h); bg.drawImage(g.canvas, 0, 0, m, h, w + m, 0, m, h);
  const out = makeCanvas(w + 2 * m, h), og = out.getContext('2d');
  og.filter = `blur(${px}px)`; og.drawImage(big, 0, 0);
  g.clearRect(0, 0, w, h); g.drawImage(out, m, 0, w, h, 0, 0, w, h);
}
function mixRGB(a, b, t) { return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t }; }
// the old single cloud band name, kept as an alias (Elwynn's sky)
register('sky_clouds', { family: 'terrain', w: 2048, h: 512, alpha: true, note: 'alias of sky_clouds_meadow', paint: cloudBand(CLOUDS.meadow) });
