// Texture family: nature. See docs/ART.md for the style rules.
//
// Bark & wood (tile; u runs around a trunk, v up it):
//   bark_oak      Elwynn oak: pale gray-brown ridged plates, lit left edges, cool furrows
//   bark_pine     red-brown scaly plates (stretch v ×2 on the mesh)
//   bark_dead     bleached silver deadwood: long grain, splits, knots
//   bark_palm     stacked leaf-scar rings with cross-hatched fibre
//   wood_fence    weathered split-rail wood (grain along v)
// Foliage (alpha atlases; cells are 256 px, canvas top-left = cell 0):
//   leaves_oak    0 oak clump · 1 lobed oak clump · 2 dense leaf mass (opaque) · 3 bush clump
//   leaves_scrub  0 sage brush · 1 dry twig brush · 2 dense sage mass (opaque) · 3 juniper spray
//   needles_pine  0, 1 drooping boughs (base at the bottom, tip at the top) · 2 dense needles · 3 tip spray
//   palm_frond    two 256×512 fronds side by side (green, dry), rachis from the bottom up
// Rock (tile; world-space UVs, v = height so strata stay level):
//   rock_gray (meadow) rock_warm (fields) rock_granite (snow) rock_red (badlands) rock_sand (desert)
// Top cover (tile; alpha = thickness mask, blended on up-facing surfaces by the nature shader):
//   cover_moss cover_lichen cover_snow cover_dust cover_sand
// Props: cactus_skin (tiles, 4 ribs), hay (tiles), hay_end (disc), stump_top (disc), bone (tiles),
//   scarecrow (atlas), iron (tiles), coals (disc), flame (alpha, 2×2 frames), spark (alpha dot)
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

// Draw fn three times, shifted by -s, 0, +s in x (and optionally y), for things that run off an edge.
function tiled(s, fn, both = false) {
  for (const dx of [-s, 0, s]) for (const dy of both ? [-s, 0, s] : [0]) fn(dx, dy);
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
    const o = at + f(((u % s) + s) % s / s) * amp;
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
// shadow on its lower right, a warm sheen on its upper left. That's what makes a card read as a
// ball of leaves rather than a sheet of confetti.
function leafClump(g, cx, cy, R, rnd, P, { n = 220, lobes = 5, L = [20, 32], W = [9, 14], squash = 0.88, core = 0.92, form = 1 } = {}) {
  const lob = [[cx, cy, R * 0.6]];
  for (let i = 1; i < lobes; i++) {
    const a = rnd() * TAU, d = R * range(rnd, 0.22, 0.44);
    lob.push([cx + Math.cos(a) * d, cy + Math.sin(a) * d * squash, R * range(rnd, 0.36, 0.5)]);
  }
  if (core) for (const [lx, ly, lr] of lob) {
    blob(g, lx + lr * 0.06, ly + lr * 0.08, lr * core, lr * core * 0.95, 0, P.core, 1, 0.8);
  }
  const passes = [[P.dark, 1.04, -0.15, 0.4], [P.mid, 0.95, 0.3, 0.32], [P.lit, 0.82, 0.62, 0.21], [P.hi, 0.62, 0.85, 0.07]];
  for (const [cols, rK, bias, share] of passes) {
    const cnt = Math.round(n * share);
    for (let i = 0; i < cnt; i++) {
      const [lx, ly, lr] = pick(rnd, lob);
      const a = rnd() * TAU, t = Math.sqrt(rnd());
      let px = Math.cos(a) * t, py = Math.sin(a) * t;
      if (bias) { px -= bias * 0.45; py -= bias * 0.52; const l = Math.hypot(px, py); if (l > 1) { px /= l; py /= l; } }
      const x = lx + px * lr * rK, y = ly + py * lr * rK;
      const ang = Math.atan2(px, -py) + range(rnd, -0.7, 0.7);
      leaf(g, x, y, range(rnd, L[0], L[1]), range(rnd, W[0], W[1]), ang, jitter(pick(rnd, cols), rnd, 0.05));
    }
  }
  if (form) {
    g.save();
    g.globalCompositeOperation = 'source-atop';
    for (const [lx, ly, lr] of lob) {
      blob(g, lx + lr * 0.45, ly + lr * 0.5, lr * 0.95, lr * 0.8, 0.5, '#14241a', 0.42 * form, 0.25);
      blob(g, lx - lr * 0.4, ly - lr * 0.45, lr * 0.7, lr * 0.55, 0.5, '#fff0b0', 0.14 * form, 0.3);
    }
    // the whole clump: darker underneath
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

// Soft blotches inside a rect (no wrapping).
function mottle0(g, ox, oy, w, h, rnd, colors, count, rmin, rmax, alpha = 0.3, hard = 0.2) {
  for (let i = 0; i < count; i++) {
    const r = range(rnd, rmin, rmax);
    blob(g, ox + rnd() * w, oy + rnd() * h, r * range(rnd, 0.8, 1.4), r, rnd() * Math.PI, pick(rnd, colors), alpha * range(rnd, 0.6, 1), hard);
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
const SAGE = {
  core: '#55604a',
  dark: ['#4c5844', '#48523f', '#55604a'],
  mid: ['#6c7a5e', '#768466', '#687658'],
  lit: ['#94a27c', '#9eac86', '#8c9a76'],
  hi: ['#bcc8a2', '#c6d0ac'],
};

register('leaves_oak', {
  family: F, size: 512, alpha: true, note: 'oak/bush foliage atlas: clump, lobed clump, dense mass, bush clump',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => leafClump(g, ox + w / 2, oy + h / 2 + 6, 120, rnd, OAK, { n: 260, lobes: 6 }),
    (g, ox, oy, w, h, rnd) => {
      leafClump(g, ox + w * 0.38, oy + h * 0.6, 88, rnd, OAK, { n: 150, lobes: 4 });
      leafClump(g, ox + w * 0.62, oy + h * 0.4, 92, rnd, OAK, { n: 160, lobes: 4 });
    },
    (g, ox, oy, w, h, rnd) => leafMass(g, ox, oy, w, h, rnd, OAK, { n: 2400, L: [8, 13], W: [3.5, 5.5] }),
    (g, ox, oy, w, h, rnd) => leafClump(g, ox + w / 2, oy + h / 2 + 6, 112, rnd, BUSH, { n: 380, lobes: 7, L: [13, 20], W: [6, 9] }),
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
    // forks
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

const NEEDLE = {
  core: '#1d3825',
  dark: ['#23442d', '#274a31', '#1f3e29'],
  mid: ['#376842', '#3e7247', '#33623f', '#43784b'],
  lit: ['#5e9454', '#6a9c5a', '#558a50'],
  hi: ['#8cb46a', '#9abc76'],
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
        const upness = -Math.cos(a) - Math.sin(a) * 0.5;        // > 0: pointing up / up-left
        const cols = upness > 0.35 ? (rnd() < 0.3 ? P.hi : P.lit) : upness > -0.2 ? P.mid : P.dark;
        blade(g, x, y, L, a, w, pick(rnd, cols), 1, range(rnd, -0.2, 0.2));
      }
    }
  }
}

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
    sides.push([pts, L]);
  }
  // solid underlayer so the bough reads as a mass of needles, not a fishbone
  for (const [pts, L] of sides) stroke(g, pts, Math.max(10, L * 0.42), 6, P.core, 1);
  stroke(g, main, 30, 12, P.core, 1);
  for (const [pts, L] of sides) stroke(g, pts.map(([x, y]) => [x, y + 3]), Math.max(8, L * 0.3), 4, P.dark[0], 0.8);
  for (const [pts] of sides) stroke(g, pts, 2.6, 1, '#4a3428', 1);
  stroke(g, main, 4.5, 1.5, '#5a3e2c', 1);
  for (const [pts] of sides) needles(g, pts, rnd, { P });
  needles(g, main, rnd, { len: [13, 20], P });
  // fresh growth on the tips
  for (const [pts] of sides) {
    const [x, y] = pts[pts.length - 1];
    for (let k = 0; k < 5; k++) blade(g, x, y, range(rnd, 6, 11), range(rnd, -1.2, 1.2), 2.2, pick(rnd, P.hi), 0.85, 0);
  }
}

register('needles_pine', {
  family: F, size: 512, alpha: true, note: 'pine atlas: two drooping boughs, dense needles, tip spray',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.47, n: 15 }),
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.42, n: 13 }),
    (g, ox, oy, w, h, rnd) => {
      g.fillStyle = NEEDLE.dark[0]; g.fillRect(ox, oy, w, h);
      mottle0(g, ox, oy, w, h, rnd, [NEEDLE.core, NEEDLE.mid[0], NEEDLE.dark[1]], 14, 20, 60, 0.5);
      for (let r = 0; r < 40; r++) {
        const x = ox + rnd() * w, y = oy + rnd() * h, a = range(rnd, -0.5, 0.5), L = range(rnd, 40, 90);
        needles(g, [[x, y + L / 2], [x + Math.sin(a) * L, y - L / 2]], rnd, { len: [10, 16], dens: 3 });
      }
    },
    (g, ox, oy, w, h, rnd) => bough(g, ox, oy, w, h, rnd, { spread: 0.36, n: 14 }),
  ]),
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
        blade(g, x + 1.5, y + 2, L, a, 6.5, P.dark, 0.7, sd * 0.5);
        blade(g, x, y, L, a, 6, c, 1, sd * 0.5);
        blade(g, x - sd * 0.8, y - 0.8, L * 0.8, a, 2, lightOf(c, 0.4), 0.5, sd * 0.5);
        if (rnd() < P.dryTip) blade(g, x + Math.sin(a) * L * 0.75, y - Math.cos(a) * L * 0.75, L * 0.25, a + sd * 0.35, 3, pick(rnd, P.tip), 0.8, sd * 0.3);
      }
    }
  }
  stroke(g, rach.map(([x, y]) => [x + 1.5, y + 1]), 8, 2.5, P.dark, 0.6);
  stroke(g, rach, 6.5, 2, P.rib, 1);
  stroke(g, rach.map(([x, y]) => [x - 1.4, y]), 2, 0.8, lightOf(P.rib, 0.5), 0.7);
}

register('palm_frond', {
  family: F, w: 512, h: 512, size: 512, alpha: true, note: 'two fronds (green, dry), each 256×512, rachis bottom → tip',
  paint: atlas([
    (g, ox, oy, w, h, rnd) => frond(g, ox, oy, w, h, rnd, { lit: ['#9cbc4a', '#a8c456', '#8cb042'], mid: ['#5e9032', '#6a9a36', '#548a30'], dark: '#2e4e20', rib: '#c4b070', tip: ['#c8a850', '#b89448'], dryTip: 0.18 }),
    (g, ox, oy, w, h, rnd) => frond(g, ox, oy, w, h, rnd, { lit: ['#c8aa62', '#d4b670', '#bca058'], mid: ['#9a7e46', '#a8884e', '#8a7040'], dark: '#4e3a26', rib: '#d4be8a', tip: ['#7a5e3a', '#6a5034'], dryTip: 0.5 }),
  ], 256, 512),
});

// ---- bark ------------------------------------------------------------------------------------------

register('bark_oak', {
  family: F, size: 256, note: 'Elwynn oak: pale gray-brown ridged plates, lit left edges, cool furrows (u around, v up)',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8a7862');
    mottle(g, s, rnd, { colors: ['#9c8a72', '#75644f', '#8e8270', '#6d6253', '#a8967c', '#7f7a68'], count: 30, rmin: 24, rmax: 70, alpha: 0.5, hard: 0.08, stretch: 2.6, rot: Math.PI / 2 });
    blurTile(cv, 3);
    // plates between wavy vertical furrows
    const nF = 8;
    const fur = [];
    for (let i = 0; i < nF; i++) fur.push({ x: (i + range(rnd, -0.2, 0.2)) * s / nF, f: periodic(rnd, 3, 1.1, 1), f2: periodic(rnd, 3, 1, 3), fw: periodic(rnd, 3, 1, 2) });
    const X = (fu, y) => fu.x + fu.f(((y % s) + s) % s / s) * 11 + fu.f2(((y % s) + s) % s / s) * 4;
    for (const fu of fur) {
      tiled(s, dx => {
        for (let y = -16; y < s + 16; y += 5) {
          const yy = y + 5, wv = 3 + 2.4 * (0.5 + 0.5 * fu.fw(((y % s) + s) % s / s));
          stroke(g, [[X(fu, y) + dx - 5, y], [X(fu, yy) + dx - 5, yy]], wv * 2.4, wv * 2.4, '#4a3e48', 0.12);   // shade on the plate's right edge
          stroke(g, [[X(fu, y) + dx + 4.5, y], [X(fu, yy) + dx + 4.5, yy]], wv * 1.3, wv * 1.3, '#d8c8a4', 0.16);  // lit left edge of the next plate
          stroke(g, [[X(fu, y) + dx, y], [X(fu, yy) + dx, yy]], wv, wv, '#3a2f36', 0.72);
        }
      });
    }
    // horizontal breaks across plates (bridges between furrows)
    for (let i = 0; i < 26; i++) {
      const k = Math.floor(rnd() * nF), a = fur[k], b = fur[(k + 1) % nF];
      const y = rnd() * s, dy = range(rnd, -8, 8);
      let xa = X(a, y), xb = X(b, y + dy); if (xb < xa) xb += s;
      wrap(s, (xa + xb) / 2, y, (xb - xa) / 2 + 6, (cx, cy) => {
        const off = cx - (xa + xb) / 2, offy = cy - y;
        stroke(g, [[xa + off, y + offy + 2.2], [xb + off, y + dy + offy + 2.2]], 2.4, 2, '#d0c09c', 0.25);
        stroke(g, [[xa + off, y + offy], [xb + off, y + dy + offy]], 2.4, 1.6, '#3e3238', 0.6);
      });
    }
    // grain on the plates, knots, lichen
    streaks(g, s, rnd, { colors: ['#6a5c4c', '#5c5048', '#a8987e', '#b8a688'], count: 120, len: [12, 40], width: [0.8, 1.8], angle: 0, wobble: 0.1, alpha: 0.3 });
    for (let i = 0; i < 3; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 9);
      wrap(s, x, y, r * 2, (X2, Y2) => {
        ellipse(g, X2, Y2, r * 1.6, r, 0, '#5a4a40', 0.85);
        ellipse(g, X2, Y2, r * 0.9, r * 0.55, 0, '#3a2e30', 0.9);
        blob(g, X2 - r * 0.6, Y2 - r * 0.6, r, r * 0.5, 0, '#c8b896', 0.4, 0.4);
      });
    }
    mottle(g, s, rnd, { colors: ['#8e9a6a', '#7a8a58', '#a4a88a'], count: 22, rmin: 3, rmax: 10, alpha: 0.35, hard: 0.5 });
    glaze(g, s, s, '#ffe2b0', 0.12, 'soft-light');
    blurTile(cv, 0.5);
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
  family: F, size: 256, note: 'bleached silver deadwood: long grain, dark splits with lit lips, knots',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8e877c');
    mottle(g, s, rnd, { colors: ['#9e988c', '#7a7268', '#aaa496', '#86796a', '#6e6a68', '#98887a'], count: 30, rmin: 20, rmax: 70, alpha: 0.45, hard: 0.08, stretch: 3, rot: Math.PI / 2 });
    blurTile(cv, 2.5);
    streaks(g, s, rnd, { colors: ['#5e5650', '#6a625a', '#746a60'], count: 120, len: [50, 170], width: [0.8, 2.2], angle: 0, wobble: 0.07, alpha: 0.38 });
    streaks(g, s, rnd, { colors: ['#b8b2a4', '#c8c0b0', '#d4ccbc'], count: 100, len: [40, 150], width: [0.8, 2], angle: 0, wobble: 0.07, alpha: 0.4 });
    // splits
    for (let i = 0; i < 9; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 50, 140), f = periodic(rnd, 2, 1, 1);
      const pts = []; for (let k = 0; k <= 8; k++) pts.push([x + f(k / 8) * 5, y + L * k / 8]);
      tiled(s, (dx, dy) => {
        stroke(g, pts.map(([u, v]) => [u + dx + 2, v + dy]), 2.5, 1, '#e0d8c8', 0.4);
        stroke(g, pts.map(([u, v]) => [u + dx, v + dy]), range(rnd, 2, 3.4), 0.6, '#2e2830', 0.75);
      }, true);
    }
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
  family: F, size: 256, note: 'palm trunk: 8 stacked leaf-scar rings, lit lips, cross-hatched fibre',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#8a7350');
    const n = 8, bh = s / n;
    for (let j = 0; j < n; j++) {
      const y0 = j * bh, c = jitter('#8e7652', rnd, 0.08);
      const gr = g.createLinearGradient(0, y0, 0, y0 + bh);
      gr.addColorStop(0, lightOf(c, 0.45)); gr.addColorStop(0.18, c); gr.addColorStop(0.75, shade(c, 0.85)); gr.addColorStop(1, shadowOf(c, 0.55));
      g.fillStyle = gr; g.fillRect(0, y0, s, bh);
    }
    // fibre crosshatch
    for (let j = 0; j < n; j++) {
      const y0 = j * bh;
      for (let i = 0; i < 46; i++) {
        const x = rnd() * s, y = y0 + range(rnd, 4, bh - 2), a = (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.5, 0.8), L = range(rnd, 8, 16);
        const c = rnd() < 0.5 ? '#5a4632' : '#b89c70';
        wrap(s, x, y, L, (X, Y) => stroke(g, [[X, Y], [X + Math.sin(a) * L, Y - Math.cos(a) * L]], 1.4, 0.8, c, 0.4));
      }
    }
    // the ragged lip of each ring (lit) with the shadow it throws on the ring below
    for (let j = 0; j < n; j++) {
      const y0 = j * bh, f = periodic(rnd, 4, 0.9, 2);
      tiled(s, dx => {
        const lip = wavy(s, f, 3, y0 + 2, false, 12, 4).map(([x, y]) => [x + dx, y]);
        stroke(g, lip.map(([x, y]) => [x, y - 2.5]), 4, 4, '#3a2c28', 0.55);
        stroke(g, lip, 3.2, 3.2, '#d4b886', 0.75);
      });
    }
    streaks(g, s, rnd, { colors: ['#4a3a2e', '#3e3028'], count: 22, len: [14, 30], width: [1, 2], angle: 0, wobble: 0.1, alpha: 0.5 });
    mottle(g, s, rnd, { colors: ['#a08a64', '#6e5a40', '#9a9070'], count: 30, rmin: 10, rmax: 40, alpha: 0.2, hard: 0.2 });
    glaze(g, s, s, '#ffe0a8', 0.12, 'soft-light');
    blurTile(cv, 0.5);
  },
});

register('wood_fence', {
  family: F, size: 256, note: 'weathered split-rail wood: grain along v, gray weathering, splits, knots',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#7c6850');
    mottle(g, s, rnd, { colors: ['#8a7660', '#6a5844', '#968a78', '#7a6a58', '#9a9284'], count: 30, rmin: 16, rmax: 60, alpha: 0.45, hard: 0.1, stretch: 3, rot: Math.PI / 2 });
    blurTile(cv, 2);
    streaks(g, s, rnd, { colors: ['#4e3e30', '#5a4836', '#604c3a'], count: 150, len: [40, 140], width: [0.8, 2.4], angle: 0, wobble: 0.06, alpha: 0.42 });
    streaks(g, s, rnd, { colors: ['#b0a088', '#a49076', '#c0b49c'], count: 110, len: [30, 120], width: [0.8, 1.8], angle: 0, wobble: 0.06, alpha: 0.38 });
    for (let i = 0; i < 6; i++) {
      const x = rnd() * s, y = rnd() * s, L = range(rnd, 40, 110);
      tiled(s, (dx, dy) => {
        stroke(g, [[x + dx + 2, y + dy], [x + dx + 2 + range(rnd, -3, 3), y + dy + L]], 2, 1, '#cbb89a', 0.4);
        stroke(g, [[x + dx, y + dy], [x + dx + range(rnd, -3, 3), y + dy + L]], 2.6, 0.6, '#2e2428', 0.7);
      }, true);
    }
    for (let i = 0; i < 2; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 5, 8);
      wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r * 0.9, r * 1.5, 0, '#4a3a2e', 0.85); ellipse(g, X, Y, r * 0.4, r * 0.8, 0, '#2a2026', 0.9); blob(g, X - r * 0.5, Y - r * 0.7, r * 0.5, r * 0.8, 0, '#d0bc9c', 0.35, 0.4); });
    }
    glaze(g, s, s, '#ffe2b0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

// ---- rock -----------------------------------------------------------------------------------------

// A rock face: big irregular facets (a Worley field), each a flat plane with its own light
// gradient (lighter toward the upper left, warm in the light, cool in the shade), a thin soft
// seam and a lit/shaded rim between them. Then big soft blotches break the cells up, and cracks,
// flecks, lichen and rain stains go on top.
function facets(g, s, rnd, cells, cols, { seam = '#4a4650', str = [0.22, 0.45], rim = 8 } = {}) {
  const f = worley(s, cells, rnd, 1.0);
  const cs = s / cells;
  const per = f.seeds.map(() => {
    const c = hex(jitter(pick(rnd, cols), rnd, 0.07)), a = 3.93 + range(rnd, -1.1, 1.1);
    return { c, gx: Math.cos(a), gy: Math.sin(a), k: range(rnd, str[0], str[1]) };
  });
  const S = hex(seam);
  const img = g.getImageData(0, 0, s, s), D = img.data;
  for (let i = 0; i < s * s; i++) {
    const P = per[f.id[i]], d1 = f.d1[i], rx = f.dirx[i] * d1 / cs, ry = f.diry[i] * d1 / cs, e = f.edge[i];
    let m = 1 + P.k * (rx * P.gx + ry * P.gy) * 1.6;
    const bv = Math.max(0, 1 - e / rim), facing = -(f.dirx[i] * -0.707 + f.diry[i] * -0.707);
    m *= 1 - 0.28 * bv * facing;
    let r = P.c.r * m, gg = P.c.g * m, b = P.c.b * m;
    if (m > 1) { r += (m - 1) * 40; gg += (m - 1) * 26; b -= (m - 1) * 10; } else { r -= (1 - m) * 18; b += (1 - m) * 22; }
    const t = Math.max(0, Math.min(1, (1.4 - e) / 1.2)) * 0.75;
    r = r * (1 - t) + S.r * t; gg = gg * (1 - t) + S.g * t; b = b * (1 - t) + S.b * t;
    D[i * 4] = Math.max(0, Math.min(255, r)); D[i * 4 + 1] = Math.max(0, Math.min(255, gg)); D[i * 4 + 2] = Math.max(0, Math.min(255, b)); D[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}
function rockFaces(g, s, rnd, cv, P) {
  facets(g, s, rnd, P.cells || 4, P.cols, { seam: P.grout });
  blurTile(cv, 1.6);
  mottle(g, s, rnd, { colors: P.blot, count: 36, rmin: 40, rmax: 130, alpha: 0.22, hard: 0.08 });
  // a second, finer layer of chips laid over at low strength
  const tmp = makeCanvas(s), tg = tmp.getContext('2d', { willReadFrequently: true });
  facets(tg, s, rnd, 9, P.cols, { seam: P.grout, str: [0.15, 0.35], rim: 4 });
  blurTile(tmp, 1);
  g.save(); g.globalAlpha = 0.22; g.globalCompositeOperation = 'overlay'; g.drawImage(tmp, 0, 0); g.restore();
  cracks(g, s, rnd, { color: P.crack, count: P.crackN ?? 10, len: [30, 110], width: [1, 2.4], alpha: 0.55 });
  if (P.fleck) mottle(g, s, rnd, { colors: P.fleck, count: P.fleckN ?? 140, rmin: 1.5, rmax: 4, alpha: 0.45, hard: 0.6 });
  if (P.lichen) mottle(g, s, rnd, { colors: P.lichen, count: 50, rmin: 3, rmax: 11, alpha: 0.45, hard: 0.55 });
  streaks(g, s, rnd, { colors: [P.stain], count: 26, len: [40, 120], width: [4, 12], angle: Math.PI, wobble: 0.08, alpha: 0.1 });
  glaze(g, s, s, P.glaze, 0.12, 'soft-light');
  blurTile(cv, 0.6);
}

register('rock_gray', {
  family: F, size: 512, note: 'Elwynn boulder: warm-cool gray planes, cracks, lichen (moss comes from the cover)',
  paint: (g, s, rnd, h, cv) => rockFaces(g, s, rnd, cv, {
    cols: ['#8c877e', '#7c7870', '#968f84', '#847f78', '#7a7c72', '#908a7e'], grout: '#5e5a5e',
    blot: ['#a09a8e', '#6a6764', '#7c866c', '#8c8070', '#a8a294'], crack: '#3a343e', stain: '#4a4650',
    fleck: ['#b4ae9e', '#5e5a58'], lichen: ['#a8ac7a', '#8e9a66', '#b8b08a', '#c2a868'], glaze: '#ffe2b0',
  }),
});
register('rock_warm', {
  family: F, size: 512, note: 'Westfall boulder: sun-warmed tan-gray, yellow and orange lichen',
  paint: (g, s, rnd, h, cv) => rockFaces(g, s, rnd, cv, {
    cols: ['#958a76', '#887e6c', '#a0947e', '#8c826e', '#9a8c74'], grout: '#62564a',
    blot: ['#ab9e84', '#776c5e', '#a08860', '#8a7a62'], crack: '#3e3430', stain: '#5a4a3e',
    fleck: ['#c0b498', '#665a4e'], lichen: ['#c8b45a', '#d09848', '#b8a858', '#a8a860'], glaze: '#ffdca0',
  }),
});
register('rock_granite', {
  family: F, size: 512, note: 'Dun Morogh granite: blue-gray planes, pale feldspar flecks, cold cracks',
  paint: (g, s, rnd, h, cv) => rockFaces(g, s, rnd, cv, {
    cells: 5, cols: ['#717886', '#7d8592', '#8a92a0', '#68707e', '#7a7e8a'], grout: '#3e4050',
    blot: ['#9aa2ae', '#5a6070', '#7c8090', '#8a8c96'], crack: '#2c2c3c', stain: '#3c4050',
    fleck: ['#c8ccd6', '#d8dce2', '#4a4e5c', '#a8acb8'], fleckN: 320, glaze: '#e0ecff', crackN: 12,
  }),
});

// Strata: horizontal bands with a lit ledge on top, a face that darkens downward and a dark crease
// under it; vertical erosion streaks. y is world height on the mesh, so bands stay level.
function strata(g, s, rnd, cv, P) {
  fill(g, s, s, P.cols[0]);
  const bands = [];
  let y = 0;
  while (y < s - 8) { const hh = Math.min(range(rnd, P.band[0], P.band[1]), s - y); bands.push([y, hh, pick(rnd, P.cols)]); y += hh; }
  for (const [y0, hh, c] of bands) {
    const f = periodic(rnd, 4, 1.1, 1), edge = y0 === 0 ? 0 : P.wob;
    const top = x => y0 + f(((x % s) + s) % s / s) * edge;
    g.beginPath(); g.moveTo(0, s + 2);
    for (let x = 0; x <= s; x += 4) g.lineTo(x, top(x));
    g.lineTo(s, s + 2); g.closePath();
    const gr = g.createLinearGradient(0, y0, 0, y0 + hh);
    gr.addColorStop(0, lightOf(c, 0.5)); gr.addColorStop(Math.min(0.3, 6 / hh), lightOf(c, 0.2)); gr.addColorStop(0.45, c);
    gr.addColorStop(0.9, shadowOf(c, 0.25)); gr.addColorStop(1, shadowOf(c, 0.5));
    g.fillStyle = gr; g.fill();
    // ledge line
    tiled(s, dx => {
      const pts = []; for (let x = -8; x <= s + 8; x += 4) pts.push([x + dx, top(x) + 0.5]);
      if (y0 > 0) { stroke(g, pts.map(([u, v]) => [u, v - 1.6]), P.crease, P.crease, shadowOf(c, 0.6), 0.32 * P.lines); stroke(g, pts.map(([u, v]) => [u, v + 1.4]), 3, 3, lightOf(c, 0.4), 0.24 * P.lines); }
    });
  }
  // chiselled planes over the bands, so a boulder reads as broken rock, not sliced bread
  const tmp = makeCanvas(s), tg = tmp.getContext('2d', { willReadFrequently: true });
  facets(tg, s, rnd, 4, ['#8a8a8a', '#808080', '#949494'], { seam: '#505050', str: [0.25, 0.5], rim: 10 });
  blurTile(tmp, 2);
  g.save(); g.globalAlpha = 0.55; g.globalCompositeOperation = 'overlay'; g.drawImage(tmp, 0, 0); g.restore();
  mottle(g, s, rnd, { colors: P.blot, count: 50, rmin: 16, rmax: 70, alpha: 0.22, hard: 0.15, stretch: 1.8, rot: 0 });
  streaks(g, s, rnd, { colors: P.streak, count: P.streakN, len: [30, 140], width: [2, 7], angle: Math.PI, wobble: 0.1, alpha: 0.16 });
  if (P.pock) for (let i = 0; i < P.pock; i++) {
    const x = rnd() * s, y2 = rnd() * s, r = range(rnd, 3, 9), c = pick(rnd, P.cols);
    wrap(s, x, y2, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 0.7, 0, shadowOf(c, 0.6), 0.7); blob(g, X + r * 0.1, Y + r * 0.55, r * 0.9, r * 0.3, 0, lightOf(c, 0.6), 0.6, 0.5); });
  }
  cracks(g, s, rnd, { color: P.crack, count: P.crackN, len: [20, 70], width: [1, 2], alpha: 0.45 });
  glaze(g, s, s, P.glaze, 0.12, 'soft-light');
  blurTile(cv, 0.7);
}
register('rock_red', {
  family: F, size: 512, note: 'Badlands strata: red-orange-ochre bands, lit ledges, erosion streaks',
  paint: (g, s, rnd, h, cv) => strata(g, s, rnd, cv, {
    cols: ['#8e3e22', '#b4552f', '#cf7a45', '#e3a066', '#a8482a', '#c4683a', '#9a4a2c'], band: [18, 72], wob: 5, crease: 3.5, lines: 1,
    blot: ['#d88a56', '#7a3420', '#c06a40', '#e8b07a'], streak: ['#5a2418', '#6a2c1c', '#f0b884'], streakN: 70, pock: 8,
    crack: '#3e1a14', crackN: 10, glaze: '#ffd0a0',
  }),
});
register('rock_sand', {
  family: F, size: 512, note: 'Tanaris sandstone: pale soft layers, wind-scoured, pocked',
  paint: (g, s, rnd, h, cv) => strata(g, s, rnd, cv, {
    cols: ['#c99e6c', '#d8b484', '#e4c89a', '#b88c5e', '#d0a878', '#dcbc8c'], band: [26, 90], wob: 7, crease: 2, lines: 0.45,
    blot: ['#e8d0a4', '#a8804e', '#c4965e', '#f0dcb4'], streak: ['#8e6a44', '#f4e2bc'], streakN: 40, pock: 30,
    crack: '#5e4430', crackN: 5, glaze: '#fff0c8',
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
const lumpyMask = (n, r0, r1, a = 0.6, blur = 3) => (g, s, rnd, cv) => {
  mottle(g, s, rnd, { colors: ['#ffffff'], count: n, rmin: r0, rmax: r1, alpha: a, hard: 0.55 });
  mottle(g, s, rnd, { colors: ['#000000'], count: Math.round(n * 0.35), rmin: r0 * 0.4, rmax: r1 * 0.5, alpha: 0.5, hard: 0.6 });
  blurTile(cv, blur);
};

register('cover_moss', {
  family: F, size: 256, alpha: true, note: 'moss for rock tops (alpha = thickness)',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#557228');
    mottle(g, s, rnd, { colors: ['#3e5a20', '#6a8a30', '#86a03c', '#4a6a24', '#9ab048'], count: 50, rmin: 8, rmax: 36, alpha: 0.5, hard: 0.3 });
    for (let i = 0; i < 260; i++) { const x = rnd() * s, y = rnd() * s, r = range(rnd, 2.5, 6); wrap(s, x, y, r * 2, (X, Y) => lump(g, X, Y, r, pick(rnd, ['#5e7e2c', '#6e8e34', '#4e6e26', '#84a03c']), 0.9)); }
    glaze(g, s, s, '#ffe7a0', 0.1, 'soft-light');
  }, lumpyMask(70, 10, 36)),
});
register('cover_lichen', {
  family: F, size: 256, alpha: true, note: 'Westfall: dry golden lichen and grass on rock tops',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#a89848');
    mottle(g, s, rnd, { colors: ['#c0ae58', '#8a8a40', '#b8a050', '#988a3e'], count: 50, rmin: 8, rmax: 30, alpha: 0.5, hard: 0.3 });
    mottle(g, s, rnd, { colors: ['#d08a40', '#c87a38', '#e0b060'], count: 60, rmin: 3, rmax: 8, alpha: 0.6, hard: 0.6 });
    for (let i = 0; i < 300; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 12, (X, Y) => blade(g, X, Y, range(rnd, 5, 10), range(rnd, -0.6, 0.6), 1.4, pick(rnd, ['#d8c47a', '#b8a050', '#8a7a3a']), 0.8)); }
  }, lumpyMask(80, 6, 24, 0.55, 2)),
});
register('cover_snow', {
  family: F, size: 256, alpha: true, note: 'snow on every ledge: white lumps, blue shadow pockets, sparkle',
  paint: cover((g, s, rnd, cv) => {
    fill(g, s, s, '#e4ebf3');
    mottle(g, s, rnd, { colors: ['#f6f7f4', '#dce5f0', '#cbd8e8', '#fbfaf4'], count: 60, rmin: 14, rmax: 50, alpha: 0.6, hard: 0.25 });
    for (let i = 0; i < 70; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 6, 16);
      wrap(s, x, y, r * 2, (X, Y) => { blob(g, X + r * 0.4, Y + r * 0.5, r * 1.1, r * 0.6, 0, '#a8bcd8', 0.5, 0.35); blob(g, X - r * 0.2, Y - r * 0.25, r * 0.8, r * 0.55, 0, '#ffffff', 0.7, 0.45); });
    }
    for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s; wrap(s, x, y, 3, (X, Y) => blob(g, X, Y, 1.6, 1.6, 0, '#ffffff', 0.9, 0.7)); }
  }, lumpyMask(60, 16, 48, 0.65, 4), 0.25),
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
  family: F, size: 256, note: 'saguaro: 4 ribs per tile (rib crests at x = 0, 64, 128, 192), areoles with pale spines',
  paint(g, s, rnd, h, cv) {
    const rib = s / 4;
    for (let x = 0; x < s; x++) {
      const t = ((x % rib) + rib) % rib / rib;                 // 0 crest, 0.5 groove, 1 crest
      const d = Math.abs(t - 0.5) * 2;                         // 1 at crest, 0 in the groove
      const left = t > 0.5;                                    // left flank of the next crest faces the light
      let c = mix('#2a4c3c', '#5e8e48', Math.pow(d, 0.8));
      if (d > 0.6) c = mix(c, left ? '#a0bc5c' : '#7aa04e', (d - 0.6) / 0.4 * (left ? 0.9 : 0.5));
      g.fillStyle = c; g.fillRect(x, 0, 1, s);
    }
    mottle(g, s, rnd, { colors: ['#4a7a3e', '#6a9448', '#3a6438', '#7a9a50'], count: 40, rmin: 10, rmax: 40, alpha: 0.2, hard: 0.15, stretch: 2.5, rot: Math.PI / 2 });
    // faint growth bands
    for (let i = 0; i < 5; i++) { const y = rnd() * s; wrap(s, s / 2, y, s, (X, Y) => blob(g, X, Y, s * 0.7, 5, 0, '#2a4a34', 0.12, 0.3)); }
    // areoles + spines along each crest
    for (let k = 0; k < 4; k++) {
      const x0 = k * rib;
      for (let y = range(rnd, 0, 10); y < s; y += range(rnd, 18, 24)) {
        wrap(s, x0, y, 12, (X, Y) => {
          for (let j = 0; j < 5; j++) {
            const a = range(rnd, -2.2, 2.2), L = range(rnd, 5, 9);
            stroke(g, [[X, Y], [X + Math.sin(a) * L, Y - Math.cos(a) * L]], 1.3, 0.4, '#efe6c4', 0.85);
          }
          blob(g, X + 0.8, Y + 0.8, 3.4, 2.8, 0, '#2a3a2c', 0.4, 0.4);
          ellipse(g, X, Y, 2.6, 2.2, 0, '#d8ccaa', 1);
          blob(g, X - 0.6, Y - 0.6, 1.4, 1.2, 0, '#fff8e0', 0.8, 0.5);
        });
      }
    }
    glaze(g, s, s, '#fff0b0', 0.1, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('hay', {
  family: F, size: 256, note: 'straw: golden strands running across (u), dark gaps, lit strands',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#c09848');
    mottle(g, s, rnd, { colors: ['#d4ac58', '#a8843a', '#c8a050', '#b08c40'], count: 30, rmin: 16, rmax: 60, alpha: 0.4, hard: 0.1, stretch: 2.5, rot: 0 });
    blurTile(cv, 2);
    const A = Math.PI / 2;
    streaks(g, s, rnd, { colors: ['#6a4c22', '#7a5a28', '#5e4420'], count: 220, len: [24, 80], width: [1.2, 2.8], angle: A, wobble: 0.22, alpha: 0.5 });
    streaks(g, s, rnd, { colors: ['#c8a048', '#d4ae58', '#b8923e', '#ccaa50'], count: 360, len: [24, 80], width: [1.2, 2.4], angle: A, wobble: 0.22, alpha: 0.7 });
    streaks(g, s, rnd, { colors: ['#f0d080', '#f8e0a0', '#ecd090', '#fff0c0'], count: 200, len: [16, 60], width: [0.8, 1.8], angle: A, wobble: 0.22, alpha: 0.6 });
    streaks(g, s, rnd, { colors: ['#e8c878', '#7a5a28'], count: 50, len: [10, 30], width: [0.8, 1.6], angle: 0.4, wobble: 1.2, alpha: 0.45 });
    glaze(g, s, s, '#ffd890', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('hay_end', {
  family: F, size: 256, note: 'round-bale end: a straw spiral, lit upper left',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#b08a40');
    const c = s / 2, R = s * 0.49, turns = 7;
    const gr = g.createRadialGradient(c, c, 0, c, c, R);
    gr.addColorStop(0, '#d0aa58'); gr.addColorStop(0.8, '#c09a48'); gr.addColorStop(1, '#8a6a30');
    g.fillStyle = gr; g.beginPath(); g.arc(c, c, R, 0, TAU); g.fill();
    const sp = [];
    for (let t = 0; t < turns * TAU; t += 0.06) { const r = 6 + t / (turns * TAU) * (R - 8); sp.push([c + Math.cos(t) * r, c + Math.sin(t) * r]); }
    stroke(g, sp, 3.2, 3.2, '#6a4c22', 0.55);
    for (let i = 0; i < 900; i++) {
      const t = rnd() * turns * TAU, r = 6 + t / (turns * TAU) * (R - 8) + range(rnd, 2, 9), a = t + range(rnd, -0.05, 0.05);
      const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r, L = range(rnd, 6, 16);
      const tx = -Math.sin(a), ty = Math.cos(a);
      stroke(g, [[x, y], [x + tx * L, y + ty * L]], range(rnd, 1, 2.2), 0.6, pick(rnd, ['#d8b460', '#e8c878', '#c09848', '#f4dc98', '#a88038']), 0.75);
    }
    const lg = g.createLinearGradient(0, 0, s, s);
    lg.addColorStop(0, 'rgba(255,240,190,0.28)'); lg.addColorStop(0.5, 'rgba(255,240,190,0)'); lg.addColorStop(1, 'rgba(40,30,60,0.3)');
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
    // bark rim: lit on the upper left, shaded lower right
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
  family: F, size: 256, note: 'sun-bleached bone: ivory with yellowed stains, fine grain, pits and cracks',
  paint(g, s, rnd, h, cv) {
    fill(g, s, s, '#ddd0b0');
    mottle(g, s, rnd, { colors: ['#ece2c8', '#cbbd98', '#d6c8a4', '#bfae8c', '#f4ecd8'], count: 40, rmin: 14, rmax: 60, alpha: 0.4, hard: 0.1 });
    blurTile(cv, 2);
    streaks(g, s, rnd, { colors: ['#b8a888', '#f6efe0', '#c8b898'], count: 120, len: [20, 70], width: [0.8, 1.8], angle: 0, wobble: 0.1, alpha: 0.3 });
    for (let i = 0; i < 40; i++) {
      const x = rnd() * s, y = rnd() * s, r = range(rnd, 1.2, 3);
      wrap(s, x, y, r * 2, (X, Y) => { ellipse(g, X, Y, r, r * 0.8, 0, '#8a7a60', 0.6); blob(g, X + r * 0.3, Y + r * 0.6, r, r * 0.4, 0, '#fff8e8', 0.5, 0.5); });
    }
    cracks(g, s, rnd, { color: '#6a5a48', count: 7, len: [16, 50], width: [0.8, 1.6], alpha: 0.5 });
    mottle(g, s, rnd, { colors: ['#a8946a', '#9a8662'], count: 12, rmin: 8, rmax: 24, alpha: 0.18, hard: 0.2 });
    glaze(g, s, s, '#ffe8c0', 0.12, 'soft-light');
    blurTile(cv, 0.4);
  },
});

register('scarecrow', {
  family: F, size: 256, note: 'atlas: burlap head (top half; face at u = 0.5) · plaid shirt · felt hat · rope · straw',
  paint(g, s, rnd, h, cv) {
    // burlap head wrap: rows 0..127, the whole circumference; face centered at x = 128
    g.save(); g.beginPath(); g.rect(0, 0, 256, 128); g.clip();
    fill(g, 256, 128, '#b39568');
    mottle0(g, 0, 0, 256, 128, rnd, ['#c4a676', '#9c805a', '#a88c62', '#8a7050'], 30, 10, 40, 0.35);
    for (let y = 1; y < 128; y += 3.2) { const pts = []; for (let x = -4; x <= 260; x += 8) pts.push([x, y + Math.sin(x * 0.2 + y) * 0.6]); stroke(g, pts, 1.1, 1.1, '#7a6040', 0.28); }
    for (let x = 1; x < 256; x += 3.2) stroke(g, [[x, 0], [x + 0.6, 128]], 1, 1, '#d4bc8c', 0.18);
    // face: stitched X eyes... no, sewn button eyes, a stitched grin, a patch nose
    for (const ex of [108, 148]) {
      ellipse(g, ex + 1, 55, 10, 11, 0, '#2a2024', 0.5);
      ellipse(g, ex, 53, 9, 10, 0, '#2e2428', 1);
      blob(g, ex - 3, 49, 4, 3, 0, '#8a7a7a', 0.6, 0.5);
      for (let k = 0; k < 6; k++) { const a = k / 6 * TAU; stroke(g, [[ex + Math.cos(a) * 9, 53 + Math.sin(a) * 10], [ex + Math.cos(a) * 13, 53 + Math.sin(a) * 14]], 1.6, 1.2, '#3a2a24', 0.8); }
    }
    g.fillStyle = '#8a5a3a'; g.beginPath(); g.moveTo(128, 62); g.lineTo(121, 76); g.lineTo(135, 76); g.closePath(); g.fill();
    const grin = []; for (let k = 0; k <= 12; k++) { const t = k / 12; grin.push([100 + t * 56, 86 + Math.sin(t * Math.PI) * 10]); }
    stroke(g, grin, 3.2, 3.2, '#2e2226', 0.95);
    for (let k = 1; k < 12; k++) { const [x, y] = grin[k]; stroke(g, [[x - 1, y - 6], [x + 1, y + 6]], 1.6, 1.6, '#2e2226', 0.85); }
    stroke(g, [[0, 120], [256, 122]], 8, 8, '#8a6a40', 0.9);    // rope at the neck
    for (let x = 0; x < 256; x += 7) stroke(g, [[x, 116], [x + 5, 126]], 2, 2, '#5e4628', 0.6);
    g.restore();
    // plaid shirt: 128..192, 0..128
    g.save(); g.beginPath(); g.rect(0, 128, 128, 64); g.clip();
    fill(g, 256, 256, '#a04a38');
    for (let x = 4; x < 128; x += 22) { g.fillStyle = rgba('#5a2a26', 0.45); g.fillRect(x, 128, 8, 64); g.fillStyle = rgba('#e0b080', 0.25); g.fillRect(x + 12, 128, 2, 64); }
    for (let y = 132; y < 192; y += 22) { g.fillStyle = rgba('#5a2a26', 0.4); g.fillRect(0, y, 128, 8); g.fillStyle = rgba('#e0b080', 0.25); g.fillRect(0, y + 12, 128, 2); }
    g.fillStyle = '#5a7a96'; g.fillRect(70, 148, 30, 26);
    for (let k = 0; k < 30; k += 5) { stroke(g, [[70 + k, 146], [72 + k, 150]], 1.4, 1.4, '#e8d8b0', 0.8); stroke(g, [[70 + k, 172], [72 + k, 176]], 1.4, 1.4, '#e8d8b0', 0.8); }
    mottle0(g, 0, 128, 128, 64, rnd, ['#6a3a2a', '#c87a5a', '#8a5a3a'], 20, 6, 20, 0.25);
    g.restore();
    // felt hat: 128..192, 128..256
    g.save(); g.beginPath(); g.rect(128, 128, 128, 64); g.clip();
    fill(g, 256, 256, '#5e4a3a');
    mottle0(g, 128, 128, 128, 64, rnd, ['#6e5a48', '#4a3a2e', '#7a6450', '#3e3028'], 30, 6, 22, 0.4);
    g.fillStyle = rgba('#2e2420', 0.85); g.fillRect(128, 176, 128, 10);
    g.restore();
    // rope: 192..256, 0..128
    g.save(); g.beginPath(); g.rect(0, 192, 128, 64); g.clip();
    fill(g, 256, 256, '#a88a58');
    for (let x = -64; x < 128; x += 7) { stroke(g, [[x, 256], [x + 64, 192]], 4, 4, '#7a6038', 0.7); stroke(g, [[x + 2, 256], [x + 66, 192]], 1.5, 1.5, '#d8bc88', 0.6); }
    g.restore();
    // straw: 192..256, 128..256
    g.save(); g.beginPath(); g.rect(128, 192, 128, 64); g.clip();
    fill(g, 256, 256, '#c8a048');
    for (let i = 0; i < 160; i++) { const x = 128 + rnd() * 128, y = 192 + rnd() * 64; stroke(g, [[x, y], [x + range(rnd, -3, 3), y + range(rnd, 10, 24)]], range(rnd, 1.2, 2.4), 0.6, pick(rnd, ['#e8c878', '#f4dc98', '#a88038', '#7a5a28']), 0.8); }
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
  family: F, size: 256, note: 'fire bed: charcoal chunks with glowing cracks, ash toward the rim',
  paint(g, s, rnd, h, cv) {
    const f = worley(s, 9, rnd, 0.9);
    paintCells(g, f, { colors: ['#3a3230', '#2e2826', '#463a36', '#4a3e38', '#2a2422'], grout: '#ff7a24', groutW: 2.6, bevel: 4, dome: 0.3, light: 0.5, varAmt: 0.08, rnd });
    g.save(); g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 40; i++) { const x = rnd() * s, y = rnd() * s; if (Math.hypot(x - s / 2, y - s / 2) > s * 0.36) continue; blob(g, x, y, range(rnd, 6, 16), range(rnd, 5, 12), rnd() * 3, pick(rnd, ['#ff9a30', '#ffc860', '#e85a1c']), 0.45, 0.3); }
    g.restore();
    const gr = g.createRadialGradient(s / 2, s / 2, s * 0.26, s / 2, s / 2, s * 0.5);
    gr.addColorStop(0, 'rgba(120,112,108,0)'); gr.addColorStop(0.6, 'rgba(120,112,108,0.75)'); gr.addColorStop(1, 'rgba(98,92,88,1)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    mottle(g, s, rnd, { colors: ['#8a8480', '#6a6462', '#a8a29c'], count: 50, rmin: 3, rmax: 10, alpha: 0.4, hard: 0.4 });
  },
});

register('flame', {
  family: F, size: 256, alpha: true, note: 'campfire flame: 4 frames (2×2), tongues bottom-center, additive',
  paint(g, s, rnd) {
    for (let fi = 0; fi < 4; fi++) {
      const ox = (fi % 2) * 128, oy = Math.floor(fi / 2) * 128, cx = ox + 64, by = oy + 124;
      g.save(); g.beginPath(); g.rect(ox + 2, oy + 2, 124, 124); g.clip();
      blob(g, cx, by - 30, 44, 40, 0, '#c8401a', 0.35, 0.05);
      const tongues = 5 + fi % 2;
      for (const [cols, wK, hK, a] of [[['#d8501c', '#e0601e'], 1, 1, 0.75], [['#f58a2a', '#f8a038'], 0.72, 0.8, 0.85], [['#ffd060', '#ffe080'], 0.46, 0.58, 0.9], [['#fff6d6'], 0.24, 0.36, 0.95]]) {
        for (let k = 0; k < tongues; k++) {
          const x = cx + range(rnd, -20, 20) * wK, H = range(rnd, 60, 108) * hK, W = range(rnd, 14, 24) * wK, lean = range(rnd, -0.35, 0.35);
          const pts = []; for (let j = 0; j <= 6; j++) { const t = j / 6; pts.push([x + Math.sin(t * 3 + fi + k) * 5 * t + lean * H * t * t, by - 4 - H * t]); }
          stroke(g, pts, W, 1, pick(rnd, cols), a * 0.55);
          stroke(g, pts.slice(0, 5), W * 0.7, W * 0.3, pick(rnd, cols), a * 0.5);
        }
      }
      g.restore();
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
