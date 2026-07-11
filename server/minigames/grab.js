import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, spawnInCircle } from '../physics.js';

const GAME_TIME = C.FAST ? 5 : 45;
const MAX_COINS = 26;
const SPAWN_EVERY = 0.55;
const PICKUP_DIST = C.PLAYER_RADIUS + 12;
const DROP_FRACTION = 0.35;

export default class Grab {
  static id = 'grab';

  constructor(players, rng = Math.random) {
    this.players = players;
    this.rng = rng;
    this.t = 0;
    this.spawnT = 0;
    this.coins = [];
    this.nextCoinId = 1;
    spawnInCircle(players, C.ARENA_W / 2, C.ARENA_H / 2, 330);
    players.forEach(p => { p.alive = true; p.score = 0; });
    for (let i = 0; i < 10; i++) this.spawnCoin();
  }

  spawnCoin(x, y, v) {
    const golden = v === undefined && this.rng() < 0.08;
    this.coins.push({
      id: this.nextCoinId++,
      x: x !== undefined ? x : 80 + this.rng() * (C.ARENA_W - 160),
      y: y !== undefined ? y : 80 + this.rng() * (C.ARENA_H - 160),
      v: v !== undefined ? v : (golden ? 10 : 1 + Math.floor(this.rng() * 3)),
    });
  }

  tick(dt) {
    this.t += dt;
    this.spawnT += dt;
    while (this.spawnT >= SPAWN_EVERY) {
      this.spawnT -= SPAWN_EVERY;
      if (this.coins.length < MAX_COINS) this.spawnCoin();
    }

    for (const p of this.players) {
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
    }
    collidePlayers(this.players, (a, b) => {
      // A dashing blob knocks coins out of its victim.
      const rob = (attacker, victim) => {
        const drop = Math.min(victim.score, Math.max(1, Math.floor(victim.score * DROP_FRACTION)));
        if (drop <= 0) return;
        victim.score -= drop;
        victim.events.push('robbed');
        let left = drop;
        while (left > 0) {
          const chunk = Math.min(left, 3);
          left -= chunk;
          const ang = this.rng() * Math.PI * 2;
          const r = 60 + this.rng() * 90;
          this.spawnCoin(
            Math.min(C.ARENA_W - 40, Math.max(40, victim.x + Math.cos(ang) * r)),
            Math.min(C.ARENA_H - 40, Math.max(40, victim.y + Math.sin(ang) * r)),
            chunk,
          );
        }
      };
      if (a.dashTime > 0 && b.dashTime <= 0) rob(a, b);
      else if (b.dashTime > 0 && a.dashTime <= 0) rob(b, a);
    });

    for (const p of this.players) {
      for (let i = this.coins.length - 1; i >= 0; i--) {
        const c = this.coins[i];
        if (Math.hypot(c.x - p.x, c.y - p.y) < PICKUP_DIST) {
          p.score += c.v;
          p.events.push('coin');
          this.coins.splice(i, 1);
        }
      }
    }

    if (this.t >= GAME_TIME) {
      return this.players.slice().sort((a, b) => b.score - a.score).map(p => p.id);
    }
    return null;
  }

  extras() {
    return {
      coins: this.coins.map(c => [c.id, Math.round(c.x), Math.round(c.y), c.v]),
      tl: Math.max(0, Math.ceil(GAME_TIME - this.t)),
    };
  }
}
