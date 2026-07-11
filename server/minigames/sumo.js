import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, spawnInCircle } from '../physics.js';

const START_RING = 400;
const END_RING = 130;
const SHRINK_TIME = C.FAST ? 5 : 60;
const MAX_TIME = C.FAST ? 7 : 75;

export default class Sumo {
  static id = 'sumo';

  constructor(players) {
    this.players = players;
    this.t = 0;
    this.ring = START_RING;
    this.elimOrder = [];
    this.cx = C.ARENA_W / 2;
    this.cy = C.ARENA_H / 2;
    spawnInCircle(players, this.cx, this.cy, START_RING * 0.6);
    players.forEach(p => { p.alive = true; p.score = 0; });
  }

  tick(dt) {
    this.t += dt;
    this.ring = Math.max(END_RING, START_RING - (START_RING - END_RING) * (this.t / SHRINK_TIME));

    for (const p of this.players) {
      if (!p.alive) continue;
      stepMovement(p, dt);
      const d = Math.hypot(p.x - this.cx, p.y - this.cy);
      if (d > this.ring + C.PLAYER_RADIUS * 0.4) {
        p.alive = false;
        p.events.push('splat');
        this.elimOrder.push(p.id);
      }
    }
    collidePlayers(this.players);

    const alive = this.players.filter(p => p.alive);
    if (alive.length <= 1 || this.t >= MAX_TIME) {
      // Survivors rank above the eliminated; among survivors, closest to center wins.
      const survivors = alive
        .slice()
        .sort((a, b) => Math.hypot(a.x - this.cx, a.y - this.cy) - Math.hypot(b.x - this.cx, b.y - this.cy))
        .map(p => p.id);
      return [...survivors, ...this.elimOrder.slice().reverse()];
    }
    return null;
  }

  extras() {
    return { ring: Math.round(this.ring), tl: Math.max(0, Math.ceil(MAX_TIME - this.t)) };
  }
}
