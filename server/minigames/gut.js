import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, applyChain, spawnInCircle } from '../physics.js';

const CALM = C.FAST ? 0.5 : 4.5;
const WARN = C.FAST ? 0.5 : 3.2;
const FLOOD = C.FAST ? 0.5 : 2.2;
const WAVES_NEED = C.FAST ? 1 : 4;
const LIVES = 4;
const MAX_TIME = C.FAST ? 8 : 90;
// Islands per wave: fewer and smaller as the gut gets angrier.
const WAVE_ISLANDS = [
  { n: 3, r: 165 },
  { n: 3, r: 140 },
  { n: 2, r: 130 },
  { n: 2, r: 110 },
];

// CO-OP: when the gut rumbles, get the whole chain onto a safe island before
// the acid wave. Caught in the open = a shared life. Survive every wave.
export default class Gut {
  static id = 'gut';
  static team = true;

  constructor(players, rng = Math.random) {
    this.players = players;
    this.rng = rng;
    this.t = 0;
    this.teamWin = false;
    this.lives = LIVES;
    this.wave = 0;             // completed waves
    this.state = 'calm';
    this.stateT = CALM;
    this.islands = [];
    spawnInCircle(players, C.ARENA_W / 2, C.ARENA_H / 2, 280);
    players.forEach(p => { p.alive = true; p.score = 0; p.stun = 0; p.caught = false; });
  }

  pickIslands() {
    const cfg = WAVE_ISLANDS[Math.min(this.wave, WAVE_ISLANDS.length - 1)];
    const r = C.FAST ? 1200 : cfg.r;
    const isles = [];
    let guard = 0;
    while (isles.length < cfg.n && guard++ < 200) {
      const x = 250 + this.rng() * (C.ARENA_W - 500);
      const y = 220 + this.rng() * (C.ARENA_H - 440);
      if (isles.every(i => Math.hypot(i.x - x, i.y - y) > r * 2.4)) isles.push({ x, y, r });
    }
    this.islands = isles;
  }

  onIsland(p) {
    return this.islands.some(i => Math.hypot(p.x - i.x, p.y - i.y) < i.r);
  }

  tick(dt) {
    this.t += dt;
    this.stateT -= dt;

    if (this.stateT <= 0) {
      if (this.state === 'calm') {
        this.state = 'warn';
        this.stateT = WARN;
        this.pickIslands();
      } else if (this.state === 'warn') {
        this.state = 'flood';
        this.stateT = FLOOD;
        for (const p of this.players) p.caught = false;
      } else {
        // flood over: score the wave
        for (const p of this.players) if (p.alive && !p.caught) p.score++;
        this.wave++;
        this.islands = [];
        if (this.wave >= WAVES_NEED) {
          this.teamWin = true;
          return this.rankings();
        }
        this.state = 'calm';
        this.stateT = CALM;
      }
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      p.stun = Math.max(0, p.stun - dt);
      p.freeze = p.stun > 0;
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);

      if (this.state === 'flood' && !p.caught && !this.onIsland(p)) {
        p.caught = true;
        this.lives--;
        p.stun = 1.1;
        p.events.push('burn');
        // The acid spits them toward the nearest island's edge.
        let best = this.islands[0];
        for (const i of this.islands) if (Math.hypot(i.x - p.x, i.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y)) best = i;
        if (best) {
          const d = Math.hypot(best.x - p.x, best.y - p.y) || 1;
          p.x = best.x - (best.x - p.x) / d * (best.r * 0.5);
          p.y = best.y - (best.y - p.y) / d * (best.r * 0.5);
          p.vx = 0; p.vy = 0;
        }
      }
    }
    collidePlayers(this.players);
    applyChain(this.players.filter(p => p.alive), C.LINK_LEN);

    if (this.lives <= 0 || this.t >= MAX_TIME) return this.rankings();
    return null;
  }

  rankings() {
    return this.players.slice().sort((a, b) => b.score - a.score).map(p => p.id);
  }

  extras() {
    return {
      state: this.state,
      stateT: Math.max(0, Math.round(this.stateT * 10) / 10),
      islands: this.islands.map(i => [Math.round(i.x), Math.round(i.y), Math.min(i.r, 200)]),
      wave: this.wave,
      need: WAVES_NEED,
      lives: this.lives,
      goal: `wave ${Math.min(this.wave + 1, WAVES_NEED)}/${WAVES_NEED}`,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
