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
  register, fill, rowLayout, paintRects, mottle, cracks, glaze, blurTile, blob, range, pick, wrap, streaks, ellipse,
  mix, shade, lightOf, shadowOf, jitter, hex, rgba, makeCanvas, rngFrom, hashStr,
} from './core.js';

const F = 'architecture';
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
    wrap(s, x, y, r * 3, (X, Y) => {
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
function shingles(g0, s, rnd, { rows, minW, maxW, colors, gapColor, round = 0.45, light = 0.4, overhang = 0.4, moss = 0, mossCols = ['#6d7a4a', '#5d6b3c'], grain = 0, chips = 0.25, speck = 0 }) {
  // painted twice, stacked, on a 2s-tall canvas; the middle band is a seamless tile
  const off = makeCanvas(s, s * 2), g = off.getContext('2d');
  fill(g, s, s * 2, gapColor);
  const rects = rowLayout(s, rnd, { rows, minW, maxW, rowJitter: 0.12 });
  const byRow = [];
  for (const r of rects) (byRow[r.row] ||= []).push({ ...r, c: jitter(pick(rnd, colors), rnd, 0.09), seed: Math.floor(rnd() * 1e9), drop: range(rnd, -1.5, 3.5), skew: (rnd() - 0.5) * 3 });
  const one = (r, dy) => {
    const rr = rngFrom(r.seed);
    const x = r.x + 1.6, w = r.w - 3.2, y = r.y + dy - r.h * overhang, h = r.h * (1 + overhang) + r.drop;
    const rad = Math.min(w * round, r.h * 0.6);
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

// Straw thatch: courses of straw bundles, each hanging over the one below with a ragged edge.
function thatch(g0, s, rnd, { rows = 5, base = '#5e4628', cols, tips, shadow = 0.45 }) {
  const off = makeCanvas(s, s * 2), g = off.getContext('2d');
  fill(g, s, s * 2, base);
  const H = s / rows;
  const data = [];
  for (let i = 0; i < rows; i++) data.push({ y: i * H, seed: Math.floor(rnd() * 1e9) });
  const course = (d, dy) => {
    const rr = rngFrom(d.seed);
    const y0 = d.y + dy;
    // the course's shadow on the one below
    g.save(); g.globalAlpha = shadow; g.fillStyle = INK; g.filter = 'blur(4px)';
    g.beginPath(); g.moveTo(-8, y0 + H * 1.02);
    for (let x = 0; x <= s + 8; x += 8) g.lineTo(x, y0 + H * (1.02 + 0.06 * Math.sin(x / s * TAU * 5 + d.seed)) + 8);
    g.lineTo(s + 8, y0 + H * 0.7); g.lineTo(-8, y0 + H * 0.7); g.closePath(); g.fill(); g.restore();
    const n = Math.round(s * 2.2);
    for (const [layer, list, a] of [[0, cols.slice(0, 2), 1], [1, cols, 1], [2, tips, 1]]) {
      for (let k = 0; k < n * (layer === 2 ? 0.45 : 0.7); k++) {
        const x = rr() * s, start = y0 - H * 0.35 + rr() * H * 0.45 + layer * H * 0.12;
        const len = H * range(rr, 0.9, 1.35) - layer * H * 0.12, ang = Math.PI + range(rr, -0.12, 0.12), w = range(rr, 1.8, 3.6);
        const c = pick(rr, list), bend = range(rr, -0.12, 0.12);
        const pts = [];
        for (let t = 0; t <= 4; t++) { const u = t / 4, aa = ang + bend * u * u; pts.push([x + Math.sin(aa) * len * u, start - Math.cos(aa) * len * u]); }
        for (const dx of (x < 12 ? [0, s] : x > s - 12 ? [0, -s] : [0])) line(g, pts.map(([u, v]) => [u + dx, v]), w, c, a);
      }
    }
    // a lit sheen across the middle of the course and a binding rod shadow at its top
    g.save(); g.globalAlpha = 0.16; g.fillStyle = grad(g, 0, y0, 0, y0 + H, [[0, '#2a1e14', 0], [0.55, '#fff0c0', 1], [1, '#fff0c0', 0]]); g.fillRect(0, y0, s, H); g.restore();
  };
  for (const dy of [s, 0]) for (let i = rows - 1; i >= 0; i--) course(data[i], dy);
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
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 2, 7);
    wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 0.7, rnd() * 3, '#4a4448', 0.85); blob(g, X + r * 0.4, Y + r * 0.4, r * 0.7, r * 0.4, 0, '#d8d0c0', 0.25, 0.4); });
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
function plasterHole(g, s, rnd, x, y, r, { brick = ['#9a5a3e', '#a8684a', '#8a4e36'], mortar = '#6a5446', plaster }) {
  const seed = Math.floor(rnd() * 1e9);
  wrap(s, x, y, r * 1.6, (X, Y) => {
    const rr = rngFrom(seed), pts = [];
    const n = 11;
    for (let k = 0; k < n; k++) { const th = k / n * TAU; const rad = r * range(rr, 0.6, 1.15); pts.push([X + Math.cos(th) * rad * 1.35, Y + Math.sin(th) * rad * 0.8]); }
    clipped(g, () => polyPath(g, pts), () => {
      g.fillStyle = mortar; g.fillRect(X - r * 2, Y - r * 2, r * 4, r * 4);
      const bh = Math.max(12, r * 0.42), bw = bh * 2.2;
      for (let row = -6; row <= 6; row++) for (let col = -6; col <= 6; col++) {
        const bx = X + col * bw + (row & 1) * bw / 2, by = Y + row * bh;
        const c = jitter(pick(rr, brick), rr, 0.08);
        g.fillStyle = grad(g, bx, by, bx, by + bh, [[0, lightOf(c, 0.25)], [0.5, c], [1, shadowOf(c, 0.3)]]);
        g.beginPath(); g.roundRect(bx + 1.5, by + 1.5, bw - 3, bh - 3, 2); g.fill();
      }
      g.save(); g.translate(5, 5); g.lineWidth = 12; g.strokeStyle = rgba(INK, 0.45); g.filter = 'blur(3px)'; polyPath(g, pts); g.stroke(); g.restore();
    });
    g.save(); g.translate(-1.2, -1.2); g.lineWidth = 3; g.strokeStyle = rgba(shadowOf(plaster, 0.4), 0.55); g.filter = 'blur(0.8px)'; polyPath(g, pts); g.stroke(); g.restore();
    g.save(); g.translate(1.2, 1.4); g.lineWidth = 2.5; g.strokeStyle = rgba(lightOf(plaster, 0.3), 0.45); g.filter = 'blur(0.8px)'; polyPath(g, pts); g.stroke(); g.restore();
  });
}

// ---- wall textures ----------------------------------------------------------------------------------

function plasterPaint(g, s, rnd, cv, holes) {
  {
    fill(g, s, s, '#dccdaa');
    mottle(g, s, rnd, { colors: ['#ecdfbe', '#c8b48c', '#d8c49c', '#e8d8b4', '#bdae92', '#c4b496'], count: 60, rmin: 40, rmax: 150, alpha: 0.5, hard: 0.08 });
    mottle(g, s, rnd, { colors: ['#a89c88', '#b0a488', '#9a9484'], count: 10, rmin: 50, rmax: 120, alpha: 0.16, hard: 0.05 });
    blurTile(cv, 4);
    for (let i = 0; i < 70; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 24, 70), a = range(rnd, -0.6, 0.6), w = range(rnd, 8, 20);
      const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([x + Math.cos(a) * L * t, y + Math.sin(a) * L * t + Math.sin(t * 3) * 4]); }
      const c = rnd() < 0.55 ? '#efe5ca' : '#c4b28c';
      wrap(s, x, y, L + w, (X, Y) => line(g, pts.map(([u, v]) => [u - x + X, v - y + Y]), w, c, 0.1));
    }
    mottle(g, s, rnd, { colors: ['#b8a682', '#a8987a', '#f2e8d0'], count: 260, rmin: 1.5, rmax: 4, alpha: 0.22, hard: 0.6 });
    if (holes) {
      plasterHole(g, s, rnd, s * 0.28, s * 0.3, 46, { plaster: '#ddcfae' });
      plasterHole(g, s, rnd, s * 0.74, s * 0.78, 30, { plaster: '#ddcfae', brick: ['#8e8a80', '#9e988a', '#7e7a72'], mortar: '#5a5048' });
    }
    cracks(g, s, rnd, { color: '#7a6a58', count: 6, len: [18, 60], width: [0.7, 1.3], alpha: 0.4 });
    streaks(g, s, rnd, { colors: ['#a89878', '#b0a080'], count: 18, len: [40, 140], width: [3, 9], angle: Math.PI, wobble: 0.05, alpha: 0.07 });
    glaze(g, s, s, '#fff0d0', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  }
}
register('plaster_cream', { family: F, size: 512, note: 'Goldshire plaster: cream, trowelled, a few cracks and holes showing brick', paint(g, s, rnd, h, cv) { plasterPaint(g, s, rnd, cv, true); } });
register('plaster_inner', { family: F, size: 512, note: 'indoor plaster: the same cream, no holes (they would repeat every tile)', paint(g, s, rnd, h, cv) { plasterPaint(g, s, rnd, cv, false); } });

register('stone_found', {
  family: F, size: 512, note: 'fieldstone foundation: lumpy coursed stones, warm gray, a little moss',
  paint(g, s, rnd, h, cv) {
    rubble(g, s, rnd, { rows: 6, minW: 60, maxW: 170, colors: ['#8e877a', '#9c9484', '#7f796f', '#a39a88', '#8a8577', '#958b7a', '#8c8a86', '#a08a72', '#7a7468'], grout: '#3e3532', light: 0.5, moss: 0.35, rowJitter: 0.45 });
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c', '#4e5a34'], count: 18, rmin: 10, rmax: 30, alpha: 0.14, hard: 0.2 });
    glaze(g, s, s, '#ffe2b0', 0.1, 'soft-light');
    blurTile(cv, 0.5);
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
  family: F, size: 512, note: 'barn boards: faded red paint over gray wood, chipped and streaked',
  paint(g, s, rnd, h, cv) {
    const rects = planks(g, s, rnd, { rows: 8, minL: 180, maxL: 380, vertical: true, colors: ['#8e3a2c', '#9a4432', '#843428', '#a24c38'], gap: 4, gapColor: '#2a1a1c', grain: 9, galpha: 0.3, weather: 0.4, splits: 0.4, nails: 2, knots: 0.2 });
    // paint worn through to the wood along the grain
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 16, 60), w = range(rnd, 5, 14);
      wrap(s, x, y, L, (X, Y) => {
        blob(g, X + 1.5, Y + 2, w * 0.6, L * 0.5, 0, INK, 0.25, 0.4);
        blob(g, X, Y, w * 0.55, L * 0.5, (rnd() - 0.5) * 0.2, '#9a8e7c', 0.75, 0.6);
        blob(g, X - w * 0.15, Y - L * 0.1, w * 0.3, L * 0.35, 0, '#b4a890', 0.5, 0.4);
      });
    }
    streaks(g, s, rnd, { colors: ['#5a2a24', '#c86a50'], count: 30, len: [40, 160], width: [2, 6], angle: Math.PI, wobble: 0.03, alpha: 0.12 });
    glaze(g, s, s, '#ffd8b0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

function granitePaint(g, s, rnd, cv, snow) {
  {
    const rects = rowLayout(s, rnd, { rows: 4, minW: 120, maxW: 250, rowJitter: 0.25 });
    paintRects(g, s, rects, rnd, {
      colors: ['#7c8494', '#8e96a3', '#6f7682', '#868c98', '#7a7f8c'], gap: 7, gapColor: '#363444', radius: 10, bevel: 9, light: 0.5, varAmt: 0.08,
      inner(gg, X, Y, w, hh, c, r) {
        for (let i = 0; i < 6; i++) blob(gg, X + r() * w, Y + r() * hh, range(r, 20, 60), range(r, 12, 34), r() * 3, r() < 0.5 ? lightOf(c, 0.3) : shadowOf(c, 0.3), 0.25, 0.15);
        for (let i = 0; i < 12; i++) { const x = X + r() * w, y = Y + r() * hh; line(gg, [[x, y], [x + range(r, 4, 10), y + range(r, -2, 2)]], 1.1, shadowOf(c, 0.4), 0.35); }
        for (let i = 0; i < 6; i++) ellipse(gg, X + r() * w, Y + r() * hh, range(r, 1, 2.4), range(r, 1, 2), 0, rgba('#e8e4f0', 0.5));
      },
    });
    if (snow) for (const r of rects) {
      const x = r.x + 4, w = r.w - 8, y = r.y + 3.5;
      const seed = Math.floor(rnd() * 1e9);
      wrapRect(s, x, y - 2, w, 12, (dx, dy) => {
        const rr = rngFrom(seed);
        g.save(); g.fillStyle = '#f2f6fa';
        g.beginPath(); g.moveTo(x + dx, y + dy);
        for (let k = 0; k <= 12; k++) g.lineTo(x + dx + w * k / 12, y + dy + range(rr, 2, 7) * (k > 0 && k < 12 ? 1 : 0.3));
        g.lineTo(x + dx + w, y + dy - 1); g.closePath(); g.fill(); g.restore();
        blob(g, x + dx + w / 2, y + dy + 6, w * 0.5, 2.5, 0, '#a8b8d0', 0.35, 0.3);
      });
    }
    cracks(g, s, rnd, { color: '#2e2c3a', count: 6, len: [20, 60], width: [0.8, 1.5], alpha: 0.45 });
    mottle(g, s, rnd, { colors: ['#9aa8a0', '#8a9a8a'], count: 14, rmin: 8, rmax: 22, alpha: 0.12, hard: 0.3 });
    glaze(g, s, s, '#dce8ff', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  }
}
register('granite_block', { family: F, size: 512, note: 'Kharanos ashlar: big blue-gray granite blocks, chisel marks, snow on the ledges', paint(g, s, rnd, h, cv) { granitePaint(g, s, rnd, cv, true); } });
register('granite_inner', { family: F, size: 512, note: 'indoor ashlar: no snow', paint(g, s, rnd, h, cv) { granitePaint(g, s, rnd, cv, false); } });

register('log_wall', {
  family: F, size: 512, note: 'frontier log wall: peeled horizontal logs, round-shaded, mud chinking',
  paint(g, s, rnd, h, cv) {
    const rows = 7, H = s / rows;
    fill(g, s, s, '#8e7254');
    mottle(g, s, rnd, { colors: ['#a08262', '#7a5e44', '#968060'], count: 120, rmin: 3, rmax: 10, alpha: 0.5, hard: 0.4 });
    const per = (k, a, ph) => x => a * Math.sin(TAU * k * x / s + ph);
    for (let i = 0; i < rows; i++) {
      const y0 = i * H, c = jitter(pick(rnd, ['#8a5a36', '#7e5232', '#94643c', '#86583a']), rnd, 0.06);
      const top = per(1 + Math.floor(rnd() * 2), range(rnd, 1, 3), rnd() * TAU), bot = per(2, range(rnd, 1, 2.5), rnd() * TAU);
      const yT = x => y0 + 6 + top(x), yB = x => y0 + H - 5 + bot(x);
      // shadow cast onto the chinking below the log
      g.save(); g.globalAlpha = 0.45; g.fillStyle = INK; g.filter = 'blur(3px)';
      g.beginPath(); g.moveTo(-32, yB(-32)); for (let x = -32; x <= s + 32; x += 16) g.lineTo(x, yB(x) + 5); g.lineTo(s + 32, yB(s + 32) - 6); g.lineTo(-32, yB(-32) - 6); g.closePath(); g.fill(); g.restore();
      const body = () => { g.beginPath(); g.moveTo(0, yT(0)); for (let x = 0; x <= s; x += 16) g.lineTo(x, yT(x)); for (let x = s; x >= 0; x -= 16) g.lineTo(x, yB(x)); g.closePath(); };
      clipped(g, body, () => {
        g.fillStyle = grad(g, 0, y0, 0, y0 + H, [[0, lightOf(c, 0.55)], [0.25, lightOf(c, 0.2)], [0.55, c], [0.85, shadowOf(c, 0.45)], [1, shadowOf(c, 0.65)]]);
        g.fillRect(0, y0, s, H);
        for (let k = 0; k < 16; k++) {
          const x = rnd() * s, y = y0 + range(rnd, 0.2, 0.85) * H, L = range(rnd, 30, 140);
          wrap(s, x, y, L, (X, Y) => blob(g, X, Y, L, range(rnd, 2, 7), 0, rnd() < 0.5 ? '#5a3c26' : lightOf(c, 0.3), 0.3, 0.2));
        }
        for (let k = 0; k < 9; k++) {
          const y = y0 + range(rnd, 0.25, 0.8) * H, k1 = 2 + Math.floor(rnd() * 4), ph = rnd() * TAU, a = range(rnd, 0.5, 2);
          const pts = []; for (let x = 0; x <= s; x += 8) pts.push([x, y + Math.sin(TAU * k1 * x / s + ph) * a]);
          line(g, pts, range(rnd, 0.7, 1.6), rnd() < 0.7 ? shadowOf(c, 0.5) : lightOf(c, 0.4), 0.35);
        }
        // a long check (crack) along the log
        const cy = y0 + range(rnd, 0.35, 0.6) * H, cx = rnd() * s, L = range(rnd, 80, 200);
        wrap(s, cx, cy, L, (X, Y) => { line(g, [[X, Y + 1.2], [X + L, Y + 2.2]], 2.2, lightOf(c, 0.5), 0.35); line(g, [[X, Y], [X + L * 0.5, Y + 1.5], [X + L, Y + 1]], 1.6, INK, 0.6); });
        // weathered gray patches where the bark came off unevenly
        for (let k = 0; k < 3; k++) {
          const x = rnd() * s, y = y0 + H * range(rnd, 0.3, 0.6), L = range(rnd, 30, 90);
          wrap(s, x, y, L, (X, Y) => blob(g, X, Y, L, H * 0.18, 0, '#a09484', 0.18, 0.2));
        }
      });
    }
    glaze(g, s, s, '#ffd8a8', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  },
});

register('planks_rough', {
  family: F, size: 512, note: 'frontier boards: wide, horizontal, sun-baked orange-brown, split and nailed',
  paint(g, s, rnd, h, cv) {
    planks(g, s, rnd, { rows: 7, minL: 300, maxL: 560, colors: ['#9a6a42', '#8a5c3a', '#a87a4e', '#7e5636', '#94683e', '#a07450'], gap: 5, gapColor: '#241816', rowJitter: 0.45, grain: 16, weather: 0.5, splits: 0.7, nails: 4, knots: 0.45, endShade: 0.2 });
    glaze(g, s, s, '#ffd8a0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

function adobePaint(g, s, rnd, cv, holes) {
  {
    fill(g, s, s, '#d0a676');
    mottle(g, s, rnd, { colors: ['#e0bc8e', '#bc8e60', '#d8b080', '#c4966a', '#e6c89c', '#b48a64'], count: 56, rmin: 40, rmax: 150, alpha: 0.5, hard: 0.08 });
    blurTile(cv, 4);
    for (let i = 0; i < 60; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 30, 80), a = range(rnd, -0.4, 0.4), w = range(rnd, 10, 24);
      const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([x + Math.cos(a) * L * t, y + Math.sin(a) * L * t + Math.sin(t * 3) * 5]); }
      const c = rnd() < 0.5 ? '#e8c89c' : '#b88c60';
      wrap(s, x, y, L + w, (X, Y) => line(g, pts.map(([u, v]) => [u - x + X, v - y + Y]), w, c, 0.09));
    }
    mottle(g, s, rnd, { colors: ['#a87c52', '#f0d8b0', '#b8885c'], count: 320, rmin: 1.5, rmax: 4, alpha: 0.24, hard: 0.6 });
    if (holes) {
      plasterHole(g, s, rnd, s * 0.3, s * 0.68, 48, { plaster: '#d0a676', brick: ['#a87650', '#b88458', '#9a6a46'], mortar: '#7a5838' });
      plasterHole(g, s, rnd, s * 0.8, s * 0.22, 30, { plaster: '#d0a676', brick: ['#a87650', '#b88458', '#9a6a46'], mortar: '#7a5838' });
    }
    cracks(g, s, rnd, { color: '#6a4628', count: 9, len: [20, 70], width: [0.8, 1.6], alpha: 0.45 });
    streaks(g, s, rnd, { colors: ['#a07850', '#8a6644'], count: 22, len: [50, 160], width: [3, 10], angle: Math.PI, wobble: 0.05, alpha: 0.08 });
    glaze(g, s, s, '#ffe0b0', 0.14, 'soft-light');
    blurTile(cv, 0.6);
  }
}
register('adobe', { family: F, size: 512, note: 'Gadgetzan adobe: warm tan mud plaster, soft blotches, cracks, exposed mud bricks', paint(g, s, rnd, h, cv) { adobePaint(g, s, rnd, cv, true); } });
register('adobe_inner', { family: F, size: 512, note: 'indoor adobe: no exposed bricks', paint(g, s, rnd, h, cv) { adobePaint(g, s, rnd, cv, false); } });

// ---- roofs ----------------------------------------------------------------------------------

register('shingles_red', {
  family: F, size: 512, note: 'Goldshire roof: red-brown wooden shingles, staggered, rounded butts, a little moss',
  paint(g, s, rnd, h, cv) {
    shingles(g, s, rnd, { rows: 8, minW: 46, maxW: 92, colors: ['#9a3a2a', '#b0472f', '#8a3326', '#a8503a', '#963e2c', '#b85a3e'], gapColor: '#2e1a1e', round: 0.42, grain: 3, moss: 0.12 });
    mottle(g, s, rnd, { colors: ['#c8704c', '#6e2a22', '#a0603c'], count: 30, rmin: 30, rmax: 90, alpha: 0.12, hard: 0.1 });
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
  family: F, size: 512, note: 'Westfall thatch: golden straw courses with ragged hanging edges',
  paint(g, s, rnd, h, cv) {
    thatch(g, s, rnd, { rows: 5, base: '#5a4226', cols: ['#9a7a40', '#a88848', '#8a6a38', '#b49450'], tips: ['#d4b468', '#c8a85c', '#e0c478', '#bc9c54'] });
    glaze(g, s, s, '#ffe0a0', 0.12, 'soft-light');
    blurTile(cv, 0.6);
  },
});

register('snow_roof', {
  family: F, size: 256, note: 'snow on roofs and ledges: soft lumps, icy blue shadows, glints',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e6edf4');
    mottle(g, s, rnd, { colors: ['#f6f8fa', '#d4dfec', '#c8d6e8', '#fbfaf4'], count: 30, rmin: 20, rmax: 70, alpha: 0.45, hard: 0.1 });
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 10, 30);
      wrap(s, x, y, r * 1.6, (X, Y) => { blob(g, X + r * 0.3, Y + r * 0.35, r, r * 0.6, 0, '#a9bcd8', 0.35, 0.2); blob(g, X - r * 0.2, Y - r * 0.2, r * 0.8, r * 0.5, 0, '#ffffff', 0.6, 0.25); });
    }
    for (let i = 0; i < 70; i++) { const x = rnd() * s, y = rnd() * s; ellipse(g, x, y, range(rnd, 0.6, 1.4), range(rnd, 0.6, 1.4), 0, '#ffffff', 0.9); }
    glaze(g, s, s, '#e8f0ff', 0.12, 'soft-light');
    blurTile(cv, 0.8);
  },
});

register('hide_patch', {
  family: F, size: 512, note: 'frontier roofing: stretched hides sewn edge to edge, pale where they stretch thin, stitched seams, lacing holes',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a3e28');
    const rects = rowLayout(s, rnd, { rows: 3, minW: 150, maxW: 280, rowJitter: 0.35 });
    for (const r of rects) {
      const seed = Math.floor(rnd() * 1e9);
      const c = pick(rnd, ['#9a7450', '#a8845c', '#8a6442', '#b8966c', '#94704c', '#c4a47a']);
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
        g.setLineDash([6, 5]); g.lineWidth = 2.2; g.strokeStyle = rgba('#ead8b0', 0.7); polyPath(g, pts); g.stroke();
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
  family: F, size: 256, note: 'dark oak beams and posts: grain along v, splits, knots',
  paint(g, s, rnd, h, cv) {
    grainTile(g, s, rnd, { base: '#5a3e2c', dark: ['#3a281e', '#432e22', '#2e2026'], lite: ['#7a5a40', '#86664a'], lines: 40, splits: 4, knots: 2 });
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
  family: F, size: 128, note: 'dark wrought iron: hammered, rust blooms, lit scratches',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#46444c');
    mottle(g, s, rnd, { colors: ['#58565e', '#38363e', '#64626c'], count: 24, rmin: 6, rmax: 22, alpha: 0.55, hard: 0.2 });
    mottle(g, s, rnd, { colors: ['#7a4630', '#8e5232', '#6a3a28'], count: 12, rmin: 3, rmax: 10, alpha: 0.5, hard: 0.35 });
    streaks(g, s, rnd, { colors: ['#9a98a4', '#b0aeb8'], count: 14, len: [5, 16], width: [0.6, 1.1], angle: 1.2, wobble: 0.3, alpha: 0.45 });
    blurTile(cv, 0.5);
  },
});

register('brass', {
  family: F, size: 256, note: 'goblin brass: brushed, warm highlights, green patina, rivets',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#b08a3c');
    mottle(g, s, rnd, { colors: ['#c8a050', '#8a6a2c', '#d8b860', '#a07a34'], count: 30, rmin: 14, rmax: 50, alpha: 0.45, hard: 0.1, stretch: 2.5, rot: 0 });
    streaks(g, s, rnd, { colors: ['#e8cc78', '#7a5a24'], count: 90, len: [20, 90], width: [0.6, 1.4], angle: Math.PI / 2, wobble: 0.02, alpha: 0.3 });
    mottle(g, s, rnd, { colors: ['#5a8a6a', '#6a9a78'], count: 14, rmin: 3, rmax: 10, alpha: 0.28, hard: 0.3 });
    for (let i = 0; i < 6; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 30, (X, Y) => blob(g, X, Y, range(rnd, 10, 26), range(rnd, 3, 6), -0.5, '#fff0b8', 0.35, 0.3)); }
    for (let k = 0; k < 8; k++) for (const y of [10, s / 2 + 10]) rivet(g, (k + 0.5) * s / 8, y, 3.2, '#c8a050');
    line(g, [[0, 2], [s, 2]], 3, '#6a4e22', 0.5); line(g, [[0, s / 2 + 2], [s, s / 2 + 2]], 3, '#6a4e22', 0.5);
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

register('canvas_stripe', {
  family: F, size: 256, note: 'awning canvas: faded red and cream stripes along v, sagging folds, stains',
  paint(g, s, rnd, h, cv) {
    const n = 8, W = s / n;
    for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#e0d2b2' : '#a8463a'; g.fillRect(i * W, 0, W, s); }
    mottle(g, s, rnd, { colors: ['#f0e4c8', '#8a6a50', '#c8b490'], count: 30, rmin: 10, rmax: 40, alpha: 0.18, hard: 0.1 });
    for (let k = 0; k < 4; k++) {
      const y = (k + 0.5) * s / 4 + range(rnd, -6, 6);
      g.fillStyle = grad(g, 0, y - 18, 0, y + 18, [[0, '#2a2030', 0], [0.5, '#2a2030', 0.16], [0.6, '#fff4dc', 0.16], [1, '#fff4dc', 0]]);
      g.fillRect(0, y - 18, s, 36);
    }
    for (let i = 0; i < n; i++) line(g, [[i * W, 0], [i * W, s]], 1.2, '#5a3a30', 0.35);
    streaks(g, s, rnd, { colors: ['#7a5a40'], count: 8, len: [20, 60], width: [3, 7], angle: Math.PI, wobble: 0.1, alpha: 0.12 });
    glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
    blurTile(cv, 0.6);
  },
});

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
  family: F, size: 512, note: 'gambling hall carpet: deep red with a gold diamond lattice and coin medallions',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7a2226');
    mottle(g, s, rnd, { colors: ['#8a2a2c', '#6a1c22', '#842830'], count: 40, rmin: 20, rmax: 80, alpha: 0.4, hard: 0.1 });
    const P = 128;
    // fine damask dots
    for (let y = 16; y < s; y += 32) for (let x = 16 + ((y / 32) & 1) * 16; x < s; x += 32) ellipse(g, x, y, 2.2, 2.2, 0, '#9a3a34', 0.6);
    for (const dir of [1, -1]) for (let k = -4; k <= 8; k++) {
      const pts = dir > 0 ? [[k * P - 10, -10], [k * P + s + 10, s + 10]] : [[k * P + 10, -10], [k * P - s - 10, s + 10]];
      line(g, pts.map(([x, y]) => [x + 1.5, y + 2]), 10, '#3a0e14', 0.55);
      line(g, pts, 7, '#b88a3c', 1);
      line(g, pts.map(([x, y]) => [x - 1, y - 1.2]), 2.2, '#f0d088', 0.7);
    }
    const centers = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { centers.push([64 + 128 * i, 128 * j]); centers.push([128 * i, 64 + 128 * j]); }
    for (const [x, y] of centers) wrap(s, x, y, 30, (X, Y) => {
      for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; ellipse(g, X + Math.cos(a) * 15, Y + Math.sin(a) * 15, 9, 5, a, '#5a1418', 0.9); ellipse(g, X + Math.cos(a) * 15, Y + Math.sin(a) * 15, 7, 3.5, a, '#c89a48', 0.9); }
      ellipse(g, X + 1.5, Y + 2, 12, 12, 0, '#3a0e14', 0.5);
      ellipse(g, X, Y, 11, 11, 0, '#c49440');
      ellipse(g, X, Y, 7.5, 7.5, 0, '#8a6424');
      blob(g, X - 3, Y - 3.5, 5, 4, 0, '#ffe8a0', 0.7, 0.4);
    });
    for (let y = 0; y < s; y += P) for (let x = 0; x < s; x += P) wrap(s, x, y, 8, (X, Y) => { ellipse(g, X, Y, 6, 6, 0, '#3a0e14', 0.7); ellipse(g, X, Y, 4, 4, 0, '#d8b060'); });
    mottle(g, s, rnd, { colors: ['#4a1418', '#a04a40'], count: 26, rmin: 20, rmax: 70, alpha: 0.12, hard: 0.1 });
    glaze(g, s, s, '#ffd0a0', 0.1, 'soft-light');
    blurTile(cv, 0.8);
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

// a row of goods on shelves (two shelves per tile), tiling across
function shelfTile(g, W, H, rnd, cv, items) {
  planks(g, W, rnd, { rows: 4, minL: 200, maxL: 512, colors: ['#4e3424', '#563a28', '#48301f'], gap: 2, gapColor: '#1e1418', grain: 6, galpha: 0.25, knots: 0.2, bevel: 2, light: 0.25 });
  // planks() fills a W×W square; we only keep the top W×H
  const shelfY = [H * 0.47, H * 0.97];
  g.fillStyle = grad(g, 0, 0, 0, H, [[0, '#120c14', 0.45], [0.47, '#120c14', 0], [0.5, '#120c14', 0.45], [0.97, '#120c14', 0]]); g.fillRect(0, 0, W, H);
  for (const sy of shelfY) {
    const top = sy - H * 0.47;
    // goods standing on this shelf
    let x = rnd() * 20;
    while (x < W - 10) {
      const it = pick(rnd, items), w = it.w * range(rnd, 0.85, 1.15), hh = it.h * range(rnd, 0.85, 1.15);
      const cx = x + w / 2, by = sy - 6;
      if (by - hh > top + 4) {
        for (const dx of (cx - w < 0 ? [0, W] : cx + w > W ? [0, -W] : [0])) {
          blob(g, cx + dx + w * 0.25, by, w * 0.7, 5, 0, '#120c14', 0.6, 0.3);
          it.draw(g, cx + dx, by, w, hh, rnd);
        }
      }
      x += w + range(rnd, 2, 14);
    }
    // the shelf board
    g.fillStyle = grad(g, 0, sy - 6, 0, sy + 6, [[0, '#a07048'], [0.4, '#7a5234'], [1, '#3e2a20']]);
    g.fillRect(0, sy - 6, W, 12);
    line(g, [[0, sy - 5.5], [W, sy - 5.5]], 1.4, '#d8a870', 0.7);
    g.fillStyle = grad(g, 0, sy + 6, 0, sy + 18, [[0, '#120c14', 0.55], [1, '#120c14', 0]]); g.fillRect(0, sy + 6, W, Math.min(12, H - sy - 6));
  }
}
// goods painters: (g, cx, bottomY, w, h, rnd), lit from the upper left
function vessel(col, neck = 0.35, shoulder = 0.6) {
  return (g, x, y, w, h, rnd) => {
    const c = jitter(col, rnd, 0.1), pts = [];
    const prof = [[0, 0.32], [0.08, 0.45], [shoulder * 0.6, 0.5], [shoulder, 0.42], [0.82, neck * 0.5], [0.92, neck * 0.45], [1, neck * 0.6]];
    for (const [t, r] of prof) pts.push([x - r * w, y - t * h]);
    for (const [t, r] of prof.slice().reverse()) pts.push([x + r * w, y - t * h]);
    clipped(g, () => polyPath(g, pts), () => {
      g.fillStyle = grad(g, x - w / 2, 0, x + w / 2, 0, [[0, lightOf(c, 0.3)], [0.35, lightOf(c, 0.15)], [0.7, c], [1, shadowOf(c, 0.55)]]);
      g.fillRect(x - w, y - h - 2, w * 2, h + 4);
      blob(g, x - w * 0.18, y - h * 0.45, w * 0.12, h * 0.2, 0, '#fff4d8', 0.55, 0.3);
      if (rnd() < 0.6) { g.fillStyle = rgba(shadowOf(c, 0.4), 0.6); g.fillRect(x - w, y - h * 0.6, w * 2, h * 0.07); }
    });
  };
}
const book = (g, x, y, w, h, rnd) => {
  let bx = x - w / 2;
  for (let i = 0; i < 4; i++) {
    const bw = w / 4 - 1, bh = h * range(rnd, 0.75, 1), c = pick(rnd, ['#6a2a2a', '#2e4a6a', '#4a5a2a', '#7a5a2a', '#5a2a4a']);
    g.fillStyle = grad(g, bx, 0, bx + bw, 0, [[0, lightOf(c, 0.3)], [0.5, c], [1, shadowOf(c, 0.4)]]); g.fillRect(bx, y - bh, bw, bh);
    g.fillStyle = '#d8b868'; g.fillRect(bx, y - bh * 0.8, bw, 2); g.fillRect(bx, y - bh * 0.25, bw, 2);
    bx += bw + 1;
  }
};
const crtBox = (g, x, y, w, h) => {
  g.fillStyle = grad(g, x - w / 2, 0, x + w / 2, 0, [[0, '#8a7a64'], [1, '#4e4438']]); g.beginPath(); g.roundRect(x - w / 2, y - h, w, h, 4); g.fill();
  g.fillStyle = grad(g, 0, y - h, 0, y, [[0, '#4a6a6a'], [1, '#1a2a2e']]); g.beginPath(); g.roundRect(x - w * 0.4, y - h * 0.85, w * 0.6, h * 0.62, 6); g.fill();
  blob(g, x - w * 0.22, y - h * 0.7, w * 0.12, h * 0.1, -0.4, '#d8f0e8', 0.5, 0.3);
  ellipse(g, x + w * 0.32, y - h * 0.6, 2.5, 2.5, 0, '#c8a050'); ellipse(g, x + w * 0.32, y - h * 0.4, 2.5, 2.5, 0, '#c8a050');
};
const lute = (g, x, y, w, h) => {
  ellipse(g, x + 1.5, y - h * 0.28 + 2, w * 0.5, h * 0.3, 0, '#120c14', 0.4);
  ellipse(g, x, y - h * 0.28, w * 0.5, h * 0.3, 0, '#a8703c');
  blob(g, x - w * 0.15, y - h * 0.36, w * 0.25, h * 0.14, 0, '#e8b878', 0.6, 0.3);
  ellipse(g, x, y - h * 0.3, w * 0.12, w * 0.12, 0, '#2a1a14');
  g.fillStyle = '#5a3a24'; g.fillRect(x - w * 0.07, y - h, w * 0.14, h * 0.48);
  g.fillStyle = '#3a2418'; g.fillRect(x - w * 0.12, y - h, w * 0.24, h * 0.1);
};
const goblet = (g, x, y, w, h) => {
  const c = '#c8a048';
  g.fillStyle = grad(g, x - w / 2, 0, x + w / 2, 0, [[0, '#f0d080'], [0.5, c], [1, '#6a4e1e']]);
  g.beginPath(); g.moveTo(x - w * 0.5, y - h); g.lineTo(x + w * 0.5, y - h); g.quadraticCurveTo(x + w * 0.45, y - h * 0.45, x + w * 0.08, y - h * 0.4);
  g.lineTo(x + w * 0.08, y - h * 0.1); g.lineTo(x + w * 0.35, y); g.lineTo(x - w * 0.35, y); g.lineTo(x - w * 0.08, y - h * 0.1); g.lineTo(x - w * 0.08, y - h * 0.4);
  g.quadraticCurveTo(x - w * 0.45, y - h * 0.45, x - w * 0.5, y - h); g.fill();
  blob(g, x - w * 0.22, y - h * 0.8, w * 0.1, h * 0.12, 0, '#fff8d8', 0.8, 0.4);
};
const skull = (g, x, y, w, h) => {
  ellipse(g, x, y - h * 0.58, w * 0.5, h * 0.42, 0, '#d8ccb0');
  g.fillStyle = '#c8bc9c'; g.fillRect(x - w * 0.3, y - h * 0.3, w * 0.6, h * 0.3);
  blob(g, x - w * 0.18, y - h * 0.75, w * 0.2, h * 0.15, 0, '#fff8e8', 0.7, 0.3);
  ellipse(g, x - w * 0.18, y - h * 0.5, w * 0.12, h * 0.1, 0, '#2a2030'); ellipse(g, x + w * 0.18, y - h * 0.5, w * 0.12, h * 0.1, 0, '#2a2030');
  blob(g, x + w * 0.25, y - h * 0.4, w * 0.25, h * 0.35, 0, '#6a6070', 0.35, 0.3);
};
const helm = (g, x, y, w, h) => {
  g.fillStyle = grad(g, x - w / 2, 0, x + w / 2, 0, [[0, '#c8ccd4'], [0.5, '#8a8e98'], [1, '#3e4048']]);
  g.beginPath(); g.moveTo(x - w * 0.5, y); g.lineTo(x - w * 0.5, y - h * 0.5); g.quadraticCurveTo(x, y - h * 1.15, x + w * 0.5, y - h * 0.5); g.lineTo(x + w * 0.5, y); g.closePath(); g.fill();
  g.fillStyle = '#2a2030'; g.fillRect(x - w * 0.35, y - h * 0.45, w * 0.7, h * 0.08);
  g.fillStyle = '#c8a050'; g.fillRect(x - w * 0.04, y - h * 0.95, w * 0.08, h * 0.9);
};
const chest = (g, x, y, w, h) => {
  g.fillStyle = grad(g, 0, y - h, 0, y, [[0, '#9a6a3a'], [1, '#4e3220']]); g.fillRect(x - w / 2, y - h * 0.7, w, h * 0.7);
  g.fillStyle = grad(g, 0, y - h, 0, y - h * 0.7, [[0, '#b07a44'], [1, '#6a4428']]); g.beginPath(); g.ellipse(x, y - h * 0.7, w / 2, h * 0.3, 0, Math.PI, 0); g.fill();
  g.fillStyle = '#c8a050'; g.fillRect(x - w / 2, y - h * 0.72, w, 3); g.fillRect(x - 3, y - h * 0.8, 6, 9);
};
const sack = col => (g, x, y, w, h, rnd) => {
  const c = jitter(col, rnd, 0.08);
  g.fillStyle = grad(g, x - w / 2, 0, x + w / 2, 0, [[0, lightOf(c, 0.25)], [0.6, c], [1, shadowOf(c, 0.5)]]);
  g.beginPath(); g.moveTo(x - w * 0.45, y); g.quadraticCurveTo(x - w * 0.6, y - h * 0.6, x - w * 0.2, y - h * 0.85); g.lineTo(x - w * 0.12, y - h);
  g.lineTo(x + w * 0.14, y - h); g.lineTo(x + w * 0.22, y - h * 0.85); g.quadraticCurveTo(x + w * 0.6, y - h * 0.6, x + w * 0.45, y); g.closePath(); g.fill();
  line(g, [[x - w * 0.22, y - h * 0.82], [x + w * 0.24, y - h * 0.82]], 2.5, '#5a3a24', 0.8);
  line(g, [[x - w * 0.2, y - h * 0.5], [x + w * 0.1, y - h * 0.3]], 1, shadowOf(c, 0.4), 0.5);
};
const loaf = (g, x, y, w, h) => {
  ellipse(g, x, y - h * 0.45, w * 0.5, h * 0.45, 0, '#a8682c');
  blob(g, x - w * 0.12, y - h * 0.62, w * 0.3, h * 0.2, 0, '#e8b064', 0.8, 0.3);
  for (let k = -1; k <= 1; k++) line(g, [[x + k * w * 0.18 - 3, y - h * 0.75], [x + k * w * 0.18 + 3, y - h * 0.5]], 2, '#6a3a1c', 0.7);
};
const potion = col => (g, x, y, w, h) => {
  ellipse(g, x, y - h * 0.32, w * 0.5, h * 0.32, 0, shadowOf(col, 0.3));
  ellipse(g, x - w * 0.04, y - h * 0.34, w * 0.42, h * 0.27, 0, col);
  blob(g, x - w * 0.18, y - h * 0.44, w * 0.12, h * 0.1, 0, '#ffffff', 0.8, 0.4);
  g.fillStyle = '#a8c8c8'; g.fillRect(x - w * 0.1, y - h * 0.85, w * 0.2, h * 0.25);
  g.fillStyle = '#8a5a34'; g.fillRect(x - w * 0.13, y - h, w * 0.26, h * 0.16);
};
const cheese = (g, x, y, w, h) => {
  g.fillStyle = grad(g, 0, y - h, 0, y, [[0, '#f0c860'], [1, '#b08a30']]); g.beginPath(); g.ellipse(x, y - h * 0.5, w / 2, h / 2, 0, 0, TAU); g.fill();
  g.fillStyle = '#e8d080'; g.beginPath(); g.moveTo(x, y - h * 0.5); g.lineTo(x + w / 2, y - h * 0.62); g.lineTo(x + w / 2, y - h * 0.38); g.closePath(); g.fill();
};
const coil = (g, x, y, w, h) => {
  for (let k = 0; k < 4; k++) { g.save(); g.lineWidth = 3.5; g.strokeStyle = k % 2 ? '#b89a68' : '#c8aa78'; g.beginPath(); g.ellipse(x, y - h * 0.5 + k * 1.2, w * 0.45 - k * 2, h * 0.42 - k, 0, 0, TAU); g.stroke(); g.restore(); }
  line(g, [[x - w * 0.3, y - h * 0.7], [x + w * 0.2, y - h * 0.25]], 1.2, '#5a4426', 0.5);
};

register('shelf_goods', {
  family: F, w: 512, h: 256, note: 'pawn shop shelves: vases, books, a lute, goblets, a skull, a helm, a CRT, a chest (tiles across)',
  paint(g, s, rnd, H, cv) {
    shelfTile(g, 512, H, rnd, cv, [
      { w: 34, h: 70, draw: vessel('#4a6a8a') }, { w: 40, h: 62, draw: vessel('#a8603a', 0.45, 0.5) }, { w: 50, h: 60, draw: book },
      { w: 44, h: 96, draw: lute }, { w: 26, h: 44, draw: goblet }, { w: 34, h: 34, draw: skull }, { w: 44, h: 52, draw: helm },
      { w: 66, h: 56, draw: crtBox }, { w: 58, h: 46, draw: chest }, { w: 30, h: 58, draw: vessel('#6a8a5a', 0.3, 0.7) },
    ]);
    glaze(g, 512, H, '#ffd8a8', 0.12, 'soft-light');
  },
});

register('store_goods', {
  family: F, w: 512, h: 256, note: 'general store shelves: jars, sacks, bread, potions, cheese, rope (tiles across)',
  paint(g, s, rnd, H, cv) {
    shelfTile(g, 512, H, rnd, cv, [
      { w: 30, h: 48, draw: vessel('#c8b8a0', 0.7, 0.6) }, { w: 46, h: 64, draw: sack('#b09a6e') }, { w: 54, h: 30, draw: loaf },
      { w: 26, h: 46, draw: potion('#b83a2c') }, { w: 26, h: 46, draw: potion('#3a6ab0') }, { w: 26, h: 46, draw: potion('#4a9a3a') },
      { w: 52, h: 34, draw: cheese }, { w: 50, h: 44, draw: coil }, { w: 34, h: 54, draw: vessel('#7a5a3a', 0.4, 0.55) }, { w: 44, h: 58, draw: sack('#9a8458') },
    ]);
    glaze(g, 512, H, '#ffd8a8', 0.12, 'soft-light');
  },
});

// ---- pieces ------------------------------------------------------------------------------------

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
    glaze(g, s, s, '#ffe0b0', 0.1, 'soft-light');
  },
});

register('coin_face', {
  family: F, size: 128, note: 'the big gold coin: rim, a goblin grin and a $',
  paint(g, s, rnd) {
    const c = s / 2;
    const rg = g.createRadialGradient(c - 20, c - 20, 4, c, c, c); rg.addColorStop(0, '#fff0a8'); rg.addColorStop(0.55, '#d8a840'); rg.addColorStop(1, '#7a5418');
    g.fillStyle = rg; g.fillRect(0, 0, s, s);
    g.save(); g.lineWidth = 5; g.strokeStyle = '#8a6420'; g.beginPath(); g.arc(c, c, c - 9, 0, TAU); g.stroke(); g.restore();
    for (let k = 0; k < 28; k++) { const a = k / 28 * TAU; ellipse(g, c + Math.cos(a) * (c - 4), c + Math.sin(a) * (c - 4), 2, 2, 0, '#fff0b0', 0.8); }
    g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `bold 64px Georgia, 'Liberation Serif', serif`;
    g.fillStyle = '#6a4818'; g.fillText('$', c + 2, c + 4); g.fillStyle = '#ffe890'; g.fillText('$', c, c + 1); g.restore();
  },
});

function padRug(g, s, rnd, { field, border, text, fg }) {
  const c = s / 2;
  fill(g, s, s, border);
  const ring = (r, col) => { ellipse(g, c, c, r, r, 0, col); };
  ring(c, '#d8c090'); ring(c - 8, border); ring(c - 22, '#d8b868'); ring(c - 28, field);
  for (let k = 0; k < 24; k++) { const a = k / 24 * TAU; ellipse(g, c + Math.cos(a) * (c - 15), c + Math.sin(a) * (c - 15), 4, 4, 0, '#e8d090'); }
  for (let i = 0; i < 30; i++) blob(g, c + (rnd() - 0.5) * s * 0.6, c + (rnd() - 0.5) * s * 0.6, range(rnd, 10, 30), range(rnd, 8, 20), 0, rnd() < 0.5 ? lightOf(field, 0.2) : shadowOf(field, 0.2), 0.25, 0.2);
  g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 70; g.font = `bold ${size}px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`;
  while (g.measureText(text).width > s * 0.66) { size -= 3; g.font = `bold ${size}px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`; }
  g.fillStyle = rgba(INK, 0.55); g.fillText(text, c + 3, c + 5);
  g.fillStyle = fg; g.fillText(text, c, c + 2); g.restore();
  for (let y = 0; y < s; y += 3) line(g, [[0, y], [s, y]], 0.7, '#2a2030', 0.05);
}
register('pad_hit', { family: F, size: 256, note: 'round rug: HIT', paint(g, s, rnd) { padRug(g, s, rnd, { field: '#8e2e28', border: '#3a2430', text: 'HIT', fg: '#f4e2b4' }); } });
register('pad_stand', { family: F, size: 256, note: 'round rug: STAND', paint(g, s, rnd) { padRug(g, s, rnd, { field: '#2e4a7a', border: '#2a2438', text: 'STAND', fg: '#f4e2b4' }); } });

register('banner_red', {
  family: F, w: 128, h: 256, alpha: true, note: 'hanging banner: red cloth, gold border, coin emblem, swallowtail',
  paint(g, s, rnd, H) {
    const W = 128;
    const shape = () => { g.beginPath(); g.moveTo(0, 0); g.lineTo(W, 0); g.lineTo(W, H); g.lineTo(W / 2, H * 0.84); g.lineTo(0, H); g.closePath(); };
    clipped(g, shape, () => {
      g.fillStyle = '#8a2224'; g.fillRect(0, 0, W, H);
      for (let k = 0; k < 4; k++) { const x = (k + 0.5) * W / 4; g.fillStyle = grad(g, x - 16, 0, x + 16, 0, [[0, '#2a1020', 0], [0.5, '#2a1020', 0.25], [0.7, '#ffd8b0', 0.12], [1, '#ffd8b0', 0]]); g.fillRect(x - 16, 0, 32, H); }
      g.fillStyle = '#c8a048'; g.fillRect(0, 0, 9, H); g.fillRect(W - 9, 0, 9, H); g.fillRect(0, 0, W, 12);
      ellipse(g, W / 2, H * 0.42, 34, 34, 0, '#6a4818'); ellipse(g, W / 2, H * 0.42, 30, 30, 0, '#d8a840');
      g.save(); g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = 'bold 40px Georgia, serif'; g.fillStyle = '#7a5418'; g.fillText('$', W / 2, H * 0.42 + 2); g.restore();
    });
    g.save(); g.lineWidth = 5; g.strokeStyle = '#c8a048'; g.beginPath(); g.moveTo(W, H); g.lineTo(W / 2, H * 0.84); g.lineTo(0, H); g.stroke(); g.restore();
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
  family: F, size: 256, note: 'crate face: framed planks, a diagonal brace, nails',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#1e1418');
    for (let i = 0; i < 4; i++) plank(g, 0, i * s / 4 + 1, s, s / 4 - 2, jitter(pick(rnd, ['#9a7448', '#8a663e', '#a47e50']), rnd, 0.06), rnd, { grain: 6, bevel: 3 });
    g.save(); g.translate(s / 2, s / 2); g.rotate(-Math.PI / 4);
    g.fillStyle = rgba(INK, 0.45); g.fillRect(-s * 0.7, -14, s * 1.4, 34); g.restore();
    g.save(); g.translate(s / 2, s / 2); g.rotate(-Math.PI / 4); plank(g, -s * 0.7, -18, s * 1.4, 32, '#a8845a', rnd, { grain: 5, bevel: 3 }); g.restore();
    const fr = 26;
    for (const [x, y, w, hh, v] of [[0, 0, s, fr, false], [0, s - fr, s, fr, false], [0, 0, fr, s, true], [s - fr, 0, fr, s, true]]) plank(g, x, y, w, hh, '#b08a5e', rnd, { vertical: v, grain: 5, bevel: 3 });
    for (const [x, y] of [[13, 13], [s - 13, 13], [13, s - 13], [s - 13, s - 13]]) nailHead(g, x, y, 3);
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
  family: F, size: 128, note: 'brazier coals: dark lumps with glowing orange cracks (emissive)',
  paint(g, s, rnd) {
    fill(g, s, s, '#ff8a30');
    for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 6, 14); wrap(s, x, y, r, (X, Y) => { ellipse(g, X, Y, r, r * 0.8, rnd() * 3, '#3a2a26'); blob(g, X - r * 0.3, Y - r * 0.3, r * 0.5, r * 0.4, 0, '#6a4a3a', 0.6, 0.4); }); }
    for (let i = 0; i < 30; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 4, 10), range(rnd, 3, 8), 0, pick(rnd, ['#ffd070', '#ff9a40', '#fff0b0']), 0.6, 0.4);
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

// ---- signs ---------------------------------------------------------------------------------------

export const SIGN_FONT = `Georgia, 'Palatino Linotype', 'Book Antiqua', Palatino, 'Liberation Serif', 'DejaVu Serif', serif`;

// Lines of text fitted into a box (x, y, w, h), first line bigger. Each line is painted with a
// soft dark drop shadow (lower right) and a warm lit edge (upper left), so it reads as painted or
// carved into the board rather than printed.
function signText(g, lines, x, y, w, h, { fg = '#f2e2b8', shadow = INK, lit = '#fff4d0', carved = false, gold = false, track = 0.04 } = {}) {
  const n = lines.length;
  const weights = lines.map((_, i) => (i === 0 ? 1 : 0.62));
  const tot = weights.reduce((a, b) => a + b, 0);
  let yy = y;
  g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
  lines.forEach((ln, i) => {
    const lh = h * weights[i] / tot;
    let size = Math.floor(lh * 0.86);
    const font = () => `bold ${size}px ${SIGN_FONT}`;
    g.font = font();
    g.letterSpacing = `${Math.round(size * track)}px`;
    while (g.measureText(ln).width > w * 0.93 && size > 8) { size -= 1; g.font = font(); g.letterSpacing = `${Math.round(size * track)}px`; }
    const cy = yy + lh / 2 + size * 0.04, cx = x + w / 2, o = Math.max(1.5, size * 0.05);
    if (carved) {
      g.fillStyle = rgba(lit, 0.5); g.fillText(ln, cx + o * 0.6, cy + o * 0.8);
      g.fillStyle = shadowOf(fg, 0.1); g.fillText(ln, cx, cy);
      g.fillStyle = rgba(INK, 0.55); g.fillText(ln, cx - o * 0.25, cy - o * 0.35);
    } else {
      g.save(); g.filter = `blur(${Math.max(1, o * 0.6)}px)`; g.fillStyle = rgba(shadow, 0.6); g.fillText(ln, cx + o, cy + o * 1.3); g.restore();
      if (gold) {
        g.fillStyle = '#5a3a14'; g.fillText(ln, cx + o * 0.5, cy + o * 0.6);
        g.fillStyle = grad(g, 0, cy - size / 2, 0, cy + size / 2, [[0, '#fff0b0'], [0.45, '#e8c060'], [0.55, '#c8962c'], [1, '#f0c860']]);
        g.fillText(ln, cx, cy);
      } else {
        g.fillStyle = rgba(lit, 0.45); g.fillText(ln, cx - o * 0.4, cy - o * 0.4);
        g.fillStyle = fg; g.fillText(ln, cx, cy);
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

// Paint a sign face. style: 'board' (painted panel on a planked board), 'carved' (letters cut into
// bare wood), 'gilded' (the casino: gold frame, red panel, gold letters), 'billboard' (big painted
// roadside boards), 'daub' (paint on rock, transparent). Returns a canvas of w×h.
export function signCanvas(lines, { w = 512, h = 256, bg = '#c9a24a', fg = '#f2e2b8', style = 'board', seed = '' } = {}) {
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
    const col = fgCol(fg) === '#2a1e18' ? '#3a2a24' : '#f2ede2';
    g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
    let size = Math.floor(h * 0.62); g.font = `bold ${size}px ${SIGN_FONT}`;
    while (g.measureText(lines[0]).width > w * 0.86) { size -= 2; g.font = `bold ${size}px ${SIGN_FONT}`; }
    for (let k = 0; k < 9; k++) { g.globalAlpha = 0.22; g.fillStyle = col; g.fillText(lines[0], w / 2 + (rnd() - 0.5) * size * 0.06, h / 2 + (rnd() - 0.5) * size * 0.06); }
    g.globalAlpha = 0.8; g.fillText(lines[0], w / 2, h / 2);
    g.restore();
    const tw = g.measureText(lines[0]).width;
    for (let k = 0; k < 9; k++) { const x = w / 2 + (rnd() - 0.5) * tw * 0.9, y0 = h / 2 + size * 0.3, L = range(rnd, 8, h * 0.28); line(g, [[x, y0], [x + (rnd() - 0.5) * 2, y0 + L]], range(rnd, 2, 5), col, 0.7); ellipse(g, x, y0 + L, 3.5, 4, 0, col, 0.7); }
    return cv;
  }
  if (style === 'gilded') {
    boards(Math.max(2, Math.round(h / 90)), ['#5a3a24', '#4e3220']);
    const fr = m * 0.12;
    // gilded frame
    g.fillStyle = grad(g, 0, 0, w, h, [[0, '#f8e098'], [0.3, '#c8963c'], [0.55, '#f0d080'], [1, '#6a4818']]);
    g.beginPath(); g.roundRect(fr * 0.25, fr * 0.25, w - fr * 0.5, h - fr * 0.5, fr * 0.5); g.fill();
    for (let x = fr; x < w - fr; x += fr * 0.7) { ellipse(g, x, fr * 0.6, fr * 0.16, fr * 0.16, 0, '#fff4c0', 0.7); ellipse(g, x, h - fr * 0.6, fr * 0.16, fr * 0.16, 0, '#7a5418', 0.7); }
    g.fillStyle = '#4a1418'; g.beginPath(); g.roundRect(fr, fr, w - 2 * fr, h - 2 * fr, fr * 0.3); g.fill();
    for (let i = 0; i < 30; i++) blob(g, fr + rnd() * (w - 2 * fr), fr + rnd() * (h - 2 * fr), range(rnd, 10, 40), range(rnd, 8, 30), 0, pick(rnd, ['#6a1c22', '#3a0e14', '#7a2a2a']), 0.4, 0.15);
    g.save(); g.globalAlpha = 0.18; for (let y = fr + 12; y < h - fr; y += 22) for (let x = fr + 12 + ((y / 22) & 1) * 11; x < w - fr; x += 22) ellipse(g, x, y, 3, 3, 0, '#d8a050'); g.restore();
    g.fillStyle = grad(g, 0, fr, 0, fr + 16, [[0, INK, 0.6], [1, INK, 0]]); g.fillRect(fr, fr, w - 2 * fr, 16);
    signText(g, lines, fr * 1.4, fr * 1.05, w - fr * 2.8, h - fr * 2.1, { gold: true, track: 0.06 });
    glaze(g, w, h, '#ffe0b0', 0.08, 'soft-light');
    return cv;
  }
  if (style === 'billboard') {
    const n = Math.max(3, Math.round(h / 60));
    boards(n, wood, 0.6);
    const paint = muteColor(bg, { sMax: 0.48, lMin: 0.3, lMax: 0.66 });
    const bd = m * 0.07;
    g.save(); g.globalAlpha = 0.92;
    g.fillStyle = mix(paint, '#e8d8b0', 0.55); g.fillRect(bd * 0.5, bd * 0.5, w - bd, h - bd);
    g.fillStyle = paint; g.fillRect(bd, bd, w - 2 * bd, h - 2 * bd);
    g.restore();
    for (let i = 0; i < 40; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 20, 70), range(rnd, 10, 40), 0, rnd() < 0.5 ? lightOf(paint, 0.25) : shadowOf(paint, 0.25), 0.18, 0.15);
    for (let i = 0; i < n; i++) { const y = i * h / n; line(g, [[0, y], [w, y]], 2.4, '#1e1418', 0.7); line(g, [[0, y + 2.5], [w, y + 2.5]], 1.4, '#fff0d0', 0.18); }
    chips(g, 0, 0, w, h, rnd, Math.round(w * h / 4000));
    signText(g, lines, bd * 2.2, bd * 1.6, w - bd * 4.4, h - bd * 3.2, { fg: fgCol(fg), track: 0.05 });
    streaks(g, Math.max(w, h), rnd, { colors: ['#5a4030'], count: 12, len: [20, 80], width: [2, 6], angle: Math.PI, alpha: 0.12 });
    glaze(g, w, h, '#ffe0b0', 0.1, 'soft-light');
    return cv;
  }
  // 'board' and 'carved': a planked board with a pegged frame
  boards(Math.max(2, Math.round(h / 85)));
  const fr = m * 0.1;
  for (const [x, y, ww, hh, v] of [[0, 0, w, fr, false], [0, h - fr, w, fr, false], [0, 0, fr, h, true], [w - fr, 0, fr, h, true]]) plank(g, x, y, ww, hh, '#5a3a24', rnd, { vertical: v, grain: 6, bevel: 3, light: 0.5 });
  g.fillStyle = grad(g, 0, fr, 0, fr + 10, [[0, INK, 0.5], [1, INK, 0]]); g.fillRect(fr, fr, w - 2 * fr, 10);
  g.fillStyle = grad(g, fr, 0, fr + 8, 0, [[0, INK, 0.4], [1, INK, 0]]); g.fillRect(fr, fr, 8, h - 2 * fr);
  for (const [x, y] of [[fr / 2, fr / 2], [w - fr / 2, fr / 2], [fr / 2, h - fr / 2], [w - fr / 2, h - fr / 2]]) nailHead(g, x, y, Math.max(2.5, fr * 0.16), '#4a4448');
  if (style === 'carved') {
    signText(g, lines, fr * 1.3, fr * 1.1, w - fr * 2.6, h - fr * 2.2, { fg: '#3a2418', carved: true, track: 0.06 });
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
    signText(g, lines, px + fr * 0.4, py + fr * 0.3, pw - fr * 0.8, ph - fr * 0.6, { fg: fgCol(fg) });
  }
  streaks(g, Math.max(w, h), rnd, { colors: ['#e8d8b8'], count: 10, len: [6, 22], width: [0.6, 1.2], angle: 1.3, wobble: 0.5, alpha: 0.2 });
  glaze(g, w, h, '#ffe0b0', 0.1, 'soft-light');
  return cv;
}

// gallery samples of each sign style
register('sign_demo_board', { family: F, w: 512, h: 160, note: 'sign sample: painted board', paint(g) { g.drawImage(signCanvas(["HONEST ED'S PAWN", 'WE BUY ANYTHING'], { w: 512, h: 160, bg: '#f4d35e', fg: '#2b2d42' }), 0, 0); } });
register('sign_demo_gilded', { family: F, w: 512, h: 160, note: 'sign sample: gilded casino board', paint(g) { g.drawImage(signCanvas(['LUCKY SLOP', 'CASINO · NO CLOCKS'], { w: 512, h: 160, style: 'gilded' }), 0, 0); } });
register('sign_demo_billboard', { family: F, w: 512, h: 208, note: 'sign sample: roadside billboard', paint(g) { g.drawImage(signCanvas(['SLOPMASTER 9000', 'THE LAST RV YOU WILL EVER NEED'], { w: 512, h: 208, style: 'billboard', bg: '#2e86ab', fg: '#fff' }), 0, 0); } });
register('sign_demo_carved', { family: F, w: 512, h: 200, note: 'sign sample: carved road sign', paint(g) { g.drawImage(signCanvas(['PAYDIRT', 'POP. 41 · EST. 1971'], { w: 512, h: 200, style: 'carved' }), 0, 0); } });

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
