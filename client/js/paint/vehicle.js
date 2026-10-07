// Texture family: vehicle. The Slopmaster 9000 (rv3d.js), painted the way Blizzard's 2004 artists
// painted a model: one unique atlas for the body, a trim sheet for every beam, bolt and lamp,
// and a few tiling interior surfaces. Light from the upper left: lit cream edges on top, cool
// violet-brown shadows below, soft dark seams, never pure black. See docs/ART.md.
//
//   rv_body     1024², the body atlas: right side, left side, front, rear and roof, each painted for
//               its own panel (windows, door, wheel arches and the name all line up with RV_ART).
//   rv_trim     512×1024 trim sheet: 14 horizontal bands that tile along u (wood, oak, brass, iron,
//               goblin red, goblin green, cream, tread, strap, gingham, slate, canvas, painted glass,
//               rope), then a row of 64² decal slots and a row of 128×64 slots (hub, gauges, plate...).
//   rv_paneling 512², interior wall boards: wainscot, chair rail, upper boards (tiles along u only).
//   rv_floor    512², plank floor (tiles).
//   rv_soft     512², soft goods atlas: patchwork quilt, tufted plaid, braided rag rug, shower tiles.
//   rv_lamps    256², lenses: headlight, tail light, amber marker, lantern glass (also the glow map).
//   rv_glass    256², see-through window glass with painted streaks (alpha).
import {
  register, fill, mottle, glaze, blob, range, pick, wrap, ellipse, stroke,
  mix, shade, lightOf, shadowOf, jitter, rgba, makeCanvas, rowLayout, blurTile,
} from './core.js';

const F = 'vehicle';
const TAU = Math.PI * 2;
const INK = '#2a2030';
const SERIF = `Georgia, 'Palatino Linotype', 'Book Antiqua', 'Liberation Serif', 'DejaVu Serif', serif`;

// ---- the layout the painter and the model share (local RV frame of shared/rv.js) ---------------
export const RV_ART = {
  y0: -0.6, y1: 2.4,                      // the side atlas spans this height
  wheelY: -0.86, archR: 0.64, archZ: [2.65, -2.6],
  door: { z0: -0.15, z1: 0.85, y0: 0, y1: 1.98 },
  // side openings: rectangles { z0, z1, y0, y1 } or portholes { z, y, r }
  winL: [
    { z0: 2.86, z1: 3.7, y0: 1.0, y1: 1.94, cab: true },
    { z0: 0.55, z1: 1.75, y0: 1.08, y1: 1.84 },
    { z0: -1.55, z1: -0.55, y0: 1.08, y1: 1.84 },
    { z: -3.42, y: 0.98, r: 0.19 },
    { z: -3.42, y: 1.9, r: 0.17 },
  ],
  winR: [
    { z0: 2.86, z1: 3.7, y0: 1.0, y1: 1.94, cab: true },
    { z0: 1.45, z1: 2.45, y0: 1.32, y1: 1.86 },
    { z: -2.25, y: 1.74, r: 0.15, frost: true },
    { z: -3.42, y: 0.98, r: 0.19 },
    { z: -3.42, y: 1.9, r: 0.17 },
  ],
  shield: { x: 1.07, y0: 1.04, y1: 2.06 },
  rearWin: { x: 0.7, y0: 1.66, y1: 2.06 },
  // the livery (local y)
  gold: [0.985, 1.035], orange: [0.71, 0.965], brown: [0.575, 0.69], brassTop: [0.525, 0.56],
  wood: [0.065, 0.525], brassLow: [0.03, 0.065],
  emblem: { L: 2.45, R: 2.66, y: 1.56, r: 0.15 },
  name: { z: -2.05, w: 3.2 },
};
// atlas regions (px) of rv_body
export const BODY = { W: 1024, H: 1024, sidePx: 128, R: 0, L: 384, endY: 768, endW: 256, front: 0, rear: 256, roof: 512 };
// trim sheet bands
export const TRIM = {
  W: 512, H: 1024, band: 64,
  wood: 0, oak: 1, brass: 2, iron: 3, red: 4, green: 5, cream: 6, tread: 7, strap: 8, gingham: 9,
  slate: 10, canvas: 11, glass: 12, rope: 13, slots: 14, wide: 15,
  // 64×64 decal slots in band 14
  s: { hub: 0, gauge: 1, fuel: 2, frost: 3, emblem: 4, burner: 5, clock: 6, apple: 7 },
  // 128×64 slots in band 15
  w: { plate: 0, sticker: 1, radio: 2, plaque: 3 },
};
// soft goods regions (px of a 512² atlas): x, y, w, h
export const SOFT = { quilt: [0, 0, 256, 256], plaid: [256, 0, 256, 256], rug: [0, 256, 256, 256], tile: [256, 256, 256, 256] };
// lamps (px of a 256² atlas)
export const LAMPS = { head: [0, 0, 128, 128], tail: [128, 0, 128, 128], amber: [0, 128, 128, 128], lantern: [128, 128, 128, 128] };

// ---- small helpers -------------------------------------------------------------------------------

function line(g, pts, w, color, alpha = 1, cap = 'round') {
  g.save();
  g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = w; g.lineCap = cap; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke(); g.restore();
}
function grad(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c, a = 1] of stops) gr.addColorStop(t, rgba(c, a));
  return gr;
}
function rect(g, x, y, w, h, fillStyle, alpha = 1) {
  g.save(); g.globalAlpha *= alpha; g.fillStyle = fillStyle; g.fillRect(x, y, w, h); g.restore();
}
function rrect(g, x, y, w, h, r) { g.beginPath(); g.roundRect(x, y, w, h, r); }
function clipRect(g, x, y, w, h, fn) { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); fn(); g.restore(); }
// blobs scattered inside a rect (no wrapping: for atlas regions)
function mottleIn(g, rnd, x, y, w, h, { colors, count = 40, rmin = 10, rmax = 50, alpha = 0.2, hard = 0.2, stretch = 1 } = {}) {
  for (let i = 0; i < count; i++) {
    const r = range(rnd, rmin, rmax), s = stretch * range(rnd, 0.7, 1.3);
    blob(g, x + rnd() * w, y + rnd() * h, r * s, r, stretch === 1 ? rnd() * Math.PI : (rnd() - 0.5) * 0.3, pick(rnd, colors), alpha * range(rnd, 0.6, 1), hard);
  }
}
// horizontal-only wrapping (bands of the trim sheet tile along u)
function wrapX(W, x, r, fn) { fn(x); if (x - r < 0) fn(x + W); if (x + r > W) fn(x - W); }

function rivet(g, x, y, r, base = '#9a7a3a', shadowA = 0.5) {
  blob(g, x + r * 0.5, y + r * 0.65, r * 1.7, r * 1.45, 0, INK, shadowA, 0.25);
  ellipse(g, x, y, r, r, 0, shadowOf(base, 0.35));
  ellipse(g, x - r * 0.14, y - r * 0.14, r * 0.8, r * 0.8, 0, base);
  blob(g, x - r * 0.35, y - r * 0.42, r * 0.5, r * 0.42, 0, lightOf(base, 0.9), 0.95, 0.4);
}
function nail(g, x, y, r = 2) {
  blob(g, x + r * 0.5, y + r * 0.6, r * 1.6, r * 1.4, 0, INK, 0.4, 0.3);
  ellipse(g, x, y, r, r, 0, '#5a5258');
  blob(g, x - r * 0.35, y - r * 0.35, r * 0.6, r * 0.55, 0, '#cfc6b8', 0.8, 0.4);
}

// One painted plank (grain along its length), light from the top/left.
function plank(g, X, Y, w, h, c, rnd, { vertical = false, grain = 9, galpha = 0.4, knots = 0.3, bevel = 3, light = 0.42, nails = 0, splits = 0.25, endShade = 0.25 } = {}) {
  g.save();
  g.beginPath(); g.rect(X, Y, w, h); g.clip();
  const L = vertical ? h : w, T = vertical ? w : h;
  g.fillStyle = vertical ? grad(g, X, 0, X + w, 0, [[0, lightOf(c, light * 0.45)], [0.4, c], [1, shadowOf(c, light * 0.55)]])
    : grad(g, 0, Y, 0, Y + h, [[0, lightOf(c, light * 0.45)], [0.4, c], [1, shadowOf(c, light * 0.55)]]);
  g.fillRect(X, Y, w, h);
  for (let i = 0; i < 4; i++) {
    const t = rnd() * L, r = range(rnd, 0.12, 0.35) * L, col = rnd() < 0.5 ? lightOf(c, 0.25) : shadowOf(c, 0.25);
    if (vertical) blob(g, X + w / 2, Y + t, T * 0.8, r, 0, col, 0.22, 0.1); else blob(g, X + t, Y + h / 2, r, T * 0.8, 0, col, 0.22, 0.1);
  }
  for (let i = 0; i < grain; i++) {
    const off = range(rnd, 0.06, 0.94) * T, amp = range(rnd, 0.3, 1.8) * Math.min(1, T / 30), fr = range(rnd, 0.4, 2.2), ph = rnd() * TAU;
    const pts = [];
    for (let k = 0; k <= 16; k++) { const t = k / 16, a = -4 + t * (L + 8), b = off + Math.sin(t * fr * TAU + ph) * amp; pts.push(vertical ? [X + b, Y + a] : [X + a, Y + b]); }
    line(g, pts, range(rnd, 0.6, 1.5), rnd() < 0.65 ? shadowOf(c, 0.45) : lightOf(c, 0.35), galpha * range(rnd, 0.4, 1));
  }
  if (rnd() < knots && T > 8) {
    const t = range(rnd, 0.15, 0.85) * L, o2 = range(rnd, 0.3, 0.7) * T, r = range(rnd, 2.5, Math.min(7, T * 0.22));
    const kx = vertical ? X + o2 : X + t, ky = vertical ? Y + t : Y + o2;
    const rx = vertical ? r : r * 1.7, ry = vertical ? r * 1.7 : r;
    ellipse(g, kx, ky, rx * 2.0, ry * 2.0, 0, shadowOf(c, 0.18), 0.3);
    ellipse(g, kx, ky, rx, ry, 0, shadowOf(c, 0.55), 0.9);
    blob(g, kx + rx * 0.45, ky + ry * 0.45, rx * 0.6, ry * 0.5, 0, lightOf(c, 0.4), 0.4, 0.4);
  }
  if (rnd() < splits) {
    const t0 = rnd() * L * 0.7, len = range(rnd, 0.15, 0.45) * L, o2 = range(rnd, 0.25, 0.75) * T;
    const p = [];
    for (let k = 0; k <= 6; k++) { const a = t0 + len * k / 6, b = o2 + (rnd() - 0.5) * 1.6; p.push(vertical ? [X + b, Y + a] : [X + a, Y + b]); }
    line(g, p.map(([x, y]) => [x + 0.9, y + 0.9]), 1.6, lightOf(c, 0.5), 0.35);
    line(g, p, 1.2, INK, 0.5);
  }
  if (endShade > 0) {
    g.fillStyle = vertical ? grad(g, 0, Y, 0, Y + h, [[0, INK, endShade], [0.1, INK, 0], [0.9, INK, 0], [1, INK, endShade]])
      : grad(g, X, 0, X + w, 0, [[0, INK, endShade], [0.08, INK, 0], [0.92, INK, 0], [1, INK, endShade]]);
    g.fillRect(X, Y, w, h);
  }
  for (let i = 0; i < nails; i++) {
    const t = i % 2 ? L - 8 : 8, o2 = T * (nails > 2 ? (i < 2 ? 0.3 : 0.7) : 0.5);
    nail(g, vertical ? X + o2 : X + t, vertical ? Y + t : Y + o2, 1.9);
  }
  g.globalAlpha = 0.5; g.fillStyle = lightOf(c, 0.6); g.fillRect(X, Y, w, bevel); g.fillRect(X, Y, bevel * 0.8, h);
  g.globalAlpha = 0.45; g.fillStyle = shadowOf(c, 0.55); g.fillRect(X, Y + h - bevel, w, bevel); g.fillRect(X + w - bevel * 0.8, Y, bevel * 0.8, h);
  g.restore();
}

// Gilded sign-painter's lettering: dark outline, warm gold body, cream highlight, drop shadow.
function gilded(g, text, cx, cy, maxW, size, { fillTop = '#f6dc8a', fillBot = '#c08a2c', outline = '#2a1810', track = 0.06 } = {}) {
  g.save();
  let s = size;
  const font = () => `bold ${s}px ${SERIF}`;
  g.font = font(); g.letterSpacing = `${Math.round(s * track)}px`;
  while (g.measureText(text).width > maxW && s > 8) { s -= 1; g.font = font(); g.letterSpacing = `${Math.round(s * track)}px`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineJoin = 'round';
  // soft drop shadow down-right
  g.globalAlpha = 0.55; g.fillStyle = '#1a1014'; g.filter = `blur(${Math.max(1, s * 0.05)}px)`;
  g.fillText(text, cx + s * 0.08, cy + s * 0.1);
  g.filter = 'none'; g.globalAlpha = 1;
  g.strokeStyle = outline; g.lineWidth = Math.max(2, s * 0.16); g.strokeText(text, cx, cy);
  g.fillStyle = grad(g, 0, cy - s * 0.5, 0, cy + s * 0.5, [[0, fillTop], [0.55, mix(fillTop, fillBot, 0.5)], [1, fillBot]]);
  g.fillText(text, cx, cy);
  // a cream glint along the tops of the letters
  g.save(); g.beginPath(); g.rect(cx - maxW, cy - s * 0.6, maxW * 2, s * 0.32); g.clip();
  g.globalAlpha = 0.45; g.fillStyle = '#fff6d8'; g.fillText(text, cx, cy); g.restore();
  g.restore();
  return s;
}

// a brass cog with a coin face: the goblin maker's mark
function cog(g, x, y, r, rnd, label = '9K') {
  const teeth = 10;
  g.save();
  blob(g, x + r * 0.15, y + r * 0.2, r * 1.35, r * 1.3, 0, INK, 0.4, 0.4);
  g.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a0 = i / (teeth * 2) * TAU, a1 = (i + 1) / (teeth * 2) * TAU, rr = i % 2 ? r * 0.82 : r;
    g.arc(x, y, rr, a0, a1);
  }
  g.closePath();
  g.fillStyle = grad(g, x - r, y - r, x + r, y + r, [[0, '#f2d88a'], [0.45, '#c8973e'], [1, '#6a4a22']]);
  g.fill();
  g.lineWidth = Math.max(1, r * 0.06); g.strokeStyle = rgba('#4a3018', 0.8); g.stroke();
  ellipse(g, x, y, r * 0.62, r * 0.62, 0, '#7a5424');
  g.beginPath(); g.arc(x, y, r * 0.56, 0, TAU);
  g.fillStyle = grad(g, x - r * 0.5, y - r * 0.5, x + r * 0.5, y + r * 0.5, [[0, '#ffe8a0'], [0.5, '#d8a848'], [1, '#8a6228']]);
  g.fill();
  g.font = `bold ${Math.round(r * 0.62)}px ${SERIF}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#6a4416'; g.fillText(label, x + r * 0.03, y + r * 0.05);
  g.fillStyle = rgba('#fff0c0', 0.5); g.fillText(label, x - r * 0.03, y - r * 0.01);
  blob(g, x - r * 0.3, y - r * 0.35, r * 0.3, r * 0.2, -0.6, '#fff6d0', 0.6, 0.3);
  g.restore();
}

// ---- the body atlas ------------------------------------------------------------------------------

const CREAM = '#efe1bf';
const ORANGE = '#d2702e', BROWN = '#6a3e24', GOLD = '#d8a64a', SKIRT = '#55505c';
const WOODS = ['#a06a3a', '#946036', '#aa7642', '#8c5a32'];

// The livery bands from y=hi down to y=lo, painted across [x0, x1] using Y(y) → px.
function livery(g, rnd, x0, x1, Y, { chips = 1, woodNails = true, woodBand = true } = {}) {
  const A = RV_ART, w = x1 - x0;
  const band = (lo, hi, top, mid, bot) => {
    const y0 = Y(hi), y1 = Y(lo);
    // hand-painted edge: a few px of wobble
    g.save();
    g.beginPath();
    g.moveTo(x0 - 2, y0 + (rnd() - 0.5));
    for (let x = x0; x <= x1 + 8; x += 8) g.lineTo(x, y0 + (rnd() - 0.5) * 1.2);
    for (let x = x1 + 8; x >= x0 - 8; x -= 8) g.lineTo(x, y1 + (rnd() - 0.5) * 1.2);
    g.closePath();
    g.fillStyle = grad(g, 0, y0, 0, y1, [[0, top], [0.35, mid], [1, bot]]);
    g.fill();
    g.restore();
  };
  // gold pinstripe, orange, cream gap, brown
  band(A.gold[0], A.gold[1], '#f4d68a', GOLD, '#9a6a2a');
  band(A.orange[0], A.orange[1], '#e8915a', ORANGE, '#a4501f');
  band(A.brown[0], A.brown[1], '#8a5a38', BROWN, '#4a2a1a');
  // worn paint: chips show cream primer, long faded scratches
  clipRect(g, x0, Y(A.orange[1]), w, Y(A.brown[0]) - Y(A.orange[1]), () => {
    mottleIn(g, rnd, x0, Y(A.orange[1]), w, Y(A.orange[0]) - Y(A.orange[1]), { colors: ['#e0874a', '#b85a26', '#d87a3a'], count: Math.round(w / 14), rmin: 6, rmax: 26, alpha: 0.35, stretch: 3 });
    for (let i = 0; i < w / 55 * chips; i++) {
      const x = x0 + rnd() * w, edge = rnd() < 0.8;
      const y = edge ? (rnd() < 0.5 ? Y(A.orange[1]) + range(rnd, 0, 4) : Y(A.orange[0]) - range(rnd, 0, 4)) : range(rnd, Y(A.orange[1]), Y(A.brown[0]));
      const r = range(rnd, 1.0, 2.6);
      ellipse(g, x + 0.8, y + 0.9, r * 1.8, r, rnd() * 0.4, INK, 0.2);
      ellipse(g, x, y, r * 1.8, r, rnd() * 0.4, '#e2cfa8', 0.7);
    }
    for (let i = 0; i < w / 60; i++) {
      const x = x0 + rnd() * w, y = range(rnd, Y(A.orange[1]) + 3, Y(A.brown[0]) - 3), L = range(rnd, 10, 40);
      line(g, [[x, y], [x + L, y + (rnd() - 0.5) * 3]], 0.9, '#f2c89a', 0.35);
    }
  });
  // brass trim lines either side of the wood band
  for (const [lo, hi] of [A.brassTop, A.brassLow]) {
    const y0 = Y(hi), y1 = Y(lo);
    rect(g, x0, y0, w, y1 - y0, grad(g, 0, y0, 0, y1, [[0, '#ffe8a4'], [0.35, '#d0a04c'], [1, '#6e4a20']]));
    for (let i = 0; i < w / 40; i++) blob(g, x0 + rnd() * w, (y0 + y1) / 2, range(rnd, 4, 14), (y1 - y0) * 0.5, 0, pick(rnd, ['#7a8a5a', '#8a6a30']), 0.3, 0.3);
  }
  // the wood band: two courses of long planks
  const wy0 = Y(A.wood[1]), wy1 = Y(A.wood[0]), rows = 2, rh = (wy1 - wy0) / rows;
  if (!woodBand) {
    // a cream nose: the stripes wrap round, the panel below stays painted metal
    rect(g, x0, wy0, w, wy1 - wy0, grad(g, 0, wy0, 0, wy1, [[0, '#e8d6b0'], [1, '#d2bc94']]));
    mottleIn(g, rnd, x0, wy0, w, wy1 - wy0, { colors: ['#f2e2c0', '#d8c49c', '#cfc4bc'], count: 20, rmin: 6, rmax: 20, alpha: 0.25 });
    rect(g, x0, wy0, w, 5, grad(g, 0, wy0, 0, wy0 + 5, [[0, INK, 0.3], [1, INK, 0]]));
    return;
  }
  clipRect(g, x0, wy0, w, wy1 - wy0, () => {
    rect(g, x0, wy0, w, wy1 - wy0, '#2e2024');
    for (let r = 0; r < rows; r++) {
      let x = x0 - rnd() * 120;
      while (x < x1) {
        const L = range(rnd, 110, 260);
        plank(g, x + 1, wy0 + r * rh + 1, L - 2, rh - 2, jitter(pick(rnd, WOODS), rnd, 0.06), rnd, { grain: 8, nails: woodNails ? 4 : 0, knots: 0.35, light: 0.5 });
        x += L;
      }
    }
    // the band sits a hair proud: shadow along its bottom, lit lip on top
    rect(g, x0, wy1 - 4, w, 4, grad(g, 0, wy1 - 4, 0, wy1, [[0, INK, 0], [1, INK, 0.45]]));
  });
}

// One long side. side 'R' (door side, -X) has the front at the right; 'L' (+X) is mirrored.
function paintSide(g, rnd, side, oy) {
  const A = RV_ART, P = BODY.sidePx, W = BODY.W, H = 384;
  const X = z => side === 'R' ? (z + 4) * P : (4 - z) * P;
  const Y = y => oy + (A.y1 - y) * P;
  const wins = side === 'R' ? A.winR : A.winL;
  g.save();
  g.beginPath(); g.rect(0, oy, W, H); g.clip();
  // cream body: warm and lit at the top, cooler toward the belt
  rect(g, 0, oy, W, H, grad(g, 0, Y(2.4), 0, Y(0.9), [[0, '#faeed2'], [0.45, CREAM], [1, '#dcc8a0']]));
  mottleIn(g, rnd, 0, Y(2.4), W, Y(0.9) - Y(2.4), { colors: ['#fbf2da', '#e2cca0', '#f0d6a8', '#d2cac2', '#e8d2a8'], count: 70, rmin: 30, rmax: 110, alpha: 0.28, stretch: 1.8 });
  mottleIn(g, rnd, 0, Y(2.4), W, Y(0.9) - Y(2.4), { colors: ['#fff6e0', '#d8c49c', '#cfc4bc'], count: 120, rmin: 8, rmax: 26, alpha: 0.22, stretch: 2.4 });
  // long soft rain/dust streaks down the cream
  for (let i = 0; i < 70; i++) {
    const x = rnd() * W, y = Y(range(rnd, 1.6, 2.3)), L = range(rnd, 30, 120);
    line(g, [[x, y], [x + (rnd() - 0.5) * 3, y + L]], range(rnd, 1, 3.5), pick(rnd, ['#c8b898', '#b8a888', '#d0c0a0']), range(rnd, 0.05, 0.14));
  }
  // under the roof cap: a soft cool shadow
  rect(g, 0, Y(2.32), W, 0.24 * P, grad(g, 0, Y(2.32), 0, Y(2.08), [[0, '#5a4a5a', 0.4], [1, '#5a4a5a', 0]]));
  // panel seams with rivets (skip the windows and the door)
  const blocked = z => wins.some(o => o.r ? Math.abs(z - o.z) < o.r + 0.1 : z > o.z0 - 0.08 && z < o.z1 + 0.08) || (side === 'R' && z > A.door.z0 - 0.1 && z < A.door.z1 + 0.1);
  let z = -3.92;
  const seams = [];
  while (z < 3.9) {
    z += range(rnd, 0.95, 1.35);
    let zz = z, tries = 0;
    while (blocked(zz) && tries++ < 30) zz += 0.06;
    if (zz < 3.85) seams.push(zz), z = zz;
  }
  // each panel is a little oil-canned: lit toward its upper left, shaded toward its lower right
  {
    const xs = [0, ...seams.map(X).sort((a, b) => a - b), W];
    for (let i = 0; i < xs.length - 1; i++) {
      const xa = xs[i], xb = xs[i + 1], ya = Y(2.25), yb = Y(A.gold[1]);
      rect(g, xa, ya, xb - xa, yb - ya, grad(g, xa, ya, xb, yb, [[0, '#fff4d8', 0.22], [0.45, '#fff4d8', 0], [0.6, '#3a3048', 0], [1, '#3a3048', 0.14]]));
    }
  }
  for (const sz of seams) {
    const x = X(sz), ya = Y(2.27), yb = Y(A.gold[1]) - 2;
    const pts = [];
    for (let y = ya; y <= yb; y += 12) pts.push([x + (rnd() - 0.5) * 0.8, y]);
    line(g, pts, 3, '#7a6448', 0.65);
    line(g, pts.map(([u, v]) => [u + 2.4, v]), 1.8, '#fff8e4', 0.7);
    for (let y = ya + 8; y < yb - 4; y += range(rnd, 13, 15)) {
      rivet(g, x - 5, y, 2.6, '#e2d2ae', 0.4);
      if (rnd() < 0.12) line(g, [[x - 5, y + 3], [x - 5 + (rnd() - 0.5) * 2, y + range(rnd, 14, 40)]], 1.6, '#a2703c', 0.28);
    }
  }
  // the top rail seam
  {
    const y = Y(2.22);
    line(g, [[0, y], [W, y]], 2.2, '#8a7458', 0.5);
    line(g, [[0, y + 2], [W, y + 2]], 1.4, '#fff8e4', 0.55);
    for (let x = 6; x < W; x += range(rnd, 12, 15)) rivet(g, x, y - 5, 2.3, '#e2d2ae', 0.35);
  }
  // windows: a soft occlusion halo, and grime runs from the sills
  for (const o of wins) {
    if (o.r) {
      const x = X(o.z), y = Y(o.y), r = o.r * P;
      blob(g, x + 3, y + 5, r * 1.55, r * 1.55, 0, '#5a4a4a', 0.22, 0.5);
      for (let i = 0; i < 3; i++) { const sx = x + (rnd() - 0.5) * r * 0.8; line(g, [[sx, y + r + 2], [sx + (rnd() - 0.5) * 1.5, y + r + range(rnd, 14, 36)]], range(rnd, 2.5, 4.5), '#9a8a70', 0.14); }
      continue;
    }
    const xa = Math.min(X(o.z0), X(o.z1)), xb = Math.max(X(o.z0), X(o.z1)), ya = Y(o.y1), yb = Y(o.y0);
    g.save(); g.filter = 'blur(6px)'; g.fillStyle = rgba('#4a3c44', 0.3); g.fillRect(xa - 6, ya - 4, xb - xa + 16, yb - ya + 18); g.restore();
    for (let i = 0; i < 6; i++) {
      const x = range(rnd, xa + 4, xb - 4), y = yb + 10;
      line(g, [[x, y], [x + (rnd() - 0.5) * 3, y + range(rnd, 10, 46)]], range(rnd, 1.4, 3.4), pick(rnd, ['#8a7860', '#9a8468']), range(rnd, 0.14, 0.26));
    }
  }
  // the door outline (the door itself carries this same paint)
  if (side === 'R') {
    const xa = X(A.door.z0), xb = X(A.door.z1), ya = Y(A.door.y1), yb = Y(A.door.y0 - 0.02);
    g.save(); rrect(g, xa + 1, ya + 1, xb - xa - 2, yb - ya, 10); g.lineWidth = 3; g.strokeStyle = rgba('#4a3a40', 0.6); g.stroke();
    rrect(g, xa + 4, ya + 4, xb - xa - 8, yb - ya - 6, 8); g.lineWidth = 1.6; g.strokeStyle = rgba('#fff4dc', 0.55); g.stroke(); g.restore();
  }
  // maker's mark
  cog(g, X(A.emblem[side]), Y(A.emblem.y), A.emblem.r * P, rnd);
  // the livery
  livery(g, rnd, 0, W, Y);
  // the name, gilded onto the wood band
  {
    const cx = X(A.name.z), cy = (Y(A.wood[1]) + Y(A.wood[0])) / 2 + 1;
    gilded(g, 'SLOPMASTER 9000', cx, cy, A.name.w * P, Math.round(0.34 * P));
  }
  // the skirt: riveted iron, dusty at the bottom
  {
    const ya = Y(A.brassLow[0]), yb = Y(A.y0);
    rect(g, 0, ya, W, yb - ya, grad(g, 0, ya, 0, yb, [[0, '#6a6470'], [0.25, SKIRT], [1, '#38323c']]));
    mottleIn(g, rnd, 0, ya, W, yb - ya, { colors: ['#5a5460', '#433e48', '#5c4a44'], count: 60, rmin: 8, rmax: 30, alpha: 0.3, stretch: 2 });
    for (let x = 8; x < W; x += range(rnd, 16, 20)) { rivet(g, x, ya + 9, 2.6, '#7a7480', 0.5); rivet(g, x + 6, yb - 10, 2.6, '#7a7480', 0.5); }
    // a riveted patch plate (goblin repair)
    const px = X(side === 'R' ? -1.3 : 0.4), pw = 0.55 * P;
    rect(g, px, ya + 18, pw, 30, grad(g, 0, ya + 18, 0, ya + 48, [[0, '#7a7078'], [1, '#4a4450']]));
    rect(g, px, ya + 46, pw, 3, INK, 0.45);
    for (const [u, v] of [[5, 23], [pw - 5, 23], [5, 43], [pw - 5, 43]]) rivet(g, px + u, ya + v, 2.4, '#a29aa4');
    // storage hatches with strap hinges, a brass latch and a stenciled label
    const hatches = side === 'R' ? [[-1.75, -0.65, 'LOOT'], [1.05, 1.95, 'JUNK']] : [[-1.85, -0.75, 'JUNK'], [0.45, 1.75, 'LOOT']];
    for (const [za, zb, label] of hatches) {
      const xa = Math.min(X(za), X(zb)), xb = Math.max(X(za), X(zb)), hy0 = Y(-0.06), hy1 = Y(-0.5);
      blob(g, (xa + xb) / 2 + 3, (hy0 + hy1) / 2 + 4, (xb - xa) * 0.56, (hy1 - hy0) * 0.6, 0, INK, 0.3, 0.6);
      g.save(); rrect(g, xa, hy0, xb - xa, hy1 - hy0, 6); g.clip();
      rect(g, xa, hy0, xb - xa, hy1 - hy0, grad(g, xa, hy0, xb, hy1, [[0, '#7a7482'], [0.5, '#5c5664'], [1, '#423c48']]));
      rect(g, xa, hy0, xb - xa, 3, '#a8a2b0', 0.6); rect(g, xa, hy0, 3, hy1 - hy0, '#a8a2b0', 0.4);
      rect(g, xa, hy1 - 3, xb - xa, 3, INK, 0.5); rect(g, xb - 3, hy0, 3, hy1 - hy0, INK, 0.4);
      g.save(); g.globalAlpha = 0.5; g.font = `bold 22px ${SERIF}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.letterSpacing = '4px';
      g.fillStyle = '#e8dcc0'; g.fillText(label, (xa + xb) / 2, (hy0 + hy1) / 2 + 2); g.restore();
      g.restore();
      for (const u of [0.22, 0.78]) {
        const hx = xa + (xb - xa) * u;
        rect(g, hx - 5, hy0 - 3, 10, 26, grad(g, hx - 5, 0, hx + 5, 0, [[0, '#8a8490'], [1, '#3e3844']]));
        rivet(g, hx, hy0 + 2, 2.2, '#9a94a0'); rivet(g, hx, hy0 + 17, 2.2, '#9a94a0');
      }
      const lx = (xa + xb) / 2;
      rect(g, lx - 8, hy1 - 14, 16, 10, grad(g, 0, hy1 - 14, 0, hy1 - 4, [[0, '#f2d68a'], [1, '#8a6228']]));
      rivet(g, lx, hy1 - 9, 2.4, '#e0b860', 0.4);
    }
    // road dust climbing the skirt
    rect(g, 0, ya, W, yb - ya, grad(g, 0, ya, 0, yb, [[0, '#8a7a64', 0], [0.5, '#8a7a64', 0.25], [1, '#9a8a70', 0.6]]));
  }
  // dust over the lower body, mud fans around the arches
  rect(g, 0, Y(1.0), W, Y(A.y0) - Y(1.0), grad(g, 0, Y(1.0), 0, Y(A.y0), [[0, '#9a8a6e', 0], [1, '#9a8a6e', 0.22]]));
  for (const az of A.archZ) {
    const cx = X(az), cy = Y(A.wheelY), r = A.archR * P;
    for (let i = 0; i < 40; i++) {
      const a = range(rnd, 0.25, Math.PI - 0.25), d = r * range(rnd, 1.02, 1.5);
      const x = cx + Math.cos(a) * d * (rnd() < 0.5 ? 1 : -1), y = cy - Math.sin(a) * d;
      blob(g, x, y, range(rnd, 3, 12), range(rnd, 2, 7), a, pick(rnd, ['#6a5440', '#7a6248', '#5a4636']), range(rnd, 0.15, 0.4), 0.4);
    }
    g.save(); g.beginPath(); g.arc(cx, cy, r + 10, Math.PI, TAU); g.lineWidth = 14; g.strokeStyle = rgba('#3a2e30', 0.35); g.filter = 'blur(4px)'; g.stroke(); g.restore();
  }
  // corner shade where the side meets the corner posts
  rect(g, 0, oy, 28, H, grad(g, 0, 0, 28, 0, [[0, INK, 0.3], [1, INK, 0]]));
  rect(g, W - 28, oy, 28, H, grad(g, W - 28, 0, W, 0, [[0, INK, 0], [1, INK, 0.3]]));
  g.restore();
}

// Front (x: -1.25..1.25 seen from the front, +X on the right) or rear (+X on the left).
function paintEnd(g, rnd, ox, rear) {
  const A = RV_ART, S = BODY.endW, oy = BODY.endY;
  const PX = S / 2.5, PY = S / 3;
  const X = x => ox + (rear ? (1.25 - x) : (x + 1.25)) * PX;
  const Y = y => oy + (A.y1 - y) * PY;
  g.save(); g.beginPath(); g.rect(ox, oy, S, S); g.clip();
  rect(g, ox, oy, S, S, grad(g, 0, Y(2.4), 0, Y(0.9), [[0, '#f4e8cc'], [1, '#e0cea8']]));
  mottleIn(g, rnd, ox, Y(2.4), S, Y(0.9) - Y(2.4), { colors: ['#f8eed6', '#e4d0a8', '#d6ccbc'], count: 30, rmin: 8, rmax: 30, alpha: 0.2 });
  rect(g, ox, Y(2.32), S, 18, grad(g, 0, Y(2.32), 0, Y(2.32) + 18, [[0, '#5a4a5a', 0.4], [1, '#5a4a5a', 0]]));
  // a riveted seam under the roof line and round the window
  for (let x = ox + 6; x < ox + S; x += 10) rivet(g, x, Y(2.2), 1.8, '#e2d2ae', 0.35);
  if (!rear) {
    // windshield opening (cut away) and the header
    const sw = A.shield;
    g.save(); g.filter = 'blur(4px)'; g.fillStyle = rgba('#4a3c44', 0.35); g.fillRect(X(-sw.x) - 5, Y(sw.y1) - 4, X(sw.x) - X(-sw.x) + 12, Y(sw.y0) - Y(sw.y1) + 14); g.restore();
  } else {
    const rw = A.rearWin;
    g.save(); g.filter = 'blur(4px)'; g.fillStyle = rgba('#4a3c44', 0.35); g.fillRect(X(rw.x) - 5, Y(rw.y1) - 4, X(-rw.x) - X(rw.x) + 12, Y(rw.y0) - Y(rw.y1) + 14); g.restore();
  }
  livery(g, rnd, ox, ox + S, Y, { chips: 1.4, woodNails: false, woodBand: rear });
  if (rear) {
    gilded(g, 'SLOPMASTER 9000', ox + S / 2, (Y(A.wood[1]) + Y(A.wood[0])) / 2 + 1, S * 0.86, 22, { track: 0.04 });
  }
  // skirt
  {
    const ya = Y(A.brassLow[0]), yb = Y(A.y0);
    rect(g, ox, ya, S, yb - ya, grad(g, 0, ya, 0, yb, [[0, '#6a6470'], [0.3, SKIRT], [1, '#38323c']]));
    for (let x = ox + 6; x < ox + S; x += 13) rivet(g, x, ya + 7, 2.0, '#7a7480', 0.5);
    rect(g, ox, ya, S, yb - ya, grad(g, 0, ya, 0, yb, [[0, '#8a7a64', 0], [1, '#9a8a70', 0.55]]));
  }
  if (!rear) {
    // dark well behind the grille
    g.save(); g.filter = 'blur(3px)'; g.fillStyle = '#2a2228'; rrect(g, X(-0.52), Y(0.6), X(0.52) - X(-0.52), Y(-0.24) - Y(0.6), 8); g.fill(); g.restore();
    // bugs on the nose
    for (let i = 0; i < 16; i++) {
      const x = ox + range(rnd, 10, S - 10), y = Y(range(rnd, -0.2, 1.0)), r = range(rnd, 1.2, 2.8);
      blob(g, x, y, r * 2.2, r * 1.6, rnd() * 3, pick(rnd, ['#b8b84a', '#9aa04a', '#c8a848']), 0.55, 0.5);
      ellipse(g, x, y, r * 0.6, r * 0.5, 0, '#3a2a20', 0.8);
    }
  }
  rect(g, ox, Y(1.0), S, Y(A.y0) - Y(1.0), grad(g, 0, Y(1.0), 0, Y(A.y0), [[0, '#9a8a6e', 0], [1, '#9a8a6e', rear ? 0.35 : 0.2]]));
  rect(g, ox, oy, 12, S, grad(g, ox, 0, ox + 12, 0, [[0, INK, 0.3], [1, INK, 0]]));
  rect(g, ox + S - 12, oy, 12, S, grad(g, ox + S - 12, 0, ox + S, 0, [[0, INK, 0], [1, INK, 0.3]]));
  g.restore();
}

// Roof: riveted tin plates, tar patches, leaves; z runs along u, x along v.
function paintRoof(g, rnd) {
  const ox = BODY.roof, oy = BODY.endY, W = 512, H = 256;
  const X = z => ox + (z + 4) * (W / 8);
  g.save(); g.beginPath(); g.rect(ox, oy, W, H); g.clip();
  rect(g, ox, oy, W, H, '#cfc6b2');
  mottleIn(g, rnd, ox, oy, W, H, { colors: ['#ddd4c0', '#bdb4a2', '#c8bca4', '#b0aca4'], count: 70, rmin: 10, rmax: 50, alpha: 0.3 });
  let z = -4;
  while (z < 4) {
    const L = range(rnd, 0.8, 1.15), x0 = X(z), x1 = X(Math.min(4, z + L));
    // each plate: lit toward the upper-left, shaded on its lower-right lap
    rect(g, x0, oy, x1 - x0, H, grad(g, x0, oy, x1, oy + H, [[0, '#fff4dc', 0.12], [0.6, '#000000', 0], [1, '#2c2340', 0.12]]));
    line(g, [[x1, oy], [x1, oy + H]], 3, '#6a6058', 0.6);
    line(g, [[x1 + 2.5, oy], [x1 + 2.5, oy + H]], 1.4, '#f4ecda', 0.6);
    for (let y = oy + 10; y < oy + H - 6; y += range(rnd, 12, 15)) {
      rivet(g, x1 - 5, y, 2.2, '#c8c0b0', 0.4);
      if (rnd() < 0.15) blob(g, x1 - 3, y + 6, 3, 9, 0, '#a2703c', 0.25, 0.3);
    }
    z += L;
  }
  // tar patches and a canvas patch
  for (let i = 0; i < 3; i++) {
    const x = ox + range(rnd, 30, W - 30), y = oy + range(rnd, 40, H - 40), r = range(rnd, 8, 16);
    g.save(); g.beginPath();
    for (let k = 0; k < 10; k++) { const a = k / 10 * TAU, rr = r * range(rnd, 0.7, 1.2); g.lineTo(x + Math.cos(a) * rr * 1.4, y + Math.sin(a) * rr); }
    g.closePath(); g.fillStyle = rgba('#4a3e3a', 0.75); g.fill(); g.restore();
    blob(g, x - r * 0.3, y - r * 0.3, r * 0.6, r * 0.3, -0.4, '#a09898', 0.35, 0.3);
  }
  {
    const x = ox + W * 0.62, y = oy + H * 0.3;
    g.save(); g.translate(x, y); g.rotate(0.08);
    rect(g, -30, -22, 60, 44, grad(g, 0, -22, 0, 22, [[0, '#d8c49a'], [1, '#a8946a']]));
    for (let i = -26; i < 30; i += 7) { nail(g, i, -18, 1.4); nail(g, i, 18, 1.4); }
    g.restore();
  }
  // leaves, twigs, and dust along the edges
  for (let i = 0; i < 40; i++) {
    const x = ox + rnd() * W, y = oy + (rnd() < 0.5 ? range(rnd, 4, 40) : range(rnd, H - 40, H - 4));
    blob(g, x, y, range(rnd, 2, 5), range(rnd, 1.2, 3), rnd() * 3, pick(rnd, ['#8a6a2a', '#6a7a3a', '#a2702a', '#5a4a2a']), 0.7, 0.6);
  }
  rect(g, ox, oy, W, 24, grad(g, 0, oy, 0, oy + 24, [[0, '#6a5a50', 0.45], [1, '#6a5a50', 0]]));
  rect(g, ox, oy + H - 24, W, 24, grad(g, 0, oy + H - 24, 0, oy + H, [[0, '#6a5a50', 0], [1, '#6a5a50', 0.45]]));
  g.restore();
}

register('rv_body', {
  family: F, w: BODY.W, h: BODY.H, note: 'body atlas: right side, left side, front, rear, roof',
  paint(g, s, rnd) {
    fill(g, BODY.W, BODY.H, CREAM);
    paintSide(g, rnd, 'R', BODY.R);
    paintSide(g, rnd, 'L', BODY.L);
    paintEnd(g, rnd, BODY.front, false);
    paintEnd(g, rnd, BODY.rear, true);
    paintRoof(g, rnd);
    glaze(g, BODY.W, BODY.H, '#ffe2b0', 0.08, 'soft-light');
  },
});

// ---- the trim sheet ------------------------------------------------------------------------------

// paint one band (512×64, tiles along x) on its own canvas, then copy it in
function band(g, i, fn, rnd) {
  const cv = makeCanvas(TRIM.W, TRIM.band), b = cv.getContext('2d');
  fn(b, TRIM.W, TRIM.band, rnd);
  g.drawImage(cv, 0, i * TRIM.band);
}
// across-band shading: lit top edge, shaded bottom (the band is a beam seen side-on)
function beamShade(b, W, H, c, light = 0.5) {
  rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, lightOf(c, light * 0.6)], [0.18, lightOf(c, light * 0.2)], [0.55, c], [1, shadowOf(c, light * 0.7)]]));
}
function bandEdges(b, W, H, c) {
  rect(b, 0, 0, W, 3, lightOf(c, 0.8), 0.6);
  rect(b, 0, H - 3, W, 3, shadowOf(c, 0.6), 0.6);
}
function bandMottle(b, W, H, rnd, colors, n = 30, alpha = 0.25, rmax = 26) {
  for (let i = 0; i < n; i++) { const x = rnd() * W, y = rnd() * H, r = range(rnd, 6, rmax); wrapX(W, x, r * 2, xx => blob(b, xx, y, r * 2, r * 0.6, 0, pick(rnd, colors), alpha * range(rnd, 0.5, 1), 0.2)); }
}
function woodBand(b, W, H, rnd, colors) {
  rect(b, 0, 0, W, H, '#2a2026');
  const ws = [];
  let tot = 0;
  while (tot < W - 60) { const L = range(rnd, 120, 230); ws.push(L); tot += L; }
  const k = W / tot;
  let x = rnd() * W;
  for (const L0 of ws) {
    const L = L0 * k, c = jitter(pick(rnd, colors), rnd, 0.06);
    const cv = makeCanvas(Math.ceil(L) + 2, H), pb = cv.getContext('2d');
    plank(pb, 0, 1, L - 1, H - 2, c, rnd, { grain: 11, knots: 0.4, light: 0.55, bevel: 3, nails: 2, endShade: 0.3 });
    wrapX(W, (x + L / 2) % W, L / 2 + 2, xx => b.drawImage(cv, xx - L / 2, 0));
    x += L;
  }
}

register('rv_trim', {
  family: F, w: TRIM.W, h: TRIM.H, note: 'trim sheet: 14 tiling bands + decal slots',
  paint(g, s, rnd) {
    const W = TRIM.W;
    fill(g, W, TRIM.H, '#5a4a40');
    band(g, TRIM.wood, (b, W, H, r) => woodBand(b, W, H, r, ['#5e3c24', '#54361f', '#64412a', '#4c321e']), rnd);
    band(g, TRIM.oak, (b, W, H, r) => woodBand(b, W, H, r, ['#a8743e', '#9a6a38', '#b07c44', '#a06c3a']), rnd);
    // brass: a rolled highlight across the top third, tarnish, scratches
    band(g, TRIM.brass, (b, W, H, r) => {
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#8a6428'], [0.1, '#ffeaa8'], [0.3, '#e0b45a'], [0.6, '#b0843a'], [0.85, '#6a4a22'], [1, '#9a7434']]));
      bandMottle(b, W, H, r, ['#7a8a5a', '#8a6a30', '#f0d488'], 26, 0.22);
      for (let i = 0; i < 40; i++) { const x = r() * W, y = r() * H, L = range(r, 8, 30); wrapX(W, x, L, xx => line(b, [[xx, y], [xx + L, y + (r() - 0.5) * 2]], 0.8, r() < 0.5 ? '#fff4c8' : '#6a4a22', 0.3)); }
    }, rnd);
    // iron: blue-gray plate, a row of rivets, rust blooms
    band(g, TRIM.iron, (b, W, H, r) => {
      beamShade(b, W, H, '#4c4a56', 0.6);
      bandMottle(b, W, H, r, ['#5a5866', '#3a3844', '#6a4a3a'], 30, 0.3);
      for (let x = 10; x < W; x += 32) { rivet(b, x, 16, 3.2, '#7a7888'); rivet(b, x + 16, H - 16, 3.2, '#7a7888'); }
      for (let i = 0; i < 10; i++) { const x = r() * W; wrapX(W, x, 10, xx => line(b, [[xx, r() * H * 0.5], [xx + (r() - 0.5) * 2, H * range(r, 0.6, 1)]], range(r, 1.5, 3), '#8a5a32', 0.22)); }
      bandEdges(b, W, H, '#4c4a56');
    }, rnd);
    // goblin red and goblin green: painted iron, chipped to the metal
    for (const [i, c] of [[TRIM.red, '#9c3a26'], [TRIM.green, '#4e6e36']]) {
      band(g, i, (b, W, H, r) => {
        beamShade(b, W, H, c, 0.55);
        bandMottle(b, W, H, r, [lightOf(c, 0.2), shadowOf(c, 0.2)], 24, 0.3);
        for (let k = 0; k < 16; k++) {
          const x = r() * W, y = r() < 0.75 ? (r() < 0.5 ? range(r, 2, 10) : range(r, H - 10, H - 2)) : r() * H, rr = range(r, 1.5, 4.5);
          wrapX(W, x, rr * 2, xx => { ellipse(b, xx + 0.8, y + 0.9, rr * 1.3, rr, r(), INK, 0.3); ellipse(b, xx, y, rr * 1.3, rr, r(), '#5c5660', 0.9); blob(b, xx - rr * 0.3, y - rr * 0.3, rr * 0.5, rr * 0.4, 0, '#9a98a4', 0.6, 0.4); });
        }
        for (let x = 14; x < W; x += 64) rivet(b, x, H / 2, 3.4, lightOf(c, 0.1));
        bandEdges(b, W, H, c);
      }, rnd);
    }
    // cream painted metal (matches the body)
    band(g, TRIM.cream, (b, W, H, r) => {
      beamShade(b, W, H, CREAM, 0.45);
      bandMottle(b, W, H, r, ['#f8eed6', '#e4d0a8', '#d6ccbc'], 30, 0.25);
      for (let x = 8; x < W; x += 24) rivet(b, x, H - 12, 2.4, '#e2d2ae', 0.4);
      bandEdges(b, W, H, CREAM);
    }, rnd);
    // tire: smooth sidewalls at both edges, chunky chevron tread blocks in the middle
    band(g, TRIM.tread, (b, W, H, r) => {
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#4a4450'], [0.2, '#34303a'], [0.5, '#2a262e'], [0.8, '#221e26'], [1, '#3a3640']]));
      const n = 14, bw = W / n;
      for (let i = 0; i < n; i++) {
        for (const [y0, off, sl] of [[13, 0, 5], [33, bw * 0.5, -5]]) {
          wrapX(W, i * bw + off + bw / 2, bw, cx => {
            const L = cx - bw / 2;
            b.save(); b.beginPath();
            b.moveTo(L + 3 + sl, y0); b.lineTo(L + bw - 5 + sl, y0); b.lineTo(L + bw - 5 - sl, y0 + 16); b.lineTo(L + 3 - sl, y0 + 16); b.closePath();
            b.fillStyle = grad(b, 0, y0, 0, y0 + 16, [[0, '#5e5864'], [0.4, '#3c3842'], [1, '#2a2630']]); b.fill(); b.restore();
            line(b, [[L + 4 + sl, y0 + 1], [L + bw - 6 + sl, y0 + 1]], 1.4, '#7a7480', 0.6);
          });
        }
      }
      // molded sidewall ring and a little dust
      line(b, [[0, 7], [W, 7]], 1.2, '#5a5660', 0.6); line(b, [[0, H - 7], [W, H - 7]], 1.2, '#5a5660', 0.6);
      bandMottle(b, W, H, r, ['#6a5a4a', '#7a6a58'], 20, 0.18, 14);
    }, rnd);
    // the tow strap: orange webbing, stitched edges
    band(g, TRIM.strap, (b, W, H, r) => {
      beamShade(b, W, H, '#e07a2a', 0.5);
      for (let y = 6; y < H - 4; y += 4) line(b, [[0, y], [W, y]], 1, y % 8 ? '#f29a4a' : '#b85a1a', 0.35);
      for (let x = 0; x < W; x += 10) { line(b, [[x, 9], [x + 6, 9]], 1.6, '#fff0d0', 0.7); line(b, [[x + 3, H - 10], [x + 9, H - 10]], 1.6, '#fff0d0', 0.7); }
      bandMottle(b, W, H, r, ['#8a5a3a', '#6a4a3a'], 12, 0.25, 16);
      bandEdges(b, W, H, '#e07a2a');
    }, rnd);
    // gingham curtains: red and cream check with soft folds
    band(g, TRIM.gingham, (b, W, H, r) => {
      rect(b, 0, 0, W, H, '#efe2c8');
      const cs = 8;
      for (let x = 0; x < W; x += cs * 2) rect(b, x, 0, cs, H, '#b84a3a', 0.55);
      for (let y = 0; y < H; y += cs * 2) rect(b, 0, y, W, cs, '#b84a3a', 0.55);
      for (let x = 0; x < W; x += 32) rect(b, x, 0, 16, H, grad(b, x, 0, x + 16, 0, [[0, '#2c2340', 0], [0.5, '#2c2340', 0.22], [1, '#2c2340', 0]]));
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#fff4dc', 0.25], [0.5, '#000000', 0], [1, '#2c2340', 0.3]]));
    }, rnd);
    // slate countertop
    band(g, TRIM.slate, (b, W, H, r) => {
      beamShade(b, W, H, '#62666e', 0.5);
      bandMottle(b, W, H, r, ['#70747c', '#565a62', '#6a6460'], 40, 0.3);
      for (let i = 0; i < 8; i++) { const x = r() * W; wrapX(W, x, 20, xx => line(b, [[xx, r() * H], [xx + range(r, -16, 16), r() * H]], 0.9, '#3a3c44', 0.4)); }
      bandEdges(b, W, H, '#62666e');
    }, rnd);
    // canvas / linen
    band(g, TRIM.canvas, (b, W, H, r) => {
      beamShade(b, W, H, '#cdb88c', 0.45);
      for (let i = 0; i < 60; i++) { const x = r() * W, y = r() * H, L = range(r, 20, 80); wrapX(W, x, L, xx => line(b, [[xx, y], [xx + L, y + (r() - 0.5) * 2]], 1, r() < 0.5 ? '#e0d0a8' : '#a8946a', 0.25)); }
      bandMottle(b, W, H, r, ['#a8946a', '#8a7a5a', '#e4d4ac'], 16, 0.25);
      for (let x = 0; x < W; x += 9) line(b, [[x, H - 9], [x + 5, H - 9]], 1.3, '#6a5a40', 0.55);
    }, rnd);
    // opaque painted window glass: deep teal with a diagonal sky reflection
    band(g, TRIM.glass, (b, W, H, r) => {
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#4a7488'], [0.5, '#2c4a5c'], [1, '#1c2a3a']]));
      for (let x = -40; x < W + 40; x += range(r, 50, 90)) {
        const w = range(r, 10, 24);
        wrapX(W, x, 60, xx => { b.save(); b.globalAlpha = 0.28; b.fillStyle = '#c8e4ec'; b.beginPath(); b.moveTo(xx, H); b.lineTo(xx + w, H); b.lineTo(xx + w + 30, 0); b.lineTo(xx + 30, 0); b.closePath(); b.fill(); b.restore(); });
      }
      rect(b, 0, 0, W, 6, '#9ac0cc', 0.4);
    }, rnd);
    // rope: twisted strands on the diagonal
    band(g, TRIM.rope, (b, W, H, r) => {
      rect(b, 0, 0, W, H, '#8a6a40');
      for (let x = -H; x < W + H; x += 9) {
        b.save(); b.beginPath(); b.moveTo(x, H); b.lineTo(x + 8, H); b.lineTo(x + 8 + H * 0.6, 0); b.lineTo(x + H * 0.6, 0); b.closePath();
        b.fillStyle = grad(b, x, 0, x + 8, 0, [[0, '#c8a066'], [0.5, '#a07a48'], [1, '#5a4024']]); b.fill(); b.restore();
      }
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#fff0c8', 0.25], [0.5, '#000000', 0], [1, '#2c2340', 0.4]]));
    }, rnd);
    paintSlots(g, rnd);
  },
});

// decal slots (band 14: 64² each; band 15: 128×64 each)
function paintSlots(g, rnd) {
  const y = TRIM.slots * TRIM.band, S = 64;
  const at = i => i * S;
  rect(g, 0, y, TRIM.W, S * 2, '#3a3036');
  // hub: a red-spoked wheel with a brass boss (seen face-on)
  {
    const cx = at(TRIM.s.hub) + 32, cy = y + 32;
    ellipse(g, cx, cy, 31, 31, 0, '#3a3036');
    g.save(); g.beginPath(); g.arc(cx, cy, 30, 0, TAU); g.fillStyle = grad(g, cx - 30, cy - 30, cx + 30, cy + 30, [[0, '#c4583a'], [0.5, '#9c3a26'], [1, '#5a2018']]); g.fill(); g.restore();
    g.save(); g.beginPath(); g.arc(cx, cy, 24, 0, TAU); g.fillStyle = '#2a2026'; g.fill(); g.restore();
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * TAU + 0.3;
      stroke(g, [[cx + Math.cos(a) * 6, cy + Math.sin(a) * 6], [cx + Math.cos(a) * 25, cy + Math.sin(a) * 25]], 7, 5, '#a8442c');
      line(g, [[cx + Math.cos(a) * 7 - 1, cy + Math.sin(a) * 7 - 1.5], [cx + Math.cos(a) * 24 - 1, cy + Math.sin(a) * 24 - 1.5]], 1.4, '#e08a5a', 0.6);
    }
    g.save(); g.beginPath(); g.arc(cx, cy, 11, 0, TAU); g.fillStyle = grad(g, cx - 10, cy - 10, cx + 10, cy + 10, [[0, '#ffe8a0'], [0.5, '#c8963e'], [1, '#6a4a20']]); g.fill(); g.restore();
    for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; rivet(g, cx + Math.cos(a) * 7, cy + Math.sin(a) * 7, 1.6, '#e0b860', 0.3); }
    blob(g, cx - 12, cy - 14, 9, 4, -0.7, '#fff0d0', 0.35, 0.3);
  }
  // gauges: cream faces, brass bezels, a needle
  for (const [i, lbl, ang] of [[TRIM.s.gauge, 'MPH', -0.6], [TRIM.s.fuel, 'E   F', -2.4]]) {
    const cx = at(i) + 32, cy = y + 32;
    g.save(); g.beginPath(); g.arc(cx, cy, 31, 0, TAU); g.fillStyle = grad(g, cx - 30, cy - 30, cx + 30, cy + 30, [[0, '#ffe8a0'], [0.5, '#c8963e'], [1, '#5a3a18']]); g.fill(); g.restore();
    g.save(); g.beginPath(); g.arc(cx, cy, 25, 0, TAU); g.fillStyle = grad(g, cx - 20, cy - 25, cx + 20, cy + 25, [[0, '#f6ecd0'], [1, '#c8b890']]); g.fill(); g.restore();
    for (let k = 0; k <= 10; k++) { const a = Math.PI * 0.75 + k / 10 * Math.PI * 1.5; line(g, [[cx + Math.cos(a) * 18, cy + Math.sin(a) * 18], [cx + Math.cos(a) * 23, cy + Math.sin(a) * 23]], k % 5 ? 1 : 2, '#3a2a20', 0.85); }
    if (i === TRIM.s.fuel) { g.save(); g.beginPath(); g.arc(cx, cy, 20, Math.PI * 0.75, Math.PI * 1.0); g.lineWidth = 4; g.strokeStyle = '#b8402a'; g.stroke(); g.restore(); }
    g.save(); g.font = `bold 8px ${SERIF}`; g.textAlign = 'center'; g.fillStyle = '#4a3020'; g.fillText(lbl, cx, cy + 14); g.restore();
    stroke(g, [[cx, cy], [cx + Math.cos(ang) * 20, cy + Math.sin(ang) * 20]], 2.6, 1, '#a82a1a');
    ellipse(g, cx, cy, 3.2, 3.2, 0, '#3a2a20');
    blob(g, cx - 10, cy - 12, 12, 5, -0.6, '#ffffff', 0.35, 0.3);
  }
  // frosted porthole glass
  {
    const x0 = at(TRIM.s.frost);
    rect(g, x0, y, S, S, grad(g, x0, y, x0 + S, y + S, [[0, '#e4eef0'], [0.5, '#b8ccd2'], [1, '#8aa2ac']]));
    for (let k = 0; k < 14; k++) blob(g, x0 + rnd() * S, y + rnd() * S, range(rnd, 5, 14), range(rnd, 4, 10), rnd() * 3, pick(rnd, ['#ffffff', '#a8bcc4']), 0.35, 0.2);
  }
  // emblem cog
  cog(g, at(TRIM.s.emblem) + 32, y + 32, 29, rnd);
  // cast-iron burner ring
  {
    const cx = at(TRIM.s.burner) + 32, cy = y + 32;
    rect(g, at(TRIM.s.burner), y, S, S, '#3a3840');
    for (const [r, c] of [[28, '#26242a'], [24, '#4a4852'], [17, '#26242a'], [13, '#4a4852'], [6, '#26242a']]) ellipse(g, cx, cy, r, r, 0, c);
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; line(g, [[cx + Math.cos(a) * 13, cy + Math.sin(a) * 13], [cx + Math.cos(a) * 27, cy + Math.sin(a) * 27]], 3, '#5a5862'); }
    blob(g, cx - 10, cy - 12, 10, 4, -0.6, '#8a8894', 0.5, 0.3);
  }
  // clock face
  {
    const cx = at(TRIM.s.clock) + 32, cy = y + 32;
    g.save(); g.beginPath(); g.arc(cx, cy, 31, 0, TAU); g.fillStyle = grad(g, cx - 30, cy - 30, cx + 30, cy + 30, [[0, '#ffe8a0'], [1, '#6a4a20']]); g.fill(); g.restore();
    ellipse(g, cx, cy, 26, 26, 0, '#f2e6c8');
    for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; ellipse(g, cx + Math.cos(a) * 21, cy + Math.sin(a) * 21, 1.6, 1.6, 0, '#3a2a20'); }
    stroke(g, [[cx, cy], [cx + 12, cy - 6]], 2.6, 1.2, '#3a2a20'); stroke(g, [[cx, cy], [cx - 3, cy - 18]], 2, 1, '#3a2a20');
  }
  // an apple (fruit bowl, wagon snacks)
  {
    const x0 = at(TRIM.s.apple);
    rect(g, x0, y, S, S, grad(g, x0, y, x0 + S, y + S, [[0, '#e86a4a'], [0.5, '#b8342a'], [1, '#6a1a1a']]));
    blob(g, x0 + 20, y + 18, 12, 8, -0.6, '#ffd8a0', 0.5, 0.3);
    blob(g, x0 + 44, y + 44, 14, 10, 0, '#e8b048', 0.3, 0.3);
  }
  // wide slots
  const y2 = TRIM.wide * TRIM.band, WW = 128;
  const atw = i => i * WW;
  // license plate: a riveted brass plate, painted letters
  {
    const x0 = atw(TRIM.w.plate);
    rect(g, x0, y2, WW, S, grad(g, 0, y2, 0, y2 + S, [[0, '#f2d690'], [0.5, '#c89848'], [1, '#7a5426']]));
    g.save(); rrect(g, x0 + 5, y2 + 5, WW - 10, S - 10, 5); g.lineWidth = 2.5; g.strokeStyle = '#5a3a1a'; g.stroke(); g.restore();
    gilded(g, 'SLOP 9K', x0 + WW / 2, y2 + 30, WW - 22, 26, { fillTop: '#3a5a7a', fillBot: '#1c2c44', outline: '#f6e6b8', track: 0.04 });
    g.save(); g.font = `bold 8px ${SERIF}`; g.textAlign = 'center'; g.fillStyle = '#5a3a1a'; g.fillText('GADGETZAN · TRADE PERMIT', x0 + WW / 2, y2 + 52); g.restore();
    for (const [u, v] of [[10, 10], [WW - 10, 10], [10, S - 10], [WW - 10, S - 10]]) rivet(g, x0 + u, y2 + v, 2.6, '#8a6a3a');
  }
  // bumper sticker: a painted wooden board
  {
    const x0 = atw(TRIM.w.sticker);
    plank(g, x0 + 2, y2 + 6, WW - 4, S - 12, '#8a5a32', rnd, { grain: 8, knots: 0, light: 0.5, nails: 4 });
    gilded(g, 'NO MONEY DOWN', x0 + WW / 2, y2 + 32, WW - 20, 20, { track: 0.03 });
  }
  // radio face: brass grille, a dial, two knobs
  {
    const x0 = atw(TRIM.w.radio);
    rect(g, x0, y2, WW, S, grad(g, 0, y2, 0, y2 + S, [[0, '#6a4428'], [1, '#3a2418']]));
    rect(g, x0 + 6, y2 + 6, 56, S - 12, grad(g, 0, y2, 0, y2 + S, [[0, '#e8c070'], [1, '#8a6228']]));
    for (let yy = y2 + 10; yy < y2 + S - 10; yy += 5) line(g, [[x0 + 9, yy], [x0 + 59, yy]], 2, '#4a3018', 0.8);
    rect(g, x0 + 68, y2 + 10, 52, 22, '#f0dca8');
    for (let k = 0; k < 9; k++) line(g, [[x0 + 72 + k * 5.5, y2 + 14], [x0 + 72 + k * 5.5, y2 + (k % 2 ? 18 : 22)]], 1, '#4a3020');
    line(g, [[x0 + 95, y2 + 11], [x0 + 95, y2 + 31]], 2, '#b8302a');
    for (const kx of [80, 108]) { ellipse(g, kx + x0, y2 + 46, 8, 8, 0, '#2a1a14'); ellipse(g, kx + x0 - 1, y2 + 45, 6, 6, 0, '#c8963e'); blob(g, kx + x0 - 3, y2 + 42, 3, 2, 0, '#fff0c0', 0.8, 0.4); }
  }
  // brass maker's plaque
  {
    const x0 = atw(TRIM.w.plaque);
    rect(g, x0, y2, WW, S, grad(g, 0, y2, 0, y2 + S, [[0, '#f6dc94'], [0.5, '#c8963e'], [1, '#6a4a20']]));
    g.save(); rrect(g, x0 + 4, y2 + 4, WW - 8, S - 8, 6); g.lineWidth = 2; g.strokeStyle = '#5a3a14'; g.stroke(); g.restore();
    g.save(); g.textAlign = 'center'; g.fillStyle = '#4a2c10'; g.font = `bold 17px ${SERIF}`; g.fillText('SLOPMASTER', x0 + WW / 2, y2 + 28);
    g.font = `bold 13px ${SERIF}`; g.fillText('~ 9000 ~', x0 + WW / 2, y2 + 46); g.restore();
    for (const [u, v] of [[9, 9], [WW - 9, 9], [9, S - 9], [WW - 9, S - 9]]) rivet(g, x0 + u, y2 + v, 2.2, '#8a6a3a');
  }
}

// ---- interior ------------------------------------------------------------------------------------

// Wall boards. u tiles along the wall; v runs floor (bottom) to ceiling (top), no vertical tiling.
register('rv_paneling', {
  family: F, size: 512, note: 'interior wall boards: wainscot, chair rail, upper boards (tiles along u)',
  paint(g, s, rnd) {
    const yRail = s * (1 - 0.92 / 2.3), yBase = s * (1 - 0.12 / 2.3), yCrown = s * (0.08 / 2.3);
    fill(g, s, s, '#2a2026');
    // upper boards: lighter honey pine, vertical, tongue-and-groove
    const boards = (y0, y1, colors, wmin, wmax) => {
      let x = rnd() * 30, xs = [];
      const ws = []; let tot = 0;
      while (tot < s - wmin * 0.5) { const w = range(rnd, wmin, wmax); ws.push(w); tot += w; }
      const k = s / tot;
      for (const w0 of ws) {
        const w = w0 * k, c = jitter(pick(rnd, colors), rnd, 0.06);
        const cv = makeCanvas(Math.ceil(w) + 2, Math.ceil(y1 - y0)), b = cv.getContext('2d');
        plank(b, 0, 0, w - 2, y1 - y0, c, rnd, { vertical: true, grain: 8, knots: 0.35, light: 0.45, bevel: 3, endShade: 0, nails: 0 });
        wrap(s, x + w / 2, (y0 + y1) / 2, w / 2 + 2, (xx, yy) => { if (Math.abs(yy - (y0 + y1) / 2) < 1) g.drawImage(cv, xx - w / 2, y0); });
        xs.push(x);
        x += w;
      }
      return xs;
    };
    boards(yCrown, yRail, ['#b88a52', '#a87c48', '#c4955a', '#ae804c'], 46, 70);
    boards(yRail, yBase, ['#7a4e2e', '#6e4529', '#845634', '#734a2c'], 70, 110);
    // warm lantern-lit top, cooler floor
    rect(g, 0, 0, s, s, grad(g, 0, 0, 0, s, [[0, '#ffe0a0', 0.12], [0.45, '#000000', 0], [1, '#2c2340', 0.3]]));
    // chair rail
    rect(g, 0, yRail - 7, s, 14, grad(g, 0, yRail - 7, 0, yRail + 7, [[0, '#d8a868'], [0.3, '#8a5a34'], [1, '#3a2418']]));
    rect(g, 0, yRail + 7, s, 6, grad(g, 0, yRail + 7, 0, yRail + 13, [[0, INK, 0.45], [1, INK, 0]]));
    // baseboard and crown
    rect(g, 0, yBase, s, s - yBase, grad(g, 0, yBase, 0, s, [[0, '#8a5a34'], [0.2, '#5a3820'], [1, '#2e1e16']]));
    rect(g, 0, 0, s, yCrown, grad(g, 0, 0, 0, yCrown, [[0, '#3a2418'], [0.7, '#8a5a34'], [1, '#c89858']]));
    rect(g, 0, yCrown, s, 6, grad(g, 0, yCrown, 0, yCrown + 6, [[0, INK, 0.4], [1, INK, 0]]));
    for (let x = 12; x < s; x += 64) { nail(g, x, yRail, 1.8); nail(g, x + 30, yBase + 8, 1.6); }
    glaze(g, s, s, '#ffd8a0', 0.1, 'soft-light');
  },
});

register('rv_floor', {
  family: F, size: 512, note: 'plank floor (tiles); planks run along u',
  paint(g, s, rnd) {
    const rects = rowLayout(s, rnd, { rows: 5, minW: 150, maxW: 300, rowJitter: 0.12 });
    fill(g, s, s, '#241a1e');
    for (const r of rects) {
      const c = jitter(pick(rnd, ['#8e5e34', '#80522e', '#9a683a', '#74492a']), rnd, 0.07);
      const w = r.w - 2, h = r.h - 3;
      const cv = makeCanvas(Math.ceil(w) + 2, Math.ceil(h) + 2), b = cv.getContext('2d');
      plank(b, 0, 0, w, h, c, rnd, { grain: 10, knots: 0.4, light: 0.4, bevel: 3, nails: 4, endShade: 0.35, splits: 0.35 });
      wrap(s, r.x + 1 + w / 2, r.y + 1 + h / 2, Math.max(w, h) / 2 + 2, (xx, yy) => g.drawImage(cv, xx - w / 2, yy - h / 2));
    }
    // scuffs and a worn sheen
    mottle(g, s, rnd, { colors: ['#b88a5a', '#5a3a24'], count: 18, rmin: 20, rmax: 60, alpha: 0.12, stretch: 2.5, rot: Math.PI / 2 });
    glaze(g, s, s, '#ffd8a0', 0.08, 'soft-light');
    blurTile(g.canvas, 0.3);
  },
});

register('rv_soft', {
  family: F, size: 512, note: 'soft goods: patchwork quilt, tufted plaid, braided rag rug, shower tiles',
  paint(g, s, rnd) {
    fill(g, s, s, '#6a4a3a');
    // patchwork quilt: 8×3 puffy patches, stitched, with a binding
    {
      const [x0, y0, W, H] = SOFT.quilt, cols = 8, rows = 3, pw = W / cols, ph = H / rows;
      const fabrics = ['#9a3a2c', '#c8973e', '#5a7a4a', '#3e5a7a', '#e2d2ac', '#7a4a6a', '#b85a3a', '#4a6a5a'];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const c = jitter(fabrics[(i * 3 + j * 5 + Math.floor(rnd() * 2)) % fabrics.length], rnd, 0.06);
        const X = x0 + i * pw, Y = y0 + j * ph;
        rect(g, X, Y, pw, ph, grad(g, X, Y, X + pw, Y + ph, [[0, lightOf(c, 0.35)], [0.5, c], [1, shadowOf(c, 0.45)]]));
        // a pattern on some patches: dots, stripes, little flowers
        const kind = (i + j * 2) % 4;
        if (kind === 0) for (let k = 0; k < 7; k++) ellipse(g, X + range(rnd, 5, pw - 5), Y + range(rnd, 5, ph - 5), 2.2, 2.2, 0, lightOf(c, 0.8), 0.7);
        if (kind === 1) for (let k = 4; k < pw; k += 7) line(g, [[X + k, Y + 2], [X + k, Y + ph - 2]], 2, shadowOf(c, 0.3), 0.5);
        if (kind === 2) for (let k = 0; k < 4; k++) { const fx = X + range(rnd, 8, pw - 8), fy = Y + range(rnd, 8, ph - 8); for (let p = 0; p < 5; p++) { const a = p / 5 * TAU; ellipse(g, fx + Math.cos(a) * 3, fy + Math.sin(a) * 3, 2.2, 2.2, 0, '#f2e2b8', 0.8); } ellipse(g, fx, fy, 1.6, 1.6, 0, '#c8973e'); }
        blob(g, X + pw * 0.35, Y + ph * 0.35, pw * 0.4, ph * 0.3, 0, '#fff4dc', 0.18, 0.2);
        // stitches
        g.save(); g.setLineDash([3, 3]); g.strokeStyle = rgba('#f4e8c8', 0.7); g.lineWidth = 1.1; g.strokeRect(X + 3.5, Y + 3.5, pw - 7, ph - 7); g.restore();
        rect(g, X + pw - 2, Y, 2, ph, INK, 0.45); rect(g, X, Y + ph - 2, pw, 2, INK, 0.45);
      }
      g.save(); g.lineWidth = 6; g.strokeStyle = '#6a2a22'; g.strokeRect(x0 + 3, y0 + 3, W - 6, H - 6); g.restore();
    }
    // tufted plaid upholstery
    {
      const [x0, y0, W, H] = SOFT.plaid;
      rect(g, x0, y0, W, H, '#8a3a2a');
      for (let x = 0; x < W; x += 32) { rect(g, x0 + x + 4, y0, 12, H, '#3e4a32', 0.55); rect(g, x0 + x + 22, y0, 2, H, '#d8b05a', 0.6); }
      for (let y = 0; y < H; y += 32) { rect(g, x0, y0 + y + 4, W, 12, '#3e4a32', 0.45); rect(g, x0, y0 + y + 22, W, 2, '#d8b05a', 0.55); }
      // tufts: a diamond grid of buttons with puffs between
      for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
        const bx = x0 + i * 64 + (j % 2 ? 32 : 0), by = y0 + j * 64;
        blob(g, bx - 16, by - 20, 26, 22, 0, '#fff0d0', 0.12, 0.2);
        blob(g, bx + 10, by + 12, 22, 18, 0, '#2c2340', 0.2, 0.2);
      }
      for (let j = 0; j <= 4; j++) for (let i = 0; i <= 4; i++) {
        const bx = x0 + i * 64 + (j % 2 ? 32 : 0), by = y0 + j * 64;
        for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + Math.PI / 4; line(g, [[bx, by], [bx + Math.cos(a) * 14, by + Math.sin(a) * 14]], 1.4, '#3a1a14', 0.4); }
        blob(g, bx + 1.5, by + 2, 6, 6, 0, INK, 0.5, 0.3); ellipse(g, bx, by, 3.4, 3.4, 0, '#5a2a1e'); blob(g, bx - 1, by - 1.2, 1.6, 1.4, 0, '#d89a7a', 0.8, 0.4);
      }
      rect(g, x0, y0, W, H, grad(g, x0, y0, x0 + W * 0.4, y0 + H, [[0, '#fff0d0', 0.12], [0.5, '#000000', 0], [1, '#2c2340', 0.25]]));
    }
    // braided rag rug: concentric braids (the geometry is an oval disc)
    {
      const [x0, y0, W, H] = SOFT.rug, cx = x0 + W / 2, cy = y0 + H / 2;
      const rings = ['#7a3a2a', '#c8973e', '#3e5a7a', '#e2d2ac', '#9a3a2c', '#5a7a4a', '#c8973e', '#7a4a6a', '#e2d2ac', '#3e5a7a', '#9a3a2c'];
      rect(g, x0, y0, W, H, rings[0]);
      const n = rings.length, dr = (W / 2) / n;
      for (let k = 0; k < n; k++) {
        const r = W / 2 - k * dr, c = rings[k];
        ellipse(g, cx, cy, r, r, 0, shadowOf(c, 0.4));
        ellipse(g, cx, cy, r - 1.5, r - 1.5, 0, c);
        // braid: little slanted strokes around the ring
        const m = Math.max(10, Math.floor(TAU * (r - dr / 2) / 5));
        for (let i = 0; i < m; i++) {
          const a = i / m * TAU, rr = r - dr / 2;
          const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr, ta = a + Math.PI / 2 + (i % 2 ? 0.6 : -0.6);
          line(g, [[px - Math.cos(ta) * dr * 0.35, py - Math.sin(ta) * dr * 0.35], [px + Math.cos(ta) * dr * 0.35, py + Math.sin(ta) * dr * 0.35]], dr * 0.35, i % 2 ? lightOf(c, 0.35) : shadowOf(c, 0.25), 0.55);
        }
      }
      blob(g, cx - W * 0.15, cy - H * 0.15, W * 0.35, H * 0.25, 0, '#fff0d0', 0.12, 0.2);
    }
    // shower tiles: cream and teal, soft grout, lit bevels, a painted border row
    {
      const [x0, y0, W, H] = SOFT.tile, cols = 6, rows = 16, tw = W / cols, th = H / rows;
      rect(g, x0, y0, W, H, '#8a8a84');
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const border = j === 7;
        const c = jitter(border ? '#3e7a7a' : (i + j) % 2 ? '#e6ddc6' : '#7ab0aa', rnd, 0.05);
        const X = x0 + i * tw + 1.5, Y = y0 + j * th + 1.5, w = tw - 3, h = th - 3;
        g.save(); rrect(g, X, Y, w, h, 3); g.clip();
        rect(g, X, Y, w, h, grad(g, X, Y, X + w * 0.6, Y + h, [[0, lightOf(c, 0.3)], [0.5, c], [1, shadowOf(c, 0.3)]]));
        if (border) { ellipse(g, X + w / 2, Y + h / 2, 3, 3, 0, '#e8c87a'); for (let p = 0; p < 4; p++) { const a = p / 4 * TAU; ellipse(g, X + w / 2 + Math.cos(a) * 5, Y + h / 2 + Math.sin(a) * 4, 2.2, 1.6, a, '#f2e6c8'); } }
        rect(g, X, Y, w, 2, '#ffffff', 0.4); rect(g, X, Y, 2, h, '#ffffff', 0.3);
        rect(g, X, Y + h - 2, w, 2, INK, 0.25);
        blob(g, X + w * 0.3, Y + h * 0.3, w * 0.2, h * 0.12, -0.5, '#ffffff', 0.35, 0.3);
        g.restore();
      }
      // water stains low on the wall
      rect(g, x0, y0 + H * 0.7, W, H * 0.3, grad(g, 0, y0 + H * 0.7, 0, y0 + H, [[0, '#6a7a6a', 0], [1, '#6a7a6a', 0.3]]));
    }
  },
});

// ---- lamps and glass -----------------------------------------------------------------------------

register('rv_lamps', {
  family: F, size: 256, note: 'lenses: headlight, tail, amber marker, lantern glass (also the glow map)',
  paint(g, s, rnd) {
    fill(g, s, s, '#3a3036');
    const lens = ([x0, y0, w], core, mid, rim, rings = 4) => {
      const cx = x0 + w / 2, cy = y0 + w / 2, R = w / 2;
      rect(g, x0, y0, w, w, rim);
      const gr = g.createRadialGradient(cx - R * 0.15, cy - R * 0.15, 0, cx, cy, R);
      gr.addColorStop(0, core); gr.addColorStop(0.55, mid); gr.addColorStop(1, rim);
      g.fillStyle = gr; g.fillRect(x0, y0, w, w);
      for (let k = 1; k <= rings; k++) { g.save(); g.beginPath(); g.arc(cx, cy, R * k / (rings + 1), 0, TAU); g.lineWidth = 2; g.strokeStyle = rgba(rim, 0.35); g.stroke(); g.restore(); }
      for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; line(g, [[cx + Math.cos(a) * R * 0.2, cy + Math.sin(a) * R * 0.2], [cx + Math.cos(a) * R * 0.95, cy + Math.sin(a) * R * 0.95]], 1.5, rim, 0.18); }
      blob(g, cx - R * 0.35, cy - R * 0.4, R * 0.32, R * 0.18, -0.7, '#ffffff', 0.75, 0.4);
    };
    lens(LAMPS.head, '#fffbe8', '#f4e2a8', '#b89a5a');
    lens(LAMPS.tail, '#ff9a6a', '#d0402a', '#6a1a14', 5);
    lens(LAMPS.amber, '#ffe8a0', '#f0a030', '#8a4a14', 3);
    // lantern glass: warm, a flame, soot at the top
    {
      const [x0, y0, w] = LAMPS.lantern, cx = x0 + w / 2;
      rect(g, x0, y0, w, w, grad(g, 0, y0, 0, y0 + w, [[0, '#6a4a2a'], [0.25, '#e8b060'], [0.7, '#f6d488'], [1, '#c88a40']]));
      blob(g, cx, y0 + w * 0.6, w * 0.36, w * 0.4, 0, '#fff4c8', 0.8, 0.3);
      g.save(); g.beginPath(); g.moveTo(cx, y0 + w * 0.3); g.quadraticCurveTo(cx + w * 0.13, y0 + w * 0.55, cx, y0 + w * 0.72); g.quadraticCurveTo(cx - w * 0.13, y0 + w * 0.55, cx, y0 + w * 0.3);
      g.fillStyle = '#fffbe8'; g.fill(); g.restore();
      blob(g, cx, y0 + w * 0.66, w * 0.06, w * 0.08, 0, '#ff9a3a', 0.8, 0.4);
      for (let k = 0; k < 3; k++) line(g, [[x0 + w * (0.2 + k * 0.3), y0], [x0 + w * (0.2 + k * 0.3), y0 + w]], 3, '#3a2a20', 0.5);
    }
  },
});

register('rv_glass', {
  family: F, size: 256, alpha: true, note: 'see-through window glass (alpha): streaks and grime',
  paint(g, s, rnd) {
    g.clearRect(0, 0, s, s);
    rect(g, 0, 0, s, s, grad(g, 0, 0, s, s, [[0, '#cfe6ec', 0.16], [0.5, '#9ac4d0', 0.1], [1, '#6a8a98', 0.2]]));
    for (let i = 0; i < 5; i++) {
      const x = range(rnd, -40, s), w = range(rnd, 14, 40);
      g.save(); g.globalAlpha = range(rnd, 0.12, 0.24); g.fillStyle = '#f4fbff';
      g.beginPath(); g.moveTo(x, s); g.lineTo(x + w, s); g.lineTo(x + w + s * 0.5, 0); g.lineTo(x + s * 0.5, 0); g.closePath(); g.fill(); g.restore();
    }
    // grime in the corners and along the sill
    for (const [cx, cy] of [[0, 0], [s, 0], [0, s], [s, s]]) blob(g, cx, cy, s * 0.3, s * 0.3, 0, '#7a6a52', 0.28, 0.1);
    rect(g, 0, s - 30, s, 30, grad(g, 0, s - 30, 0, s, [[0, '#7a6a52', 0], [1, '#7a6a52', 0.35]]));
  },
});

// ---- per-biome weather ---------------------------------------------------------------------------

// Snow for day 3 (Dun Morogh): lies on the roof, sills and bumpers. Tiles.
register('rv_snow', {
  family: F, size: 256, note: 'snow lying on the RV (tiles): cool blue shadows, sunlit cream, sparkle',
  paint(g, s, rnd) {
    fill(g, s, s, '#e6edf4');
    mottle(g, s, rnd, { colors: ['#f8f6ee', '#d2dcea', '#c4cee2', '#fbf8f0'], count: 50, rmin: 14, rmax: 60, alpha: 0.4, hard: 0.2 });
    mottle(g, s, rnd, { colors: ['#b8c4dc', '#aab8d4'], count: 18, rmin: 6, rmax: 20, alpha: 0.3, hard: 0.3, stretch: 2.2 });
    for (let i = 0; i < 70; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 3, (xx, yy) => { ellipse(g, xx, yy, 1.1, 1.1, 0, '#ffffff', 0.9); }); }
    blurTile(g.canvas, 0.6);
  },
});

// Road grime thrown up by the wheels (alpha, painted white: the material tints it per biome).
// u tiles along the body; v: transparent at the top, dense at the bottom.
register('rv_grime', {
  family: F, w: 512, h: 128, alpha: true, note: 'road grime overlay (alpha, tinted per biome)',
  paint(g, s, rnd, h) {
    g.clearRect(0, 0, s, h);
    const wx = (x, r, fn) => { fn(x); if (x - r < 0) fn(x + s); if (x + r > s) fn(x - s); };
    // a soft rising band of dust
    rect(g, 0, 0, s, h, grad(g, 0, 0, 0, h, [[0, '#ffffff', 0], [0.3, '#ffffff', 0.08], [0.6, '#ffffff', 0.3], [0.85, '#ffffff', 0.62], [1, '#ffffff', 0.8]]));
    // spray: long horizontal streaks low down
    for (let i = 0; i < 60; i++) {
      const x = rnd() * s, y = h * range(rnd, 0.45, 1), L = range(rnd, 20, 90);
      wx(x, L, xx => line(g, [[xx, y], [xx + L, y + (rnd() - 0.5) * 4]], range(rnd, 1.5, 5), '#ffffff', range(rnd, 0.1, 0.3)));
    }
    // splatter
    for (let i = 0; i < 160; i++) {
      const x = rnd() * s, y = h * (1 - Math.pow(rnd(), 1.8) * 0.75), r = range(rnd, 1, 4.5);
      wx(x, r * 2, xx => blob(g, xx, y, r * range(rnd, 1, 2), r, rnd() * 3, '#ffffff', range(rnd, 0.3, 0.75), 0.5));
    }
    // drips running down from the splatter line
    for (let i = 0; i < 30; i++) {
      const x = rnd() * s, y = h * range(rnd, 0.35, 0.6);
      wx(x, 3, xx => line(g, [[xx, y], [xx + (rnd() - 0.5) * 2, y + range(rnd, 8, 30)]], range(rnd, 1, 2.5), '#ffffff', 0.3));
    }
  },
});
