import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, applyChain } from '../physics.js';

export const COLS = 16;
export const ROWS = 11;
export const TILE = 80;
export const OFF_X = 160;                    // tiles span x 160..1440
const OFF_Y = (C.ARENA_H - ROWS * TILE) / 2;
export const EXIT_X = C.FAST ? 40 : OFF_X + COLS * TILE; // safe ledge beyond 1440
const CRACK_AFTER = 0.5;
const BREAK_AFTER = 1.0;
const MAX_TIME = C.FAST ? 6 : 90;
const LIVES = 4;
const RESPAWN_T = 2.2;

// CO-OP: cross the cavern. Every tile you touch crumbles behind the squad.
// Falling costs a shared life. Cleared when EVERYONE stands on the far ledge.
export default class Walk {
  static id = 'walk';
  static team = true;

  constructor(players) {
    this.players = players;
    this.t = 0;
    this.teamWin = false;
    this.lives = LIVES;
    this.exitOrder = [];
    this.tiles = new Array(COLS * ROWS).fill(0); // 0 solid, 1 cracked, 2 gone
    this.timers = new Array(COLS * ROWS).fill(-1);
    players.forEach((p, i) => {
      p.alive = true; p.score = 0; p.exited = false; p.respawnT = 0;
      this.placeAtStart(p, i, players.length);
    });
  }

  placeAtStart(p, i = 0, n = 1) {
    p.x = 60 + (i % 2) * 55;
    p.y = C.ARENA_H / 2 + (i - (n - 1) / 2) * 90;
    p.y = Math.min(C.ARENA_H - 60, Math.max(60, p.y));
    p.vx = 0; p.vy = 0;
  }

  tileAt(x, y) {
    const cx = Math.floor((x - OFF_X) / TILE);
    const cy = Math.floor((y - OFF_Y) / TILE);
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
      if (p.respawnT > 0) {
        p.respawnT -= dt;
        p.freeze = true;
        if (p.respawnT <= 0) p.freeze = false;
        continue;
      }
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);

      const wasExited = p.exited;
      p.exited = p.x >= EXIT_X - C.PLAYER_RADIUS * 0.5;
      if (p.exited && !wasExited && !this.exitOrder.includes(p.id)) {
        this.exitOrder.push(p.id);
        p.events.push('escape');
      }

      // Over the tile field: crumble what you touch, fall through what's gone.
      if (p.x > OFF_X && p.x < EXIT_X && (p.y < OFF_Y || p.y >= OFF_Y + ROWS * TILE)) {
        // The thin strips above/below the tile field are void too — nudge walls.
        p.y = Math.min(OFF_Y + ROWS * TILE - 1, Math.max(OFF_Y + 1, p.y));
      }
      const ti = this.tileAt(p.x, p.y);
      if (p.x <= OFF_X || p.exited) continue; // start/exit ledges are safe
      if (ti === -1) continue;
      if (this.tiles[ti] === 2) {
        this.lives--;
        p.events.push('fall');
        this.placeAtStart(p);
        p.respawnT = RESPAWN_T;
        p.freeze = true;
        continue;
      }
      if (this.timers[ti] < 0) this.timers[ti] = 0;
      if (!p.touched) p.touched = new Set();
      if (!p.touched.has(ti)) { p.touched.add(ti); p.score = p.touched.size; }
    }

    collidePlayers(this.players);
    // Respawning blobs drop out of the chain (no teleport yanks).
    const alive = this.players.filter(p => p.alive);
    let run = [];
    for (const p of alive) {
      if (p.respawnT > 0) { if (run.length > 1) applyChain(run, C.LINK_LEN); run = []; continue; }
      run.push(p);
    }
    if (run.length > 1) applyChain(run, C.LINK_LEN);

    const active = this.players.filter(p => p.alive);
    if (active.length && active.every(p => p.exited)) {
      this.teamWin = true;
      return this.rankings();
    }
    if (this.lives <= 0 || this.t >= MAX_TIME) return this.rankings();
    return null;
  }

  rankings() {
    // MVP: first across, then most ground scouted.
    const order = id => { const i = this.exitOrder.indexOf(id); return i === -1 ? 99 : i; };
    return this.players
      .slice()
      .sort((a, b) => (order(a.id) - order(b.id)) || (b.score - a.score))
      .map(p => p.id);
  }

  extras() {
    return {
      tiles: this.tiles.join(''),
      cols: COLS, rows: ROWS, tile: TILE, offX: OFF_X, offY: OFF_Y, exitX: EXIT_X,
      lives: this.lives,
      resp: Object.fromEntries(this.players.filter(p => p.respawnT > 0).map(p => [p.id, 1])),
      goal: `${this.exitOrder.length}/${this.players.filter(p => p.alive).length} across`,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
