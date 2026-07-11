import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, applyChain, spawnInCircle } from '../physics.js';

const FUSE = C.FAST ? 3 : 13;
const DUNKS_NEED = C.FAST ? 1 : 4;
const LIVES = 3;
const MAX_TIME = C.FAST ? 8 : 100;
const HOLE_R = C.FAST ? 2000 : 85;
const NEXT_TATER_DELAY = 2;
const BLAST_R = 250;
const HOLDER_SPEED_MULT = 1.12;

// CO-OP: the pit coughs up lit gallstones. The holder must drag the whole
// chain to the drain and dunk it before the fuse runs out. Explosions cost
// shared lives. Dunk enough to clear the chamber.
export default class Tater {
  static id = 'tater';
  static team = true;

  constructor(players, rng = Math.random) {
    this.players = players;
    this.rng = rng;
    this.t = 0;
    this.teamWin = false;
    this.lives = LIVES;
    this.dunks = 0;
    this.taterId = null;
    this.fuse = 0;
    this.nextIn = C.COUNTDOWN_TIME > 1 ? 1.5 : 0.2;
    this.transferCd = 0;
    this.hole = null;
    this.moveHole();
    spawnInCircle(players, C.ARENA_W / 2, C.ARENA_H / 2, 300);
    players.forEach(p => { p.alive = true; p.score = 0; p.stun = 0; p.speedMult = 1; });
  }

  moveHole() {
    this.hole = {
      x: 220 + this.rng() * (C.ARENA_W - 440),
      y: 200 + this.rng() * (C.ARENA_H - 400),
    };
  }

  lightTater() {
    const candidates = this.players.filter(p => p.alive);
    if (!candidates.length) return;
    const holder = candidates[Math.floor(this.rng() * candidates.length)];
    this.taterId = holder.id;
    this.fuse = FUSE;
    this.transferCd = 1.0;
    holder.events.push('tater');
    for (const p of this.players) p.speedMult = p.id === this.taterId ? HOLDER_SPEED_MULT : 1;
  }

  tick(dt) {
    this.t += dt;
    this.transferCd = Math.max(0, this.transferCd - dt);

    if (this.taterId === null) {
      this.nextIn -= dt;
      if (this.nextIn <= 0) this.lightTater();
    } else {
      this.fuse -= dt;
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      p.stun = Math.max(0, p.stun - dt);
      p.freeze = p.stun > 0;
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
    }
    collidePlayers(this.players, (a, b) => {
      if (this.transferCd > 0 || this.taterId === null) return;
      if (a.id === this.taterId) { this.passTo(b); }
      else if (b.id === this.taterId) { this.passTo(a); }
    });
    applyChain(this.players.filter(p => p.alive), C.LINK_LEN);

    const holder = this.players.find(p => p.id === this.taterId);

    // Dunk it!
    if (holder && Math.hypot(holder.x - this.hole.x, holder.y - this.hole.y) < HOLE_R) {
      this.dunks++;
      holder.score++;
      holder.events.push('dunk');
      this.taterId = null;
      this.nextIn = NEXT_TATER_DELAY;
      for (const p of this.players) p.speedMult = 1;
      this.moveHole();
      if (this.dunks >= DUNKS_NEED) {
        this.teamWin = true;
        return this.rankings();
      }
    }

    // Kaboom.
    if (holder && this.fuse <= 0) {
      this.lives--;
      holder.events.push('boom');
      for (const p of this.players) {
        const d = Math.hypot(p.x - holder.x, p.y - holder.y);
        if (d < BLAST_R) {
          const k = (1 - d / BLAST_R) * 900;
          const nx = (p.x - holder.x) / (d || 1), ny = (p.y - holder.y) / (d || 1);
          p.vx += nx * k; p.vy += ny * k;
          p.stun = Math.max(p.stun, 1.0);
        }
      }
      this.taterId = null;
      this.nextIn = NEXT_TATER_DELAY;
      for (const p of this.players) p.speedMult = 1;
    }

    if (this.lives <= 0 || this.t >= MAX_TIME) return this.rankings();
    return null;
  }

  passTo(p) {
    if (!p.alive) return;
    this.taterId = p.id;
    this.transferCd = 0.8;
    p.events.push('tater');
    for (const q of this.players) q.speedMult = q.id === this.taterId ? HOLDER_SPEED_MULT : 1;
  }

  rankings() {
    return this.players.slice().sort((a, b) => b.score - a.score).map(p => p.id);
  }

  extras() {
    return {
      taterId: this.taterId,
      fuse: this.taterId !== null ? Math.max(0, Math.round(this.fuse * 10) / 10) : null,
      hole: [Math.round(this.hole.x), Math.round(this.hole.y), Math.min(HOLE_R, 85)],
      dunks: this.dunks,
      need: DUNKS_NEED,
      lives: this.lives,
      goal: `dunked ${this.dunks}/${DUNKS_NEED}`,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
