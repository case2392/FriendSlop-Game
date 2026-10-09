// Nature: trees, bushes, rocks, cacti, haybales, fences, bones, campfires, cairns: every W.decor entry
// of a natural kind, plus the dead-tree winch anchors and the tree lines along the valley rims.
//
// The look is WoW Classic: chunky low-poly silhouettes (Elwynn groves round a huge hero oak: massive
// warm boles on flared roots, gnarled limbs into wide domed crowns of big leaf lobes with ragged hanging
// skirts; Westfall's the same oak, smaller, a round lumpy olive-gold ball; stacked drooping pine tiers;
// Badlands hoodoos lofted as one eroded column under a caprock; Badlands ledges as little stepped
// buttes (tiers 5-12% smaller, set toward one side, undercut, uneven in height, under a broken caprock)
// and Tanaris mounds as layered rock (strataRock: the day's hard beds jut as lit lips over undercuts at
// the same world heights the painted strata use, joints as soft cool wedges, a stepped skyline, a bank
// of the ground's own dust or sand round the foot that fades into the terrain); Tanaris slab arches on
// blocky stepped legs; the wall-foot rocks of Dun Morogh and Tanaris as big blocks of the walls' own
// rock lodged at the wall's toe, snowed on or drifted with sand), smooth shading, and the detail
// painted into textures (paint/nature.js). A canopy lobe is a ring of alpha
// leaf-cluster cards round one big camera-facing core card, all with normals pointing out of the lobe, so
// it lights like a volume: warm on top, cool underneath, and a leafy ceiling under it; the cards turn to
// face the camera (about the vertical, and pitched toward a camera that looks up from under a crown, so
// no card is ever an edge-on spike; in the shadow pass too, so shadows match what you see). Vertex
// colours carry baked AO and per-tree tint. A small shader hook adds wind
// sway, triplanar mapping for rocks (so strata run level in world space), the frosted-underside trick
// for Dun Morogh pine boughs, and a world-space "top cover" that lays moss, lichen, snow, dust or sand on
// up-facing surfaces (or where a per-vertex amount says so: the moss at the foot of an oak).
//
// Colliders: every solid thing keeps to the collider world gen gave it (tree boles, cacti, haybales, the
// solid rocks: see rockCol; boulders are fitted slice by slice to their cylinders, tops included; a
// ledge's walls follow its oriented box), checked by the "audit" preview (tools/preview.mjs audit x.png
// <biome>): per kind, the worst gap and overhang at 0.3-1.5 m and how far the collider's top stands off
// the rock's.
//
// Performance: everything static is built in world space and merged per (material, 600 m stretch of
// road, the camp sharing the first), so a whole leg of decor costs a few dozen draw calls however many
// trees there are; the rim tree
// lines are one shadowless mesh per material for the whole leg.
// API: buildNature(W) -> { group, fires, update(dt, t, camPos) }, NATURE_KINDS, PREVIEW.
import { THREE, tex } from './gfx.js';
import { canvasFor } from './paint/index.js';
import { mergeVertices } from '/vendor/BufferGeometryUtils.js';
import { atmo } from './atmosphere.js';
import { fbm } from '/shared/rng.js';
import { BIOME_BY_DAY, generateLeg } from '/shared/world.js';
import * as TERRAIN from './terrain3d.js';
import { STRATA_BEDS } from './paint/nature.js';

export const NATURE_KINDS = new Set(['oak', 'pine', 'palm', 'bush', 'flowers', 'stump', 'fence', 'haybale', 'wheat', 'scarecrow', 'cactus', 'deadtree', 'rock', 'bones', 'skull', 'fire', 'cairn']);

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const UP = new V3(0, 1, 0), XAX = new V3(1, 0, 0);
const CHUNK = 600;

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
// pulled in by a fraction of the cell, so the coarse mips never sample the neighbouring cell
const inset = (c, m = 0.025) => { const w = (c[2] - c[0]) * m, h = (c[3] - c[1]) * m; return [c[0] + w, c[1] + h, c[2] - w, c[3] - h]; };

// ---- the batch: merged world-space geometry for one material --------------------------------------

const _p = new V3(), _n = new V3(), _c = new V3(), _o = new V3(), _f = new V3();
class Batch {
  constructor(key) {
    this.key = key; this.P = []; this.N = []; this.UV = []; this.C = []; this.WD = []; this.CV = []; this.BC = []; this.BO = []; this.BT = []; this.I = [];
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
      this.BT.push(Math.asin(Math.max(-1, Math.min(1, _f.y / (_f.length() || 1)))));     // the card's own pitch
    } else { this.BC.push(_p.x, _p.y, _p.z); this.BO.push(0, 0, 0, 0); this.BT.push(0); }
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
      g.setAttribute('aTilt', new THREE.Float32BufferAttribute(this.BT, 1));
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
  // rounded domes: two shrinking rings, then the tip (cap = dome height in radii); cap0 closes the start
  const dome = (ch, ri, sgn) => {
    const Tn = T[ri].clone().multiplyScalar(sgn), rl = Math.max(0.004, radii[ri]), ring = R[ri], ctr = pts[ri];
    let prev = base + ri * (S + 1);
    const flip = sgn < 0;
    for (const th of (o.domeRings || [0.6, 1.1])) {
      const rb = b.n;
      for (let j = 0; j <= S; j++) {
        const jj = j % S, rv = new V3().subVectors(ring[jj], ctr);
        const p = new V3().copy(ctr).addScaledVector(rv, Math.cos(th)).addScaledVector(Tn, rl * ch * Math.sin(th));
        const nn = new V3().copy(rv).normalize().multiplyScalar(Math.cos(th)).addScaledVector(Tn, Math.sin(th)).normalize();
        let u = j / S * uRep + twist * (VV[ri] - v0), v = VV[ri] + sgn * rl * ch * Math.sin(th) / vLen;
        if (uvMap) [u, v] = uvMap(u, v, sgn > 0 ? 1 : 0);
        b.v(p, nn, u, v, typeof color === 'function' ? color(p, nn, sgn > 0 ? 1 : 0) : color, typeof wind === 'function' ? wind(p, sgn > 0 ? 1 : 0) : wind);
      }
      for (let j = 0; j < S; j++) { const a = prev + j, c = rb + j; if (!flip) { b.t(a, a + 1, c); b.t(a + 1, c + 1, c); } else { b.t(a, c, a + 1); b.t(a + 1, c, c + 1); } }
      prev = rb;
    }
    const tip = new V3().copy(ctr).addScaledVector(Tn, rl * ch);
    let u = 0.5 * uRep, v = VV[ri] + sgn * rl * ch / vLen;
    if (uvMap) [u, v] = uvMap(u, v, sgn > 0 ? 1 : 0);
    const ap = b.v(tip, Tn, u, v, typeof color === 'function' ? color(tip, Tn, sgn > 0 ? 1 : 0) : color, typeof wind === 'function' ? wind(tip, sgn > 0 ? 1 : 0) : wind);
    for (let j = 0; j < S; j++) { if (!flip) b.t(prev + j, prev + j + 1, ap); else b.t(prev + j, ap, prev + j + 1); }
  };
  if (cap) dome(cap === true ? 0.5 : cap, n - 1, 1);
  if (o.cap0) dome(o.cap0, 0, -1);
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
function creased(b, P, idx, color, FD = faceData(P, idx), cosC = COS_CREASE) {
  const { FN, FA, VF } = FD, n = new V3();
  for (let f = 0; f < FN.length; f++) {
    if (FA[f] < 1e-9) continue;
    const base = b.n;
    for (let k = 0; k < 3; k++) {
      const vi = idx[f * 3 + k];
      n.set(0, 0, 0);
      for (const g of VF[vi]) if (FA[g] > 1e-9 && FN[g].dot(FN[f]) > cosC) n.addScaledVector(FN[g], FA[g]);
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
  snowRock: { tex: 'cover_snow', lo: 0.7, hi: 0.86, noise: 0.6, scale: 0.35, gate: [0.2, 0.4] },
  dust: { tex: 'cover_dust', lo: 0.72, hi: 0.95, noise: 1.0, scale: 0.35 },
  sand: { tex: 'cover_sand', lo: 0.45, hi: 0.76, noise: 1.0, scale: 0.3 },
};

// Alpha atlases go up as a DataTexture: transparent texels take the colour of the leaves next to
// them (no dark fringes in the mips), and each mip's alpha is rescaled so the alpha-tested coverage
// of every region stays the same at a distance (canopies don't go thin and see-through far away).
const ATEX = new Map();
const ALPHA_CUT = 0.45;          // the cards' alpha test (alpha-to-coverage smooths it when MSAA is on)
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
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (d[(y * lw + x) * 4 + 3] * k > ALPHA_CUT * 255) c++; n++; }
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
    // a transparent ring round every atlas cell at every level: bilinear taps at a card's edge never
    // pick up the next cell's leaves (or snow) as a bright seam
    const cwl = nw / cols, chl = nh / rows;
    if (cwl >= 4 && chl >= 4) {
      for (let y = 0; y < nh; y++) { const ly = y % chl; for (let x = 0; x < nw; x++) { const lx = x % cwl; if (lx < 1 || ly < 1 || lx >= cwl - 1 || ly >= chl - 1) out[(y * nw + x) * 4 + 3] = 0; } }
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
// about the vertical toward the camera, keeping their authored tilt, and pitched toward a camera that
// looks up at them from under a crown, so no card is ever seen edge-on as a dark spike) and wind sway.
const vertDecl = o => `attribute float aWind; attribute float aCov; ${o.bill ? 'attribute vec3 aCtr; attribute vec4 aOff; attribute float aTilt;' : ''} uniform float uTime; uniform vec3 uCam;`;
const vertBody = o => `
  ${o.bill ? `{
    vec3 toC = uCam - aCtr; float dYaw = atan(toC.x, toC.z) - aOff.w; float cy = cos(dYaw), sy = sin(dYaw);
    vec3 bo = vec3(cy * aOff.x + sy * aOff.z, aOff.y, -sy * aOff.x + cy * aOff.z);
    // the pitch: from below, the card's elevation eases most of the way to the camera's (a little from
    // high above too); turned about the horizontal axis across the view
    float hz = length(toC.xz) + 1e-4, el = atan(toC.y, hz);
    float wP = smoothstep(0.08, 0.85, -el) * 0.85 + smoothstep(0.35, 1.2, el) * 0.45;
    float th = (el - aTilt) * wP;
    vec3 ax = vec3(-toC.z / hz, 0.0, toC.x / hz);
    bo = bo * cos(th) + cross(ax, bo) * sin(th) + ax * dot(ax, bo) * (1.0 - cos(th));
    if (aTilt < -0.8) bo *= 1.0 - smoothstep(-0.02, 0.15, el);     // a crown's underside: only seen from below
    transformed = aCtr + bo;
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
    alphaTest: o.alpha ? ALPHA_CUT : 0,
    // fade: the opacity comes from aCov (a bank of ground that melts into the terrain round it)
    transparent: !!o.fade, depthWrite: !o.fade,
  });
  if (o.fade) { m.polygonOffset = true; m.polygonOffsetFactor = -2; m.polygonOffsetUnits = -2; }
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
        vec3 tw = pow(abs(normalize(vNatN)), vec3(${o.topScale ? '8.0' : '4.0'})); tw /= (tw.x + tw.y + tw.z);
        vec4 tx = texture2D(map, vNatW.zy * uTri), ty = texture2D(map, vNatW.xz * uTri * ${o.topScale ?? '1.0'} + 0.37), tz = texture2D(map, vNatW.xy * uTri);
        diffuseColor *= tx * tw.x + ty * tw.y + tz * tw.z;
      }`);
    else if (o.fade) fs = fs.replace('#include <map_fragment>', `#include <map_fragment>
      diffuseColor.a *= clamp(vNatCov, 0.0, 1.0);`);
    else if (o.backShift) fs = fs.replace('#include <map_fragment>', `
      {
        // a bough's underside shows the bare needles, still frosted (about 40% of the snowy cell)
        vec4 tf = texture2D(map, vMapUv);
        if (!gl_FrontFacing) tf = mix(texture2D(map, vMapUv + vec2(${o.backShift.toFixed(4)}, 0.0)), tf, ${(o.backMix ?? 0.42).toFixed(3)});
        diffuseColor *= tf;
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
    leaves: 'leaves_autumn', oakTints: ['#ffffff', '#fff6e0', '#f6efd8', '#fffae8', '#f0f0d4'], leafDensity: 0.82, west: true,
    pineTints: ['#f4f0d0', '#ece8c8'],
    bush: 'leaves', bushCells: [3], bushFill: 2, bushTints: ['#ffffff', '#fff6e0', '#f4f0d8'],
    deadTint: '#d0c4b0', oakTrunk: '#fff6e4',
  },
  snow: {
    rock: 'cliff_snow', rockCover: 'snowRock', rockTints: ['#ffffff', '#f2f4f8', '#e8ecf4'], snowCaps: true,
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
    rock: 'rock_sand', rockCover: 'sand', rockTints: ['#f8e8d6', '#f2e0cc', '#fbeee0'], strata: true,
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
    case 'rock': return natMat(B.rock, { tri: true, cover: B.rockCover || null, triScale: TRI_T[biome] || 2.6, topScale: B.strata ? '0.3' : '1.0' });   // strata seen from above: broad soft blotches, never contour lines
    case 'apron': return natMat(biome === 'desert' ? 'ground_desert' : biome === 'badlands' ? 'ground_badlands' : biome === 'snow' ? 'ground_snow' : 'ground_meadow', { fade: true });
    case 'firestone': return natMat('rock_gray', { tri: true, triScale: 0.9 });
    case 'snowcap': return natMat('snow_pack', { tri: true, triScale: 3.2 });
    case 'snowridge': return natMat('snow_pack', { tri: true, triScale: 3.2, wind: true });
    case 'cactus': return biome === 'badlands' ? natMat('cactus_dusty', { cover: 'dust', covAttr: true }) : natMat('cactus_skin', {});
    case 'hay': return natMat('hay', {});
    case 'hay_end': return natMat('hay_end', {});
    case 'bone': return natMat('bone_bleached', { cover: snow ? 'snow' : null });
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
  if (biome === 'snow') out.push(['bark_pine'], ['needles_snow', true], ['snow_pack'], ['cover_snow'], ['ground_snow']);
  if (biome === 'badlands' || biome === 'desert') out.push(['leaves_scrub', true], [biome === 'badlands' ? 'cactus_dusty' : 'cactus_skin'], ['bone_bleached'], ['cover_dust']);
  if (biome === 'desert') out.push(['bark_palm'], ['palm_frond', true], ['cover_sand'], ['ground_desert']);
  if (biome === 'badlands') out.push(['ground_badlands']);
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
    this.chunk = Math.floor((d.z + 3300) / CHUNK);      // (stretches break at 300, 900, 1500 m: the camp shares the first)
  }
  b(key) {
    const k = key + '#' + (this.rim ? 'rim' : this.chunk);
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

// A leaf clump: leaf-cluster cards whose normals point out of the clump (so it lights like a ball of
// leaves: warm on top, cool and darker underneath), round one big camera-facing core card that fills
// the middle with a leafy edge (no solid inner mesh, so no polygon edge ever shows). The cards turn
// about the vertical to face the camera; their tilt is kept within ±35°, so none goes edge-on.
function clump(b, C, R, rnd, o) {
  const sq = o.squash ?? 0.8, tint0 = o.tint || WHITE, ao = o.ao || (() => 1), grid = o.grid || [2, 2];
  const warm = o.warm || null, tintAt = p => (warm ? mul3(tint0, warm(p)) : tint0);
  const rhoR = o.rho || [0.25, 0.8];
  const e1 = new V3(), up = new V3(), fn = new V3();
  const quad = (P, dir, face, sz, cellI, rho, tilt = null, rot = 0) => {
    fn.copy(face);
    if (tilt != null) fn.y = tilt;
    // keep the card within ±35° of vertical; the ones under the lobe (o.down) tip further, face down
    // and out, so from under the tree they are seen face-on, never as edge-on spikes
    const fyLo = o.down && dir.y < -0.12 ? -0.55 - (o.down - 0.55) * smooth(-0.12, -0.6, dir.y) : -0.55;
    const h = Math.hypot(fn.x, fn.z) || 1e-3, fy = Math.max(fyLo, Math.min(0.6, (o.down && dir.y < -0.12 ? Math.min(fn.y, -0.3) : fn.y) / Math.max(1e-3, fn.length())));
    const hs = Math.sqrt(1 - fy * fy) / h; fn.set(fn.x * hs, fy, fn.z * hs);
    if (Math.hypot(fn.x, fn.z) < 0.05) fn.set(0.8, fy, 0.3);
    fn.normalize();
    up.copy(UP).addScaledVector(fn, -fn.y).normalize();
    e1.crossVectors(up, fn).normalize();
    const hw = sz / 2, cell = inset(cellOf(cellI, ...grid));
    const us = [cell[0], cell[2], cell[2], cell[0]], vs = [cell[1], cell[1], cell[3], cell[3]];
    const vb = b.n, side = 0.7 + 0.3 * (dir.y + 1) / 2, cr = Math.cos(rot), sr = Math.sin(rot);
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, c], k) => {
      const ox = (a * cr - c * sr) * hw, oy = (a * sr + c * cr) * hw;
      const off = new V3().addScaledVector(e1, ox).addScaledVector(up, oy);
      const p = new V3().copy(P).add(off);
      const q = new V3(P.x + off.x * 0.5, P.y + oy, P.z + off.z * 0.5);
      const nn = new V3().subVectors(q, C).normalize().multiplyScalar(0.55).addScaledVector(dir, 0.45).add(new V3(0, 0.12, 0)).normalize();
      b.v(p, nn, us[k], vs[k], mulc(tintAt(q), ao(q) * side * (0.86 + 0.14 * rho)), (o.wind ?? 1) * (c > 0 ? 1 : 0.7), [P, off, fn.clone()]);
    });
    b.t(vb, vb + 1, vb + 2); b.t(vb, vb + 2, vb + 3);
  };
  // the core: one big card at the middle, a touch behind and below centre
  if (o.core != null) quad(new V3(C.x, C.y - R * 0.05 * sq, C.z), new V3(0, 0.25, 0), new V3(0.2, 0.15, 1).normalize(), R * (o.coreK ?? 1.55), o.core, 0.3, 0.05, range(rnd, -0.3, 0.3));
  const nC = o.cards, gold = 2.39996, sv = o.sizeVar || [0.85, 1.15];
  for (let i = 0; i < nC; i++) {
    const yy = 1 - (i + 0.5) / nC * (o.span ?? 1.5);
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy)), ph = i * gold + range(rnd, -0.4, 0.4);
    const dir = new V3(Math.cos(ph) * rr, yy, Math.sin(ph) * rr).normalize();
    const rho = range(rnd, rhoR[0], rhoR[1]);
    const P = new V3(C.x + dir.x * R * rho, C.y + dir.y * R * rho * sq * (dir.y < 0 ? (o.under ?? 0.8) : 1), C.z + dir.z * R * rho);
    const d2 = dir.clone().add(randDir(rnd).multiplyScalar(o.jit ?? 0.42));
    const cellI = typeof o.cellFn === 'function' ? o.cellFn(dir) : pick(rnd, o.cells);
    quad(P, dir, d2, o.size * range(rnd, sv[0], sv[1]), cellI, rho, null, range(rnd, -0.35, 0.35));
  }
}

// The underside of a lobe: a shallow upturned bowl of big near-horizontal cards of the dense core cell
// under its lower third (one in the middle, a ring round it tipped down and out), static, so from
// under the tree the crown closes into a leafy ceiling with a scalloped edge instead of sky seen past
// edge-on cards. Shaded as the lower flank of the lobe (normals out and only a little down) and kept
// fairly light: a leafy volume from below, never a black hole.
function ceiling(b, C, R, rnd, o) {
  const sq = o.squash ?? 0.8, grid = o.grid || [2, 2], cell = inset(cellOf(o.cell ?? 2, ...grid));
  const us = [cell[0], cell[2], cell[2], cell[0]], vs = [cell[1], cell[1], cell[3], cell[3]];
  const tint = o.tint || WHITE, lift = o.light ?? 0.82;
  const e1 = new V3(), e2 = new V3(), nrm = new V3();
  const put = (P, out, tip, sz, rot, k) => {
    // the card's plane: facing down, tipped out by `tip`
    nrm.set(out.x * Math.sin(tip), -Math.cos(tip), out.z * Math.sin(tip)).normalize();
    e1.crossVectors(nrm, Math.abs(nrm.y) > 0.99 ? XAX : UP).normalize();
    e2.crossVectors(nrm, e1).normalize();
    const cr = Math.cos(rot), sr = Math.sin(rot), hw = sz / 2, base = b.n;
    const sn = new V3(out.x * 0.8, -0.32, out.z * 0.8).normalize();
    [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, c], q) => {
      const x = (a * cr - c * sr) * hw, y = (a * sr + c * cr) * hw;
      const p = new V3().copy(P).addScaledVector(e1, x).addScaledVector(e2, y);
      // a little lighter toward the bowl's rim (it catches the sky)
      const rimK = clamp01(Math.hypot(p.x - C.x, p.z - C.z) / R);
      // (a card of the camera-facing kind whose own pitch, steeply down, marks it: the vertex hook
      // folds it away whenever the camera is above it, so it never shows edge-on from a hilltop)
      b.v(p, sn, us[q], vs[q], mulc(tint, k * (0.92 + 0.12 * rimK)), (o.wind ?? 0.5) * (0.4 + 0.6 * rimK), [P, new V3().subVectors(p, P), nrm.clone()]);
    });
    b.t(base, base + 1, base + 2); b.t(base, base + 2, base + 3);
  };
  const yC = C.y - R * sq * (o.depth ?? 0.5);
  const a0 = rnd() * TAU, n = o.n ?? 4;
  // (kept inside the lobe's own cards, so from the side they never stick out as flat slabs)
  put(new V3(C.x, yC - R * 0.04, C.z), new V3(Math.cos(a0), 0, Math.sin(a0)), 0.2, R * 0.95, rnd() * TAU, lift * 0.96);
  for (let k = 0; k < n; k++) {
    const a = a0 + (k + range(rnd, -0.2, 0.2)) * TAU / n, out = new V3(Math.cos(a), 0, Math.sin(a)), rr = R * range(rnd, 0.26, 0.34);
    put(new V3(C.x + out.x * rr, yC + R * sq * range(rnd, 0.12, 0.2), C.z + out.z * rr), out, range(rnd, 0.5, 0.7), R * range(rnd, 0.72, 0.82), rnd() * TAU, lift);
  }
}

// ---- trees -----------------------------------------------------------------------------------------

const barkAO = (y0 = 0, y1 = 1.8, lo = 0.5, tint = WHITE) => p => { const k = lo + (1 - lo) * smooth(y0, y1, p.y); return mulc(tint, k); };

// The flare round a trunk foot: soft overlapping bumps toward each root (a soft union, so between
// two roots the trunk dips gently, never to a sharp cookie-cutter notch).
function flare(rootA, width = 0.62) {
  return ph => { let q = 1; for (const ra of rootA) q *= 1 - Math.exp(-((angDiff(ph, ra) / width) ** 2)); return 1 - q; };
}
// Roots that grip the ground: thick convex tubes from inside the trunk out and down into the ground,
// tapering only to about a third and ending in a rounded cap.
function roots(ctx, b, rootA, r0, s, rnd, { len = [1.1, 1.7], rad = 0.3, up = 0.85, sides = 7, color = barkAO(-0.3, 1.2, 0.5), dive = false } = {}) {
  for (const ra of rootA) {
    const dx = Math.cos(ra), dz = Math.sin(ra), L = range(rnd, len[0], len[1]) * s;
    // dive: the root arches out of the bole as a tall ridge and dives into the ground, tapering almost
    // to nothing (it never ends in a blunt stub on the grass); otherwise a stout gripping root
    const steps = dive ? [[0, up], [0.3, up * 0.5], [0.58, 0.16], [0.82, -0.04], [1.0, -0.3]] : [[0, up], [0.28, up * 0.5], [0.58, 0.14], [0.84, -0.02], [1.04, -0.22]];
    const pts = steps.map(([f, yy]) => {
      const x = dx * (r0 * 0.3 + f * L) + range(rnd, -0.05, 0.05) * s, z = dz * (r0 * 0.3 + f * L) + range(rnd, -0.05, 0.05) * s;
      return new V3(x, ctx.gh(x, z) + yy * s, z);
    });
    const R = rad * s;
    tube(b, pts, dive ? [R * 1.15, R * 0.84, R * 0.55, R * 0.33, R * 0.16] : [R * 1.12, R * 0.86, R * 0.64, R * 0.48, R * 0.36], { sides, uRep: 1, vLen: 1.4, color, cap: dive ? 0.6 : 1,
      lobes: dive ? (dir) => (1 + 0.32 * Math.max(0, dir.y)) * (1 - 0.18 * Math.abs(dir.y < 0 ? dir.y : 0)) : (dir) => (1 + 0.18 * Math.max(0, dir.y)) * (1 - 0.12 * Math.max(0, -dir.y)) });
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

// Oak sizes. G scales the whole tree; the grove's hero (d.hero, else the grove's biggest) is 1.8-2.2x,
// the rest of the grove 1.2-1.4x the old oak; Westfall's are the Elwynn build at about two thirds of a
// hero (G 0.95-1.25). Rc is the crown's radius.
function oakSize(d, hero, west) {
  const s = d.s || 1;
  const G = west ? Math.max(0.95, Math.min(1.25, 1.05 * s)) : hero ? Math.max(1.8, Math.min(2.2, 1.5 + 0.5 * s)) : Math.max(1.0, Math.min(1.5, 1.25 * s));
  return { G, Rc: (hero ? 3.5 : west ? 3.3 : 3.2) * G };
}

// Elwynn oak: a massive warm bole that keeps to its collider through the bumper band (≤ 0.1 m off
// its axis below 2 m), with 5-6 flared roots, swelling above into a fork at 4-6 m on a hero; 3-4
// heavy gnarled limbs spread out and up, each into one big lobe of the crown, smaller branches into
// small edge lobes and a leader into the top lobe. The crown is a wide dome of 5-8 lobes (3:1 in
// size), each a ball of leaf cards round a dense core, with a ragged skirt of hanging leaf cards
// under its outer rim, and a leafy ceiling under every lobe (so from under the tree the crown is a
// closed, lit leafy volume, not sky past edge-on cards). Crowding: a tree leans its crown away from
// close neighbours and shrinks the lobes that face them, so a grove reads as one canopy without walls
// of cards through each other. The bole's flare follows the ground round it and dives straight in,
// and its roots taper into the turf (no flat skirt on the grass). Westfall's is the same oak, smaller,
// on a shorter bole with a round, lumpy ball of a crown in olive-gold with rust highlights.
function oak(ctx, d, info = {}) {
  const rnd = rngOf(seedOf(d.x, d.z, 11)), B = ctx.bio, west = !!B.west;
  const hero = !west && !!info.hero;
  const { G, Rc: Rc0 } = oakSize(d, hero, west);
  ctx.at(d, 0);                                              // world axes: neighbours need no turning
  const bark = ctx.b('bark_oak'), leaves = ctx.b('leaves');
  const rC = Math.max(0.3, (info.rCol || 0.48 * (d.s || 1)) * 0.97);   // the bole through the bumper band = the collider
  // crowding: away from the neighbours whose crowns reach into ours
  const nb = (info.nb || []).map(n => {
    const dx = n.x - d.x, dz = n.z - d.z, dist = Math.max(0.5, Math.hypot(dx, dz));
    const w = clamp01((Rc0 + n.Rc * 0.85 - dist) / (Rc0 + n.Rc * 0.85)) * (n.hero && !hero ? 1.5 : hero && !n.hero ? 0.6 : 1);
    return { ux: dx / dist, uz: dz / dist, w, dist };
  }).filter(n => n.w > 0);
  let shx = 0, shz = 0;
  for (const n of nb) { shx -= n.ux * n.w; shz -= n.uz * n.w; }
  const shl = Math.hypot(shx, shz), shk = Math.min(0.42, shl * 0.35) / Math.max(1e-6, shl);
  const Rc = Rc0 * (1 - 0.12 * Math.min(1, shl));
  const cO = { x: shx * shk * Rc, z: shz * shk * Rc };         // the crown's centre, off the trunk axis
  const crowd = (ux, uz) => { let c = 0; for (const n of nb) c += n.w * Math.max(0, ux * n.ux + uz * n.uz); return Math.min(1, c); };

  const F = (west ? range(rnd, 1.6, 1.85) : hero ? range(rnd, 2.25, 2.6) : range(rnd, 2.35, 2.75)) * G;   // the fork
  const [gLo] = ctx.foot(rC * 2.4);
  const yBot = Math.min(-0.5, gLo - 0.35);
  const nR = 5 + (rnd() < 0.5 ? 1 : 0), a0 = rnd() * TAU;
  const rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.3, 0.3));
  const fl = flare(rootA, 0.58);
  // the lean: a touch one way low down, then toward the crown's centre above the bumper band
  const la = rnd() * TAU, lean0 = 0.08;
  const toC = Math.hypot(cO.x, cO.z), leanTop = Math.min(0.55 * G, toC * 0.6 + 0.25 * G);
  const lx = toC > 0.05 ? cO.x / toC : Math.cos(la), lz = toC > 0.05 ? cO.z / toC : Math.sin(la);
  const leanAt = y => smooth(1.9, F + 0.4, y);
  const NT = hero ? 16 : 13, ph0 = rnd() * TAU;
  const rTop = rC * (hero ? 1.45 : west ? 1.28 : 1.32);
  const hF = 0.7 + 0.22 * G;                                   // the root flare's height
  // the ground round the foot, by angle: the flare swells down to the ground line there and goes
  // straight on down below it (the bole dives into the turf, never spreads a flat skirt on it)
  const NG = 16, gRing = [];
  for (let k = 0; k < NG; k++) { const a = k / NG * TAU; gRing.push(ctx.gh(Math.cos(a) * rC * 1.6, Math.sin(a) * rC * 1.6)); }
  const gAt = ph => { const f = (((ph / TAU) % 1) + 1) % 1 * NG, k = Math.floor(f), u = f - k; return gRing[k % NG] * (1 - u) + gRing[(k + 1) % NG] * u; };
  const tp = [], tr = [];
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, y = yBot + t * (F + 0.35 * G - yBot), k = clamp01((y + 0.3) / (F + 0.6));
    const Ln = leanTop * leanAt(y), lo = -lean0 * smooth(0, 1.6, y);
    tp.push(new V3(lx * Ln - Math.cos(la) * lo + Math.sin(k * 3 + a0) * 0.04 * G * k, y, lz * Ln - Math.sin(la) * lo - Math.cos(k * 2.6 + a0) * 0.03 * G * k));
    const swell = rC + (rTop - rC) * smooth(1.9, F, y);
    const fork = 1 + 0.16 * Math.exp(-(((y - F) / (0.55 * G)) ** 2));
    tr.push(swell * fork);
  }
  const tcol = lin(B.oakTrunk || '#ffffff');
  const lobes = (dir, t, i) => {
    const y = tp[i].y, ph = Math.atan2(dir.z, dir.x), h = Math.max(0, y - gAt(ph));
    const f = Math.pow(clamp01(1 - (h + 0.04) / hF), 2);
    const twist = 1 + 0.09 * Math.cos(4 * (ph - ph0 - clamp01((y + 0.3) / (F + 0.6)) * 1.3)) * (1 - f);   // ridges that twist up the bole
    return (1 + f * 1.15 * fl(ph)) * twist;
  };
  if (B.barkCover) bark.cf = (p, n) => smooth(0.65 * G, 0.0, p.y - gAt(Math.atan2(p.z, p.x))) * (0.5 + 0.5 * clamp01(-n.x * 0.7 + n.z * 0.7 + 0.1)) * 0.5;   // moss on the shady side of the foot
  tube(bark, tp, tr, { sides: hero ? 14 : 12, uRep: hero ? 3 : 2, vLen: 1.5 * Math.min(1.4, G * 0.75), twist: 0.2, lobes, color: barkAO(-0.3, 1.8, 0.5, tcol) });
  roots(ctx, bark, rootA, rC, Math.max(1, G * 0.6), rnd, { len: [1.0, 1.4], rad: hero ? 0.34 : 0.32, up: hero ? 0.42 : 0.48, color: barkAO(-0.3, 1.8, 0.5, tcol), dive: true });
  if (B.barkCover) bark.cf = (p, n) => 0;

  // ---- the crown's lobes
  const Vc = Rc * (west ? 0.66 : 0.58), yB = F + 0.3 * G, Yc = yB + Vc;      // (Westfall's a taller ball: never a flat-topped acacia)
  const L = [];
  const nRing = hero ? 5 + (rnd() < 0.5 ? 1 : 0) : 4 + (rnd() < (west ? 0.5 : 0.3) ? 1 : 0);
  const ra0 = rnd() * TAU;
  for (let k = 0; k < nRing; k++) {
    const a = ra0 + (k + range(rnd, -0.2, 0.2)) * TAU / nRing, ux = Math.cos(a), uz = Math.sin(a), c = crowd(ux, uz);
    const r = Rc * (west ? range(rnd, 0.5, 0.6) : range(rnd, 0.42, 0.56)) * (1 - 0.35 * c), rho = (Rc - r * 0.95) * (1 - 0.3 * c);
    L.push({ c: new V3(cO.x + ux * rho * (west ? 0.8 : 1), Yc + (west ? range(rnd, -0.7, -0.3) : range(rnd, -0.5, 0.1)) * Vc, cO.z + uz * rho * (west ? 0.8 : 1)), r, ux, uz, ring: true });
  }
  // the top lobe, a little off centre
  L.push({ c: new V3(cO.x + range(rnd, -0.12, 0.12) * Rc, Yc + Vc * range(rnd, 0.32, 0.45), cO.z + range(rnd, -0.12, 0.12) * Rc), r: Rc * (west ? range(rnd, 0.54, 0.6) : range(rnd, 0.5, 0.56)), top: true, ux: 0, uz: 0 });
  // a second upper lobe on the big ones (and every Westfall ball), so the dome isn't one ball
  if (west || hero || rnd() < 0.5) {
    const a = ra0 + range(rnd, 0.3, 0.7) * TAU / nRing, ux = Math.cos(a), uz = Math.sin(a);
    L.push({ c: new V3(cO.x + ux * Rc * 0.42, Yc + Vc * 0.12, cO.z + uz * Rc * 0.42), r: Rc * range(rnd, 0.36, 0.42) * (1 - 0.3 * crowd(ux, uz)), ux, uz, upper: true });
  }
  // small lobes that break the outline (between the ring lobes, a little lower)
  const nSmall = hero ? 2 + (rnd() < 0.5 ? 1 : 0) : 1 + (rnd() < 0.4 ? 1 : 0);
  for (let k = 0; k < nSmall; k++) {
    const a = ra0 + (Math.floor(rnd() * nRing) + 0.5) * TAU / nRing + range(rnd, -0.2, 0.2), ux = Math.cos(a), uz = Math.sin(a), c = crowd(ux, uz);
    if (c > 0.6) continue;
    const r = Rc * range(rnd, 0.17, 0.25), rho = Rc * range(rnd, 0.8, 0.95) * (1 - 0.3 * c);
    L.push({ c: new V3(cO.x + ux * rho, Yc - Vc * range(rnd, 0.2, 0.5), cO.z + uz * rho), r, ux, uz, small: true });
  }

  // ---- limbs: the fork into the ring lobes (the biggest 3-4 get heavy limbs), branches off them into
  // the rest, a leader into the top
  const Fp = tp[NT - 2].clone(), rF = tr[NT - 2];
  const bc = barkAO(0, F + Vc, 0.7, tcol);
  const ring = L.filter(l => l.ring).sort((p, q) => q.r - p.r);
  const nHeavy = Math.min(ring.length, hero ? 4 : 3 + (rnd() < 0.4 ? 1 : 0));
  const heavy = [];
  const gnarl = (P0, P1, bend, n = 5) => {
    const ctrl = [P0.clone()];
    const dir = new V3().subVectors(P1, P0), Ld = dir.length(); dir.normalize();
    const side = new V3(-dir.z, 0, dir.x).normalize();
    for (let i = 1; i < n; i++) {
      const t = i / n, p = P0.clone().lerp(P1, t);
      // limbs rise steeply out of the fork, then level out toward their lobe; a wobble sideways
      p.y += Math.sin(t * Math.PI) * Ld * 0.12 * bend - (1 - t) * t * Ld * 0.1;
      p.addScaledVector(side, Math.sin(t * 5.3 + bend * 7) * Ld * 0.06 * bend);
      ctrl.push(p);
    }
    ctrl.push(P1.clone());
    return spline(ctrl, 3);
  };
  ring.forEach((l, k) => {
    if (k < nHeavy) {
      const a = Math.atan2(l.c.z - Fp.z, l.c.x - Fp.x);
      const P0 = new V3(Fp.x + Math.cos(a) * rF * 0.15, Fp.y - 0.3 * G + range(rnd, -0.2, 0.25) * G * 0.5, Fp.z + Math.sin(a) * rF * 0.15);
      const P1 = new V3(l.c.x - l.ux * l.r * 0.25, l.c.y - l.r * 0.3, l.c.z - l.uz * l.r * 0.25);
      const pts = gnarl(P0, P1, range(rnd, 0.6, 1.1), 5);
      const rb = rF * range(rnd, 0.58, 0.7);
      tube(bark, pts, pts.map((_, i) => rb * lerpArr([1.12, 0.95, 0.8, 0.66, 0.52, 0.4, 0.3], i / (pts.length - 1))), { sides: hero ? 10 : 9, uRep: 1.5, vLen: 1.4, twist: 0.12, color: bc, cap: 0.6 });
      heavy.push({ pts, rb, l });
    }
  });
  // the other lobes hang off the nearest heavy limb
  const branchTo = (l) => {
    if (!heavy.length) return;
    let best = heavy[0], bd = Infinity;
    for (const h of heavy) { const e = h.pts[h.pts.length - 1], dd = Math.hypot(e.x - l.c.x, e.z - l.c.z); if (dd < bd) { bd = dd; best = h; } }
    const P0 = best.pts[Math.floor(best.pts.length * range(rnd, 0.45, 0.6))].clone();
    const P1 = new V3(l.c.x - l.ux * l.r * 0.2, l.c.y - l.r * 0.35, l.c.z - l.uz * l.r * 0.2);
    const pts = gnarl(P0, P1, range(rnd, 0.4, 0.8), 3);
    const rb = best.rb * (l.small ? 0.45 : 0.6);
    tube(bark, pts, pts.map((_, i) => rb * (1 - 0.6 * i / (pts.length - 1))), { sides: 7, uRep: 1, vLen: 1.4, color: bc, cap: 0.5 });
  };
  ring.slice(nHeavy).forEach(branchTo);
  L.filter(l => l.small || l.upper).forEach(branchTo);
  const top = L.find(l => l.top);
  {
    const P1 = new V3(top.c.x, top.c.y - top.r * 0.45, top.c.z);
    const pts = gnarl(new V3(Fp.x, Fp.y - 0.3 * G, Fp.z), P1, 0.5, 3);
    tube(bark, pts, pts.map((_, i) => rF * lerpArr([0.62, 0.48, 0.34, 0.2], i / (pts.length - 1))), { sides: 9, uRep: 1.5, vLen: 1.4, color: bc, cap: 0.5 });
  }

  // ---- the leaves
  let yLo = Infinity, yHi = -Infinity;
  for (const l of L) { yLo = Math.min(yLo, l.c.y - l.r * 0.85); yHi = Math.max(yHi, l.c.y + l.r * 0.9); }
  const tint = lin(pick(rnd, B.oakTints));
  const ao = p => (west ? 0.7 : 0.64) + (west ? 0.3 : 0.36) * Math.pow(smooth(yLo, yHi, p.y), 1.05);
  const wk = west ? [1.1, 1.06, 0.88] : [1.16, 1.12, 0.84];
  const warm = p => { const t = smooth(yLo + (yHi - yLo) * 0.45, yHi, p.y); return [1 + (wk[0] - 1) * t, 1 + (wk[1] - 1) * t, 1 + (wk[2] - 1) * t]; };
  const den = B.leafDensity;
  for (const l of L) {
    const size = Math.min(l.r * range(rnd, 0.92, 1.02), 3.1);
    const n = Math.max(6, Math.round(den * (6 + 13 * (l.r / size) ** 2)));
    clump(leaves, l.c, l.r * 0.92, rnd, { cards: n, size, cells: [0], core: 2, coreK: 1.7, tint, ao, warm, squash: west ? 0.92 : l.top ? 0.85 : 0.8, under: west ? 1.0 : 0.8, sizeVar: [0.82, 1.18] });
    // the ceiling under it (the top lobe's is hidden inside the crown but for the gaps between lobes)
    ceiling(leaves, l.c, l.r * 0.92, rnd, { tint, squash: 0.8, n: l.small ? 3 : l.top ? 3 : 4, light: 0.8, depth: l.top ? 0.55 : 0.42 });
    // the skirt: leaf cards hanging off the lobe's outer, lower rim
    if (l.top) continue;
    const nS = Math.round((l.small ? 1 : 1.5 + l.r * 0.5) * (west ? 0.7 : 1));
    const base = Math.atan2(l.uz, l.ux);
    for (let k = 0; k < nS; k++) {
      const a = base + (nS > 1 ? (k / (nS - 1) - 0.5) * 2.4 : 0) + range(rnd, -0.25, 0.25), ux = Math.cos(a), uz = Math.sin(a);
      const rr = l.r * range(rnd, 0.6, 0.78), w = l.r * range(rnd, 0.85, 1.05), h = l.r * range(rnd, 0.48, 0.64);
      const top = new V3(l.c.x + ux * rr, l.c.y - l.r * range(rnd, 0.18, 0.32), l.c.z + uz * rr);
      hang(leaves, top, w, h, new V3(ux, 0, uz), inset(cellOf(1)), mulc(tint, ao(new V3(0, top.y - h * 0.5, 0)) * 0.95));
    }
  }
  // undergrowth: a bush at the foot (no collider, like any bush)
  if (rnd() < (west ? 0.3 : 0.5)) {
    const a = rnd() * TAU, dd = rC + range(rnd, 1.2, 2.2) * Math.min(1.5, G * 0.8), R = range(rnd, 0.6, 0.9);
    const C = new V3(Math.cos(a) * dd, 0, Math.sin(a) * dd); C.y = ctx.gh(C.x, C.z) + R * 0.5;
    clump(leaves, C, R, rnd, { cards: Math.round(10 + 10 * R * R), size: range(rnd, 1.1, 1.4), cells: [3], core: 3, coreK: 1.7, tint, ao: p => 0.66 + 0.34 * smooth(C.y - R, C.y + R, p.y), squash: 0.78, wind: 0.6, sizeVar: [0.7, 1.3] });
  }
}

// A hanging leaf card: top-centre at T, w wide, h tall, facing out along `out` (it turns about the
// vertical toward the camera); its normal tips outward and down (it's lit from below and the side,
// darker than the crown above), and it sways most at its bottom.
function hang(b, T, w, h, out, cell, color, flare = 0) {
  const f = new V3(out.x, 0, out.z).normalize(), r = new V3(f.z, 0, -f.x);
  const C = new V3(T.x, T.y - h / 2, T.z);
  const us = [cell[0], cell[2], cell[2], cell[0]], vs = [cell[1], cell[1], cell[3], cell[3]];
  const base = b.n;
  [[-1, -1], [1, -1], [1, 1], [-1, 1]].forEach(([a, c], k) => {
    // flare: the bottom edge swings toward the viewer (the card turns to face the camera), so from
    // under the crown a skirt card is seen tipped toward you, never edge-on
    const off = new V3().addScaledVector(r, a * w / 2).add(new V3(0, c * h / 2, 0)).addScaledVector(f, -c * flare * h / 2);
    const n = new V3().copy(f).multiplyScalar(0.75).add(new V3(0, c > 0 ? 0.25 : -0.35, 0)).normalize();
    b.v(new V3().copy(C).add(off), n, us[k], vs[k], mulc(color, c > 0 ? 0.9 : 1.05), c > 0 ? 0.6 : 1.3, [C, off, f]);
  });
  b.t(base, base + 1, base + 2); b.t(base, base + 2, base + 3);
}

// A pine: a straight trunk that stops inside the crown, stacked drooping tiers of bough cards round
// dark inner cones, closed off by two small tiers and a tip spray. Elwynn's tiers are fewer and
// droop harder, each lit along its top. Dun Morogh's carry snow: painted on the boughs (the undersides
// still frosted), plus a lumpy snow ridge along the inner part of every bough, so every tier shows a
// white line in profile.
function pine(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 12)), s = d.s || 1, B = ctx.bio, snow = !!B.snow, lite = !!d.lite;
  ctx.at(d, d.ry || 0);
  const bark = lite ? null : ctx.b('bark_pine'), nd = ctx.b('needles'), ridge = snow && !lite ? ctx.b('snowridge') : null;
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
    tr.push(Math.max(0.03 * s, r0 * (1.08 - 0.88 * Math.pow(clamp01(y / yTrunk), 1.4)) * (1 + 0.45 * Math.pow(clamp01(1 - (y + 0.2) / (1.0 * s)), 2))));
  }
  const nR = 4, a0 = rnd() * TAU, rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.4, 0.4));
  const fl = flare(rootA, 0.6);
  if (bark) {
    tube(bark, tp, tr, {
      sides: 8, uRep: 2, vLen: 2.2, color: barkAO(-0.3, 1.5, 0.45),
      lobes: (dir, t, i) => { const f = Math.pow(clamp01(1 - (tp[i].y + 0.2) / (0.9 * s)), 1.5); return 1 + f * 0.7 * fl(Math.atan2(dir.z, dir.x)); },
    });
    roots(ctx, bark, rootA, r0, s, rnd, { len: [0.7, 1.0], rad: 0.2, up: 0.5, sides: 6, color: barkAO(-0.3, 1.2, 0.45) });
  }
  const tint = lin(pick(rnd, B.pineTints));
  const nT = lite ? 4 : Math.round((snow ? 8 : 6) * Math.min(1.1, Math.max(0.85, s)));
  const Rb = (snow ? 3.0 : 3.3) * s * range(rnd, 0.92, 1.08), dK = snow ? 0.42 : 0.55;
  const y0 = (Rb + 0.25 * s) * dK * 1.05 + range(rnd, 0.25, 0.45) * s, y1 = H * 0.86;
  const cellDense = inset(cellOf(snow ? 6 : 2, ...grid));
  const du = cellDense[2] - cellDense[0], dv = cellDense[3] - cellDense[1];
  // a far (rim) pine has no bark mesh: a dark stub in the needle material holds it up to its boughs
  if (lite) tube(nd, [new V3(0, yBot, 0), new V3(0, y0, 0)], [r0 * 1.2, r0 * 0.8], { sides: 5, uvMap: () => [cellDense[0] + du * 0.5, cellDense[1] + dv * 0.5], color: [0.3, 0.24, 0.2] });
  const tiers = [];
  for (let i = 0; i < nT; i++) {
    const t = i / (nT - 1);
    const y = y0 + (y1 - y0) * Math.pow(t, 0.95) + range(rnd, -0.08, 0.08) * s;
    tiers.push({ t, y, R: Rb * (1 - 0.76 * t) * range(rnd, 0.92, 1.06) + 0.5 * s });
  }
  // two small tiers close the crown up to the tip
  tiers.push({ t: 1, y: y1 + (H - y1) * 0.42, R: 0.75 * s, mini: true }, { t: 1, y: y1 + (H - y1) * 0.75, R: 0.45 * s, mini: true });
  const snowC = lin('#ffffff'), snowLo = lin('#c4d2e6'), snowUnder = lin('#7e8fa8');
  for (let i = 0; i < tiers.length; i++) {
    const { t, y, R, mini } = tiers[i];
    const droop = Math.max(R * dK, 0.55 * s);
    const [cx, cz] = center(y);
    const tierAO = 0.74 + 0.26 * t;
    // the dark solid cone under the boughs, overlapping the tier above so no trunk shows; mapped to a
    // small patch of the dense-needle cell (a soft dark green, never stretched streaks)
    const yTopC = i < tiers.length - 1 ? tiers[i + 1].y + 0.25 * s : H - 0.2 * s;
    tube(nd, [new V3(cx, y - droop * 0.7, cz), new V3(cx, (y - droop * 0.7 + yTopC) / 2, cz), new V3(cx, yTopC, cz)], [R * 0.4, R * 0.17, 0.04 * s], {
      sides: 9, uRep: 1, vLen: 1,
      uvMap: (u, v, tt) => [cellDense[0] + du * (0.12 + 0.76 * (1 - Math.abs(2 * (u % 1) - 1))), cellDense[1] + dv * (0.35 + 0.25 * tt)],   // mirrored round the cone: no seam, needles at their own aspect
      color: mulc(tint, (snow ? 0.6 : 0.5) * tierAO), wind: 0.15,
    });
    const K = lite ? (mini ? 3 : 5) : mini ? 5 : Math.max(7, Math.round(7 + 2 * (1 - t))), th0 = rnd() * TAU;
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
      // lit along the tier's top (the inner, upper part of each bough), a little darker at the tips
      const rowK = snow ? [0.74, 0.94, 1.04] : [0.95, 1.08, 0.9];
      strip(nd, rows, [cell[0], cell[2]], vs, (ri) => new V3().copy(nrm).add(new V3(dx, 0, dz).multiplyScalar(ri * 0.15)).normalize(),
        ri => mulc(tint, tierAO * rowK[ri]), ri => [0, 0.45, 1][ri] * 0.8, nrm);
      // the snow: one or two low lumpy mounds riding the inner part of the bough (wide and flat, their
      // undersides pressed into the needles), so the tier shows a broken white line in profile
      if (ridge && !mini && ci < 2 && i > 0) {     // (the lowest tier is seen from above: its painted snow is enough)
        const mid = r => rows[r][0].clone().lerp(rows[r][1], 0.5);
        const A = mid(0), Bm = mid(1), Cc = mid(2);
        const at = f => (f < 0.5 ? A.clone().lerp(Bm, f / 0.5) : Bm.clone().lerp(Cc, (f - 0.5) / 0.5));
        const sv = new V3(dz, 0, -dx);
        // (it starts at the trunk, inside the dark cone, so it needs no start cap; four sides and a
        // short tip keep it to 16 vertices a bough)
        const spans = rnd() < 0.88 ? [[0.04, range(rnd, 0.42, 0.62)]] : [];
        for (const [fa, fb] of spans) {
          const rr = range(rnd, 0.12, 0.17) * s * (1 - 0.4 * t), ph = rnd() * 6;
          const pts = [fa, (fa + fb) * 0.55, fb].map(f => at(f).addScaledVector(nrm, rr * 0.2).addScaledVector(sv, range(rnd, -0.08, 0.08) * s));
          tube(ridge, pts, [rr * 0.8, rr * range(rnd, 0.95, 1.12), rr * range(rnd, 0.6, 0.8)], { cap: 0.45, domeRings: [],
            sides: 4, uRep: 1, vLen: 2, a0: 0,
            lobes: (dir) => { const a = dir.dot(sv), bb = dir.dot(nrm); return 1 / Math.sqrt((a / 2.0) ** 2 + (bb / (bb < 0 ? 0.25 : 0.8)) ** 2 + 1e-4) * (1 + 0.14 * Math.sin(dir.x * 9 + dir.z * 7 + ph)); },
            color: (p, n) => (n.y < 0 ? mixc(snowUnder, snowLo, 1 + n.y) : mixc(snowLo, snowC, clamp01(0.45 + n.y * 0.6))), wind: (p, tt) => (fa + (fb - fa) * tt) * 0.8,
          });
        }
      }
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
  // the leaf-base rings tighten toward the crown
  tube(bark, pts, rad, { sides: 10, uRep: 1.5, vLen: 2.4, color: barkAO(-0.3, 1.2, 0.55), uvMap: (u, v, t) => [u, v * (1 + 0.55 * t)], lobes: (dir, t, i, j) => 1 + 0.03 * Math.sin(j * 2.1 + i) });
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
    const a = rnd() * TAU, dd = k === 0 ? 0 : range(rnd, 0.35, 0.65) * s, R = (k === 0 ? range(rnd, 0.75, 0.95) : range(rnd, 0.5, 0.75)) * s * (snow ? 1.2 : 1);
    const C = new V3(Math.cos(a) * dd, R * (snow ? 0.42 : 0.6), Math.sin(a) * dd);
    C.y += ctx.gh(C.x, C.z);
    if (snow) {
      // a snowy juniper mound: a snow-blanketed core, snowy sprays on top, bare ones low round the sides
      clump(b, C, R, rnd, { cards: Math.round((10 + 10 * (R / s) ** 2) * 1.2), size: range(rnd, 0.95, 1.2) * s, grid: [4, 2], core: 4, coreK: 1.7, cellFn: dir => (dir.y > -0.25 ? (rnd() < 0.5 ? 0 : 1) : (rnd() < 0.5 ? 2 : 3)), tint, ao, squash: 0.7, wind: 0.4, sizeVar: [0.7, 1.25], span: 1.3 });
    } else {
      clump(b, C, R, rnd, { cards: Math.round((8 + 8 * (R / s) ** 2) * 1.3), size: range(rnd, 1.15, 1.4) * s, cells: B.bushCells, core: dry ? (B.bushCells[0] === 0 ? 2 : 1) : 3, coreK: 1.45, tint, ao, warm, squash: 0.78, wind: 0.6, sizeVar: [0.7, 1.3] });
    }
  }
}

// A dead tree: a gnarled trunk that splits at the top into 2-3 twisting forks with kinks, a broken
// snag or two, a jagged split point instead of a cap, and rounded roots gripping the ground.
function deadTree(ctx, s, rnd, { r0 = 0.27, ring = null } = {}) {
  const b = ctx.b('bark_dead');
  const tint = lin(ctx.bio.deadTint || '#c8c0b8'), pale = lin('#d8ccb4');
  const col = (lo) => (p) => mulc(tint, lo + (1 - lo) * smooth(-0.2, 1.6, p.y));
  // a broken end: the bark colour along the branch, the pale split wood on its blunt dome
  const brk = (lo) => (p, n, t) => (t >= 0.999 ? mixc(mulc(tint, 0.9), pale, 0.8) : col(lo)(p));
  const H = range(rnd, 3.4, 4.4) * s, a0 = rnd() * TAU;
  const [gLo] = ctx.foot(r0 * 2.4);
  const yBot = Math.min(-0.4, gLo - 0.3);
  const tp = [], tr = [], NT = 8;
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, y = yBot + t * (H - yBot), k = clamp01(y / H);
    tp.push(new V3(Math.sin(k * 3.1 + a0) * 0.32 * k * s + Math.sin(k * 7 + a0) * 0.05 * k, y, Math.cos(k * 2.3 + a0) * 0.28 * k * s));
    tr.push(r0 * (1.1 - 0.45 * k) * (1 + 0.45 * Math.pow(clamp01(1 - (y + 0.2) / 1.1), 2)));
  }
  const nR = 4 + (rnd() < 0.5 ? 1 : 0), rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.35, 0.35));
  const ph0 = rnd() * TAU, fl = flare(rootA, 0.6);
  tube(b, tp, tr, {
    sides: 10, uRep: 1.5, vLen: 1.6, twist: 0.2, color: col(0.5),
    lobes: (dir, t, i) => { const f = Math.pow(clamp01(1 - (tp[i].y + 0.2) / 1.0), 1.5), ph = Math.atan2(dir.z, dir.x); return (1 + f * 0.6 * fl(ph)) * (1 + 0.08 * Math.cos(3 * (ph - ph0 - t * 1.2))); },
  });
  roots(ctx, b, rootA, r0, 1, rnd, { len: [0.6, 0.95], rad: 0.2, up: 0.45, sides: 7, color: col(0.5) });
  // the split top: two short blunt broken stubs, pale split wood at their ends
  const top = tp[NT], rT = tr[NT];
  for (let k = 0; k < 2; k++) {
    const a = a0 + k * Math.PI + range(rnd, -0.4, 0.4), h = range(rnd, 0.2, 0.45) * s;
    tube(b, [new V3(top.x + Math.cos(a) * rT * 0.25, top.y - 0.12, top.z + Math.sin(a) * rT * 0.25), new V3(top.x + Math.cos(a) * rT * 0.45, top.y + h, top.z + Math.sin(a) * rT * 0.45)], [rT * 0.62, rT * 0.42], { sides: 6, uRep: 1, vLen: 1.6, color: brk(0.8), cap: 0.35 });
  }
  const at = t => { const f = t * NT, i = Math.min(NT - 1, Math.floor(f)), u = f - i; return [tp[i].clone().lerp(tp[i + 1], u), tr[i] + (tr[i + 1] - tr[i]) * u]; };
  const twigs = (pts, rB, n = 2) => {
    for (let tw = 0; tw < n; tw++) {
      const q = pts[2 + tw], td = new V3(range(rnd, -1, 1), range(rnd, 0.3, 1), range(rnd, -1, 1)).normalize(), tl = range(rnd, 0.35, 0.65) * s;
      tube(b, [q, q.clone().addScaledVector(td, tl * 0.5).add(new V3(0, 0.05, 0)), q.clone().addScaledVector(td, tl)], [rB * 0.3, rB * 0.24, rB * 0.19], { sides: 5, uRep: 1, vLen: 1.6, color: brk(0.85), cap: 0.4 });
    }
  };
  // 2-3 major forks from the upper trunk, thick at the base, bending twice, ending in broken stubs
  const nF = 2 + (rnd() < 0.55 ? 1 : 0);
  for (let k = 0; k < nF; k++) {
    const t = range(rnd, 0.55, 0.78), [P0, rr] = at(t), a = a0 + k * TAU / nF + range(rnd, -0.35, 0.35);
    const rB = rr * range(rnd, 0.72, 0.84), L = range(rnd, 1.2, 1.9) * s * range(rnd, 0.8, 1.2);
    const pts = limb(P0, new V3(Math.cos(a), range(rnd, 0.45, 1.0), Math.sin(a)), L, rnd, { bends: 2, bendAmt: 0.5, rise: 0.12, segs: 6 });
    tube(b, pts, pts.map((_, i) => rB * lerpArr([1.1, 1.0, 0.9, 0.8, 0.7, 0.6, 0.5], i / (pts.length - 1))), { sides: 8, uRep: 1, vLen: 1.6, twist: 0.15, color: brk(0.75), cap: 0.35 });
    twigs(pts, rB, 1);
    // a secondary branch
    const m0 = pts[2], b2 = a + (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.7, 1.3);
    const p2 = limb(m0, new V3(Math.cos(b2), range(rnd, 0.3, 0.9), Math.sin(b2)), range(rnd, 0.8, 1.3) * s, rnd, { bends: 2, bendAmt: 0.55, segs: 4 });
    tube(b, p2, p2.map((_, i) => rB * 0.52 * lerpArr([1, 0.88, 0.76, 0.64, 0.55], i / (p2.length - 1))), { sides: 7, uRep: 1, vLen: 1.6, color: brk(0.8), cap: 0.35 });
  }
  // lower limbs and broken snags
  const nLow = 1 + (rnd() < 0.6 ? 1 : 0);
  for (let k = 0; k < nLow; k++) {
    const t = range(rnd, 0.3, 0.5), [P0, rr] = at(t), a = a0 + range(rnd, 0, TAU);
    const rB = rr * range(rnd, 0.45, 0.6), snag = rnd() < 0.5, L = (snag ? range(rnd, 0.3, 0.55) : range(rnd, 1.0, 1.6)) * s;
    const pts = limb(P0, new V3(Math.cos(a), range(rnd, 0.3, 0.8), Math.sin(a)), L, rnd, { bends: snag ? 0 : 2, bendAmt: 0.5, segs: snag ? 2 : 5 });
    tube(b, pts, pts.map((_, i) => rB * (snag ? 1 - i * 0.12 : lerpArr([1, 0.86, 0.72, 0.6, 0.5, 0.42], i / (pts.length - 1)))), { sides: 7, uRep: 1, vLen: 1.6, color: brk(0.72), cap: 0.3 });
    if (!snag) twigs(pts, rB);
  }
  if (ring != null) {
    // the winch strap: a flat iron band hugging the trunk at the hook's height, a leather strap wound
    // above it, and a heavy ring hanging from a tab
    let i = 0; while (i < NT - 1 && tp[i + 1].y < ring) i++;
    const f = clamp01((ring - tp[i].y) / (tp[i + 1].y - tp[i].y)), c = tp[i].clone().lerp(tp[i + 1], f), rr = (tr[i] + (tr[i + 1] - tr[i]) * f);
    const ib = ctx.b('iron');
    const band = (y, r, th, wd) => { const loop = []; for (let k = 0; k <= 20; k++) { const a = k / 20 * TAU; loop.push(new V3(c.x + Math.cos(a) * r, y + Math.sin(a * 2 + 1) * 0.006, c.z + Math.sin(a) * r)); } return loop; };
    const lb = band(c.y, rr * 1.04 + 0.022, 0, 0);
    tube(ib, lb, lb.map(() => 0.036), { sides: 4, a0: Math.PI / 4, uRep: 1, vLen: 0.4, color: [0.95, 0.9, 0.86] });
    // leather strap: two turns just above the band
    for (const dy of [0.09, 0.16]) { const sl = band(c.y + dy, rr * 1.03 + 0.012); tube(b, sl, sl.map(() => 0.022), { sides: 5, uRep: 1, vLen: 0.3, color: lin('#7a4e30'), lobes: (dir) => (Math.abs(dir.y) > 0.6 ? 1.6 : 0.7) }); }
    // the tab and the heavy ring at the hook point, on the trunk's +x side
    const ox = rr * 1.04 + 0.05;
    tube(ib, [new V3(c.x + ox - 0.04, c.y + 0.02, c.z), new V3(c.x + ox + 0.04, c.y - 0.04, c.z)], [0.035, 0.03], { sides: 4, uRep: 1, vLen: 0.3, color: WHITE, cap: 0.4, cap0: 0.4 });
    const sh = [];
    for (let k = 0; k <= 14; k++) { const a = k / 14 * TAU; sh.push(new V3(c.x + ox + 0.07 + Math.sin(a) * 0.02, c.y - 0.15 + Math.cos(a) * 0.12, c.z + Math.sin(a) * 0.11)); }
    tube(ib, sh, sh.map(() => 0.028), { sides: 7, uRep: 1, vLen: 0.4, color: WHITE });
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
  const fl = flare(rootA, 0.6);
  const yT = gHi * 0.5 + H;
  const pts = [new V3(0, Math.min(-0.35, gLo - 0.3), 0), new V3(0, 0.1, 0), new V3(0, yT * 0.55, 0), new V3(0, yT, 0), new V3(0, yT + 0.012, 0)];
  const rad = [R * 1.3, R * 1.12, R * 1.02, R, R * 0.88];
  if (ctx.bio.barkCover) bark.cf = (p, n) => smooth(0.7, 0.05, p.y) * 0.5;
  tube(bark, pts, rad, {
    sides: 11, uRep: 2, vLen: 1.4, color: barkAO(-0.3, 0.8, 0.55, lin(ctx.bio.oakTrunk || '#ffffff')),
    lobes: (dir, t, i) => { const ph = Math.atan2(dir.z, dir.x); if (i >= 3) return 1 + 0.04 * Math.sin(ph * 6); const f = i === 0 ? 1 : i === 1 ? 0.6 : 0.15; return 1 + f * 0.5 * fl(ph); },
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
    if (o.groove) { const f = 1 - o.groove[0] * (0.5 + 0.5 * Math.sin(TAU * p.y / o.groove[1] + sA)); p.x *= f; p.z *= f; }   // wind-cut horizontal grooves
    return p;
  });
  return { P, idx: I.idx };
}

// Put a rock shape into the world: scale R, tilt, turn, move to C; AO dark at the foot, a little
// lighter on top. Returns the placed points (for a snow cap).
function placeRock(b, shape, C, R, { yaw = 0, tilt = 0, tiltA = 0, tint = WHITE, aoLo = 0.42, cos = COS_CREASE } = {}) {
  const m = new THREE.Matrix4().makeRotationY(yaw);
  if (tilt) m.multiply(new THREE.Matrix4().makeRotationAxis(new V3(Math.cos(tiltA), 0, Math.sin(tiltA)), tilt));
  const P = shape.P.map(p => p.clone().multiplyScalar(R).applyMatrix4(m).add(C));
  let y0 = Infinity, y1 = -Infinity; for (const p of P) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const yg = Math.max(y0, C.y - 0.35 * (y1 - y0));
  const FD = faceData(P, shape.idx);
  creased(b, P, shape.idx, (p, n) => mulc(tint, (aoLo + (1 - aoLo) * smooth(yg - 0.1, yg + Math.max(0.5, (y1 - yg) * 0.7), p.y)) * (0.9 + 0.12 * n.y)), FD, cos);
  return { P, idx: shape.idx, FD };
}

// A snow cap on a placed rock: the up-facing faces lifted into a soft pillow, with a lip hanging
// over the edges.
function snowCap(b, rk, thick, minUp = 0.74) {
  const { P, idx, FD } = rk, { FN, FA, VF } = FD;
  const snowy = FN.map((n, f) => FA[f] > 1e-9 && n.y > minUp);
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

// One layer of a stepped canyon formation: an irregular 6-8-sided slab, its foot pulled in (the dark
// undercut line under the ledge above it), straight sides, a chamfered lit lip and a flat top (dust
// settles there). poly: [[angle, radius]...]. Creased at 25°, so its faces read as chiselled planes.
const COS25 = Math.cos(25 * Math.PI / 180);
function prism(b, C, y0, h, poly, rnd, { tint = WHITE, tilt = null, under = 0.9, bevel = 0.08, bulge = 1, foot = 0.06, aoLo = 0.42, lipK = 1.12, wob = 0 } = {}) {
  const N = poly.length, P = [], idx = [];
  // wob: each corner of each ring pushed in or out a little, so the faces aren't planes (no crates)
  const ring = (y, k, dy = 0) => { const i0 = P.length; for (const [a, r] of poly) { const tY = tilt ? (Math.cos(a) * tilt[0] + Math.sin(a) * tilt[1]) * r : 0, w = 1 + range(rnd, -wob, wob); P.push(new V3(C.x + Math.cos(a) * r * k * w + range(rnd, -0.02, 0.02), y + tY * dy, C.z + Math.sin(a) * r * k * w + range(rnd, -0.02, 0.02))); } return i0; };
  const bv = Math.min(bevel, h * 0.25);
  const rs = [ring(y0 - foot, under, 0), ring(y0 + h * 0.18, 1, 0.18), ring(y0 + h * 0.55, bulge, 0.55), ring(y0 + h - bv, 1, 1), ring(y0 + h, 1 - bv / Math.max(0.2, poly.reduce((m, [, r]) => Math.min(m, r), 9)), 1)];
  for (let q = 0; q < rs.length - 1; q++) for (let k = 0; k < N; k++) { const a = rs[q] + k, bb = rs[q] + (k + 1) % N, c = rs[q + 1] + k, dd = rs[q + 1] + (k + 1) % N; idx.push(a, c, bb, bb, c, dd); }
  const top = rs[rs.length - 1], cy = P.slice(top, top + N).reduce((m, p) => m + p.y, 0) / N;
  const ci = P.length; P.push(new V3(C.x, cy, C.z));
  for (let k = 0; k < N; k++) idx.push(top + k, ci, top + (k + 1) % N);
  const yTop = y0 + h;
  creased(b, P, idx, (p, n) => {
    const t = clamp01((p.y - (y0 - foot)) / (h + foot));
    const k = (aoLo + (1 - aoLo) * smooth(0, 0.35, t)) * (t > 0.88 ? lipK : 1) * (0.92 + 0.1 * n.y);
    return mulc(tint, k);
  }, faceData(P, idx), COS25);
  return yTop;
}
// an irregular footprint: N corners, radii jittered, angles jittered
const polyOf = (rnd, N, r, jit = 0.18, sx = 1, sz = 1) => { const a0 = rnd() * TAU, out = []; for (let k = 0; k < N; k++) { const a = a0 + (k + range(rnd, -0.22, 0.22)) * TAU / N, rr = r * range(rnd, 1 - jit, 1 + jit) * Math.hypot(Math.cos(a) * sx, Math.sin(a) * sz); out.push([a, rr]); } return out; };

// The collider world gen gave a rock (this mirrors shared/world.js rockCollide, steepness test
// included, and prefers the real collider when one stands at the rock's centre). Hoodoos are always
// solid (3-5 m whatever s is); other rocks over s 1.2 are solid, and so are the knee-to-waist
// boulders (s 0.9-1.2) of the green and snowy days. The visuals keep to their colliders: no invisible
// walls or steps, and no rock you can walk into (loose rubble round them stays under the 0.46 m step).
function rockCol(ctx, d) {
  const W = ctx.W, bm = ctx.biome, s = d.s || 1;
  const S0 = s * (bm === 'badlands' ? 1.25 : 1), R = S0 * 1.1;
  let lo = Infinity, hi = -Infinity;
  for (const [dx, dz] of [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R]]) { const h = W.heightAt ? W.heightAt(d.x + dx, d.z + dz) : 0; lo = Math.min(lo, h); hi = Math.max(hi, h); }
  const steep = hi - lo > 0.8 * S0, S = steep ? S0 * 0.75 : S0;
  const green = bm === 'meadow' || bm === 'fields' || bm === 'snow';
  const out = { S, steep, big: s > 1.2 };
  const c = (W.cyls || []).find(c => c.mat === 'rock' && Math.abs(c.x - d.x) < 0.02 && Math.abs(c.z - d.z) < 0.02);
  if (bm === 'badlands' && d.variant === 'hoodoo') {
    const Ht = 4.25 * Math.max(0.7, Math.min(1.2, S / 1.8));
    out.hoodoo = c ? { Ht: c.hh * 2, r: c.r } : { Ht, r: Math.max(0.55, Ht * 0.19) * 0.9 };
    out.big = true;
    return out;
  }
  if (!out.big) {
    if (c) out.cyl = { r: c.r, top: c.y + c.hh - d.y };
    else if (green && s > 0.9) out.cyl = { r: S * 0.75, top: S * 0.8 };
    return out;
  }
  // a Badlands ledge may get an oriented box (part 'rock_ledge', yawed like the rock or not): its mesa
  // then fills a long rounded rectangle instead of a circle
  const bx = bm === 'badlands' ? (W.statics || []).find(q => q.part === 'rock_ledge' && Math.abs(q.x - d.x) < 0.05 && Math.abs(q.z - d.z) < 0.05) : null;
  if (bx) {
    out.box = { hx: bx.hx, hz: bx.hz, rot: (d.ry || 0) - (bx.ry || 0), top: bx.y + bx.hy - d.y };
  } else if (bm === 'desert' && d.variant === 'arch') {
    out.arch = { span: S * 1.9, r: S * 0.36 * 1.1, top: S * 1.6 };
  } else {
    const tall = bm === 'badlands' ? 0.75 : bm === 'desert' ? 0.45 : 0.4;
    out.cyl = c ? { r: c.r, top: c.y + c.hh - d.y } : { r: S * (bm === 'desert' ? 0.95 : 0.8), top: green ? S * 0.7 : S * tall * 1.8 };
  }
  return out;
}

// The highest surface of a mesh straight above each (x, z) sample (null where there's none).
// get(i) -> [x, y, z] of vertex i.
function surfTop(get, idx, samples) {
  const out = samples.map(() => null);
  for (let t = 0; t < idx.length; t += 3) {
    const A = get(idx[t]), B = get(idx[t + 1]), C = get(idx[t + 2]);
    const x0 = Math.min(A[0], B[0], C[0]), x1 = Math.max(A[0], B[0], C[0]), z0 = Math.min(A[2], B[2], C[2]), z1 = Math.max(A[2], B[2], C[2]);
    const den = (B[2] - C[2]) * (A[0] - C[0]) + (C[0] - B[0]) * (A[2] - C[2]);
    if (Math.abs(den) < 1e-12) continue;
    samples.forEach(([x, z], i) => {
      if (x < x0 || x > x1 || z < z0 || z > z1) return;
      const l1 = ((B[2] - C[2]) * (x - C[0]) + (C[0] - B[0]) * (z - C[2])) / den, l2 = ((C[2] - A[2]) * (x - C[0]) + (A[0] - C[0]) * (z - C[2])) / den, l3 = 1 - l1 - l2;
      if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return;
      const y = l1 * A[1] + l2 * B[1] + l3 * C[1];
      if (out[i] == null || y > out[i]) out[i] = y;
    });
  }
  return out;
}
const discSamples = (cx, cz, r) => { const out = [[cx, cz]]; for (const f of [0.35, 0.6, 0.8]) for (let k = 0; k < 8; k++) { const a = (k + (f > 0.5 ? 0.5 : 0)) / 8 * TAU; out.push([cx + Math.cos(a) * r * f, cz + Math.sin(a) * r * f]); } return out; };
// the top of a solid rock over its collider's disc: a little under the mean (its low side counts more)
const topOf = hs => { const v = hs.filter(h => h != null); return v.length ? Math.min(...v) * 0.4 + (v.reduce((a, q) => a + q, 0) / v.length) * 0.6 : null; };

// Raise or lower the top of a fitted rock (scaled, about its centre): its top over the collider's
// disc lands at `want` (the collider's top), so there's no invisible step on it.
function fitTop(P, idx, rIn, want) {
  const low = topOf(surfTop(i => [P[i].x, P[i].y, P[i].z], idx, discSamples(0, 0, rIn)));
  if (low == null || low < 0.05) return P;
  const k = Math.max(0.45, Math.min(2.2, want / low));
  for (const p of P) if (p.y > 0) p.y *= k;
  return P;
}

// Squeeze or swell a rock shape (already scaled) in plan so the part of it at bumper height fills a
// circle of radius `target`: per angle, the outline moves most of the way to the circle (a little of
// its own shape kept, so it stays a chiselled rock and not a drum).
function fitPlan(P, target, keep = 0.22) {
  const NB = 16, ext = new Array(NB).fill(0);
  let y0 = Infinity, y1 = -Infinity; for (const p of P) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  const ya = y0 + (y1 - y0) * 0.3, yb = y0 + (y1 - y0) * 0.75;   // the body, above the buried foot
  for (const p of P) {
    if (p.y > yb || p.y < ya) continue;
    const a = Math.atan2(p.z, p.x), k = Math.round(((a + Math.PI) / TAU) * NB) % NB, r = Math.hypot(p.x, p.z);
    ext[k] = Math.max(ext[k], r);
  }
  for (let k = 0; k < NB; k++) if (!ext[k]) ext[k] = Math.max(...ext);
  const kOf = a => {
    const f = ((a + Math.PI) / TAU) * NB, i = Math.floor(f), u = f - i;
    const e = ext[((i % NB) + NB) % NB] * (1 - u) + ext[(((i + 1) % NB) + NB) % NB] * u;
    return Math.max(0.75, Math.min(1.5, (target / Math.max(1e-3, e)) * (1 - keep) + keep));
  };
  for (const p of P) { const k = kOf(Math.atan2(p.z, p.x)); p.x *= k; p.z *= k; }
  return P;
}

// A mesh's cross-section at height y, as its outermost radius per angle bin (from the triangles
// the plane cuts, sampled along each cut); empty bins take their neighbours' values.
function sectionExt(P, idx, y, NB = 24) {
  const ext = new Array(NB).fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const hit = [];
    for (let e = 0; e < 3; e++) {
      const A = P[idx[t + e]], B = P[idx[t + (e + 1) % 3]];
      if ((A.y - y) * (B.y - y) > 0 || A.y === B.y) continue;
      const u = (y - A.y) / (B.y - A.y); hit.push([A.x + (B.x - A.x) * u, A.z + (B.z - A.z) * u]);
    }
    if (hit.length < 2) continue;
    for (let q = 0; q <= 8; q++) {
      const x = hit[0][0] + (hit[1][0] - hit[0][0]) * q / 8, z = hit[0][1] + (hit[1][1] - hit[0][1]) * q / 8;
      const k = Math.round(((Math.atan2(z, x) + Math.PI) / TAU) * NB) % NB;
      ext[k] = Math.max(ext[k], Math.hypot(x, z));
    }
  }
  if (!ext.some(v => v > 0)) return null;
  for (let k = 0; k < NB; k++) if (!ext[k]) {
    let i = 1; while (!ext[(k - i + NB) % NB] && i < NB) i++;
    let j = 1; while (!ext[(k + j) % NB] && j < NB) j++;
    ext[k] = (ext[(k - i + NB) % NB] * j + ext[(k + j) % NB] * i) / (i + j);
  }
  return ext;
}
// The same, height by height: between yA and yB (the bumper band, about the rock's centre) every
// slice of the rock is moved most of the way onto the circle, so it fills its collider at every
// height there (with `bulge` a little proud at mid-height: a rounded boulder, not a drum); above and
// below, the nearest slice's scaling carries on (the shoulder and the buried foot).
function fitPlanY(P, idx, target, yA, yB, keep = 0.26, bulge = 0.06) {
  const NB = 24, NY = 4;
  for (let pass = 0; pass < 2; pass++) {
    const ys = [], ext = [];
    for (let j = 0; j < NY; j++) { const y = yA + (yB - yA) * j / (NY - 1); ys.push(y); ext.push(sectionExt(P, idx, y, NB)); }
    for (let j = 0; j < NY; j++) if (!ext[j]) ext[j] = ext.find(e => e) || new Array(NB).fill(target);
    const kAt = (j, a) => {
      const f = ((a + Math.PI) / TAU) * NB, i = Math.floor(f), u = f - i, row = ext[j];
      const e = row[((i % NB) + NB) % NB] * (1 - u) + row[(((i + 1) % NB) + NB) % NB] * u;
      const tg = target * (1 + bulge * Math.sin(Math.PI * j / (NY - 1)));
      const kp = pass ? 0 : keep;
      return Math.max(0.6, Math.min(1.6, (tg / Math.max(1e-3, e)) * (1 - kp) + kp));
    };
    for (const p of P) {
      const a = Math.atan2(p.z, p.x), f = Math.max(0, Math.min(NY - 1, ((p.y - yA) / Math.max(1e-3, yB - yA)) * (NY - 1)));
      const j0 = Math.min(NY - 2, Math.floor(f)), u = f - j0;
      const k = kAt(j0, a) * (1 - u) + kAt(j0 + 1, a) * u;
      // the second pass only trims what the first left over (keeping the rock's own wobble)
      const kk = pass ? 1 + (k - 1) * 0.85 : k;
      p.x *= kk; p.z *= kk;
    }
  }
  return P;
}

// Loose rubble round a big rock: small chunks (under the step height) that settle at its foot.
function rubble(ctx, b, n, r0, r1, rnd, tint, { size = [0.12, 0.26], sy = 0.55 } = {}) {
  for (let k = 0; k < n; k++) {
    const a = rnd() * TAU, dd = range(rnd, r0, r1), R = range(rnd, size[0], size[1]), x = Math.cos(a) * dd, z = Math.sin(a) * dd;
    const sh = rockShape(rnd, { sx: range(rnd, 1, 1.4), sy, sides: 3, oblique: 2, detail: R > 0.2 ? 1 : 0, noise: 0.14 });
    const [lo] = ctx.foot(R, x, z, 5);
    placeRock(b, sh, new V3(x, lo + R * sy * 0.15, z), R, { yaw: rnd() * TAU, tilt: range(rnd, 0, 0.3), tiltA: rnd() * TAU, tint });
  }
}

// A Badlands hoodoo: ONE continuous lofted column (12 sides, smooth normals) on a flared talus foot,
// eroded into 2-4 waists at uneven heights between harder bands that stand proud, leaning a little
// and wandering ring to ring, with vertical rain flutes, up to a narrow neck under an irregular,
// tilted, overhanging caprock (the only creased edge is the cap's lip), a pale bleached band just
// under it. The strata come from the rock material's broad world-height beds, so the whole formation
// is one rock. Through the bumper band (below ~2 m) the column keeps to its collider (centred, radius
// r): the deep waists are higher up.
function hoodoo(ctx, b, rnd, col, tint) {
  const Ht = col.Ht * range(rnd, 1.0, 1.14), rb = col.r * 0.97;
  const [lo] = ctx.foot(rb * 1.5, 0, 0, 7);
  const y0 = Math.min(-0.45, lo - 0.45), capH = Ht * range(rnd, 0.1, 0.13);
  const yN = Ht - capH * 0.55;                                 // the neck's top, inside the cap
  const nW = 2 + Math.floor(rnd() * 3), waists = [];
  for (let k = 0; k < nW; k++) waists.push({ t: 0.2 + (k + range(rnd, 0.15, 0.85)) / nW * 0.62, d: range(rnd, 0.65, 0.88), w: range(rnd, 0.05, 0.1) });
  const bands = []; for (let k = 0; k < 2; k++) bands.push({ t: range(rnd, 0.25, 0.85), w: range(rnd, 0.02, 0.04), a: range(rnd, 0.04, 0.07) });
  const waistK = t => { let r = 1; for (const w of waists) r *= 1 - (1 - w.d) * Math.exp(-(((t - w.t) / w.w) ** 2)); return r; };
  const prof = (t, y) => {
    let r = (1 - 0.2 * smooth(0.3, 1, t)) * waistK(t);
    for (const bd of bands) r *= 1 + bd.a * Math.exp(-(((t - bd.t) / bd.w) ** 2));
    r = r + (Math.max(r, 0.95) - r) * (1 - smooth(1.7, 2.4, y - lo));   // the bumper band keeps to the collider
    r *= 1 + 0.5 * Math.pow(clamp01(1 - (y - lo + 0.45) / 0.85), 2);   // the talus foot, 1.5x, under the step height
    r *= 1 - 0.32 * smooth(0.84, 1, t);                     // the neck under the cap
    return r;
  };
  const la = rnd() * TAU, lean = range(rnd, 0.05, 0.1) * Ht;
  const NR = 30, pts = [], rad = [], ts = [];
  for (let i = 0; i <= NR; i++) {
    const t = i / NR, y = y0 + t * (yN - y0), tt = clamp01(y / yN);
    const L = lean * smooth(1.9, yN, y), j = i > 0 && i < NR ? 0.02 * rb : 0;
    pts.push(new V3(Math.cos(la) * L + range(rnd, -j, j), y, Math.sin(la) * L + range(rnd, -j, j)));
    rad.push(rb * prof(tt, y)); ts.push(tt);
  }
  const p1 = rnd() * TAU, p2 = rnd() * TAU, p3 = rnd() * TAU;
  // a bleached band under the cap: the red pulled toward cream (per-channel, so it desaturates)
  const bleach = mixc(WHITE, [1.12, 1.42, 1.62], 1);
  const aoAt = (y, t) => (0.55 + 0.45 * smooth(lo - 0.2, lo + 1.3, y)) * (1 - 0.3 * smooth(0.9, 0.99, t)) * (0.8 + 0.2 * waistK(t));
  tube(b, pts, rad, {
    sides: 12, uRep: 1, vLen: 2,
    lobes: (dir, t, i) => {
      const a = Math.atan2(dir.z, dir.x), tt = ts[i], k = 0.35 + 0.65 * smooth(1.7, 2.4, pts[i].y - lo);   // rounder through the bumper band
      return 1 + k * (0.08 * Math.cos(2 * a + p1 + tt * 1.6) + 0.05 * Math.cos(3 * a + p2 - tt * 2.2)) - 0.045 * Math.max(0, Math.cos(7 * a + p3 + tt * 0.6)) * smooth(0.1, 0.25, tt);
    },
    color: (p, n) => { const t = clamp01(p.y / yN), bl = smooth(0.72, 0.8, t) * (1 - smooth(0.93, 0.99, t)); return mul3(mulc(tint, aoAt(p.y, t) * (0.9 + 0.14 * Math.max(0, n.y))), mixc(WHITE, bleach, bl * 0.85)); },
  });
  // the caprock: 1.5-1.8x the neck, irregular, tilted 4-10°, overhanging all round
  const top = pts[NR], rNeck = rad[NR] / (1 - 0.32);
  const capS = rockShape(rnd, { sx: range(rnd, 1.0, 1.15), sy: 0.56, sz: range(rnd, 0.82, 0.98), topCut: [0.5, 0.64], topTilt: 0.1, sides: 5, oblique: 3, sideCut: [0.72, 0.86], noise: 0.12, bottom: 0.42, detail: 1 });
  const Rcap = rNeck * range(rnd, 1.5, 1.8) / 0.82;
  placeRock(b, capS, new V3(top.x + range(rnd, -0.1, 0.1) * rb, top.y + capH * 0.12, top.z + range(rnd, -0.1, 0.1) * rb), Rcap,
    { yaw: rnd() * TAU, tilt: range(rnd, 4, 10) * Math.PI / 180, tiltA: rnd() * TAU, tint: mul3(tint, lin('#c49274')), aoLo: 0.62 });
  // talus: a few small chunks at the foot (under the step height: no collider needed)
  rubble(ctx, b, 3 + Math.floor(rnd() * 4), rb * 1.5, rb * 2.2, rnd, tint);
}

// ---- layered rocks: Badlands ledges and Tanaris mounds ------------------------------------------------

// World metres per texture repeat of the layered rock materials (matFor maps them at this scale); the
// hard beds of the painted strata (paint/nature.js STRATA_BEDS) lie at fixed world heights from it.
const TRI_T = { badlands: 6.2, desert: 6.4, snow: 10.5 };   // (snow: the walls' own granite at the walls' own scale)
// The day's hard beds that cross local heights y0..y1 (local = above the rock's origin at world height
// baseY), as { y0, y1 } in local metres.
function bedsIn(biome, baseY, y0, y1) {
  const T = TRI_T[biome], B = STRATA_BEDS[biome === 'desert' ? 'rock_sand' : 'rock_red'], out = [];
  if (!T || !B) return out;
  for (let k = Math.floor((baseY + y0) / T) - 1; k <= Math.floor((baseY + y1) / T) + 1; k++) {
    for (const [v0, v1] of B) { const a = (k + v0) * T - baseY, c = (k + v1) * T - baseY; if (c > y0 && a < y1) out.push({ y0: a, y1: c }); }
  }
  return out.sort((p, q) => p.y0 - q.y0);
}

// Creased normals with shared vertices: round every vertex its faces fall into smoothing groups (a face
// joins the first group whose first face lies within the crease angle of it), one output vertex per
// group. The chiselled look of creased() at about a third of the vertices. color(p, n, vi).
function creasedShared(b, P, idx, color, cosC) {
  const { FN, FA, VF } = faceData(P, idx);
  const out = new Int32Array(idx.length).fill(-1);
  for (let vi = 0; vi < P.length; vi++) {
    const groups = [];
    for (const f of VF[vi]) {
      if (FA[f] < 1e-9) continue;
      let g = null;
      for (const G of groups) if (FN[G.f0].dot(FN[f]) > cosC) { g = G; break; }
      if (!g) { g = { f0: f, n: new V3(), faces: [] }; groups.push(g); }
      g.n.addScaledVector(FN[f], FA[f]); g.faces.push(f);
    }
    for (const g of groups) {
      if (g.n.lengthSq() < 1e-12) g.n.copy(FN[g.f0]);
      g.n.normalize();
      const o = b.v(P[vi], g.n, 0, 0, color(P[vi], g.n, vi), 0);
      for (const f of g.faces) for (let k = 0; k < 3; k++) if (idx[f * 3 + k] === vi) out[f * 3 + k] = o;
    }
  }
  for (let f = 0; f < idx.length / 3; f++) if (FA[f] >= 1e-9) b.t(out[f * 3], out[f * 3 + 1], out[f * 3 + 2]);
}

// A plan as a polygon ([[x, z]...] round the point (cx, cz)) -> its radius by angle about that point.
function polyRadius(poly, cx = 0, cz = 0) {
  const Q = poly.map(([x, z]) => [x - cx, z - cz]);
  return a => {
    const dx = Math.cos(a), dz = Math.sin(a);
    let best = Infinity;
    for (let i = 0; i < Q.length; i++) {
      const [x1, z1] = Q[i], [x2, z2] = Q[(i + 1) % Q.length], ex = x2 - x1, ez = z2 - z1, den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-9) continue;
      const t = (x1 * ez - z1 * ex) / den, u = (x1 * dz - z1 * dx) / den;
      if (t > 0 && u >= -1e-6 && u <= 1 + 1e-6) best = Math.min(best, t);
    }
    return best === Infinity ? 0.5 : best;
  };
}
// A periodic function of angle with values in about [-1, 1]: a few low harmonics.
function periodicA(rnd, terms = 4) {
  const T = []; for (let k = 1; k <= terms; k++) T.push([k + (k > 2 ? Math.floor(rnd() * 2) : 0), rnd() * TAU, (0.5 + rnd()) / k]);
  const nrm = T.reduce((m, t) => m + t[2], 0) * 0.62;
  return a => { let v = 0; for (const [k, p, w] of T) v += Math.sin(k * a + p) * w; return Math.max(-1, Math.min(1, v / nrm)); };
}
// A rectangle (half-sizes hx along the axis at angle rot, hz across it, centred at (ox, oz) in that
// axis frame) as an angular polygon: every corner chamfered (one or two facets), every side broken
// into two or three facets that wander a few centimetres in and out. Local frame points.
function boxPoly(rnd, hx, hz, rot, { ox = 0, oz = 0, cham = [0.12, 0.3], wob = 0.04, two = 0.4 } = {}) {
  const c = Math.cos(rot), s = Math.sin(rot), pts = [];
  const put = (u, v) => pts.push([(ox + u) * c - (oz + v) * s, (ox + u) * s + (oz + v) * c]);
  const corners = [[hx, -hz], [hx, hz], [-hx, hz], [-hx, -hz]];
  for (let k = 0; k < 4; k++) {
    const [u0, v0] = corners[k], [u1, v1] = corners[(k + 1) % 4];
    const L = Math.hypot(u1 - u0, v1 - v0), du = (u1 - u0) / L, dv = (v1 - v0) / L, nu = dv, nv = -du;   // nu, nv: outward
    const ca = Math.min(range(rnd, cham[0], cham[1]), L * 0.3), cb = Math.min(range(rnd, cham[0], cham[1]), L * 0.3);
    put(u0 + du * ca, v0 + dv * ca);
    const nMid = L > 1.6 ? 2 : 1;
    for (let q = 1; q <= nMid; q++) { const t = q / (nMid + 1) + range(rnd, -0.08, 0.08), w = range(rnd, -wob, wob * 0.6); put(u0 + du * L * t + nu * w, v0 + dv * L * t + nv * w); }
    put(u1 - du * cb, v1 - dv * cb);
    // a two-facet chamfer now and then: a point a little out from the cut's middle
    if (rnd() < two) { const [u2, v2] = corners[(k + 2) % 4], e = Math.hypot(u2 - u1, v2 - v1), eu = (u2 - u1) / e, ev = (v2 - v1) / e, cc = Math.min(cb, ca) * 0.5;
      put(u1 - du * cc * 0.6 + eu * cc * 0.6, v1 - dv * cc * 0.6 + ev * cc * 0.6); }
  }
  return pts;
}
// A round footprint as an angular polygon of N facets whose middles lie at about radius r (corners a
// little proud), radii jittered; stretched by sx along x.
function roundPoly(rnd, N, r, { jit = 0.04, sx = 1, ox = 0, oz = 0, proud = 1 } = {}) {
  const a0 = rnd() * TAU, out = [], k = Math.pow(1 / Math.cos(Math.PI / N), proud);
  for (let i = 0; i < N; i++) { const a = a0 + (i + range(rnd, -0.18, 0.18)) * TAU / N, rr = r * k * range(rnd, 1 - jit, 1 + jit); out.push([ox + Math.cos(a) * rr * sx, oz + Math.sin(a) * rr]); }
  return out;
}

// One layered rock: a wall swept round a plan from a buried foot to a rim, with the day's hard beds
// standing proud as lips (crisp, lit, chamfered on top) over undercuts, vertical joints notched in
// (some only part of the way up), a slight batter, an optional overhanging cap and a wind-cut foot, and
// a top surface in rings to the middle. Rows sit on the bed heights so the lips stay crisp; normals are
// creased at ~38 degrees (shared vertices). Polar about (cx, cz) in the ctx frame.
//   o: plan(a); rimY(a); topAt(x, z) (ctx-frame x, z); yB; beds [{y0, y1}]; lip, uc, ucH; joints
//      [{a, w, d, ya, yb, ph}] (w, d in metres); batter (m per m above 1 m); capOut(a) above capY0;
//      foot {d, h}; chamfer; angles (extra columns: the plan's corners); NA; ground(x, z); tint, aoLo, lipK
// Returns the columns { a, R0, gl, x, z } (for the dust bank round the foot).
function strataRock(ctx, b, o) {
  const cx = o.cx || 0, cz = o.cz || 0, gnd = o.ground || ((x, z) => ctx.gh(x, z));
  const NA = o.NA || 40, raw = [];
  for (let j = 0; j < NA; j++) raw.push(j / NA * TAU);
  for (const a of o.angles || []) raw.push(a);
  for (const J of o.joints || []) { const dA = J.w / Math.max(0.3, o.plan(J.a)); for (const k of [-1.4, -0.55, 0, 0.55, 1.4]) raw.push(J.a + k * dA); }
  const ang = raw.map(a => ((a % TAU) + TAU) % TAU).sort((p, q) => p - q);
  const A = ang.filter((a, i) => i === 0 || a - ang[i - 1] > 0.006);
  if (A.length > 3 && TAU - A[A.length - 1] + A[0] < 0.006) A.pop();
  const cols = A.map(a => { const R0 = o.plan(a), x = cx + Math.cos(a) * R0, z = cz + Math.sin(a) * R0; return { a, R0, x, z, gl: gnd(cx + Math.cos(a) * R0 * 0.96, cz + Math.sin(a) * R0 * 0.96), yt: o.rimY(a, x, z) }; });
  let gMin = Infinity, tMax = -Infinity;
  for (const c of cols) { gMin = Math.min(gMin, c.gl); tMax = Math.max(tMax, c.yt); }
  // the shared rows: on and round every bed, filled in to <= 0.3 m apart
  const ucH = o.ucH ?? 0.2, lip = o.lip ?? 0.1, uc = o.uc ?? 0.12, bat = o.batter ?? 0, ch = o.chamfer ?? 0.07, ph = rngOf(seedOf(ctx.base.x + cx, ctx.base.z + cz, 41))() * 20;
  const lo = gMin + 0.06, hi = Math.max(lo + 0.05, tMax - 0.26);
  let F = [lo, hi];
  for (const bd of o.beds || []) { const c2 = Math.min(0.06, (bd.y1 - bd.y0) * 0.35); F.push(bd.y0 - ucH, bd.y0 - ucH * 0.45, bd.y0 - 0.025, bd.y0 + 0.015, bd.y1 - c2, bd.y1); }
  for (const y of o.rows || []) F.push(y);
  F = F.filter(y => y >= lo && y <= hi).sort((p, q) => p - q);
  const L = [];
  for (let i = 0; i < F.length; i++) {
    if (i > 0) { const gap = F[i] - F[i - 1], m = Math.floor(gap / 0.3); for (let k = 1; k <= m; k++) L.push(F[i - 1] + gap * k / (m + 1)); }
    if (i === 0 || F[i] - F[i - 1] > 0.008) L.push(F[i]);
  }
  L.sort((p, q) => p - q);
  const rowYs = c => {
    const a = c.gl + 0.06, z = Math.max(a, c.yt - 0.26);
    const ys = [o.yB ?? Math.min(-0.5, gMin - 0.45), c.gl - 0.14, c.gl + 0.03, ...L.map(y => Math.max(a, Math.min(z, y))), c.yt - 0.2, c.yt - 0.08, c.yt];
    // where the ground stands above the rim (a block whose back runs into a slope) the column stays
    // under its rim, so nothing pokes out of the slope there
    if (c.yt < c.gl + 0.3) for (let i = 0; i < ys.length; i++) ys[i] = Math.min(ys[i], c.yt - 0.002 * (ys.length - 1 - i));
    return ys;
  };
  // every stratum (between two hard beds) has its own outline, a few centimetres in or out of the
  // plan here and there (the strata weather back unevenly: the walls step, never one sheer box), and
  // every lip comes and goes along its length
  const beds = o.beds || [], tierA = o.tierAmp ?? 0;
  const tierF = [], lipF = [];
  { const r2 = rngOf(seedOf(ctx.base.x + cx, ctx.base.z + cz, 43)); for (let t = 0; t <= beds.length; t++) tierF.push(periodicA(r2, 4)); for (let t = 0; t < beds.length; t++) lipF.push(periodicA(r2, 3)); }
  const tierAt = (a, y) => { let t = 0; for (const bd of beds) if (y > (bd.y0 + bd.y1) / 2) t++; return tierF[t](a); };
  const rAt = (c, y, kind) => {
    const h = y - c.gl;
    let dr = bat * ((o.batY ?? 1) - Math.max(0, h));
    if (tierA) dr += tierA * tierAt(c.a, y);
    beds.forEach((bd, t) => {
      const lk = 0.75 + 0.6 * lipF[t](c.a);
      dr += lip * Math.max(0.1, lk) * smooth(bd.y0 - 0.02, bd.y0 + 0.012, y) * (1 - 0.55 * smooth(bd.y1 - 0.05, bd.y1 + 0.004, y)) * (1 - smooth(bd.y1, bd.y1 + 0.02, y));
      if (y < bd.y0) dr -= uc * Math.max(0.3, lk) * Math.exp(-(((bd.y0 - y) / ucH) ** 2) * 1.4);
    });
    for (const J of o.joints || []) {
      const fade = smooth(J.ya - 0.12, J.ya + 0.05, y) * (1 - smooth(J.yb - 0.05, J.yb + 0.12, y));
      if (fade <= 0) continue;
      const da = angDiff(c.a, J.a + 0.02 * Math.sin(y * 2.7 + J.ph)) * c.R0, jw = J.w * (1 - (J.taper || 0) * (1 - clamp01((y - J.ya) / Math.max(0.1, J.yb - J.ya))));
      dr -= J.d * fade * Math.pow(Math.max(0, 1 - da / jw), 1.5);
      // the block on one side of the joint stands a little proud of the other (a stepped face)
      if (J.off) { const sd = Math.sin(c.a - J.a) * c.R0; dr += J.off * fade * smooth(-J.w * 0.6, J.w * 0.6, sd) * smooth(J.w * 6, J.w * 2, Math.abs(sd)); }
    }
    if (o.capOut) dr += o.capOut(c.a) * smooth(o.capY0, o.capY0 + 0.25, y);
    if (o.foot) dr -= o.foot.d * (1 - smooth(c.gl + 0.02, c.gl + o.foot.h, y));
    if (kind === 2) dr -= ch; else if (kind === 1) dr -= ch * 0.3;
    dr += (o.noise ?? 0.016) * noise3(Math.cos(c.a) * 2.3, y * 1.7, Math.sin(c.a) * 2.3, ph);
    return Math.max(c.R0 * 0.3, c.R0 + dr);
  };
  const P = [], rows = [], colOf = [], NC = cols.length;
  let NR = 0;
  cols.forEach((c, j) => {
    const ys = rowYs(c); NR = ys.length;
    ys.forEach((y, r) => {
      const kind = r === NR - 1 ? 2 : r === NR - 2 ? 1 : 0, R = rAt(c, y, kind);
      (rows[r] = rows[r] || []).push(P.length); colOf.push(j);
      P.push(new V3(cx + Math.cos(c.a) * R, y, cz + Math.sin(c.a) * R));
    });
  });
  const idx = [];
  for (let r = 0; r < NR - 1; r++) for (let j = 0; j < NC; j++) {
    const a = rows[r][j], bb = rows[r][(j + 1) % NC], c = rows[r + 1][j], d = rows[r + 1][(j + 1) % NC];
    idx.push(a, c, bb, bb, c, d);
  }
  // the top: the rim, rings in toward the middle on the top surface
  const rim = rows[NR - 1], rings = [rim];
  for (const fr of [0.82, 0.56, 0.28]) {
    const ring = [];
    for (let j = 0; j < NC; j++) {
      const q = P[rim[j]], x = cx + (q.x - cx) * fr, z = cz + (q.z - cz) * fr;
      ring.push(P.length); colOf.push(-1);
      P.push(new V3(x, o.topAt(x, z) + (cols[j].yt - o.topAt(cols[j].x, cols[j].z)) * smooth(0.5, 1, fr) + 0.012 * noise3(x * 1.7, 0.3, z * 1.7, ph + 3), z));
    }
    rings.push(ring);
  }
  const mid = P.length; colOf.push(-1); P.push(new V3(cx, o.topAt(cx, cz) + 0.01, cz));
  for (let q = 0; q < rings.length - 1; q++) for (let j = 0; j < NC; j++) {
    const a = rings[q][j], bb = rings[q][(j + 1) % NC], c = rings[q + 1][j], d = rings[q + 1][(j + 1) % NC];
    idx.push(a, c, bb, bb, c, d);
  }
  const last = rings[rings.length - 1];
  for (let j = 0; j < NC; j++) idx.push(last[j], mid, last[(j + 1) % NC]);
  const tint = o.tint || WHITE, aoLo = o.aoLo ?? 0.5, lipK = o.lipK ?? 1.08;
  // jShade: every joint is a soft cool shadow wedge (deepest in its middle, fading out across its
  // width and toward its ends) with a warm lit edge along the side that faces the light
  const SHADE = [0.8, 0.8, 0.94], WARM = [1.2, 1.12, 1.0];
  const jointTone = (c, y) => {
    let sh = 0, lt = 0;
    for (const J of o.joints || []) {
      const fade = smooth(J.ya - 0.1, J.ya + 0.15, y) * (1 - smooth(J.yb - 0.15, J.yb + 0.1, y));
      if (fade <= 0) continue;
      const da = Math.atan2(Math.sin(c.a - J.a), Math.cos(c.a - J.a)) * c.R0, w = J.w * (1 - (J.taper || 0) * (1 - clamp01((y - J.ya) / Math.max(0.1, J.yb - J.ya))));
      sh = Math.max(sh, fade * Math.pow(clamp01(1 - Math.abs(da) / (w * 1.25)), 0.8));
      const q = (((J.lit ?? 1) * da) / w - 1.45) / 0.45;
      lt = Math.max(lt, fade * Math.exp(-q * q));
    }
    return [sh, lt];
  };
  creasedShared(b, P, idx, (p, n, vi) => {
    const j = colOf[vi], g = j >= 0 ? cols[j].gl : gMin;
    let k = aoLo + (1 - aoLo) * smooth(-0.1, 1.2, p.y - g);
    if (n.y < -0.2) k *= 0.74;                                        // under the lips
    else if (n.y > 0.5 && p.y - g > 0.25) k *= lipK;                  // the lips' and the top's lit faces
    let c = mulc(tint, k * (0.92 + 0.1 * Math.max(0, n.y)));
    if (o.jShade && j >= 0) {
      const [sh, lt] = jointTone(cols[j], p.y);
      if (sh > 0) c = mul3(c, mulc(mixc(WHITE, SHADE, sh), 1 - 0.22 * sh));
      if (lt > 0) c = mul3(c, mixc(WHITE, WARM, lt));
    }
    return c;
  }, Math.cos(38 * Math.PI / 180));
  return cols;
}

// A bank of the day's own dust or sand heaped round a rock's foot: the terrain's ground texture, mapped
// like the terrain and carrying its tint and occlusion (terrainTintAt), from up the rock's wall out to
// under the ground, so the rock stands in the ground with no line or sock at its foot. cols from
// strataRock; hIn(a) the bank's height at the wall, wOut(a) its reach.
function dustBank(ctx, cols, hIn, wOut, cx = 0, cz = 0, { aoK = 1, flat = false } = {}) {
  const b = ctx.b('apron'), W = ctx.W, S = ctx.biome === 'desert' || ctx.biome === 'snow' ? 8 : 7, NC = cols.length;
  const xf = ctx.xf, wp = new V3();
  // the terrain's tint, sampled on 12 bearings at two radii and blended between them (cheap)
  const tintOK = typeof TERRAIN.terrainTintAt === 'function' && W.heights && W.nx;
  const T = [];
  for (let k = 0; k < 12; k++) {
    const a = k / 12 * TAU, row = [];
    for (const f of [0.3, 1]) {
      let c = [1, 1, 1];
      if (tintOK) { const R = cols[Math.round(k / 12 * NC) % NC].R0 + f * wOut(a); wp.set(cx + Math.cos(a) * R, 0, cz + Math.sin(a) * R).applyMatrix4(xf); try { const t = TERRAIN.terrainTintAt(W, wp.x, wp.z); c = [t.r, t.g, t.b]; } catch { /* keep white */ } }
      row.push(c);
    }
    T.push(row);
  }
  const tintAt = (a, f) => {
    const u = (((a / TAU) % 1) + 1) % 1 * 12, k = Math.floor(u), t = u - k, A = T[k % 12], B = T[(k + 1) % 12], m = f < 0.6 ? 0 : 1;
    return [0, 1, 2].map(i => A[m][i] * (1 - t) + B[m][i] * t);
  };
  // [reach, height, occlusion, opacity]: opaque against the wall, gone by the outer edge
  const RINGS = [[-0.1, 1, 0.72, 1], [0.1, 0.8, 0.8, 1], [0.36, 0.42, 0.9, 0.8], [0.68, 0.13, 0.97, 0.3], [1, -0.04, 1, 0]].map(([f, h, ao, op]) => [f, h, 1 - (1 - ao) * aoK, op]);
  const P = [], C = [], UV = [], OP = [];
  for (const [f, hk, ao, op] of RINGS) {
    for (const c of cols) {
      const w = wOut(c.a), R = c.R0 + f * w, x = cx + Math.cos(c.a) * R, z = cz + Math.sin(c.a) * R;
      const g = f <= 0 ? Math.max(c.gl, ctx.gh(x, z)) : ctx.gh(x, z);
      // flat: the bank lies only where the ground is gentle (none smeared up a wall)
      const fk = flat ? smooth(0.95, 0.4, Math.hypot(ctx.gh(x + 0.5, z) - ctx.gh(x - 0.5, z), ctx.gh(x, z + 0.5) - ctx.gh(x, z - 0.5))) : 1;
      const y = g + hk * hIn(c.a) * fk;
      P.push(new V3(x, y, z)); OP.push(op * fk);
      wp.set(x, y, z).applyMatrix4(xf); UV.push([wp.x / S, wp.z / S]);
      C.push(mulc(tintAt(c.a, f), ao));
    }
  }
  const idx = [];
  for (let r = 0; r < RINGS.length - 1; r++) for (let j = 0; j < NC; j++) {
    const a = r * NC + j, bb = r * NC + (j + 1) % NC, c = (r + 1) * NC + j, d = (r + 1) * NC + (j + 1) % NC;
    idx.push(a, bb, c, bb, d, c);
  }
  let vi = 0;
  b.cf = () => OP[vi++];
  mesh(b, P, idx, { uv: (p, n, i) => UV[i], color: (p, n, i) => C[i] });
  b.cf = null;
}

// A Badlands ledge: a block of the canyon's own strata broken off the walls and weathered into a
// stepped little butte. The base tier stands on the collider's footprint (an angular polygon, its
// vertical corners chamfered in one or two big facets) up through the bumper band; each tier above is
// 5-12% smaller and set toward one side, so one face climbs almost sheer while the other steps back in
// terraces, and its foot is undercut into a dark notch over the terrace below; the tiers are of
// uneven height (snapped onto the painted hard beds when one lies near, so a terrace's edge is a lit
// cream lip) and each is turned a few degrees from the one under it, so no corner or joint lines up.
// The top tier is the caprock: overhanging, a corner or two knocked out of its rim, notched where
// joints cut it, with a block or two of the next bed still standing on it (the skyline steps). Joints
// are soft cool wedges with a warm lit edge (vertex colour), not pen lines. Round the foot: a bank of
// ochre dust in the ground's own texture, fallen blocks and scree.
function ledgeRock(ctx, b, S, rnd, tint, col, steep, piece) {
  const bm = ctx.biome, by = ctx.base.y;
  let rot, hx, hz, top;
  if (col.box) ({ hx, hz, rot, top } = col.box);
  else if (col.cyl) { hx = col.cyl.r * 1.12; hz = col.cyl.r * 0.88; rot = rnd() * TAU; top = col.cyl.top; }
  else { hx = S * range(rnd, 0.95, 1.15); hz = hx * range(rnd, 0.5, 0.7); rot = rnd() * TAU; top = S * range(rnd, 0.6, 0.9); }
  const solid = !!(col.box || col.cyl), sc = Math.min(1, Math.max(0.6, S / 2));
  const [gLo] = ctx.foot(Math.max(hx, hz), 0, 0, 9), g0 = ctx.gh(0, 0);
  // the tiers' tops
  const H = top - g0, nT = H > 2.25 ? 3 : H > 1.45 ? 2 : 1;
  const fr = nT === 3 ? [range(rnd, 0.5, 0.6), range(rnd, 0.76, 0.84)] : nT === 2 ? [range(rnd, 0.6, 0.7)] : [];
  const hard = bedsIn(bm, by, gLo - 0.5, top + 1.5);
  const tops = [];
  for (const f of fr) {
    let y = g0 + Math.max(1.15, H * f);
    let bd = null; for (const q of hard) if (!bd || Math.abs(q.y1 - y) < Math.abs(bd.y1 - y)) bd = q;
    if (bd && Math.abs(bd.y1 - y) < 0.24) y = bd.y1;
    if (y > (tops.length ? tops[tops.length - 1] : g0 + 0.9) + 0.4 && y < top - 0.42) tops.push(y);
  }
  tops.push(top);
  const su = rnd() < 0.5 ? -1 : 1, sv = rnd() < 0.5 ? -1 : 1;                 // the corner the tiers step toward
  const tTint = [WHITE, pick(rnd, ['#fff2e8', '#ffe6d6', '#f8ece4']), pick(rnd, ['#f6e4d8', '#fff0e2', '#f2dccc'])].map(lin);
  const capF = periodicA(rnd, 3);
  let px = 0, pz = 0, phx = hx, phz = hz, prot = rot, below = null, cols0 = null, capT = null;
  for (let t = 0; t < tops.length; t++) {
    const cap = t === tops.length - 1, yT = tops[t], yLo = t ? tops[t - 1] : g0;
    let thx = phx, thz = phz, ox = px, oz = pz, trot = prot;
    if (t > 0) {
      // 5-12% smaller, and never by less than a terrace you can see (a narrow block steps in 15-25%)
      thx = phx - Math.max(phx * range(rnd, 0.06, 0.12), range(rnd, 0.2, 0.34)); thz = phz - Math.max(phz * range(rnd, 0.07, 0.14), range(rnd, 0.18, 0.3));
      const u2 = t === 2 && rnd() < 0.35 ? -su : su;
      ox = px + u2 * (phx - thx) * range(rnd, 0.55, 0.85); oz = pz + sv * (phz - thz) * range(rnd, 0.3, 0.8);
      trot = prot + range(rnd, -0.07, 0.07);
    }
    const cr = Math.cos(trot), sr = Math.sin(trot), cx = ox * cr - oz * sr, cz = ox * sr + oz * cr;
    const chamK = Math.min(1, thz / 1.15);
    // the base tier: the collider's footprint, its corners cut hard; the tiers above: irregular
    // rounded polygons (weathered back, no box corners left)
    const poly = t ? roundPoly(rnd, 9 + Math.floor(rnd() * 3), thz, { jit: 0.11, sx: thx / thz, proud: 0.4 }).map(([x, z]) => [cx + x * Math.cos(trot) - z * Math.sin(trot), cz + x * Math.sin(trot) + z * Math.cos(trot)])
      : boxPoly(rnd, thx, thz, trot, { ox, oz, cham: [0.36, 0.6].map(v => v * chamK), wob: 0.08, two: 0.9 });
    const plan = polyRadius(poly, cx, cz), angles = poly.map(([x, z]) => Math.atan2(z - cz, x - cx));
    const tilt = range(rnd, 0.03, 0.06), ta = rnd() * TAU;
    // the cap: one or two corners knocked out of the rim (flat-bottomed bites)
    const bites = [];
    if (cap) for (let k = 0; k < 1 + (rnd() < 0.55 ? 1 : 0); k++) bites.push({ a: angles[Math.floor(rnd() * angles.length)] + range(rnd, -0.15, 0.15), w: range(rnd, 0.24, 0.42), d: range(rnd, 0.2, 0.36) * Math.min(1, (yT - yLo) / 0.8) });
    const bite = a => bites.reduce((m, q) => Math.max(m, q.d * smooth(q.w + 0.06, q.w - 0.06, angDiff(a, q.a))), 0);
    const topAt = (x, z) => {
      const a = Math.atan2(z - cz, x - cx), rr = Math.hypot(x - cx, z - cz) / Math.max(0.3, plan(a));
      return yT + 0.01 + tilt * ((x - cx) * Math.cos(ta) + (z - cz) * Math.sin(ta)) + 0.03 * noise3(x * 0.9, 1.3 + t, z * 0.9, hx) - bite(a) * smooth(0.45, 0.85, rr);
    };
    // joints: 1-3 per tier, wide soft wedges, some only part of the way up; the cap's cut its rim
    const joints = [];
    for (let k = 0, n = (t ? 1 : 2) + Math.floor(rnd() * 2); k < n; k++) {
      const full = rnd() < 0.5, ya = full ? yLo - 0.25 : range(rnd, yLo + 0.1, yLo + (yT - yLo) * 0.5), yb = full || rnd() < 0.6 ? yT + 0.25 : range(rnd, ya + 0.35, yT - 0.08);
      // (a shallow notch, so the faces stay smooth across it: the soft wedge of shadow is the vertex colour's)
      joints.push({ a: rnd() * TAU, w: range(rnd, 0.24, 0.42) * sc, d: range(rnd, 0.06, 0.1) * sc, ya, yb, ph: rnd() * 6, off: range(rnd, -0.05, 0.05) * sc, lit: rnd() < 0.5 ? 1 : -1, taper: range(rnd, 0.5, 0.75) });
    }
    const notch = a => joints.reduce((m, J) => m + (J.yb > yT ? J.d * 0.8 * Math.max(0, 1 - angDiff(a, J.a) * plan(J.a) / (J.w * 1.5)) : 0), 0);
    const ft = t ? { d: range(rnd, 0.1, 0.15) * sc, h: range(rnd, 0.12, 0.18) } : null;
    const lo = t ? yLo : gLo;
    const cols = strataRock(ctx, b, {
      cx, cz, plan, angles, joints, topAt, rimY: (a, x, z) => topAt(x, z) - notch(a),
      ground: t ? (x, z) => below(x, z) - 0.02 : undefined, yB: t ? yLo - 0.22 : Math.min(-0.5, gLo - 0.45),
      beds: bedsIn(bm, by, lo + 0.2, yT - 0.2), NA: t ? 34 : (solid ? 44 : 32),
      lip: 0.085 * sc, uc: 0.11 * sc, ucH: 0.16 * sc, batter: t ? 0.09 : 0.12, batY: 0.7, chamfer: 0.07 * sc, tierAmp: (t ? 0.09 : 0.06) * sc, noise: 0.035,
      foot: ft, rows: ft ? [yLo + ft.h * 0.35, yLo + ft.h * 0.75, yLo + ft.h * 1.2] : [],
      capOut: cap ? (a => Math.max(0, 0.05 + 0.06 * capF(a)) + 0.12 * Math.pow(Math.max(0, Math.cos(a - trot - (su < 0 ? Math.PI : 0))), 3)) : (a => 0.035 + 0.025 * capF(a + t)),
      capY0: cap ? Math.max(yLo + 0.1, yT - 0.32) : yT - 0.16,
      tint: mul3(tint, tTint[Math.min(t, 2)]), aoLo: t ? 0.72 : 0.5, lipK: 1.1, jShade: true,
    });
    if (t === 0) cols0 = cols;
    below = topAt; px = ox; pz = oz; phx = thx; phz = thz; prot = trot;
    if (cap) capT = { cx, cz, thx, thz, trot, topAt, yT, plan };
  }
  // a block or two of the next bed still standing on the cap, set back from its rim (the skyline steps)
  if (solid && top > 1.6) {
    const nB = rnd() < 0.7 ? 1 : 0, end0 = rnd() < 0.5 ? 1 : -1;
    for (let k = 0; k < nB; k++) {
      const e = (k ? -end0 : end0) * range(rnd, 0.25, 0.5) * capT.thx, w2 = capT.thx * range(rnd, 0.28, 0.42) * (k ? 0.75 : 1), d2 = capT.thz * range(rnd, 0.45, 0.65);
      const off = range(rnd, -0.2, 0.2) * capT.thz, cr = Math.cos(capT.trot), sr = Math.sin(capT.trot);
      const c2x = capT.cx + e * cr - off * sr, c2z = capT.cz + e * sr + off * cr;
      const poly2 = roundPoly(rnd, 6 + Math.floor(rnd() * 2), d2, { jit: 0.15, sx: w2 / d2 }).map(([x, z]) => [c2x + x * cr - z * sr, c2z + x * sr + z * cr]);
      const g2 = capT.topAt(c2x, c2z), h2 = range(rnd, 0.5, 0.8) * sc, tb = rnd() * TAU;
      const topAt2 = (x, z) => g2 + h2 + 0.06 * ((x - c2x) * Math.cos(tb) + (z - c2z) * Math.sin(tb)) + 0.03 * noise3(x * 1.1, 2.1, z * 1.1, hz);
      strataRock(ctx, b, {
        cx: c2x, cz: c2z, plan: polyRadius(poly2, c2x, c2z), rimY: (a, x, z) => topAt2(x, z), topAt: topAt2, angles: poly2.map(([x, z]) => Math.atan2(z - c2z, x - c2x)),
        beds: bedsIn(bm, by, g2 + 0.05, g2 + h2 - 0.1), ground: (x, z) => capT.topAt(x, z) - 0.02, yB: g2 - 0.25, NA: 24,
        lip: 0.05 * sc, uc: 0.07 * sc, ucH: 0.12, batter: 0.16, batY: 0.2, chamfer: 0.1 * sc, tierAmp: 0.05, noise: 0.03,
        foot: { d: 0.08 * sc, h: 0.14 }, rows: [g2 + 0.06, g2 + 0.12], capOut: a => 0.025 + 0.025 * Math.sin(3 * a + tb), capY0: g2 + h2 - 0.12,
        joints: rnd() < 0.5 ? [{ a: rnd() * TAU, w: 0.14 * sc, d: 0.1 * sc, ya: g2 - 0.1, yb: g2 + h2 + 0.2, ph: 1, lit: 1 }] : [],
        tint: mul3(tint, tTint[2]), aoLo: 0.8, lipK: 1.1, jShade: true,
      });
    }
  }
  if (steep) return;
  // the low broken shelf off one end (under the step height: no collider)
  if (rnd() < 0.7) {
    const uw = range(rnd, 0.35, 0.6) * Math.min(1.4, hx * 0.4), vh = hz * range(rnd, 0.45, 0.7), off = range(rnd, -0.25, 0.25) * hz;
    const ox = -su * (hx + uw * 0.7), poly3 = boxPoly(rnd, uw, vh, rot, { ox, oz: off, cham: [0.1, 0.2], wob: 0.04 });
    const c3x = ox * Math.cos(rot) - off * Math.sin(rot), c3z = ox * Math.sin(rot) + off * Math.cos(rot);
    const g3 = ctx.foot(Math.max(uw, vh), c3x, c3z, 7)[1], h3 = range(rnd, 0.28, 0.4);
    const topAt3 = (x, z) => g3 + h3 + 0.02 * noise3(x * 1.3, 0.7, z * 1.3, uw);
    const cols3 = strataRock(ctx, b, { cx: c3x, cz: c3z, plan: polyRadius(poly3, c3x, c3z), rimY: (a, x, z) => topAt3(x, z), topAt: topAt3, angles: poly3.map(([x, z]) => Math.atan2(z - c3z, x - c3x)), beds: [], NA: 24, chamfer: 0.06, batter: 0.12, noise: 0.03, tint, aoLo: 0.55 });
    dustBank(ctx, cols3, a => 0.07, a => 0.55, c3x, c3z);
  }
  // the dust bank round the foot: deeper under the long walls, with a drift or two
  const dp = [rnd() * TAU, rnd() * TAU];
  dustBank(ctx, cols0, a => (0.1 + 0.05 * Math.sin(2 * a + dp[0]) + 0.035 * Math.sin(3 * a + dp[1])) * Math.max(0.8, sc), a => (1.0 + 0.3 * Math.sin(2 * a + dp[1]) + 0.15 * Math.sin(5 * a + dp[0])) * Math.max(0.8, sc));
  // fallen blocks under the walls and at the ends (under the step height), and scree
  const plan0 = a => Math.hypot(Math.cos(a - rot) * hx, Math.sin(a - rot) * hz) * 0.9;
  const nB = 3 + Math.floor(rnd() * 3);
  for (let k = 0; k < nB; k++) {
    const a = k === 0 ? rot + (su > 0 ? 0 : Math.PI) + range(rnd, -0.4, 0.4) : rot + (k % 2 ? 1 : -1) * Math.PI / 2 + range(rnd, -0.9, 0.9);
    const R = range(rnd, 0.2, 0.38) * sc, dd = plan0(a) + R * 0.6 + range(rnd, 0.1, 0.7);
    const x = Math.cos(a) * dd, z = Math.sin(a) * dd;
    const sh = rockShape(rnd, { sx: range(rnd, 1.1, 1.5), sy: range(rnd, 0.55, 0.7), sides: 4, oblique: 2, topCut: [0.5, 0.7], topTilt: 0.25, noise: 0.1, detail: 1 });
    seatRock(ctx, b, sh, x, z, R, { yaw: rnd() * TAU, tilt: range(rnd, 0.1, 0.45), tiltA: rnd() * TAU, tint: mul3(tint, tTint[Math.floor(rnd() * 3)]), sink: R * 0.18, cos: Math.cos(30 * Math.PI / 180) });
  }
  rubble(ctx, b, 3 + Math.floor(rnd() * 4), Math.min(hx, hz) * 1.25, Math.max(hx, hz) * 1.25, rnd, tint, { size: [0.08, 0.2] });
}

// A Tanaris mound: a low outcrop of pale sandstone cut by the wind into the day's beds (thin lit lips
// over soft undercuts), its foot scoured in and half buried in a drift of the desert's own sand, its top
// rounded off, often a smaller tier sitting on it (the skyline steps), a joint or two, and blocks fallen
// off it lying in the sand. A solid one fills its collider's circle through the bumper band.
function moundRock(ctx, b, S, rnd, tint, col, steep, piece) {
  const bm = ctx.biome, by = ctx.base.y, solid = !!col.cyl;
  const r = solid ? col.cyl.r * 0.99 : S * range(rnd, 0.7, 0.95), top = solid ? col.cyl.top : S * range(rnd, 0.45, 0.72);
  const sx = solid ? 1 : range(rnd, 1.15, 1.45);
  const poly = roundPoly(rnd, solid ? 8 + Math.floor(rnd() * 3) : 6 + Math.floor(rnd() * 3), r, { jit: solid ? 0.045 : 0.1, sx, proud: solid ? 0.5 : 1 });
  const plan = polyRadius(poly), angles = poly.map(([x, z]) => Math.atan2(z, x));
  const dome = range(rnd, 0.06, 0.14) * Math.min(1.2, S), ta = rnd() * TAU;
  const topAt = (x, z) => top - 0.03 + dome * Math.max(0, 1 - (x * x / (sx * sx) + z * z) / (r * r)) + 0.03 * Math.sin(x * 0.9 + ta) * Math.cos(z * 0.8 - ta);
  const joints = [];
  for (let k = 0; k < 1 + Math.floor(rnd() * 2.5); k++) joints.push({ a: rnd() * TAU, w: range(rnd, 0.08, 0.14), d: range(rnd, 0.06, 0.11), ya: range(rnd, 0, top * 0.4), yb: top + 0.3, ph: rnd() * 6 });
  const [gLo] = ctx.foot(r * sx, 0, 0, 9);
  const cols = strataRock(ctx, b, {
    plan, angles, joints, topAt, rimY: (a, x, z) => topAt(x, z) - joints.reduce((m, J) => m + J.d * 0.6 * Math.max(0, 1 - angDiff(a, J.a) * r / (J.w * 1.6)), 0),
    beds: bedsIn(bm, by, gLo + 0.18, top - 0.12), NA: solid ? 40 : 28,
    lip: 0.07, uc: 0.1, ucH: 0.14, batter: 0.13, batY: 0.55, chamfer: 0.13, foot: { d: 0.13, h: 0.3 }, tierAmp: 0.05, noise: 0.025,
    tint, aoLo: 0.6, lipK: 1.06, yB: Math.min(-0.5, gLo - 0.4),
  });
  // a taller block to one side, its outer wall rising over the main one (the skyline steps up there)
  if (rnd() < (solid ? 0.75 : 0.35)) {
    const r2 = r * range(rnd, 0.42, 0.56), a = rnd() * TAU, d0 = (r - r2) * range(rnd, 0.75, 0.95), cx2 = Math.cos(a) * d0 * sx, cz2 = Math.sin(a) * d0, h2 = range(rnd, 0.28, 0.48) * Math.min(1.2, S);
    const poly2 = roundPoly(rnd, 7 + Math.floor(rnd() * 2), r2, { jit: 0.08, sx: range(rnd, 1, 1.3), ox: cx2, oz: cz2 });
    const t2 = topAt(cx2, cz2) - 0.04 + h2;
    const topAt2 = (x, z) => t2 + 0.07 * Math.max(0, 1 - ((x - cx2) ** 2 + (z - cz2) ** 2) / (r2 * r2)) + 0.02 * Math.sin(x * 1.7 + ta);
    strataRock(ctx, b, {
      cx: cx2, cz: cz2, plan: polyRadius(poly2, cx2, cz2), angles: poly2.map(([x, z]) => Math.atan2(z - cz2, x - cx2)), topAt: topAt2, rimY: (q, x, z) => topAt2(x, z),
      ground: (x, z) => topAt(x, z) - 0.03, yB: topAt(cx2, cz2) - 0.2, beds: bedsIn(bm, by, topAt(cx2, cz2) + 0.06, t2 - 0.08), NA: 24,
      lip: 0.05, uc: 0.06, ucH: 0.1, batter: 0.06, chamfer: 0.1, tierAmp: 0.04, noise: 0.02, tint: mulc(tint, 1.03), aoLo: 0.82,
    });
  }
  // a low broken shelf off another side (under the step height: no collider)
  if (!steep && rnd() < (solid ? 0.6 : 0.3)) {
    const a = rnd() * TAU, r3 = r * range(rnd, 0.35, 0.5), d3 = plan(a) + r3 * 0.45, c3x = Math.cos(a) * d3, c3z = Math.sin(a) * d3;
    const poly3 = roundPoly(rnd, 6 + Math.floor(rnd() * 2), r3, { jit: 0.1, sx: range(rnd, 1.1, 1.5), ox: c3x, oz: c3z });
    const g3 = ctx.foot(r3, c3x, c3z, 6)[1], h3 = range(rnd, 0.2, 0.36);
    const topAt3 = (x, z) => g3 + h3 + 0.02 * Math.sin(x * 2.1 + z);
    const cols3 = strataRock(ctx, b, { cx: c3x, cz: c3z, plan: polyRadius(poly3, c3x, c3z), angles: poly3.map(([x, z]) => Math.atan2(z - c3z, x - c3x)), topAt: topAt3, rimY: (q, x, z) => topAt3(x, z), beds: [], NA: 20, chamfer: 0.08, batter: 0.1, noise: 0.02, tint, aoLo: 0.6 });
    dustBank(ctx, cols3, () => 0.08, () => 0.5, c3x, c3z);
  }
  // the drift: sand heaped against the windward side, thin on the lee
  const wa = rnd() * TAU, k = Math.min(1.2, S);
  dustBank(ctx, cols, a => (0.16 + 0.18 * Math.max(0, Math.cos(a - wa)) + 0.04 * Math.sin(3 * a + wa)) * k, a => (0.85 + 0.55 * Math.max(0, Math.cos(a - wa)) + 0.15 * Math.sin(4 * a)) * k);
  if (steep) return;
  // blocks fallen off it, lying tipped in the sand, and a little rubble
  const nB = solid ? 2 + Math.floor(rnd() * 2) : 1 + Math.floor(rnd() * 2);
  for (let q = 0; q < nB; q++) {
    const a = wa + Math.PI + range(rnd, -1.6, 1.6), dd = plan(a) + range(rnd, 0.3, 0.8), R = range(rnd, 0.18, 0.3) * Math.min(1.3, S);
    piece(Math.cos(a) * dd, Math.sin(a) * dd, R, { sx: range(rnd, 1.2, 1.6), sy: range(rnd, 0.45, 0.65), sz: range(rnd, 0.8, 1), sides: 4, oblique: 2, topCut: [0.5, 0.68], topTilt: 0.2, sideCut: [0.6, 0.78], noise: 0.08, detail: 1 }, { tilt: range(rnd, 0.15, 0.45), tiltA: rnd() * TAU, sink: 0.38, cos: Math.cos(30 * Math.PI / 180) });
  }
  rubble(ctx, b, 1 + Math.floor(rnd() * 3), r * 1.2, r * 1.6, rnd, tint, { size: [0.08, 0.16], sy: 0.6 });
}

function badlandsRock(ctx, b, S, rnd, steep, tintOf, col, d, piece) {
  if (col.hoodoo) return hoodoo(ctx, b, rnd, col.hoodoo, tintOf());
  if (!col.big && piece) {
    // a small one: a broken, angular block of the canyon's sandstone (the strata are the material's),
    // tipped over, often with a thinner slab split off against it
    piece(0, 0, S * 0.8, { sx: range(rnd, 1.1, 1.5), sy: range(rnd, 0.6, 0.85), sz: range(rnd, 0.8, 1.0), sides: 4, oblique: 3, topCut: [0.5, 0.7], topTilt: 0.3, sideCut: [0.55, 0.75], noise: 0.1 }, { tilt: range(rnd, 0.05, 0.25), tiltA: rnd() * TAU, cos: Math.cos(30 * Math.PI / 180) });
    if (!steep && rnd() < 0.55) { const a = rnd() * TAU, dd = S * range(rnd, 0.75, 1.0); piece(Math.cos(a) * dd, Math.sin(a) * dd, S * range(rnd, 0.35, 0.5), { sx: 1.3, sy: 0.45, sides: 3, oblique: 2, topCut: [0.5, 0.7], topTilt: 0.2 }, { tilt: range(rnd, 0.2, 0.5), tiltA: a + Math.PI, cos: Math.cos(30 * Math.PI / 180) }); }
    if (!steep) rubble(ctx, b, 1 + Math.floor(rnd() * 3), S * 0.9, S * 1.4, rnd, tintOf());
    return;
  }
  ledgeRock(ctx, b, S, rnd, tintOf(), col, steep, piece);
}

// A Tanaris sandstone arch: a flat-topped slab bridge (a lintel at least twice as wide as it is thick,
// its top nearly level and wider than the legs, thinned off-centre and notched underneath by the wind)
// on two blocky legs stepped in sandstone layers that widen toward the base. The legs stand exactly
// on their colliders (±1.9 S along the rock's own x axis) through the bumper band; above it the
// heavier leg swells into the span. The span's underside and top follow world gen's span box (players
// walk under it, the RV doesn't). Swept as squared sections (soft corners), creased only at the steps.
function sandArch(ctx, b, S, rnd, tint, col) {
  const A = col.arch || { span: S * 1.9, r: S * 0.396 };
  const span = A.span, rL = A.r * 0.97;
  const H = Math.max(1.7 * S, 2.35 + 0.36 * S), under = H - 0.25 * S, topY = H + 0.35 * S;
  const heavy = rnd() < 0.5 ? -1 : 1;                         // the side of the heavier leg
  const aLint = 0.62 * S;                                     // the lintel's half-width (the legs' is about 0.38 S)
  const rho = Math.min(0.36 * S, under - 1.3);                 // the opening's corner radius (a squarish opening)
  const xThin = -heavy * range(rnd, 0.15, 0.45) * S, ph = rnd() * 9;
  const notches = [{ x: range(rnd, -0.9, 0.9) * S, w: range(rnd, 0.16, 0.28) * S, d: range(rnd, 0.08, 0.13) * S }];
  if (rnd() < 0.5) notches.push({ x: range(rnd, -0.9, 0.9) * S, w: range(rnd, 0.12, 0.2) * S, d: range(rnd, 0.06, 0.1) * S });
  const yU = x => under + 0.03 * S + 0.13 * S * Math.exp(-(((x - xThin) / (0.75 * S)) ** 2)) + notches.reduce((m, n) => m + n.d * Math.exp(-(((x - n.x) / n.w) ** 2)), 0);
  const xs = range(rnd, 0.3, 0.9) * S * (rnd() < 0.5 ? -1 : 1);   // a broken step in the top
  const yT = x => topY - 0.03 * S + 0.03 * S * Math.sin(x * 1.3 / S + ph) - 0.04 * S * Math.exp(-(((x - xThin) / (0.6 * S)) ** 2)) - 0.07 * S * smooth(-0.08 * S, 0.08 * S, (x - xs) * Math.sign(xs));
  const ends = [-1, 1].map(sd => ctx.foot(rL * 1.3, span * sd, 0, 7)[0]);
  const Z = new V3(0, 0, 1);
  const ribs = [];          // { c, e1, a1, a2 }: a section centred at c, half-extent a1 along e1 (in the xy plane) and a2 along z
  const rib = (inner, outer, a2, lump = 0.045, ex = 2 / 5) => { const c = inner.clone().add(outer).multiplyScalar(0.5), e1 = outer.clone().sub(inner); const a1 = e1.length() / 2; e1.normalize(); ribs.push({ c, e1, a1, a2, lump, ex }); };
  // a leg's layers, by height over its ground: a broad plinth (under the step height), a lower bed a
  // touch proud, the column on the collider, and (on the heavier leg) a swelling into the span
  // (the heavier leg swells only above the bumper band, so a low arch's hardly does)
  const ykRel = sd => yU(sd * (span - rL - rho)) - rho - ends[sd < 0 ? 0 : 1];
  const swell = sd => (sd === heavy ? 0.34 : 0.12) * smooth(1.8, 2.6, ykRel(sd));
  const legK = (h, sd) => {
    let k = 1.0;
    if (h < 0.22) k = 1.24; else if (h < 0.9) k = 1.05;
    const yk = ykRel(sd);
    k *= 1 + swell(sd) * smooth(Math.min(1.9, yk - 0.4), yk, h);
    return k * (1 + 0.025 * Math.sin(h * 9 + ph + sd) * (1 - smooth(1.4, 1.9, h)));   // wind-cut grooves
  };
  const legSteps = (g, yTop) => {
    const ys = [g - 0.5, g - 0.05, g + 0.18, g + 0.24, g + 0.56, g + 0.86, g + 0.92];
    for (let k = 1; k <= 4; k++) ys.push(g + 0.92 + (yTop - g - 0.92) * k / 4);
    return ys.filter((y, i, arr) => i === 0 || y > arr[i - 1] + 0.01);
  };
  const kTops = [-1, 1].map(sd => 1 + swell(sd));
  const xK = sd => sd * (span - rL * kTops[sd < 0 ? 0 : 1] - rho);     // the opening's corner centres
  const corner = (sd, a2Leg, kTop) => {
    // a quarter turn from the leg's inner face to the lintel's underside: the inner point runs round
    // the opening's rounded corner, the outer one round the squared outer corner
    const xc = xK(sd), Kc = new V3(xc, yU(xc) - rho, 0);
    const dx = 2 * rL * kTop / 0.9 * 0.9 + rho, dy = yT(xc) - Kc.y;
    for (let i = 0; i <= 6; i++) {
      const phi = (sd < 0 ? i : 6 - i) / 6 * Math.PI / 2, dir = new V3(sd * Math.cos(phi), Math.sin(phi), 0);
      const inner = Kc.clone().addScaledVector(dir, rho);
      const n = 8, d = Math.pow(Math.pow(Math.cos(phi) / dx, n) + Math.pow(Math.sin(phi) / dy, n), -1 / n);
      const outer = Kc.clone().addScaledVector(dir, d);
      rib(inner, outer, a2Leg + (aLint - a2Leg) * smooth(0, 1, phi / (Math.PI / 2)));
    }
  };
  // left leg up, the span, right leg down
  for (const sd of [-1, 1]) {
    const g = ends[sd < 0 ? 0 : 1], xc = xK(sd), yk = yU(xc) - rho;
    const legRibs = [];
    for (const y of legSteps(g, yk)) {
      const k = legK(y - g, sd), cx = sd * span;
      // the heavier leg swells outward and inward alike; its inner face meets the corner
      // the plinth: broken slabs, pushed out from under the opening (lumpy, off-centre)
      // (a blocky section: half-extents 0.9 r, the corners a little proud of the collider)
      const pl = y - g < 0.22, off = pl ? sd * 0.1 * rL : 0, kk = 0.9 * k;
      legRibs.push({ inner: new V3(cx - sd * rL * kk + off, y, 0), outer: new V3(cx + sd * rL * kk + off, y, 0), a2: rL * kk * (pl ? 0.94 : 1), lump: pl ? 0.15 : 0.05 });
    }
    const kTop = kTops[sd < 0 ? 0 : 1];
    if (sd < 0) {
      for (const r of legRibs) rib(r.inner, r.outer, r.a2, r.lump, 2 / 6);
      corner(-1, rL * kTop * 0.9, kTop * 0.9);
      const x0 = xK(-1), x1 = xK(1);
      for (let i = 1; i < 16; i++) { const x = x0 + (x1 - x0) * i / 16; rib(new V3(x, yU(x), 0), new V3(x, yT(x), 0), aLint * (1 + 0.05 * Math.sin(x * 2.1 / S + ph))); }
    } else {
      corner(1, rL * kTop * 0.9, kTop * 0.9);
      for (const r of legRibs.reverse()) rib(r.inner, r.outer, r.a2, r.lump, 2 / 6);
    }
  }
  // the sections: a squared ring (superellipse, soft corners) per rib
  const NS = 24, P = [], idx = [];
  for (const r of ribs) {
    const sp = v => Math.sign(v) * Math.pow(Math.abs(v), r.ex);
    for (let k = 0; k < NS; k++) {
      const th = (k + 0.5) / NS * TAU, c = Math.cos(th), sn = Math.sin(th);
      const lump = 1 + r.lump * noise3(r.c.x * 2.3 + c * 1.6, r.c.y * (r.lump > 0.08 ? 0.4 : 2.1), sn * 1.9, ph);
      P.push(r.c.clone().addScaledVector(r.e1, r.a1 * sp(c) * lump).addScaledVector(Z, r.a2 * sp(sn) * lump));
    }
  }
  // winding: outward faces (checked on the first section)
  const n0 = new V3().subVectors(P[1], P[0]).cross(new V3().subVectors(P[NS], P[0])), out0 = new V3().subVectors(P[0], ribs[0].c);
  const flip = n0.dot(out0) < 0;
  for (let i = 0; i < ribs.length - 1; i++) for (let k = 0; k < NS; k++) {
    const A0 = i * NS + k, B0 = i * NS + (k + 1) % NS, C0 = (i + 1) * NS + k, D0 = (i + 1) * NS + (k + 1) % NS;
    if (!flip) idx.push(A0, B0, C0, B0, D0, C0); else idx.push(A0, C0, B0, B0, C0, D0);
  }
  const gMin = Math.min(...ends);
  creased(b, P, idx, (p, nn) => {
    let k = 0.52 + 0.48 * smooth(gMin - 0.2, gMin + Math.min(2.2, under * 0.8), p.y);
    if (nn.y < -0.3) k *= 0.8;                       // under the span
    if (nn.y > 0.75) k *= 1.06;
    return mulc(tint, k * (0.9 + 0.12 * Math.max(0, nn.y)));
  }, faceData(P, idx), Math.cos(42 * Math.PI / 180));
  // slabs fallen against the feet, and rubble (under the step height)
  for (const sd of [-1, 1]) for (let k = 0; k < 1 + (rnd() < 0.6 ? 1 : 0); k++) {
    const a = (sd > 0 ? 0 : Math.PI) + range(rnd, -1.3, 1.3), R = 0.26 * S * range(rnd, 0.85, 1.1), dd = rL * range(rnd, 1.25, 1.5);
    const x = sd * span + Math.cos(a) * dd, z = Math.sin(a) * dd, [lo] = ctx.foot(R, x, z, 5);
    const sh = rockShape(rnd, { sx: range(rnd, 1.2, 1.5), sy: 0.36, sides: 4, oblique: 2, topCut: [0.55, 0.7], topTilt: 0.2, noise: 0.1, detail: 1 });
    placeRock(b, sh, new V3(x, lo + R * 0.08, z), R, { yaw: -a + range(rnd, -0.4, 0.4), tilt: range(rnd, 0.12, 0.28), tiltA: a + Math.PI / 2, tint, cos: Math.cos(30 * Math.PI / 180) });
  }
  rubble(ctx, b, 2 + Math.floor(rnd() * 3), span - rL * 2.6, span + rL * 2.6, rnd, tint, { size: [0.14, 0.26], sy: 0.6 });
}

// Tanaris: a wind-cut sandstone mound (moundRock), or a slab arch whose two feet stand exactly on
// their colliders.
function desertRock(ctx, b, S, rnd, steep, tintOf, piece, col, d) {
  if (col.arch || d.variant === 'arch') return sandArch(ctx, b, S, rnd, tintOf(), col);
  moundRock(ctx, b, S, rnd, tintOf(), col, steep, piece);
}

// ---- wall-foot rocks (Dun Morogh, Tanaris) --------------------------------------------------------
// World gen lays a big rock at the foot of the canyon walls every 40-60 m (d.foot), to break the line
// where the wall meets the floor. Its collider is a small cylinder on the floor at the wall's toe; the
// rock fills it there, and behind it bigger blocks lie lodged against the wall itself (the wall is too
// steep to walk, so they cost no invisible walls), their feet buried in the slope and drifted over.

// Which way the wall rises from the rock's centre, and how steeply: the highest ground on a ring.
function uphillOf(ctx, R = 2.4) {
  const h0 = ctx.gh(0, 0);
  let best = -Infinity, a0 = 0;
  for (let k = 0; k < 24; k++) { const a = k / 24 * TAU, h = ctx.gh(Math.cos(a) * R, Math.sin(a) * R); if (h > best) { best = h; a0 = a; } }
  return { a: a0, ux: Math.cos(a0), uz: Math.sin(a0), g: Math.max(0, best - h0) / R };
}
// A rock shape scaled, turned (yaw), tilted and set down at (x, z) so that its whole underside lies at
// or under the ground (the lowest-standing part of its foot sinks `sink`; on a slope the uphill part
// goes deep into it): a block resting in the ground, never floating over a slope. Emits it like
// placeRock; returns { P, idx, FD } (for a snow cap) and the placed points.
function seatRock(ctx, b, shape, x, z, R, { yaw = 0, tilt = 0, tiltA = 0, tint = WHITE, aoLo = 0.42, cos = COS_CREASE, sink = 0.06 } = {}) {
  const m = new THREE.Matrix4().makeRotationY(yaw);
  if (tilt) m.multiply(new THREE.Matrix4().makeRotationAxis(new V3(Math.cos(tiltA), 0, Math.sin(tiltA)), tilt));
  const P = shape.P.map(p => p.clone().multiplyScalar(R).applyMatrix4(m));
  let y0 = Infinity, y1 = -Infinity; for (const p of P) { y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
  // the underside: the lowest quarter of the rock
  let dy = Infinity;
  for (const p of P) if (p.y < y0 + (y1 - y0) * 0.25) dy = Math.min(dy, ctx.gh(x + p.x, z + p.z) - p.y);
  dy -= sink;
  for (const p of P) { p.x += x; p.z += z; p.y += dy; }
  const FD = faceData(P, shape.idx);
  creased(b, P, shape.idx, (p, n) => {
    const above = p.y - ctx.gh(p.x, p.z);                     // AO from the ground right under each point
    return mulc(tint, (aoLo + (1 - aoLo) * smooth(-0.05, Math.max(0.5, (y1 - y0) * R * 0.55), above)) * (0.9 + 0.12 * n.y));
  }, FD, cos);
  return { P, idx: shape.idx, FD };
}
// The outline a cluster of placed rocks makes where it meets the ground, as columns for dustBank (polar
// about (cx, cz); NB bearings): per bearing, the furthest rock point standing within `band` of the
// ground; empty bearings take their neighbours'.
function groundOutline(ctx, Ps, cx, cz, NB = 36, band = 0.3, rMin = 0.3) {
  const ext = new Array(NB).fill(0);
  for (const P of Ps) for (const p of P) {
    const above = p.y - ctx.gh(p.x, p.z);
    if (above > band || above < -0.25) continue;
    const a = Math.atan2(p.z - cz, p.x - cx), k = ((Math.round(a / TAU * NB) % NB) + NB) % NB, r = Math.hypot(p.x - cx, p.z - cz);
    ext[k] = Math.max(ext[k], r);
  }
  if (!ext.some(v => v > 0)) ext.fill(rMin);
  for (let k = 0; k < NB; k++) if (!ext[k]) {
    let i = 1; while (!ext[(k - i + NB) % NB] && i < NB) i++;
    let j = 1; while (!ext[(k + j) % NB] && j < NB) j++;
    ext[k] = (ext[(k - i + NB) % NB] * j + ext[(k + j) % NB] * i) / (i + j);
  }
  // a little smoothing round the ring (single far points would make spikes)
  const sm = ext.map((v, k) => Math.max(rMin, (ext[(k + NB - 1) % NB] + 2 * v + ext[(k + 1) % NB]) / 4 * 0.94));
  return sm.map((R0, k) => { const a = k / NB * TAU, x = cx + Math.cos(a) * R0, z = cz + Math.sin(a) * R0; return { a, R0, x, z, gl: ctx.gh(cx + Math.cos(a) * R0 * 0.96, cz + Math.sin(a) * R0 * 0.96) }; });
}

// Dun Morogh: a pile of the walls' own blue-gray granite (cliff_snow, snow on its up-facing faces) at
// the wall's toe: the collider's block (fitted to it; world gen puts it on the wall's lower slope), a big
// angular block seated over and behind it, its long side along the wall and its base tipped to the
// slope, often a tall slab leaning back on the wall beside it, a few loose chunks in front, snow
// pillowed thick on every top, and a drift banked against the front that fades into the ground (never
// smeared up the slope).
function footGranite(ctx, d, b, cap, col, rnd, tint, piece) {
  const S = col.S, s = d.s || 1, U = uphillOf(ctx), wall = U.g > 0.3;
  const r = col.cyl ? col.cyl.r : S * 0.8, top = col.cyl ? col.cyl.top : S * 0.7;
  const ux = wall ? U.ux : Math.cos(rnd() * TAU), uz = wall ? U.uz : Math.sin(rnd() * TAU), lx = -uz, lz = ux;
  const tiltK = wall ? Math.atan(U.g) : 0.15;
  const placed = [];
  // the collider's block: angular, filling the collider through the bumper band, its top on the
  // collider's (on a wall its back is buried in the slope)
  {
    const fit = r * 0.98, R0 = Math.min(S * 1.05, fit * 1.12);
    piece(0, 0, R0, { sx: range(rnd, 1.05, 1.25), sy: col.cyl ? top / (R0 * 0.66) * 0.96 : 0.75, sides: 4, oblique: 2, topCut: [0.6, 0.72], topTilt: 0.14, sideCut: [0.62, 0.78], noise: 0.09 }, { fit, topY: top, rec: placed });
  }
  // the big block lodged against the wall: its long side along the wall, its base tipped to the slope
  // (tilt > 0 tips its top toward the floor, < 0 leans it back on the wall)
  const block = (R, lat, back, { sx, sy, sz, tilt, k = 1, sink = 0.08 }) => {
    const sh = rockShape(rnd, { sx, sy, sz, sides: 4, oblique: 3, topCut: [0.56, 0.7], topTilt: 0.12, sideCut: [0.6, 0.76], noise: 0.08, detail: 2, bottom: 0.55 });
    const x = ux * back + lx * lat, z = uz * back + lz * lat;
    const yaw = Math.atan2(-lz, lx) + range(rnd, -0.25, 0.25);
    const rk = seatRock(ctx, b, sh, x, z, R, { yaw, tilt, tiltA: 0, tint: mulc(tint, k), sink, cos: Math.cos(32 * Math.PI / 180), aoLo: 0.55 });
    if (cap) snowCap(cap, rk, Math.min(0.28, 0.13 + 0.07 * R), 0.6);
    placed.push(rk.P);
    return rk;
  };
  const side = rnd() < 0.5 ? -1 : 1;
  // (on a wall it sits over and behind the collider's block, which world gen puts on the wall's lower
  // slope: seated, its front comes down past it toward the toe; on open ground it lies behind it)
  const RB = s * range(rnd, 1.45, 1.7);
  block(RB, side * range(rnd, 0.1, 0.3) * r, wall ? r * 0.1 + RB * 0.15 : r * 0.3 + RB * 1.05, { sx: range(rnd, 0.95, 1.08), sy: range(rnd, 1.1, 1.25), sz: range(rnd, 0.7, 0.8), tilt: tiltK * range(rnd, 0.1, 0.25), k: 1.12, sink: 0.1 });
  // a tall slab leaning back on the wall beside it
  if (rnd() < 0.75) {
    const RC = s * range(rnd, 1.0, 1.2);
    block(RC, -side * (RB * 0.9 + RC * 0.3), wall ? r * 0.25 + RC * 0.25 : r * 0.4 + RC * 0.3, { sx: range(rnd, 0.85, 1.0), sy: range(rnd, 1.35, 1.55), sz: range(rnd, 0.5, 0.6), tilt: -range(rnd, 0.28, 0.42), k: 1.04, sink: 0.12 });
  }
  // loose chunks on the floor in front of the pile (under the step height), snow-capped
  for (let k = 0; k < 2 + Math.floor(rnd() * 3); k++) {
    const a = Math.atan2(-uz, -ux) + range(rnd, -1.3, 1.3), dd = (wall ? RB * 0.8 : r * 1.1) + range(rnd, 0.3, 1.1), R = range(rnd, 0.14, 0.26);
    const sh = rockShape(rnd, { sx: range(rnd, 1, 1.4), sy: 0.6, sides: 3, oblique: 2, detail: R > 0.2 ? 1 : 0, noise: 0.12 });
    const rk = seatRock(ctx, b, sh, Math.cos(a) * dd, Math.sin(a) * dd, R, { yaw: rnd() * TAU, tilt: range(rnd, 0, 0.3), tiltA: rnd() * TAU, tint, sink: R * 0.25 });
    if (cap) snowCap(cap, rk, 0.05);
  }
  // the drift: banked deep against the front and the sides of the pile, thin up the slope behind
  const cx = ux * r * 0.5, cz = uz * r * 0.5, cols = groundOutline(ctx, placed, cx, cz, 36, 0.35, r * 0.8);
  const aD = Math.atan2(-uz, -ux), dp = rnd() * TAU;
  const front = a => clamp01(0.35 + 0.65 * Math.cos(a - aD));
  dustBank(ctx, cols, a => (0.08 + 0.16 * front(a) + 0.05 * Math.sin(3 * a + dp) + 0.03 * Math.sin(7 * a - dp)) * Math.min(1.2, s), a => (0.7 + 0.9 * front(a) + 0.2 * Math.sin(2 * a + dp)) * Math.min(1.2, s), cx, cz, { aoK: 0.45, flat: true });
}

// Tanaris: a wind-cut sandstone mound at the wall's toe in the walls' own beds (tan, rust and honey
// between thick cream hard beds, the lips and undercuts at the day's bed heights): the collider's own
// mound (fitted to it) and a big level-topped block long along the wall over it (on open ground, behind
// it), its back running into the slope where the wall climbs past it, battered walls, a scoured foot,
// often a smaller tier on top; the whole thing half buried in a drift of the desert's sand heaped by
// the wind against one end and the front, a block or two fallen off it lying in the sand.
function footSandstone(ctx, d, b, col, rnd, tint, steep, piece) {
  const S = col.S, s = d.s || 1, U = uphillOf(ctx), wall = U.g > 0.3, bm = ctx.biome, by = ctx.base.y;
  const r = col.cyl ? col.cyl.r : S * 0.95;
  const ux = wall ? U.ux : Math.cos(rnd() * TAU), uz = wall ? U.uz : Math.sin(rnd() * TAU), lx = -uz, lz = ux;
  // the collider's mound, filling it through the bumper band (on a wall its back runs into the slope)
  moundRock(ctx, b, S, rnd, tint, col, true, piece);
  // the block: a long, irregular plan along the wall, shallow across it, a little downhill of the
  // collider so its front stands on the floor; its top is level (a low dome), and where the wall
  // climbs past it its back simply runs into the slope
  const H = range(rnd, 1.85, 2.3) * Math.min(1.15, s), g = wall ? U.g : 0;
  const RB = Math.max(0.6, Math.min(s * range(rnd, 0.75, 0.9), g > 0 ? (H * 1.5 - 0.35) / (2 * g) : 9)), sxB = Math.min(3, s * range(rnd, 1.25, 1.5) / RB);
  const back = wall ? -r * 0.15 : r * 0.35 + RB * 1.05, lat = range(rnd, -0.3, 0.3) * r;
  const cx = ux * back + lx * lat, cz = uz * back + lz * lat, rot = Math.atan2(lz, lx) + range(rnd, -0.15, 0.15);
  const poly = roundPoly(rnd, 9 + Math.floor(rnd() * 3), RB, { jit: 0.08, sx: sxB }).map(([x, z]) => [cx + x * Math.cos(rot) - z * Math.sin(rot), cz + x * Math.sin(rot) + z * Math.cos(rot)]);
  const plan = polyRadius(poly, cx, cz);
  let gF = Infinity; for (let k = 0; k < 16; k++) { const a = k / 16 * TAU; gF = Math.min(gF, ctx.gh(cx + Math.cos(a) * plan(a), cz + Math.sin(a) * plan(a))); }   // the floor at its lowest side
  const ta = rnd() * TAU, dome = range(rnd, 0.1, 0.18), tl = range(rnd, 0.03, 0.06);
  const topAt = (x, z) => gF + H + tl * ((x - cx) * Math.cos(ta) + (z - cz) * Math.sin(ta)) + dome * Math.max(0, 1 - ((x - cx) ** 2 + (z - cz) ** 2) / (RB * RB * sxB)) + 0.04 * Math.sin(x * 1.3 + ta) * Math.cos(z * 1.1 - ta);
  const joints = [];
  for (let k = 0; k < 1 + Math.floor(rnd() * 2.5); k++) joints.push({ a: rnd() * TAU, w: range(rnd, 0.18, 0.3), d: range(rnd, 0.08, 0.14), ya: gF + range(rnd, 0, H * 0.4), yb: gF + H + 1, ph: rnd() * 6, taper: 0.6, lit: rnd() < 0.5 ? 1 : -1 });
  const notch = a => joints.reduce((m, J) => m + J.d * 0.6 * Math.max(0, 1 - angDiff(a, J.a) * plan(J.a) / (J.w * 1.6)), 0);
  const cols = strataRock(ctx, b, {
    cx, cz, plan, angles: poly.map(([x, z]) => Math.atan2(z - cz, x - cx)), joints, topAt,
    rimY: (a, x, z) => topAt(x, z) - notch(a),
    beds: bedsIn(bm, by, gF + 0.2, gF + H - 0.1), NA: 44, yB: gF - 0.6,
    lip: 0.06, uc: 0.1, ucH: 0.16, batter: 0.16, batY: 0.5, chamfer: 0.16, foot: { d: 0.16, h: 0.36 }, tierAmp: 0.07, noise: 0.035, jShade: true,
    capOut: a => 0.04 + 0.04 * Math.sin(2 * a + ta), capY0: gF + H - 0.4,
    tint: mulc(tint, 1.02), aoLo: 0.58, lipK: 1.07,
  });
  // a smaller tier sitting on it toward one end (the skyline steps)
  if (rnd() < 0.65) {
    const e = range(rnd, 0.25, 0.5) * (rnd() < 0.5 ? -1 : 1) * RB * sxB, r2 = RB * range(rnd, 0.5, 0.65);
    const c2x = cx + Math.cos(rot) * e + ux * 0.1, c2z = cz + Math.sin(rot) * e + uz * 0.1;
    const poly2 = roundPoly(rnd, 7, r2, { jit: 0.1, sx: range(rnd, 1.3, 1.7), ox: c2x, oz: c2z });
    const t2 = topAt(c2x, c2z) + range(rnd, 0.35, 0.55);
    const topAt2 = (x, z) => t2 + 0.07 * Math.max(0, 1 - ((x - c2x) ** 2 + (z - c2z) ** 2) / (r2 * r2)) + 0.02 * Math.sin(x * 1.7 + ta);
    strataRock(ctx, b, {
      cx: c2x, cz: c2z, plan: polyRadius(poly2, c2x, c2z), angles: poly2.map(([x, z]) => Math.atan2(z - c2z, x - c2x)), topAt: topAt2, rimY: (q, x, z) => topAt2(x, z),
      ground: (x, z) => topAt(x, z) - 0.03, yB: topAt(c2x, c2z) - 0.25, beds: bedsIn(bm, by, topAt(c2x, c2z) + 0.06, t2 - 0.08), NA: 26,
      lip: 0.05, uc: 0.07, ucH: 0.1, batter: 0.12, chamfer: 0.12, foot: { d: 0.09, h: 0.18 }, tierAmp: 0.04, noise: 0.025, tint: mulc(tint, 1.05), aoLo: 0.8,
    });
  }
  // the drift: half buried, deepest against the front, nothing on the wall's slope
  // (heaped against one end and the front by the wind, thin round the rest: a drift, not a plinth)
  const aD = Math.atan2(-uz, -ux), dp = rnd() * TAU, wa = aD + (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.6, 1.2);
  const heap = a => Math.pow(clamp01(Math.cos(a - wa)), 1.5), front = a => clamp01(Math.cos(a - aD));
  dustBank(ctx, cols, a => (0.07 + 0.42 * heap(a) + 0.12 * front(a) + 0.04 * Math.sin(3 * a + dp)) * Math.min(1.2, s), a => (0.5 + 1.5 * heap(a) + 0.5 * front(a) + 0.15 * Math.sin(2 * a + dp)) * Math.min(1.2, s), cx, cz, { flat: true });
  // blocks fallen off it, lying tipped in the sand in front
  for (let q = 0; q < 1 + Math.floor(rnd() * 2); q++) {
    const a = aD + range(rnd, -1.0, 1.0), dd = plan(a) * 0.9 + range(rnd, 0.5, 1.1), R = range(rnd, 0.2, 0.32) * Math.min(1.3, S);
    const x = cx + Math.cos(a) * dd, z = cz + Math.sin(a) * dd;
    const sh = rockShape(rnd, { sx: range(rnd, 1.2, 1.6), sy: range(rnd, 0.45, 0.65), sz: range(rnd, 0.8, 1), sides: 4, oblique: 2, topCut: [0.5, 0.68], topTilt: 0.2, sideCut: [0.6, 0.78], noise: 0.08, detail: 1 });
    seatRock(ctx, b, sh, x, z, R, { yaw: rnd() * TAU, tilt: range(rnd, 0.15, 0.45), tiltA: rnd() * TAU, tint, sink: R * 0.3, cos: Math.cos(30 * Math.PI / 180) });
  }
}

function rock(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 16)), B = ctx.bio, bm = ctx.biome;
  const col = rockCol(ctx, d);
  const S = col.S, steep = col.steep;                       // the scale (and steepness) world gen used
  ctx.at(d, d.ry || 0);
  const b = ctx.b('rock'), cap = B.snowCaps ? ctx.b('snowridge') : null;   // (the boughs' snow: same paint and mapping, no sway at wind 0, one batch fewer)
  const tint = () => lin(pick(rnd, B.rockTints));
  // sit every piece on the lowest ground under it, sunk; `fit` makes it fill its collider in plan
  const piece = (x, z, R, shapeO, o = {}) => {
    let [lo] = ctx.foot(R * (shapeO.sx ?? 1) * 0.9, x, z, 6);
    const sy = shapeO.sy ?? 0.75, bot = shapeO.bottom ?? 0.5;
    if (o.fit) lo = Math.max(lo, ctx.gh(x, z) - 0.12 * R * sy);     // a solid rock stands on the ground at its collider
    const sink = o.sink != null ? (bot - o.sink * (bot + 1)) : (bot - 0.32);
    const C = new V3(x, lo + R * sy * sink + (o.lift || 0), z);
    const sh = rockShape(rnd, { detail: R > 1.25 ? 2 : 1, ...shapeO });
    if (o.fit) {
      let Ps = fitPlan(sh.P.map(p => p.clone().multiplyScalar(R)), o.fit);
      if (o.topY != null) {
        // plan and top, twice over (each moves the other a little)
        const g0 = ctx.gh(x, z) - C.y, want = o.topY - C.y;          // the ground and the collider's top, about the rock's centre
        for (let it = 0; it < 2; it++) {
          const yb = o.band ? g0 + (want - g0) * o.band : want - Math.max(0.18, (want - g0) * 0.26);
          Ps = fitPlanY(Ps, sh.idx, o.fit, g0 + 0.15, Math.max(g0 + 0.3, yb), 0.24, 0.05);
          Ps = fitTop(Ps, sh.idx, o.fit, want);
        }
      }
      sh.P = Ps.map(p => p.multiplyScalar(1 / R));
    }
    const rk = placeRock(b, sh, C, R, { yaw: rnd() * TAU, tint: tint(), ...o });
    if (cap) snowCap(cap, rk, Math.min(0.16, 0.05 + 0.05 * R));
    if (o.rec) o.rec.push(rk.P);
    return C;
  };
  const fit = col.cyl ? col.cyl.r * 0.98 : 0, topY = col.cyl ? col.cyl.top : null;
  const tall = (sy0, R) => (fit ? col.cyl.top / (R * 0.66) * 0.96 : sy0);           // roughly; fitTop sets the top exactly
  const topC = c => (fit ? [0.6, 0.72] : c);
  const R0 = k => (fit ? Math.min(S * k, fit * 1.12) : S * k);                       // a fitted rock starts near its collider's size
  if (d.foot && bm === 'snow') footGranite(ctx, d, b, cap, col, rnd, tint(), piece);
  else if (d.foot && bm === 'desert') footSandstone(ctx, d, b, col, rnd, tint(), steep, piece);
  else if (bm === 'badlands') badlandsRock(ctx, b, S, rnd, steep, tint, col, d, piece);
  else if (bm === 'desert') desertRock(ctx, b, S, rnd, steep, tint, piece, col, d);
  else if (bm === 'snow') {
    piece(0, 0, R0(1.05), { sx: range(rnd, 1, 1.25), sy: tall(range(rnd, 0.65, 0.85), R0(1.05)), sides: 3, oblique: fit ? 3 : 4, topCut: topC([0.55, 0.75]), topTilt: fit ? 0.16 : 0.25, noise: 0.14 }, { fit, topY });
    if (S > 1.0 && rnd() < 0.6 && !steep) {   // a tilted slab leaning on it (inside the collider when there is one)
      const a = rnd() * TAU, dd = S * (fit ? 0.45 : 0.95);
      piece(Math.cos(a) * dd, Math.sin(a) * dd, S * (fit ? 0.55 : 0.65), { sx: 0.5, sy: 1.25, sz: 1, sides: 2, oblique: 2, topCut: [0.65, 0.8], topTilt: 0.3 }, { tilt: range(rnd, 0.2, 0.4), tiltA: a + Math.PI / 2, lift: S * 0.15 });
    }
    if (!steep && rnd() < 0.5) {
      const a = rnd() * TAU, dd = S * range(rnd, 1.1, 1.4);
      if (fit) rubble(ctx, b, 2, fit * 1.15, fit * 1.5, rnd, tint());
      else piece(Math.cos(a) * dd, Math.sin(a) * dd, S * range(rnd, 0.3, 0.5), { sy: 0.7, sides: 3, oblique: 2 });
    }
  } else {                                  // Elwynn / Westfall: chunky boulders, outcrops of tilted slabs
    const fields = bm === 'fields';
    piece(0, 0, R0(1.0), { sx: range(rnd, 1, 1.3), sy: tall(fields ? range(rnd, 0.55, 0.7) : range(rnd, 0.68, 0.85), R0(1.0)), sz: range(rnd, 0.85, 1.05), sides: 3, oblique: fit ? 3 : 3, topCut: topC([0.55, 0.75]), topTilt: fit ? 0.12 : 0.15 }, { fit, topY });
    if (S > 1.2 && rnd() < 0.65 && !steep) {          // an outcrop: 2-3 tall slabs leaning together (inside the collider)
      const a = rnd() * TAU, n = 2 + (rnd() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const aa = a + (k - (n - 1) / 2) * 0.55, dd = S * (fit ? range(rnd, 0.3, 0.45) : range(rnd, 0.6, 0.9)), x = Math.cos(aa) * dd, z = Math.sin(aa) * dd;
        piece(x, z, S * range(rnd, 0.55, 0.72), { sx: range(rnd, 0.45, 0.6), sy: range(rnd, 1.2, 1.6), sz: 1, sides: 2, oblique: 2, topCut: [0.6, 0.78], topTilt: 0.35 }, { tilt: range(rnd, 0.12, 0.35), tiltA: aa + Math.PI / 2 + range(rnd, -0.4, 0.4), lift: S * 0.25 });
      }
    }
    if (fit) { if (!steep) rubble(ctx, b, 2 + Math.floor(rnd() * 2), fit * 1.15, fit * 1.5, rnd, tint()); }
    else {
      const extra = steep ? 0 : S > 1.2 ? 2 : (rnd() < 0.5 ? 1 : 0);
      for (let k = 0; k < extra; k++) {
        const a = rnd() * TAU, dd = S * range(rnd, 1.0, 1.35), r = S * range(rnd, 0.3, 0.5);
        piece(Math.cos(a) * dd, Math.sin(a) * dd, r, { sx: range(rnd, 1, 1.3), sy: 0.65, sides: 3, oblique: 2 });
      }
    }
  }
}

// A desert road marker: 3-4 flat sandstone slabs stacked 0.6-0.9 m high, each a little askew, and
// often a sun-bleached skull or horn on top. World gen gives it a flimsy 0.35 m collider (mat 'cairn').
function cairn(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 27)), s = d.s || 1;
  ctx.at(d, d.ry || 0);
  const b = ctx.b('rock'), B = ctx.bio;
  const tint = () => lin(pick(rnd, B.rockTints));
  const n = 3 + (rnd() < 0.5 ? 1 : 0), Htot = range(rnd, 0.6, 0.9) * s;
  const [lo] = ctx.foot(0.45 * s, 0, 0, 6);
  let y = lo - 0.06, r = range(rnd, 0.37, 0.4) * Math.min(1.05, s), cx = 0, cz = 0;   // the foot slab on the 0.35 m collider
  for (let i = 0; i < n; i++) {
    const h = Htot / n * range(rnd, 0.8, 1.2), ta = rnd() * TAU, tk = Math.tan(range(rnd, 3, 9) * Math.PI / 180);
    const yt = prism(b, new V3(cx, 0, cz), y, h, polyOf(rnd, 6 + (rnd() < 0.5 ? 1 : 0), r, 0.12, range(rnd, 1, 1.15), 1), rnd,
      { tint: tint(), under: 0.88, bulge: 1.02, bevel: 0.03, foot: 0.015, tilt: [Math.cos(ta) * tk, Math.sin(ta) * tk], aoLo: i === 0 ? 0.5 : 0.7, lipK: 1.1 });
    y = yt - 0.025; r *= range(rnd, 0.82, 0.92);
    cx += range(rnd, -0.05, 0.05) * s; cz += range(rnd, -0.05, 0.05) * s;
  }
  const deco = d.variant ?? (rnd() < 0.45 ? 'skull' : rnd() < 0.5 ? 'horn' : 'none');
  if (deco === 'skull') {
    const k = 0.32 * s, pitch = range(rnd, 0.1, 0.25);
    ctx.at(d, (d.ry || 0) + range(rnd, -1, 1), new THREE.Matrix4().makeTranslation(cx, 0, cz).multiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, 0, 0))));
    skullAt(ctx, new V3(0, y + 0.36 * k, 0), k);
  } else if (deco === 'horn') {
    const bb = ctx.b('bone'), hb = lin('#d8c8a0'), ht = lin('#5a4a36'), a = rnd() * TAU;
    const hc = [new V3(cx, y + 0.03, cz), new V3(cx + Math.cos(a) * 0.14, y + 0.12, cz + Math.sin(a) * 0.14), new V3(cx + Math.cos(a) * 0.2, y + 0.3, cz + Math.sin(a) * 0.2 + 0.04), new V3(cx + Math.cos(a) * 0.14, y + 0.44, cz + Math.sin(a) * 0.14 + 0.08)];
    const hp = spline(hc, 3);
    tube(bb, hp, hp.map((_, i) => 0.055 * (1 - 0.8 * i / (hp.length - 1)) + 0.008), { sides: 8, uRep: 0.6, vLen: 0.4, cap: 0.8, cap0: 0.4, color: (p, nn, t) => mulc(mixc(hb, ht, Math.pow(t, 0.9)), 0.85 + 0.25 * clamp01(nn.y * 0.5 + 0.5)) });
  }
}

// ---- farm & field bits ------------------------------------------------------------------------------

// Split-rail fence: thick weathered posts with chamfered tops, flat split rails that overhang the
// posts and pass in front of or behind them (3 in Westfall, 2 elsewhere). On a slope it steps: each
// span's rails stay level at the height of its upper post's ground (the lower post runs longer), and
// a span steeper than 0.4 (rise over run) is left out, so a run never climbs a hill like a ladder.
function fence(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 17)), n = Math.max(2, d.len || 4), west = ctx.biome === 'fields';
  ctx.at(d, d.ry || 0);
  const b = ctx.b('wood');
  const wood = (y0) => (p, nn) => { const k = (0.62 + 0.4 * smooth(y0 - 0.3, y0 + 0.6, p.y)) * (0.8 + 0.26 * Math.max(0, nn.y)); return [k * 1.02, k, k * 0.96]; };
  const hs = west ? [0.35, 0.7, 1.05] : [0.45, 0.92];
  const posts = [];
  for (let i = 0; i < n; i++) {
    const z = (i - (n - 1) / 2) * 1.9 + range(rnd, -0.12, 0.12), x = range(rnd, -0.06, 0.06);
    posts.push({ x, z, g: ctx.gh(x, z), lx: range(rnd, -0.07, 0.07), lz: range(rnd, -0.07, 0.07), r: range(rnd, 0.13, 0.15), h: (west ? 1.25 : 1.15) + range(rnd, -0.06, 0.06), top: -Infinity });
  }
  const spans = [];
  for (let i = 0; i < n - 1; i++) {
    const A = posts[i], B = posts[i + 1], run = Math.hypot(B.x - A.x, B.z - A.z);
    if (Math.abs(B.g - A.g) / run > 0.4) continue;
    const base = Math.max(A.g, B.g);
    spans.push({ A, B, base, i });
    for (const P of [A, B]) P.top = Math.max(P.top, base + P.h);
  }
  for (const P of posts) {
    if (P.top === -Infinity) continue;                    // no rails reach it: no post
    const H = P.top - P.g, y = P.g, k = (P.top - P.g) / P.h;
    tube(b, [new V3(P.x, y - 0.45, P.z), new V3(P.x + P.lx * 0.5, y + H * 0.5, P.z + P.lz * 0.5), new V3(P.x + P.lx, y + H - 0.1, P.z + P.lz), new V3(P.x + P.lx, y + H, P.z + P.lz), new V3(P.x + P.lx, y + H + 0.06, P.z + P.lz)],
      [P.r, P.r * 0.97, P.r * 0.93, P.r * 0.62, 0.035], { sides: 8, uRep: 1, vLen: 1.2, color: wood(y), a0: rnd(), lobes: (dir, t, i, j) => 1 + 0.06 * Math.sin(j * 2.3 + i * 1.7) });
    P.H = H; P.k = k;
  }
  const flat = (dir) => { const hz = Math.hypot(dir.x, dir.z), v = dir.y; return 1 / Math.sqrt((hz / 0.75) ** 2 + (v / 1.15) ** 2); };   // split rails: taller than thick
  for (const { A, B, base, i } of spans) {
    hs.forEach((h, row) => {
      if (rnd() < 0.06) return;
      const side = ((i + row) % 2 ? 1 : -1), r = range(rnd, 0.072, 0.08);
      const ox = side * (A.r + r * 0.9);
      const ya = base + h + range(rnd, -0.04, 0.04), yb = base + h + range(rnd, -0.04, 0.04);
      const lean = (P, y) => (y - P.g) / P.H;              // how far up its post (it leans a little)
      const ov = range(rnd, 0.2, 0.3);
      const pa = new V3(A.x + A.lx * lean(A, ya) + ox, ya, A.z - ov), pb = new V3(B.x + B.lx * lean(B, yb) + ox, yb, B.z + ov);
      const mid = pa.clone().lerp(pb, 0.5); mid.y -= 0.03; mid.x += range(rnd, -0.025, 0.025);
      tube(b, [pa, pa.clone().lerp(mid, 0.5), mid, mid.clone().lerp(pb, 0.5), pb], [r, r * 1.04, r * 1.06, r, r * 0.92], { sides: 6, uRep: 1, vLen: 1.6, color: wood(base), cap: 0.3, lobes: (dir, t, ii, j) => flat(dir) * (1 + 0.05 * Math.sin(j * 3.1 + ii)) });
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
    const g0 = lo, ys = [-0.25, 0.12, 0.45, 0.8, 1.0, 1.3, 1.62, 1.9, 2.05, 2.1], rs = [0.92, 0.98, 1.02, 0.94, 0.9, 0.78, 0.55, 0.3, 0.12, 0.02].map(v => v * 0.8);   // its waist on the 0.75 m collider
    const sA = rnd() * 9;
    const dampC = [0.62, 0.5, 0.34], sunC = [1.12, 1.06, 0.92];
    const col = p => { const t = smooth(g0 + 0.05, g0 + 1.8, p.y); return mixc(dampC, sunC, t); };
    tube(hay, ys.map(y => new V3(0, g0 + y, 0)), rs, { sides: 16, uRep: 3, vLen: 0.7, color: col, lobes: (dir, t, i, j) => 1 + 0.09 * Math.sin(j * 1.3 + sA) * Math.sin(i * 1.1 + sA) + 0.04 * Math.sin(j * 3.7 + i * 2.1) });
    strawRing(ctx, new V3(0, g0, 0), 0.78, 14, rnd, { h: [0.3, 0.45], up: -0.04, color: [0.8, 0.7, 0.5], outward: 0.6 });
    strawRing(ctx, new V3(0, g0, 0), 0.74, 10, rnd, { h: [0.25, 0.35], up: 0.82, cells: [2], color: [0.95, 0.88, 0.7], outward: 0.9 });
    strawRing(ctx, new V3(0, g0, 0), 0.15, 5, rnd, { h: [0.3, 0.42], up: 1.95, color: [1.1, 1.05, 0.9], outward: 0.3 });
    if (rnd() < 0.35) {
      const wb = ctx.b('wood'), ib = ctx.b('iron'), a = rnd() * TAU, c = Math.cos(a), s = Math.sin(a);
      const p0 = new V3(c * 0.42, g0 + 1.05, s * 0.42), p1 = new V3(c * 1.0, g0 + 2.45, s * 1.0);
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
  // the seat: joins both trouser tops up inside the shirt hem
  part([P(-0.2, 0.98, 0.09), P(0, 0.95, 0.1), P(0.2, 0.98, 0.09)], [0.13, 0.15, 0.13], 'pants', { sides: 9, cap: 0.6, lobes: lumpy(0.05) });
  // straw at the cuffs, the trouser ends, the waist and the neck
  const strawC = (c) => mulc(WHITE, c > 0 ? 1.05 : 0.75);
  const st = ctx.b('straw');
  for (const sd of [-1, 1]) {
    for (let k = 0; k < 5; k++) { const a = k / 5 * TAU + rnd(); card(st, P(sd * 0.86, 1.58 + Math.sin(a) * 0.05, Math.cos(a) * 0.05), 0.28, 0.26, new V3(Math.cos(a) * 0.3, 0, Math.sin(a) * 0.3 + 1).normalize(), inset(cellOf(pick(rnd, [0, 1]))), strawC, { lean: sd * 1.3 * (k % 2 ? 1 : -1) * 0.5, wind: 0.3 }); }
    for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + rnd(); card(st, P(sd * 0.155 + Math.cos(a) * 0.04, 0.48, 0.12 + Math.sin(a) * 0.04), 0.24, -0.28, new V3(Math.cos(a), 0, Math.sin(a)), inset(cellOf(pick(rnd, [0, 1]))), strawC, { wind: 0.3 }); }
  }
  for (let k = 0; k < 8; k++) { const a = k / 8 * TAU + rnd() * 0.5; card(st, P(Math.cos(a) * 0.29, 0.97, 0.08 + Math.sin(a) * 0.29), 0.24, -0.24, new V3(Math.cos(a), 0, Math.sin(a)), inset(cellOf(2)), strawC, { lean: 0.4, wind: 0.2 }); }
  for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + rnd() * 0.5; card(st, P(Math.cos(a) * 0.11, 1.76, 0.07 + Math.sin(a) * 0.11), 0.22, 0.2, new V3(Math.cos(a), 0, Math.sin(a)), inset(cellOf(pick(rnd, [0, 1]))), strawC, { lean: -0.5, wind: 0.2 }); }
  // burlap head, cocked to one side; the face is at u = 0.5, which faces +z
  const hc = P(0.04, 2.12, 0.08), hr = 0.3, hp = [], hrad = [];
  for (let k = 0; k <= 8; k++) { const th = 0.1 * Math.PI + k / 8 * 0.84 * Math.PI; hp.push(new V3(hc.x + Math.sin(k / 8 * 2) * 0.03, hc.y - Math.cos(th) * hr * 1.1, hc.z)); hrad.push(Math.sin(th) * hr * (1 + 0.05 * Math.sin(k * 1.7))); }
  part(hp, hrad, 'head', { sides: 14, cap: true });
  // a felt hat: a smooth wide brim (16 segments, drooping on one side, turned up a little on the other)
  // round a dented crown
  const yb = hc.y + 0.2, hx = hc.x + 0.03, hz = hc.z - 0.02, da = rnd() * TAU, NB = 16;
  const ring = (r, dy) => { const row = []; for (let k = 0; k <= NB; k++) { const a = k / NB * TAU, w = Math.cos(a - da); row.push(new V3(hx + Math.cos(a) * r, yb + dy + (r > 0.3 ? (w > 0 ? -0.09 * w * w : 0.035 * w * w) : 0), hz + Math.sin(a) * r)); } return row; };
  const hatR = SC.hat, us = []; for (let k = 0; k <= NB; k++) us.push(hatR[0] + (hatR[2] - hatR[0]) * (0.02 + 0.96 * k / NB));
  const topIn = ring(0.2, 0.0), topOut = ring(0.5, -0.03), botIn = ring(0.2, -0.03), botOut = ring(0.5, -0.06);
  const hatC = (ri) => mulc(WHITE, [1.0, 0.85][ri] ?? 1);
  strip(sc, [topIn, topOut], us, [hatR[1] + 0.16, hatR[1] + 0.23], () => UP, hatC, () => 0, UP);
  strip(sc, [botIn, botOut], us, [hatR[1] + 0.16, hatR[1] + 0.23], () => new V3(0, -1, 0), () => [0.55, 0.52, 0.5], () => 0, new V3(0, -1, 0));
  strip(sc, [topOut, botOut], us, [hatR[1] + 0.2, hatR[1] + 0.22], (ri, ci) => new V3(Math.cos(ci / NB * TAU), 0, Math.sin(ci / NB * TAU)), () => [0.7, 0.68, 0.66], () => 0, new V3(Math.cos(TAU / NB * 0.5), 0, Math.sin(TAU / NB * 0.5)));
  const crown = [[0.22, -0.01], [0.215, 0.12], [0.2, 0.24], [0.15, 0.3], [0.04, 0.31]];
  part(crown.map(([r, y], i) => new V3(hx + i * 0.006, yb + y, hz)), crown.map(([r]) => r), 'hat', { sides: 14, cap: 0.3, lobes: (dir, t, i) => (i >= 3 ? 1 - 0.12 * Math.max(0, Math.cos(Math.atan2(dir.z, dir.x) - da)) : 1) });
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
    // organ pipe: the central column fills the collider; tall columns of varied height rise round it from
    // one base, with 2-4 short side stubs, rounded tops, rust-pink flower nubs and dust on the tops
    cb.cf = p => smooth(g0 + h * 0.7, g0 + h * 1.0, p.y) * 0.45;      // patchy dust on the tops
    const n = 4 + Math.floor(rnd() * 3), R0 = range(rnd, 0.2, 0.24), bone = ctx.b('bone'), nub = lin('#c86a5a');
    const cols = [];
    for (let k = 0; k < n; k++) cols.push({ main: k === 0, hk: k === 0 ? h : h * range(rnd, 0.62, 1.1), R: k === 0 ? R0 : R0 * range(rnd, 0.75, 0.92), off: k === 0 ? 0 : range(rnd, 0.3, 0.5) });
    const nS = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < nS; k++) cols.push({ hk: h * range(rnd, 0.22, 0.42), R: R0 * range(rnd, 0.6, 0.75), off: range(rnd, 0.32, 0.55), stub: true });
    const a0 = rnd() * TAU;
    cols.forEach((c0, k) => {
      // the outer columns stand with their outer faces on the 0.45 m collider (± a few cm)
      const a = a0 + k * 2.39996 + range(rnd, -0.3, 0.3), c = Math.cos(a), sn = Math.sin(a), { hk, R } = c0, off = c0.main ? 0 : Math.max(0.12, 0.45 - R + range(rnd, -0.06, 0.02));
      const lean = c0.main ? 0.04 : range(rnd, 0.02, 0.06);
      const pts = c0.main ? [new V3(0, g0 - 0.3, 0), new V3(0, g0 + 0.3, 0), new V3(0.02, g0 + hk * 0.5, 0), new V3(0.04, g0 + hk - R * 0.6, 0)]
        : [new V3(c * 0.05, g0 - 0.2, sn * 0.05), new V3(c * off * 0.6, g0 + 0.12, sn * off * 0.6), new V3(c * off, g0 + Math.min(0.45, hk * 0.4), sn * off), new V3(c * (off + lean * 0.6), g0 + hk * 0.7, sn * (off + lean * 0.6)), new V3(c * (off + lean), g0 + hk - R * 0.6, sn * (off + lean))];
      tube(cb, pts, pts.map((_, i) => (i === 0 ? R * 1.05 : R) * (i === pts.length - 1 ? 0.96 : 1)), { sides: 14, uRep: 1.75, vLen: 1.6, lobes: ribs(0.15), color: capCol, cap: 0.85 });
      if (!c0.stub && rnd() < 0.45) {
        const T = pts[pts.length - 1];
        for (let q = 0; q < 2 + Math.floor(rnd() * 2); q++) { const aa = rnd() * TAU, F = new V3(T.x + Math.cos(aa) * R * 0.5, T.y + R * 0.6, T.z + Math.sin(aa) * R * 0.5); sphereish(bone, 1, u => new V3(F.x + u.x * 0.055, F.y + u.y * 0.045, F.z + u.z * 0.055), { color: (p2, nn) => mulc(nub, 0.8 + 0.35 * clamp01(nn.y)) }); }
      }
    });
    cb.cf = null;
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
  // the muzzle: a short elliptical tube from the plate to the nose, narrowing then widening again
  // into a spade at the nose
  const mz = [], NM = 7, ML = 0.8;
  for (let i = 0; i <= NM; i++) { const t = i / NM; mz.push(L(0, 0.02 - 0.12 * t * t, -0.02 + t * ML)); }
  const wA = [0.4, 0.33, 0.26, 0.22, 0.21, 0.23, 0.26, 0.27], hA = [0.27, 0.24, 0.2, 0.17, 0.15, 0.14, 0.13, 0.12];
  tube(b, mz, mz.map(() => k), { sides: 12, uRep: 2, vLen: 0.8 * k, cap: 0.1, color: bone,
    lobes: (dir, t, i) => { const a = lerpArr(wA, t), hh = lerpArr(hA, t) * (dir.y < 0 ? 0.8 : 1); const hz = Math.hypot(dir.x, dir.z); return 1 / Math.sqrt((hz / a) ** 2 + (dir.y / hh) ** 2); } });
  // the jaw line: a low ridge of worn teeth along each side of the upper jaw (no pearl beads)
  const tooth = [0.82, 0.76, 0.66];
  // sockets: deep warm-dark hollows (never black) facing forward and out, under lit brows
  const rim = lin('#6a4c36'), deep = lin('#5a4030');
  for (const sd of [-1, 1]) {
    const f = new V3(sd * 0.55, 0.08, 0.83).normalize(), sc = new V3(sd * 0.31, 0.06, 0.13);
    sphereish(b, 1, u => { const p = u.clone(); p.addScaledVector(f, -p.dot(f) * 0.6); return L(sc.x + p.x * 0.2, sc.y + p.y * 0.17, sc.z + p.z * 0.2); },
      { color: (p, n) => mixc(rim, mulc(deep, 0.75), clamp01(n.dot(f)) ** 1.2) });
    const brow = [L(sd * 0.1, 0.19, 0.15), L(sd * 0.27, 0.22, 0.18), L(sd * 0.43, 0.19, 0.11), L(sd * 0.49, 0.1, 0.0)];
    tube(b, spline(brow, 3), Array(10).fill(0.055 * k), { sides: 7, uRep: 0.5, vLen: 0.5 * k, color: bone, cap: 0.5, cap0: 0.5 });
    // nostril, on the spade
    const nc = new V3(sd * 0.09, -0.04, ML - 0.02), nf = new V3(sd * 0.3, 0.15, 1).normalize();
    sphereish(b, 1, u => { const p = u.clone(); p.addScaledVector(nf, -p.dot(nf) * 0.6); return L(nc.x + p.x * 0.055, nc.y + p.y * 0.075 + Math.max(0, p.y) * 0.03, nc.z + p.z * 0.05); }, { color: (p, n) => mixc(rim, deep, clamp01(n.dot(nf))) });
    const tr = [L(sd * 0.2, -0.16, 0.3), L(sd * 0.19, -0.17, 0.45), L(sd * 0.2, -0.15, 0.6)];
    tube(b, tr, [0.03 * k, 0.034 * k, 0.026 * k], { sides: 6, uRep: 0.4, vLen: 0.4, cap: 0.6, cap0: 0.6, color: tooth });
    // horns: thick at the root, one smooth arc out, up and forward, darkening toward the tip, with
    // growth rings
    const hc = [L(sd * 0.3, 0.2, -0.1), L(sd * 0.62, 0.26, -0.08), L(sd * 0.92, 0.36, 0.0), L(sd * 1.1, 0.55, 0.12), L(sd * 1.15, 0.78, 0.26), L(sd * 1.08, 0.95, 0.4)];
    const hp = spline(hc, 3), hb = lin('#d8c8a0'), ht = lin('#5a4a36');
    tube(b, hp, hp.map((_, i) => k * lerpArr([0.1, 0.093, 0.082, 0.068, 0.052, 0.036, 0.02], i / (hp.length - 1))), { sides: 9, uRep: 0.6, vLen: 0.6 * k, cap: 0.8,
      color: (p, n, t) => mulc(mixc(hb, ht, Math.pow(t, 0.9)), (0.8 + 0.3 * clamp01(n.y * 0.5 + 0.5)) * (0.93 + 0.07 * Math.sin(t * 48))) });
  }
}

function skull(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 21));
  const pitch = range(rnd, 0.26, 0.42), roll = range(rnd, -0.12, 0.12);
  ctx.at(d, d.ry || 0, new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(pitch, 0, roll)));
  const k = 1.6;
  // the muzzle tip and the back of the cranium rest on the sand
  const [lo] = ctx.foot(1.6);
  const tipY = -0.24 * Math.cos(pitch) - 0.8 * Math.sin(pitch);
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
  tube(b, sp, sp.map(() => 0.06 * s), { sides: 7, uRep: 0.4, vLen: 0.6, color: bone });
  for (let i = 1; i < nV; i++) {
    const p = sp[i], r = 0.095 * s * range(rnd, 0.85, 1.15);
    sphereish(b, 0, u => new V3(p.x + u.x * r * 1.1, p.y + u.y * r * 0.9, p.z + u.z * r * 0.8), { color: bone });
    if (i > 1 && i < nV - 1) tube(b, [p.clone(), new V3(p.x, p.y + 0.2 * s * range(rnd, 0.6, 1.4), p.z - 0.05 * s)], [0.035 * s, 0.016 * s], { sides: 5, uRep: 0.3, vLen: 0.5, cap: 0.6, color: bone });
  }
  const nRib = 7 + Math.floor(rnd() * 3), broken = new Set();
  for (let k = 0; k < 2 + Math.floor(rnd() * 2); k++) broken.add(Math.floor(rnd() * nRib * 2));
  for (let i = 0; i < nRib; i++) {
    const t = 0.24 + clamp01((i + range(rnd, -0.25, 0.25)) / (nRib - 1)) * 0.5, f = t * nV, j = Math.min(nV - 1, Math.floor(f)), V = sp[j].clone().lerp(sp[j + 1], f - j);
    const W0 = (0.55 + 0.45 * Math.sin(Math.PI * (t - 0.24) / 0.5)) * 0.75 * s;
    for (const sd of [-1, 1]) {
      const id = i * 2 + (sd > 0 ? 1 : 0), cut = broken.has(id) ? range(rnd, 0.45, 0.7) : 1;
      const W = W0 * range(rnd, 0.82, 1.18), arc = Math.PI * 0.62 * range(rnd, 0.85, 1.15);
      const gy = ctx.gh(V.x + sd * W, V.z);
      const pts = [];
      for (let q = 0; q <= 8; q++) {
        const u = q / 8 * cut, a = u * arc;
        const x = V.x + sd * W * Math.sin(a) / Math.sin(arc) * (1 + 0.05 * Math.sin(u * 5));
        const y = V.y - (V.y - gy + 0.18) * (1 - Math.cos(a)) / (1 - Math.cos(arc));
        pts.push(new V3(x, y, V.z + 0.06 * s * u));
      }
      const flat = (dir) => 1 / Math.sqrt((dir.z / 1.45) ** 2 + (dir.x * dir.x + dir.y * dir.y) / 0.52);
      tube(b, pts, pts.map((_, q) => (0.042 - q * 0.002) * s), { sides: 6, uRep: 0.3, vLen: 0.6, color: bone, cap: 0.5, lobes: flat });
    }
  }
  // long bones lying about
  for (let k = 0; k < 2 + (rnd() < 0.5 ? 1 : 0); k++) {
    const a = rnd() * TAU, x = range(rnd, -1.2, 1.2) * s, z = range(rnd, -1.3, 1.3) * s, L = range(rnd, 0.5, 0.8) * s;
    const x1 = x + Math.cos(a) * L, z1 = z + Math.sin(a) * L;
    const p0 = new V3(x, ctx.gh(x, z) + 0.04, z), p1 = new V3(x1, ctx.gh(x1, z1) + 0.04, z1);
    tube(b, [p0, p0.clone().lerp(p1, 0.12), p0.clone().lerp(p1, 0.5), p0.clone().lerp(p1, 0.88), p1], [0.075, 0.042, 0.034, 0.042, 0.075].map(r => r * s), { sides: 7, uRep: 0.4, vLen: 0.6, cap: 0.6, cap0: 0.6, color: bone });
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
  // a ring of 11-12 smaller overlapping sooty basalt stones; soot on their inner faces, a faint warm
  // bounce there too (the fire's own light does the rest)
  const nS = 11 + (rnd() < 0.5 ? 1 : 0);
  for (let i = 0; i < nS; i++) {
    const a = i / nS * TAU + range(rnd, -0.08, 0.08), r = range(rnd, 0.66, 0.74), x = Math.cos(a) * r, z = Math.sin(a) * r;
    const R = range(rnd, 0.18, 0.25), sh = rockShape(rnd, { sx: range(rnd, 1.1, 1.4), sy: 0.72, sides: 3, oblique: 2, detail: 1 });
    const C = new V3(x, ctx.gh(x, z) + R * 0.1, z);
    const m = new THREE.Matrix4().makeRotationY(-a + range(rnd, -0.3, 0.3));
    const P = sh.P.map(p => p.clone().multiplyScalar(R).applyMatrix4(m).add(C));
    const inw = new V3(-x, 0, -z).normalize(), base = lin(pick(rnd, ['#6e727e', '#666a76', '#767884']));   // cool basalt: the firelight warms it to a sooty gray-brown, not terracotta
    creased(rk, P, sh.idx, (p, n) => {
      const k = clamp01(n.dot(inw)), y = smooth(C.y - R * 0.3, C.y + R * 0.5, p.y);
      const soot = 1 - 0.45 * k * y - 0.15 * k;      // charcoal-black where the flames lick
      return mul3(base, [(0.5 + 0.38 * y) * soot + 0.05 * k, (0.48 + 0.36 * y) * soot + 0.02 * k, (0.5 + 0.38 * y) * soot]);
    });
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
  for (let k = 0; k < 3; k++) quad(k * Math.PI / 3 + 0.3, 0.95, range(rnd, 1.25, 1.45), ph + k * 1.7, false);
  quad(0, 0.8, 1.3, ph + 5.3, true);
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

// Tree lines on the unreachable apron past both side edges of the playable grid (no colliders
// needed), so every valley rim has a wooded skyline: Elwynn oak clumps with a few conifers, Westfall's
// groves of big round olive-gold oaks (3-6 to a grove, 2-2.7x a roadside oak, open gaps of rim between
// groves: fewer and bigger, so they read as trees from the valley floor, never as matchsticks), ranks
// of snowy pines in Dun Morogh; the canyon and the desert stay bare. Cheap impostors (a short trunk, a
// few leaf clumps; pines with fewer tiers), merged into one mesh per material for the whole leg,
// casting no shadows: 2-3 draw calls.
const sst = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
function rimTrees(ctx) {
  const W = ctx.W, bm = ctx.biome;
  if (!(bm === 'meadow' || bm === 'fields' || bm === 'snow') || !W.heightAt || !W.nx || !W.cell) return;
  const X0 = W.X0, X1 = W.X0 + W.nx * W.cell, Zend = W.Z0 + W.nz * W.cell, seed = W.seed | 0;
  // the apron's height (mirrors terrain3d buildApron along the sides)...
  const hA = (x, z) => { const cx = Math.max(X0, Math.min(X1, x)), dOut = Math.abs(x - cx); return W.heightAt(cx, z) + dOut * 0.25 + sst(180, 340, dOut) * 70 + fbm(x / 70, z / 70, seed + 901, 3) * 22 * sst(0, 90, dOut); };
  // ...as its mesh has it: that function sampled on the apron's 10 m lattice (from the grid's edges)
  // and interpolated across each cell, so a big tree neither floats nor sinks where a cell is bent
  const hL = (x, z) => {
    const L = 10, ox = x > X1 ? X1 : X0, i = Math.floor((x - ox) / L), j = Math.floor((z - W.Z0) / L);
    const x0 = ox + i * L, z0 = W.Z0 + j * L, u = (x - x0) / L, v = (z - z0) / L;
    const h00 = hA(x0, z0), h10 = hA(x0 + L, z0), h01 = hA(x0, z0 + L), h11 = hA(x0 + L, z0 + L);
    return (h00 * (1 - u) + h10 * u) * (1 - v) + (h01 * (1 - u) + h11 * u) * v;
  };
  const rnd = rngOf(((seed * 2654435761) ^ 0x5bd1e995) >>> 0);
  const B = ctx.bio, tintO = () => lin(pick(rnd, B.oakTints));
  ctx.rim = true;
  // a far oak: a stout short trunk under a full dome of lobes that reaches down to about a third of
  // the tree's height (low side lobes under the ring), so it reads as an oak, never a flat-topped acacia;
  // Westfall's (ball) is a round, lumpy ball, about as tall as it is wide, on a short visible bole
  const oakImp = (x, y, z, G, ball = false, tint0 = null) => {
    ctx.at({ x, y, z }, 0);
    const lv = ctx.b('leaves'), F = (ball ? range(rnd, 0.95, 1.15) : range(rnd, 1.0, 1.2)) * G, Rc = (ball ? range(rnd, 2.5, 2.9) : range(rnd, 3.0, 3.5)) * G, tint = tint0 || tintO();
    // the trunk goes in the leaf mesh (no bark draw call for far trees): a dark brown stub sampling the
    // opaque middle of the dense core cell (sunk well in: the apron under a big tree may slope)
    const cc = inset(cellOf(2)), uc = (cc[0] + cc[2]) / 2, vc = (cc[1] + cc[3]) / 2;
    tube(lv, [new V3(0, -0.6 - 0.25 * G, 0), new V3(0, F * 0.5, 0), new V3(range(rnd, -0.2, 0.2) * G, F + 0.9 * G, range(rnd, -0.2, 0.2) * G)], [0.6 * G, 0.5 * G, 0.36 * G], { sides: 6, uvMap: () => [uc, vc], color: [0.6, 0.42, 0.3] });
    const yc = F + Rc * (ball ? 0.86 : 0.72), n = ball ? 4 + (rnd() < 0.5 ? 1 : 0) : 4 + (rnd() < 0.5 ? 1 : 0), a0 = rnd() * TAU, yLo = F, yHi = yc + Rc * 0.9;
    const ao = p => (ball ? 0.6 : 0.58) + (ball ? 0.4 : 0.42) * smooth(yLo, yHi, p.y);
    for (let k = 0; k <= n; k++) {
      const top = k === n, a = a0 + k * TAU / n, rr = top ? 0 : Rc * (ball ? 0.48 : 0.52), R = top ? Rc * (ball ? 0.62 : 0.58) : Rc * (ball ? range(rnd, 0.44, 0.54) : range(rnd, 0.42, 0.52));
      const C = new V3(Math.cos(a) * rr + (top && ball ? range(rnd, -0.15, 0.15) * Rc : 0), top ? yc + Rc * (ball ? 0.38 : 0.32) : yc - Rc * (ball ? range(rnd, 0.06, 0.26) : range(rnd, 0, 0.16)), Math.sin(a) * rr);
      clump(lv, C, R, rnd, { cards: ball ? 7 : 6, size: R * 1.05, cells: [0], core: 2, coreK: 1.8, tint, ao, squash: 0.95, wind: 0.3, sizeVar: [0.9, 1.15] });
    }
    // the dome's low skirt: 1-2 smaller lobes hanging lower on the sides
    const nLow = 1 + (rnd() < 0.6 ? 1 : 0);
    for (let k = 0; k < nLow; k++) {
      const a = a0 + (k + 0.5) * TAU / n + range(rnd, -0.3, 0.3), R = Rc * range(rnd, 0.3, 0.38), rr = Rc * range(rnd, 0.5, 0.62) * (ball ? 0.85 : 1);
      clump(lv, new V3(Math.cos(a) * rr, yc - Rc * (ball ? 0.52 : 0.5), Math.sin(a) * rr), R, rnd, { cards: 5, size: R * 1.1, cells: [0], core: 2, coreK: 1.7, tint, ao, squash: 0.95, wind: 0.3, sizeVar: [0.9, 1.15] });
    }
  };
  if (bm === 'fields') {
    // Westfall: groves of 3-6 big round oaks along each rim, crowns touching, open rim between them.
    // Each grove grows out from its biggest tree, every new one set against one already planted (its
    // crown overlapping a quarter or so), the grove drawn out along the rim.
    for (const side of [-1, 1]) {
      let z = W.Z0 + range(rnd, 15, 70);
      while (z < Zend - 12) {
        const n = 3 + Math.floor(rnd() * 4), Gc = range(rnd, 2.25, 2.7), d0 = range(rnd, 9, 30), tint = tintO();
        const pts = [{ d: d0, z, G: Gc }];
        for (let k = 1; k < n; k++) {
          const G = Gc * range(rnd, 0.74, 0.95);
          let best = null;
          for (let tries = 0; tries < 10 && !best; tries++) {
            const p = pts[Math.floor(rnd() * pts.length)], a = rnd() * TAU, dd = 2.7 * (p.G + G) * range(rnd, 0.68, 0.82);
            const q = { d: p.d + Math.cos(a) * dd * 0.55, z: p.z + Math.sin(a) * dd, G };
            if (q.d > 4 && q.d < 46 && pts.every(o => Math.hypot(o.d - q.d, o.z - q.z) > 2.7 * (o.G + G) * 0.6)) best = q;
          }
          if (best) pts.push(best);
        }
        for (const p of pts) {
          if (p.z < W.Z0 + 4 || p.z > Zend - 4) continue;
          const x = side > 0 ? X1 + p.d : X0 - p.d;
          // (the grove shares a tint, each tree a little lighter or darker)
          oakImp(x, hL(x, p.z) - 0.35, p.z, p.G, true, mulc(tint, range(rnd, 0.92, 1.05)));
        }
        z += range(rnd, 110, 190);
      }
    }
    ctx.rim = false;
    return;
  }
  for (const side of [-1, 1]) {
    let z = W.Z0 + rnd() * 12;
    while (z < Zend - 4) {
      const n = 3 + Math.floor(rnd() * 4);
      rnd();                                          // (draws kept as they were: the same rims as before)
      for (let k = 0; k < n; k++) {
        rnd(); if (k) rnd();
        const dOut = range(rnd, 3, bm === 'snow' ? 34 : 26), x = side > 0 ? X1 + dOut : X0 - dOut;
        const zz = z + range(rnd, -7, 7);
        if (zz < W.Z0 + 2 || zz > Zend - 2) continue;
        const y = hL(x, zz) - 0.2;
        if (bm === 'snow' || (bm === 'meadow' && rnd() < 0.22)) pine(ctx, { x, y, z: zz, s: range(rnd, 1.0, 1.35), ry: rnd() * TAU, lite: true });
        else oakImp(x, y, zz, range(rnd, 1.3, 1.8), false);
        ctx.rim = true;
      }
      z += bm === 'meadow' ? range(rnd, 10, 22) : range(rnd, 9, 18);
    }
  }
  ctx.rim = false;
}

// Oak groves: world gen plants them as runs of consecutive oak entries (the grove's centre first);
// the heroes are the ones world gen flags (d.hero). Only a leg (or a preview) with no flags at all
// falls back on each grove's biggest. Every oak also gets its collider radius (its bole matches it)
// and the oaks whose crowns may reach into its own.
function oakInfo(W, deco) {
  const out = new Map(), west = W.biome === 'fields';
  const cyl = new Map();
  for (const c of W.cyls || []) if (c.mat === 'tree') cyl.set(Math.round(c.x * 10) + ',' + Math.round(c.z * 10), c.r);
  const groves = []; let cur = null, prev = null;
  for (const d of deco) {
    if (d.k === 'oak') {
      if (cur && prev && prev.k === 'oak' && Math.hypot(d.x - cur[0].x, d.z - cur[0].z) < 13.5) cur.push(d);
      else { cur = [d]; groves.push(cur); }
    }
    prev = d;
  }
  const all = [], anyFlag = deco.some(d => d.hero !== undefined);
  for (const g of groves) {
    const flagged = anyFlag;
    let hero = null;
    if (!west) hero = flagged ? null : g.reduce((m, d) => ((d.s || 1) > (m.s || 1) ? d : m), g[0]);
    for (const d of g) {
      const h = !west && (flagged ? !!d.hero : d === hero);
      const o = { hero: h, rCol: cyl.get(Math.round(d.x * 10) + ',' + Math.round(d.z * 10)) || null, nb: [], d, Rc: oakSize(d, h, west).Rc };
      out.set(d, o); all.push(o);
    }
  }
  for (const o of all) for (const q of all) {
    if (o === q) continue;
    const dd = Math.hypot(o.d.x - q.d.x, o.d.z - q.d.z);
    if (dd < o.Rc + q.Rc) o.nb.push({ x: q.d.x, z: q.d.z, Rc: q.Rc, hero: q.hero });
  }
  return out;
}

// tomorrow's nature textures, painted one at a time in idle slots while the night lasts
const prewarmed = new Set();

export function buildNature(W) {
  const group = new THREE.Group();
  group.name = 'nature';
  const fires = [];
  const ctx = new Ctx(W);
  const deco = W.decor || [];
  const oaks = oakInfo(W, deco);
  for (const d of deco) {
    if (!NATURE_KINDS.has(d.k)) continue;
    try {
      switch (d.k) {
        case 'oak': oak(ctx, d, oaks.get(d)); break;
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
        case 'cairn': cairn(ctx, d); break;
        default: break;   // flowers & wheat are ground clutter (terrain3d)
      }
    } catch (e) { console.warn('nature: failed to build', d.k, e); }
  }
  try { rimTrees(ctx); } catch (e) { ctx.rim = false; console.warn('nature: rim trees', e); }
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
      m = b.build(mat); m.castShadow = !k.endsWith('#rim') && key !== 'apron'; m.receiveShadow = true;
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
        f.light.intensity = f.base * k * (0.3 + 0.7 * clamp01(atmo.night ?? 1));   // by day the sun outshines it
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

const fakeW = (biome, decor, extra = {}) => ({ biome, decor, cyls: extra.cyls || [], anchors: extra.anchors || [], heightAt: extra.heightAt || (() => 0) });
// A collider audit (tools/preview.mjs audit ...): generate real legs, build every solid rock and
// oak on its own, slice its mesh at a few heights above the ground and compare the cross-section
// with its collider: "gap" = how far inside the collider the rock surface sits (an invisible wall),
// "in" = how far rock pokes out past it (rock you could walk into). Logged as console errors.
function sliceExtents(batches, keys, cx, cz, Y, rMax, NB = 16, ground = null) {
  const ext = new Array(NB).fill(-1);
  for (const [k, b] of batches) {
    if (!keys.some(q => k.startsWith(q + '#'))) continue;
    const P = b.P, I = b.I;
    for (let t = 0; t < I.length; t += 3) {
      const v = [I[t], I[t + 1], I[t + 2]].map(i => [P[i * 3] - cx, P[i * 3 + 1], P[i * 3 + 2] - cz]);
      const hit = [];
      for (let e = 0; e < 3; e++) {
        const A = v[e], B = v[(e + 1) % 3];
        if ((A[1] - Y) * (B[1] - Y) > 0 || A[1] === B[1]) continue;
        const u = (Y - A[1]) / (B[1] - A[1]); hit.push([A[0] + (B[0] - A[0]) * u, A[2] + (B[2] - A[2]) * u]);
      }
      if (hit.length < 2) continue;
      for (let q = 0; q <= 12; q++) {
        const x = hit[0][0] + (hit[1][0] - hit[0][0]) * q / 12, z = hit[0][1] + (hit[1][1] - hit[0][1]) * q / 12, rr = Math.hypot(x, z);
        if (rr > (typeof rMax === 'function' ? rMax(Math.atan2(z, x)) : rMax)) continue;     // (debris lying further out is not the wall)
        if (ground && ground(cx + x, cz + z) > Y + 0.05) continue;                          // (rock under the ground, e.g. in a wall's slope, can't be reached)
        const bin = Math.round(((Math.atan2(z, x) + Math.PI) / TAU) * NB) % NB;
        ext[bin] = Math.max(ext[bin], rr);
      }
    }
  }
  return ext;
}
// the top of a rock over its collider's disc (an invisible step if the collider's top stands above it)
function topOver(batches, cx, cz, r) {
  const S = discSamples(cx, cz, r), best = S.map(() => null);
  for (const [k, b] of batches) {
    if (!k.startsWith('rock#') && !k.startsWith('hoodoo#')) continue;
    const hs = surfTop(i => [b.P[i * 3], b.P[i * 3 + 1], b.P[i * 3 + 2]], b.I, S);
    hs.forEach((h, i) => { if (h != null && (best[i] == null || h > best[i])) best[i] = h; });
  }
  return topOf(best);
}
function auditColliders(biome) {
  const day = BIOME_BY_DAY.indexOf(biome) + 1, rows = {}, green = biome === 'meadow' || biome === 'fields' || biome === 'snow';
  const add = (k, gap, out) => { const R = rows[k] || (rows[k] = { n: 0, gap: 0, gapMax: 0, out: 0, outMax: 0 }); R.n++; R.gap += gap; R.gapMax = Math.max(R.gapMax, gap); R.out += out; R.outMax = Math.max(R.outMax, out); };
  const tops = {};
  for (const seed of [777, 1234, 4242, 99]) {
    const W = generateLeg(seed, day);
    const oaks = oakInfo(W, W.decor);
    for (const d of W.decor) {
      if (!((d.k === 'rock' && (d.s > 1.2 || d.variant === 'hoodoo' || (green && d.s > 0.9))) || d.k === 'oak' || d.k === 'cairn')) continue;
      const ctx = new Ctx(W);
      if (d.k === 'oak') oak(ctx, d, oaks.get(d)); else if (d.k === 'cairn') cairn(ctx, d); else rock(ctx, d);
      const cm = d.k === 'oak' ? 'tree' : d.k === 'cairn' ? 'cairn' : 'rock';
      const cs = W.cyls.filter(c => c.mat === cm && Math.hypot(c.x - d.x, c.z - d.z) < (d.k === 'rock' ? 5 * d.s : 0.05));
      const kind = d.k === 'rock' ? (d.foot ? 'foot' : d.variant || (d.s > 1.2 ? 'boulder' : 'boulder-s')) : d.k;
      if (d.k === 'rock' && cs.length === 1 && d.variant !== 'hoodoo') {
        const c = cs[0], t = topOver(ctx.batches, c.x, c.z, c.r);
        if (t != null) { const T = tops[kind] || (tops[kind] = { n: 0, sum: 0, max: 0 }); const e = c.y + c.hh - t; T.n++; T.sum += e; T.max = Math.max(T.max, Math.abs(e)); if (Math.abs(e) > 0.4 && kind !== 'foot') console.error(`AUDITX ${kind} s ${d.s.toFixed(2)} e ${e.toFixed(2)} r ${c.r.toFixed(2)} top ${(c.y + c.hh - d.y).toFixed(2)} slope ${(Math.max(...[0, 1, 2, 3].map(q => W.heightAt(d.x + Math.cos(q * 1.57) * c.r, d.z + Math.sin(q * 1.57) * c.r))) - Math.min(...[0, 1, 2, 3].map(q => W.heightAt(d.x + Math.cos(q * 1.57) * c.r, d.z + Math.sin(q * 1.57) * c.r)))).toFixed(2)}`); }
      }
      // a Badlands ledge's oriented box: per bearing, the slice against the box's outline
      const bx = d.k === 'rock' && biome === 'badlands' ? (W.statics || []).find(q => q.part === 'rock_ledge' && Math.abs(q.x - d.x) < 0.05 && Math.abs(q.z - d.z) < 0.05) : null;
      if (bx) {
        const g = W.heightAt(bx.x, bx.z), top = bx.y + bx.hy, cr = Math.cos(bx.ry || 0), sr = Math.sin(bx.ry || 0), NB = 32;
        for (const h of [0.3, 0.6, 1.0, 1.5]) {
          if (g + h > top - 0.1) continue;
          const boxR = th => { const dx = Math.cos(th), dz = Math.sin(th), lx = dx * cr - dz * sr, lz = dx * sr + dz * cr; return Math.min(bx.hx / Math.max(1e-6, Math.abs(lx)), bx.hz / Math.max(1e-6, Math.abs(lz))); };
          const ext = sliceExtents(ctx.batches, ['rock'], bx.x, bx.z, g + h, th => boxR(th) + 0.45, NB);
          let gap = 0, out = 0, gm = 0, om = 0, n = 0;
          ext.forEach((e, k) => {
            if (e < 0) return;
            const th = k / NB * TAU - Math.PI, dx = Math.cos(th), dz = Math.sin(th);
            const lx = dx * cr - dz * sr, lz = dx * sr + dz * cr, R = Math.min(bx.hx / Math.max(1e-6, Math.abs(lx)), bx.hz / Math.max(1e-6, Math.abs(lz)));
            const gp = Math.max(0, R - e), op = Math.max(0, e - R); gap += gp; out += op; gm = Math.max(gm, gp); om = Math.max(om, op); n++;
          });
          if (n < NB * 0.75) { add('ledge-box (open slice)', 0, 0); continue; }
          const R = rows['ledge-box @' + h] || (rows['ledge-box @' + h] = { n: 0, gap: 0, gapMax: 0, out: 0, outMax: 0 });
          R.n++; R.gap += gap / n; R.gapMax = Math.max(R.gapMax, gm); R.out += out / n; R.outMax = Math.max(R.outMax, om);
        }
        const tS = discSamples(bx.x, bx.z, Math.min(bx.hx, bx.hz) * 0.8), best = tS.map(() => null);
        for (const [k, b] of ctx.batches) if (k.startsWith('rock#')) surfTop(i => [b.P[i * 3], b.P[i * 3 + 1], b.P[i * 3 + 2]], b.I, tS).forEach((hh, i) => { if (hh != null && (best[i] == null || hh > best[i])) best[i] = hh; });
        const t = topOf(best);
        if (t != null) { const T = tops['ledge-box'] || (tops['ledge-box'] = { n: 0, sum: 0, max: 0 }); const e = top - t; T.n++; T.sum += e; T.max = Math.max(T.max, Math.abs(e)); }
      }
      for (const c of cs) {
        const g = W.heightAt(c.x, c.z), top = c.y + c.hh;
        for (const h of d.k === 'cairn' ? [0.15, 0.4] : [0.3, 0.6, 1.0, 1.5]) {
          if (g + h > top - 0.1) continue;
          const ext = sliceExtents(ctx.batches, d.k === 'oak' ? ['bark_oak'] : ['rock'], c.x, c.z, g + h, d.k === 'rock' ? c.r + 0.45 : c.r * 2 + 0.6, 16, W.heightAt);
          const has = ext.filter(e => e >= 0);
          if (has.length < 12) { add((d.k === 'oak' ? 'oak' : kind) + ' (open slice)', 0, 0); continue; }
          const mn = Math.min(...has), mx = Math.max(...has);
          // (a wall-foot block encloses its collider on purpose: there only the gap counts)
          add((d.k === 'oak' ? (oaks.get(d).hero ? 'oak hero' : 'oak') : kind) + (d.k === 'rock' && d.s <= 1.2 && d.variant === 'hoodoo' ? ' small' : '') + ' @' + h, Math.max(0, c.r - mn), Math.max(0, mx - c.r));
        }
      }
    }
  }
  for (const [k, R] of Object.entries(rows)) console.error(`AUDIT ${biome} ${k}: slices ${R.n} · gap avg ${(R.gap / R.n).toFixed(2)} max ${R.gapMax.toFixed(2)} m · out avg ${(R.out / R.n).toFixed(2)} max ${R.outMax.toFixed(2)} m`);
  for (const [k, T] of Object.entries(tops)) console.error(`AUDIT ${biome} ${k} top: n ${T.n} · collider top above rock avg ${(T.sum / T.n).toFixed(2)} · |max| ${T.max.toFixed(2)} m`);
  return new THREE.Group();
}

// the colliders world gen gives a rock, as wireframes (to check a shape against them)
function colliderWires(W, d) {
  const g = new THREE.Group(), m = new THREE.MeshBasicMaterial({ color: 0xff2060, wireframe: true });
  const ctx = new Ctx(W), col = rockCol(ctx, d);
  const add = (x, z, r, y0, y1) => { const c = new THREE.Mesh(new THREE.CylinderGeometry(r, r, y1 - y0, 16, 2, true), m); c.position.set(x, (y0 + y1) / 2, z); g.add(c); };
  if (col.hoodoo) add(d.x, d.z, col.hoodoo.r, -0.3, col.hoodoo.Ht - 0.3);
  if (col.cyl) add(d.x, d.z, col.cyl.r, 0, col.cyl.top);
  if (col.arch) for (const sd of [-1, 1]) add(d.x + Math.cos(d.ry) * col.arch.span * sd, d.z - Math.sin(d.ry) * col.arch.span * sd, col.arch.r, -0.2 * col.S, 1.6 * col.S);
  for (const q of W.statics || []) {
    if (q.part !== 'rock_ledge') continue;
    const c = new THREE.Mesh(new THREE.BoxGeometry(q.hx * 2, q.hy * 2, q.hz * 2), m); c.position.set(q.x, q.y, q.z); c.rotation.y = q.ry || 0; g.add(c);
  }
  return g;
}
// a Badlands ledge as world gen makes it: an oriented box (part 'rock_ledge') yawed with the rock
const ledgeW = (s, x, ry = 0.4) => { const S = s * 1.25; return { statics: [{ part: 'rock_ledge', x, y: 0.6 * S, z: 0, hx: 1.3 * S, hy: 0.75 * S, hz: 0.7 * S, ry }] }; };
// a canyon wall rising toward -z past z = -1 (a 45-55 degree slope with a rounded toe), for the
// wall-foot boulders (the preview camera looks at it from +z)
const wallH = (x, z) => { const u = -z - 1 + 0.25 * Math.sin(x * 0.23), k = 1.1 + 0.18 * Math.sin(x * 0.4 + 1); return k * (u > 0.6 ? u : u < -0.6 ? 0 : (u + 0.6) ** 2 / 2.4); };
// the wall as a mesh (preview only): the day's cliff texture, mapped like the terrain maps its walls
function wallMesh(biome, x0 = -15, x1 = 15, z0 = -4.2, z1 = 0) {
  const NX = 60, NZ = 24, P = [], UV = [], I = [];
  const sc = { snow: 10.5, desert: 16, badlands: 17 }[biome] || 15;
  for (let j = 0; j <= NZ; j++) for (let i = 0; i <= NX; i++) { const x = x0 + (x1 - x0) * i / NX, z = z0 + (z1 - z0) * j / NZ, y = wallH(x, z) + 0.004; P.push(x, y, z); UV.push(x / sc, y / sc); }
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) { const a = j * (NX + 1) + i, b2 = a + 1, c = a + NX + 1, d = c + 1; I.push(a, c, b2, b2, c, d); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2)); g.setIndex(I); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ map: tex('cliff_' + (biome === 'fields' ? 'fields' : biome)), side: THREE.DoubleSide }));
  m.receiveShadow = true;
  return m;
}
// foot rocks against a stretch of wall (with the wall drawn), and one out on the open floor, with the
// colliders world gen would give them (mirrors shared/world.js rockCollide)
function footwall(biome, wires) {
  const spots = [[-9, 0.2, 1.5, 0.3], [-1, -0.3, 1.3, 2.2], [7, 0.4, 1.68, 4.1], [12.5, 4.5, 1.4, 1.0]];
  const decor = [], cyls = [];
  for (const [x, z, s2, ry] of spots) {
    const R = s2 * 1.1; let lo = Infinity, hi = -Infinity;
    for (const [dx, dz] of [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R]]) { const h = wallH(x + dx, z + dz); lo = Math.min(lo, h); hi = Math.max(hi, h); }
    const S = hi - lo > 0.8 * s2 ? s2 * 0.75 : s2, y = wallH(x, z);
    cyls.push(biome === 'desert' ? { x, y: y + S * 0.36, z, r: S * 0.95, hh: S * 0.45, mat: 'rock' } : { x, y: y + S * 0.3, z, r: S * 0.8, hh: S * 0.4, mat: 'rock' });
    decor.push({ k: 'rock', x, y, z, s: s2, ry, foot: true, variant: biome === 'desert' ? 'mound' : undefined });
  }
  const W = fakeW(biome, decor, { cyls, heightAt: wallH });
  const n = buildNature(W); n.update(0.016, 1.3);
  n.group.add(wallMesh(biome));
  if (wires) for (const d of decor) n.group.add(colliderWires(W, d));
  return n.group;
}
const pv = (k, extra = {}, w = {}) => ({ biome = 'meadow' } = {}) => {
  if (typeof w === 'function') w = w(biome);
  const d = { k, x: 0, y: 0, z: 0, ry: 0.4, s: 1, ...extra };
  if (w.heightAt) d.y = w.heightAt(d.x, d.z);
  const W = fakeW(biome, [d], w);
  if (w.statics) W.statics = w.statics;
  const n = buildNature(W);
  n.update(0.016, 1.3);
  if (w.wires) n.group.add(colliderWires(W, d));
  return n.group;
};
export const PREVIEW = {
  oak: pv('oak', { hero: false }), oak_big: pv('oak', { s: 1.3, x: 3.1, hero: false }), oak_hero: pv('oak', { s: 1.2, hero: true }),
  grove: ({ biome = 'meadow' } = {}) => {
    const decor = [[0, 0, 1.25], [7, 3.5, 0.95], [-6.5, 5, 1.05], [2, -8, 0.8], [-3, 11, 0.9]].map(([x, z, s]) => ({ k: 'oak', x, y: 0, z, s }));
    const n = buildNature(fakeW(biome, decor)); n.update(0.016, 1.3); return n.group;
  }, pine: pv('pine'), pine_small: pv('pine', { s: 0.8, x: 1.7 }), palm: pv('palm'),
  bush: pv('bush'), stump: pv('stump'), haybale: pv('haybale', { variant: 0 }), haystack: pv('haybale', { variant: 1 }),
  scarecrow: pv('scarecrow', { ry: 0.3 }), fence: pv('fence', { len: 5, ry: 1.2 }),
  fence_slope: pv('fence', { len: 7, ry: 0, x: 4 }, { heightAt: (x, z) => Math.max(0, z) * 0.32 }), fence_steep: pv('fence', { len: 7, ry: 0, x: 7 }, { heightAt: (x, z) => Math.max(0, z + 1) * 0.7 }), bones: pv('bones'),
  cactus: pv('cactus', { h: 3.2 }), cactus_small: pv('cactus', { h: 2.0, variant: 'saguaro', x: 2.3 }), prickly: pv('cactus', { h: 1.9, variant: 'pear' }),
  rock: pv('rock', { s: 1.0 }), outcrop: pv('rock', { s: 1.8, x: 4.2 }), rock2: pv('rock', { s: 1.5, x: 7.7 }), rock3: pv('rock', { s: 1.9, x: 11.3 }), boulder_a: pv('rock', { s: 1.5, x: 3 }), boulder_b: pv('rock', { s: 1.85, x: 6 }), rock4: pv('rock', { s: 1.3, x: -5.1 }), skull: pv('skull', { ry: 0.6 }),
  deadtree: pv('deadtree', { s: 1.1 }),
  hoodoo: pv('rock', { s: 1.8, variant: 'hoodoo' }), ledge: pv('rock', { s: 1.6, variant: 'ledge', x: 6 }), arch: pv('rock', { s: 1.6, variant: 'arch' }), mound: pv('rock', { s: 1.4, variant: 'mound', x: 6 }),
  hoodoo2: pv('rock', { s: 1.3, variant: 'hoodoo', x: 1.7 }), ledge2: pv('rock', { s: 1.9, variant: 'ledge', x: 4.4 }), ledge_small: pv('rock', { s: 0.9, variant: 'ledge', x: 2.2 }),
  mound2: pv('rock', { s: 1.9, variant: 'mound', x: 4.4 }), mound_small: pv('rock', { s: 1.0, variant: 'mound', x: 2.2 }),
  hoodoo_col: pv('rock', { s: 1.8, variant: 'hoodoo' }, { wires: true }), ledge_col: pv('rock', { s: 1.6, variant: 'ledge', x: 6 }, { wires: true }),
  arch_col: pv('rock', { s: 1.6, variant: 'arch' }, { wires: true }), mound_col: pv('rock', { s: 1.4, variant: 'mound', x: 6 }, { wires: true }), boulder_col: pv('rock', { s: 1.7, x: 3 }, { wires: true }),
  cairn: pv('cairn', { variant: 'skull' }), cairn2: pv('cairn', { variant: 'horn', x: 1.3 }), cairn3: pv('cairn', { variant: 'none', x: 2.9 }),
  anchor: ({ biome = 'meadow' } = {}) => buildNature(fakeW(biome, [], { cyls: [{ x: 0, y: 1.6, z: 0, r: 0.3, hh: 1.6, mat: 'deadtree' }], anchors: [{ id: 0, x: 0, y: 1.1, z: 0 }] })).group,
  ledge_box: pv('rock', { s: 1.6, variant: 'ledge', x: 6 }, ledgeW(1.6, 6)), ledge_box2: pv('rock', { s: 1.9, variant: 'ledge', x: -1, ry: 2.1 }, ledgeW(1.9, -1, 2.1)),
  ledge_box_s: pv('rock', { s: 1.25, variant: 'ledge', x: 13, ry: 1.2 }, ledgeW(1.25, 13, 1.2)), ledge_box_col: pv('rock', { s: 1.6, variant: 'ledge', x: 6 }, { ...ledgeW(1.6, 6), wires: true }),
  footwall: ({ biome = 'snow' } = {}) => footwall(biome, false), footwall_col: ({ biome = 'snow' } = {}) => footwall(biome, true),
  // a stretch of Westfall rim: a tiny grid with the apron's groves either side (they stand on the
  // apron's rising height, so they float over the flat preview patch: for their shapes, not their seating)
  rimgrove: ({ biome = 'fields' } = {}) => {
    const W = { biome, decor: [], cyls: [], anchors: [], seed: 11, X0: -4, nx: 2, cell: 2.5, Z0: -60, nz: 48, heightAt: () => 0 };
    const n = buildNature(W); n.update(0.016, 1.3); return n.group;
  },
  campfire: pv('fire'),
  audit: ({ biome = 'meadow' } = {}) => auditColliders(biome),
};
