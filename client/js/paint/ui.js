// Texture family: ui. The 2D interface skin, painted like WoW Classic's UI art:
// parchment, dark slate, stained wood, worn antique-gold frames with cast corner
// ornaments and rivets, red gold-rimmed buttons, glossy status bars, small
// painted object icons, and a painted vista for the title screen. See docs/ART.md.
//
// Most of these are applied to the DOM: labels.js turns them into blob URLs
// and sets CSS custom properties (--tx-parchment, --tx-frame-gold, ...), which
// style.css uses as backgrounds and 9-slice border-images.
//
//   tiling:    ui_parchment ui_stone ui_wood ui_leather ui_bar
//   9-slice:   ui_frame_gold (416, slice 80, middle repeats)  ui_trim_gold (288, slice 48)
//              ui_frame_silver (96, slice 32)  ui_btn_red / ui_btn_stone (128x40, slice 14)  ui_editbox (64, slice 16)
//   sprites:   ui_filigree (512x64)  ui_endcap (160x128)  ui_seal (96)  ui_ring (128)  ui_menu_bg (1280x720)
//   icons 64:  ui_ico_<crown coin hourglass scroll hook key door sun mic micoff speaker
//              speakeroff walkie gear close ping skull bolt>  (cut-out objects: world markers, ornaments)
//   slots 64:  ui_slot_<sun hourglass coin scroll hook key door mic micoff speaker speakeroff gear
//              close walkie>  (full-bleed square icons for the HUD and the voice dock)
//   title:     paintVista (backdrop stages, or the whole scene in 2D) + finishVista; labels.js
//              renders the game's own 3D assets over the backdrop when it can
import {
  register, mottle, streaks, blob, ellipse, stroke, cracks, glaze, blurTile, fill, vgrad, rgba, mix,
  lightOf, shadowOf, wrap, range, pick, rowLayout, paintRects, makeCanvas, jitter, blade, pebbles, canvasFor,
} from './core.js';

const F = 'ui';

// ---- palettes & painting helpers --------------------------------------------------------

export const PAL = {
  gold:   { hi: '#fff3c2', light: '#f3d06a', mid: '#c99433', low: '#8c5c1b', dark: '#4b2e0c', line: '#1d1004' },
  // worn antique gold for the big frames: darker than the text it holds
  antique: { hi: '#f3d06a', light: '#c99433', mid: '#8c5c1b', low: '#6b4a1a', dark: '#3a2410', line: '#1a0e04', mott: ['#a8742a', '#6b4a1a', '#c99433', '#7d5420'] },
  brass:  { hi: '#fff0b8', light: '#e0b04a', mid: '#b07d2c', low: '#7a5220', dark: '#4a2e10', line: '#1d1004' },
  silver: { hi: '#ffffff', light: '#e1e3e8', mid: '#a7abb4', low: '#6d717b', dark: '#3d4048', line: '#121318' },
  iron:   { hi: '#c4c7cd', light: '#8b9099', mid: '#5c616a', low: '#3d4149', dark: '#25282e', line: '#0b0c0e' },
  red:    { hi: '#ffb08a', light: '#d64a30', mid: '#a32616', low: '#6c130a', dark: '#3e0804', line: '#170302' },
  cloth:  { hi: '#ff9c7c', light: '#c8402a', mid: '#9a2214', low: '#62120a', dark: '#360804', line: '#170302' },
  bone:   { hi: '#fffaf0', light: '#efe6d0', mid: '#cfc2a2', low: '#97896b', dark: '#5c5240', line: '#1e1a12' },
  wood:   { hi: '#d9a86a', light: '#a8733f', mid: '#7a4f28', low: '#523318', dark: '#2e1c0c', line: '#120a04' },
  leather: { hi: '#c89a6a', light: '#8a5a32', mid: '#6a4024', low: '#4a2a16', dark: '#2a160a', line: '#120804' },
  cork:   { hi: '#f6e0b0', light: '#d9b47a', mid: '#b48a52', low: '#86603a', dark: '#4e3420', line: '#1e1208' },
  pewter: { hi: '#c4c7cd', light: '#a4a8b0', mid: '#8a8d94', low: '#5c6068', dark: '#3c3f46', line: '#121318' },
  slate:  { hi: '#9aa0ab', light: '#6c717c', mid: '#4a4e57', low: '#33363d', dark: '#202227', line: '#0a0b0d' },
};

function layer(w, h) { const cv = makeCanvas(w, h); return [cv, cv.getContext('2d')]; }

// A white mask drawn by fn(g).
function mask(w, h, fn) {
  const [cv, g] = layer(w, h);
  g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineCap = 'round'; g.lineJoin = 'round';
  fn(g);
  return cv;
}
// mask recolored
function tint(m, color, alpha = 1) {
  const [cv, g] = layer(m.width, m.height);
  g.drawImage(m, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.globalAlpha = alpha;
  g.fillStyle = color; g.fillRect(0, 0, cv.width, cv.height);
  return cv;
}
// the part of m that is NOT covered by m shifted by (dx, dy): a rim facing -(dx, dy)
function rim(m, dx, dy, color, blurPx = 0.8) {
  const [cv, g] = layer(m.width, m.height);
  g.drawImage(m, 0, 0);
  g.globalCompositeOperation = 'destination-out';
  g.drawImage(m, dx, dy);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color; g.fillRect(0, 0, cv.width, cv.height);
  if (blurPx > 0) {
    const [c2, g2] = layer(m.width, m.height);
    g2.filter = `blur(${blurPx}px)`; g2.drawImage(cv, 0, 0);
    g2.filter = 'none';
    g2.globalCompositeOperation = 'destination-in'; g2.drawImage(m, 0, 0);
    return c2;
  }
  return cv;
}
// keep only what lies under `keep`'s alpha
function within(cv, keep) { const g = cv.getContext('2d'); g.save(); g.globalCompositeOperation = 'destination-in'; g.drawImage(keep, 0, 0); g.restore(); return cv; }
// copies of a mark at ±period that still touch the canvas (keeps 9-slice middles seamless)
function periodic(x, y, r, w, h, period) {
  if (!period) return [[x, y]];
  const out = [];
  for (const ox of [-period, 0, period]) for (const oy of [-period, 0, period]) {
    const px = x + ox, py = y + oy;
    if (px + r >= 0 && px - r <= w && py + r >= 0 && py - r <= h) out.push([px, py]);
  }
  return out;
}
// soft white brush dabs: an alpha mask that breaks rims and highlights into painted strokes.
// period > 0 repeats every dab at ±period (so 9-slice middles stay seamless)
function dabs(w, h, rnd, n, rmin, rmax, amin = 0.35, amax = 1, period = 0) {
  const [cv, g] = layer(w, h);
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, rx = range(rnd, rmin, rmax), ry = rx * range(rnd, 0.5, 0.9), a = rnd() * 3, al = range(rnd, amin, amax);
    for (const [px, py] of periodic(x, y, rx, w, h, period)) blob(g, px, py, rx, ry, a, '#ffffff', al, 0.45);
  }
  return cv;
}

// Paint a mask as a solid object with a brush rather than a bevel filter: a base
// colour, a 2-3 hue mottle, broad form shading (warm light from the upper left,
// cool shade toward the lower right), a broken warm rim where the light hits, a
// cool rim on the shaded side, and a soft 1px dark outline.
function paintObj(g, m, pal, rnd, {
  d = 1.6, outline = 1, shadow = 0.5, mottleAmt = 0.45, lit = 0.85, glints = 2, x = 0, y = 0, bbox = null, period = 0, mott = null, form = 1, count = 0, dabCount = 0, size = 0,
} = {}) {
  const w = m.width, h = m.height;
  const [bx, by, bw, bh] = bbox || [0, 0, w, h];
  if (shadow > 0) { g.save(); g.filter = `blur(${Math.max(1, d)}px)`; g.globalAlpha = shadow; g.drawImage(tint(m, '#140c10'), x + d * 0.8, y + d * 1.2); g.restore(); }
  if (outline > 0) {
    const [o, og] = layer(w, h);
    og.filter = 'blur(0.6px)'; og.drawImage(tint(m, pal.line, 0.85), 0, 0);
    for (let a = 0; a < 8; a++) g.drawImage(o, x + Math.cos(a * Math.PI / 4) * outline, y + Math.sin(a * Math.PI / 4) * outline);
  }
  const [b, bg] = layer(w, h);
  bg.fillStyle = pal.mid; bg.fillRect(0, 0, w, h);
  const sz = size || Math.min(bw, bh), cols = mott || [pal.light, pal.low, pal.mid];
  const n = count || Math.max(10, (bw * bh) / 200);
  for (let i = 0; i < n; i++) {
    const px = bx + rnd() * bw, py = by + rnd() * bh, rx = range(rnd, 0.06, 0.26) * sz + 1.5, ry = rx * range(rnd, 0.4, 0.8), a = rnd() * 3, c = pick(rnd, cols), al = mottleAmt * range(rnd, 0.5, 1);
    for (const [qx, qy] of periodic(px, py, rx, w, h, period)) blob(bg, qx, qy, rx, ry, a, c, al, 0.22);
  }
  if (form > 0) {
    const gr = bg.createLinearGradient(bx, by, bx + bw, by + bh);
    gr.addColorStop(0, rgba(pal.light, 0.5 * form)); gr.addColorStop(0.42, rgba(pal.light, 0)); gr.addColorStop(0.58, 'rgba(58,42,74,0)'); gr.addColorStop(1, `rgba(58,42,74,${0.5 * form})`);
    bg.fillStyle = gr; bg.fillRect(0, 0, w, h);
  }
  bg.globalCompositeOperation = 'destination-in'; bg.drawImage(m, 0, 0);
  g.drawImage(b, x, y);
  g.save(); g.globalAlpha = 0.6; g.drawImage(rim(m, -d, -d, '#3a2a4a', d * 0.45), x, y); g.restore();
  g.save(); g.globalAlpha = 0.55; g.drawImage(rim(m, -d * 0.5, -d * 0.5, pal.dark, 0.4), x, y); g.restore();
  const hi = rim(m, d, d, pal.hi, d * 0.35);
  within(hi, dabs(w, h, rnd, dabCount || Math.max(14, (w + h) / 2.5), 2.5, Math.max(4, Math.min(sz * 0.22, 14)), 0.3, 1, period));
  g.save(); g.globalAlpha = lit; g.drawImage(hi, x, y); g.restore();
  if (glints > 0) {
    const [gl, glg] = layer(w, h);
    for (let i = 0; i < glints; i++) blob(glg, bx + range(rnd, 0.1, 0.55) * bw, by + range(rnd, 0.08, 0.45) * bh, range(rnd, 1.2, 3), range(rnd, 0.8, 1.6), rnd() * 3, '#fffbe8', 0.75, 0.45);
    within(gl, rim(m, d * 1.6, d * 1.6, '#fff', 0));
    g.drawImage(gl, x, y);
  }
}

// A rivet: a dark recess, a domed head, a lit spot upper left.
function rivet(g, x, y, r, pal = PAL.antique) {
  blob(g, x + r * 0.35, y + r * 0.45, r * 1.55, r * 1.4, 0, '#1a0e04', 0.7, 0.45);
  ellipse(g, x, y, r, r, 0, pal.mid, 1);
  blob(g, x + r * 0.3, y + r * 0.35, r * 0.75, r * 0.6, 0, pal.dark, 0.6, 0.4);
  ellipse(g, x - r * 0.32, y - r * 0.35, r * 0.42, r * 0.36, 0, pal.hi, 0.95);
}
// An engraved notch across a band: a dark cut with a lit lip below it.
function notch(g, x0, y0, x1, y1, w = 1.4) {
  stroke(g, [[x0 + 0.9, y0 + 0.9], [x1 + 0.9, y1 + 0.9]], w * 0.8, w * 0.8, '#f3d06a', 0.55);
  stroke(g, [[x0, y0], [x1, y1]], w, w, '#2a1606', 0.75);
}

// ruby / sapphire cabochon, optionally set deep in a dark socket
function gem(g, x, y, r, color = '#b3261e', socket = 0) {
  if (socket) { ellipse(g, x + 0.6, y + 0.8, r + socket, r + socket, 0, '#140a02', 0.95); ellipse(g, x - 0.5, y - 0.6, r + socket * 0.4, r + socket * 0.4, 0, '#2a1606', 1); }
  blob(g, x + r * 0.25, y + r * 0.35, r * 1.2, r * 1.1, 0, '#0c0406', 0.5, 0.3);
  const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  gr.addColorStop(0, lightOf(color, 0.9)); gr.addColorStop(0.45, color); gr.addColorStop(1, shadowOf(color, 0.6));
  g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(20,6,4,0.8)'; g.lineWidth = 1; g.stroke();
  blob(g, x - r * 0.38, y - r * 0.42, r * 0.32, r * 0.22, -0.6, '#ffffff', 0.9, 0.5);
  blob(g, x + r * 0.35, y + r * 0.45, r * 0.4, r * 0.18, -0.6, lightOf(color, 0.5), 0.45, 0.3);
}

// A curling filigree scroll as a tapered stroke into a mask context.
function curl(g, x, y, r, a0, turns, w0, dir = 1) {
  const pts = [];
  const n = 24;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = a0 + dir * t * turns * Math.PI * 2;
    const rr = r * (1 - t * 0.78);
    pts.push([x + Math.cos(a) * rr, y + Math.sin(a) * rr]);
  }
  stroke(g, pts, w0, w0 * 0.35, '#fff');
}

const rr = (x, y, w, h, r) => { const p = new Path2D(); p.roundRect(x, y, w, h, r); return p; };

// The old uniform bevel, kept only for the small inset rims of buttons and edit boxes.
function emboss(g, m, pal, rnd, { d = 2, outline = 1.2, shadow = 0.6, mottleAmt = 0.35, glints = 3, hiAlpha = 0.95 } = {}) {
  const w = m.width, h = m.height;
  if (shadow > 0) { g.save(); g.filter = `blur(${Math.max(1, d)}px)`; g.globalAlpha = shadow; g.drawImage(tint(m, '#120a10'), d * 0.9, d * 1.4); g.restore(); }
  if (outline > 0) { const o = tint(m, pal.line); for (let a = 0; a < 8; a++) g.drawImage(o, Math.cos(a * Math.PI / 4) * outline, Math.sin(a * Math.PI / 4) * outline); }
  const [b, bg] = layer(w, h);
  const gr = bg.createLinearGradient(0, 0, w * 0.25, h);
  gr.addColorStop(0, pal.light); gr.addColorStop(0.45, pal.mid); gr.addColorStop(1, pal.low);
  bg.fillStyle = gr; bg.fillRect(0, 0, w, h);
  for (let i = 0; i < Math.max(6, (w * h) / 500); i++) blob(bg, rnd() * w, rnd() * h, range(rnd, 2, Math.max(4, Math.min(w, h) * 0.25)), range(rnd, 2, Math.max(3, Math.min(w, h) * 0.15)), rnd() * 3, pick(rnd, [pal.light, pal.low, pal.mid, pal.hi]), mottleAmt * range(rnd, 0.3, 0.8), 0.15);
  bg.globalCompositeOperation = 'destination-in'; bg.drawImage(m, 0, 0);
  g.drawImage(b, 0, 0);
  g.save(); g.globalAlpha = hiAlpha; g.drawImage(rim(m, d, d, pal.hi, Math.abs(d) * 0.45), 0, 0); g.restore();
  g.save(); g.globalAlpha = 0.85; g.drawImage(rim(m, -d, -d, pal.dark, Math.abs(d) * 0.45), 0, 0); g.restore();
  if (glints > 0) {
    const [gl, glg] = layer(w, h);
    for (let i = 0; i < glints; i++) blob(glg, range(rnd, w * 0.1, w * 0.6), range(rnd, h * 0.08, h * 0.45), range(rnd, 1.5, 3.5), range(rnd, 1, 2), rnd() * 3, '#fffbe8', 0.7, 0.4);
    within(gl, rim(m, d * 1.5, d * 1.5, '#fff', 0));
    g.drawImage(gl, 0, 0);
  }
}

// ---- tiling surfaces ----------------------------------------------------------------------

// Aged parchment for quest-log style panels (receipt, help, game over). The edge burn is in CSS.
register('ui_parchment', { size: 512, family: F, note: 'tiles; quest parchment', paint(g, s, rnd) {
  fill(g, s, s, '#e0c794');
  mottle(g, s, rnd, { colors: ['#eedcae', '#d6b984', '#e8d29f', '#cfae78', '#f2e3bb', '#c8a46c'], count: 90, rmin: 50, rmax: 170, alpha: 0.55, hard: 0.08 });
  mottle(g, s, rnd, { colors: ['#b08850'], count: 14, rmin: 60, rmax: 140, alpha: 0.25, hard: 0.05 });
  mottle(g, s, rnd, { colors: ['#c9a46a', '#bf9760', '#d6b57c'], count: 34, rmin: 12, rmax: 46, alpha: 0.24, hard: 0.1 });
  // fibres, mostly horizontal
  streaks(g, s, rnd, { colors: ['#c3a26c', '#f4e7c6', '#d4b985'], count: 340, len: [8, 34], width: [0.5, 1.2], angle: Math.PI / 2, wobble: 0.9, alpha: 0.24 });
  // foxing: small rust-brown spots
  for (let i = 0; i < 40; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.2, 4.5), a = rnd() * 3;
    wrap(s, x, y, r * 3, (xx, yy) => { blob(g, xx, yy, r * 2.4, r * 2, a, '#b78a55', 0.18, 0.1); blob(g, xx, yy, r, r * 0.8, 0, '#8e6236', 0.28, 0.4); });
  }
  // a few broken, wobbly tide-line arcs (old spills that dried)
  for (let i = 0; i < 5; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 30, 70), a0 = rnd() * Math.PI * 2, span = range(rnd, 0.25, 0.35) * Math.PI * 2, sq = range(rnd, 0.6, 0.9);
    const pts = []; for (let k = 0; k <= 12; k++) { const a = a0 + span * k / 12, rr2 = r * (1 + Math.sin(k * 1.7 + i) * 0.06); pts.push([Math.cos(a) * rr2, Math.sin(a) * rr2 * sq]); }
    const w0 = range(rnd, 1, 2.2);
    wrap(s, x, y, r + 4, (xx, yy) => stroke(g, pts.map(([u, v]) => [xx + u, yy + v]), w0, w0 * 0.3, '#a77d4b', 0.16));
  }
  blurTile(g.canvas, 0.6);
  glaze(g, s, s, '#f3dca4', 0.22, 'soft-light');
} });

// Dark slate: the backing of HUD plates, popups and the voice panel.
register('ui_stone', { size: 256, family: F, note: 'tiles; dark slate backing', paint(g, s, rnd) {
  fill(g, s, s, '#2a2a30');
  mottle(g, s, rnd, { colors: ['#1c1c22', '#403e46', '#34343c', '#232328', '#3a342c', '#262a34'], count: 80, rmin: 14, rmax: 70, alpha: 0.7, hard: 0.25 });
  streaks(g, s, rnd, { colors: ['#4a4852', '#45434b', '#3b3a40'], count: 30, len: [30, 110], width: [0.8, 2], angle: 1.2, wobble: 0.9, alpha: 0.3 });
  cracks(g, s, rnd, { color: '#121115', count: 8, len: [24, 80], width: [0.7, 1.6], alpha: 0.6 });
  for (let i = 0; i < 60; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 0.8, 2.2);
    wrap(s, x, y, r * 2, (xx, yy) => { blob(g, xx, yy, r, r * 0.8, 0, '#5a5862', 0.35, 0.5); });
  }
  blurTile(g.canvas, 0.5);
} });
// Dark stained planks (menu card, keypad board).
register('ui_wood', { size: 256, family: F, note: 'tiles; dark stained planks', paint(g, s, rnd) {
  const rects = rowLayout(s, rnd, { rows: 5, minW: 110, maxW: 250, rowJitter: 0.35 });
  paintRects(g, s, rects, rnd, {
    colors: ['#4e3220', '#573822', '#45291a', '#5c3d26'], gap: 3, gapColor: '#160d08', radius: 2, bevel: 3, light: 0.3, varAmt: 0.08,
    inner: (gg, X, Y, w, h, c, r) => {
      for (let k = 0; k < 9; k++) {
        const yy = Y + range(r, 2, h - 2), pts = [];
        for (let i = 0; i <= 8; i++) pts.push([X + (i / 8) * w, yy + Math.sin(i * 0.9 + k) * range(r, 0.3, 1.6)]);
        stroke(gg, pts, range(r, 0.6, 1.6), 0.5, pick(r, [shadowOf(c, 0.35), lightOf(c, 0.25)]), range(r, 0.25, 0.5));
      }
      if (r() < 0.5) { const kx = X + range(r, 20, w - 20), ky = Y + h / 2; ellipse(gg, kx, ky, 6, 3, 0, shadowOf(c, 0.5), 0.6); ellipse(gg, kx - 1, ky - 1, 3, 1.5, 0, lightOf(c, 0.2), 0.4); }
    },
  });
  glaze(g, s, s, '#3a2412', 0.25, 'multiply');
} });

// Tooled dark leather (HUD bar, roster plates).
register('ui_leather', { size: 256, family: F, note: 'tiles; tooled dark leather', paint(g, s, rnd) {
  fill(g, s, s, '#3b2618');
  mottle(g, s, rnd, { colors: ['#4a3020', '#2f1d12', '#523624', '#3a2516'], count: 90, rmin: 10, rmax: 50, alpha: 0.45, hard: 0.2 });
  // pores / pebbled grain
  for (let i = 0; i < 900; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 0.6, 1.6);
    wrap(s, x, y, r * 2, (xx, yy) => { ellipse(g, xx, yy, r, r * 0.8, 0, '#24160d', 0.35); ellipse(g, xx - 0.6, yy - 0.6, r * 0.6, r * 0.4, 0, '#6b4a33', 0.25); });
  }
  streaks(g, s, rnd, { colors: ['#1e120a', '#5d412c'], count: 30, len: [10, 50], width: [0.6, 1.4], angle: 0.4, wobble: 1, alpha: 0.25 });
  blurTile(g.canvas, 0.4);
} });

// Status-bar gloss: light grayscale, multiplied over the bar color in CSS.
register('ui_bar', { w: 256, h: 32, family: F, note: 'tiles in x; multiply over a fill color', paint(g, w, rnd, h) {
  vgrad(g, w, h, [[0, '#f4f4f4'], [0.16, '#ffffff'], [0.34, '#e6e6e6'], [0.62, '#c9c9c9'], [0.86, '#a9a9a9'], [1, '#7b7b7b']]);
  for (let i = 0; i < 40; i++) {
    const x = rnd() * w, y = range(rnd, 4, h - 4), rx = range(rnd, 12, 40);
    for (const xx of [x, x - w, x + w]) blob(g, xx, y, rx, range(rnd, 2, 5), 0, pick(rnd, ['#ffffff', '#b8b8b8', '#d2d2d2']), 0.25, 0.1);
  }
  g.fillStyle = 'rgba(255,255,255,0.55)'; g.fillRect(0, 2, w, 2);
  g.fillStyle = 'rgba(40,40,40,0.45)'; g.fillRect(0, h - 2, w, 2);
} });

// ---- frames (9-slice) ----------------------------------------------------------------------

// The cast-gold band shared by the dialog frame and the HUD trim: an antique-gold
// ring (A..B from the outer edge, corner radius cr) painted with a brush, a groove
// down its middle, rivets and engraved notches in the straight runs. The middle
// segment (slice..size-slice) is painted periodic so border-image-repeat: round
// tiles it without seams.
function goldBand(g, s, rnd, { A, B, cr, slice, rivetR, gap = [28, 40], d = 2, notches = true }) {
  const period = s - 2 * slice;
  const m = mask(s, s, mg => {
    const ring = new Path2D(); ring.addPath(rr(A, A, s - 2 * A, s - 2 * A, cr)); ring.addPath(rr(B, B, s - 2 * B, s - 2 * B, Math.max(2, cr - (B - A))));
    mg.fill(ring, 'evenodd');
  });
  paintObj(g, m, PAL.antique, rnd, { d, outline: 1.1, shadow: 0.75, mottleAmt: 0.42, lit: 0.9, glints: 0, mott: PAL.antique.mott, period, form: 0.35, count: Math.round(s * 1.2), dabCount: Math.round(s * 0.7), size: (B - A) * 2.6 });
  // the groove along the middle of the band, patina in it
  const mid = (A + B) / 2, gw = Math.max(1.2, (B - A) * 0.09);
  g.save();
  g.strokeStyle = rgba('#3b2a12', 0.5); g.lineWidth = gw * 2.4; g.beginPath(); g.roundRect(mid, mid, s - 2 * mid, s - 2 * mid, Math.max(2, cr - (B - A) / 2)); g.stroke();
  g.strokeStyle = rgba('#24140a', 0.7); g.lineWidth = gw; g.beginPath(); g.roundRect(mid - gw * 0.4, mid - gw * 0.4, s - 2 * mid + gw * 0.8, s - 2 * mid + gw * 0.8, Math.max(2, cr - (B - A) / 2)); g.stroke();
  g.strokeStyle = rgba('#f3d06a', 0.4); g.lineWidth = gw * 0.7; g.beginPath(); g.roundRect(mid + gw * 0.9, mid + gw * 0.9, s - 2 * mid - gw * 1.8, s - 2 * mid - gw * 1.8, Math.max(2, cr - (B - A) / 2)); g.stroke();
  g.restore();
  // rivets and notches in the straight runs (each run painted once per period, so it tiles)
  const stops = [];
  for (let t = slice + range(rnd, 6, 14); t < s - slice - 8; t += range(rnd, gap[0], gap[1])) stops.push([t, !notches || rnd() < 0.62 ? 'rivet' : 'notch', range(rnd, -1, 1)]);
  const rq = (B - A) * 0.32;
  for (const [t, kind, j] of stops) {
    for (const [x, y, horiz] of [[t, mid, 1], [t, s - mid, 1], [mid, t, 0], [s - mid, t, 0]]) {
      if (kind === 'rivet') rivet(g, x + (horiz ? j * 2 : 0), y + (horiz ? 0 : j * 2), rivetR);
      else if (horiz) { for (const o of [-1.6, 1.6]) notch(g, x + o * rq * 0.5, y - rq * 1.25, x + o * rq * 0.5, y + rq * 1.25, 1.2); }
      else { for (const o of [-1.6, 1.6]) notch(g, x - rq * 1.25, y + o * rq * 0.5, x + rq * 1.25, y + o * rq * 0.5, 1.2); }
    }
  }
  // worn spots: a little dark patina where hands would rub
  const [l2, g2] = layer(s, s);
  for (let i = 0; i < 10; i++) {
    const t = range(rnd, slice, s - slice), side = Math.floor(rnd() * 4), r = range(rnd, 4, 10), a = range(rnd, 0.15, 0.3);
    const [x, y] = side === 0 ? [t, A + 3] : side === 1 ? [t, s - A - 3] : side === 2 ? [A + 3, t] : [s - A - 3, t];
    for (const o of [-period, 0, period]) blob(g2, x + (side < 2 ? o : 0), y + (side < 2 ? 0 : o), r, r * 0.6, side < 2 ? 0 : Math.PI / 2, '#3b2a12', a, 0.3);
  }
  within(l2, m); g.drawImage(l2, 0, 0);
  return m;
}

// The cast corner ornament: a concave-sided diamond plate with an engraved border,
// a round boss and a ruby set deep in a dark socket, with two cast knuckles on the
// diagonal. Each corner is painted on its own (lit from the upper left), centred
// on the band's corner (c, c), (s-c, c), ...
function cornerOrnament(g, s, rnd, c, R) {
  const S = Math.ceil(2 * R + 24), h = S / 2;
  const diamond = (mg, k) => {
    mg.beginPath();
    const q = 0.4 * k;
    mg.moveTo(h, h - R * k);
    mg.quadraticCurveTo(h + R * q, h - R * q, h + R * k, h);
    mg.quadraticCurveTo(h + R * q, h + R * q, h, h + R * k);
    mg.quadraticCurveTo(h - R * q, h + R * q, h - R * k, h);
    mg.quadraticCurveTo(h - R * q, h - R * q, h, h - R * k);
  };
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    const [cv, cg] = layer(S, S);
    const plate = mask(S, S, mg => {
      diamond(mg, 1); mg.fill();
      mg.beginPath(); mg.arc(h, h, R * 0.56, 0, Math.PI * 2); mg.fill();
      for (const k of [1, -1]) { mg.beginPath(); mg.arc(h + sx * k * R * 0.45, h + sy * k * R * 0.45, R * 0.2, 0, Math.PI * 2); mg.fill(); }
    });
    paintObj(cg, plate, PAL.antique, rnd, { d: 2.4, outline: 1.3, shadow: 0.85, mottleAmt: 0.45, lit: 0.95, glints: 5, mott: PAL.antique.mott, form: 0.6, bbox: [h - R, h - R, 2 * R, 2 * R], count: 150, size: R * 1.1 });
    cg.save(); cg.translate(0.9, 0.9); diamond(cg, 0.74); cg.strokeStyle = rgba('#f3d06a', 0.45); cg.lineWidth = 1.2; cg.stroke(); cg.restore();
    diamond(cg, 0.74); cg.strokeStyle = rgba('#24140a', 0.75); cg.lineWidth = 1.5; cg.stroke();
    cg.strokeStyle = rgba('#24140a', 0.7); cg.lineWidth = 1.6; cg.beginPath(); cg.arc(h, h, R * 0.46, 0, Math.PI * 2); cg.stroke();
    cg.strokeStyle = rgba('#f3d06a', 0.5); cg.lineWidth = 1; cg.beginPath(); cg.arc(h + 0.8, h + 0.8, R * 0.46, Math.PI * 0.9, Math.PI * 1.6); cg.stroke();
    gem(cg, h, h, R * 0.27, '#a8231b', R * 0.08);
    g.drawImage(cv, (sx > 0 ? c : s - c) - h, (sy > 0 ? c : s - c) - h);
  }
}

// Gold dialog frame. 416px, slice 80 (drawn at 50px: 1.6 texture px per screen px).
// The band runs 26..46px from the outer edge; corners carry a cast ornament about
// 72px across; a soft inner shadow (46..76) falls onto the panel.
register('ui_frame_gold', { size: 416, family: F, alpha: true, note: '9-slice 80, middle repeats (round); antique gold, rivets, cast corners', paint(g, s, rnd) {
  const A = 26, B = 46, slice = 80;
  for (let i = 0; i < 12; i++) {
    const k = i / 12;
    g.strokeStyle = rgba('#140a06', 0.24 * (1 - k)); g.lineWidth = 2.6;
    g.strokeRect(B + i * 2.4, B + i * 2.4, s - 2 * (B + i * 2.4), s - 2 * (B + i * 2.4));
  }
  goldBand(g, s, rnd, { A, B, cr: 10, slice, rivetR: 3.3, gap: [44, 62], d: 2.2, notches: false });
  cornerOrnament(g, s, rnd, (A + B) / 2, 36);
} });

// Thin gold trim for the HUD bar. 288px, slice 48 (drawn at 18px); band 14..26.
register('ui_trim_gold', { size: 288, family: F, alpha: true, note: '9-slice 48, middle repeats (round); thin HUD trim', paint(g, s, rnd) {
  const A = 14, B = 26, slice = 48;
  for (let i = 0; i < 6; i++) { g.strokeStyle = rgba('#140a06', 0.28 * (1 - i / 6)); g.lineWidth = 2; g.strokeRect(B + i * 2, B + i * 2, s - 2 * (B + i * 2), s - 2 * (B + i * 2)); }
  goldBand(g, s, rnd, { A, B, cr: 7, slice, rivetR: 2.4, gap: [40, 56], d: 1.8 });
  // small square corner caps with a rivet
  const c = (A + B) / 2;
  const caps = mask(s, s, mg => { for (const [x, y] of [[c, c], [s - c, c], [c, s - c], [s - c, s - c]]) { mg.beginPath(); mg.roundRect(x - 13, y - 13, 26, 26, 4); mg.fill(); } });
  paintObj(g, caps, PAL.antique, rnd, { d: 1.8, outline: 1.1, shadow: 0.7, mott: PAL.antique.mott, glints: 3, form: 0.6 });
  for (const [x, y] of [[c, c], [s - c, c], [c, s - c], [s - c, s - c]]) { g.strokeStyle = rgba('#24140a', 0.7); g.lineWidth = 1.2; g.strokeRect(x - 9, y - 9, 18, 18); rivet(g, x, y, 3.6); }
} });

// Pewter tooltip frame (prompt, tooltips): a dull gray-metal band with a dark line
// inside it, like WoW's tooltip border. 96px, slice 32; band 8..15.
register('ui_frame_silver', { size: 96, family: F, alpha: true, note: '9-slice 32; dull pewter tooltip border', paint(g, s, rnd) {
  const A = 8, B = 15;
  for (let i = 0; i < 6; i++) { g.strokeStyle = rgba('#05060a', 0.25 * (1 - i / 6)); g.lineWidth = 1.6; g.strokeRect(B + i * 1.5, B + i * 1.5, s - 2 * (B + i * 1.5), s - 2 * (B + i * 1.5)); }
  const m = mask(s, s, mg => {
    const ring = new Path2D(); ring.addPath(rr(A, A, s - 2 * A, s - 2 * A, 7)); ring.addPath(rr(B, B, s - 2 * B, s - 2 * B, 3));
    mg.fill(ring, 'evenodd');
  });
  paintObj(g, m, PAL.pewter, rnd, { d: 1.2, outline: 1, shadow: 0.5, mottleAmt: 0.3, lit: 0.55, glints: 0, period: s - 64, form: 0.25, mott: ['#7a7e86', '#959aa2', '#6a6e76'] });
  g.strokeStyle = rgba('#14151a', 0.85); g.lineWidth = 1.2; g.beginPath(); g.roundRect(B - 0.6, B - 0.6, s - 2 * B + 1.2, s - 2 * B + 1.2, 3); g.stroke();
} });

// Recessed edit box (name / code inputs, keypad).
register('ui_editbox', { size: 64, family: F, alpha: true, note: '9-slice 16; sunken input box', paint(g, s, rnd) {
  g.fillStyle = '#07070a'; g.beginPath(); g.roundRect(2, 2, s - 4, s - 4, 5); g.fill();
  for (let i = 0; i < 6; i++) { g.strokeStyle = rgba('#000', 0.3 * (1 - i / 6)); g.lineWidth = 1.5; g.beginPath(); g.roundRect(4 + i, 4 + i, s - 8 - 2 * i, s - 8 - 2 * i, 4); g.stroke(); }
  const m = mask(s, s, mg => { const ring = new Path2D(); ring.addPath(rr(1, 1, s - 2, s - 2, 6)); ring.addPath(rr(5, 5, s - 10, s - 10, 4)); mg.fill(ring, 'evenodd'); });
  emboss(g, m, PAL.iron, rnd, { d: -1.2, outline: 0.6, shadow: 0, mottleAmt: 0.15, glints: 0, hiAlpha: 0.7 });
} });

function button(g, w, h, rnd, body, rimPal) {
  const [b, bg] = layer(w, h);
  const gr = bg.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, body.light); gr.addColorStop(0.42, body.mid); gr.addColorStop(1, body.dark);
  bg.fillStyle = gr; bg.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) blob(bg, rnd() * w, rnd() * h, range(rnd, 6, 22), range(rnd, 3, 8), 0, pick(rnd, [body.low, body.light, body.mid]), 0.25, 0.1);
  blob(bg, w * 0.42, h * 0.22, w * 0.5, h * 0.18, 0, '#ffffff', 0.18, 0.2);   // painted gloss on the upper third
  bg.globalCompositeOperation = 'destination-in';
  bg.fillStyle = '#fff'; bg.beginPath(); bg.roundRect(5, 5, w - 10, h - 10, 4); bg.fill();
  g.drawImage(b, 0, 0);
  g.save(); g.beginPath(); g.roundRect(5, 5, w - 10, h - 10, 4); g.clip();
  g.fillStyle = rgba(body.dark, 0.55); g.fillRect(0, h - 10, w, 6);
  g.fillStyle = rgba(body.hi, 0.35); g.fillRect(0, 5, w, 2);
  g.restore();
  const m = mask(w, h, mg => { const ring = new Path2D(); ring.addPath(rr(1.5, 1.5, w - 3, h - 3, 7)); ring.addPath(rr(5, 5, w - 10, h - 10, 4)); mg.fill(ring, 'evenodd'); });
  emboss(g, m, rimPal, rnd, { d: 1.2, outline: 0.8, shadow: 0, mottleAmt: 0.25, glints: 3 });
}
register('ui_btn_red', { w: 128, h: 40, family: F, alpha: true, note: '9-slice 14; WoW red panel button', paint(g, w, rnd, h) { button(g, w, h, rnd, PAL.red, PAL.gold); } });
register('ui_btn_stone', { w: 128, h: 40, family: F, alpha: true, note: '9-slice 14; secondary button', paint(g, w, rnd, h) { button(g, w, h, rnd, PAL.slate, PAL.silver); } });

// ---- ornaments -----------------------------------------------------------------------------

// Horizontal gold divider: a central lozenge with a ruby, scrolls, tapering rules.
register('ui_filigree', { w: 512, h: 64, family: F, alpha: true, note: 'divider under headings', paint(g, w, rnd, h) {
  const cx = w / 2, cy = h / 2;
  const m = mask(w, h, mg => {
    for (const sx of [1, -1]) {
      mg.save(); mg.translate(cx, cy); mg.scale(sx, 1);
      stroke(mg, [[16, 0], [90, -1], [170, 0], [236, 0]], 5, 0.8, '#fff');
      curl(mg, 40, -9, 11, Math.PI * 0.6, 0.85, 4.5, 1);
      curl(mg, 40, 9, 11, -Math.PI * 0.6, 0.85, 4.5, -1);
      curl(mg, 92, -6, 7, Math.PI * 0.7, 0.8, 3.2, 1);
      curl(mg, 92, 6, 7, -Math.PI * 0.7, 0.8, 3.2, -1);
      mg.beginPath(); mg.arc(132, 0, 3.2, 0, Math.PI * 2); mg.fill();
      mg.restore();
    }
    mg.beginPath(); mg.moveTo(cx, cy - 18); mg.lineTo(cx + 20, cy); mg.lineTo(cx, cy + 18); mg.lineTo(cx - 20, cy); mg.closePath(); mg.fill();
  });
  paintObj(g, m, PAL.antique, rnd, { d: 1.6, outline: 1, shadow: 0.7, mottleAmt: 0.4, glints: 4, mott: PAL.antique.mott, bbox: [cx - 240, cy - 20, 480, 40], form: 0.4 });
  gem(g, cx, cy, 6.5, '#a8231b', 1.5);
} });

// HUD bar end cap: a gold wing of separate feathers (a nod to the gryphons at the
// ends of WoW's action bar), riveted into a heavy clamp. Points left; CSS mirrors it.
register('ui_endcap', { w: 160, h: 128, family: F, alpha: true, note: 'HUD end cap; points left, mirrored in CSS', paint(g, w, rnd, h) {
  const rx = w - 22, ry = h * 0.58;
  const feathers = [];
  const LEN = [1, 0.84, 0.94, 0.7, 0.8, 0.6], BEND = [0.26, 0.36, 0.2, 0.32, 0.4, 0.24];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI + 0.44 - i * 0.2 + range(rnd, -0.03, 0.03), L = 116 * LEN[i], bend = BEND[i], pts = [];
    for (let k = 0; k <= 8; k++) { const t = k / 8; pts.push([rx + Math.cos(a + t * bend) * L * t, ry + Math.sin(a + t * bend) * L * t * 0.9 + t * t * (6 + i * 2)]); }
    feathers.push({ pts, w0: (25 - i * 1.6) * range(rnd, 0.9, 1.08) });
  }
  // lowest (longest) feather first, so each one above casts its groove on the one below
  for (const f of feathers) {
    const m = mask(w, h, mg => stroke(mg, f.pts, f.w0, 3.5, '#fff'));
    const gap = mask(w, h, mg => stroke(mg, f.pts, f.w0 + 3.5, 5, '#fff'));
    g.save(); g.globalAlpha = 0.85; g.drawImage(tint(gap, '#1a0e04'), 0.8, 1.6); g.restore();          // the dark gap under it
    paintObj(g, m, PAL.antique, rnd, { d: 1.8, outline: 1, shadow: 0.7, mottleAmt: 0.4, lit: 0.95, glints: 2, mott: PAL.antique.mott, form: 0.5 });
    // a lit upper edge, the quill and the barbs
    const up = f.pts.slice(1, 8).map(([x, y], k) => { const [x1, y1] = f.pts[Math.min(8, k + 2)], [x0, y0] = f.pts[k], dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1; return [x - dy / l * f.w0 * 0.36 * (1 - k / 9), y + dx / l * f.w0 * 0.36 * (1 - k / 9)]; });
    stroke(g, up, 1.6, 0.6, '#f3d06a', 0.65);
    stroke(g, f.pts.slice(1, 7).map(([x, y]) => [x, y - 1]), 1.6, 0.6, '#3a2410', 0.7);
    for (let k = 1; k < 7; k++) {
      const [x0, y0] = f.pts[k], [x1, y1] = f.pts[k + 1], dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1;
      const nx = -dy / l, ny = dx / l, ww = f.w0 * (1 - k / 9) * 0.42;
      stroke(g, [[x0 + nx * 1.5, y0 + ny * 1.5], [x0 + nx * ww + dx * 0.4, y0 + ny * ww + dy * 0.4]], 1, 0.5, '#3a2410', 0.45);
      stroke(g, [[x0 - nx * 1.5, y0 - ny * 1.5], [x0 - nx * ww + dx * 0.4, y0 - ny * ww + dy * 0.4]], 1, 0.5, '#f3d06a', 0.35);
    }
  }
  // the clamp where the wing meets the bar: a heavy riveted collar
  const clamp = mask(w, h, mg => { mg.beginPath(); mg.roundRect(rx - 12, ry - 30, 30, 66, 6); mg.fill(); mg.beginPath(); mg.ellipse(rx - 10, ry + 3, 13, 20, 0, 0, Math.PI * 2); mg.fill(); });
  paintObj(g, clamp, PAL.antique, rnd, { d: 2.2, outline: 1.2, shadow: 0.8, mottleAmt: 0.45, glints: 3, mott: PAL.antique.mott, bbox: [rx - 24, ry - 30, 42, 66], form: 0.7 });
  for (const y of [ry - 22, ry + 28]) { stroke(g, [[rx - 10, y], [rx + 16, y]], 1.4, 1.4, '#24140a', 0.7); stroke(g, [[rx - 10, y + 1.4], [rx + 16, y + 1.4]], 1, 1, '#f3d06a', 0.4); }
  for (const y of [ry - 14, ry + 20]) rivet(g, rx + 9, y, 2.8);
  gem(g, rx - 10, ry + 3, 7.5, '#23559e', 2.2);
} });

// Red wax seal (the receipt is official).
register('ui_seal', { size: 96, family: F, alpha: true, note: 'wax seal', paint(g, s, rnd) {
  const m = mask(s, s, mg => {
    mg.beginPath();
    for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2, r = 36 + Math.sin(i * 2.7) * 3 + range(rnd, -2, 2); mg.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r); }
    mg.closePath(); mg.fill();
  });
  paintObj(g, m, PAL.red, rnd, { d: 2.5, outline: 1, shadow: 0.6, mottleAmt: 0.4, glints: 3, form: 0.8 });
  const c = mask(s, s, mg => { mg.lineWidth = 4; mg.beginPath(); mg.arc(s / 2, s / 2, 24, 0, Math.PI * 2); mg.stroke(); });
  g.drawImage(rim(c, -1.5, -1.5, '#ff9c7c', 0.6), 0, 0); g.drawImage(rim(c, 1.5, 1.5, '#3a0603', 0.6), 0, 0);
  g.save(); g.font = 'bold 34px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,170,140,0.55)'; g.fillText('$', s / 2 - 1, s / 2 - 1);
  g.fillStyle = 'rgba(50,6,3,0.7)'; g.fillText('$', s / 2 + 1, s / 2 + 1);
  g.fillStyle = '#8e1f12'; g.fillText('$', s / 2, s / 2);
  g.restore();
} });

// ---- icons (64px, painted objects) --------------------------------------------------------

// A cut-out painted freely on its own layer, finished like the other objects: a soft
// cast shadow down-right, a dark 1px outline, then the painting.
function cutout(g, L, { outline = 1, shadow = 0.5, line = '#1d1004' } = {}) {
  const w = L.width, h = L.height;
  if (shadow > 0) { g.save(); g.filter = 'blur(1.5px)'; g.globalAlpha = shadow; g.drawImage(tint(L, '#140c10'), 1.2, 1.8); g.restore(); }
  const o = tint(L, line, 0.9);
  for (let a = 0; a < 8; a++) g.drawImage(o, Math.cos(a * Math.PI / 4) * outline, Math.sin(a * Math.PI / 4) * outline);
  g.drawImage(L, 0, 0);
}
// A gold coin lying flat: a reeded edge band, a face lit from the upper left, a stamped rim.
function coinFlat(g, x, y, rx, ry, rnd) {
  const th = ry * 0.75;
  g.save();
  const eg = g.createLinearGradient(x - rx, 0, x + rx, 0);
  eg.addColorStop(0, '#e8b444'); eg.addColorStop(0.35, '#b07d2c'); eg.addColorStop(1, '#5a3410');
  g.fillStyle = eg; g.beginPath(); g.ellipse(x, y + th, rx, ry, 0, 0, Math.PI); g.lineTo(x - rx, y); g.ellipse(x, y, rx, ry, 0, Math.PI, 0, true); g.closePath(); g.fill();
  g.beginPath(); g.ellipse(x, y + th, rx, ry, 0, 0, Math.PI); g.lineTo(x - rx, y); g.ellipse(x, y, rx, ry, 0, Math.PI, 0, true); g.closePath(); g.clip();
  for (let u = -rx + 1.5; u < rx; u += 2.1) g.fillRect(x + u, y, 0.8, th + ry), g.fillStyle = 'rgba(60,34,8,0.45)';
  g.restore();
  const fg = g.createRadialGradient(x - rx * 0.45, y - ry * 0.5, 1, x, y, rx * 1.1);
  fg.addColorStop(0, '#fff0b0'); fg.addColorStop(0.35, '#f0c45a'); fg.addColorStop(1, '#a8742a');
  g.fillStyle = fg; g.beginPath(); g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); g.fill();
  g.strokeStyle = 'rgba(110,70,20,0.85)'; g.lineWidth = 1; g.beginPath(); g.ellipse(x, y, rx - 2.2, ry - 0.9, 0, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = 'rgba(255,240,190,0.6)'; g.lineWidth = 0.8; g.beginPath(); g.ellipse(x + 0.5, y + 0.4, rx - 2.2, ry - 0.9, 0, Math.PI * 0.1, Math.PI * 0.9); g.stroke();
  blob(g, x - rx * 0.4, y - ry * 0.3, rx * 0.3, ry * 0.3, 0, '#fffbe8', 0.8, 0.5);
}

function icon(name, note, fn) { register(`ui_ico_${name}`, { size: 64, family: F, alpha: true, note, paint(g, s, rnd) { fn(g, s, rnd); } }); }
const obj = (g, rnd, pal, fn, o = {}) => paintObj(g, mask(64, 64, fn), pal, rnd, { d: 1.5, outline: 1.1, shadow: 0.55, glints: 2, ...o });

icon('crown', 'party leader', (g, s, rnd) => {
  obj(g, rnd, PAL.gold, mg => {
    mg.beginPath(); mg.moveTo(12, 48); mg.lineTo(9, 20); mg.lineTo(22, 32); mg.lineTo(32, 13); mg.lineTo(42, 32); mg.lineTo(55, 20); mg.lineTo(52, 48); mg.closePath(); mg.fill();
    mg.fillRect(11, 44, 42, 9);
    for (const [x, y] of [[9, 18], [32, 11], [55, 18]]) { mg.beginPath(); mg.arc(x, y, 4, 0, Math.PI * 2); mg.fill(); }
  }, { d: 1.8, bbox: [8, 8, 48, 46] });
  stroke(g, [[12, 44.5], [52, 44.5]], 1.2, 1.2, '#4b2e0c', 0.6);
  gem(g, 32, 48.5, 3.6, '#2c62b5'); gem(g, 20, 48.5, 2.6, '#a8231b'); gem(g, 44, 48.5, 2.6, '#a8231b');
});

icon('coin', 'money: a stack of gold coins, one leaning on it', (g, s, rnd) => {
  const [L, lg] = layer(s, s);
  for (let i = 0; i < 4; i++) coinFlat(lg, 25 + range(rnd, -1.6, 1.6), 50 - i * 6.2, 17, 6.4, rnd);
  // the leaning coin, face on: stamped rim, a crown pressed into it, specular dabs
  lg.save(); lg.translate(43, 33); lg.rotate(0.22);
  lg.fillStyle = '#6a4212'; lg.beginPath(); lg.ellipse(2.2, 0.8, 13, 15, 0, 0, Math.PI * 2); lg.fill();
  const fg = lg.createRadialGradient(-5, -6, 1, 0, 0, 16);
  fg.addColorStop(0, '#fff2b8'); fg.addColorStop(0.4, '#f0c45a'); fg.addColorStop(1, '#9a6624');
  lg.fillStyle = fg; lg.beginPath(); lg.ellipse(0, 0, 13, 15, 0, 0, Math.PI * 2); lg.fill();
  lg.strokeStyle = 'rgba(100,62,16,0.9)'; lg.lineWidth = 1.3; lg.beginPath(); lg.ellipse(0, 0, 10.4, 12.2, 0, 0, Math.PI * 2); lg.stroke();
  lg.strokeStyle = 'rgba(255,240,190,0.7)'; lg.lineWidth = 0.9; lg.beginPath(); lg.ellipse(0.7, 0.7, 10.4, 12.2, 0, Math.PI * 0.05, Math.PI * 0.75); lg.stroke();
  for (let k = 0; k < 28; k++) { const t = k / 28 * Math.PI * 2; lg.fillStyle = 'rgba(110,70,20,0.55)'; lg.fillRect(Math.cos(t) * 12, Math.sin(t) * 14, 0.9, 0.9); }
  const crown = new Path2D('M-6 5 L-7 -4 L-3 0 L0 -6 L3 0 L7 -4 L6 5 Z');
  lg.save(); lg.translate(0.8, 0.8); lg.fillStyle = 'rgba(255,236,170,0.6)'; lg.fill(crown); lg.restore();
  lg.fillStyle = '#9a6420'; lg.fill(crown);
  blob(lg, -5, -7, 3.6, 2.2, -0.6, '#fffbe8', 0.9, 0.5); blob(lg, 6, 8, 2, 1.2, -0.6, '#fff2c0', 0.5, 0.4);
  lg.restore();
  cutout(g, L, { outline: 1, shadow: 0.55 });
});

icon('hourglass', 'clock', (g, s, rnd) => {
  g.save();
  const glass = new Path2D('M20 14 C20 26 30 28 30 32 C30 36 20 38 20 50 L44 50 C44 38 34 36 34 32 C34 28 44 26 44 14 Z');
  g.fillStyle = 'rgba(190,220,235,0.55)'; g.fill(glass);
  g.clip(glass);
  g.fillStyle = '#e1b65a'; g.beginPath(); g.moveTo(20, 50); g.lineTo(44, 50); g.lineTo(38, 41); g.quadraticCurveTo(32, 36, 26, 41); g.closePath(); g.fill();
  g.fillStyle = '#e8c06a'; g.beginPath(); g.moveTo(24, 22); g.lineTo(40, 22); g.quadraticCurveTo(34, 29, 32, 31); g.quadraticCurveTo(30, 29, 24, 22); g.fill();
  g.fillStyle = '#d9a94a'; g.fillRect(31.3, 30, 1.4, 14);
  blob(g, 25, 22, 3, 8, 0.2, '#ffffff', 0.55, 0.4);
  g.restore();
  g.strokeStyle = 'rgba(30,40,50,0.7)'; g.lineWidth = 1.2; g.stroke(glass);
  obj(g, rnd, PAL.wood, mg => { mg.fillRect(13, 8, 38, 7); mg.fillRect(13, 49, 38, 7); mg.fillRect(15, 14, 3.5, 36); mg.fillRect(45.5, 14, 3.5, 36); }, { d: 1.4, bbox: [13, 8, 38, 48] });
});

icon('scroll', 'payment due', (g, s, rnd) => {
  obj(g, rnd, { ...PAL.bone, light: '#f3e2b8', mid: '#dcc28e', low: '#a98c5c' }, mg => { mg.fillRect(16, 12, 32, 40); }, { glints: 0, bbox: [16, 12, 32, 40] });
  for (let i = 0; i < 5; i++) stroke(g, [[21, 19 + i * 6], [21 + range(rnd, 14, 22), 19 + i * 6 + range(rnd, -0.6, 0.6)]], 1.4, 1, '#5b4128', 0.6);
  obj(g, rnd, { ...PAL.bone, light: '#efdcae', mid: '#cdb07a', low: '#8c7048' }, mg => { mg.beginPath(); mg.roundRect(11, 7, 42, 8, 4); mg.fill(); mg.beginPath(); mg.roundRect(11, 49, 42, 8, 4); mg.fill(); }, { glints: 1, bbox: [11, 7, 42, 50] });
  obj(g, rnd, PAL.red, mg => { mg.beginPath(); mg.arc(42, 42, 7, 0, Math.PI * 2); mg.fill(); }, { d: 1.4, glints: 1, bbox: [35, 35, 14, 14] });
});

icon('hook', 'repo strikes: the tow hook', (g, s, rnd) => {
  obj(g, rnd, PAL.iron, mg => {
    mg.lineWidth = 8;
    mg.beginPath(); mg.moveTo(34, 18); mg.lineTo(34, 36); mg.arc(25, 38, 9, 0, Math.PI, false); mg.stroke();
    mg.beginPath(); mg.moveTo(16, 38); mg.lineTo(11, 31); mg.lineTo(20, 33); mg.closePath(); mg.fill();
    mg.lineWidth = 4.5; mg.beginPath(); mg.ellipse(34, 11, 4.5, 6.5, 0, 0, Math.PI * 2); mg.stroke();
  }, { d: 1.6, glints: 3, bbox: [10, 4, 30, 48] });
  for (let i = 0; i < 6; i++) blob(g, range(rnd, 18, 38), range(rnd, 24, 46), range(rnd, 1.5, 3), range(rnd, 1, 2), 0, '#7a3a14', 0.4, 0.3);
});

icon('key', 'room code', (g, s, rnd) => {
  obj(g, rnd, PAL.gold, mg => {
    mg.lineWidth = 6; mg.beginPath(); mg.arc(20, 22, 9, 0, Math.PI * 2); mg.stroke();
    mg.save(); mg.translate(20, 22); mg.rotate(0.75);
    mg.fillRect(8, -3, 34, 6); mg.fillRect(32, 2, 4, 8); mg.fillRect(38, 2, 4, 6);
    mg.restore();
  }, { d: 1.6, bbox: [8, 10, 46, 46] });
});

// the room / invite chip: an arched oak door in a stone surround, iron straps, a brass ring
// pull, left ajar so warm light spills down its edge ("the door's open, come join")
icon('door', 'room invite: an arched oak door, ajar', (g, s, rnd) => {
  const arch = (mg, x, y, w, h) => { mg.beginPath(); mg.moveTo(x, y + h); mg.lineTo(x, y + w / 2); mg.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0); mg.lineTo(x + w, y + h); mg.closePath(); mg.fill(); };
  // the stone surround, then its joints: voussoirs round the top, coursed blocks down the jambs
  obj(g, rnd, { ...PAL.slate, light: '#8a8f99', mid: '#646a74', low: '#454a53' }, mg => arch(mg, 9, 3, 46, 58), { d: 1.6, glints: 0, bbox: [9, 3, 46, 58] });
  for (let i = 1; i < 6; i++) {
    const a = Math.PI + i / 6 * Math.PI, c = Math.cos(a), sn = Math.sin(a);
    stroke(g, [[32 + c * 16.5, 26 + sn * 16.5], [32 + c * 22.5, 26 + sn * 22.5]], 1.3, 1.1, '#1c1e24', 0.75);
    stroke(g, [[32.8 + c * 16.5, 26.8 + sn * 16.5], [32.8 + c * 22.5, 26.8 + sn * 22.5]], 0.8, 0.6, '#c4c8d0', 0.35);
  }
  for (const [x0, x1, ys] of [[9.5, 16, [34, 43, 52]], [48, 54.5, [38, 47, 56]]]) for (const y of ys) {
    stroke(g, [[x0, y], [x1, y]], 1.2, 1.2, '#1c1e24', 0.7);
    stroke(g, [[x0, y + 1], [x1, y + 1]], 0.7, 0.7, '#c4c8d0', 0.3);
  }
  for (let i = 0; i < 5; i++) blob(g, range(rnd, 11, 53), range(rnd, 6, 58), range(rnd, 2, 4), range(rnd, 1.2, 2.4), rnd() * 3, '#5a7a3a', 0.35, 0.3);   // moss
  // warm light through the gap on the latch side
  const glow = g.createLinearGradient(44, 0, 50, 0);
  glow.addColorStop(0, '#ffe7a0'); glow.addColorStop(1, '#c87a2a');
  g.fillStyle = glow; g.fillRect(44, 18, 4.5, 42);
  blob(g, 47, 40, 7, 16, 0, '#ffd27a', 0.35, 0.1);
  // the door: oak planks, seams with a lit lip, iron straps and rivets, a brass ring pull
  obj(g, rnd, PAL.wood, mg => arch(mg, 15.5, 9.5, 30, 51), { d: 1.4, glints: 0, bbox: [15.5, 9.5, 30, 51] });
  for (const x of [23, 30.5, 38]) {
    const top = 24.5 - Math.sqrt(Math.max(0, 225 - (x - 30.5) ** 2)) + 1.5;
    stroke(g, [[x, top], [x + range(rnd, -0.3, 0.3), 59.5]], 1.3, 1.3, '#21130a', 0.75);
    stroke(g, [[x + 1.1, top + 1], [x + 1.1, 59]], 0.7, 0.7, '#d9a86a', 0.4);
  }
  for (let i = 0; i < 7; i++) { const x = range(rnd, 18, 43), y = range(rnd, 14, 56); stroke(g, [[x, y], [x + range(rnd, -0.5, 0.5), y + range(rnd, 3, 7)]], 0.6, 0.4, '#3a2210', 0.45); }   // grain
  obj(g, rnd, PAL.iron, mg => { mg.fillRect(15, 21, 26, 4.5); mg.fillRect(15, 46, 26, 4.5); mg.beginPath(); mg.arc(41, 23.25, 3.2, 0, Math.PI * 2); mg.arc(41, 48.25, 3.2, 0, Math.PI * 2); mg.fill(); }, { d: 1, outline: 0.8, shadow: 0.45, glints: 1, bbox: [15, 20, 30, 32] });
  for (const y of [23.25, 48.25]) for (const x of [19, 27, 35]) rivet(g, x, y, 1.15, PAL.iron);
  obj(g, rnd, PAL.brass, mg => { mg.lineWidth = 2.4; mg.beginPath(); mg.arc(38.5, 38, 3.8, 0, Math.PI * 2); mg.stroke(); }, { d: 0.9, outline: 0.8, shadow: 0.5, glints: 1, bbox: [34, 33, 9, 10] });
  rivet(g, 38.5, 33.6, 1.3, PAL.brass);
  // the threshold step
  obj(g, rnd, PAL.slate, mg => { mg.beginPath(); mg.roundRect(7, 58, 50, 5, 1.5); mg.fill(); }, { d: 0.9, outline: 0.8, shadow: 0.3, glints: 0, bbox: [7, 58, 50, 5] });
});

icon('sun', 'day', (g, s, rnd) => {
  obj(g, rnd, PAL.gold, mg => {
    mg.beginPath();
    for (let i = 0; i <= 32; i++) { const a = i / 32 * Math.PI * 2, r = i % 2 ? 15 : 25; mg.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
    mg.closePath(); mg.fill();
  }, { bbox: [7, 7, 50, 50] });
  obj(g, rnd, { ...PAL.gold, light: '#ffe48a', mid: '#f0b437', low: '#c07a1a' }, mg => { mg.beginPath(); mg.arc(32, 32, 12, 0, Math.PI * 2); mg.fill(); }, { d: 1.6, shadow: 0.4, bbox: [20, 20, 24, 24] });
});

// voice: a goblin brass microphone, a round grille head on a short riveted handle (live),
// and the same with a red bar across it (muted)
function micro(g, rnd) {
  // handle, collar and foot
  obj(g, rnd, PAL.brass, mg => { mg.beginPath(); mg.roundRect(27, 34, 10, 20, 3); mg.fill(); mg.beginPath(); mg.roundRect(19, 54, 26, 6, 3); mg.fill(); }, { d: 1.5, glints: 1, bbox: [19, 34, 26, 26] });
  stroke(g, [[29, 37], [29, 52]], 1.2, 1, '#fff0b8', 0.55);
  for (const y of [38, 49]) rivet(g, 34.5, y, 1.5, PAL.brass);
  ellipse(g, 32, 44, 2.2, 2.2, 0, '#7a1a10', 1); ellipse(g, 31.4, 43.4, 0.8, 0.8, 0, '#ff9a7a', 0.9);
  // the grille: a dark ball with brass mesh, shaded like a sphere
  const head = new Path2D(); head.arc(32, 21, 14, 0, Math.PI * 2);
  g.save(); g.clip(head);
  g.fillStyle = '#1e140a'; g.fillRect(16, 5, 32, 32);
  g.strokeStyle = 'rgba(214,170,80,0.85)'; g.lineWidth = 1;
  for (let k = -30; k < 30; k += 3.2) { g.beginPath(); g.moveTo(18 + k, 5); g.lineTo(18 + k + 30, 37); g.stroke(); g.beginPath(); g.moveTo(46 - k, 5); g.lineTo(46 - k - 30, 37); g.stroke(); }
  const sh = g.createRadialGradient(26, 15, 2, 32, 21, 15);
  sh.addColorStop(0, 'rgba(255,240,190,0.45)'); sh.addColorStop(0.45, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(10,6,20,0.7)');
  g.fillStyle = sh; g.fillRect(16, 5, 32, 32);
  g.restore();
  // a brass band round its middle, the outline
  const band = mask(64, 64, mg => { mg.lineWidth = 4; mg.beginPath(); mg.ellipse(32, 23, 14.5, 4, 0, 0, Math.PI); mg.stroke(); mg.beginPath(); mg.roundRect(28, 32, 8, 4, 1.5); mg.fill(); });
  paintObj(g, band, PAL.brass, rnd, { d: 1, outline: 0.8, shadow: 0.4, glints: 1, bbox: [17, 19, 30, 17] });
  g.strokeStyle = 'rgba(29,16,4,0.9)'; g.lineWidth = 1.4; g.stroke(head);
  blob(g, 26, 14, 4, 2.4, -0.6, '#fffbe8', 0.55, 0.5);
}
icon('mic', 'voice: live (a goblin brass microphone)', (g, s, rnd) => { micro(g, rnd); });
icon('micoff', 'voice: muted (the microphone, barred in red)', (g, s, rnd) => {
  micro(g, rnd);
  obj(g, rnd, PAL.red, mg => { mg.lineWidth = 7; mg.lineCap = 'round'; mg.beginPath(); mg.moveTo(12, 10); mg.lineTo(52, 54); mg.stroke(); }, { d: 1.4, glints: 1, bbox: [8, 6, 48, 52] });
  stroke(g, [[13, 8.5], [52.5, 51.5]], 1.2, 1.2, '#f3d06a', 0.7);
});

// voice peers: a brass ear-trumpet (listening) and the same horn with a leather strap tied over the bell (muted)
function hornShape(mg) {
  mg.beginPath();
  mg.moveTo(6, 44); mg.lineTo(14, 40);
  mg.bezierCurveTo(26, 36, 36, 26, 46, 10);
  mg.lineTo(56, 18); mg.lineTo(58, 44);
  mg.bezierCurveTo(44, 46, 30, 48, 14, 47);
  mg.lineTo(6, 49); mg.closePath(); mg.fill();
  mg.beginPath(); mg.ellipse(53, 30, 7, 18, -0.12, 0, Math.PI * 2); mg.fill();
}
function horn(g, rnd) {
  obj(g, rnd, PAL.brass, hornShape, { d: 1.6, bbox: [6, 10, 56, 40] });
  ellipse(g, 53.5, 30.5, 4.4, 14, -0.12, '#2a1606', 1);                 // inside the bell
  blob(g, 52, 24, 2.4, 6, -0.12, '#7a5220', 0.8, 0.5);
  stroke(g, [[50, 14], [47, 26], [48, 40]], 1.4, 0.8, '#fff0b8', 0.7);  // lit lip of the bell
  stroke(g, [[14, 41.5], [30, 37]], 1.4, 1, '#fff0b8', 0.6);
  for (const x of [20, 34]) { const y = x === 20 ? 41 : 36; stroke(g, [[x, y - 2], [x + 1, y + 9]], 1.6, 1.6, '#4a2e10', 0.55); }
}
icon('speaker', 'voice peer (a brass ear-trumpet)', (g, s, rnd) => { horn(g, rnd); });
icon('speakeroff', 'voice peer muted (strap tied over the horn)', (g, s, rnd) => {
  horn(g, rnd);
  obj(g, rnd, PAL.leather, mg => {
    mg.lineWidth = 7; mg.beginPath(); mg.moveTo(42, 8); mg.bezierCurveTo(52, 22, 54, 38, 50, 54); mg.stroke();
    mg.beginPath(); mg.ellipse(54, 30, 6, 8, 0.3, 0, Math.PI * 2); mg.fill();
    mg.lineWidth = 4; mg.beginPath(); mg.moveTo(56, 34); mg.lineTo(62, 46); mg.stroke(); mg.beginPath(); mg.moveTo(55, 35); mg.lineTo(52, 50); mg.stroke();
  }, { d: 1.3, glints: 1, bbox: [40, 8, 22, 46] });
  for (let i = 0; i < 4; i++) ellipse(g, 46 + i * 2.4, 14 + i * 9.5, 0.9, 0.9, 0, '#e8c76a', 0.8);   // stitching
});

icon('walkie', 'walkie-talkie: a riveted brass goblin box with a crystal antenna', (g, s, rnd) => {
  blob(g, 40, 7, 9, 9, 0, '#7fe0ff', 0.45, 0.2);
  obj(g, rnd, PAL.iron, mg => { mg.fillRect(38, 10, 4, 14); }, { d: 1, outline: 0.9, glints: 0, bbox: [38, 10, 4, 14] });
  obj(g, rnd, { hi: '#e8ffff', light: '#9ff0ff', mid: '#3fb6d8', low: '#1e6c96', dark: '#123a5a', line: '#081624' }, mg => { mg.beginPath(); mg.moveTo(40, 0); mg.lineTo(45, 7); mg.lineTo(40, 13); mg.lineTo(35, 7); mg.closePath(); mg.fill(); }, { d: 1, outline: 0.9, glints: 1, bbox: [35, 0, 10, 13] });
  obj(g, rnd, PAL.brass, mg => { mg.beginPath(); mg.roundRect(15, 18, 32, 44, 6); mg.fill(); }, { d: 1.8, bbox: [15, 18, 32, 44] });
  g.fillStyle = '#1e140a'; g.beginPath(); g.roundRect(20, 23, 22, 10, 2); g.fill();
  const sg = g.createLinearGradient(21, 24, 41, 32); sg.addColorStop(0, '#b8ffb0'); sg.addColorStop(1, '#3a9a4a');
  g.fillStyle = sg; g.beginPath(); g.roundRect(21.5, 24.5, 19, 7, 1.5); g.fill();
  blob(g, 26, 26, 4, 1.5, 0, '#ffffff', 0.5, 0.4);
  for (let i = 0; i < 4; i++) { stroke(g, [[21, 39 + i * 4.5], [35, 39 + i * 4.5]], 1.8, 1.8, '#2a1a08', 0.85); stroke(g, [[21, 40.2 + i * 4.5], [35, 40.2 + i * 4.5]], 0.8, 0.8, '#fff0b8', 0.4); }
  ellipse(g, 40.5, 46, 3.4, 3.4, 0, '#6a1a10', 1); ellipse(g, 39.8, 45.2, 1.2, 1.2, 0, '#ff9a7a', 0.9);
  for (const [x, y] of [[18.5, 21.5], [43.5, 21.5], [18.5, 58.5], [43.5, 58.5]]) rivet(g, x, y, 1.6, PAL.brass);
});

icon('gear', 'settings: a riveted iron cog', (g, s, rnd) => {
  obj(g, rnd, PAL.iron, mg => {
    mg.beginPath();
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = i / n * Math.PI * 2;
      for (const [da, r] of [[-0.22, 18], [-0.13, 26], [0.13, 26], [0.22, 18]]) mg.lineTo(32 + Math.cos(a0 + da) * r, 32 + Math.sin(a0 + da) * r);
    }
    mg.closePath(); mg.fill();
    mg.globalCompositeOperation = 'destination-out'; mg.beginPath(); mg.arc(32, 32, 6.5, 0, Math.PI * 2); mg.fill();
  }, { d: 1.6, glints: 2, bbox: [6, 6, 52, 52] });
  g.strokeStyle = rgba('#14161a', 0.6); g.lineWidth = 1.4; g.beginPath(); g.arc(32, 32, 13, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = rgba('#c4c7cd', 0.35); g.lineWidth = 1; g.beginPath(); g.arc(32.8, 32.8, 13, Math.PI * 0.95, Math.PI * 1.6); g.stroke();
  for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; rivet(g, 32 + Math.cos(a) * 9.5, 32 + Math.sin(a) * 9.5, 1.7, PAL.iron); }
  for (let i = 0; i < 9; i++) { const a = rnd() * Math.PI * 2, d = range(rnd, 14, 24); blob(g, 32 + Math.cos(a) * d, 32 + Math.sin(a) * d, range(rnd, 1.5, 3.5), range(rnd, 1, 2.2), a, pick(rnd, ['#7a3a14', '#9a5420', '#5a2a10']), 0.55, 0.35); }
});

icon('close', 'close / leave', (g, s, rnd) => {
  obj(g, rnd, PAL.gold, mg => { mg.beginPath(); mg.roundRect(8, 8, 48, 48, 9); mg.fill(); }, { d: 1.4, bbox: [8, 8, 48, 48] });
  const inner = mask(s, s, mg => { mg.beginPath(); mg.roundRect(13, 13, 38, 38, 6); mg.fill(); });
  emboss(g, inner, PAL.red, rnd, { d: -1.4, outline: 0, shadow: 0, glints: 0 });
  obj(g, rnd, PAL.gold, mg => { mg.lineWidth = 6; mg.beginPath(); mg.moveTo(22, 22); mg.lineTo(42, 42); mg.moveTo(42, 22); mg.lineTo(22, 42); mg.stroke(); }, { d: 1.2, outline: 1, shadow: 0.5, glints: 1, bbox: [19, 19, 26, 26] });
});

icon('ping', 'map ping: a red-and-gold pennant on a pole', (g, s, rnd) => {
  blob(g, 34, 26, 26, 22, 0, '#ffd34a', 0.3, 0.1);
  blob(g, 22, 59, 12, 3.5, 0, '#1a1008', 0.5, 0.3);
  obj(g, rnd, PAL.wood, mg => { mg.fillRect(19.5, 8, 5, 52); }, { d: 1.2, glints: 0, bbox: [19, 8, 6, 52] });
  obj(g, rnd, PAL.cloth, mg => {
    mg.beginPath(); mg.moveTo(24, 10); mg.bezierCurveTo(36, 7, 46, 14, 59, 12); mg.lineTo(48, 23); mg.lineTo(58, 34);
    mg.bezierCurveTo(46, 34, 36, 30, 24, 36); mg.closePath(); mg.fill();
  }, { d: 1.6, glints: 1, bbox: [24, 8, 35, 28] });
  stroke(g, [[24, 12], [36, 9.5], [46, 15], [58, 13]], 1.6, 1.4, '#f3d06a', 0.9);   // gold edging
  stroke(g, [[24, 34], [36, 29.5], [46, 33], [57, 33.5]], 1.6, 1.4, '#c99433', 0.9);
  stroke(g, [[30, 16], [38, 19], [46, 23]], 1, 1, '#4a0804', 0.4);                 // a fold
  obj(g, rnd, PAL.gold, mg => { mg.beginPath(); mg.arc(36, 21, 4.5, 0, Math.PI * 2); mg.fill(); }, { d: 1, outline: 0.8, shadow: 0.3, glints: 1, bbox: [31, 16, 10, 10] });
  obj(g, rnd, PAL.gold, mg => { mg.beginPath(); mg.arc(22, 6.5, 4, 0, Math.PI * 2); mg.fill(); }, { d: 1, outline: 0.9, glints: 1, bbox: [18, 2, 8, 9] });
});

icon('skull', 'knocked out', (g, s, rnd) => {
  obj(g, rnd, PAL.bone, mg => { mg.beginPath(); mg.arc(32, 27, 18, 0, Math.PI * 2); mg.fill(); mg.beginPath(); mg.roundRect(22, 36, 20, 16, 4); mg.fill(); }, { d: 1.8, bbox: [14, 9, 36, 43] });
  for (const x of [25, 39]) { ellipse(g, x, 29, 5, 5.5, 0, '#2a1f18', 0.95); ellipse(g, x - 1, 28, 2, 2, 0, '#4a3a2e', 0.6); }
  g.fillStyle = '#2a1f18'; g.beginPath(); g.moveTo(32, 34); g.lineTo(29, 40); g.lineTo(35, 40); g.closePath(); g.fill();
  for (const x of [27, 32, 37]) stroke(g, [[x, 45], [x, 51]], 1.5, 1.5, '#3a2e24', 0.8);
});

icon('bolt', 'stamina: a winged leather boot', (g, s, rnd) => {
  // a little gold wing at the heel, feathers fanning back
  for (let i = 0; i < 3; i++) obj(g, rnd, PAL.antique, mg => { const a = -2.2 - i * 0.32, L = 22 - i * 4; stroke(mg, [[22, 26 + i * 2], [22 + Math.cos(a) * L * 0.5, 26 + i * 2 + Math.sin(a) * L * 0.5 - 2], [22 + Math.cos(a) * L, 26 + i * 2 + Math.sin(a) * L]], 7 - i, 2, '#fff'); }, { d: 1.2, glints: 1, mott: PAL.antique.mott, bbox: [4, 4, 22, 26] });
  // the boot: a tall shaft, a turned-down cuff, the foot pointing right
  obj(g, rnd, PAL.leather, mg => { mg.beginPath(); mg.moveTo(22, 12); mg.lineTo(38, 12); mg.lineTo(39, 38); mg.quadraticCurveTo(52, 40, 58, 48); mg.lineTo(58, 54); mg.lineTo(20, 54); mg.lineTo(21, 40); mg.closePath(); mg.fill(); }, { d: 1.6, glints: 1, bbox: [20, 12, 38, 42] });
  obj(g, rnd, { ...PAL.leather, light: '#a8703c', mid: '#7a4a24' }, mg => { mg.beginPath(); mg.roundRect(19, 9, 22, 9, 3); mg.fill(); }, { d: 1.3, glints: 1, bbox: [19, 9, 22, 9] });
  g.fillStyle = '#2a1a0e'; g.beginPath(); g.roundRect(19, 52, 40, 5, 2); g.fill();
  stroke(g, [[20, 52.4], [58, 52.4]], 1, 1, '#8a5a32', 0.6);
  obj(g, rnd, PAL.gold, mg => { mg.lineWidth = 2.6; mg.strokeRect(27, 30, 8, 7); }, { d: 0.8, outline: 0.8, shadow: 0.3, glints: 1, bbox: [26, 29, 10, 9] });
  stroke(g, [[22, 40], [38, 41]], 1.4, 1.4, '#2e1a0c', 0.6);
  for (let i = 0; i < 5; i++) ellipse(g, 24 + i * 3.2, 46 + i * 0.4, 0.8, 0.8, 0, '#e2b878', 0.7);   // stitching
});

// ---- slot icons (64px, full bleed) ---------------------------------------------------------
// WoW-style square icons for the HUD and the voice dock: a dark vignette painted in the
// icon's own hue, the object large and a little off-center, a warm rim light from the upper
// left and a cool bounce from the lower right, then a gold hairline and a black inner edge.
const SLOT = {            // [center hue, corner hue, nudge x, nudge y, scale]
  hourglass: ['#3e3424', '#120e08', -2, 0, 1.12], coin: ['#4a3418', '#140c05', -1, -1, 1.16], scroll: ['#4a1e16', '#150806', 0, 0, 1.1],
  hook: ['#2e3640', '#0c0e12', 2, -1, 1.1], key: ['#22383c', '#081012', 2, 1, 1.08], mic: ['#2c3a26', '#0a1008', 0, 2, 0.98],
  micoff: ['#3a2622', '#120808', 0, 2, 0.98], speaker: ['#3a2a44', '#110b16', 3, 0, 0.96], speakeroff: ['#3a2a44', '#110b16', 1, 0, 0.94],
  gear: ['#30353c', '#0c0e10', 0, 0, 1.06], close: ['#4a1610', '#150604', 0, 0, 0.92], walkie: ['#1e3a42', '#071416', 0, 2, 0.96],
  door: ['#2a3442', '#0a0d12', 0, -1, 0.92],
};
function slotFrame(g, s) {
  // warm light from the upper left, a cool bounce from the lower right
  const wl = g.createLinearGradient(0, 0, s * 0.7, s * 0.7);
  wl.addColorStop(0, 'rgba(255,240,192,0.32)'); wl.addColorStop(0.5, 'rgba(255,240,192,0)');
  g.save(); g.globalCompositeOperation = 'soft-light'; g.fillStyle = wl; g.fillRect(0, 0, s, s); g.restore();
  const cl = g.createLinearGradient(s, s, s * 0.35, s * 0.35);
  cl.addColorStop(0, 'rgba(90,106,138,0.3)'); cl.addColorStop(0.6, 'rgba(90,106,138,0)');
  g.save(); g.globalCompositeOperation = 'screen'; g.fillStyle = cl; g.fillRect(0, 0, s, s); g.restore();
  // inner vignette, then the edges: black inside, a gold hairline outside
  for (let i = 0; i < 6; i++) { g.strokeStyle = rgba('#000', 0.22 * (1 - i / 6)); g.lineWidth = 2; g.strokeRect(4 + i * 2, 4 + i * 2, s - 8 - i * 4, s - 8 - i * 4); }
  g.strokeStyle = '#050403'; g.lineWidth = 4; g.strokeRect(3, 3, s - 6, s - 6);
  g.strokeStyle = '#8c5c1b'; g.lineWidth = 2; g.strokeRect(1, 1, s - 2, s - 2);
  g.strokeStyle = rgba('#f3d06a', 0.45); g.lineWidth = 1; g.beginPath(); g.moveTo(1.5, s - 2); g.lineTo(1.5, 1.5); g.lineTo(s - 2, 1.5); g.stroke();
  g.strokeStyle = rgba('#fff0c0', 0.18); g.lineWidth = 1; g.beginPath(); g.moveTo(5.5, s - 6); g.lineTo(5.5, 5.5); g.lineTo(s - 6, 5.5); g.stroke();
}
for (const [name, [c0, c1, dx, dy, k]] of Object.entries(SLOT)) {
  register(`ui_slot_${name}`, { size: 64, family: F, note: `slot icon: ${name}`, paint(g, s, rnd) {
    const bg = g.createRadialGradient(s * 0.42 + dx, s * 0.4 + dy, 2, s / 2, s / 2, s * 0.74);
    bg.addColorStop(0, c0); bg.addColorStop(1, c1);
    g.fillStyle = bg; g.fillRect(0, 0, s, s);
    for (let i = 0; i < 9; i++) blob(g, rnd() * s, rnd() * s, range(rnd, 6, 16), range(rnd, 4, 10), rnd() * 3, pick(rnd, [c0, c1, lightOf(c0, 0.15)]), 0.25, 0.15);
    blob(g, s * 0.44 + dx, s * 0.42 + dy, 22, 20, 0, lightOf(c0, 0.35), 0.4, 0.05);
    const S = s * k;
    g.drawImage(canvasFor(`ui_ico_${name}`), (s - S) / 2 + dx, (s - S) / 2 + dy, S, S);
    slotFrame(g, s);
  } });
}
// the day: a sun coming up over painted hills
register('ui_slot_sun', { size: 64, family: F, note: 'slot icon: the day (sunrise over hills)', paint(g, s, rnd) {
  vgrad(g, s, s, [[0, '#1c3260'], [0.45, '#4a62a0'], [0.7, '#e89a58'], [1, '#f6c27a']]);
  blob(g, 30, 40, 30, 22, 0, '#ffd890', 0.55, 0.05);
  blob(g, 30, 40, 16, 15, 0, '#fff0c0', 0.75, 0.2);
  const sg = g.createRadialGradient(27, 36, 1, 30, 40, 11);
  sg.addColorStop(0, '#fffdf0'); sg.addColorStop(0.6, '#ffe7a0'); sg.addColorStop(1, '#ffc860');
  g.fillStyle = sg; g.beginPath(); g.arc(30, 40, 10.5, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 9; i++) { const a = -Math.PI + (i + 0.5) / 9 * Math.PI; stroke(g, [[30 + Math.cos(a) * 14, 40 + Math.sin(a) * 14], [30 + Math.cos(a) * 27, 40 + Math.sin(a) * 27]], 3.2, 0.6, '#fff0c0', 0.35); }
  blob(g, 48, 14, 12, 4, 0, '#c8b8d0', 0.6, 0.4); blob(g, 46, 12.5, 9, 3, 0, '#ffe8d0', 0.6, 0.4);
  const hill = (pts, c, lit) => { const p = new Path2D(); p.moveTo(0, s); pts.forEach(([x, y]) => p.lineTo(x, y)); p.lineTo(s, s); p.closePath(); g.fillStyle = c; g.fill(p); stroke(g, pts, 1.6, 1.6, lit, 0.7); };
  hill([[0, 46], [10, 42], [22, 45], [34, 43], [46, 40], [58, 44], [64, 43]], '#3a4a6a', '#f0b078');
  hill([[0, 52], [14, 48], [28, 51], [40, 49], [52, 52], [64, 49]], '#25402a', '#c8b060');
  for (let i = 0; i < 6; i++) { const x = range(rnd, 4, 60), y = 50 + range(rnd, -1, 1); stroke(g, [[x, y + 2], [x, y - range(rnd, 4, 7)]], 2.6, 0.5, '#1a2c1c', 0.95); }
  slotFrame(g, s);
} });

// Round gold portrait ring (unit frames): 128px, transparent outside, dark slate inside.
register('ui_ring', { size: 128, family: F, alpha: true, note: 'portrait ring for unit frames', paint(g, s, rnd) {
  const c = s / 2;
  const gr = g.createRadialGradient(c - 10, c - 12, 4, c, c, 48);
  gr.addColorStop(0, '#4a4e58'); gr.addColorStop(1, '#16171b');
  g.fillStyle = gr; g.beginPath(); g.arc(c, c, 48, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 8; i++) { g.strokeStyle = rgba('#000', 0.3 * (1 - i / 8)); g.lineWidth = 2; g.beginPath(); g.arc(c, c, 46 - i * 2, 0, Math.PI * 2); g.stroke(); }
  const m = mask(s, s, mg => {
    const ring = new Path2D(); ring.arc(c, c, 60, 0, Math.PI * 2); ring.arc(c, c, 47, 0, Math.PI * 2, true);
    mg.fill(ring);
    for (const a of [-Math.PI / 2, Math.PI / 2]) { mg.beginPath(); mg.arc(c + Math.cos(a) * 54, c + Math.sin(a) * 54, 8, 0, Math.PI * 2); mg.fill(); }
  });
  paintObj(g, m, PAL.antique, rnd, { d: 2.2, outline: 1.2, shadow: 0.6, glints: 4, mott: PAL.antique.mott, form: 0.6 });
  g.strokeStyle = rgba('#24140a', 0.65); g.lineWidth = 1.4; g.beginPath(); g.arc(c, c, 53.5, 0, Math.PI * 2); g.stroke();
  g.strokeStyle = rgba('#f3d06a', 0.35); g.lineWidth = 1; g.beginPath(); g.arc(c + 1, c + 1, 53.5, Math.PI * 0.8, Math.PI * 1.7); g.stroke();
  for (let i = 0; i < 10; i++) { const a = (i + 0.5) / 10 * Math.PI * 2; if (Math.abs(Math.sin(a)) > 0.9) continue; rivet(g, c + Math.cos(a) * 53.5, c + Math.sin(a) * 53.5, 2.2); }
  for (const a of [-Math.PI / 2, Math.PI / 2]) gem(g, c + Math.cos(a) * 54, c + Math.sin(a) * 54, 4.5, '#23559e', 1.5);
} });

// ---- the title-screen vista ----------------------------------------------------------------

// A jagged polyline from a to b by midpoint displacement (perpendicular offsets).
function jag(rnd, a, b, depth, amp) {
  let pts = [a, b], k = amp;
  for (let d = 0; d < depth; d++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const dx = x1 - x0, dy = y1 - y0, l = Math.hypot(dx, dy) || 1, off = (rnd() - 0.5) * k;
      next.push([(x0 + x1) / 2 - dy / l * off, (y0 + y1) / 2 + dx / l * off], pts[i + 1]);
    }
    pts = next; k *= 0.55;
  }
  return pts;
}
const poly = pts => { const p = new Path2D(); pts.forEach(([x, y], i) => (i ? p.lineTo(x, y) : p.moveTo(x, y))); p.closePath(); return p; };
const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
function along(pts, t) {
  const n = pts.length - 1, f = Math.min(n - 1e-6, Math.max(0, t * n)), i = Math.floor(f);
  return lerp2(pts[i], pts[i + 1], f - i);
}
function vlin(g, x0, y0, x1, y1, stops) {
  const gr = g.createLinearGradient(x0, y0, x1, y1);
  for (const [t, c] of stops) gr.addColorStop(t, c);
  return gr;
}

// A painted peak, lit from the left: a lit face and a shadow face split by a
// jagged ridge, gullies that follow the fall line, a snow cap that runs down
// the gullies.
function peak(g, rnd, o) {
  const { x, y, wl, wr, base, lit, sh, snowLit, snowSh, snow = 0.4, n = 40, gullyLit, gullySh, spur } = o;
  // concave flanks (steep up top, easing out at the foot), a shoulder or two, jagged detail
  const flank = (sign, w) => {
    const N = 9, key = [], sh = rnd() < 0.6 ? range(rnd, 0.25, 0.6) : -1;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      let yy = y + (base - y) * t;
      if (sh > 0 && Math.abs(t - sh) < 0.14) yy -= (base - y) * 0.07 * (1 - Math.abs(t - sh) / 0.14);
      key.push([x + sign * w * Math.pow(t, 1.4) * range(rnd, 0.94, 1.06), yy]);
    }
    key[0] = [x, y]; key[N] = [x + sign * w, base];
    let out = [key[0]];
    for (let i = 0; i < N; i++) out = out.concat(jag(rnd, key[i], key[i + 1], 3, Math.hypot(key[i + 1][0] - key[i][0], key[i + 1][1] - key[i][1]) * 0.4).slice(1));
    return out;
  };
  const left = flank(-1, wl), right = flank(1, wr);
  const re = [x + wr * range(rnd, 0.12, 0.3), base];
  const ridge = jag(rnd, [x, y], re, 5, (base - y) * 0.16);
  const sil = poly([...left.slice().reverse(), ...right.slice(1)]);
  const litFace = poly([...left.slice().reverse(), ...ridge.slice(1)]);
  const shFace = poly([...ridge, ...right.slice().reverse().slice(0, -1)]);
  g.fillStyle = vlin(g, 0, y, 0, base, [[0, sh[0]], [1, sh[1]]]); g.fill(sil);
  g.fillStyle = vlin(g, 0, y, 0, base, [[0, lit[0]], [1, lit[1]]]); g.fill(litFace);
  // gullies and spurs: tapering strokes down the fall line of each face
  const face = (path, edge, lo, hi) => {
    g.save(); g.clip(path);
    const dA = [re[0] - x, re[1] - y], dB = [edge[edge.length - 1][0] - x, edge[edge.length - 1][1] - y];
    for (let i = 0; i < n; i++) {
      const t = range(rnd, 0.03, 0.85), s = Math.pow(rnd(), 0.8);
      const p = lerp2(along(ridge, t), along(edge, t), s);
      const d = lerp2(dA, dB, Math.min(1, s + 0.15));
      const l = Math.hypot(d[0], d[1]) || 1, L = range(rnd, 0.08, 0.3) * (base - y) * (1.2 - t * 0.5);
      const ux = d[0] / l, uy = d[1] / l, wob = range(rnd, -0.25, 0.25);
      const pts = [p, [p[0] + (ux + wob * uy) * L * 0.5, p[1] + (uy - wob * ux) * L * 0.5], [p[0] + ux * L, p[1] + uy * L]];
      const col = rnd() < 0.62 ? lo : hi;
      stroke(g, pts, range(rnd, 2, 6) * (0.6 + s * 0.6), 0.6, col, range(rnd, 0.28, 0.55));
    }
    g.restore();
  };
  face(litFace, left, gullyLit, spur);
  face(shFace, right, gullySh, lit[1]);
  // snow cap with drips down the gullies
  const sl = [];
  const Y = y + (base - y) * snow;
  for (let xx = x - wl - 10; xx <= x + wr + 10; xx += 5) sl.push([xx, Y + Math.sin(xx * 0.11 + y) * 6 + range(rnd, -7, 7) + (rnd() < 0.18 ? range(rnd, 10, 34) : 0)]);
  const cap = poly([[x - wl - 10, y - 40], [x + wr + 10, y - 40], ...sl.reverse()]);
  g.save(); g.clip(sil); g.clip(cap);
  g.fillStyle = snowSh; g.fillRect(x - wl - 10, y - 40, wl + wr + 20, base - y + 40);
  g.restore();
  g.save(); g.clip(litFace); g.clip(cap);
  g.fillStyle = vlin(g, x - wl, y, x, Y, [[0, snowLit], [1, mix(snowLit, lit[0], 0.35)]]); g.fillRect(x - wl - 10, y - 40, wl + wr + 20, base - y + 40);
  g.restore();
  // snow streaks below the line, rock showing through above it
  for (const [path, edge, col] of [[litFace, left, snowLit], [shFace, right, snowSh]]) {
    g.save(); g.clip(path);
    for (let i = 0; i < n * 0.6; i++) {
      const t = range(rnd, snow * 0.7, Math.min(0.95, snow * 1.7)), s = rnd();
      const p = lerp2(along(ridge, t), along(edge, t), s);
      const L = range(rnd, 8, 34) * (base - y) / 200;
      const dx = (edge === left ? -1 : 1) * range(rnd, 0.1, 0.5);
      stroke(g, [p, [p[0] + dx * L * 0.5, p[1] + L * 0.6], [p[0] + dx * L, p[1] + L]], range(rnd, 2, 5), 0.5, col, range(rnd, 0.5, 0.9));
    }
    for (let i = 0; i < n * 0.3; i++) {
      const t = range(rnd, 0.08, snow * 0.9), s = rnd();
      const p = lerp2(along(ridge, t), along(edge, t), s);
      stroke(g, [p, [p[0] + range(rnd, -4, 4), p[1] + range(rnd, 4, 12)]], range(rnd, 1.5, 4), 0.5, edge === left ? gullyLit : gullySh, range(rnd, 0.3, 0.6));
    }
    g.restore();
  }
  // broken horizontal ledges across the bare rock below the cap, each with snow lying on it
  // and a dark rock shadow under its lip
  const ledges = 3 + Math.floor(rnd() * 2);
  for (const [path, edge, sCol, dCol] of [[litFace, left, snowLit, gullyLit], [shFace, right, snowSh, gullySh]]) {
    g.save(); g.clip(path);
    for (let k = 0; k < ledges; k++) {
      const t = snow + 0.07 + (k + range(rnd, 0, 0.6)) / ledges * (0.82 - snow);
      const N = 7;
      for (let i = 0; i < N; i++) {
        if (rnd() < 0.3) continue;
        const s0 = i / N, s1 = (i + range(rnd, 0.55, 1)) / N;
        const p0 = lerp2(along(ridge, t), along(edge, t), s0), p1 = lerp2(along(ridge, t + range(rnd, -0.02, 0.02)), along(edge, t), s1);
        const sag = range(rnd, -2, 3) * (base - y) / 220;
        const pts = [p0, [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2 + sag], p1];
        stroke(g, pts.map(([u, v]) => [u, v + 2.4]), range(rnd, 2.2, 3.6), 1, dCol, 0.75);
        stroke(g, pts, range(rnd, 1.6, 3), 0.8, sCol, 0.92);
      }
    }
    g.restore();
  }
  // a crisp lit edge along the ridge, where the two faces meet
  stroke(g, ridge.slice(0, Math.ceil(ridge.length * 0.6)), 1.6, 0.6, mix(snowLit, '#ffffff', 0.4), 0.55);
  return sil;
}

// A gray mossy rock outcrop, lit from the upper left.
function rockOutcrop(g, rnd, cx, cy, w, h) {
  const pts = [];
  for (let i = 0; i < 14; i++) {
    const a = Math.PI + (i / 13) * Math.PI;              // the top half: left → over → right
    const r = range(rnd, 0.75, 1.08);
    pts.push([cx + Math.cos(a) * w * 0.5 * r, cy + Math.sin(a) * h * r * (i % 3 === 1 ? 0.88 : 1)]);
  }
  pts.push([cx + w * 0.52, cy + h * 0.08], [cx - w * 0.5, cy + h * 0.1]);
  const p = poly(pts);
  blob(g, cx + w * 0.12, cy + h * 0.1, w * 0.62, h * 0.22, 0, '#1e2a16', 0.55, 0.3);
  g.fillStyle = vlin(g, cx - w * 0.4, cy - h, cx + w * 0.3, cy, [[0, '#97918a'], [0.5, '#77746e'], [1, '#4d4a52']]); g.fill(p);
  g.save(); g.clip(p);
  // facets: lit planes up-left, shadowed planes down-right, dark crevices between
  for (let i = 0; i < 9; i++) {
    const fx = cx + range(rnd, -0.45, 0.4) * w, fy = cy - range(rnd, 0.1, 0.9) * h;
    const litSide = fx < cx + w * 0.05;
    blob(g, fx, fy, range(rnd, 0.12, 0.26) * w, range(rnd, 0.1, 0.22) * h, range(rnd, -0.6, 0.6), litSide ? pick(rnd, ['#a9a39a', '#8f8a84']) : pick(rnd, ['#5c5964', '#66626a']), 0.7, 0.7);
  }
  for (let i = 0; i < 5; i++) {
    const x0 = cx + range(rnd, -0.35, 0.35) * w, y0 = cy - range(rnd, 0.3, 0.95) * h;
    const pts2 = [[x0, y0], [x0 + range(rnd, -8, 8), y0 + h * range(rnd, 0.2, 0.4)], [x0 + range(rnd, -10, 14), y0 + h * range(rnd, 0.45, 0.8)]];
    stroke(g, pts2.map(([u, v]) => [u + 1.4, v + 0.6]), 2.2, 0.8, '#b8b2a8', 0.45);
    stroke(g, pts2, range(rnd, 1.8, 3), 0.6, '#2f2c36', 0.75);
  }
  // moss on the tops
  for (let i = 0; i < 26; i++) {
    const a = Math.PI * range(rnd, 1.05, 1.75), d = range(rnd, 0.55, 0.95);
    ellipse(g, cx + Math.cos(a) * w * 0.5 * d, cy + Math.sin(a) * h * d, range(rnd, 3, 8), range(rnd, 2, 4), rnd() * 3, pick(rnd, ['#5f7d2a', '#7d9c3a', '#4b6a24']), 0.85);
  }
  g.fillStyle = vlin(g, 0, cy - h * 0.2, 0, cy + h * 0.1, [[0, 'rgba(40,36,56,0)'], [1, 'rgba(40,36,56,0.45)']]); g.fillRect(cx - w, cy - h, w * 2, h * 1.3);
  g.restore();
  g.strokeStyle = 'rgba(30,24,30,0.55)'; g.lineWidth = 1.2; g.stroke(p);
  for (let i = 0; i < 40; i++) blade(g, cx + range(rnd, -0.55, 0.55) * w, cy + h * range(rnd, 0, 0.14), range(rnd, 6, 16) * (h / 60 + 0.4), range(rnd, -0.5, 0.5), range(rnd, 1.5, 3), pick(rnd, ['#4f7d2a', '#6f9c34', '#9cb447', '#3e6420']), 0.95);
}

// A conifer: tiers of drooping boughs with ragged needle edges; dark core,
// lit needles on the upper left, a cool shadow under each tier. Leans a little.
function conifer(g, rnd, x, y, h, wd, lean) {
  const top = [x + Math.tan(lean) * h, y - h];
  const at = t => lerp2([x, y], top, t);
  blob(g, x + wd * 0.35, y + 2, wd * 0.95, Math.max(4, wd * 0.12), 0, '#162214', 0.5, 0.3);
  stroke(g, [at(0), at(0.32)], wd * 0.13, wd * 0.07, '#3a2a1c');
  stroke(g, [[x - wd * 0.035, y], lerp2([x - wd * 0.03, y], top, 0.3)], wd * 0.035, wd * 0.02, '#7a6248', 0.7);
  const tiers = Math.round(range(rnd, 9, 12));
  const needle = Math.max(1.4, wd * 0.022);
  for (let k = 0; k < tiers; k++) {
    const t = 0.13 + (k / tiers) * 0.84;
    const [cx, cy] = at(t);
    const tw = wd * Math.pow(1 - t, 0.85) * range(rnd, 0.82, 1.12) + wd * 0.05;
    const th = h * 0.1 * range(rnd, 0.85, 1.2);
    const swL = tw * range(rnd, 0.8, 1.15), swR = tw * range(rnd, 0.8, 1.15);
    // the bough mass: a drooping skirt with a zig-zag hem
    const hem = [];
    const N = Math.max(6, Math.round((swL + swR) / (needle * 4)));
    for (let i = 0; i <= N; i++) {
      const u = i / N, xx = cx - swL + (swL + swR) * u, mid = 1 - Math.abs(u - 0.5) * 2;
      hem.push([xx + range(rnd, -1, 1) * needle, cy + th * (0.75 - mid * 0.35) + (i % 2 ? -1 : 1) * th * range(rnd, 0.06, 0.16)]);
    }
    const skirt = poly([[cx, cy - th * 0.55], [cx - swL * 0.55, cy - th * 0.05], ...hem, [cx + swR * 0.55, cy - th * 0.05]]);
    g.fillStyle = '#1c3421'; g.fill(skirt);
    // ragged needles off the hem and flanks
    for (const [hx, hy] of hem) {
      const side = hx < cx ? -1 : 1, L = th * range(rnd, 0.14, 0.26);
      stroke(g, [[hx - side * L * 0.3, hy - L * 0.5], [hx + side * L * 0.5, hy + L * 0.45]], needle * 1.1, 0.5, pick(rnd, ['#14261a', '#1c3421', '#22402a']), 1);
    }
    g.save(); g.clip(skirt);
    blob(g, cx, cy + th * 0.62, (swL + swR) * 0.55, th * 0.22, 0, '#0f1d14', 0.55, 0.3);   // the shade under the bough
    // lit needles upper left, mid-green needles upper right, all following the droop
    const lit = Math.round((swL + swR) / needle * 0.9);
    for (let i = 0; i < lit; i++) {
      const u = rnd(), side = u < 0.62 ? -1 : 1, f = rnd();
      const sx0 = cx + side * f * (side < 0 ? swL : swR) * 0.95, sy0 = cy - th * 0.45 + f * th * 0.6 + range(rnd, -0.1, 0.25) * th;
      const L = th * range(rnd, 0.22, 0.45);
      const col = side < 0 ? pick(rnd, ['#5f8a3e', '#4a7434', '#6f9a44', '#3d6230']) : pick(rnd, ['#2f4f34', '#2a4a30', '#3a5e38']);
      stroke(g, [[sx0, sy0], [sx0 + side * L * 0.45, sy0 + L * 0.8]], needle * range(rnd, 1, 1.6), 0.5, col, side < 0 ? range(rnd, 0.7, 0.95) : 0.7);
    }
    g.restore();
  }
  stroke(g, [at(0.93), at(1.02)], wd * 0.05, 1, '#1f3a24');
  stroke(g, [lerp2(at(0.93), at(1), 0.2), at(1)], wd * 0.02, 0.6, '#5f8a3e', 0.7);
}

// One clump of an oak canopy: a dark underside, mid leaves, a lit crescent upper-left,
// ragged leaf dabs on the silhouette (no blur).
function leafClump(g, rnd, cx, cy, r) {
  const mass = (x, y, rr, cols, n, sq = 0.82) => {
    ellipse(g, x, y, rr * 0.78, rr * 0.7 * sq / 0.82, 0, cols[0], 1);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, d = rr * Math.pow(rnd(), 0.45) * 0.98;
      blob(g, x + Math.cos(a) * d, y + Math.sin(a) * d * sq, range(rnd, 0.05, 0.11) * rr + 3, range(rnd, 0.035, 0.065) * rr + 2, a + range(rnd, -0.6, 0.6), pick(rnd, cols), 1, 0.82);
    }
  };
  mass(cx, cy + r * 0.04, r, ['#1d3214', '#203816', '#182a10', '#24361a'], Math.round(r * 2.6));
  mass(cx - r * 0.07, cy - r * 0.14, r * 0.8, ['#3d6526', '#355a22', '#45702a', '#2f5220', '#2a4a1e'], Math.round(r * 2.2), 0.76);
  mass(cx - r * 0.17, cy - r * 0.27, r * 0.56, ['#4f7d2a', '#5b8a2e', '#46732a', '#3d6526'], Math.round(r * 1.4), 0.7);
  for (let i = 0; i < r * 1.5; i++) {
    const a = range(rnd, -2.8, -0.95), d = r * range(rnd, 0.38, 0.84);
    blob(g, cx - r * 0.1 + Math.cos(a) * d, cy - r * 0.13 + Math.sin(a) * d * 0.78, range(rnd, 0.045, 0.09) * r + 2, range(rnd, 0.03, 0.055) * r + 1.5, a + 1.4 + range(rnd, -0.5, 0.5), pick(rnd, ['#8fae45', '#7da23c', '#9cb447', '#6f9a38', '#86a648']), range(rnd, 0.6, 0.9), 0.82);
  }
  for (let i = 0; i < r * 0.06; i++) {
    const a = range(rnd, -2.4, -1.4), d = r * range(rnd, 0.6, 0.8);
    blob(g, cx - r * 0.1 + Math.cos(a) * d, cy - r * 0.13 + Math.sin(a) * d * 0.78, range(rnd, 2.5, 4.5), range(rnd, 1.5, 2.5), rnd() * 3, '#c4cf6c', 0.8, 0.7);
  }
}

// The RV, about 120px across, coming round the bend toward the viewer: cream and
// orange painted panels, brass trim and rivets, lit from the upper left.
function paintRV(g, rnd, x, y, s = 1) {
  g.save(); g.translate(x, y); g.scale(s, s);
  const P = (px, py) => [px, py];
  // ground shadow falls back and right (sun low on the left)
  blob(g, 70, -8, 82, 13, -0.2, '#1c1410', 0.55, 0.35);
  blob(g, 48, -2, 46, 7, -0.15, '#120c08', 0.6, 0.5);
  const FL = P(0, 0), FR = P(43, -7), TL = P(-2, -58), TR = P(42, -64), RB = P(122, -32), RT = P(121, -79), BT = P(78, -73);
  const front = poly([FL, FR, TR, TL]), side = poly([FR, RB, RT, TR]), roof = poly([TL, TR, RT, BT]);
  const outlineAll = poly([FL, FR, RB, RT, BT, TL]);
  // side: cool shade with a warm bounce at the bottom
  g.fillStyle = vlin(g, 0, -79, 0, -7, [[0, '#cbbb98'], [0.55, '#b3a184'], [1, '#8d7e6a']]); g.fill(side);
  g.save(); g.clip(side);
  // the orange sweep stripe and a brown band under it
  const sweep = (y0, y1, c) => { g.fillStyle = c; g.fill(poly([[40, y0], [124, y0 - 25], [124, y1 - 25], [40, y1]])); };
  sweep(-34, -24, '#a8502a'); sweep(-24, -20, '#6e3a20');
  for (let i = 0; i < 14; i++) blob(g, range(rnd, 45, 120), range(rnd, -75, -12), range(rnd, 6, 16), range(rnd, 3, 7), -0.3, pick(rnd, ['#d8c9a6', '#9c8c74', '#c0ae8e']), 0.35, 0.3);
  // windows: dark glass with a warm sky reflection
  for (const [wx, ww] of [[58, 18], [84, 24]]) {
    const top = -62 - (wx - 43) * 0.19, bot = -44 - (wx - 43) * 0.3;
    const win = poly([[wx, top], [wx + ww, top - ww * 0.19], [wx + ww, bot - ww * 0.3], [wx, bot]]);
    g.fillStyle = '#26303e'; g.fill(win);
    g.save(); g.clip(win); blob(g, wx + ww * 0.3, top + 4, ww * 0.5, 4, -0.2, '#e8c890', 0.55, 0.3); g.restore();
    g.strokeStyle = '#c99433'; g.lineWidth = 1.6; g.stroke(win);
  }
  // door
  const door = poly([[47, -10], [56, -12], [56, -50], [47, -48]]);
  g.strokeStyle = 'rgba(60,40,24,0.7)'; g.lineWidth = 1.2; g.stroke(door);
  ellipse(g, 54.5, -30, 1.2, 1.2, 0, '#e8c76a', 1);
  // riveted brass seam
  stroke(g, [[44, -40], [121, -55]], 1.2, 1.2, '#7a5520', 0.7);
  for (let i = 0; i < 8; i++) { const t = (i + 0.5) / 8; ellipse(g, 44 + 77 * t, -41 - 15 * t, 1.1, 1.1, 0, '#f3d06a', 0.9); }
  g.restore();
  // front: lit, warm cream
  g.fillStyle = vlin(g, -2, -60, 30, 0, [[0, '#fbf1d8'], [0.5, '#ead9b2'], [1, '#c5ae86']]); g.fill(front);
  g.save(); g.clip(front);
  for (let i = 0; i < 10; i++) blob(g, range(rnd, 0, 40), range(rnd, -58, -4), range(rnd, 5, 12), range(rnd, 3, 6), 0, pick(rnd, ['#fff6e0', '#d9c49c']), 0.4, 0.3);
  g.fillStyle = '#c4622a'; g.fill(poly([[-2, -30], [43, -36], [43, -27], [-2, -21]]));
  g.fillStyle = '#7a3c1e'; g.fill(poly([[-2, -21], [43, -27], [43, -24], [-2, -18]]));
  // cab-over shadow, windshield, grille, lamps, bumper
  g.fillStyle = 'rgba(60,40,50,0.35)'; g.fill(poly([[-2, -45], [43, -51], [43, -48], [-2, -42]]));
  const ws = poly([[3, -42], [39, -47], [39, -34], [3, -30]]);
  g.fillStyle = vlin(g, 0, -47, 0, -30, [[0, '#7f9fc0'], [0.5, '#3a4a62'], [1, '#232a3a']]); g.fill(ws);
  g.save(); g.clip(ws); stroke(g, [[8, -32], [20, -46]], 4, 3, '#ffffff', 0.35); stroke(g, [[15, -31], [24, -43]], 2, 1.5, '#ffffff', 0.25); g.restore();
  g.strokeStyle = '#c99433'; g.lineWidth = 2; g.stroke(ws);
  g.fillStyle = '#6e5120'; g.fill(poly([[12, -16], [32, -18.5], [32, -11], [12, -9]]));
  for (let i = 0; i < 4; i++) stroke(g, [[13 + i * 5, -15.5 - i * 0.6], [13 + i * 5, -10 - i * 0.6]], 1.2, 1.2, '#f3d06a', 0.8);
  for (const lx of [5, 38]) { ellipse(g, lx, -14 - lx * 0.07, 3.6, 3.6, 0, '#5a4018', 1); ellipse(g, lx, -14 - lx * 0.07, 2.6, 2.6, 0, '#ffe9a8', 1); blob(g, lx - 0.6, -14.6 - lx * 0.07, 7, 6, 0, '#fff2c0', 0.35, 0.2); }
  g.fillStyle = '#3a3036'; g.fill(poly([[-3, -5], [44, -11], [44, -6], [-3, 0]]));
  stroke(g, [[-3, -5], [44, -11]], 1.2, 1.2, '#9a9098', 0.8);
  g.restore();
  // roof: brightest plane, a canvas-covered rack, a brass stovepipe
  g.fillStyle = vlin(g, 0, -79, 40, -58, [[0, '#fff7e4'], [1, '#e2cfa6']]); g.fill(roof);
  const rack = poly([[16, -66], [40, -69], [86, -77], [62, -74]]);
  g.fillStyle = '#7a6a4a'; g.fill(rack);
  for (let i = 0; i < 5; i++) blob(g, range(rnd, 28, 72), range(rnd, -76, -67), range(rnd, 6, 12), range(rnd, 3, 5), -0.2, pick(rnd, ['#9a8a62', '#5e5038', '#b8a67a']), 0.7, 0.5);
  stroke(g, [[22, -71], [66, -79]], 2.4, 2.4, '#b8a67a', 0.9);
  stroke(g, [[30, -66], [34, -76]], 1.2, 1.2, '#4a3a22', 0.8); stroke(g, [[52, -70], [56, -79]], 1.2, 1.2, '#4a3a22', 0.8);
  stroke(g, [[98, -76], [98, -92]], 5, 4.4, '#8c5c1b'); stroke(g, [[96.8, -76], [96.8, -92]], 1.4, 1.2, '#f3d06a', 0.9);
  ellipse(g, 98, -93, 4, 1.6, 0, '#c99433', 1);
  for (let i = 0; i < 5; i++) blob(g, 99 + i * 5 + range(rnd, -2, 2), -98 - i * 7, 4 + i * 2.4, 3 + i * 1.8, 0, pick(rnd, ['#d9d2c8', '#bdb4ae']), 0.45 - i * 0.06, 0.3);
  // brass trim along the top edges, rivets, a lit edge on the front-top corner
  stroke(g, [TL, TR, RT], 2.4, 2.4, '#8c5c1b', 0.95);
  stroke(g, [[TL[0], TL[1] - 0.8], [TR[0], TR[1] - 0.8]], 1, 1, '#f3d06a', 0.95);
  stroke(g, [FR, TR], 2.2, 2.2, '#8c5c1b', 0.9); stroke(g, [[FR[0] - 0.8, FR[1]], [TR[0] - 0.8, TR[1]]], 0.8, 0.8, '#f3d06a', 0.8);
  for (let i = 0; i < 6; i++) { const p = lerp2(TL, TR, (i + 0.5) / 6); ellipse(g, p[0], p[1] + 2.5, 0.9, 0.9, 0, '#f3d06a', 1); }
  // wheels: dark tyres, brass hubs
  for (const [wx, wy, k] of [[58, -9, 1], [108, -26, 0.85]]) {
    ellipse(g, wx, wy, 7 * k, 9 * k, 0, '#1e1a1c', 1);
    ellipse(g, wx + 0.6, wy, 3.4 * k, 4.6 * k, 0, '#a8742a', 1);
    ellipse(g, wx - 0.3, wy - 1, 1.6 * k, 2 * k, 0, '#f3d06a', 0.9);
    stroke(g, [[wx - 8 * k, wy - 7 * k], [wx, wy - 11 * k], [wx + 8 * k, wy - 9 * k]], 2, 2, '#4a3a2c', 0.8);
  }
  ellipse(g, 6, -1, 6, 7.5, 0, '#1e1a1c', 1); ellipse(g, 6.4, -1, 2.6, 3.6, 0, '#a8742a', 1);
  // a lantern hung by the door
  stroke(g, [[45, -52], [45, -46]], 0.8, 0.8, '#2a1a10'); blob(g, 45, -42, 7, 7, 0, '#ffd27a', 0.45, 0.2); ellipse(g, 45, -42.5, 2.2, 3.2, 0, '#ffe9a8', 1);
  // a soft dark outline, broken where the light hits
  g.strokeStyle = 'rgba(42,26,16,0.75)'; g.lineWidth = 1.4; g.lineJoin = 'round'; g.stroke(outlineAll);
  stroke(g, [[TL[0] - 0.8, TL[1] + 1], [FL[0] - 0.8, FL[1] - 2]], 1.2, 1.2, '#fff6dc', 0.6);
  g.restore();
}

// Lay a tiling texture on the ground plane in perspective (y = HZ + FZ/Z,
// x = VX + X*FZ/Z), a few rows of pixels at a time; T = texture px per unit.
function groundStrips(g, img, { W, HZ, FZ, VX, T, zNear, zFar, alpha, clip = null }) {
  const pat = g.createPattern(img, 'repeat');
  g.save(); if (clip) g.clip(clip);
  const yTop = Math.floor(HZ + FZ / zFar), yBot = Math.ceil(HZ + FZ / zNear);
  for (let y = yTop; y < yBot; y += 3) {
    const Z = FZ / (y + 1.5 - HZ), sx = FZ / (Z * T), sy = sx / Z;
    pat.setTransform(new DOMMatrix([sx, 0, 0, sy, VX, y + Z * T * sy]));
    g.globalAlpha = alpha(Z);
    g.fillStyle = pat; g.fillRect(0, y, W, 3);
  }
  g.restore();
}

// Field grass for the vista (meant to be seen in perspective): blotches and tufts.
register('ui_vista_grass', { size: 256, family: F, note: 'tiles; title-screen field grass', paint(g, s, rnd) {
  fill(g, s, s, '#5b8a2e');
  mottle(g, s, rnd, { colors: ['#4f7d2a', '#6f9c34', '#86a648', '#3e6420', '#9cb447', '#2f5220'], count: 50, rmin: 18, rmax: 70, alpha: 0.6, hard: 0.2 });
  for (let i = 0; i < 420; i++) {
    const x = rnd() * s, y = rnd() * s, L = range(rnd, 6, 15), n = 3 + Math.floor(rnd() * 4), c = pick(rnd, ['#3e6420', '#4f7d2a', '#5b8a2e', '#6f9c34']), lit = pick(rnd, ['#9cb447', '#86a648', '#b2c25a', '#a8c060']);
    const bl = []; for (let j = 0; j < n; j++) bl.push([range(rnd, -2, 2), L * range(rnd, 0.6, 1.1), (j / (n - 1) - 0.5) * 1.2 + range(rnd, -0.15, 0.15)]);
    wrap(s, x, y, L + 4, (xx, yy) => {
      blob(g, xx + 2, yy + 1, L * 0.7, L * 0.25, 0, '#243e18', 0.4, 0.3);
      bl.forEach(([dx, l, a], j) => blade(g, xx + dx, yy, l, a, 2.4, j === 0 ? lit : c, 0.92));
    });
  }
  blurTile(g.canvas, 0.35);
} });

// Packed road dirt for the vista: warm blotches, pebbles, faint wheel-worn streaks.
register('ui_vista_dirt', { size: 256, family: F, note: 'tiles; title-screen road dirt', paint(g, s, rnd) {
  fill(g, s, s, '#b89468');
  mottle(g, s, rnd, { colors: ['#a07a50', '#c8a678', '#8a6640', '#d6b888'], count: 50, rmin: 14, rmax: 60, alpha: 0.45, hard: 0.15, stretch: 1.8, rot: 0 });
  streaks(g, s, rnd, { colors: ['#7a5a38', '#dcc49a'], count: 40, len: [20, 60], width: [1, 2.5], angle: 0, wobble: 0.2, alpha: 0.25 });
  pebbles(g, s, rnd, { colors: ['#9a8f80', '#b1a594', '#857a6c', '#a08868'], count: 60, rmin: 1.5, rmax: 4, shadow: 0.4 });
  blurTile(g.canvas, 0.3);
} });

// A painted golden-hour road vista (the login screen), lit from a low sun on the
// left. The center column stays calm (sky, distant peaks, the road vanishing
// behind the menu card); the story sits in the lower left: the RV coming round
// the bend under a big oak, kicking up dust.
// Painted in stages (a generator) so labels.js can spread the work over several
// frames at startup; the registered texture runs every stage in one go.
export function* paintVista(g, W, H, rnd, { full = true } = {}) {
  const HZ = Math.round(H * 0.6);               // horizon
  const SX = W * 0.315, SY = HZ - 60;            // the sun, low on the left
  // sky
  vgrad(g, W, H, [[0, '#2c5690'], [0.16, '#4777ae'], [0.34, '#8fb0cc'], [0.47, '#dcd2b0'], [0.55, '#f4cf8e'], [0.6, '#f2b878'], [1, '#c98a52']]);
  blob(g, SX, SY, 620, 320, 0, '#ffe2a0', 0.45, 0.05);
  blob(g, SX, SY, 200, 130, 0, '#fff3d0', 0.7, 0.1);
  blob(g, SX, SY, 40, 38, 0, '#fffdf2', 0.95, 0.6);
  // clouds: two-tone cumulus, lobes piled on a flat base: soft painted shading inside (a
  // cream lit top toward the sun on the upper left, a lavender-gray underside), a crisp
  // silhouette, a darker band along the flat bottom
  const cloud = (cx, cy, cw, ch, n) => {
    const lobes = [];
    for (let i = 0; i < n; i++) {
      const t = (i + rnd() * 0.8) / n, bell = Math.pow(Math.sin(t * Math.PI), 0.7);
      const r = ch * (0.3 + bell * range(rnd, 0.42, 0.72));
      lobes.push([cx + (t - 0.5) * cw, cy - r * range(rnd, 0.35, 0.8), r]);
    }
    for (let i = 0; i < Math.round(n / 3); i++) {                  // a second tier of towers on top
      const t = range(rnd, 0.25, 0.7), r = ch * range(rnd, 0.32, 0.5);
      lobes.push([cx + (t - 0.5) * cw, cy - ch * range(rnd, 0.7, 1.05), r]);
    }
    // work in a box around the cloud
    const bx = Math.floor(cx - cw * 0.5 - ch * 1.2), by = Math.floor(cy - ch * 2.2), bw = Math.ceil(cw + ch * 2.4), bh = Math.ceil(ch * 2.2 + 4);
    const body = new Path2D();
    for (const [x, y, r] of lobes) { body.moveTo(x - bx + r, y - by); body.ellipse(x - bx, y - by, r, r * 0.84, 0, 0, Math.PI * 2); }
    const [SL, sg] = layer(bw, bh);
    sg.fillStyle = vlin(sg, 0, 0, 0, bh, [[0, '#f4e8d8'], [0.55, '#e2d8d4'], [1, '#c6bfd0']]); sg.fill(body);
    for (const [x, y, r] of lobes) { sg.fillStyle = 'rgba(186,178,204,0.6)'; sg.beginPath(); sg.ellipse(x - bx + r * 0.22, y - by + r * 0.34, r * 0.82, r * 0.5, 0, 0, Math.PI * 2); sg.fill(); }
    for (const [x, y, r] of lobes) { sg.fillStyle = '#fff1d8'; sg.beginPath(); sg.ellipse(x - bx - r * 0.2, y - by - r * 0.3, r * 0.7, r * 0.52, -0.2, 0, Math.PI * 2); sg.fill(); }
    for (const [x, y, r] of lobes) if (rnd() < 0.6) { sg.fillStyle = '#fffaf0'; sg.beginPath(); sg.ellipse(x - bx - r * 0.34, y - by - r * 0.46, r * 0.32, r * 0.2, -0.3, 0, Math.PI * 2); sg.fill(); }
    const [CL, cg] = layer(bw, bh);
    cg.filter = `blur(${Math.max(1.5, ch * 0.05).toFixed(1)}px)`; cg.drawImage(SL, 0, 0); cg.filter = 'none';
    cg.fillStyle = vlin(cg, 0, cy - by - ch * 0.3, 0, cy - by, [[0, 'rgba(160,150,184,0)'], [1, 'rgba(160,150,184,0.5)']]); cg.fillRect(0, cy - by - ch * 0.3, bw, ch * 0.3);
    cg.globalCompositeOperation = 'destination-in';
    cg.save(); cg.beginPath(); cg.rect(0, 0, bw, cy - by); cg.clip(); cg.fillStyle = '#000'; cg.fill(body); cg.restore();
    g.save(); g.filter = 'blur(0.6px)'; g.drawImage(CL, bx, by); g.restore();
  };
  cloud(W * 0.62, H * 0.12, 360, 70, 11);
  cloud(W * 0.9, H * 0.2, 280, 58, 9);
  cloud(W * 0.47, H * 0.27, 220, 34, 8);
  cloud(W * 0.13, H * 0.36, 200, 30, 7);
  cloud(W * 0.8, H * 0.41, 170, 24, 6);
  yield;

  // mountains: painted on a layer, softened a touch, hazed toward the horizon
  const [ML, mg] = layer(W, H);
  const far = { lit: ['#a6aebb', '#8e96a3'], sh: ['#6c7488', '#7a8296'], snowLit: '#fbf3e6', snowSh: '#bccadf', gullyLit: '#7c8494', gullySh: '#5a6276', spur: '#b4bcc8', n: 30 };
  for (const [x, h, wl, wr] of [[90, 168, 170, 150], [300, 140, 150, 170], [520, 214, 190, 170], [705, 186, 160, 150], [880, 226, 200, 190], [1080, 160, 160, 150], [1250, 196, 170, 180]]) {
    peak(mg, rnd, { ...far, x, y: HZ - 6 - h, wl, wr, base: HZ + 6, snow: range(rnd, 0.34, 0.42) });
  }
  mg.save(); mg.globalCompositeOperation = 'source-atop';
  mg.fillStyle = vlin(mg, 0, HZ - 260, 0, HZ, [[0, 'rgba(169,198,214,0.42)'], [0.6, 'rgba(176,200,212,0.6)'], [1, 'rgba(206,214,200,0.78)']]); mg.fillRect(0, 0, W, H);
  mg.restore();
  const near = { lit: ['#8e96a3', '#6f7682'], sh: ['#4e5562', '#5c6272'], snowLit: '#fff6e8', snowSh: '#aebcd4', gullyLit: '#5c6372', gullySh: '#3c4250', spur: '#a8b0bc', n: 75 };
  for (const [x, h, wl, wr] of [[-30, 230, 200, 230], [215, 262, 210, 220], [1000, 252, 220, 210], [1265, 214, 180, 200]]) {
    peak(mg, rnd, { ...near, x, y: HZ + 4 - h, wl, wr, base: HZ + 16, snow: range(rnd, 0.3, 0.36) });
  }
  g.save(); g.filter = 'blur(1.2px)'; g.drawImage(ML, 0, 0); g.restore();
  blob(g, W * 0.5, HZ - 6, W * 0.75, 34, 0, '#e2d3ac', 0.5, 0.15);           // haze band
  blob(g, SX, HZ - 30, 380, 90, 0, '#ffe6b8', 0.45, 0.1);                    // sun haze over the range
  yield;

  // forested foothills, blue-green
  const ridgeLine = (y0, amp, f, ph) => { const pts = []; for (let x = -20; x <= W + 20; x += 8) pts.push([x, y0 - amp * (0.55 * Math.sin(x * f + ph) + 0.3 * Math.sin(x * f * 2.7 + ph * 1.3) + 0.15 * Math.sin(x * f * 6.1 + ph * 0.5))]); return pts; };
  const band = (pts, top, bot, y0, y1) => { const p = poly([[-20, H], ...pts, [W + 20, H]]); g.fillStyle = vlin(g, 0, y0, 0, y1, [[0, top], [1, bot]]); g.fill(p); return p; };
  const fh = ridgeLine(HZ - 6, 16, 0.011, 0.7);
  const fhp = band(fh, '#5f7f86', '#90a596', HZ - 24, HZ + 10);
  g.save(); g.clip(fhp);
  {                                                    // tree tips along the ridge in clumps, lit side left
    const [TL, tg] = layer(W, H);
    const ridgeY = x => { for (let k = 1; k < fh.length; k++) if (fh[k][0] >= x) return fh[k - 1][1] + (fh[k][1] - fh[k - 1][1]) * ((x - fh[k - 1][0]) / 8); return HZ; };
    for (let x = range(rnd, -20, 10); x < W + 20;) {
      const n = 3 + Math.floor(rnd() * 5), tall = range(rnd, 0.6, 1);
      for (let j = 0; j < n; j++) {
        const xx = x + j * range(rnd, 3.5, 6), y = ridgeY(xx) + range(rnd, 2, 14), h = range(rnd, 5, 13) * tall * range(rnd, 0.4, 1);
        stroke(tg, [[xx, y + h * 0.4], [xx, y - h]], h * 0.5, 0.5, pick(rnd, ['#4b6a6c', '#55747a', '#41605f', '#4e6a62']), 0.9);
        stroke(tg, [[xx - h * 0.12, y + h * 0.3], [xx - h * 0.05, y - h * 0.7]], h * 0.15, 0.4, '#8fa8a0', 0.45);
      }
      x += n * 5 + range(rnd, 6, 46);
    }
    g.save(); g.filter = 'blur(0.6px)'; g.drawImage(TL, 0, 0); g.restore();
  }
  g.restore();
  blob(g, SX, HZ, 360, 30, 0, '#ffe0b0', 0.35, 0.1);

  // far hills (Elwynn green), soft blotches and lit crests
  const h1 = ridgeLine(HZ + 14, 14, 0.0065, 2.1);
  const h1p = band(h1, '#8aa65a', '#6a8a3e', HZ, HZ + 30);
  g.save(); g.clip(h1p);
  for (let i = 0; i < 50; i++) blob(g, rnd() * W, HZ + range(rnd, 4, 34), range(rnd, 30, 90), range(rnd, 4, 9), 0, pick(rnd, ['#9cb45a', '#5e8034', '#7c9a44', '#b0bf68']), 0.35, 0.25);
  for (const [x, y, L] of [[150, HZ + 16, 70], [330, HZ + 22, 40], [905, HZ + 14, 60], [1110, HZ + 22, 50], [1200, HZ + 12, 34]]) {   // copses on the far fields
    blob(g, x + L * 0.1, y + 3, L * 0.6, 5, 0, '#2f4a20', 0.55, 0.4);
    for (let k = 0; k < L / 4; k++) {
      const xx = x + range(rnd, -0.5, 0.5) * L, hh = range(rnd, 6, 14);
      if (rnd() < 0.5) { stroke(g, [[xx, y + 2], [xx, y - hh]], hh * 0.5, 0.6, pick(rnd, ['#355a2a', '#2f4f2a']), 0.95); stroke(g, [[xx - 1, y], [xx - 0.6, y - hh * 0.7]], hh * 0.16, 0.4, '#7d9a4a', 0.5); }
      else { blob(g, xx, y - hh * 0.4, hh * 0.55, hh * 0.45, 0, pick(rnd, ['#3f6326', '#4a6d2a']), 0.95, 0.8); blob(g, xx - hh * 0.15, y - hh * 0.6, hh * 0.28, hh * 0.2, 0, '#8fae4c', 0.7, 0.6); }
    }
  }
  g.restore();
  stroke(g, h1.filter((_, i) => i % 2 === 0), 2.4, 2.4, '#c2cf78', 0.4);
  // a timber-framed cottage on the right-hand hill, smoke from the chimney
  {
    const cx = 1046, cy = HZ + 20;
    blob(g, cx + 6, cy + 2, 26, 4, 0, '#2c3a1c', 0.5, 0.3);
    g.fillStyle = '#e6d8b8'; g.fillRect(cx - 16, cy - 14, 32, 14);
    g.fillStyle = '#b8a888'; g.fillRect(cx + 6, cy - 14, 10, 14);
    g.fillStyle = '#4a2e18'; for (const bx of [-16, -6, 5, 15]) g.fillRect(cx + bx, cy - 14, 1.6, 14); g.fillRect(cx - 16, cy - 8, 32, 1.4);
    g.fillStyle = '#ffd77a'; g.fillRect(cx - 12, cy - 6, 3, 3); g.fillRect(cx + 9, cy - 6, 3, 3);
    const roofL = poly([[cx - 20, cy - 12], [cx - 2, cy - 33], [cx + 2, cy - 33], [cx + 2, cy - 12]]), roofR = poly([[cx + 2, cy - 33], [cx + 20, cy - 12], [cx + 2, cy - 12]]);
    g.fillStyle = '#b8462a'; g.fill(roofL); g.fillStyle = '#7a2a1c'; g.fill(roofR);
    stroke(g, [[cx - 20, cy - 12], [cx, cy - 34]], 1.4, 1.2, '#e88a5c', 0.8);
    g.fillStyle = '#8a8480'; g.fillRect(cx + 8, cy - 32, 5, 12); g.fillStyle = '#b8b2aa'; g.fillRect(cx + 8, cy - 32, 2, 12);
    for (let i = 0; i < 6; i++) blob(g, cx + 11 + i * 4 + Math.sin(i) * 3, cy - 38 - i * 8, 4 + i * 1.8, 3 + i * 1.4, 0, '#e8e2dc', 0.42 - i * 0.05, 0.3);
  }

  // the near ground
  const h2 = ridgeLine(HZ + 44, 18, 0.0042, 3.4);
  const h2p = band(h2, '#6f8f3c', '#456e28', HZ + 30, H);
  const VX = W * 0.53, FZ = H + 20 - HZ;
  // painted grass laid on the ground plane in perspective, fading out with distance
  groundStrips(g, canvasFor('ui_vista_grass'), { W, HZ, FZ, VX, T: 230, zNear: 0.95, zFar: 8, alpha: Z => 0.9 * Math.min(1, Math.max(0, (8 - Z) / 4.5)), clip: h2p });
  yield;
  g.save(); g.clip(h2p);
  for (let i = 0; i < 110; i++) { const y = HZ + 30 + Math.pow(rnd(), 1.4) * (H - HZ); const k = (y - HZ) / (H - HZ); blob(g, rnd() * W, y, range(rnd, 40, 140) * (0.5 + k), range(rnd, 6, 22) * (0.5 + k), range(rnd, -0.08, 0.08), pick(rnd, ['#4f7d2a', '#6f9c34', '#9cb447', '#86a648', '#3e6420', '#5e8a30']), 0.3, 0.25); }
  for (const [x, y, rx, ry] of [[700, HZ + 120, 330, 40], [1010, HZ + 210, 300, 50], [560, H - 30, 420, 60], [1180, HZ + 70, 220, 26]]) blob(g, x, y, rx, ry, 0, '#2c4a1c', 0.26, 0.2);   // cloud shadows
  for (const [x, y, rx, ry] of [[480, HZ + 70, 260, 30], [860, HZ + 150, 200, 34], [380, H - 120, 200, 40]]) blob(g, x, y, rx, ry, 0, '#c9c46a', 0.2, 0.2);        // sunlit patches
  g.fillStyle = vlin(g, 0, H - 150, 0, H, [[0, 'rgba(30,44,18,0)'], [1, 'rgba(30,44,18,0.38)']]); g.fillRect(0, H - 150, W, 150);
  g.restore();
  stroke(g, h2.filter((_, i) => i % 2 === 0), 3, 3, '#a8bd5a', 0.35);
  // the backdrop ends here: labels.js renders the real game assets over it (the RV on the
  // dirt road, the oak, pines, rocks, fence and signpost), then runs finishVista
  if (!full) return;

  // the road: a ground plane seen from a little hill, curving in from the lower left
  const RX = [[0.9, -1.0], [1.3, -1.7], [1.7, -2.35], [2.2, -2.85], [3, -3.0], [4.4, -2.65], [7, -2.2], [12, -1.95], [25, -1.5], [60, -1.0], [300, -0.4]];
  const roadX = Z => { for (let i = 1; i < RX.length; i++) if (Z <= RX[i][0]) { const t = (Math.log(Z) - Math.log(RX[i - 1][0])) / (Math.log(RX[i][0]) - Math.log(RX[i - 1][0])); const s = t * t * (3 - 2 * t); return RX[i - 1][1] + (RX[i][1] - RX[i - 1][1]) * s; } return RX[RX.length - 1][1]; };
  const at = (Z, u) => [VX + (roadX(Z) + u * 0.85) * FZ / Z, HZ + FZ / Z];
  const Zs = []; for (let z = 0.9; z < 300; z *= 1.04) Zs.push(z);
  const road = poly([...Zs.map(z => at(z, -1)), ...Zs.slice().reverse().map(z => at(z, 1))]);
  g.save(); g.clip(road);
  vgrad(g, W, H, [[0, '#dcc09a'], [0.62, '#ccaa7a'], [0.78, '#a98458'], [1, '#86643e']]);
  groundStrips(g, canvasFor('ui_vista_dirt'), { W, HZ, FZ, VX, T: 200, zNear: 0.95, zFar: 14, alpha: Z => 0.85 * Math.min(1, Math.max(0, (14 - Z) / 8)) });
  for (let i = 0; i < 220; i++) { const z = Math.exp(range(rnd, Math.log(0.9), Math.log(40))), [x, y] = at(z, range(rnd, -1, 1)); blob(g, x, y, range(rnd, 0.1, 0.4) * FZ / z, range(rnd, 0.02, 0.07) * FZ / z, range(rnd, -0.15, 0.15), pick(rnd, ['#8a6640', '#b8946a', '#6f5033', '#caa676', '#9a7650', '#d6b888']), 0.32, 0.2); }
  // darker, grass-shaded verges; a sunlit crown
  for (const u of [-1, 1]) for (let i = 0; i < 80; i++) { const z = Math.exp(range(rnd, Math.log(0.9), Math.log(30))), [x, y] = at(z, u * range(rnd, 0.82, 1)); blob(g, x, y, 0.16 * FZ / z, 0.035 * FZ / z, 0, '#5e4428', 0.3, 0.2); }
  for (let i = 0; i < 60; i++) { const z = Math.exp(range(rnd, Math.log(0.9), Math.log(30))), [x, y] = at(z, range(rnd, -0.15, 0.15)); blob(g, x, y, 0.22 * FZ / z, 0.04 * FZ / z, 0, '#e8d0a0', 0.22, 0.2); }
  // wheel ruts: two continuous soft bands with lit inner lips, painted on their own layer
  const [RL, rg] = layer(W, H), [LL, lg] = layer(W, H);
  for (const u of [-0.42, 0.42]) {
    const zs = Zs.filter(z => z < 70);
    for (let i = 0; i < zs.length - 1; i++) {
      const a = at(zs[i], u), b = at(zs[i + 1], u), w0 = 0.26 * FZ / zs[i], w1 = 0.26 * FZ / zs[i + 1];
      stroke(rg, [a, b], w0, w1, '#6f5033', 1);
      const ia = at(zs[i], u * 0.7), ib = at(zs[i + 1], u * 0.7);
      stroke(lg, [ia, ib], w0 * 0.22, w1 * 0.22, '#ecd3a4', 1);
    }
  }
  g.save(); g.filter = 'blur(3px)'; g.globalAlpha = 0.42; g.drawImage(RL, 0, 0); g.filter = 'blur(2px)'; g.globalAlpha = 0.2; g.drawImage(LL, 0, 0); g.restore();
  // stones in the near dirt
  for (let i = 0; i < 46; i++) { const z = range(rnd, 0.9, 3.2), [x, y] = at(z, range(rnd, -0.95, 0.95)), r = range(rnd, 0.008, 0.022) * FZ / z; ellipse(g, x + r * 0.4, y + r * 0.35, r, r * 0.6, 0, '#4b3826', 0.45); ellipse(g, x, y, r, r * 0.62, 0, pick(rnd, ['#9a8f80', '#b1a594', '#857a6c']), 0.95); ellipse(g, x - r * 0.3, y - r * 0.25, r * 0.5, r * 0.3, 0, '#e2d6c0', 0.6); }
  // grass invading the crown between the ruts
  for (let i = 0; i < 520; i++) { const z = Math.exp(range(rnd, Math.log(0.9), Math.log(18))), [x, y] = at(z, range(rnd, -0.16, 0.16)), L = range(rnd, 0.02, 0.06) * FZ / z; blade(g, x, y, L, range(rnd, -0.5, 0.5), Math.max(0.6, 0.012 * FZ / z), pick(rnd, ['#6f9c34', '#9cb447', '#5b8a2e', '#86a648']), 0.85); }
  blob(g, ...at(14, 0), 240, 26, 0, '#ffe2b2', 0.3, 0.1);
  g.restore();
  yield;
  // ragged grass along both edges
  for (const side of [-1, 1]) for (let i = 0; i < 1100; i++) {
    const z = Math.exp(range(rnd, Math.log(0.9), Math.log(30))), [x, y] = at(z, side * range(rnd, 0.84, 1.12)), L = range(rnd, 0.035, 0.09) * FZ / z;
    blade(g, x, y + L * 0.15, L, side * range(rnd, -0.15, 0.55) * -1 + range(rnd, -0.2, 0.2), Math.max(0.6, 0.016 * FZ / z), pick(rnd, ['#4f7d2a', '#6f9c34', '#9cb447', '#3e6420', '#86a648']), 0.9);
  }

  // rail fence and signpost across the field on the right
  {
    const posts = [];
    for (let i = 0; i < 8; i++) { const z = 1 + i, t = (1 - 1 / z) / (1 - 1 / 8), p = lerp2([1290, H - 22], [880, HZ + 66], t); posts.push([p[0], p[1], 1 / Math.pow(z, 0.75)]); }
    for (const [hh] of [[0.42], [0.76]]) for (let i = 0; i < posts.length - 1; i++) {
      const [x0, y0, k0] = posts[i], [x1, y1, k1] = posts[i + 1];
      stroke(g, [[x0, y0 - 92 * k0 * hh], [x1, y1 - 92 * k1 * hh]], 7 * k0, 7 * k1, '#5c3d22', 1);
      stroke(g, [[x0, y0 - 92 * k0 * hh - 2 * k0], [x1, y1 - 92 * k1 * hh - 2 * k1]], 2.4 * k0, 2.4 * k1, '#b08850', 0.75);
    }
    for (const [x, y, k] of posts) {
      const h = 104 * k, w = 11 * k;
      blob(g, x + w * 1.6, y, w * 2.2, w * 0.5, 0, '#22301a', 0.4, 0.3);
      stroke(g, [[x, y], [x + 0.6 * k, y - h]], w, w * 0.85, '#4e3420', 1);
      stroke(g, [[x - w * 0.28, y - 2], [x - w * 0.22, y - h + 3]], w * 0.3, w * 0.25, '#a07650', 0.75);
      stroke(g, [[x + w * 0.3, y - 2], [x + w * 0.3, y - h + 3]], w * 0.2, w * 0.2, '#2e1e12', 0.6);
      ellipse(g, x + 0.6 * k, y - h, w * 0.5, w * 0.2, 0, '#b08a5a', 0.9);
      for (let j = 0; j < 8; j++) blade(g, x + range(rnd, -w, w * 1.5), y + 2, range(rnd, 8, 22) * k, range(rnd, -0.5, 0.5), 2.4 * k, pick(rnd, ['#4f7d2a', '#6f9c34', '#9cb447']), 0.95);
    }
  }
  {
    const x = 988, y = 612;
    blob(g, x + 24, y + 2, 34, 6, 0, '#22301a', 0.45, 0.3);
    stroke(g, [[x, y + 4], [x + 3, y - 150]], 11, 8, '#4a301c', 1);
    stroke(g, [[x - 3, y], [x - 0.5, y - 146]], 3, 2, '#a07650', 0.75);
    const board = (bx, by, w, h, dir, txt) => {
      const p = poly([[bx, by], [bx + dir * w, by + dir * -2], [bx + dir * (w + 13), by + h / 2 - 1], [bx + dir * w, by + h + 1 - dir * 2], [bx, by + h]]);
      g.save(); g.translate(3, 4); g.fillStyle = 'rgba(20,12,6,0.45)'; g.fill(p); g.restore();
      g.fillStyle = vlin(g, 0, by, 0, by + h, [[0, '#b08452'], [0.5, '#8a5f36'], [1, '#5e3e22']]); g.fill(p);
      g.save(); g.clip(p);
      for (let k = 0; k < 7; k++) stroke(g, [[bx - 30, by + 2 + k * h / 7], [bx + dir * 40, by + 2 + k * h / 7 + range(rnd, -1, 1)], [bx + dir * (w + 20), by + 2 + k * h / 7 + range(rnd, -1.2, 1.2)]], range(rnd, 0.8, 1.6), 0.8, pick(rnd, ['#5a3a1e', '#c49a66']), 0.4);
      stroke(g, [[bx, by + 1], [bx + dir * w, by - dir * 2 + 1]], 1.6, 1.6, '#e2be86', 0.7);
      g.font = `bold ${Math.round(h * 0.58)}px Georgia, 'Times New Roman', serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
      const tx = bx + dir * ((w + 6) / 2 + 3), ty = by + h / 2 + 1;
      g.fillStyle = 'rgba(255,230,180,0.35)'; g.fillText(txt, tx + 0.8, ty + 0.8);
      g.fillStyle = 'rgba(40,20,8,0.85)'; g.fillText(txt, tx, ty);
      g.restore();
      g.strokeStyle = 'rgba(36,20,10,0.8)'; g.lineWidth = 1.3; g.stroke(p);
      for (const nx of [bx + dir * 4]) ellipse(g, nx, by + h / 2, 1.3, 1.3, 0, '#2a2420', 1);
    };
    board(x + 3, y - 140, 76, 21, -1, 'GOLDSHIRE');
    board(x + 3, y - 112, 88, 20, 1, 'LOST WAGES');
    for (let j = 0; j < 22; j++) blade(g, x + range(rnd, -14, 16), y + 4, range(rnd, 8, 22), range(rnd, -0.5, 0.5), 2.6, pick(rnd, ['#4f7d2a', '#6f9c34', '#9cb447']), 0.95);
  }

  yield;
  // rock outcrops
  rockOutcrop(g, rnd, 826, HZ + 84, 110, 44);
  rockOutcrop(g, rnd, 1180, HZ + 120, 150, 66);
  rockOutcrop(g, rnd, 150, 538, 110, 40);

  yield;
  // grass blades over the near fields (denser and bigger toward the viewer)
  for (let i = 0; i < 420; i++) {                       // tufts standing up out of the painted grass
    const y = HZ + 90 + Math.pow(rnd(), 0.5) * (H - HZ - 80), k = (y - HZ) / (H - HZ), x = rnd() * W;
    const z = FZ / Math.max(1, y - HZ), [l] = at(z, -1.04), [r] = at(z, 1.04);
    if (x > l && x < r) continue;
    const n = 3 + Math.floor(rnd() * 4), L = range(rnd, 6, 18) * k * 1.4, c = pick(rnd, ['#4f7d2a', '#6f9c34', '#3e6420', '#5e8a30']);
    blob(g, x + L * 0.3, y + 1, L * 0.7, L * 0.16 + 1, 0, '#2c4a1c', 0.35, 0.3);
    for (let j = 0; j < n; j++) blade(g, x + range(rnd, -2, 2) * k, y, L * range(rnd, 0.6, 1.1), (j / (n - 1 || 1) - 0.5) * 1.1 + range(rnd, -0.15, 0.15), Math.max(0.7, 3 * k), j === 0 ? '#9cb447' : jitter(c, rnd, 0.06), 0.9);
  }

  yield;
  // dust from the RV, back along the road, lit on the sun side
  {
    const [x0, y0] = at(1.9, -0.28);
    for (let i = 0; i < 16; i++) {
      const t = i / 15, [x, y] = at(2.7 + t * 2.6, range(rnd, -0.5, 0.5));
      const r = 14 + t * 34;
      blob(g, x + r * 0.15, y - r * 0.2, r * 1.1, r * 0.6, 0, '#a99487', 0.28 * (1 - t * 0.5), 0.2);
      blob(g, x - r * 0.2, y - r * 0.35, r * 0.85, r * 0.5, 0, '#f0d7a8', 0.36 * (1 - t * 0.5), 0.25);
    }
    blob(g, x0 + 110, y0 - 40, 60, 20, -0.3, '#e9cfa0', 0.3, 0.2);
    paintRV(g, rnd, x0, y0, 1.0);
  }

  yield;
  // the framing oak, top left: a thick trunk with flared roots, a huge clumped canopy
  {
    const tx = 52, ty = H + 14;
    for (const [dx, dy, w] of [[-70, -6, 40], [92, 4, 46], [140, 14, 30], [10, 18, 50]]) stroke(g, [[tx + 6, ty - 70], [tx + dx * 0.5, ty - 22], [tx + dx, ty + dy]], w, w * 0.3, '#3e3226', 1);
    stroke(g, [[tx, ty], [tx + 10, H * 0.74], [tx + 4, H * 0.5], [tx + 26, H * 0.32], [tx + 40, H * 0.2]], 118, 52, '#43362a', 1);
    stroke(g, [[tx - 40, ty - 10], [tx - 24, H * 0.75], [tx - 22, H * 0.52], [tx + 4, H * 0.34]], 22, 8, '#7d6a54', 0.75);      // lit flank
    stroke(g, [[tx - 46, ty - 30], [tx - 32, H * 0.78], [tx - 30, H * 0.6]], 8, 3, '#a38c6c', 0.6);
    stroke(g, [[tx + 52, ty], [tx + 56, H * 0.74], [tx + 44, H * 0.5], [tx + 52, H * 0.34]], 30, 10, '#261d16', 0.6);          // shaded flank
    for (let i = 0; i < 70; i++) {                           // bark: wobbly vertical ridges with dark furrows
      const x = tx + range(rnd, -46, 56), y = H * range(rnd, 0.4, 1.02), L = range(rnd, 40, 120);
      const pts = [[x, y], [x + range(rnd, -3, 3), y - L * 0.5], [x + range(rnd, -4, 4), y - L]];
      stroke(g, pts, range(rnd, 2.5, 6), 1, x < tx - 10 ? pick(rnd, ['#2a221c', '#1e1712']) : x < tx + 20 ? pick(rnd, ['#2a221c', '#5e4c3a']) : pick(rnd, ['#1e1712', '#2e241c']), 0.7);
      if (x < tx + 10) stroke(g, pts.map(([u, v]) => [u - 2.2, v]), range(rnd, 1.2, 2.4), 0.6, pick(rnd, ['#9a8468', '#b39a78', '#7d6a54']), 0.6);
    }
    for (const [kx, ky] of [[tx - 8, H * 0.62], [tx + 22, H * 0.81]]) { blob(g, kx, ky, 9, 6, 0, '#1a130e', 0.75, 0.5); stroke(g, [[kx - 8, ky - 5], [kx, ky - 8], [kx + 8, ky - 5]], 2, 1.2, '#8d7a62', 0.6); }   // two old knots
    for (let i = 0; i < 18; i++) blob(g, tx + range(rnd, -48, -18), H * range(rnd, 0.82, 1), range(rnd, 5, 12), range(rnd, 3, 6), rnd() * 3, pick(rnd, ['#4b6a24', '#5f7d2a']), 0.55, 0.5);   // moss low on the roots
    for (const [a, b, c, w] of [[[tx + 20, H * 0.42], [tx + 120, H * 0.3], [tx + 230, H * 0.22], 34], [[tx + 6, H * 0.46], [tx - 30, H * 0.34], [tx - 60, H * 0.26], 26], [[tx + 34, H * 0.3], [tx + 110, H * 0.14], [tx + 160, H * 0.04], 24]]) {
      stroke(g, [a, b, c], w, w * 0.35, '#3e3226', 1);
      stroke(g, [[a[0], a[1] - w * 0.3], [b[0], b[1] - w * 0.25], [c[0], c[1] - w * 0.12]], w * 0.25, w * 0.08, '#7d6a54', 0.6);
    }
    const clumps = [[-30, 30, 120], [110, -20, 105], [250, 26, 92], [370, -6, 70], [40, 150, 100], [190, 140, 92], [320, 104, 66], [-40, 240, 92], [110, 252, 70], [250, 214, 58]];
    clumps.sort((a, b) => a[1] - b[1]);
    for (const [cx, cy, r] of clumps) leafClump(g, rnd, cx, cy, r);
    // a few leaves hanging loose below the canopy
    for (let i = 0; i < 40; i++) { const x = range(rnd, -20, 330), y = range(rnd, 250, 300) - x * 0.1; ellipse(g, x, y, range(rnd, 3, 6), range(rnd, 2, 3.5), rnd() * 3, pick(rnd, ['#2f5220', '#3d6526', '#86a648']), 0.95); }
  }

  yield;
  // conifers framing the right edge
  conifer(g, rnd, 1236, H + 30, 700, 170, -0.05);
  conifer(g, rnd, 1128, H + 10, 430, 110, 0.04);
  conifer(g, rnd, 862, HZ + 70, 118, 34, 0.06);
  conifer(g, rnd, 832, HZ + 62, 86, 26, -0.04);
  conifer(g, rnd, 382, HZ + 34, 70, 22, 0.05);

  // foreground: tall grass and flower clumps in the corners
  for (let i = 0; i < 260; i++) {
    const left = rnd() < 0.5, x = left ? range(rnd, -10, 260) : range(rnd, 1000, W + 10), y = H - range(rnd, -6, 46);
    blade(g, x, y, range(rnd, 18, 46), range(rnd, -0.45, 0.45), range(rnd, 2.5, 5), pick(rnd, ['#3e6420', '#4f7d2a', '#6f9c34', '#9cb447', '#2f5220']), 0.95, range(rnd, -0.4, 0.4));
  }
  for (let c = 0; c < 8; c++) {
    const cx = c < 4 ? range(rnd, 560, 860) : range(rnd, 940, 1180), cy = range(rnd, H * 0.88, H * 0.97);
    const col = pick(rnd, ['#e8d24a', '#f2efe0', '#c86ad0', '#e88a3a']);
    for (let i = 0; i < 12; i++) { const x = cx + range(rnd, -22, 22), y = cy + range(rnd, -7, 7); ellipse(g, x + 0.8, y + 0.8, 3, 2.4, 0, '#2a3a1a', 0.4); ellipse(g, x, y, 2.9, 2.4, 0, jitter(col, rnd, 0.1), 0.95); ellipse(g, x - 0.7, y - 0.7, 1.1, 0.9, 0, '#fffbe0', 0.8); }
  }

  finishVista(g, W, H, rnd);
}

// The last stage, over everything: soft sun shafts from the low sun on the left,
// a warm unifying glaze, the greens pulled back from candy, a vignette.
export function finishVista(g, W, H, rnd, { sat = 0.14 } = {}) {
  const SX = W * 0.315, SY = Math.round(H * 0.6) - 60;
  g.save(); g.globalCompositeOperation = 'screen';
  for (let i = 0; i < 6; i++) { const a = range(rnd, -0.5, 1.2); stroke(g, [[SX, SY], [SX + Math.sin(a) * 1100, SY + Math.cos(a) * 900]], 10, range(rnd, 90, 170), '#ffe8b8', 0.045); }
  g.restore();
  glaze(g, W, H, '#ffd9a0', 0.16, 'soft-light');
  glaze(g, W, H, '#808080', sat, 'saturation');            // pull the greens back from candy
  g.save(); const vg = g.createRadialGradient(W * 0.52, H * 0.5, H * 0.35, W * 0.5, H * 0.5, W * 0.75); vg.addColorStop(0, 'rgba(20,12,24,0)'); vg.addColorStop(1, 'rgba(20,12,24,0.5)'); g.fillStyle = vg; g.fillRect(0, 0, W, H); g.restore();
}
register('ui_menu_bg', { w: 1280, h: 720, family: F, note: 'title screen painting (staged: paintVista)', paint(g, W, rnd, H) { for (const _ of paintVista(g, W, H, rnd)); } });
