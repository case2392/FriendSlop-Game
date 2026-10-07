// People: every human in the game. Other players (PlayerView), the town NPCs
// (buildCharacter, used by town3d.js) and your own first-person hands (Hands).
//
// Style: WoW Classic humans with a dash of OSRS chunk: big shoulders under domed
// pauldrons, a barrel chest, a leather jerkin skirt with a tabard in the player's
// color hanging front and back, big gauntleted gloves, knee boots with turned-down
// cuffs, a bedroll on the back. Each person is ONE SkinnedMesh (one draw call + one
// in the shadow pass) on a 20-bone skeleton, textured with ONE hand-painted 512×768
// atlas from paint/characters.js (painted faces with lidded eyes and heavy brows,
// chunky painted hair, stitched leather, gold trim). Geometry is smooth lathes,
// tubes and thick slabs, all built here; the detail lives in the texture.
//
// Frames: root at the feet; the model faces local +x inside, and root.rotation.y
// = -PI/2 turns it to face +z (unchanged from the old egg people). Bones rotate
// about local z to swing forward (legs, arms, head nod), as before. Two extra
// bones (flapF, flapB) carry the front and back of the skirt and tabard: they
// follow the forward-most / back-most thigh, so the cloth never cuts the legs.
//
// HEAD FRAME (for accessories added to `head`, e.g. the Repo Man's shades in
// town3d.js): +x = where the face points, +y = up, +z = the character's right.
// The head bone has a uniform local scale of 1 head unit: HU = 0.00829 m (× the
// character's scale). In head units the eyes sit at about (13, 3.5, ±4.5), the
// nose bridge front at x ≈ 16, the skull half-width at the eyes is ≈ 13, the crown
// at y ≈ 22, the chin at y ≈ -12. So the old sunglasses transform, position
// (16.5, 4, 0) with BoxGeometry(4, 5, 30), still sits right across the eyes. (The
// Repo Man now wears modeled brass aviators of his own at the same spot.)
import { THREE, painted, tex, labelSprite, canvasTex } from './gfx.js';
import * as C from '/shared/constants.js';
import { mergeGeometries } from '/vendor/BufferGeometryUtils.js';
import { AW, AH, REG, HEAD_RINGS, TORSO, TORSO_UP, hairlineDy, lerpTable, armV, skirtV, resolveSpec, charAtlas, charGlow, handsAtlas, FP, labelColor } from './paint/characters.js';

const TAU = Math.PI * 2;
const HS = 1.16;             // head size factor over HEAD_RINGS
const HU = 0.025 * HS / 3.5; // head-local unit (see the header): the eye line sits at y = 3.5
const clamp01 = x => Math.max(0, Math.min(1, x));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const thOf = u => Math.PI - TAU * u;          // u .5 = front (+x), .25 = right (+z), .75 = left (-z)
const gauss = (x, s) => Math.exp(-(x * x) / (s * s));

// bone indices
const B = { body: 0, hips: 1, spine: 2, chest: 3, neck: 4, head: 5, armL: 6, foreL: 7, handL: 8, armR: 9, foreR: 10, handR: 11, legL: 12, shinL: 13, footL: 14, legR: 15, shinR: 16, footR: 17, flapF: 18, flapB: 19 };
const ARM = s => s < 0 ? [B.armL, B.foreL, B.handL] : [B.armR, B.foreR, B.handR];
const LEG = s => s < 0 ? [B.legL, B.shinL, B.footL] : [B.legR, B.shinR, B.footR];
// spine joints (meters, body space)
const J = { hips: 0.95, spine: 1.06, chest: 1.25, neck: 1.475, head: 1.62, hipY: 0.92, upper: 0.29, fore: 0.258, thigh: 0.42, shin: 0.4 };
// limb joints depend on the build (s = -1 left, +1 right)
function frameOf(S) {
  const fem = !!S.look.female, bulk = S.bulk || 1, wide = 1 + (bulk - 1) * 0.9;
  const sh = (fem ? 0.228 : 0.252) * wide, shY = fem ? 1.415 : 1.425;
  return {
    fem, bulk,
    shoulder: s => [0, shY, sh * s],
    hip: s => [0, J.hipY, (fem ? 0.104 : 0.108) * wide * s],
    knee: s => [0.006, J.hipY - J.thigh, (fem ? 0.098 : 0.122) * wide * s],
    ankle: s => [0, J.hipY - J.thigh - J.shin, (fem ? 0.094 : 0.112) * wide * s],
  };
}

// ---- geometry kit -------------------------------------------------------------------------

function ringXZ(th, w, d, db, n = 2) {
  const c = Math.cos(th), s = Math.sin(th), e = 2 / n;
  return [Math.sign(c) * Math.pow(Math.abs(c), e) * (c >= 0 ? d : db), Math.sign(s) * Math.pow(Math.abs(s), e) * w];
}
function weightsOf(bones, p, u, v) {
  let list = typeof bones === 'number' ? [[bones, 1]] : bones(p, u, v);
  list = list.filter(x => x[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const tot = list.reduce((a, x) => a + x[1], 0) || 1;
  const si = [0, 0, 0, 0], sw = [0, 0, 0, 0];
  list.forEach(([b, w], i) => { si[i] = b; sw[i] = w / tot; });
  return [si, sw];
}

// A (u, v) grid surface. fn(u, v) -> [x, y, z]. o.reg = atlas rect, o.uv(u, v) ->
// [tu, tv] inside it, o.bones = bone index or fn, o.inside(u, v) -> a point the
// surface should face away from, o.closed = u wraps (seam normals are welded).
function surf(fn, nu, nv, o) {
  const pos = [], uvs = [], si = [], sw = [], ins = [];
  const [aw, ah] = o.atlas || [AW, AH], reg = o.reg;
  for (let i = 0; i <= nv; i++) for (let j = 0; j <= nu; j++) {
    const u = j / nu, v = i / nv, p = fn(u, v);
    pos.push(p[0], p[1], p[2]);
    const [tu, tv] = o.uv ? o.uv(u, v) : [u, v];
    uvs.push((reg.x + 0.5 + clamp01(tu) * (reg.w - 1)) / aw, 1 - (reg.y + 0.5 + (1 - clamp01(tv)) * (reg.h - 1)) / ah);
    if (o.bones != null) { const [a, b] = weightsOf(o.bones, p, u, v); si.push(...a); sw.push(...b); }
    ins.push(o.inside ? o.inside(u, v) : null);
  }
  const idx = [];
  for (let i = 0; i < nv; i++) for (let j = 0; j < nu; j++) {
    const a = i * (nu + 1) + j, b = a + 1, c = a + nu + 1, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  if (o.bones != null) {
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  }
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // orientation: face away from the inside reference (or the centroid)
  const P = geo.attributes.position, N = geo.attributes.normal;
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < P.count; k++) { cx += P.getX(k); cy += P.getY(k); cz += P.getZ(k); }
  cx /= P.count; cy /= P.count; cz /= P.count;
  let sum = 0;
  for (let k = 0; k < P.count; k++) {
    const c = ins[k] || o.center || [cx, cy, cz];
    sum += N.getX(k) * (P.getX(k) - c[0]) + N.getY(k) * (P.getY(k) - c[1]) + N.getZ(k) * (P.getZ(k) - c[2]);
  }
  if ((sum < 0) !== !!o.flip) {
    for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
    geo.setIndex(idx);
    geo.computeVertexNormals();
  }
  const Nn = geo.attributes.normal;
  const avg = list => {
    let x = 0, y = 0, z = 0;
    for (const k of list) { x += Nn.getX(k); y += Nn.getY(k); z += Nn.getZ(k); }
    const l = Math.hypot(x, y, z) || 1;
    for (const k of list) Nn.setXYZ(k, x / l, y / l, z / l);
  };
  if (o.closed) for (let i = 0; i <= nv; i++) avg([i * (nu + 1), i * (nu + 1) + nu]);
  for (const i of [0, nv]) {          // poles: a collapsed ring gets one normal
    const row = []; for (let j = 0; j <= nu; j++) row.push(i * (nu + 1) + j);
    let span = 0; const x0 = P.getX(row[0]), y0 = P.getY(row[0]), z0 = P.getZ(row[0]);
    for (const k of row) span = Math.max(span, Math.abs(P.getX(k) - x0) + Math.abs(P.getY(k) - y0) + Math.abs(P.getZ(k) - z0));
    if (span < 1e-5) avg(row);
  }
  return geo;
}

// Lathe from a ring table. Each ring {y, w, d, db, n, cx, cz, v}. o.xf maps the
// local point (x = ring front, y = along, z = ring side) to the model; o.deform
// tweaks local points.
function lathe(rings, o) {
  const nv = rings.length - 1, nu = o.seg || 14;
  const R = v => rings[Math.round(v * nv)];
  const xf = o.xf || (p => p);
  return surf((u, v) => {
    const r = R(v), th = thOf(u);
    const [x, z] = ringXZ(th, r.w, r.d, r.db ?? r.d, r.n ?? 2);
    let p = [(r.cx || 0) + x, r.y, (r.cz || 0) + z];
    if (o.deform) p = o.deform(p, th, r, u, v);
    return xf(p);
  }, nu, nv, { ...o, closed: true, uv: o.uv || ((u, v) => [u, R(v).v ?? v]), inside: (u, v) => { const r = R(v); return xf([r.cx || 0, r.y, r.cz || 0]); } });
}

// Tube along a path(v) -> point, radius(v, th). o.ref = a vector not parallel to the path.
function tube(path, radius, nu, nv, o) {
  const ref = o.ref || [0, 1, 0];
  const frame = v => {
    const e = 1e-3, a = path(Math.max(0, v - e)), b = path(Math.min(1, v + e));
    let T = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]; const l = Math.hypot(...T) || 1; T = T.map(x => x / l);
    let N = [ref[1] * T[2] - ref[2] * T[1], ref[2] * T[0] - ref[0] * T[2], ref[0] * T[1] - ref[1] * T[0]];
    const ln = Math.hypot(...N) || 1; N = N.map(x => x / ln);
    const Bn = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
    return [N, Bn];
  };
  return surf((u, v) => {
    const p = path(v), [N, Bn] = frame(v), th = thOf(u), r = radius(v, th), c = Math.cos(th), s = Math.sin(th);
    return [p[0] + (N[0] * c + Bn[0] * s) * r, p[1] + (N[1] * c + Bn[1] * s) * r, p[2] + (N[2] * c + Bn[2] * s) * r];
  }, nu, nv, { ...o, closed: true, inside: (u, v) => path(v) });
}
const bez = (a, b, c, d) => t => { const m = 1 - t; return [0, 1, 2].map(k => m * m * m * a[k] + 3 * m * m * t * b[k] + 3 * m * t * t * c[k] + t * t * t * d[k]); };

// A thin sheet with thickness: outer surface, inner surface, and rims on open edges.
function slab(fn, nu, nv, thick, o) {
  const outer = surf(fn, nu, nv, o);
  const inner = outer.clone();
  const P = inner.attributes.position, N = outer.attributes.normal, NI = inner.attributes.normal;
  for (let k = 0; k < P.count; k++) {
    P.setXYZ(k, P.getX(k) - N.getX(k) * thick, P.getY(k) - N.getY(k) * thick, P.getZ(k) - N.getZ(k) * thick);
    NI.setXYZ(k, -N.getX(k), -N.getY(k), -N.getZ(k));
  }
  const ii = Array.from(inner.index.array);
  for (let k = 0; k < ii.length; k += 3) { const t = ii[k + 1]; ii[k + 1] = ii[k + 2]; ii[k + 2] = t; }
  inner.setIndex(ii);
  if (o.uvInner) { const U = inner.attributes.uv; for (let k = 0; k < U.count; k++) { const [a, b] = o.uvInner(U.getX(k), U.getY(k)); U.setXY(k, a, b); } }
  const parts = [outer, inner];
  const edges = [];
  const W = nu + 1;
  if (!o.closed) { edges.push([...Array(nv + 1).keys()].map(i => i * W)); edges.push([...Array(nv + 1).keys()].map(i => i * W + nu)); }
  edges.push([...Array(W).keys()]); edges.push([...Array(W).keys()].map(j => nv * W + j));
  const OP = outer.attributes.position;
  for (const e of edges) {
    const pos = [], uv = [], si = [], sw = [], idx = [];
    const OU = outer.attributes.uv;
    for (const k of e) {
      pos.push(OP.getX(k), OP.getY(k), OP.getZ(k), P.getX(k), P.getY(k), P.getZ(k));
      uv.push(OU.getX(k), OU.getY(k), OU.getX(k), OU.getY(k));
      if (outer.attributes.skinIndex) for (let r = 0; r < 2; r++) { for (let q = 0; q < 4; q++) { si.push(outer.attributes.skinIndex.array[k * 4 + q]); sw.push(outer.attributes.skinWeight.array[k * 4 + q]); } }
    }
    for (let m = 0; m < e.length - 1; m++) { const a = m * 2, b = a + 1, c = a + 2, d = a + 3; idx.push(a, c, b, b, c, d); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    if (si.length) { g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4)); }
    g.setIndex(idx); g.computeVertexNormals();
    const mid = e[Math.floor(e.length / 2)];
    const nb = e === edges[0] && !o.closed ? mid + 1 : e === edges[1] && !o.closed ? mid - 1 : (mid < W ? mid + W : mid - W);
    const out = [OP.getX(mid) - OP.getX(nb), OP.getY(mid) - OP.getY(nb), OP.getZ(mid) - OP.getZ(nb)];
    const RN = g.attributes.normal; const mi = Math.floor(e.length / 2) * 2;
    if (RN.getX(mi) * out[0] + RN.getY(mi) * out[1] + RN.getZ(mi) * out[2] < 0) {
      for (let k = 0; k < idx.length; k += 3) { const t = idx[k + 1]; idx[k + 1] = idx[k + 2]; idx[k + 2] = t; }
      g.setIndex(idx); g.computeVertexNormals();
    }
    parts.push(g);
  }
  return parts;
}

// ---- the head --------------------------------------------------------------------------------

const H0 = [0, J.head, 0];
// point on the (undeformed) skull at angle th, height dy above the head origin, in head-local meters
function skull(th, dy) {
  const k = dy / HS;
  const w = lerpTable(HEAD_RINGS, k, 1), d = lerpTable(HEAD_RINGS, k, 2), db = lerpTable(HEAD_RINGS, k, 3), n = lerpTable(HEAD_RINGS, k, 4), cx = lerpTable(HEAD_RINGS, k, 5);
  const [x, z] = ringXZ(th, w, d, db, n);
  return [(cx + x) * HS, dy, z * HS];
}
const HC = [-0.006 * HS, 0.025 * HS, 0];     // head center for radial offsets
function shellPt(th, dy, off) {
  const p = skull(th, dy);
  const dx = p[0] - HC[0], dyy = p[1] - HC[1], dz = p[2] - HC[2];
  const l = Math.hypot(dx, dyy, dz) || 1;
  return [p[0] + dx / l * off, p[1] + dyy / l * off, p[2] + dz / l * off];
}
const toHead = p => [p[0] + H0[0], p[1] + H0[1], p[2] + H0[2]];
const CROWN = 0.156 * HS;

function headWeights(p) {
  const dy = p[1] - J.head;
  if (dy > -0.1 * HS) return [[B.head, 1]];
  const t = sstep(-0.15 * HS, -0.1 * HS, dy);
  return [[B.head, t], [B.neck, (1 - t) * 0.7], [B.chest, (1 - t) * 0.3]];
}

function headParts(S) {
  const parts = [];
  const rings = HEAD_RINGS.map(([dy, w, d, db, n, cx, v]) => ({ y: dy * HS, w: w * HS, d: d * HS, db: db * HS, n, cx: cx * HS, v }));
  const fem = S.look.female;
  parts.push(lathe(rings, {
    seg: 24, reg: REG.head, bones: headWeights, xf: toHead,
    deform(p, th, r) {
      const dy = r.y / HS, front = Math.max(0, Math.cos(th));
      let dx = 0;
      dx += (fem ? 0.017 : 0.025) * gauss(dy + 0.014, 0.012) * gauss(th, 0.2);        // nose tip
      dx += (fem ? 0.009 : 0.013) * gauss(dy - 0.012, 0.016) * gauss(th, 0.17);       // bridge
      dx += 0.008 * gauss(dy - 0.047, 0.01) * gauss(th, 0.8) * (fem ? 0.5 : 1);         // brow ridge
      dx -= 0.008 * gauss(dy - 0.025, 0.012) * gauss(Math.abs(th) - 0.34, 0.16);        // eye sockets
      dx += 0.006 * gauss(dy + 0.074, 0.014) * gauss(th, 0.32) * (fem ? 0.4 : 1);       // chin
      const cheek = 0.006 * gauss(dy, 0.016) * gauss(Math.abs(th) - 0.8, 0.3);           // cheekbones
      const c = Math.cos(th), s = Math.sin(th);
      // a woman's jaw and chin are narrower
      const jaw = fem ? 1 - 0.14 * gauss(dy + 0.07, 0.03) : 1;
      return [p[0] + dx * HS * front + cheek * HS * c, p[1], (p[2] + cheek * HS * s) * jaw];
    },
  }));
  // ears
  for (const s of [-1, 1]) {
    const er = [[-0.028, 0], [-0.024, 0.6], [-0.01, 1], [0.012, 1], [0.024, 0.75], [0.03, 0]].map(([dy, k], i, a) => ({ y: dy * HS, w: 0.01 * k * HS, d: 0.02 * k * HS, db: 0.013 * k * HS, cx: (-0.006 - dy * 0.15) * HS, v: i / (a.length - 1) }));
    parts.push(lathe(er, { seg: 8, reg: REG.ear, bones: B.head, xf: p => toHead([p[0], p[1] + 0.008 * HS, p[2] + s * 0.094 * HS]) }));
  }
  // hair shell
  const L = S.look, coveredByHat = ['hood', 'helm', 'beanie', 'bandana'].includes(S.hat);
  if (['short', 'slick', 'braid', 'bun', 'long'].includes(L.hair) && !coveredByHat) {
    const vol = L.hair === 'slick' ? 0.006 : L.hair === 'short' ? 0.017 : 0.013;
    parts.push(surf((u, v) => {
      const th = thOf(u);
      const jag = (L.hair === 'short' || L.hair === 'long') && Math.abs(th) < 1.1 ? (Math.round(u * 24) % 2 ? 0.007 : -0.004) : 0;
      const h0 = (hairlineDy(th) + jag) * HS + (L.hair === 'slick' ? 0.006 : 0);
      const dy = h0 + (CROWN + 0.002 - h0) * Math.pow(v, 0.8);
      const tuft = L.hair === 'short' ? 0.005 * Math.sin(u * 37) * Math.sin(v * 9) : 0;
      return toHead(shellPt(th, dy, v === 0 ? 0 : vol * Math.min(1, v * 4) * (0.7 + 0.3 * Math.cos(th * 0.5) ** 2) + tuft));
    }, 24, 7, { reg: REG.hair, bones: B.head, closed: true, inside: () => toHead(HC) }));
  }
  if (L.hair === 'long') {
    // a mane hanging from the back of the head to the shoulders
    parts.push(...slab((u, v) => {
      const th = Math.PI + (u - 0.5) * 2.5;
      const top = hairlineDy(th) * HS;
      if (v < 0.55) {
        const dy = top + 0.03 - (v / 0.55) * (top + 0.12 * HS);
        return toHead(shellPt(th, dy, 0.016 + 0.01 * v));
      }
      const t = (v - 0.55) / 0.45, b = shellPt(th, -0.12 * HS, 0.022);
      return toHead([b[0] - 0.02 * t, b[1] - 0.09 * t, b[2] * (1 + 0.25 * t)]);
    }, 10, 6, 0.012, { reg: REG.hair, uv: (u, v) => [u, 1 - v], bones: p => { const t = sstep(1.5, 1.4, p[1]); return [[B.head, 1 - t], [B.neck, t * 0.5], [B.chest, t * 0.5]]; }, inside: () => toHead(HC) }));
  }
  if (L.hair === 'braid') {
    const path = bez(toHead([-0.1 * HS, 0.03 * HS, 0]), toHead([-0.15 * HS, -0.1 * HS, 0]), [-0.19, 1.42, 0], [-0.185, 1.22, 0]);
    parts.push(tube(path, (v) => (0.026 - 0.008 * v) * (0.85 + 0.15 * Math.abs(Math.sin(v * Math.PI * 7))) * Math.sqrt(Math.sin(Math.min(1, v * 1.02 + 0.02) * Math.PI)), 8, 14, {
      reg: REG.beard, ref: [0, 0, 1], bones: p => { const t = sstep(1.5, 1.32, p[1]); return [[B.head, 1 - t], [B.chest, t]]; },
    }));
    parts.push(tube(v => [-0.185, 1.22 - v * 0.05, 0], v => 0.022 * Math.sqrt(Math.sin(v * Math.PI)), 8, 4, { reg: REG.beard, ref: [1, 0, 0], bones: B.chest }));
  }
  if (L.hair === 'bun' && !coveredByHat) {
    const c = toHead([-0.08 * HS, 0.12 * HS, 0]);
    parts.push(lathe([0, 0.6, 0.9, 1, 0.9, 0.6, 0].map((k, i) => ({ y: (i / 6 - 0.5) * 0.085, w: 0.046 * k, d: 0.042 * k, v: i / 6 })), {
      seg: 10, reg: REG.beard, bones: B.head, xf: p => [c[0] + p[0] - p[1] * 0.4, c[1] + p[1], c[2] + p[2]],
    }));
  }
  if (L.facial === 'beard' || L.facial === 'goatee') {
    const big = L.facial === 'beard';
    const c = toHead([(big ? 0.07 : 0.095) * HS, (big ? -0.078 : -0.09) * HS, 0]);
    const ks = big ? [0, 0.75, 1, 0.95, 0.7, 0] : [0, 0.9, 1, 0.75, 0.4, 0];
    parts.push(lathe(ks.map((k, i) => ({ y: (0.5 - i / 5) * (big ? 0.08 : 0.052), w: (big ? 0.076 : 0.023) * k, d: (big ? 0.044 : 0.017) * k, db: (big ? 0.03 : 0.01) * k, v: 1 - i / 5 })), {
      seg: 12, reg: REG.beard, bones: B.head, xf: p => [c[0] + p[0] + Math.max(0, -p[1]) * 0.35, c[1] + p[1], c[2] + p[2]],
    }));
  }
  if (L.facial === 'mustache') {
    const path = v => { const a = (v - 0.5) * 2.2; return toHead([0.114 * HS - Math.abs(a) * 0.012, (-0.03 - Math.abs(a) ** 2 * 0.012) * HS, Math.sin(a) * 0.04 * HS]); };
    parts.push(tube(path, v => 0.012 * Math.sin(v * Math.PI) ** 0.6, 6, 10, { reg: REG.beard, ref: [1, 0, 0], bones: B.head }));
  }
  if (S.shades) parts.push(...shadesParts());
  parts.push(...hatParts(S));
  return parts;
}

// The Repo Man's aviators: two dark lenses in brass frames, a bridge, temples to the ears.
function shadesParts() {
  const P = [], G = REG.gear;
  const lensUV = (u, v) => [u, 0.76 + v * 0.24], frameUV = (u, v) => [u, 0.63 + v * 0.1];
  for (const s of [-1, 1]) {
    const thc = s * 0.3, dyc = 0.024 * HS;
    P.push(...slab((u, v) => {
      const a = (u - 0.5) * 2, b = (v - 0.5) * 2;
      const r = Math.max(Math.abs(a) ** 3 + Math.abs(b) ** 3, 1e-6) ** (1 / 3);    // a rounded lens outline
      const k = r > 1 ? 1 / r : 1;
      const th = thc + a * k * 0.2 * (b < 0 ? 1 - 0.25 * a * s * Math.abs(b) : 1), dy = dyc + b * k * 0.018 * HS - (b < 0 ? 0.004 * Math.abs(a) : 0);
      return toHead(shellPt(th, dy, 0.016 + 0.003 * (1 - b * b)));
    }, 6, 4, 0.005, { reg: G, uv: lensUV, uvInner: (x, y) => [x, y], bones: B.head, inside: () => toHead(HC) }));
    // the frame's top bar and temple
    const a0 = toHead(shellPt(thc - s * 0.2, dyc + 0.02 * HS, 0.02)), a1 = toHead(shellPt(thc + s * 0.22, dyc + 0.02 * HS, 0.02));
    P.push(tube(v => [a0[0] + (a1[0] - a0[0]) * v, a0[1] + (a1[1] - a0[1]) * v + 0.004 * Math.sin(v * Math.PI), a0[2] + (a1[2] - a0[2]) * v], () => 0.0035, 6, 4, { reg: G, uv: frameUV, ref: [1, 0, 0], bones: B.head }));
    const t0 = toHead(shellPt(s * 0.62, dyc + 0.016 * HS, 0.012)), t1 = toHead(shellPt(s * 1.45, dyc + 0.01 * HS, 0.006));
    P.push(tube(v => [t0[0] + (t1[0] - t0[0]) * v, t0[1] + (t1[1] - t0[1]) * v, t0[2] + (t1[2] - t0[2]) * v], () => 0.003, 5, 4, { reg: G, uv: frameUV, ref: [0, 1, 0], bones: B.head }));
  }
  const b0 = toHead(shellPt(-0.12, 0.034 * HS, 0.022)), b1 = toHead(shellPt(0.12, 0.034 * HS, 0.022));
  P.push(tube(v => [b0[0] + (b1[0] - b0[0]) * v + 0.004 * Math.sin(v * Math.PI), b0[1] + (b1[1] - b0[1]) * v, b0[2] + (b1[2] - b0[2]) * v], () => 0.0035, 6, 4, { reg: G, uv: frameUV, ref: [0, 1, 0], bones: B.head }));
  return P;
}

// ---- hats ----------------------------------------------------------------------------------

const ACC = REG.acc;
const crownUV = (u, v) => [u, 0.52 + v * 0.48];
const brimUV = (u, v) => [u, v * 0.45];
function hatParts(S) {
  const h = S.hat, P = [];
  const head = { bones: B.head };
  if (h === 'brim' || h === 'straw') {
    // a wide-brimmed leather hat with a pinched crown and a brim that curls up at the
    // sides, or a farmer's straw hat with a round crown and a ragged drooping brim
    const straw = h === 'straw';
    const base = 0.08 * HS, top = (straw ? 0.21 : 0.225) * HS;
    const prof = straw ? [[1, 0], [0.98, 0.3], [0.9, 0.65], [0.78, 0.9], [0.5, 1.0], [0, 1.03]] : [[1, 0], [0.99, 0.3], [0.95, 0.7], [0.88, 0.95], [0.55, 1.0], [0.25, 0.9], [0, 0.88]];
    const rx = 0.13 * HS, rz = 0.122 * HS;
    P.push(lathe(prof.map(([k, t], i) => ({ y: base + (top - base) * t, w: rz * k, d: rx * k * (!straw && t > 0.8 ? 0.82 : 1), db: rx * k, n: 2.1, cx: -0.008, v: i / (prof.length - 1) })), {
      seg: 18, reg: ACC, uv: (u, v) => crownUV(u, v), ...head, xf: toHead,
      deform: (p, th) => straw ? p : [p[0], p[1] - (p[1] > top * 0.9 ? 0.014 * Math.max(0, Math.cos(th)) : 0), p[2] * (1 - (p[1] > top * 0.85 ? 0.06 * Math.max(0, Math.cos(th)) : 0))],
    }));
    const r0 = 0.1 * HS, r1 = (straw ? 0.24 : 0.235) * HS;
    P.push(...slab((u, v) => {
      const th = thOf(u), t = v;
      let r = r0 + (r1 - r0) * t;
      if (straw) r += (Math.sin(u * 61) * 0.5 + Math.sin(u * 23) * 0.5) * 0.008 * t;
      const side = Math.sin(th) ** 2, front = Math.cos(th);
      const y = base + 0.004 - (straw ? 0.03 * t * t : 0) + (straw ? 0 : 0.05 * side * t ** 1.7 - 0.016 * Math.max(0, front) * t);
      return toHead([Math.cos(th) * r * 1.05 - 0.008, y, Math.sin(th) * r]);
    }, 24, 3, 0.012, { reg: ACC, uv: brimUV, ...head, closed: true, inside: () => toHead([0, base + 0.05, 0]) }));
  } else if (h === 'bandana' || h === 'beanie' || h === 'helm' || h === 'hood' || h === 'cap') {
    const off = { bandana: 0.012, beanie: 0.02, helm: 0.024, hood: 0.03, cap: 0.022 }[h];
    const low = th => {
      const a = Math.abs(th);
      if (h === 'hood') return -0.12 * HS;
      if (h === 'helm') return (a < 0.9 ? 0.042 : lerpTable([[0.9, 0.042], [1.5, 0.0], [Math.PI, -0.035]], a)) * HS;
      if (h === 'beanie') return (a < 1.2 ? 0.062 : lerpTable([[1.2, 0.062], [1.6, 0.045], [Math.PI, 0.0]], a)) * HS;
      if (h === 'cap') return lerpTable([[0, 0.068], [1.5, 0.05], [Math.PI, 0.02]], a) * HS;
      return lerpTable([[0, 0.07], [1.3, 0.05], [1.7, 0.03], [Math.PI, -0.045]], a) * HS;   // bandana
    };
    const shellFn = (u, v) => {
      const th = thOf(u);
      const lo = low(th), dy = lo + (CROWN + 0.004 - lo) * Math.pow(v, 0.85);
      const bulge = h === 'beanie' ? 0.012 * Math.sin(v * Math.PI) : 0;
      return toHead(shellPt(th, dy, off + bulge));
    };
    if (h === 'hood') {
      // u runs from one edge of the face opening, round the back, to the other; the
      // opening is a pointed arch: wide at the jaw, closing over the forehead
      P.push(...slab((u, v) => {
        const te = 1.2 * (1 - sstep(0.5, 0.97, v)), side = u < 0.5 ? 1 : -1, f = u < 0.5 ? u * 2 : (1 - u) * 2;
        const th = side * (te + (Math.PI - te) * f);
        const lo = low(th), dy = lo + (CROWN + 0.006 - lo) * Math.pow(v, 0.9);
        const back = gauss(Math.abs(th) - Math.PI, 0.9);
        let p = shellPt(th, dy, 0.03 + 0.016 * (1 - v) + 0.012 * back * v);
        if (dy < -0.03 * HS) p = [p[0] * 1.03, p[1], p[2] * (1 + (-0.03 * HS - dy) * 2.2)];
        p[0] -= 0.05 * gauss(v - 1, 0.35) * back;      // the hood's point, drooping at the back
        p[1] += 0.02 * gauss(v - 0.85, 0.2) * back;
        if (f < 0.08) { p[0] += 0.008 * (1 - f / 0.08); }   // rolled front edge
        return toHead(p);
      }, 18, 9, 0.02, { reg: ACC, uv: crownUV, bones: p => headWeights(p), inside: () => toHead(HC), uvInner: (a, b) => [a, b - 0.03] }));
      // mantle round the shoulders
      P.push(...slab((u, v) => {
        const th = thOf(u), y = 1.49 - v * 0.17;
        const [x, z] = ringXZ(th, 0.088 + v * 0.2, 0.082 + v * 0.14, 0.082 + v * 0.14, 2.2);
        return [x - 0.01, y + 0.02 * Math.cos(th * 2) * v, z];
      }, 18, 3, 0.012, { reg: ACC, uv: brimUV, bones: p => p[1] > 1.46 ? [[B.chest, 0.6], [B.neck, 0.4]] : [[B.chest, 1]], closed: true, inside: () => [0, 1.32, 0] }));
    } else {
      P.push(surf(shellFn, 22, 6, { reg: ACC, uv: crownUV, bones: B.head, closed: true, inside: () => toHead(HC) }));
    }
    if (h === 'helm' || h === 'beanie' || h === 'cap') {    // rim / cuff ring at the bottom edge
      const thick = h === 'helm' ? 0.014 : h === 'beanie' ? 0.014 : 0.006;
      P.push(surf((u, v) => {
        const th = thOf(u), lo = low(th), dy = lo + (v - 0.5) * (h === 'beanie' ? 0.05 : 0.026) * HS + (h === 'beanie' ? 0.014 * HS : 0.004);
        return toHead(shellPt(th, dy, off + thick * Math.sin(v * Math.PI) + 0.002));
      }, 22, 4, { reg: ACC, uv: brimUV, bones: B.head, closed: true, inside: () => toHead(HC) }));
    }
    if (h === 'cap') {
      P.push(...slab((u, v) => {
        const a = (u - 0.5) * 1.9, r = shellPt(a, 0.068 * HS, off);
        const ext = v * 0.085 * Math.pow(Math.max(0, Math.cos(a * 1.45)), 0.6);
        return toHead([r[0] + ext, r[1] - ext * 0.3, r[2] + Math.sin(a) * ext * 0.25]);
      }, 12, 2, 0.008, { reg: ACC, uv: brimUV, bones: B.head, inside: () => toHead([0, 0.1, 0]) }));
      P.push(lathe([0, 1, 0.7, 0].map((k, i) => ({ y: CROWN + off + i * 0.004, w: 0.012 * k, d: 0.012 * k, v: 1 })), { seg: 8, reg: ACC, uv: () => [0.5, 0.98], bones: B.head, xf: toHead }));
    }
    if (h === 'beanie') {   // the pompom-less fold at the top
      P.push(lathe([0, 0.8, 1, 0.6, 0].map((k, i) => ({ y: CROWN + off + 0.004 + i * 0.006, w: 0.022 * k, d: 0.02 * k, v: 0.95 })), { seg: 8, reg: ACC, uv: () => [0.5, 0.95], bones: B.head, xf: toHead }));
    }
    if (h === 'bandana') {
      const k = toHead(shellPt(Math.PI, 0.0, off + 0.012));
      P.push(lathe([0, 0.8, 1, 0.8, 0].map((q, i) => ({ y: (i / 4 - 0.5) * 0.05, w: 0.03 * q, d: 0.022 * q, v: i / 4 })), { seg: 10, reg: ACC, uv: (u, v) => [u, 0.6 + v * 0.3], bones: B.head, xf: p => [k[0] + p[0] - 0.008, k[1] + p[1], k[2] + p[2]] }));
      for (const s of [-1, 1]) P.push(...slab((u, v) => [k[0] - 0.012 - v * 0.03, k[1] - 0.01 - v * 0.12, k[2] + s * (0.006 + v * 0.025) + (u - 0.5) * 0.04], 2, 4, 0.006,
        { reg: ACC, uv: (u, v) => [u * 0.2 + 0.4, 0.55 - v * 0.5], bones: p => { const t = sstep(1.6, 1.48, p[1]); return [[B.head, 1 - t], [B.neck, t]]; }, inside: () => [k[0] + 0.1, k[1], k[2]] }));
    }
    if (h === 'helm') {
      // a nasal guard and a pair of curling horns
      P.push(...slab((u, v) => toHead(shellPt((u - 0.5) * 0.2, (0.06 - v * 0.065) * HS, off + 0.008 + 0.006 * v)), 2, 3, 0.006, { reg: ACC, uv: (u, v) => [0.5, 0.2 + v * 0.2], bones: B.head, inside: () => toHead(HC) }));
      for (const s of [-1, 1]) {
        const a = toHead([0, 0.09 * HS, s * 0.11 * HS]);
        const path = bez(a, [a[0] + 0.01, a[1] + 0.03, a[2] + s * 0.09], [a[0] + 0.05, a[1] + 0.12, a[2] + s * 0.13], [a[0] + 0.085, a[1] + 0.2, a[2] + s * 0.1]);
        P.push(tube(path, v => 0.034 * (1 - v) ** 0.9 + 0.002, 9, 9, { reg: REG.horn, uv: (u, v) => [u, v], ref: [1, 0, 0], bones: B.head }));
      }
    }
  } else if (h === 'visor') {
    P.push(surf((u, v) => toHead(shellPt(thOf(u), (0.068 + v * 0.03) * HS, 0.012 + 0.004 * Math.sin(v * Math.PI))), 20, 3, { reg: ACC, uv: crownUV, bones: B.head, closed: true, inside: () => toHead(HC) }));
    P.push(...slab((u, v) => {
      const a = (u - 0.5) * 2.0, r = shellPt(a, 0.08 * HS, 0.016);
      const ext = v * 0.09;
      return toHead([r[0] + Math.cos(a) * ext, r[1] - v * 0.035, r[2] + Math.sin(a) * ext * 0.9]);
    }, 12, 2, 0.005, { reg: ACC, uv: brimUV, bones: B.head, inside: () => toHead([0, 0.1, 0]) }));
  }
  return P;
}

// ---- body ----------------------------------------------------------------------------------

// per-height width scales for the build: women narrower in the chest and waist,
// big men wider all over
function torsoScale(y, S) {
  const b = S.bulk || 1;
  let kw = b, kd = b, kdb = b;
  if (S.look.female) {
    const chest = gauss(y - 1.3, 0.13), waist = gauss(y - 1.06, 0.09), hip = gauss(y - 0.86, 0.09);
    kw *= 1 - 0.13 * chest - 0.15 * waist - 0.02 * hip;
    kd *= 1 - 0.1 * waist - 0.05 * chest;
    kdb *= 1 - 0.08 * chest + 0.04 * hip;
  }
  return [kw, kd, kdb];
}
function torsoRing(y, S) {
  const [kw, kd, kdb] = torsoScale(y, S);
  const r = { y, w: lerpTable(TORSO_UP, y, 1) * kw, d: lerpTable(TORSO_UP, y, 2) * kd, db: lerpTable(TORSO_UP, y, 3) * kdb, n: lerpTable(TORSO_UP, y, 4) };
  r.d += (S.belly || 0) * gauss(y - 1.06, 0.12);
  if (S.look.female) r.d += 0.022 * gauss(y - 1.27, 0.06);   // bust
  return r;
}
function torsoWeights(p) {
  const y = p[1];
  if (y < 0.955) {
    const a = 0.55 * sstep(0.955, 0.775, y);
    const l = clamp01(0.5 - p[2] / 0.2 * 0.7);
    return [[B.hips, 1 - a], [B.legL, a * l], [B.legR, a * (1 - l)]];
  }
  if (y < 1.12) { const t = sstep(0.97, 1.12, y); return [[B.hips, 1 - t], [B.spine, t]]; }
  if (y < 1.3) { const t = sstep(1.12, 1.3, y); return [[B.spine, 1 - t], [B.chest, t]]; }
  if (y < 1.45) return [[B.chest, 1]];
  const t = sstep(1.45, 1.5, y);
  return [[B.chest, 1 - t * 0.5], [B.neck, t * 0.5]];
}

function bodyParts(S, F) {
  const P = [];
  P.push(lathe(TORSO.map(([y, w, d, db, n, v], i) => {
    if (i < 3) { const [kw, kd, kdb] = torsoScale(0.79, S); return { y, w: w * kw, d: d * kd, db: db * kdb, n, v }; }
    const R = torsoRing(y, S); return { y, w: R.w, d: R.d, db: R.db, n, v };
  }), { seg: 24, reg: REG.torso, bones: torsoWeights }));
  // a rolled collar round the neck
  if (S.collar) {
    const prof = [[1.448, 0.0], [1.462, 0.6], [1.48, 1.0], [1.498, 0.85], [1.508, 0.4], [1.506, 0.0]];
    P.push(lathe(prof.map(([y, k], i) => ({ y, w: 0.082 + 0.03 * k, d: 0.078 + 0.026 * k, db: 0.08 + 0.03 * k, n: 2.1, cx: -0.006, v: 1 - i / (prof.length - 1) })), {
      seg: 18, reg: REG.collar, bones: p => { const t = sstep(1.46, 1.51, p[1]); return [[B.chest, 1 - t * 0.5], [B.neck, t * 0.5]]; },
    }));
  }
  if (S.belt) P.push(...beltParts(S));
  if (S.skirt) P.push(...skirtParts(S));
  if (S.apron) P.push(...apronParts(S));
  if (S.pack) P.push(...packParts(S));
  if (S.chain) P.push(...chainParts(S));
  for (const s of [-1, 1]) { P.push(...armParts(S, F, s)); P.push(...legParts(S, F, s)); }
  if (S.pauldrons === 'both') for (const s of [-1, 1]) P.push(...pauldron(S, F, s, F.fem ? 0.88 : 1));
  return P;
}

function beltParts(S) {
  const P = [];
  const player = S.outfit === 'player';
  const by0 = player ? 0.94 : 0.968, by1 = player ? 1.04 : 1.02, off = player ? 0.026 : 0.01;
  P.push(surf((u, v) => {
    const th = thOf(u), y = by0 + (by1 - by0) * v;
    const r = torsoRing(Math.max(0.955, y), S), [x, z] = ringXZ(th, r.w + off + 0.004 * Math.sin(v * Math.PI), r.d + off + 0.004 * Math.sin(v * Math.PI), r.db + off, r.n);
    return [x, y, z];
  }, 28, 3, { reg: REG.belt, uv: (u, v) => [u, 0.52 + v * 0.46], bones: p => p[1] > 1.0 ? [[B.hips, 0.7], [B.spine, 0.3]] : [[B.hips, 1]], closed: true, inside: () => [0, 1, 0] }));
  // the buckle: a chunky brass plate
  const fr = torsoRing(0.99, S), bh = player ? 0.082 : 0.046, bw = player ? 0.05 : 0.03;
  const ys = [-0.52, -0.48, -0.25, 0.25, 0.48, 0.52], ks = [0, 0.92, 1, 1, 0.92, 0];
  P.push(lathe(ks.map((k, i) => ({ y: ys[i] * bh, w: bw * k, d: 0.011 * k, db: 0.004 * k, n: 4, v: i / 5 })),
    { seg: 10, reg: REG.metal, uv: (u, v) => [u, 0.55 + v * 0.42], bones: B.hips, xf: p => [fr.d + off + 0.006 + p[0], 0.99 + p[1], p[2]] }));
  if (player) {
    // a pouch on the right hip and a smaller one round the back on the left
    for (const [th, sc] of [[1.05, 1], [-2.3, 0.75]]) {
      const pr = torsoRing(0.95, S), [px, pz] = ringXZ(th, pr.w + off, pr.d + off, pr.db + off, pr.n);
      const c = Math.cos(th), s = Math.sin(th);
      P.push(lathe([0, 0.85, 1, 1, 0.92, 0].map((k, i) => ({ y: (0.5 - i / 5) * 0.09 * sc, w: 0.052 * k * sc, d: 0.028 * k * sc, db: 0.01 * k * sc, n: 3, v: 1 - i / 5 })), {
        seg: 10, reg: REG.belt, uv: (u, v) => [u, v * 0.48], bones: p => [[B.hips, 0.6], [s > 0 ? B.legR : B.legL, 0.4]],
        xf: p => [px + p[0] * c - p[2] * s, 0.935 + p[1], pz + p[0] * s + p[2] * c],
      }));
    }
  }
  return P;
}

// The jerkin skirt (four leather panels) and the tabard flaps hanging over it.
// The side panels ride their thighs; the front and back ride flapF / flapB.
const SKIRT_TOP = 1.0;
function skirtOff(pn, y) {
  const t = (SKIRT_TOP - y) / (SKIRT_TOP - pn.hem);
  return pn.off + pn.flare * Math.pow(clamp01(t), 1.4) + 0.025 * Math.max(0, t - 1);
}
function skirtParts(S) {
  const P = [];
  const panels = [
    { th0: 0, half: 0.98, off: 0.016, hem: 0.63, flare: 0.06, bone: B.flapF, q: 0 },
    { th0: Math.PI / 2, half: 0.8, off: 0.008, hem: 0.65, flare: 0.07, bone: B.legR, q: 1 },
    { th0: Math.PI, half: 0.98, off: 0.016, hem: 0.63, flare: 0.06, bone: B.flapB, q: 2 },
    { th0: -Math.PI / 2, half: 0.8, off: 0.008, hem: 0.65, flare: 0.07, bone: B.legL, q: 3 },
  ];
  const ringAt = (th, y, off) => { const R = torsoRing(Math.max(0.79, Math.min(SKIRT_TOP, y)), S); return ringXZ(th, R.w + off, R.d + off, R.db + off, R.n); };
  for (const pn of panels) {
    const yOf = v => pn.hem + (SKIRT_TOP - pn.hem) * v;
    P.push(...slab((u, v) => {
      const th = pn.th0 + (u - 0.5) * 2 * pn.half, y = yOf(v);
      const [x, z] = ringAt(th, y, skirtOff(pn, y));
      return [x, y, z];
    }, 10, 5, 0.01, {
      reg: REG.skirt, uv: (u, v) => [(pn.q + 0.02 + u * 0.96) / 4, skirtV(yOf(v))],
      bones: p => { const t = sstep(0.97, 0.86, p[1]); return [[B.hips, 1 - t], [pn.bone, t]]; },
      inside: (u, v) => [0, yOf(v), 0],
    }));
  }
  // tabard flaps, front and back
  for (const back of [false, true]) {
    const pn = panels[back ? 2 : 0], hem = 0.5, top = 1.01;
    const yOf = v => hem + (top - hem) * v;
    P.push(...slab((u, v) => {
      const th = pn.th0 + (u - 0.5) * 2 * 0.5, y = yOf(v);
      const tuck = sstep(0.975, 1.005, y) * 0.016;     // tucked under the belt at the top
      const [x, z] = ringAt(th, y, skirtOff(pn, y) + 0.01 - tuck);
      return [x * (1 - 0.06 * (1 - Math.abs(Math.cos(th)))), y, z * 0.94];
    }, 6, 8, 0.008, {
      reg: back ? REG.flapB : REG.flap, uv: (u, v) => [back ? u : 1 - u, v],
      bones: p => { const t = sstep(0.985, 0.88, p[1]); return [[B.hips, 1 - t], [pn.bone, t]]; },
      inside: (u, v) => [0, yOf(v), 0],
    }));
  }
  return P;
}

// Ed's leather shop apron: hangs from the chest to the knees
function apronParts(S) {
  return slab((u, v) => {
    const y = 0.48 + 0.82 * v, th = (u - 0.5) * 1.75;
    const yy = Math.max(0.79, y);
    const r = torsoRing(yy, S), [x, z] = ringXZ(th, r.w, r.d, r.db, r.n);
    const flare = y < 0.79 ? (0.79 - y) * 0.2 : 0;
    return [x + 0.014 + flare, y, z * (1 + flare * 1.5)];
  }, 10, 10, 0.008, {
    reg: ACC, uv: (u, v) => [u, v], inside: (u, v) => [0, 0.48 + 0.82 * v, 0],
    bones: p => { if (p[1] > 0.955) return torsoWeights(p); const t = sstep(0.95, 0.8, p[1]); return [[B.hips, 1 - t], [B.flapF, t]]; },
  });
}

// A rolled bedroll strapped across the small of the back.
function packParts(S) {
  const R = torsoRing(1.12, S), cx = -(R.db + 0.062), cy = 1.115;
  const rings = [0, 0.75, 0.97, 1, 1, 0.97, 0.75, 0].map((k, i, a) => {
    const t = i / (a.length - 1);
    return { y: (t - 0.5) * 0.44 * (k === 0 ? 0.96 : 1), w: 0.064 * (0.4 + 0.6 * k), d: 0.068 * (0.4 + 0.6 * k), v: k < 0.9 ? 0.2 : 0.4 + 0.6 * t };
  });
  return [lathe(rings, {
    seg: 14, reg: REG.pack, uv: (u, v) => [u, v < 0.3 ? v : 0.4 + (v - 0.4) * 1.0], bones: p => [[B.spine, 0.7], [B.hips, 0.3]],
    xf: p => [cx + p[0], cy + p[2] * 0.95, p[1]],
  })];
}

// The Repo Man's tow chain, worn like a bandolier over his right shoulder.
function chainParts(S) {
  const path = v => {
    const th = v * TAU, y = 1.21 + 0.24 * Math.sin(th);
    const R = torsoRing(Math.min(1.44, y), S), [x, z] = ringXZ(th, R.w + 0.026, R.d + 0.026, R.db + 0.026, R.n);
    return [x, y, z];
  };
  return [tube(path, () => 0.024, 8, 40, { reg: REG.gear, uv: (u, v) => [u, ((v * 9) % 1) * 0.58], ref: [0, 1, 0], bones: p => p[1] > 1.3 ? [[B.chest, 1]] : p[1] > 1.1 ? [[B.chest, 0.5], [B.spine, 0.5]] : [[B.spine, 0.4], [B.hips, 0.6]] })];
}

const ARM_UP = [   // dy below the shoulder joint, half-width across (z), front, back
  [0.075, 0.0, 0.0, 0.0],
  [0.062, 0.05, 0.056, 0.054],
  [0.038, 0.082, 0.086, 0.084],
  [-0.005, 0.092, 0.092, 0.088],
  [-0.07, 0.085, 0.083, 0.079],
  [-0.145, 0.079, 0.081, 0.073],
  [-0.22, 0.07, 0.072, 0.067],
  [-0.285, 0.064, 0.068, 0.065],
  [-0.33, 0.069, 0.074, 0.068],
  [-0.39, 0.064, 0.067, 0.06],
];
const ARM_GLOVE = [   // a flared gauntlet cuff down to the wrist
  [-0.413, 0.061, 0.064, 0.059],
  [-0.417, 0.084, 0.088, 0.084],
  [-0.432, 0.088, 0.092, 0.087],
  [-0.49, 0.07, 0.075, 0.07],
  [-0.548, 0.054, 0.06, 0.054],
];
const ARM_BARE = [
  [-0.45, 0.056, 0.06, 0.054],
  [-0.51, 0.047, 0.051, 0.046],
  [-0.548, 0.043, 0.048, 0.043],
];
const HAND = [   // hanging hand: thin across z (palm faces the leg), wide front to back
  [-0.575, 0.036, 0.06, 0.058],
  [-0.615, 0.04, 0.068, 0.064],
  [-0.66, 0.038, 0.07, 0.064],
  [-0.705, 0.034, 0.064, 0.058],
  [-0.74, 0.026, 0.05, 0.044],
  [-0.76, 0.0, 0.0, 0.0],
];
function armParts(S, F, s) {
  const [ua, fa, ha] = ARM(s), sh = F.shoulder(s);
  const bare = S.hands === 'bare';
  const hk = bare ? 0.9 : S.hands === 'workglove' ? 1.14 : 1.06;
  const ak = (S.armBulk || 1) * (S.bulk || 1) * (F.fem ? 0.86 : 1);
  const rolled = S.arms === 'rolled';
  const tab = [
    ...ARM_UP.map(([dy, w, d, db]) => { const roll = rolled ? 0.014 * gauss(dy + 0.255, 0.014) : 0; return [dy, w * ak + roll, d * ak + roll, db * ak + roll]; }),
    ...(bare ? ARM_BARE : ARM_GLOVE).map(([dy, w, d, db]) => [dy, w * (bare ? ak : 1), d * (bare ? ak : 1), db * (bare ? ak : 1)]),
    ...HAND.map(([dy, w, d, db]) => [dy, w * hk * (F.fem ? 0.9 : 1), d * hk * (F.fem ? 0.9 : 1), db * hk * (F.fem ? 0.9 : 1)]),
  ];
  const rings = tab.map(([dy, w, d, db]) => {
    const curl = dy < -0.64 ? (-0.64 - dy) / 0.12 : 0;
    return { y: dy, w, d, db, n: dy < -0.56 ? 2.6 : 2, cx: 0.008 * curl, cz: -0.02 * curl * curl, v: armV(dy) };
  });
  const wts = p => {
    const dy = p[1] - sh[1];
    if (dy > -0.25) return [[ua, 1]];
    if (dy > -0.33) { const t = sstep(-0.25, -0.33, dy); return [[ua, 1 - t], [fa, t]]; }
    if (dy > -0.535) return [[fa, 1]];
    if (dy > -0.575) { const t = sstep(-0.535, -0.575, dy); return [[fa, 1 - t], [ha, t]]; }
    return [[ha, 1]];
  };
  const P = [lathe(rings, { seg: 14, reg: REG.arm, bones: wts, xf: p => [sh[0] + p[0], sh[1] + p[1], sh[2] + p[2] * s] })];
  // the thumb (front, toward the body)
  const k = hk * (F.fem ? 0.9 : 1);
  const T = (x, dy, zin) => [sh[0] + x * k, sh[1] - 0.548 + (dy + 0.548) * k, sh[2] - s * zin * k];
  const path = bez(T(0.022, -0.57, 0.008), T(0.056, -0.595, 0.022), T(0.07, -0.635, 0.026), T(0.062, -0.668, 0.019));
  P.push(tube(path, v => (0.021 - 0.005 * v) * k * Math.sqrt(Math.sin(Math.min(1, 0.15 + v * 0.85) * Math.PI)), 8, 6, { reg: REG.arm, uv: (u, v) => [0.4 + u * 0.2, armV(-0.6) - v * 0.1], ref: [0, 0, 1], bones: ha }));
  return P;
}

const LEG_TOP = [   // y, half-width, front, back
  [0.99, 0.0, 0.0, 0.0],
  [0.97, 0.085, 0.09, 0.09],
  [0.91, 0.114, 0.118, 0.114],
  [0.80, 0.11, 0.114, 0.11],
  [0.68, 0.1, 0.102, 0.098],
  [0.575, 0.09, 0.092, 0.088],
  [0.51, 0.084, 0.09, 0.082],
];
const LEG_TALL = [   // a knee boot with a turned-down cuff
  [0.49, 0.082, 0.088, 0.081],
  [0.482, 0.105, 0.111, 0.105],
  [0.455, 0.11, 0.116, 0.11],
  [0.41, 0.105, 0.111, 0.105],
  [0.4, 0.09, 0.096, 0.092],
  [0.33, 0.09, 0.096, 0.094],
  [0.22, 0.08, 0.086, 0.082],
  [0.14, 0.076, 0.082, 0.078],
  [0.085, 0.072, 0.076, 0.072],
  [0.06, 0.05, 0.05, 0.05],
  [0.05, 0.0, 0.0, 0.0],
];
const LEG_PLAIN = [
  [0.44, 0.074, 0.078, 0.076],
  [0.33, 0.072, 0.076, 0.074],
  [0.22, 0.065, 0.069, 0.067],
  [0.13, 0.061, 0.065, 0.063],
  [0.07, 0.05, 0.05, 0.05],
  [0.05, 0.0, 0.0, 0.0],
];
const FOOT = [ // x, half-width, up, down, center y, squareness, v
  [-0.095, 0.0, 0.0, 0.0, 0.055, 2, 0.0],
  [-0.086, 0.05, 0.046, 0.05, 0.055, 2.4, 0.05],
  [-0.056, 0.062, 0.066, 0.054, 0.06, 2.6, 0.16],
  [0.0, 0.066, 0.082, 0.06, 0.066, 2.6, 0.33],
  [0.06, 0.07, 0.064, 0.053, 0.053, 2.7, 0.52],
  [0.13, 0.074, 0.052, 0.048, 0.048, 2.8, 0.70],
  [0.195, 0.07, 0.047, 0.043, 0.045, 2.8, 0.86],
  [0.234, 0.054, 0.039, 0.036, 0.044, 2.5, 0.95],
  [0.248, 0.0, 0.0, 0.0, 0.047, 2, 1.0],
];
function legParts(S, F, s) {
  const [th, sn, ft] = LEG(s), hip = F.hip(s), knee = F.knee(s), ank = F.ankle(s);
  const tall = S.boots === 'tall', shoe = S.boots === 'shoe';
  const lk = (F.fem ? 0.9 : 1) * (S.bulk ? 1 + (S.bulk - 1) * 0.6 : 1);
  const axis = y => {
    const a = y > knee[1] ? [knee, hip] : [ank, knee], t = (y - a[0][1]) / (a[1][1] - a[0][1]);
    return [a[0][0] + (a[1][0] - a[0][0]) * t, a[0][2] + (a[1][2] - a[0][2]) * t];
  };
  const tab = [...LEG_TOP, ...(tall ? LEG_TALL : LEG_PLAIN)];
  const wts = p => {
    const y = p[1];
    if (y > 0.56) return [[th, 1]];
    if (y > 0.44) { const t = sstep(0.56, 0.44, y); return [[th, 1 - t], [sn, t]]; }
    if (y > 0.13) return [[sn, 1]];
    const t = sstep(0.13, 0.07, y); return [[sn, 1 - t], [ft, t]];
  };
  const P = [lathe(tab.map(([y, w, d, db]) => { const [ax, az] = axis(y); return { y, w: w * lk, d: d * lk, db: db * lk, cx: ax, cz: az * s, v: y }; }), { seg: 14, reg: REG.leg, bones: wts, xf: p => [p[0], p[1], p[2] * s] })];
  const k = shoe ? [0.86, 0.8, 0.92] : S.outfit === 'repo' ? [1.06, 1.05, 1.04] : F.fem ? [0.9, 0.92, 0.9] : [1, 1, 1];
  const nv = FOOT.length - 1;
  P.push(surf((u, v) => {
    const i = Math.round(v * nv), [x, w, up, dn, cy, n] = FOOT[i];
    const [a, b] = ringXZ(thOf(u), w * k[0], up * k[1], dn, n);
    const X = x * k[2];
    return [X, Math.max(0.002, cy * (shoe ? 0.85 : 1) + a), s * (Math.abs(ank[2]) + b + 0.05 * Math.max(0, X))];
  }, 14, nv, { reg: REG.foot, uv: (u, v) => [u, FOOT[Math.round(v * nv)][6]], bones: p => p[0] < -0.03 && p[1] > 0.09 ? [[ft, 0.7], [sn, 0.3]] : [[ft, 1]], closed: true, inside: (u, v) => { const r = FOOT[Math.round(v * nv)]; return [r[0] * k[2], r[4], ank[2]]; } }));
  return P;
}

// A big domed pauldron with a rolled rim and a second lame hanging off the outside.
function pauldron(S, F, s, size) {
  const [ua] = ARM(s), sh = F.shoulder(s);
  const R = 0.138 * size, tilt = 0.6, fmax = 1.42;
  const A = [0, Math.cos(tilt), s * Math.sin(tilt)], E1 = [1, 0, 0];
  const E2 = [A[1] * E1[2] - A[2] * E1[1], A[2] * E1[0] - A[0] * E1[2], A[0] * E1[1] - A[1] * E1[0]];
  const Cc = [sh[0] - 0.006, sh[1] + 0.02 * size, sh[2] - s * 0.006];
  const dir = (th, f) => { const c = Math.cos(th), sn = Math.sin(th), sf = Math.sin(f), cf = Math.cos(f); return [0, 1, 2].map(k => A[k] * cf * 0.74 + (E1[k] * c + E2[k] * sn) * sf); };
  const pt = (th, f, rr) => { const d = dir(th, f); return [Cc[0] + d[0] * rr, Cc[1] + d[1] * rr, Cc[2] + d[2] * rr]; };
  const P = [];
  P.push(...slab((u, v) => {
    const th = thOf(u), f = (1 - v) * fmax;
    const lip = 1 + 0.075 * gauss(v, 0.07);
    return pt(th, f, R * lip * (1 + 0.05 * Math.cos(th)));
  }, 18, 7, 0.014, { reg: REG.paul, uv: (u, v) => [u, 0.32 + v * 0.68], bones: ua, closed: true, inside: () => Cc, uvInner: (a, b) => [a, b - 0.25] }));
  const out = [0, -0.25, s]; const ol = Math.hypot(...out);
  const thOut = Math.atan2((out[0] * E2[0] + out[1] * E2[1] + out[2] * E2[2]) / ol, (out[0] * E1[0] + out[1] * E1[1] + out[2] * E1[2]) / ol);
  P.push(...slab((u, v) => {
    const th = thOut + (u - 0.5) * 3.2, f = fmax * (0.9 + 0.34 * (1 - v));
    return pt(th, f, R * 1.1);
  }, 12, 2, 0.012, { reg: REG.paul, uv: (u, v) => [u, v * 0.28], bones: ua, inside: () => Cc }));
  return P;
}

// ---- assembly ------------------------------------------------------------------------------

const geoCache = new Map();
function charGeometry(S, F) {
  const key = [S.outfit, S.hat, S.skin, S.look.hair, S.look.facial, S.look.female ? 'f' : 'm'].join('|');
  if (!geoCache.has(key)) {
    const parts = [...bodyParts(S, F), ...headParts(S)].map(g => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k); return g; });
    const geo = mergeGeometries(parts, false);
    geo.computeBoundingSphere();
    geoCache.set(key, geo);
  }
  return geoCache.get(key);
}
const charMats = new Map();
function charMaterial(S) {
  const name = charAtlas(S), glow = charGlow(S);
  if (!glow) return painted(name);
  if (!charMats.has(name)) {
    const m = new THREE.MeshLambertMaterial({ map: tex(name), emissive: new THREE.Color('#ffffff'), emissiveMap: tex(glow) });
    charMats.set(name, m);
  }
  return charMats.get(name);
}

function makeSkeleton(F) {
  const names = Object.keys(B);
  const bones = names.map(n => { const b = new THREE.Bone(); b.name = n; return b; });
  const by = Object.fromEntries(names.map((n, i) => [n, bones[i]]));
  by.body.add(by.hips); by.hips.position.set(0, J.hips, 0);
  by.hips.add(by.spine); by.spine.position.set(0, J.spine - J.hips, 0);
  by.spine.add(by.chest); by.chest.position.set(0, J.chest - J.spine, 0);
  by.chest.add(by.neck); by.neck.position.set(0, J.neck - J.chest, 0);
  by.neck.add(by.head); by.head.position.set(0, J.head - J.neck, 0); by.head.scale.setScalar(HU);
  for (const [s, a, f, h] of [[-1, by.armL, by.foreL, by.handL], [1, by.armR, by.foreR, by.handR]]) {
    const sh = F.shoulder(s);
    by.chest.add(a); a.position.set(sh[0], sh[1] - J.chest, sh[2]);
    a.add(f); f.position.set(0, -J.upper, 0.004 * s);
    f.add(h); h.position.set(0, -J.fore, 0);
  }
  for (const [s, l, sn, ft] of [[-1, by.legL, by.shinL, by.footL], [1, by.legR, by.shinR, by.footR]]) {
    const hip = F.hip(s), knee = F.knee(s), ank = F.ankle(s);
    by.hips.add(l); l.position.set(hip[0], hip[1] - J.hips, hip[2]);
    l.add(sn); sn.position.set(knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2]);
    sn.add(ft); ft.position.set(ank[0] - knee[0], ank[1] - knee[1], ank[2] - knee[2]);
  }
  for (const f of [by.flapF, by.flapB]) { by.hips.add(f); f.position.set(0, J.hipY - J.hips, 0); }
  return bones;
}

// Root at the feet. Inner model faces local +x; root.rotation.y = -PI/2 turns it to face +z.
// opts.outfit: 'player' | 'ed' | 'clerk' | 'dealer' | 'repo' (inferred from the old call
// signatures in town3d.js when absent).
export function buildCharacter(color, { hatIndex = 0, skinIndex = 0, scale = 1, eyeColor = null, outfit = null } = {}) {
  const spec = resolveSpec(color, { hatIndex, skinIndex, scale, eyeColor, outfit });
  const F = frameOf(spec);
  const bones = makeSkeleton(F);
  const [body] = bones;
  const mesh = new THREE.SkinnedMesh(charGeometry(spec, F), charMaterial(spec));
  mesh.add(body);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  body.scale.setScalar(scale);
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0 * scale, 0), 1.5 * scale);
  mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-0.5, 0, -0.5).multiplyScalar(scale), new THREE.Vector3(0.5, 2.1, 0.5).multiplyScalar(scale));
  const root = new THREE.Group();
  root.add(mesh);
  root.rotation.y = -Math.PI / 2;
  root.userData.body = body;
  const inner = new THREE.Group();
  inner.add(root);
  const byName = Object.fromEntries(Object.keys(B).map((k, i) => [k, bones[i]]));
  const ch = { root: inner, body, legL: byName.legL, legR: byName.legR, armL: byName.armL, armR: byName.armR, torso: byName.spine, head: byName.head, bones: byName, mesh, spec, frame: F, driven: false, seed: (hatIndex * 7 + skinIndex * 3 + (spec.outfit.length)) };
  applyPose(ch, idlePose(ch, 0));
  // NPCs (nobody drives them) idle on their own: breathing, weight shifts, a look around.
  mesh.onBeforeRender = () => { if (!ch.driven) { const t = performance.now() / 1000; if (t - (ch.idleT || 0) > 1 / 40) { ch.idleT = t; applyPose(ch, idlePose(ch, t)); } } };
  return ch;
}

// ---- posing --------------------------------------------------------------------------------

const POSE_KEYS = ['lL', 'lR', 'kL', 'kR', 'fL', 'fR', 'aL', 'aR', 'eL', 'eR', 'inL', 'inR', 'abL', 'abR', 'lean', 'bend', 'tw', 'ctw', 'head', 'headY', 'bob', 'spread', 'roll', 'wristL', 'wristR'];
function restPose() { const P = {}; for (const k of POSE_KEYS) P[k] = 0; P.abL = P.abR = 0.13; P.eL = P.eR = 0.22; P.inL = P.inR = 0.05; return P; }
// NPC stances: the Repo Man stands hands-on-hips, the Dealer deals, Ed leans on his counter
const STANCE = {
  repo: { abL: 0.62, abR: 0.62, aL: -0.42, aR: -0.42, eL: 1.25, eR: 1.25, inL: 0.95, inR: 0.95, wristL: 0.3, wristR: 0.3, spread: 0.1, bend: 0.04, head: -0.08 },
  dealer: { aL: 0.42, aR: 0.48, eL: 0.8, eR: 0.75, inL: 0.25, inR: 0.3, bend: -0.06, head: 0.18 },
  ed: { aL: 0.35, aR: 0.35, eL: 1.05, eR: 1.05, inL: 0.75, inR: 0.75, abL: 0.18, abR: 0.18, bend: -0.04 },
  clerk: { aL: 0.1, aR: 0.12, eL: 0.5, eR: 0.45, inL: 0.5, inR: 0.45, abL: 0.08, abR: 0.08 },
};
function idlePose(ch, t) {
  const P = { ...restPose(), ...(STANCE[ch.spec.outfit] || {}) }, k = ch.seed;
  const br = Math.sin(t * 1.7 + k);
  P.bend += -0.015 - br * 0.012;
  P.abL += br * 0.015; P.abR += br * 0.015;
  P.aL += 0.03 * Math.sin(t * 0.6 + k); P.aR += 0.03 * Math.sin(t * 0.7 + k * 2);
  P.headY = 0.35 * Math.sin(t * 0.23 + k) * Math.max(0, Math.sin(t * 0.11 + k * 3));
  P.head += 0.04 * Math.sin(t * 0.4 + k);
  const shift = Math.sin(t * 0.3 + k * 5);
  P.roll = shift * 0.025; P.spread = Math.max(P.spread, 0.03);
  return P;
}
function applyPose(ch, P) {
  const b = ch.bones;
  b.legL.rotation.set(P.spread + P.roll, 0, P.lL);
  b.legR.rotation.set(-P.spread + P.roll, 0, P.lR);
  b.shinL.rotation.set(0, 0, P.kL); b.shinR.rotation.set(0, 0, P.kR);
  b.footL.rotation.set(-P.roll, 0, P.fL); b.footR.rotation.set(-P.roll, 0, P.fR);
  b.armL.rotation.set(P.abL, 0, P.aL); b.armR.rotation.set(-P.abR, 0, P.aR);
  b.foreL.rotation.set(-P.inL, 0, P.eL); b.foreR.rotation.set(P.inR, 0, P.eR);
  b.handL.rotation.set(0, 0, P.wristL); b.handR.rotation.set(0, 0, P.wristR);
  b.hips.position.y = J.hips + P.bob;
  b.hips.rotation.set(-P.roll, P.tw * 0.5, 0);
  b.spine.rotation.set(P.roll * 0.6, P.tw * 0.5, P.bend * 0.5);
  b.chest.rotation.set(P.roll * 0.4, P.ctw, P.bend * 0.5);
  b.neck.rotation.set(0, P.headY * 0.4, P.head * 0.35);
  b.head.rotation.set(0, P.headY * 0.6, P.head * 0.65);
  // the skirt front follows the forward-most thigh, the back the back-most one
  b.flapF.rotation.set(0, 0, Math.max(0, P.lL, P.lR) * 0.96);
  b.flapB.rotation.set(0, 0, Math.min(0, P.lL, P.lR) * 0.96);
  ch.body.rotation.z = -P.lean;
}

// Knee angle that puts the foot back on the ground, given a thigh angle and how far the hips dropped.
function kneeFor(thigh, drop) {
  const L1 = J.thigh, L2 = J.shin, hipY = J.hipY + drop;
  const ky = hipY - Math.cos(thigh) * L1;
  const a = Math.acos(Math.max(-1, Math.min(1, ky / L2)));
  return Math.min(0, -a - thigh);
}

// The target pose for a player state. st: {mode, flags, pitch}; m: {t, ph, speed, id, emote}
function playerPose(st, m) {
  const M = C.MODE, F = C.FLAG, t = m.t, ph = m.ph, speed = m.speed, id = m.id;
  const T = restPose();
  let tip = 0, drop = 0, spin = 0;
  T.head = -st.pitch * 0.6;
  const br = Math.sin(t * 1.8 + id);
  if (st.mode === M.KO) {
    // flat on his back, one knee up, arms flung out, head lolling
    tip = Math.PI / 2 - 0.04;
    T.lL = 0.55 + Math.sin(t * 3 + id) * 0.08; T.kL = -1.0; T.fL = 0.35; T.lR = 0.08; T.kR = -0.12;
    T.aL = 0.5; T.aR = 0.15; T.abL = 1.15; T.abR = 0.9; T.eL = 0.7; T.eR = 0.35; T.head = 0.3; T.headY = 0.55 * Math.sin(t * 0.7 + id); T.spread = 0.2;
  } else if (st.mode === M.SEAT) {
    drop = -0.4;
    T.lL = T.lR = 1.5; T.kL = T.kR = kneeFor(1.5, drop); T.fL = T.fR = -T.lL - T.kL;
    T.aL = T.aR = 0.8; T.eL = T.eR = 0.85; T.inL = T.inR = 0.3; T.head = -st.pitch * 0.4; T.spread = 0.08; T.bend = 0.05;
  } else if (st.mode === M.CLIMB) {
    const c = Math.sin(t * 5 + id);
    T.aL = 2.75 + c * 0.35; T.aR = 2.75 - c * 0.35; T.eL = 0.35 - c * 0.25; T.eR = 0.35 + c * 0.25; T.abL = T.abR = 0.22;
    T.lL = 0.55 + c * 0.4; T.lR = 0.55 - c * 0.4; T.kL = -0.9 - c * 0.4; T.kR = -0.9 + c * 0.4; T.lean = 0.1; T.head = -0.35;
  } else if (st.mode === M.AIR) {
    T.lL = 0.75; T.lR = -0.2; T.kL = -1.15; T.kR = -0.5; T.fL = 0.3; T.aL = 1.5; T.aR = 1.1; T.abL = T.abR = 0.5; T.eL = T.eR = 0.55; T.lean = 0.06;
  } else {
    // walk / run cycle: thigh swing, knee lift on the swing phase, toe-off, hip bob and
    // sway, counter-swinging arms with bent elbows, a twist through the spine
    const sprint = !!(st.flags & F.SPRINT);
    const g = Math.min(1, speed * 1.6);
    const A = (0.44 + 0.22 * speed) * g;
    for (const [side, off] of [['L', 0], ['R', Math.PI]]) {
      const p = ph + off, sn = Math.sin(p), cs = Math.cos(p);
      T['l' + side] = A * sn;
      T['k' + side] = -g * ((0.3 + 0.8 * speed) * Math.max(0, cs) ** 1.3 + 0.08);
      T['f' + side] = g * (0.35 * Math.max(0, -sn) * Math.max(0, cs) - 0.12 * Math.max(0, sn));
      const o = side === 'L' ? 'R' : 'L';
      T['a' + o] = A * sn * (sprint ? 1.3 : 0.85);
      T['e' + o] = 0.3 + (sprint ? 1.1 : 0.45) * g + 0.3 * g * Math.max(0, sn);
    }
    T.bob = g * (0.024 + 0.012 * speed) * Math.cos(2 * ph) - 0.014 * g;
    T.tw = 0.12 * g * Math.sin(ph); T.ctw = -0.16 * g * Math.sin(ph);
    T.roll += 0.035 * g * Math.sin(ph);
    T.bend = -(sprint ? 0.22 : 0.07) * g; T.lean = (sprint ? 0.09 : 0.03) * g;
    T.abL += 0.06 * g; T.abR += 0.06 * g;
    // idle on top: breathing + a slow weight shift
    T.bend += -0.012 - br * 0.012 * (1 - g);
    T.abL += br * 0.015 * (1 - g); T.abR += br * 0.015 * (1 - g);
    T.roll += 0.025 * Math.sin(t * 0.35 + id * 2) * (1 - g);
    if (st.flags & F.CROUCH) {
      drop = -0.3;
      T.lL += 1.0; T.lR += 1.0; T.kL = kneeFor(T.lL, drop) + T.kL * 0.3; T.kR = kneeFor(T.lR, drop) + T.kR * 0.3;
      T.fL = -T.lL - T.kL; T.fR = -T.lR - T.kR; T.bend -= 0.45; T.lean += 0.05; T.aL += 0.35; T.aR += 0.35; T.eL += 0.4; T.eR += 0.4; T.head += 0.25;
    }
  }
  if ((st.flags & F.HOLDING) && st.mode !== M.KO && st.mode !== M.CLIMB) {
    const map = st.flags & F.MAP;
    // carrying: forearms forward under the load; the map: held up in front, head down
    T.aL = T.aR = map ? 0.55 : 0.7; T.eL = T.eR = map ? 1.15 : 0.95; T.abL = T.abR = map ? 0.12 : 0.24; T.inL = T.inR = map ? 0.35 : 0.42;
    T.wristL = T.wristR = map ? 0.3 : 0.2;
    if (map) T.head = Math.max(T.head, 0.35);
    else T.bend -= 0.05;
  }
  const e = m.emote;
  if (e) {
    if (e === '😂') { T.aL = 2.5 + Math.sin(t * 14) * 0.3; T.aR = 2.5 - Math.sin(t * 14) * 0.3; T.eL = T.eR = 0.6; T.bend = 0.15; T.head = -0.4; drop = Math.abs(Math.sin(t * 14)) * 0.06; }
    else if (e === '😭') { T.aL = 0.9; T.aR = 0.9; T.eL = T.eR = 2.0; T.inL = T.inR = 0.5; T.abL = T.abR = 0.25; T.head = 0.7; T.bend = -0.35; T.headY = Math.sin(t * 6) * 0.15; }
    else if (e === '💀') { tip = Math.PI / 2 - 0.06; T.aL = Math.sin(t * 19) * 1.6; T.aR = -T.aL; T.abL = T.abR = 0.8; T.lL = Math.sin(t * 17) * 0.4; T.lR = -T.lL; }
    else if (e === '🤬') { T.aL = 2.3 + Math.sin(t * 22) * 0.6; T.aR = 2.3 - Math.sin(t * 22) * 0.6; T.eL = T.eR = 0.8; T.lL = Math.sin(t * 19) * 0.8; T.lR = -T.lL; T.kL = T.kR = -0.5; T.bend = -0.15; }
    else if (e === '👑') { T.aL = 2.9; T.aR = 2.9; T.abL = T.abR = 0.5; T.eL = T.eR = 0.15; T.lean = -0.08; T.bend = 0.2; T.head = -0.35; }
    else { spin = 12; T.abL = T.abR = 1.3; T.eL = T.eR = 0.2; }
  }
  return { T, tip, drop: drop + (st.mode === M.KO ? 0.17 : 0), spin };
}

// ---- other players --------------------------------------------------------------------------

const spring = (s, target, dt, k = 170, d = 11) => { s.v += (target - s.a) * k * dt; s.v *= Math.max(0, 1 - d * dt); s.a += s.v * dt; return s.a; };

export class PlayerView {
  constructor(scene, p) {
    this.id = p.id;
    this.group = new THREE.Group();
    this.ch = buildCharacter(p.color, { hatIndex: p.id % 6, skinIndex: (p.id * 7) % 6 });
    this.ch.driven = true;
    this.ch.root.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.tilt = new THREE.Group();
    this.tilt.add(this.ch.root);
    this.group.add(this.tilt);
    this.label = labelSprite(p.name, labelColor(p.color), 40);
    this.label.position.y = 2.25;
    this.group.add(this.label);
    this.mic = labelSprite('🔊', '#fff', 60);
    this.mic.scale.set(0.9, 0.45, 1);
    this.mic.position.y = 2.65;
    this.mic.visible = false;
    this.group.add(this.mic);
    this.walkie = labelSprite('📻', '#fff', 60);
    this.walkie.scale.set(0.9, 0.45, 1);
    this.walkie.position.y = 2.65;
    this.walkie.visible = false;
    this.group.add(this.walkie);
    this.phase = 0;
    this.s = {};
    this.P = restPose();
    this.prev = null;
    this.vel = 0;
    this.emote = null;
    scene.add(this.group);
  }

  setName(name, color) { this.label.userData.set(name, labelColor(color)); }

  dispose(scene) { scene.remove(this.group); }

  sp(key, target, dt, k = 170, d = 11) { const s = this.s[key] || (this.s[key] = { a: target, v: 0 }); return spring(s, target, dt, k, d); }

  update(dt, t, st) {
    // st: {pos, yaw, pitch, mode, flags, speaking, walkieTx}
    this.group.position.set(st.pos.x, st.pos.y, st.pos.z);
    this.group.rotation.y = st.yaw;
    let v = this.prev ? Math.hypot(st.pos.x - this.prev.x, st.pos.z - this.prev.z) / Math.max(dt, 1e-3) : 0;
    if (v > 25) v = 0;   // teleports
    this.prev = { ...st.pos };
    this.vel += (v - this.vel) * Math.min(1, dt * 10);
    v = this.vel;
    const speed = Math.min(1.4, v / 4.4);
    // one stride (two steps) per ~1.5 m walked; a slow shuffle in place when barely moving
    this.phase += dt * (2.6 + v * 2.05);
    if (this.emote) { this.emote.t -= dt; if (this.emote.t <= 0) { this.emote = null; this.tilt.rotation.y = 0; } }
    const { T, tip, drop, spin } = playerPose(st, { t, ph: this.phase, speed, id: this.id, emote: this.emote?.e });
    if (spin) this.tilt.rotation.y += dt * spin;
    const P = this.P;
    for (const k of POSE_KEYS) {
      const arm = k[0] === 'a' || k[0] === 'e' || k[0] === 'i' || k[0] === 'w';
      const fast = k[0] === 'k' || k[0] === 'f' || k === 'bob';
      P[k] = this.sp(k, T[k], dt, arm ? 150 : fast ? 260 : 170, arm ? 9 : fast ? 16 : 11);
    }
    applyPose(this.ch, P);
    this.tilt.rotation.x = -this.sp('tip', tip, dt, 60, 7);
    this.tilt.position.y = this.sp('drop', drop, dt, 90, 9);
    this.mic.visible = !!st.speaking && !st.walkieTx;
    this.walkie.visible = !!st.walkieTx;
    if (this.mic.visible || this.walkie.visible) {
      const k = 0.9 + Math.sin(t * 10) * 0.08;
      (this.mic.visible ? this.mic : this.walkie).scale.set(k, k / 2, 1);
    }
    this.label.visible = st.mode !== C.MODE.KO || Math.sin(t * 4) > 0;
  }
}

// ---- first-person hands ----------------------------------------------------------------------
// Chunky stitched leather gauntlets with flared, riveted cuffs (trimmed in your color),
// a strap across the back of the hand, the sleeve in your color, built pointing down -z
// from the wrist (the mesh origin), back of the hand up, thumb on the inner side.

const FPA = [256, 256];
function fpHandGeometry(side) {
  const P = [];
  const k = 1.18;      // WoW-chunky
  const xf = (p) => [p[2] * k, p[0] * k, p[1] * k];        // lathe local (front, along, side) -> (x side, y up, z along)
  const seg = (rings, reg, n = 14) => lathe(rings, { seg: n, reg, atlas: FPA, xf });
  // the gauntlet cuff (flared, rolled rim), then the sleeve: lathes along +z (toward the camera)
  P.push(seg([[0.0, 0.044, 0.033, 0], [0.03, 0.05, 0.038, 0.2], [0.098, 0.066, 0.054, 0.75], [0.118, 0.076, 0.064, 0.92], [0.13, 0.074, 0.062, 1], [0.134, 0.058, 0.05, 1]].map(([y, w, d, v]) => ({ y, w, d, db: d * 1.05, v })), FP.cuff, 16));
  P.push(seg([[0.13, 0.058, 0.05, 0], [0.24, 0.06, 0.052, 1]].map(([y, w, d, v]) => ({ y, w, d, v })), FP.bracer));
  P.push(seg([[0.236, 0.064, 0.056, 0], [0.26, 0.068, 0.06, 0.12], [0.6, 0.074, 0.066, 1]].map(([y, w, d, v]) => ({ y, w, d, v })), FP.sleeve));
  // the hand: a flattened block down -z, back of the hand up
  P.push(seg([[0.016, 0.043, 0.031, 0], [-0.028, 0.051, 0.035, 0.35], [-0.078, 0.055, 0.032, 0.82], [-0.095, 0.051, 0.027, 0.94], [-0.103, 0.0, 0.0, 1]].map(([y, w, d, v]) => ({ y, w, d, db: d * 0.9, n: 2.8, v })), FP.palm, 16));
  // fingers, gently curled
  const fx = [-0.036, -0.012, 0.012, 0.035], len = [0.9, 1.0, 0.96, 0.8];
  fx.forEach((x, i) => {
    const L = len[i];
    const path = bez([x, 0.006, -0.086], [x, 0.004, -0.086 - 0.05 * L], [x * 1.05, -0.02, -0.086 - 0.08 * L], [x * 1.05, -0.046 * L, -0.086 - 0.074 * L]);
    P.push(tube(v => path(v).map(c => c * k), v => (0.0152 - 0.002 * v) * k * Math.pow(Math.sin(Math.min(1, 0.1 + v * 0.9) * Math.PI), 0.35), 8, 7, { reg: FP.finger, atlas: FPA, ref: [1, 0, 0] }));
  });
  const tp = bez([-0.038, -0.006, -0.01], [-0.068, -0.004, -0.04], [-0.072, -0.01, -0.076], [-0.06, -0.017, -0.098]);
  P.push(tube(v => tp(v).map(c => c * k), v => (0.0195 - 0.004 * v) * k * Math.pow(Math.sin(Math.min(1, 0.15 + v * 0.85) * Math.PI), 0.4), 8, 7, { reg: FP.thumb, atlas: FPA, ref: [0, 1, 0] }));
  const geo = mergeGeometries(P.map(g => { for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a); return g; }), false);
  if (side < 0) {   // mirror for the left hand
    geo.scale(-1, 1, 1);
    const I = geo.index.array;
    for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
    geo.index.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}

export class Hands {
  constructor(camera, color) {
    this.g = new THREE.Group();
    camera.add(this.g);
    this.color = color;
    const mat = painted(handsAtlas(color));
    this.L = new THREE.Mesh(fpHandGeometry(-1), mat);
    this.R = new THREE.Mesh(fpHandGeometry(1), mat);
    for (const h of [this.L, this.R]) { h.frustumCulled = false; h.renderOrder = 2; }
    this.L.userData.side = -1; this.R.userData.side = 1;
    this.L.position.set(-0.26, -0.4, -0.36); this.R.position.set(0.26, -0.4, -0.36);
    this.g.add(this.L, this.R);
    this.t = 0;
    this.map = null;
    this.state = 'idle';
  }
  setColor(color) {
    if (color === this.color) return;
    this.color = color;
    const m = painted(handsAtlas(color));
    this.L.material = m; this.R.material = m;
    if (this.board) this.board.material = m;
  }
  showMap(canvas) {
    if (!this.map) {
      this.mapTex = canvasTex(canvas);
      this.map = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.34), new THREE.MeshBasicMaterial({ map: this.mapTex, side: THREE.DoubleSide, fog: false, toneMapped: false }));
      this.map.position.set(0, -0.06, -0.42);
      this.map.rotation.x = -0.12;
      // a leather map case behind the paper (reuses the glove atlas: no new texture)
      const bg = new THREE.PlaneGeometry(0.5, 0.38);
      const U = bg.attributes.uv, r = FP.bracer;
      for (let i = 0; i < U.count; i++) U.setXY(i, (r.x + 2 + U.getX(i) * (r.w - 4)) / 256, 1 - (r.y + 2 + (1 - U.getY(i)) * (r.h - 4)) / 256);
      this.board = new THREE.Mesh(bg, this.L.material);
      this.board.position.set(0, 0, -0.004);
      this.map.add(this.board);
      this.g.add(this.map);
    }
    this.mapTex.image = canvas;
    this.mapTex.needsUpdate = true;
    this.map.visible = true;
  }
  hideMap() { if (this.map) this.map.visible = false; }

  update(dt, me, moving, sprinting) {
    this.t += dt * (sprinting ? 13 : 8.5);
    const t = this.t;
    const walk = moving ? 1 : 0;
    this.w = (this.w ?? 0) + (walk - (this.w ?? 0)) * Math.min(1, dt * 6);
    const w = this.w, now = performance.now() / 1000, idle = Math.sin(now * 1.6) * 0.004;
    const amp = sprinting ? 0.022 : 0.014;
    const bobL = Math.sin(t) * amp * w + idle, bobR = Math.sin(t + Math.PI) * amp * w + idle;
    const swayL = Math.cos(t) * 0.008 * w, swayR = Math.cos(t + Math.PI) * 0.008 * w;
    const pose = (h, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const k = Math.min(1, dt * 14);
      h.position.x += (x - h.position.x) * k; h.position.y += (y - h.position.y) * k; h.position.z += (z - h.position.z) * k;
      h.rotation.x += (rx - h.rotation.x) * k; h.rotation.y += (ry - h.rotation.y) * k; h.rotation.z += (rz - h.rotation.z) * k;
    };
    const st = me.mode;
    this.g.visible = st !== 'ko';
    if (st === 'climb') {
      const c = Math.sin(now * 6.2);
      pose(this.L, -0.2, -0.1 + (moving ? c * 0.07 : 0), -0.36, 1.25, -0.15, 0.35);
      pose(this.R, 0.2, -0.1 - (moving ? c * 0.07 : 0), -0.36, 1.25, 0.15, -0.35);
    } else if (st === 'seat' && me.seat === 0) {
      pose(this.L, -0.19, -0.3, -0.34, 0.75, -0.25, 1.0);
      pose(this.R, 0.19, -0.3, -0.34, 0.75, 0.25, -1.0);
    } else if (me.holding?.type === 'map') {
      pose(this.L, -0.205, -0.33 + bobL * 0.5, -0.36, 1.05, -0.2, 0.55);
      pose(this.R, 0.205, -0.33 + bobR * 0.5, -0.36, 1.05, 0.2, -0.55);
    } else if (me.holding) {
      pose(this.L, -0.2, -0.3 + bobL * 0.6, -0.4, 0.55, -0.85, 0.9);
      pose(this.R, 0.2, -0.3 + bobR * 0.6, -0.4, 0.55, 0.85, -0.9);
    } else {
      pose(this.L, -0.255 + swayL, -0.35 + bobL, -0.34, 0.66, -0.34, 0.32);
      pose(this.R, 0.255 + swayR, -0.35 + bobR, -0.34, 0.66, 0.34, -0.32);
    }
  }
}

// ---- preview (tools/preview.mjs) ----
function posed(color, opts, P) { const ch = buildCharacter(color, opts); ch.driven = true; applyPose(ch, { ...restPose(), ...P }); return ch.root; }
// a player in a given state, posed by the real PlayerView logic (springs settled)
function viewIn(id, st, { emote = null, speed = 0, frames = 90 } = {}) {
  const v = new PlayerView({ add() {}, remove() {} }, { id, color: ['#7CFC00', '#FF6EC7', '#00E5FF', '#FFA033', '#B26EFF', '#FFE93B'][id % 6], name: '' });
  v.emote = emote ? { e: emote, t: 99 } : null;
  const S = { pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, mode: C.MODE.WALK, flags: 0, ...st };
  for (let i = 0; i < frames; i++) { S.pos = { x: 0, y: 0, z: S.pos.z + speed / 30 }; v.update(1 / 30, i / 30, S); }
  v.group.position.set(0, 0, 0);
  for (const o of [v.label, v.mic, v.walkie]) o.visible = false;
  return v.group;
}
const M_ = C.MODE, F_ = C.FLAG;
export const PREVIEW = {
  player: () => buildCharacter('#7CFC00', { hatIndex: 0, skinIndex: 0 }).root,
  player2: () => buildCharacter('#FF6EC7', { hatIndex: 1, skinIndex: 1 }).root,
  player3: () => buildCharacter('#00E5FF', { hatIndex: 2, skinIndex: 2 }).root,
  player4: () => buildCharacter('#FFA033', { hatIndex: 3, skinIndex: 3 }).root,
  player5: () => buildCharacter('#B26EFF', { hatIndex: 4, skinIndex: 4 }).root,
  player6: () => buildCharacter('#FFE93B', { hatIndex: 5, skinIndex: 5 }).root,
  ed: () => buildCharacter('#c0392b', { hatIndex: 2, skinIndex: 3 }).root,
  clerk: () => buildCharacter('#2e86ab', { hatIndex: 0, skinIndex: 4 }).root,
  dealer: () => buildCharacter('#111111', { hatIndex: 1, skinIndex: 4, eyeColor: '#d62828' }).root,
  repoman: () => buildCharacter('#6b5640', { hatIndex: 0, skinIndex: 1, scale: 1.25 }).root,
  walker: () => posed('#00E5FF', { hatIndex: 2, skinIndex: 2 }, { lL: 0.55, lR: -0.5, kL: -0.15, kR: -0.85, fR: 0.3, aL: -0.45, aR: 0.45, eL: 0.4, eR: 0.75, bend: -0.08, tw: 0.08, ctw: -0.12 }),
  sitter: () => posed('#FFA033', { hatIndex: 3, skinIndex: 3 }, { lL: 1.5, lR: 1.5, kL: -1.5, kR: -1.5, aL: 0.8, aR: 0.8, eL: 0.85, eR: 0.85 }),
  climber: () => posed('#B26EFF', { hatIndex: 4, skinIndex: 4 }, { aL: 2.9, aR: 2.5, eL: 0.3, eR: 0.5, lL: 0.9, lR: 0.2, kL: -1.2, kR: -0.5 }),
  walking: () => viewIn(2, {}, { speed: 4.4, frames: 47 }),
  running: () => viewIn(0, { flags: F_.SPRINT }, { speed: 7, frames: 52 }),
  crouching: () => viewIn(1, { flags: F_.CROUCH }),
  carrying: () => viewIn(3, { flags: F_.HOLDING }),
  mapping: () => viewIn(4, { flags: F_.HOLDING | F_.MAP }),
  seated: () => viewIn(5, { mode: M_.SEAT }),
  climbing: () => viewIn(4, { mode: M_.CLIMB }),
  ko: () => viewIn(0, { mode: M_.KO }),
  jumping: () => viewIn(2, { mode: M_.AIR }),
  laughing: () => viewIn(1, {}, { emote: '😂' }),
  crowned: () => viewIn(3, {}, { emote: '👑' }),
  fphands: () => { const g = new THREE.Group(); const m = painted(handsAtlas('#00E5FF')); const L = new THREE.Mesh(fpHandGeometry(-1), m), R = new THREE.Mesh(fpHandGeometry(1), m); L.position.set(-0.16, 0, 0); R.position.set(0.16, 0, 0); for (const h of [L, R]) { h.rotation.x = 0.5; g.add(h); } g.rotation.y = Math.PI; g.scale.setScalar(3); return g; },
};
