// End-to-end game logic test: 3 ws clients + 1 bot play a full match
// against a real server running in fast mode. No browser required.
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PORT = 3199;
const url = `ws://localhost:${PORT}`;

function fail(msg) {
  console.error('❌ FAIL:', msg);
  process.exit(1);
}

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
    this.states = 0;
    this.podium = null;
    this.errors = [];
    this.phasesSeen = new Set();
  }
  connect() {
    return new Promise((res, rej) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', res);
      this.ws.on('error', rej);
      this.ws.on('message', raw => {
        const m = JSON.parse(raw);
        if (m.t === 'welcome') this.welcome = m;
        else if (m.t === 'meta') { this.meta = m; this.phasesSeen.add(m.phase); }
        else if (m.t === 'state') this.states++;
        else if (m.t === 'podium') this.podium = m.standings;
        else if (m.t === 'error') this.errors.push(m.msg);
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  async until(pred, what, ms = 30000) {
    const t0 = Date.now();
    while (!pred(this)) {
      if (Date.now() - t0 > ms) fail(`timeout waiting for: ${what} (phase=${this.meta?.phase}, round=${this.meta?.round})`);
      await new Promise(r => setTimeout(r, 40));
    }
  }
}

const host = new Client('Hosty');
const p2 = new Client('SloppyJoe');
const p3 = new Client('Beans');
await Promise.all([host.connect(), p2.connect(), p3.connect()]);

// -- lobby ---------------------------------------------------------------
host.send({ t: 'create', name: host.name });
await host.until(c => c.welcome, 'welcome');
const code = host.welcome.code;
if (!/^[A-Z2-9]{4}$/.test(code)) fail(`bad room code: ${code}`);

// Joining a garbage room must fail politely.
p3.send({ t: 'join', name: 'x', room: 'ZZZZ' });
await p3.until(c => c.errors.length > 0, 'join error for bad code');
console.log('✅ bad room code rejected:', p3.errors[0]);
p3.errors = [];
// (p3 got no welcome, can join for real now)
p3.welcome = null;

p2.send({ t: 'join', name: p2.name, room: code });
p3.send({ t: 'join', name: p3.name, room: code });
await p2.until(c => c.welcome, 'p2 welcome');
await p3.until(c => c.welcome, 'p3 welcome');

host.send({ t: 'addbot' });
await host.until(c => c.meta?.players.length === 4, '4 players in lobby');
console.log('✅ lobby: 3 humans + 1 bot:', host.meta.players.map(p => p.name).join(', '));

// Non-host can't start.
p2.send({ t: 'start' });
await new Promise(r => setTimeout(r, 300));
if (host.meta.phase !== 'lobby') fail('non-host started the game!');
console.log('✅ non-host cannot start');

host.send({ t: 'chat', msg: 'lets gooo' });

// -- play a full match -----------------------------------------------------
host.send({ t: 'start' });
await host.until(c => c.meta?.phase === 'betting', 'betting phase');
console.log(`✅ round 1 betting, minigame=${host.meta.minigame}`);

// Everyone bets on p2. Also assert bad bets are clamped.
host.send({ t: 'bet', target: p2.welcome.id, amount: 40 });
p2.send({ t: 'bet', target: p2.welcome.id, amount: 999999 }); // clamps to coins
p3.send({ t: 'bet', target: host.welcome.id, amount: 10 });
await host.until(c => {
  const b = c.meta?.players.find(p => p.id === p2.welcome.id)?.bet;
  return b && b.amount === 100; // clamped to full stack
}, 'bet clamped to coins');
console.log('✅ bets placed and clamped, and visible to everyone');

// Drive all humans with mashy inputs the whole match so physics gets exercised.
const mash = setInterval(() => {
  for (const c of [host, p2, p3]) {
    if (c.meta?.phase !== 'play') continue;
    c.send({
      t: 'input',
      keys: {
        up: Math.random() < 0.5, down: Math.random() < 0.5,
        left: Math.random() < 0.5, right: Math.random() < 0.5,
        dash: Math.random() < 0.2,
      },
    });
  }
}, 120);

await host.until(c => c.meta?.phase === 'play', 'play phase');
await host.until(c => c.states > 5, 'state snapshots flowing');
console.log('✅ play phase, snapshots flowing');

await host.until(c => c.meta?.phase === 'results', 'round 1 results', 60000);
const r = host.meta.lastResults;
if (!r || !r.rankings.length) fail('no results/rankings');
if (!r.rankings.includes(r.winnerId)) fail('winner not in rankings');
const total = host.meta.players.reduce((s, p) => s + p.coins, 0);
console.log(`✅ round 1 results: winner=${r.winnerId}, pot=${r.pot}, potWon=${r.potWon}, jackpot=${r.jackpot}, totalCoins=${total}`);

// Everyone bet during round 1, someone must have gained/lost coins.
if (host.meta.players.every(p => p.coins === 100)) fail('economy did not move');

// Ride it out to the podium (5 rounds).
await host.until(c => c.podium, 'podium', 120000);
clearInterval(mash);
if (host.podium.length !== 4) fail(`podium has ${host.podium.length} entries`);
const sorted = [...host.podium].every((p, i, a) => i === 0 || a[i - 1].coins >= p.coins);
if (!sorted) fail('podium not sorted by coins');
console.log('✅ podium:', host.podium.map(p => `${p.name}:${p.coins}`).join(' | '));

// Everyone saw every phase.
for (const c of [host, p2, p3]) {
  for (const ph of ['betting', 'play', 'results', 'podium']) {
    if (!c.phasesSeen.has(ph)) fail(`${c.name} never saw phase ${ph}`);
  }
}

// -- back to lobby, rematch possible ----------------------------------------
await host.until(c => c.meta?.phase === 'lobby', 'back to lobby', 30000);
console.log('✅ back to lobby after podium');

// Disconnect handling: p3 leaves, host stays host, room lives.
p3.ws.close();
await host.until(c => c.meta?.players.length === 3, 'p3 removed from lobby');
console.log('✅ disconnect handled');

console.log('\n🎉 ALL LOGIC TESTS PASSED');
server.kill();
process.exit(0);
