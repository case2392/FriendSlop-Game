// Texture family: roadside (stops, gates, anchors, camp). See docs/ART.md for the style rules.
//
// Everything along the road that isn't nature or a building, painted the way Blizzard's 2004
// artists painted goblin and human junk: riveted painted steel with chipped paint and rust runs,
// corrugated tin, honey and gray planks, banded timber, bleached driftwood, wrought iron, goblin
// brass, lime plaster, shingles, slate and thatch, canvas, hides and cloth.
//
// Tiling (world-space UVs; "tile" = meters per repeat as roadside3d.js maps them):
//   rs_steel_<cream|red|blue|green|teal|mustard>  riveted painted steel: full-height panels, 2-3 per tile
//                             (trailer sides: 4 m per tile, v fitted to the wall's height)
//   rs_tin, rs_tin_red        corrugated sheet roofing, ribs along v (2 m)
//   rs_planks, rs_planks_gray boards along u (1 m)   rs_slats  long narrow boards (2 m)
//   rs_timber, rs_bleach      banded beams / bleached driftwood, grain along v (1.5 m)   rs_plaster (1.8 m)
//   rs_shingles, rs_shingles_red (1.2 m)  rs_slate (1.4 m)  rs_thatch (1.3 m; up the roof = up the texture)
//   rs_hide (1.6 m)  rs_adobe (2 m)  rs_dirt (2 m)  rs_rock (1.4 m, faceted)  rs_hay (1 m)
//   rs_iron (0.5 m)  rs_brass (1 m)  rs_tire (tread, u around)  rs_gingham (0.6 m)  rs_burlap  rs_plaid  rs_canvas (stripes along u)
//   rs_wing (doped canvas, ribs along v, 1.6 m)  rs_scrap (junk soil, world-planar 1 m)  rs_stone (1.6 m)  rs_rope  rs_bone
//   rs_bark (u around, v along)  rs_dino (u along the body, one tile per 6 m; v = 0 belly .. 1 back, from the normal)
//   rs_rv_green|rust|blue (u 3 m, v fitted; atlas rs_rv_skins stacks all three over rs_rv_names)  rs_fascia (u 4 m, v fitted)
//   rs_snow, rs_dust, rs_sand (caps)   rs_cover_snow|dust|sand (alpha = breakup noise, for the world-space
//   top-cover shader)   rs_ice (icicles)
// Fitted (one image per face): rs_hub, rs_glass (two panes side by side), rs_grille, rs_crate_a|b|c, rs_barrel,
//   rs_barrel_lid, rs_drum, rs_drum_red, rs_drum_lid, rs_pump_face, rs_logend, rs_rv_window, rs_boards, rs_headlamp,
//   rs_blanket, rs_plaque, rs_chevband, rs_gasboard, rs_shield (dwarven boss), rs_rune (band);
//   rs_gatelabels: atlas of rs_ranger_board, rs_warn (two boards), rs_stop and rs_keypad, picked by uv rect;
//   alpha: rs_decal_freight, rs_roundel, rs_pennant, rs_puff (smoke billboard), rs_bunting (eight pennants),
//   rs_tuft, rs_tuft_dry (grass cards), rs_scorch, rs_glow (soft decals)
import {
  register, fill, mottle, stroke, pebbles, cracks, glaze, blurTile, range, pick, wrap, blob, ellipse,
  mix, lightOf, shadowOf, jitter, rgba, rngFrom, rowLayout, paintRects, streaks, hex, blade, meta, makeCanvas,
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
// Heavy timber with the planes of an adzed beam painted in: two or three broad value bands across u
// (dark, mid, light), a lit stroke down each band's left edge, dark grain grooves, checks, lit-rimmed
// knots. Grain along v; tiles both ways.
function timberTile(g, s, rnd, { bands, lit, groove, dark, knotC = null }) {
  fill(g, s, s, bands[1]);
  // the bands: widths that sum to the tile, neighbours never the same value
  const ws = []; let tot = 0;
  while (tot < s - 40) { const w = range(rnd, 64, 112); ws.push(w); tot += w; }
  const k = s / tot, x0 = rnd() * s;
  let x = x0, last = -1;
  const edges = [];
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i] * k;
    let bi = Math.floor(rnd() * bands.length); if (bi === last) bi = (bi + 1) % bands.length; if (i === ws.length - 1 && bi === edges[0]?.bi) bi = (bi + 1) % bands.length;
    last = bi;
    edges.push({ x, w, bi });
    x += w;
  }
  for (const { x: bx, w, bi } of edges) {
    const c = bands[bi];
    for (const dx of [0, -s, s]) {
      const X = bx + dx; if (X > s || X + w < 0) continue;
      g.fillStyle = grad(g, X, 0, X + w, 0, [[0, lightOf(c, 0.12)], [0.35, c], [1, shadowOf(c, 0.16)]]); g.fillRect(X, 0, w, s);
    }
  }
  mottle(g, s, rnd, { colors: [lightOf(bands[1], 0.2), shadowOf(bands[1], 0.25), bands[0], bands[2]], count: 18, rmin: s * 0.06, rmax: s * 0.18, alpha: 0.3, hard: 0.1, stretch: 3.5, rot: Math.PI / 2 });
  // grain grooves and lit fibres, periodic in v so the tile wraps
  for (let i = 0; i < 46; i++) {
    const gx = rnd() * s, kk = 1 + Math.floor(rnd() * 3), ph = rnd() * TAU, amp = range(rnd, 1, 4.5), k2 = 2 + Math.floor(rnd() * 3), ph2 = rnd() * TAU;
    const groove_ = rnd() < 0.62, w = groove_ ? range(rnd, 0.9, 2.2) : range(rnd, 0.6, 1.4), a = groove_ ? range(rnd, 0.18, 0.34) : range(rnd, 0.15, 0.3);
    const pts = [];
    for (let y = 0; y <= s; y += s / 32) pts.push([gx + Math.sin(TAU * kk * y / s + ph) * amp + Math.sin(TAU * k2 * y / s + ph2) * amp * 0.4, y]);
    for (const dx of [-s, 0, s]) line(g, pts.map(([u, v]) => [u + dx, v]), w, groove_ ? groove : lit, a);
  }
  // each band's left edge: a dark seam then a lit stroke (the arris catching the light)
  for (const { x: bx } of edges) for (const dx of [-s, 0, s]) {
    const X = bx + dx; if (X < -6 || X > s + 6) continue;
    const pts = []; for (let y = 0; y <= s; y += s / 16) pts.push([X + Math.sin(y / s * TAU * 2 + bx) * 1.2, y]);
    line(g, pts.map(([u, v]) => [u - 1.6, v]), 2.2, dark, 0.45);
    line(g, pts.map(([u, v]) => [u + 1.4, v]), 2.4, lit, 0.55);
  }
  // knots with a lit lower rim, checks
  for (let i = 0; i < 3; i++) {
    const kx = rnd() * s, ky = rnd() * s, r = range(rnd, 4, 7.5), kc = knotC || dark;
    wrap(s, kx, ky, r * 3.5, (X, Y) => {
      ellipse(g, X, Y, r * 2, r * 3.2, 0, shadowOf(bands[1], 0.2), 0.35);
      ellipse(g, X, Y, r, r * 1.5, 0, kc, 0.85);
      g.save(); g.globalAlpha = 0.6; g.strokeStyle = lit; g.lineWidth = 1.6; g.beginPath(); g.ellipse(X, Y, r * 1.2, r * 1.75, 0, 0.2, Math.PI * 0.9); g.stroke(); g.restore();
    });
  }
  for (let i = 0; i < 4; i++) {
    const cx = rnd() * s, cy = rnd() * s, L = range(rnd, s * 0.12, s * 0.35);
    const pts = []; for (let q = 0; q <= 8; q++) pts.push([cx + (rnd() - 0.5) * 1.5, cy + L * q / 8]);
    for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) {
      const p = pts.map(([u, v]) => [u + dx, v + dy]);
      line(g, p.map(([u, v]) => [u + 1.2, v]), 1.8, lit, 0.35);
      line(g, p, 1.4, dark, 0.7);
    }
  }
}
register('rs_timber', {
  family: F, size: 256, note: 'heavy timber (posts, beams, rails, palisade logs; grain along v): broad dark/mid/light bands, lit arrises, grain grooves, lit-rimmed knots',
  paint(g, s, rnd, h, cv) {
    timberTile(g, s, rnd, { bands: ['#5a3a24', '#7a5434', '#94704a'], lit: '#b08a5c', groove: '#3a2a20', dark: '#2e2220' });
    glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
    blurTile(cv, 0.45);
  },
});
register('rs_bleach', {
  family: F, size: 256, note: 'sun-bleached driftwood (Badlands stakes, poles, lashed posts; grain along v): gray-cream bands, silvery checks, dark cracks',
  paint(g, s, rnd, h, cv) {
    timberTile(g, s, rnd, { bands: ['#9e8e76', '#b8a890', '#c8baa2'], lit: '#e8dcc4', groove: '#5e5244', dark: '#4a4038', knotC: '#5a4a3c' });
    mottle(g, s, rnd, { colors: ['#9a9a94', '#a8a49a', '#8a7a68'], count: 14, rmin: 8, rmax: 24, alpha: 0.25, hard: 0.2, stretch: 3, rot: Math.PI / 2 });
    glaze(g, s, s, '#fff0d8', 0.08, 'soft-light');
    blurTile(cv, 0.45);
  },
});
register('rs_plaster', {
  family: F, size: 256, note: 'cream lime plaster between timbers (Elwynn gatehouse): soft trowel blotches, damp shadows, hairline cracks, a patch of wattle showing',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e0d0aa');
    mottle(g, s, rnd, { colors: ['#ecdec0', '#d2c09a', '#e6d6b2', '#c8b68e'], count: 26, rmin: 20, rmax: 64, alpha: 0.4, hard: 0.08 });
    for (let i = 0; i < 16; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 14, 32), a0 = rnd() * TAU, al = range(rnd, 0.8, 1.7), c = rnd() < 0.5 ? '#f6ead0' : '#bca884';
      wrap(s, x, y, r + 4, (X, Y) => { g.save(); g.strokeStyle = rgba(c, 0.22); g.lineWidth = range(rnd, 2, 4); g.beginPath(); g.arc(X, Y, r, a0, a0 + al); g.stroke(); g.restore(); });
    }
    // a patch where the plaster fell away: wattle under it, a lit lower lip on the plaster edge
    for (let i = 0; i < 2; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 10, 18), ps = Math.floor(rnd() * 1e9);
      wrap(s, x, y, r * 1.6, (X, Y) => {
        const pr = rngFrom(ps), pts = [];
        for (let k = 0; k < 8; k++) { const a = k / 8 * TAU; pts.push([X + Math.cos(a) * r * range(pr, 0.6, 1.2), Y + Math.sin(a) * r * 0.7 * range(pr, 0.6, 1.2)]); }
        polyPath(g, pts); g.fillStyle = '#7a6448'; g.fill();
        g.save(); polyPath(g, pts); g.clip();
        for (let k = -3; k <= 3; k++) line(g, [[X - r * 1.4, Y + k * 5], [X + r * 1.4, Y + k * 5 + 2]], 3, k % 2 ? '#9a8058' : '#5a4632', 0.8);
        g.restore();
        line(g, pts.slice(3, 7).map(([u, v]) => [u, v + 1.5]), 2, '#fff4dc', 0.5);
        line(g, pts.slice(0, 4).map(([u, v]) => [u + 1, v]), 2.5, '#6a5640', 0.5);
      });
    }
    cracks(g, s, rnd, { color: '#8a7656', count: 5, len: [16, 44], width: [0.6, 1.1], alpha: 0.45 });
    streaks(g, s, rnd, { colors: ['#b8a47e', '#a8946e'], count: 10, len: [30, 90], width: [3, 7], angle: Math.PI, wobble: 0.05, alpha: 0.12 });
    glaze(g, s, s, '#ffe8c0', 0.1, 'soft-light');
    blurTile(cv, 0.6);
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
    fill(g, s, s, '#2e2a34');
    const n = 4, W = s / n;
    for (let i = 0; i < n; i++) {
      for (const side of [-1, 1]) {
        const x0 = i * W + (side > 0 ? W * 0.5 : 0), yc = s / 2;
        const pts = [[x0 + 3, yc + side * 4], [x0 + W * 0.66, yc + side * 4], [x0 + W * 0.82, yc + side * (s / 2 - 2)], [x0 + W * 0.08, yc + side * (s / 2 - 2)]];
        wrap(s, x0 + W * 0.4, yc, W, (X) => {
          const q = pts.map(([u, v]) => [u - x0 - W * 0.4 + X, v]);
          polyPath(g, q.map(([u, v]) => [u + 2, v + 3])); g.fillStyle = rgba('#1e1a24', 0.55); g.fill();
          polyPath(g, q); g.fillStyle = grad(g, 0, yc - s / 2, 0, yc + s / 2, [[0, '#6a6058'], [0.5, '#4e484a'], [1, '#3a3438']]); g.fill();
          line(g, [q[0], q[1]], 3, '#8a8070', 0.65);
          line(g, [q[3], q[0]], 2, '#6a6058', 0.5);
        });
      }
    }
    mottle(g, s, rnd, { colors: ['#7a6a52', '#5a4c3e'], count: 18, rmin: 4, rmax: 14, alpha: 0.35, hard: 0.2 });
    blurTile(cv, 0.6);
  },
});
function hubFace(g, s, rnd, { rim = '#a8503a', cap = '#c8a050', tireEdge = 0.22 }) {
  const c = s / 2;
  fill(g, s, s, '#3a3438');
  const R = c - 1;
  g.fillStyle = radial(g, c - 10, c - 10, R * 0.3, R, [[0, '#5a5250'], [0.8, '#443e42'], [1, '#2e2a34']]);
  g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
  for (let i = 0; i < 24; i++) { const a = i / 24 * TAU; line(g, [[c + Math.cos(a) * R * 0.86, c + Math.sin(a) * R * 0.86], [c + Math.cos(a) * R * 0.98, c + Math.sin(a) * R * 0.98]], 2, '#5a5254', 0.5); }
  const r1 = R * (1 - tireEdge);
  g.fillStyle = radial(g, c - r1 * 0.3, c - r1 * 0.3, r1 * 0.1, r1, [[0, lightOf(rim, 0.35)], [0.7, rim], [1, shadowOf(rim, 0.5)]]);
  g.beginPath(); g.arc(c, c, r1, 0, TAU); g.fill();
  g.lineWidth = 3; g.strokeStyle = rgba(lightOf(rim, 0.6), 0.6); g.beginPath(); g.arc(c, c, r1 - 3, Math.PI * 1.0, Math.PI * 1.6); g.stroke();
  g.strokeStyle = rgba(INK, 0.5); g.beginPath(); g.arc(c, c, r1 - 3, Math.PI * 0.05, Math.PI * 0.65); g.stroke();
  for (let i = 0; i < 6; i++) { const a = i / 6 * TAU + 0.3; ellipse(g, c + Math.cos(a) * r1 * 0.62, c + Math.sin(a) * r1 * 0.62, r1 * 0.13, r1 * 0.1, a, '#2e2a34'); blob(g, c + Math.cos(a) * r1 * 0.62 + 2, c + Math.sin(a) * r1 * 0.62 + 2, r1 * 0.1, r1 * 0.07, a, lightOf(rim, 0.4), 0.35, 0.4); }
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
register('rs_canvas_plain', {
  family: F, size: 256, note: 'sun-bleached plain canvas (u along the cloth, v down to the hem): sewn widths, soft folds, rust runs and tide-mark stains, a darned patch, a stitched hem',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#cdbb94');
    mottle(g, s, rnd, { colors: ['#dccaa2', '#b8a27a', '#d4c49e', '#c2ad86'], count: 34, rmin: 22, rmax: 70, alpha: 0.34, hard: 0.08 });
    // a coarse weave, barely there
    for (let y = 0; y < s; y += 3) line(g, [[0, y + 1], [s, y + 1]], 1, rnd() < 0.5 ? '#9a8460' : '#e6d8b8', 0.08);
    for (let x = 0; x < s; x += 3) line(g, [[x + 1, 0], [x + 1, s]], 1, rnd() < 0.5 ? '#9a8460' : '#e6d8b8', 0.07);
    // soft vertical folds: a cool shadow on one side, a warm lit crest on the other
    for (let i = 0; i < 5; i++) {
      const x = rnd() * s, w = range(rnd, 14, 30);
      for (const dx of [-s, 0, s]) { g.fillStyle = grad(g, x + dx - w, 0, x + dx + w, 0, [[0, '#5a4a52', 0], [0.42, '#5a4a52', 0.22], [0.58, '#fff0d0', 0.2], [1, '#fff0d0', 0]]); g.fillRect(x + dx - w, 0, w * 2, s); }
    }
    // tide-mark water stains and rust runs from the top edge (where it lies over the plates)
    for (let i = 0; i < 5; i++) {
      const x = rnd() * s, y = range(rnd, 0.2, 0.7) * s, r = range(rnd, 12, 26);
      const a = rnd() * 3, k = range(rnd, 0.4, 0.7);
      wrap(s, x, y, r * 1.6, (X, Y) => { blob(g, X, Y, r, r * 0.75, a, '#8e7656', 0.2, 0.25); blob(g, X + r * 0.3, Y + r * 0.2, r * k, r * k * 0.8, a + 1, '#cdbb94', 0.35, 0.3); });
    }
    streaks(g, s, rnd, { colors: ['#8a5a36', '#7a5a40'], count: 9, len: [26, 90], width: [2, 5], angle: 0, wobble: 0.08, alpha: 0.2 });
    // two sewn widths per tile: a dark seam with a lit lap beside it and running stitches
    for (const sx of [s * 0.18, s * 0.68]) {
      line(g, [[sx, 0], [sx, s]], 2, '#5e4a3a', 0.45);
      line(g, [[sx + 2.5, 0], [sx + 2.5, s]], 2, '#f2e4c4', 0.32);
      g.save(); g.setLineDash([4, 4]);
      for (const o of [-4, 6]) line(g, [[sx + o, 0], [sx + o, s]], 1, '#4a3a30', 0.38);
      g.restore();
    }
    // a darned square patch, a shade darker and greener
    {
      const x = range(rnd, 0.3, 0.55) * s, y = range(rnd, 0.3, 0.5) * s, w = range(rnd, 34, 46), hh = range(rnd, 28, 38);
      g.save(); g.globalAlpha = 0.5; g.fillStyle = '#a89870'; g.fillRect(x, y, w, hh); g.restore();
      g.save(); g.setLineDash([3, 3]); g.strokeStyle = rgba('#4a3a30', 0.5); g.lineWidth = 1; g.strokeRect(x + 2, y + 2, w - 4, hh - 4); g.restore();
      line(g, [[x, y + hh], [x + w, y + hh]], 1.6, '#5a4a52', 0.35);
      line(g, [[x, y], [x + w, y]], 1.2, '#f6e8c8', 0.3);
    }
    // the hem: a turned-over band with two rows of stitching, a little darker with grime
    g.save(); g.globalAlpha = 0.18; g.fillStyle = '#6a5440'; g.fillRect(0, s - 20, s, 20); g.restore();
    line(g, [[0, s - 20], [s, s - 20]], 1.4, '#f2e4c4', 0.35);
    g.save(); g.setLineDash([5, 4]); line(g, [[0, s - 15], [s, s - 15]], 1.2, '#3a2a24', 0.5); line(g, [[0, s - 6], [s, s - 6]], 1.2, '#3a2a24', 0.4); g.restore();
    glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
    blurTile(cv, 0.7);
  },
});
// Irregular panels on a jittered grid, some merged into bigger ones: per pixel the panel, the distance to its
// border (to the nearest seed of a different panel) and which way that border lies. Tiles both ways.
function panelField(s, rnd, { cells = 5, jit = 0.85, merge = 0.3 } = {}) {
  const cs = s / cells, seeds = [];
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) seeds.push({ x: (i + 0.5 + (rnd() - 0.5) * jit) * cs, y: (j + 0.5 + (rnd() - 0.5) * jit) * cs, i, j });
  const par = seeds.map((_, k) => k), find = k => (par[k] === k ? k : (par[k] = find(par[k])));
  for (const sd of seeds) {
    const k = sd.j * cells + sd.i;
    if (rnd() < merge) par[find(k)] = find(sd.j * cells + (sd.i + 1) % cells);
    else if (rnd() < merge * 0.6) par[find(k)] = find(((sd.j + 1) % cells) * cells + sd.i);
  }
  const P = [];
  for (const sd of seeds) for (const dx of [-s, 0, s]) for (const dy of [-s, 0, s]) P.push({ x: sd.x + dx, y: sd.y + dy, p: find(sd.j * cells + sd.i) });
  const pid = new Int32Array(s * s), dist = new Float32Array(s * s), nx = new Float32Array(s * s), ny = new Float32Array(s * s);
  for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
    let best = 1e9, a = null;
    for (const q of P) { const d = (x - q.x) ** 2 + (y - q.y) ** 2; if (d < best) { best = d; a = q; } }
    let bd = 1e9, bx = 0, by = 0;
    for (const q of P) {
      if (q.p === a.p) continue;
      const ex = q.x - a.x, ey = q.y - a.y, L = Math.hypot(ex, ey);
      if (L > cs * 3.2) continue;
      const d = (((x - q.x) ** 2 + (y - q.y) ** 2) - best) / (2 * L);
      if (d < bd) { bd = d; bx = ex / L; by = ey / L; }
    }
    const k = y * s + x;
    pid[k] = a.p; dist[k] = bd; nx[k] = bx; ny[k] = by;
  }
  return { pid, dist, nx, ny };
}
register('rs_hide', {
  family: F, size: 256, note: 'stitched hides (Badlands banners, tablecloths, roofs): irregular rounded skins of several sizes, darkened curling edges, uneven thong stitches, puckers',
  paint(g, s, rnd, h, cv) {
    const { pid, dist, nx, ny } = panelField(s, rnd, { cells: 5, jit: 0.9, merge: 0.32 });
    const pal = ['#a87a4c', '#94683e', '#b48a5a', '#7e5836', '#9c744a', '#8a6440'];
    const col = new Map();
    const img = g.getImageData(0, 0, s, s), D = img.data;
    for (let k = 0; k < s * s; k++) {
      let c = col.get(pid[k]); if (!c) { c = hex(jitter(pick(rnd, pal), rnd, 0.06)); col.set(pid[k], c); }
      const e = dist[k];
      // the edge of each skin darkens and curls: a lit lip just inside it on the side facing the light
      const edgeK = Math.max(0, 1 - e / 9), facing = -(nx[k] * -0.707 + ny[k] * -0.707);
      let m = 1 - 0.32 * edgeK * edgeK;
      if (e > 1.5 && e < 5) m += 0.12 * Math.max(0, facing) * (1 - Math.abs(e - 3) / 2);
      let r = c.r * m, gg = c.g * m, b = c.b * m;
      if (e < 1.6) { const t = 1 - e / 1.6; r = r * (1 - t) + 0x3a * t; gg = gg * (1 - t) + 0x28 * t; b = b * (1 - t) + 0x1e * t; }
      D[k * 4] = r; D[k * 4 + 1] = gg; D[k * 4 + 2] = b; D[k * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    mottle(g, s, rnd, { colors: ['#c49a68', '#7a5434', '#b08458'], count: 22, rmin: 14, rmax: 40, alpha: 0.22, hard: 0.08 });
    // wrinkles: soft creases, shadow under, light over
    for (let i = 0; i < 14; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 16, 40), a = rnd() * TAU, bb = range(rnd, -0.5, 0.5);
      const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6, aa = a + bb * t; pts.push([x + Math.cos(aa) * L * t, y + Math.sin(aa) * L * t]); }
      wrap(s, x, y, L + 4, (X, Y) => { const q = pts.map(([u, v]) => [u - x + X, v - y + Y]); stroke(g, q.map(([u, v]) => [u, v + 1.5]), 2.4, 0.6, '#5a3a24', 0.3); stroke(g, q.map(([u, v]) => [u, v - 1]), 1.6, 0.4, '#d8b080', 0.28); });
    }
    // thong stitches across the seams at uneven spacing, a pucker beside some of them
    const pts = [];
    for (let y = 1; y < s; y += 2) for (let x = 1; x < s; x += 2) { const k = y * s + x; if (dist[k] < 1.1) pts.push([x, y, nx[k], ny[k]]); }
    for (let i = pts.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pts[i], pts[j]] = [pts[j], pts[i]]; }
    const taken = [];
    for (const [x, y, ux, uy] of pts) {
      const sp2 = range(rnd, 6, 12);
      if (taken.some(([a, b, r]) => { let dx = Math.abs(a - x), dy = Math.abs(b - y); dx = Math.min(dx, s - dx); dy = Math.min(dy, s - dy); return dx * dx + dy * dy < Math.min(r, sp2) ** 2; })) continue;
      taken.push([x, y, sp2]);
      const L = range(rnd, 3.5, 5.5), tilt = range(rnd, -0.35, 0.35), cx = Math.cos(tilt) * ux - Math.sin(tilt) * uy, cy = Math.sin(tilt) * ux + Math.cos(tilt) * uy;
      wrap(s, x, y, 8, (X, Y) => {
        line(g, [[X - cx * L + 0.8, Y - cy * L + 1], [X + cx * L + 0.8, Y + cy * L + 1]], 2.2, '#3a281c', 0.55);
        line(g, [[X - cx * L, Y - cy * L], [X + cx * L, Y + cy * L]], 1.8, '#e0c49a', 0.85);
        if (rnd() < 0.3) blob(g, X - cx * L * 1.6, Y - cy * L * 1.6, 3, 2, Math.atan2(cy, cx), '#5a3a24', 0.3, 0.3);
      });
    }
    for (let i = 0; i < 6; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 20, (X, Y) => blob(g, X, Y, range(rnd, 8, 18), range(rnd, 5, 10), rnd() * 3, '#c89a68', 0.25, 0.3)); }
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
// The flying machine's airframe atlas (512 x 512, fitted; roadside3d.js maps the same rects, canvas px, y down):
//   hull   [0, 0, 512, 248]    the fuselage skin: x along the hull (0 tail .. 512 nose), y around it from the top
//                              centre (0) down the side to the belly (248); both sides take the same image
//   cowl   [0, 256, 512, 376]  the brass nose bowl: x around it (tiles), y from its back edge (256) to the front lip
//   barrel [0, 384, 256, 512]  a finned cylinder barrel: x around (tiles), y from the crankcase (384) out to the head
//   face   [256, 384, 384, 512] the crankcase's front (a fitted disc)
//   trim   [384, 384, 512, 512] chipped red paint over metal (fitted: wing edge caps, the fin, debris)
// The hull is red-doped canvas over ribs for its back three quarters (rib tapes with stitching, the cloth sagging
// between them and between the deck stringers, a cream cheat line edged in chipped red, a faded roundel, a repair
// patch, a tear showing a rib through it) and riveted painted panels for the front quarter (seams with lit lips,
// rivet strips, louvres, an access hatch, a brass filler cap); oil and exhaust soot streak back from the cowl, the
// belly grimy, the deck sun-bleached. Light from the upper left everywhere.
const PLANE_R = { hull: [0, 0, 512, 248], cowl: [0, 256, 512, 376], barrel: [0, 384, 256, 512], face: [256, 384, 384, 512], trim: [384, 384, 512, 512] };
const PLANE_JOINT = 0.78;   // fabric → metal, as a fraction of the hull's length (roadside3d.js puts its brass band there)
// paint inside one region: clipped (with a 4 px gutter that the region's own paint spills into), origin at its corner
function inRegion(g, R, fn) {
  const [x0, y0, x1, y1] = R, G = 4;
  g.save(); g.beginPath(); g.rect(x0 - G, y0 - G, x1 - x0 + 2 * G, y1 - y0 + 2 * G); g.clip(); g.translate(x0, y0);
  fn(x1 - x0, y1 - y0);
  g.restore();
}
// soft blotches over a w x h area (wrapX: tiles across x)
function blots(g, w, h, rnd, { colors, count, rmin, rmax, alpha, hard = 0.15, stretch = 1, rot = null, wrapX: wx = false }) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * w, y = rnd() * h, r = range(rnd, rmin, rmax), c = pick(rnd, colors), a = rot == null ? rnd() * Math.PI : rot, s = stretch * range(rnd, 0.7, 1.3), al = alpha * range(rnd, 0.6, 1);
    for (const dx of wx ? [0, -w, w] : [0]) if (x + dx > -r * s - 4 && x + dx < w + r * s + 4) blob(g, x + dx, y, r * s, r, a, c, al, hard);
  }
}
const NOWRAP = 1e6;   // pass as the tile size to the wrapping helpers (chip, dent, rustRun) so they draw once
// paint a layer on its own canvas (with a margin), blur it soft and lay it over: oil, soot and grime as painted smears
function softLayer(g, w, h, px, fn, alpha = 1) {
  const P = Math.ceil(px * 3) + 4, cv = makeCanvas(w + 2 * P, h + 2 * P), g2 = cv.getContext('2d', { willReadFrequently: true });
  g2.translate(P, P); fn(g2); blurTile(cv, px);
  g.save(); g.globalAlpha *= alpha; g.drawImage(cv, -P, -P); g.restore();
}

function planeHull(g, w, h, rnd) {
  const J = Math.round(w * PLANE_JOINT), RED = '#973b2c', REDL = '#b55c45', REDD = '#702c26', CREAM = '#e2d2aa', PRIMER = '#c9b48e';
  g.fillStyle = RED; g.fillRect(-4, -4, w + 8, h + 8);
  g.fillStyle = rgba(REDD, 0.22); g.fillRect(J, -4, w - J + 4, h + 8);
  blots(g, w, h, rnd, { colors: [REDL, REDD, '#a8483a'], count: 9, rmin: 40, rmax: 80, alpha: 0.4, hard: 0.05, stretch: 1.8, rot: 0 });
  blots(g, w, h, rnd, { colors: [REDL, REDD, lightOf(RED, 0.2)], count: 40, rmin: 10, rmax: 30, alpha: 0.18 });
  // painted light: the deck sun-bleached and lit, the side mid, the belly in shade and grime
  g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#ffe2b0', 0.3], [0.12, '#ffe2b0', 0.16], [0.32, '#ffe2b0', 0.02], [0.6, '#3a2430', 0], [0.82, '#3a2430', 0.22], [1, '#2e2028', 0.45]]);
  g.fillRect(-4, -4, w + 8, h + 8);
  // the deck stringers: the cloth sags between them (lit on the upper half of each sag), a lit ridge on each
  for (const y of [0.075, 0.16, 0.245].map(f => f * h)) {
    g.fillStyle = grad(g, 0, y - 18, 0, y + 6, [[0, '#ffe8c0', 0], [0.7, '#ffe8c0', 0.1], [0.85, '#fff0d0', 0.28], [1, '#4a2a2a', 0]]); g.fillRect(-4, y - 18, J + 4, 24);
    g.fillStyle = grad(g, 0, y, 0, y + 9, [[0, '#3a2228', 0.3], [1, '#3a2228', 0]]); g.fillRect(-4, y, J + 4, 9);
  }
  // rib stations every ~0.42 m along the fabric: the cloth sagging in each bay, then the rib tape with its stitching
  const ribs = [];
  for (let x = 16; x < J - 12; x += 35) ribs.push(x + range(rnd, -2, 2));
  for (let i = 0; i < ribs.length; i++) {
    const a = ribs[i], b = i + 1 < ribs.length ? ribs[i + 1] : J;
    g.fillStyle = grad(g, a, 0, b, 0, [[0, '#2e1c24', 0.32], [0.14, '#2e1c24', 0.08], [0.45, '#ffe6bc', 0.2], [0.78, '#ffe6bc', 0.06], [0.95, '#2e1c24', 0.12], [1, '#2e1c24', 0.2]]);
    g.fillRect(a, -4, b - a, h + 8);
  }
  if (ribs[0] > 4) { g.fillStyle = grad(g, 0, 0, ribs[0], 0, [[0, '#ffe6bc', 0.1], [1, '#2e1c24', 0.2]]); g.fillRect(-4, -4, ribs[0] + 4, h + 8); }
  for (const x of ribs) {
    g.fillStyle = rgba(REDL, 0.5); g.fillRect(x - 3, -4, 6, h + 8);
    g.fillStyle = rgba('#fff0d0', 0.3); g.fillRect(x - 3, -4, 1.5, h + 8);
    g.fillStyle = grad(g, x + 3, 0, x + 8, 0, [[0, '#2a1820', 0.35], [1, '#2a1820', 0]]); g.fillRect(x + 3, -4, 5, h + 8);
    for (let y = 3; y < h; y += 7) line(g, [[x - 1.6, y], [x + 1.6, y + 1.6]], 0.8, '#5a2a22', 0.3);
  }
  // the cheat line: a cream stripe the length of the hull, sweeping up toward the nose, pinstriped in deep red
  const cy = x => h * (0.4 - 0.05 * (x / w) ** 2);
  const band = (off, wd, col, al) => { const P = []; for (let x = -4; x <= w + 4; x += 8) P.push([x, cy(x) + off]); g.save(); g.globalAlpha = al; g.strokeStyle = col; g.lineWidth = wd; g.beginPath(); P.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke(); g.restore(); };
  band(0, 15, CREAM, 0.92); band(-1, 4, '#fff4d8', 0.3); band(-10, 3, REDD, 0.9); band(10, 3, REDD, 0.9); band(12.5, 2, '#2a1820', 0.25);
  for (let i = 0; i < 26; i++) { const x = rnd() * w, side = rnd() < 0.5 ? -1 : 1; chip(g, NOWRAP, x, cy(x) + side * range(rnd, 5, 10), range(rnd, 1.6, 3.6), x > J ? '#8c8478' : PRIMER, rnd); }
  // the faded roundel (sun-worn, paint lifting off it)
  {
    const rx = 0.33 * w, ry0 = 0.64 * h, R = 40, SY = 1.12;
    g.save(); g.translate(rx, ry0); g.scale(1, SY);
    for (const [r, col] of [[R, '#4a3a34'], [R - 3, CREAM], [R * 0.74, '#a03c2c'], [R * 0.5, CREAM]]) { g.fillStyle = rgba(col, 0.82); g.beginPath(); g.arc(0, 0, r, 0, TAU); g.fill(); }
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; ellipse(g, Math.cos(a) * R * 0.4, Math.sin(a) * R * 0.4, 4.6, 4, a, '#7a5a24', 0.85); }
    g.fillStyle = grad(g, -14, -14, 14, 14, [[0, '#e8cc80'], [1, '#6a4e22']]); g.globalAlpha = 0.85; g.beginPath(); g.arc(0, 0, R * 0.36, 0, TAU); g.fill();
    g.globalAlpha = 1; ellipse(g, 0, 0, 4.5, 4.5, 0, '#3a2a30', 0.85);
    g.restore();
    // sun fade over it and the paint lifting in flakes
    blob(g, rx - 8, ry0 - 14, R * 1.2, R * 0.9, 0.4, '#f0dcb4', 0.22, 0.2);
    for (let i = 0; i < 14; i++) { const a = rnd() * TAU, d = range(rnd, 4, R * 0.95); chip(g, NOWRAP, rx + Math.cos(a) * d, ry0 + Math.sin(a) * d * SY, range(rnd, 1.5, 3.5), rnd() < 0.5 ? PRIMER : RED, rnd); }
  }
  // a doped repair patch on the deck, stitched on with pinked edges
  {
    const x = 0.5 * w, y = 0.13 * h, pw = 34, ph = 22;
    g.save(); g.translate(x, y); g.rotate(-0.05);
    g.fillStyle = rgba('#2a1820', 0.3); g.fillRect(-pw / 2 + 2, -ph / 2 + 3, pw, ph);
    g.fillStyle = grad(g, 0, -ph / 2, 0, ph / 2, [[0, lightOf('#a8483a', 0.3)], [1, '#8a3428']]); g.fillRect(-pw / 2, -ph / 2, pw, ph);
    g.setLineDash([2, 2.5]); g.strokeStyle = rgba('#e0c8a0', 0.7); g.lineWidth = 1; g.strokeRect(-pw / 2 + 3, -ph / 2 + 3, pw - 6, ph - 6);
    g.restore();
  }
  // a tear in the cloth aft, a rib and a stringer showing through, the torn edges curling up pale
  {
    const x = 0.15 * w, y = 0.72 * h, r = 15;
    const pts = []; for (let k = 0; k < 14; k++) { const a = k / 14 * TAU, rr = r * range(rnd, 0.6, 1.15); pts.push([x + Math.cos(a) * rr * 1.25, y + Math.sin(a) * rr * 0.85]); }
    blob(g, x + 2, y + 2, r * 1.8, r * 1.3, 0, '#3a2228', 0.3, 0.2);
    polyPath(g, pts); g.fillStyle = radial(g, x - 5, y - 4, 1, r * 1.5, [[0, '#2a1a1c'], [1, '#3e2a26']]); g.fill();
    g.save(); polyPath(g, pts); g.clip();
    g.fillStyle = '#8a6a44'; g.fillRect(x + 3, y - r * 1.2, 5, r * 2.4); g.fillStyle = rgba('#d8b880', 0.6); g.fillRect(x + 3, y - r * 1.2, 1.5, r * 2.4);
    g.fillStyle = '#7a5a3a'; g.fillRect(x - r * 1.5, y + 4, r * 3, 3);
    g.restore();
    g.lineWidth = 2.6; g.strokeStyle = rgba('#e8d8b4', 0.85); polyPath(g, pts); g.stroke();
    g.lineWidth = 1; g.strokeStyle = rgba('#6a3a2c', 0.8); polyPath(g, pts.map(([u, v]) => [x + (u - x) * 1.14, y + (v - y) * 1.1])); g.stroke();
  }
  // ---- the metal nose section ----
  // the joint: a riveted strip over the cloth's leading edge
  g.fillStyle = grad(g, J - 6, 0, J + 8, 0, [[0, '#2a1820', 0.4], [0.35, '#8a3428', 1], [0.55, lightOf(RED, 0.35), 1], [1, '#8a3428', 1]]); g.fillRect(J - 6, -4, 14, h + 8);
  for (let y = 5; y < h; y += 9) { rivet(g, J - 1, y + range(rnd, -0.6, 0.6), 1.9, '#c8a050'); rivet(g, J + 5, y + 4.5, 1.9, '#c8a050'); }
  const seam = (x0, y0, x1, y1) => {
    line(g, [[x0 + 1.5, y0 + 1.5], [x1 + 1.5, y1 + 1.5]], 1.2, lightOf(RED, 0.55), 0.5);
    line(g, [[x0, y0], [x1, y1]], 2.2, '#2a1820', 0.8);
    const L = Math.hypot(x1 - x0, y1 - y0), n = Math.floor(L / 9);
    const nx = -(y1 - y0) / L, ny = (x1 - x0) / L;
    for (let k = 1; k < n; k++) { const t = k / n; for (const s2 of [-1, 1]) if (rnd() > 0.06) rivet(g, x0 + (x1 - x0) * t + nx * s2 * 4.5, y0 + (y1 - y0) * t + ny * s2 * 4.5, 1.7, lightOf(RED, 0.25)); }
  };
  const xs = [J + 0.42 * (w - J), J + 0.78 * (w - J)];
  for (const x of xs) seam(x, 0, x + 1, h);
  seam(J + 8, 0.27 * h, w, 0.26 * h); seam(J + 8, 0.82 * h, w, 0.84 * h);
  // louvres: a row of slanted hoods on the side, each lit along its top lip with a dark slot under it
  for (let k = 0; k < 5; k++) {
    const x = xs[0] + 10 + k * 8.5, y0 = 0.47 * h, L = 0.17 * h;
    g.save(); g.translate(x, y0); g.rotate(0.12);
    g.fillStyle = rgba('#24161c', 0.85); g.fillRect(0, 0, 4, L);
    g.fillStyle = rgba(lightOf(RED, 0.5), 0.9); g.fillRect(-2.2, 0, 2.2, L);
    g.fillStyle = rgba('#24161c', 0.3); g.fillRect(4, 1, 2.5, L);
    g.restore();
  }
  // an access hatch with four screws and a latch
  {
    const x = J + 14, y = 0.5 * h, hw = 30, hh = 0.22 * h;
    g.lineWidth = 2; g.strokeStyle = rgba('#2a1820', 0.8); g.strokeRect(x, y, hw, hh);
    g.lineWidth = 1; g.strokeStyle = rgba(lightOf(RED, 0.5), 0.6); g.strokeRect(x + 2, y + 2, hw - 4, hh - 4);
    for (const [a, b] of [[4, 4], [hw - 4, 4], [4, hh - 4], [hw - 4, hh - 4]]) nail(g, x + a, y + b, 1.8);
    g.fillStyle = '#c8a050'; g.fillRect(x + hw / 2 - 5, y + hh / 2 - 2, 10, 4); g.fillStyle = rgba('#fff0c0', 0.6); g.fillRect(x + hw / 2 - 5, y + hh / 2 - 2, 10, 1.2);
  }
  // wear: paint chipped off the panel edges to the metal, scuffs and a few dents
  for (let i = 0; i < 24; i++) { const x = J + rnd() * (w - J), y = rnd() * h; chip(g, NOWRAP, x, y, range(rnd, 1.6, 4.5), rnd() < 0.6 ? '#8c8478' : '#a8843a', rnd); }
  for (let i = 0; i < 30; i++) { const x = rnd() * J, y = rnd() * h; chip(g, NOWRAP, x, y, range(rnd, 1.4, 3.2), PRIMER, rnd); }
  for (let i = 0; i < 4; i++) dent(g, NOWRAP, J + range(rnd, 0.1, 0.9) * (w - J), range(rnd, 0.3, 0.9) * h, range(rnd, 8, 14), RED, 0.45);
  // oil from the engine: dark smears blown back along the lower side and belly, thinning as they go, a wet
  // sheen on the thick ones near the nose; soot from the exhaust stubs on the side
  softLayer(g, w, h, 2.2, q => {
    for (let i = 0; i < 12; i++) {
      const y0 = range(rnd, 0.45, 1.0) * h, L = range(rnd, 60, i < 4 ? 300 : 170), w0 = range(rnd, 7, 16), drift = range(rnd, 0, 0.1);
      const P = []; for (let k = 0; k <= 8; k++) { const t = k / 8; P.push([w + 6 - L * t, y0 + L * t * drift + Math.sin(t * 4 + i) * 2]); }
      stroke(q, P, w0, 1, pick(rnd, ['#2a1c18', '#3a2a1e', '#4a3420']), range(rnd, 0.22, 0.4));
    }
    for (let i = 0; i < 6; i++) {
      const y0 = range(rnd, 0.42, 0.52) * h, L = range(rnd, 80, 210);
      const P = []; for (let k = 0; k <= 6; k++) { const t = k / 6; P.push([w - 12 - L * t, y0 + L * t * 0.05]); }
      stroke(q, P, range(rnd, 12, 20), 3, '#2e2a2c', 0.18);
    }
    blob(q, w - 14, 0.47 * h, 22, 10, 0, '#2e2a2c', 0.4, 0.2);
  });
  softLayer(g, w, h, 0.8, q => {
    for (let i = 0; i < 7; i++) {
      const y0 = range(rnd, 0.55, 0.95) * h, L = range(rnd, 30, 110), x0 = w - range(rnd, 2, 40);
      stroke(q, [[x0, y0], [x0 - L * 0.5, y0 + 1], [x0 - L, y0 + 2]], range(rnd, 2.5, 4), 0.6, '#1e1414', 0.4);
      stroke(q, [[x0, y0 - 1.5], [x0 - L * 0.4, y0 - 1]], 1, 0.4, '#d8c0a0', 0.35);
    }
  });
  // grime and rain: dirt washed down the sides, mud thrown up along the belly, scorch near the nose
  softLayer(g, w, h, 1.6, q => {
    for (let i = 0; i < 14; i++) { const x = rnd() * w, y = range(rnd, 0.3, 0.7) * h, L = range(rnd, 25, 70); stroke(q, [[x, y], [x + range(rnd, -2, 2), y + L]], range(rnd, 4, 9), 1, '#4a3028', 0.18); }
    blots(q, w, h, rnd, { colors: ['#5a4232', '#4a3628'], count: 14, rmin: 6, rmax: 16, alpha: 0.3, hard: 0.3 });
  });
  for (let i = 0; i < 3; i++) { const x = w - range(rnd, 10, 90), y = range(rnd, 0.75, 0.98) * h, r = range(rnd, 12, 22); blob(g, x, y, r * 1.4, r, 0, '#6a4a30', 0.3, 0.1); blob(g, x, y, r, r * 0.7, 0, '#2e2220', 0.4, 0.2); }
  glaze(g, w, h, '#ffe2b8', 0.1, 'soft-light');
}

function planeCowl(g, w, h, rnd) {
  const BR = '#a8843a';
  g.fillStyle = BR; g.fillRect(-4, -4, w + 8, h + 8);
  blots(g, w, h, rnd, { colors: ['#c8a050', '#8a6a2c', '#d8b860', '#9a7430'], count: 30, rmin: 12, rmax: 36, alpha: 0.42, hard: 0.1, stretch: 2.6, rot: 0, wrapX: true });
  // brushed round the bowl
  for (let i = 0; i < 70; i++) { const x = rnd() * w, y = rnd() * h, L = range(rnd, 20, 80), c = rnd() < 0.5 ? '#e8cc78' : '#7a5a24', a = range(rnd, 0.12, 0.28); for (const dx of [0, -w, w]) line(g, [[x + dx, y], [x + dx + L, y + range(rnd, -1, 1)]], range(rnd, 0.6, 1.3), c, a); }
  // a crevice where the bowl meets the hull, soot and oil round the front lip
  g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#2a1c18', 0.5], [0.06, '#2a1c18', 0], [0.8, '#2a2224', 0], [1, '#2a2224', 0.55]]); g.fillRect(-4, -4, w + 8, h + 8);
  // the red band round its back edge, chipped back to the brass, with a cream pinstripe
  g.fillStyle = '#973b2c'; g.fillRect(-4, 4, w + 8, 18);
  g.fillStyle = grad(g, 0, 4, 0, 22, [[0, '#fff0d0', 0.35], [0.25, '#fff0d0', 0], [1, '#2a1820', 0.3]]); g.fillRect(-4, 4, w + 8, 18);
  g.fillStyle = '#e2d2aa'; g.fillRect(-4, 23, w + 8, 3);
  for (let i = 0; i < 22; i++) { const x = rnd() * w, y = range(rnd, 6, 24); for (const dx of [0, -w, w]) if (x + dx > -8 && x + dx < w + 8) chip(g, NOWRAP, x + dx, y, range(rnd, 1.5, 4), '#b89448', rnd); }
  // six panels: seams with a lit lip, rivet columns either side; rivet rows round the band and the lip
  const n = 6, seams = []; for (let k = 0; k < n; k++) seams.push(k * w / n + range(rnd, -6, 6));
  for (const x of seams) for (const dx of [0, -w, w]) {
    const X = x + dx; if (X < -12 || X > w + 12) continue;
    line(g, [[X + 1.5, 26], [X + 1.5, h]], 1.2, '#f0d890', 0.5); line(g, [[X, 26], [X, h]], 2.2, '#3a2a14', 0.8);
    for (let y = 33; y < h - 6; y += 9) for (const s2 of [-4.5, 4.5]) rivet(g, X + s2, y, 1.8, '#c8a050');
  }
  for (const y of [30, h - 9]) for (let x = 3; x < w; x += 10) rivet(g, x + range(rnd, -0.8, 0.8), y, 1.8, '#c8a050');
  // louvres on each panel, Dzus fasteners by the seams
  for (let k = 0; k < n; k++) {
    const x0 = seams[k] + w / n * 0.3;
    for (let j = 0; j < (k % 3 === 1 ? 0 : 3); j++) {
      const x = x0 + j * 11, y0 = 44, L = 34;
      for (const dx of [0, -w, w]) {
        const X = x + dx; if (X < -12 || X > w + 12) continue;
        g.fillStyle = rgba('#2a1c14', 0.85); g.fillRect(X, y0, 4, L);
        g.fillStyle = rgba('#f0d890', 0.85); g.fillRect(X - 2.2, y0, 2.2, L);
        g.fillStyle = rgba('#2a1c14', 0.3); g.fillRect(X + 4, y0 + 1, 2.5, L);
      }
    }
    for (const y of [56, 92]) { const X = seams[k] + 11; ellipse(g, X, y, 3.2, 3.2, 0, '#6a4e22'); line(g, [[X - 2.2, y - 1], [X + 2.2, y + 1]], 1.1, '#2a1c14', 0.9); blob(g, X - 1, y - 1.2, 1.5, 1, 0, '#fff0c0', 0.5, 0.4); }
  }
  for (let i = 0; i < 6; i++) dent(g, NOWRAP, 20 + rnd() * (w - 40), range(rnd, 40, h - 20), range(rnd, 8, 16), BR, 0.5);
  // oil blown back over it from the front lip (toward its back edge), soot on the lip
  softLayer(g, w, h, 2, q => {
    for (let i = 0; i < 16; i++) {
      const x = rnd() * w, L = range(rnd, 25, h * 0.85), w0 = range(rnd, 6, 13);
      const P = []; for (let k = 0; k <= 6; k++) { const t = k / 6; P.push([x + Math.sin(t * 3 + i) * 3, h + 4 - L * t]); }
      for (const dx of [0, -w, w]) stroke(q, P.map(([u, v]) => [u + dx, v]), w0, 1, pick(rnd, ['#2a1c14', '#3e2a18']), range(rnd, 0.2, 0.38));
    }
    for (let i = 0; i < 10; i++) { const x = rnd() * w; for (const dx of [0, -w, w]) blob(q, x + dx, h - 5, range(rnd, 16, 32), 9, 0, '#2a2224', 0.35, 0.2); }
  });
  glaze(g, w, h, '#ffe2b8', 0.08, 'soft-light');
}

function planeBarrel(g, w, h, rnd) {
  g.fillStyle = '#5e5a5c'; g.fillRect(-4, -4, w + 8, h + 8);
  // base flange (y 0..12) with its bolts
  g.fillStyle = '#4a464a'; g.fillRect(-4, -4, w + 8, 16);
  g.fillStyle = rgba('#a49a90', 0.5); g.fillRect(-4, 0, w + 8, 2);
  for (let x = 8; x < w; x += 21) nail(g, x, 6, 2.6);
  // seven cooling fins between y 14 and 119 (roadside3d.js ridges the barrel's profile to match: a crest a quarter
  // of the way into each, the gap three quarters in): the lit fin face with a bright crest, the dark gap; then
  // heat-bluing toward the head
  const FP = (119 - 14) / 7;
  for (let k = 0; k < 7; k++) {
    const y0 = 14 + k * FP;
    g.fillStyle = grad(g, 0, y0, 0, y0 + FP, [[0, '#3a3640', 0.5], [0.08, '#8a8486', 0.45], [0.25, '#c8beb2', 0.8], [0.42, '#8a8486', 0.45], [0.6, '#24202a', 0.75], [0.78, '#1c1820', 0.85], [1, '#3a3640', 0.5]]);
    g.fillRect(-4, y0, w + 8, FP);
  }
  g.fillStyle = grad(g, 0, h * 0.45, 0, h, [[0, '#6a5a8a', 0], [0.6, '#7a5a7a', 0.22], [1, '#a07a4a', 0.3]]); g.fillRect(-4, h * 0.45, w + 8, h * 0.55 + 4);
  // oil weeping down from the head and rust in the gaps
  for (let i = 0; i < 16; i++) { const x = rnd() * w, L = range(rnd, 20, 90); for (const dx of [0, -w, w]) if (x + dx > -6 && x + dx < w + 6) stroke(g, [[x + dx, h], [x + dx + range(rnd, -1, 1), h - L]], range(rnd, 2, 4), 0.5, '#2a1c18', range(rnd, 0.2, 0.4)); }
  for (let i = 0; i < 30; i++) { const x = rnd() * w, y = 14 + (Math.floor(rnd() * 7) + 0.75) * FP; for (const dx of [0, -w, w]) if (x + dx > -6 && x + dx < w + 6) blob(g, x + dx, y, range(rnd, 2, 6), 1.5, 0, '#9a5a2c', 0.45, 0.3); }
  // the head joint: a lighter machined ring
  g.fillStyle = '#7a7270'; g.fillRect(-4, 119, w + 8, h - 119 + 4); g.fillStyle = rgba('#d8ccb8', 0.5); g.fillRect(-4, 119, w + 8, 1.5);
  glaze(g, w, h, '#ffe2b8', 0.08, 'soft-light');
}

function planeFace(g, w, h, rnd) {
  const c = w / 2;
  g.fillStyle = '#4e4a4e'; g.fillRect(-4, -4, w + 8, h + 8);
  // a domed iron cover lit from the upper left, a raised rim, seven bolts, a brass boss with oil weeping from it
  g.fillStyle = radial(g, c - 18, c - 20, 4, c, [[0, '#8a827e'], [0.6, '#5e5a5c'], [1, '#3e3a40']]); g.beginPath(); g.arc(c, c, c - 2, 0, TAU); g.fill();
  g.lineWidth = 5; g.strokeStyle = rgba('#2a2630', 0.7); g.beginPath(); g.arc(c + 1, c + 1, c - 12, 0, TAU); g.stroke();
  g.lineWidth = 2; g.strokeStyle = rgba('#c8bcae', 0.55); g.beginPath(); g.arc(c - 1, c - 1, c - 12, Math.PI * 0.9, Math.PI * 1.7); g.stroke();
  for (let k = 0; k < 7; k++) { const a = k / 7 * TAU + 0.2; nail(g, c + Math.cos(a) * (c - 22), c + Math.sin(a) * (c - 22), 4); }
  g.fillStyle = radial(g, c - 6, c - 7, 1, 22, [[0, '#f0d890'], [0.6, '#b08a3c'], [1, '#6a4e22']]); g.beginPath(); g.arc(c, c, 20, 0, TAU); g.fill();
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; ellipse(g, c + Math.cos(a) * 13, c + Math.sin(a) * 13, 2.4, 2.4, 0, '#5a4018'); }
  ellipse(g, c, c, 5, 5, 0, '#2a2026');
  for (let i = 0; i < 6; i++) { const a = range(rnd, 0.3, 2.8), x = c + Math.cos(a) * 18, y = c + Math.sin(a) * 18; stroke(g, [[x, y], [x + range(rnd, -3, 3), y + range(rnd, 14, 34)]], range(rnd, 2, 4), 0.6, '#2a1c18', 0.4); }
  for (let i = 0; i < 8; i++) blob(g, rnd() * w, rnd() * h, range(rnd, 3, 8), range(rnd, 2, 5), rnd() * 3, '#8a5634', 0.35, 0.3);
}

function planeTrim(g, w, h, rnd) {
  const RED = '#973b2c';
  g.fillStyle = RED; g.fillRect(-4, -4, w + 8, h + 8);
  blots(g, w, h, rnd, { colors: ['#b55c45', '#702c26', '#a8483a'], count: 18, rmin: 10, rmax: 30, alpha: 0.35, hard: 0.1 });
  g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#ffe2b0', 0.25], [0.2, '#ffe2b0', 0], [0.8, '#2e2028', 0], [1, '#2e2028', 0.35]]); g.fillRect(-4, -4, w + 8, h + 8);
  g.fillStyle = '#e2d2aa'; g.fillRect(-4, h * 0.3, w + 8, 4); g.fillStyle = rgba('#702c26', 0.9); g.fillRect(-4, h * 0.3 + 4, w + 8, 1.5);
  for (let y = 7; y < h; y += 30) for (let x = 6; x < w; x += 12) rivet(g, x, y, 1.8, lightOf(RED, 0.25));
  for (let i = 0; i < 16; i++) chip(g, NOWRAP, rnd() * w, rnd() * h, range(rnd, 1.6, 4.5), rnd() < 0.6 ? '#8c8478' : '#c9b48e', rnd);
  for (let i = 0; i < 10; i++) { const x = rnd() * w, y = rnd() * h * 0.6; stroke(g, [[x, y], [x + range(rnd, -2, 2), y + range(rnd, 14, 40)]], range(rnd, 2, 4), 0.5, '#5a3020', 0.25); }
  glaze(g, w, h, '#ffe2b8', 0.08, 'soft-light');
}

register('rs_plane', {
  family: F, size: 512, note: 'the flying machine\'s airframe atlas (fitted rects: hull 0,0-512,248 · cowl 0,256-512,376 · barrel 0,384-256,512 · face 256,384-384,512 · trim 384,384-512,512): red-doped canvas over rib tapes and a riveted nose, cheat line, faded roundel, oil and soot; a brass cowl in six riveted panels with louvres and a chipped red band; finned cylinder barrels; the crankcase face; chipped red trim',
  paint(g, s, rnd, h, cv) {
    g.fillStyle = '#973b2c'; g.fillRect(0, 0, s, s);
    inRegion(g, PLANE_R.hull, (w, hh) => planeHull(g, w, hh, rnd));
    inRegion(g, PLANE_R.cowl, (w, hh) => planeCowl(g, w, hh, rnd));
    inRegion(g, PLANE_R.barrel, (w, hh) => planeBarrel(g, w, hh, rnd));
    inRegion(g, PLANE_R.face, (w, hh) => planeFace(g, w, hh, rnd));
    inRegion(g, PLANE_R.trim, (w, hh) => planeTrim(g, w, hh, rnd));
    blurTile(cv, 0.45);
  },
});

// The gas bag's torn envelope, dragged over the mesa rim (alpha, fitted: u across, v from the gathered top
// edge down to the hem). Weathered off-white doped canvas in six gores, every other one a bold faded-red
// stripe (sun-bleached in blotches, the cream showing through where the dope wore off), stitched welts
// between them; the hanging folds painted in (cool shadows in the troughs, warm lit crests), loose folds on
// the part that lies on the top; rain grime and mud toward the hem, a tan repair patch, a scorch with a burnt
// hole, and the hem torn into four ragged tongues of different lengths.
register('rs_gasbag', {
  family: F, size: 256, alpha: true, note: 'torn gas-bag envelope (alpha, fitted; v=1 top edge, v=0 hem): off-white doped canvas, six gores with bold faded-red stripes, painted hanging folds, grime, repair patch, scorch and holes, hem in 4 tongues',
  paint(g, s, rnd, h, cv) {
    const lerp = (a, b, t) => a + (b - a) * t, smooth01 = t => { const c = Math.max(0, Math.min(1, t)); return c * c * (3 - 2 * c); };
    // the outline: a gathered top edge, ragged sides narrowing a little, the hem torn into tongues
    const body = 0.72 * s, out = [];
    out.push([2, 0], [s - 2, 0]);
    for (let k = 1; k <= 8; k++) { const y = body * k / 8; out.push([s - 2 - 10 * (k / 8) - range(rnd, 0, 5), y]); }
    // tongues from right to left: [valley x, tip x, tip y]
    const nT = 4, edges = [s - 14];
    for (let k = 1; k < nT; k++) edges.push(s - 14 - (s - 28) * (k / nT) + range(rnd, -14, 14));
    edges.push(14);
    for (let k = 0; k < nT; k++) {
      const xr = edges[k], xl = edges[k + 1], tipY = s * [0.97, 0.89, 0.99, 0.92][k] - range(rnd, 0, 8), tipX = lerp(xl, xr, range(rnd, 0.3, 0.6));
      const valley = body + range(rnd, -6, 10);
      if (k > 0) out.push([xr, valley]);
      // the right flank of the tongue frays down to its tip, the left flank back up
      for (let q = 1; q <= 4; q++) { const t = q / 4; out.push([lerp(xr - 2, tipX + 4, t) + range(rnd, -3, 3), lerp(valley + 4, tipY, t * t)]); }
      out.push([tipX, tipY + 3]);
      for (let q = 3; q >= 1; q--) { const t = q / 4; out.push([lerp(xl + 2, tipX - 4, t) + range(rnd, -3, 3), lerp(valley + 6, tipY, t * t)]); }
    }
    for (let k = 8; k >= 1; k--) { const y = body * k / 8; out.push([2 + 9 * (k / 8) + range(rnd, 0, 5), y]); }
    g.save(); polyPath(g, out); g.clip();
    // six gores, the odd ones faded red; each bellied: lit on the side toward the light, shadowed into the next seam
    const seams = [0, 1, 2, 3, 4, 5, 6].map(i => (i % 6 ? i / 6 + range(rnd, -0.015, 0.015) : i / 6) * s);
    const CREAM = ['#d6cab0', '#dccfb2', '#d2c6aa'], RED = ['#a14c3c', '#9a4637', '#a8543f'];
    for (let i = 0; i < 6; i++) {
      const x0 = seams[i], x1 = seams[i + 1], c = jitter(i % 2 ? RED[(i - 1) / 2] : CREAM[i / 2], rnd, 0.03);
      g.fillStyle = c; g.fillRect(x0, 0, x1 - x0 + 1, s);
      g.fillStyle = grad(g, x0, 0, x1, 0, [[0, shadowOf(c, 0.25), 0.5], [0.2, lightOf(c, 0.2), 0.3], [0.5, lightOf(c, 0.12), 0.12], [0.85, shadowOf(c, 0.2), 0.22], [1, shadowOf(c, 0.35), 0.5]]);
      g.fillRect(x0, 0, x1 - x0 + 1, s);
      if (i % 2) {
        // the red dope sun-bleached in soft blotches and worn through to the cream in scuffs
        for (let k = 0; k < 5; k++) blob(g, range(rnd, x0 + 6, x1 - 6), range(rnd, 0.05, 0.9) * s, range(rnd, 10, 22), range(rnd, 16, 40), range(rnd, -0.3, 0.3), '#c08068', 0.35, 0.1);
        for (let k = 0; k < 9; k++) blob(g, range(rnd, x0 + 3, x1 - 3), range(rnd, 0.05, 0.95) * s, range(rnd, 2, 7), range(rnd, 1.5, 4), rnd() * 3, '#d4c4a4', 0.6, 0.35);
      } else {
        // old canvas: a few warm stains and cool mildew freckles
        for (let k = 0; k < 4; k++) blob(g, range(rnd, x0 + 6, x1 - 6), range(rnd, 0.05, 0.9) * s, range(rnd, 8, 20), range(rnd, 10, 30), rnd() * 3, pick(rnd, ['#b8a888', '#c4ae86', '#a8a49a']), 0.3, 0.1);
      }
    }
    mottle(g, s, rnd, { colors: ['#b8a68a', '#8a6a58', '#c8b898'], count: 18, rmin: 18, rmax: 50, alpha: 0.12, hard: 0.08 });
    // the hanging folds (the lower two thirds hang down the face): long soft troughs, cool and dark, each with
    // a warm lit crest on its left, converging a little toward the top edge
    const folds = [0.07, 0.2, 0.31, 0.45, 0.56, 0.69, 0.83, 0.94].map(f => f + range(rnd, -0.025, 0.025));
    for (const f of folds) {
      const x = f * s, top = range(rnd, 0.2, 0.34) * s, lean = range(rnd, -10, 10), w = range(rnd, 7, 11), ph = rnd() * 6;
      // a soft brush dragged down the fold: overlapping feathered dabs, the trough widening toward the hem
      for (let t = 0; t <= 1.0001; t += 0.03) {
        const xx = x + lean * (1 - t) + Math.sin(t * 3 + ph) * 3, yy = lerp(top, s, t), k = smooth01(t / 0.25), ww = w * (0.6 + 0.6 * t);
        blob(g, xx + ww * 0.25, yy, ww, s * 0.04, 0, '#3a2c48', 0.1 * k, 0.05);
        blob(g, xx - ww * 0.95, yy, ww * 0.5, s * 0.035, 0, '#fff4dc', 0.1 * k, 0.05);
      }
    }
    // loose folds on the part lying on the top: a few short soft diagonal creases
    for (const [x0, y0, x1, y1] of [[s * 0.12, s * 0.04, s * 0.3, s * 0.24], [s * 0.6, s * 0.02, s * 0.44, s * 0.2], [s * 0.82, s * 0.06, s * 0.92, s * 0.26]]) {
      const pts = []; for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([lerp(x0, x1, t) + Math.sin(t * 5) * 3, lerp(y0, y1, t)]); }
      for (const [u, v] of pts) { blob(g, u + 4, v + 5, 9, 6, 0.6, '#3a2c48', 0.1, 0.05); blob(g, u - 2, v - 2, 6, 4, 0.6, '#fff4dc', 0.1, 0.05); }
    }
    // light falls on the top that lies flat; the hanging part darkens and cools toward the hem
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#fff0c8', 0.18], [0.3, '#fff0c8', 0], [0.55, '#2c2340', 0], [1, '#2c2340', 0.32]]); g.fillRect(0, 0, s, s);
    // rain grime running down from the top, and mud splashed up the hem
    streaks(g, s, rnd, { colors: ['#6a5a48', '#5a4a40'], count: 18, len: [30, 110], width: [3, 7], angle: Math.PI / 2, wobble: 0.1, alpha: 0.07 });
    for (let k = 0; k < 14; k++) blob(g, rnd() * s, range(rnd, 0.72, 1) * s, range(rnd, 8, 24), range(rnd, 5, 14), rnd() * 3, pick(rnd, ['#7a6448', '#6a5440']), 0.22, 0.15);
    // seams: a dark welt, a lit lip on its left, the stitching
    for (let i = 1; i < 6; i++) {
      const x = seams[i];
      g.fillStyle = grad(g, x - 5, 0, x + 5, 0, [[0, '#fff0d0', 0], [0.35, '#fff0d0', 0.22], [0.5, '#3a2c2c', 0.5], [0.75, '#3a2c2c', 0.12], [1, '#3a2c2c', 0]]); g.fillRect(x - 5, 0, 10, s);
      g.save(); g.setLineDash([4, 4]); line(g, [[x - 3, 0], [x - 3, s]], 1.1, '#efe2c4', 0.5); line(g, [[x + 3, 2], [x + 3, s]], 1.1, '#efe2c4', 0.4); g.restore();
    }
    // gathered top edge: a reinforced hem with puckers where the rigging pulled it
    g.fillStyle = grad(g, 0, 0, 0, 16, [[0, '#5a4636', 0.7], [0.5, '#7a604a', 0.35], [1, '#7a604a', 0]]); g.fillRect(0, 0, s, 16);
    for (let x = 10; x < s; x += range(rnd, 18, 34)) { stroke(g, [[x, 2], [x + range(rnd, -5, 5), range(rnd, 12, 24)]], 4, 0.6, '#4a3a30', 0.22); stroke(g, [[x + 3, 2], [x + 3 + range(rnd, -4, 4), range(rnd, 8, 18)]], 2, 0.4, '#fff0d0', 0.22); }
    // a tan canvas repair patch, stitched on crooked across a red stripe
    {
      const x = seams[3] - 20, y = s * 0.2, w = 44, hh = 32, rot = 0.12;
      g.save(); g.translate(x, y); g.rotate(rot);
      g.fillStyle = rgba(INK, 0.3); g.fillRect(3, 4, w, hh);
      g.fillStyle = grad(g, 0, 0, w, hh, [[0, '#c8aa7a'], [1, '#94784e']]); g.fillRect(0, 0, w, hh);
      for (let k = 0; k < 6; k++) blob(g, rnd() * w, rnd() * hh, range(rnd, 4, 10), range(rnd, 3, 7), rnd() * 3, '#7a6040', 0.25, 0.2);
      g.setLineDash([3, 3]); g.strokeStyle = rgba('#4a3420', 0.7); g.lineWidth = 1.2; g.strokeRect(3, 3, w - 6, hh - 6);
      g.restore();
    }
    // the scorch: a brown-black bloom with a singed warm rim, low on the right
    {
      const x = s * 0.78, y = s * 0.42, r = 34;
      blob(g, x, y - 4, r * 1.6, r * 1.3, 0.4, '#a0703e', 0.35, 0.1);
      blob(g, x, y, r * 1.1, r * 0.95, 0.4, '#3a2a24', 0.6, 0.12);
      blob(g, x + 4, y + 2, r * 0.6, r * 0.5, 0, '#221a1c', 0.6, 0.2);
      for (let i = 0; i < 4; i++) blob(g, x + range(rnd, -16, 16), y - r * range(rnd, 1.1, 1.6), range(rnd, 6, 10), range(rnd, 12, 20), range(rnd, -0.3, 0.3), '#3a2c28', 0.16, 0.1);
    }
    g.restore();
    // the edges of the tear darken and curl: a dark rim with a lit lip just inside it
    g.save(); polyPath(g, out); g.clip();
    g.lineJoin = 'round';
    polyPath(g, out); g.strokeStyle = rgba('#3a2c28', 0.7); g.lineWidth = 5; g.stroke();
    polyPath(g, out.map(([x, y]) => [x + (x < s / 2 ? 2 : -2), y - 2])); g.strokeStyle = rgba('#f4e6c8', 0.4); g.lineWidth = 2; g.stroke();
    g.restore();
    // holes: ragged, with a lit curled lip and a dark scorched ring round them
    const holes = [[s * 0.8, s * 0.45, 9], [s * 0.22, s * 0.42, 7], [s * 0.5, s * 0.78, 6], [s * 0.66, s * 0.08, 5]];
    for (const [x, y, r] of holes) {
      const pts = []; for (let k = 0; k < 11; k++) { const a = k / 11 * TAU, rr = r * range(rnd, 0.55, 1.2); pts.push([x + Math.cos(a) * rr * 1.2, y + Math.sin(a) * rr]); }
      g.save(); polyPath(g, pts.map(([u, v]) => [x + (u - x) * 1.5, y + (v - y) * 1.5])); g.fillStyle = rgba('#2e2420', 0.45); g.fill(); g.restore();
      g.save(); polyPath(g, pts.map(([u, v]) => [x + (u - x) * 1.25 - 1, y + (v - y) * 1.25 - 1])); g.strokeStyle = rgba('#f4e6c8', 0.6); g.lineWidth = 1.6; g.stroke(); g.restore();
      g.save(); g.globalCompositeOperation = 'destination-out'; polyPath(g, pts); g.fillStyle = '#000'; g.fill(); g.restore();
    }
    // frayed threads hanging off the tongues
    for (let i = 0; i < 18; i++) {
      const k = Math.floor(rnd() * (out.length - 2)) + 2, [x, y] = out[k];
      if (y < body) continue;
      line(g, [[x, y], [x + range(rnd, -3, 3), y + range(rnd, 4, 9)]], 1.4, '#8a7a64', 1);
    }
    glaze(g, s, s, '#ffe0b8', 0.08, 'soft-light');
    blurTile(cv, 0.45);
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
  family: F, size: 256, note: 'scrap-heap soil between the plates (world-planar, 1 m): dark oily earth, bent rusty strips with curled lit edges, nuts and bolts, rust bleeding into the dirt',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a4634');
    mottle(g, s, rnd, { colors: ['#66503a', '#463830', '#6e5840', '#54484a'], count: 22, rmin: 24, rmax: 60, alpha: 0.5, hard: 0.08 });
    mottle(g, s, rnd, { colors: ['#7a4626', '#8a5030', '#6a3e24'], count: 12, rmin: 10, rmax: 28, alpha: 0.32, hard: 0.15 });
    pebbles(g, s, rnd, { colors: ['#5e5046', '#6e5e4e', '#4e443c'], count: 34, rmin: 1.5, rmax: 4 });
    // bent strips and offcuts: a shadow under each, the body, a thin lit line along the upper edge
    for (let i = 0; i < 12; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 16, 34), a = rnd() * TAU, bend = range(rnd, -0.5, 0.5), w = range(rnd, 6, 12);
      const c = pick(rnd, ['#8a5634', '#7a4a2e', '#6a6670', '#9a6a3a', '#94392a', '#3e6a72', '#a8843a']);
      const pts = []; for (let k = 0; k <= 8; k++) { const t = k / 8, aa = a + bend * t; pts.push([x + Math.cos(aa) * L * t, y + Math.sin(aa) * L * t]); }
      wrap(s, x, y, L + w + 4, (X, Y) => {
        const q = pts.map(([u, v]) => [u - x + X, v - y + Y]);
        stroke(g, q.map(([u, v]) => [u + 1.6, v + 2.2]), w + 1.5, w * 0.8, '#140e0c', 0.5);
        stroke(g, q, w, w * 0.75, c, 0.95);
        stroke(g, q.map(([u, v]) => [u, v - w * 0.38]), Math.max(1, w * 0.3), 0.8, lightOf(c, 0.6), 0.7);
        if (rnd() < 0.5) stroke(g, q.slice(2, 6), w * 0.5, w * 0.3, '#8a4a26', 0.6);
      });
    }
    // nuts and bolts
    for (let i = 0; i < 16; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 2.2, 4), a0 = rnd();
      wrap(s, x, y, r * 2, (X, Y) => {
        const hx = []; for (let k = 0; k < 6; k++) { const a = a0 + k / 6 * TAU; hx.push([X + Math.cos(a) * r, Y + Math.sin(a) * r]); }
        polyPath(g, hx.map(([u, v]) => [u + 1, v + 1.4])); g.fillStyle = rgba('#140e0c', 0.5); g.fill();
        polyPath(g, hx); g.fillStyle = grad(g, X - r, Y - r, X + r, Y + r, [[0, '#a8a29a'], [0.5, '#6a6670'], [1, '#3e3a40']]); g.fill();
        ellipse(g, X, Y, r * 0.4, r * 0.4, 0, '#2e2a30', 0.9);
      });
    }
    glaze(g, s, s, '#ffd8b0', 0.08, 'soft-light');
    blurTile(cv, 0.5);
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
  family: F, size: 256, note: 'painted plaster roadside dino (u along the body, one tile per 6 m; v: 0 belly .. 1 back): darker teal spine band, teal back, olive flank, big irregular plates lit along their upper rims (bigger on the back), a scalloped painted edge onto the ochre belly, soft belly folds, peeled paint over pink plaster, a crack web',
  paint(g, s, rnd, h, cv) {
    // canvas top = the back (v 1), bottom = the belly (v 0)
    g.fillStyle = grad(g, 0, 0, 0, s, [[0, '#3c5646'], [0.08, '#46685a'], [0.3, '#4e7562'], [0.44, '#66784c'], [0.6, '#7a8250'], [0.68, '#c4a468'], [1, '#d6bc86']]);
    g.fillRect(0, 0, s, s);
    mottle(g, s, rnd, { colors: ['#557c64', '#62784a', '#4a6a56', '#6e8456'], count: 14, rmin: 26, rmax: 60, alpha: 0.2, hard: 0.08 });
    // plates in rows, irregular sizes: big over the back, smaller down the flank, fading out toward the belly
    const rows = [[0.13, 56, 72, 1, 4], [0.29, 44, 58, 0.85, 5], [0.44, 32, 44, 0.65, 6], [0.56, 24, 32, 0.4, 7]];
    for (const [yr, wmin, wmax, k, nper] of rows) {
      // nper plates round the tile with a varying gap between them
      let x = rnd() * s; const x1 = x + s, step = s / nper;
      while (x < x1 - step * 0.5) {
        const w = range(rnd, wmin, wmax), hh = w * range(rnd, 0.5, 0.7), cx = x + w / 2, cy = yr * s + range(rnd, -7, 7), ps = Math.floor(rnd() * 1e9);
        const base = mix(yr < 0.35 ? '#4e7562' : '#6e7a4a', yr < 0.35 ? '#5a806a' : '#7e8a56', rnd());
        wrapX(s, cx, w, X => {
          const pr = rngFrom(ps), pts = [];
          for (let q = 0; q < 10; q++) { const a = q / 10 * TAU, rr = range(pr, 0.82, 1.08); pts.push([X + Math.cos(a) * w * 0.5 * rr, cy + Math.sin(a) * hh * 0.5 * rr]); }
          polyPath(g, pts.map(([u, v]) => [u + 3, v + 4])); g.fillStyle = rgba('#2e4038', 0.4 * k); g.fill();
          g.save(); polyPath(g, pts); g.globalAlpha = 0.6 * k;
          g.fillStyle = grad(g, 0, cy - hh / 2, 0, cy + hh / 2, [[0, lightOf(base, 0.25)], [0.45, base], [1, shadowOf(base, 0.25)]]); g.fill(); g.restore();
          // the lit upper rim, brushed over the top-left two fifths of the outline
          const rim = pts.slice(5, 9).map(([u, v]) => [u, v + 1.2]);
          stroke(g, rim, 3.2 * k, 1, '#b8c890', 0.7 * k);
          if (pr() < 0.5) stroke(g, pts.slice(1, 4).map(([u, v]) => [u, v - 1]), 2, 0.6, '#2e4038', 0.35 * k);
        });
        x += step * range(rnd, 0.85, 1.15);
      }
    }
    // the darker spine band over it all
    g.fillStyle = grad(g, 0, 0, 0, s * 0.12, [[0, '#3c5646', 0.85], [0.6, '#3c5646', 0.5], [1, '#3c5646', 0]]); g.fillRect(0, 0, s, s * 0.12);
    // belly: the ochre paint rises into the flank in a scalloped edge, a shadow line above it, a lit lip below
    {
      const yb = s * 0.66, n = 9, W = s / n, sc = [];
      for (let i = 0; i <= n; i++) sc.push(range(rnd, 0.8, 1.2));
      sc[n] = sc[0];
      const edge = [];
      for (let i = 0; i < n; i++) for (let q = 0; q <= 8; q++) { const t = q / 8, x = (i + t) * W, d = Math.sin(Math.PI * t) * 9 * sc[i]; edge.push([x, yb - d + Math.sin(x * 0.3) * 0.8]); }
      const poly = [...edge, [s, s + 2], [0, s + 2]];
      polyPath(g, poly.map(([u, v]) => [u, v - 3])); g.fillStyle = rgba('#2e4038', 0.3); g.fill();
      polyPath(g, poly); g.fillStyle = grad(g, 0, yb - 12, 0, s, [[0, '#d2b47a'], [0.2, '#c8a86a'], [1, '#dcc290']]); g.fill();
      line(g, edge.map(([u, v]) => [u, v + 2]), 2.2, '#f0dca8', 0.55);
      // soft folds down the belly: short, curving, unevenly spaced, lit on one side
      for (let i = 0; i < 11; i++) {
        const x = rnd() * s, y0 = yb + range(rnd, 6, 30), L = range(rnd, 30, 70), bend = range(rnd, -8, 8);
        const pts = []; for (let q = 0; q <= 6; q++) { const t = q / 6; pts.push([x + bend * Math.sin(t * Math.PI), y0 + L * t]); }
        wrapX(s, x, 14, X => { const P = pts.map(([u, v]) => [u - x + X, v]); stroke(g, P, range(rnd, 4, 7), 1.5, '#9a7e4e', 0.28); stroke(g, P.map(([u, v]) => [u - 3, v]), 2, 0.8, '#f0dcae', 0.3); });
      }
    }
    mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c'], count: 6, rmin: 8, rmax: 18, alpha: 0.2, hard: 0.2 });
    // peeled paint over pinkish plaster: a dark lower rim, a lit upper lip
    for (let i = 0; i < 3; i++) {
      const x = rnd() * s, y = range(rnd, 0.15, 0.6) * s, r = range(rnd, 9, 15), ps = Math.floor(rnd() * 1e9);
      wrapX(s, x, r * 2, X => {
        const pr = rngFrom(ps), pts = [];
        for (let q = 0; q < 9; q++) { const a = q / 9 * TAU; pts.push([X + Math.cos(a) * r * range(pr, 0.5, 1.2), y + Math.sin(a) * r * 0.7 * range(pr, 0.5, 1.2)]); }
        polyPath(g, pts); g.fillStyle = '#d8c8b4'; g.fill();
        line(g, pts.slice(1, 5).map(([u, v]) => [u, v + 1]), 2.2, '#5a5048', 0.55);
        line(g, pts.slice(5, 9).map(([u, v]) => [u, v - 1]), 1.8, '#e8f0c8', 0.6);
      });
    }
    // a crack web (one spot near the middle of the tile: on the neck it lands near the break)
    {
      const cx = s * 0.55, cy = s * 0.42;
      for (let k = 0; k < 6; k++) {
        const a = k / 6 * TAU + rnd() * 0.5, pts = [[cx, cy]]; let px = cx, py = cy, aa = a;
        for (let q = 0; q < 5; q++) { aa += (rnd() - 0.5) * 0.8; px += Math.cos(aa) * range(rnd, 5, 10); py += Math.sin(aa) * range(rnd, 4, 8); pts.push([px, py]); }
        stroke(g, pts.map(([u, v]) => [u + 0.8, v + 0.8]), 1.8, 0.5, '#e8f0c8', 0.25);
        stroke(g, pts, 1.5, 0.3, '#2e3430', 0.6);
      }
    }
    cracks(g, s, rnd, { color: '#2e3430', count: 3, len: [14, 34], width: [0.7, 1.2], alpha: 0.3 });
    streaks(g, s, rnd, { colors: ['#3a4a3a', '#6a6044'], count: 10, len: [24, 70], width: [1, 2.2], angle: Math.PI, wobble: 0.08, alpha: 0.1 });
    glaze(g, s, s, '#ffe8b8', 0.1, 'soft-light');
    blurTile(cv, 0.7);
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
  family: F, size: 256, note: 'gray boulder (tiles both ways): a few big flat facets, warm lit tops, cool blue-gray sides, soft dark crevices, moss only on the lit faces',
  paint(g, s, rnd, h, cv) {
    const { pid, dist, nx, ny } = panelField(s, rnd, { cells: 3, jit: 0.9, merge: 0.15 });
    const tones = ['#a29a8a', '#7a808a', '#6c7480', '#8a8682', '#9a9486'];
    const tone = new Map(), lit = new Map();
    const img = g.getImageData(0, 0, s, s), D = img.data;
    for (let k = 0; k < s * s; k++) {
      let c = tone.get(pid[k]);
      if (!c) { const t = pick(rnd, tones); lit.set(pid[k], t === '#a29a8a' || t === '#9a9486'); c = hex(jitter(t, rnd, 0.04)); tone.set(pid[k], c); }
      const x = k % s, y = (k / s) | 0, e = dist[k];
      // each facet: a soft gradient across it (lit upper left), a lit bevel on the edge facing the light, crevices
      const gr = 1.06 - 0.12 * ((x + y) % s) / s;
      const facing = -(nx[k] * -0.707 + ny[k] * -0.707), bv = Math.max(0, 1 - e / 6);
      let m = gr * (1 + 0.22 * bv * -facing);
      let r = c.r * m, gg = c.g * m, b = c.b * m;
      if (e < 1.8) { const t = (1 - e / 1.8) * 0.75; r = r * (1 - t) + 0x3e * t; gg = gg * (1 - t) + 0x3a * t; b = b * (1 - t) + 0x40 * t; }
      D[k * 4] = r; D[k * 4 + 1] = gg; D[k * 4 + 2] = b; D[k * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    blurTile(cv, 1.4);
    mottle(g, s, rnd, { colors: ['#b4ac9c', '#7a808a', '#646a74', '#8e8a84'], count: 34, rmin: 14, rmax: 44, alpha: 0.24, hard: 0.1 });
    for (let i = 0; i < 14; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 16, 40);
      wrap(s, x, y, r * 1.4, (X, Y) => { blob(g, X - r * 0.25, Y - r * 0.3, r, r * 0.6, rnd() * 3, '#c4beb0', 0.2, 0.2); blob(g, X + r * 0.35, Y + r * 0.4, r * 0.8, r * 0.5, rnd() * 3, '#4e4c58', 0.2, 0.2); });
    }
    // moss on the lit facets only
    for (let i = 0; i < 40; i++) {
      const x = rnd() * s, y = rnd() * s, k = (Math.floor(y) * s + Math.floor(x));
      if (!lit.get(pid[k]) || dist[k] < 6) continue;
      const r = range(rnd, 5, 14);
      wrap(s, x, y, r * 1.3, (X, Y) => { blob(g, X, Y, r, r * 0.7, rnd() * 3, pick(rnd, ['#6d7a4a', '#7e8a52', '#5d6b3c']), 0.55, 0.35); blob(g, X - r * 0.3, Y - r * 0.3, r * 0.5, r * 0.35, 0, '#9aa868', 0.4, 0.4); });
    }
    cracks(g, s, rnd, { color: '#3e3a40', count: 4, len: [16, 40], width: [0.8, 1.6], alpha: 0.45 });
    glaze(g, s, s, '#ffe2b0', 0.07, 'soft-light');
    blurTile(cv, 0.7);
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
    // a lit cream bevel round the board (upper left), shaded lower right
    g.fillStyle = rgba('#f2e2b8', 0.75); g.fillRect(0, 0, w, 4); g.fillRect(0, 0, 4, h);
    g.fillStyle = rgba('#f2e2b8', 0.3); g.fillRect(4, 4, w - 8, 2);
    g.fillStyle = rgba('#2a1a1c', 0.6); g.fillRect(0, h - 4, w, 4); g.fillRect(w - 4, 0, 4, h);
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
    g.fillStyle = radial(g, c - 10, c - 10, 4, c, [[0, '#b0905e'], [0.75, '#9a7a52'], [1, '#7a5c3c']]);
    g.beginPath(); g.arc(c, c, c * 0.86, 0, TAU); g.fill();
    g.fillStyle = grad(g, 0, c * 0.6, 0, s, [[0, '#4a4458', 0], [1, '#4a4458', 0.45]]); g.beginPath(); g.arc(c, c, c * 0.86, 0, TAU); g.fill();
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
    g.lineWidth = c * 0.16; g.strokeStyle = '#5a3e28'; g.beginPath(); g.arc(c, c, c * 0.92, 0, TAU); g.stroke();
    g.lineWidth = 2; g.strokeStyle = rgba('#8a6a50', 0.6); g.beginPath(); g.arc(c, c, c * 0.95, Math.PI, Math.PI * 1.6); g.stroke();
    blob(g, c - 14, c - 16, 22, 14, -0.6, '#e8cc98', 0.18, 0.2);
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
  family: F, w: 512, h: 64, note: 'gas canopy fascia board (u along, 4 m; v fitted): red paint, cream pinstripes, brass trim line and rivets, hand-painted diamonds unevenly spaced, two lost, one hung crooked',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#b8543e'], [0.3, '#9a3e2e'], [1, '#6a2a22']]); g.fillRect(0, 0, w, h);
    mottle(g, w, rnd, { colors: ['#b24a36', '#7e3024'], count: 14, rmin: 8, rmax: 22, alpha: 0.3 });
    g.fillStyle = grad(g, 0, h - 9, 0, h, [[0, '#f0d890'], [0.5, '#b08a3c'], [1, '#5a4018']]); g.fillRect(0, h - 9, w, 9);
    for (const y of [9, h - 15]) line(g, wobbly([[0, y], [w, y]], rnd, 0.6, 24), 2.5, '#e8d8b0', 0.85, 'butt');
    const n = 8, missing = new Set([2, 6]), crooked = 4;
    for (let i = 0; i < n; i++) {
      const x = (i + 0.5) * w / n + range(rnd, -0.2, 0.2) * w / n, cy = h / 2 - 3 + range(rnd, -1.5, 1.5), sc = range(rnd, 0.88, 1.1);
      if (missing.has(i)) {
        // a paler ghost where it hung, two nail holes
        g.save(); g.globalAlpha = 0.35; polyPath(g, [[x, cy - 11 * sc], [x + 14 * sc, cy], [x, cy + 11 * sc], [x - 14 * sc, cy]]); g.fillStyle = '#c86a50'; g.fill(); g.restore();
        ellipse(g, x, cy - 7, 1.4, 1.4, 0, INK, 0.8); ellipse(g, x, cy + 7, 1.4, 1.4, 0, INK, 0.8);
      } else {
        g.save(); g.translate(x, cy); g.rotate(i === crooked ? 0.32 : range(rnd, -0.05, 0.05)); g.scale(sc, sc);
        polyPath(g, [[2, -12], [16, 2], [2, 14], [-12, 2]]); g.fillStyle = rgba(INK, 0.35); g.fill();
        polyPath(g, [[0, -14], [14, 0], [0, 12], [-14, 0]]); g.fillStyle = '#e8d8b0'; g.fill();
        polyPath(g, [[0, -8], [7, 0], [0, 6], [-7, 0]]); g.fillStyle = '#c8963a'; g.fill();
        line(g, [[-12, -1], [0, -13], [12, -1]], 1.5, '#fff4d8', 0.6);
        g.restore();
        nail(g, x, cy - (i === crooked ? 3 : 8), 1.6);
      }
      rivet(g, (i + 1) * w / n + range(rnd, -6, 6), h - 4.5, 3, '#c8a050');
    }
    for (let i = 0; i < 9; i++) chip(g, w, rnd() * w, range(rnd, 12, h - 18), range(rnd, 2, 4), '#5a3a2a', rnd);
    for (let i = 0; i < 4; i++) rustRun(g, w, rnd() * w, h - 10, range(rnd, 4, 9), 1.6, 0.3, rnd, h);
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#fff0c8', 0.25], [0.15, '#fff0c8', 0], [0.8, INK, 0], [1, INK, 0.3]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.4);
  },
});
register('rs_gasboard', {
  family: F, w: 512, h: 128, note: 'the gas stop roof board (fitted): GAS · FOOD · REGRET in sign-painter cream on red planks, brass corners, a painted border',
  paint(g, w, rnd, h) {
    fill(g, w, h, '#2a1c1e');
    for (let i = 0; i < 3; i++) plank(g, 0, i * h / 3 + 1, w, h / 3 - 2, jitter('#9a3a2c', rnd, 0.05), rnd, { grain: 8, bevel: 3, light: 0.45 });
    g.lineWidth = 4; g.strokeStyle = rgba('#e8d8b0', 0.85); g.strokeRect(12, 12, w - 24, h - 24);
    g.lineWidth = 1.5; g.strokeStyle = rgba('#c8a050', 0.8); g.strokeRect(18, 18, w - 36, h - 36);
    g.save(); g.font = SERIF(54); g.textAlign = 'center'; g.textBaseline = 'middle';
    const txt = 'GAS · FOOD · REGRET', m = g.measureText(txt).width, k = Math.min(1, (w - 70) / m);
    g.translate(w / 2, h / 2 + 3); g.scale(k, 1);
    g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = '#2a1c1e'; g.strokeText(txt, 2, 2.5);
    g.fillStyle = '#f0e0b4'; g.fillText(txt, 0, 0);
    g.restore();
    for (let i = 0; i < 8; i++) chip(g, w, rnd() * w, range(rnd, 20, h - 20), range(rnd, 2.5, 5), '#7a5634', rnd);
    for (const [x, y, dx, dy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
      g.fillStyle = '#b08a3c'; g.fillRect(Math.min(x, x + dx * 30), Math.min(y, y + dy * 10), 30, 10); g.fillRect(Math.min(x, x + dx * 10), Math.min(y, y + dy * 30), 10, 30);
      rivet(g, x + dx * 6, y + dy * 6, 3.2, '#c8a050');
    }
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#fff0c8', 0.22], [0.15, '#fff0c8', 0], [0.75, INK, 0], [1, INK, 0.35]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.35);
  },
});
// The junk yard's board on its derrick: SALVAGE hand-lettered in white-lead on weathered gray boards with a
// painted cog, a smaller TAKE WHAT YOU CAN CARRY under it, nailed-on iron corners.
register('rs_junkboard', {
  family: F, w: 512, h: 160, note: 'the junk yard derrick board (fitted): SALVAGE on gray boards, a painted cog, TAKE WHAT YOU CAN CARRY, iron corners',
  paint(g, w, rnd, h) {
    fill(g, w, h, '#221a1c');
    for (let i = 0; i < 4; i++) plank(g, range(rnd, -6, 0), i * h / 4 + 1, w + 8, h / 4 - 2, jitter(pick(rnd, ['#7a746a', '#6e685e', '#847c70']), rnd, 0.05), rnd, { grain: 8, bevel: 3, light: 0.45 });
    // a painted cog at the left, rust red with a cream rim
    const cx = 70, cy = h / 2, R = 46;
    g.save(); g.translate(cx, cy);
    g.beginPath();
    for (let k = 0; k < 20; k++) { const a = k / 20 * TAU, r = k % 2 ? R : R * 0.8; g.lineTo(Math.cos(a - 0.12) * r, Math.sin(a - 0.12) * r); g.lineTo(Math.cos(a + 0.12) * r, Math.sin(a + 0.12) * r); }
    g.closePath(); g.fillStyle = rgba('#2a1c1e', 0.6); g.translate(3, 4); g.fill(); g.translate(-3, -4);
    g.fillStyle = '#a4432c'; g.fill(); g.lineWidth = 3; g.strokeStyle = rgba('#e8d8b0', 0.85); g.stroke();
    g.beginPath(); g.arc(0, 0, R * 0.32, 0, TAU); g.fillStyle = '#4a4040'; g.fill(); g.strokeStyle = rgba('#e8d8b0', 0.8); g.stroke();
    g.restore();
    g.save(); g.font = SERIF(64); g.textAlign = 'center'; g.textBaseline = 'middle';
    const t1 = 'SALVAGE', m1 = g.measureText(t1).width, k1 = Math.min(1, (w - 190) / m1);
    g.translate(w / 2 + 52, h * 0.4); g.scale(k1, 1); g.rotate(-0.015);
    g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = '#2a1c1e'; g.strokeText(t1, 2, 3);
    g.fillStyle = '#efe4c8'; g.fillText(t1, 0, 0);
    g.restore();
    letters(g, 'TAKE WHAT YOU CAN CARRY', w / 2 + 52, h * 0.78, { font: FONT(27), color: '#2a2030', alpha: 0.9, worn: 0.25, rnd, maxW: w - 190, under: '#7a746a' });
    for (let i = 0; i < 10; i++) chip(g, w, rnd() * w, range(rnd, 16, h - 16), range(rnd, 2.5, 5), '#4e463e', rnd);
    for (let i = 0; i < 5; i++) rustRun(g, w, range(rnd, 20, w - 20), range(rnd, 6, 30), range(rnd, 30, 80), range(rnd, 2, 4), 0.4, rnd, h);
    for (const [x, y, dx, dy] of [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]]) {
      g.fillStyle = '#4a4448'; g.fillRect(Math.min(x, x + dx * 34), Math.min(y, y + dy * 11), 34, 11); g.fillRect(Math.min(x, x + dx * 11), Math.min(y, y + dy * 34), 11, 34);
      rivet(g, x + dx * 6, y + dy * 6, 3.2, '#8a8478');
    }
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#fff0c8', 0.2], [0.15, '#fff0c8', 0], [0.75, INK, 0], [1, INK, 0.35]]); g.fillRect(0, 0, w, h);
    blurTile(g.canvas, 0.35);
  },
});
// The YARD SALE bunting: eight hand-painted pennants side by side (alpha), one letter each, in faded
// alternating colours. Picked one at a time with a uv rect.
register('rs_bunting', {
  family: F, w: 512, h: 64, alpha: true, note: 'YARD SALE bunting (alpha; eight pennants side by side, fitted one each by uv rect): faded red, cream, blue and mustard cloth, a painted letter on each, frayed tips',
  paint(g, w, rnd, h) {
    const L = 'YARDSALE', cols = ['#a8463a', '#e2d2aa', '#4a6a8a', '#c8963a'], W = w / 8;
    for (let i = 0; i < 8; i++) {
      const x0 = i * W, c = cols[i % 4], ink = c === '#e2d2aa' || c === '#c8963a' ? '#5a2a24' : '#efe2c0';
      const tip = [x0 + W / 2 + range(rnd, -3, 3), h - 3];
      const pts = wobbly([[x0 + 3, 4], [x0 + W - 3, 4], tip, [x0 + 3, 4]], rnd, 1, 4);
      polyPath(g, pts); g.fillStyle = grad(g, x0, 0, x0 + W, h, [[0, lightOf(c, 0.25)], [0.5, c], [1, shadowOf(c, 0.3)]]); g.fill();
      g.save(); polyPath(g, pts); g.clip();
      for (let k = 0; k < 3; k++) line(g, [[x0 + range(rnd, 8, W - 8), 6], [x0 + W / 2 + range(rnd, -6, 6), h - 10]], 1.5, shadowOf(c, 0.3), 0.35);
      g.restore();
      g.fillStyle = rgba('#3a2a24', 0.8); g.fillRect(x0 + 1, 2, W - 2, 5);
      g.save(); g.font = SERIF(28); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = ink; g.fillText(L[i], x0 + W / 2, 24); g.restore();
    }
  },
});
function tuft(g, s, rnd, cols) {
  for (let i = 0; i < 26; i++) {
    const x = s / 2 + range(rnd, -s * 0.22, s * 0.22), a = range(rnd, -0.7, 0.7) + (x - s / 2) / s * 1.2, len = range(rnd, 0.45, 0.95) * s * 0.85, c = pick(rnd, cols);
    blade(g, x, s - 2, len, a, range(rnd, 4, 7), c, 1, range(rnd, -0.5, 0.5));
    if (rnd() < 0.5) blade(g, x - 1, s - 2, len * 0.95, a, range(rnd, 1.5, 2.5), lightOf(c, 0.5), 0.6, 0.2);
  }
  g.globalCompositeOperation = 'source-atop';
  g.fillStyle = grad(g, 0, s * 0.5, 0, s, [[0, '#2c2340', 0], [1, '#2c2340', 0.45]]); g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'source-over';
}
register('rs_tuft', { family: F, size: 128, alpha: true, note: 'a grass tuft card (alpha): lush painted blades, lit tips, cool roots', paint(g, s, rnd) { tuft(g, s, rnd, ['#5e8a34', '#6e9a3a', '#4e7a2e', '#7aa842', '#8ab04a']); } });
register('rs_tuft_dry', { family: F, size: 128, alpha: true, note: 'a dry golden grass tuft card (Westfall)', paint(g, s, rnd) { tuft(g, s, rnd, ['#a89040', '#c8a850', '#8a8a3a', '#d8b860', '#7a7a34']); } });
register('rs_scorch', {
  family: F, size: 256, alpha: true, note: 'a scorch and soot decal (alpha) for the crash furrow: sooty core, ash flecks, a ragged fading edge',
  paint(g, s, rnd) {
    const c = s / 2;
    for (let i = 0; i < 14; i++) { const a = rnd() * TAU, d = range(rnd, 0, s * 0.22); blob(g, c + Math.cos(a) * d, c + Math.sin(a) * d * 1.4, range(rnd, s * 0.14, s * 0.26), range(rnd, s * 0.1, s * 0.2), rnd() * 3, '#3a2a20', 0.35, 0.2); }
    for (let i = 0; i < 6; i++) { const a = rnd() * TAU, d = range(rnd, 0, s * 0.12); blob(g, c + Math.cos(a) * d, c + Math.sin(a) * d * 1.3, range(rnd, s * 0.06, s * 0.12), range(rnd, s * 0.05, s * 0.1), rnd() * 3, '#1e1618', 0.4, 0.3); }
    for (let i = 0; i < 40; i++) { const a = rnd() * TAU, d = range(rnd, 0, s * 0.3); blob(g, c + Math.cos(a) * d, c + Math.sin(a) * d * 1.4, range(rnd, 2, 5), range(rnd, 1.5, 3), rnd() * 3, pick(rnd, ['#8a8478', '#a89c8a', '#5a4a3c']), 0.6, 0.5); }
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = radial(g, c, c, s * 0.08, s * 0.48, [[0, '#ffffff', 1], [0.6, '#ffffff', 0.8], [1, '#ffffff', 0]]); g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = 'source-over';
  },
});
register('rs_shield', {
  family: F, size: 128, note: 'dwarven shield boss (fitted, circle): iron dish in a brass rim, a hammer-and-anvil boss, big rivets, a lit upper-left rim',
  paint(g, s, rnd) {
    const c = s / 2;
    fill(g, s, s, '#3a3438');
    g.fillStyle = radial(g, c - 16, c - 16, 4, c, [[0, '#f0d890'], [0.6, '#b08a3c'], [1, '#5a4018']]); g.beginPath(); g.arc(c, c, c - 1, 0, TAU); g.fill();
    g.fillStyle = radial(g, c - 14, c - 14, 6, c * 0.82, [[0, '#9a9490'], [0.5, '#6a6670'], [1, '#46424a']]); g.beginPath(); g.arc(c, c, c * 0.8, 0, TAU); g.fill();
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; rivet(g, c + Math.cos(a) * c * 0.9, c + Math.sin(a) * c * 0.9, 3.4, '#c8a050'); }
    // the boss: an anvil with a hammer over it, in brass
    g.save(); g.translate(c, c + 4);
    polyPath(g, [[-24, -6], [22, -6], [30, -12], [30, -4], [12, 2], [10, 14], [18, 20], [-18, 20], [-10, 14], [-12, 2], [-24, 0]].map(([x, y]) => [x + 2, y + 3])); g.fillStyle = rgba(INK, 0.5); g.fill();
    polyPath(g, [[-24, -6], [22, -6], [30, -12], [30, -4], [12, 2], [10, 14], [18, 20], [-18, 20], [-10, 14], [-12, 2], [-24, 0]]); g.fillStyle = grad(g, -24, -12, 24, 20, [[0, '#f2dc98'], [0.5, '#c09a48'], [1, '#6a4e22']]); g.fill();
    g.rotate(-0.5); g.fillStyle = '#7a5a34'; g.fillRect(-3, -40, 6, 30); g.fillStyle = grad(g, -12, -46, 12, -36, [[0, '#d8d2c8'], [1, '#6a6670']]); g.fillRect(-12, -48, 24, 12);
    g.restore();
    blob(g, c - 22, c - 26, 26, 12, -0.6, '#ffffff', 0.18, 0.3);
    for (let i = 0; i < 6; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 3, 8), range(rnd, 2, 5), rnd() * 3, '#7a4a2a', 0.35, 0.4);
    blurTile(g.canvas, 0.4);
  },
});
register('rs_rune', {
  family: F, w: 256, h: 64, note: 'a carved dwarven rune band in granite (fitted: u around the bollard): angular runes cut in, a shadowed upper lip and lit lower lip, lichen',
  paint(g, w, rnd, h) {
    g.fillStyle = grad(g, 0, 0, 0, h, [[0, '#8e96a2'], [0.5, '#7a8290'], [1, '#626a78']]); g.fillRect(0, 0, w, h);
    mottle(g, w, rnd, { colors: ['#a0a8b4', '#6a7280'], count: 10, rmin: 6, rmax: 18, alpha: 0.3 });
    for (const y of [5, h - 7]) { line(g, [[0, y], [w, y]], 3, '#3e4450', 0.8, 'butt'); line(g, [[0, y + 2.5], [w, y + 2.5]], 1.4, '#c4ccd6', 0.5, 'butt'); }
    const glyphs = [[[0, 0], [0, 1], [1, 0.4]], [[0, 1], [0.5, 0], [1, 1], [0.2, 0.6], [0.8, 0.6]], [[0, 0], [1, 1], [1, 0], [0, 1]], [[0.5, 0], [0.5, 1], [0, 0.3], [1, 0.3]], [[0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5]], [[0, 0.5], [0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]];
    for (let i = 0; i < 8; i++) {
      const gl = glyphs[(i * 5 + 1) % glyphs.length], x0 = 8 + i * w / 8, gw = w / 8 - 16, y0 = 14, gh = h - 28;
      const pts = gl.map(([u, v]) => [x0 + u * gw, y0 + v * gh]);
      line(g, pts.map(([u, v]) => [u - 1.2, v - 1.5]), 4.5, '#2e323c', 0.85);
      line(g, pts.map(([u, v]) => [u + 1.2, v + 1.6]), 2.4, '#d0d8e2', 0.55);
      line(g, pts, 2.8, '#4a505c', 0.9);
    }
    mottle(g, w, rnd, { colors: ['#6d7a4a', '#a8a48e'], count: 6, rmin: 3, rmax: 8, alpha: 0.4, hard: 0.4 });
    blurTile(g.canvas, 0.4);
  },
});
// Junked motorhome skins (u along the body, 3 m; v fitted top→bottom): a cream upper body, a painted lower
// body in the RV's own colour behind a belt stripe, a darker skirt band, rivet seams, rust and mud.
// A junked motorhome's side in the SLOPMASTER's own language (v fitted bottom to top, u along the body, 3 m):
// a riveted roof-edge strip, weathered painted steel above (sun-faded toward the top, chipped to primer, rust
// runs from every rivet row), a brass trim strip at the belt, honey planks below with nail heads and dark gaps,
// a muddy iron skirt.
function rvSkin(g, s, rnd, cv, { paint, wood = '#9a7448' }) {
  fill(g, s, s, paint);
  const P0 = s * 0.06, P1 = s * 0.44, BR1 = s * 0.5, PL1 = s * 0.86;
  // the painted steel: sheets between rivet seams, faded and bleached toward the roof
  g.fillStyle = grad(g, 0, P0, 0, P1, [[0, mix(paint, '#e8dcc0', 0.35)], [0.45, mix(paint, '#d8ccb0', 0.12)], [1, shadowOf(paint, 0.12)]]); g.fillRect(0, P0, s, P1 - P0);
  mottle(g, s, rnd, { colors: [lightOf(paint, 0.2), shadowOf(paint, 0.2), mix(paint, '#c8b890', 0.4)], count: 24, rmin: 12, rmax: 40, alpha: 0.3, hard: 0.1 });
  const seams = [0, 0.36, 0.69].map(t => (t + range(rnd, -0.02, 0.02)) * s);
  for (const x of seams) {
    g.fillStyle = grad(g, x - 3, 0, x + 5, 0, [[0, INK, 0.35], [0.5, INK, 0.15], [1, '#fff0d0', 0.18]]); g.fillRect(x - 3, P0, 8, P1 - P0);
    for (let y = P0 + 8; y < P1 - 4; y += 16) { rivet(g, x + 7, y + range(rnd, -1.5, 1.5), 2.2, '#a09888'); if (rnd() < 0.3) rustRun(g, s, x + 7, y + 2, range(rnd, 8, 22), 1.4, 0.32, rnd); }
  }
  for (let i = 0; i < 12; i++) chip(g, s, rnd() * s, range(rnd, P0 + 6, P1 - 6), range(rnd, 2.5, 6.5), '#8a7a68', rnd);
  for (let i = 0; i < 4; i++) dent(g, s, rnd() * s, range(rnd, P0 + 10, P1 - 10), range(rnd, 10, 20), paint, 0.4);
  // the roof-edge strip
  g.fillStyle = grad(g, 0, 0, 0, P0, [[0, '#4a4040'], [0.5, '#6a605a'], [1, '#3a3234']]); g.fillRect(0, 0, s, P0);
  for (let x = 6; x < s; x += 18) rivet(g, x, P0 / 2, 2, '#a09888');
  // planks below the belt: four boards a row, butt joints staggered, nail heads at the joints
  const rows = 4, rh = (PL1 - BR1) / rows;
  g.fillStyle = '#2a2024'; g.fillRect(0, BR1, s, PL1 - BR1);
  for (let r = 0; r < rows; r++) {
    const y = BR1 + r * rh, x0 = range(rnd, 0, s);
    let x = x0;
    // boards laid from a random joint once round the tile; the one crossing the edge is drawn on both sides
    while (x < x0 + s - 20) {
      const L = Math.min(range(rnd, 70, 130), x0 + s - x), c = jitter(wood, rnd, 0.07), seed = Math.floor(rnd() * 1e9);
      for (const dx of [0, -s]) if (x + dx < s && x + dx + L > 0) plank(g, x + dx, y + 0.5, L - 1.5, rh - 2, c, rngFrom(seed), { grain: 6, bevel: 2.5, light: 0.42 });
      const jx = ((x + L - 4) % s + s) % s;
      nail(g, jx, y + rh * 0.3, 1.8); nail(g, jx, y + rh * 0.7, 1.8);
      x += L;
    }
  }
  // the brass belt strip, riveted
  g.fillStyle = grad(g, 0, P1, 0, BR1, [[0, '#f0d890'], [0.35, '#c8a050'], [1, '#6a5028']]); g.fillRect(0, P1, s, BR1 - P1);
  for (let x = 9; x < s; x += 22) rivet(g, x, (P1 + BR1) / 2, 2, '#e0c070');
  line(g, [[0, BR1], [s, BR1]], 2, INK, 0.5, 'butt');
  // the skirt: dark iron, mud thrown up from the wheels
  g.fillStyle = grad(g, 0, PL1, 0, s, [[0, '#3e3634'], [0.3, '#4a4240'], [1, '#2a2426']]); g.fillRect(0, PL1, s, s - PL1);
  for (let x = 8; x < s; x += 20) rivet(g, x, PL1 + 5, 1.8, '#8a8478');
  g.fillStyle = grad(g, 0, s * 0.7, 0, s, [[0, '#5a4a38', 0], [0.6, '#5a4a38', 0.32], [1, '#3a2e24', 0.6]]); g.fillRect(0, 0, s, s);
  streaks(g, s, rnd, { colors: ['#6a5040', '#7a6048'], count: 22, len: [6, 28], width: [1.2, 3], angle: 0, wobble: 0.6, alpha: 0.26 });
  for (let i = 0; i < 6; i++) rustRun(g, s, rnd() * s, P0 + 2, range(rnd, 14, 40), range(rnd, 1.2, 2.2), 0.24, rnd);
  glaze(g, s, s, '#ffe2b8', 0.1, 'soft-light');
  blurTile(cv, 0.5);
}
register('rs_rv_green', { family: F, size: 256, note: 'junked motorhome skin: faded green paint over a brass belt and honey planks, dark skirt', paint(g, s, rnd, h, cv) { rvSkin(g, s, rnd, cv, { paint: '#6a7a4a' }); } });
register('rs_rv_rust', { family: F, size: 256, note: 'junked motorhome skin: rust-red paint over a brass belt and gray planks, dark skirt', paint(g, s, rnd, h, cv) { rvSkin(g, s, rnd, cv, { paint: '#8e3e2c', wood: '#857a6a' }); } });
register('rs_rv_blue', { family: F, size: 256, note: 'junked motorhome skin: faded slate-blue paint over a brass belt and dark planks, dark skirt', paint(g, s, rnd, h, cv) { rvSkin(g, s, rnd, cv, { paint: '#4e6a80', wood: '#7a5a3a' }); } });
// Hand-painted name boards for the three junked motorhomes, stacked (fitted, a uv rect each).
register('rs_rv_names', {
  family: F, w: 256, h: 256, note: 'three hand-painted motorhome name boards stacked (fitted by uv rect): DUSTY BELLE, SLOPMASTER 5000, LAST CHANCE',
  paint(g, w, rnd, h) {
    fill(g, w, h, '#1e1618');
    const boards = [['DUSTY BELLE', '#3e5a34', '#efe2c0'], ['SLOPMASTER 5000', '#7a2e24', '#f0d890'], ['LAST CHANCE', '#2e4458', '#efe2c0']];
    boards.forEach(([txt, bg, fg], k) => {
      const y0 = k * 85 + 2, bh = 81;
      for (let i = 0; i < 2; i++) plank(g, 0, y0 + i * bh / 2, w, bh / 2 - 1, jitter(bg, rnd, 0.05), rnd, { grain: 6, bevel: 2.5, light: 0.45 });
      g.lineWidth = 3; g.strokeStyle = rgba(fg, 0.7); g.strokeRect(7, y0 + 7, w - 14, bh - 14);
      g.save(); g.font = SERIF(34); g.textAlign = 'center'; g.textBaseline = 'middle';
      const m = g.measureText(txt).width, sc = Math.min(1, (w - 34) / m);
      g.translate(w / 2, y0 + bh / 2 + 2); g.scale(sc, 1); g.rotate(range(rnd, -0.02, 0.02));
      g.lineJoin = 'round'; g.lineWidth = 6; g.strokeStyle = '#1e1618'; g.strokeText(txt, 1.5, 2);
      g.fillStyle = fg; g.fillText(txt, 0, 0);
      g.restore();
      for (let i = 0; i < 5; i++) chip(g, w, rnd() * w, range(rnd, y0 + 10, y0 + bh - 10), range(rnd, 2, 4), '#6a5440', rnd);
      for (const x of [10, w - 10]) for (const yy of [y0 + 10, y0 + bh - 10]) nail(g, x, yy, 2.4);
      g.fillStyle = grad(g, 0, y0, 0, y0 + bh, [[0, '#fff0c8', 0.18], [0.2, '#fff0c8', 0], [0.8, INK, 0], [1, INK, 0.35]]); g.fillRect(0, y0, w, bh);
    });
    blurTile(g.canvas, 0.35);
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
  const a = makeCanvas(s);
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
register('rs_glow', {
  family: F, size: 128, alpha: true, note: 'a soft patch of daylight (alpha): pale cream, dust motes, fading out well inside the edge',
  paint(g, s, rnd) {
    const c = s / 2;
    g.fillStyle = radial(g, c, c, 2, c * 0.95, [[0, '#fff6dc', 0.75], [0.5, '#fff0d0', 0.4], [1, '#fff0d0', 0]]); g.fillRect(0, 0, s, s);
    for (let i = 0; i < 18; i++) { const a = rnd() * TAU, d = rnd() * c * 0.6; ellipse(g, c + Math.cos(a) * d, c + Math.sin(a) * d, range(rnd, 0.8, 1.8), range(rnd, 0.8, 1.8), 0, '#ffffff', 0.5); }
  },
});
register('rs_puff', {
  family: F, size: 128, alpha: true, note: 'a cartoon smoke puff billboard (alpha): soft cauliflower blobs lit warm cream at the upper left, cool lavender-gray lower right, alpha fading well inside the edge',
  paint(g, s, rnd) {
    const c = s / 2;
    const mask = makeCanvas(s);
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

function shingles(g, s, rnd, cv, { colors, gapC = '#3a2a24', moss = 0.22, rows = 6 }) {
  fill(g, s, s, gapC);
  const rh = s / rows;
  for (let r = rows - 1; r >= 0; r--) {
    const y = r * rh, ws = rowLayout(s, rngFrom(77 + r), { rows: 1, minW: 26, maxW: 52 }).map(q => [q.x, q.w]);
    for (const [x0, w] of ws) {
      const c = jitter(pick(rnd, colors), rnd, 0.06), sh = range(rnd, -3, 3), ts = Math.floor(rnd() * 1e9);
      wrapRect(s, x0 + 1, y, w - 2, rh + 10, (dx, dy) => {
        const pr = rngFrom(ts);
        const X = x0 + 1 + dx, Y = y + dy, W = w - 2, H = rh + 8 + sh;
        g.fillStyle = grad(g, 0, Y, 0, Y + H, [[0, shadowOf(c, 0.4)], [0.35, c], [0.9, lightOf(c, 0.25)], [1, shadowOf(c, 0.3)]]);
        g.beginPath(); g.roundRect(X, Y, W, H, [0, 0, 4, 4]); g.fill();
        for (let k = 0; k < 3; k++) { const gx = X + range(pr, 0.15, 0.85) * W; line(g, [[gx, Y + 4], [gx + range(pr, -1, 1), Y + H - 3]], 0.8, shadowOf(c, 0.4), 0.4); }
        g.fillStyle = rgba(lightOf(c, 0.5), 0.45); g.fillRect(X, Y + H - 4, W, 2);
        g.fillStyle = rgba(INK, 0.35); g.fillRect(X + W - 2, Y, 2, H);
      });
    }
    g.fillStyle = grad(g, 0, y, 0, y + 10, [[0, INK, 0.5], [1, INK, 0]]); g.fillRect(0, y, s, 10);
  }
  mottle(g, s, rnd, { colors: ['#6d7a4a', '#5d6b3c'], count: 12, rmin: 5, rmax: 16, alpha: moss, hard: 0.3 });
  glaze(g, s, s, '#ffd8b0', 0.1, 'soft-light');
  blurTile(cv, 0.4);
}
register('rs_shingles', {
  family: F, size: 256, note: 'cedar shingles (up the roof = up the texture): rows overlapping with soft shadows, moss in the laps',
  paint(g, s, rnd, h, cv) { shingles(g, s, rnd, cv, { colors: ['#8a5e3a', '#7a5232', '#946640', '#6e4a30'] }); },
});
register('rs_shingles_red', {
  family: F, size: 256, note: 'Elwynn red shingles (up the roof = up the texture): brick-red to rust, faded tips, moss in the laps',
  paint(g, s, rnd, h, cv) { shingles(g, s, rnd, cv, { colors: ['#9a3a2c', '#a8463a', '#8a3428', '#b04e38', '#94402e'], gapC: '#3a2024', moss: 0.18 }); },
});
// Thatch: straw courses laid in rows, each row's ragged lower edge lit gold with a dark under-shadow on the
// row below (up the roof = up the texture). Tiles both ways.
register('rs_thatch', {
  family: F, size: 256, note: 'layered straw thatch (Westfall; up the roof = up the texture): courses with ragged lit tips, dark under-shadow, strands along v',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8a6a34');
    const rows = 4, rh = s / rows;
    for (let r = rows - 1; r >= 0; r--) {
      const y = r * rh;
      // the course: streaky straw running down the roof
      for (const dy of [0, -s, s]) {
        g.save(); g.beginPath(); g.rect(0, y + dy - 6, s, rh + 12); g.clip();
        g.fillStyle = grad(g, 0, y + dy, 0, y + dy + rh, [[0, '#7a5e30'], [0.5, '#a8863e'], [1, '#c8a450']]); g.fillRect(0, y + dy - 6, s, rh + 12);
        g.restore();
      }
      for (let k = 0; k < 120; k++) {
        const x = rnd() * s, y0 = y + range(rnd, -4, rh * 0.6), L = range(rnd, rh * 0.4, rh * 0.9), c = pick(rnd, ['#d8b860', '#e2c56a', '#a8863e', '#8e7032', '#c8a050']);
        for (const dx of [0, -s, s]) for (const dy of [0, -s, s]) { const X = x + dx, Y = y0 + dy; if (X < -4 || X > s + 4 || Y > s + 4 || Y + L < -4) continue; line(g, [[X, Y], [X + range(rnd, -2, 2), Y + L]], range(rnd, 1, 2.2), c, 0.55); }
      }
      // the ragged lower edge: shadow cast on the course below, then lit tips
      const edge = []; for (let x = 0; x <= s; x += 4) edge.push([x, y + rh + range(rnd, -3, 5)]);
      edge[edge.length - 1][1] = edge[0][1];
      for (const dy of [0, -s]) {
        g.fillStyle = grad(g, 0, y + rh + dy, 0, y + rh + dy + 16, [[0, '#4a3418', 0.65], [1, '#4a3418', 0]]); g.fillRect(0, y + rh + dy - 2, s, 18);
        for (const [x, ey] of edge) line(g, [[x, ey + dy - 10], [x + range(rnd, -1.5, 1.5), ey + dy + range(rnd, -1, 3)]], range(rnd, 1.4, 2.6), pick(rnd, ['#e2c56a', '#f0d888', '#c8a450']), 0.9);
        line(g, edge.map(([u, v]) => [u, v + dy + 3]), 1.6, '#6a5030', 0.45);
      }
    }
    mottle(g, s, rnd, { colors: ['#6a5030', '#5a6a3a'], count: 10, rmin: 8, rmax: 20, alpha: 0.18, hard: 0.2 });
    glaze(g, s, s, '#ffe0a0', 0.1, 'soft-light');
    blurTile(cv, 0.5);
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
        // hand-woven: the band's edges wander a couple of pixels
        const top = [], bot = [];
        for (let x = 0; x <= s; x += 16) { top.push([x, Y + range(rnd, -2, 2)]); bot.push([x, Y + h + range(rnd, -2, 2)]); }
        polyPath(g, [...top, ...bot.reverse()]); g.fillStyle = c; g.fill();
        for (let x = 0; x < s; x += 3) line(g, [[x, Y], [x + 1, Y + h]], 0.8, rnd() < 0.5 ? shadowOf(c, 0.3) : lightOf(c, 0.3), 0.18);
      }
    }
    g.save(); g.beginPath();
    for (let x = 0; x <= s; x += 18) g.lineTo(x + range(rnd, -2, 2), s / 2 + (x / 18 % 2 ? -10 : 10) + range(rnd, -3, 3));
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
    // one half bleached by the sun, the colours washed toward the cloth
    g.fillStyle = grad(g, s * 0.35, 0, s * 0.75, 0, [[0, '#efe4c8', 0.42], [1, '#efe4c8', 0]]); g.fillRect(0, 0, s, s);
    // the fold crease across the middle: a shadow under it, a lit ridge over it
    { const y = s * range(rnd, 0.42, 0.5), pts = []; for (let x = 0; x <= s; x += 16) pts.push([x, y + range(rnd, -1.5, 1.5)]);
      g.fillStyle = grad(g, 0, y - 10, 0, y + 12, [[0, INK, 0], [0.45, INK, 0.2], [0.55, '#fff4dc', 0.3], [1, '#fff4dc', 0]]); g.fillRect(0, y - 10, s, 22);
      line(g, pts, 1.4, '#3a2a30', 0.35); }
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

// Two stretched pelts side by side for the Badlands gate (the hide's outline is geometry; this is its face): a
// scraped flesh-side hide in cream-tan painted with a red-ochre sun and dots, and a dark bison hide, fur side out,
// with a white painted zigzag. Both darken toward their curling edges. Lives in the gate label atlas.
register('rs_pelts', {
  family: F, w: 256, h: 128, note: 'two pelt faces (fitted, 128 px each; outline is geometry): cream flesh-side hide with an ochre sun, dark bison fur with a white zigzag',
  paint(g, w, rnd, h) {
    const S = 128;
    for (const k of [0, 1]) {
      const X = k * S, cx = X + S / 2, cy = S / 2;
      g.save(); g.beginPath(); g.rect(X, 0, S, S); g.clip();
      const base = k ? '#5a3e2e' : '#c49c6c';
      g.fillStyle = base; g.fillRect(X, 0, S, S);
      for (let i = 0; i < 14; i++) blob(g, X + rnd() * S, rnd() * S, range(rnd, 12, 30), range(rnd, 8, 22), rnd() * 3, jitter(k ? pick(rnd, ['#6a4a34', '#4a3226', '#74523a']) : pick(rnd, ['#d4ac7a', '#b48a5a', '#caa070']), rnd, 0.04), 0.35, 0.1);
      // the spine: a soft darker stripe down the middle, the flank on the lit side warmer
      g.fillStyle = grad(g, X, 0, X + S, 0, [[0, INK, 0.0], [0.38, '#fff0d0', k ? 0.06 : 0.12], [0.5, INK, k ? 0.28 : 0.14], [0.62, INK, 0.04], [1, INK, 0.1]]); g.fillRect(X, 0, S, S);
      if (k) {
        // fur: short strokes sweeping out from the spine, lit tips
        for (let i = 0; i < 260; i++) {
          const x = X + rnd() * S, y = rnd() * S, dir = x < cx ? -1 : 1, a = Math.atan2(0.6, dir) + range(rnd, -0.3, 0.3), L = range(rnd, 4, 9);
          line(g, [[x, y], [x + Math.cos(a) * L, y + Math.sin(a) * L]], range(rnd, 1, 2), rnd() < 0.3 ? '#9a7656' : '#2e2018', 0.45);
        }
        // a white-clay zigzag across the shoulders, two handprint dabs
        const zz = []; for (let q = 0; q <= 8; q++) zz.push([X + 18 + q * 11.5, 42 + (q % 2 ? -9 : 9)]);
        stroke(g, zz.map(([u, v]) => [u + 1.5, v + 2]), 7, 6, '#1e1410', 0.35); stroke(g, zz, 6, 5, '#e8dcc4', 0.85);
        for (const [hx2, hy2] of [[cx - 18, 82], [cx + 16, 88]]) { blob(g, hx2, hy2, 7, 8, 0, '#e8dcc4', 0.8, 0.5); for (let f = 0; f < 4; f++) blob(g, hx2 - 6 + f * 4, hy2 - 11, 1.8, 4, 0, '#e8dcc4', 0.75, 0.5); }
      } else {
        // scraped flesh side: pale blotches, fine scraping marks, an ochre-and-red sun with a ring of dots
        for (let i = 0; i < 40; i++) { const x = X + rnd() * S, y = rnd() * S; line(g, [[x, y], [x + range(rnd, 6, 14), y + range(rnd, -2, 2)]], 1, '#e8d0a8', 0.3); }
        g.save(); g.translate(cx, cy + 4);
        for (let q = 0; q < 12; q++) { const a = q / 12 * TAU; stroke(g, [[Math.cos(a) * 17, Math.sin(a) * 17], [Math.cos(a) * 29, Math.sin(a) * 29]], 4.5, 1.5, q % 2 ? '#b04a2e' : '#c8862e', 0.85); }
        g.beginPath(); g.arc(0, 0, 14, 0, TAU); g.fillStyle = rgba('#a8402a', 0.9); g.fill();
        g.beginPath(); g.arc(0, 0, 7, 0, TAU); g.fillStyle = rgba('#d89a3a', 0.9); g.fill();
        for (let q = 0; q < 16; q++) { const a = q / 16 * TAU; blob(g, Math.cos(a) * 38, Math.sin(a) * 36, 2.4, 2.4, 0, '#7a2a1e', 0.8, 0.5); }
        g.restore();
      }
      // wrinkles, light over, cool shadow under
      for (let i = 0; i < 7; i++) { const x = X + range(rnd, 10, S - 30), y = range(rnd, 10, S - 10), L = range(rnd, 12, 26), a = range(rnd, -0.5, 0.5); const pts = [[x, y], [x + Math.cos(a) * L * 0.5, y + Math.sin(a) * L * 0.5 + 2], [x + Math.cos(a) * L, y + Math.sin(a) * L]]; stroke(g, pts.map(([u, v]) => [u, v + 1.6]), 2.6, 0.6, '#2c2018', 0.28); stroke(g, pts, 1.6, 0.4, k ? '#a07a5a' : '#f0dcb4', 0.35); }
      // the edges darken and curl: a soft vignette toward the outline
      g.fillStyle = radial(g, cx, cy, S * 0.22, S * 0.62, [[0, INK, 0], [0.6, '#3a2418', 0.2], [1, '#2a1a14', 0.6]]); g.fillRect(X, 0, S, S);
      g.restore();
    }
    glaze(g, w, h, '#ffd8b0', 0.08, 'soft-light');
    blurTile(g.canvas, 0.4);
  },
});

// ---- atlases: textures that share one draw call per cluster -----------------------------------------------
// Each part is painted exactly as its own texture would be (same paint function, same seed), then placed.
function part(name) {
  const t = meta(name), cv = makeCanvas(t.w, t.h);
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!t.alpha) { g.fillStyle = '#7f7f7f'; g.fillRect(0, 0, t.w, t.h); }
  t.paint(g, t.w, rngFrom(name), t.h, cv);
  return cv;
}
// the ranger gate's labels: station board (u 0-1, v .667-1), warning boards (u 0-.5; board 0 v .5-.667,
// board 1 v .333-.5), STOP (u .5-1, v .417-.667), keypad face (u .5-.75, v 0-.417), two pelts (u 0-.25 and .25-.5, v 0-.333)
register('rs_gatelabels', {
  family: F, w: 512, h: 384, note: 'atlas of the ranger gate labels: station board, two warning boards, STOP, keypad face, two pelts (fitted by uv rect)',
  paint(g) {
    g.fillStyle = '#2a2024'; g.fillRect(0, 0, 512, 384);
    g.drawImage(part('rs_ranger_board'), 0, 0);
    g.drawImage(part('rs_warn'), 0, 128);
    g.drawImage(part('rs_stop'), 256, 128);
    g.drawImage(part('rs_keypad'), 256, 224);
    g.drawImage(part('rs_pelts'), 0, 256);
  },
});
// the three parked-RV skins stacked (v fitted into a quarter each: green .75-1, rust .5-.75, blue .25-.5), name boards in 0-.25
register('rs_rv_skins', {
  family: F, w: 256, h: 1024, note: 'atlas of the three junked motorhome skins and their name boards, stacked (u along the body, 3 m; v fitted into a quarter each)',
  paint(g) { ['rs_rv_green', 'rs_rv_rust', 'rs_rv_blue', 'rs_rv_names'].forEach((n, i) => g.drawImage(part(n), 0, i * 256)); },
});

