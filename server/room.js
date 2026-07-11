import * as C from '../shared/constants.js';
import { CHAMBERS } from './minigames/index.js';
import { driveBot, driveHubBot, botVote, botName } from './bots.js';
import { Blackjack } from './blackjack.js';
import { stepMovement, collidePlayers, boundRect, applyChain } from './physics.js';

let nextPlayerId = 1;

const inRect = (p, z) => Math.abs(p.x - z.x) < z.w / 2 && Math.abs(p.y - z.y) < z.h / 2;
const inCircle = (p, z) => Math.hypot(p.x - z.x, p.y - z.y) < z.r;

export class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.phase = 'hub';        // hub | play
    this.hubMode = 'lobby';    // lobby | gate | blackjack | celebrate
    this.chamberIdx = 0;
    this.attempts = 0;
    this.totalPlays = 0;
    this.clearedOnce = [];
    this.game = null;
    this.gameClass = CHAMBERS[0];
    this.countdown = 0;
    this.hostId = null;
    this.lastResults = null;
    this.banner = null;          // {text, color, until}
    this.gateEndsAt = null;
    this.bj = null;
    this.bjVoteEnds = 0;
    this.bjVoteStart = 0;
    this.bjShowdownAt = 0;
    this.celebrateEnds = 0;
    this.standings = null;
    this.escaped = false;
    this.closed = false;
  }

  // ---- membership ----------------------------------------------------------

  addPlayer(conn, name, isBot = false) {
    if (this.players.size >= C.MAX_PLAYERS) return { error: 'Squad is full (8 blobs max).' };
    if (!(this.phase === 'hub' && this.hubMode === 'lobby')) {
      return { error: 'The boys are mid-expedition. Wait for the lobby.' };
    }
    const used = [...this.players.values()].map(p => p.color);
    const color = C.SLOP_COLORS.find(c => !used.includes(c)) || C.SLOP_COLORS[0];
    const n = this.players.size;
    const p = {
      id: nextPlayerId++,
      name: String(name || 'Blob').slice(0, 18),
      color,
      isBot,
      conn,
      connected: true,
      coins: C.START_COINS,
      input: { mx: 0, my: 0, dash: false },
      x: C.HUB.SPAWN.x + Math.cos(n * 2.4) * 120,
      y: C.HUB.SPAWN.y + Math.sin(n * 2.4) * 120,
      vx: 0, vy: 0, face: 0,
      dashCd: 0, dashTime: 0, speedMult: 1,
      alive: true, freeze: false, score: 0, stun: 0,
      events: [],
    };
    this.players.set(p.id, p);
    if (!isBot && (!this.hostId || !this.humans().some(h => h.id === this.hostId && h.connected))) {
      this.hostId = p.id;
    }
    this.sendMeta();
    return { player: p };
  }

  addBot() {
    const taken = [...this.players.values()].map(p => p.name);
    return this.addPlayer(null, botName(taken), true);
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    if (this.phase === 'hub' && this.hubMode === 'lobby') {
      this.players.delete(id);
    } else {
      p.connected = false;
      p.alive = false; // zombie until the expedition ends
    }
    if (this.hostId === id) {
      const nextHost = this.humans().find(h => h.connected);
      this.hostId = nextHost ? nextHost.id : null;
    }
    if (this.humans().filter(h => h.connected).length === 0) this.closed = true;
    else this.sendMeta();
  }

  humans() { return [...this.players.values()].filter(p => !p.isBot); }
  list() { return [...this.players.values()]; }
  crew() { return this.list().filter(p => p.connected); }

  // ---- messaging -----------------------------------------------------------

  send(p, msg) {
    if (p.conn && p.connected && p.conn.readyState === 1) p.conn.send(JSON.stringify(msg));
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.conn && p.connected && p.conn.readyState === 1) p.conn.send(s);
    }
  }

  sendMeta() {
    this.broadcast({
      t: 'meta',
      code: this.code,
      phase: this.phase,
      hubMode: this.hubMode,
      chamber: this.chamberIdx,
      chambers: C.CHAMBER_COUNT,
      attempts: this.attempts,
      cleared: this.clearedOnce.filter(Boolean).length,
      hostId: this.hostId,
      minigame: this.gameClass ? this.gameClass.id : null,
      players: this.list().map(p => ({
        id: p.id, name: p.name, color: p.color, isBot: p.isBot,
        connected: p.connected, coins: p.coins,
      })),
      lastResults: this.lastResults,
    });
  }

  setBanner(text, color = '#FFD84D', secs = C.BANNER_TIME) {
    this.banner = { text, color, until: Date.now() + secs * 1000 };
  }

  // ---- player intents ------------------------------------------------------

  handleInput(p, m) {
    if (!m || typeof m !== 'object') return;
    if (m.keys && typeof m.keys === 'object') {
      p.input.mx = (m.keys.right ? 1 : 0) - (m.keys.left ? 1 : 0);
      p.input.my = (m.keys.down ? 1 : 0) - (m.keys.up ? 1 : 0);
      if (m.keys.dash) p.input.dash = true;
    } else {
      p.input.mx = Math.max(-1, Math.min(1, Number(m.mx) || 0));
      p.input.my = Math.max(-1, Math.min(1, Number(m.my) || 0));
      if (m.dash) p.input.dash = true; // edge-triggered, consumed by physics
    }
  }

  handleEmote(p, e) {
    if (!C.EMOTES.includes(e)) return;
    this.broadcast({ t: 'emote', id: p.id, e });
  }

  handleChat(p, msg) {
    const clean = String(msg || '').slice(0, 120).trim();
    if (!clean) return;
    this.broadcast({ t: 'chat', id: p.id, name: p.name, msg: clean });
  }

  // ---- expedition flow -----------------------------------------------------

  startExpedition() {
    this.chamberIdx = 0;
    this.attempts = 0;
    this.totalPlays = 0;
    this.clearedOnce = [];
    this.lastResults = null;
    this.escaped = false;
    for (const p of this.players.values()) p.coins = C.START_COINS;
  }

  beginPlay() {
    if (this.hubMode === 'lobby') this.startExpedition();
    this.phase = 'play';
    this.gateEndsAt = null;
    this.banner = null;
    this.attempts++;
    this.gameClass = CHAMBERS[this.chamberIdx];
    const participants = this.crew();
    this.participants = participants.map(p => p.id);
    for (const p of participants) { p.alive = true; p.stun = 0; }
    this.game = new this.gameClass(participants);
    this.countdown = C.COUNTDOWN_TIME;
    for (const p of participants) p.freeze = true;
    this.sendMeta();
  }

  endPlay(rankings) {
    for (const id of this.participants) if (!rankings.includes(id)) rankings.push(id);
    this.totalPlays++;

    const win = this.game.teamWin === true;
    const mvpId = rankings[0];
    const payouts = {};
    const add = (id, amt, why) => {
      const p = this.players.get(id);
      if (!p || amt <= 0) return;
      p.coins += amt;
      (payouts[id] ||= []).push({ amt, why });
    };

    if (win) {
      const firstClear = !this.clearedOnce[this.chamberIdx];
      this.clearedOnce[this.chamberIdx] = true;
      const base = firstClear ? C.CLEAR_PAY : C.RECLEAR_PAY;
      const lifeBonus = firstClear ? (this.game.lives ?? 0) * C.LIFE_BONUS : 0;
      for (const id of this.participants) add(id, base + lifeBonus, firstClear ? 'chamber cleared' : 'cleared it AGAIN');
      add(mvpId, C.MVP_BONUS, 'MVP');
    } else {
      add(mvpId, Math.floor(C.MVP_BONUS / 2), 'at least YOU tried');
    }

    const mvp = this.players.get(mvpId);
    this.lastResults = {
      minigame: this.gameClass.id, teamWin: win, rankings, mvpId,
      payouts, livesLeft: this.game.lives ?? null, chamber: this.chamberIdx,
    };
    this.game = null;

    // Everyone back to the Den.
    this.phase = 'hub';
    this.crew().forEach((p, i) => {
      p.alive = true; p.freeze = false; p.stun = 0; p.speedMult = 1;
      p.x = C.HUB.SPAWN.x + Math.cos(i * 2.4) * 130;
      p.y = C.HUB.SPAWN.y + Math.sin(i * 2.4) * 130;
      p.vx = 0; p.vy = 0;
    });

    if (win) {
      if (this.chamberIdx >= C.CHAMBER_COUNT - 1) {
        // Clearing the final chamber IS the escape.
        this.beginCelebrate(true);
      } else {
        this.setBanner(`✅ CHAMBER CLEARED! MVP: ${mvp?.name ?? '?'} — now beat the Pit Boss to advance`, '#7CFC00', 8);
        this.beginBlackjack();
      }
    } else if (this.totalPlays >= C.MAX_TOTAL_PLAYS) {
      this.beginCelebrate(false);
    } else {
      this.setBanner('❌ THE PIT WINS THIS ONE — walk back through the gate to run it back', '#FF7676', 8);
      this.hubMode = 'gate';
    }
    this.sendMeta();
  }

  beginBlackjack() {
    this.hubMode = 'blackjack';
    this.bj = new Blackjack();
    if (this.bj.state === 'done') {
      this.bjShowdownAt = Date.now() + C.BJ_RESULT_TIME * 1000;
      this.bjVoteEnds = 0;
    } else {
      this.bjVoteStart = Date.now();
      this.bjVoteEnds = Date.now() + C.BJ_VOTE_TIME * 1000;
      this.bjShowdownAt = 0;
    }
    for (const p of this.players.values()) delete p.bjChoice;
    this.sendMeta();
  }

  bjZones() {
    const crew = this.crew().filter(p => p.alive);
    return {
      hitIds: crew.filter(p => inCircle(p, C.HUB.HIT)).map(p => p.id),
      standIds: crew.filter(p => inCircle(p, C.HUB.STAND)).map(p => p.id),
    };
  }

  resolveBjVote() {
    const { hitIds, standIds } = this.bjZones();
    // Majority of bodies; ties with actual voters HIT (of course they do);
    // an empty table plays it safe and stands.
    const choice = hitIds.length > standIds.length ? 'hit'
      : standIds.length > hitIds.length ? 'stand'
      : hitIds.length > 0 ? 'hit' : 'stand';
    const done = this.bj.act(choice);
    if (done) {
      this.bjShowdownAt = Date.now() + C.BJ_RESULT_TIME * 1000;
      this.bjVoteEnds = 0;
    } else {
      this.bjVoteStart = Date.now();
      this.bjVoteEnds = Date.now() + C.BJ_VOTE_TIME * 1000;
      for (const p of this.players.values()) delete p.bjChoice;
    }
    this.sendMeta();
  }

  afterBlackjack() {
    const outcome = this.bj?.outcome;
    this.bjShowdownAt = 0;
    if (outcome === 'push') {
      this.setBanner('😤 PUSH — the Boss re-deals', '#FFD84D', 4);
      this.beginBlackjack();
      return;
    }
    if (outcome === 'win' || outcome === 'natural') {
      const pay = outcome === 'natural' ? C.BJ_NATURAL_PAY : C.BJ_WIN_PAY;
      for (const p of this.crew()) p.coins += pay;
      this.chamberIdx++;
      this.attempts = 0;
      this.bj = null;
      this.gameClass = CHAMBERS[this.chamberIdx];
      this.setBanner(
        outcome === 'natural'
          ? `💎 NATURAL 21! +${pay}💰 each — the gate is open`
          : `🎉 THE BOYS BEAT THE BOSS! +${pay}💰 — the gate is open`,
        '#7CFC00', 7);
      this.hubMode = 'gate';
      this.sendMeta();
      return;
    }
    // Lost the hand.
    this.bj = null;
    if (this.totalPlays >= C.MAX_TOTAL_PLAYS) {
      this.beginCelebrate(false);
      return;
    }
    this.setBanner('💀 BUSTED BY THE BOSS — run the chamber back', '#FF7676', 7);
    this.hubMode = 'gate';
    this.sendMeta();
  }

  beginCelebrate(escaped) {
    this.hubMode = 'celebrate';
    this.escaped = escaped;
    this.bj = null;
    this.celebrateEnds = Date.now() + C.CELEBRATE_TIME * 1000;
    this.standings = this.list()
      .slice()
      .sort((a, b) => b.coins - a.coins)
      .map(p => ({ id: p.id, name: p.name, color: p.color, coins: p.coins }));
    this.setBanner(
      escaped ? '🏆 THE BOYS ESCAPED THE SLOP PIT 🏆' : `💀 THE PIT WINS — ${this.clearedOnce.filter(Boolean).length}/${C.CHAMBER_COUNT} chambers cleared`,
      escaped ? '#7CFC00' : '#FF7676',
      C.CELEBRATE_TIME);
    this.broadcast({
      t: 'podium',
      escaped,
      cleared: this.clearedOnce.filter(Boolean).length,
      chambers: C.CHAMBER_COUNT,
      standings: this.standings,
    });
    this.sendMeta();
  }

  backToLobby() {
    this.hubMode = 'lobby';
    this.chamberIdx = 0;
    this.attempts = 0;
    this.game = null;
    this.gameClass = CHAMBERS[0];
    this.lastResults = null;
    this.standings = null;
    this.banner = null;
    for (const [id, p] of this.players) if (!p.connected) this.players.delete(id);
    for (const p of this.players.values()) { p.alive = true; p.freeze = false; }
    this.sendMeta();
  }

  // ---- simulation ----------------------------------------------------------

  tickHub(dt) {
    const now = Date.now();
    const crew = this.crew().filter(p => p.alive);

    for (const p of crew) {
      if (p.isBot) driveHubBot(p, this, dt);
      stepMovement(p, dt);
      boundRect(p, C.ARENA_W, C.ARENA_H);
      // the Boss's table is solid
      const dx = p.x - C.HUB.TABLE.x, dy = p.y - C.HUB.TABLE.y;
      const d = Math.hypot(dx, dy);
      const minD = 130 + C.PLAYER_RADIUS;
      if (d < minD && d > 0) { p.x = C.HUB.TABLE.x + dx / d * minD; p.y = C.HUB.TABLE.y + dy / d * minD; }
    }
    collidePlayers(crew);
    applyChain(crew, C.LINK_LEN);

    if (this.banner && now > this.banner.until) this.banner = null;

    if (this.hubMode === 'lobby' || this.hubMode === 'gate') {
      const ins = crew.filter(p => inRect(p, C.HUB.GATE));
      const enough = crew.length >= 2;
      if (!enough) {
        this.gateEndsAt = null;
      } else if (ins.length === crew.length) {
        const t = now + C.GATE_CD_ALL * 1000;
        this.gateEndsAt = this.gateEndsAt ? Math.min(this.gateEndsAt, t) : t;
      } else if (ins.length >= Math.ceil(crew.length * 0.6)) {
        if (!this.gateEndsAt) this.gateEndsAt = now + C.GATE_CD_MAJORITY * 1000;
      } else {
        this.gateEndsAt = null;
      }
      if (this.gateEndsAt && now >= this.gateEndsAt) this.beginPlay();
    } else if (this.hubMode === 'blackjack' && this.bj) {
      if (this.bj.state === 'voting') {
        const { hitIds, standIds } = this.bjZones();
        const allIn = crew.length > 0 && hitIds.length + standIds.length === crew.length;
        const minWindow = this.bjVoteStart + Math.min(2500, C.BJ_VOTE_TIME * 400);
        if (now >= this.bjVoteEnds || (allIn && now >= minWindow)) this.resolveBjVote();
      } else if (this.bjShowdownAt && now >= this.bjShowdownAt) {
        this.afterBlackjack();
      }
    } else if (this.hubMode === 'celebrate') {
      if (now >= this.celebrateEnds) this.backToLobby();
    }
  }

  tick(dt) {
    if (this.phase === 'hub') {
      this.tickHub(dt);
      return;
    }
    if (this.phase === 'play' && this.game) {
      if (this.countdown > 0) {
        this.countdown -= dt;
        if (this.countdown <= 0) {
          this.countdown = 0;
          for (const p of this.players.values()) p.freeze = false;
        }
        return;
      }
      const participants = this.list().filter(p => this.participants.includes(p.id));
      for (const p of participants) {
        if (p.isBot && p.alive) driveBot(p, this.game, participants, dt);
        if (!p.connected) p.input = { mx: 0, my: 0, dash: false };
      }
      const rankings = this.game.tick(dt);
      if (rankings) this.endPlay(rankings);
    }
  }

  hubExtras() {
    const now = Date.now();
    const ex = { hub: this.hubMode };
    if (this.banner) ex.banner = { text: this.banner.text, color: this.banner.color };
    if (this.hubMode === 'lobby' || this.hubMode === 'gate') {
      const crew = this.crew().filter(p => p.alive);
      ex.gate = {
        in: crew.filter(p => inRect(p, C.HUB.GATE)).map(p => p.id),
        need: Math.max(2, Math.ceil(crew.length * 0.6)),
        total: crew.length,
        cd: this.gateEndsAt ? Math.max(0, Math.round((this.gateEndsAt - now) / 100) / 10) : null,
      };
    } else if (this.hubMode === 'blackjack' && this.bj) {
      const { hitIds, standIds } = this.bjZones();
      ex.bj = {
        ...this.bj.publicState(),
        hitIds, standIds,
        voteLeft: this.bjVoteEnds ? Math.max(0, Math.round((this.bjVoteEnds - now) / 100) / 10) : null,
      };
    } else if (this.hubMode === 'celebrate') {
      ex.standings = this.standings;
      ex.escaped = this.escaped;
    }
    return ex;
  }

  snapshot() {
    if (this.phase === 'play' && !this.game) return null;
    const ids = this.phase === 'play' ? this.participants : this.crew().map(p => p.id);
    const players = this.list()
      .filter(p => ids.includes(p.id))
      .map(p => {
        const ev = p.events;
        p.events = [];
        return [
          p.id,
          Math.round(p.x * 10) / 10,
          Math.round(p.y * 10) / 10,
          p.alive ? 1 : 0,
          Math.round((p.score || 0) * 10) / 10,
          Math.round(p.dashCd * 100) / 100,
          p.dashTime > 0 ? 1 : 0,
          ev,
        ];
      });
    return {
      t: 'state',
      countdown: this.phase === 'play' ? Math.ceil(this.countdown) : 0,
      players,
      extra: this.phase === 'play' ? this.game.extras() : this.hubExtras(),
    };
  }
}
