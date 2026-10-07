// Texture family: characters. WoW Classic-style hand-painted character skins.
//
// Every person is ONE skinned mesh with ONE 512×768 atlas (one draw call): face
// and hair, jerkin/tabard, sleeves and gloves, trousers and boots, the jerkin
// skirt and tabard flaps, pauldrons, belt, hat and NPC gear. REG lists the atlas
// regions; people.js maps its UVs into them using the landmark tables exported
// here (HEAD_RINGS / HAIRLINE / TORSO / armV / skirtV), so the painted face lines
// up with the modeled nose and brow and the painted belt line with the belt.
//
// Lathe-mapped regions run u around the part (u = 0.5 is the front, 0.25 the
// character's right / an arm's outer side, 0.75 its left / an arm's inner side)
// and v along it (0 = bottom). Light is baked from above: warm cream highlights on
// top edges and lit planes, cool violet-brown shadows below, in creases and under
// overhangs, soft dark seams, never pure black.
//
// Textures registered here (static, for the gallery): face_0..face_5 (the six
// skin tones and faces), char_<outfit> sample atlases, fp_hands. Live atlases are
// registered on demand by charAtlas(spec) / handsAtlas(color).
import {
  register, has, blob, ellipse, stroke, mix, shade, shadowOf, lightOf, hex, toHex, range, pick, makeCanvas, rgba,
} from './core.js';

export const AW = 512, AH = 768;
export const REG = {
  head:  { x: 0,   y: 0,   w: 512, h: 192 },
  torso: { x: 0,   y: 196, w: 256, h: 200 },
  arm:   { x: 260, y: 196, w: 92,  h: 200 },
  leg:   { x: 356, y: 196, w: 92,  h: 200 },
  foot:  { x: 452, y: 196, w: 60,  h: 96 },
  beard: { x: 452, y: 296, w: 60,  h: 100 },
  skirt: { x: 0,   y: 400, w: 256, h: 96 },     // four panels side by side: front, right, back, left
  flap:  { x: 260, y: 400, w: 64,  h: 112 },    // tabard flap, front
  flapB: { x: 328, y: 400, w: 64,  h: 112 },    // tabard flap, back
  ear:   { x: 396, y: 400, w: 52,  h: 24 },
  horn:  { x: 396, y: 428, w: 52,  h: 84 },
  metal: { x: 452, y: 400, w: 60,  h: 60 },     // top half brass, bottom half iron
  collar:{ x: 452, y: 464, w: 60,  h: 48 },
  paul:  { x: 0,   y: 500, w: 128, h: 64 },
  belt:  { x: 0,   y: 568, w: 128, h: 68 },
  hair:  { x: 132, y: 516, w: 124, h: 120 },
  acc:   { x: 260, y: 516, w: 192, h: 120 },    // hat: crown v .52-1, brim v 0-.45 (or Ed's apron)
  gear:  { x: 456, y: 516, w: 56,  h: 120 },    // NPC extras: shades (top), chain links (bottom)
  pack:  { x: 0,   y: 640, w: 256, h: 128 },    // bedroll + straps (players)
};

// Head lathe, shared with people.js: [dy above the head origin (m), half-width (z),
// front depth, back depth, squareness, center x offset, texture v]. A broad, square
// WoW human jaw, a heavy brow and a thick neck.
export const HEAD_RINGS = [
  [-0.150, 0.068, 0.066, 0.068, 2.0, -0.016, 0.00],
  [-0.116, 0.064, 0.064, 0.066, 2.0, -0.015, 0.07],
  [-0.097, 0.066, 0.076, 0.066, 2.3, -0.008, 0.115],
  [-0.086, 0.061, 0.098, 0.068, 3.0, 0.000, 0.16],
  [-0.068, 0.075, 0.106, 0.078, 2.8, 0.000, 0.22],
  [-0.046, 0.083, 0.107, 0.086, 2.5, 0.000, 0.31],
  [-0.022, 0.088, 0.106, 0.092, 2.3, 0.000, 0.42],
  [0.000, 0.091, 0.104, 0.098, 2.2, 0.000, 0.51],
  [0.025, 0.092, 0.101, 0.101, 2.1, 0.000, 0.60],
  [0.046, 0.093, 0.106, 0.102, 2.1, 0.000, 0.68],
  [0.080, 0.090, 0.094, 0.101, 2.0, -0.004, 0.80],
  [0.114, 0.076, 0.076, 0.090, 2.0, -0.008, 0.89],
  [0.141, 0.051, 0.048, 0.062, 2.0, -0.010, 0.96],
  [0.156, 0.000, 0.000, 0.000, 2.0, -0.010, 1.00],
];
export const EYE_U = 0.047;          // eye centers sit at u = 0.5 ± EYE_U
// Hairline: [|theta| (0 = front, PI = back), dy]
export const HAIRLINE = [[0, 0.083], [0.45, 0.079], [0.8, 0.058], [1.12, 0.014], [1.36, -0.006], [1.52, 0.03], [1.75, 0.03], [2.2, -0.035], [Math.PI, -0.07]];
export function lerpTable(tab, x, col = 1, key = 0) {
  if (x <= tab[0][key]) return tab[0][col];
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][key]) { const a = tab[i - 1], b = tab[i]; const t = (x - a[key]) / (b[key] - a[key] || 1); return a[col] + (b[col] - a[col]) * t; }
  }
  return tab[tab.length - 1][col];
}
export const headV = dy => lerpTable(HEAD_RINGS, dy, 6);
export const hairlineDy = th => lerpTable(HAIRLINE, Math.abs(th), 1);

// Torso lathe (male base, people.js scales it per outfit): [y, half-width, front
// depth, back depth, squareness, v]. The first rows close the crotch.
export const TORSO = [
  [0.89,  0.03,  0.03,  0.03,  2.0, 0.0],
  [0.80,  0.172, 0.128, 0.122, 2.2, 0.005],
  [0.772, 0.218, 0.158, 0.152, 2.3, 0.015],
  [0.79,  0.222, 0.162, 0.156, 2.3, 0.04],
  [0.87,  0.214, 0.156, 0.150, 2.4, 0.15],
  [0.955, 0.202, 0.148, 0.142, 2.4, 0.26],
  [1.00,  0.198, 0.145, 0.138, 2.4, 0.31],
  [1.06,  0.200, 0.146, 0.134, 2.5, 0.39],
  [1.16,  0.224, 0.166, 0.142, 2.6, 0.53],
  [1.26,  0.246, 0.180, 0.152, 2.7, 0.67],
  [1.35,  0.248, 0.170, 0.156, 2.7, 0.79],
  [1.41,  0.214, 0.138, 0.140, 2.5, 0.87],
  [1.45,  0.150, 0.105, 0.110, 2.2, 0.93],
  [1.48,  0.088, 0.078, 0.078, 2.0, 0.975],
  [1.495, 0.0,   0.0,   0.0,   2.0, 1.0],
];
export const TORSO_UP = TORSO.slice(3);           // monotonic in y
export const torsoV = y => lerpTable(TORSO_UP, y, 5);
// Arms: v runs linearly from the fingertips (0) to the top of the shoulder (1).
export const ARM_TOP = 0.075, ARM_TIP = -0.76;
export const armV = dy => (dy - ARM_TIP) / (ARM_TOP - ARM_TIP);
export const ARM_LM = { elbow: -0.285, sleeve: -0.305, cuffTop: -0.415, cuffRim: -0.43, cuffBot: -0.49, wrist: -0.548, knuckle: -0.66 };
// Legs: v = height above the sole. The skirt: v from 0.56 m (0) to 1.02 m (1).
export const SKIRT_Y0 = 0.56, SKIRT_Y1 = 1.02;
export const skirtV = y => (y - SKIRT_Y0) / (SKIRT_Y1 - SKIRT_Y0);

// ---- who is who ---------------------------------------------------------------------

export const SKIN_TONES = ['#dfa47b', '#c98c5e', '#a6704a', '#7c5038', '#ecbe9a', '#5e3c2b'];
const LOOKS = [
  { hair: 'short', hairColor: '#5c3a1f', facial: 'stubble', eyes: '#4a5c74', female: false },
  { hair: 'short', hairColor: '#231b1a', facial: 'mustache', eyes: '#4a3220', female: false },
  { hair: 'long', hairColor: '#3d2516', facial: 'beard', eyes: '#3f5236', female: false },
  { hair: 'bald', hairColor: '#a29b92', facial: 'goatee', eyes: '#3e2a1a', female: false },
  { hair: 'braid', hairColor: '#a3471f', facial: 'none', eyes: '#3f6348', female: true },
  { hair: 'bun', hairColor: '#1e1719', facial: 'none', eyes: '#3d2617', female: true },
];
export const HATS = ['brim', 'bandana', 'cap', 'hood', 'straw', 'helm'];
const OUTFITS = {
  player: { torso: 'tabard', arms: 'sleeve', hands: 'glove', legs: 'trousers', boots: 'tall', pauldrons: 'both', belt: true, skirt: true, collar: true, pack: true },
  ed:     { torso: 'shirt', arms: 'rolled', hands: 'bare', legs: 'wool', boots: 'short', pauldrons: 'none', belt: false, apron: true, hat: 'none', belly: 0.035, armBulk: 1.05 },
  clerk:  { torso: 'waistcoat', arms: 'shirt', hands: 'bare', legs: 'wool', boots: 'shoe', pauldrons: 'none', belt: true, hat: 'none', armBulk: 0.82, collar: true },
  dealer: { torso: 'vest', arms: 'shirt', hands: 'bare', legs: 'black', boots: 'shoe', pauldrons: 'none', belt: true, hat: 'visor', armBulk: 0.84, collar: true, look: { hair: 'slick', hairColor: '#17121a', facial: 'pencil', female: false, stern: true } },
  repo:   { torso: 'overalls', arms: 'flannel', hands: 'workglove', legs: 'overalls', boots: 'tall', pauldrons: 'none', belt: false, hat: 'beanie', bulk: 1.12, belly: 0.03, chain: true, shades: true, look: { hair: 'buzz', hairColor: '#1d1716', facial: 'stubble', female: false, stern: true } },
};

function hsl(c) {
  const { r, g, b } = hex(c);
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2;
  let h = 0, s = 0;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = (mx === R ? (G - B) / d + (G < B ? 6 : 0) : mx === G ? (B - R) / d + 2 : (R - G) / d + 4) / 6;
  }
  return { h, s, l };
}
function fromHsl(h, s, l) {
  const f = n => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return toHex({ r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 });
}
// A player's neon UI color, toned down to a WoW tabard dye (same hue, muted).
export function muted(c) {
  const { h, s, l } = hsl(c);
  if (h > 0.11 && h < 0.2) return fromHsl(0.115, Math.min(s, 0.62), 0.45);    // yellow → a rich ochre-gold, not olive
  return fromHsl(h, Math.min(s, 0.52), Math.max(0.26, Math.min(0.42, l * 0.8 + 0.06)));
}
// ...and a soft, readable version for name labels.
export function labelColor(c) { const { h, s } = hsl(c); return fromHsl(h, Math.min(s, 0.62), 0.7); }

export function resolveSpec(color = '#7CFC00', { hatIndex = 0, skinIndex = 0, scale = 1, eyeColor = null, outfit = null } = {}) {
  const lc = String(color).toLowerCase();
  if (!outfit) {
    outfit = lc === '#c0392b' ? 'ed' : lc === '#2e86ab' ? 'clerk' : (eyeColor || lc === '#111111') ? 'dealer' : scale >= 1.2 ? 'repo' : 'player';
  }
  const O = OUTFITS[outfit] || OUTFITS.player;
  const skin = ((skinIndex % 6) + 6) % 6;
  const look = { ...LOOKS[skin], ...(O.look || {}) };
  const tone = SKIN_TONES[skin];
  let c = muted(color);
  if (outfit === 'dealer') c = '#2c2832';
  if (outfit === 'repo') c = '#5a4a36';
  const hat = O.hat || HATS[((hatIndex % 6) + 6) % 6];
  // players: steel pauldrons under a helm or cap, leather otherwise
  const paulMetal = outfit === 'player' && (hat === 'helm' || hat === 'cap' || hat === 'bandana');
  const spec = { ...O, outfit, color: c, raw: color, skin, tone, look, hat, paulMetal, eyeGlow: eyeColor || null };
  spec.key = [outfit, c, skin, hat, eyeColor || '-'].join('_').replace(/#/g, '');
  return spec;
}

// ---- painting helpers ---------------------------------------------------------------

const LEATHER = '#6c4a2f', LEATHER_D = '#432b1c', SUEDE = '#8a6340', TRIM = '#d6b46c', LINEN = '#e2d2ad', BRASS = '#b58c3c', IRON = '#7d8088';
const TROUSER = '#4e3d30';
const INK = '#24192a';    // the darkest thing we ever paint (soft violet-brown, not black)

function clip(g, r, fn) { g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip(); fn(); g.restore(); }
function clipRect(g, x, y, w, h, fn) { g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip(); fn(); g.restore(); }
const RX = (r, u) => r.x + u * r.w;
const RY = (r, v) => r.y + (1 - v) * r.h;
function gradV(g, x, y, w, h, stops) {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  for (const [t, c] of stops) gr.addColorStop(Math.max(0, Math.min(1, t)), c);
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}
function gradH(g, x, y, w, h, stops) {
  const gr = g.createLinearGradient(x, 0, x + w, 0);
  for (const [t, c] of stops) gr.addColorStop(Math.max(0, Math.min(1, t)), c);
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}
// blob that wraps around a lathe region's u seam
function wblob(g, r, x, y, rx, ry, rot, c, a, hard) {
  blob(g, x, y, rx, ry, rot, c, a, hard);
  if (r && x - rx < r.x) blob(g, x + r.w, y, rx, ry, rot, c, a, hard);
  if (r && x + rx > r.x + r.w) blob(g, x - r.w, y, rx, ry, rot, c, a, hard);
}
function band(g, r, v0, v1, c, a = 1) { g.save(); g.globalAlpha = a; g.fillStyle = c; g.fillRect(r.x, RY(r, v1), r.w, RY(r, v0) - RY(r, v1)); g.restore(); }
function bandGrad(g, r, v0, v1, cTop, cBot, a = 1) {
  g.save(); g.globalAlpha = a;
  gradV(g, r.x, RY(r, v1), r.w, RY(r, v0) - RY(r, v1), [[0, cTop], [1, cBot]]);
  g.restore();
}
function stitches(g, pts, color = '#2a1d17', a = 0.7, dash = 3, gap = 2.6, w = 1.2) {
  g.save(); g.globalAlpha = a; g.strokeStyle = color; g.lineWidth = w; g.lineCap = 'round';
  g.setLineDash([dash, gap]);
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) g.lineTo(p[0], p[1]); g.stroke();
  g.globalAlpha = a * 0.45; g.strokeStyle = '#f2dfb4'; g.lineDashOffset = 1.2;
  g.beginPath(); g.moveTo(pts[0][0] - 0.8, pts[0][1] - 0.8); for (const p of pts.slice(1)) g.lineTo(p[0] - 0.8, p[1] - 0.8); g.stroke();
  g.restore();
}
function hstitch(g, r, v, color, a) { stitches(g, [[r.x, RY(r, v)], [r.x + r.w, RY(r, v)]], color, a); }
function rivet(g, x, y, rad, base = BRASS) {
  blob(g, x + rad * 0.45, y + rad * 0.6, rad * 1.5, rad * 1.3, 0, INK, 0.5, 0.25);
  ellipse(g, x, y, rad, rad, 0, shadowOf(base, 0.35));
  ellipse(g, x - rad * 0.12, y - rad * 0.12, rad * 0.8, rad * 0.8, 0, base);
  blob(g, x - rad * 0.35, y - rad * 0.4, rad * 0.55, rad * 0.45, 0, '#fff0c0', 0.9, 0.4);
}
function fold(g, pts, w, base, a = 0.32) {
  stroke(g, pts, w, w * 0.25, shadowOf(base, 0.5), a);
  stroke(g, pts.map(([x, y]) => [x - w * 0.45, y - w * 0.4]), w * 0.55, w * 0.15, lightOf(base, 0.5), a * 0.85);
}
function curve(x0, y0, x1, y1, bend, n = 5) {
  const pts = [];
  const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
  for (let k = 0; k <= n; k++) { const t = k / n, b = Math.sin(t * Math.PI) * bend; pts.push([x0 + dx * t + nx * b, y0 + dy * t + ny * b]); }
  return pts;
}
function polyPath(g, p) { g.beginPath(); p.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); }

// Cloth: lit-top gradient, big soft hue blotches, a few big painted folds.
function cloth(g, r, x, y, w, h, base, rnd, { folds = 5, foldLen = [0.25, 0.5], foldAngle = 0, light = 0.32, blotch = 10, wrap = false, foldW = [3, 6] } = {}) {
  gradV(g, x, y, w, h, [[0, lightOf(base, light)], [0.45, base], [1, shadowOf(base, light * 0.9)]]);
  const hues = [shade(base, 0.84), lightOf(base, 0.2), mix(base, '#5b4a7a', 0.2), mix(base, '#c9a35e', 0.14)];
  for (let i = 0; i < blotch; i++) {
    const bx = x + rnd() * w, by = y + rnd() * h, bw = range(rnd, w * 0.1, w * 0.28), bh = range(rnd, h * 0.08, h * 0.2);
    wblob(g, wrap ? r : null, bx, by, bw, bh, rnd() * 3, pick(rnd, hues), 0.24, 0.12);
  }
  for (let i = 0; i < folds; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, foldLen[0], foldLen[1]) * h, a = foldAngle + (rnd() - 0.5) * 0.6;
    fold(g, curve(x0, y0, x0 + Math.sin(a) * L, y0 + Math.cos(a) * L, (rnd() - 0.5) * L * 0.25), range(rnd, foldW[0], foldW[1]), base, 0.42);
  }
}
// Leather: gradient, darker mottling, worn lighter patches, creases and scuffs.
function leather(g, r, x, y, w, h, base, rnd, { creases = 6, scuffs = 8, light = 0.3, wrap = false } = {}) {
  gradV(g, x, y, w, h, [[0, lightOf(base, light)], [0.5, base], [1, shadowOf(base, light)]]);
  const R = wrap ? r : null;
  for (let i = 0; i < 12; i++) wblob(g, R, x + rnd() * w, y + rnd() * h, range(rnd, w * 0.08, w * 0.22), range(rnd, h * 0.06, h * 0.18), rnd() * 3, pick(rnd, [shade(base, 0.78), mix(base, '#3a2a3e', 0.25), lightOf(base, 0.18)]), 0.26, 0.18);
  for (let i = 0; i < creases; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, 6, 16), a = rnd() * Math.PI;
    fold(g, curve(x0, y0, x0 + Math.cos(a) * L, y0 + Math.sin(a) * L, range(rnd, -3, 3), 3), range(rnd, 1.6, 3), base, 0.35);
  }
  for (let i = 0; i < scuffs; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, 3, 9), a = rnd() * Math.PI;
    stroke(g, [[x0, y0], [x0 + Math.cos(a) * L, y0 + Math.sin(a) * L]], range(rnd, 0.8, 1.6), 0.4, lightOf(base, 0.6), 0.3);
  }
}
// Hair the WoW way: big tapered locks, each with a dark shadow side and a lit
// ridge, a warm sheen band, dark partings between. Never thin per-hair strands.
function locks(g, r, x, y, w, h, base, rnd, { count = 14, len = [0.55, 0.95], width = [9, 16], flow = 0, sheen = 0.3, wrap = false, topPad = 0.12 } = {}) {
  gradV(g, x, y, w, h, [[0, lightOf(base, 0.12)], [0.5, base], [1, shadowOf(base, 0.45)]]);
  const dark = shadowOf(base, 0.6), deep = mix(shadowOf(base, 0.75), INK, 0.3);
  const mids = [base, mix(base, lightOf(base, 0.2), 0.5), shade(base, 0.9)];
  const hi = mix(lightOf(base, 0.8), '#ffe6b4', 0.35);
  const lockList = [];
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < count; i++) {
      const x0 = x + (i + rnd() * 0.8 + pass * 0.5) / count * w, y0 = y - h * topPad + rnd() * h * 0.2;
      const L = range(rnd, len[0], len[1]) * h, W = range(rnd, width[0], width[1]) * (pass ? 0.75 : 1);
      const bend = (rnd() - 0.5) * W * 0.8;
      lockList.push({ pts: curve(x0, y0, x0 + flow * L * 0.35 + (rnd() - 0.5) * W * 0.4, y0 + L, bend, 7), W, c: pick(rnd, mids) });
    }
  }
  const each = (fn) => { for (const lk of lockList) { fn(lk.pts, lk); if (wrap && r) { if (lk.pts[0][0] < x + lk.W * 1.5) fn(lk.pts.map(([a, b]) => [a + w, b]), lk); if (lk.pts[0][0] > x + w - lk.W * 1.5) fn(lk.pts.map(([a, b]) => [a - w, b]), lk); } } };
  each((P, lk) => stroke(g, P.map(([a, b]) => [a + lk.W * 0.22, b + 1.5]), lk.W * 1.1, lk.W * 0.2, deep, 0.6));      // parting shadow
  each((P, lk) => stroke(g, P, lk.W, lk.W * 0.12, lk.c, 0.96));                                                       // the lock
  each((P, lk) => stroke(g, P.slice(1).map(([a, b]) => [a + lk.W * 0.28, b]), lk.W * 0.32, lk.W * 0.05, dark, 0.5)); // shadow side
  each((P, lk) => {                                                                                                     // lit ridge, strongest in the sheen band
    const k0 = Math.max(0, Math.floor((sheen - 0.12) * 7)), seg = P.slice(k0, k0 + 3);
    if (seg.length > 1) stroke(g, seg.map(([a, b]) => [a - lk.W * 0.18, b]), lk.W * 0.3, lk.W * 0.06, hi, 0.75);
    stroke(g, P.slice(0, 5).map(([a, b]) => [a - lk.W * 0.2, b]), lk.W * 0.16, lk.W * 0.04, lightOf(base, 0.4), 0.45);
  });
}
function plaid(g, x, y, w, h, base, rnd) {
  gradV(g, x, y, w, h, [[0, lightOf(base, 0.2)], [0.5, base], [1, shadowOf(base, 0.3)]]);
  const dark = shadowOf(base, 0.55), light = mix(base, '#e0b070', 0.35);
  g.save();
  for (let xx = x - 6 + rnd() * 6; xx < x + w; xx += 17) { g.globalAlpha = 0.5; g.fillStyle = dark; g.fillRect(xx, y, 6, h); g.globalAlpha = 0.35; g.fillStyle = light; g.fillRect(xx + 10, y, 1.2, h); }
  for (let yy = y - 6 + rnd() * 6; yy < y + h; yy += 17) { g.globalAlpha = 0.42; g.fillStyle = dark; g.fillRect(x, yy, w, 6); g.globalAlpha = 0.35; g.fillStyle = light; g.fillRect(x, yy + 10, w, 1.2); }
  g.restore();
  for (let i = 0; i < 8; i++) blob(g, x + rnd() * w, y + rnd() * h, range(rnd, 8, 20), range(rnd, 6, 14), rnd() * 3, pick(rnd, [shadowOf(base, 0.3), lightOf(base, 0.2)]), 0.25, 0.1);
}
// Embroidered trim strip (horizontal) with a zigzag stitch.
function trimH(g, x0, x1, y, h, base = TRIM, accent = '#7a4a24') {
  g.save();
  gradV(g, x0, y, x1 - x0, h, [[0, lightOf(base, 0.4)], [0.5, base], [1, shadowOf(base, 0.4)]]);
  g.globalAlpha = 0.55; g.strokeStyle = accent; g.lineWidth = 1;
  g.beginPath();
  for (let x = x0, k = 0; x <= x1; x += h * 0.7, k++) g.lineTo(x, y + (k % 2 ? h * 0.25 : h * 0.75));
  g.stroke();
  g.globalAlpha = 0.6; g.fillStyle = INK; g.fillRect(x0, y + h - 0.8, x1 - x0, 1);
  g.restore();
}
function trimPath(g, pts, w, base = TRIM) {
  stroke(g, pts.map(([x, y]) => [x + 0.8, y + 1.0]), w + 1.8, w + 1.8, INK, 0.45);
  stroke(g, pts, w, w, base, 1);
  stroke(g, pts.map(([x, y]) => [x - w * 0.22, y - w * 0.22]), w * 0.35, w * 0.35, lightOf(base, 0.6), 0.65);
}
function buckle(g, x, y, w, h) {
  blob(g, x + 1.5, y + 2, w * 0.75, h * 0.7, 0, INK, 0.5, 0.3);
  g.save();
  g.lineWidth = Math.max(2, w * 0.22); g.strokeStyle = shadowOf(BRASS, 0.3);
  g.strokeRect(x - w / 2 + 0.6, y - h / 2 + 0.6, w, h);
  g.strokeStyle = BRASS; g.strokeRect(x - w / 2, y - h / 2, w, h);
  g.lineWidth = 1; g.strokeStyle = '#fbe7a8'; g.globalAlpha = 0.8;
  g.beginPath(); g.moveTo(x - w / 2 - 0.5, y + h / 2 - 1); g.lineTo(x - w / 2 - 0.5, y - h / 2 - 0.5); g.lineTo(x + w / 2 - 1, y - h / 2 - 0.5); g.stroke();
  g.globalAlpha = 1; g.fillStyle = shadowOf(BRASS, 0.4); g.fillRect(x - 0.8, y - h / 2, 1.6, h * 0.6);
  g.restore();
}
// The crew's sigil: a wagon wheel (it's a road trip), embroidered in gold thread.
function wheelEmblem(g, x, y, rad, col = TRIM) {
  g.save();
  g.translate(x + 1, y + 1.3); g.globalAlpha = 0.45; g.strokeStyle = INK; g.lineWidth = rad * 0.3;
  g.beginPath(); g.arc(0, 0, rad, 0, Math.PI * 2); g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0); g.translate(x, y); g.globalAlpha = 1;
  g.strokeStyle = col; g.lineWidth = rad * 0.24;
  g.beginPath(); g.arc(0, 0, rad, 0, Math.PI * 2); g.stroke();
  g.lineWidth = rad * 0.13;
  for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + 0.26; g.beginPath(); g.moveTo(Math.cos(a) * rad * 0.2, Math.sin(a) * rad * 0.2); g.lineTo(Math.cos(a) * rad * 0.92, Math.sin(a) * rad * 0.92); g.stroke(); }
  g.fillStyle = col; g.beginPath(); g.arc(0, 0, rad * 0.26, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 0.75; g.strokeStyle = lightOf(col, 0.7); g.lineWidth = rad * 0.08;
  g.beginPath(); g.arc(0, 0, rad * 1.04, Math.PI * 1.05, Math.PI * 1.6); g.stroke();
  g.restore();
}
// soft blur of one region (painterly), in place
function soften(cv, r, px) {
  const t = makeCanvas(r.w + 8, r.h + 8), tg = t.getContext('2d');
  tg.drawImage(cv, r.x - 4, r.y - 4, r.w + 8, r.h + 8, 0, 0, r.w + 8, r.h + 8);
  const o = makeCanvas(r.w + 8, r.h + 8), og = o.getContext('2d');
  og.filter = `blur(${px}px)`; og.drawImage(t, 0, 0);
  cv.getContext('2d').drawImage(o, 4, 4, r.w, r.h, r.x, r.y, r.w, r.h);
}
// extend a region's edge pixels outward so mipmaps don't bleed neighbours in
function bleed(g, cv, r, n = 3) {
  g.drawImage(cv, r.x, r.y, 1, r.h, r.x - n, r.y, n, r.h);
  g.drawImage(cv, r.x + r.w - 1, r.y, 1, r.h, r.x + r.w, r.y, n, r.h);
  g.drawImage(cv, r.x - n, r.y, r.w + 2 * n, 1, r.x - n, r.y - n, r.w + 2 * n, n);
  g.drawImage(cv, r.x - n, r.y + r.h - 1, r.w + 2 * n, 1, r.x - n, r.y + r.h, r.w + 2 * n, n);
}
function fill0(g, r, c) { g.fillStyle = c; g.fillRect(r.x, r.y, r.w, r.h); }

// ---- the head: skin, face, painted hair ---------------------------------------------------

function toneOf(c) {
  return {
    base: c, light: lightOf(c, 0.32), hi: lightOf(c, 0.55), shadow: shadowOf(c, 0.34), deep: shadowOf(c, 0.56),
    cool: mix(shadowOf(c, 0.3), '#6a5a8a', 0.22), blush: mix(c, '#c4504a', 0.32), lip: mix(shadowOf(c, 0.22), '#a4484a', 0.38),
  };
}

// An eye: a narrow almond under a heavy lid. Mostly iris, very little white, the
// top third of the eyeball in the lid's shadow, one warm catchlight.
function paintEye(g, cx, cy, S, side, glow) {
  const T = toneOf(S.tone), L = S.look, fem = L.female;
  const ew = fem ? 10 : 9.5, eh = fem ? 4.2 : 3.4;
  const inner = [cx - side * ew, cy + eh * 0.35], outer = [cx + side * ew, cy - eh * (fem ? 0.3 : 0.0)];
  // the socket: a soft cool shadow wrapping the eye, deepest at the inner corner
  blob(g, cx - side * 1.5, cy - eh * 0.9, ew * 1.75, eh * 3.0, 0, mix(T.deep, '#3a2c52', 0.3), fem ? 0.3 : 0.48, 0.12);
  blob(g, cx - side * ew * 0.9, cy - eh * 0.2, ew * 0.45, eh * 1.8, 0, T.deep, 0.42, 0.2);
  const almond = () => {
    g.beginPath(); g.moveTo(...inner);
    g.quadraticCurveTo(cx - side * ew * 0.1, cy - eh * 1.95, ...outer);
    g.quadraticCurveTo(cx + side * ew * 0.25, cy + eh * 1.45, ...inner);
    g.closePath();
  };
  g.save();
  almond(); g.fillStyle = glow ? mix('#d0b8a0', glow, 0.35) : mix('#cdb9a0', T.base, 0.3); g.fill();
  g.clip();
  const ir = eh * 1.5, ix = cx + side * 0.4, iy = cy - eh * 0.1;
  ellipse(g, ix, iy, ir, ir, 0, glow ? shadowOf(glow, 0.35) : shadowOf(L.eyes, 0.5));
  ellipse(g, ix, iy + ir * 0.15, ir * 0.74, ir * 0.7, 0, glow || L.eyes);
  blob(g, ix, iy + ir * 0.45, ir * 0.6, ir * 0.35, 0, glow ? '#ffb08a' : lightOf(L.eyes, 0.45), 0.55, 0.2);
  ellipse(g, ix, iy, ir * 0.36, ir * 0.36, 0, glow ? '#4a0808' : '#191216');
  gradV(g, cx - ew, cy - eh * 2.1, ew * 2, eh * 2.6, [[0, rgba(T.deep, 1)], [0.55, rgba(T.deep, 0.75)], [1, rgba(T.deep, 0)]]);
  ellipse(g, ix - ir * 0.35, iy - ir * 0.1, ir * 0.2, ir * 0.18, 0, '#fff6e0', 0.95);
  g.restore();
  // the upper lid: a thick dark line, heavier toward the outer corner; the lid crease above it
  const up = [inner, [cx - side * ew * 0.35, cy - eh * 1.2], [cx + side * ew * 0.3, cy - eh * 1.35], outer];
  if (fem) up.push([outer[0] + side * ew * 0.3, outer[1] - eh * 0.5]);
  stroke(g, up, 1.6, fem ? 3.4 : 3, '#2a1814', 0.95);
  stroke(g, up.map(([x, y]) => [x, y - 1.4]), 1.2, 1.8, mix(T.deep, '#2a1814', 0.4), 0.45);
  stroke(g, curve(inner[0] + side * ew * 0.2, cy - eh * 2.3, outer[0] - side * ew * 0.05, cy - eh * 2.1, -side * eh * 0.6, 4), 1.4, 1, T.deep, 0.55);
  blob(g, cx + side * ew * 0.1, cy - eh * 3.0, ew * 0.9, eh * 0.7, 0, T.light, fem ? 0.35 : 0.2, 0.2);   // lit lid fold under the brow
  // lower lid: a soft warm line and a lit cheek under it
  stroke(g, [[inner[0] + side * ew * 0.25, inner[1] + eh * 0.25], [cx + side * ew * 0.2, cy + eh * 1.2], [outer[0], outer[1] + eh * 0.6]], 1.2, 0.8, mix(T.deep, T.blush, 0.3), 0.6);
  blob(g, cx, cy + eh * 2.6, ew * 0.95, eh * 0.9, 0, T.light, 0.32, 0.2);
}

function paintHead(g, r, S, rnd) {
  const T = toneOf(S.tone), L = S.look, fem = L.female;
  const X = du => r.x + (0.5 + du) * r.w, Y = v => r.y + (1 - v) * r.h;
  const ph = r.h, pw = r.w;
  const vEye = headV(0.025), vBrow = headV(0.048), vNoseB = headV(-0.022), vMouth = headV(-0.047), vChin = headV(-0.084), vJaw = headV(-0.068), vCheek = headV(0.0);
  clip(g, r, () => {
    // skin, lit from above; the throat in the jaw's shadow
    gradV(g, r.x, r.y, r.w, r.h, [[0, T.light], [0.3, T.base], [1 - vJaw, T.base], [1 - vChin + 0.02, T.shadow], [1 - vChin * 0.55, T.deep], [1, mix(T.deep, '#3c2c50', 0.2)]]);
    for (let i = 0; i < 18; i++) wblob(g, r, r.x + rnd() * pw, r.y + rnd() * ph * 0.8, range(rnd, 14, 40), range(rnd, 8, 22), rnd() * 3, pick(rnd, [T.light, T.shadow, T.blush, T.cool]), 0.14, 0.1);
    // the big planes: the sides of the face turn away (cool), the front plane catches the light
    for (const s of [-1, 1]) {
      blob(g, X(s * 0.2), Y(0.45), pw * 0.06, ph * 0.32, 0, T.cool, 0.5, 0.1);
      blob(g, X(s * 0.155), Y(vBrow + 0.03), pw * 0.035, ph * 0.12, 0, T.shadow, 0.35, 0.1);          // temples
      blob(g, X(s * 0.115), Y(vJaw + 0.02), pw * 0.05, ph * 0.08, s * 0.5, T.deep, 0.4, 0.15);           // the jaw's corner
      blob(g, X(s * 0.1), Y(vCheek - 0.08), pw * 0.035, ph * 0.08, s * 0.2, T.shadow, fem ? 0.18 : 0.38, 0.15);   // under the cheekbone
      blob(g, X(s * 0.072), Y(vCheek + 0.015), pw * 0.04, ph * 0.035, s * 0.3, T.hi, 0.45, 0.2);        // cheekbone
      blob(g, X(s * 0.07), Y(vCheek - 0.04), pw * 0.032, ph * 0.06, 0, T.blush, fem ? 0.42 : 0.28, 0.15);
      blob(g, X(s * 0.048), Y(vBrow + 0.045), pw * 0.04, ph * 0.035, 0, T.hi, 0.42, 0.2);              // brow ridge catches the light
      blob(g, X(s * EYE_U), Y(vEye + 0.05), pw * 0.04, ph * 0.035, 0, mix(T.deep, '#4a3a6a', 0.3), 0.5, 0.15);   // under the brow
    }
    blob(g, X(-0.008), Y(0.79), pw * 0.075, ph * 0.075, 0, T.hi, 0.42, 0.15);   // forehead
    blob(g, X(0), Y(vEye + 0.01), pw * 0.01, ph * 0.04, 0, T.light, 0.35, 0.3);  // between the eyes
    for (const s of [-1, 1]) blob(g, X(s * 0.25), Y(0.55), pw * 0.025, ph * 0.12, 0, T.deep, 0.4, 0.2);   // where the ears attach
    // the jawline: a dark soft edge where the jaw turns under, a lit chin
    blob(g, X(0), Y(vChin - 0.01), pw * 0.12, ph * 0.035, 0, mix(T.deep, '#3c2c50', 0.3), 0.6, 0.3);
    for (const s of [-1, 1]) blob(g, X(s * 0.09), Y(vChin + 0.025), pw * 0.05, ph * 0.03, s * 0.35, T.deep, 0.45, 0.25);
    // nose: a lit bridge, a bright tip, a cool shadow side, nostrils, and its shadow below
    stroke(g, [[X(-0.004), Y(vBrow - 0.015)], [X(-0.005), Y(vNoseB + 0.07)]], pw * 0.011, pw * 0.017, T.hi, 0.5);
    blob(g, X(-0.003), Y(vNoseB + 0.035), pw * 0.016, ph * 0.03, 0, T.hi, 0.7, 0.3);
    blob(g, X(0.016), Y(vNoseB + 0.07), pw * 0.01, ph * 0.09, 0, T.shadow, 0.5, 0.2);
    blob(g, X(0.0), Y(vNoseB + 0.03), pw * 0.02, ph * 0.025, 0, T.blush, 0.35, 0.25);
    blob(g, X(0), Y(vNoseB - 0.012), pw * 0.026, ph * 0.022, 0, T.deep, 0.7, 0.3);
    for (const s of [-1, 1]) ellipse(g, X(s * 0.01), Y(vNoseB + 0.004), pw * 0.0055, ph * 0.01, s * 0.4, mix(T.deep, '#3a1a1a', 0.35), 0.85);
    for (const s of [-1, 1]) blob(g, X(s * 0.019), Y(vNoseB + 0.016), pw * 0.008, ph * 0.025, 0, T.shadow, 0.55, 0.3);   // nostril wings
    blob(g, X(0), Y((vNoseB + vMouth) / 2), pw * 0.006, ph * 0.025, 0, T.shadow, 0.35, 0.3);   // philtrum
    for (const s of [-1, 1]) if (!fem) stroke(g, curve(X(s * 0.024), Y(vNoseB + 0.012), X(s * 0.042), Y(vMouth - 0.025), s * 2, 4), 2.6, 1, T.deep, 0.42);   // smile folds
    facialBase(g, X, Y, pw, ph, S, T, rnd, vMouth, vChin, vNoseB);
    // mouth: a firm line, a shaded upper lip, a lit lower lip, a shadow under it
    const mw = pw * (fem ? 0.029 : 0.034), my = Y(vMouth);
    blob(g, X(0), my - ph * 0.012, mw * 1.05, ph * 0.016, 0, mix(T.lip, T.shadow, 0.35), 0.6, 0.4);
    blob(g, X(0), my + ph * 0.015, mw * 0.85, ph * 0.016, 0, fem ? mix(T.lip, '#b8504e', 0.35) : T.lip, fem ? 0.8 : 0.5, 0.4);
    blob(g, X(-0.004), my + ph * 0.012, mw * 0.4, ph * 0.007, 0, T.hi, 0.5, 0.3);
    const corner = L.stern ? 1.8 : 0.8;
    stroke(g, [[X(0) - mw, my + corner], [X(0) - mw * 0.4, my - 0.3], [X(0), my + 0.3], [X(0) + mw * 0.4, my - 0.3], [X(0) + mw, my + corner]], 2.1, 1.6, '#3b2220', 0.85);
    blob(g, X(0), my + ph * 0.036, mw * 0.75, ph * 0.013, 0, T.deep, 0.45, 0.3);
    blob(g, X(0), Y(vChin + 0.045), pw * 0.026, ph * 0.03, 0, T.hi, 0.5, 0.25);       // chin
    if (!fem && S.skin === 0) stroke(g, [[X(0), Y(vChin + 0.06)], [X(0), Y(vChin + 0.025)]], 1.5, 1, T.shadow, 0.5);   // a cleft chin
    // eyes & brows
    for (const s of [-1, 1]) paintEye(g, X(s * EYE_U), Y(vEye), S, s, S.eyeGlow);
    const browC = L.hair === 'bald' ? mix(L.hairColor, '#5a5048', 0.4) : shadowOf(L.hairColor, 0.12);
    for (const s of [-1, 1]) {
      const cx = X(s * EYE_U), by = Y(vBrow + 0.005);
      const innerY = by + (L.stern ? ph * 0.022 : ph * 0.008);
      const pts = [[cx - s * pw * 0.028, innerY], [cx - s * pw * 0.005, by - ph * (fem ? 0.022 : 0.012)], [cx + s * pw * 0.024, by + ph * 0.01]];
      if (fem) { stroke(g, pts, 2.6, 1, browC, 0.9); continue; }
      stroke(g, pts.map(([x, y]) => [x + 0.6, y + 1.4]), 6.5, 2.5, mix(T.deep, INK, 0.3), 0.4);
      stroke(g, pts, 6.5, 2.4, browC, 0.95);
      for (let k = 0; k < 7; k++) { const t = k / 6, px = pts[0][0] + (pts[2][0] - pts[0][0]) * t, py = pts[0][1] + (pts[1][1] - pts[0][1]) * Math.sin(t * Math.PI) * 0.8 + (pts[2][1] - pts[0][1]) * t; stroke(g, [[px - s * 1, py + 2], [px + s * 2.5, py - 1.5]], 1.2, 0.5, lightOf(browC, 0.35), 0.5); }
    }
    facialHair(g, X, Y, pw, ph, S, T, rnd, vMouth, vChin, vNoseB);
    paintHairCap(g, r, S, rnd);
  });
}

function jawPath(g, X, Y, ph, vMouth, vChin, top) {
  g.beginPath();
  g.moveTo(X(-0.22), Y(top));
  g.bezierCurveTo(X(-0.205), Y(vChin + 0.02), X(-0.1), Y(vChin - 0.06), X(0), Y(vChin - 0.065));
  g.bezierCurveTo(X(0.1), Y(vChin - 0.06), X(0.205), Y(vChin + 0.02), X(0.22), Y(top));
  g.lineTo(X(0.165), Y(top));
  g.bezierCurveTo(X(0.12), Y(vMouth + 0.13), X(0.07), Y(vMouth + 0.075), X(0.03), Y(vMouth + 0.07));
  g.lineTo(X(-0.03), Y(vMouth + 0.07));
  g.bezierCurveTo(X(-0.07), Y(vMouth + 0.075), X(-0.12), Y(vMouth + 0.13), X(-0.165), Y(top));
  g.closePath();
}
function facialBase(g, X, Y, pw, ph, S, T, rnd, vMouth, vChin, vNoseB) {
  const L = S.look, f = L.facial;
  if (L.female || f === 'none' || f === 'pencil') return;
  g.save();
  jawPath(g, X, Y, ph, vMouth, vChin, f === 'goatee' ? 0.3 : 0.5);
  g.clip();
  const sc = mix(mix(L.hairColor, T.shadow, 0.45), '#3e3a5a', 0.25);
  const amt = f === 'stubble' ? 0.42 : f === 'goatee' ? 0.24 : 0.32;
  blob(g, X(0), Y(vChin + 0.04), pw * 0.2, ph * 0.22, 0, sc, amt, 0.4);
  blob(g, X(0), Y(vMouth + 0.05), pw * 0.05, ph * 0.04, 0, sc, amt * 0.8, 0.3);
  for (let i = 0; i < 60; i++) blob(g, X((rnd() - 0.5) * 0.4), Y(vChin - 0.04 + rnd() * 0.36), range(rnd, 4, 9), range(rnd, 3, 5), rnd() * 3, sc, amt * 0.3, 0.1);
  g.restore();
}
function facialHair(g, X, Y, pw, ph, S, T, rnd, vMouth, vChin, vNoseB) {
  const L = S.look, f = L.facial, hc = L.hairColor;
  const mustache = (droop, curl) => {
    for (const s of [-1, 1]) {
      const pts = [[X(s * 0.004), Y(vNoseB - 0.025)], [X(s * 0.022), Y(vNoseB - 0.042)], [X(s * 0.042), Y(vMouth - droop)]];
      if (curl) pts.push([X(s * 0.058), Y(vMouth + 0.02)], [X(s * 0.062), Y(vMouth + 0.06)]);
      stroke(g, pts.map(([x, y]) => [x + 0.8, y + 1.4]), 8, 2, T.deep, 0.5);
      stroke(g, pts, 8, curl ? 2.2 : 3, shadowOf(hc, 0.1), 1);
      stroke(g, pts.map(([x, y]) => [x - 0.5, y - 1.8]), 2.6, 0.8, lightOf(hc, 0.4), 0.7);
    }
  };
  if (f === 'mustache') mustache(0.03, true);
  if (f === 'pencil') for (const s of [-1, 1]) stroke(g, [[X(s * 0.004), Y(vNoseB - 0.04)], [X(s * 0.03), Y(vMouth + 0.035)]], 1.8, 1, shadowOf(hc, 0.1), 0.95);
  if (f === 'goatee') {
    mustache(0.0, false);
    g.save();
    g.beginPath(); g.ellipse(X(0), Y(vChin + 0.02), pw * 0.036, ph * 0.085, 0, 0, Math.PI * 2); g.clip();
    locks(g, null, X(-0.04), Y(vMouth - 0.02), pw * 0.08, ph * 0.22, hc, rnd, { count: 5, width: [5, 8], len: [0.6, 1] });
    g.restore();
    blob(g, X(0), Y(vMouth - 0.02), pw * 0.014, ph * 0.012, 0, T.lip, 0.5, 0.3);
  }
  if (f === 'beard') {
    g.save(); jawPath(g, X, Y, ph, vMouth, vChin, 0.56); g.clip();
    locks(g, null, X(-0.23), Y(0.6), pw * 0.46, ph * 0.62, hc, rnd, { count: 16, len: [0.35, 0.6], width: [7, 11], sheen: 0.35 });
    g.restore();
    mustache(0.02, false);
    blob(g, X(0), Y(vMouth - 0.025), pw * 0.02, ph * 0.014, 0, T.lip, 0.7, 0.4);
    stroke(g, [[X(-0.022), Y(vMouth)], [X(0.022), Y(vMouth)]], 1.8, 1.8, '#3b2220', 0.8);
  }
}

// Hair painted straight onto the scalp (under the hair shell, or the whole look
// for bald / buzz cuts).
function paintHairCap(g, r, S, rnd) {
  const L = S.look, hc = L.hairColor;
  const X = u => r.x + u * r.w, Y = v => r.y + (1 - v) * r.h;
  const capPath = (drop = 0) => {
    g.beginPath(); g.moveTo(X(0), Y(1.2));
    for (let k = 0; k <= 64; k++) {
      const u = k / 64, th = Math.PI - 2 * Math.PI * u;
      const jag = L.hair === 'short' || L.hair === 'long' ? Math.sin(k * 2.7) * 0.012 : 0;
      g.lineTo(X(u), Y(headV(hairlineDy(th) - drop) + (Math.abs(th) < 1.1 ? jag : jag * 0.5)));
    }
    g.lineTo(X(1), Y(1.2)); g.closePath();
  };
  if (L.hair === 'bald') {
    // a horseshoe of short gray hair round the back, a shiny scalp on top
    g.save(); capPath(-0.005); g.clip();
    gradV(g, r.x, Y(0.75), r.w, r.h * 0.4, [[0, rgba(hc, 0)], [1, rgba(hc, 0.0)]]);
    for (let i = 0; i < 70; i++) {
      const u = rnd(), th = Math.PI - 2 * Math.PI * u;
      if (Math.abs(th) < 1.5) continue;
      const v0 = headV(hairlineDy(th)), v = v0 + rnd() * 0.2;
      const x = X(u), y = Y(v);
      stroke(g, [[x, y - 5], [x + range(rnd, -2, 2), y + 4]], range(rnd, 4, 7), 1.5, pick(rnd, [hc, shadowOf(hc, 0.3), lightOf(hc, 0.2)]), 0.55);
    }
    g.restore();
    blob(g, X(0.46), Y(0.92), r.w * 0.08, r.h * 0.07, 0, '#fff2d6', 0.45, 0.15);
    blob(g, X(0.42), Y(0.86), r.w * 0.03, r.h * 0.03, 0, '#fffaf0', 0.4, 0.3);
    return;
  }
  g.save(); capPath(); g.clip();
  if (L.hair === 'buzz') {
    // a dark cap with soft painted texture (not dots): a few big blotches and short dashes
    gradV(g, r.x, r.y, r.w, r.h, [[0, mix(hc, S.tone, 0.15)], [1, mix(hc, S.tone, 0.45)]]);
    for (let i = 0; i < 26; i++) wblob(g, r, X(rnd()), Y(0.4 + rnd() * 0.6), range(rnd, 10, 26), range(rnd, 6, 12), rnd() * 3, pick(rnd, [mix(hc, S.tone, 0.3), shadowOf(hc, 0.3)]), 0.3, 0.15);
    for (let i = 0; i < 90; i++) { const x = X(rnd()), y = Y(0.35 + rnd() * 0.65); stroke(g, [[x, y], [x + 1, y + 3]], 1.4, 0.6, mix(hc, '#9a8a7a', 0.35), 0.35); }
    blob(g, X(0.45), Y(0.92), r.w * 0.08, r.h * 0.06, 0, mix(S.tone, '#fff0d0', 0.4), 0.3, 0.15);
  } else {
    locks(g, r, r.x, Y(1.05), r.w, r.h * 0.95, hc, rnd, { count: 22, len: [0.5, 0.8], width: [11, 17], sheen: 0.32, wrap: true });
  }
  g.restore();
  // soft shadow just under the hairline (hair casts onto the forehead)
  g.save(); g.globalAlpha = 0.22; g.translate(0, 3.5); capPath(); g.fillStyle = shadowOf(S.tone, 0.55); g.fill(); g.restore();
  if (L.hair !== 'buzz') {   // sideburns
    for (const s of [-1, 1]) {
      const x = X(0.5 + s * 0.215), y0 = Y(headV(0.02)), y1 = Y(headV(L.facial === 'beard' ? -0.06 : -0.025));
      stroke(g, [[x, y0], [x + s * 1, y1]], 10, 6, hc, 0.95);
      stroke(g, [[x - 2, y0], [x - 2 + s, y1]], 3, 2, lightOf(hc, 0.3), 0.5);
    }
  }
}

// ---- body regions -------------------------------------------------------------------------

function paintTorso(g, r, S, rnd) {
  const c = S.color, U = u => RX(r, u), V = v => RY(r, v), TV = y => V(torsoV(y));
  clip(g, r, () => {
    if (S.torso === 'tabard') {
      leather(g, r, r.x, r.y, r.w, r.h, LEATHER, rnd, { creases: 14, scuffs: 16, wrap: true });
      // below the belt: trousers (under the skirt; seen when it parts)
      clipRect(g, r.x, TV(0.95), r.w, r.y + r.h - TV(0.95), () => cloth(g, r, r.x, TV(0.95), r.w, r.y + r.h - TV(0.95), TROUSER, rnd, { folds: 6, wrap: true }));
      for (const u of [0.25, 0.75]) stitches(g, [[U(u), TV(1.04)], [U(u), TV(1.42)]], INK, 0.5);
      // the linen undershirt in the V, laced
      g.save(); polyPath(g, [[U(0.43), TV(1.5)], [U(0.5), TV(1.31)], [U(0.57), TV(1.5)]]); g.clip();
      cloth(g, r, U(0.42), TV(1.5), r.w * 0.16, TV(1.3) - TV(1.5), LINEN, rnd, { folds: 2 });
      blob(g, U(0.5), TV(1.46), r.w * 0.06, 10, 0, INK, 0.45, 0.2);
      for (let k = 0; k < 3; k++) { const y = TV(1.44 - k * 0.04); stroke(g, [[U(0.478), y - 3], [U(0.522), y + 3]], 1.5, 1.5, '#5a3a24', 0.9); stroke(g, [[U(0.522), y - 3], [U(0.478), y + 3]], 1.5, 1.5, '#5a3a24', 0.9); }
      g.restore();
      // tabard panels, front and back, over the shoulders down to the belt
      const panel = (cu, vneck) => {
        const p = [[U(cu - 0.16), TV(0.94)], [U(cu + 0.16), TV(0.94)], [U(cu + 0.14), TV(1.36)], [U(cu + 0.12), TV(1.5)]];
        if (vneck) p.push([U(cu + 0.07), TV(1.5)], [U(cu), TV(1.31)], [U(cu - 0.07), TV(1.5)]);
        p.push([U(cu - 0.12), TV(1.5)], [U(cu - 0.14), TV(1.36)]);
        return p;
      };
      for (const [cu, vneck] of [[0.5, true], [0, false], [1, false]]) {
        const p = panel(cu, vneck);
        g.save(); polyPath(g, p);
        g.save(); g.translate(2, 2.5); g.fillStyle = rgba(INK, 0.5); g.fill(); g.restore();
        g.clip();
        cloth(g, r, U(cu - 0.17), TV(1.5), r.w * 0.34, TV(0.93) - TV(1.5), c, rnd, { folds: 5, foldAngle: 0, light: 0.34, blotch: 10, foldW: [4, 7] });
        // the chest: lit; the belly under the pecs: a soft shade
        blob(g, U(cu - 0.03), TV(1.27), r.w * 0.09, 18, 0, lightOf(c, 0.5), 0.3, 0.1);
        blob(g, U(cu), TV(1.1), r.w * 0.12, 14, 0, shadowOf(c, 0.4), 0.3, 0.1);
        g.restore();
        trimPath(g, [p[0], p[p.length - 1], p[p.length - 2]], 3.4);
        trimPath(g, [p[1], p[2], p[3]], 3.4);
        if (vneck) trimPath(g, p.slice(4, 7), 2.8);
        wheelEmblem(g, U(cu), TV(1.2), r.w * 0.05);
      }
      // the shoulder tops sit in the pauldrons' shadow
      for (const u of [0.25, 0.75]) blob(g, U(u), TV(1.43), r.w * 0.1, 22, 0, INK, 0.4, 0.15);
    } else if (S.torso === 'shirt') {
      cloth(g, r, r.x, r.y, r.w, r.h, c, rnd, { folds: 10, light: 0.3, blotch: 14, wrap: true });
      stroke(g, [[U(0.5), TV(0.95)], [U(0.5), TV(1.48)]], 3, 3, shadowOf(c, 0.3), 0.6);
      for (let k = 0; k < 6; k++) rivet(g, U(0.505), TV(1.42 - k * 0.08), 1.6, '#d9ccb0');
      // the apron's neck strap and waist ties, suspenders down the back
      for (const s of [-1, 1]) stroke(g, [[U(0.5 + s * 0.1), TV(1.3)], [U(0.5 + s * 0.075), TV(1.42)], [U(0.5 + s * 0.05), TV(1.5)]], 5, 5, '#5a3c26', 1);
      g.save(); g.fillStyle = '#5a3c26'; g.fillRect(r.x, TV(1.03), r.w, TV(0.995) - TV(1.03)); g.restore();
      for (const s of [-1, 1]) for (const cu of [0, 1]) stroke(g, [[U(cu + s * 0.06), TV(1.0)], [U(cu + s * 0.04), TV(1.5)]], 5, 5, '#3d2a1c', 0.95);
      bandGrad(g, r, torsoV(0.94), torsoV(0.99), rgba(INK, 0), rgba(INK, 0.3));
    } else if (S.torso === 'waistcoat' || S.torso === 'vest') {
      const vest = S.torso === 'vest' ? '#2c2832' : c;
      cloth(g, r, r.x, r.y, r.w, r.h, LINEN, rnd, { folds: 8, wrap: true });
      g.save(); polyPath(g, [[U(-0.01), TV(0.97)], [U(0.5), TV(0.94)], [U(1.01), TV(0.97)], [U(1.01), TV(1.45)], [U(0.58), TV(1.46)], [U(0.5), TV(1.24)], [U(0.42), TV(1.46)], [U(-0.01), TV(1.45)]]);
      g.save(); g.translate(1.5, 2); g.fillStyle = rgba(INK, 0.45); g.fill(); g.restore();
      g.clip();
      cloth(g, r, r.x, r.y, r.w, r.h, vest, rnd, { folds: 7, light: 0.36, wrap: true });
      if (S.torso === 'vest') { g.save(); g.globalAlpha = 0.12; g.fillStyle = '#c8c0d8'; for (let x = r.x + 3; x < r.x + r.w; x += 7) g.fillRect(x, r.y, 1, r.h); g.restore(); }
      g.save(); g.globalAlpha = 0.35; g.fillStyle = shadowOf(vest, 0.4); g.fillRect(U(0.8), r.y, r.w * 0.4, r.h); g.fillRect(U(-0.2), r.y, r.w * 0.4, r.h); g.restore();
      g.restore();
      stroke(g, [[U(0.42), TV(1.46)], [U(0.5), TV(1.24)], [U(0.58), TV(1.46)]], 2, 2, lightOf(vest, 0.5), 0.6);
      stroke(g, [[U(0.5), TV(1.24)], [U(0.5), TV(0.95)]], 1.5, 1.5, shadowOf(vest, 0.5), 0.8);
      for (let k = 0; k < 4; k++) rivet(g, U(0.515), TV(1.2 - k * 0.055), 2.4);
      for (const s of [-1, 1]) stroke(g, [[U(0.5 + s * 0.06), TV(1.1)], [U(0.5 + s * 0.13), TV(1.105)]], 2, 2, shadowOf(vest, 0.5), 0.8);
      if (S.torso === 'waistcoat') stroke(g, curve(U(0.515), TV(1.13), U(0.62), TV(1.11), 6), 1.4, 1.4, BRASS, 0.95);   // watch chain
      const tie = S.torso === 'vest' ? '#9a2a2a' : '#6a2a2a';
      for (const s of [-1, 1]) { g.save(); polyPath(g, [[U(0.5), TV(1.47)], [U(0.5 + s * 0.05), TV(1.49)], [U(0.5 + s * 0.05), TV(1.445)]]); g.fillStyle = tie; g.fill(); g.restore(); }
      blob(g, U(0.5), TV(1.47), 3.5, 3.5, 0, shadowOf(tie, 0.2), 1, 0.7);
      blob(g, U(0.48), TV(1.475), 3, 1.5, 0, lightOf(tie, 0.5), 0.5, 0.3);
    } else if (S.torso === 'overalls') {
      plaid(g, r.x, r.y, r.w, r.h, '#7d3428', rnd);
      for (let i = 0; i < 6; i++) fold(g, curve(U(rnd()), TV(1.15 + rnd() * 0.25), U(rnd()), TV(1.1 + rnd() * 0.2), 4), 3, '#7d3428', 0.3);
      const ov = c;
      g.save(); polyPath(g, [[U(-0.01), r.y + r.h + 2], [U(1.01), r.y + r.h + 2], [U(1.01), TV(1.03)], [U(0.63), TV(1.04)], [U(0.62), TV(1.36)], [U(0.38), TV(1.36)], [U(0.37), TV(1.04)], [U(-0.01), TV(1.03)]]);
      g.save(); g.translate(1.5, 2.5); g.fillStyle = rgba(INK, 0.5); g.fill(); g.restore();
      g.clip();
      cloth(g, r, r.x, r.y, r.w, r.h, ov, rnd, { folds: 8, light: 0.3, wrap: true });
      g.restore();
      stitches(g, [[U(0.385), TV(1.35)], [U(0.615), TV(1.35)], [U(0.625), TV(1.05)]], '#e0c890', 0.6);
      stitches(g, [[U(0.385), TV(1.35)], [U(0.375), TV(1.05)]], '#e0c890', 0.6);
      g.save(); g.fillStyle = shadowOf(ov, 0.15); g.fillRect(U(0.44), TV(1.3), r.w * 0.12, TV(1.18) - TV(1.3)); g.restore();
      stitches(g, [[U(0.44), TV(1.3)], [U(0.56), TV(1.3)]], '#e0c890', 0.6);
      for (const s of [-1, 1]) {
        stroke(g, [[U(0.5 + s * 0.1), TV(1.35)], [U(0.5 + s * 0.08), TV(1.5)]], 9, 9, shadowOf(ov, 0.1), 1);
        stroke(g, [[U(0.0 + s * 0.08), TV(1.03)], [U(0.0 - s * 0.07), TV(1.5)]], 9, 9, shadowOf(ov, 0.15), 1);
        stroke(g, [[U(1.0 + s * 0.08), TV(1.03)], [U(1.0 - s * 0.07), TV(1.5)]], 9, 9, shadowOf(ov, 0.15), 1);
        rivet(g, U(0.5 + s * 0.1), TV(1.34), 4);
        rivet(g, U(0.5 + s * 0.24), TV(1.02), 3.5);
      }
      rivet(g, U(0), TV(1.22), 3.5); rivet(g, U(1), TV(1.22), 3.5);
    }
    // common shading: armpits, under the pecs, under the belt line, the hem and the collar
    for (const u of [0.25, 0.75]) { blob(g, U(u), TV(1.34), r.w * 0.08, 26, 0, INK, 0.5, 0.15); blob(g, U(u), TV(1.2), r.w * 0.05, 30, 0, INK, 0.18, 0.1); }
    bandGrad(g, r, torsoV(0.93), torsoV(0.97), rgba(INK, 0), rgba(INK, 0.35));
    bandGrad(g, r, 0.0, 0.05, rgba(INK, 0.35), rgba(INK, 0.0));
    blob(g, U(0.44), TV(1.3), r.w * 0.08, 16, 0, '#fff1c4', 0.12, 0.1);
    bandGrad(g, r, 0.96, 1.0, rgba(INK, 0), rgba(INK, 0.7));
  });
}

// Arms: v = armV(dy). The outer side (back of the hand) is u .25, the inner side (palm) u .75.
function paintArm(g, r, S, rnd) {
  const c = S.color, U = u => RX(r, u), V = v => RY(r, v), AV = dy => V(armV(dy)), av = armV;
  const skin = toneOf(S.tone), LM = ARM_LM;
  clip(g, r, () => {
    const sleeveC = S.arms === 'sleeve' || S.arms === 'rolled' ? c : S.arms === 'flannel' ? '#7d3428' : LINEN;
    if (S.arms === 'flannel') plaid(g, r.x, r.y, r.w, r.h, sleeveC, rnd);
    else cloth(g, r, r.x, r.y, r.w, r.h, sleeveC, rnd, { folds: 6, foldAngle: Math.PI / 2, foldLen: [0.05, 0.1], wrap: true });
    // a lit shoulder cap, folds at the elbow
    bandGrad(g, r, av(-0.02), av(0.06), rgba('#fff1c4', 0), rgba('#fff1c4', 0.25));
    for (let i = 0; i < 4; i++) fold(g, curve(U(0.55 + rnd() * 0.4), AV(LM.elbow + 0.02 - rnd() * 0.03), U(0.05 + rnd() * 0.4), AV(LM.elbow + 0.01 - rnd() * 0.03), 3), 2.6, sleeveC, 0.4);
    if (S.arms === 'sleeve') {
      trimH(g, r.x, r.x + r.w, AV(LM.elbow + 0.005), r.h * 0.035);
      // a laced leather bracer from the elbow to the glove
      clipRect(g, r.x, AV(LM.sleeve), r.w, AV(LM.cuffTop) - AV(LM.sleeve), () => {
        leather(g, r, r.x, AV(LM.sleeve), r.w, AV(LM.cuffTop) - AV(LM.sleeve), LEATHER_D, rnd, { creases: 4, scuffs: 6, wrap: true });
        for (let k = 0; k < 4; k++) { const y = AV(LM.sleeve - 0.02 - k * 0.025); stroke(g, [[U(0.2), y], [U(0.3), y - 4]], 1.4, 1.4, '#c9a878', 0.85); stroke(g, [[U(0.3), y], [U(0.2), y - 4]], 1.4, 1.4, '#c9a878', 0.85); }
      });
      hstitch(g, r, av(LM.sleeve - 0.008), '#c9a878', 0.5);
      bandGrad(g, r, av(LM.sleeve - 0.02), av(LM.sleeve), rgba(INK, 0), rgba(INK, 0.45));
    }
    if (S.arms === 'shirt') { band(g, r, av(-0.12), av(-0.1), S.outfit === 'dealer' ? '#9a2a2a' : '#2d2a3a', 1); hstitch(g, r, av(-0.11), '#f0d8a0', 0.35); }
    if (S.arms === 'rolled') {
      // the sleeve rolled up above the elbow; a hairy bare forearm below
      const top = LM.elbow + 0.03;
      clipRect(g, r.x, AV(top), r.w, r.y + r.h - AV(top), () => {
        gradV(g, r.x, AV(top), r.w, AV(LM.wrist) - AV(top), [[0, skin.light], [0.5, skin.base], [1, skin.shadow]]);
        for (const u of [0.2, 0.7]) blob(g, U(u), AV(-0.36), r.w * 0.12, 18, 0, skin.light, 0.3, 0.2);
        for (let i = 0; i < 30; i++) { const x = U(rnd()), y = AV(top - 0.02 - rnd() * 0.2); stroke(g, [[x, y], [x + 1.5, y + 3]], 0.9, 0.4, shadowOf(S.look.hairColor, 0.1), 0.25); }
      });
      band(g, r, av(top - 0.005), av(top + 0.045), lightOf(c, 0.15), 1);
      hstitch(g, r, av(top + 0.02), shadowOf(c, 0.4), 0.6);
      bandGrad(g, r, av(top - 0.035), av(top), rgba(INK, 0.0), rgba(INK, 0.4));
      bandGrad(g, r, av(top + 0.045), av(top + 0.065), rgba(INK, 0.35), rgba(INK, 0));
    }
    // hands: bare, or big gloves with a flared gauntlet cuff
    if (S.hands === 'bare') {
      const top = S.arms === 'rolled' ? LM.wrist + 0.03 : LM.wrist + 0.01;
      clipRect(g, r.x, AV(top), r.w, r.y + r.h - AV(top), () => {
        gradV(g, r.x, AV(top), r.w, r.y + r.h - AV(top), [[0, skin.light], [0.5, skin.base], [1, skin.shadow]]);
        for (const u of [0.66, 0.75, 0.84]) stroke(g, [[U(u), V(0.0)], [U(u), AV(-0.69)]], 1.4, 0.8, skin.deep, 0.6);
        for (const u of [0.16, 0.25, 0.34]) stroke(g, [[U(u), V(0.0)], [U(u), AV(-0.7)]], 1.2, 0.6, skin.deep, 0.5);
        for (const u of [0.18, 0.26, 0.34]) blob(g, U(u), AV(LM.knuckle), 3, 2, 0, skin.light, 0.6, 0.3);
        for (const u of [0.16, 0.24, 0.32, 0.4]) blob(g, U(u), V(0.02), 2.4, 1.6, 0, mix(skin.light, '#f0d0c0', 0.4), 0.55, 0.4);
        blob(g, U(0.75), AV(-0.62), 10, 8, 0, skin.shadow, 0.4, 0.2);
      });
      if (S.arms === 'shirt') { band(g, r, av(LM.wrist + 0.005), av(LM.wrist + 0.035), '#efe6d2', 1); rivet(g, U(0.25), AV(LM.wrist + 0.02), 1.8, '#c8c8d0'); bandGrad(g, r, av(LM.wrist - 0.01), av(LM.wrist + 0.005), rgba(INK, 0), rgba(INK, 0.35)); }
    } else {
      const work = S.hands === 'workglove';
      const gl = work ? '#a8834f' : '#7a5232', cuffC = work ? '#7a5a36' : SUEDE;
      clipRect(g, r.x, AV(LM.cuffBot), r.w, r.y + r.h - AV(LM.cuffBot), () => {
        leather(g, r, r.x, AV(LM.cuffBot), r.w, r.y + r.h - AV(LM.cuffBot), gl, rnd, { creases: 6, scuffs: 8, wrap: true, light: 0.38 });
        // fingers: grooves on both the back (u .25) and the palm (u .75) sides
        for (const u of [0.16, 0.25, 0.34]) fold(g, [[U(u), V(0.0)], [U(u), AV(-0.68)]], 2, gl, 0.65);
        for (const u of [0.66, 0.75, 0.84]) fold(g, [[U(u), V(0.0)], [U(u), AV(-0.69)]], 1.8, gl, 0.55);
        for (const u of [0.13, 0.21, 0.29, 0.37]) blob(g, U(u), AV(LM.knuckle), 3.5, 2.4, 0, lightOf(gl, 0.5), 0.65, 0.3);   // knuckles
        if (!work) { stitches(g, [[U(0.15), AV(-0.57)], [U(0.35), AV(-0.57)], [U(0.35), AV(-0.63)], [U(0.15), AV(-0.63)], [U(0.15), AV(-0.57)]], '#e2c898', 0.55); }
        blob(g, U(0.75), AV(-0.61), 11, 7, 0, shadowOf(gl, 0.4), 0.45, 0.2);       // the palm in shade
        bandGrad(g, r, 0, 0.04, rgba(INK, 0.35), rgba(INK, 0));
      });
      // the flared gauntlet cuff
      clipRect(g, r.x, AV(LM.cuffTop), r.w, AV(LM.cuffBot) - AV(LM.cuffTop), () => {
        leather(g, r, r.x, AV(LM.cuffTop), r.w, AV(LM.cuffBot) - AV(LM.cuffTop), cuffC, rnd, { creases: 4, scuffs: 8, wrap: true, light: 0.4 });
        for (let k = 0; k < 5; k++) rivet(g, U((k + 0.5) / 5), AV(LM.cuffRim - 0.022), work ? 2 : 2.2, work ? IRON : BRASS);
      });
      if (S.hands === 'glove') trimH(g, r.x, r.x + r.w, AV(LM.cuffTop + 0.002), r.h * 0.022, c, shadowOf(c, 0.5));
      band(g, r, av(LM.cuffTop - 0.003), av(LM.cuffTop + 0.006), shadowOf(cuffC, 0.6), 1);
      bandGrad(g, r, av(LM.cuffBot - 0.012), av(LM.cuffBot + 0.004), rgba(INK, 0), rgba(INK, 0.5));
      bandGrad(g, r, av(LM.wrist - 0.015), av(LM.wrist + 0.01), rgba(INK, 0), rgba(INK, 0.35));
    }
    // the armpit side (inner, u .75) in shade; the top of the arm under the pauldron
    blob(g, U(0.75), AV(-0.06), r.w * 0.14, 30, 0, INK, 0.3, 0.1);
    bandGrad(g, r, av(0.0), 1.0, rgba(INK, 0), rgba(INK, S.pauldrons !== 'none' ? 0.5 : 0.15));
  });
}

function paintLeg(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    const pants = S.legs === 'trousers' ? TROUSER : S.legs === 'wool' ? '#4c4a52' : S.legs === 'black' ? '#28252c' : S.color;
    cloth(g, r, r.x, r.y, r.w, r.h, pants, rnd, { folds: 6, foldAngle: 0, foldLen: [0.06, 0.16], wrap: true });
    for (let i = 0; i < 4; i++) fold(g, curve(U(0.85 + rnd() * 0.3 - 0.15), V(0.53 + rnd() * 0.04), U(0.1 + rnd() * 0.2), V(0.53 + rnd() * 0.04), 3), 2.6, pants, 0.4);  // back of the knee
    for (const u of [0.25, 0.75]) stitches(g, [[U(u), V(0.47)], [U(u), V(1)]], S.legs === 'overalls' ? '#e0c890' : INK, 0.5);
    blob(g, U(0.5), V(0.52), r.w * 0.1, 10, 0, lightOf(pants, 0.4), 0.3, 0.2);   // knee
    if (S.legs === 'trousers') {
      g.save(); g.beginPath(); g.roundRect(U(0.4), V(0.6), r.w * 0.2, V(0.49) - V(0.6), 3); g.clip();
      leather(g, r, U(0.4), V(0.6), r.w * 0.2, V(0.49) - V(0.6), '#6e5038', rnd, { creases: 2, scuffs: 4 });
      g.restore();
      stitches(g, [[U(0.4), V(0.6)], [U(0.6), V(0.6)], [U(0.6), V(0.49)], [U(0.4), V(0.49)], [U(0.4), V(0.6)]], INK, 0.55);
    }
    bandGrad(g, r, 0.88, 1.0, rgba(INK, 0), rgba(INK, 0.55));
    blob(g, U(0.75), V(0.85), r.w * 0.12, 30, 0, INK, 0.3, 0.1);   // inner thigh
    // boots
    const boot = S.outfit === 'repo' ? '#3a2b22' : S.boots === 'shoe' ? '#2d2428' : LEATHER_D;
    const top = S.boots === 'tall' ? 0.48 : S.boots === 'short' ? 0.3 : 0.16;
    clipRect(g, r.x, V(top), r.w, r.y + r.h - V(top), () => {
      leather(g, r, r.x, V(top), r.w, r.y + r.h - V(top), boot, rnd, { creases: 8, scuffs: 12, wrap: true, light: 0.38 });
      for (let i = 0; i < 5; i++) fold(g, curve(U(0.35 + rnd() * 0.3), V(0.1 + rnd() * 0.05), U(0.35 + rnd() * 0.3), V(0.13 + rnd() * 0.06), 2), 2, boot, 0.5);
      blob(g, U(0.5), V(top - 0.1), r.w * 0.16, 20, 0, lightOf(boot, 0.5), 0.3, 0.2);   // the shin of the boot catches light
    });
    bandGrad(g, r, top, top + 0.025, rgba(INK, 0.0), rgba(INK, 0.4));
    if (S.boots === 'tall') {
      // the turned-down suede cuff, a strap and buckle round the ankle
      const cuff = S.outfit === 'repo' ? '#4a3a2e' : SUEDE;
      clipRect(g, r.x, V(0.478), r.w, V(0.4) - V(0.478), () => leather(g, r, r.x, V(0.478), r.w, V(0.4) - V(0.478), cuff, rnd, { creases: 3, scuffs: 6, wrap: true, light: 0.45 }));
      band(g, r, 0.47, 0.48, lightOf(cuff, 0.4), 0.8);
      hstitch(g, r, 0.41, '#e8d0a0', 0.5);
      bandGrad(g, r, 0.375, 0.4, rgba(INK, 0.0), rgba(INK, 0.6));
      band(g, r, 0.19, 0.225, '#3a261a', 1); hstitch(g, r, 0.207, '#c8a070', 0.4);
      buckle(g, U(0.25), V(0.207), 6, 7);
    }
    bandGrad(g, r, 0.0, 0.08, rgba(INK, 0.4), rgba(INK, 0));
  });
}

function paintFoot(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  const boot = S.outfit === 'repo' ? '#3a2b22' : S.boots === 'shoe' ? '#2d2428' : LEATHER_D;
  clip(g, r, () => {
    leather(g, r, r.x, r.y, r.w, r.h, boot, rnd, { creases: 6, scuffs: 10, light: 0.3, wrap: true });
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.5)], [0.3, rgba(INK, 0)], [0.5, rgba('#fff0c8', 0.12)], [0.7, rgba(INK, 0)], [1, rgba(INK, 0.5)]]);
    blob(g, U(0.5), V(0.86), r.w * 0.26, r.h * 0.1, 0, S.outfit === 'repo' ? '#9a9aa2' : lightOf(boot, 0.55), S.outfit === 'repo' ? 0.55 : 0.45, 0.2);   // the toe cap
    if (S.boots === 'shoe') blob(g, U(0.42), V(0.8), r.w * 0.08, r.h * 0.05, 0, '#fff0d0', 0.45, 0.3);
    blob(g, U(0.5), V(0.08), r.w * 0.35, r.h * 0.1, 0, INK, 0.3, 0.2);
    if (S.boots !== 'tall') for (let k = 0; k < 3; k++) { const y = V(0.42 + k * 0.08); stroke(g, [[U(0.42), y], [U(0.58), y - 4]], 1.3, 1.3, '#b8a080', 0.8); stroke(g, [[U(0.58), y], [U(0.42), y - 4]], 1.3, 1.3, '#b8a080', 0.8); }
    else { band(g, r, 0.36, 0.43, '#3a261a', 0.9); buckle(g, U(0.5), V(0.395), 5, 6); }
    // the sole: a dark band round the bottom with a lit welt and stitching
    g.save(); g.fillStyle = '#2b1e18';
    g.fillRect(r.x, r.y, r.w * 0.14, r.h); g.fillRect(RX(r, 0.86), r.y, r.w * 0.14 + 1, r.h);
    g.globalAlpha = 0.75; g.fillStyle = '#9a7650'; g.fillRect(RX(r, 0.14), r.y, 1.6, r.h); g.fillRect(RX(r, 0.86) - 1.6, r.y, 1.6, r.h);
    g.restore();
    stitches(g, [[U(0.17), V(0)], [U(0.17), V(1)]], '#c8a878', 0.45, 2, 2);
    stitches(g, [[U(0.83), V(0)], [U(0.83), V(1)]], '#c8a878', 0.45, 2, 2);
  });
}

// The jerkin skirt: four panels (front, right, back, left), each a quarter of the region.
function paintSkirt(g, r, S, rnd) {
  const V = v => RY(r, v);
  clip(g, r, () => {
    const base = mix(LEATHER, '#5a3c26', 0.4);
    for (let q = 0; q < 4; q++) {
      const x0 = r.x + q * r.w / 4, w = r.w / 4;
      // each panel: two tassets (vertical strips), lit in the middle, seams between
      for (let k = 0; k < 2; k++) {
        const sx = x0 + k * w / 2, sw = w / 2;
        clipRect(g, sx, r.y, sw, r.h, () => {
          leather(g, null, sx, r.y, sw, r.h, shade(base, 0.95 + 0.1 * rnd()), rnd, { creases: 3, scuffs: 6, light: 0.35 });
          gradH(g, sx, r.y, sw, r.h, [[0, rgba(INK, 0.45)], [0.2, rgba(INK, 0)], [0.45, rgba('#fff1c4', 0.12)], [0.8, rgba(INK, 0)], [1, rgba(INK, 0.5)]]);
          stitches(g, [[sx + 3, V(0.97)], [sx + 3, V(0.1)], [sx + sw - 3, V(0.1)], [sx + sw - 3, V(0.97)]], '#d8bc8a', 0.5, 2.4, 2);
        });
        rivet(g, sx + sw / 2, V(0.88), 2.4);
      }
      // the hem: a darker rolled edge
      g.save(); g.fillStyle = shadowOf(base, 0.45); g.fillRect(x0, V(0.07), w, V(0) - V(0.07) + 2); g.restore();
      g.save(); g.globalAlpha = 0.5; g.fillStyle = lightOf(base, 0.4); g.fillRect(x0, V(0.075), w, 1.2); g.restore();
    }
    bandGrad(g, r, 0.82, 1.0, rgba(INK, 0), rgba(INK, 0.55));     // under the belt
    bandGrad(g, r, 0.0, 0.25, rgba(INK, 0.3), rgba(INK, 0));
  });
}

// A tabard flap (u across, v up): the player's dye, gold trim, an embroidered band.
function paintFlap(g, r, S, rnd, back) {
  const c = S.color, U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    cloth(g, null, r.x, r.y, r.w, r.h, c, rnd, { folds: 4, foldAngle: 0, foldLen: [0.4, 0.7], light: 0.28, blotch: 6, foldW: [4, 7] });
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.35)], [0.25, rgba(INK, 0)], [0.75, rgba(INK, 0)], [1, rgba(INK, 0.35)]]);
    // embroidered band near the hem
    trimH(g, r.x, r.x + r.w, V(0.2), 3.5);
    g.save(); g.fillStyle = shadowOf(c, 0.35); g.fillRect(r.x, V(0.19), r.w, V(0.11) - V(0.19)); g.restore();
    for (let x = r.x + 4; x < r.x + r.w - 2; x += 9) { g.save(); polyPath(g, [[x, V(0.15)], [x + 4, V(0.185)], [x + 8, V(0.15)], [x + 4, V(0.115)]]); g.fillStyle = TRIM; g.globalAlpha = 0.9; g.fill(); g.restore(); }
    trimH(g, r.x, r.x + r.w, V(0.11), 3.5);
    // gold trim down both edges and along the hem
    trimPath(g, [[U(0.06), V(1.02)], [U(0.06), V(0.04)], [U(0.94), V(0.04)], [U(0.94), V(1.02)]], 3.2);
    if (!back) wheelEmblem(g, U(0.5), V(0.62), r.w * 0.17);
    bandGrad(g, r, 0.85, 1.0, rgba(INK, 0), rgba(INK, 0.5));
    bandGrad(g, r, 0.0, 0.06, rgba(INK, 0.35), rgba(INK, 0));
  });
}

function paintCollar(g, r, S, rnd) {
  clip(g, r, () => {
    const base = S.outfit === 'player' ? LEATHER_D : S.outfit === 'dealer' ? '#e8e2d4' : LINEN;
    if (S.outfit === 'player') leather(g, r, r.x, r.y, r.w, r.h, base, rnd, { creases: 3, scuffs: 6, light: 0.45, wrap: true });
    else cloth(g, r, r.x, r.y, r.w, r.h, base, rnd, { folds: 2 });
    bandGrad(g, r, 0.6, 1.0, rgba('#fff1c4', 0), rgba('#fff1c4', 0.25));
    bandGrad(g, r, 0.0, 0.35, rgba(INK, 0.5), rgba(INK, 0));
    if (S.outfit === 'player') { hstitch(g, r, 0.62, '#d8bc8a', 0.55); band(g, r, 0.3, 0.38, S.color, 0.9); }
  });
}

function paintPauldron(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  const metal = S.paulMetal;
  const base = metal ? '#8a8c94' : '#7c5434';
  clip(g, r, () => {
    if (metal) {
      gradV(g, r.x, r.y, r.w, r.h, [[0, '#e4e6ee'], [0.25, '#a8acb6'], [0.6, base], [1, '#4a4a56']]);
      for (let i = 0; i < 10; i++) wblob(g, r, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 6, 18), range(rnd, 4, 10), rnd() * 3, pick(rnd, ['#6a6070', '#c0c4cc', '#5a5c66']), 0.28, 0.2);
      for (let i = 0; i < 16; i++) { const x = U(rnd()), y = V(0.3 + rnd() * 0.7); stroke(g, [[x, y], [x + range(rnd, -6, 6), y + range(rnd, -2, 2)]], 0.8, 0.3, '#f4f6fc', 0.45); }
      for (let k = 0; k < 4; k++) { const u = (k + 0.5) / 4; stroke(g, [[U(u), V(0.5)], [U(u), V(1)]], 4, 2, '#5a5c66', 0.45); stroke(g, [[U(u) - 2, V(0.5)], [U(u) - 2, V(1)]], 1.4, 1, '#ffffff', 0.4); }
    } else leather(g, r, r.x, r.y, r.w, r.h, base, rnd, { creases: 6, scuffs: 14, light: 0.4, wrap: true });
    bandGrad(g, r, 0.72, 1.0, rgba('#fff0c8', 0.0), rgba('#fff0c8', 0.35));
    // the rim: a band in the player's color with gold piping
    band(g, r, 0.32, 0.42, S.color, 1);
    bandGrad(g, r, 0.32, 0.42, rgba('#fff0c8', 0.3), rgba(INK, 0.3));
    band(g, r, 0.415, 0.435, TRIM, 1); band(g, r, 0.31, 0.325, TRIM, 1);
    for (let k = 0; k < 9; k++) rivet(g, U((k + 0.5) / 9), V(0.52), 2.6, metal ? '#d8d0b8' : BRASS);
    // the lower lame
    bandGrad(g, r, 0.0, 0.28, rgba(INK, 0.35), rgba(INK, 0.05));
    band(g, r, 0.02, 0.07, S.color, 0.9);
    for (let k = 0; k < 7; k++) rivet(g, U((k + 0.3) / 7), V(0.16), 2, BRASS);
    band(g, r, 0.285, 0.31, INK, 0.5);
  });
}

function paintBelt(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    // top half: the strap
    clipRect(g, r.x, r.y, r.w, r.h * 0.5, () => {
      const strap = S.outfit === 'dealer' ? '#1e1a20' : '#3c2618';
      leather(g, r, r.x, r.y, r.w, r.h * 0.5, strap, rnd, { creases: 5, scuffs: 10, wrap: true, light: 0.4 });
      stitches(g, [[r.x, V(0.92)], [r.x + r.w, V(0.92)]], '#d2b483', 0.55);
      stitches(g, [[r.x, V(0.58)], [r.x + r.w, V(0.58)]], '#d2b483', 0.55);
      if (S.outfit === 'player') for (let k = 0; k < 7; k++) rivet(g, U((k + 0.5) / 7 + 0.03), V(0.75), 2.4);
      bandGrad(g, r, 0.5, 0.58, rgba(INK, 0.45), rgba(INK, 0));
    });
    // bottom half: pouches
    clipRect(g, r.x, V(0.48), r.w, r.h * 0.48, () => {
      leather(g, r, r.x, V(0.48), r.w, r.h * 0.48, '#7a5434', rnd, { creases: 6, scuffs: 8, wrap: true, light: 0.4 });
      band(g, r, 0.3, 0.48, '#5e3e26', 1);
      bandGrad(g, r, 0.25, 0.3, rgba(INK, 0), rgba(INK, 0.5));
      rivet(g, U(0.5), V(0.33), 3);
      stitches(g, [[U(0.1), V(0.05)], [U(0.1), V(0.28)]], '#d8bc8a', 0.5); stitches(g, [[U(0.9), V(0.05)], [U(0.9), V(0.28)]], '#d8bc8a', 0.5);
    });
  });
}

function paintHairRegion(g, r, S, rnd) {
  const hc = S.look.hairColor;
  clip(g, r, () => {
    locks(g, r, r.x, r.y, r.w, r.h, hc, rnd, { count: 12, len: [0.7, 1.05], width: [12, 18], sheen: 0.3, wrap: true, topPad: 0.1 });
    bandGrad(g, r, 0.0, 0.12, rgba(INK, 0.45), rgba(INK, 0));
  });
}
function paintBeardRegion(g, r, S, rnd) {
  const hc = S.look.hairColor;
  clip(g, r, () => {
    locks(g, r, r.x, r.y, r.w, r.h, hc, rnd, { count: 6, len: [0.4, 0.75], width: [9, 13], sheen: 0.3, wrap: true });
    if (S.look.hair === 'braid' || S.look.hair === 'bun') for (let k = 0; k < 9; k++) {   // braid lobes
      const y = r.y + (k + 0.5) / 9 * r.h;
      fold(g, curve(r.x, y - 4, r.x + r.w, y + 4, 0, 3), 3.4, hc, 0.7);
    }
  });
}
function paintEar(g, r, S) {
  const T = toneOf(S.tone);
  clip(g, r, () => {
    gradV(g, r.x, r.y, r.w, r.h, [[0, T.light], [0.5, T.blush], [1, T.shadow]]);
    blob(g, RX(r, 0.5), RY(r, 0.5), r.w * 0.2, r.h * 0.3, 0, T.deep, 0.5, 0.2);
  });
}
function paintHorn(g, r, rnd) {
  clip(g, r, () => {
    gradV(g, r.x, r.y, r.w, r.h, [[0, '#efe2c4'], [0.4, '#d8c49a'], [0.85, '#9a8264'], [1, '#6c5a48']]);
    for (let k = 0; k < 12; k++) { const y = r.y + r.h * (0.25 + k * 0.06); fold(g, curve(r.x, y, r.x + r.w, y + 2, 1, 3), 1.8, '#c8b48a', 0.5); }
    for (let i = 0; i < 6; i++) blob(g, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 4, 10), 3, 0, '#8a7458', 0.2, 0.2);
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.3)], [0.35, rgba('#fff8e0', 0.25)], [0.6, rgba(INK, 0)], [1, rgba(INK, 0.35)]]);
  });
}
function paintMetal(g, r, rnd) {
  clip(g, r, () => {
    gradV(g, r.x, r.y, r.w, r.h * 0.5, [[0, '#f0d890'], [0.5, BRASS], [1, '#6e5222']]);
    blob(g, RX(r, 0.35), RY(r, 0.85), r.w * 0.2, r.h * 0.06, 0, '#fff6d0', 0.6, 0.3);
    gradV(g, r.x, r.y + r.h * 0.5, r.w, r.h * 0.5, [[0, '#b8bcc6'], [0.5, IRON], [1, '#4a4a54']]);
    for (let i = 0; i < 10; i++) { const x = r.x + rnd() * r.w, y = r.y + r.h * (0.5 + rnd() * 0.5); stroke(g, [[x, y], [x + range(rnd, -8, 8), y + range(rnd, -2, 2)]], 0.8, 0.3, '#eef0f6', 0.35); }
  });
}
// NPC gear: the Repo Man's aviators (top: lens, then frame) and his tow chain (bottom).
function paintGear(g, r, S, rnd) {
  const V = v => RY(r, v);
  clip(g, r, () => {
    // lenses: dark glass reflecting a sky gradient and a hard white glint
    gradV(g, r.x, V(1), r.w, V(0.75) - V(1), [[0, '#6a7c96'], [0.45, '#2a3040'], [0.55, '#1e1a24'], [1, '#3a3028']]);
    stroke(g, [[RX(r, 0.2), V(0.97)], [RX(r, 0.45), V(0.78)]], 4, 3, '#e8f0ff', 0.55);
    stroke(g, [[RX(r, 0.5), V(0.98)], [RX(r, 0.62), V(0.86)]], 2, 1.5, '#e8f0ff', 0.4);
    // brass frame
    gradV(g, r.x, V(0.74), r.w, V(0.62) - V(0.74), [[0, '#f4dc98'], [0.5, BRASS], [1, '#5e4418']]);
    // the chain: iron links, alternating face-on and edge-on
    gradV(g, r.x, V(0.6), r.w, V(0) - V(0.6), [[0, '#3a3a44'], [1, '#2a2a32']]);
    const n = 7, lh = (V(0) - V(0.6)) / n;
    for (let k = 0; k < n; k++) {
      const y = V(0.6) + (k + 0.5) * lh;
      if (k % 2) {
        g.save(); g.lineWidth = lh * 0.34; g.strokeStyle = '#5a5c66'; g.beginPath(); g.ellipse(r.x + r.w / 2, y, r.w * 0.36, lh * 0.42, 0, 0, Math.PI * 2); g.stroke();
        g.lineWidth = lh * 0.12; g.strokeStyle = '#c8ccd6'; g.beginPath(); g.ellipse(r.x + r.w / 2 - 1, y - 1, r.w * 0.36, lh * 0.42, 0, Math.PI * 1.0, Math.PI * 1.7); g.stroke(); g.restore();
      } else {
        g.save(); g.fillStyle = '#6a6c76'; g.fillRect(r.x + r.w * 0.38, y - lh * 0.55, r.w * 0.24, lh * 1.1);
        g.fillStyle = '#b8bcc6'; g.fillRect(r.x + r.w * 0.4, y - lh * 0.5, r.w * 0.06, lh); g.restore();
      }
      for (let i = 0; i < 3; i++) blob(g, r.x + rnd() * r.w, y + (rnd() - 0.5) * lh, range(rnd, 2, 5), 2, 0, '#8a4a2a', 0.35, 0.3);   // rust
    }
  });
}
// The bedroll strapped to a player's back: rolled wool blanket, leather straps.
function paintPack(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    const wool = ['#8a5a3a', '#6a5a7a', '#7a6a3a', '#5a6a5a', '#8a4a3a', '#5a5a6a'][S.skin];
    // top half: the roll (u around the roll, v along it)
    clipRect(g, r.x, r.y, r.w, r.h * 0.6, () => {
      cloth(g, r, r.x, r.y, r.w, r.h * 0.6, wool, rnd, { folds: 3, wrap: true });
      for (let x = r.x + 6; x < r.x + r.w; x += 22) { g.save(); g.globalAlpha = 0.5; g.fillStyle = lightOf(wool, 0.5); g.fillRect(x, r.y, 4, r.h * 0.6); g.globalAlpha = 0.4; g.fillStyle = shadowOf(wool, 0.4); g.fillRect(x + 4, r.y, 2, r.h * 0.6); g.restore(); }
      gradV(g, r.x, r.y, r.w, r.h * 0.6, [[0, rgba('#fff1c4', 0.2)], [0.4, rgba('#fff1c4', 0)], [0.6, rgba(INK, 0)], [1, rgba(INK, 0.45)]]);
      for (const u of [0.2, 0.8]) {
        g.save(); g.fillStyle = '#3c2618'; g.fillRect(U(u) - 7, r.y, 14, r.h * 0.6); g.restore();
        stitches(g, [[U(u) - 5, r.y], [U(u) - 5, r.y + r.h * 0.6]], '#d2b483', 0.5);
      }
    });
    // bottom: the roll's spiral end caps
    clipRect(g, r.x, V(0.38), r.w, r.h * 0.38, () => {
      fill0(g, { x: r.x, y: V(0.38), w: r.w, h: r.h * 0.38 }, shadowOf(wool, 0.2));
      const cx = r.x + r.w / 2, cy = V(0.19);
      g.save(); g.strokeStyle = shadowOf(wool, 0.55); g.lineWidth = 3;
      g.beginPath(); for (let a = 0; a < Math.PI * 7; a += 0.2) { const rr = 2 + a * 1.9; g.lineTo(cx + Math.cos(a) * rr * 2.2, cy + Math.sin(a) * rr); } g.stroke(); g.restore();
    });
  });
}

// The accessory region: the hat (crown v .52-1, brim v 0-.45), Ed's apron, the visor.
function paintAcc(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v), c = S.color;
  const brim = { x: r.x, y: r.y + r.h * 0.52, w: r.w, h: r.h * 0.48 };
  clip(g, r, () => {
    const h = S.hat;
    if (S.apron) {
      leather(g, r, r.x, r.y, r.w, r.h, '#8a6440', rnd, { creases: 12, scuffs: 18 });
      for (let i = 0; i < 5; i++) blob(g, U(0.2 + rnd() * 0.6), V(0.2 + rnd() * 0.6), range(rnd, 6, 14), range(rnd, 5, 10), rnd() * 3, '#4a3a2a', 0.3, 0.3);   // stains
      g.save(); g.fillStyle = '#7a5636'; g.fillRect(U(0.35), V(0.62), r.w * 0.3, r.h * 0.14); g.restore();
      stitches(g, [[U(0.35), V(0.62)], [U(0.35), V(0.48)], [U(0.65), V(0.48)], [U(0.65), V(0.62)]], '#e8d0a0', 0.6);
      stroke(g, [[U(0.55), V(0.66)], [U(0.6), V(0.5)]], 3, 3, '#c8a040', 1);    // a pencil in the pocket
      blob(g, U(0.55), V(0.665), 2, 2, 0, '#e8a0a0', 1, 0.6);
      for (const u of [0.03, 0.97]) stitches(g, [[U(u), V(0)], [U(u), V(1)]], '#e8d0a0', 0.55);
      stitches(g, [[U(0), V(0.03)], [U(1), V(0.03)]], '#e8d0a0', 0.55);
      bandGrad(g, r, 0, 0.1, rgba(INK, 0.35), rgba(INK, 0));
      return;
    }
    if (h === 'brim') {
      leather(g, r, r.x, r.y, r.w, r.h, '#6e4c30', rnd, { creases: 14, scuffs: 20, light: 0.35, wrap: true });
      band(g, r, 0.5, 0.62, '#3a2618', 1); hstitch(g, r, 0.6, '#c8a070', 0.4); hstitch(g, r, 0.52, '#c8a070', 0.4);
      buckle(g, U(0.62), V(0.56), 7, 9);
      // a feather tucked in the band, in the player's color
      stroke(g, curve(U(0.3), V(0.55), U(0.22), V(0.98), 6, 6), 7, 1.5, lightOf(c, 0.2), 1);
      stroke(g, curve(U(0.3), V(0.55), U(0.22), V(0.98), 6, 6).map(([x, y]) => [x + 1, y]), 1.2, 0.5, shadowOf(c, 0.5), 0.8);
      bandGrad(g, r, 0.62, 0.7, rgba(INK, 0.35), rgba(INK, 0));
      stitches(g, [[r.x, V(0.06)], [r.x + r.w, V(0.06)]], '#d8b88a', 0.5);
      bandGrad(g, r, 0.88, 1.0, rgba('#fff0c8', 0), rgba('#fff0c8', 0.25));
    } else if (h === 'straw') {
      gradV(g, r.x, r.y, r.w, r.h, [[0, '#e6c97e'], [0.5, '#c9a255'], [1, '#9c7a3c']]);
      const rowH = 6.5;
      for (let row = 0, yy = r.y; yy < r.y + r.h; yy += rowH, row++) {
        g.save(); g.globalAlpha = 0.55; g.fillStyle = '#6a4a22'; g.fillRect(r.x, yy + rowH - 1.4, r.w, 1.4); g.restore();
        const dir = row % 2 ? 1 : -1;
        for (let xx = r.x - 4 + rnd() * 3; xx < r.x + r.w + 4; xx += 4.2) {
          const cc = pick(rnd, ['#e8cc80', '#d8b466', '#c9a254', '#efd894']);
          stroke(g, [[xx, yy + 0.8], [xx + dir * 3.2, yy + rowH - 1.8]], 3.4, 2.4, cc, 0.9);
          stroke(g, [[xx - 0.6, yy + 1.2], [xx + dir * 2.2 - 0.6, yy + rowH * 0.5]], 1, 0.6, '#fff0bc', 0.5);
        }
      }
      for (let i = 0; i < 10; i++) blob(g, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 10, 26), range(rnd, 6, 14), 0, pick(rnd, ['#8a6a34', '#f0d890']), 0.18, 0.1);
      band(g, r, 0.5, 0.6, c, 1); bandGrad(g, r, 0.5, 0.6, rgba('#fff0c8', 0.3), rgba(INK, 0.3));
      for (let i = 0; i < 20; i++) { const x = U(rnd()); stroke(g, [[x, V(0.02)], [x + range(rnd, -3, 3), V(-0.05)]], 1.2, 0.5, '#7a5a2a', 0.6); }
      bandGrad(g, r, 0, 0.12, rgba(INK, 0.35), rgba(INK, 0));
    } else if (h === 'bandana' || h === 'hood' || h === 'cap') {
      const cc = h === 'bandana' ? mix(c, '#7a2a24', 0.35) : h === 'hood' ? shadowOf(c, 0.15) : c;
      cloth(g, r, r.x, r.y, r.w, r.h, cc, rnd, { folds: h === 'hood' ? 10 : 8, light: 0.35, wrap: true });
      if (h === 'bandana') for (let i = 0; i < 40; i++) { const x = r.x + rnd() * r.w, y = r.y + rnd() * r.h; ellipse(g, x, y, 2, 2, 0, '#efe3c8', 0.7); ellipse(g, x + 3, y, 0.9, 0.9, 0, '#efe3c8', 0.6); }
      if (h === 'hood') { trimH(g, r.x, r.x + r.w, V(0.06), r.h * 0.05); trimH(g, r.x, r.x + r.w, V(0.56), r.h * 0.04); bandGrad(g, r, 0.52, 0.62, rgba(INK, 0.45), rgba(INK, 0)); }
      if (h === 'cap') {
        for (let k = 0; k < 6; k++) stitches(g, [[U(k / 6), V(0.52)], [U(k / 6 + 0.02), V(1)]], shadowOf(c, 0.5), 0.6);
        clipRect(g, brim.x, brim.y, brim.w, brim.h, () => {
          leather(g, r, brim.x, brim.y, brim.w, brim.h, '#5a3c26', rnd, { creases: 6, scuffs: 10 });
          stitches(g, [[r.x, V(0.12)], [r.x + r.w, V(0.12)]], '#d8b88a', 0.6);
          stitches(g, [[r.x, V(0.2)], [r.x + r.w, V(0.2)]], '#d8b88a', 0.6);
        });
        rivet(g, U(0.5), V(0.97), 3);
        band(g, r, 0.5, 0.56, shadowOf(c, 0.3), 1);
        wheelEmblem(g, U(0.5), V(0.7), 7);
      }
    } else if (h === 'helm') {
      gradV(g, r.x, r.y, r.w, r.h, [[0, '#d0d4dc'], [0.4, '#8a8e98'], [1, '#4a4c56']]);
      for (let i = 0; i < 14; i++) wblob(g, r, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 6, 18), range(rnd, 4, 10), rnd() * 3, pick(rnd, ['#6a5a52', '#a8acb6', '#5a5c66']), 0.3, 0.2);
      for (let i = 0; i < 30; i++) { const x = U(rnd()), y = V(rnd()); stroke(g, [[x, y], [x + range(rnd, -7, 7), y + range(rnd, -2, 2)]], 0.8, 0.3, '#f0f2f8', 0.4); }
      for (let k = 0; k < 4; k++) { const u = (k + 0.5) / 4; stroke(g, [[U(u), V(0.5)], [U(u), V(1)]], 5, 3, '#5a5c66', 0.6); stroke(g, [[U(u) - 2, V(0.5)], [U(u) - 2, V(1)]], 1.5, 1, '#e8eaf0', 0.5); }
      band(g, r, 0.42, 0.5, '#7a5a3c', 1);
      band(g, r, 0.0, 0.42, '#6a6c76', 1);
      bandGrad(g, r, 0.0, 0.42, rgba('#ffffff', 0.25), rgba(INK, 0.35));
      band(g, r, 0.3, 0.36, c, 0.9);
      for (let k = 0; k < 12; k++) rivet(g, U((k + 0.5) / 12), V(0.18), 3, '#c8ccd4');
      bandGrad(g, r, 0.85, 1, rgba('#ffffff', 0), rgba('#ffffff', 0.25));
    } else if (h === 'visor') {
      gradV(g, r.x, r.y, r.w, r.h, [[0, '#7ac08a'], [0.5, '#3a8a5a'], [1, '#1e5a3a']]);
      for (let i = 0; i < 6; i++) blob(g, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 10, 30), range(rnd, 5, 10), 0, '#c8f0c8', 0.18, 0.2);
      band(g, r, 0.5, 1, '#2a2632', 1); hstitch(g, r, 0.75, '#8a8090', 0.5);
      stitches(g, [[r.x, V(0.06)], [r.x + r.w, V(0.06)]], '#1a3a24', 0.5);
    } else if (h === 'beanie') {
      const kc = '#3a3a44';
      gradV(g, r.x, r.y, r.w, r.h, [[0, lightOf(kc, 0.3)], [0.5, kc], [1, shadowOf(kc, 0.3)]]);
      for (let x = r.x; x < r.x + r.w; x += 6) { stroke(g, [[x, r.y], [x, r.y + r.h]], 2.6, 2.6, shadowOf(kc, 0.45), 0.5); stroke(g, [[x + 3, r.y], [x + 3, r.y + r.h]], 1.6, 1.6, lightOf(kc, 0.35), 0.35); }
      band(g, r, 0.0, 0.3, mix(kc, '#5a4a3a', 0.2), 0.35);
      bandGrad(g, r, 0.28, 0.32, rgba(INK, 0.5), rgba(INK, 0));
      bandGrad(g, r, 0.8, 1.0, rgba('#fff1c4', 0), rgba('#fff1c4', 0.18));
    } else {
      fill0(g, r, '#5a4030');
    }
  });
}

// ---- atlases --------------------------------------------------------------------------

function paintAtlas(g, s, rnd, cv, S) {
  fill0(g, { x: 0, y: 0, w: AW, h: AH }, '#4a3a30');
  paintHead(g, REG.head, S, rnd);
  paintTorso(g, REG.torso, S, rnd);
  paintArm(g, REG.arm, S, rnd);
  paintLeg(g, REG.leg, S, rnd);
  paintFoot(g, REG.foot, S, rnd);
  paintEar(g, REG.ear, S);
  paintBeardRegion(g, REG.beard, S, rnd);
  paintSkirt(g, REG.skirt, S, rnd);
  paintFlap(g, REG.flap, S, rnd, false);
  paintFlap(g, REG.flapB, S, rnd, true);
  paintCollar(g, REG.collar, S, rnd);
  paintPauldron(g, REG.paul, S, rnd);
  paintBelt(g, REG.belt, S, rnd);
  paintHairRegion(g, REG.hair, S, rnd);
  paintAcc(g, REG.acc, S, rnd);
  paintHorn(g, REG.horn, rnd);
  paintMetal(g, REG.metal, rnd);
  paintGear(g, REG.gear, S, rnd);
  paintPack(g, REG.pack, S, rnd);
  // painterly softening + a warm unifying glaze, then bleed edges for mipmaps
  for (const k of ['torso', 'arm', 'leg', 'foot', 'paul', 'belt', 'acc', 'beard', 'skirt', 'flap', 'flapB', 'collar', 'pack']) soften(cv, REG[k], 0.55);
  soften(cv, REG.hair, 0.45);
  soften(cv, REG.head, 0.35);
  g.save(); g.globalCompositeOperation = 'soft-light'; g.globalAlpha = 0.12; g.fillStyle = '#ffd9a0'; g.fillRect(0, 0, AW, AH); g.restore();
  for (const r of Object.values(REG)) bleed(g, cv, r, 2);
}

export function charAtlas(spec) {
  const name = `chr_${spec.key}`;
  if (!has(name)) register(name, { family: 'characters-live', w: AW, h: AH, note: spec.outfit, paint: (g, s, rnd, h, cv) => paintAtlas(g, s, rnd, cv, spec) });
  return name;
}
// emissive map: black, with the eyes glowing (the Dealer's red eyes)
export function charGlow(spec) {
  if (!spec.eyeGlow) return null;
  const name = `chrglow_${spec.key}`;
  if (!has(name)) register(name, {
    family: 'characters-live', w: AW, h: AH, note: 'glow',
    paint(g) {
      fill0(g, { x: 0, y: 0, w: AW, h: AH }, '#000000');
      const r = REG.head, X = du => r.x + (0.5 + du) * r.w, Y = v => r.y + (1 - v) * r.h;
      for (const sd of [-1, 1]) {
        blob(g, X(sd * EYE_U), Y(headV(0.025)), 14, 7, 0, spec.eyeGlow, 0.5, 0.2);
        blob(g, X(sd * EYE_U + sd * 0.002), Y(headV(0.025)), 5, 4, 0, '#ffd0b0', 0.9, 0.4);
      }
    },
  });
  return name;
}

// ---- first-person hands (256×256): sleeve, gauntlet cuff, glove back, palm, fingers, thumb ----
export const FP = {
  sleeve: { x: 0, y: 0, w: 124, h: 124 },
  cuff: { x: 128, y: 0, w: 128, h: 60 },
  bracer: { x: 128, y: 64, w: 128, h: 60 },
  palm: { x: 128, y: 128, w: 128, h: 128 },
  finger: { x: 0, y: 128, w: 124, h: 60 },
  thumb: { x: 0, y: 192, w: 124, h: 64 },
};
function paintHands(g, s, rnd, cv, color) {
  const c = muted(color);
  fill0(g, { x: 0, y: 0, w: 256, h: 256 }, '#5a3c26');
  const GL = '#7a5232';
  clip(g, FP.sleeve, () => {
    const r = FP.sleeve;
    cloth(g, r, r.x, r.y, r.w, r.h, c, rnd, { folds: 8, foldAngle: Math.PI / 2, foldLen: [0.15, 0.4], wrap: true });
    trimH(g, r.x, r.x + r.w, RY(r, 0.1), r.h * 0.07);
    bandGrad(g, r, 0, 0.1, rgba(INK, 0.5), rgba(INK, 0));
  });
  clip(g, FP.bracer, () => {
    const r = FP.bracer;
    leather(g, r, r.x, r.y, r.w, r.h, LEATHER_D, rnd, { creases: 6, scuffs: 12, wrap: true, light: 0.4 });
    for (let k = 0; k < 4; k++) { const x = RX(r, 0.2 + k * 0.2); stroke(g, [[x - 4, RY(r, 0.3)], [x + 4, RY(r, 0.7)]], 2, 2, '#c9a878', 0.85); stroke(g, [[x + 4, RY(r, 0.3)], [x - 4, RY(r, 0.7)]], 2, 2, '#c9a878', 0.85); }
    hstitch(g, r, 0.1, '#c9a878', 0.55); hstitch(g, r, 0.9, '#c9a878', 0.55);
  });
  clip(g, FP.cuff, () => {
    const r = FP.cuff;
    leather(g, r, r.x, r.y, r.w, r.h, SUEDE, rnd, { creases: 6, scuffs: 12, wrap: true, light: 0.45 });
    trimH(g, r.x, r.x + r.w, RY(r, 0.97), r.h * 0.16, c, shadowOf(c, 0.5));
    hstitch(g, r, 0.74, '#e8d0a0', 0.6);
    for (let k = 0; k < 6; k++) rivet(g, RX(r, (k + 0.5) / 6), RY(r, 0.45), 3);
    bandGrad(g, r, 0, 0.2, rgba(INK, 0.5), rgba(INK, 0));
  });
  clip(g, FP.palm, () => {
    const r = FP.palm;
    leather(g, r, r.x, r.y, r.w, r.h, GL, rnd, { creases: 10, scuffs: 16, light: 0.4, wrap: true });
    // the back of the hand (u ~ .5): a stitched, riveted leather plate; knuckle highlights at the far end
    g.save(); g.beginPath(); g.roundRect(RX(r, 0.31), RY(r, 0.82), r.w * 0.38, r.h * 0.62, 8); g.clip();
    leather(g, r, RX(r, 0.31), RY(r, 0.82), r.w * 0.38, r.h * 0.62, shadowOf(GL, 0.12), rnd, { creases: 4, scuffs: 8, light: 0.45 });
    g.restore();
    stitches(g, [[RX(r, 0.32), RY(r, 0.81)], [RX(r, 0.32), RY(r, 0.21)], [RX(r, 0.68), RY(r, 0.21)], [RX(r, 0.68), RY(r, 0.81)], [RX(r, 0.32), RY(r, 0.81)]], '#e2c898', 0.65);
    for (const [u, v] of [[0.38, 0.74], [0.62, 0.74], [0.38, 0.28], [0.62, 0.28]]) rivet(g, RX(r, u), RY(r, v), 3);
    band(g, r, 0.38, 0.46, c, 0.85);   // a strap across the back in the player's color
    hstitch(g, r, 0.42, '#f0dca8', 0.5);
    for (const u of [0.38, 0.46, 0.54, 0.62]) blob(g, RX(r, u), RY(r, 0.92), 7, 4.5, 0, lightOf(GL, 0.55), 0.6, 0.25);
    blob(g, RX(r, 0.0), RY(r, 0.5), r.w * 0.2, r.h * 0.4, 0, INK, 0.4, 0.1);   // the palm side in shade
    blob(g, RX(r, 1.0), RY(r, 0.5), r.w * 0.2, r.h * 0.4, 0, INK, 0.4, 0.1);
    bandGrad(g, r, 0, 0.1, rgba(INK, 0.4), rgba(INK, 0));
  });
  for (const k of ['finger', 'thumb']) clip(g, FP[k], () => {
    const r = FP[k];
    leather(g, r, r.x, r.y, r.w, r.h, GL, rnd, { creases: 8, scuffs: 10, light: 0.4, wrap: true });
    for (const v of [0.38, 0.68]) { const y = RY(r, v); fold(g, curve(RX(r, 0.3), y, RX(r, 0.7), y, 2, 3), 2.4, GL, 0.65); }
    blob(g, RX(r, 0.5), RY(r, 0.55), r.w * 0.14, r.h * 0.45, 0, lightOf(GL, 0.4), 0.35, 0.2);
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.4)], [0.3, rgba(INK, 0)], [0.7, rgba(INK, 0)], [1, rgba(INK, 0.4)]]);
    bandGrad(g, r, 0.9, 1, rgba(INK, 0), rgba(INK, 0.4));
  });
  for (const r of Object.values(FP)) soften(cv, r, 0.6);
  g.save(); g.globalCompositeOperation = 'soft-light'; g.globalAlpha = 0.12; g.fillStyle = '#ffd9a0'; g.fillRect(0, 0, 256, 256); g.restore();
  for (const r of Object.values(FP)) bleed(g, cv, r, 2);
}
export function handsAtlas(color) {
  const name = `fphands_${muted(color).slice(1)}`;
  if (!has(name)) register(name, { family: 'characters-live', size: 256, paint: (g, s, rnd, h, cv) => paintHands(g, s, rnd, cv, color) });
  return name;
}

// ---- gallery samples --------------------------------------------------------------------

for (let i = 0; i < 6; i++) {
  register(`face_${i}`, {
    family: 'characters', w: 512, h: 192, note: `skin tone ${i} + face (head region)`,
    paint(g, s, rnd) { paintHead(g, { x: 0, y: 0, w: 512, h: 192 }, resolveSpec('#7CFC00', { skinIndex: i, hatIndex: i }), rnd); },
  });
}
const SAMPLES = {
  char_player: ['#7CFC00', { hatIndex: 0, skinIndex: 0 }],
  char_player4: ['#FF6EC7', { hatIndex: 4, skinIndex: 4 }],
  char_ed: ['#c0392b', { hatIndex: 2, skinIndex: 3 }],
  char_clerk: ['#2e86ab', { hatIndex: 0, skinIndex: 4 }],
  char_dealer: ['#111111', { hatIndex: 1, skinIndex: 4, eyeColor: '#d62828' }],
  char_repo: ['#6b5640', { hatIndex: 0, skinIndex: 1, scale: 1.25 }],
};
for (const [name, [col, o]] of Object.entries(SAMPLES)) {
  register(name, { family: 'characters', w: AW, h: AH, note: 'atlas (not tiled)', paint: (g, s, rnd, h, cv) => paintAtlas(g, s, rnd, cv, resolveSpec(col, o)) });
}
register('fp_hands', { family: 'characters', size: 256, note: 'first-person gloves', paint: (g, s, rnd, h, cv) => paintHands(g, s, rnd, cv, '#00E5FF') });
