// Texture family: ui. The 2D interface skin, painted like WoW Classic's UI art:
// parchment, dark slate, stained wood, gold and silver frames with corner
// filigree, red gold-rimmed buttons, glossy status bars, small painted glyph
// icons, and a painted vista for the title screen. See docs/ART.md.
//
// Most of these are applied to the DOM: labels.js turns them into blob URLs
// and sets CSS custom properties (--tx-parchment, --tx-frame-gold, ...), which
// style.css uses as backgrounds and 9-slice border-images.
//
//   tiling:    ui_parchment ui_stone ui_wood ui_leather ui_bar
//   9-slice:   ui_frame_gold (192, slice 64)  ui_frame_silver (96, slice 32)
//              ui_btn_red / ui_btn_stone (128x40, slice 14)  ui_editbox (64, slice 16)
//   sprites:   ui_filigree (512x64)  ui_endcap (160x128)  ui_seal (96)  ui_menu_bg (1280x720)
//   icons 64:  ui_ico_<crown coin hourglass scroll hook key sun mic micoff speaker
//              speakeroff walkie gear close ping skull>
import {
  register, mottle, streaks, blob, ellipse, stroke, cracks, glaze, blurTile, fill, vgrad, rgba, mix, shade,
  lightOf, shadowOf, wrap, range, pick, rowLayout, paintRects, makeCanvas, jitter, blade,
} from './core.js';

const F = 'ui';

// ---- metal & emboss helpers -------------------------------------------------------------

export const PAL = {
  gold:   { hi: '#fff3c2', light: '#f3d06a', mid: '#c99433', low: '#8c5c1b', dark: '#4b2e0c', line: '#1d1004' },
  silver: { hi: '#ffffff', light: '#e1e3e8', mid: '#a7abb4', low: '#6d717b', dark: '#3d4048', line: '#121318' },
  iron:   { hi: '#c4c7cd', light: '#8b9099', mid: '#5c616a', low: '#3d4149', dark: '#25282e', line: '#0b0c0e' },
  red:    { hi: '#ffb08a', light: '#d64a30', mid: '#a32616', low: '#6c130a', dark: '#3e0804', line: '#170302' },
  bone:   { hi: '#fffaf0', light: '#efe6d0', mid: '#cfc2a2', low: '#97896b', dark: '#5c5240', line: '#1e1a12' },
  wood:   { hi: '#d9a86a', light: '#a8733f', mid: '#7a4f28', low: '#523318', dark: '#2e1c0c', line: '#120a04' },
  slate:  { hi: '#9aa0ab', light: '#6c717c', mid: '#4a4e57', low: '#33363d', dark: '#202227', line: '#0a0b0d' },
  green:  { hi: '#d8f0a0', light: '#8fbf4a', mid: '#5b8a2c', low: '#3a5d1a', dark: '#1f350b', line: '#0b1404' },
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

// Paint a mask as a lit, beveled, painted solid (metal, wood, bone...): soft drop
// shadow, dark outline, ramp body with painterly mottling, warm lit rim on the
// upper-left, cool shaded rim on the lower-right, a few glints.
function emboss(g, m, pal, rnd, { d = 2, outline = 1.2, shadow = 0.6, ramp = null, mottleAmt = 0.35, glints = 3, x = 0, y = 0, hiAlpha = 0.95 } = {}) {
  const w = m.width, h = m.height;
  // drop shadow (down-right, soft, cool-dark)
  if (shadow > 0) {
    g.save(); g.filter = `blur(${Math.max(1, d)}px)`; g.globalAlpha = shadow;
    g.drawImage(tint(m, '#120a10'), x + d * 0.9, y + d * 1.4);
    g.restore();
  }
  // outline: the mask dilated
  if (outline > 0) {
    const o = tint(m, pal.line);
    for (let a = 0; a < 8; a++) g.drawImage(o, x + Math.cos(a * Math.PI / 4) * outline, y + Math.sin(a * Math.PI / 4) * outline);
  }
  // body
  const [b, bg] = layer(w, h);
  const r = ramp || [0, h];
  const gr = bg.createLinearGradient(0, r[0], w * 0.25, r[1]);
  gr.addColorStop(0, pal.light); gr.addColorStop(0.45, pal.mid); gr.addColorStop(1, pal.low);
  bg.fillStyle = gr; bg.fillRect(0, 0, w, h);
  if (mottleAmt > 0) {
    for (let i = 0; i < Math.max(6, (w * h) / 500); i++) {
      const c = pick(rnd, [pal.light, pal.low, pal.mid, pal.hi]);
      blob(bg, rnd() * w, rnd() * h, range(rnd, 2, Math.max(4, Math.min(w, h) * 0.25)), range(rnd, 2, Math.max(3, Math.min(w, h) * 0.15)), rnd() * 3, c, mottleAmt * range(rnd, 0.3, 0.8), 0.15);
    }
  }
  bg.globalCompositeOperation = 'destination-in'; bg.drawImage(m, 0, 0);
  g.drawImage(b, x, y);
  // bevel rims
  g.save(); g.globalAlpha = hiAlpha; g.drawImage(rim(m, d, d, pal.hi, d * 0.45), x, y); g.restore();
  g.save(); g.globalAlpha = 0.85; g.drawImage(rim(m, -d, -d, pal.dark, d * 0.45), x, y); g.restore();
  // glints on the lit side
  const [gl, glg] = layer(w, h);
  for (let i = 0; i < glints; i++) blob(glg, range(rnd, w * 0.1, w * 0.6), range(rnd, h * 0.08, h * 0.45), range(rnd, 1.5, 3.5), range(rnd, 1, 2), rnd() * 3, '#fffbe8', 0.7, 0.4);
  glg.globalCompositeOperation = 'destination-in'; glg.drawImage(rim(m, d * 1.5, d * 1.5, '#fff', 0), 0, 0);
  g.drawImage(gl, x, y);
}

// ruby / sapphire cabochon
function gem(g, x, y, r, color = '#b3261e') {
  blob(g, x + r * 0.25, y + r * 0.35, r * 1.25, r * 1.15, 0, '#0c0406', 0.55, 0.3);
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

// ---- tiling surfaces ----------------------------------------------------------------------

// Aged parchment for quest-log style panels (receipt, help, game over).
register('ui_parchment', { size: 512, family: F, note: 'tiles; quest parchment', paint(g, s, rnd) {
  fill(g, s, s, '#e2cb98');
  mottle(g, s, rnd, { colors: ['#eedcae', '#d9be88', '#e8d29f', '#d2b47e', '#f2e3bb'], count: 80, rmin: 50, rmax: 170, alpha: 0.4, hard: 0.05 });
  mottle(g, s, rnd, { colors: ['#c9a46a', '#bf9760', '#d6b57c'], count: 30, rmin: 12, rmax: 46, alpha: 0.2, hard: 0.1 });
  // fibres, mostly horizontal
  streaks(g, s, rnd, { colors: ['#c3a26c', '#f4e7c6', '#d4b985'], count: 320, len: [8, 34], width: [0.5, 1.2], angle: Math.PI / 2, wobble: 0.9, alpha: 0.22 });
  // foxing: small rust-brown spots
  for (let i = 0; i < 36; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.2, 4.5);
    wrap(s, x, y, r * 3, (xx, yy) => { blob(g, xx, yy, r * 2.4, r * 2, rnd() * 3, '#b78a55', 0.18, 0.1); blob(g, xx, yy, r, r * 0.8, 0, '#8e6236', 0.28, 0.4); });
  }
  // a couple of faint tide-line stains
  for (let i = 0; i < 4; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 30, 70);
    wrap(s, x, y, r + 4, (xx, yy) => {
      g.save(); g.strokeStyle = rgba('#a77d4b', 0.12); g.lineWidth = range(rnd, 1.2, 2.4);
      g.beginPath(); g.ellipse(xx, yy, r, r * range(rnd, 0.6, 0.9), rnd() * 3, 0, Math.PI * 2); g.stroke(); g.restore();
    });
  }
  blurTile(g.canvas, 0.6);
  glaze(g, s, s, '#f3dca4', 0.25, 'soft-light');
} });

// Dark slate: the backing of HUD plates, popups and the voice panel.
register('ui_stone', { size: 256, family: F, note: 'tiles; dark slate backing', paint(g, s, rnd) {
  fill(g, s, s, '#2a2a30');
  mottle(g, s, rnd, { colors: ['#34343c', '#232328', '#383229', '#262a34', '#2f2d33'], count: 70, rmin: 14, rmax: 70, alpha: 0.5, hard: 0.15 });
  streaks(g, s, rnd, { colors: ['#45434b', '#3b3a40'], count: 26, len: [20, 90], width: [0.6, 1.6], angle: 1.2, wobble: 0.9, alpha: 0.3 });
  cracks(g, s, rnd, { color: '#121115', count: 7, len: [24, 80], width: [0.7, 1.6], alpha: 0.55 });
  for (let i = 0; i < 50; i++) {
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

// Gold dialog frame. 192px, slice 64. The band runs 24..42px from the outer edge,
// corners carry a boss with a ruby and two filigree curls, and a soft inner
// shadow (42..64) falls onto whatever the frame sits on.
register('ui_frame_gold', { size: 192, family: F, alpha: true, note: '9-slice 64; gold band + corner filigree', paint(g, s, rnd) {
  const A = 24, B = 42;
  // inner shadow cast on the panel
  for (let i = 0; i < 10; i++) {
    const k = i / 10;
    g.strokeStyle = rgba('#140a06', 0.22 * (1 - k)); g.lineWidth = 2.2;
    g.strokeRect(B + i * 2.1, B + i * 2.1, s - 2 * (B + i * 2.1), s - 2 * (B + i * 2.1));
  }
  const m = mask(s, s, mg => {
    const outer = rr(A, A, s - 2 * A, s - 2 * A, 9), inner = rr(B, B, s - 2 * B, s - 2 * B, 3);
    const ring = new Path2D(); ring.addPath(outer); ring.addPath(inner);
    mg.fill(ring, 'evenodd');
    // corner bosses + filigree, mirrored into each corner
    for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      mg.save();
      mg.translate(sx > 0 ? 0 : s, sy > 0 ? 0 : s); mg.scale(sx, sy);
      mg.beginPath(); mg.moveTo(33, 9); mg.lineTo(57, 33); mg.lineTo(33, 57); mg.lineTo(9, 33); mg.closePath(); mg.fill();   // diamond boss
      curl(mg, 62, 22, 10, Math.PI * 0.95, 0.8, 5, 1);
      curl(mg, 22, 62, 10, -Math.PI * 0.45, 0.8, 5, -1);
      mg.beginPath(); mg.arc(70, 30, 3, 0, Math.PI * 2); mg.fill();
      mg.beginPath(); mg.arc(30, 70, 3, 0, Math.PI * 2); mg.fill();
      mg.restore();
    }
  });
  emboss(g, m, PAL.gold, rnd, { d: 2.2, outline: 1.4, shadow: 0.7, mottleAmt: 0.3, glints: 10 });
  // a dark groove down the middle of the band
  g.save();
  g.strokeStyle = rgba('#3a2208', 0.65); g.lineWidth = 1.6;
  g.beginPath(); g.roundRect(A + 8.5, A + 8.5, s - 2 * A - 17, s - 2 * A - 17, 5); g.stroke();
  g.strokeStyle = rgba('#fff0b8', 0.35); g.lineWidth = 1;
  g.beginPath(); g.roundRect(A + 9.7, A + 9.7, s - 2 * A - 19.4, s - 2 * A - 19.4, 5); g.stroke();
  g.restore();
  for (const [x, y] of [[33, 33], [s - 33, 33], [33, s - 33], [s - 33, s - 33]]) gem(g, x, y, 7, x < s / 2 && y < s / 2 ? '#a8231b' : '#a8231b');
} });

// Silver tooltip frame (prompt, tooltips, edit boxes). 96px, slice 32; band 8..16.
register('ui_frame_silver', { size: 96, family: F, alpha: true, note: '9-slice 32; thin silver tooltip border', paint(g, s, rnd) {
  const A = 8, B = 14;
  for (let i = 0; i < 6; i++) { g.strokeStyle = rgba('#05060a', 0.25 * (1 - i / 6)); g.lineWidth = 1.6; g.strokeRect(B + i * 1.5, B + i * 1.5, s - 2 * (B + i * 1.5), s - 2 * (B + i * 1.5)); }
  const m = mask(s, s, mg => {
    const ring = new Path2D(); ring.addPath(rr(A, A, s - 2 * A, s - 2 * A, 7)); ring.addPath(rr(B, B, s - 2 * B, s - 2 * B, 3));
    mg.fill(ring, 'evenodd');
  });
  emboss(g, m, PAL.silver, rnd, { d: 1.4, outline: 1, shadow: 0.55, mottleAmt: 0.2, glints: 4 });
} });

// Recessed edit box (name / code inputs, keypad).
register('ui_editbox', { size: 64, family: F, alpha: true, note: '9-slice 16; sunken input box', paint(g, s, rnd) {
  g.fillStyle = '#07070a'; g.beginPath(); g.roundRect(2, 2, s - 4, s - 4, 5); g.fill();
  // inner shadow top-left (sunken)
  for (let i = 0; i < 6; i++) { g.strokeStyle = rgba('#000', 0.3 * (1 - i / 6)); g.lineWidth = 1.5; g.beginPath(); g.roundRect(4 + i, 4 + i, s - 8 - 2 * i, s - 8 - 2 * i, 4); g.stroke(); }
  const m = mask(s, s, mg => { const ring = new Path2D(); ring.addPath(rr(1, 1, s - 2, s - 2, 6)); ring.addPath(rr(5, 5, s - 10, s - 10, 4)); mg.fill(ring, 'evenodd'); });
  emboss(g, m, PAL.iron, rnd, { d: -1.2, outline: 0.6, shadow: 0, mottleAmt: 0.15, glints: 0, hiAlpha: 0.7 });
} });

function button(g, w, h, rnd, body, rimPal) {
  // body
  const [b, bg] = layer(w, h);
  const gr = bg.createLinearGradient(0, 0, 0, h);
  gr.addColorStop(0, body.light); gr.addColorStop(0.42, body.mid); gr.addColorStop(1, body.dark);
  bg.fillStyle = gr; bg.fillRect(0, 0, w, h);
  for (let i = 0; i < 26; i++) blob(bg, rnd() * w, rnd() * h, range(rnd, 6, 22), range(rnd, 3, 8), 0, pick(rnd, [body.low, body.light, body.mid]), 0.25, 0.1);
  // painted gloss on the upper third
  blob(bg, w * 0.42, h * 0.22, w * 0.5, h * 0.18, 0, '#ffffff', 0.18, 0.2);
  bg.globalCompositeOperation = 'destination-in';
  bg.fillStyle = '#fff'; bg.beginPath(); bg.roundRect(5, 5, w - 10, h - 10, 4); bg.fill();
  g.drawImage(b, 0, 0);
  // inner bottom shade + top lip
  g.save(); g.beginPath(); g.roundRect(5, 5, w - 10, h - 10, 4); g.clip();
  g.fillStyle = rgba(body.dark, 0.55); g.fillRect(0, h - 10, w, 6);
  g.fillStyle = rgba(body.hi, 0.35); g.fillRect(0, 5, w, 2);
  g.restore();
  // metal rim
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
      stroke(mg, [[16, 0], [90, -1], [170, 0], [236, 0]], 5, 0.8, '#fff');       // the rule
      curl(mg, 40, -9, 11, Math.PI * 0.6, 0.85, 4.5, 1);
      curl(mg, 40, 9, 11, -Math.PI * 0.6, 0.85, 4.5, -1);
      curl(mg, 92, -6, 7, Math.PI * 0.7, 0.8, 3.2, 1);
      curl(mg, 92, 6, 7, -Math.PI * 0.7, 0.8, 3.2, -1);
      mg.beginPath(); mg.arc(132, 0, 3.2, 0, Math.PI * 2); mg.fill();
      mg.restore();
    }
    mg.beginPath(); mg.moveTo(cx, cy - 18); mg.lineTo(cx + 20, cy); mg.lineTo(cx, cy + 18); mg.lineTo(cx - 20, cy); mg.closePath(); mg.fill();
  });
  emboss(g, m, PAL.gold, rnd, { d: 1.6, outline: 1.1, shadow: 0.7, mottleAmt: 0.3, glints: 6 });
  gem(g, cx, cy, 6.5, '#a8231b');
} });

// HUD bar end cap: a gold wing of layered feathers (a nod to the gryphons that
// sit at the ends of WoW's action bar). Points left; CSS mirrors it.
register('ui_endcap', { w: 160, h: 128, family: F, alpha: true, note: 'HUD end cap; points left, mirrored in CSS', paint(g, w, rnd, h) {
  const m = mask(w, h, mg => {
    // feathers fan out from the root at the right edge
    const rx = w - 10, ry = h * 0.42;
    for (let i = 0; i < 6; i++) {
      const a = Math.PI + 0.55 - i * 0.2;
      const L = 120 - i * 13;
      const pts = [];
      for (let k = 0; k <= 6; k++) { const t = k / 6; pts.push([rx + Math.cos(a + t * 0.25) * L * t, ry + Math.sin(a + t * 0.25) * L * t * 0.9 + t * t * 10]); }
      stroke(mg, pts, 24 - i * 1.6, 3, '#fff');
    }
    mg.beginPath(); mg.ellipse(rx - 6, ry + 6, 22, 30, 0, 0, Math.PI * 2); mg.fill();   // the shoulder
  });
  emboss(g, m, PAL.gold, rnd, { d: 2, outline: 1.3, shadow: 0.7, mottleAmt: 0.35, glints: 8 });
  // feather separations
  const rx = w - 10, ry = h * 0.42;
  for (let i = 0; i < 6; i++) {
    const a = Math.PI + 0.55 - i * 0.2 - 0.1, L = 110 - i * 13, pts = [];
    for (let k = 1; k <= 6; k++) { const t = k / 6; pts.push([rx + Math.cos(a + t * 0.25) * L * t, ry + Math.sin(a + t * 0.25) * L * t * 0.9 + t * t * 10 + 4]); }
    stroke(g, pts, 1.6, 0.4, '#4b2e0c', 0.6);
  }
  gem(g, rx - 8, ry + 6, 8, '#23559e');
} });

// Red wax seal (the receipt is official).
register('ui_seal', { size: 96, family: F, alpha: true, note: 'wax seal', paint(g, s, rnd) {
  const m = mask(s, s, mg => {
    mg.beginPath();
    for (let i = 0; i <= 40; i++) { const a = i / 40 * Math.PI * 2, r = 36 + Math.sin(i * 2.7) * 3 + range(rnd, -2, 2); mg.lineTo(s / 2 + Math.cos(a) * r, s / 2 + Math.sin(a) * r); }
    mg.closePath(); mg.fill();
  });
  emboss(g, m, PAL.red, rnd, { d: 2.5, outline: 1, shadow: 0.6, mottleAmt: 0.3, glints: 3 });
  const c = mask(s, s, mg => { mg.lineWidth = 4; mg.beginPath(); mg.arc(s / 2, s / 2, 24, 0, Math.PI * 2); mg.stroke(); });
  g.drawImage(rim(c, -1.5, -1.5, '#ff9c7c', 0.6), 0, 0); g.drawImage(rim(c, 1.5, 1.5, '#3a0603', 0.6), 0, 0);
  // stamped "$"
  g.save(); g.font = 'bold 34px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = 'rgba(255,170,140,0.55)'; g.fillText('$', s / 2 - 1, s / 2 - 1);
  g.fillStyle = 'rgba(50,6,3,0.7)'; g.fillText('$', s / 2 + 1, s / 2 + 1);
  g.fillStyle = '#8e1f12'; g.fillText('$', s / 2, s / 2);
  g.restore();
} });

// ---- icons (64px glyphs, painted) ---------------------------------------------------------

function icon(name, note, fn) { register(`ui_ico_${name}`, { size: 64, family: F, alpha: true, note, paint(g, s, rnd) { fn(g, s, rnd); } }); }

icon('crown', 'party leader', (g, s, rnd) => {
  const m = mask(s, s, mg => {
    mg.beginPath(); mg.moveTo(12, 48); mg.lineTo(9, 20); mg.lineTo(22, 32); mg.lineTo(32, 13); mg.lineTo(42, 32); mg.lineTo(55, 20); mg.lineTo(52, 48); mg.closePath(); mg.fill();
    mg.fillRect(11, 44, 42, 9);
    for (const [x, y] of [[9, 18], [32, 11], [55, 18]]) { mg.beginPath(); mg.arc(x, y, 4, 0, Math.PI * 2); mg.fill(); }
  });
  emboss(g, m, PAL.gold, rnd, { d: 1.8, outline: 1.3 });
  gem(g, 32, 48, 3.6, '#2c62b5'); gem(g, 20, 48.5, 2.6, '#a8231b'); gem(g, 44, 48.5, 2.6, '#a8231b');
});

icon('coin', 'money', (g, s, rnd) => {
  const m1 = mask(s, s, mg => { mg.beginPath(); mg.ellipse(38, 40, 18, 17, 0, 0, Math.PI * 2); mg.fill(); });
  emboss(g, m1, PAL.gold, rnd, { d: 2, outline: 1.2 });
  const m2 = mask(s, s, mg => { mg.beginPath(); mg.ellipse(26, 28, 18, 17, 0, 0, Math.PI * 2); mg.fill(); });
  emboss(g, m2, PAL.gold, rnd, { d: 2, outline: 1.2 });
  const r = mask(s, s, mg => { mg.lineWidth = 2.6; mg.beginPath(); mg.ellipse(26, 28, 11.5, 11, 0, 0, Math.PI * 2); mg.stroke(); });
  g.drawImage(rim(r, 1.2, 1.2, '#fff3c2', 0.4), 0, 0); g.drawImage(rim(r, -1.2, -1.2, '#6b420f', 0.4), 0, 0);
});

icon('hourglass', 'clock', (g, s, rnd) => {
  // glass
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
  const m = mask(s, s, mg => { mg.fillRect(13, 8, 38, 7); mg.fillRect(13, 49, 38, 7); mg.fillRect(15, 14, 3.5, 36); mg.fillRect(45.5, 14, 3.5, 36); });
  emboss(g, m, PAL.wood, rnd, { d: 1.4, outline: 1.1 });
});

icon('scroll', 'payment due', (g, s, rnd) => {
  const m = mask(s, s, mg => { mg.fillRect(16, 12, 32, 40); });
  emboss(g, m, { ...PAL.bone, light: '#f3e2b8', mid: '#dcc28e', low: '#a98c5c' }, rnd, { d: 1.5, outline: 1.1, glints: 0 });
  for (let i = 0; i < 5; i++) stroke(g, [[21, 19 + i * 6], [21 + range(rnd, 14, 22), 19 + i * 6 + range(rnd, -0.6, 0.6)]], 1.4, 1, '#5b4128', 0.6);
  const rolls = mask(s, s, mg => { mg.beginPath(); mg.roundRect(11, 7, 42, 8, 4); mg.fill(); mg.beginPath(); mg.roundRect(11, 49, 42, 8, 4); mg.fill(); });
  emboss(g, rolls, { ...PAL.bone, light: '#efdcae', mid: '#cdb07a', low: '#8c7048' }, rnd, { d: 1.5, outline: 1.1, glints: 1 });
  const seal = mask(s, s, mg => { mg.beginPath(); mg.arc(42, 42, 7, 0, Math.PI * 2); mg.fill(); });
  emboss(g, seal, PAL.red, rnd, { d: 1.4, outline: 0.9, glints: 1 });
});

icon('hook', 'repo strikes: the tow hook', (g, s, rnd) => {
  const m = mask(s, s, mg => {
    mg.lineWidth = 8;
    mg.beginPath(); mg.moveTo(34, 18); mg.lineTo(34, 36); mg.arc(25, 38, 9, 0, Math.PI, false); mg.stroke();
    mg.beginPath(); mg.moveTo(16, 38); mg.lineTo(11, 31); mg.lineTo(20, 33); mg.closePath(); mg.fill();
    mg.lineWidth = 4.5; mg.beginPath(); mg.ellipse(34, 11, 4.5, 6.5, 0, 0, Math.PI * 2); mg.stroke();
  });
  emboss(g, m, PAL.iron, rnd, { d: 1.6, outline: 1.2, glints: 3 });
  // a little rust
  for (let i = 0; i < 5; i++) blob(g, range(rnd, 18, 38), range(rnd, 24, 46), range(rnd, 1.5, 3), range(rnd, 1, 2), 0, '#7a3a14', 0.35, 0.3);
});

icon('key', 'room code', (g, s, rnd) => {
  const m = mask(s, s, mg => {
    mg.lineWidth = 6; mg.beginPath(); mg.arc(20, 22, 9, 0, Math.PI * 2); mg.stroke();
    mg.save(); mg.translate(20, 22); mg.rotate(0.75);
    mg.fillRect(8, -3, 34, 6); mg.fillRect(32, 2, 4, 8); mg.fillRect(38, 2, 4, 6);
    mg.restore();
  });
  emboss(g, m, PAL.gold, rnd, { d: 1.6, outline: 1.2 });
});

icon('sun', 'day', (g, s, rnd) => {
  const m = mask(s, s, mg => {
    mg.beginPath();
    for (let i = 0; i <= 32; i++) { const a = i / 32 * Math.PI * 2, r = i % 2 ? 15 : 25; mg.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r); }
    mg.closePath(); mg.fill();
  });
  emboss(g, m, PAL.gold, rnd, { d: 1.5, outline: 1.1 });
  const c = mask(s, s, mg => { mg.beginPath(); mg.arc(32, 32, 12, 0, Math.PI * 2); mg.fill(); });
  emboss(g, c, { ...PAL.gold, light: '#ffe48a', mid: '#f0b437', low: '#c07a1a' }, rnd, { d: 1.6, outline: 1, shadow: 0.4 });
});

function micShape(mg) {
  mg.beginPath(); mg.roundRect(24, 8, 16, 28, 8); mg.fill();
  mg.lineWidth = 3.5; mg.beginPath(); mg.arc(32, 28, 13, 0.1, Math.PI - 0.1); mg.stroke();
  mg.fillRect(30.5, 40, 3, 9); mg.beginPath(); mg.roundRect(21, 48, 22, 5, 2); mg.fill();
}
function grille(g) { for (let i = 0; i < 4; i++) stroke(g, [[27, 14 + i * 5], [37, 14 + i * 5]], 1.3, 1.3, '#16181c', 0.7); }
function slash(g, s) {
  stroke(g, [[12, 52], [52, 12]], 8, 8, '#1a0302', 0.9);
  stroke(g, [[12, 52], [52, 12]], 5.5, 5.5, '#c8301e', 1);
  stroke(g, [[13, 50], [50, 13]], 1.5, 1.5, '#ff9a7a', 0.7);
}
icon('mic', 'voice: live', (g, s, rnd) => { const m = mask(s, s, micShape); emboss(g, m, PAL.silver, rnd, { d: 1.5, outline: 1.2 }); grille(g); });
icon('micoff', 'voice: muted', (g, s, rnd) => { const m = mask(s, s, micShape); emboss(g, m, PAL.iron, rnd, { d: 1.5, outline: 1.2 }); grille(g); slash(g, s); });

function speakerShape(mg) { mg.fillRect(10, 24, 11, 16); mg.beginPath(); mg.moveTo(19, 24); mg.lineTo(33, 12); mg.lineTo(33, 52); mg.lineTo(19, 40); mg.closePath(); mg.fill(); }
icon('speaker', 'voice peer', (g, s, rnd) => {
  const m = mask(s, s, mg => { speakerShape(mg); mg.lineWidth = 4; for (const r of [9, 17]) { mg.beginPath(); mg.arc(34, 32, r, -0.75, 0.75); mg.stroke(); } });
  emboss(g, m, PAL.silver, rnd, { d: 1.5, outline: 1.2 });
});
icon('speakeroff', 'voice peer muted', (g, s, rnd) => {
  const m = mask(s, s, speakerShape);
  emboss(g, m, PAL.iron, rnd, { d: 1.5, outline: 1.2 });
  for (const [a, b] of [[[40, 24], [54, 40]], [[54, 24], [40, 40]]]) { stroke(g, [a, b], 7, 7, '#1a0302', 0.9); stroke(g, [a, b], 4.5, 4.5, '#c8301e', 1); }
});

icon('walkie', 'walkie-talkie', (g, s, rnd) => {
  const ant = mask(s, s, mg => { mg.fillRect(36, 3, 5, 18); });
  emboss(g, ant, PAL.iron, rnd, { d: 1.2, outline: 1 });
  const m = mask(s, s, mg => { mg.beginPath(); mg.roundRect(18, 16, 28, 44, 6); mg.fill(); });
  emboss(g, m, { ...PAL.iron, light: '#7d8a6a', mid: '#525e45', low: '#343d2c' }, rnd, { d: 1.6, outline: 1.2 });
  g.fillStyle = '#2a1c08'; g.fillRect(23, 22, 18, 9);
  const sg = g.createLinearGradient(23, 22, 41, 31); sg.addColorStop(0, '#ffd77a'); sg.addColorStop(1, '#c98a1e');
  g.fillStyle = sg; g.fillRect(24, 23, 16, 7);
  for (let i = 0; i < 4; i++) stroke(g, [[24, 38 + i * 4.5], [40, 38 + i * 4.5]], 1.6, 1.6, '#1c2116', 0.8);
});

icon('gear', 'settings', (g, s, rnd) => {
  const m = mask(s, s, mg => {
    mg.beginPath();
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a0 = i / n * Math.PI * 2;
      for (const [da, r] of [[-0.2, 17], [-0.12, 25], [0.12, 25], [0.2, 17]]) mg.lineTo(32 + Math.cos(a0 + da) * r, 32 + Math.sin(a0 + da) * r);
    }
    mg.closePath(); mg.fill();
    mg.globalCompositeOperation = 'destination-out'; mg.beginPath(); mg.arc(32, 32, 7, 0, Math.PI * 2); mg.fill();
  });
  emboss(g, m, PAL.iron, rnd, { d: 1.6, outline: 1.2 });
});

icon('close', 'close / leave', (g, s, rnd) => {
  const m = mask(s, s, mg => { mg.beginPath(); mg.roundRect(8, 8, 48, 48, 9); mg.fill(); });
  emboss(g, m, PAL.gold, rnd, { d: 1.4, outline: 1.2 });
  const inner = mask(s, s, mg => { mg.beginPath(); mg.roundRect(13, 13, 38, 38, 6); mg.fill(); });
  emboss(g, inner, PAL.red, rnd, { d: -1.4, outline: 0, shadow: 0, glints: 0 });
  const x = mask(s, s, mg => { mg.lineWidth = 6; mg.beginPath(); mg.moveTo(22, 22); mg.lineTo(42, 42); mg.moveTo(42, 22); mg.lineTo(22, 42); mg.stroke(); });
  emboss(g, x, PAL.gold, rnd, { d: 1.2, outline: 1, shadow: 0.5, glints: 1 });
});

icon('ping', 'map ping marker', (g, s, rnd) => {
  blob(g, 32, 56, 18, 5, 0, '#ffd34a', 0.5, 0.2);
  const m = mask(s, s, mg => { mg.beginPath(); mg.moveTo(32, 58); mg.bezierCurveTo(18, 38, 14, 30, 14, 22); mg.arc(32, 22, 18, Math.PI, 0); mg.bezierCurveTo(50, 30, 46, 38, 32, 58); mg.fill(); });
  emboss(g, m, PAL.gold, rnd, { d: 2, outline: 1.4 });
  gem(g, 32, 22, 7, '#a8231b');
});

icon('skull', 'knocked out', (g, s, rnd) => {
  const m = mask(s, s, mg => { mg.beginPath(); mg.arc(32, 27, 18, 0, Math.PI * 2); mg.fill(); mg.beginPath(); mg.roundRect(22, 36, 20, 16, 4); mg.fill(); });
  emboss(g, m, PAL.bone, rnd, { d: 1.8, outline: 1.2, glints: 2 });
  for (const x of [25, 39]) { ellipse(g, x, 29, 5, 5.5, 0, '#2a1f18', 0.95); ellipse(g, x - 1, 28, 2, 2, 0, '#4a3a2e', 0.6); }
  g.fillStyle = '#2a1f18'; g.beginPath(); g.moveTo(32, 34); g.lineTo(29, 40); g.lineTo(35, 40); g.closePath(); g.fill();
  for (const x of [27, 32, 37]) stroke(g, [[x, 45], [x, 51]], 1.5, 1.5, '#3a2e24', 0.8);
});

// ---- the title-screen vista ----------------------------------------------------------------

// A painted golden-hour road vista (the login screen). Big soft shapes first,
// then medium shapes, then detail; light from the sun at the right of center.
register('ui_menu_bg', { w: 1280, h: 720, family: F, note: 'title screen painting', paint(g, W, rnd, H) {
  const HZ = H * 0.6;                      // horizon
  const SX = W * 0.6, SY = HZ - 40;        // sun
  // sky
  vgrad(g, W, H, [[0, '#2f5d96'], [0.18, '#4f7fb6'], [0.36, '#93b4cf'], [0.5, '#e2d3ac'], [0.58, '#f5cd8a'], [0.64, '#f0b46e'], [1, '#c98a52']]);
  blob(g, SX, SY, 560, 300, 0, '#ffe7a8', 0.5, 0.05);
  blob(g, SX, SY, 170, 120, 0, '#fff6d8', 0.75, 0.1);
  blob(g, SX, SY, 46, 44, 0, '#fffdf2', 0.95, 0.55);
  // clouds: soft clusters, lavender undersides, warm sunlit rims
  const cloud = (cx, cy, cw, ch, n) => {
    // big cauliflower lobes on a flat-ish base, small lobes at the ends
    const parts = [];
    for (let i = 0; i < n; i++) {
      const t = rnd(), bell = Math.sin(t * Math.PI);
      const r = ch * (0.25 + bell * range(rnd, 0.45, 0.85));
      parts.push([cx + (t - 0.5) * cw, cy - r * range(rnd, 0.2, 0.75), r]);
    }
    parts.sort((p, q) => q[2] - p[2]);
    const near = 1 - Math.min(1, Math.hypot(cx - SX, cy - SY) / 700);
    blob(g, cx, cy + ch * 0.08, cw * 0.55, ch * 0.22, 0, '#9b92b6', 0.45, 0.3);                     // shaded base
    for (const [x, y, r] of parts) blob(g, x + r * 0.1, y + r * 0.22, r * 1.05, r * 0.85, 0, '#a49cbc', 0.55, 0.45);
    for (const [x, y, r] of parts) blob(g, x, y, r, r * 0.86, 0, mix('#efe3da', '#ffe3b6', near), 0.85, 0.55);
    for (const [x, y, r] of parts) blob(g, x - r * 0.22, y - r * 0.32, r * 0.62, r * 0.48, 0, mix('#fffaf0', '#fff1cc', near), 0.75, 0.4);
    g.save(); g.globalCompositeOperation = 'multiply';
    blob(g, cx, cy + ch * 0.12, cw * 0.5, ch * 0.14, 0, '#c9bfd6', 0.6, 0.3);
    g.restore();
  };
  cloud(W * 0.18, H * 0.16, 360, 90, 22);
  cloud(W * 0.8, H * 0.13, 420, 80, 24);
  cloud(W * 0.44, H * 0.31, 280, 40, 14);
  cloud(W * 0.95, H * 0.4, 240, 32, 12);
  cloud(W * 0.04, H * 0.41, 220, 28, 12);
  // distant ridgelines
  const ridge = (y0, amp, rough, seedShift) => {
    let pts = [[-20, y0], [W + 20, y0]];
    let a = amp;
    for (let k = 0; k < 7; k++) {
      const next = [];
      for (let i = 0; i < pts.length - 1; i++) {
        const [x0, ya] = pts[i], [x1, yb] = pts[i + 1];
        next.push(pts[i], [(x0 + x1) / 2 + range(rnd, -4, 4), (ya + yb) / 2 + (rnd() - 0.6 + seedShift) * a]);
      }
      next.push(pts[pts.length - 1]);
      pts = next; a *= rough;
    }
    return pts;
  };
  const fillRidge = (pts, top, bottom, yTop, yBot, hazeCol, haze) => {
    const p = new Path2D(); p.moveTo(-20, H); for (const [x, y] of pts) p.lineTo(x, y); p.lineTo(W + 20, H); p.closePath();
    g.save(); g.clip(p);
    const gr = g.createLinearGradient(0, yTop, 0, yBot); gr.addColorStop(0, top); gr.addColorStop(1, bottom);
    g.fillStyle = gr; g.fillRect(0, 0, W, H);
    return p;
  };
  // far snowy range: big painted peaks, lit faces toward the sun, snowfields on top
  const peaks = (base, list, noise) => {
    const pts = [];
    for (let x = -20; x <= W + 20; x += 6) {
      let h = 0;
      for (const [c, ph, pw] of list) { const t = Math.max(0, 1 - Math.abs(x - c) / pw); h = Math.max(h, ph * Math.pow(t, 1.25)); }
      pts.push([x, base - h + Math.sin(x * 0.09) * noise + Math.sin(x * 0.23 + 1) * noise * 0.5 + range(rnd, -1, 1) * noise * 0.3]);
    }
    return pts;
  };
  const far = peaks(HZ - 40, [[60, 170, 190], [260, 120, 160], [430, 205, 210], [640, 150, 170], [820, 230, 230], [1010, 140, 150], [1180, 190, 200], [1330, 120, 150]], 5);
  fillRidge(far, '#7f86ad', '#c7c0c4', HZ - 260, HZ);
  for (let i = 0; i < 260; i++) {                 // painted rock masses: cool in the shade, warm-gray where lit
    const x = rnd() * W, y = range(rnd, HZ - 230, HZ - 10);
    blob(g, x, y, range(rnd, 10, 34), range(rnd, 4, 12), range(rnd, -0.5, 0.5), pick(rnd, ['#9a9cc0', '#73789f', '#b4aec0', '#8c86a6', '#a99fae']), 0.28, 0.25);
  }
  for (let i = 1; i < far.length - 1; i++) {
    const [x0, y0] = far[i - 1], [x1, y1] = far[i + 1], [x, y] = far[i];
    const slope = (y1 - y0) / (x1 - x0 || 1);
    const lit = slope > 0.05 ? 1 : slope < -0.05 ? -1 : 0;
    if (i % 2) continue;
    const depth = range(rnd, 18, 70);
    const col = lit > 0 ? '#b9b3c4' : lit < 0 ? '#646893' : '#8a8fb2';
    const dx = Math.max(-1.2, Math.min(1.2, slope)) * depth * 0.9;          // run down the slope, not straight down
    stroke(g, [[x, y + 4], [x + dx * 0.5, y + depth * 0.55], [x + dx, y + depth]], range(rnd, 4, 9), 1, col, 0.22);
    if (rnd() < 0.25) stroke(g, [[x - 14, y + depth * 0.6], [x + 16, y + depth * 0.6 + range(rnd, -3, 3)]], 2.5, 1, lit > 0 ? '#d6cfd8' : '#55597f', 0.25);
  }
  {
    const snow = new Path2D(); snow.moveTo(-20, HZ);
    for (const [x, y] of far) snow.lineTo(x, y);
    for (let i = far.length - 1; i >= 0; i--) { const [x, y] = far[i]; snow.lineTo(x, Math.max(y, HZ - 175 + Math.sin(x * 0.05) * 16 + Math.sin(x * 0.13) * 10 + Math.sin(x * 0.31) * 5) + 2); }
    snow.closePath();
    g.save(); g.clip(snow);
    g.fillStyle = '#e9e5ee'; g.fillRect(0, 0, W, H);
    for (let i = 1; i < far.length - 1; i++) {
      const [x0, y0] = far[i - 1], [x1, y1] = far[i + 1], [x, y] = far[i];
      const slope = (y1 - y0) / (x1 - x0 || 1);
      stroke(g, [[x, y], [x + slope * 10, y + range(rnd, 20, 60)]], range(rnd, 6, 14), 2, slope > 0 ? '#fff6e6' : '#9ea3c8', 0.55);
    }
    g.restore();
  }
  blob(g, SX, HZ - 40, 460, 110, 0, '#ffe2b4', 0.5, 0.1);   // sun haze over the range
  g.restore();
  // mid range: blue-green forested ridges
  const mid = ridge(HZ - 22, 70, 0.5, 0.15);
  fillRidge(mid, '#5f7f86', '#9fae9a', HZ - 90, HZ);
  for (let i = 0; i < 260; i++) {                 // conifer tips on the ridge
    const x = rnd() * W;
    let yy = HZ; for (let k = 1; k < mid.length; k++) if (mid[k][0] >= x) { const [x0, y0] = mid[k - 1], [x1, y1] = mid[k]; yy = y0 + (y1 - y0) * ((x - x0) / (x1 - x0 || 1)); break; }
    const y = yy + range(rnd, 2, 40), h = range(rnd, 7, 15);
    stroke(g, [[x, y + h * 0.3], [x, y - h]], h * 0.5, 0.5, pick(rnd, ['#4b6a6c', '#56767a', '#40605f']), 0.8);
  }
  blob(g, SX, HZ - 5, 380, 50, 0, '#ffe0b0', 0.4, 0.1);
  g.restore();
  // rolling hills (Elwynn green), lit from the sun side
  const hills = (y0, amp, f, ph, top, bot) => {
    const pts = [];
    for (let x = -20; x <= W + 20; x += 10) pts.push([x, y0 - amp * (0.55 * Math.sin(x * f + ph) + 0.3 * Math.sin(x * f * 2.3 + ph * 1.7) + 0.15 * Math.sin(x * f * 5.1 + ph * 0.3))]);
    return [pts, fillRidge(pts, top, bot, y0 - amp, y0 + 60)];
  };
  let [hp] = hills(HZ + 8, 26, 0.006, 1.2, '#7f9c4c', '#5b7c33');
  mottle(g, W, rnd, { colors: ['#8fae55', '#5f8034', '#a2b860'], count: 40, rmin: 20, rmax: 70, alpha: 0.3, stretch: 2.5, rot: 0 });
  for (let i = 0; i < 70; i++) {                  // tree clumps on the far hills
    const x = rnd() * W, y = HZ - 6 + rnd() * 26, r = range(rnd, 4, 9);
    blob(g, x + 2, y + 2, r * 1.2, r * 0.7, 0, '#2e4220', 0.6, 0.3);
    ellipse(g, x, y - r * 0.3, r, r * 0.85, 0, '#3f5f28', 0.95);
    blob(g, x - r * 0.3 + 1, y - r * 0.7, r * 0.55, r * 0.4, 0, '#8bae4c', 0.75, 0.3);
  }
  g.restore();
  // the ground plane
  const ground = new Path2D(); ground.rect(-10, HZ + 18, W + 20, H);
  [hp] = hills(HZ + 46, 30, 0.0042, 3.1, '#7a9a3f', '#4f7a2a');
  mottle(g, W, rnd, { colors: ['#86a648', '#4b7428', '#9cb447', '#6f9c34'], count: 70, rmin: 30, rmax: 120, alpha: 0.35, stretch: 3, rot: 0 });
  g.restore();
  // dirt road in perspective, curving off toward the sun
  const VX = W * 0.56;
  const at = (z, u) => {           // z: depth (1 near .. 60 far), u: -1..1 across the road
    const s = 1 / z;
    const lat = Math.sin(z * 0.17 + 0.6) * 2.2 - 0.4 + (z > 14 ? (z - 14) * 0.05 : 0);
    return [VX + (lat + u * 1.15) * W * 0.26 * s, HZ + 22 + (H - HZ) * 0.92 * s];
  };
  const road = new Path2D();
  const Z = []; for (let z = 0.85; z < 70; z *= 1.06) Z.push(z);
  Z.forEach((z, i) => { const [x, y] = at(z, -1); i ? road.lineTo(x, y) : road.moveTo(x, y); });
  for (let i = Z.length - 1; i >= 0; i--) { const [x, y] = at(Z[i], 1); road.lineTo(x, y); }
  road.closePath();
  g.save(); g.clip(road);
  vgrad(g, W, H, [[0, '#d2a979'], [0.62, '#c49866'], [0.75, '#9a7650'], [1, '#7c5b3a']]);
  for (let i = 0; i < 160; i++) { const z = range(rnd, 0.9, 30), u = range(rnd, -1, 1), [x, y] = at(z, u), sc = 1 / z; blob(g, x, y, range(rnd, 18, 60) * sc * 3, range(rnd, 4, 12) * sc * 3, 0, pick(rnd, ['#8a6640', '#b18c5c', '#6f5033', '#c8a272']), 0.3, 0.15); }
  for (const u of [-0.45, 0.45]) {                // wheel ruts
    const pts = Z.filter(z => z < 40).map(z => at(z, u + Math.sin(z) * 0.03));
    for (let i = 0; i < pts.length - 1; i++) { const w = 26 / Z[i]; stroke(g, [pts[i], pts[i + 1]], w, w * 0.94, '#5e4430', 0.35); stroke(g, [[pts[i][0] - w * 0.3, pts[i][1] - 1], [pts[i + 1][0] - w * 0.3, pts[i + 1][1] - 1]], w * 0.3, w * 0.28, '#e0bd8c', 0.25); }
  }
  for (let i = 0; i < 40; i++) { const z = range(rnd, 0.9, 3.5), [x, y] = at(z, pick(rnd, [-0.8, -0.45, 0, 0.45, 0.82]) + range(rnd, -0.12, 0.12)), r = range(rnd, 2, 6) / z; ellipse(g, x + r * 0.4, y + r * 0.4, r, r * 0.6, 0, '#4b3826', 0.45); ellipse(g, x, y, r, r * 0.6, 0, pick(rnd, ['#9a8f80', '#b1a594', '#857a6c']), 0.95); ellipse(g, x - r * 0.3, y - r * 0.25, r * 0.5, r * 0.3, 0, '#e2d6c0', 0.6); }
  blob(g, ...at(18, 0), 260, 30, 0, '#ffe2b2', 0.35, 0.1);
  g.restore();
  // ragged grass along both road edges
  for (const side of [-1, 1]) {
    for (let i = 0; i < 900; i++) {
      const z = 0.85 * Math.pow(1.06, rnd() * 75);
      if (z > 40) continue;
      const [x, y] = at(z, side * range(rnd, 0.86, 1.08));
      const L = range(rnd, 10, 26) / z;
      blade(g, x, y + L * 0.2, L, side * range(rnd, -0.1, 0.5) * -1, Math.max(0.6, 3.2 / z), pick(rnd, ['#5b8a2e', '#7da23c', '#9cb447', '#4b7428']), 0.85);
    }
  }
  // near grass texture on the ground sides
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * W, y = HZ + 60 + Math.pow(rnd(), 0.7) * (H - HZ - 40);
    const depth = (y - HZ) / (H - HZ);
    const [lx] = at(0.92 * (H - HZ) / Math.max(1, y - HZ - 22), -1.05), [rx2] = at(0.92 * (H - HZ) / Math.max(1, y - HZ - 22), 1.05);
    if (x > lx && x < rx2) continue;
    blade(g, x, y, range(rnd, 4, 16) * depth * 1.4, range(rnd, -0.5, 0.5), Math.max(0.6, 2.6 * depth), pick(rnd, ['#4f7d2a', '#6f9c34', '#9cb447', '#3e6420', '#86a648']), 0.7);
  }
  // rail fence along the left side
  const posts = [];
  for (let z = 1.25; z < 16; z *= 1.22) posts.push(at(z, -1.45).concat([z]));
  for (let i = 0; i < posts.length - 1; i++) {
    const [x0, y0, z0] = posts[i], [x1, y1] = posts[i + 1];
    for (const hh of [0.45, 0.8]) { const k0 = 150 / z0 * hh; const k1 = 150 / posts[i + 1][2] * hh; stroke(g, [[x0, y0 - k0], [x1, y1 - k1]], 9 / z0, 9 / posts[i + 1][2], '#5c3d22', 1); stroke(g, [[x0, y0 - k0 - 2 / z0], [x1, y1 - k1 - 2 / posts[i + 1][2]]], 3 / z0, 3 / posts[i + 1][2], '#a87b4c', 0.7); }
  }
  for (const [x, y, z] of posts) { const h = 170 / z, w = 15 / z; blob(g, x + w, y, w * 2, w * 0.6, 0, '#2c3a18', 0.4, 0.2); stroke(g, [[x, y], [x, y - h]], w, w * 0.85, '#4e3420', 1); stroke(g, [[x - w * 0.25, y - 2], [x - w * 0.25, y - h + 2]], w * 0.3, w * 0.25, '#9a7046', 0.7); }
  // the RV, a long way down the road, kicking up dust
  {
    const [x, y] = at(7.5, 0.15), sc = 1 / 7.5 * 8;
    for (let i = 0; i < 9; i++) blob(g, x + range(rnd, -14, 14) * sc, y - range(rnd, 0, 10) * sc, range(rnd, 6, 14) * sc, range(rnd, 4, 8) * sc, 0, '#e6c79a', 0.35, 0.2);
    const bw = 14 * sc, bh = 12 * sc;
    blob(g, x, y + 1, bw * 0.7, 2 * sc, 0, '#2a1e14', 0.6, 0.3);
    g.fillStyle = '#efe4cc'; g.beginPath(); g.roundRect(x - bw / 2, y - bh - 2 * sc, bw, bh, 2 * sc); g.fill();
    g.fillStyle = '#b4472c'; g.fillRect(x - bw / 2, y - bh * 0.55, bw, bh * 0.16);
    g.fillStyle = '#3a3a4a'; g.fillRect(x - bw * 0.32, y - bh * 0.95, bw * 0.64, bh * 0.28);
    g.fillStyle = 'rgba(255,240,200,0.6)'; g.fillRect(x - bw / 2, y - bh - 2 * sc, bw * 0.25, bh);
    g.fillStyle = '#c63a1e'; g.fillRect(x - bw * 0.46, y - bh * 0.35, 2 * sc, 2 * sc); g.fillRect(x + bw * 0.46 - 2 * sc, y - bh * 0.35, 2 * sc, 2 * sc);
    g.fillStyle = '#1e1a18'; g.fillRect(x - bw * 0.45, y - 2.5 * sc, bw * 0.2, 2.5 * sc); g.fillRect(x + bw * 0.25, y - 2.5 * sc, bw * 0.2, 2.5 * sc);
  }
  // a wooden signpost on the right
  {
    const [x, y] = at(3.2, 1.45);
    blob(g, x + 18, y + 2, 34, 8, 0, '#24301a', 0.45, 0.2);
    stroke(g, [[x, y + 4], [x + 2, y - 190]], 13, 10, '#4a301c', 1);
    stroke(g, [[x - 3, y], [x - 1, y - 186]], 3.5, 2.5, '#9a7046', 0.7);
    const board = (bx, by, w, h, dir) => {
      const p = new Path2D(); p.moveTo(bx, by); p.lineTo(bx + dir * w, by); p.lineTo(bx + dir * (w + 16), by + h / 2); p.lineTo(bx + dir * w, by + h); p.lineTo(bx, by + h); p.closePath();
      g.save(); g.fillStyle = 'rgba(20,12,6,0.5)'; g.translate(3, 4); g.fill(p); g.restore();
      const gr = g.createLinearGradient(0, by, 0, by + h); gr.addColorStop(0, '#a2774a'); gr.addColorStop(1, '#6b4728');
      g.fillStyle = gr; g.fill(p);
      g.save(); g.clip(p); for (let k = 0; k < 6; k++) stroke(g, [[bx - 30, by + 3 + k * h / 6], [bx + dir * (w + 20), by + 3 + k * h / 6 + range(rnd, -1, 1)]], 1.2, 1, '#5a3a1e', 0.45); g.restore();
      g.strokeStyle = '#2e1c0e'; g.lineWidth = 1.6; g.stroke(p);
    };
    board(x + 2, y - 176, 74, 24, -1);
    board(x + 2, y - 144, 64, 22, 1);
  }
  // framing oak, top-left: trunk + huge canopy
  {
    const tx = W * 0.06, ty = H * 1.02;
    stroke(g, [[tx, ty], [tx + 14, H * 0.72], [tx + 6, H * 0.45], [tx + 30, H * 0.22]], 92, 40, '#3e3226', 1);
    stroke(g, [[tx - 24, ty], [tx - 8, H * 0.72], [tx - 14, H * 0.48]], 22, 10, '#6e5c48', 0.55);
    stroke(g, [[tx - 30, ty], [tx - 16, H * 0.74], [tx - 20, H * 0.5], [tx + 4, H * 0.3]], 14, 6, '#8d7a62', 0.45);   // lit flank
    stroke(g, [[tx + 34, ty], [tx + 40, H * 0.72], [tx + 28, H * 0.46]], 26, 12, '#2a2119', 0.55);                   // shaded flank
    for (const [dx, a] of [[-70, -0.5], [60, 0.45], [100, 0.7]]) stroke(g, [[tx, ty - 40], [tx + dx, ty + 6]], 46, 14, '#3e3226', 1);   // flared roots
    stroke(g, [[tx + 6, H * 0.45], [tx + 120, H * 0.3], [tx + 210, H * 0.2]], 30, 10, '#3e3226', 1);
    for (let i = 0; i < 26; i++) { const x = tx + range(rnd, -40, 50), y = H * range(rnd, 0.5, 1); stroke(g, [[x, y], [x + range(rnd, -4, 4), y - range(rnd, 30, 90)]], range(rnd, 2, 5), 1, pick(rnd, ['#2a221c', '#5d4c3a']), 0.5); }
    const canopy = [];
    for (let i = 0; i < 70; i++) canopy.push([range(rnd, -60, 330), range(rnd, -60, 190), range(rnd, 40, 95)]);
    for (const [x, y, r] of canopy) blob(g, x + 10, y + 16, r, r * 0.8, 0, '#1d3214', 0.85, 0.5);
    for (const [x, y, r] of canopy) blob(g, x, y, r * 0.85, r * 0.68, rnd() * 3, pick(rnd, ['#355a22', '#2f5220', '#3d6526']), 0.9, 0.55);
    for (const [x, y, r] of canopy) if (x + y * 0.3 < 300) blob(g, x - r * 0.2 + 12, y - r * 0.3, r * 0.5, r * 0.32, rnd() * 3, pick(rnd, ['#6f9c34', '#86a648', '#9cb447']), 0.55, 0.4);
    for (let i = 0; i < 260; i++) { const [x, y, r] = pick(rnd, canopy); const a = rnd() * Math.PI * 2, d = rnd() * r * 0.8; blob(g, x + Math.cos(a) * d, y + Math.sin(a) * d * 0.7, range(rnd, 5, 13), range(rnd, 3, 7), rnd() * 3, pick(rnd, ['#4f7d2a', '#2b4a1c', '#7da23c', '#b8c860']), 0.5, 0.5); }
  }
  // conifers on the right edge
  const pine = (x, y, h, wd) => {
    blob(g, x + wd * 0.4, y + 4, wd * 0.9, 10, 0, '#1a2614', 0.5, 0.2);
    stroke(g, [[x, y + 6], [x, y - h * 0.2]], wd * 0.14, wd * 0.1, '#3a2a1c', 1);
    for (let k = 0; k < 9; k++) {
      const t = k / 9, yy = y - h * 0.12 - t * h * 0.88, ww = wd * (1 - t * 0.85) * range(rnd, 0.85, 1.1);
      const p = new Path2D(); p.moveTo(x - ww, yy + 8); p.quadraticCurveTo(x - ww * 0.3, yy - 4, x, yy - h * 0.16); p.quadraticCurveTo(x + ww * 0.3, yy - 4, x + ww, yy + 8); p.quadraticCurveTo(x, yy + 2, x - ww, yy + 8);
      g.fillStyle = mix('#1f3a24', '#2c4b2e', t); g.fill(p);
      g.save(); g.clip(p); blob(g, x + ww * 0.45, yy, ww * 0.6, 10, 0, '#5f8a3e', 0.45, 0.3); blob(g, x - ww * 0.5, yy + 6, ww * 0.5, 6, 0, '#14241a', 0.5, 0.3); g.restore();
    }
  };
  pine(W * 0.985, H * 1.0, 560, 120);
  pine(W * 0.915, H * 0.9, 300, 70);
  pine(W * 0.78, H * 0.71, 130, 34);
  pine(W * 0.81, H * 0.7, 100, 26);
  pine(W * 0.2, H * 0.72, 120, 30);
  pine(W * 0.24, H * 0.7, 90, 24);
  // foreground flowers, in clumps
  for (let c = 0; c < 9; c++) {
    const cx = range(rnd, 140, W * 0.44), cy = range(rnd, H * 0.8, H * 0.97);
    const col = pick(rnd, ['#e8d24a', '#f2efe0', '#c86ad0', '#e88a3a']);
    for (let i = 0; i < 14; i++) { const x = cx + range(rnd, -26, 26), y = cy + range(rnd, -8, 8); ellipse(g, x, y, 2.8, 2.3, 0, jitter(col, rnd, 0.1), 0.95); ellipse(g, x - 0.7, y - 0.7, 1.1, 0.9, 0, '#fffbe0', 0.8); }
  }
  // atmosphere: warm light shafts from the sun, then a unifying glaze
  g.save(); g.globalCompositeOperation = 'screen';
  for (let i = 0; i < 6; i++) { const a = range(rnd, -0.9, 0.9); stroke(g, [[SX, SY], [SX + Math.sin(a) * 1100, SY + Math.cos(a) * 900]], 10, range(rnd, 90, 180), '#ffe8b8', 0.05); }
  g.restore();
  glaze(g, W, H, '#ffd9a0', 0.18, 'soft-light');
  g.save(); const vg = g.createRadialGradient(W * 0.55, H * 0.5, H * 0.35, W * 0.5, H * 0.5, W * 0.75); vg.addColorStop(0, 'rgba(20,12,24,0)'); vg.addColorStop(1, 'rgba(20,12,24,0.55)'); g.fillStyle = vg; g.fillRect(0, 0, W, H); g.restore();
} });
