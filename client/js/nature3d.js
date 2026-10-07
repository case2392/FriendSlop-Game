// Nature: trees, bushes, rocks, cacti, haybales, fences, bones, campfires: every W.decor entry of a
// natural kind, plus the dead-tree winch anchors.
//
// The look is WoW Classic: chunky low-poly silhouettes (thick flared trunks, huge clumped canopies,
// drooping pine tiers), smooth shading, and the detail painted into textures (paint/nature.js).
// Canopies are a solid leaf mass wrapped in alpha leaf-cluster cards whose normals point out of the
// clump, so a tree lights like a volume: warm on top, cool and dark underneath. Vertex colours carry
// baked AO and per-tree tint. A small shader hook adds wind sway and a world-space "top cover" that
// lays moss, lichen, snow, dust or sand on every up-facing surface, per biome.
//
// Performance: everything static is built in world space and merged per (material, 300 m stretch of
// road), so a whole leg of decor costs a few dozen draw calls however many trees there are.
// API: buildNature(W) -> { group, fires, update(dt, t, camPos) }, NATURE_KINDS, PREVIEW.
import { THREE, tex } from './gfx.js';
import { canvasFor } from './paint/index.js';
import { mergeVertices } from '/vendor/BufferGeometryUtils.js';

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
const WHITE = [1, 1, 1];
function noise3(x, y, z, s) {
  return (Math.sin(x * 1.7 + s) * Math.sin(y * 2.3 + s * 1.31) * Math.sin(z * 1.9 + s * 0.73)
    + 0.6 * Math.sin(x * 3.1 - z * 2.3 + s * 2.1) * Math.sin(y * 3.7 + x * 0.9 + s)) / 1.3;
}
function randDir(rnd) {
  const y = range(rnd, -1, 1), a = rnd() * TAU, r = Math.sqrt(1 - y * y);
  return new V3(Math.cos(a) * r, y, Math.sin(a) * r);
}

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

// atlas cells (canvas top-left = cell 0; UV v runs up)
const CELL = [[0, 0.5, 0.5, 1], [0.5, 0.5, 1, 1], [0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5]];
const inset = (c, m = 0.006) => [c[0] + m, c[1] + m, c[2] - m, c[3] - m];

// ---- the batch: merged world-space geometry for one material --------------------------------------

const _p = new V3(), _n = new V3();
class Batch {
  constructor(key) { this.key = key; this.P = []; this.N = []; this.UV = []; this.C = []; this.WD = []; this.X = []; this.I = []; this.n = 0; this.xf = null; this.nm = null; this.bill = false; }
  // bb = [center V3 (local), offX, offY]: a camera-facing card corner (the static corner p is what
  // the shadow pass sees)
  v(p, n, u, v, c, w = 0, bb = null) {
    if (this.xf) { _p.copy(p).applyMatrix4(this.xf); _n.copy(n).applyMatrix3(this.nm).normalize(); } else { _p.copy(p); _n.copy(n).normalize(); }
    this.P.push(_p.x, _p.y, _p.z); this.N.push(_n.x, _n.y, _n.z); this.UV.push(u, v);
    this.C.push(c[0], c[1], c[2]); this.WD.push(w);
    if (bb) {
      this.bill = true;
      if (this.xf) _p.copy(bb[0]).applyMatrix4(this.xf); else _p.copy(bb[0]);
      this.X.push(_p.x, _p.y, _p.z, bb[1], bb[2]);
    } else this.X.push(_p.x, _p.y, _p.z, 0, 0);
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
    if (this.bill) {
      const ctr = [], off = [];
      for (let i = 0; i < this.n; i++) { ctr.push(this.X[i * 5], this.X[i * 5 + 1], this.X[i * 5 + 2]); off.push(this.X[i * 5 + 3], this.X[i * 5 + 4]); }
      g.setAttribute('aCtr', new THREE.Float32BufferAttribute(ctr, 3));
      g.setAttribute('aOff', new THREE.Float32BufferAttribute(off, 2));
    }
    g.setIndex(this.n > 65535 ? new THREE.Uint32BufferAttribute(this.I, 1) : new THREE.Uint16BufferAttribute(this.I, 1));
    g.computeBoundingSphere();
    return new THREE.Mesh(g, material);
  }
}

// A tube along pts (local V3s) with radii. Normals come from the actual surface (finite
// differences), so lobes (root flares, cactus ribs) shade properly. u runs around, v along.
//   lobes(dir, t, i, j) multiplies the radius; color(p, n, t) / wind(p, t) per vertex;
//   uvMap(u, v) remaps into an atlas region.
function tube(b, pts, radii, o = {}) {
  const { sides = 8, uRep = 1, vLen = 1.5, v0 = 0, color = WHITE, wind = 0, lobes = null, uvMap = null, cap = false, a0 = 0 } = o;
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
      let u = j / S * uRep, v = VV[i];
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
    const tip = new V3().copy(pts[n - 1]).addScaledVector(T[n - 1], Math.max(0.004, radii[n - 1]) * 0.5);
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

// A deformed icosphere (rocks, leaf masses, lumps). shape(u: unit V3) -> local V3.
function sphereish(b, detail, shape, o = {}) {
  const I = ico(detail);
  const P = I.P.map(u => shape(u));
  mesh(b, P, I.idx, { ...o, uv: o.uv ? (p, n, i) => o.uv(I.P[i], p, n) : null });
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
  // e1 × e2 = nrm → (center, j, j+1) is counter-clockwise seen from the front
  for (let j = 0; j < seg; j++) b.t(base, base + 1 + j, base + 2 + j);
}

// ---- materials ----------------------------------------------------------------------------------------

const U_TIME = { value: 0 };
const COVER = {
  moss: { tex: 'cover_moss', lo: 0.42, hi: 0.72, noise: 1.3, scale: 0.4 },
  mossBark: { tex: 'cover_moss', lo: 0.62, hi: 0.9, noise: 1.2, scale: 0.7 },
  lichen: { tex: 'cover_lichen', lo: 0.5, hi: 0.8, noise: 1.3, scale: 0.45 },
  snow: { tex: 'cover_snow', lo: 0.48, hi: 0.72, noise: 0.9, scale: 0.35, gate: [0.18, 0.38] },
  snowRock: { tex: 'cover_snow', lo: 0.42, hi: 0.62, noise: 1.1, scale: 0.35, gate: [0.25, 0.45] },
  snowLeaf: { tex: 'cover_snow', lo: 0.35, hi: 0.62, noise: 1.3, scale: 0.6 },
  frost: { tex: 'cover_snow', lo: 0.45, hi: 0.8, noise: 1.5, scale: 0.7, gate: [0.42, 0.62] },
  snowNeedle: { tex: 'cover_snow', lo: 0.62, hi: 0.86, noise: 1.6, scale: 0.55, gate: [0.28, 0.5] },
  dust: { tex: 'cover_dust', lo: 0.72, hi: 0.95, noise: 1.0, scale: 0.35 },
  sand: { tex: 'cover_sand', lo: 0.62, hi: 0.9, noise: 1.0, scale: 0.3 },
};

// Alpha atlases go up as a DataTexture: transparent texels take the colour of the leaves next to
// them (no dark fringes in the mips), and each mip's alpha is rescaled so the alpha-tested coverage
// stays the same at a distance (canopies don't go thin and see-through far away).
const ATEX = new Map();
function alphaTex(name) {
  if (ATEX.has(name)) return ATEX.get(name);
  const cv = canvasFor(name), w = cv.width, h = cv.height;
  const src = cv.getContext('2d').getImageData(0, 0, w, h).data;
  const blurs = [3, 10, 30].map(px => {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.filter = `blur(${px}px)`; g.drawImage(cv, 0, 0);
    return g.getImageData(0, 0, w, h).data;
  });
  const L0 = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4, o = ((h - 1 - y) * w + x) * 4, a = src[k + 3];
    if (a >= 24) { L0[o] = src[k]; L0[o + 1] = src[k + 1]; L0[o + 2] = src[k + 2]; }
    else {
      let c = null;
      for (const B of blurs) if (B[k + 3] > 12) { c = [B[k], B[k + 1], B[k + 2]]; break; }
      if (!c) c = [44, 62, 34];
      L0[o] = c[0]; L0[o + 1] = c[1]; L0[o + 2] = c[2];
    }
    L0[o + 3] = a;
  }
  const quads = (lw, lh) => [[0, 0, lw >> 1, lh >> 1], [lw >> 1, 0, lw, lh >> 1], [0, lh >> 1, lw >> 1, lh], [lw >> 1, lh >> 1, lw, lh]];
  const cover = (d, lw, [x0, y0, x1, y1], k) => {
    let c = 0, n = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { if (d[(y * lw + x) * 4 + 3] * k > 127.5) c++; n++; }
    return n ? c / n : 0;
  };
  const cov0 = quads(w, h).map(q => cover(L0, w, q, 1));
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
    if (nw >= 8 && nh >= 8) {
      quads(nw, nh).forEach((qd, qi) => {
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

// The nature material: smooth Lambert + painted map + vertex colours (AO, tint), with optional
//   alpha (cutout cards, alpha-to-coverage), wind (sway by the aWind attribute), noFlip (both faces
//   keep the card's own normal: volumetric canopies), cover (world-space moss/snow/... on up-facing
//   surfaces; frontOnly: only on front faces), tri (triplanar world-space mapping, for rocks).
const MAT = new Map();
function natMat(texName, o = {}) {
  const key = texName + '|' + JSON.stringify(o);
  if (MAT.has(key)) return MAT.get(key);
  const m = new THREE.MeshLambertMaterial({
    map: o.alpha ? alphaTex(texName) : tex(texName),
    vertexColors: true,
    side: o.alpha || o.double ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: o.alpha ? 0.5 : 0,
  });
  if (o.alpha) m.alphaToCoverage = true;
  const C = o.cover ? COVER[o.cover] : null;
  m.onBeforeCompile = sh => {
    sh.uniforms.uTime = U_TIME;
    if (C) {
      sh.uniforms.uCoverMap = { value: tex(C.tex) };
      sh.uniforms.uCover = { value: new THREE.Vector4(C.lo, C.hi, C.noise, C.scale) };
      sh.uniforms.uCoverG = { value: new THREE.Vector2(...(C.gate || [0, 0])) };
    }
    sh.uniforms.uTri = { value: 1 / 2.6 };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float aWind; uniform float uTime; varying vec3 vNatW; varying vec3 vNatN;
        ${o.bill ? 'attribute vec3 aCtr; attribute vec2 aOff;' : ''}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        ${o.bill ? `{
          vec3 camR = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
          vec3 camU = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
          transformed = aCtr + camR * aOff.x + camU * aOff.y;
        }` : ''}
        ${o.wind ? `{
          float ph = uTime * 1.6 + position.x * 0.31 + position.z * 0.27;
          vec3 sw = vec3(sin(ph) + 0.45 * sin(ph * 2.3 + 1.3), 0.35 * sin(ph * 1.9 + 0.7), 0.7 * cos(ph * 0.83));
          transformed += sw * aWind * 0.055;
        }` : ''}`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vNatW = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vNatN = normalize(mat3(modelMatrix) * objectNormal);`);
    let fs = sh.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vNatW; varying vec3 vNatN; uniform float uTri;
      ${C ? 'uniform sampler2D uCoverMap; uniform vec4 uCover; uniform vec2 uCoverG;' : ''}`);
    if (o.tri) fs = fs.replace('#include <map_fragment>', `
      {
        vec3 tw = pow(abs(normalize(vNatN)), vec3(4.0)); tw /= (tw.x + tw.y + tw.z);
        vec4 tx = texture2D(map, vNatW.zy * uTri), ty = texture2D(map, vNatW.xz * uTri + 0.37), tz = texture2D(map, vNatW.xy * uTri);
        diffuseColor *= tx * tw.x + ty * tw.y + tz * tw.z;
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
        diffuseColor.rgb = mix(diffuseColor.rgb, cv.rgb * mix(0.6, 1.0, ao), k);
      }
      #include <lights_lambert_fragment>`);
    sh.fragmentShader = fs;
  };
  m.customProgramCacheKey = () => 'nature|' + key;
  MAT.set(key, m);
  return m;
}

// ---- biomes -----------------------------------------------------------------------------------------

const BIO = {
  meadow: {
    rock: 'rock_gray', rockCover: 'moss', rockTints: ['#ffffff', '#f0eee6', '#e6e8de', '#f4efe4'],
    oakTints: ['#ffffff', '#eef6dc', '#e2ecc8', '#fff4dc', '#f2f6e0', '#dfe9c8'], leafDensity: 1,
    pineTints: ['#ffffff', '#f2f8ea', '#e8f0de', '#f8f4e4'],
    bush: 'leaves', bushCells: [3], bushFill: 2, bushTints: ['#ffffff', '#f4f8e4', '#fffbe8'],
    deadTint: '#c4bcb4', barkCover: 'mossBark',
  },
  fields: {
    rock: 'rock_warm', rockCover: 'lichen', rockTints: ['#ffffff', '#f6eee0', '#ece4d4'],
    oakTints: ['#ffe490', '#f4d680', '#ffeaa0', '#ead078', '#f8e8a8'], leafDensity: 0.8, crownWarm: [1.18, 1.08, 0.7],
    pineTints: ['#f4f0d0', '#ece8c8'],
    bush: 'leaves', bushCells: [3], bushFill: 2, bushTints: ['#fff0b0', '#f8e8a4', '#fff6c8', '#f0eab0'],
    deadTint: '#d0c4b0',
  },
  snow: {
    rock: 'rock_granite', rockCover: 'snowRock', rockTints: ['#ffffff', '#eef0f6', '#e4e8f0'],
    oakTints: ['#d8e4d8'], leafDensity: 0.7,
    pineTints: ['#e2ecea', '#d6e4e2', '#eaf2ee', '#dce8e0'],
    bush: 'scrub', bushCells: [3], bushFill: 2, bushTints: ['#c8d8d8', '#bcd0d0', '#d4e0dc'],
    deadTint: '#c4bab4', snow: true,
  },
  badlands: {
    rock: 'rock_red', rockCover: 'dust', rockTints: ['#ffffff', '#f6ece4', '#ecdcd0'],
    oakTints: ['#e8d8a8'], leafDensity: 0.6,
    pineTints: ['#d8d4bc'],
    bush: 'scrub', bushCells: [0, 0, 1], bushFill: 2, bushTints: ['#fff6e0', '#fff0d4', '#ffffff'],
    deadTint: '#d8cab6', cactusTints: ['#c8c490', '#bcb884', '#d0cc9c'], deadCover: 'dust',
  },
  desert: {
    rock: 'rock_sand', rockCover: 'sand', rockTints: ['#ffffff', '#fbf4e8', '#f4ecdc'],
    oakTints: ['#e8e0a8'], leafDensity: 0.6,
    pineTints: ['#d8d8c0'],
    bush: 'scrub', bushCells: [0, 1, 1], bushFill: 2, bushTints: ['#fff8e4', '#fff4dc', '#ffffff'],
    deadTint: '#e8dccc', cactusTints: ['#ffffff', '#f0f4d8', '#e8f0cc'], palmTints: ['#ffffff', '#f4f0d0', '#eaf0c8'],
  },
};

function matFor(key, biome) {
  const B = BIO[biome] || BIO.meadow, snow = !!B.snow;
  const sc = c => (snow ? 'snow' : c);
  switch (key) {
    case 'bark_oak': return natMat('bark_oak', { cover: sc(B.barkCover || null) });
    case 'bark_pine': return natMat('bark_pine', { cover: sc(null) });
    case 'bark_dead': return natMat('bark_dead', { cover: sc(B.deadCover || null) });
    case 'bark_palm': return natMat('bark_palm', {});
    case 'wood': return natMat('wood_fence', { cover: sc(null) });
    case 'stump_top': return natMat('stump_top', { cover: sc(null) });
    case 'leaves': return natMat('leaves_oak', { alpha: true, noFlip: true, wind: true, bill: true });
    case 'scrub': return natMat('leaves_scrub', { alpha: true, noFlip: true, wind: true, bill: true, cover: snow ? 'frost' : null });
    case 'needles': return natMat('needles_pine', { alpha: true, wind: true, frontOnly: true, cover: snow ? 'snowNeedle' : null });
    case 'frond': return natMat('palm_frond', { alpha: true, wind: true });
    case 'rock': return natMat(B.rock, { tri: true, cover: B.rockCover });
    case 'cactus': return natMat('cactus_skin', {});
    case 'hay': return natMat('hay', {});
    case 'hay_end': return natMat('hay_end', {});
    case 'bone': return natMat('bone', { cover: snow ? 'snow' : null });
    case 'scarecrow': return natMat('scarecrow', {});
    case 'iron': return natMat('iron', {});
    default: return natMat('bark_dead', {});
  }
}

// ---- build context --------------------------------------------------------------------------------

class Ctx {
  constructor(W) {
    this.W = W; this.biome = BIO[W.biome] ? W.biome : 'meadow'; this.bio = BIO[this.biome];
    this.batches = new Map(); this.xf = null; this.nm = null; this.chunk = 0; this.base = new V3(); this.ry = 0;
  }
  // build in local space: origin at (x, y, z), turned by ry (and an optional extra local rotation)
  at(d, ry = 0, extra = null) {
    this.base.set(d.x, d.y, d.z); this.ry = ry;
    const m = new THREE.Matrix4().makeRotationY(ry);
    if (extra) m.multiply(extra);
    m.setPosition(d.x, d.y, d.z);
    this.xf = m; this.nm = new THREE.Matrix3().getNormalMatrix(m);
    this.chunk = Math.floor((d.z + 3000) / CHUNK);
  }
  b(key) {
    const k = key + '#' + this.chunk;
    let b = this.batches.get(k);
    if (!b) { b = new Batch(key); this.batches.set(k, b); }
    b.xf = this.xf; b.nm = this.nm;
    return b;
  }
  // ground height under local (lx, lz), relative to the origin's height
  gh(lx, lz) {
    if (!this.W.heightAt) return 0;
    const c = Math.cos(this.ry), s = Math.sin(this.ry);
    return this.W.heightAt(this.base.x + lx * c + lz * s, this.base.z - lx * s + lz * c) - this.base.y;
  }
}

// ---- foliage ---------------------------------------------------------------------------------------

// A leaf clump: a lumpy solid leaf mass, wrapped in leaf-cluster cards whose normals point out of
// the clump (so it lights like a ball of leaves), darker toward the bottom and the inside.
function clump(b, C, R, rnd, o) {
  const sq = o.squash ?? 0.8, inner = o.inner ?? 0.74, tint0 = o.tint || WHITE, ao = o.ao || (() => 1);
  const warm = o.warm || null, tintAt = p => (warm ? [tint0[0] * warm(p)[0], tint0[1] * warm(p)[1], tint0[2] * warm(p)[2]] : tint0);
  const fc = inset(CELL[o.fill], 0.02), sA = rnd() * 40, rows = 5, cols = 9, base = b.n;
  // the solid leaf mass: a lumpy lat-long ball (proper UVs: no smeared bands)
  for (let i = 0; i <= rows; i++) {
    const th = i / rows * Math.PI;
    for (let j = 0; j <= cols; j++) {
      const ph = j / cols * TAU + i * 0.3;
      const u = new V3(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
      const k = inner * (1 + 0.2 * noise3(u.x * 1.4, u.y * 1.4, u.z * 1.4, sA)), ky = u.y < 0 ? (o.under ?? 0.6) : 1;
      const p = new V3(C.x + u.x * R * k, C.y + u.y * R * k * sq * ky, C.z + u.z * R * k);
      const n = new V3(u.x, u.y / sq, u.z).normalize();
      b.v(p, n, fc[0] + (fc[2] - fc[0]) * j / cols, fc[3] - (fc[3] - fc[1]) * i / rows, mulc(tintAt(p), ao(p) * (o.massK ?? 0.55) * (1 + 0.36 * (u.y + 1) / 2)), (o.wind ?? 1) * 0.3);
    }
  }
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const a = base + i * (cols + 1) + j, bb = a + 1, c = a + cols + 1, d = c + 1;
    b.t(a, bb, c); b.t(bb, d, c);
  }
  // leaf-cluster cards around it, facing out
  const nC = o.cards, gold = 2.39996;
  const e1 = new V3(), up = new V3(), fn = new V3();
  for (let i = 0; i < nC; i++) {
    const yy = 1 - (i + 0.5) / nC * (o.span ?? 1.45);
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy)), ph = i * gold + range(rnd, -0.4, 0.4);
    const dir = new V3(Math.cos(ph) * rr, yy, Math.sin(ph) * rr).normalize();
    const rho = range(rnd, 0.45, 0.85);
    const P = new V3(C.x + dir.x * R * rho, C.y + dir.y * R * rho * sq * (dir.y < 0 ? (o.under ?? 0.6) : 1), C.z + dir.z * R * rho);
    fn.copy(dir).add(randDir(rnd).multiplyScalar(o.jit ?? 0.42)).normalize();
    up.copy(UP).addScaledVector(fn, -fn.y);
    if (up.lengthSq() < 0.01) up.set(1, 0, 0).addScaledVector(fn, -fn.x);
    up.normalize().applyAxisAngle(fn, range(rnd, -0.45, 0.45));
    e1.crossVectors(up, fn).normalize();
    const sz = o.size * range(rnd, 0.85, 1.15), hw = sz / 2;
    const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => new V3().copy(P).addScaledVector(e1, a * hw).addScaledVector(up, c * hw));
    const cell = inset(CELL[pick(rnd, o.cells)]);
    const us = [cell[0], cell[2], cell[2], cell[0]], vs = [cell[1], cell[1], cell[3], cell[3]];
    const vb = b.n, side = 0.62 + 0.38 * (dir.y + 1) / 2, rot = range(rnd, -0.35, 0.35), cr = Math.cos(rot), sr = Math.sin(rot);
    const offs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => [(a * cr - c * sr) * hw, (a * sr + c * cr) * hw]);
    cs.forEach((p, k) => {
      const q = new V3(P.x + offs[k][0] * 0.5, P.y + offs[k][1], P.z);      // roughly where the billboard corner sits
      const nn = new V3().subVectors(q, C).normalize().multiplyScalar(0.55).addScaledVector(dir, 0.45).add(new V3(0, 0.1, 0)).normalize();
      b.v(p, nn, us[k], vs[k], mulc(tintAt(q), ao(q) * side * (0.82 + 0.18 * rho)), (o.wind ?? 1) * (k >= 2 ? 1 : 0.7), [P, offs[k][0], offs[k][1]]);
    });
    b.t(vb, vb + 1, vb + 2); b.t(vb, vb + 2, vb + 3);
  }
}

// ---- trees -----------------------------------------------------------------------------------------

const barkAO = (y0 = 0, y1 = 1.8, lo = 0.5) => p => { const k = lo + (1 - lo) * smooth(y0, y1, p.y); return [k, k, k]; };

function roots(ctx, b, rootA, r0, s, rnd, { len = [1.1, 1.7], rad = 0.3, up = 0.85, sides = 7 } = {}) {
  for (const ra of rootA) {
    const dx = Math.cos(ra), dz = Math.sin(ra), L = range(rnd, len[0], len[1]) * s;
    const steps = [[0, up], [0.3, up * 0.45], [0.62, 0.12], [0.85, -0.04], [1.08, -0.3]];
    const pts = steps.map(([f, yy]) => {
      const x = dx * (r0 * 0.35 + f * L) + range(rnd, -0.06, 0.06) * s, z = dz * (r0 * 0.35 + f * L) + range(rnd, -0.06, 0.06) * s;
      return new V3(x, ctx.gh(x, z) + yy * s, z);
    });
    const R = rad * s;
    tube(b, pts, [R, R * 0.8, R * 0.55, R * 0.33, R * 0.12], { sides, uRep: 1, vLen: 1.4, color: barkAO(-0.3, 1.2, 0.5) });
  }
}

function oak(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 11)), s = d.s || 1, B = ctx.bio;
  ctx.at(d, d.ry || 0);
  const bark = ctx.b('bark_oak'), leaves = ctx.b('leaves');
  const r0 = 0.44 * s, H = range(rnd, 2.9, 3.6) * s;
  const lx = range(rnd, -0.4, 0.4) * s, lz = range(rnd, -0.4, 0.4) * s;
  const nR = 5 + (rnd() < 0.5 ? 1 : 0), a0 = rnd() * TAU;
  const rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.3, 0.3));
  const tp = [], tr = [], NT = 7;
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, y = -0.5 + t * (H + 0.5), wob = Math.sin(t * 3.2 + a0) * 0.12 * s * t;
    tp.push(new V3(lx * t * t + wob, y, lz * t * t - wob * 0.6));
    const fl = Math.pow(clamp01(1 - (y + 0.2) / (1.15 * s)), 2);     // the flare stays below the bumper
    tr.push(r0 * (1.04 - 0.1 * t) * (1 + 0.6 * fl));
  }
  const lobes = (dir, t, i) => {
    const f = Math.pow(clamp01(1 - (tp[i].y + 0.2) / (1.4 * s)), 1.5), ph = Math.atan2(dir.z, dir.x);
    let m = 0; for (const ra of rootA) m = Math.max(m, clamp01(1 - angDiff(ph, ra) / 0.55));
    return (1 + f * 0.9 * m * m) * (1 + 0.05 * Math.sin(ph * 7 + i * 1.7));
  };
  tube(bark, tp, tr, { sides: 10, uRep: 2, vLen: 1.4, lobes, color: barkAO(-0.3, 1.8, 0.5) });
  roots(ctx, bark, rootA, r0, s, rnd, { len: [0.75, 1.15], rad: 0.36, up: 0.95 });
  // limbs, each ending in a clump; a leader up the middle to a big crown clump; high clumps
  // between the limbs round the canopy off into a dome (an Elwynn oak, not a flat-topped acacia)
  const F = tp[NT], rT = tr[NT], clumps = [];
  const nL = 3 + (rnd() < 0.6 ? 1 : 0), la0 = rnd() * TAU;
  const bc = barkAO(0, 3, 0.75);
  for (let k = 0; k < nL; k++) {
    const a = la0 + k * TAU / nL + range(rnd, -0.35, 0.35), dx = Math.cos(a), dz = Math.sin(a);
    const out = range(rnd, 1.7, 2.4) * s, up = range(rnd, 1.7, 2.5) * s;
    const j = () => range(rnd, -0.18, 0.18) * s;
    const pts = [
      new V3(F.x - dx * 0.1, F.y - 0.55 * s, F.z - dz * 0.1),
      new V3(F.x + dx * out * 0.35 + j(), F.y + up * 0.25, F.z + dz * out * 0.35 + j()),
      new V3(F.x + dx * out * 0.72 + j(), F.y + up * 0.62, F.z + dz * out * 0.72 + j()),
      new V3(F.x + dx * out, F.y + up, F.z + dz * out),
    ];
    tube(bark, pts, [rT * 0.8, rT * 0.62, rT * 0.46, rT * 0.28], { sides: 8, uRep: 1.5, vLen: 1.4, color: bc });
    clumps.push([new V3(pts[3].x, pts[3].y + 0.55 * s, pts[3].z), range(rnd, 1.9, 2.35) * s]);
    if (rnd() < 0.5) {
      const b2 = a + (rnd() < 0.5 ? -1 : 1) * range(rnd, 0.7, 1.1), L2 = range(rnd, 0.9, 1.3) * s;
      const m0 = pts[1].clone().lerp(pts[2], 0.5);
      const e = new V3(m0.x + Math.cos(b2) * L2, m0.y + L2 * 0.5, m0.z + Math.sin(b2) * L2);
      tube(bark, [m0, m0.clone().lerp(e, 0.5).add(new V3(0, 0.12 * s, 0)), e], [rT * 0.3, rT * 0.22, rT * 0.14], { sides: 6, uRep: 1, vLen: 1.4, color: bc });
      clumps.push([new V3(e.x, e.y + 0.3 * s, e.z), range(rnd, 1.4, 1.7) * s]);
    }
  }
  const top = new V3(F.x + range(rnd, -0.3, 0.3) * s, F.y + range(rnd, 2.5, 3.1) * s, F.z + range(rnd, -0.3, 0.3) * s);
  tube(bark, [new V3(F.x, F.y - 0.4 * s, F.z), F.clone().lerp(top, 0.5), top], [rT * 0.7, rT * 0.5, rT * 0.26], { sides: 8, uRep: 1.5, vLen: 1.4, color: bc });
  clumps.push([new V3(top.x, top.y + 0.6 * s, top.z), range(rnd, 2.4, 2.8) * s]);
  for (let k = 0; k < 2; k++) {
    const a = la0 + (k * 2 + 1) * TAU / (nL * 1.4) + range(rnd, -0.3, 0.3), dd = range(rnd, 1.1, 1.6) * s;
    clumps.push([new V3(F.x + Math.cos(a) * dd, F.y + range(rnd, 2.8, 3.4) * s, F.z + Math.sin(a) * dd), range(rnd, 1.8, 2.2) * s]);
  }
  let yLo = Infinity, yHi = -Infinity;
  for (const [c, R] of clumps) { yLo = Math.min(yLo, c.y - R * 0.8); yHi = Math.max(yHi, c.y + R * 0.8); }
  const tint = lin(pick(rnd, B.oakTints));
  const ao = p => 0.3 + 0.7 * Math.pow(smooth(yLo, yHi, p.y), 1.1);
  // the sunlit crown goes warm yellow-green, the way the Elwynn canopies do
  const wk = B.crownWarm || [1.12, 1.1, 0.8];
  const warm = p => { const t = smooth(yLo + (yHi - yLo) * 0.55, yHi, p.y); return [1 + (wk[0] - 1) * t, 1 + (wk[1] - 1) * t, 1 + (wk[2] - 1) * t]; };
  for (const [c, R] of clumps) {
    clump(leaves, c, R, rnd, { cards: Math.round((5 + 2.8 * (R / s) ** 2) * B.leafDensity), size: range(rnd, 1.9, 2.3) * s, cells: [0, 0, 1], fill: 2, tint, ao, warm, squash: 0.88, inner: 0.68 });
  }
}

function pine(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 12)), s = d.s || 1, B = ctx.bio, snow = !!B.snow;
  ctx.at(d, d.ry || 0);
  const bark = ctx.b('bark_pine'), nd = ctx.b('needles');
  const H = (snow ? range(rnd, 8, 10.5) : range(rnd, 7.5, 10)) * s, r0 = 0.31 * s;
  const lx = range(rnd, -0.25, 0.25) * s, lz = range(rnd, -0.25, 0.25) * s;
  const tp = [], tr = [], NT = 6;
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, y = -0.4 + t * (H * 0.92 + 0.4);
    tp.push(new V3(lx * t * t, y, lz * t * t));
    tr.push(Math.max(0.03 * s, r0 * (1.05 - 0.92 * t) * (1 + 0.5 * Math.pow(clamp01(1 - (y + 0.2) / (1.0 * s)), 2))));
  }
  const center = y => { const t = clamp01((y + 0.4) / (H + 0.4)); return [lx * t * t, lz * t * t]; };
  const nR = 4, a0 = rnd() * TAU, rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.4, 0.4));
  tube(bark, tp, tr, {
    sides: 8, uRep: 2, vLen: 2.2, color: barkAO(-0.3, 1.5, 0.45),
    lobes: (dir, t, i) => { const f = Math.pow(clamp01(1 - (tp[i].y + 0.2) / (0.9 * s)), 1.5), ph = Math.atan2(dir.z, dir.x); let m = 0; for (const ra of rootA) m = Math.max(m, clamp01(1 - angDiff(ph, ra) / 0.6)); return 1 + f * 0.8 * m * m; },
  });
  roots(ctx, bark, rootA, r0, s, rnd, { len: [0.7, 1.0], rad: 0.2, up: 0.5, sides: 6 });
  const tint = lin(pick(rnd, B.pineTints));
  const nT = snow ? 8 + (rnd() < 0.5 ? 1 : 0) : 6 + Math.floor(rnd() * 2.5);
  const y0 = (snow ? 1.1 : 1.5) * s, y1 = H * 0.88;
  const Rb = (snow ? 3.1 : 2.9) * s * range(rnd, 0.9, 1.1);
  const dyT = (y1 - y0) / (nT - 1);
  const cellC = inset(CELL[2]);
  for (let i = 0; i <= nT; i++) {
    const last = i === nT, t = Math.min(1, i / (nT - 1));
    const y = last ? H * 0.95 : y0 + (y1 - y0) * Math.pow(t, 0.92) + range(rnd, -0.12, 0.12) * s;
    const R = last ? 0.5 * s : Rb * (1 - 0.8 * t) * range(rnd, 0.9, 1.08) + 0.22 * s;
    const droop = R * (snow ? 0.58 : 0.5);
    const [cx, cz] = center(y);
    const tierAO = 0.55 + 0.45 * t;
    // the dark solid cone under the boughs
    if (!last) tube(nd, [new V3(cx, y - droop * 0.75, cz), new V3(cx, y + dyT * (t > 0.6 ? 0.55 : 0.9), cz)], [R * 0.62, 0.06 * s], {
      sides: 9, uRep: 1, vLen: dyT + droop,
      uvMap: (u, v) => [cellC[0] + u * (cellC[2] - cellC[0]), cellC[1] + clamp01(v) * (cellC[3] - cellC[1])],
      color: mulc(tint, 0.72 * tierAO), wind: 0.2,
    });
    const K = last ? 4 : Math.max(5, Math.round(4.5 + R / s * 2.6)), th0 = rnd() * TAU;
    for (let k = 0; k < K; k++) {
      const th = th0 + k * TAU / K + range(rnd, -0.2, 0.2), dx = Math.cos(th), dz = Math.sin(th);
      const RR = R * range(rnd, 0.88, 1.12), W = TAU * RR / K * 1.5, dr = droop * range(rnd, 0.8, 1.2);
      const tilt = Math.atan2(dr, RR);
      const nrm = new V3(dx * Math.sin(tilt) * 0.9, Math.cos(tilt), dz * Math.sin(tilt) * 0.9).normalize();
      const rowsF = [[0.04, 0.16, 0.38], [0.52, -0.3, 0.9], [1.0, -1.0, 0.85]];
      const rows = rowsF.map(([f, yf, wf]) => {
        const rho = RR * f, yy = y + (yf > 0 ? yf * s : yf * dr);
        const px = cx + dx * rho, pz = cz + dz * rho, hw = W * wf / 2;
        return [new V3(px + dz * hw, yy, pz - dx * hw), new V3(px - dz * hw, yy, pz + dx * hw)];
      });
      const cell = inset(CELL[last ? 3 : (rnd() < 0.5 ? 0 : 1)]);
      const vs = [cell[1], (cell[1] + cell[3]) / 2, cell[3]];
      strip(nd, rows, [cell[0], cell[2]], vs, (ri) => new V3().copy(nrm).add(new V3(dx, 0, dz).multiplyScalar(ri * 0.15)).normalize(),
        ri => mulc(tint, tierAO * [0.65, 0.88, 1.0][ri]), ri => [0, 0.45, 1][ri] * 0.8, nrm);
    }
  }
}

function palm(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 13)), s = d.s || 1, B = ctx.bio;
  ctx.at(d, d.ry || 0);
  const bark = ctx.b('bark_palm'), fr = ctx.b('frond');
  const L = range(rnd, 5.6, 7.2) * s, la = rnd() * TAU, lean = range(rnd, 0.6, 1.5) * s;
  const pts = [], rad = [];
  for (let i = 0; i <= 9; i++) {
    const t = i / 9, y = -0.4 + t * (L + 0.4), off = lean * Math.pow(t, 1.7) + Math.sin(t * Math.PI) * 0.15 * s;
    pts.push(new V3(Math.cos(la) * off, y, Math.sin(la) * off));
    rad.push(s * (0.21 + 0.11 * (1 - t) + 0.12 * Math.pow(clamp01(1 - (y + 0.2) / 0.9), 2)));
  }
  tube(bark, pts, rad, { sides: 9, uRep: 2, vLen: 2.6, color: barkAO(-0.3, 1.2, 0.55) });
  const T = pts[9];
  // crown knob + coconuts
  const knob = (C, r, col) => sphereish(bark, 1, u => new V3(C.x + u.x * r, C.y + u.y * r, C.z + u.z * r), { uv: u => [u.x * 0.5 + 0.5, u.y * 0.5 + 0.5], color: col });
  knob(new V3(T.x, T.y + 0.05, T.z), 0.3 * s, lin('#c8c8a0'));
  for (let k = 0; k < 3 + Math.floor(rnd() * 3); k++) {
    const a = rnd() * TAU;
    knob(new V3(T.x + Math.cos(a) * 0.24 * s, T.y - 0.18 * s, T.z + Math.sin(a) * 0.24 * s), 0.14 * s, lin('#6a5038'));
  }
  const tint = lin(pick(rnd, B.palmTints || ['#ffffff']));
  const frond = (az, e0, Lf, Wf, cell, dryK) => {
    const ca = Math.cos(az), sa = Math.sin(az), ax = -sa, az2 = ca;
    const rows = [];
    const N = 7;
    for (let i = 0; i <= N; i++) {
      const t = i / N, hd = Lf * t * Math.cos(e0) * (1 - 0.1 * t), y = T.y + 0.05 + Lf * t * Math.sin(e0) - Lf * 0.42 * t * t;
      const w = Wf * Math.pow(Math.sin(Math.PI * Math.min(1, 0.1 + t * 0.95)), 0.7) / 2;
      const px = T.x + ca * hd, pz = T.z + sa * hd, drop = w * 0.35;
      rows.push([new V3(px + ax * w, y - drop, pz + az2 * w), new V3(px, y, pz), new V3(px - ax * w, y - drop, pz - az2 * w)]);
    }
    const c = inset(cell, 0.004);
    const us = [c[0], (c[0] + c[2]) / 2, c[2]], vs = rows.map((_, i) => c[1] + (c[3] - c[1]) * i / N);
    strip(fr, rows, us, vs, (ri, ci) => {
      const t = ri / N, slope = Math.cos(e0) * 0 + (Math.sin(e0) - t);
      return new V3(-ca * slope * 0.5 + (ci - 1) * ax * 0.45, 1, -sa * slope * 0.5 + (ci - 1) * az2 * 0.45).normalize();
    }, ri => mulc(tint, (0.7 + 0.3 * ri / N) * dryK), ri => ri / N * 1.2, UP);
  };
  const nF = 12 + Math.floor(rnd() * 4), f0 = rnd() * TAU;
  for (let k = 0; k < nF; k++) frond(f0 + k * TAU / nF + range(rnd, -0.2, 0.2), range(rnd, 0.15, 0.85), range(rnd, 3.2, 4.2) * s, range(rnd, 1.15, 1.4) * s, [0, 0, 0.5, 1], 1);
  for (let k = 0; k < 3; k++) frond(rnd() * TAU, range(rnd, -1.2, -0.8), range(rnd, 1.6, 2.2) * s, 0.9 * s, [0.5, 0, 1, 1], 0.8);
}

function bush(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 14)), s = d.s || 1, B = ctx.bio;
  ctx.at(d, d.ry || 0);
  const b = ctx.b(B.bush);
  const tint = lin(pick(rnd, B.bushTints));
  const n = 2 + Math.floor(rnd() * 2.5);
  const dry = B.bush === 'scrub' && !B.snow, ao = p => (dry ? 0.7 : 0.6) + (dry ? 0.3 : 0.4) * smooth(0, 1.4 * s, p.y);
  const warm = B.snow ? null : p => { const t = smooth(0.5 * s, 1.5 * s, p.y); return [1 + 0.12 * t, 1 + 0.1 * t, 1 - 0.15 * t]; };
  for (let k = 0; k < n; k++) {
    const a = rnd() * TAU, dd = k === 0 ? 0 : range(rnd, 0.35, 0.65) * s, R = (k === 0 ? range(rnd, 0.75, 0.95) : range(rnd, 0.5, 0.75)) * s;
    const C = new V3(Math.cos(a) * dd, R * 0.62, Math.sin(a) * dd);
    C.y += ctx.gh(C.x, C.z);
    clump(b, C, R, rnd, { cards: Math.round(7 + 7 * (R / s) ** 2), size: range(rnd, 1.0, 1.25) * s, cells: B.bushCells, fill: B.bushFill, tint, ao, warm, squash: 0.78, inner: dry ? 0.55 : B.snow ? 0.55 : 0.7, wind: 0.6, massK: dry ? 0.75 : B.snow ? 0.38 : 0.55 });
  }
}

function deadTree(ctx, s, rnd, { r0 = 0.27, ring = null } = {}) {
  const b = ctx.b('bark_dead');
  const tint = lin(ctx.bio.deadTint || '#c8c0b8');
  const col = (lo) => (p) => mulc(tint, lo + (1 - lo) * smooth(-0.2, 1.4, p.y));
  const H = range(rnd, 3.4, 4.6) * s, a0 = rnd() * TAU;
  const tp = [], tr = [], NT = 6;
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, y = -0.4 + t * (H + 0.4);
    tp.push(new V3(Math.sin(t * 3.1 + a0) * 0.36 * t * s + Math.sin(t * 7 + a0) * 0.06 * t, y, Math.cos(t * 2.3 + a0) * 0.3 * t * s));
    tr.push(r0 * (1.08 - 0.6 * t) * (1 + 0.6 * Math.pow(clamp01(1 - (y + 0.2) / 1.1), 2)));
  }
  const nR = 3 + (rnd() < 0.5 ? 1 : 0), rootA = []; for (let k = 0; k < nR; k++) rootA.push(a0 + k * TAU / nR + range(rnd, -0.4, 0.4));
  tube(b, tp, tr, {
    sides: 10, uRep: 1.5, vLen: 1.6, color: col(0.5), cap: true,
    lobes: (dir, t, i) => { const f = Math.pow(clamp01(1 - (tp[i].y + 0.2) / 1.0), 1.5), ph = Math.atan2(dir.z, dir.x); let m = 0; for (const ra of rootA) m = Math.max(m, clamp01(1 - angDiff(ph, ra) / 0.8)); return (1 + f * 0.6 * m * m) * (1 + 0.06 * Math.sin(ph * 5 + i)); },
  });
  roots(ctx, b, rootA, r0, 1, rnd, { len: [0.6, 0.9], rad: 0.16, up: 0.45, sides: 6 });
  // gnarled limbs reaching up, with twigs
  const nL = 5 + Math.floor(rnd() * 2.5);
  for (let k = 0; k < nL; k++) {
    const t = range(rnd, 0.32, 0.9), i = Math.min(NT - 1, Math.floor(t * NT)), f = t * NT - i;
    const P0 = tp[i].clone().lerp(tp[i + 1], f), rB = Math.max(0.07, (tr[i] + (tr[i + 1] - tr[i]) * f) * 0.8);
    const a = a0 + k * TAU / nL + range(rnd, -0.4, 0.4), L = range(rnd, 1.7, 2.9) * s;
    const pts = [P0];
    let dir = new V3(Math.cos(a), range(rnd, 0.5, 1.0), Math.sin(a)).normalize();
    for (let j = 1; j <= 4; j++) {
      dir.add(new V3(range(rnd, -0.5, 0.5), range(rnd, -0.1, 0.35), range(rnd, -0.5, 0.5))).normalize();
      pts.push(pts[j - 1].clone().addScaledVector(dir, L / 4));
    }
    tube(b, pts, [rB, rB * 0.75, rB * 0.52, rB * 0.3, 0.02], { sides: 6, uRep: 1, vLen: 1.6, color: col(0.75) });
    for (let tw = 0; tw < 3; tw++) {
      const q = pts[1 + tw], td = new V3(range(rnd, -1, 1), range(rnd, 0.3, 1), range(rnd, -1, 1)).normalize(), tl = range(rnd, 0.5, 1.0) * s;
      tube(b, [q, q.clone().addScaledVector(td, tl * 0.5).add(new V3(0, 0.05, 0)), q.clone().addScaledVector(td, tl)], [rB * 0.25, rB * 0.15, 0.008], { sides: 5, uRep: 1, vLen: 1.6, color: col(0.8) });
    }
  }
  if (ring != null) {
    // the winch strap: an iron band round the trunk at the hook's height, and a shackle ring
    let i = 0; while (i < NT - 1 && tp[i + 1].y < ring) i++;
    const f = clamp01((ring - tp[i].y) / (tp[i + 1].y - tp[i].y)), c = tp[i].clone().lerp(tp[i + 1], f), rr = tr[i] + (tr[i + 1] - tr[i]) * f + 0.03;
    const ib = ctx.b('iron'), loop = [];
    for (let k = 0; k <= 14; k++) { const a = k / 14 * TAU; loop.push(new V3(c.x + Math.cos(a) * rr, c.y + Math.sin(a * 3) * 0.015, c.z + Math.sin(a) * rr)); }
    tube(ib, loop, loop.map(() => 0.035), { sides: 5, uRep: 1, vLen: 0.4, color: WHITE });
    const sh = [];
    for (let k = 0; k <= 12; k++) { const a = k / 12 * TAU; sh.push(new V3(c.x + rr + 0.1 + Math.cos(a) * 0.09, c.y - 0.1 + Math.sin(a) * 0.11, c.z)); }
    tube(ib, sh, sh.map(() => 0.022), { sides: 5, uRep: 1, vLen: 0.4, color: WHITE });
  }
}

function stump(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 15)), s = d.s || 1;
  ctx.at(d, d.ry || 0);
  const bark = ctx.b(ctx.biome === 'badlands' || ctx.biome === 'desert' ? 'bark_dead' : 'bark_oak'), top = ctx.b('stump_top');
  const R = range(rnd, 0.42, 0.56) * s, H = range(rnd, 0.45, 0.8) * s, a0 = rnd() * TAU;
  const rootA = []; for (let k = 0; k < 4; k++) rootA.push(a0 + k * TAU / 4 + range(rnd, -0.3, 0.3));
  const pts = [new V3(0, -0.35, 0), new V3(0, 0.1, 0), new V3(0, H * 0.55, 0), new V3(0, H, 0), new V3(0, H + 0.012, 0)];
  const rad = [R * 1.3, R * 1.12, R * 1.02, R, R * 0.88];
  tube(bark, pts, rad, {
    sides: 11, uRep: 2, vLen: 1.4, color: barkAO(-0.3, 0.8, 0.55),
    lobes: (dir, t, i) => { if (i >= 3) return 1 + 0.04 * Math.sin(Math.atan2(dir.z, dir.x) * 6); const f = i === 0 ? 1 : i === 1 ? 0.6 : 0.15, ph = Math.atan2(dir.z, dir.x); let m = 0; for (const ra of rootA) m = Math.max(m, clamp01(1 - angDiff(ph, ra) / 0.6)); return 1 + f * 0.6 * m * m; },
  });
  roots(ctx, bark, rootA, R, s * 0.8, rnd, { len: [0.6, 0.9], rad: 0.24, up: 0.4 });
  disc(top, new V3(0, H + 0.014, 0), UP, R * 0.9, 14, (c, sn) => [0.5 + c * 0.43, 0.5 + sn * 0.43]);
}

// ---- rocks ------------------------------------------------------------------------------------------

function boulder(b, C, R, rnd, o = {}) {
  const sA = rnd() * 50, rot = rnd() * TAU, cr = Math.cos(rot), sr = Math.sin(rot);
  const cuts = [];
  for (let k = 0; k < (o.cuts ?? 3); k++) { const d = randDir(rnd); d.y = Math.abs(d.y) * 0.8 + 0.1; cuts.push([d.normalize(), range(rnd, 0.6, 0.85)]); }
  const sq = o.sq ?? 0.72, nz = o.noise ?? 0.16, sx = o.sx ?? 1, sz = o.sz ?? 1;
  const tint = o.tint || WHITE;
  sphereish(b, R > 0.8 || o.fine ? 2 : 1, u => {
    const k = 1 + nz * noise3(u.x * 1.2, u.y * 1.2, u.z * 1.2, sA) + 0.05 * noise3(u.x * 3, u.y * 3, u.z * 3, sA + 7);
    const p = new V3(u.x * k, u.y * k, u.z * k);
    for (const [n, dd] of cuts) { const e = p.dot(n) - dd; if (e > 0) p.addScaledVector(n, -e * 0.85); }
    p.y *= sq;
    if (p.y < -0.3 * sq) p.y = -0.3 * sq + (p.y + 0.3 * sq) * 0.3;
    const x = p.x * sx, z = p.z * sz;
    return new V3(C.x + (x * cr - z * sr) * R, C.y + p.y * R, C.z + (x * sr + z * cr) * R);
  }, { color: p => mulc(tint, 0.5 + 0.5 * smooth(C.y - 0.3 * R * sq, C.y + 0.5 * R * sq, p.y)) });
}

function rock(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 16)), S = d.s || 1, B = ctx.bio, bm = ctx.biome;
  ctx.at(d, d.ry || 0);
  const b = ctx.b('rock');
  const tint = () => lin(pick(rnd, B.rockTints));
  const g = (x, z) => ctx.gh(x, z);
  if (bm === 'badlands') {
    if (S > 1.45 && rnd() < 0.3) {        // a hoodoo: a tall column with a cap slab
      const h = S * range(rnd, 1.6, 2.2);
      boulder(b, new V3(0, g(0, 0) + h * 0.32, 0), S * 0.6, rnd, { sq: h / S * 1.15, sx: 0.8, sz: 0.7, cuts: 4, noise: 0.22, tint: tint() });
      boulder(b, new V3(0, g(0, 0) + h * 0.42, 0), S * 0.85, rnd, { sq: 0.5, cuts: 3, noise: 0.2, tint: tint() });
      boulder(b, new V3(0.08 * S, g(0, 0) + h * 0.98, 0), S * 0.62, rnd, { sq: 0.55, cuts: 3, noise: 0.18, tint: tint() });
    } else {                                // blocky broken boulders (the strata come from the texture)
      boulder(b, new V3(0, g(0, 0) + S * 0.15, 0), S * 1.05, rnd, { sq: 0.8, sx: range(rnd, 0.9, 1.2), cuts: 5, noise: 0.12, tint: tint() });
      if (rnd() < 0.6) { const a = rnd() * TAU, dd = S * 1.05, x = Math.cos(a) * dd, z = Math.sin(a) * dd; boulder(b, new V3(x, g(x, z) + S * 0.1, z), S * 0.55, rnd, { sq: 0.75, cuts: 4, tint: tint() }); }
    }
  } else if (bm === 'desert') {
    boulder(b, new V3(0, g(0, 0) + S * 0.15, 0), S * 1.0, rnd, { sq: 0.82, cuts: 2, noise: 0.16, tint: tint() });
    if (S > 1.1) boulder(b, new V3(0.15 * S, g(0, 0) + S * 0.85, 0), S * 0.62, rnd, { sq: 0.7, cuts: 2, noise: 0.15, tint: tint() });
    if (rnd() < 0.55) { const a = rnd() * TAU, dd = S * 1.0; boulder(b, new V3(Math.cos(a) * dd, g(Math.cos(a) * dd, Math.sin(a) * dd) + S * 0.08, Math.sin(a) * dd), S * 0.5, rnd, { sq: 0.8, cuts: 2, tint: tint() }); }
  } else if (bm === 'snow') {
    boulder(b, new V3(0, g(0, 0) + S * 0.1, 0), S * 1.05, rnd, { sq: 0.8, cuts: 4, noise: 0.18, tint: tint() });
    if (S > 1.0 && rnd() < 0.6) {           // a leaning slab beside it
      const a = rnd() * TAU, dd = S * 0.95;
      boulder(b, new V3(Math.cos(a) * dd, g(Math.cos(a) * dd, Math.sin(a) * dd) + S * 0.35, Math.sin(a) * dd), S * 0.6, rnd, { sq: 1.25, sx: 0.5, cuts: 3, tint: tint() });
    }
  } else {                                  // Elwynn / Westfall: rounded mossy boulders, sometimes an outcrop
    boulder(b, new V3(0, g(0, 0) + S * 0.12, 0), S * 1.0, rnd, { sq: bm === 'fields' ? 0.68 : 0.86, cuts: 3, noise: 0.17, tint: tint() });
    if (S > 1.25 && rnd() < 0.7) {          // an outcrop: a big tilted slab standing out of the turf
      const a = rnd() * TAU, dd = S * 0.7, x = Math.cos(a) * dd, z = Math.sin(a) * dd;
      boulder(b, new V3(x, g(x, z) + S * 0.45, z), S * 0.75, rnd, { sq: 1.35, sx: 0.6, cuts: 3, noise: 0.14, tint: tint() });
    }
    const extra = S > 1.2 ? 2 : (rnd() < 0.5 ? 1 : 0);
    for (let k = 0; k < extra; k++) {
      const a = rnd() * TAU, dd = S * range(rnd, 0.95, 1.25), r = S * range(rnd, 0.35, 0.6);
      boulder(b, new V3(Math.cos(a) * dd, g(Math.cos(a) * dd, Math.sin(a) * dd) + r * 0.1, Math.sin(a) * dd), r, rnd, { sq: 0.8, cuts: 2, tint: tint() });
    }
  }
}

// ---- farm & field bits ------------------------------------------------------------------------------

function fence(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 17)), n = Math.max(2, d.len || 4);
  ctx.at(d, d.ry || 0);
  const b = ctx.b('wood');
  const wood = barkAO(-0.3, 0.6, 0.6);
  const posts = [];
  for (let i = 0; i < n; i++) {
    const z = (i - (n - 1) / 2) * 1.9 + range(rnd, -0.12, 0.12), x = range(rnd, -0.08, 0.08), y = ctx.gh(x, z);
    const lx = range(rnd, -0.06, 0.06), lz = range(rnd, -0.06, 0.06), r = range(rnd, 0.085, 0.11);
    tube(b, [new V3(x, y - 0.4, z), new V3(x + lx * 0.5, y + 0.6, z + lz * 0.5), new V3(x + lx, y + 1.18, z + lz), new V3(x + lx, y + 1.27, z + lz)], [r, r * 0.95, r * 0.9, r * 0.35], { sides: 6, uRep: 1, vLen: 1.2, color: wood, cap: true });
    posts.push({ x, y, z, lx, lz });
  }
  for (let i = 0; i < n - 1; i++) {
    const A = posts[i], Bp = posts[i + 1];
    for (const h of [0.5, 0.98]) {
      if (rnd() < 0.06) continue;
      const ha = h + range(rnd, -0.05, 0.05), hb = h + range(rnd, -0.05, 0.05);
      const pa = new V3(A.x + A.lx * ha, A.y + ha, A.z - 0.16), pb = new V3(Bp.x + Bp.lx * hb, Bp.y + hb, Bp.z + 0.16);
      if (rnd() < 0.05) pb.set(Bp.x + 0.2, ctx.gh(Bp.x + 0.2, Bp.z - 0.2) + 0.06, Bp.z - 0.2);   // a fallen rail
      const mid = pa.clone().lerp(pb, 0.5); mid.y -= 0.03; mid.x += range(rnd, -0.03, 0.03);
      const r = range(rnd, 0.05, 0.065);
      tube(b, [pa, mid, pb], [r, r * 1.05, r * 0.95], { sides: 6, uRep: 1, vLen: 1.6, color: [0.95, 0.95, 0.95] });
    }
  }
}

function haybale(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 18));
  ctx.at(d, d.ry || 0);
  const hay = ctx.b('hay');
  const ao = barkAO(-0.1, 0.9, 0.55);
  const stack = d.variant != null ? d.variant === 1 : rnd() < 0.4;
  if (!stack) {        // a round bale on its side
    const y0 = ctx.gh(0, 0) + 0.68, xs = [-0.6, -0.57, -0.45, 0, 0.45, 0.57, 0.6], rs = [0.56, 0.67, 0.72, 0.73, 0.72, 0.67, 0.56];
    tube(hay, xs.map(x => new V3(x, y0, 0)), rs, { sides: 16, uRep: 3, vLen: 0.6, color: ao, lobes: (dir, t, i, j) => 1 + 0.02 * Math.sin(j * 2.7 + i) });
    const he = ctx.b('hay_end');
    for (const sd of [-1, 1]) disc(he, new V3(0.6 * sd, y0, 0), new V3(sd, 0, 0), 0.57, 16, (c, sn) => [0.5 + c * 0.47, 0.5 + sn * 0.47 * sd], [0.9, 0.9, 0.9]);
    for (const tx of [-0.24, 0.24]) {
      const loop = []; for (let k = 0; k <= 16; k++) { const a = k / 16 * TAU; loop.push(new V3(tx, y0 + Math.cos(a) * 0.735, Math.sin(a) * 0.735)); }
      tube(hay, loop, loop.map(() => 0.016), { sides: 4, uRep: 1, vLen: 0.3, color: lin('#5a4630') });
    }
  } else {             // a domed haystack
    const g0 = ctx.gh(0, 0), ys = [-0.25, 0.15, 0.6, 1.0, 1.35, 1.6, 1.74, 1.78], rs = [0.8, 0.8, 0.76, 0.64, 0.46, 0.26, 0.09, 0.02];
    const sA = rnd() * 9;
    tube(hay, ys.map(y => new V3(0, g0 + y, 0)), rs, { sides: 14, uRep: 3, vLen: 0.7, color: ao, lobes: (dir, t, i, j) => 1 + 0.07 * Math.sin(j * 1.9 + sA) * Math.sin(i * 1.3 + sA) });
    if (rnd() < 0.35) {
      const wb = ctx.b('wood'), ib = ctx.b('iron'), a = rnd() * TAU, c = Math.cos(a), s = Math.sin(a);
      const p0 = new V3(c * 0.45, g0 + 1.05, s * 0.45), p1 = new V3(c * 1.15, g0 + 2.45, s * 1.15);
      tube(wb, [p0, p1], [0.028, 0.025], { sides: 5, uRep: 1, vLen: 1.2 });
      for (const o of [-0.07, 0, 0.07]) tube(ib, [p0.clone().add(new V3(-s * o, 0, c * o)), new V3(c * 0.2 - s * o, g0 + 0.75, s * 0.2 + c * o)], [0.012, 0.008], { sides: 4, uRep: 1, vLen: 0.5 });
    }
  }
}

// region of the scarecrow atlas: [u0, v0, u1, v1]
const SC = { head: [0, 0.5, 1, 1], shirt: [0, 0.25, 0.5, 0.5], hat: [0.5, 0.25, 1, 0.5], rope: [0, 0, 0.5, 0.25], straw: [0.5, 0, 1, 0.25] };
const region = (r, wrapU = true) => (u, v) => [r[0] + (wrapU ? u - Math.floor(u) : clamp01(u)) * (r[2] - r[0]) * 0.98 + 0.002, r[1] + clamp01(v) * (r[3] - r[1]) * 0.96 + 0.004];
const len = pts => { let L = 0; for (let i = 1; i < pts.length; i++) L += pts[i].distanceTo(pts[i - 1]); return L; };

function scarecrow(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 19));
  ctx.at(d, d.ry || 0);
  const wb = ctx.b('wood'), sc = ctx.b('scarecrow');
  const g0 = ctx.gh(0, 0);
  const P = (x, y, z) => new V3(x, g0 + y, z);
  tube(wb, [P(0, -0.4, 0), P(0.02, 1.0, 0), P(0.03, 2.1, 0)], [0.075, 0.07, 0.06], { sides: 6, uRep: 1, vLen: 1.2, color: barkAO(-0.2, 0.8, 0.6) });
  tube(wb, [P(-0.78, 1.63, 0.02), P(0, 1.66, 0.06), P(0.78, 1.61, 0.02)], [0.05, 0.055, 0.05], { sides: 6, uRep: 1, vLen: 1.2 });
  const part = (pts, rad, reg, o = {}) => tube(sc, pts, rad, { sides: o.sides || 8, uRep: 1, vLen: len(pts), uvMap: region(SC[reg]), cap: o.cap, color: o.color || WHITE, lobes: o.lobes });
  // shirt: a stuffed, lumpy torso
  part([P(0, 0.9, 0.06), P(0, 1.02, 0.07), P(0, 1.35, 0.08), P(0, 1.66, 0.07), P(0, 1.78, 0.06)], [0.25, 0.27, 0.29, 0.26, 0.09], 'shirt', { lobes: (dir, t, i, j) => 1 + 0.06 * Math.sin(j * 2.3 + i * 1.7) });
  part([P(0, 1.04, 0.07), P(0, 1.05, 0.07)], [0.29, 0.29], 'rope', { sides: 8 });
  for (const sd of [-1, 1]) {
    part([P(sd * 0.12, 1.64, 0.06), P(sd * 0.42, 1.62, 0.07), P(sd * 0.68, 1.57, 0.08)], [0.12, 0.115, 0.1], 'shirt');
    part([P(sd * 0.66, 1.57, 0.08), P(sd * 0.76, 1.55, 0.08), P(sd * 0.88, 1.5, 0.09)], [0.08, 0.12, 0.03], 'straw', { cap: true, lobes: (dir, t, i, j) => 1 + 0.25 * Math.sin(j * 2.9) });
    part([P(sd * 0.11, 0.98, 0.07), P(sd * 0.13, 0.7, 0.08), P(sd * 0.16, 0.42, 0.1)], [0.09, 0.075, 0.05], 'straw', { cap: true, lobes: (dir, t, i, j) => 1 + 0.2 * Math.sin(j * 2.9 + i) });
  }
  // burlap head, cocked to one side; the face is at u = 0.5, which faces +z
  const hc = P(0.04, 2.02, 0.07), hr = 0.27, hp = [], hrad = [];
  for (let k = 0; k <= 7; k++) { const th = 0.12 * Math.PI + k / 7 * 0.82 * Math.PI; hp.push(new V3(hc.x + Math.sin(k / 7 * 2) * 0.03, hc.y - Math.cos(th) * hr * 1.08, hc.z)); hrad.push(Math.sin(th) * hr); }
  part(hp, hrad, 'head', { sides: 12, cap: true });
  // floppy hat
  const yb = hc.y + 0.17, hx = hc.x + 0.03;
  const hat = [[0.17, -0.025], [0.44, -0.01], [0.43, 0.02], [0.21, 0.035], [0.19, 0.24], [0.13, 0.28], [0.02, 0.29]];
  part(hat.map(([r, y], i) => new V3(hx + i * 0.008, yb + y, hc.z - 0.02)), hat.map(([r]) => r), 'hat', { sides: 12, lobes: (dir, t, i, j) => i <= 2 ? 1 + 0.06 * Math.sin(j * 1.5) : 1 });
}

// ---- desert & badlands ------------------------------------------------------------------------------

function cactus(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 20)), B = ctx.bio, h = d.h || 2.4;
  ctx.at(d, d.ry || 0);
  const cb = ctx.b('cactus');
  const tint = lin(pick(rnd, B.cactusTints || ['#ffffff']));
  const g0 = ctx.gh(0, 0);
  const col = p => mulc(tint, 0.6 + 0.4 * smooth(g0 - 0.2, g0 + 1.0, p.y));
  const pear = d.variant != null ? d.variant === 'pear' : h < 2.2 && rnd() < 0.5;
  if (pear) {
    // prickly pear: flat pads on pads, a few red fruit on the rims
    const pads = [];
    const pad = (C, w, hgt, yaw, roll, depth) => {
      const cy = Math.cos(yaw), sy = Math.sin(yaw), cr = Math.cos(roll), sr = Math.sin(roll);
      sphereish(cb, 1, u => {
        let x = u.x * w, y = u.y * hgt, z = u.z * 0.09;
        const x2 = x * cr - y * sr, y2 = x * sr + y * cr;
        return new V3(C.x + x2 * cy - z * sy, C.y + y2, C.z + x2 * sy + z * cy);
      }, { uv: u => [0.02 + u.x * 0.08, 0.5 + u.y * 0.45], color: col });
      pads.push([C, w, hgt, yaw, roll, depth]);
    };
    const nb = 2 + Math.floor(rnd() * 2);
    for (let k = 0; k < nb; k++) {
      const yaw = rnd() * Math.PI, roll = range(rnd, -0.35, 0.35), w = range(rnd, 0.3, 0.38), hg = w * range(rnd, 1.15, 1.35);
      const x = range(rnd, -0.35, 0.35), z = range(rnd, -0.35, 0.35);
      pad(new V3(x, ctx.gh(x, z) + hg * 0.8, z), w, hg, yaw, roll, 0);
    }
    for (let it = 0; it < 7 && pads.length < 9; it++) {
      const [C, w, hg, yaw, roll, depth] = pick(rnd, pads);
      if (depth > 1) continue;
      const a = roll + range(rnd, -0.8, 0.8), w2 = w * range(rnd, 0.75, 0.95), h2 = w2 * range(rnd, 1.1, 1.3);
      const tx = -Math.sin(a) * (hg + h2 * 0.7), ty = Math.cos(a) * (hg + h2 * 0.7);
      const y2 = yaw + range(rnd, -0.6, 0.6);
      pad(new V3(C.x + tx * Math.cos(yaw), C.y + ty, C.z + tx * Math.sin(yaw)), w2, h2, y2, a, depth + 1);
    }
    const bone = ctx.b('bone'), red = lin('#d03850');
    for (const [C, w, hg, yaw, roll] of pads) {
      if (rnd() < 0.4) continue;
      for (let k = 0; k < 2; k++) {
        const a = roll + range(rnd, -0.6, 0.6), fx = -Math.sin(a) * hg, fy = Math.cos(a) * hg;
        const F = new V3(C.x + fx * Math.cos(yaw), C.y + fy, C.z + fx * Math.sin(yaw));
        sphereish(bone, 1, u => new V3(F.x + u.x * 0.05, F.y + u.y * 0.065, F.z + u.z * 0.05), { color: red });
      }
    }
    return;
  }
  // saguaro: 8 ribs (16 sides, the lobes alternate), a domed top and up-turned arms
  const R = range(rnd, 0.23, 0.26);
  const ribs = (dir, t, i, j) => 1 + 0.09 * Math.cos(j * Math.PI);    // even sides are crests, odd are grooves
  const ys = [-0.3, 0.3, h * 0.5, h - R * 1.1, h - R * 0.55, h - R * 0.18, h + 0.02];
  const rs = [R * 0.92, R, R * 1.04, R * 0.98, R * 0.85, R * 0.55, R * 0.12];
  tube(cb, ys.map(y => new V3(0, g0 + y, 0)), rs, { sides: 16, uRep: 2, vLen: 1.6, lobes: ribs, color: col });
  const nA = h > 2.5 ? 1 + (rnd() < 0.6 ? 1 : 0) : (rnd() < 0.6 ? 1 : 0);
  let phi = rnd() * TAU;
  for (let k = 0; k < nA; k++) {
    phi += k ? Math.PI + range(rnd, -0.6, 0.6) : 0;
    const c = Math.cos(phi), sn = Math.sin(phi), ya = g0 + h * range(rnd, 0.32, 0.55), ra = R * 0.66, L = range(rnd, 0.5, 1.1);
    const at = (o, y) => new V3(c * o, y, sn * o);
    const pts = [at(R * 0.2, ya - 0.05), at(R + 0.1, ya - 0.04), at(R + 0.3, ya + 0.04), at(R + 0.38, ya + 0.24), at(R + 0.4, ya + 0.24 + L * 0.5), at(R + 0.4, ya + 0.24 + L - ra * 0.5), at(R + 0.4, ya + 0.24 + L - ra * 0.1), at(R + 0.4, ya + 0.24 + L + 0.02)];
    tube(cb, pts, [ra, ra, ra * 1.02, ra, ra, ra * 0.85, ra * 0.5, ra * 0.1], { sides: 12, uRep: 1.5, vLen: 1.6, lobes: ribs, color: col });
  }
  if (ctx.biome === 'desert' && rnd() < 0.5) {
    const bone = ctx.b('bone'), fc = lin(pick(rnd, ['#f8f0f8', '#f8d870', '#f0a0c0']));
    for (let k = 0; k < 3; k++) { const a = rnd() * TAU, F = new V3(Math.cos(a) * R * 0.5, g0 + h - 0.02, Math.sin(a) * R * 0.5); sphereish(bone, 1, u => new V3(F.x + u.x * 0.07, F.y + u.y * 0.04, F.z + u.z * 0.07), { color: fc }); }
  }
}

// a cow skull: broad cranium narrowing to the snout, sunken dark sockets and nostrils, a row of
// teeth, and long horns sweeping out and up
function skullAt(ctx, C, k, rnd) {
  const b = ctx.b('bone');
  const dark = lin('#2a2018'), horn = lin('#a08a64');
  const zs = [-0.5, -0.38, -0.1, 0.3, 0.68, 0.98, 1.22, 1.4, 1.48], rs = [0.32, 0.64, 0.72, 0.64, 0.54, 0.47, 0.41, 0.31, 0.12];
  tube(b, zs.map((z, i) => new V3(C.x, C.y + (z < 0.3 ? 0.1 : 0.1 - (z - 0.3) * 0.14) * k, C.z + z * k)), rs.map(r => r * k), {
    sides: 12, uRep: 1, vLen: 1.2 * k, cap: true,
    lobes: (dir, t) => 1 + 0.22 * Math.abs(dir.x) * (1 - t) - 0.22 * Math.abs(dir.y) + (dir.y > 0.3 && t < 0.4 ? 0.06 : 0),
    color: p => mulc(WHITE, 0.6 + 0.4 * smooth(C.y - 0.3 * k, C.y + 0.4 * k, p.y)),
  });
  const pit = (x, y, z, r, ry = 0.8) => sphereish(b, 1, u => new V3(C.x + (x + u.x * r) * k, C.y + (y + u.y * r * ry) * k, C.z + (z + u.z * r) * k), { color: dark });
  for (const sd of [-1, 1]) {
    pit(sd * 0.52, 0.2, 0.3, 0.23, 0.8);
    pit(sd * 0.11, 0.0, 1.44, 0.08, 0.8);
    const pts = [[0.45, 0.32, -0.3], [0.95, 0.42, -0.36], [1.45, 0.62, -0.25], [1.75, 0.98, 0.0], [1.78, 1.32, 0.3], [1.66, 1.55, 0.5]]
      .map(([x, y, z]) => new V3(C.x + sd * x * k, C.y + y * k, C.z + z * k));
    tube(b, pts, [0.22, 0.18, 0.13, 0.09, 0.05, 0.012].map(r => r * k), { sides: 8, uRep: 1, vLen: 0.8 * k, color: (p, n, t) => [1 - (1 - horn[0]) * t, 1 - (1 - horn[1]) * t, 1 - (1 - horn[2]) * t] });
    for (let j = 0; j < 5; j++) sphereish(b, 0, u => new V3(C.x + (sd * 0.22 + u.x * 0.05) * k, C.y + (-0.22 + u.y * 0.06) * k, C.z + (0.62 + j * 0.16 + u.z * 0.06) * k), { color: [0.9, 0.86, 0.78] });
  }
}

function skull(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 21));
  const tilt = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-0.12, 0, range(rnd, -0.12, 0.12)));
  ctx.at(d, d.ry || 0, tilt);
  skullAt(ctx, new V3(0, ctx.gh(0, 0) + 0.55 * 1.6, 0), 1.6, rnd);
}

function bones(ctx, d) {
  const rnd = rngOf(seedOf(d.x, d.z, 22)), s = (d.s || 1) * 1.7;
  ctx.at(d, d.ry || 0);
  const b = ctx.b('bone');
  const n = 6 + Math.floor(rnd() * 3), sp = [];
  for (let i = 0; i < n; i++) { const z = (i - n / 2) * 0.2 * s, x = Math.sin(i * 0.5) * 0.12 * s; sp.push(new V3(x, ctx.gh(x, z) + 0.06, z)); }
  for (const p of sp) sphereish(b, 1, u => new V3(p.x + u.x * 0.1 * s, p.y + u.y * 0.07 * s, p.z + u.z * 0.08 * s), { color: p2 => [0.85, 0.82, 0.76] });
  // ribs arching over the spine and into the ground
  for (let i = 1; i < n - 1; i++) {
    for (const sd of [-1, 1]) {
      if (rnd() < 0.15) continue;
      const p = sp[i], w = range(rnd, 0.45, 0.62) * s * (1 - Math.abs(i - n / 2) / n * 0.6), broken = rnd() < 0.25;
      const pts = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5 * (broken ? 0.6 : 1), a = t * Math.PI * 0.95;
        const x = p.x + sd * Math.sin(a * 0.5 + 0.2) * w, z = p.z + 0.08 * s * t;
        pts.push(new V3(x, p.y + Math.sin(a) * 0.42 * s * (1 - t * 0.35) - t * 0.08, z));
      }
      tube(b, pts, pts.map((_, k) => (0.035 - k * 0.003) * s), { sides: 5, uRep: 1, vLen: 0.6, color: [0.95, 0.93, 0.88] });
    }
  }
  // a couple of long bones lying about
  for (let k = 0; k < 2; k++) {
    const a = rnd() * TAU, x = range(rnd, -0.9, 0.9) * s, z = range(rnd, -0.9, 0.9) * s, L = range(rnd, 0.5, 0.75) * s;
    const p0 = new V3(x, ctx.gh(x, z) + 0.05, z), p1 = new V3(x + Math.cos(a) * L, ctx.gh(x + Math.cos(a) * L, z + Math.sin(a) * L) + 0.05, z + Math.sin(a) * L);
    tube(b, [p0, p0.clone().lerp(p1, 0.12), p0.clone().lerp(p1, 0.5), p0.clone().lerp(p1, 0.88), p1], [0.07, 0.04, 0.033, 0.04, 0.07].map(r => r * s), { sides: 6, uRep: 1, vLen: 0.6, cap: true });
  }
  if (rnd() < 0.6) skullAt(ctx, new V3(sp[0].x + 0.1, sp[0].y + 0.12 * s, sp[0].z - 0.45 * s), 0.32 * s, rnd);
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
  const rk = ctx.b('rock'), lg = ctx.b('bark_dead');
  for (let i = 0; i < 9; i++) {
    const a = i / 9 * TAU + range(rnd, -0.12, 0.12), r = range(rnd, 0.6, 0.7), x = Math.cos(a) * r, z = Math.sin(a) * r;
    boulder(rk, new V3(x, ctx.gh(x, z) + 0.04, z), range(rnd, 0.17, 0.24), rnd, { sq: 0.75, cuts: 2, tint: [0.26, 0.25, 0.24] });   // sooty, and too warm for snow
  }
  const charred = (p, n, t) => { const k = 0.16 + 0.34 * clamp01(1 - t * 1.4); return [k, k * 0.95, k * 0.9]; };
  for (let i = 0; i < 4; i++) {
    const a = i / 4 * TAU + 0.4 + range(rnd, -0.2, 0.2), r = 0.55;
    const p0 = new V3(Math.cos(a) * r, ctx.gh(Math.cos(a) * r, Math.sin(a) * r) + 0.06, Math.sin(a) * r), p1 = new V3(Math.cos(a) * 0.06, 0.5, Math.sin(a) * 0.06);
    tube(lg, [p0, p0.clone().lerp(p1, 0.5), p1], [0.075, 0.07, 0.05], { sides: 7, uRep: 1, vLen: 0.8, cap: true, color: charred });
  }
  const cb = ctx.b('coals');
  disc(cb, new V3(0, ctx.gh(0, 0) + 0.05, 0), UP, 0.56, 14, (c, sn) => [0.5 + c * 0.48, 0.5 + sn * 0.48]);
  const fb = ctx.b('flame'), ph = rnd() * 10;
  const g0 = ctx.gh(0, 0);
  const quad = (a, w, h, phase) => {
    const c = Math.cos(a) * w / 2, s = Math.sin(a) * w / 2, base = fb.n;
    const n = new V3(-Math.sin(a), 0, Math.cos(a));
    const cs = [[-c, 0, -s], [c, 0, s], [c, h, s], [-c, h, -s]];
    const uvs = [[0, 0], [1, 0], [1, 1], [0, 1]];
    cs.forEach(([x, y, z], k) => fb.v(new V3(x, g0 + 0.04 + y, z), n, uvs[k][0], uvs[k][1], WHITE, phase));
    fb.t(base, base + 1, base + 2); fb.t(base, base + 2, base + 3);
  };
  for (let k = 0; k < 3; k++) quad(k * Math.PI / 3 + 0.3, 1.0, 1.3, ph + k * 1.7);
  for (let k = 0; k < 2; k++) quad(k * Math.PI / 2 + 1.1, 0.6, 0.85, ph + 5 + k * 2.3);
  const light = new THREE.PointLight(0xff9a3c, 14, 16, 1.6);
  light.position.set(d.x, d.y + g0 + 1.2, d.z);
  fires.push({ x: d.x, y: d.y + g0, z: d.z, light, ph, base: 14 });
}

// ---- assembly ---------------------------------------------------------------------------------------

let flameMat = null, coalMat = null, sparkMat = null;
function fxMats() {
  if (flameMat) return;
  flameMat = new THREE.ShaderMaterial({
    uniforms: { map: { value: tex('flame') }, uTime: U_TIME },
    vertexShader: `attribute float aWind; varying vec2 vUv; varying float vPh; uniform float uTime;
      void main() {
        vUv = uv; vPh = aWind; vec3 p = position; float h = uv.y;
        p.x += sin(uTime * 6.0 + aWind * 7.0 + h * 2.5) * 0.06 * h;
        p.z += cos(uTime * 5.1 + aWind * 3.0) * 0.05 * h;
        p.y += sin(uTime * 9.0 + aWind) * 0.05 * h;
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
  coalMat = new THREE.MeshBasicMaterial({ map: tex('coals'), color: 0xffffff });
  sparkMat = new THREE.PointsMaterial({ map: tex('spark'), size: 0.09, color: 0xffc070, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, sizeAttenuation: true });
}

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
    deadTree(ctx, 1, rngOf(seedOf(c.x, c.z, 25)), { r0: c.r, ring: a ? a.y - g : 1.1 });
  }
  fxMats();
  for (const [k, b] of ctx.batches) {
    if (!b.n) continue;
    const key = b.key;
    let m;
    if (key === 'flame') { m = b.build(flameMat); m.renderOrder = 5; m.frustumCulled = false; }
    else if (key === 'coals') { m = b.build(coalMat); m.receiveShadow = true; }
    else { m = b.build(matFor(key, ctx.biome)); m.castShadow = true; m.receiveShadow = true; }
    m.name = 'nature:' + k;
    group.add(m);
  }
  // embers drifting up from every fire
  let sparks = null;
  if (fires.length) {
    const N = 16, pos = new Float32Array(fires.length * N * 3), st = [];
    fires.forEach((f, fi) => { for (let i = 0; i < N; i++) st.push({ f, age: (i / N) * 1.6, life: 1.2 + (i % 5) * 0.15, vx: Math.sin(i * 2.1 + fi) * 0.25, vz: Math.cos(i * 1.7 + fi) * 0.25 }); });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    sparks = new THREE.Points(g, sparkMat);
    sparks.frustumCulled = false;
    sparks.userData.st = st;
    group.add(sparks);
    for (const f of fires) group.add(f.light);
    const upd = () => {
      st.forEach((p, i) => {
        const t = p.age;
        pos[i * 3] = p.f.x + p.vx * t + Math.sin(t * 5 + i) * 0.06;
        pos[i * 3 + 1] = p.f.y + 0.3 + t * 1.3;
        pos[i * 3 + 2] = p.f.z + p.vz * t + Math.cos(t * 4 + i) * 0.06;
      });
      g.attributes.position.needsUpdate = true;
    };
    upd();
    sparks.userData.upd = upd;
  }
  return {
    group, fires,
    update(dt, t) {
      U_TIME.value = t;
      for (const f of fires) {
        const k = 1 + Math.sin(t * 13 + f.ph) * 0.08 + Math.sin(t * 7.3 + f.ph * 2) * 0.06 + Math.sin(t * 23.7 + f.ph) * 0.03;
        f.light.intensity = f.base * k;
      }
      if (coalMat) coalMat.color.setScalar(0.85 + 0.15 * Math.sin(t * 4.3) * Math.sin(t * 2.9 + 1));
      if (sparks) {
        for (const p of sparks.userData.st) { p.age += dt; if (p.age > p.life) { p.age -= p.life; p.vx = (Math.random() - 0.5) * 0.5; p.vz = (Math.random() - 0.5) * 0.5; } }
        sparks.userData.upd();
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
