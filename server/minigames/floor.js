import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, spawnInCircle } from '../physics.js';

export const COLS = 20;
export const ROWS = 11;
export const TILE = 80; // COLS*TILE = 1600, ROWS*TILE = 880 (centered vertically)
const OFFSET_Y = (C.ARENA_H - ROWS * TILE) / 2;
const CRACK_AFTER = 0.45;   // solid -> cracked once stepped on
const BREAK_AFTER = 0.9;    // cracked -> gone
const MAX_TIME = C.FAST ? 6 : 90;

// Tile states: 0 solid, 1 cracked, 2 gone
export default class Floor {
  static id = 'floor';

  constructor(players) {
    this.players = players;
    this.t = 0;
    this.elimOrder = [];
    this.tiles = new Array(COLS * ROWS).fill(0);
    this.timers = new Array(COLS * ROWS).fill(-1); // time since first touch
    spawnInCircle(players, C.ARENA_W / 2, C.ARENA_H / 2, 300);
    players.forEach(p => { p.alive = true; p.score = 0; p.touched = new Set(); });
  }

  tileAt(x, y) {
    const cx = Math.floor(x / TILE);
    const cy = Math.floor((y - OFFSET_Y) / TILE);
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return -1;
    return cy * COLS + cx;
  }

  tick(dt) {
    this.t += dt;

    for (let i = 0; i < this.timers.length; i++) {
      if (this.timers[i] < 0) continue;
      this.timers[i] += dt;
      if (this.tiles[i] === 0 && this.timers[i] >= CRACK_AFTER) this.tiles[i] = 1;
      if (this.tiles[i] === 1 && this.timers[i] >= CRACK_AFTER + BREAK_AFTER) this.tiles[i] = 2;
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
      const ti = this.tileAt(p.x, p.y);
      if (ti === -1 || this.tiles[ti] === 2) {
        p.alive = false;
        p.events.push('fall');
        this.elimOrder.push(p.id);
        continue;
      }
      if (this.timers[ti] < 0) this.timers[ti] = 0;
      if (!p.touched.has(ti)) { p.touched.add(ti); p.score = p.touched.size; }
    }
    collidePlayers(this.players);

    const alive = this.players.filter(p => p.alive);
    if (alive.length <= 1 || this.t >= MAX_TIME) {
      const survivors = alive.slice().sort((a, b) => b.score - a.score).map(p => p.id);
      return [...survivors, ...this.elimOrder.slice().reverse()];
    }
    return null;
  }

  extras() {
    return {
      tiles: this.tiles.join(''), offsetY: OFFSET_Y, tile: TILE, cols: COLS, rows: ROWS,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
