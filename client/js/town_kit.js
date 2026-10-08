// Geometry kit for the town (town3d.js / town_build.js): build parts in a local frame with a
// transform stack, give them world-scale painted UVs and vertex-color shading (ground grime,
// shade under eaves, darker interiors), and merge everything that shares a material into one
// mesh, so a whole town is a few dozen draw calls.
import { THREE, painted } from './gfx.js';
import { mergeGeometries } from '/vendor/BufferGeometryUtils.js';

const E = new THREE.Euler(), Q = new THREE.Quaternion();
const AX = ['x', 'y', 'z'];

// the town's materials: painted, smooth Lambert, vertex colors on (tagged with their texture name)
export function mat(name, o = {}) { const m = painted(name, { vertexColors: true, ...o }); m.userData.paint = name; return m; }

// One shadow policy per material, so a material's indoor and outdoor parts merge into one mesh (and
// one shadow draw): flat, glowing or indoor-only surfaces never cast, everything else does.
const NO_CAST = new Set(['window_lead', 'lantern_glass', 'flowerbox', 'banner_red', 'banner_hide', 'banner_dwarf', 'banner_goblin', 'rug_red', 'rug_bear', 'rug_hide', 'rug_braid', 'rug_desert',
  'carpet_casino', 'carpet_border', 'tile_goblin', 'felt_table', 'latillas', 'embers', 'slot_face', 'flip_face', 'repo_plate', 'plaster_inner', 'granite_inner',
  'wall_holes', 'straw_fringe', 'clay', 'endgrain']);

export function matrix(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, s = 1) {
  E.set(rx, ry, rz, 'YXZ'); Q.setFromEuler(E);
  return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), Q, typeof s === 'number' ? new THREE.Vector3(s, s, s) : s);
}

// Deterministic little RNG for jitter.
export function rng(seed) {
  let a = (seed * 2654435761) >>> 0 || 1;
  return () => { a ^= a << 13; a >>>= 0; a ^= a >> 17; a ^= a << 5; a >>>= 0; return a / 4294967296; };
}

// Planar UVs per vertex, picked by the dominant axis of its normal. u runs to the right as you look
// at the face; v = the `grain` axis when it lies in the face (so wood grain runs along a beam),
// otherwise up / along z. tile = meters per texture repeat.
export function planarUV(geo, { tile = 1, tileV = null, grain = 'y', off = [0, 0], flipV = false, flipU = false }) {
  const p = geo.attributes.position, n = geo.attributes.normal, cnt = p.count;
  const uv = new Float32Array(cnt * 2);
  const tu = 1 / tile, tv = 1 / (tileV || tile);
  const gi = AX.indexOf(grain);
  for (let i = 0; i < cnt; i++) {
    const P = [p.getX(i), p.getY(i), p.getZ(i)], Nn = [n.getX(i), n.getY(i), n.getZ(i)];
    const ax = [0, 1, 2].map(k => Math.abs(Nn[k]));
    const d = ax[0] >= ax[1] && ax[0] >= ax[2] ? 0 : ax[1] >= ax[2] ? 1 : 2;
    const sgn = Nn[d] >= 0 ? 1 : -1;
    let u, v;
    if (gi !== d) {
      const other = 3 - d - gi;
      v = P[gi];
      // u to the right when looking at the face from outside
      u = P[other];
      if (d === 0) u = gi === 1 ? -sgn * P[2] : P[other] * sgn;          // ±x faces
      else if (d === 2) u = gi === 1 ? sgn * P[0] : P[other] * -sgn;     // ±z faces
      else u = P[other] * sgn;                                           // ±y faces
    } else {
      // end grain: map the face's two tangents
      const t = [0, 1, 2].filter(k => k !== d);
      u = P[t[0]] * sgn; v = P[t[1]];
    }
    if (flipU) u = -u;
    if (flipV) v = -v;
    uv[i * 2] = u * tu + off[0];
    uv[i * 2 + 1] = v * tv + off[1];
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

// Collects geometry per material; build() merges each list into one mesh.
export class Batch {
  constructor() { this.lists = new Map(); }
  add(material, geo, { cast = true, receive = true } = {}) {
    const pn = material.userData && material.userData.paint;
    if (pn !== undefined) { cast = !NO_CAST.has(pn); receive = true; }
    if (geo.index) geo = geo.toNonIndexed();
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.attributes.color) { const c = new Float32Array(geo.attributes.position.count * 3).fill(1); geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
    geo.morphAttributes = {};
    const key = material.uuid + (cast ? 'c' : '') + (receive ? 'r' : '');
    if (!this.lists.has(key)) this.lists.set(key, { material, cast, receive, geos: [] });
    this.lists.get(key).geos.push(geo);
    return geo;
  }
  build(parent) {
    const meshes = [];
    for (const { material, cast, receive, geos } of this.lists.values()) {
      const g = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!g) continue;
      g.computeBoundingSphere(); g.computeBoundingBox();
      const m = new THREE.Mesh(g, material);
      m.castShadow = cast; m.receiveShadow = receive;
      m.matrixAutoUpdate = false; m.updateMatrix();
      parent.add(m);
      meshes.push(m);
    }
    for (const l of this.lists.values()) for (const g of l.geos) if (l.geos.length > 1) g.dispose();
    this.lists.clear();
    return meshes;
  }
}

// Batches per spatial cluster (the town core, each roadside stop, each lone sign), so far-away
// clusters are culled by the camera and the shadow camera. keyFn(x, z) → cluster key.
export class ClusterBatch {
  constructor(keyFn) { this.keyFn = keyFn; this.batches = new Map(); }
  add(material, geo, opts) {
    geo.computeBoundingBox();
    const bb = geo.boundingBox, k = this.keyFn((bb.min.x + bb.max.x) / 2, (bb.min.z + bb.max.z) / 2);
    let b = this.batches.get(k);
    if (!b) this.batches.set(k, b = new Batch());
    return b.add(material, geo, opts);
  }
  // one group per cluster under parent; returns [{ key, group, center, radius }]
  build(parent) {
    const out = [];
    for (const [key, b] of this.batches) {
      const group = new THREE.Group();
      group.name = 'cluster:' + key;
      const meshes = b.build(group);
      if (!meshes.length) continue;
      const box = new THREE.Box3();
      for (const m of meshes) box.union(m.geometry.boundingBox);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      parent.add(group);
      out.push({ key, group, center: sphere.center, radius: sphere.radius });
    }
    this.batches.clear();
    return out;
  }
}

// A builder with a transform stack. root maps the kit's frame to the world; parts are added in
// the current local frame. shadeFn(x, y, z, nx, ny, nz) → multiplier (number or [r, g, b]) in
// the kit's frame gives vertex-color lighting (AO, grime, interiors).
export class Kit {
  constructor(batch, root = new THREE.Matrix4(), shadeFn = null) {
    this.batch = batch; this.root = root; this.m = new THREE.Matrix4(); this.stack = []; this.shadeFn = shadeFn; this.seed = 1; this.log = null;
  }
  push(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, s = 1) { this.stack.push(this.m.clone()); this.m.multiply(matrix(x, y, z, ry, rx, rz, s)); return this; }
  pushM(M) { this.stack.push(this.m.clone()); this.m.multiply(M); return this; }
  pop() { this.m = this.stack.pop(); return this; }
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return (this.seed - 1) / 2147483646; }

  // o: uv ('planar' | 'keep'), uvSpace ('part' | 'kit'), tile, tileV, grain, flipV, uvScale [su, sv], uvOff,
  //    at (Matrix4 in the local frame), shade (false | true | fn), tint ('#rrggbb' | [r,g,b]), warp(v: Vector3) → void,
  //    ao(x, y, z) → extra multiplier in the part's frame, cast, receive
  add(material, geo, o = {}) {
    const { uv = 'planar', uvSpace = 'part', tile = 1, tileV = null, grain = 'y', flipV = false, flipU = false, uvScale = null, at = null, shade = true, tint = null, warp = null, cast = true, receive = true } = o;
    if (warp) {
      const p = geo.attributes.position, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); warp(v); p.setXYZ(i, v.x, v.y, v.z); }
      geo.computeVertexNormals();
    }
    // o.ao(x, y, z) → multiplier (number or [r, g, b]) evaluated in the part's own frame (before `at`)
    let aoV = null;
    if (o.ao) { const p = geo.attributes.position; aoV = []; for (let i = 0; i < p.count; i++) aoV.push(o.ao(p.getX(i), p.getY(i), p.getZ(i))); }
    const off = o.uvOff || [this.rnd(), this.rnd()];
    if (uv === 'planar' && uvSpace === 'part') planarUV(geo, { tile, tileV, grain, off, flipV, flipU });
    else if (uv === 'keep' && uvScale) { const a = geo.attributes.uv; for (let i = 0; i < a.count; i++) a.setXY(i, a.getX(i) * uvScale[0] + (o.uvOff ? off[0] : 0), a.getY(i) * uvScale[1] + (o.uvOff ? off[1] : 0)); }
    const M = this.m.clone(); if (at) M.multiply(at);
    geo.applyMatrix4(M);
    if (uv === 'planar' && uvSpace === 'kit') planarUV(geo, { tile, tileV, grain, off: o.uvOff || [0, 0], flipV, flipU });
    // vertex colors
    const p = geo.attributes.position, n = geo.attributes.normal;
    const col = new Float32Array(p.count * 3);
    const tc = tint ? (Array.isArray(tint) ? tint : new THREE.Color(tint).toArray()) : [1, 1, 1];
    const fn = shade === true ? this.shadeFn : typeof shade === 'function' ? shade : null;
    for (let i = 0; i < p.count; i++) {
      let k = fn ? fn(p.getX(i), p.getY(i), p.getZ(i), n.getX(i), n.getY(i), n.getZ(i)) : 1;
      if (typeof k === 'number') k = [k, k, k];
      if (aoV) { const a = aoV[i]; k = typeof a === 'number' ? [k[0] * a, k[1] * a, k[2] * a] : [k[0] * a[0], k[1] * a[1], k[2] * a[2]]; }
      col[i * 3] = k[0] * tc[0]; col[i * 3 + 1] = k[1] * tc[1]; col[i * 3 + 2] = k[2] * tc[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.applyMatrix4(this.root);
    const stored = this.batch.add(material, geo, { cast, receive }) || geo;
    if (this.log) this.log.push(stored);
    return stored;
  }
  // a box centered at (x, y, z) in the local frame; o.ry/rx/rz rotate it about its center;
  // o.seg = [sx, sy, sz] subdivides it (for warps and vertex shading)
  box(material, w, h, d, x, y, z, o = {}) {
    const s = o.seg || [1, Math.max(1, Math.ceil(h / 0.7)), 1];
    return this.add(material, new THREE.BoxGeometry(w, h, d, s[0], s[1], s[2]), { ...o, at: matrix(x, y, z, o.ry || 0, o.rx || 0, o.rz || 0) });
  }
  // a beam between two points (local frame), square section t×t2; grain runs along it
  beam(material, a, b, t, t2 = t, o = {}) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const L = A.distanceTo(B), mid = A.clone().add(B).multiplyScalar(0.5);
    const dir = B.clone().sub(A).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    if (o.roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), o.roll));
    const M = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
    const g = new THREE.BoxGeometry(t, L + (o.ext || 0), t2, 1, Math.max(1, Math.ceil(L / 1.2)), 1);
    return this.add(material, g, { tile: 1.2, grain: 'y', ...o, at: M });
  }
  // a cylinder from a to b (local frame); radius r0 at a, r1 at b
  cyl(material, a, b, r0, r1 = r0, o = {}) {
    const A = new THREE.Vector3(...a), B = new THREE.Vector3(...b);
    const L = A.distanceTo(B), mid = A.clone().add(B).multiplyScalar(0.5);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize());
    const M = new THREE.Matrix4().compose(mid, q, new THREE.Vector3(1, 1, 1));
    const g = new THREE.CylinderGeometry(r1, r0, L, o.sides || 8, o.hseg || 1, !!o.open);
    const circ = Math.PI * (r0 + r1);
    return this.add(material, g, { uv: 'keep', uvScale: o.uvScale || [Math.max(1, Math.round(circ / (o.tile || 1.2))), L / (o.tile || 1.2)], ...o, at: M });
  }
  // a tube through pts [[x, y, z], ...] (local frame); r = number | [r per point] | fn(t 0..1, angle, i).
  // o.sides, o.caps (default true), o.tile (m per texture repeat along the tube), o.uRep (repeats around)
  tube(material, pts, r, o = {}) {
    const sides = o.sides || 8, n = pts.length, P = pts.map(p => new THREE.Vector3(p[0], p[1], p[2]));
    const pos = [], uv = [], idx = [];
    let prevN = null, along = 0;
    const tile = o.tile || 1.2, uRep = o.uRep || 1;
    const rad = (i, a) => typeof r === 'function' ? r(i / (n - 1), a, i) : Array.isArray(r) ? r[i] : r;
    for (let i = 0; i < n; i++) {
      const t = (i === 0 ? P[1].clone().sub(P[0]) : i === n - 1 ? P[n - 1].clone().sub(P[n - 2]) : P[i + 1].clone().sub(P[i - 1])).normalize();
      let N;
      if (prevN) N = prevN.clone().sub(t.clone().multiplyScalar(prevN.dot(t)));
      if (!N || N.lengthSq() < 1e-6) { const up = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0); N = up.sub(t.clone().multiplyScalar(up.dot(t))); }
      N.normalize(); prevN = N;
      const B = new THREE.Vector3().crossVectors(t, N);
      if (i > 0) along += P[i].distanceTo(P[i - 1]);
      for (let k = 0; k <= sides; k++) {
        const a = k / sides * Math.PI * 2, rr = rad(i, a);
        pos.push(P[i].x + (N.x * Math.cos(a) + B.x * Math.sin(a)) * rr, P[i].y + (N.y * Math.cos(a) + B.y * Math.sin(a)) * rr, P[i].z + (N.z * Math.cos(a) + B.z * Math.sin(a)) * rr);
        uv.push(k / sides * uRep, along / tile);
      }
    }
    for (let i = 0; i < n - 1; i++) for (let k = 0; k < sides; k++) {
      const a = i * (sides + 1) + k, b = a + sides + 1;
      idx.push(a, a + 1, b, b, a + 1, b + 1);
    }
    if (o.caps !== false) {
      for (const [i, s] of [[0, -1], [n - 1, 1]]) {
        const c0 = pos.length / 3;
        pos.push(P[i].x, P[i].y, P[i].z); uv.push(0.5, along / tile * (i ? 1 : 0));
        const base = i * (sides + 1);
        for (let k = 0; k < sides; k++) { if (s > 0) idx.push(c0, base + k, base + k + 1); else idx.push(c0, base + k + 1, base + k); }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return this.add(material, g, { uv: 'keep', ...o });
  }
  // a prism: polygon pts [[x, y], ...] in the local xy plane, extruded depth d along +z from z0
  prism(material, pts, z0, d, o = {}) {
    const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y)));
    const g = new THREE.ExtrudeGeometry(shape, { depth: d, bevelEnabled: false, steps: 1 });
    g.translate(0, 0, z0);
    return this.add(material, g, { tile: 3, ...o });
  }
  // a flat quad w×h facing +z at (x, y, z), rotated by o.ry/rx; UVs 0..1 unless planar requested
  quad(material, w, h, x, y, z, o = {}) {
    const g = new THREE.PlaneGeometry(w, h, o.sx || 1, o.sy || 1);
    return this.add(material, g, { uv: 'keep', ...o, at: matrix(x, y, z, o.ry || 0, o.rx || 0, o.rz || 0) });
  }
}

// A flat grid in the xy plane facing +z at z, with its lines at the given xs and ys (sorted), skipping
// cells for which skip(x0, x1, y0, y1) is true (a door hole). Positions only; normals +z.
export function gridGeo(xs, ys, z = 0, skip = null) {
  const pos = [], idx = [], nx = xs.length, ny = ys.length;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) pos.push(xs[i], ys[j], z);
  for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    if (skip && skip(xs[i], xs[i + 1], ys[j], ys[j + 1])) continue;
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, b, d, a, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(new Array(pos.length).fill(0).map((_, k) => (k % 3 === 2 ? 1 : 0)), 3));
  g.setIndex(idx);
  return g;
}

// smoothstep
export const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
