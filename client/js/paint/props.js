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
//   wood turned iron safe safeback porcelain leather sign slot slotback slotside bulbs
//   dinohead dinojaw dinomouth eye plaster (the dino head: hide, jaw, mouth / tongue / plain bumps / spine plates)
//   gnomehat gnomecoat gnomebeard gnomeface gnomefur portrait gold rosette glass brass bronze gilt
//   tire rim screen steel bakelite toastplate red regdeck crest till plaque keys tvfront tvback
//   strap fret guitar honey ball ivory rubber parchment lantern skin boot toast bulb tag
// Boulders (not in the atlas, they're 4 m wide): loot_boulder_<biome> (512×256, u wraps round
// the rock, v runs ground → top; badlands and desert carry the strata of BOULDER_BANDS, whose
// edges the slab geometry ledges on) is the stone; loot_cover_<biome> (alpha, seamless) is the
// broad cap of moss / lichen / snow / dust / sand on its upward faces (a shell mesh, alpha-tested).
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
  dinohead: [512, 256, 'wrap'], dinojaw: [256, 128, 'wrap'], dinomouth: [256, 64], sign: [512, 288], slot: [256, 512], slotback: [192, 384], slotside: [96, 192], bulbs: [512, 48],
  gnomehat: [128, 128, 'wrap'], gnomecoat: [256, 128, 'wrap'], gnomebeard: [128, 128, 'wrap'], gnomeface: [256, 128, 'wrap'], gnomefur: [128, 32, 'wrap'],
  portrait: [384, 288], gold: [1008, 64], rosette: [64, 64], glass: [512, 128, 'wrap'],
  brass: [256, 128, 'wrap'], bronze: [256, 128, 'wrap'], gilt: [256, 128, 'wrap'], tire: [512, 128, 'wrap'], turned: [128, 128, 'wrap'],
  rim: [128, 128], screen: [128, 128], steel: [128, 192], bakelite: [64, 64, 'wrap'], toastplate: [128, 40], red: [128, 128], regdeck: [256, 128], crest: [192, 96],
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

export const TIRE_V = { treadLo: 0.38, treadHi: 0.62, wallLo: [0.16, 0.24], wallHi: [0.76, 0.84], textLo: [0.02, 0.15], textHi: [0.85, 0.98] };

// The dino head (meters, before props3d fits it to the collider): the sauropod statue's head, a
// domed crown over the eyes and a long, blunt, rounded muzzle (everything in front of the crown is
// stretched forward by SNOUT.k, so the profile reads as a long-necked grazer's head, not a round
// blob). The head and neck share one hide cell: u round the cross-section (0.5 = the spine, 0 / 1 = the
// underside), v along z from z0 (behind the neck's break) to the snout (z1). In front of the hinge the
// underside is the roof of the mouth (pink, inside the lip line at lipU). The lower jaw has its own
// cell: u round it (0.5 = the floor of the mouth, lip at 0.5 ± jawLipU), v from its hinge end to the
// chin. head / jaw / neck are the lofts' sections { z, w (half width), top, bot }; the neck leaves the
// skull at neckAt, tilted neckTilt down and back. sz(z) maps a z drawn on the unstretched head (the
// teeth, say) onto the stretched one.
const SNOUT = { from: 0.15, k: 1.15 };
const snoutZ = z => z > SNOUT.from ? SNOUT.from + (z - SNOUT.from) * SNOUT.k : z;
const stretched = st => st.map(s => ({ ...s, z: +snoutZ(s.z).toFixed(4) }));
export const DINO = {
  z0: -0.6, z1: snoutZ(0.725), hinge: -0.14, hingeY: -0.11, open: 0, lipU: 0.07, jawLipU: 0.07,
  eye: { z: 0.02, u: 0.2, r: 0.125 }, nostril: { z: snoutZ(0.655), u: 0.06 }, pw: 2.15, sz: snoutZ,
  head: stretched([
    { z: -0.34, w: 0.2, top: 0.18, bot: -0.07 }, { z: -0.28, w: 0.3, top: 0.27, bot: -0.15 }, { z: -0.18, w: 0.37, top: 0.33, bot: -0.2 },
    { z: -0.05, w: 0.4, top: 0.41, bot: -0.22 }, { z: 0.06, w: 0.395, top: 0.49, bot: -0.215 }, { z: 0.15, w: 0.37, top: 0.52, bot: -0.2 },
    { z: 0.23, w: 0.34, top: 0.475, bot: -0.185 }, { z: 0.3, w: 0.31, top: 0.37, bot: -0.17 }, { z: 0.37, w: 0.29, top: 0.3, bot: -0.16 },
    { z: 0.45, w: 0.28, top: 0.27, bot: -0.152 }, { z: 0.54, w: 0.27, top: 0.255, bot: -0.145 }, { z: 0.61, w: 0.248, top: 0.235, bot: -0.138 },
    { z: 0.67, w: 0.196, top: 0.205, bot: -0.122 }, { z: 0.71, w: 0.12, top: 0.16, bot: -0.095 }, { z: 0.725, w: 0.03, top: 0.11, bot: -0.05 },
  ]),
  jaw: stretched([
    { z: -0.18, w: 0.22, top: -0.085, bot: -0.21 }, { z: -0.08, w: 0.33, top: -0.085, bot: -0.3 }, { z: 0.06, w: 0.36, top: -0.09, bot: -0.36 },
    { z: 0.2, w: 0.34, top: -0.095, bot: -0.38 }, { z: 0.35, w: 0.295, top: -0.1, bot: -0.355 }, { z: 0.47, w: 0.262, top: -0.1, bot: -0.315 },
    { z: 0.56, w: 0.228, top: -0.102, bot: -0.27 }, { z: 0.62, w: 0.166, top: -0.105, bot: -0.22 }, { z: 0.655, w: 0.08, top: -0.11, bot: -0.18 },
    { z: 0.665, w: 0.02, top: -0.12, bot: -0.16 },
  ]),
  neck: [{ z: 0, w: 0.31, top: 0.29, bot: -0.29 }, { z: 0.2, w: 0.32, top: 0.3, bot: -0.3 }, { z: 0.38, w: 0.335, top: 0.31, bot: -0.31 }, { z: 0.5, w: 0.35, top: 0.325, bot: -0.325 }],
  neckAt: [0, 0.06, -0.18], neckTilt: 0.3,
};

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

// a wide soft rust stain bleeding down from (x, y): a dark core, a warm orange halo, fading as it runs
function rustStain(g, x, y, wd, len, rnd, alpha = 1) {
  const n = Math.max(4, Math.round(len / 5));
  for (let k = 0; k < n; k++) {
    const t = k / n, cx = x + Math.sin(t * 5 + x) * wd * 0.15, cy = y + len * t, r = wd * (1 - t * 0.55);
    blob(g, cx, cy, r * 0.7, r * 0.9, 0, mix('#b8642a', '#8a4a22', t), 0.22 * alpha * (1 - t * 0.6), 0.2);
  }
  stroke(g, [[x, y], [x + range(rnd, -1, 1), y + len * 0.4], [x + range(rnd, -2, 2), y + len * 0.75]], wd * 0.35, wd * 0.1, '#5e2c14', 0.35 * alpha);
  blob(g, x, y + 1, wd * 0.45, wd * 0.35, 0, '#c87a3a', 0.4 * alpha, 0.4);
}
// riveted iron: green-black lacquer lit on the upper left, deep on the lower right; rivets set by hand
// (one or two missing); the lacquer chipped to bare iron at the edges; a few wide rust stains bleeding
// from the corners and the hinges, a rust bloom along the bottom edge
function ironPlate(g, s, rnd, { base = '#34463e', door = false, rivets = 9, hinges = null } = {}) {
  fill(g, s, s, base);
  g.fillStyle = lin(g, 0, 0, s, s, [[0, '#6c8c76'], [0.22, '#56725f'], [0.5, '#3c5246'], [0.78, '#263630'], [1, '#1a2424']]); g.fillRect(0, 0, s, s);
  mottle(g, s, rnd, { colors: ['#4a5e52', '#2e3c36', '#56705e', '#344640'], count: 24, rmin: s * 0.06, rmax: s * 0.22, alpha: 0.3, hard: 0.1 });
  // hammer marks: soft dents, lit on their upper left
  for (let i = 0; i < 12; i++) { const x = range(rnd, 0.15, 0.85) * s, y = range(rnd, 0.15, 0.85) * s, r = range(rnd, 10, 20); blob(g, x - r * 0.3, y - r * 0.3, r, r * 0.8, 0, '#7a9a84', 0.16, 0.15); blob(g, x + r * 0.4, y + r * 0.4, r * 0.9, r * 0.7, 0, '#18221e', 0.12, 0.15); }
  // the raised border band
  const b = Math.round(s * 0.06);
  molding(g, b - 6, b - 6, s - 2 * b + 12, s - 2 * b + 12, '#46584e', 12, 0.95);
  // gold pinstripe, hand drawn
  const pin = (o, a, wdt) => { const q = [[b + o, b + o], [s - b - o, b + o], [s - b - o, s - b - o], [b + o, s - b - o], [b + o, b + o]].map(([x, y]) => [x + (rnd() - 0.5) * 1.4, y + (rnd() - 0.5) * 1.4]); line(g, q, wdt, '#c8a050', a); };
  pin(s * 0.055, 0.75, 1.6); pin(s * 0.072, 0.35, 1);
  // rivets: hand-spaced (±15%), one or two gone, leaving their holes
  const n = rivets, step = (s - 2 * b) / (n - 1), pts = [];
  for (let k = 0; k < n; k++) for (const side of [0, 1, 2, 3]) {
    const t = b + step * k + (k > 0 && k < n - 1 ? range(rnd, -0.15, 0.15) * step : 0), off = range(rnd, -1, 1);
    pts.push(side === 0 ? [t, b + off] : side === 1 ? [t, s - b + off] : side === 2 ? [b + off, t] : [s - b + off, t]);
  }
  const gone = new Set([Math.floor(rnd() * pts.length), Math.floor(rnd() * pts.length)]);
  pts.forEach(([x, y], i) => {
    if (gone.has(i)) { ellipse(g, x, y, s * 0.012, s * 0.012, 0, '#141a18'); ellipse(g, x + 0.6, y + 0.8, s * 0.008, s * 0.008, 0, '#5a4030', 0.8); line(g, [[x - 2, y + 3], [x - 1, y + 9]], 2.4, '#8a4a22', 0.4); }
    else rivet(g, x, y, s * 0.014 * range(rnd, 0.9, 1.1), '#6a7670');
  });
  // the lacquer chipped to bare iron along the edges and corners
  const bare = (x, y, r) => { chips(g, rnd, 1, x - 1, y - 1, 2, 2, '#8a8a86', r * 0.6, r, 0.95); blob(g, x - r * 0.3, y - r * 0.35, r * 0.5, r * 0.3, 0, '#c8bca0', 0.6, 0.4); };
  for (let i = 0; i < (door ? 18 : 34); i++) {
    const side = Math.floor(rnd() * 4), t = rnd(), band = s * 0.03;
    const x = side === 0 || side === 2 ? t * s : side === 1 ? s - rnd() * band : rnd() * band, y = side === 1 || side === 3 ? t * s : side === 0 ? rnd() * band : s - rnd() * band;
    bare(x, y, range(rnd, 3, 7));
  }
  for (const [x, y] of [[4, 4], [s - 4, 4], [4, s - 4], [s - 4, s - 4]]) for (let k = 0; k < 3; k++) bare(x + range(rnd, -4, 4) * (x < s / 2 ? -1 : 1) + (x < s / 2 ? 4 : -4), y + (y < s / 2 ? 4 : -4) + range(rnd, -3, 3), range(rnd, 3, 6));
  // rust: wide stains from the top corners (and the hinges), a bloom along the bottom
  const spots = [[b + range(rnd, 4, 14), b + 4], [s - b - range(rnd, 4, 14), b + 4], ...(hinges || [[range(rnd, 0.35, 0.65) * s, b + 2]])];
  for (const [x, y] of spots) rustStain(g, x, y, range(rnd, 11, 20), range(rnd, s * 0.16, s * 0.34), rnd, 1.3);
  for (let i = 0; i < 7; i++) blob(g, range(rnd, 0.05, 0.95) * s, s - range(rnd, 2, 10), range(rnd, 10, 26), range(rnd, 5, 10), 0, pick(rnd, ['#8a4a22', '#a85a2a', '#6e3a1c']), 0.35, 0.25);
  g.fillStyle = lin(g, 0, s * 0.86, 0, s, [[0, '#7a4428', 0], [1, '#7a4428', 0.3]]); g.fillRect(0, s * 0.86, s, s * 0.14);
  // a cream highlight along the top bevel, the soft bevel round the rest
  bevel(g, 0, 0, s, s, base, 10, 0.4, 0.6);
  g.fillStyle = lin(g, 0, 0, 0, 5, [[0, '#f0e4c0', 0.55], [1, '#f0e4c0', 0]]); g.fillRect(0, 0, s, 5);
  line(g, [[3, 1.5], [s * 0.6, 1.5]], 1.2, '#fff4d8', 0.6);
}
register('loot_iron', {
  family: F, size: 256, note: "the Rusty Safe's body: green-black lacquered iron, rivet border, gold pinstripe, worn edges, rust runs",
  paint(g, s, rnd, h, cv) { ironPlate(g, s, rnd); glaze(g, s, s, '#ffe8c0', 0.08); blurTile(cv, 0.4); },
});
register('loot_safe', {
  family: F, size: 256, note: "the safe door: pinstripes, corner scrolls, the maker's plate, the dial's number ring",
  paint(g, s, rnd, h, cv) {
    ironPlate(g, s, rnd, { base: '#34403a', door: true, hinges: [[s * 0.12, s * 0.2], [s * 0.15, s * 0.83]] });
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
    for (let i = 0; i < 2; i++) rustStain(g, range(rnd, s * 0.25, s * 0.75), range(rnd, s * 0.3, s * 0.5), range(rnd, 6, 10), range(rnd, 20, 40), rnd, 0.8);
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
  family: F, w: 256, h: 128, note: "the trophy's gilt (u wraps, front at the middle; v up the cup's profile): foot, stem knot, a bowl with a bright cream band under the lip and a dark reflected band at the belly, crisp dents, a bowling pin engraved on the front, an umber inside",
  paint(g, w, rnd, h, cv) {
    const Y = v => (1 - v) * h;
    g.fillStyle = lin(g, 0, Y(1), 0, Y(0), [
      [0, '#3a2408'], [0.1, '#5a3a10'], [0.14, '#8a6020'],      // inside (v 1 → 0.86): umber shadow
      [0.15, '#fff6c8'], [0.18, '#e8c060'],                     // the lip
      [0.22, '#fff0b8'], [0.27, '#fff0b8'], [0.32, '#e8c060'],  // the cream band under the lip
      [0.4, '#c8902e'], [0.46, '#6a4a18'], [0.52, '#6a4a18'],   // the dark reflected band at the belly
      [0.58, '#b8862e'], [0.64, '#e8b850'],                     // the bowl's lit underside
      [0.72, '#8a5a18'], [0.76, '#f0d070'], [0.8, '#a8782a'],   // stem knot
      [0.86, '#7a5418'], [0.9, '#f8e090'], [0.94, '#b8862e'], [1, '#6a4814'],  // the foot
    ]);
    g.fillRect(0, 0, w, h);
    // the light round the cup: lit on the left of the front, darker on the right
    g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = lin(g, 0, 0, w, 0, [[0, '#c8b090'], [0.25, '#ffffff'], [0.45, '#fff8ec'], [0.75, '#a89070'], [1, '#c8b090']]); g.fillRect(0, 0, w, Y(0.15)); g.restore();
    for (let i = 0; i < 6; i++) { const x = range(rnd, 0.18, 0.36) * w; line(g, [[x, Y(0.84)], [x + range(rnd, -2, 2), Y(0.6)]], range(rnd, 1.5, 3), '#fffbe0', 0.5); }
    for (let i = 0; i < 26; i++) { const x = rnd() * w, y = Y(range(rnd, 0.2, 0.84)), L = range(rnd, 10, 30); wrapX(w, x, L, X => line(g, [[X, y], [X + L, y + range(rnd, -1, 1)]], 0.7, rnd() < 0.5 ? '#fff0b8' : '#6a4a18', 0.2)); }
    // crisp dents: a short dark edge under a lit one
    for (let i = 0; i < 9; i++) { const x = rnd() * w, y = Y(range(rnd, 0.25, 0.8)), r = range(rnd, 2.5, 4.5); wrapX(w, x, 8, X => { line(g, [[X - r, y], [X, y - r * 0.6], [X + r, y]], 1.3, '#4a3008', 0.6); line(g, [[X - r, y + 1.4], [X, y - r * 0.6 + 1.4], [X + r, y + 1.4]], 1, '#fff4c8', 0.7); }); }
    // a bowling pin engraved on the front of the bowl
    const px = w / 2, py = Y(0.6), pin = [];
    for (let k = 0; k <= 20; k++) { const t = k / 20, y = py - 15 + t * 30, r = 2 + 2.6 * Math.exp(-(((t - 0.18) / 0.12) ** 2)) * 0.6 + 4.2 * Math.exp(-(((t - 0.72) / 0.22) ** 2)) - (t > 0.32 && t < 0.45 ? 0.8 : 0); pin.push([px + r, y]); }
    const outlineP = [...pin, ...pin.slice().reverse().map(([x, y]) => [2 * px - x, y])];
    line(g, [...outlineP, outlineP[0]].map(([x, y]) => [x + 0.7, y + 0.8]), 1.1, '#fff4c8', 0.7);
    line(g, [...outlineP, outlineP[0]], 1.1, '#4a3008', 0.85);
    line(g, [[px - 3, py - 5], [px + 3, py - 5]], 1, '#4a3008', 0.8); line(g, [[px - 3, py - 3], [px + 3, py - 3]], 1, '#4a3008', 0.8);
    blurTile(cv, 0.4);
  },
});

register('loot_steel', {
  family: F, w: 128, h: 192, note: "the toaster's chrome, painted as a reflection: the top 128 px are the sides (cream sky, a soft horizon, the warm brown ground, cool blue-gray low, a bright streak near the left edge, dark rims); the bottom 64 px the top face",
  paint(g, w, rnd, h, cv) {
    const s = 128;
    // the sides: sky → horizon → ground → cool shade
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#f6ecd0'], [0.2, '#f2e6c8'], [0.34, '#d8ccb0'], [0.4, '#b8b0a0'], [0.43, '#7e6a50'], [0.52, '#6e5c44'], [0.64, '#8a7458'], [0.74, '#7a7468'], [0.86, '#5a6478'], [1, '#444c5e']]);
    g.fillRect(0, 0, w, s);
    // the horizon line, soft but definite, wavering a little; tree and hill shapes reflected in it
    for (let i = 0; i < 9; i++) { const x = rnd() * w, r = range(rnd, 6, 16); wrapX(w, x, r, X => blob(g, X, s * 0.42, r, range(rnd, 2, 5), 0, '#5a4a36', 0.5, 0.4)); }
    line(g, [[0, s * 0.415], [w * 0.4, s * 0.41], [w, s * 0.418]], 1.6, '#4a3c2c', 0.6);
    line(g, [[0, s * 0.395], [w, s * 0.398]], 1.2, '#fff8e4', 0.6);
    for (let i = 0; i < 40; i++) { const y = rnd() * s, x = rnd() * w, L = range(rnd, 10, 40); line(g, [[x, y], [x + L, y + (rnd() - 0.5)]], range(rnd, 0.5, 1), y < s * 0.4 ? '#fffaf0' : '#3e4656', 0.12); }
    // the bright vertical streak near the left edge, a fainter one to its right
    g.fillStyle = lin(g, 10, 0, 26, 0, [[0, '#fffaf0', 0], [0.35, '#fffaf0', 0.85], [0.65, '#fffaf0', 0.85], [1, '#fffaf0', 0]]); g.fillRect(10, 0, 16, s * 0.94);
    g.fillStyle = lin(g, 36, 0, 42, 0, [[0, '#fffaf0', 0], [0.5, '#fffaf0', 0.4], [1, '#fffaf0', 0]]); g.fillRect(36, 0, 6, s * 0.9);
    // a dark reflected band on the right where the room's corner shows
    g.fillStyle = lin(g, w * 0.7, 0, w * 0.86, 0, [[0, '#2e3442', 0], [0.5, '#2e3442', 0.35], [1, '#2e3442', 0]]); g.fillRect(w * 0.7, 0, w * 0.16, s);
    // dents: small, crisp, a lit edge over a dark one
    for (let i = 0; i < 6; i++) { const x = range(rnd, 0.15, 0.85) * w, y = range(rnd, 0.15, 0.85) * s, r = range(rnd, 3, 6); line(g, [[x - r, y + r * 0.2], [x, y - r * 0.4], [x + r, y]], 1.2, '#2e3442', 0.5); line(g, [[x - r, y + r * 0.2 + 1.4], [x, y - r * 0.4 + 1.4], [x + r, y + 1.4]], 1, '#fffaf0', 0.55); }
    for (let i = 0; i < 4; i++) blob(g, rnd() * w, range(rnd, 0.5, 0.95) * s, range(rnd, 4, 9), range(rnd, 2, 4), rnd() * 3, '#8a6a48', 0.22, 0.3);
    // dark rims where the chrome turns over the bevels
    g.save(); g.strokeStyle = rgba('#2a2e38', 0.75); g.lineWidth = 3; g.strokeRect(1.5, 1.5, w - 3, s - 3); g.restore();
    line(g, [[3, 4], [w - 3, 4]], 1.4, '#fffaf0', 0.6);
    // the top face: bright cream chrome with a soft reflected window and a dark rim
    g.fillStyle = lin(g, 0, s, w, h, [[0, '#fff8e4'], [0.4, '#e8dcc0'], [0.75, '#b8b0a0'], [1, '#8a8478']]); g.fillRect(0, s, w, h - s);
    g.save(); g.globalAlpha = 0.5; poly(g, [[16, s + 8], [52, s + 6], [44, h - 8], [10, h - 6]]); g.fillStyle = '#fffcf0'; g.fill(); g.restore();
    line(g, [[0, s + 32], [w, s + 30]], 1.2, '#7a7060', 0.35);
    g.save(); g.strokeStyle = rgba('#3a3a40', 0.6); g.lineWidth = 3; g.strokeRect(1.5, s + 1.5, w - 3, h - s - 3); g.restore();
    blurTile(cv, 0.5);
  },
});
register('loot_bakelite', {
  family: F, size: 64, note: "oxblood bakelite (u wraps; v up the knob's profile): knurled stripes, a lit band, a dark base",
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#d07a5a'], [0.25, '#b85a40'], [0.55, '#7a2a22'], [0.85, '#5a1c18'], [1, '#3a1210']]); g.fillRect(0, 0, s, s);
    for (let k = 0; k < 24; k++) { const x = k / 24 * s; line(g, [[x, s * 0.35], [x, s]], 1.1, k % 2 ? '#3a1210' : '#c86a4a', 0.45); }
    blob(g, s * 0.3, s * 0.2, 14, 6, 0, '#f0b090', 0.6, 0.3);
    blurTile(cv, 0.4);
  },
});
register('loot_toastplate', {
  family: F, w: 128, h: 40, note: "the toaster's riveted brass maker's plate: TOASTMASTER 9000",
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#f8e49a'], [0.4, '#d8b058'], [1, '#8a6628']]); g.fillRect(0, 0, w, h);
    molding(g, 1, 1, w - 2, h - 2, '#c8a050', 5);
    letters(g, 'TOASTMASTER', w / 2, h * 0.42, 15, { rnd, jit: 0.03, fill: ['#5a3a14', '#3a2410', '#2a1808'], rim: '#fff0b8', lit: '#2a1808', shadow: 0, chip: 0.2, rough: 0.4, maxW: w - 30 });
    letters(g, '9000', w / 2, h * 0.76, 10, { rnd, jit: 0.03, fill: ['#5a3a14', '#3a2410', '#2a1808'], rim: '#fff0b8', lit: '#2a1808', shadow: 0, chip: 0.1, rough: 0.3 });
    for (const [x, y] of [[7, 7], [w - 7, 7], [7, h - 7], [w - 7, h - 7]]) rivet(g, x, y, 2.6, '#c8a050');
    blurTile(cv, 0.3);
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
    fill(g, s, s, '#f2ecdc');
    mottle(g, s, rnd, { colors: ['#faf6ea', '#e8e4d6', '#efe6d0', '#ece8e0'], count: 30, rmin: 30, rmax: 90, alpha: 0.4, hard: 0.1 });
    const band = (y, w = 2.2, c = B1) => line(g, [[-2, y], [s + 2, y]], w, c, 0.92);
    const yFoot = Y(-0.352);
    rect(g, 0, yFoot, s, s - yFoot, '#cdb48e');
    for (let i = 0; i < 8; i++) { const x = rnd() * s, y = range(rnd, yFoot, s), rx = range(rnd, 4, 12); wrapX(s, x, 12, X => blob(g, X, y, rx, 3, 0, '#a88e6a', 0.3, 0.3)); }
    band(yFoot - 1, 3, B1);
    // lotus panels, in solid cobalt like the shoulder
    const l0 = Y(-0.33), l1 = Y(-0.2);
    rect(g, 0, l1, s, l0 - l1, '#efe8d8');
    band(l0, 2.6); band(l0 - 4, 1.2);
    const nP = 10, PW = s / nP;
    for (let i = 0; i < nP; i++) {
      const cx = (i + 0.5) * PW + range(rnd, -2, 2), pw = PW * range(rnd, 0.85, 1.15), lean = range(rnd, -0.15, 0.15) * (l0 - l1);
      const petal = (X) => { g.beginPath(); g.moveTo(X - pw * 0.42, l0 - 5); g.quadraticCurveTo(X - pw * 0.48 + lean * 0.5, l1 + 10, X + lean, l1 + 2); g.quadraticCurveTo(X + pw * 0.48 + lean * 0.5, l1 + 10, X + pw * 0.42, l0 - 5); };
      wrapX(s, cx, PW, X => {
        petal(X); g.save(); g.fillStyle = rgba(CO, 0.88); g.fill(); g.lineWidth = 2; g.strokeStyle = rgba(BD, 0.9); g.stroke(); g.restore();
        petal(X); g.save(); g.clip(); blob(g, X - PW * 0.15, l1 + (l0 - l1) * 0.4, PW * 0.18, (l0 - l1) * 0.3, 0, BW, 0.45, 0.3); g.restore();
        line(g, [[X, l0 - 7], [X + lean * 0.8, l1 + 9]], 1.4, '#f2ecdc', 0.75);
        blob(g, X + lean * 0.8, l1 + 9, 3, 3, 0, '#f2ecdc', 0.8, 0.5);
      });
    }
    band(l1, 2.4); band(l1 + 4, 1.1);
    // the main field: a peony scroll
    const m0 = Y(-0.17), m1 = Y(0.1);
    const vph = [rnd() * TAU, rnd() * TAU, rnd() * TAU];
    const vine = x => (m0 + m1) / 2 + (m0 - m1) * (0.24 * Math.sin(x / s * TAU * 2 + 0.6) + 0.07 * Math.sin(x / s * TAU * 3 + vph[0]) + 0.04 * Math.sin(x / s * TAU * 5 + vph[1]));
    const vp = []; for (let x = -10; x <= s + 10; x += 4) vp.push([x, vine(x)]);
    for (let i = 0; i < vp.length - 1; i++) { const t = 0.5 + 0.5 * Math.sin(i * 0.37 + vph[2]); line(g, [vp[i], vp[i + 1]], 3 + t * 2.4, mix('#2a4aa0', '#6a8ad0', 1 - t), 0.85); }
    line(g, vp.map(([x, y]) => [x, y + 1.2]), 1, BD, 0.45);
    for (let i = 0; i < 9; i++) { const x = rnd() * s; wrapX(s, x, 10, X => blob(g, X, vine(X) + range(rnd, -2, 2), range(rnd, 4, 9), 2.5, 0, '#1a3080', 0.35, 0.4)); }
    for (let i = 0; i < 34; i++) {
      const x = rnd() * s, y = vine(x), a = (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.5, 1.4), L = range(rnd, 12, 20);
      wrapX(s, x, 20, X => {
        g.save(); g.translate(X, y); g.rotate(a); g.fillStyle = rgba(B2, 0.85); g.beginPath(); g.ellipse(L / 2, 0, L / 2, L * 0.22, 0, 0, TAU); g.fill();
        g.strokeStyle = rgba(BD, 0.8); g.lineWidth = 0.8; g.beginPath(); g.moveTo(0, 0); g.lineTo(L, 0); g.stroke(); g.restore();
      });
    }
    const fl = [[0.12, 27], [0.37, 15], [0.55, 21], [0.8, 26], [0.94, 13]];
    for (const [i, [fx, R0]] of fl.entries()) {
      const x = (fx + range(rnd, -0.03, 0.03)) * s, y = vine(x) + (i % 2 ? -10 : 10) * (R0 / 24), R = R0 * range(rnd, 0.92, 1.08);
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
    g.save(); g.globalCompositeOperation = 'multiply';
    g.fillStyle = lin(g, 0, 0, s, 0, [[0, '#d8dce4'], [0.12, '#ffffff'], [0.36, '#ffffff'], [0.5, '#f4f2ee'], [0.68, '#c8ced8'], [0.8, '#b8c0cc'], [0.92, '#c8ced8'], [1, '#d8dce4']]); g.fillRect(0, 0, s, s);
    g.restore();
    g.save(); g.globalAlpha = 0.5; g.fillStyle = lin(g, s * 0.16, 0, s * 0.42, 0, [[0, '#fff8e8', 0], [0.5, '#fff8e8'], [1, '#fff8e8', 0]]); g.fillRect(s * 0.16, 0, s * 0.26, s); g.restore();
    stroke(g, [[s * 0.27, Y(0.19)], [s * 0.285, Y(0.13)], [s * 0.3, Y(0.07)]], 5, 2, '#fffcf2', 0.85);
    stroke(g, [[s * 0.26, Y(-0.12)], [s * 0.27, Y(-0.2)], [s * 0.275, Y(-0.26)]], 3, 1, '#fffcf2', 0.5);
    // crackle: a fine net of hairlines in the glaze
    for (let i = 0; i < 46; i++) { let x = rnd() * s, y = rnd() * s; const pts = [[x, y]]; for (let k = 0; k < 4; k++) { x += range(rnd, -9, 9); y += range(rnd, -9, 9); pts.push([x, y]); } line(g, pts, 0.6, '#9a907c', 0.16); }
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
      g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#7aa080', 0.4], [0.45, '#5a8a68', 0.15], [0.6, '#5a8a68', 0]]); g.fillRect(0, 0, w, h);   // sun-faded up top
      // the wood's grain showing through the paint, the plank seams cutting across it
      g.save(); g.globalCompositeOperation = 'multiply'; grain(g, 0, 0, w, h, rnd, { dark: ['#4a5a40', '#3a4a34'], lite: ['#9ab08a'], n: 40, amp: 2, knots: 2, alpha: 0.35 }); g.restore();
      for (const y of [92, 190]) { const pts = []; for (let x = -4; x <= w + 4; x += 16) pts.push([x, y + range(rnd, -0.8, 0.8)]); line(g, pts.map(([a, b]) => [a, b + 1.5]), 2.4, '#4a6a50', 0.6); line(g, pts, 3, '#142418', 0.85); }
      for (let i = 0; i < 30; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 3, 12), range(rnd, 2, 5), 0, '#6a4428', 0.7, 0.6);
      // the paint chipped back to bare wood along the edges, the corners worst
      const edgeP = offsetPoly(out, -26);
      for (let i = 0; i < 46; i++) { const k = Math.floor(rnd() * edgeP.length), [ex, ey] = edgeP[k], r = range(rnd, 3, 8); chips(g, rnd, 1, ex - 3, ey - 3, 6, 6, '#8a6a44', r * 0.6, r, 0.95); blob(g, ex - r * 0.3, ey - r * 0.4, r * 0.5, r * 0.3, 0, '#b89060', 0.6, 0.4); }
      for (const [cx2, cy2] of [[60, h - 40], [w - 60, h - 40], [70, 130], [w - 70, 130]]) for (let k = 0; k < 4; k++) { const r = range(rnd, 4, 9); chips(g, rnd, 1, cx2 + range(rnd, -14, 14), cy2 + range(rnd, -10, 10), 4, 4, '#8a6a44', r * 0.6, r, 0.9); }
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
  family: F, size: 128, note: 'CRT glass: convex smoky green-gray, a goblin grinning faintly out of the test card, a cream window reflection with two muntins, soft scanlines',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = radial(g, s * 0.44, s * 0.42, 4, s * 0.74, [[0, '#94b2a8'], [0.3, '#7a9a92'], [0.62, '#5e7e78'], [0.86, '#40605c'], [1, '#2e4442']]); g.fillRect(0, 0, s, s);
    // the picture, faint under the glass: a test-card circle and a grinning goblin
    g.save(); g.globalAlpha = 0.3;
    g.strokeStyle = '#c8d8c0'; g.lineWidth = 2; g.beginPath(); g.arc(s / 2, s * 0.52, s * 0.36, 0, TAU); g.stroke();
    line(g, [[s * 0.1, s * 0.52], [s * 0.9, s * 0.52]], 1.4, '#c8d8c0'); line(g, [[s / 2, s * 0.12], [s / 2, s * 0.92]], 1.4, '#c8d8c0');
    g.restore();
    g.save(); g.globalAlpha = 0.34;
    const fx = s * 0.52, fy = s * 0.56;
    for (const sd of [-1, 1]) { poly(g, [[fx + sd * 16, fy - 10], [fx + sd * 44, fy - 24], [fx + sd * 22, fy + 2]]); g.fillStyle = '#6a8a58'; g.fill(); }
    g.fillStyle = radial(g, fx - 6, fy - 8, 2, 26, [[0, '#a8b878'], [0.6, '#7a9a5a'], [1, '#4a6a48']]); g.beginPath(); g.ellipse(fx, fy, 22, 24, 0, 0, TAU); g.fill();
    for (const sd of [-1, 1]) { ellipse(g, fx + sd * 8, fy - 6, 4.5, 3.4, 0, '#f0e8a0'); ellipse(g, fx + sd * 8, fy - 6, 2, 2.6, 0, '#2a2a20'); }
    g.beginPath(); g.moveTo(fx - 13, fy + 6); g.quadraticCurveTo(fx, fy + 18, fx + 13, fy + 6); g.quadraticCurveTo(fx, fy + 11, fx - 13, fy + 6); g.fillStyle = '#2a2a20'; g.fill();
    for (let k = -2; k <= 2; k++) rect(g, fx + k * 4.4 - 1.6, fy + 8 + Math.abs(k) * -0.8, 3.2, 3, '#f0e8c8');
    stroke(g, [[fx - 2, fy - 2], [fx + 1, fy + 3], [fx - 1, fy + 4]], 3, 2, '#4a6a40');
    g.restore();
    // soft scanlines and a little static in bands
    for (let y = 1; y < s; y += 3) line(g, [[0, y], [s, y]], 1, '#1a2624', 0.06);
    for (let i = 0; i < 5; i++) { const y = rnd() * s; line(g, [[rnd() * s * 0.3, y], [s * 0.7 + rnd() * s * 0.3, y]], range(rnd, 2, 4), '#c8e8e0', 0.07); }
    // the convex glass: a darker rim, a lit lower-right edge, a cream window reflected top left
    g.save(); g.globalCompositeOperation = 'multiply'; g.fillStyle = radial(g, s * 0.46, s * 0.44, s * 0.3, s * 0.75, [[0, '#ffffff'], [1, '#6a8480']]); g.fillRect(0, 0, s, s); g.restore();
    const arc = []; for (let k = 0; k <= 12; k++) { const a = 0.15 + k / 12 * 1.3; arc.push([s * 0.48 + Math.cos(a) * s * 0.42, s * 0.48 + Math.sin(a) * s * 0.42]); }
    stroke(g, arc, 2, 5, '#cfe8e0', 0.35);
    const win = [[s * 0.13, s * 0.12], [s * 0.45, s * 0.1], [s * 0.4, s * 0.4], [s * 0.1, s * 0.43]];
    g.save(); g.globalAlpha = 0.45; poly(g, win); g.fillStyle = lin(g, s * 0.1, s * 0.1, s * 0.42, s * 0.42, [[0, '#fff8e4'], [1, '#e8eedc']]); g.fill(); g.restore();
    line(g, [[s * 0.29, s * 0.11], [s * 0.255, s * 0.415]], 2.6, '#4a6460', 0.5);
    line(g, [[s * 0.115, s * 0.27], [s * 0.425, s * 0.25]], 2.6, '#4a6460', 0.5);
    blob(g, s * 0.2, s * 0.18, 6, 4, -0.3, '#ffffff', 0.5, 0.5);
    blurTile(cv, 0.5);
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
    // the recess: warm dark bakelite, its top-left inner lip in shadow, the lower-right lip catching the light
    rrect(g, X0, Y0, X1 - X0, Y1 - Y0, 12, '#3a2a1e');
    clip(g, () => { g.beginPath(); g.roundRect(X0, Y0, X1 - X0, Y1 - Y0, 12); }, () => {
      g.fillStyle = lin(g, X0, Y0, X0 + 14, Y0 + 14, [[0, '#1e1610'], [1, '#1e1610', 0]]); g.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
      g.fillStyle = lin(g, X1, Y1, X1 - 7, Y1 - 7, [[0, '#7a5c40'], [0.6, '#6a5038'], [1, '#6a5038', 0]]); g.fillRect(X0, Y0, X1 - X0, Y1 - Y0);
      for (let i = 0; i < 8; i++) blob(g, range(rnd, X0, X1), range(rnd, Y0, Y1), range(rnd, 6, 16), range(rnd, 4, 10), 0, pick(rnd, ['#4a3828', '#2e2218']), 0.3, 0.3);
    });
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
    const bx = w * 0.12, by = h * 0.58, bw = 104, bh = 40;
    rect(g, bx + 2, by + 3, bw, bh, '#140c08', 0.45);
    rect(g, bx, by, bw, bh, '#a88438'); molding(g, bx, by, bw, bh, '#c8a050', 4);
    letters(g, 'SLOPTRON', bx + bw / 2, by + 13, 11, { rnd, jit: 0.03, fill: ['#6a4818', '#4a2e10', '#2a1a08'], rim: '#f8e4a0', lit: '#3a2410', shadow: 0, chip: 0.2, rough: 0.4 });
    for (const [txt, yy] of [['NO SERVICEABLE', by + 24], ['GOBLINS INSIDE', by + 32]]) { g.save(); g.font = `bold 7px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = rgba('#fff0c0', 0.5); g.fillText(txt, bx + bw / 2 - 0.5, yy - 0.5); g.fillStyle = '#3a2410'; g.fillText(txt, bx + bw / 2, yy); g.restore(); }
    for (const sx of [bx + 7, bx + bw - 7]) rivet(g, sx, by + bh / 2, 2.6, '#c8a050');
    for (const [x, y] of [[10, 10], [w - 10, 10], [10, h - 10], [w - 10, h - 10]]) { rivet(g, x, y, 3.6, '#8a8a84'); line(g, [[x - 2.2, y - 2.2], [x + 2.2, y + 2.2]], 1, '#2a2a2a', 0.8); }
    // a stamped inspection mark
    g.save(); g.translate(w * 0.86, h * 0.86); g.rotate(-0.2); g.strokeStyle = rgba('#8a2a1e', 0.55); g.lineWidth = 2; g.beginPath(); g.arc(0, 0, 13, 0, TAU); g.stroke();
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
  family: F, size: 128, note: "the gnome's felt hat (u wraps, front at the middle; v brim → tip; a pixel is ~3× taller in v than it is wide): lit felt on the left, purple shade on the right, broad folds up to the flop, an ochre patch with big cross-stitches, the worn brim roll at the bottom",
  paint(g, s, rnd, h, cv) {
    const Y = v => (1 - v) * s, K = 2.6;    // K: how much taller a world square is in this cell than it is wide
    // value round the hat: mid at the back, lit on the left (u ~0.3), deep purple-red shade on the right (u ~0.75)
    g.fillStyle = lin(g, 0, 0, s, 0, [[0, '#8a3028'], [0.14, '#a8402e'], [0.3, '#c8553a'], [0.42, '#b44a34'], [0.52, '#9a3428'], [0.64, '#7a2a28'], [0.76, '#5a1e2a'], [0.9, '#6a2228'], [1, '#8a3028']]);
    g.fillRect(0, 0, s, s);
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#2a0a14', 0.25], [0.35, '#2a0a14', 0], [0.85, '#fff0d0', 0], [1, '#fff0d0', 0.08]]); g.fillRect(0, 0, s, s);
    for (let i = 0; i < 22; i++) { const x = rnd() * s, y = rnd() * s, rx = range(rnd, 4, 10), ry = rx * K * range(rnd, 0.7, 1.3), c = pick(rnd, ['#c85a40', '#7a221c', '#a8382e', '#8a2a22']); wrap(s, x, y, ry, (X, Yy) => blob(g, X, Yy, rx, ry, 0, c, 0.25, 0.15)); }
    // felt nap: short soft strokes
    for (let i = 0; i < 70; i++) { const x = rnd() * s, y = rnd() * s, L = range(rnd, 3, 6), a = rnd() * TAU, c = rnd() < 0.5 ? '#d8684c' : '#4a1418'; wrapX(s, x, 8, X => line(g, [[X, y], [X + Math.cos(a) * L, y + Math.sin(a) * L * K]], 0.9, c, 0.22)); }
    // broad diagonal folds from the brim up to the flop: a lit ridge with its valley on the right
    const yc = Y(GNOME.crease), ub = GNOME.bendU * s;
    for (let k = 0; k < 4; k++) {
      const x0 = s * (0.18 + k * 0.17) + range(rnd, -4, 4), x1 = ub + (k - 1.5) * 9;
      wrapX(s, (x0 + x1) / 2, 60, () => {});
      const pts = []; for (let m = 0; m <= 8; m++) { const t = m / 8; pts.push([x0 + (x1 - x0) * t + Math.sin(t * Math.PI) * 6, Y(0.08) + (yc - Y(0.08)) * t]); }
      for (const off of [0, -s, s]) {
        stroke(g, pts.map(([a, b]) => [a + off + 4, b]), 7, 3, '#4a1420', 0.45);
        stroke(g, pts.map(([a, b]) => [a + off - 1, b]), 5, 2, '#e07858', 0.45);
      }
    }
    // the flop: the stretched outside of the bend catches the light, the inside crumples
    const uc = ((GNOME.bendU + 0.5) % 1) * s;
    wrapX(s, uc, 40, X => blob(g, X, yc, 28, 12, 0, '#e07a5a', 0.45, 0.2));
    for (let k = 0; k < 4; k++) {
      const dy = (k - 1.5) * 7, L = range(rnd, 12, 20), x = ub + range(rnd, -6, 6);
      wrapX(s, x, 30, X => { const pts = []; for (let m = 0; m <= 6; m++) { const t = m / 6; pts.push([X - L + 2 * L * t, yc + dy + Math.sin(t * Math.PI) * 4]); } stroke(g, pts.map(([a, b]) => [a, b - 2.5]), 2.6, 1, '#d06a50', 0.5); stroke(g, pts, 3, 1, '#3a0e18', 0.6); });
    }
    // the patch: an ochre square of felt (square in the world, so tall here), big cross-stitches round it
    g.save(); g.translate(s * 0.4, Y(0.34)); g.rotate(-0.06);
    const pw = 9, ph = pw * K * 0.95, pq = [[-pw, -ph], [pw * 0.9, -ph * 1.04], [pw * 1.05, ph], [-pw * 0.95, ph * 0.96]];
    poly(g, pq.map(([a, b]) => [a + 2, b + 3])); g.fillStyle = rgba('#2a0806', 0.5); g.fill();
    poly(g, pq); g.fillStyle = lin(g, -pw, -ph, pw, ph, [[0, '#d8b060'], [0.5, '#b08a40'], [1, '#7a5a24']]); g.fill();
    for (let i = 0; i < 6; i++) blob(g, range(rnd, -pw, pw), range(rnd, -ph, ph), 3, 5, 0, pick(rnd, ['#c89a48', '#8a6a2c']), 0.4, 0.3);
    for (let k = 0; k < 4; k++) {
      const [ax, ay] = pq[k], [bx, by] = pq[(k + 1) % 4], n = 3 + (k % 2);
      for (let m = 0; m < n; m++) {
        const t = (m + 0.5) / n, x = ax + (bx - ax) * t, y = ay + (by - ay) * t, ex = 2.6, ey = 2.6 * K;
        line(g, [[x - ex + 0.6, y - ey + 1], [x + ex + 0.6, y + ey + 1]], 2, '#2a0806', 0.5); line(g, [[x + ex + 0.6, y - ey + 1], [x - ex + 0.6, y + ey + 1]], 2, '#2a0806', 0.5);
        line(g, [[x - ex, y - ey], [x + ex, y + ey]], 1.7, '#f0e2b8', 0.95); line(g, [[x + ex, y - ey], [x - ex, y + ey]], 1.7, '#f0e2b8', 0.95);
      }
    }
    g.restore();
    // the brim roll (the bottom 12%): worn lighter felt, lit on top, rubbed pale at the edge
    const b0 = Y(0.12);
    g.fillStyle = lin(g, 0, b0, 0, s, [[0, '#7a2a24'], [0.3, '#c86a50'], [0.55, '#d88a68'], [0.8, '#a8483a'], [1, '#5a1e22']]); g.fillRect(0, b0, s, s - b0);
    for (let i = 0; i < 16; i++) { const x = rnd() * s; wrapX(s, x, 8, X => blob(g, X, range(rnd, b0 + 3, s - 3), range(rnd, 3, 7), 2, 0, '#e8b090', 0.35, 0.3)); }
    glaze(g, s, s, '#ffd8b0', 0.06);
    blurTile(cv, 0.45);
  },
});
register('loot_gnomecoat', {
  family: F, w: 256, h: 128, note: "the gnome's coat (u wraps, front at the middle; v hem → shoulders): slate blue, big folds lit on their left, the belt and buckle, brass buttons",
  paint(g, w, rnd, h, cv) {
    const Y = v => (1 - v) * h;
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#4e6a92'], [0.35, '#3a5680'], [0.8, '#30486c'], [1, '#26385a']]); g.fillRect(0, 0, w, h);
    g.fillStyle = lin(g, 0, 0, w, 0, [[0, '#2e3a5a', 0.3], [0.25, '#6a86b0', 0.25], [0.45, '#6a86b0', 0.12], [0.62, '#2e3a5a', 0.15], [0.78, '#1e2846', 0.4], [1, '#2e3a5a', 0.3]]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 20; i++) { const x = rnd() * w, y = rnd() * h, rx = range(rnd, 8, 20), ry = range(rnd, 10, 24), c = pick(rnd, ['#4a6690', '#2e4466', '#3e5a84']); wrapX(w, x, rx, X => blob(g, X, y, rx, ry, 0, c, 0.3, 0.15)); }
    // big folds in the skirt: a shaded valley with the lit ridge to its left, widening to the hem
    const yb = Y(GNOME.belt[0]);
    for (let i = 0; i < 9; i++) {
      const x = (i + 0.5) * w / 9 + range(rnd, -6, 6), spread = range(rnd, 6, 12);
      wrapX(w, x, 30, X => {
        stroke(g, [[X, yb + 4], [X + spread * 0.3, (yb + h) / 2], [X + spread * 0.6, h + 2]], 2, range(rnd, 9, 14), '#2e3a5a', 0.7);
        stroke(g, [[X - 7, yb + 6], [X - 8 + spread * 0.2, (yb + h) / 2], [X - 10 + spread * 0.4, h + 2]], 3, range(rnd, 7, 10), '#6a86b0', 0.6);
        stroke(g, [[X - 8, yb + 10], [X - 9 + spread * 0.2, (yb + h) / 2]], 1.5, 2.5, '#9ab0d0', 0.35);
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
    for (const y of [yt - 12, yt - 28]) {
      ellipse(g, fx + 1, y + 1.4, 4.4, 4.4, 0, '#141a30', 0.8); ellipse(g, fx, y, 4, 4, 0, '#8a5a30'); ellipse(g, fx, y, 2.8, 2.8, 0, '#a87040');
      ellipse(g, fx - 1, y, 0.7, 0.7, 0, '#3a2010'); ellipse(g, fx + 1, y, 0.7, 0.7, 0, '#3a2010'); blob(g, fx - 1.5, y - 1.6, 1.6, 1, 0, '#f0c890', 0.9, 0.4);
    }
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
    // white hair round the back of the head and over the ears, under the hat: a mass of broad locks
    const hair = (x0, x1) => {
      rect(g, x0, 0, x1 - x0, h * 0.75, '#c8c0bc');
      g.fillStyle = lin(g, 0, h * 0.6, 0, h * 0.8, [[0, '#c8c0bc'], [1, '#c8c0bc', 0]]); g.fillRect(x0, h * 0.6, x1 - x0, h * 0.2);
      const n = Math.round((x1 - x0) / 13);
      for (let i = 0; i < n; i++) {
        const x = x0 + (i + 0.5) * (x1 - x0) / n + range(rnd, -4, 4), L = range(rnd, 56, 96), wd = range(rnd, 11, 20), curl = range(rnd, -6, 6), lean = range(rnd, -6, 6);
        const pts = []; for (let k = 0; k <= 7; k++) { const t = k / 7; pts.push([x + Math.sin(t * Math.PI) * curl + lean * t, -4 + L * t]); }
        stroke(g, pts.map(([a, b]) => [a + 3, b + 2]), wd * 1.1, wd * 0.4, '#7a7488', 0.42);
        stroke(g, pts, wd, wd * 0.35, '#e4dcd0', 1);
        stroke(g, pts.slice(0, 6).map(([a, b]) => [a - wd * 0.25, b]), wd * 0.32, wd * 0.1, '#fff8e8', 0.85);
        const [ex, ey] = pts[7]; line(g, [[ex - 2, ey - 3], [ex + curl * 0.5, ey + 1], [ex + curl, ey - 2]], 2.4, '#d0c8c0', 0.8);
      }
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
  family: F, size: 64, note: "rosy gnome skin (the bulbous nose, the ears), u wraps: lit warm on top, ruddy in the middle, cool underneath",
  paint(g, s, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, s, [[0, '#f8c0a0'], [0.25, '#f0a080'], [0.55, '#d87060'], [0.85, '#a84a50'], [1, '#7a3a48']]); g.fillRect(0, 0, s, s);
    g.fillStyle = lin(g, 0, 0, s, 0, [[0, '#8a4a5a', 0.3], [0.5, '#8a4a5a', 0], [1, '#8a4a5a', 0.3]]); g.fillRect(0, 0, s, s);
    blob(g, s * 0.42, s * 0.3, 9, 5, 0, '#fff0d8', 0.7, 0.4);
    for (let i = 0; i < 6; i++) ellipse(g, range(rnd, 8, 56), range(rnd, 24, 44), 1, 1, 0, '#a84a48', 0.5);
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
  family: F, w: 384, h: 288, note: 'the Velvet Elvis on black-violet velvet: an airbrushed halo, a swept blue-black pompadour, five value steps on the face lit from the upper left, the sneer, a rhinestone collar; soft-edged, crisp glints on top',
  paint(g, w, rnd, h, cv) {
    const cx = 192;
    // soft fill: the path filled through a blur, so no edge is vector-crisp
    const soft = (path, style, px = 1.6, alpha = 1) => { g.save(); g.globalAlpha = alpha; g.filter = `blur(${px}px)`; path(); g.fillStyle = style; g.fill(); g.restore(); };
    const P = pts => () => { g.beginPath(); g.moveTo(...pts[0]); for (let i = 1; i < pts.length; i++) pts[i].length === 6 ? g.bezierCurveTo(...pts[i]) : g.lineTo(...pts[i]); g.closePath(); };
    const within = (path, fn) => { g.save(); path(); g.clip(); fn(); g.restore(); };
    // ---- black-violet velvet, the airbrushed halo behind the head
    rect(g, 0, 0, w, h, '#140c22');
    for (let i = 0; i < 30; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 20, 70), range(rnd, 16, 50), rnd() * 3, pick(rnd, ['#1c1230', '#100a1a', '#1a1028']), 0.5, 0.1);
    g.fillStyle = radial(g, cx + 4, 104, 10, 176, [[0, '#4a3a8a', 0.95], [0.4, '#3a2c72', 0.6], [0.75, '#241a48', 0.25], [1, '#140c22', 0]]); g.fillRect(0, 0, w, h);
    // ---- the white jumpsuit's shoulders, lit on the left, cool on the right
    const suit = P([[-6, h + 6], [6, 238], [56, 212], [148, 202], [172, 204], [192, 252], [212, 204], [236, 202], [326, 212], [378, 238], [w + 6, h + 6]]);
    soft(suit, lin(g, 0, 0, w, 0, [[0, '#fbf6ec'], [0.3, '#ecebf0'], [0.55, '#c8cce0'], [0.8, '#8a92b8'], [1, '#6a7098']]), 1.5);
    within(suit, () => {
      for (const [x0, y0, x1, y1, c, a] of [[70, 222, 96, 288, '#8a96c4', 0.45], [120, 214, 140, 288, '#8a96c4', 0.4], [262, 214, 250, 288, '#5a6290', 0.5], [318, 226, 300, 288, '#4e5682', 0.5], [40, 240, 54, 288, '#a8b0d0', 0.35]]) { g.save(); g.filter = 'blur(3px)'; stroke(g, [[x0, y0], [(x0 + x1) / 2 + 4, (y0 + y1) / 2], [x1, y1]], 4, 14, c, a); g.restore(); }
      blob(g, 64, 232, 40, 16, -0.3, '#fffaf0', 0.55, 0.3);
      blob(g, 330, 250, 50, 30, 0, '#4a5080', 0.45, 0.3);
    });
    // ---- the great standing collar, behind the neck: soft folds, warm lit edges
    const colL = P([[166, 206], [160, 184], [158, 160, 152, 142, 146, 132], [128, 128, 112, 130, 102, 138], [96, 160, 100, 188, 116, 210]]), colR = P([[220, 206], [226, 184], [228, 160, 234, 142, 240, 132], [258, 128, 274, 130, 284, 138], [290, 160, 286, 188, 270, 210]]);
    soft(colL, lin(g, 104, 140, 156, 206, [[0, '#fff4e0'], [0.45, '#dcdeea'], [1, '#9aa4c8']]), 1.4);
    soft(colR, lin(g, 228, 206, 280, 140, [[0, '#6a7098'], [0.6, '#8a96c4'], [1, '#b8c0dc']]), 1.4);
    within(colL, () => { for (const t of [0.3, 0.62]) { g.save(); g.filter = 'blur(2.5px)'; stroke(g, [[158 - t * 40, 206], [150 - t * 34, 172], [146 - t * 30, 136]], 3, 7, '#8a96c4', 0.55); g.restore(); } blob(g, 156, 180, 8, 26, 0, '#7a84b0', 0.5, 0.3); });
    within(colR, () => { for (const t of [0.3, 0.62]) { g.save(); g.filter = 'blur(2.5px)'; stroke(g, [[228 + t * 40, 206], [236 + t * 34, 172], [240 + t * 30, 136]], 3, 7, '#4e5682', 0.55); g.restore(); } });
    stroke(g, [[104, 136], [124, 128], [146, 132]], 3, 1.5, '#fff4e0', 0.85);
    stroke(g, [[100, 150], [100, 182], [114, 208]], 2, 1, '#fff4e0', 0.5);
    // ---- neck and the open V of the chest, in the jaw's shadow
    soft(P([[166, 160], [220, 160], [224, 208], [192, 252], [160, 208]]), lin(g, 160, 0, 226, 0, [[0, '#c88660'], [0.45, '#a8705a'], [1, '#5e4058']]), 1.2);
    blob(g, 196, 184, 34, 12, 0, '#3e2238', 0.8, 0.25);
    blob(g, 176, 216, 9, 18, 0, '#d8946a', 0.45, 0.3);
    // ---- ears and the face: a square jaw, five values, the light from the upper left
    soft(P([[150, 104], [140, 102, 140, 128, 152, 136]]), '#b8765a', 1); soft(P([[234, 104], [244, 102, 244, 128, 232, 136]]), '#6a4458', 1);
    const face = P([[154, 82], [146, 100, 147, 132, 156, 156], [162, 168, 176, 178, 192, 180], [208, 178, 222, 168, 228, 156], [237, 132, 238, 100, 230, 82], [214, 70, 172, 70, 154, 82]]);
    soft(face, lin(g, 148, 0, 238, 0, [[0, '#d6926a'], [0.35, '#c47a52'], [0.62, '#a86a54'], [0.8, '#7e5260'], [1, '#6a4a6a']]), 1.3);
    within(face, () => {
      blob(g, 178, 84, 30, 13, -0.1, '#f2b884', 0.85, 0.3);          // the brow of the forehead
      blob(g, 167, 124, 13, 10, 0.2, '#f2b884', 0.75, 0.3);          // the left cheekbone
      blob(g, 186, 170, 12, 6, 0, '#e8a678', 0.55, 0.3);             // the chin
      blob(g, 222, 128, 16, 34, 0, '#5e4062', 0.55, 0.25);           // the far side turning away
      blob(g, 164, 146, 8, 12, 0, '#9a5e56', 0.4, 0.3);              // the cheek hollows
      blob(g, 214, 148, 10, 14, 0, '#5a3a58', 0.5, 0.3);
      blob(g, 192, 182, 40, 10, 0, '#4e2c48', 0.8, 0.3);             // under the jaw
      // eye sockets, dark under heavy lids
      blob(g, 172, 108, 14, 8, 0, '#5a3446', 0.7, 0.3); blob(g, 211, 108, 14, 8, 0, '#3a2230', 0.8, 0.3);
      // the nose: a lit bridge, its shadow side, the shadow it casts
      stroke(g, [[187, 100], [188, 116], [189, 131]], 6, 5, '#f2b884', 0.75);
      blob(g, 198, 124, 6, 13, 0, '#6a4a6a', 0.6, 0.3);
      blob(g, 193, 139, 11, 4, 0, '#4e2c40', 0.8, 0.3);
      ellipse(g, 187, 136, 2.4, 1.4, 0.2, '#3a1e28', 0.85); ellipse(g, 198, 136, 2.4, 1.4, -0.2, '#3a1e28', 0.9);
      blob(g, 185, 132, 4, 3, 0, '#f6c898', 0.6, 0.4);
      // the sneer: a crease from the left nostril, the upper lip curled up on the left
      stroke(g, [[182, 137], [178, 143], [175, 149]], 2.6, 1.4, '#7a4448', 0.7);
      soft(P([[175, 148], [180, 142], [188, 145], [192, 148], [200, 147], [208, 151], [192, 154]]), '#8a4a4c', 0.8);
      soft(P([[177, 148], [181, 145], [188, 148], [184, 150]]), '#e8dccc', 0.5);
      stroke(g, [[150, 104], [156, 114], [158, 128]], 6, 3, '#e8a678', 0.35);
      blob(g, 192, 157, 12, 4.5, 0, '#d08a6c', 0.9, 0.35);
      blob(g, 192, 164, 11, 3.5, 0, '#5e3a50', 0.7, 0.3);
      // the chin's cleft and the square jaw's lit corner
      stroke(g, [[192, 168], [192.5, 173], [192, 177]], 2, 1.2, '#6a3a44', 0.6);
      blob(g, 158, 154, 6, 9, 0.4, '#d8966c', 0.45, 0.3);
    });
    // brows: the left one heavy and low, the right one cocked
    stroke(g, [[160, 100], [168, 97], [178, 96.5], [185, 98.5]], 5, 3, '#1a1018', 0.95);
    stroke(g, [[200, 97], [208, 93.5], [218, 94], [226, 98]], 5, 3, '#1a1018', 0.95);
    // ---- the hair: a tall swept pompadour, the quiff's front roll over the forehead, long sideburns
    // the shadow the quiff throws on the forehead
    within(face, () => blob(g, 196, 80, 40, 9, 0.05, '#4a2a3a', 0.65, 0.3));
    const hair = P([[148, 112], [138, 90, 136, 58, 146, 38], [152, 22, 166, 10, 184, 9], [208, 8, 232, 20, 244, 38], [254, 58, 250, 92, 238, 112],
      [235, 98, 232, 88, 226, 80], [218, 72, 208, 74, 200, 76], [192, 78, 186, 80, 180, 88], [176, 80, 168, 74, 160, 80], [154, 86, 154, 98, 156, 108]]);
    soft(hair, '#141018', 1.3);
    // a loose lock falling onto the forehead
    soft(P([[178, 74], [186, 76, 186, 86, 180, 96], [178, 88, 178, 82, 174, 78]]), '#16121c', 0.8);
    for (const sd of [-1, 1]) soft(P(sd < 0 ? [[149, 100], [158, 102], [159, 128], [157, 150], [151, 132]] : [[235, 100], [226, 102], [225, 128], [227, 150], [233, 132]]), '#16121c', 0.9);
    within(hair, () => {
      blob(g, 184, 40, 36, 20, -0.2, '#262646', 0.7, 0.3);
      blob(g, 230, 60, 20, 30, 0, '#0e0a14', 0.6, 0.3);
      // strands sweeping up off the front roll, over the crest and back
      for (let i = 0; i < 16; i++) {
        const o = i / 15, x0 = 156 + o * 66, y0 = 84 - o * 8 + range(rnd, -2, 2), pts = [];
        for (let k = 0; k <= 10; k++) { const t = k / 10, a = t * Math.PI; pts.push([x0 + (252 - x0) * (1 - Math.cos(a)) * 0.5 - Math.sin(a) * (22 - o * 12), y0 - Math.sin(a) * (70 - o * 34) + t * t * (14 + o * 16)]); }
        stroke(g, pts, range(rnd, 2, 4.5), 1, pick(rnd, ['#2a2a50', '#22223e', '#30305a', '#1a1a30']), 0.6);
      }
      // the front roll: lit along its top, falling into deep shade under the lip
      blob(g, 200, 74, 30, 5, 0, '#06040a', 0.7, 0.3);
    });
    // the velvet painter's blue: three long strokes riding the wave, a thin bright one on the crest
    const wave = (pts, w0, c, a) => { g.save(); g.filter = 'blur(0.8px)'; stroke(g, pts, w0, 0.8, c, a); g.restore(); };
    wave([[146, 90], [142, 62], [150, 36], [168, 18], [194, 12]], 7, '#3a4a98', 0.8);
    wave([[160, 78], [160, 56], [174, 36], [198, 26], [226, 28]], 5, '#3a4a98', 0.65);
    wave([[182, 76], [198, 62], [218, 50], [238, 48], [248, 62]], 4, '#2e3a80', 0.6);
    wave([[176, 80], [182, 82], [182, 90]], 2.4, '#3a4a98', 0.7);
    wave([[151, 102], [152, 116], [155, 140]], 2.6, '#3a4a98', 0.55);
    blurTile(cv, 0.01);
    { const t = makeCanvas(w, h); t.getContext('2d').drawImage(cv, 0, 0); g.save(); g.filter = 'blur(1px)'; g.drawImage(t, 0, 0); g.restore(); }
    // ---- crisp on top: the crest's glint, the eyes, the lip's light, the rhinestones
    stroke(g, [[145, 70], [147, 46], [160, 24], [184, 13]], 2, 0.6, '#8aa0e8', 0.85);
    stroke(g, [[170, 24], [190, 16], [210, 16]], 1.4, 0.5, '#b8c8f8', 0.7);
    stroke(g, [[164, 72], [172, 60], [188, 52]], 1.2, 0.5, '#8aa0e8', 0.55);
    for (const [ex, ey, white, lid] of [[173, 110, '#e0d0c8', '#24121c'], [211, 110, '#a8909c', '#1a0c14']]) {
      ellipse(g, ex, ey + 0.5, 8, 2.8, 0, white, 0.95);
      ellipse(g, ex - 1.5, ey + 0.4, 3.2, 2.8, 0, '#2a2a3e');
      ellipse(g, ex - 2.4, ey - 0.4, 0.9, 0.8, 0, '#fffbe8', 0.9);
      stroke(g, [[ex - 9, ey + 0.5], [ex - 3, ey - 2.4], [ex + 4, ey - 2.4], [ex + 9, ey]], 3, 2, lid, 0.95);
      line(g, [[ex - 7, ey - 5], [ex + 7, ey - 5.5]], 1.2, '#5a3446', 0.5);
    }
    stroke(g, [[176, 149], [181, 145.5], [188, 148.8], [196, 150.4], [207, 151.5]], 2.2, 1.4, '#2e121a', 0.95);
    line(g, [[178.5, 146.4], [184, 146.2]], 0.9, '#a85a50', 0.6);
    blob(g, 189, 155.5, 5, 1.6, 0, '#f6c4a0', 0.8, 0.5);
    blob(g, 172, 82, 8, 3, -0.1, '#ffe0b4', 0.6, 0.5);
    // rhinestones: settings in deliberate lines down the collar and the V, each with a four-point glint
    const gem = (x, y, r = 1.8, glint = true) => {
      ellipse(g, x + 0.6, y + 0.8, r + 0.8, r + 0.8, 0, '#3a2a40', 0.7); ellipse(g, x, y, r + 0.6, r + 0.6, 0, '#c8a050'); ellipse(g, x, y, r, r, 0, '#eef4ff');
      if (glint) { line(g, [[x - r * 2.6, y], [x + r * 2.6, y]], 0.7, '#ffffff', 0.85); line(g, [[x, y - r * 2.6], [x, y + r * 2.6]], 0.7, '#ffffff', 0.85); }
    };
    const along = (a, b, n, r, gl) => { for (let k = 0; k <= n; k++) { const t = k / n; gem(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, r, gl(k)); } };
    along([112, 142], [146, 192], 6, 1.7, k => k % 2 === 0); along([108, 160], [116, 202], 4, 1.5, k => k === 1);
    along([272, 142], [238, 192], 6, 1.5, k => k === 3); along([174, 210], [190, 244], 4, 1.6, k => k % 2 === 1); along([210, 210], [194, 244], 4, 1.5, () => false);
    for (const [x, y] of [[60, 250], [84, 262], [108, 250], [296, 252], [320, 264]]) gem(x, y, 2, x < 200);
    letters(g, 'E.P.', w - 34, h - 16, 14, { rnd, jit: 0.06, shadow: 0, fill: ['#e8c870', '#c89a40', '#a87a30'], rim: '#1a1008', chip: 0.3, rough: 0.6 });
    glaze(g, w, h, '#ffe0c0', 0.05);
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
  family: F, w: 512, h: 128, note: "a chunky whitewall tire (u wraps round it; v: hub bead → lettered sidewall → whitewall → shoulder → tread → and back): warm charcoal rubber, offset lugs with lit tops and deep grooves, GOBLINYEAR · ROAD KING raised on both sides",
  paint(g, w, rnd, h, cv) {
    const Y = v => (1 - v) * h, T = TIRE_V;
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#2e2a2c'], [0.18, '#3a3436'], [0.38, '#46403e'], [0.5, '#3a3436'], [0.62, '#46403e'], [0.82, '#3a3436'], [1, '#2a2628']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 30; i++) { const x = rnd() * w, y = rnd() * h, rx = range(rnd, 8, 24), ry = range(rnd, 3, 8), c = pick(rnd, ['#4a4244', '#262224', '#524640']); wrapX(w, x, 24, X => blob(g, X, y, rx, ry, 0, c, 0.28, 0.2)); }
    // the shoulders catch the cool sky light
    for (const [a, b] of [[T.wallLo[1], T.treadLo], [T.treadHi, T.wallHi[0]]]) { g.fillStyle = lin(g, 0, Y(b), 0, Y(a), [[0, '#5a6070', 0.05], [0.5, '#5a6070', 0.5], [1, '#5a6070', 0.05]]); g.fillRect(0, Y(b), w, Y(a) - Y(b)); }
    // whitewalls: cream, grimy at the edges, a dark line either side
    for (const [a, b] of [T.wallLo, T.wallHi]) {
      g.fillStyle = lin(g, 0, Y(b), 0, Y(a), [[0, '#b8ac94'], [0.35, '#ece2cc'], [0.7, '#e0d6be'], [1, '#a89c84']]); g.fillRect(0, Y(b), w, Y(a) - Y(b));
      for (let i = 0; i < 22; i++) { const x = rnd() * w, y = range(rnd, Y(b), Y(a)), rx = range(rnd, 4, 14); wrapX(w, x, 14, X => blob(g, X, y, rx, 2, 0, '#8a7a64', 0.3, 0.3)); }
      line(g, [[0, Y(b)], [w, Y(b)]], 1.4, '#1e1a1c', 0.7); line(g, [[0, Y(a)], [w, Y(a)]], 1.4, '#1e1a1c', 0.7);
    }
    // the tread: two rows of chunky lugs, offset half a lug, deep grooves between
    const t0 = Y(T.treadHi), t1 = Y(T.treadLo), mid = (t0 + t1) / 2, n = 24, bw = w / n, gap = 5;
    rect(g, 0, t0 - 6, w, t1 - t0 + 12, '#1c1a1c');
    for (const [row, ya, yb] of [[0, t0 - 7, mid - 2], [1, mid + 2, t1 + 7]]) for (let i = 0; i < n; i++) {
      const x0 = i * bw + (row ? bw / 2 : 0) + gap / 2 + range(rnd, -1, 1), x1 = x0 + bw - gap + range(rnd, -1, 1), sl = row ? -3 : 3;
      const q = [[x0 + sl, ya], [x1 + sl, ya], [x1, yb], [x0, yb]];
      for (const off of [0, -w, w]) {
        const qq = q.map(([a, b]) => [a + off, b]);
        poly(g, qq); g.save(); g.fillStyle = lin(g, 0, ya, 0, yb, row ? [[0, '#4a4644'], [0.4, '#3e3a38'], [1, '#2e2a2c']] : [[0, '#2e2a2c'], [0.6, '#3e3a38'], [1, '#4a4644']]); g.fill(); g.restore();
        line(g, [qq[0], qq[1]], 2, row ? '#6a6460' : '#3a3436', 0.85);       // the lit top edge (toward the light)
        line(g, [qq[0], qq[3]], 1.6, '#6a6460', 0.55);                           // the lit left flank
        line(g, [qq[1], qq[2]], 1.6, '#141214', 0.6);                            // the dark right flank
        line(g, [[(qq[0][0] + qq[1][0]) / 2, ya + 3], [(qq[2][0] + qq[3][0]) / 2, yb - 3]], 1, '#1c1a1c', 0.6);   // a sipe
      }
    }
    // the lugs' ends run onto the shoulders as notches
    for (const [ya, yb] of [[t0 - 16, t0 - 6], [t1 + 6, t1 + 16]]) for (let i = 0; i < n; i++) { const x = i * bw + (ya < t0 ? 0 : bw / 2) + range(rnd, -1, 1); wrapX(w, x, 4, X => { line(g, [[X, ya], [X, yb]], 3, '#1c1a1c', 0.7); line(g, [[X - 2, ya], [X - 2, yb]], 1, '#6a6460', 0.4); }); }
    // raised lettering on both sidewalls: lit on top, a shadow below, a few shades off the rubber
    for (const [a, b] of [T.textLo, T.textHi]) {
      const yc = (Y(a) + Y(b)) / 2, size = (Y(a) - Y(b)) * 0.78, txt = 'GOBLINYEAR \u00b7 ROAD KING \u00b7 ';
      g.save(); g.font = `bold ${size.toFixed(1)}px ${SANS}`; g.textBaseline = 'middle';
      const tw = g.measureText(txt).width, k = (w / 2) / tw;
      for (const off of [0, w / 2]) {
        g.save(); g.translate(off + 4, yc); g.scale(k, 1);
        g.fillStyle = rgba('#141214', 0.7); g.fillText(txt, 1.2, 1.4);
        g.fillStyle = rgba('#7a7470', 0.8); g.fillText(txt, -0.6, -0.8);
        g.fillStyle = '#4a4442'; g.fillText(txt, 0, 0);
        g.restore();
      }
      g.restore();
    }
    // road dust settled in the grooves and the bead
    for (let i = 0; i < 26; i++) { const x = rnd() * w, y = range(rnd, 0, h), rx = range(rnd, 4, 14), ry = range(rnd, 1.5, 3); wrapX(w, x, 14, X => blob(g, X, y, rx, ry, 0, '#8a7458', 0.16, 0.3)); }
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

// The statue's own paint (paint/roadside.js rs_dino), so the head reads as the piece missing off its
// neck: a dark spine band over a green back, an olive flank, a tan belly behind a scalloped painted edge
// with a lit lip and soft folds, irregular plates lit along their rims, big chips of peeled paint over
// pale plaster with a dark lower rim, a crack web, and terracotta plates standing on the spine (the
// statue's are its belly ochre reddened by (0.9, 0.55, 0.47)). The statue stands tall and is seen from
// the side, where the game's sky light is weak and the olive ground bounce strong, so it reads grass
// green; the head lies on the ground with its top to the sky, so its back is the statue's back pulled a
// little toward the flank (warmer, less blue) to read as the same paint. Its light is painted in: the
// left side (u < 0.5) warmer and lighter, the lower right cooler.
const DH = { spine: '#38533e', back: '#436548', back2: '#517451', flank: '#66784c', flank2: '#7a8250', belly: '#c4a468', belly2: '#d6bc86',
  plateB: '#4d7353', plateB2: '#5a805a', plateF: '#6e7a4a', plateF2: '#7e8a56', lit: '#b8c890', shade: '#2e4038',
  fold: '#9a7e4e', foldLit: '#f0dcae', scallop: '#f0dca8', chip: '#d8c8b4', crack: '#2e3430',
  terra: '#b45c32', terra2: '#c1673f', terraL: '#d8794f', terraD: '#6a3022',
  pink: '#a84858', pink2: '#c86476', pinkD: '#5a1e2c', lip: '#3a2422' };
// One plate: a lumpy oval (rx across, ry along), its shadow thrown away from the spine, a fill lit on
// the spine side, a brushed rim of light along that side.
function dinoPlate(g, X, Y, rx, ry, side, base, k, pr) {
  const pts = [];
  for (let q = 0; q < 10; q++) { const a = q / 10 * TAU, rr = range(pr, 0.82, 1.1); pts.push([X + Math.cos(a) * rx * rr, Y + Math.sin(a) * ry * rr]); }
  poly(g, pts.map(([u, v]) => [u + side * 2.4, v + 2])); g.fillStyle = rgba(DH.shade, 0.36 * k); g.fill();
  g.save(); poly(g, pts); g.globalAlpha = 0.55 * k;
  g.fillStyle = lin(g, X - side * rx, 0, X + side * rx, 0, [[0, lightOf(base, 0.25)], [0.45, base], [1, shadowOf(base, 0.25)]]); g.fill(); g.restore();
  // the lit rim on the spine side (the outline's points facing -side)
  const rim = side > 0 ? [pts[4], pts[5], pts[6], pts[7]] : [pts[9], pts[0], pts[1], pts[2]];
  stroke(g, rim.map(([u, v]) => [u - side * 0.8, v]), 2.6 * k + 0.6, 0.8, DH.lit, 0.62 * k);
  if (pr() < 0.45) stroke(g, (side > 0 ? [pts[9], pts[0], pts[1]] : [pts[4], pts[5], pts[6]]).map(([u, v]) => [u + side, v]), 1.8, 0.6, DH.shade, 0.35 * k);
}
// Rows of plates either side of the spine line X = cx (rows run along Y): [dist, rx, ry, k] per row, the
// spine row (dist 0) once; they wrap round the canvas's x edges.
function dinoPlates(g, w, rnd, { cx, rows, y0, y1, fadeY = 0, from = 4 }) {
  for (const [dist, rx, ry, k] of rows) for (const side of dist ? [-1, 1] : [1]) {
    for (let Y = y0 + range(rnd, 0, ry); Y < y1 + ry; Y += 2 * ry * range(rnd, 0.95, 1.25)) {
      const fy = fadeY ? Math.min(1, Math.max(0, (Y - from) / fadeY)) : 1;
      if (fy <= 0.05 || rnd() < 0.07) continue;
      const X = cx + side * dist + range(rnd, -3, 3), sc = range(rnd, 0.85, 1.15), ps = Math.floor(rnd() * 1e9);
      const base = dist < 60 ? mix(DH.plateB, DH.plateB2, rnd()) : mix(DH.plateF, DH.plateF2, rnd());
      wrapX(w, X, rx * 2, XX => dinoPlate(g, XX, Y, rx * sc, ry * sc, side, base, k * fy, rngFrom(ps)));
    }
  }
}
// The statue's painted belly edge: the tan rises into the olive in scallops along Y (x0 = the belly
// side's canvas edge, dir = +1 / -1 into the flank), a cool shadow line above it, a lit lip below it.
function bellyEdge(g, rnd, x0, dir, xe, ya, yb, n, amp = 8) {
  const edge = [], W = (yb - ya) / n;
  for (let i = 0; i < n; i++) { const sc = range(rnd, 0.8, 1.2); for (let q = 0; q <= 8; q++) { const t = q / 8, y = ya + (i + t) * W; edge.push([xe + dir * (Math.sin(Math.PI * t) * amp * sc + Math.sin(y * 0.3) * 0.8), y]); } }
  const shape = [...edge, [x0 - dir * 2, yb], [x0 - dir * 2, ya]];
  poly(g, shape.map(([u, v]) => [u + dir * 3, v])); g.fillStyle = rgba(DH.shade, 0.3); g.fill();
  poly(g, shape); g.fillStyle = lin(g, xe, 0, x0, 0, [[0, '#d2b47a'], [0.2, '#c8a86a'], [1, '#dcc290']]); g.fill();
  line(g, edge.map(([u, v]) => [u - dir * 2, v]), 2.2, DH.scallop, 0.55);
}
// soft folds across the belly paint, as on the statue's: short, curving, unevenly spaced, lit on one side
// (pts run across the fold; the lit stroke is offset by [ox, oy])
function belFold(g, pts, wd, ox, oy) {
  stroke(g, pts, wd, wd * 0.3, DH.fold, 0.3);
  stroke(g, pts.map(([u, v]) => [u + ox, v + oy]), 2, 0.8, DH.foldLit, 0.32);
}
// peeled paint over pale plaster, as on the statue: a lumpy chip, its lower rim dark, its top edge lit
function peel(g, rnd, x, y, r) {
  const pts = []; for (let k = 0; k < 9; k++) { const a = k / 9 * TAU, rr = r * range(rnd, 0.5, 1.2); pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr * 0.7]); }
  poly(g, pts.map(([u, v]) => [u + 0.8, v + 1])); g.fillStyle = rgba('#3a3028', 0.35); g.fill();
  poly(g, pts); g.fillStyle = rgba(pick(rnd, [DH.chip, DH.chip, '#d0bea8']), 0.97); g.fill();
  line(g, pts.slice(1, 5).map(([u, v]) => [u, v + 1]), 2, '#5a5048', 0.55);
  line(g, pts.slice(5, 9).map(([u, v]) => [u, v - 1]), 1.6, '#e8f0c8', 0.6);
}
// the statue's crack web: hairlines out from one spot, each lit along one side
function crackWeb(g, rnd, cx, cy, n = 6, reach = [5, 10]) {
  for (let k = 0; k < n; k++) {
    let px = cx, py = cy, aa = k / n * TAU + rnd() * 0.5; const pts = [[cx, cy]];
    for (let q = 0; q < 5; q++) { aa += (rnd() - 0.5) * 0.8; px += Math.cos(aa) * range(rnd, reach[0], reach[1]); py += Math.sin(aa) * range(rnd, reach[0] * 0.8, reach[1] * 0.8); pts.push([px, py]); }
    stroke(g, pts.map(([u, v]) => [u + 0.8, v + 0.8]), 1.8, 0.5, '#e8f0c8', 0.25);
    stroke(g, pts, 1.5, 0.3, DH.crack, 0.6);
  }
}
register('loot_dinohead', {
  family: F, w: 512, h: 256, note: "the dino head and neck (u round, 0.5 = the spine; v from behind the neck's break up to the snout at the top) in the statue's paint (rs_dino): a dark spine band, green back, olive flank, plates lit on their rims, the tan throat behind a scalloped edge, peeled chips and a crack web; painted light; a smiling lip line round the pink roof of the mouth",
  paint(g, w, rnd, h, cv) {
    const D = DINO, Yz = z => (D.z1 - z) / (D.z1 - D.z0) * h, yH = Yz(D.hinge), cx = w / 2;
    // the hide across the head: belly (edges) → flank → back (middle), the left side a touch warmer
    g.fillStyle = lin(g, 0, 0, w, 0, [[0, DH.belly2], [0.09, DH.belly], [0.15, DH.flank2], [0.25, DH.flank], [0.37, DH.back2], [0.5, DH.back], [0.63, DH.back2], [0.75, '#5e7248'], [0.85, '#6e7848'], [0.91, '#b49a62'], [1, DH.belly2]]);
    g.fillRect(0, 0, w, h);
    mottle(g, w, rnd, { colors: ['#557c5a', '#62784a', '#4a6a50', '#6e8456'], count: 26, rmin: 16, rmax: 44, alpha: 0.2, hard: 0.1 });
    // painted light: warm and lit on the upper left, cool on the lower right
    blob(g, cx - 96, h * 0.5, 50, h * 0.62, 0, '#c4c886', 0.18, 0.15);
    blob(g, cx - 40, h * 0.45, 26, h * 0.6, 0, '#d4d498', 0.08, 0.2);
    blob(g, cx + 150, h * 0.5, 54, h * 0.66, 0, '#2c3a40', 0.22, 0.15);
    // the dome and muzzle are smooth painted plaster: the paint laid on in broad soft patches, lighter
    // on the lit (left) side, cooler on the right, and brushed along the head's length to show its form
    for (let i = 0; i < 16; i++) {
      const sd = rnd() < 0.5 ? -1 : 1, X = cx + sd * range(rnd, 8, 135), Y = range(rnd, 8, yH + 12), lit = rnd() < (sd < 0 ? 0.72 : 0.28);
      const col = lit ? pick(rnd, ['#66885a', '#70905c', '#7a965e', '#80985c']) : pick(rnd, ['#33503c', '#3a5a42', '#465a38', '#2e4a3a']);
      wrapX(w, X, 60, XX => blob(g, XX, Y, range(rnd, 22, 48), range(rnd, 16, 34), range(rnd, -0.5, 0.5), col, 0.24, 0.18));
    }
    for (let i = 0; i < 26; i++) {
      const sd = i % 2 ? 1 : -1, X = cx + sd * range(rnd, 12, 125), Y = range(rnd, 10, yH), L = range(rnd, 26, 64);
      line(g, [[X, Y], [X + range(rnd, -4, 4), Y + L * 0.5], [X + range(rnd, -6, 6), Y + L]], range(rnd, 3, 7), sd < 0 ? DH.lit : '#2a4234', sd < 0 ? 0.12 : 0.15);
    }
    // plates only where the statue has them: one row down the spine from behind the nostrils, and the
    // plated hide on the back of the skull and the neck (bigger and bolder there, as on the statue)
    dinoPlates(g, w, rnd, { cx, y0: 26, y1: h, from: 22, fadeY: 24, rows: [[0, 14, 19, 0.95]] });
    dinoPlates(g, w, rnd, { cx, y0: yH - 6, y1: h, from: yH - 8, fadeY: 30, rows: [[38, 16, 19, 0.9], [78, 14, 17, 0.72], [112, 12, 14, 0.5]] });
    // the darker spine band over it all
    g.fillStyle = lin(g, cx - 34, 0, cx + 34, 0, [[0, DH.spine, 0], [0.35, DH.spine, 0.5], [0.65, DH.spine, 0.5], [1, DH.spine, 0]]); g.fillRect(cx - 34, 0, 68, h);
    // eye sockets: a cool shadow under and behind each eye, a warm lit brow over it
    for (const sd of [-1, 1]) {
      const ex = cx + sd * D.eye.u * w, ey = Yz(D.eye.z);
      blob(g, ex + sd * 18, ey + 10, 34, 30, 0, '#26382e', 0.42, 0.25);
      blob(g, ex - sd * 24, ey - 4, 22, 34, 0, '#ccd094', sd < 0 ? 0.3 : 0.16, 0.25);
    }
    // nostrils: dark rims, lit on the spine side
    for (const sd of [-1, 1]) { const nx = cx + sd * D.nostril.u * w, ny = Yz(D.nostril.z); blob(g, nx + sd * 5, ny + 2, 14, 11, 0, '#263828', 0.5, 0.35); blob(g, nx - sd * 6, ny - 2, 8, 7, 0, DH.lit, 0.35, 0.4); }
    // under the head behind the hinge: the statue's tan throat behind its scalloped edge, folds round it
    bellyEdge(g, rnd, 0, 1, 0.19 * w, yH - 6, h + 4, 6);
    bellyEdge(g, rnd, w, -1, 0.81 * w, yH - 6, h + 4, 6);
    for (const x0 of [0, w]) {
      const dir = x0 ? -1 : 1;
      for (let Y = yH + range(rnd, 6, 12); Y < h; Y += range(rnd, 12, 20)) {
        const L = range(rnd, 40, 70), bend = range(rnd, -5, 5), pts = [];
        for (let q = 0; q <= 6; q++) { const t = q / 6; pts.push([x0 + dir * L * t, Y + bend * Math.sin(t * Math.PI) + t * 2]); }
        belFold(g, pts, range(rnd, 4, 6), 0, -2.5);
      }
    }
    // the roof of the mouth: pink inside the lip line from just behind the chin back to the hinge (the
    // overhanging tip of the snout stays hide), palate ridges, darker toward the throat
    const lipX = D.lipU * w, yC = Yz(D.jaw[D.jaw.length - 2].z);
    for (const sd of [-1, 1]) {
      const edge = sd < 0 ? lipX : w - lipX, x0 = sd < 0 ? -8 : edge, x1 = sd < 0 ? edge : w + 8;
      clip(g, () => { g.beginPath(); g.rect(x0, yC, x1 - x0, yH - yC); }, () => {
        g.fillStyle = lin(g, 0, yC, 0, yH, [[0, DH.pink2], [0.45, DH.pink], [1, DH.pinkD]]); g.fillRect(x0, yC, x1 - x0, yH - yC);
        for (let Y = yC + 6; Y < yH - 6; Y += range(rnd, 10, 14)) {
          const pts = []; for (let X = x0; X <= x1; X += 6) pts.push([X, Y + Math.sin(X * 0.15) * 1.5]);
          line(g, pts.map(([a, b]) => [a, b + 2]), 2.4, DH.pinkD, 0.45); line(g, pts, 1.6, '#e08c98', 0.4);
        }
      });
      // the lip: a dark line, a lit tan roll above it (the statue's belly paint edging the mouth), turning
      // up toward the spine into a smile at the hinge
      const lp = [], hp = [];
      for (let Y = -4; Y <= yH - 6; Y += 6) { const wob = Math.sin(Y * 0.09) * 1.2; lp.push([edge + wob, Y]); hp.push([edge - sd * 7 + wob, Y]); }
      const curl = [[edge, yH - 2], [edge - sd * 8, yH + 8], [edge - sd * 20, yH + 13], [edge - sd * 30, yH + 12]];
      stroke(g, [...hp, ...curl.slice(1).map(([a, b]) => [a - sd * 5, b - 5])], 8, 4, '#c4a468', 0.55);
      stroke(g, [...lp, ...curl], 4.2, 1.6, DH.lip, 0.9);
      line(g, hp.map(([a, b]) => [a - sd * 2, b]), 1.4, DH.scallop, 0.55);
      // the cheek's round fold above the corner of the smile
      g.save(); g.globalAlpha = 0.4; g.strokeStyle = DH.shade; g.lineWidth = 2; g.lineCap = 'round';
      g.beginPath(); g.ellipse(edge - sd * 28, yH + 4, 10, 14, 0, sd < 0 ? Math.PI * 0.6 : -Math.PI * 0.4, sd < 0 ? Math.PI * 1.4 : Math.PI * 0.4); g.stroke(); g.restore();
    }
    // the statue's big chips of peeled paint, low on the flanks and back on the skull (never dotted over
    // the dome, where they'd read as a frog's spots), its crack web on the right flank by the neck, a few
    // hairline cracks, rain streaks running down the flanks
    for (const [sd, ux, yy, r] of [[-1, 0.27, 0.78, 13], [1, 0.3, 0.5, 11], [-1, 0.33, 0.92, 9], [1, 0.22, 0.86, 12], [-1, 0.2, 0.42, 8]]) peel(g, rnd, cx + sd * ux * w, yy * h + range(rnd, -4, 4), r);
    crackWeb(g, rnd, cx + 0.2 * w, h * 0.7);
    cracks(g, h, rnd, { color: DH.crack, count: 6, len: [16, 40], width: [0.7, 1.2], alpha: 0.34 });
    for (let i = 0; i < 18; i++) {
      const sd = rnd() < 0.5 ? -1 : 1, X = cx + sd * range(rnd, 20, 150), Y = range(rnd, 0, h), L = range(rnd, 20, 60);
      line(g, [[X, Y], [X + sd * L * 0.5, Y + range(rnd, -3, 3)], [X + sd * L, Y + range(rnd, -4, 4)]], range(rnd, 1.2, 2.4), pick(rnd, ['#3a4a3a', '#6a6044']), 0.12);
    }
    // grime and chipped paint toward the broken neck
    g.fillStyle = lin(g, 0, h * 0.86, 0, h, [[0, '#4a4438', 0], [1, '#4a4438', 0.32]]); g.fillRect(0, h * 0.86, w, h * 0.14);
    for (let i = 0; i < 5; i++) { const x = rnd() * w; wrapX(w, x, 12, X => peel(g, rnd, X, h - range(rnd, 4, 14), range(rnd, 4, 7))); }
    glaze(g, w, h, '#ffe8b8', 0.1);
    blurTile(cv, 0.5);
  },
});
register('loot_dinojaw', {
  family: F, w: 256, h: 128, note: "the dino's lower jaw (u round, 0.5 = the floor of the mouth; v hinge → chin at the top): pink floor, the lower lip, plated olive flanks, and the statue's tan belly paint over the lower half behind its scalloped edge, folds round the chin",
  paint(g, w, rnd, h, cv) {
    const cx = w / 2, lipX = DINO.jawLipU * w;
    g.fillStyle = lin(g, 0, 0, w, 0, [[0, DH.belly2], [0.2, DH.belly], [0.32, DH.flank2], [0.37, DH.flank], [0.42, '#5a7250'], [0.5, '#5a7250'], [0.58, '#5a7250'], [0.63, '#62724a'], [0.68, '#727a4a'], [0.8, '#b49a62'], [1, DH.belly2]]);
    g.fillRect(0, 0, w, h);
    mottle(g, w, rnd, { colors: ['#62784a', '#6e8456', '#7a8250'], count: 14, rmin: 10, rmax: 26, alpha: 0.22, hard: 0.1 });
    blob(g, cx - 64, h * 0.5, 26, h * 0.7, 0, '#c4c886', 0.18, 0.2);
    blob(g, cx + 70, h * 0.5, 30, h * 0.7, 0, '#2c3a40', 0.22, 0.2);
    // one row of plates along the flank just under the lip: "up" (the lit side) is toward the lip
    for (const sd of [-1, 1]) {
      const prs = rngFrom(sd > 0 ? 'jaw-r' : 'jaw-l');
      for (let Y = 6; Y < h + 10; Y += 2 * 11 * range(prs, 0.95, 1.2)) {
        const X = cx + sd * (lipX + 14) + range(prs, -1.5, 1.5), base = mix(DH.plateF, DH.plateF2, prs());
        dinoPlate(g, X, Y, 8, 10, sd, base, 0.85, rngFrom(Math.floor(prs() * 1e9)));
      }
    }
    // the statue's tan belly over the lower half of the jaw, behind its scalloped edge, folds round the chin
    bellyEdge(g, rnd, 0, 1, 0.33 * w, -4, h + 4, 4, 5);
    bellyEdge(g, rnd, w, -1, 0.67 * w, -4, h + 4, 4, 5);
    for (const x0 of [0, w]) {
      const dir = x0 ? -1 : 1;
      for (let Y = range(rnd, 4, 10); Y < h; Y += range(rnd, 11, 16)) {
        const L = range(rnd, 50, 76), pts = [];
        for (let q = 0; q <= 5; q++) { const t = q / 5; pts.push([x0 + dir * L * t, Y + range(rnd, -1, 1) - t * 2]); }
        belFold(g, pts, range(rnd, 3.5, 5), 0, -2.2);
      }
    }
    // the floor of the mouth, inside the lip
    clip(g, () => { g.beginPath(); g.rect(cx - lipX, -2, 2 * lipX, h + 4); }, () => {
      g.fillStyle = lin(g, 0, 0, 0, h, [[0, DH.pink2], [0.5, DH.pink], [1, DH.pinkD]]); g.fillRect(0, 0, w, h);
      g.fillStyle = lin(g, cx - lipX, 0, cx + lipX, 0, [[0, DH.pinkD, 0.6], [0.3, DH.pinkD, 0], [0.7, DH.pinkD, 0], [1, DH.pinkD, 0.6]]); g.fillRect(cx - lipX, 0, 2 * lipX, h);
    });
    for (const sd of [-1, 1]) {
      const edge = cx + sd * lipX, lp = [], hp = [];
      for (let Y = -4; Y <= h + 4; Y += 6) { const wob = Math.sin(Y * 0.11) * 1; lp.push([edge + wob, Y]); hp.push([edge + sd * 6 + wob, Y]); }
      stroke(g, hp, 7, 6, '#c4a468', 0.5); stroke(g, lp, 3.6, 3.6, DH.lip, 0.9); line(g, hp.map(([a, b]) => [a + sd * 1.5, b]), 1.2, DH.scallop, 0.5);
    }
    // a chip of peeled paint on each flank, a hairline crack or two
    for (const sd of [-1, 1]) peel(g, rnd, cx + sd * range(rnd, 66, 84), range(rnd, 24, h - 24), range(rnd, 6, 8));
    cracks(g, w, rnd, { color: DH.crack, count: 2, len: [12, 26], width: [0.7, 1], alpha: 0.3 });
    glaze(g, w, h, '#ffe8b8', 0.1);
    blurTile(cv, 0.5);
  },
});
register('loot_dinomouth', {
  family: F, w: 256, h: 64, note: "inside the dino's mouth: the cavity (u round, v throat → lips at the top), the tongue from above, a plain strip of the statue's green hide and one of its terracotta plate paint for the small bumps (u across, v underside → lit top)",
  paint(g, w, rnd, h, cv) {
    // the cavity: deep maroon, darkest at the throat, soft folds down the cheeks
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#7a2a38'], [0.5, '#4e1a26'], [1, '#2c0e16']]); g.fillRect(0, 0, 64, h);
    for (const x of [16, 48]) for (let k = 0; k < 3; k++) line(g, [[x - 6 + k * 6, 2], [x - 5 + k * 6, h - 2]], 2, '#2a0c12', 0.35);
    blob(g, 32, 4, 30, 8, 0, '#a8485a', 0.35, 0.3);
    // the tongue: pink, a lit top, darker sides, a groove down the middle, the tip at the top
    const tx = 96;
    rect(g, 64, 0, 64, h, '#8a3442');
    g.fillStyle = lin(g, 64, 0, 128, 0, [[0, '#6a2232'], [0.3, '#b85060'], [0.45, '#d47484'], [0.55, '#c86070'], [0.75, '#a84858'], [1, '#6a2232']]); g.fillRect(64, 0, 64, h);
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#f0a0a8', 0.25], [0.3, '#f0a0a8', 0], [0.8, '#3a0e18', 0], [1, '#3a0e18', 0.45]]); g.fillRect(64, 0, 64, h);
    stroke(g, [[tx, 6], [tx + 0.5, 30], [tx, 56]], 2.4, 1.2, '#6a2232', 0.7);
    line(g, [[tx - 2.5, 8], [tx - 2.5, 52]], 1, '#f4b4bc', 0.4);
    for (let i = 0; i < 26; i++) ellipse(g, range(rnd, 72, 120), range(rnd, 4, 60), 1, 0.8, 0, rnd() < 0.5 ? '#e89aa4' : '#7a2a38', 0.5);
    // a plain strip of the statue's hide for the small bumps (brows, lids, cheeks, nostrils): u across,
    // v from the underside (bottom) to the lit top: no plates to smear, just form, lit from the left
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#a4b47e'], [0.18, '#748a5a'], [0.45, DH.back2], [0.75, '#38533e'], [1, '#22362a']]); g.fillRect(128, 0, 64, h);
    g.fillStyle = lin(g, 128, 0, 192, 0, [[0, '#d4d498', 0.14], [0.45, '#d4d498', 0], [0.6, '#22303a', 0], [1, '#22303a', 0.2]]); g.fillRect(128, 0, 64, h);
    for (let i = 0; i < 10; i++) blob(g, range(rnd, 132, 188), range(rnd, 6, h - 6), range(rnd, 4, 10), range(rnd, 3, 6), 0, pick(rnd, ['#5a7e5a', '#3e5a44', '#7a8a58']), 0.3, 0.3);
    // the statue's terracotta spine-plate paint: the belly's ochre reddened, a lit cream-orange top
    // where the plate catches the light, darker down its sides, faint upright streaks (the belly folds)
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#e6a070'], [0.14, DH.terraL], [0.36, DH.terra2], [0.66, DH.terra], [1, DH.terraD]]); g.fillRect(192, 0, 64, h);
    g.fillStyle = lin(g, 192, 0, 256, 0, [[0, '#f0c088', 0.18], [0.45, '#f0c088', 0], [0.6, '#3a1810', 0], [1, '#3a1810', 0.28]]); g.fillRect(192, 0, 64, h);
    for (let i = 0; i < 7; i++) { const x = range(rnd, 198, 250), y0 = range(rnd, 10, 26); stroke(g, [[x, y0], [x + range(rnd, -2, 2), y0 + range(rnd, 16, 30)]], range(rnd, 2.5, 4), 1, '#8a4426', 0.22); }
    for (let i = 0; i < 6; i++) blob(g, range(rnd, 198, 250), range(rnd, 8, h - 8), range(rnd, 4, 8), range(rnd, 3, 5), 0, pick(rnd, ['#c87048', '#a4502c', '#d88a58']), 0.3, 0.3);
    blurTile(cv, 0.4);
  },
});
register('loot_eye', {
  family: F, w: 128, h: 64, note: "the dino's eye (a sphere: u wraps, front in the middle): ivory, a big warm amber-brown iris, a big round friendly pupil, two catchlights, the lid's shadow over the top",
  paint(g, w, rnd, h, cv) {
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#a89c80'], [0.35, '#f0e6cc'], [0.6, '#f4ecd4'], [1, '#a89c80']]); g.fillRect(0, 0, w, h);
    g.fillStyle = lin(g, 0, 0, w, 0, [[0, '#8a7e68', 0.5], [0.3, '#8a7e68', 0], [0.7, '#8a7e68', 0], [1, '#8a7e68', 0.5]]); g.fillRect(0, 0, w, h);
    const x = w / 2, y = h / 2 + 2;
    ellipse(g, x + 1, y + 1, 15, 14.5, 0, '#4a2a10', 0.6);
    g.fillStyle = radial(g, x - 3, y - 3, 1, 14.5, [[0, '#e8b860'], [0.5, '#b87a2a'], [0.85, '#7a4a1a'], [1, '#4a2a10']]); g.beginPath(); g.arc(x, y, 14, 0, TAU); g.fill();
    for (let k = 0; k < 18; k++) { const a = k / 18 * TAU; line(g, [[x + Math.cos(a) * 8, y + Math.sin(a) * 8], [x + Math.cos(a) * 12.5, y + Math.sin(a) * 12.5]], 0.8, k % 2 ? '#f0c878' : '#6a4014', 0.4); }
    g.fillStyle = radial(g, x, y, 0, 8.5, [[0, '#1a1008'], [0.85, '#2a1a0c'], [1, '#4a2a10']]); g.beginPath(); g.arc(x, y + 0.5, 8.2, 0, TAU); g.fill();
    blob(g, x - 4.5, y - 4.5, 3.8, 3.2, 0, '#fffbe8', 1, 0.6);
    ellipse(g, x + 3.5, y + 3.5, 1.4, 1.2, 0, '#fffbe8', 0.75);
    g.fillStyle = lin(g, 0, 0, 0, h, [[0, '#3a2818', 0.55], [0.32, '#3a2818', 0], [1, '#3a2818', 0]]); g.fillRect(0, 0, w, h);
    blurTile(cv, 0.35);
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
  family: F, size: 64, note: 'the broken neck seen face on: a thin rim of the statue\'s green paint, chunky pale plaster with lit broken edges, a small dark hollow',
  paint(g, s, rnd, h, cv) {
    const c = s / 2;
    rect(g, 0, 0, s, s, '#4c6a4c');
    g.fillStyle = radial(g, c - 2, c - 3, 2, c, [[0, '#b0a898'], [0.85, '#9e9686'], [0.93, '#6a7656'], [1, '#4c6a4c']]); g.beginPath(); g.arc(c, c, c, 0, TAU); g.fill();
    // broken chunks: lit on their upper left, shaded lower right
    for (let i = 0; i < 16; i++) {
      const a = rnd() * TAU, r = range(rnd, 0.2, 0.8) * c * 0.9, x = c + Math.cos(a) * r, y = c + Math.sin(a) * r, rr = range(rnd, 3, 7);
      const pts = []; for (let k = 0; k < 6; k++) { const b = k / 6 * TAU, q = rr * range(rnd, 0.6, 1.2); pts.push([x + Math.cos(b) * q, y + Math.sin(b) * q]); }
      poly(g, pts.map(([p, q]) => [p + 1.2, q + 1.4])); g.fillStyle = rgba('#4a443e', 0.55); g.fill();
      poly(g, pts); g.fillStyle = pick(rnd, ['#b8b0a0', '#a49c8e', '#c4bcaa']); g.fill();
      line(g, pts.slice(3, 6), 1, '#e8e0cc', 0.8);
    }
    // the hollow of the fiberglass shell, off center
    blob(g, c + 3, c + 2, 12, 10, 0.3, '#2a2024', 0.95, 0.55);
    blob(g, c + 1, c + 1, 6, 5, 0.3, '#1c1418', 0.9, 0.5);
    line(g, [[c - 8, c - 5], [c - 2, c - 9], [c + 8, c - 8]], 1.4, '#d8d0bc', 0.6);
    for (let k = 0; k < 10; k++) { const a = k / 10 * TAU + rnd() * 0.3; line(g, [[c + Math.cos(a) * c * 0.5, c + Math.sin(a) * c * 0.5], [c + Math.cos(a) * c * 0.88, c + Math.sin(a) * c * 0.88]], 0.9, '#5a544a', 0.5); }
    blurTile(cv, 0.3);
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
  family: F, w: 256, h: 64, note: "the register's ivory key caps from above, 8 × 2: domed ivory lit upper left, a brass rim, the digits and coins painted big in umber",
  paint(g, w, rnd, h, cv) {
    rect(g, 0, 0, w, h, '#b8902e');
    for (let i = 0; i < 16; i++) {
      const x = (i % 8) * 32 + 16, y = Math.floor(i / 8) * 32 + 16;
      g.fillStyle = radial(g, x, y, 12, 16, [[0, '#7a5418'], [0.4, '#e8c060'], [1, '#8a6420']]); g.fillRect(x - 16, y - 16, 32, 32);
      g.fillStyle = radial(g, x - 4, y - 5, 1, 14, [[0, '#fffbee'], [0.55, '#f0e6cc'], [0.85, '#d8c8a0'], [1, '#a89068']]); g.beginPath(); g.arc(x, y, 13.2, 0, TAU); g.fill();
      const t = KEY_LABELS[i], sz = t.length > 2 ? 10.5 : t.length > 1 ? 13 : 19;
      g.save(); g.font = `bold ${sz}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = rgba('#fffaf0', 0.8); g.fillText(t, x - 0.6, y + 0.4); g.fillStyle = '#4a2a14'; g.fillText(t, x, y + 1.2); g.restore();
      blob(g, x - 6, y - 7, 4, 2.4, -0.5, '#ffffff', 0.7, 0.4);
    }
    blurTile(cv, 0.25);
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

// Strata for the slab-built boulders: band edges in v (0 = the ground, 1 = the top). props3d stacks
// its slabs on some of these edges, so every geometric ledge sits on a painted one.
export const BOULDER_BANDS = { badlands: [0, 0.2, 0.42, 0.6, 0.78, 1], desert: [0, 0.27, 0.5, 0.74, 1] };
// The stone: the world's own rock (nature family) when it's there, the zone's character painted over
// it (strata, lichen, wind grooves, cold cracks). v = height, so bands stay level.
const BOULDER = {
  meadow: { rock: 'rock_gray', base: '#77746e', cols: ['#97918a', '#6a675f', '#8a857c'], ground: '#4a4030' },
  fields: { rock: 'rock_warm', base: '#8a8170', cols: ['#9a9080', '#766e60', '#a49a86'], ground: '#7a6040' },
  snow: { rock: 'rock_granite', base: '#6f7682', cols: ['#8e96a3', '#5e6470', '#7a828e'], ground: '#5a5e6a' },
  badlands: { rock: 'rock_red', base: '#a04a2a', cols: ['#b4552f', '#8e3e22', '#cf7a45'], ground: '#8a5a38',
    bands: ['#a8482a', '#7e3420', '#e8b886', '#b4552f', '#cf7a45'], lit: '#f4c898', under: '#5e2a1e' },
  desert: { rock: 'rock_sand', base: '#b7895e', cols: ['#d4ab7c', '#a87a50', '#c89a6a'], ground: '#b89060',
    bands: ['#c8986a', '#a87a50', '#ecd0a0', '#c89a6a'], lit: '#f8e0b4', under: '#7a5434' },
};
function boulderPaint(g, w, rnd, h, biome) {
  const B = BOULDER[biome];
  const Y = v => (1 - v) * h;
  if (has(B.rock)) { const src = canvasFor(B.rock); g.drawImage(src, 0, 0, w / 2, h); g.drawImage(src, w / 2, 0, w / 2, h); }
  else fill(g, w, h, B.base);
  if (B.bands) {
    // 4–5 broad strata, soft edged; within each a couple of faint thin beds
    const E = BOULDER_BANDS[biome];
    for (let i = 0; i < E.length - 1; i++) {
      const y0 = Y(E[i + 1]), y1 = Y(E[i]), c = B.bands[i % B.bands.length];
      g.save(); g.filter = 'blur(3px)'; g.globalAlpha = 0.72; g.fillStyle = c; g.fillRect(-8, y0 - 2, w + 16, y1 - y0 + 4); g.restore();
      for (let k = 0; k < 3; k++) { const yy = range(rnd, y0 + 6, y1 - 6), ph = rnd() * TAU; const pts = []; for (let x = 0; x <= w; x += 16) pts.push([x, yy + Math.sin(x / w * TAU * 2 + ph) * 2]); line(g, pts, range(rnd, 1, 2.4), pick(rnd, [lightOf(c, 0.3), shadowOf(c, 0.3)]), 0.35); }
      for (let k = 0; k < 10; k++) { const x = rnd() * w, r = range(rnd, 14, 40); wrapX(w, x, r, X => blob(g, X, range(rnd, y0, y1), r, range(rnd, 4, 10), 0, pick(rnd, [lightOf(c, 0.25), shadowOf(c, 0.25)]), 0.25, 0.2)); }
    }
    // at every edge: the lit top of the bed below (a ledge's rounded lip) and the cool dark of the one above
    // (the slabs ledge at the even edges; the odd ones are undercut grooves in the rock)
    for (let i = 1; i < E.length; i++) {
      const y = Y(E[i]), ledge = i % 2 === 0 || i === E.length - 1;
      if (!ledge && i > 1) { g.fillStyle = lin(g, 0, y - 6, 0, y + 6, [[0, B.under, 0], [0.5, B.under, 0.3], [1, B.under, 0]]); g.fillRect(0, y - 6, w, 12); continue; }
      if (ledge) {
        g.fillStyle = lin(g, 0, y, 0, y + 12, [[0, B.lit, 0.7], [1, B.lit, 0]]); g.fillRect(0, y, w, 12);
        for (let k = 0; k < 14; k++) { const x = rnd() * w, L = range(rnd, 20, 70); wrapX(w, x, L, X => stroke(g, [[X, y + 2], [X + L * 0.5, y + 2.5 + range(rnd, -1, 1)], [X + L, y + 2]], 2.2, 0.6, '#fff4dc', 0.45)); }
        if (i < E.length - 1) { g.fillStyle = lin(g, 0, y, 0, y - 14, [[0, B.under, 0.75], [1, B.under, 0]]); g.fillRect(0, y - 14, w, 14); }
      } else {
        g.fillStyle = lin(g, 0, y - 10, 0, y + 10, [[0, B.under, 0], [0.45, B.under, 0.55], [0.6, B.under, 0.35], [1, B.lit, 0.3]]); g.fillRect(0, y - 10, w, 20);
      }
    }
    // weathering: vertical streaks and soft vertical fracture shadows
    for (let i = 0; i < 18; i++) { const x = rnd() * w, y0 = rnd() * h * 0.7, L = range(rnd, 30, 110); wrapX(w, x, 6, X => line(g, [[X, y0], [X + range(rnd, -2, 2), y0 + L]], range(rnd, 1.5, 4), pick(rnd, [B.under, shadowOf(B.base, 0.4)]), 0.2)); }
    for (let i = 0; i < 4; i++) { const x = rnd() * w, y0 = range(rnd, 0.1, 0.6) * h, L = range(rnd, 30, 70); wrapX(w, x, 10, X => { stroke(g, [[X, y0], [X + range(rnd, -3, 3), y0 + L * 0.5], [X + range(rnd, -4, 4), y0 + L]], 3, 1, B.under, 0.35); line(g, [[X - 3, y0 + 4], [X - 3 + range(rnd, -3, 3), y0 + L * 0.8]], 1.2, B.lit, 0.25); }); }
    if (biome === 'desert') for (let i = 0; i < 22; i++) {         // wind-scoured grooves
      const yy = rnd() * h, x0 = rnd() * w, L = range(rnd, 60, 200);
      wrapX(w, x0 + L / 2, L, X => { line(g, [[X - L / 2, yy], [X + L / 2, yy + range(rnd, -2, 2)]], range(rnd, 1.5, 3), '#8a6a48', 0.3); line(g, [[X - L / 2, yy + 2], [X + L / 2, yy + 2]], 1, '#f4dcae', 0.35); });
    }
  } else {
    // big soft facets: lit planes and cool shaded ones (the geometry paints its facets' values too)
    for (let i = 0; i < 20; i++) {
      const x = rnd() * w, y = range(rnd, 0.15, 0.85) * h, rx = range(rnd, 20, 60), ry = range(rnd, 14, 40), a = range(rnd, -0.5, 0.5), c = lightOf(pick(rnd, B.cols), 0.25);
      wrapX(w, x, rx * 1.5, X => { blob(g, X + rx * 0.3, y + ry * 0.35, rx, ry, a, shadowOf(B.base, 0.45), 0.2, 0.3); blob(g, X - rx * 0.2, y - ry * 0.25, rx * 0.8, ry * 0.7, a, c, 0.2, 0.3); });
    }
    if (biome === 'meadow') for (let i = 0; i < 12; i++) { const x = rnd() * w; wrapX(w, x, 10, X => stroke(g, [[X, Y(0.97)], [X + range(rnd, -3, 3), Y(range(rnd, 0.62, 0.85))]], range(rnd, 5, 10), 1, pick(rnd, ['#4f6d2a', '#5d6b3c']), 0.35)); }
    if (biome === 'fields') for (let i = 0; i < 26; i++) { const x = rnd() * w, y = range(rnd, 0.25, 0.9) * h, rx = range(rnd, 4, 10); wrapX(w, x, 10, X => { blob(g, X, y, rx, rx * 0.7, 0, pick(rnd, ['#d89a3a', '#c8b04a', '#e0b050']), 0.5, 0.55); blob(g, X - rx * 0.3, y - rx * 0.25, rx * 0.4, rx * 0.3, 0, '#f0d888', 0.5, 0.4); }); }
    if (biome === 'snow') for (let i = 0; i < 14; i++) { const x = rnd() * w, y = range(rnd, 0.3, 0.85) * h, rx = range(rnd, 10, 26); wrapX(w, x, rx * 1.4, X => { blob(g, X + 2, y + 2.5, rx, 3.5, 0, '#3a4a6a', 0.22, 0.3); blob(g, X, y, rx, 3, 0, '#eef2f8', 0.55, 0.35); }); }
  }
  cracks(g, w, rnd, { color: '#2a2030', count: 8, len: [20, 60], width: [1, 2], alpha: 0.35 });
  // grime and earth at the foot
  g.fillStyle = lin(g, 0, Y(0.2), 0, h, [[0, B.ground, 0], [0.6, B.ground, 0.38], [1, shadowOf(B.ground, 0.4), 0.7]]); g.fillRect(0, Y(0.2), w, h - Y(0.2));
  if (biome === 'snow') { g.fillStyle = lin(g, 0, Y(0.12), 0, h, [[0, '#e8eef4', 0], [1, '#dfe6ee', 0.8]]); g.fillRect(0, Y(0.12), w, h - Y(0.12)); }
  glaze(g, w, h, '#ffe2b0', 0.1);
}
// The cover: an alpha-tested layer for the rock's upward faces (alpha × the shell's vertex alpha is cut
// at 0.5). Broad continuous caps with ragged holes where the stone shows through, a darker rim where
// they meet the stone, lit on their upper left. Seamless both ways.
function coverPaint(g, s, rnd, biome) {
  const caps = (base, cols, lit, rim, nHoles, hr) => {
    fill(g, s, s, base);
    for (let i = 0; i < 26; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 14, 40); wrap(s, x, y, r, (X, Y) => blob(g, X, Y, r, r * 0.8, rnd() * 3, pick(rnd, cols), 0.45, 0.2)); }
    const holes = []; for (let i = 0; i < nHoles; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, hr[0], hr[1]), dabs = []; for (let k = 0; k < 5; k++) dabs.push([x + range(rnd, -0.6, 0.6) * r, y + range(rnd, -0.5, 0.5) * r, r * range(rnd, 0.45, 0.75)]); holes.push(dabs); }
    // the rim: darker where the cover thins to the stone; the light catching it on the far side
    for (const d of holes) for (const [x, y, r] of d) wrap(s, x, y, r * 1.8, (X, Y) => { blob(g, X - r * 0.35, Y - r * 0.4, r * 1.55, r * 1.35, 0, lit, 0.35, 0.3); blob(g, X + r * 0.1, Y + r * 0.12, r * 1.35, r * 1.2, 0, rim, 0.75, 0.45); });
    g.save(); g.globalCompositeOperation = 'destination-out';
    for (const d of holes) for (const [x, y, r] of d) wrap(s, x, y, r * 1.2, (X, Y) => blob(g, X, Y, r, r * 0.85, rnd() * 3, '#000', 1, 0.75));
    for (let i = 0; i < 90; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 2, 6); wrap(s, x, y, r, (X, Y) => blob(g, X, Y, r, r, 0, '#000', 0.5, 0.5)); }
    g.restore();
    return holes;
  };
  if (biome === 'meadow') {
    const holes = caps('#4f6d2a', ['#5a7a30', '#45612a', '#628436', '#4a6a2c'], '#8aa548', '#3a4e22', 16, [16, 30]);
    g.save(); g.globalCompositeOperation = 'source-atop';
    // cushions of moss: small round clumps lit on their upper left
    for (let i = 0; i < 160; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 3, 7); wrap(s, x, y, r * 1.5, (X, Y) => { blob(g, X + r * 0.3, Y + r * 0.35, r, r * 0.85, 0, '#34481e', 0.4, 0.4); blob(g, X - r * 0.25, Y - r * 0.3, r * 0.7, r * 0.55, 0, pick(rnd, ['#8aa548', '#7a9a40', '#9ab450']), 0.55, 0.4); }); }
    for (let i = 0; i < 12; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 3, (X, Y) => { ellipse(g, X, Y, 1.8, 1.8, 0, pick(rnd, ['#f0e6a0', '#e8a0b0', '#fff8e0'])); ellipse(g, X, Y, 0.7, 0.7, 0, '#c8902a'); }); }
    g.restore();
    // grass tufts only where the moss meets the stone
    for (const d of holes) { const [x, y, r] = d[0]; for (let k = 0; k < 6; k++) { const a = rnd() * TAU, bx = x + Math.cos(a) * r * 1.2, by = y + Math.sin(a) * r; wrap(s, bx, by, 14, (X, Y) => blade(g, X, Y, range(rnd, 6, 12), range(rnd, -0.6, 0.6), range(rnd, 1.6, 2.4), pick(rnd, ['#6f9c34', '#9cb447', '#4f7d2a']), 1, range(rnd, -0.3, 0.3))); } }
  } else if (biome === 'fields') {
    // Westfall rock: broad crusts of golden lichen with dry grass in the cracks
    const holes = caps('#a89a5a', ['#b8a058', '#9a8a50', '#c0a048', '#a89060'], '#d8c888', '#5e5634', 34, [14, 26]);
    g.save(); g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 120; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 2, 6); wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X + 0.8, Y + 1, r, r * 0.8, 0, '#8a6a28', 0.5); ellipse(g, X, Y, r * 0.8, r * 0.65, 0, pick(rnd, ['#d8b058', '#c89a48', '#b8a868', '#d0a040'])); }); }
    g.restore();
    for (const d of holes) { const [x, y, r] = d[0]; for (let k = 0; k < 8; k++) { const a = rnd() * TAU, bx = x + Math.cos(a) * r * 1.1, by = y + Math.sin(a) * r * 0.9; wrap(s, bx, by, 16, (X, Y) => blade(g, X, Y, range(rnd, 7, 14), range(rnd, -0.9, 0.9), range(rnd, 1.6, 2.6), pick(rnd, ['#a99a45', '#c9ac52', '#e2c56a', '#8a7a3a']), 1, range(rnd, -0.4, 0.4))); } }
  } else if (biome === 'snow') {
    caps('#eef2f8', ['#f7f4ec', '#e2eaf2', '#ffffff', '#dfe6ee'], '#ffffff', '#b8c8dc', 4, [10, 18]);
    g.save(); g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 10, 24); wrap(s, x, y, r * 1.4, (X, Y) => { blob(g, X + r * 0.25, Y + r * 0.3, r, r * 0.6, 0, '#c8d6e8', 0.35, 0.3); blob(g, X - r * 0.2, Y - r * 0.2, r * 0.7, r * 0.45, 0, '#ffffff', 0.5, 0.3); }); }
    for (let i = 0; i < 50; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 2, (X, Y) => ellipse(g, X, Y, 1.1, 1.1, 0, '#ffffff', 0.9)); }
    g.restore();
  } else if (biome === 'badlands') {
    // ochre dust settled in drifts on the ledges, pebbles in it
    caps('#c48c5a', ['#b98457', '#cf9a62', '#b4784a', '#c89060'], '#e0b484', '#8a5034', 18, [16, 30]);
    g.save(); g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 30; i++) { const x = rnd() * s, y = rnd() * s, L = range(rnd, 14, 40); wrap(s, x, y, L, (X, Y) => { line(g, [[X - L / 2, Y], [X + L / 2, Y + 1]], 1.6, '#a87048', 0.35); line(g, [[X - L / 2, Y - 1.5], [X + L / 2, Y - 0.5]], 1, '#ecc49a', 0.4); }); }
    for (let i = 0; i < 46; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.5, 3.5); wrap(s, x, y, r, (X, Y) => { ellipse(g, X + 0.6, Y + 0.8, r, r * 0.8, 0, '#6a3a20', 0.8); ellipse(g, X, Y, r, r * 0.8, 0, pick(rnd, ['#a8583a', '#c87a4a', '#8e3e22'])); ellipse(g, X - r * 0.3, Y - r * 0.3, r * 0.35, r * 0.3, 0, '#f0c090', 0.7); }); }
    g.restore();
  } else {
    // pale sand drifted onto the ledges, wind ripples across it
    caps('#e2c48c', ['#e8cc96', '#d9b87f', '#ecd4a2', '#d4b078'], '#fff0c8', '#b88a54', 12, [14, 26]);
    g.save(); g.globalCompositeOperation = 'source-atop';
    for (let i = 0; i < 60; i++) { const x = rnd() * s, y = rnd() * s, L = range(rnd, 12, 34); wrap(s, x, y, L, (X, Y) => { const pts = [[X - L / 2, Y], [X, Y + range(rnd, -1.5, 1.5)], [X + L / 2, Y + 1]]; line(g, pts, 1.5, '#c79c62', 0.55); line(g, pts.map(([a, b]) => [a, b - 1.6]), 1, '#fff4d8', 0.6); }); }
    g.restore();
  }
}
for (const b of Object.keys(BOULDER)) {
  register(`loot_boulder_${b}`, { family: F, w: 512, h: 256, note: `the road-blocking boulder, ${b} (u wraps round it; v ground → top)`, paint(g, w, rnd, h, cv) { boulderPaint(g, w, rnd, h, b); blurTile(cv, 0.4); } });
  register(`loot_cover_${b}`, { family: F, size: 256, alpha: true, note: `what lies on the ${b} boulder's top faces (alpha-tested, seamless)`, paint(g, s, rnd, h, cv) { coverPaint(g, s, rnd, b); blurTile(cv, 0.5); } });
}

// ---- the loot twinkle -----------------------------------------------------------------------------------

// The glitter over every loose piece of loot (props3d draws it all as one point cloud), painted like
// the motes that rise off a lootable quest object in 2004: pale gold-white specks of light, not little
// stars on sticks and never orange (a warm teardrop over a piece reads as a candle flame). Four sprites
// share the texture, one per 128 px cell (TWINKLE_CELLS):
//   0, 1  round motes: a cream-white heart (#fff3c4), a soft gold rim, a faint bronze edge (so a mote
//         still shows on white snow and pale sand) and a soft pale halo; 1 has a tiny four-point glint.
//   2, 3  the twinkle: a four-point star, slim concave rays (the vertical pair a bit longer, the two of a
//         pair not quite equal, 3 tipped a few degrees), a round pale heart, a white centre; props3d
//         flashes one of these on one mote at a time per piece.
// Everything sits in the middle of its cell with at least 10 px of clear alpha round it, so the mips
// don't bleed between cells.
export const TWINKLE_CELLS = 2;    // the sprite is TWINKLE_CELLS × TWINKLE_CELLS motes
const TW_EDGE = '#7a5a22', TW_GOLD = '#dcae48', TW_GOLDL = '#f5da88', TW_CREAM = '#fff3c4', TW_WHITE = '#fffdf2';
// one needle from (x, y) out at angle a: tip at len, half-width wb at the heart, concave sides
function needle(g, x, y, a, len, wb, color, alpha) {
  const dx = Math.sin(a), dy = -Math.cos(a), nx = -dy, ny = dx;
  const P = (t, s) => [x + dx * t + nx * s, y + dy * t + ny * s];
  g.save(); g.globalAlpha *= alpha; g.fillStyle = color; g.beginPath();
  g.moveTo(...P(0, wb));
  g.quadraticCurveTo(...P(len * 0.22, wb * 0.32), ...P(len, 0));
  g.quadraticCurveTo(...P(len * 0.22, -wb * 0.32), ...P(0, -wb));
  g.quadraticCurveTo(...P(-wb * 1.3, 0), ...P(0, wb));
  g.fill(); g.restore();
}
// a four-point star: rays [angle (deg, 0 = up, clockwise), length (px)], layer by layer
// (each layer: [grow px, length ×, width ×, color, alpha])
function star(g, x, y, rays, wb, layers) {
  for (const [grow, kl, kw, color, alpha] of layers) for (const [deg, L] of rays) needle(g, x, y, deg * Math.PI / 180, L * kl + grow, wb * kw + grow * 0.7, color, alpha);
}
const STAR_LAYERS = [[3.5, 1, 1, TW_EDGE, 0.42], [0, 1, 1, TW_GOLD, 1], [0, 0.94, 0.74, TW_GOLDL, 1], [0, 0.84, 0.52, TW_CREAM, 1], [0, 0.66, 0.3, TW_WHITE, 1]];
// a round mote: a glow, not a ball (no shading across it): a soft pale-gold halo, a faint bronze edge,
// a soft gold rim a third of its radius wide (that's what still shows on white snow), then cream to
// white toward a heart a hair up and left of the middle
function mote(g, x, y, r, rnd) {
  const sq = range(rnd, 0.94, 0.99), rot = range(rnd, -0.6, 0.6);
  g.fillStyle = radial(g, x, y, 0, r * 2.1, [[0, '#fff6d6', 0.62], [0.35, '#fff0c0', 0.32], [0.7, '#f8e0a0', 0.09], [1, '#f2d080', 0]]);
  g.fillRect(x - r * 2.2, y - r * 2.2, r * 4.4, r * 4.4);
  ellipse(g, x + 0.3, y + 0.5, r + 3.2, (r + 3.2) * sq, rot, TW_EDGE, 0.42);
  g.fillStyle = radial(g, x - r * 0.08, y - r * 0.1, 0, r * 1.04, [[0, TW_WHITE], [0.3, '#fffbea'], [0.52, TW_CREAM], [0.7, '#fae6a4'], [0.86, '#f0ca68'], [1, '#d6a644']]);
  g.beginPath(); g.ellipse(x, y, r, r * sq, rot, 0, TAU); g.fill();
}
register('loot_twinkle', {
  family: F, size: 256, alpha: true, note: 'the glitter over loose loot (alpha sprite, not tiled): pale gold-white motes, one per 128 px cell: two round motes (cream heart, soft gold rim, faint bronze edge, pale halo; one with a tiny glint), two four-point twinkle stars (slim uneven rays, white centre)',
  paint(g, s, rnd, h, cv) {
    const S = s / TWINKLE_CELLS;
    for (let k = 0; k < 4; k++) {
      const x = (k % TWINKLE_CELLS) * S + S / 2, y = Math.floor(k / TWINKLE_CELLS) * S + S / 2;
      if (k < 2) {
        mote(g, x, y, S * (k ? 0.17 : 0.2), rnd);
        // the second one catches the light: a tiny four-point glint across it
        if (k === 1) star(g, x - 1, y - 1, [[0, S * 0.3], [180, S * 0.27], [92, S * 0.25], [272, S * 0.23]], S * 0.03, STAR_LAYERS.slice(2));
        continue;
      }
      const tip = k === 3 ? 7 : -3, sc = k === 3 ? 0.92 : 1, wb = S * (k === 3 ? 0.07 : 0.078);
      // a soft round halo first
      g.fillStyle = radial(g, x, y, 0, S * 0.3, [[0, '#fff6d6', 0.75], [0.3, '#fff0c0', 0.42], [0.65, '#f8e0a0', 0.1], [1, '#f2d080', 0]]);
      g.fillRect(x - S / 2 + 2, y - S / 2 + 2, S - 4, S - 4);
      const rays = [[tip, S * 0.41 * sc], [180 + tip, S * 0.38 * sc], [90 + tip, S * 0.32 * sc], [270 + tip, S * 0.34 * sc]];
      star(g, x, y, rays, wb, STAR_LAYERS.slice(0, 1));
      ellipse(g, x + 0.4, y + 0.6, S * 0.13, S * 0.127, 0, TW_EDGE, 0.4);
      star(g, x, y, rays, wb, STAR_LAYERS.slice(1, 3));
      // the heart: a round ball of cream light over the rays' roots
      g.fillStyle = radial(g, x - 1.2, y - 1.5, 0, S * 0.11, [[0, TW_WHITE], [0.45, TW_CREAM], [0.8, TW_GOLDL], [1, TW_GOLD]]);
      g.beginPath(); g.ellipse(x, y, S * 0.108, S * 0.105, 0, 0, TAU); g.fill();
      star(g, x, y, rays, wb, STAR_LAYERS.slice(3));
      blob(g, x - 1, y - 1.2, S * 0.07, S * 0.068, 0, '#ffffff', 1, 0.6);
      // 3: two faint diagonal glimmers between the rays
      if (k === 3) star(g, x, y, [[45 + tip, S * 0.17], [225 + tip, S * 0.15]], S * 0.028, STAR_LAYERS.slice(2, 4));
    }
    blurTile(cv, 0.6);
  },
});
