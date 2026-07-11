import * as C from '../../shared/constants.js';
import { stepMovement, collidePlayers, boundRect, spawnInCircle } from '../physics.js';

// THE CHAMELEON (a Mecha Chameleon homage): statues of the squad litter the
// chamber. One is ALIVE and disguised. Watch for the twitch, dash the real
// one. Smashing a wrong statue costs the squad. Catch it three times.

const CATCHES_NEED = C.FAST ? 1 : 3;
const MAX_TIME = C.FAST ? 6 : 100;
const TELL_EVERY = C.FAST ? 0.2 : 4.2;   // seconds between twitches
const TELL_LEN = C.FAST ? 99 : 0.8;
const CATCH_R = C.PLAYER_RADIUS + 36;
const livesFor = n => 2 + Math.ceil(n / 2);

export default class Cham {
  static id = 'cham';
  static team = true;

  constructor(players, rng = Math.random) {
    this.players = players;
    this.rng = rng;
    this.t = 0;
    this.teamWin = false;
    this.lives = livesFor(players.length);
    this.catches = 0;
    this.nextDecoyId = 1;
    this.tellT = 0;
    this.tellIn = 2;
    this.calm = 1.5; // grace period after a re-disguise
    this.placeDecoys();
    spawnInCircle(players, C.ARENA_W / 2, C.ARENA_H - 160, 200);
    players.forEach(p => { p.alive = true; p.score = 0; p.stun = 0; });
  }

  placeDecoys() {
    const n = C.FAST ? 1 : Math.min(14, this.players.length * 2 + 2);
    this.decoys = [];
    let guard = 0;
    while (this.decoys.length < n && guard++ < 300) {
      const x = 160 + this.rng() * (C.ARENA_W - 320);
      const y = 140 + this.rng() * (C.ARENA_H - 420);
      if (this.decoys.every(d => Math.hypot(d.x - x, d.y - y) > 160)) {
        const mimic = this.players[Math.floor(this.rng() * this.players.length)];
        this.decoys.push({ id: this.nextDecoyId++, x, y, mimic: mimic.id, face: this.rng() * Math.PI * 2 });
      }
    }
    this.realId = this.decoys[Math.floor(this.rng() * this.decoys.length)].id;
    this.tellIn = 1.5 + this.rng() * 2;
    this.tellT = 0;
    this.calm = 1.2;
  }

  tick(dt) {
    this.t += dt;
    this.calm = Math.max(0, this.calm - dt);

    // the tell: every few seconds the real one twitches
    if (this.tellT > 0) {
      this.tellT -= dt;
    } else {
      this.tellIn -= dt;
      if (this.tellIn <= 0) { this.tellT = TELL_LEN; this.tellIn = TELL_EVERY + this.rng() * 2; }
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      p.stun = Math.max(0, p.stun - dt);
      p.freeze = p.stun > 0;
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
    }
    collidePlayers(this.players);

    // dash-checking statues
    for (const p of this.players) {
      if (!p.alive || p.dashTime <= 0 || this.calm > 0) continue;
      for (let i = this.decoys.length - 1; i >= 0; i--) {
        const d = this.decoys[i];
        if (Math.hypot(p.x - d.x, p.y - d.y) > CATCH_R) continue;
        if (d.id === this.realId) {
          this.catches++;
          p.score += 1;
          p.events.push('catch');
          if (this.catches >= CATCHES_NEED) {
            this.teamWin = true;
            return this.rankings();
          }
          this.placeDecoys(); // it shrieks and re-disguises elsewhere
        } else {
          this.decoys.splice(i, 1);
          this.lives--;
          p.stun = 0.9;
          p.events.push('smash');
          if (this.decoys.length <= 1 && !this.decoys.some(q => q.id === this.realId)) this.placeDecoys();
        }
        break;
      }
    }

    if (this.lives <= 0 || this.t >= MAX_TIME) return this.rankings();
    return null;
  }

  rankings() {
    return this.players.slice().sort((a, b) => b.score - a.score).map(p => p.id);
  }

  extras() {
    return {
      decoys: this.decoys.map(d => [d.id, Math.round(d.x), Math.round(d.y), d.mimic, Math.round(d.face * 100) / 100]),
      tell: this.tellT > 0 ? this.realId : null,
      catches: this.catches,
      need: CATCHES_NEED,
      lives: this.lives,
      goal: `caught ${this.catches}/${CATCHES_NEED}`,
      tl: Math.max(0, Math.ceil(MAX_TIME - this.t)),
    };
  }
}
