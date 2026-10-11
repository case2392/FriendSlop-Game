// The talus round the crash mesas' buttes (part of the terrain art pass; render only, no colliders).
//
// A butte (terrain_butte.js: rock on world gen's cylinders, the main tier's body and lobes and the bench)
// stands on a walkable talus mound in the heightfield. Here the mound gets what has fallen off the butte,
// all of it on the mound and against the foot (round the outline, lobes and all), never on the walkable
// tops, inside the other tier, on the road or in its ditch:
//   - SHOULDERS: one or two big blocks lodged against the wall's foot on the sides seen in profile from
//     the road (their tops at most ~1.4 m above the ground: nothing a climber would hang on);
//   - CAP SLABS: under each place where a piece of the caprock broke away (terrain_butte's notches), two
//     or three thick slabs of the cap bed (its own tint) lying tipped on the mound;
//   - TALUS: fallen blocks half buried round the foot, denser and bigger near the wall (fewer, smaller
//     ones on the road side), and a scatter of RUBBLE between them.
// The blocks are the butte's own rock: Elwynn's rounded gray granite boulders, Westfall's, the Badlands'
// and Tanaris' tabular slabs of the bedded rock tipped every way, Dun Morogh's cut granite slabs with a
// soft snow cap hanging over their edge. A tabular block is an icosphere cut by a few random planes
// (flat fractured faces, creased normals), its top flattened; a snow slab is an irregular 6-8-sided slab
// with a flat top, a chamfer round its top edge and faces leaning out a little toward the top.
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

// One cut granite slab, unit-ish (radius ~1 in x and z, y from -1 to its flat top at 0.5): an irregular
// n-sided outline, faces leaning out a little toward the top, a chamfer round the top edge, the top
// rings shifted a little so it never stands square. Non-indexed (each face its own plane).
// -> { geo, ang, rad, top, ox, oz } (the outline, for a snow cap to follow)
function slabGeo(r, n = 6 + Math.floor(r() * 3)) {
  const ang = [], rad = [];
  for (let k = 0; k < n; k++) { ang.push((k + (r() - 0.5) * 0.7) / n * TAU); rad.push(0.74 + r() * 0.36); }
  const ox = (r() - 0.5) * 0.12, oz = (r() - 0.5) * 0.12, cy = 0.27 + r() * 0.08;
  const rings = [[-1.0, 0.86, 0], [-0.3, 0.95, 0.4], [cy, 1.0, 0.8], [0.5, 0.82 - r() * 0.06, 1]];
  const jy = ang.map(() => (r() - 0.5) * 0.07);
  const P = (ri, k) => {
    const [y, sc, sh] = rings[ri], kk = k % n, rr = rad[kk] * sc;
    return [Math.cos(ang[kk]) * rr + ox * sh, y + (ri === 2 ? jy[kk] : 0), Math.sin(ang[kk]) * rr + oz * sh];
  };
  const pos = [];
  for (let ri = 0; ri < rings.length - 1; ri++) for (let k = 0; k < n; k++) {
    const a = P(ri, k), b = P(ri, k + 1), c = P(ri + 1, k + 1), d = P(ri + 1, k);
    pos.push(...a, ...c, ...b, ...a, ...d, ...c);
  }
  const T = rings.length - 1, ct = [ox, 0.5, oz], cb = [0, -1.0, 0];
  for (let k = 0; k < n; k++) { pos.push(...ct, ...P(T, k + 1), ...P(T, k)); pos.push(...cb, ...P(0, k), ...P(0, k + 1)); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return { geo: g, ang, rad, top: rings[T][1], ox, oz };
}

// A soft snow cap over a slab's top (in the slab's own frame): it follows the outline, a little wider, so
// it hangs over the edge in a lip that droops further in places; a rounded crown. Smooth normals.
function capGeo(r, S) {
  const n = S.ang.length, m = 3, N = n * m;
  const pts = [];
  for (let k = 0; k < n; k++) {
    const a0 = S.ang[k], a1 = S.ang[(k + 1) % n] + (k === n - 1 ? TAU : 0), r0 = S.rad[k], r1 = S.rad[(k + 1) % n];
    for (let j = 0; j < m; j++) {
      const t = j / m, x0 = Math.cos(a0) * r0, z0 = Math.sin(a0) * r0, x1 = Math.cos(a1) * r1, z1 = Math.sin(a1) * r1;
      pts.push({ x: x0 + (x1 - x0) * t, z: z0 + (z1 - z0) * t, o: 1.04 + r() * 0.12, d: 0.07 + r() * r() * 0.3 });
    }
  }
  const ringY = [[0.78, 0.47], [-1, 0], [-2, 0.56], [0.9, 0.665], [0.55, 0.71]];
  const pos = [], idx = [];
  for (const [sc, y] of ringY) for (const p of pts) {
    if (sc === -1) pos.push(p.x * p.o + S.ox, 0.5 - p.d, p.z * p.o + S.oz);
    else if (sc === -2) pos.push(p.x * (p.o + 0.03) + S.ox, y + p.d * 0.15, p.z * (p.o + 0.03) + S.oz);
    else pos.push(p.x * sc * S.top / 0.82 + S.ox, y + (sc > 0.8 ? 0.02 * (p.o - 1.1) : 0), p.z * sc * S.top / 0.82 + S.oz);
  }
  const R = ringY.length;
  for (let ri = 0; ri < R - 1; ri++) for (let k = 0; k < N; k++) {
    const a = ri * N + k, b = ri * N + (k + 1) % N, c = (ri + 1) * N + (k + 1) % N, d = (ri + 1) * N + k;
    idx.push(a, c, b, a, d, c);
  }
  const ci = pos.length / 3; pos.push(S.ox, 0.73, S.oz);
  for (let k = 0; k < N; k++) idx.push(ci, (R - 1) * N + (k + 1) % N, (R - 1) * N + k);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
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
    acc.v(_v.x, _v.y, _v.z, _n.x, _n.y, _n.z, [S.ao[0] + (1 - S.ao[0]) * ao, S.ao[1] + (1 - S.ao[1]) * ao, S.ao[2] + (1 - S.ao[2]) * ao], [0, 0], [1, sink, snow ? -1 : 99, cap]);
  }
  if (I) for (let i = 0; i < I.count; i++) acc.I.push(v0 + I.getX(i));
  else for (let i = 0; i < P.count; i++) acc.I.push(v0 + i);
}

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _nrm = new THREE.Vector3(), _qs = new THREE.Quaternion();
export function talusInto(acc, W, S, forms) {
  const biome = W.biome;
  const snowy = biome === 'snow', round = biome === 'meadow', tabular = !snowy && !round;
  // one block: size s [x, y, z] (m), yaw, tilt [x, z] (rad), a fraction `sink` of its height buried
  // (a block spans about -1..0.55 of its size in its own frame); kinds by biome
  const block = (r, x, z, s, yaw, tilt, { cap = 0, sink = 0.4, lift = 0, flat = false, B = null } = {}) => {
    // (none inside the other tier: a bench's fallen block where a lobe of the main tier stands round it)
    if (B && inOther(B, x, z) > 0.2) return;
    // it rests on the ground under its footprint (the mound, a bank's slope): its height from the mean
    // ground round it, tipped most of the way with the slope, so it is neither buried on the uphill side
    // (a bare plate showing) nor standing off the downhill one
    const e = Math.max(0.3, Math.max(s[0], s[2]) * 0.6);
    const gE = gnd(x + e, z), gW = gnd(x - e, z), gN = gnd(x, z + e), gS = gnd(x, z - e), gC = gnd(x, z);
    const y = (gE + gW + gN + gS + 2 * gC) / 6 + s[1] * (1 - 1.55 * sink) + lift;
    _e.set(tilt[0], yaw, tilt[1]); _q.setFromEuler(_e);
    _nrm.set(-(gE - gW) / (2 * e) * 0.8, 1, -(gN - gS) / (2 * e) * 0.8).normalize();
    _q.premultiply(_qs.setFromUnitVectors(_up, _nrm));
    _m.compose(_p.set(x, y, z), _q, _s.set(s[0], s[1], s[2]));
    if (snowy && !flat) {
      const sl = slabGeo(r);
      put(acc, W, S, sl.geo, _m, { cap, gnd });
      put(acc, W, S, capGeo(r, sl), _m, { snow: true, gnd });
    } else {
      // (Elwynn: rounded granite, few cuts; elsewhere tabular slabs of the bedded rock)
      const g = round ? blockGeo(r, 2 + Math.floor(r() * 2), 1, 0.3) : blockGeo(r, 6 + Math.floor(r() * 3), 1, 0.18);
      put(acc, W, S, toCreasedNormals(g, round ? 1.05 : 0.75), _m, { cap, gnd });
    }
  };
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
    // (the ground here: the mound, and the bank of sand, snow or scree lapping up the butte's foot)
    gnd = F.bank ? (x, z) => W.heightAt(x, z) + F.bank(x, z) : (x, z) => W.heightAt(x, z);
    const bodies = [F.main, F.bench].filter(Boolean);
    // (how far inside the tier other than B a point stands: the main tier's outline is its body and lobes)
    inOther = (B, x, z) => { const Q = B === F.main ? F.bench : F.main; return Q ? Q.Rb(Math.atan2(z - Q.cz, x - Q.cx)) - Math.hypot(x - Q.cx, z - Q.cz) : -1; };
    // where a body's foot shows (the main body's lies inside the bench round the bench)
    const footOf = (B, a) => {
      if (B.arc && angDiff(a, (B.arc[0] + B.arc[1]) / 2) > (B.arc[1] - B.arc[0]) / 2 - 0.35) return null;
      if (B.shortY && B.shortY(a) != null) return null;
      return B.Rb(a) + B.wall(a, B.gm + 1) + B.flare(a) * 0.55;
    };
    const at = (B, a, d) => [B.cx + Math.cos(a) * d, B.cz + Math.sin(a) * d];
    // shoulders: big blocks lodged against the wall's foot, on the sides seen in profile from the road
    const side0 = r() < 0.5 ? 1 : -1;
    for (let k = 0; k < 1 + (r() < 0.6 ? 1 : 0); k++) {
      for (let t = 0; t < 10; t++) {
        const a = F.roadA + (k ? -side0 : side0) * (Math.PI / 2 + (r() - 0.5) * 1.0);
        const d0 = footOf(F.main, a);
        if (d0 == null) continue;
        const s = [1.5 + r() * 0.6, 1.0 + r() * 0.25, 1.1 + r() * 0.5];
        const [x, z] = at(F.main, a, d0 + s[2] * 0.25);
        if (!roadClear(x, z, s[0])) continue;
        // (a third of it buried: its top no more than ~1.3 m above the ground)
        block(r, x, z, s, -a + (r() - 0.5) * 0.4, [(r() - 0.5) * 0.18, (r() - 0.5) * 0.18], { sink: 0.36, B: F.main });
        break;
      }
    }
    // piles: two or three heaps of big blocks against the foot, away from the road, so the foot is buried
    // (their tops no more than ~1.5 m up)
    for (let k = 0, nP = 2 + (r() < 0.5 ? 1 : 0); k < nP; k++) {
      for (let t = 0; t < 12; t++) {
        const a = F.roadA + Math.PI + (r() - 0.5) * 3.8, d0 = footOf(F.main, a);
        if (d0 == null || angDiff(a, F.roadA) < 1.15) continue;
        for (let j = 0, n = 3 + Math.floor(r() * 3); j < n; j++) {
          const aj = a + (r() - 0.5) * 2.6 / F.main.Rb(a), dj = d0 - 0.3 + r() * 1.7, k0 = 0.85 + r() * 0.75;
          const [x, z] = at(F.main, aj, dj);
          if (!roadClear(x, z, k0)) continue;
          const s = tabular ? [k0 * (1.05 + r() * 0.4), k0 * (0.55 + r() * 0.3), k0 * (0.85 + r() * 0.35)]
            : [k0 * (0.95 + r() * 0.35), k0 * (0.7 + r() * 0.2), k0 * (0.9 + r() * 0.35)];
          block(r, x, z, s, r() * TAU, [(r() - 0.5) * 0.6, (r() - 0.5) * 0.6], { sink: 0.36, B: F.main });
        }
        break;
      }
    }
    // the caprock's slabs, fallen under each notch
    for (const B of bodies) for (const nt of B.notches) {
      const n = 2 + (r() < 0.5 ? 1 : 0);
      for (let k = 0; k < n; k++) {
        const a = nt.a + (r() - 0.5) * nt.w / B.Rb(nt.a) * 1.6, d0 = footOf(B, a);
        if (d0 == null) continue;
        const d = d0 + 0.6 + r() * 2.6, [x, z] = at(B, a, d), th = B.capT(nt.a) / Math.max(0.5, 1 - 0.45 * nt.k);
        const s = [1.0 + r() * 0.7, Math.min(0.9, th * (0.45 + r() * 0.2)), 0.8 + r() * 0.5];
        if (!roadClear(x, z, s[0])) continue;
        block(r, x, z, s, r() * TAU, [(r() - 0.5) * 0.7, (r() - 0.5) * 0.7], { cap: 1, sink: 0.38, B });
      }
    }
    // the talus: fallen blocks round the foot, bigger and closer in near the wall
    for (const B of bodies) {
      const n = Math.round((B.arc ? 6 : 20) + r() * 5);
      for (let k = 0; k < n; k++) {
        const a = B.arc ? B.arc[0] + (k + r() * 0.8) / n * (B.arc[1] - B.arc[0]) : (k + r() * 0.8) / n * TAU;
        const d0 = footOf(B, a);
        if (d0 == null) continue;
        const roadSide = angDiff(a, F.roadA) < 0.9;
        const q = Math.pow(r(), 1.4), d = d0 - 0.1 + q * (roadSide ? 3.2 : 4.6);   // (down the apron: the road side's is short)
        const big = !roadSide && r() < 0.35 * (1 - q), k0 = big ? 0.85 + r() * 0.6 : roadSide ? 0.3 + r() * 0.3 : 0.4 + r() * 0.45;
        const [x, z] = at(B, a, d);
        if (!roadClear(x, z, k0)) continue;
        const s = tabular ? [k0 * (1.0 + r() * 0.4), k0 * (0.42 + r() * 0.25), k0 * (0.8 + r() * 0.35)]
          : round ? [k0 * (0.9 + r() * 0.35), k0 * (0.65 + r() * 0.25), k0 * (0.85 + r() * 0.35)]
          : [k0 * (0.85 + r() * 0.4), k0 * (0.55 + r() * 0.3), k0 * (0.85 + r() * 0.4)];
        block(r, x, z, s, r() * TAU, [(r() - 0.5) * (tabular ? 0.8 : 0.45), (r() - 0.5) * (tabular ? 0.8 : 0.45)], { sink: round ? 0.42 : 0.4, B });
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
