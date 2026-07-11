import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, spawnInCircle } from '../physics.js';
import { makeGremlin, driveGremlin } from '../gremlins.js';

// ARE WE SLOP YET? (an R.V. There Yet? homage): the squad shoulder-pushes a
// dead RV across the pit while mud bogs it down and gremlins push back.

const RV_R = 95;
const RV_MASS = 7;              // players hit like 1/7th of the RV
const RV_MAX_SPEED = 230;
const EXIT_X = C.FAST ? 260 : 1420;
const MAX_TIME = C.FAST ? 12 : 110;
const GREMLIN_CAP = C.FAST ? 0 : 2;
const GREMLIN_EVERY = 9;

export default class Rv {
  static id = 'rv';
  static team = true;

  constructor(players, rng = Math.random) {
    this.players = players;
    this.rng = rng;
    this.t = 0;
    this.teamWin = false;
    this.rv = { x: 210, y: C.ARENA_H / 2, vx: 0, vy: 0 };
    this.gremlins = [];
    this.spawnT = 4;
    this.mud = [
      { x: 560, y: 260, r: 150 },
      { x: 820, y: 640, r: 170 },
      { x: 1150, y: 330, r: 150 },
    ];
    spawnInCircle(players, 340, C.ARENA_H / 2, 160);
    players.forEach(p => { p.alive = true; p.score = 0; p.stun = 0; });
  }

  inMud() {
    return this.mud.some(m => Math.hypot(this.rv.x - m.x, this.rv.y - m.y) < m.r);
  }

  shove(body) {
    const dx = this.rv.x - body.x, dy = this.rv.y - body.y;
    const d = Math.hypot(dx, dy);
    const minD = RV_R + C.PLAYER_RADIUS;
    if (d >= minD || d === 0) return false;
    const nx = dx / d, ny = dy / d;
    // push the body out of the RV
    body.x = this.rv.x - nx * minD;
    body.y = this.rv.y - ny * minD;
    // transfer the push (dash hits shove hard)
    const vn = body.vx * nx + body.vy * ny;
    if (vn > 0) {
      const k = (body.dashTime > 0 ? 2.2 : 1) / RV_MASS;
      this.rv.vx += nx * vn * k;
      this.rv.vy += ny * vn * k;
      body.vx -= nx * vn * 0.8;
      body.vy -= ny * vn * 0.8;
    }
    return true;
  }

  tick(dt) {
    this.t += dt;

    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.gremlins.filter(g => g.alive).length < GREMLIN_CAP) {
      this.spawnT = GREMLIN_EVERY;
      this.gremlins.push(makeGremlin(C.ARENA_W - 80, 150 + this.rng() * 600));
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      p.stun = Math.max(0, p.stun - dt);
      p.freeze = p.stun > 0;
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
    }
    for (const g of this.gremlins) {
      if (!g.alive) continue;
      // gremlins get behind the RV (east side) and shove it backwards
      driveGremlin(g, [{ x: this.rv.x + 150, y: this.rv.y, alive: true }], dt);
      stepMovement(g, dt);
      boundRect(g, C.ARENA_W, C.ARENA_H);
    }
    collidePlayers([...this.players, ...this.gremlins.filter(g => g.alive)]);

    // everyone leans on the RV
    for (const p of this.players) {
      if (!p.alive) continue;
      if (this.shove(p)) p.score += dt; // MVP: shoulder time
    }
    for (const g of this.gremlins) if (g.alive) this.shove(g);

    // the RV itself
    const damp = this.inMud() ? 0.045 : 0.9;
    const f = Math.pow(damp, dt * 2);
    this.rv.vx *= f; this.rv.vy *= f;
    const sp = Math.hypot(this.rv.vx, this.rv.vy);
    if (sp > RV_MAX_SPEED) { this.rv.vx *= RV_MAX_SPEED / sp; this.rv.vy *= RV_MAX_SPEED / sp; }
    this.rv.x += this.rv.vx * dt;
    this.rv.y += this.rv.vy * dt;
    this.rv.x = Math.max(RV_R, Math.min(C.ARENA_W - RV_R + 60, this.rv.x));
    this.rv.y = Math.max(RV_R + 30, Math.min(C.ARENA_H - RV_R - 30, this.rv.y));

    if (this.rv.x >= EXIT_X) {
      this.teamWin = true;
      return this.rankings();
    }
    if (this.t >= MAX_TIME) return this.rankings();
    return null;
  }

  rankings() {
    return this.players.slice().sort((a, b) => b.score - a.score).map(p => p.id);
  }

  extras() {
    return {
      rv: [Math.round(this.rv.x), Math.round(this.rv.y), Math.round(Math.atan2(this.rv.vy, this.rv.vx) * 100) / 100],
      mud: this.mud.map(m => [m.x, m.y, m.r]),
      gremlins: this.gremlins.filter(g => g.alive).map(g => [g.id, Math.round(g.x), Math.round(g.y), g.dashTime > 0 ? 1 : 0]),
      exitX: EXIT_X,
      inMud: this.inMud() ? 1 : 0,
      goal: `RV at ${Math.min(100, Math.max(0, Math.floor((this.rv.x - 210) / (EXIT_X - 210) * 100)))}%`,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
