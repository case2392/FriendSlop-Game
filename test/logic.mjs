// End-to-end expedition test with EMBODIED interactions: ws clients literally
// steer their blobs into the gate zone and blackjack vote zones.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { Blackjack, handTotal } from '../server/blackjack.js';
import * as C from '../shared/constants.js';

const PORT = 3199;
const url = `ws://localhost:${PORT}`;

function fail(msg) {
  console.error('❌ FAIL:', msg);
  process.exit(1);
}

// ---- blackjack unit checks --------------------------------------------------
{
  if (handTotal(['A♠', 'K♦']) !== 21) fail('natural should total 21');
  if (handTotal(['A♠', 'A♦', '9♥']) !== 21) fail('double ace should soft-total 21');
  if (handTotal(['A♠', 'A♦', 'A♥', 'K♣', 'Q♣']) !== 23) fail('aces should collapse to 1');

  const outcomes = { win: 0, lose: 0, push: 0, natural: 0 };
  for (let i = 0; i < 3000; i++) {
    const bj = new Blackjack();
    let guard = 0;
    while (bj.state === 'voting' && guard++ < 20) {
      bj.act(bj.squadTotal() <= 15 ? 'hit' : 'stand');
    }
    if (bj.state !== 'done' || !bj.outcome) fail('hand never resolved');
    if (bj.squadTotal() > 30) fail('impossible squad total');
    if (bj.squadTotal() <= 21 && bj.outcome !== 'natural' && bj.dealerTotal() < 17) {
      fail('dealer quit under 17');
    }
    outcomes[bj.outcome]++;
  }
  for (const k of ['win', 'lose', 'push', 'natural']) {
    if (!outcomes[k]) fail(`outcome ${k} never occurred in 3000 hands`);
  }
  const winRate = (outcomes.win + outcomes.natural) / 3000;
  if (winRate < 0.30 || winRate > 0.60) fail(`suspicious win rate ${winRate}`);
  console.log('✅ blackjack engine: 3000 hands valid,', JSON.stringify(outcomes));
}

// ---- live server ------------------------------------------------------------

process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
process.on('uncaughtException', e => { console.error('❌ FAIL:', e.message); process.exit(1); });

const server = spawn(process.execPath, ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT), FRIENDSLOP_FAST: '1' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((res, rej) => {
  server.stdout.on('data', d => { if (String(d).includes('sloppin')) res(); });
  server.on('exit', () => rej(new Error('server died')));
  setTimeout(() => rej(new Error('server never started')), 5000);
}).catch(e => fail(e.message));

class Client {
  constructor(name) {
    this.name = name;
    this.meta = null;
    this.welcome = null;
    this.snap = null;
    this.states = 0;
    this.podium = null;
    this.errors = [];
    this.modesSeen = new Set();
    this.bjOutcomes = [];
    this.maxChamber = 0;
    this.keys = {};
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.t === 'welcome') this.welcome = m;
        else if (m.t === 'meta') {
          this.meta = m;
          this.modesSeen.add(m.phase === 'play' ? 'play' : m.hubMode);
          this.maxChamber = Math.max(this.maxChamber, m.chamber ?? 0);
        } else if (m.t === 'state') {
          this.snap = m;
          this.states++;
          const o = m.extra?.bj?.outcome;
          if (o && this.bjOutcomes.at(-1) !== o) this.bjOutcomes.push(o);
        } else if (m.t === 'podium') this.podium = m;
        else if (m.t === 'error') this.errors.push(m.msg);
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  pos() {
    const me = this.snap?.players.find(p => p[0] === this.welcome?.id);
    return me ? { x: me[1], y: me[2] } : null;
  }
  steerToward(tx, ty) {
    const p = this.pos();
    if (!p) return;
    const dx = tx - p.x, dy = ty - p.y;
    const d = Math.hypot(dx, dy);
    const move = d < 20 ? { mx: 0, my: 0 } : { mx: dx / d, my: dy / d };
    const sig = JSON.stringify(move);
    if (sig !== this._lastKeys) { this._lastKeys = sig; this.send({ t: 'input', ...move }); }
  }
  async until(pred, what, ms = 60000) {
    const t0 = Date.now();
    while (!pred(this)) {
      if (Date.now() - t0 > ms) {
        fail(`timeout waiting for: ${what} (phase=${this.meta?.phase}, mode=${this.meta?.hubMode}, chamber=${this.meta?.chamber})`);
      }
      await new Promise(r => setTimeout(r, 40));
    }
  }
}

const host = new Client('Hosty');
const p2 = new Client('SloppyJoe');
const p3 = new Client('Beans');
await Promise.all([host.connect(), p2.connect(), p3.connect()]);

host.send({ t: 'create', name: host.name });
await host.until(c => c.welcome, 'welcome');
const code = host.welcome.code;
if (!/^[A-Z2-9]{4}$/.test(code)) fail(`bad room code: ${code}`);

p3.send({ t: 'join', name: 'x', room: 'ZZZZ' });
await p3.until(c => c.errors.length > 0, 'join error for bad code');
console.log('✅ bad room code rejected');
p3.errors = [];

p2.send({ t: 'join', name: p2.name, room: code });
p3.send({ t: 'join', name: p3.name, room: code });
await p2.until(c => c.welcome, 'p2 welcome');
await p3.until(c => c.welcome, 'p3 welcome');

host.send({ t: 'addbot' });
await host.until(c => c.meta?.players.length === 4, '4 blobs in the Den');
console.log('✅ the Den: 3 humans + 1 bot walking around');

await host.until(c => c.states > 5, 'hub snapshots flowing');
if (host.meta.phase !== 'hub' || host.meta.hubMode !== 'lobby') fail('should idle in hub lobby');
console.log('✅ hub snapshots flowing (the Den is live)');

// The squad drives itself for the whole expedition with body language only.
const driver = setInterval(() => {
  for (const c of [host, p2, p3]) {
    const m = c.meta;
    if (!m) continue;
    if (m.phase === 'play') {
      if (m.minigame === 'casino') {
        c.steerToward(C.HUB.STAND.x, C.HUB.STAND.y); // vote with the body
      } else if (Math.random() < 0.6) {
        const a = Math.random() * Math.PI * 2;
        c.send({ t: 'input', mx: Math.cos(a), my: Math.sin(a), dash: Math.random() < 0.2 });
        c._lastKeys = null;
      }
    } else if (m.hubMode === 'lobby' || m.hubMode === 'gate') {
      c.steerToward(C.HUB.GATE.x, C.HUB.GATE.y);
    }
  }
}, 100);

// Walking into the gate must start chamber 1.
await host.until(c => c.meta?.phase === 'play', 'gate walk-in starts chamber 1', 30000);
if (host.meta.minigame !== 'dig') fail(`expedition should start at THE DIG SITE, got ${host.meta.minigame}`);
console.log('✅ walked into the gate — chamber 1 begins (THE DIG SITE)');

await host.until(c => c.meta?.phase === 'hub' && c.meta.chamber === 1, 'clear -> straight to chamber 2', 60000);
const r1 = host.meta.lastResults;
if (!r1?.teamWin) fail('dig should be trivially clearable in FAST mode');
const mvpPay = (r1.payouts[r1.mvpId] || []).reduce((s, x) => s + x.amt, 0);
if (mvpPay < 150) fail(`mvp should earn clear pay + bonus, got ${mvpPay}`);
console.log(`✅ chamber cleared (mvp=${r1.mvpId}, +${mvpPay}) — advanced with NO toll booth`);

// Ride until the casino chamber deals cards in-world.
await host.until(c => c.meta?.phase === 'play' && c.meta.minigame === 'casino' && c.snap?.extra?.bj?.squad?.length >= 2,
  "the Boss's Casino deals", 120000);
console.log(`✅ THE BOSS'S CASINO: ${host.snap.extra.bj.squad.join(' ')} (${host.snap.extra.bj.squadTotal}) vs ${host.snap.extra.bj.dealerUp}`);

await host.until(c => c.bjOutcomes.length > 0, 'hand resolves via body votes', 40000);
console.log(`✅ hand resolved by standing in a zone: ${host.bjOutcomes[0]}`);

// Ride it out: bodies do everything until the podium.
await host.until(c => c.podium, 'podium', 240000);
clearInterval(driver);

const pod = host.podium;
console.log(`✅ podium: escaped=${pod.escaped}, cleared=${pod.cleared}/${pod.chambers}, standings=${pod.standings.map(s => `${s.name}:${s.coins}`).join(' | ')}`);
if (pod.standings.length !== 4) fail('podium missing blobs');
if (pod.standings.every(s => s.coins === 0)) fail('nobody earned anything all match');
const sorted = pod.standings.every((s, i, a) => i === 0 || a[i - 1].coins >= s.coins);
if (!sorted) fail('podium not sorted by coins');

for (const c of [host, p2, p3]) {
  for (const mode of ['lobby', 'play', 'gate', 'celebrate']) {
    if (!c.modesSeen.has(mode)) fail(`${c.name} never saw ${mode}`);
  }
}

await host.until(c => c.meta?.hubMode === 'lobby', 'back to the Den lobby', 30000);
console.log('✅ back to the Den after the expedition');

p3.ws.close();
await host.until(c => c.meta?.players.length === 3, 'p3 removed from lobby');
console.log('✅ disconnect handled');

console.log('\n🎉 ALL LOGIC TESTS PASSED');
server.kill();
process.exit(0);
