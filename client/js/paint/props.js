// Texture family: props (the loot you carry, throw and pawn). See docs/ART.md.
//
// Every loot piece is painted into ONE atlas, so each prop in the world is one mesh with one
// material: one draw call (plus its shadow). The pieces are registered on their own too, so the
// gallery shows each one (loot_<key>), and the atlas (loot_atlas) is composed from them with
// padded, dilated edges. loot_glow is the matching emissive atlas (lamp glass, lantern panes,
// the CRT, the slot machine's bulbs), a quarter the size.
//
// Pieces (props3d.js maps geometry onto these through REGIONS):
//   wood iron safe porcelain leather sign slot dino gnome portrait strap fret guitar honey brass glass
//   tire gold till screen steel red plaque eye ivory tvfront rim ball rubber parchment lantern skin
//   boot plaster toast bulb tag
// Boulders (not in the atlas, they're 4 m wide): loot_boulder_<biome>, 512×256, u wraps around
// the rock, v runs from the ground (bottom) to the top, so moss / dry grass / snow / dust / sand
// sits on top of the stone the way it does in Elwynn, Westfall, Dun Morogh, the Badlands, Tanaris.
//
// Light comes from the upper left: lit cream edges, cool violet-brown shadows, never pure black.
import {
  register, canvasFor, has, makeCanvas, fill, mottle, streaks, cracks, glaze, blurTile, blob, ellipse, stroke,
  blade, range, pick, wrap, mix, shade, lightOf, shadowOf, jitter, rgba, rngFrom,
} from './core.js';

const F = 'props';
const TAU = Math.PI * 2;
const INK = '#2a2030';
const FONT = `Georgia, 'Palatino Linotype', 'Book Antiqua', Palatino, 'Liberation Serif', 'DejaVu Serif', serif`;

// ---- the atlas layout ----------------------------------------------------------------------------

export const ATLAS_W = 1024, ATLAS_H = 1280, PAD = 3;
const CELLS = {
  wood: [0, 0, 256, 256], iron: [256, 0, 256, 256], porcelain: [512, 0, 256, 256, 'wrap'], leather: [768, 0, 256, 256],
  sign: [0, 256, 512, 256], slot: [512, 256, 256, 512], dino: [768, 256, 256, 256],
  gnome: [0, 512, 256, 256], portrait: [256, 512, 256, 208], strap: [256, 720, 256, 24], fret: [256, 744, 256, 24],
  guitar: [768, 512, 160, 256], honey: [928, 512, 96, 256],
  brass: [0, 768, 256, 128], glass: [0, 896, 256, 128, 'wrap'], tire: [256, 768, 256, 128, 'wrap'],
  gold: [256, 896, 256, 64, 'wrap'], till: [256, 960, 256, 64],
  screen: [512, 768, 128, 128], steel: [640, 768, 128, 128], red: [512, 896, 128, 128], plaque: [640, 896, 128, 32],
  eye: [640, 928, 64, 64], ivory: [704, 928, 64, 64], safe: [768, 768, 256, 256],
  tvfront: [0, 1024, 256, 176], rim: [256, 1024, 128, 128], ball: [384, 1024, 64, 64], rubber: [448, 1024, 64, 64],
  parchment: [384, 1088, 64, 64], lantern: [448, 1088, 64, 64], skin: [512, 1024, 64, 64], boot: [576, 1024, 64, 64],
  plaster: [512, 1088, 64, 64], toast: [576, 1088, 64, 64], bulb: [640, 1024, 64, 64], tag: [640, 1088, 64, 64],
};
// UV rect of each piece in the atlas: { u0, v0, u1, v1 } (v up, three.js convention).
export const REGIONS = Object.fromEntries(Object.entries(CELLS).map(([k, [x, y, w, h, wr]]) => [k, {
  key: k, x, y, w, h, wrap: wr === 'wrap',
  u0: (x + PAD) / ATLAS_W, u1: (x + w - PAD) / ATLAS_W, v0: 1 - (y + h - PAD) / ATLAS_H, v1: 1 - (y + PAD) / ATLAS_H,
}]));
// A sub-rect of a region, in the piece's own canvas fractions (x right, y DOWN, like the painting).
export function sub(R, fx0, fy0, fx1, fy1) {
  const du = R.u1 - R.u0, dv = R.v1 - R.v0;
  return { ...R, u0: R.u0 + du * fx0, u1: R.u0 + du * fx1, v0: R.v1 - dv * fy1, v1: R.v1 - dv * fy0 };
}

// Shapes shared with props3d.js so the paint lines up with the geometry.
// The vase's lathe profile [r, y] (bottom → top, meters), and where its bands fall.
export const VASE_PROFILE = [[0, -0.38], [0.1, -0.38], [0.112, -0.372], [0.108, -0.352], [0.122, -0.33], [0.152, -0.27], [0.18, -0.18], [0.194, -0.08],
  [0.197, 0.0], [0.19, 0.07], [0.166, 0.14], [0.132, 0.2], [0.097, 0.24], [0.08, 0.27], [0.076, 0.31], [0.086, 0.348], [0.104, 0.372], [0.108, 0.38]];
export function arcV(profile) {
  const L = [0];
  for (let i = 1; i < profile.length; i++) L.push(L[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
  return L.map(l => l / L[L.length - 1]);
}
const vaseT = (() => { const v = arcV(VASE_PROFILE); return y => { for (let i = 1; i < VASE_PROFILE.length; i++) if (y <= VASE_PROFILE[i][1] + 1e-9) { const a = VASE_PROFILE[i - 1], b = VASE_PROFILE[i], f = b[1] === a[1] ? 1 : (y - a[1]) / (b[1] - a[1]); return v[i - 1] + (v[i] - v[i - 1]) * f; } return 1; }; })();

// The guitar body outline, normalized: x in [-0.5, 0.5] (width), y in [0, 1] (bottom → top).
export const GUITAR_OUTLINE = (() => {
  const half = y => {
    const lo = y >= 0 && y <= 0.64 ? 0.5 * Math.sqrt(Math.max(0, 1 - ((y - 0.32) / 0.32) ** 2)) : 0;
    const up = y >= 0.48 && y <= 1 ? 0.4 * Math.sqrt(Math.max(0, 1 - ((y - 0.74) / 0.26) ** 2)) : 0;
    return Math.pow(lo ** 6 + up ** 6, 1 / 6);
  };
  const right = [];
  const N = 26;
  for (let i = 0; i <= N; i++) { const y = 0.5 - 0.5 * Math.cos(Math.PI * i / N); right.push([half(y), y]); }
  const pts = [...right, ...right.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
  return pts;
})();
export const GUITAR_HOLE = { x: 0, y: 0.6, r: 0.16 };   // soundhole (r in widths)

// The CRT's front: where the screen and knobs sit, as fractions of the front face (u right, v up).
export const TV_LAYOUT = { screen: [0.08, 0.13, 0.69, 0.87], knobs: [[0.855, 0.83], [0.855, 0.69]] };

// ---- small painting helpers ---------------------------------------------------------------------------

function lin(g, x0, y0, x1, y1, stops) { const gr = g.createLinearGradient(x0, y0, x1, y1); for (const [t, c, a = 1] of stops) gr.addColorStop(t, rgba(c, a)); return gr; }
function radial(g, x, y, r0, r1, stops) { const gr = g.createRadialGradient(x, y, r0, x, y, r1); for (const [t, c, a = 1] of stops) gr.addColorStop(t, rgba(c, a)); return gr; }
function line(g, pts, w, color, alpha = 1, cap = 'round') {
  g.save(); g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = w; g.lineCap = cap; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.stroke(); g.restore();
}
function poly(g, pts) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); }
function rrect(g, x, y, w, h, r, style, alpha = 1) { g.save(); g.globalAlpha *= alpha; g.fillStyle = style; g.beginPath(); g.roundRect(x, y, w, h, r); g.fill(); g.restore(); }
function rect(g, x, y, w, h, style, alpha = 1) { g.save(); g.globalAlpha *= alpha; g.fillStyle = style; g.fillRect(x, y, w, h); g.restore(); }
function clip(g, path, fn) { g.save(); path(); g.clip(); fn(); g.restore(); }
const wrapX = (w, x, r, fn) => { fn(x); if (x - r < 0) fn(x + w); if (x + r > w) fn(x - w); };

// A soft bevel inside a rect: lit top + left, shaded bottom + right (the light is upper left).
function bevel(g, x, y, w, h, c, k = 8, lit = 0.4, dark = 0.45) {
  g.save();
  const L = lightOf(c, 0.6), D = shadowOf(c, 0.6);
  g.fillStyle = lin(g, 0, y, 0, y + k, [[0, L, lit], [1, L, 0]]); g.fillRect(x, y, w, k);
  g.fillStyle = lin(g, x, 0, x + k, 0, [[0, L, lit * 0.75], [1, L, 0]]); g.fillRect(x, y, k, h);
  g.fillStyle = lin(g, 0, y + h, 0, y + h - k, [[0, D, dark], [1, D, 0]]); g.fillRect(x, y + h - k, w, k);
  g.fillStyle = lin(g, x + w, 0, x + w - k, 0, [[0, D, dark * 0.8], [1, D, 0]]); g.fillRect(x + w - k, y, k, h);
  g.restore();
}
function rivet(g, x, y, r, c) {
  blob(g, x + r * 0.45, y + r * 0.6, r * 1.6, r * 1.35, 0, '#1a1418', 0.5, 0.3);
  ellipse(g, x, y, r, r, 0, shadowOf(c, 0.2));
  blob(g, x - r * 0.15, y - r * 0.2, r * 0.85, r * 0.8, 0, c, 0.9, 0.5);
  blob(g, x - r * 0.35, y - r * 0.4, r * 0.55, r * 0.45, 0, lightOf(c, 0.8), 0.9, 0.4);
}
// Wood grain in a rect: wavy lines along x (or y), knots, pores.
function grain(g, x, y, w, h, rnd, { dark, lite, n = 40, vertical = false, amp = 2.5, knots = 1, alpha = 0.42, wid = [0.7, 2.0] }) {
  g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
  const L = vertical ? h : w, A = vertical ? w : h;
  for (let i = 0; i < n; i++) {
    const a0 = rnd() * A, f1 = range(rnd, 1, 3) / L * TAU, f2 = range(rnd, 3, 7) / L * TAU, p1 = rnd() * TAU, p2 = rnd() * TAU, am = amp * range(rnd, 0.4, 1.3);
    const col = rnd() < 0.65 ? pick(rnd, dark) : pick(rnd, lite), lw = range(rnd, wid[0], wid[1]), al = alpha * range(rnd, 0.35, 1);
    const pts = [];
    for (let t = -8; t <= L + 8; t += 6) { const o = a0 + Math.sin(t * f1 + p1) * am + Math.sin(t * f2 + p2) * am * 0.35; pts.push(vertical ? [x + o, y + t] : [x + t, y + o]); }
    line(g, pts, lw, col, al);
  }
  for (let i = 0; i < knots; i++) {
    const kx = x + range(rnd, 0.15, 0.85) * w, ky = y + range(rnd, 0.15, 0.85) * h, r = range(rnd, 3, 6);
    const [rx, ry] = vertical ? [r, r * 1.8] : [r * 1.8, r];
    for (let k = 3; k >= 1; k--) ellipse(g, kx, ky, rx * (1 + k * 0.6), ry * (1 + k * 0.6), 0, k % 2 ? pick(rnd, dark) : pick(rnd, lite), 0.25);
    ellipse(g, kx, ky, rx, ry, 0, pick(rnd, dark), 0.8);
    blob(g, kx - 1, ky - 1, rx * 0.5, ry * 0.5, 0, pick(rnd, lite), 0.5, 0.4);
  }
  g.restore();
}
// Hand-lettered painted text: drop shadow, dark rim lower right, lit rim upper left, gradient fill.
function letters(g, text, x, y, size, { fill: fillC = ['#f8e08a', '#d8a440', '#8a5a1e'], rim = '#2a1a10', lit = '#fff4c8', shadow = 0.55, font = FONT, weight = 'bold', jit = 0.04, rnd = null, track = 0, maxW = 1e9 } = {}) {
  g.save();
  g.font = `${weight} ${size}px ${font}`; g.textBaseline = 'middle'; g.textAlign = 'left';
  let widths = [...text].map(ch => g.measureText(ch).width + track);
  let tot = widths.reduce((a, b) => a + b, 0) - track;
  if (tot > maxW) { size = size * maxW / tot; g.font = `${weight} ${size}px ${font}`; widths = [...text].map(ch => g.measureText(ch).width + track * maxW / tot); tot = maxW; }
  const r = rnd || (() => 0.5);
  const glyphs = [];
  let cx = x - tot / 2;
  for (const [i, ch] of [...text].entries()) { glyphs.push({ ch, x: cx + widths[i] / 2, rot: (r() - 0.5) * jit * 2, dy: (r() - 0.5) * size * jit }); cx += widths[i]; }
  const draw = (dx, dy, style, alpha) => {
    for (const q of glyphs) {
      g.save(); g.globalAlpha = alpha; g.translate(q.x + dx, y + q.dy + dy); g.rotate(q.rot); g.textAlign = 'center';
      g.fillStyle = typeof style === 'function' ? style() : style; g.fillText(q.ch, 0, 0); g.restore();
    }
  };
  const s = Math.max(1, size / 26);
  if (shadow) { g.save(); g.filter = `blur(${(s * 1.5).toFixed(1)}px)`; draw(s * 2.2, s * 2.8, '#140c10', shadow); g.restore(); }
  draw(s * 1.1, s * 1.3, rim, 1);
  draw(-s * 0.8, -s * 0.9, lit, 0.85);
  const grd = () => lin(g, 0, -size * 0.45, 0, size * 0.45, fillC.map((c, i) => [i / (fillC.length - 1), c]));
  draw(0, 0, grd, 1);
  g.restore();
  return { size, width: tot };
}
// Painted stitches along a polyline.
function stitches(g, pts, step, len, color, hole = '#2a1a14', alpha = 0.9) {
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
    for (let t = (step - acc) % step; t < L; t += step) {
      const x = ax + ux * t, y = ay + uy * t;
      ellipse(g, x - ux * len * 0.5, y - uy * len * 0.5, 0.9, 0.9, 0, hole, 0.6 * alpha);
      line(g, [[x - ux * len * 0.4, y - uy * len * 0.4], [x + ux * len * 0.4, y + uy * len * 0.4]], 1.5, color, alpha);
      line(g, [[x - ux * len * 0.3 - 0.4, y - uy * len * 0.3 - 0.4], [x + ux * len * 0.2 - 0.4, y + uy * len * 0.2 - 0.4]], 0.6, '#fff8e0', 0.5 * alpha);
    }
    acc = (acc + L) % step;
  }
}
// Darken toward the border (a painted ambient-occlusion frame).
function vignette(g, x, y, w, h, color = '#1e1622', alpha = 0.35, k = 0.18) {
  g.save();
  const r = Math.max(w, h) * 0.75;
  g.fillStyle = radial(g, x + w * 0.45, y + h * 0.42, r * (1 - k * 2.2), r, [[0, color, 0], [1, color, alpha]]);
  g.fillRect(x, y, w, h); g.restore();
}
function chips(g, rnd, n, x, y, w, h, color, rmin = 1.5, rmax = 4, alpha = 0.85) {
  for (let i = 0; i < n; i++) {
    const cx = x + rnd() * w, cy = y + rnd() * h, r = range(rnd, rmin, rmax);
    const pts = []; for (let k = 0; k < 7; k++) { const a = k / 7 * TAU, rr = r * range(rnd, 0.5, 1.2); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * 0.75]); }
    g.save(); g.globalAlpha = alpha; g.fillStyle = color; poly(g, pts); g.fill(); g.restore();
    line(g, pts.slice(3, 7), 0.8, lightOf(color, 0.6), 0.5);
  }
}

// ---- wood, iron, leather -----------------------------------------------------------------------------

register('loot_wood', {
  family: F, size: 256, note: 'dark stained oak: TV cabinet, plinths, boards (grain along u, a lit bevel at the border)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a3a24');
    mottle(g, s, rnd, { colors: ['#6c4628', '#4a2e1c', '#7a5232', '#553420'], count: 30, rmin: 20, rmax: 80, alpha: 0.35, hard: 0.1, stretch: 3, rot: 0 });
    grain(g, 0, 0, s, s, rnd, { dark: ['#3a2416', '#2e1c14', '#44301e'], lite: ['#86603e', '#946a44'], n: 54, amp: 2.5, knots: 2 });
    streaks(g, s, rnd, { colors: ['#2e1c14'], count: 120, len: [3, 9], width: [0.6, 1.1], angle: Math.PI / 2, wobble: 0.05, alpha: 0.3 });
    mottle(g, s, rnd, { colors: ['#a07850'], count: 12, rmin: 8, rmax: 26, alpha: 0.14, hard: 0.2, stretch: 4, rot: 0 });
    bevel(g, 0, 0, s, s, '#5a3a24', 14, 0.45, 0.5);
    glaze(g, s, s, '#ffd8a8', 0.1);
    blurTile(cv, 0.4);
  },
});

register('loot_honey', {
  family: F, w: 96, h: 256, note: 'honey oak: guitar back and ribs, knobs and handles (grain along v)',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#a8703c');
    for (let i = 0; i < 18; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 10, 30), range(rnd, 30, 70), 0, pick(rnd, ['#b8804a', '#94602e', '#c08a52']), 0.35, 0.1);
    grain(g, 0, 0, w, h, rnd, { dark: ['#6a4220', '#7a4c26'], lite: ['#d09a5c', '#c8925a'], n: 26, vertical: true, amp: 2, knots: 1 });
    bevel(g, 0, 0, w, h, '#a8703c', 7, 0.35, 0.45);
    glaze(g, w, h, '#ffe0b0', 0.12);
    blurTile(cv, 0.4);
  },
});

// riveted iron: the safe's body (dark green lacquer worn to rusty iron at the edges)
function ironPlate(g, s, rnd, { base = '#3c4842', door = false } = {}) {
  fill(g, s, s, base);
  mottle(g, s, rnd, { colors: ['#4a5850', '#323c38', '#56625a', '#3a4440'], count: 34, rmin: 18, rmax: 70, alpha: 0.42, hard: 0.1 });
  // worn to bare iron toward the edges
  g.save(); g.fillStyle = radial(g, s / 2, s / 2, s * 0.32, s * 0.72, [[0, '#5c5a58', 0], [1, '#5c5a58', 0.55]]); g.fillRect(0, 0, s, s); g.restore();
  // rust blooms, heavier low down
  for (let i = 0; i < 26; i++) {
    const x = rnd() * s, y = Math.pow(rnd(), 0.6) * s, r = range(rnd, 3, 13);
    blob(g, x, y, r * 1.6, r * 1.2, rnd() * 3, '#5a3a28', 0.25, 0.2);
    blob(g, x, y, r, r * 0.8, rnd() * 3, pick(rnd, ['#8c5636', '#7a4630', '#9a6038']), 0.5, 0.35);
  }
  streaks(g, s, rnd, { colors: ['#8a948e', '#a4aca6'], count: 22, len: [5, 18], width: [0.6, 1.1], angle: 1.1, wobble: 0.6, alpha: 0.35 });
  // the raised border band with rivets
  const b = 15;
  g.save(); g.lineWidth = 12; g.strokeStyle = rgba('#4a5650', 0.9); g.strokeRect(b, b, s - 2 * b, s - 2 * b); g.restore();
  line(g, [[b - 6, s - b - 6], [b - 6, b - 6], [s - b - 6, b - 6]], 2, '#8a968e', 0.6);
  line(g, [[b + 6, s - b + 6], [s - b + 6, s - b + 6], [s - b + 6, b + 6]], 2.2, '#1a201e', 0.55);
  line(g, [[b + 6, s - b - 6], [b + 6, b + 6], [s - b - 6, b + 6]], 1.6, '#1a201e', 0.45);
  const n = 9;
  for (let k = 0; k < n; k++) {
    const t = b + (s - 2 * b) * k / (n - 1);
    for (const [x, y] of [[t, b], [t, s - b], [b, t], [s - b, t]]) {
      rivet(g, x, y, 3.6, '#6a726c');
      if (rnd() < 0.4) line(g, [[x, y + 4], [x + (rnd() - 0.5) * 3, y + range(rnd, 10, 28)]], range(rnd, 1.5, 3), '#7a4630', 0.35);
    }
  }
  // gold pinstripe inside the band
  g.save(); g.strokeStyle = rgba('#c8a050', 0.75); g.lineWidth = 1.6; g.strokeRect(b + 13, b + 13, s - 2 * b - 26, s - 2 * b - 26);
  g.strokeStyle = rgba('#c8a050', 0.4); g.lineWidth = 1; g.strokeRect(b + 17, b + 17, s - 2 * b - 34, s - 2 * b - 34); g.restore();
  if (!door) chips(g, rnd, 10, 30, 30, s - 60, s - 60, '#6a6a68', 1.5, 4, 0.5);
  blob(g, s * 0.3, s * 0.28, s * 0.35, s * 0.25, -0.5, '#fff1c4', 0.08, 0.1);
  bevel(g, 0, 0, s, s, base, 10, 0.4, 0.55);
}
register('loot_iron', {
  family: F, size: 256, note: "the Rusty Safe's body: green-black lacquered iron, rivet border, gold pinstripe, rust",
  paint(g, s, rnd, h, cv) { ironPlate(g, s, rnd); glaze(g, s, s, '#ffe8c0', 0.08); blurTile(cv, 0.4); },
});
register('loot_safe', {
  family: F, size: 256, note: 'the safe door: pinstripes, corner scrolls, a gilded maker\'s mark, the dial\'s number ring',
  paint(g, s, rnd, h, cv) {
    ironPlate(g, s, rnd, { base: '#34403a', door: true });
    // corner scrolls
    for (const [x, y, sx, sy] of [[44, 44, 1, 1], [s - 44, 44, -1, 1], [44, s - 44, 1, -1], [s - 44, s - 44, -1, -1]]) {
      const pts = []; for (let k = 0; k <= 14; k++) { const a = k / 14 * TAU * 0.85, r = 3 + k * 0.9; pts.push([x + sx * Math.cos(a) * r, y + sy * Math.sin(a) * r]); }
      line(g, pts, 2.2, '#2a1a10', 0.5); line(g, pts.map(([u, v]) => [u - 0.7, v - 0.7]), 1.6, '#d8b060', 0.85);
    }
    // the maker's cartouche
    rrect(g, 64, 34, 128, 30, 8, '#2a2a22', 0.55);
    g.save(); g.strokeStyle = rgba('#c8a050', 0.8); g.lineWidth = 1.5; g.beginPath(); g.roundRect(64, 34, 128, 30, 8); g.stroke(); g.restore();
    letters(g, 'GOBLIN & SONS', 128, 46, 13, { rnd, jit: 0.02, shadow: 0.3, maxW: 116 });
    letters(g, 'VAULT CO.', 128, 58, 8, { rnd, jit: 0.02, shadow: 0, maxW: 60 });
    // the dial's number ring (the dial itself is brass geometry at the center)
    const cx = s / 2, cy = s / 2;
    ellipse(g, cx, cy, 58, 58, 0, '#1e2420', 0.45);
    ellipse(g, cx, cy, 54, 54, 0, '#2c3430', 0.9);
    for (let k = 0; k < 40; k++) {
      const a = k / 40 * TAU, r0 = k % 5 ? 48 : 44;
      line(g, [[cx + Math.cos(a) * r0, cy + Math.sin(a) * r0], [cx + Math.cos(a) * 53, cy + Math.sin(a) * 53]], k % 5 ? 1 : 1.8, '#d8b060', 0.85);
    }
    g.save(); g.strokeStyle = rgba('#d8b060', 0.7); g.lineWidth = 1.2; g.beginPath(); g.arc(cx, cy, 55, 0, TAU); g.stroke(); g.restore();
    blob(g, cx - 18, cy - 22, 30, 16, -0.6, '#fff1c4', 0.08, 0.2);
    glaze(g, s, s, '#ffe8c0', 0.08); blurTile(cv, 0.4);
  },
});

register('loot_leather', {
  family: F, size: 256, note: 'trunk leather: oxblood-brown hide, creases, scuffs, a stitched welt round the border',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7a4428');
    mottle(g, s, rnd, { colors: ['#8a5230', '#683a20', '#965e38', '#5e321c'], count: 44, rmin: 14, rmax: 60, alpha: 0.38, hard: 0.12 });
    // creases: a dark fold with a lit lip just above it
    for (let i = 0; i < 46; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 8, 30), a = rnd() * TAU, bend = range(rnd, -0.5, 0.5);
      const pts = []; for (let k = 0; k <= 5; k++) { const t = k / 5; pts.push([x + Math.cos(a + bend * t) * L * t, y + Math.sin(a + bend * t) * L * t]); }
      stroke(g, pts.map(([u, v]) => [u - 0.8, v - 1]), range(rnd, 1, 2), 0.4, '#b07a50', 0.22);
      stroke(g, pts, range(rnd, 1, 2.2), 0.4, '#3e2214', 0.32);
    }
    for (let i = 0; i < 14; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 6, 20), range(rnd, 3, 8), rnd() * 3, '#b48a64', 0.2, 0.3);   // scuffs
    // the welt: a darker turned edge, a groove, stitches
    g.save(); g.lineWidth = 7; g.strokeStyle = rgba('#4a2614', 0.55); g.strokeRect(3.5, 3.5, s - 7, s - 7); g.restore();
    g.save(); g.lineWidth = 1.6; g.strokeStyle = rgba('#3a1e10', 0.7); g.strokeRect(14, 14, s - 28, s - 28); g.restore();
    g.save(); g.lineWidth = 1; g.strokeStyle = rgba('#c09068', 0.4); g.strokeRect(15.5, 15.5, s - 28, s - 28); g.restore();
    stitches(g, [[10, 10], [s - 10, 10], [s - 10, s - 10], [10, s - 10], [10, 10]], 7, 4.5, '#d8c49a');
    vignette(g, 0, 0, s, s, '#2a1610', 0.4);
    bevel(g, 0, 0, s, s, '#7a4428', 10, 0.35, 0.5);
    glaze(g, s, s, '#ffd8a8', 0.1);
    blurTile(cv, 0.4);
  },
});

register('loot_strap', {
  family: F, w: 256, h: 24, note: 'a dark leather strap (along u) with stitched edges',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#4e2c18');
    for (let i = 0; i < 20; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 8, 24), range(rnd, 3, 6), 0, pick(rnd, ['#5e3620', '#3e2212', '#6a4028']), 0.4, 0.2);
    rect(g, 0, 0, w, 3, '#8a5a38', 0.6); rect(g, 0, h - 3, w, 3, '#1e1008', 0.5);
    stitches(g, [[0, 6], [w, 6]], 6, 3.6, '#c8b088', '#1a0e08', 0.85);
    stitches(g, [[0, h - 6], [w, h - 6]], 6, 3.6, '#c8b088', '#1a0e08', 0.85);
    blurTile(cv, 0.3);
  },
});

register('loot_fret', {
  family: F, w: 256, h: 24, note: 'rosewood fretboard along u: brass frets, ivory dots, four strings',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#3a2216');
    grain(g, 0, 0, w, h, rnd, { dark: ['#24140c'], lite: ['#5a3420'], n: 12, amp: 1, knots: 0 });
    for (let n = 1; n <= 14; n++) {
      const x = w * (1 - Math.pow(2, -n / 12)) * 1.6;
      if (x > w - 2) break;
      line(g, [[x + 0.8, 0], [x + 0.8, h]], 1.2, '#1a0e08', 0.6); line(g, [[x, 0], [x, h]], 1.4, '#e0c070', 0.9);
      if ([3, 5, 7, 9].includes(n)) { const xm = w * (1 - Math.pow(2, -(n - 0.5) / 12)) * 1.6; ellipse(g, xm, h / 2, 2.2, 2.2, 0, '#f0e6cc'); }
      if (n === 12) { const xm = w * (1 - Math.pow(2, -11.5 / 12)) * 1.6; ellipse(g, xm, h * 0.3, 2, 2, 0, '#f0e6cc'); ellipse(g, xm, h * 0.7, 2, 2, 0, '#f0e6cc'); }
    }
    for (let k = 0; k < 4; k++) { const y = 4 + k * (h - 8) / 3; line(g, [[0, y + 0.8], [w, y + 0.8]], 0.9, '#120a06', 0.6); line(g, [[0, y], [w, y]], 0.9, '#e8e2d4', 0.85); }
    rect(g, 0, 0, w, 1.5, '#7a5034', 0.6);
    blurTile(cv, 0.25);
  },
});

// ---- metals --------------------------------------------------------------------------------------------

register('loot_brass', {
  family: F, w: 256, h: 128, note: 'polished brass (v up): a bright reflected band high, a dark band low, brushing, patina, dings',
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#8a6628'], [0.12, '#e0c068'], [0.24, '#f8e49a'], [0.34, '#c8a050'], [0.56, '#8a6628'], [0.72, '#6a4c1e'], [0.86, '#b08a40'], [1, '#7a5a24']]);
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 22; i++) { const x = rnd() * w, y = rnd() * h, r = range(rnd, 10, 40); wrapX(w, x, r * 3, X => blob(g, X, y, r * 3, r * 0.6, 0, pick(rnd, ['#c8a050', '#8a6a2c', '#e0c070']), 0.25, 0.1)); }
    for (let i = 0; i < 80; i++) { const x = rnd() * w, y = rnd() * h, L = range(rnd, 20, 90); wrapX(w, x, L, X => line(g, [[X - L / 2, y], [X + L / 2, y + (rnd() - 0.5)]], range(rnd, 0.6, 1.3), rnd() < 0.5 ? '#f4dc90' : '#6a4e1e', 0.22)); }
    for (let i = 0; i < 10; i++) { const x = rnd() * w, y = h * range(rnd, 0.55, 1); wrapX(w, x, 10, X => blob(g, X, y, range(rnd, 2, 7), range(rnd, 2, 5), 0, pick(rnd, ['#5a8a6a', '#6a9a78']), 0.32, 0.3)); }
    for (let i = 0; i < 7; i++) { const x = rnd() * w, y = h * range(rnd, 0.18, 0.3); wrapX(w, x, 30, X => blob(g, X, y, range(rnd, 10, 26), range(rnd, 2, 4), 0, '#fff6cc', 0.45, 0.3)); }
    for (let i = 0; i < 6; i++) { const x = rnd() * w, y = rnd() * h; wrapX(w, x, 6, X => { blob(g, X + 1, y + 1, 4, 2.5, 0, '#4a3410', 0.3, 0.3); blob(g, X - 1, y - 1, 3, 2, 0, '#fff0b8', 0.3, 0.3); }); }
    blurTile(cv, 0.4);
  },
});

register('loot_gold', {
  family: F, w: 256, h: 64, note: 'gilded frame molding (u along the bar, top = outer edge): beads, a cove, acanthus scrolls, an inner lip',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#b88a30');
    // outer lip
    g.fillStyle = lin(g, 0, 0, 0, 8, [[0, '#7a5418'], [0.3, '#f4d47a'], [1, '#c8962e']]); g.fillRect(0, 0, w, 8);
    // beads
    rect(g, 0, 8, w, 9, '#6a4614');
    for (let x = 4; x < w; x += 8) { blob(g, x + 1.2, 13.5, 4.2, 3.6, 0, '#2a1a08', 0.5, 0.3); ellipse(g, x, 12.5, 3.4, 3.4, 0, '#c8962e'); blob(g, x - 1.1, 11.3, 1.8, 1.6, 0, '#fff0b8', 0.9, 0.4); }
    // the cove
    g.fillStyle = lin(g, 0, 17, 0, 26, [[0, '#4a3010'], [0.5, '#8a6420'], [1, '#d8aa48']]); g.fillRect(0, 17, w, 9);
    // the ornament band: acanthus C-scrolls repeating every 32 px
    rect(g, 0, 26, w, 26, '#7a5818');
    for (let x0 = 0; x0 < w; x0 += 32) {
      const sc = (dx, flip) => {
        const pts = []; for (let k = 0; k <= 12; k++) { const t = k / 12, a = t * TAU * 0.7 + (flip ? Math.PI : 0); const r = 9 - t * 6; pts.push([x0 + dx + Math.cos(a) * r * (flip ? -1 : 1), 39 + Math.sin(a) * r * 0.8]); }
        return pts;
      };
      for (const [dx, fl] of [[10, false], [22, true]]) {
        const p = sc(dx, fl);
        line(g, p.map(([u, v]) => [u + 1.2, v + 1.4]), 4.5, '#2e1c08', 0.6);
        line(g, p, 4, '#c8962e', 1);
        line(g, p.map(([u, v]) => [u - 0.8, v - 0.9]), 1.6, '#fff0b8', 0.85);
      }
      // a leaf between the scrolls
      blob(g, x0 + 16 + 1, 31 + 1, 3, 5, 0, '#2e1c08', 0.5, 0.3); ellipse(g, x0 + 16, 31, 2.6, 4.4, 0, '#d8a840'); blob(g, x0 + 15.2, 29.5, 1.2, 2, 0, '#fff0b8', 0.8, 0.4);
      blob(g, x0 + 16, 47, 2.4, 2.4, 0, '#e8c060', 0.9, 0.5);
    }
    // step & inner lip, falling away toward the picture
    g.fillStyle = lin(g, 0, 52, 0, h, [[0, '#f0cc70'], [0.25, '#b88a30'], [0.7, '#7a5418'], [1, '#4a3010']]); g.fillRect(0, 52, w, h - 52);
    line(g, [[0, 52.5], [w, 52.5]], 1, '#fff0b8', 0.7);
    // grime in the recesses, worn gilt showing red bole
    for (let i = 0; i < 18; i++) { const x = rnd() * w; wrapX(w, x, 8, X => blob(g, X, range(rnd, 26, 50), range(rnd, 3, 8), range(rnd, 2, 4), 0, '#3a2410', 0.25, 0.3)); }
    for (let i = 0; i < 8; i++) { const x = rnd() * w; wrapX(w, x, 4, X => blob(g, X, range(rnd, 2, 7), range(rnd, 2, 4), 1.2, 0, '#8a3a22', 0.5, 0.5)); }
    blurTile(cv, 0.3);
  },
});

register('loot_steel', {
  family: F, size: 128, note: 'the toaster\'s polished chrome (v up): bright sky on top, a dark horizon, the warm floor below, window glints',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#f6f9fb'], [0.14, '#e4ecf0'], [0.3, '#bcc8d2'], [0.43, '#86929e'], [0.5, '#424a54'], [0.56, '#5c6066'], [0.68, '#a08a72'], [0.84, '#d0bc9a'], [1, '#7a6c5e']]);
    g.fillRect(0, 0, s, s);
    // soft reflected windows and the odd smudge
    for (const [x, w] of [[0.18, 0.1], [0.32, 0.05], [0.7, 0.08]]) { g.save(); g.globalAlpha = 0.35; g.fillStyle = lin(g, 0, s * 0.16, 0, s * 0.46, [[0, '#ffffff'], [1, '#ffffff', 0]]); g.fillRect(x * s, s * 0.16, w * s, s * 0.3); g.restore(); }
    for (let i = 0; i < 6; i++) blob(g, rnd() * s, range(rnd, 0.2, 0.9) * s, range(rnd, 6, 14), range(rnd, 4, 9), rnd() * 3, '#8a8478', 0.14, 0.2);
    blob(g, s * 0.5, s * 0.7, s * 0.4, s * 0.05, 0, '#ffe8c0', 0.3, 0.3);
    line(g, [[0, s * 0.5], [s, s * 0.5]], 1.5, '#262c34', 0.5);
    for (let x = 10; x < s; x += 18) rivet(g, x, s - 9, 2.6, '#b8a070');
    bevel(g, 0, 0, s, s, '#9aa6b0', 8, 0.35, 0.45);
    blurTile(cv, 0.5);
  },
});

register('loot_red', {
  family: F, size: 128, note: 'the slot machine\'s red-lacquered goblin steel: rivet border, chips to dark iron, rust runs',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8a2e24');
    mottle(g, s, rnd, { colors: ['#9a3a2c', '#7a2620', '#a8443a', '#842c26'], count: 26, rmin: 10, rmax: 40, alpha: 0.4, hard: 0.1 });
    chips(g, rnd, 14, 6, 6, s - 12, s - 12, '#4a3a36', 1, 3.2, 0.8);
    streaks(g, s, rnd, { colors: ['#5a2a1a'], count: 8, len: [10, 30], width: [1.2, 2.5], angle: Math.PI, wobble: 0.1, alpha: 0.25 });
    line(g, [[8, s - 8], [8, 8], [s - 8, 8]], 1.6, '#d87060', 0.5);
    line(g, [[8, s - 8], [s - 8, s - 8], [s - 8, 8]], 1.6, '#3a1410', 0.5);
    for (let k = 0; k < 6; k++) { const t = 8 + (s - 16) * k / 5; for (const [x, y] of [[t, 8], [t, s - 8], [8, t], [s - 8, t]]) rivet(g, x, y, 2.6, '#c8a050'); }
    blob(g, s * 0.32, s * 0.3, s * 0.35, s * 0.22, -0.5, '#ffd8b0', 0.1, 0.1);
    bevel(g, 0, 0, s, s, '#8a2e24', 7, 0.35, 0.5);
    glaze(g, s, s, '#ffd8b0', 0.08);
    blurTile(cv, 0.4);
  },
});

// ---- porcelain ---------------------------------------------------------------------------------------

register('loot_porcelain', {
  family: F, size: 256, note: 'blue-and-white porcelain (u wraps; v follows the vase profile): lotus panels, peony scroll, cloud collar, banana leaves',
  paint(g, s, rnd, h, cv) {
    const Y = y => (1 - vaseT(y)) * s;       // world height on the vase → canvas row
    const B1 = '#21408a', B2 = '#3558a8', BW = '#7d94cc', BD = '#172e66';
    fill(g, s, s, '#eef0ea');
    mottle(g, s, rnd, { colors: ['#f8f8f2', '#e2e6e4', '#ece8dc', '#e6ecf0'], count: 30, rmin: 30, rmax: 90, alpha: 0.4, hard: 0.1 });
    const band = (y, w = 2.2, c = B1) => line(g, [[-2, y], [s + 2, y]], w, c, 0.92);
    // unglazed foot ring
    const yFoot = Y(-0.352);
    rect(g, 0, yFoot, s, s - yFoot, '#cdb48e');
    for (let i = 0; i < 8; i++) { const x = rnd() * s; wrapX(s, x, 12, X => blob(g, X, range(rnd, yFoot, s), range(rnd, 4, 12), 3, 0, '#a88e6a', 0.3, 0.3)); }
    band(yFoot - 1, 3, B1);
    // lotus panels
    const l0 = Y(-0.33), l1 = Y(-0.2);
    band(l0, 2.2); band(l0 - 4, 1.2);
    const nP = 10, PW = s / nP;
    for (let i = 0; i < nP; i++) {
      const cx = (i + 0.5) * PW;
      const petal = (X) => { g.beginPath(); g.moveTo(X - PW * 0.42, l0 - 5); g.quadraticCurveTo(X - PW * 0.48, l1 + 10, X, l1 + 2); g.quadraticCurveTo(X + PW * 0.48, l1 + 10, X + PW * 0.42, l0 - 5); };
      wrapX(s, cx, PW, X => {
        petal(X); g.save(); g.fillStyle = rgba(BW, 0.45); g.fill(); g.lineWidth = 2; g.strokeStyle = rgba(B1, 0.9); g.stroke(); g.restore();
        line(g, [[X, l0 - 7], [X, l1 + 9]], 1.2, B2, 0.7);
        blob(g, X, l1 + 9, 3, 3, 0, B1, 0.8, 0.5);
      });
    }
    band(l1, 2.2); band(l1 + 4, 1.1);
    // the main field: a peony scroll
    const m0 = Y(-0.17), m1 = Y(0.1);
    const vine = x => (m0 + m1) / 2 + Math.sin(x / s * TAU * 2 + 0.6) * (m0 - m1) * 0.28;
    const vp = []; for (let x = -10; x <= s + 10; x += 4) vp.push([x, vine(x)]);
    line(g, vp, 4, B1, 0.85); line(g, vp.map(([x, y]) => [x, y + Math.sin(x / 9) * 3]), 1.4, B2, 0.6); line(g, vp.map(([x, y]) => [x, y + 1]), 1, BD, 0.5);
    for (let i = 0; i < 34; i++) {
      const x = rnd() * s, y = vine(x), a = (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.5, 1.4), L = range(rnd, 12, 20);
      wrapX(s, x, 20, X => {
        g.save(); g.translate(X, y); g.rotate(a); g.fillStyle = rgba(B2, 0.85); g.beginPath(); g.ellipse(L / 2, 0, L / 2, L * 0.22, 0, 0, TAU); g.fill();
        g.strokeStyle = rgba(BD, 0.8); g.lineWidth = 0.8; g.beginPath(); g.moveTo(0, 0); g.lineTo(L, 0); g.stroke(); g.restore();
      });
    }
    for (let i = 0; i < 4; i++) {
      const x = (i + 0.3 + rnd() * 0.3) * s / 4, y = vine(x) + (i % 2 ? -12 : 12), R = range(rnd, 24, 28);
      wrapX(s, x, R * 1.4, X => {
        blob(g, X, y, R * 1.3, R * 1.1, 0, BW, 0.35, 0.3);
        for (let k = 0; k < 9; k++) {
          const a = k / 9 * TAU + rnd() * 0.3, rr = R * range(rnd, 0.62, 0.8);
          g.save(); g.translate(X + Math.cos(a) * rr * 0.5, y + Math.sin(a) * rr * 0.4); g.rotate(a);
          g.fillStyle = rgba(k % 2 ? B2 : B1, 0.85); g.beginPath(); g.ellipse(0, 0, rr * 0.55, rr * 0.36, 0, 0, TAU); g.fill();
          g.strokeStyle = rgba('#eef0ea', 0.6); g.lineWidth = 1; g.beginPath(); g.ellipse(0, 0, rr * 0.4, rr * 0.22, 0, 0, TAU); g.stroke();
          g.restore();
        }
        ellipse(g, X, y, R * 0.28, R * 0.24, 0, BD, 0.95);
        for (let k = 0; k < 5; k++) ellipse(g, X + (rnd() - 0.5) * R * 0.3, y + (rnd() - 0.5) * R * 0.25, 1.2, 1.2, 0, '#eef0ea', 0.8);
      });
    }
    // shoulder: cloud-collar lappets hanging down
    const c0 = Y(0.13), c1 = Y(0.21);
    band(c0, 2.2); band(c1, 2.2); band(c1 - 4, 1.1);
    const nL = 8, LW = s / nL;
    for (let i = 0; i < nL; i++) {
      wrapX(s, (i + 0.5) * LW, LW, X => {
        g.beginPath(); g.moveTo(X - LW * 0.46, c1 + 1); g.bezierCurveTo(X - LW * 0.5, c0 - 2, X - LW * 0.12, c0 - 8, X, c0 - 2);
        g.bezierCurveTo(X + LW * 0.12, c0 - 8, X + LW * 0.5, c0 - 2, X + LW * 0.46, c1 + 1);
        g.save(); g.fillStyle = rgba(BW, 0.5); g.fill(); g.lineWidth = 1.8; g.strokeStyle = rgba(B1, 0.9); g.stroke(); g.restore();
        const sp = []; for (let k = 0; k <= 10; k++) { const a = k / 10 * TAU * 0.8; sp.push([X + Math.cos(a) * (2 + k * 0.5), (c0 + c1) / 2 + Math.sin(a) * (2 + k * 0.4)]); }
        line(g, sp, 1.4, B1, 0.85);
      });
    }
    // neck: banana leaves
    const n0 = Y(0.235), n1 = Y(0.33);
    const nB = 12, BWd = s / nB;
    for (let i = 0; i < nB; i++) {
      wrapX(s, (i + 0.5) * BWd, BWd, X => {
        g.beginPath(); g.moveTo(X - BWd * 0.42, n0); g.quadraticCurveTo(X - BWd * 0.2, (n0 + n1) / 2, X, n1 + 2); g.quadraticCurveTo(X + BWd * 0.2, (n0 + n1) / 2, X + BWd * 0.42, n0);
        g.save(); g.fillStyle = rgba(BW, 0.4); g.fill(); g.lineWidth = 1.5; g.strokeStyle = rgba(B1, 0.9); g.stroke(); g.restore();
        line(g, [[X, n0], [X, n1 + 4]], 1.1, B1, 0.8);
        for (let k = 1; k < 4; k++) { const y = n0 - (n0 - n1) * k / 4.5; line(g, [[X, y], [X - BWd * 0.22, y + 4]], 0.7, B2, 0.7); line(g, [[X, y], [X + BWd * 0.22, y + 4]], 0.7, B2, 0.7); }
      });
    }
    band(n0 + 1, 2.2);
    // lip: a solid blue band with a white wave
    const p0 = Y(0.345);
    rect(g, 0, 0, s, p0, B1, 0.92);
    const wv = []; for (let x = -4; x <= s + 4; x += 3) wv.push([x, p0 * 0.5 + Math.sin(x / s * TAU * 9) * p0 * 0.18]);
    line(g, wv, 1.6, '#e8ecf0', 0.85);
    // soft wash variation and the faintest crackle in the glaze
    mottle(g, s, rnd, { colors: [BW], count: 14, rmin: 10, rmax: 30, alpha: 0.08, hard: 0.2 });
    cracks(g, s, rnd, { color: '#8a9498', count: 10, len: [16, 50], width: [0.5, 0.9], alpha: 0.12 });
    blurTile(cv, 0.6);
  },
});

// ---- the shop sign (the old "neon OPEN sign") -----------------------------------------------------------

register('loot_sign', {
  family: F, w: 512, h: 256, note: 'a painted wooden shop sign: plank board, carved border, gold-leaf OPEN, lantern light pooling at the top corners',
  paint(g, w, rnd, h, cv) {
    // planks
    rect(g, 0, 0, w, h, '#2a1a14');
    const rows = [0, 88, 172, 256];
    for (let i = 0; i < 3; i++) {
      const y0 = rows[i] + 2, y1 = rows[i + 1] - 2, c = jitter('#6a4428', rnd, 0.06);
      rect(g, 0, y0, w, y1 - y0, c);
      grain(g, 0, y0, w, y1 - y0, rnd, { dark: ['#3e2616', '#4a2e1a'], lite: ['#8a6040', '#94684a'], n: 16, amp: 2, knots: 1 });
      bevel(g, 0, y0, w, y1 - y0, c, 6, 0.4, 0.5);
    }
    // carved, raised border
    const B = 22;
    g.save(); g.lineWidth = 18; g.strokeStyle = rgba('#7a5232', 0.95); g.strokeRect(B / 2 + 2, B / 2 + 2, w - B - 4, h - B - 4); g.restore();
    line(g, [[4, h - 4], [4, 4], [w - 4, 4]], 3, '#c09060', 0.55);
    line(g, [[B + 1, h - B - 1], [w - B - 1, h - B - 1], [w - B - 1, B + 1]], 3, '#c09060', 0.4);
    line(g, [[4, h - 4], [w - 4, h - 4], [w - 4, 4]], 3, '#1a1008', 0.6);
    line(g, [[B + 1, h - B - 1], [B + 1, B + 1], [w - B - 1, B + 1]], 3, '#1a1008', 0.55);
    for (const [x, y] of [[13, 13], [w - 13, 13], [13, h - 13], [w - 13, h - 13]]) rivet(g, x, y, 4, '#8a8a84');
    // the painted field: deep green, worn to the wood in places
    const fx = B + 4, fy = B + 4, fw = w - 2 * fx, fh = h - 2 * fy;
    g.save(); g.beginPath(); g.rect(fx, fy, fw, fh); g.clip();
    g.globalAlpha = 0.88; g.fillStyle = lin(g, 0, fy, 0, fy + fh, [[0, '#2e5a3e'], [1, '#22462e']]); g.fillRect(fx, fy, fw, fh); g.globalAlpha = 1;
    mottle(g, w, rnd, { colors: ['#3a6a48', '#1e3e28', '#2a5236'], count: 20, rmin: 20, rmax: 60, alpha: 0.3, hard: 0.1 });
    for (let i = 0; i < 26; i++) blob(g, fx + rnd() * fw, fy + rnd() * fh, range(rnd, 3, 12), range(rnd, 2, 5), 0, '#6a4428', 0.7, 0.6);   // worn to the wood
    // a thin gold pinstripe with corner curls
    g.strokeStyle = rgba('#d8b060', 0.8); g.lineWidth = 2; g.strokeRect(fx + 10, fy + 10, fw - 20, fh - 20);
    g.restore();
    for (const [x, y, sx, sy] of [[fx + 10, fy + 10, 1, 1], [fx + fw - 10, fy + 10, -1, 1], [fx + 10, fy + fh - 10, 1, -1], [fx + fw - 10, fy + fh - 10, -1, -1]]) {
      const pts = []; for (let k = 0; k <= 12; k++) { const a = k / 12 * TAU * 0.8, r = 2 + k * 0.8; pts.push([x + sx * (8 + Math.cos(a) * r), y + sy * (8 + Math.sin(a) * r)]); }
      line(g, pts, 2, '#d8b060', 0.85);
    }
    // OPEN in gold leaf, hand lettered
    letters(g, 'OPEN', w / 2, h * 0.47, 128, { rnd, jit: 0.05, track: 10, maxW: fw - 70 });
    // small flourishes and the line under it
    for (const sx of [-1, 1]) {
      const x = w / 2 + sx * 196, y = h * 0.47;
      ellipse(g, x, y, 7, 7, Math.PI / 4, '#2a1a10', 0.5); ellipse(g, x - 1, y - 1, 6, 6, Math.PI / 4, '#e0b858');
      blob(g, x - 2.5, y - 2.5, 2.5, 2, 0, '#fff4c8', 0.9, 0.4);
    }
    letters(g, '~ COME IN ~', w / 2, h * 0.79, 22, { rnd, jit: 0.03, fill: ['#f4e6c0', '#d8c08a'], rim: '#1a1008', lit: '#fffbe8', shadow: 0.35, track: 3 });
    // lantern light pooling from the top corners, grime at the bottom
    for (const x of [0, w]) { g.save(); g.globalCompositeOperation = 'soft-light'; g.fillStyle = radial(g, x, 0, 0, 200, [[0, '#ffd890', 0.85], [1, '#ffd890', 0]]); g.fillRect(0, 0, w, h); g.restore(); }
    g.fillStyle = lin(g, 0, h * 0.7, 0, h, [[0, INK, 0], [1, INK, 0.35]]); g.fillRect(0, 0, w, h);
    glaze(g, w, h, '#ffe0b0', 0.1);
    blurTile(cv, 0.45);
  },
});

register('loot_lantern', {
  family: F, size: 64, note: 'amber lantern glass: four panes in iron mullions, a flame glowing behind',
  paint(g, s, rnd, h, cv) {
    rect(g, 0, 0, s, s, '#3a2a20');
    g.fillStyle = radial(g, s / 2, s * 0.58, 2, s * 0.6, [[0, '#fff4c0'], [0.35, '#ffc860'], [0.75, '#d87a28'], [1, '#8a4418']]); g.fillRect(4, 4, s - 8, s - 8);
    ellipse(g, s / 2, s * 0.6, 5, 9, 0, '#fffbe0', 0.9);
    line(g, [[s / 2, 2], [s / 2, s - 2]], 4, '#2a2024', 0.95); line(g, [[2, s / 2], [s - 2, s / 2]], 4, '#2a2024', 0.95);
    g.save(); g.lineWidth = 5; g.strokeStyle = '#2a2024'; g.strokeRect(2.5, 2.5, s - 5, s - 5); g.restore();
    line(g, [[8, 10], [16, 8]], 2, '#fffbe8', 0.6);
    blurTile(cv, 0.4);
  },
});

// ---- the goblin one-armed bandit ------------------------------------------------------------------------

register('loot_slot', {
  family: F, w: 256, h: 512, note: 'goblin slot machine front: JACKPOT marquee (top 100 px = the crown), reels, pay table, emblem, coin tray',
  paint(g, w, rnd, h, cv) {
    // ---- the crown / marquee (y 0..100)
    g.fillStyle = lin(g, 0, 0, 0, 100, [[0, '#a8342a'], [1, '#6a1e1a']]); g.fillRect(0, 0, w, 100);
    for (let k = 0; k < 16; k++) {     // sunburst
      const a0 = Math.PI + k / 16 * Math.PI, a1 = a0 + Math.PI / 32;
      g.save(); g.globalAlpha = 0.25; g.fillStyle = '#d8604a'; g.beginPath(); g.moveTo(w / 2, 96); g.arc(w / 2, 96, 160, a0, a1); g.closePath(); g.fill(); g.restore();
    }
    g.save(); g.strokeStyle = rgba('#e8c060', 0.95); g.lineWidth = 5; g.strokeRect(5, 5, w - 10, 90); g.restore();
    for (let x = 14; x < w - 6; x += 19) for (const y of [11, 89]) { ellipse(g, x, y, 4.5, 4.5, 0, '#5a2a10'); ellipse(g, x, y, 3.4, 3.4, 0, '#ffe8a0'); blob(g, x - 1, y - 1, 1.6, 1.4, 0, '#fffbe8', 1, 0.5); }
    letters(g, 'JACKPOT', w / 2, 52, 44, { rnd, jit: 0.04, track: 1, maxW: w - 40 });
    // ---- the cabinet front (y 100..512)
    g.fillStyle = lin(g, 0, 100, 0, h, [[0, '#962e24'], [1, '#6e2018']]); g.fillRect(0, 100, w, h - 100);
    for (let i = 0; i < 18; i++) blob(g, rnd() * w, range(rnd, 110, h), range(rnd, 10, 40), range(rnd, 10, 30), 0, pick(rnd, ['#a83a2e', '#7a2620']), 0.3, 0.1);
    chips(g, rnd, 16, 6, 340, w - 12, 160, '#4a3a36', 1, 3, 0.8);
    rect(g, 0, 100, w, 16, '#c8a050'); line(g, [[0, 101], [w, 101]], 2, '#fff0b8', 0.7); line(g, [[0, 115], [w, 115]], 2, '#5a3a14', 0.8);
    // reel window
    const rx = 26, ry = 132, rw = w - 52, rh = 128;
    rrect(g, rx - 12, ry - 12, rw + 24, rh + 24, 14, '#5a3a14');
    rrect(g, rx - 9, ry - 9, rw + 18, rh + 18, 12, '#d8b060');
    g.save(); g.strokeStyle = rgba('#fff0b8', 0.8); g.lineWidth = 2; g.beginPath(); g.roundRect(rx - 8, ry - 8, rw + 16, rh + 16, 11); g.stroke(); g.restore();
    rrect(g, rx - 2, ry - 2, rw + 4, rh + 4, 6, '#1e1418');
    const RW = (rw - 8) / 3;
    const sym = (k, x, y, sz) => {
      if (k === 0) {          // 7
        g.save(); g.font = `bold ${sz}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillStyle = '#4a1010'; g.fillText('7', x + 2, y + 3); g.fillStyle = '#c8302a'; g.fillText('7', x, y); g.fillStyle = rgba('#ff9a80', 0.6); g.fillText('7', x - 1, y - 1.5); g.fillStyle = '#c8302a'; g.fillText('7', x, y); g.restore();
      } else if (k === 1) {   // cherries
        line(g, [[x - 8, y + 4], [x + 2, y - 14], [x + 9, y + 3]], 2.2, '#3a6a28', 1);
        for (const dx of [-8, 9]) { ellipse(g, x + dx + 1, y + 7, 8, 8, 0, '#4a0e10'); ellipse(g, x + dx, y + 6, 7.5, 7.5, 0, '#c02a2a'); blob(g, x + dx - 2.5, y + 3.5, 2.5, 2, 0, '#ffd0c0', 0.9, 0.4); }
        ellipse(g, x + 6, y - 12, 6, 2.8, -0.5, '#4a8a34');
      } else if (k === 2) {   // a gold coin
        ellipse(g, x + 1.5, y + 2, 15, 15, 0, '#5a3a10'); ellipse(g, x, y, 15, 15, 0, '#d8a440'); ellipse(g, x, y, 11, 11, 0, '#f0c860');
        g.save(); g.font = `bold 16px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#8a5a18'; g.fillText('G', x, y + 1); g.restore();
        blob(g, x - 5, y - 6, 4, 3, 0, '#fff4c8', 0.9, 0.4);
      } else {                // BAR
        rrect(g, x - 18, y - 9, 36, 18, 3, '#2a2030'); rrect(g, x - 16, y - 7, 32, 14, 2, '#f0e6cc');
        g.save(); g.font = `bold 11px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#2a2030'; g.fillText('BAR', x, y + 1); g.restore();
      }
    };
    const rows = [[3, 1, 2], [0, 0, 1], [2, 3, 0]];    // two sevens and a cherry: so close
    for (let c = 0; c < 3; c++) {
      const x0 = rx + 2 + c * (RW + 2);
      g.save(); g.beginPath(); g.rect(x0, ry, RW, rh); g.clip();
      g.fillStyle = lin(g, 0, ry, 0, ry + rh, [[0, '#6a5a4a'], [0.18, '#d8ccb0'], [0.5, '#f8f0dc'], [0.82, '#d8ccb0'], [1, '#6a5a4a']]); g.fillRect(x0, ry, RW, rh);
      for (let r = 0; r < 3; r++) sym(rows[r][c], x0 + RW / 2, ry + rh / 2 + (r - 1) * 46, r === 1 ? 46 : 36);
      g.fillStyle = lin(g, 0, ry, 0, ry + rh, [[0, '#1e1418', 0.75], [0.25, '#1e1418', 0], [0.75, '#1e1418', 0], [1, '#1e1418', 0.75]]); g.fillRect(x0, ry, RW, rh);
      g.restore();
    }
    line(g, [[rx, ry + rh / 2], [rx + rw, ry + rh / 2]], 2, '#d8302a', 0.7);
    g.save(); g.globalAlpha = 0.22; g.fillStyle = '#ffffff'; poly(g, [[rx + 10, ry], [rx + 46, ry], [rx + 6, ry + rh], [rx - 30, ry + rh]]); g.fill(); g.restore();
    // pay table
    rrect(g, 22, 272, w - 44, 30, 4, '#2a1a14');
    g.save(); g.font = `bold 10px ${FONT}`; g.fillStyle = '#e8c060'; g.textBaseline = 'middle';
    g.textAlign = 'left'; g.fillText('7 7 7 . . . . . 500', 30, 281); g.fillText('G G G . . . . . 50', 30, 294);
    g.textAlign = 'right'; g.fillText('BAR . . 10', w - 30, 281); g.fillText('CHERRY . . 2', w - 30, 294); g.restore();
    // the button deck (geometry sits on it)
    rect(g, 0, 304, w, 30, '#c8a050'); line(g, [[0, 305], [w, 305]], 2, '#fff0b8', 0.7); line(g, [[0, 333], [w, 333]], 2.5, '#4a2e10', 0.8);
    // the goblin emblem: a cog with a coin
    const ex = w / 2, ey = 392;
    for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; g.save(); g.translate(ex + Math.cos(a) * 34, ey + Math.sin(a) * 34); g.rotate(a); rrect(g, -6, -5, 12, 10, 2, '#8a6420'); g.restore(); }
    ellipse(g, ex + 2, ey + 3, 36, 36, 0, '#3a2410', 0.6); ellipse(g, ex, ey, 35, 35, 0, '#c8962e'); ellipse(g, ex, ey, 26, 26, 0, '#8a6420');
    ellipse(g, ex, ey, 22, 22, 0, '#e8c060'); blob(g, ex - 8, ey - 9, 9, 6, -0.5, '#fff4c8', 0.8, 0.3);
    g.save(); g.font = `bold 26px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#7a4a14'; g.fillText('$', ex, ey + 1); g.restore();
    // coin tray opening with a few coins in it
    rrect(g, 58, 438, w - 116, 46, 8, '#c8a050'); rrect(g, 64, 444, w - 128, 34, 6, '#1e1418');
    for (let i = 0; i < 7; i++) { const x = range(rnd, 74, w - 74), y = range(rnd, 466, 474); ellipse(g, x + 1, y + 1, 8, 3.5, 0, '#3a2410'); ellipse(g, x, y, 8, 3.5, 0, '#e0b048'); line(g, [[x - 5, y - 1.5], [x + 3, y - 2]], 1, '#fff0b8', 0.8); }
    for (let k = 0; k < 7; k++) { const t = 14 + k * (w - 28) / 6; rivet(g, t, 352, 3, '#c8a050'); rivet(g, t, 500, 3, '#c8a050'); }
    vignette(g, 0, 100, w, h - 100, '#2a1010', 0.3);
    glaze(g, w, h, '#ffe0b0', 0.08);
    blurTile(cv, 0.4);
  },
});

// ---- the CRT ---------------------------------------------------------------------------------------------

register('loot_screen', {
  family: F, size: 128, note: 'CRT glass: smoky green-gray, curved, a window reflection and a faint glow of a picture',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = radial(g, s * 0.5, s * 0.5, 4, s * 0.72, [[0, '#5a7470'], [0.5, '#3a5250'], [0.85, '#22302e'], [1, '#141c1c']]); g.fillRect(0, 0, s, s);
    // the ghost of a picture: a gnome waving (it's always the gnome channel)
    blob(g, s * 0.52, s * 0.6, 22, 30, 0, '#7aa098', 0.22, 0.3);
    blob(g, s * 0.52, s * 0.34, 12, 18, 0, '#9a6a60', 0.18, 0.3);
    for (let y = 2; y < s; y += 3) line(g, [[0, y], [s, y]], 1, '#0e1414', 0.08);
    for (let i = 0; i < 6; i++) { const y = rnd() * s; line(g, [[rnd() * s * 0.3, y], [s * 0.7 + rnd() * s * 0.3, y]], range(rnd, 2, 5), '#b8e0d8', 0.08); }
    // the room's window reflected in the glass, and a bright curved glint
    g.save(); g.globalAlpha = 0.28; g.fillStyle = '#e8f4f0'; poly(g, [[s * 0.14, s * 0.14], [s * 0.42, s * 0.12], [s * 0.36, s * 0.42], [s * 0.1, s * 0.44]]); g.fill(); g.restore();
    line(g, [[s * 0.25, s * 0.13], [s * 0.24, s * 0.43]], 2.5, '#22302e', 0.25);
    const arc = []; for (let k = 0; k <= 10; k++) { const a = Math.PI * (1.05 + k / 10 * 0.4); arc.push([s * 0.5 + Math.cos(a) * s * 0.4, s * 0.55 + Math.sin(a) * s * 0.42]); }
    line(g, arc, 2, '#f4fffc', 0.5);
    vignette(g, 0, 0, s, s, '#0a1010', 0.55, 0.12);
    blurTile(cv, 0.6);
  },
});

register('loot_tvfront', {
  family: F, w: 256, h: 176, note: 'the CRT cabinet face: wood frame, the deep screen recess, a speaker grille and the knob plate, SLOPTRON',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#5a3a24');
    grain(g, 0, 0, w, h, rnd, { dark: ['#3a2416', '#2e1c14'], lite: ['#86603e', '#946a44'], n: 36, amp: 2, knots: 1 });
    bevel(g, 0, 0, w, h, '#5a3a24', 9, 0.5, 0.55);
    const [su0, sv0, su1, sv1] = TV_LAYOUT.screen;
    const X0 = su0 * w, X1 = su1 * w, Y0 = (1 - sv1) * h, Y1 = (1 - sv0) * h;
    // a raised brass bezel round the screen recess
    rrect(g, X0 - 7, Y0 - 7, X1 - X0 + 14, Y1 - Y0 + 14, 16, '#3a2410', 0.6);
    rrect(g, X0 - 5, Y0 - 5, X1 - X0 + 10, Y1 - Y0 + 10, 14, '#b08a40');
    g.save(); g.strokeStyle = rgba('#f8e49a', 0.8); g.lineWidth = 1.5; g.beginPath(); g.roundRect(X0 - 4, Y0 - 4, X1 - X0 + 8, Y1 - Y0 + 8, 13); g.stroke(); g.restore();
    rrect(g, X0, Y0, X1 - X0, Y1 - Y0, 12, '#141012');
    // right panel: knob plate above, grille cloth below
    const px0 = w * 0.75, px1 = w * 0.96;
    rrect(g, px0, h * 0.06, px1 - px0, h * 0.34, 5, '#b08a40');
    g.save(); g.strokeStyle = rgba('#f8e49a', 0.7); g.lineWidth = 1.2; g.beginPath(); g.roundRect(px0 + 1, h * 0.06 + 1, px1 - px0 - 2, h * 0.34 - 2, 4); g.stroke(); g.restore();
    for (const [u, v] of TV_LAYOUT.knobs) { ellipse(g, u * w, (1 - v) * h, 9, 9, 0, '#5a3a14', 0.5); for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; line(g, [[u * w + Math.cos(a) * 10, (1 - v) * h + Math.sin(a) * 10], [u * w + Math.cos(a) * 12, (1 - v) * h + Math.sin(a) * 12]], 1, '#3a2410', 0.7); } }
    const gy0 = h * 0.45, gy1 = h * 0.88;
    rrect(g, px0, gy0, px1 - px0, gy1 - gy0, 5, '#2a1a10');
    g.save(); g.beginPath(); g.roundRect(px0 + 3, gy0 + 3, px1 - px0 - 6, gy1 - gy0 - 6, 4); g.clip();
    rect(g, px0, gy0, px1 - px0, gy1 - gy0, '#8a6a40');
    for (let y = gy0; y < gy1; y += 2.5) line(g, [[px0, y], [px1, y]], 0.8, '#5a4026', 0.6);
    for (let x = px0; x < px1; x += 2.5) line(g, [[x, gy0], [x, gy1]], 0.8, '#a8885a', 0.35);
    g.fillStyle = lin(g, 0, gy0, 0, gy1, [[0, '#1e140c', 0.5], [0.3, '#1e140c', 0], [1, '#1e140c', 0.35]]); g.fillRect(px0, gy0, px1 - px0, gy1 - gy0);
    g.restore();
    // the maker's script along the bottom rail
    letters(g, 'SLOPTRON', (X0 + X1) / 2, h * 0.94, 12, { rnd, jit: 0.02, shadow: 0, track: 2 });
    glaze(g, w, h, '#ffd8a8', 0.1);
    blurTile(cv, 0.4);
  },
});

// ---- the stained-glass lamp ------------------------------------------------------------------------------

register('loot_glass', {
  family: F, w: 256, h: 128, note: 'Tiffany-ish leaded glass (u wraps; v up the shade): amber border, a band of red poppies, green leaves, honey panes',
  paint(g, w, rnd, h, cv) {
    // jittered seeds in rows; colors by height; tiles in u
    const rowsY = [6, 16, 28, 40, 52, 64, 76, 88, 100, 112, 122];
    const seeds = [];
    for (const [ri, y] of rowsY.entries()) {
      const n = ri < 2 ? 22 : ri > 8 ? 26 : 16;
      for (let i = 0; i < n; i++) seeds.push({ x: (i + 0.5 + (rnd() - 0.5) * 0.6) * w / n, y: y + (rnd() - 0.5) * 6, ri });
    }
    const colorOf = sd => {
      const t = sd.y / h;
      if (t < 0.16) return pick(rnd, ['#c8862e', '#d89a3a', '#b8742a']);                     // top: amber
      if (t < 0.5) return pick(rnd, ['#4e7a34', '#5e8a3c', '#3e6a2e', '#6a9444', '#8aa048']);   // leaves
      if (t < 0.74) return rnd() < 0.62 ? pick(rnd, ['#b8302a', '#c84432', '#a82a26', '#d8603a']) : pick(rnd, ['#5e8a3c', '#e0a040']);   // poppies
      return pick(rnd, ['#e0a848', '#d89a3a', '#e8b860', '#c88a34']);                         // the border: honey
    };
    for (const sd of seeds) sd.c = jitter(colorOf(sd), rnd, 0.06);
    const img = g.createImageData(w, h), D = img.data;
    const near = (x, y) => {
      let b1 = 1e9, b2 = 1e9, bi = 0;
      for (let i = 0; i < seeds.length; i++) {
        const sd = seeds[i]; let dx = Math.abs(x - sd.x); if (dx > w / 2) dx = w - dx; const dy = (y - sd.y) * 1.15;
        const d = dx * dx + dy * dy; if (d < b1) { b2 = b1; b1 = d; bi = i; } else if (d < b2) b2 = d;
      }
      return [bi, (Math.sqrt(b2) - Math.sqrt(b1)) / 2, Math.sqrt(b1)];
    };
    const lead = [58, 44, 34];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const [i, e, d1] = near(x, y);
      const c = seeds[i].c, cr = parseInt(c.slice(1, 3), 16), cg = parseInt(c.slice(3, 5), 16), cb = parseInt(c.slice(5, 7), 16);
      const glow = 1.18 - Math.min(1, d1 / 14) * 0.38;     // each pane brighter in its middle
      const k = (y * w + x) * 4, lt = Math.max(0, Math.min(1, (1.6 - e) / 1.2));
      D[k] = cr * glow * (1 - lt) + lead[0] * lt; D[k + 1] = cg * glow * (1 - lt) + lead[1] * lt; D[k + 2] = cb * glow * (1 - lt) + lead[2] * lt; D[k + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    // came lines along the rows and the rim
    for (const y of [11, 46, 94, 106]) line(g, [[0, y], [w, y]], 2.2, '#3a2c22', 0.9);
    rect(g, 0, h - 4, w, 4, '#5a4026'); rect(g, 0, 0, w, 3, '#5a4026');
    // light through the glass: streaky, a little mottled
    for (let i = 0; i < 30; i++) { const x = rnd() * w, y = rnd() * h; wrapX(w, x, 8, X => blob(g, X, y, range(rnd, 2, 6), range(rnd, 1, 3), rnd() * 3, '#fff4d0', 0.25, 0.3)); }
    blurTile(cv, 0.5);
  },
});

register('loot_bulb', {
  family: F, size: 64, note: 'a warm lit bulb',
  paint(g, s, rnd, h, cv) { g.fillStyle = radial(g, s * 0.45, s * 0.45, 2, s * 0.6, [[0, '#fffbe8'], [0.5, '#ffe6a0'], [1, '#e8a850']]); g.fillRect(0, 0, s, s); },
});

// ---- the gnome ------------------------------------------------------------------------------------------

register('loot_gnome', {
  family: F, size: 256, note: 'garden gnome sheet: felt hat (top left), coat with belt (top right), beard (bottom left), face (bottom right)',
  paint(g, s, rnd, h, cv) {
    const Q = s / 2;
    // hat: red felt (u around, v up: brim at the bottom, tip at the top)
    clip(g, () => { g.beginPath(); g.rect(0, 0, Q, Q); }, () => {
      g.fillStyle = lin(g, 0, 0, 0, Q, [[0, '#7a1c1a'], [0.4, '#a82c26'], [1, '#b8382e']]); g.fillRect(0, 0, Q, Q);
      for (let i = 0; i < 22; i++) { const x = rnd() * Q; wrapX(Q, x, 14, X => blob(g, X, rnd() * Q, range(rnd, 6, 16), range(rnd, 10, 26), 0, pick(rnd, ['#c84434', '#8a2220', '#b83a30']), 0.35, 0.15)); }
      for (let i = 0; i < 9; i++) { const x = rnd() * Q; wrapX(Q, x, 10, X => stroke(g, [[X, Q - 16], [X + (rnd() - 0.5) * 8, range(rnd, 40, 80)]], range(rnd, 4, 7), 1, '#6a1816', 0.14)); }
      // a stitched patch on the front, the brim fold
      rect(g, Q * 0.56, Q * 0.52, 18, 16, '#c86a3a'); stitches(g, [[Q * 0.56, Q * 0.52], [Q * 0.56 + 18, Q * 0.52], [Q * 0.56 + 18, Q * 0.52 + 16], [Q * 0.56, Q * 0.52 + 16], [Q * 0.56, Q * 0.52]], 4, 2.2, '#f0e0b8');
      g.fillStyle = lin(g, 0, Q - 18, 0, Q, [[0, '#d85040'], [0.5, '#a82c26'], [1, '#5a1414']]); g.fillRect(0, Q - 18, Q, 18);
    });
    // coat: blue, a belt with a brass buckle at the front (u = 0.5), brass buttons above it
    clip(g, () => { g.beginPath(); g.rect(Q, 0, Q, Q); }, () => {
      g.fillStyle = lin(g, 0, 0, 0, Q, [[0, '#3a5aa0'], [0.6, '#2e4a8a'], [1, '#22386a']]); g.fillRect(Q, 0, Q, Q);
      for (let i = 0; i < 20; i++) { const x = Q + rnd() * Q; blob(g, x, rnd() * Q, range(rnd, 6, 16), range(rnd, 10, 24), 0, pick(rnd, ['#4a6ab0', '#22386a', '#3a5aa0']), 0.35, 0.15); }
      for (let i = 0; i < 12; i++) { const x = Q + rnd() * Q; line(g, [[x, Q], [x + (rnd() - 0.5) * 6, range(rnd, 60, 100)]], range(rnd, 2, 4), '#1a2a54', 0.3); }   // skirt folds
      g.fillStyle = lin(g, 0, Q - 14, 0, Q, [[0, '#22386a', 0], [1, '#141e3a', 0.6]]); g.fillRect(Q, Q - 14, Q, 14);   // hem
      const by = Q * 0.52;
      rect(g, Q, by, Q, 13, '#4a2c18'); line(g, [[Q, by + 1], [s, by + 1]], 1.5, '#8a5a38', 0.8); line(g, [[Q, by + 12], [s, by + 12]], 1.5, '#1e1008', 0.8);
      const bx = Q + Q / 2;
      rrect(g, bx - 9, by - 2, 18, 17, 3, '#5a3a10'); rrect(g, bx - 7.5, by - 0.5, 15, 14, 2, '#e0b048'); rrect(g, bx - 4, by + 3, 8, 7, 1, '#4a2c18');
      blob(g, bx - 4, by + 1, 3, 2, 0, '#fff4c8', 0.9, 0.4);
      for (const y of [by - 14, by - 28]) { ellipse(g, bx + 0.8, y + 1, 3, 3, 0, '#1a1a30'); ellipse(g, bx, y, 2.8, 2.8, 0, '#d8a440'); blob(g, bx - 0.8, y - 0.8, 1.2, 1, 0, '#fff4c8', 1, 0.4); }
      // fur trim at the collar
      for (let i = 0; i < 40; i++) { const x = Q + rnd() * Q; blade(g, x, 10, range(rnd, 6, 10), Math.PI + range(rnd, -0.3, 0.3), 2.2, pick(rnd, ['#e8e0d0', '#c8c0b0', '#f8f4ec']), 0.9, 0.2); }
    });
    // beard: white hair flowing down (v: top = chin, bottom = tip)
    clip(g, () => { g.beginPath(); g.rect(0, Q, Q, Q); }, () => {
      g.fillStyle = lin(g, 0, Q, 0, s, [[0, '#d8d0c4'], [0.5, '#e8e2d6'], [1, '#c8c0b4']]); g.fillRect(0, Q, Q, Q);
      for (let i = 0; i < 160; i++) {
        const x = rnd() * Q, y = Q + rnd() * Q * 0.8, L = range(rnd, 14, 34), c = pick(rnd, ['#f8f4ec', '#fffaf2', '#b8b0a4', '#d8d0c4', '#a8a094']);
        const curl = range(rnd, -0.6, 0.6);
        const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([x + Math.sin(t * 3 + curl * 4) * 3 * curl, y + L * t]); }
        wrapX(Q, x, 6, X => stroke(g, pts.map(([u, v]) => [u - x + X, v]), range(rnd, 1.6, 3), 0.4, c, 0.75));
      }
      g.fillStyle = lin(g, 0, Q, 0, Q + 18, [[0, '#6a6058', 0.5], [1, '#6a6058', 0]]); g.fillRect(0, Q, Q, 18);
    });
    // face: rosy skin, small bright eyes, bushy white brows (u = 0.5 is the front, v = 0.5 the equator)
    clip(g, () => { g.beginPath(); g.rect(Q, Q, Q, Q); }, () => {
      const fx = Q + Q / 2, fy = Q + Q * 0.41;
      g.fillStyle = lin(g, 0, Q, 0, s, [[0, '#d89a74'], [0.5, '#e8b088'], [1, '#c88a68']]); g.fillRect(Q, Q, Q, Q);
      // white hair round the back of the head
      for (const side of [Q + 4, s - 4]) for (let i = 0; i < 40; i++) { const x = side + (rnd() - 0.5) * 30, y = Q + range(rnd, 6, 80); blade(g, x, y, range(rnd, 10, 18), Math.PI + range(rnd, -0.3, 0.3), 3, pick(rnd, ['#e8e2d6', '#c8c0b4', '#f8f4ec']), 0.85, 0.3); }
      blob(g, fx - 14, fy + 10, 11, 8, 0, '#e07868', 0.55, 0.3); blob(g, fx + 14, fy + 10, 11, 8, 0, '#e07868', 0.55, 0.3);   // cheeks
      blob(g, fx, fy - 12, 22, 9, 0, '#f4c8a0', 0.4, 0.3);                                                                   // brow light
      for (const sx of [-1, 1]) {
        const ex = fx + sx * 8.5, ey = fy - 1;
        ellipse(g, ex, ey, 3.6, 3.2, 0, '#f4ece0'); ellipse(g, ex + sx * 0.4, ey + 0.3, 2.5, 2.7, 0, '#3a5a8a'); ellipse(g, ex + sx * 0.4, ey + 0.4, 1.3, 1.5, 0, '#141018');
        blob(g, ex - 0.8, ey - 0.9, 0.9, 0.9, 0, '#ffffff', 1, 0.6);
        line(g, [[ex - 4, ey - 2.8], [ex + 4, ey - 3.2]], 1.2, '#8a4a38', 0.7);       // lid
        for (let k = 0; k < 9; k++) blade(g, ex - sx * 4 + sx * k * 1.1, ey - 4 - k * 0.2, range(rnd, 4, 6.5), sx * range(rnd, 1.0, 1.5), 1.8, pick(rnd, ['#f8f4ec', '#d8d0c4']), 0.95, sx * 0.3);   // bushy brows
      }
      blob(g, fx, fy + 24, 9, 4, 0, '#8a4a3a', 0.3, 0.4);   // the shadow under the nose
    });
    blurTile(cv, 0.35);
  },
});

register('loot_skin', { family: F, size: 64, note: 'rosy gnome skin (nose, mitts)', paint(g, s, rnd, h, cv) { g.fillStyle = radial(g, s * 0.4, s * 0.38, 2, s * 0.6, [[0, '#f4c8a0'], [0.55, '#e0a07a'], [1, '#b87058']]); g.fillRect(0, 0, s, s); blob(g, s * 0.55, s * 0.55, 12, 10, 0, '#e07868', 0.35, 0.3); } });
register('loot_boot', {
  family: F, size: 64, note: 'dark brown boot leather',
  paint(g, s, rnd, h, cv) { g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#6a4228'], [0.6, '#4a2c18'], [1, '#2a1a10']]); g.fillRect(0, 0, s, s); for (let i = 0; i < 8; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 4, 10), range(rnd, 2, 5), 0, '#8a6040', 0.3, 0.3); blurTile(cv, 0.4); },
});

// ---- the velvet portrait -----------------------------------------------------------------------------

register('loot_portrait', {
  family: F, w: 256, h: 208, note: 'the Velvet Elvis, as a court painter in Stormwind would have done him: black velvet, rim light, a mighty pompadour',
  paint(g, w, rnd, h, cv) {
    // black velvet with a deep blue-violet sheen and a spotlight halo
    rect(g, 0, 0, w, h, '#120e1a');
    for (let i = 0; i < 18; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 30, 80), range(rnd, 30, 70), rnd() * 3, pick(rnd, ['#221a3a', '#1a1630', '#2a1e44']), 0.45, 0.1);
    g.fillStyle = radial(g, w * 0.52, h * 0.36, 10, 120, [[0, '#4a5aa0', 0.55], [0.6, '#2a2a5a', 0.3], [1, '#120e1a', 0]]); g.fillRect(0, 0, w, h);
    const cx = w * 0.5, cy = h * 0.42;
    // the white jumpsuit and its great collar
    g.save();
    g.fillStyle = lin(g, cx - 90, 0, cx + 90, 0, [[0, '#d8dcec'], [0.45, '#f2eee4'], [1, '#8a92b8']]);
    poly(g, [[cx - 104, h + 4], [cx - 92, h - 34], [cx - 52, h - 66], [cx - 18, h - 70], [cx + 18, h - 70], [cx + 56, h - 64], [cx + 96, h - 32], [cx + 108, h + 4]]); g.fill();
    g.fillStyle = '#e8e4dc';
    poly(g, [[cx - 54, h - 62], [cx - 44, cy + 20], [cx - 24, cy + 42], [cx - 12, h - 58]]); g.fill();
    g.fillStyle = '#b8bcd8';
    poly(g, [[cx + 54, h - 62], [cx + 46, cy + 22], [cx + 26, cy + 42], [cx + 12, h - 58]]); g.fill();
    g.restore();
    for (let i = 0; i < 22; i++) { const x = cx + range(rnd, -88, 88), y = range(rnd, h - 52, h - 6); ellipse(g, x + 0.8, y + 0.8, 2.2, 2.2, 0, '#5a4020'); ellipse(g, x, y, 2, 2, 0, '#e8c060'); blob(g, x - 0.5, y - 0.6, 0.9, 0.8, 0, '#fff4c8', 1, 0.5); }
    line(g, [[cx - 10, h - 64], [cx, h], [cx + 10, h - 64]], 3, '#9aa0c0', 0.6);    // the plunging V
    blob(g, cx, h - 40, 9, 22, 0, '#c88a68', 0.85, 0.5);
    // neck
    g.save(); g.fillStyle = lin(g, cx - 18, 0, cx + 18, 0, [[0, '#e0a47c'], [1, '#8a5048']]); g.fillRect(cx - 17, cy + 22, 34, 40); g.restore();
    blob(g, cx + 4, cy + 34, 18, 8, 0, '#5a3038', 0.5, 0.3);
    // the face: an angular jaw, warm lit planes on the left, cool shadow and a blue rim light on the right
    const facePath = () => {
      g.beginPath(); g.moveTo(cx - 2, cy - 42);
      g.bezierCurveTo(cx - 22, cy - 42, cx - 32, cy - 30, cx - 33, cy - 8);
      g.bezierCurveTo(cx - 33, cy + 10, cx - 28, cy + 22, cx - 18, cy + 32);
      g.bezierCurveTo(cx - 10, cy + 40, cx + 6, cy + 42, cx + 14, cy + 36);
      g.bezierCurveTo(cx + 24, cy + 28, cx + 31, cy + 14, cx + 32, cy - 6);
      g.bezierCurveTo(cx + 32, cy - 28, cx + 20, cy - 42, cx - 2, cy - 42); g.closePath();
    };
    g.save(); facePath(); g.fillStyle = lin(g, cx - 34, 0, cx + 34, 0, [[0, '#f0c098'], [0.5, '#d89670'], [0.85, '#9a5a4c'], [1, '#7a5a7a']]); g.fill(); g.clip();
    blob(g, cx - 14, cy - 6, 16, 22, 0, '#f8d4ac', 0.6, 0.2);            // lit cheek
    blob(g, cx - 6, cy - 28, 18, 9, 0, '#f8d8b4', 0.5, 0.2);             // forehead
    blob(g, cx + 20, cy + 8, 12, 26, 0, '#8a4a44', 0.45, 0.2);           // shadow side
    blob(g, cx + 14, cy + 14, 10, 6, -0.4, '#7a3e3e', 0.4, 0.3);         // under the cheekbone
    blob(g, cx - 14, cy + 14, 8, 5, 0.4, '#c07a60', 0.3, 0.3);
    for (const sx of [-1, 1]) blob(g, cx + sx * 13 + 1, cy - 6, 10, 6, 0, '#9a5a50', 0.5, 0.3);   // eye sockets
    blob(g, cx + 2, cy + 33, 10, 5, 0, '#f0c4a0', 0.4, 0.3);              // chin light
    g.restore();
    g.save(); facePath(); g.clip(); blob(g, cx + 33, cy - 2, 6, 30, 0.1, '#9ab0ff', 0.6, 0.3); blob(g, cx + 22, cy + 30, 7, 4, -0.6, '#9ab0ff', 0.4, 0.3); g.restore();
    // sideburns
    for (const sx of [-1, 1]) {
      g.save(); g.fillStyle = '#0e0c16'; g.beginPath();
      g.moveTo(cx + sx * 31, cy - 18); g.quadraticCurveTo(cx + sx * 35, cy + 6, cx + sx * 26, cy + 24); g.lineTo(cx + sx * 21, cy + 20); g.quadraticCurveTo(cx + sx * 27, cy, cx + sx * 25, cy - 16); g.closePath(); g.fill(); g.restore();
    }
    // eyes: heavy-lidded, a smouldering look
    for (const sx of [-1, 1]) {
      const ex = cx + sx * 13 + 1, ey = cy - 4;
      ellipse(g, ex, ey, 6, 2.4, 0, '#e8dcd0'); ellipse(g, ex + 1, ey + 0.4, 2.5, 2.3, 0, '#3a4a7a'); ellipse(g, ex + 1, ey + 0.4, 1.1, 1.1, 0, '#0e0a10');
      blob(g, ex + 0.2, ey - 0.4, 0.8, 0.7, 0, '#ffffff', 0.9, 0.6);
      line(g, [[ex - 7, ey - 0.8], [ex, ey - 2.2], [ex + 7, ey - 1.4]], 2.4, '#2a1418', 0.95);      // the lid
      line(g, [[ex - 6, ey + 3], [ex + 6, ey + 2.6]], 0.8, '#8a4a40', 0.5);
      line(g, [[ex - 9, ey - 8 + sx * 1.5], [ex - 2, ey - 10.5], [ex + 8, ey - 9 - sx * 2]], 3, '#0e0c16', 0.95);   // brows, one cocked
    }
    // nose: a lit ridge, a shaded side, nostrils
    stroke(g, [[cx - 1, cy - 8], [cx + 1, cy + 4], [cx + 2, cy + 10]], 2.6, 1.6, '#f8d8b4', 0.75);
    stroke(g, [[cx + 4, cy - 6], [cx + 6, cy + 6], [cx + 5, cy + 12]], 3, 2, '#8a4a40', 0.55);
    blob(g, cx - 3, cy + 13, 2.2, 1.4, 0, '#5a2a28', 0.7, 0.4); blob(g, cx + 6, cy + 13, 2.2, 1.4, 0, '#5a2a28', 0.7, 0.4);
    // the famous lip
    g.save(); g.fillStyle = '#a85a50'; g.beginPath(); g.moveTo(cx - 11, cy + 23); g.quadraticCurveTo(cx, cy + 19, cx + 13, cy + 18); g.quadraticCurveTo(cx + 2, cy + 29, cx - 11, cy + 23); g.fill(); g.restore();
    line(g, [[cx - 11, cy + 23], [cx - 2, cy + 21.5], [cx + 13, cy + 17]], 1.6, '#4a1e22', 0.9);
    blob(g, cx, cy + 25.5, 6, 1.6, 0, '#e8a890', 0.6, 0.5);
    // the pompadour: a great swept wave of blue-black hair, strokes following the wave, glossy blue highlights
    const hairPath = () => {
      g.beginPath();
      g.moveTo(cx - 34, cy - 8); g.bezierCurveTo(cx - 48, cy - 46, cx - 22, cy - 84, cx + 18, cy - 82);
      g.bezierCurveTo(cx + 56, cy - 80, cx + 62, cy - 50, cx + 42, cy - 34); g.bezierCurveTo(cx + 42, cy - 18, cx + 36, cy - 8, cx + 32, cy - 14);
      g.bezierCurveTo(cx + 26, cy - 34, cx + 4, cy - 44, cx - 16, cy - 38); g.bezierCurveTo(cx - 26, cy - 32, cx - 30, cy - 18, cx - 34, cy - 8); g.closePath();
    };
    g.save(); hairPath(); g.fillStyle = '#0c0a14'; g.fill(); g.clip();
    for (let i = 0; i < 40; i++) {
      const t0 = rnd(), pts = [];
      const R = 30 + t0 * 30, oy = range(rnd, -4, 4);
      for (let k = 0; k <= 10; k++) { const t = k / 10, a = Math.PI * (0.95 + t * 1.0); pts.push([cx + 8 + Math.cos(a) * R * 1.08, cy - 40 + oy + Math.sin(a) * R * 0.72]); }
      stroke(g, pts, range(rnd, 1.5, 4), 0.5, pick(rnd, ['#2a3060', '#1e2244', '#3a4a8a', '#4a5aa0']), range(rnd, 0.4, 0.8));
    }
    for (let i = 0; i < 7; i++) {
      const R = 36 + i * 3.5, pts = [];
      for (let k = 0; k <= 8; k++) { const t = k / 8, a = Math.PI * (1.15 + t * 0.5); pts.push([cx + 8 + Math.cos(a) * R * 1.05, cy - 42 + Math.sin(a) * R * 0.7]); }
      stroke(g, pts, 2.5 - i * 0.2, 0.6, i < 3 ? '#c8d4ff' : '#7a8ad8', 0.55 - i * 0.05);
    }
    g.restore();
    // gold signature in the corner
    letters(g, 'E.P.', w - 30, h - 14, 13, { rnd, jit: 0.05, shadow: 0, fill: ['#e8c870', '#a87a30'] });
    glaze(g, w, h, '#ffe0c0', 0.06);
    blurTile(cv, 0.5);
  },
});

// ---- guitar ------------------------------------------------------------------------------------------

register('loot_guitar', {
  family: F, w: 160, h: 256, note: 'the signed guitar\'s top: amber spruce with a sunburst, rosette, pickguard, bridge, strings and a scrawled autograph',
  paint(g, w, rnd, h, cv) {
    const P = ([x, y]) => [(x + 0.5) * w, (1 - y) * h];
    const body = () => { const pts = GUITAR_OUTLINE.map(P); poly(g, pts); };
    rect(g, 0, 0, w, h, '#5a3018');
    clip(g, body, () => {
      rect(g, 0, 0, w, h, '#d8a860');
      for (let i = 0; i < 14; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 10, 30), range(rnd, 30, 70), 0, pick(rnd, ['#e4b870', '#c89450', '#e8c07a']), 0.3, 0.1);
      for (let x = 2; x < w; x += range(rnd, 2.5, 5)) line(g, [[x, 0], [x + (rnd() - 0.5) * 1.5, h]], range(rnd, 0.5, 1.2), rnd() < 0.6 ? '#a87840' : '#f0cc88', 0.28);
      // sunburst toward the edge
      const pts = GUITAR_OUTLINE.map(P);
      for (const [lw, a] of [[60, 0.16], [38, 0.22], [22, 0.3], [10, 0.38]]) { g.save(); g.lineWidth = lw; g.strokeStyle = rgba('#5a2a12', a); g.lineJoin = 'round'; poly(g, pts); g.stroke(); g.restore(); }
      // pickguard (tortoiseshell)
      const [hx, hy] = P([GUITAR_HOLE.x, GUITAR_HOLE.y]), hr = GUITAR_HOLE.r * w;
      g.save(); g.fillStyle = '#5a2412'; g.beginPath(); g.moveTo(hx + hr * 0.8, hy - hr * 0.3); g.quadraticCurveTo(hx + hr * 2.1, hy + hr * 0.4, hx + hr * 1.3, hy + hr * 1.7); g.quadraticCurveTo(hx + hr * 0.4, hy + hr * 1.8, hx + hr * 0.2, hy + hr * 1.05); g.closePath(); g.fill();
      g.clip(); for (let i = 0; i < 12; i++) blob(g, hx + hr * range(rnd, 0.4, 1.8), hy + hr * range(rnd, -0.2, 1.7), range(rnd, 2, 5), range(rnd, 1.5, 4), 0, '#b8642a', 0.6, 0.4); g.restore();
      // rosette and soundhole
      for (const [r, c, lw] of [[1.55, '#3a2010', 2], [1.42, '#f0e2c0', 2], [1.3, '#3a2010', 3], [1.18, '#d8b070', 1.5]]) { g.save(); g.lineWidth = lw; g.strokeStyle = c; g.beginPath(); g.arc(hx, hy, hr * r, 0, TAU); g.stroke(); g.restore(); }
      for (let k = 0; k < 36; k++) { const a = k / 36 * TAU; ellipse(g, hx + Math.cos(a) * hr * 1.36, hy + Math.sin(a) * hr * 1.36, 1.2, 1.2, 0, k % 2 ? '#3a6a3a' : '#a83a2a', 0.9); }
      g.fillStyle = radial(g, hx + 2, hy + 3, 2, hr, [[0, '#2a1810'], [1, '#100a08']]); g.beginPath(); g.arc(hx, hy, hr, 0, TAU); g.fill();
      line(g, [[hx - hr * 0.8, hy - hr * 0.2], [hx + hr * 0.8, hy - hr * 0.35]], 2, '#5a3a20', 0.5);
      // bridge, saddle, pins
      const [bx, by] = P([0, 0.24]);
      rrect(g, bx - 30, by - 7, 60, 14, 4, '#2a1810'); rrect(g, bx - 28, by - 6, 56, 11, 3, '#4a2a18');
      line(g, [[bx - 20, by - 3], [bx + 20, by - 3.5]], 2, '#f0e6cc', 0.95);
      for (let k = 0; k < 6; k++) ellipse(g, bx - 15 + k * 6, by + 2, 1.6, 1.6, 0, '#f0e6cc');
      // strings from the saddle up over the hole and off the top
      for (let k = 0; k < 6; k++) {
        const x0 = bx - 13 + k * 5.2, x1 = w / 2 - 9 + k * 3.6;
        line(g, [[x0 + 0.8, by - 3], [x1 + 0.8, 0]], 0.9, '#2a1810', 0.4);
        line(g, [[x0, by - 3], [x1, 0]], k < 3 ? 1.1 : 0.8, '#ece4d4', 0.9);
      }
      // the autograph: a big loopy marker scrawl across the lower bout
      const sg = []; const x0 = w * 0.12, y0 = h * 0.86;
      for (let t = 0; t <= 1; t += 0.008) { const k = t * 9 * Math.PI; sg.push([x0 + t * w * 0.62 - Math.sin(k) * 6, y0 - t * 18 + Math.cos(k) * 7 * (1 - t * 0.4)]); }
      line(g, sg, 2.2, '#141018', 0.85);
      line(g, [[x0 + 4, y0 + 12], [x0 + w * 0.7, y0 + 2]], 1.8, '#141018', 0.8);
    });
    // binding round the edge
    { const pts = GUITAR_OUTLINE.map(P); g.save(); g.lineWidth = 3; g.strokeStyle = '#ece0c0'; g.lineJoin = 'round'; poly(g, pts); g.stroke(); g.lineWidth = 1; g.strokeStyle = '#3a2010'; g.stroke(); g.restore(); }
    glaze(g, w, h, '#ffe0b0', 0.08);
    blurTile(cv, 0.35);
  },
});

// ---- tire & wheel ------------------------------------------------------------------------------------

export const TIRE_V = { treadLo: 0.38, treadHi: 0.62, wallLo: [0.1, 0.2], wallHi: [0.8, 0.9] };
register('loot_tire', {
  family: F, w: 256, h: 128, note: 'a chunky whitewall tire (u wraps round it; v: bottom bead → sidewall → tread → sidewall → top bead)',
  paint(g, w, rnd, h, cv) {
    const Y = v => (1 - v) * h;
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#2a2628'], [0.3, '#3a3436'], [0.5, '#2e2a2c'], [0.7, '#3a3436'], [1, '#2a2628']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 20; i++) { const x = rnd() * w; wrapX(w, x, 20, X => blob(g, X, rnd() * h, range(rnd, 8, 20), range(rnd, 4, 10), 0, pick(rnd, ['#4a4244', '#221e20', '#5a4a40']), 0.3, 0.2)); }
    // whitewalls: cream, a little dirty
    for (const [a, b] of [TIRE_V.wallLo, TIRE_V.wallHi]) {
      g.fillStyle = lin(g, 0, Y(b), 0, Y(a), [[0, '#c8bca4'], [0.3, '#ece2cc'], [1, '#b8ac94']]); g.fillRect(0, Y(b), w, Y(a) - Y(b));
      for (let i = 0; i < 14; i++) { const x = rnd() * w; wrapX(w, x, 10, X => blob(g, X, range(rnd, Y(b), Y(a)), range(rnd, 4, 10), 2.5, 0, '#8a7a64', 0.35, 0.3)); }
      line(g, [[0, Y(b)], [w, Y(b)]], 1.2, '#141214', 0.6); line(g, [[0, Y(a)], [w, Y(a)]], 1.2, '#141214', 0.6);
    }
    // tread: chunky staggered blocks with dark grooves, each lit on its top-left edge
    const t0 = Y(TIRE_V.treadHi), t1 = Y(TIRE_V.treadLo), th = t1 - t0, n = 16, bw = w / n;
    rect(g, 0, t0, w, th, '#141214');
    for (let i = 0; i < n; i++) for (let r = 0; r < 2; r++) {
      const x = i * bw + (r ? bw * 0.5 : 0) + 1.5, y = t0 + 2 + r * th / 2, bh = th / 2 - 4;
      wrapX(w, x + bw / 2, bw, X => {
        const xx = X - bw / 2, c = jitter('#3a3436', rnd, 0.05);
        g.save(); g.beginPath(); g.moveTo(xx + 2, y); g.lineTo(xx + bw - 4, y + 1.5); g.lineTo(xx + bw - 2, y + bh); g.lineTo(xx, y + bh - 1); g.closePath();
        g.fillStyle = lin(g, xx, y, xx + bw * 0.5, y + bh, [[0, '#5a5254'], [0.4, c], [1, '#221e20']]); g.fill(); g.restore();
        line(g, [[xx + 2, y + 1], [xx + bw - 4, y + 2]], 1.2, '#7a7072', 0.6);
      });
    }
    // shoulders: little notches
    for (let i = 0; i < 32; i++) for (const y of [t0 - 3, t1 + 3]) { const x = i * w / 32; line(g, [[x, y - 2], [x, y + 2]], 1.2, '#141214', 0.7); }
    // dust caked in the grooves and on the lower wall
    for (let i = 0; i < 18; i++) { const x = rnd() * w; wrapX(w, x, 10, X => blob(g, X, range(rnd, t0, h), range(rnd, 4, 12), range(rnd, 2, 4), 0, '#8a7458', 0.18, 0.3)); }
    blurTile(cv, 0.35);
  },
});

register('loot_rim', {
  family: F, size: 128, note: 'the steel wheel seen face on: cream-painted dish, lug nuts, a brass goblin hubcap',
  paint(g, s, rnd, h, cv) {
    const c = s / 2;
    rect(g, 0, 0, s, s, '#3a3436');
    g.fillStyle = radial(g, c, c, s * 0.05, s * 0.5, [[0, '#d8ccb0'], [0.6, '#c8b898'], [0.85, '#8a7a64'], [1, '#4a4038']]); g.beginPath(); g.arc(c, c, s * 0.5, 0, TAU); g.fill();
    g.save(); g.lineWidth = 3; g.strokeStyle = rgba('#5a4a3a', 0.8); g.beginPath(); g.arc(c, c, s * 0.42, 0, TAU); g.stroke(); g.restore();
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; ellipse(g, c + Math.cos(a) * s * 0.33, c + Math.sin(a) * s * 0.33, 6, 4.5, a, '#3a3028', 0.8); }
    for (let i = 0; i < 10; i++) { const a = rnd() * TAU, r = range(rnd, 0.2, 0.46) * s; blob(g, c + Math.cos(a) * r, c + Math.sin(a) * r, range(rnd, 3, 8), range(rnd, 2, 4), a, '#8a4a2a', 0.45, 0.4); }
    for (let k = 0; k < 5; k++) { const a = k / 5 * TAU + 0.3; rivet(g, c + Math.cos(a) * s * 0.2, c + Math.sin(a) * s * 0.2, 3.5, '#8a8a84'); }
    ellipse(g, c + 1.5, c + 2, s * 0.13, s * 0.13, 0, '#3a2410', 0.6);
    g.fillStyle = radial(g, c - 4, c - 4, 1, s * 0.13, [[0, '#fff0b0'], [0.5, '#d8a840'], [1, '#8a6420']]); g.beginPath(); g.arc(c, c, s * 0.12, 0, TAU); g.fill();
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; line(g, [[c + Math.cos(a) * s * 0.05, c + Math.sin(a) * s * 0.05], [c + Math.cos(a) * s * 0.1, c + Math.sin(a) * s * 0.1]], 2, '#7a5418', 0.7); }
    blurTile(cv, 0.4);
  },
});

// ---- the dinosaur's head -------------------------------------------------------------------------------

register('loot_dino', {
  family: F, size: 256, note: 'the statue\'s hide (u along the head, v: belly at the bottom, back at the top): painted scales, stripes, cream belly, chipped plaster',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#2e5228'], [0.22, '#41703a'], [0.45, '#578644'], [0.58, '#7a9450'], [0.66, '#b8b07a'], [0.72, '#d4c48c'], [1, '#dccc94']]); g.fillRect(0, 0, s, s);
    mottle(g, s, rnd, { colors: ['#6a9a4a', '#3e6a34', '#7aa456', '#4a5a2a'], count: 34, rmin: 12, rmax: 46, alpha: 0.28, hard: 0.1 });
    // dark tiger stripes down from the back
    for (let i = 0; i < 8; i++) {
      const x = (i + 0.5) * s / 8 + range(rnd, -10, 10), pts = [], L = range(rnd, 0.36, 0.52) * s;
      for (let k = 0; k <= 6; k++) pts.push([x + Math.sin(k * 0.9 + i) * 5 + k * 2.5, k / 6 * L]);
      stroke(g, pts, range(rnd, 12, 18), 2, '#22401c', 0.42);
    }
    // scales: painted one by one in no order, bigger along the back, smaller down the flank
    for (let i = 0; i < 420; i++) {
      const y = Math.pow(rnd(), 1.15) * s * 0.66, x = rnd() * s, t = y / (s * 0.66);
      const r = (9 - 5 * t) * range(rnd, 0.7, 1.25), c = jitter(mix('#3a6430', '#76a052', t), rnd, 0.08);
      blob(g, x + r * 0.3, y + r * 0.45, r * 1.05, r * 0.8, 0, '#16220f', 0.28, 0.3);
      ellipse(g, x, y, r, r * 0.78, range(rnd, -0.3, 0.3), c, 0.8);
      blob(g, x - r * 0.3, y - r * 0.32, r * 0.5, r * 0.32, 0, lightOf(c, 0.45), 0.5, 0.35);
    }
    // big scutes along the ridge of the back
    for (let x = 6; x < s; x += range(rnd, 14, 20)) { const r = range(rnd, 7, 10); blob(g, x + 2, 9, r * 1.1, r * 0.8, 0, '#16220f', 0.4, 0.3); ellipse(g, x, 6, r, r * 0.8, 0, '#4a7a3a'); blob(g, x - 2, 3, r * 0.5, r * 0.35, 0, '#8ab460', 0.6, 0.4); }
    // belly plates, uneven
    for (let y = s * 0.7; y < s; y += range(rnd, 11, 16)) {
      g.fillStyle = lin(g, 0, y, 0, y + 14, [[0, '#f4e6b4', 0.5], [0.4, '#d8c890', 0], [0.85, '#8a7a50', 0.3], [1, '#5a4a34', 0.45]]); g.fillRect(0, y, s, 14);
      for (let x = rnd() * 30; x < s; x += range(rnd, 24, 44)) line(g, [[x, y + 1], [x + range(rnd, -2, 2), y + 12]], 1.2, '#7a6a48', 0.35);
    }
    // chipped paint showing gray plaster, hairline cracks, grime streaks
    for (let i = 0; i < 22; i++) chips(g, rnd, 1, 4, 4, s - 8, s - 8, '#a49c90', 2, 7, 0.9);
    cracks(g, s, rnd, { color: '#2e3428', count: 6, len: [16, 44], width: [0.8, 1.4], alpha: 0.4 });
    streaks(g, s, rnd, { colors: ['#4a5a3a', '#6a5a40'], count: 12, len: [16, 50], width: [2, 4], angle: Math.PI, wobble: 0.1, alpha: 0.12 });
    glaze(g, s, s, '#ffe8b8', 0.1);
    blurTile(cv, 0.7);
  },
});

register('loot_eye', {
  family: F, size: 64, note: 'a reptile eye (front at the middle): amber iris, slit pupil, wet glint',
  paint(g, s, rnd, h, cv) {
    rect(g, 0, 0, s, s, '#2e4a28');
    g.fillStyle = radial(g, s / 2, s / 2, 1, s * 0.3, [[0, '#ffe070'], [0.6, '#e8a028'], [1, '#8a4a10']]); g.beginPath(); g.ellipse(s / 2, s / 2, s * 0.3, s * 0.28, 0, 0, TAU); g.fill();
    ellipse(g, s / 2, s / 2, 3, s * 0.22, 0, '#140c08');
    blob(g, s * 0.4, s * 0.38, 4, 3, 0, '#ffffff', 0.95, 0.5);
    g.save(); g.lineWidth = 3; g.strokeStyle = rgba('#1a2614', 0.8); g.beginPath(); g.ellipse(s / 2, s / 2, s * 0.31, s * 0.29, 0, 0, TAU); g.stroke(); g.restore();
  },
});
register('loot_ivory', {
  family: F, size: 64, note: 'ivory / old bone: teeth, key caps, tuning pegs',
  paint(g, s, rnd, h, cv) { g.fillStyle = lin(g, 0, 0, s * 0.4, s, [[0, '#fff8e8'], [0.5, '#e8dcc0'], [1, '#a89878']]); g.fillRect(0, 0, s, s); for (let i = 0; i < 6; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 4, 10), range(rnd, 3, 6), 0, '#c8b890', 0.35, 0.3); blurTile(cv, 0.5); },
});
register('loot_plaster', {
  family: F, size: 64, note: 'the broken neck seen face on: a rim of painted green, gray plaster, a hollow fiberglass dark inside',
  paint(g, s, rnd, h, cv) {
    const c = s / 2;
    rect(g, 0, 0, s, s, '#4a7a3c');
    g.fillStyle = radial(g, c, c, 2, c, [[0, '#2a2420'], [0.5, '#3a3430'], [0.62, '#8a8478'], [0.82, '#b8b0a2'], [0.92, '#a49c90'], [1, '#4a7a3c']]); g.beginPath(); g.arc(c, c, c, 0, TAU); g.fill();
    for (let k = 0; k < 14; k++) { const a = k / 14 * TAU + rnd() * 0.3; line(g, [[c + Math.cos(a) * c * 0.55, c + Math.sin(a) * c * 0.55], [c + Math.cos(a) * c * 0.85, c + Math.sin(a) * c * 0.85]], 1, '#6a645a', 0.6); }
    blurTile(cv, 0.4);
  },
});

// ---- trophy, register, toaster bits ----------------------------------------------------------------

register('loot_plaque', {
  family: F, w: 128, h: 32, note: 'two engraved brass plates: left "No.1" (the trophy), right "$ 25" (the till\'s tab)',
  paint(g, w, rnd, h, cv) {
    for (const [x0, txt] of [[0, 'No.1'], [w / 2, '$ 25']]) {
      g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#f0d488'], [0.5, '#c8a050'], [1, '#8a6628']]); g.fillRect(x0, 0, w / 2, h);
      g.save(); g.strokeStyle = rgba('#5a3a14', 0.8); g.lineWidth = 1.5; g.strokeRect(x0 + 3, 3, w / 2 - 6, h - 6); g.restore();
      g.save(); g.font = `bold 15px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = rgba('#fff4c8', 0.7); g.fillText(txt, x0 + w / 4 - 0.7, h / 2 - 0.2); g.fillStyle = '#4a2e10'; g.fillText(txt, x0 + w / 4, h / 2 + 0.6); g.restore();
    }
    blurTile(cv, 0.3);
  },
});

register('loot_till', {
  family: F, w: 256, h: 64, note: 'the cash drawer\'s front: a raised oak panel, a brass bail pull, a keyhole, CASH in faded gilt',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#6a4428');
    grain(g, 0, 0, w, h, rnd, { dark: ['#3e2616', '#4a2e1a'], lite: ['#8a6040', '#a07450'], n: 18, amp: 1.5, knots: 1 });
    bevel(g, 0, 0, w, h, '#6a4428', 6, 0.45, 0.55);
    g.save(); g.strokeStyle = rgba('#2a1a10', 0.7); g.lineWidth = 2; g.strokeRect(12, 10, w - 24, h - 20); g.strokeStyle = rgba('#b08a60', 0.5); g.lineWidth = 1.2; g.strokeRect(13.5, 11.5, w - 24, h - 20); g.restore();
    // the bail pull
    const cx = w / 2, cy = h / 2;
    for (const sx of [-1, 1]) { ellipse(g, cx + sx * 24 + 1, cy - 6 + 1, 6, 4.5, 0, '#2a1a08', 0.6); ellipse(g, cx + sx * 24, cy - 6, 5.5, 4, 0, '#d8b060'); }
    const bail = []; for (let k = 0; k <= 12; k++) { const a = Math.PI * k / 12; bail.push([cx - Math.cos(a) * 24, cy - 6 + Math.sin(a) * 14]); }
    line(g, bail.map(([x, y]) => [x + 1.2, y + 1.6]), 3.5, '#2a1a08', 0.5); line(g, bail, 3, '#c8a050', 1); line(g, bail.map(([x, y]) => [x - 0.6, y - 0.8]), 1, '#fff0b8', 0.8);
    // keyhole escutcheon
    ellipse(g, 40, cy, 8, 10, 0, '#c8a050'); ellipse(g, 40, cy - 2, 2.2, 2.2, 0, '#1a1008'); line(g, [[40, cy - 1], [40, cy + 5]], 2, '#1a1008');
    letters(g, 'CASH', w - 52, cy + 1, 15, { rnd, jit: 0.03, shadow: 0, track: 2, fill: ['#e8c870', '#b08a40'] });
    for (let i = 0; i < 10; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 3, 8), range(rnd, 2, 4), 0, '#a08060', 0.25, 0.3);
    blurTile(cv, 0.35);
  },
});

register('loot_toast', {
  family: F, size: 64, note: 'a slice of toast: dark crust round a golden crumb',
  paint(g, s, rnd, h, cv) {
    rect(g, 0, 0, s, s, '#6a3a18');
    rrect(g, 5, 5, s - 10, s - 10, 9, '#d8a050');
    g.fillStyle = radial(g, s / 2, s / 2, 4, s * 0.45, [[0, '#f0d090'], [0.7, '#d8a050'], [1, '#a86a2a']]); g.beginPath(); g.roundRect(6, 6, s - 12, s - 12, 8); g.fill();
    for (let i = 0; i < 22; i++) ellipse(g, range(rnd, 10, s - 10), range(rnd, 10, s - 10), range(rnd, 0.8, 2), range(rnd, 0.6, 1.4), rnd() * 3, '#a8703a', 0.6);
    blob(g, s * 0.45, s * 0.5, 14, 10, 0.4, '#8a4a1a', 0.35, 0.3);
    blurTile(cv, 0.4);
  },
});

register('loot_ball', {
  family: F, size: 64, note: 'a marbled purple bowling ball with its three finger holes',
  paint(g, s, rnd, h, cv) {
    rect(g, 0, 0, s, s, '#3a2a6a');
    for (let i = 0; i < 14; i++) { const pts = []; let x = rnd() * s, y = rnd() * s, a = rnd() * TAU; for (let k = 0; k < 8; k++) { pts.push([x, y]); a += range(rnd, -0.6, 0.6); x += Math.cos(a) * 6; y += Math.sin(a) * 6; } stroke(g, pts, range(rnd, 2, 5), 1, pick(rnd, ['#6a4aa8', '#8a6ac8', '#2a1a4a', '#4a8ac8']), 0.5); }
    for (const [x, y] of [[s * 0.42, s * 0.36], [s * 0.58, s * 0.36], [s * 0.5, s * 0.56]]) { ellipse(g, x, y, 3.6, 3.6, 0, '#0e0818'); line(g, [[x - 2.5, y + 2.5], [x + 2.5, y + 2.6]], 1, '#9a8ad8', 0.6); }
    blurTile(cv, 0.4);
  },
});
register('loot_rubber', {
  family: F, size: 64, note: 'dark rubber / black iron for slots, rods and sockets',
  paint(g, s, rnd, h, cv) { g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#4a4246'], [0.5, '#2a2428'], [1, '#18141a']]); g.fillRect(0, 0, s, s); for (let i = 0; i < 6; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 4, 10), range(rnd, 2, 5), 0, '#5a5258', 0.3, 0.3); blurTile(cv, 0.4); },
});
register('loot_parchment', {
  family: F, size: 64, note: 'parchment for the map\'s edges and the luggage tag',
  paint(g, s, rnd, h, cv) { fill(g, s, s, '#e4cc98'); mottle(g, s, rnd, { colors: ['#d8bc84', '#f0dcaa', '#c8a870'], count: 12, rmin: 6, rmax: 18, alpha: 0.4 }); blurTile(cv, 0.5); },
});
register('loot_tag', {
  family: F, size: 64, note: 'a parchment luggage tag with a big question mark',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e4cc98'); mottle(g, s, rnd, { colors: ['#d8bc84', '#f0dcaa', '#c8a870'], count: 10, rmin: 6, rmax: 16, alpha: 0.4 });
    ellipse(g, s / 2, 9, 4, 4, 0, '#8a6a40'); ellipse(g, s / 2, 9, 2.4, 2.4, 0, '#3a2a1a');
    g.save(); g.font = `bold 40px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#8a2a1e'; g.fillText('?', s / 2 + 1, s * 0.6 + 1); g.fillStyle = '#b8402a'; g.fillText('?', s / 2, s * 0.6); g.restore();
    bevel(g, 0, 0, s, s, '#e4cc98', 4, 0.3, 0.45); blurTile(cv, 0.4);
  },
});

// ---- the atlas -------------------------------------------------------------------------------------------

register('loot_atlas', {
  family: F, w: ATLAS_W, h: ATLAS_H, note: 'every loot piece in one texture (one draw call per prop): padded, dilated cells',
  paint(g, w, rnd, h) {
    g.fillStyle = '#5a4a40'; g.fillRect(0, 0, w, h);
    for (const R of Object.values(REGIONS)) {
      const src = canvasFor('loot_' + R.key);
      const cx = R.x + PAD, cy = R.y + PAD, cw = R.w - 2 * PAD, ch = R.h - 2 * PAD;
      g.save(); g.beginPath(); g.rect(R.x, R.y, R.w, R.h); g.clip();
      g.drawImage(src, R.x - PAD, R.y - PAD, R.w + 2 * PAD, R.h + 2 * PAD);    // dilate the edges into the padding
      if (R.wrap) { g.drawImage(src, cx - cw, cy, cw, ch); g.drawImage(src, cx + cw, cy, cw, ch); }
      g.drawImage(src, cx, cy, cw, ch);
      g.restore();
    }
  },
});

// What glows: lamp glass and bulb, lantern panes, the CRT (faint), the slot's bulbs and reel window.
register('loot_glow', {
  family: F, w: ATLAS_W / 4, h: ATLAS_H / 4, note: 'emissive mask for the loot atlas (quarter size)',
  paint(g, w, rnd, h) {
    g.fillStyle = '#000000'; g.fillRect(0, 0, w, h);
    const put = (key, alpha, sx = 0, sy = 0, sw = 1, sh = 1) => {
      const R = REGIONS[key], src = canvasFor('loot_' + key), S = src.width, T = src.height;
      const cx = (R.x + PAD) / 4, cy = (R.y + PAD) / 4, cw = (R.w - 2 * PAD) / 4, ch = (R.h - 2 * PAD) / 4;
      g.save(); g.globalAlpha = alpha;
      g.drawImage(src, sx * S, sy * T, sw * S, sh * T, cx + sx * cw, cy + sy * ch, sw * cw, sh * ch);
      g.restore();
    };
    put('glass', 0.42); put('lantern', 0.9); put('bulb', 1); put('screen', 0.18);
    put('slot', 0.35, 0, 0, 1, 0.2); put('slot', 0.22, 0.06, 0.24, 0.88, 0.28);
  },
});

// ---- boulders, one per biome ----------------------------------------------------------------------------

// The world's own rock (nature family) when it's there, with the zone's cover painted over the top.
const BOULDER = {
  meadow: { rock: 'rock_gray', base: '#7a776f', cols: ['#8e8a82', '#6a675f', '#9a958a'], ground: '#5a4a34' },
  fields: { rock: 'rock_warm', base: '#8a8170', cols: ['#9a9080', '#766e60', '#a49a86'], ground: '#8a6a44' },
  snow: { rock: 'rock_granite', base: '#6f7682', cols: ['#8e96a3', '#5e6470', '#7a828e'], ground: '#5a5650' },
  badlands: { rock: 'rock_red', base: '#a04a2a', cols: ['#b4552f', '#8e3e22', '#cf7a45'], ground: '#9a6a44' },
  desert: { rock: 'rock_sand', base: '#b7895e', cols: ['#d4ab7c', '#a87a50', '#c89a6a'], ground: '#c8a070' },
};
function boulderPaint(g, w, rnd, h, biome) {
  const B = BOULDER[biome];
  const Y = v => (1 - v) * h;
  if (has(B.rock)) {
    const src = canvasFor(B.rock);
    for (const dx of [0, src.width]) g.drawImage(src, 0, 0, src.width, src.height, dx * (w / 2 / src.width), 0, w / 2, h * 1.0);
  } else {
    fill(g, w, h, B.base);
  }
  // big facets: soft lit planes and cool shaded ones, so it reads as one chunky stone
  for (let i = 0; i < 22; i++) {
    const x = rnd() * w, y = range(rnd, 0.15, 0.85) * h, rx = range(rnd, 20, 60), ry = range(rnd, 14, 40), a = range(rnd, -0.5, 0.5);
    wrapX(w, x, rx * 1.5, X => {
      blob(g, X + rx * 0.3, y + ry * 0.35, rx, ry, a, shadowOf(B.base, 0.45), 0.22, 0.3);
      blob(g, X - rx * 0.2, y - ry * 0.25, rx * 0.8, ry * 0.7, a, lightOf(pick(rnd, B.cols), 0.25), 0.22, 0.3);
    });
  }
  // ledges: a lit lip over a shaded underside
  for (let i = 0; i < 9; i++) {
    const x = rnd() * w, y = range(rnd, 0.25, 0.7) * h, L = range(rnd, 40, 120), pts = [];
    for (let k = 0; k <= 8; k++) pts.push([x + L * k / 8, y + Math.sin(k * 0.8 + i) * 3]);
    wrapX(w, x + L / 2, L, X => { const p = pts.map(([u, v]) => [u - x - L / 2 + X, v]); line(g, p.map(([u, v]) => [u, v + 4]), 6, shadowOf(B.base, 0.6), 0.35); line(g, p, 2.5, lightOf(B.base, 0.5), 0.55); });
  }
  if (biome === 'badlands') {   // horizontal strata bands
    for (let y = 0; y < h; y += range(rnd, 10, 22)) { const c = pick(rnd, ['#8e3e22', '#b4552f', '#cf7a45', '#e3a066']); rect(g, 0, y, w, range(rnd, 4, 10), c, 0.28); line(g, [[0, y], [w, y]], 1.5, '#5a2a18', 0.3); }
  }
  if (biome === 'desert') { for (let y = 20; y < h; y += range(rnd, 18, 34)) line(g, [[0, y], [w, y + range(rnd, -3, 3)]], range(rnd, 2, 5), '#e8c898', 0.3); }
  cracks(g, w, rnd, { color: '#2a2030', count: 8, len: [20, 60], width: [1, 2], alpha: 0.45 });
  // the ground line: earth and grime at the bottom
  g.fillStyle = lin(g, 0, Y(0.2), 0, h, [[0, B.ground, 0], [0.6, B.ground, 0.45], [1, shadowOf(B.ground, 0.4), 0.8]]); g.fillRect(0, Y(0.2), w, h - Y(0.2));
  // the zone's cover on top: ragged lower edge, lit on top
  const edge = x => Y(0.68) + Math.sin(x / w * TAU * 3 + 1) * 10 + Math.sin(x / w * TAU * 7) * 5;
  const capPath = (e = 0) => { g.beginPath(); g.moveTo(0, 0); for (let x = 0; x <= w; x += 4) g.lineTo(x, edge(x) + e); g.lineTo(w, 0); g.closePath(); };
  if (biome === 'meadow' || biome === 'fields') {
    const dark = biome === 'meadow' ? ['#3e5e22', '#4a6e28'] : ['#8a7a34', '#9a8a3e'];
    const mid = biome === 'meadow' ? ['#5a8a2e', '#6a9a34'] : ['#b89a48', '#c8aa52'];
    const lit = biome === 'meadow' ? ['#8ab444', '#9cc04e'] : ['#e2c56a', '#ecd48a'];
    g.save(); capPath(6); g.fillStyle = rgba(shadowOf(B.base, 0.5), 0.35); g.fill(); g.restore();
    g.save(); capPath(); g.fillStyle = lin(g, 0, 0, 0, Y(0.68), [[0, lit[0]], [0.5, mid[0]], [1, dark[0]]]); g.fill(); g.clip();
    for (let i = 0; i < 70; i++) { const x = rnd() * w, y = rnd() * Y(0.6); wrapX(w, x, 16, X => blob(g, X, y, range(rnd, 6, 16), range(rnd, 4, 9), 0, pick(rnd, [...dark, ...mid, ...lit]), 0.5, 0.3)); }
    g.restore();
    for (let i = 0; i < 260; i++) { const x = rnd() * w, y = edge(x) + range(rnd, -4, 8); wrapX(w, x, 10, X => blade(g, X, y, range(rnd, 5, 12), range(rnd, -0.6, 0.6), range(rnd, 1.4, 2.4), pick(rnd, [...dark, ...mid]), 0.9, range(rnd, -0.3, 0.3))); }
    // grass and dirt at the foot too
    for (let i = 0; i < 160; i++) { const x = rnd() * w, y = h - range(rnd, 0, 8); wrapX(w, x, 12, X => blade(g, X, y, range(rnd, 6, 16), range(rnd, -0.5, 0.5), range(rnd, 1.4, 2.4), pick(rnd, [...dark, ...mid, ...lit]), 0.9, range(rnd, -0.3, 0.3))); }
    if (biome === 'fields') for (let i = 0; i < 26; i++) { const x = rnd() * w, y = range(rnd, 0.3, 0.7) * h; wrapX(w, x, 8, X => blob(g, X, y, range(rnd, 3, 7), range(rnd, 2, 5), 0, pick(rnd, ['#d89a3a', '#c8b04a', '#e8c060']), 0.6, 0.5)); }   // lichen
  } else if (biome === 'snow') {
    g.save(); capPath(8); g.fillStyle = rgba('#3a4a6a', 0.35); g.fill(); g.restore();
    g.save(); capPath(); g.fillStyle = lin(g, 0, 0, 0, Y(0.68), [[0, '#fbf8f0'], [0.6, '#e8eef4'], [1, '#bccbe0']]); g.fill(); g.clip();
    for (let i = 0; i < 40; i++) { const x = rnd() * w, y = rnd() * Y(0.6); wrapX(w, x, 20, X => blob(g, X, y, range(rnd, 10, 24), range(rnd, 4, 8), 0, pick(rnd, ['#cfdbe6', '#b8c8dc', '#ffffff']), 0.5, 0.3)); }
    g.restore();
    for (let i = 0; i < 18; i++) { const x = rnd() * w, y = edge(x); wrapX(w, x, 8, X => { const L = range(rnd, 6, 18); stroke(g, [[X, y - 2], [X + range(rnd, -1, 1), y + L]], range(rnd, 3, 6), 1, '#e8eef4', 0.85); }); }   // drips and drifts
    for (let i = 0; i < 30; i++) { const x = rnd() * w, y = range(rnd, 0.3, 0.6) * h; wrapX(w, x, 14, X => blob(g, X, y, range(rnd, 6, 14), range(rnd, 2, 4), 0, '#eef2f8', 0.7, 0.5)); }   // snow on the ledges
    g.fillStyle = lin(g, 0, Y(0.12), 0, h, [[0, '#e8eef4', 0], [1, '#dfe6ee', 0.8]]); g.fillRect(0, Y(0.12), w, h - Y(0.12));
  } else {
    const dust = biome === 'badlands' ? ['#cf9a62', '#b98457', '#e0ae74'] : ['#e8cc96', '#d9b87f', '#f2dcaa'];
    g.save(); capPath(); g.fillStyle = lin(g, 0, 0, 0, Y(0.68), [[0, dust[2], 0.95], [1, dust[0], 0.6]]); g.fill(); g.clip();
    for (let i = 0; i < 50; i++) { const x = rnd() * w, y = rnd() * Y(0.6); wrapX(w, x, 20, X => blob(g, X, y, range(rnd, 10, 26), range(rnd, 3, 7), 0, pick(rnd, dust), 0.45, 0.3)); }
    g.restore();
    for (let i = 0; i < 24; i++) { const x = rnd() * w, y = range(rnd, 0.25, 0.65) * h; wrapX(w, x, 14, X => blob(g, X, y, range(rnd, 8, 18), range(rnd, 2, 4), 0, dust[1], 0.55, 0.4)); }
    g.fillStyle = lin(g, 0, Y(0.16), 0, h, [[0, dust[0], 0], [1, dust[1], 0.85]]); g.fillRect(0, Y(0.16), w, h - Y(0.16));
  }
  glaze(g, w, h, '#ffe2b0', 0.1);
}
for (const b of Object.keys(BOULDER)) {
  register(`loot_boulder_${b}`, { family: F, w: 512, h: 256, note: `the road-blocking boulder, ${b} (u wraps round it; v ground → top)`, paint(g, w, rnd, h, cv) { boulderPaint(g, w, rnd, h, b); blurTile(cv, 0.4); } });
}
