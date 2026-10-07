// Nature: trees, bushes, rocks, cacti, haybales, fences, bones, campfires: every W.decor entry of a
// natural kind, plus the dead-tree winch anchors.
//
// The look is WoW Classic: chunky low-poly silhouettes (pale twisting oak trunks with flared roots
// forking low into heavy curving limbs under huge drooping canopies, stacked drooping pine tiers,
// planar chiselled rocks), smooth shading, and the detail painted into textures (paint/nature.js).
// Canopies are a small solid leaf mass wrapped in alpha leaf-cluster cards whose normals point out of
// the clump, so a tree lights like a volume: warm on top, cool and dark underneath; the cards turn
// about the vertical to face the camera (in the shadow pass too, so shadows match what you see).
// Vertex colours carry baked AO and per-tree tint. A small shader hook adds wind sway, triplanar
// mapping for rocks, the snowy-top / bare-underside trick for Dun Morogh pine boughs, and a
// world-space "top cover" that lays moss, lichen, snow, dust or sand on up-facing surfaces (or where
// a per-vertex amount says so: the moss band at the foot of an oak).
//
// Performance: everything static is built in world space and merged per (material, 300 m stretch of
// road), so a whole leg of decor costs a few dozen draw calls however many trees there are.
// API: buildNature(W) -> { group, fires, update(dt, t, camPos) }, NATURE_KINDS, PREVIEW.
import { THREE, tex } from './gfx.js';
import { canvasFor } from './paint/index.js';
import { mergeVertices } from '/vendor/BufferGeometryUtils.js';
import { atmo } from './atmosphere.js';
import { BIOME_BY_DAY } from '/shared/world.js';

export const NATURE_KINDS = new Set(['oak', 'pine', 'palm', 'bush', 'flowers', 'stump', 'fence', 'haybale', 'wheat', 'scarecrow', 'cactus', 'deadtree', 'rock', 'bones', 'skull', 'fire']);

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const UP = new V3(0, 1, 0), XAX = new V3(1, 0, 0);
const CHUNK = 300;

// ---- small math -------------------------------------------------------------------------------------

function rngOf(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (x, z, k = 0) => (Math.imul(Math.round(x * 100) | 0, 73856093) ^ Math.imul(Math.round(z * 100) | 0, 19349663) ^ Math.imul(k + 1, 83492791)) >>> 0;
const range = (r, a, b) => a + (b - a) * r();
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const clamp01 = v => Math.max(0, Math.min(1, v));
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const angDiff = (a, b) => Math.abs(((a - b) % TAU + TAU + Math.PI) % TAU - Math.PI);
const lin = hex => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const mulc = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const mul3 = (a, b) => [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
const mixc = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const WHITE = [1, 1, 1];
function noise3(x, y, z, s) {
  return (Math.sin(x * 1.7 + s) * Math.sin(y * 2.3 + s * 1.31) * Math.sin(z * 1.9 + s * 0.73)
    + 0.6 * Math.sin(x * 3.1 - z * 2.3 + s * 2.1) * Math.sin(y * 3.7 + x * 0.9 + s)) / 1.3;
}
function randDir(rnd) {
  const y = range(rnd, -1, 1), a = rnd() * TAU, r = Math.sqrt(1 - y * y);
  return new V3(Math.cos(a) * r, y, Math.sin(a) * r);
}
// Catmull-Rom through control points, n samples per span
function spline(ctrl, n = 4) {
  const out = [];
  for (let i = 0; i < ctrl.length - 1; i++) {
    const p0 = ctrl[Math.max(0, i - 1)], p1 = ctrl[i], p2 = ctrl[i + 1], p3 = ctrl[Math.min(ctrl.length - 1, i + 2)];
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const f = (a, b, c, d) => 0.5 * ((2 * b) + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      out.push(new V3(f(p0.x, p1.x, p2.x, p3.x), f(p0.y, p1.y, p2.y, p3.y), f(p0.z, p1.z, p2.z, p3.z)));
    }
  }
  out.push(ctrl[ctrl.length - 1].clone());
  return out;
}
const lerpArr = (arr, t) => { const f = t * (arr.length - 1), i = Math.min(arr.length - 2, Math.floor(f)); return arr[i] + (arr[i + 1] - arr[i]) * (f - i); };

// unit icospheres, indexed (merged) once
const ICO = {};
function ico(detail) {
  if (!ICO[detail]) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    const m = mergeVertices(g);
    const p = m.attributes.position.array, P = [];
    for (let i = 0; i < p.length; i += 3) P.push(new V3(p[i], p[i + 1], p[i + 2]));
    ICO[detail] = { P, idx: Array.from(m.index.array) };
    g.dispose(); m.dispose();
  }
  return ICO[detail];
}

// atlas cells (canvas top-left = cell 0, row by row; UV v runs up): [u0, v0, u1, v1]
const cellOf = (i, cols = 2, rows = 2) => { const c = i % cols, r = Math.floor(i / cols); return [c / cols, 1 - (r + 1) / rows, (c + 1) / cols, 1 - r / rows]; };
const inset = (c, m = 0.006) => [c[0] + m, c[1] + m, c[2] - m, c[3] - m];

// ---- the batch: merged world-space geometry for one material --------------------------------------

const _p = new V3(), _n = new V3(), _c = new V3(), _o = new V3(), _f = new V3();
class Batch {
  constructor(key) {
    this.key = key; this.P = []; this.N = []; this.UV = []; this.C = []; this.WD = []; this.CV = []; this.BC = []; this.BO = []; this.I = [];
    this.n = 0; this.xf = null; this.nm = null; this.rm = null; this.bill = false; this.cf = null;
  }
  // bb = [center, offset, cardNormal] (local): a card that turns about the vertical to face the
  // camera; position p (= center + offset) is its authored pose
  v(p, n, u, v, c, w = 0, bb = null) {
    if (this.xf) { _p.copy(p).applyMatrix4(this.xf); _n.copy(n).applyMatrix3(this.nm).normalize(); } else { _p.copy(p); _n.copy(n).normalize(); }
    this.P.push(_p.x, _p.y, _p.z); this.N.push(_n.x, _n.y, _n.z); this.UV.push(u, v);
    this.C.push(c[0], c[1], c[2]); this.WD.push(w);
    this.CV.push(this.cf ? this.cf(p, _n) : 0);
    if (bb) {
      this.bill = true;
      _c.copy(bb[0]); _o.copy(bb[1]); _f.copy(bb[2]);
      if (this.xf) { _c.applyMatrix4(this.xf); _o.applyMatrix3(this.rm); _f.applyMatrix3(this.rm); }
      this.BC.push(_c.x, _c.y, _c.z); this.BO.push(_o.x, _o.y, _o.z, Math.atan2(_f.x, _f.z));
    } else { this.BC.push(_p.x, _p.y, _p.z); this.BO.push(0, 0, 0, 0); }
    return this.n++;
  }
  t(a, b, c) { this.I.push(a, b, c); }
  build(material) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.N, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.UV, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.C, 3));
    g.setAttribute('aWind', new THREE.Float32BufferAttribute(this.WD, 1));
    if (this.CV.some(v => v !== 0)) g.setAttribute('aCov', new THREE.Float32BufferAttribute(this.CV, 1));
    if (this.bill) {
      g.setAttribute('aCtr', new THREE.Float32BufferAttribute(this.BC, 3));
      g.setAttribute('aOff', new THREE.Float32BufferAttribute(this.BO, 4));
    }
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    g.boundingSphere.radius += 3;    // cards turn and sway a little past their authored pose
    return new THREE.Mesh(g, material);
  }
}

// A tube along pts (local V3s) with radii. Normals come from the actual surface (finite
// differences), so lobes (root flares, cactus ribs) shade properly. u runs around, v along.
//   lobes(dir, t, i, j) multiplies the radius; color(p, n, t) / wind(p, t) per vertex;
//   uvMap(u, v, t) remaps into an atlas region; twist adds a spiral to u (bark that twists).
function tube(b, pts, radii, o = {}) {
  const { sides = 8, uRep = 1, vLen = 1.5, v0 = 0, color = WHITE, wind = 0, lobes = null, uvMap = null, cap = false, a0 = 0, twist = 0 } = o;
  const n = pts.length, S = sides;
  const T = [];
  for (let i = 0; i < n; i++) T.push(new V3().subVectors(pts[Math.min(n - 1, i + 1)], pts[Math.max(0, i - 1)]).normalize());
  const nrm = new V3().crossVectors(T[0], Math.abs(T[0].y) < 0.95 ? UP : XAX).normalize();
  const q = new THREE.Quaternion(), bin = new V3();
  const R = [], VV = [];
  let acc = v0;
  for (let i = 0; i < n; i++) {
    if (i > 0) { q.setFromUnitVectors(T[i - 1], T[i]); nrm.applyQuaternion(q); acc += pts[i].distanceTo(pts[i - 1]) / vLen; }
    bin.crossVectors(T[i], nrm).normalize();
    nrm.crossVectors(bin, T[i]).normalize();
    const ring = [];
    for (let j = 0; j < S; j++) {
      const a = a0 + j / S * TAU;
      const dir = new V3().copy(nrm).multiplyScalar(Math.cos(a)).addScaledVector(bin, Math.sin(a));
      let r = Math.max(0.004, radii[i]);
      if (lobes) r *= lobes(dir, n > 1 ? i / (n - 1) : 0, i, j);
      ring.push(new V3().copy(pts[i]).addScaledVector(dir, r));
    }
    R.push(ring); VV.push(acc);
  }
  const base = b.n, tr = new V3(), ta = new V3(), nv = new V3();
  for (let i = 0; i < n; i++) {
    const t = n > 1 ? i / (n - 1) : 0;
    for (let j = 0; j <= S; j++) {
      const jj = j % S;
      tr.subVectors(R[i][(jj + 1) % S], R[i][(jj - 1 + S) % S]);
      ta.subVectors(R[Math.min(n - 1, i + 1)][jj], R[Math.max(0, i - 1)][jj]);
      nv.crossVectors(tr, ta);
      if (nv.lengthSq() < 1e-12) nv.copy(T[i]); else nv.normalize();
      const p = R[i][jj];
      let u = j / S * uRep + twist * (VV[i] - v0), v = VV[i];
      if (uvMap) [u, v] = uvMap(u, v, t);
      b.v(p, nv, u, v, typeof color === 'function' ? color(p, nv, t) : color, typeof wind === 'function' ? wind(p, t) : wind);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let j = 0; j < S; j++) {
    const a = base + i * (S + 1) + j, bb = a + 1, c = a + S + 1, d = c + 1;
    b.t(a, bb, c); b.t(bb, d, c);
  }
  if (cap) {
    const last = base + (n - 1) * (S + 1);
    const tip = new V3().copy(pts[n - 1]).addScaledVector(T[n - 1], Math.max(0.004, radii[n - 1]) * (cap === true ? 0.5 : cap));
    let u = 0.5 * uRep, v = VV[n - 1] + 0.02;
    if (uvMap) [u, v] = uvMap(u, v, 1);
    const ap = b.v(tip, T[n - 1], u, v, typeof color === 'function' ? color(tip, T[n - 1], 1) : color, typeof wind === 'function' ? wind(tip, 1) : wind);
    for (let j = 0; j < S; j++) b.t(last + j, last + j + 1, ap);
  }
}

// An indexed mesh with smooth normals from its faces.
function mesh(b, P, idx, { uv = null, color = WHITE, wind = 0 } = {}) {
  const N = P.map(() => new V3());
  const e1 = new V3(), e2 = new V3();
  for (let i = 0; i < idx.length; i += 3) {
    const a = P[idx[i]], c1 = P[idx[i + 1]], c2 = P[idx[i + 2]];
    e1.subVectors(c1, a); e2.subVectors(c2, a); e1.cross(e2);
    N[idx[i]].add(e1); N[idx[i + 1]].add(e1); N[idx[i + 2]].add(e1);
  }
  const base = b.n;
  P.forEach((p, i) => {
    const n = N[i].lengthSq() > 0 ? N[i].normalize() : UP;
    const [u, v] = uv ? uv(p, n, i) : [0, 0];
    b.v(p, n, u, v, typeof color === 'function' ? color(p, n, i) : color, typeof wind === 'function' ? wind(p, i) : wind);
  });
  for (let i = 0; i < idx.length; i += 3) b.t(base + idx[i], base + idx[i + 1], base + idx[i + 2]);
}

// A deformed icosphere (leaf masses, lumps, bones). shape(u: unit V3) -> local V3.
function sphereish(b, detail, shape, o = {}) {
  const I = ico(detail);
  const P = I.P.map(u => shape(u));
  mesh(b, P, I.idx, { ...o, uv: o.uv ? (p, n, i) => o.uv(I.P[i], p, n) : null });
}

// Face normals (area-weighted) and a vertex → faces table for an indexed mesh.
function faceData(P, idx) {
  const nF = idx.length / 3, FN = [], FA = [], VF = P.map(() => []);
  const e1 = new V3(), e2 = new V3();
  for (let f = 0; f < nF; f++) {
    const a = P[idx[f * 3]], b = P[idx[f * 3 + 1]], c = P[idx[f * 3 + 2]];
    e1.subVectors(b, a); e2.subVectors(c, a);
    const n = new V3().crossVectors(e1, e2), l = n.length();
    FN.push(l > 1e-9 ? n.multiplyScalar(1 / l) : new V3(0, 1, 0)); FA.push(l);
    for (let k = 0; k < 3; k++) VF[idx[f * 3 + k]].push(f);
  }
  return { FN, FA, VF };
}
// Creased normals: every face corner averages only the neighbouring faces within the crease angle,
// so a rock's planes read as chiselled faces while each stays smooth-shaded.
const COS_CREASE = Math.cos(36 * Math.PI / 180);
function creased(b, P, idx, color, FD = faceData(P, idx)) {
  const { FN, FA, VF } = FD, n = new V3();
  for (let f = 0; f < FN.length; f++) {
    if (FA[f] < 1e-9) continue;
    const base = b.n;
    for (let k = 0; k < 3; k++) {
      const vi = idx[f * 3 + k];
      n.set(0, 0, 0);
      for (const g of VF[vi]) if (FA[g] > 1e-9 && FN[g].dot(FN[f]) > COS_CREASE) n.addScaledVector(FN[g], FA[g]);
      if (n.lengthSq() < 1e-12) n.copy(FN[f]);
      n.normalize();
      b.v(P[vi], n, 0, 0, color(P[vi], n), 0);
    }
    b.t(base, base + 1, base + 2);
  }
}

// Rows of points → a quad strip. us per column, vs per row. faceN: which side is the front.
const _g1 = new V3(), _g2 = new V3();
function strip(b, rows, us, vs, nfn, cfn, wfn, faceN = null) {
  const base = b.n, nc = rows[0].length;
  rows.forEach((row, ri) => row.forEach((p, ci) => b.v(p, nfn(ri, ci), us[ci], vs[ri], cfn(ri, ci), wfn(ri, ci))));
  _g1.subVectors(rows[0][1], rows[0][0]); _g2.subVectors(rows[1][0], rows[0][0]);
  const flip = faceN && _g1.cross(_g2).dot(faceN) < 0;
  for (let ri = 0; ri < rows.length - 1; ri++) for (let ci = 0; ci < nc - 1; ci++) {
    const a = base + ri * nc + ci, bb = a + 1, c = a + nc, d = c + 1;
    if (!flip) { b.t(a, bb, d); b.t(a, d, c); } else { b.t(a, d, bb); b.t(a, c, d); }
  }
}

// A flat disc (stump tops, bale ends, the fire bed). uv(cos, sin) → [u, v].
function disc(b, C, nrm, R, seg, uv, color = WHITE) {
  const e1 = new V3().crossVectors(nrm, Math.abs(nrm.y) < 0.9 ? UP : XAX).normalize();
  const e2 = new V3().crossVectors(nrm, e1).normalize();
  const base = b.n;
  b.v(C, nrm, ...uv(0, 0), color, 0);
  for (let j = 0; j <= seg; j++) {
    const a = j / seg * TAU, ca = Math.cos(a), sa = Math.sin(a);
    b.v(new V3().copy(C).addScaledVector(e1, ca * R).addScaledVector(e2, sa * R), nrm, ...uv(ca, sa), color, 0);
  }
  for (let j = 0; j < seg; j++) b.t(base, base + 1 + j, base + 2 + j);
}

// A flat card (straw tufts, flame, smoke): bottom-centre at B, width w, height h, facing nrm (horizontal
// part), leaning back by `lean`. bill: it turns about the vertical to face the camera.
function card(b, B, w, h, nrm, cell, color, { lean = 0, wind = 0, bill = false, shade = null } = {}) {
  const f = new V3(nrm.x, 0, nrm.z).normalize();
  const r = new V3(f.z, 0, -f.x);                       // up × f
  const up = new V3(0, Math.cos(lean), 0).addScaledVector(f, -Math.sin(lean));
  const C = new V3().copy(B).addScaledVector(up, h / 2);
  const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  const us = [cell[0], cell[2], cell[2], cell[0]], vs = [cell[1], cell[1], cell[3], cell[3]];
  const base = b.n;
  cs.forEach(([a, c], k) => {
    const off = new V3().addScaledVector(r, a * w / 2).addScaledVector(up, c * h / 2);
    const p = new V3().copy(C).add(off);
    const n = shade ? shade(c) : new V3().copy(f).multiplyScalar(0.4).add(new V3(0, 0.9, 0)).normalize();
    b.v(p, n, us[k], vs[k], typeof color === 'function' ? color(c) : color, wind * (c > 0 ? 1 : 0), bill ? [C, off, f] : null);
  });
  b.t(base, base + 1, base + 2); b.t(base, base + 2, base + 3);
}

// ---- materials ----------------------------------------------------------------------------------------

const U_TIME = { value: 0 };
const U_CAM = { value: new V3(0, 2, 30) };
const camHook = (r, s, cam) => { U_CAM.value.setFromMatrixPosition(cam.matrixWorld); };
const COVER = {
  moss: { tex: 'cover_moss', lo: 0.64, hi: 0.86, noise: 1.2, scale: 0.42 },
  mossBark: { tex: 'cover_moss', lo: 0.66, hi: 0.92, noise: 1.0, scale: 0.7 },
  lichen: { tex: 'cover_lichen', lo: 0.55, hi: 0.8, noise: 1.2, scale: 0.45 },
  snow: { tex: 'cover_snow', lo: 0.5, hi: 0.74, noise: 0.8, scale: 0.35, gate: [0.18, 0.38] },
  snowLimb: { tex: 'cover_snow', lo: 0.45, hi: 0.68, noise: 0.8, scale: 0.5, gate: [0.15, 0.3] },
  dust: { tex: 'cover_dust', lo: 0.72, hi: 0.95, noise: 1.0, scale: 0.35 },
  sand: { tex: 'cover_sand', lo: 0.62, hi: 0.9, noise: 1.0, scale: 0.3 },
};

// Alpha atlases go up as a DataTexture: transparent texels take the colour of the leaves next to
// them (no dark fringes in the mips), and each mip's alpha is rescaled so the alpha-tested coverage
// of every region stays the same at a distance (canopies don't go thin and see-through far away).
const ATEX = new Map();
function alphaTex(name, cols = 2, rows = 2) {
  if (ATEX.has(name)) return ATEX.get(name);
  const cv = canvasFor(name), w = cv.width, h = cv.height;
  const src = cv.getContext('2d').getImageData(0, 0, w, h).data;
  // a premultiplied colour pyramid (plain JS, no canvas filters): a transparent texel takes the
  // colour of the nearest coarser level that has leaves in it
  const pyr = [];
  {
    let cw = w, ch = h, cur = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { const a = src[i * 4 + 3] / 255; cur[i * 4] = src[i * 4] * a; cur[i * 4 + 1] = src[i * 4 + 1] * a; cur[i * 4 + 2] = src[i * 4 + 2] * a; cur[i * 4 + 3] = a; }
    pyr.push({ d: cur, w: cw, h: ch });
    while (cw > 1 || ch > 1) {
      const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1), nd = new Float32Array(nw * nh * 4);
      for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
        const o = (y * nw + x) * 4;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const k = (Math.min(ch - 1, y * 2 + dy) * cw + Math.min(cw - 1, x * 2 + dx)) * 4;
          nd[o] += cur[k]; nd[o + 1] += cur[k + 1]; nd[o + 2] += cur[k + 2]; nd[o + 3] += cur[k + 3];
        }
      }
      pyr.push({ d: nd, w: nw, h: nh }); cur = nd; cw = nw; ch = nh;
    }
  }
  const L0 = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4, o = ((h - 1 - y) * w + x) * 4, a = src[k + 3];
    if (a >= 24) { L0[o] = src[k]; L0[o + 1] = src[k + 1]; L0[o + 2] = src[k + 2]; }
    else {
      let c = null;
      for (let l = 1; l < pyr.length && !c; l++) {
        const P = pyr[l], q = (Math.min(P.h - 1, y >> l) * P.w + Math.min(P.w - 1, x >> l)) * 4;
        if (P.d[q + 3] > 0.05) c = [P.d[q] / P.d[q + 3], P.d[q + 1] / P.d[q + 3], P.d[q + 2] / P.d[q + 3]];
      }
      if (!c) c = [44, 62, 34];
      L0[o] = c[0]; L0[o + 1] = c[1]; L0[o + 2] = c[2];
    }
    L0[o + 3] = a;
  }
  const RC = cols * 2, RR = rows * 2;      // coverage is matched per quarter-cell
  const regions = (lw, lh) => { const out = []; for (let j = 0; j < RR; j++) for (let i = 0; i < RC; i++) out.push([Math.floor(i * lw / RC), Math.floor(j * lh / RR), Math.floor((i + 1) * lw / RC), Math.floor((j + 1) * lh / RR)]); return out; };
  const cover = (d, lw, [x0, y0, x1, y1], k) => {
    let c = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (d[(y * lw + x) * 4 + 3] * k > 127.5) c++; n++; }
    return n ? c / n : 0;
  };
  const cov0 = regions(w, h).map(q => cover(L0, w, q, 1));
  const levels = [{ data: L0, width: w, height: h }];
  let cur = L0, cw = w, ch = h;
  while (cw > 1 || ch > 1) {
    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);
    const nd = new Uint8Array(nw * nh * 4);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) {
      let r = 0, g = 0, bl = 0, a = 0, ws = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const k = (Math.min(ch - 1, y * 2 + dy) * cw + Math.min(cw - 1, x * 2 + dx)) * 4, wt = cur[k + 3] + 6;
        r += cur[k] * wt; g += cur[k + 1] * wt; bl += cur[k + 2] * wt; a += cur[k + 3]; ws += wt;
      }
      const o = (y * nw + x) * 4;
      nd[o] = r / ws; nd[o + 1] = g / ws; nd[o + 2] = bl / ws; nd[o + 3] = a / 4;
    }
    const out = new Uint8Array(nd);
    if (nw >= RC * 4 && nh >= RR * 4) {
      regions(nw, nh).forEach((qd, qi) => {
        let lo = 1, hi = 4;
        if (cover(nd, nw, qd, hi) <= cov0[qi]) lo = hi;
        else for (let it = 0; it < 12; it++) { const mid = (lo + hi) / 2; if (cover(nd, nw, qd, mid) < cov0[qi]) lo = mid; else hi = mid; }
        const [x0, y0, x1, y1] = qd;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const o = (y * nw + x) * 4 + 3; out[o] = Math.min(255, nd[o] * lo); }
      });
    }
    levels.push({ data: out, width: nw, height: nh });
    cur = nd; cw = nw; ch = nh;
  }
  const t = new THREE.DataTexture(L0, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.mipmaps = levels;
  t.generateMipmaps = false;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.needsUpdate = true;
  ATEX.set(name, t);
  return t;
}
const GRID = { needles_snow: [4, 2], palm_frond: [2, 1] };

// The vertex hook shared by the colour pass and the shadow (depth) pass: camera-facing cards (turned
// about the vertical toward the camera, keeping their authored tilt) and wind sway.
const vertDecl = o => `attribute float aWind; attribute float aCov; ${o.bill ? 'attribute vec3 aCtr; attribute vec4 aOff;' : ''} uniform float uTime; uniform vec3 uCam;`;
const vertBody = o => `
  ${o.bill ? `{
    vec3 toC = uCam - aCtr; float dYaw = atan(toC.x, toC.z) - aOff.w; float cy = cos(dYaw), sy = sin(dYaw);
    transformed = aCtr + vec3(cy * aOff.x + sy * aOff.z, aOff.y, -sy * aOff.x + cy * aOff.z);
  }` : ''}
  ${o.wind ? `{
    float ph = uTime * 1.6 + ${o.bill ? 'aCtr.x * 0.31 + aCtr.z * 0.27' : 'position.x * 0.31 + position.z * 0.27'};
    vec3 sw = vec3(sin(ph) + 0.45 * sin(ph * 2.3 + 1.3), 0.35 * sin(ph * 1.9 + 0.7), 0.7 * cos(ph * 0.83));
    transformed += sw * aWind * 0.055;
  }` : ''}`;

// The nature material: smooth Lambert + painted map + vertex colours (AO, tint), with optional
//   alpha (cutout cards, alpha-to-coverage), wind (sway by aWind), bill (camera-facing cards), noFlip
//   (both faces keep the card's own normal: volumetric canopies), backShift (a card's underside shows
//   the atlas cell `backShift` to the right: bare boughs under snowy ones), cover (world-space
//   moss/snow/... on up-facing surfaces, plus where aCov says so), tri (triplanar world mapping).
const MAT = new Map();
function natMat(texName, o = {}) {
  const key = texName + '|' + JSON.stringify(o);
  if (MAT.has(key)) return MAT.get(key);
  const grid = GRID[texName] || [2, 2];
  const m = new THREE.MeshLambertMaterial({
    map: o.alpha ? alphaTex(texName, ...grid) : tex(texName),
    vertexColors: true,
    side: o.alpha || o.double ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: o.alpha ? 0.5 : 0,
  });
  if (o.alpha) m.alphaToCoverage = true;
  const C = o.cover ? COVER[o.cover] : null;
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = U_TIME; sh.uniforms.uCam = U_CAM;
    if (C) {
      sh.uniforms.uCoverMap = { value: tex(C.tex) };
      sh.uniforms.uCover = { value: new THREE.Vector4(C.lo, C.hi, C.noise, C.scale) };
      sh.uniforms.uCoverG = { value: new THREE.Vector2(...(C.gate || [0, 0])) };
    }
    sh.uniforms.uTri = { value: 1 / (o.triScale || 2.6) };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        ${vertDecl(o)} varying vec3 vNatW; varying vec3 vNatN; varying float vNatCov;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${vertBody(o)}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vNatW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vNatN = normalize(mat3(modelMatrix) * objectNormal);
        vNatCov = aCov;`);
    let fs = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vNatW; varying vec3 vNatN; varying float vNatCov; uniform float uTri;
      ${C ? 'uniform sampler2D uCoverMap; uniform vec4 uCover; uniform vec2 uCoverG;' : ''}`);
    if (o.tri) fs = fs.replace('#include <map_fragment>', `
      {
        vec3 tw = pow(abs(normalize(vNatN)), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
        vec4 tx = texture2D(map, vNatW.zy * uTri), ty = texture2D(map, vNatW.xz * uTri + 0.37), tz = texture2D(map, vNatW.xy * uTri);
        diffuseColor *= tx * tw.x + ty * tw.y + tz * tw.z;
      }`);
    else if (o.backShift) fs = fs.replace('#include <map_fragment>', `
      {
        vec2 nUv = vMapUv; if (!gl_FrontFacing) nUv.x += ${o.backShift.toFixed(4)};
        diffuseColor *= texture2D(map, nUv);
      }`);
    if (o.noFlip) fs = fs.replace('#include <normal_fragment_begin>', `
      float faceDirection = gl_FrontFacing ? 1.0 : -1.0;
      vec3 normal = normalize(vNormal);
      vec3 nonPerturbedNormal = normal;`);
    if (C) fs = fs.replace('#include <lights_lambert_fragment>', `{
        vec4 cv = texture2D(uCoverMap, vNatW.xz * uCover.w);
        float up = normalize(vNatN).y${o.frontOnly ? ' * faceDirection' : ''};
        float k = smoothstep(uCover.x, uCover.y, up + (cv.a - 0.55) * uCover.z);
        float ao = clamp(dot(vColor.rgb, vec3(0.3333)) * 1.3, 0.0, 1.0);
        if (uCoverG.y > 0.0) k *= smoothstep(uCoverG.x, uCoverG.y, ao);   // sheltered (dark AO) parts stay bare
        ${o.covAttr ? 'k = max(k, smoothstep(0.3, 0.7, vNatCov * (0.5 + cv.a)));' : ''}
        diffuseColor.rgb = mix(diffuseColor.rgb, cv.rgb * mix(0.62, 1.0, ao), k);
      }
      #include <lights_lambert_fragment>`);
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => 'nature|' + key;
  // the shadow pass sees the same turned, swaying cards
  if (o.bill || o.wind) {
    const dm = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    dm.onBeforeCompile = sh => {
      sh.uniforms.uTime = U_TIME; sh.uniforms.uCam = U_CAM;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          ${vertDecl(o)}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          ${vertBody(o)}`);
    };
    dm.customProgramCacheKey = () => 'natdepth|' + (o.bill ? 'b' : '') + (o.wind ? 'w' : '');
    m.userData.depth = dm;
  }
  MAT.set(key, m);
  return m;
}

// ---- biomes -----------------------------------------------------------------------------------------

const BIO = {
  meadow: {
    rock: 'rock_gray', rockCover: 'moss', rockTints: ['#ffffff', '#f0eee6', '#e6e8de', '#f4efe4'],
    leaves: 'leaves_oak', oakTints: ['#ffffff', '#eef6dc', '#e2ecc8', '#fff4dc', '#f2f6e0', '#dfe9c8'], leafDensity: 1,
    pineTints: ['#ffffff', '#f2f8ea', '#e8f0de', '#f8f4e4'],
    bush: 'leaves', bushCells: [3], bushFill: 2, bushTints: ['#ffffff', '#f4f8e4', '#fffbe8'],
    deadTint: '#c4bcb4', barkCover: 'mossBark', oakTrunk: '#f4f6ec',
  },
  fields: {
    rock: 'rock_warm', rockCover: 'lichen', rockTints: ['#ffffff', '#f6eee0', '#ece4d4'],
    leaves: 'leaves_autumn', oakTints: ['#ffffff', '#fff6e0', '#f6efd8', '#fffae8'], leafDensity: 0.62, west: true,
    pineTints: ['#f4f0d0', '#ece8c8'],
    bush: 'leaves', bushCells: [3], bushFill: 2, bushTints: ['#ffffff', '#fff6e0', '#f4f0d8'],
    deadTint: '#d0c4b0', oakTrunk: '#fff6e4',
  },
  snow: {
    rock: 'rock_granite', rockCover: null, rockTints: ['#ffffff', '#eef0f6', '#e4e8f0'], snowCaps: true,
    leaves: 'leaves_oak', oakTints: ['#d8e4d8'], leafDensity: 0.7,
    pineTints: ['#ffffff', '#f2f6f4', '#e8f0ee', '#f6f8f2'],
    bush: 'shrub', bushTints: ['#ffffff', '#f0f4f4', '#e8eeee'],
    deadTint: '#9a9088', snow: true,
  },
  badlands: {
    rock: 'rock_red', rockCover: 'dust', rockTints: ['#ffffff', '#f6ece4', '#ecdcd0'], strata: true,
    leaves: 'leaves_oak', oakTints: ['#e8d8a8'], leafDensity: 0.6,
    pineTints: ['#d8d4bc'],
    bush: 'scrub', bushCells: [0, 0, 1], bushFill: 2, bushTints: ['#fff6e0', '#fff0d4', '#ffffff'],
    deadTint: '#bca896', cactusTints: ['#ffffff', '#f4f0f0', '#fff6ee'], deadCover: 'dust', cactusCover: 'dust',
  },
  desert: {
    rock: 'rock_sand', rockCover: 'sand', rockTints: ['#ffffff', '#fbf4e8', '#f4ecdc'], strata: true,
    leaves: 'leaves_oak', oakTints: ['#e8e0a8'], leafDensity: 0.6,
    pineTints: ['#d8d8c0'],
    bush: 'scrub', bushCells: [0, 1, 1], bushFill: 2, bushTints: ['#fff8e4', '#fff4dc', '#ffffff'],
    deadTint: '#e8dccc', cactusTints: ['#f4f8e4', '#eef6dc', '#fafce8'], palmTints: ['#ffffff', '#f4f0d0', '#eaf0c8'],
  },
};

function matFor(key, biome) {
  const B = BIO[biome] || BIO.meadow, snow = !!B.snow;
  const sc = c => (snow ? 'snow' : c);
  switch (key) {
    case 'bark_oak': return natMat('bark_oak', { cover: sc(B.barkCover || null), covAttr: !!B.barkCover && !snow });
    case 'bark_pine': return natMat('bark_pine', { cover: sc(null) });
    case 'bark_dead': return natMat('bark_dead', { cover: snow ? 'snowLimb' : (B.deadCover || null) });
    case 'bark_palm': return natMat('bark_palm', {});
    case 'wood': return natMat('wood_fence', { cover: sc(null) });
    case 'stump_top': return natMat('stump_top', { cover: sc(null) });
    case 'leaves': return natMat(B.leaves || 'leaves_oak', { alpha: true, noFlip: true, wind: true, bill: true });
    case 'scrub': return natMat('leaves_scrub', { alpha: true, noFlip: true, wind: true, bill: true });
    case 'shrub': return natMat('needles_snow', { alpha: true, noFlip: true, wind: true, bill: true });
    case 'needles': return snow ? natMat('needles_snow', { alpha: true, wind: true, backShift: 0.5 }) : natMat('needles_pine', { alpha: true, wind: true });
    case 'frond': return natMat('palm_frond', { alpha: true, wind: true });
    case 'straw': return natMat('straw_tuft', { alpha: true, wind: true });
    case 'rock': return natMat(B.rock, { tri: true, cover: B.rockCover || null });
    case 'firestone': return natMat('rock_gray', { tri: true });
    case 'snowcap': return natMat('snow_pack', { tri: true, triScale: 3.2 });
    case 'cactus': return natMat(biome === 'badlands' ? 'cactus_dusty' : 'cactus_skin', {});
    case 'hay': return natMat('hay', {});
    case 'hay_end': return natMat('hay_end', {});
    case 'bone': return natMat('bone', { cover: snow ? 'snow' : null });
    case 'scarecrow': return natMat('scarecrow', {});
    case 'iron': return natMat('iron', {});
    default: return natMat('bark_dead', {});
  }
}
// the textures a biome's nature uses (painted ahead of time, at night, for tomorrow's biome)
function texturesFor(biome) {
  const B = BIO[biome] || BIO.meadow;
  const out = [['bark_dead'], ['wood_fence'], ['stump_top'], ['rock_gray'], ['iron'], ['coals'], ['flame'], ['smoke'], ['spark'], [B.rock]];
  if (B.rockCover) out.push([COVER[B.rockCover].tex]);
  if (biome === 'meadow' || biome === 'fields') out.push(['bark_oak'], [B.leaves, true], ['bark_pine'], ['needles_pine', true], ['cover_moss']);
  if (biome === 'fields') out.push(['hay'], ['hay_end'], ['straw_tuft', true], ['scarecrow'], ['cover_lichen']);
  if (biome === 'snow') out.push(['bark_pine'], ['needles_snow', true], ['snow_pack'], ['cover_snow']);
  if (biome === 'badlands' || biome === 'desert') out.push(['leaves_scrub', true], [biome === 'badlands' ? 'cactus_dusty' : 'cactus_skin'], ['bone'], ['cover_dust']);
  if (biome === 'desert') out.push(['bark_palm'], ['palm_frond', true], ['cover_sand']);
  return out;
}

// ---- build context --------------------------------------------------------------------------------

class Ctx {
  constructor(W) {
    this.W = W; this.biome = BIO[W.biome] ? W.biome : 'meadow'; this.bio = BIO[this.biome];
    this.batches = new Map(); this.xf = null; this.nm = null; this.rm = null; this.chunk = 0; this.base = new V3(); this.ry = 0;
  }
  // build in local space: origin at (x, y, z), turned by ry (and an optional extra local rotation)
  at(d, ry = 0, extra = null) {
    this.base.set(d.x, d.y, d.z); this.ry = ry;
    const m = new THREE.Matrix4().makeRotationY(ry);
    if (extra) m.multiply(extra);
    m.setPosition(d.x, d.y, d.z);
    this.xf = m; this.nm = new THREE.Matrix3().getNormalMatrix(m); this.rm = new THREE.Matrix3().setFromMatrix4(m);
    this.chunk = Math.floor((d.z + 3000) / CHUNK);
  }
  b(key) {
    const k = key + '#' + this.chunk;
    let b = this.batches.get(k);
    if (!b) { b = new Batch(key); this.batches.set(k, b); }
    b.xf = this.xf; b.nm = this.nm; b.rm = this.rm; b.cf = null;
    return b;
  }
  // ground height under local (lx, lz), relative to the origin's height
  gh(lx, lz) {
    if (!this.W.heightAt) return 0;
    const c = Math.cos(this.ry), s = Math.sin(this.ry);
    return this.W.heightAt(this.base.x + lx * c + lz * s, this.base.z - lx * s + lz * c) - this.base.y;
  }
  // lowest / highest ground over a disc of radius r around local (x, z)
  foot(r, x = 0, z = 0, n = 7) {
    let lo = this.gh(x, z), hi = lo;
    for (let k = 0; k < n; k++) { const a = k / n * TAU, h = this.gh(x + Math.cos(a) * r, z + Math.sin(a) * r); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    return [lo, hi];
  }
}

// ---- foliage ---------------------------------------------------------------------------------------

// A leaf clump: a small lumpy solid leaf mass, wrapped in leaf-cluster cards whose normals point out
// of the clump (so it lights like a ball of leaves), darker toward the bottom and the inside. The
// cards turn about the vertical to face the camera; their tilt is kept within ±35°, so none goes
// edge-on.
function clump(b, C, R, rnd, o) {
  const sq = o.squash ?? 0.8, inner = o.inner ?? 0.5, tint0 = o.tint || WHITE, ao = o.ao || (() => 1), grid = o.grid || [2, 2];
  const warm = o.warm || null, tintAt = p => (warm ? mul3(tint0, warm(p)) : tint0);
  const fc = inset(cellOf(o.fill, ...grid), 0.02), sA = rnd() * 40, rows = 4, cols = 7, base = b.n;
  if (inner > 0) {
    for (let i = 0; i <= rows; i++) {
      const th = i / rows * Math.PI;
      for (let j = 0; j <= cols; j++) {
        const ph = j / cols * TAU + i * 0.3;
        const u = new V3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
        const k = inner * (1 + 0.22 * noise3(u.x * 1.4, u.y * 1.4, u.z * 1.4, sA)), ky = u.y < 0 ? (o.under ?? 0.8) : 1;
        const p = new V3(C.x + u.x * R * k, C.y + u.y * R * k * sq * ky, C.z + u.z * R * k);
        const n = new V3(u.x, u.y / sq, u.z).normalize();
        b.v(p, n, fc[0] + (fc[2] - fc[0]) * j / cols, fc[3] - (fc[3] - fc[1]) * i / rows, mulc(tintAt(p), ao(p) * (o.massK ?? 0.55) * (1 + 0.36 * (u.y + 1) / 2)), (o.wind ?? 1) * 0.3);
      }
    }
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const a = base + i * (cols + 1) + j, bb = a + 1, c = a + cols + 1, d = c + 1;
      b.t(a, bb, c); b.t(bb, d, c);
    }
  }
  const nC = o.cards, gold = 2.39996, sv = o.sizeVar || [0.85, 1.15];
  const e1 = new V3(), up = new V3(), fn = new V3();
  for (let i = 0; i < nC; i++) {
    const yy = 1 - (i + 0.5) / nC * (o.span ?? 1.5);
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy)), ph = i * gold + range(rnd, -0.4, 0.4);
    const dir = new V3(Math.cos(ph) * rr, yy, Math.sin(ph) * rr).normalize();
    const rho = range(rnd, 0.45, 0.85);
    const P = new V3(C.x + dir.x * R * rho, C.y + dir.y * R * rho * sq * (dir.y < 0 ? (o.under ?? 0.8) : 1), C.z + dir.z * R * rho);
    fn.copy(dir).add(randDir(rnd).multiplyScalar(o.jit ?? 0.42));
    // keep the card within ±35° of vertical
    const h = Math.hypot(fn.x, fn.z) || 1e-3, fy = Math.max(-0.55, Math.min(0.6, fn.y / Math.max(1e-3, fn.length())));
    const hs = Math.sqrt(1 - fy * fy) / h; fn.set(fn.x * hs, fy, fn.z * hs);
    if (Math.hypot(fn.x, fn.z) < 0.05) fn.set(Math.cos(ph) * 0.8, fy, Math.sin(ph) * 0.8);
    fn.normalize();
    up.copy(UP).addScaledVector(fn, -fn.y).normalize();
    e1.crossVectors(up, fn).normalize();
    const sz = o.size * range(rnd, sv[0], sv[1]), hw = sz / 2;
    const cellI = typeof o.cellFn === 'function' ? o.cellFn(dir) : pick(rnd, o.cells);
    const cell = inset(cellOf(cellI, ...grid));
    const us = [cell[0], cell[2], cell[2], cell[0]], vs = [cell[1], cell[1], cell[3], cell[3]];
    const vb = b.n, side = 0.62 + 0.38 * (dir.y + 1) / 2, rot = range(rnd, -0.35, 0.35), cr = Math.cos(rot), sr = Math.sin(rot);
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, c], k) => {
      const ox = (a * cr - c * sr) * hw, oy = (a * sr + c * cr) * hw;
      const off = new V3().addScaledVector(e1, ox).addScaledVector(up, oy);
      const p = new V3().copy(P).add(off);
      const q = new V3(P.x, P.y + oy, P.z);
      const nn = new V3().subVectors(q, C).normalize().multiplyScalar(0.55).addScaledVector(dir, 0.45).add(new V3(0, 0.1, 0)).normalize();
      b.v(p, nn, us[k], vs[k], mulc(tintAt(q), ao(q) * side * (0.82 + 0.18 * rho)), (o.wind ?? 1) * (c > 0 ? 1 : 0.7), [P, off, fn]);
    });
    b.t(vb, vb + 1, vb + 2); b.t(vb, vb + 2, vb + 3);
  }
}

// ---- trees -----------------------------------------------------------------------------------------

const barkAO = (y0 = 0, y1 = 1.8, lo = 0.5, tint = WHITE) => p => { const k = lo + (1 - lo) * smooth(y0, y1, p.y); return mulc(tint, k); };

// Roots that grip the ground: from inside the trunk out and down, following the ground.
function roots(ctx, b, rootA, r0, s, rnd, { len = [1.1, 1.7], rad = 0.3, up = 0.85, sides = 7, color = barkAO(-0.3, 1.2, 0.5) } = {}) {
  for (const ra of rootA) {
    const dx = Math.cos(ra), dz = Math.sin(ra), L = range(rnd, len[0], len[1]) * s;
    const steps = [[0, up], [0.3, up * 0.45], [0.62, 0.1], [0.85, -0.06], [1.08, -0.32]];
    const pts = steps.map(([f, yy]) => {
      const x = dx * (r0 * 0.35 + f * L) + range(rnd, -0.06, 0.06) * s, z = dz * (r0 * 0.35 + f * L) + range(rnd, -0.06, 0.06) * s;
      return new V3(x, ctx.gh(x, z) + yy * s, z);
    });
    const R = rad * s;
    tube(b, pts, [R, R * 0.8, R * 0.55, R * 0.36, R * 0.16], { sides, uRep: 1, vLen: 1.4, color, lobes: (dir) => 1 + 0.25 * Math.max(0, -dir.y) });
  }
}

// A curving limb: from a collar inside the parent, out along `dir`, bending as it goes.
function limb(P0, dir, L, rnd, { bends = 2, bendAmt = 0.35, rise = 0, segs = 6 } = {}) {
  const pts = [P0.clone()], d = dir.clone().normalize();
  const bendAt = new Set(); for (let k = 0; k < bends; k++) bendAt.add(1 + Math.floor(rnd() * (segs - 2)));
  for (let i = 1; i <= segs; i++) {
    if (bendAt.has(i)) { d.add(new V3(range(rnd, -1, 1), range(rnd, -0.6, 0.6), range(rnd, -1, 1)).multiplyScalar(bendAmt)).normalize(); }
    d.y += rise / segs; d.normalize();
    pts.push(pts[i - 1].clone().addScaledVector(d, L / segs));
  }
  return pts;
}

// Elwynn oak: a pale twisting bole with buttress roots that forks low into 3-4 heavy curving limbs,
// a domed canopy of clumps that droops past the limb tips and hangs low around the sides.
// Westfall's is smaller, scruffier, wider and lower, olive-gold with the odd rust clump.
function oak(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 11)), s = d.s || 1, B = ctx.bio, west = !!B.west;
  ctx.at(d, d.ry || 0);
  const bark = ctx.b('bark_oak'), leaves = ctx.b('leaves');
  const rC = 0.42 * s, r0 = rC * 1.05;                      // r0 ≈ the collider through the bumper band
  const H = (west ? range(rnd, 2.1, 2.5) : range(rnd, 2.6, 3.0)) * s + 0.3;     // the fork
  const [gLo] = ctx.foot(r0 * 2.2);
  const yBot = Math.min(-0.5, gLo - 0.35);
  const nR = 5 + (rnd() < 0.5 ? 1 : 0), a0 = rnd() * TAU;
  const rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.3, 0.3));
  const lx = range(rnd, -0.25, 0.25) * s, lz = range(rnd, -0.25, 0.25) * s, NT = 9, ph0 = rnd() * TAU;
  const tp = [], tr = [];
  const swell = y => smooth(Math.min(2.5, H - 0.6), H + 0.2, y);
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, y = yBot + t * (H + 0.35 - yBot), k = clamp01((y + 0.3) / (H + 0.6));
    tp.push(new V3(lx * k * k + Math.sin(k * 3 + a0) * 0.08 * s * k, y, lz * k * k - Math.cos(k * 2.6 + a0) * 0.06 * s * k));
    const fl = Math.pow(clamp01(1 - (y + 0.15) / (1.0 * s)), 2);
    tr.push(r0 * (1 + 0.4 * fl) * (1 + 0.55 * swell(y)));
  }
  const tcol = lin(B.oakTrunk || '#ffffff');
  const lobes = (dir, t, i) => {
    const y = tp[i].y, ph = Math.atan2(dir.z, dir.x);
    const f = Math.pow(clamp01(1 - (y + 0.15) / (1.0 * s)), 1.4);
    let m = 0; for (const ra of rootA) m = Math.max(m, clamp01(1 - angDiff(ph, ra) / 0.6));
    const twist = 1 + 0.085 * Math.cos(4 * (ph - ph0 - clamp01((y + 0.3) / (H + 0.6)) * 0.7)) * (1 - f);   // lobes that twist ~40° up the bole
    return (1 + f * 1.6 * m * m) * twist;
  };
  // moss creeps up the foot of the trunk on its shady side, and onto the tops of limbs
  if (B.barkCover) bark.cf = (p, n) => smooth(1.5 * s, 0.25, p.y) * (0.55 + 0.45 * clamp01(-n.x * 0.7 + n.z * 0.7 + 0.3));
  tube(bark, tp, tr, { sides: 12, uRep: 2, vLen: 1.5, twist: 0.12, lobes, color: barkAO(-0.3, 1.8, 0.5, tcol) });
  roots(ctx, bark, rootA, r0, s, rnd, { len: [0.8, 1.15], rad: 0.4, up: 0.85, color: barkAO(-0.3, 1.2, 0.5, tcol) });
  // limbs: 3-4 thick ones, 35-55° up (Westfall 22-38°), each with a swollen collar and 1-2 bends
  const F = tp[NT - 1], rF = tr[NT - 1], clumps = [];
  const nL = 3 + (rnd() < (west ? 0.7 : 0.55) ? 1 : 0), la0 = rnd() * TAU;
  const bc = barkAO(0, 3, 0.72, tcol);
  const tipR = [];
  for (let k = 0; k < nL; k++) {
    const a = la0 + k * TAU / nL + range(rnd, -0.3, 0.3), el = (west ? range(rnd, 22, 38) : range(rnd, 35, 55)) * Math.PI / 180;
    const dir = new V3(Math.cos(a) * Math.cos(el), Math.sin(el), Math.sin(a) * Math.cos(el));
    const L = (west ? range(rnd, 2.6, 3.3) : range(rnd, 2.2, 2.9)) * s, rb = rF * range(rnd, 0.6, 0.72);
    const start = new V3(F.x - dir.x * rF * 0.2, F.y - 0.3 * s + range(rnd, -0.15, 0.15) * s, F.z - dir.z * rF * 0.2);
    const pts = limb(start, dir, L, rnd, { bends: 1 + (rnd() < 0.5 ? 1 : 0), bendAmt: 0.32, rise: west ? 0.05 : 0.12 });
    const rad = pts.map((_, i) => i === 0 ? rF * 0.92 : rb * lerpArr([1.12, 0.95, 0.8, 0.66, 0.52, 0.4, 0.28], i / (pts.length - 1)));
    if (B.barkCover) bark.cf = (p, n) => 0;
    tube(bark, pts, rad, { sides: 9, uRep: 1.5, vLen: 1.4, twist: 0.08, color: bc });
    const tip = pts[pts.length - 1], outD = new V3(tip.x - F.x, 0, tip.z - F.z).normalize();
    tipR.push(Math.hypot(tip.x - F.x, tip.z - F.z));
    // the clump hangs out and down past the tip, so the crown droops
    clumps.push([new V3(tip.x + outD.x * 0.4 * s, tip.y - range(rnd, 0.1, 0.6) * s, tip.z + outD.z * 0.4 * s), range(rnd, 2.0, 2.45) * s]);
    // a side branch off the middle of the limb
    if (rnd() < (west ? 0.7 : 0.45)) {
      const m0 = pts[2].clone(), b2 = a + (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.6, 1.0);
      const d2 = new V3(Math.cos(b2), range(rnd, 0.15, 0.5), Math.sin(b2));
      const p2 = limb(m0, d2, range(rnd, 1.3, 1.9) * s, rnd, { bends: 1, bendAmt: 0.3, segs: 4 });
      tube(bark, p2, p2.map((_, i) => rb * 0.45 * (1 - i / p2.length * 0.7)), { sides: 7, uRep: 1, vLen: 1.4, color: bc });
      const e = p2[p2.length - 1];
      clumps.push([new V3(e.x, e.y - range(rnd, 0.1, 0.5) * s, e.z), range(rnd, 1.5, 1.85) * s]);
    }
  }
  // a short leader into the crown, and the crown clumps that round off the dome
  const crownR = tipR.reduce((a, b) => a + b, 0) / tipR.length;
  const leadTop = new V3(F.x + range(rnd, -0.3, 0.3) * s, F.y + (west ? 1.6 : 2.3) * s, F.z + range(rnd, -0.3, 0.3) * s);
  tube(bark, [new V3(F.x, F.y - 0.3 * s, F.z), F.clone().lerp(leadTop, 0.5), leadTop], [rF * 0.6, rF * 0.42, rF * 0.22], { sides: 8, uRep: 1.5, vLen: 1.4, color: bc });
  const topY = F.y + (west ? 2.7 : 3.4) * s;
  clumps.push([new V3(F.x + range(rnd, -0.3, 0.3) * s, topY + 0.3 * s, F.z + range(rnd, -0.3, 0.3) * s), range(rnd, 2.3, 2.7) * s]);
  const nTop = 2;
  for (let k = 0; k < nTop; k++) {
    const a = la0 + (k + 0.5) * TAU / nTop + range(rnd, -0.3, 0.3), dd = crownR * range(rnd, 0.45, 0.6);
    clumps.push([new V3(F.x + Math.cos(a) * dd, topY - range(rnd, 0.2, 0.6) * s, F.z + Math.sin(a) * dd), range(rnd, 1.9, 2.3) * s]);
  }
  // low side clumps between the limbs: the canopy hangs down around the fork, no flat underside
  const nLow = 2;
  for (let k = 0; k < nLow; k++) {
    const a = la0 + (k + 0.5) * TAU / nLow + range(rnd, -0.4, 0.4), dd = crownR * range(rnd, 0.75, 0.95);
    clumps.push([new V3(F.x + Math.cos(a) * dd, F.y + range(rnd, 1.5, 2.0) * s, F.z + Math.sin(a) * dd), range(rnd, 1.5, 1.8) * s]);
  }
  let yLo = Infinity, yHi = -Infinity;
  for (const [c, R] of clumps) { yLo = Math.min(yLo, c.y - R * 0.8); yHi = Math.max(yHi, c.y + R * 0.8); }
  const tint = lin(pick(rnd, B.oakTints));
  const ao = p => 0.32 + 0.68 * Math.pow(smooth(yLo, yHi, p.y), 1.1);
  const wk = west ? [1.1, 1.06, 0.86] : [1.12, 1.1, 0.8];
  const warm = p => { const t = smooth(yLo + (yHi - yLo) * 0.55, yHi, p.y); return [1 + (wk[0] - 1) * t, 1 + (wk[1] - 1) * t, 1 + (wk[2] - 1) * t]; };
  const den = B.leafDensity;
  for (const [c, R] of clumps) {
    if (west && rnd() < 0.18) continue;          // a scruffy, open crown: the limbs show
    clump(leaves, c, R * 0.92, rnd, { cards: Math.max(4, Math.round((5 + 2.6 * (R / s) ** 2) * den)), size: range(rnd, 1.8, 2.15) * s, cells: west ? [0, 0, 1] : [0, 0, 1], fill: 2, tint, ao, warm, squash: 0.86, inner: 0.5, under: 0.85, sizeVar: [0.8, 1.2] });
  }
  // undergrowth: a bush or two at the foot (they have no colliders, like any bush)
  if (rnd() < (west ? 0.3 : 0.45)) {
    const n = 1;
    for (let k = 0; k < n; k++) {
      const a = rnd() * TAU, dd = range(rnd, 1.3, 2.2) * s, R = range(rnd, 0.55, 0.8);
      const C = new V3(Math.cos(a) * dd, 0, Math.sin(a) * dd); C.y = ctx.gh(C.x, C.z) + R * 0.5;
      clump(leaves, C, R, rnd, { cards: Math.round(9 + 9 * R * R), size: range(rnd, 0.95, 1.2), cells: [3], fill: 2, tint, ao: p => 0.62 + 0.38 * smooth(C.y - R, C.y + R, p.y), squash: 0.78, inner: 0.42, wind: 0.6, sizeVar: [0.7, 1.3] });
    }
  }
}

// A pine: a straight trunk that stops inside the crown, stacked drooping tiers of bough cards round
// dark inner cones, closed off by a solid top cone and a tip spray. Dun Morogh's carry snow on every
// bough (painted; the undersides show bare needles).
function pine(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 12)), s = d.s || 1, B = ctx.bio, snow = !!B.snow;
  ctx.at(d, d.ry || 0);
  const bark = ctx.b('bark_pine'), nd = ctx.b('needles');
  const grid = snow ? [4, 2] : [2, 2];
  const H = (snow ? range(rnd, 8.5, 11) : range(rnd, 8, 10.5)) * s, r0 = 0.31 * s;
  const [gLo] = ctx.foot(r0 * 2);
  const yBot = Math.min(-0.4, gLo - 0.3);
  const lx = range(rnd, -0.2, 0.2) * s, lz = range(rnd, -0.2, 0.2) * s;
  const center = y => { const t = clamp01((y + 0.4) / (H + 0.4)); return [lx * t * t, lz * t * t]; };
  const yTrunk = H * 0.6, tp = [], tr = [], NT = 6;
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, y = yBot + t * (yTrunk - yBot), [cx, cz] = center(y);
    tp.push(new V3(cx, y, cz));
    tr.push(Math.max(0.03 * s, r0 * (1.08 - 0.88 * Math.pow(clamp01(y / yTrunk), 1.4)) * (1 + 0.5 * Math.pow(clamp01(1 - (y + 0.2) / (1.0 * s)), 2))));
  }
  const nR = 4, a0 = rnd() * TAU, rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.4, 0.4));
  tube(bark, tp, tr, {
    sides: 8, uRep: 2, vLen: 2.2, color: barkAO(-0.3, 1.5, 0.45),
    lobes: (dir, t, i) => { const f = Math.pow(clamp01(1 - (tp[i].y + 0.2) / (0.9 * s)), 1.5), ph = Math.atan2(dir.z, dir.x); let m = 0; for (const ra of rootA) m = Math.max(m, clamp01(1 - angDiff(ph, ra) / 0.6)); return 1 + f * 0.8 * m * m; },
  });
  roots(ctx, bark, rootA, r0, s, rnd, { len: [0.7, 1.0], rad: 0.2, up: 0.5, sides: 6, color: barkAO(-0.3, 1.2, 0.45) });
  const tint = lin(pick(rnd, B.pineTints));
  const nT = Math.round((snow ? 8 : 7) * Math.min(1.1, Math.max(0.85, s)));
  const Rb = (snow ? 3.0 : 3.3) * s * range(rnd, 0.92, 1.08), dK = snow ? 0.42 : 0.45;
  const y0 = (Rb + 0.25 * s) * dK * 1.05 + range(rnd, 0.25, 0.45) * s, y1 = H * 0.86;
  const dyT = (y1 - y0) / (nT - 1);
  const cellDense = inset(cellOf(snow ? 6 : 2, ...grid));
  const tiers = [];
  for (let i = 0; i < nT; i++) {
    const t = i / (nT - 1);
    const y = y0 + (y1 - y0) * Math.pow(t, 0.8) + range(rnd, -0.08, 0.08) * s;
    tiers.push({ t, y, R: Rb * (1 - 0.76 * t) * range(rnd, 0.92, 1.06) + 0.5 * s });
  }
  // two small tiers close the crown up to the tip
  tiers.push({ t: 1, y: y1 + (H - y1) * 0.42, R: 0.75 * s, mini: true }, { t: 1, y: y1 + (H - y1) * 0.75, R: 0.45 * s, mini: true });
  for (let i = 0; i < tiers.length; i++) {
    const { t, y, R, mini } = tiers[i];
    const droop = Math.max(R * dK, 0.55 * s);
    const [cx, cz] = center(y);
    const tierAO = 0.72 + 0.28 * t;
    // the dark solid cone under the boughs, overlapping the tier above so no trunk shows
    const yTopC = i < tiers.length - 1 ? tiers[i + 1].y + 0.25 * s : H - 0.2 * s;
    tube(nd, [new V3(cx, y - droop * 0.7, cz), new V3(cx, (y - droop * 0.7 + yTopC) / 2, cz), new V3(cx, yTopC, cz)], [R * 0.4, R * 0.17, 0.04 * s], {
      sides: 9, uRep: 1, vLen: 1,
      uvMap: (u, v, tt) => [cellDense[0] + u * (cellDense[2] - cellDense[0]), cellDense[1] + tt * (cellDense[3] - cellDense[1])],
      color: mulc(tint, 0.6 * tierAO), wind: 0.15,
    });
    const K = mini ? 5 : Math.max(7, Math.round(7 + 2 * (1 - t))), th0 = rnd() * TAU;
    for (let k = 0; k < K; k++) {
      const th = th0 + k * TAU / K + range(rnd, -0.18, 0.18), dx = Math.cos(th), dz = Math.sin(th);
      const RR = R * range(rnd, 0.88, 1.12), W = TAU * RR / K * 1.45, dr = droop * range(rnd, 0.8, 1.2);
      const tilt = Math.atan2(dr, RR);
      const nrm = new V3(dx * Math.sin(tilt) * 0.9, Math.cos(tilt), dz * Math.sin(tilt) * 0.9).normalize();
      const rowsF = mini ? [[0.02, 0.3, 0.5], [0.55, -0.1, 0.95], [1.0, -0.6, 0.85]] : [[0.03, 0.18 + 0.3 * t, 0.4], [0.52, -0.32, 0.92], [1.0, -1.0, 0.86]];
      const rows = rowsF.map(([f, yf, wf]) => {
        const rho = RR * f, yy = y + (yf > 0 ? yf * s : yf * dr);
        const px = cx + dx * rho, pz = cz + dz * rho, hw = W * wf / 2;
        return [new V3(px + dz * hw, yy, pz - dx * hw), new V3(px - dz * hw, yy, pz + dx * hw)];
      });
      let ci = rnd() < 0.5 ? 0 : 1;
      if (snow && i === 0 && rnd() < 0.2) ci += 2;     // the odd bare bough low down
      const cell = inset(cellOf(ci, ...grid));
      const vs = [cell[1], (cell[1] + cell[3]) / 2, cell[3]];
      strip(nd, rows, [cell[0], cell[2]], vs, (ri) => new V3().copy(nrm).add(new V3(dx, 0, dz).multiplyScalar(ri * 0.15)).normalize(),
        ri => mulc(tint, tierAO * [0.72, 0.92, 1.06][ri]), ri => [0, 0.45, 1][ri] * 0.8, nrm);
    }
  }
  // the leader: a short crossed tip spray above the last little tier
  const yT = tiers[tiers.length - 1].y, [tx, tz] = center(H);
  const tipCell = inset(cellOf(snow ? 5 : 3, ...grid));
  const a0t = rnd() * Math.PI;
  for (let k = 0; k < 2; k++) {
    const a = a0t + k * Math.PI / 2;
    card(nd, new V3(tx, yT - 0.15 * s, tz), 0.7 * s, H - yT + 0.5 * s, new V3(Math.cos(a), 0, Math.sin(a)), tipCell, mulc(tint, 1.02), { wind: 0.6, shade: () => new V3(0, 1, 0) });
  }
}

// Tanaris palm: a trunk with a bulb at the foot that stays inside its collider up to 3 m, then leans
// in an S-curve; a collar of old frond bases, a big arching crown with an upright inner tier and a
// skirt of dead fronds, coconuts, and a tuft of young fronds at its foot.
function palm(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 13)), s = d.s || 1, B = ctx.bio;
  ctx.at(d, d.ry || 0);
  const bark = ctx.b('bark_palm'), fr = ctx.b('frond');
  const L = Math.max(5.6, range(rnd, 6.0, 7.2) * s), la = rnd() * TAU, lean = range(rnd, 1.5, 2.4) * s, sb = rnd() * TAU;
  const [gLo] = ctx.foot(0.6 * s);
  const yBot = Math.min(-0.4, gLo - 0.3);
  const pts = [], rad = [];
  const NS = 12;
  for (let i = 0; i <= NS; i++) {
    const t = i / NS, y = yBot + t * (L - yBot), u = clamp01((y - 2.9) / (L - 2.9)), off = lean * u * u * (3 - 2 * u);
    const bow = Math.sin(clamp01(y / L) * Math.PI) * 0.04 * s;
    pts.push(new V3(Math.cos(la) * off + Math.cos(sb) * bow, y, Math.sin(la) * off + Math.sin(sb) * bow));
    rad.push(s * (0.28 + 0.08 * (1 - clamp01(y / L))) + s * 0.22 * Math.pow(clamp01(1 - (y + 0.1) / 1.0), 1.6));
  }
  tube(bark, pts, rad, { sides: 10, uRep: 1.5, vLen: 2.8, color: barkAO(-0.3, 1.2, 0.55), lobes: (dir, t, i, j) => 1 + 0.03 * Math.sin(j * 2.1 + i) });
  const T = pts[NS], Td = new V3().subVectors(pts[NS], pts[NS - 1]).normalize();
  // collar of old frond bases
  const dry = lin('#c0a070');
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * TAU + range(rnd, -0.2, 0.2), c = Math.cos(a), sn = Math.sin(a), y0 = T.y - range(rnd, 0.1, 0.6) * s;
    const b0 = new V3(T.x + c * 0.18 * s, y0, T.z + sn * 0.18 * s), b1 = new V3(T.x + c * 0.5 * s, y0 + range(rnd, -0.05, 0.25) * s, T.z + sn * 0.5 * s);
    tube(bark, [b0, b1], [0.11 * s, 0.05 * s], { sides: 5, uRep: 1, vLen: 0.6, cap: true, color: mulc(dry, range(rnd, 0.8, 1)) });
  }
  sphereish(bark, 1, u => new V3(T.x + u.x * 0.32 * s, T.y + 0.05 + u.y * 0.3 * s, T.z + u.z * 0.32 * s), { uv: u => [u.x * 0.5 + 0.5, u.y * 0.5 + 0.5], color: lin('#c8c0a0') });
  for (let k = 0; k < 4 + Math.floor(rnd() * 3); k++) {
    const a = rnd() * TAU, C = new V3(T.x + Math.cos(a) * 0.3 * s, T.y - 0.22 * s + range(rnd, -0.08, 0.05), T.z + Math.sin(a) * 0.3 * s);
    sphereish(bark, 1, u => new V3(C.x + u.x * 0.15 * s, C.y + u.y * 0.15 * s, C.z + u.z * 0.15 * s), { uv: u => [u.x * 0.3 + 0.5, u.y * 0.3 + 0.5], color: lin('#6a5038') });
  }
  const tint = lin(pick(rnd, B.palmTints || ['#ffffff']));
  const cellG = [0, 0, 0.5, 1], cellD = [0.5, 0, 1, 1];
  const frond = (O, az, e0, Lf, Wf, cell, dryK, grav) => {
    const ca = Math.cos(az), sa = Math.sin(az), ax = -sa, az2 = ca;
    const rows = [], N = 8;
    for (let i = 0; i <= N; i++) {
      const t = i / N, hd = Lf * t * Math.cos(e0) * (1 - 0.1 * t), y = O.y + Lf * t * Math.sin(e0) - Lf * grav * t * t;
      const w = Wf * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.95)), 0.7) / 2;
      const px = O.x + ca * hd, pz = O.z + sa * hd, drop = w * 0.4;
      rows.push([new V3(px + ax * w, y - drop, pz + az2 * w), new V3(px, y, pz), new V3(px - ax * w, y - drop, pz - az2 * w)]);
    }
    const c = inset(cell, 0.004);
    const us = [c[0], (c[0] + c[2]) / 2, c[2]], vs = rows.map((_, i) => c[1] + (c[3] - c[1]) * i / N);
    strip(fr, rows, us, vs, (ri, ci) => {
      const t = ri / N, slope = Math.sin(e0) - 2 * grav * t;
      return new V3(-ca * slope * 0.5 + (ci - 1) * ax * 0.45, 1, -sa * slope * 0.5 + (ci - 1) * az2 * 0.45).normalize();
    }, ri => mulc(tint, (0.68 + 0.32 * ri / N) * dryK), ri => ri / N * 1.2, UP);
  };
  const O = new V3(T.x, T.y + 0.08, T.z);
  const nF = 16 + Math.floor(rnd() * 5), f0 = rnd() * TAU;
  for (let k = 0; k < nF; k++) frond(O, f0 + k * TAU / nF + range(rnd, -0.15, 0.15), range(rnd, 0.3, 0.8), range(rnd, 5.0, 6.0) * Math.max(0.9, s), range(rnd, 1.8, 2.2) * Math.max(0.9, s), cellG, 1, 0.5);
  for (let k = 0; k < 7; k++) frond(new V3(O.x, O.y + 0.1, O.z), f0 + (k + 0.5) * TAU / 7, range(rnd, 0.95, 1.25), range(rnd, 2.8, 3.4) * Math.max(0.9, s), range(rnd, 1.2, 1.5) * Math.max(0.9, s), cellG, 1.05, 0.32);
  for (let k = 0; k < 4 + Math.floor(rnd() * 3); k++) frond(new V3(O.x, O.y - 0.25 * s, O.z), rnd() * TAU, range(rnd, -1.35, -1.05), range(rnd, 2.0, 2.6) * s, range(rnd, 0.9, 1.2) * s, cellD, 0.85, 0.05);
  // young fronds at the foot
  if (rnd() < 0.8) {
    const a = rnd() * TAU, dd = range(rnd, 0.7, 1.2) * s, gx = Math.cos(a) * dd, gz = Math.sin(a) * dd, G = new V3(gx, ctx.gh(gx, gz) - 0.05, gz);
    const n = 6 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) frond(G, k / n * TAU + range(rnd, -0.3, 0.3), range(rnd, 0.6, 1.1), range(rnd, 1.0, 1.6) * s, range(rnd, 0.55, 0.75) * s, cellG, 0.95, 0.4);
  }
}

// Bushes: lobed leaf clumps (green in Elwynn, olive in Westfall), sage and twig brush in the dry
// lands, and in Dun Morogh a low snowy juniper mound.
function bush(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 14)), s = d.s || 1, B = ctx.bio;
  ctx.at(d, d.ry || 0);
  const b = ctx.b(B.bush);
  const tint = lin(pick(rnd, B.bushTints));
  const n = 2 + Math.floor(rnd() * 2.5);
  const snow = !!B.snow, dry = B.bush === 'scrub';
  const ao = p => (dry ? 0.7 : 0.6) + (dry ? 0.3 : 0.4) * smooth(0, 1.4 * s, p.y);
  const warm = snow ? null : p => { const t = smooth(0.5 * s, 1.5 * s, p.y); return [1 + 0.12 * t, 1 + 0.1 * t, 1 - 0.15 * t]; };
  for (let k = 0; k < n; k++) {
    const a = rnd() * TAU, dd = k === 0 ? 0 : range(rnd, 0.35, 0.65) * s, R = (k === 0 ? range(rnd, 0.75, 0.95) : range(rnd, 0.5, 0.75)) * s * (snow ? 1.25 : 1);
    const C = new V3(Math.cos(a) * dd, R * (snow ? 0.45 : 0.6), Math.sin(a) * dd);
    C.y += ctx.gh(C.x, C.z);
    if (snow) {
      clump(b, C, R, rnd, { cards: Math.round((9 + 9 * (R / s) ** 2) * 1.3), size: range(rnd, 1.0, 1.25) * s, grid: [4, 2], fill: 4, cellFn: dir => (dir.y > -0.15 ? (rnd() < 0.5 ? 0 : 1) : (rnd() < 0.5 ? 2 : 3)), tint, ao, squash: 0.7, inner: 0.45, wind: 0.4, massK: 0.75, sizeVar: [0.7, 1.3], span: 1.3 });
    } else {
      clump(b, C, R, rnd, { cards: Math.round((7 + 7 * (R / s) ** 2) * 1.3), size: range(rnd, 1.0, 1.25) * s, cells: B.bushCells, fill: B.bushFill, tint, ao, warm, squash: 0.78, inner: dry ? 0.4 : 0.42, wind: 0.6, massK: dry ? 0.75 : 0.5, sizeVar: [0.7, 1.3] });
    }
  }
}

// A dead tree: a gnarled trunk that splits at the top into 2-3 twisting forks with kinks, a broken
// snag or two, a jagged split point instead of a cap, and rounded roots gripping the ground.
function deadTree(ctx, s, rnd, { r0 = 0.27, ring = null } = {}) {
  const b = ctx.b('bark_dead');
  const tint = lin(ctx.bio.deadTint || '#c8c0b8');
  const col = (lo) => (p) => mulc(tint, lo + (1 - lo) * smooth(-0.2, 1.6, p.y));
  const H = range(rnd, 3.4, 4.4) * s, a0 = rnd() * TAU;
  const [gLo] = ctx.foot(r0 * 2.4);
  const yBot = Math.min(-0.4, gLo - 0.3);
  const tp = [], tr = [], NT = 8;
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, y = yBot + t * (H - yBot), k = clamp01(y / H);
    tp.push(new V3(Math.sin(k * 3.1 + a0) * 0.32 * k * s + Math.sin(k * 7 + a0) * 0.05 * k, y, Math.cos(k * 2.3 + a0) * 0.28 * k * s));
    tr.push(r0 * (1.08 - 0.5 * k) * (1 + 0.55 * Math.pow(clamp01(1 - (y + 0.2) / 1.1), 2)));
  }
  const nR = 4 + (rnd() < 0.5 ? 1 : 0), rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.4, 0.4));
  const ph0 = rnd() * TAU;
  tube(b, tp, tr, {
    sides: 10, uRep: 1.5, vLen: 1.6, twist: 0.15, color: col(0.5),
    lobes: (dir, t, i) => { const f = Math.pow(clamp01(1 - (tp[i].y + 0.2) / 1.0), 1.5), ph = Math.atan2(dir.z, dir.x); let m = 0; for (const ra of rootA) m = Math.max(m, clamp01(1 - angDiff(ph, ra) / 0.7)); return (1 + f * 0.75 * m * m) * (1 + 0.08 * Math.cos(3 * (ph - ph0 - t * 1.2))); },
  });
  roots(ctx, b, rootA, r0, 1, rnd, { len: [0.65, 1.0], rad: 0.19, up: 0.5, sides: 7, color: col(0.5) });
  // the split top: two jagged spikes
  const top = tp[NT], rT = tr[NT];
  for (let k = 0; k < 2; k++) {
    const a = a0 + k * Math.PI + range(rnd, -0.4, 0.4), h = range(rnd, 0.25, 0.6) * s;
    tube(b, [new V3(top.x + Math.cos(a) * rT * 0.3, top.y - 0.1, top.z + Math.sin(a) * rT * 0.3), new V3(top.x + Math.cos(a) * rT * 0.5, top.y + h, top.z + Math.sin(a) * rT * 0.5)], [rT * 0.6, 0.01], { sides: 6, uRep: 1, vLen: 1.6, color: col(0.8) });
  }
  const at = t => { const f = t * NT, i = Math.min(NT - 1, Math.floor(f)), u = f - i; return [tp[i].clone().lerp(tp[i + 1], u), tr[i] + (tr[i + 1] - tr[i]) * u]; };
  const twigs = (pts, rB, n = 2) => {
    for (let tw = 0; tw < n; tw++) {
      const q = pts[2 + tw], td = new V3(range(rnd, -1, 1), range(rnd, 0.3, 1), range(rnd, -1, 1)).normalize(), tl = range(rnd, 0.4, 0.8) * s;
      tube(b, [q, q.clone().addScaledVector(td, tl * 0.5).add(new V3(0, 0.05, 0)), q.clone().addScaledVector(td, tl)], [rB * 0.28, rB * 0.16, 0.01], { sides: 5, uRep: 1, vLen: 1.6, color: col(0.85) });
    }
  };
  // 2-3 major forks from the upper trunk, thick at the base, kinked and twisting
  const nF = 2 + (rnd() < 0.55 ? 1 : 0);
  for (let k = 0; k < nF; k++) {
    const t = range(rnd, 0.55, 0.78), [P0, rr] = at(t), a = a0 + k * TAU / nF + range(rnd, -0.35, 0.35);
    const rB = rr * range(rnd, 0.7, 0.82), L = range(rnd, 1.3, 2.1) * s * range(rnd, 0.75, 1.25);
    const pts = limb(P0, new V3(Math.cos(a), range(rnd, 0.45, 1.0), Math.sin(a)), L, rnd, { bends: 2 + (rnd() < 0.5 ? 1 : 0), bendAmt: 0.5, rise: 0.12, segs: 6 });
    tube(b, pts, pts.map((_, i) => rB * lerpArr([1.1, 1.0, 0.9, 0.78, 0.64, 0.5, 0.34], i / (pts.length - 1))), { sides: 8, uRep: 1, vLen: 1.6, color: col(0.75), cap: 0.8 });
    twigs(pts, rB, 1);
    // a secondary branch
    const m0 = pts[2], b2 = a + (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.7, 1.3);
    const p2 = limb(m0, new V3(Math.cos(b2), range(rnd, 0.3, 0.9), Math.sin(b2)), range(rnd, 0.9, 1.5) * s, rnd, { bends: 1, bendAmt: 0.6, segs: 4 });
    tube(b, p2, p2.map((_, i) => rB * 0.5 * lerpArr([1, 0.85, 0.68, 0.5, 0.3], i / (p2.length - 1))), { sides: 7, uRep: 1, vLen: 1.6, color: col(0.8), cap: 1 });
  }
  // lower limbs and broken snags
  const nLow = 1 + (rnd() < 0.6 ? 1 : 0);
  for (let k = 0; k < nLow; k++) {
    const t = range(rnd, 0.3, 0.5), [P0, rr] = at(t), a = a0 + range(rnd, 0, TAU);
    const rB = rr * range(rnd, 0.45, 0.6), snag = rnd() < 0.5, L = (snag ? range(rnd, 0.3, 0.6) : range(rnd, 1.2, 1.9)) * s;
    const pts = limb(P0, new V3(Math.cos(a), range(rnd, 0.3, 0.8), Math.sin(a)), L, rnd, { bends: snag ? 0 : 2, bendAmt: 0.5, segs: snag ? 2 : 5 });
    tube(b, pts, pts.map((_, i) => rB * (snag ? (i < pts.length - 1 ? 1 - i * 0.15 : 0.55) : lerpArr([1, 0.8, 0.6, 0.4, 0.22, 0.06], i / (pts.length - 1)))), { sides: 7, uRep: 1, vLen: 1.6, color: col(0.72), cap: snag ? 0.9 : 2 });
    if (!snag) twigs(pts, rB);
  }
  if (ring != null) {
    // the winch strap: an iron band round the trunk at the hook's height, and a shackle ring
    let i = 0; while (i < NT - 1 && tp[i + 1].y < ring) i++;
    const f = clamp01((ring - tp[i].y) / (tp[i + 1].y - tp[i].y)), c = tp[i].clone().lerp(tp[i + 1], f), rr = (tr[i] + (tr[i + 1] - tr[i]) * f) * 1.06 + 0.03;
    const ib = ctx.b('iron'), loop = [];
    for (let k = 0; k <= 16; k++) { const a = k / 16 * TAU; loop.push(new V3(c.x + Math.cos(a) * rr, c.y + Math.sin(a * 3) * 0.015, c.z + Math.sin(a) * rr)); }
    tube(ib, loop, loop.map(() => 0.04), { sides: 6, uRep: 1, vLen: 0.4, color: WHITE });
    const sh = [];
    for (let k = 0; k <= 12; k++) { const a = k / 12 * TAU; sh.push(new V3(c.x + rr + 0.1 + Math.cos(a) * 0.09, c.y - 0.1 + Math.sin(a) * 0.11, c.z)); }
    tube(ib, sh, sh.map(() => 0.024), { sides: 6, uRep: 1, vLen: 0.4, color: WHITE });
  }
}

function stump(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 15)), s = d.s || 1;
  ctx.at(d, d.ry || 0);
  const dryLand = ctx.biome === 'badlands' || ctx.biome === 'desert';
  const bark = ctx.b(dryLand ? 'bark_dead' : 'bark_oak'), top = ctx.b('stump_top');
  const R = range(rnd, 0.42, 0.56) * s, H = range(rnd, 0.45, 0.8) * s, a0 = rnd() * TAU;
  const [gLo, gHi] = ctx.foot(R * 1.2);
  const rootA = []; for (let k = 0; k < 4; k++) rootA.push(a0 + k * TAU / 4 + range(rnd, -0.3, 0.3));
  const yT = gHi * 0.5 + H;
  const pts = [new V3(0, Math.min(-0.35, gLo - 0.3), 0), new V3(0, 0.1, 0), new V3(0, yT * 0.55, 0), new V3(0, yT, 0), new V3(0, yT + 0.012, 0)];
  const rad = [R * 1.3, R * 1.12, R * 1.02, R, R * 0.88];
  if (ctx.bio.barkCover) bark.cf = (p, n) => smooth(0.7, 0.05, p.y) * 0.5;
  tube(bark, pts, rad, {
    sides: 11, uRep: 2, vLen: 1.4, color: barkAO(-0.3, 0.8, 0.55, lin(ctx.bio.oakTrunk || '#ffffff')),
    lobes: (dir, t, i) => { if (i >= 3) return 1 + 0.04 * Math.sin(Math.atan2(dir.z, dir.x) * 6); const f = i === 0 ? 1 : i === 1 ? 0.6 : 0.15, ph = Math.atan2(dir.z, dir.x); let m = 0; for (const ra of rootA) m = Math.max(m, clamp01(1 - angDiff(ph, ra) / 0.6)); return 1 + f * 0.6 * m * m; },
  });
  roots(ctx, bark, rootA, R, s * 0.8, rnd, { len: [0.6, 0.9], rad: 0.24, up: 0.4 });
  disc(top, new V3(0, yT + 0.014, 0), UP, R * 0.9, 14, (c, sn) => [0.5 + c * 0.43, 0.5 + sn * 0.43]);
}

// ---- rocks ------------------------------------------------------------------------------------------

// A chunky planar rock: a lumpy ellipsoid cut flat by a strong top plane, near-vertical side planes
// and a few oblique ones (full flattening), so its silhouette is chiselled faces; creased normals
// keep each face smooth. Unit-ish, in its own frame (y up, the underside flat and buried).
function rockShape(rnd, o = {}) {
  const sx = o.sx ?? 1, sy = o.sy ?? 0.75, sz = o.sz ?? 1, nz = o.noise ?? 0.12;
  const I = ico(o.detail ?? 1), sA = rnd() * 50;
  const supp = n => Math.sqrt((n.x * sx) ** 2 + (n.y * sy) ** 2 + (n.z * sz) ** 2);
  const cuts = [];
  const add = (n, k) => { n.normalize(); cuts.push([n, k * supp(n)]); };
  const tt = o.topTilt ?? 0.15;
  if (o.top !== false) add(new V3(range(rnd, -tt, tt), 1, range(rnd, -tt, tt)), range(rnd, ...(o.topCut || [0.55, 0.78])));
  const nS = o.sides ?? 3, a0 = rnd() * TAU;
  for (let k = 0; k < nS; k++) { const a = a0 + (k + range(rnd, -0.25, 0.25)) * TAU / nS; add(new V3(Math.cos(a), range(rnd, -0.06, 0.2), Math.sin(a)), range(rnd, ...(o.sideCut || [0.6, 0.8]))); }
  for (let k = 0; k < (o.oblique ?? 3); k++) { const a = rnd() * TAU, e = range(rnd, 0.35, 0.9); add(new V3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)), range(rnd, 0.56, 0.78)); }
  const bot = o.bottom ?? 0.5;
  const P = I.P.map(u => {
    const k = 1 + nz * noise3(u.x * 1.3, u.y * 1.3, u.z * 1.3, sA) + 0.04 * noise3(u.x * 3.1, u.y * 3.1, u.z * 3.1, sA + 7);
    const p = new V3(u.x * k * sx, u.y * k * sy, u.z * k * sz);
    for (let it = 0; it < 2; it++) for (const [n, dd] of cuts) { const e = p.dot(n) - dd; if (e > 0) p.addScaledVector(n, -e); }
    if (p.y < -bot * sy) p.y = -bot * sy;
    if (o.under && p.y < 0) { const f = 1 - o.under * smooth(0, -bot * sy, p.y); p.x *= f; p.z *= f; }
    return p;
  });
  return { P, idx: I.idx };
}

// Put a rock shape into the world: scale R, tilt, turn, move to C; AO dark at the foot, a little
// lighter on top. Returns the placed points (for a snow cap).
function placeRock(b, shape, C, R, { yaw = 0, tilt = 0, tiltA = 0, tint = WHITE, aoLo = 0.42 } = {}) {
  const m = new THREE.Matrix4().makeRotationY(yaw);
  if (tilt) m.multiply(new THREE.Matrix4().makeRotationAxis(new V3(Math.cos(tiltA), 0, Math.sin(tiltA)), tilt));
  const P = shape.P.map(p => p.clone().multiplyScalar(R).applyMatrix4(m).add(C));
  let y0 = Infinity, y1 = -Infinity; for (const p of P) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const yg = Math.max(y0, C.y - 0.35 * (y1 - y0));
  const FD = faceData(P, shape.idx);
  creased(b, P, shape.idx, (p, n) => mulc(tint, (aoLo + (1 - aoLo) * smooth(yg - 0.1, yg + Math.max(0.5, (y1 - yg) * 0.7), p.y)) * (0.9 + 0.12 * n.y)), FD);
  return { P, idx: shape.idx, FD };
}

// A snow cap on a placed rock: the up-facing faces lifted into a soft pillow, with a lip hanging
// over the edges.
function snowCap(b, rk, thick) {
  const { P, idx, FD } = rk, { FN, FA, VF } = FD;
  const snowy = FN.map((n, f) => FA[f] > 1e-9 && n.y > 0.74);
  if (!snowy.some(Boolean)) return;
  const map = new Map(), Ps = [], frac = [], nrm = [];
  const vid = vi => {
    if (map.has(vi)) return map.get(vi);
    let c = 0, t = 0; const n = new V3();
    for (const f of VF[vi]) if (FA[f] > 1e-9) { t++; if (snowy[f]) c++; n.addScaledVector(FN[f], FA[f]); }
    n.normalize();
    const fr = t ? c / t : 0;
    const p = P[vi].clone().addScaledVector(UP, thick * (0.45 + 0.55 * fr)).addScaledVector(n, 0.015);
    map.set(vi, Ps.length); Ps.push(p); frac.push(fr); nrm.push(n);
    return Ps.length - 1;
  };
  const I = [];
  const edges = new Map();
  for (let f = 0; f < snowy.length; f++) {
    if (!snowy[f]) continue;
    const a = idx[f * 3], bb = idx[f * 3 + 1], c = idx[f * 3 + 2];
    I.push(vid(a), vid(bb), vid(c));
    for (const [u, v] of [[a, bb], [bb, c], [c, a]]) { const k = u < v ? u + ',' + v : v + ',' + u; edges.set(k, (edges.get(k) || 0) + 1); }
  }
  // the lip: under every boundary edge, a curtain that hangs over the rock face
  const lip = new Map();
  const lipId = vi => {
    if (lip.has(vi)) return lip.get(vi);
    const s = Ps[map.get(vi)], n = nrm[map.get(vi)], out = new V3(n.x, 0, n.z);
    if (out.lengthSq() > 1e-6) out.normalize();
    const p = P[vi].clone().addScaledVector(UP, -thick * 0.6).addScaledVector(out, thick * 0.35);
    p.y = Math.min(p.y, s.y - thick * 0.9);
    lip.set(vi, Ps.length); Ps.push(p); frac.push(-1); nrm.push(n);
    return Ps.length - 1;
  };
  for (let f = 0; f < snowy.length; f++) {
    if (!snowy[f]) continue;
    const a = idx[f * 3], bb = idx[f * 3 + 1], c = idx[f * 3 + 2];
    for (const [u, v] of [[a, bb], [bb, c], [c, a]]) {
      const k = u < v ? u + ',' + v : v + ',' + u;
      if (edges.get(k) !== 1) continue;
      const su = map.get(u), sv = map.get(v), lu = lipId(u), lv = lipId(v);
      I.push(su, lv, sv, su, lu, lv);
    }
  }
  const lo = lin('#c2d0e4');
  mesh(b, Ps, I, { color: (p, n, i) => (frac[i] < 0 ? mixc(lo, WHITE, 0.15) : mixc(lo, WHITE, clamp01(0.35 + n.y * 0.7))) });
}

function rock(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 16)), B = ctx.bio, bm = ctx.biome;
  let S = (d.s || 1) * (B.strata ? 1.25 : 1);    // the canyon lands get bigger formations
  ctx.at(d, d.ry || 0);
  const b = ctx.b('rock'), cap = B.snowCaps ? ctx.b('snowcap') : null;
  const tint = () => lin(pick(rnd, B.rockTints));
  // sit every piece on the lowest ground under it, sunk; skip satellites on steep ground
  const [lo0, hi0] = ctx.foot(S * 1.1);
  const steep = hi0 - lo0 > 0.8 * S;
  if (steep) S *= 0.75;
  const piece = (x, z, R, shapeO, o = {}) => {
    const [lo] = ctx.foot(R * (shapeO.sx ?? 1) * 0.9, x, z, 6);
    const sy = shapeO.sy ?? 0.75, bot = shapeO.bottom ?? 0.5;
    const C = new V3(x, lo + R * sy * (bot - 0.32) + (o.lift || 0), z);
    const rk = placeRock(b, rockShape(rnd, { detail: R > 1.25 ? 2 : 1, ...shapeO }), C, R, { yaw: rnd() * TAU, tint: tint(), ...o });
    if (cap) snowCap(cap, rk, Math.min(0.16, 0.05 + 0.05 * R));
    return C;
  };
  if (bm === 'badlands') {
    if (S > 1.3 && rnd() < 0.35) {           // a hoodoo: one tall chiselled column under a wider cap stone
      const [lo] = ctx.foot(S * 0.7), hc = S * range(rnd, 1.7, 2.3), R = S * 0.55;
      placeRock(b, rockShape(rnd, { detail: 2, sx: 1, sy: hc / R * 0.52, sz: range(rnd, 0.75, 0.95), sides: 5, oblique: 2, topTilt: 0.05, topCut: [0.88, 0.96], bottom: 0.92, sideCut: [0.62, 0.78], under: -0.25, noise: 0.1 }), new V3(0, lo - 0.25 * S + hc * 0.48, 0), R, { yaw: rnd() * TAU, tint: tint(), aoLo: 0.5 });
      placeRock(b, rockShape(rnd, { sx: 1, sy: 0.34, sz: 0.85, sides: 5, oblique: 2, topTilt: 0.06, topCut: [0.8, 0.92], bottom: 0.9, sideCut: [0.62, 0.8], noise: 0.08 }), new V3(0.05 * S, lo - 0.25 * S + hc * 0.96 + 0.1 * S, 0), S * 0.8, { yaw: rnd() * TAU, tint: tint(), aoLo: 0.75 });
    } else {                                  // a blocky broken block with ledges stepping out of it
      const [lo] = ctx.foot(S * 1.1);
      const hb = S * range(rnd, 0.9, 1.3), ha = rnd() * TAU;
      placeRock(b, rockShape(rnd, { detail: 2, sx: range(rnd, 1, 1.3), sy: hb / S * 0.55, sz: range(rnd, 0.8, 1), sides: 5, oblique: 2, topTilt: 0.06, topCut: [0.82, 0.94], bottom: 0.9, sideCut: [0.58, 0.74], noise: 0.08 }), new V3(0, lo - 0.3 * S + hb * 0.5, 0), S, { yaw: rnd() * TAU, tint: tint() });
      // a low ledge slab jutting out at the foot on one side, a thinner one higher on the other
      const lh = S * range(rnd, 0.3, 0.42);
      placeRock(b, rockShape(rnd, { sx: 1.3, sy: lh / (S * 0.75) * 0.6, sz: 0.9, sides: 5, oblique: 1, topTilt: 0.04, topCut: [0.84, 0.95], bottom: 0.9, sideCut: [0.58, 0.74], noise: 0.07 }), new V3(Math.cos(ha) * S * 0.55, lo - 0.25 * S + lh * 0.5, Math.sin(ha) * S * 0.55), S * 0.75, { yaw: rnd() * TAU, tint: tint() });
      if (S > 1.1) { const th = S * 0.24, yy = lo - 0.3 * S + hb * range(rnd, 0.5, 0.75); placeRock(b, rockShape(rnd, { sx: 1.2, sy: th / (S * 0.6) * 0.6, sz: 0.85, sides: 5, oblique: 1, topTilt: 0.03, topCut: [0.84, 0.95], bottom: 0.9, sideCut: [0.6, 0.75], noise: 0.06 }), new V3(-Math.cos(ha) * S * 0.45, yy, -Math.sin(ha) * S * 0.45), S * 0.6, { yaw: rnd() * TAU, tint: tint(), aoLo: 0.7 }); }
      if (!steep && rnd() < 0.6) { const a = rnd() * TAU, dd = S * 1.3; piece(Math.cos(a) * dd, Math.sin(a) * dd, S * range(rnd, 0.35, 0.5), { sx: 1.2, sy: 0.55, sides: 4, oblique: 1, topCut: [0.75, 0.9], topTilt: 0.1 }); }
    }
  } else if (bm === 'desert') {
    if (S > 1.1 && rnd() < 0.5) {            // a table rock: a wide flat slab on a narrower undercut base
      const [lo] = ctx.foot(S);
      const hb = S * range(rnd, 0.5, 0.7);
      placeRock(b, rockShape(rnd, { sx: 0.8, sy: hb / S * 0.7, sz: 0.75, sides: 4, oblique: 1, topCut: [0.85, 0.95], topTilt: 0.05, bottom: 0.9, under: 0.2, noise: 0.1 }), new V3(0, lo - 0.2 * S + hb * 0.5, 0), S * 0.75, { yaw: rnd() * TAU, tint: tint() });
      placeRock(b, rockShape(rnd, { sx: 1.25, sy: 0.32, sz: 1, sides: 5, oblique: 2, topCut: [0.8, 0.92], topTilt: 0.08, bottom: 0.85, under: 0.35, noise: 0.08 }), new V3(range(rnd, -0.1, 0.1) * S, lo - 0.2 * S + hb + 0.1 * S, 0), S * 1.05, { yaw: rnd() * TAU, tint: tint(), aoLo: 0.7 });
    } else {                                  // a wind-scoured tablet, flat-topped and undercut
      piece(0, 0, S * 1.0, { detail: 2, sx: range(rnd, 1.1, 1.4), sy: range(rnd, 0.5, 0.65), sz: 0.9, sides: 5, oblique: 3, topCut: [0.72, 0.86], topTilt: 0.12, sideCut: [0.55, 0.72], under: 0.3, noise: 0.12 });
    }
    if (!steep && rnd() < 0.55) { const a = rnd() * TAU, dd = S * 1.25; piece(Math.cos(a) * dd, Math.sin(a) * dd, S * range(rnd, 0.35, 0.5), { sx: 1.2, sy: 0.5, sides: 3, oblique: 2, topCut: [0.7, 0.85] }); }
  } else if (bm === 'snow') {
    piece(0, 0, S * 1.05, { sx: range(rnd, 1, 1.25), sy: range(rnd, 0.65, 0.85), sides: 3, oblique: 4, topCut: [0.55, 0.75], topTilt: 0.25, noise: 0.14 });
    if (S > 1.0 && rnd() < 0.6 && !steep) {   // a tilted slab leaning beside it
      const a = rnd() * TAU, dd = S * 0.95;
      piece(Math.cos(a) * dd, Math.sin(a) * dd, S * 0.65, { sx: 0.5, sy: 1.25, sz: 1, sides: 2, oblique: 2, topCut: [0.65, 0.8], topTilt: 0.3 }, { tilt: range(rnd, 0.2, 0.4), tiltA: a + Math.PI / 2, lift: S * 0.15 });
    }
    if (!steep && rnd() < 0.5) { const a = rnd() * TAU, dd = S * range(rnd, 1.1, 1.4); piece(Math.cos(a) * dd, Math.sin(a) * dd, S * range(rnd, 0.3, 0.5), { sy: 0.7, sides: 3, oblique: 2 }); }
  } else {                                  // Elwynn / Westfall: chunky boulders, outcrops of tilted slabs
    const fields = bm === 'fields';
    piece(0, 0, S * 1.0, { sx: range(rnd, 1, 1.3), sy: fields ? range(rnd, 0.55, 0.7) : range(rnd, 0.68, 0.85), sz: range(rnd, 0.85, 1.05), sides: 3, oblique: 3, topCut: [0.55, 0.75] });
    if (S > 1.2 && rnd() < 0.65 && !steep) {          // an outcrop: 2-3 tall slabs leaning together
      const a = rnd() * TAU, n = 2 + (rnd() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const aa = a + (k - (n - 1) / 2) * 0.55, dd = S * range(rnd, 0.6, 0.9), x = Math.cos(aa) * dd, z = Math.sin(aa) * dd;
        piece(x, z, S * range(rnd, 0.6, 0.8), { sx: range(rnd, 0.45, 0.6), sy: range(rnd, 1.2, 1.6), sz: 1, sides: 2, oblique: 2, topCut: [0.6, 0.78], topTilt: 0.35 }, { tilt: range(rnd, 0.12, 0.35), tiltA: aa + Math.PI / 2 + range(rnd, -0.4, 0.4), lift: S * 0.25 });
      }
    }
    const extra = steep ? 0 : S > 1.2 ? 2 : (rnd() < 0.5 ? 1 : 0);
    for (let k = 0; k < extra; k++) {
      const a = rnd() * TAU, dd = S * range(rnd, 1.0, 1.35), r = S * range(rnd, 0.3, 0.5);
      piece(Math.cos(a) * dd, Math.sin(a) * dd, r, { sx: range(rnd, 1, 1.3), sy: 0.65, sides: 3, oblique: 2 });
    }
  }
}

// ---- farm & field bits ------------------------------------------------------------------------------

// Split-rail fence: thick weathered posts with chamfered tops, flat split rails that overhang the
// posts and pass in front of or behind them (3 in Westfall, 2 elsewhere).
function fence(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 17)), n = Math.max(2, d.len || 4), west = ctx.biome === 'fields';
  ctx.at(d, d.ry || 0);
  const b = ctx.b('wood');
  const wood = (p, nn) => { const k = (0.6 + 0.4 * smooth(-0.3, 0.6, p.y)) * (0.78 + 0.26 * Math.max(0, nn.y)); return [k, k, k]; };
  const posts = [];
  for (let i = 0; i < n; i++) {
    const z = (i - (n - 1) / 2) * 1.9 + range(rnd, -0.12, 0.12), x = range(rnd, -0.06, 0.06), y = ctx.gh(x, z);
    const lx = range(rnd, -0.07, 0.07), lz = range(rnd, -0.07, 0.07), r = range(rnd, 0.13, 0.15), h = (west ? 1.25 : 1.15) + range(rnd, -0.06, 0.06);
    tube(b, [new V3(x, y - 0.45, z), new V3(x + lx * 0.5, y + h * 0.5, z + lz * 0.5), new V3(x + lx, y + h - 0.1, z + lz), new V3(x + lx, y + h, z + lz), new V3(x + lx, y + h + 0.06, z + lz)],
      [r, r * 0.97, r * 0.93, r * 0.62, 0.035], { sides: 8, uRep: 1, vLen: 1.2, color: wood, a0: rnd(), lobes: (dir, t, i, j) => 1 + 0.06 * Math.sin(j * 2.3 + i * 1.7) });
    posts.push({ x, y, z, lx, lz, r, h });
  }
  const hs = west ? [0.35, 0.7, 1.05] : [0.45, 0.92];
  const flat = (dir) => { const hz = Math.hypot(dir.x, dir.z), v = dir.y; return 1 / Math.sqrt((hz / 1.25) ** 2 + (v / 0.78) ** 2); };
  for (let i = 0; i < n - 1; i++) {
    const A = posts[i], Bp = posts[i + 1];
    hs.forEach((h, row) => {
      if (rnd() < 0.06) return;
      const side = ((i + row) % 2 ? 1 : -1), r = range(rnd, 0.08, 0.09);
      const ox = side * (A.r + r * 0.9);
      const ha = h + range(rnd, -0.04, 0.04), hb = h + range(rnd, -0.04, 0.04);
      const ov = range(rnd, 0.2, 0.3);
      const pa = new V3(A.x + A.lx * ha / A.h + ox, A.y + ha, A.z - ov), pb = new V3(Bp.x + Bp.lx * hb / Bp.h + ox, Bp.y + hb, Bp.z + ov);
      if (rnd() < 0.05) pb.set(Bp.x + 0.25, ctx.gh(Bp.x + 0.25, Bp.z - 0.2) + 0.08, Bp.z - 0.2);   // a fallen rail
      const mid = pa.clone().lerp(pb, 0.5); mid.y -= 0.03; mid.x += range(rnd, -0.025, 0.025);
      tube(b, [pa, pa.clone().lerp(mid, 0.5), mid, mid.clone().lerp(pb, 0.5), pb], [r, r * 1.04, r * 1.06, r, r * 0.92], { sides: 6, uRep: 1, vLen: 1.6, color: wood, cap: 0.3, lobes: (dir, t, ii, j) => flat(dir) * (1 + 0.05 * Math.sin(j * 3.1 + ii)) });
    });
  }
}

// straw tufts: alpha cards round a base (haystacks, bales, the scarecrow)
function strawRing(ctx, C, R, n, rnd, { h = [0.28, 0.42], up = 0, cells = [0, 1], color = WHITE, outward = 0.5 } = {}) {
  const st = ctx.b('straw');
  for (let k = 0; k < n; k++) {
    const a = k / n * TAU + range(rnd, -0.25, 0.25), c = Math.cos(a), s = Math.sin(a);
    const B = new V3(C.x + c * R, C.y + up, C.z + s * R);
    const ht = range(rnd, h[0], h[1]), w = ht * range(rnd, 0.9, 1.3);
    const cell = inset(cellOf(pick(rnd, cells)));
    card(st, B, w, ht, new V3(c, 0, s), cell, typeof color === 'function' ? color : (cc) => mulc(color, cc > 0 ? 1.05 : 0.7), { lean: -outward * range(rnd, 0.5, 1.1), wind: 0.25 });
  }
}

// Westfall: round bales (twine, spiral ends, a straw fringe at the rims) and domed haystacks with
// a sagging waist, a ragged straw skirt and a topknot.
function haybale(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 18));
  ctx.at(d, d.ry || 0);
  const hay = ctx.b('hay');
  const stack = d.variant != null ? d.variant === 1 : rnd() < 0.4;
  if (!stack) {
    const [lo] = ctx.foot(0.7);
    const y0 = lo + 0.66, xs = [-0.6, -0.57, -0.45, 0, 0.45, 0.57, 0.6], rs = [0.56, 0.67, 0.72, 0.73, 0.72, 0.67, 0.56];
    const ao = p => { const k = 0.55 + 0.5 * smooth(y0 - 0.75, y0 + 0.6, p.y); return [k * (p.y > y0 + 0.4 ? 1.06 : 1), k, k * 0.95]; };
    tube(hay, xs.map(x => new V3(x, y0, 0)), rs, { sides: 16, uRep: 3, vLen: 0.6, color: ao, lobes: (dir, t, i, j) => 1 + 0.025 * Math.sin(j * 2.7 + i) });
    const he = ctx.b('hay_end');
    for (const sd of [-1, 1]) disc(he, new V3(0.6 * sd, y0, 0), new V3(sd, 0, 0), 0.57, 18, (c, sn) => [0.5 + c * 0.47, 0.5 + sn * 0.47 * sd], [0.92, 0.9, 0.86]);
    const tw = lin('#7a5e38');
    for (const tx of [-0.24, 0.24]) {
      const loop = []; for (let k = 0; k <= 18; k++) { const a = k / 18 * TAU; loop.push(new V3(tx + Math.sin(a * 2) * 0.01, y0 + Math.cos(a) * 0.74, Math.sin(a) * 0.74)); }
      tube(hay, loop, loop.map(() => 0.025), { sides: 5, uRep: 1, vLen: 0.3, color: tw, uvMap: (u, v) => [u * 0.05, v * 0.05] });
    }
    // straw fringe round both rims
    const st = ctx.b('straw');
    for (const sd of [-1, 1]) for (let k = 0; k < 12; k++) {
      const a = k / 12 * TAU + range(rnd, -0.2, 0.2), cy = Math.cos(a), cz = Math.sin(a);
      const B = new V3(0.55 * sd, y0 + cy * 0.62, cz * 0.62);
      if (B.y < ctx.gh(B.x, B.z) + 0.05) continue;
      const nrmv = new V3(sd * 0.7, cy * 0.7, cz * 0.7);
      card(st, B, 0.34, 0.24, nrmv, inset(cellOf(2)), (c) => mulc(WHITE, c > 0 ? 1 : 0.75), { lean: -1.1, wind: 0.2 });
    }
  } else {
    const [lo] = ctx.foot(0.95);
    const g0 = lo, ys = [-0.25, 0.12, 0.45, 0.8, 1.0, 1.3, 1.62, 1.9, 2.05, 2.1], rs = [0.92, 0.98, 1.02, 0.94, 0.9, 0.78, 0.55, 0.3, 0.12, 0.02];
    const sA = rnd() * 9;
    const dampC = [0.62, 0.5, 0.34], sunC = [1.12, 1.06, 0.92];
    const col = p => { const t = smooth(g0 + 0.05, g0 + 1.8, p.y); return mixc(dampC, sunC, t); };
    tube(hay, ys.map(y => new V3(0, g0 + y, 0)), rs, { sides: 16, uRep: 3, vLen: 0.7, color: col, lobes: (dir, t, i, j) => 1 + 0.09 * Math.sin(j * 1.3 + sA) * Math.sin(i * 1.1 + sA) + 0.04 * Math.sin(j * 3.7 + i * 2.1) });
    strawRing(ctx, new V3(0, g0, 0), 0.96, 14, rnd, { h: [0.3, 0.45], up: -0.04, color: [0.8, 0.7, 0.5], outward: 0.6 });
    strawRing(ctx, new V3(0, g0, 0), 0.9, 10, rnd, { h: [0.25, 0.35], up: 0.82, cells: [2], color: [0.95, 0.88, 0.7], outward: 0.9 });
    strawRing(ctx, new V3(0, g0, 0), 0.15, 5, rnd, { h: [0.3, 0.42], up: 1.95, color: [1.1, 1.05, 0.9], outward: 0.3 });
    if (rnd() < 0.35) {
      const wb = ctx.b('wood'), ib = ctx.b('iron'), a = rnd() * TAU, c = Math.cos(a), s = Math.sin(a);
      const p0 = new V3(c * 0.5, g0 + 1.05, s * 0.5), p1 = new V3(c * 1.2, g0 + 2.45, s * 1.2);
      tube(wb, [p0, p1], [0.03, 0.026], { sides: 6, uRep: 1, vLen: 1.2 });
      for (const o of [-0.07, 0, 0.07]) tube(ib, [p0.clone().add(new V3(-s * o, 0, c * o)), new V3(c * 0.22 - s * o, g0 + 0.75, s * 0.22 + c * o)], [0.013, 0.008], { sides: 4, uRep: 1, vLen: 0.5 });
    }
  }
}

// region of the scarecrow atlas: [u0, v0, u1, v1]
const SC = { head: [0, 0.5, 1, 1], shirt: [0, 0.25, 0.5, 0.5], hat: [0.5, 0.25, 1, 0.5], rope: [0, 0, 0.25, 0.25], pants: [0.25, 0, 0.5, 0.25], straw: [0.5, 0, 1, 0.25] };
// u wraps round a tube; the closing column (u = 1) stays at the region's far edge
const region = (r, wrapU = true) => (u, v) => {
  const fu = u - Math.floor(u), uu = wrapU ? ((fu === 0 && u > 0) ? 1 : fu) : clamp01(u);
  return [r[0] + uu * (r[2] - r[0]) * 0.98 + 0.002, r[1] + clamp01(v) * (r[3] - r[1]) * 0.96 + 0.004];
};
const len = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += pts[i].distanceTo(pts[i - 1]); return L; };

// A Westfall scarecrow: a leaning cross-post, a stuffed plaid shirt with straw at the cuffs, neck and
// waist, two straw-stuffed trouser legs hanging off it, a big burlap head with a lopsided sewn face,
// and a felt hat with a wide drooping brim.
function scarecrow(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 19));
  const lean = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(range(rnd, -0.12, 0.12), 0, range(rnd, 0.07, 0.13) * (rnd() < 0.5 ? -1 : 1)));
  ctx.at(d, d.ry || 0, lean);
  const wb = ctx.b('wood'), sc = ctx.b('scarecrow');
  const g0 = ctx.gh(0, 0);
  const P = (x, y, z) => new V3(x, g0 + y, z);
  tube(wb, [P(0, -0.5, 0), P(0.02, 1.0, 0), P(0.03, 2.25, 0)], [0.085, 0.08, 0.07], { sides: 7, uRep: 1, vLen: 1.2, color: barkAO(-0.2, 0.8, 0.6), cap: true });
  tube(wb, [P(-0.95, 1.66, -0.04), P(0, 1.7, -0.04), P(0.95, 1.64, -0.04)], [0.06, 0.065, 0.06], { sides: 7, uRep: 1, vLen: 1.2, cap: true });
  const part = (pts, rad, reg, o = {}) => tube(sc, pts, rad, { sides: o.sides || 9, uRep: 1, vLen: len(pts), uvMap: region(SC[reg]), cap: o.cap, color: o.color || WHITE, lobes: o.lobes });
  const lumpy = (a = 0.06) => (dir, t, i, j) => 1 + a * Math.sin(j * 2.3 + i * 1.7);
  // shirt: a stuffed, lumpy torso
  part([P(0, 0.92, 0.06), P(0, 1.02, 0.08), P(0, 1.35, 0.09), P(0, 1.68, 0.08), P(0, 1.8, 0.06)], [0.27, 0.31, 0.33, 0.3, 0.1], 'shirt', { lobes: lumpy(0.07) });
  part([P(0, 1.03, 0.08), P(0, 1.06, 0.08)], [0.33, 0.33], 'rope', { sides: 9 });
  for (const sd of [-1, 1]) {
    // sleeves along the cross-bar, a bit saggy
    part([P(sd * 0.14, 1.66, 0.04), P(sd * 0.45, 1.6, 0.02), P(sd * 0.8, 1.58, 0.0)], [0.13, 0.12, 0.11], 'shirt', { lobes: lumpy(0.08) });
    // trouser legs hanging from the waist
    const lx = sd * 0.13;
    part([P(lx, 1.0, 0.09), P(lx * 1.1, 0.7, 0.1 + sd * 0.01), P(lx * 1.2, 0.42, 0.12)], [0.12, 0.11, 0.1], 'pants', { lobes: lumpy(0.06) });
  }
  // straw at the cuffs, the trouser ends, the waist and the neck
  const strawC = (c) => mulc(WHITE, c > 0 ? 1.05 : 0.75);
  const st = ctx.b('straw');
  for (const sd of [-1, 1]) {
    for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + rnd(); card(st, P(sd * 0.86, 1.58 + Math.sin(a) * 0.05, Math.cos(a) * 0.05), 0.22, 0.2, new V3(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3 + 1).normalize(), inset(cellOf(pick(rnd, [0, 1]))), strawC, { lean: sd * 1.3 * (k % 2 ? 1 : -1) * 0.5, wind: 0.3 }); }
    for (let k = 0; k < 3; k++) { const a = k / 3 * TAU + rnd(); card(st, P(sd * 0.155 + Math.cos(a) * 0.04, 0.48, 0.12 + Math.sin(a) * 0.04), 0.2, -0.22, new V3(Math.cos(a), 0, Math.sin(a)), inset(cellOf(pick(rnd, [0, 1]))), strawC, { wind: 0.3 }); }
  }
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + rnd() * 0.5; card(st, P(Math.cos(a) * 0.28, 0.96, 0.08 + Math.sin(a) * 0.28), 0.2, -0.16, new V3(Math.cos(a), 0, Math.sin(a)), inset(cellOf(2)), strawC, { lean: 0.4, wind: 0.2 }); }
  for (let k = 0; k < 5; k++) { const a = k / 5 * TAU + rnd() * 0.5; card(st, P(Math.cos(a) * 0.1, 1.76, 0.07 + Math.sin(a) * 0.1), 0.18, 0.16, new V3(Math.cos(a), 0, Math.sin(a)), inset(cellOf(pick(rnd, [0, 1]))), strawC, { lean: -0.5, wind: 0.2 }); }
  // burlap head, cocked to one side; the face is at u = 0.5, which faces +z
  const hc = P(0.04, 2.12, 0.08), hr = 0.3, hp = [], hrad = [];
  for (let k = 0; k <= 8; k++) { const th = 0.1 * Math.PI + k / 8 * 0.84 * Math.PI; hp.push(new V3(hc.x + Math.sin(k / 8 * 2) * 0.03, hc.y - Math.cos(th) * hr * 1.1, hc.z)); hrad.push(Math.sin(th) * hr * (1 + 0.05 * Math.sin(k * 1.7))); }
  part(hp, hrad, 'head', { sides: 14, cap: true });
  // floppy felt hat with a wide drooping brim
  const yb = hc.y + 0.2, hx = hc.x + 0.03, hz = hc.z - 0.02;
  const brimD = range(rnd, 0.06, 0.1);
  const hat = [[0.2, -0.05], [0.5, -0.02 - brimD], [0.49, 0.0 - brimD], [0.24, 0.035], [0.21, 0.26], [0.15, 0.3], [0.02, 0.31]];
  part(hat.map(([r, y], i) => new V3(hx + i * 0.008, yb + y, hz)), hat.map(([r]) => r), 'hat', { sides: 14, lobes: (dir, t, i, j) => i <= 2 ? 1 + 0.07 * Math.sin(j * 1.5) : 1 });
}

// ---- desert & badlands ------------------------------------------------------------------------------

// Cacti: chunky ribbed saguaros with thick arms in smooth elbows (Tanaris, with prickly pears at the
// foot and blossoms on top); in the Badlands an organ-pipe cactus: a clump of columns from one base,
// dusty olive-purple.
function cactus(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 20)), B = ctx.bio, h = d.h || 2.4;
  ctx.at(d, d.ry || 0);
  const cb = ctx.b('cactus');
  const tint = lin(pick(rnd, B.cactusTints || ['#ffffff']));
  const [g0] = ctx.foot(0.3);
  const col = p => { const k = 0.6 + 0.4 * smooth(g0 - 0.2, g0 + 1.0, p.y); return mulc(tint, k); };
  const ribs = (amt) => (dir, t, i, j) => 1 + amt * Math.cos(j * Math.PI);    // even sides are crests, odd are grooves
  const capCol = p => mixc(col(p), mulc(tint, 1.18), smooth(0.65, 1, (p.y - g0) / h));
  const pads = (cx, cz, n0) => {
    const pads = [];
    const pad = (C, w, hgt, yaw, roll, depth) => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll);
      sphereish(cb, 1, u => {
        const x = u.x * w, y = u.y * hgt, z = u.z * 0.09;
        const x2 = x * cr - y * sr, y2 = x * sr + y * cr;
        return new V3(C.x + x2 * cy - z * sy, C.y + y2, C.z + x2 * sy + z * cy);
      }, { uv: u => [0.02 + u.x * 0.08, 0.5 + u.y * 0.45], color: col });
      pads.push([C, w, hgt, yaw, roll, depth]);
    };
    for (let k = 0; k < n0; k++) {
      const yaw = rnd() * Math.PI, roll = range(rnd, -0.35, 0.35), w = range(rnd, 0.28, 0.36), hg = w * range(rnd, 1.15, 1.35);
      const x = cx + range(rnd, -0.3, 0.3), z = cz + range(rnd, -0.3, 0.3);
      pad(new V3(x, ctx.gh(x, z) + hg * 0.75, z), w, hg, yaw, roll, 0);
    }
    for (let it = 0; it < 6 && pads.length < 8; it++) {
      const [C, w, hg, yaw, roll, depth] = pick(rnd, pads);
      if (depth > 1) continue;
      const a = roll + range(rnd, -0.8, 0.8), w2 = w * range(rnd, 0.75, 0.95), h2 = w2 * range(rnd, 1.1, 1.3);
      const tx = -Math.sin(a) * (hg + h2 * 0.7), ty = Math.cos(a) * (hg + h2 * 0.7);
      pad(new V3(C.x + tx * Math.cos(yaw), C.y + ty, C.z + tx * Math.sin(yaw)), w2, h2, yaw + range(rnd, -0.6, 0.6), a, depth + 1);
    }
    const bone = ctx.b('bone'), fruit = lin('#b8406a');
    for (const [C, w, hg, yaw, roll] of pads) {
      if (rnd() < 0.45) continue;
      for (let k = 0; k < 2; k++) {
        const a = roll + range(rnd, -0.6, 0.6), fx = -Math.sin(a) * hg, fy = Math.cos(a) * hg;
        const F = new V3(C.x + fx * Math.cos(yaw), C.y + fy, C.z + fx * Math.sin(yaw));
        sphereish(bone, 1, u => new V3(F.x + u.x * 0.05, F.y + u.y * 0.07, F.z + u.z * 0.05), { color: (p, n) => mulc(fruit, 0.75 + 0.45 * clamp01(n.y * 0.6 - n.x * 0.4 + 0.3)) });
      }
    }
  };
  if (d.variant === 'pear') { pads(0, 0, 2 + Math.floor(rnd() * 2)); return; }
  if (ctx.biome === 'badlands' && d.variant !== 'saguaro') {
    // organ pipe: the central column fills the collider, the rest rise round it from one base
    const n = 5 + Math.floor(rnd() * 4), R0 = range(rnd, 0.2, 0.24);
    for (let k = 0; k < n; k++) {
      const main = k === 0, a = rnd() * TAU, off = main ? 0 : range(rnd, 0.22, 0.42), hk = main ? h : h * range(rnd, 0.45, 0.85), R = main ? R0 : R0 * range(rnd, 0.6, 0.8);
      const c = Math.cos(a), s = Math.sin(a);
      const pts = main ? [new V3(0, g0 - 0.3, 0), new V3(0, g0 + 0.3, 0), new V3(0.03, g0 + hk * 0.5, 0), new V3(0.05, g0 + hk - R * 0.6, 0), new V3(0.05, g0 + hk - R * 0.15, 0), new V3(0.05, g0 + hk + 0.02, 0)]
        : [new V3(c * 0.05, g0 - 0.2, s * 0.05), new V3(c * off * 0.6, g0 + 0.15, s * off * 0.6), new V3(c * off, g0 + 0.45, s * off), new V3(c * off * 1.08, g0 + hk * 0.6, s * off * 1.08), new V3(c * off * 1.1, g0 + hk - R * 0.5, s * off * 1.1), new V3(c * off * 1.1, g0 + hk, s * off * 1.1)];
      tube(cb, pts, [R * 1.05, R, R * 1.02, R * 0.98, R * 0.75, R * 0.15], { sides: 14, uRep: 1.75, vLen: 1.6, lobes: ribs(0.15), color: capCol });
    }
    return;
  }
  // saguaro: 8 ribs (16 sides, the lobes alternate), a domed top and thick up-turned arms
  const R = range(rnd, 0.24, 0.27);
  const ys = [-0.3, 0.3, h * 0.5, h - R * 1.1, h - R * 0.55, h - R * 0.18, h + 0.02];
  const rs = [R * 0.94, R, R * 1.05, R * 0.98, R * 0.86, R * 0.55, R * 0.12];
  tube(cb, ys.map(y => new V3(0, g0 + y, 0)), rs, { sides: 16, uRep: 2, vLen: 1.6, lobes: ribs(0.16), color: capCol });
  const nA = h > 2.5 ? 1 + (rnd() < 0.6 ? 1 : 0) : (rnd() < 0.6 ? 1 : 0);
  let phi = rnd() * TAU;
  const tops = [new V3(0, g0 + h, 0)];
  for (let k = 0; k < nA; k++) {
    phi += k ? Math.PI + range(rnd, -0.6, 0.6) : 0;
    const c = Math.cos(phi), sn = Math.sin(phi), ya = g0 + h * range(rnd, 0.3, 0.5), ra = R * 0.75, L = range(rnd, 0.5, 1.0), rr = range(rnd, 0.28, 0.36);
    const at = (o, y) => new V3(c * o, y, sn * o);
    // out from the trunk, a smooth quarter-circle elbow, then straight up
    const ctrl = [at(R * 0.2, ya - rr * 0.1)];
    for (let i = 0; i <= 6; i++) { const a = i / 6 * Math.PI / 2; ctrl.push(at(R + 0.05 + rr * Math.sin(a), ya + rr * (1 - Math.cos(a)))); }
    const xe = R + 0.05 + rr;
    ctrl.push(at(xe, ya + rr + L * 0.5), at(xe, ya + rr + L - ra * 0.5), at(xe, ya + rr + L - ra * 0.1), at(xe, ya + rr + L + 0.02));
    const rad = ctrl.map((_, i) => i < ctrl.length - 3 ? ra : [ra * 0.85, ra * 0.5, ra * 0.1][i - (ctrl.length - 3)]);
    tube(cb, ctrl, rad, { sides: 12, uRep: 1.5, vLen: 1.6, lobes: ribs(0.14), color: capCol });
    tops.push(at(xe, ya + rr + L));
  }
  if (ctx.biome === 'desert') {
    const bone = ctx.b('bone');
    if (rnd() < 0.55) {
      const fc = lin(pick(rnd, ['#f8f0e8', '#f8e0a0', '#f0b0c8']));
      for (const T of tops) { if (rnd() < 0.4) continue; for (let k = 0; k < 3; k++) { const a = rnd() * TAU, F = new V3(T.x + Math.cos(a) * R * 0.45, T.y - 0.03, T.z + Math.sin(a) * R * 0.45); sphereish(bone, 1, u => new V3(F.x + u.x * 0.07, F.y + u.y * 0.045, F.z + u.z * 0.07), { color: fc }); } }
    }
    if (rnd() < 0.35) { const a = rnd() * TAU, dd = range(rnd, 0.6, 0.9); pads(Math.cos(a) * dd, Math.sin(a) * dd, 1 + Math.floor(rnd() * 2)); }
  }
}

// The landmark cow skull, built front-first: a broad flat forehead plate with big forward sockets
// under lit brow ridges, a muzzle tapering to a narrow nose with two teardrop nostrils, a row of
// teeth, and long horns in one smooth arc out, up and forward. Local +z is the muzzle.
function skullAt(ctx, C, k) {
  const b = ctx.b('bone');
  const bone = (p, n) => { const lit = clamp01(0.5 + n.y * 0.4 - n.x * 0.15 + n.z * 0.1); return mixc([0.68, 0.64, 0.66], [1.04, 1.0, 0.92], lit); };
  const L = (x, y, z) => new V3(C.x + x * k, C.y + y * k, C.z + z * k);
  // the cranium: a wide plate, flattened in front
  sphereish(b, 2, u => {
    let x = u.x * 0.52, y = u.y * 0.36, z = u.z * 0.34;
    if (z > 0.16) z = 0.16 + (z - 0.16) * 0.25;
    if (y > 0.22) y = 0.22 + (y - 0.22) * 0.6;
    y += 0.06 * Math.exp(-x * x * 30) * (u.y > 0 ? 1 : 0);        // the poll ridge between the horns
    return L(x, y, z);
  }, { color: bone });
  // the muzzle: an elliptical tube from the plate to the nose, dipping a little
  const mz = [], NM = 7;
  for (let i = 0; i <= NM; i++) { const t = i / NM; mz.push(L(0, 0.02 - 0.16 * t * t, -0.02 + t * 1.12)); }
  const wA = [0.4, 0.37, 0.32, 0.27, 0.235, 0.215, 0.205, 0.2], hA = [0.27, 0.25, 0.21, 0.18, 0.15, 0.14, 0.135, 0.13];
  tube(b, mz, mz.map(() => k), { sides: 12, uRep: 1, vLen: 0.8 * k, cap: 0.12, color: bone,
    lobes: (dir, t, i) => { const a = lerpArr(wA, t), hh = lerpArr(hA, t) * (dir.y < 0 ? 0.8 : 1); const hz = Math.hypot(dir.x, dir.z); return 1 / Math.sqrt((hz / a) ** 2 + (dir.y / hh) ** 2); } });
  // sockets: warm dark hollows (never black) facing forward and out, under lit brows
  const rim = lin('#5a4230'), deep = lin('#3a2a20');
  for (const sd of [-1, 1]) {
    const f = new V3(sd * 0.55, 0.08, 0.83).normalize(), sc = new V3(sd * 0.31, 0.06, 0.13);
    sphereish(b, 1, u => { const p = u.clone(); p.addScaledVector(f, -p.dot(f) * 0.55); return L(sc.x + p.x * 0.19, sc.y + p.y * 0.16, sc.z + p.z * 0.19); },
      { color: (p, n) => mixc(rim, deep, clamp01(n.dot(f)) ** 1.5) });
    const brow = [L(sd * 0.1, 0.19, 0.15), L(sd * 0.27, 0.22, 0.18), L(sd * 0.43, 0.19, 0.11), L(sd * 0.49, 0.1, 0.0)];
    tube(b, spline(brow, 3), Array(10).fill(0.05 * k), { sides: 7, uRep: 1, vLen: 0.5 * k, color: bone });
    // nostril
    const nc = new V3(sd * 0.075, -0.06, 1.12), nf = new V3(sd * 0.25, 0.1, 1).normalize();
    sphereish(b, 1, u => { const p = u.clone(); p.addScaledVector(nf, -p.dot(nf) * 0.6); return L(nc.x + p.x * 0.05, nc.y + p.y * 0.08 + Math.max(0, p.y) * 0.03, nc.z + p.z * 0.05); }, { color: (p, n) => mixc(rim, deep, clamp01(n.dot(nf))) });
    // teeth along the upper jaw
    for (let j = 0; j < 4; j++) sphereish(b, 0, u => L(sd * (0.19 - j * 0.012) + u.x * 0.04, -0.17 - j * 0.02 + u.y * 0.05, 0.42 + j * 0.13 + u.z * 0.05), { color: [0.9, 0.86, 0.76] });
    // horns: one smooth arc, tapering to a point, darker at the root
    const hc = [L(sd * 0.3, 0.2, -0.1), L(sd * 0.68, 0.28, -0.12), L(sd * 0.98, 0.38, -0.08), L(sd * 1.2, 0.58, 0.02), L(sd * 1.28, 0.82, 0.15), L(sd * 1.22, 1.02, 0.3)];
    const hp = spline(hc, 3), hb = lin('#8a7458'), ht = lin('#e0d0a8');
    tube(b, hp, hp.map((_, i) => k * lerpArr([0.1, 0.085, 0.068, 0.05, 0.032, 0.008], i / (hp.length - 1))), { sides: 9, uRep: 1, vLen: 0.6 * k, cap: true,
      color: (p, n, t) => mulc(mixc(hb, ht, Math.pow(t, 0.7)), 0.8 + 0.3 * clamp01(n.y * 0.5 + 0.5)) });
  }
}

function skull(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 21));
  const pitch = range(rnd, 0.26, 0.42), roll = range(rnd, -0.12, 0.12);
  ctx.at(d, d.ry || 0, new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, 0, roll)));
  const k = 1.6;
  // the muzzle tip and the back of the cranium rest on the sand
  const [lo] = ctx.foot(1.6);
  const tipY = -0.27 * Math.cos(pitch) - 1.12 * Math.sin(pitch);
  const backY = -0.36 * Math.cos(pitch) + 0.3 * Math.sin(pitch);
  skullAt(ctx, new V3(0, lo - Math.min(tipY, backY) * k - 0.08, 0), k);
}

// A kodo carcass: the spine an arched ridge of knobbed vertebrae, 7-9 pairs of flat ribs hanging
// from it into the sand (largest in the middle, a few broken short), leg bones strewn about.
function bones(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 22)), s = (d.s || 1) * 1.5;
  ctx.at(d, d.ry || 0);
  const b = ctx.b('bone');
  const bone = (p, n) => { const lit = clamp01(0.5 + n.y * 0.45 - n.x * 0.12); return mixc([0.66, 0.62, 0.62], [1.04, 1.0, 0.92], lit); };
  const Ls = range(rnd, 2.4, 3.0) * s, Hs = range(rnd, 0.8, 1.0) * s;
  const nV = 12, sp = [];
  for (let i = 0; i <= nV; i++) {
    const t = i / nV, z = (t - 0.5) * Ls, x = Math.sin(t * 2.2 + 1) * 0.12 * s;
    sp.push(new V3(x, ctx.gh(x, z) - 0.12 + Hs * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.08)), 0.75), z));
  }
  tube(b, sp, sp.map(() => 0.06 * s), { sides: 7, uRep: 1, vLen: 0.6, color: bone });
  for (let i = 1; i < nV; i++) {
    const p = sp[i], r = 0.095 * s;
    sphereish(b, 0, u => new V3(p.x + u.x * r * 1.1, p.y + u.y * r * 0.9, p.z + u.z * r * 0.8), { color: bone });
    if (i > 1 && i < nV - 1) tube(b, [p.clone(), new V3(p.x, p.y + 0.2 * s, p.z - 0.04 * s)], [0.035 * s, 0.012 * s], { sides: 5, uRep: 1, vLen: 0.5, cap: true, color: bone });
  }
  const nRib = 7 + Math.floor(rnd() * 3), broken = new Set();
  for (let k = 0; k < 2 + Math.floor(rnd() * 2); k++) broken.add(Math.floor(rnd() * nRib * 2));
  for (let i = 0; i < nRib; i++) {
    const t = 0.24 + i / (nRib - 1) * 0.5, f = t * nV, j = Math.min(nV - 1, Math.floor(f)), V = sp[j].clone().lerp(sp[j + 1], f - j);
    const W = (0.55 + 0.45 * Math.sin(Math.PI * (t - 0.24) / 0.5)) * 0.75 * s;
    for (const sd of [-1, 1]) {
      const id = i * 2 + (sd > 0 ? 1 : 0), cut = broken.has(id) ? range(rnd, 0.45, 0.7) : 1;
      const gy = ctx.gh(V.x + sd * W, V.z);
      const pts = [];
      for (let q = 0; q <= 8; q++) {
        const u = q / 8 * cut, a = u * Math.PI * 0.62;
        const x = V.x + sd * W * Math.sin(a) / Math.sin(Math.PI * 0.62) * (1 + 0.05 * Math.sin(u * 5));
        const y = V.y - (V.y - gy + 0.18) * (1 - Math.cos(a)) / (1 - Math.cos(Math.PI * 0.62));
        pts.push(new V3(x, y, V.z + 0.06 * s * u));
      }
      const flat = (dir) => 1 / Math.sqrt((dir.z / 1.5) ** 2 + (dir.x * dir.x + dir.y * dir.y) / 0.5);
      tube(b, pts, pts.map((_, q) => (0.042 - q * 0.002) * s), { sides: 6, uRep: 1, vLen: 0.6, color: bone, cap: cut < 1 ? 0.8 : false, lobes: flat });
    }
  }
  // long bones lying about
  for (let k = 0; k < 2 + (rnd() < 0.5 ? 1 : 0); k++) {
    const a = rnd() * TAU, x = range(rnd, -1.2, 1.2) * s, z = range(rnd, -1.3, 1.3) * s, L = range(rnd, 0.5, 0.8) * s;
    const x1 = x + Math.cos(a) * L, z1 = z + Math.sin(a) * L;
    const p0 = new V3(x, ctx.gh(x, z) + 0.04, z), p1 = new V3(x1, ctx.gh(x1, z1) + 0.04, z1);
    tube(b, [p0, p0.clone().lerp(p1, 0.12), p0.clone().lerp(p1, 0.5), p0.clone().lerp(p1, 0.88), p1], [0.075, 0.042, 0.034, 0.042, 0.075].map(r => r * s), { sides: 7, uRep: 1, vLen: 0.6, cap: true, color: bone });
  }
  if (rnd() < 0.6) {
    const e = sp[nV], kk = 0.38 * s;
    const pitch = 0.45;
    ctx.at({ x: d.x, y: d.y, z: d.z }, d.ry || 0, new THREE.Matrix4().makeTranslation(e.x + 0.1 * s, 0, e.z + 0.45 * s).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, 0.4, 0))));
    skullAt(ctx, new V3(0, ctx.gh(e.x, e.z + 0.45 * s) + 0.32 * kk, 0), kk);
  }
}

function deadTreeDecor(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 23));
  ctx.at(d, d.ry || 0);
  deadTree(ctx, d.s || 1, rnd, { r0: 0.25 });
}

// ---- campfire ---------------------------------------------------------------------------------------

function campfire(ctx, d, fires) {
  const rnd = rngOf(seedOf(d.x, d.z, 24));
  ctx.at(d, 0);
  const rk = ctx.b('firestone'), lg = ctx.b('bark_dead');
  // a ring of sooty stones, warm bounce light on their inward faces
  const nS = 10;
  for (let i = 0; i < nS; i++) {
    const a = i / nS * TAU + range(rnd, -0.1, 0.1), r = range(rnd, 0.68, 0.76), x = Math.cos(a) * r, z = Math.sin(a) * r;
    const R = range(rnd, 0.18, 0.25), sh = rockShape(rnd, { sx: range(rnd, 1, 1.3), sy: 0.7, sides: 3, oblique: 2, detail: 1 });
    const C = new V3(x, ctx.gh(x, z) + R * 0.12, z);
    const m = new THREE.Matrix4().makeRotationY(rnd() * TAU);
    const P = sh.P.map(p => p.clone().multiplyScalar(R).applyMatrix4(m).add(C));
    const inw = new V3(-x, 0, -z).normalize();
    creased(rk, P, sh.idx, (p, n) => { const k = clamp01(n.dot(inw)), y = smooth(C.y - R * 0.3, C.y + R * 0.5, p.y); return [0.4 + 0.22 * y + 0.16 * k, 0.38 + 0.2 * y + 0.07 * k, 0.37 + 0.19 * y + 0.01 * k]; });
  }
  // crossed logs, charred toward the middle, with glowing ends
  const cb = ctx.b('coals');
  const charred = (p, n, t) => { const k = 0.18 + 0.34 * clamp01(1 - t * 1.3); return [k, k * 0.95, k * 0.9]; };
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + 0.4 + range(rnd, -0.2, 0.2), r = 0.62, rr = range(rnd, 0.11, 0.13);
    const p0 = new V3(Math.cos(a) * r, ctx.gh(Math.cos(a) * r, Math.sin(a) * r) + 0.08, Math.sin(a) * r), p1 = new V3(Math.cos(a) * 0.08, 0.42, Math.sin(a) * 0.08);
    tube(lg, [p0, p0.clone().lerp(p1, 0.5), p1], [rr, rr * 0.95, rr * 0.8], { sides: 8, uRep: 1, vLen: 0.8, color: charred });
    const dir = new V3().subVectors(p1, p0).normalize();
    disc(cb, p1.clone().addScaledVector(dir, 0.005), dir, rr * 0.8, 8, (c, sn) => [0.5 + c * 0.08, 0.5 + sn * 0.08]);
  }
  const g0 = ctx.gh(0, 0);
  disc(cb, new V3(0, g0 + 0.05, 0), UP, 0.62, 16, (c, sn) => [0.5 + c * 0.48, 0.5 + sn * 0.48]);
  // flames: 3 crossed cards and one that faces the camera; a smoke wisp above
  const fb = ctx.b('flame'), ph = rnd() * 10;
  const quad = (a, w, h, phase, bill) => {
    const f = new V3(-Math.sin(a), 0, Math.cos(a)), r = new V3(Math.cos(a), 0, Math.sin(a)), base = fb.n;
    const C = new V3(0, g0 + 0.04, 0);
    [[-1, 0], [1, 0], [1, 1], [-1, 1]].forEach(([x, y], k) => {
      const off = new V3().addScaledVector(r, x * w / 2).add(new V3(0, y * h, 0));
      fb.v(C.clone().add(off), f, [0, 1, 1, 0][k], y, WHITE, phase, bill ? [C, off, f] : null);
    });
    fb.t(base, base + 1, base + 2); fb.t(base, base + 2, base + 3);
  };
  for (let k = 0; k < 3; k++) quad(k * Math.PI / 3 + 0.3, 1.15, range(rnd, 1.5, 1.8), ph + k * 1.7, false);
  quad(0, 1.0, 1.65, ph + 5.3, true);
  const sm = ctx.b('smoke');
  const sc = new V3(0, g0 + 1.3, 0), soff = [[-1, 0], [1, 0], [1, 1], [-1, 1]], base = sm.n;
  soff.forEach(([x, y], k) => { const off = new V3(x * 0.7, y * 2.4, 0); sm.v(sc.clone().add(off), new V3(0, 0, 1), [0, 1, 1, 0][k], y, WHITE, ph, [sc, off, new V3(0, 0, 1)]); });
  sm.t(base, base + 1, base + 2); sm.t(base, base + 2, base + 3);
  const light = new THREE.PointLight(0xff9a3c, 14, 16, 1.6);
  light.position.set(d.x, d.y + g0 + 1.2, d.z);
  fires.push({ x: d.x, y: d.y + g0, z: d.z, light, ph, base: 14 });
}

// ---- assembly ---------------------------------------------------------------------------------------

const billVert = `
  attribute vec3 aCtr; attribute vec4 aOff; uniform vec3 uCam;
  vec3 natBill(vec3 p) {
    if (aOff.x == 0.0 && aOff.y == 0.0 && aOff.z == 0.0) return p;
    vec3 toC = uCam - aCtr; float dYaw = atan(toC.x, toC.z) - aOff.w; float cy = cos(dYaw), sy = sin(dYaw);
    return aCtr + vec3(cy * aOff.x + sy * aOff.z, aOff.y, -sy * aOff.x + cy * aOff.z);
  }`;
let flameMat = null, coalMat = null, sparkMat = null, smokeMat = null;
function fxMats() {
  if (flameMat) return;
  flameMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex('flame') }, uTime: U_TIME, uCam: U_CAM },
    vertexShader: `attribute float aWind; varying vec2 vUv; varying float vPh; uniform float uTime; ${billVert}
      void main() {
        vUv = uv; vPh = aWind; vec3 p = natBill(position); float h = uv.y;
        p.x += sin(uTime * 6.0 + aWind * 7.0 + h * 2.5) * 0.07 * h;
        p.z += cos(uTime * 5.1 + aWind * 3.0) * 0.06 * h;
        p.y += sin(uTime * 9.0 + aWind) * 0.06 * h;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `uniform sampler2D map; uniform float uTime; varying vec2 vUv; varying float vPh;
      vec4 frame(float f) { f = mod(f, 4.0); vec2 o = vec2(mod(f, 2.0), 1.0 - floor(f / 2.0)) * 0.5; return texture2D(map, o + clamp(vUv, 0.02, 0.98) * 0.5); }
      void main() {
        float t = uTime * 8.0 + vPh * 5.3, k = fract(t);
        vec4 c = mix(frame(floor(t)), frame(floor(t) + 1.0), k);
        gl_FragColor = vec4(c.rgb * c.a * 1.25, 1.0);
        #include <colorspace_fragment>
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false,
  });
  smokeMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex('smoke') }, uTime: U_TIME, uCam: U_CAM },
    vertexShader: `attribute float aWind; varying vec2 vUv; varying float vPh; uniform float uTime; ${billVert}
      void main() {
        vUv = uv; vPh = aWind; vec3 p = natBill(position);
        p.x += sin(uTime * 0.7 + aWind + uv.y * 2.0) * 0.25 * uv.y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `uniform sampler2D map; uniform float uTime; varying vec2 vUv; varying float vPh;
      void main() {
        vec2 uv = vec2(vUv.x, fract(vUv.y * 0.8 - uTime * 0.12 + vPh));
        vec4 c = texture2D(map, uv) * 0.6 + texture2D(map, vec2(1.0 - vUv.x, fract(vUv.y * 0.6 - uTime * 0.07 + vPh * 1.7))) * 0.6;
        float fade = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.55, 1.0, vUv.y));
        gl_FragColor = vec4(c.rgb, c.a * fade * 0.8);
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
  coalMat = new THREE.MeshBasicMaterial({ map: tex('coals'), color: 0xffffff });
  sparkMat = new THREE.PointsMaterial({ map: tex('spark'), size: 0.09, color: 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
}

// tomorrow's nature textures, painted one at a time in idle slots while the night lasts
const prewarmed = new Set();

export function buildNature(W) {
  const group = new THREE.Group();
  group.name = 'nature';
  const fires = [];
  const ctx = new Ctx(W);
  const deco = W.decor || [];
  for (const d of deco) {
    if (!NATURE_KINDS.has(d.k)) continue;
    try {
      switch (d.k) {
        case 'oak': oak(ctx, d); break;
        case 'pine': pine(ctx, d); break;
        case 'palm': palm(ctx, d); break;
        case 'bush': bush(ctx, d); break;
        case 'stump': stump(ctx, d); break;
        case 'rock': rock(ctx, d); break;
        case 'fence': fence(ctx, d); break;
        case 'haybale': haybale(ctx, d); break;
        case 'scarecrow': scarecrow(ctx, d); break;
        case 'cactus': cactus(ctx, d); break;
        case 'deadtree': deadTreeDecor(ctx, d); break;
        case 'bones': bones(ctx, d); break;
        case 'skull': skull(ctx, d); break;
        case 'fire': campfire(ctx, d, fires); break;
        default: break;   // flowers & wheat are ground clutter (terrain3d)
      }
    } catch (e) { console.warn('nature: failed to build', d.k, e); }
  }
  // winch anchors: a dead tree with an iron strap where the hook goes
  for (const c of W.cyls || []) {
    if (c.mat !== 'deadtree') continue;
    const a = (W.anchors || []).find(a => Math.abs(a.x - c.x) < 0.6 && Math.abs(a.z - c.z) < 0.6);
    const g = c.y - c.hh;
    ctx.at({ x: c.x, y: g, z: c.z }, (c.x * 7 + c.z * 3) % TAU);
    try { deadTree(ctx, 1, rngOf(seedOf(c.x, c.z, 25)), { r0: c.r, ring: a ? a.y - g : 1.1 }); } catch (e) { console.warn('nature: anchor', e); }
  }
  fxMats();
  for (const [k, b] of ctx.batches) {
    if (!b.n) continue;
    const key = b.key;
    let m;
    if (key === 'flame') { m = b.build(flameMat); m.renderOrder = 5; m.frustumCulled = false; m.onBeforeRender = camHook; }
    else if (key === 'smoke') { m = b.build(smokeMat); m.renderOrder = 6; m.frustumCulled = false; m.onBeforeRender = camHook; }
    else if (key === 'coals') { m = b.build(coalMat); m.receiveShadow = true; }
    else {
      const mat = matFor(key, ctx.biome);
      m = b.build(mat); m.castShadow = true; m.receiveShadow = true;
      if (mat.userData.depth) m.customDepthMaterial = mat.userData.depth;
      if (b.bill) m.onBeforeRender = camHook;
    }
    m.name = 'nature:' + k;
    group.add(m);
  }
  for (const n of texturesFor(ctx.biome)) prewarmed.add(n[0]);
  // embers drifting up from every fire (a seeded generator per fire: deterministic)
  let sparks = null, stE = null, posE = null, gE = null;
  if (fires.length) {
    const N = 16;
    posE = new Float32Array(fires.length * N * 3); stE = [];
    fires.forEach((f, fi) => {
      let sd = (seedOf(f.x, f.z, 26) | 1) >>> 0;
      f.rng = () => { sd = (Math.imul(sd, 1664525) + 1013904223) >>> 0; return sd / 4294967296; };
      for (let i = 0; i < N; i++) stE.push({ f, i, age: (i / N) * 1.6, life: 1.2 + (i % 5) * 0.15, vx: Math.sin(i * 2.1 + fi) * 0.25, vz: Math.cos(i * 1.7 + fi) * 0.25 });
    });
    gE = new THREE.BufferGeometry();
    gE.setAttribute('position', new THREE.BufferAttribute(posE, 3));
    sparks = new THREE.Points(gE, sparkMat);
    sparks.frustumCulled = false;
    group.add(sparks);
    for (const f of fires) group.add(f.light);
  }
  const updSparks = () => {
    for (let i = 0; i < stE.length; i++) {
      const p = stE[i], t = p.age;
      posE[i * 3] = p.f.x + p.vx * t + Math.sin(t * 5 + i) * 0.06;
      posE[i * 3 + 1] = p.f.y + 0.3 + t * 1.3;
      posE[i * 3 + 2] = p.f.z + p.vz * t + Math.cos(t * 4 + i) * 0.06;
    }
    gE.attributes.position.needsUpdate = true;
  };
  if (sparks) updSparks();
  // tomorrow's textures
  const next = BIOME_BY_DAY[W.day] || null;
  let queue = next && next !== ctx.biome ? texturesFor(next).filter(([n]) => !prewarmed.has(n)) : [], idleAt = 0;
  return {
    group, fires,
    update(dt, t, camPos) {
      U_TIME.value = t;
      if (camPos) U_CAM.value.copy(camPos);
      for (const f of fires) {
        const k = 1 + Math.sin(t * 13 + f.ph) * 0.08 + Math.sin(t * 7.3 + f.ph * 2) * 0.06 + Math.sin(t * 23.7 + f.ph) * 0.03;
        f.light.intensity = f.base * k;
      }
      if (coalMat) coalMat.color.setScalar(0.85 + 0.15 * Math.sin(t * 4.3) * Math.sin(t * 2.9 + 1));
      if (sparks) {
        for (const p of stE) { p.age += dt; if (p.age > p.life) { p.age -= p.life; p.vx = (p.f.rng() - 0.5) * 0.5; p.vz = (p.f.rng() - 0.5) * 0.5; } }
        updSparks();
      }
      if (queue.length && atmo.night > 0.6 && t > idleAt && typeof requestIdleCallback === 'function') {
        idleAt = t + 1.5;
        requestIdleCallback(() => {
          const it = queue.shift(); if (!it || prewarmed.has(it[0])) return;
          try { if (it[1]) alphaTex(it[0], ...(GRID[it[0]] || [2, 2])); else canvasFor(it[0]); } catch {}
          prewarmed.add(it[0]);
        }, { timeout: 4000 });
      }
    },
  };
}

// ---- previews (tools/preview.mjs) ---------------------------------------------------------------------

const fakeW = (biome, decor, extra = {}) => ({ biome, decor, cyls: extra.cyls || [], anchors: extra.anchors || [], heightAt: () => 0 });
const pv = (k, extra = {}, w = {}) => ({ biome = 'meadow' } = {}) => {
  const n = buildNature(fakeW(biome, [{ k, x: 0, y: 0, z: 0, ry: 0.4, s: 1, ...extra }], w));
  n.update(0.016, 1.3);
  return n.group;
};
export const PREVIEW = {
  oak: pv('oak'), oak_big: pv('oak', { s: 1.3, x: 3.1 }), pine: pv('pine'), pine_small: pv('pine', { s: 0.8, x: 1.7 }), palm: pv('palm'),
  bush: pv('bush'), stump: pv('stump'), haybale: pv('haybale', { variant: 0 }), haystack: pv('haybale', { variant: 1 }),
  scarecrow: pv('scarecrow', { ry: 0.3 }), fence: pv('fence', { len: 5, ry: 1.2 }), bones: pv('bones'),
  cactus: pv('cactus', { h: 3.2 }), cactus_small: pv('cactus', { h: 2.0, variant: 'saguaro', x: 2.3 }), prickly: pv('cactus', { h: 1.9, variant: 'pear' }),
  rock: pv('rock', { s: 1.0 }), outcrop: pv('rock', { s: 1.8, x: 4.2 }), rock2: pv('rock', { s: 1.5, x: 7.7 }), rock3: pv('rock', { s: 1.9, x: 11.3 }), rock4: pv('rock', { s: 1.3, x: -5.1 }), skull: pv('skull', { ry: 0.6 }),
  deadtree: pv('deadtree', { s: 1.1 }),
  anchor: ({ biome = 'meadow' } = {}) => buildNature(fakeW(biome, [], { cyls: [{ x: 0, y: 1.6, z: 0, r: 0.3, hh: 1.6, mat: 'deadtree' }], anchors: [{ id: 0, x: 0, y: 1.1, z: 0 }] })).group,
  campfire: pv('fire'),
};
