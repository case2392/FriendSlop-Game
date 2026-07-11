import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, applyChain, spawnInCircle } from '../physics.js';
import { makeGremlin, driveGremlin } from '../gremlins.js';

// Plate layout scales with squad size: the chain (LINK_LEN per hop) must be
// able to span every pair of covered plates, so small squads get a tight
// triangle and big squads a wide one. 2-3 blobs get two plates only.
function makePlates(n) {
  if (n <= 3) {
    const d = 120 + n * 50;
    return [
      { x: C.ARENA_W / 2 - d / 2, y: 480 },
      { x: C.ARENA_W / 2 + d / 2, y: 480 },
    ];
  }
  const R = 100 + n * 16;
  return [-Math.PI / 2, Math.PI / 6, (Math.PI * 5) / 6].map(a => ({
    x: C.ARENA_W / 2 + Math.cos(a) * R,
    y: 450 + Math.sin(a) * R,
  }));
}
const PLATE_R = C.FAST ? 2000 : 100;
const HOLD_NEED = C.FAST ? 0.4 : 8;    // cumulative seconds with all plates covered
const MAX_TIME = C.FAST ? 6 : 75;
const GREMLIN_EVERY = 5;
const GREMLIN_CAP = C.FAST ? 0 : 2;

// CO-OP: stretch the chain across all three pressure plates at once to grind
// the gate open, while gremlins try to shove you off. No lives — a time race.
export default class Gates {
  static id = 'gates';
  static team = true;

  constructor(players) {
    this.players = players;
    this.plates = makePlates(players.length);
    this.t = 0;
    this.teamWin = false;
    this.progress = 0;
    this.gremlins = [];
    this.spawnT = 2;
    spawnInCircle(players, C.ARENA_W / 2, C.ARENA_H / 2, 260);
    players.forEach(p => { p.alive = true; p.score = 0; p.stun = 0; });
  }

  tick(dt) {
    this.t += dt;

    this.spawnT -= dt;
    if (this.spawnT <= 0 && this.gremlins.filter(g => g.alive).length < GREMLIN_CAP) {
      this.spawnT = GREMLIN_EVERY;
      const ang = Math.random() * Math.PI * 2;
      this.gremlins.push(makeGremlin(
        C.ARENA_W / 2 + Math.cos(ang) * 700,
        Math.min(C.ARENA_H - 60, Math.max(60, C.ARENA_H / 2 + Math.sin(ang) * 380)),
      ));
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
      driveGremlin(g, this.players, dt);
      stepMovement(g, dt);
      boundRect(g, C.ARENA_W, C.ARENA_H);
    }
    collidePlayers([...this.players, ...this.gremlins.filter(g => g.alive)], (a, b) => {
      // A dashing gremlin staggers a blob off its plate.
      if (a.isGremlin && a.dashTime > 0 && !b.isGremlin) { b.stun = Math.max(b.stun, 0.5); b.events.push('bonk'); }
      if (b.isGremlin && b.dashTime > 0 && !a.isGremlin) { a.stun = Math.max(a.stun, 0.5); a.events.push('bonk'); }
    });
    applyChain(this.players.filter(p => p.alive), C.LINK_LEN);

    const covered = this.plates.map(pl =>
      this.players.some(p => p.alive && Math.hypot(p.x - pl.x, p.y - pl.y) < PLATE_R));
    for (const p of this.players) {
      if (!p.alive) continue;
      if (this.plates.some(pl => Math.hypot(p.x - pl.x, p.y - pl.y) < PLATE_R)) p.score += dt; // MVP: plate time
    }
    if (covered.every(Boolean)) this.progress += dt;

    if (this.progress >= HOLD_NEED) {
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
    const covered = this.plates.map(pl =>
      this.players.some(p => p.alive && Math.hypot(p.x - pl.x, p.y - pl.y) < PLATE_R));
    return {
      plates: this.plates.map((pl, i) => [Math.round(pl.x), Math.round(pl.y), Math.min(PLATE_R, 100), covered[i] ? 1 : 0]),
      prog: Math.round(this.progress * 10) / 10,
      need: HOLD_NEED,
      gremlins: this.gremlins.filter(g => g.alive).map(g => [g.id, Math.round(g.x), Math.round(g.y), g.dashTime > 0 ? 1 : 0]),
      goal: `gate ${Math.min(100, Math.floor(this.progress / HOLD_NEED * 100))}% open`,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
