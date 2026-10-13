// What the wildlife looks like (shared/mobs.js says what it is). Each critter is one mesh in the loot
// material; a MobView poses it from its state (the snapshot's st) and how fast it's going.
//
// API: buildMob(type, W) -> { obj, view } · MobView.update(dt, t, st, camPos) · PREVIEW
import { THREE, shadowy } from './gfx.js';
import { LOOT } from '/shared/loot.js';
import { ST_MASK } from '/shared/mobs.js';

// (stand-ins until the critters get their own rigs: a shape the size of the collider)
function standIn(type) {
  const L = LOOT[type], g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: type === 'grumphorn' ? 0x6b4a2e : 0x8a8178 });
  if (L.shape[0] === 'cap') {
    const [, hh, r] = L.shape;
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, hh * 2, 6, 12), mat);
    m.rotation.x = Math.PI / 2;
    g.add(m);
  } else {
    g.add(new THREE.Mesh(new THREE.SphereGeometry(L.shape[1], 12, 8), mat));
  }
  return shadowy(g);
}

export class MobView {
  constructor(type, obj) { this.type = type; this.obj = obj; this.st = 0; }
  // st: the snapshot's state (with its flag bits); camPos: where the camera is (no posing far away)
  update(dt, t, st, camPos) {
    this.st = (st ?? 0) & ST_MASK;
  }
}

export function buildMob(type, W) {
  const obj = standIn(type);
  return { obj, view: new MobView(type, obj) };
}

// ---- preview (tools/preview.mjs) ----
export const PREVIEW = Object.fromEntries(Object.keys(LOOT).filter(k => LOOT[k].mob).map(k => [`mob_${k}`, () => buildMob(k, null).obj]));
