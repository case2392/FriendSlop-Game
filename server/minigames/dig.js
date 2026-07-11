import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect } from '../physics.js';

// THE DIG SITE (a Keep Digging homage): dash the floor to crack it, fall
// through, repeat. The squad wins when EVERYONE reaches the bottom floor.
// Digging loots progressively rarer pickaxes (gray -> white -> green ->
// blue -> purple) that dig faster — and you carry yours for the rest of
// the expedition, where it does absolutely nothing.

const AXE_AT = [3, 7, 12, 18]; // tiles broken -> tier 1..4

export const COLS = 16;
export const ROWS = 9;
export const TILE = 100; // 16x100 = 1600, 9x100 = 900
const LAYERS = C.FAST ? 1 : 3;
const TILE_HP = C.FAST ? 1 : 2;
const STAND_DIG = C.FAST ? 0.15 : 0.9;  // seconds standing on a tile per 1 damage
const MAX_TIME = C.FAST ? 6 : 110;
const FALL_STUN = 0.35;

export default class Dig {
  static id = 'dig';
  static team = true;

  constructor(players) {
    this.players = players;
    this.t = 0;
    this.teamWin = false;
    this.doneOrder = [];
    this.layers = [];
    for (let l = 0; l < LAYERS; l++) this.layers.push(new Array(COLS * ROWS).fill(TILE_HP));
    players.forEach((p, i) => {
      p.alive = true; p.score = 0; p.layer = 0; p.done = false;
      p.standT = 0; p.standTile = -1; p.digCd = 0; p.stun = 0;
      const ang = (i / players.length) * Math.PI * 2;
      p.x = C.ARENA_W / 2 + Math.cos(ang) * 300;
      p.y = C.ARENA_H / 2 + Math.sin(ang) * 250;
      p.vx = 0; p.vy = 0;
    });
  }

  tileAt(x, y) {
    const cx = Math.floor(x / TILE);
    const cy = Math.floor(y / TILE);
    if (cx < 0 || cx >= COLS || cy < 0 || cy >= ROWS) return -1;
    return cy * COLS + cx;
  }

  damage(p, ti, amt) {
    const grid = this.layers[p.layer];
    if (!grid || grid[ti] <= 0) return;
    grid[ti] = Math.max(0, grid[ti] - amt);
    if (grid[ti] === 0) {
      p.score++;
      p.events.push('crack');
      const tier = AXE_AT.filter(n => p.score >= n).length;
      if (tier > (p.axeTier || 0)) {
        p.axeTier = tier;
        p.events.push('loot' + tier);
      }
    }
  }

  tick(dt) {
    this.t += dt;

    for (const p of this.players) {
      if (!p.alive) continue;
      p.digCd = Math.max(0, p.digCd - dt);
      p.stun = Math.max(0, p.stun - dt);
      p.freeze = p.stun > 0;
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
      if (p.done) continue;

      const ti = this.tileAt(p.x, p.y);
      if (ti === -1) continue;
      const grid = this.layers[p.layer];

      if (grid[ti] <= 0) {
        // standing over a hole: down we go
        p.layer++;
        p.stun = FALL_STUN;
        p.events.push('fall');
        p.standTile = -1;
        if (p.layer >= LAYERS) {
          p.done = true;
          p.layer = LAYERS;
          p.events.push('escape');
          this.doneOrder.push(p.id);
        }
        continue;
      }
      // dash-digging cracks the tile hard; big axes crack harder
      const tier = p.axeTier || 0;
      if (p.dashTime > 0 && p.digCd === 0) {
        this.damage(p, ti, tier >= 3 ? 2 : 1);
        p.digCd = Math.max(0.28, 0.45 - tier * 0.04);
        p.events.push('dig');
      }
      // loitering digs slowly (faster with a better axe)
      if (ti === p.standTile) {
        p.standT += dt;
        const need = STAND_DIG * (1 - tier * 0.13);
        if (p.standT >= need) { this.damage(p, ti, 1); p.standT = 0; }
      } else {
        p.standTile = ti;
        p.standT = 0;
      }
    }

    // collisions only among same-layer diggers
    for (let l = 0; l <= LAYERS; l++) {
      collidePlayers(this.players.filter(p => p.alive && p.layer === l));
    }

    const active = this.players.filter(p => p.alive);
    if (active.length && active.every(p => p.done)) {
      // FRIENDSLOP_PHOTO holds the chamber open so screenshots can pose
      if (!process.env.FRIENDSLOP_PHOTO || this.t >= 60) {
        this.teamWin = true;
        return this.rankings();
      }
    }
    if (this.t >= MAX_TIME) return this.rankings();
    return null;
  }

  rankings() {
    return this.players
      .slice()
      .sort((a, b) => (b.layer - a.layer) || (b.score - a.score))
      .map(p => p.id);
  }

  extras() {
    const enc = grid => grid.map(hp => hp >= TILE_HP ? '0' : hp > 0 ? '1' : '2').join('');
    return {
      layers: this.layers.map(enc),
      pl: Object.fromEntries(this.players.map(p => [p.id, p.layer])),
      depth: LAYERS,
      cols: COLS, rows: ROWS, tile: TILE,
      goal: `${this.doneOrder.length}/${this.players.filter(p => p.alive).length} at the bottom`,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
