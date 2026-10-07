// Geometry kit for the town (town3d.js / town_build.js): build parts in a local frame with a
// transform stack, give them world-scale painted UVs and vertex-color shading (ground grime,
// shade under eaves, darker interiors), and merge everything that shares a material into one
// mesh, so a whole town is a few dozen draw calls.
import { THREE, painted } from './gfx.js';
import { mergeGeometries } from '/vendor/BufferGeometryUtils.js';

const E = new THREE.Euler(), Q = new THREE.Quaternion();
const AX = ['x', 'y', 'z'];

// the town's materials: painted, smooth Lambert, vertex colors on
export function mat(name, o = {}) { return painted(name, { vertexColors: true, ...o }); }

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
    if (geo.index) geo = geo.toNonIndexed();
    for (const k of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'color'].includes(k)) geo.deleteAttribute(k);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    if (!geo.attributes.color) { const c = new Float32Array(geo.attributes.position.count * 3).fill(1); geo.setAttribute('color', new THREE.BufferAttribute(c, 3)); }
    geo.morphAttributes = {};
    const key = material.uuid + (cast ? 'c' : '') + (receive ? 'r' : '');
    if (!this.lists.has(key)) this.lists.set(key, { material, cast, receive, geos: [] });
    this.lists.get(key).geos.push(geo);
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

// A builder with a transform stack. root maps the kit's frame to the world; parts are added in
// the current local frame. shadeFn(x, y, z, nx, ny, nz) → multiplier (number or [r, g, b]) in
// the kit's frame gives vertex-color lighting (AO, grime, interiors).
export class Kit {
  constructor(batch, root = new THREE.Matrix4(), shadeFn = null) {
    this.batch = batch; this.root = root; this.m = new THREE.Matrix4(); this.stack = []; this.shadeFn = shadeFn; this.seed = 1;
  }
  push(x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, s = 1) { this.stack.push(this.m.clone()); this.m.multiply(matrix(x, y, z, ry, rx, rz, s)); return this; }
  pushM(M) { this.stack.push(this.m.clone()); this.m.multiply(M); return this; }
  pop() { this.m = this.stack.pop(); return this; }
  rnd() { this.seed = (this.seed * 16807) % 2147483647; return (this.seed - 1) / 2147483646; }

  // o: uv ('planar' | 'keep'), uvSpace ('part' | 'kit'), tile, tileV, grain, flipV, uvScale [su, sv], uvOff,
  //    at (Matrix4 in the local frame), shade (false | true | fn), tint ('#rrggbb' | [r,g,b]), warp(v: Vector3) → void,
  //    cast, receive
  add(material, geo, o = {}) {
    const { uv = 'planar', uvSpace = 'part', tile = 1, tileV = null, grain = 'y', flipV = false, flipU = false, uvScale = null, at = null, shade = true, tint = null, warp = null, cast = true, receive = true } = o;
    if (warp) {
      const p = geo.attributes.position, v = new THREE.Vector3();
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i); warp(v); p.setXYZ(i, v.x, v.y, v.z); }
      geo.computeVertexNormals();
    }
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
      col[i * 3] = k[0] * tc[0]; col[i * 3 + 1] = k[1] * tc[1]; col[i * 3 + 2] = k[2] * tc[2];
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.applyMatrix4(this.root);
    this.batch.add(material, geo, { cast, receive });
    return geo;
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

// smoothstep
export const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
