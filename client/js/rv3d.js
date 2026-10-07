// The Slopmaster 9000, as seen from outside and in: a 1970s motorhome rebuilt the way Blizzard's
// 2004 artists would have built it for a goblin zone. A cream body painted as one atlas (rv_body:
// riveted panels, a worn orange/brown stripe, a wood-grain band with the name gilded on it), a
// half-timbered frame of chunky dark beams, brass lamps and trim, riveted iron, fat painted tires
// on spoked red hubs, and a goblin winch on the nose. Inside: an inn room on wheels.
//
// Draw calls: everything static is merged per material (8 meshes); the roof, the rear wall and the
// door are their own groups (the Repo Man takes them, see setParts); the wheels and the tow strap
// are instanced. The interior matches shared/rv.js (RV_PARTS) box for box: walls, floor, roof,
// door, dash, seats, table, benches, counter, shower stall, bunks, steps and bumpers.
// The road grime and the snow follow the day's biome (atmo.biome).
import { THREE, painted, tex, canvasTex } from './gfx.js';
import { atmo } from './atmosphere.js';
import { mergeGeometries, toCreasedNormals } from '/vendor/BufferGeometryUtils.js';
import { RV_DIM, RV_WHEELS, SUSP_REST, RV_WINCH, RV_PARTS } from '/shared/rv.js';
import { RV_ART as A, TRIM, SOFT, LAMPS, BODY } from './paint/vehicle.js';

const D = RV_DIM, PI = Math.PI, TAU = PI * 2;
const V3 = THREE.Vector3, V2 = THREE.Vector2;
const HW = D.HALF_W, HL = D.HALF_L, WH = D.WALL_H;   // 1.25, 4.0, 2.3
const IN = HW - 0.1;                                   // inner face of the walls
const ROOF_TOP = D.ROOF_Y + 0.005;
const WHEEL_Y = RV_WHEELS[0][1] - SUSP_REST;           // wheel centers at rest (-0.86)
const DRUM = { x: RV_WINCH.x, y: RV_WINCH.y, z: RV_WINCH.z + 0.07 };
const CABLE_START = new V3(RV_WINCH.x, RV_WINCH.y, RV_WINCH.z + 0.21);
const HOOK_STOW = new V3(RV_WINCH.x, RV_WINCH.y + 0.02, RV_WINCH.z + 0.25);

// per-biome road grime [tint, opacity]: Elwynn mud, Westfall dust, Dun Morogh salt slush,
// Badlands red dust, Tanaris sand
const GRIME = { meadow: ['#6b5232', 0.8], fields: ['#b8975a', 0.85], snow: ['#e4ecf2', 0.85], badlands: ['#b4552f', 0.9], desert: ['#dcb87e', 0.85] };

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
class Bucket {
  constructor() { this.list = []; }
  add(geo) { this.list.push(prep(geo)); return geo; }
  mesh(mat, cast = true) {
    if (!this.list.length) return null;
    const g = mergeGeometries(this.list);
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mat);
    m.castShadow = cast; m.receiveShadow = true;
    return m;
  }
}
const KINDS = ['body', 'trim', 'panel', 'floor', 'soft', 'glass', 'lamps', 'snow', 'grime', 'ceil', 'glow'];
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

// ---- uv mapping ----------------------------------------------------------------------------------

const BAND = TRIM.band / TRIM.H;
// a geometry's 0..1 uv into trim band i; u repeats `ur` times along the band
function toBand(geo, i, ur = 1) {
  const uv = geo.attributes.uv, top = 1 - i * BAND - 2 / TRIM.H, bot = 1 - (i + 1) * BAND + 2 / TRIM.H;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * ur, bot + uv.getY(k) * (top - bot));
  return geo;
}
// into a 64² decal slot (band 14) or a 128×64 slot (band 15)
function toSlot(geo, i, wide = false) {
  const uv = geo.attributes.uv, sw = wide ? 128 : 64, bi = wide ? TRIM.wide : TRIM.slots;
  const u0 = (i * sw + 1.5) / TRIM.W, u1 = ((i + 1) * sw - 1.5) / TRIM.W;
  const top = 1 - (bi * TRIM.band + 1.5) / TRIM.H, bot = 1 - ((bi + 1) * TRIM.band - 1.5) / TRIM.H;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, u0 + uv.getX(k) * (u1 - u0), bot + uv.getY(k) * (top - bot));
  return geo;
}
// into a pixel region [x, y, w, h] of an S² atlas
function toRegion(geo, [x, y, w, h], S = 512, inset = 1.5) {
  const uv = geo.attributes.uv;
  for (let k = 0; k < uv.count; k++) uv.setXY(k, (x + inset + uv.getX(k) * (w - 2 * inset)) / S, 1 - (y + inset + (1 - uv.getY(k)) * (h - 2 * inset)) / S);
  return geo;
}
function setUV(geo, fn) {
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let k = 0; k < p.count; k++) { const [u, v] = fn(p.getX(k), p.getY(k), p.getZ(k)); uv.setXY(k, u, v); }
  return geo;
}
// box projection: each face picks its two in-plane axes; u runs along the longer one (in meters ×
// density, so it tiles along a band), v across the shorter one (0..1 over the piece: a band's lit
// top edge lands on the top of a beam)
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
const ring = (r, tube, band, segs = 18, arc = TAU, ur = 1) => toBand(new THREE.TorusGeometry(r, tube, 8, segs, arc), band, ur);
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
function lathe(pts, band, segs = 12, ur = 1) {
  return toBand(new THREE.LatheGeometry(pts.map(([r, y]) => new V2(r, y)), segs), band, ur);
}
// a wavy hanging cloth (curtains): a thin slab whose surface folds along z
function cloth(w, h, depth, folds, band) {
  const g = new THREE.BoxGeometry(depth, h, w, 1, 1, Math.max(4, folds * 4));
  const p = g.attributes.position;
  for (let k = 0; k < p.count; k++) p.setX(k, p.getX(k) + Math.sin((p.getZ(k) / w + 0.5) * folds * TAU) * depth * 0.9);
  g.computeVertexNormals();
  return toBand(boxUV(g, 2.5), band);
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
  // axis x: (a,y,e)→(e,y,a) mirrors unless s = -1; axis z: mirrors only when s = -1
  if ((axis === 'x') === (s > 0)) flip(g);
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
const uvRoof = (x, y, z) => [(BODY.roof + (Math.max(-HL, Math.min(HL, z)) + HL) * 64) / BODY.W, BV(BODY.endY + 2 + (1.3 - Math.max(-1.3, Math.min(1.3, x))) * (252 / 2.6))];
const uvPanelZ = (x, y, z) => [z / 1.6, y / WH];
const uvPanelX = (x, y) => [x / 1.6, y / WH];

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

function buildShell(b) {
  // outer skins (the painted atlas) and the paneled inner skins
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
  // the front wall around the windshield
  const sw = A.shield;
  const fo = new THREE.Shape(); fo.moveTo(-HW, A.y0); fo.lineTo(HW, A.y0); fo.lineTo(HW, WH); fo.lineTo(-HW, WH); fo.closePath();
  fo.holes.push(rr(new THREE.Path(), -sw.x, sw.y0, sw.x, sw.y1, 0.12));
  b.body.add(setUV(wallGeo(fo, 'z', HL, 1), uvFront));
  const fi = new THREE.Shape(); fi.moveTo(-IN, 0); fi.lineTo(IN, 0); fi.lineTo(IN, WH); fi.lineTo(-IN, WH); fi.closePath();
  fi.holes.push(rr(new THREE.Path(), -sw.x, sw.y0, sw.x, sw.y1, 0.12));
  b.panel.add(setUV(wallGeo(fi, 'z', HL - 0.1, -1), uvPanelX));

  // the timber frame: corner posts, wall plates, rub rails
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.trim.add(at(rod(0.085, 2.98, TRIM.wood, { segs: 10 }), sx * 1.215, (A.y0 + 2.38) / 2, sz * 3.965));
  for (const sx of [-1, 1]) b.trim.add(at(beam(0.14, 0.06, 8.0, TRIM.wood), sx * 1.2, 2.29, 0));
  b.trim.add(at(beam(2.5, 0.06, 0.14, TRIM.wood), 0, 2.29, 3.95));
  b.trim.add(at(beam(0.06, 0.1, 7.86, TRIM.wood), 1.275, 0, 0));
  b.trim.add(at(beam(0.06, 0.1, A.door.z0 + 3.93 - 0.06, TRIM.wood), -1.275, 0, (A.door.z0 - 0.06 - 3.93) / 2));
  b.trim.add(at(beam(0.06, 0.1, 3.93 - A.door.z1 - 0.06, TRIM.wood), -1.275, 0, (A.door.z1 + 0.06 + 3.93) / 2));

  // windows: chunky wooden frames through the wall, sills, glass; brass portholes
  for (const [side, wins] of [[1, A.winL], [-1, A.winR]]) {
    for (const o of wins) {
      if (o.r) {
        for (const x of [HW + 0.012, IN - 0.012]) b.trim.add(at(ring(o.r + 0.032, 0.038, TRIM.brass, 20), side * x, o.y, o.z, 0, PI / 2, 0));
        b.trim.add(at(flip(rod(o.r + 0.002, 0.12, TRIM.brass, { segs: 16, open: true })), side * 1.2, o.y, o.z, 0, 0, PI / 2));
        const disc = new THREE.CircleGeometry(o.r, 18);
        if (o.frost) { for (const f of [1, -1]) b.trim.add(at(toSlot(new THREE.CircleGeometry(o.r, 18), TRIM.s.frost), side * (1.2 + f * 0.01), o.y, o.z, 0, f * side * PI / 2, 0)); }
        else { b.glass.add(at(disc, side * 1.2, o.y, o.z, 0, PI / 2, 0)); b.glow.add(at(new THREE.CircleGeometry(o.r, 18), side * 1.21, o.y, o.z, 0, side * PI / 2, 0)); }
        continue;
      }
      const cz = (o.z0 + o.z1) / 2, cy = (o.y0 + o.y1) / 2, w = o.z1 - o.z0, h = o.y1 - o.y0;
      const fr = throughWall(frameShape(o, 0.075), 'x', side * (IN - 0.045), side, 0.21);
      b.trim.add(toBand(boxUV(at(fr, 0, cy, cz)), TRIM.wood));
      b.trim.add(at(beam(0.12, 0.05, w + 0.3, TRIM.wood), side * (HW + 0.07), o.y0 - 0.1, cz));
      b.trim.add(at(beam(0.07, 0.035, w + 0.16, TRIM.oak), side * (IN - 0.035), o.y0 - 0.08, cz));
      b.glass.add(at(new THREE.PlaneGeometry(w, h), side * 1.2, cy, cz, 0, PI / 2, 0));
      if (!o.cab) b.glow.add(at(new THREE.PlaneGeometry(w, h), side * 1.21, cy, cz, 0, side * PI / 2, 0));
      b.snow.add(at(rbox(0.13, 0.05, w + 0.26, 0.02, 2), side * (HW + 0.075), o.y0 - 0.06, cz));
    }
  }
  // the door jamb and its brass threshold
  for (const z of [A.door.z0 - 0.04, A.door.z1 + 0.04]) b.trim.add(at(beam(0.2, 2.08, 0.08, TRIM.wood), -1.21, 1.04, z));
  b.trim.add(at(beam(0.2, 0.1, A.door.z1 - A.door.z0 + 0.16, TRIM.wood), -1.21, 2.03, (A.door.z0 + A.door.z1) / 2));
  b.trim.add(at(beam(0.2, 0.025, A.door.z1 - A.door.z0, TRIM.brass), -1.2, 0.012, (A.door.z0 + A.door.z1) / 2));

  // wheel arches: riveted red fenders, dark wells
  const Ri = A.archR + 0.005, Ro = A.archR + 0.11, fa = 0.36;
  const fs = new THREE.Shape(); fs.absarc(0, 0, Ro, PI - fa, fa, true); fs.absarc(0, 0, Ri, fa, PI - fa, false); fs.closePath();
  for (const az of A.archZ) for (const side of [-1, 1]) {
    const g = throughWall(fs, 'x', side * (HW - 0.02), side, 0.09, { bevel: 0.012, segs: 16 });
    const p = g.attributes.position, uv = g.attributes.uv;
    for (let k = 0; k < p.count; k++) { const a = p.getZ(k), y = p.getY(k), th = Math.atan2(y, a); uv.setXY(k, th * 0.8, Math.max(0, Math.min(1, (Math.hypot(a, y) - Ri) / (Ro - Ri)))); }
    b.trim.add(at(toBand(g, TRIM.red), 0, WHEEL_Y, az));
    b.trim.add(at(toBand(flip(new THREE.CylinderGeometry(A.archR, A.archR, 0.42, 14, 1, true, 0.25, PI - 0.5)), TRIM.iron, 2), side * 1.06, WHEEL_Y, az, 0, 0, PI / 2));
  }
  // steps under the door: oak treads on iron stringers
  for (const [x, y] of [[-1.42, -0.465], [-1.64, -0.895]]) {
    b.trim.add(at(beam(0.4, 0.07, 0.92, TRIM.oak), x, y, D.DOOR_Z));
    b.trim.add(at(beam(0.03, 0.08, 0.93, TRIM.iron), x - 0.2, y - 0.005, D.DOOR_Z));
    b.snow.add(at(rbox(0.36, 0.04, 0.86, 0.015, 2), x + 0.01, y + 0.045, D.DOOR_Z));
  }
  for (const dz of [-0.48, 0.48]) b.trim.add(at(beam(0.86, 0.1, 0.03, TRIM.iron), -1.555, -0.66, D.DOOR_Z + dz, 0, 0, Math.atan2(0.6, 0.61)));
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
    b.trim.add(at(beam(0.62, 0.025, 0.02, TRIM.iron), sx * 0.5, sw.y0 + 0.12, HL + 0.07, 0, 0, sx * 0.35));
    b.trim.add(at(rod(0.025, 0.04, TRIM.brass), sx * 0.22, sw.y0 + 0.02, HL + 0.07, PI / 2, 0, 0));
  }
  // the cab-over brow: the motorhome's heavy rounded forehead, with marker lamps along it
  const bp = new THREE.Shape();
  bp.moveTo(HL - 0.03, 2.12); bp.lineTo(HL + 0.14, 2.12); bp.quadraticCurveTo(HL + 0.34, 2.12, HL + 0.34, 2.28);
  bp.lineTo(HL + 0.34, ROOF_TOP - 0.05); bp.quadraticCurveTo(HL + 0.34, ROOF_TOP, HL + 0.29, ROOF_TOP); bp.lineTo(HL - 0.03, ROOF_TOP); bp.closePath();
  // the livery wraps over the brow: gold at the crown, orange, brown underneath
  b.body.add(setUV(throughWall(bp, 'x', -HW - 0.02, 1, 2 * HW + 0.04, { bevel: 0.025, segs: 6 }), (x, y, z) => uvFront(x, A.brown[0] + (y - 2.12) / (ROOF_TOP - 2.12) * (A.gold[1] - A.brown[0]))));
  b.trim.add(at(beam(2.6, 0.05, 0.06, TRIM.brass), 0, 2.115, HL + 0.16));
  b.snow.add(at(rbox(2.66, 0.1, 0.42, 0.045, 3), 0, ROOF_TOP + 0.04, HL + 0.16));
  for (const x of [-0.9, -0.45, 0, 0.45, 0.9]) {
    b.trim.add(at(rod(0.05, 0.05, TRIM.brass, { segs: 10 }), x, 2.335, HL + 0.35, PI / 2, 0, 0));
    b.lamps.add(at(toRegion(new THREE.CircleGeometry(0.04, 12), LAMPS.amber, 256), x, 2.335, HL + 0.376));
  }
  // grille: brass frame, iron bars; the maker's cog above it
  const gs = new THREE.Shape(); rr(gs, -0.56, -0.28, 0.56, 0.62, 0.12);
  gs.holes.push(rr(new THREE.Path(), -0.47, -0.2, 0.47, 0.54, 0.07));
  b.trim.add(toBand(boxUV(throughWall(gs, 'z', HL - 0.01, 1, 0.08, { bevel: 0.012 })), TRIM.brass));
  for (let i = 0; i < 9; i++) b.trim.add(at(rod(0.022, 0.76, TRIM.iron, { segs: 6 }), -0.42 + i * 0.105, 0.17, HL + 0.035));
  b.trim.add(at(rod(0.02, 0.96, TRIM.iron, { segs: 6 }), 0, 0.17, HL + 0.05, 0, 0, PI / 2));
  b.trim.add(at(toSlot(new THREE.CircleGeometry(0.1, 18), TRIM.s.emblem), 0, 0.76, HL + 0.012));
  b.trim.add(at(ring(0.104, 0.02, TRIM.brass, 20), 0, 0.76, HL + 0.012));
  // round brass headlights and amber turn signals
  for (const sx of [-1, 1]) {
    const x = sx * 0.86;
    b.trim.add(at(rod(0.17, 0.12, TRIM.brass, { segs: 16 }), x, 0.28, HL + 0.05, PI / 2, 0, 0));
    b.trim.add(at(ring(0.158, 0.03, TRIM.brass, 20), x, 0.28, HL + 0.11));
    b.lamps.add(at(toRegion(new THREE.CircleGeometry(0.15, 20), LAMPS.head, 256), x, 0.28, HL + 0.112));
    b.trim.add(at(rod(0.072, 0.06, TRIM.brass, { segs: 12 }), x, -0.07, HL + 0.03, PI / 2, 0, 0));
    b.lamps.add(at(toRegion(new THREE.CircleGeometry(0.058, 14), LAMPS.amber, 256), x, -0.07, HL + 0.062));
  }
  // the front bumper: an iron beam faced with a plank, rounded iron ends, brass bolts
  b.trim.add(at(beam(2.4, 0.3, 0.24, TRIM.iron), 0, -0.42, 4.06));
  b.trim.add(at(beam(2.36, 0.2, 0.05, TRIM.wood), 0, -0.42, 4.195));
  for (const sx of [-1, 1]) {
    b.trim.add(at(rod(0.12, 0.33, TRIM.iron, { segs: 10 }), sx * 1.18, -0.42, 4.1));
    for (const x of [0.62, 1.0]) b.trim.add(at(rod(0.026, 0.03, TRIM.brass, { segs: 8 }), sx * x, -0.42, 4.225, PI / 2, 0, 0));
  }
  b.snow.add(at(rbox(2.5, 0.05, 0.22, 0.02, 2), 0, -0.25, 4.07));
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
  b.trim.add(at(toBand(new THREE.CylinderGeometry(0.115, 0.115, 0.46, 16), TRIM.strap, 3), x, y, z, 0, 0, PI / 2));
  for (const sx of [-1, 1]) b.trim.add(at(rod(0.19, 0.035, TRIM.iron, { segs: 18 }), x + sx * 0.25, y, z, 0, 0, PI / 2));
  // gearbox + cog
  b.trim.add(at(beam(0.14, 0.34, 0.32, TRIM.green), x + 0.355, y, z));
  const cog = throughWall(gearShape(0.12, 0.15, 10), 'x', x + 0.425, 1, 0.035);
  b.trim.add(toBand(boxUV(at(cog, 0, y, z)), TRIM.brass));
  b.trim.add(at(rod(0.035, 0.06, TRIM.iron), x + 0.46, y, z, 0, 0, PI / 2));
  // motor, fins, exhaust stack
  b.trim.add(at(rod(0.14, 0.22, TRIM.green, { segs: 14 }), x - 0.39, y, z, 0, 0, PI / 2));
  b.trim.add(at(rod(0.1, 0.04, TRIM.iron, { segs: 12 }), x - 0.52, y, z, 0, 0, PI / 2));
  for (const dx of [-0.33, -0.39, -0.45]) b.trim.add(at(ring(0.145, 0.012, TRIM.iron, 16), x + dx, y, z, 0, PI / 2, 0));
  b.trim.add(at(rod(0.026, 0.42, TRIM.brass), x - 0.42, y + 0.32, z + 0.06));
  b.trim.add(at(rod(0.05, 0.07, TRIM.brass, { r2: 0.02 }), x - 0.42, y + 0.55, z + 0.06));
  // fairlead rollers
  for (const dy of [-0.13, 0.13]) b.trim.add(at(rod(0.03, 0.42, TRIM.iron, { segs: 8 }), x, y + dy, z + 0.14, 0, 0, PI / 2));
  for (const sx of [-1, 1]) b.trim.add(at(beam(0.04, 0.34, 0.06, TRIM.iron), x + sx * 0.21, y, z + 0.14));
}

// a goblin exhaust stack up the driver's side: brass pipe, a perforated heat shield, a rain flap
function buildStack(b) {
  const x = HW + 0.15, z = 2.05, y0 = -0.35, y1 = 2.95;
  b.trim.add(at(rod(0.085, y1 - y0, TRIM.brass, { segs: 12 }), x, (y0 + y1) / 2, z));
  b.trim.add(at(rod(0.12, 0.9, TRIM.iron, { segs: 12, open: true }), x, 1.55, z));
  for (const y of [1.12, 1.98]) b.trim.add(at(ring(0.12, 0.02, TRIM.iron, 14), x, y, z, PI / 2, 0, 0));
  b.trim.add(at(rod(0.1, 0.2, TRIM.brass, { segs: 12, r2: 0.15 }), x, y1 + 0.08, z));
  b.trim.add(at(ring(0.15, 0.02, TRIM.brass, 14), x, y1 + 0.18, z, PI / 2, 0, 0));
  b.trim.add(at(toBand(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 12), TRIM.iron), x + 0.05, y1 + 0.26, z, 0, 0, -0.6));
  for (const y of [0.25, 1.3, 2.15]) b.trim.add(at(beam(0.16, 0.05, 0.06, TRIM.iron), HW + 0.07, y, z));
  b.trim.add(at(lathe([[0.075, 0], [0.12, -0.02], [0.13, -0.1], [0.075, -0.12]], TRIM.brass, 12), x, y0, z));
}

function buildUnder(b) {
  b.trim.add(at(beam(2.36, 0.03, 7.9, TRIM.iron, 0.6), 0, A.y0 + 0.02, 0));
  for (const az of A.archZ) {
    b.trim.add(at(rod(0.05, 1.86, TRIM.iron), 0, WHEEL_Y, az, 0, 0, PI / 2));
    for (const sx of [-1, 1]) b.trim.add(at(beam(0.1, 0.07, 1.2, TRIM.iron), sx * 0.86, A.y0 - 0.05, az));
  }
  b.trim.add(at(beam(0.7, 0.26, 1.1, TRIM.red), 0.45, A.y0 - 0.1, 0.1));
  b.trim.add(at(rod(0.04, 1.4, TRIM.iron), -0.65, A.y0 - 0.06, -3.4, PI / 2, 0, 0));
  // mud flaps behind the rear wheels
  for (const sx of [-1, 1]) b.trim.add(at(beam(0.34, 0.44, 0.02, TRIM.iron), sx * 1.06, -0.85, A.archZ[1] - 0.68));
  // the rear bumper, its slogan board and two lantern-style tail lamps
  b.trim.add(at(beam(2.4, 0.3, 0.22, TRIM.iron), 0, -0.42, -4.06));
  b.trim.add(at(beam(2.36, 0.2, 0.05, TRIM.wood), 0, -0.42, -4.185));
  b.trim.add(at(toSlot(new THREE.PlaneGeometry(0.42, 0.2), TRIM.w.sticker, true), 0.25, -0.42, -4.212, 0, PI, 0));
  for (const sx of [-1, 1]) {
    b.trim.add(at(rod(0.12, 0.31, TRIM.iron, { segs: 10 }), sx * 1.18, -0.42, -4.08));
    b.trim.add(at(rod(0.022, 0.16, TRIM.brass), sx * 1.0, -0.19, -4.09));
    b.trim.add(at(rod(0.088, 0.1, TRIM.brass, { segs: 12 }), sx * 1.0, -0.04, -4.09, PI / 2, 0, 0));
    b.trim.add(at(rod(0.04, 0.05, TRIM.brass, { r2: 0.01 }), sx * 1.0, 0.07, -4.09));
    b.lamps.add(at(toRegion(new THREE.CircleGeometry(0.074, 14), LAMPS.tail, 256), sx * 1.0, -0.04, -4.142, 0, PI, 0));
  }
  b.snow.add(at(rbox(2.5, 0.05, 0.2, 0.02, 2), 0, -0.25, -4.07));
}

// ---- the interior --------------------------------------------------------------------------------

function sconce(b, side, y, z) {
  const x = side * IN, dx = -side;
  b.trim.add(at(beam(0.02, 0.22, 0.1, TRIM.wood), x + dx * 0.01, y + 0.06, z));
  b.trim.add(at(beam(0.2, 0.025, 0.025, TRIM.iron), x + dx * 0.1, y + 0.15, z));
  b.trim.add(at(rod(0.004, 0.06, TRIM.iron), x + dx * 0.18, y + 0.12, z));
  b.trim.add(at(rod(0.075, 0.06, TRIM.iron, { r2: 0.02 }), x + dx * 0.18, y + 0.08, z));
  b.lamps.add(at(toRegion(new THREE.CylinderGeometry(0.052, 0.052, 0.13, 8, 1, true), LAMPS.lantern, 256), x + dx * 0.18, y - 0.015, z));
  b.trim.add(at(rod(0.065, 0.025, TRIM.brass), x + dx * 0.18, y - 0.09, z));
  for (let k = 0; k < 4; k++) { const a = k / 4 * TAU + PI / 4; b.trim.add(at(rod(0.006, 0.13, TRIM.iron, { segs: 4 }), x + dx * 0.18 + Math.cos(a) * 0.055, y - 0.015, z + Math.sin(a) * 0.055)); }
}
function curtains(b, side, o) {
  const x = side * (IN - 0.085), h = o.y1 - o.y0 + 0.24, cy = (o.y0 + o.y1) / 2 + 0.03;
  b.trim.add(at(rod(0.012, o.z1 - o.z0 + 0.4, TRIM.brass), x + side * 0.02, o.y1 + 0.16, (o.z0 + o.z1) / 2, PI / 2, 0, 0));
  for (const z of [o.z0 + 0.04, o.z1 - 0.04]) b.trim.add(at(cloth(0.22, h, 0.03, 3, TRIM.gingham), x, cy, z));
  b.trim.add(at(cloth(o.z1 - o.z0 + 0.32, 0.15, 0.03, 6, TRIM.gingham), x - side * 0.01, o.y1 + 0.08, (o.z0 + o.z1) / 2));
}

function buildInterior(b) {
  // floor and the braided rug
  b.floor.add(setUV(at(new THREE.PlaneGeometry(2.3, 7.8), 0, 0.002, 0, -PI / 2, 0, 0), (x, y, z) => [z / 1.4, x / 1.4]));
  b.soft.add(at(toRegion(new THREE.CircleGeometry(0.5, 36), SOFT.rug), -0.06, 0.006, -0.85, -PI / 2, 0, 0, [1.0, 1.6, 1]));

  // the shower stall: tiles inside, boards outside, oak edges, a slatted floor, a canvas curtain
  const sx0 = -1.2, sx1 = -0.4, scx = (sx0 + sx1) / 2, sw = sx1 - sx0;
  b.soft.add(toRegion(at(new THREE.PlaneGeometry(sw - 0.02, 2.2), scx, 1.1, -1.781, 0, PI, 0), SOFT.tile));
  b.soft.add(toRegion(at(new THREE.PlaneGeometry(sw - 0.02, 2.2), scx, 1.1, -2.719), SOFT.tile));
  {
    const s = new THREE.Shape(); s.moveTo(-2.72, 0); s.lineTo(-1.78, 0); s.lineTo(-1.78, 2.2); s.lineTo(-2.72, 2.2); s.closePath();
    s.holes.push(holeOf(A.winR.find(o => o.frost)));
    b.soft.add(toRegion(setUV(wallGeo(s, 'x', -IN + 0.004, 1), (x, y, z) => [(z + 2.72) / 0.94, y / 2.2]), SOFT.tile));
  }
  b.panel.add(setUV(at(new THREE.PlaneGeometry(sw, 2.2), scx, 1.1, -1.719), uvPanelX));
  b.panel.add(setUV(at(new THREE.PlaneGeometry(sw, 2.2), scx, 1.1, -2.781, 0, PI, 0), uvPanelX));
  for (const z of [-1.75, -2.75]) {
    b.trim.add(at(beam(0.07, 2.22, 0.08, TRIM.oak), sx1, 1.11, z));
    b.trim.add(at(beam(sw, 0.04, 0.08, TRIM.oak), scx, 2.22, z));
  }
  b.trim.add(at(beam(0.06, 0.18, 1.0, TRIM.oak), -0.4, 0.09, -2.25));
  for (const dz of [-0.33, -0.11, 0.11, 0.33]) b.trim.add(at(beam(0.72, 0.025, 0.17, TRIM.oak), scx, 0.013, -2.25 + dz));
  b.trim.add(at(rod(0.014, 0.96, TRIM.brass), -0.41, 2.0, -2.25, PI / 2, 0, 0));
  b.trim.add(at(cloth(0.34, 1.76, 0.035, 3, TRIM.canvas), -0.43, 1.11, -2.52));
  b.trim.add(at(rod(0.014, 0.24, TRIM.brass), -1.04, 1.96, -2.25, 0, 0, PI / 2));
  b.trim.add(at(rod(0.06, 0.04, TRIM.brass, { r2: 0.025, segs: 10 }), -0.92, 1.93, -2.25));
  b.trim.add(at(lathe([[0.001, 0], [0.12, 0], [0.13, 0.02], [0.14, 0.24], [0.125, 0.25], [0.12, 0.03]], TRIM.oak, 12, 2), -0.98, 0, -2.5));
  for (const y of [0.06, 0.2]) b.trim.add(at(ring(0.132 + y * 0.04, 0.009, TRIM.iron, 14), -0.98, y, -2.5, PI / 2, 0, 0));

  // the bunks: oak frames, quilts, pillows, a guard rail, drawers underneath
  b.trim.add(at(beam(2.36, 0.4, 0.94, TRIM.oak), 0, 0.2, -3.42));
  b.trim.add(at(beam(2.36, 0.12, 0.05, TRIM.wood), 0, 0.44, -2.955));
  for (const sx of [-1, 1]) {
    b.trim.add(at(beam(0.9, 0.24, 0.02, TRIM.wood), sx * 0.56, 0.19, -2.945));
    b.trim.add(at(toBand(new THREE.SphereGeometry(0.022, 8, 6), TRIM.brass), sx * 0.56, 0.2, -2.93));
  }
  b.soft.add(at(toRegion(rbox(2.28, 0.17, 0.88, 0.06, 3), SOFT.quilt), 0, 0.48, -3.43));
  b.trim.add(at(toBand(rbox(0.52, 0.13, 0.32, 0.06, 2), TRIM.canvas), -0.84, 0.61, -3.66, 0, 0.1, 0));
  b.trim.add(at(beam(2.36, 0.1, 0.96, TRIM.oak), 0, 1.45, -3.42));
  b.soft.add(at(toRegion(rbox(2.28, 0.15, 0.88, 0.06, 3), SOFT.quilt), 0, 1.57, -3.43, 0, PI, 0));
  b.trim.add(at(toBand(rbox(0.52, 0.12, 0.32, 0.06, 2), TRIM.canvas), 0.84, 1.69, -3.66, 0, -0.08, 0));
  b.trim.add(at(beam(1.6, 0.07, 0.05, TRIM.wood), 0.3, 1.82, -2.96));
  for (const x of [-0.46, 1.06]) b.trim.add(at(beam(0.05, 0.32, 0.05, TRIM.wood), x, 1.66, -2.96));
  for (const sx of [-1, 1]) b.trim.add(at(beam(0.08, 2.26, 0.08, TRIM.oak), sx * 1.105, 1.13, -2.95));

  // the dinette: oak table on a pedestal, plaid benches, supper on the table
  b.trim.add(at(beam(0.86, 0.07, 0.78, TRIM.oak), 0.78, 0.745, 1.15));
  b.trim.add(at(beam(0.9, 0.035, 0.82, TRIM.wood), 0.78, 0.695, 1.15));
  b.trim.add(at(rod(0.05, 0.68, TRIM.oak, { segs: 10 }), 0.78, 0.34, 1.15));
  b.trim.add(at(rod(0.2, 0.04, TRIM.iron, { segs: 14, r2: 0.12 }), 0.78, 0.02, 1.15));
  for (const z of [0.5, 1.8]) {
    const dir = z < 1.15 ? -1 : 1;
    b.trim.add(at(beam(0.84, 0.29, 0.4, TRIM.oak), 0.78, 0.145, z));
    b.soft.add(at(toRegion(rbox(0.84, 0.13, 0.42, 0.05, 3), SOFT.plaid), 0.78, 0.36, z));
    b.soft.add(at(toRegion(rbox(0.84, 0.5, 0.12, 0.05, 3), SOFT.plaid), 0.78, 0.7, z + dir * 0.15, dir * 0.08, 0, 0));
    b.trim.add(at(beam(0.88, 0.06, 0.15, TRIM.wood), 0.78, 0.98, z + dir * 0.175));
    b.trim.add(at(beam(0.05, 0.98, 0.44, TRIM.oak), 0.37, 0.49, z + dir * 0.02));
  }
  b.trim.add(at(rod(0.05, 0.02, TRIM.brass, { segs: 10 }), 0.98, 0.79, 1.36));
  b.lamps.add(at(toRegion(new THREE.CylinderGeometry(0.035, 0.035, 0.1, 8, 1, true), LAMPS.lantern, 256), 0.98, 0.85, 1.36));
  b.trim.add(at(rod(0.045, 0.025, TRIM.brass, { r2: 0.012, segs: 10 }), 0.98, 0.912, 1.36));
  b.trim.add(at(rod(0.045, 0.12, TRIM.oak, { segs: 10 }), 0.6, 0.84, 0.98));
  for (const y of [0.8, 0.88]) b.trim.add(at(ring(0.047, 0.006, TRIM.brass, 12), 0.6, y, 0.98, PI / 2, 0, 0));
  b.trim.add(at(ring(0.035, 0.009, TRIM.brass, 10, PI), 0.6 - 0.045, 0.84, 0.98, 0, PI / 2, PI / 2));
  b.trim.add(at(rod(0.11, 0.014, TRIM.brass, { segs: 14 }), 0.84, 0.787, 1.08));
  for (const [dx, dz] of [[0, 0], [0.05, 0.04], [-0.04, 0.05]]) b.trim.add(at(toSlot(new THREE.SphereGeometry(0.038, 10, 8), TRIM.s.apple), 0.84 + dx, 0.826, 1.08 + dz));
  for (const [i, a] of [[0, 0.2], [1, -0.5], [2, 0.9]]) b.trim.add(at(beam(0.09, 0.003, 0.13, TRIM.canvas), 0.66 + i * 0.03, 0.782 + i * 0.002, 1.32, 0, a, 0));

  // the galley: an oak cabinet, slate top, a cast-iron stove with a pot and a kettle, a basin,
  // a shelf of jars over the window and pans on a rail
  b.trim.add(at(beam(0.58, 0.84, 1.22, TRIM.oak), -0.9, 0.44, 1.95));
  b.trim.add(at(beam(0.64, 0.06, 1.28, TRIM.slate), -0.9, 0.89, 1.95));
  for (const z of [1.66, 2.24]) {
    b.trim.add(at(beam(0.025, 0.56, 0.52, TRIM.wood), -0.598, 0.38, z));
    b.trim.add(at(toBand(new THREE.SphereGeometry(0.022, 8, 6), TRIM.brass), -0.58, 0.5, z + (z < 2 ? 0.2 : -0.2)));
    b.trim.add(at(beam(0.025, 0.13, 0.52, TRIM.wood), -0.598, 0.77, z));
    b.trim.add(at(beam(0.02, 0.025, 0.12, TRIM.brass), -0.58, 0.77, z));
  }
  b.trim.add(at(beam(0.44, 0.05, 0.5, TRIM.iron), -0.92, 0.945, 2.25));
  for (const dz of [-0.12, 0.12]) b.trim.add(at(toSlot(new THREE.CircleGeometry(0.1, 16), TRIM.s.burner), -0.92, 0.972, 2.25 + dz, -PI / 2, 0, 0));
  b.trim.add(at(lathe([[0.001, 0], [0.1, 0], [0.11, 0.02], [0.115, 0.12], [0.12, 0.13], [0.001, 0.14]], TRIM.iron, 14), -0.92, 0.975, 2.13));
  b.trim.add(at(rod(0.015, 0.02, TRIM.iron), -0.92, 1.125, 2.13));
  b.trim.add(at(lathe([[0.001, 0], [0.08, 0], [0.1, 0.05], [0.09, 0.12], [0.05, 0.16], [0.02, 0.17], [0.001, 0.17]], TRIM.brass, 14), -0.92, 0.975, 2.37));
  b.trim.add(at(rod(0.014, 0.12, TRIM.brass, { r2: 0.008 }), -0.92, 1.06, 2.46, 0.9, 0, 0));
  b.trim.add(at(ring(0.06, 0.009, TRIM.wood, 12, PI), -0.92, 1.14, 2.37, 0, PI / 2, 0));
  b.trim.add(at(lathe([[0.001, 0.02], [0.08, 0.02], [0.13, 0.08], [0.14, 0.1], [0.125, 0.1], [0.07, 0.04]], TRIM.brass, 16), -0.92, 0.9, 1.62));
  b.trim.add(at(rod(0.015, 0.26, TRIM.iron), -1.1, 1.05, 1.62));
  b.trim.add(at(rod(0.012, 0.16, TRIM.iron), -1.03, 1.17, 1.62, 0, 0, PI / 2));
  b.trim.add(at(beam(0.22, 0.04, 1.1, TRIM.oak), -IN + 0.11, 2.0, 1.95));
  for (const z of [1.5, 2.4]) b.trim.add(at(beam(0.15, 0.1, 0.02, TRIM.iron), -IN + 0.075, 1.94, z));
  for (const [z, h] of [[1.6, 0.13], [1.75, 0.1], [1.88, 0.15]]) {
    b.trim.add(at(lathe([[0.001, 0], [0.05, 0], [0.055, 0.02], [0.05, h - 0.03], [0.03, h - 0.01], [0.03, h]], TRIM.glass, 10), -1.04, 2.02, z));
    b.trim.add(at(rod(0.034, 0.025, TRIM.wood), -1.04, 2.02 + h + 0.01, z));
  }
  b.trim.add(at(toBand(rbox(0.2, 0.17, 0.16, 0.07, 2), TRIM.canvas), -1.04, 2.1, 2.3));
  b.trim.add(at(rod(0.012, 1.0, TRIM.brass), -1.11, 1.24, 1.95, PI / 2, 0, 0));
  b.trim.add(at(rod(0.1, 0.025, TRIM.iron, { segs: 14 }), -1.11, 1.02, 1.68, 0, 0, PI / 2));
  b.trim.add(at(beam(0.02, 0.15, 0.025, TRIM.wood), -1.11, 1.17, 1.68));
  b.trim.add(at(rod(0.008, 0.2, TRIM.iron), -1.11, 1.13, 2.18));
  b.trim.add(at(lathe([[0.001, -0.04], [0.035, -0.035], [0.045, 0], [0.04, 0.005]], TRIM.iron, 10), -1.11, 1.02, 2.18));

  // the icebox: an oak chest with brass bands, a frosted iron front, a basket of apples on top
  b.trim.add(at(beam(0.42, 0.7, 0.8, TRIM.oak), 0.94, 0.35, -1.0));
  b.trim.add(at(beam(0.46, 0.05, 0.84, TRIM.wood), 0.94, 0.725, -1.0));
  b.trim.add(at(beam(0.012, 0.4, 0.56, TRIM.iron), 0.725, 0.38, -1.0));
  for (const z of [-1.39, -0.61]) b.trim.add(at(beam(0.44, 0.71, 0.03, TRIM.brass), 0.94, 0.36, z));
  b.trim.add(at(beam(0.03, 0.08, 0.1, TRIM.brass), 0.715, 0.52, -1.0));
  b.trim.add(at(lathe([[0.001, 0], [0.12, 0], [0.16, 0.1], [0.165, 0.11], [0.15, 0.11], [0.11, 0.02]], TRIM.rope, 14, 3), 0.94, 0.75, -1.1));
  for (const [dx, dz] of [[0, 0], [0.06, 0.05], [-0.05, 0.06], [0.03, -0.06]]) b.trim.add(at(toSlot(new THREE.SphereGeometry(0.045, 10, 8), TRIM.s.apple), 0.94 + dx, 0.84 + (dx === 0 ? 0.03 : 0), -1.1 + dz));

  // lanterns on the walls, curtains on the windows
  sconce(b, 1, 1.6, -0.05);
  sconce(b, -1, 1.66, 1.09);
  sconce(b, 1, 1.86, -2.45);
  curtains(b, 1, A.winL[1]);
  curtains(b, 1, A.winL[2]);
  curtains(b, -1, A.winR[1]);
}

function buildCockpit(b) {
  // the dash: an oak cabinet with a walnut top, a gauge board for the driver, a radio, a glove box
  b.trim.add(at(beam(2.3, 0.5, 0.56, TRIM.oak), 0, 0.6, 3.62));
  b.trim.add(at(beam(2.36, 0.07, 0.62, TRIM.wood), 0, 0.885, 3.6));
  b.trim.add(at(beam(0.5, 0.36, 0.5, TRIM.oak), 0, 0.18, 3.62));
  b.trim.add(at(beam(0.52, 0.26, 0.02, TRIM.wood), -0.62, 0.6, 3.335));
  b.trim.add(at(toSlot(new THREE.PlaneGeometry(0.3, 0.15), TRIM.w.plaque, true), -0.62, 0.62, 3.322, 0, PI, 0));
  b.trim.add(at(toBand(new THREE.SphereGeometry(0.02, 8, 6), TRIM.brass), -0.62, 0.5, 3.32));
  const tilt = 0.55, n = new V3(0, Math.sin(tilt), -Math.cos(tilt));
  b.trim.add(at(beam(0.74, 0.3, 0.05, TRIM.wood), 0.62, 1.05, 3.53, tilt, 0, 0));
  b.trim.add(at(beam(0.78, 0.04, 0.12, TRIM.brass), 0.62, 1.2, 3.6));
  b.trim.add(at(beam(0.74, 0.16, 0.2, TRIM.wood), 0.62, 0.95, 3.6));
  for (const [dx, slot] of [[-0.26, TRIM.s.gauge], [0.26, TRIM.s.fuel]]) {
    const p = new V3(0.62 + dx, 1.07, 3.53).addScaledVector(n, 0.03);
    b.trim.add(at(toSlot(new THREE.CircleGeometry(0.068, 18), slot), p.x, p.y, p.z, tilt, PI, 0));
  }
  b.trim.add(at(beam(0.3, 0.12, 0.22, TRIM.wood), 0, 0.98, 3.46));
  b.trim.add(at(toSlot(new THREE.PlaneGeometry(0.26, 0.11), TRIM.w.radio, true), 0, 0.98, 3.348, 0, PI, 0));
  b.trim.add(at(beam(0.035, 0.07, 0.03, TRIM.iron), 0.17, 0.95, 3.42));
  // the steering column (the wheel itself turns: see RVView)
  const ax = new V3(0, -Math.sin(0.9), Math.cos(0.9));
  b.trim.add(at(rod(0.03, 0.4, TRIM.iron), 0.62, 0.95 + ax.y * 0.2, 3.22 + ax.z * 0.2, Math.atan2(ax.z, ax.y), 0, 0));
  // seats: oak pedestals, plaid tufted cushions and high backs, oak arms
  for (const sx of [-1, 1]) {
    const x = sx * 0.62;
    b.trim.add(at(beam(0.5, 0.27, 0.5, TRIM.oak), x, 0.135, 2.86));
    b.soft.add(at(toRegion(rbox(0.62, 0.18, 0.6, 0.06, 2), SOFT.plaid), x, 0.36, 2.86));
    b.soft.add(at(toRegion(rbox(0.62, 0.84, 0.17, 0.07, 2), SOFT.plaid), x, 0.86, 2.58, -0.12, 0, 0));
    for (const ax2 of [-1, 1]) {
      b.trim.add(at(beam(0.07, 0.07, 0.48, TRIM.oak), x + ax2 * 0.34, 0.6, 2.84));
      b.trim.add(at(beam(0.05, 0.22, 0.05, TRIM.oak), x + ax2 * 0.34, 0.47, 3.02));
    }
  }
}

// ---- the roof (a Repo Man part) ------------------------------------------------------------------

function buildRoof(b) {
  const p = new THREE.Shape();
  p.moveTo(-1.29, 2.31); p.lineTo(1.29, 2.31); p.lineTo(1.29, ROOF_TOP - 0.06);
  p.quadraticCurveTo(1.29, ROOF_TOP, 1.23, ROOF_TOP); p.lineTo(-1.23, ROOF_TOP);
  p.quadraticCurveTo(-1.29, ROOF_TOP, -1.29, ROOF_TOP - 0.06); p.closePath();
  const cap = new THREE.ExtrudeGeometry(p, { depth: 8.08, bevelEnabled: false, curveSegments: 4 });
  cap.translate(0, 0, -4.04);
  b.body.add(setUV(toCreasedNormals(cap, 0.7), uvRoof));
  // ceiling boards across the width, heavy beams
  b.ceil.add(setUV(at(new THREE.PlaneGeometry(2.3, 7.8), 0, 2.298, 0, PI / 2, 0, 0), (x, y, z) => [z / 1.6, 0.45 + (x + 1.15) / 2.3 * 0.48]));
  // a heavy eave all round
  for (const sx of [-1, 1]) b.trim.add(at(beam(0.07, 0.11, 8.1, TRIM.wood), sx * 1.31, 2.33, -0.02));
  b.trim.add(at(beam(2.69, 0.11, 0.07, TRIM.wood), 0, 2.33, -4.06));
  for (const sx of [-1, 1]) for (const z of [-3.0, -1.0, 1.0, 3.0]) b.trim.add(at(beam(0.09, 0.12, 0.07, TRIM.wood), sx * 1.29, 2.22, z));
  for (const z of [-3.36, -2.22, -1.12, 0.02, 1.1, 2.24, 3.32]) b.trim.add(at(beam(2.3, 0.1, 0.13, TRIM.wood), 0, 2.245, z));
  // on top: a vent hatch, a stovepipe, a goblin cooling contraption, a rack with a barrel, a
  // crate and a bedroll
  b.trim.add(at(beam(0.66, 0.04, 0.66, TRIM.iron), 0, ROOF_TOP + 0.02, 0.62));
  b.trim.add(at(beam(0.6, 0.09, 0.6, TRIM.oak), 0, ROOF_TOP + 0.08, 0.62));
  for (const dz of [-0.2, 0.2]) b.trim.add(at(beam(0.62, 0.012, 0.06, TRIM.iron), 0, ROOF_TOP + 0.13, 0.62 + dz));
  b.trim.add(at(rod(0.065, 0.62, TRIM.iron, { segs: 10 }), 0.78, ROOF_TOP + 0.31, -2.05));
  b.trim.add(at(rod(0.09, 0.05, TRIM.brass, { segs: 10 }), 0.78, ROOF_TOP + 0.03, -2.05));
  b.trim.add(at(toBand(new THREE.ConeGeometry(0.14, 0.1, 10), TRIM.iron), 0.78, ROOF_TOP + 0.68, -2.05));
  b.trim.add(at(beam(0.8, 0.26, 0.8, TRIM.cream), -0.25, ROOF_TOP + 0.13, -1.0));
  b.trim.add(at(toSlot(new THREE.CircleGeometry(0.28, 18), TRIM.s.burner), -0.25, ROOF_TOP + 0.262, -1.0, -PI / 2, 0, 0));
  b.trim.add(at(ring(0.29, 0.025, TRIM.brass, 22), -0.25, ROOF_TOP + 0.262, -1.0, PI / 2, 0, 0));
  b.trim.add(at(rod(0.03, 0.6, TRIM.brass), 0.2, ROOF_TOP + 0.08, -1.0, PI / 2, 0, 0));
  for (const sx of [-1, 1]) {
    b.trim.add(at(rod(0.02, 1.3, TRIM.iron, { segs: 6 }), sx * 1.0, ROOF_TOP + 0.2, 3.15, PI / 2, 0, 0));
    for (const z of [2.5, 3.8]) b.trim.add(at(rod(0.02, 0.2, TRIM.iron, { segs: 6 }), sx * 1.0, ROOF_TOP + 0.1, z));
  }
  for (const z of [2.5, 3.8]) b.trim.add(at(rod(0.02, 2.0, TRIM.iron, { segs: 6 }), 0, ROOF_TOP + 0.2, z, 0, 0, PI / 2));
  b.trim.add(at(lathe([[0.001, 0], [0.19, 0], [0.22, 0.1], [0.235, 0.25], [0.22, 0.4], [0.19, 0.5], [0.001, 0.5]], TRIM.oak, 14, 2), 0.55, ROOF_TOP, 3.2));
  for (const y of [0.08, 0.42]) b.trim.add(at(ring(0.205 + (y > 0.2 ? 0 : 0.008), 0.012, TRIM.iron, 16), 0.55, ROOF_TOP + y, 3.2, PI / 2, 0, 0));
  b.trim.add(at(beam(0.5, 0.38, 0.5, TRIM.oak), -0.4, ROOF_TOP + 0.19, 2.95, 0, 0.15, 0));
  b.trim.add(at(beam(0.52, 0.04, 0.52, TRIM.iron), -0.4, ROOF_TOP + 0.36, 2.95, 0, 0.15, 0));
  b.trim.add(at(rod(0.13, 0.9, TRIM.canvas, { segs: 10 }), -0.25, ROOF_TOP + 0.13, 3.62, 0, 0, PI / 2));
  for (const dx of [-0.25, 0.25]) b.trim.add(at(ring(0.135, 0.014, TRIM.rope, 12, TAU, 2), -0.25 + dx, ROOF_TOP + 0.13, 3.62, 0, PI / 2, 0));
  // snow (day 3): a lumpy blanket on the roof and caps on the cargo
  // a thick, lumpy blanket that overhangs the eaves (Dun Morogh roofs are heavy with it)
  const sn = rbox(2.76, 0.13, 8.22, 0.065, 8);
  const sp = sn.attributes.position;
  for (let k = 0; k < sp.count; k++) {
    const x = sp.getX(k), y = sp.getY(k), z = sp.getZ(k);
    if (y > 0.02) sp.setY(k, y + 0.03 * Math.sin(z * 2.3 + 1) * Math.cos(x * 3.1) + 0.012 * Math.sin(z * 7.1));
    else if (Math.abs(x) > 1.3) sp.setY(k, y - 0.035 * (0.5 + 0.5 * Math.sin(z * 5.3)));
  }

  b.snow.add(at(sn, 0, ROOF_TOP + 0.05, -0.02));
  b.snow.add(at(rbox(0.52, 0.06, 0.52, 0.025, 2), -0.4, ROOF_TOP + 0.4, 2.95, 0, 0.15, 0));
  b.snow.add(at(rbox(0.36, 0.05, 0.36, 0.025, 2), 0.55, ROOF_TOP + 0.52, 3.2));
  b.snow.add(at(rbox(0.82, 0.05, 0.82, 0.025, 2), -0.25, ROOF_TOP + 0.28, -1.0));
  b.snow.add(at(rbox(0.62, 0.05, 0.62, 0.025, 2), 0, ROOF_TOP + 0.15, 0.62));
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
  for (const f of [1, -1]) b.trim.add(at(toBand(new THREE.PlaneGeometry(rw.x * 2, rw.y1 - rw.y0), TRIM.glass), 0, (rw.y0 + rw.y1) / 2, -HL + 0.05 + f * 0.01, 0, f > 0 ? 0 : PI, 0));
  b.trim.add(at(beam(2.5, 0.06, 0.14, TRIM.wood), 0, 2.29, -3.95));
  // the ladder
  for (const x of [0.62, 1.0]) {
    b.trim.add(at(rod(0.024, 2.9, TRIM.iron, { segs: 6 }), x, 1.18, -4.13));
    for (const y of [0.3, 1.3, 2.2]) b.trim.add(at(beam(0.03, 0.03, 0.14, TRIM.iron), x, y, -4.06));
  }
  for (let y = 0.0; y < 2.5; y += 0.3) b.trim.add(at(rod(0.017, 0.4, TRIM.iron, { segs: 6 }), 0.81, y, -4.13, 0, 0, PI / 2));
  // the spare on its bracket, the brass plate
  b.trim.add(at(wheel.clone(), -0.4, 0.98, -4.19, 0, PI / 2, 0, 0.86));
  b.trim.add(at(beam(0.12, 0.12, 0.14, TRIM.iron), -0.4, 0.98, -4.06));
  b.trim.add(at(toSlot(new THREE.PlaneGeometry(0.48, 0.24), TRIM.w.plate, true), 0.1, 0.2, -HL - 0.012, 0, PI, 0));
}

// ---- the door (a Repo Man part; hinged at its rear edge) -----------------------------------------

function buildDoor(b) {
  const dz0 = D.DOOR_Z - D.DOOR_HALF, L = D.DOOR_HALF * 2;
  const s = new THREE.Shape(); s.moveTo(0.02, 0.02); s.lineTo(L - 0.02, 0.02); s.lineTo(L - 0.02, 2.0); s.lineTo(0.02, 2.0); s.closePath();
  b.body.add(setUV(wallGeo(s, 'x', -0.03, -1), (x, y, z) => uvSideR(x, y, z + dz0)));
  b.panel.add(setUV(wallGeo(s, 'x', 0.03, 1), uvPanelZ));
  // a framed plank door: border boards, strap hinges, a brass porthole, ring pulls
  for (const z of [0.045, L - 0.045]) b.trim.add(at(beam(0.075, 1.98, 0.05, TRIM.wood), 0, 1.01, z));
  for (const y of [0.045, 1.975]) b.trim.add(at(beam(0.075, 0.05, L - 0.04, TRIM.wood), 0, y, L / 2));
  b.trim.add(at(beam(0.07, 0.05, L - 0.1, TRIM.wood), 0, 0.95, L / 2));
  for (const f of [-1, 1]) {
    b.trim.add(at(ring(0.165, 0.03, TRIM.brass, 20), f * 0.04, 1.45, L / 2, 0, PI / 2, 0));
    b.trim.add(at(toBand(new THREE.CircleGeometry(0.15, 18), TRIM.glass), f * 0.034, 1.45, L / 2, 0, f * PI / 2, 0));
    b.trim.add(at(beam(0.012, 0.16, 0.08, TRIM.iron), f * 0.042, 1.02, L - 0.14));
    b.trim.add(at(ring(0.045, 0.01, TRIM.brass, 12), f * 0.055, 0.99, L - 0.14, 0, PI / 2, 0));
  }
  for (const y of [0.4, 1.62]) {
    b.trim.add(at(beam(0.012, 0.07, 0.46, TRIM.iron), -0.042, y, 0.25));
    b.trim.add(at(rod(0.04, 0.012, TRIM.iron, { segs: 10 }), -0.042, y, 0.48, 0, 0, PI / 2));
    for (const z of [0.1, 0.25, 0.4]) b.trim.add(at(rod(0.012, 0.012, TRIM.brass, { segs: 6 }), -0.05, y, z, 0, 0, PI / 2));
  }
}

// ---- wheels, hook, strap -------------------------------------------------------------------------

// A fat tire with painted tread on a red-spoked hub, axle along X.
function wheelGeo() {
  const prof = [[0.29, -0.17], [0.36, -0.2], [0.44, -0.205], [0.484, -0.18], [0.502, -0.12], [0.506, 0], [0.502, 0.12], [0.484, 0.18], [0.44, 0.205], [0.36, 0.2], [0.29, 0.17]];
  const parts = [
    lathe(prof, TRIM.tread, 20, 2),
    at(toSlot(new THREE.CircleGeometry(0.3, 18), TRIM.s.hub), 0, 0.172, 0, -PI / 2, 0, 0),
    at(toSlot(new THREE.CircleGeometry(0.3, 18), TRIM.s.hub), 0, -0.172, 0, PI / 2, 0, 0),
    rod(0.075, 0.44, TRIM.brass, { segs: 10 }),
    rod(0.04, 0.5, TRIM.iron, { segs: 8 }),
  ].map(prep);
  const g = mergeGeometries(parts);
  g.rotateZ(PI / 2);
  return g;
}
function hookGeo() {
  const parts = [
    at(ring(0.12, 0.042, TRIM.red, 16, PI * 1.45), 0, -0.44, 0, 0, 0, PI / 2),
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

// ---- the view ------------------------------------------------------------------------------------

export class RVView {
  constructor(scene) {
    this.g = new THREE.Group();
    scene.add(this.g);
    const g = this.g;
    this.parts = { doors: [], roof: [] };
    this.biome = null;

    const mat = {
      body: painted('rv_body'),
      trim: painted('rv_trim'),
      panel: painted('rv_paneling'),
      floor: painted('rv_floor'),
      soft: painted('rv_soft'),
      glass: painted('rv_glass', { transparent: true, side: THREE.DoubleSide }),
      snow: painted('rv_snow', { repeat: [3, 3] }),
      lamps: new THREE.MeshLambertMaterial({ map: tex('rv_lamps'), emissiveMap: tex('rv_lamps'), emissive: 0x000000 }),
      glow: new THREE.MeshBasicMaterial({ color: '#ffb25a', transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }),   // faces out: lit windows seen from outside only
      ceil: painted('rv_paneling', { tint: '#f0dcc0', emissive: '#5a3a1e', emissiveIntensity: 0.5 }),
      grime: new THREE.MeshLambertMaterial({ map: tex('rv_grime'), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
    };
    mat.glass.depthWrite = false;
    this.mat = mat;
    const cast = { body: true, trim: true, snow: true };
    this.snowMeshes = []; this.glowMeshes = [];
    const emit = (parent, bk) => {
      for (const k of KINDS) {
        const m = bk[k].mesh(mat[k], !!cast[k]);
        if (!m) continue;
        if (k === 'snow') { m.visible = false; this.snowMeshes.push(m); }
        if (k === 'glow') { m.visible = false; this.glowMeshes.push(m); }
        if (k === 'glass' || k === 'grime' || k === 'glow') m.renderOrder = 2;
        parent.add(m);
      }
    };

    const wheel = wheelGeo();
    const main = buckets();
    buildShell(main); buildFront(main); buildWinch(main); buildStack(main); buildUnder(main); buildInterior(main); buildCockpit(main);
    // road grime over the lower body (tinted per biome)
    const gr = sideOutline(1.02, true);
    main.grime.add(setUV(wallGeo(gr, 'x', -HW - 0.004, -1), (x, y, z) => [z / 2.2, (y - A.y0) / (1.02 - A.y0)]));
    main.grime.add(setUV(wallGeo(sideOutline(1.02), 'x', HW + 0.004, 1), (x, y, z) => [-z / 2.2, (y - A.y0) / (1.02 - A.y0)]));
    const gf = new THREE.Shape(); gf.moveTo(-HW, A.y0); gf.lineTo(HW, A.y0); gf.lineTo(HW, 1.02); gf.lineTo(-HW, 1.02); gf.closePath();
    main.grime.add(setUV(wallGeo(gf, 'z', HL + 0.004, 1), (x, y) => [x / 2.2, (y - A.y0) / (1.02 - A.y0)]));
    emit(g, main);

    const roof = new THREE.Group(), rb = buckets();
    buildRoof(rb); emit(roof, rb);
    g.add(roof); this.parts.roof.push(roof);

    const rear = new THREE.Group(), qb = buckets();
    buildRear(qb, wheel);
    const rg = new THREE.Shape(); rg.moveTo(-HW, A.y0); rg.lineTo(HW, A.y0); rg.lineTo(HW, 1.02); rg.lineTo(-HW, 1.02); rg.closePath();
    qb.grime.add(setUV(wallGeo(rg, 'z', -HL - 0.004, -1), (x, y) => [-x / 2.2, (y - A.y0) / (1.02 - A.y0)]));
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
      const parts = [ring(0.18, 0.03, TRIM.oak, 24, TAU, 3), rod(0.045, 0.06, TRIM.brass, { segs: 10 })].map(prep);
      parts[1].rotateX(PI / 2);
      for (const a of [0, PI, -PI / 2]) parts.push(prep(at(rod(0.014, 0.16, TRIM.brass, { segs: 6 }), Math.cos(a) * 0.085, Math.sin(a) * 0.085, 0, 0, 0, a - PI / 2)));
      parts.push(prep(at(rod(0.016, 0.05, TRIM.brass, { segs: 6 }), -0.127, -0.127, -0.03, PI / 2, 0, 0)));
      const sw = new THREE.Mesh(mergeGeometries(parts), mat.trim);
      sw.position.set(0.62, 0.95, 3.22); sw.rotation.x = 0.9;
      sw.castShadow = true;
      g.add(sw);
      this.steeringWheel = sw;
    }
    // the odometer and clock, in a brass bezel on the gauge board
    this.odoCv = document.createElement('canvas'); this.odoCv.width = 256; this.odoCv.height = 96;
    this.odoTex = canvasTex(this.odoCv);
    {
      const tilt = 0.55, n = new V3(0, Math.sin(tilt), -Math.cos(tilt));
      const odo = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.1275), new THREE.MeshBasicMaterial({ map: this.odoTex }));
      odo.position.set(0.62, 1.08, 3.53).addScaledVector(n, 0.03);
      odo.rotation.set(tilt, PI, 0);
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
  }

  setParts(parts) {
    for (const p of this.parts.doors) p.visible = parts.doors !== false;
    for (const p of this.parts.roof) p.visible = parts.roof !== false;
  }

  setBiome(b) {
    this.biome = b;
    const [tint, op] = GRIME[b] || GRIME.meadow;
    this.mat.grime.color.set(tint);
    this.mat.grime.opacity = op;
    for (const m of this.snowMeshes) m.visible = b === 'snow';
  }

  updateWheels(rv) {
    const d = this._dummy;
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const susp = rv?.wheels?.[i * 2] ?? SUSP_REST;
      const rot = rv?.wheels?.[i * 2 + 1] ?? 0;
      d.position.set(w.x, w.y - susp, w.z);
      d.rotation.set(rot, w.steer ? (rv?.steer ?? 0) : 0, 0);
      d.updateMatrix();
      this.wheelMesh.setMatrixAt(i, d.matrix);
    }
    this.wheelMesh.instanceMatrix.needsUpdate = true;
  }

  drawOdo(odo, clockStr) {
    const g = this.odoCv.getContext('2d'), W = 256, H = 96;
    const gr = (y0, y1, stops) => { const l = g.createLinearGradient(0, y0, 0, y1); for (const [t, c] of stops) l.addColorStop(t, c); return l; };
    g.fillStyle = gr(0, H, [[0, '#f2d68a'], [0.5, '#b8873a'], [1, '#5a3c18']]); g.fillRect(0, 0, W, H);
    g.fillStyle = '#2a1a12'; g.beginPath(); g.roundRect(6, 6, W - 12, H - 12, 8); g.fill();
    // drum counter: cream cells, dark digits
    const digits = String(Math.max(0, Math.round(odo))).padStart(4, '0').slice(-5);
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'bold 15px Georgia, serif'; g.fillStyle = '#e8c070'; g.fillText('ODO', 30, 30);
    const cw = 30, x0 = 54;
    for (let i = 0; i < digits.length; i++) {
      const x = x0 + i * (cw + 4);
      g.fillStyle = gr(12, 48, [[0, '#b8a888'], [0.25, '#f6ecd2'], [0.75, '#f6ecd2'], [1, '#a89878']]);
      g.fillRect(x, 12, cw, 36);
      g.fillStyle = '#1e140e'; g.font = 'bold 30px monospace'; g.fillText(digits[i], x + cw / 2, 31);
    }
    g.fillStyle = '#e8c070'; g.font = 'bold 20px Georgia, serif'; g.fillText('m', x0 + digits.length * (cw + 4) + 10, 32);
    // the clock in a warm amber window
    g.fillStyle = gr(54, 88, [[0, '#ffd27a'], [1, '#e8a040']]); g.beginPath(); g.roundRect(30, 54, W - 60, 32, 6); g.fill();
    g.fillStyle = '#2a1408'; g.font = 'bold 26px monospace'; g.fillText(clockStr || '', W / 2, 71);
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
