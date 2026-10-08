// The hand-painted texture toolkit. Every texture in the game is painted here,
// procedurally, on a <canvas>, in the style of 2004 WoW Classic: soft painted
// shapes with the lighting baked in (light from the upper left), never
// per-pixel noise. See docs/ART.md.
//
// Every mark that could cross an edge goes through wrap(), so textures tile.
// Paint functions are deterministic: use the rnd you're handed.

// ---- randomness --------------------------------------------------------------------

export function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function rngFrom(seed) {
  let a = (typeof seed === 'string' ? hashStr(seed) : seed) >>> 0;
  return function rnd() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const range = (rnd, a, b) => a + (b - a) * rnd();
export const pick = (rnd, arr) => arr[Math.floor(rnd() * arr.length)];

// ---- canvas & color ----------------------------------------------------------------

export function makeCanvas(w, h = w) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  // Paint canvases live on the CPU: textures are read back (blurTile, pixel passes) and composited
  // with each other, and mixing GPU- and CPU-backed canvases forces slow readbacks. Later
  // getContext('2d') calls return this same context.
  cv.getContext('2d', { willReadFrequently: true });
  return cv;
}

export function hex(c) {
  if (typeof c !== 'string') return c;
  let s = c.replace('#', '');
  if (s.length === 3) s = s.split('').map(ch => ch + ch).join('');
  const n = parseInt(s, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const clamp255 = v => Math.max(0, Math.min(255, Math.round(v)));
export function toHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => clamp255(v).toString(16).padStart(2, '0')).join('');
}
export function rgba(c, a = 1) { const { r, g, b } = hex(c); return `rgba(${clamp255(r)},${clamp255(g)},${clamp255(b)},${a})`; }
export function mix(a, b, t) {
  const A = hex(a), B = hex(b);
  return toHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}
// k < 1 darkens, k > 1 lightens (toward white, not blown out)
export function shade(c, k) {
  const C = hex(c);
  if (k <= 1) return toHex({ r: C.r * k, g: C.g * k, b: C.b * k });
  const t = Math.min(1, k - 1);
  return toHex({ r: C.r + (255 - C.r) * t, g: C.g + (255 - C.g) * t, b: C.b + (255 - C.b) * t });
}
// painterly shadow: darker AND cooler (toward blue-purple)
export function shadowOf(c, amt = 0.35) { return mix(shade(c, 1 - amt), '#2c2340', amt * 0.35); }
// painterly highlight: lighter AND warmer (toward cream)
export function lightOf(c, amt = 0.3) { return mix(shade(c, 1 + amt * 0.6), '#fff1c4', amt * 0.4); }
export function jitter(c, rnd, amt = 0.08) {
  const C = hex(c);
  const k = 1 + (rnd() - 0.5) * 2 * amt;
  const hueish = (rnd() - 0.5) * amt * 40;
  return toHex({ r: C.r * k + hueish, g: C.g * k, b: C.b * k - hueish });
}

// ---- tileable drawing ------------------------------------------------------------------

// Call fn(x, y) for (x, y) and every wrapped copy whose radius r crosses an edge.
export function wrap(size, x, y, r, fn) {
  const xs = [x], ys = [y];
  if (x - r < 0) xs.push(x + size); if (x + r > size) xs.push(x - size);
  if (y - r < 0) ys.push(y + size); if (y + r > size) ys.push(y - size);
  for (const xx of xs) for (const yy of ys) fn(xx, yy);
}

// Soft blob: an ellipse that fades out. hard=0 → all feather, hard=1 → crisp edge.
export function blob(g, x, y, rx, ry, rot, color, alpha = 1, hard = 0.35) {
  g.save();
  g.translate(x, y);
  g.rotate(rot);
  g.scale(1, ry / rx);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  gr.addColorStop(0, rgba(color, alpha));
  gr.addColorStop(Math.min(0.98, Math.max(0.01, hard)), rgba(color, alpha * 0.9));
  gr.addColorStop(1, rgba(color, 0));
  g.fillStyle = gr;
  g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
  g.restore();
}

export function ellipse(g, x, y, rx, ry, rot, color, alpha = 1) {
  g.save();
  g.globalAlpha *= alpha;
  g.fillStyle = color;
  g.beginPath(); g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2); g.fill();
  g.restore();
}

// Tapered stroke along points [[x,y],...], width w0 → w1.
export function stroke(g, pts, w0, w1, color, alpha = 1) {
  g.save();
  g.globalAlpha *= alpha;
  g.fillStyle = color;
  const n = pts.length;
  for (let i = 0; i < n - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const t0 = i / (n - 1), t1 = (i + 1) / (n - 1);
    const wa = (w0 + (w1 - w0) * t0) / 2, wb = (w0 + (w1 - w0) * t1) / 2;
    const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l;
    g.beginPath();
    g.moveTo(ax + nx * wa, ay + ny * wa); g.lineTo(bx + nx * wb, by + ny * wb);
    g.lineTo(bx - nx * wb, by - ny * wb); g.lineTo(ax - nx * wa, ay - ny * wa);
    g.closePath(); g.fill();
    g.beginPath(); g.arc(bx, by, wb, 0, Math.PI * 2); g.fill();
  }
  g.beginPath(); g.arc(pts[0][0], pts[0][1], w0 / 2, 0, Math.PI * 2); g.fill();
  g.restore();
}

// A curved, tapered blade (grass, straw, fur): from (x,y) at angle (0 = up).
export function blade(g, x, y, len, angle, width, color, alpha = 1, bend = 0.25) {
  const pts = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = angle + bend * t * t;
    pts.push([x + Math.sin(a) * len * t, y - Math.cos(a) * len * t]);
  }
  stroke(g, pts, width, width * 0.15, color, alpha);
}

// Many soft blotches → painterly color variation (tileable).
export function mottle(g, size, rnd, { colors, count = 60, rmin = 20, rmax = 90, alpha = 0.25, hard = 0.2, stretch = 1, rot = null } = {}) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = range(rnd, rmin, rmax);
    const c = pick(rnd, colors);
    const a = rot == null ? rnd() * Math.PI : rot + (rnd() - 0.5) * 0.4;
    const s = stretch * range(rnd, 0.7, 1.3);
    const al = alpha * range(rnd, 0.6, 1);   // drawn once, outside wrap(), so every wrapped copy matches (no seam)
    wrap(size, x, y, r * Math.max(1, s), (xx, yy) => blob(g, xx, yy, r * s, r, a, c, al, hard));
  }
}

// Directional strokes (wood grain, cliff streaks, wind-blown sand).
export function streaks(g, size, rnd, { colors, count = 80, len = [30, 120], width = [1, 4], angle = 0, wobble = 0.15, alpha = 0.35 } = {}) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size;
    const L = range(rnd, len[0], len[1]), W = range(rnd, width[0], width[1]);
    const a = angle + (rnd() - 0.5) * wobble;
    const c = pick(rnd, colors);
    const pts = [];
    let px = x, py = y;
    const segs = 6;
    for (let k = 0; k <= segs; k++) {
      pts.push([px, py]);
      const aa = a + Math.sin(k * 1.3 + i) * wobble;
      px += Math.sin(aa) * L / segs; py -= Math.cos(aa) * L / segs;
    }
    const w1 = W * range(rnd, 0.3, 1), al = alpha * range(rnd, 0.5, 1);   // once, outside wrap(): copies must match
    wrap(size, x, y, L + W, (xx, yy) => stroke(g, pts.map(([u, v]) => [u - x + xx, v - y + yy]), W, w1, c, al));
  }
}

// Lit pebbles: each a little painted stone with highlight (upper-left) and shadow.
export function pebbles(g, size, rnd, { colors, count = 80, rmin = 2, rmax = 7, alpha = 1, shadow = 0.45 } = {}) {
  for (let i = 0; i < count; i++) {
    const x = rnd() * size, y = rnd() * size;
    const r = range(rnd, rmin, rmax), ry = r * range(rnd, 0.6, 0.95), rot = rnd() * Math.PI;
    const c = pick(rnd, colors);
    wrap(size, x, y, r * 2, (xx, yy) => {
      blob(g, xx + r * 0.35, yy + r * 0.45, r * 1.25, ry * 1.25, rot, '#1e1626', shadow * alpha, 0.2);   // contact shadow
      ellipse(g, xx, yy, r, ry, rot, c, alpha);
      blob(g, xx - r * 0.3, yy - r * 0.35, r * 0.6, ry * 0.5, rot, lightOf(c, 0.5), 0.75 * alpha, 0.3);  // lit top-left
      blob(g, xx + r * 0.3, yy + r * 0.3, r * 0.6, ry * 0.5, rot, shadowOf(c, 0.4), 0.5 * alpha, 0.3);   // shade bottom-right
    });
  }
}

// Branching cracks.
export function cracks(g, size, rnd, { color = '#2a2030', count = 8, len = [20, 70], width = [0.8, 2], alpha = 0.55, branch = 0.35 } = {}) {
  const one = (x, y, a, L, W, depth) => {
    const pts = [[x, y]];
    let px = x, py = y;
    const segs = 5 + Math.floor(rnd() * 4);
    for (let k = 0; k < segs; k++) {
      a += (rnd() - 0.5) * 0.9;
      px += Math.cos(a) * L / segs; py += Math.sin(a) * L / segs;
      pts.push([px, py]);
      if (depth < 2 && rnd() < branch) one(px, py, a + (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.5, 1.2), L * 0.45, W * 0.6, depth + 1);
    }
    wrap(size, x, y, L + 4, (xx, yy) => {
      const shifted = pts.map(([u, v]) => [u - x + xx, v - y + yy]);
      stroke(g, shifted.map(([u, v]) => [u + 0.8, v + 0.8]), W + 0.6, W * 0.3, '#fff1c4', alpha * 0.18);  // lit lip
      stroke(g, shifted, W, W * 0.2, color, alpha);
    });
  };
  for (let i = 0; i < count; i++) one(rnd() * size, rnd() * size, rnd() * Math.PI * 2, range(rnd, len[0], len[1]), range(rnd, width[0], width[1]), 0);
}

export function fill(g, w, h, color) { g.fillStyle = color; g.fillRect(0, 0, w, h); }

export function vgrad(g, w, h, stops) {
  const gr = g.createLinearGradient(0, 0, 0, h);
  for (const [t, c] of stops) gr.addColorStop(t, typeof c === 'string' && c.startsWith('rgba') ? c : rgba(c, 1));
  g.fillStyle = gr; g.fillRect(0, 0, w, h);
}

// A soft wash over everything (unifying glaze). mode: 'multiply' | 'overlay' | 'soft-light' | 'screen' | 'source-over'
export function glaze(g, w, h, color, alpha = 0.15, mode = 'soft-light') {
  g.save();
  g.globalCompositeOperation = mode;
  g.globalAlpha = alpha;
  g.fillStyle = color; g.fillRect(0, 0, w, h);
  g.restore();
}

// Tileable blur (blurs a 3×3 tiling, keeps the center).
// Seamless (wrap-around) blur on the CPU: premultiplied alpha, two box passes per axis (close to a
// gaussian), a 3-tap kernel for sub-pixel radii. Canvas 'filter' blurs round-trip through the GPU and
// cost seconds per texture on software GL, so painting uses this instead.
export function blurTile(cv, px) {
  if (!(px > 0)) return cv;
  const w = cv.width, h = cv.height, g = cv.getContext('2d', { willReadFrequently: true });
  const img = g.getImageData(0, 0, w, h), d = img.data, n = w * h;
  let A = new Float32Array(n * 4), B = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const a = d[i * 4 + 3] / 255; A[i * 4] = d[i * 4] * a; A[i * 4 + 1] = d[i * 4 + 1] * a; A[i * 4 + 2] = d[i * 4 + 2] * a; A[i * 4 + 3] = d[i * 4 + 3]; }
  const pass = (src, dst, horiz, r, k) => {
    const L = horiz ? w : h, M = horiz ? h : w;
    for (let m = 0; m < M; m++) {
      const at = q => { q = ((q % L) + L) % L; return (horiz ? m * w + q : q * w + m) * 4; };
      if (k) {   // 3-tap kernel for sub-pixel blurs
        for (let q = 0; q < L; q++) { const i0 = at(q - 1), i1 = at(q), i2 = at(q + 1); for (let c = 0; c < 4; c++) dst[i1 + c] = src[i0 + c] * k + src[i1 + c] * (1 - 2 * k) + src[i2 + c] * k; }
      } else {   // running box sum
        const sm = [0, 0, 0, 0], inv = 1 / (2 * r + 1);
        for (let q = -r; q <= r; q++) { const i = at(q); for (let c = 0; c < 4; c++) sm[c] += src[i + c]; }
        for (let q = 0; q < L; q++) {
          const o = at(q); for (let c = 0; c < 4; c++) dst[o + c] = sm[c] * inv;
          const ia = at(q + r + 1), ib = at(q - r); for (let c = 0; c < 4; c++) sm[c] += src[ia + c] - src[ib + c];
        }
      }
    }
  };
  if (px < 1) { const k = Math.min(0.25, px * px / 2); pass(A, B, true, 0, k); pass(B, A, false, 0, k); }
  else {
    const r = Math.max(1, Math.round(px * 1.2 - 0.4));
    for (let it = 0; it < 2; it++) { pass(A, B, true, r, 0); pass(B, A, false, r, 0); }
  }
  for (let i = 0; i < n; i++) {
    const a = A[i * 4 + 3], k = a > 0.01 ? 255 / a : 0;
    d[i * 4] = A[i * 4] * k; d[i * 4 + 1] = A[i * 4 + 1] * k; d[i * 4 + 2] = A[i * 4 + 2] * k; d[i * 4 + 3] = a;
  }
  g.putImageData(img, 0, 0);
  return cv;
}

// ---- stones & cells -------------------------------------------------------------------------

// Tileable Worley field on a jittered grid. Returns per-pixel nearest-cell id
// and distance-to-border (d2-d1)/2, plus the seeds.
export function worley(size, cells, rnd, jitterAmt = 0.8) {
  const cs = size / cells;
  const seeds = [];
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    seeds.push({ x: (i + 0.5 + (rnd() - 0.5) * jitterAmt) * cs, y: (j + 0.5 + (rnd() - 0.5) * jitterAmt) * cs });
  }
  const id = new Int32Array(size * size), edge = new Float32Array(size * size), d1a = new Float32Array(size * size);
  const dirx = new Float32Array(size * size), diry = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const cj = Math.floor(y / cs);
    for (let x = 0; x < size; x++) {
      const ci = Math.floor(x / cs);
      let b1 = 1e9, b2 = 1e9, bid = 0, bx = 0, by = 0;
      for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
        let ii = ci + di, jj = cj + dj, ox = 0, oy = 0;
        if (ii < 0) { ii += cells; ox = -size; } else if (ii >= cells) { ii -= cells; ox = size; }
        if (jj < 0) { jj += cells; oy = -size; } else if (jj >= cells) { jj -= cells; oy = size; }
        const sd = seeds[jj * cells + ii];
        const dx = x - (sd.x + ox), dy = y - (sd.y + oy);
        const d = dx * dx + dy * dy;
        if (d < b1) { b2 = b1; b1 = d; bid = jj * cells + ii; bx = dx; by = dy; } else if (d < b2) b2 = d;
      }
      const k = y * size + x;
      const d1 = Math.sqrt(b1), d2 = Math.sqrt(b2);
      id[k] = bid; edge[k] = (d2 - d1) / 2; d1a[k] = d1;
      const l = d1 || 1; dirx[k] = bx / l; diry[k] = by / l;
    }
  }
  return { size, cells, seeds, id, edge, d1: d1a, dirx, diry };
}

// Paint a Worley field as stones: per-stone color, domed shading, lit/shadowed
// bevels (upper-left light), soft dark grout.
export function paintCells(g, field, { colors, grout = '#3a3036', groutW = 2.2, bevel = 7, dome = 0.18, light = 0.35, varAmt = 0.12, rnd }) {
  const { size, id, edge, d1, dirx, diry, seeds } = field;
  const img = g.getImageData(0, 0, size, size);
  const D = img.data;
  const cellCol = seeds.map(() => hex(jitter(pick(rnd, colors), rnd, varAmt)));
  const G = hex(grout);
  const maxR = size / field.cells * 0.75;
  for (let k = 0; k < size * size; k++) {
    const c = cellCol[id[k]];
    const e = edge[k];
    let r = c.r, gg = c.g, b = c.b;
    // dome: center a little lighter
    const dm = 1 + dome * (1 - Math.min(1, d1[k] / maxR)) - dome * 0.5;
    // bevel: the rim facing the light is lit, the far rim is in shade
    const bv = Math.max(0, 1 - e / bevel);
    const facing = -(dirx[k] * -0.707 + diry[k] * -0.707);   // light from upper-left
    let m = dm * (1 + light * bv * (-facing));
    r *= m; gg *= m; b *= m;
    if (bv > 0 && facing > 0) { r -= 8 * bv * facing; b += 6 * bv * facing; }   // cool shadow side
    // grout
    const gt = Math.max(0, Math.min(1, (groutW - e) / 1.5 + 0.5));
    r = r * (1 - gt) + G.r * gt; gg = gg * (1 - gt) + G.g * gt; b = b * (1 - gt) + G.b * gt;
    D[k * 4] = clamp255(r); D[k * 4 + 1] = clamp255(gg); D[k * 4 + 2] = clamp255(b); D[k * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
}

// Rows of rectangles (flagstones, bricks, planks, shingles). Tileable.
export function rowLayout(size, rnd, { rows = 8, minW = 40, maxW = 110, rowJitter = 0.25 } = {}) {
  const rects = [];
  const baseH = size / rows;
  let y = 0;
  const heights = [];
  for (let r = 0; r < rows; r++) heights.push(baseH * (1 + (rnd() - 0.5) * rowJitter));
  const sum = heights.reduce((a, b) => a + b, 0);
  for (let r = 0; r < rows; r++) {
    const h = heights[r] * size / sum;
    // widths that sum to exactly `size`, starting at a random offset → seamless wrap, no overlaps
    const ws = [];
    let tot = 0;
    while (tot < size - minW * 0.5) { const w = range(rnd, minW, maxW); ws.push(w); tot += w; }
    const k = size / tot;
    let x = rnd() * size;
    for (const w0 of ws) {
      const w = w0 * k;
      rects.push({ x: x % size, y, w, h, row: r });
      x += w;
    }
    y += h;
  }
  return rects;
}

// Paint rects as stones/planks with baked light: gradient body, lit top/left
// edge, shaded bottom/right edge, soft gap. Tileable via wrap.
export function paintRects(g, size, rects, rnd, { colors, gap = 3, gapColor = '#2e2630', radius = 6, bevel = 4, light = 0.35, varAmt = 0.1, inner = null } = {}) {
  g.save();
  g.fillStyle = gapColor;
  g.fillRect(0, 0, size, size);
  g.restore();
  for (const r of rects) {
    const c = jitter(pick(rnd, colors), rnd, varAmt);
    const x = r.x + gap / 2, y = r.y + gap / 2, w = r.w - gap, h = r.h - gap;
    if (w <= 2 || h <= 2) continue;
    const seed = Math.floor(rnd() * 4294967296);   // inner() replays the same random detail in every wrapped copy
    wrap(size, x + w / 2, y + h / 2, Math.max(w, h) / 2 + 2, (cx, cy) => {
      const X = cx - w / 2, Y = cy - h / 2;
      g.save();
      g.beginPath(); g.roundRect(X, Y, w, h, radius); g.clip();
      const gr = g.createLinearGradient(X, Y, X + w * 0.6, Y + h);
      gr.addColorStop(0, lightOf(c, light * 0.6));
      gr.addColorStop(0.5, c);
      gr.addColorStop(1, shadowOf(c, light * 0.7));
      g.fillStyle = gr; g.fillRect(X, Y, w, h);
      if (inner) inner(g, X, Y, w, h, c, rngFrom(seed));
      // bevels: lit top + left, shaded bottom + right
      g.globalAlpha = 0.55;
      g.fillStyle = lightOf(c, 0.7); g.fillRect(X, Y, w, bevel); g.fillRect(X, Y, bevel * 0.8, h);
      g.globalAlpha = 0.5;
      g.fillStyle = shadowOf(c, 0.5); g.fillRect(X, Y + h - bevel, w, bevel); g.fillRect(X + w - bevel * 0.8, Y, bevel * 0.8, h);
      g.restore();
    });
  }
}

// ---- the registry -------------------------------------------------------------------------

const REG = new Map();
const CACHE = new Map();

// paint(g, size, rnd) draws into a size×size canvas (or w×h via opts.w/opts.h).
export function register(name, { size = 512, w = null, h = null, family = 'misc', alpha = false, paint, note = '' }) {
  // names are global across families: a second family registering the same name silently replaces the first
  const prev = REG.get(name);
  if (prev && prev.family !== family) console.warn(`paint: texture '${name}' from family '${family}' replaces the one from '${prev.family}' (prefix it with the family name)`);
  REG.set(name, { name, size, w: w || size, h: h || size, family, alpha, paint, note });
}
export function list(family = null) { return [...REG.values()].filter(t => !family || t.family === family); }
export function has(name) { return REG.has(name); }
export function canvasFor(name) {
  if (CACHE.has(name)) return CACHE.get(name);
  const t = REG.get(name);
  if (!t) throw new Error(`no texture registered as "${name}"`);
  const cv = makeCanvas(t.w, t.h);
  const g = cv.getContext('2d', { willReadFrequently: true });
  if (!t.alpha) fill(g, t.w, t.h, '#7f7f7f');
  t.paint(g, t.w, rngFrom(name), t.h, cv);
  CACHE.set(name, cv);
  return cv;
}
export function meta(name) { return REG.get(name); }
