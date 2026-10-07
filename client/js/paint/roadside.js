// Texture family: roadside (stops, gates, anchors, camp). See docs/ART.md for the style rules.
//
// Everything along the road that isn't nature or a building, painted the way Blizzard's 2004
// artists painted goblin and human junk: riveted painted steel with chipped paint and rust runs,
// corrugated tin, honey and gray planks, dark timber, wrought iron, goblin brass, canvas, cloth.
//
// Tiling (world-space UVs; "tile" = meters per repeat as roadside3d.js maps them):
//   rs_steel_<cream|red|blue|green|teal|mustard>  riveted painted steel: full-height panels, 2-3 per tile
//                             (trailer sides: 4 m per tile, v fitted to the wall's height)
//   rs_tin, rs_tin_red        corrugated sheet roofing, ribs along v (2 m)
//   rs_planks, rs_planks_gray boards along u (1 m)   rs_slats  long narrow boards (2 m)   rs_timber  dark beam, grain along v (1.5 m)
//   rs_shingles (1.2 m)  rs_slate (1.4 m)  rs_hide (1.6 m)  rs_adobe (2 m)  rs_dirt (2 m)  rs_rock (1.4 m)  rs_hay (1 m)
//   rs_iron (0.5 m)  rs_brass (1 m)  rs_tire (tread, u around)  rs_gingham (0.6 m)  rs_burlap  rs_plaid  rs_canvas (stripes along u)
//   rs_wing (doped canvas, ribs along v, 1.6 m)  rs_scrap (1.5 m)  rs_stone (1.6 m)  rs_rope (u around, v along)  rs_bone
//   rs_bark (u around, v along)  rs_dino (u along the body; v = 0 belly .. 1 back, from the normal)
//   rs_rv (u 3 m, v fitted to the body height)  rs_fascia (u 2 m, v fitted)
//   rs_snow, rs_dust, rs_sand (drifts and caps)   rs_cover_snow|dust|sand (alpha = breakup noise, for the
//   world-space top-cover shader)   rs_ice (icicles)
// Fitted (one image per face): rs_hub, rs_glass (two panes side by side), rs_grille, rs_crate_a|b|c, rs_barrel,
//   rs_barrel_lid, rs_drum, rs_drum_red, rs_drum_lid, rs_pump_face, rs_keypad, rs_logend, rs_rv_window, rs_boards,
//   rs_headlamp, rs_blanket, rs_ranger_board, rs_plaque, rs_warn (two boards stacked), rs_stop, rs_chevband;
//   alpha: rs_decal_freight, rs_roundel, rs_pennant, rs_puff (smoke billboard)
import {
  register, fill, mottle, stroke, pebbles, cracks, glaze, blurTile, range, pick, wrap, blob, ellipse,
  mix, lightOf, shadowOf, jitter, rgba, rngFrom, rowLayout, paintRects, streaks,
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
function radial(g, x, y, r0, r1, stops) {
  const gr = g.createRadialGradient(x, y, r0, x, y, r1);
  for (const [t, c, a = 1] of stops) gr.addColorStop(t, rgba(c, a));
  return gr;
}
function wrapRect(s, x, y, w, h, fn, sy = s) {
  const xs = [0], ys = [0];
  if (x < 0) xs.push(s); if (x + w > s) xs.push(-s);
  if (y < 0) ys.push(sy); if (y + h > sy) ys.push(-sy);
  for (const dx of xs) for (const dy of ys) fn(dx, dy);
}
// horizontal-only wrap (textures that tile in u but not in v)
function wrapX(s, x, r, fn) { fn(x); if (x - r < 0) fn(x + s); if (x + r > s) fn(x - s); }
// a seed that is the same for every wrapped copy of a rect
const seedAt = (s, X, Y) => (Math.round(((X % s) + s) % s) * 7919 + Math.round(((Y % s) + s) % s) * 104729) >>> 0;
// a polyline with its points jittered sideways (hand-brushed edges)
function wobbly(pts, rnd, amt, steps = 6) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    for (let k = 0; k < steps; k++) { const t = k / steps; out.push([ax + (bx - ax) * t + (rnd() - 0.5) * 2 * amt, ay + (by - ay) * t + (rnd() - 0.5) * 2 * amt]); }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

function rivet(g, x, y, r, base = '#8a8478') {
  blob(g, x + r * 0.5, y + r * 0.65, r * 1.7, r * 1.5, 0, INK, 0.45, 0.25);
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
// carved letters: a shadowed upper lip, a lit lower lip, then the paint in the cut
function carved(g, text, x, y, font, paintC, maxW) {
  g.save(); g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  const m = g.measureText(text).width, sx = maxW ? Math.min(1, maxW / m) : 1;
  g.translate(x, y); g.scale(sx, 1);
  g.fillStyle = rgba('#120c10', 0.8); g.fillText(text, -1.5, -2);
  g.fillStyle = rgba('#fff0c0', 0.4); g.fillText(text, 1.5, 2.5);
  g.fillStyle = paintC; g.fillText(text, 0, 0);
  g.restore();
}

// ---- painted steel -----------------------------------------------------------------------------
// Full-height panels (2-3 per tile, so 1.3-2 m wide on a trailer side), one global light wash, big
// soft blotches of faded paint, dark seams in the paint's own hue with a lit lip, jittered rivets
// (a few missing), wear dragged along the panel edges down to primer and bare metal, wide rust runs.

function paintedSteel(g, s, rnd, cv, { colors, primer = '#7a3a26', bare = '#8c8a84', rust = 1, dents = 5 }) {
  const [c0, c1, c2] = colors;
  fill(g, s, s, c0);
  mottle(g, s, rnd, { colors: [c1, c2], count: 4, rmin: 60, rmax: 100, alpha: 0.5, hard: 0.05 });
  mottle(g, s, rnd, { colors: [c1, c2, lightOf(c0, 0.18)], count: 16, rmin: 18, rmax: 44, alpha: 0.2, hard: 0.1 });
  const panels = rowLayout(s, rnd, { rows: 1, minW: 84, maxW: 132 });
  for (const p of panels) {
    const tone = rnd() < 0.5 ? lightOf(c0, 0.14) : shadowOf(c0, 0.12);
    wrapRect(s, p.x, 0, p.w, s, (dx) => { g.save(); g.globalAlpha = 0.16; g.fillStyle = tone; g.fillRect(p.x + dx, 0, p.w, s); g.restore(); });
  }
  // seams: the panel to the left is overlapped (soft shadow), the seam itself, the lit lip of the next panel
  const seamC = shadowOf(c0, 0.5), lipC = lightOf(c0, 0.55);
  for (const p of panels) for (const dx of [0, s, -s]) {
    const x = p.x + dx; if (x < -10 || x > s + 10) continue;
    g.fillStyle = grad(g, x - 8, 0, x, 0, [[0, seamC, 0], [1, seamC, 0.3]]); g.fillRect(x - 8, 0, 8, s);
    g.fillStyle = rgba(seamC, 0.95); g.fillRect(x - 1.5, 0, 3, s);
    g.fillStyle = rgba(lipC, 0.55); g.fillRect(x + 1.5, 0, 1, s);
  }
  // wear: horizontal scuffs dragged in from the panel edges and along the top and bottom
  const scuff = (x, y, L, w) => {
    const pts = []; for (let k = 0; k <= 5; k++) pts.push([x + L * k / 5, y + (rnd() - 0.5) * 1.6]);
    wrap(s, x + L / 2, y, L, (X, Y) => {
      const q = pts.map(([u, v]) => [u - x - L / 2 + X, v - y + Y]);
      stroke(g, q.map(([u, v]) => [u, v + 1.2]), w + 1.6, w * 0.6, shadowOf(c0, 0.35), 0.35);
      stroke(g, q, w, w * 0.4, primer, 0.85);
      if (w > 2.6) stroke(g, q.slice(1, 4), w * 0.45, w * 0.2, bare, 0.8);
      stroke(g, q.map(([u, v]) => [u, v - w * 0.55]), 1, 0.5, lightOf(c0, 0.5), 0.4);
    });
  };
  for (const p of panels) {
    for (let k = 0; k < 3; k++) { const L = range(rnd, 20, 60); scuff(rnd() < 0.5 ? p.x + 4 : p.x + p.w - 4 - L, range(rnd, 10, s - 10), L, range(rnd, 2, 4)); }
    for (const y of [range(rnd, 5, 14), range(rnd, s - 18, s - 7)]) if (rnd() < 0.7) scuff(p.x + rnd() * p.w * 0.6, y, range(rnd, 24, 60), range(rnd, 2.5, 4));
  }
  for (let i = 0; i < 7; i++) chip(g, s, rnd() * s, rnd() * s, range(rnd, 2.5, 6), rnd() < 0.6 ? primer : bare, rnd);
  for (let i = 0; i < dents; i++) dent(g, s, rnd() * s, range(rnd, 0.15, 0.85) * s, range(rnd, 12, 26), c0, 0.4);
  // rivets: columns either side of every seam, rows top and bottom; jittered, a few popped out
  const rivC = lightOf(c0, 0.15);
  const rivetAt = (x, y) => {
    if (rnd() < 0.1) { wrap(s, x, y, 4, (a, b) => { ellipse(g, a, b, 2, 2, 0, shadowOf(c0, 0.6), 0.8); }); return; }
    const X = x + range(rnd, -1.2, 1.2), Y = y + range(rnd, -3, 3);
    wrap(s, X, Y, 6, (a, b) => rivet(g, a, b, 2.4, rivC));
    if (rnd() < 0.14 * rust) rustRun(g, s, X, Y + 3, range(rnd, 16, 64), range(rnd, 4, 7), 0.42, rnd);
  };
  for (const p of panels) {
    for (let y = 14; y < s - 10; y += 20) { rivetAt(p.x + 6, y); rivetAt(p.x - 6, y); }
    for (let x = p.x + 18; x < p.x + p.w - 10; x += 21) { rivetAt(x, 6); rivetAt(x, s - 7); }
    if (rnd() < 0.6 * rust) rustRun(g, s, p.x - 1, range(rnd, 0.2, 0.6) * s, range(rnd, 30, 80), range(rnd, 4, 6), 0.35, rnd);
  }
  // one light wash over the whole sheet: sun-bleached along the top, mud and grime along the bottom
  g.fillStyle = grad(g, 0, 0, 0, s, [[0, lightOf(c0, 0.6), 0.3], [0.15, lightOf(c0, 0.6), 0], [0.75, '#4a3a2c', 0], [1, '#4a3a2c', 0.35]]); g.fillRect(0, 0, s, s);
  streaks(g, s, rnd, { colors: [shadowOf(c0, 0.3), '#5a4a3a'], count: 12, len: [30, 110], width: [2, 5], angle: Math.PI, wobble: 0.06, alpha: 0.12 });
  mottle(g, s, rnd, { colors: ['#8a4a26', '#6a4a30'], count: Math.round(6 * rust), rmin: 6, rmax: 14, alpha: 0.2, hard: 0.3 });
  glaze(g, s, s, '#ffe2b8', 0.1, 'soft-light');
  blurTile(cv, 0.5);
}
// base, sun-faded, deep: three related hues per paint
const STEEL = {
  cream: ['#d2c4a2', '#e2d8bc', '#b8a888'],
  red: ['#94392a', '#ae5a44', '#76302a'],
  blue: ['#3e5f8a', '#6a86a2', '#33496a'],
  green: ['#56703e', '#7a8c5a', '#44593a'],
  teal: ['#3e7a78', '#6a9a92', '#2f5e60'],
  mustard: ['#c08a34', '#d4aa60', '#9a6c2a'],
};
for (const [k, colors] of Object.entries(STEEL)) {
  register(`rs_steel_${k}`, { family: F, size: 256, note: `riveted painted steel (${k}): full-height panels, scuffed edges, rust runs`, paint(g, s, rnd, h, cv) { paintedSteel(g, s, rnd, cv, { colors }); } });
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
  // sheet laps: staggered sheets of uneven width, each lapping at its own height
  let x0 = Math.floor(rnd() * n);
  for (let done = 0; done < n;) {
    const wRibs = Math.min(n - done, 3 + Math.floor(rnd() * 3)), y = range(rnd, 0.1, 0.9) * s;
    for (let r = 0; r < wRibs; r++) {
      const xi = ((x0 + r) % n) * W;
      g.fillStyle = grad(g, 0, y, 0, y + 10, [[0, INK, 0.45], [1, INK, 0]]);
      for (const dy of [0, s, -s]) g.fillRect(xi, y + dy, W, 10);
      for (const dy of [0, s, -s]) line(g, [[xi, y - 1 + dy], [xi + W, y - 1 + dy]], 1.5, '#fff0d0', 0.3);
      if (r % 2 === 0) {
        wrap(s, xi + W * 0.3, y - 5, 4, (X, Y) => nail(g, X, Y, 2));
        if (rnd() < 0.45 * rust) rustRun(g, s, xi + W * 0.3, y - 3, range(rnd, 14, 50), range(rnd, 2, 4), 0.45, rnd);
      }
    }
    x0 += wRibs; done += wRibs;
  }
  for (let i = 0; i < 12 * rust; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 18);
    wrap(s, x, y, r * 1.5, (X, Y) => { blob(g, X, Y, r, r * 0.7, rnd() * 3, '#8a4a26', 0.45, 0.3); blob(g, X - r * 0.2, Y - r * 0.2, r * 0.5, r * 0.35, 0, '#b8682e', 0.35, 0.3); });
  }
  glaze(g, s, s, '#ffe2b8', 0.1, 'soft-light');
  blurTile(cv, 0.6);
}
register('rs_tin', { family: F, size: 256, note: 'galvanized corrugated tin: ribs along v, staggered sheet laps, nails, rust blooms', paint(g, s, rnd, h, cv) { tin(g, s, rnd, cv, { base: '#8e9094' }); } });
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
  family: F, size: 256, note: 'sun-grayed boards along u (trailer liners, crates, pallets, barn wood)',
  paint(g, s, rnd, h, cv) {
    boards(g, s, rnd, { rows: 4, minL: 150, maxL: 300, colors: ['#8a7e6c', '#968a76', '#7e7262', '#a09480'], gap: 4, nails: 2, grain: 10, weather: 0.6 });
    glaze(g, s, s, '#ffe8c8', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});
register('rs_timber', {
  family: F, size: 256, note: 'dark heavy timber: posts, beams, gate rails and palisade logs (grain along v)',
  paint(g, s, rnd, h, cv) {
    grainTile(g, s, rnd, { base: '#664834', dark: ['#3e2c20', '#46302a', '#3a2a28'], lite: ['#866446', '#946e50'], lines: 40, splits: 5, knots: 2 });
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// ---- metal ----------------------------------------------------------------------------------------

register('rs_iron', {
  family: F, size: 128, note: 'painted wrought iron: mid gray, warm lit dimples, rusty lows, blue-gray glints (never darker than #3a3438)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5e5a5c');
    mottle(g, s, rnd, { colors: ['#6a6466', '#524e52', '#726a66'], count: 22, rmin: 8, rmax: 26, alpha: 0.5, hard: 0.15 });
    for (let i = 0; i < 16; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 3, 7);
      wrap(s, x, y, r * 1.6, (X, Y) => { blob(g, X - r * 0.3, Y - r * 0.3, r, r * 0.8, 0, '#8e8678', 0.4, 0.3); blob(g, X + r * 0.4, Y + r * 0.4, r, r * 0.8, 0, '#46404a', 0.35, 0.3); });
    }
    mottle(g, s, rnd, { colors: ['#7a4a2c', '#8a5634', '#6e4430'], count: 10, rmin: 4, rmax: 12, alpha: 0.45, hard: 0.3 });
    streaks(g, s, rnd, { colors: ['#7c8494', '#9aa0aa'], count: 12, len: [5, 16], width: [0.6, 1.1], angle: 1.2, wobble: 0.3, alpha: 0.4 });
    glaze(g, s, s, '#ffe2b8', 0.08, 'soft-light');
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
    for (let k = 0; k < 8; k++) for (const y of [12, s / 2 + 12]) rivet(g, (k + 0.5) * s / 8 + range(rnd, -3, 3), y, 3.2, '#c8a050');
    blurTile(cv, 0.4);
  },
});

// ---- wheels -----------------------------------------------------------------------------------------

register('rs_tire', {
  family: F, size: 128, note: 'chunky rubber tread (u around the tire, v across it): big chevron lugs, dust in the grooves',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#2a2426');
    const n = 4, W = s / n;
    for (let i = 0; i < n; i++) {
      for (const side of [-1, 1]) {
        const x0 = i * W + (side > 0 ? W * 0.5 : 0), yc = s / 2;
        const pts = [[x0 + 3, yc + side * 4], [x0 + W * 0.66, yc + side * 4], [x0 + W * 0.82, yc + side * (s / 2 - 2)], [x0 + W * 0.08, yc + side * (s / 2 - 2)]];
        wrap(s, x0 + W * 0.4, yc, W, (X) => {
          const q = pts.map(([u, v]) => [u - x0 - W * 0.4 + X, v]);
          polyPath(g, q.map(([u, v]) => [u + 2, v + 3])); g.fillStyle = rgba('#120e10', 0.6); g.fill();
          polyPath(g, q); g.fillStyle = grad(g, 0, yc - s / 2, 0, yc + s / 2, [[0, '#5e5658'], [0.5, '#4c4648'], [1, '#3c3638']]); g.fill();
          line(g, [q[0], q[1]], 3, '#857c7c', 0.6);
          line(g, [q[3], q[0]], 2, '#6a6264', 0.5);
        });
      }
    }
    mottle(g, s, rnd, { colors: ['#7a6a52', '#5a4c3e'], count: 18, rmin: 4, rmax: 14, alpha: 0.35, hard: 0.2 });
    blurTile(cv, 0.6);
  },
});
function hubFace(g, s, rnd, { rim = '#94392a', cap = '#c8a050', tireEdge = 0.22 }) {
  const c = s / 2;
  fill(g, s, s, '#2e2a2c');
  const R = c - 1;
  g.fillStyle = radial(g, c - 10, c - 10, R * 0.3, R, [[0, '#4a4446'], [0.8, '#3a3436'], [1, '#262224']]);
  g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
  for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; line(g, [[c + Math.cos(a) * R * 0.86, c + Math.sin(a) * R * 0.86], [c + Math.cos(a) * R * 0.98, c + Math.sin(a) * R * 0.98]], 2, '#5a5254', 0.5); }
  const r1 = R * (1 - tireEdge);
  g.fillStyle = radial(g, c - r1 * 0.3, c - r1 * 0.3, r1 * 0.1, r1, [[0, lightOf(rim, 0.35)], [0.7, rim], [1, shadowOf(rim, 0.5)]]);
  g.beginPath(); g.arc(c, c, r1, 0, TAU); g.fill();
  g.lineWidth = 3; g.strokeStyle = rgba(lightOf(rim, 0.6), 0.6); g.beginPath(); g.arc(c, c, r1 - 3, Math.PI * 1.0, Math.PI * 1.6); g.stroke();
  g.strokeStyle = rgba(INK, 0.5); g.beginPath(); g.arc(c, c, r1 - 3, Math.PI * 0.05, Math.PI * 0.65); g.stroke();
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + 0.3; ellipse(g, c + Math.cos(a) * r1 * 0.62, c + Math.sin(a) * r1 * 0.62, r1 * 0.13, r1 * 0.1, a, '#1e1a1c'); blob(g, c + Math.cos(a) * r1 * 0.62 + 2, c + Math.sin(a) * r1 * 0.62 + 2, r1 * 0.1, r1 * 0.07, a, lightOf(rim, 0.4), 0.35, 0.4); }
  for (let i = 0; i < 8; i++) { const a = rnd() * TAU, d = range(rnd, 0.3, 0.9) * r1; blob(g, c + Math.cos(a) * d, c + Math.sin(a) * d, range(rnd, 2, 6), range(rnd, 2, 4), rnd() * 3, '#7a4026', 0.5, 0.4); }
  const r2 = r1 * 0.36;
  g.fillStyle = radial(g, c - r2 * 0.4, c - r2 * 0.4, 1, r2, [[0, '#f2dc98'], [0.5, cap], [1, '#6a4e22']]);
  g.beginPath(); g.arc(c, c, r2, 0, TAU); g.fill();
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; rivet(g, c + Math.cos(a) * r2 * 1.35, c + Math.sin(a) * r2 * 1.35, 3.2, '#9a9488'); }
  blurTile(g.canvas, 0.4);
}
register('rs_hub', { family: F, size: 128, note: 'wheel face (fitted, circle): rubber sidewall, red steel rim, brass hub cap, lug nuts', paint(g, s, rnd) { hubFace(g, s, rnd, {}); } });
register('rs_hub_cream', { family: F, size: 128, note: 'wheel face: cream rim', paint(g, s, rnd) { hubFace(g, s, rnd, { rim: '#c8b890', cap: '#b8b0a0' }); } });

// ---- glass, grille, lamps ----------------------------------------------------------------------------

register('rs_glass', {
  family: F, w: 256, h: 128, note: 'dusty windshield glass, two panes side by side (fitted with a uv rect): sky streaks, grime, a different crack in each',
  paint(g, w, rnd, h) {
    for (let p = 0; p < 2; p++) {
      const X = p * h, s = h;
      g.save(); g.beginPath(); g.rect(X, 0, s, s); g.clip();
      g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#7e9eaa'], [0.45, '#43606c'], [1, '#2e3a44']]); g.fillRect(X, 0, s, s);
      for (const [x, ww] of [[0.18, 0.16], [0.46, 0.06], [0.62, 0.1]]) {
        g.save(); g.globalAlpha = 0.28; g.fillStyle = '#e8f2f0';
        const xx = x + p * 0.11;
        polyPath(g, [[X + s * xx, 0], [X + s * (xx + ww), 0], [X + s * (xx + ww - 0.35), s], [X + s * (xx - 0.35), s]]); g.fill(); g.restore();
      }
      g.fillStyle = grad(g, 0, s * 0.7, 0, s, [[0, '#8a7a5a', 0], [1, '#8a7a5a', 0.55]]); g.fillRect(X, 0, s, s);
      for (const [x, y] of [[0, 0], [s, 0], [0, s], [s, s]]) blob(g, X + x, y, s * 0.3, s * 0.3, 0, '#7a6a4a', 0.45, 0.2);
      if (p === 0) {
        line(g, [[X + s * 0.7, s * 0.2], [X + s * 0.76, s * 0.34], [X + s * 0.72, s * 0.5], [X + s * 0.8, s * 0.62]], 1.4, '#e8f0f0', 0.6);
        line(g, [[X + s * 0.76, s * 0.34], [X + s * 0.9, s * 0.38]], 1.2, '#e8f0f0', 0.5);
      } else {
        // a stone chip low on the pane with a little starburst
        const cx = X + s * 0.28, cy = s * 0.72;
        ellipse(g, cx, cy, 3, 3, 0, '#f0f6f4', 0.8);
        for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + rnd() * 0.5, L = range(rnd, 8, 22); line(g, [[cx, cy], [cx + Math.cos(a) * L * 0.5 + (rnd() - 0.5) * 3, cy + Math.sin(a) * L * 0.5], [cx + Math.cos(a) * L, cy + Math.sin(a) * L]], 1.1, '#e8f0f0', 0.55); }
      }
      g.lineWidth = 5; g.strokeStyle = rgba('#2e282c', 0.9); g.strokeRect(X + 2.5, 2.5, s - 5, s - 5);
      g.restore();
    }
    blurTile(g.canvas, 0.6);
  },
});
register('rs_grille', {
  family: F, size: 256, note: 'cab-over truck front (fitted): brass-framed grille slats, rivets, a goblin cog badge',
  paint(g, s, rnd) {
    fill(g, s, s, '#2a2228');
    g.fillStyle = grad(g, 0, 0, s, s, [[0, '#e0c070'], [0.5, '#b08a3c'], [1, '#6a4e22']]);
    g.fillRect(0, 0, s, s);
    const m = 22;
    g.fillStyle = '#241e22'; g.fillRect(m, m, s - 2 * m, s - 2 * m);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const x = m + 4 + i * (s - 2 * m - 8) / n, w = (s - 2 * m - 8) / n - 6;
      g.fillStyle = grad(g, x, 0, x + w, 0, [[0, '#d8c080'], [0.35, '#a8843a'], [1, '#4a3618']]);
      g.fillRect(x, m + 4, w, s - 2 * m - 8);
    }
    g.fillStyle = grad(g, 0, s / 2 - 12, 0, s / 2 + 12, [[0, '#f0d890'], [0.5, '#a8843a'], [1, '#4a3618']]); g.fillRect(m, s / 2 - 12, s - 2 * m, 24);
    const c = s / 2;
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; ellipse(g, c + Math.cos(a) * 26, c + Math.sin(a) * 26, 8, 6, a, '#8a6a2c'); }
    g.fillStyle = radial(g, c - 8, c - 8, 2, 26, [[0, '#f8e8a8'], [0.6, '#c8a050'], [1, '#5a4018']]);
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
    g.fillStyle = radial(g, c - 8, c - 8, 2, c, [[0, '#fff8d8'], [0.45, '#e8c878'], [0.85, '#a87a3a'], [1, '#5a4018']]);
    g.beginPath(); g.arc(c, c, c - 2, 0, TAU); g.fill();
    blob(g, c - 9, c - 10, 7, 4, -0.6, '#ffffff', 0.85, 0.4);
  },
});

// ---- cloth ------------------------------------------------------------------------------------------

register('rs_gingham', {
  family: F, size: 256, note: 'red gingham tablecloth: big soft woven checks (about 20 cm), fold shadows, a few stains',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e2d4b6');
    const n = 3, W = s / n;
    g.save(); g.globalAlpha = 0.5; g.fillStyle = '#a23a30';
    for (let i = 0; i < n; i++) { g.fillRect(i * W, 0, W / 2, s); g.fillRect(0, i * W, s, W / 2); }
    g.restore();
    // weave: short slanted threads, denser along the stripes
    for (let i = 0; i < 900; i++) { const x = rnd() * s, y = rnd() * s, c = rnd() < 0.5 ? '#7a2a24' : '#fff4dc'; wrap(s, x, y, 3, (X, Y) => line(g, [[X, Y], [X + 2.5, Y + 1.2]], 0.9, c, 0.14)); }
    // folds: soft long waves of light and shadow, two directions
    for (let i = 0; i < 4; i++) {
      const x = rnd() * s, w = range(rnd, 26, 50);
      for (const dx of [-s, 0, s]) { g.fillStyle = grad(g, x + dx - w, 0, x + dx + w, 0, [[0, INK, 0], [0.45, INK, 0.2], [0.6, '#fff4dc', 0.2], [1, '#fff4dc', 0]]); g.fillRect(x + dx - w, 0, w * 2, s); }
    }
    for (let i = 0; i < 2; i++) {
      const y = rnd() * s, w = range(rnd, 20, 40);
      for (const dy of [-s, 0, s]) { g.fillStyle = grad(g, 0, y + dy - w, 0, y + dy + w, [[0, INK, 0], [0.5, INK, 0.12], [0.65, '#fff4dc', 0.12], [1, '#fff4dc', 0]]); g.fillRect(0, y + dy - w, s, w * 2); }
    }
    for (let i = 0; i < 4; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 8, 18); wrap(s, x, y, r * 1.5, (X, Y) => blob(g, X, Y, r, r * 0.7, rnd() * 3, '#8a6a40', 0.22, 0.4)); }
    glaze(g, s, s, '#ffe8c8', 0.1, 'soft-light');
    blurTile(cv, 1.2);
  },
});
register('rs_burlap', {
  family: F, size: 256, note: 'coarse burlap sacking (Westfall tablecloths): visible weave, stencil ghost, stains, folds',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#b4966a');
    mottle(g, s, rnd, { colors: ['#c4a678', '#a08458', '#bc9e6c'], count: 26, rmin: 18, rmax: 56, alpha: 0.35, hard: 0.1 });
    for (let y = 0; y < s; y += 4) line(g, [[0, y + 1], [s, y + 1]], 1.6, rnd() < 0.5 ? '#8a6c44' : '#d2b688', 0.22);
    for (let x = 0; x < s; x += 4) line(g, [[x + 1, 0], [x + 1, s]], 1.4, rnd() < 0.5 ? '#7a5e3a' : '#d8bc8e', 0.18);
    letters(g, 'WESTFALL', s / 2, s * 0.42, { font: FONT(34), color: '#6a3a2a', alpha: 0.28, worn: 0.6, rnd, maxW: s * 0.8, under: '#b4966a' });
    letters(g, 'FINE FLOUR', s / 2, s * 0.56, { font: FONT(20), color: '#6a3a2a', alpha: 0.25, worn: 0.5, rnd, maxW: s * 0.6, under: '#b4966a' });
    for (let i = 0; i < 3; i++) {
      const x = rnd() * s, w = range(rnd, 24, 44);
      for (const dx of [-s, 0, s]) { g.fillStyle = grad(g, x + dx - w, 0, x + dx + w, 0, [[0, INK, 0], [0.45, INK, 0.2], [0.6, '#fff4dc', 0.16], [1, '#fff4dc', 0]]); g.fillRect(x + dx - w, 0, w * 2, s); }
    }
    for (let i = 0; i < 4; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 10, 22); wrap(s, x, y, r * 1.5, (X, Y) => blob(g, X, Y, r, r * 0.7, rnd() * 3, '#6a5034', 0.2, 0.3)); }
    glaze(g, s, s, '#ffe8c8', 0.1, 'soft-light');
    blurTile(cv, 0.8);
  },
});
register('rs_plaid', {
  family: F, size: 256, note: 'dwarven wool plaid (Dun Morogh tablecloths): muted green and red tartan, soft weave, folds',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#3e5a46');
    const bands = [[0, 46, '#2e4636', 0.6], [70, 20, '#8e3a2c', 0.7], [104, 8, '#d6c6a0', 0.6], [140, 46, '#2e4636', 0.6], [200, 14, '#8e3a2c', 0.55], [232, 6, '#c8963a', 0.5]];
    for (const [o, w, c, a] of bands) {
      g.save(); g.globalAlpha = a; g.fillStyle = c; g.fillRect(o, 0, w, s); g.restore();
      g.save(); g.globalAlpha = a * 0.8; g.fillStyle = c; g.fillRect(0, o, s, w); g.restore();
    }
    for (let i = 0; i < 1200; i++) { const x = rnd() * s, y = rnd() * s, c = rnd() < 0.5 ? '#1e2a22' : '#e8dcc0'; wrap(s, x, y, 3, (X, Y) => line(g, [[X, Y], [X + 2.5, Y - 1.2]], 0.9, c, 0.13)); }
    for (let i = 0; i < 4; i++) {
      const x = rnd() * s, w = range(rnd, 26, 48);
      for (const dx of [-s, 0, s]) { g.fillStyle = grad(g, x + dx - w, 0, x + dx + w, 0, [[0, INK, 0], [0.45, INK, 0.22], [0.6, '#fff4dc', 0.14], [1, '#fff4dc', 0]]); g.fillRect(x + dx - w, 0, w * 2, s); }
    }
    glaze(g, s, s, '#ffe8c8', 0.1, 'soft-light');
    blurTile(cv, 1.0);
  },
});
function canvasStripes(g, s, rnd, cv, cols) {
  const n = 8, W = s / n;
  for (let i = 0; i < n; i++) { g.fillStyle = cols[i % cols.length]; g.fillRect(i * W, 0, W, s); }
  mottle(g, s, rnd, { colors: ['#f0e4c8', '#8a6a50', '#c8b490'], count: 30, rmin: 10, rmax: 40, alpha: 0.18, hard: 0.1 });
  for (let i = 0; i < n; i++) {
    g.fillStyle = grad(g, i * W, 0, i * W + W, 0, [[0, INK, 0.2], [0.2, '#fff4dc', 0.15], [0.55, '#fff4dc', 0], [1, INK, 0.22]]);
    g.fillRect(i * W, 0, W, s);
    line(g, [[i * W, 0], [i * W, s]], 1.6, '#4a3028', 0.45);
  }
  g.save(); g.setLineDash([5, 4]); line(g, [[0, s - 12], [s, s - 12]], 1.4, '#3a2a24', 0.5); g.restore();
  streaks(g, s, rnd, { colors: ['#7a5a40'], count: 8, len: [20, 60], width: [3, 7], angle: Math.PI, wobble: 0.1, alpha: 0.12 });
  glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
  blurTile(cv, 0.6);
}
register('rs_canvas', { family: F, size: 256, note: 'faded red/cream canvas: stripes along u, bellied panels, hem', paint(g, s, rnd, h, cv) { canvasStripes(g, s, rnd, cv, ['#a8463a', '#e0d2b2']); } });
register('rs_canvas_blue', { family: F, size: 256, note: 'faded blue/cream canvas', paint(g, s, rnd, h, cv) { canvasStripes(g, s, rnd, cv, ['#3e5a7e', '#e0d2b2']); } });
register('rs_hide', {
  family: F, size: 256, note: 'stitched hides (Badlands roofs, banners, tablecloths): big tan and umber skins with wobbly sewn seams, wrinkles, scuffs, dark edges',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#9a7048');
    mottle(g, s, rnd, { colors: ['#b48a5c', '#86603c', '#a87e52', '#7a5434'], count: 26, rmin: 26, rmax: 70, alpha: 0.45, hard: 0.06 });
    // wrinkles: soft curved creases, dark below and lit above
    for (let i = 0; i < 16; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 20, 50), a = rnd() * TAU, b = range(rnd, -0.5, 0.5);
      const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6, aa = a + b * t; pts.push([x + Math.cos(aa) * L * t, y + Math.sin(aa) * L * t]); }
      wrap(s, x, y, L + 4, (X, Y) => { const q = pts.map(([u, v]) => [u - x + X, v - y + Y]); stroke(g, q.map(([u, v]) => [u, v + 1.5]), 2.4, 0.6, '#5a3a24', 0.35); stroke(g, q.map(([u, v]) => [u, v - 1]), 1.6, 0.4, '#d8b080', 0.3); });
    }
    // seams between the skins: wobbly lines around the tile, darkened edges each side, thong stitches across
    const seam = pts => {
      for (const [dx, dy] of [[0, 0], [s, 0], [-s, 0], [0, s], [0, -s]]) {
        const q = pts.map(([u, v]) => [u + dx, v + dy]);
        line(g, q, 10, '#5a3a24', 0.35); line(g, q, 3, '#3a281c', 0.8);
        for (let i = 0; i < q.length - 1; i++) {
          const [ax, ay] = q[i], [bx, by] = q[i + 1], l = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / l, ny = (bx - ax) / l;
          for (let t = 4; t < l; t += 9) { const px = ax + (bx - ax) * t / l, py = ay + (by - ay) * t / l; line(g, [[px - nx * 5, py - ny * 5], [px + nx * 5, py + ny * 5]], 2, '#e0c49a', 0.75); }
        }
      }
    };
    const y0 = range(rnd, 0.2, 0.4) * s, y1 = range(rnd, 0.65, 0.85) * s;
    seam([[0, y0], [s * 0.3, y0 + range(rnd, -10, 10)], [s * 0.65, y0 + range(rnd, -12, 12)], [s, y0]]);
    seam([[0, y1], [s * 0.35, y1 + range(rnd, -10, 10)], [s * 0.7, y1 + range(rnd, -12, 12)], [s, y1]]);
    const x0 = range(rnd, 0.3, 0.7) * s;
    seam([[x0, y0], [x0 + range(rnd, -12, 12), (y0 + y1) / 2], [x0 + range(rnd, -8, 8), y1]]);
    for (let i = 0; i < 6; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 20, (X, Y) => blob(g, X, Y, range(rnd, 8, 18), range(rnd, 5, 10), rnd() * 3, '#c89a68', 0.3, 0.3)); }
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.6);
  },
});
register('rs_rope', {
  family: F, size: 128, note: 'twisted hemp rope (u around, v along): lit strands, dark twist grooves',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#6a5030');
    const n = 6, P = s / n, sh = P * 3;
    g.save(); g.setTransform(1, 0, -sh / s, 1, 0, 0);
    for (let k = -1; k < n + 4; k++) {
      const x = k * P;
      g.fillStyle = grad(g, x, 0, x + P, 0, [[0, '#4a3826'], [0.2, '#d8bc8a'], [0.5, '#b0905e'], [0.85, '#7a5e3c'], [1, '#4a3826']]);
      g.fillRect(x, 0, P, s);
    }
    g.restore();
    streaks(g, s, rnd, { colors: ['#e8d4a8', '#6a5030'], count: 40, len: [6, 18], width: [0.6, 1.2], angle: 2.68, wobble: 0.2, alpha: 0.3 });
    blurTile(cv, 0.6);
  },
});

// ---- the crashed flying machine -------------------------------------------------------------------------

register('rs_wing', {
  family: F, size: 256, note: 'doped canvas over wing ribs (ribs along v, 3 per tile): sagging lit bays, shadow under each rib, patches, scorch blooms, ragged tears',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#d9c9a0');
    mottle(g, s, rnd, { colors: ['#e2d4ae', '#c8b68a', '#d4c296'], count: 30, rmin: 18, rmax: 56, alpha: 0.3, hard: 0.08 });
    const n = 3, W = s / n;
    for (let i = 0; i < n; i++) {
      const x = i * W;
      // the fabric sags between the ribs: a light swell in the middle of the bay, darker beside the ribs
      g.fillStyle = grad(g, x, 0, x + W, 0, [[0, '#9c8866', 0.5], [0.12, '#9c8866', 0.1], [0.45, '#efe2c0', 0.55], [0.75, '#efe2c0', 0.15], [0.95, '#9c8866', 0.25], [1, '#9c8866', 0.35]]);
      g.fillRect(x, 0, W, s);
    }
    for (let i = 0; i <= n; i++) {
      const x = i * W;
      g.fillStyle = grad(g, x - 5, 0, x + 5, 0, [[0, '#efe2c0', 0.85], [0.5, '#e2d2a8', 0.9], [1, '#a89068', 0.9]]); g.fillRect(x - 5, 0, 10, s);
      g.fillStyle = grad(g, x + 5, 0, x + 12, 0, [[0, '#9c8866', 0.55], [1, '#9c8866', 0]]); g.fillRect(x + 5, 0, 7, s);
      g.save(); g.setLineDash([3, 5]); line(g, [[x - 3, 0], [x - 3, s]], 0.9, '#7a6040', 0.4); line(g, [[x + 3, 0], [x + 3, s]], 0.9, '#7a6040', 0.4); g.restore();
    }
    // repair patches
    for (let i = 0; i < 2; i++) {
      const x = rnd() * s, y = rnd() * s, w = range(rnd, 24, 40), hh = range(rnd, 18, 32), c = pick(rnd, ['#c8a878', '#e2d6b0', '#b89870']), rot = range(rnd, -0.15, 0.15);
      wrapRect(s, x, y, w, hh, (dx, dy) => {
        g.save(); g.translate(x + dx, y + dy); g.rotate(rot);
        g.fillStyle = INK; g.globalAlpha = 0.25; g.fillRect(2, 3, w, hh);
        g.globalAlpha = 1; g.fillStyle = grad(g, 0, 0, w, hh, [[0, lightOf(c, 0.25)], [1, shadowOf(c, 0.15)]]); g.fillRect(0, 0, w, hh);
        g.setLineDash([3, 3]); g.strokeStyle = rgba('#5a4430', 0.6); g.lineWidth = 1; g.strokeRect(3, 3, w - 6, hh - 6);
        g.restore();
      });
    }
    // scorch: soft brown-black blooms with a warm singed rim
    for (let i = 0; i < 3; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 18, 36);
      wrap(s, x, y, r * 1.6, (X, Y) => { blob(g, X, Y, r * 1.4, r, rnd() * 3, '#8a6a40', 0.3, 0.1); blob(g, X, Y, r, r * 0.75, rnd() * 3, '#4a3424', 0.42, 0.15); blob(g, X + r * 0.1, Y, r * 0.5, r * 0.35, 0, '#2e2420', 0.4, 0.25); });
    }
    streaks(g, s, rnd, { colors: ['#6a5640'], count: 8, len: [20, 70], width: [2, 5], angle: Math.PI / 2, wobble: 0.15, alpha: 0.14 });
    // a tear: a dark soft hole, the torn fabric edges curling up and catching the light
    for (let i = 0; i < 1; i++) {
      const x = range(rnd, 0.25, 0.75) * s, y = rnd() * s, r = range(rnd, 16, 22);
      const pts = []; for (let k = 0; k < 14; k++) { const a = k / 14 * TAU, rr = r * range(rnd, 0.55, 1.15); pts.push([Math.cos(a) * rr * 0.7, Math.sin(a) * rr * 1.3]); }
      wrap(s, x, y, r * 2, (X, Y) => {
        g.save(); g.translate(X, Y);
        blob(g, 0, 0, r * 1.5, r * 1.8, 0, '#6a5640', 0.35, 0.2);
        polyPath(g, pts); g.fillStyle = radial(g, -r * 0.2, -r * 0.3, 1, r * 1.3, [[0, '#2e221a'], [1, '#4e3c2a']]); g.fill();
        g.lineWidth = 3; g.strokeStyle = rgba('#f4e8c8', 0.75); g.stroke();
        g.lineWidth = 1.2; g.strokeStyle = rgba('#8a7050', 0.7); polyPath(g, pts.map(([u, v]) => [u * 1.12, v * 1.08])); g.stroke();
        g.restore();
      });
    }
    glaze(g, s, s, '#ffe0b0', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});
register('rs_pennant', {
  family: F, w: 128, h: 64, alpha: true, note: 'a tattered red pennant with a cream stripe (alpha, fitted): swallowtail, frayed holes',
  paint(g, w, rnd, h) {
    const pts = [[2, 4], [w - 4, 14], [w - 22, h / 2], [w - 2, h - 12], [2, h - 4]];
    polyPath(g, pts); g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#b04a36'], [0.5, '#9a3a2c'], [1, '#6e2a22']]); g.fill();
    g.save(); polyPath(g, pts); g.clip();
    g.fillStyle = rgba('#e0d0a8', 0.95); g.fillRect(0, h * 0.42, w, h * 0.14);
    for (let i = 0; i < 4; i++) { const x = range(rnd, 10, w - 20); g.fillStyle = grad(g, x - 8, 0, x + 8, 0, [[0, INK, 0], [0.5, INK, 0.25], [1, '#fff0d0', 0]]); g.fillRect(x - 8, 0, 16, h); }
    g.restore();
    g.save(); g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 9; i++) { const x = range(rnd, 0.35, 1) * w, y = rnd() * h; ellipse(g, x, y, range(rnd, 2, 6), range(rnd, 2, 5), rnd() * 3, '#000', 1); }
    for (let x = 6; x < w; x += 5) { ellipse(g, x, 4 + (x / w) * 10 + rnd() * 2, 2, 2.5, 0, '#000', 1); ellipse(g, x, h - 4 - (x / w) * 8 - rnd() * 2, 2, 2.5, 0, '#000', 1); }
    g.restore();
    g.fillStyle = '#4a3a2c'; g.fillRect(0, 0, 5, h);
  },
});

// ---- junk: crates, barrels, drums, scrap ----------------------------------------------------------------

function crateFace(g, s, rnd, { woods, frame, text, sub = null, ink = '#2a2228', mark = null, band = null }) {
  fill(g, s, s, '#1e1418');
  for (let i = 0; i < 4; i++) plank(g, 0, i * s / 4 + 1, s, s / 4 - 2, jitter(pick(rnd, woods), rnd, 0.06), rnd, { grain: 7, bevel: 3 });
  if (band) { g.fillStyle = grad(g, 0, s * 0.3, 0, s * 0.72, [[0, lightOf(band, 0.2)], [1, shadowOf(band, 0.2)]]); g.globalAlpha = 0.85; g.fillRect(0, s * 0.3, s, s * 0.42); g.globalAlpha = 1; for (let i = 0; i < 8; i++) blob(g, rnd() * s, range(rnd, 0.3, 0.72) * s, range(rnd, 4, 12), range(rnd, 3, 8), rnd() * 3, woods[0], 0.6, 0.4); }
  if (text) letters(g, text, s / 2, s * (sub ? 0.44 : 0.5), { font: FONT(text.length > 4 ? 50 : 70), color: ink, alpha: 0.8, worn: 0.6, rnd, maxW: s * 0.7, under: woods[0] });
  if (sub) letters(g, sub, s / 2, s * 0.64, { font: FONT(24), color: ink, alpha: 0.75, worn: 0.4, rnd, maxW: s * 0.62, under: woods[0] });
  if (mark) mark(g, s);
  const fr = 26;
  for (const [x, y, w, hh, v] of [[0, 0, s, fr, false], [0, s - fr, s, fr, false], [0, 0, fr, s, true], [s - fr, 0, fr, s, true]]) plank(g, x, y, w, hh, jitter(frame, rnd, 0.05), rnd, { vertical: v, grain: 5, bevel: 3 });
  for (const [x, y] of [[13, 13], [s - 13, 13], [13, s - 13], [s - 13, s - 13], [s / 2, 13], [s / 2, s - 13]]) nail(g, x, y, 3);
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
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, INK, 0.4], [0.2, INK, 0], [0.75, INK, 0], [1, INK, 0.45]]); g.fillRect(0, 0, s, s);
    for (const y of [s * 0.08, s * 0.22, s * 0.78, s * 0.92]) {
      g.fillStyle = grad(g, 0, y - 8, 0, y + 8, [[0, '#9a96a0'], [0.35, '#6a6670'], [1, '#3a3640']]); g.fillRect(0, y - 8, s, 16);
      for (let k = 0; k < n; k++) rivet(g, (k + 0.5) * W, y, 2.4, '#7a7680');
      for (let k = 0; k < 4; k++) blob(g, rnd() * s, y + 4, range(rnd, 6, 16), 4, 0, '#8a4a26', 0.5, 0.3);
    }
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(g.canvas, 0.4);
  },
});
register('rs_barrel_lid', {
  family: F, size: 128, note: 'barrel head (fitted, circle): boards across, a lit iron chime, a dark recessed ring, a brass bung',
  paint(g, s, rnd) {
    const c = s / 2;
    fill(g, s, s, '#3a3036');
    g.save(); g.beginPath(); g.arc(c, c, c - 8, 0, TAU); g.clip();
    for (let i = 0; i < 5; i++) plank(g, 0, i * s / 5, s, s / 5 - 1, jitter('#8e6844', rnd, 0.08), rnd, { grain: 5, bevel: 2 });
    g.fillStyle = radial(g, c, c, c * 0.55, c, [[0, INK, 0], [1, INK, 0.55]]); g.fillRect(0, 0, s, s);
    g.restore();
    g.lineWidth = 9; g.strokeStyle = '#5e5a5c'; g.beginPath(); g.arc(c, c, c - 4.5, 0, TAU); g.stroke();
    g.lineWidth = 3; g.strokeStyle = rgba('#b8b0a4', 0.8); g.beginPath(); g.arc(c, c, c - 3, Math.PI * 0.95, Math.PI * 1.65); g.stroke();
    g.lineWidth = 2.5; g.strokeStyle = rgba('#241c20', 0.7); g.beginPath(); g.arc(c, c, c - 9, 0, TAU); g.stroke();
    const bx = c + 22, by = c - 14;
    ellipse(g, bx + 2, by + 3, 10, 10, 0, INK, 0.5);
    g.fillStyle = radial(g, bx - 3, by - 3, 1, 9, [[0, '#f2dc98'], [0.6, '#b08a3c'], [1, '#5a4018']]); g.beginPath(); g.arc(bx, by, 9, 0, TAU); g.fill();
    line(g, [[bx - 5, by], [bx + 5, by]], 2, '#4a3418', 0.8);
  },
});
function drum(g, s, rnd, { paint, label, labelCol = '#e8dcc0' }) {
  fill(g, s, s, paint);
  mottle(g, s, rnd, { colors: [lightOf(paint, 0.2), shadowOf(paint, 0.25)], count: 24, rmin: 10, rmax: 40, alpha: 0.35, hard: 0.1 });
  for (const y of [s * 0.33, s * 0.66]) { g.fillStyle = grad(g, 0, y - 9, 0, y + 9, [[0, lightOf(paint, 0.55)], [0.4, paint], [1, shadowOf(paint, 0.6)]]); g.fillRect(0, y - 9, s, 18); }
  for (const [y, d] of [[0, 1], [s, -1]]) { g.fillStyle = grad(g, 0, y, 0, y + d * 14, [[0, '#3a3438'], [0.5, shadowOf(paint, 0.4)], [1, shadowOf(paint, 0.1), 0]]); g.fillRect(0, Math.min(y, y + d * 14), s, 14); }
  letters(g, label, s * 0.3, s * 0.5, { font: FONT(34), color: labelCol, alpha: 0.85, worn: 0.6, rnd, maxW: s * 0.36, under: paint });
  for (let i = 0; i < 12; i++) chip(g, s, rnd() * s, rnd() * s, range(rnd, 3, 8), '#5a3a2a', rnd);
  for (let i = 0; i < 8; i++) rustRun(g, s, rnd() * s, rnd() * s * 0.6, range(rnd, 20, 60), range(rnd, 2, 5), 0.4, rnd);
  for (let i = 0; i < 4; i++) dent(g, s, rnd() * s, range(rnd, 0.2, 0.8) * s, range(rnd, 12, 24), paint, 0.5);
  g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#fff0c8', 0.1], [0.5, '#fff0c8', 0], [1, '#5a3a24', 0.3]]); g.fillRect(0, 0, s, s);
  blurTile(g.canvas, 0.5);
}
register('rs_drum', { family: F, size: 256, note: 'steel oil drum (fitted: u around, v top→bottom): teal paint, rolled ribs, stencil OIL, rust', paint(g, s, rnd) { drum(g, s, rnd, { paint: '#3e6a72', label: 'OIL' }); } });
register('rs_drum_red', { family: F, size: 256, note: 'steel drum, red paint, stencil FUEL', paint(g, s, rnd) { drum(g, s, rnd, { paint: '#94392a', label: 'FUEL' }); } });
register('rs_drum_lid', {
  family: F, size: 128, note: 'steel drum head (fitted, circle): lit rolled rim, dark recessed ring, a brass bung and a vent cap, rust in the low ring',
  paint(g, s, rnd) {
    const c = s / 2;
    fill(g, s, s, '#4a4648');
    g.fillStyle = radial(g, c - 14, c - 14, 6, c, [[0, '#8e8a86'], [0.7, '#6e6a6a'], [1, '#4e4a4c']]); g.beginPath(); g.arc(c, c, c - 2, 0, TAU); g.fill();
    g.lineWidth = 7; g.strokeStyle = rgba('#3c383c', 0.9); g.beginPath(); g.arc(c, c, c - 13, 0, TAU); g.stroke();
    g.lineWidth = 2; g.strokeStyle = rgba('#a8a29a', 0.7); g.beginPath(); g.arc(c, c, c - 9, Math.PI * 0.9, Math.PI * 1.7); g.stroke();
    g.lineWidth = 5; g.strokeStyle = rgba('#c8c0b2', 0.75); g.beginPath(); g.arc(c, c, c - 4, Math.PI * 0.95, Math.PI * 1.65); g.stroke();
    g.strokeStyle = rgba('#2e2a2e', 0.6); g.beginPath(); g.arc(c, c, c - 4, Math.PI * 0.05, Math.PI * 0.7); g.stroke();
    for (let i = 0; i < 8; i++) { const a = rnd() * TAU; blob(g, c + Math.cos(a) * (c - 13), c + Math.sin(a) * (c - 13), range(rnd, 4, 9), 3, a, '#8a4a26', 0.55, 0.3); }
    const bx = c + 20, by = c - 16;
    ellipse(g, bx + 2, by + 3, 11, 11, 0, INK, 0.45);
    g.fillStyle = radial(g, bx - 3, by - 3, 1, 10, [[0, '#f2dc98'], [0.6, '#b08a3c'], [1, '#5a4018']]); g.beginPath(); g.arc(bx, by, 10, 0, TAU); g.fill();
    for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; ellipse(g, bx + Math.cos(a) * 6, by + Math.sin(a) * 6, 1.4, 1.4, 0, '#5a4018'); }
    ellipse(g, c - 22, c + 18, 6, 6, 0, '#3a3438'); blob(g, c - 24, c + 16, 3, 3, 0, '#a8a29a', 0.7, 0.4);
    blurTile(g.canvas, 0.4);
  },
});

register('rs_scrap', {
  family: F, size: 256, note: 'scrap heap fill (tiles): dark warm soil, a few big rusty plates lit from the upper left, deep soft shadows, one chipped red accent',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#4a3a2c');
    mottle(g, s, rnd, { colors: ['#5a4634', '#3a2e24', '#62503a'], count: 18, rmin: 30, rmax: 70, alpha: 0.5, hard: 0.08 });
    pebbles(g, s, rnd, { colors: ['#5a4a3c', '#6a5a48', '#4a4038'], count: 30, rmin: 2, rmax: 5 });
    const plates = 7;
    for (let i = 0; i < plates; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 30, 56), a = rnd() * TAU;
      const red = i === 0, c = red ? '#94392a' : jitter(pick(rnd, ['#7a4a2e', '#8a5634', '#6e4430', '#6a6670', '#7a5a3a']), rnd, 0.06);
      const pts = []; const n = 4 + Math.floor(rnd() * 2);
      for (let k = 0; k < n; k++) { const t = a + k / n * TAU + range(rnd, -0.25, 0.25), rr = r * range(rnd, 0.75, 1.1); pts.push([Math.cos(t) * rr, Math.sin(t) * rr * 0.6]); }
      const ribbed = !red && rnd() < 0.35, riv = rnd() < 0.5, rs = Math.floor(rnd() * 1e9);
      wrap(s, x, y, r * 1.6, (X, Y) => {
        const pr = rngFrom(rs);
        g.save(); g.translate(X, Y);
        blob(g, r * 0.25, r * 0.35, r * 1.3, r * 0.9, 0, '#140e0c', 0.6, 0.2);
        polyPath(g, pts); g.fillStyle = grad(g, -r, -r, r, r, [[0, lightOf(c, 0.4)], [0.5, c], [1, shadowOf(c, 0.45)]]); g.fill();
        g.save(); polyPath(g, pts); g.clip();
        if (ribbed) for (let k = -6; k <= 6; k++) { g.fillStyle = rgba(INK, 0.22); g.fillRect(k * 10, -r, 4, r * 2); g.fillStyle = rgba('#fff0d0', 0.14); g.fillRect(k * 10 + 4, -r, 3, r * 2); }
        for (let k = 0; k < (red ? 6 : 3); k++) blob(g, range(pr, -r, r) * 0.6, range(pr, -r, r) * 0.4, r * range(pr, 0.25, 0.5), r * 0.3, 0, red ? pick(pr, ['#7a4a2e', '#5a3a2a', '#8c8a84']) : pick(pr, ['#8a4a26', '#a85a2a', '#5a3424']), 0.6, 0.35);
        g.restore();
        g.lineWidth = 2.5; g.strokeStyle = rgba(lightOf(c, 0.6), 0.55); g.beginPath(); g.moveTo(pts[n - 1][0], pts[n - 1][1]); for (let k = 0; k < Math.ceil(n / 2); k++) g.lineTo(pts[k][0], pts[k][1]); g.stroke();
        if (riv) for (const p of pts) rivet(g, p[0] * 0.75, p[1] * 0.75, 2.6, '#8a8276');
        g.restore();
      });
    }
    glaze(g, s, s, '#ffd8b0', 0.08, 'soft-light');
    blurTile(cv, 0.6);
  },
});

// ---- gas pump --------------------------------------------------------------------------------------------

register('rs_pump_face', {
  family: F, w: 128, h: 256, note: 'goblin fuel pump front (fitted): cream enamel in a brass frame, gauge dial, FUEL lettering, price drums, kick plate',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, w, h, [[0, '#e8cc78'], [0.5, '#b08a3c'], [1, '#6a4e22']]); g.fillRect(0, 0, w, h);
    const ec = '#e2d4b0';
    g.fillStyle = grad(g, 0, 10, 0, h - 56, [[0, lightOf(ec, 0.3)], [0.5, ec], [1, shadowOf(ec, 0.25)]]); g.beginPath(); g.roundRect(9, 9, w - 18, h - 66, 10); g.fill();
    mottle(g, w, rnd, { colors: ['#c8b890', '#efe4c8'], count: 10, rmin: 8, rmax: 22, alpha: 0.3 });
    const cx = w / 2, cy = 58, R = 40;
    g.fillStyle = grad(g, cx - R, cy - R, cx + R, cy + R, [[0, '#f0d890'], [0.5, '#b08a3c'], [1, '#5a4018']]);
    g.beginPath(); g.arc(cx, cy, R + 6, 0, TAU); g.fill();
    g.fillStyle = radial(g, cx - 10, cy - 12, 4, R, [[0, '#fbf2dc'], [1, '#c8b890']]);
    g.beginPath(); g.arc(cx, cy, R, 0, TAU); g.fill();
    for (let i = 0; i <= 10; i++) { const a = Math.PI * 0.8 + i / 10 * Math.PI * 1.4; line(g, [[cx + Math.cos(a) * R * 0.72, cy + Math.sin(a) * R * 0.72], [cx + Math.cos(a) * R * 0.9, cy + Math.sin(a) * R * 0.9]], i % 5 ? 1.5 : 3, '#3a2a24', 0.85); }
    { const a = Math.PI * 0.8 + 0.83 * Math.PI * 1.4; line(g, [[cx, cy], [cx + Math.cos(a) * R * 0.8, cy + Math.sin(a) * R * 0.8]], 3, '#a8302a'); }
    ellipse(g, cx, cy, 5, 5, 0, '#3a2a24');
    g.font = FONT(10); g.fillStyle = '#3a2a24'; g.textAlign = 'center'; g.fillText('GALLONS', cx, cy + 22);
    blob(g, cx - 16, cy - 20, 14, 7, -0.6, '#ffffff', 0.5, 0.4);
    letters(g, 'FUEL', cx, 128, { font: SERIF(32), color: '#8e2e24', shadowCol: '#5a4018', alpha: 0.95, worn: 0.3, rnd, maxW: w - 26, under: ec });
    g.fillStyle = '#2e262a'; g.fillRect(18, 152, w - 36, 30);
    for (let i = 0; i < 4; i++) {
      const x = 22 + i * (w - 44) / 4, ww = (w - 44) / 4 - 4;
      g.fillStyle = grad(g, 0, 154, 0, 180, [[0, '#8a8070'], [0.3, '#f0e6d0'], [0.7, '#f0e6d0'], [1, '#8a8070']]); g.fillRect(x, 154, ww, 26);
      g.font = FONT(18); g.fillStyle = '#2a2228'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('8.99'[i], x + ww / 2, 168);
    }
    g.fillStyle = grad(g, 0, h - 52, 0, h, [[0, '#e0c070'], [0.3, '#b08a3c'], [1, '#5a4018']]); g.fillRect(0, h - 52, w, 52);
    for (const x of [12, w / 2, w - 12]) for (const y of [h - 42, h - 12]) rivet(g, x, y, 3.5, '#c8a050');
    for (let y = 16; y < h - 60; y += 24) for (const x of [5, w - 5]) rivet(g, x, y, 2.4, '#c8a050');
    for (let i = 0; i < 6; i++) chip(g, w, range(rnd, 14, w - 14), 96 + rnd() * 90, range(rnd, 2, 4), '#6a5a48', rnd);
    g.fillStyle = grad(g, 0, h * 0.55, 0, h, [[0, INK, 0], [1, INK, 0.3]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.4);
  },
});

// ---- the dinosaur ----------------------------------------------------------------------------------------

register('rs_dino', {
  family: F, size: 256, note: 'painted plaster roadside dino (tiles in u; v: bottom = belly, top = back): muted teal back, olive flank, ochre belly, soft saddles, big lit scales, plaster chips',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#456a58'], [0.2, '#4e7562'], [0.38, '#6f7a48'], [0.5, '#8c8a52'], [0.58, '#c2a46a'], [1, '#d0b882']]);
    g.fillRect(0, 0, s, s);
    mottle(g, s, rnd, { colors: ['#557c64', '#62784a', '#4a6a56'], count: 16, rmin: 22, rmax: 52, alpha: 0.22, hard: 0.08 });
    // two or three big soft darker saddles over the back, fading down the flank
    for (let i = 0; i < 3; i++) {
      const x = (i + 0.25 + rnd() * 0.5) * s / 3, rx = range(rnd, 34, 52), ry = range(rnd, 70, 96);
      wrapX(s, x, rx, X => blob(g, X, 0, rx, ry, range(rnd, -0.15, 0.15), '#3c5646', 0.35, 0.15));
    }
    // big scales, 7 to a row: a cool shadow under each, the body, a lit cream-green top edge
    const cols = 7, W = s / cols;
    for (let row = 0; row < 6; row++) {
      const y = 14 + row * 22, off = row % 2 ? W / 2 : 0, fade = 1 - row / 7;
      for (let i = 0; i < cols; i++) {
        const x = i * W + off + range(rnd, -3, 3), yy = y + range(rnd, -3, 3), sc = range(rnd, 0.85, 1.1), rw = W * 0.42 * sc, rh = W * 0.3 * sc;
        wrapX(s, x, W, X => {
          blob(g, X + 3, yy + rh * 0.55, rw * 1.05, rh * 0.7, 0, '#2e4038', 0.4 * fade, 0.4);
          ellipse(g, X, yy, rw, rh, 0, row < 3 ? '#557c64' : '#76804e', 0.55 * fade);
          g.save(); g.globalAlpha = 0.6 * fade; g.strokeStyle = '#a9bf88'; g.lineWidth = 2.6; g.lineCap = 'round';
          g.beginPath(); g.ellipse(X, yy + 1, rw * 0.86, rh * 0.8, 0, Math.PI * 1.1, Math.PI * 1.75); g.stroke(); g.restore();
        });
      }
    }
    // belly: soft wrinkles, a little moss where the flank meets the belly
    for (let k = 0; k < 7; k++) { const y = s * (0.64 + k * 0.05); line(g, [[0, y], [s * 0.3, y + 2], [s * 0.6, y - 1], [s, y + 1]], 2, '#9a7e4e', 0.16); }
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c'], count: 6, rmin: 8, rmax: 18, alpha: 0.25, hard: 0.2 });
    // chipped paint showing pale plaster, hairline cracks, thin rain streaks
    for (let i = 0; i < 3; i++) {
      const x = rnd() * s, y = range(rnd, 0.08, 0.9) * s, r = range(rnd, 7, 12);
      const cs = Math.floor(rnd() * 1e9);
      wrapX(s, x, r * 2, X => chip(g, 1e6, X, y, r, '#cfc4ac', rngFrom(cs)));
    }
    cracks(g, s, rnd, { color: '#3a3430', count: 3, len: [14, 36], width: [0.7, 1.2], alpha: 0.32 });
    streaks(g, s, rnd, { colors: ['#3a4a3a', '#6a6044'], count: 12, len: [24, 70], width: [1, 2.2], angle: Math.PI, wobble: 0.08, alpha: 0.12 });
    glaze(g, s, s, '#ffe8b8', 0.1, 'soft-light');
    blurTile(cv, 0.6);
  },
});
register('rs_stone', {
  family: F, size: 256, note: 'cut stone blocks (pedestal, footings, piers): lit bevels, soft grout, a little moss',
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
register('rs_rock', {
  family: F, size: 256, note: 'mossy gray boulder (tiles both ways): big lit planes, soft cool shadows, cracks, moss patches',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#86827c');
    mottle(g, s, rnd, { colors: ['#97918a', '#77746e', '#8e8880'], count: 18, rmin: 30, rmax: 70, alpha: 0.4, hard: 0.08 });
    for (let i = 0; i < 12; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 20, 46);
      wrap(s, x, y, r * 1.4, (X, Y) => { blob(g, X - r * 0.25, Y - r * 0.3, r, r * 0.7, rnd() * 3, '#c4beb0', 0.3, 0.2); blob(g, X + r * 0.35, Y + r * 0.4, r * 0.8, r * 0.5, rnd() * 3, '#4e4c58', 0.32, 0.2); });
    }
    cracks(g, s, rnd, { color: '#3a3640', count: 6, len: [20, 60], width: [1, 2.2], alpha: 0.5 });
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#7e8a52', '#5d6b3c'], count: 18, rmin: 8, rmax: 26, alpha: 0.38, hard: 0.3 });
    mottle(g, s, rnd, { colors: ['#a8a48e'], count: 8, rmin: 3, rmax: 8, alpha: 0.4, hard: 0.5 });
    glaze(g, s, s, '#ffe2b0', 0.08, 'soft-light');
    blurTile(cv, 0.6);
  },
});

// ---- ranger gate & keypad ------------------------------------------------------------------------------

// A warning board (one image per board face): red and cream chevrons pointing right, brushed by hand,
// the paint worn back from the board's edges and ends, mud splashed along the bottom. Two layouts stacked.
register('rs_warn', {
  family: F, w: 256, h: 128, note: 'two warning boards stacked (fitted with a uv rect; mirror for chevrons pointing left): red/cream chevrons, worn edges',
  paint(g, w, rnd, h) {
    fill(g, w, h, '#2a2024');
    for (let b = 0; b < 2; b++) {
      const Y = b * 64, H = 64, pr = rngFrom(311 + b * 97), wood = jitter('#8a6440', pr, 0.05);
      plank(g, 0, Y + 1, w, H - 2, wood, pr, { grain: 7, bevel: 0, splits: 0.3, knots: 0.3 });
      g.save(); g.beginPath(); g.rect(0, Y + 1, w, H - 2); g.clip();
      const ink = (pts, c, a) => { g.save(); g.globalAlpha = a; polyPath(g, pts); g.fillStyle = c; g.fill(); g.restore(); };
      // cream ground, brushed short of the board ends
      ink(wobbly([[8, Y + 4], [w - 8, Y + 4], [w - 8, Y + H - 4], [8, Y + H - 4]], pr, 2), '#d6c6a0', 0.95);
      // chevrons: band width varies per board, edges wobble
      const bw = (b ? 26 : 22) * range(pr, 0.88, 1.12), tip = H * 0.45;
      for (let x = 10 - bw * 2; x < w; x += bw * 2) {
        const x0 = x, x1 = x + bw * range(pr, 0.9, 1.1);
        const L = [[x0, Y + 4], [x0 + tip, Y + H / 2], [x0, Y + H - 4]], R = [[x1, Y + H - 4], [x1 + tip, Y + H / 2], [x1, Y + 4]];
        ink(wobbly([...L, ...R, L[0]], pr, 1.8, 4), '#9a3a2c', 0.95);
      }
      // wear from the edges: scuffs dragged along the grain, chipped islands along the plank seams, bare ends
      for (let k = 0; k < 14; k++) {
        const top = pr() < 0.5, y = top ? Y + range(pr, 3, 9) : Y + H - range(pr, 3, 10), x = pr() * w, L = range(pr, 20, 60), ww = range(pr, 2, 4);
        stroke(g, [[x, y], [x + L * 0.5, y + (pr() - 0.5) * 2], [x + L, y + (pr() - 0.5) * 2]], ww, ww * 0.4, pick(pr, [wood, shadowOf(wood, 0.15)]), 0.9);
      }
      for (let k = 0; k < 6; k++) {
        const x = pr() * w, y = Y + (pr() < 0.5 ? 6 : H - 7), r = range(pr, 3, 6);
        const pts = []; for (let q = 0; q < 6; q++) { const a = q / 6 * TAU; pts.push([x + Math.cos(a) * r * range(pr, 0.6, 1.3), y + Math.sin(a) * r * 0.6]); }
        ink(pts, wood, 0.9);
      }
      for (const ex of [0, w]) {
        const d = ex ? -1 : 1;
        for (let k = 0; k < 5; k++) { const y = Y + range(pr, 4, H - 4), L = range(pr, 10, 30); stroke(g, [[ex, y], [ex + d * L, y + (pr() - 0.5) * 2]], range(pr, 3, 6), 1, wood, 0.85); }
      }
      // mud splashed up the bottom fifth
      g.fillStyle = grad(g, 0, Y + H * 0.78, 0, Y + H, [[0, '#4a3826', 0], [1, '#4a3826', 0.5]]); g.fillRect(0, Y, w, H);
      for (let k = 0; k < 14; k++) ellipse(g, pr() * w, Y + H - range(pr, 2, 14), range(pr, 1, 3), range(pr, 1, 2.5), 0, '#4a3826', 0.55);
      // board shading: lit top edge, shaded bottom edge
      g.fillStyle = grad(g, 0, Y, 0, Y + H, [[0, '#fff0c8', 0.35], [0.12, '#fff0c8', 0], [0.82, INK, 0], [1, INK, 0.45]]); g.fillRect(0, Y, w, H);
      g.restore();
      for (const x of [10, w - 10]) { nail(g, x, Y + 16, 2.6); nail(g, x + (x < w / 2 ? 2 : -2), Y + H - 16, 2.6); }
      rustRun(g, w, 10, Y + 19, range(pr, 8, 18), 2, 0.4, pr, h);
    }
    blurTile(g.canvas, 0.5);
  },
});
register('rs_stop', {
  family: F, w: 256, h: 96, note: 'a carved STOP board (fitted): two red-painted planks, letters cut in and painted cream, iron corner straps',
  paint(g, w, rnd, h) {
    fill(g, w, h, '#241c22');
    for (let i = 0; i < 2; i++) plank(g, 0, i * h / 2 + 1, w, h / 2 - 2, jitter('#9a3a2c', rnd, 0.05), rnd, { grain: 9, bevel: 3, light: 0.5 });
    for (let k = 0; k < 10; k++) { const x = rnd() * w, y = rnd() * h; stroke(g, [[x, y], [x + range(rnd, 16, 40), y + (rnd() - 0.5) * 2]], range(rnd, 2, 4), 1, '#7a5634', 0.75); }
    carved(g, 'STOP', w / 2, h / 2 + 2, SERIF(64), '#e2d2a8', w - 60);
    for (const [x, y, dx, dy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
      g.fillStyle = '#5e5a5c'; g.fillRect(Math.min(x, x + dx * 26), Math.min(y, y + dy * 9), 26, 9); g.fillRect(Math.min(x, x + dx * 9), Math.min(y, y + dy * 26), 9, 26);
      rivet(g, x + dx * 6, y + dy * 6, 3, '#8e8678');
    }
    g.fillStyle = grad(g, 0, h * 0.75, 0, h, [[0, '#4a3826', 0], [1, '#4a3826', 0.4]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.4);
  },
});
register('rs_chevband', {
  family: F, w: 128, h: 64, note: 'a hand-painted chevron band wrapping a post (fitted: u around, three chevrons), worn edges',
  paint(g, w, rnd, h) {
    fill(g, w, h, '#d6c6a0');
    mottle(g, w, rnd, { colors: ['#e2d4b0', '#c4b48e'], count: 8, rmin: 6, rmax: 16, alpha: 0.3 });
    const P = w / 3, bw = P * 0.42;
    for (let i = -1; i < 4; i++) {
      const x0 = i * P + 4, x1 = x0 + bw;
      const pts = wobbly([[x0, 0], [x0 + h * 0.4, h / 2], [x0, h], [x1, h], [x1 + h * 0.4, h / 2], [x1, 0], [x0, 0]], rnd, 1.4, 3);
      polyPath(g, pts); g.fillStyle = '#9a3a2c'; g.fill();
    }
    for (let k = 0; k < 10; k++) { const y = pick(rnd, [range(rnd, 1, 6), range(rnd, h - 6, h - 1)]), x = rnd() * w; stroke(g, [[x, y], [x + range(rnd, 10, 26), y]], range(rnd, 2, 3.5), 1, '#6a4a30', 0.8); }
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#fff0c8', 0.25], [0.2, '#fff0c8', 0], [0.8, INK, 0], [1, INK, 0.35]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.5);
  },
});
register('rs_keypad', {
  family: F, w: 128, h: 160, note: 'goblin keypad (fitted): brass plate, green-glass readout, twelve ivory buttons, rivets',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, w, h, [[0, '#f0d890'], [0.35, '#c09a48'], [1, '#5a4018']]); g.fillRect(0, 0, w, h);
    g.fillStyle = grad(g, 0, 0, w, h, [[0, '#a8843a'], [1, '#7a5a24']]); g.fillRect(8, 8, w - 16, h - 16);
    streaks(g, w, rnd, { colors: ['#e8cc78', '#6a4e22'], count: 30, len: [10, 40], width: [0.6, 1.2], angle: Math.PI / 2, wobble: 0.02, alpha: 0.25 });
    for (let i = 0; i < 6; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 4, 12), range(rnd, 3, 8), rnd() * 3, '#5a8a6a', 0.35, 0.3);
    g.fillStyle = '#1e2a22'; g.fillRect(16, 16, w - 32, 26);
    g.fillStyle = grad(g, 0, 18, 0, 40, [[0, '#4a8a52'], [1, '#2a5a32']]); g.fillRect(18, 18, w - 36, 22);
    g.font = FONT(16); g.fillStyle = '#b8f0a0'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('- - - -', w / 2, 30);
    blob(g, 30, 22, 14, 3, 0, '#ffffff', 0.35, 0.4);
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) {
      const x = 30 + c * 34, y = 62 + r * 24;
      blob(g, x + 2, y + 3, 13, 10, 0, INK, 0.5, 0.3);
      g.fillStyle = radial(g, x - 4, y - 4, 1, 12, [[0, '#fbf2dc'], [0.7, '#d8c8a0'], [1, '#8a7a5a']]);
      g.beginPath(); g.ellipse(x, y, 12, 10, 0, 0, TAU); g.fill();
      g.font = FONT(12); g.fillStyle = '#3a2a20'; g.fillText(keys[r * 3 + c], x, y + 1);
    }
    for (const [x, y] of [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8]]) rivet(g, x, y, 4, '#c8a050');
    ellipse(g, w - 20, h - 22, 5, 5, 0, '#a8302a'); blob(g, w - 21.5, h - 23.5, 2, 2, 0, '#ffd0b0', 0.8, 0.4);
    blurTile(g.canvas, 0.3);
  },
});

// ---- camp: logs, bales -----------------------------------------------------------------------------------

register('rs_bark', {
  family: F, size: 256, note: 'log bark (u around, v along the log): long meandering ridges broken into tapered plates, lit left edges, deep soft furrows, lichen and moss',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#2e2420');
    mottle(g, s, rnd, { colors: ['#3a2e26', '#2a201c'], count: 12, rmin: 20, rmax: 50, alpha: 0.5, hard: 0.1, stretch: 2.5, rot: Math.PI / 2 });
    const cols = 11, W = s / cols;
    for (let i = 0; i < cols; i++) {
      let xc = (i + 0.5) * W + range(rnd, -5, 5), y = rnd() * s;
      const end = y + s;
      while (y < end - 10) {
        const L = Math.min(range(rnd, 50, 120), end - y), c = jitter(pick(rnd, ['#6a5642', '#5e4c3a', '#725e48', '#66523e']), rnd, 0.07);
        const ww = W * range(rnd, 0.6, 0.95), drift = range(rnd, -7, 7), ps = Math.floor(rnd() * 1e9), y0 = y + range(rnd, 1, 4), y1 = y + L - range(rnd, 1, 4);
        // a plate: pointed-ish ends, one side bulging, drifting sideways as it runs down the log
        const shape = (X, dy) => {
          const pr = rngFrom(ps), pts = [];
          for (let k = 0; k <= 6; k++) { const t = k / 6, half = ww / 2 * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.3) * range(pr, 0.85, 1.1); pts.push([X + drift * t - half, y0 + (y1 - y0) * t + dy]); }
          for (let k = 6; k >= 0; k--) { const t = k / 6, half = ww / 2 * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * t)), 0.3) * range(pr, 0.85, 1.1); pts.push([X + drift * t + half, y0 + (y1 - y0) * t + dy]); }
          return pts;
        };
        for (const dy of [0, -s]) wrapX(s, xc, ww + 8, X => {
          const pts = shape(X, dy), pr = rngFrom(ps + 1);
          polyPath(g, pts.map(([u, v]) => [u + 2, v + 2])); g.fillStyle = rgba('#140e0c', 0.5); g.fill();
          g.save(); polyPath(g, pts); g.fillStyle = grad(g, X - ww / 2, 0, X + ww / 2 + drift, 0, [[0, '#8a7660'], [0.22, c], [0.75, shadowOf(c, 0.22)], [1, shadowOf(c, 0.5)]]); g.fill();
          g.clip(); for (let q = 0; q < 3; q++) { const ox = range(pr, -ww * 0.35, ww * 0.35); line(g, [[X + ox, y0 + dy], [X + ox + drift, y1 + dy]], 0.9, shadowOf(c, 0.45), 0.4); }
          g.restore();
          line(g, pts.slice(1, 6).map(([u, v]) => [u + 1.5, v]), 1.8, '#9a8670', 0.55);
        });
        y += L; xc += drift * 0.6;
      }
    }
    mottle(g, s, rnd, { colors: ['#8a8a74', '#9a9a84'], count: 10, rmin: 5, rmax: 14, alpha: 0.5, hard: 0.45 });
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c'], count: 8, rmin: 8, rmax: 20, alpha: 0.45, hard: 0.35 });
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});
register('rs_logend', {
  family: F, size: 128, note: 'sawn log end (fitted, circle): growth rings, radial checks, bark rim',
  paint(g, s, rnd) {
    const c = s / 2;
    fill(g, s, s, '#3a2a20');
    g.fillStyle = radial(g, c - 10, c - 10, 4, c, [[0, '#d8b480'], [0.8, '#b48a58'], [1, '#8a6440']]);
    g.beginPath(); g.arc(c, c, c * 0.86, 0, TAU); g.fill();
    for (let r = 5; r < c * 0.84; r += range(rnd, 3.5, 6)) {
      g.strokeStyle = rgba('#7a5434', range(rnd, 0.25, 0.5)); g.lineWidth = range(rnd, 0.8, 1.6);
      g.beginPath(); for (let k = 0; k <= 32; k++) { const a = k / 32 * TAU, rr = r + Math.sin(a * 3 + r) * 0.8; k ? g.lineTo(c + 2 + Math.cos(a) * rr, c + 1 + Math.sin(a) * rr) : g.moveTo(c + 2 + Math.cos(a) * rr, c + 1 + Math.sin(a) * rr); } g.stroke();
    }
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
register('rs_hay', {
  family: F, size: 256, note: 'pressed hay (Westfall bales; straw along u): golden strands lit on top, dark gaps, loose wisps',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#a8863e');
    mottle(g, s, rnd, { colors: ['#c8a050', '#8e7032', '#d8b860'], count: 26, rmin: 16, rmax: 46, alpha: 0.4, hard: 0.1, stretch: 2.5, rot: 0 });
    streaks(g, s, rnd, { colors: ['#5a4422', '#6e5428'], count: 70, len: [20, 60], width: [1.5, 3], angle: Math.PI / 2, wobble: 0.25, alpha: 0.4 });
    streaks(g, s, rnd, { colors: ['#e8cc78', '#f2dc90', '#d8b860'], count: 160, len: [14, 50], width: [1, 2.2], angle: Math.PI / 2, wobble: 0.3, alpha: 0.6 });
    streaks(g, s, rnd, { colors: ['#fff0b0'], count: 30, len: [8, 22], width: [0.8, 1.4], angle: 1.3, wobble: 0.6, alpha: 0.6 });
    glaze(g, s, s, '#ffe0a0', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  },
});
register('rs_bone', {
  family: F, size: 128, note: 'sun-bleached bone (skulls and horns on Badlands posts): cream, porous, cracked, cool shadow',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e2d8c0');
    mottle(g, s, rnd, { colors: ['#f2ead6', '#c8bca0', '#d6caae'], count: 16, rmin: 10, rmax: 30, alpha: 0.4, hard: 0.1 });
    pebbles(g, s, rnd, { colors: ['#b0a488'], count: 30, rmin: 0.8, rmax: 2, alpha: 0.6, shadow: 0.2 });
    cracks(g, s, rnd, { color: '#6a5a48', count: 5, len: [12, 30], width: [0.7, 1.2], alpha: 0.5 });
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#fff8e8', 0.25], [0.5, '#fff8e8', 0], [1, '#8a7e6a', 0.35]]); g.fillRect(0, 0, s, s);
    blurTile(cv, 0.6);
  },
});

// ---- other biomes' building materials ---------------------------------------------------------------------

register('rs_slate', {
  family: F, size: 256, note: 'blue-gray slate roofing (Dun Morogh; up the roof = up the texture): overlapping rows, lit lower lips, cool shadows',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#2e3440');
    const rows = 7, rh = s / rows;
    for (let r = rows - 1; r >= 0; r--) {
      const y = r * rh, ws = rowLayout(s, rngFrom(91 + r * 13), { rows: 1, minW: 30, maxW: 56 }).map(q => [q.x, q.w]);
      for (const [x0, w] of ws) {
        const c = jitter(pick(rnd, ['#5e6878', '#6f7a8a', '#545e6e', '#66707e']), rnd, 0.06), sh = range(rnd, -3, 3), ts = Math.floor(rnd() * 1e9);
        wrapRect(s, x0 + 1, y, w - 2, rh + 10, (dx, dy) => {
          const X = x0 + 1 + dx, Y = y + dy, W = w - 3, H = rh + 7 + sh, rnd = rngFrom(ts);
          g.fillStyle = grad(g, 0, Y, 0, Y + H, [[0, shadowOf(c, 0.45)], [0.35, c], [0.88, lightOf(c, 0.3)], [1, shadowOf(c, 0.3)]]);
          g.beginPath(); g.roundRect(X, Y, W, H, [0, 0, 5, 5]); g.fill();
          if (rnd() < 0.4) line(g, [[X + W * range(rnd, 0.2, 0.8), Y + H * 0.5], [X + W * range(rnd, 0.2, 0.8), Y + H - 2]], 0.9, shadowOf(c, 0.5), 0.5);
          g.fillStyle = rgba(lightOf(c, 0.55), 0.5); g.fillRect(X + 1, Y + H - 4, W - 2, 2);
          g.fillStyle = rgba(INK, 0.3); g.fillRect(X + W - 2, Y, 2, H);
        });
      }
      g.fillStyle = grad(g, 0, y, 0, y + 10, [[0, INK, 0.5], [1, INK, 0]]); g.fillRect(0, y, s, 10);
    }
    mottle(g, s, rnd, { colors: ['#8a94a0', '#b8c4d0'], count: 10, rmin: 6, rmax: 18, alpha: 0.18, hard: 0.2 });
    glaze(g, s, s, '#dfe8f2', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});
register('rs_adobe', {
  family: F, size: 256, note: 'tan adobe plaster (Gadgetzan post bases): trowel swirls, soft blotches, hairline cracks, a little bare brick',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#c8a478');
    mottle(g, s, rnd, { colors: ['#d4b086', '#b8946a', '#dcbc90'], count: 26, rmin: 20, rmax: 60, alpha: 0.35, hard: 0.08 });
    for (let i = 0; i < 18; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 12, 30), a0 = rnd() * TAU, c = rnd() < 0.5 ? '#ecd2a8' : '#a8845a', lw = range(rnd, 2, 4), al = range(rnd, 0.8, 1.8);
      wrap(s, x, y, r + 4, (X, Y) => { g.save(); g.strokeStyle = rgba(c, 0.18); g.lineWidth = lw; g.beginPath(); g.arc(X, Y, r, a0, a0 + al); g.stroke(); g.restore(); });
    }
    cracks(g, s, rnd, { color: '#6a4a30', count: 6, len: [16, 44], width: [0.7, 1.3], alpha: 0.45 });
    glaze(g, s, s, '#ffe0b0', 0.1, 'soft-light');
    blurTile(cv, 0.6);
  },
});

// ---- parked motorhomes ---------------------------------------------------------------------------------------

register('rs_rv', {
  family: F, size: 256, note: 'junked motorhome skin (u along the body, 3 m; v fitted top→bottom): cream panels, a two-tone belt stripe, rivet seams, rust, mud',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e2d6bc');
    mottle(g, s, rnd, { colors: ['#ece2cc', '#cfc2a4', '#d8ccb0'], count: 30, rmin: 16, rmax: 50, alpha: 0.35, hard: 0.1 });
    const band = (y0, y1, c) => { g.fillStyle = grad(g, 0, y0, 0, y1, [[0, lightOf(c, 0.3)], [0.5, c], [1, shadowOf(c, 0.3)]]); g.fillRect(0, y0, s, y1 - y0); };
    band(s * 0.46, s * 0.56, '#7a4a2a');
    band(s * 0.585, s * 0.62, '#c8783a');
    for (const y of [s * 0.1, s * 0.86]) { g.fillStyle = grad(g, 0, y - 2, 0, y + 5, [[0, INK, 0.45], [1, '#fff0d0', 0.2]]); g.fillRect(0, y - 2, s, 7); for (let x = 8; x < s; x += 21) rivet(g, x + range(rnd, -2, 2), y + 6, 2.2, '#9a9284'); }
    for (let i = 0; i < 3; i++) {
      const x = (i + 0.3) * s / 3;
      g.fillStyle = grad(g, x - 2, 0, x + 4, 0, [[0, INK, 0.4], [1, '#fff0d0', 0.2]]); g.fillRect(x - 2, s * 0.1, 6, s * 0.76);
      for (let y = s * 0.16; y < s * 0.84; y += 19) { rivet(g, x + 6, y + range(rnd, -2, 2), 2.2, '#9a9284'); if (rnd() < 0.2) rustRun(g, s, x + 6, y + 2, range(rnd, 6, 18), 1.4, 0.3, rnd); }
    }
    for (let i = 0; i < 10; i++) chip(g, s, rnd() * s, range(rnd, 0.15, 0.85) * s, range(rnd, 2.5, 6), '#7a6a5a', rnd);
    for (let i = 0; i < 5; i++) dent(g, s, rnd() * s, range(rnd, 0.2, 0.8) * s, range(rnd, 10, 22), '#d8ccb0', 0.5);
    g.fillStyle = grad(g, 0, s * 0.7, 0, s, [[0, '#6a5a44', 0], [0.6, '#6a5a44', 0.35], [1, '#4a3a2c', 0.65]]); g.fillRect(0, 0, s, s);
    streaks(g, s, rnd, { colors: ['#6a5040', '#7a6048'], count: 26, len: [6, 30], width: [1.2, 3], angle: 0, wobble: 0.6, alpha: 0.3 });
    for (let i = 0; i < 8; i++) rustRun(g, s, rnd() * s, s * 0.12, range(rnd, 14, 44), range(rnd, 1.2, 2.2), 0.28, rnd);
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
    for (const [y, , rot] of bd) {
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
  family: F, w: 256, h: 64, note: 'gas canopy fascia board (u along, 2 m; v fitted): red paint, cream pinstripes, brass trim line and rivets, painted diamonds',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#b8543e'], [0.3, '#9a3e2e'], [1, '#6a2a22']]); g.fillRect(0, 0, w, h);
    mottle(g, w, rnd, { colors: ['#b24a36', '#7e3024'], count: 10, rmin: 8, rmax: 20, alpha: 0.3 });
    g.fillStyle = grad(g, 0, h - 9, 0, h, [[0, '#f0d890'], [0.5, '#b08a3c'], [1, '#5a4018']]); g.fillRect(0, h - 9, w, 9);
    for (const y of [9, h - 15]) line(g, [[0, y], [w, y]], 2.5, '#e8d8b0', 0.85, 'butt');
    for (let i = 0; i < 4; i++) {
      const x = i * w / 4 + w / 8;
      polyPath(g, [[x, h / 2 - 14], [x + 14, h / 2 - 3], [x, h / 2 + 8], [x - 14, h / 2 - 3]]); g.fillStyle = '#e8d8b0'; g.fill();
      polyPath(g, [[x, h / 2 - 8], [x + 7, h / 2 - 3], [x, h / 2 + 2], [x - 7, h / 2 - 3]]); g.fillStyle = '#c8963a'; g.fill();
      rivet(g, x + w / 8, h - 4.5, 3, '#c8a050');
    }
    for (let i = 0; i < 6; i++) chip(g, w, rnd() * w, range(rnd, 12, h - 18), range(rnd, 2, 4), '#5a3a2a', rnd);
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#fff0c8', 0.25], [0.15, '#fff0c8', 0], [0.8, INK, 0], [1, INK, 0.3]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.4);
  },
});

// ---- weather: snow, dust, sand (caps, drifts, cover), icicles, smoke --------------------------------------------

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
  family: F, w: 64, h: 128, note: 'icicle (fitted: v top→tip): opaque packed white at the root to icy blue at the tip, a lit streak',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#f4f8fb'], [0.3, '#eef4f8'], [0.65, '#c4daea'], [1, '#9cc0d8']]); g.fillRect(0, 0, w, h);
    g.fillStyle = grad(g, 0, 0, w, 0, [[0, '#ffffff', 0.4], [0.3, '#ffffff', 0], [0.7, '#7aa0c0', 0], [1, '#7aa0c0', 0.35]]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 5; i++) { const x = rnd() * w; line(g, [[x, 0], [x + (rnd() - 0.5) * 4, h]], range(rnd, 1, 2.5), rnd() < 0.5 ? '#ffffff' : '#a8c4dc', 0.3); }
    blurTile(g.canvas, 1);
  },
});
register('rs_puff', {
  family: F, size: 128, alpha: true, note: 'a cartoon smoke puff billboard (alpha): soft cauliflower blobs lit warm cream at the upper left, cool lavender-gray lower right, alpha fading well inside the edge',
  paint(g, s, rnd) {
    const c = s / 2;
    const mask = document.createElement('canvas'); mask.width = mask.height = s;
    const mg = mask.getContext('2d');
    const lobes = [[0, 0, 0.3]];
    for (let i = 0; i < 5; i++) { const a = i / 5 * TAU + range(rnd, -0.3, 0.3), d = range(rnd, 0.12, 0.18); lobes.push([Math.cos(a) * d, Math.sin(a) * d, range(rnd, 0.15, 0.21)]); }
    for (const [x, y, r] of lobes) {
      mg.fillStyle = radial(mg, c + x * s, c + y * s, 0, r * s, [[0, '#ffffff', 1], [0.55, '#ffffff', 0.85], [1, '#ffffff', 0]]);
      mg.beginPath(); mg.arc(c + x * s, c + y * s, r * s, 0, TAU); mg.fill();
    }
    // the shading: warm lit top-left, cool lavender lower right, a soft crease between the lobes
    g.fillStyle = grad(g, s * 0.15, s * 0.1, s * 0.85, s * 0.9, [[0, '#ece4d4'], [0.45, '#c8c2c0'], [1, '#8c88a0']]); g.fillRect(0, 0, s, s);
    for (const [x, y, r] of lobes) {
      blob(g, c + (x - r * 0.3) * s, c + (y - r * 0.35) * s, r * s * 0.6, r * s * 0.5, 0, '#f8f0e0', 0.55, 0.2);
      blob(g, c + (x + r * 0.45) * s, c + (y + r * 0.5) * s, r * s * 0.55, r * s * 0.35, 0, '#7a7690', 0.3, 0.2);
    }
    g.globalCompositeOperation = 'destination-in'; g.drawImage(mask, 0, 0); g.globalCompositeOperation = 'source-over';
    // fade the whole puff out well inside the edge
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = radial(g, c, c, s * 0.18, s * 0.48, [[0, '#ffffff', 1], [1, '#ffffff', 0]]); g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = 'source-over';
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
    const cx = 62, cy = 64;
    for (let i = 0; i < 10; i++) { const a = i / 10 * TAU; ellipse(g, cx + Math.cos(a) * 44, cy + Math.sin(a) * 44, 11, 9, a, '#2a2030'); ellipse(g, cx + Math.cos(a) * 43, cy + Math.sin(a) * 43, 8, 6, a, '#b08a3c'); }
    g.fillStyle = '#2a2030'; g.beginPath(); g.arc(cx, cy, 42, 0, TAU); g.fill();
    g.fillStyle = grad(g, cx - 40, cy - 40, cx + 40, cy + 40, [[0, '#f0d890'], [1, '#7a5a24']]); g.beginPath(); g.arc(cx, cy, 38, 0, TAU); g.fill();
    g.fillStyle = '#94392a'; g.beginPath(); g.arc(cx, cy, 20, 0, TAU); g.fill();
    g.font = SERIF(26); g.fillStyle = '#efdcae'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('$', cx, cy + 1);
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
    carved(g, 'RANGER STATION 7', w / 2, h / 2 + 2, SERIF(46), '#d8b050', w - 70);
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
    g.font = FONT(12); g.fillStyle = '#3a2a14';
    { const txt = 'HEAD STOLEN 1987 · DO NOT CLIMB', m = g.measureText(txt).width, k = Math.min(1, (w - 44) / m); g.save(); g.translate(w / 2, 70); g.scale(k, 1); g.fillText(txt, 0, 0); g.restore(); }
    g.restore();
    for (let i = 0; i < 10; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 4, 14), range(rnd, 3, 8), rnd() * 3, '#5a8a6a', 0.3, 0.3);
    for (const [x, y] of [[14, 14], [w - 14, 14], [14, h - 14], [w - 14, h - 14]]) rivet(g, x, y, 4, '#c8a050');
  },
});

register('rs_roundel', {
  family: F, size: 128, alpha: true, note: 'gnomish roundel (alpha): a brass cog on red and cream rings, sun-worn',
  paint(g, s, rnd) {
    const c = s / 2;
    for (const [r, col] of [[60, '#4a3a34'], [57, '#e2d2aa'], [44, '#9a3a2c'], [30, '#e2d2aa']]) { g.fillStyle = col; g.beginPath(); g.arc(c, c, r, 0, TAU); g.fill(); }
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; ellipse(g, c + Math.cos(a) * 24, c + Math.sin(a) * 24, 7, 6, a, '#7a5a24'); }
    g.fillStyle = grad(g, c - 22, c - 22, c + 22, c + 22, [[0, '#f0d890'], [1, '#6a4e22']]); g.beginPath(); g.arc(c, c, 22, 0, TAU); g.fill();
    ellipse(g, c, c, 7, 7, 0, '#3a2a30');
    blob(g, c - 30, c - 34, 26, 10, -0.6, '#ffffff', 0.25, 0.3);
    g.save(); g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26; i++) { const a = rnd() * TAU, d = range(rnd, 10, 58); blob(g, c + Math.cos(a) * d, c + Math.sin(a) * d, range(rnd, 2, 5), range(rnd, 1.5, 3), rnd() * 3, '#000', 0.7, 0.5); }
    g.restore();
  },
});

register('rs_blanket', {
  family: F, size: 256, note: 'yard-sale blanket (fitted): a woven rag rug in uneven muted bands, a zigzag field, frayed fringe, creases and stains',
  paint(g, s, rnd) {
    const base = '#d2c4a0';
    fill(g, s, s, base);
    const mute = c => mix(c, '#b8a888', 0.2);
    const pal = ['#8e3a2c', '#3e5a7e', '#c8963a', '#6a7a3a', base, '#7a4a3a'];
    let y = 16;
    const half = [];
    while (y < s / 2 - 30) { const h = Math.round(range(rnd, 0.6, 1.4) * 16), c = mute(pick(rnd, pal)); half.push([y, h, c]); y += h + Math.round(range(rnd, 2, 8)); }
    for (const [yy, h, c] of half) {
      for (const Y of [yy, s - yy - h]) {
        g.fillStyle = c; g.fillRect(0, Y, s, h);
        for (let x = 0; x < s; x += 3) line(g, [[x, Y], [x + 1, Y + h]], 0.8, rnd() < 0.5 ? shadowOf(c, 0.3) : lightOf(c, 0.3), 0.18);
      }
    }
    g.save(); g.beginPath();
    for (let x = 0; x <= s; x += 18) g.lineTo(x, s / 2 + (x / 18 % 2 ? -10 : 10) + range(rnd, -2, 2));
    g.lineWidth = 6; g.strokeStyle = mute('#8e3a2c'); g.stroke(); g.restore();
    for (let x = 10; x < s; x += 36) { polyPath(g, [[x, s / 2 - 26], [x + 8, s / 2 - 18], [x, s / 2 - 10], [x - 8, s / 2 - 18]]); g.fillStyle = mute('#3e5a7e'); g.fill(); }
    for (let yy = 0; yy < s; yy += 4) line(g, [[0, yy], [s, yy]], 0.8, '#2a2030', 0.07);
    for (let i = 0; i < 400; i++) { const x = rnd() * s, yy = rnd() * s; line(g, [[x, yy], [x + 3, yy]], 1, rnd() < 0.5 ? '#fff4dc' : '#2a2030', 0.12); }
    for (let i = 0; i < 3; i++) { const x = range(rnd, 0.2, 0.8) * s; g.fillStyle = grad(g, x - 14, 0, x + 14, 0, [[0, INK, 0], [0.45, INK, 0.16], [0.6, '#fff4dc', 0.18], [1, '#fff4dc', 0]]); g.fillRect(x - 14, 0, 28, s); }
    for (let x = 2; x < s; x += 4) {
      line(g, [[x, 0], [x + range(rnd, -3, 3), range(rnd, 6, 14)]], 2, rnd() < 0.2 ? '#a89878' : '#e8dcc0', 0.9);
      line(g, [[x, s], [x + range(rnd, -3, 3), s - range(rnd, 6, 14)]], 2, rnd() < 0.2 ? '#a89878' : '#e8dcc0', 0.9);
    }
    for (let i = 0; i < 2; i++) blob(g, range(rnd, 0.2, 0.8) * s, range(rnd, 0.2, 0.8) * s, range(rnd, 14, 24), range(rnd, 9, 14), rnd() * 3, '#6a5034', 0.25, 0.3);
    g.fillStyle = radial(g, s / 2, s / 2, s * 0.3, s * 0.75, [[0, '#6a5a40', 0], [1, '#6a5a40', 0.35]]); g.fillRect(0, 0, s, s);
    blurTile(g.canvas, 0.6);
  },
});

register('rs_slats', {
  family: F, size: 256, note: 'long narrow boards along u (trailer liners and decks, ramps): 8 per tile, one butt joint each, scuffed and grayed',
  paint(g, s, rnd, h, cv) {
    boards(g, s, rnd, { rows: 8, minL: 230, maxL: 420, colors: ['#8a7058', '#94785c', '#7e6650', '#9a8064', '#86705a'], gap: 3, nails: 2, grain: 6, weather: 0.45, rowJitter: 0.1 });
    streaks(g, s, rnd, { colors: ['#5a4636', '#c8b090'], count: 24, len: [20, 70], width: [1, 2.5], angle: Math.PI / 2, wobble: 0.08, alpha: 0.18 });
    glaze(g, s, s, '#ffe0b8', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});
