import * as C from '../shared/constants.js';

const BOT_NAMES = [
  'Gravy Boat', 'Moist Goblin', 'Crusty Dave', 'Lord Slop', 'Beans',
  'Wet Bandit', 'Soggy Kyle', 'Grease Wizard', 'Chunk', 'Damp Steve',
];

export function botName(taken) {
  const free = BOT_NAMES.filter(n => !taken.includes(n + ' 🤖'));
  const pool = free.length ? free : BOT_NAMES;
  return pool[Math.floor(Math.random() * pool.length)] + ' 🤖';
}

function steerToward(bot, tx, ty) {
  const dx = tx - bot.x, dy = ty - bot.y;
  const d = Math.hypot(dx, dy);
  if (d < 16) { bot.input.mx = 0; bot.input.my = 0; return; }
  bot.input.mx = dx / d;
  bot.input.my = dy / d;
}

// Called every tick for each alive bot while a chamber is running.
export function driveBot(bot, game, players, dt) {
  bot.aiT = (bot.aiT || 0) - dt;
  if (bot.aiT > 0) return;         // re-plan ~8x/sec so bots feel organic
  bot.aiT = 0.12 + Math.random() * 0.08;
  bot.input.dash = false;

  const id = game.constructor.id;

  if (id === 'dig') {
    if (bot.done) { steerToward(bot, C.ARENA_W / 2, C.ARENA_H / 2); return; }
    const grid = game.layers[bot.layer];
    const myTile = game.tileAt(bot.x, bot.y);
    if (myTile !== -1 && grid && grid[myTile] > 0) {
      // dig where you stand
      steerToward(bot, bot.x, bot.y);
      if (bot.dashCd === 0 && Math.random() < 0.8) bot.input.dash = true;
    } else if (grid) {
      // find something intact to break (or a hole was left for us — stand on it)
      let best = null, bd = Infinity;
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] <= 0) continue;
        const tx = (i % 16) * 100 + 50, ty = Math.floor(i / 16) * 100 + 50;
        const d = Math.hypot(tx - bot.x, ty - bot.y) + Math.random() * 150;
        if (d < bd) { bd = d; best = { tx, ty }; }
      }
      if (best) steerToward(bot, best.tx, best.ty);
    }
  } else if (id === 'rv') {
    // get behind the bumper and push east; dash into it now and then
    const rv = game.rv;
    const behindX = rv.x - 130;
    const laneY = rv.y + Math.sin(bot.id * 2.1) * 60;
    const d = Math.hypot(behindX - bot.x, laneY - bot.y);
    steerToward(bot, d < 40 ? rv.x : behindX, d < 40 ? rv.y : laneY);
    if (d < 60 && bot.dashCd === 0 && Math.random() < 0.5) bot.input.dash = true;
  } else if (id === 'casino') {
    const bj = game.bj;
    if (bj && bj.state === 'voting') {
      const key = game.handNo * 100 + game.windowNo;
      if (bot.bjKey !== key) {
        bot.bjKey = key;
        bot.bjChoice = null;
        bot.bjDelay = 0.5 + Math.random() * 1.6;
      }
      if (bot.bjChoice === null) {
        bot.bjDelay -= 0.18;
        if (bot.bjDelay <= 0) bot.bjChoice = botVote(bj.squadTotal());
        steerToward(bot, C.HUB.TABLE.x + Math.sin(bot.id * 2.7) * 250, 480);
        return;
      }
      const zone = bot.bjChoice === 'hit' ? C.HUB.HIT : C.HUB.STAND;
      steerToward(bot, zone.x + (Math.random() - 0.5) * zone.r, zone.y + (Math.random() - 0.5) * zone.r);
    } else {
      steerToward(bot, C.HUB.TABLE.x + Math.sin(bot.id * 2.7) * 260, 500 + Math.cos(bot.id) * 60);
    }
  } else if (id === 'cham') {
    // loiter near statues; when the twitch happens, the nearest bot pounces
    if (game.tellT > 0) {
      const real = game.decoys.find(d => d.id === game.realId);
      if (real) {
        steerToward(bot, real.x, real.y);
        if (Math.hypot(real.x - bot.x, real.y - bot.y) < 170 && bot.dashCd === 0) bot.input.dash = true;
        return;
      }
    }
    // drift between statues, watching
    if (!bot.watchId || Math.random() < 0.05) {
      const d = game.decoys[Math.floor(Math.random() * game.decoys.length)];
      bot.watchId = d?.id;
    }
    const w = game.decoys.find(d => d.id === bot.watchId);
    if (w) steerToward(bot, w.x + 90, w.y + 60);
  } else if (game.ledges) {
    // the mountains: ledge -> vine -> up
    const climbing = game.onClimb(bot);
    if (climbing) {
      // push straight up the vine, stay centered
      let vine = null;
      for (const c of game.climbs) {
        if (Math.abs(bot.x - c.x) < c.w / 2 + 20 && bot.y > c.yTop - 14 && bot.y < c.yBot + 14) { vine = c; break; }
      }
      bot.input.my = -1;
      bot.input.mx = vine ? Math.max(-0.4, Math.min(0.4, (vine.x - bot.x) / 40)) : 0;
      return;
    }
    // find a vine that starts at (or below) our footing and leads up
    const reachable = game.climbs.filter(c => c.yTop < bot.y - 20 && c.yBot >= bot.y - 60);
    let best = null, bd = Infinity;
    for (const c of reachable) {
      let d = Math.abs(c.x - bot.x) + Math.max(0, bot.y - c.yBot) * 2;
      if (game.constructor.chained) {
        // chained: single file — favor the route under the highest climber
        let leader = null;
        for (const q of players) if (q.alive && (!leader || q.y < leader.y)) leader = q;
        if (leader && leader.id !== bot.id) d += Math.abs(c.x - leader.x) * 1.5;
      }
      if (d < bd) { bd = d; best = c; }
    }
    if (best) {
      steerToward(bot, best.x, Math.min(bot.y, best.yBot - 4));
    } else {
      // walk toward the middle of our ledge to find a better spot
      steerToward(bot, C.ARENA_W / 2 + Math.sin(bot.id * 3.7) * 300, bot.y);
    }
  }
}

// Blackjack instincts. Mostly sensible, occasionally degenerate — like the boys.
export function botVote(squadTotal) {
  if (Math.random() < 0.12) return Math.random() < 0.5 ? 'hit' : 'stand'; // chaos agent
  return squadTotal <= 15 ? 'hit' : 'stand';
}

// Hub life: mill around, then walk where the squad needs to be.
export function driveHubBot(bot, room, dt) {
  bot.aiT = (bot.aiT || 0) - dt;
  if (bot.aiT > 0) return;
  bot.aiT = 0.15 + Math.random() * 0.1;
  bot.input.dash = false;

  const mode = room.hubMode;
  if (mode === 'lobby' || mode === 'gate') {
    bot.hubDelay ??= 1.5 + Math.random() * 3.5;
    bot.hubDelay -= 0.2;
    if (bot.hubDelay > 0) {
      wander(bot);
      return;
    }
    steerToward(bot, C.HUB.GATE.x + (Math.random() - 0.5) * (C.HUB.GATE.w - 120),
      C.HUB.GATE.y + (Math.random() - 0.5) * (C.HUB.GATE.h - 100));
  } else {
    wander(bot);
    if (Math.random() < 0.05) bot.input.dash = true; // celebration zoomies
  }
}

function wander(bot) {
  if (!bot.wanderTo || Math.hypot(bot.wanderTo.x - bot.x, bot.wanderTo.y - bot.y) < 60 || Math.random() < 0.02) {
    bot.wanderTo = { x: 300 + Math.random() * 1000, y: 300 + Math.random() * 350 };
  }
  steerToward(bot, bot.wanderTo.x, bot.wanderTo.y);
}
