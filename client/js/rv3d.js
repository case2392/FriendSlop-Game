// The Slopmaster 9000, as seen from outside and in: a 1970s motorhome rebuilt the way Blizzard's
// 2004 artists would have built it for a goblin zone. A cream riveted body painted as one atlas
// (rv_body), a heavy crowned roof lofted round a rounded plan with a rolled eave and a cab-over brow
// that overhangs the windshield (the gold/orange/brown livery wraps over it), an oak rub rail, fat
// tires under flared fenders, brass lamps, riveted iron, a goblin winch, and the clutter of a
// caravan that lives on the road: an awning, a lantern by the door, a cask and a crate, tools,
// cargo all along the roof. Inside: an inn room on wheels.
//
// Draw calls: everything static is merged per material, per group: the main body, the roof (a
// Repo Man part), the rear wall and the door (the other Repo Man part). The wheels and the tow strap
// are instanced. ~30 meshes in all. Interior furniture is a separate trim mesh that casts no shadow
// while the roof is on. The interior matches shared/rv.js (RV_PARTS) box for box: walls, floor,
// roof, door, dash, seats, table, benches, counter, shower stall, bunks, steps and bumpers.
// Biome-dependent: the road grime's tint, the day-3 snow and icicles, and a small prop set per
// biome (atmo.biome).
import { THREE, painted, tex, canvasTex } from './gfx.js';
import { atmo } from './atmosphere.js';
import { canvasFor, meta, rngFrom } from './paint/index.js';
import { mergeGeometries, toCreasedNormals } from '/vendor/BufferGeometryUtils.js';
import { RV_DIM, RV_WHEELS, SUSP_REST, RV_WINCH, RV_PARTS } from '/shared/rv.js';
import { RV_ART as A, TRIM, SOFT, LAMPS, BODY, ROOF_MAP, LETTER_FONT } from './paint/vehicle.js';

const D = RV_DIM, PI = Math.PI, TAU = PI * 2;
const V3 = THREE.Vector3, V2 = THREE.Vector2;
const HW = D.HALF_W, HL = D.HALF_L, WH = D.WALL_H;   // 1.25, 4.0, 2.3
const IN = HW - 0.1;                                   // inner face of the walls
const WHEEL_Y = RV_WHEELS[0][1] - SUSP_REST;           // wheel centers at rest (-0.86)
const DRUM = { x: RV_WINCH.x, y: RV_WINCH.y, z: RV_WINCH.z + 0.07 };
const CABLE_START = new V3(RV_WINCH.x, RV_WINCH.y, RV_WINCH.z + 0.21);
const HOOK_STOW = new V3(RV_WINCH.x, RV_WINCH.y + 0.02, RV_WINCH.z + 0.25);
const BIOMES = ['meadow', 'fields', 'snow', 'badlands', 'desert'];

// per-biome road grime [tint, opacity]: Elwynn mud, Westfall golden dust, Dun Morogh slush,
// Badlands red dust, Tanaris sand
const GRIME = { meadow: ['#6e5638', 0.85], fields: ['#b8975a', 0.9], snow: ['#9aa4b2', 0.88], badlands: ['#b04a22', 0.92], desert: ['#d2ac70', 0.9] };

// ---- geometry helpers ----------------------------------------------------------------------------

// non-indexed position/normal/uv, ready to merge
function prep(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  g.clearGroups();
  return g;
}
const ICE = new THREE.Color('#a8bed8'), SNOWW = new THREE.Color('#f6f8fc');
class Bucket {
  constructor() { this.list = []; }
  add(geo) { this.list.push(prep(geo)); return geo; }
  mesh(mat, cast = true, snow = false) {
    if (!this.list.length) return null;
    const g = mergeGeometries(this.list);
    if (snow) {
      // icy blue on the undersides and the hanging faces, white where the sky sees it
      const n = g.attributes.normal, c = new Float32Array(n.count * 3), t = new THREE.Color();
      for (let k = 0; k < n.count; k++) { const s = Math.max(0, Math.min(1, (n.getY(k) + 0.25) / 0.95)); t.copy(ICE).lerp(SNOWW, s * s * (3 - 2 * s)); c[k * 3] = t.r; c[k * 3 + 1] = t.g; c[k * 3 + 2] = t.b; }
      g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    }
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = cast; m.receiveShadow = true;
    return m;
  }
}
const KINDS = ['body', 'trim', 'itrim', 'panel', 'floor', 'soft', 'glass', 'lamps', 'snow', 'grime', 'ceil', 'glow', ...BIOMES.map(b => 'bio_' + b)];
const buckets = () => Object.fromEntries(KINDS.map(k => [k, new Bucket()]));

const _o = new THREE.Object3D();
// place a geometry: scale, then rotate (XYZ), then move
function at(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) {
  _o.position.set(x, y, z); _o.rotation.set(rx, ry, rz);
  if (Array.isArray(s)) _o.scale.set(s[0], s[1], s[2]); else _o.scale.setScalar(s);
  _o.updateMatrix();
  geo.applyMatrix4(_o.matrix);
  return geo;
}
// swap the winding of every triangle (and turn the normals around)
function flip(geo) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  for (const key of Object.keys(g.attributes)) {
    const a = g.attributes[key], n = a.itemSize, arr = a.array;
    for (let t = 0; t < a.count; t += 3) for (let c = 0; c < n; c++) { const i1 = (t + 1) * n + c, i2 = (t + 2) * n + c, tmp = arr[i1]; arr[i1] = arr[i2]; arr[i2] = tmp; }
  }
  if (g.attributes.normal) { const nn = g.attributes.normal.array; for (let i = 0; i < nn.length; i++) nn[i] = -nn[i]; }
  return g;
}
// orient a geometry along a direction: built along +Y, turned to point along d
const _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
function along(geo, from, to) {
  const a = new V3(...from), b = new V3(...to), d = b.clone().sub(a), L = d.length();
  _q.setFromUnitVectors(new V3(0, 1, 0), d.normalize());
  geo.applyMatrix4(_m4.makeRotationFromQuaternion(_q));
  geo.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return geo;
}

// ---- uv mapping ----------------------------------------------------------------------------------

const BAND = TRIM.band / TRIM.H;
// a geometry's 0..1 uv into trim band i; u repeats `ur` times along the band
function toBand(geo, i, ur = 1) {
  const uv = geo.attributes.uv, top = 1 - i * BAND - 2 / TRIM.H, bot = 1 - (i + 1) * BAND + 2 / TRIM.H;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * ur, bot + uv.getY(k) * (top - bot));
  return geo;
}
// into a 64² decal slot (bands 14/27) or a 128×64 slot (band 15)
function toSlot(geo, i, bi = TRIM.slots, sw = 64) {
  const uv = geo.attributes.uv;
  const u0 = (i * sw + 1.5) / TRIM.W, u1 = ((i + 1) * sw - 1.5) / TRIM.W;
  const top = 1 - (bi * TRIM.band + 1.5) / TRIM.H, bot = 1 - ((bi + 1) * TRIM.band - 1.5) / TRIM.H;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * (u1 - u0), bot + uv.getY(k) * (top - bot));
  return geo;
}
const toWide = (geo, i) => toSlot(geo, i, TRIM.wide, 128);
const toSlot2 = (geo, i) => toSlot(geo, i, TRIM.slots2);
// into a pixel region [x, y, w, h] of a W×H atlas
function toRegion(geo, [x, y, w, h], W = 512, H = W, inset = 1.5) {
  const uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, (x + inset + uv.getX(k) * (w - 2 * inset)) / W, 1 - (y + inset + (1 - uv.getY(k)) * (h - 2 * inset)) / H);
  return geo;
}
const toLamp = (geo, region) => toRegion(geo, region, LAMPS.W, LAMPS.H);
function setUV(geo, fn) {
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let k = 0; k < p.count; k++) { const [u, v] = fn(p.getX(k), p.getY(k), p.getZ(k)); uv.setXY(k, u, v); }
  return geo;
}
// box projection: each face picks its two in-plane axes; u runs along the longer one (in meters ×
// density, so it tiles along a band), v across the shorter one (0..1 over the piece)
function boxUV(geo, density = 1.2) {
  geo.computeBoundingBox();
  const mn = geo.boundingBox.min, ext = geo.boundingBox.getSize(new V3());
  const E = [ext.x, ext.y, ext.z], M = [mn.x, mn.y, mn.z];
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  for (let k = 0; k < p.count; k++) {
    const nx = Math.abs(n.getX(k)), ny = Math.abs(n.getY(k)), nz = Math.abs(n.getZ(k));
    let a, b;
    if (nx >= ny && nx >= nz) [a, b] = [2, 1]; else if (ny >= nz) [a, b] = [0, 2]; else [a, b] = [0, 1];
    if (E[b] > E[a]) [a, b] = [b, a];
    const P = [p.getX(k), p.getY(k), p.getZ(k)];
    uv.setXY(k, (P[a] - M[a]) * density, E[b] > 1e-6 ? (P[b] - M[b]) / E[b] : 0.5);
  }
  return geo;
}

// ---- primitives ----------------------------------------------------------------------------------

const beam = (w, h, d, band, density = 1.2) => toBand(boxUV(new THREE.BoxGeometry(w, h, d), density), band);
// a rod along Y: u along its length, v around it (kept mid-band so painted light stays soft)
function rod(r, len, band, { segs = 8, density = 1.2, r2 = r, open = false } = {}) {
  const g = new THREE.CylinderGeometry(r2, r, len, segs, 1, open);
  const uv = g.attributes.uv;
  for (let k = 0; k < uv.count; k++) { const u = uv.getX(k), v = uv.getY(k); uv.setXY(k, v * len * density + u * 0.01, 0.5 + 0.36 * Math.cos(u * TAU)); }
  return toBand(g, band);
}
const rodAB = (r, a, b, band, opts) => along(rod(r, new V3(...a).distanceTo(new V3(...b)), band, opts), a, b);
const ring = (r, tube, band, segs = 18, arc = TAU, ur = 1) => toBand(new THREE.TorusGeometry(r, tube, 6, segs, arc), band, ur);
// rounded box with analytic (smooth) normals; seg 2 = puffy cushion, seg 3+ = flatter faces
function rbox(w, h, d, r, seg = 2) {
  const g = new THREE.BoxGeometry(w, h, d, seg, seg, seg);
  const p = g.attributes.position, n = g.attributes.normal;
  const hx = w / 2 - r, hy = h / 2 - r, hz = d / 2 - r, v = new V3(), c = new V3();
  for (let k = 0; k < p.count; k++) {
    v.fromBufferAttribute(p, k);
    c.set(Math.max(-hx, Math.min(hx, v.x)), Math.max(-hy, Math.min(hy, v.y)), Math.max(-hz, Math.min(hz, v.z)));
    v.sub(c);
    if (v.lengthSq() < 1e-12) continue;
    v.normalize();
    n.setXYZ(k, v.x, v.y, v.z);
    p.setXYZ(k, c.x + v.x * r, c.y + v.y * r, c.z + v.z * r);
  }
  return g;
}
const rboxB = (w, h, d, r, band, seg = 2, density = 1.2) => toBand(boxUV(rbox(w, h, d, r, seg), density), band);
function lathe(pts, band, segs = 12, ur = 1) {
  return toBand(new THREE.LatheGeometry(pts.map(([r, y]) => new V2(r, y)), segs), band, ur);
}
// a partial open cylinder along Y (corner caps)
function post(r, h, band, th0 = 0, thL = TAU, segs = 10) {
  const g = new THREE.CylinderGeometry(r, r, h, segs, 1, true, th0, thL);
  const uv = g.attributes.uv;
  for (let k = 0; k < uv.count; k++) { const u = uv.getX(k), v = uv.getY(k); uv.setXY(k, v * h * 1.2, 0.12 + 0.76 * u); }
  return toBand(g, band);
}
// a wavy hanging cloth (curtains): a thin slab whose surface folds along z
function cloth(w, h, depth, folds, band) {
  const g = new THREE.BoxGeometry(depth, h, w, 1, 1, Math.max(4, folds * 4));
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) p.setX(k, p.getX(k) + Math.sin((p.getZ(k) / w + 0.5) * folds * TAU) * depth * 0.9);
  g.computeVertexNormals();
  return toBand(boxUV(g, 0.6), band);
}
// lumpy: push the top of a geometry around (snow caps, sand drifts, sacks)
function lumpy(geo, amp, seed = 0) {
  const p = geo.attributes.position;
  for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k), z = p.getZ(k); if (y > 0) p.setY(k, y + amp * (Math.sin(x * 9.1 + seed) * Math.cos(z * 7.3 + seed * 2) * 0.6 + Math.sin(x * 3.1 + z * 4.7 + seed) * 0.4)); }
  geo.computeVertexNormals();
  return geo;
}
// a little snow cap (rounded top, lumpy) to sit on a ledge
const snowCap = (w, d, h = 0.07, seed = 0) => lumpy(rbox(w, h, d, Math.min(h * 0.48, w / 2, d / 2), 3), h * 0.25, seed);
// a flat quad in XZ (normal +y) with explicit corner uvs: [u,v] at (x0,z0), (x1,z0), (x1,z1), (x0,z1)
function quadXZ(x0, x1, z0, z1, y, uvs) {
  const g = new THREE.BufferGeometry();
  const P = [[x0, y, z0], [x1, y, z0], [x1, y, z1], [x0, y, z1]];
  const idx = [0, 2, 1, 0, 3, 2];
  g.setAttribute('position', new THREE.Float32BufferAttribute(idx.flatMap(i => P[i]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(idx.flatMap(() => [0, 1, 0]), 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(idx.flatMap(i => uvs[i]), 2));
  return g;
}
// a quad facing +z (lamp halos), mapped to a lamps region
const halo = (s, region = LAMPS.halo) => toLamp(new THREE.PlaneGeometry(s, s), region);

// A grid surface rows × cols (cols wrap if closed), smooth normals from the faces, oriented so
// they agree with outward(i, j, p) on average. part() cuts rows [i0..i1] out with its own uvs, so
// several materials share one smooth surface.
function gridSurface(rows, cols, posFn, outward, closed = false) {
  const P = [];
  for (let i = 0; i < rows; i++) { P.push([]); for (let j = 0; j < cols; j++) P[i].push(new V3(...posFn(i, j))); }
  const N = P.map(r => r.map(() => new V3()));
  const e1 = new V3(), e2 = new V3(), n = new V3();
  const add = (a, b, c) => { e1.subVectors(b, a); e2.subVectors(c, a); n.crossVectors(e1, e2); return n; };
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
    const p00 = P[i][j], p01 = P[i][j + 1], p11 = P[i + 1][j + 1], p10 = P[i + 1][j];
    add(p00, p01, p11); N[i][j].add(n); N[i][j + 1].add(n); N[i + 1][j + 1].add(n);
    add(p00, p11, p10); N[i][j].add(n); N[i + 1][j + 1].add(n); N[i + 1][j].add(n);
  }
  if (closed) for (let i = 0; i < rows; i++) { const s = N[i][0].clone().add(N[i][cols - 1]); N[i][0].copy(s); N[i][cols - 1].copy(s); }
  let dot = 0;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const v = N[i][j];
    if (v.lengthSq() < 1e-14) v.set(0, 1, 0); else v.normalize();
    const o = outward(i, j, P[i][j]);
    if (o) dot += v.dot(o);
  }
  const flipIt = dot < 0;
  if (flipIt) for (const r of N) for (const v of r) v.negate();
  return {
    P, N,
    part(i0, i1, uvFn) {
      const pos = [], nrm = [], uv = [];
      const put = (i, j) => { const p = P[i][j], q = N[i][j]; pos.push(p.x, p.y, p.z); nrm.push(q.x, q.y, q.z); uv.push(...uvFn(i, j, p)); };
      for (let i = i0; i < i1; i++) for (let j = 0; j < cols - 1; j++) {
        const tri = flipIt ? [[i, j], [i + 1, j + 1], [i, j + 1], [i, j], [i + 1, j], [i + 1, j + 1]] : [[i, j], [i, j + 1], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i + 1, j]];
        for (const [a, b] of tri) put(a, b);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      return g;
    },
  };
}

// ---- shapes --------------------------------------------------------------------------------------

function rr(path, x0, y0, x1, y1, r) {
  path.moveTo(x0 + r, y0); path.lineTo(x1 - r, y0); path.quadraticCurveTo(x1, y0, x1, y0 + r);
  path.lineTo(x1, y1 - r); path.quadraticCurveTo(x1, y1, x1 - r, y1); path.lineTo(x0 + r, y1);
  path.quadraticCurveTo(x0, y1, x0, y1 - r); path.lineTo(x0, y0 + r); path.quadraticCurveTo(x0, y0, x0 + r, y0);
  return path;
}
const holeOf = o => { const p = new THREE.Path(); if (o.r) p.absarc(o.z, o.y, o.r, 0, TAU, false); else rr(p, o.z0, o.y0, o.z1, o.y1, 0.08); return p; };
const doorHole = () => rr(new THREE.Path(), A.door.z0, A.door.y0, A.door.z1, A.door.y1, 0.1);

// A flat wall from a shape drawn in (a, y): on the plane x = pos (a → z) or z = pos (a → x), facing
// ±1 along that axis.
function wallGeo(shape, axis, pos, facing, segs = 10) {
  const sg = new THREE.ShapeGeometry(shape, segs);
  const g = sg.toNonIndexed();
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) {
    const a = p.getX(k), y = p.getY(k);
    if (axis === 'x') p.setXYZ(k, pos, y, a); else p.setXYZ(k, a, y, pos);
  }
  if (facing !== (axis === 'x' ? -1 : 1)) flip(g);
  g.computeVertexNormals();
  return g;
}
// Extrude a shape drawn in (a, y) through a wall: axis 'x' → a is z and the extrusion runs along x
// from x0 in direction s; axis 'z' → a is x, the extrusion runs along z.
function throughWall(shape, axis, x0, s, depth, { bevel = 0, segs = 6 } = {}) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, curveSegments: segs });
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) {
    const a = p.getX(k), y = p.getY(k), e = p.getZ(k);
    if (axis === 'x') p.setXYZ(k, x0 + s * e, y, a); else p.setXYZ(k, a, y, x0 + s * e);
  }
  if ((axis === 'x') === (s > 0)) flip(g);
  g.computeVertexNormals();
  return toCreasedNormals(g, 0.7);
}
// a profile drawn in (a = outward from the side wall, y), extruded `depth` along z, centred on zc
function sideProfile(shape, side, zc, depth, segs = 6) {
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: segs });
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) { const a = p.getX(k), y = p.getY(k), e = p.getZ(k); p.setXYZ(k, side * (HW + a), y, zc - depth / 2 + e); }
  if (side < 0) flip(g);
  g.computeVertexNormals();
  return toCreasedNormals(g, 0.7);
}
// a window frame: the opening grown by `grow`, extruded `depth` through the wall
function frameShape(o, grow, r = 0.08) {
  const s = new THREE.Shape();
  if (o.r) { s.absarc(0, 0, o.r + grow, 0, TAU, false); s.holes.push(new THREE.Path().absarc(0, 0, o.r, 0, TAU, true)); return s; }
  const hw = (o.z1 - o.z0) / 2, hh = (o.y1 - o.y0) / 2;
  rr(s, -hw - grow, -hh - grow, hw + grow, hh + grow, r + grow * 0.6);
  s.holes.push(rr(new THREE.Path(), -hw, -hh, hw, hh, r));
  return s;
}

// ---- atlas uv functions (local RV frame) ---------------------------------------------------------

const BV = py => 1 - py / BODY.H;
const clampY = y => Math.max(A.y0, Math.min(A.y1, y));
const uvSideR = (x, y, z) => [(z + HL) * BODY.sidePx / BODY.W, BV(BODY.R + (A.y1 - clampY(y)) * BODY.sidePx)];
const uvSideL = (x, y, z) => [(HL - z) * BODY.sidePx / BODY.W, BV(BODY.L + (A.y1 - clampY(y)) * BODY.sidePx)];
const endPX = BODY.endW / 2.5, endPY = BODY.endW / 3;
const uvFront = (x, y) => [(BODY.front + (Math.max(-HW, Math.min(HW, x)) + HW) * endPX) / BODY.W, BV(BODY.endY + (A.y1 - clampY(y)) * endPY)];
const uvRear = (x, y) => [(BODY.rear + (HW - Math.max(-HW, Math.min(HW, x))) * endPX) / BODY.W, BV(BODY.endY + (A.y1 - clampY(y)) * endPY)];
const RM = ROOF_MAP;
const uvRoof = (x, z) => [(BODY.roof + (Math.max(RM.z0, Math.min(RM.z1, z)) - RM.z0) / (RM.z1 - RM.z0) * 512) / BODY.W, BV(BODY.endY + (RM.x1 - Math.max(RM.x0, Math.min(RM.x1, x))) / (RM.x1 - RM.x0) * 256)];
const uvPanelZ = (x, y, z) => [z / 3.2, y / WH];
const uvPanelX = (x, y) => [x / 3.2, y / WH];
const GV = (y) => (y - A.y0) / (1.02 - A.y0);      // grime v over y0..1.02

// ---- the roof: a lofted plan ---------------------------------------------------------------------

// A rounded rectangle in plan: half-width ax, z from z0 (rear) to z1 (front), rear and front corner
// radii. Always the same number of points (rings of different sizes correspond point for point);
// each point carries its outward plan normal and its "frontness" w (1 on the front, 0 elsewhere).
const SEG = { f: 3, c: 6, s: 22, r: 6 };
function ringPts(ax, z0, z1, rr0, rf0) {
  ax = Math.max(0, ax);
  const rr2 = Math.max(0, Math.min(rr0, ax, (z1 - z0) / 2)), rf = Math.max(0, Math.min(rf0, ax, (z1 - z0) / 2));
  const pts = [], push = (x, z, nx, nz, w) => pts.push({ x, z, nx, nz, w });
  for (let i = 0; i < SEG.f; i++) push(i / SEG.f * (ax - rf), z1, 0, 1, 1);
  for (let i = 0; i < SEG.c; i++) { const th = PI / 2 * (1 - i / SEG.c); push(ax - rf + rf * Math.cos(th), z1 - rf + rf * Math.sin(th), Math.cos(th), Math.sin(th), Math.sin(th) ** 2); }
  for (let i = 0; i < SEG.s; i++) push(ax, (z1 - rf) + i / SEG.s * ((z0 + rr2) - (z1 - rf)), 1, 0, 0);
  for (let i = 0; i < SEG.c; i++) { const th = -PI / 2 * i / SEG.c; push(ax - rr2 + rr2 * Math.cos(th), z0 + rr2 + rr2 * Math.sin(th), Math.cos(th), Math.sin(th), 0); }
  for (let i = 0; i < SEG.r * 2; i++) push((ax - rr2) * (1 - 2 * i / (SEG.r * 2)), z0, 0, -1, 0);
  for (let i = 0; i < SEG.c; i++) { const th = -PI / 2 - PI / 2 * i / SEG.c; push(-ax + rr2 + rr2 * Math.cos(th), z0 + rr2 + rr2 * Math.sin(th), Math.cos(th), Math.sin(th), 0); }
  for (let i = 0; i < SEG.s; i++) push(-ax, (z0 + rr2) + i / SEG.s * ((z1 - rf) - (z0 + rr2)), -1, 0, 0);
  for (let i = 0; i < SEG.c; i++) { const th = PI - PI / 2 * i / SEG.c; push(-ax + rf + rf * Math.cos(th), z1 - rf + rf * Math.sin(th), Math.cos(th), Math.sin(th), Math.sin(th) ** 2); }
  for (let i = 0; i <= SEG.f; i++) push(-(ax - rf) * (1 - i / SEG.f), z1, 0, 1, 1);
  return pts;
}
// The roof's plan: overhangs 0.2 m at the sides and rear, 0.55 m at the front (the cab-over brow).
const RF = { ax: 1.45, z0: -4.2, z1: 4.55, rr: 0.45, rf: 0.75 };
const inset = d => [RF.ax - d, RF.z0 + d, RF.z1 - d, RF.rr - d, RF.rf - d];
const WALL_RING = [HW, -HL, HL, 0.15, 0.12];
const mixW = (a, b, w) => a * (1 - w) + b * w;
// the crown: flat down the middle, falling away to the eave (sides) or rounding over into the
// forehead (front)
const hSide = d => 2.42 - 0.17 * (1 - Math.min(d, 1.45) / 1.45) ** 3;
// the cab-over forehead: a rounded bulge that crests above the roof line in front of the walkable
// roof (the roof collider ends at z = 4; the crest is at z ≈ 4.25)
const hFront = d => d < 0.3 ? 2.06 + 0.5 * Math.sqrt(Math.max(0, 1 - (1 - d / 0.3) ** 2)) : d < 0.6 ? 2.42 + 0.14 * (0.5 + 0.5 * Math.cos(PI * (d - 0.3) / 0.3)) : 2.42;
const hTop = (d, w) => mixW(hSide(d), hFront(d), w);
// the eave line sags a little toward the middle of the long sides, like an old wagon's
// ... and kicks up at the back
const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const eaveOff = z => -0.06 * Math.max(0, 1 - (z / 4.1) ** 2) + 0.08 * sstep(-2.6, -4.2, z);
const hTopP = (d, p) => hTop(d, p.w) + eaveOff(p.z) * (1 - p.w) * Math.max(0, 1 - d / 0.6);
const lipTop = p => hTopP(0, p), lipBot = p => mixW(2.03, 1.98, p.w) + eaveOff(p.z) * (1 - p.w), soffitY = p => mixW(2.2, 2.17, p.w);
const TOP_D = [0, 0.04, 0.09, 0.16, 0.25, 0.35, 0.5, 0.7, 0.95, 1.2, 1.45];
// the roof's top surface height over a plan point (approximate: ignores corner rounding)
function roofY(x, z) {
  const ds = Math.min(RF.ax - Math.abs(x), z - RF.z0), df = RF.z1 - z;
  return df < ds && z > 3.6 ? hTop(df, 1) : hSide(Math.min(ds, df));
}
// smooth lumps for the snow
const lump = (x, z) => Math.sin(z * 2.1 + x * 1.3) * 0.5 + Math.sin(z * 4.7 - x * 2.9 + 1.7) * 0.3 + Math.sin(z * 1.1 + 2) * 0.2;
const droopN = (x, z) => 0.5 + 0.5 * Math.sin(z * 3.3 + x * 2.1) * Math.cos(z * 1.7 - x * 0.9 + 0.5);

function arcLengths(ring) {
  const out = [0];
  for (let j = 1; j < ring.length; j++) out.push(out[j - 1] + Math.hypot(ring[j].x - ring[j - 1].x, ring[j].z - ring[j - 1].z));
  return out;
}

function buildRoofShell(b) {
  // rings, from the soffit at the wall out round the rolled lip and up over the crown
  const levels = [
    [WALL_RING, p => soffitY(p)],
    [inset(0.06), p => lipBot(p) + 0.03],
    [inset(0.015), p => lipBot(p)],
    [inset(-0.02), p => lipBot(p) + 0.015],
    [inset(-0.038), p => (lipBot(p) + lipTop(p)) / 2],
    [inset(-0.025), p => lipTop(p) - 0.014],
    ...TOP_D.map(d => [inset(d), p => hTopP(d, p)]),
  ];
  const rings = levels.map(([r, yf]) => ringPts(...r).map(p => ({ ...p, y: yf(p) })));
  const cols = rings[0].length;
  const S = gridSurface(rings.length, cols, (i, j) => [rings[i][j].x, rings[i][j].y, rings[i][j].z], (i, j, p) => i >= 6 ? new V3(0, 1, 0) : null, true);
  const iTop = 6, iEdge = 6 + TOP_D.indexOf(0.35);
  const arcLip = arcLengths(rings[4]), arcTop = arcLengths(rings[iTop]);
  // soffit and rolled lip: walnut boards
  b.trim.add(toBand(S.part(0, 1, (i, j) => [arcLip[j] * 0.6, i]), TRIM.wood));
  b.trim.add(toBand(S.part(1, iTop, (i, j) => [arcLip[j] * 0.6, (i - 1) / (iTop - 1)]), TRIM.wood));
  // the shoulder and the brow: the livery band
  const band = (u, v) => [u, (1 - TRIM.roofedge * BAND - 2 / TRIM.H) * v + (1 - (TRIM.roofedge + 1) * BAND + 2 / TRIM.H) * (1 - v)];
  b.trim.add(S.part(iTop, iEdge, (i, j) => band(arcTop[j] * 0.5, TOP_D[i - iTop] / 0.35)));
  // the tin top
  b.body.add(S.part(iEdge, rings.length - 1, (i, j, p) => uvRoof(p.x, p.z)));
  return rings;
}

// Day 3: a fat lumpy blanket on the roof that rounds over the eave, sags below the lip and grows
// icicles. Thin over the crown (people walk up there), thick at the edges.
function buildRoofSnow(b) {
  const sT = (d, p) => hTopP(d, p) + 0.035 + 0.13 * (1 - Math.min(1, d / 0.6)) ** 2 + lump(p.x, p.z) * (0.015 + 0.04 * (1 - Math.min(1, d / 0.8)));
  const top0 = p => sT(0, p);
  const dr = p => (0.05 + 0.08 * droopN(p.x, p.z)) * (1 - 0.4 * p.w);
  const levels = [
    [inset(-0.048), p => lipTop(p) - 0.03],
    [inset(-0.088), p => lipBot(p) - dr(p) * 0.6],
    [inset(-0.128), p => lipBot(p) - dr(p)],
    [inset(-0.163), p => lipBot(p) - dr(p) * 0.35 + 0.04],
    [inset(-0.158), p => (top0(p) + lipBot(p)) / 2 + 0.02],
    [inset(-0.11), p => top0(p) - 0.03],
    [inset(-0.05), p => top0(p) - 0.006],
    ...[0, 0.06, 0.15, 0.3, 0.5, 0.75, 1.0, 1.25, 1.45].map(d => [inset(d), p => sT(d, p)]),
  ];
  const rings = levels.map(([r, yf]) => ringPts(...r).map(p => ({ ...p, y: yf(p) })));
  const cols = rings[0].length;
  const S = gridSurface(rings.length, cols, (i, j) => [rings[i][j].x, rings[i][j].y, rings[i][j].z], (i, j, p) => i >= 7 ? new V3(0, 1, 0) : null, true);
  b.snow.add(S.part(0, rings.length - 1, (i, j, p) => [p.z / 3, p.x / 3]));
  // icicles hanging from the sag, irregularly spaced
  const rnd = rngFrom('rv_icicles'), sag = rings[2];
  const arc = arcLengths(sag);
  let s = rnd() * 0.3;
  while (s < arc[arc.length - 1]) {
    let j = 1; while (j < arc.length - 1 && arc[j] < s) j++;
    const t = (s - arc[j - 1]) / Math.max(1e-6, arc[j] - arc[j - 1]), p0 = sag[j - 1], p1 = sag[j];
    const x = p0.x + (p1.x - p0.x) * t, z = p0.z + (p1.z - p0.z) * t, y = p0.y + (p1.y - p0.y) * t;
    const L = 0.08 + 0.27 * rnd() ** 1.5, r = 0.022 + 0.026 * rnd();
    b.snow.add(at(new THREE.ConeGeometry(r, L, 5, 1), x, y - L / 2 + 0.02, z, PI, rnd() * TAU, 0));
    if (rnd() < 0.35) { const L2 = L * 0.5; b.snow.add(at(new THREE.ConeGeometry(r * 0.7, L2, 5, 1), x + 0.04, y - L2 / 2 + 0.01, z + 0.03, PI, 0, 0)); }
    s += 0.1 + 0.3 * rnd();
  }
}

// ---- the body ------------------------------------------------------------------------------------

// The side outline in (z, y): straight top, wheel arches cut into the skirt; optionally lower
// (the grime overlay) with a notch where the door is.
function sideOutline(top = WH, notchDoor = false) {
  const s = new THREE.Shape(), R = A.archR, y0 = A.y0;
  const dz = Math.sqrt(R * R - (y0 - WHEEL_Y) ** 2), a0 = Math.atan2(y0 - WHEEL_Y, -dz);
  s.moveTo(-HL, y0);
  for (const az of [...A.archZ].sort((a, b) => a - b)) { s.lineTo(az - dz, y0); s.absarc(az, WHEEL_Y, R, a0, PI - a0, true); }
  s.lineTo(HL, y0); s.lineTo(HL, top);
  if (notchDoor) { s.lineTo(A.door.z1, top); s.lineTo(A.door.z1, A.door.y0); s.lineTo(A.door.z0, A.door.y0); s.lineTo(A.door.z0, top); }
  s.lineTo(-HL, top);
  s.closePath();
  return s;
}

// A fender: a rolled iron shell swept round the arch, flared out past the tire.
function fenderGeo(side, az, band = TRIM.red, prof = [[0.0, 0.11], [0.06, 0.14], [0.13, 0.13], [0.165, 0.07], [0.165, 0.0], [0.13, -0.025]], th0 = 0.22, th1 = PI - 0.22) {
  const R = A.archR, n = 18;
  const S = gridSurface(prof.length, n + 1, (i, j) => {
    const th = th0 + (th1 - th0) * j / n, [a, rho] = prof[i];
    return [side * (HW + a), WHEEL_Y + (R + rho) * Math.sin(th), az + (R + rho) * Math.cos(th)];
  }, (i, j, p) => i === 1 ? new V3(side * 0.3, p.y - WHEEL_Y, p.z - az).normalize() : null);
  return toBand(S.part(0, prof.length - 1, (i, j) => [(th0 + (th1 - th0) * j / n) * R * 1.0, 1 - i / (prof.length - 1)]), band);
}

function buildShell(b) {
  // outer skins (the painted atlas) and the plaster-and-timber inner skins
  const sr = sideOutline(); sr.holes.push(...A.winR.map(holeOf), doorHole());
  b.body.add(setUV(wallGeo(sr, 'x', -HW, -1), uvSideR));
  const sl = sideOutline(); sl.holes.push(...A.winL.map(holeOf));
  b.body.add(setUV(wallGeo(sl, 'x', HW, 1), uvSideL));
  const inner = (wins, notch) => {
    const s = new THREE.Shape();
    s.moveTo(-HL + 0.1, 0);
    if (notch) { s.lineTo(A.door.z0, 0); s.lineTo(A.door.z0, A.door.y1); s.lineTo(A.door.z1, A.door.y1); s.lineTo(A.door.z1, 0); }
    s.lineTo(HL - 0.1, 0); s.lineTo(HL - 0.1, WH); s.lineTo(-HL + 0.1, WH); s.closePath();
    s.holes.push(...wins.map(holeOf));
    return s;
  };
  b.panel.add(setUV(wallGeo(inner(A.winR, true), 'x', -IN, 1), uvPanelZ));
  b.panel.add(setUV(wallGeo(inner(A.winL, false), 'x', IN, -1), uvPanelZ));
  const sw = A.shield;
  const fo = new THREE.Shape(); fo.moveTo(-HW, A.y0); fo.lineTo(HW, A.y0); fo.lineTo(HW, WH); fo.lineTo(-HW, WH); fo.closePath();
  fo.holes.push(rr(new THREE.Path(), -sw.x, sw.y0, sw.x, sw.y1, 0.12));
  b.body.add(setUV(wallGeo(fo, 'z', HL, 1), uvFront));
  const fi = new THREE.Shape(); fi.moveTo(-IN, 0); fi.lineTo(IN, 0); fi.lineTo(IN, WH); fi.lineTo(-IN, WH); fi.closePath();
  fi.holes.push(rr(new THREE.Path(), -sw.x, sw.y0, sw.x, sw.y1, 0.12));
  b.panel.add(setUV(wallGeo(fi, 'z', HL - 0.1, -1), uvPanelX));

  // the timber frame: rounded corner posts, wall plates (they cap the walls when the roof is gone)
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const r = sz < 0 ? 0.15 : 0.13, cx = sx * (HW - 0.08), cz = sz * (HL - 0.08), th = Math.atan2(sx, sz);
    b.trim.add(at(post(r, 2.78, TRIM.wood, th - 1.75, 3.5, 10), cx, (A.y0 - 0.02 + 2.16) / 2, cz));
  }
  for (const sx of [-1, 1]) b.trim.add(at(beam(0.14, 0.06, 8.0, TRIM.wood), sx * 1.2, 2.27, 0));
  b.trim.add(at(beam(2.5, 0.06, 0.14, TRIM.wood), 0, 2.27, 3.95));
  // the beltline rub rail: chunky oak standing 0.1 proud, a strong shadow line along the stripe
  const rail = (side, z0, z1) => b.trim.add(at(rboxB(0.1, 0.14, z1 - z0, 0.045, TRIM.oak, 2), side * (HW + 0.05), A.rail, (z0 + z1) / 2));
  rail(1, -3.96, 3.98); rail(-1, -3.96, A.door.z0 - 0.07); rail(-1, A.door.z1 + 0.07, 3.98);
  // a lower skirt rail
  b.trim.add(at(beam(0.05, 0.08, 7.9, TRIM.wood), HW + 0.025, 0.03, 0));
  b.trim.add(at(beam(0.05, 0.08, A.door.z0 + 3.93 - 0.06, TRIM.wood), -HW - 0.025, 0.03, (A.door.z0 - 0.06 - 3.93) / 2));
  b.trim.add(at(beam(0.05, 0.08, 3.93 - A.door.z1 - 0.06, TRIM.wood), -HW - 0.025, 0.03, (A.door.z1 + 0.06 + 3.93) / 2));
  // carved brackets under the eave
  {
    const s = new THREE.Shape();
    s.moveTo(0, 2.2); s.lineTo(0.16, 2.115); s.lineTo(0.16, 2.07); s.quadraticCurveTo(0.03, 2.07, 0.02, 1.95); s.lineTo(0, 1.95); s.closePath();
    for (const [side, zs] of [[1, [2.35, 0.05, -2.0, -2.95]], [-1, [2.62, -1.0, -2.95]]]) for (const z of zs) b.trim.add(toBand(boxUV(sideProfile(s, side, z, 0.09)), TRIM.wood));
  }

  // windows: chunky wooden frames through the wall, sills, glass, night glow; brass portholes
  for (const [side, wins] of [[1, A.winL], [-1, A.winR]]) {
    for (const o of wins) {
      if (o.r) {
        for (const x of [HW + 0.012, IN - 0.012]) b.trim.add(at(ring(o.r + 0.03, 0.028, TRIM.brass, 20), side * x, o.y, o.z, 0, PI / 2, 0));
        b.trim.add(at(flip(rod(o.r + 0.002, 0.12, TRIM.brass, { segs: 14, open: true })), side * 1.2, o.y, o.z, 0, 0, PI / 2));
        for (let k = 0; k < 6; k++) { const a = k / 6 * TAU + 0.3; b.trim.add(at(rod(0.012, 0.02, TRIM.iron, { segs: 5 }), side * (HW + 0.03), o.y + Math.sin(a) * (o.r + 0.03), o.z + Math.cos(a) * (o.r + 0.03), 0, 0, PI / 2)); }
        if (o.frost) { for (const f of [1, -1]) b.trim.add(at(toSlot(new THREE.CircleGeometry(o.r, 16), TRIM.s.frost), side * (1.2 + f * 0.01), o.y, o.z, 0, f * side * PI / 2, 0)); }
        else { b.glass.add(at(new THREE.CircleGeometry(o.r, 16), side * 1.2, o.y, o.z, 0, PI / 2, 0)); b.glow.add(at(toLamp(new THREE.CircleGeometry(o.r, 16), LAMPS.port), side * 1.215, o.y, o.z, 0, side * PI / 2, 0)); }
        b.snow.add(at(snowCap(0.12, o.r * 1.4, 0.05, o.z), side * (HW + 0.05), o.y + o.r + 0.05, o.z));
        continue;
      }
      const cz = (o.z0 + o.z1) / 2, cy = (o.y0 + o.y1) / 2, w = o.z1 - o.z0, h = o.y1 - o.y0;
      const fr = throughWall(frameShape(o, 0.075), 'x', side * (IN - 0.045), side, 0.21);
      b.trim.add(toBand(boxUV(at(fr, 0, cy, cz)), TRIM.wood));
      b.trim.add(at(rboxB(0.13, 0.06, w + 0.32, 0.02, TRIM.wood, 2), side * (HW + 0.075), o.y0 - 0.1, cz));
      for (const dz of [-1, 1]) b.trim.add(at(beam(0.08, 0.1, 0.05, TRIM.wood), side * (HW + 0.04), o.y0 - 0.17, cz + dz * (w / 2 + 0.06)));
      b.itrim.add(at(beam(0.07, 0.035, w + 0.16, TRIM.oak), side * (IN - 0.035), o.y0 - 0.08, cz));
      b.glass.add(at(new THREE.PlaneGeometry(w, h), side * 1.2, cy, cz, 0, PI / 2, 0));
      b.glow.add(at(toLamp(new THREE.PlaneGeometry(w, h), LAMPS.window), side * 1.215, cy, cz, 0, side * PI / 2, 0));
      b.snow.add(at(snowCap(0.15, w + 0.3, 0.08, cz), side * (HW + 0.08), o.y0 - 0.04, cz));
    }
  }
  // the door jamb and its brass threshold
  for (const z of [A.door.z0 - 0.04, A.door.z1 + 0.04]) b.trim.add(at(beam(0.2, 2.08, 0.08, TRIM.wood), -1.21, 1.04, z));
  b.trim.add(at(beam(0.22, 0.1, A.door.z1 - A.door.z0 + 0.2, TRIM.wood), -1.22, 2.02, (A.door.z0 + A.door.z1) / 2));
  b.trim.add(at(beam(0.2, 0.025, A.door.z1 - A.door.z0, TRIM.brass), -1.2, 0.012, (A.door.z0 + A.door.z1) / 2));

  // wheel arches: flared, rolled fenders and dark wells
  for (const az of A.archZ) for (const side of [-1, 1]) {
    b.trim.add(fenderGeo(side, az));
    b.trim.add(at(toBand(flip(new THREE.CylinderGeometry(A.archR, A.archR, 0.44, 14, 1, true, 0.25, PI - 0.5)), TRIM.iron, 2), side * 1.04, WHEEL_Y, az, 0, 0, PI / 2));
    for (let k = 0; k < 5; k++) { const th = 0.45 + k / 4 * (PI - 0.9); b.trim.add(at(rod(0.014, 0.02, TRIM.iron, { segs: 5 }), side * (HW + 0.17), WHEEL_Y + (A.archR + 0.06) * Math.sin(th), az + (A.archR + 0.06) * Math.cos(th), 0, 0, PI / 2)); }
    b.snow.add(fenderGeo(side, az, 0, [[0.02, 0.13], [0.06, 0.2], [0.12, 0.2], [0.16, 0.15], [0.12, 0.13]], 0.75, PI - 0.75));
  }
  // the steps under the door: a chunky two-step oak crate, darker risers, iron corner straps.
  // Tread tops at the step colliders (-0.42 and -0.85).
  {
    const z = D.DOOR_Z, L = 0.9;
    b.trim.add(at(rboxB(0.42, 0.2, L, 0.03, TRIM.oak, 2), -1.42, -0.52, z));
    b.trim.add(at(rboxB(0.44, 0.38, L, 0.03, TRIM.oak, 2), -1.64, -1.04, z));
    b.trim.add(at(beam(0.03, 0.16, L - 0.06, TRIM.wood), -1.63, -0.53, z));
    b.trim.add(at(beam(0.03, 0.32, L - 0.06, TRIM.wood), -1.86, -1.05, z));
    for (const dz of [-1, 1]) {
      // side boards tie the two steps together
      const sb = new THREE.Shape(); sb.moveTo(-1.21, -0.42); sb.lineTo(-1.63, -0.42); sb.lineTo(-1.63, -0.85); sb.lineTo(-1.86, -0.85); sb.lineTo(-1.86, -1.23); sb.lineTo(-1.42, -1.23); sb.lineTo(-1.21, -0.62); sb.closePath();
      const g = new THREE.ExtrudeGeometry(sb, { depth: 0.04, bevelEnabled: false });
      g.translate(0, 0, z + dz * (L / 2 + 0.005) - 0.02);
      b.trim.add(toBand(boxUV(toCreasedNormals(g, 0.7)), TRIM.oak));
      for (const [x, y] of [[-1.63, -0.43], [-1.86, -0.86], [-1.63, -0.62]]) b.trim.add(at(beam(0.05, 0.05, 0.06, TRIM.iron), x, y - 0.02, z + dz * (L / 2 + 0.01)));
    }
    b.snow.add(at(snowCap(0.4, L - 0.04, 0.07, 1), -1.42, -0.39, z));
    b.snow.add(at(snowCap(0.42, L - 0.04, 0.07, 2), -1.65, -0.82, z));
    b.bio_desert.add(toBand(boxUV(at(lumpy(rbox(0.46, 0.1, L * 0.8, 0.045, 3), 0.03, 3), -1.66, -0.81, z - 0.06, 0, 0.1, 0)), TRIM.sand));
    b.bio_desert.add(toBand(boxUV(at(lumpy(rbox(0.6, 0.16, 1.2, 0.07, 3), 0.04, 4), -1.9, -1.32, z + 0.1, 0, 0.3, 0)), TRIM.sand));
  }
}

function buildFront(b) {
  const sw = A.shield;
  // windshield: a heavy frame, a center post, two panes, wipers
  const s = new THREE.Shape(); rr(s, -sw.x - 0.08, sw.y0 - 0.08, sw.x + 0.08, sw.y1 + 0.08, 0.17);
  s.holes.push(rr(new THREE.Path(), -sw.x, sw.y0, sw.x, sw.y1, 0.12));
  b.trim.add(toBand(boxUV(throughWall(s, 'z', HL - 0.12, 1, 0.21)), TRIM.wood));
  b.trim.add(at(beam(0.08, sw.y1 - sw.y0, 0.15, TRIM.wood), 0, (sw.y0 + sw.y1) / 2, HL - 0.02));
  for (const sx of [-1, 1]) {
    b.glass.add(at(new THREE.PlaneGeometry(sw.x - 0.04, sw.y1 - sw.y0), sx * (sw.x + 0.04) / 2, (sw.y0 + sw.y1) / 2, HL - 0.05));
    b.glow.add(at(toLamp(new THREE.PlaneGeometry(sw.x - 0.04, sw.y1 - sw.y0), LAMPS.window), sx * (sw.x + 0.04) / 2, (sw.y0 + sw.y1) / 2, HL + 0.012));
    b.trim.add(at(beam(0.62, 0.025, 0.02, TRIM.iron), sx * 0.5, sw.y0 + 0.12, HL + 0.07, 0, 0, sx * 0.35));
    b.trim.add(at(rod(0.025, 0.04, TRIM.brass), sx * 0.22, sw.y0 + 0.02, HL + 0.07, PI / 2, 0, 0));
  }
  b.snow.add(at(snowCap(2.3, 0.14, 0.07, 3), 0, sw.y0 - 0.06, HL + 0.06));
  // marker lamps along the brow's lip
  for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) {
    const lip = inset(-0.035), cxr = lip[0] - lip[4], czr = lip[2] - lip[4];
    let z = lip[2], nx = 0, nz = 1;
    if (Math.abs(x) > cxr) { const dx = Math.abs(x) - cxr, dz = Math.sqrt(Math.max(0, lip[4] ** 2 - dx * dx)); z = czr + dz; nx = Math.sign(x) * dx / lip[4]; nz = dz / lip[4]; }
    const pp = { w: nz * nz, x, z }, y = (lipBot(pp) + lipTop(pp)) / 2, ry = Math.atan2(nx, nz);
    b.trim.add(along(rod(0.05, 0.05, TRIM.brass, { segs: 10 }), [x, y, z], [x + nx * 0.05, y, z + nz * 0.05]));
    b.lamps.add(at(toLamp(new THREE.CircleGeometry(0.04, 12), LAMPS.amber), x + nx * 0.052, y, z + nz * 0.052, 0, ry, 0));
    b.glow.add(at(halo(0.45), x + nx * 0.07, y, z + nz * 0.07, 0, ry, 0));
  }
  // grille: brass frame, iron bars; the maker's cog above it
  const gs = new THREE.Shape(); rr(gs, -0.56, -0.28, 0.56, 0.62, 0.12);
  gs.holes.push(rr(new THREE.Path(), -0.47, -0.2, 0.47, 0.54, 0.07));
  b.trim.add(toBand(boxUV(throughWall(gs, 'z', HL - 0.01, 1, 0.08, { bevel: 0.012 })), TRIM.brass));
  for (let i = 0; i < 9; i++) b.trim.add(at(rod(0.022, 0.76, TRIM.iron, { segs: 6 }), -0.42 + i * 0.105, 0.17, HL + 0.035));
  b.trim.add(at(rod(0.02, 0.96, TRIM.iron, { segs: 6 }), 0, 0.17, HL + 0.05, 0, 0, PI / 2));
  b.trim.add(at(toSlot(new THREE.CircleGeometry(0.1, 18), TRIM.s.emblem), 0, 0.76, HL + 0.012));
  b.trim.add(at(ring(0.104, 0.02, TRIM.brass, 18), 0, 0.76, HL + 0.012));
  // round brass headlights and amber turn signals
  for (const sx of [-1, 1]) {
    const x = sx * 0.86;
    b.trim.add(at(rod(0.17, 0.12, TRIM.brass, { segs: 16 }), x, 0.28, HL + 0.05, PI / 2, 0, 0));
    b.trim.add(at(ring(0.16, 0.024, TRIM.brass, 20), x, 0.28, HL + 0.11));
    b.lamps.add(at(toLamp(new THREE.CircleGeometry(0.15, 20), LAMPS.head), x, 0.28, HL + 0.112));
    b.trim.add(at(rod(0.072, 0.06, TRIM.brass, { segs: 12 }), x, -0.07, HL + 0.03, PI / 2, 0, 0));
    b.lamps.add(at(toLamp(new THREE.CircleGeometry(0.058, 14), LAMPS.amber), x, -0.07, HL + 0.062));
    b.glow.add(at(halo(1.1), x, 0.28, HL + 0.14));
    b.glow.add(at(halo(0.4), x, -0.07, HL + 0.08));
  }
  // the front bumper: an iron beam faced with a plank, rounded iron ends, brass bolts
  b.trim.add(at(beam(2.4, 0.3, 0.24, TRIM.iron), 0, -0.42, 4.06));
  b.trim.add(at(beam(2.36, 0.2, 0.05, TRIM.wood), 0, -0.42, 4.195));
  for (const sx of [-1, 1]) {
    b.trim.add(at(rod(0.12, 0.33, TRIM.iron, { segs: 10 }), sx * 1.18, -0.42, 4.1));
    for (const x of [0.62, 1.0]) b.trim.add(at(rod(0.026, 0.03, TRIM.brass, { segs: 8 }), sx * x, -0.42, 4.225, PI / 2, 0, 0));
  }
  b.snow.add(at(snowCap(2.5, 0.24, 0.08, 4), 0, -0.24, 4.07));
  // per biome, up front: a sprig of oak leaves under the wiper and wildflowers on the grille
  // (Elwynn), a horned skull on the grille (Badlands), sand on the bumper (Tanaris)
  for (const [x, y, z, s, a] of [[-0.52, 1.12, 4.1, 0.07, 0.4], [-0.44, 1.1, 4.11, 0.06, -0.3], [-0.6, 1.09, 4.1, 0.055, 1.1], [-0.48, 1.06, 4.12, 0.05, 2.2], [-0.37, 1.13, 4.1, 0.045, -1.2]]) {
    b.bio_meadow.add(at(toBand(new THREE.SphereGeometry(1, 8, 5), TRIM.leaf), x, y, z, 0.2, 0, a, [s, s * 0.45, s * 0.25]));
  }
  b.bio_meadow.add(at(rod(0.006, 0.18, TRIM.wood, { segs: 4 }), -0.47, 1.1, 4.1, 0, 0, 1.1));
  b.bio_meadow.add(at(toSlot2(new THREE.CircleGeometry(0.11, 10), TRIM.s2.flowers), 0.34, 0.46, HL + 0.07));
  b.bio_meadow.add(at(toBand(lumpy(new THREE.SphereGeometry(0.1, 8, 6), 0.02, 1), TRIM.leaf), 0.34, 0.46, HL + 0.03, 0, 0, 0, [1, 1, 0.5]));
  for (const [x, z] of [[-0.7, 4.12], [0.2, 4.1], [0.85, 4.14]]) b.bio_meadow.add(at(toSlot2(lumpy(rbox(0.22, 0.06, 0.14, 0.028, 2), 0.015, x * 9), TRIM.s2.mud), x, -0.25, z));
  {
    // the skull: a bleached cow skull with long horns, wired to the grille's cog
    b.bio_badlands.add(at(toBand(boxUV(rbox(0.2, 0.26, 0.12, 0.05, 2)), TRIM.bone), 0, 0.72, HL + 0.09));
    b.bio_badlands.add(at(toSlot2(new THREE.PlaneGeometry(0.19, 0.25), TRIM.s2.skull), 0, 0.72, HL + 0.152));
    for (const sx of [-1, 1]) {
      const pts = [[sx * 0.09, 0.8, HL + 0.09], [sx * 0.24, 0.84, HL + 0.1], [sx * 0.36, 0.95, HL + 0.11], [sx * 0.4, 1.07, HL + 0.12]];
      for (let k = 0; k < 3; k++) b.bio_badlands.add(rodAB(0.035 - k * 0.01, pts[k], pts[k + 1], TRIM.bone, { r2: 0.035 - (k + 1) * 0.01, segs: 7 }));
    }
  }
  b.bio_desert.add(toBand(boxUV(at(lumpy(rbox(2.0, 0.07, 0.2, 0.03, 3), 0.025, 5), 0, -0.24, 4.06)), TRIM.sand));
}

// The winch: goblin engineering. A strap drum between iron flanges, a green gearbox with a brass
// cog, a finned green motor with a brass exhaust stack, a fairlead of two rollers.
function gearShape(r0, r1, teeth) {
  const s = new THREE.Shape();
  for (let i = 0; i < teeth * 4; i++) {
    const a = i / (teeth * 4) * TAU, r = (i % 4 === 1 || i % 4 === 2) ? r1 : r0;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r); else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  s.holes.push(new THREE.Path().absarc(0, 0, r0 * 0.35, 0, TAU, true));
  return s;
}
function buildWinch(b) {
  const { x, y, z } = DRUM;
  b.trim.add(at(beam(1.0, 0.32, 0.05, TRIM.iron), x, y, z - 0.11));
  b.trim.add(at(toBand(new THREE.CylinderGeometry(0.115, 0.115, 0.46, 14), TRIM.strap, 3), x, y, z, 0, 0, PI / 2));
  for (const sx of [-1, 1]) b.trim.add(at(rod(0.19, 0.035, TRIM.iron, { segs: 16 }), x + sx * 0.25, y, z, 0, 0, PI / 2));
  b.trim.add(at(rboxB(0.14, 0.34, 0.32, 0.03, TRIM.green, 2), x + 0.355, y, z));
  const cg = throughWall(gearShape(0.12, 0.15, 10), 'x', x + 0.425, 1, 0.035);
  b.trim.add(toBand(boxUV(at(cg, 0, y, z)), TRIM.brass));
  b.trim.add(at(rod(0.035, 0.06, TRIM.iron), x + 0.46, y, z, 0, 0, PI / 2));
  b.trim.add(at(rod(0.14, 0.22, TRIM.green, { segs: 12 }), x - 0.39, y, z, 0, 0, PI / 2));
  b.trim.add(at(rod(0.1, 0.04, TRIM.iron, { segs: 10 }), x - 0.52, y, z, 0, 0, PI / 2));
  for (const dx of [-0.33, -0.39, -0.45]) b.trim.add(at(ring(0.145, 0.012, TRIM.iron, 14), x + dx, y, z, 0, PI / 2, 0));
  b.trim.add(at(rod(0.026, 0.36, TRIM.brass), x - 0.42, y + 0.29, z + 0.06, 0, 0, 0.05));
  b.trim.add(at(rod(0.05, 0.07, TRIM.soot, { r2: 0.02 }), x - 0.43, y + 0.5, z + 0.06));
  for (const dy of [-0.13, 0.13]) b.trim.add(at(rod(0.03, 0.42, TRIM.iron, { segs: 8 }), x, y + dy, z + 0.14, 0, 0, PI / 2));
  for (const sx of [-1, 1]) b.trim.add(at(beam(0.04, 0.34, 0.06, TRIM.iron), x + sx * 0.21, y, z + 0.14));
}

function buildUnder(b) {
  b.trim.add(at(beam(2.36, 0.03, 7.9, TRIM.iron, 0.6), 0, A.y0 + 0.02, 0));
  for (const az of A.archZ) {
    b.trim.add(at(rod(0.05, 1.7, TRIM.iron), 0, WHEEL_Y + A.tireLift, az, 0, 0, PI / 2));
    for (const sx of [-1, 1]) b.trim.add(at(beam(0.1, 0.07, 1.2, TRIM.iron), sx * 0.7, A.y0 - 0.05, az));
  }
  b.trim.add(at(rboxB(0.7, 0.26, 1.1, 0.06, TRIM.red, 2), 0.45, A.y0 - 0.1, 0.1));
  b.trim.add(at(rod(0.04, 1.4, TRIM.iron), -0.65, A.y0 - 0.06, -3.4, PI / 2, 0, 0));
  for (const sx of [-1, 1]) b.trim.add(at(beam(0.36, 0.44, 0.025, TRIM.leather), sx * 1.06, -0.86, A.archZ[1] - 0.76, 0.06, 0, 0));
  // the rear bumper, its slogan board, the trade plate and two lantern tail lamps
  b.trim.add(at(beam(2.4, 0.3, 0.22, TRIM.iron), 0, -0.42, -4.06));
  b.trim.add(at(beam(2.36, 0.2, 0.05, TRIM.wood), 0, -0.42, -4.185));
  b.trim.add(at(toWide(new THREE.PlaneGeometry(0.42, 0.2), TRIM.w.sticker), 0.32, -0.42, -4.212, 0, PI, 0));
  b.trim.add(at(toWide(new THREE.PlaneGeometry(0.36, 0.18), TRIM.w.plate), -0.42, -0.42, -4.212, 0, PI, 0));
  for (const sx of [-1, 1]) {
    b.trim.add(at(rod(0.12, 0.31, TRIM.iron, { segs: 10 }), sx * 1.18, -0.42, -4.08));
    b.trim.add(at(rod(0.022, 0.15, TRIM.brass), sx * 0.98, -0.19, -4.09));
    b.trim.add(at(rod(0.115, 0.1, TRIM.brass, { segs: 14 }), sx * 0.98, -0.02, -4.09, PI / 2, 0, 0));
    b.trim.add(at(ring(0.108, 0.018, TRIM.brass, 16), sx * 0.98, -0.02, -4.14));
    b.trim.add(at(rod(0.05, 0.06, TRIM.soot, { r2: 0.012 }), sx * 0.98, 0.1, -4.09));
    b.lamps.add(at(toLamp(new THREE.CircleGeometry(0.1, 16), LAMPS.tail), sx * 0.98, -0.02, -4.142, 0, PI, 0));
    b.glow.add(at(halo(0.7), sx * 0.98, -0.02, -4.17, 0, PI, 0));
  }
  b.snow.add(at(snowCap(2.5, 0.22, 0.08, 6), 0, -0.24, -4.07));
  // a bucket swinging under the rear bumper
  b.trim.add(at(lathe([[0.001, 0], [0.1, 0], [0.105, 0.01], [0.125, 0.22], [0.13, 0.23], [0.118, 0.23], [0.11, 0.03]], TRIM.oak, 10, 2), -0.72, -0.95, -4.12));
  for (const y of [-0.9, -0.77]) b.trim.add(at(ring(0.118 + (y + 0.9) * 0.1, 0.008, TRIM.iron, 12), -0.72, y, -4.12, PI / 2, 0, 0));
  b.trim.add(at(ring(0.12, 0.007, TRIM.iron, 10, PI), -0.72, -0.72, -4.12, 0, 0, 0));
  b.bio_desert.add(toBand(boxUV(at(lumpy(rbox(2.0, 0.06, 0.18, 0.025, 3), 0.02, 7), 0, -0.24, -4.06)), TRIM.sand));
}

// ---- the caravan's clutter (exterior) ------------------------------------------------------------

function lantern(b, x, y, z, s = 1) {
  b.trim.add(at(lathe([[0.001, 0.0], [0.075, 0.0], [0.09, -0.02], [0.03, -0.07], [0.001, -0.075]].map(([r, h]) => [r * s, -h * s]), TRIM.soot, 8), x, y + 0.08 * s, z));
  b.lamps.add(at(toLamp(new THREE.CylinderGeometry(0.055 * s, 0.055 * s, 0.14 * s, 8, 1, true), LAMPS.lantern), x, y, z));
  b.trim.add(at(rod(0.068 * s, 0.03 * s, TRIM.brass, { segs: 10 }), x, y - 0.085 * s, z));
  for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + PI / 4; b.trim.add(at(rod(0.006, 0.15 * s, TRIM.iron, { segs: 4 }), x + Math.cos(a) * 0.06 * s, y, z + Math.sin(a) * 0.06 * s)); }
  b.trim.add(at(ring(0.025 * s, 0.006, TRIM.iron, 8), x, y + 0.13 * s, z));
  for (const ry of [0, PI / 3, -PI / 3, PI, PI + PI / 3, PI - PI / 3]) b.glow.add(at(halo(0.9 * s), x, y, z, 0, ry, 0));
}

function buildClutter(b) {
  // the door side: a rolled canvas awning on iron brackets over the door, a lantern by it
  {
    const x = -HW - 0.13, y = 1.89, z0 = A.door.z0 - 0.3, z1 = A.door.z1 + 0.28;
    b.trim.add(at(rod(0.085, z1 - z0, TRIM.awning, { segs: 10, density: 0.9 }), x, y, (z0 + z1) / 2, PI / 2, 0, 0));
    for (const z of [z0 + 0.25, z1 - 0.25]) b.trim.add(at(toBand(new THREE.TorusGeometry(0.088, 0.012, 5, 12), TRIM.leather), x, y, z));
    for (const z of [z0 + 0.06, z1 - 0.06]) {
      b.trim.add(at(beam(0.18, 0.03, 0.03, TRIM.iron), -HW - 0.09, 1.97, z));
      b.trim.add(at(beam(0.03, 0.1, 0.03, TRIM.iron), x - 0.02, 1.92, z));
    }
    const LZ = 1.28;
    b.trim.add(at(beam(0.03, 0.2, 0.1, TRIM.iron), -HW - 0.015, 1.86, LZ));
    b.trim.add(at(beam(0.24, 0.03, 0.03, TRIM.iron), -HW - 0.12, 1.95, LZ));
    b.trim.add(at(beam(0.03, 0.08, 0.03, TRIM.iron), -HW - 0.13, 1.88, LZ, 0, 0, 0.7));
    b.trim.add(at(rod(0.004, 0.06, TRIM.iron, { segs: 4 }), -HW - 0.22, 1.91, LZ));
    lantern(b, -HW - 0.22, 1.76, LZ, 1.15);
  }
  // the driver's side skirt: an iron shelf with a lashed crate and a strapped water cask, a
  // shovel and a pick strapped along the skirt
  {
    const sx = HW;
    b.trim.add(at(beam(0.3, 0.03, 1.5, TRIM.iron), sx + 0.15, -0.6, -1.15));
    for (const z of [-1.85, -0.45]) b.trim.add(rodAB(0.016, [sx + 0.01, -0.3, z], [sx + 0.28, -0.6, z], TRIM.iron, { segs: 5 }));
    b.trim.add(at(rboxB(0.28, 0.36, 0.5, 0.025, TRIM.oak, 2), sx + 0.145, -0.405, -1.55, 0, 0.03, 0));
    for (const dz of [-0.2, 0.2]) b.trim.add(at(beam(0.29, 0.37, 0.03, TRIM.iron), sx + 0.145, -0.405, -1.55 + dz, 0, 0.03, 0));
    b.trim.add(at(beam(0.3, 0.025, 0.52, TRIM.rope), sx + 0.145, -0.3, -1.55, 0, 0.03, 0));
    const cask = lathe([[0.13, -0.28], [0.16, -0.2], [0.175, 0], [0.16, 0.2], [0.13, 0.28], [0.001, 0.28]], TRIM.oak, 10, 2);
    b.trim.add(at(cask, sx + 0.17, -0.41, -0.82, PI / 2, 0, 0));
    b.trim.add(at(toSlot2(new THREE.CircleGeometry(0.13, 10), TRIM.s2.map), sx + 0.17, -0.41, -1.102, 0, PI, 0));
    for (const dz of [-0.17, 0.17]) b.trim.add(at(ring(0.168, 0.012, TRIM.iron, 12), sx + 0.17, -0.41, -0.82 + dz));
    b.trim.add(at(rod(0.025, 0.06, TRIM.brass, { segs: 6 }), sx + 0.33, -0.41, -0.82, 0, 0, PI / 2));
    b.trim.add(at(beam(0.36, 0.035, 0.05, TRIM.leather), sx + 0.17, -0.25, -0.82, 0, 0, 0.0));
    // shovel and pick (along z, flat on the skirt)
    b.trim.add(at(rod(0.02, 0.86, TRIM.oak, { segs: 6 }), sx + 0.04, -0.2, 0.05, PI / 2, 0, 0.0));
    b.trim.add(at(rboxB(0.02, 0.2, 0.24, 0.02, TRIM.iron, 2), sx + 0.04, -0.2, -0.5));
    b.trim.add(at(rod(0.02, 0.86, TRIM.oak, { segs: 6 }), sx + 0.08, -0.42, 0.1, PI / 2, 0, 0.0));
    b.trim.add(rodAB(0.026, [sx + 0.08, -0.42, 0.55], [sx + 0.08, -0.22, 0.63], TRIM.iron, { r2: 0.008, segs: 6 }));
    b.trim.add(rodAB(0.026, [sx + 0.08, -0.42, 0.55], [sx + 0.08, -0.57, 0.6], TRIM.iron, { r2: 0.008, segs: 6 }));
    for (const z of [-0.25, 0.35]) b.trim.add(at(beam(0.13, 0.32, 0.04, TRIM.leather), sx + 0.04, -0.32, z));
  }
}

// ---- the interior --------------------------------------------------------------------------------

function sconce(b, side, y, z) {
  const x = side * IN, dx = -side;
  b.itrim.add(at(beam(0.02, 0.22, 0.1, TRIM.wood), x + dx * 0.01, y + 0.06, z));
  b.itrim.add(at(beam(0.2, 0.025, 0.025, TRIM.iron), x + dx * 0.1, y + 0.15, z));
  b.itrim.add(at(rod(0.004, 0.06, TRIM.iron, { segs: 4 }), x + dx * 0.18, y + 0.12, z));
  b.itrim.add(at(rod(0.075, 0.06, TRIM.soot, { r2: 0.02, segs: 8 }), x + dx * 0.18, y + 0.08, z));
  b.lamps.add(at(toLamp(new THREE.CylinderGeometry(0.052, 0.052, 0.13, 8, 1, true), LAMPS.lantern), x + dx * 0.18, y - 0.015, z));
  b.itrim.add(at(rod(0.065, 0.025, TRIM.brass, { segs: 8 }), x + dx * 0.18, y - 0.09, z));
  for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + PI / 4; b.itrim.add(at(rod(0.006, 0.13, TRIM.iron, { segs: 4 }), x + dx * 0.18 + Math.cos(a) * 0.055, y - 0.015, z + Math.sin(a) * 0.055)); }
}
function curtains(b, side, o) {
  const x = side * (IN - 0.085), h = o.y1 - o.y0 + 0.24, cy = (o.y0 + o.y1) / 2 + 0.03;
  b.itrim.add(at(rod(0.012, o.z1 - o.z0 + 0.4, TRIM.brass, { segs: 6 }), x + side * 0.02, o.y1 + 0.16, (o.z0 + o.z1) / 2, PI / 2, 0, 0));
  for (const z of [o.z0 + 0.04, o.z1 - 0.04]) b.itrim.add(at(cloth(0.22, h, 0.03, 3, TRIM.gingham), x, cy, z));
  b.itrim.add(at(cloth(o.z1 - o.z0 + 0.32, 0.15, 0.03, 6, TRIM.gingham), x - side * 0.01, o.y1 + 0.08, (o.z0 + o.z1) / 2));
}
// the woven runner down the aisle: an end piece at each end, middle pieces between (the soft
// atlas' rug region: RUG_END px of end, the rest a middle that repeats)
function runner(b, x0, x1, z0, z1, y) {
  const [rx, ry, rw, rh] = SOFT.rug, E = SOFT.RUG_END, w = x1 - x0, ins = 1.5;
  const U = s => (rx + ins + s * (rw - 2 * ins)) / 512, Vp = py => 1 - py / 512;
  const endL = w * E / rw, midL0 = w * (rh - E) / rw;
  const n = Math.max(1, Math.round((z1 - z0 - 2 * endL) / midL0)), midL = (z1 - z0 - 2 * endL) / n;
  const vEnd = [Vp(ry + ins), Vp(ry + E - ins)], vMid = [Vp(ry + E + ins), Vp(ry + rh - ins)];
  // rear end (fringe toward z0), middles, front end (fringe toward z1)
  b.soft.add(quadXZ(x0, x1, z0, z0 + endL, y, [[U(0), vEnd[0]], [U(1), vEnd[0]], [U(1), vEnd[1]], [U(0), vEnd[1]]]));
  for (let i = 0; i < n; i++) { const za = z0 + endL + i * midL; b.soft.add(quadXZ(x0, x1, za, za + midL, y, [[U(0), vMid[0]], [U(1), vMid[0]], [U(1), vMid[1]], [U(0), vMid[1]]])); }
  b.soft.add(quadXZ(x0, x1, z1 - endL, z1, y, [[U(1), vEnd[1]], [U(0), vEnd[1]], [U(0), vEnd[0]], [U(1), vEnd[0]]]));
}

function buildInterior(b) {
  b.floor.add(setUV(at(new THREE.PlaneGeometry(2.3, 7.8), 0, 0.002, 0, -PI / 2, 0, 0), (x, y, z) => [z / 1.6, (x + 1.15) / 2.3]));
  runner(b, -0.33, 0.33, -2.8, 0.32, 0.006);

  // the wash stall: riveted copper inside, timber-and-plaster outside, oak edges, a slatted floor,
  // a canvas curtain, a brass rain-head fed by a pipe, a bucket
  const sx0 = -1.2, sx1 = -0.4, scx = (sx0 + sx1) / 2, sw = sx1 - sx0;
  b.soft.add(toRegion(at(new THREE.PlaneGeometry(sw - 0.02, 2.2), scx, 1.1, -1.781, 0, PI, 0), SOFT.stall));
  b.soft.add(toRegion(at(new THREE.PlaneGeometry(sw - 0.02, 2.2), scx, 1.1, -2.719), SOFT.stall));
  {
    const s = new THREE.Shape(); s.moveTo(-2.72, 0); s.lineTo(-1.78, 0); s.lineTo(-1.78, 2.2); s.lineTo(-2.72, 2.2); s.closePath();
    s.holes.push(holeOf(A.winR.find(o => o.frost)));
    b.soft.add(toRegion(setUV(wallGeo(s, 'x', -IN + 0.004, 1), (x, y, z) => [(z + 2.72) / 0.94, y / 2.2]), SOFT.stall));
  }
  b.panel.add(setUV(at(new THREE.PlaneGeometry(sw, 2.2), scx, 1.1, -1.719), uvPanelX));
  b.panel.add(setUV(at(new THREE.PlaneGeometry(sw, 2.2), scx, 1.1, -2.781, 0, PI, 0), uvPanelX));
  for (const z of [-1.75, -2.75]) {
    b.itrim.add(at(beam(0.08, 2.22, 0.09, TRIM.wood), sx1, 1.11, z));
    b.itrim.add(at(beam(sw, 0.05, 0.09, TRIM.wood), scx, 2.22, z));
  }
  b.itrim.add(at(beam(0.06, 0.18, 1.0, TRIM.oak), -0.4, 0.09, -2.25));
  for (const dz of [-0.33, -0.11, 0.11, 0.33]) b.itrim.add(at(beam(0.72, 0.025, 0.17, TRIM.oak), scx, 0.013, -2.25 + dz));
  b.itrim.add(at(rod(0.014, 0.96, TRIM.brass, { segs: 6 }), -0.41, 2.0, -2.25, PI / 2, 0, 0));
  b.itrim.add(at(cloth(0.34, 1.76, 0.035, 3, TRIM.canvas), -0.43, 1.11, -2.52));
  b.itrim.add(at(rod(0.016, 0.9, TRIM.copper, { segs: 6 }), -1.12, 1.55, -2.62));
  b.itrim.add(at(rod(0.016, 0.24, TRIM.copper, { segs: 6 }), -1.04, 2.0, -2.62, 0, 0, PI / 2));
  b.itrim.add(at(lathe([[0.02, 0.06], [0.03, 0.03], [0.1, 0.0], [0.11, -0.02], [0.001, -0.02]], TRIM.brass, 12), -0.92, 1.94, -2.62 + 0.02));
  b.itrim.add(at(rod(0.04, 0.03, TRIM.brass, { segs: 8 }), -1.12, 1.25, -2.66, PI / 2, 0, 0));
  b.itrim.add(at(lathe([[0.001, 0], [0.12, 0], [0.13, 0.02], [0.14, 0.24], [0.125, 0.25], [0.12, 0.03]], TRIM.oak, 10, 2), -0.98, 0, -2.45));
  for (const y of [0.06, 0.2]) b.itrim.add(at(ring(0.132 + y * 0.04, 0.009, TRIM.iron, 12), -0.98, y, -2.45, PI / 2, 0, 0));

  // the bunks: oak frames, quilts, pillows, a guard rail, drawers underneath
  b.itrim.add(at(beam(2.36, 0.4, 0.94, TRIM.oak), 0, 0.2, -3.42));
  b.itrim.add(at(beam(2.36, 0.12, 0.05, TRIM.wood), 0, 0.44, -2.955));
  for (const sx of [-1, 1]) {
    b.itrim.add(at(beam(0.9, 0.24, 0.02, TRIM.wood), sx * 0.56, 0.19, -2.945));
    b.itrim.add(at(toBand(new THREE.SphereGeometry(0.022, 6, 4), TRIM.brass), sx * 0.56, 0.2, -2.93));
  }
  b.soft.add(at(toRegion(rbox(2.28, 0.17, 0.88, 0.06, 3), SOFT.quilt), 0, 0.48, -3.43));
  b.itrim.add(at(toBand(rbox(0.52, 0.13, 0.32, 0.06, 2), TRIM.canvas), -0.84, 0.61, -3.66, 0, 0.1, 0));
  b.itrim.add(at(beam(2.36, 0.1, 0.96, TRIM.oak), 0, 1.45, -3.42));
  b.soft.add(at(toRegion(rbox(2.28, 0.07, 0.88, 0.03, 3), SOFT.quilt), 0, 1.52, -3.43, 0, PI, 0));
  b.itrim.add(at(toBand(rbox(0.52, 0.12, 0.32, 0.06, 2), TRIM.canvas), 0.84, 1.6, -3.66, 0, -0.08, 0));
  b.itrim.add(at(beam(1.6, 0.07, 0.05, TRIM.wood), 0.3, 1.82, -2.96));
  for (const x of [-0.46, 1.06]) b.itrim.add(at(beam(0.05, 0.32, 0.05, TRIM.wood), x, 1.66, -2.96));
  for (const sx of [-1, 1]) b.itrim.add(at(beam(0.09, 2.26, 0.09, TRIM.wood), sx * 1.105, 1.13, -2.95));

  // the dinette: oak table on a pedestal, plaid benches, supper on the table
  b.itrim.add(at(beam(0.86, 0.07, 0.78, TRIM.oak), 0.78, 0.745, 1.15));
  b.itrim.add(at(beam(0.9, 0.035, 0.82, TRIM.wood), 0.78, 0.695, 1.15));
  b.itrim.add(at(rod(0.05, 0.68, TRIM.wood, { segs: 8 }), 0.78, 0.34, 1.15));
  b.itrim.add(at(rod(0.2, 0.04, TRIM.iron, { segs: 12, r2: 0.12 }), 0.78, 0.02, 1.15));
  for (const z of [0.5, 1.8]) {
    const dir = z < 1.15 ? -1 : 1;
    b.itrim.add(at(beam(0.84, 0.29, 0.4, TRIM.oak), 0.78, 0.145, z));
    b.soft.add(at(toRegion(rbox(0.84, 0.13, 0.42, 0.05, 3), SOFT.plaid), 0.78, 0.36, z));
    b.soft.add(at(toRegion(rbox(0.84, 0.5, 0.12, 0.05, 3), SOFT.plaid), 0.78, 0.7, z + dir * 0.15, dir * 0.08, 0, 0));
    b.itrim.add(at(beam(0.88, 0.06, 0.15, TRIM.wood), 0.78, 0.98, z + dir * 0.175));
    b.itrim.add(at(beam(0.05, 0.98, 0.44, TRIM.wood), 0.37, 0.49, z + dir * 0.02));
  }
  b.itrim.add(at(rod(0.05, 0.02, TRIM.brass, { segs: 8 }), 0.98, 0.79, 1.36));
  b.lamps.add(at(toLamp(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 8, 1, true), LAMPS.lantern), 0.98, 0.85, 1.36));
  b.itrim.add(at(rod(0.045, 0.025, TRIM.soot, { r2: 0.012, segs: 8 }), 0.98, 0.912, 1.36));
  b.itrim.add(at(rod(0.045, 0.12, TRIM.oak, { segs: 8 }), 0.6, 0.84, 0.98));
  for (const y of [0.8, 0.88]) b.itrim.add(at(ring(0.047, 0.006, TRIM.brass, 10), 0.6, y, 0.98, PI / 2, 0, 0));
  b.itrim.add(at(ring(0.035, 0.009, TRIM.brass, 8, PI), 0.6 - 0.045, 0.84, 0.98, 0, PI / 2, PI / 2));
  b.itrim.add(at(rod(0.11, 0.014, TRIM.brass, { segs: 12 }), 0.84, 0.787, 1.08));
  for (const [dx, dz] of [[0, 0], [0.05, 0.04], [-0.04, 0.05]]) b.itrim.add(at(toSlot(new THREE.SphereGeometry(0.038, 8, 6), TRIM.s.apple), 0.84 + dx, 0.826, 1.08 + dz));
  for (const [i, a] of [[0, 0.2], [1, -0.5], [2, 0.9]]) b.itrim.add(at(beam(0.09, 0.003, 0.13, TRIM.canvas), 0.66 + i * 0.03, 0.782 + i * 0.002, 1.32, 0, a, 0));

  // the galley: an oak cabinet (one door is the icebox: iron, frosted, a brass latch), a slate top,
  // a cast-iron stove with a pot, a kettle and a flue up through the roof, a brass basin and pump,
  // a basket of apples, a shelf of jars over the window and pans on a rail
  b.itrim.add(at(beam(0.58, 0.84, 1.22, TRIM.oak), -0.9, 0.44, 1.95));
  b.itrim.add(at(beam(0.64, 0.06, 1.28, TRIM.slate), -0.9, 0.89, 1.95));
  b.itrim.add(at(beam(0.025, 0.56, 0.52, TRIM.wood), -0.598, 0.38, 2.24));
  b.itrim.add(at(toBand(new THREE.SphereGeometry(0.022, 6, 4), TRIM.brass), -0.58, 0.5, 2.04));
  b.itrim.add(at(beam(0.03, 0.58, 0.54, TRIM.iron), -0.598, 0.38, 1.66));
  b.itrim.add(at(toSlot(new THREE.PlaneGeometry(0.4, 0.42), TRIM.s.frost), -0.581, 0.4, 1.66, 0, PI / 2, 0));
  for (const dy of [-0.24, 0.24]) b.itrim.add(at(beam(0.035, 0.04, 0.56, TRIM.brass), -0.596, 0.38 + dy, 1.66));
  b.itrim.add(at(beam(0.04, 0.12, 0.05, TRIM.brass), -0.57, 0.42, 1.88));
  for (const z of [1.66, 2.24]) {
    b.itrim.add(at(beam(0.025, 0.13, 0.52, TRIM.wood), -0.598, 0.77, z));
    b.itrim.add(at(beam(0.02, 0.025, 0.12, TRIM.brass), -0.58, 0.77, z));
  }
  b.itrim.add(at(beam(0.44, 0.05, 0.5, TRIM.iron), -0.92, 0.945, 2.25));
  for (const dz of [-0.12, 0.12]) b.itrim.add(at(toSlot(new THREE.CircleGeometry(0.1, 14), TRIM.s.burner), -0.92, 0.972, 2.25 + dz, -PI / 2, 0, 0));
  b.itrim.add(at(lathe([[0.001, 0], [0.1, 0], [0.11, 0.02], [0.115, 0.12], [0.12, 0.13], [0.001, 0.14]], TRIM.iron, 12), -0.92, 0.975, 2.13));
  b.itrim.add(at(rod(0.015, 0.02, TRIM.iron, { segs: 6 }), -0.92, 1.125, 2.13));
  b.itrim.add(at(lathe([[0.001, 0], [0.08, 0], [0.1, 0.05], [0.09, 0.12], [0.05, 0.16], [0.02, 0.17], [0.001, 0.17]], TRIM.brass, 12), -0.92, 0.975, 2.37));
  b.itrim.add(at(rod(0.014, 0.12, TRIM.brass, { r2: 0.008, segs: 6 }), -0.92, 1.06, 2.46, 0.9, 0, 0));
  b.itrim.add(at(ring(0.06, 0.009, TRIM.wood, 10, PI), -0.92, 1.14, 2.37, 0, PI / 2, 0));
  b.itrim.add(at(rod(0.06, 2.3 - 0.97, TRIM.soot, { segs: 8 }), -1.06, (0.97 + 2.3) / 2, 2.55));
  b.itrim.add(at(ring(0.065, 0.012, TRIM.iron, 10), -1.06, 1.4, 2.55, PI / 2, 0, 0));
  b.itrim.add(at(lathe([[0.001, 0.02], [0.08, 0.02], [0.13, 0.08], [0.14, 0.1], [0.125, 0.1], [0.07, 0.04]], TRIM.brass, 14), -0.92, 0.9, 1.62));
  b.itrim.add(at(rod(0.015, 0.26, TRIM.iron, { segs: 6 }), -1.1, 1.05, 1.62));
  b.itrim.add(at(rod(0.012, 0.16, TRIM.iron, { segs: 6 }), -1.03, 1.17, 1.62, 0, 0, PI / 2));
  b.itrim.add(at(lathe([[0.001, 0], [0.08, 0], [0.11, 0.07], [0.115, 0.08], [0.1, 0.08], [0.075, 0.015]], TRIM.rope, 12, 3), -0.86, 0.92, 1.9));
  for (const [dx, dz] of [[0, 0], [0.05, 0.04], [-0.04, 0.05], [0.03, -0.05]]) b.itrim.add(at(toSlot(new THREE.SphereGeometry(0.04, 8, 6), TRIM.s.apple), -0.86 + dx, 0.99 + (dx === 0 ? 0.025 : 0), 1.9 + dz));
  b.itrim.add(at(beam(0.22, 0.04, 1.1, TRIM.wood), -IN + 0.11, 2.0, 1.95));
  for (const z of [1.5, 2.4]) b.itrim.add(at(beam(0.15, 0.1, 0.02, TRIM.iron), -IN + 0.075, 1.94, z));
  for (const [z, h] of [[1.6, 0.13], [1.75, 0.1], [1.88, 0.15]]) {
    b.itrim.add(at(lathe([[0.001, 0], [0.05, 0], [0.055, 0.02], [0.05, h - 0.03], [0.03, h - 0.01], [0.03, h]], TRIM.glass, 8), -1.04, 2.02, z));
    b.itrim.add(at(rod(0.034, 0.025, TRIM.wood, { segs: 8 }), -1.04, 2.02 + h + 0.01, z));
  }
  b.itrim.add(at(toBand(rbox(0.2, 0.17, 0.16, 0.07, 2), TRIM.burlap), -1.04, 2.1, 2.2));
  b.itrim.add(at(rod(0.012, 0.8, TRIM.brass, { segs: 6 }), -1.11, 1.24, 1.82, PI / 2, 0, 0));
  b.itrim.add(at(rod(0.1, 0.025, TRIM.iron, { segs: 12 }), -1.11, 1.02, 1.62, 0, 0, PI / 2));
  b.itrim.add(at(beam(0.02, 0.15, 0.025, TRIM.wood), -1.11, 1.17, 1.62));

  // a sack of flour on the top bunk, a coil of rope hung flat on the wall (nothing to trip on)
  b.itrim.add(at(toBand(boxUV(lumpy(rbox(0.3, 0.22, 0.36, 0.1, 3), 0.02, 3)), TRIM.burlap), -0.82, 1.66, -3.25, 0, 0.3, 0.06));
  b.itrim.add(at(ring(0.13, 0.03, TRIM.rope, 14, TAU, 3), IN - 0.035, 1.35, -1.98, 0, PI / 2, 0));
  b.itrim.add(at(beam(0.03, 0.04, 0.04, TRIM.iron), IN - 0.015, 1.49, -1.98));

  sconce(b, 1, 1.6, -0.05);
  sconce(b, -1, 1.66, 1.09);
  sconce(b, 1, 1.86, -2.45);
  curtains(b, 1, A.winL[1]);
  curtains(b, 1, A.winL[2]);
  curtains(b, -1, A.winR[1]);
}

function buildCockpit(b) {
  // the dash: an oak cabinet with a walnut top, a gauge board for the driver, a radio, a glove box
  b.itrim.add(at(beam(2.3, 0.5, 0.56, TRIM.oak), 0, 0.6, 3.62));
  b.itrim.add(at(beam(2.36, 0.07, 0.62, TRIM.wood), 0, 0.885, 3.6));
  b.itrim.add(at(beam(0.5, 0.36, 0.5, TRIM.oak), 0, 0.18, 3.62));
  b.itrim.add(at(beam(0.52, 0.26, 0.02, TRIM.wood), -0.62, 0.6, 3.335));
  b.itrim.add(at(toWide(new THREE.PlaneGeometry(0.3, 0.15), TRIM.w.plaque), -0.62, 0.62, 3.322, 0, PI, 0));
  b.itrim.add(at(toBand(new THREE.SphereGeometry(0.02, 6, 4), TRIM.brass), -0.62, 0.5, 3.32));
  // the gauge board sits below the windshield's sill line (the road stays in view)
  const G = GAUGE, n = new V3(0, Math.sin(G.tilt), -Math.cos(G.tilt));
  b.itrim.add(at(beam(0.74, 0.22, 0.05, TRIM.wood), 0.62, G.y, G.z, G.tilt, 0, 0));
  b.itrim.add(at(beam(0.78, 0.035, 0.1, TRIM.brass), 0.62, G.y + 0.1, G.z + 0.08));
  b.itrim.add(at(beam(0.74, 0.12, 0.2, TRIM.wood), 0.62, 0.86, 3.62));
  for (const [dx, slot] of [[-0.29, TRIM.s.gauge], [0.29, TRIM.s.fuel]]) {
    const p = new V3(0.62 + dx, G.y, G.z).addScaledVector(n, 0.03);
    b.itrim.add(at(toSlot(new THREE.CircleGeometry(0.06, 16), slot), p.x, p.y, p.z, G.tilt, PI, 0));
  }
  b.itrim.add(at(beam(0.3, 0.12, 0.22, TRIM.wood), 0, 0.98, 3.46));
  b.itrim.add(at(toWide(new THREE.PlaneGeometry(0.26, 0.11), TRIM.w.radio), 0, 0.98, 3.348, 0, PI, 0));
  b.itrim.add(at(beam(0.035, 0.07, 0.03, TRIM.iron), 0.17, 0.95, 3.42));
  // the steering column (the wheel itself turns: see RVView)
  const ax = new V3(0, -Math.sin(0.9), Math.cos(0.9));
  b.itrim.add(at(rod(0.03, 0.4, TRIM.iron), 0.62, WHEEL_POS.y + ax.y * 0.2, WHEEL_POS.z + ax.z * 0.2, Math.atan2(ax.z, ax.y), 0, 0));
  // seats: oak pedestals, plaid tufted cushions and high backs, oak arms
  for (const sx of [-1, 1]) {
    const x = sx * 0.62;
    b.itrim.add(at(beam(0.5, 0.27, 0.5, TRIM.oak), x, 0.135, 2.86));
    b.soft.add(at(toRegion(rbox(0.62, 0.18, 0.6, 0.06, 2), SOFT.plaid), x, 0.36, 2.86));
    b.soft.add(at(toRegion(rbox(0.62, 0.84, 0.17, 0.07, 2), SOFT.plaid), x, 0.86, 2.58, -0.12, 0, 0));
    for (const ax2 of [-1, 1]) {
      b.itrim.add(at(beam(0.07, 0.07, 0.48, TRIM.oak), x + ax2 * 0.34, 0.6, 2.84));
      b.itrim.add(at(beam(0.05, 0.22, 0.05, TRIM.oak), x + ax2 * 0.34, 0.47, 3.02));
    }
  }
}
const GAUGE = { y: 0.93, z: 3.53, tilt: 0.7 };
const WHEEL_POS = { x: 0.62, y: 0.89, z: 3.22 };

// ---- the roof (a Repo Man part) ------------------------------------------------------------------

function buildRoof(b) {
  buildRoofShell(b);
  // the ceiling: boards between heavy beams (unevenly spaced), inside
  b.ceil.add(setUV(at(new THREE.PlaneGeometry(2.3, 7.8), 0, 2.298, 0, PI / 2, 0, 0), (x, y, z) => [z / 2.0, (x + 1.15) / 2.3]));
  for (const z of [-3.3, -2.28, -1.06, 0.05, 1.18, 2.16, 3.28]) b.itrim.add(at(beam(2.3, 0.11, 0.14, TRIM.wood), 0, 2.24, z));
  for (const sx of [-1, 1]) b.itrim.add(at(beam(0.1, 0.12, 7.8, TRIM.wood), sx * 1.1, 2.24, 0));

  const R = (x, z) => roofY(x, z);
  // the front: a cargo rack with a barrel, a crate, a bedroll and a goblin pennant
  {
    const y0 = R(0, 3.1);
    for (const sx of [-1, 1]) {
      b.trim.add(at(rod(0.02, 1.42, TRIM.iron, { segs: 6 }), sx * 0.95, y0 + 0.2, 3.15, PI / 2 + 0.02, 0, 0));
      for (const z of [2.45, 3.85]) b.trim.add(at(rod(0.022, 0.24, TRIM.iron, { segs: 6 }), sx * 0.95, y0 + 0.08, z));
    }
    for (const z of [2.45, 3.85]) b.trim.add(at(rod(0.02, 1.92, TRIM.iron, { segs: 6 }), 0, y0 + 0.2, z, 0, 0, PI / 2));
    for (const z of [2.9, 3.4]) b.trim.add(at(rod(0.014, 1.9, TRIM.iron, { segs: 5 }), 0, y0 + 0.03, z, 0, 0, PI / 2));
    b.trim.add(at(lathe([[0.001, 0], [0.19, 0], [0.22, 0.1], [0.235, 0.25], [0.22, 0.4], [0.19, 0.5], [0.001, 0.5]], TRIM.oak, 12, 2), 0.55, y0, 3.2, 0, 0, 0.03));
    for (const y of [0.08, 0.42]) b.trim.add(at(ring(0.205 + (y > 0.2 ? 0 : 0.008), 0.012, TRIM.iron, 14), 0.55 + y * 0.03, y0 + y, 3.2, PI / 2, 0, 0));
    b.trim.add(at(rboxB(0.5, 0.38, 0.5, 0.03, TRIM.oak, 2), -0.4, y0 + 0.19, 2.95, 0, 0.15, 0.02));
    b.trim.add(at(beam(0.52, 0.04, 0.52, TRIM.iron), -0.4, y0 + 0.36, 2.95, 0, 0.15, 0.02));
    b.trim.add(at(rod(0.13, 0.9, TRIM.canvas, { segs: 10 }), -0.25, y0 + 0.13, 3.62, 0, 0.05, PI / 2));
    for (const dx of [-0.25, 0.25]) b.trim.add(at(ring(0.135, 0.014, TRIM.leather, 12, TAU, 2), -0.25 + dx, y0 + 0.13, 3.62 + dx * 0.05, 0, PI / 2, 0));
    // pennant: a short leaning pole, a red swallow-tail flag with the crest
    const pb = [0.95, y0 + 0.2, 3.85], pt = [0.98, y0 + 0.78, 3.83];
    b.trim.add(rodAB(0.016, pb, pt, TRIM.wood, { segs: 5 }));
    const fl = new THREE.Shape(); fl.moveTo(0, 0); fl.lineTo(-0.36, -0.03); fl.lineTo(-0.27, -0.09); fl.lineTo(-0.36, -0.16); fl.lineTo(0, -0.17); fl.closePath();
    const fg = new THREE.ExtrudeGeometry(fl, { depth: 0.008, bevelEnabled: false });
    fg.rotateY(-PI / 2 + 0.25); fg.translate(pt[0], pt[1] - 0.02, pt[2] - 0.004);
    b.trim.add(toBand(boxUV(fg, 2.4), TRIM.red));
    b.trim.add(at(toBand(new THREE.SphereGeometry(0.025, 6, 4), TRIM.brass), pt[0], pt[1] + 0.02, pt[2]));
    b.snow.add(at(snowCap(0.52, 0.52, 0.08, 1), -0.4, y0 + 0.42, 2.95, 0, 0.15, 0));
    b.snow.add(at(snowCap(0.38, 0.38, 0.07, 2), 0.56, y0 + 0.54, 3.2));
    b.snow.add(at(snowCap(0.9, 0.2, 0.05, 3), -0.25, y0 + 0.27, 3.62, 0, 0.05, 0));
    // Westfall: a haybale and a pitchfork. Tanaris: a canvas sunshade over the rack.
    b.bio_fields.add(at(toBand(boxUV(lumpy(rbox(0.8, 0.44, 0.48, 0.1, 3), 0.02, 5)), TRIM.hay), 0.25, y0 + 0.24, 2.62, 0, 0.08, 0));
    for (const dx of [-0.2, 0.2]) b.bio_fields.add(at(toBand(new THREE.TorusGeometry(0.235, 0.008, 4, 14), TRIM.rope), 0.25 + dx, y0 + 0.24, 2.62, 0, PI / 2 + 0.08, 0, [1, 1.0, 1]));
    const sh = [[-0.95, 2.45], [0.95, 2.45], [-0.95, 3.85], [0.95, 3.85]];
    for (const [x, z] of sh) b.bio_desert.add(rodAB(0.018, [x, y0 + 0.2, z], [x * 1.02, y0 + 0.82, z], TRIM.wood, { segs: 5 }));
    const can = new THREE.PlaneGeometry(2.0, 1.5, 8, 6);
    {
      const p = can.attributes.position;
      for (let k = 0; k < p.count; k++) { const x = p.getX(k), y = p.getY(k); p.setZ(k, -0.1 * Math.cos(x / 1.0 * PI / 2) * Math.cos(y / 0.75 * PI / 2) + 0.02 * Math.sin(x * 5 + y * 3)); }
      can.computeVertexNormals();
      at(can, 0, y0 + 0.84, 3.15, -PI / 2, 0, 0);
    }
    const under = can.clone();
    b.bio_desert.add(toBand(can, TRIM.awning, 2));
    b.bio_desert.add(flip(toBand(under, TRIM.canvas, 2)));
  }
  // the stove's chimney (over the galley): an elbowed stovepipe with an iron band at the joint and
  // a spark-arrestor cage over a brass cone, sooty at the top
  {
    const x = -1.06, z = 2.55, y0 = R(x, z) - 0.02;
    b.trim.add(at(lathe([[0.16, 0], [0.15, 0.03], [0.1, 0.06], [0.09, 0.08], [0.001, 0.08]], TRIM.brass, 10), x, y0, z));
    const p1 = [x, y0 + 0.05, z], p2 = [x + 0.012, y0 + 0.32, z + 0.01], p3 = [x + 0.03, y0 + 0.55, z - 0.07];
    b.trim.add(rodAB(0.085, p1, p2, TRIM.iron, { segs: 10 }));
    b.trim.add(rodAB(0.085, p2, p3, TRIM.soot, { segs: 10 }));
    b.trim.add(at(ring(0.092, 0.016, TRIM.iron, 12), p2[0], p2[1], p2[2], PI / 2 - 0.15, 0, 0));
    b.trim.add(at(toBand(new THREE.SphereGeometry(0.095, 10, 6), TRIM.iron), ...p2));
    b.trim.add(at(lathe([[0.09, 0], [0.13, 0.04], [0.12, 0.06], [0.04, 0.16], [0.001, 0.17]], TRIM.brass, 10), p3[0], p3[1] - 0.01, p3[2], -0.3, 0, 0));
    for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + PI / 4; b.trim.add(at(ring(0.11, 0.008, TRIM.soot, 8, PI), p3[0], p3[1] + 0.02, p3[2], 0, a, 0)); }
    b.snow.add(at(snowCap(0.3, 0.3, 0.06, 4), p3[0], p3[1] + 0.13, p3[2] - 0.04));
  }
  // the vent hatch: oak with iron straps and a hinge
  {
    const y0 = R(0, 0.62);
    b.trim.add(at(beam(0.66, 0.04, 0.66, TRIM.iron), 0, y0 + 0.01, 0.62));
    b.trim.add(at(rboxB(0.6, 0.1, 0.6, 0.02, TRIM.oak, 2), 0, y0 + 0.07, 0.62, 0.06, 0, 0));
    for (const dz of [-0.2, 0.2]) b.trim.add(at(beam(0.62, 0.014, 0.06, TRIM.iron), 0, y0 + 0.125 + dz * 0.06, 0.62 + dz, 0.06, 0, 0));
    b.trim.add(at(rod(0.025, 0.5, TRIM.iron, { segs: 6 }), 0, y0 + 0.06, 0.31, 0, 0, PI / 2));
    b.snow.add(at(snowCap(0.62, 0.62, 0.07, 5), 0, y0 + 0.15, 0.62, 0.06, 0, 0));
  }
  // a plank walkway along the crown from the ladder to the rack (it is what people stand on)
  {
    const x = 0.66, y = 2.425;
    for (const dx of [-0.17, 0.17]) b.trim.add(at(beam(0.06, 0.05, 6.1, TRIM.wood), x + dx, y - 0.04, -0.85));
    for (let z = -3.88, i = 0; z < 2.2; z += 0.16, i++) b.trim.add(at(rboxB(0.5, 0.03, 0.135, 0.012, i % 5 === 3 ? TRIM.wood : TRIM.oak, 2, 1.2), x + (i % 3 - 1) * 0.008, y - 0.015, z + 0.07, 0, (i % 4 - 1.5) * 0.012, 0));
  }
  // a goblin cooling contraption: a riveted green box, a fan grille, brass pipes
  {
    const x = -0.38, z = -1.0, y0 = R(x, z);
    b.trim.add(at(rboxB(0.72, 0.26, 0.72, 0.04, TRIM.green, 2), x, y0 + 0.13, z));
    b.trim.add(at(toSlot2(new THREE.CircleGeometry(0.26, 16), TRIM.s2.fan), x, y0 + 0.262, z, -PI / 2, 0, 0));
    b.trim.add(at(ring(0.27, 0.02, TRIM.brass, 18), x, y0 + 0.262, z, PI / 2, 0, 0));
    b.trim.add(at(rod(0.03, 0.6, TRIM.brass, { segs: 6 }), x - 0.42, y0 + 0.06, z, PI / 2, 0, 0));
    b.trim.add(at(rod(0.03, 0.12, TRIM.brass, { segs: 6 }), x - 0.38, y0 + 0.06, z + 0.3, 0, 0, PI / 2));
    b.snow.add(at(snowCap(0.74, 0.74, 0.06, 6), x, y0 + 0.28, z));
  }
  // the back of the roof: sacks, a rolled carpet tied with rope, a small iron-bound chest
  {
    for (const [x, z, a, s] of [[-0.55, -2.5, 0.4, 1], [-0.85, -2.95, -0.3, 0.9], [-0.38, -3.0, 1.2, 0.85]]) {
      const y0 = R(x, z);
      b.trim.add(at(toBand(boxUV(lumpy(rbox(0.36 * s, 0.24 * s, 0.5 * s, 0.11 * s, 3), 0.025, x * 7)), TRIM.burlap), x, y0 + 0.11 * s, z, 0.04, a, 0.05));
      b.snow.add(at(snowCap(0.3 * s, 0.42 * s, 0.06, x * 3), x, y0 + 0.24 * s, z, 0, a, 0));
    }
    const cy = R(-0.3, -3.55) + 0.13;
    b.trim.add(at(rod(0.13, 1.25, TRIM.carpet, { segs: 10, density: 0.8 }), -0.32, cy, -3.55, 0, 0.06, PI / 2));
    b.trim.add(at(toSlot2(new THREE.CircleGeometry(0.13, 10), TRIM.s2.map), -0.32 - 0.626, cy, -3.55 + 0.04, 0, -PI / 2, 0));
    for (const dx of [-0.35, 0.3]) b.trim.add(at(ring(0.134, 0.012, TRIM.rope, 12), -0.32 + dx, cy, -3.55 + dx * 0.06, 0, PI / 2, 0));
    b.snow.add(at(snowCap(1.2, 0.2, 0.05, 8), -0.32, cy + 0.13, -3.55, 0, 0.06, 0));
    const x = 0.15, z = -2.45, y0 = R(x, z);
    b.trim.add(at(rboxB(0.46, 0.3, 0.32, 0.03, TRIM.oak, 2), x, y0 + 0.15, z, 0, -0.2, 0));
    for (const dx of [-0.15, 0.15]) b.trim.add(at(beam(0.04, 0.31, 0.33, TRIM.iron), x + dx * Math.cos(0.2), y0 + 0.155, z + dx * Math.sin(0.2), 0, -0.2, 0));
    b.trim.add(at(beam(0.07, 0.08, 0.02, TRIM.brass), x - 0.03, y0 + 0.24, z - 0.165, 0, -0.2, 0));
    b.snow.add(at(snowCap(0.48, 0.34, 0.07, 9), x, y0 + 0.33, z, 0, -0.2, 0));
    // Westfall: a pitchfork lying on the roof
    const f0 = [-0.95, R(-0.9, -1.9) + 0.04, -1.2], f1 = [-0.7, R(-0.7, -2.6) + 0.04, -2.45];
    b.bio_fields.add(rodAB(0.018, f0, f1, TRIM.oak, { segs: 5 }));
    for (const dx of [-0.06, 0, 0.06]) b.bio_fields.add(rodAB(0.008, [f0[0] + dx, f0[1], f0[2]], [f0[0] + dx * 1.3 - 0.07, f0[1] + 0.01, f0[2] + 0.32], TRIM.iron, { segs: 4 }));
    b.bio_fields.add(at(beam(0.16, 0.02, 0.03, TRIM.iron), f0[0], f0[1], f0[2] + 0.01, 0, 0.3, 0));
  }
  // the roof's snow blanket (day 3)
  buildRoofSnow(b);
}

// ---- the rear wall (a Repo Man part: "doors") ----------------------------------------------------

function buildRear(b, wheel) {
  const rw = A.rearWin;
  const so = new THREE.Shape(); so.moveTo(-HW, A.y0); so.lineTo(HW, A.y0); so.lineTo(HW, WH); so.lineTo(-HW, WH); so.closePath();
  so.holes.push(rr(new THREE.Path(), -rw.x, rw.y0, rw.x, rw.y1, 0.08));
  b.body.add(setUV(wallGeo(so, 'z', -HL, -1), uvRear));
  const si = new THREE.Shape(); si.moveTo(-IN, 0); si.lineTo(IN, 0); si.lineTo(IN, WH); si.lineTo(-IN, WH); si.closePath();
  si.holes.push(rr(new THREE.Path(), -rw.x, rw.y0, rw.x, rw.y1, 0.08));
  b.panel.add(setUV(wallGeo(si, 'z', -HL + 0.1, 1), uvPanelX));
  const o = { z0: -rw.x, z1: rw.x, y0: rw.y0, y1: rw.y1 };
  b.trim.add(toBand(boxUV(at(throughWall(frameShape(o, 0.07), 'z', -HL - 0.07, 1, 0.21), 0, (rw.y0 + rw.y1) / 2, 0)), TRIM.wood));
  b.trim.add(at(rboxB(rw.x * 2 + 0.3, 0.06, 0.13, 0.02, TRIM.wood, 2), 0, rw.y0 - 0.1, -HL - 0.075));
  for (const f of [1, -1]) b.trim.add(at(toBand(new THREE.PlaneGeometry(rw.x * 2, rw.y1 - rw.y0), TRIM.glass), 0, (rw.y0 + rw.y1) / 2, -HL + 0.05 + f * 0.01, 0, f > 0 ? 0 : PI, 0));
  b.glow.add(at(toLamp(new THREE.PlaneGeometry(rw.x * 2, rw.y1 - rw.y0), LAMPS.window), 0, (rw.y0 + rw.y1) / 2, -HL - 0.012, 0, PI, 0));
  b.snow.add(at(snowCap(rw.x * 2 + 0.3, 0.15, 0.08, 7), 0, rw.y0 - 0.04, -HL - 0.08));
  b.trim.add(at(beam(2.5, 0.06, 0.14, TRIM.wood), 0, 2.27, -3.95));
  // the ladder, leaning a hair, standing off the wall on iron brackets, its rails curling onto the roof
  const lz = y => -4.27 - (y + 0.26) * 0.03;
  for (const x of [0.62, 1.0]) {
    b.trim.add(rodAB(0.024, [x, -0.26, lz(-0.26)], [x, 2.55, lz(2.55)], TRIM.iron, { segs: 6 }));
    b.trim.add(rodAB(0.024, [x, 2.55, lz(2.55)], [x, 2.62, -4.22], TRIM.iron, { segs: 6 }));
    b.trim.add(rodAB(0.024, [x, 2.62, -4.22], [x, 2.42, -3.98], TRIM.iron, { segs: 6 }));
    for (const y of [0.3, 1.3, 2.0]) b.trim.add(rodAB(0.016, [x, y, -HL], [x, y, lz(y)], TRIM.iron, { segs: 5 }));
  }
  for (let y = -0.05; y < 2.5; y += 0.3) { b.trim.add(at(rod(0.017, 0.4, TRIM.iron, { segs: 5 }), 0.81, y, lz(y), 0, 0, PI / 2)); b.snow.add(at(snowCap(0.36, 0.05, 0.04, y * 5), 0.81, y + 0.03, lz(y))); }
  b.trim.add(at(ring(0.16, 0.035, TRIM.rope, 16, TAU, 3), 0.81, 1.62, lz(1.62) - 0.06, 0, 0, 0.2));
  b.trim.add(at(ring(0.13, 0.03, TRIM.rope, 14, TAU, 3), 0.83, 1.58, lz(1.58) - 0.08, 0.3, 0, -0.4));
  lantern(b, 1.12, 1.95, lz(1.95) - 0.02, 0.9);
  b.trim.add(rodAB(0.008, [1.0, 2.05, lz(2.05)], [1.12, 2.08, lz(2.08) - 0.02], TRIM.iron, { segs: 4 }));
  // the spare on its bracket
  b.trim.add(at(wheel.clone(), -0.4, 0.98, -4.24, 0, PI / 2, 0, 0.86));
  b.trim.add(at(beam(0.12, 0.12, 0.2, TRIM.iron), -0.4, 0.98, -4.08));
  b.snow.add(at(new THREE.TorusGeometry(0.48, 0.055, 6, 14, PI * 0.8), -0.4, 0.98, -4.24, 0, 0, PI * 0.1));
  // Dun Morogh: snowshoes on the ladder. Badlands: a tumbleweed snagged on the ladder's foot.
  // Westfall: a sheaf of wheat tied to the ladder.
  for (const dx of [-0.08, 0.08]) {
    b.bio_snow.add(at(toBand(new THREE.TorusGeometry(0.15, 0.015, 5, 14), TRIM.oak), 0.81 + dx, 0.85, lz(0.85) - 0.05, 0, 0, 0, [0.6, 1, 1]));
    b.bio_snow.add(at(beam(0.16, 0.2, 0.01, TRIM.leather), 0.81 + dx, 0.85, lz(0.85) - 0.05));
  }
  b.bio_badlands.add(at(toBand(lumpy(new THREE.IcosahedronGeometry(0.28, 1), 0.05, 2), TRIM.rope, 2), 0.95, -0.02, -4.45));
  b.bio_fields.add(at(rod(0.09, 0.7, TRIM.hay, { segs: 8, r2: 0.13 }), 0.81, 1.0, lz(1.0) - 0.1, 0.1, 0, 0.05));
  b.bio_fields.add(at(ring(0.1, 0.012, TRIM.rope, 10), 0.81, 0.92, lz(0.92) - 0.1, PI / 2, 0, 0));
}

// ---- the door (a Repo Man part; hinged at its rear edge) -----------------------------------------

function buildDoor(b) {
  const dz0 = D.DOOR_Z - D.DOOR_HALF, L = D.DOOR_HALF * 2;
  const s = new THREE.Shape(); s.moveTo(0.02, 0.02); s.lineTo(L - 0.02, 0.02); s.lineTo(L - 0.02, 2.0); s.lineTo(0.02, 2.0); s.closePath();
  b.body.add(setUV(wallGeo(s, 'x', -0.03, -1), (x, y, z) => uvSideR(x, y, z + dz0)));
  b.panel.add(setUV(wallGeo(s, 'x', 0.03, 1), uvPanelZ));
  const gs = new THREE.Shape(); gs.moveTo(0.02, 0.02); gs.lineTo(L - 0.02, 0.02); gs.lineTo(L - 0.02, 1.02); gs.lineTo(0.02, 1.02); gs.closePath();
  b.grime.add(setUV(wallGeo(gs, 'x', -0.034, -1), (x, y, z) => [(z + dz0 + HL) / 8, 0.5 + 0.5 * GV(y)]));
  // a framed plank door: border boards, strap hinges, a brass porthole, ring pulls
  for (const z of [0.045, L - 0.045]) b.trim.add(at(beam(0.075, 1.98, 0.05, TRIM.wood), 0, 1.01, z));
  for (const y of [0.045, 1.975]) b.trim.add(at(beam(0.075, 0.05, L - 0.04, TRIM.wood), 0, y, L / 2));
  b.trim.add(at(beam(0.07, 0.05, L - 0.1, TRIM.wood), 0, 0.95, L / 2));
  b.trim.add(at(rboxB(0.1, 0.14, L - 0.12, 0.045, TRIM.oak, 2), -0.08, A.rail, L / 2));
  for (const f of [-1, 1]) {
    b.trim.add(at(ring(0.163, 0.026, TRIM.brass, 20), f * 0.04, 1.45, L / 2, 0, PI / 2, 0));
    b.trim.add(at(toBand(new THREE.CircleGeometry(0.15, 16), TRIM.glass), f * 0.034, 1.45, L / 2, 0, f * PI / 2, 0));
    b.trim.add(at(beam(0.012, 0.16, 0.08, TRIM.iron), f * 0.042, 1.02, L - 0.14));
    b.trim.add(at(ring(0.045, 0.01, TRIM.brass, 10), f * 0.055, 0.99, L - 0.14, 0, PI / 2, 0));
  }
  b.glow.add(at(toLamp(new THREE.CircleGeometry(0.15, 16), LAMPS.port), -0.045, 1.45, L / 2, 0, -PI / 2, 0));
  for (const y of [0.4, 1.62]) {
    b.trim.add(at(beam(0.012, 0.07, 0.46, TRIM.iron), -0.042, y, 0.25));
    b.trim.add(at(rod(0.04, 0.012, TRIM.iron, { segs: 8 }), -0.042, y, 0.48, 0, 0, PI / 2));
    for (const z of [0.1, 0.25, 0.4]) b.trim.add(at(rod(0.012, 0.012, TRIM.brass, { segs: 5 }), -0.05, y, z, 0, 0, PI / 2));
  }
}

// ---- wheels, hook, strap -------------------------------------------------------------------------

// A fat tire with painted chunky lugs on a muted red-spoked hub with an iron rim ring and a brass
// cap, axle along X.
function wheelGeo() {
  const R = A.tireR, H = A.tireW / 2;
  const prof = [[0.34, -H + 0.035], [0.41, -H + 0.005], [0.48, -H], [0.525, -H + 0.03], [0.546, -0.14], [R, -0.05], [R, 0.05], [0.546, 0.14], [0.525, H - 0.03], [0.48, H], [0.41, H - 0.005], [0.34, H - 0.035]];
  const parts = [
    lathe(prof, TRIM.tread, 24, 3),
    at(toSlot(new THREE.CircleGeometry(0.34, 18), TRIM.s.hub), 0, H - 0.035, 0, -PI / 2, 0, 0),
    at(toSlot(new THREE.CircleGeometry(0.34, 18), TRIM.s.hub), 0, -H + 0.035, 0, PI / 2, 0, 0),
    at(ring(0.335, 0.026, TRIM.iron, 22), 0, H - 0.03, 0, PI / 2, 0, 0),
    at(ring(0.335, 0.026, TRIM.iron, 22), 0, -H + 0.03, 0, PI / 2, 0, 0),
    rod(0.075, 2 * H - 0.02, TRIM.brass, { segs: 10 }),
    at(toBand(new THREE.SphereGeometry(0.075, 10, 4, 0, TAU, 0, PI / 2), TRIM.brass), 0, H - 0.01, 0),
    at(toBand(new THREE.SphereGeometry(0.075, 10, 4, 0, TAU, 0, PI / 2), TRIM.brass), 0, -H + 0.01, 0, PI, 0, 0),
  ].map(prep);
  const g = mergeGeometries(parts);
  g.rotateZ(PI / 2);
  return g;
}
function hookGeo() {
  const parts = [
    at(ring(0.12, 0.042, TRIM.red, 14, PI * 1.45), 0, -0.44, 0, 0, 0, PI / 2),
    at(rod(0.036, 0.22, TRIM.red), 0, -0.22, 0),
    at(rod(0.042, 0.09, TRIM.red, { r2: 0.004 }), 0.118, -0.42, 0),
    at(rod(0.04, 0.06, TRIM.brass, { segs: 10 }), 0, -0.13, 0),
    at(ring(0.045, 0.015, TRIM.iron, 12), 0, -0.05, 0, 0, PI / 2, 0),
  ].map(prep);
  return mergeGeometries(parts);
}
function strapGeo() {
  const g = new THREE.CylinderGeometry(0.05, 0.05, 1, 6, 1, true).translate(0, 0.5, 0).rotateX(PI / 2);
  const uv = g.attributes.uv;
  for (let k = 0; k < uv.count; k++) { const u = uv.getX(k), v = uv.getY(k); uv.setXY(k, v * 4, Math.abs(u * 2 - 1)); }
  return toBand(g, TRIM.strap);
}

// The sign-painter's font (Cinzel) ships with the client but may still be loading when the body is
// first painted; repaint the body once it is in (same seed: same paint, better letters).
let repaintAsked = false;
function repaintBodyWhenFontLoads() {
  if (repaintAsked || typeof document === 'undefined' || !document.fonts?.check) return;
  repaintAsked = true;
  let ready = true;
  try { ready = document.fonts.check('900 40px Cinzel'); } catch { ready = true; }
  if (ready) return;
  document.fonts.load('900 40px Cinzel', 'SLOPMASTER 9000').then(() => {
    if (!document.fonts.check('900 40px Cinzel')) return;
    const m = meta('rv_body'), cv = canvasFor('rv_body'), g = cv.getContext('2d');
    m.paint(g, m.w, rngFrom('rv_body'), m.h, cv);
    tex('rv_body').needsUpdate = true;
  }).catch(() => {});
}

// ---- the view ------------------------------------------------------------------------------------

export class RVView {
  constructor(scene) {
    this.g = new THREE.Group();
    scene.add(this.g);
    const g = this.g;
    this.parts = { doors: [], roof: [] };
    this.biome = null;

    const trim = painted('rv_trim');
    const mat = {
      body: painted('rv_body'),
      trim, itrim: trim,
      panel: painted('rv_paneling'),
      floor: painted('rv_floor'),
      soft: painted('rv_soft'),
      glass: painted('rv_glass', { transparent: true, side: THREE.DoubleSide }),
      snow: painted('rv_snow', { repeat: [3, 3], vertexColors: true }),
      lamps: new THREE.MeshLambertMaterial({ map: tex('rv_lamps'), emissiveMap: tex('rv_lamps'), emissive: 0x000000 }),
      // faces out: lit windows, portholes and lamp halos, seen from outside only, added on
      glow: new THREE.MeshBasicMaterial({ map: tex('rv_lamps'), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }),
      ceil: painted('rv_ceiling', { emissive: '#7a5a3e', emissiveIntensity: 0.35 }),
      grime: new THREE.MeshLambertMaterial({ map: tex('rv_grime'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    };
    for (const b of BIOMES) mat['bio_' + b] = trim;
    mat.glass.depthWrite = false;
    this.mat = mat;
    const cast = { body: true, trim: true, snow: true, ...Object.fromEntries(BIOMES.map(b => ['bio_' + b, true])) };
    this.snowMeshes = []; this.glowMeshes = []; this.interior = [];
    this.bioMeshes = Object.fromEntries(BIOMES.map(b => [b, []]));
    const emit = (parent, bk) => {
      for (const k of KINDS) {
        const m = bk[k].mesh(mat[k], !!cast[k], k === 'snow');
        if (!m) continue;
        if (k === 'snow') { m.visible = false; this.snowMeshes.push(m); }
        if (k === 'glow') { m.visible = false; this.glowMeshes.push(m); }
        if (k === 'itrim') this.interior.push(m);
        if (k.startsWith('bio_')) { m.visible = false; this.bioMeshes[k.slice(4)].push(m); }
        if (k === 'glass' || k === 'grime' || k === 'glow') m.renderOrder = 2;
        parent.add(m);
      }
    };

    const wheel = wheelGeo();
    const main = buckets();
    buildShell(main); buildFront(main); buildWinch(main); buildUnder(main); buildClutter(main); buildInterior(main); buildCockpit(main);
    // road grime over the lower body (tinted per biome): one painted side, mirrored for the other
    const gr = sideOutline(1.02, true);
    main.grime.add(setUV(wallGeo(gr, 'x', -HW - 0.004, -1), (x, y, z) => [(z + HL) / 8, 0.5 + 0.5 * GV(y)]));
    main.grime.add(setUV(wallGeo(sideOutline(1.02), 'x', HW + 0.004, 1), (x, y, z) => [(HL - z) / 8, 0.5 + 0.5 * GV(y)]));
    const gf = new THREE.Shape(); gf.moveTo(-HW, A.y0); gf.lineTo(HW, A.y0); gf.lineTo(HW, 1.02); gf.lineTo(-HW, 1.02); gf.closePath();
    main.grime.add(setUV(wallGeo(gf, 'z', HL + 0.004, 1), (x, y) => [(x + HW) / 2.5, 0.5 * GV(y)]));
    emit(g, main);

    const roof = new THREE.Group(), rb = buckets();
    buildRoof(rb); emit(roof, rb);
    g.add(roof); this.parts.roof.push(roof);

    const rear = new THREE.Group(), qb = buckets();
    buildRear(qb, wheel);
    const rg = new THREE.Shape(); rg.moveTo(-HW, A.y0); rg.lineTo(HW, A.y0); rg.lineTo(HW, 1.02); rg.lineTo(-HW, 1.02); rg.closePath();
    qb.grime.add(setUV(wallGeo(rg, 'z', -HL - 0.004, -1), (x, y) => [(HW - x) / 2.5, 0.5 * GV(y)]));
    emit(rear, qb);
    g.add(rear); this.parts.doors.push(rear);

    this.doorPivot = new THREE.Group();
    this.doorPivot.position.set(-1.2, 0, D.DOOR_Z - D.DOOR_HALF);
    const db = buckets(); buildDoor(db); emit(this.doorPivot, db);
    g.add(this.doorPivot); this.parts.doors.push(this.doorPivot);
    this.doorAng = 0;

    // headlights' reach and the cabin's lantern glow
    this.beam = new THREE.SpotLight(0xfff1c8, 0, 60, 0.5, 0.6, 1.2);
    this.beam.position.set(0, 0.5, 4.2);
    this.beam.target.position.set(0, -1, 14);
    g.add(this.beam, this.beam.target);
    this.light = new THREE.PointLight(0xffd8a0, 3, 7, 1.5);
    this.light.position.set(0, 1.95, 0.2);
    g.add(this.light);

    // the steering wheel: an oak rim, three brass spokes (the top stays open: you read the
    // odometer through it), a brass boss
    {
      const parts = [ring(0.18, 0.03, TRIM.oak, 22, TAU, 3), rod(0.045, 0.06, TRIM.brass, { segs: 10 })].map(prep);
      parts[1].rotateX(PI / 2);
      for (const a of [0, PI, -PI / 2]) parts.push(prep(at(rod(0.014, 0.16, TRIM.brass, { segs: 6 }), Math.cos(a) * 0.085, Math.sin(a) * 0.085, 0, 0, 0, a - PI / 2)));
      parts.push(prep(at(rod(0.016, 0.05, TRIM.brass, { segs: 6 }), -0.127, -0.127, -0.03, PI / 2, 0, 0)));
      const sw = new THREE.Mesh(mergeGeometries(parts), mat.trim);
      sw.position.set(WHEEL_POS.x, WHEEL_POS.y, WHEEL_POS.z); sw.rotation.x = 0.9;
      g.add(sw);
      this.steeringWheel = sw;
    }
    // the odometer and clock: cream number drums and an enamel clock plate in a brass bezel on the
    // gauge board; backlit amber at night
    this.odoCv = document.createElement('canvas'); this.odoCv.width = 384; this.odoCv.height = 80;
    this.odoTex = canvasTex(this.odoCv);
    {
      const n = new V3(0, Math.sin(GAUGE.tilt), -Math.cos(GAUGE.tilt));
      this.odoMat = new THREE.MeshLambertMaterial({ map: this.odoTex, emissiveMap: this.odoTex, emissive: 0x000000 });
      const odo = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4 * 80 / 384), this.odoMat);
      const up = new V3(0, Math.cos(GAUGE.tilt), Math.sin(GAUGE.tilt));
      odo.position.set(0.62, GAUGE.y, GAUGE.z).addScaledVector(n, 0.03).addScaledVector(up, 0.045);
      odo.rotation.set(GAUGE.tilt, PI, 0);
      g.add(odo);
    }
    this.odoLast = '';

    // wheels: one instanced draw for all four
    this.wheelMesh = new THREE.InstancedMesh(wheel, mat.trim, RV_WHEELS.length);
    this.wheelMesh.castShadow = true; this.wheelMesh.receiveShadow = true;
    this.wheelMesh.frustumCulled = false;
    g.add(this.wheelMesh);
    this.wheels = RV_WHEELS.map(([x, y, z, steer]) => ({ x, y, z, steer }));
    this._dummy = new THREE.Object3D(); this._dummy.rotation.order = 'YXZ';
    this._cd = new THREE.Object3D();
    this.updateWheels(null);

    // the hook and the tow strap live in world space
    this.hook = new THREE.Mesh(hookGeo(), mat.trim);
    this.hook.castShadow = true;
    scene.add(this.hook);
    const strapMat = new THREE.MeshLambertMaterial({ map: tex('rv_trim'), emissive: new THREE.Color('#5a2a00') });   // a bright tow strap reads at 40 m
    this.cableN = 16;
    this.cable = new THREE.InstancedMesh(strapGeo(), strapMat, this.cableN);
    this.cable.castShadow = true;
    this.cable.frustumCulled = false;
    this.cable.visible = false;
    scene.add(this.cable);
    this.cablePts = Array.from({ length: this.cableN + 1 }, () => new V3());
    this._v = new V3(); this._dir = new V3(); this._up = new V3(0, 1, 0);
    this.setBiome(atmo.biome);
    repaintBodyWhenFontLoads();
  }

  setParts(parts) {
    for (const p of this.parts.doors) p.visible = parts.doors !== false;
    for (const p of this.parts.roof) p.visible = parts.roof !== false;
    // with the roof gone the sun gets in: the furniture casts shadows again
    for (const m of this.interior) m.castShadow = parts.roof === false;
  }

  setBiome(b) {
    this.biome = b;
    const [tint, op] = GRIME[b] || GRIME.meadow;
    this.mat.grime.color.set(tint);
    this.mat.grime.opacity = op;
    for (const m of this.snowMeshes) m.visible = b === 'snow';
    for (const [k, list] of Object.entries(this.bioMeshes)) for (const m of list) m.visible = k === b;
  }

  updateWheels(rv) {
    const d = this._dummy;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const susp = rv?.wheels?.[i * 2] ?? SUSP_REST;
      const rot = rv?.wheels?.[i * 2 + 1] ?? 0;
      d.position.set(w.x, w.y - susp + A.tireLift, w.z);
      d.rotation.set(rot, w.steer ? (rv?.steer ?? 0) : 0, 0);
      d.updateMatrix();
      this.wheelMesh.setMatrixAt(i, d.matrix);
    }
    this.wheelMesh.instanceMatrix.needsUpdate = true;
  }

  drawOdo(odo, clockStr) {
    const g = this.odoCv.getContext('2d'), W = 384, H = 80;
    const gr = (x0, y0, x1, y1, stops) => { const l = g.createLinearGradient(x0, y0, x1, y1); for (const [t, c] of stops) l.addColorStop(t, c); return l; };
    // the brass bezel, a little verdigris
    g.fillStyle = gr(0, 0, 0, H, [[0, '#d8bc72'], [0.5, '#a07a36'], [1, '#553a1a']]); g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(110,140,106,0.35)'; g.beginPath(); g.ellipse(196, 72, 22, 6, 0.1, 0, TAU); g.fill();
    for (const [rx, ry] of [[7, 7], [W - 7, 7], [7, H - 7], [W - 7, H - 7], [192, 7], [192, H - 7]]) { g.fillStyle = '#553a1a'; g.beginPath(); g.arc(rx, ry, 3, 0, TAU); g.fill(); g.fillStyle = '#ecd08a'; g.beginPath(); g.arc(rx - 0.8, ry - 0.8, 1.4, 0, TAU); g.fill(); }
    // the drum counter in a dark window: cream drums, umber numerals, shadowed top and bottom
    const digits = String(Math.max(0, Math.round(odo))).padStart(4, '0').slice(-5);
    const cw = 30, gap = 3, wW = digits.length * (cw + gap) + 9;
    g.fillStyle = '#24160e'; g.beginPath(); g.roundRect(16, 12, wW, 56, 5); g.fill();
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let i = 0; i < digits.length; i++) {
      const x = 22 + i * (cw + gap);
      g.fillStyle = gr(0, 15, 0, 65, [[0, '#5e4e3a'], [0.22, '#ece0c2'], [0.5, '#f6ecd2'], [0.78, '#e0d0ac'], [1, '#54442f']]);
      g.fillRect(x, 15, cw, 50);
      g.fillStyle = '#2e1c10'; g.font = `900 36px ${LETTER_FONT}`; g.fillText(digits[i], x + cw / 2, 42);
    }
    // the clock: a cream enamel plate, engraved numerals, a brass frame
    const cx0 = 32 + wW, cw2 = W - cx0 - 14;
    g.fillStyle = '#6e4f24'; g.beginPath(); g.roundRect(cx0 - 3, 9, cw2 + 6, 62, 6); g.fill();
    g.fillStyle = gr(0, 12, 0, 68, [[0, '#f4e8ca'], [1, '#d6c6a0']]); g.beginPath(); g.roundRect(cx0, 12, cw2, 56, 4); g.fill();
    let fs = 34; g.font = `900 ${fs}px ${LETTER_FONT}`;
    while (g.measureText(clockStr || '').width > cw2 - 12 && fs > 14) { fs -= 1; g.font = `900 ${fs}px ${LETTER_FONT}`; }
    g.fillStyle = 'rgba(255,248,230,0.85)'; g.fillText(clockStr || '', cx0 + cw2 / 2 + 1, 42);
    g.fillStyle = '#3a2418'; g.fillText(clockStr || '', cx0 + cw2 / 2, 41);
    this.odoTex.needsUpdate = true;
  }

  update(dt, rv, door, night, hook, odo, clockStr) {
    if (!rv) return;
    if (atmo.biome !== this.biome) this.setBiome(atmo.biome);
    this.g.position.set(rv.p.x, rv.p.y, rv.p.z);
    this.g.quaternion.set(rv.q.x, rv.q.y, rv.q.z, rv.q.w);
    const target = door ? -1.75 : 0;
    this.doorAng += (target - this.doorAng) * Math.min(1, dt * 6);
    this.doorPivot.rotation.y = this.doorAng;
    this.updateWheels(rv);
    this.steeringWheel.rotation.z = rv.steer * 2.2;
    this.mat.lamps.emissive.setHex(night ? 0xffffff : 0x000000);
    this.odoMat.emissive.setHex(night ? 0x9a6a3a : 0x000000);
    for (const m of this.glowMeshes) m.visible = !!night;
    this.beam.intensity = night ? 40 : 0;
    this.light.intensity = night ? 6 : 1.5;
    // dash readout
    const s = `${String(Math.max(0, Math.round(odo))).padStart(4, '0')} m  ${clockStr}`;
    if (s !== this.odoLast) { this.odoLast = s; this.drawOdo(odo, clockStr); }
    // winch strap: fairlead → hook with a lazy sag
    const wp = this._v.copy(CABLE_START).applyQuaternion(this.g.quaternion).add(this.g.position);
    if (!hook || hook.state === 0) {
      this.hook.position.copy(HOOK_STOW).applyQuaternion(this.g.quaternion).add(this.g.position);
      this.hook.quaternion.copy(this.g.quaternion);
      this.cable.visible = false;
    } else {
      this.hook.position.set(hook.x, hook.y, hook.z);
      const d = wp.distanceTo(this.hook.position);
      const slack = Math.max(0, hook.len - d);
      const sag = Math.min(3, slack * 0.5 + 0.05 * d);
      const P = this.cablePts;
      for (let i = 0; i < P.length; i++) {
        const t = i / (P.length - 1);
        P[i].lerpVectors(wp, this.hook.position, t);
        P[i].y -= Math.sin(t * PI) * sag;
      }
      const o = this._cd;
      for (let i = 0; i < this.cableN; i++) {
        const a = P[i], b = P[i + 1];
        o.position.copy(a);
        o.scale.set(1, 1, Math.max(0.001, a.distanceTo(b)));
        o.lookAt(b);
        o.updateMatrix();
        this.cable.setMatrixAt(i, o.matrix);
      }
      this.cable.instanceMatrix.needsUpdate = true;
      this.cable.visible = true;
      // the hook hangs along the last stretch of strap
      this._dir.subVectors(P[P.length - 2], P[P.length - 1]).normalize();
      this.hook.quaternion.setFromUnitVectors(this._up, this._dir);
    }
    this.hook.visible = true;
  }
}

// ---- preview (tools/preview.mjs) ----
// The RV, its hook and strap all go into one root (the preview frames whatever it is handed).
function previewRV({ yaw = 0, door = false, night = false, parts = null, steer = 0.2, hook = null, colliders = false } = {}) {
  const root = new THREE.Group();
  const v = new RVView(root);
  if (parts) v.setParts(parts);
  const q = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
  for (let i = 0; i < 30; i++) v.update(0.1, { p: { x: 0, y: 1.36, z: 0 }, q, v: { x: 0, y: 0, z: 0 }, steer, wheels: [] }, door, night, hook, 120, '9:41 AM');
  v.g.name = 'rv';
  if (colliders) {
    // the physics boxes of shared/rv.js as wireframes, to check the art against them
    const wm = new THREE.LineBasicMaterial({ color: 0xff2060 });
    for (const [, hx, hy, hz, cx, cy, cz, o] of RV_PARTS) {
      if (o?.part && parts && parts[o.part] === false) continue;
      const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2)), wm);
      box.position.set(cx, cy, cz);
      v.g.add(box);
    }
  }
  return root;
}
export const PREVIEW = {
  rv: () => previewRV(),
  rv_side: () => previewRV({ yaw: PI / 2 }),
  rv_rear: () => previewRV({ yaw: PI }),
  rv_night: () => previewRV({ door: true, night: true }),
  rv_bare: () => previewRV({ parts: { doors: false, roof: false }, door: false, yaw: PI * 0.75 }),
  rv_tow: () => previewRV({ hook: { state: 2, x: 1.2, y: 0.35, z: 11, len: 7.5 } }),
  rv_colliders: () => previewRV({ parts: { doors: false, roof: false }, colliders: true }),
};
