// The crash buttes' shape: angular prisms that lean in a little (a 'radial batter'), not cylinders. Upright
// cylinders read as drums or tanks from the road (an elliptical rim, strata bands curving round, parallel
// sides); jointed rock is flat faces meeting at corners, and a butte's walls lean in as they rise.
//
// Each butte is a few convex masses: the body, two lobes (one in profile from the road, one round the
// back; each holds the centre, so the outline stays one radius per bearing) and the lower bench. Each
// mass is the convex hull of a ring of 6-9 corners at jittered bearings and radii, its faces turned toward
// two joint directions when they lie close to one (some near-parallel faces, as jointed rock has, never a
// box), cleaned up (no face under 1.5 m, no turn under 14 degrees, none over 75: a chamfer cuts it). Its
// cross-section at height y is its top polygon scaled about its tier's centre by s(y) = 1 + K (yTop - y):
// every corner keeps its bearing at every height, so the renderer's outline is s(y) Rb(th), and the
// collider is the convex hull of the top ring and the scaled bottom ring. Everything comes from hashes of
// the stop's z (no rng: nothing else on the leg moves).
//
// A mass: { part: 'butte' | 'butte_lobe' | 'butte_bench', cx, cz (its tier's centre), planes: [[nx, nz, d]]
// (unit outward normals about (cx, cz), at the top), y0, y1, K, sAt(y), polyAt(y), top, bot }.

export const TAU = Math.PI * 2;
const hash = (z, k) => Math.abs(Math.sin(z * k) * 43758.5453) % 1;

// ---- 2D convex polygons in the x-z plane (counter-clockwise in (x, z) = positive area) ------------------
// a plane at bearing a (its outward normal) at distance d from the centre
const pl = (a, d) => [Math.cos(a), Math.sin(a), d];
// Clip a big square by every plane (each n.(q - c) <= d + off): the polygon, and for each edge (pts[i] ->
// pts[i+1]) the index of the plane it lies on.
export function polyFromPlanes(cx, cz, planes, off = 0) {
  const B = 200;
  let P = [[cx - B, cz - B], [cx + B, cz - B], [cx + B, cz + B], [cx - B, cz + B]], E = [-1, -2, -3, -4];
  planes.forEach(([nx, nz, d], j) => {
    const lim = d + off + nx * cx + nz * cz, out = [], oe = [], n = P.length;
    for (let i = 0; i < n; i++) {
      const a = P[i], b = P[(i + 1) % n], ea = E[i];
      const fa = nx * a[0] + nz * a[1] - lim, fb = nx * b[0] + nz * b[1] - lim;
      if (fa <= 0) {
        out.push(a); oe.push(ea);
        if (fb > 0) { const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); oe.push(j); }
      } else if (fb <= 0) {
        const t = fa / (fa - fb); out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]); oe.push(ea);
      }
    }
    // (the edge along the clip line: both its ends lie on it)
    for (let i = 0; i < out.length; i++) {
      const a = out[i], b = out[(i + 1) % out.length];
      if (Math.abs(nx * a[0] + nz * a[1] - lim) < 1e-7 && Math.abs(nx * b[0] + nz * b[1] - lim) < 1e-7) oe[i] = j;
    }
    P = out; E = oe;
  });
  const pts = [], ids = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) continue;   // (near-duplicate corners)
    pts.push(a); ids.push(E[i]);
  }
  return { pts, ids };
}
// signed distance to a convex polygon (negative inside)
export function sdPoly(P, x, z) {
  let maxPl = -1e9, best = 1e9;
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez, L = Math.sqrt(L2);
    const pq = (x - a[0]) * ez / L - (z - a[1]) * ex / L;
    if (pq > maxPl) maxPl = pq;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * ex + (z - a[1]) * ez) / L2));
    best = Math.min(best, Math.hypot(x - a[0] - ex * t, z - a[1] - ez * t));
  }
  return maxPl <= 0 ? maxPl : best;
}
// how far from (cx, cz) along bearing a the polygon's boundary lies ((cx, cz) inside it). Each polygon's
// edge normals are worked out once (the renderer asks this a great many times)
const EDGES = new WeakMap();
function edgesOf(P) {
  let E = EDGES.get(P);
  if (!E) {
    E = new Float64Array(P.length * 4);
    for (let i = 0; i < P.length; i++) {
      const p0 = P[i], p1 = P[(i + 1) % P.length], ex = p1[0] - p0[0], ez = p1[1] - p0[1], L = Math.hypot(ex, ez);
      E[i * 4] = ez / L; E[i * 4 + 1] = -ex / L; E[i * 4 + 2] = p0[0]; E[i * 4 + 3] = p0[1];
    }
    EDGES.set(P, E);
  }
  return E;
}
export function polyExit(P, cx, cz, a) {
  const ux = Math.cos(a), uz = Math.sin(a), E = edgesOf(P);
  let t = 1e9;
  for (let i = 0; i < E.length; i += 4) {
    const nx = E[i], nz = E[i + 1], dn = ux * nx + uz * nz;
    if (dn > 1e-12) { const v = ((E[i + 2] - cx) * nx + (E[i + 3] - cz) * nz) / dn; if (v < t) t = v; }
  }
  return t;
}
export const polyArea = P => { let s = 0; for (let i = 0; i < P.length; i++) { const a = P[i], b = P[(i + 1) % P.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
// 2D convex hull (monotone chain), counter-clockwise in (x, z)
function hull2(pts) {
  const P = pts.map(p => [p[0], p[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-9) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 1e-9) up.pop(); up.push(p); }
  up.pop(); lo.pop();
  return lo.concat(up);
}

// ---- one mass: a ring of corners, its faces turned toward the joints -----------------------------------
function ringPlanes(H, k0, cx, cz, R, n, jitR, jitA, phi, { pin = null, minIn = 0 } = {}) {
  const a0 = H(k0) * TAU, pts = [];
  for (let k = 0; k < n; k++) {
    const a = a0 + (k + (H(k0 + 1.1 * k + 0.3) - 0.5) * jitA) * TAU / n, r = R * (1 + (H(k0 + 1.7 * k + 0.9) - 0.5) * 2 * jitR);
    pts.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  if (pin) pts.push(...pin);
  const P = hull2(pts), planes = [];
  for (let i = 0; i < P.length; i++) {
    const a = P[i], b = P[(i + 1) % P.length], ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    let na = Math.atan2(-ex / L, ez / L);
    for (const j of [phi, phi + Math.PI / 2, phi + Math.PI, phi - Math.PI / 2]) {
      const d = Math.atan2(Math.sin(j - na), Math.cos(j - na));
      if (Math.abs(d) < 0.44) { na += 0.4 * d; break; }
    }
    // (the face keeps passing through its own middle)
    const mx = (a[0] + b[0]) / 2 - cx, mz = (a[1] + b[1]) / 2 - cz;
    planes.push([Math.cos(na), Math.sin(na), Math.max(mx * Math.cos(na) + mz * Math.sin(na), minIn)]);
  }
  return planes;
}
// no face shorter than minEdge (its plane dropped: the neighbours meet), no corner turning more than
// maxTurn (a chamfer face across it, 0.9 m in), no turn under minTurn (the shorter face merged away)
function cleanPlanes(cx, cz, planes, { minEdge = 1.5, minTurn = 14 * Math.PI / 180, maxTurn = 75 * Math.PI / 180 } = {}) {
  let P = planes.slice();
  for (let it = 0; it < 24; it++) {
    const { pts, ids } = polyFromPlanes(cx, cz, P), n = pts.length;
    let worst = -1, wl = minEdge;
    for (let i = 0; i < n; i++) { const a = pts[i], b = pts[(i + 1) % n], L = Math.hypot(b[0] - a[0], b[1] - a[1]); if (L < wl) { wl = L; worst = i; } }
    if (worst >= 0 && n > 5) { P = P.filter((_, j) => j !== ids[worst]); continue; }
    let fixed = false;
    for (let i = 0; i < n; i++) {
      const pa = P[ids[(i - 1 + n) % n]], pb = P[ids[i]];
      if (!pa || !pb) continue;
      if (Math.acos(Math.max(-1, Math.min(1, pa[0] * pb[0] + pa[1] * pb[1]))) > maxTurn) {
        const v = pts[i], mx = pa[0] + pb[0], mz = pa[1] + pb[1], l = Math.hypot(mx, mz), nx = mx / l, nz = mz / l;
        P.push([nx, nz, (v[0] - cx) * nx + (v[1] - cz) * nz - 0.9]); fixed = true; break;
      }
    }
    if (fixed) continue;
    let merged = false;
    for (let i = 0; i < n && !merged; i++) {
      const pa = P[ids[(i - 1 + n) % n]], pb = P[ids[i]];
      if (!pa || !pb) continue;
      if (Math.acos(Math.max(-1, Math.min(1, pa[0] * pb[0] + pa[1] * pb[1]))) < minTurn && n > 5) {
        const la = Math.hypot(pts[i][0] - pts[(i - 1 + n) % n][0], pts[i][1] - pts[(i - 1 + n) % n][1]);
        const lb = Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]);
        const drop = la < lb ? ids[(i - 1 + n) % n] : ids[i];
        P = P.filter((_, j) => j !== drop); merged = true;
      }
    }
    if (!merged) break;
  }
  return P;
}

// ---- the butte ----------------------------------------------------------------------------------------
// p: the crash stop (x, z, side), M: p.mesa as world gen laid it out (R, h, base, talus, bench, lobes);
// sets M.parts, M.K, M.footDist(x, z) (from the foot at the talus line, < 0 inside), M.topAt(x, z) (the
// walkable top over (x, z), or null) and M.bound (no part reaches farther from the centre at any height).
export function butteParts(p, M, roadX, K = 0.02) {
  const H = k => hash(p.z, k), R = M.R, y1 = M.base + M.h, y0 = M.base - 0.6, yC = M.base + M.talus;
  const away = p.side > 0 ? 0 : Math.PI, toRoad = away + Math.PI;
  // the lobe in profile from the road stands a little farther out: the plan runs longer along the road
  const L1 = M.lobes[0], a1 = Math.atan2(L1.z - p.z, L1.x - p.x), push = R * (0.12 + 0.1 * H(77.7));
  M.lobes = [{ x: L1.x + Math.cos(a1) * push, z: L1.z + Math.sin(a1) * push, r: L1.r }, ...M.lobes.slice(1)];
  const phi = H(13.1) * Math.PI;
  // the body: 7-9 corners 0.86-1.14 R out, no face nearer the centre than 5.6 m (the wreck and its loot)
  const parts = [{ part: 'butte', cx: p.x, cz: p.z, planes: ringPlanes(H, 2.3, p.x, p.z, R, 7 + Math.floor(H(2.9) * 3), 0.14, 0.7, phi, { minIn: 5.6 }), y0, y1 }];
  parts[0].planes.push(pl(toRoad, Math.min(R * 1.12, Math.abs(p.x - roadX(p.z)) - 7.6)));
  // the lobes: masses round world gen's lobe circles, each pinned to the centre; then about the centre
  M.lobes.forEach((c, i) => {
    const pin = [[p.x + 0.6, p.z], [p.x - 0.6, p.z + 0.6], [p.x - 0.6, p.z - 0.6]];
    const planes = ringPlanes(H, 30 + 7 * i, c.x, c.z, c.r * 0.98, 6 + Math.floor(H(31 + i) * 2), 0.16, 0.6, phi, { pin });
    parts.push({ part: 'butte_lobe', cx: p.x, cz: p.z, planes: planes.map(([nx, nz, d]) => [nx, nz, d + nx * (c.x - p.x) + nz * (c.z - p.z)]), y0, y1 });
  });
  // the bench: its own mass, lower, about its own centre
  const b = M.bench;
  parts.push({ part: 'butte_bench', cx: b.x, cz: b.z, planes: ringPlanes(H, 50, b.x, b.z, b.r, 6 + Math.floor(H(51) * 2), 0.14, 0.6, phi), y0, y1: b.top });
  // (the road side keeps its 7.6 m at the talus line: the main tier's faces pulled in if the leaning foot
  // would cross it)
  const sC = 1 + K * (y1 - yC), dRoad = Math.abs(p.x - roadX(p.z)) - 7.6;
  for (const q of parts) if (q.part !== 'butte_bench') q.planes.push(pl(toRoad, dRoad / sC));
  for (const q of parts) q.planes = cleanPlanes(q.cx, q.cz, q.planes);
  // each lobe stands at least 0.9 m proud of the body (or it only grazes it): pushed out along its axis
  const bodyTop = polyFromPlanes(p.x, p.z, parts[0].planes).pts;
  for (const q of parts.filter(q => q.part === 'butte_lobe')) {
    const top = polyFromPlanes(q.cx, q.cz, q.planes).pts;
    let best = 0, ba = 0;
    for (let k = 0; k < 180; k++) { const a = k / 180 * TAU, d = polyExit(top, p.x, p.z, a) - polyExit(bodyTop, p.x, p.z, a); if (d > best) { best = d; ba = a; } }
    if (best < 0.9) { const grow = 0.9 - best; q.planes = q.planes.map(([nx, nz, d]) => [nx, nz, d + grow * Math.max(0, nx * Math.cos(ba) + nz * Math.sin(ba))]); }
  }
  for (const q of parts) {
    q.K = K;
    q.sAt = y => 1 + K * (q.y1 - y);
    const memo = new Map();
    q.polyAt = y => { const k = Math.round(y * 100); let v = memo.get(k); if (!v) { const s = q.sAt(y); v = polyFromPlanes(q.cx, q.cz, q.planes.map(([a, c, d]) => [a, c, d * s])).pts; memo.set(k, v); } return v; };
    q.top = q.polyAt(q.y1); q.bot = q.polyAt(q.y0);
  }
  M.K = K;
  M.parts = parts;
  M.footDist = (x, z) => { let e = 1e9; for (const q of parts) e = Math.min(e, sdPoly(q.polyAt(yC), x, z)); return e; };
  M.topAt = (x, z) => { let y = null; for (const q of parts) if (sdPoly(q.top, x, z) < 0) y = Math.max(y ?? -1e9, q.y1); return y; };
  M.bound = R * 2.6;
}

// the main tier's masses (the body and its lobes): the outline butteRadius() follows
export const butteMains = p => (p.mesa.parts || []).filter(q => q.part === 'butte' || q.part === 'butte_lobe');

// a mass as a collider: its top ring and its leaning bottom ring, as points about (x, y, z) (W.hulls)
export function partHull(q, poi) {
  const pts = [];
  let r = 0;
  for (const [ring, y] of [[q.top, q.y1], [q.bot, q.y0]]) for (const v of ring) {
    pts.push(v[0] - q.cx, y - q.y0, v[1] - q.cz);
    r = Math.max(r, Math.hypot(v[0] - q.cx, v[1] - q.cz));
  }
  return { x: q.cx, y: q.y0, z: q.cz, r, pts: new Float32Array(pts), mat: 'mesa', poi, part: q.part };
}
