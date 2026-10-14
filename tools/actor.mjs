// The trailer's actors move as players do: each has the page's own controller (client/js/player.js) on the
// page's own physics world (client/js/phys.js: the ground, the buildings, the fences, the RV), so they walk
// round what's solid, step up kerbs, fall off edges and fly when knocked, the way a player's page moves them.
// A shot says where an actor should be; the actor walks there (or is put there, when it's far).
import '../test/pagemods.mjs';
const C = await import('../shared/constants.js');
const { initPhys, LocalWorld } = await import('../client/js/phys.js');
const { Me } = await import('../client/js/player.js');
await initPhys();

// the day's physics world, with the RV where the server has it
export class Stage {
  constructor(W) { this.W = W; this.lw = new LocalWorld(W); }
  free() { this.lw.free(); }
  // rv: { p, q } (the server's RV); door: open or not
  step(rv, door = true) {
    if (rv) this.lw.setRV(rv.p, rv.q);
    this.lw.setDoor(door);
    this.lw.step();
  }
}

const P = C.PLAYER;
export class Actor {
  constructor() { this.me = new Me(); this.goal = null; this.speed = null; }
  get pos() { return this.me.pos; }
  // stand here now (a cut, or a first placement)
  place(x, y, z, yaw) { this.me.teleport(x, y, z, yaw); this.me.mode = 'walk'; this.goal = null; }
  // walk to (x, z), facing yaw once there; speed in m/s (null: a walk, or a run when it's far)
  walkTo(x, z, yaw = null, speed = null) { this.goal = { x, z, yaw }; this.speed = speed; }
  // thrown: v the knock's velocity ([x, y, z]); ko: out cold where it lands
  knock(v, ko, rv = null) { this.me.knock(v, ko, 'mob', !!rv, rv); }
  get flying() { return !this.me.grounded || this.me.mode === 'ko' && Math.hypot(this.me.vel.x, this.me.vel.z) > 0.3; }
  wake() { if (this.me.mode === 'ko') { this.me.mode = 'walk'; this.me.koT = 0; } }
  // one physics step: the controller steers for the goal like a player's keys would
  step(dt, stage, rv = null, { crouch = false } = {}) {
    const me = this.me, g = this.goal, inp = { f: 0, r: 0, jump: false, sprint: false, crouch, grab: false };
    if (g && me.mode === 'walk') {
      const dx = g.x - me.pos.x, dz = g.z - me.pos.z, d = Math.hypot(dx, dz);
      if (d > 0.05) {
        me.yaw = Math.atan2(dx, dz);
        // (as fast as asked, slowing into the spot: no overshoot, no shuffle)
        const want = Math.min(this.speed ?? (d > 5 ? P.SPRINT : P.WALK), d * 6);
        inp.sprint = want > P.WALK + 0.01 && !crouch;
        inp.f = Math.min(1, want / (inp.sprint ? P.SPRINT : crouch ? P.CROUCH : P.WALK));
      } else if (g.yaw != null) me.yaw = g.yaw;
    }
    me.update(dt, inp, stage.lw, rv, null);
  }
}
