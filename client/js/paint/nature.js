// Texture family: nature. See docs/ART.md for the style rules.
//
// Bark & wood (tile; u runs around a trunk, v up it):
//   bark_oak      Elwynn oak: pale gray-green plates of varied width, lit left edges, deep soft furrows
//                 that wander, split and merge (one continuous stroke each, no beading)
//   bark_pine     red-brown scaly plates (stretch v ×2 on the mesh)
//   bark_dead     bleached deadwood: long grain, splits with lit lips, knots
//   bark_palm     overlapping diamond leaf-base scales in staggered rows, fibre between
//   wood_fence    weathered split-rail wood: long grain, silver weathering over warm brown cracks
// Foliage (alpha atlases; canvas top-left = cell 0, cells laid out left to right, top to bottom):
//   leaves_oak    2×2: 0 oak clump · 1 lobed oak clump · 2 dense leaf mass (opaque) · 3 lobed bush clump
//   leaves_autumn 2×2, Westfall: 0 olive-gold clump · 1 rust/olive clump · 2 dense mass · 3 olive bush
//   leaves_scrub  2×2: 0 sage brush · 1 dry twig brush · 2 dense sage mass (opaque) · 3 juniper spray
//   needles_pine  2×2: 0, 1 drooping boughs (base at the bottom, tip at the top) · 2 dense needles · 3 tip
//   needles_snow  4×2, Dun Morogh: snowy cells on the left half, the same cells without snow on the right
//                 half (the shader shows the right half on a card's underside): 0, 1 snowy boughs ·
//                 4 dense needles under a snow cap · 5 snowy tip; 2, 3, 6, 7 the bare versions
//   palm_frond    two 256×512 fronds side by side (green, dry), rachis from the bottom up
//   straw_tuft    2×2: 0, 1 straw tufts fanning up · 2 ragged straw fringe · 3 loose wisps
// Rock (tile; world-space triplanar, so v = height and strata stay level):
//   rock_gray (meadow) rock_warm (fields) rock_granite (snow): big soft value planes, long fractures
//     with a lit lip and a cool crease, chips, lichen
//   rock_red (badlands) rock_sand (desert): horizontal strata, seamless in both directions
// Top cover (tile; alpha = thickness mask, blended on up-facing surfaces by the nature shader):
//   cover_moss cover_lichen cover_snow cover_dust cover_sand · snow_pack (opaque snow for snow caps)
// Props: cactus_skin (tiles, 4 ribs), hay (tiles), hay_end (disc), stump_top (disc), bone (tiles),
//   scarecrow (atlas), iron (tiles), coals (disc), flame (alpha, 2×2 frames), smoke (alpha), spark
import {
  register, fill, mottle, blade, stroke, cracks, glaze, blurTile, range, pick, wrap, blob, ellipse,
  mix, shade, lightOf, shadowOf, jitter, hex, rgba, makeCanvas, worley, paintCells, streaks,
} from './core.js';

const TAU = Math.PI * 2;
const F = 'nature';

// ---- helpers ---------------------------------------------------------------------------------

// A periodic function on [0, 1): integer-frequency sines (tiles seamlessly).
function periodic(rnd, terms = 5, falloff = 1.2, k0 = 1) {
  const T = [];
  for (let k = k0; k < k0 + terms; k++) T.push([k, rnd() * TAU, (0.5 + rnd()) / Math.pow(k, falloff)]);
  const norm = T.reduce((a, t) => a + t[2], 0);
  return t => { let v = 0; for (const [k, p, a] of T) v += Math.sin(TAU * k * t + p) * a; return v / norm; };
}
const fract01 = (v, s) => (((v % s) + s) % s) / s;

// Draw fn three times, shifted by -s, 0, +s in x (and optionally y), for things that run off an edge.
function tiled(s, fn, both = false) {
  for (const dx of [-s, 0, s]) for (const dy of both ? [-s, 0, s] : [0]) fn(dx, dy);
}

// Paint on a scratch layer at full strength, then lay it down at `alpha` (no beading where marks
// overlap), optionally blurred (seamlessly) first.
function layer(g, w, h, fn, { alpha = 1, mode = 'source-over', blur = 0 } = {}) {
  const tmp = makeCanvas(w, h), tg = tmp.getContext('2d', { willReadFrequently: true });
  fn(tg, tmp);
  if (blur) blurTile(tmp, blur);
  g.save(); g.globalAlpha = alpha; g.globalCompositeOperation = mode; g.drawImage(tmp, 0, 0); g.restore();
}

// One continuous path: round joins and caps, constant width.
function line(g, pts, w, color, alpha = 1) {
  if (pts.length < 2) return;
  g.save();
  g.globalAlpha *= alpha; g.strokeStyle = color; g.lineWidth = w; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
  g.stroke(); g.restore();
}
// Call fn(shiftedPts) for every wrapped copy of a polyline that crosses an edge.
function wrapPts(s, pts, pad, fn) {
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const xs = [0], ys = [0];
  if (x0 - pad < 0) xs.push(s); if (x1 + pad > s) xs.push(-s);
  if (y0 - pad < 0) ys.push(s); if (y1 + pad > s) ys.push(-s);
  for (const dx of xs) for (const dy of ys) fn(dx || dy ? pts.map(([x, y]) => [x + dx, y + dy]) : pts);
}
function poly(g, pts, color, alpha = 1) {
  g.save(); g.globalAlpha *= alpha; g.fillStyle = color;
  g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]); g.closePath(); g.fill();
  g.restore();
}

// Paint into cells of an atlas, clipped (cells are w × h, laid out left to right, top to bottom).
function atlas(cells, cw = null, ch = null) {
  return (g, s, rnd, h) => {
    const W = cw || s / 2, H = ch || (h || s) / 2;
    const per = Math.round(s / W);
    cells.forEach((fn, i) => {
      const ox = (i % per) * W, oy = Math.floor(i / per) * H;
      g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, W - 4, H - 4); g.clip();
      fn(g, ox, oy, W, H, rnd);
      g.restore();
    });
  };
}
function clipCell(g, ox, oy, w, h, fn) { g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, w - 4, h - 4); g.clip(); fn(); g.restore(); }

// RGB from one canvas, alpha from the red channel of a mask canvas (lo..hi).
function withMask(g, s, colorCv, maskCv, lo = 0.15, hi = 1) {
  const C = colorCv.getContext('2d').getImageData(0, 0, s, s).data;
  const M = maskCv.getContext('2d').getImageData(0, 0, s, s).data;
  const img = g.createImageData(s, s), D = img.data;
  for (let k = 0; k < s * s; k++) {
    D[k * 4] = C[k * 4]; D[k * 4 + 1] = C[k * 4 + 1]; D[k * 4 + 2] = C[k * 4 + 2];
    D[k * 4 + 3] = Math.round(255 * (lo + (hi - lo) * M[k * 4] / 255));
  }
  g.putImageData(img, 0, 0);
}

// A wavy line (periodic in t) as a polyline across [-pad, s + pad].
function wavy(s, f, amp, at, vertical = true, pad = 24, step = 6) {
  const pts = [];
  for (let u = -pad; u <= s + pad; u += step) {
    const o = at + f(fract01(u, s)) * amp;
    pts.push(vertical ? [o, u] : [u, o]);
  }
  return pts;
}

// Lit/shadowed little bump (a pebble-ish lump) at x, y.
function lump(g, x, y, r, c, a = 1) {
  blob(g, x + r * 0.3, y + r * 0.35, r * 1.2, r * 0.9, 0, '#1e1626', 0.3 * a, 0.25);
  ellipse(g, x, y, r, r * 0.8, 0, c, a);
  blob(g, x - r * 0.3, y - r * 0.3, r * 0.6, r * 0.45, 0, lightOf(c, 0.5), 0.7 * a, 0.3);
  blob(g, x + r * 0.3, y + r * 0.3, r * 0.6, r * 0.45, 0, shadowOf(c, 0.35), 0.5 * a, 0.3);
}

// Soft blotches inside a rect (no wrapping).
function mottle0(g, ox, oy, w, h, rnd, colors, count, rmin, rmax, alpha = 0.3, hard = 0.2) {
  for (let i = 0; i < count; i++) {
    const r = range(rnd, rmin, rmax);
    blob(g, ox + rnd() * w, oy + rnd() * h, r * range(rnd, 0.8, 1.4), r, rnd() * Math.PI, pick(rnd, colors), alpha * range(rnd, 0.6, 1), hard);
  }
}

// ---- foliage painting --------------------------------------------------------------------------

// One painted leaf, stem at (x, y), pointing along ang (0 = up). The half that faces the
// upper-left light is lit, the other half shaded, with a soft vein.
function leaf(g, x, y, L, W, ang, base, alpha = 1) {
  const litLeft = Math.cos(ang) + Math.sin(ang) > 0;
  const sx = litLeft ? -1 : 1;
  g.save();
  g.translate(x, y); g.rotate(ang);
  g.globalAlpha = alpha;
  g.beginPath(); g.moveTo(0, 0);
  g.bezierCurveTo(W * 0.95, -L * 0.18, W * 0.75, -L * 0.78, 0, -L);
  g.bezierCurveTo(-W * 0.75, -L * 0.78, -W * 0.95, -L * 0.18, 0, 0);
  g.fillStyle = base; g.fill();
  g.beginPath(); g.moveTo(0, 0);
  g.bezierCurveTo(sx * W * 0.95, -L * 0.18, sx * W * 0.75, -L * 0.78, 0, -L);
  g.quadraticCurveTo(sx * W * 0.12, -L * 0.5, 0, 0);
  g.globalAlpha = alpha * 0.75; g.fillStyle = lightOf(base, 0.4); g.fill();
  g.beginPath(); g.moveTo(0, 0);
  g.bezierCurveTo(-sx * W * 0.95, -L * 0.18, -sx * W * 0.75, -L * 0.78, 0, -L);
  g.quadraticCurveTo(-sx * W * 0.5, -L * 0.45, 0, 0);
  g.globalAlpha = alpha * 0.55; g.fillStyle = shadowOf(base, 0.35); g.fill();
  g.globalAlpha = alpha * 0.4; g.strokeStyle = shadowOf(base, 0.45); g.lineWidth = Math.max(0.7, W * 0.13);
  g.beginPath(); g.moveTo(0, -L * 0.05); g.lineTo(0, -L * 0.82); g.stroke();
  g.restore();
}

// A clump of leaves: a dark solid core under lumpy lobes, then leaves back to front, dark to lit,
// the lit ones gathered toward the upper left of each lobe, the edge leaves pointing outward. Then
// each lobe gets its form painted over it (source-atop, so the cut-out shape is untouched): a cool
// shadow on its lower right, a warm sheen on its upper left.
function leafClump(g, cx, cy, R, rnd, P, { n = 220, lobes = 5, L = [20, 32], W = [9, 14], squash = 0.88, core = 0.92, form = 1, spread = [0.22, 0.44], lobeR = [0.36, 0.5], palettes = null } = {}) {
  const lob = [[cx, cy, R * 0.6, P]];
  for (let i = 1; i < lobes; i++) {
    const a = rnd() * TAU, d = R * range(rnd, spread[0], spread[1]);
    lob.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * squash, R * range(rnd, lobeR[0], lobeR[1]), palettes ? pick(rnd, palettes) : P]);
  }
  if (core) for (const [lx, ly, lr, LP] of lob) blob(g, lx + lr * 0.06, ly + lr * 0.08, lr * core, lr * core * 0.95, 0, LP.core, 1, 0.8);
  const passes = [['dark', 1.04, -0.15, 0.4], ['mid', 0.95, 0.3, 0.32], ['lit', 0.82, 0.62, 0.21], ['hi', 0.62, 0.85, 0.07]];
  for (const [key, rK, bias, share] of passes) {
    const cnt = Math.round(n * share);
    for (let i = 0; i < cnt; i++) {
      const [lx, ly, lr, LP] = pick(rnd, lob);
      const a = rnd() * TAU, t = Math.sqrt(rnd());
      let px = Math.cos(a) * t, py = Math.sin(a) * t;
      if (bias) { px -= bias * 0.45; py -= bias * 0.52; const l = Math.hypot(px, py); if (l > 1) { px /= l; py /= l; } }
      const x = lx + px * lr * rK, y = ly + py * lr * rK;
      const ang = Math.atan2(px, -py) + range(rnd, -0.7, 0.7);
      leaf(g, x, y, range(rnd, L[0], L[1]), range(rnd, W[0], W[1]), ang, jitter(pick(rnd, LP[key]), rnd, 0.05));
    }
  }
  if (form) {
    g.save();
    g.globalCompositeOperation = 'source-atop';
    for (const [lx, ly, lr] of lob) {
      blob(g, lx + lr * 0.45, ly + lr * 0.5, lr * 0.95, lr * 0.8, 0.5, '#14241a', 0.42 * form, 0.25);
      blob(g, lx - lr * 0.4, ly - lr * 0.45, lr * 0.7, lr * 0.55, 0.5, '#fff0b0', 0.14 * form, 0.3);
    }
    const gr = g.createLinearGradient(cx, cy - R, cx + R * 0.3, cy + R);
    gr.addColorStop(0, 'rgba(255,240,180,0.10)'); gr.addColorStop(0.5, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(16,28,30,0.38)');
    g.fillStyle = gr; g.fillRect(cx - R * 1.3, cy - R * 1.3, R * 2.6, R * 2.6);
    g.restore();
  }
}

// A cell filled edge to edge with leaves (the solid mass inside a canopy).
function leafMass(g, ox, oy, w, h, rnd, P, { n = 520, L = [16, 26], W = [7, 11] } = {}) {
  g.fillStyle = P.core; g.fillRect(ox, oy, w, h);
  mottle0(g, ox, oy, w, h, rnd, [P.core, P.dark[0], shadowOf(P.core, 0.2)], 16, 20, 60, 0.5);
  const passes = [[P.dark, 0.5], [P.mid, 0.34], [P.lit, 0.14], [P.hi, 0.02]];
  for (const [cols, share] of passes) {
    for (let i = 0; i < n * share; i++) {
      leaf(g, ox + rnd() * w, oy + rnd() * h, range(rnd, L[0], L[1]), range(rnd, W[0], W[1]), rnd() * TAU, jitter(pick(rnd, cols), rnd, 0.05));
    }
  }
}

const OAK = {
  core: '#1e3418',
  dark: ['#29481c', '#2e501f', '#25421a', '#33561f'],
  mid: ['#42702a', '#4b7a2c', '#3c6626', '#548230'],
  lit: ['#70a238', '#7caa3c', '#6a9832', '#88b240'],
  hi: ['#acc852', '#bacc5e', '#c6d468'],
};
const BUSH = {
  core: '#203818',
  dark: ['#2a4a1e', '#2e5020', '#264418'],
  mid: ['#47722c', '#507c30', '#3e6a28'],
  lit: ['#78a43e', '#86ac44', '#6e9c38'],
  hi: ['#b4c85c', '#c4d06a'],
};
// Westfall: sun-baked olive-gold, with the odd rust-red autumn clump
const GOLD = {
  core: '#36361a',
  dark: ['#4a4820', '#545024', '#46421c'],
  mid: ['#8a8636', '#7e7a30', '#94883a'],
  lit: ['#b09a40', '#bea646', '#a89a3c'],
  hi: ['#d0a850', '#dcc070', '#e0b860'],
};
const RUST = {
  core: '#3e2416',
  dark: ['#5e3420', '#56301c', '#663a22'],
  mid: ['#9a5a30', '#a8663a', '#b0663a'],
  lit: ['#c88048', '#d09050', '#c47a40'],
  hi: ['#e0b060', '#e8c070'],
};
const OLIVE = {
  core: '#2e3418',
  dark: ['#3e4620', '#444c22', '#38401c'],
  mid: ['#6a7432', '#747c36', '#626c2e'],
  lit: ['#9a9a44', '#a8a24a', '#90923e'],
  hi: ['#c8b85a', '#d0c066'],
};
const SAGE = {
  core: '#55604a',
  dark: ['#4c5844', '#48523f', '#55604a'],
  mid: ['#6c7a5e', '#768466', '#687658'],
  lit: ['#94a27c', '#9eac86', '#8c9a76'],
  hi: ['#bcc8a2', '#c6d0ac'],
};

// a lobed bush clump: many smaller lobes spread wide, so the outline is bumpy, not a disc
const bushClump = (P, palettes = null) => (g, ox, oy, w, h, rnd) => {
  leafClump(g, ox + w / 2, oy + h / 2 + 10, 104, rnd, P, { n: 420, lobes: 9, L: [13, 20], W: [6, 9], spread: [0.3, 0.62], lobeR: [0.26, 0.4], squash: 0.78, palettes });
  for (let i = 0; i < 9; i++) {   // stray sprigs past the outline
    const a = range(rnd, -2.6, 0.6), d = range(rnd, 92, 112), x = ox + w / 2 + Math.cos(a) * d, y = oy + h / 2 + 10 + Math.sin(a) * d * 0.8;
    for (let k = 0; k < 4; k++) leaf(g, x + range(rnd, -6, 6), y + range(rnd, -6, 6), range(rnd, 11, 16), range(rnd, 5, 7), a + Math.PI / 2 + range(rnd, -0.6, 0.6), jitter(pick(rnd, P.mid), rnd, 0.05));
  }
};

register('leaves_oak', {
  family: F, size: 512, alpha: true, note: 'oak/bush foliage atlas: clump, lobed clump, dense mass, lobed bush clump',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => leafClump(g, ox + w / 2, oy + h / 2 + 6, 120, rnd, OAK, { n: 260, lobes: 6 }),
    (g, ox, oy, w, h, rnd) => {
      leafClump(g, ox + w * 0.38, oy + h * 0.6, 88, rnd, OAK, { n: 150, lobes: 4 });
      leafClump(g, ox + w * 0.62, oy + h * 0.4, 92, rnd, OAK, { n: 160, lobes: 4 });
    },
    (g, ox, oy, w, h, rnd) => leafMass(g, ox, oy, w, h, rnd, OAK, { n: 2400, L: [8, 13], W: [3.5, 5.5] }),
    bushClump(BUSH),
  ]),
});

register('leaves_autumn', {
  family: F, size: 512, alpha: true, note: 'Westfall foliage: olive-gold clump, rust/olive clump, dense mass, olive bush',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => leafClump(g, ox + w / 2, oy + h / 2 + 6, 118, rnd, GOLD, { n: 240, lobes: 6, palettes: [GOLD, GOLD, OLIVE] }),
    (g, ox, oy, w, h, rnd) => {
      leafClump(g, ox + w * 0.38, oy + h * 0.6, 88, rnd, RUST, { n: 150, lobes: 4, palettes: [RUST, GOLD] });
      leafClump(g, ox + w * 0.62, oy + h * 0.4, 92, rnd, GOLD, { n: 160, lobes: 4, palettes: [GOLD, OLIVE] });
    },
    (g, ox, oy, w, h, rnd) => leafMass(g, ox, oy, w, h, rnd, { ...OLIVE, mid: [...OLIVE.mid, ...GOLD.mid] }, { n: 2200, L: [8, 13], W: [3.5, 5.5] }),
    bushClump(OLIVE, [OLIVE, OLIVE, GOLD]),
  ]),
});

// sage / scrub leaves: small, narrow, gray-green, on visible brown twigs
function twigFan(g, cx, by, rnd, { n = 9, len = [70, 120], col = '#5e4636', lit = '#9a7e64', spread = 1.1, w = 4 } = {}) {
  const tips = [];
  for (let i = 0; i < n; i++) {
    const a = range(rnd, -spread, spread), L = range(rnd, len[0], len[1]);
    const x1 = cx + Math.sin(a) * L, y1 = by - Math.cos(a) * L;
    const mx = (cx + x1) / 2 + range(rnd, -8, 8), my = (by + y1) / 2;
    stroke(g, [[cx + range(rnd, -6, 6), by], [mx, my], [x1, y1]], w, 1, col, 1);
    stroke(g, [[cx - 1, by], [mx - 1, my], [x1 - 1, y1]], w * 0.4, 0.5, lit, 0.6);
    tips.push([x1, y1, a]);
    for (let k = 0; k < 2; k++) {
      const t = range(rnd, 0.45, 0.8), fx = cx + (x1 - cx) * t, fy = by + (y1 - by) * t, fa = a + range(rnd, -0.9, 0.9), fl = L * range(rnd, 0.25, 0.45);
      stroke(g, [[fx, fy], [fx + Math.sin(fa) * fl, fy - Math.cos(fa) * fl]], w * 0.55, 0.8, col, 1);
      tips.push([fx + Math.sin(fa) * fl, fy - Math.cos(fa) * fl, fa]);
    }
  }
  return tips;
}

register('leaves_scrub', {
  family: F, size: 512, alpha: true, note: 'dry-land shrubs: sage brush, twig brush, dense sage, juniper spray',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => {
      const tips = twigFan(g, ox + w / 2, oy + h - 8, rnd, { n: 10, len: [80, 140] });
      for (const [x, y] of tips) leafClump(g, x, y + 6, range(rnd, 26, 40), rnd, SAGE, { n: 50, lobes: 3, L: [8, 14], W: [3.5, 5.5], core: 0.75, form: 0.6 });
    },
    (g, ox, oy, w, h, rnd) => {
      // a dry tangle (tumbleweed-ish): many crooked twigs in a ball, a few dead leaves
      const cx = ox + w / 2, cy = oy + h / 2 + 10;
      for (let i = 0; i < 70; i++) {
        let x = cx + range(rnd, -70, 70), y = cy + range(rnd, -60, 60);
        if (Math.hypot(x - cx, (y - cy) * 1.15) > 84) continue;
        const pts = [[x, y]];
        let a = rnd() * TAU;
        for (let k = 0; k < 4; k++) { a += range(rnd, -0.9, 0.9); x += Math.cos(a) * range(rnd, 10, 20); y += Math.sin(a) * range(rnd, 10, 20); pts.push([x, y]); }
        const c = pick(rnd, ['#6a503e', '#7a5e48', '#5a4232', '#8a6e54']);
        stroke(g, pts.map(([u, v]) => [u + 1.2, v + 1.2]), 3, 1, '#2e2226', 0.5);
        stroke(g, pts, 2.6, 0.9, c, 1);
        stroke(g, pts.map(([u, v]) => [u - 0.6, v - 0.6]), 1, 0.4, '#c4a888', 0.5);
      }
      for (let i = 0; i < 40; i++) leaf(g, cx + range(rnd, -70, 70), cy + range(rnd, -55, 55), range(rnd, 8, 12), range(rnd, 3, 5), rnd() * TAU, pick(rnd, ['#9a8a5a', '#a8946a', '#8a7a4e']));
    },
    (g, ox, oy, w, h, rnd) => leafMass(g, ox, oy, w, h, rnd, SAGE, { n: 900, L: [9, 14], W: [3.5, 5.5] }),
    (g, ox, oy, w, h, rnd) => {
      // juniper: dark blue-green scale-leaf sprays fanning out of a low woody base
      const cx = ox + w / 2, by = oy + h - 10;
      for (let i = 0; i < 30; i++) {
        const a = range(rnd, -1.3, 1.3), L = range(rnd, 70, 125), x0 = cx + range(rnd, -24, 24), y0 = by - range(rnd, 0, 40);
        const x1 = x0 + Math.sin(a) * L, y1 = y0 - Math.cos(a) * L * 0.85;
        stroke(g, [[x0, y0], [(x0 + x1) / 2, (y0 + y1) / 2 - 6], [x1, y1]], 5, 1.5, '#3a2e2a', 1);
        for (let k = 0; k < 16; k++) {
          const t = 0.2 + k / 16 * 0.8, px = x0 + (x1 - x0) * t, py = y0 + (y1 - y0) * t - Math.sin(t * Math.PI) * 6;
          const lit = Math.sin(a) < 0.2 && k % 3 === 0;
          const c = lit ? pick(rnd, ['#5e8070', '#6a8c78']) : pick(rnd, ['#2e4a40', '#36564a', '#3e5e4e', '#284036']);
          for (const sd of [-1, 1]) stroke(g, [[px, py], [px + sd * range(rnd, 8, 15) + Math.sin(a) * 6, py - range(rnd, 4, 11)]], 4.2, 1.2, c, 1);
        }
      }
    },
  ]),
});

// ---- pine boughs -------------------------------------------------------------------------------

// Elwynn: a cool mid green with warm lit tips (never near-black)
const NEEDLE = {
  core: '#22382e',
  dark: ['#2a4a38', '#2f5a3e', '#28463a'],
  mid: ['#3f6e48', '#46784e', '#3a6844', '#4a7c50'],
  lit: ['#7fa055', '#6e9a50', '#88a85a'],
  hi: ['#a4b862', '#b4c470'],
};
// Dun Morogh: a darker blue-green under the snow
const NEEDLE_SNOW = {
  core: '#1c302c',
  dark: ['#24403a', '#2c4a3c', '#223c36'],
  mid: ['#3f6650', '#467058', '#3a5e4c'],
  lit: ['#5e8a6a', '#6a9472', '#58826a'],
  hi: ['#88aa84', '#94b48c'],
};

// Needle spray along a polyline: short strokes angled forward on both sides; the ones pointing
// up (toward the light) are lit, the ones hanging down are dark.
function needles(g, pts, rnd, { len = [12, 19], w = 2.6, dens = 2.4, P = NEEDLE, forward = 0.6 } = {}) {
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
    const dirA = Math.atan2(dx, -dy);
    const steps = Math.max(1, Math.round(l / dens));
    const tipK = 1 - i / (pts.length - 1) * 0.4;
    for (let k = 0; k < steps; k++) {
      const t = k / steps, x = ax + dx * t, y = ay + dy * t;
      for (const sd of [-1, 1]) {
        const a = dirA + sd * range(rnd, forward * 0.7, forward * 1.4);
        const L = range(rnd, len[0], len[1]) * tipK;
        const upness = -Math.cos(a) - Math.sin(a) * 0.5;
        const cols = upness > 0.35 ? (rnd() < 0.3 ? P.hi : P.lit) : upness > -0.2 ? P.mid : P.dark;
        blade(g, x, y, L, a, w, pick(rnd, cols), 1, range(rnd, -0.2, 0.2));
      }
    }
  }
}

// A drooping bough, base at the bottom of the cell, tip at the top. Returns its skeleton so a snow
// cap can be painted along it.
function bough(g, ox, oy, w, h, rnd, { spread = 0.47, n = 14, P = NEEDLE } = {}) {
  const cx = ox + w / 2, by = oy + h - 6, ty = oy + 14;
  const bend = periodic(rnd, 2, 1, 1);
  const main = [];
  for (let k = 0; k <= 10; k++) { const t = k / 10; main.push([cx + bend(t * 0.5) * 8, by + (ty - by) * t]); }
  const sides = [];
  for (let i = 0; i < n; i++) {
    const t = 0.08 + i / n * 0.86 + range(rnd, -0.015, 0.015);
    const k = Math.min(9, Math.floor(t * 10)), f = t * 10 - k;
    const bx = main[k][0] + (main[k + 1][0] - main[k][0]) * f, byy = main[k][1] + (main[k + 1][1] - main[k][1]) * f;
    const sd = i % 2 ? 1 : -1;
    const prof = Math.pow(Math.sin(Math.PI * Math.min(1, 0.22 + t * 0.85)), 0.6);
    const L = w * spread * prof * range(rnd, 0.85, 1.05);
    const a = sd * range(rnd, 0.95, 1.2);
    const pts = [];
    for (let j = 0; j <= 5; j++) { const u = j / 5; const aa = a - sd * u * 0.35; pts.push([bx + Math.sin(aa) * L * u, byy - Math.cos(aa) * L * u + u * u * 10]); }
    sides.push([pts, L, t]);
  }
  for (const [pts, L] of sides) stroke(g, pts, Math.max(10, L * 0.42), 6, P.core, 1);
  stroke(g, main, 30, 12, P.core, 1);
  for (const [pts, L] of sides) stroke(g, pts.map(([x, y]) => [x, y + 3]), Math.max(8, L * 0.3), 4, P.dark[0], 0.8);
  for (const [pts] of sides) stroke(g, pts, 2.6, 1, '#4a3428', 1);
  stroke(g, main, 4.5, 1.5, '#5a3e2c', 1);
  for (const [pts] of sides) needles(g, pts, rnd, { P });
  needles(g, main, rnd, { len: [13, 20], P });
  for (const [pts] of sides) {
    const [x, y] = pts[pts.length - 1];
    for (let k = 0; k < 5; k++) blade(g, x, y, range(rnd, 6, 11), range(rnd, -1.2, 1.2), 2.2, pick(rnd, P.hi), 0.85, 0);
  }
  return { main, sides };
}
function denseNeedles(g, ox, oy, w, h, rnd, P) {
  g.fillStyle = P.dark[0]; g.fillRect(ox, oy, w, h);
  mottle0(g, ox, oy, w, h, rnd, [P.core, P.mid[0], P.dark[1]], 14, 20, 60, 0.5);
  for (let r = 0; r < 40; r++) {
    const x = ox + rnd() * w, y = oy + rnd() * h, a = range(rnd, -0.5, 0.5), L = range(rnd, 40, 90);
    needles(g, [[x, y + L / 2], [x + Math.sin(a) * L, y - L / 2]], rnd, { len: [10, 16], dens: 3, P });
  }
}

register('needles_pine', {
  family: F, size: 512, alpha: true, note: 'pine atlas: two drooping boughs, dense needles, tip spray (Elwynn green)',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.47, n: 15 }),
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.42, n: 13 }),
    (g, ox, oy, w, h, rnd) => denseNeedles(g, ox, oy, w, h, rnd, NEEDLE),
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.36, n: 14 }),
  ]),
});

// Snow lying along a bough: a thick lumpy cap along the main stem and the inner part of each side
// branch, a cool shadow under its lip, a lit cream-white top toward the upper left, needles left
// showing at the tips and the edges. Painted on a layer so it stays one soft shape.
const SNOW = { lit: '#f6f7f2', body: '#dfe7ee', mid: '#cfdbe8', shadow: '#8aa0bc', deep: '#6e84a4' };
function snowCap(g, sk, ox, oy, w, h, rnd) {
  const { main, sides } = sk;
  const mainPts = main.slice(1, 10);
  const sidePts = sides.filter(([, , t]) => t < 0.88).map(([pts, L, t]) => [pts.slice(0, 3 + (t < 0.5 ? 1 : 0)), L, t]);
  const paintShape = (tg, color, k, dx, dy) => {
    for (const [pts, L] of sidePts) line(tg, pts.map(([x, y]) => [x + dx, y + dy]), Math.max(7, L * 0.2) * k, color);
    line(tg, mainPts.map(([x, y]) => [x + dx, y + dy]), 20 * k, color);
    // lumps along the cap
    for (const [pts] of sidePts) { const [x, y] = pts[1]; ellipse(tg, x + dx, y + dy, 6 * k, 5 * k, 0, color, 1); }
  };
  clipCell(g, ox, oy, w, h, () => {
    layer(g, g.canvas.width, g.canvas.height, tg => paintShape(tg, SNOW.shadow, 1.3, 3, 6), { alpha: 0.75, blur: 2.5 });
    layer(g, g.canvas.width, g.canvas.height, tg => {
      paintShape(tg, SNOW.body, 1, 0, 0);
      tg.save(); tg.globalCompositeOperation = 'source-atop';
      // form: cool lower right, lit upper left on every lump
      for (const [pts] of sidePts) for (const [x, y] of pts) { blob(tg, x + 4, y + 4, 9, 6, 0, SNOW.mid, 0.8, 0.3); blob(tg, x - 3, y - 3, 6, 4, 0, SNOW.lit, 0.9, 0.4); }
      for (const [x, y] of mainPts) { blob(tg, x + 6, y + 3, 11, 8, 0, SNOW.mid, 0.7, 0.3); blob(tg, x - 4, y - 4, 8, 6, 0, SNOW.lit, 0.95, 0.4); }
      for (let i = 0; i < 40; i++) blob(tg, ox + rnd() * w, oy + rnd() * h, 1.4, 1.4, 0, '#ffffff', 0.9, 0.6);
      tg.restore();
    }, { alpha: 1, blur: 0.8 });
    // a few needle tips poking through the cap edge
    for (const [pts] of sidePts) {
      const [x, y] = pts[pts.length - 1];
      for (let k = 0; k < 3; k++) blade(g, x + range(rnd, -4, 4), y + range(rnd, -2, 4), range(rnd, 6, 10), range(rnd, -1.4, 1.4), 2, pick(rnd, NEEDLE_SNOW.mid), 0.9, 0);
    }
  });
}

register('needles_snow', {
  family: F, w: 1024, h: 512, size: 1024, alpha: true,
  note: 'Dun Morogh pine atlas, 4×2: snowy boughs (0, 1), snow-capped dense needles (4), snowy tip (5); bare copies at +2 columns for card undersides',
  paint(g, s, rnd, h, cv) {
    const C = 256;
    const at = i => [(i % 4) * C, Math.floor(i / 4) * C];
    const sk = {};
    // the bare cells first (right half)
    const bare = [[2, { spread: 0.47, n: 15 }], [3, { spread: 0.42, n: 13 }], [7, { spread: 0.36, n: 14 }]];
    for (const [i, o] of bare) { const [ox, oy] = at(i); clipCell(g, ox, oy, C, C, () => { sk[i] = bough(g, ox, oy, C, C, rnd, { ...o, P: NEEDLE_SNOW }); }); }
    { const [ox, oy] = at(6); clipCell(g, ox, oy, C, C, () => denseNeedles(g, ox, oy, C, C, rnd, NEEDLE_SNOW)); }
    // the snowy copies (left half): the same bough, then the snow
    for (const [src, dst] of [[2, 0], [3, 1], [6, 4], [7, 5]]) {
      const [sx, sy] = at(src), [dx, dy] = at(dst);
      g.drawImage(cv, sx, sy, C, C, dx, dy, C, C);
      if (sk[src]) {
        const shift = ([x, y]) => [x - sx + dx, y - sy + dy];
        const S = { main: sk[src].main.map(shift), sides: sk[src].sides.map(([pts, L, t]) => [pts.map(shift), L, t]) };
        snowCap(g, S, dx, dy, C, C, rnd);
      }
    }
    // the dense cell under a snow cap: the top third white with a wavy lower edge and a cool lip
    const [ox, oy] = at(4), f = periodic(rnd, 4, 1, 1);
    const edge = x => oy + C * 0.36 + f((x - ox) / C) * 14;
    clipCell(g, ox, oy, C, C, () => {
      const cap = (e) => { g.beginPath(); g.moveTo(ox, oy); for (let x = ox; x <= ox + C; x += 4) g.lineTo(x, edge(x) + e); g.lineTo(ox + C, oy); g.closePath(); };
      layer(g, cv.width, cv.height, tg => { tg.fillStyle = SNOW.shadow; tg.beginPath(); tg.moveTo(ox, oy); for (let x = ox; x <= ox + C; x += 4) tg.lineTo(x, edge(x) + 9); tg.lineTo(ox + C, oy); tg.closePath(); tg.fill(); }, { alpha: 0.75, blur: 3 });
      cap(0);
      const gr = g.createLinearGradient(0, oy, 0, oy + C * 0.4);
      gr.addColorStop(0, SNOW.lit); gr.addColorStop(0.6, SNOW.body); gr.addColorStop(1, SNOW.mid);
      g.fillStyle = gr; g.fill();
      for (let i = 0; i < 26; i++) { const x = ox + rnd() * C, y = oy + rnd() * C * 0.3; blob(g, x, y, range(rnd, 8, 18), range(rnd, 4, 8), 0, pick(rnd, [SNOW.mid, SNOW.lit]), 0.5, 0.3); }
      for (let i = 0; i < 30; i++) { const x = ox + rnd() * C; blade(g, x, edge(x) - 1, range(rnd, 5, 9), range(rnd, -0.5, 0.5) + Math.PI, 2, pick(rnd, NEEDLE_SNOW.mid), 0.8, 0); }
    });
  },
});

// ---- palm fronds ---------------------------------------------------------------------------------

function frond(g, ox, oy, w, h, rnd, P) {
  const cx = ox + w / 2, by = oy + h - 8, ty = oy + 10;
  const rach = [];
  for (let k = 0; k <= 12; k++) { const t = k / 12; rach.push([cx + Math.sin(t * 2.2) * 10, by + (ty - by) * t]); }
  const at = t => { const k = Math.min(11, Math.floor(t * 12)), f = t * 12 - k; return [rach[k][0] + (rach[k + 1][0] - rach[k][0]) * f, rach[k][1] + (rach[k + 1][1] - rach[k][1]) * f]; };
  for (let pass = 0; pass < 2; pass++) {
    for (let t = 0.04; t < 0.98; t += 0.016) {
      const [x, y] = at(t);
      const prof = Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.95)), 0.6);
      for (const sd of [-1, 1]) {
        if (pass === 0 && sd < 0) continue;
        if (pass === 1 && sd > 0) continue;
        const L = w * 0.47 * prof * range(rnd, 0.85, 1.05);
        const a = sd * range(rnd, 0.5, 0.7);
        const lit = sd < 0;
        const c = jitter(pick(rnd, lit ? P.lit : P.mid), rnd, 0.06);
        blade(g, x + 1.5, y + 2, L, a, 7, P.dark, 0.7, sd * 0.5);
        blade(g, x, y, L, a, 6.5, c, 1, sd * 0.5);
        blade(g, x - sd * 0.8, y - 0.8, L * 0.8, a, 2, lightOf(c, 0.4), 0.5, sd * 0.5);
        if (rnd() < P.dryTip) blade(g, x + Math.sin(a) * L * 0.75, y - Math.cos(a) * L * 0.75, L * 0.25, a + sd * 0.35, 3, pick(rnd, P.tip), 0.8, sd * 0.3);
      }
    }
  }
  stroke(g, rach.map(([x, y]) => [x + 1.5, y + 1]), 9, 2.5, P.dark, 0.6);
  stroke(g, rach, 7, 2, P.rib, 1);
  stroke(g, rach.map(([x, y]) => [x - 1.4, y]), 2, 0.8, lightOf(P.rib, 0.5), 0.7);
}

register('palm_frond', {
  family: F, w: 512, h: 512, size: 512, alpha: true, note: 'two fronds (green, dry), each 256×512, rachis bottom → tip',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => frond(g, ox, oy, w, h, rnd, { lit: ['#9cbc4a', '#a8c456', '#8cb042'], mid: ['#5e9032', '#6a9a36', '#548a30'], dark: '#2e4e20', rib: '#c4b070', tip: ['#c8a850', '#b89448'], dryTip: 0.18 }),
    (g, ox, oy, w, h, rnd) => frond(g, ox, oy, w, h, rnd, { lit: ['#c8aa62', '#d4b670', '#bca058'], mid: ['#9a7e46', '#a8884e', '#8a7040'], dark: '#4e3a26', rib: '#d4be8a', tip: ['#7a5e3a', '#6a5034'], dryTip: 0.5 }),
  ], 256, 512),
});

// ---- straw -----------------------------------------------------------------------------------------

const STRAW = ['#e8c878', '#f4dc98', '#d4ac58', '#c09848', '#a88038', '#f8e8b0'];
function strawTuft(g, cx, by, rnd, { n = 60, len = [60, 120], spread = 0.9, w = [2.4, 4.2] } = {}) {
  for (let i = 0; i < n; i++) {
    const a = range(rnd, -spread, spread), L = range(rnd, len[0], len[1]), x = cx + range(rnd, -14, 14);
    const c = i < n * 0.35 ? pick(rnd, ['#8a6a30', '#a88038', '#7a5a28']) : pick(rnd, STRAW);
    blade(g, x, by, L, a, range(rnd, w[0], w[1]), c, 1, range(rnd, -0.4, 0.4));
    if (i >= n * 0.35 && rnd() < 0.5) blade(g, x - 1, by - 1, L * 0.8, a, 1, '#fff4d0', 0.5, 0);
  }
}
register('straw_tuft', {
  family: F, size: 256, alpha: true, note: 'straw: two tufts fanning up, a ragged fringe, loose wisps',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => strawTuft(g, ox + w / 2, oy + h - 4, rnd, { n: 70, len: [50, 110] }),
    (g, ox, oy, w, h, rnd) => strawTuft(g, ox + w / 2, oy + h - 4, rnd, { n: 60, len: [40, 90], spread: 1.25 }),
    (g, ox, oy, w, h, rnd) => { for (let x = ox + 6; x < ox + w - 6; x += 5) strawTuft(g, x, oy + h - 4, rnd, { n: 3, len: [40, 100], spread: 0.35, w: [2.2, 3.6] }); },
    (g, ox, oy, w, h, rnd) => { for (let i = 0; i < 40; i++) { const x = ox + range(rnd, 16, w - 16), y = oy + range(rnd, 30, h - 10); blade(g, x, y, range(rnd, 30, 60), range(rnd, -1.8, 1.8), range(rnd, 2, 3.2), pick(rnd, STRAW), 1, range(rnd, -0.6, 0.6)); } },
  ]),
});

// ---- bark ------------------------------------------------------------------------------------------

register('bark_oak', {
  family: F, size: 256, note: 'Elwynn oak: pale gray-green plates of varied width, lit left edges, deep soft furrows that split and merge',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8e8a78');
    mottle(g, s, rnd, { colors: ['#a49e88', '#7a7464', '#98947e', '#86806e', '#b0a890', '#7e8270', '#8a8a72'], count: 28, rmin: 30, rmax: 84, alpha: 0.45, hard: 0.06, stretch: 2.4, rot: Math.PI / 2 });
    blurTile(cv, 4);
    // 5 plates of varied width between wandering furrows
    const nP = 5, ws = []; for (let i = 0; i < nP; i++) ws.push(range(rnd, 0.6, 1.6));
    const sum = ws.reduce((a, b) => a + b, 0);
    let acc = rnd() * s * 0.2;
    const fur = ws.map(wd => { const x0 = acc; acc += wd / sum * s; return { x0, f: periodic(rnd, 3, 1.1, 1), f2: periodic(rnd, 2, 1, 3), sway: rnd() * TAU, wd: wd / sum * s }; });
    const X = (fu, y) => fu.x0 + fu.f(fract01(y, s)) * 9 + fu.f2(fract01(y, s)) * 3 + Math.sin(TAU * y / s + fu.sway) * 7;
    const path = (fu, dx = 0, off = 0) => { const p = []; for (let y = -24; y <= s + 24; y += 4) p.push([X(fu, y) + dx + off, y]); return p; };
    // Y-splits: a branch leaves one furrow and runs diagonally into the next
    const splits = [];
    for (let i = 0; i < 5; i++) {
      const k = Math.floor(rnd() * nP), a = fur[k], b = fur[(k + 1) % nP], y0 = rnd() * s, len = range(rnd, 40, 80);
      const pts = []; for (let j = 0; j <= 8; j++) { const t = j / 8, y = y0 + t * len; let xb = X(b, y); const xa = X(a, y); if (xb < xa) xb += s; pts.push([xa + (xb - xa) * (t * t * (3 - 2 * t)) + Math.sin(t * 6 + i) * 2, y]); }
      splits.push(pts);
    }
    // plate shading: a cool shadow on each plate's right edge, a warm lit band on its left edge
    layer(g, s, s, tg => tiled(s, dx => { for (const fu of fur) line(tg, path(fu, dx, -8), 14, '#4a4652'); }, false), { alpha: 0.38, blur: 4 });
    layer(g, s, s, tg => tiled(s, dx => { for (const fu of fur) line(tg, path(fu, dx, 9), 10, '#d8d0b4'); for (const p of splits) line(tg, p.map(([x, y]) => [x + dx + 6, y - 4]), 6, '#d8d0b4'); }, false), { alpha: 0.42, blur: 3 });
    // plate middles: soft mid-tone variation, stretched along the trunk
    mottle(g, s, rnd, { colors: ['#8a8474', '#9a9482', '#7e7a6a'], count: 30, rmin: 8, rmax: 22, alpha: 0.25, hard: 0.1, stretch: 3, rot: Math.PI / 2 });
    // the furrows: a soft wide dark pass, then a narrow deep core (one continuous path each)
    layer(g, s, s, tg => tiled(s, dx => {
      for (const fu of fur) line(tg, path(fu, dx), 11, '#3e3640');
      for (const p of splits) line(tg, p.map(([x, y]) => [x + dx, y]), 8, '#3e3640');
    }, false), { alpha: 0.6, blur: 2.6 });
    layer(g, s, s, tg => tiled(s, dx => {
      for (const fu of fur) line(tg, path(fu, dx, 0.8), 3.4, '#2a2430');
      for (const p of splits) line(tg, p.map(([x, y]) => [x + dx, y]), 2.4, '#2a2430');
    }, false), { alpha: 0.6, blur: 1 });
    // short shallow cracks and rough patches inside the plates
    layer(g, s, s, tg => {
      for (let i = 0; i < 40; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 10, 30), a = range(rnd, -0.25, 0.25);
        const pts = [[x, y], [x + Math.sin(a) * L * 0.5 + range(rnd, -2, 2), y + L * 0.5], [x + Math.sin(a) * L, y + L]];
        wrapPts(s, pts, 4, Q => { line(tg, Q.map(([u, v]) => [u + 1.8, v]), 2, '#d0c8ac'); line(tg, Q, 1.6, '#4a4248'); });
      }
    }, { alpha: 0.45, blur: 0.6 });
    mottle(g, s, rnd, { colors: ['#6e6a5c', '#b4ae96', '#5e5a50'], count: 60, rmin: 3, rmax: 9, alpha: 0.18, hard: 0.3, stretch: 2, rot: Math.PI / 2 });
    // a few short horizontal breaks across plates
    layer(g, s, s, tg => {
      for (let i = 0; i < 6; i++) {
        const k = Math.floor(rnd() * nP), a = fur[k], b = fur[(k + 1) % nP], y = rnd() * s;
        let xa = X(a, y), xb = X(b, y + 3); if (xb < xa) xb += s;
        const x0 = xa + (xb - xa) * range(rnd, 0, 0.3), x1 = xa + (xb - xa) * range(rnd, 0.55, 1), dy = range(rnd, -5, 5);
        const pts = [[x0, y], [(x0 + x1) / 2, y + dy * 0.5 + range(rnd, -2, 2)], [x1, y + dy]];
        wrapPts(s, pts, 6, P => { line(tg, P.map(([u, v]) => [u, v - 2.4]), 2.4, '#d4ccb0'); line(tg, P, 3.6, '#342c36'); });
      }
    }, { alpha: 0.45, blur: 1.2 });
    // grain, knots, lichen
    streaks(g, s, rnd, { colors: ['#6a6454', '#5e584c', '#aaa48c', '#bcb498'], count: 90, len: [12, 40], width: [0.8, 1.6], angle: 0, wobble: 0.1, alpha: 0.22 });
    for (let i = 0; i < 2; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 8);
      wrap(s, x, y, r * 2, (X2, Y2) => {
        ellipse(g, X2, Y2, r * 1.5, r, 0, '#5a5248', 0.8);
        ellipse(g, X2, Y2, r * 0.8, r * 0.5, 0, '#3a3236', 0.85);
        blob(g, X2 - r * 0.6, Y2 - r * 0.6, r, r * 0.5, 0, '#d4ccae', 0.4, 0.4);
      });
    }
    mottle(g, s, rnd, { colors: ['#8e9a6a', '#7a8a58', '#a4a88a', '#b4b090'], count: 26, rmin: 2, rmax: 6, alpha: 0.4, hard: 0.6 });
    glaze(g, s, s, '#ffe8b8', 0.12, 'soft-light');
    blurTile(cv, 0.45);
  },
});

register('bark_pine', {
  family: F, size: 256, note: 'red-brown scaly plates with dark seams (stretch v on the mesh)',
  paint(g, s, rnd, h, cv) {
    const f = worley(s, 6, rnd, 0.9);
    paintCells(g, f, { colors: ['#7a4c36', '#8a5a3e', '#6c4232', '#93634a', '#7f5442'], grout: '#33242a', groutW: 2.6, bevel: 7, dome: 0.25, light: 0.55, varAmt: 0.08, rnd });
    mottle(g, s, rnd, { colors: ['#a06a4a', '#5e3a2c', '#8a6450', '#6e5048'], count: 30, rmin: 10, rmax: 40, alpha: 0.25, hard: 0.2 });
    streaks(g, s, rnd, { colors: ['#3a2628', '#4a3030'], count: 30, len: [20, 60], width: [1, 2], angle: 0, wobble: 0.1, alpha: 0.45 });
    mottle(g, s, rnd, { colors: ['#c08a62', '#b47c58'], count: 40, rmin: 3, rmax: 8, alpha: 0.35, hard: 0.4 });
    mottle(g, s, rnd, { colors: ['#8a9468', '#9aa078'], count: 10, rmin: 4, rmax: 10, alpha: 0.3, hard: 0.5 });
    glaze(g, s, s, '#ffd8a8', 0.1, 'soft-light');
    blurTile(cv, 0.45);
  },
});

register('bark_dead', {
  family: F, size: 256, note: 'bleached deadwood: long grain, dark splits with lit lips, knots',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8e877c');
    mottle(g, s, rnd, { colors: ['#a29c90', '#766e64', '#aea898', '#86796a', '#6a6664', '#9a8a7a'], count: 30, rmin: 20, rmax: 70, alpha: 0.5, hard: 0.08, stretch: 3, rot: Math.PI / 2 });
    blurTile(cv, 2.5);
    streaks(g, s, rnd, { colors: ['#564e48', '#625a52', '#6e6458'], count: 120, len: [50, 170], width: [0.8, 2.2], angle: 0, wobble: 0.07, alpha: 0.42 });
    streaks(g, s, rnd, { colors: ['#bcb6a8', '#cac2b2', '#d8d0c0'], count: 100, len: [40, 150], width: [0.8, 2], angle: 0, wobble: 0.07, alpha: 0.42 });
    layer(g, s, s, tg => {
      for (let i = 0; i < 9; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 50, 140), f = periodic(rnd, 2, 1, 1), wd = range(rnd, 2, 3.4);
        const pts = []; for (let k = 0; k <= 10; k++) pts.push([x + f(k / 10) * 5, y + L * k / 10]);
        wrapPts(s, pts, 6, P => { line(tg, P.map(([u, v]) => [u + 2, v]), 2.5, '#e4dccc'); line(tg, P, wd, '#2e2830'); });
      }
    }, { alpha: 0.7, blur: 0.5 });
    for (let i = 0; i < 2; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 6, 10);
      wrap(s, x, y, r * 2.2, (X, Y) => {
        ellipse(g, X, Y, r * 0.8, r * 1.8, 0, '#5a524c', 0.8);
        ellipse(g, X, Y, r * 0.45, r, 0, '#2e2830', 0.85);
        blob(g, X - r * 0.5, Y - r * 0.8, r * 0.5, r * 0.9, 0, '#e0d8c8', 0.35, 0.4);
      });
    }
    glaze(g, s, s, '#ffe8c0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('bark_palm', {
  family: F, size: 256, note: 'palm trunk: overlapping diamond leaf-base scales in staggered rows, fibre between',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#5a4632');
    // fibre crosshatch in the gaps
    streaks(g, s, rnd, { colors: ['#7a6040', '#4a3828', '#8a7050'], count: 160, len: [10, 22], width: [1, 1.8], angle: 0.6, wobble: 0.3, alpha: 0.5 });
    streaks(g, s, rnd, { colors: ['#7a6040', '#4a3828', '#9a8058'], count: 160, len: [10, 22], width: [1, 1.8], angle: -0.6, wobble: 0.3, alpha: 0.5 });
    // rows of scales: heights vary 12..24 px (normalized to tile exactly), alternate rows offset
    const hs = []; let tot = 0;
    while (tot < s - 12) { const hh = range(rnd, 14, 26); hs.push(hh); tot += hh; }
    const kH = s / tot;
    let y = 0;
    const rows = hs.map((hh, i) => { const r = { y, h: hh * kH, i }; y += hh * kH; return r; });
    const nPer = 7;
    const scale = (X, Y, w, hh, c, fib) => {
      // a rounded diamond: point at the top, wide shoulders, a cupped lower edge
      const pts = [[X, Y - hh * 0.62], [X + w * 0.5, Y - hh * 0.05], [X + w * 0.3, Y + hh * 0.42], [X, Y + hh * 0.5], [X - w * 0.3, Y + hh * 0.42], [X - w * 0.5, Y - hh * 0.05]];
      poly(g, pts.map(([u, v]) => [u + 1.5, v + 3.5]), '#3a2a1e', 0.75);          // the dark undercut under its lip
      const gr = g.createLinearGradient(X - w * 0.4, Y - hh * 0.6, X + w * 0.4, Y + hh * 0.5);
      gr.addColorStop(0, lightOf(c, 0.45)); gr.addColorStop(0.45, c); gr.addColorStop(1, shadowOf(c, 0.45));
      poly(g, pts, gr, 1);
      line(g, [pts[5], pts[0], pts[1]].map(([u, v]) => [u + 0.6, v + 1.2]), 1.6, lightOf(c, 0.6), 0.6);   // lit upper edges
      line(g, [pts[2], pts[3], pts[4]], 2.2, '#4a3626', 0.8);                                          // the dark lower lip
      for (const [fu, fd] of fib) { const fx = X + fu * w; line(g, [[fx, Y - hh * 0.3], [fx + fd, Y + hh * 0.35]], 0.9, shadowOf(c, 0.3), 0.4); }
    };
    // every scale (and its wrapped copies), drawn bottom first so each row's lower lip overlaps
    // the row under it, the same order across the wrap
    const w = s / nPer, draws = [];
    rows.forEach((r, ri) => {
      const off = (ri % 2) * w * 0.5 + range(rnd, -2, 2);
      for (let k = 0; k < nPer; k++) {
        const X = off + k * w + range(rnd, -2, 2), Y = r.y + r.h * 0.5, c = jitter(pick(rnd, ['#8e7652', '#9a8058', '#86704c', '#a08a62']), rnd, 0.06);
        const fib = [0, 1, 2, 3].map(() => [range(rnd, -0.25, 0.25), range(rnd, -2, 2)]);
        for (const dy of [-s, 0, s]) for (const dx of [-s, 0, s]) if (Y + dy > -r.h * 2 && Y + dy < s + r.h * 2 && X + dx > -w && X + dx < s + w) draws.push([X + dx, Y + dy, r.h, c, fib]);
      }
    });
    draws.sort((a, b) => b[1] - a[1]);
    for (const [X, Y, hh, c, fib] of draws) scale(X, Y, w * 1.05, hh * 1.3, c, fib);
    mottle(g, s, rnd, { colors: ['#a08a64', '#6e5a40', '#9a9070'], count: 30, rmin: 10, rmax: 40, alpha: 0.18, hard: 0.2 });
    glaze(g, s, s, '#ffe0a8', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  },
});

register('wood_fence', {
  family: F, size: 256, note: 'weathered split-rail wood: long grain, silver weathering over warm brown cracks, dark splits',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#6a5038');
    // silver weathering laid over the warm brown, broken by long cracks of the brown showing through
    mottle(g, s, rnd, { colors: ['#9a9282', '#8a8070', '#a8a090', '#7a6e5e'], count: 40, rmin: 20, rmax: 60, alpha: 0.7, hard: 0.15, stretch: 4, rot: Math.PI / 2 });
    blurTile(cv, 2);
    streaks(g, s, rnd, { colors: ['#5a4430', '#6a5038', '#4a3828'], count: 120, len: [60, 200], width: [1.2, 3.2], angle: 0, wobble: 0.05, alpha: 0.6 });
    streaks(g, s, rnd, { colors: ['#c8bca0', '#b8ae96', '#d4c8ac'], count: 120, len: [40, 160], width: [0.8, 2], angle: 0, wobble: 0.05, alpha: 0.5 });
    layer(g, s, s, tg => {
      for (let i = 0; i < 7; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 60, 160), f = periodic(rnd, 2, 1, 1);
        const pts = []; for (let k = 0; k <= 10; k++) pts.push([x + f(k / 10) * 3, y + L * k / 10]);
        wrapPts(s, pts, 6, P => { line(tg, P.map(([u, v]) => [u + 2.2, v]), 2.4, '#d4c8ac'); line(tg, P.map(([u, v]) => [u - 1, v]), 4, '#6a5038'); line(tg, P, 2.2, '#3a3030'); });
      }
    }, { alpha: 0.85, blur: 0.4 });
    for (let i = 0; i < 2; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 8);
      wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r * 0.9, r * 1.5, 0, '#4a3a2e', 0.85); ellipse(g, X, Y, r * 0.4, r * 0.8, 0, '#2a2026', 0.9); blob(g, X - r * 0.5, Y - r * 0.7, r * 0.5, r * 0.8, 0, '#d8c8a8', 0.4, 0.4); });
    }
    mottle(g, s, rnd, { colors: ['#8a9a6a', '#a4a070'], count: 8, rmin: 3, rmax: 7, alpha: 0.3, hard: 0.5 });
    glaze(g, s, s, '#ffe2b0', 0.08, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// ---- rock -----------------------------------------------------------------------------------------

// A rock face the WoW way: no cells. Big soft value planes, then a few long fractures (a cool dark
// crease with a lit lip on the upper-left side), chipped angular patches lit on their upper-left
// edges, lichen colonies and rain stains. Form comes from the mesh's planes and its vertex AO.
function rockPaint(g, s, rnd, cv, P) {
  fill(g, s, s, P.base);
  mottle(g, s, rnd, { colors: P.big, count: 9, rmin: 110, rmax: 220, alpha: 0.55, hard: 0.04 });
  mottle(g, s, rnd, { colors: P.blot, count: 30, rmin: 30, rmax: 90, alpha: 0.22, hard: 0.08 });
  blurTile(cv, 5);
  // chipped planes: soft angular patches, lighter or darker, lit on the upper-left edges
  layer(g, s, s, tg => {
    for (let i = 0; i < (P.planes ?? 11); i++) {
      const cx = rnd() * s, cy = rnd() * s, r = range(rnd, 60, 150), n = 4 + Math.floor(rnd() * 3), a0 = rnd() * TAU, sq = range(rnd, 0.55, 0.9);
      const pts = []; for (let k = 0; k < n; k++) { const a = a0 + (k + range(rnd, -0.25, 0.25)) / n * TAU, rr = r * range(rnd, 0.6, 1.1); pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr * sq]); }
      const lighter = rnd() < 0.55, c = lighter ? lightOf(P.base, 0.3) : shadowOf(P.base, 0.25);
      wrapPts(s, pts, 4, Q => {
        poly(tg, Q, c, 0.5);
        for (let k = 0; k < n; k++) {
          const A = Q[k], B = Q[(k + 1) % n], nx = B[1] - A[1], ny = -(B[0] - A[0]), l = Math.hypot(nx, ny) || 1;
          const up = (-nx - ny) / l / Math.SQRT2;       // edge normal toward the upper left
          if (up > 0.25) line(tg, [A, B], 5, P.lip, 0.9 * up);
          else if (up < -0.25) line(tg, [A, B], 6, P.crease, 0.8 * -up);
        }
      });
    }
  }, { alpha: 0.42, blur: 3.5 });
  // long fractures
  const frac = [];
  layer(g, s, s, tg => {
    for (let i = 0; i < (P.fractures ?? 7); i++) {
      let x = rnd() * s, y = rnd() * s, a = range(rnd, 0.6, 2.5) * (rnd() < 0.5 ? 1 : -1);
      const pts = [[x, y]], segs = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < segs; k++) { a += range(rnd, -0.5, 0.5); const L = range(rnd, 28, 70); x += Math.cos(a) * L; y += Math.sin(a) * L; pts.push([x, y]); }
      const br = []; if (rnd() < 0.3) { const [bx, by] = pts[1 + Math.floor(rnd() * (pts.length - 1))], ba = a + range(rnd, 0.6, 1.2) * (rnd() < 0.5 ? 1 : -1), bl = range(rnd, 18, 40); br.push([bx, by], [bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl]); }
      frac.push(pts); if (br.length) frac.push(br);
    }
  }, { alpha: 0, blur: 0 });
  // each fracture: a wide soft cool shadow, a lit lip on its upper-left side, a dark core
  layer(g, s, s, tg => { for (const pts of frac) wrapPts(s, pts, 10, Q => line(tg, Q.map(([u, v]) => [u + 2, v + 2.5]), 9, P.crease)); }, { alpha: 0.45, blur: 3 });
  layer(g, s, s, tg => { for (const pts of frac) wrapPts(s, pts, 10, Q => line(tg, Q.map(([u, v]) => [u - 2.2, v - 2.2]), 3.4, P.lip)); }, { alpha: 0.55, blur: 1.2 });
  layer(g, s, s, tg => { for (const pts of frac) wrapPts(s, pts, 10, Q => line(tg, Q, 2.6, P.deep)); }, { alpha: 0.75, blur: 0.7 });
  // chips
  for (let i = 0; i < 40; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 3, 8), a0 = rnd() * TAU;
    const pts = []; for (let k = 0; k < 4; k++) { const a = a0 + k / 4 * TAU + range(rnd, -0.3, 0.3); pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 0.75]); }
    wrapPts(s, pts, 2, Q => { poly(g, Q.map(([u, v]) => [u + 1.2, v + 1.4]), P.crease, 0.35); poly(g, Q, lightOf(P.base, 0.35), 0.5); });
  }
  if (P.fleck) mottle(g, s, rnd, { colors: P.fleck, count: P.fleckN ?? 120, rmin: 1.2, rmax: 3, alpha: 0.5, hard: 0.6 });
  if (P.lichen) {
    for (let c = 0; c < 14; c++) {
      const cx = rnd() * s, cy = rnd() * s, col = pick(rnd, P.lichen);
      for (let k = 0; k < 14; k++) { const x = cx + range(rnd, -14, 14), y = cy + range(rnd, -10, 10), r = range(rnd, 1.8, 5); wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 0.8, 0, col, 0.6); blob(g, X - r * 0.3, Y - r * 0.3, r * 0.5, r * 0.4, 0, lightOf(col, 0.4), 0.5, 0.4); }); }
    }
  }
  streaks(g, s, rnd, { colors: [P.stain], count: 22, len: [40, 120], width: [4, 12], angle: Math.PI, wobble: 0.08, alpha: 0.1 });
  glaze(g, s, s, P.glaze, 0.12, 'soft-light');
  blurTile(cv, 0.6);
}

register('rock_gray', {
  family: F, size: 512, note: 'Elwynn rock: warm-cool gray planes, long fractures with lit lips, chips, lichen (moss comes from the cover)',
  paint: (g, s, rnd, h, cv) => rockPaint(g, s, rnd, cv, {
    base: '#88847a', big: ['#a29c8e', '#6c6a66', '#8a8c7c', '#9a9284', '#767472'], blot: ['#a09a8e', '#6a6764', '#7c866c', '#8c8070', '#a8a294'],
    lip: '#e2d8bc', crease: '#4a4652', deep: '#36323e', stain: '#4a4650',
    fleck: ['#b4ae9e', '#5e5a58'], lichen: ['#a8ac7a', '#8e9a66', '#b8b08a', '#c2a868'], glaze: '#ffe2b0',
  }),
});
register('rock_warm', {
  family: F, size: 512, note: 'Westfall rock: sun-warmed tan-gray, yellow and orange lichen',
  paint: (g, s, rnd, h, cv) => rockPaint(g, s, rnd, cv, {
    base: '#958a76', big: ['#aea08a', '#786e60', '#a49478', '#8a7e6a'], blot: ['#ab9e84', '#776c5e', '#a08860', '#8a7a62'],
    lip: '#ecdcb8', crease: '#54484a', deep: '#3e3432', stain: '#5a4a3e',
    fleck: ['#c0b498', '#665a4e'], lichen: ['#c8b45a', '#d09848', '#b8a858', '#a8a860', '#d8a040'], glaze: '#ffdca0',
  }),
});
register('rock_granite', {
  family: F, size: 512, note: 'Dun Morogh granite: blue-gray planes, pale feldspar flecks, cold fractures',
  paint: (g, s, rnd, h, cv) => rockPaint(g, s, rnd, cv, {
    base: '#7a828e', big: ['#9aa4b4', '#5c6474', '#848c9a', '#6a7280'], blot: ['#9aa2ae', '#5a6070', '#7c8090', '#8a8c96'],
    lip: '#e4ecf4', crease: '#3e4256', deep: '#2c2e40', stain: '#3c4050',
    fleck: ['#c8ccd6', '#d8dce2', '#4a4e5c', '#a8acb8'], fleckN: 260, glaze: '#e0ecff', fractures: 9,
  }),
});

// Strata: horizontal bands with a lit ledge on top, a face that darkens downward and a dark crease
// under it; vertical erosion streaks. y is world height on the mesh, so bands stay level. Seamless
// both ways: the band heights add up to the tile exactly and every band (the wrap included) is
// drawn tiled vertically, so the wrap is just another wobbly ledge.
function strata(g, s, rnd, cv, P) {
  fill(g, s, s, P.cols[0]);
  const hs = []; let tot = 0;
  while (tot < s - P.band[0] * 0.5) { const hh = range(rnd, P.band[0], P.band[1]); hs.push(hh); tot += hh; }
  const k = s / tot;
  let y = 0;
  const bands = hs.map(hh => { const b = { y0: y, hh: hh * k, c: pick(rnd, P.cols), f: periodic(rnd, 4, 1.1, 1) }; y += hh * k; return b; });
  const n = bands.length;
  const top = (i, x) => { const b = bands[((i % n) + n) % n], wrapK = Math.floor(i / n); return b.y0 + wrapK * s + b.f(fract01(x, s)) * P.wob; };
  for (const dy of [-s, 0, s]) {
    for (let i = 0; i < n; i++) {
      const b = bands[i];
      g.beginPath();
      for (let x = -8; x <= s + 8; x += 4) g.lineTo(x, top(i, x) + dy);
      for (let x = s + 8; x >= -8; x -= 4) g.lineTo(x, top(i + 1, x) + dy + 0.5);
      g.closePath();
      const gr = g.createLinearGradient(0, b.y0 + dy, 0, b.y0 + b.hh + dy);
      gr.addColorStop(0, lightOf(b.c, 0.5)); gr.addColorStop(Math.min(0.3, 6 / b.hh), lightOf(b.c, 0.2)); gr.addColorStop(0.45, b.c);
      gr.addColorStop(0.9, shadowOf(b.c, 0.25)); gr.addColorStop(1, shadowOf(b.c, 0.5));
      g.fillStyle = gr; g.fill();
    }
  }
  // ledge lines on every boundary
  layer(g, s, s, tg => {
    for (const dy of [-s, 0, s]) for (let i = 0; i < n; i++) {
      const c = bands[(i - 1 + n) % n].c, pts = []; for (let x = -8; x <= s + 8; x += 4) pts.push([x, top(i, x) + dy + 0.5]);
      line(tg, pts.map(([u, v]) => [u, v - 1.6]), P.crease, shadowOf(c, 0.6), 0.6 * P.lines);
      line(tg, pts.map(([u, v]) => [u, v + 1.6]), 3, lightOf(bands[i].c, 0.45), 0.5 * P.lines);
    }
  }, { alpha: 0.75, blur: 0.8 });
  mottle(g, s, rnd, { colors: P.blot, count: 50, rmin: 16, rmax: 70, alpha: 0.22, hard: 0.15, stretch: 1.8, rot: 0 });
  streaks(g, s, rnd, { colors: P.streak, count: P.streakN, len: [30, 140], width: [2, 7], angle: Math.PI, wobble: 0.1, alpha: 0.16 });
  if (P.pock) for (let i = 0; i < P.pock; i++) {
    const x = rnd() * s, y2 = rnd() * s, r = range(rnd, 3, 9), c = pick(rnd, P.cols);
    wrap(s, x, y2, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 0.7, 0, shadowOf(c, 0.6), 0.7); blob(g, X + r * 0.1, Y + r * 0.55, r * 0.9, r * 0.3, 0, lightOf(c, 0.6), 0.6, 0.5); });
  }
  cracks(g, s, rnd, { color: P.crack, count: P.crackN, len: [20, 70], width: [1, 2], alpha: 0.4 });
  glaze(g, s, s, P.glaze, 0.12, 'soft-light');
  blurTile(cv, 0.7);
}
register('rock_red', {
  family: F, size: 512, note: 'Badlands strata: red-orange-ochre bands, lit ledges, erosion streaks (seamless)',
  paint: (g, s, rnd, h, cv) => strata(g, s, rnd, cv, {
    cols: ['#8e3e22', '#b4552f', '#cf7a45', '#e3a066', '#a8482a', '#c4683a', '#9a4a2c'], band: [18, 72], wob: 5, crease: 3.5, lines: 1,
    blot: ['#d88a56', '#7a3420', '#c06a40', '#e8b07a'], streak: ['#5a2418', '#6a2c1c', '#f0b884'], streakN: 70, pock: 8,
    crack: '#3e1a14', crackN: 8, glaze: '#ffd0a0',
  }),
});
register('rock_sand', {
  family: F, size: 512, note: 'Tanaris sandstone: pale soft layers, wind-scoured, pocked (seamless)',
  paint: (g, s, rnd, h, cv) => strata(g, s, rnd, cv, {
    cols: ['#c99e6c', '#d8b484', '#e4c89a', '#b88c5e', '#d0a878', '#dcbc8c'], band: [26, 90], wob: 7, crease: 2, lines: 0.5,
    blot: ['#e8d0a4', '#a8804e', '#c4965e', '#f0dcb4'], streak: ['#8e6a44', '#f4e2bc'], streakN: 40, pock: 30,
    crack: '#5e4430', crackN: 4, glaze: '#fff0c8',
  }),
});

// ---- top cover (moss, snow, dust...) ---------------------------------------------------------------

function cover(paintColor, paintMask, lo = 0.15) {
  return (g, s, rnd) => {
    const C = makeCanvas(s), M = makeCanvas(s);
    const cg = C.getContext('2d', { willReadFrequently: true }), mg = M.getContext('2d', { willReadFrequently: true });
    paintColor(cg, s, rnd, C);
    fill(mg, s, s, '#000');
    paintMask(mg, s, rnd, M);
    withMask(g, s, C, M, lo, 1);
  };
}
// thickness: soft white patches; `stipple` small dark specks fray the edges (no big round holes)
const lumpyMask = (n, r0, r1, a = 0.6, blur = 3, stipple = 0) => (g, s, rnd, cv) => {
  mottle(g, s, rnd, { colors: ['#ffffff'], count: n, rmin: r0, rmax: r1, alpha: a, hard: 0.55 });
  if (stipple) mottle(g, s, rnd, { colors: ['#000000'], count: stipple, rmin: 1.2, rmax: 3.5, alpha: 0.7, hard: 0.7 });
  blurTile(cv, blur);
};

register('cover_moss', {
  family: F, size: 256, alpha: true, note: 'moss: dark olive, stippled clumps and tiny tufts (alpha = thickness)',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#4c6428');
    mottle(g, s, rnd, { colors: ['#3e5422', '#5a7030', '#66783a', '#46602a', '#56682e'], count: 50, rmin: 8, rmax: 34, alpha: 0.5, hard: 0.2 });
    for (let i = 0; i < 700; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.2, 3), c = pick(rnd, ['#5a7030', '#66783a', '#4c6428', '#728440', '#40561f']);
      wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X + 0.6, Y + 0.7, r, r * 0.8, 0, '#2e3c1c', 0.35); ellipse(g, X, Y, r, r * 0.8, 0, c, 0.9); });
    }
    for (let i = 0; i < 160; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 8, (X, Y) => blade(g, X, Y, range(rnd, 3, 7), range(rnd, -0.6, 0.6), 1.3, pick(rnd, ['#8c9a4a', '#7a8c40', '#9aa458']), 0.85, range(rnd, -0.3, 0.3))); }
    glaze(g, s, s, '#ffe7a0', 0.08, 'soft-light');
  }, lumpyMask(60, 8, 30, 0.6, 1.6, 500)),
});
register('cover_lichen', {
  family: F, size: 256, alpha: true, note: 'Westfall: dry golden lichen and grass on rock tops',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#a89848');
    mottle(g, s, rnd, { colors: ['#c0ae58', '#8a8a40', '#b8a050', '#988a3e'], count: 50, rmin: 8, rmax: 30, alpha: 0.5, hard: 0.3 });
    mottle(g, s, rnd, { colors: ['#d08a40', '#c87a38', '#e0b060'], count: 60, rmin: 3, rmax: 8, alpha: 0.6, hard: 0.6 });
    for (let i = 0; i < 300; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 12, (X, Y) => blade(g, X, Y, range(rnd, 5, 10), range(rnd, -0.6, 0.6), 1.4, pick(rnd, ['#d8c47a', '#b8a050', '#8a7a3a']), 0.8)); }
  }, lumpyMask(80, 6, 24, 0.55, 1.6, 400)),
});
const paintSnow = (g, s, rnd) => {
  fill(g, s, s, '#e6edf4');
  mottle(g, s, rnd, { colors: ['#f6f7f4', '#dce5f0', '#cfdbe8', '#fbfaf4'], count: 60, rmin: 14, rmax: 50, alpha: 0.6, hard: 0.25 });
  for (let i = 0; i < 70; i++) {
    const x = rnd() * s, y = rnd() * s, r = range(rnd, 6, 16);
    wrap(s, x, y, r * 2, (X, Y) => { blob(g, X + r * 0.4, Y + r * 0.5, r * 1.1, r * 0.6, 0, '#b4c6dc', 0.45, 0.35); blob(g, X - r * 0.2, Y - r * 0.25, r * 0.8, r * 0.55, 0, '#ffffff', 0.7, 0.45); });
  }
  for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 3, (X, Y) => blob(g, X, Y, 1.6, 1.6, 0, '#ffffff', 0.9, 0.7)); }
};
register('cover_snow', {
  family: F, size: 256, alpha: true, note: 'snow on every ledge: white lumps, blue shadow pockets, sparkle (no holes)',
  paint: cover(paintSnow, lumpyMask(70, 16, 48, 0.7, 4), 0.35),
});
register('snow_pack', {
  family: F, size: 256, note: 'opaque packed snow for the snow caps on rocks: soft blue hollows, sparkle',
  paint(g, s, rnd, h, cv) { paintSnow(g, s, rnd); blurTile(cv, 0.8); },
});
register('cover_dust', {
  family: F, size: 256, alpha: true, note: 'Badlands: ochre dust and grit settled on ledges',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#b8784a');
    mottle(g, s, rnd, { colors: ['#c88a58', '#a86a40', '#d09460', '#9a5e3a'], count: 50, rmin: 10, rmax: 40, alpha: 0.45, hard: 0.2 });
    for (let i = 0; i < 160; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.5, 3.5); wrap(s, x, y, r * 2, (X, Y) => lump(g, X, Y, r, pick(rnd, ['#a86a44', '#d8a070', '#8a5236']), 0.8)); }
  }, lumpyMask(50, 18, 50, 0.6, 5)),
});
register('cover_sand', {
  family: F, size: 256, alpha: true, note: 'Tanaris: pale sand drifted onto rock tops, with ripples',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#d8b884');
    mottle(g, s, rnd, { colors: ['#e2c696', '#c8a872', '#ead2a4', '#c0a06c'], count: 40, rmin: 12, rmax: 50, alpha: 0.45, hard: 0.15 });
    for (let k = 0; k < 18; k++) {
      const f = periodic(rnd, 3, 1, 1), y0 = k * s / 18 + range(rnd, -3, 3);
      const pts = wavy(s, f, 5, y0, false, 10, 6);
      stroke(g, pts.map(([x, y]) => [x, y + 1.6]), 2.2, 2.2, '#b8945e', 0.35);
      stroke(g, pts, 1.6, 1.6, '#fbecc8', 0.5);
    }
  }, lumpyMask(40, 22, 60, 0.6, 6)),
});

// ---- props ------------------------------------------------------------------------------------------

register('cactus_skin', {
  family: F, size: 256, note: 'saguaro: sage-green, 4 ribs per tile (crests at x = 0, 64, 128, 192), areoles with pale spines',
  paint(g, s, rnd, h, cv) {
    const rib = s / 4;
    for (let x = 0; x < s; x++) {
      const t = ((x % rib) + rib) % rib / rib;                 // 0 crest, 0.5 groove, 1 crest
      const d = Math.abs(t - 0.5) * 2;                         // 1 at crest, 0 in the groove
      const left = t > 0.5;                                    // left flank of the next crest faces the light
      let c = mix('#2c4434', '#5e7c48', Math.pow(d, 0.75));
      if (d > 0.62) c = mix(c, left ? '#9cb46a' : '#7a9658', (d - 0.62) / 0.38 * (left ? 0.95 : 0.5));
      if (d > 0.9 && left) c = mix(c, '#d8d4a0', (d - 0.9) / 0.1 * 0.35);
      g.fillStyle = c; g.fillRect(x, 0, 1, s);
    }
    mottle(g, s, rnd, { colors: ['#58764a', '#6e8a52', '#4a663e', '#7a9058', '#6a7a4a'], count: 40, rmin: 10, rmax: 40, alpha: 0.2, hard: 0.15, stretch: 2.5, rot: Math.PI / 2 });
    for (let i = 0; i < 5; i++) { const y = rnd() * s; wrap(s, s / 2, y, s, (X, Y) => blob(g, X, Y, s * 0.7, 5, 0, '#2c4434', 0.1, 0.3)); }
    // areoles + spines along each crest, hand-placed (jittered, varied)
    for (let k = 0; k < 4; k++) {
      const x0 = k * rib;
      for (let y = range(rnd, 0, 10); y < s - 4; y += range(rnd, 16, 27)) {
        const X0 = x0 + range(rnd, -5, 5), sz = range(rnd, 0.7, 1.25);
        wrap(s, X0, y, 14, (X, Y) => {
          for (let j = 0; j < 3 + Math.floor(rnd() * 4); j++) {
            const a = range(rnd, -2.4, 2.4), L = range(rnd, 4, 10) * sz;
            stroke(g, [[X, Y], [X + Math.sin(a) * L, Y - Math.cos(a) * L]], 1.2, 0.3, '#e8dcb0', 0.8);
          }
          blob(g, X + 0.8, Y + 0.8, 3.2 * sz, 2.6 * sz, 0, '#24382a', 0.4, 0.4);
          ellipse(g, X, Y, 2.4 * sz, 2 * sz, 0, '#cfc29c', 1);
          blob(g, X - 0.6, Y - 0.6, 1.3 * sz, 1.1 * sz, 0, '#fff8e0', 0.8, 0.5);
        });
      }
    }
    glaze(g, s, s, '#fff0c0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('hay', {
  family: F, size: 256, note: 'straw: clumped bundles of strands in three values, dark gaps between (strands run across, u)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#6e5226');
    mottle(g, s, rnd, { colors: ['#8a6a30', '#5e4420', '#7a5a28'], count: 30, rmin: 16, rmax: 50, alpha: 0.5, hard: 0.1 });
    // bundles: a run of parallel strands at a shared slant, lit on top, shadowed under
    const bundle = (x, y, L, a, n, cols) => {
      for (let i = 0; i < n; i++) {
        const oy = (i - n / 2) * 2.2 + range(rnd, -0.6, 0.6), ox = range(rnd, -6, 6), l = L * range(rnd, 0.7, 1.1);
        const pts = []; for (let k = 0; k <= 4; k++) { const t = k / 4; pts.push([x + ox + Math.cos(a) * l * t, y + oy + Math.sin(a) * l * t + Math.sin(t * 3 + i) * 1.2]); }
        const c = i < n * 0.3 ? cols[2] : i > n * 0.75 ? cols[0] : cols[1];
        wrapPts(s, pts, 4, Q => line(g, Q, range(rnd, 1.4, 2.4), jitter(c, rnd, 0.06), 0.95));
      }
    };
    for (let i = 0; i < 70; i++) bundle(rnd() * s, rnd() * s, range(rnd, 40, 90), range(rnd, -0.25, 0.25) + (rnd() < 0.5 ? 0 : Math.PI), 4 + Math.floor(rnd() * 6), [shadowOf('#b88c40', 0.35), '#c49c4c', '#f0d488']);
    for (let i = 0; i < 40; i++) bundle(rnd() * s, rnd() * s, range(rnd, 30, 60), range(rnd, -0.3, 0.3), 3 + Math.floor(rnd() * 3), ['#8a6a30', '#d8b460', '#fff0c0']);
    for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s, a = rnd() * TAU, L = range(rnd, 8, 20); wrapPts(s, [[x, y], [x + Math.cos(a) * L, y + Math.sin(a) * L]], 4, Q => line(g, Q, 1.2, pick(rnd, ['#e8c878', '#7a5a28']), 0.6)); }
    glaze(g, s, s, '#ffd890', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('hay_end', {
  family: F, size: 256, note: 'round-bale end: a hand-jittered straw spiral, darker core, lit upper-left rim',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8a6a30');
    const c = s / 2, R = s * 0.49, turns = 6.5;
    const gr = g.createRadialGradient(c, c, 0, c, c, R);
    gr.addColorStop(0, '#7a5a28'); gr.addColorStop(0.25, '#b08a40'); gr.addColorStop(0.85, '#c8a050'); gr.addColorStop(1, '#8a6a30');
    g.fillStyle = gr; g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
    const rn = periodic(rnd, 5, 0.9, 2);
    const rad = t => { const f = t / (turns * TAU); return (8 + f * (R - 12)) * (1 + rn((t / TAU) % 1) * 0.08 * Math.min(1, f * 3)); };
    // the spiral's dark gap, broken here and there
    layer(g, s, s, tg => {
      let pts = [];
      for (let t = 0; t < turns * TAU; t += 0.05) {
        pts.push([c + Math.cos(t) * rad(t), c + Math.sin(t) * rad(t)]);
        if (rnd() < 0.012 && pts.length > 4) { line(tg, pts, range(rnd, 2.5, 4), '#4e3818'); pts = []; t += range(rnd, 0.1, 0.4); }
      }
      if (pts.length > 1) line(tg, pts, 3, '#4e3818');
    }, { alpha: 0.6, blur: 0.8 });
    for (let i = 0; i < 1100; i++) {
      const t = rnd() * turns * TAU, r = rad(t) + range(rnd, 2, 9), a = t + range(rnd, -0.05, 0.05);
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r, L = range(rnd, 6, 18);
      const tx = -Math.sin(a), ty = Math.cos(a), lit = -(Math.cos(a) + Math.sin(a)) > 0.3;
      stroke(g, [[x, y], [x + tx * L, y + ty * L]], range(rnd, 1, 2.2), 0.6, pick(rnd, lit ? ['#e8c878', '#f4dc98', '#d8b460', '#fff0c0'] : ['#c09848', '#a88038', '#d8b460', '#8a6a30']), 0.8);
    }
    for (let i = 0; i < 30; i++) {   // broken strands sticking out
      const a = rnd() * TAU, r = range(rnd, 0.3, 0.95) * R, x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      stroke(g, [[x, y], [x + range(rnd, -12, 12), y + range(rnd, -12, 12)]], 1.6, 0.6, pick(rnd, ['#f4dc98', '#c09848']), 0.9);
    }
    const lg = g.createLinearGradient(c - R, c - R, c + R, c + R);
    lg.addColorStop(0, 'rgba(255,240,190,0.3)'); lg.addColorStop(0.5, 'rgba(255,240,190,0)'); lg.addColorStop(1, 'rgba(40,30,60,0.32)');
    g.fillStyle = lg; g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
    glaze(g, s, s, '#ffd890', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('stump_top', {
  family: F, size: 256, note: 'cut stump: growth rings, sapwood, radial cracks, bark rim; lit upper left',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#4e3a2c');
    const c = s / 2, R = s * 0.43;
    const wob = periodic(rnd, 4, 1.1, 2);
    const ringPath = (r, k = 1) => { g.beginPath(); for (let i = 0; i <= 72; i++) { const a = i / 72 * TAU, rr = r * (1 + wob(i / 72) * 0.05 * k); g.lineTo(c + Math.cos(a) * rr, c + Math.sin(a) * rr); } g.closePath(); };
    ringPath(R * 1.14); g.fillStyle = '#4a3628'; g.fill();
    const gr = g.createRadialGradient(c, c, 0, c, c, R);
    gr.addColorStop(0, '#c8a070'); gr.addColorStop(0.7, '#d4b082'); gr.addColorStop(0.92, '#e0c090'); gr.addColorStop(1, '#a88458');
    ringPath(R); g.fillStyle = gr; g.fill();
    for (let k = 1; k < 16; k++) {
      ringPath(R * k / 16 * range(rnd, 0.97, 1.03), k / 16);
      g.strokeStyle = rgba(k % 3 ? '#9a7448' : '#7a5636', range(rnd, 0.25, 0.45)); g.lineWidth = range(rnd, 1, 2.2); g.stroke();
    }
    for (let i = 0; i < 5; i++) {
      const a = rnd() * TAU, r0 = R * range(rnd, 0.1, 0.4), r1 = R * range(rnd, 0.7, 1.02);
      const pts = []; for (let k = 0; k <= 6; k++) { const r = r0 + (r1 - r0) * k / 6, aa = a + range(rnd, -0.04, 0.04); pts.push([c + Math.cos(aa) * r, c + Math.sin(aa) * r]); }
      stroke(g, pts.map(([x, y]) => [x + 1.2, y + 1.2]), 2.5, 1, '#f0d8a8', 0.4);
      stroke(g, pts, 3, 0.8, '#3e2a22', 0.75);
    }
    blob(g, c, c, 6, 6, 0, '#6a4a30', 0.9, 0.6);
    ringPath(R * 1.07); g.strokeStyle = rgba('#5e4430', 1); g.lineWidth = 11; g.stroke();
    g.save(); ringPath(R * 1.14); g.clip();
    const lg = g.createLinearGradient(c - R, c - R, c + R, c + R);
    lg.addColorStop(0, 'rgba(255,236,190,0.3)'); lg.addColorStop(0.5, 'rgba(255,236,190,0)'); lg.addColorStop(1, 'rgba(40,28,60,0.35)');
    g.fillStyle = lg; g.fillRect(0, 0, s, s); g.restore();
    mottle(g, s, rnd, { colors: ['#8a9a5a', '#6e7e44'], count: 8, rmin: 4, rmax: 10, alpha: 0.3, hard: 0.5 });
    glaze(g, s, s, '#ffe0a8', 0.1, 'soft-light');
    blurTile(cv, 0.5);
  },
});

register('bone', {
  family: F, size: 256, note: 'sun-bleached bone: cream with ochre-stained grooves, suture zig-zags, pits and chips',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#e0d4b4');
    mottle(g, s, rnd, { colors: ['#f2e6c8', '#cbbd98', '#d6c8a4', '#c4b08a', '#f6eedc'], count: 40, rmin: 14, rmax: 60, alpha: 0.45, hard: 0.1 });
    blurTile(cv, 3);
    // ochre stains running along the grooves, soft
    layer(g, s, s, tg => {
      for (let i = 0; i < 8; i++) {
        const x = rnd() * s, y = rnd() * s, L = range(rnd, 60, 180), f = periodic(rnd, 2, 1, 1);
        const pts = []; for (let k = 0; k <= 10; k++) pts.push([x + f(k / 10) * 10, y + L * k / 10]);
        wrapPts(s, pts, 12, Q => line(tg, Q, range(rnd, 6, 14), pick(rnd, ['#b89a68', '#a8885a', '#c4a878'])));
      }
    }, { alpha: 0.35, blur: 4 });
    streaks(g, s, rnd, { colors: ['#c4b494', '#f8f0e0', '#d0c0a0'], count: 100, len: [20, 70], width: [0.8, 1.8], angle: 0, wobble: 0.1, alpha: 0.3 });
    // sutures: zig-zag seams with a lit lip
    layer(g, s, s, tg => {
      for (let i = 0; i < 3; i++) {
        const x = rnd() * s, y = rnd() * s, a = rnd() * TAU, L = range(rnd, 50, 110), pts = [];
        for (let k = 0; k <= 16; k++) { const t = k / 16, z = (k % 2 ? 1 : -1) * range(rnd, 2, 5); pts.push([x + Math.cos(a) * L * t - Math.sin(a) * z, y + Math.sin(a) * L * t + Math.cos(a) * z]); }
        wrapPts(s, pts, 6, Q => { line(tg, Q.map(([u, v]) => [u - 1, v - 1]), 2, '#fff8e8'); line(tg, Q, 1.6, '#6a5a44'); });
      }
    }, { alpha: 0.6, blur: 0.4 });
    for (let i = 0; i < 50; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.2, 3.2);
      wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 0.8, 0, '#8a7a60', 0.6); blob(g, X + r * 0.3, Y + r * 0.6, r, r * 0.4, 0, '#fff8e8', 0.5, 0.5); });
    }
    for (let i = 0; i < 10; i++) {   // chips: a lit facet with a dark lower edge
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 4, 9), a0 = rnd() * TAU;
      const pts = []; for (let k = 0; k < 5; k++) { const a = a0 + k / 5 * TAU + range(rnd, -0.3, 0.3); pts.push([x + Math.cos(a) * r, y + Math.sin(a) * r * 0.7]); }
      wrapPts(s, pts, 2, Q => { poly(g, Q.map(([u, v]) => [u + 1, v + 1.5]), '#8a7a62', 0.4); poly(g, Q, '#f6ecd4', 0.6); });
    }
    cracks(g, s, rnd, { color: '#6a5a48', count: 6, len: [16, 50], width: [0.8, 1.6], alpha: 0.45 });
    glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('scarecrow', {
  family: F, size: 256, note: 'atlas: burlap head (top half; face at u = 0.5) · plaid shirt · felt hat · rope · patched trousers · straw',
  paint(g, s, rnd, h, cv) {
    // burlap head wrap: rows 0..127, the whole circumference; face centered at x = 128
    g.save(); g.beginPath(); g.rect(0, 0, 256, 128); g.clip();
    fill(g, 256, 128, '#9a7c54');
    mottle0(g, 0, 0, 256, 128, rnd, ['#ac8e62', '#866a46', '#94784e', '#7a6040'], 30, 10, 40, 0.4);
    for (let y = 1; y < 128; y += 3.2) { const pts = []; for (let x = -4; x <= 260; x += 8) pts.push([x, y + Math.sin(x * 0.2 + y) * 0.6]); stroke(g, pts, 1.1, 1.1, '#6a5034', 0.3); }
    for (let x = 1; x < 256; x += 3.2) stroke(g, [[x, 0], [x + 0.6, 128]], 1, 1, '#c4aa7c', 0.18);
    // a sewn-on patch at the back, with its seam
    g.fillStyle = '#7a6a4a'; g.fillRect(14, 30, 34, 30);
    for (let k = 0; k < 34; k += 4) { stroke(g, [[14 + k, 28], [16 + k, 32]], 1.2, 1.2, '#3a2a20', 0.8); stroke(g, [[14 + k, 58], [16 + k, 62]], 1.2, 1.2, '#3a2a20', 0.8); }
    // the face, a little lopsided: one sewn-on button eye, one stitched X
    const ex1 = 108, ey1 = 52;
    ellipse(g, ex1 + 1, ey1 + 2, 10, 10, 0, '#2a2024', 0.45);
    ellipse(g, ex1, ey1, 9, 8.4, 0, '#3a3034', 1);
    blob(g, ex1 - 3, ey1 - 3, 3.5, 2.6, 0, '#8a8080', 0.6, 0.5);
    for (const [dx, dy] of [[-2.5, -2], [2.5, -2], [-2.5, 2], [2.5, 2]]) ellipse(g, ex1 + dx, ey1 + dy, 1.1, 1.1, 0, '#1e1618', 0.9);
    stroke(g, [[ex1 - 2.5, ey1 - 2], [ex1 + 2.5, ey1 + 2]], 1, 1, '#c8b890', 0.8);
    const ex2 = 151, ey2 = 50;
    stroke(g, [[ex2 - 8, ey2 - 7], [ex2 + 8, ey2 + 8]], 3.4, 3.4, '#2a1e1c', 0.95);
    stroke(g, [[ex2 + 8, ey2 - 8], [ex2 - 7, ey2 + 7]], 3.4, 3.4, '#2a1e1c', 0.95);
    // a darker stitched nose patch, off-center grin with cross-stitches
    g.fillStyle = '#6a4a30'; g.beginPath(); g.moveTo(130, 62); g.lineTo(124, 73); g.lineTo(136, 72); g.closePath(); g.fill();
    const grin = []; for (let k = 0; k <= 12; k++) { const t = k / 12; grin.push([106 + t * 44, 86 + Math.sin(t * Math.PI) * 7 + t * 5]); }
    stroke(g, grin, 2.6, 2.6, '#2e2226', 0.95);
    for (let k = 1; k < 12; k += 1.5) { const i = Math.floor(k), [x, y] = grin[i]; stroke(g, [[x - 1.5, y - 5], [x + 1.5, y + 5]], 1.5, 1.5, '#2e2226', 0.85); }
    stroke(g, [[0, 120], [256, 122]], 8, 8, '#7a5e38', 0.9);    // rope at the neck
    for (let x = 0; x < 256; x += 7) stroke(g, [[x, 116], [x + 5, 126]], 2, 2, '#4e3a22', 0.6);
    g.restore();
    // plaid shirt: x 0..128, y 128..192 (u 0..0.5, v 0.25..0.5)
    g.save(); g.beginPath(); g.rect(0, 128, 128, 64); g.clip();
    fill(g, 256, 256, '#9a4636');
    for (let x = 4; x < 128; x += 22) { g.fillStyle = rgba('#542824', 0.45); g.fillRect(x, 128, 8, 64); g.fillStyle = rgba('#e0b080', 0.25); g.fillRect(x + 12, 128, 2, 64); }
    for (let y = 132; y < 192; y += 22) { g.fillStyle = rgba('#542824', 0.4); g.fillRect(0, y, 128, 8); g.fillStyle = rgba('#e0b080', 0.25); g.fillRect(0, y + 12, 128, 2); }
    g.fillStyle = '#5a7088'; g.fillRect(70, 146, 26, 24);
    for (let k = 0; k < 26; k += 5) { stroke(g, [[70 + k, 144], [72 + k, 148]], 1.4, 1.4, '#e8d8b0', 0.8); stroke(g, [[70 + k, 168], [72 + k, 172]], 1.4, 1.4, '#e8d8b0', 0.8); }
    mottle0(g, 0, 128, 128, 64, rnd, ['#6a3a2a', '#c87a5a', '#8a5a3a'], 20, 6, 20, 0.25);
    g.restore();
    // felt hat: x 128..256, y 128..192
    g.save(); g.beginPath(); g.rect(128, 128, 128, 64); g.clip();
    fill(g, 256, 256, '#5a4636');
    mottle0(g, 128, 128, 128, 64, rnd, ['#6e5a48', '#4a3a2e', '#7a6450', '#3e3028'], 30, 6, 22, 0.4);
    g.fillStyle = rgba('#2e2420', 0.85); g.fillRect(128, 174, 128, 10);
    g.restore();
    // rope: x 0..64, y 192..256
    g.save(); g.beginPath(); g.rect(0, 192, 64, 64); g.clip();
    fill(g, 256, 256, '#a88a58');
    for (let x = -64; x < 64; x += 7) { stroke(g, [[x, 256], [x + 64, 192]], 4, 4, '#7a6038', 0.7); stroke(g, [[x + 2, 256], [x + 66, 192]], 1.5, 1.5, '#d8bc88', 0.6); }
    g.restore();
    // patched trousers: x 64..128, y 192..256
    g.save(); g.beginPath(); g.rect(64, 192, 64, 64); g.clip();
    fill(g, 256, 256, '#4e5a6a');
    for (let x = 64; x < 128; x += 2.5) stroke(g, [[x, 192], [x + 3, 256]], 1, 1, '#3a4452', 0.35);
    mottle0(g, 64, 192, 64, 64, rnd, ['#5e6a7a', '#3e4856', '#6a6a5a'], 14, 5, 14, 0.35);
    g.fillStyle = '#8a6a44'; g.fillRect(78, 214, 18, 16);
    for (let k = 0; k < 18; k += 4) { stroke(g, [[78 + k, 212], [80 + k, 216]], 1.2, 1.2, '#e8d8b0', 0.8); stroke(g, [[78 + k, 228], [80 + k, 232]], 1.2, 1.2, '#e8d8b0', 0.8); }
    g.restore();
    // straw: x 128..256, y 192..256
    g.save(); g.beginPath(); g.rect(128, 192, 128, 64); g.clip();
    fill(g, 256, 256, '#b89040');
    for (let i = 0; i < 200; i++) { const x = 128 + rnd() * 128, y = 188 + rnd() * 64; stroke(g, [[x, y], [x + range(rnd, -3, 3), y + range(rnd, 10, 24)]], range(rnd, 1.2, 2.4), 0.6, pick(rnd, ['#e8c878', '#f4dc98', '#a88038', '#7a5a28']), 0.8); }
    g.restore();
    glaze(g, s, s, '#ffe0a8', 0.1, 'soft-light');
  },
});

register('iron', {
  family: F, size: 128, note: 'dark wrought iron, rust blooms, lit scratches',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#4a4850');
    mottle(g, s, rnd, { colors: ['#5a5860', '#3a3a42', '#62606a'], count: 20, rmin: 8, rmax: 30, alpha: 0.5, hard: 0.15 });
    mottle(g, s, rnd, { colors: ['#7a4630', '#9a5a34', '#6a3a28'], count: 14, rmin: 4, rmax: 16, alpha: 0.55, hard: 0.3 });
    streaks(g, s, rnd, { colors: ['#9a98a4', '#b0aeb8'], count: 16, len: [6, 20], width: [0.6, 1.2], angle: 1.2, wobble: 0.3, alpha: 0.5 });
    blurTile(cv, 0.5);
  },
});

register('coals', {
  family: F, size: 256, note: 'fire bed: an orange glow pool under chunky charcoal, thin glowing seams in the middle, pale ash at the rim',
  paint(g, s, rnd, h, cv) {
    const c = s / 2;
    fill(g, s, s, '#8a8480');
    // the glow pool
    const gp = g.createRadialGradient(c, c, 0, c, c, s * 0.42);
    gp.addColorStop(0, '#ffb050'); gp.addColorStop(0.35, '#ff8a30'); gp.addColorStop(0.7, '#b84010'); gp.addColorStop(1, 'rgba(80,40,30,0)');
    g.fillStyle = gp; g.fillRect(0, 0, s, s);
    // charcoal lumps, darker and denser toward the middle, each lit on its upper left
    for (let i = 0; i < 90; i++) {
      const a = rnd() * TAU, d = Math.sqrt(rnd()) * s * 0.4, x = c + Math.cos(a) * d, y = c + Math.sin(a) * d, r = range(rnd, 7, 17) * (1 - d / s * 0.6);
      const n = 5 + Math.floor(rnd() * 3), a0 = rnd() * TAU, pts = [];
      for (let k = 0; k < n; k++) { const aa = a0 + k / n * TAU, rr = r * range(rnd, 0.7, 1.1); pts.push([x + Math.cos(aa) * rr, y + Math.sin(aa) * rr * 0.8]); }
      const col = pick(rnd, ['#2a2220', '#3a2e28', '#322824', '#46382e']);
      poly(g, pts, col, 0.95);
      blob(g, x - r * 0.3, y - r * 0.35, r * 0.6, r * 0.4, 0, '#6a5a50', 0.5, 0.3);
      if (d < s * 0.22) blob(g, x + r * 0.2, y + r * 0.3, r * 0.5, r * 0.35, 0, '#c85a1c', 0.35, 0.4);
    }
    // thin soft glowing seams, only near the centre
    g.save(); g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 16; i++) {
      let x = c + range(rnd, -40, 40), y = c + range(rnd, -34, 34), a = rnd() * TAU; const pts = [[x, y]];
      for (let k = 0; k < 4; k++) { a += range(rnd, -0.8, 0.8); x += Math.cos(a) * range(rnd, 6, 14); y += Math.sin(a) * range(rnd, 6, 14); pts.push([x, y]); }
      line(g, pts, 2, '#ff7a24', 0.45); line(g, pts, 0.9, '#ffd080', 0.5);
    }
    for (let i = 0; i < 14; i++) blob(g, c + range(rnd, -36, 36), c + range(rnd, -30, 30), range(rnd, 6, 12), range(rnd, 4, 9), 0, pick(rnd, ['#ff9a30', '#ffc860']), 0.25, 0.3);
    g.restore();
    // pale ash toward the rim
    const ash = g.createRadialGradient(c, c, s * 0.24, c, c, s * 0.5);
    ash.addColorStop(0, 'rgba(138,132,128,0)'); ash.addColorStop(0.55, 'rgba(138,132,128,0.7)'); ash.addColorStop(1, 'rgba(110,104,100,1)');
    g.fillStyle = ash; g.fillRect(0, 0, s, s);
    mottle(g, s, rnd, { colors: ['#9a948e', '#6a6462', '#b0aaa4', '#4a4442'], count: 70, rmin: 2, rmax: 7, alpha: 0.4, hard: 0.5 });
  },
});

register('flame', {
  family: F, size: 256, alpha: true, note: 'campfire flame: 4 frames (2×2), tongues bottom-center, white-yellow core → orange → deep red tips, additive',
  paint(g, s, rnd) {
    for (let fi = 0; fi < 4; fi++) {
      const ox = (fi % 2) * 128, oy = Math.floor(fi / 2) * 128, cx = ox + 64, by = oy + 126;
      g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, 124, 124); g.clip();
      blob(g, cx, by - 26, 50, 40, 0, '#a83010', 0.4, 0.05);
      const tongues = 6 + fi % 2;
      for (const [cols, wK, hK, a] of [[['#a82a10', '#b83414'], 1.1, 1.05, 0.7], [['#e0601e', '#ec7024'], 0.85, 0.85, 0.8], [['#f8a038', '#ffb048'], 0.6, 0.62, 0.9], [['#ffe080', '#fff0a8'], 0.4, 0.42, 0.95], [['#fffaf0'], 0.22, 0.26, 1]]) {
        for (let k = 0; k < tongues; k++) {
          const x = cx + range(rnd, -24, 24) * wK, H = range(rnd, 70, 118) * hK, W = range(rnd, 18, 30) * wK, lean = range(rnd, -0.3, 0.3);
          const pts = []; for (let j = 0; j <= 6; j++) { const t = j / 6; pts.push([x + Math.sin(t * 3 + fi + k) * 6 * t + lean * H * t * t, by - 4 - H * t]); }
          stroke(g, pts, W, 1, pick(rnd, cols), a * 0.55);
          stroke(g, pts.slice(0, 5), W * 0.7, W * 0.3, pick(rnd, cols), a * 0.5);
        }
      }
      g.restore();
    }
  },
});

register('smoke', {
  family: F, size: 128, alpha: true, note: 'a faint smoke wisp rising from the fire (normal blend)',
  paint(g, s, rnd) {
    for (let i = 0; i < 26; i++) {
      const t = i / 26, x = s / 2 + Math.sin(t * 5) * 14 * t + range(rnd, -6, 6), y = s - 10 - t * (s - 24), r = 8 + t * 22;
      blob(g, x, y, r, r * 0.8, 0, pick(rnd, ['#5a5452', '#6a6462', '#4a4644']), 0.12 * (1 - t * 0.6), 0.1);
    }
  },
});

register('spark', {
  family: F, size: 32, alpha: true, note: 'a soft glowing dot (embers)',
  paint(g, s) {
    blob(g, s / 2, s / 2, s * 0.48, s * 0.48, 0, '#ffb050', 0.6, 0.1);
    blob(g, s / 2, s / 2, s * 0.22, s * 0.22, 0, '#fff0c0', 1, 0.4);
  },
});
