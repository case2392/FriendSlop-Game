// Texture family: props (the loot you carry, throw and pawn). See docs/ART.md.
//
// Every loot piece is painted into ONE atlas, so each prop in the world is one mesh with one
// material: one draw call (plus its shadow). The pieces are registered on their own too, so the
// gallery shows each one (loot_<key>), and the atlas (loot_atlas) is composed from them 1:1 with
// 8 px of dilated padding round every cell (cells marked 'wrap' are padded with their own other
// edge, so lathes can wrap u round them without a seam). loot_glow is the matching emissive atlas
// (lamp glass, lantern panes, the CRT, the slot machine's bulbs), a quarter the size.
//
// Pieces (props3d.js maps geometry onto these through REGIONS):
//   wood turned iron safe safeback porcelain leather sign slot slotback slotside bulbs dino
//   gnomehat gnomecoat gnomebeard gnomeface gnomefur portrait gold rosette glass brass bronze gilt
//   tire rim screen steel red regdeck crest till plaque keys tvfront tvback strap fret guitar honey
//   ball eye ivory rubber parchment lantern skin boot plaster toast bulb tag
// Boulders (not in the atlas, they're 4 m wide): loot_boulder_<biome> (512×256, u wraps round
// the rock, v runs ground → top) is the stone; loot_cover_<biome> (alpha, seamless) is the moss /
// dry grass / snow / dust / sand that sits on its upward faces (a shell mesh, alpha-tested).
//
// Light comes from the upper left: lit cream edges, cool violet-brown shadows, never pure black.
// Lettering is painted, not typeset: jittered glyphs, a mottled fill, chipped gilt, an umber
// under-shadow and a few offset passes so the edges aren't vector-crisp.
import {
  register, canvasFor, has, makeCanvas, fill, mottle, streaks, cracks, glaze, blurTile, blob, ellipse, stroke,
  blade, range, pick, wrap, mix, lightOf, shadowOf, jitter, rgba, rngFrom,
} from './core.js';

const F = 'props';
const TAU = Math.PI * 2;
const INK = '#2a2030';
const FONT = `Georgia, 'Palatino Linotype', 'Book Antiqua', Palatino, 'Liberation Serif', 'DejaVu Serif', serif`;
const SANS = `'Arial Black', Impact, 'Helvetica Neue', Arial, 'Liberation Sans', 'DejaVu Sans', sans-serif`;

// ---- the atlas layout ----------------------------------------------------------------------------

// content sizes [w, h, 'wrap'?]: every cell is painted at exactly this size
const PIECES = {
  wood: [256, 256], iron: [256, 256], safe: [256, 256], safeback: [192, 192], porcelain: [256, 256, 'wrap'], leather: [256, 256],
  dino: [256, 256], sign: [512, 288], slot: [256, 512], slotback: [192, 384], slotside: [96, 192], bulbs: [512, 48],
  gnomehat: [128, 128, 'wrap'], gnomecoat: [256, 128, 'wrap'], gnomebeard: [128, 128, 'wrap'], gnomeface: [256, 128, 'wrap'], gnomefur: [128, 32, 'wrap'],
  portrait: [384, 288], gold: [1008, 64], rosette: [64, 64], glass: [512, 128, 'wrap'],
  brass: [256, 128, 'wrap'], bronze: [256, 128, 'wrap'], gilt: [256, 128, 'wrap'], tire: [256, 128, 'wrap'], turned: [128, 128, 'wrap'],
  rim: [128, 128], screen: [128, 128], steel: [128, 128], red: [128, 128], regdeck: [256, 128], crest: [192, 96],
  till: [256, 64], plaque: [256, 64], keys: [256, 64], tvfront: [256, 176], tvback: [256, 176],
  strap: [256, 24], fret: [256, 24], guitar: [160, 256], honey: [96, 256], ball: [128, 64, 'wrap'], eye: [128, 64, 'wrap'],
  ivory: [64, 64, 'wrap'], rubber: [64, 64, 'wrap'], parchment: [64, 64], lantern: [64, 64], skin: [64, 64, 'wrap'],
  boot: [64, 64, 'wrap'], plaster: [64, 64], toast: [64, 64], bulb: [64, 64], tag: [64, 64],
};
export const ATLAS_W = 1024, PAD = 8;
// skyline packing (tallest first, lowest spot, leftmost on ties): deterministic
function packAtlas(pieces, W) {
  const items = Object.entries(pieces).map(([key, [w, h, wr]]) => ({ key, cw: w, ch: h, w: w + 2 * PAD, h: h + 2 * PAD, wrap: wr === 'wrap' }));
  items.sort((a, b) => b.h - a.h || b.w - a.w || (a.key < b.key ? -1 : 1));
  const sky = new Int32Array(W), out = {};
  for (const it of items) {
    let best = null;
    for (let x = 0; x + it.w <= W; x += 8) {
      let y = 0; for (let i = x; i < x + it.w; i++) if (sky[i] > y) y = sky[i];
      if (!best || y < best.y) best = { x, y };
    }
    for (let i = best.x; i < best.x + it.w; i++) sky[i] = best.y + it.h;
    out[it.key] = { ...it, x: best.x, y: best.y };
  }
  let H = 0; for (const v of sky) H = Math.max(H, v);
  return { cells: out, H: Math.ceil(H / 16) * 16 };
}
const PACK = packAtlas(PIECES, ATLAS_W);
export const ATLAS_H = PACK.H;
// UV rect of each piece in the atlas: { u0, v0, u1, v1 } (v up, three.js convention).
export const REGIONS = Object.fromEntries(Object.values(PACK.cells).map(c => [c.key, {
  ...c, u0: (c.x + PAD) / ATLAS_W, u1: (c.x + PAD + c.cw) / ATLAS_W, v0: 1 - (c.y + PAD + c.ch) / ATLAS_H, v1: 1 - (c.y + PAD) / ATLAS_H,
}]));
// A sub-rect of a region, in the piece's own canvas fractions (x right, y DOWN, like the painting).
export function sub(R, fx0, fy0, fx1, fy1) {
  const du = R.u1 - R.u0, dv = R.v1 - R.v0;
  return { ...R, u0: R.u0 + du * fx0, u1: R.u0 + du * fx1, v0: R.v1 - dv * fy1, v1: R.v1 - dv * fy0 };
}

// ---- shapes shared with props3d.js so the paint lines up with the geometry ----------------------------

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
  return [...right, ...right.slice(1, -1).reverse().map(([x, y]) => [-x, y])];
})();
export const GUITAR_HOLE = { x: 0, y: 0.6, r: 0.16 };   // soundhole (r in widths)

// The CRT's front: where the screen and knobs sit, as fractions of the front face (u right, v up).
export const TV_LAYOUT = { screen: [0.08, 0.13, 0.69, 0.87], knobs: [[0.855, 0.83], [0.855, 0.69]] };

// The shop board's outline in meters (x across, y up from the bottom edge): a straight foot,
// coved shoulders and a domed crest. Painted and extruded from the same points.
export const SIGN = (() => {
  const W = 0.8, H = 0.45, side = 0.31, coveR = 0.04, crestW = 0.36;
  const right = [[0.4, 0.015], [0.4, side]];
  for (let k = 1; k <= 6; k++) { const a = -Math.PI / 2 - k / 6 * Math.PI / 2; right.push([0.4 + Math.cos(a) * coveR, side + coveR + Math.sin(a) * coveR]); }
  for (let k = 1; k <= 14; k++) { const x = crestW * (1 - k / 14); right.push([x, side + coveR + 0.1 * Math.pow(Math.max(0, 1 - (x / crestW) ** 2), 0.6)]); }
  const left = right.slice(0, -1).reverse().map(([x, y]) => [-x, y]);
  return { W, H, pts: [[-0.385, 0], [0.385, 0], ...right, ...left] };
})();

// The gnome: where the paint has to land on the lathes (props3d builds from the same numbers).
export const GNOME = {
  headR: 0.075, eyeX: 0.031, eyeY: 0.011,      // eye offsets from the head's center
  belt: [0.36, 0.44],                           // the coat lathe's v range of the belt
  crease: 0.6, bendU: 0.69,                     // the hat's fold (v) and which way it flops (u)
};
const gnomeEye = (() => { const r = GNOME.headR, rr = Math.sqrt(r * r - GNOME.eyeY ** 2); return { du: Math.asin(GNOME.eyeX / rr) / TAU, v: Math.acos(-GNOME.eyeY / r) / Math.PI }; })();

// The slot machine's arched crown (meters): half width, the height of its straight sides, its top.
// The marquee paintings (top of loot_slot and loot_slotback) follow the same arch.
export const SLOT_CROWN = { hw: 0.3, side: 0.1, top: 0.255 };

// The register's key caps, left → right, top row then bottom row (8 × 2 in loot_keys).
export const KEY_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '5¢', '10¢', '25¢', '50¢', '$1', '$5'];

export const TIRE_V = { treadLo: 0.38, treadHi: 0.62, wallLo: [0.1, 0.2], wallHi: [0.8, 0.9] };

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
function tinted(src, color, alpha = 1) {
  const c = makeCanvas(src.width, src.height), cg = c.getContext('2d');
  cg.drawImage(src, 0, 0); cg.globalCompositeOperation = 'source-in'; cg.fillStyle = rgba(color, alpha); cg.fillRect(0, 0, c.width, c.height);
  return c;
}
// Offset a closed polygon by d px (d > 0 grows it), along each corner's bisector.
function offsetPoly(pts, d) {
  let area = 0; for (let i = 0; i < pts.length; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length]; area += ax * by - bx * ay; }
  const sg = area > 0 ? -1 : 1, n = pts.length;
  return pts.map((p, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[(i + 1) % n];
    const e1 = [p[0] - a[0], p[1] - a[1]], e2 = [b[0] - p[0], b[1] - p[1]];
    const l1 = Math.hypot(...e1) || 1, l2 = Math.hypot(...e2) || 1;
    const n1 = [e1[1] / l1 * sg, -e1[0] / l1 * sg], n2 = [e2[1] / l2 * sg, -e2[0] / l2 * sg];
    let nx = n1[0] + n2[0], ny = n1[1] + n2[1]; const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
    const k = Math.max(0.5, nx * n1[0] + ny * n1[1]);
    return [p[0] + nx * d / k, p[1] + ny * d / k];
  });
}

// A carved molding following a closed outline: bands inset d0..d1 (outer half) and d1..d2 (inner
// half), each stretch lit or shaded by which way it faces the upper-left light.
function pathMolding(g, out, base, d0 = 3, d1 = 12, d2 = 21) {
  const o0 = offsetPoly(out, -d0), o1 = offsetPoly(out, -d1), o2 = offsetPoly(out, -d2);
  const L = lightOf(base, 0.7), D = shadowOf(base, 0.6);
  let area = 0; for (let i = 0; i < out.length; i++) { const [ax, ay] = out[i], [bx, by] = out[(i + 1) % out.length]; area += ax * by - bx * ay; }
  const sg = area > 0 ? -1 : 1;
  for (let i = 0; i < out.length; i++) {
    const j = (i + 1) % out.length;
    const ex = out[j][0] - out[i][0], ey = out[j][1] - out[i][1], el = Math.hypot(ex, ey) || 1;
    const nx = ey / el * sg, ny = -ex / el * sg;
    const lit = Math.max(-1, Math.min(1, -(nx * 0.7 + ny * 0.7) * 1.2));
    const outer = lit > 0 ? mix(base, L, lit) : mix(base, D, -lit), inner = lit > 0 ? mix(base, D, lit * 0.8) : mix(base, L, -lit * 0.8);
    g.save(); g.fillStyle = outer; poly(g, [o0[i], o0[j], o1[j], o1[i]]); g.fill(); g.lineWidth = 1; g.strokeStyle = outer; g.stroke();
    g.fillStyle = inner; poly(g, [o1[i], o1[j], o2[j], o2[i]]); g.fill(); g.strokeStyle = inner; g.stroke(); g.restore();
  }
  line(g, [...o2, o2[0]], Math.max(1, (d2 - d1) * 0.2), shadowOf(base, 0.8), 0.55);
}

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
// A raised, carved molding round a rect: every side lit on its upper-left half, shaded on its lower-right half.
function molding(g, x, y, w, h, c, k = 8, alpha = 1) {
  const L = lightOf(c, 0.75), D = shadowOf(c, 0.6);
  const sides = [
    [[[x, y], [x + w, y], [x + w - k, y + k], [x + k, y + k]], [x, y, x, y + k]],
    [[[x, y], [x + k, y + k], [x + k, y + h - k], [x, y + h]], [x, y, x + k, y]],
    [[[x, y + h], [x + k, y + h - k], [x + w - k, y + h - k], [x + w, y + h]], [x, y + h - k, x, y + h]],
    [[[x + w, y], [x + w, y + h], [x + w - k, y + h - k], [x + w - k, y + k]], [x + w - k, y, x + w, y]],
  ];
  g.save(); g.globalAlpha *= alpha;
  for (const [pts, gr] of sides) { poly(g, pts); g.fillStyle = lin(g, ...gr, [[0, L], [0.4, c], [0.62, c], [1, D]]); g.fill(); }
  g.restore();
  line(g, [[x, y + h], [x, y], [x + w, y]], 1, lightOf(c, 1), 0.45 * alpha);
  line(g, [[x + k, y + h - k], [x + w - k, y + h - k], [x + w - k, y + k]], 1, lightOf(c, 0.8), 0.3 * alpha);
  line(g, [[x, y + h], [x + w, y + h], [x + w, y]], 1.4, shadowOf(c, 0.85), 0.55 * alpha);
}
function rivet(g, x, y, r, c) {
  blob(g, x + r * 0.45, y + r * 0.6, r * 1.6, r * 1.35, 0, '#1a1418', 0.5, 0.3);
  ellipse(g, x, y, r, r, 0, shadowOf(c, 0.2));
  blob(g, x - r * 0.15, y - r * 0.2, r * 0.85, r * 0.8, 0, c, 0.9, 0.5);
  blob(g, x - r * 0.35, y - r * 0.4, r * 0.55, r * 0.45, 0, lightOf(c, 0.8), 0.9, 0.4);
}
// a run of rust or grime trickling down from (x, y)
function run(g, x, y, len, w, color, alpha, rnd) {
  const pts = []; let xx = x;
  for (let k = 0; k <= 6; k++) { pts.push([xx, y + len * k / 6]); xx += range(rnd, -0.7, 0.7); }
  stroke(g, pts, w, w * 0.2, color, alpha);
  stroke(g, pts.slice(0, 4).map(([a, b]) => [a + w * 0.15, b]), w * 0.45, w * 0.15, shadowOf(color, 0.4), alpha * 0.6);
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

// Hand-painted lettering. The glyphs are jittered into a mask; the fill is a base color with a
// lit blotch high on every letter and shade low, mottles and brush drags, gilt chipped away; it
// goes down over an umber under-shadow (down-right), a dark rim and a lit rim, in a few slightly
// offset passes so the edges are soft and uneven. Optional board-colored strokes drag across it.
function letters(g, text, x, y, size, { fill: fc = ['#f4d47a', '#cf9f42', '#8a5a1e'], rim = '#2a1a10', lit = '#fff0c0', shadow = 0.55, font = FONT, weight = 'bold',
  jit = 0.04, rnd = null, track = 0, maxW = 1e9, chip = 1, board = null, rough = 1 } = {}) {
  const r = rnd || rngFrom(text + size);
  const mk = makeCanvas(4, 4).getContext('2d');
  mk.font = `${weight} ${size}px ${font}`;
  let widths = [...text].map(ch => mk.measureText(ch).width + track);
  let tot = widths.reduce((a, b) => a + b, 0) - track;
  if (tot > maxW) { const k = maxW / tot; size *= k; mk.font = `${weight} ${size}px ${font}`; widths = [...text].map(ch => mk.measureText(ch).width + track * k); tot = maxW; }
  const pad = Math.ceil(size * 0.35 + 6), MW = Math.ceil(tot + pad * 2), MH = Math.ceil(size * 1.5 + pad * 2);
  const M = makeCanvas(MW, MH), mg = M.getContext('2d');
  mg.font = `${weight} ${size}px ${font}`; mg.textBaseline = 'middle'; mg.textAlign = 'center'; mg.fillStyle = '#ffffff';
  const glyphs = []; let cx = pad;
  for (const [i, ch] of [...text].entries()) { glyphs.push({ ch, x: cx + widths[i] / 2, y: MH / 2 + (r() - 0.5) * size * jit, rot: (r() - 0.5) * jit * 2 }); cx += widths[i]; }
  for (const q of glyphs) { mg.save(); mg.translate(q.x, q.y); mg.rotate(q.rot); mg.fillText(q.ch, 0, 0); mg.restore(); }
  const C = makeCanvas(MW, MH), cg = C.getContext('2d');
  cg.drawImage(M, 0, 0); cg.globalCompositeOperation = 'source-in'; cg.fillStyle = fc[1]; cg.fillRect(0, 0, MW, MH);
  cg.globalCompositeOperation = 'source-atop';
  const top = MH / 2 - size * 0.42, bot = MH / 2 + size * 0.42;
  for (const q of glyphs) {
    blob(cg, q.x - size * 0.1, top + size * 0.18, size * 0.42, size * 0.22, (r() - 0.5) * 0.4, fc[0], 0.85, 0.25);
    blob(cg, q.x + size * 0.12, bot - size * 0.08, size * 0.45, size * 0.2, (r() - 0.5) * 0.4, fc[2], 0.7, 0.25);
  }
  for (let i = 0; i < text.length * 4; i++) blob(cg, pad + r() * tot, top + r() * (bot - top), range(r, 2, Math.max(3, size * 0.18)), range(r, 1.5, Math.max(2, size * 0.1)), r() * 3, pick(r, fc), 0.3, 0.2);
  for (let i = 0; i < text.length * 3; i++) { const yy = top + r() * (bot - top), xx = pad + r() * tot, L = range(r, size * 0.2, size * 0.6); line(cg, [[xx, yy], [xx + L, yy + (r() - 0.5) * 2]], range(r, 0.6, 1.4), pick(r, [fc[0], fc[2]]), 0.35); }
  cg.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < Math.round(text.length * 3 * chip); i++) {
    const xx = pad + r() * tot, yy = top + r() * (bot - top), rr = range(r, 0.7, Math.max(1.3, size * 0.045));
    const pts = []; for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; pts.push([xx + Math.cos(a) * rr * range(r, 0.5, 1.3), yy + Math.sin(a) * rr * range(r, 0.5, 1.3)]); }
    poly(cg, pts); cg.fillStyle = '#000'; cg.fill();
  }
  cg.globalCompositeOperation = 'source-over';
  const ox = x - MW / 2, oy = y - MH / 2, s = Math.max(0.8, size / 28);
  if (shadow) { g.save(); g.filter = `blur(${(s * 1.2).toFixed(1)}px)`; g.globalAlpha = shadow; g.drawImage(tinted(M, '#3a2010'), ox + 2 * s, oy + 2 * s); g.restore(); }
  g.save(); g.globalAlpha = 0.95; g.drawImage(tinted(M, rim), ox + s, oy + s * 1.1); g.restore();
  g.save(); g.globalAlpha = 0.55; g.drawImage(tinted(M, lit), ox - s * 0.7, oy - s * 0.8); g.restore();
  if (rough) for (let k = 0; k < 3; k++) { g.save(); g.globalAlpha = 0.35; g.drawImage(C, ox + (r() - 0.5) * 1.2 * rough, oy + (r() - 0.5) * 1.2 * rough); g.restore(); }
  g.drawImage(C, ox, oy);
  if (board) for (let i = 0; i < text.length * 2; i++) { const yy = y + (r() - 0.5) * size * 0.8, xx = x - tot / 2 + r() * tot, L = range(r, size * 0.3, size * 0.8); stroke(g, [[xx, yy], [xx + L, yy + (r() - 0.5) * 3]], range(r, 1.5, 3), 0.8, board, 0.15); }
  return { size, width: tot };
}
// Sprayed stencil lettering: blocky glyphs with bridges cut through the round ones, overspray, worn flecks.
function stencil(g, text, x, y, size, color, rnd, { alpha = 0.8, track = 2, maxW = 1e9, rot = 0 } = {}) {
  const mk = makeCanvas(4, 4).getContext('2d');
  mk.font = `bold ${size}px ${SANS}`;
  let tot = mk.measureText(text).width + track * (text.length - 1);
  if (tot > maxW) { size *= maxW / tot; mk.font = `bold ${size}px ${SANS}`; tot = maxW; }
  const pad = Math.ceil(size * 0.5 + 4), MW = Math.ceil(tot + pad * 2), MH = Math.ceil(size * 1.6 + pad);
  const M = makeCanvas(MW, MH), mg = M.getContext('2d');
  mg.font = `bold ${size}px ${SANS}`; mg.textBaseline = 'middle'; mg.textAlign = 'left'; mg.fillStyle = '#fff';
  let cx = pad;
  const cuts = [];
  for (const ch of text) { const w = mg.measureText(ch).width; mg.fillText(ch, cx, MH / 2); if ('OQDBPRAG0689C'.includes(ch)) cuts.push(cx + w * 0.5); cx += w + track; }
  mg.globalCompositeOperation = 'destination-out';
  for (const c of cuts) mg.fillRect(c - Math.max(1, size * 0.04), MH / 2 - size * 0.7, Math.max(2, size * 0.08), size * 0.5);
  for (let i = 0; i < text.length * 5; i++) ellipse(mg, rnd() * MW, MH / 2 + (rnd() - 0.5) * size, range(rnd, 0.6, 1.8), range(rnd, 0.5, 1.4), rnd() * 3, '#000');
  g.save(); g.translate(x, y); g.rotate(rot);
  g.save(); g.filter = 'blur(2px)'; g.globalAlpha = alpha * 0.28; g.drawImage(tinted(M, color), -MW / 2, -MH / 2); g.restore();
  g.globalAlpha = alpha; g.drawImage(tinted(M, color), -MW / 2, -MH / 2);
  g.restore();
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
// A painterly pass: re-lay the picture as short brush strokes picked from its own colors, along a flow.
function brushify(g, w, h, rnd, { n = 1200, len = [3, 8], wid = [1.2, 2.6], alpha = 0.45, flow = () => 0 } = {}) {
  const D = g.getImageData(0, 0, w, h).data;
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, k = ((y | 0) * w + (x | 0)) * 4;
    const c = `rgb(${D[k]},${D[k + 1]},${D[k + 2]})`, a = flow(x, y) + (rnd() - 0.5) * 0.5, L = range(rnd, len[0], len[1]);
    line(g, [[x - Math.cos(a) * L / 2, y - Math.sin(a) * L / 2], [x + Math.cos(a) * L / 2, y + Math.sin(a) * L / 2]], range(rnd, wid[0], wid[1]), c, alpha);
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
// worn paint along a rect's border: lighter bare metal (or wood) showing through
function edgeWear(g, x, y, w, h, rnd, color, n = 30, band = 9) {
  for (let i = 0; i < n; i++) {
    const side = Math.floor(rnd() * 4), t = rnd();
    const px = side === 0 || side === 2 ? x + t * w : side === 1 ? x + w - rnd() * band : x + rnd() * band;
    const py = side === 1 || side === 3 ? y + t * h : side === 0 ? y + rnd() * band : y + h - rnd() * band;
    chips(g, rnd, 1, px - 1, py - 1, 2, 2, color, 1.2, 4, 0.7);
  }
}
// a gold coin with a goblin "G", lit from the upper left
function coin(g, x, y, r, rnd) {
  ellipse(g, x + r * 0.08, y + r * 0.12, r * 1.04, r * 1.04, 0, '#3a2410', 0.6);
  ellipse(g, x, y, r, r, 0, '#b8862e');
  for (let k = 0; k < 28; k++) { const a = k / 28 * TAU; line(g, [[x + Math.cos(a) * r * 0.86, y + Math.sin(a) * r * 0.86], [x + Math.cos(a) * r * 0.98, y + Math.sin(a) * r * 0.98]], Math.max(0.8, r * 0.05), '#7a5418', 0.6); }
  g.save(); g.fillStyle = radial(g, x - r * 0.3, y - r * 0.3, r * 0.05, r * 0.85, [[0, '#fff0b0'], [0.45, '#e0b050'], [1, '#a87828']]); g.beginPath(); g.arc(x, y, r * 0.8, 0, TAU); g.fill(); g.restore();
  letters(g, 'G', x, y + r * 0.04, r * 1.05, { fill: ['#c89a40', '#a8782a', '#7a5018'], rim: '#5a3a10', lit: '#fff4c8', shadow: 0, jit: 0, rnd, chip: 0.3, rough: 0.3 });
  blob(g, x - r * 0.38, y - r * 0.42, r * 0.3, r * 0.18, -0.6, '#fffbe8', 0.75, 0.35);
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

register('loot_turned', {
  family: F, size: 128, note: 'turned dark oak for lathes (u wraps): grain along v, lathe rings, a waxed sheen',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a3a24');
    for (let i = 0; i < 16; i++) { const x = rnd() * s, y = rnd() * s, rx = range(rnd, 8, 20), ry = range(rnd, 20, 50), c = pick(rnd, ['#6c4628', '#4a2e1c', '#7a5232']); wrap(s, x, y, ry, (X, Y) => blob(g, X, Y, rx, ry, 0, c, 0.35, 0.1)); }
    for (let i = 0; i < 40; i++) {
      const x = rnd() * s, w = range(rnd, 0.6, 1.6), c = rnd() < 0.65 ? pick(rnd, ['#3a2416', '#2e1c14']) : pick(rnd, ['#86603e', '#946a44']), p = rnd() * TAU;
      const pts = []; for (let y = -4; y <= s + 4; y += 4) pts.push([x + Math.sin(y / s * TAU * 2 + p) * 2, y]);
      wrapX(s, x, 4, X => line(g, pts.map(([a, b]) => [a - x + X, b]), w, c, 0.4));
    }
    for (let i = 0; i < 6; i++) { const y = rnd() * s; line(g, [[0, y], [s, y]], range(rnd, 0.8, 1.6), '#2e1c14', 0.35); line(g, [[0, y - 1.2], [s, y - 1.2]], 0.8, '#a07850', 0.3); }
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#fff0d0', 0.12], [0.3, '#fff0d0', 0], [0.8, '#1a0e08', 0], [1, '#1a0e08', 0.15]]); g.fillRect(0, 0, s, s);
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

// riveted iron: green-black lacquer, worn to bare metal at the edges, rust running down from the rivets
function ironPlate(g, s, rnd, { base = '#3c4842', door = false, rivets = 9 } = {}) {
  fill(g, s, s, base);
  mottle(g, s, rnd, { colors: ['#4a5850', '#323c38', '#56625a', '#3a4440'], count: 26, rmin: s * 0.08, rmax: s * 0.3, alpha: 0.4, hard: 0.1 });
  g.save(); g.fillStyle = radial(g, s * 0.42, s * 0.4, s * 0.25, s * 0.75, [[0, '#5c6058', 0], [1, '#5c6058', 0.4]]); g.fillRect(0, 0, s, s); g.restore();
  // the raised border band with rivets
  const b = Math.round(s * 0.06);
  molding(g, b - 6, b - 6, s - 2 * b + 12, s - 2 * b + 12, '#46524c', 12, 0.95);
  const n = rivets, pts = [];
  for (let k = 0; k < n; k++) { const t = b + (s - 2 * b) * k / (n - 1); pts.push([t, b], [t, s - b], [b, t], [s - b, t]); }
  for (const [x, y] of pts) rivet(g, x, y, s * 0.014, '#6a726c');
  // gold pinstripe, hand drawn
  const pin = (o, a, wdt) => { const q = [[b + o, b + o], [s - b - o, b + o], [s - b - o, s - b - o], [b + o, s - b - o], [b + o, b + o]].map(([x, y]) => [x + (rnd() - 0.5) * 1.2, y + (rnd() - 0.5) * 1.2]); line(g, q, wdt, '#c8a050', a); };
  pin(s * 0.055, 0.75, 1.6); pin(s * 0.072, 0.35, 1);
  // worn edges: chips of bare gray-green metal
  edgeWear(g, 0, 0, s, s, rnd, '#6a7a70', door ? 26 : 40, s * 0.035);
  if (!door) chips(g, rnd, 6, s * 0.15, s * 0.15, s * 0.7, s * 0.7, '#5a6660', 1.5, 4, 0.4);
  // rust: runs down from rivets and from the top edge, a stain where it pools at the bottom
  for (const [x, y] of pts) if (rnd() < 0.35) run(g, x + range(rnd, -1, 1), y + 3, range(rnd, 10, 40), range(rnd, 2.2, 3.6), '#8a4a22', 0.32, rnd);
  for (let i = 0; i < 10; i++) run(g, rnd() * s, range(rnd, 0, 4), range(rnd, 12, s * 0.35), range(rnd, 2, 5), '#8a4a22', 0.26, rnd);
  g.fillStyle = lin(g, 0, s * 0.82, 0, s, [[0, '#7a4428', 0], [1, '#7a4428', 0.3]]); g.fillRect(0, s * 0.82, s, s * 0.18);
  blob(g, s * 0.3, s * 0.28, s * 0.35, s * 0.25, -0.5, '#fff1c4', 0.08, 0.1);
  bevel(g, 0, 0, s, s, base, 10, 0.4, 0.55);
}
register('loot_iron', {
  family: F, size: 256, note: "the Rusty Safe's body: green-black lacquered iron, rivet border, gold pinstripe, worn edges, rust runs",
  paint(g, s, rnd, h, cv) { ironPlate(g, s, rnd); glaze(g, s, s, '#ffe8c0', 0.08); blurTile(cv, 0.4); },
});
register('loot_safe', {
  family: F, size: 256, note: "the safe door: pinstripes, corner scrolls, the maker's plate, the dial's number ring",
  paint(g, s, rnd, h, cv) {
    ironPlate(g, s, rnd, { base: '#34403a', door: true });
    for (const [x, y, sx, sy] of [[44, 44, 1, 1], [s - 44, 44, -1, 1], [44, s - 44, 1, -1], [s - 44, s - 44, -1, -1]]) {
      const pts = []; for (let k = 0; k <= 14; k++) { const a = k / 14 * TAU * 0.85, r = 3 + k * 0.9; pts.push([x + sx * Math.cos(a) * r, y + sy * Math.sin(a) * r]); }
      line(g, pts, 2.2, '#2a1a10', 0.5); line(g, pts.map(([u, v]) => [u - 0.7, v - 0.7]), 1.6, '#d8b060', 0.85);
    }
    // the maker's plate: a cast brass cartouche
    rrect(g, 62, 30, 132, 38, 9, '#2a1a10', 0.5);
    rrect(g, 60, 28, 132, 38, 9, '#8a6628');
    molding(g, 60, 28, 132, 38, '#b08a40', 5);
    rect(g, 66, 34, 120, 26, '#5a4018', 0.55);
    letters(g, 'GOBLIN & SONS', 126, 42, 14, { rnd, jit: 0.03, shadow: 0.4, maxW: 112, fill: ['#f8e090', '#d8a848', '#9a6a24'] });
    letters(g, 'VAULT CO.', 126, 56, 9, { rnd, jit: 0.03, shadow: 0, maxW: 60, fill: ['#f0d080', '#c8983c', '#8a5a1e'], rough: 0.5 });
    // the dial's number ring (the dial itself is brass geometry at the center)
    const cx = s / 2, cy = s / 2;
    ellipse(g, cx + 2, cy + 3, 60, 60, 0, '#141a16', 0.45);
    ellipse(g, cx, cy, 56, 56, 0, '#2c3430', 0.95);
    g.save(); g.fillStyle = radial(g, cx - 14, cy - 16, 4, 58, [[0, '#56605a', 0.6], [1, '#2c3430', 0]]); g.beginPath(); g.arc(cx, cy, 56, 0, TAU); g.fill(); g.restore();
    for (let k = 0; k < 40; k++) {
      const a = k / 40 * TAU + (rnd() - 0.5) * 0.01, r0 = k % 5 ? 47 : 42;
      line(g, [[cx + Math.cos(a) * r0, cy + Math.sin(a) * r0], [cx + Math.cos(a) * 53, cy + Math.sin(a) * 53]], k % 5 ? 1.1 : 2, '#d8b060', 0.8);
    }
    blob(g, cx - 18, cy - 22, 30, 16, -0.6, '#fff1c4', 0.08, 0.2);
    glaze(g, s, s, '#ffe8c0', 0.08); blurTile(cv, 0.45);
  },
});
register('loot_safeback', {
  family: F, size: 192, note: "the safe's back: the same iron, a shipping stencil sprayed on (FRAGILE? NO.)",
  paint(g, s, rnd, h, cv) {
    ironPlate(g, s, rnd, { base: '#38443e', rivets: 7 });
    stencil(g, 'FRAGILE?', s / 2, s * 0.4, 28, '#d8cfb0', rnd, { maxW: s * 0.66, rot: -0.04, alpha: 0.62 });
    stencil(g, 'NO.', s / 2, s * 0.62, 36, '#d8cfb0', rnd, { rot: -0.03, alpha: 0.66 });
    // an arrow pointing the wrong way, and rust running back over the paint
    stroke(g, [[s * 0.77, s * 0.32], [s * 0.77, s * 0.7]], 5, 5, '#c8bf9e', 0.6);
    poly(g, [[s * 0.72, s * 0.32], [s * 0.82, s * 0.32], [s * 0.77, s * 0.24]]); g.save(); g.globalAlpha = 0.6; g.fillStyle = '#c8bf9e'; g.fill(); g.restore();
    for (let i = 0; i < 6; i++) run(g, range(rnd, s * 0.2, s * 0.8), range(rnd, s * 0.25, s * 0.45), range(rnd, 14, 40), range(rnd, 2, 3.5), '#8a4a22', 0.3, rnd);
    glaze(g, s, s, '#ffe8c0', 0.08); blurTile(cv, 0.45);
  },
});

register('loot_leather', {
  family: F, size: 256, note: 'trunk leather: oxblood-brown hide, creases, scuffs, a stitched welt round the border',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7a4428');
    mottle(g, s, rnd, { colors: ['#8a5230', '#683a20', '#965e38', '#5e321c'], count: 44, rmin: 14, rmax: 60, alpha: 0.38, hard: 0.12 });
    for (let i = 0; i < 46; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 8, 30), a = rnd() * TAU, bend = range(rnd, -0.5, 0.5);
      const pts = []; for (let k = 0; k <= 5; k++) { const t = k / 5; pts.push([x + Math.cos(a + bend * t) * L * t, y + Math.sin(a + bend * t) * L * t]); }
      stroke(g, pts.map(([u, v]) => [u - 0.8, v - 1]), range(rnd, 1, 2), 0.4, '#b07a50', 0.22);
      stroke(g, pts, range(rnd, 1, 2.2), 0.4, '#3e2214', 0.32);
    }
    for (let i = 0; i < 14; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 6, 20), range(rnd, 3, 8), rnd() * 3, '#b48a64', 0.2, 0.3);
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

// ---- metals (lathe swatches wrap in u; v runs up the profile) ------------------------------------------

register('loot_brass', {
  family: F, w: 256, h: 128, note: 'polished brass (u wraps, v up): a bright reflected band high, a dark band low, brushing, patina, dings',
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#8a6628'], [0.12, '#e0c068'], [0.24, '#f8e49a'], [0.34, '#c8a050'], [0.56, '#8a6628'], [0.72, '#6a4c1e'], [0.86, '#b08a40'], [1, '#7a5a24']]);
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 22; i++) { const x = rnd() * w, y = rnd() * h, r = range(rnd, 10, 40), c = pick(rnd, ['#c8a050', '#8a6a2c', '#e0c070']); wrapX(w, x, r * 3, X => blob(g, X, y, r * 3, r * 0.6, 0, c, 0.25, 0.1)); }
    for (let i = 0; i < 80; i++) { const x = rnd() * w, y = rnd() * h, L = range(rnd, 20, 90), wd = range(rnd, 0.6, 1.3), c = rnd() < 0.5 ? '#f4dc90' : '#6a4e1e', dy = rnd() - 0.5; wrapX(w, x, L, X => line(g, [[X - L / 2, y], [X + L / 2, y + dy]], wd, c, 0.22)); }
    for (let i = 0; i < 10; i++) { const x = rnd() * w, y = h * range(rnd, 0.55, 1), rx = range(rnd, 2, 7), ry = range(rnd, 2, 5), c = pick(rnd, ['#5a8a6a', '#6a9a78']); wrapX(w, x, 10, X => blob(g, X, y, rx, ry, 0, c, 0.32, 0.3)); }
    for (let i = 0; i < 7; i++) { const x = rnd() * w, y = h * range(rnd, 0.18, 0.3), rx = range(rnd, 10, 26), ry = range(rnd, 2, 4); wrapX(w, x, 30, X => blob(g, X, y, rx, ry, 0, '#fff6cc', 0.45, 0.3)); }
    for (let i = 0; i < 6; i++) { const x = rnd() * w, y = rnd() * h; wrapX(w, x, 6, X => { blob(g, X + 1, y + 1, 4, 2.5, 0, '#4a3410', 0.3, 0.3); blob(g, X - 1, y - 1, 3, 2, 0, '#fff0b8', 0.3, 0.3); }); }
    blurTile(cv, 0.4);
  },
});

register('loot_bronze', {
  family: F, w: 256, h: 128, note: 'cast bronze (u wraps, v up): umber-bronze, warm lit ridges, green patina settled in the low bands',
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#9a7842'], [0.2, '#c49a52'], [0.35, '#8a6a3a'], [0.6, '#7a5a30'], [0.8, '#8a6a3a'], [1, '#5a4224']]);
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) { const x = rnd() * w, y = rnd() * h, r = range(rnd, 8, 30), c = pick(rnd, ['#a07a40', '#6a4c26', '#b08a4a']); wrapX(w, x, r * 2, X => blob(g, X, y, r * 2, r * 0.7, 0, c, 0.3, 0.1)); }
    // patina: verdigris in blotches and runs, heavier low
    for (let i = 0; i < 40; i++) { const x = rnd() * w, y = h * Math.pow(rnd(), 0.6), rx = range(rnd, 3, 12), ry = range(rnd, 2, 6), c = pick(rnd, ['#5a7a5a', '#6a8a6a', '#4a6a52']); wrapX(w, x, rx, X => blob(g, X, y, rx, ry, 0, c, 0.45, 0.3)); }
    for (let i = 0; i < 12; i++) { const x = rnd() * w, y = rnd() * h * 0.6, L = range(rnd, 8, 30); wrapX(w, x, 4, X => run(g, X, y, L, range(rnd, 1.5, 3), '#5a7a5a', 0.3, rnd)); }
    for (let i = 0; i < 9; i++) { const x = rnd() * w, y = h * range(rnd, 0.12, 0.3), rx = range(rnd, 10, 30); wrapX(w, x, 32, X => blob(g, X, y, rx, 2.5, 0, '#f0d090', 0.45, 0.3)); }
    blurTile(cv, 0.45);
  },
});

register('loot_gilt', {
  family: F, w: 256, h: 128, note: "the trophy's gilt (u wraps; v up the cup's profile): foot, stem knot, a warm bowl with a cream highlight band, a bright lip, an umber inside",
  paint(g, w, rnd, h, cv) {
    const Y = v => (1 - v) * h;
    g.fillStyle = lin(g, 0, Y(1), 0, Y(0), [
      [0, '#3a2408'], [0.1, '#5a3a10'], [0.14, '#8a6020'],      // inside (v 1 → 0.86): umber shadow
      [0.15, '#fff0b0'], [0.18, '#e8c060'],                     // the lip
      [0.25, '#b8862e'], [0.34, '#fff0b0'], [0.4, '#f0d070'],   // the upper bowl's highlight band
      [0.5, '#c8902e'], [0.6, '#a86a20'], [0.66, '#d8a040'],    // warm reflected mid, the bowl's underside
      [0.72, '#8a5a18'], [0.76, '#f0d070'], [0.8, '#a8782a'],   // stem knot
      [0.86, '#7a5418'], [0.9, '#f8e090'], [0.94, '#b8862e'], [1, '#6a4814'],  // the foot
    ]);
    g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) { const x = rnd() * w, y = Y(range(rnd, 0.1, 0.84)), rx = range(rnd, 4, 14), ry = range(rnd, 8, 24), c = pick(rnd, ['#fff0b0', '#8a5a18', '#e0b050']); wrapX(w, x, rx, X => blob(g, X, y, rx, ry, 0, c, 0.22, 0.2)); }
    for (let i = 0; i < 8; i++) { const x = rnd() * w, y = Y(range(rnd, 0.3, 0.8)); wrapX(w, x, 8, X => { blob(g, X + 1, y + 1, 4, 3, 0, '#4a3008', 0.35, 0.3); blob(g, X - 1, y - 1, 3, 2, 0, '#fff4c8', 0.4, 0.3); }); }
    blurTile(cv, 0.6);
  },
});

register('loot_steel', {
  family: F, size: 128, note: "the toaster's nickel (box faces): warm nickel, a broad cream highlight upper left, cool shade low, dark rims, soft dents, brushing",
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#a8a8a0');
    g.fillStyle = lin(g, 0, 0, s * 0.5, s, [[0, '#e8e0c8'], [0.3, '#c8c4b4'], [0.55, '#a8a8a0'], [0.85, '#7a7e86'], [1, '#5a6070']]); g.fillRect(0, 0, s, s);
    blob(g, s * 0.3, s * 0.26, s * 0.42, s * 0.16, -0.35, '#f4ecd4', 0.55, 0.3);
    for (let i = 0; i < 70; i++) { const y = rnd() * s, x = rnd() * s, L = range(rnd, 10, 50); line(g, [[x, y], [x + L, y + (rnd() - 0.5)]], range(rnd, 0.5, 1), rnd() < 0.5 ? '#f0ead8' : '#6a6e78', 0.16); }
    for (let i = 0; i < 4; i++) { const x = range(rnd, 0.2, 0.8) * s, y = range(rnd, 0.3, 0.8) * s, r = range(rnd, 5, 10); blob(g, x - r * 0.3, y - r * 0.3, r, r * 0.7, 0, '#fff4dc', 0.3, 0.3); blob(g, x + r * 0.35, y + r * 0.35, r, r * 0.7, 0, '#4a4e58', 0.3, 0.3); }
    for (let i = 0; i < 5; i++) blob(g, rnd() * s, range(rnd, 0.4, 0.9) * s, range(rnd, 4, 10), range(rnd, 3, 6), rnd() * 3, '#8a8070', 0.18, 0.3);
    g.save(); g.strokeStyle = rgba('#4a4e58', 0.7); g.lineWidth = 3; g.strokeRect(1.5, 1.5, s - 3, s - 3); g.restore();
    bevel(g, 0, 0, s, s, '#a8a8a0', 9, 0.35, 0.5);
    blurTile(cv, 0.6);
  },
});

register('loot_red', {
  family: F, size: 128, note: "the slot machine's red-lacquered goblin steel: rivet border, chips to dark iron, rust runs",
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8a2e24');
    mottle(g, s, rnd, { colors: ['#9a3a2c', '#7a2620', '#a8443a', '#842c26'], count: 26, rmin: 10, rmax: 40, alpha: 0.4, hard: 0.1 });
    edgeWear(g, 0, 0, s, s, rnd, '#4a3a36', 18, 6);
    for (let i = 0; i < 5; i++) run(g, rnd() * s, range(rnd, 6, s * 0.5), range(rnd, 10, 30), range(rnd, 1.5, 2.5), '#5a2416', 0.3, rnd);
    molding(g, 3, 3, s - 6, s - 6, '#8a2e24', 6, 0.7);
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
    const Y = y => (1 - vaseT(y)) * s;
    const B1 = '#21408a', B2 = '#3558a8', BW = '#7d94cc', BD = '#172e66', CO = '#2a4a9a';
    fill(g, s, s, '#eef0ea');
    mottle(g, s, rnd, { colors: ['#f8f8f2', '#e2e6e4', '#ece8dc', '#e6ecf0'], count: 30, rmin: 30, rmax: 90, alpha: 0.4, hard: 0.1 });
    const band = (y, w = 2.2, c = B1) => line(g, [[-2, y], [s + 2, y]], w, c, 0.92);
    const yFoot = Y(-0.352);
    rect(g, 0, yFoot, s, s - yFoot, '#cdb48e');
    for (let i = 0; i < 8; i++) { const x = rnd() * s, y = range(rnd, yFoot, s), rx = range(rnd, 4, 12); wrapX(s, x, 12, X => blob(g, X, y, rx, 3, 0, '#a88e6a', 0.3, 0.3)); }
    band(yFoot - 1, 3, B1);
    // lotus panels, in solid cobalt like the shoulder
    const l0 = Y(-0.33), l1 = Y(-0.2);
    rect(g, 0, l1, s, l0 - l1, '#e8ecf0');
    band(l0, 2.6); band(l0 - 4, 1.2);
    const nP = 10, PW = s / nP;
    for (let i = 0; i < nP; i++) {
      const cx = (i + 0.5) * PW;
      const petal = (X) => { g.beginPath(); g.moveTo(X - PW * 0.42, l0 - 5); g.quadraticCurveTo(X - PW * 0.48, l1 + 10, X, l1 + 2); g.quadraticCurveTo(X + PW * 0.48, l1 + 10, X + PW * 0.42, l0 - 5); };
      wrapX(s, cx, PW, X => {
        petal(X); g.save(); g.fillStyle = rgba(CO, 0.88); g.fill(); g.lineWidth = 2; g.strokeStyle = rgba(BD, 0.9); g.stroke(); g.restore();
        petal(X); g.save(); g.clip(); blob(g, X - PW * 0.15, l1 + (l0 - l1) * 0.4, PW * 0.18, (l0 - l1) * 0.3, 0, BW, 0.45, 0.3); g.restore();
        line(g, [[X, l0 - 7], [X, l1 + 9]], 1.4, '#e8ecf0', 0.75);
        blob(g, X, l1 + 9, 3, 3, 0, '#e8ecf0', 0.8, 0.5);
      });
    }
    band(l1, 2.4); band(l1 + 4, 1.1);
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
    // a cool shadow tucked under the swell of the shoulder, a warm light on top of it
    g.fillStyle = lin(g, 0, Y(-0.06), 0, Y(-0.2), [[0, '#6a7090', 0], [0.5, '#6a7090', 0.16], [1, '#6a7090', 0]]); g.fillRect(0, Y(-0.06), s, Y(-0.2) - Y(-0.06));
    g.fillStyle = lin(g, 0, Y(0.16), 0, Y(0.04), [[0, '#fff4dc', 0], [0.5, '#fff4dc', 0.18], [1, '#fff4dc', 0]]); g.fillRect(0, Y(0.16), s, Y(0.04) - Y(0.16));
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
    const p0 = Y(0.345);
    rect(g, 0, 0, s, p0, B1, 0.92);
    const wv = []; for (let x = -4; x <= s + 4; x += 3) wv.push([x, p0 * 0.5 + Math.sin(x / s * TAU * 9) * p0 * 0.18]);
    line(g, wv, 1.6, '#e8ecf0', 0.85);
    mottle(g, s, rnd, { colors: [BW], count: 14, rmin: 10, rmax: 30, alpha: 0.08, hard: 0.2 });
    cracks(g, s, rnd, { color: '#8a9498', count: 10, len: [16, 50], width: [0.5, 0.9], alpha: 0.12 });
    blurTile(cv, 0.6);
  },
});

// ---- the shop sign (the old "neon OPEN sign") -----------------------------------------------------------

register('loot_sign', {
  family: F, w: 512, h: 288, note: 'the shaped shop board (domed crest, coved shoulders): planks, a carved molding, a green field, gold-leaf OPEN, lantern light',
  paint(g, w, rnd, h, cv) {
    const P = ([x, y]) => [(x + SIGN.W / 2) / SIGN.W * w, (1 - y / SIGN.H) * h];
    const out = SIGN.pts.map(P);
    rect(g, 0, 0, w, h, '#4a2e1c');
    // planks across the board
    clip(g, () => poly(g, out), () => {
      const rows = [0, 92, 190, h];
      for (let i = 0; i < 3; i++) {
        const y0 = rows[i] + 2, y1 = rows[i + 1] - 2, c = jitter('#6a4428', rnd, 0.06);
        rect(g, 0, y0, w, y1 - y0, c);
        grain(g, 0, y0, w, y1 - y0, rnd, { dark: ['#3e2616', '#4a2e1a'], lite: ['#8a6040', '#94684a'], n: 16, amp: 2, knots: 1 });
        bevel(g, 0, y0, w, y1 - y0, c, 6, 0.4, 0.5);
      }
    });
    // the carved molding round the edge
    pathMolding(g, out, '#7a5232', 3, 12, 21);
    // the painted field: deep green, worn to the wood in places
    const f = offsetPoly(out, -23);
    clip(g, () => poly(g, f), () => {
      g.globalAlpha = 0.9; g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#305c40'], [1, '#22462e']]); g.fillRect(0, 0, w, h); g.globalAlpha = 1;
      mottle(g, w, rnd, { colors: ['#3a6a48', '#1e3e28', '#2a5236'], count: 22, rmin: 20, rmax: 60, alpha: 0.3, hard: 0.1 });
      for (let i = 0; i < 30; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 3, 12), range(rnd, 2, 5), 0, '#6a4428', 0.7, 0.6);
      // a hand-drawn gold pinstripe inside
      const pin = offsetPoly(out, -34).map(([x, y]) => [x + (rnd() - 0.5) * 1.4, y + (rnd() - 0.5) * 1.4]);
      line(g, [...pin, pin[0]], 2, '#d8b060', 0.75);
    });
    // the crest's little gold coin
    const [kx, ky] = P([0, 0.385]);
    coin(g, kx, ky, 17, rnd);
    for (const sx of [-1, 1]) { const pts = []; for (let k = 0; k <= 12; k++) { const a = k / 12 * TAU * 0.8, r = 2 + k * 0.7; pts.push([kx + sx * (26 + Math.cos(a) * r), ky + 4 + Math.sin(a) * r * 0.8]); } line(g, pts, 2.2, '#2a1a10', 0.4); line(g, pts.map(([a, b]) => [a - 0.6, b - 0.6]), 1.8, '#d8b060', 0.85); }
    // OPEN in gold leaf, hand lettered; small flourishes; the line under it
    const [, oy] = P([0, 0.19]);
    letters(g, 'OPEN', w / 2, oy, 120, { rnd, jit: 0.05, track: 10, maxW: 330, board: '#2a4a34', chip: 1.4 });
    for (const sx of [-1, 1]) { const x = w / 2 + sx * 196, y = oy; ellipse(g, x + 1, y + 1, 7, 7, Math.PI / 4, '#2a1a10', 0.5); ellipse(g, x, y, 6, 6, Math.PI / 4, '#e0b858'); blob(g, x - 2.5, y - 2.5, 2.5, 2, 0, '#fff4c8', 0.9, 0.4); }
    const [, cy2] = P([0, 0.065]);
    letters(g, '~ COME IN ~', w / 2, cy2, 22, { rnd, jit: 0.04, fill: ['#f8ecc8', '#e0cc98', '#a8946a'], rim: '#1a1008', lit: '#fffbe8', shadow: 0.35, track: 3, board: '#2a4a34' });
    // lantern light pooling from the top corners, grime at the bottom
    for (const x of [0, w]) { g.save(); g.globalCompositeOperation = 'soft-light'; g.fillStyle = radial(g, x, h * 0.25, 0, 220, [[0, '#ffd890', 0.85], [1, '#ffd890', 0]]); g.fillRect(0, 0, w, h); g.restore(); }
    g.fillStyle = lin(g, 0, h * 0.7, 0, h, [[0, INK, 0], [1, INK, 0.35]]); g.fillRect(0, 0, w, h);
    glaze(g, w, h, '#ffe0b0', 0.1);
    blurTile(cv, 0.55);
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

function sunburst(g, cx, cy, R, n, c, alpha, a0 = Math.PI, a1 = TAU) {
  for (let k = 0; k < n; k++) {
    const a = a0 + (k + 0.5) / n * (a1 - a0), da = (a1 - a0) / n * 0.28;
    g.save(); g.globalAlpha = alpha; g.fillStyle = c; g.beginPath(); g.moveTo(cx, cy); g.arc(cx, cy, R, a - da, a + da); g.closePath(); g.fill(); g.restore();
  }
}
function bulbRow(g, pts, r) {
  for (const [x, y] of pts) { ellipse(g, x + 0.6, y + 0.8, r * 1.25, r * 1.25, 0, '#3a1a0c', 0.7); ellipse(g, x, y, r, r, 0, '#ffd890'); blob(g, x - r * 0.3, y - r * 0.3, r * 0.5, r * 0.4, 0, '#fffbe8', 1, 0.5); }
}
function padlock(g, x, y, s) {
  line(g, [[x - s * 0.5, y], [x - s * 0.5, y - s * 0.55], [x - s * 0.4, y - s * 0.85], [x, y - s], [x + s * 0.4, y - s * 0.85], [x + s * 0.5, y - s * 0.55], [x + s * 0.5, y]], s * 0.18, '#2a2a2c', 0.9);
  line(g, [[x - s * 0.5, y - s * 0.1], [x - s * 0.5, y - s * 0.55], [x - s * 0.35, y - s * 0.82], [x, y - s * 0.94]], s * 0.07, '#a8aab0', 0.7);
  rrect(g, x - s * 0.72 + 1.5, y - s * 0.05 + 2, s * 1.44, s * 1.1, s * 0.16, '#1a0e08', 0.5);
  rrect(g, x - s * 0.72, y - s * 0.05, s * 1.44, s * 1.1, s * 0.16, '#a87a30');
  molding(g, x - s * 0.72, y - s * 0.05, s * 1.44, s * 1.1, '#b8883a', Math.max(2, s * 0.14));
  ellipse(g, x, y + s * 0.4, s * 0.13, s * 0.13, 0, '#1a1008'); line(g, [[x, y + s * 0.45], [x, y + s * 0.72]], s * 0.1, '#1a1008');
}
// The crown's arch in canvas space (T px tall, w wide), inset px inward; and the marquee painted in it.
function crownArch(w, T, inset = 0) {
  const C = SLOT_CROWN, P = (x, y) => [(x / (2 * C.hw) + 0.5) * w, (1 - y / C.top) * T], pts = [P(-C.hw, 0), P(-C.hw, C.side)];
  for (let k = 1; k < 24; k++) { const a = Math.PI - k / 24 * Math.PI; pts.push(P(C.hw * Math.cos(a), C.side + (C.top - C.side) * Math.sin(a))); }
  pts.push(P(C.hw, C.side), P(C.hw, 0));
  return inset ? offsetPoly(pts, -inset) : pts;
}
function marquee(g, w, T, rnd, text) {
  g.fillStyle = lin(g, 0, 0, 0, T, [[0, '#a8342a'], [1, '#6a1e1a']]); g.fillRect(0, 0, w, T);
  const k = T / 100, arch = crownArch(w, T);
  clip(g, () => poly(g, arch), () => { sunburst(g, w / 2, T, w * 0.75, 14, '#d8604a', 0.28); blob(g, w * 0.35, T * 0.3, w * 0.3, T * 0.25, 0, '#ffd8b0', 0.12, 0.2); });
  pathMolding(g, arch, '#c8a050', 1.5 * k, 5.5 * k, 10 * k);
  // chaser bulbs round the arch
  const path = crownArch(w, T, 17 * k).slice(1, -1), bp = [];
  let acc = 0;
  for (let i = 1; i < path.length; i++) { const [ax, ay] = path[i - 1], [bx, by] = path[i], L = Math.hypot(bx - ax, by - ay); for (let t = (19 * k - acc) % (19 * k); t < L; t += 19 * k) bp.push([ax + (bx - ax) * t / L, ay + (by - ay) * t / L]); acc = (acc + L) % (19 * k); }
  bulbRow(g, bp, 3.8 * k);
  if (text) letters(g, text, w / 2, T * 0.7, 40 * k, { rnd, jit: 0.05, track: 1, maxW: w - 74 * k, board: '#8a2a20', chip: 1.2 });
  else coin(g, w / 2, T * 0.66, 19 * k, rnd);
}
register('loot_slot', {
  family: F, w: 256, h: 512, note: 'goblin slot machine front: JACKPOT marquee (top 100 px = the crown), reels, pay table, emblem, coin tray',
  paint(g, w, rnd, h, cv) {
    // ---- the crown / marquee (y 0..100)
    marquee(g, w, 100, rnd, 'JACKPOT');
    // ---- the cabinet front (y 100..512)
    g.fillStyle = lin(g, 0, 100, 0, h, [[0, '#962e24'], [1, '#6e2018']]); g.fillRect(0, 100, w, h - 100);
    for (let i = 0; i < 18; i++) blob(g, rnd() * w, range(rnd, 110, h), range(rnd, 10, 40), range(rnd, 10, 30), 0, pick(rnd, ['#a83a2e', '#7a2620']), 0.3, 0.1);
    edgeWear(g, 0, 330, w, 182, rnd, '#4a3a36', 16, 8);
    molding(g, 0, 100, w, 16, '#c8a050', 6);
    // reel window in a cast brass bezel
    const rx = 26, ry = 132, rw = w - 52, rh = 128;
    rrect(g, rx - 14, ry - 14, rw + 28, rh + 28, 14, '#3a2410', 0.6);
    rrect(g, rx - 12, ry - 12, rw + 24, rh + 24, 14, '#b08a40');
    molding(g, rx - 12, ry - 12, rw + 24, rh + 24, '#c8a050', 9);
    rrect(g, rx - 2, ry - 2, rw + 4, rh + 4, 6, '#1e1418');
    const RW = (rw - 8) / 3;
    const sym = (k, x, y, sz) => {
      if (k === 0) letters(g, '7', x, y, sz, { rnd, jit: 0.03, fill: ['#e86a50', '#c8302a', '#7a1a14'], rim: '#4a1010', lit: '#ffc0a8', shadow: 0.3, chip: 0.4, rough: 0.5 });
      else if (k === 1) {
        line(g, [[x - 8, y + 4], [x + 2, y - 14], [x + 9, y + 3]], 2.2, '#3a6a28', 1);
        for (const dx of [-8, 9]) { ellipse(g, x + dx + 1, y + 7, 8, 8, 0, '#4a0e10'); ellipse(g, x + dx, y + 6, 7.5, 7.5, 0, '#b82a28'); blob(g, x + dx - 2.5, y + 3.5, 2.5, 2, 0, '#ffd0c0', 0.9, 0.4); }
        ellipse(g, x + 6, y - 12, 6, 2.8, -0.5, '#4a8a34');
      } else if (k === 2) coin(g, x, y, 14, rnd);
      else {
        rrect(g, x - 18, y - 9, 36, 18, 3, '#2a2030'); rrect(g, x - 16, y - 7, 32, 14, 2, '#f0e6cc');
        letters(g, 'BAR', x, y + 0.5, 11, { rnd, jit: 0.02, fill: ['#4a4050', '#2a2030', '#1a1420'], rim: '#f0e6cc', lit: '#f0e6cc', shadow: 0, chip: 0, rough: 0.3 });
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
    line(g, [[rx, ry + rh / 2], [rx + rw, ry + rh / 2]], 2, '#c8302a', 0.6);
    g.save(); g.globalAlpha = 0.2; g.fillStyle = '#fffbe8'; poly(g, [[rx + 10, ry], [rx + 46, ry], [rx + 6, ry + rh], [rx - 30, ry + rh]]); g.fill(); g.restore();
    // pay table on a little painted board
    rrect(g, 22, 272, w - 44, 30, 4, '#2a1a14');
    molding(g, 22, 272, w - 44, 30, '#5a3a20', 3);
    for (const [txt, x, y, al] of [['777 .... 500', 32, 282, 'l'], ['GGG .... 50', 32, 293, 'l'], ['BAR .. 10', w - 32, 282, 'r'], ['CHERRY .. 2', w - 32, 293, 'r']]) {
      g.save(); g.font = `bold 9px ${FONT}`; g.textBaseline = 'middle'; g.textAlign = al === 'l' ? 'left' : 'right'; g.fillStyle = '#1a0e08'; g.fillText(txt, x + 0.7, y + 0.8); g.fillStyle = '#e0b858'; g.fillText(txt, x, y); g.restore();
    }
    // the button deck (geometry sits on it)
    molding(g, 0, 304, w, 30, '#c8a050', 8);
    // the goblin emblem: a cog with a coin
    const ex = w / 2, ey = 392;
    for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; g.save(); g.translate(ex + Math.cos(a) * 34, ey + Math.sin(a) * 34); g.rotate(a); rrect(g, -6, -5, 12, 10, 2, '#8a6420'); g.restore(); }
    ellipse(g, ex + 2, ey + 3, 36, 36, 0, '#3a2410', 0.6); ellipse(g, ex, ey, 35, 35, 0, '#a87a2a');
    coin(g, ex, ey, 26, rnd);
    // coin tray opening with a few coins in it
    rrect(g, 58, 438, w - 116, 46, 8, '#b08a40'); molding(g, 58, 438, w - 116, 46, '#c8a050', 6); rrect(g, 66, 446, w - 132, 30, 6, '#1e1418');
    for (let i = 0; i < 7; i++) { const x = range(rnd, 76, w - 76), y = range(rnd, 464, 470); ellipse(g, x + 1, y + 1, 8, 3.5, 0, '#3a2410'); ellipse(g, x, y, 8, 3.5, 0, '#e0b048'); line(g, [[x - 5, y - 1.5], [x + 3, y - 2]], 1, '#fff0b8', 0.8); }
    for (let k = 0; k < 7; k++) { const t = 14 + k * (w - 28) / 6; rivet(g, t, 352, 3, '#c8a050'); rivet(g, t, 500, 3, '#c8a050'); }
    vignette(g, 0, 100, w, h - 100, '#2a1010', 0.3);
    glaze(g, w, h, '#ffe0b0', 0.08);
    blurTile(cv, 0.45);
  },
});
register('loot_slotback', {
  family: F, w: 192, h: 384, note: "the slot machine's back: the crown's sunburst and bulbs (top 75 px), a riveted access door with a padlock, PROPERTY OF LUCKY SLOP",
  paint(g, w, rnd, h, cv) {
    const T = 75;
    marquee(g, w, T, rnd, null);
    // the cabinet back
    g.fillStyle = lin(g, 0, T, 0, h, [[0, '#8a2a22'], [1, '#6a1e18']]); g.fillRect(0, T, w, h - T);
    for (let i = 0; i < 14; i++) blob(g, rnd() * w, range(rnd, T, h), range(rnd, 10, 34), range(rnd, 10, 26), 0, pick(rnd, ['#a03a2e', '#6a2018']), 0.3, 0.1);
    molding(g, 0, T, w, 12, '#c8a050', 5);
    // the access door
    const dx = 26, dy = T + 34, dw = w - 52, dh = h - T - 90;
    rect(g, dx + 3, dy + 4, dw, dh, '#2a0e0a', 0.5);
    rect(g, dx, dy, dw, dh, '#7a2620');
    molding(g, dx, dy, dw, dh, '#8a2e24', 8);
    for (let k = 0; k < 5; k++) { const t = k / 4; for (const [x, y] of [[dx + 14 + t * (dw - 28), dy + 14], [dx + 14 + t * (dw - 28), dy + dh - 14]]) rivet(g, x, y, 3, '#c8a050'); }
    for (const y of [dy + 30, dy + dh - 30]) { rect(g, dx - 8, y - 7, 22, 14, '#4a4446'); molding(g, dx - 8, y - 7, 22, 14, '#5a5456', 3); }
    stencil(g, 'PROPERTY OF', w / 2, dy + 48, 14, '#e8d8b0', rnd, { maxW: dw - 30, alpha: 0.75 });
    stencil(g, 'LUCKY SLOP', w / 2, dy + 70, 20, '#e8d8b0', rnd, { maxW: dw - 22, alpha: 0.8 });
    padlock(g, dx + dw - 30, dy + dh / 2 + 22, 16);
    // louvers low down
    for (let k = 0; k < 5; k++) { const y = h - 46 + k * 7; rect(g, 30, y, w - 60, 4, '#2a0e0a', 0.75); line(g, [[30, y + 4.5], [w - 30, y + 4.5]], 1, '#c8584a', 0.5); }
    edgeWear(g, 0, T, w, h - T, rnd, '#4a3a36', 22, 7);
    for (let i = 0; i < 7; i++) run(g, rnd() * w, range(rnd, T + 14, h * 0.7), range(rnd, 10, 40), range(rnd, 1.6, 3), '#4a1a10', 0.3, rnd);
    vignette(g, 0, T, w, h - T, '#2a1010', 0.3);
    glaze(g, w, h, '#ffe0b0', 0.08);
    blurTile(cv, 0.45);
  },
});
register('loot_slotside', {
  family: F, w: 96, h: 192, note: "the slot machine's flanks: a gold-pinstriped panel and a big painted goblin coin",
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#962e24'], [1, '#6a1e18']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 10; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 8, 24), range(rnd, 8, 20), 0, pick(rnd, ['#a83a2e', '#7a2620']), 0.3, 0.1);
    molding(g, 9, 12, w - 18, h - 24, '#8a2e24', 5);
    const pin = [[17, 20], [w - 17, 20], [w - 17, h - 20], [17, h - 20], [17, 20]].map(([x, y]) => [x + (rnd() - 0.5), y + (rnd() - 0.5)]);
    line(g, pin, 1.6, '#d8b060', 0.8);
    for (const [x, y, sx, sy] of [[17, 20, 1, 1], [w - 17, 20, -1, 1], [17, h - 20, 1, -1], [w - 17, h - 20, -1, -1]]) { const pts = []; for (let k = 0; k <= 10; k++) { const a = k / 10 * TAU * 0.75, r = 1.5 + k * 0.6; pts.push([x + sx * (5 + Math.cos(a) * r), y + sy * (5 + Math.sin(a) * r)]); } line(g, pts, 1.4, '#d8b060', 0.85); }
    coin(g, w / 2, h * 0.47, 26, rnd);
    for (let k = 0; k < 4; k++) { const t = 8 + k * (h - 16) / 3; rivet(g, 5, t, 2.4, '#c8a050'); rivet(g, w - 5, t, 2.4, '#c8a050'); }
    edgeWear(g, 0, 0, w, h, rnd, '#4a3a36', 12, 5);
    for (let i = 0; i < 4; i++) run(g, rnd() * w, range(rnd, 10, h * 0.6), range(rnd, 10, 30), range(rnd, 1.4, 2.4), '#4a1a10', 0.3, rnd);
    glaze(g, w, h, '#ffe0b0', 0.08);
    blurTile(cv, 0.45);
  },
});
register('loot_bulbs', {
  family: F, w: 512, h: 48, note: "the crown's arched band (u along the arch, v front → back): chaser bulbs in brass cups on red lacquer",
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#7a2420'], [0.5, '#a8382c'], [1, '#7a2420']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 10, 30), range(rnd, 3, 8), 0, pick(rnd, ['#b8443a', '#6a1e1a']), 0.3, 0.1);
    for (const y of [0, h - 6]) { rect(g, 0, y, w, 6, '#c8a050'); line(g, [[0, y + 1], [w, y + 1]], 1, '#fff0b8', 0.7); line(g, [[0, y + 5.5], [w, y + 5.5]], 1, '#5a3a14', 0.7); }
    // bulbs (the band is ~4.5× longer per pixel across than along, so they're painted squashed in v)
    for (let x = 10; x < w; x += 21) for (const y of [h * 0.33, h * 0.67]) {
      ellipse(g, x + 0.5, y + 0.8, 6.5, 2.4, 0, '#3a1a0c', 0.7); ellipse(g, x, y, 5.5, 2, 0, '#c8a050');
      ellipse(g, x, y, 4.2, 1.5, 0, '#ffd890'); blob(g, x - 1.5, y - 0.4, 2, 0.7, 0, '#fffbe8', 1, 0.5);
    }
    blurTile(cv, 0.3);
  },
});

// ---- the CRT ---------------------------------------------------------------------------------------------

register('loot_screen', {
  family: F, size: 128, note: 'CRT glass: smoky green-gray, curved, a window reflection and a faint glow of a picture',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = radial(g, s * 0.5, s * 0.5, 4, s * 0.75, [[0, '#6e8c86'], [0.55, '#4a6662'], [0.9, '#2e4040'], [1, '#1e2a2a']]); g.fillRect(0, 0, s, s);
    blob(g, s * 0.52, s * 0.6, 22, 30, 0, '#7aa098', 0.22, 0.3);
    blob(g, s * 0.52, s * 0.34, 12, 18, 0, '#9a6a60', 0.18, 0.3);
    blob(g, s * 0.52, s * 0.18, 10, 12, 0, '#a85a4a', 0.16, 0.3);
    for (let y = 2; y < s; y += 3) line(g, [[0, y], [s, y]], 1, '#0e1414', 0.08);
    for (let i = 0; i < 6; i++) { const y = rnd() * s; line(g, [[rnd() * s * 0.3, y], [s * 0.7 + rnd() * s * 0.3, y]], range(rnd, 2, 5), '#b8e0d8', 0.08); }
    g.save(); g.globalAlpha = 0.28; g.fillStyle = '#e8f4f0'; poly(g, [[s * 0.14, s * 0.14], [s * 0.42, s * 0.12], [s * 0.36, s * 0.42], [s * 0.1, s * 0.44]]); g.fill(); g.restore();
    line(g, [[s * 0.25, s * 0.13], [s * 0.24, s * 0.43]], 2.5, '#22302e', 0.25);
    const arc = []; for (let k = 0; k <= 10; k++) { const a = Math.PI * (1.05 + k / 10 * 0.4); arc.push([s * 0.5 + Math.cos(a) * s * 0.4, s * 0.55 + Math.sin(a) * s * 0.42]); }
    line(g, arc, 2, '#f4fffc', 0.5);
    vignette(g, 0, 0, s, s, '#0a1010', 0.4, 0.08);
    blurTile(cv, 0.6);
  },
});

register('loot_tvfront', {
  family: F, w: 256, h: 176, note: 'the CRT cabinet face: wood frame, the deep screen recess in a brass bezel, a speaker grille and the knob plate, SLOPTRON',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#5a3a24');
    grain(g, 0, 0, w, h, rnd, { dark: ['#3a2416', '#2e1c14'], lite: ['#86603e', '#946a44'], n: 36, amp: 2, knots: 1 });
    bevel(g, 0, 0, w, h, '#5a3a24', 9, 0.5, 0.55);
    const [su0, sv0, su1, sv1] = TV_LAYOUT.screen;
    const X0 = su0 * w, X1 = su1 * w, Y0 = (1 - sv1) * h, Y1 = (1 - sv0) * h;
    rrect(g, X0 - 8, Y0 - 7, X1 - X0 + 16, Y1 - Y0 + 16, 18, '#2a1a0c', 0.6);
    rrect(g, X0 - 7, Y0 - 7, X1 - X0 + 14, Y1 - Y0 + 14, 17, '#b08a40');
    clip(g, () => { g.beginPath(); g.roundRect(X0 - 7, Y0 - 7, X1 - X0 + 14, Y1 - Y0 + 14, 17); }, () => {
      g.fillStyle = lin(g, X0, Y0, X1, Y1, [[0, '#f8e49a'], [0.35, '#c8a050'], [0.7, '#8a6628'], [1, '#5a3a14']]); g.fillRect(X0 - 8, Y0 - 8, X1 - X0 + 16, Y1 - Y0 + 16);
    });
    rrect(g, X0, Y0, X1 - X0, Y1 - Y0, 12, '#141012');
    const px0 = w * 0.75, px1 = w * 0.96;
    rrect(g, px0, h * 0.06, px1 - px0, h * 0.34, 5, '#b08a40');
    molding(g, px0, h * 0.06, px1 - px0, h * 0.34, '#c8a050', 4);
    for (const [u, v] of TV_LAYOUT.knobs) { ellipse(g, u * w, (1 - v) * h, 9, 9, 0, '#5a3a14', 0.5); for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; line(g, [[u * w + Math.cos(a) * 10, (1 - v) * h + Math.sin(a) * 10], [u * w + Math.cos(a) * 12, (1 - v) * h + Math.sin(a) * 12]], 1, '#3a2410', 0.7); } }
    const gy0 = h * 0.45, gy1 = h * 0.88;
    rrect(g, px0, gy0, px1 - px0, gy1 - gy0, 5, '#2a1a10');
    g.save(); g.beginPath(); g.roundRect(px0 + 3, gy0 + 3, px1 - px0 - 6, gy1 - gy0 - 6, 4); g.clip();
    rect(g, px0, gy0, px1 - px0, gy1 - gy0, '#8a6a40');
    for (let y = gy0; y < gy1; y += 2.5) line(g, [[px0, y], [px1, y]], 0.8, '#5a4026', 0.6);
    for (let x = px0; x < px1; x += 2.5) line(g, [[x, gy0], [x, gy1]], 0.8, '#a8885a', 0.35);
    g.fillStyle = lin(g, 0, gy0, 0, gy1, [[0, '#1e140c', 0.5], [0.3, '#1e140c', 0], [1, '#1e140c', 0.35]]); g.fillRect(px0, gy0, px1 - px0, gy1 - gy0);
    g.restore();
    letters(g, 'SLOPTRON', (X0 + X1) / 2, h * 0.945, 13, { rnd, jit: 0.04, shadow: 0.3, track: 2, board: '#5a3a24', chip: 0.6 });
    glaze(g, w, h, '#ffd8a8', 0.1);
    blurTile(cv, 0.4);
  },
});
register('loot_tvback', {
  family: F, w: 256, h: 176, note: "the CRT's back: dark pressed board, vent slots, four screws, the brass plate (NO SERVICEABLE GOBLINS INSIDE)",
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#3a2a1c');
    for (let i = 0; i < 26; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 10, 40), range(rnd, 6, 20), rnd() * 3, pick(rnd, ['#46341f', '#2e2016', '#4a3826']), 0.4, 0.1);
    for (let i = 0; i < 90; i++) { const x = rnd() * w, y = rnd() * h; ellipse(g, x, y, range(rnd, 0.5, 1.2), range(rnd, 0.4, 0.9), rnd() * 3, rnd() < 0.5 ? '#5a4630' : '#241810', 0.4); }
    bevel(g, 0, 0, w, h, '#3a2a1c', 9, 0.4, 0.55);
    // vent slots
    const n = 10, x0 = w * 0.16, x1 = w * 0.84, sw = 7;
    for (let k = 0; k < n; k++) {
      const x = x0 + (x1 - x0) * k / (n - 1) + (rnd() - 0.5), y0 = h * 0.1, y1 = h * 0.42;
      rrect(g, x - sw / 2 - 1, y0 - 1, sw + 2, y1 - y0 + 2, 3, '#5a4630', 0.6);
      rrect(g, x - sw / 2, y0, sw, y1 - y0, 3, '#1e140c');
      line(g, [[x - sw / 2 + 1, y1 + 0.5], [x + sw / 2 - 1, y1 + 0.5]], 1.4, '#8a6a48', 0.85);
      line(g, [[x + sw / 2 + 0.5, y0 + 2], [x + sw / 2 + 0.5, y1 - 1]], 1, '#8a6a48', 0.5);
    }
    // the brass plate
    const bx = w * 0.5 - 62, by = h * 0.62, bw = 124, bh = 40;
    rect(g, bx + 2, by + 3, bw, bh, '#140c08', 0.45);
    rect(g, bx, by, bw, bh, '#a88438'); molding(g, bx, by, bw, bh, '#c8a050', 4);
    letters(g, 'SLOPTRON', bx + bw / 2, by + 13, 11, { rnd, jit: 0.03, fill: ['#6a4818', '#4a2e10', '#2a1a08'], rim: '#f8e4a0', lit: '#3a2410', shadow: 0, chip: 0.2, rough: 0.4 });
    for (const [txt, yy] of [['NO SERVICEABLE', by + 24], ['GOBLINS INSIDE', by + 32]]) { g.save(); g.font = `bold 7px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = rgba('#fff0c0', 0.5); g.fillText(txt, bx + bw / 2 - 0.5, yy - 0.5); g.fillStyle = '#3a2410'; g.fillText(txt, bx + bw / 2, yy); g.restore(); }
    for (const sx of [bx + 7, bx + bw - 7]) rivet(g, sx, by + bh / 2, 2.6, '#c8a050');
    for (const [x, y] of [[10, 10], [w - 10, 10], [10, h - 10], [w - 10, h - 10]]) { rivet(g, x, y, 3.6, '#8a8a84'); line(g, [[x - 2.2, y - 2.2], [x + 2.2, y + 2.2]], 1, '#2a2a2a', 0.8); }
    // a stamped inspection mark
    g.save(); g.translate(w * 0.84, h * 0.66); g.rotate(-0.2); g.strokeStyle = rgba('#8a2a1e', 0.55); g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 13, 0, TAU); g.stroke();
    g.font = `bold 8px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = rgba('#8a2a1e', 0.55); g.fillText('No.7', 0, 1); g.restore();
    glaze(g, w, h, '#ffd8a8', 0.08);
    blurTile(cv, 0.4);
  },
});

// ---- the stained-glass lamp ------------------------------------------------------------------------------

// A pane of glass: lighter top-left, darker bottom-right, a glint; then the bronze came round it.
function pane(g, pts, c, rnd) {
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9; for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  poly(g, pts); g.save(); g.fillStyle = lin(g, x0, y0, x1, y1, [[0, lightOf(c, 0.35)], [0.45, c], [1, shadowOf(c, 0.3)]]); g.fill(); g.restore();
  if (rnd && rnd() < 0.5) blob(g, x0 + (x1 - x0) * 0.3, y0 + (y1 - y0) * 0.3, Math.max(1.5, (x1 - x0) * 0.18), Math.max(1, (y1 - y0) * 0.1), -0.4, '#fff8e0', 0.35, 0.3);
}
function came(g, pts, closed = true) {
  const p = closed ? [...pts, pts[0]] : pts;
  line(g, p, 2.6, '#3a2a18', 0.95); line(g, p.map(([x, y]) => [x - 0.5, y - 0.6]), 0.8, '#7a6040', 0.6);
}
register('loot_glass', {
  family: F, w: 512, h: 128, note: 'Tiffany leaded glass (u wraps; top = the crown, bottom = the scalloped rim): amber crown, a leaf band, poppies of petal panes on honey, an amber border',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#3a2a18');
    const HONEY = ['#d89a3a', '#e0a848', '#f0c060', '#e8b050', '#d49440'], AMBER = ['#c8862e', '#b8742a', '#d89a3a'], LEAF = ['#6a8a3a', '#8aa048', '#5a7a34', '#7a9440'], RED = ['#b8402a', '#c25032', '#a8382a', '#c8603a'];
    // the background: an irregular quad lattice of honey panes from y 14 down (wraps in u)
    const rowsY = [14, 30, 46, 62, 78, 94, 108, 118];
    const nx = 22, dx = w / nx;
    const node = [];
    for (const [j, y] of rowsY.entries()) { node.push([]); for (let i = 0; i <= nx; i++) { const jx = i === nx ? node[j][0][0] + w : i * dx + (j % 2 ? dx * 0.5 : 0) + (rnd() - 0.5) * dx * 0.3, jy = y + (j === 0 || j === rowsY.length - 1 ? 0 : (rnd() - 0.5) * 6); node[j].push([jx, jy]); } node[j][nx] = [node[j][0][0] + w, node[j][0][1]]; }
    for (let j = 0; j < rowsY.length - 1; j++) for (let i = 0; i < nx; i++) {
      const q = [node[j][i], node[j][i + 1], node[j + 1][i + 1], node[j + 1][i]], c = jitter(pick(rnd, j < 1 ? LEAF : HONEY), rnd, 0.05);
      for (const off of [0, -w, w]) { const qq = q.map(([x, y]) => [x + off, y]); pane(g, qq, c, rnd); came(g, qq); }
    }
    // the crown: small amber panes in two rows
    for (const [y0, y1, n] of [[0, 7, 26], [7, 14, 22]]) for (let i = 0; i < n; i++) {
      const xa = i * w / n, xb = (i + 1) * w / n, c = jitter(pick(rnd, AMBER), rnd, 0.06);
      const q = [[xa, y0], [xb, y0], [xb, y1], [xa, y1]]; pane(g, q, c, rnd); came(g, q);
    }
    // the poppies: five petal panes round a dark seed head, with leaves between
    const nP = 7;
    for (let i = 0; i < nP; i++) {
      const cx = (i + 0.5) * w / nP + range(rnd, -6, 6), cy = range(rnd, 58, 66), R = range(rnd, 19, 23);
      wrapX(w, cx, R * 2.4, X => {
        // leaves either side, down low
        for (const sx of [-1, 1]) {
          const lx = X + sx * R * 1.55, ly = cy + R * 0.7, a = sx * 0.6;
          const lp = []; for (let k = 0; k <= 8; k++) { const t = k / 8 * TAU, rr = (Math.abs(Math.sin(t)) * 0.5 + 0.5); lp.push([lx + Math.cos(t + a) * R * 0.75 * rr, ly + Math.sin(t + a) * R * 0.32 * rr]); }
          const c = jitter(pick(rnd, LEAF), rnd, 0.06); pane(g, lp, c, rnd); came(g, lp);
          line(g, [[lx - Math.cos(a) * R * 0.6, ly - Math.sin(a) * R * 0.25], [lx + Math.cos(a) * R * 0.6, ly + Math.sin(a) * R * 0.25]], 1.6, '#3a2a18', 0.9);
        }
        for (let k = 0; k < 5; k++) {
          const a = k / 5 * TAU - Math.PI / 2 + range(rnd, -0.12, 0.12), a0 = a - 0.62, a1 = a + 0.62, r0 = R * 0.28;
          const pp = [[X + Math.cos(a0) * r0, cy + Math.sin(a0) * r0]];
          for (let m = 0; m <= 6; m++) { const t = a0 + (a1 - a0) * m / 6, rr = R * (0.86 + 0.14 * Math.sin(m / 6 * Math.PI)) * range(rnd, 0.94, 1.06); pp.push([X + Math.cos(t) * rr, cy + Math.sin(t) * rr * 0.92]); }
          pp.push([X + Math.cos(a1) * r0, cy + Math.sin(a1) * r0]);
          const c = jitter(pick(rnd, RED), rnd, 0.05); pane(g, pp, c, rnd); came(g, pp);
        }
        const hp = []; for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; hp.push([X + Math.cos(a) * R * 0.3, cy + Math.sin(a) * R * 0.3]); }
        pane(g, hp, '#4a3a20', null); came(g, hp);
        for (let k = 0; k < 5; k++) ellipse(g, X + (rnd() - 0.5) * R * 0.3, cy + (rnd() - 0.5) * R * 0.3, 1.2, 1.2, 0, '#e0a848', 0.9);
      });
    }
    // the border at the rim: amber rectangles, the scallops come from the geometry
    for (let i = 0; i < 32; i++) { const xa = i * w / 32, xb = (i + 1) * w / 32, q = [[xa, 118], [xb, 118], [xb, h], [xa, h]]; pane(g, q, jitter(pick(rnd, AMBER), rnd, 0.06), rnd); came(g, q); }
    line(g, [[0, 1], [w, 1]], 2.5, '#3a2a18'); line(g, [[0, h - 1], [w, h - 1]], 2.5, '#3a2a18');
    blurTile(cv, 0.45);
  },
});

register('loot_bulb', {
  family: F, size: 64, note: 'a warm lit bulb',
  paint(g, s, rnd, h, cv) { g.fillStyle = radial(g, s * 0.45, s * 0.45, 2, s * 0.6, [[0, '#fffbe8'], [0.5, '#ffe6a0'], [1, '#e8a850']]); g.fillRect(0, 0, s, s); },
});

// ---- the gnome ------------------------------------------------------------------------------------------

register('loot_gnomehat', {
  family: F, size: 128, note: "the gnome's felt hat (u wraps, front at the middle; v brim → tip): fold creases where it flops, a dark stitched patch",
  paint(g, s, rnd, h, cv) {
    const Y = v => (1 - v) * s;
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#7a2620'], [0.4, '#9a3228'], [0.85, '#a83a2e'], [1, '#6a201a']]); g.fillRect(0, 0, s, s);
    for (let i = 0; i < 26; i++) { const x = rnd() * s, y = rnd() * s, rx = range(rnd, 5, 14), ry = range(rnd, 8, 22), c = pick(rnd, ['#b84838', '#7a221c', '#a8382e', '#8a2a22']); wrap(s, x, y, ry, (X, Yy) => blob(g, X, Yy, rx, ry, 0, c, 0.32, 0.15)); }
    for (let i = 0; i < 60; i++) { const x = rnd() * s, y = rnd() * s, L = range(rnd, 3, 7), a = rnd() * TAU, c = rnd() < 0.5 ? '#c85a48' : '#5a1814'; wrapX(s, x, 8, X => line(g, [[X, y], [X + Math.cos(a) * L, y + Math.sin(a) * L]], 0.8, c, 0.3)); }
    // the convex side of the bend is stretched and catches the light; the concave side folds
    const ub = GNOME.bendU * s, uc = ((GNOME.bendU + 0.5) % 1) * s, yc = Y(GNOME.crease);
    wrapX(s, uc, 40, X => blob(g, X, yc, 30, 9, 0, '#d86a54', 0.4, 0.2));
    for (let k = 0; k < 4; k++) {
      const dy = (k - 1.5) * 5, L = range(rnd, 14, 24), x = ub + range(rnd, -8, 8);
      wrapX(s, x, 30, X => {
        const pts = []; for (let m = 0; m <= 6; m++) { const t = m / 6; pts.push([X - L + 2 * L * t, yc + dy + Math.sin(t * Math.PI) * 3]); }
        stroke(g, pts.map(([a, b]) => [a, b - 1.6]), 2.4, 1, '#c85a48', 0.55); stroke(g, pts, 2.6, 1, '#4a1410', 0.6);
      });
    }
    // the patch: a dark square of felt with heavy cream stitching (front, low)
    g.save(); g.translate(s * 0.47, Y(0.33)); g.rotate(-0.22);
    const pq = [[-10, -8], [9, -10], [10, 8], [-9, 9]];
    poly(g, pq.map(([a, b]) => [a + 1.5, b + 2])); g.fillStyle = rgba('#2a0806', 0.45); g.fill();
    poly(g, pq); g.fillStyle = '#6a2418'; g.fill();
    blob(g, -3, -4, 8, 4, -0.2, '#8a3a2a', 0.6, 0.3); blob(g, 4, 5, 7, 3, 0, '#4a1810', 0.5, 0.3);
    for (let k = 0; k < 4; k++) { const [ax, ay] = pq[k], [bx, by] = pq[(k + 1) % 4]; for (let m = 1; m < 5; m++) { const t = m / 5, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, nx = -(by - ay) * 0.12, ny = (bx - ax) * 0.12; line(g, [[x - nx * 0.5 - 1.2, y - ny * 0.5 - 1.2], [x + nx * 0.5 + 1.2, y + ny * 0.5 + 1.2]], 1.3, '#c8b088', 0.85); } }
    g.restore();
    g.fillStyle = lin(g, 0, Y(0.12), 0, s, [[0, '#2a0806', 0], [1, '#2a0806', 0.45]]); g.fillRect(0, Y(0.12), s, s - Y(0.12));
    glaze(g, s, s, '#ffd8b0', 0.08);
    blurTile(cv, 0.45);
  },
});
register('loot_gnomecoat', {
  family: F, w: 256, h: 128, note: "the gnome's coat (u wraps, front at the middle; v hem → shoulders): slate blue, big folds lit on their left, the belt and buckle, brass buttons",
  paint(g, w, rnd, h, cv) {
    const Y = v => (1 - v) * h;
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#4e6a92'], [0.35, '#3a5680'], [0.8, '#30486c'], [1, '#26385a']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 20; i++) { const x = rnd() * w, y = rnd() * h, rx = range(rnd, 8, 20), ry = range(rnd, 10, 24), c = pick(rnd, ['#4a6690', '#2e4466', '#3e5a84']); wrapX(w, x, rx, X => blob(g, X, y, rx, ry, 0, c, 0.3, 0.15)); }
    // big folds in the skirt: a shaded valley with the lit ridge to its left, widening to the hem
    const yb = Y(GNOME.belt[0]);
    for (let i = 0; i < 9; i++) {
      const x = (i + 0.5) * w / 9 + range(rnd, -6, 6), spread = range(rnd, 6, 12);
      wrapX(w, x, 30, X => {
        stroke(g, [[X, yb + 4], [X + spread * 0.3, (yb + h) / 2], [X + spread * 0.6, h + 2]], 2, range(rnd, 9, 14), '#26385a', 0.55);
        stroke(g, [[X - 5, yb + 6], [X - 6 + spread * 0.2, (yb + h) / 2], [X - 8 + spread * 0.4, h + 2]], 1.5, range(rnd, 5, 8), '#6a86ac', 0.45);
      });
    }
    // the chest: softer folds toward the arms, light on the shoulders
    for (let i = 0; i < 6; i++) { const x = rnd() * w; wrapX(w, x, 10, X => stroke(g, [[X, Y(0.95)], [X + 4, Y(0.6)]], 4, 1, '#30486c', 0.35)); }
    g.fillStyle = lin(g, 0, 0, 0, Y(0.8), [[0, '#8aa4c4', 0.4], [1, '#8aa4c4', 0]]); g.fillRect(0, 0, w, Y(0.8));
    // the hem's shadow
    g.fillStyle = lin(g, 0, h - 12, 0, h, [[0, '#141e3a', 0], [1, '#141e3a', 0.55]]); g.fillRect(0, h - 12, w, 12);
    // the front opening above the belt and its buttons
    const fx = w / 2, yt = Y(GNOME.belt[1]);
    line(g, [[fx + 1, 0], [fx + 1.5, yt]], 2, '#1a2846', 0.7); line(g, [[fx - 0.8, 0], [fx - 0.4, yt]], 1, '#7a94b8', 0.6);
    for (const y of [yt - 12, yt - 28]) { ellipse(g, fx + 0.8, y + 1, 3.2, 3.2, 0, '#141a30'); ellipse(g, fx, y, 3, 3, 0, '#c89a40'); blob(g, fx - 0.9, y - 0.9, 1.3, 1, 0, '#fff4c8', 1, 0.4); }
    // the belt and its brass buckle
    const by0 = Y(GNOME.belt[1]), by1 = Y(GNOME.belt[0]);
    rect(g, 0, by0, w, by1 - by0, '#4a2c18');
    for (let i = 0; i < 10; i++) { const x = rnd() * w; wrapX(w, x, 10, X => blob(g, X, (by0 + by1) / 2, range(rnd, 6, 14), 2.5, 0, pick(rnd, ['#5e3a22', '#3a2010']), 0.4, 0.3)); }
    line(g, [[0, by0 + 1], [w, by0 + 1]], 1.5, '#8a5a38', 0.8); line(g, [[0, by1 - 1], [w, by1 - 1]], 1.5, '#1e1008', 0.8);
    rrect(g, fx - 9, by0 - 2, 18, by1 - by0 + 4, 3, '#5a3a10'); rrect(g, fx - 7.5, by0 - 0.5, 15, by1 - by0 + 1, 2, '#d8a840'); rrect(g, fx - 4, by0 + 2.5, 8, by1 - by0 - 5, 1, '#4a2c18');
    blob(g, fx - 4, by0 + 1, 3, 2, 0, '#fff4c8', 0.9, 0.4);
    glaze(g, w, h, '#ffe0b8', 0.08);
    blurTile(cv, 0.45);
  },
});
register('loot_gnomebeard', {
  family: F, size: 128, note: "the gnome's beard (u wraps, front at the middle; v tip → chin): eight big tapered locks, warm-lit on their upper left, lilac shadow between, a chin shadow",
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#a8a2ac'], [0.3, '#c4beba'], [1, '#9a94a2']]); g.fillRect(0, 0, s, s);
    // the back half (against the chest) stays a plain shaded mass; the locks fan over the front
    const locks = 8;
    for (let i = 0; i < locks; i++) {
      const t = (i + 0.5) / locks, x0 = s * (0.2 + 0.6 * t) + range(rnd, -2, 2), x1 = s * 0.5 + (x0 - s * 0.5) * 0.45 + range(rnd, -3, 3), yEnd = s * range(rnd, 0.82, 0.98), wTop = s * range(rnd, 0.12, 0.15);
      const curl = (i % 2 ? 1 : -1) * range(rnd, 2, 5);
      const pts = []; for (let k = 0; k <= 8; k++) { const u = k / 8; pts.push([x0 + (x1 - x0) * u * u + Math.sin(u * Math.PI) * curl, -4 + (yEnd + 4) * u]); }
      stroke(g, pts.map(([a, b]) => [a + 3, b + 2]), wTop * 1.25, wTop * 0.5, '#6a6478', 0.85);       // the shadow between locks
      stroke(g, pts, wTop, wTop * 0.38, '#e8e0d4', 1);                                              // the lock
      stroke(g, pts.slice(0, 8).map(([a, b]) => [a - wTop * 0.24, b + 1]), wTop * 0.38, wTop * 0.12, '#fff8e8', 0.9);   // lit upper-left edge
      for (let k = 0; k < 3; k++) stroke(g, pts.slice(1, 7).map(([a, b]) => [a + (k - 1) * wTop * 0.22, b]), 0.9, 0.5, k === 2 ? '#a8a0a8' : '#efe6d8', 0.5);
      // a curl at the tip
      const [ex, ey] = pts[8]; line(g, [[ex, ey - 3], [ex + curl * 0.8, ey + 1], [ex + curl * 1.3, ey - 1.5]], 2.2, '#c8c0b8', 0.8);
    }
    g.fillStyle = lin(g, 0, 0, 0, 18, [[0, '#6a6470', 0.7], [1, '#6a6470', 0]]); g.fillRect(0, 0, s, 18);   // the chin shadow
    g.fillStyle = lin(g, 0, 0, s, 0, [[0, '#6a6470', 0.35], [0.16, '#6a6470', 0], [0.84, '#6a6470', 0], [1, '#6a6470', 0.35]]); g.fillRect(0, 0, s, s);
    blurTile(cv, 0.5);
  },
});
register('loot_gnomeface', {
  family: F, w: 256, h: 128, note: "the gnome's head (u wraps, front at the middle; v up): painted form, deep-set squinting eyes, big overhanging brows, white hair round the back",
  paint(g, w, rnd, h, cv) {
    const fx = w / 2, eu = gnomeEye.du * w, ey = (1 - gnomeEye.v) * h;
    // skin, turning cool toward the sides
    g.fillStyle = lin(g, 0, 0, w, 0, [[0, '#9a6a6a'], [0.3, '#a87068'], [0.4, '#d0946e'], [0.47, '#e2a67e'], [0.53, '#dc9e78'], [0.6, '#c08068'], [0.7, '#9a6a6a'], [1, '#9a6a6a']]); g.fillRect(0, 0, w, h);
    blob(g, fx - 10, ey - 12, 30, 15, -0.2, '#f0c09a', 0.75, 0.3);          // light on the brow and the left cheek
    blob(g, fx - 16, ey + 10, 12, 10, 0, '#f0c09a', 0.45, 0.3);
    blob(g, fx + 20, ey + 8, 14, 18, 0, '#8a5a60', 0.4, 0.3);              // cool shade on the far cheek
    for (const sx of [-1, 1]) blob(g, fx + sx * 17, ey + 11, 9, 6, 0, '#d8806a', 0.45, 0.3);   // rosy cheeks
    for (const sx of [-1, 1]) blob(g, fx + sx * eu, ey - 1, 9, 4.5, 0, '#8a5a5a', 0.65, 0.3);  // deep sockets under the brow
    // eyes: happy squinting slits with a warm catchlight, deep under the brow
    for (const sx of [-1, 1]) {
      const x = fx + sx * eu;
      blob(g, x, ey, 8, 4.5, 0, '#7a4a4a', 0.55, 0.3);
      stroke(g, [[x - 5.5, ey + 1.2], [x - 2, ey - 1.4], [x + 2, ey - 1.4], [x + 5.5, ey + 1.2]], 3.2, 2.4, '#2a1a18', 0.95);
      ellipse(g, x - 1.4 * sx, ey - 0.9, 0.9, 0.8, 0, '#ffe0b8', 0.95);
      line(g, [[x - 4.5, ey + 3.4], [x + 4.5, ey + 3.4]], 0.9, '#b87a68', 0.6);
    }
    // bushy white brows, big, overhanging the eyes, flaring outward
    for (const sx of [-1, 1]) {
      const bx = fx + sx * (eu + 1), by = ey - 8;
      blob(g, bx + 1, by + 3.5, 11, 3.5, 0, '#6a4a50', 0.5, 0.3);
      for (let k = 0; k < 14; k++) {
        const t = k / 13, x = bx - sx * 7 + sx * t * 15, y = by - Math.sin(t * Math.PI) * 2.5 + range(rnd, -0.8, 0.8);
        blade(g, x, y + 1.5, range(rnd, 6, 10), sx * range(rnd, 1.15, 1.6), range(rnd, 2.2, 3.2), pick(rnd, ['#f4efe6', '#ffffff', '#d8d0c4', '#e8e2d6']), 0.95, sx * 0.35);
      }
    }
    for (const dy of [-12, -16]) line(g, [[fx - 10, ey + dy], [fx, ey + dy - 1.5], [fx + 10, ey + dy]], 1, '#a86a5a', 0.35);   // forehead wrinkles
    // white hair round the back of the head and over the ears, under the hat
    const hair = (x0, x1) => {
      for (let i = 0; i < 46; i++) {
        const x = range(rnd, x0, x1), y0 = range(rnd, 2, 26), L = range(rnd, 40, 80), c = pick(rnd, ['#e8e2d6', '#d8d0c4', '#f4efe6', '#b8b0b0']);
        const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([x + Math.sin(t * 3 + x) * 3, y0 + L * t]); }
        stroke(g, pts, range(rnd, 5, 8), 1.5, c, 0.85);
      }
      for (let i = 0; i < 12; i++) { const x = range(rnd, x0, x1); stroke(g, [[x, range(rnd, 8, 30)], [x + 2, range(rnd, 50, 80)]], 2, 0.6, '#fff8ec', 0.6); }
    };
    hair(-4, w * 0.29); hair(w * 0.71, w + 4);
    g.fillStyle = lin(g, 0, 0, 0, 24, [[0, '#d8d0c4', 0.8], [1, '#d8d0c4', 0]]); g.fillRect(0, 0, w, 24);
    blurTile(cv, 0.4);
  },
});
register('loot_gnomefur', {
  family: F, w: 128, h: 32, note: "the coat's fur collar (a torus; wraps both ways): clumped cream fur, cool shade between clumps",
  paint(g, w, rnd, h, cv) {
    fill(g, w, h, '#b8b0a4');
    for (let i = 0; i < 34; i++) {
      const x = rnd() * w, y = rnd() * h, a = range(rnd, -0.6, 0.6) + Math.PI, n = 6;
      wrap(w, x, y, 12, (X, Y) => {
        blob(g, X + 2, Y + 2, 9, 6, a, '#8a8494', 0.4, 0.3);
        for (let k = 0; k < n; k++) blade(g, X + (k - n / 2) * 1.6, Y - 3, range(rnd, 6, 10), a + range(rnd, -0.3, 0.3), 2.4, pick(rnd, ['#e8e0d0', '#f4ecdc', '#d8d0c0']), 0.95, 0.3);
        blob(g, X - 1.5, Y - 2.5, 3, 2, 0, '#fff8ec', 0.7, 0.4);
      });
    }
    blurTile(cv, 0.4);
  },
});

register('loot_skin', {
  family: F, size: 64, note: "rosy gnome skin (the bulbous nose, the ears), u wraps",
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#f0c09a'], [0.45, '#d8806a'], [1, '#9a5a5a']]); g.fillRect(0, 0, s, s);
    g.fillStyle = lin(g, 0, 0, s, 0, [[0, '#9a6a6a', 0.3], [0.5, '#9a6a6a', 0], [1, '#9a6a6a', 0.3]]); g.fillRect(0, 0, s, s);
    blob(g, s * 0.44, s * 0.36, 8, 5, 0, '#fff0d8', 0.6, 0.4);
    blurTile(cv, 0.6);
  },
});
register('loot_boot', {
  family: F, size: 64, note: 'dark brown leather: boots and mittens (u wraps)',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#8a6040'], [0.35, '#5a3a22'], [0.75, '#4a2c18'], [1, '#2a1a10']]); g.fillRect(0, 0, s, s);
    for (let i = 0; i < 10; i++) { const x = rnd() * s, y = rnd() * s, rx = range(rnd, 4, 10), ry = range(rnd, 2, 5); wrapX(s, x, rx, X => blob(g, X, y, rx, ry, 0, pick(rnd, ['#8a6040', '#3a2414']), 0.3, 0.3)); }
    blurTile(cv, 0.4);
  },
});

// ---- the velvet portrait -----------------------------------------------------------------------------

register('loot_portrait', {
  family: F, w: 384, h: 288, note: 'the Velvet Elvis, in big value blocks on black velvet: a black pompadour with blue rim light, sideburns, the sneer, the high white collar',
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#141020');
    g.fillStyle = radial(g, w * 0.5, h * 0.42, 20, w * 0.62, [[0, '#2a1e3a'], [0.55, '#1e1630'], [1, '#141020']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 24; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 30, 90), range(rnd, 20, 60), rnd() * 3, pick(rnd, ['#1c1630', '#241a38', '#181226']), 0.4, 0.1);
    blob(g, w * 0.57, h * 0.36, 125, 110, 0, '#28305e', 0.45, 0.1);
    const cx = w / 2, cy = 126;
    // --- the jumpsuit, the chest V, the great collar
    poly(g, [[cx - 176, h + 4], [cx - 164, h - 48], [cx - 112, h - 76], [cx - 40, h - 86], [cx + 40, h - 86], [cx + 112, h - 76], [cx + 164, h - 48], [cx + 176, h + 4]]);
    g.save(); g.fillStyle = lin(g, cx - 170, 0, cx + 170, 0, [[0, '#eeeae2'], [0.45, '#dcdce6'], [0.7, '#a8aec8'], [1, '#7a82a6']]); g.fill(); g.restore();
    blob(g, cx - 100, h - 30, 40, 20, 0, '#fffaf0', 0.4, 0.3);
    blob(g, cx + 110, h - 20, 40, 30, 0, '#5a6290', 0.4, 0.3);
    poly(g, [[cx - 24, h - 94], [cx + 2, h + 2], [cx + 28, h - 94]]); g.save(); g.fillStyle = lin(g, cx - 24, 0, cx + 28, 0, [[0, '#c89070'], [0.6, '#9a6a5c'], [1, '#6a4a5a']]); g.fill(); g.restore();
    line(g, [[cx - 24, h - 94], [cx + 2, h + 2], [cx + 28, h - 94]], 2.4, '#5a5a80', 0.7);
    // the neck, in shadow under the jaw
    poly(g, [[cx - 24, cy + 36], [cx + 28, cy + 36], [cx + 30, cy + 92], [cx - 28, cy + 92]]); g.save(); g.fillStyle = lin(g, cx - 24, 0, cx + 30, 0, [[0, '#c89070'], [0.5, '#a87462'], [1, '#6a4a5a']]); g.fill(); g.restore();
    blob(g, cx + 4, cy + 46, 30, 12, 0, '#6a4a5a', 0.7, 0.3);
    // the collar: two big smooth wedges standing up and out, studs in a deliberate line down each edge
    const L = [[cx - 30, cy + 94], [cx - 50, cy + 26], [cx - 100, cy + 6], [cx - 126, cy + 82], [cx - 84, cy + 104]];
    const Rr = L.map(([x, y]) => [2 * cx - x, y]);
    poly(g, L); g.save(); g.fillStyle = lin(g, cx - 40, 0, cx - 120, 0, [[0, '#9aa4c0'], [0.5, '#e4e2e8'], [1, '#f6f2e8']]); g.fill(); g.restore();
    poly(g, Rr); g.save(); g.fillStyle = lin(g, cx + 40, 0, cx + 124, 0, [[0, '#6a7090'], [0.6, '#aab0c8'], [1, '#c8cce0']]); g.fill(); g.restore();
    line(g, [Rr[1], Rr[2], Rr[3]], 3, '#8ab0e0', 0.55);
    line(g, [L[1], L[2]], 2, '#fffaf0', 0.7);
    const studs = (a, b, n) => { for (let k = 0; k <= n; k++) { const t = k / n, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t; ellipse(g, x + 0.8, y + 1, 2.8, 2.8, 0, '#4a3418'); ellipse(g, x, y, 2.6, 2.6, 0, '#d8b050'); blob(g, x - 0.8, y - 0.9, 1.1, 0.9, 0, '#fff4c8', 1, 0.5); } };
    const inset = (p, q, k) => [p[0] + (q[0] - p[0]) * k, p[1] + (q[1] - p[1]) * k];
    studs(inset(L[2], L[0], 0.08), inset(L[3], L[4], 0.12), 7); studs(inset(Rr[2], Rr[0], 0.08), inset(Rr[3], Rr[4], 0.12), 7);
    studs([cx - 30, h - 80], [cx - 8, h - 14], 5); studs([cx + 34, h - 80], [cx + 12, h - 14], 5);
    // --- the face: three tones, lit from the upper left
    const face = () => { g.beginPath(); g.moveTo(cx - 34, cy - 46); g.bezierCurveTo(cx - 46, cy - 20, cx - 46, cy + 10, cx - 38, cy + 30); g.bezierCurveTo(cx - 30, cy + 50, cx - 14, cy + 60, cx + 2, cy + 60);
      g.bezierCurveTo(cx + 18, cy + 60, cx + 32, cy + 48, cx + 38, cy + 28); g.bezierCurveTo(cx + 44, cy + 8, cx + 42, cy - 20, cx + 34, cy - 46); g.closePath(); };
    face(); g.save(); g.fillStyle = '#c08a6a'; g.fill(); g.clip();
    blob(g, cx - 16, cy - 10, 30, 46, 0.12, '#e8b890', 0.85, 0.4);
    blob(g, cx - 4, cy - 34, 28, 13, 0, '#f0c4a0', 0.6, 0.3);
    blob(g, cx - 6, cy + 42, 14, 12, 0, '#e8b890', 0.55, 0.3);
    blob(g, cx + 32, cy + 6, 16, 44, 0, '#6a4a5a', 0.75, 0.35);
    stroke(g, [[cx + 10, cy + 12], [cx + 22, cy + 22], [cx + 34, cy + 30]], 14, 5, '#6a4a5a', 0.5);
    blob(g, cx + 12, cy + 58, 30, 9, 0.2, '#6a4a5a', 0.5, 0.3);
    blob(g, cx + 44, cy, 5, 38, 0, '#8ab0e0', 0.55, 0.3);
    blob(g, cx - 18, cy - 8, 12, 6, 0, '#9a6a60', 0.6, 0.3); blob(g, cx + 18, cy - 8, 12, 6, 0, '#5a3a4a', 0.65, 0.3);
    g.restore();
    // eyes: heavy-lidded, two dark strokes; brows, one cocked
    stroke(g, [[cx - 28, cy - 8], [cx - 18, cy - 11.5], [cx - 8, cy - 8]], 3.4, 2.2, '#2a1a20', 0.95);
    stroke(g, [[cx + 8, cy - 9], [cx + 18, cy - 11.5], [cx + 28, cy - 7]], 3.4, 2.2, '#2a1a20', 0.95);
    ellipse(g, cx - 17, cy - 6.5, 2.6, 1.8, 0, '#2a1a20'); ellipse(g, cx + 17, cy - 7, 2.6, 1.8, 0, '#2a1a20');
    line(g, [[cx - 25, cy - 3], [cx - 11, cy - 3.5]], 1.2, '#e8b890', 0.5);
    stroke(g, [[cx - 31, cy - 19], [cx - 19, cy - 23], [cx - 7, cy - 20]], 4.5, 2.5, '#141018', 0.95);
    stroke(g, [[cx + 7, cy - 22], [cx + 18, cy - 29], [cx + 31, cy - 22]], 4.5, 2.5, '#141018', 0.95);
    // the nose: a lit ridge, the shadow side, the shadow under it
    stroke(g, [[cx - 3, cy - 6], [cx - 2, cy + 10], [cx, cy + 18]], 4, 3, '#f0c8a0', 0.6);
    blob(g, cx + 7, cy + 10, 6, 11, 0, '#6a4a5a', 0.5, 0.3);
    blob(g, cx + 1, cy + 22, 10, 3.6, 0, '#5a3438', 0.7, 0.3);
    ellipse(g, cx - 4, cy + 21, 1.8, 1.1, 0, '#3a2028'); ellipse(g, cx + 6, cy + 21, 1.8, 1.1, 0, '#3a2028');
    // the sneer: the upper lip raised on the left, a lit lower lip, its shadow
    g.save(); g.fillStyle = '#9a5a54'; g.beginPath(); g.moveTo(cx - 16, cy + 30); g.quadraticCurveTo(cx - 8, cy + 26, cx, cy + 31); g.quadraticCurveTo(cx + 8, cy + 30, cx + 15, cy + 33); g.lineTo(cx + 2, cy + 34); g.closePath(); g.fill(); g.restore();
    stroke(g, [[cx - 16, cy + 30], [cx - 9, cy + 33.5], [cx + 2, cy + 34.5], [cx + 15, cy + 33]], 2.6, 1.6, '#3a1a20', 0.95);
    blob(g, cx - 1, cy + 38.5, 9, 3.2, 0, '#d89a84', 0.75, 0.4);
    blob(g, cx + 2, cy + 44, 10, 3, 0, '#6a4a5a', 0.5, 0.3);
    // sideburns, long and black
    poly(g, [[cx - 40, cy - 26], [cx - 31, cy - 24], [cx - 30, cy + 26], [cx - 37, cy + 38], [cx - 45, cy + 14]]); g.fillStyle = '#14121c'; g.fill();
    poly(g, [[cx + 40, cy - 26], [cx + 31, cy - 24], [cx + 31, cy + 26], [cx + 38, cy + 38], [cx + 46, cy + 14]]); g.fill();
    line(g, [[cx + 46, cy + 14], [cx + 42, cy - 20]], 2, '#4a6aa8', 0.6);
    // --- the pompadour: one big black mass, a quiff rising high over the forehead and rolling back,
    // the sides slicked back; the velvet painter's blue rim light only along the top edge
    const hair = () => {
      g.beginPath(); g.moveTo(cx - 44, cy - 6);
      g.bezierCurveTo(cx - 56, cy - 36, cx - 56, cy - 70, cx - 44, cy - 92);      // up the left side
      g.bezierCurveTo(cx - 38, cy - 118, cx - 14, cy - 128, cx + 6, cy - 122);      // the quiff's crest
      g.bezierCurveTo(cx + 34, cy - 116, cx + 60, cy - 98, cx + 64, cy - 66);       // rolling back over the top
      g.bezierCurveTo(cx + 66, cy - 40, cx + 54, cy - 14, cx + 42, cy + 6);         // down the back to the temple
      g.lineTo(cx + 36, cy - 36);
      g.bezierCurveTo(cx + 26, cy - 52, cx + 8, cy - 60, cx - 8, cy - 62);          // the hairline under the quiff
      g.bezierCurveTo(cx - 22, cy - 64, cx - 30, cy - 52, cx - 34, cy - 40);        // the roll of the quiff's front lip
      g.bezierCurveTo(cx - 37, cy - 30, cx - 38, cy - 18, cx - 38, cy - 6); g.closePath();
    };
    hair(); g.save(); g.fillStyle = '#14121c'; g.fill(); g.clip();
    // strands: from the front lip up through the quiff and back, each its own curve
    for (let i = 0; i < 12; i++) {
      const o = i / 11, x0 = cx - 34 + o * 30 + range(rnd, -4, 4), y0 = cy - 46 - o * 10;
      const pts = [];
      for (let k = 0; k <= 12; k++) {
        const t = k / 12, a = t * Math.PI * 0.95;
        pts.push([x0 + (cx + 56 - x0) * (1 - Math.cos(a)) * 0.5 + Math.sin(a) * range(rnd, 4, 9) - o * 6, y0 - Math.sin(a) * (64 - o * 26) + t * t * (26 + o * 10)]);
      }
      stroke(g, pts, range(rnd, 2.5, 5), range(rnd, 1, 2), pick(rnd, ['#24223c', '#1c1a30', '#2c2a48', '#201e34']), 0.75);
    }
    for (let i = 0; i < 5; i++) { const y = cy - 30 + i * 9; stroke(g, [[cx - 50, y - 6], [cx - 44, y - 10], [cx - 36, y - 12]], 2, 1, '#2a2846', 0.6); stroke(g, [[cx + 56, y - 10], [cx + 48, y - 6], [cx + 40, y - 4]], 2, 1, '#2a2846', 0.6); }
    g.restore();
    // rim light: a few long broken strokes hugging the crest and the back of the head
    const rim = (pts, w0, c, a) => stroke(g, pts, w0, 0.6, c, a);
    rim([[cx - 40, cy - 98], [cx - 30, cy - 116], [cx - 10, cy - 124], [cx + 10, cy - 120]], 4, '#4a6aa8', 0.75);
    rim([[cx - 33, cy - 110], [cx - 18, cy - 121], [cx - 2, cy - 121]], 2, '#a8c8f0', 0.8);
    rim([[cx + 18, cy - 116], [cx + 40, cy - 108], [cx + 58, cy - 90], [cx + 62, cy - 72]], 3.5, '#4a6aa8', 0.7);
    rim([[cx + 34, cy - 110], [cx + 52, cy - 96], [cx + 59, cy - 80]], 1.6, '#8ab0e0', 0.75);
    rim([[cx + 63, cy - 58], [cx + 60, cy - 36], [cx + 52, cy - 16]], 2.4, '#4a6aa8', 0.55);
    rim([[cx - 30, cy - 50], [cx - 22, cy - 60], [cx - 8, cy - 62]], 1.6, '#4a6aa8', 0.5);     // light on the quiff's front roll
    brushify(g, w, h, rnd, { n: 1800, len: [3, 7], wid: [1.2, 2.4], alpha: 0.35, flow: (x, y) => Math.atan2(y - cy, x - cx) + Math.PI / 2 });
    letters(g, 'E.P.', w - 34, h - 16, 14, { rnd, jit: 0.06, shadow: 0, fill: ['#e8c870', '#c89a40', '#a87a30'], rim: '#1a1008', chip: 0.3, rough: 0.6 });
    glaze(g, w, h, '#ffe0c0', 0.06);
    blurTile(cv, 0.55);
  },
});

// The gilded frame's molding: u along the bar (one cell covers the long side, mitred corners cut
// it on the diagonal), v across the profile, top = the outer edge. Bands: outer roll with acanthus
// (y 2–29), fillet (29–32), cove (32–44), beads (44–56), the sight edge (56–64).
register('loot_gold', {
  family: F, w: 1008, h: 64, note: 'the gilded frame molding: an acanthus roll, a cove, a bead row, the sight edge (hand-placed, irregular)',
  paint(g, w, rnd, h, cv) {
    const U = '#4a3010', M = '#c89a3a', C = '#fff0b0';
    // the roll: lit along its top, falling into shade toward the fillet
    g.fillStyle = lin(g, 0, 0, 0, 30, [[0, '#5a3a10'], [0.1, '#e8c060'], [0.28, '#fff0b0'], [0.5, '#d8aa48'], [0.8, '#a8782a'], [1, '#6a4818']]); g.fillRect(0, 0, w, 30);
    // acanthus: irregular lobed leaves, overlapping, each with umber recesses and cream top-left edges
    let x = range(rnd, 0, 10);
    while (x < w + 20) {
      const L = range(rnd, 26, 40), H = range(rnd, 10, 14), cy = range(rnd, 14, 17), dir = rnd() < 0.85 ? 1 : -1, lobes = 3 + Math.floor(rnd() * 3);
      const pts = [];
      for (let k = 0; k <= 24; k++) {
        const t = k / 24, ang = t * TAU, base = 0.55 + 0.45 * Math.abs(Math.sin(ang * lobes / 2));
        pts.push([x + dir * (Math.cos(ang) * 0.5 + 0.5) * L * (0.7 + 0.3 * base), cy + Math.sin(ang) * H * 0.5 * base]);
      }
      poly(g, pts.map(([a, b]) => [a + 1.6, b + 1.8])); g.fillStyle = rgba(U, 0.7); g.fill();
      poly(g, pts); g.save(); g.fillStyle = lin(g, x, cy - H / 2, x + L * 0.4, cy + H / 2, [[0, '#f0d070'], [0.5, M], [1, '#8a6020']]); g.fill(); g.restore();
      const vein = []; for (let k = 0; k <= 6; k++) { const t = k / 6; vein.push([x + dir * t * L * 0.85, cy + Math.sin(t * Math.PI) * -2]); }
      line(g, vein, 1.4, U, 0.7);
      for (let k = 1; k < lobes; k++) { const t = k / lobes; line(g, [[x + dir * t * L * 0.8, cy - 1], [x + dir * (t * L * 0.8 + 4), cy - H * 0.38]], 1, U, 0.55); line(g, [[x + dir * t * L * 0.8, cy + 1], [x + dir * (t * L * 0.8 + 4), cy + H * 0.36]], 1, U, 0.5); }
      line(g, pts.slice(12, 20).map(([a, b]) => [a - 0.5, b - 0.6]), 1.2, C, 0.8);
      if (rnd() < 0.5) { const bx = x + dir * L * range(rnd, 0.95, 1.1); ellipse(g, bx + 1, cy + 1.5, 3.4, 3.4, 0, U, 0.6); ellipse(g, bx, cy, 3, 3, 0, '#e0b450'); blob(g, bx - 1, cy - 1.2, 1.4, 1.2, 0, C, 0.9, 0.4); }
      x += L * range(rnd, 0.72, 1.05);
    }
    // grime in the roll's recesses
    for (let i = 0; i < 60; i++) blob(g, rnd() * w, range(rnd, 6, 26), range(rnd, 2, 6), range(rnd, 1.5, 3), 0, '#3a2408', 0.3, 0.3);
    // fillet
    rect(g, 0, 29, w, 3, '#f0cc70'); line(g, [[0, 29.5], [w, 29.5]], 1, C, 0.9);
    // the cove: shaded at the top (it faces down there), lit at the bottom
    g.fillStyle = lin(g, 0, 32, 0, 44, [[0, '#3a2408'], [0.4, '#7a5418'], [0.85, '#d8aa48'], [1, '#f0cc70']]); g.fillRect(0, 32, w, 12);
    for (let i = 0; i < 160; i++) { const xx = rnd() * w; line(g, [[xx, 34], [xx + range(rnd, -1, 1), 41]], 0.7, rnd() < 0.5 ? U : '#c89a3a', 0.25); }
    // beads: pearls of slightly uneven size and spacing
    rect(g, 0, 44, w, 12, '#5a3a10');
    for (let bx = 3; bx < w; bx += range(rnd, 7.2, 8.8)) { const r = range(rnd, 3.1, 3.8); ellipse(g, bx + 1, 51, r + 0.6, r + 0.4, 0, '#2a1a08', 0.5); ellipse(g, bx, 50, r, r, 0, M); blob(g, bx - 1.1, 48.6, r * 0.55, r * 0.45, 0, C, 0.9, 0.4); }
    // the sight edge, falling away toward the picture
    g.fillStyle = lin(g, 0, 56, 0, h, [[0, '#f0cc70'], [0.3, '#b88a30'], [0.75, '#6a4818'], [1, '#3a2408']]); g.fillRect(0, 56, w, h - 56);
    line(g, [[0, 56.5], [w, 56.5]], 1, C, 0.7);
    // worn gilt showing the red bole, dust
    for (let i = 0; i < 30; i++) blob(g, rnd() * w, range(rnd, 2, 8), range(rnd, 2, 5), range(rnd, 1, 2), 0, '#8a3a22', 0.45, 0.5);
    for (let i = 0; i < 20; i++) blob(g, rnd() * w, range(rnd, 30, 60), range(rnd, 3, 8), range(rnd, 1.5, 3), 0, '#3a2a18', 0.2, 0.3);
    blurTile(cv, 0.35);
  },
});
register('loot_rosette', {
  family: F, size: 64, note: "a gilded acanthus rosette (the frame's corner cartouches), seen from the front",
  paint(g, s, rnd, h, cv) {
    rect(g, 0, 0, s, s, '#8a6020');
    const c = s / 2;
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * TAU - Math.PI / 2 + 0.2, lx = c + Math.cos(a) * 13, ly = c + Math.sin(a) * 13;
      g.save(); g.translate(lx, ly); g.rotate(a);
      g.beginPath(); g.ellipse(0, 0, 15, 10, 0, 0, TAU);
      g.fillStyle = lin(g, -12, -10, 10, 10, [[0, '#fff0b0'], [0.4, '#d8aa48'], [1, '#6a4818']]); g.fill();
      line(g, [[-10, 0], [12, 0]], 1.4, '#4a3010', 0.7); line(g, [[0, -1], [6, -7]], 1, '#4a3010', 0.5); line(g, [[0, 1], [6, 7]], 1, '#4a3010', 0.5);
      g.restore();
    }
    ellipse(g, c + 1, c + 1.5, 9, 9, 0, '#3a2408', 0.6); ellipse(g, c, c, 8, 8, 0, '#d8aa48');
    blob(g, c - 2.5, c - 3, 4, 3, 0, '#fff4c8', 0.9, 0.4);
    blurTile(cv, 0.5);
  },
});

// ---- guitar ------------------------------------------------------------------------------------------

register('loot_guitar', {
  family: F, w: 160, h: 256, note: "the signed guitar's top: amber spruce with a sunburst, rosette, pickguard, bridge, strings and a scrawled autograph",
  paint(g, w, rnd, h, cv) {
    const P = ([x, y]) => [(x + 0.5) * w, (1 - y) * h];
    const body = () => { const pts = GUITAR_OUTLINE.map(P); poly(g, pts); };
    rect(g, 0, 0, w, h, '#5a3018');
    clip(g, body, () => {
      rect(g, 0, 0, w, h, '#d8a860');
      for (let i = 0; i < 14; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 10, 30), range(rnd, 30, 70), 0, pick(rnd, ['#e4b870', '#c89450', '#e8c07a']), 0.3, 0.1);
      for (let x = 2; x < w; x += range(rnd, 2.5, 5)) line(g, [[x, 0], [x + (rnd() - 0.5) * 1.5, h]], range(rnd, 0.5, 1.2), rnd() < 0.6 ? '#a87840' : '#f0cc88', 0.28);
      const pts = GUITAR_OUTLINE.map(P);
      for (const [lw, a] of [[60, 0.16], [38, 0.22], [22, 0.3], [10, 0.38]]) { g.save(); g.lineWidth = lw; g.strokeStyle = rgba('#5a2a12', a); g.lineJoin = 'round'; poly(g, pts); g.stroke(); g.restore(); }
      const [hx, hy] = P([GUITAR_HOLE.x, GUITAR_HOLE.y]), hr = GUITAR_HOLE.r * w;
      g.save(); g.fillStyle = '#5a2412'; g.beginPath(); g.moveTo(hx + hr * 0.8, hy - hr * 0.3); g.quadraticCurveTo(hx + hr * 2.1, hy + hr * 0.4, hx + hr * 1.3, hy + hr * 1.7); g.quadraticCurveTo(hx + hr * 0.4, hy + hr * 1.8, hx + hr * 0.2, hy + hr * 1.05); g.closePath(); g.fill();
      g.clip(); for (let i = 0; i < 12; i++) blob(g, hx + hr * range(rnd, 0.4, 1.8), hy + hr * range(rnd, -0.2, 1.7), range(rnd, 2, 5), range(rnd, 1.5, 4), 0, '#b8642a', 0.6, 0.4); g.restore();
      for (const [r, c, lw] of [[1.55, '#3a2010', 2], [1.42, '#f0e2c0', 2], [1.3, '#3a2010', 3], [1.18, '#d8b070', 1.5]]) { g.save(); g.lineWidth = lw; g.strokeStyle = c; g.beginPath(); g.arc(hx, hy, hr * r, 0, TAU); g.stroke(); g.restore(); }
      for (let k = 0; k < 36; k++) { const a = k / 36 * TAU; ellipse(g, hx + Math.cos(a) * hr * 1.36, hy + Math.sin(a) * hr * 1.36, 1.2, 1.2, 0, k % 2 ? '#3a6a3a' : '#a83a2a', 0.9); }
      // the sound hole: deep warm brown, a brace glimpsed inside, the lit far rim
      g.fillStyle = radial(g, hx + 2, hy + 3, 2, hr, [[0, '#3a2418'], [1, '#2a1a12']]); g.beginPath(); g.arc(hx, hy, hr, 0, TAU); g.fill();
      g.save(); g.beginPath(); g.arc(hx, hy, hr, 0, TAU); g.clip();
      rect(g, hx - hr, hy + hr * 0.25, hr * 2, hr * 0.28, '#6a4a2a', 0.75); line(g, [[hx - hr, hy + hr * 0.25], [hx + hr, hy + hr * 0.25]], 1, '#a07848', 0.6);
      g.restore();
      g.save(); g.strokeStyle = rgba('#e8c088', 0.45); g.lineWidth = 1.5; g.beginPath(); g.arc(hx, hy, hr - 1, 0.2, Math.PI - 0.2); g.stroke(); g.restore();
      const [bx, by] = P([0, 0.24]);
      rrect(g, bx - 30, by - 7, 60, 14, 4, '#2a1810'); rrect(g, bx - 28, by - 6, 56, 11, 3, '#4a2a18');
      line(g, [[bx - 20, by - 3], [bx + 20, by - 3.5]], 2, '#f0e6cc', 0.95);
      for (let k = 0; k < 6; k++) ellipse(g, bx - 15 + k * 6, by + 2, 1.6, 1.6, 0, '#f0e6cc');
      for (let k = 0; k < 6; k++) {
        const x0 = bx - 13 + k * 5.2, x1 = w / 2 - 9 + k * 3.6;
        line(g, [[x0 + 0.8, by - 3], [x1 + 0.8, 0]], 0.9, '#2a1810', 0.4);
        line(g, [[x0, by - 3], [x1, 0]], k < 3 ? 1.1 : 0.8, '#ece4d4', 0.9);
      }
      const sg = []; const x0 = w * 0.12, y0 = h * 0.86;
      for (let t = 0; t <= 1; t += 0.008) { const k = t * 9 * Math.PI; sg.push([x0 + t * w * 0.62 - Math.sin(k) * 6, y0 - t * 18 + Math.cos(k) * 7 * (1 - t * 0.4)]); }
      line(g, sg, 2.2, '#141018', 0.85);
      line(g, [[x0 + 4, y0 + 12], [x0 + w * 0.7, y0 + 2]], 1.8, '#141018', 0.8);
    });
    { const pts = GUITAR_OUTLINE.map(P); g.save(); g.lineWidth = 3; g.strokeStyle = '#ece0c0'; g.lineJoin = 'round'; poly(g, pts); g.stroke(); g.lineWidth = 1; g.strokeStyle = '#3a2010'; g.stroke(); g.restore(); }
    glaze(g, w, h, '#ffe0b0', 0.08);
    blurTile(cv, 0.35);
  },
});

// ---- tire & wheel ------------------------------------------------------------------------------------

register('loot_tire', {
  family: F, w: 256, h: 128, note: 'a chunky whitewall tire (u wraps round it; v: bottom bead → sidewall → tread → sidewall → top bead): warm charcoal, chevron tread',
  paint(g, w, rnd, h, cv) {
    const Y = v => (1 - v) * h;
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#2e2a2c'], [0.3, '#3a3436'], [0.5, '#322c2e'], [0.7, '#3a3436'], [1, '#2e2a2c']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 20; i++) { const x = rnd() * w, y = rnd() * h, rx = range(rnd, 8, 20), ry = range(rnd, 4, 10), c = pick(rnd, ['#4a4244', '#262224', '#5a4a40']); wrapX(w, x, 20, X => blob(g, X, y, rx, ry, 0, c, 0.3, 0.2)); }
    for (const [a, b] of [TIRE_V.wallLo, TIRE_V.wallHi]) {
      g.fillStyle = lin(g, 0, Y(b), 0, Y(a), [[0, '#c8bca4'], [0.3, '#ece2cc'], [1, '#b8ac94']]); g.fillRect(0, Y(b), w, Y(a) - Y(b));
      for (let i = 0; i < 14; i++) { const x = rnd() * w, y = range(rnd, Y(b), Y(a)), rx = range(rnd, 4, 10); wrapX(w, x, 10, X => blob(g, X, y, rx, 2.5, 0, '#8a7a64', 0.35, 0.3)); }
      line(g, [[0, Y(b)], [w, Y(b)]], 1.2, '#1e1a1c', 0.6); line(g, [[0, Y(a)], [w, Y(a)]], 1.2, '#1e1a1c', 0.6);
    }
    // tread: chevron blocks (each half slants the other way), lit with cool light on their top edges
    const t0 = Y(TIRE_V.treadHi), t1 = Y(TIRE_V.treadLo), th = t1 - t0, mid = (t0 + t1) / 2, n = 14, bw = w / n;
    rect(g, 0, t0, w, th, '#1e1a1c');
    for (let i = 0; i < n; i++) for (const half of [-1, 1]) {
      const x = i * bw, c = jitter('#3a3436', rnd, 0.05), sl = bw * 0.35;
      const yA = half < 0 ? t0 + 2 : mid + 1.5, yB = half < 0 ? mid - 1.5 : t1 - 2;
      const q = half < 0 ? [[x + 2 + sl, yA], [x + bw - 2 + sl, yA], [x + bw - 2, yB], [x + 2, yB]] : [[x + 2, yA], [x + bw - 2, yA], [x + bw - 2 + sl, yB], [x + 2 + sl, yB]];
      for (const off of [0, -w, w]) {
        const qq = q.map(([a, b]) => [a + off, b]);
        poly(g, qq); g.save(); g.fillStyle = lin(g, qq[0][0], yA, qq[0][0] + bw * 0.5, yB, [[0, '#56585e'], [0.35, c], [1, '#262224']]); g.fill(); g.restore();
        line(g, [qq[0], qq[1]], 1.4, '#6a6e7a', 0.75);
        line(g, [qq[0], qq[3]], 1, '#6a6e7a', 0.4);
      }
    }
    for (let i = 0; i < 32; i++) for (const y of [t0 - 3, t1 + 3]) { const x = i * w / 32; line(g, [[x, y - 2], [x, y + 2]], 1.2, '#1e1a1c', 0.7); }
    for (let i = 0; i < 18; i++) { const x = rnd() * w, y = range(rnd, t0, h), rx = range(rnd, 4, 12), ry = range(rnd, 2, 4); wrapX(w, x, 10, X => blob(g, X, y, rx, ry, 0, '#8a7458', 0.18, 0.3)); }
    blurTile(cv, 0.35);
  },
});

register('loot_rim', {
  family: F, size: 128, note: 'the steel wheel seen face on: painted steel dish, a dark hub well, five lug nuts, a red pinstripe ring, the brass goblin hubcap',
  paint(g, s, rnd, h, cv) {
    const c = s / 2;
    rect(g, 0, 0, s, s, '#3a3436');
    g.fillStyle = radial(g, c - s * 0.08, c - s * 0.08, s * 0.05, s * 0.55, [[0, '#c8ccd0'], [0.5, '#9aa0a6'], [0.85, '#6a6e76'], [1, '#3a3e46']]); g.beginPath(); g.arc(c, c, s * 0.5, 0, TAU); g.fill();
    g.save(); g.lineWidth = 2; g.strokeStyle = rgba('#b8402a', 0.9); g.beginPath(); g.arc(c, c, s * 0.41, 0, TAU); g.stroke(); g.restore();
    g.save(); g.lineWidth = 3; g.strokeStyle = rgba('#3a3e46', 0.7); g.beginPath(); g.arc(c, c, s * 0.46, 0, TAU); g.stroke(); g.restore();
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + 0.26; ellipse(g, c + Math.cos(a) * s * 0.34, c + Math.sin(a) * s * 0.34, 5.5, 4, a, '#2a2c32', 0.85); }
    g.fillStyle = radial(g, c + 3, c + 3, s * 0.05, s * 0.27, [[0, '#2a2c32'], [0.7, '#3a3e46'], [1, '#6a6e76', 0]]); g.beginPath(); g.arc(c, c, s * 0.27, 0, TAU); g.fill();
    for (let i = 0; i < 8; i++) { const a = rnd() * TAU, r = range(rnd, 0.28, 0.46) * s; blob(g, c + Math.cos(a) * r, c + Math.sin(a) * r, range(rnd, 3, 8), range(rnd, 2, 4), a, '#8a4a2a', 0.4, 0.4); }
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * TAU - Math.PI / 2, x = c + Math.cos(a) * s * 0.2, y = c + Math.sin(a) * s * 0.2, hx = [];
      for (let m = 0; m < 6; m++) { const b = m / 6 * TAU; hx.push([x + Math.cos(b) * 4.5, y + Math.sin(b) * 4.5]); }
      poly(g, hx.map(([p, q]) => [p + 1, q + 1.2])); g.fillStyle = rgba('#141418', 0.6); g.fill();
      poly(g, hx); g.save(); g.fillStyle = lin(g, x - 4, y - 4, x + 4, y + 4, [[0, '#e0e2e6'], [0.5, '#9a9ea6'], [1, '#4a4e58']]); g.fill(); g.restore();
    }
    ellipse(g, c + 1.5, c + 2, s * 0.13, s * 0.13, 0, '#3a2410', 0.6);
    g.fillStyle = radial(g, c - 4, c - 4, 1, s * 0.13, [[0, '#fff0b0'], [0.5, '#d8a840'], [1, '#8a6420']]); g.beginPath(); g.arc(c, c, s * 0.12, 0, TAU); g.fill();
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; line(g, [[c + Math.cos(a) * s * 0.05, c + Math.sin(a) * s * 0.05], [c + Math.cos(a) * s * 0.1, c + Math.sin(a) * s * 0.1]], 2, '#7a5418', 0.7); }
    blurTile(cv, 0.4);
  },
});

// ---- the dinosaur's head -------------------------------------------------------------------------------

// The statue's own hide (rs_dino from the roadside family) so the head matches the body it came off.
// u runs along the head, v from the belly (bottom) to the back (top).
function dinoHide(g, s, rnd) {
  g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#45703a'], [0.3, '#548442'], [0.55, '#629048'], [0.66, '#94a058'], [0.74, '#d0c088'], [1, '#dccc96']]); g.fillRect(0, 0, s, s);
  mottle(g, s, rnd, { colors: ['#6e9c4c', '#4a7a3a', '#7aa456', '#5a8040'], count: 40, rmin: 14, rmax: 46, alpha: 0.3, hard: 0.1, stretch: 1.6, rot: Math.PI / 2 });
  for (let i = 0; i < 5; i++) {
    const x = (i + 0.2 + rnd() * 0.6) * s / 5, wd = range(rnd, 18, 26), L = range(rnd, 0.3, 0.42) * s, bend = range(rnd, 10, 22);
    for (let k = 0; k <= 10; k++) { const tt = k / 10, cx = x + tt * bend, cy = tt * L, r = wd * (1 - tt * 0.45) / 2; wrap(s, cx, cy, r * 1.4, (X, Y) => blob(g, X, Y, r, r * 0.9, 0.3, '#2e4a28', 0.4, 0.45)); }
  }
  const cols = 11, W = s / cols;
  for (let row = 0; row < 8; row++) {
    const y = 10 + row * 21, off = row % 2 ? W / 2 : 0;
    for (let i = 0; i < cols; i++) {
      const x = i * W + off + range(rnd, -2, 2), yy = y + range(rnd, -2, 2), sc = range(rnd, 0.85, 1.1);
      wrap(s, x, yy, W, (X, Y) => { blob(g, X + 2, Y + 4, W * 0.5 * sc, W * 0.36 * sc, 0, '#1e2a1a', 0.18, 0.3); blob(g, X - 2, Y - 3, W * 0.32 * sc, W * 0.18 * sc, 0, '#c8dc90', 0.28, 0.35); });
    }
  }
  for (let y = s * 0.74; y < s; y += range(rnd, 11, 16)) {
    const pts = []; for (let x = -4; x <= s + 4; x += 8) pts.push([x, y + Math.sin(x / 23 + y) * 1.6]);
    g.fillStyle = lin(g, 0, y, 0, y + 14, [[0, '#f4e6b8', 0.6], [0.4, '#dccc96', 0], [0.85, '#8a7a50', 0.35], [1, '#5a4a34', 0.5]]);
    g.save(); g.beginPath(); g.moveTo(-4, y + 14); for (const p of pts) g.lineTo(p[0], p[1]); g.lineTo(s + 4, y + 14); g.closePath(); g.fill(); g.restore();
  }
  for (let i = 0; i < 12; i++) chips(g, rnd, 1, 4, 4, s - 8, s - 8, '#a49c90', 3, 8, 0.85);
  cracks(g, s, rnd, { color: '#3a3430', count: 4, len: [16, 44], width: [0.8, 1.4], alpha: 0.4 });
  streaks(g, s, rnd, { colors: ['#3a4a2e', '#6a5a40'], count: 14, len: [20, 60], width: [2, 4], angle: Math.PI, wobble: 0.1, alpha: 0.12 });
  glaze(g, s, s, '#ffe8b8', 0.1);
}
register('loot_dino', {
  family: F, size: 256, note: "the fiberglass sauropod's hide: the statue's own (rs_dino) so the head matches its body; u along, v belly → back",
  paint(g, s, rnd, h, cv) {
    if (has('rs_dino')) { g.drawImage(canvasFor('rs_dino'), 0, 0, s, s); return; }
    dinoHide(g, s, rnd); blurTile(cv, 0.6);
  },
});
register('loot_eye', {
  family: F, w: 128, h: 64, note: 'the fiberglass statue\'s goofy eye (a sphere: u wraps, front in the middle): cream, a big amber iris, a round pupil, a catchlight',
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#c8bc98'], [0.5, '#f0e6cc'], [1, '#a89c80']]); g.fillRect(0, 0, w, h);
    const x = w / 2, y = h / 2;
    ellipse(g, x + 1, y + 1, 15, 15, 0, '#5a3a14', 0.6);
    g.fillStyle = radial(g, x - 3, y - 3, 1, 15, [[0, '#f0c050'], [0.6, '#d0902a'], [1, '#7a4a14']]); g.beginPath(); g.arc(x, y, 14, 0, TAU); g.fill();
    ellipse(g, x + 0.5, y + 0.5, 7.5, 7.5, 0, '#1a100c');
    blob(g, x - 4, y - 4, 3.6, 3, 0, '#fffbe8', 0.95, 0.5);
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#4a3020', 0.35], [0.3, '#4a3020', 0], [1, '#4a3020', 0]]); g.fillRect(0, 0, w, h);
    blurTile(cv, 0.4);
  },
});
register('loot_ivory', {
  family: F, size: 64, note: 'ivory / old bone: teeth, key caps, tuning pegs (u wraps)',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#fff8e8'], [0.5, '#e8dcc0'], [1, '#a89878']]); g.fillRect(0, 0, s, s);
    for (let i = 0; i < 6; i++) { const x = rnd() * s, y = rnd() * s, rx = range(rnd, 4, 10), ry = range(rnd, 3, 6); wrapX(s, x, rx, X => blob(g, X, y, rx, ry, 0, '#c8b890', 0.35, 0.3)); }
    blurTile(cv, 0.5);
  },
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
  family: F, w: 256, h: 64, note: 'two engraved brass plates: left "No.1" (the trophy), right "$ 25" (spare)',
  paint(g, w, rnd, h, cv) {
    for (const [x0, txt] of [[0, 'No.1'], [w / 2, '$ 25']]) {
      g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#f0d488'], [0.5, '#c8a050'], [1, '#8a6628']]); g.fillRect(x0, 0, w / 2, h);
      molding(g, x0 + 2, 2, w / 2 - 4, h - 4, '#c8a050', 6);
      letters(g, txt, x0 + w / 4, h / 2 + 1, 30, { rnd, jit: 0.03, fill: ['#6a4818', '#4a2e10', '#2a1a08'], rim: '#fff0b8', lit: '#3a2410', shadow: 0, chip: 0.2, rough: 0.5, maxW: w / 2 - 22 });
    }
    blurTile(cv, 0.3);
  },
});
register('loot_crest', {
  family: F, w: 192, h: 96, note: "the cash register's arched brass crest: scrollwork round a window showing the $ 25 pop-up tab",
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#f0d488'], [0.4, '#c8a050'], [1, '#7a5a24']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) { const x = rnd() * w, y = rnd() * h; line(g, [[x, y], [x + range(rnd, 6, 20), y]], 0.7, rnd() < 0.5 ? '#fff0b8' : '#6a4a1a', 0.2); }
    // scrolls either side of the window
    for (const sx of [-1, 1]) for (let k = 0; k < 2; k++) {
      const x = w / 2 + sx * (52 + k * 26), y = h * 0.62 - k * 8, pts = [];
      for (let m = 0; m <= 16; m++) { const a = m / 16 * TAU * 0.9, r = 3 + m * 0.75; pts.push([x + sx * Math.cos(a) * r, y + Math.sin(a) * r]); }
      line(g, pts.map(([a, b]) => [a + 1, b + 1.3]), 3.4, '#4a3010', 0.6); line(g, pts, 3, '#d8aa48'); line(g, pts.map(([a, b]) => [a - 0.6, b - 0.8]), 1, '#fff0b8', 0.85);
    }
    // the window and the tab
    const wx = w / 2 - 34, wy = h * 0.3, ww = 68, wh = 42;
    rrect(g, wx - 5, wy - 5, ww + 10, wh + 10, 8, '#8a6628'); molding(g, wx - 5, wy - 5, ww + 10, wh + 10, '#c8a050', 5);
    rect(g, wx, wy, ww, wh, '#1e140c');
    rrect(g, wx + 5, wy + 4, ww - 10, wh - 6, 3, '#f0e6cc');
    letters(g, '$ 25', w / 2, wy + wh / 2 + 1, 24, { rnd, jit: 0.03, fill: ['#3a2a20', '#2a1a14', '#1a100c'], rim: '#f8f0dc', lit: '#f8f0dc', shadow: 0, chip: 0, rough: 0.4, maxW: ww - 16 });
    bevel(g, 0, 0, w, h, '#c8a050', 6, 0.4, 0.5);
    blurTile(cv, 0.35);
  },
});
register('loot_regdeck', {
  family: F, w: 256, h: 128, note: "the cash register's brass key deck: embossed C-scrolls and a border, GOBLIN CASH Co. on a little cartouche",
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, w * 0.4, h, [[0, '#f0d488'], [0.5, '#c8a050'], [1, '#8a6628']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) { const x = rnd() * w, y = rnd() * h; line(g, [[x, y], [x + range(rnd, 6, 24), y]], 0.7, rnd() < 0.5 ? '#fff0b8' : '#6a4a1a', 0.2); }
    molding(g, 3, 3, w - 6, h - 6, '#c8a050', 7);
    for (let i = 0; i < 14; i++) {
      const x = range(rnd, 20, w - 20), y = range(rnd, 16, h - 16), sx = rnd() < 0.5 ? -1 : 1, pts = [];
      for (let m = 0; m <= 14; m++) { const a = m / 14 * TAU * 0.85, r = 2 + m * 0.65; pts.push([x + sx * Math.cos(a) * r, y + Math.sin(a) * r]); }
      line(g, pts.map(([a, b]) => [a + 0.8, b + 1]), 2.2, '#5a3a10', 0.45); line(g, pts.map(([a, b]) => [a - 0.5, b - 0.6]), 1.2, '#fff0b8', 0.7);
    }
    rrect(g, w / 2 - 50, h - 30, 100, 18, 5, '#7a5418'); molding(g, w / 2 - 50, h - 30, 100, 18, '#b08a40', 3);
    g.save(); g.font = `bold 9px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#2a1a08'; g.fillText('GOBLIN CASH Co.', w / 2 + 0.6, h - 20.4); g.fillStyle = '#f8e090'; g.fillText('GOBLIN CASH Co.', w / 2, h - 21); g.restore();
    glaze(g, w, h, '#ffe8b0', 0.1);
    blurTile(cv, 0.4);
  },
});
register('loot_keys', {
  family: F, w: 256, h: 64, note: "the register's ivory key caps from above, 8 × 2: digits and coins in dark enamel",
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#c8b890');
    for (let i = 0; i < 16; i++) {
      const x = (i % 8) * 32 + 16, y = Math.floor(i / 8) * 32 + 16;
      g.fillStyle = radial(g, x - 4, y - 5, 1, 15, [[0, '#fffbee'], [0.6, '#eadfc4'], [1, '#b8a880']]); g.fillRect(x - 16, y - 16, 32, 32);
      g.save(); g.strokeStyle = rgba('#7a6a48', 0.7); g.lineWidth = 2; g.beginPath(); g.arc(x, y, 13.5, 0, TAU); g.stroke(); g.restore();
      const t = KEY_LABELS[i];
      g.save(); g.font = `bold ${t.length > 2 ? 9 : t.length > 1 ? 11 : 15}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#fff8e8'; g.fillText(t, x - 0.5, y + 0.5); g.fillStyle = '#2a1a14'; g.fillText(t, x, y + 1); g.restore();
    }
    blurTile(cv, 0.3);
  },
});
register('loot_till', {
  family: F, w: 256, h: 64, note: "the cash drawer's front: a raised oak panel, a brass bail pull, a keyhole, CASH in faded gilt",
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#6a4428');
    grain(g, 0, 0, w, h, rnd, { dark: ['#3e2616', '#4a2e1a'], lite: ['#8a6040', '#a07450'], n: 18, amp: 1.5, knots: 1 });
    bevel(g, 0, 0, w, h, '#6a4428', 6, 0.45, 0.55);
    molding(g, 10, 8, w - 20, h - 16, '#7a5232', 5);
    const cx = w / 2, cy = h / 2;
    for (const sx of [-1, 1]) { ellipse(g, cx + sx * 24 + 1, cy - 6 + 1, 6, 4.5, 0, '#2a1a08', 0.6); ellipse(g, cx + sx * 24, cy - 6, 5.5, 4, 0, '#d8b060'); }
    const bail = []; for (let k = 0; k <= 12; k++) { const a = Math.PI * k / 12; bail.push([cx - Math.cos(a) * 24, cy - 6 + Math.sin(a) * 14]); }
    line(g, bail.map(([x, y]) => [x + 1.2, y + 1.6]), 3.5, '#2a1a08', 0.5); line(g, bail, 3, '#c8a050', 1); line(g, bail.map(([x, y]) => [x - 0.6, y - 0.8]), 1, '#fff0b8', 0.8);
    ellipse(g, 40, cy, 8, 10, 0, '#c8a050'); ellipse(g, 40, cy - 2, 2.2, 2.2, 0, '#1a1008'); line(g, [[40, cy - 1], [40, cy + 5]], 2, '#1a1008');
    letters(g, 'CASH', w - 52, cy + 1, 16, { rnd, jit: 0.04, shadow: 0.3, track: 2, fill: ['#f0d080', '#c8983c', '#8a5a1e'], board: '#6a4428', chip: 1.2 });
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
  family: F, w: 128, h: 64, note: 'a deep indigo bowling ball (a sphere: u wraps, front in the middle; v up): violet swirls, three finger holes, a cream highlight upper left',
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#3a2a5a'], [0.5, '#2a1e4a'], [1, '#1a1230']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 16; i++) {
      const pts = []; let x = rnd() * w, y = rnd() * h, a = rnd() * TAU;
      for (let k = 0; k < 9; k++) { pts.push([x, y]); a += range(rnd, -0.5, 0.5); x += Math.cos(a) * 6; y += Math.sin(a) * 3; }
      const c = pick(rnd, ['#6a4aa0', '#4a3480', '#8a6ac0']), wd = range(rnd, 2, 4.5);
      for (const off of [0, -w, w]) stroke(g, pts.map(([p, q]) => [p + off, q]), wd, 1, c, 0.45);
    }
    const fx = w / 2, fy = h * 0.4;
    for (const [dx, dy] of [[-6, -4], [6, -4], [0, 7]]) {
      ellipse(g, fx + dx, fy + dy, 3.4, 3.4, 0, '#0e0818');
      line(g, [[fx + dx - 2.6, fy + dy + 2], [fx + dx + 2.6, fy + dy + 2.2]], 1.1, '#8a7ac8', 0.6);
    }
    blob(g, fx - 14, fy - 9, 9, 5, -0.3, '#f8ecd8', 0.75, 0.35);
    blob(g, fx - 16, fy - 10, 3.5, 2, -0.3, '#fffbf0', 0.95, 0.5);
    blurTile(cv, 0.4);
  },
});
register('loot_rubber', {
  family: F, size: 64, note: 'dark rubber / black iron for rods, sockets and brackets (u wraps)',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#4e464a'], [0.5, '#2e282c'], [1, '#1c181e']]); g.fillRect(0, 0, s, s);
    for (let i = 0; i < 6; i++) { const x = rnd() * s, y = rnd() * s, rx = range(rnd, 4, 10), ry = range(rnd, 2, 5); wrapX(s, x, rx, X => blob(g, X, y, rx, ry, 0, '#5a5258', 0.3, 0.3)); }
    blurTile(cv, 0.4);
  },
});
register('loot_parchment', {
  family: F, size: 64, note: "parchment for the map's edges and the luggage tag",
  paint(g, s, rnd, h, cv) { fill(g, s, s, '#e4cc98'); mottle(g, s, rnd, { colors: ['#d8bc84', '#f0dcaa', '#c8a870'], count: 12, rmin: 6, rmax: 18, alpha: 0.4 }); blurTile(cv, 0.5); },
});
register('loot_tag', {
  family: F, size: 64, note: 'a parchment luggage tag with a big question mark',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e4cc98'); mottle(g, s, rnd, { colors: ['#d8bc84', '#f0dcaa', '#c8a870'], count: 10, rmin: 6, rmax: 16, alpha: 0.4 });
    ellipse(g, s / 2, 9, 4, 4, 0, '#8a6a40'); ellipse(g, s / 2, 9, 2.4, 2.4, 0, '#3a2a1a');
    letters(g, '?', s / 2, s * 0.6, 40, { rnd, jit: 0.06, fill: ['#d8604a', '#b8402a', '#7a2a1e'], rim: '#5a1a10', lit: '#f8e0c0', shadow: 0.25, chip: 0.3 });
    bevel(g, 0, 0, s, s, '#e4cc98', 4, 0.3, 0.45); blurTile(cv, 0.4);
  },
});

// ---- the atlas -------------------------------------------------------------------------------------------

register('loot_atlas', {
  family: F, w: ATLAS_W, h: ATLAS_H, note: 'every loot piece in one texture (one draw call per prop): 1:1 cells with 8 px dilated padding',
  paint(g, w, rnd, h) {
    g.fillStyle = '#5a4a40'; g.fillRect(0, 0, w, h);
    for (const R of Object.values(REGIONS)) {
      const src = canvasFor('loot_' + R.key), cx = R.x + PAD, cy = R.y + PAD, cw = R.cw, ch = R.ch;
      g.save(); g.beginPath(); g.rect(R.x, R.y, R.w, R.h); g.clip();
      g.drawImage(src, R.x, R.y, R.w, R.h);
      if (R.wrap) { g.drawImage(src, cx - cw, cy, cw, ch); g.drawImage(src, cx + cw, cy, cw, ch); }
      else { g.drawImage(src, 0, 0, 1, ch, R.x, cy, PAD, ch); g.drawImage(src, cw - 1, 0, 1, ch, cx + cw, cy, PAD, ch); }
      g.drawImage(src, 0, 0, cw, 1, R.x, R.y, R.w, PAD); g.drawImage(src, 0, ch - 1, cw, 1, R.x, cy + ch, R.w, PAD);
      if (R.wrap) { g.drawImage(src, 0, 0, cw, 1, cx, R.y, cw, PAD); g.drawImage(src, 0, ch - 1, cw, 1, cx, cy + ch, cw, PAD); }
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
      const pad = key === 'glass' || key === 'lantern' || key === 'bulb' || key === 'bulbs' ? PAD / 4 : 0;
      const cx = (R.x + PAD) / 4, cy = (R.y + PAD) / 4, cw = R.cw / 4, ch = R.ch / 4;
      g.save(); g.globalAlpha = alpha;
      g.drawImage(src, sx * S, sy * T, sw * S, sh * T, cx + sx * cw - (sx === 0 ? pad : 0), cy + sy * ch - (sy === 0 ? pad : 0), sw * cw + (sx === 0 ? pad : 0) + (sx + sw >= 1 ? pad : 0), sh * ch + (sy === 0 ? pad : 0) + (sy + sh >= 1 ? pad : 0));
      g.restore();
    };
    put('glass', 0.42); put('lantern', 0.9); put('bulb', 1); put('screen', 0.18); put('bulbs', 0.4);
    put('slot', 0.3, 0, 0, 1, 0.2); put('slot', 0.2, 0.06, 0.24, 0.88, 0.28); put('slotback', 0.25, 0, 0, 1, 0.2);
  },
});

// ---- boulders, one per biome ----------------------------------------------------------------------------

// The stone: the world's own rock (nature family) when it's there, the zone's character painted over
// it (strata, lichen, wind grooves, cold cracks). v = height, so bands stay level.
const BOULDER = {
  meadow: { rock: 'rock_gray', base: '#77746e', cols: ['#97918a', '#6a675f', '#8a857c'], ground: '#4a4030' },
  fields: { rock: 'rock_warm', base: '#8a8170', cols: ['#9a9080', '#766e60', '#a49a86'], ground: '#7a6040' },
  snow: { rock: 'rock_granite', base: '#6f7682', cols: ['#8e96a3', '#5e6470', '#7a828e'], ground: '#5a5e6a' },
  badlands: { rock: 'rock_red', base: '#a04a2a', cols: ['#b4552f', '#8e3e22', '#cf7a45'], ground: '#8a5a38' },
  desert: { rock: 'rock_sand', base: '#b7895e', cols: ['#d4ab7c', '#a87a50', '#c89a6a'], ground: '#b89060' },
};
function boulderPaint(g, w, rnd, h, biome) {
  const B = BOULDER[biome];
  const Y = v => (1 - v) * h;
  if (has(B.rock)) { const src = canvasFor(B.rock); g.drawImage(src, 0, 0, w / 2, h); g.drawImage(src, w / 2, 0, w / 2, h); }
  else fill(g, w, h, B.base);
  // big soft facets: lit planes and cool shaded ones
  for (let i = 0; i < 20; i++) {
    const x = rnd() * w, y = range(rnd, 0.15, 0.85) * h, rx = range(rnd, 20, 60), ry = range(rnd, 14, 40), a = range(rnd, -0.5, 0.5), c = lightOf(pick(rnd, B.cols), 0.25);
    wrapX(w, x, rx * 1.5, X => { blob(g, X + rx * 0.3, y + ry * 0.35, rx, ry, a, shadowOf(B.base, 0.45), 0.2, 0.3); blob(g, X - rx * 0.2, y - ry * 0.25, rx * 0.8, ry * 0.7, a, c, 0.2, 0.3); });
  }
  if (biome === 'badlands' || biome === 'desert') {
    // strata: uneven bands, each with a lit top edge and a dark under-ledge, wobbling
    const pal = biome === 'badlands' ? ['#8e3e22', '#b4552f', '#cf7a45', '#a8482a', '#c06a3a'] : ['#c8a070', '#d4ab7c', '#b7895e', '#e0bc8c', '#a87a50'];
    const litC = biome === 'badlands' ? '#e3a066' : '#f0d4a4', darkC = biome === 'badlands' ? '#6a2a16' : '#7a5a3a';
    let y = range(rnd, -10, 0);
    const ph = rnd() * TAU;
    while (y < h) {
      const t = range(rnd, 4, 30), c = pick(rnd, pal), wob = x => Math.sin(x / w * TAU * 2 + ph + y * 0.05) * 2.2 + Math.sin(x / w * TAU * 5 + y) * 0.9;
      const top = [], bot = [];
      for (let x = 0; x <= w; x += 8) { top.push([x, y + wob(x)]); bot.push([x, y + t + wob(x + 40)]); }
      g.save(); g.globalAlpha = biome === 'badlands' ? 0.55 : 0.4; g.fillStyle = c; poly(g, [...top, ...bot.slice().reverse()]); g.fill(); g.restore();
      line(g, top, range(rnd, 1.2, 2.2), litC, 0.55);
      line(g, bot.map(([a, b]) => [a, b + 1.5]), range(rnd, 2, 4), darkC, 0.45);
      y += t;
    }
    if (biome === 'desert') for (let i = 0; i < 26; i++) {         // wind-scoured grooves
      const yy = rnd() * h, x0 = rnd() * w, L = range(rnd, 60, 220);
      wrapX(w, x0 + L / 2, L, X => { line(g, [[X - L / 2, yy], [X + L / 2, yy + range(rnd, -2, 2)]], range(rnd, 1.5, 3), '#7a5a3a', 0.35); line(g, [[X - L / 2, yy + 2], [X + L / 2, yy + 2]], 1, '#f4dcae', 0.4); });
    }
  }
  if (biome === 'meadow') for (let i = 0; i < 26; i++) { const x = rnd() * w; wrapX(w, x, 10, X => stroke(g, [[X, Y(0.95)], [X + range(rnd, -3, 3), Y(range(rnd, 0.45, 0.8))]], range(rnd, 4, 9), 1, pick(rnd, ['#5d6b3c', '#6d7a4a']), 0.28)); }
  if (biome === 'fields') for (let i = 0; i < 40; i++) { const x = rnd() * w, y = range(rnd, 0.2, 0.9) * h, rx = range(rnd, 3, 8); wrapX(w, x, 8, X => blob(g, X, y, rx, rx * 0.7, 0, pick(rnd, ['#d89a3a', '#c8b04a', '#e8c060']), 0.55, 0.5)); }
  if (biome === 'snow') for (let i = 0; i < 14; i++) { const x = rnd() * w, y = range(rnd, 0.3, 0.85) * h, rx = range(rnd, 10, 26); wrapX(w, x, rx * 1.4, X => { blob(g, X + 2, y + 2.5, rx, 3.5, 0, '#3a4a6a', 0.22, 0.3); blob(g, X, y, rx, 3, 0, '#eef2f8', 0.55, 0.35); }); }
  cracks(g, w, rnd, { color: '#2a2030', count: 8, len: [20, 60], width: [1, 2], alpha: 0.4 });
  // grime and earth at the foot
  g.fillStyle = lin(g, 0, Y(0.22), 0, h, [[0, B.ground, 0], [0.6, B.ground, 0.4], [1, shadowOf(B.ground, 0.4), 0.75]]); g.fillRect(0, Y(0.22), w, h - Y(0.22));
  if (biome === 'snow') { g.fillStyle = lin(g, 0, Y(0.12), 0, h, [[0, '#e8eef4', 0], [1, '#dfe6ee', 0.8]]); g.fillRect(0, Y(0.12), w, h - Y(0.12)); }
  glaze(g, w, h, '#ffe2b0', 0.1);
}
// The cover: an alpha-tested layer for the rock's upward faces (alpha × the shell's vertex alpha is
// cut at 0.5, so its edge is ragged where the slope turns). Seamless both ways.
function coverPaint(g, s, rnd, biome) {
  // a patch: a cluster of small overlapping dabs (never one round disc), lit on its upper left
  const patch = (n, spread, rmin, rmax, cols, lit, dark, { rim = 0.5, hard = 0.55, fringe = null } = {}) => {
    for (let i = 0; i < n; i++) {
      const cx = rnd() * s, cy = rnd() * s, m = 5 + Math.floor(rnd() * 7), dabs = [];
      for (let k = 0; k < m; k++) dabs.push([cx + (rnd() - 0.5) * spread, cy + (rnd() - 0.5) * spread * 0.7, range(rnd, rmin, rmax), pick(rnd, cols)]);
      for (const [x, y, r] of dabs) wrap(s, x, y, r * 1.5, (X, Y) => blob(g, X + r * 0.3, Y + r * 0.35, r * 1.1, r * 0.9, 0, dark, rim, hard));
      for (const [x, y, r, c] of dabs) wrap(s, x, y, r * 1.5, (X, Y) => blob(g, X, Y, r, r * 0.8, rnd() * 3, c, 1, hard));
      for (const [x, y, r] of dabs) if (rnd() < 0.6) wrap(s, x, y, r, (X, Y) => blob(g, X - r * 0.3, Y - r * 0.3, r * 0.45, r * 0.32, 0, lit, 0.7, 0.4));
      if (fringe) for (const [x, y, r] of dabs) for (let k = 0; k < 3; k++) { const a = rnd() * TAU, bx = x + Math.cos(a) * r, by = y + Math.sin(a) * r * 0.8, c = pick(rnd, fringe); wrap(s, bx, by, 12, (X, Y) => blade(g, X, Y, range(rnd, 4, 9), range(rnd, -0.8, 0.8), range(rnd, 1.4, 2.2), c, 1, range(rnd, -0.3, 0.3))); }
    }
  };
  if (biome === 'meadow') {
    patch(46, 44, 5, 11, ['#5d6b3c', '#6d7a4a', '#55663a', '#667544', '#4f5e32'], '#9aa860', '#3a4428', { fringe: ['#4f7d2a', '#6f9c34', '#5d6b3c'] });
    for (let i = 0; i < 12; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 4, (X, Y) => ellipse(g, X, Y, 1.6, 1.6, 0, pick(rnd, ['#f0e6a0', '#e8a0b0', '#fff8e0']))); }
  } else if (biome === 'fields') {
    patch(14, 26, 3, 7, ['#8a8a48', '#9a8a44', '#7a7a40'], '#c8b870', '#4a4428', { fringe: ['#a99a45', '#c9ac52', '#e2c56a'] });
    for (let i = 0; i < 160; i++) { const x = rnd() * s, y = rnd() * s, c = pick(rnd, ['#a99a45', '#c9ac52', '#e2c56a', '#8a7a3a']); wrap(s, x, y, 14, (X, Y) => blade(g, X, Y, range(rnd, 7, 14), range(rnd, -0.8, 0.8), range(rnd, 1.6, 2.6), c, 1, range(rnd, -0.4, 0.4))); }
    for (let i = 0; i < 26; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 2.5, 5); wrap(s, x, y, r, (X, Y) => blob(g, X, Y, r, r * 0.8, 0, pick(rnd, ['#d89a3a', '#e8b048']), 1, 0.7)); }
  } else if (biome === 'snow') {
    g.fillStyle = rgba('#e8eef4', 0.82); g.fillRect(0, 0, s, s);
    patch(30, 40, 8, 18, ['#f2f4f8', '#e8eef4', '#f7f4ec'], '#ffffff', '#b8c8dc', { rim: 0.6, hard: 0.45 });
    g.save(); g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 30; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 8, 20); wrap(s, x, y, r, (X, Y) => blob(g, X, Y, r, r * 0.8, rnd() * 3, '#000', 0.5, 0.3)); }
    g.restore();
    for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 2, (X, Y) => ellipse(g, X, Y, 1.2, 1.2, 0, '#ffffff', 0.9)); }
  } else if (biome === 'badlands') {
    // ochre dust settled in drifts: flat, close to the rock's own tone, no lip
    patch(18, 44, 5, 12, ['#c48c5a', '#b98457', '#cf9a62', '#b4784a'], '#dcae7a', '#9a5a38', { rim: 0.25, hard: 0.6 });
    for (let i = 0; i < 30; i++) { const x = rnd() * s, y = rnd() * s, c = pick(rnd, ['#a88850', '#8a7040']); wrap(s, x, y, 12, (X, Y) => blade(g, X, Y, range(rnd, 5, 10), range(rnd, -0.8, 0.8), range(rnd, 1.2, 1.8), c, 1, range(rnd, -0.4, 0.4))); }
    for (let i = 0; i < 30; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.5, 3); wrap(s, x, y, r, (X, Y) => { ellipse(g, X + 0.6, Y + 0.8, r, r * 0.8, 0, '#6a3a20'); ellipse(g, X, Y, r, r * 0.8, 0, pick(rnd, ['#a8583a', '#c87a4a', '#8e3e22'])); }); }
  } else {
    patch(22, 50, 7, 15, ['#e8cc96', '#d9b87f', '#e2c48c'], '#fff0c8', '#c79c62', { rim: 0.3, hard: 0.55 });
    for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s, L = range(rnd, 10, 30); wrap(s, x, y, L, (X, Y) => { line(g, [[X - L / 2, Y], [X + L / 2, Y + 1]], 1.4, '#c79c62', 0.6); line(g, [[X - L / 2, Y - 1.4], [X + L / 2, Y - 0.4]], 1, '#fff4d0', 0.6); }); }
  }
}
for (const b of Object.keys(BOULDER)) {
  register(`loot_boulder_${b}`, { family: F, w: 512, h: 256, note: `the road-blocking boulder, ${b} (u wraps round it; v ground → top)`, paint(g, w, rnd, h, cv) { boulderPaint(g, w, rnd, h, b); blurTile(cv, 0.4); } });
  register(`loot_cover_${b}`, { family: F, size: 256, alpha: true, note: `what lies on the ${b} boulder's top faces (alpha-tested, seamless)`, paint(g, s, rnd, h, cv) { coverPaint(g, s, rnd, b); blurTile(cv, 0.5); } });
}
