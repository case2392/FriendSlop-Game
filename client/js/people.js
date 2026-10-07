// People: every human in the game. Other players (PlayerView), the town NPCs
// (buildCharacter, used by town3d.js) and your own first-person hands (Hands).
//
// Style: WoW Classic humans with a dash of OSRS chunk. Each person is ONE
// SkinnedMesh (one draw call + one in the shadow pass) on an 18-bone skeleton,
// textured with ONE hand-painted 512×512 atlas from paint/characters.js: painted
// face (almond eyes, heavy brows, beards), tabard in the player's color over a
// leather jerkin, belt and buckle, big gloves, knee-high boots with folded cuffs,
// chunky riveted pauldrons, and a hat. Geometry is smooth lathes and tubes, all
// built here; detail lives in the texture.
//
// Frames: root at the feet; the model faces local +x inside, and root.rotation.y
// = -PI/2 turns it to face +z (unchanged from the old egg people). Bones rotate
// about local z to swing forward (legs, arms, head nod), as before.
//
// HEAD FRAME (for accessories added to `head`, e.g. the Repo Man's shades in
// town3d.js): +x = where the face points, +y = up, +z = the character's right.
// 1 head unit = HU = 0.00829 m (× the character's scale). In head units the eyes
// sit at about (13, 3.5, ±4.5), the nose bridge front at x ≈ 16, the skull
// half-width at the eyes is ≈ 13, the crown at y ≈ 22, the chin at y ≈ -11.5.
// So the old sunglasses transform, position (16.5, 4, 0) with BoxGeometry(4, 5, 30),
// still sits right across the eyes.
import { THREE, painted, tex, labelSprite, canvasTex } from './gfx.js';
import * as C from '/shared/constants.js';
import { mergeGeometries } from '/vendor/BufferGeometryUtils.js';
import { AW, AH, REG, HEAD_RINGS, hairlineDy, lerpTable, resolveSpec, charAtlas, charGlow, handsAtlas, FP, labelColor } from './paint/characters.js';

const TAU = Math.PI * 2;
const HS = 1.16;             // head size factor over HEAD_RINGS
const HU = 0.025 * HS / 3.5; // head-local unit (see the header): the eye line sits at y = 3.5
const clamp01 = x => Math.max(0, Math.min(1, x));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const thOf = u => Math.PI - TAU * u;          // u .5 = front (+x), .25 = right (+z), .75 = left (-z)

// bone indices
const B = { body: 0, hips: 1, spine: 2, chest: 3, neck: 4, head: 5, armL: 6, foreL: 7, handL: 8, armR: 9, foreR: 10, handR: 11, legL: 12, shinL: 13, footL: 14, legR: 15, shinR: 16, footR: 17 };
const ARM = s => s < 0 ? [B.armL, B.foreL, B.handL] : [B.armR, B.foreR, B.handR];
const LEG = s => s < 0 ? [B.legL, B.shinL, B.footL] : [B.legR, B.shinR, B.footR];
// joints in the bind pose (meters, body space; s = -1 left, +1 right)
const J = {
  hips: 0.93, spine: 1.03, chest: 1.22, neck: 1.45, head: 1.595,
  shoulder: s => [0, 1.405, 0.245 * s], hip: s => [0, 0.905, 0.105 * s], knee: s => [0, 0.475, 0.118 * s], ankle: s => [0, 0.105, 0.108 * s],
};

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
  geo.userData.grid = { nu, nv };
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
const ringsOf = (tab, f) => tab.map(f);

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
  // rims
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
    // flip if the rim faces inward (compare with the outward step at its middle)
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
const HR = HEAD_RINGS.map(([dy, w, d, db, n, cx, v]) => ({ dy, w, d, db, n, cx, v }));
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
  let dx = p[0] - HC[0], dyy = p[1] - HC[1], dz = p[2] - HC[2];
  const l = Math.hypot(dx, dyy, dz) || 1;
  return [p[0] + dx / l * off, p[1] + dyy / l * off, p[2] + dz / l * off];
}
const toHead = p => [p[0] + H0[0], p[1] + H0[1], p[2] + H0[2]];
const gauss = (x, s) => Math.exp(-(x * x) / (s * s));
const CROWN = 0.156 * HS;

function headWeights(p) {
  const dy = p[1] - J.head;
  if (dy > -0.1 * HS) return [[B.head, 1]];
  const t = sstep(-0.15 * HS, -0.1 * HS, dy);
  return [[B.head, t], [B.neck, (1 - t) * 0.7], [B.chest, (1 - t) * 0.3]];
}

function headParts(S) {
  const parts = [];
  const rings = HR.map(r => ({ y: r.dy * HS, w: r.w * HS, d: r.d * HS, db: r.db * HS, n: r.n, cx: r.cx * HS, v: r.v }));
  const fem = S.look.female;
  parts.push(lathe(rings, {
    seg: 22, reg: REG.head, bones: headWeights, xf: toHead,
    deform(p, th, r) {
      const dy = r.y / HS, front = Math.max(0, Math.cos(th));
      let dx = 0;
      dx += (fem ? 0.019 : 0.024) * gauss(dy + 0.014, 0.012) * gauss(th, 0.2);        // nose tip
      dx += 0.012 * gauss(dy - 0.012, 0.016) * gauss(th, 0.17);                         // bridge
      dx += 0.007 * gauss(dy - 0.047, 0.01) * gauss(th, 0.8) * (fem ? 0.6 : 1);         // brow ridge
      dx -= 0.007 * gauss(dy - 0.025, 0.012) * gauss(Math.abs(th) - 0.34, 0.16);        // eye sockets
      dx += 0.005 * gauss(dy + 0.07, 0.014) * gauss(th, 0.3) * (fem ? 0.5 : 1);         // chin
      const cheek = 0.006 * gauss(dy - 0.0, 0.016) * gauss(Math.abs(th) - 0.8, 0.3);   // cheekbones
      const c = Math.cos(th), s = Math.sin(th);
      return [p[0] + dx * HS * front + cheek * HS * c, p[1], p[2] + cheek * HS * s];
    },
  }));
  // ears
  for (const s of [-1, 1]) {
    const er = [[-0.028, 0], [-0.024, 0.6], [-0.01, 1], [0.012, 1], [0.024, 0.75], [0.03, 0]].map(([dy, k], i, a) => ({ y: dy * HS, w: 0.011 * k * HS, d: 0.021 * k * HS, db: 0.014 * k * HS, cx: (-0.006 - dy * 0.15) * HS, v: i / (a.length - 1) }));
    parts.push(lathe(er, { seg: 8, reg: REG.ear, bones: B.head, xf: p => toHead([p[0], p[1] + 0.008 * HS, p[2] + s * 0.096 * HS]) }));
  }
  // hair shell
  const L = S.look, coveredByHat = ['hood', 'helm', 'beanie', 'bandana'].includes(S.hat);
  if (['short', 'slick', 'braid', 'bun'].includes(L.hair) && !coveredByHat) {
    const vol = L.hair === 'slick' ? 0.006 : L.hair === 'short' ? 0.016 : 0.011;
    parts.push(surf((u, v) => {
      const th = thOf(u);
      const jag = L.hair === 'short' && Math.abs(th) < 1.1 ? (Math.round(u * 22) % 2 ? 0.006 : -0.004) : 0;
      const h0 = (hairlineDy(th) + jag) * HS + (L.hair === 'slick' ? 0.006 : 0);
      const dy = h0 + (CROWN + 0.002 - h0) * Math.pow(v, 0.8);
      const tuft = L.hair === 'short' ? 0.004 * Math.sin(u * 37) * Math.sin(v * 9) : 0;
      return toHead(shellPt(th, dy, v === 0 ? 0 : vol * Math.min(1, v * 4) * (0.7 + 0.3 * Math.cos(th * 0.5) ** 2) + tuft));
    }, 22, 7, { reg: REG.hair, bones: B.head, closed: true, inside: () => toHead(HC) }));
  }
  if (L.hair === 'braid') {
    const path = bez(toHead([-0.1 * HS, 0.03 * HS, 0]), toHead([-0.15 * HS, -0.1 * HS, 0]), [-0.17, 1.4, 0], [-0.165, 1.2, 0]);
    parts.push(tube(path, (v) => (0.024 - 0.008 * v) * (0.85 + 0.15 * Math.abs(Math.sin(v * Math.PI * 7))) * Math.sqrt(Math.sin(Math.min(1, v * 1.02 + 0.02) * Math.PI)), 8, 14, {
      reg: REG.beard, ref: [0, 0, 1], bones: p => { const t = sstep(1.48, 1.3, p[1]); return [[B.head, 1 - t], [B.chest, t]]; },
    }));
    parts.push(tube(v => [-0.165, 1.2 - v * 0.05, 0], v => 0.022 * Math.sqrt(Math.sin(v * Math.PI)), 8, 4, { reg: REG.beard, ref: [1, 0, 0], bones: B.chest }));
  }
  if (L.hair === 'bun' && !coveredByHat) {
    const c = toHead([-0.08 * HS, 0.12 * HS, 0]);
    parts.push(lathe([0, 0.6, 0.9, 1, 0.9, 0.6, 0].map((k, i) => ({ y: (i / 6 - 0.5) * 0.085, w: 0.045 * k, d: 0.04 * k, v: i / 6 })), {
      seg: 10, reg: REG.beard, bones: B.head, xf: p => [c[0] + p[0] - p[1] * 0.4, c[1] + p[1], c[2] + p[2]],
    }));
  }
  if (L.facial === 'beard' || L.facial === 'goatee') {
    const big = L.facial === 'beard';
    const c = toHead([(big ? 0.068 : 0.093) * HS, (big ? -0.075 : -0.088) * HS, 0]);
    const ks = big ? [0, 0.75, 1, 0.95, 0.7, 0] : [0, 0.9, 1, 0.75, 0.4, 0];
    parts.push(lathe(ks.map((k, i) => ({ y: (0.5 - i / 5) * (big ? 0.075 : 0.05), w: (big ? 0.072 : 0.022) * k, d: (big ? 0.042 : 0.016) * k, db: (big ? 0.03 : 0.01) * k, v: 1 - i / 5 })), {
      seg: 12, reg: REG.beard, bones: B.head, xf: p => [c[0] + p[0] + Math.max(0, -p[1]) * 0.35, c[1] + p[1], c[2] + p[2]],
    }));
  }
  if (L.facial === 'mustache') {
    const path = v => { const a = (v - 0.5) * 2.2; return toHead([0.112 * HS - Math.abs(a) * 0.012, (-0.03 - Math.abs(a) ** 2 * 0.012) * HS, Math.sin(a) * 0.04 * HS]); };
    parts.push(tube(path, v => 0.011 * Math.sin(v * Math.PI) ** 0.6, 6, 10, { reg: REG.beard, ref: [1, 0, 0], bones: B.head }));
  }
  parts.push(...hatParts(S));
  return parts;
}

// ---- hats ----------------------------------------------------------------------------------

const ACC = REG.acc;
const crownUV = (u, v) => [u, 0.52 + v * 0.48];
const brimUV = (u, v) => [u, v * 0.45];
function hatParts(S) {
  const h = S.hat, P = [];
  const head = { bones: B.head };
  if (h === 'brim' || h === 'straw') {
    const straw = h === 'straw';
    const base = 0.08 * HS, top = (straw ? 0.205 : 0.215) * HS;
    const prof = straw ? [[1, 0], [0.98, 0.3], [0.9, 0.65], [0.78, 0.9], [0.5, 1.0], [0, 1.03]] : [[1, 0], [0.99, 0.3], [0.94, 0.7], [0.88, 0.95], [0.55, 1.0], [0.25, 0.9], [0, 0.88]];
    const rx = 0.128 * HS, rz = 0.12 * HS;
    P.push(lathe(prof.map(([k, t], i) => ({ y: base + (top - base) * t, w: rz * k, d: rx * k * (!straw && t > 0.8 ? 0.82 : 1), db: rx * k, n: 2.1, cx: -0.008, v: i / (prof.length - 1) })), {
      seg: 18, reg: ACC, uv: (u, v) => crownUV(u, v), ...head, xf: toHead,
      deform: (p, th) => straw ? p : [p[0], p[1] - (p[1] > top * 0.9 ? 0.012 * Math.max(0, Math.cos(th)) : 0), p[2]],
    }));
    const r0 = 0.1 * HS, r1 = (straw ? 0.235 : 0.225) * HS;
    P.push(...slab((u, v) => {
      const th = thOf(u), t = v;
      let r = r0 + (r1 - r0) * t;
      if (straw) r += (Math.sin(u * 61) * 0.5 + Math.sin(u * 23) * 0.5) * 0.008 * t;
      const side = Math.sin(th) ** 2, front = Math.cos(th);
      let y = base + 0.004 - (straw ? 0.026 * t * t : 0) + (straw ? 0 : 0.04 * side * t ** 1.6 - 0.014 * Math.max(0, front) * t);
      return toHead([Math.cos(th) * r * 1.05 - 0.008, y, Math.sin(th) * r]);
    }, 22, 3, 0.012, { reg: ACC, uv: brimUV, ...head, closed: true, inside: () => toHead([0, base + 0.05, 0]) }));
  } else if (h === 'bandana' || h === 'beanie' || h === 'helm' || h === 'hood' || h === 'cap') {
    const off = { bandana: 0.012, beanie: 0.02, helm: 0.024, hood: 0.03, cap: 0.022 }[h];
    const low = th => {
      const a = Math.abs(th);
      if (h === 'hood') return -0.12 * HS;
      if (h === 'helm') return (a < 0.9 ? 0.042 : lerpTable([[0.9, 0.042], [1.5, 0.0], [Math.PI, -0.035]], a)) * HS;
      if (h === 'beanie') return (a < 1.2 ? 0.06 : lerpTable([[1.2, 0.06], [1.6, 0.035], [Math.PI, -0.02]], a)) * HS;
      if (h === 'cap') return lerpTable([[0, 0.068], [1.5, 0.05], [Math.PI, 0.02]], a) * HS;
      return lerpTable([[0, 0.07], [1.3, 0.05], [1.7, 0.03], [Math.PI, -0.045]], a) * HS;   // bandana
    };
    const shellFn = (u, v) => {
      let th = thOf(u);
      if (h === 'hood') th = Math.sign(th || 1) * (0.95 + (Math.PI - 0.95) * (1 - Math.abs(u - 0.5) * 2)) * 1 + 0;
      const lo = low(th), dy = lo + (CROWN + 0.004 - lo) * Math.pow(v, h === 'hood' ? 1 : 0.85);
      let o = off * (h === 'hood' ? 1 + 0.6 * (1 - v) : 1);
      let p = shellPt(th, dy, o);
      if (h === 'hood') {   // drape: below the jaw the cloth falls outward; a point at the back of the crown
        if (dy < -0.04) p = [p[0] * 1.05, p[1], p[2] * (1.15 + (-0.04 - dy) * 3)];
        p[0] -= 0.04 * gauss(v - 1, 0.25) * gauss(Math.abs(th) - Math.PI, 0.6);
        p[1] += 0.03 * gauss(v - 0.9, 0.2) * gauss(Math.abs(th) - Math.PI, 0.7);
      }
      return toHead(p);
    };
    if (h === 'hood') {
      // u runs around the face opening: u = 0 and 1 at the face edges, .5 at the back
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
        const th = thOf(u), y = 1.475 - v * 0.17;
        const [x, z] = ringXZ(th, 0.085 + v * 0.19, 0.08 + v * 0.13, 0.08 + v * 0.13, 2.2);
        return [x - 0.01, y + 0.02 * Math.cos(th * 2) * v, z];
      }, 18, 3, 0.012, { reg: ACC, uv: brimUV, bones: p => p[1] > 1.45 ? [[B.chest, 0.6], [B.neck, 0.4]] : [[B.chest, 1]], closed: true, inside: () => [0, 1.3, 0] }));
    } else {
      P.push(surf(shellFn, 20, 6, { reg: ACC, uv: crownUV, bones: B.head, closed: true, inside: () => toHead(HC) }));
    }
    if (h === 'helm' || h === 'beanie' || h === 'cap') {    // rim / cuff ring at the bottom edge
      const thick = h === 'helm' ? 0.014 : h === 'beanie' ? 0.016 : 0.006;
      P.push(surf((u, v) => {
        const th = thOf(u), lo = low(th), dy = lo + (v - 0.5) * (h === 'beanie' ? 0.05 : 0.026) * HS + (h === 'beanie' ? 0.014 * HS : 0.004);
        return toHead(shellPt(th, dy, off + thick * Math.sin(v * Math.PI) + 0.002));
      }, 20, 4, { reg: ACC, uv: brimUV, bones: B.head, closed: true, inside: () => toHead(HC) }));
    }
    if (h === 'cap') {
      P.push(...slab((u, v) => {
        const a = (u - 0.5) * 1.9, r = shellPt(a, 0.068 * HS, off);
        const ext = v * 0.08 * Math.pow(Math.max(0, Math.cos(a * 1.45)), 0.6);
        return toHead([r[0] + ext, r[1] - ext * 0.3, r[2] + Math.sin(a) * ext * 0.25]);
      }, 12, 2, 0.008, { reg: ACC, uv: brimUV, bones: B.head, inside: () => toHead([0, 0.1, 0]) }));
      P.push(lathe([0, 1, 0.7, 0].map((k, i) => ({ y: CROWN + off + i * 0.004, w: 0.012 * k, d: 0.012 * k, v: 1 })), { seg: 8, reg: ACC, uv: () => [0.5, 0.98], bones: B.head, xf: toHead }));
    }
    if (h === 'bandana') {
      const k = toHead(shellPt(Math.PI, 0.0, off + 0.012));
      P.push(lathe([0, 0.8, 1, 0.8, 0].map((q, i) => ({ y: (i / 4 - 0.5) * 0.05, w: 0.03 * q, d: 0.022 * q, v: i / 4 })), { seg: 10, reg: ACC, uv: (u, v) => [u, 0.6 + v * 0.3], bones: B.head, xf: p => [k[0] + p[0] - 0.008, k[1] + p[1], k[2] + p[2]] }));
      for (const s of [-1, 1]) P.push(...slab((u, v) => [k[0] - 0.012 - v * 0.03, k[1] - 0.01 - v * 0.12, k[2] + s * (0.006 + v * 0.025) + (u - 0.5) * 0.04], 2, 4, 0.006,
        { reg: ACC, uv: (u, v) => [u * 0.2 + 0.4, 0.55 - v * 0.5], bones: p => { const t = sstep(1.58, 1.46, p[1]); return [[B.head, 1 - t], [B.neck, t]]; }, inside: () => [k[0] + 0.1, k[1], k[2]] }));
    }
    if (h === 'helm') {
      // nasal guard
      P.push(...slab((u, v) => toHead(shellPt((u - 0.5) * 0.2, (0.06 - v * 0.065) * HS, off + 0.008 + 0.006 * v)), 2, 3, 0.006, { reg: ACC, uv: (u, v) => [0.5, 0.2 + v * 0.2], bones: B.head, inside: () => toHead(HC) }));
      for (const s of [-1, 1]) {
        const a = toHead([0, 0.09 * HS, s * 0.11 * HS]);
        const path = bez(a, [a[0] + 0.01, a[1] + 0.03, a[2] + s * 0.09], [a[0] + 0.05, a[1] + 0.12, a[2] + s * 0.13], [a[0] + 0.085, a[1] + 0.2, a[2] + s * 0.1]);
        P.push(tube(path, v => 0.032 * (1 - v) ** 0.9 + 0.002, 9, 9, { reg: REG.horn, uv: (u, v) => [u, v], ref: [1, 0, 0], bones: B.head }));
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

const TORSO = [
  // y,     w,     d,     db,    n,   v
  [0.885, 0.03, 0.03, 0.03, 2.0, 0.0],
  [0.80, 0.17, 0.12, 0.11, 2.2, 0.005],
  [0.772, 0.212, 0.152, 0.144, 2.3, 0.015],
  [0.79, 0.214, 0.155, 0.146, 2.3, 0.04],
  [0.87, 0.205, 0.150, 0.140, 2.4, 0.15],
  [0.955, 0.192, 0.140, 0.132, 2.4, 0.26],
  [1.00, 0.186, 0.136, 0.128, 2.4, 0.31],
  [1.06, 0.180, 0.132, 0.124, 2.4, 0.39],
  [1.16, 0.202, 0.150, 0.130, 2.6, 0.53],
  [1.27, 0.222, 0.162, 0.140, 2.7, 0.68],
  [1.355, 0.220, 0.152, 0.140, 2.6, 0.80],
  [1.42, 0.168, 0.112, 0.112, 2.3, 0.90],
  [1.462, 0.085, 0.075, 0.075, 2.0, 0.97],
  [1.475, 0.0, 0.0, 0.0, 2.0, 1.0],
];
function torsoWeights(p) {
  const y = p[1];
  if (y < 0.955) {
    const a = 0.55 * sstep(0.955, 0.775, y);
    const l = clamp01(0.5 - p[2] / 0.2 * 0.7);
    return [[B.hips, 1 - a], [B.legL, a * l], [B.legR, a * (1 - l)]];
  }
  if (y < 1.12) { const t = sstep(0.97, 1.12, y); return [[B.hips, 1 - t], [B.spine, t]]; }
  if (y < 1.3) { const t = sstep(1.12, 1.3, y); return [[B.spine, 1 - t], [B.chest, t]]; }
  if (y < 1.44) return [[B.chest, 1]];
  const t = sstep(1.44, 1.48, y);
  return [[B.chest, 1 - t * 0.5], [B.neck, t * 0.5]];
}
const TORSO_UP = TORSO.slice(3);     // monotonic in y, for lookups
function torsoRing(y, S) {
  const bulk = S.bulk || 1, belly = S.belly || 0;
  const r = { y, w: lerpTable(TORSO_UP, y, 1) * bulk, d: lerpTable(TORSO_UP, y, 2) * bulk, db: lerpTable(TORSO_UP, y, 3) * bulk, n: lerpTable(TORSO_UP, y, 4) };
  r.d += belly * gauss(y - 1.06, 0.12);
  return r;
}

function bodyParts(S) {
  const P = [];
  const bulk = S.bulk || 1, belly = S.belly || 0;
  P.push(lathe(TORSO.map(([y, w, d, db, n, v]) => ({ y, w: w * bulk, d: d * bulk + belly * gauss(y - 1.06, 0.12), db: db * bulk, n, v })), { seg: 22, reg: REG.torso, bones: torsoWeights }));
  // belt + buckle + pouch
  if (S.belt) {
    const by0 = 0.958, by1 = 1.035, thin = S.outfit !== 'player';
    P.push(surf((u, v) => {
      const th = thOf(u), y = by0 + (by1 - by0) * (thin ? 0.3 + v * 0.45 : v);
      const r = torsoRing(y, S), [x, z] = ringXZ(th, r.w + 0.009, r.d + 0.009, r.db + 0.009, r.n);
      return [x, y, z];
    }, 24, 2, { reg: REG.belt, uv: (u, v) => [u, 0.52 + v * 0.46], bones: torsoWeights, closed: true, inside: (u, v) => [0, 1, 0] }));
    const fr = torsoRing(0.996, S);
    const bh = thin ? 0.042 : 0.062, ys = [-0.52, -0.48, -0.2, 0.2, 0.48, 0.52], ks = [0, 0.9, 1, 1, 0.9, 0];
    P.push(lathe(ks.map((k, i) => ({ y: ys[i] * bh, w: 0.032 * (thin ? 0.7 : 1) * k, d: 0.009 * k, n: 4, v: i / 5 })),
      { seg: 8, reg: REG.metal, uv: (u, v) => [u, 0.6 + v * 0.35], bones: B.hips, xf: p => [fr.d + 0.012 + p[0], 0.996 + p[1], p[2]] }));
    if (S.outfit === 'player') {
      const pr = torsoRing(0.95, S), th = 1.15, [px, pz] = ringXZ(th, pr.w, pr.d, pr.db, pr.n);
      P.push(lathe([0, 0.85, 1, 1, 0.9, 0].map((k, i) => ({ y: (0.5 - i / 5) * 0.085, w: 0.05 * k, d: 0.025 * k, db: 0.012 * k, n: 3, v: 1 - i / 5 })), {
        seg: 10, reg: REG.belt, uv: (u, v) => [u, v * 0.48], bones: p => [[B.hips, 0.7], [B.legR, 0.3]],
        xf: p => { const c = Math.cos(th), s = Math.sin(th); return [px + p[0] * c - p[2] * s + 0.01, 0.94 + p[1], pz + p[0] * s + p[2] * c + 0.01]; },
      }));
    }
  }
  // Ed's leather apron: hangs from the chest to the knees
  if (S.apron) {
    P.push(...slab((u, v) => {
      const y = 0.48 + 0.82 * v, th = (u - 0.5) * 1.75;
      const yy = Math.max(0.78, y);
      const r = torsoRing(yy, S), [x, z] = ringXZ(th, r.w, r.d, r.db, r.n);
      const flare = y < 0.78 ? (0.78 - y) * 0.18 : 0;
      return [x + 0.012 + flare, y, z * (1 + flare * 1.5)];
    }, 10, 10, 0.008, {
      reg: ACC, uv: (u, v) => [u, v], inside: (u, v) => [0, 0.48 + 0.82 * v, 0],
      bones: p => { if (p[1] > 0.955) return torsoWeights(p); const a = 0.5 * sstep(0.955, 0.5, p[1]), l = clamp01(0.5 - p[2] / 0.15 * 0.5); return [[B.hips, 1 - a], [B.legL, a * l], [B.legR, a * (1 - l)]]; },
    }));
  }
  for (const s of [-1, 1]) { P.push(...armParts(S, s)); P.push(...legParts(S, s)); }
  if (S.pauldrons === 'both') for (const s of [-1, 1]) P.push(...pauldron(S, s, 1));
  if (S.pauldrons === 'right') P.push(...pauldron(S, 1, 1.4));
  return P;
}

const ARM_UP = [
  [0.07, 0.0, 0.0, 0.0, 1.0],
  [0.058, 0.05, 0.056, 0.054, 0.97],
  [0.03, 0.076, 0.084, 0.08, 0.92],
  [-0.01, 0.084, 0.088, 0.083, 0.86],
  [-0.07, 0.078, 0.079, 0.074, 0.79],
  [-0.15, 0.073, 0.076, 0.068, 0.70],
  [-0.24, 0.064, 0.066, 0.062, 0.61],
  [-0.29, 0.061, 0.063, 0.06, 0.57],
  [-0.335, 0.065, 0.071, 0.064, 0.53],
  [-0.40, 0.059, 0.063, 0.057, 0.43],
];
const ARM_GLOVE = [
  [-0.436, 0.055, 0.059, 0.053, 0.37],
  [-0.44, 0.074, 0.078, 0.074, 0.355],
  [-0.462, 0.078, 0.082, 0.078, 0.33],
  [-0.53, 0.066, 0.07, 0.066, 0.24],
  [-0.553, 0.05, 0.055, 0.05, 0.20],
];
const ARM_BARE = [
  [-0.47, 0.054, 0.058, 0.053, 0.32],
  [-0.53, 0.044, 0.048, 0.044, 0.24],
  [-0.553, 0.041, 0.046, 0.041, 0.20],
];
const HAND = [   // hanging hand: thin across z (palm faces the leg), wide front-to-back
  [-0.58, 0.032, 0.052, 0.05, 0.17],
  [-0.625, 0.035, 0.059, 0.057, 0.11],
  [-0.668, 0.031, 0.055, 0.052, 0.06],
  [-0.698, 0.024, 0.044, 0.042, 0.02],
  [-0.71, 0.0, 0.0, 0.0, 0.0],
];
function armParts(S, s) {
  const [ua, fa, ha] = ARM(s), sh = J.shoulder(s);
  const bare = S.hands === 'bare', big = S.hands === 'workglove' ? 1.1 : 1;
  const bulk = S.bulk || 1;
  const tab = [...ARM_UP, ...(bare ? ARM_BARE : ARM_GLOVE), ...HAND.map(r => [r[0], r[1] * (bare ? 0.92 : big), r[2] * (bare ? 0.92 : big), r[3] * (bare ? 0.92 : big), r[4]])];
  const rings = tab.map(([dy, w, d, db, v]) => {
    const curl = dy < -0.62 ? (-0.62 - dy) / 0.09 : 0;
    return { y: dy, w: w * (dy > -0.4 ? bulk : 1), d: d * (dy > -0.4 ? bulk : 1), db: db * (dy > -0.4 ? bulk : 1), n: dy < -0.56 ? 2.6 : 2, cx: 0.006 * curl, cz: -0.014 * curl * curl, v };
  });
  const wts = p => {
    const dy = p[1] - sh[1];
    if (dy > -0.25) return [[ua, 1]];
    if (dy > -0.33) { const t = sstep(-0.25, -0.33, dy); return [[ua, 1 - t], [fa, t]]; }
    if (dy > -0.545) return [[fa, 1]];
    if (dy > -0.58) { const t = sstep(-0.545, -0.58, dy); return [[fa, 1 - t], [ha, t]]; }
    return [[ha, 1]];
  };
  const P = [lathe(rings, { seg: 12, reg: REG.arm, bones: wts, xf: p => [sh[0] + p[0], sh[1] + p[1], sh[2] + p[2] * s] })];
  // thumb (front, toward the body)
  const k = bare ? 0.9 : big;
  const T = (x, dy, zin) => [sh[0] + x * k, sh[1] + dy * k - (1 - k) * 0.55, sh[2] - s * zin * k];
  const path = bez(T(0.02, -0.565, 0.006), T(0.05, -0.59, 0.02), T(0.065, -0.625, 0.024), T(0.058, -0.655, 0.018));
  P.push(tube(path, v => (0.02 - 0.005 * v) * k * Math.sqrt(Math.sin(Math.min(1, 0.15 + v * 0.85) * Math.PI)), 8, 6, { reg: REG.arm, uv: (u, v) => [0.4 + u * 0.2, 0.15 - v * 0.12], ref: [0, 0, 1], bones: ha }));
  return P;
}

const LEG_TOP = [
  [0.985, 0.0, 0.0, 0.0, 1.0],
  [0.965, 0.075, 0.085, 0.085, 0.97],
  [0.905, 0.1, 0.104, 0.1, 0.92],
  [0.80, 0.097, 0.1, 0.097, 0.84],
  [0.65, 0.087, 0.089, 0.086, 0.72],
  [0.53, 0.077, 0.081, 0.077, 0.64],
  [0.475, 0.074, 0.08, 0.073, 0.60],
];
const LEG_TALL = [
  [0.44, 0.071, 0.077, 0.072, 0.565],
  [0.436, 0.087, 0.09, 0.087, 0.55],
  [0.41, 0.09, 0.094, 0.09, 0.52],
  [0.335, 0.083, 0.088, 0.084, 0.44],
  [0.325, 0.073, 0.078, 0.074, 0.42],
  [0.25, 0.069, 0.073, 0.071, 0.33],
  [0.16, 0.065, 0.069, 0.067, 0.22],
  [0.10, 0.064, 0.068, 0.066, 0.15],
  [0.06, 0.05, 0.05, 0.05, 0.06],
  [0.05, 0.0, 0.0, 0.0, 0.0],
];
const LEG_PLAIN = [
  [0.40, 0.062, 0.067, 0.064, 0.52],
  [0.30, 0.058, 0.062, 0.06, 0.40],
  [0.20, 0.055, 0.059, 0.057, 0.27],
  [0.12, 0.052, 0.056, 0.054, 0.17],
  [0.06, 0.044, 0.044, 0.044, 0.06],
  [0.05, 0.0, 0.0, 0.0, 0.0],
];
const FOOT = [ // x, w, up, down, cy, n, v
  [-0.088, 0.0, 0.0, 0.0, 0.05, 2, 0.0],
  [-0.078, 0.046, 0.042, 0.048, 0.05, 2.4, 0.05],
  [-0.05, 0.058, 0.06, 0.05, 0.055, 2.6, 0.16],
  [0.0, 0.062, 0.075, 0.055, 0.06, 2.6, 0.33],
  [0.06, 0.066, 0.058, 0.05, 0.05, 2.7, 0.52],
  [0.12, 0.069, 0.047, 0.045, 0.045, 2.8, 0.70],
  [0.18, 0.066, 0.042, 0.04, 0.04, 2.8, 0.86],
  [0.214, 0.05, 0.032, 0.035, 0.035, 2.5, 0.95],
  [0.226, 0.0, 0.0, 0.0, 0.035, 2, 1.0],
];
function legParts(S, s) {
  const [th, sn, ft] = LEG(s), hip = J.hip(s), knee = J.knee(s), ank = J.ankle(s);
  const tall = S.boots === 'tall', shoe = S.boots === 'shoe';
  const axisZ = y => y > knee[1] ? knee[2] + (hip[2] - knee[2]) * (y - knee[1]) / (hip[1] - knee[1]) : ank[2] + (knee[2] - ank[2]) * (y - ank[1]) / (knee[1] - ank[1]);
  const tab = [...LEG_TOP, ...(tall ? LEG_TALL : LEG_PLAIN)];
  const wts = p => {
    const y = p[1];
    if (y > 0.54) return [[th, 1]];
    if (y > 0.42) { const t = sstep(0.54, 0.42, y); return [[th, 1 - t], [sn, t]]; }
    if (y > 0.13) return [[sn, 1]];
    const t = sstep(0.13, 0.07, y); return [[sn, 1 - t], [ft, t]];
  };
  const P = [lathe(tab.map(([y, w, d, db, v]) => ({ y, w, d, db, cz: axisZ(y) * s, v })), { seg: 12, reg: REG.leg, bones: wts, xf: p => [p[0], p[1], p[2] * s] })];
  const k = shoe ? [0.86, 0.8, 0.94] : S.outfit === 'repo' ? [1.06, 1.05, 1.04] : [1, 1, 1];
  const nv = FOOT.length - 1;
  P.push(surf((u, v) => {
    const i = Math.round(v * nv), [x, w, up, dn, cy, n] = FOOT[i];
    const [a, b] = ringXZ(thOf(u), w * k[0], up * k[1], dn, n);
    const X = x * k[2];
    return [X, Math.max(0.002, cy * (shoe ? 0.85 : 1) + a), s * (Math.abs(ank[2]) + b + 0.06 * Math.max(0, X))];
  }, 12, nv, { reg: REG.foot, uv: (u, v) => [u, FOOT[Math.round(v * nv)][6]], bones: p => p[0] < -0.03 && p[1] > 0.09 ? [[ft, 0.7], [sn, 0.3]] : [[ft, 1]], closed: true, inside: (u, v) => { const r = FOOT[Math.round(v * nv)]; return [r[0] * k[2], r[4], ank[2]]; } }));
  return P;
}

function pauldron(S, s, size) {
  const [ua] = ARM(s), sh = J.shoulder(s);
  const R = 0.122 * size, tilt = 0.55, fmax = 1.22;
  const A = [0, Math.cos(tilt), s * Math.sin(tilt)], E1 = [1, 0, 0];
  const E2 = [A[1] * E1[2] - A[2] * E1[1], A[2] * E1[0] - A[0] * E1[2], A[0] * E1[1] - A[1] * E1[0]];
  const C = [sh[0] - 0.005, sh[1] + 0.028 * size, sh[2] + s * 0.012];
  const dir = (th, f) => { const c = Math.cos(th), sn = Math.sin(th), sf = Math.sin(f), cf = Math.cos(f); return [0, 1, 2].map(k => A[k] * cf * 0.82 + (E1[k] * c + E2[k] * sn) * sf); };
  const pt = (th, f, rr) => { const d = dir(th, f); return [C[0] + d[0] * rr, C[1] + d[1] * rr, C[2] + d[2] * rr]; };
  const P = [];
  P.push(...slab((u, v) => {
    const th = thOf(u), f = (1 - v) * fmax;
    const lip = 1 + 0.07 * gauss(v, 0.08);
    return pt(th, f, R * lip * (1 + 0.04 * Math.cos(th)));
  }, 16, 6, 0.014, { reg: REG.paul, uv: (u, v) => [u, 0.32 + v * 0.68], bones: ua, closed: true, inside: () => C, uvInner: (a, b) => [a, b - 0.25] }));
  // a second, lower lame on the outer side
  const out = [0, -0.25, s]; const ol = Math.hypot(...out);
  const thOut = Math.atan2((out[0] * E2[0] + out[1] * E2[1] + out[2] * E2[2]) / ol, (out[0] * E1[0] + out[1] * E1[1] + out[2] * E1[2]) / ol);
  P.push(...slab((u, v) => {
    const th = thOut + (u - 0.5) * 3.4, f = fmax * (0.92 + 0.32 * (1 - v));
    return pt(th, f, R * 1.1);
  }, 12, 2, 0.012, { reg: REG.paul, uv: (u, v) => [u, v * 0.28], bones: ua, inside: () => C }));
  return P;
}

// ---- assembly ------------------------------------------------------------------------------

const geoCache = new Map();
function charGeometry(S) {
  const key = [S.outfit, S.hat, S.skin, S.look.hair, S.look.facial].join('|');
  if (!geoCache.has(key)) {
    const parts = [...bodyParts(S), ...headParts(S)].map(g => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k); return g; });
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

function makeSkeleton() {
  const names = Object.keys(B);
  const bones = names.map(n => { const b = new THREE.Bone(); b.name = n; return b; });
  const [body, hips, spine, chest, neck, head, armL, foreL, handL, armR, foreR, handR, legL, shinL, footL, legR, shinR, footR] = bones;
  body.add(hips); hips.position.set(0, J.hips, 0);
  hips.add(spine); spine.position.set(0, J.spine - J.hips, 0);
  spine.add(chest); chest.position.set(0, J.chest - J.spine, 0);
  chest.add(neck); neck.position.set(0, J.neck - J.chest, 0);
  neck.add(head); head.position.set(0, J.head - J.neck, 0); head.scale.setScalar(HU);
  for (const [s, a, f, h] of [[-1, armL, foreL, handL], [1, armR, foreR, handR]]) {
    chest.add(a); a.position.set(0, 1.405 - J.chest, 0.245 * s);
    a.add(f); f.position.set(0, -0.29, 0.005 * s);
    f.add(h); h.position.set(0, -0.265, 0);
  }
  for (const [s, l, sn, ft] of [[-1, legL, shinL, footL], [1, legR, shinR, footR]]) {
    hips.add(l); l.position.set(0, 0.905 - J.hips, 0.105 * s);
    l.add(sn); sn.position.set(0, -0.43, 0.013 * s);
    sn.add(ft); ft.position.set(0, -0.37, -0.01 * s);
  }
  return bones;
}

// Root at the feet. Inner model faces local +x; root.rotation.y = -PI/2 turns it to face +z.
// opts.outfit: 'player' | 'ed' | 'clerk' | 'dealer' | 'repo' (inferred from the old call
// signatures in town3d.js when absent).
export function buildCharacter(color, { hatIndex = 0, skinIndex = 0, scale = 1, eyeColor = null, outfit = null } = {}) {
  const spec = resolveSpec(color, { hatIndex, skinIndex, scale, eyeColor, outfit });
  const bones = makeSkeleton();
  const [body] = bones;
  const mesh = new THREE.SkinnedMesh(charGeometry(spec), charMaterial(spec));
  mesh.add(body);
  mesh.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones));
  body.scale.setScalar(scale);
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0 * scale, 0), 1.5 * scale);
  mesh.boundingBox = new THREE.Box3(new THREE.Vector3(-0.45, 0, -0.5).multiplyScalar(scale), new THREE.Vector3(0.45, 2.05, 0.5).multiplyScalar(scale));
  const root = new THREE.Group();
  root.add(mesh);
  root.rotation.y = -Math.PI / 2;
  root.userData.body = body;
  const inner = new THREE.Group();
  inner.add(root);
  const byName = Object.fromEntries(Object.keys(B).map((k, i) => [k, bones[i]]));
  const ch = { root: inner, body, legL: byName.legL, legR: byName.legR, armL: byName.armL, armR: byName.armR, torso: byName.spine, head: byName.head, bones: byName, mesh, spec, driven: false, seed: (hatIndex * 7 + skinIndex * 3 + (spec.outfit.length)) };
  applyPose(ch, idlePose(ch, 0));
  // NPCs (nobody drives them) idle on their own: breathing, weight shifts, a look around.
  mesh.onBeforeRender = () => { if (!ch.driven) { const t = performance.now() / 1000; if (t - (ch.idleT || 0) > 1 / 40) { ch.idleT = t; applyPose(ch, idlePose(ch, t)); } } };
  return ch;
}

// ---- posing --------------------------------------------------------------------------------

const POSE_KEYS = ['lL', 'lR', 'kL', 'kR', 'fL', 'fR', 'aL', 'aR', 'eL', 'eR', 'inL', 'inR', 'abL', 'abR', 'lean', 'bend', 'tw', 'ctw', 'head', 'headY', 'bob', 'spread', 'roll', 'wristL', 'wristR'];
function restPose() { const P = {}; for (const k of POSE_KEYS) P[k] = 0; P.abL = P.abR = 0.1; P.eL = P.eR = 0.18; return P; }
// NPC stances: the Repo Man stands hands-on-hips, the Dealer deals, Ed clasps his hands
const STANCE = {
  repo: { abL: 0.8, abR: 0.8, aL: -0.38, aR: -0.38, eL: 0.1, eR: 0.1, inL: 1.15, inR: 1.15, wristL: -0.3, wristR: -0.3, spread: 0.09, bend: 0.05, head: -0.06 },
  dealer: { aL: 0.38, aR: 0.44, eL: 0.75, eR: 0.7, inL: 0.25, inR: 0.3, bend: -0.06, head: 0.18 },
  ed: { aL: 0.12, aR: 0.12, eL: 0.95, eR: 0.95, inL: 0.95, inR: 0.95, abL: 0.2, abR: 0.2 },
};
function idlePose(ch, t) {
  const P = { ...restPose(), ...(STANCE[ch.spec.outfit] || {}) }, k = ch.seed;
  const br = Math.sin(t * 1.7 + k);
  P.bend += -0.015 - br * 0.012;
  P.abL += br * 0.015; P.abR += br * 0.015;
  P.aL += 0.03 * Math.sin(t * 0.6 + k); P.aR += 0.03 * Math.sin(t * 0.7 + k * 2);
  P.headY = 0.35 * Math.sin(t * 0.23 + k) * Math.max(0, Math.sin(t * 0.11 + k * 3));
  P.head = 0.04 * Math.sin(t * 0.4 + k);
  const shift = Math.sin(t * 0.3 + k * 5);
  P.roll = shift * 0.025; P.spread = 0.03;
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
  ch.body.rotation.z = -P.lean;
}

// Knee angle that puts the foot back on the ground, given a thigh angle and how far the hips dropped.
function kneeFor(thigh, drop) {
  const L1 = 0.43, L2 = 0.4, hipY = 0.905 + drop;
  const ky = hipY - Math.cos(thigh) * L1;
  const a = Math.acos(Math.max(-1, Math.min(1, ky / L2)));
  return Math.min(0, -a - thigh);
}

// ---- other players --------------------------------------------------------------------------

const spring = (s, target, dt, k = 170, d = 11) => { s.v += (target - s.a) * k * dt; s.v *= Math.max(0, 1 - d * dt); s.a += s.v * dt; return s.a; };
const sp = () => ({ a: 0, v: 0 });

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
    this.phase += dt * (3 + v * 2.1);
    const ph = this.phase;
    const M = C.MODE, F = C.FLAG;
    const T = restPose();
    let tip = 0, drop = 0;
    T.head = -st.pitch * 0.6;
    const br = Math.sin(t * 1.8 + this.id);
    if (st.mode === M.KO) {
      tip = Math.PI / 2 - 0.06;
      T.lL = Math.sin(t * 3 + this.id) * 0.15; T.lR = -T.lL * 0.5; T.kL = -0.3; T.kR = -0.1;
      T.aL = 0.4; T.aR = 0.2; T.abL = 1.0; T.abR = 0.8; T.eL = 0.6; T.eR = 0.3; T.head = 0.25; T.headY = 0.4; T.spread = 0.18;
    } else if (st.mode === M.SEAT) {
      drop = -0.38;
      T.lL = T.lR = 1.5; T.kL = T.kR = kneeFor(1.5, drop) ; T.aL = T.aR = 0.75; T.eL = T.eR = 0.75; T.head = -st.pitch * 0.4; T.spread = 0.06;
    } else if (st.mode === M.CLIMB) {
      const c = Math.sin(t * 5 + this.id);
      T.aL = 2.75 + c * 0.35; T.aR = 2.75 - c * 0.35; T.eL = 0.35 - c * 0.25; T.eR = 0.35 + c * 0.25;
      T.lL = 0.55 + c * 0.4; T.lR = 0.55 - c * 0.4; T.kL = -0.9 - c * 0.4; T.kR = -0.9 + c * 0.4; T.lean = 0.1; T.head = -0.35;
    } else if (st.mode === M.AIR) {
      T.lL = 0.7; T.lR = -0.15; T.kL = -1.1; T.kR = -0.45; T.fL = 0.3; T.aL = 1.6; T.aR = 1.2; T.abL = T.abR = 0.45; T.eL = T.eR = 0.5; T.lean = 0.06;
    } else {
      // walk / run cycle: thigh swing, knee lift on the swing phase, toe-off, hip bob,
      // counter-swinging arms with bent elbows, a little twist through the spine
      const sprint = !!(st.flags & F.SPRINT);
      const g = Math.min(1, speed * 1.6);
      const A = (0.46 + 0.2 * speed) * g;
      for (const [side, off] of [['L', 0], ['R', Math.PI]]) {
        const p = ph + off, sn = Math.sin(p), cs = Math.cos(p);
        T['l' + side] = A * sn;
        T['k' + side] = -g * ((0.25 + 0.75 * speed) * Math.max(0, cs) ** 1.3 + 0.08);
        T['f' + side] = g * (0.35 * Math.max(0, -sn) * Math.max(0, cs) - 0.1 * Math.max(0, sn));
        T['a' + (side === 'L' ? 'R' : 'L')] = A * sn * (sprint ? 1.25 : 0.85);
        T['e' + (side === 'L' ? 'R' : 'L')] = 0.25 + (sprint ? 1.05 : 0.45) * g + 0.25 * g * Math.max(0, sn);
      }
      T.bob = g * (0.022 + 0.01 * speed) * Math.cos(2 * ph) - 0.012 * g;
      T.tw = 0.1 * g * Math.sin(ph); T.ctw = -0.14 * g * Math.sin(ph);
      T.bend = -(sprint ? 0.2 : 0.07) * g; T.lean = (sprint ? 0.08 : 0.03) * g;
      // idle on top: breathing + slow weight shift
      T.bend += -0.012 - br * 0.012 * (1 - g);
      T.abL += br * 0.015 * (1 - g); T.abR += br * 0.015 * (1 - g);
      T.roll = 0.025 * Math.sin(t * 0.35 + this.id * 2) * (1 - g);
      if (st.flags & F.CROUCH) {
        drop = -0.3;
        T.lL += 1.0; T.lR += 1.0; T.kL = kneeFor(T.lL, drop) + T.kL * 0.3; T.kR = kneeFor(T.lR, drop) + T.kR * 0.3;
        T.fL = -T.lL - T.kL; T.fR = -T.lR - T.kR; T.bend -= 0.45; T.lean += 0.05; T.aL += 0.35; T.aR += 0.35; T.eL += 0.4; T.eR += 0.4; T.head += 0.25;
      }
    }
    if ((st.flags & F.HOLDING) && st.mode !== M.KO && st.mode !== M.CLIMB) {
      const map = st.flags & F.MAP;
      T.aL = T.aR = map ? 0.85 : 1.3; T.eL = T.eR = map ? 1.0 : 0.35; T.abL = T.abR = map ? 0.18 : 0.06;
      if (map) T.head = Math.max(T.head, 0.3);
    }
    if (this.emote) {
      this.emote.t -= dt;
      const e = this.emote.e;
      if (e === '😂') { T.aL = 2.5 + Math.sin(t * 14) * 0.3; T.aR = 2.5 - Math.sin(t * 14) * 0.3; T.eL = T.eR = 0.6; T.bend = 0.15; T.head = -0.4; drop = Math.abs(Math.sin(t * 14)) * 0.06; }
      else if (e === '😭') { T.aL = 0.9; T.aR = 0.9; T.eL = T.eR = 2.0; T.abL = T.abR = 0.25; T.head = 0.7; T.bend = -0.35; T.headY = Math.sin(t * 6) * 0.15; }
      else if (e === '💀') { tip = Math.PI / 2 - 0.08; T.aL = Math.sin(t * 19) * 1.6; T.aR = -T.aL; T.abL = T.abR = 0.8; T.lL = Math.sin(t * 17) * 0.4; T.lR = -T.lL; }
      else if (e === '🤬') { T.aL = 2.3 + Math.sin(t * 22) * 0.6; T.aR = 2.3 - Math.sin(t * 22) * 0.6; T.eL = T.eR = 0.8; T.lL = Math.sin(t * 19) * 0.8; T.lR = -T.lL; T.kL = T.kR = -0.5; T.bend = -0.15; }
      else if (e === '👑') { T.aL = 2.9; T.aR = 2.9; T.abL = T.abR = 0.5; T.eL = T.eR = 0.15; T.lean = -0.08; T.bend = 0.2; T.head = -0.35; }
      else { this.tilt.rotation.y += dt * 12; T.abL = T.abR = 1.3; }
      if (this.emote.t <= 0) { this.emote = null; this.tilt.rotation.y = 0; }
    }
    const P = this.P;
    for (const k of POSE_KEYS) {
      const fast = k[0] === 'k' || k[0] === 'f' || k === 'bob';
      P[k] = this.sp(k, T[k], dt, k[0] === 'a' || k[0] === 'e' ? 150 : fast ? 260 : 170, k[0] === 'a' || k[0] === 'e' ? 9 : fast ? 16 : 11);
    }
    applyPose(this.ch, P);
    this.tilt.rotation.x = -this.sp('tip', tip, dt, 60, 7);
    this.tilt.position.y = this.sp('drop', drop + (st.mode === M.KO ? 0.06 : 0), dt, 90, 9);
    this.mic.visible = !!st.speaking && !st.walkieTx;
    this.walkie.visible = !!st.walkieTx;
    if (this.mic.visible || this.walkie.visible) {
      const k = 0.9 + Math.sin(t * 10) * 0.08;
      (this.mic.visible ? this.mic : this.walkie).scale.set(k, k / 2, 1);
    }
    this.label.visible = st.mode !== M.KO || Math.sin(t * 4) > 0;
  }
}

// ---- first-person hands ----------------------------------------------------------------------
// Chunky stitched leather gloves with flared gauntlet cuffs, a leather bracer and the
// sleeve in your color, built pointing down -z from the wrist (the group origin).

const FPA = [256, 256];
function fpHandGeometry(side) {
  const P = [];
  const k = 1.15;      // WoW-chunky
  const xf = (p) => [p[2] * k, p[0] * k, p[1] * k];        // lathe local (front, along, side) -> (x side, y up, z along)
  const seg = (rings, reg) => lathe(rings, { seg: 14, reg, atlas: FPA, xf });
  // gauntlet cuff (flared), bracer, sleeve: lathes along +z (toward the camera)
  P.push(seg([[0.0, 0.042, 0.032, 0], [0.03, 0.05, 0.036, 0.25], [0.105, 0.066, 0.05, 0.85], [0.118, 0.07, 0.054, 1], [0.12, 0.05, 0.04, 1]].map(([y, w, d, v]) => ({ y, w, d, db: d * 1.05, v })), FP.cuff));
  P.push(seg([[0.1, 0.048, 0.04, 0], [0.24, 0.054, 0.046, 1]].map(([y, w, d, v]) => ({ y, w, d, v })), FP.bracer));
  P.push(seg([[0.235, 0.06, 0.052, 0], [0.26, 0.064, 0.056, 0.12], [0.6, 0.07, 0.062, 1]].map(([y, w, d, v]) => ({ y, w, d, v })), FP.sleeve));
  // the hand: a flattened lathe down -z, back of the hand facing up
  P.push(seg([[0.015, 0.042, 0.03, 0], [-0.03, 0.05, 0.034, 0.35], [-0.08, 0.054, 0.031, 0.82], [-0.096, 0.05, 0.026, 0.94], [-0.104, 0.0, 0.0, 1]].map(([y, w, d, v]) => ({ y, w, d, db: d * 0.9, n: 2.8, v })), FP.palm));
  // fingers, curled
  const fx = [-0.036, -0.012, 0.012, 0.035], len = [0.92, 1.0, 0.97, 0.82];
  fx.forEach((x, i) => {
    const L = len[i];
    const path = bez([x, 0.006, -0.088], [x, 0.004, -0.088 - 0.05 * L], [x * 1.05, -0.02, -0.088 - 0.08 * L], [x * 1.05, -0.044 * L, -0.088 - 0.075 * L]);
    P.push(tube(v => path(v).map(c => c * k), v => (0.0145 - 0.002 * v) * k * Math.pow(Math.sin(Math.min(1, 0.1 + v * 0.9) * Math.PI), 0.35), 8, 6, { reg: FP.finger, atlas: FPA, ref: [1, 0, 0] }));
  });
  const tp = bez([-0.038, -0.006, -0.01], [-0.066, -0.004, -0.04], [-0.07, -0.01, -0.075], [-0.058, -0.016, -0.098]);
  P.push(tube(v => tp(v).map(c => c * k), v => (0.019 - 0.004 * v) * k * Math.pow(Math.sin(Math.min(1, 0.15 + v * 0.85) * Math.PI), 0.4), 8, 6, { reg: FP.thumb, atlas: FPA, ref: [0, 1, 0] }));
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
    this.L.position.set(-0.27, -0.4, -0.36); this.R.position.set(0.27, -0.4, -0.36);
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
    const w = this.w, idle = Math.sin(performance.now() / 1000 * 1.6) * 0.004;
    const bobL = Math.sin(t) * 0.014 * w + idle, bobR = Math.sin(t + Math.PI) * 0.014 * w + idle;
    const swayL = Math.cos(t) * 0.008 * w, swayR = Math.cos(t + Math.PI) * 0.008 * w;
    const pose = (h, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const k = Math.min(1, dt * 14);
      h.position.x += (x - h.position.x) * k; h.position.y += (y - h.position.y) * k; h.position.z += (z - h.position.z) * k;
      h.rotation.x += (rx - h.rotation.x) * k; h.rotation.y += (ry - h.rotation.y) * k; h.rotation.z += (rz - h.rotation.z) * k;
    };
    const st = me.mode;
    this.g.visible = st !== 'ko';
    if (st === 'climb') {
      const c = Math.sin(performance.now() / 160);
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
      pose(this.L, -0.25 + swayL, -0.355 + bobL, -0.33, 0.62, -0.32, 0.3);
      pose(this.R, 0.25 + swayR, -0.355 + bobR, -0.33, 0.62, 0.32, -0.3);
    }
  }
}

// ---- preview (tools/preview.mjs) ----
function posed(color, opts, P) { const ch = buildCharacter(color, opts); ch.driven = true; applyPose(ch, { ...restPose(), ...P }); return ch.root; }
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
  walker: () => posed('#00E5FF', { hatIndex: 2, skinIndex: 2 }, { lL: 0.6, lR: -0.6, kL: -0.15, kR: -0.9, fR: 0.3, aL: -0.5, aR: 0.5, eL: 0.4, eR: 0.7, bend: -0.08, tw: 0.08, ctw: -0.12 }),
  sitter: () => posed('#FFA033', { hatIndex: 3, skinIndex: 3 }, { lL: 1.5, lR: 1.5, kL: -1.5, kR: -1.5, aL: 0.75, aR: 0.75, eL: 0.75, eR: 0.75 }),
  climber: () => posed('#B26EFF', { hatIndex: 4, skinIndex: 4 }, { aL: 2.9, aR: 2.5, eL: 0.3, eR: 0.5, lL: 0.9, lR: 0.2, kL: -1.2, kR: -0.5 }),
  fphands: () => { const g = new THREE.Group(); const m = painted(handsAtlas('#00E5FF')); const L = new THREE.Mesh(fpHandGeometry(-1), m), R = new THREE.Mesh(fpHandGeometry(1), m); L.position.x = -0.14; R.position.x = 0.14; for (const h of [L, R]) { h.rotation.x = -Math.PI / 2 + 0.9; g.add(h); } g.scale.setScalar(4); return g; },
};
