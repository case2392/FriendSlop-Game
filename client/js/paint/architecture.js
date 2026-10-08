// Texture family: architecture (the towns: buildings, signs, lamps, interiors, the tow truck).
// See docs/ART.md. Everything is painted with the light from the upper left: lit cream edges on
// top, cool shadows below, soft dark grout, never pure black.
//
// Walls (512, tile, ~3 m a tile; up in the texture = up in the world):
//   plaster_cream (timber)  stone_found (foundations)  planks_weathered + planks_barnred (farm)
//   granite_block (alpine)  log_wall + planks_rough (frontier)  adobe (desert)
//   plaster_inner / granite_inner / adobe_inner: the indoor versions (no holes or snow repeating)
// Roofs (512, tile, ~2.6 m a tile; up in the texture = up the slope):
//   shingles_red (timber)  thatch + shingles_wood (farm)  slate_roof + snow_roof (alpine)  hide_patch (frontier)
// Trim, metal, cloth (256, tile): timber_dark  wood_light  wood_white  iron_wrought  brass  metal_green  metal_red  canvas_stripe
// Interiors: floor_planks + carpet_casino (512, tile)  rug_red (256)  felt_table (512×256)
//   shelf_goods + store_goods (512×256, tile across)
// Pieces (no tiling): door_plank  window_lead  lantern_glass  slot_face  flip_face  coin_face  pad_hit  pad_stand
//   repo_plate  banner_red  barrel  crate  flowerbox  embers  glow_soft
// Signs: signCanvas(lines, opts) paints a sign face (wooden board, gilded board, billboard or a
// paint daub) for town3d.js; sign_demo_* are registered so the gallery shows them.
import {
  register, fill, rowLayout, paintRects, cracks, glaze, blurTile, blob, range, pick, wrap, ellipse, stroke,
  mix, shade, lightOf, shadowOf, jitter, hex, rgba, makeCanvas, rngFrom, hashStr,
} from './core.js';

const F = 'architecture';

// mottle() and streaks() as in core.js, but every mark's alpha and width are drawn once, before it is
// wrapped, so a mark crossing a tile edge is the same mark on both sides (no seam)
function mottle(g, size, rnd, { colors, count = 60, rmin = 20, rmax = 90, alpha = 0.25, hard = 0.2, stretch = 1, rot = null } = {}) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = range(rnd, rmin, rmax);
    const c = pick(rnd, colors);
    const a = rot == null ? rnd() * Math.PI : rot + (rnd() - 0.5) * 0.4;
    const st = stretch * range(rnd, 0.7, 1.3), al = alpha * range(rnd, 0.6, 1);
    wrap(size, x, y, r * Math.max(1, st), (xx, yy) => blob(g, xx, yy, r * st, r, a, c, al, hard));
  }
}
function streaks(g, size, rnd, { colors, count = 80, len = [30, 120], width = [1, 4], angle = 0, wobble = 0.15, alpha = 0.35 } = {}) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size;
    const L = range(rnd, len[0], len[1]), W = range(rnd, width[0], width[1]);
    const a = angle + (rnd() - 0.5) * wobble;
    const c = pick(rnd, colors);
    const pts = [];
    let px = x, py = y;
    for (let k = 0; k <= 6; k++) {
      pts.push([px, py]);
      const aa = a + Math.sin(k * 1.3 + i) * wobble;
      px += Math.sin(aa) * L / 6; py -= Math.cos(aa) * L / 6;
    }
    const w1 = W * range(rnd, 0.3, 1), al = alpha * range(rnd, 0.5, 1);
    wrap(size, x, y, L + W, (xx, yy) => stroke(g, pts.map(([u, v]) => [u - x + xx, v - y + yy]), W, w1, c, al));
  }
}
const TAU = Math.PI * 2;
const INK = '#2a2030';      // the darkest thing we paint: a soft violet-brown

// ---- small helpers ---------------------------------------------------------------------------

// A polyline stroked in one path (uniform alpha: no beading at the joints).
function line(g, pts, w, color, alpha = 1, cap = 'round') {
  g.save();
  g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = w; g.lineCap = cap; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke(); g.restore();
}
function polyPath(g, pts) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); }
function clipped(g, pathFn, fn) { g.save(); pathFn(); g.clip(); fn(); g.restore(); }
// call fn(dx, dy) once per wrapped copy of the rect (x, y, w, h) on an s×s tile
function wrapRect(s, x, y, w, h, fn, sy = s) {
  const xs = [0], ys = [0];
  if (x < 0) xs.push(s); if (x + w > s) xs.push(-s);
  if (y < 0) ys.push(sy); if (y + h > sy) ys.push(-sy);
  for (const dx of xs) for (const dy of ys) fn(dx, dy);
}
function grad(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c, a = 1] of stops) gr.addColorStop(t, rgba(c, a));
  return gr;
}
function hsl(c) {
  const { r, g, b } = hex(c);
  const R = r / 255, G = g / 255, B = b / 255, mx = Math.max(R, G, B), mn = Math.min(R, G, B), l = (mx + mn) / 2;
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
  const v = n => Math.round(Math.max(0, Math.min(1, f(n))) * 255).toString(16).padStart(2, '0');
  return '#' + v(0) + v(8) + v(4);
}
// Neon and primaries → a 2004 painted-wood palette: same hue, less saturation, kept off the extremes.
export function muteColor(c, { sMax = 0.5, lMin = 0.24, lMax = 0.74 } = {}) {
  if (!c || c.startsWith('rgba')) return c;
  const { h, s, l } = hsl(c);
  return fromHsl(h, Math.min(s, sMax), Math.max(lMin, Math.min(lMax, l)));
}

function nailHead(g, x, y, r = 2.2, col = '#5e5a5e') {
  blob(g, x + r * 0.5, y + r * 0.6, r * 1.7, r * 1.5, 0, INK, 0.45, 0.3);
  ellipse(g, x, y, r, r, 0, col);
  blob(g, x - r * 0.35, y - r * 0.35, r * 0.65, r * 0.6, 0, '#c8c2b8', 0.8, 0.4);
}
function rivet(g, x, y, r, base = '#9a7a3a') {
  blob(g, x + r * 0.45, y + r * 0.6, r * 1.6, r * 1.4, 0, INK, 0.5, 0.25);
  ellipse(g, x, y, r, r, 0, shadowOf(base, 0.3));
  ellipse(g, x - r * 0.12, y - r * 0.12, r * 0.8, r * 0.8, 0, base);
  blob(g, x - r * 0.35, y - r * 0.4, r * 0.5, r * 0.45, 0, lightOf(base, 0.8), 0.9, 0.4);
}

// ---- wood --------------------------------------------------------------------------------------

// One painted plank in the rect (X, Y, w, h): an across-grain gradient (lit on the upper/left side),
// tone blotches along it, grain lines, maybe a knot, a split and nails, then lit/shaded bevels.
function plank(g, X, Y, w, h, c, rnd, o = {}) {
  const { vertical = false, grain = 10, galpha = 0.38, knots = 0.3, bevel = 3, light = 0.42, splits = 0.3, nails = 0, weather = 0, endShade = 0.0 } = o;
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
  if (weather > 0) {
    for (let i = 0; i < 7; i++) {
      const t = rnd() * L, o2 = rnd() * T, r = range(rnd, 0.1, 0.3) * L;
      const col = pick(rnd, ['#a8a294', '#9a968c', '#b4ab98']);
      if (vertical) blob(g, X + o2, Y + t, T * 0.35, r, 0, col, weather * 0.35, 0.15); else blob(g, X + t, Y + o2, r, T * 0.35, 0, col, weather * 0.35, 0.15);
    }
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
    ellipse(g, kx - rx * 0.15, ky - ry * 0.15, rx * 0.45, ry * 0.45, 0, shadowOf(c, 0.75), 0.9);
    blob(g, kx + rx * 0.45, ky + ry * 0.45, rx * 0.6, ry * 0.5, 0, lightOf(c, 0.4), 0.4, 0.4);
  }
  if (rnd() < splits) {
    const t0 = rnd() * L * 0.7, len = range(rnd, 0.15, 0.45) * L, o2 = range(rnd, 0.25, 0.75) * T;
    const p = [];
    for (let k = 0; k <= 6; k++) { const a = t0 + len * k / 6, b = o2 + (rnd() - 0.5) * 1.6; p.push(vertical ? [X + b, Y + a] : [X + a, Y + b]); }
    line(g, p.map(([x, y]) => [x + 0.9, y + 0.9]), 1.7, lightOf(c, 0.5), 0.35);
    line(g, p, 1.3, INK, 0.55);
  }
  if (endShade > 0) {
    if (vertical) { g.fillStyle = grad(g, 0, Y, 0, Y + h, [[0, INK, endShade], [0.12, INK, 0], [0.88, INK, 0], [1, INK, endShade]]); }
    else { g.fillStyle = grad(g, X, 0, X + w, 0, [[0, INK, endShade], [0.1, INK, 0], [0.9, INK, 0], [1, INK, endShade]]); }
    g.fillRect(X, Y, w, h);
  }
  for (let i = 0; i < nails; i++) {
    const t = i % 2 ? L - 9 : 9, o2 = T * (nails > 2 ? (i < 2 ? 0.3 : 0.7) : 0.5);
    nailHead(g, vertical ? X + o2 : X + t, vertical ? Y + t : Y + o2, 2.1);
  }
  g.globalAlpha = 0.55; g.fillStyle = lightOf(c, 0.6); g.fillRect(X, Y, w, bevel); g.fillRect(X, Y, bevel * 0.8, h);
  g.globalAlpha = 0.5; g.fillStyle = shadowOf(c, 0.55); g.fillRect(X, Y + h - bevel, w, bevel); g.fillRect(X + w - bevel * 0.8, Y, bevel * 0.8, h);
  g.restore();
}

// A tiling field of planks (rows along y; vertical:true turns them into boards standing up).
function planks(g, s, rnd, { rows, minL, maxL, colors, gap = 3, gapColor = '#241c22', vertical = false, rowJitter = 0.15, varAmt = 0.07, ...o }) {
  fill(g, s, s, gapColor);
  const rects = rowLayout(s, rnd, { rows, minW: minL, maxW: maxL, rowJitter });
  for (const r of rects) {
    const c = jitter(pick(rnd, colors), rnd, varAmt);
    let x = r.x + gap / 2, y = r.y + gap / 2, w = r.w - gap, h = r.h - gap;
    if (vertical) [x, y, w, h] = [y, x, h, w];
    const seed = Math.floor(rnd() * 1e9);
    wrapRect(s, x, y, w, h, (dx, dy) => plank(g, x + dx, y + dy, w, h, c, rngFrom(seed), { vertical, ...o }));
  }
  return rects;
}

// Wood grain running along y over the whole tile (beams, posts, furniture). Tiles both ways.
function grainTile(g, s, rnd, { base, dark, lite, lines = 46, splits = 4, knots = 2, alpha = 0.42 }) {
  fill(g, s, s, base);
  mottle(g, s, rnd, { colors: [lightOf(base, 0.15), shadowOf(base, 0.2), base], count: 22, rmin: s * 0.06, rmax: s * 0.2, alpha: 0.4, hard: 0.1, stretch: 3, rot: Math.PI / 2 });
  for (let i = 0; i < lines; i++) {
    const x0 = rnd() * s, k = 1 + Math.floor(rnd() * 3), ph = rnd() * TAU, amp = range(rnd, 1, 5), k2 = 2 + Math.floor(rnd() * 3), ph2 = rnd() * TAU;
    const col = rnd() < 0.62 ? pick(rnd, dark) : pick(rnd, lite), w = range(rnd, 0.7, 2.0), a = alpha * range(rnd, 0.4, 1);
    const pts = [];
    for (let y = 0; y <= s; y += s / 32) pts.push([x0 + Math.sin(TAU * k * y / s + ph) * amp + Math.sin(TAU * k2 * y / s + ph2) * amp * 0.4, y]);
    for (const dx of [-s, 0, s]) line(g, pts.map(([x, y]) => [x + dx, y]), w, col, a);
  }
  for (let i = 0; i < knots; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, s * 0.015, s * 0.03);
    wrap(s, x, y, r * 4, (X, Y) => {
      ellipse(g, X, Y, r * 2, r * 3.4, 0, shadowOf(base, 0.15), 0.4);
      ellipse(g, X, Y, r, r * 1.6, 0, shadowOf(base, 0.4), 0.8);
      blob(g, X + r * 0.5, Y + r * 0.7, r * 0.6, r, 0, lightOf(base, 0.4), 0.45, 0.4);
    });
  }
  for (let i = 0; i < splits; i++) {
    const x = rnd() * s, y = rnd() * s, L = range(rnd, s * 0.15, s * 0.45);
    const pts = []; for (let k = 0; k <= 8; k++) pts.push([x + (rnd() - 0.5) * 1.5, y + L * k / 8]);
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) {
      const p = pts.map(([u, v]) => [u + dx, v + dy]);
      line(g, p.map(([u, v]) => [u + 1, v]), 1.8, lightOf(base, 0.5), 0.35);
      line(g, p, 1.3, INK, 0.6);
    }
  }
}

// ---- shingles & thatch -------------------------------------------------------------------------

// Rows of shingles, drawn from the eave up so each row overlaps the one below and drops a soft
// shadow on it. Up in the texture = up the roof. Tiles both ways.
function shingles(g0, s, rnd, { rows, minW, maxW, colors, gapColor, round = 0.45, light = 0.4, overhang = 0.4, moss = 0, mossCols = ['#6d7a4a', '#5d6b3c'], grain = 0, chips = 0.25, speck = 0, missing = 0, patched = 0, butt = 0 }) {
  // painted twice, stacked, on a 2s-tall canvas; the middle band is a seamless tile
  const off = makeCanvas(s, s * 2), g = off.getContext('2d');
  fill(g, s, s * 2, gapColor);
  const rects = rowLayout(s, rnd, { rows, minW, maxW, rowJitter: 0.12 });
  const byRow = [];
  for (const r of rects) {
    const kind = rnd() < missing ? 'gone' : rnd() < patched ? 'patch' : 'ok';
    const c = jitter(pick(rnd, colors), rnd, 0.09);
    (byRow[r.row] ||= []).push({ ...r, kind, c: kind === 'patch' ? mix(shade(c, 0.78), '#6a4a34', 0.4) : c, seed: Math.floor(rnd() * 1e9), drop: range(rnd, -2.5, 5), skew: (rnd() - 0.5) * 5, rk: range(rnd, 0.55, 1.45) });
  }
  const one = (r, dy) => {
    let rr = rngFrom(r.seed);
    const x = r.x + 1.6, w = r.w - 3.2, y = r.y + dy - r.h * overhang, h = r.h * (1 + overhang) + r.drop;
    if (r.kind === 'gone') {
      // a missing shingle: the dark sheathing boards and the butts of the row above's nails
      for (const ox of (x < 0 ? [0, s] : x + w > s ? [0, -s] : [0])) {
        g.fillStyle = grad(g, 0, y, 0, y + h, [[0, '#3a2620'], [0.7, '#5a4030'], [1, '#4a3428']]); g.fillRect(x + ox, y + h * 0.35, w, h * 0.65);
        line(g, [[x + ox + 2, y + h * 0.7], [x + ox + w - 2, y + h * 0.72]], 1.2, '#5a4434', 0.6);
      }
      return;
    }
    const rad = Math.min(w * round * r.rk, r.h * 0.6);
    const path = (ox) => {
      g.beginPath();
      g.moveTo(x + ox, y); g.lineTo(x + ox + w, y);
      g.lineTo(x + ox + w + r.skew * 0.3, y + h - rad);
      g.quadraticCurveTo(x + ox + w + r.skew * 0.3, y + h, x + ox + w - rad + r.skew * 0.3, y + h);
      g.lineTo(x + ox + rad + r.skew, y + h);
      g.quadraticCurveTo(x + ox + r.skew, y + h, x + ox + r.skew, y + h - rad);
      g.closePath();
    };
    for (const ox of (x < 0 ? [0, s] : x + w > s ? [0, -s] : [0])) {
      rr = rngFrom(r.seed + 1);
      // the soft shadow this shingle drops on the row below
      g.fillStyle = grad(g, 0, y + h - 3, 0, y + h + 7, [[0, INK, 0.38], [0.45, INK, 0.2], [1, INK, 0]]);
      g.fillRect(x + ox + 1, y + h - 3, w + 2, 10);
      clipped(g, () => path(ox), () => {
        const c = r.c;
        g.fillStyle = grad(g, 0, y, 0, y + h, [[0, shadowOf(c, 0.55)], [overhang / (1 + overhang) + 0.05, shadowOf(c, 0.2)], [0.6, c], [0.95, lightOf(c, light * 0.4)], [1, shadowOf(c, 0.3)]]);
        g.fillRect(x + ox - 4, y, w + 8, h + 2);
        for (let i = 0; i < 3; i++) blob(g, x + ox + rr() * w, y + h * range(rr, 0.4, 0.9), range(rr, 4, 12), range(rr, 4, 9), rr() * 3, rr() < 0.5 ? lightOf(c, 0.3) : shadowOf(c, 0.3), 0.3, 0.2);
        for (let i = 0; i < grain; i++) {
          const gx = x + ox + range(rr, 0.1, 0.9) * w;
          line(g, [[gx, y + h * 0.3], [gx + (rr() - 0.5) * 2, y + h * range(rr, 0.7, 1)]], range(rr, 0.7, 1.4), rr() < 0.7 ? shadowOf(c, 0.4) : lightOf(c, 0.3), 0.4);
        }
        for (let i = 0; i < speck; i++) ellipse(g, x + ox + rr() * w, y + h * range(rr, 0.35, 0.95), range(rr, 0.6, 1.6), range(rr, 0.5, 1.2), 0, rr() < 0.5 ? lightOf(c, 0.5) : shadowOf(c, 0.5), 0.5);
        // lit left edge, shaded right edge, and the dark butt end at the bottom
        g.globalAlpha = 0.5; g.fillStyle = lightOf(c, 0.55); g.fillRect(x + ox + r.skew * 0.5, y, 2.4, h);
        g.globalAlpha = 0.45; g.fillStyle = shadowOf(c, 0.6); g.fillRect(x + ox + w - 2.6, y, 2.6, h);
        g.globalAlpha = 1;
        line(g, [[x + ox + r.skew + rad * 0.6, y + h - 1.2], [x + ox + w - rad * 0.6, y + h - 1.2]], 2.4, shadowOf(c, 0.65), 0.6);
        // the butt's worn front edge catches the light just above the dark line
        if (butt) line(g, [[x + ox + r.skew + rad * 0.7, y + h - 4], [x + ox + w - rad * 0.7, y + h - 4.4]], 1.6, lightOf(c, 0.55), butt);
        if (rr() < chips) { const cx = x + ox + range(rr, 0.2, 0.8) * w; ellipse(g, cx, y + h, range(rr, 2, 5), range(rr, 2, 4), 0, gapColor, 0.9); }
        if (moss && rr() < moss) {
          for (let i = 0; i < 3; i++) blob(g, x + ox + range(rr, 0.1, 0.9) * w, y + h * range(rr, 0.75, 1.0), range(rr, 3, 9), range(rr, 2, 5), 0, pick(rr, mossCols), 0.55, 0.4);
        }
      });
    }
  };
  for (const dy of [s, 0]) for (let i = byRow.length - 1; i >= 0; i--) for (const r of byRow[i]) one(r, dy);
  g0.drawImage(off, 0, s / 2, s, s, 0, 0, s, s);
}

// Straw thatch: courses of straw bundles laid from the eave up, each course's ragged butt overlapping
// the one below. Every bundle has its own width, tint, offset and length, a lit bulge near its top and
// a dark ragged under-lip, so the courses read as bundles of straw, not as stacked tubes. Up = up the roof.
function thatch(g0, s, rnd, { courses = 9, base = '#3e3020', straw, tips, lip = '#5a4628', lit = '#dcc070', moss = 0.12, mossCols = ['#6d7a4a', '#5e6a3e'] }) {
  const off = makeCanvas(s, s * 2), g = off.getContext('2d');
  fill(g, s, s * 2, base);
  const H = s / courses;
  const data = [];
  for (let i = 0; i < courses; i++) {
    const bundles = [];
    let x = rnd() * s, end = x + s;
    while (x < end - 10) { const w = Math.min(end - x, range(rnd, 26, 58)); bundles.push({ x, w, dy: range(rnd, -5, 6), len: range(rnd, 1.05, 1.32), c: jitter(pick(rnd, straw), rnd, 0.08), seed: Math.floor(rnd() * 1e9), mossy: rnd() < moss, bulge: range(rnd, 0.7, 1.3) }); x += w * range(rnd, 0.8, 0.95); }
    data.push({ y: i * H, bundles });
  }
  const bundle = (b, y0, dx) => {
    const rr = rngFrom(b.seed);
    const X = b.x + dx, top = y0 - H * 0.45 + b.dy, bot = y0 + H * b.len + b.dy;
    // the soft shadow this bundle's butt throws on the course below
    blob(g, X + b.w / 2 + 3, bot + 3, b.w * 0.62, H * 0.3, 0, INK, 0.38, 0.25);
    // body: a vertical gradient (lit bulge up top, dark under the butt)
    g.save();
    g.beginPath(); g.moveTo(X, top);
    for (let k = 0; k <= 8; k++) g.lineTo(X + b.w * k / 8 + (rr() - 0.5) * 3, bot - Math.abs(Math.sin(k * 1.7 + b.seed)) * 7 - rr() * 5);
    g.lineTo(X + b.w, top); g.closePath(); g.clip();
    g.fillStyle = grad(g, 0, top, 0, bot, [[0, shadowOf(b.c, 0.3)], [0.35, mix(b.c, lit, 0.35 * b.bulge)], [0.6, b.c], [0.86, shadowOf(b.c, 0.25)], [1, lip]]);
    g.fillRect(X - 2, top, b.w + 4, bot - top + 2);
    // straws: near-vertical strokes, a few slanted, light and dark
    for (let k = 0; k < b.w * 1.6; k++) {
      const sx = X + rr() * b.w, sy = top + rr() * (bot - top) * 0.5, L = range(rr, 0.4, 0.75) * (bot - top), a = range(rr, -0.12, 0.12);
      const col = rr() < 0.55 ? pick(rr, straw) : rr() < 0.6 ? pick(rr, tips) : shadowOf(b.c, 0.45);
      line(g, [[sx, sy], [sx + Math.sin(a) * L, sy + Math.cos(a) * L]], range(rr, 1, 2.2), col, range(rr, 0.35, 0.75));
    }
    g.restore();
    // ragged straw tips hanging past the butt, and the dark under-lip
    for (let k = 0; k < b.w / 3; k++) {
      const sx = X + rr() * b.w, sy = bot - range(rr, 6, 12), L = range(rr, 4, 13);
      line(g, [[sx, sy], [sx + (rr() - 0.5) * 3, sy + L]], range(rr, 1, 1.8), rr() < 0.5 ? lip : pick(rr, tips), 0.7);
    }
    line(g, [[X + 2, bot - 4], [X + b.w - 2, bot - 5]], 2.6, lip, 0.45);
    if (b.mossy) for (let k = 0; k < 3; k++) blob(g, X + rr() * b.w, bot - range(rr, 4, H * 0.5), range(rr, 5, 13), range(rr, 3, 7), 0, pick(rr, mossCols), 0.5, 0.35);
  };
  for (const dy of [s, 0]) for (let i = courses - 1; i >= 0; i--) {
    const d = data[i];
    for (const b of d.bundles) for (const dx of [0, -s]) bundle(b, d.y + dy, dx);
  }
  g0.drawImage(off, 0, s / 2, s, s, 0, 0, s, s);
}

// ---- stone ----------------------------------------------------------------------------------------

// Irregular coursed fieldstone: each stone a lumpy polygon, lit on the upper left, in dark grout.
function rubble(g, s, rnd, { rows, minW, maxW, colors, grout, groutCols, light = 0.5, inset = [3, 7], moss = 0, mossCols = ['#6d7a4a', '#5d6b3c'], snow = 0, rowJitter = 0.3 }) {
  fill(g, s, s, grout);
  mottle(g, s, rnd, { colors: groutCols || [shadowOf(grout, 0.2), lightOf(grout, 0.15)], count: 60, rmin: 4, rmax: 16, alpha: 0.5, hard: 0.4 });
  const rects = rowLayout(s, rnd, { rows, minW, maxW, rowJitter });
  for (const r of rects) {
    const seed = Math.floor(rnd() * 1e9);
    const c = jitter(pick(rnd, colors), rnd, 0.1);
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    wrap(s, cx, cy, Math.max(r.w, r.h) / 2 + 4, (X, Y) => {
      const rr = rngFrom(seed);
      const hw = r.w / 2 - range(rr, inset[0], inset[1]), hh = r.h / 2 - range(rr, inset[0], inset[1]);
      const p = range(rr, 2.2, 3.6), n = 14, pts = [];
      for (let k = 0; k < n; k++) {
        const th = k / n * TAU + rr() * 0.15, cs = Math.cos(th), sn = Math.sin(th);
        const j = 1 + (rr() - 0.5) * 0.18;
        pts.push([X + Math.sign(cs) * Math.pow(Math.abs(cs), 2 / p) * hw * j, Y + Math.sign(sn) * Math.pow(Math.abs(sn), 2 / p) * hh * j]);
      }
      // contact shadow into the grout on the lower right
      g.save(); g.fillStyle = INK; g.globalAlpha = 0.22; g.translate(3.5, 4); polyPath(g, pts); g.fill(); g.globalAlpha = 0.3; g.translate(-1.5, -1.5); polyPath(g, pts); g.fill(); g.restore();
      clipped(g, () => polyPath(g, pts), () => {
        g.fillStyle = grad(g, X - hw, Y - hh, X + hw * 0.6, Y + hh, [[0, lightOf(c, light * 0.7)], [0.5, c], [1, shadowOf(c, light * 0.8)]]);
        g.fillRect(X - hw - 2, Y - hh - 2, hw * 2 + 4, hh * 2 + 4);
        for (let i = 0; i < 5; i++) blob(g, X + (rr() - 0.5) * hw * 1.6, Y + (rr() - 0.5) * hh * 1.6, range(rr, hw * 0.2, hw * 0.6), range(rr, hh * 0.2, hh * 0.5), rr() * 3, rr() < 0.5 ? lightOf(c, 0.3) : shadowOf(c, 0.3), 0.28, 0.15);
        for (let i = 0; i < 3; i++) ellipse(g, X + (rr() - 0.5) * hw * 1.6, Y + (rr() - 0.5) * hh * 1.6, range(rr, 1, 2.5), range(rr, 1, 2), 0, shadowOf(c, 0.5), 0.5);
        // bevel: lit upper-left rim, shaded lower-right rim
        g.save(); g.translate(-2.5, -2.5); g.lineWidth = 5; g.strokeStyle = rgba(lightOf(c, 0.45), 0.35); polyPath(g, pts); g.stroke(); g.restore();
        g.save(); g.translate(2.5, 2.5); g.lineWidth = 6; g.strokeStyle = rgba(shadowOf(c, 0.6), 0.6); polyPath(g, pts); g.stroke(); g.restore();
        if (moss && rr() < moss) for (let i = 0; i < 3; i++) blob(g, X + (rr() - 0.5) * hw * 1.6, Y + hh * range(rr, 0.2, 0.9), range(rr, 4, 12), range(rr, 3, 7), 0, pick(rr, mossCols), 0.45, 0.35);
      });
      if (snow) {
        // snow resting on the top of the stone
        clipped(g, () => polyPath(g, pts), () => {
          g.save(); g.fillStyle = '#eef3f8';
          g.beginPath(); g.moveTo(X - hw - 2, Y - hh - 2);
          for (let k = 0; k <= 10; k++) { const t = k / 10; g.lineTo(X - hw + t * hw * 2, Y - hh + snow * hh * (0.25 + 0.2 * Math.sin(t * 9 + seed))); }
          g.lineTo(X + hw + 2, Y - hh - 2); g.closePath(); g.fill();
          g.restore();
          blob(g, X, Y - hh + snow * hh * 0.4, hw, 3, 0, '#9fb2cc', 0.35, 0.3);
        });
      }
    });
  }
}

// ---- metal ------------------------------------------------------------------------------------

function plates(g, s, rnd, { colors, rows = 2, minW = 90, maxW = 200, gap = 3, rivetCol = '#b0a080', rust = 0.4, chips = 0.4, scratches = 20 }) {
  const rects = rowLayout(s, rnd, { rows, minW, maxW, rowJitter: 0.1 });
  paintRects(g, s, rects, rnd, { colors, gap, gapColor: '#2a2428', radius: 3, bevel: 4, light: 0.4, varAmt: 0.06 });
  mottle(g, s, rnd, { colors: colors.map(c => lightOf(c, 0.15)).concat(colors.map(c => shadowOf(c, 0.2))), count: 40, rmin: 10, rmax: 50, alpha: 0.2, hard: 0.1 });
  // chipped paint: dark metal underneath, with a lit lower lip
  for (let i = 0; i < 26 * chips; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 2, 7), ra = rnd() * 3;
    wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 0.7, ra, '#4a4448', 0.85); blob(g, X + r * 0.4, Y + r * 0.4, r * 0.7, r * 0.4, 0, '#d8d0c0', 0.25, 0.4); });
  }
  streaks(g, s, rnd, { colors: ['#e8e0d0', '#c8c0b4'], count: scratches, len: [8, 30], width: [0.6, 1.2], angle: 1.3, wobble: 0.4, alpha: 0.35 });
  for (const r of rects) {
    const n = Math.max(2, Math.round(r.w / 26));
    for (let k = 0; k < n; k++) {
      const x = r.x + 7 + (r.w - 14) * (k + 0.5) / n;
      for (const y of [r.y + 7, r.y + r.h - 8]) {
        wrap(s, x, y, 6, (X, Y) => {
          rivet(g, X, Y, 3, rivetCol);
          if (rnd() < rust * 0.35) line(g, [[X, Y + 3], [X + (rnd() - 0.5) * 2, Y + range(rnd, 10, 26)]], range(rnd, 1.5, 3), '#7a4026', 0.35);
        });
      }
    }
  }
}

// ---- plaster patches ----------------------------------------------------------------------------

// A hole in the plaster showing bricks or stones underneath; the plaster rim is lit on the
// far side of the hole (lower right) and casts a shadow into it on the near side.
function plasterHole(g, s, rnd, x, y, r, { brick = ['#9a5a3e', '#a8684a', '#8a4e36'], mortar = '#6a5446', plaster, squash = 0.8 }) {
  const seed = Math.floor(rnd() * 1e9);
  wrap(s, x, y, r * 1.8, (X, Y) => {
    const rr = rngFrom(seed), pts = [];
    const n = 13;
    for (let k = 0; k < n; k++) { const th = k / n * TAU; const rad = r * range(rr, 0.55, 1.2); pts.push([X + Math.cos(th) * rad * 1.35, Y + Math.sin(th) * rad * squash]); }
    // a soft darker stain round the hole (dirt collects at the broken edge)
    g.save(); g.filter = 'blur(5px)'; g.globalAlpha = 0.22; g.fillStyle = shadowOf(plaster, 0.35);
    g.translate(X, Y); g.scale(1.18, 1.22); g.translate(-X, -Y); polyPath(g, pts); g.fill(); g.restore();
    clipped(g, () => polyPath(g, pts), () => {
      g.fillStyle = mortar; g.fillRect(X - r * 2, Y - r * 2, r * 4, r * 4);
      const bh = Math.max(11, r * 0.4), bw = bh * 2.2;
      for (let row = -6; row <= 6; row++) for (let col = -6; col <= 6; col++) {
        const bx = X + col * bw + (row & 1) * bw / 2 + (rr() - 0.5) * 3, by = Y + row * bh;
        const c = jitter(pick(rr, brick), rr, 0.08);
        g.fillStyle = grad(g, bx, by, bx, by + bh, [[0, lightOf(c, 0.22)], [0.5, c], [1, shadowOf(c, 0.3)]]);
        g.beginPath(); g.roundRect(bx + 1.6, by + 1.6, bw - 3.2, bh - 3.2, 2.5); g.fill();
      }
      // the plaster's upper-left lip throws a soft shadow into the hole
      g.save(); g.translate(4, 5); g.lineWidth = 14; g.strokeStyle = rgba(INK, 0.5); g.filter = 'blur(3px)'; polyPath(g, pts); g.stroke(); g.restore();
    });
    // the broken lip: lit only on the lower right (it faces the light), shaded on the upper left
    g.save(); g.beginPath(); g.rect(X - r * 3, Y - r * 3, r * 6, r * 6); polyPath(g, pts); g.clip('evenodd');
    g.save(); g.translate(1.6, 1.8); g.lineWidth = 3; g.strokeStyle = rgba(lightOf(plaster, 0.35), 0.6); g.filter = 'blur(0.7px)'; polyPath(g, pts); g.stroke(); g.restore();
    g.save(); g.translate(-1.4, -1.6); g.lineWidth = 2.6; g.strokeStyle = rgba(shadowOf(plaster, 0.35), 0.45); g.filter = 'blur(0.9px)'; polyPath(g, pts); g.stroke(); g.restore();
    g.restore();
  });
}

// ---- wall textures ----------------------------------------------------------------------------------

// Rain streaks running down from a ledge at y0 (x0..x1), wrapped.
function rainStreaks(g, s, rnd, x0, x1, y0, col, n, alpha) {
  for (let i = 0; i < n; i++) {
    const x = range(rnd, x0, x1), L = range(rnd, 30, 150), w = range(rnd, 3, 10);
    wrap(s, x, y0 + L / 2, L, (X, Y) => {
      g.save(); g.globalAlpha = alpha * range(rnd, 0.5, 1);
      g.fillStyle = grad(g, 0, Y - L / 2, 0, Y + L / 2, [[0, col, 1], [0.6, col, 0.6], [1, col, 0]]);
      g.beginPath(); g.ellipse(X, Y, w / 2, L / 2, 0, 0, TAU); g.fill(); g.restore();
    });
  }
}

function plasterPaint(g, s, rnd, cv, holes) {
  fill(g, s, s, '#dccdaa');
  // three related creams in big soft blotches, then smaller ones
  mottle(g, s, rnd, { colors: ['#e8dcb8', '#d8c8a0', '#e4d4c0'], count: 22, rmin: 90, rmax: 220, alpha: 0.55, hard: 0.05 });
  mottle(g, s, rnd, { colors: ['#ecdfbe', '#c8b48c', '#d8c49c', '#e8d8b4', '#bdae92', '#c4b496'], count: 50, rmin: 30, rmax: 120, alpha: 0.4, hard: 0.08 });
  mottle(g, s, rnd, { colors: ['#a89c88', '#b0a488', '#9a9484'], count: 10, rmin: 50, rmax: 120, alpha: 0.14, hard: 0.05 });
  blurTile(cv, 4);
  // trowel strokes
  for (let i = 0; i < 80; i++) {
    const x = rnd() * s, y = rnd() * s, L = range(rnd, 24, 80), a = range(rnd, -0.6, 0.6), w = range(rnd, 8, 22);
    const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([x + Math.cos(a) * L * t, y + Math.sin(a) * L * t + Math.sin(t * 3) * 4]); }
    const c = rnd() < 0.55 ? '#f2e8ce' : '#c4b28c';
    wrap(s, x, y, L + w, (X, Y) => line(g, pts.map(([u, v]) => [u - x + X, v - y + Y]), w, c, 0.1));
  }
  mottle(g, s, rnd, { colors: ['#b8a682', '#a8987a', '#f2e8d0'], count: 220, rmin: 1.5, rmax: 4, alpha: 0.2, hard: 0.6 });
  // rain streaks from beams and sills (the tile is ~3 m: a few ledges)
  for (const y0 of [s * 0.02, s * 0.4, s * 0.71]) rainStreaks(g, s, rnd, 0, s, y0, '#b8a888', 9, 0.16);
  if (holes) {
    // 6 holes of varied size and shape: brick and fieldstone showing through
    const bricks = { plaster: '#ddcfae' }, stones = { plaster: '#ddcfae', brick: ['#8e8a80', '#9e988a', '#7e7a72'], mortar: '#5a5048' };
    const spots = [[0.18, 0.22, 44, bricks], [0.66, 0.12, 22, stones], [0.82, 0.55, 34, bricks], [0.36, 0.62, 18, bricks], [0.55, 0.9, 28, stones], [0.08, 0.84, 14, stones]];
    for (const [fx, fy, r, o] of spots) plasterHole(g, s, rnd, s * (fx + (rnd() - 0.5) * 0.06), s * (fy + (rnd() - 0.5) * 0.06), r * range(rnd, 0.85, 1.15), { ...o, squash: range(rnd, 0.6, 0.95) });
  }
  cracks(g, s, rnd, { color: '#7a6a58', count: 7, len: [18, 60], width: [0.7, 1.3], alpha: 0.4 });
  glaze(g, s, s, '#fff0d0', 0.12, 'soft-light');
  blurTile(cv, 0.5);
}
register('plaster_cream', { family: F, size: 512, note: 'Goldshire plaster: three creams, soft trowel strokes, rain streaks (the holes are separate decals: wall_holes)', paint(g, s, rnd, h, cv) { plasterPaint(g, s, rnd, cv, false); } });
// Indoor plaster (Goldshire shops and the inn hall): a warmer, older cream than the outside. Big soft
// clouds in three hues (cream, honey, a cool grey-beige where damp got in), trowel crescents with a
// shaded lip, two re-plastered patches (fresher, paler, a lit upper-left edge and a shaded lower one),
// a chip where the lath shows, soft smoke and damp stains running down, and hairline cracks with
// branches. The grime along the ceiling beam and the wainscot cap is vertex colour (town_build).
function lathHole(g, s, rnd, x, y, r, plaster) {
  const seed = Math.floor(rnd() * 1e9);
  wrap(s, x, y, r * 1.8, (X, Y) => {
    const rr = rngFrom(seed), pts = [];
    for (let k = 0; k < 12; k++) { const th = k / 12 * TAU; const rad = r * range(rr, 0.6, 1.15); pts.push([X + Math.cos(th) * rad * 1.5, Y + Math.sin(th) * rad * 0.75]); }
    clipped(g, () => polyPath(g, pts), () => {
      g.fillStyle = '#4a3828'; g.fillRect(X - r * 2, Y - r * 2, r * 4, r * 4);
      // the laths: thin sawn strips with dark gaps, lit on top, a nail here and there
      const lh = Math.max(6, r * 0.22);
      for (let yy = Y - r * 1.2 + rr() * lh; yy < Y + r * 1.2; yy += lh * 1.45) {
        const c = jitter(pick(rr, ['#9a7450', '#8a6644', '#a8805a']), rr, 0.08);
        g.fillStyle = grad(g, 0, yy, 0, yy + lh, [[0, lightOf(c, 0.25)], [0.45, c], [1, shadowOf(c, 0.3)]]);
        g.fillRect(X - r * 2, yy, r * 4, lh);
        if (rr() < 0.5) nailHead(g, X + range(rr, -r, r), yy + lh / 2, 1.4, '#6a6266');
      }
      // the plaster keys squeezed between the laths
      for (let k = 0; k < 6; k++) blob(g, X + range(rr, -r, r), Y + range(rr, -r * 0.6, r * 0.6), range(rr, 3, 6), range(rr, 2, 4), 0, shadowOf(plaster, 0.15), 0.7, 0.5);
      g.save(); g.translate(3, 4); g.lineWidth = 10; g.strokeStyle = rgba(INK, 0.45); polyPath(g, pts); g.stroke(); g.restore();
    });
    g.save(); g.beginPath(); g.rect(X - r * 3, Y - r * 3, r * 6, r * 6); polyPath(g, pts); g.clip('evenodd');
    g.save(); g.translate(1.4, 1.6); g.lineWidth = 2.6; g.strokeStyle = rgba(lightOf(plaster, 0.35), 0.65); polyPath(g, pts); g.stroke(); g.restore();
    g.save(); g.translate(-1.2, -1.4); g.lineWidth = 2.2; g.strokeStyle = rgba(shadowOf(plaster, 0.35), 0.5); polyPath(g, pts); g.stroke(); g.restore();
    g.restore();
  });
}
function innerPlasterPaint(g, s, rnd, cv) {
  const base = '#d6c49e';
  fill(g, s, s, base);
  mottle(g, s, rnd, { colors: ['#e8d8b0', '#cbb282', '#bcb09a', '#e2cfa4'], count: 22, rmin: 110, rmax: 250, alpha: 0.62, hard: 0.04 });
  mottle(g, s, rnd, { colors: ['#ecdeb8', '#c4aa7e', '#d6c296', '#b0a28a', '#e4d2aa', '#c8b08a'], count: 56, rmin: 30, rmax: 120, alpha: 0.44, hard: 0.08 });
  mottle(g, s, rnd, { colors: ['#a8987c', '#9c9282'], count: 10, rmin: 40, rmax: 110, alpha: 0.18, hard: 0.05 });
  blurTile(cv, 5);
  // trowel crescents: a lighter sweep with a shaded lower lip, in loose clusters
  for (let i = 0; i < 60; i++) {
    const x = rnd() * s, y = rnd() * s, R = range(rnd, 18, 52), a0 = rnd() * TAU, sweep = range(rnd, 0.8, 1.8), w = range(rnd, 8, 18);
    const pts = []; for (let k = 0; k <= 9; k++) { const a = a0 + sweep * k / 9; pts.push([x + Math.cos(a) * R, y + Math.sin(a) * R * 0.55]); }
    wrap(s, x, y, R + w, (X, Y) => {
      const sh = pts.map(([u, v]) => [u - x + X, v - y + Y]);
      line(g, sh.map(([u, v]) => [u + 1.2, v + 2]), w, '#9a8466', 0.09);
      line(g, sh, w * 0.8, '#f4e8c8', 0.14);
    });
  }
  // two re-plastered patches: fresher and paler, their edges lit upper left and shaded lower right
  for (const [fx, fy, pw, ph] of [[0.26, 0.3, 120, 84], [0.72, 0.74, 90, 70]]) {
    const x = s * (fx + (rnd() - 0.5) * 0.08), y = s * (fy + (rnd() - 0.5) * 0.08), seed = Math.floor(rnd() * 1e9);
    wrap(s, x, y, Math.max(pw, ph), (X, Y) => {
      const rr = rngFrom(seed), pts = [];
      for (let k = 0; k < 14; k++) { const th = k / 14 * TAU, c = Math.cos(th), sn = Math.sin(th); const sq = 1 / Math.pow(Math.pow(Math.abs(c), 3) + Math.pow(Math.abs(sn), 3), 1 / 3); pts.push([X + c * sq * pw / 2 * range(rr, 0.88, 1.08), Y + sn * sq * ph / 2 * range(rr, 0.88, 1.08)]); }
      clipped(g, () => polyPath(g, pts), () => {
        g.fillStyle = grad(g, X - pw / 2, Y - ph / 2, X + pw / 2, Y + ph / 2, [[0, '#efe2c2'], [0.6, '#e2d2ae'], [1, '#d4c29c']]);
        g.fillRect(X - pw, Y - ph, pw * 2, ph * 2);
        for (let k = 0; k < 7; k++) { const yy = Y - ph / 2 + rr() * ph, xx = X - pw / 2 + rr() * pw; line(g, [[xx - 20, yy], [xx, yy + 3], [xx + 22, yy - 1]], range(rr, 6, 12), rr() < 0.5 ? '#f8eed4' : '#c8b48e', 0.22); }
      });
      line(g, [...pts, pts[0]].map(([u, v]) => [u - 1, v - 1]), 2, '#fff4d8', 0.5);
      line(g, [...pts, pts[0]].map(([u, v]) => [u + 1.4, v + 1.6]), 2.4, '#8a7656', 0.3);
    });
  }
  lathHole(g, s, rnd, s * range(rnd, 0.55, 0.65), s * range(rnd, 0.18, 0.28), 24, base);
  // smoke and damp: soft stains running down from a few places
  for (let i = 0; i < 4; i++) {
    const x = rnd() * s, y = rnd() * s, L = range(rnd, 90, 200), w = range(rnd, 26, 60), c = i % 2 ? '#8a7a62' : '#9a8a70';
    wrap(s, x, y + L / 2, L, (X, Y) => {
      g.save(); g.globalAlpha = 0.14;
      g.fillStyle = grad(g, 0, Y - L / 2, 0, Y + L / 2, [[0, c, 1], [0.5, c, 0.7], [1, c, 0]]);
      g.beginPath(); g.ellipse(X, Y, w / 2, L / 2, 0, 0, TAU); g.fill(); g.restore();
    });
  }
  rainStreaks(g, s, rnd, 0, s, s * 0.05, '#a8987a', 8, 0.12);
  mottle(g, s, rnd, { colors: ['#a8987a', '#9a8a6e', '#f4e8cc'], count: 260, rmin: 1.4, rmax: 3.8, alpha: 0.22, hard: 0.6 });
  cracks(g, s, rnd, { color: '#6a5844', count: 13, len: [24, 96], width: [0.6, 1.2], alpha: 0.42, branch: 0.55 });
  glaze(g, s, s, '#ffdca8', 0.14, 'soft-light');
  blurTile(cv, 0.5);
}
register('plaster_inner', { family: F, size: 512, note: 'indoor plaster: warm old cream in three hues, trowel crescents, two re-plastered patches, a lath chip, smoke and damp stains, branching hairline cracks (ceiling and wainscot grime are vertex colour)', paint(g, s, rnd, h, cv) { innerPlasterPaint(g, s, rnd, cv); } });

// Holes and patches in the plaster as decals (4×2 atlas of 256 px cells, alpha): [0] bricks and [1]
// fieldstone through cream plaster, [2] mud bricks and [3] a shallow scar through adobe, [4] a fresh
// pale patch of mud render, [5] a big fallen piece showing courses of mud brick, [6] a darker, rougher
// mud repair with straw in it, [7] a re-plastered patch on cream plaster. town_build scatters them per wall
// (each decal maps the middle 84% × 62% of its cell).
export const HOLE_CELLS = { plaster: [0, 1], adobe: [2, 3, 5], adobePatch: [4, 6], plasterPatch: [7] };
export const HOLE_COLS = 4;
// A repair patch (cell canvas, centred): a lumpy squarish outline, the patch's own trowel marks, a lit
// upper-left edge and a shaded lower-right one, a faint darker halo where it was feathered in.
function patchPaint(g, q, rnd, { col, lite, dark, straw = 0, w = 170, h = 104 }) {
  const X = q / 2, Y = q / 2, pts = [];
  for (let k = 0; k < 16; k++) {
    const th = k / 16 * TAU, c = Math.cos(th), sn = Math.sin(th);
    const sq = 1 / Math.pow(Math.pow(Math.abs(c), 3) + Math.pow(Math.abs(sn), 3), 1 / 3);
    pts.push([X + c * sq * w / 2 * range(rnd, 0.84, 1.06), Y + sn * sq * h / 2 * range(rnd, 0.82, 1.06)]);
  }
  g.save(); g.globalAlpha = 0.16; g.lineWidth = 12; g.lineJoin = 'round'; g.strokeStyle = dark; polyPath(g, pts); g.stroke(); g.restore();
  clipped(g, () => polyPath(g, pts), () => {
    g.fillStyle = grad(g, X - w / 2, Y - h / 2, X + w / 2, Y + h / 2, [[0, lightOf(col, 0.12)], [0.55, col], [1, shadowOf(col, 0.12)]]);
    g.fillRect(0, 0, q, q);
    for (let k = 0; k < 10; k++) blob(g, X + range(rnd, -w, w) * 0.45, Y + range(rnd, -h, h) * 0.45, range(rnd, 14, 40), range(rnd, 8, 22), rnd() * 3, rnd() < 0.5 ? lite : dark, 0.16, 0.1);
    for (let k = 0; k < 9; k++) {
      const x = X + range(rnd, -w, w) * 0.42, y = Y + range(rnd, -h, h) * 0.42, R = range(rnd, 14, 34), a0 = rnd() * TAU;
      const arc = []; for (let j = 0; j <= 8; j++) { const a = a0 + 1.4 * j / 8; arc.push([x + Math.cos(a) * R, y + Math.sin(a) * R * 0.55]); }
      line(g, arc.map(([u, v]) => [u + 1, v + 1.6]), range(rnd, 6, 12), dark, 0.12);
      line(g, arc, range(rnd, 5, 10), lite, 0.18);
    }
    for (let k = 0; k < straw; k++) { const x = X + range(rnd, -w, w) * 0.48, y = Y + range(rnd, -h, h) * 0.48, L = range(rnd, 3, 8), a = rnd() * Math.PI; line(g, [[x, y], [x + Math.cos(a) * L, y + Math.sin(a) * L]], range(rnd, 0.8, 1.4), rnd() < 0.6 ? '#f0d49a' : '#6a4630', 0.5); }
    mottle(g, q, rnd, { colors: [lite, dark], count: 60, rmin: 1.2, rmax: 3, alpha: 0.22, hard: 0.6 });
  });
  line(g, [...pts, pts[0]].map(([u, v]) => [u - 1.2, v - 1.2]), 2.4, lightOf(col, 0.4), 0.55);
  line(g, [...pts, pts[0]].map(([u, v]) => [u + 1.4, v + 1.8]), 2.8, shadowOf(dark, 0.2), 0.4);
}
register('wall_holes', {
  family: F, w: 1024, h: 512, alpha: true, note: 'plaster decals (4×2 atlas, alpha): brick and fieldstone through plaster; mud brick, a scar, a big fallen piece through adobe; fresh and rough mud patches; a cream plaster patch',
  paint(g, w, rnd) {
    g.clearRect(0, 0, w, w / 2);
    const q = w / 4;
    const cells = [
      { plaster: '#ddcfae' },
      { plaster: '#ddcfae', brick: ['#8e8a80', '#9e988a', '#7e7a72'], mortar: '#5a5048' },
      { plaster: '#c89068', brick: ['#a87650', '#b88458', '#9a6a46', '#b07a52'], mortar: '#6a4830' },
      { plaster: '#c89068', brick: ['#9a6a48', '#a87452', '#8e6040'], mortar: '#5e4028' },
      { patch: { col: '#dcb88a', lite: '#f0d4a8', dark: '#a87650' } },
      { plaster: '#c89068', brick: ['#a87650', '#b88458', '#9a6a46', '#b07a52', '#a06e4a'], mortar: '#6a4830', r: 66, squash: 0.66 },
      { patch: { col: '#a87652', lite: '#c89a6e', dark: '#7a5234', straw: 40, w: 150, h: 96 } },
      { patch: { col: '#e8dcbc', lite: '#fff4d8', dark: '#a89474', w: 160, h: 100 } },
    ];
    cells.forEach((o, i) => {
      const cx = (i % 4) * q + q / 2, cy = Math.floor(i / 4) * q + q / 2;
      // paint on a cell-sized canvas so nothing bleeds into the neighbours
      const cv = makeCanvas(q, q), gg = cv.getContext('2d');
      if (o.patch) patchPaint(gg, q, rnd, o.patch);
      else plasterHole(gg, q * 4, rnd, q / 2, q / 2, o.r || (i === 3 ? 44 : 62), { ...o, squash: o.squash || (i === 1 ? 0.75 : 0.85) });
      g.drawImage(cv, cx - q / 2, cy - q / 2);
    });
  },
});

// Fieldstone: a tileable power diagram (Voronoi with a weight per stone) so stones come in three
// sizes, squashed so they sit wider than tall with flattish tops; lumpy edges, a domed body lit from
// the upper left, a lit top-left rim and a cool shaded lower rim, soft warm-dark mortar, moss
// collecting in the crevices under the stones.
function fieldstone(g, s, rnd, cv, { colors, mortar = '#4a4038', moss = 0.5, sizes = [64, 42, 24], squash = 1.45, mossCols = ['#6d7a4a', '#5d6b3c', '#7a8a50'] }) {
  // dart-throwing: big stones first, then medium and small ones in the gaps
  const seeds = [];
  const dist = (ax, ay, bx, by) => { let dx = Math.abs(ax - bx), dy = Math.abs(ay - by); dx = Math.min(dx, s - dx); dy = Math.min(dy, s - dy) * squash; return Math.hypot(dx, dy); };
  for (const r of sizes) for (let t = 0; t < 900; t++) {
    const x = rnd() * s, y = rnd() * s, rr = r * range(rnd, 0.85, 1.15);
    if (seeds.every(q => dist(x, y, q.x, q.y) > (q.r + rr) * 0.92)) seeds.push({ x, y, r: rr, c: hex(jitter(pick(rnd, colors), rnd, 0.08)), ph: rnd() * TAU, ph2: rnd() * TAU, tone: range(rnd, 0.92, 1.08) });
  }
  const N = seeds.length, img = g.createImageData(s, s), D = img.data, M = hex(mortar);
  const pd = new Float32Array(N);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    // lumpy edges: a few tileable waves added to the weighted distance
    const lump = 380 * (Math.sin(TAU * 7 * x / s + Math.sin(TAU * 3 * y / s) * 1.3) + Math.sin(TAU * 9 * y / s + Math.sin(TAU * 4 * x / s)) * 0.8) + 160 * Math.sin(TAU * 17 * x / s + TAU * 13 * y / s);
    let b1 = 1e12, b2 = 1e12, b3 = 1e12, i1 = 0, i2 = 0, i3 = 0;
    for (let i = 0; i < N; i++) {
      const q = seeds[i];
      let dx = x - q.x, dy = y - q.y;
      if (dx > s / 2) dx -= s; else if (dx < -s / 2) dx += s;
      if (dy > s / 2) dy -= s; else if (dy < -s / 2) dy += s;
      dy *= squash;
      const d = dx * dx + dy * dy - q.r * q.r + lump;
      pd[i] = d;
      if (d < b1) { b3 = b2; i3 = i2; b2 = b1; i2 = i1; b1 = d; i1 = i; } else if (d < b2) { b3 = b2; i3 = i2; b2 = d; i2 = i; } else if (d < b3) { b3 = d; i3 = i; }
    }
    const A = seeds[i1];
    const edgeTo = (Bq, bd) => {
      let sx = Bq.x - A.x, sy = Bq.y - A.y;
      if (sx > s / 2) sx -= s; else if (sx < -s / 2) sx += s;
      if (sy > s / 2) sy -= s; else if (sy < -s / 2) sy += s;
      return (bd - b1) / (2 * Math.hypot(sx, sy * squash) + 1e-6);
    };
    // distance to the joint, with the corners rounded off (a soft min of the two nearest joints)
    const e12 = edgeTo(seeds[i2], b2), e13 = edgeTo(seeds[i3], b3), kk = 4;
    const e = -kk * Math.log(Math.exp(-e12 / kk) + Math.exp(-e13 / kk)) + kk * 0.45;
    let dx = x - A.x, dy = y - A.y;
    if (dx > s / 2) dx -= s; else if (dx < -s / 2) dx += s;
    if (dy > s / 2) dy -= s; else if (dy < -s / 2) dy += s;
    const rn = Math.min(1, Math.hypot(dx, dy * squash) / A.r);
    const l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l;
    const k = (y * s + x) * 4;
    const c = A.c;
    // dome, then a wide lit rim facing the upper left and a shaded rim facing the lower right
    const facing = -(ux * 0.6 + uy * 0.8);            // > 0 on the upper-left side
    const rim = Math.max(0, 1 - (e - 3) / 9);
    let m = A.tone * (1.08 - 0.22 * rn * rn) * (1 + 0.32 * rim * facing);
    // the flat top of a stone catches more light
    if (uy < -0.55) m *= 1 + 0.12 * Math.max(0, 1 - e / 14);
    // soft painterly blotches inside each stone
    m *= 1 + 0.07 * Math.sin(dx * 0.09 + A.ph) * Math.sin(dy * 0.11 + A.ph2);
    let r = c.r * m, gg = c.g * m, bb = c.b * m;
    if (facing < 0) { r -= 10 * rim * -facing; bb += 8 * rim * -facing; }   // cool shadow side
    // moss: in the crevice under a stone's bottom and the joints round it, broken up
    const mossy = moss * Math.max(0, uy) * Math.max(0, 1 - e / 7) * (0.5 + 0.5 * Math.sin(x * 0.07 + y * 0.05) * Math.sin(x * 0.031 - y * 0.06 + A.ph));
    if (mossy > 0.05) { const mc = hex(mossCols[(i1 + i2) % mossCols.length]); const t = Math.min(0.75, mossy * 1.6); r = r * (1 - t) + mc.r * t; gg = gg * (1 - t) + mc.g * t; bb = bb * (1 - t) + mc.b * t; }
    // mortar: soft-edged, a touch lighter where it is thick
    const gt = Math.max(0, Math.min(1, (4.2 - e) / 2.6));
    const mw = 1 + 0.12 * Math.max(0, 1 - Math.abs(e) / 3);
    r = r * (1 - gt) + M.r * mw * gt; gg = gg * (1 - gt) + M.g * mw * gt; bb = bb * (1 - gt) + M.b * mw * gt;
    D[k] = Math.max(0, Math.min(255, r)); D[k + 1] = Math.max(0, Math.min(255, gg)); D[k + 2] = Math.max(0, Math.min(255, bb)); D[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // a few pits, chips and cracks, and the odd moss tuft on a top
  for (let i = 0; i < 90; i++) { const x = rnd() * s, y = rnd() * s, ex = range(rnd, 1, 2.6), ey = range(rnd, 0.8, 2); wrap(s, x, y, 5, (X, Y) => { ellipse(g, X, Y, ex, ey, 0, INK, 0.3); ellipse(g, X + 1, Y + 1.2, 1.2, 0.9, 0, '#fff0d0', 0.18); }); }
  cracks(g, s, rnd, { color: '#3a3030', count: 6, len: [14, 40], width: [0.7, 1.3], alpha: 0.45 });
  mottle(g, s, rnd, { colors: mossCols, count: 14, rmin: 5, rmax: 16, alpha: 0.18, hard: 0.3 });
}
register('stone_found', {
  family: F, size: 512, note: 'fieldstone foundation: stones of three sizes sitting wider than tall, lit top-left rims, soft warm mortar, moss in the crevices',
  paint(g, s, rnd, h, cv) {
    fieldstone(g, s, rnd, cv, { colors: ['#8e877a', '#9c9484', '#7f796f', '#a39a88', '#8a8577', '#958b7a', '#8c8a86', '#a08a72', '#7a7468', '#9a8e7e'], mortar: '#4a4038', moss: 0.55 });
    glaze(g, s, s, '#ffe2b0', 0.1, 'soft-light');
    blurTile(cv, 0.7);
  },
});

register('planks_weathered', {
  family: F, size: 512, note: 'Westfall boards: vertical, sun-grayed honey wood, splits, nails',
  paint(g, s, rnd, h, cv) {
    planks(g, s, rnd, { rows: 8, minL: 150, maxL: 340, vertical: true, colors: ['#8a6c4c', '#9a7a56', '#7c6046', '#a08260', '#86684a'], gap: 4, gapColor: '#2a1e1c', grain: 12, weather: 0.8, splits: 0.5, nails: 2, knots: 0.35 });
    mottle(g, s, rnd, { colors: ['#a49c8c', '#6a5640'], count: 30, rmin: 20, rmax: 70, alpha: 0.12, hard: 0.1, stretch: 2.5, rot: Math.PI / 2 });
    glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('planks_barnred', {
  family: F, size: 512, note: 'barn boards: faded oxblood paint worn to grey wood, rain runs and sun-faded streaks',
  paint(g, s, rnd, h, cv) {
    const rects = planks(g, s, rnd, { rows: 8, minL: 180, maxL: 380, vertical: true, colors: ['#8a3a2a', '#7e3426', '#94442e', '#86382a', '#8e4232'], gap: 4, gapColor: '#2a1a1c', grain: 9, galpha: 0.3, weather: 0.65, splits: 0.45, nails: 2, knots: 0.2 });
    // paint worn through to the grey wood along the grain
    for (let i = 0; i < 40; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 16, 60), w = range(rnd, 5, 14);
      wrap(s, x, y, L, (X, Y) => {
        blob(g, X + 1.5, Y + 2, w * 0.6, L * 0.5, 0, INK, 0.25, 0.4);
        blob(g, X, Y, w * 0.55, L * 0.5, (rnd() - 0.5) * 0.2, '#9a8e7c', 0.75, 0.6);
        blob(g, X - w * 0.15, Y - L * 0.1, w * 0.3, L * 0.35, 0, '#b4a890', 0.5, 0.4);
      });
    }
    // rain runs and sun-faded streaks down the boards
    streaks(g, s, rnd, { colors: ['#4a2420', '#5a2a24', '#b07a68', '#a89080'], count: 60, len: [50, 220], width: [2, 7], angle: Math.PI, wobble: 0.02, alpha: 0.16 });
    mottle(g, s, rnd, { colors: ['#a08a7a', '#6a3428'], count: 16, rmin: 40, rmax: 110, alpha: 0.12, hard: 0.05, stretch: 2.5, rot: Math.PI / 2 });
    glaze(g, s, s, '#ffd8b0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// Coursed ashlar: rows of uneven height, squarish blocks (now and then a small odd one) with
// chipped corners, chisel marks, a lit top-left edge, a shadowed lower edge and warm dark mortar.
// snow: the share of blocks with a cap of snow on their top.
function ashlar(g, s, rnd, { colors, mortar = '#3c3636', snow = 0 }) {
  fill(g, s, s, mortar);
  mottle(g, s, rnd, { colors: [shadowOf(mortar, 0.2), lightOf(mortar, 0.15)], count: 50, rmin: 4, rmax: 14, alpha: 0.5, hard: 0.4 });
  const hs = []; let tot = 0;
  while (tot < s - 50) { const h = range(rnd, 40, 95); hs.push(h); tot += h; }
  const k = s / tot;
  let y = 0;
  const blocks = [];
  for (const h0 of hs) {
    const h = h0 * k, x0 = rnd() * s;
    let x = x0;
    while (x < x0 + s - 24) {
      let w = rnd() < 0.14 ? range(rnd, 34, 58) : range(rnd, Math.max(70, h * 1.3), Math.max(130, h * 3.0));
      if (x + w > x0 + s - 34) w = x0 + s - x;
      blocks.push({ x, y, w, h });
      x += w;
    }
    y += h;
  }
  for (const bk of blocks) {
    const seed = Math.floor(rnd() * 1e9), c = jitter(pick(rnd, colors), rnd, 0.06), gap = range(rnd, 3, 4.2), capped = rnd() < snow;
    wrapRect(s, bk.x, bk.y, bk.w, bk.h, (dx, dy) => {
      const rr = rngFrom(seed);
      const X = bk.x + dx + gap, Y = bk.y + dy + gap, w = bk.w - 2 * gap, h = bk.h - 2 * gap;
      const J = () => (rr() - 0.5) * 2.6;
      const ch = [0, 1, 2, 3].map(() => rr() < 0.38 ? range(rr, 7, 15) : range(rr, 2, 5));
      const pts = [
        [X + ch[0], Y + J()], [X + w * 0.35, Y + J()], [X + w * 0.7, Y + J()], [X + w - ch[1], Y + J()],
        [X + w + J(), Y + ch[1]], [X + w + J(), Y + h * 0.5], [X + w + J(), Y + h - ch[2]],
        [X + w - ch[2], Y + h + J()], [X + w * 0.6, Y + h + J()], [X + w * 0.3, Y + h + J()], [X + ch[3], Y + h + J()],
        [X + J(), Y + h - ch[3]], [X + J(), Y + h * 0.5], [X + J(), Y + ch[0]],
      ];
      g.save(); g.fillStyle = INK; g.globalAlpha = 0.3; g.filter = 'blur(1.5px)'; g.translate(2.5, 3); polyPath(g, pts); g.fill(); g.restore();
      clipped(g, () => polyPath(g, pts), () => {
        g.fillStyle = grad(g, X, Y, X + w * 0.45, Y + h, [[0, lightOf(c, 0.2)], [0.45, c], [1, shadowOf(c, 0.28)]]);
        g.fillRect(X - 4, Y - 4, w + 8, h + 8);
        for (let i = 0; i < 5; i++) blob(g, X + rr() * w, Y + rr() * h, range(rr, w * 0.15, w * 0.4), range(rr, h * 0.2, h * 0.45), rr() * 3, rr() < 0.5 ? lightOf(c, 0.18) : shadowOf(c, 0.22), 0.25, 0.12);
        // chisel marks: short parallel strokes, not dots
        const ang = range(rr, -0.95, -0.45);
        for (let i = 0; i < Math.round(w * h / 700); i++) {
          const x = X + rr() * w, yy = Y + rr() * h, L = range(rr, 5, 12);
          line(g, [[x, yy], [x + Math.cos(ang) * L, yy + Math.sin(ang) * L]], range(rr, 1, 1.7), shadowOf(c, 0.35), 0.3);
          line(g, [[x + 1.2, yy + 1.2], [x + 1.2 + Math.cos(ang) * L, yy + 1.2 + Math.sin(ang) * L]], 0.8, lightOf(c, 0.3), 0.22);
        }
        if (rr() < 0.35) { const x = X + rr() * w; line(g, [[x, Y + h * 0.2], [x + range(rr, -6, 6), Y + h * 0.6], [x + range(rr, -8, 8), Y + h * 0.9]], 1.2, INK, 0.45); }
        // lit upper-left edge, shadowed lower-right edge (strokes of the outline shifted inward)
        g.save(); g.translate(2, 2); g.lineWidth = 4; g.strokeStyle = rgba('#b8b4a8', 0.5); polyPath(g, pts); g.stroke(); g.restore();
        g.save(); g.translate(-2.5, -2.5); g.lineWidth = 5; g.strokeStyle = rgba('#4e4a50', 0.55); polyPath(g, pts); g.stroke(); g.restore();
        if (capped) {
          g.save(); g.fillStyle = '#f2f5f8'; g.beginPath(); g.moveTo(X - 3, Y - 3);
          for (let k = 0; k <= 10; k++) { const t = k / 10; g.lineTo(X + t * w, Y + 2 + range(rr, 3, 9) * Math.sin(Math.PI * t)); }
          g.lineTo(X + w + 3, Y - 3); g.closePath(); g.fill(); g.restore();
          blob(g, X + w / 2, Y + 9, w * 0.42, 3, 0, '#9fb0cc', 0.35, 0.3);
          blob(g, X + w * 0.35, Y + 3, w * 0.25, 2, 0, '#ffffff', 0.7, 0.4);
        }
      });
    });
  }
  cracks(g, s, rnd, { color: '#2e2a30', count: 5, len: [20, 60], width: [0.8, 1.4], alpha: 0.4 });
  mottle(g, s, rnd, { colors: ['#8a8a6a', '#7a7a60'], count: 10, rmin: 8, rmax: 22, alpha: 0.12, hard: 0.3 });
}
function granitePaint(g, s, rnd, cv, snow) {
  ashlar(g, s, rnd, { colors: ['#7d7a74', '#8f8a80', '#6f7682', '#858078', '#9a8a6a', '#7a7670', '#8a8478'], mortar: '#3c3636', snow: snow ? 0.38 : 0 });
  glaze(g, s, s, '#ffe8c8', 0.08, 'soft-light');
  blurTile(cv, 0.5);
}
register('granite_block', { family: F, size: 512, note: 'Kharanos ashlar: uneven courses of warm gray granite, chipped corners, chisel marks, snow caps on some blocks', paint(g, s, rnd, h, cv) { granitePaint(g, s, rnd, cv, true); } });
register('granite_inner', { family: F, size: 512, note: 'indoor ashlar: no snow', paint(g, s, rnd, h, cv) { granitePaint(g, s, rnd, cv, false); } });

// log courses (fractions of the 3 m tile, top of the canvas first): town_build lines the 3D log ends up with them
export const LOG_ROWS = [0.17, 0.115, 0.155, 0.125, 0.18, 0.11, 0.145];

register('log_wall', {
  family: F, size: 512, note: 'frontier log wall: peeled logs of uneven girth, dark mud chinking with dried edges, checks',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a4030');
    mottle(g, s, rnd, { colors: ['#6a4e38', '#4a3426', '#7a5e44'], count: 140, rmin: 3, rmax: 10, alpha: 0.5, hard: 0.4 });
    const per = (k, a, ph) => x => a * Math.sin(TAU * k * x / s + ph);
    let y0 = 0;
    for (const f of LOG_ROWS) {
      const H = f * s, c = jitter(pick(rnd, ['#8a5a36', '#7e5232', '#94643c', '#86583a', '#9a6c44']), rnd, 0.06);
      const top = per(1 + Math.floor(rnd() * 2), range(rnd, 1, 3), rnd() * TAU), bot = per(2, range(rnd, 1, 2.5), rnd() * TAU);
      const gapT = range(rnd, 4, 8), gapB = range(rnd, 4, 7);
      const yT = x => y0 + gapT + top(x), yB = x => y0 + H - gapB + bot(x);
      // dried, lighter edges of the chinking along the log
      line(g, Array.from({ length: 34 }, (_, k) => [k * s / 32 - 8, yB(k * s / 32 - 8) + 3]), 2, '#8a7058', 0.45);
      line(g, Array.from({ length: 34 }, (_, k) => [k * s / 32 - 8, yT(k * s / 32 - 8) - 2.5]), 1.6, '#8a7058', 0.35);
      g.save(); g.globalAlpha = 0.5; g.fillStyle = INK; g.filter = 'blur(3px)';
      g.beginPath(); g.moveTo(-32, yB(-32)); for (let x = -32; x <= s + 32; x += 16) g.lineTo(x, yB(x) + 5); g.lineTo(s + 32, yB(s + 32) - 6); g.lineTo(-32, yB(-32) - 6); g.closePath(); g.fill(); g.restore();
      const body = () => { g.beginPath(); g.moveTo(-32, yT(-32)); for (let x = -32; x <= s + 32; x += 16) g.lineTo(x, yT(x)); for (let x = s + 32; x >= -32; x -= 16) g.lineTo(x, yB(x)); g.closePath(); };
      clipped(g, body, () => {
        g.fillStyle = grad(g, 0, y0, 0, y0 + H, [[0, lightOf(c, 0.55)], [0.25, lightOf(c, 0.2)], [0.55, c], [0.85, shadowOf(c, 0.45)], [1, shadowOf(c, 0.65)]]);
        g.fillRect(-32, y0, s + 64, H);
        for (let k = 0; k < 16; k++) {
          const x = rnd() * s, y = y0 + range(rnd, 0.2, 0.85) * H, L = range(rnd, 30, 140);
          const bh = range(rnd, 2, 7), bc = rnd() < 0.5 ? '#5a3c26' : lightOf(c, 0.3);
          wrap(s, x, y, L, (X, Y) => blob(g, X, Y, L, bh, 0, bc, 0.3, 0.2));
        }
        for (let k = 0; k < 9; k++) {
          const y = y0 + range(rnd, 0.25, 0.8) * H, k1 = 2 + Math.floor(rnd() * 4), ph = rnd() * TAU, a = range(rnd, 0.5, 2);
          const pts = []; for (let x = -16; x <= s + 16; x += 8) pts.push([x, y + Math.sin(TAU * k1 * x / s + ph) * a]);
          line(g, pts, range(rnd, 0.7, 1.6), rnd() < 0.7 ? shadowOf(c, 0.5) : lightOf(c, 0.4), 0.35);
        }
        // checks (cracks) along the log
        for (let k = 0; k < 2; k++) {
          const cy = y0 + range(rnd, 0.35, 0.6) * H, cx = rnd() * s, L = range(rnd, 60, 200);
          wrap(s, cx, cy, L, (X, Y) => { line(g, [[X, Y + 1.2], [X + L, Y + 2.2]], 2.2, lightOf(c, 0.5), 0.35); line(g, [[X, Y], [X + L * 0.5, Y + 1.5], [X + L, Y + 1]], 1.6, INK, 0.6); });
        }
        for (let k = 0; k < 3; k++) {
          const x = rnd() * s, y = y0 + H * range(rnd, 0.3, 0.6), L = range(rnd, 30, 90);
          wrap(s, x, y, L, (X, Y) => blob(g, X, Y, L, H * 0.18, 0, '#a09484', 0.18, 0.2));
        }
      });
      y0 += H;
    }
    glaze(g, s, s, '#ffd8a8', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  },
});

register('planks_rough', {
  family: F, size: 512, note: 'frontier clapboards: 8-10 wide horizontal boards a tile in three tones, dark gaps, nail heads at the studs, sun-bleached tops, rare butt joints',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#24160e');
    const hs = []; let tot = 0;
    while (tot < s - 40) { const hh = range(rnd, 44, 60); hs.push(hh); tot += hh; }
    const k = s / tot;
    const tones = [['#8a5a36', '#94643c', '#86583a'], ['#6e4a30', '#785234', '#664428'], ['#9c7a58', '#a08262', '#94765a']];
    const studs = [0.12, 0.45, 0.78].map(f => f * s + range(rnd, -6, 6));
    let y = 0;
    for (const h0 of hs) {
      const hh = h0 * k, x0 = rnd() * s, tone = pick(rnd, tones);
      let x = x0;
      while (x < x0 + s - 12) {
        let L = range(rnd, 260, 520); if (x + L > x0 + s - 60) L = x0 + s - x;
        const c = jitter(pick(rnd, tone), rnd, 0.06), seed = Math.floor(rnd() * 1e9);
        wrapRect(s, x, y, L, hh, (dx, dy) => plank(g, x + dx + 1.5, y + dy + 1.5, L - 3, hh - 3, c, rngFrom(seed), { grain: 7, galpha: 0.4, knots: 0.35, bevel: 3, light: 0.55, splits: 0.45, weather: 0.75, endShade: 0.3 }));
        x += L;
      }
      wrapRect(s, 0, y, s, hh, (dx, dy) => {
        // the board's sun-bleached top edge, and the soft shadow it throws on the board below
        g.save(); g.fillStyle = grad(g, 0, y + dy, 0, y + dy + hh * 0.4, [[0, '#d0ae80', 0.42], [1, '#d0ae80', 0]]); g.fillRect(0, y + dy + 1.5, s, hh * 0.4); g.restore();
        g.save(); g.fillStyle = grad(g, 0, y + dy + hh - 1, 0, y + dy + hh + 7, [[0, INK, 0.6], [1, INK, 0]]); g.fillRect(0, y + dy + hh - 1, s, 8); g.restore();
        // nails at the studs, a rust run under some
        for (const sx of studs) {
          const nx = sx + range(rnd, -3, 3), ny = y + dy + hh * range(rnd, 0.35, 0.6);
          const rust = rnd() < 0.3, rx = range(rnd, -1, 1), ry = range(rnd, 8, 20);
          wrap(s, nx, ny, 6, (X, Y) => { nailHead(g, X, Y, 2.4, '#4e4a4e'); if (rust) line(g, [[X, Y + 2.5], [X + rx, Y + ry]], 1.8, '#6a3a22', 0.3); });
        }
      });
      y += hh;
    }
    mottle(g, s, rnd, { colors: ['#a49c8c', '#6a5640', '#b09878'], count: 24, rmin: 30, rmax: 100, alpha: 0.12, hard: 0.1, stretch: 3, rot: 0 });
    glaze(g, s, s, '#ffd8a0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// Gadgetzan mud plaster: a warm terracotta-tan (well off the pale sand), big soft ochre and rose
// blotches, trowel swirls, straw flecks, rain runs and hairline cracks. (Holes are wall_holes decals.)
function adobePaint(g, s, rnd, cv, { base = '#c9976a', blot = ['#d8b083', '#b48058', '#c9976a', '#e2be90', '#a87450'], mid = ['#e0bc8e', '#b4825a', '#cc9a6a', '#c4925f', '#e6c496', '#a87650'], lite = '#ecca9a', dark = '#8e6040', chipsN = 0, brick = ['#a87650', '#b88458', '#9a6a46', '#b07a52'], lifts = 0, damp = false } = {}) {
  fill(g, s, s, base);
  // big soft blotches of three related tans (about ±12% in value), then a couple of faint ochre clouds
  mottle(g, s, rnd, { colors: blot, count: 22, rmin: 100, rmax: 230, alpha: 0.62, hard: 0.05 });
  mottle(g, s, rnd, { colors: ['#c89050', '#d4aa70', '#b88050'], count: 6, rmin: 120, rmax: 220, alpha: 0.24, hard: 0.04 });
  mottle(g, s, rnd, { colors: mid, count: 50, rmin: 30, rmax: 120, alpha: 0.36, hard: 0.08 });
  blurTile(cv, 4);
  // troweled swirl blotches: broad lighter arcs with a shaded lower lip, in loose clusters
  for (let i = 0; i < 70; i++) {
    const x = rnd() * s, y = rnd() * s, R = range(rnd, 22, 64), a0 = rnd() * TAU, sweep = range(rnd, 1.0, 2.2), w = range(rnd, 10, 24);
    const pts = []; for (let k = 0; k <= 10; k++) { const a = a0 + sweep * k / 10; pts.push([x + Math.cos(a) * R, y + Math.sin(a) * R * 0.6]); }
    wrap(s, x, y, R + w, (X, Y) => {
      const sh = pts.map(([u, v]) => [u - x + X, v - y + Y]);
      line(g, sh.map(([u, v]) => [u + 1.5, v + 2.2]), w, dark, 0.08);
      line(g, sh, w * 0.82, lite, 0.13);
    });
  }
  // straw flecks in the mud
  for (let i = 0; i < 120; i++) {
    const x = rnd() * s, y = rnd() * s, L = range(rnd, 3, 8), a = rnd() * Math.PI, lw = range(rnd, 0.8, 1.4), lc = rnd() < 0.6 ? '#f0d49a' : '#7a5034';
    wrap(s, x, y, 10, (X, Y) => line(g, [[X, Y], [X + Math.cos(a) * L, Y + Math.sin(a) * L]], lw, lc, 0.45));
  }
  mottle(g, s, rnd, { colors: [dark, '#f2d2a2', '#a87650'], count: 220, rmin: 1.5, rmax: 4, alpha: 0.2, hard: 0.6 });
  // trowel lifts: each day's coat of mud ends in a faint wavy horizontal seam, a lighter lip over a
  // shaded line, the band under it a shade apart from the one above
  for (let i = 0; i < lifts; i++) {
    const y = s * (i + range(rnd, 0.25, 0.75)) / lifts, hg = range(rnd, 26, 52);
    const k1 = 1 + Math.floor(rnd() * 2), k2 = 3 + Math.floor(rnd() * 3), p1 = rnd() * TAU, p2 = rnd() * TAU;
    const edge = (x, o) => y + o + 5 * Math.sin(TAU * k1 * x / s + p1) + 2.5 * Math.sin(TAU * k2 * x / s + p2);
    const top = [], bot = [];
    for (let x = -8; x <= s + 8; x += 8) { top.push([x, edge(x, 0)]); bot.push([x, edge(x, hg)]); }
    const tone = i % 2 ? lite : dark, ta = i % 2 ? 0.09 : 0.07;
    for (const dy of [0, -s, s]) {
      const T = top.map(([x, yy]) => [x, yy + dy]), B = bot.map(([x, yy]) => [x, yy + dy]);
      g.save(); g.globalAlpha = ta; g.fillStyle = grad(g, 0, y + dy, 0, y + dy + hg, [[0, tone, 1], [1, tone, 0]]); polyPath(g, [...T, ...B.slice().reverse()]); g.fill(); g.restore();
      line(g, T.map(([x, yy]) => [x, yy + 1.8]), 2.6, shadowOf(dark, 0.2), 0.16);
      line(g, T.map(([x, yy]) => [x, yy - 0.6]), 1.6, lite, 0.22);
    }
  }
  // damp under the parapet (the top of the tile is laid at the top of the wall): darker soft stains
  // with drips running down out of them
  if (damp) {
    for (let i = 0; i < 9; i++) { const x = rnd() * s, y = range(rnd, -4, 22), rx = range(rnd, 26, 70), ry = range(rnd, 10, 26), a = range(rnd, 0.12, 0.26); wrap(s, x, y, rx, (X, Y) => blob(g, X, Y, rx, ry, 0, '#7a4e30', a, 0.15)); }
    rainStreaks(g, s, rnd, 0, s, s * 0.03, '#7a4e30', 9, 0.2);
  }
  // chipped places where the render has fallen away and the mud bricks show
  for (let i = 0; i < chipsN; i++) plasterHole(g, s, rnd, (i + range(rnd, 0.1, 0.9)) / chipsN * s, range(rnd, 0.15, 0.9) * s, range(rnd, 26, 44) * (i ? 1 : 1.25), { plaster: base, brick, mortar: '#6a4830', squash: range(rnd, 0.6, 0.9) });
  // long vertical rain runs (darker, soft) and a few pale salt bloom streaks
  for (const y0 of [s * 0.02, s * 0.36, s * 0.7]) rainStreaks(g, s, rnd, 0, s, y0, dark, 6, 0.16);
  rainStreaks(g, s, rnd, 0, s, s * 0.55, '#f0dcb4', 4, 0.12);
  cracks(g, s, rnd, { color: '#5a3420', count: 9, len: [20, 70], width: [0.8, 1.6], alpha: 0.42 });
  glaze(g, s, s, '#ffe0b0', 0.12, 'soft-light');
  blurTile(cv, 0.6);
}
register('adobe', { family: F, size: 512, note: 'Gadgetzan adobe: warm tan mud render in three related tans (±12%), troweled swirls, straw flecks, three wavy trowel-lift seams, damp stains and drips along the top (laid at the parapet), rain runs (~3 m a tile; chips, patches and the base splash are decals placed per wall)', paint(g, s, rnd, h, cv) { adobePaint(g, s, rnd, cv, { lifts: 3, damp: true }); } });
register('arch_streak', {
  family: F, w: 64, h: 256, alpha: true, note: 'a rain run down an adobe wall from under a viga: dark wet mud fading downward, a couple of drips (alpha decal)',
  paint(g, w, rnd, h) {
    g.clearRect(0, 0, w, h);
    for (let k = 0; k < 4; k++) {
      const x = w / 2 + range(rnd, -12, 12), L = range(rnd, 0.45, 1) * h, ww = range(rnd, 5, 14);
      g.save(); g.filter = 'blur(3px)';
      g.fillStyle = grad(g, 0, 0, 0, L, [[0, '#6a4428', 0.55], [0.5, '#7a5030', 0.32], [1, '#8e6040', 0]]);
      g.beginPath(); g.moveTo(x - ww, 0); g.quadraticCurveTo(x - ww * 0.4, L * 0.6, x + range(rnd, -3, 3), L); g.quadraticCurveTo(x + ww * 0.4, L * 0.6, x + ww, 0); g.closePath(); g.fill();
      g.restore();
    }
    g.fillStyle = grad(g, 0, 0, 0, 30, [[0, '#4a2e1a', 0.5], [1, '#4a2e1a', 0]]); g.fillRect(6, 0, w - 12, 30);
  },
});
register('adobe_inner', {
  family: F, size: 512, note: 'adobe trim and indoor mud: a lighter limewashed tan (parapet caps, piers, upper blocks, interiors)',
  paint(g, s, rnd, h, cv) { adobePaint(g, s, rnd, cv, { base: '#d8b088', blot: ['#e4c49a', '#ccA07a', '#dcb890'], mid: ['#ecd0a6', '#bc906a', '#d6ac80', '#cea47a', '#f0d6ae', '#b48862'], lite: '#f4dcb4', dark: '#9a7050', chipsN: 0 }); },
});

// ---- roofs ----------------------------------------------------------------------------------

register('shingles_red', {
  family: F, size: 512, note: 'Goldshire roof: red-brown wooden shingles, staggered, rounded butts, a little moss',
  paint(g, s, rnd, h, cv) {
    shingles(g, s, rnd, { rows: 8, minW: 34, maxW: 104, colors: ['#9e3e2c', '#b44a30', '#883428', '#9e3e2c', '#a84434'], gapColor: '#2a181c', round: 0.4, grain: 3, moss: 0.14, missing: 0.012, patched: 0.06, butt: 0.45, chips: 0.35 });
    mottle(g, s, rnd, { colors: ['#b85a3c', '#6e2a22', '#8a4a34', '#7a3a2e'], count: 34, rmin: 30, rmax: 100, alpha: 0.14, hard: 0.08 });
    glaze(g, s, s, '#ffd8b0', 0.12, 'soft-light');
    blurTile(cv, 0.45);
  },
});

register('shingles_wood', {
  family: F, size: 512, note: 'barn roof: gray-brown cedar shakes, long and split',
  paint(g, s, rnd, h, cv) {
    shingles(g, s, rnd, { rows: 7, minW: 34, maxW: 70, colors: ['#7a6a58', '#8a7864', '#6e5e4e', '#958470', '#806e5a'], gapColor: '#241c20', round: 0.12, grain: 5, overhang: 0.5, moss: 0.15, mossCols: ['#7a8248', '#8a8a50'] });
    glaze(g, s, s, '#ffe8c0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('slate_roof', {
  family: F, size: 512, note: 'dwarven roof: thick blue-gray slates with chipped corners',
  paint(g, s, rnd, h, cv) {
    shingles(g, s, rnd, { rows: 7, minW: 50, maxW: 96, colors: ['#5a6070', '#666e7e', '#4e5464', '#707888', '#5e6474'], gapColor: '#1e1c28', round: 0.18, chips: 0.5, speck: 8, light: 0.5 });
    glaze(g, s, s, '#d8e4ff', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('thatch', {
  family: F, size: 512, note: 'Westfall thatch: golden-brown straw bundles in ragged overlapping courses, lit bulges, dark under-lips, moss and grey weathering',
  paint(g, s, rnd, h, cv) {
    thatch(g, s, rnd, { courses: 9, base: '#3a2c1c', straw: ['#b09048', '#a08040', '#c0a058', '#a68a46', '#987a3e'], tips: ['#dcc070', '#d0b468', '#e2c87a'], lip: '#5a4628', lit: '#dcc070', moss: 0.13 });
    // grey weathering and sun-bleached patches, big and soft
    mottle(g, s, rnd, { colors: ['#9a9080', '#8e8676', '#a89a80'], count: 18, rmin: 40, rmax: 110, alpha: 0.16, hard: 0.06 });
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5e6a3e'], count: 10, rmin: 10, rmax: 28, alpha: 0.18, hard: 0.25 });
    glaze(g, s, s, '#f0d8a8', 0.08, 'soft-light');
    blurTile(cv, 0.5);
  },
});

register('snow_roof', {
  family: F, size: 256, note: 'snow on roofs and ledges: sunlit cream tops, blue-lavender troughs, soft wind ripples, glints',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e4ebf3');
    mottle(g, s, rnd, { colors: ['#fbf8f0', '#d2dceb', '#b6c6dc', '#f4f2ea'], count: 26, rmin: 26, rmax: 80, alpha: 0.5, hard: 0.08 });
    // wind ripples: long soft ridges, lit on top and blue in the trough below
    for (let i = 0; i < 14; i++) {
      const y = rnd() * s, x0 = rnd() * s, L = range(rnd, 50, 140), a = range(rnd, 2, 5), ph = rnd() * TAU, wl = range(rnd, 40, 90);
      const pts = []; for (let x = 0; x <= L; x += 6) pts.push([x0 + x, y + Math.sin(x / wl * TAU + ph) * a]);
      const lw = range(rnd, 5, 10);
      wrap(s, x0 + L / 2, y, L, (X, Y) => {
        const dx = X - x0 - L / 2, dy = Y - y;
        line(g, pts.map(([u, v]) => [u + dx, v + dy + 4]), lw, '#b0c0da', 0.16);
        line(g, pts.map(([u, v]) => [u + dx, v + dy]), lw * 0.6, '#fffbf0', 0.22);
      });
    }
    for (let i = 0; i < 20; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 10, 28);
      wrap(s, x, y, r * 1.6, (X, Y) => { blob(g, X + r * 0.3, Y + r * 0.35, r, r * 0.6, 0, '#a9bcd8', 0.3, 0.2); blob(g, X - r * 0.2, Y - r * 0.2, r * 0.8, r * 0.5, 0, '#fffdf6', 0.55, 0.25); });
    }
    for (let i = 0; i < 60; i++) { const x = rnd() * s, y = rnd() * s; ellipse(g, x, y, range(rnd, 0.6, 1.4), range(rnd, 0.6, 1.4), 0, '#ffffff', 0.9); }
    glaze(g, s, s, '#e8f0ff', 0.1, 'soft-light');
    blurTile(cv, 0.8);
  },
});

register('hide_patch', {
  family: F, size: 512, note: 'frontier roofing: dark stretched hides sewn edge to edge, paler where they stretch thin, stitched seams, lacing holes',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a3e28');
    const rects = rowLayout(s, rnd, { rows: 3, minW: 150, maxW: 280, rowJitter: 0.35 });
    for (const r of rects) {
      const seed = Math.floor(rnd() * 1e9);
      const c = pick(rnd, ['#8a5a38', '#6e4428', '#7c5030', '#946440', '#82563a', '#9a6a44']);
      wrapRect(s, r.x - 10, r.y - 10, r.w + 20, r.h + 20, (dx, dy) => {
        const rr = rngFrom(seed);
        const x0 = r.x + dx + 3, y0 = r.y + dy + 3, x1 = r.x + dx + r.w - 3, y1 = r.y + dy + r.h - 3, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
        const j = () => (rr() - 0.5) * 10;
        // an irregular stretched hide: corners pulled out, edges sagging in between
        const pts = [[x0 + j(), y0 + j()], [cx + j(), y0 + 6 + rr() * 6], [x1 + j(), y0 + j()], [x1 - 6 - rr() * 6, cy + j()], [x1 + j(), y1 + j()], [cx + j(), y1 - 6 - rr() * 6], [x0 + j(), y1 + j()], [x0 + 6 + rr() * 6, cy + j()]];
        clipped(g, () => polyPath(g, pts), () => {
          const rg = g.createRadialGradient(cx - r.w * 0.1, cy - r.h * 0.15, 4, cx, cy, Math.max(r.w, r.h) * 0.62);
          rg.addColorStop(0, lightOf(c, 0.35)); rg.addColorStop(0.55, c); rg.addColorStop(1, shadowOf(c, 0.45));
          g.fillStyle = rg; g.fillRect(x0 - 12, y0 - 12, r.w + 24, r.h + 24);
          // stretch lines from the corners toward the middle
          for (const [px, py] of [pts[0], pts[2], pts[4], pts[6]]) for (let k = 0; k < 3; k++) {
            const tx = cx + (rr() - 0.5) * r.w * 0.4, ty = cy + (rr() - 0.5) * r.h * 0.4;
            line(g, [[px, py], [px + (tx - px) * 0.55, py + (ty - py) * 0.55]], range(rr, 2, 4), shadowOf(c, 0.35), 0.28);
            line(g, [[px + 2, py + 2], [px + (tx - px) * 0.5 + 2, py + (ty - py) * 0.5 + 2]], range(rr, 1, 2), lightOf(c, 0.35), 0.22);
          }
          for (let i = 0; i < 12; i++) blob(g, x0 + rr() * r.w, y0 + rr() * r.h, range(rr, 4, 14), range(rr, 3, 9), rr() * 3, rr() < 0.5 ? '#5a3c26' : '#d8bc94', 0.18, 0.3);
          // a scar or a burn mark now and then
          if (rr() < 0.4) line(g, [[cx - 20, cy + 5], [cx + 18, cy - 4]], 3, '#4a3020', 0.4);
        });
        // lacing holes at the corners, a stitched seam just inside the edge, dark edge
        g.save(); g.translate(cx, cy); g.scale(0.92, 0.9); g.translate(-cx, -cy);
        g.setLineDash([7, 5]); g.lineWidth = 2.6; g.strokeStyle = rgba('#3a2214', 0.6); g.translate(1, 1.4); polyPath(g, pts); g.stroke(); g.translate(-1, -1.4);
        g.lineWidth = 2.2; g.strokeStyle = rgba('#d8bc8c', 0.75); polyPath(g, pts); g.stroke();
        g.restore();
        g.lineWidth = 2.5; g.strokeStyle = rgba(shadowOf(c, 0.65), 0.75); polyPath(g, pts); g.stroke();
        for (const [px, py] of [pts[0], pts[2], pts[4], pts[6]]) { ellipse(g, px + (cx - px) * 0.08, py + (cy - py) * 0.08, 3, 3, 0, '#2a1a14'); line(g, [[px + (cx - px) * 0.08, py + (cy - py) * 0.08], [px - (cx - px) * 0.05, py - (cy - py) * 0.05]], 2, '#c8b088', 0.8); }
      });
    }
    glaze(g, s, s, '#ffd8a8', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  },
});

// ---- trim, metal, cloth --------------------------------------------------------------------------

register('timber_dark', {
  family: F, size: 256, note: 'dark oak beams and posts: lit and shaded streaks along the grain, splits, knots, end checks',
  paint(g, s, rnd, h, cv) {
    grainTile(g, s, rnd, { base: '#5e4330', dark: ['#2a1c14', '#3a281e', '#33241c'], lite: ['#7a5a3c', '#8a6848', '#74563a'], lines: 50, splits: 6, knots: 3, alpha: 0.5 });
    // broad worn highlights and shaded hollows running along the beam
    for (let i = 0; i < 7; i++) {
      const x = rnd() * s, w = range(rnd, 8, 26), lit = rnd() < 0.55;
      for (const dx of [-s, 0, s]) blob(g, x + dx, s / 2, w, s * 0.75, 0, lit ? '#8a6a4c' : '#2a1c14', lit ? 0.2 : 0.22, 0.1);
    }
    for (let i = 0; i < 10; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 4, 10), dx = range(rnd, -2, 2);
      wrap(s, x, y, 12, (X, Y) => { line(g, [[X, Y], [X + dx, Y + L]], 1.6, '#1e1410', 0.55); line(g, [[X + 1.2, Y], [X + 1.2, Y + L]], 0.8, '#9a7a58', 0.35); });
    }
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('wood_light', {
  family: F, size: 256, note: 'honey oak for furniture, counters, frames and wheels: grain along v',
  paint(g, s, rnd, h, cv) {
    grainTile(g, s, rnd, { base: '#8e5e36', dark: ['#5e3c24', '#6a4428', '#4e3222'], lite: ['#b07a48', '#c08a54'], lines: 44, splits: 3, knots: 2 });
    glaze(g, s, s, '#ffe0b0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('wood_white', {
  family: F, size: 256, note: 'whitewashed barn trim: chalky cream paint, worn to gray wood along the grain',
  paint(g, s, rnd, h, cv) {
    grainTile(g, s, rnd, { base: '#d6cab2', dark: ['#9a8c78', '#8a7c6a', '#b0a28c'], lite: ['#f2ead8', '#ece2cc'], lines: 30, splits: 3, knots: 1, alpha: 0.35 });
    mottle(g, s, rnd, { colors: ['#a09484', '#f4ecdc'], count: 26, rmin: 6, rmax: 22, alpha: 0.25, hard: 0.3, stretch: 2.5, rot: Math.PI / 2 });
    glaze(g, s, s, '#fff0d0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('iron_wrought', {
  family: F, size: 128, note: 'wrought iron: hammered blue-gray, lit scratches, rust blooms',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#4a4650');
    mottle(g, s, rnd, { colors: ['#5c5864', '#3a3840', '#6a6672', '#7a7480'], count: 26, rmin: 6, rmax: 22, alpha: 0.5, hard: 0.2 });
    mottle(g, s, rnd, { colors: ['#7a4630', '#8e5232', '#6a3a28'], count: 12, rmin: 3, rmax: 10, alpha: 0.45, hard: 0.35 });
    streaks(g, s, rnd, { colors: ['#9a98a4', '#b0aeb8'], count: 16, len: [5, 16], width: [0.6, 1.1], angle: 1.2, wobble: 0.3, alpha: 0.45 });
    blurTile(cv, 0.5);
  },
});

register('brass', {
  family: F, size: 256, note: 'goblin brass: warm gold, lit edges, dark creases, green patina in the recesses, rivets',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#b08a3c');
    mottle(g, s, rnd, { colors: ['#c8a050', '#8a6a2c', '#d8b860', '#a07a34'], count: 30, rmin: 14, rmax: 50, alpha: 0.45, hard: 0.1, stretch: 2.5, rot: 0 });
    streaks(g, s, rnd, { colors: ['#f0d080', '#7a5a24'], count: 70, len: [20, 90], width: [0.6, 1.4], angle: Math.PI / 2, wobble: 0.02, alpha: 0.28 });
    // seams: a dark crease with a lit lip, patina collecting in the crease
    for (const y of [s * 0.25, s * 0.75]) {
      line(g, [[0, y + 2], [s, y + 2]], 5, '#5a4018', 0.55);
      line(g, [[0, y - 1.5], [s, y - 1.5]], 2, '#f0d080', 0.6);
      for (let i = 0; i < 10; i++) { const x = rnd() * s, bw = range(rnd, 6, 16), bh = range(rnd, 2, 4); wrap(s, x, y + 3, 20, (X, Y) => blob(g, X, Y, bw, bh, 0, '#6a8a5a', 0.55, 0.3)); }
      for (let k = 0; k < 8; k++) rivet(g, (k + 0.5) * s / 8, y + 10, 3.2, '#c8a050');
    }
    mottle(g, s, rnd, { colors: ['#6a8a5a', '#5a7a52'], count: 12, rmin: 3, rmax: 9, alpha: 0.3, hard: 0.3 });
    for (let i = 0; i < 6; i++) { const x = rnd() * s, y = rnd() * s, bw = range(rnd, 10, 26), bh = range(rnd, 3, 6); wrap(s, x, y, 30, (X, Y) => blob(g, X, Y, bw, bh, -0.5, '#fff0b8', 0.35, 0.3)); }
    blurTile(cv, 0.4);
  },
});

register('metal_green', {
  family: F, size: 256, note: 'goblin vehicle plate: painted olive-green steel, rivets, chips, rust runs',
  paint(g, s, rnd, h, cv) {
    plates(g, s, rnd, { colors: ['#56703e', '#5e7a44', '#4a6438', '#647e48'], rows: 2, minW: 90, maxW: 170, rivetCol: '#a89a70' });
    glaze(g, s, s, '#ffe8c0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('metal_red', {
  family: F, size: 256, note: 'goblin plate: painted brick-red steel, rivets, chips, rust runs',
  paint(g, s, rnd, h, cv) {
    plates(g, s, rnd, { colors: ['#8a3a2a', '#9a4430', '#7e3426', '#a04a34'], rows: 2, minW: 90, maxW: 170, rivetCol: '#c8a050' });
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

function canvasStripes(g, s, rnd, cv, dark, light) {
  const n = 8, W = s / n;
  for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? light : dark; g.fillRect(i * W, 0, W, s); }
  mottle(g, s, rnd, { colors: ['#f0e4c8', '#8a6a50', '#c8b490'], count: 30, rmin: 10, rmax: 40, alpha: 0.18, hard: 0.1 });
  for (let k = 0; k < 4; k++) {
    const y = (k + 0.5) * s / 4 + range(rnd, -6, 6);
    g.fillStyle = grad(g, 0, y - 18, 0, y + 18, [[0, '#2a2030', 0], [0.5, '#2a2030', 0.16], [0.6, '#fff4dc', 0.16], [1, '#fff4dc', 0]]);
    g.fillRect(0, y - 18, s, 36);
  }
  for (let i = 0; i < n; i++) line(g, [[i * W, 0], [i * W, s]], 1.2, '#5a3a30', 0.35);
  streaks(g, s, rnd, { colors: ['#7a5a40'], count: 8, len: [20, 60], width: [3, 7], angle: Math.PI, wobble: 0.1, alpha: 0.12 });
  // sun-faded patches
  mottle(g, s, rnd, { colors: ['#f4ead4'], count: 8, rmin: 30, rmax: 70, alpha: 0.12, hard: 0.05 });
  glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
  blurTile(cv, 0.6);
}
register('canvas_stripe', { family: F, size: 256, note: 'awning canvas: faded rust and cream stripes, folds, stains', paint(g, s, rnd, h, cv) { canvasStripes(g, s, rnd, cv, '#a84a30', '#e0d2b2'); } });
register('canvas_teal', { family: F, size: 256, note: 'awning canvas: faded teal and cream', paint(g, s, rnd, h, cv) { canvasStripes(g, s, rnd, cv, '#4a8a8a', '#e2d6b8'); } });
register('canvas_mustard', { family: F, size: 256, note: 'awning canvas: mustard and cream', paint(g, s, rnd, h, cv) { canvasStripes(g, s, rnd, cv, '#c89a3a', '#e6dcc0'); } });

// ---- interiors ----------------------------------------------------------------------------------

register('floor_planks', {
  family: F, size: 512, note: 'interior floor: long honey boards, nail pairs, scuffs',
  paint(g, s, rnd, h, cv) {
    planks(g, s, rnd, { rows: 9, minL: 170, maxL: 420, colors: ['#8a5a34', '#94643a', '#7c5030', '#9c6c40', '#86583a'], gap: 3, gapColor: '#2a1c18', grain: 9, nails: 2, knots: 0.3, splits: 0.2, endShade: 0.2 });
    streaks(g, s, rnd, { colors: ['#c8a070', '#5a3a24'], count: 40, len: [6, 22], width: [1, 2.5], angle: Math.PI / 2, wobble: 0.6, alpha: 0.18 });
    glaze(g, s, s, '#ffd8a8', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('carpet_casino', {
  family: F, size: 512, note: 'gambling hall carpet: deep red, a hand-drawn gold lattice, three kinds of medallion, worn paths and faded patches',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7a2026');
    mottle(g, s, rnd, { colors: ['#8a2a2c', '#6a1c22', '#842830'], count: 40, rmin: 20, rmax: 80, alpha: 0.4, hard: 0.1 });
    // small damask sprigs
    for (let i = 0; i < 70; i++) { const x = rnd() * s, y = rnd() * s, ra = rnd() * 3; wrap(s, x, y, 8, (X, Y) => { ellipse(g, X, Y, 3, 1.6, ra, '#9a3a34', 0.6); ellipse(g, X + 2, Y + 2, 1.6, 1.6, 0, '#a8483c', 0.5); }); }
    // the lattice: hand-wobbled gold strokes, a dark under-stroke and a light upper edge
    const P = 256;
    for (const dir of [1, -1]) for (let k = -3; k <= 4; k++) {
      const pts = [];
      for (let t = 0; t <= 24; t++) { const u = t / 24; const x = dir > 0 ? k * P - 10 + (s + 20) * u : k * P + 10 - (s + 20) * u; pts.push([x + Math.sin(u * 17 + k) * 1.4 + (rnd() - 0.5) * 1.2, -10 + (s + 20) * u]); }
      line(g, pts.map(([x, y]) => [x + 1.5, y + 2]), 7, '#3a0e14', 0.5);
      line(g, pts, range(rnd, 3.5, 5), '#b88a3a', 0.72);
      line(g, pts.map(([x, y]) => [x - 0.8, y - 1]), 1.3, '#f0d088', 0.45);
    }
    // three medallion designs at the lattice cells
    const med = (X, Y, kind) => {
      if (kind === 0) {
        for (let k = 0; k < 6; k++) { const a = k * TAU / 6; ellipse(g, X + Math.cos(a) * 20, Y + Math.sin(a) * 20, 12, 6, a, '#5a1418', 0.85); ellipse(g, X + Math.cos(a) * 20, Y + Math.sin(a) * 20, 9.5, 4.5, a, '#c89a48', 0.8); }
        ellipse(g, X + 1.5, Y + 2, 15, 15, 0, '#3a0e14', 0.5); ellipse(g, X, Y, 14, 14, 0, '#c49440'); ellipse(g, X, Y, 9, 9, 0, '#8a6424');
        blob(g, X - 4, Y - 4, 6, 5, 0, '#ffe8a0', 0.6, 0.4);
      } else if (kind === 1) {
        g.save(); g.translate(X, Y); g.rotate(Math.PI / 4);
        g.fillStyle = '#3a0e14'; g.globalAlpha = 0.5; g.fillRect(-15, -13, 32, 32); g.globalAlpha = 1;
        g.fillStyle = '#b88a3a'; g.fillRect(-16, -16, 32, 32); g.fillStyle = '#6a1a20'; g.fillRect(-11, -11, 22, 22); g.fillStyle = '#c89a48'; g.fillRect(-5, -5, 10, 10);
        g.restore();
        for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; ellipse(g, X + Math.cos(a) * 28, Y + Math.sin(a) * 28, 5, 5, 0, '#c89a48', 0.85); }
      } else {
        for (let k = 0; k < 8; k++) { const a = k * TAU / 8; line(g, [[X, Y], [X + Math.cos(a) * 24, Y + Math.sin(a) * 24]], 3, '#b88a3a', 0.75); ellipse(g, X + Math.cos(a) * 24, Y + Math.sin(a) * 24, 4, 4, 0, '#d8b060', 0.9); }
        ellipse(g, X, Y, 10, 10, 0, '#5a1418'); ellipse(g, X, Y, 6, 6, 0, '#d8b060');
      }
    };
    let i = 0;
    for (let y = 0; y < s; y += P / 2) for (let x = (y / (P / 2)) % 2 ? P / 2 : 0; x < s; x += P) { const kind = i++ % 3; wrap(s, x + P / 4, y + P / 4, 40, (X, Y) => med(X, Y, kind)); }
    // worn traffic paths and sun-faded patches
    for (let k = 0; k < 6; k++) { const x = rnd() * s, y = rnd() * s, bw = range(rnd, 50, 110), bh = range(rnd, 25, 60), ba = rnd() * 3; wrap(s, x, y, 120, (X, Y) => blob(g, X, Y, bw, bh, ba, '#4a1418', 0.22, 0.05)); }
    for (let k = 0; k < 4; k++) { const x = rnd() * s, y = rnd() * s, bw = range(rnd, 40, 90), bh = range(rnd, 30, 70), ba = rnd() * 3; wrap(s, x, y, 100, (X, Y) => blob(g, X, Y, bw, bh, ba, '#b06a5a', 0.14, 0.05)); }
    for (let k = 0; k < 400; k++) ellipse(g, rnd() * s, rnd() * s, 0.9, 0.9, 0, rnd() < 0.5 ? '#a04040' : '#4a1418', 0.25);
    glaze(g, s, s, '#ffd0a0', 0.1, 'soft-light');
    blurTile(cv, 0.7);
  },
});

register('carpet_border', {
  family: F, w: 512, h: 64, note: 'the casino carpet border band: gold guard stripes and a running scroll on dark red (tiles along u)',
  paint(g, s, rnd, H, cv) {
    const W = 512;
    g.fillStyle = '#4a1418'; g.fillRect(0, 0, W, H);
    g.fillStyle = '#b88a3a'; g.fillRect(0, 6, W, 5); g.fillRect(0, H - 11, W, 5);
    g.fillStyle = '#f0d088'; g.globalAlpha = 0.45; g.fillRect(0, 6, W, 1.5); g.fillRect(0, H - 11, W, 1.5); g.globalAlpha = 1;
    const pts = []; for (let x = -4; x <= W + 4; x += 4) pts.push([x, H / 2 + Math.sin(x / W * TAU * 8) * 9]);
    line(g, pts.map(([x, y]) => [x + 1, y + 1.5]), 5, '#2a0a0e', 0.5);
    line(g, pts, 3.5, '#c89a48', 0.85);
    for (let k = 0; k < 8; k++) { const x = (k + 0.25) * W / 8; ellipse(g, x, H / 2 - 9, 3.5, 3.5, 0, '#d8b060'); ellipse(g, x + W / 16, H / 2 + 9, 3.5, 3.5, 0, '#d8b060'); }
    for (let k = 0; k < 30; k++) blob(g, rnd() * W, rnd() * H, range(rnd, 10, 30), range(rnd, 5, 12), 0, '#2a0a0e', 0.16, 0.1);
    glaze(g, W, H, '#ffd0a0', 0.1, 'soft-light');
  },
});

register('tile_goblin', {
  family: F, size: 512, note: 'Gadgetzan gambling-hall floor: glazed ochre and terracotta tiles, teal diamond insets, brass inlay strips with rivets at the joints',
  paint(g, s, rnd, h, cv) {
    const n = 4, T = s / n, gap = 7;
    fill(g, s, s, '#6a4c22');
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const x = i * T + gap / 2, y = j * T + gap / 2, w = T - gap, c = jitter(pick(rnd, ['#b8783c', '#c48a48', '#ac6c36', '#c07e44']), rnd, 0.06);
      g.save(); g.beginPath(); g.roundRect(x, y, w, w, 5); g.clip();
      g.fillStyle = grad(g, x, y, x + w * 0.6, y + w, [[0, lightOf(c, 0.3)], [0.5, c], [1, shadowOf(c, 0.3)]]); g.fillRect(x, y, w, w);
      for (let k = 0; k < 5; k++) blob(g, x + rnd() * w, y + rnd() * w, range(rnd, 10, 34), range(rnd, 8, 24), rnd() * 3, rnd() < 0.5 ? lightOf(c, 0.2) : shadowOf(c, 0.25), 0.3, 0.15);
      if ((i + j) % 2 === 0) {
        // a teal glazed diamond, a cream keyline round it
        const cx = x + w / 2, cy = y + w / 2, r = w * 0.36, tc = jitter('#3a7a72', rnd, 0.06);
        const dia = (rr) => { g.beginPath(); g.moveTo(cx, cy - rr); g.lineTo(cx + rr, cy); g.lineTo(cx, cy + rr); g.lineTo(cx - rr, cy); g.closePath(); };
        dia(r + 6); g.fillStyle = '#e6d2a0'; g.fill();
        dia(r); g.fillStyle = grad(g, cx - r, cy - r, cx + r, cy + r, [[0, lightOf(tc, 0.35)], [0.5, tc], [1, shadowOf(tc, 0.35)]]); g.fill();
        dia(r * 0.45); g.fillStyle = '#d8b060'; g.fill();
        blob(g, cx - r * 0.35, cy - r * 0.35, r * 0.3, r * 0.18, -0.8, '#e8fff8', 0.3, 0.3);
      } else {
        // a little brass coin stamp in the corner
        ellipse(g, x + w * 0.5, y + w * 0.5, 9, 9, 0, '#8a6424', 0.8); ellipse(g, x + w * 0.5 - 1, y + w * 0.5 - 1, 7, 7, 0, '#d8b060', 0.8);
      }
      // glaze sheen and worn traffic in the middle of the tile
      blob(g, x + w * 0.3, y + w * 0.25, w * 0.3, w * 0.12, -0.6, '#fff4dc', 0.18, 0.2);
      g.restore();
      // lit top-left bevel, shaded lower-right
      g.save(); g.globalAlpha = 0.45; g.fillStyle = lightOf(c, 0.6); g.fillRect(x, y, w, 3); g.fillRect(x, y, 3, w);
      g.globalAlpha = 0.5; g.fillStyle = shadowOf(c, 0.5); g.fillRect(x, y + w - 3, w, 3); g.fillRect(x + w - 3, y, 3, w); g.restore();
    }
    // brass inlay strips in the joints: lit upper edge, rivets where they cross
    for (let k = 0; k < n; k++) for (const v of [false, true]) {
      const p0 = k * T;
      for (const q of k === 0 ? [p0, p0 + s] : [p0]) {
        if (v) { g.fillStyle = grad(g, q - 3, 0, q + 3, 0, [[0, '#f0d080'], [0.5, '#b88a3c'], [1, '#6a4a1e']]); g.fillRect(q - 3, 0, 6, s); }
        else { g.fillStyle = grad(g, 0, q - 3, 0, q + 3, [[0, '#f0d080'], [0.5, '#b88a3c'], [1, '#6a4a1e']]); g.fillRect(0, q - 3, s, 6); }
      }
    }
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) rivet(g, i * T, j * T, 5, '#d8b060');
    cracks(g, s, rnd, { color: '#3a2418', count: 6, len: [16, 50], width: [0.8, 1.4], alpha: 0.45 });
    mottle(g, s, rnd, { colors: ['#4a3018', '#e8c890'], count: 20, rmin: 30, rmax: 90, alpha: 0.1, hard: 0.05 });
    glaze(g, s, s, '#ffd8a8', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});

register('rug_red', {
  family: F, size: 256, alpha: true, note: 'woven rug: bordered red field with a gold medallion, fringed ends (alpha)',
  paint(g, s, rnd, h, cv) {
    const band = (inset, col) => { g.fillStyle = col; g.fillRect(inset, inset + 10, s - 2 * inset, s - 2 * inset - 20); };
    band(4, '#3a3050'); band(12, '#c8a050'); band(18, '#7a2a28'); band(36, '#d0b070'); band(41, '#8e3430');
    for (let x = 26; x < s - 26; x += 14) { ellipse(g, x, 27, 4, 4, 0, '#d8b868'); ellipse(g, x, s - 27, 4, 4, 0, '#d8b868'); }
    for (let y = 26; y < s - 26; y += 14) { ellipse(g, 30, y, 4, 4, 0, '#d8b868'); ellipse(g, s - 30, y, 4, 4, 0, '#d8b868'); }
    const c = s / 2;
    g.save(); g.translate(c, c); g.rotate(Math.PI / 4);
    g.fillStyle = '#2e3a5a'; g.fillRect(-52, -52, 104, 104);
    g.fillStyle = '#c8a050'; g.fillRect(-42, -42, 84, 84);
    g.fillStyle = '#8e3430'; g.fillRect(-34, -34, 68, 68);
    g.restore();
    ellipse(g, c, c, 18, 18, 0, '#d8b868'); ellipse(g, c, c, 10, 10, 0, '#2e3a5a');
    for (let x = 8; x < s - 8; x += 5) { line(g, [[x, 2], [x + (rnd() - 0.5) * 3, 15]], 2.2, '#e8dcbc', 1); line(g, [[x, s - 2], [x + (rnd() - 0.5) * 3, s - 15]], 2.2, '#e8dcbc', 1); }
    g.save(); g.globalCompositeOperation = 'source-atop';
    mottle(g, s, rnd, { colors: ['#5a2420', '#e0c890', '#2a2030'], count: 50, rmin: 6, rmax: 26, alpha: 0.12, hard: 0.2 });
    for (let y = 14; y < s - 14; y += 3) line(g, [[4, y], [s - 4, y]], 0.8, '#2a2030', 0.06);
    g.restore();
  },
});

register('felt_table', {
  family: F, w: 512, h: 256, note: 'blackjack felt: green baize, gold arc and lettering, card boxes (player side at the bottom)',
  paint(g, s, rnd, H, cv) {
    const W = 512;
    g.fillStyle = '#2c6a40'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 40; i++) blob(g, rnd() * W, rnd() * H, range(rnd, 20, 70), range(rnd, 14, 50), rnd() * 3, pick(rnd, ['#327448', '#24603a', '#2e6e42']), 0.35, 0.1);
    g.fillStyle = grad(g, 0, 0, 0, H, [[0, '#1a3a26', 0.35], [0.5, '#1a3a26', 0], [1, '#1a3a26', 0.25]]); g.fillRect(0, 0, W, H);
    // the arc
    const cx = W / 2, cy = -H * 0.95, R = H * 1.62;
    g.save(); g.lineWidth = 5; g.strokeStyle = '#d8b460'; g.beginPath(); g.arc(cx, cy, R, Math.PI * 0.28, Math.PI * 0.72); g.stroke();
    g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R - 14, Math.PI * 0.3, Math.PI * 0.7); g.stroke(); g.restore();
    g.save(); g.fillStyle = '#e4c470'; g.font = `bold 21px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const txt = 'BLACKJACK PAYS 3 TO 2', R2 = R - 34;
    const n = txt.length, span = n * 13 / R2;
    for (let i = 0; i < n; i++) { const a = Math.PI / 2 + span * (0.5 - i / (n - 1)); g.save(); g.translate(cx + Math.cos(a) * R2, cy + Math.sin(a) * R2); g.rotate(a - Math.PI / 2); g.fillText(txt[i], 0, 0); g.restore(); }
    g.font = `bold 14px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`; g.fillStyle = '#c8b070';
    g.fillText('DEALER STANDS ON 17', cx, H * 0.24);
    g.restore();
    // card spots: dealer row and player row
    const box = (x, y, w, hh) => { g.save(); g.strokeStyle = rgba('#e8d8a0', 0.75); g.lineWidth = 2.5; g.beginPath(); g.roundRect(x, y, w, hh, 6); g.stroke(); g.restore(); };
    box(cx - 46, H * 0.06, 92, 44);
    box(cx - 56, H * 0.62, 112, 56);
    for (let k = 0; k < 2; k++) { ellipse(g, cx + (k ? 150 : -150), H * 0.8, 24, 24, 0, '#e8d8a0', 0.18); ellipse(g, cx + (k ? 150 : -150), H * 0.8, 20, 20, 0, '#2c6a40', 1); }
    for (let i = 0; i < 1800; i++) ellipse(g, rnd() * W, rnd() * H, 0.8, 0.8, 0, rnd() < 0.5 ? '#3a8052' : '#1e4e30', 0.35);
    glaze(g, W, H, '#fff0c0', 0.08, 'soft-light');
  },
});

// ---- pieces ------------------------------------------------------------------------------------

// Wear over a painted badge: a darker vignette, a soft lit top-left, scratches and worn edges.
function wear(g, W, H, rnd, { edge = '#2a1a14', lit = '#fff0c8', scratches = 24 } = {}) {
  const vg = g.createRadialGradient(W * 0.38, H * 0.32, Math.min(W, H) * 0.15, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
  vg.addColorStop(0, rgba(lit, 0.12)); vg.addColorStop(0.55, rgba(lit, 0)); vg.addColorStop(1, rgba(edge, 0.42));
  g.fillStyle = vg; g.fillRect(0, 0, W, H);
  for (let i = 0; i < scratches; i++) {
    const x = rnd() * W, y = rnd() * H, a = range(rnd, -0.6, 0.6) + (rnd() < 0.5 ? 0 : Math.PI / 2), L = range(rnd, 6, 26);
    line(g, [[x, y], [x + Math.cos(a) * L, y + Math.sin(a) * L]], range(rnd, 0.6, 1.2), rnd() < 0.6 ? '#f0e4c8' : edge, 0.3);
  }
  chips(g, 0, 0, W, H, rnd, Math.round((W + H) / 18), '#5a4632');
}

register('door_plank', {
  family: F, w: 256, h: 512, note: 'plank door with iron straps, studs and a ring pull',
  paint(g, s, rnd, H, cv) {
    const W = 256;
    fill(g, W, H, '#1e1418');
    const n = 4, pw = W / n;
    for (let i = 0; i < n; i++) plank(g, i * pw + 1.5, 0, pw - 3, H, jitter(pick(rnd, ['#6e4a2e', '#7a5434', '#664428']), rnd, 0.06), rnd, { vertical: true, grain: 14, knots: 0.5, splits: 0.5, bevel: 4 });
    for (const y of [H * 0.16, H * 0.8]) {
      g.fillStyle = grad(g, 0, y - 14, 0, y + 14, [[0, '#6a6a74'], [0.4, '#45444c'], [1, '#26242c']]);
      g.beginPath(); g.moveTo(8, y - 12); g.lineTo(W - 30, y - 12); g.quadraticCurveTo(W - 8, y - 18, W - 10, y); g.quadraticCurveTo(W - 8, y + 18, W - 30, y + 12); g.lineTo(8, y + 12); g.closePath(); g.fill();
      line(g, [[10, y - 11], [W - 32, y - 11]], 2, '#a8a8b4', 0.6);
      for (let x = 22; x < W - 30; x += 40) rivet(g, x, y, 4.5, '#6a6a74');
    }
    ellipse(g, W * 0.22 + 3, H * 0.52 + 4, 22, 22, 0, INK, 0.3);
    g.save(); g.lineWidth = 6; g.strokeStyle = '#4a4850'; g.beginPath(); g.arc(W * 0.22, H * 0.55, 18, 0, TAU); g.stroke();
    g.lineWidth = 2; g.strokeStyle = '#a8a6b0'; g.beginPath(); g.arc(W * 0.22 - 1, H * 0.55 - 1, 18, Math.PI * 1.0, Math.PI * 1.6); g.stroke(); g.restore();
    rivet(g, W * 0.22, H * 0.52, 7, '#5a5860');
    g.fillStyle = grad(g, 0, 0, 0, H, [[0, INK, 0.3], [0.1, INK, 0], [0.9, INK, 0], [1, INK, 0.35]]); g.fillRect(0, 0, W, H);
    glaze(g, W, H, '#ffd8b0', 0.1, 'soft-light');
  },
});

register('window_lead', {
  family: F, size: 256, note: 'leaded window: wooden frame, diamond panes glowing with warm lamplight (also the emissive map)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#3a2618');
    const fr = 22;
    g.fillStyle = grad(g, 0, fr, 0, s - fr, [[0, '#7a5a3a'], [0.35, '#d8a058'], [0.75, '#f0c070'], [1, '#c88a48']]);
    g.fillRect(fr, fr, s - 2 * fr, s - 2 * fr);
    blob(g, s * 0.5, s * 0.66, s * 0.36, s * 0.3, 0, '#ffe0a0', 0.6, 0.2);
    blob(g, s * 0.36, s * 0.42, s * 0.14, s * 0.2, 0, '#8a5a3a', 0.35, 0.2);
    for (let i = 0; i < 40; i++) blob(g, fr + rnd() * (s - 2 * fr), fr + rnd() * (s - 2 * fr), range(rnd, 4, 12), range(rnd, 4, 12), 0, pick(rnd, ['#ffe8b0', '#c88848', '#f8d088']), 0.25, 0.3);
    g.save(); g.beginPath(); g.rect(fr, fr, s - 2 * fr, s - 2 * fr); g.clip();
    const P = 34;
    for (let k = -10; k <= 20; k++) {
      line(g, [[k * P, 0], [k * P + s, s]], 3, '#3a3036', 0.85);
      line(g, [[k * P, s], [k * P + s, 0]], 3, '#3a3036', 0.85);
    }
    for (let k = -10; k <= 20; k++) line(g, [[k * P - 1, 1], [k * P + s - 1, s + 1]], 1, '#fff4d0', 0.3);
    g.restore();
    // mullions
    g.fillStyle = '#4a3220'; g.fillRect(s / 2 - 6, fr, 12, s - 2 * fr); g.fillRect(fr, s * 0.45 - 6, s - 2 * fr, 12);
    g.fillStyle = '#7a5434'; g.fillRect(s / 2 - 6, fr, 4, s - 2 * fr); g.fillRect(fr, s * 0.45 - 6, s - 2 * fr, 4);
    // frame bevel
    g.fillStyle = grad(g, 0, 0, s, s, [[0, '#8a6440'], [1, '#3a2418']]);
    g.save(); g.beginPath(); g.rect(0, 0, s, s); g.rect(fr, s - fr, s - 2 * fr, -(s - 2 * fr)); g.clip('evenodd'); g.fillRect(0, 0, s, s); g.restore();
    line(g, [[2, s - 2], [2, 2], [s - 2, 2]], 3, '#b08454', 0.7, 'butt');
    line(g, [[fr, s - fr], [s - fr, s - fr], [s - fr, fr]], 3, '#9a7048', 0.6, 'butt');
    line(g, [[fr, s - fr], [fr, fr], [s - fr, fr]], 5, '#1e1218', 0.6, 'butt');
  },
});

register('lantern_glass', {
  family: F, size: 128, note: 'lantern pane: warm glow, brighter low in the middle, sooty top, iron cross bars',
  paint(g, s, rnd) {
    const gr = g.createRadialGradient(s / 2, s * 0.62, 2, s / 2, s * 0.6, s * 0.7);
    gr.addColorStop(0, '#fffbe8'); gr.addColorStop(0.3, '#ffe2a0'); gr.addColorStop(0.7, '#f0a850'); gr.addColorStop(1, '#a86030');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    g.fillStyle = grad(g, 0, 0, 0, s * 0.35, [[0, '#3a2418', 0.6], [1, '#3a2418', 0]]); g.fillRect(0, 0, s, s * 0.35);
    g.fillStyle = '#2e2a30'; g.fillRect(s / 2 - 3, 0, 6, s); g.fillRect(0, s * 0.5 - 3, s, 6);
    g.fillRect(0, 0, s, 6); g.fillRect(0, s - 6, s, 6); g.fillRect(0, 0, 6, s); g.fillRect(s - 6, 0, 6, s);
  },
});

// the casino button domes, four glasses side by side (u quarters: bet gold, all-in red, clear grey, deal
// green); the material glows with the texture's own colour, so every button is its colour in one draw
export const BTN_GLASS = ['#e0b048', '#c8402e', '#9a9aa6', '#4aa85a'];
register('arch_btn_glass', {
  family: F, size: 128, note: 'casino button domes: four coloured glasses (gold, red, grey, green) side by side, a bright crown, a darker refracting band, a lit rim',
  paint(g, s, rnd) {
    BTN_GLASS.forEach((c, i) => {
      const x0 = i * s / 4;
      // sphere UVs: v = 1 at the crown (canvas top), 0.5 at the base of the dome
      g.fillStyle = grad(g, 0, 0, 0, s, [[0, lightOf(c, 0.9)], [0.16, lightOf(c, 0.45)], [0.34, c], [0.45, shadowOf(c, 0.45)], [0.5, lightOf(c, 0.3)], [1, c]]);
      g.fillRect(x0, 0, s / 4, s);
      for (let k = 0; k < 3; k++) { const x = x0 + 4 + rnd() * (s / 4 - 8); line(g, [[x, s * 0.06], [x + range(rnd, -3, 3), s * 0.36]], range(rnd, 1.5, 3), '#fff8e0', 0.3); }
    });
  },
});
register('slot_face', {
  family: F, w: 256, h: 512, note: 'goblin slot machine front: brass frame, three painted reels, gem lamps, coin tray',
  paint(g, s, rnd, H, cv) {
    const W = 256;
    fill(g, W, H, '#6a2e2a');
    for (let i = 0; i < 30; i++) blob(g, rnd() * W, rnd() * H, range(rnd, 14, 40), range(rnd, 10, 30), 0, pick(rnd, ['#7a3a32', '#5a2622', '#844238']), 0.35, 0.15);
    const brassBand = (x, y, w, h) => { g.fillStyle = grad(g, 0, y, 0, y + h, [[0, '#f0d080'], [0.4, '#b88a3c'], [1, '#5a3e1a']]); g.fillRect(x, y, w, h); };
    brassBand(0, 0, W, 16); brassBand(0, H - 16, W, 16);
    g.fillStyle = grad(g, 0, 0, W, 0, [[0, '#f0d080'], [0.5, '#b88a3c'], [1, '#5a3e1a']]); g.fillRect(0, 0, 14, H); g.fillRect(W - 14, 0, 14, H);
    // marquee: arched top with gem lamps
    g.fillStyle = grad(g, 0, 24, 0, 130, [[0, '#3a1a20'], [1, '#5a2228']]); g.beginPath(); g.roundRect(26, 26, W - 52, 100, 40); g.fill();
    g.save(); g.fillStyle = '#e8c468'; g.font = `bold 42px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#2a1018'; g.fillText('SLOP', W / 2 + 2, 80 + 3); g.fillStyle = '#e8c468'; g.fillText('SLOP', W / 2, 80); g.restore();
    for (let k = 0; k < 7; k++) { const a = Math.PI * (1 + k / 6); const x = W / 2 + Math.cos(a) * 92, y = 96 + Math.sin(a) * 58; ellipse(g, x, y, 7, 7, 0, ['#e85a3a', '#f0c040', '#4ab0a0'][k % 3]); blob(g, x - 2, y - 2, 3, 3, 0, '#fff', 0.8, 0.4); }
    // reels window
    const ry = 150, rh = 140;
    g.fillStyle = grad(g, 0, ry - 10, 0, ry + rh + 10, [[0, '#f0d080'], [1, '#6a4a1e']]); g.beginPath(); g.roundRect(22, ry - 10, W - 44, rh + 20, 10); g.fill();
    const syms = [
      (x, y) => { ellipse(g, x - 9, y + 6, 11, 11, 0, '#b8302a'); ellipse(g, x + 9, y + 8, 11, 11, 0, '#a82a24'); blob(g, x - 12, y + 2, 4, 4, 0, '#fff', 0.7, 0.4); line(g, [[x - 8, y - 3], [x + 2, y - 20], [x + 9, y - 2]], 2.5, '#4a6a2a'); },
      (x, y) => { ellipse(g, x, y, 22, 22, 0, '#8a6424'); ellipse(g, x, y, 18, 18, 0, '#e0b048'); g.save(); g.fillStyle = '#8a6424'; g.font = 'bold 26px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', x, y + 1); g.restore(); },
      (x, y) => { ellipse(g, x, y - 3, 17, 15, 0, '#e8dcc0'); g.fillStyle = '#d8ccb0'; g.fillRect(x - 10, y + 6, 20, 10); ellipse(g, x - 6, y - 2, 5, 5, 0, '#2a2030'); ellipse(g, x + 6, y - 2, 5, 5, 0, '#2a2030'); },
      (x, y) => { g.save(); g.fillStyle = '#c03a2a'; g.font = 'bold 44px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('7', x, y + 2); g.restore(); },
    ];
    for (let k = 0; k < 3; k++) {
      const x = 32 + k * ((W - 64) / 3), w = (W - 64) / 3 - 4;
      g.fillStyle = grad(g, 0, ry, 0, ry + rh, [[0, '#6a6460'], [0.2, '#e8e0cc'], [0.5, '#fff8e8'], [0.8, '#e8e0cc'], [1, '#6a6460']]);
      g.fillRect(x, ry, w, rh);
      syms[(k * 3 + Math.floor(rnd() * 4)) % 4](x + w / 2, ry + rh / 2);
      syms[(k + 1) % 4](x + w / 2, ry + 12);
      g.fillStyle = grad(g, 0, ry, 0, ry + rh, [[0, '#1a1018', 0.75], [0.22, '#1a1018', 0], [0.78, '#1a1018', 0], [1, '#1a1018', 0.75]]); g.fillRect(x, ry, w, rh);
    }
    line(g, [[26, ry + rh / 2], [W - 26, ry + rh / 2]], 2, '#d83a2a', 0.8);
    blob(g, 70, ry + 20, 40, 12, -0.3, '#ffffff', 0.25, 0.3);
    // coin slot plate and tray
    g.fillStyle = grad(g, 0, 330, 0, 380, [[0, '#d8b060'], [1, '#6a4a1e']]); g.beginPath(); g.roundRect(W / 2 - 40, 330, 80, 46, 8); g.fill();
    g.fillStyle = '#1a1018'; g.fillRect(W / 2 - 4, 340, 8, 26);
    g.fillStyle = grad(g, 0, 420, 0, 480, [[0, '#2a1018'], [1, '#6a4a2a']]); g.beginPath(); g.roundRect(36, 420, W - 72, 56, 14); g.fill();
    for (let k = 0; k < 7; k++) ellipse(g, 60 + rnd() * (W - 120), 455 + rnd() * 12, 10, 4, 0, '#e0b048');
    for (const [x, y] of [[24, 24], [W - 24, 24], [24, H - 24], [W - 24, H - 24], [24, H / 2 + 60], [W - 24, H / 2 + 60]]) rivet(g, x, y, 5, '#c8a050');
    wear(g, W, H, rnd);
    glaze(g, W, H, '#ffe0b0', 0.1, 'soft-light');
  },
});

register('flip_face', {
  family: F, size: 512, note: 'double-or-nothing contraption: riveted red plate, brass gear, gauges, painted plaque',
  paint(g, s, rnd, h, cv) {
    plates(g, s, rnd, { colors: ['#8a3a2a', '#9a4430', '#7e3426'], rows: 3, minW: 140, maxW: 260, rivetCol: '#c8a050', scratches: 30 });
    const cx = s / 2, cy = s * 0.4;
    // gear
    g.save(); g.translate(cx + 6, cy + 8); g.fillStyle = rgba(INK, 0.45);
    for (let k = 0; k < 12; k++) { g.rotate(TAU / 12); g.fillRect(-14, -130, 28, 30); }
    g.beginPath(); g.arc(0, 0, 112, 0, TAU); g.fill(); g.restore();
    g.save(); g.translate(cx, cy);
    for (let k = 0; k < 12; k++) { g.rotate(TAU / 12); g.fillStyle = grad(g, -14, 0, 14, 0, [[0, '#f0d080'], [1, '#8a6424']]); g.fillRect(-14, -130, 28, 30); }
    g.restore();
    const rg = g.createRadialGradient(cx - 40, cy - 40, 10, cx, cy, 116); rg.addColorStop(0, '#f8e098'); rg.addColorStop(0.6, '#c09040'); rg.addColorStop(1, '#6a4a1e');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, 108, 0, TAU); g.fill();
    g.fillStyle = '#3a1a1a'; g.beginPath(); g.arc(cx, cy, 70, 0, TAU); g.fill();
    g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold 34px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`;
    g.fillStyle = '#1a0a0a'; g.fillText('x2', cx + 2, cy + 3); g.fillStyle = '#f0c860'; g.fillText('x2', cx, cy); g.restore();
    for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; rivet(g, cx + Math.cos(a) * 90, cy + Math.sin(a) * 90, 6, '#d8b060'); }
    // gauges
    for (const gx of [80, s - 80]) {
      ellipse(g, gx + 3, s * 0.3 + 4, 40, 40, 0, INK, 0.4); ellipse(g, gx, s * 0.3, 40, 40, 0, '#c8a050'); ellipse(g, gx, s * 0.3, 32, 32, 0, '#f0e8d0');
      for (let k = 0; k < 9; k++) { const a = Math.PI * (0.8 + k / 8 * 1.4); line(g, [[gx + Math.cos(a) * 24, s * 0.3 + Math.sin(a) * 24], [gx + Math.cos(a) * 30, s * 0.3 + Math.sin(a) * 30]], 2, '#2a2030'); }
      const a = Math.PI * range(rnd, 1.1, 1.9); line(g, [[gx, s * 0.3], [gx + Math.cos(a) * 26, s * 0.3 + Math.sin(a) * 26]], 3, '#a8302a'); ellipse(g, gx, s * 0.3, 4, 4, 0, '#2a2030');
    }
    // plaque
    const py = s * 0.74;
    g.fillStyle = grad(g, 0, py - 50, 0, py + 50, [[0, '#f0d080'], [0.5, '#b88a3c'], [1, '#5a3e1a']]); g.beginPath(); g.roundRect(40, py - 52, s - 80, 104, 12); g.fill();
    g.fillStyle = '#3a1a1a'; g.beginPath(); g.roundRect(52, py - 40, s - 104, 80, 8); g.fill();
    g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold 40px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`;
    g.fillStyle = '#100808'; g.fillText('DOUBLE', s / 2 + 2, py - 14 + 3); g.fillStyle = '#f0c860'; g.fillText('DOUBLE', s / 2, py - 14);
    g.font = `bold 24px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`; g.fillStyle = '#e0b858'; g.fillText('OR NOTHING', s / 2, py + 22); g.restore();
    for (const x of [58, s - 58]) rivet(g, x, py, 6, '#d8b060');
    wear(g, s, s, rnd, { scratches: 40 });
    glaze(g, s, s, '#ffe0b0', 0.1, 'soft-light');
  },
});

register('coin_face', {
  family: F, size: 128, note: 'the big gold coin: a beaded rim, a laurel ring, a struck $ in relief, worn high spots, grime in the recesses',
  paint(g, s, rnd) {
    const c = s / 2;
    const rg = g.createRadialGradient(c - 20, c - 22, 4, c, c, c); rg.addColorStop(0, '#f0d488'); rg.addColorStop(0.5, '#c89838'); rg.addColorStop(1, '#7a5418');
    g.fillStyle = rg; g.fillRect(0, 0, s, s);
    g.save(); g.lineWidth = 7; g.strokeStyle = '#a8782c'; g.beginPath(); g.arc(c, c, c - 6, 0, TAU); g.stroke();
    g.lineWidth = 2; g.strokeStyle = '#ffe8a0'; g.beginPath(); g.arc(c - 0.8, c - 0.8, c - 8, Math.PI * 0.9, Math.PI * 1.7); g.stroke();
    g.strokeStyle = '#5a3c10'; g.beginPath(); g.arc(c + 0.8, c + 0.8, c - 11, -0.2, Math.PI * 0.75); g.stroke(); g.restore();
    for (let k = 0; k < 32; k++) { const a = k / 32 * TAU; ellipse(g, c + Math.cos(a) * (c - 15), c + Math.sin(a) * (c - 15), 1.6, 1.6, 0, '#7a5418', 0.6); ellipse(g, c + Math.cos(a) * (c - 15) - 0.6, c + Math.sin(a) * (c - 15) - 0.6, 1.1, 1.1, 0, '#fff0b0', 0.7); }
    // a laurel ring: little leaves either side, struck (shadow down-right, light up-left)
    for (let k = 0; k < 22; k++) {
      if (k === 0 || k === 11) continue;
      const a = Math.PI / 2 + k / 22 * TAU, x = c + Math.cos(a) * (c - 26), y = c + Math.sin(a) * (c - 26), rot = a + Math.PI / 2 + 0.5;
      ellipse(g, x + 1, y + 1.2, 4.2, 1.9, rot, '#5a3c10', 0.7); ellipse(g, x - 0.4, y - 0.4, 4.2, 1.9, rot, '#fff0b0', 0.7); ellipse(g, x, y, 4, 1.7, rot, '#c8962c');
    }
    // the $ struck in relief
    g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold 56px ${SIGN_FONT}`;
    g.fillStyle = '#5a3c10'; g.fillText('$', c + 2.5, c + 4); g.fillStyle = '#fff0b0'; g.fillText('$', c - 1.2, c + 0.2); g.fillStyle = '#c8962c'; g.fillText('$', c, c + 1.5); g.restore();
    blob(g, c - 10, c - 10, 14, 9, -0.6, '#fff4c8', 0.3, 0.2);
    for (let i = 0; i < 16; i++) { const x = rnd() * s, y = rnd() * s, a = rnd() * 3; line(g, [[x, y], [x + Math.cos(a) * 8, y + Math.sin(a) * 8]], 0.8, rnd() < 0.5 ? '#fff4c0' : '#6a4818', 0.35); }
    for (let i = 0; i < 10; i++) blob(g, c + (rnd() - 0.5) * s * 0.6, c + (rnd() - 0.5) * s * 0.6, range(rnd, 3, 8), range(rnd, 2, 6), 0, '#5a4018', 0.18, 0.3);
    const vg = g.createRadialGradient(c - 18, c - 18, 8, c, c, c); vg.addColorStop(0, 'rgba(255,248,210,0.12)'); vg.addColorStop(0.65, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(60,36,10,0.45)');
    g.fillStyle = vg; g.fillRect(0, 0, s, s);
  },
});

function padRug(g, s, rnd, { field, border, text, fg }) {
  const c = s / 2;
  g.clearRect(0, 0, s, s);
  // a frayed fringe all round, then the border bands, the field, a worn middle
  for (let k = 0; k < 200; k++) { const a = k / 200 * TAU + rnd() * 0.02, r0 = c - 14, r1 = c - range(rnd, 1, 5); line(g, [[c + Math.cos(a) * r0, c + Math.sin(a) * r0], [c + Math.cos(a) * r1 + (rnd() - 0.5) * 2, c + Math.sin(a) * r1 + (rnd() - 0.5) * 2]], 1.6, rnd() < 0.7 ? '#d8c8a0' : '#b8a880', 0.95); }
  const ring = (r, col) => ellipse(g, c, c, r, r, 0, col);
  ring(c - 12, '#d8c090'); ring(c - 18, border); ring(c - 30, '#b89858'); ring(c - 35, field);
  for (let k = 0; k < 24; k++) { const a = k / 24 * TAU; ellipse(g, c + Math.cos(a) * (c - 24), c + Math.sin(a) * (c - 24), 3.6, 3.6, 0, '#d8c080'); }
  for (let i = 0; i < 30; i++) blob(g, c + (rnd() - 0.5) * s * 0.55, c + (rnd() - 0.5) * s * 0.55, range(rnd, 10, 30), range(rnd, 8, 20), 0, rnd() < 0.5 ? lightOf(field, 0.18) : shadowOf(field, 0.2), 0.25, 0.2);
  blob(g, c + 6, c + 10, s * 0.24, s * 0.18, 0.4, shadowOf(field, 0.35), 0.25, 0.1);   // trodden
  g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 66; g.font = `bold ${size}px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`;
  while (g.measureText(text).width > s * 0.62) { size -= 3; g.font = `bold ${size}px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`; }
  g.fillStyle = rgba(INK, 0.5); g.fillText(text, c + 2.5, c + 4.5);
  g.fillStyle = fg; g.fillText(text, c, c + 2); g.restore();
  // woven rows, a worn bald patch and the edge darkened with grime
  g.save(); g.globalCompositeOperation = 'source-atop';
  for (let y = 0; y < s; y += 3) line(g, [[0, y], [s, y]], 0.8, '#2a2030', 0.07);
  for (let i = 0; i < 18; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 6, 18), range(rnd, 4, 10), 0, '#c8b890', 0.16, 0.3);
  g.restore();
}
register('pad_hit', { family: F, size: 256, alpha: true, note: 'round woven rug: HIT, worn and fringed', paint(g, s, rnd) { padRug(g, s, rnd, { field: '#8a3428', border: '#3a2430', text: 'HIT', fg: '#f0dcb0' }); } });
register('pad_stand', { family: F, size: 256, alpha: true, note: 'round woven rug: STAND, faded blue, worn and fringed', paint(g, s, rnd) { padRug(g, s, rnd, { field: '#34507a', border: '#2a2438', text: 'STAND', fg: '#ecdcb4' }); } });

// A hanging cloth banner (alpha): soft vertical folds, an embroidered border with a darker outline
// and stitching, an emblem, wear and stains, and a frayed bottom (swallowtail or straight).
function bannerCloth(g, W, H, rnd, { field, field2, border, edge, emblem, tail = 'swallow' }) {
  g.clearRect(0, 0, W, H);
  const bot = [];
  const n = 14;
  for (let k = 0; k <= n; k++) {
    const t = k / n, x = 3 + (W - 6) * t;
    const y = tail === 'swallow' ? H * (0.985 - 0.16 * (1 - Math.abs(t - 0.5) * 2)) : H * (0.96 - 0.02 * Math.sin(t * 9));
    bot.push([x, y + (rnd() - 0.5) * 5]);
  }
  const pts = [[3, 0], [W - 3, 0], [W - 2 + (rnd() - 0.5) * 3, H * 0.5], ...bot.slice().reverse(), [2 + (rnd() - 0.5) * 3, H * 0.5]];
  clipped(g, () => polyPath(g, pts), () => {
    g.fillStyle = grad(g, 0, 0, W, 0, [[0, field2 || field], [0.5, field], [1, shadowOf(field, 0.2)]]); g.fillRect(0, 0, W, H);
    for (let i = 0; i < 18; i++) blob(g, rnd() * W, rnd() * H, range(rnd, 8, 26), range(rnd, 10, 40), 0, rnd() < 0.5 ? lightOf(field, 0.15) : shadowOf(field, 0.2), 0.3, 0.15);
    // the embroidered border: dark outline, the band, a stitched line inside it
    const bw = W * 0.085;
    const band = (inset, col, w) => { g.save(); g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(inset, -4); g.lineTo(inset, H); g.moveTo(W - inset, -4); g.lineTo(W - inset, H); g.moveTo(-4, inset + 6); g.lineTo(W + 4, inset + 6); g.stroke(); g.restore(); };
    band(bw * 0.9, edge, bw * 1.25); band(bw * 0.9, border, bw * 0.8);
    g.save(); g.setLineDash([3, 3]); band(bw * 0.9, lightOf(border, 0.4), 1.2); g.restore();
    line(g, bot.map(([x, y]) => [x, y - 6]), bw * 0.9, edge, 0.9); line(g, bot.map(([x, y]) => [x, y - 6]), bw * 0.5, border, 0.95);
    emblem(g, W / 2, H * 0.42);
    // wear: faded patches and a few stains
    for (let i = 0; i < 6; i++) blob(g, rnd() * W, rnd() * H, range(rnd, 6, 18), range(rnd, 5, 14), 0, '#2a1a14', 0.16, 0.3);
    for (let i = 0; i < 4; i++) blob(g, rnd() * W, rnd() * H, range(rnd, 10, 24), range(rnd, 10, 30), 0, '#f0e0c0', 0.1, 0.1);
    // folds over everything: soft dark valleys, lit ridges (light from the left)
    for (let k = 0; k < 4; k++) {
      const x = (k + 0.3 + rnd() * 0.4) * W / 4, w = range(rnd, 12, 20);
      g.fillStyle = grad(g, x - w, 0, x + w, 0, [[0, '#ffe8c8', 0], [0.35, '#ffe8c8', 0.16], [0.55, '#1a0a14', 0.05], [0.8, '#1a0a14', 0.3], [1, '#1a0a14', 0]]);
      g.fillRect(x - w, 0, w * 2, H);
    }
    g.fillStyle = grad(g, 0, 0, 0, H, [[0, '#1a0a14', 0.3], [0.08, '#1a0a14', 0], [0.85, '#1a0a14', 0], [1, '#1a0a14', 0.25]]); g.fillRect(0, 0, W, H);
  });
  // a frayed bottom: loose threads
  for (const [x, y] of bot) for (let k = 0; k < 3; k++) { const xx = x + range(rnd, -4, 4); line(g, [[xx, y - 3], [xx + range(rnd, -1.5, 1.5), y + range(rnd, 2, 7)]], 1.2, rnd() < 0.5 ? border : field, 0.85); }
  // the sleeve the rod goes through
  g.fillStyle = grad(g, 0, 0, 0, 12, [[0, shadowOf(field, 0.5)], [1, field]]); g.fillRect(3, 0, W - 6, 10);
  for (let x = 12; x < W - 8; x += 18) { ellipse(g, x, 5, 2.4, 2.4, 0, '#2a1a14', 0.8); }
}
const coinEmblem = (g, x, y) => {
  ellipse(g, x + 2, y + 3, 33, 33, 0, '#1a0a0e', 0.4);
  ellipse(g, x, y, 33, 33, 0, '#5a3c14'); ellipse(g, x, y, 30, 30, 0, '#c89a40');
  ellipse(g, x, y, 23, 23, 0, '#a8782c'); blob(g, x - 9, y - 10, 12, 9, -0.5, '#ffe8a0', 0.7, 0.3);
  g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold 38px ${SIGN_FONT}`; g.fillStyle = '#5a3c14'; g.fillText('$', x + 1, y + 3); g.fillStyle = '#f0cc68'; g.fillText('$', x, y + 1); g.restore();
  for (let k = 0; k < 16; k++) { const a = k / 16 * TAU; ellipse(g, x + Math.cos(a) * 31.5, y + Math.sin(a) * 31.5, 1.6, 1.6, 0, '#fff0b0', 0.7); }
};
register('banner_red', {
  family: F, w: 128, h: 256, alpha: true, note: 'Goldshire hall banner: red cloth in soft folds, embroidered gold border, a gold coin, frayed swallowtail',
  paint(g, s, rnd, H) { bannerCloth(g, 128, H, rnd, { field: '#8a2224', field2: '#9a2a28', border: '#c8a048', edge: '#4a1a10', emblem: coinEmblem }); },
});
register('banner_dwarf', {
  family: F, w: 128, h: 256, alpha: true, note: 'Kharanos banner: deep blue wool, a gold knotwork border, a silver hammer over an anvil, straight frayed hem',
  paint(g, s, rnd, H) {
    bannerCloth(g, 128, H, rnd, { field: '#2e3e6a', field2: '#36487a', border: '#c8a048', edge: '#1a1a30', tail: 'straight', emblem: (g, x, y) => {
      // anvil
      g.fillStyle = '#1a1a28'; g.globalAlpha = 0.4; g.fillRect(x - 28, y + 14, 60, 14); g.globalAlpha = 1;
      g.fillStyle = grad(g, 0, y + 6, 0, y + 30, [[0, '#d8dce4'], [1, '#6a7080']]);
      g.beginPath(); g.moveTo(x - 32, y + 8); g.lineTo(x + 26, y + 8); g.quadraticCurveTo(x + 36, y + 10, x + 34, y + 16); g.lineTo(x + 12, y + 18); g.lineTo(x + 10, y + 30); g.lineTo(x + 18, y + 36); g.lineTo(x - 18, y + 36); g.lineTo(x - 10, y + 30); g.lineTo(x - 12, y + 18); g.lineTo(x - 30, y + 14); g.closePath(); g.fill();
      // hammer, leaning over it
      g.save(); g.translate(x - 2, y - 8); g.rotate(-0.5);
      g.fillStyle = '#5a3a24'; g.fillRect(-3.5, -6, 7, 46);
      g.fillStyle = grad(g, -16, 0, 16, 0, [[0, '#e8ecf0'], [1, '#70788a']]); g.fillRect(-17, -22, 34, 18);
      g.fillStyle = '#c8a048'; g.fillRect(-17, -9, 34, 3);
      g.restore();
      // knot dots in the field
      for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; ellipse(g, x + Math.cos(a) * 44, y + 10 + Math.sin(a) * 52, 3, 3, 0, '#c8a048', 0.85); }
    } });
    // a knotwork chain on the border: little interlaced loops
    for (let yy = 22; yy < H * 0.9; yy += 14) for (const x of [11, 117]) { g.save(); g.strokeStyle = '#7a5a20'; g.lineWidth = 1.6; g.beginPath(); g.ellipse(x, yy, 3.5, 6, 0, 0, TAU); g.stroke(); g.restore(); }
  },
});
register('banner_goblin', {
  family: F, w: 128, h: 256, alpha: true, note: 'Gadgetzan cartel banner: faded teal cloth, brass-thread border, a brass gear round a gold coin, swallowtail',
  paint(g, s, rnd, H) {
    bannerCloth(g, 128, H, rnd, { field: '#2e6a64', field2: '#367a72', border: '#d0a040', edge: '#163430', emblem: (g, x, y) => {
      g.save(); g.translate(x + 2, y + 3); g.fillStyle = rgba('#0a1a18', 0.4); for (let k = 0; k < 10; k++) { g.rotate(TAU / 10); g.fillRect(-6, -44, 12, 12); } g.beginPath(); g.arc(0, 0, 36, 0, TAU); g.fill(); g.restore();
      g.save(); g.translate(x, y); for (let k = 0; k < 10; k++) { g.rotate(TAU / 10); g.fillStyle = grad(g, -6, 0, 6, 0, [[0, '#f0d080'], [1, '#8a6424']]); g.fillRect(-6, -44, 12, 12); } g.restore();
      const rg = g.createRadialGradient(x - 12, y - 12, 4, x, y, 36); rg.addColorStop(0, '#f8e098'); rg.addColorStop(0.6, '#c09040'); rg.addColorStop(1, '#6a4a1e');
      g.fillStyle = rg; g.beginPath(); g.arc(x, y, 34, 0, TAU); g.fill();
      ellipse(g, x, y, 24, 24, 0, '#1e4a44');
      g.save(); g.translate(x, y); g.scale(0.64, 0.64); coinEmblem(g, 0, 0); g.restore();
      for (let k = 0; k < 8; k++) { const a = k / 8 * TAU + 0.2; rivet(g, x + Math.cos(a) * 29, y + Math.sin(a) * 29, 2.4, '#e0b860'); }
    } });
  },
});

register('repo_plate', {
  family: F, w: 256, h: 128, note: 'the tow wagon\'s side plate: REPO stenciled in ochre on riveted green steel',
  paint(g, s, rnd, H, cv) {
    const W = 256;
    g.fillStyle = '#4e6838'; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 20; i++) blob(g, rnd() * W, rnd() * H, range(rnd, 10, 30), range(rnd, 8, 20), 0, pick(rnd, ['#5e7a44', '#425a30']), 0.4, 0.15);
    g.fillStyle = grad(g, 0, 0, 0, H, [[0, '#e8cc78'], [0.1, '#b88a3c'], [0.15, '#6a4a1e', 0], [0.85, '#6a4a1e', 0], [0.9, '#b88a3c'], [1, '#5a3e1a']]); g.fillRect(0, 0, W, H);
    g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold 78px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`;
    g.fillStyle = rgba(INK, 0.6); g.fillText('REPO', W / 2 + 3, H / 2 + 6);
    g.fillStyle = '#e8b848'; g.fillText('REPO', W / 2, H / 2 + 3); g.restore();
    for (let i = 0; i < 26; i++) ellipse(g, rnd() * W, rnd() * H, range(rnd, 1.5, 4), range(rnd, 1, 3), 0, '#3a4430', 0.8);
    for (const x of [14, W - 14]) for (const y of [24, H - 24]) rivet(g, x, y, 4, '#c8a050');
    streaks(g, W, rnd, { colors: ['#7a4026'], count: 6, len: [10, 30], width: [1.5, 3], angle: Math.PI, alpha: 0.35 });
  },
});

register('barrel', {
  family: F, size: 256, note: 'barrel side: staves around u, two pairs of iron hoops',
  paint(g, s, rnd, h, cv) {
    const n = 10, W = s / n;
    fill(g, s, s, '#1e1418');
    for (let i = 0; i < n; i++) plank(g, i * W + 1, 0, W - 2, s, jitter(pick(rnd, ['#7a5232', '#86603a', '#6e4a2e']), rnd, 0.06), rnd, { vertical: true, grain: 6, bevel: 2, knots: 0.2, light: 0.2 });
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, INK, 0.4], [0.2, INK, 0], [0.8, INK, 0], [1, INK, 0.4]]); g.fillRect(0, 0, s, s);
    for (const y of [s * 0.1, s * 0.2, s * 0.8, s * 0.9]) {
      g.fillStyle = grad(g, 0, y - 7, 0, y + 7, [[0, '#7a7882'], [0.4, '#4a4850'], [1, '#26242c']]); g.fillRect(0, y - 7, s, 14);
      for (let k = 0; k < n; k++) rivet(g, (k + 0.5) * W, y, 2.2, '#6a6870');
    }
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
  },
});

register('crate', {
  family: F, size: 256, note: 'crate face: framed planks with grain, a diagonal brace, nicks and dents, nails, grime in the corners',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#1e1418');
    for (let i = 0; i < 4; i++) plank(g, 0, i * s / 4 + 1.5, s, s / 4 - 3, jitter(pick(rnd, ['#9a7448', '#8a663e', '#a47e50', '#7e5c38']), rnd, 0.07), rnd, { grain: 12, galpha: 0.45, knots: 0.5, splits: 0.5, bevel: 3, weather: 0.35 });
    g.save(); g.translate(s / 2, s / 2); g.rotate(-Math.PI / 4);
    g.fillStyle = rgba(INK, 0.45); g.fillRect(-s * 0.7, -12, s * 1.4, 34); g.restore();
    g.save(); g.translate(s / 2, s / 2); g.rotate(-Math.PI / 4); plank(g, -s * 0.7, -18, s * 1.4, 32, '#a8845a', rnd, { grain: 9, galpha: 0.45, bevel: 3, splits: 0.6, knots: 0.4 }); g.restore();
    const fr = 26;
    for (const [x, y, w, hh, v] of [[0, 0, s, fr, false], [0, s - fr, s, fr, false], [0, 0, fr, s, true], [s - fr, 0, fr, s, true]]) plank(g, x, y, w, hh, jitter('#a8845a', rnd, 0.06), rnd, { vertical: v, grain: 7, galpha: 0.45, bevel: 3, splits: 0.4 });
    // nicks and dents: a dark gouge with a lit lower lip
    for (let i = 0; i < 16; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 4, 14), a = rnd() * Math.PI;
      line(g, [[x, y], [x + Math.cos(a) * L, y + Math.sin(a) * L]], range(rnd, 1.5, 3), '#3a2418', 0.6);
      line(g, [[x + 1, y + 1.5], [x + 1 + Math.cos(a) * L, y + 1.5 + Math.sin(a) * L]], 1, '#e8c890', 0.35);
    }
    for (const [x, y] of [[13, 13], [s - 13, 13], [13, s - 13], [s - 13, s - 13], [s / 2, 13], [s / 2, s - 13]]) nailHead(g, x, y, 3);
    // grime toward the edges and in the corners
    const vg = g.createRadialGradient(s * 0.42, s * 0.4, s * 0.2, s / 2, s / 2, s * 0.72);
    vg.addColorStop(0, rgba('#ffe8c0', 0.08)); vg.addColorStop(0.6, rgba(INK, 0)); vg.addColorStop(1, rgba(INK, 0.45));
    g.fillStyle = vg; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 6; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 10, 30), range(rnd, 8, 20), 0, '#3a2818', 0.14, 0.2);
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
  },
});

register('flowerbox', {
  family: F, size: 256, alpha: true, note: 'window-box flowers: leafy clumps with red and gold blooms (alpha card, base at the bottom)',
  paint(g, s, rnd) {
    for (let i = 0; i < 120; i++) {
      const x = range(rnd, 10, s - 10), y = s - range(rnd, 0, 40), L = range(rnd, 30, 110), a = range(rnd, -0.6, 0.6);
      const c = pick(rnd, ['#3e6a28', '#4a7a2e', '#365e24', '#5a8a34']);
      const pts = []; for (let k = 0; k <= 4; k++) { const t = k / 4; pts.push([x + Math.sin(a) * L * t, y - Math.cos(a) * L * t]); }
      line(g, pts, 2.2, '#2e4a1e', 0.9);
      ellipse(g, pts[4][0], pts[4][1], range(rnd, 8, 14), range(rnd, 5, 8), a + 0.6, c);
      blob(g, pts[4][0] - 2, pts[4][1] - 2, 5, 3, a, '#9ac860', 0.6, 0.4);
    }
    for (let i = 0; i < 34; i++) {
      const x = range(rnd, 16, s - 16), y = range(rnd, s * 0.2, s * 0.7), r = range(rnd, 7, 13), c = pick(rnd, ['#c83a2e', '#d84a34', '#e8b040', '#b83060', '#e8d8c0']);
      for (let k = 0; k < 5; k++) { const a = k / 5 * TAU; ellipse(g, x + Math.cos(a) * r * 0.6, y + Math.sin(a) * r * 0.6, r * 0.55, r * 0.4, a, k < 2 ? lightOf(c, 0.3) : c); }
      ellipse(g, x, y, r * 0.3, r * 0.3, 0, '#f0d060');
    }
  },
});

register('embers', {
  family: F, size: 128, note: 'brazier coals: round lumps of three sizes, ash-grey tops, a soft orange glow showing in only a few gaps (emissive; tiles)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#24160f');
    // the glow under the coals, only in a few soft pools
    for (let i = 0; i < 7; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 8, 18); wrap(s, x, y, r * 1.5, (X, Y) => { blob(g, X, Y, r, r * 0.8, 0, '#e8641c', 0.85, 0.2); blob(g, X, Y, r * 0.5, r * 0.4, 0, '#ffc060', 0.8, 0.3); }); }
    // lumps: big ones first, then the gaps filled with smaller ones
    const lumps = [];
    for (const r of [16, 11, 7]) for (let t = 0; t < 400; t++) {
      const x = rnd() * s, y = rnd() * s, rr = r * range(rnd, 0.85, 1.15);
      const near = q => { let dx = Math.abs(x - q.x), dy = Math.abs(y - q.y); dx = Math.min(dx, s - dx); dy = Math.min(dy, s - dy); return Math.hypot(dx, dy) < (q.r + rr) * 0.82; };
      if (!lumps.some(near)) lumps.push({ x, y, r: rr, ash: rnd() < 0.55, hot: rnd() < 0.18 });
    }
    for (const L of lumps) {
      const n = 9, pts = [], ph = rnd() * TAU, c = pick(rnd, ['#2e2018', '#3a281e', '#261a14', '#34261c']);
      for (let k = 0; k < n; k++) { const t = k / n * TAU; pts.push([Math.cos(t) * L.r * (0.8 + 0.25 * Math.sin(t * 3 + ph)), Math.sin(t) * L.r * 0.85 * (0.8 + 0.25 * Math.cos(t * 2 + ph))]); }
      wrap(s, L.x, L.y, L.r * 1.4, (X, Y) => {
        const P = pts.map(([u, v]) => [X + u, Y + v]);
        g.save(); g.translate(L.r * 0.22, L.r * 0.3); polyPath(g, P); g.fillStyle = rgba('#0e0806', 0.6); g.fill(); g.restore();
        clipped(g, () => polyPath(g, P), () => {
          g.fillStyle = grad(g, X - L.r, Y - L.r, X + L.r * 0.6, Y + L.r, [[0, L.ash ? '#6a625c' : '#4a3a30'], [0.45, c], [1, '#140c08']]);
          g.fillRect(X - L.r * 1.3, Y - L.r * 1.3, L.r * 2.6, L.r * 2.6);
          if (L.ash) blob(g, X - L.r * 0.25, Y - L.r * 0.35, L.r * 0.65, L.r * 0.4, -0.3, '#a8a098', 0.5, 0.25);
          if (L.hot) blob(g, X + L.r * 0.1, Y + L.r * 0.65, L.r * 0.7, L.r * 0.28, 0, '#e8641c', 0.55, 0.2);
          line(g, [[X - L.r * 0.4, Y - L.r * 0.1], [X + L.r * 0.1, Y + L.r * 0.05], [X + L.r * 0.4, Y + L.r * 0.3]], 1, '#0e0806', 0.5);
        });
      });
    }
    blurTile(cv, 0.6);
  },
});

register('glow_soft', {
  family: F, size: 64, alpha: true, note: 'a soft round glow for lamp halos (additive points)',
  paint(g, s) {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,244,214,1)'); gr.addColorStop(0.18, 'rgba(255,220,150,0.75)'); gr.addColorStop(0.5, 'rgba(255,180,90,0.22)'); gr.addColorStop(1, 'rgba(255,160,80,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  },
});

// ---- frontier, desert, farm pieces ---------------------------------------------------------------

register('board_rough', {
  family: F, size: 256, note: 'a single rough frontier board: orange-brown, sun-grayed, grain along v (false fronts)',
  paint(g, s, rnd, h, cv) {
    grainTile(g, s, rnd, { base: '#8a5a36', dark: ['#5a3a22', '#4e3220', '#3a2418'], lite: ['#c09a6a', '#b08a5c'], lines: 40, splits: 6, knots: 3, alpha: 0.45 });
    mottle(g, s, rnd, { colors: ['#a49c8c', '#9a9284', '#b0a08a'], count: 18, rmin: 10, rmax: 40, alpha: 0.22, hard: 0.15, stretch: 3, rot: Math.PI / 2 });
    glaze(g, s, s, '#ffd8a0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('arch_bone', {
  family: F, size: 128, note: 'ivory bone and tusk: cream with soft growth rings (they wrap) and a dirty base',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e8dcc0');
    const n = 11;
    for (let i = 0; i < n; i++) {
      const y0 = (i + range(rnd, -0.25, 0.25)) * s / n, a = range(rnd, 0.5, 2), ph = rnd() * TAU;
      const pts = []; for (let x = -4; x <= s + 4; x += 4) pts.push([x, y0 + a * Math.sin(TAU * x / s + ph)]);
      for (const dy of [-s, 0, s]) line(g, pts.map(([x, y]) => [x, y + dy]), range(rnd, 1, 3), '#c8b898', 0.35);
    }
    mottle(g, s, rnd, { colors: ['#f6eedc', '#d0c0a0', '#bca888'], count: 18, rmin: 6, rmax: 24, alpha: 0.35, hard: 0.15 });
    blurTile(cv, 0.6);
  },
});

register('clay', {
  family: F, size: 128, note: 'glazed pottery and painted goods: a light neutral glaze with throwing rings and drips (tinted per item with vertex colours)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#d8d0c2');
    mottle(g, s, rnd, { colors: ['#e8e2d6', '#c4baa8', '#d0c6b4'], count: 20, rmin: 10, rmax: 36, alpha: 0.4, hard: 0.1 });
    for (let y = 4; y < s; y += range(rnd, 7, 13)) { const pts = []; for (let x = -4; x <= s + 4; x += 8) pts.push([x, y + Math.sin(TAU * x / s + y) * 1.2]); line(g, pts, range(rnd, 1, 2), rnd() < 0.5 ? '#b0a690' : '#f0ebe0', 0.3); }
    for (let i = 0; i < 6; i++) { const x = rnd() * s, y = rnd() * s * 0.5, L = range(rnd, 10, 40), dx = (rnd() - 0.5) * 2, lw = range(rnd, 2, 4); wrap(s, x, y + L / 2, L, (X, Y) => line(g, [[X, Y - L / 2], [X + dx, Y + L / 2]], lw, '#a89c86', 0.3)); }
    blurTile(cv, 0.8);
  },
});

register('endgrain', {
  family: F, size: 128, note: 'sawn log end: growth rings from a pale centre to a dark rim, radial checks, lit upper left (for vigas, log ends, firewood)',
  paint(g, s, rnd) {
    const c = s / 2;
    const rg = g.createRadialGradient(c - 6, c - 6, 2, c, c, c);
    rg.addColorStop(0, '#d8a870'); rg.addColorStop(0.55, '#c49460'); rg.addColorStop(0.88, '#9a6a40'); rg.addColorStop(1, '#6a4428');
    g.fillStyle = rg; g.fillRect(0, 0, s, s);
    for (let r = 5; r < c; r += range(rnd, 3.5, 7)) { g.save(); g.strokeStyle = rgba('#7a5232', 0.4); g.lineWidth = range(rnd, 0.8, 1.8); g.beginPath(); g.ellipse(c + (rnd() - 0.5) * 2, c + (rnd() - 0.5) * 2, r, r * range(rnd, 0.94, 1.04), 0, 0, TAU); g.stroke(); g.restore(); }
    for (let k = 0; k < 4; k++) { const a = rnd() * TAU, r0 = range(rnd, 4, 14), r1 = range(rnd, 24, c * 0.95); line(g, [[c + Math.cos(a) * r0, c + Math.sin(a) * r0], [c + Math.cos(a) * r1, c + Math.sin(a) * r1]], range(rnd, 1.2, 2.4), '#3a2416', 0.7); }
    g.save(); g.strokeStyle = '#4a2e1c'; g.lineWidth = 6; g.beginPath(); g.arc(c, c, c - 3, 0, TAU); g.stroke(); g.restore();
    blob(g, c - c * 0.35, c - c * 0.4, c * 0.4, c * 0.3, -0.6, '#fff0c8', 0.22, 0.2);
  },
});

register('straw_fringe', {
  family: F, w: 256, h: 64, alpha: true, note: 'the ragged straw fringe hanging under a thatch eave (alpha card, tiles along u)',
  paint(g, s, rnd, H) {
    const W = 256;
    g.clearRect(0, 0, W, H);
    for (let k = 0; k < 420; k++) {
      const x = rnd() * W, L = H * range(rnd, 0.35, 1) * (0.7 + 0.3 * Math.sin(x / W * TAU * 3 + 1)), a = range(rnd, -0.15, 0.15);
      const col = pick(rnd, ['#a08040', '#b09048', '#8a6e38', '#c4a45c', '#6e5630']);
      for (const dx of [0, -W, W]) line(g, [[x + dx, 0], [x + dx + Math.sin(a) * L, Math.cos(a) * L]], range(rnd, 1.2, 2.6), col, 1);
    }
    g.fillStyle = grad(g, 0, 0, 0, H, [[0, '#2a1e10', 0.55], [0.5, '#2a1e10', 0.1], [1, '#2a1e10', 0]]);
    g.globalCompositeOperation = 'source-atop'; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'source-over';
  },
});

register('arch_rag', {
  family: F, size: 128, alpha: true, note: 'a red rag tied to the rim-code stake: faded red cloth, folds, frayed ragged edges (alpha)',
  paint(g, s, rnd) {
    g.clearRect(0, 0, s, s);
    // a ragged strip: the outline nibbled along both long edges, the ends torn
    const pts = [];
    for (let k = 0; k <= 12; k++) pts.push([s * 0.12 + range(rnd, -4, 6), k / 12 * s]);
    for (let k = 12; k >= 0; k--) pts.push([s * 0.88 + range(rnd, -6, 4), k / 12 * s]);
    clipped(g, () => polyPath(g, pts), () => {
      fill(g, s, s, '#9a2a1e');
      for (let k = 0; k < 7; k++) { const y = rnd() * s; g.fillStyle = grad(g, 0, y - 10, 0, y + 10, [[0, '#7a1e16', 0], [0.5, '#6a1a14', 0.5], [1, '#7a1e16', 0]]); g.fillRect(0, y - 10, s, 20); }
      for (let k = 0; k < 6; k++) { const y = rnd() * s; line(g, [[0, y], [s, y + range(rnd, -6, 6)]], range(rnd, 2, 4), '#c8503a', 0.35); }
      for (let x = 0; x < s; x += 3) line(g, [[x, 0], [x, s]], 1, rnd() < 0.5 ? '#b03828' : '#7a2018', 0.25);
      g.fillStyle = grad(g, 0, 0, s, 0, [[0, '#3a1010', 0.35], [0.3, '#3a1010', 0], [0.75, '#ffd0a0', 0], [1, '#3a1010', 0.3]]); g.fillRect(0, 0, s, s);
    });
    for (let k = 0; k < 18; k++) { const sx = rnd() < 0.5 ? s * 0.12 : s * 0.88, y = rnd() * s; line(g, [[sx, y], [sx + range(rnd, -8, 8), y + range(rnd, 2, 9)]], 1.2, '#8a2418', 0.8); }
  },
});
register('rope', {
  family: F, size: 128, note: 'twisted hemp rope: diagonal strands, lit and shaded (tiles)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7a6440');
    const P = 16;
    for (let k = -2 * s; k < 2 * s; k += P) for (const dx of [0]) {
      const a = [k + dx, -s], b = [k + dx + s * 1.5, 2 * s];
      line(g, [a, b], P * 0.95, '#b49c68', 1, 'butt');
      line(g, [[a[0] - P * 0.22, a[1]], [b[0] - P * 0.22, b[1]]], P * 0.3, '#d8c08a', 0.8, 'butt');
      line(g, [[a[0] + P * 0.36, a[1]], [b[0] + P * 0.36, b[1]]], P * 0.2, '#5a4428', 0.7, 'butt');
    }
    for (let i = 0; i < 60; i++) { const x = rnd() * s, y = rnd() * s; line(g, [[x, y], [x + 5, y + 9]], 0.8, rnd() < 0.5 ? '#e8d8a8' : '#5a4428', 0.4); }
    blurTile(cv, 0.4);
  },
});

register('burlap', {
  family: F, size: 128, note: 'sack cloth: coarse beige weave, a few stains (tiles)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#b8a078');
    for (let y = 0; y < s; y += 4) line(g, [[0, y], [s, y]], 2, rnd() < 0.5 ? '#c8b088' : '#a08a62', 0.6);
    for (let x = 0; x < s; x += 4) line(g, [[x, 0], [x, s]], 1.6, rnd() < 0.5 ? '#c4ac84' : '#9a845c', 0.45);
    mottle(g, s, rnd, { colors: ['#8a7450', '#d0bc94'], count: 12, rmin: 8, rmax: 26, alpha: 0.25, hard: 0.1 });
    blurTile(cv, 0.5);
  },
});

register('latillas', {
  family: F, size: 256, note: 'adobe ceiling: thin peeled sticks laid side by side across the vigas (along u); each row breaks at its own place',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#3a2a1e');
    let y = 0;
    const hs = []; let tot = 0;
    while (tot < s - 10) { const hh = range(rnd, 9, 15); hs.push(hh); tot += hh; }
    const k = s / tot;
    for (const h0 of hs) {
      const hh = h0 * k, c = jitter(pick(rnd, ['#b89470', '#a8845e', '#c4a07a', '#9a7856']), rnd, 0.06);
      g.fillStyle = grad(g, 0, y, 0, y + hh, [[0, lightOf(c, 0.35)], [0.4, c], [1, shadowOf(c, 0.5)]]);
      g.fillRect(0, y + 0.8, s, hh - 1.6);
      // where one stick ends and the next begins: a dark gap between two rounded ends (wraps)
      const bx = rnd() * s, gap = range(rnd, 2, 5);
      wrap(s, bx, y + hh / 2, hh + gap, (X) => {
        g.fillStyle = '#3a2a1e'; g.fillRect(X - gap / 2, y, gap, hh);
        for (const sd of [-1, 1]) { g.fillStyle = grad(g, X + sd * gap / 2, 0, X + sd * (gap / 2 + hh * 0.6), 0, [[0, '#3a2a1e', 0.85], [1, '#3a2a1e', 0]]); g.fillRect(Math.min(X + sd * gap / 2, X + sd * (gap / 2 + hh * 0.6)), y + 0.8, hh * 0.6, hh - 1.6); }
      });
      for (let j = 0; j < 3; j++) { const x = rnd() * s, bw = range(rnd, 10, 40); wrap(s, x, y + hh / 2, 40, (X, Y) => blob(g, X, Y, bw, hh * 0.25, 0, '#6a4a30', 0.3, 0.3)); }
      y += hh;
    }
    glaze(g, s, s, '#ffd8a8', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('banner_hide', {
  family: F, w: 128, h: 256, alpha: true, note: 'a rust-red hide banner with painted tribal marks and a ragged bottom (alpha)',
  paint(g, s, rnd, H) {
    const W = 128;
    const pts = [[4, 0], [W - 4, 0], [W - 8 + (rnd() - 0.5) * 6, H * 0.5], [W - 2, H * 0.78]];
    for (let k = 0; k <= 6; k++) pts.push([W - 4 - k * (W - 8) / 6, H * (0.86 + (k % 2 ? 0.1 : 0) + (rnd() - 0.5) * 0.06)]);
    pts.push([2, H * 0.78], [8 + (rnd() - 0.5) * 6, H * 0.5]);
    clipped(g, () => polyPath(g, pts), () => {
      g.fillStyle = grad(g, 0, 0, W, 0, [[0, '#a8502e'], [0.5, '#8e3e22'], [1, '#6a2c18']]); g.fillRect(0, 0, W, H);
      mottle(g, W, rnd, { colors: ['#b45a34', '#6a2a16', '#9a4426'], count: 26, rmin: 8, rmax: 30, alpha: 0.35, hard: 0.15 });
      g.save(); g.lineCap = 'round'; g.strokeStyle = '#e8d4a8'; g.lineWidth = 6; g.globalAlpha = 0.85;
      g.beginPath(); g.moveTo(W * 0.25, H * 0.2); g.lineTo(W * 0.5, H * 0.32); g.lineTo(W * 0.75, H * 0.2); g.stroke();
      g.beginPath(); g.arc(W / 2, H * 0.48, 18, 0, TAU); g.stroke();
      g.beginPath(); g.moveTo(W * 0.5, H * 0.56); g.lineTo(W * 0.5, H * 0.72); g.stroke();
      for (const sx of [-1, 1]) { g.beginPath(); g.moveTo(W / 2 + sx * 30, H * 0.6); g.lineTo(W / 2 + sx * 40, H * 0.7); g.stroke(); }
      g.fillStyle = '#2a1a14'; g.beginPath(); g.arc(W / 2, H * 0.48, 7, 0, TAU); g.fill();
      g.restore();
      for (let k = 0; k < 6; k++) blob(g, rnd() * W, rnd() * H, range(rnd, 6, 16), range(rnd, 4, 10), 0, '#3a1a10', 0.25, 0.3);
    });
    g.save(); g.lineWidth = 3; g.strokeStyle = rgba('#3a1a10', 0.7); polyPath(g, pts); g.stroke(); g.restore();
    for (let x = 10; x < W - 6; x += 16) { ellipse(g, x, 7, 3, 3, 0, '#2a1a14'); line(g, [[x, 7], [x + 2, -2]], 2, '#c8b088', 0.9); }
  },
});

// a rug shape on a transparent ground; shape(g) paints it
function rugCanvas(g, s, rnd, shape) { g.clearRect(0, 0, s, s); shape(); }
register('rug_bear', {
  family: F, size: 256, alpha: true, note: 'a bear-skin rug seen from above: brown fur, four paws, a head (alpha)',
  paint(g, s, rnd) {
    rugCanvas(g, s, rnd, () => {
      const c = s / 2, fur = ['#5a3a24', '#6a4630', '#4a2e1c', '#7a5438'];
      const body = () => { g.beginPath(); g.ellipse(c, c + 8, s * 0.26, s * 0.34, 0, 0, TAU); };
      for (const [x, y, a] of [[-1, -1, -0.7], [1, -1, 0.7], [-1, 1, 0.6], [1, 1, -0.6]]) {
        g.save(); g.translate(c + x * s * 0.22, c + 8 + y * s * 0.2); g.rotate(a);
        g.fillStyle = '#4a2e1c'; g.beginPath(); g.ellipse(x * s * 0.1, 0, s * 0.14, s * 0.06, 0, 0, TAU); g.fill();
        for (let k = 0; k < 4; k++) ellipse(g, x * s * 0.22, (k - 1.5) * 5, 3, 2, 0, '#e8dcc0');
        g.restore();
      }
      g.fillStyle = '#5a3a24'; body(); g.fill();
      ellipse(g, c, c - s * 0.33, s * 0.11, s * 0.1, 0, '#5a3a24');
      ellipse(g, c, c - s * 0.41, s * 0.05, s * 0.045, 0, '#7a5a40');
      ellipse(g, c, c - s * 0.44, 4, 3, 0, '#1e1410');
      for (const x of [-1, 1]) { ellipse(g, c + x * s * 0.08, c - s * 0.38, 7, 6, 0, '#4a2e1c'); ellipse(g, c + x * s * 0.045, c - s * 0.35, 2.5, 2.5, 0, '#1e1410'); }
      g.save(); g.globalCompositeOperation = 'source-atop';
      for (let i = 0; i < 900; i++) { const x = rnd() * s, y = rnd() * s, a = Math.atan2(y - c, x - c); line(g, [[x, y], [x + Math.cos(a) * 6, y + Math.sin(a) * 6]], 1.4, pick(rnd, fur), 0.5); }
      blob(g, c - 20, c - 10, s * 0.15, s * 0.22, 0, '#8a6448', 0.25, 0.2);
      g.restore();
    });
  },
});

register('rug_hide', {
  family: F, size: 256, alpha: true, note: 'a stretched hide rug with lacing holes and a painted ring (alpha)',
  paint(g, s, rnd) {
    rugCanvas(g, s, rnd, () => {
      const c = s / 2, pts = [];
      for (let k = 0; k < 16; k++) { const a = k / 16 * TAU, r = (k % 4 === 0 ? 0.48 : k % 2 ? 0.38 : 0.42) * s * range(rnd, 0.92, 1.05); pts.push([c + Math.cos(a) * r, c + Math.sin(a) * r * 0.82]); }
      clipped(g, () => polyPath(g, pts), () => {
        const rg = g.createRadialGradient(c - 20, c - 24, 6, c, c, s * 0.5); rg.addColorStop(0, '#d8b88c'); rg.addColorStop(0.6, '#b08a5c'); rg.addColorStop(1, '#7a5a3a');
        g.fillStyle = rg; g.fillRect(0, 0, s, s);
        mottle(g, s, rnd, { colors: ['#c8a478', '#8a6644', '#e0c49c'], count: 30, rmin: 8, rmax: 30, alpha: 0.3, hard: 0.15 });
        g.save(); g.strokeStyle = '#7a3020'; g.lineWidth = 7; g.globalAlpha = 0.75; g.beginPath(); g.arc(c, c, s * 0.17, 0, TAU); g.stroke();
        g.lineWidth = 4; for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; g.beginPath(); g.moveTo(c + Math.cos(a) * s * 0.21, c + Math.sin(a) * s * 0.21); g.lineTo(c + Math.cos(a) * s * 0.28, c + Math.sin(a) * s * 0.28); g.stroke(); } g.restore();
      });
      g.save(); g.lineWidth = 3; g.strokeStyle = rgba('#4a3020', 0.8); polyPath(g, pts); g.stroke(); g.restore();
      for (const [x, y] of pts) { ellipse(g, x + (c - x) * 0.06, y + (c - y) * 0.06, 3, 3, 0, '#2a1a14'); }
    });
  },
});

register('rug_braid', {
  family: F, size: 256, alpha: true, note: 'an oval braided rag rug in faded farmhouse colours (alpha)',
  paint(g, s, rnd) {
    rugCanvas(g, s, rnd, () => {
      const c = s / 2, cols = ['#8a3a2c', '#c8a868', '#5a6a4a', '#a87850', '#e0d0b0', '#6a4a5a'];
      for (let r = 0; r < 14; r++) {
        const rx = s * 0.47 - r * 8, ry = s * 0.36 - r * 8 * 0.77;
        if (ry < 4) break;
        const col = cols[(r + Math.floor(rnd() * 2)) % cols.length];
        g.save(); g.lineWidth = 8.5; g.strokeStyle = col; g.beginPath(); g.ellipse(c, c, rx, ry, 0, 0, TAU); g.stroke();
        g.setLineDash([5, 4]); g.lineWidth = 3; g.strokeStyle = rgba(lightOf(col, 0.4), 0.5); g.beginPath(); g.ellipse(c, c, rx - 1.5, ry - 1.5, 0, 0, TAU); g.stroke(); g.restore();
      }
      g.save(); g.globalCompositeOperation = 'source-atop';
      mottle(g, s, rnd, { colors: ['#2a2030', '#f0e4c8'], count: 20, rmin: 10, rmax: 40, alpha: 0.12, hard: 0.1 });
      g.restore();
    });
  },
});

register('rug_desert', {
  family: F, size: 256, alpha: true, note: 'a striped desert kilim with stepped diamonds and fringed ends (alpha)',
  paint(g, s, rnd) {
    rugCanvas(g, s, rnd, () => {
      const y0 = 16, y1 = s - 16;
      g.fillStyle = '#b8603a'; g.fillRect(8, y0, s - 16, y1 - y0);
      const bands = ['#e0c890', '#3a5a6a', '#8a2a20', '#e0c890', '#2a2030'];
      for (let k = 0; k < 10; k++) { g.fillStyle = bands[k % bands.length]; g.fillRect(8, y0 + 6 + k * 23, s - 16, 6); }
      for (let k = 0; k < 3; k++) {
        const cx = s / 2, cy = y0 + 40 + k * 75;
        for (let st = 4; st >= 1; st--) { g.fillStyle = st % 2 ? '#e8d4a0' : '#2a3a4a'; g.beginPath(); g.moveTo(cx, cy - st * 9); g.lineTo(cx + st * 14, cy); g.lineTo(cx, cy + st * 9); g.lineTo(cx - st * 14, cy); g.closePath(); g.fill(); }
      }
      for (let x = 10; x < s - 10; x += 5) { line(g, [[x, 2], [x + (rnd() - 0.5) * 3, y0]], 2, '#e0d4b0'); line(g, [[x, s - 2], [x + (rnd() - 0.5) * 3, y1]], 2, '#e0d4b0'); }
      g.save(); g.globalCompositeOperation = 'source-atop';
      for (let y = y0; y < y1; y += 3) line(g, [[0, y], [s, y]], 0.7, '#2a2030', 0.08);
      mottle(g, s, rnd, { colors: ['#f0e0c0', '#5a2a1a'], count: 20, rmin: 10, rmax: 40, alpha: 0.12, hard: 0.1 });
      g.restore();
    });
  },
});

register('sail_canvas', {
  family: F, w: 128, h: 512, alpha: true, note: 'windmill sail cloth: weathered cream canvas, seams, patches, dirt runs, frayed edges (alpha)',
  paint(g, s, rnd, H) {
    const W = 128;
    g.clearRect(0, 0, W, H);
    const pts = [[3, 2]];
    for (let y = 2; y <= H - 2; y += 16) pts.push([W - 3 - rnd() * 4, y]);
    for (let y = H - 2; y >= 2; y -= 16) pts.push([3 + rnd() * 4, y]);
    clipped(g, () => polyPath(g, pts), () => {
      g.fillStyle = grad(g, 0, 0, W, 0, [[0, '#e8dcc0'], [0.5, '#d6c9aa'], [1, '#b8a888']]); g.fillRect(0, 0, W, H);
      mottle(g, W, rnd, { colors: ['#e8dec4', '#c4b494', '#cfc2a2'], count: 30, rmin: 10, rmax: 40, alpha: 0.35, hard: 0.1 });
      for (let k = 1; k < 4; k++) { const y = H * k / 4; line(g, [[0, y], [W, y]], 3, '#9a8a6a', 0.55); line(g, [[0, y + 3], [W, y + 3]], 1, '#f0e8d0', 0.4); }
      for (let k = 0; k < 3; k++) {
        const x = range(rnd, 14, W - 50), y = range(rnd, 20, H - 70), w = range(rnd, 26, 44), h = range(rnd, 30, 60), c = pick(rnd, ['#c8b48c', '#b8a07a', '#d8ccb0']);
        g.fillStyle = c; g.fillRect(x, y, w, h);
        g.save(); g.setLineDash([3, 3]); g.strokeStyle = '#6a5a40'; g.lineWidth = 1.2; g.strokeRect(x + 2, y + 2, w - 4, h - 4); g.restore();
      }
      streaks(g, W, rnd, { colors: ['#8a7a5a', '#7a6a4a'], count: 14, len: [40, 160], width: [3, 8], angle: Math.PI, wobble: 0.05, alpha: 0.15 });
      g.fillStyle = grad(g, 0, 0, W, 0, [[0, INK, 0.25], [0.1, INK, 0], [0.9, INK, 0], [1, INK, 0.3]]); g.fillRect(0, 0, W, H);
    });
  },
});

// ---- signs ---------------------------------------------------------------------------------------

export const SIGN_FONT = `Georgia, 'Palatino Linotype', 'Book Antiqua', Palatino, 'Liberation Serif', 'DejaVu Serif', serif`;

// Lay a line out glyph by glyph with a hand-cut wobble: every letter turned a few degrees, nudged off
// the baseline and scaled a little (deterministic per line). Returns { glyphs, width }.
function layoutGlyphs(g, ln, size, track, rnd, wob = 1) {
  g.letterSpacing = '0px';
  const chars = [...ln], sp = size * track;
  const ws = chars.map(ch => g.measureText(ch).width);
  const width = ws.reduce((a, b) => a + b, 0) + sp * Math.max(0, chars.length - 1);
  let x = -width / 2;
  const glyphs = chars.map((ch, i) => {
    const q = { ch, x: x + ws[i] / 2, dy: (rnd() - 0.5) * 0.08 * size * wob, rot: (rnd() - 0.5) * 0.105 * wob, sc: 1 + (rnd() - 0.5) * 0.1 * wob };
    x += ws[i] + sp;
    return q;
  });
  return { glyphs, width };
}
// draw a laid-out line centred at (cx, cy); kx squeezes it sideways; op 'fill' | 'stroke'
function drawGlyphs(gg, L, cx, cy, op = 'fill', kx = 1) {
  gg.save(); gg.textAlign = 'center'; gg.textBaseline = 'middle';
  for (const q of L.glyphs) {
    if (q.ch === ' ') continue;
    gg.save(); gg.translate(cx + q.x * kx, cy + q.dy); gg.rotate(q.rot); gg.scale(q.sc * kx, q.sc);
    if (op === 'stroke') gg.strokeText(q.ch, 0, 0); else gg.fillText(q.ch, 0, 0);
    gg.restore();
  }
  gg.restore();
}

// Lines of text fitted into a box (x, y, w, h), first line bigger (the second stays at least 55% of it,
// squeezed sideways if it must). mode:
//   'paint'   brushed paint: a soft drop shadow, a warm lit edge, the fill (opt. a dark outline under it, drips)
//   'carved'  cut into the wood and filled with paint (gold: gilded), paint chipped out of the cuts
//   'burnt'   branded into hide: a scorched halo, charred strokes
//   'engraved' cut into brass: dark letters with a lit lower lip
function signText(g, lines, x, y, w, h, { fg = '#f2e2b8', shadow = INK, lit = '#fff4d0', mode = 'paint', gold = false, track = 0.04, wob = 1, outline = null, drips = 0, chipN = 12 } = {}) {
  const weights = lines.map((_, i) => (i === 0 ? 1 : 0.62));
  const tot = weights.reduce((a, b) => a + b, 0);
  let yy = y, size0 = 0;
  g.save();
  lines.forEach((ln, i) => {
    const lh = h * weights[i] / tot;
    const seed = hashStr(ln + '#' + i);
    let size = Math.floor(lh * 0.86);
    const font = () => `bold ${size}px ${SIGN_FONT}`;
    g.font = font();
    let L = layoutGlyphs(g, ln, size, track, rngFrom(seed), wob);
    while (L.width > w * 0.93 && size > 8) { size -= 1; g.font = font(); L = layoutGlyphs(g, ln, size, track, rngFrom(seed), wob); }
    let kx = 1;
    if (i === 0) size0 = size;
    else if (size < size0 * 0.55) {
      size = Math.floor(size0 * 0.55); g.font = font();
      L = layoutGlyphs(g, ln, size, track * 0.5, rngFrom(seed), wob);
      kx = Math.min(1, w * 0.95 / L.width);
    }
    const rnd = rngFrom(seed ^ 0x5bd1e995);
    const cy = yy + lh / 2 + size * 0.04, cx = x + w / 2, o = Math.max(1.5, size * 0.05), lw = Math.max(1, size * 0.045);
    g.lineJoin = 'round';
    if (mode === 'carved') {
      // a lit lower-right lip, the dark cut, then the paint inside it nudged down-right so the cut's
      // wall shows along the upper-left inner edge; a dozen flakes of paint chipped out of the cuts
      g.fillStyle = rgba('#f0d8a8', 0.45); drawGlyphs(g, L, cx + o * 0.55, cy + o * 0.7, 'fill', kx);
      g.fillStyle = '#2a1a12'; drawGlyphs(g, L, cx, cy, 'fill', kx);
      if (i > 0) { g.lineWidth = lw; g.strokeStyle = '#2a1a12'; drawGlyphs(g, L, cx, cy, 'stroke', kx); }
      const tw = Math.ceil(L.width * kx + size * 1.4), th = Math.ceil(size * 1.6);
      const setup = gg => { gg.font = g.font; gg.lineJoin = 'round'; gg.lineWidth = lw; };
      const cv2 = makeCanvas(tw, th), g2 = cv2.getContext('2d'), cv3 = makeCanvas(tw, th), g3 = cv3.getContext('2d');
      setup(g2); setup(g3);
      g2.fillStyle = '#000'; drawGlyphs(g2, L, tw / 2, th / 2, 'fill', kx);
      if (i > 0) { g2.strokeStyle = '#000'; drawGlyphs(g2, L, tw / 2, th / 2, 'stroke', kx); }
      g3.fillStyle = gold ? grad(g3, 0, th * 0.2, 0, th * 0.8, [[0, '#fff0b0'], [0.45, '#e8c060'], [0.6, '#c8962c'], [1, '#b88a30']]) : fg;
      drawGlyphs(g3, L, tw / 2 + o * 0.45, th / 2 + o * 0.55, 'fill', kx);
      if (i > 0) { g3.strokeStyle = g3.fillStyle; drawGlyphs(g3, L, tw / 2 + o * 0.45, th / 2 + o * 0.55, 'stroke', kx); }
      g3.save(); g3.globalCompositeOperation = 'destination-out';
      for (let k = 0; k < chipN; k++) { const px = tw / 2 + (rnd() - 0.5) * L.width * kx, py = th / 2 + (rnd() - 0.5) * size * 0.8, r = range(rnd, 1, 2.6) * size / 40; ellipse(g3, px, py, r * range(rnd, 1, 2), r, rnd() * 3, '#000', 1); }
      g3.restore();
      g2.globalCompositeOperation = 'source-in';
      g2.drawImage(cv3, 0, 0);
      g.drawImage(cv2, cx - tw / 2, cy - th / 2);
    } else if (mode === 'burnt') {
      g.save(); g.filter = `blur(${Math.max(1.5, o * 1.5)}px)`; g.fillStyle = rgba('#6a3010', 0.6); drawGlyphs(g, L, cx, cy, 'fill', kx); g.restore();
      g.lineWidth = size * 0.07; g.strokeStyle = rgba('#4a2010', 0.75); drawGlyphs(g, L, cx, cy, 'stroke', kx);
      g.fillStyle = '#22100a'; drawGlyphs(g, L, cx, cy, 'fill', kx);
      g.fillStyle = rgba('#a85a28', 0.35); drawGlyphs(g, L, cx - o * 0.3, cy - o * 0.3, 'fill', kx * 0.98);
      g.fillStyle = '#22100a'; drawGlyphs(g, L, cx + o * 0.15, cy + o * 0.15, 'fill', kx);
    } else if (mode === 'engraved') {
      g.fillStyle = rgba('#fff4c0', 0.7); drawGlyphs(g, L, cx + o * 0.45, cy + o * 0.55, 'fill', kx);
      g.fillStyle = '#3a2810'; drawGlyphs(g, L, cx, cy, 'fill', kx);
      g.fillStyle = rgba('#6a8a5a', 0.35); drawGlyphs(g, L, cx - o * 0.25, cy - o * 0.25, 'fill', kx);
      g.fillStyle = '#2e2008'; drawGlyphs(g, L, cx + o * 0.1, cy + o * 0.1, 'fill', kx);
    } else {
      if (outline) { g.lineWidth = size * 0.11; g.strokeStyle = outline; drawGlyphs(g, L, cx + o * 0.3, cy + o * 0.4, 'stroke', kx * 1.0); }
      g.save(); g.filter = `blur(${Math.max(1, o * 0.6)}px)`; g.fillStyle = rgba(shadow, 0.6); drawGlyphs(g, L, cx + o, cy + o * 1.3, 'fill', kx); g.restore();
      if (gold) {
        g.fillStyle = '#5a3a14'; drawGlyphs(g, L, cx + o * 0.5, cy + o * 0.6, 'fill', kx);
        g.fillStyle = grad(g, 0, cy - size / 2, 0, cy + size / 2, [[0, '#fff0b0'], [0.45, '#e8c060'], [0.55, '#c8962c'], [1, '#f0c860']]);
        drawGlyphs(g, L, cx, cy, 'fill', kx);
      } else {
        g.fillStyle = rgba(lit, 0.45); drawGlyphs(g, L, cx - o * 0.4, cy - o * 0.4, 'fill', kx);
        g.fillStyle = fg; drawGlyphs(g, L, cx, cy, 'fill', kx);
        if (i > 0) { g.lineWidth = lw; g.strokeStyle = fg; drawGlyphs(g, L, cx, cy, 'stroke', kx); }
      }
      // runs of paint from the bottoms of a few letters
      for (let k = 0; k < drips; k++) {
        const q = L.glyphs[Math.floor(rnd() * L.glyphs.length)]; if (!q || q.ch === ' ') continue;
        const px = cx + q.x * kx + (rnd() - 0.5) * size * 0.3, py = cy + size * 0.36, len = range(rnd, 0.15, 0.5) * size;
        line(g, [[px, py], [px + (rnd() - 0.5) * 1.5, py + len]], range(rnd, 1.2, 2.6) * size / 50, fg, 0.85);
        ellipse(g, px, py + len, 1.6 * size / 50, 2 * size / 50, 0, fg, 0.85);
      }
    }
    yy += lh;
  });
  g.restore();
}

// Chipped paint: little flakes of bare wood showing through a painted panel.
function chips(g, x, y, w, h, rnd, n, wood = '#7a5434') {
  for (let i = 0; i < n; i++) {
    const e = rnd() * 4 | 0, t = rnd(), d = Math.pow(rnd(), 2.5) * Math.min(w, h) * 0.3;
    const cx = e === 0 ? x + d : e === 1 ? x + w - d : x + t * w, cy = e === 2 ? y + d : e === 3 ? y + h - d : y + t * h;
    const r = range(rnd, 1.5, 5);
    ellipse(g, cx, cy, r * range(rnd, 1, 2.2), r, rnd() * 3, wood, 0.9);
    blob(g, cx + r * 0.3, cy + r * 0.4, r, r * 0.5, 0, INK, 0.25, 0.4);
  }
}

// The roadside billboard palette: oxblood, mustard, teal or cream, by the hue asked for.
function billboardPaint(bg) {
  if (!bg || bg.startsWith('rgba')) return '#7a3028';
  const { h, s, l } = hsl(bg);
  if (l > 0.82 || s < 0.15) return '#e6d6b0';
  const deg = h * 360;
  if (deg < 22 || deg >= 290) return '#7a3028';
  if (deg < 70) return '#b88a34';
  return '#3f6e6a';
}

// a carved C-scroll (gilded) curling out of a corner at (x, y); sx, sy point into the panel
function scrollOrnament(g, x, y, sx, sy, r) {
  const pts = [];
  for (let k = 0; k <= 24; k++) { const t = k / 24, a = t * TAU * 1.15, rr = r * (1 - t * 0.75); pts.push([x + sx * (Math.cos(a) * rr * 0.9 + r * 0.4), y + sy * (Math.sin(a) * rr * 0.6 + r * 0.2)]); }
  line(g, pts.map(([px, py]) => [px + 1.5, py + 2]), r * 0.16, '#2a1808', 0.6);
  line(g, pts, r * 0.12, '#c8962c', 0.95);
  line(g, pts.map(([px, py]) => [px - 0.8, py - 0.8]), r * 0.04, '#fff0b0', 0.8);
  const leaf = [[x + sx * r * 0.2, y + sy * r * 0.9], [x + sx * r * 1.4, y + sy * r * 0.35], [x + sx * r * 2.2, y + sy * r * 0.15]];
  line(g, leaf.map(([px, py]) => [px + 1.5, py + 2]), r * 0.12, '#2a1808', 0.5);
  line(g, leaf, r * 0.09, '#c8962c', 0.9);
}

// an interlaced knot band (dwarven): a chain of loops, each going over the last and under the next
function knotBand(g, x0, y0, x1, y1, r, rnd) {
  const L = Math.hypot(x1 - x0, y1 - y0), n = Math.max(2, Math.round(L / (r * 1.6))), ux = (x1 - x0) / L, uy = (y1 - y0) / L;
  for (let pass = 0; pass < 2; pass++) for (let k = 0; k < n; k++) {
    if ((k % 2) !== pass) continue;
    const cx = x0 + ux * (k + 0.5) * L / n, cy = y0 + uy * (k + 0.5) * L / n;
    g.save(); g.translate(cx, cy); g.rotate(Math.atan2(uy, ux));
    g.lineWidth = r * 0.42; g.strokeStyle = '#2a1a10'; g.beginPath(); g.ellipse(1, 1.5, r * 0.95, r * 0.6, 0, 0, TAU); g.stroke();
    g.lineWidth = r * 0.3; g.strokeStyle = '#c8a050'; g.beginPath(); g.ellipse(0, 0, r * 0.95, r * 0.6, 0, 0, TAU); g.stroke();
    g.lineWidth = r * 0.08; g.strokeStyle = '#fff0b8'; g.beginPath(); g.ellipse(-0.6, -0.8, r * 0.95, r * 0.6, 0, Math.PI, TAU * 0.85); g.stroke();
    g.restore();
  }
}

// ---- door aprons: the paving in front of each door and a few stepping stones out to the street ----------

// A flat stone (or a slab) as a lumpy polygon: base colour with soft lighter and darker patches, a lit
// upper-left lip and a cool lower-right one, a crack or two, then the style's dirt in its low corner.
function flatStone(g, pts, c, rnd, { lit = 0.45, cracksN = 1, specks = 4 } = {}) {
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), w = x1 - x0, h = y1 - y0;
  // a soft contact shadow round it first
  g.save(); g.filter = 'blur(2px)'; g.translate(2, 2.5); polyPath(g, pts); g.fillStyle = rgba(INK, 0.45); g.fill(); g.restore();
  clipped(g, () => polyPath(g, pts), () => {
    g.fillStyle = grad(g, x0, y0, x1, y1, [[0, lightOf(c, 0.18)], [0.5, c], [1, shadowOf(c, 0.22)]]); g.fillRect(x0 - 2, y0 - 2, w + 4, h + 4);
    for (let i = 0; i < 6; i++) blob(g, x0 + rnd() * w, y0 + rnd() * h, range(rnd, 0.2, 0.5) * w, range(rnd, 0.2, 0.45) * h, rnd() * 3, rnd() < 0.5 ? lightOf(c, 0.3) : shadowOf(c, 0.25), 0.22, 0.15);
    for (let i = 0; i < specks; i++) blob(g, x0 + rnd() * w, y0 + rnd() * h, range(rnd, 1.5, 3.5), range(rnd, 1.2, 2.8), rnd() * 3, shadowOf(c, 0.45), 0.4, 0.4);
    for (let i = 0; i < cracksN; i++) {
      const a = [x0 + rnd() * w, y0 + rnd() * h * 0.3], b = [x0 + rnd() * w, y0 + h * range(rnd, 0.5, 1)];
      const q = []; for (let k = 0; k <= 5; k++) { const t = k / 5; q.push([a[0] + (b[0] - a[0]) * t + range(rnd, -3, 3), a[1] + (b[1] - a[1]) * t]); }
      line(g, q.map(([x, y]) => [x + 0.8, y + 0.8]), 1.4, lightOf(c, 0.4), 0.4); line(g, q, 1.1, INK, 0.5);
    }
  });
  // lips: lit along the upper-left edges, shaded along the lower-right
  g.save(); g.lineJoin = 'round';
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length], nx = b[1] - a[1], ny = -(b[0] - a[0]), L = Math.hypot(nx, ny) || 1;
    const f = (nx / L) * -0.707 + (ny / L) * -0.707;   // outward normal against the light (upper left)
    if (f > 0.15) line(g, [[a[0] - nx / L * -1.2, a[1] - ny / L * -1.2], [b[0] - nx / L * -1.2, b[1] - ny / L * -1.2]], 2.4, lightOf(c, 0.55), lit * f);
    else if (f < -0.15) line(g, [[a[0] - nx / L * 1.2, a[1] - ny / L * 1.2], [b[0] - nx / L * 1.2, b[1] - ny / L * 1.2]], 2.6, shadowOf(c, 0.5), 0.5 * -f);
  }
  g.restore();
}
// a jittered polygon for the rect (x, y, w, h), its corners clipped
function stonePoly(x, y, w, h, rnd, cut = 0.22) {
  const c = Math.min(w, h) * cut, j = () => range(rnd, -1, 1) * Math.min(w, h) * 0.06;
  return [[x + c + j(), y + j()], [x + w - c + j(), y + j()], [x + w + j(), y + c + j()], [x + w + j(), y + h - c + j()], [x + w - c + j(), y + h + j()], [x + c + j(), y + h + j()], [x + j(), y + h - c + j()], [x + j(), y + c + j()]];
}
const APRON = {
  timber: { stones: ['#a59c8d', '#958d80', '#b4aa98', '#9c9387', '#ada392'], grout: '#4c4348', dirt: '#7c5b3a', dirt2: '#9a7650', moss: ['#6d7a4a', '#5d6b3c'] },
  farm: { stones: ['#b8a888', '#a89878', '#c4b494', '#9e8e70'], grout: '#8a6a46', dirt: '#94704a', dirt2: '#b18c5c', straw: true, sparse: 0.35 },
  alpine: { stones: ['#8e96a3', '#7f8794', '#9ea5b0', '#878e9a'], grout: '#3e4450', dirt: '#8a8478', dirt2: '#a39d90', snow: true },
  frontier: { planks: ['#8a6a4c', '#7a5a3e', '#9a7a58', '#86664a'], grout: '#3a2a22', dirt: '#a77650', dirt2: '#b98457' },
  adobe: { stones: ['#c27a50', '#b06a44', '#d08a5e', '#c88458'], grout: '#6a4630', dirt: '#bf9a68', dirt2: '#d9b87f', sand: true, tiles: true },
};
// 384 × 640 (3 m × 5 m; y = 0 at the door): an apron of paving 2.2-2.5 m deep with a ragged edge, then
// stepping stones out to the street over a worn strip of dirt, everything fading into the ground (alpha)
function apronPaint(g, W, H, rnd, st) {
  const A = APRON[st];
  g.clearRect(0, 0, W, H);
  const PX = W / 3, aD = range(rnd, 2.2, 2.5) * PX;          // px per metre, the apron's depth
  // the worn dirt under it all, in a separate layer so the soft blobs don't pile up
  const dc = makeCanvas(W, H), dg = dc.getContext('2d');
  for (let i = 0; i < 26; i++) blob(dg, W / 2 + range(rnd, -0.42, 0.42) * W, range(rnd, 0.02, 0.48) * H * (aD / (H * 0.45)), range(rnd, 50, 110), range(rnd, 40, 80), rnd() * 3, rnd() < 0.6 ? A.dirt : A.dirt2, 0.7, 0.25);
  for (let y = aD - 20; y < H - 30; y += 22) blob(dg, W / 2 + range(rnd, -20, 20), y, range(rnd, 50, 80), range(rnd, 30, 50), rnd() * 3, rnd() < 0.6 ? A.dirt : A.dirt2, 0.55 * (1 - (y - aD) / (H - aD) * 0.6), 0.2);
  g.save(); g.globalAlpha = 0.8; g.drawImage(dc, 0, 0); g.restore();
  // the apron's outline: a ragged rounded shape, a little narrower away from the door
  const edge = []; const n = 22;
  for (let k = 0; k < n; k++) {
    const t = k / n * TAU, ca = Math.cos(t), sa = Math.sin(t);
    const r = 1 / Math.pow(Math.pow(Math.abs(ca), 3) + Math.pow(Math.abs(sa), 3), 1 / 3) * range(rnd, 0.9, 1.04);
    const yy = sa * r * aD * 0.5 + aD * 0.5;
    edge.push([W / 2 + ca * r * W * (0.47 - 0.05 * Math.max(0, sa)), Math.max(-20, yy)]);
  }
  edge[Math.floor(n * 0.75)][1] = -30;   // the door side runs right up to the threshold
  const inside = (x, y) => { let c = false; for (let i = 0, j = edge.length - 1; i < edge.length; j = i++) { const [xi, yi] = edge[i], [xj, yj] = edge[j]; if (((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } return c; };
  if (A.planks) {
    // a boardwalk: rough planks laid across, ends ragged, two sleepers showing at the sides
    let y = 0;
    while (y < aD - 10) {
      const ph = range(rnd, 0.22, 0.3) * PX, l0 = W * range(rnd, 0.04, 0.12), l1 = W * range(rnd, 0.88, 0.97);
      if (rnd() > 0.08) { g.save(); g.filter = 'blur(2px)'; g.fillStyle = rgba(INK, 0.45); g.fillRect(l0 + 2, y + 3, l1 - l0, ph - 2); g.restore(); plank(g, l0, y + 1, l1 - l0, ph - 3, jitter(pick(rnd, A.planks), rnd, 0.07), rnd, { grain: 9, knots: 0.5, splits: 0.6, weather: 0.5, nails: 4, endShade: 0.25 }); }
      y += ph;
    }
    // log rounds for stepping stones
    for (let y2 = aD + 0.3 * PX, k = 0; y2 < H - 40; y2 += range(rnd, 0.62, 0.8) * PX, k++) {
      const x = W / 2 + (k % 2 ? 1 : -1) * range(rnd, 6, 26), r = range(rnd, 0.22, 0.3) * PX;
      blob(g, x + 3, y2 + 4, r * 1.15, r * 1.1, 0, INK, 0.45, 0.4);
      ellipse(g, x, y2, r, r * 0.96, 0, '#6a4a30');
      ellipse(g, x - 1, y2 - 1, r * 0.88, r * 0.84, 0, '#c8a070');
      for (let q = 1; q < 5; q++) g.save(), g.strokeStyle = rgba('#8a6440', 0.55), g.lineWidth = 1.2, g.beginPath(), g.ellipse(x - 1 + range(rnd, -1, 1), y2 - 1, r * 0.88 * q / 5, r * 0.84 * q / 5, 0, 0, TAU), g.stroke(), g.restore();
      line(g, [[x - r * 0.6, y2 - r * 0.2], [x + r * 0.1, y2 + r * 0.1]], 1.2, INK, 0.5);
    }
  } else {
    // grout under the paving, then the stones in rows (square tiles in Gadgetzan), the edge ones dropped
    g.save(); g.filter = 'blur(4px)'; polyPath(g, edge); g.fillStyle = A.grout; g.fill(); g.restore();
    let y = -6;
    while (y < aD + 10) {
      const rh = (A.tiles ? range(rnd, 0.36, 0.42) : range(rnd, 0.42, 0.6)) * PX;
      let x = -range(rnd, 0, 0.4) * PX;
      while (x < W) {
        const sw = (A.tiles ? range(rnd, 0.36, 0.44) : range(rnd, 0.45, 0.9)) * PX;
        const cx = x + sw / 2, cy = y + rh / 2;
        const keep = inside(cx, cy) && (!A.sparse || rnd() > A.sparse || cy < aD * 0.45);
        if (keep && inside(x + 6, y + 6) && inside(x + sw - 6, y + rh - 6)) flatStone(g, stonePoly(x + 3, y + 3, sw - 6, rh - 6, rnd, A.tiles ? 0.12 : 0.22), jitter(pick(rnd, A.stones), rnd, 0.06), rnd, { cracksN: rnd() < 0.4 ? 1 : 0 });
        else if (keep) { const k = 0.6; flatStone(g, stonePoly(cx - sw * k / 2, cy - rh * k / 2, sw * k, rh * k, rnd, 0.3), jitter(pick(rnd, A.stones), rnd, 0.08), rnd, { cracksN: 0 }); }
        x += sw;
      }
      y += rh;
    }
    // the grout's own edge, soft: crumbs of stone and dirt where the paving gives out
    for (let i = 0; i < 40; i++) { const e = edge[Math.floor(rnd() * edge.length)]; const x = e[0] + range(rnd, -14, 14), yy = e[1] + range(rnd, -10, 14); if (yy < 4) continue; flatStone(g, stonePoly(x - 5, yy - 4, range(rnd, 6, 14), range(rnd, 5, 10), rnd, 0.35), pick(rnd, A.stones), rnd, { cracksN: 0, specks: 0, lit: 0.3 }); }
    // stepping stones out to the street, a little zig-zag
    for (let y2 = aD + 0.35 * PX, k = 0; y2 < H - 50; y2 += range(rnd, 0.7, 0.88) * PX, k++) {
      const sw = range(rnd, 0.48, 0.66) * PX, sh = range(rnd, 0.36, 0.5) * PX, x = W / 2 + (k % 2 ? 1 : -1) * range(rnd, 4, 22) - sw / 2;
      flatStone(g, stonePoly(x, y2 - sh / 2, sw, sh, rnd, 0.32), jitter(pick(rnd, A.stones), rnd, 0.07), rnd, { cracksN: rnd() < 0.3 ? 1 : 0 });
    }
  }
  // the style's dirt on top: moss in the joints (Goldshire), straw (Westfall), snow drifted into the joints
  // and over the edges (Kharanos), sand blown across (Gadgetzan); a little road dust everywhere
  const over = (cols, count, rmin, rmax, alpha, yMax = H) => { for (let i = 0; i < count; i++) blob(g, rnd() * W, rnd() * yMax, range(rnd, rmin, rmax), range(rnd, rmin, rmax) * 0.7, rnd() * 3, pick(rnd, cols), alpha, 0.2); };
  g.save(); g.globalCompositeOperation = 'source-atop';
  if (A.moss) over(A.moss, 26, 6, 20, 0.28, aD);
  if (A.snow) { over(['#eef2f6', '#dfe8f0', '#f6f4ee'], 34, 8, 30, 0.55); for (let i = 0; i < 16; i++) { const e = edge[Math.floor(rnd() * edge.length)]; blob(g, e[0], e[1], range(rnd, 18, 40), range(rnd, 12, 26), rnd() * 3, '#eef2f6', 0.8, 0.35); } }
  if (A.sand) { over(['#d9b87f', '#e8cc96'], 30, 10, 36, 0.4); for (let i = 0; i < 12; i++) { const e = edge[Math.floor(rnd() * edge.length)]; blob(g, e[0], e[1], range(rnd, 20, 46), range(rnd, 12, 26), rnd() * 3, '#e2c48e', 0.65, 0.3); } }
  if (A.straw) for (let i = 0; i < 50; i++) { const x = rnd() * W, y = rnd() * H, a = rnd() * TAU, L = range(rnd, 8, 22); line(g, [[x, y], [x + Math.cos(a) * L, y + Math.sin(a) * L]], range(rnd, 1, 2), pick(rnd, ['#e2c56a', '#c9ac52', '#f0d888']), 0.8); }
  over([A.dirt2, A.dirt], 20, 6, 22, 0.16);
  g.restore();
  // fade the far end into the ground
  g.save(); g.globalCompositeOperation = 'destination-out';
  g.fillStyle = grad(g, 0, H - 120, 0, H, [[0, '#000', 0], [1, '#000', 1]]); g.fillRect(0, H - 120, W, 120);
  g.restore();
}
for (const st of Object.keys(APRON)) register('arch_apron_' + st, { family: F, w: 384, h: 640, alpha: true, note: `door apron (${st}): paving at the door, stepping stones out to the street, fading into the ground (alpha; y = 0 at the door)`, paint(g, w, rnd, h) { apronPaint(g, w, h, rnd, st); } });

// ---- the rim code: house paint brushed onto a rock -------------------------------------------------

// Brush skeletons for the digits in a 0.6 × 1 box (y down), a few strokes each; a stroke is a list of
// points, smoothed and sampled when it is painted. arc(): degrees, 0 = right, 90 = down (y down).
const arc = (cx, cy, rx, ry, a0, a1, n = 10) => { const p = []; for (let k = 0; k <= n; k++) { const a = (a0 + (a1 - a0) * k / n) * Math.PI / 180; p.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]); } return p; };
const DIGITS = {
  0: [arc(0.3, 0.5, 0.25, 0.46, -100, 262, 18)],
  1: [[[0.12, 0.25], [0.33, 0.04], [0.34, 0.5], [0.33, 0.97]], [[0.12, 0.96], [0.54, 0.97]]],
  2: [[...arc(0.3, 0.29, 0.25, 0.24, 192, 370, 9), [0.44, 0.55], [0.05, 0.95]], [[0.03, 0.95], [0.6, 0.94]]],
  3: [arc(0.28, 0.26, 0.25, 0.22, 205, 450, 10), arc(0.27, 0.72, 0.29, 0.25, -95, 158, 11)],
  4: [[[0.45, 0.04], [0.03, 0.67]], [[0.02, 0.67], [0.61, 0.66]], [[0.45, 0.05], [0.44, 0.98]]],
  5: [[[0.56, 0.05], [0.1, 0.06]], [[0.1, 0.05], [0.06, 0.46]], [[0.06, 0.46], ...arc(0.29, 0.69, 0.27, 0.28, -122, 152, 11)]],
  6: [[[0.52, 0.05], [0.3, 0.15], [0.14, 0.36], [0.06, 0.64], ...arc(0.3, 0.73, 0.25, 0.24, 180, 535, 13)]],
  7: [[[0.02, 0.06], [0.6, 0.05]], [[0.6, 0.05], [0.38, 0.5], [0.24, 0.97]]],
  8: [arc(0.3, 0.27, 0.21, 0.22, 95, 452, 13), arc(0.3, 0.72, 0.26, 0.25, -88, 268, 13)],
  9: [arc(0.29, 0.31, 0.25, 0.27, 5, 368, 13), [[0.55, 0.3], [0.53, 0.62], [0.43, 0.86], [0.25, 0.97], [0.05, 0.91]]],
};
// a Catmull-Rom curve through pts, sampled about every `step` px
function sampleCurve(pts, step) {
  const out = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    const n = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push([f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}
// One loaded brush stroke into a mask (gm paints opaque; colour comes later): round dabs along the curve,
// the width swelling and thinning with the hand's pressure, then bristle gaps dragged out of it where the
// brush runs dry (more toward the end, more at the brush's edges). Returns the stroke for later passes.
function brushMask(gm, pts, r0, rnd, { dry = 0.5, bristles = 11, taper = 0.75 } = {}) {
  const P = sampleCurve(pts, Math.max(0.8, r0 * 0.18)), n = P.length;
  if (n < 2) return null;
  const N = P.map((p, i) => { const a = P[Math.max(0, i - 1)], b = P[Math.min(n - 1, i + 1)], dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [-dy / l, dx / l]; });
  const ph = rnd() * 6, ph2 = rnd() * 6, kick = range(rnd, 0.9, 1.25);
  const rad = t => r0 * (0.8 + 0.2 * Math.sin(Math.PI * Math.min(1, t * 1.4 + 0.2)) + 0.09 * Math.sin(t * 7 + ph) + 0.05 * Math.sin(t * 19 + ph2))
    * (t < 0.06 ? kick : 1) * (t > taper ? 1 - (t - taper) / (1 - taper) * 0.55 : 1);
  const R = P.map((_, i) => rad(i / (n - 1)));
  gm.fillStyle = '#000';
  for (let i = 0; i < n; i++) { gm.beginPath(); gm.arc(P[i][0], P[i][1], Math.max(0.4, R[i]), 0, TAU); gm.fill(); }
  // the bristles: thin lines along the stroke, each running dry in its own rhythm
  gm.save(); gm.globalCompositeOperation = 'destination-out'; gm.lineCap = 'butt';
  for (let k = 0; k < bristles; k++) {
    const o = (k / (bristles - 1) - 0.5) * 1.9, edge = Math.abs(o) > 0.62 ? 0.35 : 0;
    const w = r0 * range(rnd, 0.05, 0.13), f = range(rnd, 5, 14), p0 = rnd() * 6, start = range(rnd, 0.15, 0.7);
    gm.lineWidth = w;
    for (let i = 1; i < n; i++) {
      const t = i / (n - 1);
      const d = Math.min(0.95, Math.max(0, (Math.max(0, t - start) / (1 - start)) * dry + edge * dry + 0.55 * Math.sin(t * f + p0) - 0.25));
      if (d < 0.04) continue;
      gm.strokeStyle = `rgba(0,0,0,${d.toFixed(3)})`;
      gm.beginPath();
      gm.moveTo(P[i - 1][0] + N[i - 1][0] * o * R[i - 1] * 0.5, P[i - 1][1] + N[i - 1][1] * o * R[i - 1] * 0.5);
      gm.lineTo(P[i][0] + N[i][0] * o * R[i] * 0.5, P[i][1] + N[i][1] * o * R[i] * 0.5);
      gm.stroke();
    }
  }
  gm.restore();
  return { P, N, R };
}
// a few lit and dark ridges of paint along a stroke (drawn onto the coloured paint, source-atop)
function brushRidges(g, S, rnd, lite, dark) {
  const { P, N, R } = S;
  for (let k = 0; k < 5; k++) {
    const o = range(rnd, -0.75, 0.75), c = k < 3 ? lite : dark, a = k < 3 ? range(rnd, 0.16, 0.3) : range(rnd, 0.12, 0.22);
    const t0 = Math.floor(rnd() * P.length * 0.4), t1 = Math.min(P.length, t0 + Math.floor(P.length * range(rnd, 0.3, 0.7)));
    const pts = []; for (let i = t0; i < t1; i++) pts.push([P[i][0] + N[i][0] * o * R[i] * 0.5, P[i][1] + N[i][1] * o * R[i] * 0.5]);
    if (pts.length > 1) line(g, pts, Math.max(0.8, R[t0] * range(rnd, 0.1, 0.22)), c, a, 'butt');
  }
}
// The code daubed in house paint on the rock: a patchy primer wash of the contrasting value behind it,
// the digits in loaded brush strokes (uneven width, dry-brush bristle gaps, lit ridges), round splatters
// where the brush was flicked, and a dry drag of the emptied brush under the number. Transparent elsewhere.
function daub(g, text, w, h, rnd, { paint, primer = null, edge = null }) {
  const chars = [...text];
  const gap = 0.2, cw = 0.6;
  const size = Math.min(h * 0.52, w * 0.7 / Math.max(1, chars.length * cw + (chars.length - 1) * gap));
  const r0 = size * 0.085;
  const tw = size * (chars.length * cw + (chars.length - 1) * gap), x0 = (w - tw) / 2, y0 = (h - size) / 2 - size * 0.04;
  const lightPaint = hsl(paint).l > 0.55;
  // 1. the primer: a few broad, patchy horizontal strokes over the code's box
  if (primer) {
    const pc = makeCanvas(w, h), pg = pc.getContext('2d');
    const rows = 3, pr = size * 0.3;
    for (let k = 0; k < rows; k++) {
      const y = y0 + size * (0.12 + 0.76 * k / (rows - 1)) + range(rnd, -0.05, 0.05) * size;
      const a = Math.max(pr * 1.1, x0 - size * range(rnd, 0.2, 0.4)), b = Math.min(w - pr * 1.1, x0 + tw + size * range(rnd, 0.15, 0.4));
      const pts = []; for (let i = 0; i <= 5; i++) { const t = i / 5; pts.push([a + (b - a) * t, y + Math.sin(t * 3 + k) * size * 0.05]); }
      brushMask(pg, k % 2 ? pts.reverse() : pts, pr, rnd, { dry: 0.75, bristles: 15, taper: 0.6 });
    }
    pg.globalCompositeOperation = 'source-in'; pg.fillStyle = primer; pg.fillRect(0, 0, w, h);
    g.save(); g.globalAlpha = 0.45; g.drawImage(pc, 0, 0); g.restore();
  }
  // 2. the paint mask: digits, splatters, the drag
  const mc = makeCanvas(w, h), mg = mc.getContext('2d');
  const strokes = [];
  chars.forEach((ch, i) => {
    const sk = DIGITS[ch];
    const ox = x0 + i * size * (cw + gap) + range(rnd, -0.03, 0.03) * size, oy = y0 + range(rnd, -0.05, 0.05) * size;
    const rot = range(rnd, -0.09, 0.09), sc = range(rnd, 0.94, 1.06), cx = ox + size * cw / 2, cy = oy + size / 2;
    const tf = ([u, v]) => { const x = (u - cw / 2) * size * sc, y = (v - 0.5) * size * sc; return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]; };
    if (sk) for (const st of sk) { const S = brushMask(mg, st.map(tf), r0 * range(rnd, 0.9, 1.1), rnd, { dry: range(rnd, 0.35, 0.6) }); if (S) strokes.push(S); }
    else if (ch !== ' ') {
      // anything but a digit: the serif glyph, roughened
      mg.save(); mg.font = `bold ${Math.floor(size * 1.05)}px ${SIGN_FONT}`; mg.textAlign = 'center'; mg.textBaseline = 'middle'; mg.fillStyle = '#000';
      mg.translate(cx, cy); mg.rotate(rot); mg.fillText(ch, 0, 0); mg.restore();
    }
  });
  // splatters: flicked off the loaded brush near the starts of strokes, and a few strays
  const dot = (x, y, r) => { mg.beginPath(); mg.ellipse(x, y, r * range(rnd, 0.85, 1.2), r, rnd() * 3, 0, TAU); mg.fill(); };
  mg.fillStyle = '#000';
  for (let k = 0; k < 7; k++) {
    const S = strokes[Math.floor(rnd() * strokes.length)]; if (!S) break;
    const [sx, sy] = S.P[0], a = rnd() * TAU, d = r0 * range(rnd, 1.6, 3.2);
    const bx = sx + Math.cos(a) * d, by = sy + Math.sin(a) * d;
    dot(bx, by, r0 * range(rnd, 0.18, 0.4));
    for (let j = 0; j < 3; j++) { const dd = r0 * range(rnd, 0.5, 1.6); dot(bx + Math.cos(a) * dd + range(rnd, -2, 2), by + Math.sin(a) * dd + range(rnd, -2, 2), r0 * range(rnd, 0.06, 0.16)); }
  }
  for (let k = 0; k < 14; k++) dot(x0 - size * 0.2 + rnd() * (tw + size * 0.4), y0 - size * 0.15 + rnd() * size * 1.3, r0 * range(rnd, 0.05, 0.2));
  // the emptied brush dragged out under the number (dry, broken, trailing off)
  const ya = y0 + size * 1.14, xa = x0 + tw * range(rnd, 0.0, 0.12);
  brushMask(mg, [[xa, ya + size * 0.04], [xa + tw * 0.3, ya + size * 0.07], [xa + tw * 0.62, ya + size * 0.02]], r0 * 0.7, rnd, { dry: 1.5, bristles: 9, taper: 0.3 });
  // 3. colour it: the paint with soft lighter and darker patches and ridges along the strokes
  const cc = makeCanvas(w, h), cg = cc.getContext('2d');
  cg.fillStyle = paint; cg.fillRect(0, 0, w, h);
  cg.globalCompositeOperation = 'destination-in'; cg.drawImage(mc, 0, 0);
  cg.globalCompositeOperation = 'source-atop';
  for (let k = 0; k < 26; k++) blob(cg, rnd() * w, rnd() * h, r0 * range(rnd, 1, 3), r0 * range(rnd, 0.6, 1.6), rnd() * 3, rnd() < 0.5 ? lightOf(paint, 0.3) : shadowOf(paint, 0.3), range(rnd, 0.12, 0.28), 0.2);
  for (const S of strokes) brushRidges(cg, S, rnd, lightOf(paint, 0.4), shadowOf(paint, 0.35));
  cg.globalCompositeOperation = 'source-over';
  // 4. lay it down: a soft darker rim under the paint (the edge colour, or a thin shadow), then the paint
  const ec = makeCanvas(w, h), eg = ec.getContext('2d');
  eg.filter = `blur(${Math.max(1, r0 * 0.12).toFixed(1)}px)`; eg.drawImage(mc, 0, 0); eg.filter = 'none';
  eg.globalCompositeOperation = 'source-in'; eg.fillStyle = edge || (lightPaint ? INK : '#1e1410'); eg.fillRect(0, 0, w, h);
  g.save(); g.globalAlpha = edge ? 0.85 : 0.4; g.drawImage(ec, r0 * 0.12, r0 * 0.16); g.restore();
  g.save(); g.globalAlpha = 0.94; g.drawImage(cc, 0, 0); g.restore();
}

// Paint a sign face. style:
//   'board'   a painted panel on a planked board        'carved'  letters cut into bare wood
//   'oakgold' carved oak, a moulded frame, gilded letters and scrolls (the Goldshire casino)
//   'barn'    letters painted straight onto faded barn boards (the Westfall casino)
//   'dwarf'   dark oak in a bronze rune-knot border, gilded carved letters (Kharanos)
//   'hide'    a stretched hide with branded letters, ragged edges and lacing holes (alpha) (the canyon outpost)
//   'goblin'  a riveted brass marquee frame, a teal panel, gold letters, gears (Gadgetzan)
//   'plaque'  an engraved brass plaque          'billboard'  big painted roadside boards
//   'daub'    paint on rock (transparent)
// Returns a canvas of w×h.
export function signCanvas(lines, { w = 512, h = 256, bg = '#c9a24a', fg = '#f2e2b8', style = 'board', seed = '', edge = null } = {}) {
  const cv = makeCanvas(w, h), g = cv.getContext('2d');
  const rnd = rngFrom(hashStr(lines.join('|') + style + seed));
  const m = Math.min(w, h);
  const wood = ['#6e4a2e', '#7a5434', '#664428', '#805a38'];
  const boards = (n, cols = wood, weather = 0.2) => {
    fill(g, w, h, '#1e1418');
    for (let i = 0; i < n; i++) plank(g, 0, i * h / n + 1, w, h / n - 2, jitter(pick(rnd, cols), rnd, 0.06), rnd, { grain: 14, knots: 0.6, splits: 0.6, bevel: 3, weather, endShade: 0.2 });
  };
  const fgCol = c => { const { l } = hsl(c || '#fff'); return l > 0.6 ? '#f4e6c0' : l < 0.25 ? '#2a1e18' : muteColor(c, { sMax: 0.55, lMin: 0.3, lMax: 0.7 }); };
  if (style === 'daub') {
    // house paint brushed onto a rock: fg is the paint, bg (if a color) the primer wash behind it, edge
    // an optional darker rim under the strokes
    daub(g, String(lines[0] || ''), w, h, rnd, { paint: fg || '#f2ead8', primer: bg && !bg.startsWith('rgba') ? bg : null, edge });
    return cv;
  }
  if (style === 'gilded' || style === 'oakgold') {
    boards(Math.max(2, Math.round(h / 80)), ['#5e3c24', '#6a4428', '#563620'], 0.12);
    const fr = m * 0.13;
    for (const [x, y, ww, hh, v] of [[0, 0, w, fr, false], [0, h - fr, w, fr, false], [0, 0, fr, h, true], [w - fr, 0, fr, h, true]]) plank(g, x, y, ww, hh, '#8a5e36', rnd, { vertical: v, grain: 6, bevel: 4, light: 0.6, splits: 0.2 });
    for (const [x0, y0, sx, sy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) line(g, [[x0, y0], [x0 + sx * fr, y0 + sy * fr]], 1.6, INK, 0.6);
    g.save(); g.strokeStyle = rgba('#2a1a10', 0.6); g.lineWidth = 3; g.strokeRect(fr * 0.5 + 1.5, fr * 0.5 + 2, w - fr, h - fr);
    g.strokeStyle = rgba('#e8c090', 0.45); g.lineWidth = 1.5; g.strokeRect(fr * 0.5, fr * 0.5, w - fr, h - fr); g.restore();
    g.fillStyle = grad(g, 0, fr, 0, fr + 16, [[0, INK, 0.6], [1, INK, 0]]); g.fillRect(fr, fr, w - 2 * fr, 16);
    g.fillStyle = grad(g, fr, 0, fr + 12, 0, [[0, INK, 0.45], [1, INK, 0]]); g.fillRect(fr, fr, 12, h - 2 * fr);
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) scrollOrnament(g, sx > 0 ? fr * 1.25 : w - fr * 1.25, sy > 0 ? fr * 1.3 : h - fr * 1.3, sx, sy, fr * 0.75);
    for (const [x, y] of [[fr / 2, fr / 2], [w - fr / 2, fr / 2], [fr / 2, h - fr / 2], [w - fr / 2, h - fr / 2], [w / 2, fr / 2], [w / 2, h - fr / 2]]) rivet(g, x, y, Math.max(3, fr * 0.16), '#c8a050');
    signText(g, lines, fr * 2.3, fr * 1.1, w - fr * 4.6, h - fr * 2.2, { mode: 'carved', gold: true, track: 0.06, chipN: 8 });
    glaze(g, w, h, '#ffe0b0', 0.08, 'soft-light');
    return cv;
  }
  if (style === 'barn') {
    fill(g, w, h, '#2a1a1c');
    const nb = Math.max(6, Math.round(w / 34)), bw = w / nb;
    for (let i = 0; i < nb; i++) plank(g, i * bw + 1.5, 0, bw - 3, h, jitter(pick(rnd, ['#8a3a2a', '#7e3426', '#94442e', '#86382a']), rnd, 0.07), rnd, { vertical: true, grain: 6, galpha: 0.3, weather: 0.6, splits: 0.4, nails: 2, bevel: 2, knots: 0.2 });
    for (let i = 0; i < Math.round(w * h / 9000); i++) { const x = rnd() * w, y = rnd() * h, L = range(rnd, 10, 40), ww = range(rnd, 4, 10); blob(g, x, y, ww * 0.55, L * 0.5, 0, '#9a8e7c', 0.6, 0.6); }
    // two painted rules and the letters, cream, brushed on with a few runs
    for (const y of [h * 0.1, h * 0.9]) { line(g, [[w * 0.06, y], [w * 0.94, y + (rnd() - 0.5) * 3]], h * 0.03, '#2a1010', 0.35); line(g, [[w * 0.06, y - 1], [w * 0.94, y - 1 + (rnd() - 0.5) * 3]], h * 0.022, '#e8dcc0', 0.9); }
    signText(g, lines, w * 0.04, h * 0.12, w * 0.92, h * 0.78, { mode: 'paint', fg: '#f0e2c0', shadow: '#1a0808', wob: 1.4, drips: 7, track: 0.04, outline: '#3a1410' });
    chips(g, 0, 0, w, h, rnd, Math.round(w * h / 5000), '#8a7a68');
    streaks(g, Math.max(w, h), rnd, { colors: ['#4a2420', '#b07a68'], count: 16, len: [30, 120], width: [2, 6], angle: Math.PI, wobble: 0.02, alpha: 0.14 });
    glaze(g, w, h, '#ffd8b0', 0.1, 'soft-light');
    return cv;
  }
  if (style === 'dwarf') {
    boards(Math.max(2, Math.round(h / 80)), ['#4a3222', '#52382a', '#3e2a1c'], 0.1);
    const fr = m * 0.15;
    g.save(); g.beginPath(); g.rect(0, 0, w, h); g.rect(fr, h - fr, w - 2 * fr, -(h - 2 * fr)); g.clip('evenodd');
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#8a6a3a'], [0.5, '#6a4e28'], [1, '#4a3418']]); g.fillRect(0, 0, w, h);
    g.restore();
    knotBand(g, fr * 0.5, fr * 0.5, w - fr * 0.5, fr * 0.5, fr * 0.32, rnd); knotBand(g, fr * 0.5, h - fr * 0.5, w - fr * 0.5, h - fr * 0.5, fr * 0.32, rnd);
    knotBand(g, fr * 0.5, fr * 0.5, fr * 0.5, h - fr * 0.5, fr * 0.32, rnd); knotBand(g, w - fr * 0.5, fr * 0.5, w - fr * 0.5, h - fr * 0.5, fr * 0.32, rnd);
    // iron corner plates with rivets
    for (const [x, y] of [[0, 0], [w - fr * 1.4, 0], [0, h - fr * 1.4], [w - fr * 1.4, h - fr * 1.4]]) {
      g.fillStyle = grad(g, x, y, x + fr * 1.4, y + fr * 1.4, [[0, '#7a7882'], [1, '#2e2c34']]); g.fillRect(x, y, fr * 1.4, fr * 1.4);
      for (const [dx, dy] of [[0.3, 0.3], [1.1, 0.3], [0.3, 1.1], [1.1, 1.1]]) rivet(g, x + dx * fr, y + dy * fr, Math.max(2.5, fr * 0.12), '#8a8890');
    }
    g.fillStyle = grad(g, 0, fr, 0, fr + 14, [[0, INK, 0.6], [1, INK, 0]]); g.fillRect(fr, fr, w - 2 * fr, 14);
    signText(g, lines, fr * 1.3, fr * 1.1, w - fr * 2.6, h - fr * 2.2, { mode: 'carved', gold: true, track: 0.08, chipN: 10, wob: 0.8 });
    glaze(g, w, h, '#ffe0b0', 0.08, 'soft-light');
    return cv;
  }
  if (style === 'hide') {
    g.clearRect(0, 0, w, h);
    const pts = [], jag = () => (rnd() - 0.5) * m * 0.04;
    const ins = m * 0.06;
    const edge = (x0, y0, x1, y1, nx, ny, n) => { for (let k = 0; k < n; k++) { const t = k / n, sag = Math.sin(Math.PI * t) * m * 0.07; pts.push([x0 + (x1 - x0) * t + nx * sag + jag(), y0 + (y1 - y0) * t + ny * sag + jag()]); } };
    const nx = Math.max(6, Math.round(w / 40)), ny = Math.max(4, Math.round(h / 40));
    edge(ins * 0.3, ins * 0.3, w - ins * 0.3, ins * 0.3, 0, 1, nx); edge(w - ins * 0.3, ins * 0.3, w - ins * 0.3, h - ins * 0.3, -1, 0, ny);
    edge(w - ins * 0.3, h - ins * 0.3, ins * 0.3, h - ins * 0.3, 0, -1, nx); edge(ins * 0.3, h - ins * 0.3, ins * 0.3, ins * 0.3, 1, 0, ny);
    clipped(g, () => polyPath(g, pts), () => {
      const rg = g.createRadialGradient(w * 0.42, h * 0.4, m * 0.1, w / 2, h / 2, Math.max(w, h) * 0.6);
      rg.addColorStop(0, '#d8b688'); rg.addColorStop(0.6, '#b48c5c'); rg.addColorStop(1, '#7a5634');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
      mottle(g, Math.max(w, h), rnd, { colors: ['#c8a478', '#8a6644', '#e0c49c', '#9a7450'], count: 40, rmin: m * 0.05, rmax: m * 0.25, alpha: 0.3, hard: 0.15 });
      for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) for (let k = 0; k < 4; k++) line(g, [[px, py], [px + (w / 2 - px) * range(rnd, 0.3, 0.5) + (rnd() - 0.5) * m * 0.3, py + (h / 2 - py) * range(rnd, 0.3, 0.5)]], range(rnd, 2, 4), '#7a5634', 0.25);
      signText(g, lines, ins * 2.2, ins * 1.8, w - ins * 4.4, h - ins * 3.6, { mode: 'burnt', track: 0.05, wob: 1.6 });
      for (let i = 0; i < 8; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 8, 30), range(rnd, 6, 18), 0, '#4a2a14', 0.15, 0.3);
    });
    g.save(); g.lineWidth = 4; g.strokeStyle = rgba('#3a2010', 0.85); polyPath(g, pts); g.stroke(); g.restore();
    for (let k = 0; k < pts.length; k += 2) { const [px, py] = pts[k], dx = w / 2 - px, dy = h / 2 - py, l = Math.hypot(dx, dy); ellipse(g, px + dx / l * ins * 0.6, py + dy / l * ins * 0.6, 3.5, 3.5, 0, '#1e1008'); line(g, [[px + dx / l * ins * 0.6, py + dy / l * ins * 0.6], [px - dx / l * 3, py - dy / l * 3]], 2.2, '#c8b088', 0.9); }
    return cv;
  }
  if (style === 'goblin') {
    fill(g, w, h, '#2a2018');
    const fr = m * 0.14;
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#f8e098'], [0.25, '#c8963c'], [0.6, '#e8c870'], [1, '#6a4818']]); g.beginPath(); g.roundRect(0, 0, w, h, fr * 0.5); g.fill();
    for (let i = 0; i < 20; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 6, 20), range(rnd, 3, 8), 0, '#6a8a5a', 0.3, 0.3);
    const panel = () => { g.beginPath(); g.roundRect(fr, fr, w - 2 * fr, h - 2 * fr, fr * 0.3); };
    clipped(g, panel, () => {
      g.fillStyle = grad(g, 0, fr, 0, h - fr, [[0, '#1a3e3a'], [0.5, '#1e4a46'], [1, '#143430']]); g.fillRect(0, 0, w, h);
      for (let i = 0; i < 26; i++) blob(g, fr + rnd() * (w - 2 * fr), fr + rnd() * (h - 2 * fr), range(rnd, 10, 40), range(rnd, 8, 24), 0, pick(rnd, ['#24564f', '#123430', '#2a5e56']), 0.4, 0.15);
      // half-gears peeking in from the ends of the panel
      for (const gx of [fr, w - fr]) {
        g.save(); g.translate(gx, h / 2); const R = (h - 2 * fr) * 0.42;
        for (let k = 0; k < 12; k++) { g.rotate(TAU / 12); g.fillStyle = '#8a6a2c'; g.fillRect(-R * 0.12, -R * 1.2, R * 0.24, R * 0.3); }
        g.fillStyle = grad(g, -R, -R, R, R, [[0, '#d8b060'], [1, '#6a4a1e']]); g.beginPath(); g.arc(0, 0, R * 0.95, 0, TAU); g.fill();
        g.fillStyle = '#1e4a46'; g.beginPath(); g.arc(0, 0, R * 0.4, 0, TAU); g.fill();
        g.restore();
      }
      g.fillStyle = grad(g, 0, fr, 0, fr + 14, [[0, INK, 0.6], [1, INK, 0]]); g.fillRect(fr, fr, w - 2 * fr, 14);
    });
    g.save(); g.strokeStyle = '#d8b060'; g.lineWidth = Math.max(2, m * 0.012); g.beginPath(); g.roundRect(fr * 1.2, fr * 1.2, w - fr * 2.4, h - fr * 2.4, fr * 0.2); g.stroke(); g.restore();
    for (let x = fr * 0.5; x < w; x += fr * 0.9) { rivet(g, x, fr * 0.5, Math.max(2.5, fr * 0.13), '#e0b860'); rivet(g, x, h - fr * 0.5, Math.max(2.5, fr * 0.13), '#e0b860'); }
    signText(g, lines, fr * 2.4 + h * 0.2, fr * 1.15, w - fr * 4.8 - h * 0.4, h - fr * 2.3, { mode: 'paint', gold: true, shadow: '#3a0e08', track: 0.06, wob: 0.8 });
    glaze(g, w, h, '#ffe0b0', 0.08, 'soft-light');
    return cv;
  }
  if (style === 'plaque') {
    fill(g, w, h, '#3a2a14');
    g.fillStyle = grad(g, 0, 0, w, h, [[0, '#f0d080'], [0.35, '#c8963c'], [0.7, '#b08030'], [1, '#6a4818']]); g.beginPath(); g.roundRect(0, 0, w, h, m * 0.08); g.fill();
    for (let i = 0; i < 30; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 6, 26), range(rnd, 4, 12), 0, rnd() < 0.6 ? '#6a8a5a' : '#fff0b8', 0.25, 0.25);
    const fr = m * 0.1;
    g.save(); g.strokeStyle = '#4a3410'; g.lineWidth = 3; g.beginPath(); g.roundRect(fr, fr, w - 2 * fr, h - 2 * fr, fr * 0.5); g.stroke();
    g.strokeStyle = rgba('#fff0b0', 0.7); g.lineWidth = 1.5; g.beginPath(); g.roundRect(fr + 2, fr + 2.5, w - 2 * fr, h - 2 * fr, fr * 0.5); g.stroke(); g.restore();
    for (const [x, y] of [[fr * 0.5, fr * 0.5], [w - fr * 0.5, fr * 0.5], [fr * 0.5, h - fr * 0.5], [w - fr * 0.5, h - fr * 0.5]]) { rivet(g, x, y, Math.max(3, fr * 0.22), '#a88848'); line(g, [[x - fr * 0.15, y], [x + fr * 0.15, y]], 1.5, '#3a2810', 0.8); }
    signText(g, lines, fr * 1.4, fr * 1.2, w - fr * 2.8, h - fr * 2.4, { mode: 'engraved', track: 0.08, wob: 0.5 });
    return cv;
  }
  if (style === 'billboard') {
    const n = Math.max(3, Math.round(h / 60));
    boards(n, wood, 0.6);
    const paint = billboardPaint(bg);
    const bd = m * 0.07;
    g.save(); g.globalAlpha = 0.92;
    g.fillStyle = mix(paint, '#e8d8b0', 0.55); g.fillRect(bd * 0.5, bd * 0.5, w - bd, h - bd);
    g.fillStyle = paint; g.fillRect(bd, bd, w - 2 * bd, h - 2 * bd);
    g.restore();
    for (let i = 0; i < 40; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 20, 70), range(rnd, 10, 40), 0, rnd() < 0.5 ? lightOf(paint, 0.25) : shadowOf(paint, 0.25), 0.18, 0.15);
    for (let i = 0; i < n; i++) { const y = i * h / n; line(g, [[0, y], [w, y]], 2.4, '#1e1418', 0.7); line(g, [[0, y + 2.5], [w, y + 2.5]], 1.4, '#fff0d0', 0.18); }
    chips(g, 0, 0, w, h, rnd, Math.round(w * h / 4000));
    const light = paint === '#e6d6b0';
    signText(g, lines, bd * 2.2, bd * 1.6, w - bd * 4.4, h - bd * 3.2, { fg: light ? '#5a2a20' : '#f2e2b8', track: 0.05, wob: 1.2, outline: light ? '#c8b088' : shadowOf(paint, 0.55) });
    chips(g, bd, bd, w - 2 * bd, h - 2 * bd, rnd, Math.round(w * h / 9000), '#8a6a4a');
    streaks(g, Math.max(w, h), rnd, { colors: ['#5a4030'], count: 12, len: [20, 80], width: [2, 6], angle: Math.PI, alpha: 0.12 });
    glaze(g, w, h, '#ffe0b0', 0.1, 'soft-light');
    return cv;
  }
  // 'board' and 'carved': a planked board with a pegged frame
  boards(Math.max(2, Math.round(h / 85)), style === 'carved' ? ['#7a5a3c', '#86643f', '#8a6844', '#7e5e40'] : wood, style === 'carved' ? 0.35 : 0.2);
  const fr = m * 0.1;
  for (const [x, y, ww, hh, v] of [[0, 0, w, fr, false], [0, h - fr, w, fr, false], [0, 0, fr, h, true], [w - fr, 0, fr, h, true]]) plank(g, x, y, ww, hh, '#5a3a24', rnd, { vertical: v, grain: 6, bevel: 3, light: 0.5 });
  g.fillStyle = grad(g, 0, fr, 0, fr + 10, [[0, INK, 0.5], [1, INK, 0]]); g.fillRect(fr, fr, w - 2 * fr, 10);
  g.fillStyle = grad(g, fr, 0, fr + 8, 0, [[0, INK, 0.4], [1, INK, 0]]); g.fillRect(fr, fr, 8, h - 2 * fr);
  for (const [x, y] of [[fr / 2, fr / 2], [w - fr / 2, fr / 2], [fr / 2, h - fr / 2], [w - fr / 2, h - fr / 2]]) nailHead(g, x, y, Math.max(2.5, fr * 0.16), '#4a4448');
  if (style === 'carved') {
    signText(g, lines, fr * 1.3, fr * 1.1, w - fr * 2.6, h - fr * 2.2, { fg: '#f6e8bc', mode: 'carved', track: 0.06 });
  } else {
    const paint = muteColor(bg, { sMax: 0.5, lMin: 0.28, lMax: 0.7 });
    const px = fr * 1.25, py = fr * 1.2, pw = w - px * 2, ph = h - py * 2;
    g.save();
    g.beginPath(); g.roundRect(px, py, pw, ph, fr * 0.3); g.clip();
    g.globalAlpha = 0.94; g.fillStyle = paint; g.fillRect(px, py, pw, ph); g.globalAlpha = 1;
    for (let i = 0; i < 26; i++) blob(g, px + rnd() * pw, py + rnd() * ph, range(rnd, 14, 50), range(rnd, 8, 30), 0, rnd() < 0.5 ? lightOf(paint, 0.25) : shadowOf(paint, 0.25), 0.2, 0.15);
    const n = Math.max(2, Math.round(h / 85));
    for (let i = 1; i < n; i++) { const y = i * h / n; line(g, [[0, y], [w, y]], 2.2, '#1e1418', 0.55); }
    chips(g, px, py, pw, ph, rnd, Math.round(pw * ph / 2600));
    g.restore();
    // a thin painted keyline just inside the panel
    g.save(); g.strokeStyle = rgba(fgCol(fg), 0.55); g.lineWidth = Math.max(2, m * 0.012); g.beginPath(); g.roundRect(px + fr * 0.25, py + fr * 0.25, pw - fr * 0.5, ph - fr * 0.5, fr * 0.2); g.stroke(); g.restore();
    signText(g, lines, px + fr * 0.4, py + fr * 0.3, pw - fr * 0.8, ph - fr * 0.6, { fg: fgCol(fg), wob: 1.1 });
  }
  streaks(g, Math.max(w, h), rnd, { colors: ['#e8d8b8'], count: 10, len: [6, 22], width: [0.6, 1.2], angle: 1.3, wobble: 0.5, alpha: 0.2 });
  glaze(g, w, h, '#ffe0b0', 0.1, 'soft-light');
  return cv;
}

// gallery samples of each sign style
register('sign_demo_board', { family: F, w: 512, h: 160, note: 'sign sample: painted board', paint(g) { g.drawImage(signCanvas(["HONEST ED'S PAWN", 'WE BUY ANYTHING'], { w: 512, h: 160, bg: '#f4d35e', fg: '#2b2d42' }), 0, 0); } });
register('sign_demo_billboard', { family: F, w: 512, h: 208, note: 'sign sample: roadside billboard', paint(g) { g.drawImage(signCanvas(['SLOPMASTER 9000', 'THE LAST RV YOU WILL EVER NEED'], { w: 512, h: 208, style: 'billboard', bg: '#2e86ab', fg: '#fff' }), 0, 0); } });
register('sign_demo_daub', { family: F, w: 1024, h: 600, note: 'sign sample: the rim code daubed on rock, per biome (meadow, snow, desert, badlands)', paint(g) {
  const cells = [['#86827a', '8297', '#f2ead8', '#2e2622', null], ['#78818e', '3240', '#9a2a22', '#ece4d6', '#3a1a14'], ['#c9a274', '5168', '#7a2a1a', '#efe4cc', null], ['#a8553a', '7406', '#f4ecdc', '#2e2420', null]];
  cells.forEach(([rock, code, paint, primer, edge], i) => {
    const x = (i % 2) * 512, y = Math.floor(i / 2) * 300;
    g.fillStyle = rock; g.fillRect(x, y, 512, 300);
    g.drawImage(signCanvas([code], { w: 512, h: 300, style: 'daub', fg: paint, bg: primer, edge, seed: code }), x, y);
  });
} });
register('sign_demo_carved', { family: F, w: 512, h: 200, note: 'sign sample: carved road sign', paint(g) { g.drawImage(signCanvas(['PAYDIRT', 'POP. 41 · EST. 1971'], { w: 512, h: 200, style: 'carved' }), 0, 0); } });
for (const [st, note] of [['oakgold', 'Goldshire casino: carved oak, gilded'], ['barn', 'Westfall casino: painted on the barn'], ['dwarf', 'Kharanos: rune-knot border'], ['hide', 'canyon outpost: branded hide (alpha)'], ['goblin', 'Gadgetzan: brass marquee'], ['plaque', 'Gadgetzan: brass plaque']]) {
  register('sign_demo_' + st, { family: F, w: 640, h: 170, alpha: st === 'hide', note: 'sign sample: ' + note, paint(g) { g.drawImage(signCanvas(st === 'plaque' ? ['LOST WAGES', 'POP. 41 · EST. 1971'] : ['LUCKY SLOP', 'CASINO · NO CLOCKS'], { w: 640, h: 170, style: st }), 0, 0); } });
}

// ---- quality anchor: Goldshire bridge flagstones ------------------------------------------
register('flagstone', {
  family: 'architecture', size: 512, note: 'anchor: painted flagstones',
  paint(g, s, rnd, h, cv) {
    const rects = rowLayout(s, rnd, { rows: 5, minW: 80, maxW: 190, rowJitter: 0.3 });
    paintRects(g, s, rects, rnd, {
      colors: ['#a59c8d', '#958d80', '#b4aa98', '#9c9387', '#ada392'],
      gap: 5, gapColor: '#4c4348', radius: 8, bevel: 6, light: 0.45, varAmt: 0.09,
      inner(gg, X, Y, w, hh, c, r) {
        for (let i = 0; i < 6; i++) blob(gg, X + r() * w, Y + r() * hh, range(r, 14, 46), range(r, 10, 30), r() * 3, r() < 0.5 ? '#c8bfae' : '#857c72', 0.22, 0.15);
        for (let i = 0; i < 3; i++) blob(gg, X + r() * w, Y + r() * hh, range(r, 3, 7), range(r, 2, 5), r() * 3, '#6f675f', 0.35, 0.4);
      },
    });
    cracks(g, s, rnd, { color: '#3a3238', count: 7, len: [16, 50], width: [0.8, 1.5], alpha: 0.5 });
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c'], count: 14, rmin: 8, rmax: 26, alpha: 0.18, hard: 0.2 });  // a little moss
    glaze(g, s, s, '#ffe2b0', 0.1, 'soft-light');
    blurTile(cv, 0.3);
  },
});
