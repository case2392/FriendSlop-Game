// People: every human in the game. Other players (PlayerView), the town NPCs
// (buildCharacter, used by town3d.js) and your own first-person hands (Hands).
//
// Style: WoW Classic humans with a dash of OSRS chunk: big shoulders, a barrel chest, a leather
// jerkin skirt with a tabard in the player's color hanging front and back, big gloves with real
// thumbs and grooved fingers, knee boots with turned-down cuffs and a welted sole, a bedroll on
// the back. Each person is ONE SkinnedMesh (one draw call + one in the shadow pass) on a 23-bone
// skeleton, textured with ONE hand-painted 512×768 atlas from paint/characters.js. The face is
// modeled (a broad blunt nose, a heavy brow ridge over deep sockets, cheekbones, a square chin
// with a flat front; a woman's is narrower and rounder, with a short nose, a small round chin and
// a slimmer neck) and painted in a few lit and shaded planes; beards and mustaches are modeled
// sheets and rolls that take their texture from the painted face. Geometry is smooth lathes,
// tubes and thick slabs, all built here; the detail lives in the texture.
//
// The crew: six kits (paint/characters.js KITS, picked by player id like the hat and the face):
// a boiled-leather dome, layered leather lames or a riveted iron dome on the shoulders, or none
// under the hood's capelet or a fur-collared leather mantle; one embroidered sigil on the tabard
// (wheel, coin, crossed wrenches, horseshoe, boot, lion); pouches, a flask, a map case or nothing
// on the belt; laced or plain bracers and jerkin front. The dye stays on the tabard, the cuff
// bands and the name label, so the crew stays tellable apart at a distance.
//
// The town folk: Honest Ed (burly, bald, a forked grizzled beard, a red shirt with its sleeves
// rolled to a fat cuff, bare hairy forearms, a one-piece leather shop apron with neck straps),
// the clerk (a barmaid's laced bodice, puffed blouse sleeves, a long gathered skirt with an
// apron, a high bun), the Dealer (pressed shirt with sleeve garters, pinstriped vest and trousers,
// a brass watch chain, green celluloid visor, slick hair, red-lit eyes, a fanned hand of cards in
// his left hand and his right on the table) and the Repo Man (scale 1.25 and a brute besides: a
// barrel chest, trapezius and forearms, a head a size up, plaid flannel, a canvas overall bib with
// a pocket, work gloves, a beanie with a pompom, brass aviators and a tow chain of real iron links
// worn like a bandolier, standing hands on hips).
//
// Frames: root at the feet; the model faces local +x inside, and root.rotation.y
// = -PI/2 turns it to face +z (unchanged from the old egg people). Bones rotate
// about local z to swing forward (legs, arms, head nod), as before. Extra bones:
// flapF / flapB carry the front and back of the skirt and tabard (they follow the
// forward-most / back-most thigh, so the cloth never cuts the legs), flapF2 lets the
// front flap's hem hang over the knees when sitting, `hat` (a child of the head) carries a
// brimmed hat, which tips over the face when its wearer is knocked out, and `map` (a child of
// the chest, at zero scale unless the map is raised) carries the third-person road map.
//
// HEAD FRAME (for accessories added to `head`): +x = where the face points, +y = up,
// +z = the character's right. The head bone has a uniform local scale of 1 head unit:
// HU = 0.025 × HS / 3.5 = 0.00886 m (× the character's scale). Everything on the head
// scales with HS, so in head units the landmarks never move: the eyes sit at about
// (11.5, 3.5, ±4), deep under the brow ridge; the nose bridge front at x ≈ 14 at eye
// height and the nose tip at about (18.4, -1.8, 0); the skull half-width at the eyes is
// ≈ 12.7, the crown at y ≈ 22, the chin at y ≈ -12. An accessory at (16.5, 4, 0) (the
// old placeholder shades) still sits just in front of the eyes. Exception: the Repo Man's head
// geometry is built 1.12× bigger about the head bone (the bone's scale is still HU), so his
// landmarks are 1.12× these; he wears modeled brass aviators of his own.
import { THREE, painted, tex, labelSprite, canvasTex } from './gfx.js';
import * as C from '/shared/constants.js';
import { mergeGeometries } from '/vendor/BufferGeometryUtils.js';
import { AW, AH, REG, HEAD_RINGS, HEAD_SCALE, headTh, headU, headV, hairWave, BEARD_TOP, GOATEE_TOP, MUSTACHES, mustacheAt, TORSO, TORSO_UP, hairlineDy, lerpTable, armV, ARM_LM, skirtV, dressV, DRESS_Y0, DRESS_Y1, APRON_Y0, APRON_Y1, resolveSpec, charAtlas, charGlow, handsAtlas, FP, labelColor } from './paint/characters.js';

const TAU = Math.PI * 2;
const HS = HEAD_SCALE;        // head size factor over HEAD_RINGS (WoW humans carry a big head)
const HU = 0.025 * HS / 3.5; // head-local unit (see the header): the eye line sits at y = 3.5
const clamp01 = x => Math.max(0, Math.min(1, x));
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const thOf = u => Math.PI - TAU * u;          // u .5 = front (+x), .25 = right (+z), .75 = left (-z)
const gauss = (x, s) => Math.exp(-(x * x) / (s * s));

// bone indices
const B = { body: 0, hips: 1, spine: 2, chest: 3, neck: 4, head: 5, armL: 6, foreL: 7, handL: 8, armR: 9, foreR: 10, handR: 11, legL: 12, shinL: 13, footL: 14, legR: 15, shinR: 16, footR: 17, flapF: 18, flapB: 19, flapF2: 20, hat: 21, map: 22 };
const ARM = s => s < 0 ? [B.armL, B.foreL, B.handL] : [B.armR, B.foreR, B.handR];
const LEG = s => s < 0 ? [B.legL, B.shinL, B.footL] : [B.legR, B.shinR, B.footR];
// spine joints (meters, body space)
const J = { hips: 0.95, spine: 1.06, chest: 1.25, neck: 1.475, head: 1.62, hipY: 0.92, upper: 0.3, fore: 0.275, thigh: 0.42, shin: 0.4 };
// limb joints depend on the build (s = -1 left, +1 right)
function frameOf(S) {
  const fem = !!S.look.female, bulk = S.bulk || 1, wide = 1 + (bulk - 1) * 0.9, bare = S.pauldrons === 'none';
  // (no pauldrons: the arm hangs a little in and down, so the shoulder is a dome on the trapezius' slope)
  const sh = (fem ? 0.226 : 0.262) * wide * (S.shoulderK || 1) * (bare ? 0.93 : 1), shY = (fem ? 1.415 : 1.425) - (bare ? 0.012 : 0);
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
    const r = R(v), th = (o.thOf || thOf)(u);
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

// atlas uv <-> a region's local (tu, tv) (the same mapping surf() uses)
const atlasUV = (reg, tu, tv, [aw, ah] = [AW, AH]) => [(reg.x + 0.5 + clamp01(tu) * (reg.w - 1)) / aw, 1 - (reg.y + 0.5 + (1 - clamp01(tv)) * (reg.h - 1)) / ah];
const localUV = (reg, a, b, [aw, ah] = [AW, AH]) => [(a * aw - reg.x - 0.5) / (reg.w - 1), 1 - ((1 - b) * ah - reg.y - 0.5) / (reg.h - 1)];
// uvInner for slab(): the inner surface samples rect (tv0..tv1 of `reg`) instead
const innerIn = (reg, tv0, tv1, from = reg) => (a, b) => { const [tu, tv] = localUV(from, a, b); return atlasUV(reg, tu, tv0 + (tv1 - tv0) * clamp01(tv)); };

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
  const parts = o.noInner ? [outer] : [outer, inner];      // (noInner: the back face is never seen; the rims still give the edge its thickness)
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
let femHead = false;   // true while a woman's head is built: shellPt / facePt follow her narrower jaw and neck
const femY = dyU => femHead ? Math.max(0, -0.05 - dyU) * 0.08 * HS : 0;
function shellPt(th, dy, off) {
  const p = skull(th, dy);
  if (femHead) { p[0] *= femNeck(dy / HS); p[1] += femY(dy / HS); p[2] *= femJaw(dy / HS); }
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

// The face's relief on top of the HEAD_RINGS skull (dy unscaled, offsets in unscaled
// head meters): a big nose, a heavy brow ridge over deep sockets, cheekbones, a
// muzzle, a square chin and jaw corners, temples pulled back so the face is a wedge.
function faceRelief(th, dy, fem) {
  const a = Math.abs(th);
  let fx = 0, rr = 0;
  fx += (fem ? 0.011 : 0.017) * gauss(dy + 0.013, 0.011) * gauss(th, (fem ? 0.13 : 0.17) + 0.05 * sstep(0.01, -0.02, dy));   // nose tip: broad and blunt
  fx += (fem ? 0.006 : 0.011) * sstep(0.032, 0.004, dy) * sstep(-0.028, -0.012, dy) * gauss(th, fem ? 0.1 : 0.12);       // bridge
  fx += (fem ? 0.005 : 0.012) * gauss(dy + 0.019, 0.007) * gauss(a - (fem ? 0.13 : 0.17), 0.08);                           // nostril wings
  fx += 0.008 * gauss(dy + 0.045, 0.014) * gauss(th, 0.42);                                                                  // the mouth's muzzle
  if (fem) fx += 0.012 * gauss(dy + 0.081, 0.01) * gauss(th, 0.24);                                                         // a small round chin
  else fx += 0.021 * gauss(dy + 0.081, 0.012) * Math.exp(-Math.pow(th / 0.24, 4));                                          // a square chin with a flat front
  rr += (fem ? 0.0035 : 0.016) * gauss(dy - 0.046, 0.011) * gauss(th, 0.78);                                                // brow ridge
  rr -= (fem ? 0.009 : 0.014) * gauss(dy - 0.024, 0.012) * gauss(a - 0.3, 0.17);                                            // eye sockets
  rr += (fem ? 0.0075 : 0.012) * gauss(dy + (fem ? -0.002 : 0.003), 0.015) * gauss(a - 0.64, 0.26);                        // cheekbones
  rr -= (fem ? 0.0036 : 0.006) * gauss(dy + 0.04, 0.014) * gauss(a - 0.72, 0.25);                                          // hollows under them
  rr -= 0.009 * gauss(dy - 0.045, 0.028) * gauss(a - 1.08, 0.3);                                                            // temples
  rr += (fem ? 0 : 0.012) * gauss(dy + 0.076, 0.014) * gauss(a - 0.95, 0.28);                                               // square jaw corners
  return [fx * Math.max(0, Math.cos(th)), rr];
}
// a woman's head: a narrower, rounder jaw, a slimmer neck (z scale and x scale at height dy, unscaled)
const femJaw = dy => 0.93 * (1 - 0.17 * sstep(-0.005, -0.075, dy)) * (1 - 0.06 * sstep(-0.1, -0.12, dy));
const femNeck = dy => 1 - 0.2 * sstep(-0.098, -0.118, dy);
// a point on the face surface (head-local meters), pushed `off` further out
function facePt(th, dyM, off, fem) {
  const p = skull(th, dyM), [fx, rr] = faceRelief(th, dyM / HS, fem), dy = dyM / HS;
  const c = Math.cos(th), s = Math.sin(th), xk = fem ? femNeck(dy) : 1, zk = fem ? femJaw(dy) : 1;
  return [(p[0] + (fx + rr * c) * HS) * xk + c * off, p[1] + (fem ? Math.max(0, -0.05 - dy) * 0.08 * HS : 0), (p[2] + rr * s * HS) * zk + s * off];
}
const HEAD_DY = [-0.15, -0.125, -0.106, -0.096, -0.088, -0.079, -0.07, -0.061, -0.052, -0.044, -0.036, -0.028, -0.02, -0.012, -0.004, 0.004, 0.013, 0.021, 0.029, 0.037, 0.045, 0.054, 0.066, 0.08, 0.098, 0.116, 0.134, 0.147, 0.156];

function headParts(S) {
  femHead = !!S.look.female;
  try { return headPartsOf(S); } finally { femHead = false; }
}
function headPartsOf(S) {
  const parts = [];
  const fem = S.look.female;
  const rings = HEAD_DY.map(dy => ({ y: dy * HS, w: lerpTable(HEAD_RINGS, dy, 1) * HS, d: lerpTable(HEAD_RINGS, dy, 2) * HS, db: lerpTable(HEAD_RINGS, dy, 3) * HS, n: fem && dy < -0.04 ? 2 + (lerpTable(HEAD_RINGS, dy, 4) - 2) * 0.3 : lerpTable(HEAD_RINGS, dy, 4), cx: lerpTable(HEAD_RINGS, dy, 5) * HS, v: lerpTable(HEAD_RINGS, dy, 6) }));
  parts.push(lathe(rings, {
    seg: 28, thOf: headTh, reg: REG.head, bones: headWeights, xf: toHead,
    deform(p, th, r) {
      const dy = r.y / HS, [fx, rr] = faceRelief(th, dy, fem);
      const c = Math.cos(th), s = Math.sin(th);
      const zk = fem ? femJaw(dy) : 1, xk = fem ? femNeck(dy) : 1;
      return [(p[0] + (fx + rr * c) * HS) * xk, p[1] + (fem ? Math.max(0, -0.05 - dy) * 0.08 * HS : 0), (p[2] + rr * s * HS) * zk];
    },
  }));
  // ears: a cupped bowl inside a raised rim, the back edge flaring away from the head
  for (const s of [-1, 1]) {
    const er = [[-0.03, 0], [-0.027, 0.55], [-0.017, 0.9], [-0.002, 1], [0.013, 1], [0.024, 0.82], [0.031, 0]].map(([dy, k], i, a) => ({ y: dy * HS * (fem ? 0.86 : 1), w: 0.0088 * k * HS, d: 0.019 * k * HS * (fem ? 0.86 : 1), db: 0.014 * k * HS * (fem ? 0.86 : 1), cx: (-0.006 - dy * 0.2) * HS, v: i / (a.length - 1) }));
    parts.push(lathe(er, {
      seg: 10, reg: REG.ear, bones: B.head,
      deform: (p, th, r, u, v) => {
        let z = p[2];
        if (z * s > 0) z *= 1 - 0.62 * gauss(th - s * Math.PI / 2, 0.8) * Math.pow(Math.sin(v * Math.PI), 1.5);
        return [p[0], p[1], z + s * Math.max(0, -(p[0] - (r.cx || 0))) * 0.45];
      },
      xf: p => toHead([p[0], p[1] + 0.008 * HS, p[2] + s * (fem ? 0.09 : 0.094) * HS]),
    }));
  }
  // hair shell
  const L = S.look, coveredByHat = ['hood', 'helm', 'beanie', 'bandana'].includes(S.hat);
  if (['short', 'slick', 'braid', 'bun', 'long'].includes(L.hair) && !coveredByHat) {
    const vol = L.hair === 'slick' ? 0.006 : L.hair === 'short' ? 0.017 : 0.013;
    parts.push(surf((u, v) => {
      const th = thOf(u);
      const h0 = (hairlineDy(th) + hairWave(th, L.hair)) * HS + (L.hair === 'slick' ? 0.006 : 0);
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
    }, 10, 6, 0.012, { reg: REG.beard, uv: (u, v) => [u, 1 - v], bones: p => { const t = sstep(1.5, 1.4, p[1]); return [[B.head, 1 - t], [B.neck, t * 0.5], [B.chest, t * 0.5]]; }, inside: () => toHead(HC) }));
  }
  if (L.hair === 'braid') {
    const path = bez(toHead([-0.1 * HS, 0.03 * HS, 0]), toHead([-0.15 * HS, -0.1 * HS, 0]), [-0.19, 1.42, 0], [-0.185, 1.22, 0]);
    parts.push(tube(path, (v) => (0.026 - 0.008 * v) * (0.85 + 0.15 * Math.abs(Math.sin(v * Math.PI * 7))) * Math.sqrt(Math.sin(Math.min(1, v * 1.02 + 0.02) * Math.PI)), 8, 14, {
      reg: REG.beard, ref: [0, 0, 1], bones: p => { const t = sstep(1.5, 1.32, p[1]); return [[B.head, 1 - t], [B.chest, t]]; },
    }));
    parts.push(tube(v => [-0.185, 1.22 - v * 0.05, 0], v => 0.022 * Math.sqrt(Math.sin(v * Math.PI)), 8, 4, { reg: REG.beard, ref: [1, 0, 0], bones: B.chest }));
  }
  if (L.hair === 'bun' && !coveredByHat) {
    // a big bun set high on the back of the head, so it shows from the front three-quarters
    const c = toHead([-0.075 * HS, 0.142 * HS, 0]);
    parts.push(lathe([0, 0.62, 0.92, 1, 0.94, 0.66, 0].map((k, i) => ({ y: (i / 6 - 0.5) * 0.1, w: 0.06 * k, d: 0.056 * k, v: i / 6 })), {
      seg: 12, reg: REG.beard, bones: B.head, xf: p => [c[0] + p[0] - p[1] * 0.55, c[1] + p[1] * 0.85 + p[0] * 0.3, c[2] + p[2]],
    }));
  }
  if (S.look.female && ['bun', 'braid', 'long'].includes(L.hair) && !coveredByHat) {
    // two loose locks slipping out at the temples: flat wavy ribbons lying along the cheeks
    for (const s of [-1, 1]) {
      parts.push(...slab((u, v) => {
        const th = s * (1.02 + 0.1 * v + (u - 0.5) * (0.16 - 0.08 * v) + 0.03 * Math.sin(v * 5)), dy = (0.07 - 0.12 * v) * HS;
        return toHead(shellPt(th, dy, 0.005 + 0.004 * Math.sin(v * Math.PI)));
      }, 2, 6, 0.006, { reg: REG.hair, uv: (u, v) => [0.28 + u * 0.12, 0.92 - v * 0.8], bones: B.head, inside: () => toHead(HC), noInner: true }));
    }
  }
  if (L.facial === 'beard') {
    // a full beard: up the cheeks into the sideburns, round the jaw, hanging below the
    // chin to a blunt (Ed: forked) point; the mustache overhangs the mouth on its own
    const bs = L.beard || 1, len = 0.045 * bs, fork = bs > 1.1 ? 0.3 : 0;
    parts.push(...beardSurface(S, {
      thMax: 1.42, top: BEARD_TOP,
      bot: a => a < 0.7 ? -0.09 - len * (1 - Math.pow(a / 0.7, 1.5)) * (1 - fork * gauss(a, 0.07)) : lerpTable([[0.7, -0.09], [1.0, -0.094], [1.2, -0.08], [1.42, -0.01]], a),
      off1: 0.014 + 0.006 * bs, taper: 0.45,
    }));
    parts.push(mustacheTube(S, MUSTACHES.beard, 0.0125 * (0.8 + 0.2 * bs)));
  }
  if (L.facial === 'goatee') {
    // a small tapered tuft hugging the chin
    parts.push(...beardSurface(S, { thMax: 0.42, top: GOATEE_TOP, bot: a => -0.09 - 0.017 * (1 - (a / 0.42) ** 2), off1: 0.009, taper: 0.3, nu: 10 }));
  }
  if (L.facial === 'mustache') parts.push(mustacheTube(S, MUSTACHES.mustache, 0.0145));
  if (S.shades) parts.push(...shadesParts());
  parts.push(...hatParts(S));
  return parts;
}

// A beard as a thick sheet over the jaw. u runs from the right sideburn round the front
// to the left one; v from its top edge (top: [|th|, dy] table, unscaled) down to its
// bottom edge (bot(|th|)). Below the chin it hangs free, tapering toward the point.
function beardSurface(S, { thMax, top, bot, off0 = 0.003, off1 = 0.016, taper = 0.4, nu = 16 }) {
  const fem = S.look.female, CH = -0.088;
  const at = (u, v) => { const th = (0.5 - u) * 2 * thMax, a = Math.abs(th), dyT = lerpTable(top, a), dyB = bot(a); return [th, dyT + (dyB - dyT) * Math.pow(v, 0.9)]; };
  return slab((u, v) => {
    const [th, dy] = at(u, v);
    const off = off0 + (off1 - off0) * Math.sin(Math.min(1, v * 1.7) * Math.PI / 2);
    if (dy >= CH) return toHead(facePt(th, dy * HS, off, fem));
    const p0 = facePt(th, CH * HS, off, fem), t = (CH - dy) / 0.05;
    return toHead([p0[0] + 0.016 * t - 0.006 * t * t, dy * HS, p0[2] * (1 - taper * Math.min(1, t))]);
  }, nu, 6, 0.008, { reg: REG.head, uv: (u, v) => { const [th, dy] = at(u, v); return [headU(th), headV(dy)]; }, bones: B.head, inside: () => toHead(HC) });
}
// A mustache: a thick tapered roll under the nose sweeping out past the mouth corners
// and drooping (or curling up at the ends: a handlebar). Textured from the face, where
// paintHead paints the mustache.
function mustacheTube(S, line, r) {
  const fem = S.look.female;
  const path = v => { const [th, dy] = mustacheAt(v, line); return toHead(facePt(th, dy * HS, 0.007 * HS + r * 0.4, fem)); };
  return tube(path, v => r * (1.1 - 0.75 * Math.pow(Math.abs(v - 0.5) * 2, 0.8)) * Math.pow(Math.sin(Math.min(1, 0.04 + v * 0.92) * Math.PI), 0.35), 8, 12, { reg: REG.head, uv: (u, v) => { const [th, dy] = mustacheAt(v, line); return [headU(th), headV(dy + 0.002 * Math.cos(u * TAU))]; }, ref: [1, 0, 0], bones: B.head });
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
  const head = { bones: B.hat };      // brimmed hats ride their own bone: knocked out, the hat tips over the face
  if (h === 'brim' || h === 'straw') {
    // a soft traveller's hat of leather: a tapered crown with a teardrop crease down the top and
    // two pinches at the front, the brim curling up at the sides and dipping front and back; or
    // a farmer's straw hat: a low round dome and a ragged, drooping brim
    const straw = h === 'straw';
    const base = 0.08 * HS, top = (straw ? 0.1775 : 0.19) * HS;
    const prof = straw ? [[1, 0], [0.97, 0.3], [0.88, 0.6], [0.7, 0.82], [0.4, 0.95], [0, 1]] : [[1, 0], [0.97, 0.2], [0.94, 0.35], [0.84, 0.62], [0.72, 0.82], [0.5, 0.95], [0, 1]];
    const rx = 0.13 * HS, rz = 0.122 * HS;
    P.push(lathe(prof.map(([k, t], i) => ({ y: base + (top - base) * t, w: rz * k, d: rx * k, db: rx * k, n: 2.1, cx: -0.008, v: i / (prof.length - 1) })), {
      seg: straw ? 18 : 20, reg: ACC, uv: (u, v) => crownUV(u, v), ...head, xf: toHead,
      deform: (p, th) => {
        if (straw) return p;
        const t = (p[1] - base) / (top - base), c = Math.cos(th);
        const crease = 0.02 * HS * gauss(p[2] / (rz * 0.55), 1) * sstep(0.5, 1.0, t) * (1 - 0.3 * Math.max(0, c));
        const pinch = 1 - (0.012 * HS / rx) * Math.max(gauss(th - 0.61, 0.32), gauss(th + 0.61, 0.32)) * sstep(0.4, 0.9, t);
        return [(p[0] + 0.008) * pinch - 0.008, p[1] - crease, p[2] * pinch];
      },
    }));
    const r0 = 0.1 * HS, r1 = (straw ? 0.24 : 0.235) * HS, nb = straw ? 40 : 24;
    P.push(...slab((u, v) => {
      const th = thOf(u), t = v;
      let r = r0 + (r1 - r0) * t;
      if (straw) r += (Math.sin(u * 61) * 0.5 + Math.sin(u * 23) * 0.5) * 0.009 * t + (Math.sin(u * 157) > 0.6 ? 0.014 : 0) * t * t;   // ragged, a few strands poking out
      const side = Math.sin(th) ** 2, front = Math.cos(th);
      const y = base + 0.004 - (straw ? 0.045 * t * t * (1 + 0.15 * Math.sin(u * 37)) : 0) + (straw ? 0 : 0.08 * side * t ** 1.7 - 0.025 * Math.abs(front) * t * (1 - side));
      return toHead([Math.cos(th) * r * 1.05 - 0.008, y, Math.sin(th) * r]);
    }, nb, 3, 0.012, { reg: ACC, uv: brimUV, ...head, closed: true, inside: () => toHead([0, base + 0.05, 0]) }));
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
      // a soft wool cowl: u runs from one edge of the face opening, round the back, to the
      // other; v from the neck to the top. The opening shows the face to the ears and
      // closes over the forehead; the cloth hangs loose round the neck and droops into a
      // point at the back; a thick rolled lip edges the opening.
      const lo = -0.116 * HS;
      const cowl = (u, v) => {
        const te = 1.36 * (1 - sstep(0.5, 1.0, v)) + 0.06, side = u < 0.5 ? 1 : -1, f = u < 0.5 ? u * 2 : (1 - u) * 2;
        const th = side * (te + (Math.PI - te) * f);
        const dy = lo + (CROWN + 0.008 - lo) * Math.pow(v, 0.9);
        const back = gauss(Math.abs(th) - Math.PI, 1.0);
        let p = shellPt(th, dy, 0.022 + 0.026 * (1 - v) ** 2 + 0.01 * back * v);
        const below = Math.max(0, -0.035 * HS - dy) / (0.08 * HS);      // the cowl flares out over the neck
        p = [p[0] * (1 + 0.1 * below), p[1], p[2] * (1 + 0.45 * below * below)];
        p[0] -= 0.055 * gauss(v - 1, 0.3) * back;                            // the point, drooping at the back
        p[1] -= 0.014 * gauss(v - 1, 0.25) * back;
        return toHead(p);
      };
      P.push(...slab(cowl, 18, 9, 0.016, { reg: ACC, uv: crownUV, bones: p => headWeights(p), inside: () => toHead(HC), uvInner: innerIn(ACC, 0.06, 0.38) }));
      // the rolled lip round the face opening
      const edge = t => { const q = t < 0.5 ? t * 2 : (1 - t) * 2; const p = cowl(t < 0.5 ? 0 : 1, Math.min(0.995, q)); return p; };
      P.push(tube(edge, () => 0.0125, 8, 20, { reg: ACC, uv: (u, v) => [v, 0.43 + u * 0.06], ref: [1, 0, 0], bones: p => headWeights(p) }));
      P.push(...capeletParts(S));
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
    if (h === 'beanie') {   // a squat pompom of yarn clumps
      P.push(lathe([0, 0.62, 0.92, 1, 0.86, 0.5, 0].map((k, i) => ({ y: CROWN + off - 0.004 + i * 0.0075, w: 0.034 * k, d: 0.032 * k, v: 0.2 + i * 0.12 })), {
        seg: 12, reg: ACC, uv: (u, v) => [u, 0.62 + v * 0.3], bones: B.head, xf: toHead,
        deform: (p, th, r, u, v) => { const k = 1 + 0.2 * Math.sin(th * 4 + 0.5) * Math.sin(v * Math.PI) + 0.12 * Math.sin(th * 7 + v * 9); return [p[0] * k, p[1] + 0.003 * Math.sin(th * 5) * Math.sin(v * Math.PI), p[2] * k]; },
      }));
    }
    if (h === 'bandana') {
      const k = toHead(shellPt(Math.PI, 0.0, off + 0.012));
      P.push(lathe([0, 0.8, 1, 0.8, 0].map((q, i) => ({ y: (i / 4 - 0.5) * 0.05, w: 0.03 * q, d: 0.022 * q, v: i / 4 })), { seg: 10, reg: ACC, uv: (u, v) => [u, 0.6 + v * 0.3], bones: B.head, xf: p => [k[0] + p[0] - 0.008, k[1] + p[1], k[2] + p[2]] }));
      for (const s of [-1, 1]) P.push(...slab((u, v) => [k[0] - 0.012 - v * 0.03, k[1] - 0.01 - v * 0.12, k[2] + s * (0.006 + v * 0.025) + (u - 0.5) * 0.04], 2, 4, 0.006,
        { reg: ACC, uv: (u, v) => [u * 0.2 + 0.4, 0.55 - v * 0.5], bones: p => { const t = sstep(1.6, 1.48, p[1]); return [[B.head, 1 - t], [B.neck, t]]; }, inside: () => [k[0] + 0.1, k[1], k[2]] }));
    }
    if (h === 'helm') {
      // a nasal guard and a pair of curling horns
      // a tapered iron nasal guard riveted to the rim, following the nose bridge a finger's width off the face
      P.push(...slab((u, v) => { const dy = (0.052 - v * 0.06) * HS; return toHead(facePt((u - 0.5) * (0.17 - 0.07 * v), dy, 0.011 + 0.003 * (1 - v), S.look.female)); }, 2, 5, 0.006,
        { reg: ACC, uv: (u, v) => [0.47 + u * 0.06, 0.25 - v * 0.2], bones: B.head, inside: () => toHead(HC) }));
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

// A draped capelet over the shoulders and back, open down the front: it follows the torso, folds
// radiate from the neck, the hem is scalloped a hand's width below the shoulder line. The hood's
// is wool; a mantle (kit 'mantle') is leather, a little longer, under a fur collar.
function capeletParts(S) {
  const mantle = !!S.mantle;
  return slab((u, v) => {
    const open = (mantle ? 0.3 : 0.2) + (mantle ? 0.32 : 0.42) * (1 - v) ** 1.5, th = open + (TAU - 2 * open) * u, a = Math.abs(Math.atan2(Math.sin(th), Math.cos(th)));
    const yTop = 1.478, hem = (mantle ? 1.3 : 1.33) + 0.016 * Math.cos(th * 7 + 0.4) - 0.022 * gauss(a - Math.PI / 2, 0.55) + 0.03 * gauss(a, 0.5) - (mantle ? 0.03 * gauss(a - Math.PI, 0.9) : 0);
    const y = hem + (yTop - hem) * v, R = torsoRing(Math.min(1.45, y), S);
    const off = 0.018 + 0.008 * Math.sin(th * 12) * (1 - v) + 0.012 * (1 - v) + (mantle ? 0.006 : 0);
    const [x, z] = ringXZ(th, R.w + off, R.d + off, R.db + off, R.n);
    const fr = Math.max(0, Math.cos(th)), hug = 1 - 0.28 * sstep(0.4, 1, v) * fr;
    return [x * hug, y, z * (1 - 0.1 * sstep(0.4, 1, v) * fr)];
  }, 30, 4, 0.01, { reg: REG.apron, uv: (u, v) => [u, v], bones: p => p[1] > 1.46 ? [[B.chest, 0.6], [B.neck, 0.4]] : [[B.chest, 1]], inside: () => [0, 1.4, 0], uvInner: innerIn(REG.apron, 0.0, 0.15) });
}
// The mantle's fur collar: a thick, clumpy roll of fur round the base of the neck, open at the throat.
function furCollarParts(S) {
  const path = v => {
    const th = 0.55 + (TAU - 1.1) * v, y = 1.462 - 0.012 * Math.max(0, Math.cos(th));
    const R = torsoRing(1.45, S), [x, z] = ringXZ(th, R.w + 0.03, R.d + 0.034, R.db + 0.03, R.n);
    return [x * 0.96, y, z];
  };
  return [tube(path, (v, th) => 0.037 * (1 + 0.2 * Math.max(0, Math.sin(v * 61 + th * 2)) * Math.max(0, Math.sin(th * 4 + v * 17)) + 0.14 * Math.sin(v * 29) * Math.cos(th * 2)) * Math.pow(Math.sin(Math.min(1, 0.03 + v * 0.94) * Math.PI), 0.25), 10, 32, {
    reg: REG.horn, uv: (u, v) => [u, (v * 3) % 1], ref: [0, 1, 0], bones: p => [[B.chest, 0.7], [B.neck, 0.3]],
  })];
}

// ---- body ----------------------------------------------------------------------------------

// per-height width scales for the build: women narrower in the chest and waist,
// big men wider all over
function torsoScale(y, S) {
  const b = S.bulk || 1;
  let kw = b, kd = b, kdb = b;
  if (S.brute) {
    // a barrel chest over a forward belly: broad at the ribs, tapering to the waist
    const chest = gauss(y - 1.3, 0.12), waist = gauss(y - 1.04, 0.1), hip = gauss(y - 0.86, 0.1);
    kw *= 1 + 0.14 * chest + 0.02 * waist - 0.02 * hip;
    kd *= 1 + 0.12 * chest;
    kdb *= 1 + 0.06 * chest;
  }
  if (S.shoulderK) kw *= 1 + (S.shoulderK - 1) * 0.7 * sstep(1.12, 1.36, y);
  // a barrel chest: deeper front and back between the ribs and the collarbones; the waist stays, so the V reads
  const rib = sstep(1.12, 1.2, y) * sstep(1.45, 1.38, y), fem = S.look.female;
  kd *= 1 + (fem ? 0.1 : 0.2) * rib; kdb *= 1 + (fem ? 0.08 : 0.15) * rib;
  if (fem) {
    const chest = gauss(y - 1.3, 0.13), waist = gauss(y - 1.06, 0.09), hip = gauss(y - 0.86, 0.09), neck = sstep(1.43, 1.48, y);
    kw *= (1 - 0.13 * chest - 0.15 * waist - 0.02 * hip) * (1 - 0.2 * neck);
    kd *= (1 - 0.1 * waist - 0.05 * chest) * (1 - 0.15 * neck);
    kdb *= (1 - 0.08 * chest + 0.04 * hip) * (1 - 0.15 * neck);
  }
  return [kw, kd, kdb];
}
function torsoRing(y, S) {
  const [kw, kd, kdb] = torsoScale(y, S);
  const r = { y, w: lerpTable(TORSO_UP, y, 1) * kw, d: lerpTable(TORSO_UP, y, 2) * kd, db: lerpTable(TORSO_UP, y, 3) * kdb, n: lerpTable(TORSO_UP, y, 4) };
  r.d += (S.belly || 0) * gauss(y - 1.06, 0.12);
  r.d += 0.012 * gauss(y - 1.33, 0.05);                        // pectorals
  r.db += 0.01 * gauss(y - 1.32, 0.06);                        // shoulder blades
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
  // a brute's trapezius: the shoulders slope up into a thick neck instead of stopping flat
  const TT = S.brute ? [...TORSO.filter(r => r[0] <= 1.41), [1.45, 0.19, 0.124, 0.128, 2.4, 0.93], [1.48, 0.125, 0.092, 0.098, 2.2, 0.97], [1.5, 0.075, 0.07, 0.074, 2.0, 0.99], [1.508, 0, 0, 0, 2, 1]] : TORSO;
  P.push(lathe(TT.map(([y, w, d, db, n, v], i) => {
    if (i < 3) { const [kw, kd, kdb] = torsoScale(0.79, S); return { y, w: w * kw, d: d * kd, db: db * kdb, n, v }; }
    if (y > 1.42 && S.brute) { const b = S.bulk; return { y, w: w * b, d: d * b, db: db * b, n, v }; }
    const R = torsoRing(y, S); return { y, w: R.w, d: R.d, db: R.db, n: S.brute ? R.n * 0.92 : R.n, v };
  }), { seg: 24, reg: REG.torso, bones: torsoWeights }));
  // a rolled collar round the neck
  if (S.collar) {
    // a folded neckline: a low soft roll of cloth round the base of the neck
    const prof = [[1.452, 0.0], [1.462, 0.7], [1.474, 1.0], [1.486, 0.75], [1.492, 0.3], [1.49, 0.0]];
    const nk = S.look.female ? 0.86 : 1;
    P.push(lathe(prof.map(([y, k], i) => ({ y, w: (0.086 + 0.016 * k) * nk, d: (0.082 + 0.014 * k) * nk, db: (0.084 + 0.016 * k) * nk, n: 2.1, cx: -0.004, v: 1 - i / (prof.length - 1) })), {
      seg: 18, reg: REG.collar, bones: p => { const t = sstep(1.46, 1.51, p[1]); return [[B.chest, 1 - t * 0.5], [B.neck, t * 0.5]]; },
    }));
  }
  if (S.belt) P.push(...beltParts(S));
  if (S.skirt) P.push(...skirtParts(S));
  if (S.dress) P.push(...dressParts(S));
  if (S.apron) P.push(...apronParts(S));
  if (S.pack) P.push(...packParts(S));
  if (S.mantle) P.push(...capeletParts(S), ...furCollarParts(S));
  if (S.outfit === 'player') P.push(...mapParts());
  if (S.outfit === 'dealer') P.push(...cardParts(S, F));
  if (S.chain) P.push(...chainParts(S));
  if (S.bib) P.push(...bibParts(S));
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
    // the kit's belt gear: pouches (a big one on the right hip, a small one round the back on the
    // left), or a leather-wrapped flask in a loop, or a map case hanging at the back, or nothing
    const pouches = { pouch: [[1.05, 1], [-2.3, 0.75]], flask: [[1.05, 1]], mapcase: [[-1.1, 0.85]], none: [] }[S.beltX || 'pouch'];
    const hipW = th => () => [[B.hips, 0.6], [Math.sin(th) > 0 ? B.legR : B.legL, 0.4]];
    const onHip = (th, y, lift = 0) => { const pr = torsoRing(0.95, S), [px, pz] = ringXZ(th, pr.w + off + lift, pr.d + off + lift, pr.db + off + lift, pr.n); return [px, y, pz]; };
    if (S.beltX === 'flask') {
      // a flat flask in a leather loop on the left hip, a brass cap
      const th = -1.15, [px, py, pz] = onHip(th, 0.875, 0.02), c = Math.cos(th), sn = Math.sin(th);
      const xf = p => [px + p[0] * c - p[2] * sn, py + p[1], pz + p[0] * sn + p[2] * c];
      P.push(lathe([0, 0.75, 0.97, 1, 0.96, 0.8, 0.42, 0.36, 0.36].map((k, i) => ({ y: -0.075 + i * 0.019, w: 0.05 * k, d: 0.026 * k, db: 0.026 * k, n: 2.2, v: i / 8 })), { seg: 12, reg: REG.belt, uv: (u, v) => [u, 0.04 + v * 0.42], bones: hipW(th), xf }));
      P.push(lathe([1, 1.1, 1.1, 0.9, 0].map((k, i) => ({ y: 0.077 + i * 0.008, w: 0.019 * k, d: 0.019 * k, v: i / 4 })), { seg: 8, reg: REG.metal, uv: (u, v) => [u, 0.55 + v * 0.4], bones: hipW(th), xf }));
      P.push(lathe([0, 1, 1, 0].map((k, i) => ({ y: 0.012 + i * 0.012, w: 0.054 * k + 0.0001, d: 0.03 * k + 0.0001, n: 2.2, v: i / 3 })), { seg: 12, reg: REG.belt, uv: (u, v) => [u, 0.6 + v * 0.3], bones: hipW(th), xf }));   // the loop
    }
    if (S.beltX === 'mapcase') {
      // a leather map case slung at the back, tilted, brass end caps
      const th = 2.35, [px, py, pz] = onHip(th, 0.84, 0.045), c = Math.cos(th), sn = Math.sin(th), tilt = 0.6;
      const xf = p => { const y = p[1] * Math.cos(tilt) - p[0] * Math.sin(tilt), x0 = p[0] * Math.cos(tilt) + p[1] * Math.sin(tilt); return [px + x0 * c - p[2] * sn, py + y, pz + x0 * sn + p[2] * c]; };
      const caseR = 0.034, half = 0.17;
      P.push(lathe([[-half, 0], [-half, 0.92], [-half + 0.006, 1], [half - 0.006, 1], [half, 0.92], [half, 0]].map(([y, k], i) => ({ y, w: caseR * k, d: caseR * k, v: i / 5 })), { seg: 10, reg: REG.belt, uv: (u, v) => [u, 0.04 + v * 0.42], bones: hipW(th), xf }));
      for (const e of [-1, 1]) P.push(lathe([1.08, 1.12, 1.12, 1.08].map((k, i) => ({ y: e * (half - 0.03 + i * 0.012), w: caseR * k, d: caseR * k, v: i / 3 })), { seg: 10, reg: REG.metal, uv: (u, v) => [u, 0.55 + v * 0.4], bones: hipW(th), xf }));
    }
    for (const [th, sc] of pouches) {
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
      reg: REG.skirt, uv: (u, v) => [(pn.q + 0.02 + u * 0.96) / 4, skirtV(yOf(v))], noInner: true,
      // the side panels follow their thigh three-quarters of the way, so a seated
      // person's skirt drapes over the thighs instead of jutting out flat
      bones: p => { const t = sstep(0.97, 0.86, p[1]) * (pn.q % 2 ? 0.75 : 1); return [[B.hips, 1 - t], [pn.bone, t]]; },
      inside: (u, v) => [0, yOf(v), 0],
    }));
  }
  // tabard flaps, front and back
  for (const back of [false, true]) {
    const pn = panels[back ? 2 : 0], hem = 0.45, top = 1.01;
    const yOf = v => hem + (top - hem) * v;
    P.push(...slab((u, v) => {
      const th = pn.th0 + (u - 0.5) * 2 * 0.5, y = yOf(v);
      const tuck = sstep(0.975, 1.005, y) * 0.016;     // tucked under the belt at the top
      const [x, z] = ringAt(th, y, skirtOff(pn, y) + 0.01 - tuck);
      return [x * (1 - 0.06 * (1 - Math.abs(Math.cos(th)))), y, z * 0.94];
    }, 6, 8, 0.008, {
      reg: back ? REG.flapB : REG.flap, uv: (u, v) => [back ? u : 1 - u, v],
      // the front flap's last hand's-breadth rides flapF2, so it drapes over the knees when sitting
      bones: p => { const t = sstep(0.985, 0.88, p[1]), t2 = back ? 0 : sstep(0.56, 0.5, p[1]); return [[B.hips, 1 - t], [pn.bone, t * (1 - t2)], [B.flapF2, t * t2]]; },
      inside: (u, v) => [0, yOf(v), 0],
    }));
  }
  return P;
}

// A long gathered skirt from the waist to the ankles (the clerk). The front half rides
// flapF and the back half flapB, so a stride pushes the cloth instead of cutting it.
const DRESS_TOP = DRESS_Y1, DRESS_HEM = DRESS_Y0;
function dressParts(S) {
  const prof = [[DRESS_TOP, 0.012, 0], [0.97, 0.018, 0], [0.9, 0.03, 0.01], [0.79, 0.04, 0.035], [0.6, 0.05, 0.09], [0.4, 0.055, 0.14], [0.22, 0.058, 0.18], [DRESS_HEM, 0.06, 0.2]];
  const rings = prof.map(([y, off, fl]) => {
    const R = torsoRing(Math.max(0.79, y), S);
    return { y, w: R.w + off + fl * 0.75, d: R.d + off + fl, db: R.db + off + fl, n: 2.1, v: dressV(y) };
  });
  return [lathe(rings, {
    seg: 26, reg: REG.skirt, uv: (u, v) => [u, dressV(rings[Math.round(v * (rings.length - 1))].y)],
    deform: (p, th, r) => {   // soft gathers round the hem
      const t = clamp01((DRESS_TOP - r.y) / (DRESS_TOP - DRESS_HEM)), k = 1 + 0.035 * t * Math.sin(th * 9 + 0.6);
      return [p[0] * k, p[1], p[2] * k];
    },
    bones: p => {
      const t = sstep(0.98, 0.82, p[1]), f = clamp01(0.5 + p[0] / 0.2);
      return [[B.hips, 1 - t], [B.flapF, t * f], [B.flapB, t * (1 - f)]];
    },
  })];
}

// Ed's leather shop apron: one piece, a bib wrapped round the chest (its edges turn back round the
// ribs), the skirt round the belly and hanging round the fronts of the thighs to the knees, two big
// soft folds hanging from the waist ties, and a strap from each top corner over the shoulder.
const apronHalf = y => 1.1 - 0.5 * sstep(1.0, 1.2, y);              // its half-angle round the body
function apronParts(S) {
  const P = [];
  P.push(...slab((u, v) => {
    const y = APRON_Y0 + (APRON_Y1 - APRON_Y0) * v;
    const corner = Math.max(0, Math.abs(u - 0.5) * 2 - 0.8) / 0.2;     // the bib's top corners round off
    const yy = y - 0.03 * corner * corner * sstep(1.24, 1.31, y);
    const th = (u - 0.5) * 2 * apronHalf(yy);
    const R = torsoRing(Math.max(0.8, Math.min(1.44, yy)), S), below = Math.max(0, 0.8 - yy);
    // two big soft folds from the ties, strongest toward the hem
    const folds = (0.013 * gauss(u - 0.31, 0.07) + 0.011 * gauss(u - 0.7, 0.06) - 0.004 * gauss(u - 0.5, 0.08)) * sstep(1.0, 0.62, yy);
    const off = 0.012 + 0.06 * below + folds;
    const [x, z] = ringXZ(th, R.w + off, R.d + off, R.db, R.n);
    return [x + below * 0.08, yy, z];
  }, 16, 12, 0.008, {
    reg: ACC, uv: (u, v) => [u, v], inside: (u, v) => [0, APRON_Y0 + (APRON_Y1 - APRON_Y0) * v, 0],
    bones: p => { if (p[1] > 0.955) return torsoWeights(p); const t = sstep(0.95, 0.8, p[1]); return [[B.hips, 1 - t], [B.flapF, t]]; },
  }));
  // the neck straps: from the bib's top corners up over the shoulders to the back of the neck
  for (const s of [-1, 1]) {
    const ctl = [[0.47, 1.27], [0.62, 1.38], [0.95, 1.455], [1.45, 1.488], [2.2, 1.45], [2.7, 1.4]];
    const at = v => { const f = v * (ctl.length - 1), i = Math.min(ctl.length - 2, Math.floor(f)), t = f - i; return [ctl[i][0] + (ctl[i + 1][0] - ctl[i][0]) * t, ctl[i][1] + (ctl[i + 1][1] - ctl[i][1]) * t]; };
    P.push(...slab((u, v) => {
      const [th0, y] = at(v), R = torsoRing(Math.min(1.47, y), S), rad = Math.max(0.08, (R.w + R.d) / 2);
      const th = s * (th0 + (u - 0.5) * 0.026 / rad), off = 0.014 + 0.004 * sstep(1.4, 1.47, y);
      const [x, z] = ringXZ(th, R.w + off, R.d + off, R.db + off, R.n);
      return [x, y + 0.004 * sstep(1.4, 1.48, y), z];
    }, 1, 10, 0.005, { reg: ACC, uv: (u, v) => [0.005 + u * 0.03, 0.15 + v * 0.7], inside: (u, v) => [0, at(v)[1] - 0.05, 0], bones: torsoWeights, noInner: true }));
  }
  return P;
}

// The Dealer's fanned hand of cards, held up in his left hand: five cards fanned round the palm,
// their faces toward him and their backs to the table. They are built in the hand's bind frame so
// that in his stance (DEALER_STANCE) they stand up out of his fist facing back and up.
const DEALER_STANCE = { aL: 0.3, eL: 1.55, inL: 0.55, abL: 0.1, wristL: -0.15, wiL: 0, aR: 0.72, eR: 0.18, inR: 0.22, abR: 0.22, wristR: -0.45, wiR: 0, bend: -0.12, head: 0.16 };
function cardParts(S, F) {
  const st = { ...DEALER_STANCE }, s = -1, sh = F.shoulder(s);
  // the hand bone's posed rotation, composed down the chain (spine, chest, arm, forearm, hand)
  const E = (x, y, z) => new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(x, y, z));
  const R = E(0, 0, st.bend * 0.5).multiply(E(0, 0, st.bend * 0.5)).multiply(E(st.abL, 0, st.aL)).multiply(E(-st.inL, 0, st.eL)).multiply(E(0, 0, st.wristL));
  const Ri = R.clone().transpose(), V3 = THREE.Vector3;
  const toBind = v => new V3(...v).normalize().applyMatrix4(Ri);
  const n = toBind([-0.85, 0.45, 0.18]), up0 = toBind([0.4, 1, 0.05]), side = new V3().crossVectors(up0, n).normalize(), up = new V3().crossVectors(n, side).normalize();
  const { k, kl } = handSize(S, F), pivot = new V3(sh[0] + 0.012 * k, sh[1] + WRIST - 0.075 * kl, sh[2] + 0.026 * k).addScaledVector(n, 0.012 * k);
  const W = 0.07, H = 0.1, reg = REG.pack, P = [];
  [-0.55, -0.28, 0, 0.28, 0.55].forEach((phi, i) => {
    const c = Math.cos(phi), sn = Math.sin(phi);
    const ax = side.clone().multiplyScalar(c).addScaledVector(up, sn), ay = up.clone().multiplyScalar(c).addScaledVector(side, -sn);
    P.push(...slab((u, v) => {
      const p = pivot.clone().addScaledVector(ax, (u - 0.5) * W).addScaledVector(ay, v * H - 0.018).addScaledVector(n, (i - 2) * 0.0016);
      return [p.x, p.y, p.z];
    }, 1, 1, 0.0018, { reg, uv: (u, v) => [0.02 + u * 0.44, 0.06 + v * 0.88], uvInner: (a, b) => { const [tu, tv] = localUV(reg, a, b); return atlasUV(reg, tu + 0.52, tv); }, bones: B.handL, inside: () => { const q = pivot.clone().addScaledVector(n, -0.1); return [q.x, q.y, q.z]; } }));
  });
  return P;
}

// The road map held up in front of the chest (third person). It rides the `map` bone, which
// sits at zero scale (collapsed out of sight inside the chest) unless the map is out.
const MAP_AT = [0.38, 1.22, 0];
function mapParts() {
  return slab((u, v) => {
    const x = (u - 0.5) * 0.3, y = (v - 0.5) * 0.22, curl = 0.012 * (x / 0.15) ** 2;
    return [MAP_AT[0] - y * 0.55 + curl, MAP_AT[1] + y * 0.84, x];       // tilted back toward the reader's face
  }, 6, 2, 0.004, { reg: REG.gear, uv: (u, v) => [1 - u, v], bones: B.map, inside: () => [MAP_AT[0] - 0.2, MAP_AT[1] + 0.1, 0] });
}

// A rolled bedroll strapped high across the shoulder blades, sagging a little in the middle.
function packParts(S) {
  const yc = S.pauldrons === 'none' ? 1.16 : 1.285;   // (under a capelet or a mantle it rides lower, below the hem)
  const R = torsoRing(yc, S), cx = -(R.db + 0.058), cy = yc;
  const rings = [0, 0.75, 0.97, 1, 1, 1, 0.97, 0.75, 0].map((k, i, a) => {
    const t = i / (a.length - 1);
    const q = k === 0 ? 0 : 0.4 + 0.6 * k; return { y: (t - 0.5) * 0.4 * (k === 0 ? 0.96 : 1), w: 0.06 * q, d: 0.064 * q, v: k < 0.9 ? 0.2 : 0.4 + 0.6 * t };
  });
  return [lathe(rings, {
    // the roll's body maps along v .4-1; its ends map round the spiral at (.5, .19)
    seg: 14, reg: REG.pack, bones: p => [[B.chest, 0.85], [B.spine, 0.15]],
    uv: (u, v) => { const i = Math.round(v * (rings.length - 1)), R = rings[i]; if (R.v >= 0.4) return [u, R.v]; const rr = R.w / 0.06; return [0.5 + 0.0425 * rr * Math.cos(u * TAU), 0.19 + 0.17 * rr * Math.sin(u * TAU)]; },
    xf: p => [cx + p[0], cy + p[2] * 0.95 - 0.014 * (1 - (p[1] / 0.2) ** 2), p[1]],
  })];
}

// The Repo Man's overall bib: heavy canvas wrapped to the chest and belly, rounded top corners,
// a stitched chest pocket standing proud of it with a lit lip.
function bibParts(S) {
  const P = [];
  const at = (a, y, off) => {
    const th = a * (0.64 - 0.12 * sstep(1.1, 1.3, y)), R = torsoRing(y, S);
    const [x, z] = ringXZ(th, R.w + off, R.d + off, R.db, R.n);
    return [x, y, z];
  };
  P.push(...slab((u, v) => {
    const a = (u - 0.5) * 2, corner = Math.max(0, Math.abs(a) - 0.72) / 0.28;
    const top = 1.36 - 0.03 * a * a - 0.045 * corner * corner;          // the top edge dips, its corners round off
    return at(a, 1.0 + (top - 1.0) * v, 0.012);
  }, 14, 8, 0.008, { reg: REG.apron, uv: (u, v) => [u, v], bones: torsoWeights, inside: (u, v) => [0, 1.0 + 0.33 * v, 0], noInner: true }));
  // the pocket (its texture is the bib's own painted pocket, u .36-.64, v .36-.78)
  P.push(...slab((u, v) => {
    const a = (u - 0.5) * 0.56, y = 1.12 + 0.14 * v, p = at(a, y, 0.012 + 0.012 * Math.sin(Math.min(1, v * 1.4) * Math.PI / 2) + 0.004 * Math.sin(u * Math.PI));
    return p;
  }, 4, 3, 0.006, { reg: REG.apron, uv: (u, v) => [0.36 + u * 0.28, 0.36 + v * 0.42], bones: torsoWeights, inside: (u, v) => [0, 1.12 + 0.14 * v, 0], noInner: true }));
  return P;
}

// The Repo Man's tow chain, worn like a bandolier over his right shoulder: big iron links, each a
// flattened torus, alternately lying flat on him and standing up, merged into his one mesh.
function chainParts(S) {
  const path = v => {
    const th = v * TAU, y = 1.21 + 0.24 * Math.sin(th);
    const R = torsoRing(Math.min(1.44, y), S), [x, z] = ringXZ(th, R.w + 0.03, R.d + 0.03, R.db + 0.03, R.n);
    return [x, y, z];
  };
  const N = 400, pts = [], len = [0];
  for (let i = 0; i <= N; i++) pts.push(path(i / N));
  for (let i = 1; i <= N; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
  const L = len[N], pitch = 0.072, n = Math.round(L / pitch), out = [];
  const reg = REG.gear, wts = p => p[1] > 1.3 ? [[B.chest, 1]] : p[1] > 1.1 ? [[B.chest, 0.5], [B.spine, 0.5]] : [[B.spine, 0.4], [B.hips, 0.6]];
  const V3 = THREE.Vector3;
  for (let k = 0; k < n; k++) {
    const d = (k + 0.5) * L / n; let i = 1; while (i < N && len[i] < d) i++;
    const c = new V3(...pts[i]), T = new V3(...pts[Math.min(N, i + 1)]).sub(new V3(...pts[Math.max(0, i - 1)])).normalize();
    const out0 = new V3(c.x, 0, c.z).normalize(), Bn = new V3().crossVectors(T, out0).normalize(), Nn = new V3().crossVectors(Bn, T).normalize();
    const g = new THREE.TorusGeometry(0.03, 0.0072, 4, 8);
    g.scale(1.45, 1, 1);
    const m = (k % 2 ? new THREE.Matrix4().makeBasis(T, Nn, Bn) : new THREE.Matrix4().makeBasis(T, Bn, Nn.clone().negate())).setPosition(c);   // (right-handed bases: standing up / lying flat)
    g.applyMatrix4(m);
    const U = g.attributes.uv, cnt = g.attributes.position.count;
    for (let q = 0; q < cnt; q++) { const [a, b] = atlasUV(reg, U.getX(q), 0.03 + U.getY(q) * 0.54); U.setXY(q, a, b); }
    const [si, sw] = weightsOf(wts, [c.x, c.y, c.z]);
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: cnt }, () => si).flat(), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: cnt }, () => sw).flat(), 4));
    out.push(g);
  }
  return out;
}

const ROLL_DY = ARM_LM.roll;   // where a rolled sleeve sits (a little over halfway down the upper arm)
const ARM_UP = [   // dy below the shoulder joint, half-width across (z), front, back: a round deltoid, a
  [0.064, 0.0, 0.0, 0.0],     // tapering upper arm, a slim elbow, a forearm swell, a slim wrist
  [0.056, 0.05, 0.056, 0.054],
  [0.036, 0.082, 0.086, 0.084],
  [0.005, 0.094, 0.092, 0.088],
  [-0.05, 0.089, 0.086, 0.08],
  [-0.11, 0.08, 0.082, 0.074],
  [-0.18, 0.072, 0.075, 0.068],
  [-0.25, 0.064, 0.066, 0.062],
  [-0.3, 0.06, 0.062, 0.061],
  [-0.35, 0.064, 0.069, 0.06],
  [-0.4, 0.061, 0.066, 0.057],
  [-0.44, 0.056, 0.059, 0.052],
];
// no pauldron: a lower, rounder shoulder cap (it replaces the rows of ARM_UP above dy -0.06)
const ARM_CAP = [
  [-0.004, 0.0, 0.0, 0.0],
  [-0.01, 0.05, 0.054, 0.052],
  [-0.024, 0.078, 0.082, 0.08],
  [-0.05, 0.088, 0.087, 0.082],
];
const ARM_GLOVE = [   // a gauntlet: a rolled rim flaring out over the forearm, tapering to the wrist
  [-0.448, 0.057, 0.06, 0.053],
  [-0.453, 0.072, 0.076, 0.069],
  [-0.468, 0.077, 0.081, 0.073],
  [-0.492, 0.069, 0.073, 0.065],
  [-0.535, 0.058, 0.062, 0.055],
  [-0.575, 0.05, 0.054, 0.047],
];
const ARM_BARE = [
  [-0.48, 0.054, 0.057, 0.05],
  [-0.53, 0.046, 0.049, 0.043],
  [-0.575, 0.04, 0.044, 0.038],
];
const HAND = [   // a hanging hand: slim across (the palm faces the leg), broad front to back, fingers curling in
  [-0.598, 0.027, 0.047, 0.045],
  [-0.632, 0.027, 0.052, 0.049],
  [-0.67, 0.026, 0.053, 0.049],
  [-0.705, 0.024, 0.051, 0.046],
  [-0.738, 0.021, 0.045, 0.04],
  [-0.764, 0.015, 0.033, 0.028],
  [-0.778, 0.0, 0.0, 0.0],
];
// Hand size: k = across and front to back, kl = length below the wrist. Big WoW mitts that
// carry the chunk of the pauldrons and boots on down past the elbow (a glove is a size up again).
function handSize(S, F) {
  const bare = S.hands === 'bare';
  const k = (bare ? 1.28 : S.hands === 'workglove' ? 1.62 : 1.5) * (F.fem ? 0.86 : 1);
  return { k, kl: (bare ? 1.1 : 1.16) * (F.fem ? 0.94 : 1) };
}
// the forearm's girth over the table (1.2: a thick WoW forearm under the big shoulders)
const FOREARM_K = 1.2;
const WRIST = ARM_LM.wrist;
function armParts(S, F, s) {
  const [ua, fa, ha] = ARM(s), sh = F.shoulder(s);
  const bare = S.hands === 'bare';
  const { k: hk, kl } = handSize(S, F);
  const ak = (S.armBulk || 1) * (S.bulk || 1) * (F.fem ? 0.86 : 1);
  const rolled = S.arms === 'rolled';
  const fk = S.forearm || 1, FK = F.fem ? 1.12 : FOREARM_K;
  // the forearm thickens in from the elbow (and the gauntlet or bare wrist with it)
  const fore = dy => 1 + (FK - 1) * sstep(-0.27, -0.37, dy);
  const UP = S.pauldrons === 'none' ? [...ARM_CAP, ...ARM_UP.filter(r => r[0] < -0.06)] : ARM_UP;
  const tab = [
    ...UP.map(([dy, w, d, db]) => {
      let roll = 0;
      if (S.arms === 'blouse') roll += 0.024 * gauss(dy + 0.12, 0.09) * sstep(0.07, 0.0, dy) - 0.008 * gauss(dy + 0.3, 0.02);    // puffed, gathered at the elbow
      if (S.arms === 'shirt') roll += 0.009 * gauss(dy + 0.09, 0.03) - 0.006 * gauss(dy + 0.125, 0.012);                           // the puff over a sleeve garter
      // a brute's (and Ed's) forearms swell toward the elbow; a rolled sleeve tapers in toward the shoulder
      const f = (dy < -0.31 ? 1 + (fk - 1) * gauss(dy + 0.37, 0.06) : 1) * (rolled ? 0.82 + 0.18 * sstep(-0.02, -0.2, dy) : 1) * fore(dy);
      return [dy, w * ak * f + roll, d * ak * f + roll, db * ak * f + roll];
    }),
    ...(bare ? ARM_BARE : ARM_GLOVE).map(([dy, w, d, db]) => { const f = FK * (bare ? ak : 1); return [dy, w * f, d * f, db * f]; }),
    ...HAND.map(([dy, w, d, db]) => [dy, w * hk, d * hk, db * hk]),
  ];
  // (the hand's rings stretch by kl below the wrist; their texture rows stay where they were)
  const hy = dy => dy < WRIST ? WRIST + (dy - WRIST) * kl : dy;
  const rings = tab.map(([dy, w, d, db]) => {
    const curl = dy < -0.66 ? (-0.66 - dy) / 0.12 : 0;
    return { y: hy(dy), y0: dy, w, d, db, n: dy < -0.585 ? 2.6 : 2, cx: 0.008 * curl * hk, cz: -0.02 * curl * curl * hk, v: armV(dy) };
  });
  const wts = p => {
    const dy = p[1] - sh[1];
    if (dy > -0.26) return [[ua, 1]];
    if (dy > -0.34) { const t = sstep(-0.26, -0.34, dy); return [[ua, 1 - t], [fa, t]]; }
    if (dy > -0.555) return [[fa, 1]];
    if (dy > -0.595) { const t = sstep(-0.555, -0.595, dy); return [[fa, 1 - t], [ha, t]]; }
    return [[ha, 1]];
  };
  // below the knuckles, three grooves across the back and the palm split the hand into four fingers
  // (with 12 segments there's a vertex column right on each groove: x = 0, +-d/2)
  const fingers = (p, th, r) => {
    if (r.y0 > ARM_LM.knuckle) return p;
    const t = sstep(ARM_LM.knuckle, ARM_LM.knuckle - 0.03, r.y0), xr = p[0] - (r.cx || 0), xn = xr / ((xr >= 0 ? r.d : r.db) || 1);
    const gr = gauss(xn + 0.5, 0.14) + gauss(xn, 0.14) + gauss(xn - 0.5, 0.14), cz = r.cz || 0;
    return [p[0], p[1], cz + (p[2] - cz) * (1 - 0.24 * gr * t)];
  };
  const P = [lathe(rings, { seg: 12, reg: REG.arm, bones: wts, deform: fingers, xf: p => [sh[0] + p[0], sh[1] + p[1], sh[2] + p[2] * s] })];
  if (rolled) {
    // the rolled sleeve: a fat torus of cloth round the upper arm, a little over halfway down
    const y0 = ROLL_DY, R = lerpTable(tab.map(r => [-r[0], r[1]]), -y0, 1), r0 = 0.018;
    const ring = Array.from({ length: 7 }, (_, i) => { const ph = Math.PI / 2 - i / 6 * TAU; return { y: y0 + r0 * Math.sin(ph) * 1.1, w: R + r0 * (0.4 + Math.cos(ph)), d: R * 1.04 + r0 * (0.4 + Math.cos(ph)), db: R * 0.98 + r0 * (0.4 + Math.cos(ph)), v: armV(ROLL_DY + 0.012 - 0.024 * i / 6) }; });
    P.push(lathe(ring, { seg: 10, reg: REG.arm, bones: ua, xf: p => [sh[0] + p[0], sh[1] + p[1], sh[2] + p[2] * s] }));
  }
  // the thumb (front, toward the body)
  const k = hk;
  // a proper thumb on the palm side of the front edge, angled forward and down, clear of the fingers
  const T = (x, dy, zin) => [sh[0] + x * k, sh[1] + WRIST + (dy - WRIST) * kl, sh[2] - s * zin * k];
  const path = bez(T(0.026, -0.59, 0.006), T(0.052, -0.608, 0.018), T(0.066, -0.638, 0.022), T(0.066, -0.672, 0.018));
  P.push(tube(path, v => (0.019 - 0.004 * v) * k * Math.pow(Math.sin(Math.min(1, 0.12 + v * 0.88) * Math.PI), 0.4), 8, 7, { reg: REG.arm, uv: (u, v) => [0.55 + u * 0.4, armV(-0.62) - v * 0.12], ref: [0, 0, 1], bones: ha }));
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
  [0.4, 0.092, 0.098, 0.094],
  [0.33, 0.092, 0.098, 0.096],
  [0.22, 0.087, 0.093, 0.089],
  [0.14, 0.084, 0.09, 0.086],
  [0.085, 0.081, 0.086, 0.081],
  [0.06, 0.056, 0.056, 0.056],
  [0.05, 0.0, 0.0, 0.0],
];
const LEG_WORK = [   // work trousers flaring a little and bunching over a short work boot
  [0.49, 0.084, 0.09, 0.082],
  [0.42, 0.084, 0.09, 0.084],
  [0.36, 0.088, 0.094, 0.088],
  [0.335, 0.095, 0.101, 0.095],
  [0.31, 0.091, 0.097, 0.092],
  [0.29, 0.095, 0.101, 0.097],
  [0.276, 0.084, 0.09, 0.086],
  [0.2, 0.084, 0.09, 0.086],
  [0.14, 0.083, 0.089, 0.085],
  [0.085, 0.08, 0.085, 0.08],
  [0.06, 0.056, 0.056, 0.056],
  [0.05, 0.0, 0.0, 0.0],
];
const LEG_PLAIN = [   // (a straight, full trouser leg down into the shoe: no pegs into big boots)
  [0.44, 0.08, 0.084, 0.081],
  [0.33, 0.079, 0.083, 0.08],
  [0.22, 0.076, 0.08, 0.077],
  [0.13, 0.074, 0.078, 0.075],
  [0.07, 0.058, 0.058, 0.058],
  [0.05, 0.0, 0.0, 0.0],
];
const FOOT = [ // x, half-width, up, down, center y, squareness, v  (a squarer, flatter toe than a clown's bulb)
  [-0.095, 0.0, 0.0, 0.0, 0.055, 2, 0.0],
  [-0.086, 0.05, 0.046, 0.05, 0.055, 2.4, 0.05],
  [-0.056, 0.062, 0.066, 0.054, 0.06, 2.6, 0.16],
  [0.0, 0.066, 0.08, 0.06, 0.066, 2.6, 0.33],
  [0.06, 0.068, 0.058, 0.053, 0.053, 2.8, 0.52],
  [0.13, 0.07, 0.045, 0.048, 0.048, 3.0, 0.70],
  [0.195, 0.066, 0.04, 0.043, 0.045, 3.0, 0.86],
  [0.234, 0.052, 0.033, 0.036, 0.044, 2.6, 0.95],
  [0.248, 0.0, 0.0, 0.0, 0.045, 2, 1.0],
];
function legParts(S, F, s) {
  const [th, sn, ft] = LEG(s), hip = F.hip(s), knee = F.knee(s), ank = F.ankle(s);
  const tall = S.boots === 'tall', shoe = S.boots === 'shoe';
  const lk = (F.fem ? 0.9 : 1.04) * (S.bulk ? 1 + (S.bulk - 1) * 0.8 : 1);
  const axis = y => {
    const a = y > knee[1] ? [knee, hip] : [ank, knee], t = (y - a[0][1]) / (a[1][1] - a[0][1]);
    return [a[0][0] + (a[1][0] - a[0][0]) * t, a[0][2] + (a[1][2] - a[0][2]) * t];
  };
  const tab = [...LEG_TOP, ...(tall ? LEG_TALL : S.boots === 'work' ? LEG_WORK : LEG_PLAIN)];
  const wts = p => {
    const y = p[1];
    if (y > 0.56) return [[th, 1]];
    if (y > 0.44) { const t = sstep(0.56, 0.44, y); return [[th, 1 - t], [sn, t]]; }
    if (y > 0.13) return [[sn, 1]];
    const t = sstep(0.13, 0.07, y); return [[sn, 1 - t], [ft, t]];
  };
  const P = [lathe(tab.map(([y, w, d, db]) => { const [ax, az] = axis(y); return { y, w: w * lk, d: d * lk, db: db * lk, cx: ax, cz: az * s, v: y }; }), { seg: 12, reg: REG.leg, bones: wts, xf: p => [p[0], p[1], p[2] * s] })];
  const k = shoe ? [0.86, 0.8, 0.92] : S.outfit === 'repo' ? [1.2, 1.16, 1.14] : F.fem ? [0.9, 0.92, 0.9] : [1.06, 1.06, 1.05];
  const nv = FOOT.length - 1;
  P.push(surf((u, v) => {
    const i = Math.round(v * nv), [x, w, up, dn, cy, n] = FOOT[i];
    const [a, b] = ringXZ(thOf(u), w * k[0], up * k[1], dn, n);
    const X = x * k[2], welt = 1 + 0.09 * sstep(-0.55, -0.85, a / Math.max(1e-4, dn));    // the sole's welt stands out round the bottom
    return [X * (1 + 0.04 * (welt - 1)), Math.max(0.002, cy * (shoe ? 0.85 : 1) + a), s * (Math.abs(ank[2]) + b * welt + 0.05 * Math.max(0, X))];
  }, 12, nv, { reg: REG.foot, uv: (u, v) => [u, FOOT[Math.round(v * nv)][6]], bones: p => p[0] < -0.03 && p[1] > 0.09 ? [[ft, 0.7], [sn, 0.3]] : [[ft, 1]], closed: true, inside: (u, v) => { const r = FOOT[Math.round(v * nv)]; return [r[0] * k[2], r[4], ank[2]]; } }));
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
  const out = [0, -0.25, s]; const ol = Math.hypot(...out);
  const thOut = Math.atan2((out[0] * E2[0] + out[1] * E2[1] + out[2] * E2[2]) / ol, (out[0] * E1[0] + out[1] * E1[1] + out[2] * E1[2]) / ol);
  if (S.shoulders === 'lames') {
    // three overlapping curved plates of boiled leather: a cap, then two lames, each lower one
    // a little bigger so it tucks under the one above; the lames wrap the outside of the arm
    const plates = [[0, 0.86, 1.0, null], [0.72, 1.22, 1.06, 2.3], [1.04, 1.56, 1.12, 2.0]];
    plates.forEach(([f0, f1, k, span]) => {
      P.push(...slab((u, v) => {
        const th = span ? thOut + (u - 0.5) * span : thOf(u), f = f1 - (f1 - f0) * v;
        return pt(th, f, R * k * (1 + 0.05 * Math.cos(th)) * (1 + 0.06 * gauss(v, 0.12)));
      }, span ? 12 : 18, 3, 0.012, { reg: REG.paul, uv: (u, v) => [u, 0.32 + v * 0.68], bones: ua, closed: !span, inside: () => Cc, noInner: !!span }));
    });
    // the cap's underside, closed by a cheap disc (you'd see the sky through the dome from below)
    P.push(surf((u, v) => pt(thOf(u), 0.82, R * (1 - v)), 8, 1, { reg: REG.paul, uv: () => [0.5, 0.1], bones: ua, closed: true, inside: () => [Cc[0] + A[0] * 0.3, Cc[1] + A[1] * 0.3, Cc[2] + A[2] * 0.3] }));
    return P;
  }
  P.push(...slab((u, v) => {
    const th = thOf(u), f = (1 - v) * fmax;
    const lip = 1 + 0.075 * gauss(v, 0.07);
    return pt(th, f, R * lip * (1 + 0.05 * Math.cos(th)));
  }, 18, 7, 0.014, { reg: REG.paul, uv: (u, v) => [u, 0.32 + v * 0.68], bones: ua, closed: true, inside: () => Cc, noInner: true }));
  // the dome's underside: a cheap disc across its rim (no inner skin: you'd only ever see it from below)
  P.push(surf((u, v) => pt(thOf(u), fmax, R * 1.075 * (1 - v)), 9, 1, { reg: REG.paul, uv: () => [0.5, 0.1], bones: ua, closed: true, inside: () => [Cc[0] + A[0] * 0.3, Cc[1] + A[1] * 0.3, Cc[2] + A[2] * 0.3] }));
  P.push(...slab((u, v) => {
    const th = thOut + (u - 0.5) * 3.2, f = fmax * (0.9 + 0.34 * (1 - v));
    return pt(th, f, R * 1.1);
  }, 12, 2, 0.012, { reg: REG.paul, uv: (u, v) => [u, v * 0.28], bones: ua, inside: () => Cc }));
  return P;
}

// ---- assembly ------------------------------------------------------------------------------
const FLAP2_Y = 0.53;   // where the front flap folds over the knees (a thigh's length below the hip)

const geoCache = new Map();
function charGeometry(S, F) {
  const key = [S.outfit, S.hat, S.skin, S.look.hair, S.look.facial, S.look.female ? 'f' : 'm', S.kit ?? '-'].join('|');
  if (!geoCache.has(key)) {
    const head = headParts(S);
    // the Repo Man's head is a size up, so it isn't a pinhead on his bulk (scaled about the head bone)
    if (S.brute) for (const g of head) { g.translate(0, -J.head, 0); g.scale(1.12, 1.12, 1.12); g.translate(0, J.head, 0); }
    const parts = [...bodyParts(S, F), ...head].map(g => { for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(k)) g.deleteAttribute(k); return g; });
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
  by.flapF.add(by.flapF2); by.flapF2.position.set(0.17, FLAP2_Y - J.hipY, 0);
  by.head.add(by.hat);
  by.chest.add(by.map); by.map.position.set(MAP_AT[0], MAP_AT[1] - J.chest, MAP_AT[2]);    // (bound at scale 1; applyPose collapses it)
  return bones;
}

// Root at the feet. Inner model faces local +x; root.rotation.y = -PI/2 turns it to face +z.
// opts.outfit: 'player' | 'ed' | 'clerk' | 'dealer' | 'repo' (inferred from the old call
// signatures in town3d.js when absent). opts.variant: a player's kit, 0-5 (defaults to hatIndex).
export function buildCharacter(color, { hatIndex = 0, skinIndex = 0, scale = 1, eyeColor = null, outfit = null, variant = null } = {}) {
  const spec = resolveSpec(color, { hatIndex, skinIndex, scale, eyeColor, outfit, variant });
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

const POSE_KEYS = ['lL', 'lR', 'kL', 'kR', 'fL', 'fR', 'aL', 'aR', 'eL', 'eR', 'inL', 'inR', 'abL', 'abR', 'lean', 'bend', 'tw', 'ctw', 'head', 'headY', 'bob', 'spread', 'roll', 'wristL', 'wristR', 'wiL', 'wiR', 'hatOff', 'mapK', 'toe', 'sway'];
// At rest the arms bow: the upper arm hangs out from the shoulder pad, the elbow bends ~15 deg
// forward and the forearm swings back in (inL), so the big hands hang by the front of the thighs,
// turned in toward them a little more at the wrist (wiL), never stiff tubes straight down.
function restPose() { const P = {}; for (const k of POSE_KEYS) P[k] = 0; P.abL = P.abR = 0.27; P.eL = P.eR = 0.26; P.inL = P.inR = 0.3; P.wristL = P.wristR = 0.2; P.wiL = P.wiR = 0.16; return P; }
// The heroic WoW idle, layered on a pose by weight w (0 = none): feet apart and turned out, knees
// a little soft, chest up, and a slow (~4.5 s) weight shift: the hips sway and roll over one leg
// while the opposite shoulder dips.
function heroicIdle(P, t, k, w = 1) {
  P.spread += 0.038 * w; P.toe += 0.14 * w;
  P.lL += 0.05 * w; P.lR += 0.05 * w; P.kL -= 0.1 * w; P.kR -= 0.1 * w; P.fL += 0.05 * w; P.fR += 0.05 * w;
  P.bend += 0.05 * w;
  const sh = Math.sin(t * 1.4 + k * 1.7);
  P.roll += 0.035 * sh * w; P.sway += 0.015 * sh * w;
}
// NPC stances: the Repo Man stands hands-on-hips, the Dealer deals, Ed leans on his counter
const STANCE = {
  repo: { abL: 0.76, abR: 0.76, aL: -0.24, aR: -0.24, eL: 0.36, eR: 0.36, inL: 1.6, inR: 1.6, wristL: 0.35, wristR: 0.35, wiL: 0, wiR: 0, spread: 0.13, bend: 0.05, head: -0.1 },
  dealer: DEALER_STANCE,
  ed: { aL: 0.35, aR: 0.35, eL: 1.05, eR: 1.05, inL: 0.75, inR: 0.75, abL: 0.18, abR: 0.18, bend: -0.04 },
  clerk: { aL: 0.1, aR: 0.12, eL: 0.5, eR: 0.45, inL: 0.5, inR: 0.45, abL: 0.08, abR: 0.08 },
};
function idlePose(ch, t) {
  const st = STANCE[ch.spec.outfit] || {}, P = { ...restPose(), ...st }, k = ch.seed;
  const br = Math.sin(t * 1.7 + k);
  heroicIdle(P, t, k, st.spread ? 0.4 : 1);
  if (ch.spec.outfit === 'dealer') P.bend -= 0.05;          // (leaning on his table)
  P.bend += -0.015 - br * 0.012;
  P.abL += br * 0.015; P.abR += br * 0.015;
  P.aL += 0.03 * Math.sin(t * 0.6 + k); P.aR += 0.03 * Math.sin(t * 0.7 + k * 2);
  P.headY = 0.35 * Math.sin(t * 0.23 + k) * Math.max(0, Math.sin(t * 0.11 + k * 3));
  P.head += 0.04 * Math.sin(t * 0.4 + k);
  return P;
}
function applyPose(ch, P) {
  const b = ch.bones;
  // (the hips' sway is cancelled at the feet: the legs lean back over the planted soles)
  b.legL.rotation.set(P.spread + P.roll + P.sway / 0.82, P.toe, P.lL);
  b.legR.rotation.set(-P.spread + P.roll + P.sway / 0.82, -P.toe, P.lR);
  b.shinL.rotation.set(0, 0, P.kL); b.shinR.rotation.set(0, 0, P.kR);
  b.footL.rotation.set(-P.roll, 0, P.fL); b.footR.rotation.set(-P.roll, 0, P.fR);
  b.armL.rotation.set(P.abL, 0, P.aL); b.armR.rotation.set(-P.abR, 0, P.aR);
  b.foreL.rotation.set(-P.inL, 0, P.eL); b.foreR.rotation.set(P.inR, 0, P.eR);
  b.handL.rotation.set(-P.wiL, 0, P.wristL); b.handR.rotation.set(P.wiR, 0, P.wristR);
  b.hips.position.y = J.hips + P.bob; b.hips.position.z = P.sway;
  b.hips.rotation.set(-P.roll, P.tw * 0.5, 0);
  b.spine.rotation.set(P.roll * 0.75, P.tw * 0.5, P.bend * 0.5);
  b.chest.rotation.set(P.roll * 0.6, P.ctw, P.bend * 0.5);     // (net +.35 roll: the shoulders dip against the hips)
  b.neck.rotation.set(0, P.headY * 0.4, P.head * 0.35);
  b.head.rotation.set(0, P.headY * 0.6, P.head * 0.65);
  // a brimmed hat tipped forward over the face (knocked out): pivot forward, settle on the nose
  b.hat.rotation.set(0, 0, -1.42 * P.hatOff);
  b.hat.position.set(0.112 / HU * P.hatOff, 0.025 / HU * P.hatOff, 0);
  b.map.scale.setScalar(Math.max(1e-4, Math.min(1, P.mapK)));
  // the skirt front follows the forward-most thigh, the back the back-most one
  const fwd = Math.max(0, P.lL, P.lR) * 0.96;
  b.flapF.rotation.set(0, 0, fwd);
  b.flapF2.rotation.set(0, 0, -fwd * 0.92 * sstep(0.6, 1.4, fwd));     // sitting / crouching: the hem hangs over the knees
  b.flapB.rotation.set(0, 0, Math.min(0, P.lL, P.lR) * 0.96);
  ch.body.rotation.z = -P.lean;
}

// Knee angle that puts the foot back on the ground, given a thigh angle and how far the hips dropped.
function kneeFor(thigh, drop) {
  const L1 = J.thigh, L2 = J.shin, hipY = J.hipY + drop, ankleY = J.hipY - J.thigh - J.shin;   // the ankle rests 10 cm up
  const ky = hipY - Math.cos(thigh) * L1;
  const a = Math.acos(Math.max(-1, Math.min(1, (ky - ankleY) / L2)));
  return Math.min(0, -a - thigh);
}
// How far below the ground a posed foot's sole (heel or toe) would reach, in the body's
// sagittal plane, with the body leaning by `lean`: > 0 means lift the hips by that much.
const HEEL = [-0.1, -0.096], TOE = [0.25, -0.09];
function soleDip(P, drop) {
  let low = Infinity;
  const cl = Math.cos(P.lean), sl = Math.sin(P.lean);
  for (const [l, k, f] of [[P.lL, P.kL, P.fL], [P.lR, P.kR, P.fR]]) {
    const a2 = l + k, a3 = a2 + f;
    const ax = J.thigh * Math.sin(l) + J.shin * Math.sin(a2), ay = J.hipY + P.bob + drop - J.thigh * Math.cos(l) - J.shin * Math.cos(a2);
    for (const [hx, hy] of [HEEL, TOE]) {
      const x = ax + hx * Math.cos(a3) - hy * Math.sin(a3), y = ay + hx * Math.sin(a3) + hy * Math.cos(a3);
      low = Math.min(low, -x * sl + y * cl);
    }
  }
  return Math.max(0, -low);
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
    T.aL = 0.5; T.aR = 0.15; T.abL = 1.15; T.abR = 0.9; T.eL = 0.7; T.eR = 0.35; T.head = 0.4; T.headY = 0.3 * Math.sin(t * 0.7 + id); T.spread = 0.2; T.hatOff = 1;
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
      T['e' + o] = 0.26 + (sprint ? 1.1 : 0.45) * g + 0.3 * g * Math.max(0, sn);
    }
    T.bob = g * (0.024 + 0.012 * speed) * Math.cos(2 * ph) - 0.014 * g;
    T.tw = 0.12 * g * Math.sin(ph); T.ctw = -0.16 * g * Math.sin(ph);
    T.roll += 0.035 * g * Math.sin(ph);
    T.bend = -(sprint ? 0.22 : 0.07) * g; T.lean = (sprint ? 0.09 : 0.03) * g;
    T.abL += 0.06 * g; T.abR += 0.06 * g;
    // idle on top: the heroic stance, breathing, a slow weight shift
    heroicIdle(T, t, id, 1 - g);
    T.bend += -0.012 - br * 0.012 * (1 - g);
    T.abL += br * 0.015 * (1 - g); T.abR += br * 0.015 * (1 - g);
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
    if (map) { T.head = Math.max(T.head, 0.35); T.mapK = 1; }
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
  return { T, tip, drop: drop + (st.mode === M.KO ? 0.2 : 0), spin, grounded: st.mode !== M.KO && st.mode !== M.CLIMB && st.mode !== M.AIR && st.mode !== M.SEAT && !e };
}

// ---- other players --------------------------------------------------------------------------

// Paint a player's atlas and build their mesh ahead of time (e.g. when the lobby lists them),
// so a player joining mid-game doesn't stall a frame while their look is painted.
export function prewarmPlayer(p) {
  const S = resolveSpec(p.color, { hatIndex: p.id % 6, skinIndex: (p.id * 7) % 6, variant: p.id % 6 });
  charMaterial(S); charGeometry(S, frameOf(S));
}

const spring = (s, target, dt, k = 170, d = 11) => { s.v += (target - s.a) * k * dt; s.v *= Math.max(0, 1 - d * dt); s.a += s.v * dt; return s.a; };

export class PlayerView {
  constructor(scene, p) {
    this.id = p.id;
    this.group = new THREE.Group();
    this.ch = buildCharacter(p.color, { hatIndex: p.id % 6, skinIndex: (p.id * 7) % 6, variant: p.id % 6 });
    this.ch.driven = true;
    this.ch.root.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.tilt = new THREE.Group();
    this.tilt.add(this.ch.root);
    this.group.add(this.tilt);
    this.label = labelSprite(p.name, labelColor(p.color), 40);
    this.label.position.y = ['brim', 'straw', 'helm'].includes(this.ch.spec.hat) ? 2.12 : 2.05;   // a hand above the hat
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

  dispose(scene) {
    scene.remove(this.group);
    this.ch.mesh.skeleton.dispose();     // (the geometry and the atlas are shared and cached: keep them)
    for (const s of [this.label, this.mic, this.walkie]) { s.material.map?.dispose(); s.material.dispose(); }
  }

  sp(key, target, dt, k = 170, d = 11) { const s = this.s[key] || (this.s[key] = { a: target, v: 0 }); return spring(s, target, dt, k, d); }

  update(dt, t, st) {
    // st: {pos, yaw, pitch, mode, flags, speaking, walkieTx}
    this.group.position.set(st.pos.x, st.pos.y, st.pos.z);
    // knocked out, the body lies centered on the feet along world z, like the physics capsule
    const ko = this.sp('ko', st.mode === C.MODE.KO ? 1 : 0, dt, 60, 9);
    const snap = Math.round(st.yaw / Math.PI) * Math.PI;
    this.group.rotation.y = st.yaw + (snap - st.yaw) * ko;
    this.tilt.position.z = 0.9 * ko;
    let v = this.prev ? Math.hypot(st.pos.x - this.prev.x, st.pos.z - this.prev.z) / Math.max(dt, 1e-3) : 0;
    if (v > 25) v = 0;   // teleports
    if (!this.prev) this.prev = { x: 0, y: 0, z: 0 };
    this.prev.x = st.pos.x; this.prev.y = st.pos.y; this.prev.z = st.pos.z;
    this.vel += (v - this.vel) * Math.min(1, dt * 10);
    v = this.vel;
    const speed = Math.min(1.4, v / 4.4);
    // one stride (two steps) per ~1.5 m walked; a slow shuffle in place when barely moving
    this.phase += dt * (2.6 + v * 2.05);
    if (this.emote) { this.emote.t -= dt; if (this.emote.t <= 0) { this.emote = null; this.tilt.rotation.y = 0; } }
    const { T, tip, drop, spin, grounded } = playerPose(st, { t, ph: this.phase, speed, id: this.id, emote: this.emote?.e });
    if (spin) this.tilt.rotation.y += dt * spin;
    const P = this.P;
    for (const k of POSE_KEYS) {
      const arm = k[0] === 'a' || k[0] === 'e' || k[0] === 'i' || k[0] === 'w';
      const fast = k[0] === 'k' || k[0] === 'f' || k === 'bob';
      P[k] = this.sp(k, T[k], dt, arm ? 150 : fast ? 260 : 170, arm ? 9 : fast ? 16 : 11);
    }
    const dropNow = this.sp('drop', drop, dt, 90, 9);
    // the springs run at different rates: keep the planted sole on the ground, never under it
    const bob = P.bob;
    if (grounded) P.bob += soleDip(P, dropNow);
    applyPose(this.ch, P);
    P.bob = bob;
    this.tilt.rotation.x = -this.sp('tip', tip, dt, 60, 7);
    this.tilt.position.y = dropNow;
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
// Big WoW-style leather gauntlets: a flared, riveted cuff banded in your color, a laced
// bracer, your sleeve; a padded glove with stitched seams, riveted knuckle studs and thick
// two-jointed fingers in a relaxed curl. Built pointing down -z from the wrist (the mesh
// origin), back of the hand up, thumb on the inner side (-x for the right hand).

const FPA = [256, 256];
function fpHandGeometry(side) {
  const P = [];
  const k = 1.2;      // WoW-chunky
  const xf = (p) => [p[2] * k, p[0] * k, p[1] * k];        // lathe local (front, along, side) -> (x side, y up, z along)
  const seg = (rings, reg, n = 14) => lathe(rings, { seg: n, reg, atlas: FPA, xf });
  // the gauntlet cuff (flared, with a rolled rim), the laced bracer, then the sleeve: lathes along +z (toward the camera)
  P.push(seg([[0.0, 0.046, 0.034, 0], [0.025, 0.05, 0.037, 0.18], [0.07, 0.062, 0.05, 0.5], [0.108, 0.078, 0.064, 0.82], [0.122, 0.083, 0.069, 0.93], [0.134, 0.08, 0.066, 1], [0.138, 0.06, 0.05, 1]].map(([y, w, d, v]) => ({ y, w, d, db: d * 1.05, v })), FP.cuff, 18));
  P.push(seg([[0.13, 0.058, 0.05, 0], [0.185, 0.062, 0.054, 0.5], [0.24, 0.061, 0.053, 1]].map(([y, w, d, v]) => ({ y, w, d, v })), FP.bracer));
  P.push(seg([[0.236, 0.065, 0.057, 0], [0.26, 0.07, 0.062, 0.12], [0.6, 0.076, 0.068, 1]].map(([y, w, d, v]) => ({ y, w, d, v })), FP.sleeve));
  // the hand: a broad padded block down -z, back of the hand up, swelling at the knuckles
  const HR = [[0.016, 0.044, 0.031, 0], [-0.02, 0.053, 0.036, 0.3], [-0.058, 0.057, 0.036, 0.6], [-0.078, 0.06, 0.041, 0.78], [-0.09, 0.059, 0.039, 0.88], [-0.1, 0.054, 0.03, 0.96], [-0.106, 0.0, 0.0, 1]];
  P.push(seg(HR.map(([y, w, d, v]) => ({ y, w, d, db: d * 0.85, n: 2.8, v })), FP.palm, 18));
  // fingers: thick and jointed, curled into a loose fist (the index least, the little finger most),
  // each a little different, the tips tucked under the palm
  const fx = [-0.04, -0.0135, 0.013, 0.039], len = [0.95, 1.0, 0.96, 0.82], curl = [0.72, 0.82, 0.9, 1.0];
  fx.forEach((x, i) => {
    const L = len[i], c = curl[i], y0 = 0.004 - Math.abs(x) * 0.12, z0 = -0.086 + Math.abs(x) * 0.15;
    const path = bez([x, y0, z0], [x * 1.02, y0 - 0.006, z0 - 0.05 * L], [x * 1.04, y0 - 0.058 * L * c, z0 - 0.062 * L], [x * 1.04, y0 - 0.07 * L * c, z0 - 0.022 * L / c]);
    P.push(tube(v => path(v).map(q => q * k), v => (0.0158 - 0.0018 * v) * k * (1 + 0.1 * gauss(v - 0.42, 0.08) + 0.08 * gauss(v - 0.72, 0.07)) * Math.pow(Math.sin(Math.min(1, 0.1 + v * 0.9) * Math.PI), 0.3), 8, 10, { reg: FP.finger, atlas: FPA, ref: [1, 0, 0] }));
  });
  // the thumb, from the heel of the palm across to rest on the index finger's middle joint
  const tp = bez([-0.044, -0.012, -0.015], [-0.07, -0.016, -0.052], [-0.064, -0.034, -0.1], [-0.047, -0.044, -0.128]);
  P.push(tube(v => tp(v).map(q => q * k), v => (0.0185 - 0.003 * v) * k * (1 + 0.08 * gauss(v - 0.55, 0.1)) * Math.pow(Math.sin(Math.min(1, 0.15 + v * 0.85) * Math.PI), 0.35), 8, 9, { reg: FP.thumb, atlas: FPA, ref: [0, 1, 0] }));
  const geo = mergeGeometries(P.map(g => { for (const a of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(a)) g.deleteAttribute(a); return g; }), false);
  if (side < 0) {   // mirror for the left hand
    geo.scale(-1, 1, 1);
    const I = geo.index.array;
    for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; }
    geo.index.needsUpdate = true;     // (scale() already mirrored the normals, keeping surf()'s welded seams)
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
    if (this.board) for (const c of this.board.children) c.material = m;
  }
  showMap(canvas) {
    if (!this.map) {
      // a parchment sheet, gently curled, wound on a wooden roller at the top and the bottom
      this.mapTex = canvasTex(canvas);
      const W = 0.46, H = 0.34, sheet = new THREE.PlaneGeometry(W, H, 8, 1), SP = sheet.attributes.position;
      for (let i = 0; i < SP.count; i++) { const q = SP.getX(i) / (W / 2); SP.setZ(i, 0.022 * q * q); }
      sheet.computeVertexNormals();
      this.map = new THREE.Mesh(sheet, new THREE.MeshBasicMaterial({ map: this.mapTex, side: THREE.DoubleSide, fog: false, toneMapped: false }));
      this.map.position.set(0, -0.06, -0.42);
      this.map.rotation.x = -0.12;
      // the rollers reuse the glove atlas (the dark bracer leather): no new texture
      const roll = new THREE.CylinderGeometry(0.013, 0.013, W + 0.05, 10, 4);
      roll.rotateZ(Math.PI / 2);
      const RP = roll.attributes.position, U = roll.attributes.uv, r = FP.bracer;
      for (let i = 0; i < RP.count; i++) { const q = RP.getX(i) / (W / 2); RP.setZ(i, RP.getZ(i) + 0.022 * Math.min(1, q * q)); }
      for (let i = 0; i < U.count; i++) U.setXY(i, (r.x + 2 + U.getX(i) * (r.w - 4)) / FPA[0], 1 - (r.y + 2 + (1 - U.getY(i)) * (r.h - 4)) / FPA[1]);
      roll.computeVertexNormals();
      this.board = new THREE.Group();
      for (const y of [H / 2 + 0.006, -H / 2 - 0.006]) { const m = new THREE.Mesh(roll, this.L.material); m.position.set(0, y, 0.006); m.renderOrder = 2; this.board.add(m); }
      this.map.add(this.board);
      this.g.add(this.map);
    }
    if (this.mapTex.image !== canvas) {   // the map is painted once per day: upload it only when it changes
      this.mapTex.image = canvas;
      this.mapTex.needsUpdate = true;
    }
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
    } else if (me.holding?.type === 'map' && this.map?.visible) {
      // gripping the bottom roller near both ends, fingers curled over it
      pose(this.L, -0.205, -0.322 + bobL * 0.5, -0.385, 1.2, 0.25, 0.7);
      pose(this.R, 0.205, -0.316 + bobR * 0.5, -0.385, 1.2, -0.25, -0.7);
    } else if (me.holding) {
      pose(this.L, -0.2, -0.3 + bobL * 0.6, -0.4, 0.55, -0.85, 0.9);
      pose(this.R, 0.2, -0.3 + bobR * 0.6, -0.4, 0.55, 0.85, -0.9);
    } else {
      // loose fists low in the frame, knuckles forward and the backs of the hands turned up toward
      // you; not mirror twins: the left rides a little lower and turned, and idles on its own beat
      const idleL = Math.sin(now * 1.3 + 1.7) * 0.004;
      pose(this.L, -0.235 + swayL, -0.37 + bobL + idleL, -0.4, 0.62, -0.3, 0.5);
      pose(this.R, 0.235 + swayR, -0.36 + bobR, -0.4, 0.6, 0.28, -0.46);
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
