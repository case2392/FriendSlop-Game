// What the wildlife looks like (shared/mobs.js says what it is). Each critter is ONE skinned mesh in the loot
// material (one draw call, plus its shadow), built from the props kit (props3d.js) and painted in the loot
// atlas (paint/props.js: hide, horn, hoof). The rig is rigid: every part hangs whole off one bone (root,
// body, head, tail, four legs), so posing a critter is turning a handful of bones. A MobView poses it from
// its state (the snapshot's st, shared/mobs.js GST / RST) and how fast it's going, easing every joint.
//
// API: buildMob(type, W) -> { obj, view } · MobView.update(dt, t, st, camPos) · PREVIEW
import { THREE, shadowy, labelSprite } from './gfx.js';
import { LOOT } from '/shared/loot.js';
import { GST, RST, ST_MASK, ST_MOOD, ST_CARRY } from '/shared/mobs.js';
import { Build, lathe, sphere, limb, loft, mat4, lootMat, taperTube } from './props3d.js';
import { REGIONS as R, sub } from './paint/props.js';

const V3 = THREE.Vector3;
const BONES = ['root', 'body', 'head', 'tail', 'fl', 'fr', 'bl', 'br'];
const B = Object.fromEntries(BONES.map((k, i) => [k, i]));

// coats per biome (vertex tint on the painted hide): meadow brown, wheat-tawny, snow-pale, rust, sand
const COAT = {
  grumphorn: { meadow: [1, 1, 1], fields: [1.16, 1.02, 0.8], snow: [1.12, 1.12, 1.14], badlands: [1.24, 0.86, 0.68], desert: [1.3, 1.12, 0.86] },
};
const HORN_TINT = { snow: [1.05, 1.05, 1.08] };

// ---- the grumphorn ----------------------------------------------------------------------------------
// Model space: the origin is the collider's middle (a capsule lying along z, 0.7 m off the ground), +z is
// its nose, the ground at y -0.7. 2.9 m nose to rump, 1.5 m at the hump.
const GH_PIV = { body: [0, 0, 0], head: [0, 0.28, 0.98], tail: [0, 0.3, -1.3], fl: [0.4, -0.16, 0.62], fr: [-0.4, -0.16, 0.62], bl: [0.4, -0.16, -0.86], br: [-0.4, -0.16, -0.86] };
const GH_BODY = [
  { z: -1.42, w: 0.3, top: 0.28, bot: -0.1 }, { z: -1.22, w: 0.52, top: 0.48, bot: -0.28 }, { z: -0.8, w: 0.63, top: 0.56, bot: -0.38 },
  { z: -0.3, w: 0.67, top: 0.66, bot: -0.41 }, { z: 0.2, w: 0.69, top: 0.82, bot: -0.39 }, { z: 0.55, w: 0.66, top: 0.8, bot: -0.35 },
  { z: 0.86, w: 0.55, top: 0.62, bot: -0.3 }, { z: 1.06, w: 0.4, top: 0.44, bot: -0.18 },
];
const GH_HEAD = [
  { z: 0.9, w: 0.25, top: 0.38, bot: 0.0 }, { z: 1.08, w: 0.3, top: 0.45, bot: -0.12 }, { z: 1.28, w: 0.22, top: 0.31, bot: -0.21 },
  { z: 1.45, w: 0.18, top: 0.15, bot: -0.28 }, { z: 1.56, w: 0.22, top: 0.07, bot: -0.31 }, { z: 1.63, w: 0.18, top: 0.0, bot: -0.26 },
];
// a loft's middle height at z (its sections' (top + bot) / 2, between them)
function midAt(st, z) {
  let i = 1; while (i < st.length - 1 && st[i].z < z) i++;
  const a = st[i - 1], b = st[i], f = Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z || 1)));
  return ((a.top + a.bot) + ((b.top + b.bot) - (a.top + a.bot)) * f) / 2;
}
function grumphornGeo(biome) {
  const coat = COAT.grumphorn[biome] || COAT.grumphorn.meadow, horn = HORN_TINT[biome] || 1;
  const P = new Build();
  // the hide, with the hair hanging down: u runs nose to tail, v round the body from the spine (the painted
  // top) down either flank to the belly (the shaggy fringe)
  const hideUV = (st, z0, z1) => (x, y, z) => [Math.min(1, Math.max(0, (z - z0) / (z1 - z0))), 1 - Math.atan2(Math.abs(x), y - midAt(st, z)) / Math.PI];
  // the body: a barrel with a hump over the shoulders, and a shaggy skirt hanging off its belly
  P.add(loft(GH_BODY, 16, 2.4), R.hide, { uv: 'fn', fn: hideUV(GH_BODY, -1.45, 1.1), tint: coat, bone: B.body, crease: 70 });
  const skirt = GH_BODY.slice(1, -1).map(s => ({ z: s.z, w: s.w * 1.04, top: (s.top + s.bot) / 2, bot: s.bot - 0.12 }));
  P.add(loft(skirt, 14, 3), R.hide, { uv: 'fn', fn: hideUV(skirt, -1.45, 1.1), tint: coat.map(c => c * 0.85), bone: B.body, crease: 70 });
  // the head: a heavy brow, a narrower muzzle, then a broad bucket of a nose
  P.add(loft(GH_HEAD, 14, 2.3), R.hide, { uv: 'fn', fn: hideUV(GH_HEAD, 0.9, 1.65), tint: coat, bone: B.head, crease: 70 });
  // the nose pad (dark leather) and a beard under the chin
  P.add(sphere(1, 10, 6), R.boot, { at: mat4(0, -0.13, 1.63, 0, 0, 0, [0.17, 0.12, 0.05]), uv: 'keep', tint: 0.75, bone: B.head });
  P.add(lathe([[0, 0.02], [0.13, 0], [0.1, -0.16], [0, -0.24]], 8), R.hide, { at: mat4(0, -0.2, 1.3, 0, 0, 0, [1, 1, 1.4]), uv: 'fn', fn: (x, y) => [0.5, Math.min(1, Math.max(0, (y + 0.44) / 0.5)) * 0.4], tint: coat.map(c => c * 0.7), bone: B.head });
  // tiny eyes under the brow
  for (const sx of [-1, 1]) P.add(sphere(0.03, 6, 4), R.eye, { at: mat4(sx * 0.2, 0.26, 1.2), uv: 'keep', tint: 0.45, bone: B.head });
  // the horns: thick at the brow, sweeping out and back, then curling forward to points (it charges with them)
  for (const sx of [-1, 1]) {
    P.add(taperTube([[sx * 0.2, 0.42, 1.08], [sx * 0.48, 0.5, 1.0], [sx * 0.72, 0.44, 1.04], [sx * 0.86, 0.3, 1.18], [sx * 0.86, 0.25, 1.36], [sx * 0.76, 0.31, 1.5]], 0.11, 0.022, 16, 7), R.horn, { uv: 'keep', tint: horn, bone: B.head });
  }
  // the collar and its brass cowbell, hanging under the throat (on the head: it swings when the head does)
  P.add(new THREE.TorusGeometry(0.31, 0.035, 5, 16), R.leather, { at: mat4(0, 0.12, 1.0, 0, 0, 0, [1, 1.12, 1]), uv: 'keep', bone: B.head });
  P.add(lathe([[0, 0.02], [0.05, 0.02], [0.06, 0], [0.085, -0.12], [0.11, -0.2], [0.11, -0.21], [0, -0.21]], 10), R.brass, { at: mat4(0, -0.24, 1.04), uv: 'keep', bone: B.head });
  // the legs: stumpy, shaggy to the fetlock, a dark split hoof
  for (const leg of ['fl', 'fr', 'bl', 'br']) {
    const [x, y, z] = GH_PIV[leg], front = leg[0] === 'f';
    P.add(limb([x, y + 0.05, z], [x, -0.58, z + (front ? 0.04 : -0.02)], 0.17, 0.12, 10), R.hide, { uv: 'fn', fn: (vx, vy, vz) => [0.2 + 0.6 * ((Math.atan2(vx - x, vz - z) / (Math.PI * 2)) + 0.5), Math.min(1, Math.max(0, (vy + 0.6) / 0.6)) * 0.85], tint: coat.map(c => c * 0.9), bone: B[leg] });
    P.add(lathe([[0, 0], [0.13, 0], [0.14, 0.05], [0.12, 0.12], [0, 0.12]], 10), R.hoof, { at: mat4(x, -0.7, z + (front ? 0.04 : -0.02)), uv: 'keep', bone: B[leg] });
  }
  // the tail: a rope with a dark tuft
  P.add(limb([0, 0.3, -1.3], [0, -0.12, -1.52], 0.05, 0.03, 6), R.hide, { uv: 'fn', fn: (x, y) => [0.5, Math.min(1, Math.max(0, (y + 0.2) / 0.5))], tint: coat, bone: B.tail });
  P.add(sphere(1, 8, 5), R.hide, { at: mat4(0, -0.2, -1.55, 0, 0, 0, [0.08, 0.14, 0.08]), uv: 'fn', fn: (x, y) => [0.5, Math.min(1, Math.max(0, (y + 0.36) / 0.32)) * 0.3], tint: coat.map(c => c * 0.6), bone: B.tail });
  return P.done({ ao: 0.28, aoH: 0.5 });
}

const BUILD = { grumphorn: { geo: grumphornGeo, piv: GH_PIV } };
const cache = new Map();
function geoFor(type, biome) {
  const k = `${type}-${biome}`;
  if (!cache.has(k)) cache.set(k, BUILD[type].geo(biome));
  return cache.get(k);
}

// a fresh rig for one critter: the bones at their pivots, bound to the shared geometry
function rig(type, geo) {
  const piv = BUILD[type].piv, bones = {};
  bones.root = new THREE.Bone();
  bones.body = new THREE.Bone(); bones.root.add(bones.body);
  for (const k of BONES.slice(2)) { const b = new THREE.Bone(); b.position.set(...piv[k]); bones.body.add(b); bones[k] = b; }
  const mesh = new THREE.SkinnedMesh(geo, lootMat());
  mesh.add(bones.root);
  bones.root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(BONES.map(k => bones[k])));
  mesh.frustumCulled = false;   // (posed far from its rest shape at times; there are only ever a few)
  return { mesh, bones };
}

// ---- posing -------------------------------------------------------------------------------------------

const ease = (cur, to, k) => cur + (to - cur) * k;
export class MobView {
  constructor(type, obj, mesh, bones) {
    this.type = type; this.obj = obj; this.mesh = mesh; this.b = bones;
    this.st = 0; this.raw = 0; this.stT = 0;
    this.ph = Math.random() * 6;   // gait phase
    this.prev = null; this.speed = 0;
    this.j = { lift: 0, fold: 0, head: 0, headY: 0, tail: 0, fl: 0, fr: 0, bl: 0, br: 0, heave: 0 };
    this.zzz = null; this.puffT = 0;
    this.onPuff = null;   // (main.js) where steam or dust puffs from
    this.farT = 0; this.farSt = null; this.snap = false;
  }
  // gone (nightfall, a re-list, a new day): what it made for itself (the geometry is shared, cached per biome)
  dispose() {
    this.zzz?.userData.dispose?.();
    this.mesh?.skeleton?.dispose();
  }
  // st: the snapshot's state (with its flag bits); camPos: where the camera is (nothing is posed far off)
  update(dt, t, st, camPos) {
    const raw = st ?? 0, s = raw & ST_MASK;
    if (s !== this.st) { this.st = s; this.stT = 0; }
    this.stT += dt; this.raw = raw;
    const p = this.obj.position;
    if (this.prev) { const v = Math.hypot(p.x - this.prev.x, p.z - this.prev.z) / Math.max(dt, 1e-3); this.speed += (Math.min(12, v) - this.speed) * Math.min(1, dt * 8); }
    this.prev = p.clone();
    const d = camPos ? p.distanceTo(camPos) : 0;
    this.obj.visible = d < 140;
    if (dt <= 0 || d >= 140) return;
    if (d > 60) {
      // far off: posed four times a second and snapped (no easing), so it still lies down, gets up and runs
      this.farT += dt;
      if (this.farT < 0.25 && this.farSt === raw) return;
      dt = this.farT; this.farT = 0; this.farSt = raw; this.snap = true;
    } else { this.farT = 0; this.farSt = null; }
    if (this.type === 'grumphorn') this.grumphorn(dt, t, s, raw, d);
    this.snap = false;
  }
  grumphorn(dt, t, s, raw, d) {
    const S = GST, J = this.j, k = this.snap ? 1 : Math.min(1, dt * 7);
    const lying = s === S.SLEEP || s === S.LEFT || (s === S.DOZE && this.speed < 0.3);
    const tgt = { lift: 0, fold: 0, head: 0.05, headY: 0, tail: 0.15, fl: 0, fr: 0, bl: 0, br: 0, heave: 0 };
    if (lying) { tgt.lift = -0.36; tgt.fold = 1; tgt.head = 0.32; tgt.tail = 0.5; tgt.heave = 0.02 * Math.sin(t * 1.3); }
    else if (s === S.RISE) { const f = Math.min(1, this.stT / 1.2); tgt.lift = -0.36 * (1 - f); tgt.fold = 1 - f; tgt.head = 0.32 - 0.5 * f; }
    else if (s === S.GLARE) { tgt.head = 0.45; tgt.fr = Math.max(0, Math.sin(t * 9)) * -0.6; tgt.tail = 0.6 + Math.sin(t * 12) * 0.3; }
    else if (s === S.HELD) { tgt.headY = Math.sin(t * 13) * 0.5; tgt.head = 0.2 + Math.sin(t * 9) * 0.2; }
    else if (s === S.WINDED) { tgt.head = 0.4; tgt.heave = 0.05 * Math.sin(t * 7); tgt.tail = 0.1; }
    else {
      // walking, trotting, the charge: a gait from how fast it's going (diagonal pairs walking, a gallop's
      // front and back pairs charging)
      const v = this.speed, gallop = s === S.CHARGE || v > 3.5;
      this.ph += dt * (gallop ? 3 : 1.1) * Math.PI * 2 * Math.min(1, 0.3 + v / 3);
      const a = Math.min(0.7, 0.18 + v * 0.08), sn = Math.sin(this.ph);
      if (gallop) { tgt.fl = tgt.fr = sn * a; tgt.bl = tgt.br = -sn * a; tgt.lift = Math.abs(Math.cos(this.ph)) * 0.08; tgt.head = 0.42; tgt.tail = -0.3; }
      else { tgt.fl = tgt.br = sn * a; tgt.fr = tgt.bl = -sn * a; tgt.head = 0.12 + Math.sin(this.ph * 2) * 0.04; }
    }
    for (const key in J) J[key] = ease(J[key], tgt[key], key === 'fl' || key === 'fr' || key === 'bl' || key === 'br' ? (this.snap ? 1 : Math.min(1, dt * 18)) : k);
    const b = this.b;
    b.root.position.y = J.lift;
    b.body.scale.set(1 + J.heave * 0.6, 1 + J.heave, 1);
    b.head.rotation.set(J.head, J.headY, 0);
    b.tail.rotation.set(J.tail, 0, 0);
    // folded: the forelegs tuck forward under the chest, the hind legs back under the belly
    b.fl.rotation.set(J.fl - J.fold * 1.45, 0, 0); b.fr.rotation.set(J.fr - J.fold * 1.45, 0, 0);
    b.bl.rotation.set(J.bl + J.fold * 1.35, 0, 0); b.br.rotation.set(J.br + J.fold * 1.35, 0, 0);
    // asleep: a bobbing Zzz (close by only); in a foul mood: steam from the nostrils
    const sleeping = s === S.SLEEP && d < 25;
    if (sleeping && !this.zzz) { this.zzz = labelSprite('Zzz', '#e8f0ff', 30); this.zzz.scale.set(1.2, 0.24, 1); this.obj.add(this.zzz); }
    if (this.zzz) { this.zzz.visible = sleeping; this.zzz.position.set(0.3, 0.95 + Math.sin(t * 1.4) * 0.08, 1.2); }
    if ((raw & ST_MOOD) || s === S.GLARE) {
      this.puffT -= dt;
      if (this.puffT <= 0 && this.onPuff) { this.puffT = s === S.GLARE ? 0.35 : 1.2; this.onPuff(this.obj.localToWorld(new V3(0, 0.0, 1.66)), '#e8e4dc'); }
    }
  }
}

export function buildMob(type, W) {
  const biome = W?.biome || 'meadow';
  if (!BUILD[type]) {
    // (a critter with no model yet: a shape the size of its collider)
    const L = LOOT[type], g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.SphereGeometry(L.shape[1], 10, 8), new THREE.MeshLambertMaterial({ color: 0x8a8178 })));
    return { obj: shadowy(g), view: new MobView(type, g, null, null) };
  }
  const { mesh, bones } = rig(type, geoFor(type, biome));
  const obj = new THREE.Group();
  obj.add(mesh);
  shadowy(obj);
  return { obj, view: new MobView(type, obj, mesh, bones) };
}

// ---- preview (tools/preview.mjs) ----
// each critter in a few states (the view's own posing, settled)
function posedMob(type, st, biome, secs = 2) {
  const { obj, view } = buildMob(type, { biome });
  for (let i = 0; i < secs * 30; i++) view.update(1 / 30, i / 30, st, null);
  return obj;
}
export const PREVIEW = {
  mob_grumphorn: (o = {}) => posedMob('grumphorn', GST.ROAM, o.biome),
  mob_grumphorn_sleep: (o = {}) => posedMob('grumphorn', GST.SLEEP, o.biome),
  mob_grumphorn_glare: (o = {}) => posedMob('grumphorn', GST.GLARE, o.biome),
  mob_grumphorn_snow: () => posedMob('grumphorn', GST.ROAM, 'snow'),
  mob_grumphorn_badlands: () => posedMob('grumphorn', GST.ROAM, 'badlands'),
};
