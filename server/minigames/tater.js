import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, spawnInCircle } from '../physics.js';

const START_FUSE = C.FAST ? 2 : 14;
const MIN_FUSE = C.FAST ? 1 : 6;
const MAX_TIME = C.FAST ? 8 : 150;
const HOLDER_SPEED_MULT = 1.18;

export default class Tater {
  static id = 'tater';

  constructor(players, rng = Math.random) {
    this.players = players;
    this.rng = rng;
    this.t = 0;
    this.fuseMax = START_FUSE;
    this.elimOrder = [];
    this.transferCd = 0;
    spawnInCircle(players, C.ARENA_W / 2, C.ARENA_H / 2, 330);
    players.forEach(p => { p.alive = true; p.score = 0; p.speedMult = 1; });
    this.giveTater(players[Math.floor(rng() * players.length)].id);
  }

  giveTater(id) {
    this.taterId = id;
    this.fuse = this.fuseMax;
    this.transferCd = 1.0;
    for (const p of this.players) p.speedMult = p.id === id ? HOLDER_SPEED_MULT : 1;
  }

  tick(dt) {
    this.t += dt;
    this.fuse -= dt;
    this.transferCd = Math.max(0, this.transferCd - dt);

    for (const p of this.players) {
      if (!p.alive) continue;
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
    }
    collidePlayers(this.players, (a, b) => {
      if (this.transferCd > 0) return;
      if (a.id === this.taterId && b.alive) { this.giveTater(b.id); b.events.push('tater'); }
      else if (b.id === this.taterId && a.alive) { this.giveTater(a.id); a.events.push('tater'); }
    });

    if (this.fuse <= 0) {
      const holder = this.players.find(p => p.id === this.taterId);
      if (holder) {
        holder.alive = false;
        holder.speedMult = 1;
        holder.events.push('boom');
        this.elimOrder.push(holder.id);
      }
      const alive = this.players.filter(p => p.alive);
      if (alive.length > 1) {
        this.fuseMax = Math.max(MIN_FUSE, this.fuseMax - 2);
        this.giveTater(alive[Math.floor(this.rng() * alive.length)].id);
      }
    }

    const alive = this.players.filter(p => p.alive);
    if (alive.length <= 1 || this.t >= MAX_TIME) {
      // On timeout with several alive, whoever is NOT holding ranks above the holder.
      const survivors = alive
        .slice()
        .sort((a, b) => (a.id === this.taterId ? 1 : 0) - (b.id === this.taterId ? 1 : 0))
        .map(p => p.id);
      return [...survivors, ...this.elimOrder.slice().reverse()];
    }
    return null;
  }

  extras() {
    return { taterId: this.taterId, fuse: Math.max(0, Math.round(this.fuse * 10) / 10) };
  }
}
