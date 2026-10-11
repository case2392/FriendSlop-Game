// Your body. Client-authoritative, moved through the local physics world by
// Rapier's character controller. Walk, sprint, jump, crouch, CLIMB anything
// steep on a stamina bar (PEAK rules), ride the RV, fall, get knocked out.

import * as C from '/shared/constants.js';
import { LOOT } from '/shared/loot.js';
import { RV_DIM, RV_SEATS, RV_SEAT_EXIT, toWorld, toLocal, insideRV, qYaw } from '/shared/rv.js';
import { G } from './phys.js';

const P = C.PLAYER, ST = C.STAMINA;
const CH = P.HALF_H + P.RADIUS;             // capsule center above the feet
const STEEP = Math.cos(C.CLIMB.MIN_STEEP_DEG * Math.PI / 180);
const WALKABLE = Math.cos(P.MAX_SLOPE_DEG * Math.PI / 180);
const v3 = (x = 0, y = 0, z = 0) => ({ x, y, z });
const add = (a, b) => v3(a.x + b.x, a.y + b.y, a.z + b.z);
const sub = (a, b) => v3(a.x - b.x, a.y - b.y, a.z - b.z);
const mul = (a, s) => v3(a.x * s, a.y * s, a.z * s);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a, b) => v3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = a => Math.hypot(a.x, a.y, a.z);
const norm = a => { const l = len(a) || 1; return mul(a, 1 / l); };
const wrap = a => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const CLIMBABLE = new Set(['terrain', 'static', 'rv', 'gate']);

export class Me {
  constructor() {
    this.pos = v3(0, 0, 0);
    this.vel = v3();
    this.yaw = 0; this.pitch = 0;
    this.mode = 'walk';          // walk | climb | seat | ko
    this.par = 0; this.lp = null;
    this.grounded = false;
    this.stamina = ST.MAX; this.stamMax = ST.MAX; this.regenT = 0;
    this.crouch = false; this.sprinting = false;
    this.climb = null;           // {n, rv}
    this.seat = null;
    this.koT = 0;
    this.holding = null;         // {id, type}
    this.hasHook = false;
    this.regrabT = 0;
    this.prevRvYaw = null;
    this.buffT = 0;
    this.events = [];
    this.pushes = [];
    this.pushCd = new Map();
    this.airT = 0;
    this.stepT = 0;
    this.lastLand = 0;
  }

  teleport(x, y, z, yaw = null) {
    this.pos = v3(x, y, z);
    this.vel = v3();
    if (yaw != null) this.yaw = yaw;
    this.par = 0; this.lp = null;
    if (this.mode === 'climb' || this.mode === 'seat') this.mode = 'walk';
    this.climb = null;
  }

  eye(rv) {
    if (this.mode === 'seat' && rv) {
      const s = RV_SEATS[this.seat];
      return toWorld(rv.p, rv.q, v3(s.x, s.y, s.z));
    }
    const h = this.mode === 'ko' ? 0.32 : this.crouch ? 1.05 : P.EYE;
    return v3(this.pos.x, this.pos.y + h, this.pos.z);
  }

  look() {
    const cp = Math.cos(this.pitch);
    return v3(Math.sin(this.yaw) * cp, -Math.sin(this.pitch), Math.cos(this.yaw) * cp);
  }

  knock(v, ko) {
    if (this.mode === 'seat') return;
    this.unparent(null);
    this.par = 0; this.lp = null;
    this.mode = 'walk';
    this.climb = null;
    this.vel = v3(v[0], v[1], v[2]);
    this.grounded = false;
    if (ko) this.ko('rv');
  }

  ko(why) {
    if (this.mode === 'ko') return;
    (this.koLog ||= []).push({ why, pos: { ...this.pos }, vel: { ...this.vel }, par: this.par, mode: this.mode, t: performance.now() });
    if (this.mode === 'seat') this.seat = null;
    this.mode = 'ko';
    this.koT = P.KO_TIME;
    this.climb = null;
    this.events.push({ k: 'ko', why });
  }

  revive() {
    if (this.mode !== 'ko') return;
    this.mode = 'walk';
    this.koT = 0;
    this.stamina = Math.max(this.stamina, 40);
  }

  sit(seat) {
    this.mode = 'seat';
    this.seat = seat;
    this.climb = null;
    this.par = 1;
    this.vel = v3();
    this.yaw = this.prevRvYaw ?? this.yaw;
    this.pitch = 0.05;
  }

  unsit(exit) {
    if (this.mode !== 'seat') return;
    this.mode = 'walk';
    const e = exit || RV_SEAT_EXIT[this.seat ?? 0];
    this.seat = null;
    this.par = 1;
    this.lp = v3(e.x, e.y + 0.05, e.z);
  }

  unparent(rv) {
    if (!this.par) return;
    this.par = 0;
    this.lp = null;
    if (rv) this.vel = add(this.vel, rv.v);
  }

  update(dt, inp, lw, rv, exclude) {
    this.events.length = 0;
    this.pushes.length = 0;
    this.regrabT = Math.max(0, this.regrabT - dt);
    this.buffT = Math.max(0, this.buffT - dt);

    // ride the RV: re-anchor to wherever it is now, turn with it
    const rvYaw = rv ? qYaw(rv.q) : 0;
    if (rv && this.par && this.lp) {
      this.pos = toWorld(rv.p, rv.q, this.lp);
      if (this.prevRvYaw != null) this.yaw += wrap(rvYaw - this.prevRvYaw);
    }
    this.prevRvYaw = rvYaw;

    const L = this.holding ? LOOT[this.holding.type] : null;
    this.stamMax = ST.MAX - Math.min(ST.WEIGHT_CAP, (L ? L.mass : 0) * ST.WEIGHT_PER_KG) - (this.hasHook ? 4 : 0);
    if (this.stamina > this.stamMax) this.stamina = this.stamMax;

    if (this.mode === 'seat') {
      if (!rv) return;
      const s = RV_SEATS[this.seat ?? 0];
      this.par = 1;
      this.lp = v3(s.x, 0.02, s.z - 0.1);
      this.pos = toWorld(rv.p, rv.q, this.lp);
      this.vel = v3();
      this.regen(dt);
      return;
    }
    if (this.mode === 'ko') {
      this.koT -= dt;
      this.walk(dt, { f: 0, r: 0, jump: false, sprint: false, crouch: false }, lw, rv, exclude, true);
      if (this.koT <= 0) { this.mode = 'walk'; this.events.push({ k: 'wake' }); this.stamina = ST.MAX * 0.5; }
      this.reparent(lw, rv, exclude);
      return;
    }
    this.lurch(dt, rv);
    if (this.mode === 'climb') this.climbStep(dt, inp, lw, rv, exclude);
    else this.walk(dt, inp, lw, rv, exclude, false);
    this.reparent(lw, rv, exclude);
    if (this.mode !== 'climb') this.regen(dt);
  }

  // Standing in the RV when it brakes hard (or hits a boulder) throws you around.
  // rv.acc comes from the server snapshots' own timestamps, so a frame hitch
  // on your machine can't fake a crash.
  lurch(dt, rv) {
    if (!rv?.acc || dt <= 0) return;
    const a = Math.hypot(rv.acc.x, rv.acc.z);
    this.lurchCd = Math.max(0, (this.lurchCd || 0) - dt);
    if (this.par && this.mode === 'walk' && a > 6 && a < 400 && this.lurchCd <= 0) {
      this.vel.x -= rv.acc.x * 0.28; this.vel.z -= rv.acc.z * 0.28;
      this.vel.y += Math.min(3, a * 0.08);
      this.lurchCd = 0.5;
      this.events.push({ k: 'lurch', a });
      if (a > 45) { this.lastCrash = { a, acc: { ...rv.acc }, rvp: { ...rv.p }, lp: this.lp && { ...this.lp } }; this.ko('crash'); }
      else if (a > 20) { this.spend(30); this.events.push({ k: 'stumble' }); }
    }
  }

  regen(dt) {
    if (this.regenT > 0) { this.regenT -= dt; return; }
    this.stamina = Math.min(this.stamMax, this.stamina + ST.REGEN * dt * (this.buffT > 0 ? 1.6 : 1));
  }

  spend(n) { this.stamina = Math.max(0, this.stamina - n); this.regenT = ST.REGEN_DELAY; }

  walk(dt, inp, lw, rv, exclude, limp) {
    const fwd = v3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const right = v3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
    let w = add(mul(fwd, inp.f), mul(right, inp.r));
    const wl = Math.hypot(w.x, w.z);
    if (wl > 1) w = mul(w, 1 / wl);
    this.crouch = !!inp.crouch && !limp;
    const cls = this.holding ? LOOT[this.holding.type]?.cls : null;
    this.sprinting = !!inp.sprint && inp.f > 0 && !this.crouch && this.stamina > 1 && cls !== 'heavy' && this.grounded;
    let speed = this.crouch ? P.CROUCH : this.sprinting ? P.SPRINT : P.WALK;
    if (cls === '2h') speed *= 0.78;
    if (cls === 'heavy') speed *= 0.5;
    if (this.buffT > 0) speed *= 1.15;
    const accel = this.grounded ? P.ACCEL_GROUND : P.ACCEL_AIR;
    const tx = w.x * speed, tz = w.z * speed;
    const ax = tx - this.vel.x, az = tz - this.vel.z;
    const al = Math.hypot(ax, az), amax = accel * dt;
    if (al > amax) { this.vel.x += ax / al * amax; this.vel.z += az / al * amax; }
    else { this.vel.x = tx; this.vel.z = tz; }
    if (limp) { this.vel.x *= 0.9; this.vel.z *= 0.9; }
    this.vel.y -= P.GRAVITY * dt;
    if (this.sprinting && wl > 0.1) this.spend(ST.SPRINT * dt);

    if (inp.jump && this.grounded && this.stamina > 3 && !limp) {
      this.vel.y = P.JUMP * (this.buffT > 0 ? 1.08 : 1);
      this.grounded = false;
      this.spend(ST.JUMP);
      this.events.push({ k: 'jump' });
    }

    // grab a wall: PEAK climbing
    if (inp.grab && !this.holding && !this.hasHook && this.regrabT <= 0 && this.stamina > 4 && !limp) {
      const eye = this.eye(rv);
      const lk = this.look();
      let hit = lw.ray(eye, lk, C.CLIMB.REACH + 0.55, G.WORLD | G.RV, exclude, false);
      if (!hit || !CLIMBABLE.has(hit.kind)) {
        const chest = v3(this.pos.x, this.pos.y + 1.1, this.pos.z);
        hit = lw.ray(chest, fwd, C.CLIMB.REACH, G.WORLD | G.RV, exclude, false);
      }
      if (hit && CLIMBABLE.has(hit.kind) && hit.normal.y < STEEP && hit.normal.y > -0.6) {
        this.mode = 'climb';
        this.climb = { n: v3(hit.normal.x, hit.normal.y, hit.normal.z), rv: hit.kind === 'rv' };
        this.vel = v3();
        this.events.push({ k: 'grabwall' });
        return;
      }
    }

    const center = v3(this.pos.x, this.pos.y + CH, this.pos.z);
    const vy0 = this.vel.y;
    const res = lw.moveSelf(center, mul(this.vel, dt), exclude);
    this.pos = v3(center.x + res.move.x, center.y + res.move.y - CH, center.z + res.move.z);
    // blocked sideways? lose that velocity (no wall-sliding at full speed)
    if (dt > 0) {
      const mx = res.move.x / dt, mz = res.move.z / dt;
      if (Math.abs(mx) < Math.abs(this.vel.x) - 0.5) this.vel.x = mx;
      if (Math.abs(mz) < Math.abs(this.vel.z) - 0.5) this.vel.z = mz;
      if (vy0 > 0 && res.move.y < vy0 * dt * 0.5) this.vel.y = Math.min(this.vel.y, 0);   // bonk your head
    }
    if (res.grounded) {
      if (!this.grounded && vy0 < -2) {
        const s = -vy0;
        this.events.push({ k: 'land', s });
        if (s > P.KO_LAND_SPEED && this.mode !== 'ko') { this.lastFall = { s, airT: this.airT }; this.ko('fall'); }
        else if (s > P.STUMBLE_LAND_SPEED) { this.events.push({ k: 'stumble' }); this.spend(25); this.vel.x *= 0.3; this.vel.z *= 0.3; }
      }
      this.vel.y = Math.max(this.vel.y, -1);
      this.airT = 0;
    } else this.airT += dt;
    this.grounded = res.grounded;

    if (this.grounded && wl > 0.1) {
      this.stepT += dt * (this.sprinting ? 2.4 : 1.6);
      if (this.stepT > 1) { this.stepT = 0; this.events.push({ k: 'step' }); }
    }

    // shove what you walk into: the RV (from outside) and loot
    if (wl > 0.2) {
      const wn = norm(v3(w.x, 0, w.z));
      for (const h of res.hits) {
        if (h.kind !== 'rv' && h.kind !== 'prop') continue;
        if (h.kind === 'rv' && this.par) continue;
        if (this.holding && h.kind === 'prop' && h.id === this.holding.id) continue;
        const nh = norm(v3(-h.normal.x, 0, -h.normal.z));
        if (dot(wn, nh) < 0.35) continue;
        const key = h.kind + (h.id ?? '');
        if ((this.pushCd.get(key) || 0) > performance.now()) continue;
        this.pushCd.set(key, performance.now() + 90);
        this.pushes.push({ kind: h.kind, id: h.id, pt: [h.point.x, h.point.y, h.point.z], dir: [wn.x * (this.sprinting ? 1.4 : 1), 0, wn.z * (this.sprinting ? 1.4 : 1)] });
      }
    }
  }

  climbStep(dt, inp, lw, rv, exclude) {
    const c = this.climb;
    if (!inp.grab || this.stamina <= 0 || this.holding) {
      this.mode = 'walk';
      this.vel = mul(c.n, 1.2);
      this.regrabT = this.stamina <= 0 ? 0.9 : 0.15;
      this.climb = null;
      this.events.push({ k: this.stamina <= 0 ? 'exhausted' : 'letgo' });
      return;
    }
    const center = v3(this.pos.x, this.pos.y + CH, this.pos.z);
    const probe = lw.ray(add(center, mul(c.n, 0.35)), mul(c.n, -1), 1.7, G.WORLD | G.RV, exclude, false);
    if (!probe || !CLIMBABLE.has(probe.kind)) {
      if (inp.f > 0 && this.mantle(lw, center, c.n, exclude)) return;
      this.mode = 'walk'; this.climb = null; this.vel = v3(); this.regrabT = 0.2;
      return;
    }
    // ease the normal toward the surface (rock is lumpy)
    c.n = norm(add(mul(c.n, 0.5), mul(probe.normal, 0.5)));
    c.rv = probe.kind === 'rv';
    if (probe.normal.y > WALKABLE) {           // it flattened out: you're standing now
      this.mode = 'walk'; this.climb = null; this.vel = v3();
      return;
    }
    const up = v3(0, 1, 0);
    let tUp = sub(up, mul(c.n, dot(c.n, up)));
    if (len(tUp) < 0.2) { this.mode = 'walk'; this.climb = null; return; }
    tUp = norm(tUp);
    const tRight = cross(tUp, c.n);
    let mv = add(mul(tUp, inp.f), mul(tRight, inp.r));
    const ml = len(mv);
    if (ml > 1) mv = mul(mv, 1 / ml);
    const moving = ml > 0.1;
    this.spend((moving ? C.STAMINA.CLIMB_MOVE : C.STAMINA.CLIMB_HANG) * dt * (this.buffT > 0 ? 0.6 : 1));

    if (inp.jump && this.stamina > C.STAMINA.LUNGE * 0.5) {   // lunge for the next hold
      const dir = moving ? norm(mv) : tUp;
      this.vel = add(mul(dir, C.CLIMB.LUNGE), mul(c.n, 0.6));
      this.spend(C.STAMINA.LUNGE);
      this.mode = 'walk'; this.climb = null; this.regrabT = 0.16;
      this.events.push({ k: 'lunge' });
      return;
    }
    const stick = sub(add(probe.point, mul(c.n, P.RADIUS + 0.07)), center);
    const desired = add(stick, mul(mv, C.CLIMB.SPEED * (this.buffT > 0 ? 1.2 : 1) * dt));
    const res = lw.moveSelf(center, desired, exclude, true);
    const nc = add(center, res.move);
    // reached the top edge?
    if (inp.f > 0) {
      const head = add(add(nc, mul(tUp, 0.95)), mul(c.n, 0.4));
      const above = lw.ray(head, mul(c.n, -1), 1.1, G.WORLD | G.RV, exclude, false);
      if (!above && this.mantle(lw, nc, c.n, exclude)) return;
    }
    this.pos = v3(nc.x, nc.y - CH, nc.z);
    this.vel = v3();
    if (moving) {
      this.stepT += dt * 2.2;
      if (this.stepT > 1) { this.stepT = 0; this.events.push({ k: 'climbstep' }); }
    }
  }

  mantle(lw, center, n, exclude) {
    const nh = norm(v3(-n.x, 0, -n.z));
    for (const [upBy, fwdBy] of [[1.35, 0.7], [1.0, 0.75], [1.7, 0.6], [0.7, 0.8]]) {
      const cand = add(add(center, v3(0, upBy, 0)), mul(nh, fwdBy));
      if (!lw.fits(cand)) continue;
      // there has to be something to stand on
      const g = lw.ray(cand, v3(0, -1, 0), CH + 0.8, G.WORLD | G.RV | G.PROP, exclude, false);
      if (!g) continue;
      this.pos = v3(cand.x, g.point.y + 0.02, cand.z);
      this.mode = 'walk'; this.climb = null; this.vel = v3();
      this.events.push({ k: 'mantle' });
      return true;
    }
    return false;
  }

  reparent(lw, rv, exclude) {
    if (!rv) { this.par = 0; this.lp = null; return; }
    const l = toLocal(rv.p, rv.q, this.pos);
    let onRV = false;
    if (this.mode === 'climb') onRV = !!this.climb?.rv;
    else {
      const g = lw.ray(v3(this.pos.x, this.pos.y + 0.2, this.pos.z), v3(0, -1, 0), 0.7, G.WORLD | G.RV | G.PROP, exclude, false);
      onRV = (g && g.kind === 'rv') || (insideRV(l.x, l.y, l.z, -0.05) && l.y < RV_DIM.ROOF_Y - 0.25);
    }
    if (onRV && !this.par) { this.par = 1; this.vel = sub(this.vel, rv.v); }
    else if (!onRV && this.par) { this.par = 0; this.vel = add(this.vel, rv.v); }
    this.lp = this.par ? l : null;
  }

  // what goes over the wire
  pose(rv) {
    let x = this.pos.x, y = this.pos.y, z = this.pos.z, yaw = this.yaw;
    if (this.par && this.lp && rv) { x = this.lp.x; y = this.lp.y; z = this.lp.z; yaw = wrap(this.yaw - qYaw(rv.q)); }
    const m = this.mode === 'climb' ? C.MODE.CLIMB : this.mode === 'seat' ? C.MODE.SEAT : this.mode === 'ko' ? C.MODE.KO : this.grounded ? C.MODE.WALK : C.MODE.AIR;
    let f = 0;
    if (this.sprinting) f |= C.FLAG.SPRINT;
    if (this.crouch) f |= C.FLAG.CROUCH;
    if (this.holding) f |= C.FLAG.HOLDING;
    if (this.holding?.type === 'map') f |= C.FLAG.MAP;
    const wv = this.par && rv ? add(this.vel, rv.v) : this.vel;
    return { t: 'p', par: this.par, x, y, z, yaw, pitch: this.pitch, m, f, v: [wv.x, wv.y, wv.z] };
  }
}
