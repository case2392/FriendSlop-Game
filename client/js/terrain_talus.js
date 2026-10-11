// The talus round the crash mesas' buttes (part of the terrain art pass).
//
// A butte (terrain_butte.js: rock on world gen's masses, the main tier's body and lobes and the bench)
// stands on a walkable talus mound in the heightfield. What has fallen off it lies on the mound and against
// the foot (round the outline, lobes and all), never on the walkable tops, inside the other tier, on the
// road or in its ditch, and all of it but the rubble is solid: world gen (shared/world.js) lays and shapes
// every block (W.talus) and the physics takes its points as one convex hull (W.hulls), so here each is
// drawn from exactly those points and you stand on what you see:
//   - SHOULDERS: one or two big blocks lodged against the wall's foot on the sides seen in profile from
//     the road (their tops at most ~1.4 m above the ground: nothing a climber would hang on);
//   - HEAPS: two or three piles of big blocks against the foot, away from the road;
//   - CAP SLABS: under each place where a piece of the caprock broke away (world gen's notches, which
//     terrain_butte draws), two or three thick slabs of the cap bed (its own tint) lying tipped on the mound;
//   - TALUS: fallen blocks half buried round the foot, denser and bigger near the wall (fewer, smaller
//     ones on the road side);
//   - RUBBLE: a scatter of small pieces in loose clusters between them, this file's own (render only:
//     under 0.1 m, too small to trip on).
// The blocks are the butte's own rock: Elwynn's rounded gray granite boulders, Westfall's, the Badlands'
// and Tanaris' tabular slabs of the bedded rock tipped every way, Dun Morogh's cut granite slabs with a
// soft snow cap hanging over their edge (the cap is part of the slab's collider: you stand on the snow).
// Everything goes into terrain_butte.js's mesh (one draw call), in its material (triplanar on a block).
//
//   talusInto(acc, W, S, forms)   (acc: terrain_butte's accumulator; S: its biome style; forms: butteForms(W))
import { THREE } from './gfx.js';
import { mergeVertices, toCreasedNormals } from '/vendor/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const sstep = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const angDiff = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
function rng32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// One angular block, unit-ish size, in its own frame (y up): lumpy, then cut by a flattened top and
// `cuts` random fracture planes. -> indexed geometry, smooth normals
function blockGeo(r, cuts = 5, detail = 1, lump = 0.22) {
  let g = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal'); g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = g.attributes.position, v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) { v.fromBufferAttribute(P, i); v.multiplyScalar(1 - lump / 2 + r() * lump); P.setXYZ(i, v.x, v.y, v.z); }
  const planes = [[new THREE.Vector3((r() - 0.5) * 0.25, 1, (r() - 0.5) * 0.25).normalize(), 0.5 + r() * 0.15]];     // the flat top
  for (let k = 0; k < cuts; k++) {
    const a = r() * TAU, e = (r() - 0.35) * 1.1;
    planes.push([new THREE.Vector3(Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e)), 0.55 + r() * 0.3]);
  }
  for (const [pn, d] of planes) for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    const t = v.dot(pn);
    if (t > d) { v.addScaledVector(pn, d - t); P.setXYZ(i, v.x, v.y, v.z); }
  }
  g.computeVertexNormals();
  return g;
}

// Put a block's geometry (its own frame) into the accumulator at m4: per vertex its height above the
// ground (the shader buries its foot), a little darker low down; cap: a slab of the caprock bed; snow:
// a snow cap (covered all over).
const _v = new THREE.Vector3(), _n = new THREE.Vector3(), _m3 = new THREE.Matrix3();
function put(acc, W, S, geo, m4, { cap = 0, snow = false, gnd = null } = {}) {
  const P = geo.attributes.position, N = geo.attributes.normal, I = geo.index;
  _m3.getNormalMatrix(m4);
  const v0 = acc.n;
  for (let i = 0; i < P.count; i++) {
    _v.fromBufferAttribute(P, i).applyMatrix4(m4);
    _n.fromBufferAttribute(N, i).applyMatrix3(_m3).normalize();
    const sink = _v.y - (gnd ? gnd(_v.x, _v.z) : W.heightAt(_v.x, _v.z)), ao = 0.78 + 0.22 * sstep(-0.15, 0.6, sink);
    acc.vf(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, S.ao[0] + (1 - S.ao[0]) * ao, S.ao[1] + (1 - S.ao[1]) * ao, S.ao[2] + (1 - S.ao[2]) * ao, 0, 0, 1, sink, snow ? -1 : 99, cap);
  }
  if (I) for (let i = 0; i < I.count; i++) acc.I.push(v0 + I.getX(i));
  else for (let i = 0; i < P.count; i++) acc.I.push(v0 + i);
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _I4 = new THREE.Matrix4();
// a block's mesh from world gen's points (about its centre x, y, z) and faces
function blockMesh(P, I, x, y, z) {
  const pos = new Float32Array(P.length);
  for (let i = 0; i < pos.length; i += 3) { pos[i] = P[i] + x; pos[i + 1] = P[i + 1] + y; pos[i + 2] = P[i + 2] + z; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(Array.from(I));
  return g;
}
export function talusInto(acc, W, S, forms) {
  const pebble = (r, x, z, k) => {
    const g = blockGeo(r, 3, 0, 0.3);
    _e.set((r() - 0.5) * 0.8, r() * TAU, (r() - 0.5) * 0.8); _q.setFromEuler(_e);
    _m.compose(_p.set(x, gnd(x, z) - k * 0.2, z), _q, _s.set(k * (0.9 + r() * 0.5), k * (0.5 + r() * 0.3), k * (0.8 + r() * 0.4)));
    put(acc, W, S, toCreasedNormals(g, 0.9), _m, { gnd });
  };
  const roadClear = (x, z, pad) => Math.abs(x - W.roadX(z)) > 6.7 + pad;
  let gnd = (x, z) => W.heightAt(x, z), inOther = () => -1;
  for (const F of forms) {
    const r = rng32((Math.round(F.p.z * 977) ^ 0x2545F491) >>> 0);
    // (the ground here: the mound, and the fillet of sand, snow or scree in the corner at the butte's foot)
    gnd = F.bank ? (x, z) => W.heightAt(x, z) + F.bank(x, z) : (x, z) => W.heightAt(x, z);
    const bodies = [F.main, F.bench].filter(Boolean);
    // (how far inside the tier other than B a point stands: the main tier's outline is its body and lobes)
    inOther = (B, x, z) => { const Q = B === F.main ? F.bench : F.main; return Q ? (Q.Rf || Q.Rb)(Math.atan2(z - Q.cz, x - Q.cx)) - Math.hypot(x - Q.cx, z - Q.cz) : -1; };
    // where a body's foot shows (the main body's lies inside the bench round the bench)
    const footOf = (B, a) => {
      if (B.arc && angDiff(a, (B.arc[0] + B.arc[1]) / 2) > (B.arc[1] - B.arc[0]) / 2 - 0.35) return null;
      if (B.shortY && B.shortY(a) != null) return null;
      return (B.Ry ? B.Ry(a, B.gm + 1) : B.Rb(a)) + B.wall(a, B.gm + 1) + B.flare(a) * 0.55;
    };
    const at = (B, a, d) => [B.cx + Math.cos(a) * d, B.cz + Math.sin(a) * d];
    // the fallen blocks, as world gen laid and shaped them (their points are the physics' hulls): Elwynn's
    // rounded granite, the tabular blocks' fractured faces (creased normals), a snow slab's flat faces and
    // its soft cap
    for (const b of W.talus || []) {
      if (b.poi !== F.p.id) continue;
      const g = blockMesh(b.P, b.I, b.x, b.y, b.z);
      if (b.kind === 'slab') {
        const fl = g.toNonIndexed(); fl.computeVertexNormals();
        put(acc, W, S, fl, _I4, { cap: b.cap, gnd });
        const cg = blockMesh(b.C.P, b.C.I, b.x, b.y, b.z); cg.computeVertexNormals();
        put(acc, W, S, cg, _I4, { snow: true, gnd });
      } else {
        g.computeVertexNormals();
        put(acc, W, S, toCreasedNormals(g, b.kind === 'round' ? 1.05 : 0.75), _I4, { cap: b.cap, gnd });
      }
    }
    // rubble: a scatter of small pieces in loose clusters between them
    const nR = 26 + Math.floor(r() * 12);
    for (let k = 0; k < nR; k++) {
      const B = bodies[r() < 0.75 || !F.bench ? 0 : 1];
      const a = B.arc ? B.arc[0] + r() * (B.arc[1] - B.arc[0]) : r() * TAU;
      const d0 = footOf(B, a);
      if (d0 == null) continue;
      const cl = 1 + Math.floor(r() * 3), d = d0 + Math.pow(r(), 1.3) * 4.4;
      for (let j = 0; j < cl; j++) {
        const [x0, z0] = at(B, a, d), x = x0 + (r() - 0.5) * 0.9, z = z0 + (r() - 0.5) * 0.9, kk = 0.1 + r() * 0.2;
        if (!roadClear(x, z, kk) || inOther(B, x, z) > 0) continue;
        pebble(r, x, z, kk);
      }
    }
  }
}
