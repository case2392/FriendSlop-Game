// What the loot looks like: chunky, smooth-shaded props in the WoW Classic manner, the detail
// hand-painted into one texture atlas (client/js/paint/props.js). Every loot item is ONE mesh with
// ONE material, so a prop costs one draw call (plus its shadow); its geometry is built once per
// type and shared by every copy. Each mesh is centered on, and fills, its physics collider
// (shared/loot.js LOOT[type].shape). Every face that can land facing the camera is painted:
// loot tumbles, so backs and flanks matter as much as fronts.
//
// API: buildProp(type, W) → Object3D · mapCanvas(W) → the paper road map (canvas) · PREVIEW
//      prewarm(W) → paints the atlas and builds the geometry in idle time (optional)
import { THREE, tex, painted, canvasTex, shadowy } from './gfx.js';
import { LOOT } from '/shared/loot.js';
import { REGIONS as R, sub, VASE_PROFILE, GUITAR_OUTLINE, TV_LAYOUT, TIRE_V, SIGN, GNOME, SLOT_CROWN, KEY_LABELS, DINO, BOULDER_BANDS } from './paint/props.js';
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

// A box with rounded edges (m facets per half-quarter, evenly spaced in angle), its faces tagged for
// box UVs by the source cube's normals.
function rbox(w, h, d, r = 0.02, m = 2) {
  const H = [w / 2, h / 2, d / 2];
  r = Math.max(0, Math.min(r, ...H.map(x => x * 0.92)));
  const N = 2 * m + 1;
  const axis = hh => { const pos = []; for (let k = 0; k <= m; k++) pos.push(hh - r + r * Math.tan(k / m * Math.PI / 4)); return [...pos.slice().reverse().map(x => -x), ...pos]; };
  const C = H.map(axis);
  const g = new THREE.BoxGeometry(2, 2, 2, N, N, N);
  const p = g.attributes.position, v = new V3();
  for (let i = 0; i < p.count; i++) {
    const q = [p.getX(i), p.getY(i), p.getZ(i)].map((c, k) => C[k][Math.round((c + 1) / 2 * N)]);
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
// a tapered rod from a to b
function limb(a, b, r0, r1 = r0, segs = 10) {
  const A = new V3(...a), d = new V3(...b).sub(A), L = d.length();
  const g = lathe([[0, 0], [r0, 0], [r0 * 1.02, L * 0.5], [r1, L], [0, L]], segs);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d.normalize()));
  g.translate(A.x, A.y, A.z);
  return g;
}
const tube = (pts, r, n = 16, radial = 6) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new V3(...p))), n, r, radial, false);
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
    pos.push(0, (s.top + s.bot) / 2, s.z + (front ? 0.004 : -0.004)); uv.push(0.5, front ? 1 : 0);
    for (let i = 0; i < segs; i++) { const a = j * W + i, b = a + 1; if (front) idx.push(ci, a, b); else idx.push(ci, b, a); }
  };
  cap(0, false); cap(st.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
// The dino's loft: superelliptic sections [{ z, w, top, bot }] along z; u round the section with
// 0.5 on top and the seam underneath, v linear in z from o.v[0] (first section) to o.v[1] (last).
// o.caps: [back, front]; o.inside turns every face inward (a cavity seen from within).
const secPoint = (s, u, pw) => { const ph = (u - 0.5) * TAU, S = t => Math.sign(t) * Math.pow(Math.abs(t), 2 / pw); return [s.w * S(Math.sin(ph)), (s.top + s.bot) / 2 + (s.top - s.bot) / 2 * S(Math.cos(ph)), s.z]; };
function secAt(st, z) {
  let i = 1; while (i < st.length - 1 && st[i].z < z) i++;
  const a = st[i - 1], b = st[i], f = Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z || 1)));
  return { z, w: a.w + (b.w - a.w) * f, top: a.top + (b.top - a.top) * f, bot: a.bot + (b.bot - a.bot) * f };
}
function loftU(st, { segs = 28, pw = 2.4, v = [0, 1], caps = [true, true], inside = false } = {}) {
  const pos = [], uv = [], idx = [], W = segs + 1, za = st[0].z, zb = st[st.length - 1].z;
  for (const s of st) for (let i = 0; i <= segs; i++) { pos.push(...secPoint(s, i / segs, pw)); uv.push(i / segs, v[0] + (v[1] - v[0]) * (s.z - za) / (zb - za || 1)); }
  const tri = (a, b, c) => inside ? idx.push(a, c, b) : idx.push(a, b, c);
  for (let j = 0; j < st.length - 1; j++) for (let i = 0; i < segs; i++) { const a = j * W + i, b = a + 1, c = a + W + 1, d = a + W; tri(a, c, b); tri(a, d, c); }
  const cap = (j, front) => {
    const s = st[j], ci = pos.length / 3;
    pos.push(0, (s.top + s.bot) / 2, s.z); uv.push(0.5, uv[j * W * 2 + 1]);
    for (let i = 0; i < segs; i++) { const a = j * W + i, b = a + 1; if (front) tri(ci, b, a); else tri(ci, a, b); }
  };
  if (caps[0]) cap(0, false);
  if (caps[1]) cap(st.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  return g;
}
// a rounded peg (a tooth) from base a toward tip b
function peg(a, b, r) {
  const A = new V3(...a), d = new V3(...b).sub(A), L = d.length();
  const g = lathe([[0, -r * 0.4], [r * 0.9, -r * 0.3], [r, L * 0.3], [r * 0.9, L * 0.62], [r * 0.62, L * 0.86], [r * 0.25, L * 0.98], [0, L]], 8);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), d.normalize()));
  g.translate(A.x, A.y, A.z);
  return g;
}

// A rounded pane bulging toward +z (a CRT face): a grid pushed out to a superellipse, uv 0..1.
function squirclePane(w, h, bulge = 0.02, n = 5, nx = 12, ny = 10) {
  const g = new THREE.PlaneGeometry(2, 2, nx, ny), p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i);
    const m = Math.max(Math.abs(x), Math.abs(y));
    if (m > 1e-6) { const s = Math.pow(Math.abs(x) ** n + Math.abs(y) ** n, 1 / n); x *= m / s; y *= m / s; }
    p.setXYZ(i, x * w / 2, y * h / 2, bulge * (1 - m * m));
    uv.setXY(i, (x + 1) / 2, (y + 1) / 2);
  }
  return g;
}
// A shape's flat face (z = 0, facing +z)
function shapeFace(pts) { return new THREE.ShapeGeometry(new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, y))), 1); }
// the band round a shape's outline, from z0 to z1: u along the outline (0..1), v across (0 at z0)
function shapeBand(pts, z0, z1, center) {
  const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const T = L[L.length - 1], pos = [], uv = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1], ua = L[i] / T, ub = L[i + 1] / T;
    const q = [[ax, ay, z0, ua, 0], [bx, by, z0, ub, 0], [bx, by, z1, ub, 1], [ax, ay, z1, ua, 1]];
    const e = new V3(bx - ax, by - ay, 0), f = new V3(0, 0, z1 - z0), n = e.clone().cross(f), m = new V3((ax + bx) / 2 - center[0], (ay + by) / 2 - center[1], 0);
    const order = n.dot(m) > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (const k of order) { pos.push(q[k][0], q[k][1], q[k][2]); uv.push(q[k][3], q[k][4]); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// Collects parts (each with its own region, UVs, transform and tint) into one geometry.
class Build {
  constructor() { this.parts = []; }
  // o.uv: 'keep' (the geometry's 0..1 uvs) | 'box' (planar per face, faces: {px,nx,py,ny,pz,nz}) |
  //       'planar' (axis: 'x' | 'y' | 'z'; bounds = [minA, minB, maxA, maxB]) | 'fn' (o.fn(x,y,z,nx,ny,nz) → [u,v])
  // o.at: Matrix4; o.space: 'final' projects after placing ('fn' always does); o.box: [x0,y0,z0,x1,y1,z1]
  // overrides the box projection's bounds; o.tint: number | [r,g,b]; o.crease: degrees; o.swap; o.warp(v)
  add(geo, reg, o = {}) {
    const { uv = 'keep', at = null, tint = 1, crease = 50, faces = null, swap = false, warp = null, axis = 'z', bounds = null, flipU = false, space = 'local', box = null, fn = null } = o;
    const gg = geo.index ? geo.toNonIndexed() : geo.clone();
    if (!gg.attributes.normal && uv === 'box') gg.computeVertexNormals();
    const p = gg.attributes.position, n = p.count;
    if (warp) { const t = new V3(); for (let i = 0; i < n; i++) { t.fromBufferAttribute(p, i); warp(t); p.setXYZ(i, t.x, t.y, t.z); } }
    const early = at && (space === 'final' || uv === 'fn');
    if (early) gg.applyMatrix4(at);
    const UV = new Float32Array(n * 2);
    const src = gg.attributes.uv, nrm = gg.attributes.normal;
    gg.computeBoundingBox();
    const mn = box ? new V3(box[0], box[1], box[2]) : gg.boundingBox.min, sz = box ? new V3(box[3] - box[0], box[4] - box[1], box[5] - box[2]) : gg.boundingBox.getSize(new V3());
    let smooth = null;
    if (uv === 'fn') { const t = new THREE.BufferGeometry(); t.setAttribute('position', p.clone()); creaseNormals(t, 85); smooth = t.attributes.normal; }
    const map = (rg, u, v) => {
      if (swap) [u, v] = [v, 1 - u];
      if (flipU) u = 1 - u;
      return [rg.u0 + (rg.u1 - rg.u0) * u, rg.v0 + (rg.v1 - rg.v0) * v];
    };
    const a = new V3(), b = new V3(), c = new V3();
    for (let f = 0; f < n / 3; f++) {
      let rg = reg, ax = axis, sg = 1;
      if (uv === 'box') {
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
        else if (uv === 'fn') [u, v] = fn(x, y, z, smooth.getX(i), smooth.getY(i), smooth.getZ(i));
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
    if (at && !early) gg.applyMatrix4(at);
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
  // merge, then darken toward the bottom (contact shadow) and a whisper of top light
  done({ ao = 0.32, aoH = 0.3, fit = null } = {}) {
    const g = mergeGeometries(this.parts, false);
    if (fit) {     // stretch to fill the collider box [hx, hy, hz]
      g.computeBoundingBox();
      const b = g.boundingBox, c = b.getCenter(new V3()), sz = b.getSize(new V3());
      const k = [2 * fit[0] / sz.x, 2 * fit[1] / sz.y, 2 * fit[2] / sz.z];
      g.translate(-c.x, -c.y, -c.z); g.scale(...k);
      const nr = g.attributes.normal;
      for (let i = 0; i < nr.count; i++) { const x = nr.getX(i) / k[0], y = nr.getY(i) / k[1], z = nr.getZ(i) / k[2], L = Math.hypot(x, y, z) || 1; nr.setXYZ(i, x / L, y / L, z / L); }
    }
    g.computeBoundingBox();
    const y0 = g.boundingBox.min.y, H = Math.max(0.05, g.boundingBox.max.y - y0), k = Math.min(aoH, H * 0.45);
    const p = g.attributes.position, c = g.attributes.color, nr = g.attributes.normal;
    for (let i = 0; i < p.count; i++) {
      const t = Math.min(1, Math.max(0, (p.getY(i) - y0) / k)), s = 1 - ao * (1 - t * t * (3 - 2 * t));
      const up = 0.94 + 0.06 * nr.getY(i);
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
const IRON = [1.25, 1.2, 1.15];
const RUST = [1.6, 0.85, 0.55];

const BUILDERS = {
  gnome() {
    const B = new Build();
    const hat = R.gnomehat, coat = R.gnomecoat, beard = R.gnomebeard, face = R.gnomeface;
    // big boots poking out under the coat
    for (const sx of [-1, 1]) B.add(sphere(1, 12, 8), R.boot, { at: mat4(sx * 0.054, -0.21, 0.032, 0, sx * 0.15, 0, [0.05, 0.03, 0.082]) });
    // a fat bell of a coat; the belt lands on GNOME.belt in v
    B.add(lathe([[0, -0.205, 0], [0.098, -0.205, 0.02], [0.114, -0.19, 0.08], [0.118, -0.15, 0.2], [0.112, -0.115, 0.32], [0.109, -0.105, GNOME.belt[0]], [0.107, -0.08, GNOME.belt[1]],
      [0.098, -0.05, 0.56], [0.084, -0.02, 0.72], [0.06, 0.005, 0.88], [0.035, 0.015, 0.96], [0, 0.02, 1]], 16), coat, { at: mat4(0, 0, 0, 0, 0, 0, [1.06, 1, 1.04]) });
    B.add(new THREE.TorusGeometry(0.054, 0.022, 8, 20), R.gnomefur, { at: mat4(0, 0.006, 0.004, Math.PI / 2, 0, 0) });
    // arms round the belly; chunky leather mittens with a thumb, half in the beard
    for (const sx of [-1, 1]) {
      B.add(sphere(1, 10, 7), coat, { at: mat4(sx * 0.088, -0.012, 0.0, 0, 0, 0, [0.038, 0.037, 0.037]) });
      B.add(limb([sx * 0.09, -0.016, 0.004], [sx * 0.058, -0.09, 0.084], 0.032, 0.026, 10), coat);
      B.add(sphere(1, 12, 8), R.boot, { at: mat4(sx * 0.05, -0.1, 0.1, 0.3, sx * -0.3, 0, [0.042, 0.032, 0.036]) });
      B.add(sphere(1, 8, 6), R.boot, { at: mat4(sx * 0.03, -0.083, 0.112, 0.4, 0, sx * 0.5, [0.016, 0.021, 0.016]) });
    }
    // a big round head, ears, a bulbous rosy nose
    B.add(sphere(GNOME.headR, 18, 12), face, { at: mat4(0, 0.062, 0.01) });
    for (const sx of [-1, 1]) B.add(sphere(1, 8, 6), R.skin, { at: mat4(sx * 0.074, 0.062, 0.006, 0, sx * 0.3, 0, [0.013, 0.024, 0.01]), tint: 0.9 });
    B.add(sphere(0.03, 14, 10), R.skin, { at: mat4(0, 0.044, 0.086, 0.2, 0, 0, [1, 0.95, 1]) });
    // the beard: a broad wedge from the cheeks to the belt, lying on the chest; a drooping mustache
    const locks = v => {     // the locks in the geometry too: ridges where the paint puts them, converging to the tip
      const r = Math.hypot(v.x, v.z); if (r < 1e-6) return;
      const u = ((Math.atan2(-v.x, -v.z) / TAU) % 1 + 1) % 1, t = Math.min(1, Math.max(0, (0.047 - v.y) / 0.165)), per = 0.075 * (1 - 0.55 * t * t);
      if (Math.abs(u - 0.5) > 0.3) return;
      const k = 1 + 0.1 * (0.5 + 0.5 * Math.cos(TAU * ((u - 0.5) / per - 0.5))) - 0.05;
      v.x *= k; v.z *= k;
    };
    B.add(lathe([[0, -0.118, 0], [0.018, -0.1, 0.1], [0.032, -0.08, 0.22], [0.042, -0.062, 0.35], [0.054, -0.037, 0.5], [0.062, -0.012, 0.65], [0.07, 0.022, 0.85], [0.062, 0.04, 0.95], [0, 0.047, 1]], 64), beard,
      { at: mat4(0, 0.002, 0.074, -0.3, 0, 0, [1.2, 1, 0.56]), warp: locks, crease: 70 });
    for (const sx of [-1, 1]) B.add(sphere(1, 10, 7), sub(beard, 0.3, 0.02, 0.7, 0.5), { at: mat4(sx * 0.028, 0.034, 0.08, 0.1, sx * 0.35, sx * -1.05, [0.034, 0.015, 0.019]), tint: 1.05 });
    // the hat, its top flopping over sideways at the crease, and a fat rolled brim
    // (the whole hat tips back 9°, brim up at the front, so the face isn't lost in its shadow)
    const bd = new V3(0.85, 0, 0.3).normalize(), axisK = new V3(bd.z, 0, -bd.x), pivot = 0.182;
    const flop = v => {
      const t = Math.min(1, Math.max(0, (v.y - pivot + 0.01) / 0.05)), a = 1.32 * t * t * (3 - 2 * t);
      if (a > 0) { rot.makeRotationAxis(axisK, a); v.y -= pivot - 0.01; v.applyMatrix4(rot); v.y += pivot - 0.01; }
      return v;
    };
    const rot = new THREE.Matrix4(), tip = new THREE.Matrix4().makeTranslation(0, 0.106, 0).multiply(new THREE.Matrix4().makeRotationX(-0.16)).multiply(new THREE.Matrix4().makeTranslation(0, -0.106, 0));
    B.add(lathe([[0.08, 0.1, 0], [0.079, 0.113, 0.1], [0.067, 0.14, 0.28], [0.053, 0.162, 0.45], [0.042, pivot, GNOME.crease], [0.031, 0.204, 0.72], [0.019, 0.228, 0.85], [0.009, 0.248, 0.95], [0, 0.258, 1]], 18), hat, {
      at: tip,
      warp: flop,
    });
    const tp = flop(new V3(0, 0.25, 0)).applyMatrix4(tip);
    B.add(sphere(1, 10, 7), R.gnomefur, { at: mat4(tp.x, tp.y, tp.z, 0, 0, 0, [0.016, 0.016, 0.016]) });
    B.add(new THREE.TorusGeometry(0.078, 0.017, 8, 24), sub(hat, 0, 0.88, 1, 1), { at: tip.clone().multiply(mat4(0, 0.106, 0, Math.PI / 2, 0, 0)) });
    return B.done({ ao: 0.28, aoH: 0.12 });
  },

  lamp() {
    const B = new Build();
    // a heavy cast-bronze foot, a ribbed stem (ridges catch the light band, grooves the patina)
    const base = [[0, -0.3, 0.02], [0.15, -0.3, 0.04], [0.155, -0.292, 0.1], [0.148, -0.282, 0.78], [0.125, -0.274, 0.6], [0.09, -0.262, 0.5], [0.06, -0.245, 0.7], [0.046, -0.226, 0.4]];
    for (let k = 0; k < 8; k++) { const y = -0.215 + k * 0.022; base.push([0.031, y, 0.8], [0.025, y + 0.011, 0.35]); }
    base.push([0.046, -0.035, 0.82], [0.04, -0.018, 0.6], [0.02, -0.008, 0.45], [0.016, 0.05, 0.5], [0.022, 0.06, 0.75], [0, 0.065, 0.75]);
    B.add(lathe(base, 14), R.bronze);
    // a wide, low Tiffany dome with a scalloped rim
    const shade = [[0.17, -0.02, 0.0], [0.166, 0.0, 0.08], [0.158, 0.03, 0.2], [0.14, 0.075, 0.38], [0.112, 0.12, 0.56], [0.078, 0.155, 0.72], [0.045, 0.178, 0.86], [0.026, 0.188, 0.95], [0.02, 0.19, 1.0]];
    const scallop = v => { if (v.y < -0.012) { const a = Math.atan2(v.x, v.z); v.y -= 0.016 * Math.pow(0.5 + 0.5 * Math.cos(a * 12), 1.5); } };
    B.add(lathe(shade, 48), R.glass, { warp: scallop });
    B.add(lathe(shade.map(([r, y, v]) => [r - 0.005, y + 0.002, v]).reverse(), 48), R.glass, { tint: 0.55, warp: scallop });
    B.add(lathe([[0.03, 0.186], [0.036, 0.196], [0.024, 0.21], [0.012, 0.232], [0.006, 0.25]], 12), R.bronze, { tint: 1.1 });
    B.add(sphere(0.02, 10, 7), R.bronze, { at: mat4(0, 0.268, 0), tint: 1.15 });
    B.add(sphere(0.042, 10, 7), R.bulb, { at: mat4(0, 0.09, 0) });
    return B.done({ ao: 0.25, aoH: 0.1 });
  },

  toaster() {
    const B = new Build();
    const SIDE = sub(R.steel, 0, 0, 1, 2 / 3), TOP = sub(R.steel, 0, 2 / 3, 1, 1);
    // brass domed feet
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add(sphere(1, 10, 6), R.brass, { at: mat4(sx * 0.1, -0.097, sz * 0.056, 0, 0, 0, [0.022, 0.016, 0.022]), tint: [1.1, 1, 0.85] });
    // the chrome body, well rounded, painted as a reflection
    B.add(rbox(0.27, 0.19, 0.17, 0.052, 3), SIDE, { uv: 'box', faces: { py: TOP, ny: sub(R.steel, 0, 0.55, 1, 0.66) } });
    // three brass art-deco ribs down each long side (stopping short of the knob on the front)
    for (const sz of [-1, 1]) for (const y of [-0.045, -0.024, -0.003]) {
      const L = sz > 0 ? 0.15 : 0.21, x = sz > 0 ? -0.03 : 0;
      B.add(rbox(L, 0.009, 0.01, 0.004, 1), R.brass, { uv: 'box', at: mat4(x, y, sz * 0.086) });
    }
    // the slots: dark openings in brass trim rings, two slices of toast
    const ring = new THREE.Shape([[-0.108, -0.024], [0.108, -0.024], [0.108, 0.024], [-0.108, 0.024]].map(([x, y]) => new THREE.Vector2(x, y)));
    ring.holes.push(new THREE.Path([[-0.099, -0.016], [-0.099, 0.016], [0.099, 0.016], [0.099, -0.016]].map(([x, y]) => new THREE.Vector2(x, y))));
    const ringG = new THREE.ExtrudeGeometry(ring, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 1 });
    for (const sz of [-1, 1]) {
      B.add(rbox(0.2, 0.012, 0.032, 0.005, 1), R.rubber, { uv: 'box', at: mat4(0, 0.09, sz * 0.038), tint: 0.6 });
      B.add(ringG, R.brass, { uv: 'box', at: mat4(0, 0.094, sz * 0.038, -Math.PI / 2, 0, 0) });
      B.add(rbox(0.16, 0.06, 0.02, 0.012, 2), R.toast, { uv: 'box', at: mat4(0.004 * sz, 0.087, sz * 0.038, 0, 0, sz * 0.03) });
    }
    // the lever (a honey-wood knob) on the end
    B.add(rbox(0.008, 0.09, 0.022, 0.003, 1), R.rubber, { uv: 'box', at: mat4(0.136, 0.0, 0), tint: 0.6 });
    B.add(rbox(0.026, 0.026, 0.04, 0.01, 2), R.honey, { uv: 'box', at: mat4(0.148, 0.03, 0) });
    // a knurled oxblood bakelite knob with a cream pointer
    const knurl = v => { const r = Math.hypot(v.x, v.z); if (r > 0.012 && v.y < 0.02) { const a = Math.atan2(v.x, v.z), k = 1 + 0.06 * Math.cos(a * 24); v.x *= k; v.z *= k; } };
    B.add(lathe([[0, 0], [0.019, 0], [0.023, 0.004], [0.023, 0.016], [0.02, 0.021], [0.012, 0.024], [0, 0.025]], 48), R.bakelite, { at: mat4(0.082, -0.03, 0.083, Math.PI / 2, 0, 0), warp: knurl });
    B.add(rbox(0.004, 0.016, 0.004, 0.0015, 1), R.ivory, { uv: 'box', at: mat4(0.082, -0.022, 0.108, 0, 0, -0.5) });
    // the riveted brass maker's plate
    B.add(rbox(0.11, 0.034, 0.004, 0.0015, 1), R.brass, { uv: 'box', faces: { pz: R.toastplate }, at: mat4(-0.04, 0.042, 0.0865) });
    return B.done({ ao: 0.22, aoH: 0.06 });
  },

  register() {
    const B = new Build();
    // the oak drawer
    B.add(rbox(0.42, 0.075, 0.38, 0.014), R.wood, { uv: 'box', faces: { pz: R.till }, at: mat4(0, -0.052, 0) });
    // a sloped brass key deck, engraved (its top rises 2.8 cm from the front edge to the back)
    const deckY = z => -0.005 + (0.095 - z) / 0.27 * 0.028;
    B.add(rbox(0.38, 0.03, 0.27, 0.01), R.brass, { uv: 'box', faces: { py: R.regdeck }, at: mat4(0, -0.004, -0.04), warp: v => { if (v.y > 0) v.y += (0.095 - (v.z - 0.04)) / 0.27 * 0.028 - 0.01; } });
    // keys: staggered rows of ivory caps with painted numerals, on visible brass stems
    let ki = 0;
    for (let j = 0; j < 3; j++) {
      const n = j === 1 ? 5 : 6, z = 0.06 - j * 0.062;
      for (let i = 0; i < n && ki < 16; i++, ki++) {
        const x = -0.15 + i * 0.06 + (j === 1 ? 0.03 : 0), lift = j * 0.007, y = deckY(z) + lift, rr = (j === 2 ? 0.017 : 0.0155) * 1.2;
        B.add(cyl(0.005, 0.024 + lift * 2, 8), R.brass, { at: mat4(x, y + 0.008 - lift, z), tint: 0.85 });
        B.add(lathe([[rr * 0.9, 0, 0.1], [rr, 0.004, 0.4], [rr * 0.98, 0.01, 0.8]], 14), R.ivory, { at: mat4(x, y + 0.019, z) });
        B.add(new THREE.TorusGeometry(rr * 0.99, 0.0018, 4, 12), R.brass, { at: mat4(x, y + 0.029, z, Math.PI / 2, 0, 0), tint: 1.1 });
        const col = ki % 8, row = Math.floor(ki / 8), rk = rr * 0.98;
        B.add(lathe([[rk, 0], [rk * 0.8, 0.0035], [rk * 0.5, 0.0058], [0, 0.0066]], 12), sub(R.keys, col / 8, row / 2, (col + 1) / 8, (row + 1) / 2), { uv: 'planar', axis: 'y', bounds: [-rk * 1.2, -rk * 1.2, rk * 1.2, rk * 1.2], at: mat4(x, y + 0.029, z), crease: 80 });
      }
    }
    // the arched brass crest at the back with the $ 25 tab in its window
    const crest = [[-0.13, 0], [0.13, 0], [0.13, 0.032]];
    for (let k = 1; k <= 12; k++) { const a = k / 12 * Math.PI; crest.push([0.13 * Math.cos(a), 0.032 + 0.046 * Math.sin(a)]); }
    const cG = new THREE.ExtrudeGeometry(new THREE.Shape(crest.map(([x, y]) => new THREE.Vector2(x, y))), { depth: 0.014, bevelEnabled: true, bevelThickness: 0.003, bevelSize: 0.003, bevelSegments: 1, curveSegments: 6 });
    B.add(cG, R.brass, { uv: 'box', faces: { pz: R.crest, nz: R.regdeck }, box: [-0.13, 0, 0, 0.13, 0.078, 0.014], at: mat4(0, 0.009, -0.172) });
    // the crank on the right
    B.add(cyl(0.012, 0.024, 10), R.brass, { at: mat4(0.205, -0.045, 0.06, 0, 0, Math.PI / 2) });
    B.add(rbox(0.01, 0.06, 0.014, 0.004, 1), R.brass, { uv: 'box', at: mat4(0.214, -0.02, 0.06) });
    B.add(sphere(0.012, 8, 6), R.honey, { at: mat4(0.216, 0.012, 0.06) });
    return B.done({ ao: 0.25, aoH: 0.05 });
  },

  trophy() {
    const B = new Build();
    B.add(lathe([[0, -0.22, 0], [0.083, -0.22, 0.08], [0.088, -0.215, 0.14], [0.089, -0.208, 0.2], [0.088, -0.18, 0.45], [0.083, -0.176, 0.5], [0.079, -0.172, 0.56], [0.07, -0.15, 0.78], [0.058, -0.145, 0.86], [0, -0.145, 1]], 20), R.turned, { crease: 60 });
    B.add(rbox(0.09, 0.03, 0.006, 0.003, 1), R.brass, { uv: 'box', faces: { pz: sub(R.plaque, 0, 0, 0.5, 1) }, at: mat4(0, -0.196, 0.087) });
    B.add(lathe([[0.046, -0.145, 0.0], [0.042, -0.136, 0.06], [0.02, -0.12, 0.12], [0.013, -0.09, 0.18], [0.026, -0.076, 0.22], [0.028, -0.066, 0.25], [0.013, -0.05, 0.3], [0.015, -0.02, 0.36],
      [0.03, -0.005, 0.42], [0.054, 0.012, 0.5], [0.068, 0.045, 0.6], [0.072, 0.09, 0.7], [0.074, 0.118, 0.8], [0.079, 0.128, 0.85], [0.071, 0.128, 0.88], [0.064, 0.105, 0.94], [0, 0.085, 1]], 24), R.gilt);
    for (const sx of [-1, 1]) B.add(new THREE.TorusGeometry(0.022, 0.0065, 6, 12, Math.PI), sub(R.gilt, 0, 0.3, 1, 0.45), { at: mat4(sx * 0.068, 0.07, 0, 0, 0, sx > 0 ? -Math.PI / 2 : Math.PI / 2) });
    B.add(sphere(0.043, 16, 12), R.ball, { at: mat4(0, 0.172, 0, -0.45, 0.2, 0), crease: 80 });
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
    B.add(rbox(0.6, 0.03, 0.44, 0.01), R.wood, { uv: 'box', at: mat4(0, -0.285, 0.0), tint: 0.75 });
    // the cabinet, tapering toward the tube at the back; the back is its own painted panel
    const taper = v => { const f = Math.max(0, (0.05 - v.z) / 0.31); v.x *= 1 - 0.2 * f; v.y = v.y * (1 - 0.16 * f) - 0.02 * f; };
    B.add(rbox(0.68, 0.47, 0.52, 0.04), R.wood, { uv: 'box', faces: { pz: R.tvfront, nz: R.tvback }, at: mat4(0, -0.035, 0.02), warp: taper });
    // the tube's bulge out of the back
    B.add(lathe([[0, 0], [0.11, 0], [0.102, 0.026], [0.078, 0.048], [0.042, 0.056], [0, 0.056]], 16), sub(R.tvback, 0.06, 0.58, 0.22, 0.78), { at: mat4(-0.13, -0.11, -0.236, -Math.PI / 2, 0, 0) });
    // the screen: an evenly rounded pane bulging out of the recess
    const [u0, v0, u1, v1] = TV_LAYOUT.screen, fw = 0.68, fh = 0.47, fz = 0.28;
    const sw = (u1 - u0) * fw * 0.95, sh = (v1 - v0) * fh * 0.94, scx = -fw / 2 + (u0 + u1) / 2 * fw, scy = -0.035 - fh / 2 + (v0 + v1) / 2 * fh;
    B.add(squirclePane(sw, sh, 0.02, 5), R.screen, { at: mat4(scx, scy, fz + 0.002), crease: 80 });
    for (const [ku, kv] of TV_LAYOUT.knobs) B.add(lathe([[0, 0], [0.024, 0], [0.026, 0.01], [0.022, 0.022], [0.012, 0.026], [0, 0.027]], 12), R.brass, { at: mat4(-fw / 2 + ku * fw, -0.035 - fh / 2 + kv * fh, fz - 0.002, Math.PI / 2, 0, 0) });
    // rabbit ears
    B.add(sphere(1, 10, 6), R.brass, { at: mat4(0.06, 0.2, -0.06, 0, 0, 0, [0.05, 0.03, 0.05]), tint: 0.85 });
    for (const sx of [-1, 1]) {
      B.add(cyl(0.0055, 0.17, 6, 0.004), R.rubber, { at: mat4(0.06 + sx * 0.068, 0.268, -0.06, 0, 0, -sx * 0.95) });
      B.add(sphere(0.011, 6, 4), R.brass, { at: mat4(0.06 + sx * 0.137, 0.317, -0.06) });
    }
    return B.done({ ao: 0.28, aoH: 0.12 });
  },

  neon() {     // the old neon OPEN sign, as a lantern-lit painted shop board with a domed crest
    const B = new Build();
    const yb = -0.25, D = 0.075, bev = 0.01;
    const board = new THREE.ExtrudeGeometry(new THREE.Shape(SIGN.pts.map(([x, y]) => new THREE.Vector2(x, y + yb))), { depth: D, bevelEnabled: true, bevelThickness: bev, bevelSize: 0.007, bevelSegments: 2, curveSegments: 4 });
    board.translate(0, 0, -D / 2);
    B.add(board, R.wood, { uv: 'box', faces: { pz: R.sign, nz: R.sign }, box: [-SIGN.W / 2, yb, -0.05, SIGN.W / 2, yb + SIGN.H, 0.05], crease: 55 });
    // the iron bar, its scroll brackets and the chain links that hold the board
    B.add(rbox(0.98, 0.022, 0.03, 0.008, 1), R.rubber, { uv: 'box', at: mat4(0, 0.232, 0), tint: 1.3 });
    for (const sx of [-1, 1]) {
      B.add(new THREE.TorusGeometry(0.028, 0.006, 6, 16, Math.PI * 1.5), R.rubber, { at: mat4(sx * 0.15, 0.193, 0, 0, 0, sx > 0 ? Math.PI * 0.5 : Math.PI), tint: 1.3 });
      B.add(new THREE.TorusGeometry(0.02, 0.005, 6, 14, Math.PI * 1.6), R.rubber, { at: mat4(sx * 0.38, 0.203, 0, 0, 0, sx > 0 ? 0 : Math.PI * 0.4), tint: 1.3 });
      for (const [y, ry] of [[0.206, Math.PI / 2], [0.178, 0]]) B.add(new THREE.TorusGeometry(0.015, 0.004, 5, 10), R.rubber, { at: mat4(sx * 0.28, y, 0, 0, ry, Math.PI / 2), tint: 1.3 });
      const x = sx * 0.452;
      B.add(new THREE.TorusGeometry(0.014, 0.004, 4, 8), R.rubber, { at: mat4(x, 0.212, 0, 0, Math.PI / 2, 0), tint: 1.3 });
      B.add(lathe([[0, 0], [0.045, 0], [0.04, 0.012], [0.012, 0.04], [0, 0.045]], 4), R.rubber, { at: mat4(x, 0.155, 0, 0, Math.PI / 4, 0), tint: 1.2 });
      B.add(rbox(0.07, 0.09, 0.07, 0.006, 1), R.lantern, { uv: 'box', faces: { py: R.rubber, ny: R.rubber }, at: mat4(x, 0.11, 0) });
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
    B.add(body, R.honey, { uv: 'box', faces: { pz: R.guitar }, crease: 55 });
    B.add(rbox(0.046, 0.31, 0.03, 0.012), R.wood, { uv: 'box', at: mat4(0, 0.26, -0.006), tint: [1.1, 0.95, 0.85] });
    B.add(rbox(0.05, 0.31, 0.008, 0.003, 1), R.fret, { uv: 'box', faces: { pz: R.fret }, swap: true, at: mat4(0, 0.26, 0.013) });
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
    const ax = 0.36, ay = 0.27;          // the sight opening's half sizes; the frame is 9 cm wide
    B.add(rbox(0.74, 0.56, 0.02, 0.004, 1), R.honey, { uv: 'box', faces: { pz: R.portrait }, at: mat4(0, 0, -0.022) });
    // the frame: one mitred molding per side, a 3-step profile (inner bead, cove, acanthus roll), [o, z, v]
    const FR = [[0.0, -0.01, 0.0], [0.006, -0.002, 0.07], [0.01, 0.004, 0.12], [0.013, 0.01, 0.17], [0.018, 0.014, 0.22], [0.023, 0.01, 0.27], [0.026, 0.008, 0.31],
      [0.03, 0.012, 0.36], [0.034, 0.02, 0.42], [0.037, 0.026, 0.48], [0.04, 0.028, 0.52], [0.046, 0.032, 0.58], [0.055, 0.034, 0.66], [0.066, 0.032, 0.75],
      [0.076, 0.025, 0.84], [0.084, 0.012, 0.92], [0.088, -0.002, 0.97], [0.09, -0.02, 0.99], [0.09, -0.038, 1.0], [0.0, -0.038, 1.0], [0.0, -0.01, 1.0]];
    const sides = [
      { along: [1, 0], out: [0, 1], half: ax, off: ay }, { along: [-1, 0], out: [0, -1], half: ax, off: ay },
      { along: [0, -1], out: [1, 0], half: ay, off: ax }, { along: [0, 1], out: [-1, 0], half: ay, off: ax },
    ];
    for (const s of sides) {
      const pos = [], uv = [];
      const P = (i, e) => { const [o, z] = FR[i], t = e * (s.half + o); return [s.out[0] * (s.off + o) + s.along[0] * t, s.out[1] * (s.off + o) + s.along[1] * t, z, (t + 0.45) / 0.9, FR[i][2]]; };
      for (let i = 0; i < FR.length - 1; i++) {
        const a = P(i, -1), b = P(i, 1), c = P(i + 1, 1), d = P(i + 1, -1);
        const dO = FR[i + 1][0] - FR[i][0], dZ = FR[i + 1][1] - FR[i][1];
        const want = new V3(s.out[0] * -dZ, s.out[1] * -dZ, dO);
        const n = new V3(b[0] - a[0], b[1] - a[1], b[2] - a[2]).cross(new V3(c[0] - a[0], c[1] - a[1], c[2] - a[2]));
        const tri = n.dot(want) >= 0 ? [a, b, c, a, c, d] : [a, c, b, a, d, c];
        for (const q of tri) { pos.push(q[0], q[1], q[2]); uv.push(q[3], q[4]); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      B.add(g, R.gold, { crease: 50 });
    }
    // scalloped acanthus rosettes on the corners
    const ros = (() => {
      const pos = [], idx = [], uv = [], N = 30, rings = 4, Rr = 0.034;
      pos.push(0, 0, 0.014); uv.push(0.5, 0.5);
      for (let j = 1; j <= rings; j++) for (let i = 0; i < N; i++) {
        const t = i / N * TAU, rho = Rr * j / rings * (1 + 0.2 * Math.cos(5 * t)), z = 0.014 * (1 - (j / rings) ** 2);
        pos.push(Math.cos(t) * rho, Math.sin(t) * rho, z); uv.push(0.5 + Math.cos(t) * rho / (Rr * 2.4), 0.5 + Math.sin(t) * rho / (Rr * 2.4));
      }
      for (let i = 0; i < N; i++) idx.push(0, 1 + i, 1 + (i + 1) % N);
      for (let j = 1; j < rings; j++) for (let i = 0; i < N; i++) { const a = 1 + (j - 1) * N + i, b = 1 + (j - 1) * N + (i + 1) % N, c = 1 + j * N + (i + 1) % N, d = 1 + j * N + i; idx.push(a, d, c, a, c, b); }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); return g;
    })();
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) B.add(ros, R.rosette, { at: mat4(sx * (ax + 0.056), sy * (ay + 0.056), 0.026, 0, 0, Math.atan2(sy, sx)), crease: 70 });
    return B.done({ ao: 0.1, aoH: 0.1 });
  },

  suitcase() {
    const B = new Build();
    B.add(rbox(0.68, 0.44, 0.21, 0.04), R.leather, { uv: 'box', at: mat4(0, -0.025, 0) });
    B.add(rbox(0.692, 0.024, 0.222, 0.01, 1), R.strap, { uv: 'box', at: mat4(0, 0.085, 0), tint: 0.9 });
    for (const sx of [-1, 1]) {
      const x = sx * 0.19;
      for (const sz of [-1, 1]) B.add(rbox(0.058, 0.452, 0.008, 0.003, 1), R.strap, { uv: 'box', swap: true, at: mat4(x, -0.025, sz * 0.107) });
      B.add(rbox(0.058, 0.008, 0.222, 0.003, 1), R.strap, { uv: 'box', at: mat4(x, 0.199, 0) });
      B.add(rbox(0.07, 0.05, 0.012, 0.008, 1), R.brass, { uv: 'box', at: mat4(x, 0.02, 0.114) });
      B.add(rbox(0.04, 0.026, 0.006, 0.003, 1), R.strap, { uv: 'box', at: mat4(x, 0.02, 0.121), tint: 0.6 });
      for (const sy of [-1, 1]) B.add(rbox(0.068, 0.068, 0.226, 0.016), R.brass, { uv: 'box', at: mat4(sx * 0.31, -0.025 + sy * 0.19, 0), tint: 0.9 });
    }
    B.add(rbox(0.06, 0.046, 0.01, 0.006, 1), R.brass, { uv: 'box', at: mat4(0, 0.095, 0.112) });
    B.add(new THREE.TorusGeometry(0.046, 0.013, 6, 10, Math.PI), R.strap, { uv: 'keep', at: mat4(0, 0.2, 0) });
    for (const sx of [-1, 1]) B.add(rbox(0.026, 0.014, 0.04, 0.005, 1), R.brass, { uv: 'box', at: mat4(sx * 0.046, 0.204, 0) });
    B.add(rbox(0.05, 0.068, 0.004, 0.002, 1), R.tag, { uv: 'box', at: mat4(0.075, 0.15, 0.03, 0, 0.2, 0.32) });
    return B.done({ ao: 0.25, aoH: 0.1 });
  },

  tire() {
    const B = new Build();
    const T = TIRE_V;
    B.add(lathe([[0.21, -0.088, 0], [0.24, -0.118, 0.08], [0.28, -0.13, T.wallLo[0]], [0.315, -0.128, T.wallLo[1]], [0.345, -0.108, 0.31], [0.36, -0.07, T.treadLo],
      [0.362, 0, 0.5], [0.36, 0.07, T.treadHi], [0.345, 0.108, 0.69], [0.315, 0.128, T.wallHi[0]], [0.28, 0.13, T.wallHi[1]], [0.24, 0.118, 0.92], [0.21, 0.088, 1]], 36), R.tire, { crease: 60 });
    const rim = [[0, -0.045], [0.06, -0.045], [0.085, -0.066], [0.19, -0.075], [0.208, -0.09], [0.214, -0.07], [0.214, 0.07], [0.208, 0.09], [0.19, 0.075], [0.085, 0.066], [0.06, 0.045], [0, 0.045]];
    B.add(lathe(rim, 32), R.rim, { uv: 'planar', axis: 'y', bounds: [-0.214, -0.214, 0.214, 0.214], crease: 40 });
    return B.done({ ao: 0.2, aoH: 0.1 });
  },

  slot() {
    const B = new Build();
    const T = 100 / 512, Tb = 75 / 384;
    B.add(rbox(0.72, 0.1, 0.64, 0.025), R.wood, { uv: 'box', at: mat4(0, -0.65, 0), tint: 0.8 });
    B.add(rbox(0.64, 0.98, 0.56, 0.035), R.red, { uv: 'box', faces: { pz: sub(R.slot, 0, T, 1, 1), nz: sub(R.slotback, 0, Tb, 1, 1), px: R.slotside, nx: R.slotside }, at: mat4(0, -0.11, -0.02) });
    B.add(rbox(0.668, 0.032, 0.59, 0.012), R.brass, { uv: 'box', at: mat4(0, 0.385, -0.02) });
    // the arched crown: painted faces front and back, a band of chaser bulbs over the top
    const C = SLOT_CROWN, arch = [[-C.hw, 0], [-C.hw, C.side]];
    for (let k = 1; k < 18; k++) { const a = Math.PI - k / 18 * Math.PI; arch.push([C.hw * Math.cos(a), C.side + (C.top - C.side) * Math.sin(a)]); }
    arch.push([C.hw, C.side], [C.hw, 0]);
    const cz0 = -0.24, cz1 = 0.16, cy = 0.401;
    B.add(shapeFace(arch), sub(R.slot, 0, 0, 1, T), { uv: 'planar', axis: 'z', bounds: [-C.hw, 0, C.hw, C.top], at: mat4(0, cy, cz1) });
    B.add(shapeFace(arch), sub(R.slotback, 0, 0, 1, Tb), { uv: 'planar', axis: 'z', bounds: [-C.hw, 0, C.hw, C.top], at: mat4(0, cy, cz0, 0, Math.PI, 0) });
    B.add(shapeBand(arch, cz0, cz1, [0, C.side]), R.bulbs, { at: mat4(0, cy, 0), crease: 40 });
    B.add(sphere(0.03, 12, 8), R.brass, { at: mat4(0, cy + C.top + 0.026, (cz0 + cz1) / 2), tint: GOLD });
    // the button ledge and the coin tray line up with the paint
    B.add(rbox(0.6, 0.05, 0.1, 0.014), R.brass, { uv: 'box', at: mat4(0, -0.135, 0.29, -0.35, 0, 0) });
    for (let k = 0; k < 3; k++) B.add(cyl(0.022, 0.02, 12), R.ivory, { at: mat4(-0.15 + k * 0.15, -0.11, 0.3, -0.35, 0, 0), tint: k === 1 ? [1.1, 0.42, 0.36] : 1 });
    B.add(rbox(0.36, 0.06, 0.08, 0.016), R.brass, { uv: 'box', at: mat4(0, -0.475, 0.285) });
    // the one arm
    B.add(rbox(0.05, 0.13, 0.13, 0.02), R.brass, { uv: 'box', at: mat4(0.335, 0.0, 0.0) });
    B.add(cyl(0.013, 0.44, 8), R.rubber, { at: mat4(0.345, 0.22, 0.02, 0.06, 0, 0), tint: 1.5 });
    B.add(sphere(0.045, 12, 8), R.ivory, { at: mat4(0.338, 0.455, 0.035), tint: [1.15, 0.36, 0.3] });
    return B.done({ ao: 0.3, aoH: 0.25 });
  },

  safe() {
    const B = new Build();
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) B.add(lathe([[0, 0], [0.06, 0], [0.064, 0.02], [0.05, 0.05], [0.055, 0.062], [0, 0.064]], 12), R.rubber, { at: mat4(sx * 0.3, -0.42, sz * 0.28 - 0.03), tint: IRON });
    // the body, a touch narrower at the top
    const taper = v => { const t = (v.y + 0.385) / 0.77, k = 1 - 0.04 * t; v.x *= k; v.z *= k; };
    B.add(rbox(0.78, 0.77, 0.72, 0.045), R.iron, { uv: 'box', faces: { nz: R.safeback }, at: mat4(0, 0.03, -0.03), warp: taper });
    // the door: a thick bevelled slab standing proud of the front, two strap hinges on the left
    B.add(rbox(0.6, 0.6, 0.04, 0.016), R.iron, { uv: 'box', faces: { pz: R.safe }, at: mat4(0, 0.03, 0.335) });
    for (const sy of [-1, 1]) {
      const y = 0.03 + sy * 0.19;
      B.add(cyl(0.022, 0.1, 10), R.rubber, { at: mat4(-0.31, y, 0.338), tint: IRON });
      B.add(rbox(0.13, 0.044, 0.01, 0.005, 1), R.rubber, { uv: 'box', at: mat4(-0.24, y, 0.358), tint: IRON });
      for (let k = 0; k < 3; k++) B.add(sphere(0.0075, 8, 5), R.brass, { at: mat4(-0.285 + k * 0.045, y, 0.364), tint: [0.8, 0.8, 0.75] });
    }
    // the dial, the handle
    B.add(lathe([[0, 0], [0.074, 0], [0.08, 0.01], [0.076, 0.02], [0.05, 0.028], [0.022, 0.034], [0, 0.035]], 20), R.brass, { at: mat4(0, 0.03, 0.355, Math.PI / 2, 0, 0) });
    B.add(rbox(0.15, 0.024, 0.022, 0.009, 1), R.brass, { uv: 'box', at: mat4(0.0, -0.17, 0.384) });
    B.add(cyl(0.024, 0.026, 10), R.brass, { at: mat4(0.0, -0.17, 0.366, Math.PI / 2, 0, 0) });
    // lifting rings on the flanks
    for (const sx of [-1, 1]) {
      B.add(cyl(0.02, 0.016, 10), R.rubber, { at: mat4(sx * 0.381, 0.2, -0.03, 0, 0, Math.PI / 2), tint: IRON });
      B.add(new THREE.TorusGeometry(0.04, 0.009, 6, 16), R.rubber, { at: mat4(sx * 0.386, 0.158, -0.03, 0, Math.PI / 2, 0), tint: IRON });
    }
    return B.done({ ao: 0.3, aoH: 0.15 });
  },

  dino() {
    // The roadside sauropod's goofy fiberglass head, snapped off with a thick stub of its neck: a
    // round dome with big slit-pupil eyes up on its top corners under heavy brows, plates down the
    // spine, a blunt snout with its nostrils on top, the jaw hanging open over a pink tongue and two
    // rows of cream peg teeth. The head and neck share one painted hide (loot_dinohead) wrapped
    // round them; the lower jaw and the inside of the mouth have their own cells.
    const B = new Build(), D = DINO, pw = D.pw, rnd = rngFrom('dino-head');
    const vOf = z => Math.min(1, Math.max(0, (z - D.z0) / (D.z1 - D.z0)));
    // the small bumps (plates, brows, lids, nostrils) take a plain strip of hide, lit by their normal
    const PLAIN = sub(R.dinomouth, 2 / 3, 0, 1, 1);
    const hide = { uv: 'fn', fn: (x, y, z, nx, ny) => [0.5 + 0.4 * nx, Math.min(0.98, Math.max(0.02, 0.5 + 0.48 * ny))], crease: 80 };
    const head = [
      { z: -0.47, w: 0.27, top: 0.27, bot: -0.02 }, { z: -0.41, w: 0.33, top: 0.38, bot: -0.05 }, { z: -0.29, w: 0.36, top: 0.45, bot: -0.07 },
      { z: -0.14, w: 0.375, top: 0.48, bot: -0.075 }, { z: 0.02, w: 0.36, top: 0.43, bot: -0.07 }, { z: 0.17, w: 0.3, top: 0.32, bot: -0.06 },
      { z: 0.32, w: 0.275, top: 0.255, bot: -0.05 }, { z: 0.48, w: 0.28, top: 0.245, bot: -0.04 }, { z: 0.6, w: 0.275, top: 0.24, bot: -0.03 },
      { z: 0.68, w: 0.235, top: 0.215, bot: -0.02 }, { z: 0.735, w: 0.16, top: 0.17, bot: 0.0 }, { z: 0.765, w: 0.07, top: 0.12, bot: 0.03 }, { z: 0.775, w: 0.01, top: 0.085, bot: 0.065 },
    ];
    B.add(loftU(head, { segs: 32, pw, v: [vOf(head[0].z), vOf(head[head.length - 1].z)] }), R.dinohead, { crease: 80 });
    // the lower jaw, swung open about the hinge under the back of the skull
    const jaw = [
      { z: -0.34, w: 0.2, top: -0.05, bot: -0.19 }, { z: -0.27, w: 0.285, top: -0.05, bot: -0.26 }, { z: -0.12, w: 0.305, top: -0.055, bot: -0.3 },
      { z: 0.08, w: 0.29, top: -0.06, bot: -0.3 }, { z: 0.28, w: 0.27, top: -0.06, bot: -0.27 }, { z: 0.46, w: 0.255, top: -0.06, bot: -0.24 },
      { z: 0.59, w: 0.23, top: -0.06, bot: -0.205 }, { z: 0.665, w: 0.17, top: -0.065, bot: -0.165 }, { z: 0.7, w: 0.08, top: -0.08, bot: -0.13 }, { z: 0.71, w: 0.01, top: -0.1, bot: -0.11 },
    ];
    const open = 0.21, hy = -0.06, hz = D.hinge;
    const jawM = new THREE.Matrix4().makeTranslation(0, hy, hz).multiply(new THREE.Matrix4().makeRotationX(open)).multiply(new THREE.Matrix4().makeTranslation(0, -hy, -hz));
    B.add(loftU(jaw, { segs: 28, pw }), R.dinojaw, { at: jawM, crease: 80 });
    // inside the mouth: a dark cavity between the jaws, open at the front, the throat at the back
    const jawAt = z => { const zl = hz + (z - hz) / Math.cos(open), s = secAt(jaw, zl); return { y: hy + (s.top - hy) * Math.cos(open) - (zl - hz) * Math.sin(open), w: s.w }; };
    const cav = [-0.25, -0.18, -0.06, 0.1, 0.26, 0.42, 0.56, 0.645].map(z => { const u = secAt(head, z), j = jawAt(z); return { z, w: Math.min(u.w, j.w) - 0.05, top: u.bot + 0.05, bot: j.y - 0.045 }; });
    B.add(loftU(cav, { segs: 20, pw: 4, inside: true, caps: [true, false] }), sub(R.dinomouth, 0, 0, 1 / 3, 1), { crease: 80 });
    // the tongue lying in the jaw, its tip curling up
    B.add(sphere(1, 16, 10), sub(R.dinomouth, 1 / 3, 0, 2 / 3, 1), {
      uv: 'fn', fn: (x, y, z) => [Math.min(1, Math.max(0, (x + 0.16) / 0.32)), Math.min(1, Math.max(0, (z + 0.17) / 0.68))],
      at: jawM.clone().multiply(mat4(0, -0.075, 0.15, 0, 0, 0, [0.15, 0.05, 0.31])), crease: 80,
      warp: v => { if (v.y < 0) v.y *= 0.5; else v.y -= 0.22 * Math.exp(-((v.x / 0.3) ** 2)) * v.y; if (v.z > 0.35) v.y += (v.z - 0.35) ** 2 * 1.6; },
    });
    // two rows of big cream peg teeth, interleaved
    for (const sd of [-1, 1]) {
      const zs = [0.04, 0.16, 0.28, 0.4, 0.52, 0.63];
      for (const [k, z0] of zs.entries()) {
        const z = z0 + range(rnd, -0.015, 0.015), p = secPoint(secAt(head, z), sd < 0 ? D.lipU + 0.012 : 1 - D.lipU - 0.012, pw), L = range(rnd, 0.075, 0.095) * (k === 5 ? 0.85 : 1);
        B.add(peg([p[0] * 0.97, p[1] + 0.025, p[2]], [p[0] * 1.02, p[1] - L, p[2] + 0.01], range(rnd, 0.027, 0.032)), R.ivory, { crease: 70 });
      }
      { const p = secPoint(secAt(head, 0.715), sd < 0 ? 0.06 : 0.94, pw); B.add(peg([p[0], p[1] + 0.02, p[2] - 0.01], [p[0] * 1.1, p[1] - 0.07, p[2] + 0.015], 0.026), R.ivory, { crease: 70 }); }
      for (const [k, zl] of [0.1, 0.23, 0.36, 0.49, 0.6].entries()) {
        const p = secPoint(secAt(jaw, zl + range(rnd, -0.015, 0.015)), sd < 0 ? 0.5 - D.jawLipU + 0.01 : 0.5 + D.jawLipU - 0.01, pw), L = range(rnd, 0.065, 0.08) * (k === 4 ? 0.85 : 1);
        const a = new V3(p[0] * 0.98, p[1] - 0.02, p[2]).applyMatrix4(jawM), b = new V3(p[0] * 1.02, p[1] + L, p[2] - 0.005).applyMatrix4(jawM);
        B.add(peg(a.toArray(), b.toArray(), range(rnd, 0.025, 0.03)), R.ivory, { crease: 70 });
      }
    }
    // big eyes up on the dome's top corners: an amber slit-pupil eyeball, a heavy lid, a brow ridge
    for (const sd of [-1, 1]) {
      const s = secAt(head, D.eye.z), p = secPoint(s, 0.5 + sd * D.eye.u, pw), mid = (s.top + s.bot) / 2;
      const n = new V3(p[0] / s.w, (p[1] - mid) / ((s.top - s.bot) / 2), 0).normalize(), r = 0.125;
      const c = new V3(...p).addScaledVector(n, -0.03);
      const look = new V3(sd * 0.5, 0.22, 0.84).normalize(), ry = Math.atan2(look.x, look.z), rx = -Math.asin(look.y);
      const E = mat4(c.x, c.y, c.z, rx, ry, 0);
      B.add(sphere(r, 16, 12), R.eye, { at: E, crease: 80 });
      B.add(lathe([[r * 1.08, -0.004], [r * 1.06, r * 0.32], [r * 0.92, r * 0.62], [r * 0.6, r * 0.88], [r * 0.25, r * 1.02], [0, r * 1.06]], 18), PLAIN, { ...hide, at: E.clone().multiply(mat4(0, 0, 0, -0.3, 0, 0)) });
      B.add(sphere(1, 12, 8), PLAIN, { ...hide, at: mat4(c.x + sd * 0.004, c.y + 0.11, c.z - 0.035, 0.12, sd * 0.25, sd * -0.3, [0.13, 0.062, 0.105]), tint: 0.95 });
    }
    // nostrils on top of the snout
    for (const sd of [-1, 1]) {
      const p = secPoint(secAt(head, D.nostril.z), 0.5 + sd * D.nostril.u, pw);
      B.add(sphere(1, 12, 8), PLAIN, { ...hide, at: mat4(p[0], p[1] - 0.012, p[2], 0, 0, sd * -0.2, [0.055, 0.032, 0.065]) });
      B.add(sphere(1, 10, 6), R.rubber, { at: mat4(p[0] + sd * 0.004, p[1] + 0.014, p[2] + 0.012, -0.5, 0, sd * -0.2, [0.022, 0.009, 0.03]), tint: [1.25, 0.75, 0.7] });
    }
    // plates down the spine, dark green, biggest over the back of the dome
    for (const [z, s] of [[0.08, 0.6], [-0.06, 0.8], [-0.21, 0.95], [-0.35, 1]]) {
      const t = secPoint(secAt(head, z), 0.5, pw);
      B.add(sphere(1, 12, 8), PLAIN, { ...hide, at: mat4(0, t[1] - 0.008, z, 0.15, 0, 0, [0.05 * s, 0.07 * s, 0.08 * s]), tint: 0.78 });
    }
    // the neck: a thick stub flaring out to the break, angling down and back out of the skull
    const neck = [{ z: 0, w: 0.33, top: 0.28, bot: -0.28 }, { z: 0.2, w: 0.355, top: 0.295, bot: -0.295 }, { z: 0.36, w: 0.39, top: 0.31, bot: -0.31 }, { z: 0.45, w: 0.42, top: 0.32, bot: -0.32 }];
    const NL = 0.45, nS = new V3(0, 0.06, -0.3), nM = mat4(nS.x, nS.y, nS.z, 0.5, Math.PI, 0);
    const nEnd = new V3(0, 0, NL).applyMatrix4(nM);
    const jag = v => { if (v.z > NL - 0.001) { const a = Math.atan2(v.y, v.x); v.z += 0.04 * Math.sin(a * 5 + 1.3) + 0.022 * Math.sin(a * 11 + 0.4) + 0.012 * Math.sin(a * 23) - 0.012; } };
    B.add(loftU(neck, { segs: 30, pw: 2.2, v: [vOf(nS.z), vOf(nEnd.z)], caps: [false, false] }), R.dinohead, { at: nM, flipU: true, crease: 80, warp: jag });
    for (const [lz, s] of [[0.12, 0.95], [0.3, 0.85]]) {
      const q = new V3(0, secAt(neck, lz).top - 0.01, lz).applyMatrix4(nM);
      B.add(sphere(1, 12, 8), PLAIN, { ...hide, at: mat4(q.x, q.y, q.z, 0.6, 0, 0, [0.055 * s, 0.07 * s, 0.085 * s]), tint: 0.78 });
    }
    // the break: a jagged oval of plaster round the hollow, three rusty rebar stubs
    const brk = [], ns = neck[neck.length - 1];
    for (let k = 0; k < 28; k++) { const t = k / 28 * TAU, j = range(rnd, 0.93, 1.03); brk.push([Math.cos(t) * ns.w * j, Math.sin(t) * ns.top * j]); }
    const brkM = nM.clone().multiply(mat4(0, 0, NL - 0.03));
    B.add(shapeFace(brk), R.plaster, { uv: 'planar', axis: 'z', bounds: [-ns.w * 1.03, -ns.top * 1.03, ns.w * 1.03, ns.top * 1.03], at: brkM, crease: 30 });
    for (const [bx, by] of [[-0.2, 0.08], [0.17, 0.12], [0.04, -0.17]]) {
      const pts = [[bx, by, -0.02], [bx * 1.05, by * 1.05, 0.05], [bx * 1.25 + 0.02, by * 1.1 - 0.03, 0.1]].map(p => new V3(...p).applyMatrix4(brkM).toArray());
      B.add(tube(pts, 0.014, 6, 5), R.rubber, { tint: RUST });
    }
    return B.done({ ao: 0.28, aoH: 0.3, fit: [0.5, 0.45, 0.75] });
  },

  map() {      // the leather map case: a rolled edge, a strap with a buckle (the paper is a second mesh)
    const B = new Build();
    B.add(rbox(0.4, 0.026, 0.28, 0.008, 1), R.leather, { uv: 'box', at: mat4(0, -0.007, 0) });
    B.add(cyl(0.016, 0.28, 10), R.leather, { at: mat4(-0.184, -0.004, 0, Math.PI / 2, 0, 0), tint: 0.85 });
    B.add(rbox(0.032, 0.004, 0.284, 0.0015, 1), R.strap, { uv: 'box', swap: true, at: mat4(0.14, 0.0095, 0) });
    B.add(rbox(0.04, 0.006, 0.032, 0.002, 1), R.brass, { uv: 'box', at: mat4(0.14, 0.012, 0.06) });
    return B.done({ ao: 0, aoH: 0.01 });
  },
};

// ---- the boulder: fills the 4 × 2.6 × 3 m box --------------------------------------------------------
// Meadow, fields and snow: three cut-plane lumps with big flat facets (each facet's value painted in by
// its facing: lit cream-gray tops, cool sides). Badlands and desert: tabular slabs stacked and set back,
// flat tops, near-vertical sides, a fracture notch or two, their ledges on the painted strata lines
// (BOULDER_BANDS). Every biome: two or three broken chunks at the foot.

const LUMPS = [
  { c: [-0.25, -0.05, 0.0], r: [1.25, 1.0, 1.15], rz: 0.02, top: 0.8 },     // the main stone, a broken flat top
  { c: [0.78, -0.3, 0.32], r: [0.9, 0.72, 0.85], rz: -0.24, top: 0.62 },    // a slab leaning off it
  { c: [0.7, 0.32, -0.42], r: [0.62, 0.44, 0.56], rz: 0.18, top: 0.7 },     // an overhanging shoulder
];
// The mesa block: one angular outline, stepping back at some of the strata edges toward `dir`
// (k = 1 − setback × max(0, cos(angle − dir))), flush on the far side where only a joint shows.
const SLABS = {
  badlands: { n: 9, jit: 0.38, rx: 1.95, rz: 1.45, ch: 0.07, notch: 2, levels: [{ b: [0, 2], sb: 0, dir: 0 }, { b: [2, 4], sb: 0.34, dir: 0.6 }, { b: [4, 5], sb: 0.5, dir: 2.4 }] },
  desert: { n: 11, jit: 0.22, rx: 1.95, rz: 1.45, ch: 0.14, notch: 1, levels: [{ b: [0, 2], sb: 0, dir: 0 }, { b: [2, 3], sb: 0.3, dir: 3.6 }, { b: [3, 4], sb: 0.46, dir: 0.9 }] },
};
const CHUNKS = [[-1.55, 1.05, 0.4, 0.34, 0.36, 0.5], [1.6, -0.9, 0.36, 0.3, 0.3, 2.2], [0.35, -1.25, 0.3, 0.26, 0.26, 4.1]];   // x, z, rx, rz, height, rot

// One continuous block through `levels` [{ P (outline, meters), y0, y1, vTop }] (each outline inside
// the one below): a wall per level, bulging a little and leaning, then a rounded lip and a flat ledge in
// to the next level's outline. Where the next level is flush there's no lip, so the cliff runs on
// unbroken. Pushes triangles into pos and a "v override" per vertex (null = by height).
function mesaInto(pos, vo, levels, ch, taper = 0.03, rnd = Math.random) {
  const R = [], cen = P => [P.reduce((a, p) => a + p[0], 0) / P.length, P.reduce((a, p) => a + p[1], 0) / P.length];
  const ring = (P, y, insets, v, k = 1, jit = null) => {
    const [cx, cz] = cen(P);
    return P.map(([x, z], i) => { const L = Math.hypot(x - cx, z - cz) || 1, f = Math.max(0.2, (L - insets[i]) / L) * k * (jit ? jit[i] : 1); return [cx + (x - cx) * f, y, cz + (z - cz) * f, v]; });
  };
  levels.forEach((L, i) => {
    const H = L.y1 - L.y0, n = L.P.length, tp = y => 1 - taper * (y - L.y0) / H, zero = new Array(n).fill(0);
    const next = levels[i + 1], depth = L.P.map(([x, z], k) => next ? Math.max(0, Math.hypot(x, z) - Math.hypot(...next.P[k])) : 1);
    const lip = depth.map(d => ch * Math.min(1, d / (ch * 3)));
    if (i === 0) { R.push(ring(L.P, L.y0, zero.map(() => ch * 0.5), null)); R.push(ring(L.P, L.y0 + ch * 0.4, zero, null)); }
    else R.push(ring(L.P, L.y0 + 0.02, zero, null));
    const jit = L.P.map(() => range(rnd, 0.97, 1.05)), jit2 = L.P.map(() => range(rnd, 0.96, 1.03));
    R.push(ring(L.P, L.y0 + H * 0.45, zero, null, tp(L.y0 + H * 0.45), jit));
    R.push(ring(L.P, L.y1 - ch * 1.1, zero, null, tp(L.y1 - ch * 1.1), jit2));
    R.push(ring(L.P, L.y1 - ch * 0.35, lip.map(d => d * 0.45), L.vTop, tp(L.y1), jit2));
    R.push(ring(L.P, L.y1, lip.map(d => d * 1.1), L.vTop, tp(L.y1), jit2));
    if (next) R.push(ring(next.P, L.y1, new Array(next.P.length).fill(0), L.vTop, 1 - taper * 0.02));
  });
  const n = R[0].length;
  const tri = (a, b, c) => { for (const p of [a, b, c]) { pos.push(p[0], p[1], p[2]); vo.push(p[3]); } };
  for (let j = 0; j < R.length - 1; j++) for (let k = 0; k < n; k++) { const a = R[j][k], b = R[j][(k + 1) % n], c = R[j + 1][(k + 1) % n], d = R[j + 1][k]; tri(a, c, b); tri(a, d, c); }
  const top = R[R.length - 1], bot = R[0], yT = levels[levels.length - 1].y1, vT = levels[levels.length - 1].vTop;
  const ct = [top.reduce((a, p) => a + p[0], 0) / n, yT + 0.012, top.reduce((a, p) => a + p[2], 0) / n, vT], cb = [bot.reduce((a, p) => a + p[0], 0) / n, levels[0].y0, bot.reduce((a, p) => a + p[2], 0) / n, null];
  for (let k = 0; k < n; k++) { tri(ct, top[(k + 1) % n], top[k]); tri(cb, bot[k], bot[(k + 1) % n]); }
}
// a jittered outline: n points round an ellipse-ish (squarish) shape, some notched in
function outline(n, rx, rz, cx, cz, rnd, notches = 0, rot = 0, jit = 0.3) {
  const nk = new Set(Array.from({ length: notches }, () => Math.floor(rnd() * n)));
  return Array.from({ length: n }, (_, k) => {
    const a = rot + (k + range(rnd, -jit, jit)) / n * TAU, c = Math.cos(a), sn = Math.sin(a);
    let r = Math.pow(Math.abs(c) ** 3 + Math.abs(sn) ** 3, -1 / 3) * range(rnd, 0.86, 1.04);
    if (nk.has(k)) r *= range(rnd, 0.62, 0.72);
    return [cx + c * r * rx, cz + sn * r * rz, a];
  });
}
function boulderGeo(biome) {
  const [, hx, hy, hz] = LOOT.boulder.shape;
  const rnd = rngFrom('boulder-' + biome);
  const vOf = y => (y + hy) / (2 * hy);
  let out;
  const vo = [];
  if (SLABS[biome]) {
    // stacked slabs, built in meters (y exact, so the ledges land on the painted strata)
    const SB = SLABS[biome], BV = BOULDER_BANDS[biome], E = BV.map(v => -hy + v * 2 * hy), pos = [];
    const P0 = outline(SB.n, SB.rx, SB.rz, 0, 0, rnd, SB.notch, rnd() * TAU, SB.jit);
    let K = P0.map(() => 1);     // the setbacks accumulate, so each level sits inside the one below
    mesaInto(pos, vo, SB.levels.map(L => { K = K.map((k, i) => k * (1 - L.sb * Math.max(0, Math.cos(P0[i][2] - L.dir)))); return { P: P0.map(([x, z], i) => [x * K[i], z * K[i]]), y0: E[L.b[0]], y1: E[L.b[1]], vTop: BV[L.b[1]] - 0.014 }; }), SB.ch, 0.03, rnd);
    for (const [x, z, rx, rz, ht, rot] of CHUNKS) mesaInto(pos, vo, [{ P: outline(5, rx, rz, x, z, rnd, 0, rot, 0.35), y0: -hy, y1: -hy + ht * range(rnd, 0.8, 1.3), vTop: null }], SB.ch * 0.8, 0.25, rnd);
    out = new THREE.BufferGeometry(); out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    out.computeBoundingBox();
    const bb = out.boundingBox, c = bb.getCenter(new V3()), s = bb.getSize(new V3()), p = out.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, (p.getX(i) - c.x) / s.x * 2 * hx * 0.995, p.getY(i), (p.getZ(i) - c.z) / s.z * 2 * hz * 0.995);
  } else {
    const parts = [];
    const lump = (L, nCut, depth, chunk = false) => {
      const cuts = [];
      for (let k = 0; k < nCut; k++) { const a = rnd() * TAU, e = range(rnd, -0.3, 0.75); cuts.push([new V3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)).normalize(), range(rnd, depth[0], depth[1])]); }
      const tilt = range(rnd, -0.15, 0.15);
      cuts.push([new V3(Math.sin(tilt), Math.cos(tilt), range(rnd, -0.1, 0.1)).normalize(), L.top]);
      const ph = Array.from({ length: 4 }, () => rnd() * TAU);
      const g = sphere(1, chunk ? 12 : 20, chunk ? 8 : 14).toNonIndexed(), p = g.attributes.position, v = new V3(), zAxis = new V3(0, 0, 1), c = new V3(...L.c);
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        v.multiplyScalar(1 + 0.05 * Math.sin(v.x * 3.1 + ph[0]) * Math.sin(v.z * 2.7 + ph[1]) + 0.03 * Math.sin(v.y * 4.3 + ph[2] + v.x * 2));
        for (const [nn, d] of cuts) { const e = v.dot(nn) - d; if (e > 0) v.addScaledVector(nn, -e); }
        if (v.y < -0.8) v.y = -0.8;
        v.set(v.x * L.r[0], v.y * L.r[1], v.z * L.r[2]).applyAxisAngle(zAxis, L.rz).add(c);
        p.setXYZ(i, v.x, Math.max(-0.85, v.y), v.z);     // every lump sits on the same flat floor
      }
      g.deleteAttribute('uv'); g.deleteAttribute('normal');
      parts.push(g);
    };
    for (const L of LUMPS) lump(L, 12, [0.68, 0.84]);
    // broken chunks at the foot (unit space: the whole thing is fitted to the box after)
    for (const [x, z, rx, rz, ht] of CHUNKS) lump({ c: [x * 0.82, -0.85 + ht * 0.6, z * 0.85], r: [rx * 0.7, ht * 0.75, rz * 0.7], rz: range(rnd, -0.3, 0.3), top: 0.55 }, 7, [0.55, 0.75], true);
    out = mergeGeometries(parts, false);
    out.computeBoundingBox();
    const bb = out.boundingBox, c = bb.getCenter(new V3()), s = bb.getSize(new V3()), p = out.attributes.position;
    for (let i = 0; i < p.count; i++) p.setXYZ(i, (p.getX(i) - c.x) / s.x * 2 * hx * 0.995, (p.getY(i) - c.y) / s.y * 2 * hy, (p.getZ(i) - c.z) / s.z * 2 * hz * 0.995);
  }
  const p = out.attributes.position, n = p.count;
  // u: round the rock (seam fixed per face), v: height (or the slab's override at its ledges)
  const uv = new Float32Array(n * 2);
  for (let f = 0; f < n / 3; f++) {
    const us = [0, 1, 2].map(k => Math.atan2(p.getX(f * 3 + k), p.getZ(f * 3 + k)) / TAU + 0.5);
    const mx = Math.max(...us);
    for (let k = 0; k < 3; k++) { const i = f * 3 + k; uv[i * 2] = mx - us[k] > 0.5 ? us[k] + 1 : us[k]; uv[i * 2 + 1] = Math.min(0.995, Math.max(0.005, vo[i] ?? vOf(p.getY(i)))); }
  }
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  creaseNormals(out, SLABS[biome] ? 40 : 46);
  // the painted light: each facet's value by its facing (lit warm tops and upper-left planes, cool
  // shaded sides), a contact shadow low down, darker under overhangs
  const nr = out.attributes.normal, col = new Float32Array(n * 3), Ld = new V3(-0.45, 0.8, 0.4).normalize(), t3 = new V3();
  for (let i = 0; i < n; i++) {
    t3.fromBufferAttribute(nr, i);
    const lit = Math.max(0, t3.dot(Ld)), up = Math.max(0, t3.y), t = Math.min(1, (p.getY(i) + hy) / 0.9), ao = 0.62 + 0.38 * t * t * (3 - 2 * t);
    const k = ao * (0.78 + 0.34 * lit + 0.08 * up) * (t3.y < 0 ? 1 + t3.y * 0.3 : 1);
    col[i * 3] = k * (0.94 + 0.08 * lit); col[i * 3 + 1] = k * (0.96 + 0.05 * lit); col[i * 3 + 2] = k * (1.06 - 0.08 * lit);
  }
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // the cover shell: the upward faces lifted 1.5 cm along their normals; its alpha fades with the
  // slope and is gone well before the silhouette turns over
  const cp = [], cu = [], cc = [];
  const sm = new THREE.BufferGeometry(); sm.setAttribute('position', p.clone()); creaseNormals(sm, 80);
  const sn = sm.attributes.normal;
  for (let f = 0; f < n / 3; f++) {
    let ny = 0; for (let k = 0; k < 3; k++) ny += sn.getY(f * 3 + k);
    if (ny / 3 < 0.5) continue;
    for (let k = 0; k < 3; k++) {
      const i = f * 3 + k, x = p.getX(i) + sn.getX(i) * 0.015, y = p.getY(i) + sn.getY(i) * 0.015, z = p.getZ(i) + sn.getZ(i) * 0.015;
      const a = Math.min(1, Math.max(0, (sn.getY(i) - 0.6) / 0.28));
      cp.push(x, y, z); cu.push(x / 1.7, z / 1.7); cc.push(1, 1, 1, a * a * (3 - 2 * a));
    }
  }
  const cover = new THREE.BufferGeometry();
  cover.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  cover.setAttribute('uv', new THREE.Float32BufferAttribute(cu, 2));
  cover.setAttribute('color', new THREE.Float32BufferAttribute(cc, 4));
  creaseNormals(cover, 80);
  const coverM = mergeVertices(cover, 1e-5); coverM.computeBoundingSphere();
  const m = mergeVertices(out, 1e-5); m.computeBoundingSphere(); m.computeBoundingBox();
  return { body: m, cover: coverM };
}

// ---- the paper road map ----------------------------------------------------------------------------

const BIOME_INK = {
  meadow: { land: ['#b8c48a', '#a8b878', '#c8cc96'], hill: '#8a9a5a', tree: 'oak', stamps: ['round', 'round', 'peak'], water: '#8ab4c0', critter: 'serpent' },
  fields: { land: ['#e0c98a', '#d4b874', '#e8d49a'], hill: '#b89a5a', tree: 'wheat', stamps: ['round', 'low'], water: '#94b8c0', critter: 'serpent' },
  snow: { land: ['#e8ecee', '#d4dee6', '#f2f2ee'], hill: '#8a96a8', tree: 'pine', stamps: ['peak', 'peak', 'round'], water: '#d8e6ee', critter: 'ice' },
  badlands: { land: ['#e0a878', '#d4946a', '#e8b888'], hill: '#a85a38', tree: 'dead', stamps: ['mesa', 'mesa', 'peak'], water: '#d4b088', critter: 'scorpid' },
  desert: { land: ['#ecd4a0', '#e0c48c', '#f2dcae'], hill: '#c09a6a', tree: 'cactus', stamps: ['dune', 'dune', 'round'], water: '#7ab8b0', critter: 'worm' },
};
const POI_NAMES = { gas: 'Fuel Stop', semi: 'Overturned Wagon', yard: 'Yard Sale', crash: 'Crash Site', junk: 'Junkyard', dino: 'Dino Park' };
const OBST_NAMES = { grade: 'Steep Grade', mud: 'Mud Bog', boulder: 'Rockfall', gate: 'Ranger Gate' };
const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const MAPFONT = `Georgia, 'Liberation Serif', 'DejaVu Serif', serif`;

function mapIcon(g, kind, x, y, s = 1) {
  g.save(); g.translate(x, y); g.scale(s, s);
  const ink = '#3a2a1e';
  g.lineJoin = 'round'; g.lineCap = 'round';
  const fillStroke = (c) => { g.fillStyle = c; g.fill(); g.stroke(); };
  g.beginPath(); g.arc(0.8, 1, 13, 0, TAU); g.fillStyle = 'rgba(58,42,30,0.35)'; g.fill();
  g.beginPath(); g.arc(0, 0, 13, 0, TAU); g.fillStyle = '#f2e2b8'; g.fill(); g.lineWidth = 2; g.strokeStyle = ink; g.stroke();
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
    g.font = `bold 8px ${MAPFONT}`; g.fillStyle = ink; g.textAlign = 'center'; g.fillText('$', 3, 4.5);
  } else if (kind === 'crash') {
    g.rotate(-0.5);
    g.beginPath(); g.ellipse(0, 0, 9, 2.6, 0, 0, TAU); fillStroke('#a8a8a0');
    g.beginPath(); g.moveTo(-2, 0); g.lineTo(-4, -8); g.lineTo(1, -8); g.lineTo(3, 0); g.lineTo(1, 8); g.lineTo(-4, 8); g.closePath(); fillStroke('#c8c8b8');
    g.beginPath(); g.moveTo(-8, 0); g.lineTo(-10, -4); g.lineTo(-7, -4); g.closePath(); fillStroke('#c8c8b8');
  } else if (kind === 'junk') {
    g.beginPath(); for (let k = 0; k < 16; k++) { const a = k / 16 * TAU, r = k % 2 ? 6 : 8.5; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); } g.closePath(); fillStroke('#8a8a84');
    g.beginPath(); g.arc(0, 0, 2.6, 0, TAU); fillStroke('#f2e2b8');
  } else if (kind === 'dino') {
    g.beginPath(); g.moveTo(-9, 6); g.quadraticCurveTo(-8, -1, -3, -1); g.quadraticCurveTo(0, -1, 1, -6); g.quadraticCurveTo(2, -9, 5, -8); g.lineTo(7, -7); g.lineTo(5, -5); g.quadraticCurveTo(3, 2, 6, 6); g.closePath(); fillStroke('#5a8a44');
    g.beginPath(); g.arc(4.2, -7.2, 0.9, 0, TAU); g.fillStyle = ink; g.fill();
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
  g.restore();
}
function tinyTree(g, kind, x, y, rnd, sc = 1) {
  const s = range(rnd, 0.8, 1.2) * sc;
  g.save(); g.translate(x, y); g.scale(s, s);
  g.strokeStyle = '#3a2a1e'; g.lineWidth = 1;
  if (kind === 'oak') { g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -3); g.stroke(); g.beginPath(); g.arc(0, -6, 4, 0, TAU); g.fillStyle = pick(rnd, ['#6a8a3a', '#5a7a34', '#7a9440']); g.fill(); g.stroke(); blob(g, -1.3, -7.3, 1.8, 1.3, 0, '#b8cc70', 0.8, 0.5); }
  else if (kind === 'pine') { g.beginPath(); g.moveTo(0, -10); g.lineTo(4, -1); g.lineTo(-4, -1); g.closePath(); g.fillStyle = '#4a6a54'; g.fill(); g.stroke(); g.beginPath(); g.moveTo(0, -10); g.lineTo(2, -6); g.lineTo(-2, -6); g.closePath(); g.fillStyle = '#f4f4f0'; g.fill(); }
  else if (kind === 'wheat') { for (const dx of [-2, 0, 2]) { g.beginPath(); g.moveTo(dx, 0); g.lineTo(dx * 1.4, -7); g.strokeStyle = '#8a6a2a'; g.stroke(); ellipse(g, dx * 1.4, -7, 1, 2, 0, '#c8a040'); } }
  else if (kind === 'dead') { g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -7); g.moveTo(0, -4); g.lineTo(-3, -7); g.moveTo(0, -5); g.lineTo(3, -8); g.strokeStyle = '#4a2e1e'; g.lineWidth = 1.3; g.stroke(); }
  else if (kind === 'cactus') { g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -8); g.moveTo(-3, -6); g.lineTo(-3, -3); g.lineTo(0, -3); g.moveTo(3, -7); g.lineTo(3, -4); g.lineTo(0, -4); g.strokeStyle = '#3a6a3a'; g.lineWidth = 2; g.stroke(); }
  else if (kind === 'palm') { g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(1, -5, 0, -9); g.strokeStyle = '#6a4a2a'; g.lineWidth = 1.4; g.stroke(); for (const a of [-2.6, -2, -1.2, -0.5]) { g.beginPath(); g.moveTo(0, -9); g.quadraticCurveTo(Math.cos(a) * 3, -9 + Math.sin(a) * 4, Math.cos(a) * 5, -9 + Math.sin(a) * 1.5 + 2); g.strokeStyle = '#3a7a3a'; g.lineWidth = 1.5; g.stroke(); } }
  g.restore();
}
// hill stamps: a few shapes, each inked, lit on its left, hatched on its shaded right
function hillStamp(g, kind, px, py, w, h, fillC, rnd) {
  g.save(); g.beginPath();
  if (kind === 'mesa') { g.moveTo(px - w, py); g.lineTo(px - w * 0.62, py - h); g.lineTo(px + w * 0.5, py - h * (0.96 + rnd() * 0.08)); g.lineTo(px + w, py); }
  else if (kind === 'dune') { g.moveTo(px - w * 1.2, py); g.quadraticCurveTo(px - w * 0.2, py - h * 0.95, px + w * 0.3, py - h * 0.6); g.quadraticCurveTo(px + w * 0.7, py - h * 0.25, px + w * 1.3, py); }
  else if (kind === 'peak') { g.moveTo(px - w, py); g.lineTo(px - w * 0.25, py - h * 1.2); g.lineTo(px + w * 0.05, py - h * 0.95); g.lineTo(px + w * 0.3, py - h * 1.05); g.lineTo(px + w, py); }
  else if (kind === 'low') { g.moveTo(px - w * 1.2, py); g.quadraticCurveTo(px, py - h * 1.0, px + w * 1.2, py); }
  else { g.moveTo(px - w, py); g.bezierCurveTo(px - w * 0.7, py - h * 1.15, px + w * 0.4, py - h * 1.2, px + w, py); }
  g.closePath();
  g.fillStyle = rgba(fillC, 0.62); g.fill(); g.strokeStyle = 'rgba(58,42,30,0.8)'; g.lineWidth = 1.1; g.stroke();
  g.clip();
  g.strokeStyle = 'rgba(58,42,30,0.35)'; g.lineWidth = 0.8;
  for (let k = 0; k < 7; k++) { const x = px + w * (0.05 + k * 0.13); g.beginPath(); g.moveTo(x, py); g.lineTo(x + w * 0.25, py - h * 1.2); g.stroke(); }
  blob(g, px - w * 0.45, py - h * 0.55, w * 0.35, h * 0.3, 0, '#fff4d8', 0.35, 0.3);
  if (kind === 'mesa') for (const f of [0.35, 0.65]) { g.beginPath(); g.moveTo(px - w, py - h * (1 - f)); g.lineTo(px + w, py - h * (1 - f)); g.strokeStyle = 'rgba(90,42,24,0.45)'; g.stroke(); }
  g.restore();
}
// ink lettering, each glyph nudged a little so it reads hand-lettered
function inkText(g, txt, x, y, { size = 12, color = '#3a2a1e', italic = false, align = 'center', halo = '#f2e2b8', weight = 'bold', jit = 0.05, clear = 0 } = {}) {
  g.save();
  g.font = `${italic ? 'italic ' : ''}${weight} ${size}px ${MAPFONT}`;
  g.textBaseline = 'middle';
  const W = g.measureText(txt).width;
  let cx = align === 'center' ? x - W / 2 : align === 'right' ? x - W : x;
  if (clear) blob(g, cx + W / 2, y, W / 2 + size * 0.7, size * 0.95, 0, '#ecd8aa', clear, 0.5);
  const r = rngFrom(txt + x.toFixed(0));
  g.textAlign = 'left';
  for (const ch of txt) {
    const w = g.measureText(ch).width, dy = (r() - 0.5) * size * jit, rot = (r() - 0.5) * jit;
    g.save(); g.translate(cx, y + dy); g.rotate(rot);
    if (halo) { g.lineWidth = 3; g.strokeStyle = rgba(halo, 0.85); g.lineJoin = 'round'; g.strokeText(ch, 0, 0); }
    g.fillStyle = color; g.fillText(ch, 0, 0); g.restore();
    cx += w;
  }
  g.restore();
  return W;
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
  inkText(g, 'N', 0, -r - r * 0.28, { size: Math.round(r * 0.42), halo: null, jit: 0 });
  g.restore();
}
// a coffee blot: an uneven ring, a faint stain inside, a drip
function coffee(g, x, y, r, rnd) {
  const pts = [], ph = [rnd() * TAU, rnd() * TAU];
  for (let k = 0; k <= 40; k++) { const a = k / 40 * TAU; pts.push([x + Math.cos(a) * r * (1 + 0.08 * Math.sin(a * 3 + ph[0]) + 0.05 * Math.sin(a * 7 + ph[1])), y + Math.sin(a) * r * (0.92 + 0.06 * Math.sin(a * 2 + ph[1]))]); }
  g.save(); g.beginPath(); pts.forEach(([a, b], i) => i ? g.lineTo(a, b) : g.moveTo(a, b)); g.fillStyle = 'rgba(168,120,64,0.1)'; g.fill(); g.restore();
  for (let k = 0; k < 40; k++) { g.save(); g.strokeStyle = `rgba(140,92,44,${(0.18 + 0.2 * Math.abs(Math.sin(k * 0.4 + ph[0]))).toFixed(2)})`; g.lineWidth = 1 + 2 * Math.abs(Math.sin(k * 0.3 + ph[1])); g.beginPath(); g.moveTo(...pts[k]); g.lineTo(...pts[k + 1]); g.stroke(); g.restore(); }
  blob(g, x + r * 1.2, y + r * 0.6, r * 0.18, r * 0.12, 0, '#a87840', 0.25, 0.5);
}
// the critter drawn in the margin's water (or sand)
function doodle(g, kind, x, y, s, rnd) {
  g.save(); g.translate(x, y); g.scale(s, s); g.strokeStyle = '#3a2a1e'; g.lineWidth = 1.2; g.lineJoin = 'round'; g.lineCap = 'round';
  if (kind === 'serpent' || kind === 'worm') {
    const c = kind === 'serpent' ? '#5a8a6a' : '#b8885a';
    for (const [hx, hr] of [[-14, 5], [-3, 6], [9, 5]]) { g.beginPath(); g.arc(hx, 0, hr, Math.PI, 0); g.lineTo(hx + hr - 2.5, 0); g.arc(hx, 0, hr - 2.5, 0, Math.PI, true); g.closePath(); g.fillStyle = c; g.fill(); g.stroke(); }
    g.beginPath(); g.moveTo(14, 0); g.quadraticCurveTo(15, -10, 21, -10); g.quadraticCurveTo(25, -9, 24, -6); g.lineTo(18, -5); g.quadraticCurveTo(18, -2, 18, 0); g.closePath(); g.fillStyle = c; g.fill(); g.stroke();
    g.beginPath(); g.arc(21, -8.5, 0.8, 0, TAU); g.fillStyle = '#3a2a1e'; g.fill();
    g.beginPath(); g.moveTo(-21, 0); g.quadraticCurveTo(-24, -4, -22, -7); g.stroke();
    g.strokeStyle = kind === 'serpent' ? 'rgba(58,90,110,0.7)' : 'rgba(138,98,58,0.7)'; g.lineWidth = 1;
    for (const wx of [-26, -9, 3, 16, 26]) { g.beginPath(); g.moveTo(wx - 3, 1.5); g.quadraticCurveTo(wx, -0.5, wx + 3, 1.5); g.stroke(); }
  } else if (kind === 'scorpid') {
    g.beginPath(); g.ellipse(0, 0, 7, 3.5, 0, 0, TAU); g.fillStyle = '#a8583a'; g.fill(); g.stroke();
    g.beginPath(); g.moveTo(-6, 0); g.quadraticCurveTo(-14, -2, -13, -9); g.quadraticCurveTo(-11, -12, -8, -9); g.stroke();
    for (const sy of [-1, 1]) { g.beginPath(); g.moveTo(6, sy * 2); g.lineTo(11, sy * 5); g.lineTo(14, sy * 3); g.moveTo(11, sy * 5); g.lineTo(14, sy * 7); g.stroke(); for (let k = -1; k <= 1; k++) { g.beginPath(); g.moveTo(k * 2.5, sy * 3); g.lineTo(k * 3.5, sy * 7); g.stroke(); } }
  } else if (kind === 'ice') {
    g.strokeStyle = 'rgba(90,110,140,0.75)'; g.lineWidth = 0.9;
    for (let k = 0; k < 5; k++) { g.beginPath(); let px = (rnd() - 0.5) * 20, py = (rnd() - 0.5) * 10; g.moveTo(px, py); for (let m = 0; m < 4; m++) { px += (rnd() - 0.5) * 12; py += (rnd() - 0.5) * 8; g.lineTo(px, py); } g.stroke(); }
  }
  g.restore();
}

// The road map: a sheet of burnt-edged parchment with the leg hand-inked on it. The road runs
// left (camp) → right (town), its wiggles exaggerated to fill the sheet; every stop, obstacle and
// landmark is on it, labels pushed clear of the road and of each other on leader lines.
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
  // the projection: x along the leg; the road's sideways wiggle scaled up to fill the sheet, features near it at their true offsets
  const z0 = Wd.Z0 + 30, z1 = Wd.Z1 - 20;
  let rmin = 1e9, rmax = -1e9; for (let z = z0; z <= z1; z += 8) { const r = Wd.roadX(z); rmin = Math.min(rmin, r); rmax = Math.max(rmax, r); }
  // the leg runs from the camp low on the left up to the town on the right; its sideways wiggle is
  // exaggerated by a gain that wanders along the road (0.4–1), so no two stretches snake alike
  const gph = [rnd() * TAU, rnd() * TAU], gain = z => { const t = (z - z0) / (z1 - z0); return 0.7 + 0.3 * (0.6 * Math.sin(t * TAU * 0.8 + gph[0]) + 0.4 * Math.sin(t * TAU * 1.9 + gph[1])); };
  const kRoad = Math.min(3.2, CH * 0.36 / Math.max(1, rmax - rmin)), rmid = (rmin + rmax) / 2;
  const X = z => 40 + (z - z0) / (z1 - z0) * 432;
  const base = z => CH * (0.64 - 0.24 * (z - z0) / (z1 - z0));
  const Y = (z, x = Wd.roadX(z)) => base(z) - (Wd.roadX(z) - rmid) * kRoad * gain(z) - (x - Wd.roadX(z)) * 1.35;
  const road = []; for (let z = z0; z <= z1; z += 5) road.push([X(z), Y(z)]);
  const roadY = px => { let best = road[0]; for (const q of road) if (Math.abs(q[0] - px) < Math.abs(best[0] - px)) best = q; return best[1]; };
  // the land along the road
  for (let i = 0; i < 80; i++) { const z = z0 + rnd() * (z1 - z0), x = Wd.roadX(z) + range(rnd, -42, 42); blob(g, X(z), Y(z, x), range(rnd, 18, 40), range(rnd, 12, 26), 0, pick(rnd, B.land), 0.42, 0.15); }
  // margins: a lake (or a dry lake, or an oasis) where there's most room clear of the road and the
  // title, compass and notes; forest masses (fields, mesas, dunes) in the other open margins
  const dRoad = (px, py) => { let d = 1e9; for (const [a, b] of road) d = Math.min(d, Math.hypot((a - px) / 1.7, (b - py) / 0.8)); return d; };
  const furniture = [[0, 0, 300, 70], [CW - 90, 0, CW, 100], [CW - 280, CH - 34, CW, CH], [0, CH - 56, 150, CH]];
  const inFurn = (px, py, m = 0) => furniture.some(([x0, y0, x1, y1]) => px > x0 - m && px < x1 + m && py > y0 - m * 0.5 && py < y1 + m * 0.5);
  let lake = null;
  for (let py = 70; py <= CH - 50; py += 8) for (let px = 70; px <= CW - 70; px += 8) {
    let d = dRoad(px, py); d = Math.min(d, (px - 20) / 1.7, (CW - 20 - px) / 1.7, (py - 20) / 0.8, (CH - 20 - py) / 0.8);
    if (inFurn(px, py, 40)) continue;
    if (!lake || d > lake.d) lake = { cx: px, cy: py, d };
  }
  if (lake && lake.d > 22) {
    const r = Math.min(40, lake.d * 0.62), ly = lake.cy; lake.r = r;
    const pts = [], ph = [rnd() * TAU, rnd() * TAU];
    for (let k = 0; k <= 36; k++) { const a = k / 36 * TAU; pts.push([lake.cx + Math.cos(a) * r * 1.7 * (1 + 0.14 * Math.sin(a * 3 + ph[0])), ly + Math.sin(a) * r * 0.75 * (1 + 0.12 * Math.sin(a * 5 + ph[1]))]); }
    g.save(); g.beginPath(); pts.forEach(([a, b], i) => i ? g.lineTo(a, b) : g.moveTo(a, b)); g.closePath();
    g.fillStyle = rgba(B.water, 0.85); g.fill(); g.lineWidth = 1.4; g.strokeStyle = 'rgba(58,42,30,0.8)'; g.stroke(); g.clip();
    g.strokeStyle = 'rgba(58,42,30,0.25)'; g.lineWidth = 1; g.beginPath(); pts.forEach(([a, b], i) => { const q = [lake.cx + (a - lake.cx) * 0.8, ly + (b - ly) * 0.75]; i ? g.lineTo(...q) : g.moveTo(...q); }); g.stroke();
    if (Wd.biome === 'badlands') { g.strokeStyle = 'rgba(90,58,30,0.5)'; for (let k = 0; k < 14; k++) { const x = lake.cx + (rnd() - 0.5) * r * 3, y = ly + (rnd() - 0.5) * r * 1.2; g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 14, y + (rnd() - 0.5) * 8); g.stroke(); } }
    g.restore();
    doodle(g, B.critter, lake.cx, ly + 2, (Wd.biome === 'snow' ? 1.4 : 0.85) * Math.min(1, r / 32), rnd);
    if (Wd.biome === 'desert') for (let k = 0; k < 4; k++) tinyTree(g, 'palm', lake.cx + Math.cos(k * 1.7) * r * 1.9, ly + Math.sin(k * 1.7) * r * 0.9 + 4, rnd, 1.3);
  } else lake = null;
  const inLake = (px, py) => lake && ((px - lake.cx) / (lake.r * 2.1)) ** 2 + ((py - lake.cy) / (lake.r * 1.1)) ** 2 < 1;
  for (let f = 0; f < 8; f++) {
    const cx = range(rnd, 30, CW - 30), cy = range(rnd, 70, CH - 46);
    if (dRoad(cx, cy) < 30 || inLake(cx, cy) || inFurn(cx, cy, 10)) continue;
    if (Wd.biome === 'fields') {          // hatched field plots
      g.save(); g.translate(cx, cy); g.rotate(range(rnd, -0.3, 0.3));
      for (let k = 0; k < 3; k++) { const w = range(rnd, 16, 26), h = range(rnd, 9, 14), x = (k - 1) * 22 + range(rnd, -3, 3), y = range(rnd, -4, 4);
        g.beginPath(); g.rect(x - w / 2, y - h / 2, w, h); g.fillStyle = pick(rnd, ['#e8c870', '#d8b058', '#c8a048']); g.fill(); g.strokeStyle = 'rgba(58,42,30,0.7)'; g.lineWidth = 0.9; g.stroke();
        g.save(); g.clip(); g.strokeStyle = 'rgba(120,80,30,0.45)'; for (let m = -w; m < w; m += 3.5) { g.beginPath(); g.moveTo(x - w / 2 + m, y - h / 2); g.lineTo(x - w / 2 + m + h * 0.6, y + h / 2); g.stroke(); } g.restore(); }
      g.restore(); continue;
    }
    if (Wd.biome === 'badlands' || Wd.biome === 'desert') {   // a cluster of little mesas or dunes
      const n = 2 + Math.floor(rnd() * 3), list = [];
      for (let k = 0; k < n; k++) list.push([cx + (rnd() - 0.5) * 40, cy + (rnd() - 0.5) * 14, range(rnd, 0.6, 1.1)]);
      list.sort((a, b) => a[1] - b[1]);
      for (const [x, y, sc] of list) if (dRoad(x, y) > 22 && !inLake(x, y)) hillStamp(g, Wd.biome === 'badlands' ? 'mesa' : 'dune', x, y, 10 * sc, 9 * sc, B.hill, rnd);
      continue;
    }
    const n = 5 + Math.floor(rnd() * 6), pts = [];
    for (let k = 0; k < n; k++) pts.push([cx + (rnd() - 0.5) * 60, cy + (rnd() - 0.5) * 26]);
    pts.sort((a, b) => a[1] - b[1]);
    for (const [x, y] of pts) if (dRoad(x, y) > 16 && !inLake(x, y)) tinyTree(g, B.tree, x, y, rnd, 1.15);
  }
  // the canyon walls: clustered hill stamps, back to front
  const hills = [];
  for (const side of [-1, 1]) for (let z = z0 + 8; z < z1; z += range(rnd, 26, 42)) {
    const sc = range(rnd, 0.7, 1.4), x = Wd.roadX(z) + side * range(rnd, 32, 48);
    hills.push({ px: X(z) + range(rnd, -4, 4), py: Y(z, x), w: 11 * sc, h: 12 * sc, kind: pick(rnd, B.stamps) });
    if (rnd() < 0.15) hills.push({ px: X(z) + range(rnd, 4, 10), py: Y(z, x) + side * range(rnd, 4, 9), w: 8 * sc, h: 8 * sc, kind: pick(rnd, B.stamps) });
  }
  for (let i = hills.length - 1; i >= 0; i--) if (inLake(hills[i].px, hills[i].py) || inFurn(hills[i].px, hills[i].py)) hills.splice(i, 1);
  hills.sort((a, b) => a.py - b.py);
  for (const h of hills) {
    hillStamp(g, h.kind, h.px, h.py, h.w, h.h, B.hill, rnd);
    if (Wd.biome === 'snow' && h.kind === 'peak') { g.save(); g.beginPath(); g.moveTo(h.px - h.w * 0.5, h.py - h.h * 0.62); g.lineTo(h.px - h.w * 0.25, h.py - h.h * 1.2); g.lineTo(h.px + h.w * 0.02, h.py - h.h * 0.95); g.lineTo(h.px - h.w * 0.05, h.py - h.h * 0.66); g.closePath(); g.fillStyle = '#fbfbf6'; g.fill(); g.restore(); }
  }
  for (let i = 0; i < 24; i++) { const z = z0 + rnd() * (z1 - z0), side = rnd() < 0.5 ? -1 : 1, x = Wd.roadX(z) + side * range(rnd, 12, 28); if (!inLake(X(z), Y(z, x))) tinyTree(g, Wd.biome === 'badlands' && rnd() < 0.5 ? 'cactus' : B.tree, X(z), Y(z, x), rnd); }
  // fold creases and coffee
  for (const x of [CW / 3, CW * 2 / 3]) { g.fillStyle = 'rgba(120,90,50,0.16)'; g.fillRect(x - 1, 0, 2, CH); g.fillStyle = 'rgba(255,248,220,0.3)'; g.fillRect(x + 1, 0, 1.5, CH); }
  g.fillStyle = 'rgba(120,90,50,0.14)'; g.fillRect(0, CH / 2 - 1, CW, 2); g.fillStyle = 'rgba(255,248,220,0.28)'; g.fillRect(0, CH / 2 + 1, CW, 1.5);
  for (let i = 0; i < 2; i++) coffee(g, range(rnd, 60, CW - 60), range(rnd, 60, CH - 60), range(rnd, 14, 22), rnd);
  // the road: an inked double line with a dusty fill
  const path = () => { g.beginPath(); road.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); };
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  path(); g.strokeStyle = '#3a2a1e'; g.lineWidth = 8; g.stroke();
  path(); g.strokeStyle = '#c89a5e'; g.lineWidth = 5; g.stroke();
  path(); g.setLineDash([6, 7]); g.strokeStyle = 'rgba(90,58,30,0.6)'; g.lineWidth = 1; g.stroke(); g.setLineDash([]);
  g.restore();
  // ---- labels: every mark claims its box; each label takes the first free spot (then rings further
  // out, then the least crowded one) and gets a dotted leader when it lands away from its mark
  const taken = [];
  const inter = (a, b) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const cost = b => { let A = 0; for (const t of taken) A += inter(b, t); const out = Math.max(0, 12 - b[0]) + Math.max(0, b[2] - (CW - 12)) + Math.max(0, 12 - b[1]) + Math.max(0, b[3] - (CH - 12)); return A + out * 200; };
  const claim = b => taken.push(b);
  const claimLine = (x0, y0, x1, y1) => { const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 7); for (let k = 1; k < n; k++) { const t = k / n; claim([x0 + (x1 - x0) * t - 2.5, y0 + (y1 - y0) * t - 2.5, x0 + (x1 - x0) * t + 2.5, y0 + (y1 - y0) * t + 2.5]); } };
  const rings = []; for (const Rr of [22, 34, 48, 64, 84]) for (let k = 0; k < 12; k++) { const a = k / 12 * TAU + Rr; rings.push([Math.cos(a) * Rr * 1.3, Math.sin(a) * Rr * 0.85]); }
  const place = (x, y, w, h, offs) => {
    let best = null;
    for (const [dx, dy] of [...offs, ...rings]) {
      const cx = x + dx, cy = y + dy, b = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], c = cost(b);
      if (c === 0) { claim(b); return [cx, cy]; }
      if (!best || c < best.c) best = { c, cx, cy, b };
    }
    claim(best.b); return [best.cx, best.cy];
  };
  const leader = (ax, ay, lx, ly, color = 'rgba(58,42,30,0.55)') => { if (Math.hypot(lx - ax, ly - ay) < 26) return; g.save(); g.strokeStyle = color; g.lineWidth = 0.9; g.setLineDash([2, 2]); g.beginPath(); g.moveTo(ax, ay); g.lineTo(lx, ly); g.stroke(); g.restore(); claimLine(ax, ay, lx, ly); };
  const textW = (txt, size, italic = false) => { g.save(); g.font = `${italic ? 'italic ' : ''}bold ${size}px ${MAPFONT}`; const w = g.measureText(txt).width; g.restore(); return w; };
  // the fixed furniture first: the title banner, the compass, the note, the scale bar
  const bannerW = 250;
  claim([8, 6, 8 + bannerW + 32, 62]); claim([CW - 80, 10, CW - 6, 92]); claim([CW - 270, CH - 30, CW - 8, CH - 8]); claim([12, CH - 50, 140, CH - 18]);
  for (const [x, y] of road) claim([x - 5, y - 5, x + 5, y + 5]);
  if (lake) claim([lake.cx - lake.r * 1.6, lake.cy - lake.r * 0.7, lake.cx + lake.r * 1.6, lake.cy + lake.r * 0.7]);
  // distance ticks every 100 m from camp
  const ticks = [];
  for (let z = 0; z <= Wd.LEN; z += 100) { const px = X(z), py = Y(z); g.fillStyle = '#3a2a1e'; g.fillRect(px - 1, py + 5, 2, 6); ticks.push([z, px, py]); claim([px - 2, py + 4, px + 2, py + 12]); }
  // the marks themselves claim their spots before any label goes down
  const stops = Wd.pois.map(p => ({ ...p, px: X(p.z), py: Y(p.z, p.x) }));
  for (const s of stops) claim([s.px - 13, s.py - 13, s.px + 13, s.py + 13]);
  for (const l of Wd.landmarks) { const px = X(l.z), py = Y(l.z, l.x); claim([px - 9, py - 11, px + 9, py + 6]); }
  for (const o of Wd.obstacles) { const px = X(o.z), py = Y(o.z); claim([px - 6, py - 6, px + 6, py + 6]); }
  const campZ = Math.max(z0 + 10, -40), townZ = Math.min(z1 - 10, Wd.LEN + 60);
  const campP = [X(campZ), Y(campZ) + 30], townP = [X(townZ), Y(townZ) + 30];
  claim([campP[0] - 14, campP[1] - 14, campP[0] + 14, campP[1] + 14]); claim([townP[0] - 15, townP[1] - 15, townP[0] + 15, townP[1] + 15]);
  for (const [z, px, py] of ticks) { const [lx, ly] = place(px, py, 22, 10, [[0, 18], [0, -16], [12, 18], [-12, 18]]); inkText(g, String(z), lx, ly, { size: 9.5, weight: 'normal', clear: 0.5 }); }
  // the stops: a medallion on the spot, the name nearby (repeats numbered)
  // (a kind of stop that comes up more than once gets numbered medallions and one line in the legend)
  const counts = {}, seen = {}; for (const s of stops) counts[s.type] = (counts[s.type] || 0) + 1;
  const legend = Object.keys(counts).filter(t => counts[t] > 1);
  const lsize = stops.length - legend.reduce((a, t) => a + counts[t], 0) > 6 ? 9 : 10.5;
  if (legend.length) claim([12, CH - 56 - 14 * legend.length, 184, CH - 50]);
  for (const s of [...stops].sort((a, b) => a.z - b.z)) {
    seen[s.type] = (seen[s.type] || 0) + 1;
    const name = POI_NAMES[s.type] || s.type;
    mapIcon(g, s.type, s.px, s.py, 0.95);
    if (counts[s.type] > 1) {
      const bx = s.px + 11, by = s.py - 11;
      g.save(); g.beginPath(); g.arc(bx, by, 6.5, 0, TAU); g.fillStyle = '#1e3a5a'; g.fill(); g.lineWidth = 1; g.strokeStyle = '#f2e2b8'; g.stroke(); g.restore();
      inkText(g, ROMAN[seen[s.type] - 1], bx, by + 0.5, { size: 7.5, color: '#f2e2b8', halo: null, jit: 0 });
      continue;
    }
    const up = s.py < Y(s.z) ? -1 : 1, w = textW(name, lsize) + 6, extra = s.type === 'crash' ? 10 : 0;
    const [lx, ly] = place(s.px, s.py, w, 12 + extra, [[0, (22 + extra / 2) * up], [0, (34 + extra / 2) * up], [w / 2 + 17, 0], [-w / 2 - 17, 0], [0, -(22 + extra / 2) * up]]);
    leader(s.px, s.py, lx, ly);
    inkText(g, name, lx, ly - extra / 2, { size: lsize, color: '#1e3a5a', clear: 0.7 });
    if (extra) inkText(g, '(up the mesa)', lx, ly + 6, { size: 8.5, italic: true, weight: 'normal', color: '#1e3a5a' });
  }
  // obstacles in red ink: an X on the road, the sign and its name off to one side on a dotted leader
  for (const o of Wd.obstacles) {
    const px = X(o.z), py = Y(o.z), name = (OBST_NAMES[o.type] || o.type).toUpperCase(), w = Math.max(30, textW(name, 9.5)) + 6;
    const [cx, cy] = place(px, py, w, 30, [[0, -32], [0, 34], [w / 2 + 14, -26], [-w / 2 - 14, -26], [0, -52], [0, 54]]);
    const iy = cy + (cy < py ? 6 : -6), ly = cy + (cy < py ? -8 : 9);
    g.save(); g.strokeStyle = 'rgba(138,30,20,0.7)'; g.lineWidth = 1; g.setLineDash([2, 2]); g.beginPath(); g.moveTo(px, py + (cy < py ? -5 : 5)); g.lineTo(cx, iy + (cy < py ? 7 : -7)); g.stroke(); g.restore();
    claimLine(px, py, cx, iy);
    obstacleIcon(g, o.type, cx, iy);
    inkText(g, name, cx, ly, { size: 9.5, color: '#8a1e14', clear: 0.7 });
    g.save(); g.strokeStyle = '#a8241a'; g.lineWidth = 2; g.beginPath(); g.moveTo(px - 4, py - 4); g.lineTo(px + 4, py + 4); g.moveTo(px + 4, py - 4); g.lineTo(px - 4, py + 4); g.stroke(); g.restore();
  }
  // landmarks
  for (const l of Wd.landmarks) {
    const px = X(l.z), py = Y(l.z, l.x);
    if (l.kind === 'skull') {
      g.save(); g.translate(px, py); g.fillStyle = '#f2ead8'; g.strokeStyle = '#3a2a1e'; g.lineWidth = 1;
      g.beginPath(); g.ellipse(0, 0, 4, 5, 0, 0, TAU); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(-3, -3); g.quadraticCurveTo(-9, -6, -8, -10); g.moveTo(3, -3); g.quadraticCurveTo(9, -6, 8, -10); g.stroke();
      g.fillStyle = '#3a2a1e'; g.fillRect(-2.2, -1.5, 1.5, 1.5); g.fillRect(0.8, -1.5, 1.5, 1.5); g.restore();
      const [lx, ly] = place(px, py, 48, 10, [[0, 13], [0, -17], [32, 0], [-32, 0]]);
      leader(px, py, lx, ly);
      inkText(g, 'cow skull', lx, ly, { size: 9, italic: true, weight: 'normal', color: '#5a3a6a', clear: 0.6 });
    } else {
      g.save(); g.translate(px, py); g.strokeStyle = '#3a2a1e'; g.lineWidth = 1;
      g.fillStyle = '#8a6a40'; g.fillRect(-0.8, -2, 1.6, 7); g.fillStyle = '#e8d4a0'; g.fillRect(-7, -7, 14, 6); g.strokeRect(-7, -7, 14, 6); g.restore();
      const txt = `"${l.label}"`, w = textW(txt, 8.5, true) + 6;
      const [lx, ly] = place(px, py, w, 10, [[0, -14], [0, 13], [w / 2 + 11, -3], [-w / 2 - 11, -3], [0, -26], [0, 25]]);
      leader(px, py, lx, ly);
      inkText(g, txt, lx, ly, { size: 8.5, italic: true, weight: 'normal', color: '#5a3a6a', clear: 0.6 });
    }
  }
  // camp and town
  mapIcon(g, 'camp', campP[0], campP[1], 1.05);
  { const [lx, ly] = place(campP[0], campP[1], 36, 13, [[0, 21], [24, 0], [0, -21]]); inkText(g, 'CAMP', lx, ly, { size: 12, color: '#2d4a2a', clear: 0.7 }); }
  mapIcon(g, 'town', townP[0], townP[1], 1.15);
  { const [lx, ly] = place(townP[0], townP[1], 38, 13, [[0, 23], [-26, 0], [0, -23]]); inkText(g, 'TOWN', lx, ly, { size: 12, color: '#2d4a2a', clear: 0.7 }); }
  // the legend for the numbered stops
  legend.forEach((t, i) => {
    const y = CH - 62 - 14 * (legend.length - 1 - i), n = counts[t];
    mapIcon(g, t, 22, y, 0.45);
    inkText(g, `${ROMAN[0]}\u2013${ROMAN[n - 1]}  ${POI_NAMES[t] || t}${n > 1 ? 's' : ''}`, 33, y + 0.5, { size: 9.5, color: '#1e3a5a', align: 'left', clear: 0.6 });
  });
  // the title on a scroll banner with curled ends
  {
    const x0 = 24, x1 = x0 + bannerW, y0 = 16, h = 36, wv = x => Math.sin((x - x0) / bannerW * Math.PI * 2) * 2.5;
    g.save();
    for (const [ex, sx] of [[x0, -1], [x1, 1]]) {
      g.beginPath(); g.moveTo(ex, y0 + 8 + wv(ex)); g.lineTo(ex + sx * 18, y0 + 4); g.lineTo(ex + sx * 11, y0 + h / 2 + 6); g.lineTo(ex + sx * 18, y0 + h + 8); g.lineTo(ex, y0 + h + wv(ex)); g.closePath();
      g.fillStyle = '#c8a870'; g.fill(); g.strokeStyle = '#3a2a1e'; g.lineWidth = 1.3; g.stroke();
      g.beginPath(); g.ellipse(ex + sx * 2, y0 + h - 2 + wv(ex), 3.5, 5.5, 0, 0, TAU); g.fillStyle = '#a8885a'; g.fill(); g.stroke();
    }
    g.beginPath(); g.moveTo(x0, y0 + wv(x0)); for (let x = x0; x <= x1; x += 6) g.lineTo(x, y0 + wv(x)); g.lineTo(x1, y0 + wv(x1)); for (let x = x1; x >= x0; x -= 6) g.lineTo(x, y0 + h + wv(x)); g.closePath();
    g.fillStyle = '#f2e2b8'; g.fill(); g.strokeStyle = '#3a2a1e'; g.lineWidth = 1.5; g.stroke();
    g.clip(); blob(g, x0 + 40, y0 + 10, 60, 10, 0, '#fffbe8', 0.4, 0.3); blob(g, x1 - 40, y0 + h - 6, 70, 10, 0, '#c8a870', 0.3, 0.3);
    g.restore();
    inkText(g, `Day ${Wd.day}: ${Wd.biomeName || 'The Road'}`, (x0 + x1) / 2, y0 + 13, { size: 14, halo: null, jit: 0.06 });
    inkText(g, `${Wd.LEN} m to town`, (x0 + x1) / 2, y0 + 27, { size: 11, weight: 'normal', italic: true, halo: null });
  }
  inkText(g, '(no GPS. ask the driver what the odometer says.)', CW - 14, CH - 18, { size: 9.5, italic: true, weight: 'normal', align: 'right', color: '#5a4030' });
  compassRose(g, CW - 44, 54, 26);
  const sb = (X(100) - X(0));
  g.fillStyle = '#3a2a1e'; g.fillRect(20, CH - 30, sb, 3); g.fillStyle = '#f2e2b8'; g.fillRect(20 + sb / 2, CH - 29.5, sb / 2, 2);
  inkText(g, '100 m', 20 + sb / 2, CH - 40, { size: 9, weight: 'normal' });
  // the edges: torn paper, aged a little toward them; three to five burnt bites eating in, each a
  // deep char with a scorched halo fading into the paper and a faint ember line
  const edge = [], tj = (t, k) => 2.2 + 1.1 * Math.sin(t * 0.21 + k * 1.3) + 0.8 * Math.sin(t * 0.67 + k * 2.1) + range(rnd, 0, 1.3);
  for (let x = 0; x <= CW; x += 3) edge.push([x, tj(x, 1)]);
  for (let y = 0; y <= CH; y += 3) edge.push([CW - tj(y, 2), y]);
  for (let x = CW; x >= 0; x -= 3) edge.push([x, CH - tj(x, 3)]);
  for (let y = CH; y >= 0; y -= 3) edge.push([tj(y, 4), y]);
  const edgePath = () => { g.beginPath(); edge.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); };
  g.save(); g.filter = 'blur(6px)'; g.strokeStyle = 'rgba(168,128,72,0.4)'; g.lineWidth = 18; edgePath(); g.stroke(); g.restore();
  g.save(); g.beginPath(); g.rect(0, 0, CW, CH); edge.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fillStyle = '#6a5034'; g.fill('evenodd'); g.restore();
  g.save(); g.strokeStyle = 'rgba(120,88,52,0.7)'; g.lineWidth = 1; edgePath(); g.stroke(); g.restore();
  const nB = 3 + Math.floor(rnd() * 3), sides = [0, 1, 2, 3].sort(() => rnd() - 0.5);
  for (let i = 0; i < nB; i++) {
    const side = sides[i % 4], t = range(rnd, 0.15, 0.85), R = range(rnd, 14, 34);
    const [ex, ey] = side === 0 ? [t * CW, -4] : side === 1 ? [CW + 4, t * CH] : side === 2 ? [t * CW, CH + 4] : [-4, t * CH];
    const pts = []; for (let k = 0; k < 30; k++) { const a = k / 30 * TAU, r = R * (0.78 + 0.18 * Math.sin(a * 3 + i * 1.7) + 0.1 * Math.sin(a * 7 + i) + range(rnd, -0.08, 0.08)); pts.push([Math.cos(a) * r * 1.4, Math.sin(a) * r]); }
    const at = k => { g.beginPath(); pts.forEach(([x, y], j) => j ? g.lineTo(ex + x * k, ey + y * k) : g.moveTo(ex + x * k, ey + y * k)); g.closePath(); };
    g.save(); g.filter = 'blur(8px)'; at(1.5); g.fillStyle = 'rgba(138,90,42,0.55)'; g.fill(); g.restore();
    g.save(); g.filter = 'blur(2.5px)'; at(1.15); g.fillStyle = 'rgba(96,54,22,0.85)'; g.fill(); g.restore();
    at(1); g.fillStyle = '#2a160c'; g.fill();
    g.save(); g.strokeStyle = 'rgba(214,120,44,0.4)'; g.lineWidth = 1.2; at(1.02); g.stroke(); g.restore();
  }
  if (W) mapCache.set(W, cv);
  return cv;
}

// a stand-in leg for previews (the real one comes from shared/world.js)
function demoWorld() {
  return {
    seed: 1, day: 1, LEN: 900, Z0: -90, Z1: 1075, biome: 'meadow', biomeName: 'The Westmeadow Road',
    roadX: z => 22 * Math.sin(z / 95) + 7 * Math.sin(z / 33),
    pois: [{ type: 'gas', z: 140 }, { type: 'yard', z: 300 }, { type: 'crash', z: 470 }, { type: 'semi', z: 560 }, { type: 'junk', z: 640 }, { type: 'semi', z: 720 }, { type: 'dino', z: 790 }].map((p, i) => ({ ...p, x: 22 * Math.sin(p.z / 95) + 7 * Math.sin(p.z / 33) + (i % 2 ? -18 : 20) })),
    obstacles: [{ type: 'mud', z: 220, id: 0 }, { type: 'boulder', z: 400, id: 1 }, { type: 'grade', z: 520, id: 2 }, { type: 'gate', z: 680, id: 3 }],
    landmarks: [{ kind: 'billboard', z: 250, x: 30, label: 'LUCKY SLOP' }, { kind: 'skull', z: 705, x: -30 }],
  };
}

// ---- building ------------------------------------------------------------------------------------

const geoCache = new Map();
let paperW = null, paperM = null, demoPaper = null;
function paperMat(W) {
  if (!W) return demoPaper ||= new THREE.MeshLambertMaterial({ map: canvasTex(mapCanvas(null)) });
  if (paperW !== W) {      // only today's map stays on the GPU
    if (paperM) { paperM.map?.dispose(); paperM.dispose(); }
    paperW = W; paperM = new THREE.MeshLambertMaterial({ map: canvasTex(mapCanvas(W)) });
  }
  return paperM;
}
let paperGeo = null;
function mapPaper() {
  if (paperGeo) return paperGeo;
  const g = new THREE.PlaneGeometry(0.36, 0.264, 6, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const k = Math.round((p.getX(i) / 0.36 + 0.5) * 6); p.setZ(i, (k % 2 ? 0.003 : 0) + (k === 3 ? 0.0015 : 0)); }
  g.rotateX(-Math.PI / 2);
  g.computeVertexNormals();
  return paperGeo = g;
}
function geoOf(type) {
  if (!geoCache.has(type)) {
    const make = BUILDERS[type];
    geoCache.set(type, make ? make() : new Build().add(rbox(0.3, 0.3, 0.3, 0.04), R.wood, { uv: 'box' }).done());
  }
  return geoCache.get(type);
}
const BIOMES = ['meadow', 'fields', 'snow', 'badlands', 'desert'];

export function buildProp(type, W) {
  if (type === 'boulder') {
    const biome = BIOMES.includes(W?.biome) ? W.biome : 'meadow';
    const key = 'boulder-' + biome;
    if (!geoCache.has(key)) geoCache.set(key, boulderGeo(biome));
    const { body, cover } = geoCache.get(key);
    const grp = new THREE.Group();
    grp.add(shadowy(new THREE.Mesh(body, painted(`loot_boulder_${biome}`, { repeat: [2, 1], vertexColors: true }))));
    const cm = painted(`loot_cover_${biome}`, { alphaTest: 0.5, vertexColors: true });
    cm.polygonOffset = true; cm.polygonOffsetFactor = -2; cm.polygonOffsetUnits = -2;
    grp.add(shadowy(new THREE.Mesh(cover, cm), false, true));
    return grp;
  }
  const mesh = new THREE.Mesh(geoOf(type), lootMat());
  if (type === 'map') {
    const g = new THREE.Group();
    g.add(mesh);
    const paper = new THREE.Mesh(mapPaper(), paperMat(W));
    paper.position.set(0.012, 0.0075, 0);
    g.add(paper);
    return shadowy(g);
  }
  return shadowy(mesh);
}

// Optional: paint the atlas and build every prop's geometry in idle slices, so the first props
// (and a new biome's boulder) don't stall the frame they arrive in.
export function prewarm(W) {
  const idle = (typeof window !== 'undefined' && window.requestIdleCallback) || (f => setTimeout(f, 30));
  const jobs = [() => lootMat(), ...Object.keys(BUILDERS).map(k => () => geoOf(k)), () => { if (W) buildProp('boulder', W); }, () => { if (W) paperMat(W); }];
  const step = () => { const j = jobs.shift(); if (!j) return; try { j(); } catch (e) { console.warn('props prewarm', e); } idle(step); };
  idle(step);
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
  // the same, turned round to show the back
  ...Object.fromEntries(['tv', 'slot', 'safe', 'gnome', 'dino', 'painting', 'neon'].map(k => [`b_${k}`, () => {
    const o = buildProp(k, null), bb = new THREE.Box3().setFromObject(o), s = bb.getSize(new V3());
    const g = new THREE.Group(); g.add(o); o.scale.setScalar(1.6 / Math.max(s.x, s.y, s.z)); o.rotation.y = Math.PI; return g;
  }])),
  // the map sheet standing up, big, for reading it
  mapsheet: (o = {}) => { const W = { ...demoWorld(), biome: o.biome || 'meadow', day: BIOMES.indexOf(o.biome || 'meadow') + 1 }; const m = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.19), new THREE.MeshBasicMaterial({ map: canvasTex(mapCanvas(W)), side: THREE.DoubleSide })); m.position.y = 0.7; const g = new THREE.Group(); g.add(m); return g; },
};
