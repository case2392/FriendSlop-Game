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
  register, has, blob, ellipse, stroke as rawStroke, mix, shade, shadowOf, lightOf, hex, toHex, range, pick, makeCanvas, rgba,
} from './core.js';

// core's stroke() fills each segment separately, so a translucent stroke beads where the
// segments overlap. Translucent strokes here are drawn opaque on a scratch canvas and then
// laid down once at the wanted alpha.
let SCRATCH = null;
function stroke(g, pts, w0, w1, color, alpha = 1) {
  if (alpha >= 0.97) return rawStroke(g, pts, w0, w1, color, alpha);
  const pad = Math.max(w0, w1) / 2 + 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = Math.floor(x0 - pad); y0 = Math.floor(y0 - pad);
  const W = Math.ceil(x1 + pad) - x0, H = Math.ceil(y1 + pad) - y0;
  if (!(W > 0 && H > 0)) return;
  if (!SCRATCH || SCRATCH.width < W || SCRATCH.height < H) SCRATCH = makeCanvas(Math.max(W, SCRATCH?.width || 0), Math.max(H, SCRATCH?.height || 0));
  const sg = SCRATCH.getContext('2d');
  sg.setTransform(1, 0, 0, 1, 0, 0); sg.clearRect(0, 0, W, H); sg.translate(-x0, -y0);
  rawStroke(sg, pts, w0, w1, color, 1);
  g.save(); g.globalAlpha *= alpha; g.drawImage(SCRATCH, 0, 0, W, H, x0, y0, W, H); g.restore();
}

export const AW = 512, AH = 768;
export const REG = {
  head:  { x: 0,   y: 0,   w: 512, h: 256 },    // u around the head (see headU: the face gets ~55% of it)
  torso: { x: 0,   y: 260, w: 256, h: 200 },
  arm:   { x: 260, y: 260, w: 92,  h: 200 },
  leg:   { x: 356, y: 260, w: 92,  h: 200 },
  foot:  { x: 452, y: 260, w: 60,  h: 96 },
  beard: { x: 452, y: 360, w: 60,  h: 100 },
  skirt: { x: 0,   y: 464, w: 256, h: 96 },     // four panels side by side: front, right, back, left
  flap:  { x: 260, y: 464, w: 64,  h: 112 },    // tabard flap, front
  flapB: { x: 328, y: 464, w: 64,  h: 112 },    // tabard flap, back
  ear:   { x: 396, y: 464, w: 52,  h: 24 },
  horn:  { x: 396, y: 492, w: 52,  h: 84 },
  metal: { x: 452, y: 464, w: 60,  h: 60 },     // top half brass, bottom half iron
  collar:{ x: 452, y: 528, w: 60,  h: 48 },
  paul:  { x: 0,   y: 564, w: 128, h: 64 },
  belt:  { x: 0,   y: 632, w: 128, h: 68 },
  hair:  { x: 132, y: 580, w: 124, h: 120 },
  acc:   { x: 260, y: 580, w: 192, h: 120 },    // hat: crown v .52-1, brim v 0-.45
  gear:  { x: 456, y: 580, w: 56,  h: 120 },    // NPC extras: shades (top), chain links (bottom)
  pack:  { x: 0,   y: 704, w: 256, h: 64 },     // bedroll + straps (players)
  apron: { x: 260, y: 704, w: 252, h: 64 },     // Ed's apron, the Repo Man's bib, the hood's capelet
};

// The head: HEAD_RINGS (below) scaled by HEAD_SCALE. WoW humans carry a big head.
export const HEAD_SCALE = 1.24;
const TAU = Math.PI * 2;
// Texture u around the head is not linear in the angle: the face (the front ±1.2 rad)
// gets about 55% of the 512 px, the back of the head (under the hair) the rest.
// th = 0 is the front (+x), th > 0 the character's right (+z); u .5 = the front.
export const HEAD_B = 0.55;
export const headU = th => 0.5 - (th + HEAD_B * Math.sin(th)) / TAU;
export function headTh(u) {
  const f = (0.5 - u) * TAU;
  let th = f / (1 + HEAD_B);
  for (let k = 0; k < 10; k++) th -= (th + HEAD_B * Math.sin(th) - f) / (1 + HEAD_B * Math.cos(th));
  return Math.max(-Math.PI, Math.min(Math.PI, th));
}

// Head lathe, shared with people.js: [dy above the head origin (m, before HEAD_SCALE),
// half-width (z), front depth, back depth, squareness, center x offset, texture v].
// A broad brow, a square jaw that narrows under the chin into a thick neck. The v
// column runs linearly (4.07 per unit dy) from the chin to the brow so the face paints
// in even centimeters; people.js adds the nose, brow ridge, sockets and cheekbones.
export const HEAD_RINGS = [
  [-0.150, 0.066, 0.060, 0.066, 2.0, -0.016, 0.0],
  [-0.125, 0.064, 0.060, 0.064, 2.0, -0.015, 0.035],
  [-0.106, 0.062, 0.066, 0.064, 2.2, -0.010, 0.07],
  [-0.096, 0.060, 0.084, 0.066, 2.6, -0.004, 0.095],
  [-0.088, 0.058, 0.100, 0.068, 3.0, 0.000, 0.12],
  [-0.075, 0.065, 0.105, 0.076, 2.8, 0.000, 0.173],
  [-0.060, 0.073, 0.106, 0.082, 2.6, 0.000, 0.234],
  [-0.046, 0.079, 0.106, 0.087, 2.4, 0.000, 0.291],
  [-0.022, 0.084, 0.104, 0.093, 2.3, 0.000, 0.388],
  [0.000, 0.088, 0.102, 0.098, 2.2, 0.000, 0.478],
  [0.025, 0.091, 0.099, 0.101, 2.1, 0.000, 0.58],
  [0.046, 0.093, 0.103, 0.102, 2.1, 0.000, 0.665],
  [0.080, 0.090, 0.094, 0.101, 2.0, -0.004, 0.785],
  [0.114, 0.076, 0.076, 0.090, 2.0, -0.008, 0.88],
  [0.141, 0.051, 0.048, 0.062, 2.0, -0.010, 0.955],
  [0.156, 0.000, 0.000, 0.000, 2.0, -0.010, 1.00],
];
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
// a soft irregular wave along the hairline (people.js uses it for the hair shell's edge too)
export const hairWave = (th, hair) => (hair === 'short' || hair === 'long' ? 0.005 * Math.sin(th * 7 + 1) + 0.003 * Math.sin(th * 13) : 0.002 * Math.sin(th * 9));
// Face painting space: x = cm along the face from the midline (+ = the character's
// left, as seen from the front: the viewer's right), y = cm above the eye line.
export const EYE_DY = 0.025;
const FACE_ARC = lerpTable(HEAD_RINGS, EYE_DY, 1) * HEAD_SCALE * 100;   // cm of face per radian at the front
export const faceUV = (x, y) => [headU(-x / FACE_ARC), headV(EYE_DY + y / (100 * HEAD_SCALE))];
export const EYE_X = 3.5;            // eye centers, cm from the midline
// A full beard's top edge: [|theta|, dy] (unscaled), from under the lower lip, past the
// mouth corners, up the cheeks to the sideburns. people.js models the beard sheet from it
// and maps the sheet's texture onto the face (faceUV), where paintHead paints the beard.
export const BEARD_TOP = [[0, -0.061], [0.2, -0.056], [0.32, -0.042], [0.55, -0.022], [0.85, -0.006], [1.15, 0.01], [1.42, 0.03]];
export const GOATEE_TOP = [[0, -0.058], [0.3, -0.054]];

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
  [1.41,  0.232, 0.140, 0.142, 2.6, 0.87],
  [1.45,  0.168, 0.106, 0.112, 2.3, 0.93],
  [1.48,  0.088, 0.078, 0.078, 2.0, 0.975],
  [1.495, 0.0,   0.0,   0.0,   2.0, 1.0],
];
export const TORSO_UP = TORSO.slice(3);           // monotonic in y
export const torsoV = y => lerpTable(TORSO_UP, y, 5);
// Arms: v runs linearly from the fingertips (0) to the top of the shoulder (1).
export const ARM_TOP = 0.075, ARM_TIP = -0.78;
export const armV = dy => (dy - ARM_TIP) / (ARM_TOP - ARM_TIP);
// (below the shoulder joint: the elbow, the sleeve's end, the gauntlet's rolled rim, the wrist, the knuckles)
export const ARM_LM = { elbow: -0.3, sleeve: -0.315, cuffTop: -0.448, cuffRim: -0.465, cuffBot: -0.5, wrist: -0.575, knuckle: -0.672 };
// Legs: v = height above the sole. The skirt: v from 0.56 m (0) to 1.02 m (1).
export const SKIRT_Y0 = 0.56, SKIRT_Y1 = 1.02;
export const skirtV = y => (y - SKIRT_Y0) / (SKIRT_Y1 - SKIRT_Y0);
// The clerk's long skirt (S.dress) uses the whole skirt region: u around, v from the hem (0) to the waist (1).
export const DRESS_Y0 = 0.1, DRESS_Y1 = 1.03;
export const dressV = y => (y - DRESS_Y0) / (DRESS_Y1 - DRESS_Y0);

// ---- who is who ---------------------------------------------------------------------

export const SKIN_TONES = ['#dfa47b', '#c98c5e', '#a6704a', '#81563c', '#ecbe9a', '#694431'];
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
  ed:     { torso: 'shirt', arms: 'rolled', hands: 'bare', legs: 'wool', boots: 'short', pauldrons: 'none', belt: false, apron: true, hat: 'none', bulk: 1.08, belly: 0.045, armBulk: 1.08, look: { hair: 'bald', hairColor: '#8a7c6c', facial: 'beard', beard: 1.3, female: false } },
  clerk:  { torso: 'bodice', arms: 'blouse', hands: 'bare', legs: 'wool', boots: 'shoe', pauldrons: 'none', belt: false, dress: true, hat: 'none', armBulk: 0.84, collar: false, look: { hair: 'bun', hairColor: '#8e3a1c', female: true, facial: 'none' } },
  dealer: { torso: 'vest', arms: 'shirt', hands: 'bare', legs: 'black', boots: 'shoe', pauldrons: 'none', belt: true, hat: 'visor', armBulk: 0.86, shoulderK: 1.08, collar: true, look: { hair: 'slick', hairColor: '#17121a', facial: 'pencil', female: false, stern: true } },
  repo:   { torso: 'overalls', arms: 'flannel', hands: 'workglove', legs: 'overalls', boots: 'work', pauldrons: 'none', belt: false, hat: 'beanie', bulk: 1.12, brute: true, belly: 0.06, armBulk: 1.0, forearm: 1.14, chain: true, bib: true, shades: true, look: { hair: 'buzz', hairColor: '#1d1716', facial: 'stubble', female: false, stern: true } },
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
// A player's neon UI color, toned down to a WoW tabard dye: deep and a little muted
// (neon pink → wine, cyan → deep teal, lime → kelly green, violet → royal violet,
// orange → burnt orange, yellow → ochre gold).
export function muted(c) {
  const { h, s } = hsl(c);
  if (h > 0.11 && h < 0.2) return fromHsl(0.115, Math.min(s, 0.6), 0.42);
  if (h <= 0.11 || h > 0.96) return fromHsl(h < 0.5 ? h * 0.72 : h, Math.min(s, 0.68), 0.38);
  if (h < 0.42) return fromHsl(h + 0.04, Math.min(s, 0.49), 0.32);
  if (h < 0.6) return fromHsl(h, Math.min(s, 0.6), 0.3);
  return fromHsl(h > 0.7 && h < 0.8 ? h - 0.018 : h, Math.min(s, 0.5), 0.32);
}
// ...a brighter dye of the same hue for small accents (cuff bands, the hood's lip) so the crew stays tellable apart
export function brightDye(c) { const { h, s } = hsl(c); return fromHsl(h, Math.min(s, 0.7), 0.48); }
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
  if (outfit === 'ed') { const q = hsl(c); c = fromHsl(q.h, Math.min(q.s, 0.42), 0.27); }
  const hat = O.hat || HATS[((hatIndex % 6) + 6) % 6];
  // players: steel pauldrons under a helm or cap, leather otherwise
  const paulMetal = outfit === 'player' && (hat === 'helm' || hat === 'cap' || hat === 'bandana');
  const spec = { ...O, outfit, color: c, bright: outfit === 'player' ? brightDye(color) : c, raw: color, skin, tone, look, hat, paulMetal, eyeGlow: eyeColor || null };
  spec.key = [outfit, c, skin, hat, eyeColor || '-'].join('_').replace(/#/g, '');
  return spec;
}

// ---- painting helpers ---------------------------------------------------------------

// (the game's sun is warm and bright: browns paint darker and cooler than they read on screen)
const LEATHER = '#5a3c26', LEATHER_D = '#3a2518', SUEDE = '#7a5636', TRIM = '#d6b46c', LINEN = '#ddcfb0', BRASS = '#b58c3c', IRON = '#7d8088';
const TROUSER = '#43362e';
const INK = '#24192a';    // the darkest thing we ever paint (soft violet-brown, not black)

const sstepJS = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
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
// A soft painted fold: a feathered crease (cool shadow) that swells in the middle and
// tapers at both ends, with a lit ridge beside it on the light (upper-left) side.
function sfold(g, pts, w, base, a = 0.5, { ridge = 0.8, dark = 0.55 } = {}) {
  const P = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.ceil(L / Math.max(1.2, w * 0.35)));
    for (let k = 0; k < n; k++) P.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n, Math.atan2(by - ay, bx - ax)]);
  }
  P.push([...pts[pts.length - 1], P.length ? P[P.length - 1][2] : 0]);
  const sh = mix(shadowOf(base, dark), '#3a2c4e', 0.18), li = lightOf(base, 0.5);
  P.forEach(([x, y, r], i) => { const t = i / Math.max(1, P.length - 1), k = Math.pow(Math.sin(Math.PI * Math.min(0.97, Math.max(0.03, t))), 0.7); blob(g, x, y, w * k * 0.62 + 0.4, w * k * 0.34 + 0.4, r, sh, a * 0.5, 0.25); });
  if (ridge > 0) P.forEach(([x, y, r], i) => { const t = i / Math.max(1, P.length - 1), k = Math.pow(Math.sin(Math.PI * Math.min(0.97, Math.max(0.03, t))), 1.2); blob(g, x - w * 0.55 * Math.abs(Math.sin(r)) - w * 0.2, y - w * 0.55 * Math.abs(Math.cos(r)) - w * 0.15, w * k * 0.42 + 0.3, w * k * 0.2 + 0.3, r, li, a * 0.44 * ridge, 0.3); });
}
function curve(x0, y0, x1, y1, bend, n = 5) {
  const pts = [];
  const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, nx = -dy / l, ny = dx / l;
  for (let k = 0; k <= n; k++) { const t = k / n, b = Math.sin(t * Math.PI) * bend; pts.push([x0 + dx * t + nx * b, y0 + dy * t + ny * b]); }
  return pts;
}
function polyPath(g, p) { g.beginPath(); p.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); }

// Faint brushwork: short 1 px dabs, lighter and darker, across and along (weave / grain).
function weave(g, x, y, w, h, base, rnd, { a = 0.08, len = [2, 5], dir = 0.5 } = {}) {
  const N = Math.round(w * h / 28), lc = lightOf(base, 0.45), dc = shadowOf(base, 0.45);
  g.save(); g.globalAlpha = a;
  for (let i = 0; i < N; i++) {
    const px = x + rnd() * w, py = y + rnd() * h, L = range(rnd, len[0], len[1]);
    g.fillStyle = rnd() < 0.5 ? lc : dc;
    if (rnd() < dir) g.fillRect(px, py, L, 1); else g.fillRect(px, py, 1, L);
  }
  g.restore();
}
// Worn edges: a broken lighter, desaturated line along a hem or seam.
function wear(g, pts, base, w = 2.4, a = 0.4, rnd = null) {
  const c = mix(lightOf(base, 0.5), '#b8ae9c', 0.35);
  for (let i = 0; i < pts.length - 1; i++) {
    if (rnd && rnd() < 0.3) continue;
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    stroke(g, [[ax, ay], [(ax + bx) / 2, (ay + by) / 2 - 0.4], [bx, by]], w, w * 0.5, c, a);
  }
}
const along = (x0, y0, x1, y1, n = 8) => Array.from({ length: n + 1 }, (_, k) => [x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n]);
// Cloth, in layers: a lit-top gradient, big soft blotches in related hues, faint weave,
// then big painted folds (a cool crease with a lit ridge beside it).
function cloth(g, r, x, y, w, h, base, rnd, { folds = 6, foldLen = [0.25, 0.5], foldAngle = 0, light = 0.34, blotch = 12, wrap = false, foldW = [3, 6], weaveA = 0.08 } = {}) {
  gradV(g, x, y, w, h, [[0, lightOf(base, light)], [0.45, base], [1, shadowOf(base, light * 0.95)]]);
  const hues = [shade(base, 0.88), lightOf(base, 0.16), mix(base, '#5b4a7a', 0.18), mix(base, '#c9a35e', 0.14)];
  for (let i = 0; i < blotch; i++) {
    const bx = x + rnd() * w, by = y + rnd() * h, bw = range(rnd, w * 0.12, w * 0.32), bh = range(rnd, h * 0.08, h * 0.22);
    wblob(g, wrap ? r : null, bx, by, bw, bh, rnd() * 3, pick(rnd, hues), 0.3, 0.12);
  }
  if (weaveA) weave(g, x, y, w, h, base, rnd, { a: weaveA });
  for (let i = 0; i < folds; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, foldLen[0], foldLen[1]) * h, a = foldAngle + (rnd() - 0.5) * 0.5;
    const pts = curve(x0, y0, x0 + Math.sin(a) * L, y0 + Math.cos(a) * L, (rnd() - 0.5) * L * 0.18, 6);
    const fw = range(rnd, foldW[0], foldW[1]) * 1.5;
    sfold(g, pts, fw, base, 0.85);
    if (wrap && r) { if (x0 < x + fw * 2) sfold(g, pts.map(([a, b]) => [a + w, b]), fw, base, 0.85); if (x0 > x + w - fw * 2) sfold(g, pts.map(([a, b]) => [a - w, b]), fw, base, 0.85); }
  }
}
// Leather: a lit-top gradient, mottling, broad soft sheen where it bulges, short worn
// creases, and nicks (a dark cut with a lit lower lip). No curly scuffs.
function leather(g, r, x, y, w, h, base, rnd, { creases = 6, scuffs = 8, light = 0.3, wrap = false, sheen = 0.22 } = {}) {
  gradV(g, x, y, w, h, [[0, lightOf(base, light)], [0.5, base], [1, shadowOf(base, light)]]);
  const R = wrap ? r : null;
  for (let i = 0; i < 12; i++) wblob(g, R, x + rnd() * w, y + rnd() * h, range(rnd, w * 0.08, w * 0.22), range(rnd, h * 0.06, h * 0.18), rnd() * 3, pick(rnd, [shade(base, 0.76), mix(base, '#3a2a3e', 0.25), lightOf(base, 0.2)]), 0.28, 0.18);
  for (let i = 0; i < 3; i++) wblob(g, R, x + rnd() * w, y + range(rnd, 0.15, 0.6) * h, range(rnd, w * 0.15, w * 0.3), range(rnd, h * 0.1, h * 0.2), 0, lightOf(base, 0.4), sheen, 0.1);
  weave(g, x, y, w, h, base, rnd, { a: 0.06, len: [1, 3] });
  for (let i = 0; i < creases; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, 5, 12), a = range(rnd, -0.35, 0.35);
    sfold(g, [[x0, y0], [x0 + Math.cos(a) * L, y0 + Math.sin(a) * L]], range(rnd, 2.5, 4), base, 0.75, { dark: 0.55 });
  }
  for (let i = 0; i < scuffs; i++) {
    const x0 = x + rnd() * w, y0 = y + rnd() * h, L = range(rnd, 2.5, 6), a = range(rnd, -0.6, 0.6);
    const x1 = x0 + Math.cos(a) * L, y1 = y0 + Math.sin(a) * L;
    stroke(g, [[x0, y0], [x1, y1]], 1.3, 0.6, shadowOf(base, 0.6), 0.5);
    stroke(g, [[x0, y0 + 1.2], [x1, y1 + 1.2]], 1.0, 0.4, lightOf(base, 0.5), 0.38);
  }
}
// Hair the WoW way: a few big tapered clumps with dark partings between them, each
// clump darker at the root and on its shadow side, a broad warm sheen band across the
// middle broken into a few soft streaks, darker tips. Never thin per-hair strands.
function locks(g, r, x, y, w, h, base, rnd, { count = 14, len = [0.55, 0.95], width = [9, 16], flow = 0, sheen = 0.3, wrap = false, topPad = 0.12 } = {}) {
  gradV(g, x, y, w, h, [[0, shadowOf(base, 0.25)], [0.35, base], [1, shadowOf(base, 0.4)]]);
  const deep = mix(shadowOf(base, 0.7), INK, 0.25), dark = shadowOf(base, 0.5);
  const mids = [base, mix(base, lightOf(base, 0.25), 0.5), shade(base, 0.92), mix(base, '#7a4a30', 0.12)];
  const hi = mix(lightOf(base, 0.75), '#ffe6b4', 0.3);
  const list = [];
  const n = Math.max(3, Math.round(count * 0.75));
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
    const x0 = x + (i + 0.2 + rnd() * 0.6 + pass * 0.5) / n * w, y0 = y - h * topPad + rnd() * h * 0.12 + pass * h * 0.06;
    const L = range(rnd, len[0], len[1]) * h * (pass ? 0.85 : 1.1), W = Math.max(range(rnd, width[0], width[1]) * 1.3, w / n * range(rnd, 0.9, 1.25)) * (pass ? 0.8 : 1);
    list.push({ pts: curve(x0, y0, x0 + flow * L * 0.35 + (rnd() - 0.5) * W * 0.3, y0 + L, (rnd() - 0.5) * W * 0.5, 8), W, c: pick(rnd, mids), s: range(rnd, -0.08, 0.08) });
  }
  const each = fn => { for (const lk of list) { fn(lk.pts, lk); if (wrap && r) { if (lk.pts[0][0] < x + lk.W * 1.5) fn(lk.pts.map(([a, b]) => [a + w, b]), lk); if (lk.pts[0][0] > x + w - lk.W * 1.5) fn(lk.pts.map(([a, b]) => [a - w, b]), lk); } } };
  // (opaque strokes in pre-mixed colors: translucent ones bead where their segments overlap)
  each((P, lk) => stroke(g, P.map(([a, b]) => [a + lk.W * 0.48, b + 2]), lk.W * 0.42, lk.W * 0.1, mix(deep, base, 0.4), 1));   // the parting beside each clump
  each((P, lk) => stroke(g, P, lk.W, lk.W * 0.2, lk.c, 1));                                                                    // the clump
  each((P, lk) => stroke(g, P.map(([a, b]) => [a - lk.W * 0.16, b]), lk.W * 0.45, lk.W * 0.1, mix(lk.c, lightOf(lk.c, 0.25), 0.45), 1));   // its lit side
  each((P, lk) => stroke(g, P.map(([a, b]) => [a + lk.W * 0.3, b]), lk.W * 0.36, lk.W * 0.08, mix(lk.c, dark, 0.55), 1));       // its shadow side
  each((P, lk) => stroke(g, P.slice(0, 3), lk.W * 0.9, lk.W * 0.8, mix(lk.c, shadowOf(lk.c, 0.3), 0.45), 1));                 // darker at the root
  each((P, lk) => {                                                                                                    // the sheen: soft, elongated, broken
    const t0 = Math.max(0.12, Math.min(0.8, sheen + lk.s * 2.5)), k = Math.min(P.length - 2, Math.floor(t0 * 8));
    const [ax, ay] = P[k], [bx, by] = P[k + 1], rot = Math.atan2(by - ay, bx - ax);
    blob(g, (ax + bx) / 2 - lk.W * 0.1, (ay + by) / 2, lk.W * 0.9, lk.W * 0.2, rot, hi, 0.4, 0.2);
    blob(g, (ax + bx) / 2 - lk.W * 0.14, (ay + by) / 2 + lk.W * 0.3, lk.W * 0.55, lk.W * 0.09, rot, mix(hi, '#fff6dc', 0.4), 0.5, 0.3);
  });
  each((P, lk) => stroke(g, P.slice(-3), lk.W * 0.35, lk.W * 0.1, mix(lk.c, shadowOf(lk.c, 0.35), 0.45), 1));          // darker tips
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
  const dk = Math.max(0, 0.42 - hsl(c).l) * 1.4;     // dark skin: shadows a touch less deep, highlights a touch stronger
  return {
    base: c, light: lightOf(c, 0.32 + dk * 0.3), hi: lightOf(c, 0.6 + dk * 0.45), shadow: shadowOf(c, 0.32 - dk * 0.1), deep: shadowOf(c, 0.55 - dk * 0.25),
    cool: mix(shadowOf(c, 0.28), '#6a5a8a', 0.24), blush: mix(c, '#c4504a', 0.3), lip: mix(shadowOf(c, 0.2), '#a4484a', 0.36),
  };
}

// Face painting kit: F(x, y) -> canvas px for face cm (x + = the character's left, y + = up
// from the eye line), KX / KY = px per cm across / up the face.
function faceKit(g, r) {
  const KX = r.w * (1 + HEAD_B) / TAU / FACE_ARC, KY = 4.07 / (100 * HEAD_SCALE) * r.h;
  const F = (x, y) => { const [u, v] = faceUV(x, y); return [r.x + u * r.w, r.y + (1 - v) * r.h]; };
  return {
    KX, KY, F,
    B: (x, y, rx, ry, c, a, hard = 0.15, rot = 0) => { const [px, py] = F(x, y); wblob(g, r, px, py, rx * KX, ry * KY, rot, c, a, hard); },
    S: (pts, w0, w1, c, a = 1) => stroke(g, pts.map(([x, y]) => F(x, y)), w0, w1, c, a),
    E: (x, y, rx, ry, c, a = 1, rot = 0) => { const [px, py] = F(x, y); ellipse(g, px, py, rx * KX, ry * KY, rot, c, a); },
    poly: pts => polyPath(g, pts.map(([x, y]) => F(x, y))),
    yOf: dy => (dy - EYE_DY) * 100 * HEAD_SCALE,
  };
}

// An eye, WoW-style: a narrow almond under a heavy brow, mostly iris, a thick dark upper
// lid that runs past the outer corner, the top of the eyeball in the lid's shadow, one
// catchlight. (The socket shadow around it is painted by paintHead.)
function paintEye(g, K, s, S, glow) {
  const T = toneOf(S.tone), L = S.look, fem = L.female, { KX, KY } = K;
  const [cx, cy] = K.F(s * EYE_X, 0);
  const ew = (fem ? 1.8 : 1.75) * KX, eh = (fem ? 0.62 : 0.5) * KY;
  const inner = [cx - s * ew, cy + eh * 0.25], outer = [cx + s * ew, cy - eh * (fem ? 0.35 : 0.05)];
  const almond = () => {
    g.beginPath(); g.moveTo(...inner);
    g.quadraticCurveTo(cx - s * ew * 0.1, cy - eh * 2.0, ...outer);
    g.quadraticCurveTo(cx + s * ew * 0.25, cy + eh * 1.5, ...inner);
    g.closePath();
  };
  g.save();
  almond(); g.fillStyle = glow ? mix('#d0b8a0', glow, 0.4) : mix('#c9b8a2', T.base, 0.3); g.fill();
  g.clip();
  const ir = (fem ? 0.56 : 0.5), ix = cx + s * 0.08 * KX, iy = cy - eh * 0.05;
  ellipse(g, ix, iy, ir * KX, ir * KY, 0, glow ? shadowOf(glow, 0.4) : shadowOf(L.eyes, 0.6));
  ellipse(g, ix, iy + ir * KY * 0.12, ir * KX * 0.78, ir * KY * 0.74, 0, glow || L.eyes);
  blob(g, ix, iy + ir * KY * 0.45, ir * KX * 0.6, ir * KY * 0.35, 0, glow ? '#ffb08a' : lightOf(L.eyes, 0.55), 0.6, 0.2);
  ellipse(g, ix, iy, ir * KX * 0.36, ir * KY * 0.38, 0, glow ? '#4a0808' : '#1a1218');
  gradV(g, cx - ew, cy - eh * 2.2, ew * 2, eh * 2.8, [[0, rgba(T.deep, 1)], [0.6, rgba(mix(T.deep, '#2a1830', 0.3), 0.8)], [1, rgba(T.deep, 0)]]);
  ellipse(g, ix - ir * KX * 0.32, iy - ir * KY * 0.12, ir * KX * 0.2, ir * KY * 0.2, 0, '#fff6e0', 0.95);
  g.restore();
  // the upper lid: thick and dark, heaviest toward the outer corner, a lash flick past it
  const up = [inner, [cx - s * ew * 0.35, cy - eh * 1.25], [cx + s * ew * 0.3, cy - eh * 1.4], outer, [outer[0] + s * ew * 0.2, outer[1] + eh * (fem ? -0.6 : 0.3)]];
  stroke(g, up, 2.6, fem ? 5.2 : 4.6, '#24140f', 0.97);
  stroke(g, up.map(([x, y]) => [x, y - 2]), 2, 3, mix(T.deep, '#24140f', 0.45), 0.5);
  if (fem) for (let k = 0; k < 3; k++) { const t = 0.55 + k * 0.17, x = inner[0] + (outer[0] - inner[0]) * t, y = cy - eh * (1.3 - k * 0.15); stroke(g, [[x, y], [x + s * 3, y - 3.5]], 1.6, 0.5, '#24140f', 0.8); }
  // the lid crease above, a lit fold of lid under the brow
  stroke(g, curve(inner[0] + s * ew * 0.15, cy - eh * 2.5, outer[0] - s * ew * 0.05, cy - eh * 2.25, -s * eh * 0.6, 4), 2, 1.4, mix(T.deep, '#2a1c30', 0.3), 0.6);
  blob(g, cx + s * ew * 0.1, cy - eh * 3.3, ew * 0.9, eh * 0.7, 0, T.light, fem ? 0.45 : 0.28, 0.2);
  // lower lid: a soft warm line, a bag of shadow (men), a lit cheek under it
  stroke(g, [[inner[0] + s * ew * 0.2, inner[1] + eh * 0.3], [cx + s * ew * 0.2, cy + eh * 1.3], [outer[0], outer[1] + eh * 0.7]], 1.8, 1.2, mix(T.deep, T.blush, 0.25), 0.7);
  if (!fem) blob(g, cx + s * 1.5, cy + eh * 2.2, ew * 0.75, eh * 0.7, 0, T.shadow, 0.35, 0.2);
}

// The face region of the jaw where stubble and beards grow (face cm).
const BEARD_ZONE = s => [[-15.5 * s, 1.5], [-11.5 * s, -3.5], [-6.8 * s, -6.2], [-3.1 * s, -7.0], [0, -6.6]];
function beardPath(K, top = 1) {
  const up = BEARD_ZONE(1).map(([x, y]) => [x, y * top]), dn = [[16, -8], [10.5, -14.6], [4, -16.2], [0, -16.6]];
  const pts = [...up, ...BEARD_ZONE(-1).map(([x, y]) => [x, y * top]).reverse().slice(1), ...dn.map(([x, y]) => [x, y]), ...dn.slice(0, -1).reverse().map(([x, y]) => [-x, y])];
  K.poly(pts);
}

function paintHead(g, r, S, rnd) {
  const T = toneOf(S.tone), L = S.look, fem = L.female;
  const K = faceKit(g, r), { B, S: St, F, E, KX, KY } = K;
  const Y = v => r.y + (1 - v) * r.h;
  const yBrow = K.yOf(0.047), yNoseTip = K.yOf(-0.012), yNoseB = K.yOf(-0.022), yMouth = K.yOf(-0.047), yChin = K.yOf(-0.08), yJaw = K.yOf(-0.092);
  clip(g, r, () => {
    // skin, lit from above; a soft cool shadow under the jaw that fades down the neck
    const vJ = headV(-0.094);
    gradV(g, r.x, r.y, r.w, r.h, [[0, T.light], [1 - 0.79, mix(T.light, T.base, 0.4)], [1 - 0.6, T.base], [1 - 0.2, T.base], [1 - vJ - 0.02, mix(T.base, T.shadow, 0.35)], [1 - vJ + 0.015, mix(T.shadow, T.cool, 0.4)], [1 - 0.03, mix(T.base, T.shadow, 0.55)], [1, mix(T.shadow, T.cool, 0.3)]]);
    for (let i = 0; i < 22; i++) wblob(g, r, r.x + rnd() * r.w, r.y + rnd() * r.h * 0.85, range(rnd, 14, 40), range(rnd, 8, 22), rnd() * 3, pick(rnd, [T.light, T.shadow, T.blush, T.cool]), 0.13, 0.1);
    weave(g, r.x, r.y, r.w, r.h, T.base, rnd, { a: 0.045, len: [2, 4], dir: 0.3 });     // faint brushwork in the skin
    // the big planes: the sides of the head turn away (cool), the front of the face catches the light
    for (const s of [-1, 1]) {
      B(s * 17, -2, 6, 13, T.cool, 0.42, 0.1);
      B(s * 30, 2, 9, 16, T.shadow, 0.3, 0.1);
      B(s * 9.2, 3.2, 2.4, 3.6, T.cool, 0.42);                               // temples
      B(s * 11, -12, 2.6, 2.6, mix(T.cool, T.deep, 0.3), 0.5);               // the jaw's corner
      B(s * 17.6, -1, 1.3, 4.5, T.deep, 0.42, 0.2);                          // where the ears attach
    }
    B(0, -1, 7.5, 10, T.light, 0.22, 0.1);
    B(-0.6, 5.2, 6.8, 2.6, T.hi, 0.42);                                       // forehead
    // the brow ridge: lit on top, a deep cool shadow under it pooling in the sockets
    const sock = mix(T.deep, '#3a2c52', 0.3);
    for (const s of [-1, 1]) {
      B(s * 3.4 - 0.3, yBrow + 0.9, 3.1, 0.9, T.hi, fem ? 0.32 : 0.55, 0.25, -s * 0.08);
      B(s * EYE_X, 0.55, 2.8, 1.75, sock, fem ? 0.45 : 0.75, 0.2);
      B(s * 1.7, 0.2, 0.8, 1.1, T.deep, fem ? 0.35 : 0.6, 0.2);
      B(s * 5.8, 0.7, 1.3, 1.5, T.deep, fem ? 0.2 : 0.38);
      B(s * 3.8, -2.1, 2.1, 0.8, T.light, 0.38, 0.2);                       // lit cheek under the eye
    }
    B(-0.2, 1.9, 0.8, 1.3, T.light, 0.45, 0.2);                               // between the brows
    // cheekbones: a lit plane, a little color, a cool hollow under it
    for (const s of [-1, 1]) {
      B(s * 6.3, -1.8, 2.4, 1.25, T.hi, fem ? 0.38 : 0.5, 0.2, s * 0.25);
      B(s * 5.6, -3.4, 2.1, 1.5, T.blush, fem ? 0.42 : 0.22);
      B(s * 7.2, -6.0, 2.2, 2.6, T.cool, fem ? 0.18 : 0.32, 0.12, -s * 0.3);
    }
    // nose: a lit bridge and tip (light from the upper left), shadowed sides, wings,
    // nostrils, and a strong shadow under it
    for (const s of [-1, 1]) St([[s * 1.15, -1.6], [s * 1.4, -3.2], [s * 1.7, -5.0]], 4, 9, T.shadow, s > 0 ? 0.55 : 0.35);
    St([[-0.25, 0.4], [-0.3, -2.2], [-0.35, -3.8]], 4, 6.5, T.hi, 0.5);
    B(-0.25, yNoseTip + 0.15, 1.35, 0.85, T.hi, 0.7, 0.3);
    B(-0.5, yNoseTip + 0.45, 0.4, 0.3, '#fff2dc', 0.35, 0.3);
    B(0.1, yNoseTip - 0.45, 1.1, 0.4, T.blush, 0.3, 0.3);
    for (const s of [-1, 1]) {
      B(s * 1.6, yNoseB + 0.75, 0.75, 0.8, T.shadow, 0.62, 0.3);
      B(s * 1.45 - 0.15, yNoseB + 1.15, 0.4, 0.35, T.light, 0.42, 0.3);
      E(s * 0.75, yNoseB + 0.15, 0.32, 0.26, mix(T.deep, '#3a1a1a', 0.4), 0.9, s * 0.4);
    }
    B(0, yNoseB - 0.3, 1.8, 0.6, T.deep, fem ? 0.6 : 0.82, 0.3);
    B(0, -7.3, 0.35, 0.9, T.shadow, 0.42, 0.3);                               // philtrum
    for (const s of [-1, 1]) B(s * 0.55 - 0.1, -7.2, 0.18, 0.7, T.light, 0.3, 0.3);
    // smile folds from the nose wings round the mouth, lit on the cheek side
    for (const s of [-1, 1]) {
      const fold = curve(s * 2.0, yNoseB + 0.6, s * 3.2, yMouth + 0.2, -s * 0.4, 4);
      St(fold, fem ? 2.5 : 4.5, 1.2, T.shadow, fem ? 0.3 : 0.55);
      St(fold.map(([x, y]) => [x + s * 0.5, y + 0.1]), 3.5, 1.2, T.light, 0.3);
    }
    facialBase(g, K, S, T, rnd);
    // mouth: a shaded upper lip, a firm line, a lit lower lip, a shadow under it
    const mw = fem ? 2.2 : 2.5;
    B(0, yMouth + 0.55, mw * 0.95, 0.5, mix(T.lip, T.shadow, 0.4), 0.72, 0.4);
    B(0, yMouth - 0.65, mw * 0.78, 0.6, fem ? mix(T.lip, '#b04a4a', 0.4) : T.lip, fem ? 0.88 : 0.62, 0.4);
    B(-0.4, yMouth - 0.55, mw * 0.33, 0.2, T.hi, 0.5, 0.3);
    const corner = L.stern ? -0.3 : fem ? 0.3 : 0.2;
    St([[-mw, yMouth + corner], [-mw * 0.45, yMouth + 0.08], [0, yMouth - 0.06], [mw * 0.45, yMouth + 0.08], [mw, yMouth + corner]], 2.8, 2.2, '#3b2220', 0.92);
    for (const s of [-1, 1]) B(s * mw * 1.08, yMouth + corner, 0.3, 0.3, T.deep, 0.5, 0.3);
    B(0, yMouth - 1.55, mw * 0.72, 0.5, T.deep, 0.62, 0.3);
    // chin and jaw: a lit chin, the jaw line in a soft dark edge where it turns under
    B(-0.2, yChin + 0.9, 2.1, 1.1, T.hi, 0.52, 0.25);
    if (!fem && S.skin === 0) St([[0, yChin + 1.4], [0, yChin + 0.3]], 1.8, 1.2, T.shadow, 0.5);
    for (const s of [-1, 1]) for (const [x, y, rx] of [[2.5, 0.2, 3.2], [6.8, 0.9, 2.8], [10, 2.4, 2]]) B(s * x, yJaw + y, rx, 0.9, T.deep, fem ? 0.3 : 0.45, 0.25, -s * 0.2);
    B(0, yJaw - 1.2, 8.5, 1.6, mix(T.deep, '#3c2c50', 0.3), 0.55, 0.2);
    B(0, yJaw - 5.5, 2.6, 2.4, T.light, 0.22);                               // the throat catches a little light
    // eyes & brows
    for (const s of [-1, 1]) paintEye(g, K, s, S, S.eyeGlow);
    const browC = L.hair === 'bald' ? mix(L.hairColor, '#5a5048', 0.4) : shadowOf(L.hairColor, 0.12);
    for (const s of [-1, 1]) {
      const iy = yBrow - (L.stern ? 0.95 : 0.5);
      const pts = [[s * 1.0, iy], [s * 2.4, yBrow + (fem ? 0.35 : 0.05)], [s * 4.0, yBrow + (fem ? 0.45 : 0.25)], [s * 5.9, yBrow - 0.5]];
      const fp = pts.map(([x, y]) => F(x, y));
      if (fem) { stroke(g, fp.map(([x, y]) => [x, y + 1.5]), 5, 1.6, mix(T.deep, INK, 0.2), 0.35); stroke(g, fp, 5, 1.8, browC, 0.95); continue; }
      stroke(g, fp.map(([x, y]) => [x + 1, y + 3]), 15, 5, mix(T.deep, INK, 0.3), 0.5);
      stroke(g, fp, 15, 5.5, browC, 0.97);
      for (let k = 0; k < 9; k++) {   // hairy strokes along the brow, lit on top
        const t = k / 8, [px, py] = F(s * (1.1 + t * 4.6), yBrow - 0.45 + Math.sin(t * Math.PI) * 0.75 - (L.stern ? (1 - t) * 0.4 : 0));
        stroke(g, [[px - s * 2, py + 3], [px + s * 4, py - 3]], 1.8, 0.7, lightOf(browC, 0.4), 0.5);
      }
    }
    facialHair(g, K, S, T, rnd);
    paintHairCap(g, r, S, rnd);
  });
}

function facialBase(g, K, S, T, rnd) {
  const L = S.look, f = L.facial;
  if (L.female || f === 'none' || f === 'pencil') return;
  g.save();
  beardPath(K, f === 'goatee' ? 0.6 : 1);
  g.clip();
  const sc = mix(mix(L.hairColor, T.shadow, 0.45), '#3e3a5a', 0.25);
  const amt = f === 'stubble' ? 0.42 : f === 'goatee' ? 0.26 : f === 'beard' ? 0.6 : 0.32;
  K.B(0, -12, 13, 6, sc, amt, 0.4);
  K.B(0, -7.6, 3.2, 0.9, sc, amt * 0.85, 0.3);
  for (let i = 0; i < 14; i++) K.B(range(rnd, -13, 13), range(rnd, -15, -5), range(rnd, 1.2, 2.6), range(rnd, 0.8, 1.4), sc, amt * 0.22, 0.1);
  g.restore();
}

// A painted mustache of a few lit clumps per side, sweeping out and down from under the nose.
function paintMustache(g, K, hc, T, { droop = 0.6, curl = false, width = 1 } = {}) {
  const yN = K.yOf(-0.025), yM = K.yOf(-0.047);
  for (const s of [-1, 1]) {
    const ends = curl ? [[s * 3.6 * width, yM - 0.2], [s * 4.1 * width, yM + 0.7]] : [[s * 3.4 * width, yM - droop]];
    const pts = [[s * 0.25, yN - 0.15], [s * 1.5, yN - 0.75], [s * 2.6 * width, yM + 0.6], ...ends];
    K.S(pts.map(([x, y]) => [x + 0.15, y - 0.35]), 14, 4, T.deep, 0.5);
    K.S(pts, 16, curl ? 3.5 : 5, shadowOf(hc, 0.3), 1);
    K.S(pts, 12, curl ? 2.5 : 3.5, shadowOf(hc, 0.2), 1);
    for (let k = 0; k < 3; k++) {   // clumps, each lit along its top
      const o = (k - 1) * 0.35;
      const cp = pts.map(([x, y], i) => [x, y + o * (1 - i / pts.length)]);
      K.S(cp, 5, 1.6, mix(hc, shadowOf(hc, 0.3), 0.3 + k * 0.15), 0.9);
      K.S(cp.map(([x, y]) => [x - s * 0.1, y + 0.3]), 2.4, 0.8, lightOf(hc, 0.45), 0.65);
    }
  }
}

// Long downward clumps of beard between x0..x1 (cm), from the top edge yTop(x) down to yBot(x),
// drawing in toward the point; dark roots, mid clumps, lit tops, dark partings.
function beardClumps(g, K, hc, rnd, { x0, x1, yTop, yBot, n = 22, w = [1.3, 2.0], pull = 0.35, roots, lit }) {
  const mids = [hc, mix(hc, lightOf(hc, 0.25), 0.5), shade(hc, 0.9), mix(hc, roots, 0.3)];
  const list = [];
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < n; i++) {
    const x = x0 + (x1 - x0) * (i + 0.2 + rnd() * 0.6 + pass * 0.5) / n, yt = yTop(x) + range(rnd, -0.3, 0.6), yb = yBot(x) - range(rnd, 0, 1.2);
    const W = range(rnd, w[0], w[1]) * (pass ? 0.8 : 1) * K.KX, xe = x * (1 - pull) + range(rnd, -0.6, 0.6);
    list.push({ pts: [[x, yt], [x * (1 - pull * 0.3), yt + (yb - yt) * 0.35], [x * (1 - pull * 0.7), yt + (yb - yt) * 0.7], [xe, yb]], W, c: pick(rnd, mids) });
  }
  for (const lk of list) {
    const P = lk.pts.map(([x, y]) => K.F(x, y)), W = lk.W;
    stroke(g, P.map(([a, b]) => [a + W * 0.45, b]), W * 0.45, W * 0.12, roots, 1);
    stroke(g, P, W, W * 0.3, lk.c, 1);
    stroke(g, P.map(([a, b]) => [a - W * 0.2, b]), W * 0.32, W * 0.08, mix(lk.c, lit, 0.6), 1);
    stroke(g, P.slice(0, 2), W * 0.9, W * 0.7, mix(lk.c, roots, 0.55), 0.8);
  }
}
function facialHair(g, K, S, T, rnd) {
  const L = S.look, f = L.facial, hc = L.hairColor;
  const roots = mix(shadowOf(hc, 0.4), '#3a3040', 0.15), lit = mix(lightOf(hc, 0.6), '#efe4cc', 0.3);
  const topOf = tab => x => K.yOf(lerpTable(tab, Math.abs(x) / FACE_ARC, 1));
  if (f === 'mustache') paintMustache(g, K, hc, T, { curl: true });
  if (f === 'pencil') for (const s of [-1, 1]) K.S([[s * 0.4, K.yOf(-0.028)], [s * 2.7, K.yOf(-0.043)]], 2.4, 1.2, shadowOf(hc, 0.1), 0.95);
  if (f === 'goatee') {
    // painted onto the chin and down the neck front, where the modeled tuft samples it
    g.save(); K.poly([[-3.2, -9.0], [3.2, -9.0], [3.6, -12], [2.6, -17], [0, -20], [-2.6, -17], [-3.6, -12]]); g.clip();
    K.B(0, -13, 4, 7, mix(roots, hc, 0.35), 0.9, 0.5);
    beardClumps(g, K, hc, rnd, { x0: -3.2, x1: 3.2, yTop: topOf(GOATEE_TOP), yBot: () => -19.5, n: 3, w: [1.7, 2.3], pull: 0.6, roots: mix(roots, hc, 0.35), lit });
    g.restore();
    paintMustache(g, K, hc, T, { droop: 1.4, width: 0.9 });
  }
  if (f === 'beard') {
    // the whole beard, painted where the modeled beard sheet samples it: up the cheeks
    // into the sideburns, round the jaw, and on down the neck front for the hanging part
    const top = topOf(BEARD_TOP), xs = 17.5;
    g.save();
    g.beginPath();
    for (let k = 0; k <= 40; k++) { const x = -xs + 2 * xs * k / 40, [px, py] = K.F(x, top(x) + 0.4); k ? g.lineTo(px, py) : g.moveTo(px, py); }
    for (const [x, y] of [[xs, -9], [12, -16], [9, -26], [-9, -26], [-12, -16], [-xs, -9]]) g.lineTo(...K.F(x, y));
    g.closePath(); g.clip();
    K.B(0, -12, 16, 12, roots, 0.95, 0.6);
    beardClumps(g, K, hc, rnd, { x0: -xs, x1: xs, yTop: top, yBot: x => Math.abs(x) > 11 ? -12 + (Math.abs(x) - 11) * 0.6 : -25, n: 16, w: [1.6, 2.4], pull: 0.25, roots, lit });
    g.restore();
    // the soft upper edge on the cheeks: short strokes fading into the skin
    for (let i = 0; i < 26; i++) { const x = range(rnd, -15, 15), y = top(x) + 0.3; K.S([[x, y + 0.6], [x * 0.98, y - 1.2]], 5, 1.5, mix(hc, roots, 0.4), 0.55); }
    paintMustache(g, K, hc, T, { droop: 0.9, width: 1.1 });
  }
}

// Hair the WoW way: big clumps flowing up from the hairline and back over the crown in a
// soft S, each laid over the last with a dark parting along its shadow side, a lit
// top-left edge and a broken sheen across the middle; darker roots. Never thin per-hair
// strands, never drips. ys(x) / ye(x): where a clump starts (the hairline) and ends.
function hairFlow(g, base, rnd, { x0, x1, ys, ye, count = 9, width = [18, 26], lean = () => 0, sheen = 0.45, wrapW = 0, root = 0.5 }) {
  const deep = mix(shadowOf(base, 0.62), INK, 0.2), dark = shadowOf(base, 0.42);
  const mids = [base, mix(base, lightOf(base, 0.3), 0.55), shade(base, 0.9), mix(base, '#7a4a30', 0.12)];
  const dk = hsl(base).l < 0.15;     // black hair: a cool, quieter sheen
  const hi = dk ? mix(lightOf(base, 0.9), '#8a96b0', 0.35) : mix(lightOf(base, 0.7), '#ffe6b4', 0.3);
  const list = [];
  for (let pass = 0; pass < 2; pass++) for (let i = 0; i < count; i++) {
    const t = (i + 0.15 + rnd() * 0.7 + pass * 0.5) / count, x = x0 + (x1 - x0) * t;
    const y0 = ys(x) + range(rnd, -1, 2) + pass * 3, y1 = ye(x) + range(rnd, 0, 6);
    const L = y0 - y1, dx = lean(x) * L, W = range(rnd, width[0], width[1]) * (pass ? 0.78 : 1), bend = (rnd() - 0.5) * W * 0.9;
    const pts = []; for (let k = 0; k <= 8; k++) { const q = k / 8; pts.push([x + dx * q * q + Math.sin(q * TAU) * bend * 0.45, y0 - L * q]); }
    list.push({ pts, W, c: pick(rnd, mids), s: range(rnd, -0.1, 0.1) });
  }
  const copies = lk => wrapW ? [lk.pts, lk.pts.map(([a, b]) => [a + wrapW, b]), lk.pts.map(([a, b]) => [a - wrapW, b])] : [lk.pts];
  for (const lk of list) for (const P of copies(lk)) {
    const W = lk.W;
    stroke(g, P.map(([a, b]) => [a + W * 0.46, b + 1]), W * 0.5, W * 0.14, mix(deep, base, 0.2), 1);        // the parting
    stroke(g, P, W, W * 0.28, lk.c, 1);                                                                    // the clump
    blob(g, P[0][0], P[0][1] - 1, W * 0.52, W * 0.3, 0, lk.c, 1, 0.85);                                    // rounded at the hairline
    stroke(g, P.map(([a, b]) => [a + W * 0.26, b]), W * 0.4, W * 0.1, mix(lk.c, dark, 0.6), 1);             // its shadow side
    stroke(g, P.map(([a, b]) => [a - W * 0.22, b - 1]), W * 0.3, W * 0.06, mix(lk.c, lightOf(lk.c, 0.4), 0.7), 1);   // lit top-left edge
    const k = Math.max(1, Math.min(6, Math.round((sheen + lk.s) * 8))), [ax, ay] = P[k], [bx, by] = P[k + 1];
    blob(g, (ax + bx) / 2 - W * 0.14, (ay + by) / 2, W * 0.5, W * 0.15, Math.atan2(by - ay, bx - ax), hi, dk ? 0.35 : 0.55, 0.25);
    stroke(g, P.slice(0, 2), W * 0.95, W * 0.85, mix(lk.c, shadowOf(lk.c, 0.35), root), 0.85);           // darker at the roots
  }
}

// Hair painted straight onto the scalp: the whole look for bald / buzz cuts, the hair
// under hats that hide the hair shell, and the soft hairline with a few wisps.
function paintHairCap(g, r, S, rnd) {
  const L = S.look, hc = L.hairColor;
  const XT = th => r.x + headU(th) * r.w, Y = v => r.y + (1 - v) * r.h;
  const wave = th => hairWave(th, L.hair);
  const lineDy = (th, drop = 0) => hairlineDy(th) - drop + wave(th);
  const capPath = (drop = 0) => {
    g.beginPath(); g.moveTo(r.x - 4, Y(1.2));
    for (let k = 0; k <= 96; k++) { const u = k / 96, th = headTh(u); g.lineTo(r.x + u * r.w, Y(headV(lineDy(th, drop)))); }
    g.lineTo(r.x + r.w + 4, Y(1.2)); g.closePath();
  };
  if (L.hair === 'bald') {
    // a close-cropped horseshoe of hair round the back and sides, a shiny scalp on top
    g.save(); capPath(-0.005); g.clip();
    g.beginPath();
    for (let k = 0; k <= 96; k++) {
      const u = k / 96, th = headTh(u), a = Math.abs(th);
      const top = hairlineDy(th) + (a > 1.25 ? 0.05 * sstepJS(1.25, 1.9, a) + 0.004 * Math.sin(k * 1.7) : -0.05);
      k ? g.lineTo(r.x + u * r.w, Y(headV(top))) : g.moveTo(r.x + u * r.w, Y(headV(top)));
    }
    g.lineTo(r.x + r.w, Y(-0.2)); g.lineTo(r.x, Y(-0.2)); g.closePath(); g.clip();
    gradV(g, r.x, Y(0.75), r.w, r.h * 0.5, [[0, mix(hc, S.tone, 0.55)], [0.4, mix(hc, S.tone, 0.25)], [1, shadowOf(hc, 0.2)]]);
    for (let i = 0; i < 26; i++) wblob(g, r, r.x + rnd() * r.w, Y(0.3 + rnd() * 0.45), range(rnd, 6, 14), range(rnd, 3, 6), 0, pick(rnd, [shadowOf(hc, 0.3), lightOf(hc, 0.25)]), 0.3, 0.2);
    for (let i = 0; i < 70; i++) { const x = r.x + rnd() * r.w, y = Y(0.3 + rnd() * 0.45); stroke(g, [[x, y + 3], [x + range(rnd, -1.5, 1.5), y - 3]], 2.2, 0.6, pick(rnd, [shadowOf(hc, 0.35), lightOf(hc, 0.35)]), 0.4); }
    g.restore();
    blob(g, XT(0.15), Y(0.93), r.w * 0.07, r.h * 0.06, 0, '#fff2d6', 0.45, 0.15);
    blob(g, XT(0.3), Y(0.88), r.w * 0.025, r.h * 0.025, 0, '#fffaf0', 0.4, 0.3);
    return;
  }
  g.save(); capPath(); g.clip();
  if (L.hair === 'buzz') {
    // a dark cap with soft painted texture: a few big blotches and short dashes
    gradV(g, r.x, r.y, r.w, r.h, [[0, mix(hc, S.tone, 0.15)], [1, mix(hc, S.tone, 0.45)]]);
    for (let i = 0; i < 26; i++) wblob(g, r, r.x + rnd() * r.w, Y(0.4 + rnd() * 0.6), range(rnd, 10, 26), range(rnd, 6, 12), rnd() * 3, pick(rnd, [mix(hc, S.tone, 0.3), shadowOf(hc, 0.3)]), 0.3, 0.15);
    for (let i = 0; i < 90; i++) { const x = r.x + rnd() * r.w, y = Y(0.35 + rnd() * 0.65); stroke(g, [[x, y], [x + 1, y - 3]], 1.6, 0.6, mix(hc, '#9a8a7a', 0.35), 0.35); }
    blob(g, XT(0), Y(0.92), r.w * 0.08, r.h * 0.06, 0, mix(S.tone, '#fff0d0', 0.4), 0.3, 0.15);
  } else {
    gradV(g, r.x, r.y, r.w, r.h, [[0, base2(hc)], [1, shadowOf(hc, 0.3)]]);
    hairFlow(g, hc, rnd, {
      x0: r.x, x1: r.x + r.w, count: 16, width: [20, 30], wrapW: r.w,
      ys: x => Y(headV(lineDy(headTh((x - r.x) / r.w)))) + 2, ye: () => r.y - 6,
      lean: x => { const th = headTh((x - r.x) / r.w); return -Math.sin(th) * 0.35; },
    });
  }
  g.restore();
  // the hairline: hair casts a soft shadow onto the forehead; a few short wisps break the edge
  g.save(); g.globalAlpha = 0.24; g.translate(0, 4); capPath(); g.fillStyle = shadowOf(S.tone, 0.55); g.fill(); g.restore();
  if (L.hair !== 'buzz') {
    for (let i = 0; i < 9; i++) {
      const th = range(rnd, -1.3, 1.3), x = XT(th), y = Y(headV(lineDy(th))) - 1;
      stroke(g, [[x, y - 3], [x + range(rnd, -3, 3), y + range(rnd, 4, 8)]], range(rnd, 3, 5), 0.6, shadowOf(hc, 0.1), 0.6);
    }
    if (!L.female) for (const s of [-1, 1]) {   // short square sideburns
      const th = s * 1.36, x = XT(th), y0 = Y(headV(0.012)), y1 = Y(headV(L.facial === 'beard' ? -0.05 : -0.008));
      g.save(); g.beginPath(); g.moveTo(x - 7, y0 - 2); g.lineTo(x + 7, y0 - 2); g.lineTo(x + 6, y1); g.lineTo(x - 6, y1 + 1); g.closePath();
      g.fillStyle = shadowOf(hc, 0.1); g.fill(); g.restore();
      stroke(g, [[x - 3, y0], [x - 3, y1]], 4, 2, lightOf(hc, 0.3), 0.45);
    }
  }
}
const base2 = hc => mix(shadowOf(hc, 0.25), hc, 0.5);

// ---- body regions -------------------------------------------------------------------------

function paintTorso(g, r, S, rnd) {
  const c = S.color, U = u => RX(r, u), V = v => RY(r, v), TV = y => V(torsoV(y));
  // ambient occlusion: a soft dark band between two heights (a = alpha at y0 → y1)
  const ao = (y0, y1, a0, a1) => bandGrad(g, r, torsoV(Math.min(y0, y1)), torsoV(Math.max(y0, y1)), rgba(INK, y1 > y0 ? a1 : a0), rgba(INK, y1 > y0 ? a0 : a1));
  clip(g, r, () => {
    if (S.torso === 'tabard') {
      leather(g, r, r.x, r.y, r.w, r.h, LEATHER, rnd, { creases: 10, scuffs: 14, wrap: true });
      // below the belt: trousers (under the skirt; seen when it parts)
      clipRect(g, r.x, TV(0.95), r.w, r.y + r.h - TV(0.95), () => cloth(g, r, r.x, TV(0.95), r.w, r.y + r.h - TV(0.95), TROUSER, rnd, { folds: 6, wrap: true }));
      // the jerkin's stitched side panels, worn pale along the seams
      for (const u of [0.25, 0.75]) for (const d of [-0.05, 0.05]) { stitches(g, [[U(u + d), TV(0.96)], [U(u + d * 0.8), TV(1.4)]], '#d2b483', 0.45); wear(g, along(U(u + d * 1.2), TV(0.98), U(u + d), TV(1.38), 6), LEATHER, 2, 0.3, rnd); }
      // tabard panels front and back: straight sides, a round neck, gold trim, the crew's wagon-wheel sigil
      const panel = (cu, front) => [[U(cu - 0.165), TV(0.94)], [U(cu + 0.165), TV(0.94)], [U(cu + 0.15), TV(1.38)], [U(cu + 0.13), TV(1.52)],
        ...(front ? [[U(cu + 0.06), TV(1.52)], [U(cu + 0.035), TV(1.455)], [U(cu), TV(1.44)], [U(cu - 0.035), TV(1.455)], [U(cu - 0.06), TV(1.52)]] : []),
        [U(cu - 0.13), TV(1.52)], [U(cu - 0.15), TV(1.38)]];
      for (const [cu, front] of [[0.5, true], [0, false], [1, false]]) {
        const p = panel(cu, front);
        g.save(); polyPath(g, p);
        g.save(); g.translate(2, 2.5); g.fillStyle = rgba(INK, 0.55); g.fill(); g.restore();
        g.clip();
        cloth(g, r, U(cu - 0.17), TV(1.52), r.w * 0.34, TV(0.93) - TV(1.52), c, rnd, { folds: 0, light: 0.4, blotch: 12 });
        // the chest swells into the light; folds hang from the shoulders and bunch above the belt
        blob(g, U(cu - 0.04), TV(1.3), r.w * 0.1, 22, 0, lightOf(c, 0.55), 0.38, 0.1);
        blob(g, U(cu + 0.05), TV(1.1), r.w * 0.12, 20, 0, shadowOf(c, 0.5), 0.34, 0.1);
        for (const s2 of [-1, 1]) {
          sfold(g, curve(U(cu + s2 * 0.12), TV(1.44), U(cu + s2 * 0.045), TV(1.08), s2 * 4, 6), 8, c, 0.95, { dark: 0.6 });
          sfold(g, curve(U(cu + s2 * 0.075), TV(1.36), U(cu + s2 * 0.1), TV(1.16), -s2 * 3, 4), 6, c, 0.7);
          sfold(g, curve(U(cu + s2 * 0.15), TV(0.99), U(cu + s2 * 0.06), TV(1.07), 2, 3), 7, c, 0.95, { dark: 0.6 });
        }
        for (let k = 0; k < 5; k++) sfold(g, [[U(cu - 0.12 + k * 0.06), TV(0.95)], [U(cu - 0.12 + k * 0.06 + 0.012), TV(1.03)]], 6, c, 0.85, { dark: 0.6 });
        sfold(g, curve(U(cu + 0.005), TV(1.24), U(cu - 0.01), TV(1.02), 2, 4), 6, c, 0.6);
        ao(1.42, 1.52, 0, 0.35);                  // under the neckline
        ao(1.06, 0.97, 0, 0.38);                  // bunched into the belt
        g.restore();
        trimPath(g, [p[0], p[p.length - 1], p[p.length - 2]], 3.6);
        trimPath(g, [p[1], p[2], p[3]], 3.6);
        if (front) trimPath(g, p.slice(3, 10), 3); else trimPath(g, [p[3], p[4]], 3);
        wear(g, [p[0], p[p.length - 1], p[p.length - 2]].map(([x, y]) => [x - 1.5, y]), TRIM, 1.4, 0.35, rnd);
        wheelEmblem(g, U(cu), TV(1.22), r.w * (front ? 0.055 : 0.05));
      }
      // the bedroll's straps: up the back, over the shoulders, ending in buckles on the chest
      if (S.pack) for (const sd of [-1, 1]) {
        const st = [[U(0.5 + sd * 0.4), TV(1.27)], [U(0.5 + sd * 0.36), TV(1.4)], [U(0.5 + sd * 0.3), TV(1.49)], [U(0.5 + sd * 0.2), TV(1.44)], [U(0.5 + sd * 0.14), TV(1.33)]];
        stroke(g, st.map(([x, y]) => [x + 1, y + 2]), 9, 9, INK, 0.4);
        stroke(g, st, 8, 8, '#4a3020', 1);
        stroke(g, st.map(([x, y]) => [x - 1.5, y - 1]), 2, 2, '#8a6a48', 0.6);
        buckle(g, U(0.5 + sd * 0.14), TV(1.34), 6, 7);
      }
      // the shoulder tops sit in the pauldrons' shadow
      for (const u of [0.25, 0.75]) blob(g, U(u), TV(1.44), r.w * 0.11, 24, 0, INK, 0.45, 0.15);
    } else if (S.torso === 'shirt') {
      // Ed: a madder-red work shirt, buttoned, the apron's neck strap; braces down the back
      cloth(g, r, r.x, r.y, r.w, r.h, c, rnd, { folds: 10, light: 0.32, blotch: 14, wrap: true });
      for (const s2 of [-1, 1]) sfold(g, curve(U(0.5 + s2 * 0.2), TV(1.42), U(0.5 + s2 * 0.08), TV(1.12), s2 * 3, 5), 8, c, 0.9);
      stroke(g, [[U(0.5), TV(0.95)], [U(0.5), TV(1.48)]], 3, 3, shadowOf(c, 0.3), 0.6);
      for (let k = 0; k < 6; k++) rivet(g, U(0.505), TV(1.42 - k * 0.08), 1.6, '#d9ccb0');
      for (const s of [-1, 1]) stroke(g, [[U(0.5 + s * 0.1), TV(1.3)], [U(0.5 + s * 0.075), TV(1.42)], [U(0.5 + s * 0.05), TV(1.5)]], 5, 5, '#5a3c26', 1);
      // the apron's waist ties, wrapped round and knotted at the back
      g.save(); g.fillStyle = '#5a3c26'; g.fillRect(r.x, TV(1.03), r.w, TV(0.995) - TV(1.03)); g.restore();
      stroke(g, [[U(0.02), TV(1.01)], [U(-0.04), TV(0.92)]], 4, 3, '#5a3c26', 1); stroke(g, [[U(0.98), TV(1.01)], [U(1.05), TV(0.93)]], 4, 3, '#5a3c26', 1);
      blob(g, U(0.0), TV(1.012), 7, 6, 0, '#4a3020', 1, 0.6); blob(g, U(1.0), TV(1.012), 7, 6, 0, '#4a3020', 1, 0.6);
      for (const s of [-1, 1]) for (const cu of [0, 1]) stroke(g, [[U(cu + s * 0.06), TV(1.0)], [U(cu + s * 0.04), TV(1.5)]], 5, 5, '#3d2a1c', 0.95);
      ao(0.99, 0.94, 0.3, 0);
      ao(1.46, 1.52, 0, 0.4);
    } else if (S.torso === 'bodice') {
      // a cream linen blouse with a gathered neckline, a laced bodice in her color over it
      cloth(g, r, r.x, r.y, r.w, r.h, LINEN, rnd, { folds: 7, wrap: true, foldW: [3, 5], light: 0.28 });
      for (let k = 0; k < 18; k++) { const u = (k + 0.5) / 18; sfold(g, [[U(u), TV(1.49)], [U(u + 0.004), TV(1.4)]], 3.2, LINEN, 0.75); }
      stroke(g, [[r.x, TV(1.465)], [r.x + r.w, TV(1.465)]], 1.6, 1.6, '#8a5a3a', 0.8);   // the drawstring
      const bod = shade(c, 0.95);
      const P = [[U(-0.01), TV(1.35)], [U(0.18), TV(1.36)], [U(0.36), TV(1.33)], [U(0.44), TV(1.28)], [U(0.5), TV(1.25)], [U(0.56), TV(1.28)], [U(0.64), TV(1.33)], [U(0.82), TV(1.36)], [U(1.01), TV(1.35)],
        [U(1.01), TV(0.96)], [U(0.56), TV(0.96)], [U(0.5), TV(0.92)], [U(0.44), TV(0.96)], [U(-0.01), TV(0.96)]];
      g.save(); polyPath(g, P);
      g.save(); g.translate(1.5, 2.5); g.fillStyle = rgba(INK, 0.5); g.fill(); g.restore();
      g.clip();
      cloth(g, r, r.x, r.y, r.w, r.h, bod, rnd, { folds: 3, light: 0.4, foldW: [2, 4], wrap: true });
      for (let k = 0; k < 12; k++) { const x = U(k / 12 + 0.04); sfold(g, [[x, TV(1.34)], [x, TV(0.97)]], 4, bod, 0.6, { ridge: 1.2 }); }   // boning
      blob(g, U(0.47), TV(1.2), r.w * 0.07, 16, 0, lightOf(bod, 0.5), 0.35, 0.15);
      g.restore();
      trimPath(g, P.slice(0, 9), 2.6);
      for (let k = 0; k < 5; k++) {   // the front lacing
        const y0 = TV(1.0 + k * 0.05), y1 = TV(1.05 + k * 0.05);
        stroke(g, [[U(0.478), y0], [U(0.522), y1]], 1.6, 1.6, '#efe2c0', 0.95); stroke(g, [[U(0.522), y0], [U(0.478), y1]], 1.6, 1.6, '#efe2c0', 0.95);
        for (const s2 of [-1, 1]) rivet(g, U(0.5 + s2 * 0.024), y0, 1.4, '#d8c070');
      }
      stroke(g, [[U(0.5), TV(1.0)], [U(0.5), TV(1.25)]], 2, 2, shadowOf(bod, 0.5), 0.6);
    } else if (S.torso === 'waistcoat' || S.torso === 'vest') {
      // the Dealer: a pressed shirt, a pinstriped vest, the shirt tail tucked into black trousers
      const vest = S.torso === 'vest' ? '#2c2832' : c;
      cloth(g, r, r.x, r.y, r.w, r.h, LINEN, rnd, { folds: 8, wrap: true });
      clipRect(g, r.x, TV(0.975), r.w, r.y + r.h - TV(0.975), () => cloth(g, r, r.x, TV(0.975), r.w, r.y + r.h - TV(0.975), '#28252c', rnd, { folds: 3, wrap: true }));
      g.save(); polyPath(g, [[U(-0.01), TV(0.965)], [U(0.5), TV(0.935)], [U(1.01), TV(0.965)], [U(1.01), TV(1.45)], [U(0.58), TV(1.46)], [U(0.5), TV(1.24)], [U(0.42), TV(1.46)], [U(-0.01), TV(1.45)]]);
      g.save(); g.translate(1.5, 2); g.fillStyle = rgba(INK, 0.45); g.fill(); g.restore();
      g.clip();
      cloth(g, r, r.x, r.y, r.w, r.h, vest, rnd, { folds: 7, light: 0.4, wrap: true });
      if (S.torso === 'vest') { g.save(); g.globalAlpha = 0.14; g.fillStyle = '#c8c0d8'; for (let x = r.x + 3; x < r.x + r.w; x += 7) g.fillRect(x, r.y, 1, r.h); g.restore(); }
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
      // the Repo Man: a plaid flannel shirt; the overalls' trousers below the waist and their
      // braces over the shoulders (the bib itself is modeled, painted in the apron region)
      plaid(g, r.x, r.y, r.w, r.h, '#7d3428', rnd);
      for (let i = 0; i < 8; i++) sfold(g, curve(U(rnd()), TV(1.15 + rnd() * 0.25), U(rnd()), TV(1.1 + rnd() * 0.2), 4), 6, '#7d3428', 0.8);
      const ov = c;
      clipRect(g, r.x, TV(1.04), r.w, r.y + r.h - TV(1.04), () => cloth(g, r, r.x, TV(1.04), r.w, r.y + r.h - TV(1.04), ov, rnd, { folds: 5, light: 0.3, wrap: true }));
      stitches(g, [[r.x, TV(1.03)], [r.x + r.w, TV(1.03)]], '#e0c890', 0.6);
      ao(1.08, 1.035, 0, 0.35);
      for (const s of [-1, 1]) {
        const br = [[U(0.5 + s * 0.11), TV(1.34)], [U(0.5 + s * 0.13), TV(1.46)], [U(0.5 + s * 0.25), TV(1.5)], [U(0.5 + s * 0.4), TV(1.42)], [U(0.5 - s * 0.45), TV(1.06)]];
        stroke(g, br.map(([x, y]) => [x + 1, y + 2]), 12, 12, INK, 0.4);
        stroke(g, br, 11, 11, shadowOf(ov, 0.05), 1);
        stroke(g, br.map(([x, y]) => [x - 2, y - 1]), 2.5, 2.5, lightOf(ov, 0.4), 0.55);
      }
      for (const s of [-1, 1]) { rivet(g, U(0.5 + s * 0.24), TV(1.02), 3.5); rivet(g, U(s < 0 ? 0.03 : 0.97), TV(1.07), 3.5); }
    }
    // common shading: armpits, under the pecs, the skirt's top, the collar
    for (const u of [0.25, 0.75]) { blob(g, U(u), TV(1.34), r.w * 0.08, 26, 0, INK, 0.5, 0.15); blob(g, U(u), TV(1.2), r.w * 0.05, 30, 0, INK, 0.2, 0.1); }
    ao(0.97, 0.93, 0, 0.4);
    bandGrad(g, r, 0.0, 0.05, rgba(INK, 0.35), rgba(INK, 0.0));
    blob(g, U(0.44), TV(1.3), r.w * 0.08, 16, 0, '#fff1c4', 0.14, 0.1);
    bandGrad(g, r, 0.96, 1.0, rgba(INK, 0), rgba(INK, 0.6));
  });
}

// Arms: v = armV(dy). The outer side (back of the hand) is u .25, the inner side (palm) u .75.
function paintArm(g, r, S, rnd) {
  const c = S.color, U = u => RX(r, u), V = v => RY(r, v), AV = dy => V(armV(dy)), av = armV;
  const skin = toneOf(S.tone), LM = ARM_LM, gloved = S.hands !== 'bare';
  const sleeveC = S.arms === 'sleeve' || S.arms === 'rolled' ? c : S.arms === 'flannel' ? '#7d3428' : S.arms === 'blouse' ? LINEN : '#e2d8c4';
  clip(g, r, () => {
    if (S.arms === 'flannel') plaid(g, r.x, r.y, r.w, r.h, sleeveC, rnd);
    else cloth(g, r, r.x, r.y, r.w, r.h, sleeveC, rnd, { folds: 0, light: 0.4, wrap: true });
    // the outer/front of the arm faces the light, the inner side (u .75) turns away
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.14)], [0.3, rgba('#fff1c4', 0.18)], [0.5, rgba('#fff1c4', 0.06)], [0.75, rgba(INK, 0.34)], [1, rgba(INK, 0.14)]]);
    // folds: long drapes from the shoulder, a bunch of short curved ones in the crook of the elbow
    for (let i = 0; i < 6; i++) {
      const u = (i + 0.2 + rnd() * 0.5) / 6;
      sfold(g, curve(U(u), AV(0.02), U(u + range(rnd, -0.05, 0.05)), AV(range(rnd, -0.15, -0.24)), range(rnd, -3, 3), 4), range(rnd, 6, 9), sleeveC, 0.9);
    }
    for (let i = 0; i < 6; i++) { const y = AV(LM.elbow + range(rnd, -0.03, 0.04)); sfold(g, curve(U(0.55 + rnd() * 0.4), y, U(0.08 + rnd() * 0.35), y + range(rnd, -4, 4), 4, 4), 6, sleeveC, 0.95, { dark: 0.6 }); }
    bandGrad(g, r, av(-0.02), av(0.06), rgba('#fff1c4', 0), rgba('#fff1c4', 0.25));
    if (S.arms === 'sleeve') {
      // the sleeve runs on down the forearm and gathers into the gauntlet
      for (let i = 0; i < 7; i++) { const u = (i + rnd() * 0.6) / 7; sfold(g, [[U(u), AV(LM.cuffTop + 0.01)], [U(u + range(rnd, -0.02, 0.02)), AV(LM.cuffTop + range(rnd, 0.05, 0.08))]], 6, sleeveC, 0.95, { dark: 0.6 }); }
      bandGrad(g, r, av(LM.cuffTop), av(LM.cuffTop + 0.03), rgba(INK, 0), rgba(INK, 0.4));
    }
    if (S.arms === 'shirt') {
      // a pressed linen sleeve: a crease down the outside, the cloth bunched above and below a red sleeve garter
      for (let i = 0; i < 4; i++) sfold(g, curve(U(0.1 + i * 0.22), AV(-0.06), U(0.14 + i * 0.22), AV(-0.2), 3, 4), 6, sleeveC, 0.85);
      gradH(g, r.x, AV(-0.02), r.w, AV(LM.wrist) - AV(-0.02), [[0, rgba('#9a98a8', 0.35)], [0.25, rgba('#9a98a8', 0)], [0.6, rgba('#9a98a8', 0.2)], [0.8, rgba('#9a98a8', 0.45)], [1, rgba('#9a98a8', 0.35)]]);
      for (let i = 0; i < 7; i++) { const y = AV(LM.elbow + range(rnd, -0.02, 0.03)); sfold(g, curve(U(0.6 + rnd() * 0.35), y, U(0.05 + rnd() * 0.4), y + range(rnd, -3, 3), 3, 4), 6, '#c8c0b4', 0.95, { dark: 0.5 }); }
      for (let i = 0; i < 8; i++) { const u = (i + rnd() * 0.5) / 8; sfold(g, [[U(u), AV(-0.135)], [U(u + 0.01), AV(-0.1)]], 5, sleeveC, 0.9); sfold(g, [[U(u), AV(-0.17)], [U(u + 0.01), AV(-0.14)]], 5, sleeveC, 0.8); }
      band(g, r, av(-0.135), av(-0.108), S.outfit === 'dealer' ? '#9a2a2a' : '#2d2a3a', 1);
      bandGrad(g, r, av(-0.135), av(-0.108), rgba('#fff0d0', 0.3), rgba(INK, 0.35));
      rivet(g, U(0.25), AV(-0.121), 2, '#d8c070');
    }
    if (S.arms === 'blouse') {
      // puffed linen sleeve gathered at the elbow with a ribbon in her color
      for (let i = 0; i < 9; i++) { const u = (i + 0.3) / 9; sfold(g, [[U(u), AV(0.04)], [U(u + 0.01), AV(-0.13)], [U(u - 0.01), AV(LM.elbow + 0.02)]], 6, sleeveC, 0.8); }
      band(g, r, av(LM.elbow - 0.012), av(LM.elbow + 0.012), c, 1);
      bandGrad(g, r, av(LM.elbow - 0.012), av(LM.elbow + 0.012), rgba('#fff0d0', 0.35), rgba(INK, 0.35));
      for (let i = 0; i < 6; i++) sfold(g, [[U(i / 6 + 0.05), AV(LM.elbow - 0.03)], [U(i / 6 + 0.07), AV(LM.wrist + 0.06)]], 4.5, sleeveC, 0.6);
    }
    if (S.arms === 'flannel') {
      for (let i = 0; i < 5; i++) { const y = AV(LM.elbow + range(rnd, -0.02, 0.04)); sfold(g, curve(U(0.6 + rnd() * 0.35), y, U(0.05 + rnd() * 0.4), y + range(rnd, -3, 3), 3, 4), 7, sleeveC, 0.9); }
      // rolled to the forearm, a turned cuff
      band(g, r, av(LM.cuffTop + 0.02), av(LM.cuffTop + 0.05), shadowOf(sleeveC, 0.1), 1);
      bandGrad(g, r, av(LM.cuffTop + 0.035), av(LM.cuffTop + 0.05), rgba('#fff0d0', 0.3), rgba('#fff0d0', 0));
    }
    if (S.arms === 'rolled') {
      // the sleeve rolled up above the elbow; a hairy bare forearm below
      const top = LM.elbow + 0.03;
      clipRect(g, r.x, AV(top), r.w, r.y + r.h - AV(top), () => {
        gradV(g, r.x, AV(top), r.w, AV(LM.wrist) - AV(top), [[0, skin.light], [0.5, skin.base], [1, skin.shadow]]);
        gradH(g, r.x, AV(top), r.w, AV(LM.wrist) - AV(top), [[0, rgba(INK, 0.1)], [0.25, rgba('#fff1c4', 0.15)], [0.75, rgba(INK, 0.3)], [1, rgba(INK, 0.1)]]);
        for (const u of [0.2, 0.32]) blob(g, U(u), AV(-0.37), r.w * 0.1, 16, 0, skin.light, 0.35, 0.2);    // the forearm's swell catches light
        for (let i = 0; i < 34; i++) { const x = U(rnd() * 0.6), y = AV(top - 0.02 - rnd() * 0.2); stroke(g, [[x, y], [x + 1.5, y + 3]], 1.1, 0.4, shadowOf(S.look.hairColor, 0.1), 0.3); }
      });
      band(g, r, av(top - 0.005), av(top + 0.045), lightOf(c, 0.15), 1);
      for (let i = 0; i < 6; i++) sfold(g, [[U(i / 6), AV(top + 0.04)], [U(i / 6 + 0.04), AV(top + 0.005)]], 5, lightOf(c, 0.15), 0.9);
      hstitch(g, r, av(top + 0.02), shadowOf(c, 0.4), 0.6);
      bandGrad(g, r, av(top - 0.035), av(top), rgba(INK, 0.0), rgba(INK, 0.4));
      bandGrad(g, r, av(top + 0.045), av(top + 0.065), rgba(INK, 0.35), rgba(INK, 0));
    }
    // hands: bare, or big gloves with a flared gauntlet cuff. Fingers lie side by side across
    // the back (u .19 .25 .31) and the palm (u .69 .75 .81) and end at the bottom (v 0).
    const fingers = (base, deep, light, tipC) => {
      for (const u of [0.185, 0.25, 0.315]) { stroke(g, [[U(u), V(0.0)], [U(u), AV(LM.knuckle - 0.005)]], 2.4, 1.6, deep, 0.7); stroke(g, [[U(u) - 2, V(0.0)], [U(u) - 2, AV(LM.knuckle - 0.005)]], 1.4, 1, light, 0.35); }
      for (const u of [0.685, 0.75, 0.815]) stroke(g, [[U(u), V(0.0)], [U(u), AV(-0.69)]], 2, 1.4, deep, 0.6);
      for (const u of [0.15, 0.218, 0.282, 0.35]) { blob(g, U(u), AV(LM.knuckle + 0.004), 4, 3, 0, light, 0.7, 0.3); blob(g, U(u), AV(-0.725), 3.5, 2.5, 0, light, 0.4, 0.3); blob(g, U(u), V(0.03), 3.5, 2.6, 0, tipC, 0.6, 0.35); }
      bandGrad(g, r, av(LM.knuckle - 0.016), av(LM.knuckle - 0.004), rgba(deep, 0), rgba(deep, 0.35));
      blob(g, U(0.75), AV(-0.63), 12, 8, 0, deep, 0.4, 0.2);     // the palm in shade
      bandGrad(g, r, 0, 0.035, rgba(INK, 0.3), rgba(INK, 0));
    };
    if (!gloved) {
      const top = S.arms === 'rolled' ? LM.wrist + 0.03 : LM.wrist + 0.01;
      clipRect(g, r.x, AV(top), r.w, r.y + r.h - AV(top), () => {
        gradV(g, r.x, AV(top), r.w, r.y + r.h - AV(top), [[0, skin.light], [0.5, skin.base], [1, skin.shadow]]);
        gradH(g, r.x, AV(top), r.w, r.y + r.h - AV(top), [[0, rgba(INK, 0.08)], [0.25, rgba('#fff1c4', 0.16)], [0.75, rgba(skin.blush, 0.25)], [1, rgba(INK, 0.08)]]);
        fingers(skin.base, skin.deep, skin.hi, mix(skin.light, '#f4d8c8', 0.5));
        for (const u of [0.15, 0.218, 0.282, 0.35]) blob(g, U(u), V(0.022), 2.6, 1.8, 0, mix(skin.hi, '#f8e4dc', 0.5), 0.75, 0.5);   // nails
      });
      if (S.arms === 'shirt') { band(g, r, av(LM.wrist + 0.005), av(LM.wrist + 0.035), '#efe6d2', 1); rivet(g, U(0.25), AV(LM.wrist + 0.02), 1.8, '#c8c8d0'); bandGrad(g, r, av(LM.wrist - 0.01), av(LM.wrist + 0.005), rgba(INK, 0), rgba(INK, 0.35)); }
    } else {
      const work = S.hands === 'workglove';
      const gl = work ? '#a8834f' : '#6e4a2c', cuffC = work ? '#7a5a36' : SUEDE;
      clipRect(g, r.x, AV(LM.wrist), r.w, r.y + r.h - AV(LM.wrist), () => {
        leather(g, r, r.x, AV(LM.wrist), r.w, r.y + r.h - AV(LM.wrist), gl, rnd, { creases: 5, scuffs: 8, wrap: true, light: 0.4, sheen: 0.3 });
        blob(g, U(0.25), AV(-0.63), r.w * 0.14, 12, 0, lightOf(gl, 0.45), 0.35, 0.15);     // the back of the hand catches the light
        fingers(gl, shadowOf(gl, 0.6), lightOf(gl, 0.55), lightOf(gl, 0.35));
        if (!work) stitches(g, [[U(0.15), AV(-0.6)], [U(0.35), AV(-0.6)], [U(0.35), AV(-0.65)], [U(0.15), AV(-0.65)], [U(0.15), AV(-0.6)]], '#e2c898', 0.55);
        else stitches(g, [[U(0.12), AV(-0.6)], [U(0.38), AV(-0.6)]], '#5a4020', 0.6);
      });
      // the gauntlet: a rolled rim flaring over the forearm, a band of your color, riveted, tapering to the wrist
      clipRect(g, r.x, AV(LM.cuffTop), r.w, AV(LM.wrist) - AV(LM.cuffTop), () => {
        leather(g, r, r.x, AV(LM.cuffTop), r.w, AV(LM.wrist) - AV(LM.cuffTop), cuffC, rnd, { creases: 4, scuffs: 8, wrap: true, light: 0.42 });
        gradV(g, r.x, AV(LM.cuffTop), r.w, AV(LM.cuffRim + 0.004) - AV(LM.cuffTop), [[0, lightOf(cuffC, 0.7)], [0.45, lightOf(cuffC, 0.25)], [1, shadowOf(cuffC, 0.5)]]);
        if (!work) { band(g, r, av(LM.cuffBot - 0.002), av(LM.cuffRim - 0.008), S.bright || c, 1); bandGrad(g, r, av(LM.cuffBot - 0.002), av(LM.cuffRim - 0.008), rgba('#fff0c8', 0.3), rgba(INK, 0.3)); }
        for (let k = 0; k < 5; k++) rivet(g, U((k + 0.5) / 5), AV(work ? LM.cuffRim - 0.012 : (LM.cuffBot + LM.cuffRim) / 2 - 0.004), work ? 2 : 2.2, work ? IRON : BRASS);
        stitches(g, [[r.x, AV(LM.wrist + 0.012)], [r.x + r.w, AV(LM.wrist + 0.012)]], '#d8bc8a', 0.5);
        wear(g, along(r.x, AV(LM.cuffTop + 0.003), r.x + r.w, AV(LM.cuffTop + 0.003), 10), cuffC, 1.6, 0.4, rnd);
      });
      bandGrad(g, r, av(LM.wrist - 0.012), av(LM.wrist + 0.008), rgba(INK, 0), rgba(INK, 0.4));
    }
    // the armpit side (inner, u .75) in shade; the top of the arm under the pauldron
    blob(g, U(0.75), AV(-0.06), r.w * 0.14, 30, 0, INK, 0.3, 0.1);
    if (S.pauldrons !== 'none') bandGrad(g, r, av(0.0), 1.0, rgba(INK, 0), rgba(INK, 0.5));
    else {
      // no pauldron: the sleeve cap is lit from above, with the armhole seam just below it
      bandGrad(g, r, av(0.0), 1.0, rgba('#fff1c4', 0), rgba('#fff1c4', 0.3));
      hstitch(g, r, av(-0.012), shadowOf(sleeveC, 0.5), 0.5);
      bandGrad(g, r, av(-0.04), av(-0.012), rgba(INK, 0), rgba(INK, 0.22));
    }
  });
}

// Legs: v = height above the sole. u .5 the front (shin, knee), u .25 the outer side, u .75 the inner.
function paintLeg(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    const pants = S.legs === 'trousers' ? TROUSER : S.legs === 'wool' ? '#4c4a52' : S.legs === 'black' ? '#28252c' : S.color;
    cloth(g, r, r.x, r.y, r.w, r.h, pants, rnd, { folds: 5, foldAngle: 0, foldLen: [0.1, 0.2], wrap: true });
    for (let i = 0; i < 5; i++) sfold(g, curve(U(0.88 + rnd() * 0.24 - 0.12), V(0.5 + rnd() * 0.06), U(0.1 + rnd() * 0.2), V(0.5 + rnd() * 0.06), 3), 6, pants, 0.9, { dark: 0.6 });  // behind the knee
    for (let i = 0; i < 3; i++) sfold(g, curve(U(0.36 + rnd() * 0.1), V(0.62 + rnd() * 0.05), U(0.56 + rnd() * 0.1), V(0.58 + rnd() * 0.05), 3, 3), 5, pants, 0.7);       // over the knee
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.15)], [0.35, rgba('#fff1c4', 0.1)], [0.5, rgba('#fff1c4', 0.14)], [0.75, rgba(INK, 0.3)], [1, rgba(INK, 0.15)]]);
    for (const u of [0.25, 0.75]) stitches(g, [[U(u), V(0.47)], [U(u), V(1)]], S.legs === 'overalls' ? '#e0c890' : INK, 0.5);
    blob(g, U(0.5), V(0.53), r.w * 0.12, 11, 0, lightOf(pants, 0.45), 0.35, 0.2);   // knee
    if (S.legs === 'trousers') {
      g.save(); g.beginPath(); g.roundRect(U(0.4), V(0.6), r.w * 0.2, V(0.49) - V(0.6), 3); g.clip();
      leather(g, r, U(0.4), V(0.6), r.w * 0.2, V(0.49) - V(0.6), '#6e5038', rnd, { creases: 2, scuffs: 4 });
      g.restore();
      stitches(g, [[U(0.4), V(0.6)], [U(0.6), V(0.6)], [U(0.6), V(0.49)], [U(0.4), V(0.49)], [U(0.4), V(0.6)]], INK, 0.55);
      wear(g, along(U(0.41), V(0.595), U(0.59), V(0.595), 5), '#6e5038', 1.4, 0.4, rnd);
    }
    bandGrad(g, r, 0.84, 1.0, rgba(INK, 0), rgba(INK, 0.55));        // in the skirt's shade
    blob(g, U(0.75), V(0.85), r.w * 0.12, 30, 0, INK, 0.3, 0.1);       // inner thigh
    // boots
    const boot = S.outfit === 'repo' ? '#3a2b22' : S.boots === 'shoe' ? '#2d2428' : LEATHER_D;
    const top = S.boots === 'tall' ? 0.48 : S.boots === 'short' ? 0.3 : S.boots === 'work' ? 0.278 : 0.16;
    if (S.boots === 'work') {   // the trouser legs bunch over the boot tops
      for (let i = 0; i < 8; i++) { const u = (i + rnd() * 0.6) / 8; sfold(g, curve(U(u), V(0.37), U(u + range(rnd, -0.06, 0.06)), V(0.29), range(rnd, -3, 3), 3), 6, pants, 0.95, { dark: 0.6 }); }
      for (let i = 0; i < 3; i++) { const y = V(0.3 + i * 0.025); sfold(g, curve(r.x, y, r.x + r.w, y + range(rnd, -2, 2), 2, 6), 5, pants, 0.8); }
      wear(g, along(r.x, V(0.284), r.x + r.w, V(0.284), 12), pants, 2, 0.4, rnd);
    }
    clipRect(g, r.x, V(top), r.w, r.y + r.h - V(top), () => {
      leather(g, r, r.x, V(top), r.w, r.y + r.h - V(top), boot, rnd, { creases: 6, scuffs: 10, wrap: true, light: 0.4 });
      for (let i = 0; i < 6; i++) sfold(g, curve(U(0.32 + rnd() * 0.36), V(0.1 + rnd() * 0.05), U(0.32 + rnd() * 0.36), V(0.14 + rnd() * 0.06), 2), 5, boot, 0.85, { dark: 0.6 });   // ankle creases
      blob(g, U(0.5), V(Math.max(0.2, top - 0.12)), r.w * 0.14, 20, 0, lightOf(boot, 0.55), 0.38, 0.2);     // the shin of the boot catches the light
      gradH(g, r.x, V(top), r.w, r.y + r.h - V(top), [[0, rgba(INK, 0.2)], [0.4, rgba('#fff1c4', 0.08)], [0.75, rgba(INK, 0.28)], [1, rgba(INK, 0.2)]]);
    });
    bandGrad(g, r, top, top + 0.03, rgba(INK, 0.0), rgba(INK, 0.45));
    if (S.boots === 'tall') {
      // the turned-down suede cuff (lit on its rolled top, dark under), a strap and buckle round the ankle
      const cuff = SUEDE;
      clipRect(g, r.x, V(0.478), r.w, V(0.4) - V(0.478), () => leather(g, r, r.x, V(0.478), r.w, V(0.4) - V(0.478), cuff, rnd, { creases: 3, scuffs: 6, wrap: true, light: 0.45 }));
      bandGrad(g, r, 0.455, 0.48, rgba(lightOf(cuff, 0.6), 0.8), rgba(lightOf(cuff, 0.6), 0));
      for (let i = 0; i < 6; i++) { const u = (i + rnd() * 0.5) / 6; sfold(g, [[U(u), V(0.47)], [U(u + 0.02), V(0.41)]], 5, cuff, 0.8); }
      wear(g, along(r.x, V(0.476), r.x + r.w, V(0.476), 10), cuff, 1.6, 0.45, rnd);
      hstitch(g, r, 0.41, '#e8d0a0', 0.5);
      bandGrad(g, r, 0.375, 0.4, rgba(INK, 0.0), rgba(INK, 0.6));
      band(g, r, 0.19, 0.225, '#3a261a', 1); hstitch(g, r, 0.207, '#c8a070', 0.4);
      buckle(g, U(0.25), V(0.207), 6, 7);
    }
    if (S.boots === 'work') { band(g, r, 0.06, 0.09, '#2a1e18', 0.8); for (let k = 0; k < 4; k++) { const y = V(0.13 + k * 0.035); stroke(g, [[U(0.44), y], [U(0.56), y - 3]], 1.4, 1.4, '#b8a080', 0.8); stroke(g, [[U(0.56), y], [U(0.44), y - 3]], 1.4, 1.4, '#b8a080', 0.8); } }
    bandGrad(g, r, 0.0, 0.08, rgba(INK, 0.4), rgba(INK, 0));
  });
}

function paintFoot(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  const boot = S.outfit === 'repo' ? '#3a2b22' : S.boots === 'shoe' ? '#2d2428' : LEATHER_D;
  clip(g, r, () => {
    leather(g, r, r.x, r.y, r.w, r.h, boot, rnd, { creases: 5, scuffs: 10, light: 0.3, wrap: true });
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.5)], [0.3, rgba(INK, 0)], [0.5, rgba('#fff0c8', 0.14)], [0.7, rgba(INK, 0)], [1, rgba(INK, 0.5)]]);
    blob(g, U(0.5), V(0.86), r.w * 0.26, r.h * 0.1, 0, S.outfit === 'repo' ? '#9a9aa2' : lightOf(boot, 0.6), S.outfit === 'repo' ? 0.55 : 0.5, 0.2);   // the toe cap
    for (let i = 0; i < 4; i++) sfold(g, curve(U(0.35 + rnd() * 0.1), V(0.5 + i * 0.05), U(0.55 + rnd() * 0.1), V(0.52 + i * 0.05), 2, 3), 4, boot, 0.7);   // creases across the instep
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
  if (S.dress) return paintDress(g, r, S, rnd);
  clip(g, r, () => {
    const base = mix(LEATHER, '#5a3c26', 0.4);
    for (let q = 0; q < 4; q++) {
      const x0 = r.x + q * r.w / 4, w = r.w / 4;
      // each panel: two tassets (vertical strips), lit in the middle, seams between
      for (let k = 0; k < 2; k++) {
        const sx = x0 + k * w / 2, sw = w / 2;
        clipRect(g, sx, r.y, sw, r.h, () => {
          leather(g, null, sx, r.y, sw, r.h, shade(base, 0.95 + 0.1 * rnd()), rnd, { creases: 3, scuffs: 6, light: 0.38, sheen: 0.3 });
          gradH(g, sx, r.y, sw, r.h, [[0, rgba(INK, 0.5)], [0.2, rgba(INK, 0)], [0.45, rgba('#fff1c4', 0.14)], [0.8, rgba(INK, 0)], [1, rgba(INK, 0.55)]]);
          stitches(g, [[sx + 3, V(0.97)], [sx + 3, V(0.1)], [sx + sw - 3, V(0.1)], [sx + sw - 3, V(0.97)]], '#d8bc8a', 0.5, 2.4, 2);
          wear(g, along(sx + 1.5, V(0.08), sx + 1.5, V(0.95), 6), base, 1.6, 0.35, rnd);
        });
        rivet(g, sx + sw / 2, V(0.88), 2.4);
      }
      // the hem: a darker rolled edge, worn pale along its lip
      g.save(); g.fillStyle = shadowOf(base, 0.45); g.fillRect(x0, V(0.07), w, V(0) - V(0.07) + 2); g.restore();
      wear(g, along(x0, V(0.075), x0 + w, V(0.075), 6), base, 1.6, 0.5, rnd);
    }
    bandGrad(g, r, 0.8, 1.0, rgba(INK, 0), rgba(INK, 0.6));     // under the belt
    bandGrad(g, r, 0.0, 0.25, rgba(INK, 0.3), rgba(INK, 0));
  });
}

// The clerk's long skirt: deep dyed wool gathered at the waist, a cream apron at the
// front (u .5), a trimmed hem. u runs round the skirt, v from the hem (0) to the waist (1).
function paintDress(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  const sk = mix(shade(S.color, 0.72), '#3a2636', 0.25);
  clip(g, r, () => {
    cloth(g, r, r.x, r.y, r.w, r.h, sk, rnd, { folds: 0, light: 0.3, blotch: 14, wrap: true });
    // gathers: soft vertical folds that widen toward the hem
    for (let i = 0; i < 22; i++) {
      const u = (i + rnd() * 0.6) / 22, x0 = U(u), x1 = x0 + range(rnd, -4, 4);
      sfold(g, [[x0, V(0.98)], [(x0 + x1) / 2, V(0.5)], [x1, V(0.04)]], range(rnd, 5, 8), sk, 0.8, { ridge: 1.1 });
    }
    // the apron
    g.save(); polyPath(g, [[U(0.4), V(0.98)], [U(0.6), V(0.98)], [U(0.63), V(0.22)], [U(0.6), V(0.18)], [U(0.4), V(0.18)], [U(0.37), V(0.22)]]);
    g.save(); g.translate(1.5, 2); g.fillStyle = rgba(INK, 0.45); g.fill(); g.restore();
    g.clip();
    cloth(g, r, U(0.36), r.y, r.w * 0.28, r.h, LINEN, rnd, { folds: 0, light: 0.3, blotch: 6 });
    for (let i = 0; i < 6; i++) { const x = U(0.41 + i * 0.035); sfold(g, [[x, V(0.95)], [x + range(rnd, -2, 2), V(0.2)]], 4, LINEN, 0.6); }
    g.restore();
    stitches(g, [[U(0.405), V(0.22)], [U(0.595), V(0.22)]], '#8a6a4a', 0.6);
    // the hem band, and the waistband in the bodice color
    band(g, r, 0.0, 0.08, shadowOf(sk, 0.3), 1);
    trimH(g, r.x, r.x + r.w, V(0.11), 3.2);
    band(g, r, 0.93, 1.0, shade(S.color, 0.9), 1);
    bandGrad(g, r, 0.86, 0.93, rgba(INK, 0), rgba(INK, 0.45));
    bandGrad(g, r, 0.0, 0.1, rgba(INK, 0.35), rgba(INK, 0));
  });
}

// A tabard flap (u across, v up): the player's dye, gold trim, an embroidered band.
function paintFlap(g, r, S, rnd, back) {
  const c = S.color, U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    cloth(g, null, r.x, r.y, r.w, r.h, c, rnd, { folds: 0, light: 0.3, blotch: 8 });
    for (let i = 0; i < 4; i++) { const u = 0.15 + i * 0.23 + range(rnd, -0.04, 0.04); sfold(g, curve(U(u), V(0.95), U(u + range(rnd, -0.05, 0.05)), V(0.22), range(rnd, -3, 3), 5), range(rnd, 6, 9), c, 0.95, { dark: 0.6 }); }
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.35)], [0.25, rgba(INK, 0)], [0.75, rgba(INK, 0)], [1, rgba(INK, 0.35)]]);
    // embroidered band near the hem
    trimH(g, r.x, r.x + r.w, V(0.2), 3.5);
    g.save(); g.fillStyle = shadowOf(c, 0.35); g.fillRect(r.x, V(0.19), r.w, V(0.11) - V(0.19)); g.restore();
    for (let x = r.x + 4; x < r.x + r.w - 2; x += 9) { g.save(); polyPath(g, [[x, V(0.15)], [x + 4, V(0.185)], [x + 8, V(0.15)], [x + 4, V(0.115)]]); g.fillStyle = TRIM; g.globalAlpha = 0.9; g.fill(); g.restore(); }
    trimH(g, r.x, r.x + r.w, V(0.11), 3.5);
    // gold trim down both edges and along the hem, worn at the hem
    trimPath(g, [[U(0.06), V(1.02)], [U(0.06), V(0.04)], [U(0.94), V(0.04)], [U(0.94), V(1.02)]], 3.2);
    wear(g, along(U(0.06), V(0.02), U(0.94), V(0.02), 8), c, 1.8, 0.45, rnd);
    if (!back) wheelEmblem(g, U(0.5), V(0.62), r.w * 0.17);
    bandGrad(g, r, 0.82, 1.0, rgba(INK, 0), rgba(INK, 0.55));
    bandGrad(g, r, 0.0, 0.06, rgba(INK, 0.35), rgba(INK, 0));
  });
}

// The neckline (v 0 = its top against the neck, v 1 = where it meets the chest).
function paintCollar(g, r, S, rnd) {
  clip(g, r, () => {
    const base = S.outfit === 'player' ? shadowOf(S.color, 0.22) : S.outfit === 'dealer' ? '#e8e2d4' : LINEN;
    cloth(g, r, r.x, r.y, r.w, r.h, base, rnd, { folds: 3, light: 0.2, wrap: true, foldW: [2, 3] });
    bandGrad(g, r, 0.3, 0.7, rgba(lightOf(base, 0.5), 0.45), rgba(lightOf(base, 0.5), 0));    // the rolled edge catches the light
    bandGrad(g, r, 0.0, 0.25, rgba(INK, 0), rgba(INK, 0.4));
    bandGrad(g, r, 0.8, 1.0, rgba(INK, 0.45), rgba(INK, 0));
    if (S.outfit === 'player') hstitch(g, r, 0.55, '#d8bc8a', 0.45);
  });
}

// Pauldrons: a big domed shell (v .32-1, the rim at the bottom) and a hanging lame
// (v 0-.28). Leather plates boiled hard with a riveted iron rim, or steel plates for
// helm/cap/bandana wearers. The player's color is only a narrow cloth edge peeking out under the lame.
function paintPauldron(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  const metal = S.paulMetal;
  const base = metal ? '#8e929c' : '#7a5232';
  const rimC = metal ? '#b8a070' : '#6e7078';
  clip(g, r, () => {
    const dome = { x: r.x, y: V(1), w: r.w, h: V(0.32) - V(1) };
    if (metal) {
      gradV(g, dome.x, dome.y, dome.w, dome.h, [[0, '#eef0f4'], [0.3, '#b4b8c2'], [0.7, base], [1, '#4c4e5a']]);
      for (let i = 0; i < 12; i++) wblob(g, r, r.x + rnd() * r.w, dome.y + rnd() * dome.h, range(rnd, 6, 18), range(rnd, 3, 8), rnd() * 3, pick(rnd, ['#6a6272', '#c4c8d0', '#5a5c66', '#8a7a6a']), 0.26, 0.2);
      for (let i = 0; i < 14; i++) { const x = U(rnd()), y = V(0.45 + rnd() * 0.5); stroke(g, [[x, y], [x + range(rnd, -6, 6), y + range(rnd, -1.5, 1.5)]], 0.8, 0.3, '#f6f8fc', 0.4); }
    } else {
      leather(g, r, dome.x, dome.y, dome.w, dome.h, base, rnd, { creases: 5, scuffs: 14, light: 0.5, wrap: true });
    }
    // overlapping plates: each plate's lower edge is lit, the next one up casts a shadow on it
    for (const v of [0.56, 0.78]) {
      bandGrad(g, r, v - 0.07, v, rgba(INK, 0), rgba(INK, 0.5));
      band(g, r, v, v + 0.025, lightOf(base, 0.7), 0.6);
      for (let k = 0; k < 10; k++) rivet(g, U((k + (v > 0.6 ? 0.5 : 0)) / 10 + 0.025), V(v + 0.05), 1.7, metal ? '#d8d2c0' : '#b8bcc4');
    }
    // a seam down the middle of each plate
    for (let k = 0; k < 4; k++) { const u = (k + 0.5) / 4; sfold(g, [[U(u), V(0.97)], [U(u), V(0.4)]], 4, base, 0.55, { ridge: 1.3 }); }
    bandGrad(g, r, 0.78, 1.0, rgba('#fff0c8', 0.0), rgba('#fff0c8', 0.4));    // the cap of the dome catches the sun
    // the rolled rim: iron (or brass on steel), riveted
    gradV(g, r.x, V(0.43), r.w, V(0.32) - V(0.43), [[0, lightOf(rimC, 0.8)], [0.4, rimC], [1, shadowOf(rimC, 0.6)]]);
    for (let k = 0; k < 9; k++) rivet(g, U((k + 0.5) / 9), V(0.375), 2.4, metal ? '#e0c890' : '#c8ccd4');
    bandGrad(g, r, 0.43, 0.48, rgba(INK, 0.45), rgba(INK, 0));
    // the lame: darker leather with a narrow strip of the player's cloth showing under it
    const lame = { x: r.x, y: V(0.3), w: r.w, h: V(0) - V(0.3) };
    leather(g, r, lame.x, lame.y, lame.w, lame.h, shadowOf(metal ? '#6a5040' : base, 0.15), rnd, { creases: 3, scuffs: 6, light: 0.45, wrap: true });
    band(g, r, 0.0, 0.06, S.color, 1);
    bandGrad(g, r, 0.0, 0.06, rgba(INK, 0.35), rgba('#fff0c8', 0.15));
    hstitch(g, r, 0.13, '#d8bc8a', 0.55);
    for (let k = 0; k < 7; k++) rivet(g, U((k + 0.3) / 7), V(0.2), 2, metal ? '#c8ccd4' : BRASS);
    bandGrad(g, r, 0.22, 0.3, rgba(INK, 0), rgba(INK, 0.55));
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

// The hair shell: u around the head (linear), v from the hairline (0) up to the crown (1).
function paintHairRegion(g, r, S, rnd) {
  const hc = S.look.hairColor, thOfU = u => Math.PI - TAU * u;
  clip(g, r, () => {
    gradV(g, r.x, r.y, r.w, r.h, [[0, lightOf(hc, 0.12)], [0.5, hc], [1, shadowOf(hc, 0.3)]]);
    hairFlow(g, hc, rnd, { x0: r.x, x1: r.x + r.w, count: 7, width: [15, 21], wrapW: r.w, ys: () => r.y + r.h + 3, ye: () => r.y - 6, lean: x => -Math.sin(thOfU((x - r.x) / r.w)) * 0.32, sheen: 0.5 });
    bandGrad(g, r, 0.0, 0.08, rgba(INK, 0.3), rgba(INK, 0));
  });
}
// Beards, manes, braids and buns: long clumps hanging down (v 1 = the roots, at the top).
function paintBeardRegion(g, r, S, rnd) {
  const hc = S.look.hairColor;
  clip(g, r, () => {
    locks(g, r, r.x, r.y, r.w, r.h, hc, rnd, { count: 7, len: [0.55, 1.0], width: [8, 12], sheen: 0.34, wrap: true });
    bandGrad(g, r, 0.88, 1.0, rgba(mix(shadowOf(hc, 0.5), INK, 0.2), 0), rgba(mix(shadowOf(hc, 0.5), INK, 0.2), 0.6));   // dark roots against the skin
    if (S.look.hair === 'braid' || S.look.hair === 'bun') for (let k = 0; k < 9; k++) {   // braid lobes
      const y = r.y + (k + 0.5) / 9 * r.h;
      sfold(g, curve(r.x, y - 4, r.x + r.w, y + 4, 0, 4), 5, hc, 0.8);
    }
  });
}
function paintEar(g, r, S) {
  const T = toneOf(S.tone);
  clip(g, r, () => {
    gradV(g, r.x, r.y, r.w, r.h, [[0, T.light], [0.5, T.blush], [1, T.shadow]]);
    blob(g, RX(r, 0.5), RY(r, 0.5), r.w * 0.22, r.h * 0.32, 0, T.deep, 0.65, 0.2);      // the bowl
    blob(g, RX(r, 0.35), RY(r, 0.75), r.w * 0.2, r.h * 0.15, 0, T.hi, 0.5, 0.2);        // the lit rim of the helix
    bandGrad(g, r, 0.0, 0.25, rgba(T.deep, 0.5), rgba(T.deep, 0));
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
  if (S.outfit === 'player') return paintMapSheet(g, r, rnd);
  clip(g, r, () => {
    // lenses: dark glass reflecting a sky gradient and a hard white glint
    gradV(g, r.x, V(1), r.w, V(0.75) - V(1), [[0, '#6a7c96'], [0.45, '#2a3040'], [0.55, '#1e1a24'], [1, '#3a3028']]);
    stroke(g, [[RX(r, 0.2), V(0.97)], [RX(r, 0.45), V(0.78)]], 4, 3, '#e8f0ff', 0.55);
    stroke(g, [[RX(r, 0.5), V(0.98)], [RX(r, 0.62), V(0.86)]], 2, 1.5, '#e8f0ff', 0.4);
    // brass frame
    gradV(g, r.x, V(0.74), r.w, V(0.62) - V(0.74), [[0, '#f4dc98'], [0.5, BRASS], [1, '#5e4418']]);
    // the chain (v 0-.6, one stretch of links repeating along the tube): iron links, alternating
    // face-on and edge-on, lit on top, with dark gaps between them so it reads as metal
    gradV(g, r.x, V(0.6), r.w, V(0) - V(0.6), [[0, '#2e2c38'], [1, '#22202a']]);
    const n = 6, lh = (V(0) - V(0.6)) / n, cx = r.x + r.w / 2;
    for (let k = 0; k < n; k++) {
      const y = V(0.6) + (k + 0.5) * lh;
      if (k % 2) {
        g.save(); g.lineWidth = lh * 0.32; g.strokeStyle = '#3a3a48'; g.beginPath(); g.ellipse(cx + 0.8, y + 1, r.w * 0.34, lh * 0.5, 0, 0, Math.PI * 2); g.stroke();
        g.strokeStyle = '#7d8088'; g.beginPath(); g.ellipse(cx, y, r.w * 0.34, lh * 0.5, 0, 0, Math.PI * 2); g.stroke();
        g.lineWidth = lh * 0.12; g.strokeStyle = '#b8bcc4'; g.beginPath(); g.ellipse(cx - 1, y - 1, r.w * 0.34, lh * 0.5, 0, Math.PI * 0.95, Math.PI * 1.75); g.stroke(); g.restore();
      } else {
        g.save(); g.fillStyle = '#3a3a48'; g.fillRect(cx - r.w * 0.11 + 1, y - lh * 0.62, r.w * 0.22, lh * 1.24);
        g.fillStyle = '#7d8088'; g.fillRect(cx - r.w * 0.11, y - lh * 0.62, r.w * 0.2, lh * 1.2);
        g.fillStyle = '#b8bcc4'; g.fillRect(cx - r.w * 0.1, y - lh * 0.6, r.w * 0.06, lh * 1.1); g.restore();
      }
      for (let i = 0; i < 2; i++) blob(g, cx + range(rnd, -r.w * 0.3, r.w * 0.3), y + (rnd() - 0.5) * lh, range(rnd, 2, 4), 2, 0, '#8a4a2a', 0.35, 0.3);   // rust
    }
  });
}
// A player's road map, held up in third person (the gear region; players wear no NPC gear):
// creased parchment, a winding road in brown ink, a few marks, darker worn edges.
function paintMapSheet(g, r, rnd) {
  clip(g, r, () => {
    gradV(g, r.x, r.y, r.w, r.h, [[0, '#efe0b8'], [0.5, '#e2cf9e'], [1, '#c9b07a']]);
    for (let i = 0; i < 8; i++) blob(g, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 6, 16), range(rnd, 6, 16), 0, pick(rnd, ['#b8975e', '#f4e8c8']), 0.25, 0.1);
    for (const f of [0.33, 0.66]) { stroke(g, [[r.x, r.y + r.h * f], [r.x + r.w, r.y + r.h * f]], 1.6, 1.6, '#a88a58', 0.6); stroke(g, [[r.x, r.y + r.h * f - 1.5], [r.x + r.w, r.y + r.h * f - 1.5]], 1, 1, '#fff4d8', 0.5); }
    stroke(g, [[r.x + r.w / 2, r.y], [r.x + r.w / 2, r.y + r.h]], 1.4, 1.4, '#a88a58', 0.5);
    stroke(g, [[r.x + 8, r.y + r.h - 8], [r.x + 22, r.y + r.h * 0.7], [r.x + 14, r.y + r.h * 0.45], [r.x + 36, r.y + r.h * 0.3], [r.x + 30, r.y + 10]], 2.4, 2.4, '#6a4426', 0.85);   // the road
    for (const [u, v] of [[0.3, 0.75], [0.62, 0.3], [0.5, 0.55]]) ellipse(g, RX(r, u), RY(r, v), 2.4, 2.4, 0, '#8a2a20', 0.85);
    stroke(g, [[RX(r, 0.6), RY(r, 0.12)], [RX(r, 0.72), RY(r, 0.2)]], 1.6, 1.6, '#8a2a20', 0.8); stroke(g, [[RX(r, 0.72), RY(r, 0.12)], [RX(r, 0.6), RY(r, 0.2)]], 1.6, 1.6, '#8a2a20', 0.8);   // X marks the pawn shop
    for (const [x0, y0, x1, y1] of [[r.x, r.y, r.x + r.w, r.y], [r.x, r.y + r.h, r.x + r.w, r.y + r.h], [r.x, r.y, r.x, r.y + r.h], [r.x + r.w, r.y, r.x + r.w, r.y + r.h]]) stroke(g, [[x0, y0], [x1, y1]], 6, 6, '#a8875a', 0.45);
  });
}

// The bedroll strapped high on a player's back (256 × 64): the roll (v .4-1: u around it,
// v along it; u .25 is its top) and its spiral end (v 0-.38, mapped round the center).
function paintPack(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    const wool = ['#8a5a3a', '#6a5a7a', '#7a6a3a', '#5a6a5a', '#8a4a3a', '#5a5a6a'][S.skin];
    const body = { x: r.x, y: V(1), w: r.w, h: V(0.39) - V(1) };
    clipRect(g, body.x, body.y, body.w, body.h, () => {
      cloth(g, r, body.x, body.y, body.w, body.h, wool, rnd, { folds: 0, light: 0.2, wrap: true });
      for (const u of [0.1, 0.62]) { g.save(); g.fillStyle = lightOf(wool, 0.45); g.globalAlpha = 0.6; g.fillRect(U(u), body.y, r.w * 0.05, body.h); g.fillStyle = shadowOf(wool, 0.4); g.fillRect(U(u + 0.05), body.y, r.w * 0.015, body.h); g.restore(); }   // the blanket's stripes
      for (let i = 0; i < 6; i++) { const y = body.y + rnd() * body.h; sfold(g, curve(r.x + rnd() * r.w * 0.3, y, r.x + r.w * (0.6 + rnd() * 0.4), y + range(rnd, -3, 3), 2, 5), 4, wool, 0.6); }
      gradH(g, r.x, body.y, r.w, body.h, [[0, rgba(INK, 0.15)], [0.25, rgba('#fff1c4', 0.3)], [0.5, rgba(INK, 0.05)], [0.75, rgba(INK, 0.5)], [1, rgba(INK, 0.15)]]);
      for (const t of [0.2, 0.8]) {   // two leather straps round the roll, buckled on top
        const v = 0.4 + 0.6 * t;
        band(g, r, v - 0.045, v + 0.045, '#4a3020', 1);
        bandGrad(g, r, v + 0.02, v + 0.045, rgba('#fff0c8', 0), rgba('#fff0c8', 0.25));
        bandGrad(g, r, v - 0.06, v - 0.045, rgba(INK, 0), rgba(INK, 0.45));
        buckle(g, U(0.25), V(v), 6, 6);
      }
    });
    // the spiral end: the blanket's layers wound round the center
    clipRect(g, r.x, V(0.38), r.w, V(0) - V(0.38), () => {
      fill0(g, { x: r.x, y: V(0.38), w: r.w, h: r.h * 0.38 }, shadowOf(wool, 0.15));
      const cx = U(0.5), cy = V(0.19), kx = r.w * 0.0425, ky = r.h * 0.17;
      for (let k = 0; k < 2; k++) {
        g.save(); g.strokeStyle = k ? lightOf(wool, 0.3) : shadowOf(wool, 0.55); g.lineWidth = k ? 1.2 : 2.6; g.globalAlpha = k ? 0.6 : 0.9;
        g.beginPath(); for (let a = 0; a < Math.PI * 8; a += 0.15) { const rr = a / (Math.PI * 8); g.lineTo(cx + Math.cos(a) * rr * kx - k * 0.8, cy + Math.sin(a) * rr * ky - k * 0.8); } g.stroke(); g.restore();
      }
      blob(g, cx - kx * 0.3, cy - ky * 0.35, kx * 0.6, ky * 0.4, 0, '#fff1c4', 0.2, 0.2);
    });
  });
}

// The accessory region: the hat (crown v .52-1, brim v 0-.45), or Ed's apron.
function paintAcc(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v), c = S.color;
  const crown = { x: r.x, y: V(1), w: r.w, h: V(0.5) - V(1) }, brim = { x: r.x, y: V(0.5), w: r.w, h: V(0) - V(0.5) };
  clip(g, r, () => {
    const h = S.hat;
    if (S.apron) {
      // Ed's shop apron (u across, v from the hem up to the bib): oiled leather, vertical
      // hanging folds, a stitched darker edge, a pocket with a pencil, old stains
      const ap = '#7e5a3a';
      leather(g, r, r.x, r.y, r.w, r.h, ap, rnd, { creases: 10, scuffs: 16, light: 0.32 });
      for (let i = 0; i < 4; i++) { const u = (i + 0.3 + rnd() * 0.4) / 4; sfold(g, curve(U(u), V(0.6 - rnd() * 0.15), U(u + range(rnd, -0.04, 0.04)), V(0.02), range(rnd, -5, 5), 5), range(rnd, 9, 13), ap, 0.7); }
      for (let i = 0; i < 5; i++) { const y = V(0.58 + rnd() * 0.08); sfold(g, curve(U(0.1 + rnd() * 0.3), y, U(0.6 + rnd() * 0.3), y + range(rnd, -3, 3), 3, 5), 5, ap, 0.6); }   // creased where the belly folds it
      blob(g, U(0.5), V(0.5), r.w * 0.3, r.h * 0.12, 0, lightOf(ap, 0.4), 0.3, 0.1);                    // the belly pushes it into the light
      for (let i = 0; i < 6; i++) blob(g, U(0.15 + rnd() * 0.7), V(0.1 + rnd() * 0.6), range(rnd, 5, 12), range(rnd, 3, 7), rnd() * 3, '#3e2e22', 0.32, 0.3);   // stains
      const pk = [U(0.36), V(0.44), r.w * 0.28, V(0.3) - V(0.44)];
      g.save(); g.fillStyle = shade(ap, 0.86); g.fillRect(...pk); g.restore();
      bandGrad(g, r, 0.28, 0.3, rgba(INK, 0.4), rgba(INK, 0));
      stitches(g, [[U(0.36), V(0.44)], [U(0.36), V(0.3)], [U(0.64), V(0.3)], [U(0.64), V(0.44)]], '#e8d0a0', 0.6);
      stroke(g, [[U(0.55), V(0.49)], [U(0.59), V(0.36)]], 3, 3, '#c8a040', 1);    // a pencil in the pocket
      blob(g, U(0.55), V(0.495), 2, 2, 0, '#e8a0a0', 1, 0.6);
      // the darker turned edge all round, stitched
      for (const [x0, y0, x1, y1] of [[U(0.02), V(0), U(0.02), V(1)], [U(0.98), V(0), U(0.98), V(1)], [U(0), V(0.03), U(1), V(0.03)]]) stroke(g, [[x0, y0], [x1, y1]], 5, 5, shadowOf(ap, 0.35), 0.85);
      for (const u of [0.045, 0.955]) stitches(g, [[U(u), V(0)], [U(u), V(1)]], '#e8d0a0', 0.55);
      stitches(g, [[U(0), V(0.06)], [U(1), V(0.06)]], '#e8d0a0', 0.55);
      wear(g, along(U(0), V(0.01), U(1), V(0.01), 10), ap, 2, 0.4, rnd);
      bandGrad(g, r, 0.62, 0.68, rgba(INK, 0), rgba(INK, 0.3));                     // the waist tie's shadow
      bandGrad(g, r, 0.9, 1.0, rgba(INK, 0), rgba(INK, 0.35));
      return;
    }
    if (h === 'brim') {
      leather(g, r, r.x, r.y, r.w, r.h, '#6e4c30', rnd, { creases: 12, scuffs: 16, light: 0.35, wrap: true });
      band(g, r, 0.5, 0.62, '#3a2618', 1); hstitch(g, r, 0.6, '#c8a070', 0.4); hstitch(g, r, 0.52, '#c8a070', 0.4);
      buckle(g, U(0.62), V(0.56), 7, 9);
      // a feather tucked in the band, in the player's color
      stroke(g, curve(U(0.3), V(0.55), U(0.22), V(0.98), 6, 6), 7, 1.5, lightOf(c, 0.2), 1);
      stroke(g, curve(U(0.3), V(0.55), U(0.22), V(0.98), 6, 6).map(([x, y]) => [x + 1, y]), 1.2, 0.5, shadowOf(c, 0.5), 0.8);
      bandGrad(g, r, 0.62, 0.7, rgba(INK, 0.35), rgba(INK, 0));
      for (let k = 0; k < 6; k++) { const u = (k + 0.5) / 6; sfold(g, [[U(u), V(0.98)], [U(u + 0.02), V(0.7)]], 6, '#6e4c30', 0.6); }   // the pinched crown's dents
      stitches(g, [[r.x, V(0.06)], [r.x + r.w, V(0.06)]], '#d8b88a', 0.5);
      wear(g, along(r.x, V(0.02), r.x + r.w, V(0.02), 14), '#6e4c30', 2.4, 0.45, rnd);
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
    } else if (h === 'hood') {
      // dark wool, a little of your color in the dye; the rolled lip round the face in your color
      const wool = mix('#5c4c40', c, 0.24);
      clipRect(g, crown.x, crown.y, crown.w, crown.h, () => {
        cloth(g, r, crown.x, crown.y, crown.w, crown.h, wool, rnd, { folds: 0, light: 0.36, wrap: true });
        for (let i = 0; i < 10; i++) { const u = (i + rnd() * 0.5) / 10; sfold(g, curve(U(u), V(1.0), U(u + range(rnd, -0.03, 0.03)), V(0.52), range(rnd, -5, 5), 5), range(rnd, 8, 11), wool, 0.9); }
        bandGrad(g, r, 0.88, 1.0, rgba('#fff0c8', 0), rgba('#fff0c8', 0.18));
      });
      // the lining, in the hood's shade but never black
      clipRect(g, r.x, V(0.4), r.w, V(0.04) - V(0.4), () => cloth(g, r, r.x, V(0.4), r.w, V(0.04) - V(0.4), shadowOf(wool, 0.22), rnd, { folds: 5, light: 0.15, wrap: true }));
      // the lip: your color, rolled, gold piping
      gradV(g, r.x, V(0.51), r.w, V(0.41) - V(0.51), [[0, lightOf(c, 0.45)], [0.45, c], [1, shadowOf(c, 0.5)]]);
      trimH(g, r.x, r.x + r.w, V(0.512), 2.2);
      wear(g, along(r.x, V(0.47), r.x + r.w, V(0.47), 16), c, 1.6, 0.3, rnd);
    } else if (h === 'bandana' || h === 'cap') {
      const cc = h === 'bandana' ? mix(c, '#7a2a24', 0.3) : c;
      cloth(g, r, r.x, r.y, r.w, r.h, cc, rnd, { folds: 8, light: 0.35, wrap: true });
      if (h === 'bandana') for (let i = 0; i < 40; i++) { const x = r.x + rnd() * r.w, y = r.y + rnd() * r.h; ellipse(g, x, y, 2, 2, 0, '#efe3c8', 0.7); ellipse(g, x + 3, y, 0.9, 0.9, 0, '#efe3c8', 0.6); }
      if (h === 'cap') {
        for (let k = 0; k < 6; k++) stitches(g, [[U(k / 6), V(0.52)], [U(k / 6 + 0.02), V(1)]], shadowOf(c, 0.5), 0.6);
        clipRect(g, brim.x, brim.y, brim.w, brim.h, () => {
          leather(g, r, brim.x, brim.y, brim.w, brim.h, '#5a3c26', rnd, { creases: 5, scuffs: 8 });
          stitches(g, [[r.x, V(0.12)], [r.x + r.w, V(0.12)]], '#d8b88a', 0.6);
          stitches(g, [[r.x, V(0.2)], [r.x + r.w, V(0.2)]], '#d8b88a', 0.6);
          wear(g, along(r.x, V(0.43), r.x + r.w, V(0.43), 14), '#5a3c26', 2, 0.45, rnd);
        });
        rivet(g, U(0.5), V(0.97), 3);
        band(g, r, 0.5, 0.56, shadowOf(c, 0.3), 1);
        wheelEmblem(g, U(0.5), V(0.7), 7);
      }
    } else if (h === 'helm') {
      gradV(g, r.x, r.y, r.w, r.h, [[0, '#d0d4dc'], [0.4, '#8a8e98'], [1, '#4a4c56']]);
      for (let i = 0; i < 14; i++) wblob(g, r, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 6, 18), range(rnd, 4, 10), rnd() * 3, pick(rnd, ['#6a5a52', '#a8acb6', '#5a5c66']), 0.3, 0.2);
      for (let i = 0; i < 24; i++) { const x = U(rnd()), y = V(0.5 + rnd() * 0.5); stroke(g, [[x, y], [x + range(rnd, -6, 6), y + range(rnd, -1.5, 1.5)]], 1, 0.4, pick(rnd, ['#f0f2f8', '#3a3a46']), 0.35); }
      for (let k = 0; k < 4; k++) { const u = (k + 0.5) / 4; stroke(g, [[U(u), V(0.5)], [U(u), V(1)]], 5, 3, '#5a5c66', 0.6); stroke(g, [[U(u) - 2, V(0.5)], [U(u) - 2, V(1)]], 1.5, 1, '#e8eaf0', 0.5); }
      // the rim (v .26-.5): a riveted iron band over a strip of your color; the nasal guard (v .05-.25, u ~.5)
      band(g, r, 0.42, 0.5, '#7a5a3c', 1);
      band(g, r, 0.0, 0.42, IRON, 1);
      bandGrad(g, r, 0.26, 0.42, rgba('#ffffff', 0.25), rgba(INK, 0.35));
      band(g, r, 0.3, 0.36, c, 0.9);
      for (let k = 0; k < 12; k++) rivet(g, U((k + 0.5) / 12), V(0.39), 2.6, '#c8ccd4');
      gradH(g, U(0.47), V(0.26), r.w * 0.06, V(0.04) - V(0.26), [[0, '#c4c8cc'], [0.35, '#9a9ea8'], [0.7, IRON], [1, '#4a4c56']]);
      gradV(g, U(0.47), V(0.08), r.w * 0.06, V(0.04) - V(0.08), [[0, rgba(INK, 0)], [1, rgba(INK, 0.45)]]);
      rivet(g, U(0.5), V(0.22), 2.4, '#5a5c66');
      bandGrad(g, r, 0.85, 1, rgba('#ffffff', 0), rgba('#ffffff', 0.25));
    } else if (h === 'visor') {
      // a dealer's green celluloid visor on a dark leather band
      clipRect(g, crown.x, crown.y, crown.w, crown.h, () => {
        leather(g, r, crown.x, crown.y, crown.w, crown.h, '#2e2630', rnd, { creases: 3, scuffs: 6, light: 0.4, wrap: true });
        hstitch(g, r, 0.75, '#8a8090', 0.5);
      });
      clipRect(g, brim.x, brim.y, brim.w, brim.h, () => {
        gradV(g, brim.x, brim.y, brim.w, brim.h, [[0, '#7fc08a'], [0.18, '#5aa868'], [0.5, '#3f8a4a'], [1, '#2a6a38']]);
        for (let i = 0; i < 8; i++) blob(g, r.x + rnd() * r.w, V(0.1 + rnd() * 0.3), range(rnd, 10, 30), range(rnd, 3, 6), 0, '#c8f0c8', 0.22, 0.2);
        for (let i = 0; i < 6; i++) { const x = U(rnd()); stroke(g, [[x, V(0.42)], [x + 6, V(0.08)]], 2, 1, '#e0ffe0', 0.25); }
        band(g, r, 0.38, 0.46, '#a8e0b0', 0.85);                                  // the lighter bound rim
        bandGrad(g, r, 0.0, 0.08, rgba('#1a3a24', 0.6), rgba('#1a3a24', 0));       // in the band's shade where it meets the head
      });
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

// The apron region (252 × 64): the hood's capelet (players), or the Repo Man's overall bib.
function paintApron(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v), c = S.color;
  clip(g, r, () => {
    if (S.outfit === 'repo') {
      // the bib (u across, v up): heavy canvas, double-stitched edges, a chest pocket, brass clasps at the top corners
      const ov = c;
      cloth(g, r, r.x, r.y, r.w, r.h, ov, rnd, { folds: 5, light: 0.3, foldW: [3, 5] });
      for (const [x0, y0, x1, y1] of [[U(0.03), V(0), U(0.03), V(1)], [U(0.97), V(0), U(0.97), V(1)], [U(0), V(0.95), U(1), V(0.95)]]) { stitches(g, [[x0, y0], [x1, y1]], '#e0c890', 0.65); stitches(g, [[x0 + (x0 < U(0.5) ? 3 : x0 > U(0.5) ? -3 : 0), y0 + (y0 === y1 ? 3 : 0)], [x1 + (x1 < U(0.5) ? 3 : x1 > U(0.5) ? -3 : 0), y1 + (y0 === y1 ? 3 : 0)]], '#e0c890', 0.5); }
      g.save(); g.fillStyle = shadowOf(ov, 0.12); g.fillRect(U(0.36), V(0.78), r.w * 0.28, V(0.36) - V(0.78)); g.restore();
      bandGrad(g, r, 0.34, 0.37, rgba(INK, 0.45), rgba(INK, 0));
      stitches(g, [[U(0.36), V(0.78)], [U(0.36), V(0.36)], [U(0.64), V(0.36)], [U(0.64), V(0.78)]], '#e0c890', 0.6);
      stitches(g, [[U(0.36), V(0.7)], [U(0.64), V(0.7)]], '#e0c890', 0.5);
      for (const u of [0.1, 0.9]) { buckle(g, U(u), V(0.84), 9, 10); rivet(g, U(u), V(0.84), 2.4); }
      wear(g, along(U(0.02), V(0.99), U(0.98), V(0.99), 12), ov, 2.4, 0.45, rnd);
      bandGrad(g, r, 0.0, 0.12, rgba(INK, 0.3), rgba(INK, 0));
      return;
    }
    // the capelet (u around, v from the scalloped hem up to the neck): the hood's wool,
    // folds radiating from the neck, a hem band in your color with a gold trim
    const wool = mix('#5c4c40', c, 0.24);
    cloth(g, r, r.x, r.y, r.w, r.h, wool, rnd, { folds: 0, light: 0.38, wrap: true });
    for (let i = 0; i < 16; i++) { const u = (i + rnd() * 0.5) / 16; sfold(g, curve(U(u), V(1.0), U(u + range(rnd, -0.02, 0.02)), V(0.12), range(rnd, -2, 2), 4), range(rnd, 6, 9), wool, 0.9); }
    band(g, r, 0.0, 0.14, c, 1);
    bandGrad(g, r, 0.0, 0.14, rgba(INK, 0.35), rgba('#fff0c8', 0.25));
    trimH(g, r.x, r.x + r.w, V(0.16), 2.4);
    wear(g, along(r.x, V(0.02), r.x + r.w, V(0.02), 20), c, 1.6, 0.35, rnd);
    bandGrad(g, r, 0.8, 1.0, rgba(INK, 0), rgba(INK, 0.35));          // tucked into the cowl at the neck
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
  paintApron(g, REG.apron, S, rnd);
  paintHorn(g, REG.horn, rnd);
  paintMetal(g, REG.metal, rnd);
  paintGear(g, REG.gear, S, rnd);
  paintPack(g, REG.pack, S, rnd);
  // painterly softening + a warm unifying glaze, then bleed edges for mipmaps
  for (const k of ['torso', 'arm', 'leg', 'foot', 'paul', 'belt', 'acc', 'apron', 'beard', 'skirt', 'flap', 'flapB', 'collar', 'pack']) soften(cv, REG[k], 0.55);
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
      const r = REG.head, K = faceKit(g, r);
      for (const sd of [-1, 1]) {
        const [x, y] = K.F(sd * EYE_X, 0);
        blob(g, x, y, 22, 8, 0, spec.eyeGlow, 0.5, 0.2);
        blob(g, x + sd, y, 7, 5, 0, '#ffd0b0', 0.9, 0.4);
      }
    },
  });
  return name;
}

// ---- first-person hands (256×256): sleeve, gauntlet cuff, bracer, glove, fingers, thumb ----
export const FP = {
  sleeve: { x: 0, y: 0, w: 124, h: 124 },
  cuff: { x: 128, y: 0, w: 128, h: 60 },
  bracer: { x: 128, y: 64, w: 128, h: 60 },
  palm: { x: 128, y: 128, w: 128, h: 128 },
  finger: { x: 0, y: 128, w: 124, h: 60 },
  thumb: { x: 0, y: 192, w: 124, h: 64 },
};
function paintHands(g, s, rnd, cv, color) {
  const c = muted(color), cb = brightDye(color);
  fill0(g, { x: 0, y: 0, w: 256, h: 256 }, '#5a3c26');
  const GL = '#7a5232';
  clip(g, FP.sleeve, () => {
    const r = FP.sleeve;
    cloth(g, r, r.x, r.y, r.w, r.h, c, rnd, { folds: 0, light: 0.4, wrap: true });
    for (let i = 0; i < 7; i++) { const x = r.x + (i + rnd() * 0.6) / 7 * r.w; sfold(g, curve(x, RY(r, 0.12), x + range(rnd, -8, 8), RY(r, 0.95), range(rnd, -4, 4), 4), range(rnd, 7, 11), c, 0.8); }
    for (let i = 0; i < 4; i++) { const y = RY(r, 0.2 + rnd() * 0.2); sfold(g, curve(r.x + rnd() * r.w * 0.5, y, r.x + r.w * (0.5 + rnd() * 0.5), y + range(rnd, -5, 5), 3, 4), 6, c, 0.7); }   // bunched over the bracer
    trimH(g, r.x, r.x + r.w, RY(r, 0.1), r.h * 0.07);
    bandGrad(g, r, 0, 0.1, rgba(INK, 0.55), rgba(INK, 0));
  });
  clip(g, FP.bracer, () => {
    const r = FP.bracer;
    leather(g, r, r.x, r.y, r.w, r.h, LEATHER_D, rnd, { creases: 6, scuffs: 12, wrap: true, light: 0.45 });
    // a laced split down the inside, a lit strap with a buckle round the middle
    for (let k = 0; k < 4; k++) { const y = RY(r, 0.25 + k * 0.17); stroke(g, [[RX(r, 0.72), y - 4], [RX(r, 0.8), y + 4]], 2, 2, '#c9a878', 0.9); stroke(g, [[RX(r, 0.8), y - 4], [RX(r, 0.72), y + 4]], 2, 2, '#c9a878', 0.9); }
    band(g, r, 0.42, 0.6, '#4a3020', 1); bandGrad(g, r, 0.42, 0.6, rgba('#fff0c8', 0.25), rgba(INK, 0.35));
    hstitch(g, r, 0.47, '#d8bc8a', 0.5); hstitch(g, r, 0.56, '#d8bc8a', 0.5);
    buckle(g, RX(r, 0.5), RY(r, 0.51), 9, 11);
    hstitch(g, r, 0.1, '#c9a878', 0.55); hstitch(g, r, 0.9, '#c9a878', 0.55);
    bandGrad(g, r, 0.85, 1, rgba(INK, 0), rgba(INK, 0.45));
  });
  clip(g, FP.cuff, () => {
    const r = FP.cuff;
    leather(g, r, r.x, r.y, r.w, r.h, SUEDE, rnd, { creases: 6, scuffs: 12, wrap: true, light: 0.5 });
    // your color: a wide dyed band under the rolled rim, piped in gold
    band(g, r, 0.66, 0.9, cb, 1);
    bandGrad(g, r, 0.66, 0.9, rgba('#fff0c8', 0.35), rgba(INK, 0.35));
    trimH(g, r.x, r.x + r.w, RY(r, 0.91), r.h * 0.07);
    trimH(g, r.x, r.x + r.w, RY(r, 0.66), r.h * 0.06);
    gradV(g, r.x, RY(r, 1.0), r.w, RY(r, 0.93) - RY(r, 1.0), [[0, '#d8b888'], [1, '#6a4a2a']]);   // the rolled rim
    for (let k = 0; k < 7; k++) rivet(g, RX(r, (k + 0.5) / 7), RY(r, 0.4), 3, BRASS);
    for (let k = 0; k < 7; k++) sfold(g, [[RX(r, (k + 0.1) / 7), RY(r, 0.6)], [RX(r, (k + 0.15) / 7), RY(r, 0.08)]], 6, SUEDE, 0.55);
    bandGrad(g, r, 0, 0.22, rgba(INK, 0.55), rgba(INK, 0));
  });
  clip(g, FP.palm, () => {
    const r = FP.palm;
    leather(g, r, r.x, r.y, r.w, r.h, GL, rnd, { creases: 7, scuffs: 14, light: 0.45, wrap: true, sheen: 0.3 });
    // the back of the hand (u ~ .5): stitched seams running to each knuckle, a dyed strap with a brass stud
    for (const u of [0.4, 0.47, 0.53, 0.6]) { stitches(g, [[RX(r, 0.5 + (u - 0.5) * 0.5), RY(r, 0.15)], [RX(r, u), RY(r, 0.8)]], '#e2c898', 0.55); sfold(g, [[RX(r, 0.5 + (u - 0.5) * 0.5) + 3, RY(r, 0.2)], [RX(r, u) + 3, RY(r, 0.78)]], 5, GL, 0.6); }
    band(g, r, 0.46, 0.58, c, 0.95); bandGrad(g, r, 0.46, 0.58, rgba('#fff0c8', 0.3), rgba(INK, 0.35));
    hstitch(g, r, 0.48, '#f0dca8', 0.5); hstitch(g, r, 0.56, '#f0dca8', 0.5);
    rivet(g, RX(r, 0.5), RY(r, 0.52), 4);
    // a padded knuckle ridge with four brass studs, dark creases where the fingers bend
    band(g, r, 0.76, 0.9, shadowOf(GL, 0.15), 0.9);
    bandGrad(g, r, 0.84, 0.92, rgba('#fff0c8', 0.0), rgba('#fff0c8', 0.35));
    bandGrad(g, r, 0.7, 0.76, rgba(INK, 0), rgba(INK, 0.5));
    for (const u of [0.38, 0.46, 0.54, 0.62]) { rivet(g, RX(r, u), RY(r, 0.83), 3.6, BRASS); blob(g, RX(r, u) - 1.2, RY(r, 0.83) - 1.4, 1.6, 1.2, 0, '#e8c878', 0.7, 0.4); }
    for (const u of [0.42, 0.5, 0.58]) stroke(g, [[RX(r, u), RY(r, 0.97)], [RX(r, u), RY(r, 0.72)]], 2.4, 1.6, shadowOf(GL, 0.6), 0.6);    // the splits toward the fingers
    blob(g, RX(r, 0.45), RY(r, 0.55), r.w * 0.12, r.h * 0.2, 0, lightOf(GL, 0.5), 0.35, 0.15);
    // the palm (u 0 / 1): a darker padded patch in shade
    for (const u of [0.0, 1.0]) { blob(g, RX(r, u), RY(r, 0.5), r.w * 0.22, r.h * 0.4, 0, INK, 0.45, 0.1); stitches(g, [[RX(r, u) - 20, RY(r, 0.25)], [RX(r, u) + 20, RY(r, 0.25)]], '#c8a878', 0.4); }
    bandGrad(g, r, 0, 0.1, rgba(INK, 0.45), rgba(INK, 0));
  });
  // fingers and thumb: tubes with the back of the finger at u .5, its sides (toward the next
  // finger) at u .25 / .75 in a dark seam, the underside at u 0 / 1
  for (const k of ['finger', 'thumb']) clip(g, FP[k], () => {
    const r = FP[k];
    leather(g, r, r.x, r.y, r.w, r.h, GL, rnd, { creases: 5, scuffs: 8, light: 0.45, wrap: true });
    for (const v of [0.48, 0.74]) { const y = RY(r, v); for (let q = 0; q < 2; q++) sfold(g, curve(RX(r, 0.32), y + q * 3, RX(r, 0.68), y + q * 3, 2, 3), 4, GL, 0.85); }
    blob(g, RX(r, 0.5), RY(r, 0.5), r.w * 0.14, r.h * 0.45, 0, lightOf(GL, 0.45), 0.42, 0.2);
    for (const v of [0.5, 0.78]) blob(g, RX(r, 0.5), RY(r, v), r.w * 0.07, r.h * 0.06, 0, lightOf(GL, 0.7), 0.5, 0.25);   // knuckle shine
    blob(g, RX(r, 0.5), RY(r, 0.06), r.w * 0.1, r.h * 0.07, 0, lightOf(GL, 0.5), 0.45, 0.25);                             // the fingertip
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.55)], [0.17, rgba(INK, 0.45)], [0.3, rgba(INK, 0)], [0.7, rgba(INK, 0)], [0.83, rgba(INK, 0.45)], [1, rgba(INK, 0.55)]]);
    for (const u of [0.24, 0.76]) stroke(g, [[RX(r, u), r.y], [RX(r, u), r.y + r.h]], 2.2, 2.2, shadowOf(GL, 0.7), 0.6);
    bandGrad(g, r, 0.9, 1, rgba(INK, 0), rgba(INK, 0.35));
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
    family: 'characters', w: 512, h: 256, note: `skin tone ${i} + face (head region)`,
    paint(g, s, rnd) { paintHead(g, { x: 0, y: 0, w: 512, h: 256 }, resolveSpec('#7CFC00', { skinIndex: i, hatIndex: i }), rnd); },
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
