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
// The modeled mustache's center line, [theta, dy] for v 0..1 from one tip to the other: people.js
// builds the roll along it and the painter lays its color along the very same line.
export const MUSTACHES = { mustache: { w: 0.42, droop: 0.012, curl: true }, beard: { w: 0.36, droop: 0.026, curl: false } };
export function mustacheAt(v, { w, droop, curl }) {
  const a = (v - 0.5) * 2, q = Math.abs(a), th = -a * w;
  let dy = -0.029 - droop * Math.pow(q, 1.6);
  if (curl) dy += 0.016 * Math.max(0, (q - 0.75) / 0.25) ** 2;
  return [th, dy];
}

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
export const ARM_LM = { elbow: -0.3, sleeve: -0.315, cuffTop: -0.448, cuffRim: -0.465, cuffBot: -0.5, wrist: -0.575, knuckle: -0.672, roll: -0.18 };
// Legs: v = height above the sole. The skirt: v from 0.56 m (0) to 1.02 m (1).
export const SKIRT_Y0 = 0.56, SKIRT_Y1 = 1.02;
export const skirtV = y => (y - SKIRT_Y0) / (SKIRT_Y1 - SKIRT_Y0);
// The clerk's long skirt (S.dress) uses the whole skirt region: u around, v from the hem (0) to the waist (1).
export const DRESS_Y0 = 0.1, DRESS_Y1 = 1.03;
// Ed's apron: v from its hem (0) to its bib's top (1).
export const APRON_Y0 = 0.5, APRON_Y1 = 1.31;
export const dressV = y => (y - DRESS_Y0) / (DRESS_Y1 - DRESS_Y0);

// ---- who is who ---------------------------------------------------------------------

export const SKIN_TONES = ['#e09e72', '#c98a5a', '#a86e46', '#84563a', '#f0b48c', '#6c4430'];
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
  ed:     { torso: 'shirt', arms: 'rolled', hands: 'bare', legs: 'wool', boots: 'short', pauldrons: 'none', belt: false, apron: true, hat: 'none', bulk: 1.08, belly: 0.045, armBulk: 1.08, forearm: 1.15, look: { hair: 'bald', hairColor: '#8a7c6c', facial: 'beard', beard: 1.3, female: false } },
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

// Six player kits (picked by player id, like the hat and the face), so the crew don't read as one
// template with a color swap: what's on the shoulders, the tabard's sigil (once, on the tabard), what
// hangs off the belt, laced or plain bracers, a laced or plain jerkin front.
//   shoulders: leather (a boiled-leather dome), iron (a riveted iron dome), lames (three overlapping
//   leather plates), capelet (no pauldrons: the hood's capelet), mantle (no pauldrons: a leather mantle
//   with a fur collar)
export const KITS = [
  { shoulders: 'leather', emblem: 'wheel', beltX: 'pouch', bracer: 'laced', chest: 'laced' },
  { shoulders: 'lames', emblem: 'coin', beltX: 'flask', bracer: 'plain', chest: 'plain' },
  { shoulders: 'iron', emblem: 'wrenches', beltX: 'pouch', bracer: 'laced', chest: 'plain' },
  { shoulders: 'capelet', emblem: 'horseshoe', beltX: 'mapcase', bracer: 'plain', chest: 'laced' },
  { shoulders: 'mantle', emblem: 'boot', beltX: 'flask', bracer: 'laced', chest: 'plain' },
  { shoulders: 'iron', emblem: 'lion', beltX: 'none', bracer: 'plain', chest: 'laced' },
];
export function resolveSpec(color = '#7CFC00', { hatIndex = 0, skinIndex = 0, scale = 1, eyeColor = null, outfit = null, variant = null } = {}) {
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
  const kitI = outfit === 'player' ? (((variant ?? hatIndex) % 6) + 6) % 6 : -1;
  const kit = kitI >= 0 ? KITS[kitI] : {};
  const kitParts = kitI >= 0 ? { ...kit, kit: kitI, pauldrons: ['leather', 'iron', 'lames'].includes(kit.shoulders) ? 'both' : 'none', paulMetal: kit.shoulders === 'iron', mantle: kit.shoulders === 'mantle' } : {};
  const spec = { ...O, outfit, color: c, bright: outfit === 'player' ? brightDye(color) : c, raw: color, skin, tone, look, hat, paulMetal: false, eyeGlow: eyeColor || null, ...kitParts };
  spec.key = [outfit, c, skin, hat, eyeColor || '-', kitI].join('_').replace(/#/g, '');
  return spec;
}

// ---- painting helpers ---------------------------------------------------------------

// (the game's sun is warm and bright: browns paint darker and cooler than they read on screen)
const LEATHER = '#5a3c26', LEATHER_D = '#3a2518', SUEDE = '#7a5636', TRIM = '#d6b46c', LINEN = '#ddcfb0', BRASS = '#b58c3c', IRON = '#7d8088';
const TROUSER = '#4a392c';
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
// resample a polyline to n + 1 evenly spaced points
function densify(pts, n) {
  const seg = []; let tot = 0;
  for (let i = 0; i < pts.length - 1; i++) { const l = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); seg.push(l); tot += l; }
  const out = [];
  for (let k = 0; k <= n; k++) {
    let d = tot * k / n, i = 0;
    while (i < seg.length - 1 && d > seg[i]) { d -= seg[i]; i++; }
    const t = seg[i] ? Math.min(1, d / seg[i]) : 0;
    out.push([pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t]);
  }
  return out;
}
// One lock of hair, WoW-style: a tapered body in a quiet mid-tone, ONE soft lit band about a
// third of the way from its root that fades out before the tip, and a dark accent only in the
// gap where it parts from its neighbour (its outer part, on the side away from the light).
// P runs from the root to the tip. Never thin per-hair strands, never stripes.
function paintLock(g, P, W, c, { lit, gap, gapA = 0.55, band = 0.3, tip = 0.25 }) {
  stroke(g, P, W, W * tip, c, 1);
  if (gapA > 0) { const k = Math.floor(P.length * 0.35); stroke(g, P.slice(k).map(([a, b]) => [a + W * 0.4, b]), W * 0.22, W * 0.05, gap, gapA); }
  const i = Math.max(1, Math.min(P.length - 2, Math.round(band * (P.length - 1))));
  const [ax, ay] = P[i - 1], [bx, by] = P[i + 1], rot = Math.atan2(by - ay, bx - ax), L = Math.hypot(bx - ax, by - ay);
  blob(g, P[i][0] - W * 0.12, P[i][1], Math.max(W * 0.5, L * 0.95), W * 0.26, rot, lit, 0.5, 0.25);
}
const hairInks = base => {
  const dk = hsl(base).l < 0.15;
  return {
    gap: mix(shadowOf(base, 0.45), INK, 0.1),
    lit: dk ? mix(lightOf(base, 0.6), '#8a90a8', 0.3) : lightOf(base, 0.25),
    mids: [base, mix(base, lightOf(base, 0.12), 0.7), mix(base, shadowOf(base, 0.12), 0.7), mix(base, '#7a4a30', 0.08)],
  };
};
// Hanging hair (manes, braids, buns): locks of 2:1 varied widths at jittered spacing, falling from the top.
function locks(g, r, x, y, w, h, base, rnd, { count = 7, len = [0.55, 0.95], width = [8, 16], sheen = 0.3, wrap = false, topPad = 0.12 } = {}) {
  gradV(g, x, y, w, h, [[0, shadowOf(base, 0.12)], [0.4, base], [1, shadowOf(base, 0.3)]]);
  const { gap, lit, mids } = hairInks(base), step = w / count, list = [];
  for (let pass = 0; pass < 2; pass++) {
    let x0 = x + step * (pass ? 0.5 : 0.05);
    while (x0 < x + w) {
      const W = range(rnd, width[0], width[1]) * (pass ? 0.85 : 1), L = range(rnd, len[0], len[1]) * h * (pass ? 0.85 : 1.1);
      const y0 = y - h * topPad + rnd() * h * 0.1 + pass * h * 0.05;
      list.push({ pts: densify(curve(x0, y0, x0 + (rnd() - 0.5) * W * 0.3, y0 + L, (rnd() - 0.5) * W * 0.5, 4), 8), W, c: pick(rnd, mids), b: sheen + range(rnd, -0.08, 0.08), g: rnd() < 0.65 ? 0.55 : 0 });
      x0 += step * range(rnd, 0.5, 1.5);
    }
  }
  for (const lk of list) {
    const copies = [lk.pts];
    if (wrap && r) { if (lk.pts[0][0] < x + lk.W * 1.5) copies.push(lk.pts.map(([a, b]) => [a + w, b])); if (lk.pts[0][0] > x + w - lk.W * 1.5) copies.push(lk.pts.map(([a, b]) => [a - w, b])); }
    for (const P of copies) paintLock(g, P, lk.W, lk.c, { lit, gap, gapA: lk.g, band: lk.b });
  }
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
function star(g, x, y, r0, r1, n) { g.beginPath(); for (let k = 0; k < n * 2; k++) { const a = -Math.PI / 2 + k * Math.PI / n, rr = k % 2 ? r1 : r0; g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); } g.closePath(); }
// A crew sigil, embroidered in gold thread on the tabard: a dark drop shadow, the gold shape, its
// darker stitched details, a lit edge top-left. Each player's kit picks one.
function sigil(g, kind, x, y, R, col = TRIM) {
  if (!kind || kind === 'wheel') return wheelEmblem(g, x, y, R, col);
  const dark = shadowOf(col, 0.6), lit = lightOf(col, 0.7);
  const layer = (dx, dy, c, a, fn) => { g.save(); g.translate(x + dx, y + dy); g.globalAlpha = a; g.fillStyle = c; g.strokeStyle = c; g.lineCap = 'round'; g.lineJoin = 'round'; fn(); g.restore(); };
  const both = fn => { layer(1, 1.3, INK, 0.45, fn); layer(0, 0, col, 1, fn); layer(-0.6, -0.7, lit, 0.35, fn); layer(0, 0, col, 0.85, fn); };
  if (kind === 'coin') {
    both(() => { g.beginPath(); g.arc(0, 0, R, 0, TAU); g.fill(); });
    layer(0, 0, dark, 0.85, () => { g.lineWidth = R * 0.1; g.beginPath(); g.arc(0, 0, R * 0.76, 0, TAU); g.stroke(); star(g, 0, 0, R * 0.48, R * 0.2, 5); g.fill(); });
    layer(0, 0, lit, 0.8, () => { g.lineWidth = R * 0.12; g.beginPath(); g.arc(0, 0, R * 0.92, Math.PI * 1.05, Math.PI * 1.6); g.stroke(); });
  } else if (kind === 'horseshoe') {
    const arc = () => { g.lineWidth = R * 0.4; g.beginPath(); g.arc(0, R * 0.05, R * 0.68, -0.12 * Math.PI, 1.12 * Math.PI); g.stroke(); };
    both(arc);
    layer(0, 0, dark, 0.9, () => { for (const a of [0.05, 0.3, 0.7, 0.95]) { const t = (-0.12 + 1.24 * a) * Math.PI; g.beginPath(); g.arc(Math.cos(t) * R * 0.68, R * 0.05 + Math.sin(t) * R * 0.68, R * 0.07, 0, TAU); g.fill(); } });
    layer(0, 0, lit, 0.7, () => { g.lineWidth = R * 0.09; g.beginPath(); g.arc(0, R * 0.05, R * 0.86, 0.55 * Math.PI, 1.0 * Math.PI); g.stroke(); });
  } else if (kind === 'wrenches') {
    const wrench = a => () => {
      g.rotate(a); g.lineWidth = R * 0.24; g.beginPath(); g.moveTo(-R * 0.62, 0); g.lineTo(R * 0.62, 0); g.stroke();
      for (const e of [-1, 1]) { g.beginPath(); g.arc(e * R * 0.74, 0, R * 0.27, 0, TAU); g.fill(); }
    };
    for (const a of [Math.PI / 4, -Math.PI / 4]) both(wrench(a));
    layer(0, 0, dark, 0.9, () => { for (const a of [Math.PI / 4, -Math.PI / 4]) { g.save(); g.rotate(a); for (const e of [-1, 1]) g.fillRect(e * R * 0.92 - R * 0.11, -R * 0.08, R * 0.22, R * 0.16); g.restore(); } });
  } else if (kind === 'boot') {
    const boot = () => { g.beginPath(); g.moveTo(-R * 0.42, -R * 0.95); g.lineTo(R * 0.2, -R * 0.95); g.lineTo(R * 0.18, R * 0.22); g.quadraticCurveTo(R * 0.95, R * 0.25, R * 0.95, R * 0.62); g.lineTo(R * 0.95, R * 0.82); g.lineTo(-R * 0.5, R * 0.82); g.lineTo(-R * 0.5, R * 0.5); g.closePath(); g.fill(); };
    both(boot);
    layer(0, 0, dark, 0.85, () => { g.lineWidth = R * 0.1; g.beginPath(); g.moveTo(-R * 0.44, -R * 0.62); g.lineTo(R * 0.2, -R * 0.62); g.stroke(); g.beginPath(); g.moveTo(-R * 0.5, R * 0.66); g.lineTo(R * 0.95, R * 0.66); g.stroke(); });
  } else if (kind === 'lion') {
    // a lion's head, full face, in a scalloped mane
    const mane = () => { g.beginPath(); for (let k = 0; k <= 48; k++) { const a = k / 48 * TAU, rr = R * (0.86 + 0.14 * Math.cos(a * 12)); g.lineTo(Math.cos(a) * rr, Math.sin(a) * rr); } g.closePath(); g.fill(); };
    both(mane);
    layer(0, 0, dark, 0.8, () => { g.beginPath(); g.moveTo(-R * 0.48, -R * 0.38); g.quadraticCurveTo(0, -R * 0.62, R * 0.48, -R * 0.38); g.quadraticCurveTo(R * 0.5, R * 0.3, 0, R * 0.66); g.quadraticCurveTo(-R * 0.5, R * 0.3, -R * 0.48, -R * 0.38); g.fill(); });
    layer(0, 0, lightOf(col, 0.25), 1, () => { g.beginPath(); g.moveTo(-R * 0.4, -R * 0.32); g.quadraticCurveTo(0, -R * 0.52, R * 0.4, -R * 0.32); g.quadraticCurveTo(R * 0.42, R * 0.26, 0, R * 0.56); g.quadraticCurveTo(-R * 0.42, R * 0.26, -R * 0.4, -R * 0.32); g.fill(); });
    layer(0, 0, dark, 1, () => { for (const e of [-1, 1]) { g.beginPath(); g.ellipse(e * R * 0.18, -R * 0.1, R * 0.08, R * 0.05, e * 0.3, 0, TAU); g.fill(); } g.beginPath(); g.moveTo(-R * 0.13, R * 0.18); g.lineTo(R * 0.13, R * 0.18); g.lineTo(0, R * 0.32); g.closePath(); g.fill(); g.lineWidth = R * 0.06; g.beginPath(); g.moveTo(0, R * 0.32); g.lineTo(0, R * 0.42); g.moveTo(-R * 0.14, R * 0.46); g.quadraticCurveTo(0, R * 0.38, R * 0.14, R * 0.46); g.stroke(); });
  }
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
  // warm skin: shadows lean red-brown (not violet-grey), pale skin lifts toward a peachy cream
  const L = hsl(c).l, dk = Math.max(0, 0.42 - L) * 1.4, pale = Math.max(0, L - 0.6) * 3;
  return {
    base: c, light: mix(lightOf(c, 0.32 + dk * 0.3), '#f4cfa4', 0.12 + 0.3 * pale), hi: mix(lightOf(c, 0.58 + dk * 0.45), '#f8d8b0', 0.2 + 0.2 * pale),
    shadow: mix(shadowOf(c, 0.3 - dk * 0.1), '#8a4638', 0.16), deep: mix(shadowOf(c, 0.52 - dk * 0.25), '#5c2a26', 0.14),
    cool: mix(shadowOf(c, 0.28), '#7a4a4c', 0.15), blush: mix(c, '#c8664c', 0.4), lip: mix(shadowOf(c, 0.15), '#a4484a', 0.4),
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
  const ew = (fem ? 2.05 : 1.75) * KX, eh = (fem ? 0.7 : 0.5) * KY;
  const inner = [cx - s * ew, cy + eh * 0.25], outer = [cx + s * ew, cy - eh * (fem ? 0.3 : 0.05)];
  const almond = () => {
    g.beginPath(); g.moveTo(...inner);
    g.quadraticCurveTo(cx - s * ew * 0.1, cy - eh * 2.0, ...outer);
    g.quadraticCurveTo(cx + s * ew * 0.25, cy + eh * 1.5, ...inner);
    g.closePath();
  };
  g.save();
  almond(); g.fillStyle = glow ? mix('#d0b8a0', glow, 0.4) : mix('#d6c6b0', T.base, 0.25); g.fill();
  g.clip();
  const ir = (fem ? 0.6 : 0.5), ix = cx + s * 0.08 * KX, iy = cy - eh * 0.05;
  ellipse(g, ix, iy, ir * KX, ir * KY, 0, glow ? shadowOf(glow, 0.4) : shadowOf(L.eyes, 0.6));
  ellipse(g, ix, iy + ir * KY * 0.12, ir * KX * 0.78, ir * KY * 0.74, 0, glow || L.eyes);
  blob(g, ix, iy + ir * KY * 0.45, ir * KX * 0.6, ir * KY * 0.35, 0, glow ? '#ffb08a' : lightOf(L.eyes, 0.55), 0.6, 0.2);
  ellipse(g, ix, iy, ir * KX * 0.36, ir * KY * 0.38, 0, glow ? '#4a0808' : '#1e1418');
  gradV(g, cx - ew, cy - eh * 2.2, ew * 2, eh * 2.8, [[0, rgba(T.deep, 1)], [0.6, rgba(mix(T.deep, '#3a2026', 0.3), 0.75)], [1, rgba(T.deep, 0)]]);
  ellipse(g, ix - ir * KX * 0.32, iy - ir * KY * 0.12, ir * KX * 0.2, ir * KY * 0.2, 0, '#fff6e0', 0.95);
  g.restore();
  // the upper lid: thick and dark, heaviest toward the outer corner. A woman's sweeps on past the
  // corner in one tapered wedge (her lashes, painted as a single dark shape: no spikes)
  const lid = fem ? '#3a2626' : '#2a1812';
  const up = [inner, [cx - s * ew * 0.35, cy - eh * 1.25], [cx + s * ew * 0.3, cy - eh * 1.4], outer];
  if (fem) {
    stroke(g, up, 2.2, 5.6, lid, 0.97);
    stroke(g, [[outer[0] - s * ew * 0.25, outer[1] - eh * 0.55], outer, [outer[0] + s * ew * 0.22, outer[1] - eh * 0.5], [outer[0] + s * ew * 0.38, outer[1] - eh * 1.05]], 5.2, 0.6, lid, 0.95);
  } else stroke(g, [...up, [outer[0] + s * ew * 0.2, outer[1] + eh * 0.3]], 2.6, 4.6, lid, 0.97);
  stroke(g, up.map(([x, y]) => [x, y - 2]), 2, 3, mix(T.deep, lid, 0.4), 0.45);
  // the lid crease above, a lit fold of lid under the brow
  stroke(g, curve(inner[0] + s * ew * 0.15, cy - eh * 2.5, outer[0] - s * ew * 0.05, cy - eh * 2.25, -s * eh * 0.6, 4), 2, 1.4, mix(T.deep, '#3a2026', 0.3), fem ? 0.45 : 0.6);
  blob(g, cx + s * ew * 0.1, cy - eh * 3.3, ew * 0.9, eh * 0.7, 0, T.light, fem ? 0.5 : 0.28, 0.2);
  // lower lid: a soft warm line, a bag of shadow (men), a lit cheek under it
  stroke(g, [[inner[0] + s * ew * 0.2, inner[1] + eh * 0.3], [cx + s * ew * 0.2, cy + eh * 1.3], [outer[0], outer[1] + eh * 0.7]], 1.8, 1.2, mix(T.deep, T.blush, 0.3), fem ? 0.55 : 0.7);
  if (!fem) blob(g, cx + s * 1.5, cy + eh * 2.2, ew * 0.75, eh * 0.7, 0, T.shadow, 0.3, 0.2);
}

// The face region of the jaw where stubble and beards grow (face cm).
const BEARD_ZONE = s => [[-15.5 * s, 1.5], [-11.5 * s, -3.5], [-6.8 * s, -6.2], [-3.1 * s, -7.0], [0, -6.6]];
function beardPath(K, top = 1) {
  const up = BEARD_ZONE(1).map(([x, y]) => [x, y * top]), dn = [[16, -8], [10.5, -14.6], [4, -16.2], [0, -16.6]];
  const pts = [...up, ...BEARD_ZONE(-1).map(([x, y]) => [x, y * top]).reverse().slice(1), ...dn.map(([x, y]) => [x, y]), ...dn.slice(0, -1).reverse().map(([x, y]) => [-x, y])];
  K.poly(pts);
}

// round a closed polygon's corners (Chaikin's corner cutting), so painted planes read as soft
// organic shapes rather than cut-out polygons
function chaikin(pts, n = 2) {
  let P = pts;
  for (let k = 0; k < n; k++) {
    const Q = [];
    for (let i = 0; i < P.length; i++) { const [ax, ay] = P[i], [bx, by] = P[(i + 1) % P.length]; Q.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]); }
    P = Q;
  }
  return P;
}
// The face is painted in a few readable planes with soft 2-4 px edges (a lit forehead and
// nose bridge, mid-tone cheeks, shadowed sides, sockets, jaw and the hollows under the
// cheekbones), then the features on top. Light from the upper left: the viewer's left, x < 0.
function paintHead(g, r, S, rnd) {
  const T = toneOf(S.tone), L = S.look, fem = L.female;
  const K = faceKit(g, r), { B, S: St, F, E } = K;
  const yBrow = K.yOf(0.047), yNoseTip = K.yOf(-0.012), yNoseB = K.yOf(-0.022), yMouth = K.yOf(-0.047), yChin = K.yOf(-0.08), yJaw = K.yOf(-0.092);
  const P = (pts, c, a, blur = 2.5) => { g.save(); g.filter = `blur(${blur}px)`; g.globalAlpha = a; K.poly(chaikin(pts, 2)); g.fillStyle = c; g.fill(); g.restore(); };
  const lit = s => s < 0 ? 1 : 0.72;
  const warm = fem ? '#d0705a' : '#c8664c';
  clip(g, r, () => {
    // skin lit from above; under the jaw a soft warm shadow, never a dark band
    const vJ = headV(-0.094);
    gradV(g, r.x, r.y, r.w, r.h, [[0, T.light], [1 - 0.8, mix(T.light, T.base, 0.35)], [1 - 0.62, T.base], [1 - vJ - 0.03, T.base], [1 - vJ + 0.04, mix(T.base, '#9a6450', 0.28)], [1, mix(T.base, T.shadow, 0.3)]]);
    for (let i = 0; i < 16; i++) wblob(g, r, r.x + rnd() * r.w, r.y + rnd() * r.h * 0.85, range(rnd, 16, 40), range(rnd, 10, 22), rnd() * 3, pick(rnd, [T.light, T.shadow, T.blush]), 0.1, 0.1);
    weave(g, r.x, r.y, r.w, r.h, T.base, rnd, { a: 0.035, len: [2, 4], dir: 0.3 });     // faint brushwork in the skin
    for (const s of [-1, 1]) {
      const sp = pts => pts.map(([x, y]) => [x * s, y]);
      // the sides of the head turn away from the light: one broad plane from the temple to the jaw corner
      P(sp([[8.6, 9], [9.9, 3.2], [9.4, -1.5], [10.3, -6.5], [12.3, -11.5], [14.6, -16], [36, -16], [36, 9]]), T.shadow, 0.3 + 0.14 * (1 - lit(s)), 4);
      P(sp([[13.5, 6], [14.8, -2], [16.2, -10], [36, -10], [36, 6]]), T.cool, 0.2, 5);
      // the cheekbone: a lit plane under the eye
      P(sp([[2.6, -1.4], [5.2, -0.9], [7.8, -1.1], [8.8, -2.6], [7.2, -3.8], [4.2, -3.7], [2.6, -3.0]]), T.light, 0.48 * lit(s), 2.5);
      // under it, a hollow running down to the jaw corner
      P(sp([[5.6, -4.6], [8.8, -3.6], [10.2, -6.5], [11, -10.4], [8.4, -10.2], [6.2, -7.6]]), T.shadow, (fem ? 0.1 : 0.26) * (1.25 - 0.25 * lit(s)), 4);
      // the eye socket: a soft pool from the brow down under the eye
      P(sp([[1.3, 1.9], [3.5, 2.3], [5.9, 1.8], [6.4, 0.2], [5.4, -1.3], [3.4, -1.6], [1.6, -0.9], [1.1, 0.6]]), mix(T.shadow, T.cool, 0.4), fem ? 0.28 : 0.55, 2.2);
      // the brow ridge's lit top
      P(sp([[1.0, 3.1], [3.4, 3.6], [6.0, 3.3], [6.3, 2.5], [3.4, 2.4], [1.2, 2.2]]), T.hi, (fem ? 0.28 : 0.52) * lit(s), 1.8);
      // the jaw: a shadow plane under the lit chin, out to the jaw's corner
      P(sp([[2.7, -13.3], [6.5, -12.5], [10.5, -10.7], [12.7, -12.5], [11.5, -14.8], [6.5, -15.8], [2.7, -15.8]]), T.shadow, fem ? 0.26 : 0.44, 2.5);
      // the flank of the nose
      P(sp(fem ? [[0.6, -0.5], [1.3, -1.6], [1.8, -4.0], [1.3, -5.0], [0.8, -4.2], [0.7, -2.0]] : [[0.75, 1.0], [1.5, 0.0], [2.0, -2.5], [2.4, -4.4], [1.6, -5.3], [0.9, -4.4], [0.8, -2.0]]), T.shadow, (s > 0 ? 0.52 : 0.28) * (fem ? 0.6 : 1), 1.8);
      // warm color in the cheeks
      B(s * 5.2, -3.9, 2.5, 1.8, warm, fem ? 0.3 : 0.2, 0.2);
    }
    // the forehead: a lit plane from the brows to the hairline, brightest top-left
    P([[-7.4, 7.6], [7.4, 7.6], [8, 4.4], [6.2, 3.4], [1.4, 2.9], [-1.4, 2.9], [-6.2, 3.4], [-8, 4.4]], T.light, 0.48, 3);
    P([[-6, 7.2], [1.5, 7.2], [1.0, 4.5], [-1, 3.7], [-5.6, 4.0]], T.hi, 0.32, 3);
    B(-0.2, 1.9, 0.8, 1.2, T.light, 0.42, 0.25);                              // between the brows
    if (S.hat === 'hood') P([[-12, 10], [12, 10], [12, 5.2], [6, 4.4], [-6, 4.4], [-12, 5.2]], '#2e2228', 0.42, 4);   // in the hood's shade
    // the nose: a lit bridge down to a lit, warm tip; nostril wings; the shadow it casts on the lip
    P(fem ? [[-0.7, 0.4], [0.35, 0.4], [0.45, -3.6], [-0.75, -3.8]] : [[-1.0, 1.8], [0.45, 1.8], [0.55, -2.6], [0.6, -4.0], [-0.9, -4.2], [-1.2, -2.6]], T.hi, fem ? 0.4 : 0.55, 1.6);
    B(-0.25, yNoseTip + 0.25, 1.3, 0.9, T.hi, 0.66, 0.4);
    B(-0.45, yNoseTip + 0.5, 0.45, 0.32, '#fff2dc', 0.35, 0.3);
    B(0.1, yNoseTip - 0.3, 1.25, 0.6, warm, fem ? 0.32 : 0.26, 0.3);
    for (const s of [-1, 1]) {
      B(s * 1.55, yNoseB + 0.75, 0.75, 0.75, T.shadow, 0.55, 0.3);
      B(s * 1.4 - 0.15, yNoseB + 1.15, 0.4, 0.32, T.light, 0.38, 0.3);
      E(s * (fem ? 0.6 : 0.72), yNoseB + 0.15, fem ? 0.22 : 0.3, fem ? 0.17 : 0.24, mix(T.deep, '#3a1a1a', 0.4), fem ? 0.6 : 0.9, s * 0.4);
    }
    P([[-1.9, yNoseB + 0.15], [2.1, yNoseB + 0.15], [1.6, yNoseB - 0.95], [-1.2, yNoseB - 0.95]], T.deep, fem ? 0.4 : 0.58, 1.6);
    B(0, -7.3, 0.35, 0.9, T.shadow, 0.36, 0.3);                               // philtrum
    for (const s of [-1, 1]) B(s * 0.55 - 0.1, -7.2, 0.18, 0.7, T.light, 0.28, 0.3);
    // men: smile folds from the nose wings round the mouth, lit on the cheek side
    if (!fem) for (const s of [-1, 1]) {
      const fold = curve(s * 2.0, yNoseB + 0.6, s * 3.1, yMouth + 0.3, -s * 0.4, 4);
      St(fold, 3.6, 1.2, T.shadow, 0.42);
      St(fold.map(([x, y]) => [x + s * 0.5, y + 0.1]), 3.2, 1.2, T.light, 0.26);
    }
    facialBase(g, K, S, T, rnd);
    // the mouth
    const mw = fem ? 2.15 : 2.5, yM = yMouth;
    if (fem) {
      // two filled lips: a darker upper lip, a fuller lower one with one cream highlight
      const fillP = (pts, c, a) => { g.save(); g.filter = 'blur(0.7px)'; g.globalAlpha = a; K.poly(pts); g.fillStyle = c; g.fill(); g.restore(); };
      fillP([[-mw, yM + 0.05], [-mw * 0.55, yM + 0.62], [-0.3, yM + 0.44], [0, yM + 0.56], [0.3, yM + 0.44], [mw * 0.55, yM + 0.62], [mw, yM + 0.05], [mw * 0.4, yM - 0.06], [0, yM - 0.03], [-mw * 0.4, yM - 0.06]], '#a5504c', 0.92);
      fillP([[-mw * 0.9, yM - 0.06], [0, yM - 0.1], [mw * 0.9, yM - 0.06], [mw * 0.55, yM - 0.88], [0, yM - 1.08], [-mw * 0.55, yM - 0.88]], '#c0625a', 0.92);
      B(-0.35, yM - 0.46, 0.65, 0.2, '#f0c8b0', 0.75, 0.4);
      St([[-mw, yM + 0.05], [-mw * 0.4, yM - 0.04], [0, yM - 0.01], [mw * 0.4, yM - 0.04], [mw, yM + 0.05]], 1.7, 1.3, '#6a2a2a', 0.8);
      for (const s of [-1, 1]) B(s * mw * 1.05, yM + 0.1, 0.28, 0.28, T.deep, 0.4, 0.3);
      B(0, yM - 1.55, mw * 0.6, 0.45, T.shadow, 0.42, 0.3);
    } else {
      B(0, yM + 0.55, mw * 0.95, 0.5, mix(T.lip, T.shadow, 0.4), 0.72, 0.4);
      B(0, yM - 0.65, mw * 0.78, 0.6, T.lip, 0.6, 0.4);
      B(-0.4, yM - 0.55, mw * 0.33, 0.2, T.hi, 0.45, 0.3);
      const corner = L.stern ? -0.3 : 0.2;
      St([[-mw, yM + corner], [-mw * 0.45, yM + 0.08], [0, yM - 0.06], [mw * 0.45, yM + 0.08], [mw, yM + corner]], 2.8, 2.2, '#4a2622', 0.9);
      for (const s of [-1, 1]) B(s * mw * 1.08, yM + corner, 0.3, 0.3, T.deep, 0.45, 0.3);
      B(0, yM - 1.55, mw * 0.72, 0.5, T.deep, 0.55, 0.3);
    }
    // the chin: a man's is a lit square plane, a woman's a small round one
    if (fem) B(-0.2, yChin + 0.7, 1.9, 1.15, T.light, 0.5, 0.35);
    else P([[-2.4, -11.2], [2.1, -11.2], [3.0, -12.4], [2.4, -14.0], [-2.6, -14.0], [-3.2, -12.4]], T.light, 0.42, 3);
    if (!fem && S.skin === 0) St([[0, yChin + 1.3], [0, yChin + 0.3]], 1.8, 1.2, T.shadow, 0.45);
    B(0, yJaw - 1.6, 9, 1.9, '#9a6450', 0.4, 0.3);                            // under the jaw: warm, soft
    B(0, yJaw - 5.5, 2.6, 2.4, T.light, 0.2);                                  // the throat catches a little light
    // eyes & brows
    for (const s of [-1, 1]) paintEye(g, K, s, S, S.eyeGlow);
    const browC = L.hair === 'bald' ? mix(L.hairColor, '#5a4a3e', 0.45) : mix(shadowOf(L.hairColor, 0.12), '#3a2a22', hsl(L.hairColor).l < 0.15 ? 0.4 : 0);
    for (const s of [-1, 1]) {
      const iy = yBrow - (L.stern ? 0.95 : 0.5);
      const pts = [[s * 1.0, iy + (fem ? 0.15 : 0)], [s * 2.4, yBrow + (fem ? 0.22 : 0.05)], [s * 4.0, yBrow + (fem ? 0.3 : 0.25)], [s * 5.9, yBrow - (fem ? 0.35 : 0.5)]];
      const fp = pts.map(([x, y]) => F(x, y));
      if (fem) { stroke(g, fp.map(([x, y]) => [x, y + 1.5]), 5, 1.6, T.shadow, 0.3); stroke(g, fp, 5.5, 1.8, browC, 0.95); continue; }
      stroke(g, fp.map(([x, y]) => [x + 1, y + 3]), 15, 5, mix(T.deep, INK, 0.2), 0.45);
      stroke(g, fp, 15, 5.5, browC, 0.97);
      for (let k = 0; k < 9; k++) {   // hairy strokes along the brow, lit on top
        const t = k / 8, [px, py] = F(s * (1.1 + t * 4.6), yBrow - 0.45 + Math.sin(t * Math.PI) * 0.75 - (L.stern ? (1 - t) * 0.4 : 0));
        stroke(g, [[px - s * 2, py + 3], [px + s * 4, py - 3]], 1.8, 0.7, lightOf(browC, 0.35), 0.45);
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
  const sc = mix(mix(L.hairColor, T.shadow, 0.5), '#4a3a36', 0.2);
  const amt = f === 'stubble' ? 0.42 : f === 'goatee' ? 0.26 : f === 'beard' ? 0.6 : 0.32;
  K.B(0, -12, 13, 6, sc, amt, 0.4);
  K.B(0, -7.6, 3.2, 0.9, sc, amt * 0.85, 0.3);
  for (let i = 0; i < 14; i++) K.B(range(rnd, -13, 13), range(rnd, -15, -5), range(rnd, 1.2, 2.6), range(rnd, 0.8, 1.4), sc, amt * 0.22, 0.1);
  g.restore();
}

// A painted mustache: thick, sweeping out and down from under the nose, one soft lit band along
// its top, no outline. Near-black hair paints as a warm dark brown. With `line` (a MUSTACHES
// entry) it is painted along the modeled roll's center line, which samples it there.
function paintMustache(g, K, hc, T, { droop = 0.6, curl = false, width = 1, line = null } = {}) {
  const yN = K.yOf(-0.025), yM = K.yOf(-0.047);
  const base = hsl(hc).l < 0.2 ? mix(hc, '#3a2a22', 0.65) : hc, dark = mix(shadowOf(base, 0.3), '#3a2a22', 0.35), lit = lightOf(base, 0.22);
  if (line) {
    const pts = []; for (let k = 0; k <= 16; k++) { const [th, dy] = mustacheAt(k / 16, line); pts.push([-th * FACE_ARC, K.yOf(dy)]); }
    const halves = [pts.slice(0, 9).reverse(), pts.slice(8)];
    const off = (P, dy) => P.map(([x, y]) => [x, y + dy]);
    for (const H of halves) K.S(off(H, -0.7), 22, 8, T.deep, 0.3);             // its soft shadow on the lip
    for (const H of halves) K.S(H, 28, 12, base, 1);
    for (const H of halves) K.S(off(H, -0.3), 12, 5, dark, 0.9);               // the underside
    for (const H of halves) K.S(off(H, 0.28), 8, 3, lit, 0.55);                // one soft lit band along the top
    return;
  }
  for (const s of [-1, 1]) {
    const ends = curl ? [[s * 3.6 * width, yM - 0.2], [s * 4.1 * width, yM + 0.7]] : [[s * 3.4 * width, yM - droop]];
    const pts = [[s * 0.2, yN - 0.15], [s * 1.5, yN - 0.75], [s * 2.6 * width, yM + 0.6], ...ends];
    K.S(pts.map(([x, y]) => [x + 0.1, y - 0.45]), 20, 6, T.deep, 0.32);
    K.S(pts, 23, curl ? 6 : 8.5, dark, 1);
    K.S(pts.map(([x, y]) => [x, y + 0.18]), 17, curl ? 4.5 : 6.5, base, 1);
    K.B(s * 1.4, yN - 0.55, 1.1, 0.32, lit, 0.45, 0.3, s * 0.4);
  }
}

// A beard: a few big clumps, each drawn from its top edge down toward the chin's point, each
// with one soft lit band near its top and a dark accent only where it parts from the next.
function beardClumps(g, K, rnd, { x0, x1, yTop, yBot, n = 7, w = [3.2, 5], pull = 0.5, ink }) {
  const step = (x1 - x0) / n, list = [];
  for (let pass = 0; pass < 2; pass++) {
    let x = x0 + step * (pass ? 0.55 : 0.15);
    while (x < x1) {
      const yt = yTop(x) + range(rnd, -0.2, 0.5) - pass * 0.6, yb = yBot(x) - range(rnd, 0, 1.5);
      const W = range(rnd, w[0], w[1]) * (pass ? 0.8 : 1) * K.KX, xe = x * (1 - pull) + range(rnd, -0.5, 0.5);
      list.push({ pts: [[x, yt], [x * (1 - pull * 0.2), yt + (yb - yt) * 0.3], [x * (1 - pull * 0.6), yt + (yb - yt) * 0.65], [xe, yb]], W, c: pick(rnd, ink.mids), g: rnd() < 0.65 ? 0.5 : 0 });
      x += step * range(rnd, 0.5, 1.5);
    }
  }
  for (const lk of list) paintLock(g, densify(lk.pts.map(([x, y]) => K.F(x, y)), 8), lk.W, lk.c, { lit: ink.lit, gap: ink.gap, gapA: lk.g, band: 0.22, tip: 0.3 });
}
function facialHair(g, K, S, T, rnd) {
  const L = S.look, f = L.facial;
  const topOf = tab => x => K.yOf(lerpTable(tab, Math.abs(x) / FACE_ARC, 1));
  if (f === 'mustache') paintMustache(g, K, L.hairColor, T, { line: MUSTACHES.mustache });
  if (f === 'pencil') for (const s of [-1, 1]) { const pts = [[s * 0.25, K.yOf(-0.0265)], [s * 1.5, K.yOf(-0.0285)], [s * 2.6, K.yOf(-0.033)]]; K.S(pts.map(([x, y]) => [x, y - 0.35]), 4, 1.6, T.deep, 0.3); K.S(pts, 4.2, 1.6, mix(shadowOf(L.hairColor, 0.1), '#3a2a22', 0.3), 0.95); }
  if (f === 'goatee') {
    // a warm grey tuft on the chin and down the neck front, where the modeled wedge samples it
    const hc = '#8d8478', ink = { gap: '#5e564c', lit: '#bdb5a6', mids: [hc, '#958c80', '#857c70'] };
    g.save(); K.poly([[-4.6, -8.8], [4.6, -8.8], [5.0, -12], [3.4, -17], [0, -19.5], [-3.4, -17], [-5.0, -12]]); g.clip();
    K.B(0, -13, 5, 7, hc, 0.95, 0.6);
    beardClumps(g, K, rnd, { x0: -4.4, x1: 4.4, yTop: topOf(GOATEE_TOP), yBot: () => -19, n: 4, w: [2.4, 3.4], pull: 0.55, ink });
    g.restore();
    paintMustache(g, K, hc, T, { droop: 1.4, width: 0.95 });
  }
  if (f === 'beard') {
    // the whole beard, painted where the modeled beard sheet samples it: up the cheeks
    // into the sideburns, round the jaw, and on down the neck front for the hanging part
    const hc = L.hairColor, ink = hairInks(hc), top = topOf(BEARD_TOP), xs = 17.5;
    g.save();
    g.beginPath();
    for (let k = 0; k <= 40; k++) { const x = -xs + 2 * xs * k / 40, [px, py] = K.F(x, top(x) + 0.4); k ? g.lineTo(px, py) : g.moveTo(px, py); }
    for (const [x, y] of [[xs, -9], [12, -16], [9, -26], [-9, -26], [-12, -16], [-xs, -9]]) g.lineTo(...K.F(x, y));
    g.closePath(); g.clip();
    K.B(0, -12, 16, 12, mix(hc, shadowOf(hc, 0.3), 0.5), 0.95, 0.6);
    beardClumps(g, K, rnd, { x0: -xs, x1: xs, yTop: top, yBot: x => Math.abs(x) > 11 ? -12 + (Math.abs(x) - 11) * 0.6 : -24, n: 8, w: [3.2, 5.2], pull: 0.45, ink });
    // the underside, where the beard hangs off the chin over the neck, in its own shadow
    const [, ya] = K.F(0, -13.5), [, yb] = K.F(0, -24);
    gradV(g, 0, ya, AW, yb - ya, [[0, rgba(shadowOf(hc, 0.4), 0)], [1, rgba(shadowOf(hc, 0.4), 0.55)]]);
    g.restore();
    // the soft upper edge on the cheeks: short strokes fading into the skin
    for (let i = 0; i < 14; i++) { const x = range(rnd, -15, 15), y = top(x) + 0.2; K.S([[x, y + range(rnd, 0.3, 0.9)], [x * 0.98, y - 1.2]], range(rnd, 4, 7), 1.5, mix(hc, shadowOf(hc, 0.3), 0.4), 0.32); }
    paintMustache(g, K, hc, T, { line: MUSTACHES.beard });
  }
}

// Hair the WoW way: big locks flowing up from the hairline and back over the crown, 2:1 varied
// widths at jittered spacing, each laid over the last: a quiet mid-tone body, one soft lit
// band near the hairline, a dark accent only where two locks part. ys(x) / ye(x): where a
// lock starts (the hairline) and ends.
function hairFlow(g, base, rnd, { x0, x1, ys, ye, count = 9, width = [18, 36], lean = () => 0, sheen = 0.3, wrapW = 0 }) {
  const { gap, lit, mids } = hairInks(base), step = (x1 - x0) / count, list = [];
  for (let pass = 0; pass < 2; pass++) {
    let x = x0 + step * (pass ? 0.5 : 0.05);
    while (x < x1) {
      const W = range(rnd, width[0], width[1]) * (pass ? 0.85 : 1);
      const y0 = ys(x) + range(rnd, -1, 2) + pass * 4, y1 = ye(x) + range(rnd, 0, 8);
      const L = y0 - y1, dx = lean(x) * L, bend = (rnd() - 0.5) * W * 0.8;
      const pts = []; for (let k = 0; k <= 8; k++) { const q = k / 8; pts.push([x + dx * q * q + Math.sin(q * Math.PI) * bend * 0.5, y0 - L * q]); }
      list.push({ pts, W, c: pick(rnd, mids), b: sheen + range(rnd, -0.08, 0.08), g: rnd() < 0.65 ? 0.5 : 0 });
      x += step * range(rnd, 0.5, 1.5);
    }
  }
  const copies = lk => wrapW ? [lk.pts, lk.pts.map(([a, b]) => [a + wrapW, b]), lk.pts.map(([a, b]) => [a - wrapW, b])] : [lk.pts];
  for (const lk of list) for (const P of copies(lk)) {
    blob(g, P[0][0], P[0][1] - 1, lk.W * 0.5, lk.W * 0.28, 0, lk.c, 1, 0.85);    // rounded at the hairline
    paintLock(g, P, lk.W, lk.c, { lit, gap, gapA: lk.g, band: lk.b, tip: 0.35 });
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
      x0: r.x, x1: r.x + r.w, count: 14, width: [24, 46], wrapW: r.w,
      ys: x => Y(headV(lineDy(headTh((x - r.x) / r.w)))) + 2, ye: () => r.y - 6,
      lean: x => { const th = headTh((x - r.x) / r.w); return -Math.sin(th) * 0.35; },
    });
  }
  g.restore();
  // the hairline: hair casts a soft shadow onto the forehead; a few short wisps break the edge
  g.save(); g.globalAlpha = 0.24; g.translate(0, 4); capPath(); g.fillStyle = shadowOf(S.tone, 0.55); g.fill(); g.restore();
  if (L.hair !== 'buzz') {
    if (!L.female) for (const s of [-1, 1]) {   // short sideburns, their lower edge feathered into the skin
      const th = s * 1.36, x = XT(th), y0 = Y(headV(0.012)), y1 = Y(headV(L.facial === 'beard' ? -0.05 : -0.004));
      g.save(); g.beginPath(); g.moveTo(x - 7, y0 - 2); g.lineTo(x + 7, y0 - 2); g.lineTo(x + 5, y1 - 6); g.lineTo(x - 5, y1 - 5); g.closePath();
      g.fillStyle = shadowOf(hc, 0.1); g.fill(); g.restore();
      for (let k = 0; k < 5; k++) { const xx = x - 5 + k * 2.6; stroke(g, [[xx, y1 - 9], [xx + range(rnd, -1.2, 1.2), y1 + range(rnd, -1, 3)]], 2.6, 0.4, shadowOf(hc, 0.1), 0.8); }
      stroke(g, [[x - 3, y0], [x - 3, y1 - 6]], 4, 2, lightOf(hc, 0.25), 0.35);
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
        if (front && S.chest === 'laced') {
          // a laced split down the chest: a dark slit, brass eyelets, pale leather thong criss-crossing it
          stroke(g, [[U(cu), TV(1.45)], [U(cu), TV(1.2)]], 3.2, 1.2, shadowOf(c, 0.7), 0.9);
          for (let k = 0; k < 5; k++) {
            const y0 = TV(1.42 - k * 0.05), y1 = TV(1.37 - k * 0.05);
            stroke(g, [[U(cu - 0.018), y0 + 1], [U(cu + 0.018), y1 + 1]], 2.4, 2.4, INK, 0.4);
            stroke(g, [[U(cu - 0.018), y0], [U(cu + 0.018), y1]], 2, 2, '#d8c098', 0.95); stroke(g, [[U(cu + 0.018), y0], [U(cu - 0.018), y1]], 2, 2, '#c8ac80', 0.95);
            for (const e of [-1, 1]) rivet(g, U(cu + e * 0.02), y0, 1.3, BRASS);
          }
          stroke(g, [[U(cu - 0.004), TV(1.2)], [U(cu - 0.012), TV(1.12)]], 1.6, 1, '#d8c098', 0.9); stroke(g, [[U(cu + 0.004), TV(1.2)], [U(cu + 0.014), TV(1.13)]], 1.6, 1, '#c8ac80', 0.9);
        } else if (front) {
          // a plain panel: a stitched placket and one brass clasp at the throat
          stitches(g, [[U(cu - 0.012), TV(1.43)], [U(cu - 0.012), TV(1.0)]], lightOf(c, 0.4), 0.5);
          stitches(g, [[U(cu + 0.012), TV(1.43)], [U(cu + 0.012), TV(1.0)]], lightOf(c, 0.4), 0.5);
          rivet(g, U(cu), TV(1.415), 3, BRASS);
        }
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
      if (S.pauldrons === 'both') for (const u of [0.25, 0.75]) blob(g, U(u), TV(1.44), r.w * 0.11, 24, 0, INK, 0.45, 0.15);
    } else if (S.torso === 'shirt') {
      // Ed: a madder-red work shirt, buttoned, the apron's neck strap; braces down the back
      cloth(g, r, r.x, r.y, r.w, r.h, c, rnd, { folds: 10, light: 0.32, blotch: 14, wrap: true });
      for (const s2 of [-1, 1]) sfold(g, curve(U(0.5 + s2 * 0.2), TV(1.42), U(0.5 + s2 * 0.08), TV(1.12), s2 * 3, 5), 8, c, 0.9);
      stroke(g, [[U(0.5), TV(0.95)], [U(0.5), TV(1.48)]], 3, 3, shadowOf(c, 0.3), 0.6);
      for (let k = 0; k < 6; k++) rivet(g, U(0.505), TV(1.42 - k * 0.08), 1.6, '#d9ccb0');
      // the apron's waist ties, wrapped round and knotted at the back
      g.save(); g.fillStyle = '#5a3c26'; g.fillRect(r.x, TV(1.03), r.w, TV(0.995) - TV(1.03)); g.restore();
      stroke(g, [[U(0.02), TV(1.01)], [U(-0.04), TV(0.92)]], 4, 3, '#5a3c26', 1); stroke(g, [[U(0.98), TV(1.01)], [U(1.05), TV(0.93)]], 4, 3, '#5a3c26', 1);
      blob(g, U(0.0), TV(1.012), 7, 6, 0, '#4a3020', 1, 0.6); blob(g, U(1.0), TV(1.012), 7, 6, 0, '#4a3020', 1, 0.6);
      for (const s of [-1, 1]) for (const cu of [0, 1]) stroke(g, [[U(cu + s * 0.06), TV(1.0)], [U(cu + s * 0.04), TV(1.5)]], 5, 5, '#3d2a1c', 0.95);
      ao(0.99, 0.94, 0.3, 0);
      ao(1.46, 1.52, 0, 0.4);
    } else if (S.torso === 'bodice') {
      // a cream linen blouse with a gathered neckline, a laced bodice in her color over it
      cloth(g, r, r.x, r.y, r.w, r.h, LINEN, rnd, { folds: 0, wrap: true, light: 0.28 });
      // a few wide soft folds fanning from the gathered neckline over the shoulders, unevenly spaced
      for (let i = 0, u = 0.03; i < 6; i++, u += range(rnd, 0.11, 0.22)) sfold(g, curve(U(u), TV(1.46), U(u + range(rnd, -0.04, 0.04)), TV(1.3), range(rnd, -4, 4), 5), range(rnd, 9, 14), LINEN, 0.75, { dark: 0.45 });
      // short pleats where the drawstring gathers it
      for (let k = 0; k < 26; k++) { const u = (k + rnd() * 0.6) / 26; sfold(g, [[U(u), TV(1.49)], [U(u + 0.003), TV(1.445)]], 5, LINEN, 0.7, { dark: 0.45 }); }
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
      // the blouse sits in the bodice's shade just above its edge
      g.save(); g.filter = 'blur(3px)'; g.globalAlpha = 0.35; g.translate(0, -4); polyPath(g, P.slice(0, 9).concat([[U(1.01), TV(1.3)], [U(-0.01), TV(1.3)]])); g.fillStyle = shadowOf(LINEN, 0.5); g.fill(); g.restore();
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
      // a brass watch chain looping from a buttonhole to the fob pocket
      stroke(g, curve(U(0.515), TV(1.15), U(0.63), TV(1.12), 7, 8).map(([x, y]) => [x + 0.8, y + 1.2]), 2, 2, INK, 0.45);
      stroke(g, curve(U(0.515), TV(1.15), U(0.63), TV(1.12), 7, 8), 1.8, 1.8, BRASS, 1);
      for (let k = 0; k < 9; k++) { const [x, y] = curve(U(0.515), TV(1.15), U(0.63), TV(1.12), 7, 8)[k]; blob(g, x - 0.4, y - 0.5, 0.9, 0.7, 0, '#fbe7a8', 0.8, 0.5); }
      rivet(g, U(0.63), TV(1.12), 2.6, BRASS);
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
      // the sleeve rolled to a fat cuff a little over halfway down the upper arm (people.js models the
      // roll as a torus sampling armV(roll ± .012)); below it a bare, hairy forearm
      const top = LM.roll - 0.008;
      clipRect(g, r.x, AV(top), r.w, r.y + r.h - AV(top), () => {
        gradV(g, r.x, AV(top), r.w, AV(LM.wrist) - AV(top), [[0, skin.light], [0.45, skin.base], [1, skin.shadow]]);
        gradH(g, r.x, AV(top), r.w, AV(LM.wrist) - AV(top), [[0, rgba(INK, 0.08)], [0.25, rgba('#fff1c4', 0.16)], [0.75, rgba(skin.deep, 0.3)], [1, rgba(INK, 0.08)]]);
        blob(g, U(0.75), AV(LM.elbow), r.w * 0.12, 7, 0, skin.deep, 0.45, 0.3);                                  // the crook of the elbow
        blob(g, U(0.26), AV(LM.elbow + 0.005), r.w * 0.09, 6, 0, skin.hi, 0.4, 0.3);                              // the point of the elbow
        for (const u of [0.18, 0.32]) blob(g, U(u), AV(-0.37), r.w * 0.1, 16, 0, skin.light, 0.35, 0.2);          // the forearm's swell catches light
        stroke(g, [[U(0.64), AV(-0.34)], [U(0.6), AV(-0.44)], [U(0.63), AV(-0.53)]], 7, 3, skin.shadow, 0.35);     // the inner forearm's long shadow plane
        stroke(g, [[U(0.58), AV(-0.38)], [U(0.6), AV(-0.47)]], 2.2, 1.2, mix(skin.shadow, '#6a5a7a', 0.25), 0.35); // a vein
        for (let i = 0; i < 26; i++) { const x = U(rnd() * 0.55), y = AV(-0.32 - rnd() * 0.22); stroke(g, [[x, y], [x + 1.2, y + 3]], 1, 0.4, mix(S.look.hairColor, skin.shadow, 0.4), 0.28); }
      });
      // the roll: a lighter band of shirt, lit along its top, with a few creases where it's folded
      const v0 = av(LM.roll - 0.014), v1 = av(LM.roll + 0.014), rc = lightOf(c, 0.1);
      band(g, r, v0, v1, rc, 1);
      bandGrad(g, r, v0, v1, rgba('#fff0d0', 0.3), rgba(INK, 0.35));
      for (const u of [0.08, 0.31, 0.47, 0.72, 0.9]) sfold(g, [[U(u), RY(r, v1) + 1], [U(u + 0.05), RY(r, v0) - 1]], 7, rc, 0.95, { dark: 0.6 });
      hstitch(g, r, (v0 + v1) / 2, shadowOf(c, 0.4), 0.45);
      bandGrad(g, r, av(top - 0.025), av(top), rgba(skin.deep, 0.0), rgba(skin.deep, 0.45));   // the roll's shadow on the skin
      bandGrad(g, r, v1, av(LM.roll + 0.04), rgba(INK, 0.3), rgba(INK, 0));
    }
    // hands: bare, or big gloves with a flared gauntlet cuff. Fingers lie side by side across
    // the back (u .19 .25 .31) and the palm (u .69 .75 .81) and end at the bottom (v 0).
    const fingers = (base, deep, light, tipC) => {
      // (people.js grooves the hand at exactly these u: 1/6, 1/4, 1/3 on the back, 2/3, 3/4, 5/6 on the palm)
      for (const u of [1 / 6, 0.25, 1 / 3]) { stroke(g, [[U(u), V(0.0)], [U(u), AV(LM.knuckle - 0.005)]], 2.4, 1.6, deep, 0.7); stroke(g, [[U(u) - 2, V(0.0)], [U(u) - 2, AV(LM.knuckle - 0.005)]], 1.4, 1, light, 0.35); }
      for (const u of [2 / 3, 0.75, 5 / 6]) stroke(g, [[U(u), V(0.0)], [U(u), AV(-0.69)]], 2, 1.4, deep, 0.6);
      for (const u of [0.115, 0.208, 0.292, 0.385]) { blob(g, U(u), AV(LM.knuckle + 0.004), 4, 3, 0, light, 0.7, 0.3); blob(g, U(u), AV(-0.725), 3.5, 2.5, 0, light, 0.4, 0.3); blob(g, U(u), V(0.03), 3.5, 2.6, 0, tipC, 0.6, 0.35); }
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
        for (const u of [0.115, 0.208, 0.292, 0.385]) blob(g, U(u), V(0.022), 2.6, 1.8, 0, mix(skin.hi, '#f8e4dc', 0.5), 0.75, 0.5);   // nails
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
        if (S.bracer === 'laced') for (const u0 of [0.25, 0.75]) {
          // a laced split up the bracer: a dark slit, brass eyelets, a pale thong criss-crossing it
          stroke(g, [[U(u0), AV(LM.cuffBot - 0.004)], [U(u0), AV(LM.wrist + 0.01)]], 2.4, 1.6, shadowOf(cuffC, 0.7), 0.85);
          for (let k = 0; k < 3; k++) {
            const y0 = AV(LM.cuffBot - 0.008 - k * 0.022), y1 = AV(LM.cuffBot - 0.008 - (k + 1) * 0.022);
            stroke(g, [[U(u0 - 0.06), y0], [U(u0 + 0.06), y1]], 1.8, 1.8, '#dcc49c', 0.95); stroke(g, [[U(u0 + 0.06), y0], [U(u0 - 0.06), y1]], 1.8, 1.8, '#c8ac80', 0.95);
            for (const e of [-1, 1]) rivet(g, U(u0 + e * 0.065), y0, 1.3, BRASS);
          }
        }
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
    const pants = S.legs === 'trousers' ? TROUSER : S.legs === 'wool' ? '#5a4c46' : S.legs === 'black' ? '#2e2a34' : S.color;
    cloth(g, r, r.x, r.y, r.w, r.h, pants, rnd, { folds: 3, foldAngle: 0, foldLen: [0.1, 0.2], wrap: true });
    // warm where the light hits the thighs, cooling toward the shins
    gradV(g, r.x, V(1), r.w, V(0.2) - V(1), [[0, rgba(lightOf(pants, 0.35), 0.22)], [0.5, rgba(pants, 0)], [1, rgba(mix(pants, '#4a4a6a', 0.5), 0.3)]]);
    if (S.legs === 'black') { g.save(); g.globalAlpha = 0.16; g.fillStyle = '#c8c0d8'; for (let x = r.x + 2; x < r.x + r.w; x += 6) g.fillRect(x, r.y, 1, r.h); g.restore(); }   // pinstripes, like his vest
    if (S.legs === 'wool') weave(g, r.x, r.y, r.w, r.h, pants, rnd, { a: 0.14, len: [2, 4] });
    // the crotch: wide soft wedges fanning down from the inner thigh's top
    for (let k = 0; k < 3; k++) sfold(g, curve(U(0.7 + k * 0.05), V(0.97), U(0.58 + k * 0.1), V(0.8 - k * 0.03), 3, 4), 12, pants, 0.8, { dark: 0.55 });
    // a pressed crease down the front of the leg, lit
    if (S.legs === 'black' || S.legs === 'wool') { stroke(g, [[U(0.5), V(0.98)], [U(0.5), V(0.2)]], 2.4, 2.4, lightOf(pants, 0.5), 0.45); stroke(g, [[U(0.515), V(0.98)], [U(0.515), V(0.2)]], 1.6, 1.6, shadowOf(pants, 0.4), 0.4); }
    blob(g, U(0.5), V(0.54), r.w * 0.09, 8, 0, '#b8ae9c', 0.18, 0.3);   // worn at the knee
    for (let i = 0; i < 5; i++) sfold(g, curve(U(0.88 + rnd() * 0.24 - 0.12), V(0.5 + rnd() * 0.06), U(0.1 + rnd() * 0.2), V(0.5 + rnd() * 0.06), 3), 6, pants, 0.9, { dark: 0.6 });  // behind the knee
    for (let i = 0; i < 3; i++) sfold(g, curve(U(0.36 + rnd() * 0.1), V(0.62 + rnd() * 0.05), U(0.56 + rnd() * 0.1), V(0.58 + rnd() * 0.05), 3, 3), 5, pants, 0.7);       // over the knee
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.15)], [0.35, rgba('#fff1c4', 0.1)], [0.5, rgba('#fff1c4', 0.14)], [0.75, rgba(INK, 0.3)], [1, rgba(INK, 0.15)]]);
    for (const u of [0.25, 0.75]) stitches(g, [[U(u), V(0.47)], [U(u), V(1)]], S.legs === 'overalls' ? '#e0c890' : INK, 0.5);
    blob(g, U(0.5), V(0.53), r.w * 0.12, 11, 0, lightOf(pants, 0.45), 0.35, 0.2);   // knee
    if (S.legs === 'trousers' && S.boots === 'tall') {
      // a padded leather knee guard over the kneecap (people.js swells the knee under it), strapped
      // round the leg above the knee: its top lit cream, a stitched border and quilting, a rivet, a
      // cool shadow under its lower edge
      const KG = '#7a5232';
      band(g, r, 0.598, 0.62, '#2e1d14', 1);
      bandGrad(g, r, 0.612, 0.62, rgba(lightOf('#2e1d14', 0.7), 0.6), rgba('#2e1d14', 0));
      hstitch(g, r, 0.609, '#c8a070', 0.4);
      bandGrad(g, r, 0.585, 0.598, rgba(INK, 0), rgba(INK, 0.4));
      blob(g, U(0.5), V(0.488), r.w * 0.15, 5, 0, mix(INK, COOL, 0.4), 0.55, 0.3);
      g.save(); g.beginPath(); g.roundRect(U(0.37), V(0.63), r.w * 0.26, V(0.492) - V(0.63), 6); g.clip();
      leather(g, r, U(0.37), V(0.63), r.w * 0.26, V(0.492) - V(0.63), KG, rnd, { creases: 2, scuffs: 4, light: 0.36 });
      gradV(g, U(0.37), V(0.63), r.w * 0.26, V(0.492) - V(0.63), [[0, rgba('#ffe2a8', 0.5)], [0.18, rgba(lightOf(KG, 0.3), 0.2)], [0.55, rgba(KG, 0)], [1, rgba(mix(shadowOf(KG, 0.5), COOL, 0.3), 0.6)]]);
      gradH(g, U(0.37), V(0.63), r.w * 0.26, V(0.492) - V(0.63), [[0, rgba(INK, 0.3)], [0.4, rgba('#ffe8b8', 0.12)], [1, rgba(INK, 0.32)]]);
      for (const v of [0.565, 0.53]) sfold(g, curve(U(0.39), V(v), U(0.61), V(v), -2, 4), 3.2, KG, 0.7, { dark: 0.6, ridge: 1.1 });
      g.restore();
      const kg = [[U(0.385), V(0.618)], [U(0.615), V(0.618)], [U(0.615), V(0.505)], [U(0.385), V(0.505)], [U(0.385), V(0.618)]];
      stitches(g, kg, '#e0c090', 0.55, 2, 2, 1);
      wear(g, along(U(0.38), V(0.627), U(0.62), V(0.627), 5), KG, 1.4, 0.45, rnd);
      rivet(g, U(0.5), V(0.6), 2.2, BRASS);
    } else if (S.legs === 'trousers') {
      g.save(); g.beginPath(); g.roundRect(U(0.4), V(0.6), r.w * 0.2, V(0.49) - V(0.6), 3); g.clip();
      leather(g, r, U(0.4), V(0.6), r.w * 0.2, V(0.49) - V(0.6), '#6e5038', rnd, { creases: 2, scuffs: 4 });
      g.restore();
      stitches(g, [[U(0.4), V(0.6)], [U(0.6), V(0.6)], [U(0.6), V(0.49)], [U(0.4), V(0.49)], [U(0.4), V(0.6)]], INK, 0.55);
      wear(g, along(U(0.41), V(0.595), U(0.59), V(0.595), 5), '#6e5038', 1.4, 0.4, rnd);
    }
    bandGrad(g, r, 0.84, 1.0, rgba(INK, 0), rgba(INK, 0.55));        // in the skirt's shade
    blob(g, U(0.75), V(0.85), r.w * 0.12, 30, 0, INK, 0.3, 0.1);       // inner thigh
    // boots
    const boot = bootColor(S);
    const top = S.boots === 'tall' ? 0.48 : S.boots === 'short' ? 0.3 : S.boots === 'work' ? 0.278 : 0.16;
    if (S.boots === 'work') {   // the trouser legs bunch over the boot tops
      for (let i = 0; i < 8; i++) { const u = (i + rnd() * 0.6) / 8; sfold(g, curve(U(u), V(0.37), U(u + range(rnd, -0.06, 0.06)), V(0.29), range(rnd, -3, 3), 3), 6, pants, 0.95, { dark: 0.6 }); }
      for (let i = 0; i < 3; i++) { const y = V(0.3 + i * 0.025); sfold(g, curve(r.x, y, r.x + r.w, y + range(rnd, -2, 2), 2, 6), 5, pants, 0.8); }
      wear(g, along(r.x, V(0.284), r.x + r.w, V(0.284), 12), pants, 2, 0.4, rnd);
    }
    if (S.boots === 'tall') { paintTallBoot(g, r, boot, rnd); return; }
    clipRect(g, r.x, V(top), r.w, r.y + r.h - V(top), () => {
      leather(g, r, r.x, V(top), r.w, r.y + r.h - V(top), boot, rnd, { creases: 6, scuffs: 10, wrap: true, light: 0.4 });
      for (let i = 0; i < 6; i++) sfold(g, curve(U(0.32 + rnd() * 0.36), V(0.1 + rnd() * 0.05), U(0.32 + rnd() * 0.36), V(0.14 + rnd() * 0.06), 2), 5, boot, 0.85, { dark: 0.6 });   // ankle creases
      blob(g, U(0.5), V(Math.max(0.2, top - 0.12)), r.w * 0.14, 20, 0, lightOf(boot, 0.55), 0.38, 0.2);     // the shin of the boot catches the light
      gradH(g, r.x, V(top), r.w, r.y + r.h - V(top), [[0, rgba(INK, 0.2)], [0.4, rgba('#fff1c4', 0.08)], [0.75, rgba(INK, 0.28)], [1, rgba(INK, 0.2)]]);
    });
    bandGrad(g, r, top, top + 0.03, rgba(INK, 0.0), rgba(INK, 0.45));
    if (S.boots === 'work') { band(g, r, 0.06, 0.09, '#2a1e18', 0.8); for (let k = 0; k < 4; k++) { const y = V(0.13 + k * 0.035); stroke(g, [[U(0.44), y], [U(0.56), y - 3]], 1.4, 1.4, '#b8a080', 0.8); stroke(g, [[U(0.56), y], [U(0.44), y - 3]], 1.4, 1.4, '#b8a080', 0.8); } }
    bandGrad(g, r, 0.0, 0.08, rgba(INK, 0.4), rgba(INK, 0));
  });
}

const bootColor = S => S.outfit === 'repo' ? '#3a2b22' : S.boots === 'shoe' ? '#2d2428' : S.boots === 'tall' ? BOOT : LEATHER_D;
const BOOT = '#4a2b1a', CUFF = '#a06a3c', LACE = '#c9a676';
const COOL = '#3a3656';   // the cool violet the undersides of things go to
const warmLit = (c, k) => mix(shade(c, 1 + k), '#d8985a', k * 0.35);   // a leather highlight: lighter and warmer, not toward grey
// A player's knee boot (people.js LEG_TALL; v = height above the sole): the shaft laced up the
// front over a dark tongue, raised stitched seams down each side and the back, a buckled strap
// round the ankle (the buckle on the outside, u .25); a turned-down cuff of the leather's lighter
// flesh side, its rolled top catching the light, a stitched hem, a rivet on each pointed tab (front,
// outside, back), and a deep cool shadow in the undercut beneath it.
function paintTallBoot(g, r, boot, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  // the shaft
  clipRect(g, r.x, V(0.398), r.w, r.y + r.h - V(0.398), () => {
    leather(g, r, r.x, V(0.398), r.w, r.y + r.h - V(0.398), boot, rnd, { creases: 5, scuffs: 9, wrap: true, light: 0.42, sheen: 0.26 });
    gradV(g, r.x, V(0.39), r.w, V(0.08) - V(0.39), [[0, rgba(lightOf(boot, 0.4), 0.0)], [0.15, rgba(lightOf(boot, 0.35), 0.2)], [0.6, rgba(boot, 0)], [1, rgba(COOL, 0.26)]]);
    // the shin catches the light from the upper left, the back and the inner side fall into shadow
    blob(g, U(0.44), V(0.3), r.w * 0.1, 26, 0, warmLit(boot, 0.6), 0.34, 0.15);
    gradH(g, r.x, V(0.4), r.w, V(0.06) - V(0.4), [[0, rgba(COOL, 0.2)], [0.2, rgba(INK, 0.06)], [0.4, rgba('#ffe0a8', 0.1)], [0.55, rgba('#ffe0a8', 0.06)], [0.78, rgba(COOL, 0.24)], [1, rgba(COOL, 0.2)]]);
    // the tongue under the laces, a shade darker, and the lacing: brass eyelets either side and
    // crossed laces, each crossing lit on top with a dark slot under it
    g.save(); g.fillStyle = shadowOf(boot, 0.35); g.globalAlpha = 0.85; g.beginPath(); g.roundRect(U(0.45), V(0.388), r.w * 0.1, V(0.15) - V(0.388), 3); g.fill(); g.restore();
    for (const u of [0.445, 0.555]) stroke(g, [[U(u), V(0.39)], [U(u), V(0.15)]], 1.6, 1.6, shadowOf(boot, 0.6), 0.55);
    const ys = []; for (let k = 0; k < 7; k++) ys.push(0.165 + k * 0.033);
    for (const y of ys) for (const u of [0.452, 0.548]) rivet(g, U(u), V(y), 1.3, BRASS);
    for (let k = 0; k < ys.length - 1; k++) {
      const y0 = V(ys[k]), y1 = V(ys[k + 1]);
      for (const [a, b] of [[0.452, 0.548], [0.548, 0.452]]) {
        stroke(g, [[U(a) + 0.6, y0 + 1.2], [U(b) + 0.6, y1 + 1.2]], 1.6, 1.6, INK, 0.45);
        stroke(g, [[U(a), y0], [U(b), y1]], 1.5, 1.5, LACE, 0.95);
        stroke(g, [[U(a) - 0.3, y0 - 0.5], [U((a + b) / 2), (y0 + y1) / 2 - 0.5]], 0.8, 0.5, '#f4e2b8', 0.6);
      }
    }
    // the lace ends tied off under the cuff
    stroke(g, [[U(0.5), V(0.375)], [U(0.47), V(0.33)], [U(0.475), V(0.3)]], 1.4, 1, LACE, 0.8);
    // raised stitched seams: the panels' edges either side of the shin and down the back
    for (const u of [0.31, 0.69, 0.0, 1.0]) {
      stroke(g, [[U(u) + 1, V(0.39)], [U(u) + 1, V(0.1)]], 2, 1.6, shadowOf(boot, 0.55), 0.6);
      stroke(g, [[U(u) - 1, V(0.39)], [U(u) - 1, V(0.1)]], 1.4, 1.2, lightOf(boot, 0.45), 0.45);
      stitches(g, [[U(u) - 2.6, V(0.385)], [U(u) - 2.6, V(0.11)]], '#d8b888', 0.5, 2, 2, 1);
    }
    // the heel counter: a stitched panel cupping the back of the ankle
    for (const x0 of [0, 1]) {
      const cx = U(x0);
      g.save(); g.globalAlpha = 0.5; g.fillStyle = shadowOf(boot, 0.25); g.beginPath(); g.ellipse(cx, V(0.09), r.w * 0.14, V(0.09) - V(0.2), 0, 0, TAU); g.fill(); g.restore();
      stitches(g, Array.from({ length: 9 }, (_, i) => { const t = i / 4 - 1; return [cx + t * r.w * 0.13, V(0.09) - (1 - t * t) * (V(0.09) - V(0.19))]; }), '#d8b888', 0.4, 2, 2, 1);
    }
    // ankle creases where the boot bends
    for (let i = 0; i < 6; i++) { const u = 0.3 + rnd() * 0.4; sfold(g, curve(U(u - 0.08), V(0.15 + rnd() * 0.03), U(u + 0.08), V(0.14 + rnd() * 0.03), 2), 4, boot, 0.7, { dark: 0.6 }); }
    // the ankle strap and its buckle on the outside
    band(g, r, 0.185, 0.222, '#2e1d14', 1);
    bandGrad(g, r, 0.21, 0.222, rgba(lightOf('#2e1d14', 0.7), 0.7), rgba('#2e1d14', 0));
    bandGrad(g, r, 0.18, 0.19, rgba(INK, 0), rgba(INK, 0.5));
    hstitch(g, r, 0.2035, '#c8a070', 0.45);
    stroke(g, [[U(0.25) + 4, V(0.2)], [U(0.25) + 11, V(0.198)]], 3.2, 3, '#2e1d14', 1);   // the strap's tongue
    buckle(g, U(0.25), V(0.2035), 7, 8);
    // into the foot: dark and cool
    bandGrad(g, r, 0.06, 0.12, rgba(mix(COOL, INK, 0.5), 0.35), rgba(COOL, 0));
  });
  bandGrad(g, r, 0.484, 0.51, rgba(INK, 0), rgba(INK, 0.5));   // the trousers in the fold above the cuff
  // the undercut beneath the cuff: deep cool shade, a soft violet-brown, never black
  bandGrad(g, r, 0.35, 0.398, rgba(mix(INK, COOL, 0.4), 0), rgba(mix(INK, COOL, 0.4), 0.85));
  // the cuff
  const c0 = V(0.484), c1 = V(0.39);
  clipRect(g, r.x, c0, r.w, c1 - c0, () => {
    leather(g, r, r.x, c0, r.w, c1 - c0, CUFF, rnd, { creases: 3, scuffs: 7, wrap: true, light: 0.3, sheen: 0.2 });
    gradV(g, r.x, c0, r.w, c1 - c0, [[0, rgba('#f6d29a', 0.5)], [0.1, rgba(lightOf(CUFF, 0.4), 0.4)], [0.22, rgba(CUFF, 0)], [0.7, rgba(CUFF, 0)], [0.9, rgba(shadowOf(CUFF, 0.4), 0.5)], [1, rgba(mix(shadowOf(CUFF, 0.6), COOL, 0.3), 0.8)]]);
    gradH(g, r.x, c0, r.w, c1 - c0, [[0, rgba(COOL, 0.18)], [0.2, rgba(INK, 0.04)], [0.4, rgba('#ffe0a8', 0.12)], [0.6, rgba('#ffe0a8', 0.04)], [0.78, rgba(COOL, 0.2)], [1, rgba(COOL, 0.18)]]);
    // the turned leather bunches in soft vertical folds
    for (let i = 0; i < 8; i++) { const u = (i + 0.2 + rnd() * 0.6) / 8; sfold(g, [[U(u), V(0.474)], [U(u + range(rnd, -0.015, 0.015)), V(0.43)]], 5, CUFF, 0.75, { dark: 0.5 }); }
    wear(g, along(r.x, V(0.481), r.x + r.w, V(0.481), 12), CUFF, 1.8, 0.55, rnd);
    hstitch(g, r, 0.413, '#3a2418', 0.55);
    // the hem's dark edge, lit along its lip
    band(g, r, 0.392, 0.401, shadowOf(CUFF, 0.55), 0.85);
    bandGrad(g, r, 0.401, 0.406, rgba(lightOf(CUFF, 0.4), 0.5), rgba(lightOf(CUFF, 0.4), 0));
    for (const u of [0.0, 0.25, 0.5, 1.0]) rivet(g, U(u), V(0.425), 2.4, BRASS);
  });
  bandGrad(g, r, 0.0, 0.07, rgba(INK, 0.4), rgba(INK, 0));
}

// The foot (people.js FOOT / SOLE): u .2-1 the upper (u around its cross-section: .2 under the
// sole, .4 the outside, .6 the top of the foot, .8 the inside; v from the heel to the toe), u 0-.17 the
// sole's edge (its welt at 0, the tread at .17).
function paintFoot(g, r, S, rnd) {
  const boot = bootColor(S), tall = S.boots === 'tall', shoe = S.boots === 'shoe', repo = S.outfit === 'repo';
  const U0 = 0.2, U = u => RX(r, U0 + (1 - U0) * u), V = v => RY(r, v);
  const sole = repo ? '#2a1e18' : shoe ? '#241c1e' : '#33221a', welt = repo ? '#6a5a48' : shoe ? '#5a4a42' : '#7a5636';
  clip(g, r, () => {
    // the sole's edge: a lit welt on top with its stitching, the dark edge, the tread underneath
    gradH(g, r.x, r.y, RX(r, U0) - r.x, r.h, [[0, lightOf(welt, 0.35)], [0.16, welt], [0.26, shadowOf(welt, 0.3)], [0.34, lightOf(sole, 0.25)], [0.62, sole], [0.82, mix(shadowOf(sole, 0.4), COOL, 0.25)], [1, mix(shadowOf(sole, 0.5), COOL, 0.3)]]);
    stitches(g, [[RX(r, 0.04), r.y], [RX(r, 0.04), r.y + r.h]], '#e0c8a0', 0.55, 1.6, 1.6, 0.9);
    if (repo) for (let k = 0; k < 9; k++) band(g, { x: RX(r, 0.09), w: r.w * 0.08, y: r.y, h: r.h }, k / 9, k / 9 + 0.05, INK, 0.45);   // lug soles
    // the heel block's front edge: a dark step under the arch
    g.save(); g.globalAlpha = 0.5; g.fillStyle = INK; g.fillRect(RX(r, 0.05), V(0.29), r.w * 0.12, V(0.23) - V(0.29)); g.restore();
    // the upper
    clipRect(g, RX(r, U0), r.y, r.w * (1 - U0) + 1, r.h, () => {
      const x0 = RX(r, U0), w = r.w * (1 - U0);
      leather(g, null, x0, r.y, w, r.h, boot, rnd, { creases: 5, scuffs: 9, light: 0.3, sheen: 0.24 });
      // lit along the top of the foot, cool down the sides into the sole
      gradH(g, x0, r.y, w, r.h, [[0, rgba(mix(INK, COOL, 0.4), 0.7)], [0.14, rgba(COOL, 0.2)], [0.3, rgba(INK, 0)], [0.5, rgba('#e8a868', 0.12)], [0.7, rgba(INK, 0.04)], [0.86, rgba(COOL, 0.24)], [1, rgba(mix(INK, COOL, 0.4), 0.7)]]);
      // the toe cap: a stitched panel over the toe box, its top lit, scuffed pale
      const capV = shoe ? 0.78 : 0.72;
      g.save(); g.beginPath(); g.moveTo(U(0.12), V(1)); g.lineTo(U(0.12), V(capV + 0.06)); g.quadraticCurveTo(U(0.5), V(capV - 0.08), U(0.88), V(capV + 0.06)); g.lineTo(U(0.88), V(1)); g.closePath(); g.clip();
      gradV(g, x0, V(1), w, V(capV - 0.05) - V(1), [[0, rgba(warmLit(boot, 0.4), 0.36)], [1, rgba(warmLit(boot, 0.2), 0.18)]]);
      g.restore();
      const capLine = [[U(0.12), V(capV + 0.06)], [U(0.3), V(capV - 0.01)], [U(0.5), V(capV - 0.035)], [U(0.7), V(capV - 0.01)], [U(0.88), V(capV + 0.06)]];
      stroke(g, capLine.map(([x, y]) => [x + 0.6, y + 1.2]), 1.6, 1.6, shadowOf(boot, 0.6), 0.7);
      stroke(g, capLine, 1.2, 1.2, lightOf(boot, 0.45), 0.5);
      if (!shoe) stitches(g, capLine.map(([x, y]) => [x, y - 2.4]), '#d8b888', 0.5, 1.8, 1.8, 0.9);
      blob(g, U(0.47), V(0.86), w * 0.2, r.h * 0.07, 0, repo ? '#9a9aa2' : warmLit(boot, 0.8), repo ? 0.55 : 0.42, 0.2);   // the toe catches the light (the Repo Man's steel toe)
      for (let i = 0; i < 6; i++) blob(g, U(0.38 + rnd() * 0.24), V(0.84 + rnd() * 0.12), range(rnd, 1.6, 3.2), range(rnd, 1.2, 2.4), rnd() * 3, '#b4824c', 0.32, 0.3);
      if (shoe) blob(g, U(0.44), V(0.82), w * 0.08, r.h * 0.05, 0, '#fff0d0', 0.45, 0.3);   // polished
      // creases across the instep where it bends, lit ridges
      for (let i = 0; i < 3; i++) { const y = V(0.48 + i * 0.05); sfold(g, curve(U(0.3), y, U(0.7), y - 2, 3, 4), 6, boot, 0.8, { dark: 0.6, ridge: 1.2 }); }
      // the heel counter: a darker stitched panel round the back
      g.save(); g.globalAlpha = 0.5; g.fillStyle = shadowOf(boot, 0.3); g.fillRect(x0, V(0.24), w, V(0) - V(0.24)); g.restore();
      stitches(g, [[x0, V(0.24)], [x0 + w, V(0.24)]], '#d8b888', 0.45, 1.8, 1.8, 0.9);
      bandGrad(g, r, 0.24, 0.27, rgba(INK, 0.35), rgba(INK, 0));
      if (tall) {
        // a buckled strap over the instep, the buckle toward the outside
        g.save(); g.fillStyle = '#2e1d14'; g.fillRect(x0, V(0.42), w, V(0.35) - V(0.42)); g.restore();
        stitches(g, [[x0, V(0.385)], [x0 + w, V(0.385)]], '#c8a070', 0.4, 1.6, 1.6, 0.8);
        bandGrad(g, r, 0.41, 0.42, rgba(lightOf('#2e1d14', 0.7), 0.6), rgba('#2e1d14', 0));
        bandGrad(g, r, 0.335, 0.35, rgba(INK, 0), rgba(INK, 0.45));
        buckle(g, U(0.4), V(0.385), 6, 6);
      } else if (!shoe) {
        // laces up the instep
        for (let k = 0; k < 3; k++) { const y = V(0.36 + k * 0.07); stroke(g, [[U(0.43), y], [U(0.57), y - 4]], 1.3, 1.3, '#b8a080', 0.8); stroke(g, [[U(0.57), y], [U(0.43), y - 4]], 1.3, 1.3, '#b8a080', 0.8); }
      }
      // where the upper meets the sole: a dark seam, then the welt's lit lip
      for (const e of [0, 1]) { const ex = e ? x0 + w : x0; gradH(g, e ? ex - 5 : ex, r.y, 5, r.h, e ? [[0, rgba(INK, 0)], [1, rgba(INK, 0.6)]] : [[0, rgba(INK, 0.6)], [1, rgba(INK, 0)]]); }
    });
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
    if (!back && S.outfit === 'player') sigil(g, S.emblem, U(0.5), V(0.6), r.w * 0.23);
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
    if (S.shoulders === 'lames') {
      // one curved plate of boiled leather (all three lames sample it): a darker top where the plate
      // above overlaps it, a thick rolled lower edge, lit, a row of rivets just above the edge, a
      // stitched dye-colored binding along the top
      bandGrad(g, r, 0.8, 1.0, rgba(INK, 0), rgba(INK, 0.55));
      band(g, r, 0.9, 0.96, shadowOf(S.color, 0.1), 0.95); hstitch(g, r, 0.93, '#d8bc8a', 0.5);
      gradV(g, r.x, V(0.47), r.w, V(0.32) - V(0.47), [[0, lightOf(base, 0.75)], [0.45, lightOf(base, 0.3)], [1, shadowOf(base, 0.55)]]);
      for (let k = 0; k < 12; k++) rivet(g, U((k + 0.5) / 12), V(0.52), 2, BRASS);
      wear(g, along(r.x, V(0.45), r.x + r.w, V(0.45), 14), base, 1.8, 0.45, rnd);
    } else
    // overlapping plates: each plate's lower edge is lit, the next one up casts a shadow on it
    for (const v of [0.56, 0.78]) {
      bandGrad(g, r, v - 0.07, v, rgba(INK, 0), rgba(INK, 0.5));
      band(g, r, v, v + 0.025, lightOf(base, 0.7), 0.6);
      for (let k = 0; k < 10; k++) rivet(g, U((k + (v > 0.6 ? 0.5 : 0)) / 10 + 0.025), V(v + 0.05), 1.7, metal ? '#d8d2c0' : '#b8bcc4');
    }
    // a seam down the middle of each plate
    if (S.shoulders !== 'lames') for (let k = 0; k < 4; k++) { const u = (k + 0.5) / 4; sfold(g, [[U(u), V(0.97)], [U(u), V(0.4)]], 4, base, 0.55, { ridge: 1.3 }); }
    bandGrad(g, r, 0.78, 1.0, rgba('#fff0c8', 0.0), rgba('#fff0c8', 0.4));    // the cap of the dome catches the sun
    // the rolled rim: iron (or brass on steel), riveted
    if (S.shoulders !== 'lames') {
      gradV(g, r.x, V(0.43), r.w, V(0.32) - V(0.43), [[0, lightOf(rimC, metal ? 0.5 : 0.7)], [0.4, rimC], [1, shadowOf(rimC, 0.6)]]);
      for (let k = 0; k < 9; k++) rivet(g, U((k + 0.5) / 9), V(0.375), 2.4, metal ? '#e0c890' : '#c8ccd4');
      bandGrad(g, r, 0.43, 0.48, rgba(INK, 0.45), rgba(INK, 0));
    }
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
    hairFlow(g, hc, rnd, { x0: r.x, x1: r.x + r.w, count: 11, width: [9, 18], wrapW: r.w, ys: () => r.y + r.h + 3, ye: () => r.y - 6, lean: x => -Math.sin(thOfU((x - r.x) / r.w)) * 0.32, sheen: 0.3 });
    bandGrad(g, r, 0.0, 0.08, rgba(INK, 0.3), rgba(INK, 0));
  });
}
// Beards, manes, braids and buns: long clumps hanging down (v 1 = the roots, at the top).
function paintBeardRegion(g, r, S, rnd) {
  const hc = S.look.hairColor;
  clip(g, r, () => {
    locks(g, r, r.x, r.y, r.w, r.h, hc, rnd, { count: 6, len: [0.55, 1.0], width: [8, 16], sheen: 0.3, wrap: true });
    bandGrad(g, r, 0.88, 1.0, rgba(mix(shadowOf(hc, 0.5), INK, 0.2), 0), rgba(mix(shadowOf(hc, 0.5), INK, 0.2), 0.6));   // dark roots against the skin
    if (S.look.hair === 'braid' || S.look.hair === 'bun') for (let k = 0; k < 9; k++) {   // braid lobes
      const y = r.y + (k + 0.5) / 9 * r.h;
      sfold(g, curve(r.x, y - 4, r.x + r.w, y + 4, 0, 4), 5, hc, 0.8);
    }
  });
}
// The ear (u around it: its outer face at u .25 / .75, v up): a warm cupped bowl in shadow
// inside a lit rim, a touch of red.
function paintEar(g, r, S) {
  const T = toneOf(S.tone), U = u => RX(r, u), V = v => RY(r, v);
  clip(g, r, () => {
    gradV(g, r.x, r.y, r.w, r.h, [[0, T.light], [0.5, mix(T.base, T.blush, 0.4)], [1, T.shadow]]);
    for (const u of [0.25, 0.75]) {
      blob(g, U(u), V(0.5), r.w * 0.17, r.h * 0.36, 0, T.light, 0.7, 0.5);         // the rim of the helix
      blob(g, U(u + 0.02), V(0.47), r.w * 0.11, r.h * 0.26, 0, '#7a4438', 0.75, 0.35);   // the bowl
      blob(g, U(u + 0.035), V(0.42), r.w * 0.04, r.h * 0.1, 0, '#5a2e28', 0.6, 0.3);
      blob(g, U(u - 0.07), V(0.78), r.w * 0.08, r.h * 0.12, 0, T.hi, 0.5, 0.3);
    }
    blob(g, U(0.5), V(0.55), r.w * 0.5, r.h * 0.5, 0, S.look.female ? '#d0705a' : '#c8664c', 0.25, 0.2);
    bandGrad(g, r, 0.0, 0.2, rgba(T.deep, 0.45), rgba(T.deep, 0));
  });
}
// Fur (the mantle's collar, in the horn region, which only the horned helm uses): big soft clumps
// of brown fur with lit tips, darker at the roots.
function paintFur(g, r, rnd) {
  clip(g, r, () => {
    gradV(g, r.x, r.y, r.w, r.h, [[0, '#9a7a56'], [0.5, '#7e6044'], [1, '#5e4630']]);
    for (let i = 0; i < 9; i++) blob(g, r.x + rnd() * r.w, r.y + rnd() * r.h, range(rnd, 8, 16), range(rnd, 6, 12), 0, pick(rnd, ['#5a4230', '#a4865e']), 0.35, 0.2);
    for (let i = 0; i < 90; i++) {
      const x = r.x + rnd() * r.w, y = r.y + rnd() * r.h, L = range(rnd, 6, 12), a = range(rnd, -0.5, 0.5) + Math.PI / 2;
      const P = [[x, y], [x + Math.cos(a) * L * 0.5 + range(rnd, -2, 2), y + Math.sin(a) * L * 0.5], [x + Math.cos(a) * L, y + Math.sin(a) * L]];
      stroke(g, P.map(([px, py]) => [px + 1.5, py + 1]), 5, 0.8, '#4a3624', 0.6);
      stroke(g, P, 5, 0.8, pick(rnd, ['#8a6a4a', '#9a7856', '#7a5c40']), 1);
      stroke(g, P.slice(1), 2.4, 0.5, '#d4b386', 0.8);
    }
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
    // the chain links (v .03-.57: u runs round a link's long loop, v round its wire): forged iron,
    // lighter on the outside of the loop, a dark gap at both ends where the links hook through each
    // other, a little rust. No pure black or white.
    const y0 = V(0.57), y1 = V(0.03), U = u => RX(r, u);
    gradV(g, r.x, y0, r.w, y1 - y0, [[0, '#7c7f86'], [0.25, '#5d5f63'], [0.5, '#45464c'], [0.75, '#5d5f63'], [1, '#7c7f86']]);
    for (const u of [0.25, 0.75]) blob(g, U(u), V(0.3), r.w * 0.16, (y1 - y0) * 0.22, 0, '#a7abb0', 0.55, 0.3);
    for (const u of [0, 0.5, 1]) blob(g, U(u), V(0.3), r.w * 0.1, (y1 - y0) * 0.6, 0, '#2b2a2e', 0.6, 0.3);
    for (let i = 0; i < 7; i++) blob(g, U(rnd()), y0 + rnd() * (y1 - y0), range(rnd, 2, 4), range(rnd, 2, 3), 0, '#8a4a2a', 0.35, 0.3);
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
// The Dealer's cards (in the pack region, which only players use). people.js maps a card's face onto
// u .02-.46 and its back onto u .54-.98 (v .06-.94 for both), so the texture is squeezed ~2.9x across
// against the card: shapes are drawn in card space (1 wide, 1.43 tall) through cardSpace() so they
// come out the right shape on the card; lines are drawn in pixels, at least 1.5 px either way. The
// face: an ace of hearts on cream. The back, which the room sees across the table: a white margin,
// a thin red rule, and a cream panel under a red diamond lattice with a brass-and-red medallion, so
// the fan reads as light playing cards in his dark fist even across the room.
const CARD_U = [[0.02, 0.46], [0.54, 0.98]], CARD_V = [0.06, 0.94], CARD_H = 1 / 0.7;
function cardSpace(g, r, side, fn) {
  const [u0, u1] = CARD_U[side], x0 = RX(r, u0), x1 = RX(r, u1), y0 = RY(r, CARD_V[1]), y1 = RY(r, CARD_V[0]);
  g.save(); g.translate(x0, y0); g.scale(x1 - x0, (y1 - y0) / CARD_H); fn(); g.restore();
  return { x0, x1, y0, y1 };
}
function paintCards(g, r, rnd) {
  const heart = (x, y, k, col) => { g.save(); g.translate(x, y); g.scale(k, k); g.beginPath(); g.moveTo(0, 0.42); g.bezierCurveTo(-0.62, -0.05, -0.36, -0.62, 0, -0.2); g.bezierCurveTo(0.36, -0.62, 0.62, -0.05, 0, 0.42); g.fillStyle = col; g.fill(); g.restore(); };
  const diamond = (x, y, w, h, col) => { g.beginPath(); g.moveTo(x, y - h); g.lineTo(x + w, y); g.lineTo(x, y + h); g.lineTo(x - w, y); g.closePath(); g.fillStyle = col; g.fill(); };
  // a pixel-space frame (inset in card units) at least 1.5 px thick either way
  const frame = (b, inset, px, col, a = 1) => {
    const sx = b.x1 - b.x0, sy = (b.y1 - b.y0) / CARD_H, ix = b.x0 + inset * sx, iy = b.y0 + inset * sy, w = sx - 2 * inset * sx, h = (b.y1 - b.y0) - 2 * inset * sy;
    g.save(); g.globalAlpha = a; g.fillStyle = col;
    g.fillRect(ix, iy, w, px); g.fillRect(ix, iy + h - px, w, px); g.fillRect(ix, iy, px, h); g.fillRect(ix + w - px, iy, px, h);
    g.restore();
  };
  clip(g, r, () => {
    fill0(g, r, '#f2ead8');     // (bleed round both cards: the rims and the mip filter sample it as a white card edge)
    // the face: an ace of hearts on cream, lit from the top
    const F = cardSpace(g, r, 0, () => {
      const gr = g.createLinearGradient(0, 0, 0, CARD_H); gr.addColorStop(0, '#fbf5e6'); gr.addColorStop(1, '#e4d8bc');
      g.fillStyle = gr; g.fillRect(-0.05, -0.05, 1.1, CARD_H + 0.1);
      heart(0.5, CARD_H / 2, 0.42, '#7a1c20'); heart(0.5, CARD_H / 2 - 0.012, 0.4, '#b8302c');
      g.save(); g.globalAlpha = 0.45; heart(0.44, CARD_H / 2 - 0.06, 0.12, '#f4b8a0'); g.restore();
      heart(0.16, 0.34, 0.13, '#b8302c'); heart(0.84, CARD_H - 0.34, 0.13, '#b8302c');
      g.save(); g.fillStyle = '#b02a2a'; g.font = 'bold 0.2px serif'; g.textAlign = 'center'; g.fillText('A', 0.16, 0.22); g.restore();
    });
    frame(F, 0.05, 1.5, '#b8a888', 0.8);
    // the back: white margin, red rule, a cream panel under a red diamond lattice, a medallion
    const Bk = cardSpace(g, r, 1, () => {
      const m = 0.085, pw = 1 - 2 * m, ph = CARD_H - 2 * m;
      g.fillStyle = '#f6f0e0'; g.fillRect(-0.05, -0.05, 1.1, CARD_H + 0.1);
      g.save(); g.beginPath(); g.rect(m, m, pw, ph); g.clip();
      const gr = g.createLinearGradient(0, 0, 0, CARD_H); gr.addColorStop(0, '#f0e2c2'); gr.addColorStop(1, '#dcc8a0'); g.fillStyle = gr; g.fillRect(m, m, pw, ph);
      // the lattice: a harlequin of tall diamonds, red rows and cream rows (a row's diamonds touch
      // the next row's along their edges), a cream pip in each red one and a red pip in each cream one
      const cw = 0.21, ch = 0.25;
      for (let iy = -1; iy * ch / 2 < CARD_H + ch; iy++) for (let ix = -1; ix * cw < 1 + cw; ix++) {
        const x = ix * cw + (iy & 1 ? cw / 2 : 0), y = iy * ch / 2;
        if (iy & 1) { diamond(x, y, cw * 0.44, ch * 0.44, '#a82c2a'); diamond(x, y, cw * 0.13, ch * 0.13, '#f0dcb4'); }
        else diamond(x, y, cw * 0.12, ch * 0.12, '#b8402e');
      }
      // the medallion: a brass oval ringed in dark red, a red heart on it
      g.beginPath(); g.ellipse(0.5, CARD_H / 2, 0.24, 0.26, 0, 0, Math.PI * 2); g.fillStyle = '#7a1c20'; g.fill();
      g.beginPath(); g.ellipse(0.5, CARD_H / 2, 0.2, 0.22, 0, 0, Math.PI * 2); g.fillStyle = '#d8b060'; g.fill();
      g.beginPath(); g.ellipse(0.47, CARD_H / 2 - 0.06, 0.1, 0.08, -0.4, 0, Math.PI * 2); g.fillStyle = 'rgba(255,240,196,0.55)'; g.fill();
      heart(0.5, CARD_H / 2 + 0.01, 0.2, '#a82c2a');
      g.restore();
    });
    frame(Bk, 0.07, 1.5, '#7a1c20', 0.95);     // the red rule round the panel
    frame(Bk, 0.0, 1, '#a89878', 0.7);          // and a faint warm edge, so the fanned cards part from each other
    frame(F, 0.0, 1, '#a89878', 0.7);
  });
}
function paintPack(g, r, S, rnd) {
  const U = u => RX(r, u), V = v => RY(r, v);
  if (S.outfit === 'dealer') return paintCards(g, r, rnd);
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
      // Ed's shop apron (u across, v from the hem up to the bib): one piece of dark oiled leather,
      // two big soft folds hanging from the waist ties (matching the modeled ones), grease and old
      // stains, a stitched turned edge all round, a pocket with a pencil
      const ap = '#6c4a2e';
      leather(g, r, r.x, r.y, r.w, r.h, ap, rnd, { creases: 6, scuffs: 10, light: 0.28, sheen: 0.18 });
      const vt = (1.0 - APRON_Y0) / (APRON_Y1 - APRON_Y0);                                    // the waist
      for (const [u, w] of [[0.31, 22], [0.7, 18]]) {
        sfold(g, curve(U(u + 0.02), V(vt - 0.04), U(u - 0.01), V(0.02), 4, 6), w, ap, 0.55, { ridge: 0.6, dark: 0.5 });
        blob(g, U(u - 0.05), V(0.3), r.w * 0.04, r.h * 0.22, 0, lightOf(ap, 0.4), 0.3, 0.2);       // its lit ridge
      }
      for (let i = 0, u = 0.12; i < 3; i++, u += range(rnd, 0.18, 0.34)) sfold(g, curve(U(u), V(vt - 0.1), U(u + range(rnd, -0.03, 0.03)), V(0.12), range(rnd, -4, 4), 5), range(rnd, 8, 12), ap, 0.35);
      for (let i = 0; i < 4; i++) { const y = V(vt + rnd() * 0.06); sfold(g, curve(U(0.15 + rnd() * 0.25), y, U(0.55 + rnd() * 0.3), y + range(rnd, -3, 3), 3, 5), 6, ap, 0.45); }   // creased where the belly folds it
      blob(g, U(0.5), V(vt - 0.08), r.w * 0.3, r.h * 0.12, 0, lightOf(ap, 0.35), 0.28, 0.1);          // the belly pushes it into the light
      for (let i = 0; i < 7; i++) blob(g, U(0.12 + rnd() * 0.76), V(0.08 + rnd() * 0.84), range(rnd, 7, 16), range(rnd, 5, 11), rnd() * 3, '#4a3626', 0.3, 0.25);   // grease
      for (let i = 0; i < 5; i++) blob(g, U(0.15 + rnd() * 0.7), V(0.1 + rnd() * 0.5), range(rnd, 3, 6), range(rnd, 2, 4), rnd() * 3, '#3e2a1e', 0.4, 0.4);
      // the bib's pocket with a pencil
      const pk = [U(0.38), V(0.86), r.w * 0.24, V(0.74) - V(0.86)];
      g.save(); g.fillStyle = shade(ap, 0.88); g.fillRect(...pk); g.restore();
      bandGrad(g, r, 0.72, 0.74, rgba(INK, 0.4), rgba(INK, 0));
      stitches(g, [[U(0.38), V(0.86)], [U(0.38), V(0.74)], [U(0.62), V(0.74)], [U(0.62), V(0.86)]], '#d8bc8a', 0.6);
      wear(g, along(U(0.38), V(0.86), U(0.62), V(0.86), 4), ap, 1.6, 0.5, rnd);
      stroke(g, [[U(0.55), V(0.91)], [U(0.58), V(0.8)]], 3, 3, '#c8a040', 1);
      blob(g, U(0.55), V(0.915), 2, 2, 0, '#e8a0a0', 1, 0.6);
      // the darker turned edge all round, stitched, worn pale
      for (const [x0, y0, x1, y1] of [[U(0.015), V(0), U(0.015), V(1)], [U(0.985), V(0), U(0.985), V(1)], [U(0), V(0.02), U(1), V(0.02)], [U(0), V(0.985), U(1), V(0.985)]]) stroke(g, [[x0, y0], [x1, y1]], 6, 6, shadowOf(ap, 0.35), 0.9);
      for (const u of [0.04, 0.96]) stitches(g, [[U(u), V(0)], [U(u), V(1)]], '#d8bc8a', 0.55);
      stitches(g, [[U(0), V(0.05)], [U(1), V(0.05)]], '#d8bc8a', 0.55); stitches(g, [[U(0), V(0.955)], [U(1), V(0.955)]], '#d8bc8a', 0.5);
      wear(g, along(U(0), V(0.01), U(1), V(0.01), 10), ap, 2, 0.4, rnd);
      bandGrad(g, r, vt - 0.02, vt + 0.03, rgba(INK, 0), rgba(INK, 0.3));                   // the waist tie's shadow
      // the neck straps sample the left edge strip (u 0-.035)
      clipRect(g, r.x, r.y, r.w * 0.04, r.h, () => { leather(g, null, r.x, r.y, r.w * 0.04, r.h, shadowOf(ap, 0.1), rnd, { creases: 2, scuffs: 2, light: 0.2 }); stitches(g, [[U(0.008), V(0)], [U(0.008), V(1)]], '#d8bc8a', 0.5); });
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
      // the crown's teardrop crease (front u .5 and back u 0/1 at the top) and the two front pinches
      for (const u of [0.5, 0, 1]) sfold(g, [[U(u), V(1.0)], [U(u + 0.003), V(0.84)]], 12, '#6e4c30', 0.9, { dark: 0.6 });
      for (const u of [0.403, 0.597]) { sfold(g, [[U(u), V(0.95)], [U(u), V(0.76)]], 10, '#6e4c30', 0.8, { dark: 0.6 }); blob(g, U(u) - 4, V(0.86), 4, 9, 0, lightOf('#6e4c30', 0.4), 0.35, 0.3); }
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
      // the brim's frayed outer edge (brim v 1 = acc v .45): broken straw ends, a few strands poking out
      bandGrad(g, r, 0.36, 0.46, rgba('#6a4a22', 0), rgba('#6a4a22', 0.45));
      for (let i = 0; i < 46; i++) { const x = U(rnd()), y = V(range(rnd, 0.37, 0.43)); stroke(g, [[x, y], [x + range(rnd, -4, 4), V(0.455)]], range(rnd, 1.4, 2.6), 0.6, pick(rnd, ['#f0d890', '#e2c070', '#a07a3a']), 0.85); }
      bandGrad(g, r, 0, 0.12, rgba(INK, 0.35), rgba(INK, 0));
    } else if (h === 'hood') {
      // wool in a deep shade of your dye; the bright dye only on the rolled lip round the face
      const wool = mix(shadowOf(c, 0.35), '#4a3c34', 0.25);
      clipRect(g, crown.x, crown.y, crown.w, crown.h, () => {
        cloth(g, r, crown.x, crown.y, crown.w, crown.h, wool, rnd, { folds: 0, light: 0.36, wrap: true });
        for (let i = 0; i < 10; i++) { const u = (i + rnd() * 0.5) / 10; sfold(g, curve(U(u), V(1.0), U(u + range(rnd, -0.03, 0.03)), V(0.52), range(rnd, -5, 5), 5), range(rnd, 8, 11), wool, 0.9); }
        bandGrad(g, r, 0.88, 1.0, rgba('#fff0c8', 0), rgba('#fff0c8', 0.18));
      });
      // the lining, in the hood's shade but never black
      clipRect(g, r.x, V(0.4), r.w, V(0.04) - V(0.4), () => {
        cloth(g, r, r.x, V(0.4), r.w, V(0.04) - V(0.4), mix(shadowOf(wool, 0.4), '#2e2228', 0.3), rnd, { folds: 5, light: 0.12, wrap: true });
        // the inside of the face opening (the lining's ends, u 0 / 1) in deep shade, so the face pops
        gradH(g, r.x, V(0.4), r.w, V(0.04) - V(0.4), [[0, rgba('#2e2228', 0.6)], [0.06, rgba('#2e2228', 0)], [0.94, rgba('#2e2228', 0)], [1, rgba('#2e2228', 0.6)]]);
      });
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
        rivet(g, U(0.5), V(0.72), 4.5, BRASS);   // a brass badge on the front
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
      // the side seams where the bib turns round his ribs, and the lit lip of the pocket
      for (const u of [0.16, 0.84]) { sfold(g, [[U(u), V(0.95)], [U(u + (u < 0.5 ? 0.02 : -0.02)), V(0.05)]], 7, ov, 0.7); stitches(g, [[U(u + 0.012), V(0.92)], [U(u + 0.012), V(0.06)]], '#e0c890', 0.45); }
      band(g, r, 0.765, 0.785, lightOf(ov, 0.35), 0.7);
      gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.35)], [0.14, rgba(INK, 0)], [0.86, rgba(INK, 0)], [1, rgba(INK, 0.35)]]);
      wear(g, along(U(0.02), V(0.99), U(0.98), V(0.99), 12), ov, 2.4, 0.45, rnd);
      bandGrad(g, r, 0.0, 0.12, rgba(INK, 0.3), rgba(INK, 0));
      return;
    }
    if (S.mantle) {
      // a leather mantle (u around, v from the hem up to the fur collar): dark oiled leather
      // panels, folds from the neck, a dyed and gold-trimmed hem, rivets along the panel seams
      leather(g, r, r.x, r.y, r.w, r.h, '#5e3e26', rnd, { creases: 8, scuffs: 12, light: 0.36, wrap: true });
      for (let i = 0; i < 12; i++) { const u = (i + rnd() * 0.5) / 12; sfold(g, curve(U(u), V(1.0), U(u + range(rnd, -0.02, 0.02)), V(0.16), range(rnd, -2, 2), 4), range(rnd, 7, 10), '#5e3e26', 0.8); }
      for (let k = 0; k < 8; k++) { const u = (k + 0.5) / 8; stitches(g, [[U(u), V(0.96)], [U(u), V(0.2)]], '#d8bc8a', 0.4); rivet(g, U(u), V(0.24), 1.8, BRASS); }
      band(g, r, 0.0, 0.13, c, 1);
      bandGrad(g, r, 0.0, 0.13, rgba(INK, 0.35), rgba('#fff0c8', 0.25));
      trimH(g, r.x, r.x + r.w, V(0.15), 2.4);
      wear(g, along(r.x, V(0.02), r.x + r.w, V(0.02), 20), c, 1.6, 0.35, rnd);
      bandGrad(g, r, 0.82, 1.0, rgba(INK, 0), rgba(INK, 0.45));          // under the fur collar
      return;
    }
    // the capelet (u around, v from the scalloped hem up to the neck): the hood's wool,
    // folds radiating from the neck, a hem band in your color with a gold trim
    const wool = mix(shadowOf(c, 0.35), '#4a3c34', 0.25);
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
  if (S.mantle && S.hat !== 'helm') paintFur(g, REG.horn, rnd); else paintHorn(g, REG.horn, rnd);
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
    for (const u of [0.42, 0.5, 0.58]) { stroke(g, curve(RX(r, u - 0.03), RY(r, 0.74), RX(r, u + 0.03), RY(r, 0.74), 2, 3), 2.4, 1.4, '#4a2e20', 0.6); blob(g, RX(r, u), RY(r, 0.92), 4, 3, 0, '#b08a64', 0.4, 0.3); }
    for (const u of [0.42, 0.5, 0.58]) stroke(g, [[RX(r, u), RY(r, 0.97)], [RX(r, u), RY(r, 0.72)]], 2.4, 1.6, shadowOf(GL, 0.6), 0.6);    // the splits toward the fingers
    blob(g, RX(r, 0.45), RY(r, 0.55), r.w * 0.12, r.h * 0.2, 0, lightOf(GL, 0.5), 0.35, 0.15);
    // the palm (u 0 / 1): a darker padded patch in shade
    for (const u of [0.0, 1.0]) { blob(g, RX(r, u), RY(r, 0.5), r.w * 0.22, r.h * 0.4, 0, INK, 0.45, 0.1); stitches(g, [[RX(r, u) - 20, RY(r, 0.25)], [RX(r, u) + 20, RY(r, 0.25)]], '#c8a878', 0.4); }
    bandGrad(g, r, 0, 0.1, rgba(INK, 0.45), rgba(INK, 0));
  });
  // fingers and thumb: tubes with the back of the finger at u .5, its sides (toward the next
  // finger) at u .25 / .75 in a dark seam, the underside at u 0 / 1; v from the knuckle (0) to the
  // tip (1), bending at v ~.42 and ~.72
  for (const k of ['finger', 'thumb']) clip(g, FP[k], () => {
    const r = FP[k], X = u => RX(r, u), Y = v => RY(r, v);
    leather(g, r, r.x, r.y, r.w, r.h, GL, rnd, { creases: 3, scuffs: 6, light: 0.45, wrap: true });
    blob(g, X(0.5), Y(0.5), r.w * 0.16, r.h * 0.5, 0, lightOf(GL, 0.4), 0.38, 0.2);                       // the back of the finger in the light
    for (const v of (k === 'finger' ? [0.42, 0.72] : [0.55])) {
      // a knuckle: a lit ridge over the joint, dark creases in the leather either side of it, worn pale
      blob(g, X(0.5), Y(v), r.w * 0.11, r.h * 0.07, 0, lightOf(GL, 0.65), 0.6, 0.3);
      for (const dv of [-0.075, 0.075]) {
        stroke(g, curve(X(0.33), Y(v + dv), X(0.67), Y(v + dv), dv > 0 ? -2 : 2, 4), 2.6, 1.6, '#4a2e20', 0.75);
        stroke(g, curve(X(0.35), Y(v + dv) - 1.6, X(0.65), Y(v + dv) - 1.6, dv > 0 ? -2 : 2, 4), 1.4, 0.8, lightOf(GL, 0.55), 0.5);
      }
      blob(g, X(0.48), Y(v), r.w * 0.06, r.h * 0.045, 0, '#b08a64', 0.4, 0.3);
    }
    blob(g, X(0.5), Y(0.96), r.w * 0.12, r.h * 0.06, 0, '#b08a64', 0.4, 0.3);                            // the worn fingertip
    blob(g, X(0.5), Y(0.06), r.w * 0.16, r.h * 0.08, 0, INK, 0.3, 0.2);                                  // in the knuckle's shadow
    gradH(g, r.x, r.y, r.w, r.h, [[0, rgba(INK, 0.55)], [0.17, rgba(INK, 0.45)], [0.3, rgba(INK, 0)], [0.7, rgba(INK, 0)], [0.83, rgba(INK, 0.45)], [1, rgba(INK, 0.55)]]);
    for (const u of [0.24, 0.76]) { stroke(g, [[X(u), r.y], [X(u), r.y + r.h]], 2.2, 2.2, shadowOf(GL, 0.7), 0.65); stitches(g, [[X(u + (u < 0.5 ? 0.05 : -0.05)), r.y], [X(u + (u < 0.5 ? 0.05 : -0.05)), r.y + r.h]], '#d8bc8a', 0.4, 2, 2); }   // the finger seams
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
