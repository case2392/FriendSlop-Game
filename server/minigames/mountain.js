import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, applyChain } from '../physics.js';

// The vertical engine shared by the two climbing finales. The plane is a
// cliff face: y=900 is the base, y=0 is the summit. Ledges are safe footing,
// slime vines are climbable, bare rock means you slide.
//
//   CHAINED TOGETHER — chained squad + a rising slop tide (Chained Together)
//   THE PEAK         — no chain, taller, falling slop globs (PEAK)

const GRAVITY = 1500;
const AIR_CONTROL = 0.3;
const CLIMB_UP_SPEED = 0.55;
const GLOB_R = 30;

export function makeMountain(cfg) {
  const SUMMIT_Y = C.FAST ? 895 : cfg.summitY;
  const MAX_TIME = C.FAST ? 6 : cfg.maxTime;

  return class Mountain {
    static id = cfg.id;
    static team = true;
    static chained = !!cfg.chained;

    constructor(players, rng = Math.random) {
      this.players = players;
      this.rng = rng;
      this.t = 0;
      this.teamWin = false;
      this.summitOrder = [];
      this.globs = [];
      this.globT = 3;
      this.nextGlobId = 1;
      this.lives = cfg.lives ? cfg.lives(players.length) : null;
      this.tideY = cfg.tide ? 940 : null;
      this.buildMountain();
      players.forEach((p, i) => {
        p.alive = true; p.score = 0; p.stun = 0; p.speedMult = 1;
        p.bestAlt = 0; p.summited = false;
        p.x = C.ARENA_W / 2 + (i - (players.length - 1) / 2) * 90;
        p.y = 862;
        p.vx = 0; p.vy = 0;
      });
    }

    buildMountain() {
      this.ledges = [{ x: C.ARENA_W / 2, y: 885, w: C.ARENA_W, h: 44 }];
      this.climbs = [];
      let prevRow = [this.ledges[0]];
      for (let y = 760; y > SUMMIT_Y + 40; y -= 95 + this.rng() * 25) {
        const row = [];
        const n = 2 + (this.rng() < 0.5 ? 1 : 0);
        let guard = 0;
        while (row.length < n && guard++ < 40) {
          const w = 170 + this.rng() * 130;
          const x = 120 + w / 2 + this.rng() * (C.ARENA_W - 240 - w);
          if (row.every(l => Math.abs(l.x - x) > (l.w + w) / 2 + 60)) row.push({ x, y, w, h: 26 });
        }
        if (!row.length) continue;
        // every ledge gets a vine down to the nearest ledge below — no dead ends
        for (const top of row) {
          let below = prevRow[0];
          for (const l of prevRow) if (Math.abs(l.x - top.x) < Math.abs(below.x - top.x)) below = l;
          const reach = Math.max(below.x - below.w / 2, Math.min(below.x + below.w / 2, top.x));
          const vx = Math.max(90, Math.min(C.ARENA_W - 90, (top.x + reach) / 2 + (this.rng() - 0.5) * 60));
          this.climbs.push({ x: vx, w: 76, yTop: top.y - 12, yBot: below.y + 12 });
        }
        this.ledges.push(...row);
        prevRow = row;
      }
      const summit = { x: C.ARENA_W / 2, y: SUMMIT_Y - 15, w: 620, h: 44 };
      this.ledges.push(summit);
      for (const dx of [-160, 160]) {
        let below = prevRow[0];
        for (const l of prevRow) if (Math.abs(l.x - (summit.x + dx)) < Math.abs(below.x - (summit.x + dx))) below = l;
        this.climbs.push({ x: summit.x + dx, w: 76, yTop: summit.y - 12, yBot: below.y + 12 });
      }
    }

    onLedge(p) {
      return this.ledges.some(l =>
        Math.abs(p.x - l.x) < l.w / 2 + C.PLAYER_RADIUS * 0.5 &&
        p.y > l.y - l.h / 2 - C.PLAYER_RADIUS && p.y < l.y + l.h / 2 + C.PLAYER_RADIUS);
    }

    onClimb(p) {
      return this.climbs.some(c =>
        Math.abs(p.x - c.x) < c.w / 2 + C.PLAYER_RADIUS * 0.4 &&
        p.y > c.yTop - 14 && p.y < c.yBot + 14);
    }

    // lowest ledge safely above the tide; ties broken by nearness to x
    rescueSpot(x) {
      let best = null;
      for (const l of this.ledges) {
        if (this.tideY !== null && l.y > this.tideY - 80) continue; // too close to the tide
        if (!best
          || l.y > best.y + 1
          || (Math.abs(l.y - best.y) <= 1 && Math.abs(l.x - x) < Math.abs(best.x - x))) {
          best = l;
        }
      }
      return best || this.ledges[this.ledges.length - 1];
    }

    tick(dt) {
      this.t += dt;

      if (this.tideY !== null && this.t > 10) {
        this.tideY -= cfg.tide.speed * dt;
      }

      if (cfg.globs) {
        this.globT -= dt;
        if (this.globT <= 0) {
          this.globT = C.FAST ? 999 : 2.4;
          this.globs.push({ id: this.nextGlobId++, x: 150 + this.rng() * (C.ARENA_W - 300), y: -20, vy: 60 });
        }
        for (let i = this.globs.length - 1; i >= 0; i--) {
          const g = this.globs[i];
          g.vy = Math.min(520, g.vy + 620 * dt);
          g.y += g.vy * dt;
          if (g.y > 930) { this.globs.splice(i, 1); continue; }
          for (const p of this.players) {
            if (!p.alive || p.stun > 0) continue;
            if (Math.hypot(p.x - g.x, p.y - g.y) < GLOB_R + C.PLAYER_RADIUS) {
              p.vy += 420;
              p.vx += (p.x - g.x) * 4;
              p.stun = 0.55;
              p.events.push('bonk');
              this.globs.splice(i, 1);
              break;
            }
          }
        }
      }

      for (const p of this.players) {
        if (!p.alive) continue;
        p.stun = Math.max(0, p.stun - dt);
        p.freeze = p.stun > 0;

        const ledge = this.onLedge(p);
        const climb = this.onClimb(p);
        stepMovement(p, dt);
        if (!ledge && !climb) {
          // bare rock: sliding. Up is impossible, steering barely helps.
          if (p.vy < 0) p.vy *= AIR_CONTROL;
          p.vy = Math.min(640, p.vy + GRAVITY * dt);
        } else if (climb && !ledge) {
          if (p.vy < 0) p.vy *= CLIMB_UP_SPEED;
        }
        p.x = Math.max(C.PLAYER_RADIUS, Math.min(C.ARENA_W - C.PLAYER_RADIUS, p.x));
        p.y = Math.max(20, Math.min(898, p.y));

        // the tide
        if (this.tideY !== null && p.y > this.tideY) {
          this.lives--;
          p.events.push('burn');
          const spot = this.rescueSpot(p.x);
          p.x = Math.max(spot.x - spot.w / 2 + 30, Math.min(spot.x + spot.w / 2 - 30, p.x));
          p.y = spot.y - 30;
          p.vx = 0; p.vy = 0;
          p.stun = 0.9;
          if (this.lives <= 0) return this.rankings();
        }

        const alt = 900 - p.y;
        if (alt > p.bestAlt) { p.bestAlt = alt; p.score = Math.round(alt); }
        if (!p.summited && p.y < SUMMIT_Y) {
          p.summited = true;
          p.events.push('escape');
          this.summitOrder.push(p.id);
        }
        if (p.summited && p.y >= SUMMIT_Y + 45) p.summited = false; // dragged back off!
      }

      collidePlayers(this.players);
      if (cfg.chained) applyChain(this.players.filter(p => p.alive), cfg.linkLen || C.LINK_LEN);

      const active = this.players.filter(p => p.alive);
      if (active.length && active.every(p => p.summited)) {
        this.teamWin = true;
        return this.rankings();
      }
      if (this.t >= MAX_TIME) return this.rankings();
      return null;
    }

    rankings() {
      const order = id => { const i = this.summitOrder.indexOf(id); return i === -1 ? 99 : i; };
      return this.players
        .slice()
        .sort((a, b) => (order(a.id) - order(b.id)) || (b.bestAlt - a.bestAlt))
        .map(p => p.id);
    }

    extras() {
      return {
        chained: cfg.chained ? 1 : 0,
        mountain: 1,
        ledges: this.ledges.map(l => [Math.round(l.x), Math.round(l.y), Math.round(l.w), l.h]),
        climbs: this.climbs.map(c => [Math.round(c.x), c.w, Math.round(c.yTop), Math.round(c.yBot)]),
        globs: this.globs.map(g => [g.id, Math.round(g.x), Math.round(g.y)]),
        tide: this.tideY !== null ? Math.round(this.tideY) : null,
        summitY: SUMMIT_Y,
        lives: this.lives,
        goal: `${this.summitOrder.length}/${this.players.filter(p => p.alive).length} at the summit`,
        tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
      };
    }
  };
}
