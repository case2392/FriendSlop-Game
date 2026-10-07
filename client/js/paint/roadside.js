// Texture family: roadside (stops, gates, anchors, camp). See docs/ART.md for the style rules.
//
// Everything along the road that isn't nature or a building, painted the way Blizzard's 2004
// artists painted goblin and human junk: riveted painted steel with chipped paint and rust runs,
// corrugated tin, honey and gray planks, dark timber, wrought iron, goblin brass, canvas, cloth.
//
// Tiling (world-space UVs; "tile" = meters per repeat as roadside3d.js maps them):
//   rs_steel_<cream|red|blue|green|teal|mustard>  riveted painted steel plates (2 m)
//   rs_tin, rs_tin_red        corrugated sheet roofing, ribs along v (2 m)
//   rs_planks, rs_planks_gray boards along u (1 m)          rs_timber  dark beam, grain along v (1.5 m)
//   rs_iron (0.5 m)  rs_brass (1 m)  rs_tire (tread, u around)  rs_gingham (0.6 m)  rs_canvas (stripes along u)
//   rs_wing (doped canvas, ribs along v, 1.6 m)  rs_scrap (1.5 m)  rs_stone (1.6 m)  rs_warn (1.6 m)
//   rs_bark (u around, v along)  rs_dino (u along the body; v = 0 belly .. 1 back, from the normal)
//   rs_rv (u 3 m, v fitted to the body height)  rs_fascia (u 2 m, v fitted)
//   rs_snow, rs_dust, rs_sand (drifts and caps)   rs_cover_snow|dust|sand (alpha = breakup noise, for the
//   world-space top-cover shader)   rs_ice (icicles)
// Fitted (one image per face): rs_hub, rs_glass, rs_grille, rs_crate_a|b|c, rs_barrel, rs_barrel_lid,
//   rs_drum, rs_drum_red, rs_pump_face, rs_keypad, rs_logend, rs_rv_window, rs_boards, rs_headlamp
import {
  register, fill, mottle, stroke, pebbles, cracks, glaze, blurTile, range, pick, wrap, blob, ellipse,
  mix, shade, lightOf, shadowOf, jitter, rgba, rngFrom, rowLayout, paintRects, streaks,
} from './core.js';

const F = 'roadside';
const TAU = Math.PI * 2;
const INK = '#2a2030';
const FONT = (px, w = 'bold') => `${w} ${px}px 'Liberation Sans', 'DejaVu Sans', Arial, sans-serif`;
const SERIF = (px) => `bold ${px}px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`;

// ---- small helpers ---------------------------------------------------------------------------

function line(g, pts, w, color, alpha = 1, cap = 'round') {
  g.save();
  g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = w; g.lineCap = cap; g.lineJoin = 'round';
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke(); g.restore();
}
function polyPath(g, pts) { g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); }
function grad(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c, a = 1] of stops) gr.addColorStop(t, rgba(c, a));
  return gr;
}
function wrapRect(s, x, y, w, h, fn, sy = s) {
  const xs = [0], ys = [0];
  if (x < 0) xs.push(s); if (x + w > s) xs.push(-s);
  if (y < 0) ys.push(sy); if (y + h > sy) ys.push(-sy);
  for (const dx of xs) for (const dy of ys) fn(dx, dy);
}
// a seed that is the same for every wrapped copy of a rect
const seedAt = (s, X, Y) => (Math.round(((X % s) + s) % s) * 7919 + Math.round(((Y % s) + s) % s) * 104729) >>> 0;

function rivet(g, x, y, r, base = '#8a8478') {
  blob(g, x + r * 0.5, y + r * 0.65, r * 1.7, r * 1.5, 0, INK, 0.5, 0.25);
  ellipse(g, x, y, r, r, 0, shadowOf(base, 0.35));
  ellipse(g, x - r * 0.12, y - r * 0.12, r * 0.8, r * 0.8, 0, base);
  blob(g, x - r * 0.35, y - r * 0.4, r * 0.5, r * 0.45, 0, lightOf(base, 0.8), 0.9, 0.4);
}
function nail(g, x, y, r = 2.2) {
  blob(g, x + r * 0.5, y + r * 0.6, r * 1.6, r * 1.4, 0, INK, 0.45, 0.3);
  ellipse(g, x, y, r, r, 0, '#5a565a');
  blob(g, x - r * 0.35, y - r * 0.35, r * 0.6, r * 0.55, 0, '#c8c0b4', 0.8, 0.4);
}
// a rust run dripping down from (x, y)
function rustRun(g, s, x, y, len, w, alpha, rnd, sy = s) {
  const pts = [];
  let px = x;
  for (let k = 0; k <= 6; k++) { pts.push([px, y + len * k / 6]); px += (rnd() - 0.5) * 1.6; }
  const draw = (dx, dy) => {
    const p = pts.map(([u, v]) => [u + dx, v + dy]);
    stroke(g, p, w, w * 0.25, '#8a4a26', alpha);
    stroke(g, p.slice(0, 4), w * 0.6, w * 0.2, '#b0642e', alpha * 0.7);
  };
  const xs = [0], ys = [0];
  if (x - w < 0) xs.push(s); if (x + w > s) xs.push(-s);
  if (y + len > sy) ys.push(-sy);
  for (const dx of xs) for (const dy of ys) draw(dx, dy);
}
// a soft dent: shadow on the upper-left inside rim, light on the lower right
function dent(g, s, x, y, r, c, a = 0.5) {
  wrap(s, x, y, r * 1.4, (X, Y) => {
    blob(g, X - r * 0.2, Y - r * 0.25, r, r * 0.75, 0.3, shadowOf(c, 0.45), a * 0.6, 0.15);
    blob(g, X + r * 0.3, Y + r * 0.35, r * 0.65, r * 0.45, 0.3, lightOf(c, 0.4), a * 0.55, 0.2);
  });
}
// chipped paint: primer/metal underneath, a lit lower lip where the paint edge catches the light
function chip(g, s, x, y, r, under, rnd) {
  const pts = [];
  const n = 7;
  for (let k = 0; k < n; k++) { const a = k / n * TAU, rr = r * range(rnd, 0.55, 1.15); pts.push([Math.cos(a) * rr, Math.sin(a) * rr * 0.75]); }
  wrap(s, x, y, r * 1.3, (X, Y) => {
    g.save(); g.translate(X, Y);
    polyPath(g, pts); g.fillStyle = under; g.fill();
    g.globalAlpha = 0.45; g.translate(r * 0.15, r * 0.2); polyPath(g, pts.map(([u, v]) => [u * 0.7, v * 0.7])); g.fillStyle = shadowOf(under, 0.3); g.fill();
    g.restore();
    blob(g, X + r * 0.3, Y + r * 0.6, r * 0.8, r * 0.3, 0, '#fff1c4', 0.18, 0.4);
  });
}

// One painted plank: across-grain gradient lit on the upper/left side, tone blotches, grain, maybe a
// knot and a split, nails, lit/shaded bevels.
function plank(g, X, Y, w, h, c, rnd, o = {}) {
  const { vertical = false, grain = 9, galpha = 0.38, knots = 0.3, bevel = 3, light = 0.42, splits = 0.3, nails = 0, weather = 0 } = o;
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
    blob(g, kx + rx * 0.45, ky + ry * 0.45, rx * 0.6, ry * 0.5, 0, lightOf(c, 0.4), 0.4, 0.4);
  }
  if (rnd() < splits) {
    const t0 = rnd() * L * 0.7, len = range(rnd, 0.15, 0.45) * L, o2 = range(rnd, 0.25, 0.75) * T;
    const p = [];
    for (let k = 0; k <= 6; k++) { const a = t0 + len * k / 6, b = o2 + (rnd() - 0.5) * 1.6; p.push(vertical ? [X + b, Y + a] : [X + a, Y + b]); }
    line(g, p.map(([x, y]) => [x + 0.9, y + 0.9]), 1.7, lightOf(c, 0.5), 0.35);
    line(g, p, 1.3, INK, 0.55);
  }
  for (let i = 0; i < nails; i++) {
    const t = i % 2 ? L - 9 : 9, o2 = T * (nails > 2 ? (i < 2 ? 0.3 : 0.7) : 0.5);
    nail(g, vertical ? X + o2 : X + t, vertical ? Y + t : Y + o2, 2.1);
  }
  g.globalAlpha = 0.55; g.fillStyle = lightOf(c, 0.6); g.fillRect(X, Y, w, bevel); g.fillRect(X, Y, bevel * 0.8, h);
  g.globalAlpha = 0.5; g.fillStyle = shadowOf(c, 0.55); g.fillRect(X, Y + h - bevel, w, bevel); g.fillRect(X + w - bevel * 0.8, Y, bevel * 0.8, h);
  g.restore();
}

// A tiling field of boards (rows along y; vertical:true turns them into boards standing up).
function boards(g, s, rnd, { rows, minL, maxL, colors, gap = 3, gapColor = '#241c22', vertical = false, rowJitter = 0.15, varAmt = 0.07, ...o }) {
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

// Wood grain running along y over the whole tile. Tiles both ways.
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
    wrap(s, x, y, r * 3.5, (X, Y) => {
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

// stencilled / painted lettering with worn patches
function letters(g, text, x, y, { font, color, alpha = 0.85, worn = 0.3, rnd, maxW = null, shadowCol = null, align = 'center', under = null }) {
  g.save();
  g.font = font; g.textAlign = align; g.textBaseline = 'middle';
  let sx = 1;
  if (maxW) { const m = g.measureText(text).width; if (m > maxW) sx = maxW / m; }
  g.translate(x, y); g.scale(sx, 1);
  if (shadowCol) { g.globalAlpha = alpha * 0.5; g.fillStyle = shadowCol; g.fillText(text, 2, 2.5); }
  g.globalAlpha = alpha; g.fillStyle = color; g.fillText(text, 0, 0);
  g.restore();
  // wear: soft lifts of the paint, showing what it was painted on
  if (rnd && worn > 0 && under) {
    g.save(); g.font = font;
    const w = Math.min(maxW || 1e9, g.measureText(text).width);
    g.restore();
    for (let i = 0; i < 12 * worn; i++) {
      const ox = align === 'center' ? x + (rnd() - 0.5) * w : x + rnd() * w;
      blob(g, ox, y + (rnd() - 0.5) * 24, range(rnd, 3, 9), range(rnd, 2, 6), rnd() * 3, under, 0.55, 0.4);
    }
  }
}

// ---- painted steel -----------------------------------------------------------------------------

function paintedSteel(g, s, rnd, cv, { colors, under = '#4a4248', rows = 2, fade = 0.3, rust = 1, dents = 6 }) {
  // panels on a grid: the columns line up from row to row (a trailer's side, not a brick wall)
  const cols = rowLayout(s, rnd, { rows: 1, minW: 64, maxW: 120 });
  const rects = [];
  for (const c of cols) {
    if (rows > 1 && rnd() < 0.5) { const sp = range(rnd, 0.35, 0.65) * s; rects.push({ x: c.x, y: 0, w: c.w, h: sp }, { x: c.x, y: sp, w: c.w, h: s - sp }); }
    else rects.push({ x: c.x, y: 0, w: c.w, h: s });
  }
  paintRects(g, s, rects, rnd, {
    colors, gap: 4, gapColor: '#2a2228', radius: 3, bevel: 5, light: 0.42, varAmt: 0.05,
    inner(gg, X, Y, w, h, c) {
      const r = rngFrom(seedAt(s, X, Y));
      // sun-faded top, grimy bottom of each plate
      gg.fillStyle = grad(gg, 0, Y, 0, Y + h, [[0, lightOf(c, 0.4), fade], [0.45, c, 0], [1, shadowOf(c, 0.35), 0.35]]);
      gg.fillRect(X, Y, w, h);
      for (let i = 0; i < 5; i++) blob(gg, X + r() * w, Y + r() * h, range(r, 10, 34), range(r, 8, 22), r() * 3, r() < 0.5 ? lightOf(c, 0.25) : shadowOf(c, 0.2), 0.25, 0.15);
    },
  });
  // chipped paint
  for (let i = 0; i < 16; i++) chip(g, s, rnd() * s, rnd() * s, range(rnd, 2.5, 7), rnd() < 0.5 ? under : '#6a4a34', rnd);
  // dents
  for (let i = 0; i < dents; i++) dent(g, s, rnd() * s, rnd() * s, range(rnd, 8, 20), colors[0], 0.45);
  // rivet rows along the top and bottom of each plate, a column at each seam; rust runs below some
  for (const r of rects) {
    const n = Math.max(3, Math.round(r.w / 22));
    for (let k = 0; k < n; k++) {
      const x = r.x + 6 + (r.w - 12) * (k + 0.5) / n;
      for (const y of [r.y + 7, r.y + r.h - 8]) {
        wrap(s, x, y, 6, (X, Y) => rivet(g, X, Y, 2.6, '#8a8276'));
        if (rnd() < 0.22 * rust) rustRun(g, s, x, y + 3, range(rnd, 14, 60), range(rnd, 2, 3.6), 0.45, rnd);
      }
    }
  }
  for (const r of rects) for (let y = r.y + 22; y < r.y + r.h - 16; y += 22) wrap(s, r.x + 6, y, 6, (X, Y) => rivet(g, X, Y, 2.2, '#8a8276'));
  // grime gathers low on every panel, the sun bleaches the tops
  g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#fff4dc', 0.12], [0.3, '#fff4dc', 0], [0.7, '#4a3a2c', 0], [1, '#4a3a2c', 0.28]]); g.fillRect(0, 0, s, s);
  // scratches, then a warm glaze
  streaks(g, s, rnd, { colors: ['#e8e0d0', '#c8c0b4'], count: 16, len: [8, 26], width: [0.6, 1.1], angle: 1.3, wobble: 0.4, alpha: 0.3 });
  mottle(g, s, rnd, { colors: ['#8a4a26', '#7a5a3a'], count: 10 * rust, rmin: 6, rmax: 16, alpha: 0.2, hard: 0.25 });
  glaze(g, s, s, '#ffe2b8', 0.1, 'soft-light');
  blurTile(cv, 0.5);
}
const STEEL = {
  cream: ['#d6c8a6', '#cfc09c', '#dccfb0'],
  red: ['#94392a', '#9e4230', '#883426'],
  blue: ['#3e5f8a', '#456894', '#38567e'],
  green: ['#56703e', '#5e7a44', '#4c663a'],
  teal: ['#3e7a78', '#468482', '#376e6c'],
  mustard: ['#c08a34', '#c8943c', '#b47e2e'],
};
for (const [k, colors] of Object.entries(STEEL)) {
  register(`rs_steel_${k}`, { family: F, size: 256, note: `riveted painted steel (${k}): plates, chips, dents, rust runs`, paint(g, s, rnd, h, cv) { paintedSteel(g, s, rnd, cv, { colors }); } });
}

// ---- corrugated tin ----------------------------------------------------------------------------

function tin(g, s, rnd, cv, { base, bare = null, rust = 1 }) {
  fill(g, s, s, base);
  mottle(g, s, rnd, { colors: [lightOf(base, 0.2), shadowOf(base, 0.2)], count: 30, rmin: 20, rmax: 60, alpha: 0.3, hard: 0.1 });
  if (bare) mottle(g, s, rnd, { colors: [bare], count: 14, rmin: 8, rmax: 26, alpha: 0.55, hard: 0.5 });
  // ribs along v: a lit flank (upper-left light) and a shaded flank on each corrugation
  const n = 16, W = s / n;
  for (let i = 0; i < n; i++) {
    const x = i * W;
    g.fillStyle = grad(g, x, 0, x + W, 0, [[0, INK, 0.28], [0.22, '#fff4d8', 0.26], [0.45, '#fff4d8', 0.05], [0.75, INK, 0.12], [1, INK, 0.3]]);
    g.fillRect(x, 0, W, s);
  }
  // sheet laps: the upper sheet's edge casts a soft shadow; nails on the crests
  for (const y0 of [0, s / 2]) {
    const y = y0 + range(rnd, -3, 3);
    g.fillStyle = grad(g, 0, y, 0, y + 10, [[0, INK, 0.45], [1, INK, 0]]); g.fillRect(0, y, s, 10);
    line(g, [[0, y - 1], [s, y - 1]], 1.5, '#fff0d0', 0.3);
    for (let i = 0; i < n; i += 2) {
      const x = i * W + W * 0.3;
      nail(g, x, y - 5, 2);
      if (rnd() < 0.45 * rust) rustRun(g, s, x, y - 3, range(rnd, 14, 50), range(rnd, 2, 4), 0.45, rnd);
    }
  }
  // rust blooms
  for (let i = 0; i < 12 * rust; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 18);
    wrap(s, x, y, r * 1.5, (X, Y) => { blob(g, X, Y, r, r * 0.7, rnd() * 3, '#8a4a26', 0.45, 0.3); blob(g, X - r * 0.2, Y - r * 0.2, r * 0.5, r * 0.35, 0, '#b8682e', 0.35, 0.3); });
  }
  glaze(g, s, s, '#ffe2b8', 0.1, 'soft-light');
  blurTile(cv, 0.6);
}
register('rs_tin', { family: F, size: 256, note: 'galvanized corrugated tin: ribs along v, sheet laps, nails, rust blooms', paint(g, s, rnd, h, cv) { tin(g, s, rnd, cv, { base: '#8e9094' }); } });
register('rs_tin_red', { family: F, size: 256, note: 'barn-red painted corrugated tin, worn to galvanized gray', paint(g, s, rnd, h, cv) { tin(g, s, rnd, cv, { base: '#94402e', bare: '#8a8a8a', rust: 0.8 }); } });

// ---- wood ------------------------------------------------------------------------------------------

register('rs_planks', {
  family: F, size: 256, note: 'honey deck boards along u (floors, tables, ramps, counters)',
  paint(g, s, rnd, h, cv) {
    boards(g, s, rnd, { rows: 4, minL: 150, maxL: 300, colors: ['#9a6a3e', '#a87648', '#8e603a', '#b07e4c'], gap: 4, nails: 2, grain: 10 });
    mottle(g, s, rnd, { colors: ['#5a3a24', '#c89a64'], count: 14, rmin: 10, rmax: 30, alpha: 0.12, hard: 0.2 });
    glaze(g, s, s, '#ffe0b0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});
register('rs_planks_gray', {
  family: F, size: 256, note: 'sun-grayed boards along u (trailer liners, crates, pallets)',
  paint(g, s, rnd, h, cv) {
    boards(g, s, rnd, { rows: 4, minL: 150, maxL: 300, colors: ['#8a7e6c', '#968a76', '#7e7262', '#a09480'], gap: 4, nails: 2, grain: 10, weather: 0.6 });
    glaze(g, s, s, '#ffe8c8', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});
register('rs_timber', {
  family: F, size: 256, note: 'dark heavy timber: posts, beams, gate rails (grain along v)',
  paint(g, s, rnd, h, cv) {
    grainTile(g, s, rnd, { base: '#5e4230', dark: ['#3a281e', '#432e22', '#30222a'], lite: ['#7e5e42', '#8a6a4c'], lines: 40, splits: 5, knots: 2 });
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// ---- metal ----------------------------------------------------------------------------------------

register('rs_iron', {
  family: F, size: 128, note: 'dark wrought iron: hammered, rust blooms, lit scratches',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#4a464c');
    mottle(g, s, rnd, { colors: ['#5c5860', '#3a363e', '#686470'], count: 24, rmin: 6, rmax: 22, alpha: 0.55, hard: 0.2 });
    for (let i = 0; i < 18; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 3, 7); wrap(s, x, y, r * 1.6, (X, Y) => { blob(g, X - r * 0.3, Y - r * 0.3, r, r * 0.8, 0, '#7a7680', 0.35, 0.3); blob(g, X + r * 0.4, Y + r * 0.4, r, r * 0.8, 0, '#2a2630', 0.3, 0.3); }); }
    mottle(g, s, rnd, { colors: ['#7a4630', '#8e5232', '#6a3a28'], count: 12, rmin: 3, rmax: 10, alpha: 0.5, hard: 0.35 });
    streaks(g, s, rnd, { colors: ['#9a98a4', '#b0aeb8'], count: 12, len: [5, 16], width: [0.6, 1.1], angle: 1.2, wobble: 0.3, alpha: 0.4 });
    blurTile(cv, 0.5);
  },
});
register('rs_brass', {
  family: F, size: 256, note: 'goblin brass: brushed, warm highlights, green patina, rivet rows',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#a8843a');
    mottle(g, s, rnd, { colors: ['#c8a050', '#8a6a2c', '#d8b860', '#a07a34'], count: 30, rmin: 14, rmax: 50, alpha: 0.45, hard: 0.1, stretch: 2.5, rot: 0 });
    streaks(g, s, rnd, { colors: ['#e8cc78', '#7a5a24'], count: 90, len: [20, 90], width: [0.6, 1.4], angle: Math.PI / 2, wobble: 0.02, alpha: 0.28 });
    mottle(g, s, rnd, { colors: ['#5a8a6a', '#6a9a78'], count: 16, rmin: 3, rmax: 12, alpha: 0.3, hard: 0.3 });
    for (let i = 0; i < 6; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 30, (X, Y) => blob(g, X, Y, range(rnd, 10, 26), range(rnd, 3, 6), -0.5, '#fff0b8', 0.3, 0.3)); }
    for (const y of [3, s / 2 + 3]) { g.fillStyle = grad(g, 0, y - 3, 0, y + 6, [[0, '#5a4018', 0.6], [0.5, '#5a4018', 0.2], [1, '#fff0c0', 0.25]]); g.fillRect(0, y - 3, s, 9); }
    for (let k = 0; k < 8; k++) for (const y of [12, s / 2 + 12]) rivet(g, (k + 0.5) * s / 8, y, 3.2, '#c8a050');
    blurTile(cv, 0.4);
  },
});

// ---- wheels -----------------------------------------------------------------------------------------

register('rs_tire', {
  family: F, size: 128, note: 'chunky rubber tread (u around the tire, v across it): chevron lugs, dust in the grooves',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#242022');
    const n = 5, W = s / n;
    for (let i = 0; i < n; i++) {
      for (const side of [-1, 1]) {
        const x0 = i * W + (side > 0 ? W * 0.5 : 0), yc = s / 2;
        const pts = [[x0 + 3, yc + side * 5], [x0 + W * 0.62, yc + side * 5], [x0 + W * 0.78, yc + side * (s / 2 - 3)], [x0 + W * 0.1, yc + side * (s / 2 - 3)]];
        wrap(s, x0 + W * 0.4, yc, W, (X) => {
          const q = pts.map(([u, v]) => [u - x0 - W * 0.4 + X, v]);
          polyPath(g, q.map(([u, v]) => [u + 2, v + 3])); g.fillStyle = rgba('#100c0e', 0.6); g.fill();
          polyPath(g, q); g.fillStyle = grad(g, 0, yc - s / 2, 0, yc + s / 2, [[0, '#5a5456'], [0.5, '#4a4446'], [1, '#3a3436']]); g.fill();
          line(g, [q[0], q[1]], 2.5, '#7a7274', 0.6);
          line(g, [q[3], q[0]], 2, '#6a6264', 0.5);
        });
      }
    }
    mottle(g, s, rnd, { colors: ['#6a5a48', '#4a4038'], count: 16, rmin: 4, rmax: 14, alpha: 0.3, hard: 0.2 });
    blurTile(cv, 0.6);
  },
});
function hubFace(g, s, rnd, { rim = '#94392a', cap = '#c8a050', tireEdge = 0.22 }) {
  const c = s / 2;
  fill(g, s, s, '#2e2a2c');
  // sidewall
  const R = c - 1;
  g.fillStyle = (() => { const gr = g.createRadialGradient(c - 10, c - 10, R * 0.3, c, c, R); gr.addColorStop(0, '#4a4446'); gr.addColorStop(0.8, '#3a3436'); gr.addColorStop(1, '#1e1a1c'); return gr; })();
  g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
  for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; line(g, [[c + Math.cos(a) * R * 0.86, c + Math.sin(a) * R * 0.86], [c + Math.cos(a) * R * 0.98, c + Math.sin(a) * R * 0.98]], 2, '#5a5254', 0.5); }
  // painted steel rim
  const r1 = R * (1 - tireEdge);
  g.fillStyle = (() => { const gr = g.createRadialGradient(c - r1 * 0.3, c - r1 * 0.3, r1 * 0.1, c, c, r1); gr.addColorStop(0, lightOf(rim, 0.35)); gr.addColorStop(0.7, rim); gr.addColorStop(1, shadowOf(rim, 0.5)); return gr; })();
  g.beginPath(); g.arc(c, c, r1, 0, TAU); g.fill();
  g.lineWidth = 3; g.strokeStyle = rgba(lightOf(rim, 0.6), 0.6); g.beginPath(); g.arc(c, c, r1 - 3, Math.PI * 1.0, Math.PI * 1.6); g.stroke();
  g.strokeStyle = rgba(INK, 0.5); g.beginPath(); g.arc(c, c, r1 - 3, Math.PI * 0.05, Math.PI * 0.65); g.stroke();
  // vent holes
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + 0.3; ellipse(g, c + Math.cos(a) * r1 * 0.62, c + Math.sin(a) * r1 * 0.62, r1 * 0.13, r1 * 0.1, a, '#1e1a1c'); blob(g, c + Math.cos(a) * r1 * 0.62 + 2, c + Math.sin(a) * r1 * 0.62 + 2, r1 * 0.1, r1 * 0.07, a, lightOf(rim, 0.4), 0.35, 0.4); }
  // chips + rust
  for (let i = 0; i < 8; i++) { const a = rnd() * TAU, d = range(rnd, 0.3, 0.9) * r1; blob(g, c + Math.cos(a) * d, c + Math.sin(a) * d, range(rnd, 2, 6), range(rnd, 2, 4), rnd() * 3, '#7a4026', 0.5, 0.4); }
  // brass hub cap + lug nuts
  const r2 = r1 * 0.36;
  g.fillStyle = (() => { const gr = g.createRadialGradient(c - r2 * 0.4, c - r2 * 0.4, 1, c, c, r2); gr.addColorStop(0, '#f2dc98'); gr.addColorStop(0.5, cap); gr.addColorStop(1, '#6a4e22'); return gr; })();
  g.beginPath(); g.arc(c, c, r2, 0, TAU); g.fill();
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; rivet(g, c + Math.cos(a) * r2 * 1.35, c + Math.sin(a) * r2 * 1.35, 3.2, '#9a9488'); }
  blurTile(g.canvas, 0.4);
}
register('rs_hub', { family: F, size: 128, note: 'wheel face (fitted, circle): rubber sidewall, red steel rim, brass hub cap, lug nuts', paint(g, s, rnd) { hubFace(g, s, rnd, {}); } });
register('rs_hub_cream', { family: F, size: 128, note: 'wheel face: cream rim', paint(g, s, rnd) { hubFace(g, s, rnd, { rim: '#c8b890', cap: '#b8b0a0' }); } });

// ---- glass, grille, lamps ----------------------------------------------------------------------------

register('rs_glass', {
  family: F, size: 128, note: 'dusty windshield glass (fitted): sky reflection streaks, grime at the corners, a crack',
  paint(g, s, rnd) {
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#7a9aa8'], [0.45, '#3e5866'], [1, '#2a3440']]); g.fillRect(0, 0, s, s);
    for (const [x, w] of [[0.18, 0.16], [0.46, 0.06], [0.62, 0.1]]) {
      g.save(); g.globalAlpha = 0.28; g.fillStyle = '#e8f2f0';
      polyPath(g, [[s * x, 0], [s * (x + w), 0], [s * (x + w - 0.35), s], [s * (x - 0.35), s]]); g.fill(); g.restore();
    }
    g.fillStyle = grad(g, 0, s * 0.7, 0, s, [[0, '#8a7a5a', 0], [1, '#8a7a5a', 0.55]]); g.fillRect(0, 0, s, s);
    for (const [x, y] of [[0, 0], [s, 0], [0, s], [s, s]]) blob(g, x, y, s * 0.3, s * 0.3, 0, '#7a6a4a', 0.45, 0.2);
    line(g, [[s * 0.7, s * 0.2], [s * 0.76, s * 0.34], [s * 0.72, s * 0.5], [s * 0.8, s * 0.62]], 1.4, '#e8f0f0', 0.6);
    line(g, [[s * 0.76, s * 0.34], [s * 0.9, s * 0.38]], 1.2, '#e8f0f0', 0.5);
    // a rubber frame
    g.lineWidth = 5; g.strokeStyle = rgba('#2a2428', 0.9); g.strokeRect(2.5, 2.5, s - 5, s - 5);
    blurTile(g.canvas, 0.6);
  },
});
register('rs_grille', {
  family: F, size: 256, note: 'cab-over truck front (fitted): brass-framed grille slats, rivets, a goblin cog badge',
  paint(g, s, rnd) {
    fill(g, s, s, '#2a2228');
    // frame
    g.fillStyle = grad(g, 0, 0, s, s, [[0, '#e0c070'], [0.5, '#b08a3c'], [1, '#6a4e22']]);
    g.fillRect(0, 0, s, s);
    const m = 22;
    g.fillStyle = '#1e1a1e'; g.fillRect(m, m, s - 2 * m, s - 2 * m);
    // slats
    const n = 9;
    for (let i = 0; i < n; i++) {
      const x = m + 4 + i * (s - 2 * m - 8) / n, w = (s - 2 * m - 8) / n - 6;
      g.fillStyle = grad(g, x, 0, x + w, 0, [[0, '#d8c080'], [0.35, '#a8843a'], [1, '#4a3618']]);
      g.fillRect(x, m + 4, w, s - 2 * m - 8);
    }
    // horizontal bar + badge
    g.fillStyle = grad(g, 0, s / 2 - 12, 0, s / 2 + 12, [[0, '#f0d890'], [0.5, '#a8843a'], [1, '#4a3618']]); g.fillRect(m, s / 2 - 12, s - 2 * m, 24);
    const c = s / 2;
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; ellipse(g, c + Math.cos(a) * 26, c + Math.sin(a) * 26, 8, 6, a, '#8a6a2c'); }
    g.fillStyle = (() => { const gr = g.createRadialGradient(c - 8, c - 8, 2, c, c, 26); gr.addColorStop(0, '#f8e8a8'); gr.addColorStop(0.6, '#c8a050'); gr.addColorStop(1, '#5a4018'); return gr; })();
    g.beginPath(); g.arc(c, c, 24, 0, TAU); g.fill();
    ellipse(g, c, c, 9, 9, 0, '#3a2a18');
    for (const [x, y] of [[11, 11], [s - 11, 11], [11, s - 11], [s - 11, s - 11], [c, 11], [c, s - 11]]) rivet(g, x, y, 4, '#c8a050');
    for (let i = 0; i < 8; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 6, 18), range(rnd, 4, 10), rnd() * 3, '#5a8a6a', 0.25, 0.3);
    mottle(g, s, rnd, { colors: ['#6a4a2a'], count: 10, rmin: 6, rmax: 20, alpha: 0.2 });
    blurTile(g.canvas, 0.5);
  },
});
register('rs_headlamp', {
  family: F, size: 64, note: 'a round lamp lens (fitted, circle): warm glass, a lit glint',
  paint(g, s) {
    const c = s / 2;
    fill(g, s, s, '#6a4e22');
    const gr = g.createRadialGradient(c - 8, c - 8, 2, c, c, c);
    gr.addColorStop(0, '#fff8d8'); gr.addColorStop(0.45, '#e8c878'); gr.addColorStop(0.85, '#a87a3a'); gr.addColorStop(1, '#5a4018');
    g.fillStyle = gr; g.beginPath(); g.arc(c, c, c - 2, 0, TAU); g.fill();
    blob(g, c - 9, c - 10, 7, 4, -0.6, '#ffffff', 0.85, 0.4);
  },
});

// ---- cloth ------------------------------------------------------------------------------------------

register('rs_gingham', {
  family: F, size: 256, note: 'red gingham tablecloth: woven checks, soft folds, a few stains',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e4d6b8');
    const n = 8, W = s / n;
    g.save(); g.globalAlpha = 0.5; g.fillStyle = '#a63a30';
    for (let i = 0; i < n; i += 1) { g.fillRect(i * W, 0, W / 2, s); g.fillRect(0, i * W, s, W / 2); }
    g.restore();
    // weave hint along the stripes
    for (let i = 0; i < n; i++) for (let k = 0; k < 32; k++) { line(g, [[i * W + 2, k * 8], [i * W + W / 2 - 2, k * 8 + 2]], 0.8, '#7a2a24', 0.18); }
    // folds: soft diagonal-ish waves of light and shadow
    for (let i = 0; i < 6; i++) {
      const x = rnd() * s, w = range(rnd, 18, 40);
      for (const dx of [-s, 0, s]) {
        g.fillStyle = grad(g, x + dx - w, 0, x + dx + w, 0, [[0, INK, 0], [0.45, INK, 0.18], [0.6, '#fff4dc', 0.2], [1, '#fff4dc', 0]]);
        g.fillRect(x + dx - w, 0, w * 2, s);
      }
    }
    for (let i = 0; i < 5; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 6, 16); wrap(s, x, y, r * 1.5, (X, Y) => blob(g, X, Y, r, r * 0.7, rnd() * 3, '#8a6a40', 0.22, 0.4)); }
    glaze(g, s, s, '#ffe8c8', 0.1, 'soft-light');
    blurTile(cv, 0.7);
  },
});
function canvasStripes(g, s, rnd, cv, cols) {
  const n = 8, W = s / n;
  for (let i = 0; i < n; i++) { g.fillStyle = cols[i % cols.length]; g.fillRect(i * W, 0, W, s); }
  mottle(g, s, rnd, { colors: ['#f0e4c8', '#8a6a50', '#c8b490'], count: 30, rmin: 10, rmax: 40, alpha: 0.18, hard: 0.1 });
  // each panel bellies between the ribs: lit on its left half, shaded on its right
  for (let i = 0; i < n; i++) {
    g.fillStyle = grad(g, i * W, 0, i * W + W, 0, [[0, INK, 0.2], [0.2, '#fff4dc', 0.15], [0.55, '#fff4dc', 0], [1, INK, 0.22]]);
    g.fillRect(i * W, 0, W, s);
    line(g, [[i * W, 0], [i * W, s]], 1.6, '#4a3028', 0.45);
  }
  // stitched hem rows near the bottom (the canopy's edge)
  g.save(); g.setLineDash([5, 4]); line(g, [[0, s - 12], [s, s - 12]], 1.4, '#3a2a24', 0.5); g.restore();
  streaks(g, s, rnd, { colors: ['#7a5a40'], count: 8, len: [20, 60], width: [3, 7], angle: Math.PI, wobble: 0.1, alpha: 0.12 });
  glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
  blurTile(cv, 0.6);
}
register('rs_canvas', { family: F, size: 256, note: 'faded red/cream market-umbrella canvas: stripes along u, bellied panels, hem', paint(g, s, rnd, h, cv) { canvasStripes(g, s, rnd, cv, ['#a8463a', '#e0d2b2']); } });
register('rs_canvas_blue', { family: F, size: 256, note: 'faded blue/cream canvas', paint(g, s, rnd, h, cv) { canvasStripes(g, s, rnd, cv, ['#3e5a7e', '#e0d2b2']); } });

// ---- the crashed flying machine -------------------------------------------------------------------------

register('rs_wing', {
  family: F, size: 256, note: 'doped canvas over wing ribs (ribs along v): rib tapes, sag, patches, scorch, tears',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#c8a868');
    mottle(g, s, rnd, { colors: ['#d8bc80', '#b8945a', '#c09c60'], count: 40, rmin: 14, rmax: 50, alpha: 0.35, hard: 0.1 });
    const n = 4, W = s / n;
    for (let i = 0; i < n; i++) {
      const x = i * W;
      // fabric sags between the ribs
      g.fillStyle = grad(g, x, 0, x + W, 0, [[0, '#fff0c8', 0.25], [0.18, '#fff0c8', 0.05], [0.6, INK, 0.12], [0.9, INK, 0.2], [1, '#fff0c8', 0.2]]);
      g.fillRect(x, 0, W, s);
      // rib tape with stitching
      g.fillStyle = grad(g, x - 4, 0, x + 4, 0, [[0, '#dcc690', 0.8], [0.5, '#e8d6a6', 0.8], [1, '#a88a58', 0.8]]); g.fillRect(x - 4, 0, 8, s);
      g.save(); g.setLineDash([3, 5]); line(g, [[x - 2.5, 0], [x - 2.5, s]], 0.8, '#7a6040', 0.35); line(g, [[x + 2.5, 0], [x + 2.5, s]], 0.8, '#7a6040', 0.35); g.restore();
    }
    for (const dx of [-s, s]) { g.fillStyle = grad(g, dx - 4, 0, dx + 4, 0, [[0, '#dcc690', 0.8], [0.5, '#e8d6a6', 0.8], [1, '#a88a58', 0.8]]); g.fillRect(dx - 4, 0, 8, s); }
    // repair patches
    for (let i = 0; i < 3; i++) {
      const x = rnd() * s, y = rnd() * s, w = range(rnd, 22, 40), hh = range(rnd, 18, 34), c = pick(rnd, ['#a87a4a', '#d8c8a0', '#8a6a48']);
      wrapRect(s, x, y, w, hh, (dx, dy) => {
        g.save(); g.translate(x + dx, y + dy); g.rotate(range(rnd, -0.15, 0.15));
        g.fillStyle = INK; g.globalAlpha = 0.3; g.fillRect(2, 3, w, hh);
        g.globalAlpha = 1; g.fillStyle = grad(g, 0, 0, w, hh, [[0, lightOf(c, 0.25)], [1, shadowOf(c, 0.2)]]); g.fillRect(0, 0, w, hh);
        g.setLineDash([3, 3]); g.strokeStyle = rgba('#3a2a1c', 0.7); g.lineWidth = 1; g.strokeRect(3, 3, w - 6, hh - 6);
        g.restore();
      });
    }
    // scorch and oil
    for (let i = 0; i < 5; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 14, 36); wrap(s, x, y, r * 1.4, (X, Y) => { blob(g, X, Y, r, r * 0.8, rnd() * 3, '#3a2a24', 0.4, 0.15); blob(g, X, Y, r * 0.5, r * 0.4, rnd() * 3, '#1e1618', 0.4, 0.3); }); }
    streaks(g, s, rnd, { colors: ['#4a3a30'], count: 10, len: [20, 70], width: [2, 5], angle: Math.PI / 2, wobble: 0.15, alpha: 0.18 });
    // tears: dark holes, frayed lit edges
    for (let i = 0; i < 2; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 8, 16);
      const pts = []; for (let k = 0; k < 9; k++) { const a = k / 9 * TAU, rr = r * range(rnd, 0.4, 1.2); pts.push([Math.cos(a) * rr * 1.4, Math.sin(a) * rr * 0.7]); }
      wrap(s, x, y, r * 2, (X, Y) => {
        g.save(); g.translate(X, Y); polyPath(g, pts); g.fillStyle = '#1e1618'; g.fill();
        g.lineWidth = 2; g.strokeStyle = rgba('#f0dca8', 0.6); g.stroke(); g.restore();
      });
    }
    glaze(g, s, s, '#ffe0b0', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});

// ---- junk: crates, barrels, drums, scrap ----------------------------------------------------------------

function crateFace(g, s, rnd, { woods, frame, text, sub = null, ink = '#2a2228', mark = null, band = null }) {
  fill(g, s, s, '#1e1418');
  for (let i = 0; i < 4; i++) plank(g, 0, i * s / 4 + 1, s, s / 4 - 2, jitter(pick(rnd, woods), rnd, 0.06), rnd, { grain: 7, bevel: 3 });
  // a painted band behind the lettering, then the lettering, all under the frame
  if (band) { g.fillStyle = grad(g, 0, s * 0.3, 0, s * 0.72, [[0, lightOf(band, 0.2)], [1, shadowOf(band, 0.2)]]); g.globalAlpha = 0.85; g.fillRect(0, s * 0.3, s, s * 0.42); g.globalAlpha = 1; for (let i = 0; i < 8; i++) blob(g, rnd() * s, range(rnd, 0.3, 0.72) * s, range(rnd, 4, 12), range(rnd, 3, 8), rnd() * 3, woods[0], 0.6, 0.4); }
  if (text) letters(g, text, s / 2, s * (sub ? 0.44 : 0.5), { font: FONT(text.length > 4 ? 50 : 70), color: ink, alpha: 0.8, worn: 0.6, rnd, maxW: s * 0.7, under: woods[0] });
  if (sub) letters(g, sub, s / 2, s * 0.64, { font: FONT(24), color: ink, alpha: 0.75, worn: 0.4, rnd, maxW: s * 0.62, under: woods[0] });
  if (mark) mark(g, s);
  const fr = 26;
  for (const [x, y, w, hh, v] of [[0, 0, s, fr, false], [0, s - fr, s, fr, false], [0, 0, fr, s, true], [s - fr, 0, fr, s, true]]) plank(g, x, y, w, hh, jitter(frame, rnd, 0.05), rnd, { vertical: v, grain: 5, bevel: 3 });
  for (const [x, y] of [[13, 13], [s - 13, 13], [13, s - 13], [s - 13, s - 13], [s / 2, 13], [s / 2, s - 13]]) nail(g, x, y, 3);
  // grime at the bottom, a lit top
  g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#fff0c8', 0.12], [0.4, '#fff0c8', 0], [0.8, INK, 0], [1, INK, 0.3]]); g.fillRect(0, 0, s, s);
  glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
  blurTile(g.canvas, 0.4);
}
register('rs_crate_a', { family: F, size: 256, note: 'crate face (fitted): honey planks, frame, stencil GOBLIN CO.', paint(g, s, rnd) {
  crateFace(g, s, rnd, { woods: ['#9a7448', '#8a663e', '#a47e50'], frame: '#b08a5e', text: 'GOBLIN', sub: 'CO. · THIS WAY UP' });
} });
register('rs_crate_b', { family: F, size: 256, note: 'crate face (fitted): gray planks, red stencil FRAGILE', paint(g, s, rnd) {
  crateFace(g, s, rnd, { woods: ['#8a806e', '#7e7464', '#968a76'], frame: '#a09480', text: 'FRAGILE', sub: 'HANDLE W/ CARE', ink: '#8e2e24' });
} });
register('rs_crate_c', { family: F, size: 256, note: 'crate face (fitted): dark planks, TNT in red with a skull-and-fuse mark', paint(g, s, rnd) {
  crateFace(g, s, rnd, { woods: ['#7a5232', '#6e4a2e', '#86603a'], frame: '#94704a', text: 'TNT', sub: 'NO SMOKING', ink: '#a8302a',
    band: '#e0d0a8', mark(g, s) { g.save(); g.globalAlpha = 0.75; line(g, [[s * 0.72, s * 0.24], [s * 0.8, s * 0.18], [s * 0.86, s * 0.2]], 3, '#2a2228'); g.restore(); blob(g, s * 0.87, s * 0.19, 7, 7, 0, '#e8a040', 0.8, 0.5); } });
} });

register('rs_barrel', {
  family: F, size: 256, note: 'wooden barrel side (fitted: u around, v top→bottom): staves, two pairs of iron hoops',
  paint(g, s, rnd) {
    const n = 10, W = s / n;
    fill(g, s, s, '#1e1418');
    for (let i = 0; i < n; i++) plank(g, i * W + 1, 0, W - 2, s, jitter(pick(rnd, ['#7a5232', '#86603a', '#6e4a2e', '#8e6840']), rnd, 0.06), rnd, { vertical: true, grain: 6, bevel: 2, knots: 0.2, light: 0.2 });
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, INK, 0.45], [0.2, INK, 0], [0.75, INK, 0], [1, INK, 0.5]]); g.fillRect(0, 0, s, s);
    for (const y of [s * 0.08, s * 0.22, s * 0.78, s * 0.92]) {
      g.fillStyle = grad(g, 0, y - 8, 0, y + 8, [[0, '#8a8690'], [0.35, '#5a5660'], [1, '#26222c']]); g.fillRect(0, y - 8, s, 16);
      for (let k = 0; k < n; k++) rivet(g, (k + 0.5) * W, y, 2.4, '#6a6670');
      for (let k = 0; k < 4; k++) blob(g, rnd() * s, y + 4, range(rnd, 6, 16), 4, 0, '#8a4a26', 0.5, 0.3);
    }
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(g.canvas, 0.4);
  },
});
register('rs_barrel_lid', {
  family: F, size: 128, note: 'barrel head (fitted, circle): boards across, iron chime ring, a bung',
  paint(g, s, rnd) {
    const c = s / 2;
    fill(g, s, s, '#3a3036');
    g.save(); g.beginPath(); g.arc(c, c, c - 6, 0, TAU); g.clip();
    for (let i = 0; i < 5; i++) plank(g, 0, i * s / 5, s, s / 5 - 1, jitter('#8a6440', rnd, 0.08), rnd, { grain: 5, bevel: 2 });
    g.fillStyle = (() => { const gr = g.createRadialGradient(c, c, c * 0.5, c, c, c); gr.addColorStop(0, rgba(INK, 0)); gr.addColorStop(1, rgba(INK, 0.5)); return gr; })(); g.fillRect(0, 0, s, s);
    g.restore();
    g.lineWidth = 8; g.strokeStyle = '#4a464c'; g.beginPath(); g.arc(c, c, c - 4, 0, TAU); g.stroke();
    g.lineWidth = 2; g.strokeStyle = rgba('#9a98a0', 0.6); g.beginPath(); g.arc(c, c, c - 6, Math.PI, Math.PI * 1.6); g.stroke();
    ellipse(g, c + 18, c - 10, 7, 7, 0, '#3a2a20'); blob(g, c + 16, c - 12, 3, 3, 0, '#a88a60', 0.6, 0.4);
  },
});
function drum(g, s, rnd, { paint, label, labelCol = '#e8dcc0' }) {
  fill(g, s, s, paint);
  mottle(g, s, rnd, { colors: [lightOf(paint, 0.2), shadowOf(paint, 0.25)], count: 24, rmin: 10, rmax: 40, alpha: 0.35, hard: 0.1 });
  // rolled ribs at 1/3 and 2/3, the chime at each end
  for (const y of [s * 0.33, s * 0.66]) { g.fillStyle = grad(g, 0, y - 9, 0, y + 9, [[0, lightOf(paint, 0.55)], [0.4, paint], [1, shadowOf(paint, 0.6)]]); g.fillRect(0, y - 9, s, 18); }
  for (const [y, d] of [[0, 1], [s, -1]]) { g.fillStyle = grad(g, 0, y, 0, y + d * 14, [[0, '#2a2428'], [0.5, shadowOf(paint, 0.4)], [1, shadowOf(paint, 0.1), 0]]); g.fillRect(0, Math.min(y, y + d * 14), s, 14); }
  letters(g, label, s * 0.3, s * 0.5, { font: FONT(34), color: labelCol, alpha: 0.85, worn: 0.6, rnd, maxW: s * 0.36, under: paint });
  for (let i = 0; i < 12; i++) chip(g, s, rnd() * s, rnd() * s, range(rnd, 3, 8), '#5a3a2a', rnd);
  for (let i = 0; i < 8; i++) rustRun(g, s, rnd() * s, rnd() * s * 0.6, range(rnd, 20, 60), range(rnd, 2, 5), 0.4, rnd);
  for (let i = 0; i < 4; i++) dent(g, s, rnd() * s, range(rnd, 0.2, 0.8) * s, range(rnd, 12, 24), paint, 0.5);
  g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#fff0c8', 0.1], [0.5, '#fff0c8', 0], [1, '#5a3a24', 0.3]]); g.fillRect(0, 0, s, s);
  blurTile(g.canvas, 0.5);
}
register('rs_drum', { family: F, size: 256, note: 'steel oil drum (fitted: u around, v top→bottom): teal paint, rolled ribs, stencil OIL, rust', paint(g, s, rnd) { drum(g, s, rnd, { paint: '#3e6a72', label: 'OIL' }); } });
register('rs_drum_red', { family: F, size: 256, note: 'steel drum, red paint, stencil FUEL', paint(g, s, rnd) { drum(g, s, rnd, { paint: '#94392a', label: 'FUEL' }); } });

register('rs_scrap', {
  family: F, size: 256, note: 'a heap of scrap (tiles): rusted and painted sheets, pipes, a cog, bolts, dark gaps',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#4a3228');
    mottle(g, s, rnd, { colors: ['#6a4030', '#3a2a24', '#7a4a2e'], count: 30, rmin: 20, rmax: 60, alpha: 0.5, hard: 0.1 });
    const cols = ['#7a4a2e', '#8a5634', '#6a4030', '#7a5a3a', '#6a6670', '#7a4a2e', '#94392a', '#3e5f8a', '#a8843a', '#8a5634'];
    for (let i = 0; i < 26; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 26, 56), a = rnd() * TAU, c = jitter(pick(rnd, cols), rnd, 0.08);
      const pts = []; const n = 4 + Math.floor(rnd() * 2);
      for (let k = 0; k < n; k++) { const t = a + k / n * TAU + range(rnd, -0.25, 0.25), rr = r * range(rnd, 0.7, 1.15); pts.push([Math.cos(t) * rr, Math.sin(t) * rr * 0.6]); }
      const ribbed = rnd() < 0.35, riv = rnd() < 0.5, rs = Math.floor(rnd() * 1e9);
      wrap(s, x, y, r * 1.3, (X, Y) => {
        const pr = rngFrom(rs);
        g.save(); g.translate(X, Y);
        g.save(); g.translate(4, 6); polyPath(g, pts); g.fillStyle = rgba(INK, 0.5); g.fill(); g.restore();
        polyPath(g, pts); g.fillStyle = grad(g, -r, -r, r, r, [[0, lightOf(c, 0.3)], [0.5, c], [1, shadowOf(c, 0.4)]]); g.fill();
        g.save(); polyPath(g, pts); g.clip();
        if (ribbed) for (let k = -6; k <= 6; k++) { g.fillStyle = rgba(INK, 0.2); g.fillRect(k * 10, -r, 4, r * 2); g.fillStyle = rgba('#fff0d0', 0.14); g.fillRect(k * 10 + 4, -r, 3, r * 2); }
        for (let k = 0; k < 3; k++) blob(g, range(pr, -r, r) * 0.6, range(pr, -r, r) * 0.4, r * range(pr, 0.3, 0.6), r * 0.3, 0, pick(pr, ['#8a4a26', '#a85a2a', '#5a3424']), 0.5, 0.3);
        g.restore();
        g.lineWidth = 2; g.strokeStyle = rgba(lightOf(c, 0.6), 0.55); g.beginPath(); g.moveTo(pts[n - 1][0], pts[n - 1][1]); for (const p of pts) g.lineTo(p[0], p[1]); g.stroke();
        if (riv) for (const p of pts) rivet(g, p[0] * 0.75, p[1] * 0.75, 2.6, '#8a8276');
        g.restore();
      });
    }
    // pipes
    for (let i = 0; i < 5; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 40, 90), a = rnd() * TAU, w = range(rnd, 6, 11), c = pick(rnd, ['#6a6670', '#7a4a2e', '#a8843a']);
      const p = [[0, 0], [Math.cos(a) * L, Math.sin(a) * L]];
      wrap(s, x, y, L + w, (X, Y) => {
        const q = p.map(([u, v]) => [u + X, v + Y]);
        line(g, q.map(([u, v]) => [u + 2, v + 3]), w + 2, INK, 0.5);
        line(g, q, w, c, 1, 'butt');
        line(g, q.map(([u, v]) => [u - Math.sin(a) * w * 0.25, v + Math.cos(a) * w * -0.25]), w * 0.3, lightOf(c, 0.6), 0.6, 'butt');
      });
    }
    // a cog
    { const x = rnd() * s, y = rnd() * s, r = 22;
      wrap(s, x, y, r * 1.5, (X, Y) => {
        for (let k = 0; k < 10; k++) { const a = k / 10 * TAU; ellipse(g, X + Math.cos(a) * r, Y + Math.sin(a) * r, 6, 5, a, '#7a5a2a'); }
        g.fillStyle = grad(g, X - r, Y - r, X + r, Y + r, [[0, '#d8b860'], [1, '#5a4018']]); g.beginPath(); g.arc(X, Y, r, 0, TAU); g.fill();
        ellipse(g, X, Y, 7, 7, 0, '#2a2228');
      }); }
    pebbles(g, s, rnd, { colors: ['#6a6670', '#8a8276', '#7a4a2e'], count: 14, rmin: 2.5, rmax: 4.5 });
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});

// ---- gas pump --------------------------------------------------------------------------------------------

register('rs_pump_face', {
  family: F, w: 128, h: 256, note: 'goblin fuel pump front (fitted): brass gauge dial, FUEL lettering, price drums, kick plate',
  paint(g, w, rnd, h) {
    const red = '#94392a';
    g.fillStyle = grad(g, 0, 0, w, h, [[0, lightOf(red, 0.25)], [0.5, red], [1, shadowOf(red, 0.35)]]); g.fillRect(0, 0, w, h);
    mottle(g, w, rnd, { colors: [lightOf(red, 0.2), shadowOf(red, 0.2)], count: 14, rmin: 8, rmax: 24, alpha: 0.3 });
    // the dial
    const cx = w / 2, cy = 58, R = 44;
    g.fillStyle = grad(g, cx - R, cy - R, cx + R, cy + R, [[0, '#f0d890'], [0.5, '#b08a3c'], [1, '#5a4018']]);
    g.beginPath(); g.arc(cx, cy, R + 6, 0, TAU); g.fill();
    g.fillStyle = (() => { const gr = g.createRadialGradient(cx - 10, cy - 12, 4, cx, cy, R); gr.addColorStop(0, '#fbf2dc'); gr.addColorStop(1, '#c8b890'); return gr; })();
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
    for (let i = 0; i <= 10; i++) { const a = Math.PI * 0.8 + i / 10 * Math.PI * 1.4; line(g, [[cx + Math.cos(a) * R * 0.72, cy + Math.sin(a) * R * 0.72], [cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9]], i % 5 ? 1.5 : 3, '#3a2a24', 0.85); }
    { const a = Math.PI * 0.8 + 0.83 * Math.PI * 1.4; line(g, [[cx, cy], [cx + Math.cos(a) * R * 0.8, cy + Math.sin(a) * R * 0.8]], 3, '#a8302a'); }
    ellipse(g, cx, cy, 5, 5, 0, '#3a2a24');
    g.font = FONT(11); g.fillStyle = '#3a2a24'; g.textAlign = 'center'; g.fillText('GALLONS', cx, cy + 24);
    blob(g, cx - 16, cy - 20, 14, 7, -0.6, '#ffffff', 0.5, 0.4);
    // lettering
    letters(g, 'FUEL', cx, 132, { font: SERIF(34), color: '#f0dca8', shadowCol: INK, alpha: 0.95, worn: 0.3, rnd, maxW: w - 20, under: red });
    // price drums
    g.fillStyle = '#2a2228'; g.fillRect(16, 156, w - 32, 30);
    for (let i = 0; i < 4; i++) {
      const x = 20 + i * (w - 40) / 4, ww = (w - 40) / 4 - 4;
      g.fillStyle = grad(g, 0, 158, 0, 184, [[0, '#8a8070'], [0.3, '#f0e6d0'], [0.7, '#f0e6d0'], [1, '#8a8070']]); g.fillRect(x, 158, ww, 26);
      g.font = FONT(20); g.fillStyle = '#2a2228'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('8.99'[i], x + ww / 2, 172);
    }
    // brass kick plate
    g.fillStyle = grad(g, 0, h - 52, 0, h, [[0, '#e0c070'], [0.3, '#b08a3c'], [1, '#5a4018']]); g.fillRect(0, h - 52, w, 52);
    for (const x of [12, w / 2, w - 12]) for (const y of [h - 42, h - 12]) rivet(g, x, y, 3.5, '#c8a050');
    // rivets round the edge, grime, chips
    for (let y = 14; y < h - 60; y += 24) for (const x of [7, w - 7]) rivet(g, x, y, 2.6, '#c8a050');
    for (let i = 0; i < 8; i++) chip(g, w, rnd() * w, 100 + rnd() * 90, range(rnd, 2, 5), '#4a3a30', rnd);
    g.fillStyle = grad(g, 0, h * 0.6, 0, h, [[0, INK, 0], [1, INK, 0.3]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.4);
  },
});

// ---- the dinosaur ----------------------------------------------------------------------------------------

register('rs_dino', {
  family: F, size: 256, note: 'roadside dino hide (tiles in u; v: bottom = belly, top = back): dark tiger stripes over the back, soft big scales, cream belly bands, chipped plaster',
  paint(g, s, rnd, h, cv) {
    // back (top of the canvas) → flank → belly (bottom)
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#45703a'], [0.3, '#548442'], [0.55, '#629048'], [0.66, '#94a058'], [0.74, '#d0c088'], [1, '#dccc96']]);
    g.fillRect(0, 0, s, s);
    mottle(g, s, rnd, { colors: ['#6e9c4c', '#4a7a3a', '#7aa456', '#5a8040'], count: 40, rmin: 14, rmax: 46, alpha: 0.3, hard: 0.1, stretch: 1.6, rot: Math.PI / 2 });
    // tiger stripes over the back, tapering down the flank
    for (let i = 0; i < 7; i++) {
      const x = (i + 0.3 + rnd() * 0.4) * s / 7, w = range(rnd, 9, 15), L = range(rnd, 0.32, 0.5) * s, bend = range(rnd, -14, 14);
      const pts = []; for (let k = 0; k <= 6; k++) { const tt = k / 6; pts.push([x + Math.sin(tt * 2.2) * bend, -4 + tt * L]); }
      for (const dx of [-s, 0, s]) { stroke(g, pts.map(([u, v]) => [u + dx + 2, v + 3]), w + 3, 1, '#1e2a1a', 0.18); stroke(g, pts.map(([u, v]) => [u + dx, v]), w, 1.5, '#2e4a28', 0.75); }
    }
    // soft scales: big, low contrast, lit on the upper left
    const cols = 11, W = s / cols;
    for (let row = 0; row < 8; row++) {
      const y = 10 + row * 21, off = row % 2 ? W / 2 : 0;
      for (let i = 0; i < cols; i++) {
        const x = i * W + off + range(rnd, -2, 2), yy = y + range(rnd, -2, 2), sc = range(rnd, 0.85, 1.1);
        wrap(s, x, yy, W, (X, Y) => {
          blob(g, X + 2, Y + 4, W * 0.5 * sc, W * 0.36 * sc, 0, '#1e2a1a', 0.18, 0.3);
          blob(g, X - 2, Y - 3, W * 0.32 * sc, W * 0.18 * sc, 0, '#c8dc90', 0.28, 0.35);
        });
      }
    }
    // belly plates
    for (let y = s * 0.74; y < s; y += 16) {
      g.fillStyle = grad(g, 0, y, 0, y + 16, [[0, '#f4e6b8', 0.6], [0.4, '#dccc96', 0], [0.85, '#8a7a50', 0.35], [1, '#5a4a34', 0.5]]);
      g.fillRect(0, y, s, 16);
    }
    // chipped paint showing gray plaster, cracks, rain streaks
    for (let i = 0; i < 12; i++) chip(g, s, rnd() * s, rnd() * s, range(rnd, 3, 8), '#a49c90', rnd);
    cracks(g, s, rnd, { color: '#3a3430', count: 4, len: [16, 44], width: [0.8, 1.4], alpha: 0.4 });
    streaks(g, s, rnd, { colors: ['#3a4a2e', '#6a5a40'], count: 14, len: [20, 60], width: [2, 4], angle: Math.PI, wobble: 0.1, alpha: 0.12 });
    glaze(g, s, s, '#ffe8b8', 0.1, 'soft-light');
    blurTile(cv, 0.6);
  },
});
register('rs_stone', {
  family: F, size: 256, note: 'cut stone blocks (pedestal, footings): lit bevels, soft grout, a little moss',
  paint(g, s, rnd, h, cv) {
    const rects = rowLayout(s, rnd, { rows: 3, minW: 70, maxW: 150, rowJitter: 0.2 });
    paintRects(g, s, rects, rnd, {
      colors: ['#9c9284', '#8e867a', '#a89e8c', '#948a7e'], gap: 6, gapColor: '#4a4046', radius: 7, bevel: 6, light: 0.45, varAmt: 0.08,
      inner(gg, X, Y, w, hh, c) {
        const r = rngFrom(seedAt(s, X, Y));
        for (let i = 0; i < 5; i++) blob(gg, X + r() * w, Y + r() * hh, range(r, 10, 30), range(r, 8, 20), r() * 3, r() < 0.5 ? '#c8bfae' : '#7a7268', 0.22, 0.15);
        for (let i = 0; i < 3; i++) blob(gg, X + r() * w, Y + r() * hh, range(r, 2, 5), range(r, 2, 4), r() * 3, '#5e564e', 0.4, 0.4);
      },
    });
    cracks(g, s, rnd, { color: '#3a3238', count: 5, len: [14, 36], width: [0.8, 1.4], alpha: 0.45 });
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c'], count: 10, rmin: 6, rmax: 18, alpha: 0.2, hard: 0.2 });
    glaze(g, s, s, '#ffe2b0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// ---- ranger gate & keypad ------------------------------------------------------------------------------

register('rs_warn', {
  family: F, size: 256, note: 'warning planks: upright boards hand-painted in red and cream diagonal bands, worn to the wood',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#241c22');
    const n = 4, W = s / n, P = 128;
    for (let i = 0; i < n; i++) {
      const X = i * W + 2, w = W - 4;
      const pr = rngFrom(1000 + i * 77);
      plank(g, X, 0, w, s, jitter('#8a6440', pr, 0.05), pr, { vertical: true, grain: 6, bevel: 0, splits: 0.2, knots: 0.2 });
      g.save(); g.beginPath(); g.rect(X, 0, w, s); g.clip();
      // cream ground, red bands at 45° (period P tiles the 256 tile both ways)
      g.globalAlpha = 0.92; g.fillStyle = '#e2d4b2'; g.fillRect(X, 0, w, s);
      g.fillStyle = '#a8342a';
      for (let k = -4; k < 8; k++) { const o = k * P; polyPath(g, [[o, 0], [o + P / 2, 0], [o + P / 2 - s, s], [o - s, s]]); g.fill(); }
      g.globalAlpha = 1;
      // worn paint: wood shows through in blotches and along the grain
      for (let k = 0; k < 9; k++) { const y = pr() * s, x = X + pr() * w; blob(g, x, y, range(pr, 4, 12), range(pr, 8, 26), 0, pick(pr, ['#8a6440', '#7a5634']), 0.75, 0.55); }
      for (let k = 0; k < 6; k++) { const x = X + pr() * w, y = pr() * s; line(g, [[x, y], [x + (pr() - 0.5) * 2, y + range(pr, 20, 70)]], range(pr, 1, 2.2), '#6a4a30', 0.5); }
      // board shading: lit left edge, dark right edge, then nails top and bottom
      g.fillStyle = grad(g, X, 0, X + w, 0, [[0, '#fff0c8', 0.35], [0.12, '#fff0c8', 0], [0.8, INK, 0], [1, INK, 0.45]]); g.fillRect(X, 0, w, s);
      g.restore();
      for (const y of [18, s / 2 + 18]) { nail(g, X + w * 0.3, y, 2.4); nail(g, X + w * 0.7, y + 3, 2.4); }
      for (let k = 0; k < 2; k++) rustRun(g, s, X + w * (0.3 + 0.4 * k), 22 + k * 3, range(pr, 10, 26), 2, 0.4, pr);
    }
    glaze(g, s, s, '#ffe0b0', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  },
});
register('rs_keypad', {
  family: F, w: 128, h: 160, note: 'goblin keypad (fitted): brass plate, green-glass readout, twelve ivory buttons, rivets',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, w, h, [[0, '#f0d890'], [0.35, '#c09a48'], [1, '#5a4018']]); g.fillRect(0, 0, w, h);
    g.fillStyle = grad(g, 0, 0, w, h, [[0, '#a8843a'], [1, '#7a5a24']]); g.fillRect(8, 8, w - 16, h - 16);
    streaks(g, w, rnd, { colors: ['#e8cc78', '#6a4e22'], count: 30, len: [10, 40], width: [0.6, 1.2], angle: Math.PI / 2, wobble: 0.02, alpha: 0.25 });
    for (let i = 0; i < 6; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 4, 12), range(rnd, 3, 8), rnd() * 3, '#5a8a6a', 0.35, 0.3);
    // readout
    g.fillStyle = '#1e2a22'; g.fillRect(16, 16, w - 32, 26);
    g.fillStyle = grad(g, 0, 18, 0, 40, [[0, '#4a8a52'], [1, '#2a5a32']]); g.fillRect(18, 18, w - 36, 22);
    g.font = FONT(16); g.fillStyle = '#b8f0a0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('- - - -', w / 2, 30);
    blob(g, 30, 22, 14, 3, 0, '#ffffff', 0.35, 0.4);
    // buttons
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
      const x = 30 + c * 34, y = 62 + r * 24;
      blob(g, x + 2, y + 3, 13, 10, 0, INK, 0.5, 0.3);
      g.fillStyle = (() => { const gr = g.createRadialGradient(x - 4, y - 4, 1, x, y, 12); gr.addColorStop(0, '#fbf2dc'); gr.addColorStop(0.7, '#d8c8a0'); gr.addColorStop(1, '#8a7a5a'); return gr; })();
      g.beginPath(); g.ellipse(x, y, 12, 10, 0, 0, TAU); g.fill();
      g.font = FONT(12); g.fillStyle = '#3a2a20'; g.fillText(keys[r * 3 + c], x, y + 1);
    }
    for (const [x, y] of [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8]]) rivet(g, x, y, 4, '#c8a050');
    ellipse(g, w - 20, h - 22, 5, 5, 0, '#a8302a'); blob(g, w - 21.5, h - 23.5, 2, 2, 0, '#ffd0b0', 0.8, 0.4);
    blurTile(g.canvas, 0.3);
  },
});

// ---- camp: logs ------------------------------------------------------------------------------------------

register('rs_bark', {
  family: F, size: 256, note: 'log bark (u around, v along the log): deep furrows, lit ridges, lichen',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a4434');
    mottle(g, s, rnd, { colors: ['#6a5240', '#4a382c', '#725a46'], count: 30, rmin: 14, rmax: 46, alpha: 0.4, hard: 0.1, stretch: 2.5, rot: Math.PI / 2 });
    // bark plates: elongated along u (the log runs along u in the texture's long direction)
    for (let i = 0; i < 70; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 20, 60), W = range(rnd, 6, 12), c = jitter(pick(rnd, ['#6a5240', '#7a604a', '#5e4838']), rnd, 0.08);
      wrap(s, x, y, L, (X, Y) => {
        blob(g, X + W * 0.5, Y + 2, W * 0.5, L * 0.55, 0, '#1e1418', 0.45, 0.35);
        ellipse(g, X, Y, W * 0.45, L * 0.5, (rnd() - 0.5) * 0.15, c, 0.95);
        blob(g, X - W * 0.18, Y - L * 0.1, W * 0.18, L * 0.38, 0, lightOf(c, 0.45), 0.6, 0.3);
      });
    }
    mottle(g, s, rnd, { colors: ['#8a9a6a', '#a4a888'], count: 16, rmin: 4, rmax: 12, alpha: 0.45, hard: 0.4 });
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});
register('rs_logend', {
  family: F, size: 128, note: 'sawn log end (fitted, circle): growth rings, radial checks, bark rim',
  paint(g, s, rnd) {
    const c = s / 2;
    fill(g, s, s, '#3a2a20');
    g.fillStyle = (() => { const gr = g.createRadialGradient(c - 10, c - 10, 4, c, c, c); gr.addColorStop(0, '#d8b480'); gr.addColorStop(0.8, '#b48a58'); gr.addColorStop(1, '#8a6440'); return gr; })();
    g.beginPath(); g.arc(c, c, c * 0.86, 0, TAU); g.fill();
    for (let r = 5; r < c * 0.84; r += range(rnd, 3.5, 6)) {
      g.strokeStyle = rgba('#7a5434', range(rnd, 0.25, 0.5)); g.lineWidth = range(rnd, 0.8, 1.6);
      g.beginPath(); for (let k = 0; k <= 32; k++) { const a = k / 32 * TAU, rr = r + Math.sin(a * 3 + r) * 0.8; k ? g.lineTo(c + 2 + Math.cos(a) * rr, c + 1 + Math.sin(a) * rr) : g.moveTo(c + 2 + Math.cos(a) * rr, c + 1 + Math.sin(a) * rr); } g.stroke();
    }
    // a couple of drying checks running in from the rim, wobbly, thick at the bark and thinning inward
    for (let i = 0; i < 2; i++) {
      const a = rnd() * TAU, pts = [];
      for (let k = 0; k <= 6; k++) { const rr = c * (0.84 - k * 0.07), aa = a + Math.sin(k * 1.7 + i) * 0.06; pts.push([c + Math.cos(aa) * rr, c + Math.sin(aa) * rr]); }
      stroke(g, pts.map(([x, y]) => [x + 1, y + 1]), 2.6, 0.6, '#f0d8a8', 0.3);
      stroke(g, pts, 2.4, 0.4, '#3a2a20', 0.75);
    }
    ellipse(g, c + 2, c + 1, 3, 2.5, 0, '#6a4a2c', 0.8);
    g.lineWidth = c * 0.16; g.strokeStyle = '#4e3a2c'; g.beginPath(); g.arc(c, c, c * 0.92, 0, TAU); g.stroke();
    g.lineWidth = 2; g.strokeStyle = rgba('#8a6a50', 0.6); g.beginPath(); g.arc(c, c, c * 0.95, Math.PI, Math.PI * 1.6); g.stroke();
    blob(g, c - 14, c - 16, 22, 14, -0.6, '#f0d8a8', 0.25, 0.2);
  },
});

// ---- parked motorhomes ---------------------------------------------------------------------------------------

register('rs_rv', {
  family: F, size: 256, note: 'junked motorhome skin (u along the body, 3 m; v fitted top→bottom): cream panels, a two-tone belt stripe, rivet seams, rust, mud',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e2d6bc');
    mottle(g, s, rnd, { colors: ['#ece2cc', '#cfc2a4', '#d8ccb0'], count: 30, rmin: 16, rmax: 50, alpha: 0.35, hard: 0.1 });
    // belt stripes (horizontal bands at ~48-62% height)
    const band = (y0, y1, c) => { g.fillStyle = grad(g, 0, y0, 0, y1, [[0, lightOf(c, 0.3)], [0.5, c], [1, shadowOf(c, 0.3)]]); g.fillRect(0, y0, s, y1 - y0); };
    band(s * 0.46, s * 0.56, '#7a4a2a');
    band(s * 0.585, s * 0.62, '#c8783a');
    // roof cap seam and a skirt seam
    for (const y of [s * 0.1, s * 0.86]) { g.fillStyle = grad(g, 0, y - 2, 0, y + 5, [[0, INK, 0.45], [1, '#fff0d0', 0.2]]); g.fillRect(0, y - 2, s, 7); for (let x = 8; x < s; x += 21) rivet(g, x, y + 6, 2.2, '#9a9284'); }
    // panel seams with rivet columns
    for (let i = 0; i < 3; i++) {
      const x = (i + 0.3) * s / 3;
      g.fillStyle = grad(g, x - 2, 0, x + 4, 0, [[0, INK, 0.4], [1, '#fff0d0', 0.2]]); g.fillRect(x - 2, s * 0.1, 6, s * 0.76);
      for (let y = s * 0.16; y < s * 0.84; y += 19) { rivet(g, x + 6, y, 2.2, '#9a9284'); if (rnd() < 0.25) rustRun(g, s, x + 6, y + 2, range(rnd, 8, 26), 2.2, 0.4, rnd); }
    }
    for (let i = 0; i < 10; i++) chip(g, s, rnd() * s, range(rnd, 0.15, 0.85) * s, range(rnd, 2.5, 6), '#7a6a5a', rnd);
    for (let i = 0; i < 5; i++) dent(g, s, rnd() * s, range(rnd, 0.2, 0.8) * s, range(rnd, 10, 22), '#d8ccb0', 0.5);
    // grime: a dark skirt, mud splashed up from the wheels
    g.fillStyle = grad(g, 0, s * 0.7, 0, s, [[0, '#6a5a44', 0], [0.6, '#6a5a44', 0.35], [1, '#4a3a2c', 0.65]]); g.fillRect(0, 0, s, s);
    streaks(g, s, rnd, { colors: ['#6a5040', '#7a6048'], count: 26, len: [6, 30], width: [1.2, 3], angle: 0, wobble: 0.6, alpha: 0.3 });
    // rust runs from the roof seam
    for (let i = 0; i < 8; i++) rustRun(g, s, rnd() * s, s * 0.12, range(rnd, 20, 70), range(rnd, 2, 4), 0.35, rnd);
    glaze(g, s, s, '#ffe2b8', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});
register('rs_rv_window', {
  family: F, size: 128, note: 'motorhome window (fitted): rounded rim, dusty glass, a faded curtain drawn half across, a crack',
  paint(g, s, rnd) {
    fill(g, s, s, '#9a9488');
    g.fillStyle = grad(g, 0, 0, s, s, [[0, '#d8d2c4'], [1, '#6a645a']]); g.beginPath(); g.roundRect(0, 0, s, s, 18); g.fill();
    g.fillStyle = grad(g, 0, 10, 0, s - 10, [[0, '#5a7a86'], [1, '#2a3440']]); g.beginPath(); g.roundRect(10, 10, s - 20, s - 20, 12); g.fill();
    // curtain
    g.save(); g.beginPath(); g.roundRect(10, 10, s - 20, s - 20, 12); g.clip();
    for (let i = 0; i < 6; i++) { const x = 10 + i * 10; g.fillStyle = grad(g, x, 0, x + 10, 0, [[0, '#a8604a'], [0.5, '#c8805a'], [1, '#7a4030']]); g.fillRect(x, 10, 10, s - 20); }
    for (let k = 0; k < 6; k++) for (let i = 0; i < 3; i++) ellipse(g, 15 + i * 18, 20 + k * 18, 3, 3, 0, '#e8c890', 0.6);
    g.save(); g.globalAlpha = 0.25; g.fillStyle = '#e8f2f0'; polyPath(g, [[s * 0.5, 0], [s * 0.66, 0], [s * 0.3, s], [s * 0.14, s]]); g.fill(); g.restore();
    g.fillStyle = grad(g, 0, s * 0.5, 0, s, [[0, '#8a7a5a', 0], [1, '#8a7a5a', 0.6]]); g.fillRect(0, 0, s, s);
    line(g, [[s * 0.75, s * 0.15], [s * 0.7, s * 0.35], [s * 0.82, s * 0.5]], 1.2, '#e8f0f0', 0.6);
    g.restore();
    blurTile(g.canvas, 0.5);
  },
});
register('rs_boards', {
  family: F, size: 128, note: 'boarded-up window (fitted): dark hole, three planks nailed across',
  paint(g, s, rnd) {
    fill(g, s, s, '#1e1a20');
    blob(g, s / 2, s / 2, s * 0.4, s * 0.4, 0, '#3a3440', 0.6, 0.2);
    const bd = [[8, 0.12, -0.08], [44, 0.0, 0.05], [82, 0.1, -0.04]];
    for (const [y, sk, rot] of bd) {
      g.save(); g.translate(s / 2, y + 16); g.rotate(rot);
      blob(g, 3, 6, s * 0.55, 12, 0, INK, 0.5, 0.3);
      plank(g, -s * 0.56, -14, s * 1.12, 28, jitter('#8a7e6c', rnd, 0.08), rnd, { grain: 5, bevel: 3, weather: 0.5 });
      nail(g, -s * 0.4, 0, 2.6); nail(g, s * 0.4, 0, 2.6);
      g.restore();
    }
  },
});

// ---- canopy fascia -------------------------------------------------------------------------------------------

register('rs_fascia', {
  family: F, w: 256, h: 64, note: 'gas canopy fascia board (u along, 2 m; v fitted): red paint, cream pinstripes, brass rivets, painted diamonds',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#b8543e'], [0.3, '#9a3e2e'], [1, '#6a2a22']]); g.fillRect(0, 0, w, h);
    mottle(g, w, rnd, { colors: ['#b24a36', '#7e3024'], count: 10, rmin: 8, rmax: 20, alpha: 0.3 });
    for (const y of [9, h - 10]) line(g, [[0, y], [w, y]], 2.5, '#e8d8b0', 0.85, 'butt');
    for (let i = 0; i < 4; i++) {
      const x = i * w / 4 + w / 8;
      polyPath(g, [[x, h / 2 - 12], [x + 14, h / 2], [x, h / 2 + 12], [x - 14, h / 2]]); g.fillStyle = '#e8d8b0'; g.fill();
      polyPath(g, [[x, h / 2 - 6], [x + 7, h / 2], [x, h / 2 + 6], [x - 7, h / 2]]); g.fillStyle = '#c8963a'; g.fill();
      rivet(g, x + w / 8, h / 2, 3.2, '#c8a050');
    }
    for (let i = 0; i < 6; i++) chip(g, w, rnd() * w, range(rnd, 12, h - 12), range(rnd, 2, 4), '#5a3a2a', rnd);
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#fff0c8', 0.25], [0.15, '#fff0c8', 0], [0.85, INK, 0], [1, INK, 0.45]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.4);
  },
});

// ---- weather: snow, dust, sand (caps, drifts, cover), icicles --------------------------------------------------

function snowPaint(g, s, rnd) {
  fill(g, s, s, '#e6edf4');
  mottle(g, s, rnd, { colors: ['#c9d6e6', '#d6e0ec', '#bccbe0'], count: 40, rmin: 14, rmax: 50, alpha: 0.4, hard: 0.1 });
  for (let i = 0; i < 26; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 12, 36);
    wrap(s, x, y, r * 1.5, (X, Y) => {
      blob(g, X + r * 0.25, Y + r * 0.3, r, r * 0.55, 0, '#aebfd8', 0.35, 0.2);
      blob(g, X - r * 0.15, Y - r * 0.15, r * 0.8, r * 0.45, 0, '#fbf8f0', 0.6, 0.25);
    });
  }
  for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 3, (X, Y) => blob(g, X, Y, range(rnd, 1, 2.2), 1, 0, '#ffffff', 0.8, 0.5)); }
}
function dustPaint(g, s, rnd) {
  fill(g, s, s, '#b98457');
  mottle(g, s, rnd, { colors: ['#cf9a62', '#a8704a', '#c48a58'], count: 40, rmin: 14, rmax: 50, alpha: 0.4, hard: 0.1 });
  streaks(g, s, rnd, { colors: ['#e0aa72', '#9a6040'], count: 40, len: [16, 60], width: [1.5, 3], angle: Math.PI / 2, wobble: 0.3, alpha: 0.3 });
  pebbles(g, s, rnd, { colors: ['#8e3e22', '#b4552f', '#cf7a45'], count: 40, rmin: 1.5, rmax: 4 });
}
function sandPaint(g, s, rnd) {
  fill(g, s, s, '#dcbc86');
  mottle(g, s, rnd, { colors: ['#e8cc96', '#c79c62', '#e2c48e'], count: 40, rmin: 14, rmax: 50, alpha: 0.4, hard: 0.1 });
  // wind ripples
  for (let k = 0; k < 14; k++) {
    const y0 = k * s / 14 + range(rnd, -3, 3), ph = rnd() * TAU, amp = range(rnd, 2, 5);
    const pts = []; for (let x = 0; x <= s; x += 8) pts.push([x, y0 + Math.sin(TAU * x / s * 2 + ph) * amp]);
    for (const dy of [-s, 0, s]) { line(g, pts.map(([u, v]) => [u, v + dy + 2]), 2.2, '#b08454', 0.35); line(g, pts.map(([u, v]) => [u, v + dy]), 1.6, '#f4dcaa', 0.45); }
  }
}
function coverAlpha(g, s, rnd, lo = 0.35) {
  // breakup noise in alpha (the cover shader reads it): blotchy, never fully transparent
  const a = document.createElement('canvas'); a.width = a.height = s;
  const ag = a.getContext('2d');
  ag.fillStyle = '#808080'; ag.fillRect(0, 0, s, s);
  mottle(ag, s, rnd, { colors: ['#ffffff', '#202020'], count: 70, rmin: 10, rmax: 40, alpha: 0.5, hard: 0.2 });
  blurTile(a, 2);
  const img = g.getImageData(0, 0, s, s), D = img.data, A = ag.getImageData(0, 0, s, s).data;
  for (let k = 0; k < s * s; k++) D[k * 4 + 3] = Math.round(255 * (lo + (1 - lo) * A[k * 4] / 255));
  g.putImageData(img, 0, 0);
}
register('rs_snow', { family: F, size: 256, note: 'snow for caps and drifts: soft blue shadows, warm-white lit tops, a few sparkles', paint(g, s, rnd, h, cv) { snowPaint(g, s, rnd); blurTile(cv, 0.8); } });
register('rs_dust', { family: F, size: 256, note: 'red badlands dust for drifts', paint(g, s, rnd, h, cv) { dustPaint(g, s, rnd); blurTile(cv, 0.6); } });
register('rs_sand', { family: F, size: 256, note: 'pale desert sand with wind ripples, for drifts', paint(g, s, rnd, h, cv) { sandPaint(g, s, rnd); blurTile(cv, 0.6); } });
register('rs_cover_snow', { family: F, size: 256, alpha: true, note: 'snow cover (alpha = breakup noise for the top-cover shader)', paint(g, s, rnd, h, cv) { snowPaint(g, s, rnd); blurTile(cv, 0.8); coverAlpha(g, s, rnd); } });
register('rs_cover_dust', { family: F, size: 256, alpha: true, note: 'red dust cover (alpha = breakup noise)', paint(g, s, rnd, h, cv) { dustPaint(g, s, rnd); blurTile(cv, 0.6); coverAlpha(g, s, rnd); } });
register('rs_cover_sand', { family: F, size: 256, alpha: true, note: 'sand cover (alpha = breakup noise)', paint(g, s, rnd, h, cv) { sandPaint(g, s, rnd); blurTile(cv, 0.6); coverAlpha(g, s, rnd); } });
register('rs_ice', {
  family: F, w: 64, h: 128, note: 'icicle (fitted: v top→tip): milky white root, glassy blue body, lit streaks',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#f4f8fc'], [0.3, '#d4e4f2'], [1, '#9cc0dc']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 8; i++) { const x = rnd() * w; line(g, [[x, 0], [x + (rnd() - 0.5) * 4, h]], range(rnd, 1, 3), rnd() < 0.5 ? '#ffffff' : '#88acd0', 0.4); }
  },
});

// ---- ground, roofs, lettering ----------------------------------------------------------------------------

register('rs_dirt', {
  family: F, size: 256, note: 'packed earth for furrows and mounds: clods lit on top, pebbles, a few grass blades',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7a5a3a');
    mottle(g, s, rnd, { colors: ['#8a6a46', '#6a4a30', '#9a7650'], count: 40, rmin: 12, rmax: 46, alpha: 0.4, hard: 0.1 });
    for (let i = 0; i < 50; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 14), c = pick(rnd, ['#8a6a46', '#7a5a3a', '#94724c']);
      wrap(s, x, y, r * 1.6, (X, Y) => { blob(g, X + r * 0.3, Y + r * 0.45, r * 1.1, r * 0.7, 0, '#3a2a20', 0.4, 0.3); ellipse(g, X, Y, r, r * 0.7, 0, c, 0.9); blob(g, X - r * 0.3, Y - r * 0.3, r * 0.55, r * 0.35, 0, lightOf(c, 0.4), 0.6, 0.3); });
    }
    pebbles(g, s, rnd, { colors: ['#8a8070', '#9a9080', '#6a6258'], count: 40, rmin: 1.5, rmax: 4 });
    streaks(g, s, rnd, { colors: ['#5e7a34', '#7a9440'], count: 20, len: [6, 14], width: [1, 2], angle: 0, wobble: 0.6, alpha: 0.6 });
    glaze(g, s, s, '#ffe0b0', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});

register('rs_shingles', {
  family: F, size: 256, note: 'cedar shingles (up the roof = up the texture): rows overlapping with soft shadows, moss in the laps',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#3a2a24');
    const rows = 6, rh = s / rows;
    for (let r = rows - 1; r >= 0; r--) {
      const y = r * rh, ws = rowLayout(s, rngFrom(77 + r), { rows: 1, minW: 26, maxW: 52 }).map(q => [q.x, q.w]);
      for (const [x0, w] of ws) {
        const c = jitter(pick(rnd, ['#8a5e3a', '#7a5232', '#946640', '#6e4a30']), rnd, 0.06), sh = range(rnd, -3, 3);
        wrapRect(s, x0 + 1, y, w - 2, rh + 10, (dx, dy) => {
          const X = x0 + 1 + dx, Y = y + dy, W = w - 2, H = rh + 8 + sh;
          g.fillStyle = grad(g, 0, Y, 0, Y + H, [[0, shadowOf(c, 0.4)], [0.35, c], [0.9, lightOf(c, 0.25)], [1, shadowOf(c, 0.3)]]);
          g.beginPath(); g.roundRect(X, Y, W, H, [0, 0, 4, 4]); g.fill();
          for (let k = 0; k < 3; k++) { const gx = X + range(rnd, 0.15, 0.85) * W; line(g, [[gx, Y + 4], [gx + range(rnd, -1, 1), Y + H - 3]], 0.8, shadowOf(c, 0.4), 0.4); }
          g.fillStyle = rgba(lightOf(c, 0.5), 0.45); g.fillRect(X, Y + H - 4, W, 2);
          g.fillStyle = rgba(INK, 0.35); g.fillRect(X + W - 2, Y, 2, H);
        });
      }
      // the row above casts a shadow on this one
      g.fillStyle = grad(g, 0, y, 0, y + 10, [[0, INK, 0.5], [1, INK, 0]]); g.fillRect(0, y, s, 10);
    }
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c'], count: 12, rmin: 5, rmax: 16, alpha: 0.22, hard: 0.3 });
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('rs_decal_freight', {
  family: F, w: 512, h: 128, alpha: true, note: 'trailer lettering (alpha decal): LOST WAGES FREIGHT in cream sign-painter letters with a dark outline, a cog, sun-worn',
  paint(g, w, rnd, h) {
    g.save();
    g.font = SERIF(54); g.textAlign = 'center'; g.textBaseline = 'middle';
    const txt = 'LOST WAGES', m = g.measureText(txt).width, sx = Math.min(1, (w - 150) / m);
    g.translate(w / 2 + 34, 44); g.scale(sx, 1);
    g.lineJoin = 'round'; g.lineWidth = 9; g.strokeStyle = '#2a2030'; g.strokeText(txt, 0, 0);
    g.fillStyle = '#efdcae'; g.fillText(txt, 0, 0);
    g.restore();
    g.save(); g.font = FONT(30); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 6; g.strokeStyle = '#2a2030'; g.strokeText('— FREIGHT CO. —', w / 2 + 34, 98);
    g.fillStyle = '#c8963a'; g.fillText('— FREIGHT CO. —', w / 2 + 34, 98); g.restore();
    // a brass cog emblem
    const cx = 62, cy = 64;
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; ellipse(g, cx + Math.cos(a) * 44, cy + Math.sin(a) * 44, 11, 9, a, '#2a2030'); ellipse(g, cx + Math.cos(a) * 43, cy + Math.sin(a) * 43, 8, 6, a, '#b08a3c'); }
    g.fillStyle = '#2a2030'; g.beginPath(); g.arc(cx, cy, 42, 0, TAU); g.fill();
    g.fillStyle = grad(g, cx - 40, cy - 40, cx + 40, cy + 40, [[0, '#f0d890'], [1, '#7a5a24']]); g.beginPath(); g.arc(cx, cy, 38, 0, TAU); g.fill();
    g.fillStyle = '#94392a'; g.beginPath(); g.arc(cx, cy, 20, 0, TAU); g.fill();
    g.font = SERIF(26); g.fillStyle = '#efdcae'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', cx, cy + 1);
    // sun wear: knock holes in the paint
    g.save(); g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 70; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 2, 7), range(rnd, 1.5, 4), rnd() * 3, '#000', 0.8, 0.5);
    g.restore();
  },
});

register('rs_ranger_board', {
  family: F, w: 512, h: 128, note: 'the ranger station board: dark planks, carved and gilded letters, a painted border, iron corners',
  paint(g, w, rnd, h) {
    fill(g, w, h, '#241c22');
    for (let i = 0; i < 3; i++) plank(g, 0, i * h / 3 + 1, w, h / 3 - 2, jitter('#5e4230', rnd, 0.06), rnd, { grain: 9, bevel: 3 });
    g.lineWidth = 5; g.strokeStyle = rgba('#3a6b35', 0.9); g.strokeRect(12, 12, w - 24, h - 24);
    g.lineWidth = 1.5; g.strokeStyle = rgba('#c8a050', 0.8); g.strokeRect(18, 18, w - 36, h - 36);
    g.save(); g.font = SERIF(46); g.textAlign = 'center'; g.textBaseline = 'middle';
    const txt = 'RANGER STATION 7', m = g.measureText(txt).width, sx = Math.min(1, (w - 70) / m);
    g.translate(w / 2, h / 2 + 2); g.scale(sx, 1);
    g.fillStyle = rgba('#120c10', 0.85); g.fillText(txt, -1.5, -2);       // the cut's shadowed upper lip
    g.fillStyle = rgba('#fff0c0', 0.35); g.fillText(txt, 1.5, 2.5);       // its lit lower lip
    g.fillStyle = '#d8b050'; g.fillText(txt, 0, 0);
    g.restore();
    for (const [x, y] of [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8]]) rivet(g, x, y, 5, '#6a6670');
    blurTile(g.canvas, 0.3);
  },
});

register('rs_plaque', {
  family: F, w: 256, h: 96, note: 'brass plaque on the dino plinth: SLOPASAURUS, engraved, green patina in the cuts',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, w, h, [[0, '#f0d890'], [0.4, '#c09a48'], [1, '#6a4e22']]); g.fillRect(0, 0, w, h);
    g.lineWidth = 3; g.strokeStyle = rgba('#5a4018', 0.8); g.strokeRect(8, 8, w - 16, h - 16);
    g.save(); g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = SERIF(30); g.fillStyle = rgba('#fff0c0', 0.5); g.fillText('SLOPASAURUS', w / 2 + 1, 38 + 1.5); g.fillStyle = '#3a2a14'; g.fillText('SLOPASAURUS', w / 2, 38);
    g.font = FONT(14); g.fillStyle = '#3a2a14'; g.fillText('HEAD STOLEN 1987 · DO NOT CLIMB', w / 2, 70);
    g.restore();
    for (let i = 0; i < 10; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 4, 14), range(rnd, 3, 8), rnd() * 3, '#5a8a6a', 0.3, 0.3);
    for (const [x, y] of [[14, 14], [w - 14, 14], [14, h - 14], [w - 14, h - 14]]) rivet(g, x, y, 4, '#c8a050');
  },
});

register('rs_roundel', {
  family: F, size: 128, alpha: true, note: 'gnomish roundel (alpha): a brass cog on red and cream rings',
  paint(g, s) {
    const c = s / 2;
    for (const [r, col] of [[60, '#2a2030'], [57, '#e8d8b0'], [44, '#94392a'], [30, '#e8d8b0']]) { g.fillStyle = col; g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill(); }
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; ellipse(g, c + Math.cos(a) * 24, c + Math.sin(a) * 24, 7, 6, a, '#7a5a24'); }
    g.fillStyle = grad(g, c - 22, c - 22, c + 22, c + 22, [[0, '#f0d890'], [1, '#6a4e22']]); g.beginPath(); g.arc(c, c, 22, 0, TAU); g.fill();
    ellipse(g, c, c, 7, 7, 0, '#2a2030');
    blob(g, c - 30, c - 34, 26, 10, -0.6, '#ffffff', 0.25, 0.3);
  },
});
