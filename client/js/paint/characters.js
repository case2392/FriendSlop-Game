// Texture family: characters. WoW Classic-style hand-painted character skins.
//
// Every person is ONE skinned mesh with ONE 512×512 atlas (one draw call): face
// and hair, tunic/tabard, sleeves and gloves, trousers and boots, pauldrons, hat.
// REG lists the atlas regions; people.js maps its UVs into them with the same
// landmarks (HEAD_RINGS / HAIRLINE below), so the painted face lines up with the
// modeled nose and brow. Lathe-mapped regions run u around the part (u = 0.5 is
// the front, u = 0.25 the character's right, 0.75 its left) and v along it (0 =
// bottom). Light is baked from above/upper-left: warm cream highlights on top,
// cool violet-brown shadows below and in creases, soft dark seams, never black.
//
// Textures registered here (static, for the gallery): face_0..face_5 (the six
// skin tones and faces), char_<outfit> sample atlases, fp_hands sample. Live
// atlases are registered on demand by charAtlas(spec) / handsAtlas(color).
import {
  register, has, blob, ellipse, stroke, mix, shade, shadowOf, lightOf, hex, toHex, range, pick, makeCanvas, rgba,
} from './core.js';

export const AW = 512, AH = 512;
export const REG = {
  head:  { x: 0,   y: 0,   w: 512, h: 176 },
  torso: { x: 0,   y: 180, w: 256, h: 200 },
  arm:   { x: 260, y: 180, w: 92,  h: 200 },
  leg:   { x: 356, y: 180, w: 92,  h: 200 },
  foot:  { x: 452, y: 180, w: 60,  h: 96 },
  ear:   { x: 452, y: 280, w: 60,  h: 20 },
  beard: { x: 452, y: 304, w: 60,  h: 76 },
  paul:  { x: 0,   y: 384, w: 124, h: 60 },
  belt:  { x: 0,   y: 448, w: 124, h: 64 },
  hair:  { x: 128, y: 384, w: 124, h: 128 },
  acc:   { x: 256, y: 384, w: 188, h: 128 },
  horn:  { x: 448, y: 384, w: 64,  h: 60 },
  metal: { x: 448, y: 448, w: 64,  h: 64 },
};

// Head lathe, shared with people.js: [dy above the head origin (m), half-width (z),
// front depth, back depth, squareness, center x offset, texture v].
export const HEAD_RINGS = [
  [-0.150, 0.056, 0.058, 0.058, 2.0, -0.012, 0.00],
  [-0.112, 0.054, 0.057, 0.058, 2.0, -0.012, 0.07],
  [-0.092, 0.060, 0.070, 0.062, 2.2, -0.006, 0.115],
  [-0.082, 0.052, 0.093, 0.064, 2.6, 0.000, 0.16],
  [-0.066, 0.068, 0.102, 0.074, 2.6, 0.000, 0.22],
  [-0.045, 0.079, 0.105, 0.083, 2.4, 0.000, 0.31],
  [-0.022, 0.085, 0.105, 0.090, 2.3, 0.000, 0.42],
  [0.000, 0.089, 0.104, 0.097, 2.2, 0.000, 0.51],
  [0.025, 0.092, 0.101, 0.100, 2.1, 0.000, 0.60],
  [0.046, 0.092, 0.104, 0.101, 2.1, 0.000, 0.68],
  [0.080, 0.089, 0.093, 0.100, 2.0, -0.004, 0.80],
  [0.114, 0.075, 0.075, 0.089, 2.0, -0.008, 0.89],
  [0.141, 0.050, 0.047, 0.061, 2.0, -0.010, 0.96],
  [0.156, 0.000, 0.000, 0.000, 2.0, -0.010, 1.00],
];
export const EYE_U = 0.047;          // eye centers sit at u = 0.5 ± EYE_U
// Hairline: [|theta| (0 = front, PI = back), dy]
export const HAIRLINE = [[0, 0.083], [0.45, 0.079], [0.8, 0.058], [1.12, 0.012], [1.36, -0.004], [1.52, 0.03], [1.75, 0.03], [2.2, -0.03], [Math.PI, -0.062]];
export function lerpTable(tab, x, col = 1, key = 0) {
  if (x <= tab[0][key]) return tab[0][col];
  for (let i = 1; i < tab.length; i++) {
    if (x <= tab[i][key]) { const a = tab[i - 1], b = tab[i]; const t = (x - a[key]) / (b[key] - a[key] || 1); return a[col] + (b[col] - a[col]) * t; }
  }
  return tab[tab.length - 1][col];
}
export const headV = dy => lerpTable(HEAD_RINGS, dy, 6);
export const hairlineDy = th => lerpTable(HAIRLINE, Math.abs(th), 1);

// ---- who is who ---------------------------------------------------------------------

export const SKIN_TONES = ['#dda27b', '#c88d5f', '#a6704a', '#7c5038', '#ecbd99', '#5c3b2a'];
const LOOKS = [
  { hair: 'short', hairColor: '#5c3a1f', facial: 'stubble', eyes: '#4d6d8c', female: false },
  { hair: 'short', hairColor: '#221b1b', facial: 'mustache', eyes: '#5a3a1c', female: false },
  { hair: 'short', hairColor: '#3d2516', facial: 'beard', eyes: '#3f5c3a', female: false },
  { hair: 'bald', hairColor: '#a29b92', facial: 'goatee', eyes: '#4a2e1a', female: false },
  { hair: 'braid', hairColor: '#a3471f', facial: 'none', eyes: '#3f7350', female: true },
  { hair: 'bun', hairColor: '#1c1618', facial: 'none', eyes: '#3d2617', female: true },
];
export const HATS = ['brim', 'bandana', 'cap', 'hood', 'straw', 'helm'];
const OUTFITS = {
  player: { torso: 'tabard', arms: 'sleeve', hands: 'glove', legs: 'trousers', boots: 'tall', pauldrons: 'both', belt: true },
  ed:     { torso: 'shirt', arms: 'rolled', hands: 'bare', legs: 'wool', boots: 'short', pauldrons: 'none', belt: false, apron: true, hat: 'none', belly: 0.03 },
  clerk:  { torso: 'waistcoat', arms: 'shirt', hands: 'bare', legs: 'wool', boots: 'shoe', pauldrons: 'none', belt: true, hat: 'none' },
  dealer: { torso: 'vest', arms: 'shirt', hands: 'bare', legs: 'black', boots: 'shoe', pauldrons: 'none', belt: true, hat: 'visor', look: { hair: 'slick', hairColor: '#17121a', facial: 'pencil', female: false, stern: true } },
  repo:   { torso: 'overalls', arms: 'flannel', hands: 'workglove', legs: 'overalls', boots: 'tall', pauldrons: 'right', belt: false, hat: 'beanie', bulk: 1.13, belly: 0.025, look: { hair: 'buzz', hairColor: '#1d1716', facial: 'stubble', stern: true } },
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
  return fromHsl(h, Math.min(s, 0.5), Math.max(0.24, Math.min(0.4, l * 0.8 + 0.05)));
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
  if (outfit === 'repo') c = mix(c, '#9a7448', 0.55);
  const hat = O.hat || HATS[((hatIndex % 6) + 6) % 6];
  const spec = { ...O, outfit, color: c, raw: color, skin, tone, look, hat, eyeGlow: eyeColor || null };
  spec.key = [outfit, c, skin, hat, eyeColor || '-'].join('_').replace(/#/g, '');
  return spec;
}

// ---- painting helpers ---------------------------------------------------------------

const LEATHER = '#6c4a2f', LEATHER_D = '#432b1c', SUEDE = '#8a6340', TRIM = '#d4b26e', LINEN = '#e2d2ad', BRASS = '#b58c3c', IRON = '#7d8088';
const INK = '#24192a';    // the darkest thing we ever paint (soft violet-brown, not black)

function clip(g, r, fn) { g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip(); fn(); g.restore(); }
const RX = (r, u) => r.x + u * r.w;
const RY = (r, v) => r.y + (1 - v) * r.h;
function gradV(g, x, y, w, h, stops) {
  const gr = g.createLinearGradient(0, y, 0, y + h);
  for (const [t, c] of stops) gr.addColorStop(t, c);
  g.fillStyle = gr; g.fillRect(x, y, w, h);
}
// blob that wraps around a lathe region's u seam
function wblob(g, r, x, y, rx, ry, rot, c, a, hard) {
  blob(g, x, y, rx, ry, rot, c, a, hard);
  if (x - rx < r.x) blob(g, x + r.w, y, rx, ry, rot, c, a, hard);
  if (x + rx > r.x + r.w) blob(g, x - r.w, y, rx, ry, rot, c, a, hard);
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
  blob(g, x + rad * 0.45, y + rad * 0.55, rad * 1.5, rad * 1.3, 0, INK, 0.45, 0.25);
  ellipse(g, x, y, rad, rad, 0, shadowOf(base, 0.3));
  ellipse(g, x - rad * 0.12, y - rad * 0.12, rad * 0.8, rad * 0.8, 0, base);
  blob(g, x - rad * 0.35, y - rad * 0.4, rad * 0.5, rad * 0.42, 0, '#fff0c0', 0.85, 0.4);
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

// Cloth: lit-top gradient, big soft hue blotches, painted folds.
function cloth(g, r, x, y, w, h, base, rnd, { folds = 5, foldLen = [0.2, 0.45], foldAngle = 0, light = 0.3, blotch = 10, wrap = false } = {}) {
  gradV(g, x, y, w, h, [[0, lightOf(base, light)], [0.45, base], [1, shadowOf(base, light * 0.9)]]);
  const hues = [shade(base, 0.84), lightOf(base, 0.2), mix(base, '#5b4a7a', 0.2), mix(base, '#c9a35e', 0.14)];
  for (let i = 0; i < blotch; i++) {
    const bx = x + rnd() * w, by = y + rnd() * h, bw = range(rnd, w * 0.1, w * 0.28), bh = range(rnd, h * 0.08, h * 0.2);
    (wrap ? wblob : (gg, rr, ...a) => blob(gg, ...a))(g, r, bx, by, bw, bh, rnd() * 3, pick(rnd, hues), 0.24, 0.12);
  }
  for (let i = 0; i < folds; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, foldLen[0], foldLen[1]) * h, a = foldAngle + (rnd() - 0.5) * 0.7;
    fold(g, curve(x0, y0, x0 + Math.sin(a) * L, y0 + Math.cos(a) * L, (rnd() - 0.5) * L * 0.25), range(rnd, 3, 6), base, 0.42);
  }
}
// Leather: gradient, darker mottling, worn lighter patches, creases and scuffs.
function leather(g, r, x, y, w, h, base, rnd, { creases = 6, scuffs = 8, light = 0.3, wrap = false } = {}) {
  gradV(g, x, y, w, h, [[0, lightOf(base, light)], [0.5, base], [1, shadowOf(base, light)]]);
  const B = wrap ? wblob : (gg, rr, ...a) => blob(gg, ...a);
  for (let i = 0; i < 12; i++) B(g, r, x + rnd() * w, y + rnd() * h, range(rnd, w * 0.08, w * 0.22), range(rnd, h * 0.06, h * 0.18), rnd() * 3, pick(rnd, [shade(base, 0.78), mix(base, '#3a2a3e', 0.25), lightOf(base, 0.18)]), 0.26, 0.18);
  for (let i = 0; i < creases; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, 6, 16), a = rnd() * Math.PI;
    fold(g, curve(x0, y0, x0 + Math.cos(a) * L, y0 + Math.sin(a) * L, range(rnd, -3, 3), 3), range(rnd, 1.6, 3), base, 0.35);
  }
  for (let i = 0; i < scuffs; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, 3, 9), a = rnd() * Math.PI;
    stroke(g, [[x0, y0], [x0 + Math.cos(a) * L, y0 + Math.sin(a) * L]], range(rnd, 0.8, 1.6), 0.4, lightOf(base, 0.6), 0.3);
  }
}
// Hair: dark base, clumps of tapered strands flowing down, a warm sheen band.
function hair(g, r, x, y, w, h, base, rnd, { count = 60, len = [0.3, 0.7], sheen = 0.3, flow = 0, wrap = false, width = [2.5, 6] } = {}) {
  gradV(g, x, y, w, h, [[0, lightOf(base, 0.12)], [0.5, base], [1, shadowOf(base, 0.4)]]);
  const cols = [shadowOf(base, 0.55), shadowOf(base, 0.3), base, lightOf(base, 0.18), lightOf(base, 0.3)];
  for (let i = 0; i < count; i++) {
    const x0 = x + rnd() * w, y0 = y - h * 0.15 + rnd() * h * 0.85, L = range(rnd, len[0], len[1]) * h;
    const bend = (rnd() - 0.5) * 8 + flow * L * 0.3;
    const pts = curve(x0, y0, x0 + flow * L * 0.4 + (rnd() - 0.5) * 4, y0 + L, bend, 5);
    const c = pick(rnd, cols), wd = range(rnd, width[0], width[1]);
    stroke(g, pts, wd, 0.6, c, 0.6);
    if (wrap && x0 < x + 10) stroke(g, pts.map(([a, b]) => [a + w, b]), wd, 0.6, c, 0.6);
    if (wrap && x0 > x + w - 10) stroke(g, pts.map(([a, b]) => [a - w, b]), wd, 0.6, c, 0.6);
  }
  for (let i = 0; i < count * 0.4; i++) {
    const x0 = x + rnd() * w, y0 = y + h * (sheen - 0.08 + rnd() * 0.16), L = range(rnd, 0.08, 0.2) * h;
    stroke(g, curve(x0, y0, x0 + (rnd() - 0.5) * 3 + flow * L * 0.3, y0 + L, (rnd() - 0.5) * 3, 3), range(rnd, 1, 2), 0.3, mix(lightOf(base, 0.7), '#ffe6b0', 0.3), 0.45);
  }
}
function plaid(g, x, y, w, h, base, rnd) {
  gradV(g, x, y, w, h, [[0, lightOf(base, 0.2)], [0.5, base], [1, shadowOf(base, 0.3)]]);
  const dark = shadowOf(base, 0.5), light = mix(base, '#e0b070', 0.35);
  g.save();
  for (let xx = x - 6 + rnd() * 6; xx < x + w; xx += 17) { g.globalAlpha = 0.5; g.fillStyle = dark; g.fillRect(xx, y, 6, h); g.globalAlpha = 0.35; g.fillStyle = light; g.fillRect(xx + 10, y, 1.2, h); }
  for (let yy = y - 6 + rnd() * 6; yy < y + h; yy += 17) { g.globalAlpha = 0.42; g.fillStyle = dark; g.fillRect(x, yy, w, 6); g.globalAlpha = 0.35; g.fillStyle = light; g.fillRect(x, yy + 10, w, 1.2); }
  g.restore();
  for (let i = 0; i < 8; i++) blob(g, x + rnd() * w, y + rnd() * h, range(rnd, 8, 20), range(rnd, 6, 14), rnd() * 3, pick(rnd, [shadowOf(base, 0.3), lightOf(base, 0.2)]), 0.25, 0.1);
}
// Embroidered trim strip (horizontal) with a zigzag stitch.
function trimH(g, x0, x1, y, h, base = TRIM, accent = '#7a4a24') {
  g.save();
  gradV(g, x0, y, x1 - x0, h, [[0, lightOf(base, 0.35)], [0.5, base], [1, shadowOf(base, 0.35)]]);
  g.globalAlpha = 0.55; g.strokeStyle = accent; g.lineWidth = 1;
  g.beginPath();
  for (let x = x0, k = 0; x <= x1; x += h * 0.7, k++) g.lineTo(x, y + (k % 2 ? h * 0.25 : h * 0.75));
  g.stroke();
  g.globalAlpha = 0.6; g.fillStyle = INK; g.fillRect(x0, y + h - 0.8, x1 - x0, 1);
  g.restore();
}
function trimPath(g, pts, w, base = TRIM) {
  stroke(g, pts.map(([x, y]) => [x + 0.8, y + 0.9]), w + 1.6, w + 1.6, INK, 0.45);
  stroke(g, pts, w, w, base, 1);
  stroke(g, pts.map(([x, y]) => [x - w * 0.22, y - w * 0.22]), w * 0.35, w * 0.35, lightOf(base, 0.6), 0.6);
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
function wheelEmblem(g, x, y, rad, col = TRIM) {
  g.save();
  g.translate(x + 1, y + 1.2); g.globalAlpha = 0.45; g.strokeStyle = INK; g.lineWidth = rad * 0.3;
  g.beginPath(); g.arc(0, 0, rad, 0, Math.PI * 2); g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0); g.translate(x, y); g.globalAlpha = 1;
  g.strokeStyle = col; g.lineWidth = rad * 0.24;
  g.beginPath(); g.arc(0, 0, rad, 0, Math.PI * 2); g.stroke();
  g.lineWidth = rad * 0.13;
  for (let k = 0; k < 6; k++) { const a = k * Math.PI / 3 + 0.26; g.beginPath(); g.moveTo(Math.cos(a) * rad * 0.2, Math.sin(a) * rad * 0.2); g.lineTo(Math.cos(a) * rad * 0.92, Math.sin(a) * rad * 0.92); g.stroke(); }
  g.fillStyle = col; g.beginPath(); g.arc(0, 0, rad * 0.26, 0, Math.PI * 2); g.fill();
  g.globalAlpha = 0.7; g.strokeStyle = lightOf(col, 0.7); g.lineWidth = rad * 0.08;
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

// ---- the head: skin, face, painted hair ---------------------------------------------------

function toneOf(c) { return { base: c, light: lightOf(c, 0.32), shadow: shadowOf(c, 0.36), deep: shadowOf(c, 0.58), blush: mix(c, '#c4504a', 0.3), lip: mix(shadowOf(c, 0.2), '#a8494a', 0.35) }; }

function paintEye(g, cx, cy, ew, eh, side, S, glow) {
  const T = toneOf(S.tone), L = S.look;
  const inner = [cx - side * ew, cy + eh * 0.15], outer = [cx + side * ew, cy - eh * (L.female ? 0.35 : 0.1)];
  // socket shadow + crease
  blob(g, cx + side * ew * 0.1, cy - eh * 0.7, ew * 1.5, eh * 2.3, 0, mix(T.deep, '#4a3a6a', 0.25), 0.45, 0.15);
  blob(g, cx - side * ew * 0.9, cy - eh * 0.2, ew * 0.45, eh * 1.4, 0, T.deep, 0.35, 0.2);
  stroke(g, curve(inner[0] + side * ew * 0.15, cy - eh * 1.7, outer[0] - side * ew * 0.05, cy - eh * 1.75, -side * eh * 0.6, 4), 1.4, 0.6, T.deep, 0.4);
  const almond = () => {
    g.beginPath(); g.moveTo(...inner);
    g.quadraticCurveTo(cx - side * ew * 0.05, cy - eh * 1.55, ...outer);
    g.quadraticCurveTo(cx + side * ew * 0.15, cy + eh * 1.25, ...inner);
    g.closePath();
  };
  g.save();
  almond(); g.fillStyle = glow ? mix('#d8c8b4', glow, 0.2) : '#dccdb6'; g.fill();
  g.clip();
  const ir = eh * 1.12, ix = cx + side * ew * 0.06, iy = cy - eh * 0.05;
  ellipse(g, ix, iy, ir, ir * 1.05, 0, glow ? shadowOf(glow, 0.2) : shadowOf(L.eyes, 0.35));
  ellipse(g, ix, iy, ir * 0.78, ir * 0.82, 0, glow || L.eyes);
  blob(g, ix, iy + ir * 0.3, ir * 0.6, ir * 0.4, 0, glow ? '#ffb08a' : lightOf(L.eyes, 0.4), 0.6, 0.2);
  ellipse(g, ix, iy, ir * 0.36, ir * 0.38, 0, glow ? '#5a0d0d' : '#1d1418');
  ellipse(g, ix - ir * 0.35, iy - ir * 0.35, ir * 0.2, ir * 0.18, 0, '#fff4dc', 0.9);
  // lid shadow across the top of the eyeball
  gradV(g, cx - ew, cy - eh * 1.6, ew * 2, eh * 1.5, [[0, rgba(T.deep, 0.85)], [1, rgba(T.deep, 0)]]);
  g.restore();
  // upper lid: thick dark line (lashes), lower lid: soft
  const up = [inner, [cx - side * ew * 0.3, cy - eh * 1.05], [cx + side * ew * 0.35, cy - eh * 1.1], outer];
  if (L.female) up.push([outer[0] + side * ew * 0.35, outer[1] - eh * 0.45]);
  stroke(g, up, L.female ? 3.2 : 3, L.female ? 1.4 : 1.8, '#2a1914', 0.95);
  stroke(g, up.map(([x, y]) => [x, y - 1.6]), 1.6, 0.8, mix(T.deep, '#2a1914', 0.5), 0.5);
  stroke(g, [[inner[0] + side * ew * 0.2, inner[1] + eh * 0.4], [cx + side * ew * 0.2, cy + eh * 1.05], [outer[0], outer[1] + eh * 0.5]], 1.4, 0.7, T.deep, 0.6);
  blob(g, cx, cy + eh * 2.1, ew * 0.9, eh * 0.7, 0, T.light, 0.35, 0.2);
}

function paintHead(g, r, S, rnd) {
  const T = toneOf(S.tone), L = S.look;
  const X = du => r.x + (0.5 + du) * r.w, Y = v => r.y + (1 - v) * r.h;
  const ph = r.h, pw = r.w;
  const hc = L.hairColor;
  const vEye = headV(0.025), vBrow = headV(0.046), vNoseB = headV(-0.022), vMouth = headV(-0.047), vChin = headV(-0.082), vCheek = headV(0.0);
  clip(g, r, () => {
    // base skin, lit from above; neck darker
    gradV(g, r.x, r.y, r.w, r.h, [[0, T.light], [0.35, T.base], [1 - vChin, T.base], [1 - vChin * 0.6, T.shadow], [1, T.deep]]);
    for (let i = 0; i < 18; i++) wblob(g, r, r.x + rnd() * pw, r.y + rnd() * ph, range(rnd, 12, 40), range(rnd, 8, 24), rnd() * 3, pick(rnd, [T.light, T.shadow, T.blush, mix(T.base, '#7a6a9a', 0.2)]), 0.14, 0.1);
    // under the jaw: deep soft shadow at the front of the neck
    blob(g, X(0), Y(vChin - 0.035), pw * 0.15, ph * 0.07, 0, mix(T.deep, '#3c2c50', 0.25), 0.55, 0.25);
    blob(g, X(-0.13), Y(vChin + 0.02), pw * 0.06, ph * 0.1, 0.3, T.shadow, 0.35, 0.2);
    blob(g, X(0.13), Y(vChin + 0.02), pw * 0.06, ph * 0.1, -0.3, T.shadow, 0.35, 0.2);
    if (!L.female) blob(g, X(0), Y(0.07), pw * 0.012, ph * 0.03, 0, T.light, 0.35, 0.3);
    // cheeks, cheekbones, temples
    for (const s of [-1, 1]) {
      blob(g, X(s * 0.075), Y(vCheek - 0.04), pw * 0.035, ph * 0.07, 0, T.blush, L.female ? 0.4 : 0.25, 0.15);
      blob(g, X(s * 0.07), Y(vCheek + 0.02), pw * 0.04, ph * 0.03, s * 0.3, T.light, 0.4, 0.2);
      blob(g, X(s * 0.095), Y(vCheek - 0.1), pw * 0.035, ph * 0.08, s * 0.2, T.shadow, L.female ? 0.15 : 0.3, 0.15);
      blob(g, X(s * 0.13), Y(vBrow), pw * 0.035, ph * 0.1, 0, mix(T.shadow, '#6a5a8a', 0.2), 0.25, 0.15);
      blob(g, X(s * 0.05), Y(vBrow + 0.035), pw * 0.04, ph * 0.035, 0, T.light, 0.35, 0.2);     // brow ridge light
    }
    // big planes: the sides of the face turn away (cool), the front plane catches light
    for (const s of [-1, 1]) {
      blob(g, X(s * 0.175), Y(0.42), pw * 0.06, ph * 0.28, 0, mix(T.shadow, '#5a4a78', 0.15), 0.45, 0.1);
      blob(g, X(s * 0.15), Y(vBrow + 0.02), pw * 0.04, ph * 0.12, 0, T.shadow, 0.3, 0.1);
      blob(g, X(s * 0.115), Y(vChin + 0.06), pw * 0.05, ph * 0.06, s * 0.5, T.deep, 0.3, 0.15);     // jaw corner
      blob(g, X(s * EYE_U), Y(vEye + 0.045), pw * 0.042, ph * 0.04, 0, mix(T.deep, '#4a3a6a', 0.3), 0.4, 0.15);   // under the brow
    }
    blob(g, X(-0.012), Y(0.77), pw * 0.08, ph * 0.07, 0, T.light, 0.4, 0.15);    // forehead
    blob(g, X(0), Y(vEye + 0.005), pw * 0.012, ph * 0.04, 0, T.light, 0.3, 0.3);  // between the eyes
    // ears: shade where they attach
    for (const s of [-1, 1]) blob(g, X(s * 0.25), Y(0.55), pw * 0.025, ph * 0.12, 0, T.shadow, 0.4, 0.2);
    // nose
    stroke(g, [[X(-0.003), Y(vBrow - 0.02)], [X(-0.004), Y(vNoseB + 0.08)]], pw * 0.012, pw * 0.016, T.light, 0.55);
    blob(g, X(-0.002), Y(vNoseB + 0.035), pw * 0.016, ph * 0.03, 0, lightOf(T.base, 0.45), 0.6, 0.3);
    blob(g, X(0.017), Y(vNoseB + 0.07), pw * 0.01, ph * 0.08, 0, T.shadow, 0.5, 0.2);
    blob(g, X(0), Y(vNoseB), pw * 0.024, ph * 0.02, 0, T.deep, 0.65, 0.3);
    for (const s of [-1, 1]) ellipse(g, X(s * 0.01), Y(vNoseB + 0.005), pw * 0.0055, ph * 0.011, s * 0.4, mix(T.deep, '#3a1a1a', 0.3), 0.85);
    blob(g, X(0), Y((vNoseB + vMouth) / 2), pw * 0.006, ph * 0.025, 0, T.shadow, 0.35, 0.3);   // philtrum
    for (const s of [-1, 1]) {
      blob(g, X(s * 0.019), Y(vNoseB + 0.015), pw * 0.008, ph * 0.025, 0, T.shadow, 0.55, 0.3);   // nostril wings
      if (!L.female) stroke(g, curve(X(s * 0.024), Y(vNoseB + 0.01), X(s * 0.04), Y(vMouth - 0.02), s * 2, 4), 2.2, 1, T.shadow, 0.35);   // smile folds
    }
    // stubble / beard base go under the mouth
    facialBase(g, X, Y, pw, ph, S, T, rnd, vMouth, vChin, vNoseB);
    // mouth
    const mw = pw * (L.female ? 0.03 : 0.034), my = Y(vMouth);
    blob(g, X(0), my - ph * 0.012, mw * 1.05, ph * 0.016, 0, mix(T.lip, T.shadow, 0.3), 0.55, 0.4);          // upper lip
    blob(g, X(0), my + ph * 0.015, mw * 0.85, ph * 0.016, 0, L.female ? mix(T.lip, '#c25a5a', 0.3) : T.lip, L.female ? 0.75 : 0.45, 0.4);
    blob(g, X(-0.004), my + ph * 0.012, mw * 0.4, ph * 0.007, 0, lightOf(T.base, 0.4), 0.5, 0.3);      // lower lip shine
    stroke(g, [[X(0) - mw, my + (S.look.stern ? 1.5 : 0.5)], [X(0) - mw * 0.4, my - 0.4], [X(0), my + 0.2], [X(0) + mw * 0.4, my - 0.4], [X(0) + mw, my + (S.look.stern ? 1.5 : 0.5)]], 2, 1.6, '#3b2220', 0.85);
    blob(g, X(0), my + ph * 0.035, mw * 0.7, ph * 0.012, 0, T.shadow, 0.4, 0.3);     // under the lower lip
    blob(g, X(0), Y(vChin + 0.045), pw * 0.024, ph * 0.03, 0, T.light, 0.45, 0.25);  // chin light
    // eyes & brows
    const ew = pw * 0.025, eh = ph * 0.027;
    for (const s of [-1, 1]) paintEye(g, X(s * EYE_U), Y(vEye), ew, eh, s, S, S.eyeGlow);
    const browC = L.hair === 'bald' ? mix(hc, '#6a6a6a', 0.3) : shadowOf(hc, 0.15);
    for (const s of [-1, 1]) {
      const cx = X(s * EYE_U), by = Y(vBrow + 0.012);
      const innerY = by + (L.stern ? ph * 0.022 : ph * 0.006);
      const pts = [[cx - s * ew * 1.0, innerY], [cx + s * ew * 0.2, by - ph * (L.female ? 0.024 : 0.012)], [cx + s * ew * 1.3, by + ph * 0.012]];
      stroke(g, pts, L.female ? 3 : 5.5, L.female ? 1 : 2, browC, 0.92);
      stroke(g, pts.map(([x, y]) => [x - 0.6, y - 1]), L.female ? 1 : 2, 0.5, lightOf(browC, 0.35), 0.45);
    }
    facialHair(g, X, Y, pw, ph, S, T, rnd, vMouth, vChin, vNoseB);
    paintHairCap(g, r, S, rnd);
  });
}

function jawPath(g, X, Y, ph, vMouth, vChin, top) {
  g.beginPath();
  g.moveTo(X(-0.215), Y(top));
  g.bezierCurveTo(X(-0.2), Y(vChin + 0.05), X(-0.1), Y(vChin - 0.03), X(0), Y(vChin - 0.035));
  g.bezierCurveTo(X(0.1), Y(vChin - 0.03), X(0.2), Y(vChin + 0.05), X(0.215), Y(top));
  g.lineTo(X(0.17), Y(top));
  g.bezierCurveTo(X(0.12), Y(vMouth + 0.13), X(0.07), Y(vMouth + 0.08), X(0.03), Y(vMouth + 0.07));
  g.lineTo(X(-0.03), Y(vMouth + 0.07));
  g.bezierCurveTo(X(-0.07), Y(vMouth + 0.08), X(-0.12), Y(vMouth + 0.13), X(-0.17), Y(top));
  g.closePath();
}
function facialBase(g, X, Y, pw, ph, S, T, rnd, vMouth, vChin, vNoseB) {
  const L = S.look, f = L.facial;
  if (L.female || f === 'none' || f === 'pencil') return;
  const hc = L.hairColor;
  g.save();
  jawPath(g, X, Y, ph, vMouth, vChin, f === 'goatee' ? 0.3 : 0.5);
  g.clip();
  const sc = mix(mix(hc, T.shadow, 0.5), '#3e3a5a', 0.25);
  const amt = f === 'stubble' ? 0.38 : f === 'goatee' ? 0.22 : 0.3;
  blob(g, X(0), Y(vChin + 0.06), pw * 0.2, ph * 0.22, 0, sc, amt, 0.35);
  blob(g, X(0), Y(vMouth + 0.05), pw * 0.05, ph * 0.04, 0, sc, amt * 0.8, 0.3);
  for (let i = 0; i < 70; i++) blob(g, X((rnd() - 0.5) * 0.4), Y(vChin - 0.02 + rnd() * 0.35), range(rnd, 3, 7), range(rnd, 2, 4), rnd() * 3, sc, amt * 0.35, 0.1);
  g.restore();
}
function facialHair(g, X, Y, pw, ph, S, T, rnd, vMouth, vChin, vNoseB) {
  const L = S.look, f = L.facial, hc = L.hairColor;
  const strands = (x0, y0, x1, y1, n, w0, spread) => {
    for (let i = 0; i < n; i++) {
      const t = rnd();
      const sx = x0 + (x1 - x0) * t + (rnd() - 0.5) * spread, sy = y0 + (y1 - y0) * t + (rnd() - 0.5) * spread * 0.5;
      stroke(g, curve(sx, sy, sx + (rnd() - 0.5) * 3, sy + range(rnd, 4, 10), (rnd() - 0.5) * 3, 3), w0 * range(rnd, 0.6, 1.2), 0.5, pick(rnd, [shadowOf(hc, 0.4), hc, lightOf(hc, 0.25)]), 0.7);
    }
  };
  const mustache = (droop, curl) => {
    for (const s of [-1, 1]) {
      const pts = [[X(s * 0.004), Y(vNoseB - 0.025)], [X(s * 0.022), Y(vNoseB - 0.04)], [X(s * 0.042), Y(vMouth - droop)]];
      if (curl) pts.push([X(s * 0.058), Y(vMouth + 0.02)], [X(s * 0.062), Y(vMouth + 0.06)]);
      stroke(g, pts.map(([x, y]) => [x + 0.8, y + 1.2]), 7, 2, T.deep, 0.5);
      stroke(g, pts, 7, curl ? 2.2 : 3, shadowOf(hc, 0.1), 1);
      stroke(g, pts.map(([x, y]) => [x - 0.5, y - 1.5]), 2.4, 0.8, lightOf(hc, 0.35), 0.7);
    }
  };
  if (f === 'mustache') mustache(0.03, true);
  if (f === 'pencil') for (const s of [-1, 1]) stroke(g, [[X(s * 0.004), Y(vNoseB - 0.04)], [X(s * 0.03), Y(vMouth + 0.035)]], 1.8, 1, shadowOf(hc, 0.1), 0.95);
  if (f === 'goatee') {
    mustache(0.0, false);
    g.save();
    g.beginPath(); g.ellipse(X(0), Y(vChin + 0.03), pw * 0.034, ph * 0.075, 0, 0, Math.PI * 2); g.clip();
    hair(g, null, X(-0.04), Y(vMouth - 0.03), pw * 0.08, ph * 0.2, hc, rnd, { count: 30, len: [0.4, 0.8], sheen: 0.3, width: [2, 4] });
    g.restore();
    blob(g, X(0), Y(vMouth - 0.02), pw * 0.014, ph * 0.012, 0, T.lip, 0.5, 0.3);   // the lip shows through
  }
  if (f === 'beard') {
    g.save(); jawPath(g, X, Y, ph, vMouth, vChin, 0.56); g.clip();
    hair(g, null, X(-0.23), Y(0.62), pw * 0.46, ph * 0.6, hc, rnd, { count: 110, len: [0.12, 0.28], sheen: 0.4, width: [2.5, 5] });
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
    for (let k = 0; k <= 48; k++) {
      const u = k / 48, th = Math.PI - 2 * Math.PI * u;
      const jag = (k % 2 ? 0.012 : -0.008);
      g.lineTo(X(u), Y(headV(hairlineDy(th) - drop) + (L.hair === 'short' && Math.abs(th) < 1 ? jag : 0)));
    }
    g.lineTo(X(1), Y(1.2)); g.closePath();
  };
  if (L.hair === 'bald') {
    // a horseshoe of short gray hair round the back, shiny scalp on top
    g.save(); capPath(-0.005); g.clip();
    for (let i = 0; i < 160; i++) {
      const u = rnd(), th = Math.PI - 2 * Math.PI * u;
      if (Math.abs(th) < 1.45) continue;
      const v0 = headV(hairlineDy(th)), v = v0 + rnd() * 0.22;
      blob(g, X(u), Y(v), range(rnd, 2, 5), range(rnd, 2, 4), rnd() * 3, pick(rnd, [hc, shadowOf(hc, 0.3), lightOf(hc, 0.2)]), 0.4, 0.3);
    }
    g.restore();
    blob(g, X(0.45), Y(0.93), r.w * 0.09, r.h * 0.06, 0, '#fff2d6', 0.4, 0.15);
    return;
  }
  g.save(); capPath(); g.clip();
  if (L.hair === 'buzz') {
    for (let i = 0; i < 260; i++) blob(g, X(rnd()), Y(0.3 + rnd() * 0.75), range(rnd, 2, 5), range(rnd, 2, 4), rnd() * 3, pick(rnd, [hc, shadowOf(hc, 0.3), mix(hc, S.tone, 0.3)]), 0.42, 0.3);
  } else {
    hair(g, r, r.x, Y(1), r.w, r.h * 0.8, hc, rnd, { count: 110, len: [0.25, 0.6], sheen: 0.3, wrap: true });
  }
  g.restore();
  // soft shadow just under the hairline (hair casts onto the forehead)
  g.save(); g.globalAlpha = 0.18; g.translate(0, 3); capPath(); g.fillStyle = shadowOf(S.tone, 0.5); g.fill(); g.restore();
  g.save(); capPath(); g.clip();
  if (L.hair !== 'buzz') hair(g, r, r.x, Y(1), r.w, r.h * 0.8, hc, rnd, { count: 50, len: [0.2, 0.45], sheen: 0.35, wrap: true });
  g.restore();
}

// ---- body regions -------------------------------------------------------------------------

function paintTorso(g, r, S, rnd) {
  const c = S.color, U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    if (S.torso === 'tabard') {
      leather(g, r, r.x, r.y, r.w, r.h, LEATHER, rnd, { creases: 14, scuffs: 16, wrap: true });
      for (const u of [0.25, 0.75]) stitches(g, [[U(u), V(0)], [U(u), V(0.95)]], INK, 0.5);
      // linen undershirt in the V
      g.save(); g.beginPath(); g.moveTo(U(0.43), V(1.02)); g.lineTo(U(0.5), V(0.72)); g.lineTo(U(0.57), V(1.02)); g.closePath(); g.clip();
      cloth(g, r, U(0.42), V(1.02), r.w * 0.16, r.h * 0.32, LINEN, rnd, { folds: 2 });
      for (let k = 0; k < 3; k++) { const y = V(0.92 - k * 0.055); stroke(g, [[U(0.475), y - 3], [U(0.525), y + 3]], 1.4, 1.4, '#5a3a24', 0.85); stroke(g, [[U(0.525), y - 3], [U(0.475), y + 3]], 1.4, 1.4, '#5a3a24', 0.85); }
      g.restore();
      // tabard panels (front and back), with gold trim
      const panel = (cu, top, vneck) => {
        const p = [[U(cu - 0.15), V(-0.02)], [U(cu + 0.15), V(-0.02)], [U(cu + 0.13), V(top)]];
        if (vneck) p.push([U(cu + 0.065), V(top)], [U(cu), V(0.72)], [U(cu - 0.065), V(top)]);
        p.push([U(cu - 0.13), V(top)]);
        return p;
      };
      for (const [cu, top, vneck] of [[0.5, 0.86, true], [0, 0.9, false], [1, 0.9, false]]) {
        const p = panel(cu, top, vneck);
        g.save(); g.beginPath(); p.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath();
        g.save(); g.translate(2, 2.5); g.fillStyle = rgba(INK, 0.5); g.fill(); g.restore();
        g.clip();
        cloth(g, r, U(cu - 0.16), V(top + 0.02), r.w * 0.32, r.h * (top + 0.04), c, rnd, { folds: 7, foldAngle: 0, light: 0.32, blotch: 12 });
        trimH(g, U(cu - 0.16), U(cu + 0.16), V(0.055), r.h * 0.05);
        g.restore();
        trimPath(g, [p[0], p[p.length - 1]], 3.2);
        trimPath(g, [p[1], p[2]], 3.2);
        if (vneck) trimPath(g, p.slice(3, 6), 2.6);
        wheelEmblem(g, U(cu), V(0.6), r.w * 0.045);
      }
    } else if (S.torso === 'shirt') {
      cloth(g, r, r.x, r.y, r.w, r.h, c, rnd, { folds: 12, light: 0.3, blotch: 14, wrap: true });
      // button placket & collar
      stroke(g, [[U(0.5), V(0.02)], [U(0.5), V(0.95)]], 3, 3, shadowOf(c, 0.3), 0.6);
      for (let k = 0; k < 6; k++) rivet(g, U(0.505), V(0.85 - k * 0.12), 1.6, '#d9ccb0');
      // apron neck strap and waist ties
      for (const s of [-1, 1]) stroke(g, [[U(0.5 + s * 0.1), V(0.72)], [U(0.5 + s * 0.075), V(0.9)], [U(0.5 + s * 0.05), V(1.02)]], 5, 5, '#5a3c26', 1);
      band(g, r, 0.31, 0.345, '#5a3c26', 1); hstitch(g, r, 0.328, '#2a1b12', 0.5);
      blob(g, U(0.0), V(0.31), 9, 6, 0, '#5a3c26', 1, 0.7); blob(g, U(1.0), V(0.31), 9, 6, 0, '#5a3c26', 1, 0.7);
      // suspenders down the back
      for (const s of [-1, 1]) stroke(g, [[U(0.0 + s * 0.06), V(0.34)], [U(0.0 + s * 0.04), V(1.02)]], 5, 5, '#3d2a1c', 0.95);
      for (const s of [-1, 1]) stroke(g, [[U(1.0 + s * 0.06), V(0.34)], [U(1.0 + s * 0.04), V(1.02)]], 5, 5, '#3d2a1c', 0.95);
    } else if (S.torso === 'waistcoat' || S.torso === 'vest') {
      const vest = S.torso === 'vest' ? '#2c2832' : c;
      cloth(g, r, r.x, r.y, r.w, r.h, LINEN, rnd, { folds: 8, wrap: true });
      g.save(); g.beginPath();
      g.moveTo(U(-0.01), V(0.18)); g.lineTo(U(0.5), V(0.12)); g.lineTo(U(1.01), V(0.18)); g.lineTo(U(1.01), V(0.9));
      g.lineTo(U(0.58), V(0.92)); g.lineTo(U(0.5), V(0.6)); g.lineTo(U(0.42), V(0.92)); g.lineTo(U(-0.01), V(0.9)); g.closePath();
      g.save(); g.translate(1.5, 2); g.fillStyle = rgba(INK, 0.45); g.fill(); g.restore();
      g.clip();
      cloth(g, r, r.x, r.y, r.w, r.h, vest, rnd, { folds: 9, light: 0.35, wrap: true });
      if (S.torso === 'vest') { g.save(); g.globalAlpha = 0.12; g.fillStyle = '#c8c0d8'; for (let x = r.x + 3; x < r.x + r.w; x += 7) g.fillRect(x, r.y, 1, r.h); g.restore(); }
      // satin back
      g.save(); g.globalAlpha = 0.35; g.fillStyle = shadowOf(vest, 0.4); g.fillRect(U(0.8), r.y, r.w * 0.4, r.h); g.fillRect(U(-0.2), r.y, r.w * 0.4, r.h); g.restore();
      g.restore();
      stroke(g, [[U(0.42), V(0.92)], [U(0.5), V(0.6)], [U(0.58), V(0.92)]], 2, 2, lightOf(vest, 0.5), 0.6);
      stroke(g, [[U(0.5), V(0.6)], [U(0.5), V(0.13)]], 1.5, 1.5, shadowOf(vest, 0.5), 0.8);
      for (let k = 0; k < 4; k++) rivet(g, U(0.515), V(0.54 - k * 0.1), 2.4);
      for (const s of [-1, 1]) { stroke(g, [[U(0.5 + s * 0.06), V(0.42)], [U(0.5 + s * 0.13), V(0.43)]], 2, 2, shadowOf(vest, 0.5), 0.8); }
      if (S.torso === 'waistcoat') stroke(g, curve(U(0.515), V(0.46), U(0.62), V(0.43), 6), 1.4, 1.4, BRASS, 0.95);   // watch chain
      // bow tie
      const tie = S.torso === 'vest' ? '#9a2a2a' : '#6a2a2a';
      for (const s of [-1, 1]) { g.save(); g.beginPath(); g.moveTo(U(0.5), V(0.95)); g.lineTo(U(0.5 + s * 0.05), V(0.985)); g.lineTo(U(0.5 + s * 0.05), V(0.915)); g.closePath(); g.fillStyle = tie; g.fill(); g.restore(); }
      blob(g, U(0.5), V(0.95), 3.5, 3.5, 0, shadowOf(tie, 0.2), 1, 0.7);
      blob(g, U(0.48), V(0.965), 3, 1.5, 0, lightOf(tie, 0.5), 0.5, 0.3);
    } else if (S.torso === 'overalls') {
      plaid(g, r.x, r.y, r.w, r.h, '#7d3428', rnd);
      for (let i = 0; i < 6; i++) fold(g, curve(U(rnd()), V(0.5 + rnd() * 0.4), U(rnd()), V(0.4 + rnd() * 0.3), 4), 3, '#7d3428', 0.3);
      const ov = c;
      g.save(); g.beginPath();
      g.moveTo(U(-0.01), V(0.0)); g.lineTo(U(1.01), V(0.0)); g.lineTo(U(1.01), V(0.3)); g.lineTo(U(0.63), V(0.32));
      g.lineTo(U(0.62), V(0.78)); g.lineTo(U(0.38), V(0.78)); g.lineTo(U(0.37), V(0.32)); g.lineTo(U(-0.01), V(0.3)); g.closePath();
      g.save(); g.translate(1.5, 2.5); g.fillStyle = rgba(INK, 0.5); g.fill(); g.restore();
      g.clip();
      cloth(g, r, r.x, r.y, r.w, r.h, ov, rnd, { folds: 10, light: 0.3, wrap: true });
      g.restore();
      stitches(g, [[U(0.385), V(0.76)], [U(0.615), V(0.76)], [U(0.625), V(0.33)]], '#e0c890', 0.6);
      stitches(g, [[U(0.385), V(0.76)], [U(0.375), V(0.33)]], '#e0c890', 0.6);
      // bib pocket, straps, buttons
      g.save(); g.fillStyle = shadowOf(ov, 0.15); g.fillRect(U(0.44), V(0.66), r.w * 0.12, r.h * 0.14); g.restore();
      stitches(g, [[U(0.44), V(0.66)], [U(0.56), V(0.66)]], '#e0c890', 0.6);
      for (const s of [-1, 1]) {
        stroke(g, [[U(0.5 + s * 0.1), V(0.76)], [U(0.5 + s * 0.08), V(1.02)]], 9, 9, shadowOf(ov, 0.1), 1);
        stroke(g, [[U(0.0 + s * 0.08), V(0.3)], [U(0.0 - s * 0.07), V(1.02)]], 9, 9, shadowOf(ov, 0.15), 1);
        stroke(g, [[U(1.0 + s * 0.08), V(0.3)], [U(1.0 - s * 0.07), V(1.02)]], 9, 9, shadowOf(ov, 0.15), 1);
        rivet(g, U(0.5 + s * 0.1), V(0.74), 4);
        rivet(g, U(0.5 + s * 0.24), V(0.28), 3.5);
      }
      rivet(g, U(0), V(0.62), 3.5); rivet(g, U(1), V(0.62), 3.5);
    }
    // common shading: armpits, under the belt, hem, collar
    for (const u of [0.25, 0.75]) { blob(g, U(u), V(0.8), r.w * 0.09, r.h * 0.16, 0, INK, 0.5, 0.15); blob(g, U(u), V(0.55), r.w * 0.05, r.h * 0.2, 0, INK, 0.18, 0.1); }
    bandGrad(g, r, 0.18, 0.27, rgba(INK, 0), rgba(INK, 0.4));
    bandGrad(g, r, 0.0, 0.05, rgba(INK, 0.35), rgba(INK, 0.0));
    blob(g, U(0.42), V(0.7), r.w * 0.09, r.h * 0.12, 0, '#fff1c4', 0.12, 0.1);
    if (S.torso !== 'waistcoat' && S.torso !== 'vest' && S.torso !== 'overalls') {
      band(g, r, 0.93, 1.0, LEATHER_D, 0.85);
      hstitch(g, r, 0.94, '#c8a878', 0.4);
    }
    bandGrad(g, r, 0.965, 1.0, rgba(INK, 0), rgba(INK, 0.75));
  });
}

function paintArm(g, r, S, rnd) {
  const c = S.color, U = u => RX(r, u), V = v => RY(r, v);
  const skin = toneOf(S.tone);
  clip(g, r, () => {
    // upper: sleeve
    const sleeveC = S.arms === 'sleeve' ? c : S.arms === 'rolled' ? c : S.arms === 'flannel' ? '#7d3428' : LINEN;
    const sleeveTo = S.arms === 'rolled' ? 0.56 : S.arms === 'sleeve' ? 0.53 : 0.2;
    if (S.arms === 'flannel') plaid(g, r.x, r.y, r.w, r.h, sleeveC, rnd);
    else cloth(g, r, r.x, r.y, r.w, r.h, sleeveC, rnd, { folds: 9, foldAngle: Math.PI / 2, foldLen: [0.04, 0.1], wrap: true });
    // elbow wrinkles
    for (let i = 0; i < 4; i++) fold(g, curve(U(0.05 + rnd() * 0.4), V(0.58 + rnd() * 0.06), U(0.5 + rnd() * 0.45), V(0.57 + rnd() * 0.06), 3), 2.5, sleeveC, 0.35);
    if (S.arms === 'sleeve') trimH(g, r.x, r.x + r.w, V(0.575), r.h * 0.035);
    if (S.arms === 'shirt') {
      // sleeve garter
      band(g, r, 0.74, 0.77, S.outfit === 'dealer' ? '#9a2a2a' : '#2d2a3a', 1); hstitch(g, r, 0.755, '#f0d8a0', 0.35);
    }
    // forearm
    if (S.arms === 'rolled') {
      g.save(); g.beginPath(); g.rect(r.x, V(sleeveTo), r.w, r.h); g.clip();
      gradV(g, r.x, V(sleeveTo), r.w, r.h * sleeveTo, [[0, skin.light], [0.5, skin.base], [1, skin.shadow]]);
      for (let i = 0; i < 40; i++) { const x = U(rnd()), y = V(0.22 + rnd() * 0.3); stroke(g, [[x, y], [x + 1.5, y + 3]], 0.8, 0.4, shadowOf(S.look.hairColor, 0.1), 0.25); }
      g.restore();
      band(g, r, sleeveTo - 0.01, sleeveTo + 0.05, lightOf(c, 0.15), 1);
      hstitch(g, r, sleeveTo + 0.01, shadowOf(c, 0.4), 0.6);
      bandGrad(g, r, sleeveTo - 0.04, sleeveTo, rgba(INK, 0.0), rgba(INK, 0.4));
    } else if (S.arms === 'sleeve') {
      // leather bracer with laces
      g.save(); g.beginPath(); g.rect(r.x, V(0.535), r.w, r.h * 0.19); g.clip();
      leather(g, r, r.x, V(0.535), r.w, r.h * 0.19, LEATHER_D, rnd, { creases: 4, scuffs: 6, wrap: true });
      for (let k = 0; k < 4; k++) { const y = V(0.39 + k * 0.035); stroke(g, [[U(0.2), y], [U(0.3), y - 4]], 1.3, 1.3, '#c9a878', 0.8); stroke(g, [[U(0.3), y], [U(0.2), y - 4]], 1.3, 1.3, '#c9a878', 0.8); }
      g.restore();
      hstitch(g, r, 0.525, '#c9a878', 0.5);
    }
    // gloves or bare hands
    if (S.hands === 'bare') {
      g.save(); g.beginPath(); g.rect(r.x, V(0.2), r.w, r.h * 0.2); g.clip();
      gradV(g, r.x, V(0.2), r.w, r.h * 0.2, [[0, skin.base], [1, skin.shadow]]);
      g.restore();
      if (S.arms === 'shirt') { band(g, r, 0.2, 0.245, '#efe6d2', 1); rivet(g, U(0.25), V(0.222), 1.8, '#c8c8d0'); bandGrad(g, r, 0.18, 0.2, rgba(INK, 0), rgba(INK, 0.35)); }
      for (const u of [0.66, 0.75, 0.84]) stroke(g, [[U(u), V(0.0)], [U(u), V(0.075)]], 1.4, 0.8, skin.deep, 0.6);
      for (const u of [0.16, 0.25, 0.34]) stroke(g, [[U(u), V(0.0)], [U(u), V(0.06)]], 1.2, 0.6, skin.deep, 0.5);
      for (const u of [0.7, 0.79]) blob(g, U(u), V(0.1), 3, 2, 0, skin.light, 0.5, 0.3);
      for (const u of [0.64, 0.72, 0.8, 0.88]) blob(g, U(u), V(0.02), 2.4, 1.6, 0, mix(skin.light, '#f0d0c0', 0.4), 0.55, 0.4);   // nails
    } else {
      const gl = S.hands === 'workglove' ? '#a8834f' : '#7a5232';
      const cuffC = S.hands === 'workglove' ? '#6b4a2c' : SUEDE;
      g.save(); g.beginPath(); g.rect(r.x, V(0.2), r.w, r.h * 0.2); g.clip();
      leather(g, r, r.x, V(0.2), r.w, r.h * 0.2, gl, rnd, { creases: 6, scuffs: 8, wrap: true });
      for (const u of [0.66, 0.75, 0.84]) fold(g, [[U(u), V(0.0)], [U(u), V(0.085)]], 1.8, gl, 0.6);
      for (const u of [0.16, 0.25, 0.34]) fold(g, [[U(u), V(0.0)], [U(u), V(0.07)]], 1.6, gl, 0.5);
      for (const u of [0.66, 0.74, 0.82, 0.9]) blob(g, U(u), V(0.105), 3.2, 2.2, 0, lightOf(gl, 0.45), 0.6, 0.3);   // knuckles
      blob(g, U(0.25), V(0.12), 10, 6, 0, shadowOf(gl, 0.4), 0.4, 0.2);       // palm
      stitches(g, [[U(0.52), V(0.03)], [U(0.55), V(0.16)]], INK, 0.45);
      g.restore();
      // flared cuff
      g.save(); g.beginPath(); g.rect(r.x, V(0.36), r.w, r.h * 0.16); g.clip();
      leather(g, r, r.x, V(0.36), r.w, r.h * 0.16, cuffC, rnd, { creases: 4, scuffs: 8, wrap: true });
      g.restore();
      if (S.hands === 'glove') { trimH(g, r.x, r.x + r.w, V(0.345), r.h * 0.022, c, shadowOf(c, 0.5)); }
      hstitch(g, r, 0.315, '#e8d0a0', 0.5);
      band(g, r, 0.345, 0.365, shadowOf(cuffC, 0.6), 1);       // inside of the flare
      bandGrad(g, r, 0.2, 0.235, rgba(INK, 0), rgba(INK, 0.45)); // wrist crease
      bandGrad(g, r, 0.365, 0.4, rgba(INK, 0.5), rgba(INK, 0));
    }
    // shoulder top in shade (under pauldron) and armpit side (inner = u .25)
    bandGrad(g, r, 0.88, 1.0, rgba(INK, 0), rgba(INK, S.pauldrons !== 'none' ? 0.55 : 0.2));
    blob(g, U(0.25), V(0.8), r.w * 0.14, r.h * 0.18, 0, INK, 0.25, 0.1);
  });
}

function paintLeg(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    const pants = S.legs === 'trousers' ? '#5c4836' : S.legs === 'wool' ? '#4c4a52' : S.legs === 'black' ? '#28252c' : S.color;
    cloth(g, r, r.x, r.y, r.w, r.h, pants, rnd, { folds: 10, foldAngle: 0, foldLen: [0.05, 0.15], wrap: true });
    for (let i = 0; i < 4; i++) fold(g, curve(U(0.85 + rnd() * 0.3 - 0.15), V(0.58 + rnd() * 0.05), U(0.1 + rnd() * 0.2), V(0.58 + rnd() * 0.05), 3), 2.6, pants, 0.4);  // back of knee
    for (const u of [0.25, 0.75]) stitches(g, [[U(u), V(0.5)], [U(u), V(1)]], S.legs === 'overalls' ? '#e0c890' : INK, 0.5);
    if (S.legs === 'trousers') {
      // knee patch
      g.save(); g.beginPath(); g.roundRect(U(0.4), V(0.68), r.w * 0.2, r.h * 0.11, 3); g.clip();
      leather(g, r, U(0.4), V(0.68), r.w * 0.2, r.h * 0.11, '#7a5a3c', rnd, { creases: 2, scuffs: 4 });
      g.restore();
      stitches(g, [[U(0.4), V(0.68)], [U(0.6), V(0.68)], [U(0.6), V(0.57)], [U(0.4), V(0.57)], [U(0.4), V(0.68)]], INK, 0.55);
    }
    bandGrad(g, r, 0.88, 1.0, rgba(INK, 0), rgba(INK, 0.6));
    blob(g, U(0.25), V(0.85), r.w * 0.12, r.h * 0.15, 0, INK, 0.25, 0.1);   // inner thigh
    // boots
    const boot = S.outfit === 'repo' ? '#33261f' : S.boots === 'shoe' ? '#2d2428' : LEATHER_D;
    const top = S.boots === 'tall' ? 0.43 : S.boots === 'short' ? 0.3 : 0.16;
    g.save(); g.beginPath(); g.rect(r.x, V(top), r.w, r.h * top); g.clip();
    leather(g, r, r.x, V(top), r.w, r.h * top, boot, rnd, { creases: 8, scuffs: 10, wrap: true, light: 0.35 });
    for (let i = 0; i < 5; i++) fold(g, curve(U(0.35 + rnd() * 0.3), V(0.1 + rnd() * 0.05), U(0.35 + rnd() * 0.3), V(0.13 + rnd() * 0.06), 2), 2, boot, 0.5);  // ankle creases
    g.restore();
    bandGrad(g, r, top, top + 0.03, rgba(INK, 0.0), rgba(INK, 0.35));
    if (S.boots === 'tall') {
      // folded suede cuff + strap
      const cuff = S.outfit === 'repo' ? '#4a3a2e' : SUEDE;
      g.save(); g.beginPath(); g.rect(r.x, V(0.555), r.w, r.h * 0.125); g.clip();
      leather(g, r, r.x, V(0.555), r.w, r.h * 0.125, cuff, rnd, { creases: 3, scuffs: 6, wrap: true });
      g.restore();
      band(g, r, 0.54, 0.56, shadowOf(cuff, 0.6), 1);
      hstitch(g, r, 0.535, '#e8d0a0', 0.45);
      bandGrad(g, r, 0.41, 0.43, rgba(INK, 0.0), rgba(INK, 0.55));
      band(g, r, 0.23, 0.27, '#3a261a', 1); hstitch(g, r, 0.25, '#c8a070', 0.4);
      buckle(g, U(0.75), V(0.25), 6, 7);
    }
    bandGrad(g, r, 0.0, 0.08, rgba(INK, 0.4), rgba(INK, 0));
  });
}

function paintFoot(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  const boot = S.outfit === 'repo' ? '#33261f' : S.boots === 'shoe' ? '#2d2428' : LEATHER_D;
  clip(g, r, () => {
    leather(g, r, r.x, r.y, r.w, r.h, boot, rnd, { creases: 6, scuffs: 10, light: 0.3, wrap: true });
    // toe cap highlight, heel shade
    blob(g, U(0.5), V(0.85), r.w * 0.3, r.h * 0.12, 0, S.outfit === 'repo' ? '#9a9aa2' : lightOf(boot, 0.5), S.outfit === 'repo' ? 0.55 : 0.4, 0.2);
    if (S.boots === 'shoe') blob(g, U(0.42), V(0.8), r.w * 0.08, r.h * 0.05, 0, '#fff0d0', 0.45, 0.3);
    blob(g, U(0.5), V(0.08), r.w * 0.35, r.h * 0.1, 0, INK, 0.3, 0.2);
    // laces across the instep
    if (S.boots !== 'tall') for (let k = 0; k < 3; k++) { const y = V(0.42 + k * 0.08); stroke(g, [[U(0.42), y], [U(0.58), y - 4]], 1.3, 1.3, '#b8a080', 0.8); stroke(g, [[U(0.58), y], [U(0.42), y - 4]], 1.3, 1.3, '#b8a080', 0.8); }
    else { band(g, r, 0.35, 0.42, '#3a261a', 0.9); buckle(g, U(0.5), V(0.385), 5, 6); }
    // sole: dark band round the bottom with a lit welt
    g.save(); g.fillStyle = '#2b1e18';
    g.fillRect(r.x, r.y, r.w * 0.13, r.h); g.fillRect(RX(r, 0.87), r.y, r.w * 0.13 + 1, r.h);
    g.globalAlpha = 0.7; g.fillStyle = '#8a6a48'; g.fillRect(RX(r, 0.13), r.y, 1.5, r.h); g.fillRect(RX(r, 0.87) - 1.5, r.y, 1.5, r.h);
    g.restore();
    stitches(g, [[U(0.16), V(0)], [U(0.16), V(1)]], '#c8a878', 0.45, 2, 2);
    stitches(g, [[U(0.84), V(0)], [U(0.84), V(1)]], '#c8a878', 0.45, 2, 2);
  });
}

function paintPauldron(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  const repo = S.outfit === 'repo';
  const base = repo ? '#5d5a5e' : '#7c5434';
  clip(g, r, () => {
    if (repo) {
      gradV(g, r.x, r.y, r.w, r.h, [[0, lightOf(base, 0.45)], [0.5, base], [1, shadowOf(base, 0.4)]]);
      for (let i = 0; i < 10; i++) wblob(g, r, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 6, 18), range(rnd, 4, 10), rnd() * 3, pick(rnd, ['#8a5a3a', '#3a3640', '#a0a0a8']), 0.28, 0.2);   // rust & wear
      for (let i = 0; i < 14; i++) { const x = U(rnd()), y = V(rnd()); stroke(g, [[x, y], [x + range(rnd, -6, 6), y + range(rnd, -3, 3)]], 0.8, 0.3, '#e8e4ec', 0.4); }
    } else leather(g, r, r.x, r.y, r.w, r.h, base, rnd, { creases: 6, scuffs: 14, light: 0.4, wrap: true });
    // dome highlight on top
    bandGrad(g, r, 0.72, 1.0, rgba('#fff0c8', 0.0), rgba('#fff0c8', 0.35));
    // rim: player-color trim (or plain iron) with gold piping
    if (!repo) {
      band(g, r, 0.32, 0.42, S.color, 1);
      bandGrad(g, r, 0.32, 0.42, rgba('#fff0c8', 0.3), rgba(INK, 0.3));
      band(g, r, 0.415, 0.435, TRIM, 1); band(g, r, 0.31, 0.325, TRIM, 1);
    } else {
      band(g, r, 0.32, 0.4, shadowOf(base, 0.2), 1); band(g, r, 0.4, 0.415, lightOf(base, 0.6), 0.8);
    }
    for (let k = 0; k < 9; k++) rivet(g, U((k + 0.5) / 9), V(0.52), repo ? 3.4 : 2.6, repo ? '#9c9aa0' : BRASS);
    // lower lame
    bandGrad(g, r, 0.0, 0.28, rgba(INK, 0.35), rgba(INK, 0.05));
    if (!repo) band(g, r, 0.02, 0.07, S.color, 0.9);
    for (let k = 0; k < 7; k++) rivet(g, U((k + 0.3) / 7), V(0.16), 2, repo ? '#9c9aa0' : BRASS);
    band(g, r, 0.285, 0.31, INK, 0.5);
  });
}

function paintBelt(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    // top half: belt strap
    g.save(); g.beginPath(); g.rect(r.x, r.y, r.w, r.h * 0.5); g.clip();
    const strap = S.outfit === 'dealer' ? '#1e1a20' : '#3c2618';
    leather(g, r, r.x, r.y, r.w, r.h * 0.5, strap, rnd, { creases: 5, scuffs: 10, wrap: true });
    stitches(g, [[r.x, V(0.92)], [r.x + r.w, V(0.92)]], '#d2b483', 0.55);
    stitches(g, [[r.x, V(0.58)], [r.x + r.w, V(0.58)]], '#d2b483', 0.55);
    if (S.outfit === 'player') for (let k = 0; k < 7; k++) rivet(g, U((k + 0.5) / 7 + 0.03), V(0.75), 2.2);
    bandGrad(g, r, 0.5, 0.58, rgba(INK, 0.45), rgba(INK, 0));
    g.restore();
    // bottom half: the pouch
    g.save(); g.beginPath(); g.rect(r.x, V(0.48), r.w, r.h * 0.48); g.clip();
    leather(g, r, r.x, V(0.48), r.w, r.h * 0.48, '#7a5434', rnd, { creases: 6, scuffs: 8, wrap: true });
    band(g, r, 0.3, 0.48, '#5e3e26', 1);
    bandGrad(g, r, 0.25, 0.3, rgba(INK, 0), rgba(INK, 0.5));
    rivet(g, U(0.5), V(0.33), 3);
    g.restore();
  });
}

function paintHairRegion(g, r, S, rnd, flowDown = true) {
  const hc = S.look.hairColor;
  clip(g, r, () => {
    hair(g, r, r.x, r.y, r.w, r.h, hc, rnd, { count: 120, len: [0.25, 0.6], sheen: 0.32, wrap: true });
    bandGrad(g, r, 0.0, 0.12, rgba(INK, 0.4), rgba(INK, 0));
  });
}
function paintBeardRegion(g, r, S, rnd) {
  const hc = S.look.hairColor;
  clip(g, r, () => {
    hair(g, r, r.x, r.y, r.w, r.h, hc, rnd, { count: 70, len: [0.15, 0.4], sheen: 0.3, wrap: true, width: [2, 4] });
    if (S.look.hair === 'braid') for (let k = 0; k < 9; k++) {   // braid lobes
      const y = r.y + (k + 0.5) / 9 * r.h;
      fold(g, curve(r.x, y - 4, r.x + r.w, y + 4, 0, 3), 3, hc, 0.6);
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
    for (let k = 0; k < 10; k++) { const y = r.y + r.h * (0.3 + k * 0.07); fold(g, curve(r.x, y, r.x + r.w, y + 2, 1, 3), 1.8, '#c8b48a', 0.5); }
    for (let i = 0; i < 6; i++) blob(g, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 4, 10), 3, 0, '#8a7458', 0.2, 0.2);
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

// The accessory region: the hat (crown v .5-1, brim v 0-.45), Ed's apron, the visor.
function paintAcc(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v), c = S.color;
  const crown = { x: r.x, y: r.y, w: r.w, h: r.h * 0.5 }, brim = { x: r.x, y: r.y + r.h * 0.52, w: r.w, h: r.h * 0.48 };
  clip(g, r, () => {
    const h = S.hat;
    if (S.apron) {
      leather(g, r, r.x, r.y, r.w, r.h, '#8a6440', rnd, { creases: 12, scuffs: 18 });
      for (let i = 0; i < 5; i++) blob(g, U(0.2 + rnd() * 0.6), V(0.2 + rnd() * 0.6), range(rnd, 6, 14), range(rnd, 5, 10), rnd() * 3, '#4a3a2a', 0.3, 0.3);   // stains
      g.save(); g.fillStyle = '#7a5636'; g.fillRect(U(0.35), V(0.62), r.w * 0.3, r.h * 0.14); g.restore();
      stitches(g, [[U(0.35), V(0.62)], [U(0.35), V(0.48)], [U(0.65), V(0.48)], [U(0.65), V(0.62)]], '#e8d0a0', 0.6);
      stroke(g, [[U(0.55), V(0.66)], [U(0.6), V(0.5)]], 3, 3, '#c8a040', 1);    // pencil in the pocket
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
      bandGrad(g, r, 0.62, 0.7, rgba(INK, 0.35), rgba(INK, 0));
      stitches(g, [[r.x, V(0.06)], [r.x + r.w, V(0.06)]], '#d8b88a', 0.5);
      bandGrad(g, r, 0.88, 1.0, rgba('#fff0c8', 0), rgba('#fff0c8', 0.25));
    } else if (h === 'straw') {
      gradV(g, r.x, r.y, r.w, r.h, [[0, '#e6c97e'], [0.5, '#c9a255'], [1, '#9c7a3c']]);
      // plaited straw: rows of slanted braid lobes, each lit on top, with dark gaps between rows
      const rowH = 6.5;
      for (let row = 0, yy = r.y; yy < r.y + r.h; yy += rowH, row++) {
        g.save(); g.globalAlpha = 0.55; g.fillStyle = '#6a4a22'; g.fillRect(r.x, yy + rowH - 1.4, r.w, 1.4); g.restore();
        const dir = row % 2 ? 1 : -1;
        for (let xx = r.x - 4 + rnd() * 3; xx < r.x + r.w + 4; xx += 4.2) {
          const c = pick(rnd, ['#e8cc80', '#d8b466', '#c9a254', '#efd894']);
          stroke(g, [[xx, yy + 0.8], [xx + dir * 3.2, yy + rowH - 1.8]], 3.4, 2.4, c, 0.9);
          stroke(g, [[xx - 0.6, yy + 1.2], [xx + dir * 2.2 - 0.6, yy + rowH * 0.5]], 1, 0.6, '#fff0bc', 0.5);
        }
      }
      for (let i = 0; i < 10; i++) blob(g, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 10, 26), range(rnd, 6, 14), 0, pick(rnd, ['#8a6a34', '#f0d890']), 0.18, 0.1);
      band(g, r, 0.5, 0.6, c, 1); bandGrad(g, r, 0.5, 0.6, rgba('#fff0c8', 0.3), rgba(INK, 0.3));
      for (let i = 0; i < 20; i++) { const x = U(rnd()); stroke(g, [[x, V(0.02)], [x + range(rnd, -3, 3), V(-0.05)]], 1.2, 0.5, '#7a5a2a', 0.6); }
      bandGrad(g, r, 0, 0.12, rgba(INK, 0.35), rgba(INK, 0));
    } else if (h === 'bandana' || h === 'hood' || h === 'cap') {
      const cc = h === 'bandana' ? mix(c, '#7a2a24', 0.4) : h === 'hood' ? shadowOf(c, 0.2) : c;
      cloth(g, r, r.x, r.y, r.w, r.h, cc, rnd, { folds: 14, light: 0.35, wrap: true });
      if (h === 'bandana') for (let i = 0; i < 46; i++) { const x = r.x + rnd() * r.w, y = r.y + rnd() * r.h; ellipse(g, x, y, 1.8, 1.8, 0, '#efe3c8', 0.7); }
      if (h === 'hood') { trimH(g, r.x, r.x + r.w, V(0.06), r.h * 0.05); trimH(g, r.x, r.x + r.w, V(0.56), r.h * 0.04); }
      if (h === 'cap') {
        for (let k = 0; k < 6; k++) stitches(g, [[U(k / 6), V(0.52)], [U(k / 6 + 0.02), V(1)]], shadowOf(c, 0.5), 0.6);
        g.save(); g.beginPath(); g.rect(brim.x, brim.y, brim.w, brim.h); g.clip();
        leather(g, r, brim.x, brim.y, brim.w, brim.h, '#5a3c26', rnd, { creases: 6, scuffs: 10 });
        stitches(g, [[r.x, V(0.12)], [r.x + r.w, V(0.12)]], '#d8b88a', 0.6);
        stitches(g, [[r.x, V(0.2)], [r.x + r.w, V(0.2)]], '#d8b88a', 0.6);
        g.restore();
        rivet(g, U(0.5), V(0.97), 3);
        band(g, r, 0.5, 0.56, shadowOf(c, 0.3), 1);
      }
    } else if (h === 'helm') {
      gradV(g, r.x, r.y, r.w, r.h, [[0, '#d0d4dc'], [0.4, '#8a8e98'], [1, '#4a4c56']]);
      for (let i = 0; i < 14; i++) wblob(g, r, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 6, 18), range(rnd, 4, 10), rnd() * 3, pick(rnd, ['#6a5a52', '#a8acb6', '#5a5c66']), 0.3, 0.2);
      for (let i = 0; i < 30; i++) { const x = U(rnd()), y = V(rnd()); stroke(g, [[x, y], [x + range(rnd, -7, 7), y + range(rnd, -2, 2)]], 0.8, 0.3, '#f0f2f8', 0.4); }
      for (let k = 0; k < 4; k++) { const u = (k + 0.5) / 4; stroke(g, [[U(u), V(0.5)], [U(u), V(1)]], 5, 3, '#5a5c66', 0.6); stroke(g, [[U(u) - 2, V(0.5)], [U(u) - 2, V(1)]], 1.5, 1, '#e8eaf0', 0.5); }
      band(g, r, 0.42, 0.5, '#7a5a3c', 1);   // leather-backed rim
      band(g, r, 0.0, 0.42, '#6a6c76', 1);
      bandGrad(g, r, 0.0, 0.42, rgba('#ffffff', 0.25), rgba(INK, 0.35));
      for (let k = 0; k < 12; k++) rivet(g, U((k + 0.5) / 12), V(0.22), 3, '#c8ccd4');
      bandGrad(g, r, 0.85, 1, rgba('#ffffff', 0), rgba('#ffffff', 0.25));
    } else if (h === 'visor') {
      gradV(g, r.x, r.y, r.w, r.h, [[0, '#7ac08a'], [0.5, '#3a8a5a'], [1, '#1e5a3a']]);
      for (let i = 0; i < 6; i++) blob(g, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 10, 30), range(rnd, 5, 10), 0, '#c8f0c8', 0.18, 0.2);
      band(g, r, 0.5, 1, '#2a2632', 1); hstitch(g, r, 0.75, '#8a8090', 0.5);
      stitches(g, [[r.x, V(0.06)], [r.x + r.w, V(0.06)]], '#1a3a24', 0.5);
    } else if (h === 'beanie') {
      const kc = '#3a3a44';
      gradV(g, r.x, r.y, r.w, r.h, [[0, lightOf(kc, 0.25)], [0.5, kc], [1, shadowOf(kc, 0.3)]]);
      for (let x = r.x; x < r.x + r.w; x += 5) { stroke(g, [[x, r.y], [x, r.y + r.h]], 2.2, 2.2, shadowOf(kc, 0.4), 0.45); stroke(g, [[x + 2.5, r.y], [x + 2.5, r.y + r.h]], 1.4, 1.4, lightOf(kc, 0.3), 0.35); }
      for (let yy = r.y; yy < r.y + r.h; yy += 4) { g.save(); g.globalAlpha = 0.12; g.fillStyle = INK; g.fillRect(r.x, yy, r.w, 1); g.restore(); }
      band(g, r, 0.0, 0.3, mix(kc, '#5a4a3a', 0.2), 0.35);
      bandGrad(g, r, 0.28, 0.32, rgba(INK, 0.5), rgba(INK, 0));
    } else {
      fill0(g, r, '#5a4030');
    }
  });
}
function fill0(g, r, c) { g.fillStyle = c; g.fillRect(r.x, r.y, r.w, r.h); }

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
  paintPauldron(g, REG.paul, S, rnd);
  paintBelt(g, REG.belt, S, rnd);
  paintHairRegion(g, REG.hair, S, rnd);
  paintAcc(g, REG.acc, S, rnd);
  paintHorn(g, REG.horn, rnd);
  paintMetal(g, REG.metal, rnd);
  // painterly softening + a warm unifying glaze, then bleed edges for mipmaps
  for (const k of ['torso', 'arm', 'leg', 'foot', 'paul', 'belt', 'acc', 'hair', 'beard']) soften(cv, REG[k], 0.55);
  soften(cv, REG.head, 0.35);
  g.save(); g.globalCompositeOperation = 'soft-light'; g.globalAlpha = 0.12; g.fillStyle = '#ffd9a0'; g.fillRect(0, 0, AW, AH); g.restore();
  for (const r of Object.values(REG)) bleed(g, cv, r, 2);
}

export function charAtlas(spec) {
  const name = `chr_${spec.key}`;
  if (!has(name)) register(name, { family: 'characters-live', size: AW, note: spec.outfit, paint: (g, s, rnd, h, cv) => paintAtlas(g, s, rnd, cv, spec) });
  return name;
}
// emissive map: black, with the eyes glowing (the Dealer's red eyes)
export function charGlow(spec) {
  if (!spec.eyeGlow) return null;
  const name = `chrglow_${spec.key}`;
  if (!has(name)) register(name, {
    family: 'characters-live', size: AW, note: 'glow',
    paint(g, s) {
      fill0(g, { x: 0, y: 0, w: AW, h: AH }, '#000000');
      const r = REG.head, X = du => r.x + (0.5 + du) * r.w, Y = v => r.y + (1 - v) * r.h;
      for (const sd of [-1, 1]) {
        blob(g, X(sd * EYE_U), Y(headV(0.025)), 16, 9, 0, spec.eyeGlow, 0.5, 0.2);
        blob(g, X(sd * EYE_U + sd * 0.003), Y(headV(0.025)), 6, 5, 0, '#ffd0b0', 0.9, 0.4);
      }
    },
  });
  return name;
}

// ---- first-person hands (256×256): sleeve, bracer, flared cuff, glove, fingers, thumb ----
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
    cloth(g, r, r.x, r.y, r.w, r.h, c, rnd, { folds: 10, foldAngle: Math.PI / 2, foldLen: [0.15, 0.4], wrap: true });
    trimH(g, r.x, r.x + r.w, RY(r, 0.08), r.h * 0.07);
  });
  clip(g, FP.bracer, () => {
    const r = FP.bracer;
    leather(g, r, r.x, r.y, r.w, r.h, LEATHER_D, rnd, { creases: 6, scuffs: 12, wrap: true });
    for (let k = 0; k < 4; k++) { const x = RX(r, 0.2 + k * 0.2); stroke(g, [[x - 4, RY(r, 0.3)], [x + 4, RY(r, 0.7)]], 2, 2, '#c9a878', 0.85); stroke(g, [[x + 4, RY(r, 0.3)], [x - 4, RY(r, 0.7)]], 2, 2, '#c9a878', 0.85); }
    hstitch(g, r, 0.1, '#c9a878', 0.55); hstitch(g, r, 0.9, '#c9a878', 0.55);
  });
  clip(g, FP.cuff, () => {
    const r = FP.cuff;
    leather(g, r, r.x, r.y, r.w, r.h, SUEDE, rnd, { creases: 6, scuffs: 12, wrap: true });
    trimH(g, r.x, r.x + r.w, RY(r, 0.95), r.h * 0.13, c, shadowOf(c, 0.5));
    hstitch(g, r, 0.72, '#e8d0a0', 0.6);
    for (let k = 0; k < 6; k++) rivet(g, RX(r, (k + 0.5) / 6), RY(r, 0.45), 2.6);
    bandGrad(g, r, 0, 0.2, rgba(INK, 0.45), rgba(INK, 0));
  });
  clip(g, FP.palm, () => {
    const r = FP.palm;
    leather(g, r, r.x, r.y, r.w, r.h, GL, rnd, { creases: 10, scuffs: 16, light: 0.35, wrap: true });
    // back of the hand (u ~ .5): a stitched leather plate with rivets, knuckle highlights at the far end
    g.save(); g.beginPath(); g.roundRect(RX(r, 0.32), RY(r, 0.8), r.w * 0.36, r.h * 0.6, 8); g.clip();
    leather(g, r, RX(r, 0.32), RY(r, 0.8), r.w * 0.36, r.h * 0.6, shadowOf(GL, 0.15), rnd, { creases: 4, scuffs: 8 });
    g.restore();
    stitches(g, [[RX(r, 0.33), RY(r, 0.79)], [RX(r, 0.33), RY(r, 0.21)], [RX(r, 0.67), RY(r, 0.21)], [RX(r, 0.67), RY(r, 0.79)], [RX(r, 0.33), RY(r, 0.79)]], '#e2c898', 0.6);
    for (const [u, v] of [[0.38, 0.72], [0.62, 0.72], [0.38, 0.28], [0.62, 0.28]]) rivet(g, RX(r, u), RY(r, v), 2.6);
    for (const u of [0.38, 0.46, 0.54, 0.62]) blob(g, RX(r, u), RY(r, 0.9), 6, 4, 0, lightOf(GL, 0.5), 0.55, 0.25);
    blob(g, RX(r, 0.0), RY(r, 0.5), r.w * 0.2, r.h * 0.4, 0, INK, 0.35, 0.1);   // palm side in shade
    blob(g, RX(r, 1.0), RY(r, 0.5), r.w * 0.2, r.h * 0.4, 0, INK, 0.35, 0.1);
    bandGrad(g, r, 0, 0.1, rgba(INK, 0.4), rgba(INK, 0));
  });
  for (const k of ['finger', 'thumb']) clip(g, FP[k], () => {
    const r = FP[k];
    leather(g, r, r.x, r.y, r.w, r.h, GL, rnd, { creases: 8, scuffs: 10, light: 0.35, wrap: true });
    for (const v of [0.35, 0.65]) { const y = RY(r, v); fold(g, curve(RX(r, 0.3), y, RX(r, 0.7), y, 2, 3), 2, GL, 0.55); }
    blob(g, RX(r, 0.5), RY(r, 0.5), r.w * 0.15, r.h * 0.5, 0, lightOf(GL, 0.35), 0.3, 0.2);
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
    family: 'characters', w: 512, h: 176, note: `skin tone ${i} + face (head region)`,
    paint(g, s, rnd) { paintHead(g, { x: 0, y: 0, w: 512, h: 176 }, resolveSpec('#7CFC00', { skinIndex: i, hatIndex: i }), rnd); },
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
  register(name, { family: 'characters', size: AW, note: 'atlas (not tiled)', paint: (g, s, rnd, h, cv) => paintAtlas(g, s, rnd, cv, resolveSpec(col, o)) });
}
register('fp_hands', { family: 'characters', size: 256, note: 'first-person gloves', paint: (g, s, rnd, h, cv) => paintHands(g, s, rnd, cv, '#00E5FF') });
