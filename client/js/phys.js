// Each client's local physics world. It never simulates anything dynamic —
// it's the same seeded terrain plus copies of the RV, the loot and the other
// players, put where the server says they are. Your own body moves through it
// with Rapier's character controller, so walking, climbing and riding the RV
// have zero input lag.
//
// The copies are FIXED bodies moved by hand each frame, not kinematic ones: on a kinematic body's box
// tilted a degree or so (the RV parked on uneven ground) the controller stalled on the floor at every
// step, and you could only get about the RV by jumping. On a fixed body the same box walks. (And it moves
// your body across, then up or down: moveSelf)

import RAPIER from '/vendor/rapier.mjs';
import * as C from '/shared/constants.js';
import { LOOT } from '/shared/loot.js';
import { RV_PARTS } from '/shared/rv.js';

export { RAPIER };
let ready = null;
export function initPhys() { return (ready ||= RAPIER.init()); }

export const G = { WORLD: 1, RV: 2, PROP: 4, PLAYER: 8, SELF: 16, USE: 32, HOOK: 64, FENCE: 128 };   // (FENCE: world gen's fences, solid to walk into, see-through to the crosshair)
const grp = (m, f) => ((m << 16) | f) >>> 0;
const yawQ = ry => ({ x: 0, y: Math.sin(ry / 2), z: 0, w: Math.cos(ry / 2) });

function shapeDesc(shape) {
  const [k, a, b, c] = shape;
  if (k === 'box') return RAPIER.ColliderDesc.cuboid(a, b, c);
  if (k === 'cyl') return RAPIER.ColliderDesc.cylinder(a, b);
  if (k === 'cap') return RAPIER.ColliderDesc.capsule(a, b).setRotation({ x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 });   // lying along z
  return RAPIER.ColliderDesc.ball(a);
}

export class LocalWorld {
  constructor(W) {
    this.W = W;
    this.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.info = new Map();       // collider handle -> {kind, id, part, use}
    this.props = new Map();      // id -> {body, col, type}
    this.players = new Map();    // id -> {body, col}
    this.gateCols = new Map();

    const fixed = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    const { nx, nz, cell, X0, Z0, heights } = W;
    const t = this.world.createCollider(RAPIER.ColliderDesc.heightfield(nz, nx, heights, { x: nx * cell, y: 1, z: nz * cell })
      .setTranslation(X0 + nx * cell / 2, 0, Z0 + nz * cell / 2).setCollisionGroups(grp(G.WORLD, 0xffff)), fixed);
    this.info.set(t.handle, { kind: 'terrain' });
    for (const s of W.statics) {
      const c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(s.hx, s.hy, s.hz).setTranslation(s.x, s.y, s.z)
        .setRotation(yawQ(s.ry)).setCollisionGroups(grp(s.part === 'fence' || s.part === 'signpost' ? G.FENCE : G.WORLD, 0xffff)), fixed);
      this.info.set(c.handle, { kind: 'static', mat: s.mat, part: s.part });
    }
    for (const cy of W.cyls) {
      const c = this.world.createCollider(RAPIER.ColliderDesc.cylinder(cy.hh, cy.r).setTranslation(cy.x, cy.y, cy.z)
        .setCollisionGroups(grp(G.WORLD, 0xffff)), fixed);
      this.info.set(c.handle, { kind: 'static', mat: cy.mat });
    }
    // convex rocks (the crash buttes' fallen blocks): world gen's points, the very ones terrain_talus draws
    for (const h of W.hulls || []) {
      const d = RAPIER.ColliderDesc.convexHull(h.pts);
      if (!d) continue;
      const c = this.world.createCollider(d.setTranslation(h.x, h.y, h.z).setCollisionGroups(grp(G.WORLD, 0xffff)), fixed);
      this.info.set(c.handle, { kind: 'static', mat: h.mat });
    }
    for (const g of W.gates) {
      const c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(g.hx, g.hy, g.hz).setTranslation(g.x, g.y, g.z)
        .setCollisionGroups(grp(G.WORLD, 0xffff)), fixed);
      this.info.set(c.handle, { kind: 'gate', id: g.id });
      this.gateCols.set(g.id, c);
    }
    // interactables: small targets the crosshair can hit but bodies walk through
    for (const u of W.uses) {
      const c = this.world.createCollider(RAPIER.ColliderDesc.ball(u.r).setTranslation(u.x, u.y, u.z)
        .setSensor(true).setCollisionGroups(grp(G.USE, 0xffff)), fixed);
      this.info.set(c.handle, { kind: 'use', id: u.id });
    }

    // the RV
    this.rv = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -100, 0));
    this.rvCols = {};
    for (const [name, hx, hy, hz, cx, cy, cz, o] of RV_PARTS) {
      if (o.loot) continue;   // (it stops the server's loot, not people)
      const c = this.world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz)
        .setCollisionGroups(grp(G.RV, 0xffff)), this.rv);
      this.info.set(c.handle, { kind: 'rv', part: name, use: o.use || null });
      this.rvCols[name] = c;
    }

    // the winch hook (only when it's out)
    this.hook = this.world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -100, 0));
    const hc = this.world.createCollider(RAPIER.ColliderDesc.ball(0.22).setSensor(true).setCollisionGroups(grp(G.HOOK, 0xffff)), this.hook);
    this.info.set(hc.handle, { kind: 'hook' });

    // me
    this.self = this.world.createCollider(RAPIER.ColliderDesc.capsule(C.PLAYER.HALF_H, C.PLAYER.RADIUS)
      .setTranslation(0, -50, 0).setCollisionGroups(grp(G.SELF, 0)));
    this.cc = this.world.createCharacterController(0.03);
    this.cc.setUp({ x: 0, y: 1, z: 0 });
    this.cc.setSlideEnabled(true);
    this.cc.enableAutostep(C.PLAYER.STEP, 0.18, false);
    this.cc.setMaxSlopeClimbAngle(C.PLAYER.MAX_SLOPE_DEG * Math.PI / 180);
    this.cc.setMinSlopeSlideAngle(C.PLAYER.MAX_SLOPE_DEG * Math.PI / 180);
    this.cc.enableSnapToGround(0.32);
    this.cc.setApplyImpulsesToDynamicBodies(false);
  }

  free() { try { this.world.free(); } catch { } }

  // the door's collider: there only while the door is shut
  setDoor(open) { this.rvCols.door.setEnabled(!open); }
  doorOpen() { return !this.rvCols.door.isEnabled(); }

  openGate(id) {
    const c = this.gateCols.get(id);
    if (c) { this.world.removeCollider(c, false); this.gateCols.delete(id); }
  }

  setRV(p, q) {
    this.rv.setTranslation(p, false);
    this.rv.setRotation(q, false);
  }

  setHook(p) { this.hook.setNextKinematicTranslation(p || { x: 0, y: -100, z: 0 }); }

  addProp(id, type, p, q) {
    if (this.props.has(id)) return;
    const L = LOOT[type];
    if (!L) return;
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.x, p.y, p.z).setRotation(q));
    // (a small critter is a sensor: you walk through it, the crosshair finds it)
    const desc = L.sensor ? RAPIER.ColliderDesc.ball(L.sensor).setSensor(true) : shapeDesc(L.shape);
    const col = this.world.createCollider(desc.setCollisionGroups(grp(G.PROP, 0xffff)), body);
    this.info.set(col.handle, { kind: 'prop', id });
    this.props.set(id, { body, col, type });
  }
  setProp(id, p, q) {
    const e = this.props.get(id);
    if (!e) return;
    e.body.setTranslation(p, false);
    e.body.setRotation(q, false);
  }
  removeProp(id) {
    const e = this.props.get(id);
    if (!e) return;
    this.info.delete(e.col.handle);
    this.world.removeRigidBody(e.body);
    this.props.delete(id);
  }

  setPlayer(id, feet, ko) {
    let e = this.players.get(id);
    if (!e) {
      const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
      const col = this.world.createCollider(RAPIER.ColliderDesc.capsule(C.PLAYER.HALF_H, C.PLAYER.RADIUS * 0.9)
        .setCollisionGroups(grp(G.PLAYER, 0xffff)), body);
      this.info.set(col.handle, { kind: 'player', id });
      e = { body, col };
      this.players.set(id, e);
    }
    const ch = C.PLAYER.HALF_H + C.PLAYER.RADIUS;
    e.body.setTranslation({ x: feet.x, y: feet.y + (ko ? 0.25 : ch), z: feet.z }, false);
    e.body.setRotation(ko ? { x: Math.SQRT1_2, y: 0, z: 0, w: Math.SQRT1_2 } : { x: 0, y: 0, z: 0, w: 1 }, false);
  }
  removePlayer(id) {
    const e = this.players.get(id);
    if (!e) return;
    this.info.delete(e.col.handle);
    this.world.removeRigidBody(e.body);
    this.players.delete(id);
  }

  step() { this.world.step(); }

  // ---- queries ----------------------------------------------------------------------

  // KCC move of my capsule. Returns {move, grounded, hits:[{kind,id,part,normal,point}]}
  // (riding the RV, its fences don't push you about as it drives through them)
  moveSelf(center, desired, exclude, climbing = false, riding = false) {
    this.self.setTranslation(center);
    if (climbing !== this._climbMode) {
      // on a wall the slope rules don't apply — you're holding on
      this._climbMode = climbing;
      const a = (climbing ? 90 : C.PLAYER.MAX_SLOPE_DEG) * Math.PI / 180;
      this.cc.setMaxSlopeClimbAngle(a);
      this.cc.setMinSlopeSlideAngle(a);
      if (climbing) { this.cc.disableSnapToGround(); this.cc.disableAutostep(); }
      else { this.cc.enableSnapToGround(0.32); this.cc.enableAutostep(C.PLAYER.STEP, 0.18, false); }
    }
    const pred = exclude ? (c => !exclude.has(c.handle)) : undefined, groups = grp(G.SELF, G.WORLD | G.RV | G.PROP | G.PLAYER | (riding ? 0 : G.FENCE));
    const hits = [];
    const pass = d => {
      this.cc.computeColliderMovement(this.self, d, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups, pred);
      for (let i = 0; i < this.cc.numComputedCollisions(); i++) {
        const c = this.cc.computedCollision(i);
        const inf = c?.collider && this.info.get(c.collider.handle);
        if (inf) hits.push({ ...inf, normal: c.normal1, point: c.witness1 });
      }
      const m = this.cc.computedMovement();
      return { x: m.x, y: m.y, z: m.z };
    };
    if (climbing) { const m = pass(desired); return { move: m, grounded: this.cc.computedGrounded(), hits }; }
    // on foot: across first, then up or down. In one move, gravity pressing into a level floor cut steps short
    // now and then (Rapier's controller slid along the floor as if it were in the way), and each one stopped
    // you dead: indoors, on a building's floor, every second or so. (Across, steps up and slopes still work:
    // the autostep and the snap to the ground are in that pass too)
    const a = pass({ x: desired.x, y: 0, z: desired.z }), ga = this.cc.computedGrounded();
    this.self.setTranslation({ x: center.x + a.x, y: center.y + a.y, z: center.z + a.z });
    const b = pass({ x: 0, y: desired.y, z: 0 });
    return { move: { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }, grounded: desired.y === 0 ? ga : this.cc.computedGrounded(), hits };
  }

  // first thing along a ray: {kind,id,part,use,toi,point,normal}
  ray(o, d, max, mask = G.WORLD | G.RV | G.PROP | G.PLAYER | G.USE | G.HOOK, exclude = null, sensors = true) {
    const r = new RAPIER.Ray(o, d);
    const pred = exclude ? (c => !exclude.has(c.handle)) : undefined;
    const hit = this.world.castRayAndGetNormal(r, max, true,
      sensors ? undefined : RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, grp(0xffff, mask), undefined, undefined, pred);
    if (!hit) return null;
    const inf = this.info.get(hit.collider.handle) || { kind: '?' };
    const t = hit.timeOfImpact;
    return { ...inf, handle: hit.collider.handle, toi: t, point: { x: o.x + d.x * t, y: o.y + d.y * t, z: o.z + d.z * t }, normal: hit.normal };
  }

  // does a capsule fit with its center here?
  fits(center) {
    let blocked = false;
    const shape = new RAPIER.Capsule(C.PLAYER.HALF_H, C.PLAYER.RADIUS * 0.95);
    this.world.intersectionsWithShape(center, { x: 0, y: 0, z: 0, w: 1 }, shape, () => { blocked = true; return false; },
      RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, grp(0xffff, G.WORLD | G.RV | G.PROP));
    return !blocked;
  }

  propCollider(id) { return this.props.get(id)?.col.handle ?? null; }
}
