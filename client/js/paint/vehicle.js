// Texture family: vehicle. The Slopmaster 9000 (rv3d.js), painted the way Blizzard's 2004 artists
// painted a model: one unique atlas for the body, a trim sheet for every beam, bolt and lamp,
// and a few tiling interior surfaces. Light from the upper left: lit cream edges on top, cool
// violet-brown shadows below, soft dark seams, never pure black. See docs/ART.md.
//
//   rv_body     1024², the body atlas: right side, left side, front and rear, each painted for its
//               own panel (windows, door, wheel arches, the name, the hatches and the advert line up
//               with RV_ART).
//   rv_tin      512², the roof's tin (tiles ~1.5 m): plates, tar-sealed laps, rivets, rust, leaves.
//   rv_trim     512×2048 trim sheet: 64 px horizontal bands that tile along u (walnut, oak, brass,
//               iron, goblin red and green, cream, tread, strap, gingham, slate, canvas, glass, rope,
//               awning, burlap, carpet, copper, the roof-edge livery, hay, bone, leaf, sand, soot,
//               leather, butcher block, pennant cloth, corner post) plus rows of decal slots (hub,
//               gauges, plates, skull, fan grille...) and the brow's destination board.
//   rv_paneling 1024×512, interior walls: cream plaster between dark studs over a walnut wainscot
//               (tiles along u only; v runs floor → ceiling).
//   rv_floor    512², dark umber plank floor with a worn path down the aisle (tiles along u).
//   rv_ceiling  512², ceiling boards between the beams (tiles along u).
//   rv_soft     512², soft goods atlas: patchwork quilt, tufted plaid, a woven runner, the goblin
//               copper wash stall.
//   rv_lamps    512×256, lenses (headlight, tail, amber marker, lantern glass) and the night glows
//               (lit window, porthole, halo): the glow mesh draws this atlas additively.
//   rv_glass    512×256, window glass (alpha): the outside face (left half), the inside (right).
//   rv_snow     256², snow lying on the RV on day 3 (tiles).
//   rv_grime    1024×256, road grime (alpha, painted white: tinted per biome), sides and ends.
import {
  register, fill, mottle, glaze, blob, range, pick, wrap, ellipse, stroke,
  mix, lightOf, shadowOf, jitter, rgba, makeCanvas, rowLayout, blurTile,
} from './core.js';

const F = 'vehicle';
const TAU = Math.PI * 2;
const INK = '#2a2030';
const SERIF = `Georgia, 'Palatino Linotype', 'Book Antiqua', 'Liberation Serif', 'DejaVu Serif', serif`;
// The sign-painter's capitals (Cinzel ships with the client, see css/style.css; rv3d.js repaints the
// body once it has loaded). The fallbacks are heavy serifs.
export const LETTER_FONT = `'Cinzel', 'Trajan Pro', 'Liberation Serif', 'DejaVu Serif', Georgia, serif`;
const STENCIL_FONT = `'DejaVu Sans', 'Liberation Sans', Verdana, sans-serif`;

// ---- the layout the painter and the model share (local RV frame of shared/rv.js) ---------------
export const RV_ART = {
  y0: -0.6, y1: 2.4,                      // the side atlas spans this height
  eaveY: 2.2,                             // the roof's soffit meets the side walls here
  wheelY: -0.86, archR: 0.72, archZ: [2.65, -2.6],
  tireR: 0.55, tireW: 0.48, tireLift: 0.045,   // the painted tire is fatter than the physics wheel
  door: { z0: -0.15, z1: 0.85, y0: 0, y1: 1.98 },
  // side openings: rectangles { z0, z1, y0, y1 } or portholes { z, y, r }
  winL: [
    { z0: 2.86, z1: 3.7, y0: 1.0, y1: 1.94, cab: true },
    { z0: 0.55, z1: 1.75, y0: 1.08, y1: 1.84 },
    { z0: -1.55, z1: -0.55, y0: 1.08, y1: 1.84 },
    { z: -3.42, y: 0.98, r: 0.19 },
    { z: -3.42, y: 1.84, r: 0.17 },
  ],
  winR: [
    { z0: 2.86, z1: 3.7, y0: 1.0, y1: 1.94, cab: true },
    { z0: 1.45, z1: 2.45, y0: 1.32, y1: 1.86 },
    { z: -2.25, y: 1.74, r: 0.15, frost: true },
    { z: -3.42, y: 0.98, r: 0.19 },
    { z: -3.42, y: 1.84, r: 0.17 },
  ],
  shield: { x: 1.07, y0: 1.04, y1: 2.06 },
  rearWin: { x: 0.7, y0: 1.62, y1: 2.02 },
  // the livery (local y)
  gold: [0.985, 1.035], orange: [0.71, 0.965], brown: [0.575, 0.69], brassTop: [0.525, 0.56],
  wood: [0.065, 0.525], brassLow: [0.03, 0.065], rail: 0.548,
  emblem: { L: 2.42, R: 2.66, y: 1.56, r: 0.15 },
  // the name starts clear of the fat rear corner post (it ends at z ≈ -3.78)
  name: { R: [-3.6, -0.3], L: [-3.6, 0.45] },
  hatches: { R: [[-1.75, -0.65, 'LOOT'], [0.98, 1.84, 'JUNK']], L: [[0.62, 1.8, 'LOOT']] },
  // iron rib straps down the sides (eave → rub rail), clear of every opening
  ribs: { R: [-2.85, -1.95, 1.12], L: [-2.05, 0.0, 2.05] },
  // story elements on the long rear halves: a goblin advert plate and chalk tallies (door side),
  // a round oak shield with the maker's cog (driver's side, 3D)
  advert: { z0: -1.72, z1: -0.74, y0: 1.04, y1: 1.7 },
  tally: { z0: -0.62, z1: -0.28, y0: 1.18, y1: 1.5 },
  buckler: { z: -2.75, y: 1.42, r: 0.27 },
};
// atlas regions (px) of rv_body
export const BODY = { W: 1024, H: 1024, sidePx: 128, R: 0, L: 384, endY: 768, endW: 256, front: 0, rear: 256, roof: 512 };
// trim sheet bands
export const TRIM = {
  W: 512, H: 2048, band: 64,
  wood: 0, oak: 1, brass: 2, iron: 3, red: 4, green: 5, cream: 6, tread: 7, strap: 8, gingham: 9,
  slate: 10, canvas: 11, glass: 12, rope: 13, slots: 14, wide: 15,
  awning: 16, burlap: 17, carpet: 18, copper: 19, roofedge: 20, hay: 21, bone: 22, leaf: 23,
  sand: 24, soot: 25, leather: 26, slots2: 27, wide2: 28, block: 29, flag: 30, post: 31,
  // band 28 (wide2) is the brow's destination board, the whole 512×64 band (8:1)
  board: 28,
  // band 30: the pennant's cloth [0, 384) px, a rolled carpet's end [384, 448), spare [448, 512)
  flagPx: { cloth: [0, 384], carpetEnd: [384, 448] },
  // 64×64 decal slots in band 14
  s: { hub: 0, gauge: 1, fuel: 2, frost: 3, emblem: 4, burner: 5, clock: 6, apple: 7 },
  // 64×64 decal slots in band 27
  s2: { skull: 0, fan: 1, port: 2, flowers: 3, lens: 4, map: 5, crest: 6, mud: 7 },
  // 128×64 slots in band 15
  w: { plate: 0, sticker: 1, radio: 2, plaque: 3 },
};
// pleats across one curtain panel (the gingham band's folds line up with rv3d.js' pleated panels)
export const GINGHAM_PLEATS = 4;
// soft goods regions (px of a 512² atlas): x, y, w, h. The runner: its end piece is the top
// RUG_END px of the rug region, the rest is a middle piece that tiles along v.
export const SOFT = { quilt: [0, 0, 256, 256], plaid: [256, 0, 256, 256], rug: [0, 256, 256, 256], stall: [256, 256, 256, 256], RUG_END: 72 };
// lamps and glows (px of a 512×256 atlas)
export const LAMPS = {
  W: 512, H: 256,
  head: [0, 0, 128, 128], tail: [128, 0, 128, 128], amber: [0, 128, 128, 128], lantern: [128, 128, 128, 128],
  window: [256, 0, 256, 128], halo: [256, 128, 128, 128], port: [384, 128, 128, 128],
};

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
// a tiny seeded generator: lets a mark that is drawn twice across a seam replay the same numbers
const lcg = seed => { let s = seed % 2147483647 || 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; };
// horizontal-only wrapping (bands of the trim sheet tile along u). Draw every random number
// BEFORE calling it, so both copies of a mark that crosses the seam are identical.
function wrapX(W, x, r, fn) { fn(x); if (x - r < 0) fn(x + W); if (x + r > W) fn(x - W); }
const radial = (g, cx, cy, r, stops) => { const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r); for (const [t, c, a = 1] of stops) gr.addColorStop(t, rgba(c, a)); return gr; };

function rivet(g, x, y, r, base = '#9a7a3a', shadowA = 0.5) {
  blob(g, x + r * 0.55, y + r * 0.7, r * 1.75, r * 1.5, 0, INK, shadowA, 0.25);
  ellipse(g, x, y, r, r, 0, shadowOf(base, 0.4));
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

// ---- lettering -----------------------------------------------------------------------------------

// Hand-lettered sign-painter's capitals. Each letter is painted on its own little canvas in
// layers (umber outline, a darker under-body, a gold body offset up-left so a shadow sliver stays
// on the lower right, a cream highlight sliver on the upper left, chips knocked out to the wood),
// then set down with its own tilt, baseline and size, through a slight horizontal wobble, over a
// soft drop shadow. capH is the cap height in px; the text squeezes to fit maxW.
function handLetter(g, text, cx, cy, maxW, capH, rnd, {
  font = LETTER_FONT, weight = 900, top = '#f4d888', bot = '#a8742a', under = '#6a4418', outline = '#2a1a12',
  hi = '#fff2c8', outlineW = 0.13, chips = 3, tilt = 0.035, bob = 0.045, scaleJ = 0.04, wobble = 0.7, shadow = 0.5, track = 0.06,
} = {}) {
  const probe = makeCanvas(8, 8).getContext('2d');
  let size = capH / 0.7;
  probe.font = `${weight} ${size}px ${font}`;
  const capReal = probe.measureText('H').actualBoundingBoxAscent || size * 0.7;
  size *= capH / capReal;
  const fnt = `${weight} ${size.toFixed(1)}px ${font}`;
  probe.font = fnt;
  const chars = [...text], ws = chars.map(ch => probe.measureText(ch).width), tr = size * track;
  const total = ws.reduce((a, b) => a + b, 0) + tr * (chars.length - 1);
  const sx = Math.min(1, maxW / total);
  const pad = Math.ceil(size * 0.22 + 4);
  let x = cx - total * sx / 2;
  const o1 = Math.max(1.2, capH * 0.04);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i], lw = ws[i];
    // draw all of this letter's random numbers up front
    const rot = (rnd() - 0.5) * 2 * tilt, dy = (rnd() - 0.5) * 2 * bob * capH, sc = 1 + (rnd() - 0.5) * 2 * scaleJ, ph = rnd() * TAU;
    const chipList = Array.from({ length: chips }, () => [rnd(), rnd(), range(rnd, 0.6, 1.6), rnd() * 3]);
    if (ch === ' ') { x += (lw + tr) * sx; continue; }
    const W = Math.ceil(lw + pad * 2), H = Math.ceil(capH + pad * 2), bx = pad, by = pad + capH;
    const mk = () => { const c = makeCanvas(W, H), b = c.getContext('2d'); b.font = fnt; b.textBaseline = 'alphabetic'; b.textAlign = 'left'; return [c, b]; };
    // body: under-colour, gold up-left of it, then the cream sliver
    const [fc, fb] = mk();
    fb.fillStyle = under; fb.fillText(ch, bx, by);
    fb.globalCompositeOperation = 'source-atop';
    fb.fillStyle = grad(fb, 0, by - capH, 0, by, [[0, top], [0.55, mix(top, bot, 0.55)], [1, bot]]);
    fb.fillText(ch, bx - o1, by - o1);
    const [hc, hb] = mk();
    hb.fillStyle = hi; hb.fillText(ch, bx, by);
    hb.globalCompositeOperation = 'destination-out'; hb.fillText(ch, bx + o1 * 0.9, by + o1 * 0.9);
    fb.globalCompositeOperation = 'source-atop'; fb.globalAlpha = 0.85; fb.drawImage(hc, 0, 0); fb.globalAlpha = 1;
    // the letter: outline under the body, chips through both
    const [lc, lb] = mk();
    lb.lineJoin = 'round'; lb.lineWidth = Math.max(2, size * outlineW); lb.strokeStyle = outline; lb.strokeText(ch, bx, by);
    lb.drawImage(fc, 0, 0);
    lb.globalCompositeOperation = 'destination-out';
    for (const [u, v, r, a] of chipList) {
      const px = bx + u * lw, py = by - v * capH, rr = r * Math.max(1.4, capH * 0.035);
      lb.beginPath();
      for (let k = 0; k < 6; k++) { const t = a + k / 6 * TAU, q = rr * (0.6 + 0.4 * Math.sin(k * 2.3 + a)); lb.lineTo(px + Math.cos(t) * q * 1.4, py + Math.sin(t) * q); }
      lb.closePath(); lb.fill();
    }
    lb.globalCompositeOperation = 'source-over';
    // shadow stamp (the letter's alpha, dark)
    const [sc2, sb] = mk();
    sb.drawImage(lc, 0, 0); sb.globalCompositeOperation = 'source-in'; sb.fillStyle = '#1a1014'; sb.fillRect(0, 0, W, H);
    const lx = x + lw * sx / 2;
    g.save();
    g.translate(lx, cy + capH / 2 + dy - capH / 2);
    g.rotate(rot);
    g.scale(sx * sc, sc);
    const ox = -(bx + lw / 2), oy = -(by - capH / 2);
    g.save(); g.globalAlpha = shadow; g.filter = `blur(${Math.max(1, capH * 0.05).toFixed(1)}px)`; g.drawImage(sc2, ox + capH * 0.06, oy + capH * 0.08); g.restore();
    for (let sy = 0; sy < H; sy += 3) {
      const wob = Math.sin(sy * 0.21 + ph) * wobble;
      g.drawImage(lc, 0, sy, W, Math.min(3, H - sy), ox + wob, oy + sy, W, Math.min(3, H - sy));
    }
    g.restore();
    x += (lw + tr) * sx;
  }
}

// A worn stencilled word (storage hatches): bridges through the round letters, speckled edges.
function stencil(g, text, cx, cy, size, rnd, color = '#e6d6ae', alpha = 0.85, speckle = 40, wear = 4) {
  const W = Math.ceil(size * text.length * 1.0 + 24), H = Math.ceil(size * 1.5);
  const c = makeCanvas(W, H), b = c.getContext('2d');
  b.font = `bold ${size}px ${STENCIL_FONT}`; b.textBaseline = 'middle'; b.textAlign = 'left';
  const tr = size * 0.18, ws = [...text].map(ch => b.measureText(ch).width);
  let x = (W - (ws.reduce((a, q) => a + q, 0) + tr * (ws.length - 1))) / 2;
  const centers = [];
  for (let i = 0; i < ws.length; i++) { b.fillStyle = color; b.fillText(text[i], x, H / 2); centers.push([text[i], x + ws[i] / 2]); x += ws[i] + tr; }
  b.globalCompositeOperation = 'destination-out';
  const bw = Math.max(2.4, size * 0.08);
  for (const [ch, mx] of centers) {
    if ('OQDB0'.includes(ch)) { b.fillRect(mx - bw / 2, 0, bw, H * 0.42); b.fillRect(mx - bw / 2, H * 0.58, bw, H * 0.42); }
    if ('APR'.includes(ch)) b.fillRect(mx - bw / 2, H * 0.5, bw, H * 0.5);
  }
  for (let i = 0; i < W * H / speckle; i++) { const px = rnd() * W, py = rnd() * H, r = range(rnd, 0.5, 1.6); b.globalAlpha = range(rnd, 0.4, 1); b.beginPath(); b.arc(px, py, r, 0, TAU); b.fill(); }
  for (let i = 0; i < wear; i++) { const px = rnd() * W, py = rnd() * H; b.globalAlpha = 0.7; b.beginPath(); b.ellipse(px, py, range(rnd, 3, 8), range(rnd, 2, 5), rnd() * 3, 0, TAU); b.fill(); }
  g.save(); g.globalAlpha = alpha; g.drawImage(c, cx - W / 2, cy - H / 2); g.restore();
}

// A paint chip knocked through to the dark primer: an irregular little polygon whose lower-right
// wall catches the light (the chip's depth) and whose upper-left edge throws a soft shadow.
function chip(g, rnd, x, y, s) {
  const n = 5 + Math.floor(rnd() * 3), rot = rnd() * TAU, ax = range(rnd, 0.9, 1.7), pts = [];
  for (let k = 0; k < n; k++) { const a = (k + rnd() * 0.6) / n * TAU, q = s * range(rnd, 0.5, 1); pts.push([Math.cos(a) * q * ax, Math.sin(a) * q]); }
  const c = pick(rnd, ['#4e3a2e', '#5a5048', '#47362c']);
  const cr = Math.cos(rot), sr = Math.sin(rot);
  const poly = (dx, dy, col, a) => {
    g.save(); g.globalAlpha = a; g.fillStyle = col; g.beginPath();
    pts.forEach(([px, py], i) => { const X = x + dx + px * cr - py * sr, Y = y + dy + px * sr + py * cr; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); });
    g.closePath(); g.fill(); g.restore();
  };
  poly(-1, -1, '#2a1a20', 0.4);
  poly(1, 1, '#f6e2b4', 0.8);
  poly(0, 0, c, 1);
}

// a brass cog with a coin face: the goblin maker's mark
function cog(g, x, y, r, label = '9K') {
  const teeth = 10;
  g.save();
  blob(g, x + r * 0.15, y + r * 0.2, r * 1.35, r * 1.3, 0, INK, 0.4, 0.4);
  g.beginPath();
  for (let i = 0; i < teeth * 2; i++) {
    const a0 = i / (teeth * 2) * TAU, a1 = (i + 1) / (teeth * 2) * TAU, rr = i % 2 ? r * 0.82 : r;
    g.arc(x, y, rr, a0, a1);
  }
  g.closePath();
  g.fillStyle = grad(g, x - r, y - r, x + r, y + r, [[0, '#e0c47a'], [0.45, '#a8823a'], [1, '#553a1a']]);
  g.fill();
  g.lineWidth = Math.max(1, r * 0.06); g.strokeStyle = rgba('#3a2412', 0.8); g.stroke();
  ellipse(g, x, y, r * 0.62, r * 0.62, 0, '#6a4a20');
  g.beginPath(); g.arc(x, y, r * 0.56, 0, TAU);
  g.fillStyle = grad(g, x - r * 0.5, y - r * 0.5, x + r * 0.5, y + r * 0.5, [[0, '#ecd08a'], [0.5, '#b48a40'], [1, '#6e4f24']]);
  g.fill();
  blob(g, x + r * 0.2, y + r * 0.25, r * 0.3, r * 0.22, 0, '#6e8c6a', 0.35, 0.3);
  g.font = `900 ${Math.round(r * 0.62)}px ${LETTER_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#4a2c10'; g.fillText(label, x + r * 0.03, y + r * 0.05);
  g.fillStyle = rgba('#fff0c0', 0.45); g.fillText(label, x - r * 0.03, y - r * 0.01);
  blob(g, x - r * 0.3, y - r * 0.35, r * 0.3, r * 0.2, -0.6, '#fff0c8', 0.5, 0.3);
  g.restore();
}

// ---- the body atlas ------------------------------------------------------------------------------

const CREAM = '#e4cf9f';
const ORANGE = '#c4662c', BROWN = '#5c3720', GOLD = '#c8963e', SKIRT = '#55505c';
const WOODS = ['#8e5c34', '#84542f', '#966438', '#7c4e2c'];
const RUST = '#8a5a30';

// The livery bands from y=hi down to y=lo, painted across [x0, x1] using Y(y) → px.
function livery(g, rnd, x0, x1, Y, { chips = 1, woodNails = true, woodBand = true, hot = [] } = {}) {
  const A = RV_ART, w = x1 - x0;
  const band = (lo, hi, top, mid, bot) => {
    const y0 = Y(hi), y1 = Y(lo);
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
  // a soft cast shadow under the stripe set (it sits a hair proud)
  rect(g, x0, Y(A.gold[0]), w, 6, grad(g, 0, Y(A.gold[0]), 0, Y(A.gold[0]) + 6, [[0, INK, 0.25], [1, INK, 0]]));
  band(A.gold[0], A.gold[1], '#ecca7a', GOLD, '#8a5e26');
  band(A.orange[0], A.orange[1], '#e08850', ORANGE, '#94461c');
  band(A.brown[0], A.brown[1], '#7e5234', BROWN, '#3e2416');
  // worn paint: a few broad sun-faded patches, then chips knocked through to the dark primer,
  // clustered where hands, boots and stones hit (door edges, corners, window corners, arches),
  // mostly along the stripe's edges
  clipRect(g, x0, Y(A.orange[1]), w, Y(A.brown[0]) - Y(A.orange[1]), () => {
    mottleIn(g, rnd, x0, Y(A.orange[1]), w, Y(A.orange[0]) - Y(A.orange[1]), { colors: ['#d8844a', '#a85424', '#e0a070'], count: Math.round(w / 12), rmin: 6, rmax: 28, alpha: 0.35, stretch: 3 });
    const yo0 = Y(A.orange[1]), yo1 = Y(A.orange[0]);
    for (let i = 0; i < Math.max(1, Math.round(w / 380)); i++) {
      const x = x0 + range(rnd, 0.1, 0.9) * w, y = range(rnd, yo0 + 5, yo1 - 5), ry = range(rnd, 6, 11);
      blob(g, x, y, ry * range(rnd, 3.5, 4.5), ry, (rnd() - 0.5) * 0.08, '#e8a870', range(rnd, 0.12, 0.18), 0.15);
    }
    const n = Math.round(w / 100 * chips);
    for (let i = 0; i < n; i++) {
      const hx = hot.length ? pick(rnd, hot) : x0 + rnd() * w;
      const x = hx + (rnd() + rnd() - 1) * 26, e = rnd();
      const y = e < 0.42 ? yo0 + range(rnd, 1.5, 5) : e < 0.84 ? yo1 - range(rnd, 1.5, 5) : e < 0.93 ? Y(A.brown[0]) - range(rnd, 1.5, 4) : range(rnd, yo0, Y(A.brown[0]));
      const s = range(rnd, 2, 4);
      chip(g, rnd, x, y, s);
      if (rnd() < 0.45) chip(g, rnd, x + range(rnd, 5, 10) * (rnd() < 0.5 ? -1 : 1), y + range(rnd, -3, 3), s * 0.6);
    }
  });
  // brass trim lines either side of the wood band (the oak rub rail covers the top one)
  for (const [lo, hi] of [A.brassTop, A.brassLow]) {
    const y0 = Y(hi), y1 = Y(lo);
    rect(g, x0, y0, w, y1 - y0, grad(g, 0, y0, 0, y1, [[0, '#e0c47c'], [0.35, '#a07a36'], [1, '#553a1a']]));
    for (let i = 0; i < w / 40; i++) blob(g, x0 + rnd() * w, (y0 + y1) / 2, range(rnd, 4, 14), (y1 - y0) * 0.5, 0, pick(rnd, ['#6e8c6a', '#46301a']), 0.35, 0.3);
  }
  const wy0 = Y(A.wood[1]), wy1 = Y(A.wood[0]), rows = 2, rh = (wy1 - wy0) / rows;
  if (!woodBand) {
    // a cream nose: the stripes wrap round, the panel below stays painted metal
    rect(g, x0, wy0, w, wy1 - wy0, grad(g, 0, wy0, 0, wy1, [[0, '#dcc69a'], [1, '#c8b086']]));
    mottleIn(g, rnd, x0, wy0, w, wy1 - wy0, { colors: ['#e8d6ae', '#cbb48a', '#c4b8a8'], count: 20, rmin: 6, rmax: 20, alpha: 0.3 });
    rect(g, x0, wy0, w, 5, grad(g, 0, wy0, 0, wy0 + 5, [[0, INK, 0.35], [1, INK, 0]]));
    return;
  }
  // the wood band: two courses of long planks
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
    // the rub rail above casts a soft shadow on the planks; a darker foot line
    rect(g, x0, wy0, w, 9, grad(g, 0, wy0, 0, wy0 + 9, [[0, INK, 0.55], [1, INK, 0]]));
    rect(g, x0, wy1 - 4, w, 4, grad(g, 0, wy1 - 4, 0, wy1, [[0, INK, 0], [1, INK, 0.45]]));
  });
}

// The cream riveted panels between seams: oil-canned (lit top-left, shaded bottom-right), a hard lit
// bevel along each panel's top/left edge, a soft shadow on its bottom/right, big rivets along the
// seams, rust runs from some rivets.
function panels(g, rnd, xs, ya, yb, { rivR = 3.7, step = [18, 22], runs = 0.22 } = {}) {
  for (let i = 0; i < xs.length - 1; i++) {
    const xa = xs[i], xb = xs[i + 1], w = xb - xa, h = yb - ya;
    rect(g, xa, ya, w, h, grad(g, xa, ya, xa + w * 0.9, yb, [[0, '#fff0c8', 0.4], [0.32, '#fff0c8', 0], [0.62, '#5e4858', 0], [1, '#5e4858', 0.35]]));
    // a broad soft dent or two
    for (let k = 0; k < 2; k++) blob(g, range(rnd, xa + w * 0.2, xb - w * 0.2), range(rnd, ya + h * 0.2, yb - h * 0.2), range(rnd, 14, 30), range(rnd, 10, 22), rnd() * 3, rnd() < 0.5 ? '#fff0c8' : '#7a6460', 0.16, 0.2);
    // bevels
    rect(g, xa, ya, w, 2, '#fff6dc', 0.75); rect(g, xa, ya, 2, h, '#fff6dc', 0.6);
    rect(g, xa, yb - 4, w, 4, grad(g, 0, yb - 4, 0, yb, [[0, '#5e4858', 0], [1, '#5e4858', 0.45]]));
    rect(g, xb - 4, ya, 4, h, grad(g, xb - 4, 0, xb, 0, [[0, '#5e4858', 0], [1, '#5e4858', 0.45]]));
  }
  for (let i = 1; i < xs.length - 1; i++) {
    const x = xs[i];
    line(g, [[x, ya], [x, yb]], 1.6, '#4a3a40', 0.6);
    for (let y = ya + 9; y < yb - 5; y += range(rnd, step[0], step[1])) {
      rivet(g, x + 7, y, rivR, '#dcc8a0', 0.45);
      if (rnd() < runs) line(g, [[x + 7, y + rivR + 1], [x + 7 + (rnd() - 0.5) * 2, y + range(rnd, 20, 80)]], range(rnd, 1.5, 3), RUST, range(rnd, 0.25, 0.4));
    }
  }
}

// One long side. side 'R' (door side, -X) has the front at the right; 'L' (+X) is mirrored.
function paintSide(g, rnd, side, oy) {
  const A = RV_ART, P = BODY.sidePx, W = BODY.W, H = 384;
  const X = z => side === 'R' ? (z + 4) * P : (4 - z) * P;
  const Y = y => oy + (A.y1 - y) * P;
  const wins = side === 'R' ? A.winR : A.winL;
  g.save();
  g.beginPath(); g.rect(0, oy, W, H); g.clip();
  // cream body: warm, darker toward the belt; big soft blotches in three related hues
  rect(g, 0, oy, W, H, grad(g, 0, Y(2.3), 0, Y(0.9), [[0, '#ead8aa'], [0.5, CREAM], [1, '#d2bb8a']]));
  mottleIn(g, rnd, 0, Y(2.3), W, Y(0.95) - Y(2.3), { colors: ['#d6bb86', '#ecdcb4', '#c9b48c'], count: 70, rmin: 30, rmax: 110, alpha: 0.35, stretch: 1.6 });
  mottleIn(g, rnd, 0, Y(2.3), W, Y(0.95) - Y(2.3), { colors: ['#f2e2bc', '#cdb68a', '#bfae96'], count: 90, rmin: 8, rmax: 24, alpha: 0.25, stretch: 2.2 });
  // panels: seams between the openings
  const blocked = z => wins.some(o => o.r ? Math.abs(z - o.z) < o.r + 0.12 : z > o.z0 - 0.12 && z < o.z1 + 0.12) || (side === 'R' && z > A.door.z0 - 0.14 && z < A.door.z1 + 0.14);
  let z = -3.95;
  const seams = [];
  while (z < 3.8) {
    z += range(rnd, 0.85, 1.3);
    let zz = z, tries = 0;
    while (blocked(zz) && tries++ < 40) zz += 0.05;
    if (zz < 3.85) seams.push(zz), z = zz;
  }
  const xs = [0, ...seams.map(X).sort((a, b) => a - b), W];
  const ya = Y(A.eaveY), yb = Y(A.gold[1]) - 1;
  panels(g, rnd, xs, ya, yb);
  // a riveted lap seam under the eave
  {
    const y = Y(2.08);
    line(g, [[0, y], [W, y]], 2, '#4a3a40', 0.55);
    line(g, [[0, y + 2], [W, y + 2]], 1.6, '#fff6dc', 0.6);
    for (let x = 8; x < W; x += range(rnd, 18, 22)) rivet(g, x, y + 7, 3.4, '#dcc8a0', 0.4);
  }
  // rust and soot runs from the eave, thicker toward the rear (it sits in the road's spray)
  for (let i = 0; i < 30; i++) {
    const u = rnd() ** 1.8, x = side === 'R' ? u * W : W - u * W, y = Y(A.eaveY) + range(rnd, 0, 6);
    line(g, [[x, y], [x + (rnd() - 0.5) * 3, y + range(rnd, 20, 80)]], range(rnd, 1.5, 4), pick(rnd, [RUST, '#6a5a50', '#7a6450']), range(rnd, 0.2, 0.38));
  }
  // under the eave: a cool shadow band 0.35 m tall
  rect(g, 0, Y(A.eaveY), W, 0.35 * P, grad(g, 0, Y(A.eaveY), 0, Y(A.eaveY - 0.35), [[0, '#5a4a62', 0.55], [1, '#5a4a62', 0]]));
  // windows: a crisp cast shadow down-right of each frame, sill drips, rust at the corners
  for (const o of wins) {
    if (o.r) {
      const x = X(o.z), y = Y(o.y), r = (o.r + 0.05) * P;
      ellipse(g, x + 6, y + 7, r, r, 0, '#4a3a4a', 0.35);
      for (let i = 0; i < 3; i++) { const sx = x + (rnd() - 0.5) * r * 0.8; line(g, [[sx, y + r + 2], [sx + (rnd() - 0.5) * 1.5, y + r + range(rnd, 14, 40)]], range(rnd, 2, 3.5), RUST, 0.25); }
      continue;
    }
    const gw = 0.075 * P;
    const xa = Math.min(X(o.z0), X(o.z1)) - gw, xb = Math.max(X(o.z0), X(o.z1)) + gw, ya2 = Y(o.y1) - gw, yb2 = Y(o.y0) + gw;
    g.save(); rrect(g, xa + 7, ya2 + 7, xb - xa, yb2 - ya2, 10); g.fillStyle = rgba('#4a3a4a', 0.38); g.fill(); g.restore();
    for (let i = 0; i < 7; i++) {
      const x = range(rnd, xa + 6, xb - 2), y = yb2 + 12;
      line(g, [[x, y], [x + (rnd() - 0.5) * 3, y + range(rnd, 12, 50)]], range(rnd, 1.4, 3.2), pick(rnd, [RUST, '#7a6450']), range(rnd, 0.22, 0.36));
    }
    for (const cx of [xa + 3, xb - 3]) line(g, [[cx, yb2 + 4], [cx + (rnd() - 0.5) * 2, yb2 + range(rnd, 25, 60)]], 2.4, RUST, 0.35);
  }
  // the door outline (the door itself carries this same paint)
  if (side === 'R') {
    const xa = X(A.door.z0), xb = X(A.door.z1), ya3 = Y(A.door.y1), yb3 = Y(A.door.y0 - 0.02);
    g.save(); rrect(g, xa + 1, ya3 + 1, xb - xa - 2, yb3 - ya3, 10); g.lineWidth = 3; g.strokeStyle = rgba('#3a2a34', 0.6); g.stroke();
    rrect(g, xa + 4, ya3 + 4, xb - xa - 8, yb3 - ya3 - 6, 8); g.lineWidth = 1.6; g.strokeStyle = rgba('#fff4dc', 0.55); g.stroke(); g.restore();
  }
  cog(g, X(A.emblem[side]), Y(A.emblem.y), A.emblem.r * P);
  if (side === 'R') { advertPlate(g, rnd, X, Y); chalkTally(g, rnd, X, Y); }
  // chips cluster at the corners, the door's edges, the window corners and over the arches
  const hot = [14, W - 14, ...A.archZ.flatMap(az => [X(az - 0.5), X(az + 0.5)]), ...wins.filter(o => !o.r).flatMap(o => [X(o.z0), X(o.z1)])];
  if (side === 'R') hot.push(X(A.door.z0), X(A.door.z1), X(A.door.z0) + 6, X(A.door.z1) - 6);
  livery(g, rnd, 0, W, Y, { hot });
  // the name, hand-lettered in gold on the wood band
  {
    const [za, zb] = A.name[side];
    const cx = (X(za) + X(zb)) / 2, wy0 = Y(A.wood[1]), wy1 = Y(A.wood[0]);
    handLetter(g, 'SLOPMASTER 9000', cx, (wy0 + wy1) / 2 + 2, Math.abs(X(zb) - X(za)) - 10, (wy1 - wy0) * 0.62, rnd);
  }
  // the skirt: riveted iron, dusty at the bottom
  {
    const ya4 = Y(A.brassLow[0]), yb4 = Y(A.y0);
    rect(g, 0, ya4, W, yb4 - ya4, grad(g, 0, ya4, 0, yb4, [[0, '#6a6470'], [0.25, SKIRT], [1, '#38323c']]));
    mottleIn(g, rnd, 0, ya4, W, yb4 - ya4, { colors: ['#5a5460', '#433e48', '#5c4a44', '#6a4a36'], count: 70, rmin: 8, rmax: 30, alpha: 0.32, stretch: 2 });
    for (let x = 8; x < W; x += range(rnd, 18, 22)) { rivet(g, x, ya4 + 9, 3.4, '#7a7480', 0.5); rivet(g, x + 7, yb4 - 10, 3.4, '#7a7480', 0.5); }
    for (let i = 0; i < 30; i++) { const x = rnd() * W, y = ya4 + range(rnd, 10, 20); line(g, [[x, y], [x + (rnd() - 0.5) * 2, y + range(rnd, 15, 45)]], range(rnd, 1.5, 3), RUST, range(rnd, 0.25, 0.4)); }
    // a riveted patch plate (goblin repair)
    const px = X(side === 'R' ? -1.0 : -0.25), pw = 0.5 * P;
    rect(g, px, ya4 + 18, pw, 30, grad(g, 0, ya4 + 18, 0, ya4 + 48, [[0, '#7a7078'], [1, '#4a4450']]));
    rect(g, px, ya4 + 18, pw, 2, '#a8a2b0', 0.6);
    rect(g, px, ya4 + 46, pw, 3, INK, 0.45);
    for (const [u, v] of [[6, 24], [pw - 6, 24], [6, 42], [pw - 6, 42]]) rivet(g, px + u, ya4 + v, 3, '#a29aa4');
    // storage hatches: dark iron plates standing proud of the skirt (lit top edge, a cast shadow
    // below), strap hinges, a brass latch, a bold cream stencil (the grime overlay leaves them clean)
    for (const [za, zb, label] of A.hatches[side]) {
      const xa = Math.min(X(za), X(zb)), xb = Math.max(X(za), X(zb)), hy0 = Y(-0.06), hy1 = Y(-0.5);
      g.save(); g.filter = 'blur(3px)'; rrect(g, xa + 4, hy0 + 7, xb - xa, hy1 - hy0, 6); g.fillStyle = rgba('#1a1218', 0.6); g.fill(); g.restore();
      g.save(); rrect(g, xa, hy0, xb - xa, hy1 - hy0, 6); g.clip();
      rect(g, xa, hy0, xb - xa, hy1 - hy0, grad(g, xa, hy0, xa + (xb - xa) * 0.5, hy1, [[0, '#585058'], [0.45, '#4a4248'], [1, '#342e36']]));
      mottleIn(g, rnd, xa, hy0, xb - xa, hy1 - hy0, { colors: ['#544c54', '#3a343c', '#5a4840'], count: 10, rmin: 6, rmax: 18, alpha: 0.3, stretch: 1.8 });
      rect(g, xa, hy0, xb - xa, 3, '#8a8088', 0.95); rect(g, xa, hy0, 2, hy1 - hy0, '#8a8088', 0.6);
      rect(g, xa, hy1 - 4, xb - xa, 4, '#1e1820', 0.6); rect(g, xb - 3, hy0, 3, hy1 - hy0, '#1e1820', 0.45);
      stencil(g, label, (xa + xb) / 2, (hy0 + hy1) / 2 + 2, 33, rnd, '#e6d6a8', 0.92, 140, 2);
      for (let i = 0; i < 3; i++) { const x = range(rnd, xa + 8, xb - 8); line(g, [[x, hy0 + 4], [x + (rnd() - 0.5) * 2, hy0 + range(rnd, 10, 22)]], range(rnd, 1.4, 2.4), RUST, 0.35); }
      g.restore();
      for (const u of [0.2, 0.8]) {
        const hx = xa + (xb - xa) * u;
        rect(g, hx - 6, hy0 - 3, 12, 28, grad(g, hx - 6, 0, hx + 6, 0, [[0, '#8a8490'], [1, '#3e3844']]));
        rivet(g, hx, hy0 + 3, 2.6, '#9a94a0'); rivet(g, hx, hy0 + 18, 2.6, '#9a94a0');
      }
      const lx = (xa + xb) / 2;
      rect(g, lx - 9, hy1 - 15, 18, 11, grad(g, 0, hy1 - 15, 0, hy1 - 4, [[0, '#d8bc72'], [1, '#6e4f24']]));
      rivet(g, lx, hy1 - 9.5, 2.6, '#c09a50', 0.4);
    }
    rect(g, 0, ya4, W, yb4 - ya4, grad(g, 0, ya4, 0, yb4, [[0, '#8a7a64', 0], [0.6, '#8a7a64', 0.2], [1, '#9a8a70', 0.5]]));
  }
  // dust over the lower body, mud fans around the arches
  rect(g, 0, Y(1.0), W, Y(A.y0) - Y(1.0), grad(g, 0, Y(1.0), 0, Y(A.y0), [[0, '#8a7a5e', 0], [1, '#8a7a5e', 0.25]]));
  for (const az of A.archZ) {
    const cx = X(az), cy = Y(A.wheelY), r = A.archR * P;
    for (let i = 0; i < 40; i++) {
      const a = range(rnd, 0.25, Math.PI - 0.25), d = r * range(rnd, 1.02, 1.5);
      const x = cx + Math.cos(a) * d * (rnd() < 0.5 ? 1 : -1), y = cy - Math.sin(a) * d;
      blob(g, x, y, range(rnd, 3, 12), range(rnd, 2, 7), a, pick(rnd, ['#6a5440', '#7a6248', '#5a4636']), range(rnd, 0.15, 0.4), 0.4);
    }
    g.save(); g.beginPath(); g.arc(cx, cy, r + 9, Math.PI, TAU); g.lineWidth = 14; g.strokeStyle = rgba('#3a2e30', 0.4); g.filter = 'blur(4px)'; g.stroke(); g.restore();
  }
  rect(g, 0, oy, 26, H, grad(g, 0, 0, 26, 0, [[0, INK, 0.35], [1, INK, 0]]));
  rect(g, W - 26, oy, 26, H, grad(g, W - 26, 0, W, 0, [[0, INK, 0], [1, INK, 0.35]]));
  g.restore();
}

// A goblin advert on a riveted tin plate: faded red field, cream border, a flame-in-a-cog, the
// slogan; a bent corner, scratches and rust.
function advertPlate(g, rnd, X, Y) {
  const a = RV_ART.advert, xa = Math.min(X(a.z0), X(a.z1)), xb = Math.max(X(a.z0), X(a.z1)), ya = Y(a.y1), yb = Y(a.y0), w = xb - xa, h = yb - ya;
  g.save(); g.filter = 'blur(2px)'; rrect(g, xa + 4, ya + 5, w, h, 4); g.fillStyle = rgba('#3a2a34', 0.45); g.fill(); g.restore();
  g.save(); rrect(g, xa, ya, w, h, 4); g.clip();
  rect(g, xa, ya, w, h, grad(g, xa, ya, xa + w * 0.6, yb, [[0, '#a8483a'], [0.5, '#8e3a2e'], [1, '#6a2a24']]));
  mottleIn(g, rnd, xa, ya, w, h, { colors: ['#b85a44', '#7a3028', '#c49a7a'], count: 14, rmin: 8, rmax: 26, alpha: 0.3, stretch: 1.6 });
  g.save(); rrect(g, xa + 4, ya + 4, w - 8, h - 8, 3); g.lineWidth = 3; g.strokeStyle = '#e2cfa0'; g.stroke(); g.restore();
  // the flame in a cog (lower left), the slogan over and beside it
  const cx = xa + w * 0.24, cy = ya + h * 0.66, cr = h * 0.2;
  cog(g, cx, cy, cr, '');
  g.save(); g.beginPath(); g.moveTo(cx, cy - cr * 0.62); g.quadraticCurveTo(cx + cr * 0.48, cy, cx, cy + cr * 0.45); g.quadraticCurveTo(cx - cr * 0.48, cy, cx, cy - cr * 0.62); g.fillStyle = '#f0a040'; g.fill(); g.restore();
  blob(g, cx, cy + cr * 0.12, cr * 0.16, cr * 0.24, 0, '#fff0b0', 0.9, 0.4);
  g.save(); g.textAlign = 'center'; g.textBaseline = 'alphabetic';
  for (const [txt, tx, yy, fs, mw] of [['GOBLIN', xa + w / 2, ya + h * 0.36, h * 0.25, w - 18], ['GAS', xa + w * 0.64, ya + h * 0.84, h * 0.36, w * 0.56]]) {
    g.font = `900 ${fs.toFixed(1)}px ${LETTER_FONT}`;
    g.fillStyle = '#3a1810'; g.fillText(txt, tx + 1.2, yy + 1.4, mw);
    g.fillStyle = '#ecdcb0'; g.fillText(txt, tx, yy, mw);
  }
  g.restore();
  // weathering: scratches, rust from the rivets, a faded top-left
  for (let i = 0; i < 10; i++) { const x = xa + rnd() * w, y = ya + rnd() * h, L = range(rnd, 6, 22), t = rnd() * TAU; line(g, [[x, y], [x + Math.cos(t) * L, y + Math.sin(t) * L * 0.3]], 0.9, '#e8c8a0', 0.35); }
  rect(g, xa, ya, w, h, grad(g, xa, ya, xa + w, yb, [[0, '#fff0d0', 0.22], [0.5, '#fff0d0', 0], [1, '#2c2030', 0.25]]));
  g.restore();
  // the bent corner (lower right) shows the bare backing
  g.save(); g.beginPath(); g.moveTo(xb, yb - 14); g.lineTo(xb, yb); g.lineTo(xb - 16, yb); g.closePath(); g.fillStyle = '#d8c49a'; g.fill(); g.restore();
  g.save(); g.beginPath(); g.moveTo(xb, yb - 14); g.lineTo(xb - 16, yb); g.lineTo(xb - 11, yb - 9); g.closePath(); g.fillStyle = '#7a7480'; g.fill(); g.restore();
  for (const [u, v] of [[6, 6], [w - 6, 6], [6, h - 6], [w / 2, 6], [w / 2, h - 6]]) {
    rivet(g, xa + u, ya + v, 2.8, '#9a9098', 0.45);
    if (rnd() < 0.6) line(g, [[xa + u, ya + v + 3], [xa + u + (rnd() - 0.5) * 2, ya + v + range(rnd, 10, 30)]], 1.8, RUST, 0.35);
  }
}

// Chalk tally marks by the door (days on the road), a little smudged
function chalkTally(g, rnd, X, Y) {
  const t = RV_ART.tally, xa = Math.min(X(t.z0), X(t.z1)), xb = Math.max(X(t.z0), X(t.z1)), ya = Y(t.y1), yb = Y(t.y0);
  const groups = [5, 5, 3], gw = (xb - xa) / 3.1, hh = (yb - ya) * 0.5;
  for (let r = 0; r < 2; r++) for (let gi = 0; gi < groups.length; gi++) {
    const n = r ? (gi === 0 ? 4 : 0) : groups[gi], x0 = xa + gi * gw * 1.05, y0 = ya + r * hh * 1.1;
    for (let k = 0; k < Math.min(4, n); k++) {
      const x = x0 + 3 + k * gw * 0.2 + (rnd() - 0.5) * 1.2;
      line(g, [[x, y0 + 2], [x + (rnd() - 0.5) * 2, y0 + hh * 0.5], [x + (rnd() - 0.5) * 2.5, y0 + hh - 1]], range(rnd, 2.2, 2.8), '#f4f0e4', range(rnd, 0.8, 0.95));
    }
    if (n >= 5) line(g, [[x0, y0 + hh - 3], [x0 + gw * 0.82, y0 + 3]], 2.4, '#f4f0e4', 0.9);
  }
  blob(g, (xa + xb) / 2, (ya + yb) / 2, (xb - xa) * 0.6, (yb - ya) * 0.5, 0, '#f2eee2', 0.08, 0.1);
}

// Front (x: -1.25..1.25 seen from the front, +X on the right) or rear (+X on the left).
function paintEnd(g, rnd, ox, rear) {
  const A = RV_ART, S = BODY.endW, oy = BODY.endY;
  const PX = S / 2.5, PY = S / 3;
  const X = x => ox + (rear ? (1.25 - x) : (x + 1.25)) * PX;
  const Y = y => oy + (A.y1 - y) * PY;
  g.save(); g.beginPath(); g.rect(ox, oy, S, S); g.clip();
  rect(g, ox, oy, S, S, grad(g, 0, Y(2.3), 0, Y(0.9), [[0, '#ead8aa'], [1, '#d4bd8c']]));
  mottleIn(g, rnd, ox, Y(2.3), S, Y(0.9) - Y(2.3), { colors: ['#d6bb86', '#ecdcb4', '#c9b48c'], count: 30, rmin: 10, rmax: 36, alpha: 0.35 });
  // panels: one seam each side of the window
  const xs = rear ? [ox, X(0.95), X(-0.95), ox + S] : [ox, ox + S];
  panels(g, rnd, xs, Y(A.eaveY), Y(A.gold[1]) - 1, { rivR: 2.8, step: [14, 17] });
  rect(g, ox, Y(A.eaveY), S, 0.35 * PY, grad(g, 0, Y(A.eaveY), 0, Y(A.eaveY - 0.35), [[0, '#5a4a62', 0.55], [1, '#5a4a62', 0]]));
  for (let x = ox + 6; x < ox + S; x += range(rnd, 13, 16)) rivet(g, x, Y(2.1), 2.6, '#dcc8a0', 0.4);
  // the window opening's cast shadow
  if (!rear) {
    const sw = A.shield, gw = 0.08 * PX;
    g.save(); rrect(g, X(-sw.x) - gw + 5, Y(sw.y1) - gw + 5, X(sw.x) - X(-sw.x) + gw * 2, Y(sw.y0) - Y(sw.y1) + gw * 2, 8); g.fillStyle = rgba('#4a3a4a', 0.38); g.fill(); g.restore();
  } else {
    const rw = A.rearWin, gw = 0.07 * PX;
    g.save(); rrect(g, X(rw.x) - gw + 5, Y(rw.y1) - gw + 5, X(-rw.x) - X(rw.x) + gw * 2, Y(rw.y0) - Y(rw.y1) + gw * 2, 8); g.fillStyle = rgba('#4a3a4a', 0.38); g.fill(); g.restore();
    for (let i = 0; i < 6; i++) { const x = range(rnd, X(rw.x), X(-rw.x)), y = Y(rw.y0) + 8; line(g, [[x, y], [x + (rnd() - 0.5) * 2, y + range(rnd, 10, 40)]], 2, RUST, 0.3); }
  }
  // (no name on the back: the ladder, the spare and the corner posts would cut it up; the maker's
  // brass crest is bolted on under the spare instead, in rv3d.js)
  livery(g, rnd, ox, ox + S, Y, { chips: 1.6, woodNails: false, woodBand: rear, hot: [ox + 8, ox + S - 8, ox + S / 2] });
  {
    const ya = Y(A.brassLow[0]), yb = Y(A.y0);
    rect(g, ox, ya, S, yb - ya, grad(g, 0, ya, 0, yb, [[0, '#6a6470'], [0.3, SKIRT], [1, '#38323c']]));
    for (let x = ox + 6; x < ox + S; x += range(rnd, 13, 16)) rivet(g, x, ya + 7, 2.6, '#7a7480', 0.5);
    rect(g, ox, ya, S, yb - ya, grad(g, 0, ya, 0, yb, [[0, '#8a7a64', 0], [1, '#9a8a70', 0.55]]));
  }
  if (!rear) {
    g.save(); g.filter = 'blur(3px)'; g.fillStyle = '#2a2228'; rrect(g, X(-0.52), Y(0.6), X(0.52) - X(-0.52), Y(-0.24) - Y(0.6), 8); g.fill(); g.restore();
    for (let i = 0; i < 18; i++) {
      const x = ox + range(rnd, 10, S - 10), y = Y(range(rnd, -0.2, 1.0)), r = range(rnd, 1.2, 2.8);
      blob(g, x, y, r * 2.2, r * 1.6, rnd() * 3, pick(rnd, ['#a8a84a', '#8a904a', '#b89848']), 0.55, 0.5);
      ellipse(g, x, y, r * 0.6, r * 0.5, 0, '#3a2a20', 0.8);
    }
  }
  rect(g, ox, Y(1.0), S, Y(A.y0) - Y(1.0), grad(g, 0, Y(1.0), 0, Y(A.y0), [[0, '#8a7a5e', 0], [1, '#8a7a5e', rear ? 0.35 : 0.2]]));
  rect(g, ox, oy, 12, S, grad(g, ox, 0, ox + 12, 0, [[0, INK, 0.35], [1, INK, 0]]));
  rect(g, ox + S - 12, oy, 12, S, grad(g, ox + S - 12, 0, ox + S, 0, [[0, INK, 0], [1, INK, 0.35]]));
  g.restore();
}

// A fallen leaf: several shapes (oval, oak-lobed, long willow) in several autumn colours.
function leaf(g, x, y, s, rot, c) {
  g.save(); g.translate(x, y); g.rotate(rot);
  blob(g, s * 0.25, s * 0.3, s * 0.9, s * 0.5, 0, INK, 0.3, 0.3);
  g.fillStyle = c; g.beginPath();
  g.moveTo(-s, 0); g.quadraticCurveTo(-s * 0.2, -s * 0.6, s, 0); g.quadraticCurveTo(-s * 0.2, s * 0.6, -s, 0); g.fill();
  line(g, [[-s * 1.1, 0], [s * 0.9, 0]], Math.max(0.6, s * 0.12), shadowOf(c, 0.4), 0.7);
  blob(g, -s * 0.2, -s * 0.18, s * 0.4, s * 0.15, 0, lightOf(c, 0.5), 0.45, 0.3);
  g.restore();
}

register('rv_body', {
  family: F, w: BODY.W, h: BODY.H, note: 'body atlas: right side, left side, front, rear',
  paint(g, s, rnd) {
    fill(g, BODY.W, BODY.H, CREAM);
    paintSide(g, rnd, 'R', BODY.R);
    paintSide(g, rnd, 'L', BODY.L);
    paintEnd(g, rnd, BODY.front, false);
    paintEnd(g, rnd, BODY.rear, true);
    glaze(g, BODY.W, BODY.H, '#ffe2b0', 0.08, 'soft-light');
  },
});

// A crisp three-tone fallen leaf: a soft cast shadow, the dark shaded half, the mid-tone lit half,
// a lit edge along the upper curve and a dark vein.
function leaf3(g, x, y, s, rot, c) {
  g.save(); g.translate(x, y); g.rotate(rot);
  const shape = (dx, dy) => { g.beginPath(); g.moveTo(-s + dx, dy); g.quadraticCurveTo(-s * 0.2 + dx, -s * 0.62 + dy, s + dx, dy); g.quadraticCurveTo(-s * 0.2 + dx, s * 0.62 + dy, -s + dx, dy); };
  g.globalAlpha = 0.3; g.fillStyle = '#2a2026'; shape(s * 0.16, s * 0.2); g.fill();
  g.globalAlpha = 1; g.fillStyle = shadowOf(c, 0.38); shape(0, 0); g.fill();
  g.save(); g.beginPath(); g.rect(-s * 1.2, -s, s * 2.4, s); g.clip(); g.fillStyle = c; shape(0, 0); g.fill(); g.restore();
  g.strokeStyle = lightOf(c, 0.6); g.lineWidth = Math.max(0.8, s * 0.14); g.lineCap = 'round';
  g.beginPath(); g.moveTo(-s * 0.85, -s * 0.06); g.quadraticCurveTo(-s * 0.2, -s * 0.56, s * 0.9, -s * 0.02); g.stroke();
  g.strokeStyle = shadowOf(c, 0.55); g.lineWidth = Math.max(0.6, s * 0.09);
  g.beginPath(); g.moveTo(-s * 1.2, s * 0.02); g.lineTo(s * 0.92, 0); g.stroke();
  g.restore();
}

// Roof tin: its own tiling texture (≈1.5 m a tile, so the roof people walk on is crisp up close).
// u runs along the RV, v across. Weathered plates oil-canned in the light, a tar-sealed lap across
// the roof twice a tile with a lit lip and a soft shadow, rivets at uneven spacing (some missing),
// small rust blooms, airflow streaks along the length, a few crisp leaves and twigs.
register('rv_tin', {
  family: F, size: 512, note: 'roof tin (tiles, ~1.5 m): weathered plates, laps, rivets, rust, leaves',
  paint(g, s, rnd) {
    fill(g, s, s, '#857a66');
    mottle(g, s, rnd, { colors: ['#948872', '#766c5a', '#a09680', '#7a705e', '#6e6a62'], count: 46, rmin: 40, rmax: 120, alpha: 0.36 });
    mottle(g, s, rnd, { colors: ['#a49a82', '#6e6454', '#867a64'], count: 70, rmin: 10, rmax: 30, alpha: 0.24, stretch: 2.6, rot: 0 });
    // two sheets a tile: each oil-canned (lit at its upper-left, shaded toward its far lap)
    const laps = [range(rnd, 6, 30), range(rnd, 250, 290)];
    for (let i = 0; i < 2; i++) {
      const a = laps[i], b = i ? laps[0] + s : laps[1], w = b - a;
      for (const off of [0, -s]) {
        rect(g, a + off, 0, w, s, grad(g, a + off, 0, b + off, 0, [[0, '#fff4d8', 0.3], [0.22, '#fff4d8', 0], [0.68, '#2c2340', 0], [1, '#2c2340', 0.24]]));
        for (let k = 0; k < 4; k++) blob(g, a + off + w * (0.15 + k * 0.23), s * (0.15 + 0.23 * k), w * 0.2, s * 0.16, 0.3, k % 2 ? '#fff0d0' : '#5a4e50', 0.16, 0.15);
      }
    }
    // airflow streaks and rust blooms
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 40, 160), w = range(rnd, 2, 6), c = pick(rnd, ['#6e6250', '#b8ae96', '#7a5a3a']), a = range(rnd, 0.12, 0.22);
      wrap(s, x, y, L, (xx, yy) => line(g, [[xx, yy], [xx + L, yy + (y % 7 - 3.5) * 0.6]], w, c, a));
    }
    for (let i = 0; i < 9; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 4, 11), rot = rnd() * 3;
      wrap(s, x, y, r * 2, (xx, yy) => { blob(g, xx, yy, r * 1.6, r, rot, '#8a4e26', 0.4, 0.35); blob(g, xx - r * 0.25, yy - r * 0.25, r * 0.7, r * 0.45, rot, '#b4703a', 0.4, 0.4); ellipse(g, xx + r * 0.3, yy + r * 0.2, r * 0.25, r * 0.2, 0, '#4a2a1a', 0.5); });
    }
    // tar dabs over old leaks
    for (let i = 0; i < 3; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 7, 14), pts = Array.from({ length: 12 }, (_, k) => { const t = k / 12 * TAU, q = r * range(rnd, 0.55, 1.25); return [Math.cos(t) * q * 1.9, Math.sin(t) * q * 0.8]; });
      wrap(s, x, y, r * 2, (xx, yy) => {
        g.save(); g.beginPath(); pts.forEach(([px, py], k) => k ? g.lineTo(xx + px, yy + py) : g.moveTo(xx + px, yy + py)); g.closePath(); g.fillStyle = rgba('#3a302a', 0.55); g.fill(); g.restore();
        blob(g, xx - r * 0.35, yy - r * 0.3, r * 0.6, r * 0.22, -0.4, '#a8a29a', 0.3, 0.3);
      });
    }
    // the laps: a soft shadow down-sheet, the dark tar seal, a warm lit lip; rivets along them
    for (const x0 of laps) {
      const jag = Array.from({ length: Math.ceil(s / 8) + 1 }, () => (rnd() - 0.5) * 1.6);
      for (const off of [0, s, -s]) {
        const x = x0 + off;
        rect(g, x + 2, 0, 4, s, grad(g, x + 2, 0, x + 6, 0, [[0, '#2c2340', 0.3], [1, '#2c2340', 0]]));
        g.save(); g.beginPath();
        jag.forEach((d, k) => g.lineTo(x - 2 + d, k * 8));
        for (let k = jag.length - 1; k >= 0; k--) g.lineTo(x + 1.5 + jag[k] * 0.5, k * 8);
        g.closePath(); g.fillStyle = rgba('#3e342e', 0.8); g.fill(); g.restore();
        line(g, [[x - 3, 0], [x - 3, s]], 1, '#e8d8b0', 0.55);
      }
      let y = range(rnd, 0, 10);
      const ys = [];
      while (y < s - 6) { ys.push(y); y += 22 * range(rnd, 0.75, 1.25); }
      for (const ry of ys) {
        if (rnd() < 0.12) continue;
        const dx = (rnd() - 0.5) * 1.4, rust = rnd() < 0.2, rl = range(rnd, 6, 14);
        wrap(s, x0 - 9 + dx, ry, 6, (xx, yy) => {
          blob(g, xx + 1.2, yy + 1.5, 3.6, 3.2, 0, '#3e3438', 0.55, 0.35);
          ellipse(g, xx, yy, 2.9, 2.9, 0, '#8a7e6a');
          ellipse(g, xx - 0.4, yy - 0.4, 2.3, 2.3, 0, '#a09480');
          blob(g, xx - 1.0, yy - 1.1, 1.3, 1.1, 0, '#c0b090', 0.95, 0.5);
          if (rust) line(g, [[xx + 1, yy + 2], [xx + rl, yy + 3]], 1.6, RUST, 0.4);
        });
      }
    }
    // a standing seam along the length where the sheets meet across the roof
    for (const y of [0, s]) { line(g, [[0, y - 2], [s, y - 2]], 1.2, '#2c2340', 0.25); line(g, [[0, y + 1], [s, y + 1]], 1, '#e8d8b0', 0.3); }
    // a few crisp leaves and twigs
    for (let i = 0; i < 7; i++) {
      const x = rnd() * s, y = rnd() * s, sz = range(rnd, 4.5, 8), a = rnd() * TAU, c = pick(rnd, ['#a2702a', '#8a6a2a', '#9a4a24', '#6e7e36', '#b88a3a']);
      wrap(s, x, y, sz * 1.6, (xx, yy) => leaf3(g, xx, yy, sz, a, c));
    }
    for (let i = 0; i < 4; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 10, 22), a = rnd() * TAU;
      wrap(s, x, y, L, (xx, yy) => { line(g, [[xx + 1, yy + 1.2], [xx + Math.cos(a) * L + 1, yy + Math.sin(a) * L + 1.2]], 1.6, '#2a2026', 0.3); line(g, [[xx, yy], [xx + Math.cos(a) * L, yy + Math.sin(a) * L]], 1.3, '#5a4028', 0.9); });
    }
    glaze(g, s, s, '#ffe2b0', 0.07, 'soft-light');
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
function bandMottle(b, W, H, rnd, colors, n = 30, alpha = 0.25, rmax = 26, stretch = 2) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * W, y = rnd() * H, r = range(rnd, 6, rmax), c = pick(rnd, colors), a = alpha * range(rnd, 0.5, 1);
    wrapX(W, x, r * stretch, xx => blob(b, xx, y, r * stretch, r * 0.6, 0, c, a, 0.2));
  }
}
function bandLines(b, W, H, rnd, n, { len = [8, 30], ys = [0, 1], w = 1, colors, alpha = 0.3, dy = 2 }) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * W, y = range(rnd, ys[0], ys[1]) * H, L = range(rnd, len[0], len[1]), d = (rnd() - 0.5) * dy, c = pick(rnd, colors), ww = typeof w === 'number' ? w : range(rnd, w[0], w[1]);
    wrapX(W, x, L, xx => line(b, [[xx, y], [xx + L, y + d]], ww, c, alpha));
  }
}
function woodBand(b, W, H, rnd, colors, [l0, l1] = [120, 230]) {
  rect(b, 0, 0, W, H, '#2a2026');
  const ws = [];
  let tot = 0;
  while (tot < W - l0 / 2) { const L = range(rnd, l0, l1); ws.push(L); tot += L; }
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
  family: F, w: TRIM.W, h: TRIM.H, note: 'trim sheet: tiling bands + decal slots',
  paint(g, s, rnd) {
    const W = TRIM.W;
    fill(g, W, TRIM.H, '#5a4a40');
    band(g, TRIM.wood, (b, W, H, r) => woodBand(b, W, H, r, ['#5a3a22', '#4e331e', '#603e27', '#46301c'], [230, 420]), rnd);
    // mid oak (one family with the walnut): no raw pine anywhere
    band(g, TRIM.oak, (b, W, H, r) => { woodBand(b, W, H, r, ['#845a34', '#7a5230', '#8a5e36', '#7e5632']); glaze(b, W, H, '#5a3a22', 0.12, 'multiply'); }, rnd);
    // brass: dark old brass with a thin lit streak, verdigris and tarnish
    band(g, TRIM.brass, (b, W, H, r) => {
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#6e5024'], [0.1, '#c8a45c'], [0.2, '#a8803a'], [0.5, '#9c7632'], [0.82, '#6a4c22'], [1, '#553a1a']]));
      bandMottle(b, W, H, r, ['#b48c44', '#86662c'], 22, 0.3, 26);
      bandMottle(b, W, H, r, ['#6e8c6a'], 16, 0.32, 18, 1.4);
      bandMottle(b, W, H, r, ['#46301a'], 16, 0.3, 16, 1.6);
      bandLines(b, W, H, r, 12, { len: [20, 70], ys: [0.16, 0.24], w: 1.4, colors: ['#f0d896'], alpha: 0.4, dy: 0.5 });
      bandLines(b, W, H, r, 30, { len: [6, 20], ys: [0.1, 0.9], w: 0.8, colors: ['#e0c47c', '#46301a'], alpha: 0.3 });
      glaze(b, W, H, '#6a5030', 0.12, 'multiply');
    }, rnd);
    // iron: blue-gray plate, a row of rivets, rust runs
    band(g, TRIM.iron, (b, W, H, r) => {
      beamShade(b, W, H, '#4c4a56', 0.6);
      bandMottle(b, W, H, r, ['#5a5866', '#3a3844', '#6a4a3a'], 30, 0.3);
      for (let x = 10; x < W; x += 32) { rivet(b, x, 16, 3.2, '#7a7888'); rivet(b, x + 16, H - 16, 3.2, '#7a7888'); }
      for (let i = 0; i < 12; i++) { const x = r() * W, y0 = r() * H * 0.5, d = (r() - 0.5) * 2, y1 = H * range(r, 0.6, 1), w = range(r, 1.5, 3); wrapX(W, x, 10, xx => line(b, [[xx, y0], [xx + d, y1]], w, RUST, 0.25)); }
      bandEdges(b, W, H, '#4c4a56');
    }, rnd);
    // goblin red and goblin green: painted iron, chipped to the metal
    for (const [i, c] of [[TRIM.red, '#8a3a28'], [TRIM.green, '#4e6a38']]) {
      band(g, i, (b, W, H, r) => {
        beamShade(b, W, H, c, 0.55);
        bandMottle(b, W, H, r, [lightOf(c, 0.2), shadowOf(c, 0.2)], 24, 0.3);
        for (let k = 0; k < 18; k++) {
          const x = r() * W, y = r() < 0.75 ? (r() < 0.5 ? range(r, 2, 10) : range(r, H - 10, H - 2)) : r() * H, rr = range(r, 1.5, 4.5), a1 = r(), a2 = r();
          wrapX(W, x, rr * 2, xx => { ellipse(b, xx + 0.8, y + 0.9, rr * 1.3, rr, a1, INK, 0.3); ellipse(b, xx, y, rr * 1.3, rr, a2, '#5c5660', 0.9); blob(b, xx - rr * 0.3, y - rr * 0.3, rr * 0.5, rr * 0.4, 0, '#9a98a4', 0.6, 0.4); });
        }
        for (let x = 14; x < W; x += 48) rivet(b, x, H / 2, 3.6, lightOf(c, 0.1));
        bandEdges(b, W, H, c);
      }, rnd);
    }
    // cream painted metal (matches the body)
    band(g, TRIM.cream, (b, W, H, r) => {
      beamShade(b, W, H, CREAM, 0.45);
      bandMottle(b, W, H, r, ['#d6bb86', '#ecdcb4', '#c9b48c'], 30, 0.3);
      for (let x = 8; x < W; x += 20) rivet(b, x, H - 12, 3, '#dcc8a0', 0.4);
      bandEdges(b, W, H, CREAM);
    }, rnd);
    // tire: warm dark rubber; smooth sidewalls at both edges, chunky staggered lugs on the face
    band(g, TRIM.tread, (b, W, H, r) => {
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#4a4240'], [0.22, '#3e3632'], [0.5, '#342e2c'], [0.78, '#2e2826'], [1, '#3a3432']]));
      const n = 12, bw = W / n;
      for (let i = 0; i < n; i++) {
        for (const [y0, off, sl] of [[17, 0, 4], [33, bw * 0.5, -4]]) {
          wrapX(W, i * bw + off + bw / 2, bw, cx => {
            const L = cx - bw / 2 + 5, R = cx + bw / 2 - 9;
            b.save(); b.beginPath();
            b.moveTo(L + sl, y0); b.lineTo(R + sl, y0); b.lineTo(R - sl, y0 + 14); b.lineTo(L - sl, y0 + 14); b.closePath();
            b.fillStyle = grad(b, 0, y0, 0, y0 + 14, [[0, '#6a5e56'], [0.3, '#4a423e'], [1, '#342e2c']]); b.fill(); b.restore();
            line(b, [[L + sl + 1, y0 + 1], [R + sl - 1, y0 + 1]], 1.6, '#86786c', 0.65);
            line(b, [[L - sl, y0 + 14.5], [R - sl, y0 + 14.5]], 2, '#1e1a1c', 0.5);
          });
        }
      }
      line(b, [[0, 9], [W, 9]], 1.4, '#5a524e', 0.7); line(b, [[0, H - 9], [W, H - 9]], 1.4, '#5a524e', 0.7);
      bandMottle(b, W, H, r, ['#6a5a4a', '#5a4632', '#7a6a58'], 26, 0.3, 14, 1.6);
    }, rnd);
    // the tow strap: orange webbing, stitched edges
    band(g, TRIM.strap, (b, W, H, r) => {
      beamShade(b, W, H, '#e07a2a', 0.5);
      for (let y = 6; y < H - 4; y += 4) line(b, [[0, y], [W, y]], 1, y % 8 ? '#f29a4a' : '#b85a1a', 0.35);
      for (let x = 0; x < W; x += 10) { line(b, [[x, 9], [x + 6, 9]], 1.6, '#fff0d0', 0.7); line(b, [[x + 3, H - 10], [x + 9, H - 10]], 1.6, '#fff0d0', 0.7); }
      bandMottle(b, W, H, r, ['#8a5a3a', '#6a4a3a'], 12, 0.25, 16);
      bandEdges(b, W, H, '#e07a2a');
    }, rnd);
    // gingham: small muted brick checks on oat. u runs down the curtain, v across it; the pleats
    // (PLEATS across v, matching the curtain geometry) bend the check lines into the folds, lit on
    // the ridges, cool in the valleys.
    band(g, TRIM.gingham, (b, W, H, r) => {
      rect(b, 0, 0, W, H, '#d6c6a2');
      const cs = W / 64, csv = H / 8, n = GINGHAM_PLEATS;
      const phase = y => (1 - (y + 0.5) / H) * n * TAU;      // v → pleat phase (ridge at sin = 1)
      // stripes along u (straight down the curtain, across v)
      for (let y = 0; y < H; y++) if (Math.floor(y / csv) % 2 === 0) rect(b, 0, y, W, 1, '#8e4234', 0.42);
      // stripes across u, bent sideways by the pleats
      for (let y = 0; y < H; y++) {
        const sh = Math.sin(phase(y)) * 2.2;
        for (let x = 0; x < W; x += cs * 2) wrapX(W, x + sh, cs, xx => rect(b, xx, y, cs, 1, '#8e4234', 0.42));
      }
      for (let i = 0; i < 50; i++) { const x = r() * W, y = r() * H, a = range(r, 0.05, 0.12); wrapX(W, x, 4, xx => line(b, [[xx, y], [xx + 4, y]], 1, '#4a2a24', a)); }
      // pleat light: lit ridges, cool violet valleys
      for (let y = 0; y < H; y++) {
        const s = Math.sin(phase(y));
        if (s > 0) rect(b, 0, y, W, 1, '#fff0d0', 0.2 * s); else rect(b, 0, y, W, 1, '#5a4050', -0.3 * s);
      }
    }, rnd);
    band(g, TRIM.slate, (b, W, H, r) => {
      beamShade(b, W, H, '#62666e', 0.5);
      bandMottle(b, W, H, r, ['#70747c', '#565a62', '#6a6460'], 40, 0.3);
      for (let i = 0; i < 8; i++) { const x = r() * W, y0 = r() * H, d = range(r, -16, 16), y1 = r() * H; wrapX(W, x, 20, xx => line(b, [[xx, y0], [xx + d, y1]], 0.9, '#3a3c44', 0.4)); }
      bandEdges(b, W, H, '#62666e');
    }, rnd);
    band(g, TRIM.canvas, (b, W, H, r) => {
      beamShade(b, W, H, '#c4ae84', 0.45);
      bandLines(b, W, H, r, 60, { len: [20, 80], ys: [0, 1], w: 1, colors: ['#dcc8a0', '#a08c62'], alpha: 0.25 });
      bandMottle(b, W, H, r, ['#a8946a', '#8a7a5a', '#e0d0a8'], 16, 0.25);
      for (let x = 0; x < W; x += 9) line(b, [[x, H - 9], [x + 5, H - 9]], 1.3, '#6a5a40', 0.55);
    }, rnd);
    // opaque painted window glass: sky tint at the top to dark interior at the bottom, one or two
    // broad soft highlights
    band(g, TRIM.glass, (b, W, H, r) => {
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#9cb8c8'], [0.35, '#5a7484'], [1, '#2e3440']]));
      for (let k = 0; k < 3; k++) {
        const x = range(r, 0, W), w = range(r, 30, 60), a = range(r, 0.15, 0.22);
        wrapX(W, x, 90, xx => { b.save(); b.globalAlpha = a; b.fillStyle = grad(b, xx, 0, xx + w, 0, [[0, '#e8f4f8', 0], [0.5, '#e8f4f8', 1], [1, '#e8f4f8', 0]]); b.beginPath(); b.moveTo(xx, H); b.lineTo(xx + w, H); b.lineTo(xx + w + 26, 0); b.lineTo(xx + 26, 0); b.closePath(); b.fill(); b.restore(); });
      }
      rect(b, 0, 0, W, 4, '#c8dce4', 0.3);
    }, rnd);
    band(g, TRIM.rope, (b, W, H, r) => {
      rect(b, 0, 0, W, H, '#8a6a40');
      for (let x = -H; x < W + H; x += 9) {
        b.save(); b.beginPath(); b.moveTo(x, H); b.lineTo(x + 8, H); b.lineTo(x + 8 + H * 0.6, 0); b.lineTo(x + H * 0.6, 0); b.closePath();
        b.fillStyle = grad(b, x, 0, x + 8, 0, [[0, '#c8a066'], [0.5, '#a07a48'], [1, '#5a4024']]); b.fill(); b.restore();
      }
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#fff0c8', 0.25], [0.5, '#000000', 0], [1, '#2c2340', 0.4]]));
    }, rnd);
    // the awning: muted red and oat stripes (they run around the rolled canvas)
    band(g, TRIM.awning, (b, W, H, r) => {
      const n = 8, sw = W / n;
      for (let i = 0; i < n; i++) rect(b, i * sw, 0, sw, H, i % 2 ? '#c4ac80' : '#8a3a2a');
      for (let i = 0; i < n; i++) rect(b, i * sw, 0, 2, H, '#3a2420', 0.3);
      bandMottle(b, W, H, r, ['#5a3a2a', '#e8d8b0', '#6a4a34'], 26, 0.18, 20);
      bandLines(b, W, H, r, 40, { len: [10, 40], ys: [0, 1], w: 1, colors: ['#3a2a24', '#f0e0c0'], alpha: 0.18 });
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#fff0d0', 0.3], [0.35, '#000000', 0], [1, '#2c2340', 0.45]]));
    }, rnd);
    // burlap sacking: a coarse weave, lumps, a darker seam
    band(g, TRIM.burlap, (b, W, H, r) => {
      beamShade(b, W, H, '#9c8054', 0.5);
      for (let y = 2; y < H; y += 3) line(b, [[0, y], [W, y]], 1, '#6a5434', 0.22);
      for (let x = 1; x < W; x += 3) line(b, [[x, 0], [x, H]], 1, '#c8aa76', 0.12);
      bandMottle(b, W, H, r, ['#b89a64', '#6e5634', '#a8885a'], 30, 0.3, 22);
      for (let x = 0; x < W; x += 8) line(b, [[x, 32], [x + 4, 34]], 1.4, '#4a3a24', 0.5);
    }, rnd);
    // a rolled carpet: a muted navy field, oat borders, a brick lozenge chain, worn and dusty
    band(g, TRIM.carpet, (b, W, H, r) => {
      rect(b, 0, 0, W, H, '#38425a');
      bandMottle(b, W, H, r, ['#2c3448', '#46506a'], 20, 0.3, 22);
      rect(b, 0, 0, W, 9, '#b8a47e'); rect(b, 0, H - 9, W, 9, '#b8a47e');
      rect(b, 0, 9, W, 3, '#7e3e2e'); rect(b, 0, H - 12, W, 3, '#7e3e2e');
      for (let x = 0; x < W; x += 64) {
        b.save(); b.beginPath(); b.moveTo(x + 32, 17); b.lineTo(x + 50, 32); b.lineTo(x + 32, 47); b.lineTo(x + 14, 32); b.closePath(); b.fillStyle = '#7e3e2e'; b.fill();
        b.beginPath(); b.moveTo(x + 32, 24); b.lineTo(x + 41, 32); b.lineTo(x + 32, 40); b.lineTo(x + 23, 32); b.closePath(); b.fillStyle = '#b8a47e'; b.fill(); b.restore();
      }
      for (let i = 0; i < W; i += 4) { line(b, [[i, 2], [i + 2, 7]], 1, '#8a7a5a', 0.35); line(b, [[i, H - 7], [i + 2, H - 2]], 1, '#8a7a5a', 0.35); }
      bandMottle(b, W, H, r, ['#a89878', '#1e2232'], 18, 0.18, 20);
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#fff0d0', 0.2], [0.4, '#000000', 0], [1, '#2c2340', 0.45]]));
    }, rnd);
    // copper sheet: riveted, lit edge, green patina where the water runs
    band(g, TRIM.copper, (b, W, H, r) => {
      beamShade(b, W, H, '#9a5a32', 0.55);
      bandMottle(b, W, H, r, ['#b86e3e', '#7a4424'], 22, 0.3, 24);
      bandMottle(b, W, H, r, ['#5e8a72', '#6e9a80'], 14, 0.35, 18, 1.4);
      for (let x = 12; x < W; x += 36) rivet(b, x, 12, 3, '#c07a46');
      bandEdges(b, W, H, '#9a5a32');
    }, rnd);
    // the roof edge's livery strip: a narrow band painted just above the timber cornice (a few mm
    // on the sides, the brow's 0.12 m lip at the front). Top (v=1) meets the tin: a dark edge, the
    // gold pinstripe, the orange, the brown at the bottom. Broad sun-faded patches, no specks.
    band(g, TRIM.roofedge, (b, W, H, r) => {
      const Y = t => t * H;
      rect(b, 0, 0, W, Y(0.08), '#3e3230');
      rect(b, 0, Y(0.08), W, Y(0.14), grad(b, 0, Y(0.08), 0, Y(0.22), [[0, '#f0d488'], [0.5, GOLD], [1, '#8a5e26']]));
      rect(b, 0, Y(0.22), W, 2, INK, 0.35);
      rect(b, 0, Y(0.22), W, Y(0.5), grad(b, 0, Y(0.22), 0, Y(0.72), [[0, '#e08850'], [0.4, ORANGE], [1, '#94461c']]));
      rect(b, 0, Y(0.72), W, Y(0.28), grad(b, 0, Y(0.72), 0, H, [[0, '#7e5234'], [0.4, BROWN], [1, '#3e2416']]));
      bandMottle(b, W, H, r, ['#d8844a', '#a85424'], 16, 0.25, 22, 3);
      for (let k = 0; k < 3; k++) { const x = r() * W, rx = range(r, 40, 70), a = range(r, 0.12, 0.18); wrapX(W, x, rx, xx => blob(b, xx, Y(0.46), rx, rx / 4, 0, '#e8a870', a, 0.15)); }
      for (let k = 0; k < 4; k++) { const x = r() * W, y = Y(r() < 0.5 ? range(r, 0.24, 0.3) : range(r, 0.66, 0.72)), rs = range(r, 2, 3.2), sd = 1 + Math.floor(r() * 1e9); wrapX(W, x, 14, xx => chip(b, lcg(sd), xx, y, rs)); }
    }, rnd);
    // hay: straw strands along u, gaps, a twine
    band(g, TRIM.hay, (b, W, H, r) => {
      rect(b, 0, 0, W, H, '#b8964a');
      for (let i = 0; i < 260; i++) {
        const x = r() * W, y = r() * H, L = range(r, 10, 40), d = (r() - 0.5) * 6, c = pick(r, ['#e2c46a', '#c8a650', '#8a6a2a', '#f0d888', '#a07e36']), w = range(r, 1, 2.4), a = range(r, 0.5, 0.9);
        wrapX(W, x, L, xx => line(b, [[xx, y], [xx + L, y + d]], w, c, a));
      }
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#fff0c0', 0.25], [0.4, '#000000', 0], [1, '#3a2a30', 0.4]]));
    }, rnd);
    // bone: bleached, cracked, cool in the hollows
    band(g, TRIM.bone, (b, W, H, r) => {
      beamShade(b, W, H, '#d8ccb0', 0.5);
      bandMottle(b, W, H, r, ['#e8dcc0', '#b8ac94', '#c8b896'], 24, 0.35, 20);
      bandLines(b, W, H, r, 10, { len: [6, 20], ys: [0.2, 0.8], w: 1, colors: ['#6a5a50'], alpha: 0.5, dy: 6 });
    }, rnd);
    // leaves: a dense painted clump (sprigs, the meadow day's greenery)
    band(g, TRIM.leaf, (b, W, H, r) => {
      rect(b, 0, 0, W, H, '#3e5a26');
      for (let i = 0; i < 120; i++) {
        const x = r() * W, y = r() * H, s = range(r, 4, 9), a = r() * TAU, c = pick(r, ['#5a7e30', '#6e9438', '#4a6a2a', '#86a444', '#3a5424']);
        wrapX(W, x, s * 1.5, xx => leaf(b, xx, y, s, a, c));
      }
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#fff0c0', 0.2], [0.5, '#000000', 0], [1, '#1a2a30', 0.4]]));
    }, rnd);
    // sand drifts: pale with soft ripple shadows
    band(g, TRIM.sand, (b, W, H, r) => {
      beamShade(b, W, H, '#d8b67e', 0.45);
      for (let i = 0; i < 40; i++) { const x = r() * W, y = r() * H, L = range(r, 20, 60), w = range(r, 1.5, 3); wrapX(W, x, L, xx => { line(b, [[xx, y], [xx + L, y + 2]], w, '#a8845a', 0.35); line(b, [[xx, y - 2], [xx + L, y]], 1, '#f2dcae', 0.4); }); }
      bandMottle(b, W, H, r, ['#e8cc96', '#c79c62'], 20, 0.3);
    }, rnd);
    // soot: sooty dark iron (the chimney's crown)
    band(g, TRIM.soot, (b, W, H, r) => {
      beamShade(b, W, H, '#3a2c26', 0.45);
      bandMottle(b, W, H, r, ['#241c1c', '#4a3a30', '#5a4234'], 30, 0.4);
      bandEdges(b, W, H, '#3a2c26');
    }, rnd);
    // leather straps: brown, stitched both edges
    band(g, TRIM.leather, (b, W, H, r) => {
      beamShade(b, W, H, '#6a4228', 0.5);
      bandMottle(b, W, H, r, ['#7a5032', '#4e2e1c'], 20, 0.3);
      for (let x = 0; x < W; x += 8) { line(b, [[x, 8], [x + 4, 8]], 1.2, '#d8c49a', 0.6); line(b, [[x + 2, H - 8], [x + 6, H - 8]], 1.2, '#d8c49a', 0.6); }
      bandEdges(b, W, H, '#6a4228');
    }, rnd);
    // butcher block: four glued strips along u, staggered end joints, lit strip tops, knife scores
    band(g, TRIM.block, (b, W, H, r) => {
      rect(b, 0, 0, W, H, '#2a1c16');
      const tones = ['#8e6038', '#a0703e', '#7a5030', '#946640'];
      for (let k = 0; k < 4; k++) {
        const ls = []; let tot = 0;
        while (tot < W - 50) { const L = range(r, 90, 190); ls.push(L); tot += L; }
        const sc = W / tot; let x = r() * W;
        for (const L0 of ls) {
          const L = L0 * sc, c = jitter(tones[(k + Math.floor(r() * 2)) % 4], r, 0.05);
          const cv = makeCanvas(Math.ceil(L) + 2, 16), pb = cv.getContext('2d');
          plank(pb, 0, 0, L - 1, 15, c, r, { grain: 5, knots: 0.15, light: 0.55, bevel: 2, nails: 0, endShade: 0.3, splits: 0.08 });
          wrapX(W, (x + L / 2) % W, L / 2 + 2, xx => b.drawImage(cv, xx - L / 2, k * 16));
          x += L;
        }
      }
      for (let i = 0; i < 26; i++) { const x = r() * W, y = r() * H, L = range(r, 6, 22), a = (r() - 0.5) * 0.8; wrapX(W, x, L, xx => line(b, [[xx, y], [xx + Math.cos(a) * L, y + Math.sin(a) * L]], 0.8, '#3a2418', 0.45)); }
      bandMottle(b, W, H, r, ['#4a2e1c', '#c08a50'], 14, 0.15, 24);
    }, rnd);
    // the pennant: faded brick cloth, a painted goblin crest, fold shading, a frayed darker tail;
    // then a rolled carpet's spiral end
    band(g, TRIM.flag, (b, W, H, r) => {
      const [c0, c1] = TRIM.flagPx.cloth, L = c1 - c0;
      rect(b, c0, 0, L, H, grad(b, c0, 0, c1, 0, [[0, '#9a4a38'], [0.6, '#8a3e30'], [1, '#5e2a22']]));
      mottleIn(b, r, c0, 0, L, H, { colors: ['#a85a44', '#7a3428', '#b8806a'], count: 26, rmin: 6, rmax: 22, alpha: 0.3, stretch: 2 });
      for (let x = c0; x < c1; x++) { const s = Math.sin((x - c0) / L * 5.5 * TAU); rect(b, x, 0, 1, H, s > 0 ? '#ffe8c8' : '#3a2230', Math.abs(s) * (s > 0 ? 0.14 : 0.22)); }
      rect(b, c0, 0, 12, H, grad(b, c0, 0, c0 + 12, 0, [[0, '#4a2018'], [1, '#6a2e22']]));
      for (let y = 4; y < H; y += 7) line(b, [[c0 + 13, y], [c0 + 13, y + 4]], 1.2, '#d8c49a', 0.7);
      cog(b, c0 + L * 0.34, H / 2, H * 0.32, 'G');
      for (let i = 0; i < 40; i++) { const y = r() * H, x = c1 - range(r, 0, 26); line(b, [[x, y], [c1, y + (r() - 0.5) * 3]], range(r, 0.8, 1.6), '#3a1a16', range(r, 0.3, 0.6)); }
      rect(b, c0, 0, L, 3, '#ffe8c8', 0.25); rect(b, c0, H - 3, L, 3, '#2a1820', 0.35);
      const [e0, e1] = TRIM.flagPx.carpetEnd, cx = (e0 + e1) / 2, cy = H / 2;
      rect(b, e0, 0, e1 - e0, H, '#2a2430');
      ellipse(b, cx, cy, 30, 30, 0, '#38425a');
      b.save(); b.beginPath();
      for (let t = 0; t < 7 * TAU; t += 0.1) { const rr = 1.5 + t * 0.62; b.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr); }
      b.lineWidth = 2.4; b.strokeStyle = '#b8a47e'; b.stroke(); b.restore();
      b.save(); b.beginPath();
      for (let t = 0.5; t < 7 * TAU; t += 0.1) { const rr = 1.5 + t * 0.62 + 1.6; b.lineTo(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr); }
      b.lineWidth = 1.2; b.strokeStyle = '#7e3e2e'; b.stroke(); b.restore();
      blob(b, cx + 8, cy + 9, 22, 18, 0, '#1a1622', 0.4, 0.2);
      blob(b, cx - 9, cy - 10, 12, 8, -0.6, '#fff0d0', 0.18, 0.3);
    }, rnd);
    // the corner posts: one continuous walnut grain the whole height (u: bottom → top), lit on one
    // side and cool on the other, two iron bands at uneven heights
    band(g, TRIM.post, (b, W, H, r) => {
      rect(b, 0, 0, W, H, grad(b, 0, 0, 0, H, [[0, '#7a5232'], [0.25, '#6a4428'], [0.6, '#56361f'], [1, '#2e2028']]));
      bandMottle(b, W, H, r, ['#6e4a2c', '#4a2e1a', '#7e5634'], 24, 0.3, 40, 3);
      for (let i = 0; i < 16; i++) {
        const y0 = range(r, 4, H - 4), amp = range(r, 0.6, 2.4), fr = Math.round(range(r, 1, 3)), ph = r() * TAU, c = r() < 0.65 ? '#2e1c12' : '#9a6c42', a = range(r, 0.25, 0.5), w = range(r, 0.7, 1.5);
        const pts = []; for (let k = 0; k <= 32; k++) { const t = k / 32; pts.push([t * W, y0 + Math.sin(t * fr * TAU + ph) * amp]); }
        line(b, pts, w, c, a);
      }
      for (let i = 0; i < 2; i++) { const x = range(r, 40, W - 40), y = range(r, 18, H - 18); ellipse(b, x, y, 9, 4, 0, '#2e1c12', 0.6); blob(b, x + 2, y + 1, 4, 2, 0, '#9a6c42', 0.4, 0.4); }
      for (const [x0, w0] of [[range(r, 120, 190), range(r, 12, 16)], [range(r, 330, 430), range(r, 12, 16)]]) {
        rect(b, x0 - 3, 0, w0 + 6, H, '#1e1418', 0.35);
        rect(b, x0, 0, w0, H, grad(b, x0, 0, x0 + w0, 0, [[0, '#7a7888'], [0.3, '#5a5866'], [1, '#34323c']]));
        rect(b, x0, 0, w0, H, grad(b, 0, 0, 0, H, [[0, '#fff0d0', 0.2], [0.5, '#000000', 0], [1, '#2c2340', 0.4]]));
        for (const y of [12, 32, 52]) rivet(b, x0 + w0 / 2, y, 2.6, '#8a8896', 0.5);
        line(b, [[x0 + w0 / 2, 56], [x0 + w0 / 2 - range(r, 10, 26), 58]], 1.8, RUST, 0.3);
      }
      rect(b, 0, 0, W, 3, '#c89a68', 0.4);
    }, rnd);
    paintSlots(g, rnd);
    paintSlots2(g, rnd);
    paintBoard(g, rnd);
  },
});

// The brow's destination board (band 28, 512×64 = the whole 1.5 × 0.19 m board): a walnut plank
// in a darker frame, iron corner brackets, SLOPMASTER 9000 sign-painted in cream with an umber outline.
function paintBoard(g, rnd) {
  const y0 = TRIM.board * TRIM.band, W = TRIM.W, H = TRIM.band;
  rect(g, 0, y0, W, H, '#24160e');
  const cv = makeCanvas(W, H), b = cv.getContext('2d');
  plank(b, 3, 3, W - 6, H - 6, '#5e3c24', rnd, { grain: 14, knots: 0.7, light: 0.5, bevel: 3, nails: 0, endShade: 0.25, splits: 0.4 });
  g.drawImage(cv, 0, y0);
  g.save(); rrect(g, 7, y0 + 7, W - 14, H - 14, 4); g.lineWidth = 1.6; g.strokeStyle = rgba('#c8a070', 0.35); g.stroke(); g.restore();
  handLetter(g, 'SLOPMASTER 9000', W / 2, y0 + H / 2 + 1, W - 84, 29, rnd, { top: '#fbf0d4', bot: '#d4bc8c', under: '#8a6c46', outline: '#22140e', hi: '#ffffff', outlineW: 0.17, chips: 2, tilt: 0.03, bob: 0.04, wobble: 0.5, shadow: 0.55 });
  // iron corner brackets
  for (const [sx, sy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    const x = sx ? W - 2 : 2, y = y0 + (sy ? H - 2 : 2), dx = sx ? -1 : 1, dy = sy ? -1 : 1;
    g.save(); g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx * 30, y); g.lineTo(x + dx * 30, y + dy * 8); g.lineTo(x + dx * 8, y + dy * 8); g.lineTo(x + dx * 8, y + dy * 24); g.lineTo(x, y + dy * 24); g.closePath();
    g.fillStyle = '#4c4a56'; g.fill(); g.lineWidth = 1.2; g.strokeStyle = rgba('#1e1820', 0.7); g.stroke(); g.restore();
    line(g, [[x + dx * 1, y + dy * 1], [x + dx * 29, y + dy * 1]], 1, '#9a98a8', 0.7);
    rivet(g, x + dx * 4.5, y + dy * 4.5, 2.4, '#8a8896', 0.5); rivet(g, x + dx * 22, y + dy * 4.5, 2.2, '#8a8896', 0.5); rivet(g, x + dx * 4.5, y + dy * 18, 2.2, '#8a8896', 0.5);
  }
  rect(g, 0, y0 + H - 6, W, 6, grad(g, 0, y0 + H - 6, 0, y0 + H, [[0, INK, 0], [1, INK, 0.45]]));
}

// decal slots (band 14: 64² each; band 15: 128×64 each)
function paintSlots(g, rnd) {
  const y = TRIM.slots * TRIM.band, S = 64;
  const at = i => i * S;
  rect(g, 0, y, TRIM.W, S * 2, '#3a3036');
  // hub: an iron rim ring, muted red spokes on dark, a brass centre cap, mud on the lower half
  {
    const cx = at(TRIM.s.hub) + 32, cy = y + 32;
    rect(g, at(TRIM.s.hub), y, S, S, '#3a3236');
    g.save(); g.beginPath(); g.arc(cx, cy, 31, 0, TAU); g.fillStyle = grad(g, cx - 30, cy - 30, cx + 30, cy + 30, [[0, '#7a7884'], [0.5, '#4c4a56'], [1, '#2e2c36']]); g.fill(); g.restore();
    g.save(); g.beginPath(); g.arc(cx, cy, 26, 0, TAU); g.fillStyle = grad(g, cx - 26, cy - 26, cx + 26, cy + 26, [[0, '#a8503a'], [0.5, '#8a3a28'], [1, '#4e1e16']]); g.fill(); g.restore();
    g.save(); g.beginPath(); g.arc(cx, cy, 21, 0, TAU); g.fillStyle = '#2a2026'; g.fill(); g.restore();
    for (let k = 0; k < 6; k++) {
      const a = k / 6 * TAU + 0.3;
      stroke(g, [[cx + Math.cos(a) * 6, cy + Math.sin(a) * 6], [cx + Math.cos(a) * 22, cy + Math.sin(a) * 22]], 7, 5, '#8a3a28');
      line(g, [[cx + Math.cos(a) * 7 - 1, cy + Math.sin(a) * 7 - 1.5], [cx + Math.cos(a) * 21 - 1, cy + Math.sin(a) * 21 - 1.5]], 1.4, '#c87a5a', 0.5);
    }
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; rivet(g, cx + Math.cos(a) * 28.5, cy + Math.sin(a) * 28.5, 1.5, '#8a8894', 0.3); }
    g.save(); g.beginPath(); g.arc(cx, cy, 10, 0, TAU); g.fillStyle = grad(g, cx - 10, cy - 10, cx + 10, cy + 10, [[0, '#e0c47c'], [0.5, '#a07a36'], [1, '#553a1a']]); g.fill(); g.restore();
    blob(g, cx + 3, cy + 3, 4, 3, 0, '#6e8c6a', 0.4, 0.3);
    for (let i = 0; i < 14; i++) { const a = range(rnd, 0.3, Math.PI - 0.3), d = range(rnd, 14, 30); blob(g, cx + Math.cos(a) * d, cy + Math.sin(a) * d, range(rnd, 2, 6), range(rnd, 1.5, 4), a, pick(rnd, ['#5a4632', '#6a5440']), range(rnd, 0.3, 0.6), 0.4); }
    blob(g, cx - 12, cy - 14, 9, 4, -0.7, '#fff0d0', 0.25, 0.3);
  }
  // gauges: cream faces, brass bezels, a needle
  for (const [i, lbl, ang] of [[TRIM.s.gauge, 'MPH', -0.6], [TRIM.s.fuel, 'E   F', -2.4]]) {
    const cx = at(i) + 32, cy = y + 32;
    g.save(); g.beginPath(); g.arc(cx, cy, 31, 0, TAU); g.fillStyle = grad(g, cx - 30, cy - 30, cx + 30, cy + 30, [[0, '#e0c47c'], [0.5, '#a07a36'], [1, '#4a3418']]); g.fill(); g.restore();
    g.save(); g.beginPath(); g.arc(cx, cy, 25, 0, TAU); g.fillStyle = grad(g, cx - 20, cy - 25, cx + 20, cy + 25, [[0, '#f2e6c8'], [1, '#c4b48c']]); g.fill(); g.restore();
    for (let k = 0; k <= 10; k++) { const a = Math.PI * 0.75 + k / 10 * Math.PI * 1.5; line(g, [[cx + Math.cos(a) * 18, cy + Math.sin(a) * 18], [cx + Math.cos(a) * 23, cy + Math.sin(a) * 23]], k % 5 ? 1 : 2, '#3a2a20', 0.85); }
    if (i === TRIM.s.fuel) { g.save(); g.beginPath(); g.arc(cx, cy, 20, Math.PI * 0.75, Math.PI * 1.0); g.lineWidth = 4; g.strokeStyle = '#a8402a'; g.stroke(); g.restore(); }
    g.save(); g.font = `bold 8px ${SERIF}`; g.textAlign = 'center'; g.fillStyle = '#4a3020'; g.fillText(lbl, cx, cy + 14); g.restore();
    stroke(g, [[cx, cy], [cx + Math.cos(ang) * 20, cy + Math.sin(ang) * 20]], 2.6, 1, '#982a1a');
    ellipse(g, cx, cy, 3.2, 3.2, 0, '#3a2a20');
    blob(g, cx - 10, cy - 12, 12, 5, -0.6, '#ffffff', 0.3, 0.3);
  }
  // frosted porthole glass
  {
    const x0 = at(TRIM.s.frost);
    rect(g, x0, y, S, S, grad(g, x0, y, x0 + S, y + S, [[0, '#dce8ec'], [0.5, '#b0c4cc'], [1, '#849ca8']]));
    for (let k = 0; k < 14; k++) blob(g, x0 + rnd() * S, y + rnd() * S, range(rnd, 5, 14), range(rnd, 4, 10), rnd() * 3, pick(rnd, ['#f4f8f8', '#a0b4bc']), 0.35, 0.2);
  }
  cog(g, at(TRIM.s.emblem) + 32, y + 32, 29);
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
    g.save(); g.beginPath(); g.arc(cx, cy, 31, 0, TAU); g.fillStyle = grad(g, cx - 30, cy - 30, cx + 30, cy + 30, [[0, '#e0c47c'], [1, '#553a1a']]); g.fill(); g.restore();
    ellipse(g, cx, cy, 26, 26, 0, '#efe2c4');
    for (let k = 0; k < 12; k++) { const a = k / 12 * TAU; ellipse(g, cx + Math.cos(a) * 21, cy + Math.sin(a) * 21, 1.6, 1.6, 0, '#3a2a20'); }
    stroke(g, [[cx, cy], [cx + 12, cy - 6]], 2.6, 1.2, '#3a2a20'); stroke(g, [[cx, cy], [cx - 3, cy - 18]], 2, 1, '#3a2a20');
  }
  // an apple
  {
    const x0 = at(TRIM.s.apple);
    rect(g, x0, y, S, S, grad(g, x0, y, x0 + S, y + S, [[0, '#d86a4a'], [0.5, '#a8342a'], [1, '#5a1a1a']]));
    blob(g, x0 + 20, y + 18, 12, 8, -0.6, '#ffd8a0', 0.5, 0.3);
    blob(g, x0 + 44, y + 44, 14, 10, 0, '#d8a048', 0.3, 0.3);
  }
  // wide slots
  const y2 = TRIM.wide * TRIM.band, WW = 128;
  const atw = i => i * WW;
  // the plate: a riveted brass plate, hand-painted letters
  {
    const x0 = atw(TRIM.w.plate);
    rect(g, x0, y2, WW, S, grad(g, 0, y2, 0, y2 + S, [[0, '#d8bc72'], [0.5, '#a07a36'], [1, '#5a3c1a']]));
    bandlessMottle(g, rnd, x0, y2, WW, S, ['#6e8c6a', '#46301a'], 8, 0.3);
    g.save(); rrect(g, x0 + 5, y2 + 5, WW - 10, S - 10, 5); g.lineWidth = 2.5; g.strokeStyle = '#4a2e14'; g.stroke(); g.restore();
    handLetter(g, 'SLOP 9K', x0 + WW / 2, y2 + 27, WW - 26, 20, rnd, { top: '#4a6a8a', bot: '#1c2c44', under: '#121a2a', outline: '#e8d6a6', hi: '#a8c8e0', chips: 1, tilt: 0.02, wobble: 0.4, shadow: 0.3 });
    g.save(); g.font = `bold 8px ${SERIF}`; g.textAlign = 'center'; g.fillStyle = '#4a2e14'; g.fillText('GADGETZAN TRADE PERMIT', x0 + WW / 2, y2 + 52); g.restore();
    for (const [u, v] of [[10, 10], [WW - 10, 10], [10, S - 10], [WW - 10, S - 10]]) rivet(g, x0 + u, y2 + v, 2.6, '#8a6a3a');
  }
  // the slogan board: a painted wooden plank
  {
    const x0 = atw(TRIM.w.sticker);
    plank(g, x0 + 2, y2 + 6, WW - 4, S - 12, '#7a4e2c', rnd, { grain: 8, knots: 0, light: 0.5, nails: 4 });
    handLetter(g, 'NO MONEY DOWN', x0 + WW / 2, y2 + 32, WW - 18, 17, rnd, { chips: 1, wobble: 0.4, outlineW: 0.16 });
  }
  // radio face: brass grille, a dial, two knobs
  {
    const x0 = atw(TRIM.w.radio);
    rect(g, x0, y2, WW, S, grad(g, 0, y2, 0, y2 + S, [[0, '#6a4428'], [1, '#3a2418']]));
    rect(g, x0 + 6, y2 + 6, 56, S - 12, grad(g, 0, y2, 0, y2 + S, [[0, '#c8a45c'], [1, '#6e4f24']]));
    for (let yy = y2 + 10; yy < y2 + S - 10; yy += 5) line(g, [[x0 + 9, yy], [x0 + 59, yy]], 2, '#3a2412', 0.8);
    rect(g, x0 + 68, y2 + 10, 52, 22, '#e6d4a4');
    for (let k = 0; k < 9; k++) line(g, [[x0 + 72 + k * 5.5, y2 + 14], [x0 + 72 + k * 5.5, y2 + (k % 2 ? 18 : 22)]], 1, '#4a3020');
    line(g, [[x0 + 95, y2 + 11], [x0 + 95, y2 + 31]], 2, '#a8302a');
    for (const kx of [80, 108]) { ellipse(g, kx + x0, y2 + 46, 8, 8, 0, '#2a1a14'); ellipse(g, kx + x0 - 1, y2 + 45, 6, 6, 0, '#a07a36'); blob(g, kx + x0 - 3, y2 + 42, 3, 2, 0, '#fff0c0', 0.7, 0.4); }
  }
  // brass maker's plaque
  {
    const x0 = atw(TRIM.w.plaque);
    rect(g, x0, y2, WW, S, grad(g, 0, y2, 0, y2 + S, [[0, '#d8bc72'], [0.5, '#a07a36'], [1, '#553a1a']]));
    bandlessMottle(g, rnd, x0, y2, WW, S, ['#6e8c6a', '#46301a'], 8, 0.3);
    g.save(); rrect(g, x0 + 4, y2 + 4, WW - 8, S - 8, 6); g.lineWidth = 2; g.strokeStyle = '#4a2c10'; g.stroke(); g.restore();
    g.save(); g.textAlign = 'center'; g.fillStyle = '#3a2410'; g.font = `900 16px ${LETTER_FONT}`; g.fillText('SLOPMASTER', x0 + WW / 2, y2 + 28);
    g.font = `900 12px ${LETTER_FONT}`; g.fillText('~ 9000 ~', x0 + WW / 2, y2 + 46); g.restore();
    for (const [u, v] of [[9, 9], [WW - 9, 9], [9, S - 9], [WW - 9, S - 9]]) rivet(g, x0 + u, y2 + v, 2.2, '#8a6a3a');
  }
}
function bandlessMottle(g, rnd, x, y, w, h, colors, n, a) { for (let i = 0; i < n; i++) blob(g, x + rnd() * w, y + rnd() * h, range(rnd, 4, 12), range(rnd, 3, 8), rnd() * 3, pick(rnd, colors), a, 0.3); }

// more decal slots (band 27): a horned skull's face, a fan grille, porthole glass, wildflowers,
// a lens, a rolled map end, a goblin crest, a mud splat
function paintSlots2(g, rnd) {
  const y = TRIM.slots2 * TRIM.band, S = 64;
  const at = i => i * S;
  rect(g, 0, y, TRIM.W, S * 2, '#3a3036');
  // skull: a bleached cow skull seen face-on, deep eye sockets, nostrils
  {
    const x0 = at(TRIM.s2.skull), cx = x0 + 32;
    rect(g, x0, y, S, S, grad(g, x0, y, x0 + S, y + S, [[0, '#ece0c4'], [0.6, '#cfc2a4'], [1, '#9a8c74']]));
    mottleIn(g, rnd, x0, y, S, S, { colors: ['#b8ac94', '#f4ead2'], count: 10, rmin: 4, rmax: 12, alpha: 0.35 });
    for (const sx of [-1, 1]) { blob(g, cx + sx * 14, y + 24, 9, 8, 0, '#2a2026', 0.95, 0.6); blob(g, cx + sx * 13, y + 22, 4, 3, 0, '#5a4a40', 0.6, 0.4); }
    for (const sx of [-1, 1]) blob(g, cx + sx * 4, y + 52, 3, 4.5, 0, '#3a2a26', 0.9, 0.6);
    line(g, [[cx, y + 8], [cx + 2, y + 18], [cx - 1, y + 30]], 1, '#6a5a50', 0.6);
    blob(g, cx - 10, y + 10, 10, 5, -0.4, '#fffaf0', 0.5, 0.3);
  }
  // fan grille: a round iron grille over three brass blades
  {
    const x0 = at(TRIM.s2.fan), cx = x0 + 32, cy = y + 32;
    rect(g, x0, y, S, S, '#3a3840');
    ellipse(g, cx, cy, 30, 30, 0, '#26242a');
    for (let k = 0; k < 3; k++) { const a = k / 3 * TAU; g.save(); g.translate(cx, cy); g.rotate(a); g.fillStyle = grad(g, 0, -6, 0, 6, [[0, '#c8a45c'], [1, '#6e4f24']]); g.beginPath(); g.ellipse(14, 0, 14, 7, 0.4, 0, TAU); g.fill(); g.restore(); }
    for (let r = 8; r < 30; r += 6) { g.save(); g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.lineWidth = 2; g.strokeStyle = '#6a6874'; g.stroke(); g.restore(); }
    line(g, [[cx - 29, cy], [cx + 29, cy]], 2.5, '#6a6874'); line(g, [[cx, cy - 29], [cx, cy + 29]], 2.5, '#6a6874');
    ellipse(g, cx, cy, 5, 5, 0, '#a07a36');
    blob(g, cx - 12, cy - 14, 10, 4, -0.6, '#c8c4d0', 0.35, 0.3);
  }
  // dark porthole glass with a sky glint
  {
    const x0 = at(TRIM.s2.port);
    rect(g, x0, y, S, S, grad(g, x0, y, x0, y + S, [[0, '#8aa8b8'], [0.5, '#3e5260'], [1, '#22282e']]));
    blob(g, x0 + 22, y + 18, 14, 6, -0.6, '#e0f0f4', 0.35, 0.3);
  }
  // wildflowers: a little bunch seen from the front
  {
    const x0 = at(TRIM.s2.flowers);
    rect(g, x0, y, S, S, '#3e5a26');
    for (let i = 0; i < 26; i++) leaf(g, x0 + rnd() * S, y + rnd() * S, range(rnd, 3, 6), rnd() * TAU, pick(rnd, ['#5a7e30', '#6e9438', '#4a6a2a']));
    for (let i = 0; i < 9; i++) { const fx = x0 + range(rnd, 8, S - 8), fy = y + range(rnd, 8, S - 8), c = pick(rnd, ['#e8d8f0', '#f0d860', '#c87ab0', '#f4f0e0']); for (let p = 0; p < 5; p++) { const a = p / 5 * TAU; ellipse(g, fx + Math.cos(a) * 3, fy + Math.sin(a) * 3, 2.4, 2.4, 0, c); } ellipse(g, fx, fy, 1.6, 1.6, 0, '#c8973e'); }
  }
  // a plain warm lens (lantern glass seen from the side, by day)
  {
    const x0 = at(TRIM.s2.lens);
    rect(g, x0, y, S, S, grad(g, x0, y, x0, y + S, [[0, '#6a4a2a'], [0.3, '#d8a050'], [0.7, '#e8c070'], [1, '#a87030']]));
    blob(g, x0 + 20, y + 22, 8, 14, 0, '#fff0c0', 0.5, 0.3);
  }
  // a rolled map's end: spiralled parchment
  {
    const x0 = at(TRIM.s2.map), cx = x0 + 32, cy = y + 32;
    rect(g, x0, y, S, S, '#3a3036');
    ellipse(g, cx, cy, 28, 28, 0, '#d8c494');
    for (let r = 4; r < 28; r += 4) { g.save(); g.beginPath(); g.arc(cx + 1, cy + 1, r, 0, TAU); g.lineWidth = 1.4; g.strokeStyle = rgba('#8a7048', 0.7); g.stroke(); g.restore(); }
  }
  // the goblin crest: a red shield with a gold cog (pennant, awning badge)
  {
    const x0 = at(TRIM.s2.crest), cx = x0 + 32;
    rect(g, x0, y, S, S, '#8a3a28');
    rect(g, x0, y, S, S, grad(g, x0, y, x0 + S, y + S, [[0, '#fff0d0', 0.25], [0.5, '#000000', 0], [1, '#2c2340', 0.35]]));
    cog(g, cx, y + 32, 18, 'G');
  }
  // mud splat
  {
    const x0 = at(TRIM.s2.mud);
    rect(g, x0, y, S, S, '#5a4632');
    mottleIn(g, rnd, x0, y, S, S, { colors: ['#6a5440', '#4a3a2a', '#7a6248'], count: 14, rmin: 4, rmax: 14, alpha: 0.6 });
  }
}

// ---- interior ------------------------------------------------------------------------------------

// Walls: cream plaster between dark timber studs (an inn room, half-timbered) over a walnut wainscot
// of uneven boards. u tiles along the wall (3.2 m per tile); v runs floor (bottom) → ceiling (top).
register('rv_paneling', {
  family: F, w: 1024, h: 512, note: 'interior walls: plaster and studs over a walnut wainscot (tiles along u)',
  paint(g, W, rnd, H) {
    const py = m => H * (1 - m / 2.3);                // height above the floor → px
    const yCrown = py(2.22), yRail = py(0.92), yBase = py(0.12);
    fill(g, W, H, '#2a2026');
    // plaster
    rect(g, 0, yCrown, W, yRail - yCrown, grad(g, 0, yCrown, 0, yRail, [[0, '#dccaa0'], [0.6, '#d8c49a'], [1, '#c8b48a']]));
    mottle(g, W, rnd, { colors: ['#e4d2a8', '#cbb48a', '#d0bc98', '#c4b08e'], count: 60, rmin: 20, rmax: 70, alpha: 0.3 });
    rect(g, 0, yRail, W, H - yRail, '#2a2026');
    for (let i = 0; i < 14; i++) {
      const x = rnd() * W, y = range(rnd, yCrown + 20, yRail - 20), pts = [[x, y]];
      for (let k = 0; k < 5; k++) { const [px, pyy] = pts[pts.length - 1]; pts.push([px + range(rnd, -8, 8), pyy + range(rnd, 4, 12)]); }
      wrap(W, x, y, 50, (xx, yy) => { if (Math.abs(yy - y) < 1) line(g, pts.map(([a, b]) => [a + xx - x, b]), 0.9, '#8a7458', 0.5); });
    }
    for (let i = 0; i < 4; i++) { const x = rnd() * W, y = range(rnd, yCrown + 40, yRail - 60), r = range(rnd, 18, 40); wrap(W, x, y, r * 1.2, (xx, yy) => { if (Math.abs(yy - y) < 1) blob(g, xx, yy, r, r * 1.3, 0, '#a89068', 0.18, 0.5); }); }
    // studs at uneven spacing, the odd brace
    const studs = [];
    let sx = rnd() * 60;
    while (sx < W - 40) { studs.push(sx); sx += range(rnd, 260, 360); }
    for (const x of studs) {
      const w = range(rnd, 34, 42), c = jitter(pick(rnd, ['#4e321e', '#5a3a22', '#46301c']), rnd, 0.06);
      const cv = makeCanvas(Math.ceil(w) + 2, Math.ceil(yRail - yCrown)), b = cv.getContext('2d');
      plank(b, 0, 0, w, yRail - yCrown, c, rnd, { vertical: true, grain: 9, knots: 0.5, light: 0.5, bevel: 3, endShade: 0, nails: 0 });
      wrap(W, x + w / 2, H / 2, w / 2 + 14, (xx, yy) => {
        if (Math.abs(yy - H / 2) > 1) return;
        g.drawImage(cv, xx - w / 2, yCrown);
        rect(g, xx + w / 2, yCrown, 12, yRail - yCrown, grad(g, xx + w / 2, 0, xx + w / 2 + 12, 0, [[0, '#4a3a4a', 0.4], [1, '#4a3a4a', 0]]));
        rect(g, xx - w / 2 - 5, yCrown, 5, yRail - yCrown, grad(g, xx - w / 2 - 5, 0, xx - w / 2, 0, [[0, '#4a3a4a', 0], [1, '#4a3a4a', 0.2]]));
        for (const yy2 of [yCrown + 14, yRail - 14]) nail(g, xx, yy2, 2.2);
      });
    }
    {
      const x0 = studs[1] ?? 300, x1 = (studs[2] ?? W) - 4;
      g.save(); g.beginPath(); g.moveTo(x0 + 38, yRail - 6); g.lineTo(x0 + 38, yRail - 40); g.lineTo(x0 + 38 + (x1 - x0 - 38) * 0.55, yCrown + 6); g.lineTo(x0 + 38 + (x1 - x0 - 38) * 0.55 + 36, yCrown + 6); g.closePath(); g.clip();
      rect(g, x0, yCrown, x1 - x0, yRail - yCrown, grad(g, x0, yRail, x0 + 80, yCrown, [[0, '#5e3e26'], [1, '#4a301c']]));
      for (let k = 0; k < 6; k++) { const o = range(rnd, -14, 14); line(g, [[x0 + 50 + o, yRail], [x0 + 50 + o + (x1 - x0) * 0.55, yCrown]], 1, '#3a2418', 0.4); }
      g.restore();
    }
    // AO under the crown
    rect(g, 0, yCrown, W, py(2.07) - yCrown, grad(g, 0, yCrown, 0, py(2.07), [[0, '#3a2a3a', 0.45], [1, '#3a2a3a', 0]]));
    // wainscot: uneven walnut boards in three tones, the odd darker replacement
    {
      let x = rnd() * 40;
      const ws = [];
      let tot = 0;
      while (tot < W - 30) { const w = range(rnd, 26, 52); ws.push(w); tot += w; }
      const k = W / tot;
      for (const w0 of ws) {
        const w = w0 * k, c = rnd() < 0.1 ? '#3e2818' : jitter(pick(rnd, ['#5e3c26', '#6a4630', '#523420']), rnd, 0.05);
        const cv = makeCanvas(Math.ceil(w) + 2, Math.ceil(yBase - yRail)), b = cv.getContext('2d');
        plank(b, 0, 0, w - 2, yBase - yRail, c, rnd, { vertical: true, grain: 7, knots: 0.3, light: 0.45, bevel: 3, endShade: 0, nails: 2 });
        wrap(W, x + w / 2, H / 2, w / 2 + 2, (xx, yy) => { if (Math.abs(yy - H / 2) < 1) g.drawImage(cv, xx - w / 2, yRail); });
        x += w;
      }
    }
    rect(g, 0, py(0.27), W, py(0.12) - py(0.27), grad(g, 0, py(0.27), 0, py(0.12), [[0, '#241820', 0], [1, '#241820', 0.45]]));
    // chair rail and its shadow on the boards
    rect(g, 0, yRail - 8, W, 16, grad(g, 0, yRail - 8, 0, yRail + 8, [[0, '#a8784a'], [0.25, '#5a3a22'], [1, '#2e1e14']]));
    rect(g, 0, yRail + 8, W, 8, grad(g, 0, yRail + 8, 0, yRail + 16, [[0, INK, 0.5], [1, INK, 0]]));
    rect(g, 0, yRail - 14, W, 6, grad(g, 0, yRail - 14, 0, yRail - 8, [[0, INK, 0], [1, INK, 0.25]]));
    // baseboard and crown beam
    rect(g, 0, yBase, W, H - yBase, grad(g, 0, yBase, 0, H, [[0, '#7a5030'], [0.2, '#4a2e1c'], [1, '#261810']]));
    rect(g, 0, 0, W, yCrown, grad(g, 0, 0, 0, yCrown, [[0, '#2e1e14'], [0.6, '#5a3a22'], [1, '#8a6038']]));
    for (let x = 12; x < W; x += range(rnd, 60, 90)) { nail(g, x, yRail, 2); nail(g, x + 30, yBase + 8, 1.8); }
    glaze(g, W, H, '#ffd8a0', 0.1, 'soft-light');
  },
});

// Floor: dark reddish-umber planks along u (the RV's length), a lighter worn path down the aisle.
// v spans the floor's full width once (no tiling across).
register('rv_floor', {
  family: F, size: 512, note: 'plank floor (tiles along u), worn path down the middle',
  paint(g, s, rnd) {
    const rects = rowLayout(s, rnd, { rows: 15, minW: 170, maxW: 380, rowJitter: 0.18 });
    fill(g, s, s, '#1e1418');
    for (const r of rects) {
      const c = rnd() < 0.08 ? '#432a1c' : jitter(pick(rnd, ['#5a3a26', '#523420', '#62402a', '#4c3020']), rnd, 0.06);
      const w = r.w - 2, h = r.h - 3;
      const cv = makeCanvas(Math.ceil(w) + 2, Math.ceil(h) + 2), b = cv.getContext('2d');
      plank(b, 0, 0, w, h, c, rnd, { grain: 8, knots: 0.35, light: 0.4, bevel: 2.5, nails: 4, endShade: 0.35, splits: 0.3 });
      wrap(s, r.x + 1 + w / 2, r.y + 1 + h / 2, Math.max(w, h) / 2 + 2, (xx, yy) => g.drawImage(cv, xx - w / 2, yy - h / 2));
    }
    // the worn path down the aisle (v ≈ the middle third), boot scuffs
    for (let i = 0; i < 70; i++) {
      const x = rnd() * s, y = s * range(rnd, 0.36, 0.66), rx = range(rnd, 20, 70), ry = range(rnd, 6, 16), c = pick(rnd, ['#8a6444', '#7a5a3e', '#9a7452']), a = range(rnd, 0.12, 0.25);
      wrap(s, x, y, rx, (xx, yy) => { if (Math.abs(yy - y) < 1) blob(g, xx, yy, rx, ry, 0, c, a, 0.2); });
    }
    for (let i = 0; i < 30; i++) {
      const x = rnd() * s, y = s * range(rnd, 0.3, 0.7), L = range(rnd, 8, 26), d = (rnd() - 0.5) * 4;
      wrap(s, x, y, L, (xx, yy) => { if (Math.abs(yy - y) < 1) line(g, [[xx, yy], [xx + L, yy + d]], 1.2, '#2a1a14', 0.35); });
    }
    // darker by the walls
    rect(g, 0, 0, s, s * 0.12, grad(g, 0, 0, 0, s * 0.12, [[0, '#1a1018', 0.45], [1, '#1a1018', 0]]));
    rect(g, 0, s * 0.88, s, s * 0.12, grad(g, 0, s * 0.88, 0, s, [[0, '#1a1018', 0], [1, '#1a1018', 0.45]]));
    glaze(g, s, s, '#ffcfa0', 0.08, 'soft-light');
  },
});

// Ceiling boards between the beams: planks along u (2 m per tile), darker toward the walls.
register('rv_ceiling', {
  family: F, size: 512, note: 'ceiling boards (tiles along u)',
  paint(g, s, rnd) {
    const rects = rowLayout(s, rnd, { rows: 16, minW: 200, maxW: 420, rowJitter: 0.15 });
    fill(g, s, s, '#1e1418');
    for (const r of rects) {
      const c = jitter(pick(rnd, ['#6e4a30', '#664428', '#76502f', '#5e3e26']), rnd, 0.06);
      const w = r.w - 2, h = r.h - 2;
      const cv = makeCanvas(Math.ceil(w) + 2, Math.ceil(h) + 2), b = cv.getContext('2d');
      plank(b, 0, 0, w, h, c, rnd, { grain: 7, knots: 0.3, light: 0.35, bevel: 2, nails: 2, endShade: 0.3, splits: 0.1 });
      wrap(s, r.x + 1 + w / 2, r.y + 1 + h / 2, Math.max(w, h) / 2 + 2, (xx, yy) => g.drawImage(cv, xx - w / 2, yy - h / 2));
    }
    mottle(g, s, rnd, { colors: ['#2a1a18', '#8a6444'], count: 14, rmin: 30, rmax: 80, alpha: 0.12, stretch: 2.5, rot: 0 });
    rect(g, 0, 0, s, s * 0.14, grad(g, 0, 0, 0, s * 0.14, [[0, '#1a1018', 0.5], [1, '#1a1018', 0]]));
    rect(g, 0, s * 0.86, s, s * 0.14, grad(g, 0, s * 0.86, 0, s, [[0, '#1a1018', 0], [1, '#1a1018', 0.5]]));
  },
});

register('rv_soft', {
  family: F, size: 512, note: 'soft goods: patchwork quilt, tufted plaid, woven runner, copper wash stall',
  paint(g, s, rnd) {
    fill(g, s, s, '#6a4a3a');
    // patchwork quilt: 8×3 puffy patches, stitched, with a binding
    {
      const [x0, y0, W, H] = SOFT.quilt, cols = 8, rows = 3, pw = W / cols, ph = H / rows;
      const fabrics = ['#8a3a2c', '#b8893a', '#5a7a4a', '#3e5a7a', '#d8c8a2', '#6e4a62', '#a8563a', '#4a6a5a'];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const c = jitter(fabrics[(i * 3 + j * 5 + Math.floor(rnd() * 2)) % fabrics.length], rnd, 0.06);
        const X = x0 + i * pw, Y = y0 + j * ph;
        rect(g, X, Y, pw, ph, grad(g, X, Y, X + pw, Y + ph, [[0, lightOf(c, 0.35)], [0.5, c], [1, shadowOf(c, 0.45)]]));
        const kind = (i + j * 2) % 4;
        if (kind === 0) for (let k = 0; k < 7; k++) ellipse(g, X + range(rnd, 5, pw - 5), Y + range(rnd, 5, ph - 5), 2.2, 2.2, 0, lightOf(c, 0.8), 0.7);
        if (kind === 1) for (let k = 4; k < pw; k += 7) line(g, [[X + k, Y + 2], [X + k, Y + ph - 2]], 2, shadowOf(c, 0.3), 0.5);
        if (kind === 2) for (let k = 0; k < 4; k++) { const fx = X + range(rnd, 8, pw - 8), fy = Y + range(rnd, 8, ph - 8); for (let p = 0; p < 5; p++) { const a = p / 5 * TAU; ellipse(g, fx + Math.cos(a) * 3, fy + Math.sin(a) * 3, 2.2, 2.2, 0, '#eadab0', 0.8); } ellipse(g, fx, fy, 1.6, 1.6, 0, '#c8973e'); }
        blob(g, X + pw * 0.35, Y + ph * 0.35, pw * 0.4, ph * 0.3, 0, '#fff4dc', 0.18, 0.2);
        g.save(); g.setLineDash([3, 3]); g.strokeStyle = rgba('#f4e8c8', 0.7); g.lineWidth = 1.1; g.strokeRect(X + 3.5, Y + 3.5, pw - 7, ph - 7); g.restore();
        rect(g, X + pw - 2, Y, 2, ph, INK, 0.45); rect(g, X, Y + ph - 2, pw, 2, INK, 0.45);
      }
      g.save(); g.lineWidth = 6; g.strokeStyle = '#5a2a22'; g.strokeRect(x0 + 3, y0 + 3, W - 6, H - 6); g.restore();
    }
    // tufted plaid upholstery
    {
      const [x0, y0, W, H] = SOFT.plaid;
      rect(g, x0, y0, W, H, '#7e3628');
      for (let x = 0; x < W; x += 32) { rect(g, x0 + x + 4, y0, 12, H, '#3e4a32', 0.55); rect(g, x0 + x + 22, y0, 2, H, '#c8a052', 0.55); }
      for (let y = 0; y < H; y += 32) { rect(g, x0, y0 + y + 4, W, 12, '#3e4a32', 0.45); rect(g, x0, y0 + y + 22, W, 2, '#c8a052', 0.5); }
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
    paintRunner(g, rnd);
    paintStall(g, rnd);
  },
});

// The woven runner down the aisle: a deep red field, a navy border with a gold guard line, a chain
// of medallions; the end piece has a fringe. The middle piece tiles along v.
function paintRunner(g, rnd) {
  const [x0, y0, W, H] = SOFT.rug, E = SOFT.RUG_END, MH = H - E;
  const RED = '#7a2a22', NAVY = '#2e3a5a', GOLDR = '#b8913a', OAT = '#d4c39a';
  const border = (b, y, h) => {
    for (const [bx, bw, c] of [[0, 22, NAVY], [22, 3, GOLDR], [W - 25, 3, GOLDR], [W - 22, 22, NAVY]]) rect(b, bx, y, bw, h, c);
    for (let yy = y; yy < y + h; yy += 12) for (const bx of [11, W - 11]) { b.save(); b.beginPath(); b.moveTo(bx, yy); b.lineTo(bx + 5, yy + 6); b.lineTo(bx, yy + 12); b.lineTo(bx - 5, yy + 6); b.closePath(); b.fillStyle = GOLDR; b.fill(); b.restore(); }
  };
  // middle piece (tiles along v): painted on its own canvas, wrapping vertically
  {
    const cv = makeCanvas(W, MH), b = cv.getContext('2d');
    rect(b, 0, 0, W, MH, RED);
    for (let i = 0; i < 40; i++) { const x = rnd() * W, y = rnd() * MH, rx = range(rnd, 10, 40), ry = range(rnd, 8, 30), c = pick(rnd, ['#8a3428', '#6a2420', '#94402e']); for (const yy of [y - MH, y, y + MH]) blob(b, x, yy, rx, ry, 0, c, 0.3, 0.2); }
    border(b, 0, MH);
    // two medallions per tile (a big lozenge, a small one), so the repeat is two motifs long
    for (const [cy, s] of [[MH * 0.28, 1], [MH * 0.78, 0.62]]) {
      const cx = W / 2;
      b.save(); b.beginPath(); b.moveTo(cx, cy - 46 * s); b.lineTo(cx + 70 * s, cy); b.lineTo(cx, cy + 46 * s); b.lineTo(cx - 70 * s, cy); b.closePath(); b.fillStyle = NAVY; b.fill();
      b.lineWidth = 3; b.strokeStyle = GOLDR; b.stroke();
      b.beginPath(); b.moveTo(cx, cy - 26 * s); b.lineTo(cx + 40 * s, cy); b.lineTo(cx, cy + 26 * s); b.lineTo(cx - 40 * s, cy); b.closePath(); b.fillStyle = GOLDR; b.fill();
      b.beginPath(); b.moveTo(cx, cy - 12 * s); b.lineTo(cx + 18 * s, cy); b.lineTo(cx, cy + 12 * s); b.lineTo(cx - 18 * s, cy); b.closePath(); b.fillStyle = RED; b.fill(); b.restore();
      for (const sx of [-1, 1]) { ellipse(b, cx + sx * 88 * s, cy, 6 * s, 6 * s, 0, GOLDR); ellipse(b, cx + sx * 88 * s, cy, 3 * s, 3 * s, 0, OAT); }
    }
    // weave: fine rows, wear down the middle
    for (let y = 0; y < MH; y += 3) line(b, [[0, y], [W, y]], 1, '#2a1018', 0.12);
    for (let i = 0; i < 26; i++) { const x = W * range(rnd, 0.3, 0.7), y = rnd() * MH, rx = range(rnd, 12, 30), ry = range(rnd, 8, 20); for (const yy of [y - MH, y, y + MH]) blob(b, x, yy, rx, ry, 0, '#c8a888', 0.13, 0.2); }
    rect(b, 0, 0, 30, MH, grad(b, 0, 0, 30, 0, [[0, '#fff0d0', 0.18], [1, '#fff0d0', 0]]));
    rect(b, W - 30, 0, 30, MH, grad(b, W - 30, 0, W, 0, [[0, '#2c2340', 0], [1, '#2c2340', 0.3]]));
    g.drawImage(cv, x0, y0 + E);
  }
  // end piece: a fringe, an end border across, then the field
  {
    const cv = makeCanvas(W, E), b = cv.getContext('2d');
    rect(b, 0, 0, W, E, RED);
    border(b, 22, E - 22);
    rect(b, 22, 22, W - 44, 18, NAVY); rect(b, 22, 40, W - 44, 3, GOLDR);
    for (let x = 30; x < W - 30; x += 16) { b.save(); b.beginPath(); b.moveTo(x, 24); b.lineTo(x + 6, 31); b.lineTo(x, 38); b.lineTo(x - 6, 31); b.closePath(); b.fillStyle = GOLDR; b.fill(); b.restore(); }
    rect(b, 0, 0, W, 22, '#000000', 0);
    b.clearRect(0, 0, W, 22);
    for (let x = 2; x < W; x += 4) { const L = range(rnd, 12, 21), d = (rnd() - 0.5) * 3; line(b, [[x, 22], [x + d, 22 - L]], 2, pick(rnd, [OAT, '#c4b088', '#e0d0a8']), 0.95); }
    for (let y = 22; y < E; y += 3) line(b, [[0, y], [W, y]], 1, '#2a1018', 0.12);
    g.save(); g.fillStyle = '#3e281c'; g.fillRect(x0, y0, W, E); g.restore();
    g.drawImage(cv, x0, y0);
  }
}

// The goblin wash stall: riveted copper sheets of uneven size (no grid), lit top-left, green patina
// where the water runs, dark seams. Painted at the stall's true aspect (0.8 × 2.2 m), then squeezed in.
function paintStall(g, rnd) {
  const [x0, y0, W, H] = SOFT.stall, TH = Math.round(W * 2.75);
  const cv = makeCanvas(W, TH), b = cv.getContext('2d');
  rect(b, 0, 0, W, TH, '#3a2018');
  let y = -range(rnd, 0, 40);
  while (y < TH) {
    const rh = range(rnd, 120, 230);
    let x = -range(rnd, 10, 120);
    while (x < W) {
      const sw = range(rnd, 100, 170), c = jitter(pick(rnd, ['#9a5a32', '#a4643a', '#8e522e']), rnd, 0.06);
      const X = x + 2, Y = y + 2, w = sw - 4, h = rh - 4;
      b.save(); rrect(b, X, Y, w, h, 4); b.clip();
      rect(b, X, Y, w, h, grad(b, X, Y, X + w * 0.7, Y + h, [[0, lightOf(c, 0.4)], [0.45, c], [1, shadowOf(c, 0.45)]]));
      mottleIn(b, rnd, X, Y, w, h, { colors: ['#b8703e', '#7a4424', '#c88a58'], count: 6, rmin: 12, rmax: 40, alpha: 0.3 });
      // patina gathers low and in runs
      mottleIn(b, rnd, X, Y + h * 0.5, w, h * 0.5, { colors: ['#5e8a72', '#6e9a80', '#4e7a64'], count: 5, rmin: 10, rmax: 30, alpha: 0.45 });
      for (let k = 0; k < 4; k++) { const sx = range(rnd, X + 8, X + w - 8), sy = range(rnd, Y + 10, Y + h * 0.5); line(b, [[sx, sy], [sx + (rnd() - 0.5) * 3, sy + range(rnd, 30, 90)]], range(rnd, 2, 5), '#5e8a72', 0.4); }
      rect(b, X, Y, w, 3, lightOf(c, 0.8), 0.7); rect(b, X, Y, 3, h, lightOf(c, 0.8), 0.5);
      rect(b, X, Y + h - 5, w, 5, INK, 0.4); rect(b, X + w - 4, Y, 4, h, INK, 0.35);
      b.restore();
      for (let rx = X + 9; rx < X + w - 4; rx += range(rnd, 20, 26)) rivet(b, rx, Y + 8, 3.6, '#c07a46', 0.45);
      for (let ry = Y + 24; ry < Y + h - 8; ry += range(rnd, 22, 28)) rivet(b, X + 8, ry, 3.6, '#c07a46', 0.45);
      x += sw;
    }
    y += rh;
  }
  rect(b, 0, TH * 0.82, W, TH * 0.18, grad(b, 0, TH * 0.82, 0, TH, [[0, '#4e7a64', 0], [1, '#4e7a64', 0.4]]));
  g.drawImage(cv, x0, y0, W, H);
}

// ---- lamps and glows -----------------------------------------------------------------------------

register('rv_lamps', {
  family: F, w: LAMPS.W, h: LAMPS.H, note: 'lenses (headlight, tail, marker, lantern) and the night glows (window, porthole, halo)',
  paint(g, s, rnd) {
    fill(g, LAMPS.W, LAMPS.H, '#000000');
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
    lens(LAMPS.head, '#fffbe8', '#f4e2a8', '#a88a50');
    lens(LAMPS.tail, '#ffb08a', '#ff6040', '#7a2014', 5);
    lens(LAMPS.amber, '#ffe8a0', '#f0a030', '#8a4a14', 3);
    // lantern glass: warm, a flame, soot at the top, iron bars
    {
      const [x0, y0, w] = LAMPS.lantern, cx = x0 + w / 2;
      rect(g, x0, y0, w, w, grad(g, 0, y0, 0, y0 + w, [[0, '#6a4a2a'], [0.25, '#e8b060'], [0.7, '#f6d488'], [1, '#c88a40']]));
      blob(g, cx, y0 + w * 0.6, w * 0.36, w * 0.4, 0, '#fff4c8', 0.8, 0.3);
      g.save(); g.beginPath(); g.moveTo(cx, y0 + w * 0.3); g.quadraticCurveTo(cx + w * 0.13, y0 + w * 0.55, cx, y0 + w * 0.72); g.quadraticCurveTo(cx - w * 0.13, y0 + w * 0.55, cx, y0 + w * 0.3);
      g.fillStyle = '#fffbe8'; g.fill(); g.restore();
      blob(g, cx, y0 + w * 0.66, w * 0.06, w * 0.08, 0, '#ff9a3a', 0.8, 0.4);
      for (let k = 0; k < 3; k++) line(g, [[x0 + w * (0.2 + k * 0.3), y0], [x0 + w * (0.2 + k * 0.3), y0 + w]], 3, '#3a2a20', 0.5);
    }
    // a lit window seen from outside: warm lamplight, curtains drawn back at the sides, a valance,
    // a brighter pool where the lantern hangs. Drawn additively, so black adds nothing.
    {
      const [x0, y0, w, h] = LAMPS.window;
      rect(g, x0, y0, w, h, '#000000');
      g.fillStyle = radial(g, x0 + w * 0.45, y0 + h * 0.45, w * 0.6, [[0, '#e8b46a'], [0.5, '#c4823c'], [1, '#5a300e']]);
      g.fillRect(x0, y0, w, h);
      blob(g, x0 + w * 0.62, y0 + h * 0.32, w * 0.16, h * 0.3, 0, '#ffe4a8', 0.45, 0.2);
      for (const [cx, dir] of [[x0, 1], [x0 + w, -1]]) {
        rect(g, Math.min(cx, cx + dir * w * 0.2), y0, w * 0.2, h, grad(g, cx, 0, cx + dir * w * 0.2, 0, [[0, '#4a2210'], [0.7, '#7a3a18'], [1, '#7a3a18', 0]]));
        for (let k = 0; k < 4; k++) { const fx = cx + dir * w * (0.03 + k * 0.045); line(g, [[fx, y0], [fx + dir * 3, y0 + h]], 3, '#2a1208', 0.5); }
      }
      rect(g, x0, y0, w, h * 0.16, grad(g, 0, y0, 0, y0 + h * 0.16, [[0, '#2a1208'], [1, '#6a3010']]));
      rect(g, x0, y0 + h * 0.85, w, h * 0.15, grad(g, 0, y0 + h * 0.85, 0, y0 + h, [[0, '#000000', 0], [1, '#000000', 0.6]]));
    }
    // a soft halo for lamps (additive)
    {
      const [x0, y0, w] = LAMPS.halo, c = x0 + w / 2;
      g.fillStyle = radial(g, c, y0 + w / 2, w / 2, [[0, '#fff2c8'], [0.12, '#ffd890'], [0.35, '#a86420'], [0.7, '#301804'], [1, '#000000']]);
      g.fillRect(x0, y0, w, w);
    }
    // a lit porthole
    {
      const [x0, y0, w] = LAMPS.port, c = x0 + w / 2;
      g.fillStyle = radial(g, c - w * 0.08, y0 + w * 0.45, w / 2, [[0, '#ffe0a0'], [0.6, '#d88a40'], [1, '#5a2a0a']]);
      g.fillRect(x0, y0, w, w);
    }
  },
});

// Window glass (alpha), two halves: the outside face [u 0..0.5] reads as glass from the road (a sky
// tint, one broad diagonal reflection, darker in its lower third, a warm lit top edge); the inside
// face [u 0.5..1] stays nearly clear so the road is in view from the seats.
export const GLASS_U = { out: [0, 0.5], in: [0.5, 1] };
register('rv_glass', {
  family: F, w: 512, h: 256, alpha: true, note: 'window glass (alpha): outside face (left), inside face (right)',
  paint(g, W, rnd, H) {
    g.clearRect(0, 0, W, H);
    const s = H;
    // outside
    clipRect(g, 0, 0, s, s, () => {
      rect(g, 0, 0, s, s, grad(g, 0, 0, 0, s, [[0, '#a8c4cc', 0.42], [0.45, '#6a8494', 0.42], [0.7, '#3e4c58', 0.5], [1, '#2e3a44', 0.6]]));
      const x = range(rnd, s * 0.05, s * 0.3), w = range(rnd, 60, 80);
      g.save(); g.globalAlpha = 0.35;
      g.fillStyle = grad(g, x, 0, x + w, 0, [[0, '#cfe6e2', 0], [0.5, '#cfe6e2', 1], [1, '#cfe6e2', 0]]);
      g.beginPath(); g.moveTo(x, s); g.lineTo(x + w, s); g.lineTo(x + w + s * 0.45, 0); g.lineTo(x + s * 0.45, 0); g.closePath(); g.fill(); g.restore();
      g.save(); g.globalAlpha = 0.18; g.fillStyle = '#e8f4f0';
      g.beginPath(); g.moveTo(x + w + 18, s); g.lineTo(x + w + 30, s); g.lineTo(x + w + 30 + s * 0.45, 0); g.lineTo(x + w + 18 + s * 0.45, 0); g.closePath(); g.fill(); g.restore();
      rect(g, 0, 0, s, 7, grad(g, 0, 0, 0, 7, [[0, '#f0d8a8', 0.55], [1, '#f0d8a8', 0]]));
      for (const [cx, cy] of [[0, s], [s, s]]) blob(g, cx, cy, s * 0.3, s * 0.22, 0, '#6a5a44', 0.3, 0.1);
    });
    // inside
    clipRect(g, s, 0, s, s, () => {
      rect(g, s, 0, s, s, grad(g, 0, 0, 0, s, [[0, '#cfe2ea', 0.16], [0.5, '#9ac0cc', 0.08], [1, '#5a7480', 0.12]]));
      const x = s + range(rnd, -20, s * 0.5), w = range(rnd, 40, 70);
      g.save(); g.globalAlpha = 0.08;
      g.fillStyle = grad(g, x, 0, x + w, 0, [[0, '#f4fbff', 0], [0.5, '#f4fbff', 1], [1, '#f4fbff', 0]]);
      g.beginPath(); g.moveTo(x, s); g.lineTo(x + w, s); g.lineTo(x + w + s * 0.35, 0); g.lineTo(x + s * 0.35, 0); g.closePath(); g.fill(); g.restore();
      rect(g, s, s - 24, s, 24, grad(g, 0, s - 24, 0, s, [[0, '#7a6a52', 0], [1, '#7a6a52', 0.25]]));
    });
  },
});

// ---- per-biome weather ---------------------------------------------------------------------------

// Snow for day 3 (Dun Morogh): lies on the roof, sills and bumpers. Tiles.
register('rv_snow', {
  family: F, size: 256, note: 'snow lying on the RV (tiles): cool blue shadows, sunlit cream, sparkle',
  paint(g, s, rnd) {
    fill(g, s, s, '#e6edf4');
    mottle(g, s, rnd, { colors: ['#f8f6ee', '#d2dcea', '#c4cee2', '#fbf8f0'], count: 50, rmin: 14, rmax: 60, alpha: 0.4, hard: 0.2 });
    // wind-sculpted streaks along u
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 30, 90), h = range(rnd, 2, 5), c = rnd() < 0.5 ? '#ffffff' : '#c8d4e6', a = range(rnd, 0.2, 0.35);
      wrap(s, x, y, L, (xx, yy) => blob(g, xx, yy, L, h, 0.04, c, a, 0.3));
    }
    // soft blue-violet scoops, each with a warm sunlit crest on its upper-left lip
    for (let i = 0; i < 12; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 24, 50), a0 = range(rnd, 0.3, 0.7), a1 = a0 + range(rnd, 1.4, 2.1), w = range(rnd, 3, 6), sq = range(rnd, 0.22, 0.36), tilt = (rnd() - 0.5) * 0.3;
      wrap(s, x, y, r + 8, (xx, yy) => {
        g.save(); g.translate(xx, yy); g.rotate(tilt); g.scale(1, sq); g.lineCap = 'round';
        g.beginPath(); g.arc(0, 0, r, a0, a1); g.lineWidth = w; g.strokeStyle = rgba('#9aaccc', 0.2); g.filter = 'blur(1.5px)'; g.stroke();
        g.beginPath(); g.arc(-2, -7, r, a0, a1); g.lineWidth = w * 0.6; g.strokeStyle = rgba('#f7f4ec', 0.45); g.stroke();
        g.restore();
      });
    }
    mottle(g, s, rnd, { colors: ['#b8c8dc', '#aab8d4'], count: 14, rmin: 6, rmax: 18, alpha: 0.28, hard: 0.3, stretch: 2.2 });
    for (let i = 0; i < 70; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 3, (xx, yy) => { ellipse(g, xx, yy, 1.1, 1.1, 0, '#ffffff', 0.9); }); }
    blurTile(g.canvas, 0.6);
  },
});

// Road grime thrown up by the wheels (alpha, painted white: the material tints it per biome).
// Top half: a long side (u = 8 m, front at u=0 on one side and u=1 on the other: the arches sit
// at u ≈ 0.17 and 0.83 either way). Bottom half: the front/rear (u = 2.5 m). v: y -0.6 → 1.02.
register('rv_grime', {
  family: F, w: 1024, h: 256, alpha: true, note: 'road grime overlay (alpha, tinted per biome): sides (top), ends (bottom)',
  paint(g, W, rnd, H) {
    g.clearRect(0, 0, W, H);
    const RH = H / 2, PY = RH / 1.62;
    const row = (oy, Ppx, arches) => {
      const Y = y => oy + (1.02 - y) * PY;
      // a dense crust at the bottom, thinning upward
      rect(g, 0, Y(0.2), W, Y(-0.6) - Y(0.2), grad(g, 0, Y(0.2), 0, Y(-0.6), [[0, '#ffffff', 0], [0.35, '#ffffff', 0.25], [0.7, '#ffffff', 0.6], [1, '#ffffff', 0.85]]));
      // soft clouds of dust, then a ragged splattered top edge of small drops
      for (let i = 0; i < W / 14; i++) { const x = rnd() * W, y = Y(range(rnd, -0.5, 0.1)); blob(g, x, y, range(rnd, 20, 50), range(rnd, 8, 16), 0, '#ffffff', range(rnd, 0.15, 0.35), 0.2); }
      for (let i = 0; i < W / 4; i++) {
        const x = rnd() * W, y = Y(range(rnd, -0.2, 0.4) ** 1), r = range(rnd, 0.8, 3.2);
        blob(g, x, y, r * range(rnd, 1, 1.6), r, rnd() * 3, '#ffffff', range(rnd, 0.3, 0.8), 0.6);
      }
      for (let i = 0; i < W / 8; i++) {
        const x = rnd() * W, y = Y(range(rnd, -0.4, 0.2)), L = range(rnd, 20, 90);
        line(g, [[x, y], [x + L, y + (rnd() - 0.5) * 4]], range(rnd, 2, 6), '#ffffff', range(rnd, 0.2, 0.45));
      }
      // fans thrown up round the wheels
      for (const ax of arches) {
        const cx = ax * W, cy = Y(-0.86);
        for (let i = 0; i < 260; i++) {
          const a = range(rnd, 0.35, Math.PI - 0.35), d = range(rnd, 0.72, 0.72 + 0.6 * rnd() ** 1.6) * Ppx, x = cx + Math.cos(a) * d, y = cy - Math.sin(a) * d * (PY / Ppx), r = range(rnd, 1, 4);
          blob(g, x, y, r * 2.2, r, a + Math.PI / 2, '#ffffff', range(rnd, 0.3, 0.8), 0.5);
        }
        g.save(); g.beginPath(); g.ellipse(cx, cy, 0.95 * Ppx, 0.95 * PY, 0, Math.PI, TAU); g.lineWidth = 0.32 * PY; g.strokeStyle = 'rgba(255,255,255,0.65)'; g.filter = 'blur(5px)'; g.stroke(); g.restore();
      }
      // drips
      for (let i = 0; i < W / 30; i++) {
        const x = rnd() * W, y = Y(range(rnd, 0.0, 0.45));
        line(g, [[x, y], [x + (rnd() - 0.5) * 2, y + range(rnd, 8, 26)]], range(rnd, 1.2, 2.6), '#ffffff', 0.5);
      }
    };
    g.save(); g.beginPath(); g.rect(0, 0, W, RH); g.clip(); row(0, W / 8, [0.172, 0.828]); g.restore();
    g.save(); g.beginPath(); g.rect(0, RH, W, RH); g.clip(); row(RH, W / 2.5, []); g.restore();
    // keep the storage hatch plates clean (a thin streak of grime left along their bottoms). One
    // strip serves both sides (u = (z+4)/8 on the door side, (4-z)/8 on the other), so both sides'
    // hatch spans are cleared.
    {
      const Y = y => (1.02 - y) * (RH / 1.62), ya = Y(-0.06), yb = Y(-0.5);
      const spans = [...RV_ART.hatches.R.map(([a, b]) => [(a + 4) / 8, (b + 4) / 8]), ...RV_ART.hatches.L.map(([a, b]) => [(4 - b) / 8, (4 - a) / 8])];
      g.save(); g.globalCompositeOperation = 'destination-out';
      for (const [u0, u1] of spans) {
        const x0 = u0 * W - 2, x1 = u1 * W + 2;
        g.fillStyle = grad(g, 0, ya, 0, yb, [[0, '#000000', 0.95], [0.8, '#000000', 0.9], [1, '#000000', 0.3]]);
        g.fillRect(x0, ya, x1 - x0, yb - ya);
      }
      g.restore();
    }
  },
});
