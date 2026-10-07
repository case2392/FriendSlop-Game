// What the loot looks like: chunky, smooth-shaded props in the WoW Classic manner, the detail
// hand-painted into one texture atlas (client/js/paint/props.js). Every loot item is ONE mesh with
// ONE material, so a prop costs one draw call (plus its shadow); its geometry is built once per
// type and shared by every copy. Each mesh is centered on, and fills, its physics collider
// (shared/loot.js LOOT[type].shape).
//
// API: buildProp(type, W) → Object3D · mapCanvas(W) → the paper road map (canvas) · PREVIEW
import { THREE, tex, painted, canvasTex, shadowy } from './gfx.js';
import { LOOT } from '/shared/loot.js';
import { REGIONS as R, sub, VASE_PROFILE, GUITAR_OUTLINE, TV_LAYOUT, TIRE_V } from './paint/props.js';
import { mergeGeometries, mergeVertices } from '/vendor/BufferGeometryUtils.js';
import { rngFrom, rgba, blob, ellipse, range, pick, makeCanvas } from './paint/core.js';

const V3 = THREE.Vector3;
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// ---- materials ---------------------------------------------------------------------------------

let atlasMat = null;
function lootMat() {
  if (!atlasMat) {
    atlasMat = new THREE.MeshLambertMaterial({ map: tex('loot_atlas'), vertexColors: true, emissive: new THREE.Color(0xffffff), emissiveMap: tex('loot_glow') });
    atlasMat.name = 'loot_atlas';
  }
  return atlasMat;
}

// ---- geometry kit --------------------------------------------------------------------------------

function mat4(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz, 'YXZ'));
  const sc = typeof s === 'number' ? new V3(s, s, s) : new V3(...s);
  return new THREE.Matrix4().compose(new V3(x, y, z), q, sc);
}

// Normals smoothed across every vertex that shares a position (seams included) unless the faces
// meet at more than `deg` degrees: smooth shading with a few crisp creases.
function creaseNormals(geo, deg = 50) {
  const pos = geo.attributes.position, n = pos.count, cosA = Math.cos(deg * DEG);
  const F = new Float32Array(n), A = new Float32Array(n / 3);
  const a = new V3(), b = new V3(), c = new V3(), e1 = new V3(), e2 = new V3();
  for (let f = 0; f < n / 3; f++) {
    a.fromBufferAttribute(pos, f * 3); b.fromBufferAttribute(pos, f * 3 + 1); c.fromBufferAttribute(pos, f * 3 + 2);
    e1.subVectors(b, a); e2.subVectors(c, a); e1.cross(e2);
    const L = e1.length(); A[f] = L;
    if (L > 1e-12) e1.divideScalar(L); else e1.set(0, 0, 0);
    F[f * 3] = e1.x; F[f * 3 + 1] = e1.y; F[f * 3 + 2] = e1.z;
  }
  const key = i => `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  const buckets = new Map(), keys = new Array(n);
  for (let i = 0; i < n; i++) { const k = keys[i] = key(i); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(Math.floor(i / 3)); }
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const f = Math.floor(i / 3), fx = F[f * 3], fy = F[f * 3 + 1], fz = F[f * 3 + 2];
    let sx = 0, sy = 0, sz = 0;
    const seen = new Set();
    for (const g of buckets.get(keys[i])) {
      if (seen.has(g) || A[g] < 1e-12) continue; seen.add(g);
      const gx = F[g * 3], gy = F[g * 3 + 1], gz = F[g * 3 + 2];
      if (A[f] > 1e-12 && fx * gx + fy * gy + fz * gz < cosA) continue;
      sx += gx; sy += gy; sz += gz;
    }
    const L = Math.hypot(sx, sy, sz) || 1;
    out[i * 3] = sx / L; out[i * 3 + 1] = sy / L; out[i * 3 + 2] = sz / L;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geo;
}

// After a non-uniform scale the normals need the inverse-transpose; for a pure scale that is 1/s per axis.
function creaseNormalsKeep(g) {
  const n = g.attributes.normal; if (!n) return;
  g.computeBoundingBox();
  // scale was applied to positions only by BufferGeometry.scale, which also transforms normals correctly
  for (let i = 0; i < n.count; i++) { const x = n.getX(i), y = n.getY(i), z = n.getZ(i), L = Math.hypot(x, y, z) || 1; n.setXYZ(i, x / L, y / L, z / L); }
}

// A box with chamfered, rounded edges (two facets per edge), its faces tagged for box UVs.
function rbox(w, h, d, r = 0.02) {
  const g = new THREE.BoxGeometry(2, 2, 2, 3, 3, 3);
  const p = g.attributes.position, H = [w / 2, h / 2, d / 2];
  r = Math.max(0, Math.min(r, ...H.map(x => x * 0.92)));
  const v = new V3();
  for (let i = 0; i < p.count; i++) {
    const c = [p.getX(i), p.getY(i), p.getZ(i)];
    const q = c.map((x, k) => Math.sign(x) * (Math.abs(x) > 0.5 ? H[k] : H[k] - r));
    const inner = q.map((x, k) => Math.max(-(H[k] - r), Math.min(H[k] - r, x)));
    v.set(q[0] - inner[0], q[1] - inner[1], q[2] - inner[2]);
    const L = v.length(); if (L > 1e-9) v.multiplyScalar(r / L);
    p.setXYZ(i, inner[0] + v.x, inner[1] + v.y, inner[2] + v.z);
  }
  return g;
}

// A lathe: profile [[r, y, v?], ...] from bottom to top (reverse it for an inside surface). The
// front (+z) is at u = 0.5 and u grows to the right seen from the front. v is given, or the arc length.
function lathe(profile, segs = 12) {
  const vs = profile[0].length > 2 ? profile.map(p => p[2]) : (() => {
    const L = [0]; for (let i = 1; i < profile.length; i++) L.push(L[i - 1] + Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]));
    return L.map(l => l / (L[L.length - 1] || 1));
  })();
  const pos = [], uv = [], idx = [];
  for (let j = 0; j < profile.length; j++) for (let i = 0; i <= segs; i++) {
    const u = i / segs, ph = u * TAU, r = profile[j][0];
    pos.push(-r * Math.sin(ph), profile[j][1], -r * Math.cos(ph)); uv.push(u, vs[j]);
  }
  const W = segs + 1;
  for (let j = 0; j < profile.length - 1; j++) for (let i = 0; i < segs; i++) {
    const a = j * W + i, b = a + 1, c = a + W + 1, d = a + W;
    idx.push(a, b, c, a, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
const sphere = (r = 1, segs = 12, rings = 8) => { const pr = []; for (let k = 0; k <= rings; k++) { const t = k / rings * Math.PI; pr.push([Math.sin(t) * r, -Math.cos(t) * r]); } return lathe(pr, segs); };
const cyl = (r, h, segs = 10, r2 = r) => lathe([[0, -h / 2], [r, -h / 2], [r2, h / 2], [0, h / 2]], segs);
const cone = (r, h, segs = 8) => lathe([[0, 0], [r, 0], [0, h]], segs);
// A loft along z through superelliptic sections [{ z, w, top, bot }] (w = half width), closed at
// both ends: for heads and snouts. u runs round the section, v along z.
function loft(st, segs = 16, pw = 2.6) {
  const pos = [], uv = [], idx = [], W = segs + 1;
  for (let j = 0; j < st.length; j++) {
    const s = st[j], mid = (s.top + s.bot) / 2, hh = (s.top - s.bot) / 2;
    for (let i = 0; i <= segs; i++) {
      const a = i / segs * TAU, c = Math.cos(a), sn = Math.sin(a);
      pos.push(s.w * Math.sign(c) * Math.pow(Math.abs(c), 2 / pw), mid + hh * Math.sign(sn) * Math.pow(Math.abs(sn), 2 / pw), s.z);
      uv.push(i / segs, j / (st.length - 1));
    }
  }
  for (let j = 0; j < st.length - 1; j++) for (let i = 0; i < segs; i++) { const a = j * W + i, b = a + 1, c = a + W + 1, d = a + W; idx.push(a, b, c, a, c, d); }
  const cap = (j, front) => {
    const s = st[j], ci = pos.length / 3;
    pos.push(0, (s.top + s.bot) / 2, s.z + (front ? 0.004 : 0)); uv.push(0.5, front ? 1 : 0);
    for (let i = 0; i < segs; i++) { const a = j * W + i, b = a + 1; if (front) idx.push(ci, a, b); else idx.push(ci, b, a); }
  };
  cap(0, false); cap(st.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}

// Collects parts (each with its own region, UVs, transform and tint) into one geometry.
class Build {
  constructor() { this.parts = []; }
  // o.uv: 'keep' (the geometry's 0..1 uvs) | 'box' (planar per face, faces: {px,nx,py,ny,pz,nz}) |
  //       'planar' (axis: 'x' | 'y' | 'z'); o.bounds = [minA, minB, maxA, maxB] for 'planar'
  // o.at: Matrix4; o.tint: number | [r,g,b]; o.crease: degrees; o.swap: swap u/v; o.warp(v)
  add(geo, reg, o = {}) {
    const { uv = 'keep', at = null, tint = 1, crease = 50, faces = null, swap = false, warp = null, axis = 'z', bounds = null, flipU = false, space = 'local' } = o;
    const gg = geo.index ? geo.toNonIndexed() : geo.clone();
    if (!gg.attributes.normal && uv === 'box') gg.computeVertexNormals();
    const p = gg.attributes.position, n = p.count;
    // shape it (warp, local), place it if UVs are wanted in prop space, then project the UVs
    if (warp) { const t = new V3(); for (let i = 0; i < n; i++) { t.fromBufferAttribute(p, i); warp(t); p.setXYZ(i, t.x, t.y, t.z); } }
    if (at && space === 'final') gg.applyMatrix4(at);
    const UV = new Float32Array(n * 2);
    const src = gg.attributes.uv, nrm = gg.attributes.normal;
    gg.computeBoundingBox();
    const mn = gg.boundingBox.min, sz = gg.boundingBox.getSize(new V3());
    const map = (rg, u, v) => {
      if (swap) [u, v] = [v, 1 - u];
      if (flipU) u = 1 - u;
      return [rg.u0 + (rg.u1 - rg.u0) * u, rg.v0 + (rg.v1 - rg.v0) * v];
    };
    const a = new V3(), b = new V3(), c = new V3();
    for (let f = 0; f < n / 3; f++) {
      let rg = reg, ax = axis, sg = 1;
      if (uv === 'box') {
        // the face: from the source normals (exact for boxes)
        let nx = 0, ny = 0, nz = 0;
        if (nrm) for (let k = 0; k < 3; k++) { nx += nrm.getX(f * 3 + k); ny += nrm.getY(f * 3 + k); nz += nrm.getZ(f * 3 + k); }
        else { a.fromBufferAttribute(p, f * 3); b.fromBufferAttribute(p, f * 3 + 1); c.fromBufferAttribute(p, f * 3 + 2); b.sub(a); c.sub(a); b.cross(c); nx = b.x; ny = b.y; nz = b.z; }
        const X = Math.abs(nx), Y = Math.abs(ny), Z = Math.abs(nz);
        ax = X >= Y && X >= Z ? 'x' : Y >= Z ? 'y' : 'z';
        sg = (ax === 'x' ? nx : ax === 'y' ? ny : nz) >= 0 ? 1 : -1;
        const fk = (sg > 0 ? 'p' : 'n') + ax;
        if (faces && faces[fk]) rg = faces[fk];
      }
      for (let k = 0; k < 3; k++) {
        const i = f * 3 + k, x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        let u, v;
        if (uv === 'keep') { u = src ? src.getX(i) : 0; v = src ? src.getY(i) : 0; }
        else {
          const B = uv === 'planar' ? bounds : null;
          const fx = (x - mn.x) / (sz.x || 1), fy = (y - mn.y) / (sz.y || 1), fz = (z - mn.z) / (sz.z || 1);
          if (ax === 'z') { u = B ? (x - B[0]) / (B[2] - B[0]) : fx; v = B ? (y - B[1]) / (B[3] - B[1]) : fy; if (uv === 'box' && sg < 0) u = 1 - u; }
          else if (ax === 'x') { u = B ? (z - B[0]) / (B[2] - B[0]) : fz; v = B ? (y - B[1]) / (B[3] - B[1]) : fy; if (uv === 'box' && sg > 0) u = 1 - u; }
          else { u = B ? (x - B[0]) / (B[2] - B[0]) : fx; v = B ? (z - B[1]) / (B[3] - B[1]) : fz; if (uv === 'box' ? sg > 0 : true) v = 1 - v; }
        }
        u = Math.min(1, Math.max(0, u)); v = Math.min(1, Math.max(0, v));
        const [U, Vv] = map(rg, u, v);
        UV[i * 2] = U; UV[i * 2 + 1] = Vv;
      }
    }
    if (at && space !== 'final') gg.applyMatrix4(at);
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', gg.attributes.position);
    out.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
    creaseNormals(out, crease);
    const T = typeof tint === 'number' ? [tint, tint, tint] : tint;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[i * 3] = T[0]; col[i * 3 + 1] = T[1]; col[i * 3 + 2] = T[2]; }
    out.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.parts.push(out);
    return this;
  }
  // merge, then darken toward the bottom (contact shadow) and in a soft band under overhangs
  done({ ao = 0.32, aoH = 0.3, fit = null } = {}) {
    const g = mergeGeometries(this.parts, false);
    if (fit) {     // stretch to fill the collider box [hx, hy, hz]
      g.computeBoundingBox();
      const b = g.boundingBox, c = b.getCenter(new V3()), sz = b.getSize(new V3());
      g.translate(-c.x, -c.y, -c.z); g.scale(2 * fit[0] / sz.x, 2 * fit[1] / sz.y, 2 * fit[2] / sz.z);
      creaseNormalsKeep(g);
    }
    g.computeBoundingBox();
    const y0 = g.boundingBox.min.y, H = Math.max(0.05, g.boundingBox.max.y - y0), k = Math.min(aoH, H * 0.45);
    const p = g.attributes.position, c = g.attributes.color, nr = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const t = Math.min(1, Math.max(0, (p.getY(i) - y0) / k)), s = 1 - ao * (1 - t * t * (3 - 2 * t));
      const up = 0.94 + 0.06 * nr.getY(i);     // a whisper of painted top light
      c.setXYZ(i, c.getX(i) * s * up, c.getY(i) * s * up, c.getZ(i) * s * up);
    }
    const m = mergeVertices(g, 1e-5);
    m.computeBoundingSphere(); m.computeBoundingBox();
    for (const q of this.parts) q.dispose();
    return m;
  }
}

// ---- the props --------------------------------------------------------------------------------------

const GOLD = [1.18, 1.06, 0.78];

const BUILDERS = {
  gnome() {
    const B = new Build();
    const hat = sub(R.gnome, 0, 0, 0.5, 0.5), coat = sub(R.gnome, 0.5, 0, 1, 0.5), beard = sub(R.gnome, 0, 0.5, 0.5, 1), face = sub(R.gnome, 0.5, 0.5, 1, 1);
    // big boots poking out under the coat
    for (const sx of [-1, 1]) B.add(sphere(1, 10, 6), R.boot, { at: mat4(sx * 0.05, -0.211, 0.04, 0, sx * 0.12, 0, [0.05, 0.032, 0.078]) });
    // a fat bell of a coat with the belt round its middle
    B.add(lathe([[0, -0.205, 0], [0.094, -0.205, 0.04], [0.11, -0.19, 0.09], [0.115, -0.15, 0.22], [0.11, -0.095, 0.42], [0.097, -0.045, 0.62], [0.077, -0.008, 0.8], [0.048, 0.01, 0.92], [0, 0.014, 1]], 14), coat);
    // arms round the belly, mitts clasped below the beard
    for (const sx of [-1, 1]) {
      B.add(sphere(1, 8, 6), coat, { at: mat4(sx * 0.088, -0.05, 0.04, 0.55, 0, sx * 0.5, [0.036, 0.074, 0.036]) });
      B.add(sphere(1, 8, 6), R.skin, { at: mat4(sx * 0.045, -0.11, 0.104, 0, 0, 0, [0.034, 0.03, 0.03]) });
    }
    // a big round head, a bigger nose
    B.add(sphere(0.075, 14, 10), face, { at: mat4(0, 0.062, 0.01) });
    B.add(sphere(1, 10, 7), R.skin, { at: mat4(0, 0.054, 0.086, 0, 0, 0, [0.021, 0.02, 0.021]) });
    // the beard: a fat cone from the cheeks to the belly, laid against the chest; a mustache
    B.add(lathe([[0, -0.14, 0], [0.02, -0.12, 0.12], [0.056, -0.07, 0.42], [0.074, -0.02, 0.7], [0.072, 0.01, 0.88], [0.05, 0.03, 0.96], [0, 0.034, 1]], 12), beard, { at: mat4(0, 0.044, 0.05, -0.2, 0, 0, [1.18, 1.12, 0.62]) });
    for (const sx of [-1, 1]) B.add(sphere(1, 8, 5), beard, { at: mat4(sx * 0.024, 0.041, 0.082, 0, sx * 0.3, sx * -0.4, [0.03, 0.012, 0.018]), tint: 1.08 });
    // the hat, its tip flopping back and to one side, and a rolled brim
    B.add(lathe([[0.078, 0.104, 0], [0.077, 0.12, 0.1], [0.063, 0.153, 0.32], [0.044, 0.186, 0.56], [0.026, 0.214, 0.78], [0.01, 0.233, 0.94], [0, 0.24, 1]], 14), hat,
      { warp: v => { const t = Math.max(0, (v.y - 0.11) / 0.13); v.z -= t * t * 0.05; v.x += t * t * 0.02; } });
    B.add(new THREE.TorusGeometry(0.074, 0.013, 6, 18), sub(R.gnome, 0, 0.42, 0.5, 0.5), { at: mat4(0, 0.109, 0, Math.PI / 2, 0, 0) });
    return B.done({ ao: 0.28, aoH: 0.12 });
  },

  lamp() {
    const B = new Build();
    B.add(lathe([[0, -0.3], [0.118, -0.3], [0.124, -0.29], [0.118, -0.276], [0.09, -0.266], [0.06, -0.244], [0.04, -0.2], [0.026, -0.17], [0.022, -0.15], [0.022, -0.06],
      [0.036, -0.05], [0.036, -0.03], [0.02, -0.02], [0.018, 0.04], [0.01, 0.06], [0, 0.065]], 12), R.brass, { tint: [1.05, 1, 0.9] });
    const shade = [[0.165, 0.0], [0.164, 0.03], [0.152, 0.09], [0.128, 0.16], [0.09, 0.212], [0.052, 0.242], [0.03, 0.252]];
    B.add(lathe(shade, 16), R.glass);
    B.add(lathe(shade.map(([r, y]) => [r - 0.006, y + 0.002]).reverse(), 16), R.glass, { tint: 0.62 });
    B.add(new THREE.TorusGeometry(0.165, 0.008, 5, 20), R.brass, { at: mat4(0, 0.0, 0, Math.PI / 2, 0, 0) });
    B.add(cyl(0.034, 0.02, 10), R.brass, { at: mat4(0, 0.258, 0) });
    B.add(sphere(0.022, 8, 6), R.brass, { at: mat4(0, 0.278, 0) });
    B.add(sphere(0.042, 10, 7), R.bulb, { at: mat4(0, 0.09, 0) });
    return B.done({ ao: 0.25, aoH: 0.1 });
  },

  toaster() {
    const B = new Build();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add(sphere(1, 8, 5), R.rubber, { at: mat4(sx * 0.11, -0.104, sz * 0.06, 0, 0, 0, [0.022, 0.016, 0.022]), tint: 1.3 });
    B.add(rbox(0.29, 0.196, 0.18, 0.055), R.steel, { uv: 'box', faces: { py: sub(R.steel, 0, 0.02, 1, 0.14), ny: sub(R.steel, 0, 0.86, 1, 0.98) }, at: mat4(0, -0.002, 0) });
    for (const sz of [-1, 1]) {
      B.add(rbox(0.21, 0.012, 0.034, 0.005), R.rubber, { uv: 'box', at: mat4(0, 0.088, sz * 0.04), tint: 0.6 });
      B.add(rbox(0.17, 0.085, 0.022, 0.014), R.toast, { uv: 'box', at: mat4(0.004 * sz, 0.083, sz * 0.04, 0, 0, sz * 0.03) });
    }
    B.add(rbox(0.008, 0.09, 0.022, 0.003), R.rubber, { uv: 'box', at: mat4(0.146, 0.0, 0), tint: 0.6 });
    B.add(rbox(0.03, 0.026, 0.044, 0.011), R.honey, { uv: 'box', at: mat4(0.158, 0.03, 0) });
    B.add(cyl(0.02, 0.014, 10), R.brass, { at: mat4(0.08, -0.03, 0.093, Math.PI / 2, 0, 0) });
    return B.done({ ao: 0.25, aoH: 0.06 });
  },

  register() {
    const B = new Build();
    B.add(rbox(0.4, 0.092, 0.39, 0.016), R.wood, { uv: 'box', faces: { pz: R.till }, at: mat4(0, -0.044, 0) });
    const slope = v => { if (v.y > 0) v.y += (-v.z / 0.13) * 0.022; };
    B.add(rbox(0.36, 0.05, 0.26, 0.012), R.brass, { uv: 'box', at: mat4(0, 0.025, -0.04), warp: slope });
    for (let j = 0; j < 3; j++) for (let i = 0; i < 5; i++) {
      const x = -0.12 + i * 0.06, z = 0.04 - j * 0.055, y = 0.05 + (-(z + 0.04) / 0.13) * 0.022 + 0.008;
      B.add(cyl(0.016, 0.016, 8), R.brass, { at: mat4(x, y - 0.004, z), tint: 0.8 });
      B.add(cyl(0.017, 0.008, 8, 0.014), R.ivory, { at: mat4(x, y + 0.006, z) });
    }
    B.add(rbox(0.22, 0.05, 0.05, 0.01), R.brass, { uv: 'box', faces: { pz: sub(R.plaque, 0.5, 0, 1, 1) }, at: mat4(0, 0.066, -0.15) });
    B.add(cyl(0.01, 0.03, 8), R.brass, { at: mat4(0.205, -0.04, 0.06, 0, 0, Math.PI / 2) });
    B.add(rbox(0.012, 0.07, 0.016, 0.004), R.brass, { uv: 'box', at: mat4(0.218, -0.012, 0.06) });
    B.add(sphere(0.016, 8, 6), R.honey, { at: mat4(0.222, 0.025, 0.06) });
    return B.done({ ao: 0.25, aoH: 0.05 });
  },

  trophy() {
    const B = new Build();
    B.add(lathe([[0, -0.22, 0], [0.086, -0.22, 0.1], [0.088, -0.214, 0.15], [0.088, -0.184, 0.4], [0.078, -0.178, 0.5], [0.07, -0.152, 0.75], [0.058, -0.146, 0.85], [0, -0.146, 1]], 12), R.wood);
    B.add(rbox(0.07, 0.022, 0.008, 0.003), sub(R.plaque, 0, 0, 0.5, 1), { uv: 'planar', axis: 'z', at: mat4(0, -0.199, 0.085) });
    B.add(lathe([[0.046, -0.146], [0.04, -0.136], [0.018, -0.12], [0.013, -0.085], [0.028, -0.07], [0.028, -0.056], [0.013, -0.042], [0.015, -0.012], [0.03, 0.0],
      [0.054, 0.016], [0.068, 0.046], [0.072, 0.09], [0.074, 0.122], [0.078, 0.13], [0.07, 0.128], [0.062, 0.1], [0, 0.08]], 14), R.brass, { tint: GOLD });
    for (const sx of [-1, 1]) B.add(new THREE.TorusGeometry(0.021, 0.0065, 5, 10, Math.PI), R.brass, { at: mat4(sx * 0.068, 0.07, 0, 0, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2), tint: GOLD });
    B.add(sphere(0.043, 12, 9), R.ball, { at: mat4(0, 0.172, 0, -1.25, 2.4, 0) });
    return B.done({ ao: 0.25, aoH: 0.05 });
  },

  vase() {
    const B = new Build();
    B.add(lathe(VASE_PROFILE, 18), R.porcelain);
    B.add(lathe([[0.1, 0.38], [0.086, 0.366], [0.072, 0.335], [0.0, 0.31]], 18), sub(R.porcelain, 0, 0, 1, 0.05), { tint: 0.4 });
    return B.done({ ao: 0.22, aoH: 0.12 });
  },

  tv() {
    const B = new Build();
    B.add(rbox(0.6, 0.03, 0.5, 0.01), R.wood, { uv: 'box', at: mat4(0, -0.285, -0.02), tint: 0.75 });
    // the cabinet, tapering toward the tube at the back
    const taper = v => { const f = Math.max(0, (0.05 - v.z) / 0.34); v.x *= 1 - 0.2 * f; v.y = (v.y) * (1 - 0.16 * f) - 0.02 * f; };
    B.add(rbox(0.68, 0.47, 0.58, 0.04), R.wood, { uv: 'box', faces: { pz: R.tvfront, nz: sub(R.tvfront, 0.77, 0.47, 0.94, 0.86) }, at: mat4(0, -0.035, -0.01), warp: taper });
    // the screen: a bulging pane sitting in the recess
    const [u0, v0, u1, v1] = TV_LAYOUT.screen, fw = 0.68, fh = 0.47, fz = 0.28;
    const sw = (u1 - u0) * fw * 0.97, sh = (v1 - v0) * fh * 0.97, scx = -fw / 2 + (u0 + u1) / 2 * fw, scy = -0.035 - fh / 2 + (v0 + v1) / 2 * fh;
    const scr = new THREE.PlaneGeometry(sw, sh, 6, 5), sp = scr.attributes.position;
    for (let i = 0; i < sp.count; i++) { const x = sp.getX(i) / (sw / 2), y = sp.getY(i) / (sh / 2); sp.setZ(i, 0.022 * (1 - x * x * 0.8) * (1 - y * y * 0.8)); }
    B.add(scr, R.screen, { at: mat4(scx, scy, fz - 0.012), crease: 80 });
    for (const [ku, kv] of TV_LAYOUT.knobs) B.add(lathe([[0, 0], [0.024, 0], [0.026, 0.01], [0.022, 0.022], [0.012, 0.026], [0, 0.027]], 10), R.brass, { at: mat4(-fw / 2 + ku * fw, -0.035 - fh / 2 + kv * fh, fz - 0.002, Math.PI / 2, 0, 0) });
    // rabbit ears
    B.add(sphere(1, 10, 6), R.brass, { at: mat4(0.06, 0.2, -0.06, 0, 0, 0, [0.05, 0.03, 0.05]), tint: 0.85 });
    for (const sx of [-1, 1]) {
      B.add(cyl(0.0055, 0.17, 6, 0.004), R.rubber, { at: mat4(0.06 + sx * 0.068, 0.268, -0.06, 0, 0, -sx * 0.95) });
      B.add(sphere(0.011, 6, 4), R.brass, { at: mat4(0.06 + sx * 0.137, 0.317, -0.06) });
    }
    return B.done({ ao: 0.28, aoH: 0.12 });
  },

  neon() {     // the old neon OPEN sign, as a lantern-lit painted shop board
    const B = new Build();
    B.add(rbox(0.8, 0.42, 0.08, 0.016), R.wood, { uv: 'box', faces: { pz: R.sign, nz: R.sign }, at: mat4(0, -0.04, 0) });
    B.add(rbox(0.98, 0.026, 0.032, 0.008), R.rubber, { uv: 'box', at: mat4(0, 0.232, 0), tint: 1.3 });
    for (const sx of [-1, 1]) {
      // rings holding the board up
      B.add(new THREE.TorusGeometry(0.02, 0.005, 4, 10), R.rubber, { at: mat4(sx * 0.28, 0.2, 0, 0, Math.PI / 2, 0), tint: 1.3 });
      // a lantern hanging off each end of the bar
      const x = sx * 0.452;
      B.add(new THREE.TorusGeometry(0.014, 0.004, 4, 8), R.rubber, { at: mat4(x, 0.212, 0, 0, Math.PI / 2, 0), tint: 1.3 });
      B.add(lathe([[0, 0], [0.045, 0], [0.04, 0.012], [0.012, 0.04], [0, 0.045]], 4), R.rubber, { at: mat4(x, 0.155, 0, 0, Math.PI / 4, 0), tint: 1.2 });
      B.add(rbox(0.07, 0.09, 0.07, 0.006), R.lantern, { uv: 'box', faces: { py: R.rubber, ny: R.rubber }, at: mat4(x, 0.11, 0) });
      B.add(lathe([[0, 0], [0.042, 0], [0.042, 0.012], [0, 0.014]], 4), R.rubber, { at: mat4(x, 0.054, 0, 0, Math.PI / 4, 0), tint: 1.2 });
    }
    return B.done({ ao: 0.12, aoH: 0.1 });
  },

  guitar() {
    const B = new Build();
    const BW = 0.36, BH = 0.62, y0 = -0.5, depth = 0.09, bev = 0.012;
    const shape = new THREE.Shape(GUITAR_OUTLINE.map(([x, y]) => new THREE.Vector2(x * (BW - 2 * bev * 0.8), y * (BH - 2 * bev * 0.8) + y0 + bev * 0.8)));
    const body = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: true, bevelThickness: bev, bevelSize: bev * 0.8, bevelSegments: 2, curveSegments: 4 });
    body.translate(0, 0, -depth / 2);
    body.computeVertexNormals();
    B.add(body, R.honey, { uv: 'box', faces: { pz: R.guitar }, bounds: null, crease: 55 });
    // neck, fretboard, the bent-back lute-ish head, pegs
    B.add(rbox(0.046, 0.31, 0.03, 0.012), R.wood, { uv: 'box', at: mat4(0, 0.26, -0.006), tint: [1.1, 0.95, 0.85] });
    B.add(rbox(0.05, 0.31, 0.008, 0.003), R.fret, { uv: 'box', faces: { pz: R.fret }, swap: true, at: mat4(0, 0.26, 0.013) });
    B.add(rbox(0.07, 0.12, 0.024, 0.01), R.wood, { uv: 'box', at: mat4(0, 0.452, -0.02, -0.28, 0, 0) });
    for (let k = 0; k < 3; k++) for (const sx of [-1, 1]) {
      const y = 0.418 + k * 0.034, z = -0.02 - (y - 0.4) * Math.tan(0.28);
      B.add(cyl(0.005, 0.03, 6), R.brass, { at: mat4(sx * 0.045, y, z, 0, 0, Math.PI / 2) });
      B.add(sphere(1, 6, 4), R.ivory, { at: mat4(sx * 0.064, y, z, 0, 0, 0, [0.008, 0.012, 0.006]) });
    }
    return B.done({ ao: 0.15, aoH: 0.1 });
  },

  painting() {
    const B = new Build();
    B.add(rbox(0.76, 0.58, 0.022, 0.003), R.honey, { uv: 'box', faces: { pz: R.portrait }, at: mat4(0, 0, -0.008) });
    // the gilded frame: four moldings, each a few segments so the ornament keeps its scale
    const bar = (len, cx, cy, rz, segs) => {
      for (let k = 0; k < segs; k++) {
        const L = len / segs, x = -len / 2 + L * (k + 0.5);
        const M = mat4(cx, cy, 0, 0, 0, rz).multiply(mat4(x, 0, 0));
        B.add(rbox(L + 0.001, 0.08, 0.064, 0.018), R.gold, { uv: 'box', faces: { px: R.brass, nx: R.brass, ny: R.brass }, at: M, warp: v => { if (v.y < 0) v.z -= 0.012 * (-v.y / 0.04); } });
      }
    };
    bar(0.9, 0, 0.32, 0, 3); bar(0.9, 0, -0.32, Math.PI, 3);
    bar(0.56, -0.41, 0, Math.PI / 2, 2); bar(0.56, 0.41, 0, -Math.PI / 2, 2);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) B.add(sphere(1, 10, 6), R.brass, { at: mat4(sx * 0.41, sy * 0.32, 0.026, 0, 0, 0, [0.046, 0.046, 0.016]), tint: GOLD });
    return B.done({ ao: 0.1, aoH: 0.1 });
  },

  suitcase() {
    const B = new Build();
    B.add(rbox(0.68, 0.44, 0.21, 0.04), R.leather, { uv: 'box', at: mat4(0, -0.025, 0) });
    B.add(rbox(0.692, 0.024, 0.222, 0.01), R.strap, { uv: 'box', at: mat4(0, 0.085, 0), tint: 0.9 });
    for (const sx of [-1, 1]) {
      const x = sx * 0.19;
      for (const sz of [-1, 1]) B.add(rbox(0.058, 0.452, 0.008, 0.003), R.strap, { uv: 'box', swap: true, at: mat4(x, -0.025, sz * 0.107) });
      B.add(rbox(0.058, 0.008, 0.222, 0.003), R.strap, { uv: 'box', at: mat4(x, 0.199, 0) });
      B.add(rbox(0.07, 0.05, 0.012, 0.008), R.brass, { uv: 'box', at: mat4(x, 0.02, 0.114) });
      B.add(rbox(0.04, 0.026, 0.006, 0.003), R.strap, { uv: 'box', at: mat4(x, 0.02, 0.121), tint: 0.6 });
      // brass corners on the four depth-wise edges
      for (const sy of [-1, 1]) B.add(rbox(0.068, 0.068, 0.226, 0.016), R.brass, { uv: 'box', at: mat4(sx * 0.31, -0.025 + sy * 0.19, 0), tint: 0.9 });
    }
    B.add(rbox(0.06, 0.046, 0.01, 0.006), R.brass, { uv: 'box', at: mat4(0, 0.095, 0.112) });
    B.add(new THREE.TorusGeometry(0.046, 0.013, 6, 10, Math.PI), R.strap, { uv: 'keep', at: mat4(0, 0.2, 0) });
    for (const sx of [-1, 1]) B.add(rbox(0.026, 0.014, 0.04, 0.005), R.brass, { uv: 'box', at: mat4(sx * 0.046, 0.204, 0) });
    B.add(rbox(0.05, 0.068, 0.004, 0.002), R.tag, { uv: 'box', at: mat4(0.075, 0.15, 0.03, 0, 0.2, 0.32) });
    return B.done({ ao: 0.25, aoH: 0.1 });
  },

  tire() {
    const B = new Build();
    const T = TIRE_V;
    B.add(lathe([[0.21, -0.088, 0], [0.24, -0.118, T.wallLo[0] * 0.6], [0.28, -0.13, T.wallLo[0]], [0.315, -0.128, T.wallLo[1]], [0.345, -0.108, 0.3], [0.36, -0.07, T.treadLo],
      [0.362, 0, 0.5], [0.36, 0.07, T.treadHi], [0.345, 0.108, 0.7], [0.315, 0.128, T.wallHi[0]], [0.28, 0.13, T.wallHi[1]], [0.24, 0.118, 0.94], [0.21, 0.088, 1]], 22), R.tire, { crease: 60 });
    const rim = [[0, -0.045], [0.06, -0.045], [0.085, -0.066], [0.19, -0.075], [0.208, -0.09], [0.214, -0.07], [0.214, 0.07], [0.208, 0.09], [0.19, 0.075], [0.085, 0.066], [0.06, 0.045], [0, 0.045]];
    B.add(lathe(rim, 22), R.rim, { uv: 'planar', axis: 'y', bounds: [-0.214, -0.214, 0.214, 0.214], crease: 40 });
    return B.done({ ao: 0.2, aoH: 0.1 });
  },

  slot() {
    const B = new Build();
    const top = sub(R.slot, 0, 0, 1, 100 / 512), front = sub(R.slot, 0, 100 / 512, 1, 1);
    B.add(rbox(0.72, 0.1, 0.64, 0.025), R.wood, { uv: 'box', at: mat4(0, -0.65, 0), tint: 0.8 });
    B.add(rbox(0.64, 0.98, 0.56, 0.035), R.red, { uv: 'box', faces: { pz: front }, at: mat4(0, -0.11, -0.02) });
    B.add(rbox(0.668, 0.032, 0.59, 0.012), R.brass, { uv: 'box', at: mat4(0, 0.385, -0.02) });
    B.add(rbox(0.6, 0.25, 0.46, 0.1), R.red, { uv: 'box', faces: { pz: top }, at: mat4(0, 0.52, -0.04) });
    B.add(sphere(0.04, 10, 7), R.brass, { at: mat4(0, 0.67, -0.04), tint: GOLD });
    // the button ledge and the coin tray line up with the paint
    B.add(rbox(0.6, 0.05, 0.1, 0.014), R.brass, { uv: 'box', at: mat4(0, -0.135, 0.29, -0.35, 0, 0) });
    for (let k = 0; k < 3; k++) B.add(cyl(0.022, 0.02, 10), R.ivory, { at: mat4(-0.15 + k * 0.15, -0.11, 0.3, -0.35, 0, 0), tint: k === 1 ? [1.1, 0.42, 0.36] : 1 });
    B.add(rbox(0.36, 0.06, 0.08, 0.016), R.brass, { uv: 'box', at: mat4(0, -0.475, 0.285) });
    // the one arm
    B.add(rbox(0.05, 0.13, 0.13, 0.02), R.brass, { uv: 'box', at: mat4(0.335, 0.0, 0.0) });
    B.add(cyl(0.013, 0.44, 8), R.rubber, { at: mat4(0.345, 0.22, 0.02, 0.06, 0, 0), tint: 1.5 });
    B.add(sphere(0.045, 12, 8), R.ivory, { at: mat4(0.338, 0.455, 0.035), tint: [1.15, 0.36, 0.3] });
    return B.done({ ao: 0.3, aoH: 0.25 });
  },

  safe() {
    const B = new Build();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add(lathe([[0, 0], [0.06, 0], [0.064, 0.02], [0.05, 0.05], [0.055, 0.062], [0, 0.064]], 10), R.iron, { at: mat4(sx * 0.3, -0.42, sz * 0.29), tint: 0.7 });
    B.add(rbox(0.78, 0.77, 0.74, 0.045), R.iron, { uv: 'box', at: mat4(0, 0.03, -0.02) });
    B.add(rbox(0.6, 0.6, 0.03, 0.02), R.iron, { uv: 'box', faces: { pz: R.safe }, at: mat4(0, 0.03, 0.36) });
    for (const sy of [-1, 1]) B.add(cyl(0.022, 0.1, 10), R.iron, { at: mat4(-0.305, 0.03 + sy * 0.2, 0.37), tint: 0.75 });
    B.add(lathe([[0, 0], [0.074, 0], [0.08, 0.01], [0.076, 0.02], [0.05, 0.028], [0.022, 0.034], [0, 0.035]], 18), R.brass, { at: mat4(0, 0.03, 0.372, Math.PI / 2, 0, 0) });
    B.add(rbox(0.15, 0.024, 0.022, 0.009), R.brass, { uv: 'box', at: mat4(0.0, -0.17, 0.39) });
    B.add(cyl(0.024, 0.026, 10), R.brass, { at: mat4(0.0, -0.17, 0.378, Math.PI / 2, 0, 0) });
    return B.done({ ao: 0.3, aoH: 0.15 });
  },

  dino() {
    const B = new Build();
    // the hide is one projection along x in prop space: u along the head, v belly (low) → back (high)
    const hide = { uv: 'planar', axis: 'x', bounds: [-0.75, -0.45, 0.75, 0.46], space: 'final', crease: 75 };
    // the skull: deep and broad at the back, a brow over the eye, a long snout with a nose bump
    const head = [
      { z: -0.62, w: 0.33, top: 0.33, bot: -0.04 }, { z: -0.5, w: 0.43, top: 0.43, bot: -0.08 }, { z: -0.32, w: 0.47, top: 0.47, bot: -0.1 },
      { z: -0.14, w: 0.45, top: 0.45, bot: -0.1 }, { z: 0.06, w: 0.38, top: 0.37, bot: -0.09 }, { z: 0.26, w: 0.31, top: 0.33, bot: -0.08 },
      { z: 0.46, w: 0.26, top: 0.33, bot: -0.07 }, { z: 0.6, w: 0.22, top: 0.3, bot: -0.06 }, { z: 0.7, w: 0.15, top: 0.22, bot: -0.04 }, { z: 0.75, w: 0.05, top: 0.11, bot: 0.0 },
    ];
    B.add(loft(head, 18, 2.4), R.dino, hide);
    const at = (st, z) => { let i = 1; while (i < st.length - 1 && st[i].z < z) i++; const a = st[i - 1], b = st[i], f = Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z))); return { w: a.w + (b.w - a.w) * f, top: a.top + (b.top - a.top) * f, bot: a.bot + (b.bot - a.bot) * f }; };
    // the lower jaw, hinged at the back and hanging open
    const jaw = [
      { z: -0.52, w: 0.35, top: -0.07, bot: -0.34 }, { z: -0.32, w: 0.39, top: -0.07, bot: -0.4 }, { z: -0.08, w: 0.35, top: -0.07, bot: -0.33 },
      { z: 0.16, w: 0.31, top: -0.07, bot: -0.26 }, { z: 0.4, w: 0.26, top: -0.07, bot: -0.22 }, { z: 0.58, w: 0.2, top: -0.07, bot: -0.19 }, { z: 0.66, w: 0.09, top: -0.08, bot: -0.15 },
    ];
    const J = new THREE.Matrix4().makeTranslation(0, -0.08, -0.48).multiply(new THREE.Matrix4().makeRotationX(0.2)).multiply(new THREE.Matrix4().makeTranslation(0, 0.08, 0.48));
    B.add(loft(jaw, 16, 2.4), R.dino, { ...hide, at: J });
    // the mouth's dark inside
    B.add(sphere(1, 12, 8), R.skin, { at: mat4(0, -0.12, 0.06, 0.1, 0, 0, [0.33, 0.1, 0.56]), tint: [0.55, 0.2, 0.22] });
    // teeth: hanging from the upper jaw line, standing on the lower
    const rnd = rngFrom('dino-teeth');
    for (const sx of [-1, 1]) {
      for (let k = 0; k < 8; k++) {
        const z = -0.2 + k * 0.115, h = at(head, z);
        B.add(cone(0.026, range(rnd, 0.08, 0.11) * (k > 5 ? 0.8 : 1), 6), R.ivory, { at: mat4(sx * (h.w * 0.86 - 0.02), h.bot + 0.03, z, Math.PI, 0, -sx * 0.12) });
      }
      for (let k = 0; k < 6; k++) {
        const z = -0.15 + k * 0.13, h = at(jaw, z), q = new V3(sx * (h.w * 0.85 - 0.03), h.top - 0.02, z).applyMatrix4(J);
        B.add(cone(0.022, range(rnd, 0.06, 0.085), 6), R.ivory, { at: mat4(q.x, q.y, q.z, 0.2, 0, sx * 0.12) });
      }
    }
    // eyes tucked under heavy brow ridges, nostrils on the nose bump, the broken neck
    for (const sx of [-1, 1]) {
      const ez = -0.2, h = at(head, ez);
      B.add(sphere(0.08, 12, 8), R.eye, { at: mat4(sx * (h.w * 0.8), 0.28, ez + 0.03, 0, sx * (Math.PI / 2 - 0.55), 0) });
      B.add(sphere(1, 12, 7), R.dino, { ...hide, at: mat4(sx * (h.w * 0.7), 0.38, ez + 0.03, 0, sx * 0.2, sx * 0.3, [0.13, 0.055, 0.18]) });
      B.add(sphere(1, 8, 5), R.rubber, { at: mat4(sx * 0.072, 0.3, 0.6, -0.5, 0, 0, [0.03, 0.016, 0.03]), tint: 1.2 });
    }
    B.add(lathe([[0, 0], [0.29, 0], [0.3, 0.01]], 16), R.plaster, { uv: 'planar', axis: 'y', bounds: [-0.3, -0.3, 0.3, 0.3], at: mat4(0, 0.145, -0.623, -Math.PI / 2, 0, 0, [1.05, 1, 0.6]) });
    return B.done({ ao: 0.3, aoH: 0.25, fit: [0.5, 0.45, 0.745] });
  },

  map() {      // the leather map case (the paper itself is a second mesh with the map canvas)
    const B = new Build();
    B.add(rbox(0.4, 0.016, 0.28, 0.006), R.leather, { uv: 'box', at: mat4(0, -0.012, 0) });
    return B.done({ ao: 0, aoH: 0.01 });
  },
};

// the boulder: a chunky rock that fills its 4 × 2.6 × 3 m box, painted per biome
function boulderGeo(biome) {
  const [, hx, hy, hz] = LOOT.boulder.shape;
  const rnd = rngFrom('boulder-' + biome);
  const cuts = [];
  for (let k = 0; k < 10; k++) { const a = k / 10 * TAU + rnd() * 0.5, e = range(rnd, -0.25, 0.9); cuts.push([new V3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)).normalize(), range(rnd, 0.7, 0.88)]); }
  const ph = Array.from({ length: 6 }, () => rnd() * TAU);
  const g = sphere(1, 16, 10);
  const p = g.attributes.position, v = new V3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // toward a box (fills the collider's corners), lumpy, a few flat broken planes
    v.set(Math.sign(v.x) * Math.pow(Math.abs(v.x), 0.72), Math.sign(v.y) * Math.pow(Math.abs(v.y), 0.8), Math.sign(v.z) * Math.pow(Math.abs(v.z), 0.72));
    const n = 1 + 0.07 * Math.sin(v.x * 3.1 + ph[0]) * Math.sin(v.z * 2.7 + ph[1]) + 0.05 * Math.sin(v.y * 4.3 + ph[2] + v.x * 2) + 0.03 * Math.sin(v.z * 7 + ph[3]);
    v.multiplyScalar(n);
    for (const [nn, d] of cuts) { const e = v.dot(nn) - d; if (e > 0) v.addScaledVector(nn, -e * 0.97); }
    if (v.y < -0.82) v.y = -0.82 + (v.y + 0.82) * 0.15;
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeBoundingBox();
  const bb = g.boundingBox, c = bb.getCenter(new V3()), s = bb.getSize(new V3());
  for (let i = 0; i < p.count; i++) p.setXYZ(i, (p.getX(i) - c.x) / s.x * 2 * hx * 0.99, (p.getY(i) - c.y) / s.y * 2 * hy, (p.getZ(i) - c.z) / s.z * 2 * hz * 0.99);
  // u: the lathe's own (wraps round the rock, twice); v: height, so the zone's cover sits on top
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setY(i, 0.01 + 0.98 * (p.getY(i) + hy) / (2 * hy));
  const out = g.toNonIndexed();
  creaseNormals(out, 36);
  const col = new Float32Array(out.attributes.position.count * 3), q = out.attributes.position;
  for (let i = 0; i < q.count; i++) { const t = Math.min(1, (q.getY(i) + hy) / 0.9), k = 0.62 + 0.38 * t * t * (3 - 2 * t); col[i * 3] = k; col[i * 3 + 1] = k; col[i * 3 + 2] = k * 1.02; }
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = mergeVertices(out, 1e-5); m.computeBoundingSphere();
  return m;
}

// ---- the paper road map ----------------------------------------------------------------------------

const BIOME_INK = {
  meadow: { land: ['#b8c48a', '#a8b878', '#c8cc96'], hill: '#8a9a5a', tree: 'oak', wall: '#8a8a6a' },
  fields: { land: ['#e0c98a', '#d4b874', '#e8d49a'], hill: '#b89a5a', tree: 'wheat', wall: '#a08a5a' },
  snow: { land: ['#e8ecee', '#d4dee6', '#f2f2ee'], hill: '#8a96a8', tree: 'pine', wall: '#7a8494' },
  badlands: { land: ['#e0a878', '#d4946a', '#e8b888'], hill: '#a85a38', tree: 'dead', wall: '#9a4a2e' },
  desert: { land: ['#ecd4a0', '#e0c48c', '#f2dcae'], hill: '#c09a6a', tree: 'cactus', wall: '#b08a5a' },
};
const POI_NAMES = { gas: 'Fuel Stop', semi: 'Overturned Wagon', yard: 'Yard Sale', crash: 'Crash Site', junk: 'Junkyard', dino: 'Dino Park' };
const OBST_NAMES = { grade: 'Steep Grade', mud: 'Mud Bog', boulder: 'Rockfall', gate: 'Ranger Gate' };

function mapIcon(g, kind, x, y, s = 1) {
  g.save(); g.translate(x, y); g.scale(s, s);
  const ink = '#3a2a1e';
  g.lineWidth = 1.6; g.strokeStyle = ink; g.lineJoin = 'round'; g.lineCap = 'round';
  const fillStroke = (c) => { g.fillStyle = c; g.fill(); g.stroke(); };
  // a parchment medallion behind every icon
  g.beginPath(); g.arc(0, 0, 13, 0, TAU); g.fillStyle = '#f2e2b8'; g.fill(); g.lineWidth = 2; g.stroke();
  g.beginPath(); g.arc(0, 0, 10.5, 0, TAU); g.lineWidth = 0.8; g.strokeStyle = '#8a6a40'; g.stroke();
  g.lineWidth = 1.4; g.strokeStyle = ink;
  if (kind === 'gas') {
    g.beginPath(); g.rect(-6, -6, 8, 13); fillStroke('#b8402a');
    g.beginPath(); g.rect(-4.5, -4, 5, 4); fillStroke('#f2e2b8');
    g.beginPath(); g.moveTo(2, -3); g.quadraticCurveTo(7, -3, 6, 3); g.lineTo(6, 6); g.stroke();
  } else if (kind === 'semi') {
    g.beginPath(); g.rect(-8, -5, 11, 8); fillStroke('#c8a050');
    g.beginPath(); g.rect(3, -2, 5, 5); fillStroke('#8a5a30');
    for (const wx of [-5, 5]) { g.beginPath(); g.arc(wx, 4.5, 2.6, 0, TAU); fillStroke('#5a3a20'); }
  } else if (kind === 'yard') {
    g.beginPath(); g.moveTo(-7, -2); g.lineTo(2, -8); g.lineTo(8, -2); g.lineTo(8, 6); g.lineTo(-7, 6); g.closePath(); fillStroke('#d8b060');
    g.beginPath(); g.arc(-2, -0.5, 1.6, 0, TAU); g.stroke();
    g.font = `bold 8px Georgia, serif`; g.fillStyle = ink; g.textAlign = 'center'; g.fillText('$', 3, 4.5);
  } else if (kind === 'crash') {
    g.rotate(-0.5);
    g.beginPath(); g.ellipse(0, 0, 9, 2.6, 0, 0, TAU); fillStroke('#a8a8a0');
    g.beginPath(); g.moveTo(-2, 0); g.lineTo(-4, -8); g.lineTo(1, -8); g.lineTo(3, 0); g.lineTo(1, 8); g.lineTo(-4, 8); g.closePath(); fillStroke('#c8c8b8');
    g.beginPath(); g.moveTo(-8, 0); g.lineTo(-10, -4); g.lineTo(-7, -4); g.closePath(); fillStroke('#c8c8b8');
  } else if (kind === 'junk') {
    g.beginPath(); for (let k = 0; k < 16; k++) { const a = k / 16 * TAU, r = k % 2 ? 6 : 8.5; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); fillStroke('#8a8a84');
    g.beginPath(); g.arc(0, 0, 2.6, 0, TAU); fillStroke('#f2e2b8');
  } else if (kind === 'dino') {
    g.beginPath(); g.moveTo(-8, 5); g.quadraticCurveTo(-7, -6, 2, -6); g.lineTo(8, -3); g.lineTo(8, 0); g.lineTo(1, 1); g.lineTo(3, 4); g.lineTo(-2, 3); g.lineTo(-3, 6); g.closePath(); fillStroke('#5a8a44');
    g.beginPath(); g.arc(1, -3.5, 1, 0, TAU); g.fillStyle = ink; g.fill();
  } else if (kind === 'camp') {
    g.beginPath(); g.moveTo(-8, 6); g.lineTo(0, -8); g.lineTo(8, 6); g.closePath(); fillStroke('#c8a070');
    g.beginPath(); g.moveTo(0, -8); g.lineTo(0, 6); g.stroke();
    g.beginPath(); g.moveTo(-2, 6); g.lineTo(0, 1); g.lineTo(2, 6); g.closePath(); fillStroke('#5a3a20');
  } else if (kind === 'town') {
    for (const [hx, hh, c] of [[-5, 9, '#c84a3a'], [4, 12, '#3a5a8a']]) {
      g.beginPath(); g.rect(hx - 4, 7 - hh * 0.6, 8, hh * 0.6); fillStroke('#f0e2c0');
      g.beginPath(); g.moveTo(hx - 5.5, 7 - hh * 0.6); g.lineTo(hx, 7 - hh * 1.1); g.lineTo(hx + 5.5, 7 - hh * 0.6); g.closePath(); fillStroke(c);
    }
  }
  g.restore();
}
function obstacleIcon(g, kind, x, y) {
  g.save(); g.translate(x, y);
  g.strokeStyle = '#8a1e14'; g.fillStyle = '#c8402a'; g.lineWidth = 1.6; g.lineJoin = 'round'; g.lineCap = 'round';
  if (kind === 'grade') { g.beginPath(); g.moveTo(-9, 5); g.lineTo(-2, -6); g.lineTo(2, -1); g.lineTo(5, -4); g.lineTo(10, 5); g.closePath(); g.fillStyle = '#b8805a'; g.fill(); g.stroke(); }
  else if (kind === 'mud') { for (let k = 0; k < 3; k++) { g.beginPath(); for (let x = -9; x <= 9; x += 1) g.lineTo(x, -4 + k * 4 + Math.sin(x * 0.9) * 1.6); g.strokeStyle = '#5a3a1e'; g.stroke(); } }
  else if (kind === 'boulder') { g.beginPath(); g.moveTo(-8, 5); g.lineTo(-7, -2); g.lineTo(-2, -6); g.lineTo(5, -5); g.lineTo(8, 0); g.lineTo(7, 5); g.closePath(); g.fillStyle = '#9a948a'; g.fill(); g.strokeStyle = '#3a2a1e'; g.stroke(); }
  else if (kind === 'gate') { g.beginPath(); g.rect(-10, -3, 20, 5); g.fillStyle = '#e8d8b0'; g.fill(); g.stroke(); for (let k = -8; k < 10; k += 6) { g.beginPath(); g.moveTo(k, -3); g.lineTo(k + 3, 2); g.lineTo(k + 6, 2); g.lineTo(k + 3, -3); g.closePath(); g.fillStyle = '#c8402a'; g.fill(); } g.beginPath(); g.moveTo(-9, 2); g.lineTo(-9, 8); g.moveTo(9, 2); g.lineTo(9, 8); g.stroke(); }
  // a red warning X under it
  g.restore();
}
function tinyTree(g, kind, x, y, rnd) {
  const s = range(rnd, 0.8, 1.2);
  g.save(); g.translate(x, y); g.scale(s, s);
  g.strokeStyle = '#3a2a1e'; g.lineWidth = 1;
  if (kind === 'oak') { g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -3); g.stroke(); g.beginPath(); g.arc(0, -6, 4, 0, TAU); g.fillStyle = '#6a8a3a'; g.fill(); g.stroke(); blob(g, -1.3, -7.3, 1.8, 1.3, 0, '#b8cc70', 0.8, 0.5); }
  else if (kind === 'pine') { g.beginPath(); g.moveTo(0, -10); g.lineTo(4, -1); g.lineTo(-4, -1); g.closePath(); g.fillStyle = '#4a6a54'; g.fill(); g.stroke(); g.beginPath(); g.moveTo(0, -10); g.lineTo(2, -6); g.lineTo(-2, -6); g.closePath(); g.fillStyle = '#f4f4f0'; g.fill(); }
  else if (kind === 'wheat') { for (const dx of [-2, 0, 2]) { g.beginPath(); g.moveTo(dx, 0); g.lineTo(dx * 1.4, -7); g.strokeStyle = '#8a6a2a'; g.stroke(); ellipse(g, dx * 1.4, -7, 1, 2, 0, '#c8a040'); } }
  else if (kind === 'dead') { g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -7); g.moveTo(0, -4); g.lineTo(-3, -7); g.moveTo(0, -5); g.lineTo(3, -8); g.strokeStyle = '#4a2e1e'; g.lineWidth = 1.3; g.stroke(); }
  else if (kind === 'cactus') { g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -8); g.moveTo(-3, -6); g.lineTo(-3, -3); g.lineTo(0, -3); g.moveTo(3, -7); g.lineTo(3, -4); g.lineTo(0, -4); g.strokeStyle = '#3a6a3a'; g.lineWidth = 2; g.stroke(); }
  g.restore();
}
function compassRose(g, x, y, r) {
  g.save(); g.translate(x, y);
  g.beginPath(); g.arc(0, 0, r * 0.62, 0, TAU); g.strokeStyle = 'rgba(58,42,30,0.8)'; g.lineWidth = 1.2; g.stroke();
  g.beginPath(); g.arc(0, 0, r * 0.55, 0, TAU); g.lineWidth = 0.6; g.stroke();
  for (let k = 0; k < 8; k++) {
    const a = k / 8 * TAU - Math.PI / 2, L = k % 2 ? r * 0.55 : r, w = k % 2 ? r * 0.1 : r * 0.16;
    const tip = [Math.cos(a) * L, Math.sin(a) * L], lft = [Math.cos(a - Math.PI / 2) * w, Math.sin(a - Math.PI / 2) * w], rgt = [Math.cos(a + Math.PI / 2) * w, Math.sin(a + Math.PI / 2) * w];
    g.beginPath(); g.moveTo(0, 0); g.lineTo(...lft); g.lineTo(...tip); g.closePath(); g.fillStyle = k === 0 ? '#a8302a' : k % 2 ? '#c8a050' : '#3a2a1e'; g.fill();
    g.beginPath(); g.moveTo(0, 0); g.lineTo(...rgt); g.lineTo(...tip); g.closePath(); g.fillStyle = k === 0 ? '#e86a50' : k % 2 ? '#f0d488' : '#f2e2b8'; g.fill();
    g.beginPath(); g.moveTo(...lft); g.lineTo(...tip); g.lineTo(...rgt); g.strokeStyle = '#3a2a1e'; g.lineWidth = 0.8; g.stroke();
  }
  g.beginPath(); g.arc(0, 0, r * 0.08, 0, TAU); g.fillStyle = '#c8a050'; g.fill(); g.stroke();
  g.font = `bold ${Math.round(r * 0.42)}px Georgia, 'Liberation Serif', serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#3a2a1e';
  g.fillText('N', 0, -r - r * 0.28);
  g.restore();
}
function inkText(g, txt, x, y, { size = 12, color = '#3a2a1e', italic = false, align = 'center', halo = '#f2e2b8', weight = 'bold' } = {}) {
  g.save();
  g.font = `${italic ? 'italic ' : ''}${weight} ${size}px Georgia, 'Liberation Serif', 'DejaVu Serif', serif`;
  g.textAlign = align; g.textBaseline = 'middle';
  if (halo) { g.lineWidth = 3; g.strokeStyle = rgba(halo, 0.85); g.lineJoin = 'round'; g.strokeText(txt, x, y); }
  g.fillStyle = color; g.fillText(txt, x, y);
  g.restore();
}

// The road map: a sheet of burnt-edged parchment with the leg hand-inked on it. The road runs
// left (camp) → right (town); every stop, obstacle and landmark is on it, with distances.
const mapCache = new WeakMap();
export function mapCanvas(W) {
  if (W && mapCache.has(W)) return mapCache.get(W);
  const Wd = W || demoWorld();
  const CW = 512, CH = 380;
  const cv = makeCanvas(CW, CH), g = cv.getContext('2d');
  const rnd = rngFrom(`map-${Wd.seed ?? 0}-${Wd.day}`);
  const B = BIOME_INK[Wd.biome] || BIOME_INK.meadow;
  // parchment
  g.fillStyle = '#ead6a8'; g.fillRect(0, 0, CW, CH);
  for (let i = 0; i < 60; i++) blob(g, rnd() * CW, rnd() * CH, range(rnd, 20, 70), range(rnd, 14, 50), rnd() * 3, pick(rnd, ['#f2e0b4', '#dcc492', '#e4cc9a', '#d4b884']), 0.35, 0.1);
  for (let i = 0; i < 7; i++) { const x = rnd() * CW, y = rnd() * CH, r = range(rnd, 10, 26); g.save(); g.strokeStyle = rgba('#a8804a', 0.25); g.lineWidth = range(rnd, 1.5, 3); g.beginPath(); g.arc(x, y, r, 0, TAU); g.stroke(); g.restore(); blob(g, x, y, r, r, 0, '#c8a470', 0.12, 0.6); }
  // the land along the road, painted in the zone's colors, and the canyon walls inked as hills
  const z0 = Wd.Z0 + 30, z1 = Wd.Z1 - 20;
  const X = z => 34 + (z - z0) / (z1 - z0) * 444;
  const Y = x => 200 - x * 1.55;
  for (let i = 0; i < 70; i++) { const z = z0 + rnd() * (z1 - z0), x = Wd.roadX(z) + range(rnd, -40, 40); blob(g, X(z), Y(x), range(rnd, 18, 40), range(rnd, 12, 26), 0, pick(rnd, B.land), 0.4, 0.15); }
  for (const side of [-1, 1]) {
    for (let z = z0 + 8; z < z1; z += range(rnd, 13, 22)) {
      const x = Wd.roadX(z) + side * range(rnd, 34, 46), px = X(z), py = Y(x), h = range(rnd, 9, 15), w = range(rnd, 9, 14);
      g.save(); g.beginPath(); g.moveTo(px - w, py);
      if (Wd.biome === 'badlands') { g.lineTo(px - w * 0.55, py - h); g.lineTo(px + w * 0.5, py - h); g.lineTo(px + w, py); }
      else if (Wd.biome === 'desert') { g.quadraticCurveTo(px - w * 0.1, py - h * 0.9, px + w * 0.35, py - h * 0.55); g.quadraticCurveTo(px + w * 0.7, py - h * 0.2, px + w * 1.2, py); }
      else if (Wd.biome === 'snow') { g.lineTo(px - w * 0.2, py - h * 1.15); g.lineTo(px + w * 0.15, py - h * 0.85); g.lineTo(px + w * 0.35, py - h); g.lineTo(px + w, py); }
      else { g.quadraticCurveTo(px - w * 0.3, py - h * (Wd.biome === 'fields' ? 0.7 : 1.1), px, py - h * (Wd.biome === 'fields' ? 0.65 : 1)); g.quadraticCurveTo(px + w * 0.4, py - h * 0.9, px + w, py); }
      g.fillStyle = rgba(B.hill, 0.55); g.fill(); g.strokeStyle = rgba('#3a2a1e', 0.75); g.lineWidth = 1.1; g.stroke();
      if (Wd.biome === 'badlands') { for (const f of [0.35, 0.65]) { g.beginPath(); g.moveTo(px - w * (1 - f * 0.45), py - h * (1 - f)); g.lineTo(px + w * (0.5 + f * 0.5), py - h * (1 - f)); g.strokeStyle = rgba('#5a2a18', 0.45); g.stroke(); } }
      else { g.beginPath(); g.moveTo(px + 1, py - h + 2); g.quadraticCurveTo(px + w * 0.4, py - h * 0.5, px + w * 0.6, py - 1); g.strokeStyle = rgba('#3a2a1e', 0.35); g.stroke(); }
      g.restore();
      if (Wd.biome === 'snow') { g.save(); g.beginPath(); g.moveTo(px - w * 0.55, py - h * 0.6); g.lineTo(px - w * 0.2, py - h * 1.15); g.lineTo(px + w * 0.05, py - h * 0.9); g.lineTo(px - w * 0.1, py - h * 0.62); g.closePath(); g.fillStyle = '#fbfbf6'; g.fill(); g.restore(); }
    }
  }
  for (let i = 0; i < 46; i++) { const z = z0 + rnd() * (z1 - z0), side = rnd() < 0.5 ? -1 : 1, x = Wd.roadX(z) + side * range(rnd, 12, 30); tinyTree(g, B.tree, X(z), Y(x), rnd); }
  // fold creases
  for (const x of [CW / 3, CW * 2 / 3]) { g.fillStyle = 'rgba(120,90,50,0.16)'; g.fillRect(x - 1, 0, 2, CH); g.fillStyle = 'rgba(255,248,220,0.3)'; g.fillRect(x + 1, 0, 1.5, CH); }
  g.fillStyle = 'rgba(120,90,50,0.14)'; g.fillRect(0, CH / 2 - 1, CW, 2); g.fillStyle = 'rgba(255,248,220,0.28)'; g.fillRect(0, CH / 2 + 1, CW, 1.5);
  // the road: an inked double line with a dusty fill
  const road = []; for (let z = z0; z <= z1; z += 6) road.push([X(z), Y(Wd.roadX(z))]);
  const path = () => { g.beginPath(); road.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); };
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  path(); g.strokeStyle = '#3a2a1e'; g.lineWidth = 8; g.stroke();
  path(); g.strokeStyle = '#c89a5e'; g.lineWidth = 5; g.stroke();
  path(); g.setLineDash([6, 7]); g.strokeStyle = 'rgba(90,58,30,0.6)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]);
  g.restore();
  // labels never sit on each other: each tries a few spots and takes the first free one
  const taken = [];
  const free = (x0, y0, x1, y1) => x0 > 12 && x1 < CW - 12 && y0 > 10 && y1 < CH - 10 && !taken.some(r => x0 < r[2] && x1 > r[0] && y0 < r[3] && y1 > r[1]);
  const claim = (x0, y0, x1, y1) => taken.push([x0, y0, x1, y1]);
  const textW = (txt, size) => { g.save(); g.font = `bold ${size}px Georgia, 'Liberation Serif', serif`; const w = g.measureText(txt).width; g.restore(); return w; };
  const place = (x, y, w, h, offs) => { for (const [dx, dy] of offs) { const cx = x + dx, cy = y + dy; if (free(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)) { claim(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2); return [cx, cy]; } } const [dx, dy] = offs[0]; return [x + dx, y + dy]; };
  claim(14, 12, 250, 58); claim(CW - 74, 18, CW - 14, 84);
  // distance ticks every 100 m from camp
  for (let z = 0; z <= Wd.LEN; z += 100) {
    const px = X(z), py = Y(Wd.roadX(z));
    g.fillStyle = '#3a2a1e'; g.fillRect(px - 1, py + 5, 2, 7);
    inkText(g, String(z), px, py + 19, { size: 10, weight: 'normal' });
    claim(px - 10, py + 13, px + 10, py + 25);
  }
  for (const [x, y] of road) claim(x - 4, y - 4, x + 4, y + 4);
  // the stops: a medallion on the spot, the name beside it
  for (const p of Wd.pois) { const px = X(p.z), py = Y(p.x); claim(px - 13, py - 13, px + 13, py + 13); }
  for (const l of Wd.landmarks) { const px = X(l.z), py = Y(l.x); claim(px - 9, py - 11, px + 9, py + 6); }
  for (const p of Wd.pois) {
    const px = X(p.z), py = Y(p.x), name = POI_NAMES[p.type] || p.type, w = textW(name, 10.5) + 4;
    mapIcon(g, p.type, px, py, 0.95);
    const up = p.x > Wd.roadX(p.z) ? -1 : 1;
    const [lx, ly] = place(px, py, w, 12, [[0, 21 * up], [0, -21 * up], [w / 2 + 16, 0], [-w / 2 - 16, 0], [0, 33 * up], [0, -33 * up]]);
    inkText(g, name, lx, ly, { size: 10.5, color: '#1e3a5a' });
    if (p.type === 'crash') { const [mx, my] = place(lx, ly, 62, 10, [[0, 11 * Math.sign(ly - py || 1)], [0, -11], [0, 11]]); inkText(g, '(up the mesa)', mx, my, { size: 8.5, italic: true, weight: 'normal', color: '#1e3a5a' }); }
  }
  // obstacles in red ink: an X on the road, the sign off to one side on a dotted leader
  for (const o of Wd.obstacles) {
    const px = X(o.z), py = Y(Wd.roadX(o.z)), name = (OBST_NAMES[o.type] || o.type).toUpperCase(), w = Math.max(28, textW(name, 10)) + 4;
    const [cx, cy] = place(px, py, w, 32, [[0, -30], [0, 32], [0, -52], [0, 54], [w / 2 + 12, -26], [-w / 2 - 12, -26], [0, -74], [0, 76]]);
    const iy = cy + (cy < py ? 6 : -6), ly = cy + (cy < py ? -8 : 9);
    g.save(); g.strokeStyle = 'rgba(138,30,20,0.7)'; g.lineWidth = 1; g.setLineDash([2, 2]); g.beginPath(); g.moveTo(px, py + (cy < py ? -5 : 5)); g.lineTo(cx, iy + (cy < py ? 7 : -7)); g.stroke(); g.restore();
    obstacleIcon(g, o.type, cx, iy);
    inkText(g, name, cx, ly, { size: 10, color: '#8a1e14' });
    g.save(); g.strokeStyle = '#a8241a'; g.lineWidth = 2; g.beginPath(); g.moveTo(px - 4, py - 4); g.lineTo(px + 4, py + 4); g.moveTo(px + 4, py - 4); g.lineTo(px - 4, py + 4); g.stroke(); g.restore();
  }
  // landmarks
  for (const l of Wd.landmarks) {
    const px = X(l.z), py = Y(l.x);
    if (l.kind === 'skull') {
      g.save(); g.translate(px, py); g.fillStyle = '#f2ead8'; g.strokeStyle = '#3a2a1e'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(0, 0, 4, 5, 0, 0, TAU); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-3, -3); g.quadraticCurveTo(-9, -6, -8, -10); g.moveTo(3, -3); g.quadraticCurveTo(9, -6, 8, -10); g.stroke();
      g.fillStyle = '#3a2a1e'; g.fillRect(-2.2, -1.5, 1.5, 1.5); g.fillRect(0.8, -1.5, 1.5, 1.5); g.restore();
      claim(px - 9, py - 11, px + 9, py + 6);
      const [lx, ly] = place(px, py, 46, 10, [[0, 12], [0, -16], [30, 0], [-30, 0]]);
      inkText(g, 'cow skull', lx, ly, { size: 9, italic: true, weight: 'normal', color: '#5a3a6a' });
    } else {
      g.save(); g.translate(px, py); g.strokeStyle = '#3a2a1e'; g.lineWidth = 1;
      g.fillStyle = '#8a6a40'; g.fillRect(-0.8, -2, 1.6, 7); g.fillStyle = '#e8d4a0'; g.fillRect(-7, -7, 14, 6); g.strokeRect(-7, -7, 14, 6); g.restore();
      claim(px - 7, py - 7, px + 7, py + 5);
      const txt = `"${l.label}"`, w = textW(txt, 8.5) * 0.9 + 4;
      const [lx, ly] = place(px, py, w, 10, [[0, -13], [0, 12], [w / 2 + 10, -3], [-w / 2 - 10, -3], [0, -24], [0, 23]]);
      inkText(g, txt, lx, ly, { size: 8.5, italic: true, weight: 'normal', color: '#5a3a6a' });
    }
  }
  // camp and town
  mapIcon(g, 'camp', X(Math.max(z0 + 10, -40)), Y(Wd.roadX(-40)) + 30, 1.05);
  inkText(g, 'CAMP', X(Math.max(z0 + 10, -40)), Y(Wd.roadX(-40)) + 51, { size: 12, color: '#2d4a2a' });
  const tz = Math.min(z1 - 10, Wd.LEN + 60);
  mapIcon(g, 'town', X(tz), Y(Wd.roadX(tz)) + 30, 1.15);
  inkText(g, 'TOWN', X(tz), Y(Wd.roadX(tz)) + 53, { size: 12, color: '#2d4a2a' });
  // the title cartouche
  g.save();
  g.fillStyle = 'rgba(242,226,184,0.92)'; g.strokeStyle = '#3a2a1e'; g.lineWidth = 1.5;
  g.beginPath(); g.roundRect(14, 12, 236, 46, 6); g.fill(); g.stroke();
  g.lineWidth = 0.7; g.beginPath(); g.roundRect(18, 16, 228, 38, 4); g.stroke();
  g.restore();
  inkText(g, `Day ${Wd.day}: ${Wd.biomeName || 'The Road'}`, 132, 28, { size: 14, halo: null });
  inkText(g, `${Wd.LEN} m to town`, 132, 45, { size: 11, weight: 'normal', italic: true, halo: null });
  inkText(g, '(no GPS. ask the driver what the odometer says.)', CW - 14, CH - 18, { size: 9.5, italic: true, weight: 'normal', align: 'right', color: '#5a4030' });
  // compass rose and a scale bar
  compassRose(g, CW - 44, 52, 26);
  const sb = (X(100) - X(0));
  g.fillStyle = '#3a2a1e'; g.fillRect(20, CH - 30, sb, 3); g.fillStyle = '#f2e2b8'; g.fillRect(20 + sb / 2, CH - 29.5, sb / 2, 2);
  inkText(g, '100 m', 20 + sb / 2, CH - 40, { size: 9, weight: 'normal' });
  // burnt, ragged edges: char outside a jagged line, a scorched brown halo inside it
  const edge = [];
  const bites = Array.from({ length: 4 }, (_, k) => ({ side: k + 1, at: range(rnd, 0.15, 0.85), w: range(rnd, 24, 60), d: range(rnd, 6, 14) }));
  const jag = (t, k) => {
    let j = 6 + 2.6 * Math.sin(t * 0.045 + k * 1.7) + 1.8 * Math.sin(t * 0.13 + k * 2.3) + 1.1 * Math.sin(t * 0.41 + k) + range(rnd, 0, 1.2);
    for (const b of bites) if (b.side === k) { const L = k % 2 ? CW : CH, d = Math.abs(t - b.at * L) / b.w; if (d < 1) j += b.d * (1 - d * d); }
    return j;
  };
  for (let x = 0; x <= CW; x += 4) edge.push([x, jag(x, 1)]);
  for (let y = 0; y <= CH; y += 4) edge.push([CW - jag(y, 2), y]);
  for (let x = CW; x >= 0; x -= 4) edge.push([x, CH - jag(x, 3)]);
  for (let y = CH; y >= 0; y -= 4) edge.push([jag(y, 4), y]);
  g.save();
  g.beginPath(); g.rect(0, 0, CW, CH); edge.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath();
  g.fillStyle = '#2e1e14'; g.fill('evenodd');
  g.restore();
  g.save(); g.filter = 'blur(3px)'; g.strokeStyle = 'rgba(110,60,24,0.75)'; g.lineWidth = 9; g.beginPath(); edge.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.stroke(); g.restore();
  g.save(); g.strokeStyle = 'rgba(40,24,14,0.9)'; g.lineWidth = 2; g.beginPath(); edge.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.stroke(); g.restore();
  if (W) mapCache.set(W, cv);
  return cv;
}

// a stand-in leg for previews (the real one comes from shared/world.js)
function demoWorld() {
  return {
    seed: 1, day: 1, LEN: 900, Z0: -90, Z1: 1075, biome: 'meadow', biomeName: 'The Westmeadow Road',
    roadX: z => 22 * Math.sin(z / 95) + 7 * Math.sin(z / 33),
    pois: [{ type: 'gas', z: 140 }, { type: 'yard', z: 300 }, { type: 'crash', z: 470 }, { type: 'junk', z: 640 }, { type: 'dino', z: 790 }].map((p, i) => ({ ...p, x: 22 * Math.sin(p.z / 95) + 7 * Math.sin(p.z / 33) + (i % 2 ? -18 : 20) })),
    obstacles: [{ type: 'mud', z: 220, id: 0 }, { type: 'boulder', z: 400, id: 1 }, { type: 'grade', z: 560, id: 2 }],
    landmarks: [{ kind: 'billboard', z: 250, x: 30, label: 'LUCKY SLOP' }, { kind: 'skull', z: 705, x: -30 }],
  };
}

// ---- building ------------------------------------------------------------------------------------

const geoCache = new Map();
const paperMats = new WeakMap();
let demoPaper = null;
function paperMat(W) {
  if (!W) return demoPaper ||= new THREE.MeshLambertMaterial({ map: canvasTex(mapCanvas(null)) });
  if (!paperMats.has(W)) paperMats.set(W, new THREE.MeshLambertMaterial({ map: canvasTex(mapCanvas(W)) }));
  return paperMats.get(W);
}
let paperGeo = null;
function mapPaper() {
  if (paperGeo) return paperGeo;
  const g = new THREE.PlaneGeometry(0.384, 0.27, 6, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const k = Math.round((p.getX(i) / 0.384 + 0.5) * 6); p.setZ(i, (k % 2 ? 0.0035 : 0) + (k === 3 ? 0.002 : 0)); }
  g.rotateX(-Math.PI / 2); g.translate(0, 0.0, 0);
  g.computeVertexNormals();
  return paperGeo = g;
}

export function buildProp(type, W) {
  let mesh;
  if (type === 'boulder') {
    const biome = W?.biome && ['meadow', 'fields', 'snow', 'badlands', 'desert'].includes(W.biome) ? W.biome : 'meadow';
    const key = 'boulder-' + biome;
    if (!geoCache.has(key)) geoCache.set(key, boulderGeo(biome));
    mesh = new THREE.Mesh(geoCache.get(key), painted(`loot_boulder_${biome}`, { repeat: [2, 1], vertexColors: true }));
  } else {
    const make = BUILDERS[type];
    if (!make) { mesh = new THREE.Mesh(rbox(0.3, 0.3, 0.3, 0.04), lootMat()); }
    else {
      if (!geoCache.has(type)) geoCache.set(type, make());
      mesh = new THREE.Mesh(geoCache.get(type), lootMat());
    }
    if (type === 'map') {
      const g = new THREE.Group();
      g.add(mesh);
      const paper = new THREE.Mesh(mapPaper(), paperMat(W));
      paper.position.y = -0.003;
      g.add(paper);
      return shadowy(g);
    }
  }
  return shadowy(mesh);
}

// ---- preview (tools/preview.mjs) ----
export const PREVIEW = {
  ...Object.fromEntries(Object.keys(LOOT).filter(k => k !== 'map' && k !== 'boulder').map(k => [k, () => buildProp(k, null)])),
  boulder: (o = {}) => buildProp('boulder', { biome: o.biome || 'meadow' }),
  map: () => buildProp('map', null),
  // every item blown up to ~1.6 m, for judging the paint and the shape up close
  ...Object.fromEntries(Object.keys(LOOT).filter(k => k !== 'boulder').map(k => [`x_${k}`, () => {
    const o = buildProp(k, null), bb = new THREE.Box3().setFromObject(o), s = bb.getSize(new V3());
    const g = new THREE.Group(); g.add(o); o.scale.setScalar(1.6 / Math.max(s.x, s.y, s.z)); return g;
  }])),
  // the map sheet standing up, big, for reading it
  mapsheet: (o = {}) => { const W = { ...demoWorld(), biome: o.biome || 'meadow', day: ['meadow', 'fields', 'snow', 'badlands', 'desert'].indexOf(o.biome || 'meadow') + 1 }; const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.19), new THREE.MeshBasicMaterial({ map: canvasTex(mapCanvas(W)), side: THREE.DoubleSide })); m.position.y = 0.7; const g = new THREE.Group(); g.add(m); return g; },
};
