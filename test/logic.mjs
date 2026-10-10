// Integration test: the whole run over real WebSockets with two fake players.
// Physics is real (Rapier on the server); the clock runs fast (FRIENDSLOP_FAST).
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { generateLeg } from '../shared/world.js';
import { QUOTAS, medBill } from '../shared/constants.js';
import { Blackjack, handTotal } from '../server/blackjack.js';

const PORT = 4100 + Math.floor(Math.random() * 500);
const SEED = 4242;
let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- blackjack engine sanity (pure logic) ---
{
  let bad = 0;
  const tally = { win: 0, lose: 0, push: 0, natural: 0 };
  for (let i = 0; i < 3000; i++) {
    const h = new Blackjack();
    while (h.state === 'voting') h.act(h.squadTotal() < 17 ? 'hit' : 'stand');
    tally[h.outcome]++;
    if (h.outcome === 'win' && handTotal(h.dealer) <= 21 && handTotal(h.squad) <= handTotal(h.dealer)) bad++;
  }
  check(bad === 0 && tally.lose > tally.win, `blackjack engine: 3000 hands consistent ${JSON.stringify(tally)}`);
}

// --- painted textures: dependency tracking, adopted pictures, cache keys (pure logic) ---
// client/js/paint/core.js and client/js/texcache.js, with a stand-in canvas (node has none)
{
  const ctx2d = cv => ({ canvas: cv, fillStyle: '', globalCompositeOperation: 'source-over', fillRect() {}, drawImage() {} });
  const hadOC = 'OffscreenCanvas' in globalThis;
  if (!hadOC) globalThis.OffscreenCanvas = class { constructor(w, h) { this.width = w; this.height = h; this.g = ctx2d(this); } getContext() { return this.g; } };
  const P = await import('../client/js/paint/core.js');
  const TC = await import('../client/js/texcache.js');
  let xPaints = 0;
  P.register('lt_a', { family: 'terrain', size: 8, paint() {} });
  P.register('lt_b', { family: 'nature', size: 8, paint() { P.canvasFor('lt_a'); P.has('lt_missing'); } });
  P.register('lt_c', { family: 'props', size: 8, paint() { P.canvasFor('lt_b'); } });
  P.register('lt_x', { family: 'terrain', size: 8, paint() { xPaints++; } });
  P.register('lt_y', { family: 'terrain', size: 8, paint() { P.canvasFor('lt_x'); } });
  P.canvasFor('lt_c');
  const deps = P.depsOf('lt_c');
  check(JSON.stringify(deps) === JSON.stringify(['lt_a', 'lt_b', 'lt_missing']), `textures: a paint's dependencies are recorded transitively, absent ones too (${deps})`);
  const H = { env: 'e', core: 'c', fam: { terrain: '1', nature: '2', props: '3' } };
  const k0 = TC.keyOf('lt_c', deps, H, P.meta);
  const differs = (h, why) => check(TC.keyOf('lt_c', deps, h, P.meta) !== k0, `textures: the cache key changes with ${why}`);
  check(TC.keyOf('lt_c', deps, { ...H, fam: { ...H.fam } }, P.meta) === k0, 'textures: the cache key is stable for the same sources');
  differs({ ...H, core: 'c2' }, 'core.js');
  differs({ ...H, fam: { ...H.fam, props: '3b' } }, "the texture's own family");
  differs({ ...H, fam: { ...H.fam, terrain: '1b' } }, "a dependency's family (two levels down)");
  differs({ ...H, env: 'e2' }, 'the cache version or the browser');
  P.register('lt_missing', { family: 'ui', size: 8, paint() {} });
  check(TC.keyOf('lt_c', deps, { ...H, fam: { ...H.fam, ui: '4' } }, P.meta) !== k0, 'textures: the cache key changes when a texture the paint looked for appears');
  check(TC.keyOf('lt_c', deps, H, P.meta) === null, 'textures: no key (never cached) when a dependency\'s family is not hashed');
  check(TC.keyOf('lt_q', [], H, n => (n === 'lt_q' ? { family: 'characters-live', w: 8, h: 8 } : null)) === null, 'textures: no key for a texture registered at run time');
  let closed = 0;
  const bmp = (w, h) => ({ width: w, height: h, close() { closed++; } });
  check(!P.adopt('lt_x', bmp(4, 4)) && closed === 1, 'textures: a picture of the wrong size is refused');
  check(P.adopt('lt_x', bmp(8, 8)) && P.ready('lt_x') && !P.painted('lt_x'), 'textures: an adopted picture waits for canvasFor');
  P.canvasFor('lt_x');
  check(xPaints === 0 && closed === 2 && !P.painted('lt_x'), 'textures: canvasFor copies an adopted picture instead of painting');
  P.canvasFor('lt_y');
  check(xPaints === 1, "textures: a paint that reads an adopted texture gets it painted (whatever painting it leaves behind)");
  check(!P.adopt('lt_y', bmp(8, 8)) && closed === 3, 'textures: a picture for an already painted texture is refused');
  check(TC.hash53('core.js v1') !== TC.hash53('core.js v2') && TC.hash53('x') === TC.hash53('x'), 'textures: source hash');
  check(TC.hash53(new TextEncoder().encode('font bytes')) === TC.hash53('font bytes'), 'textures: byte arrays hash like their text');
  if (!hadOC) delete globalThis.OffscreenCanvas;
  // The key covers a family's own source and core.js only: a helper module a family imported would be
  // edited without the key noticing, and cached textures would come back stale. So each family module
  // imports ./core.js and nothing else, and core.js imports nothing.
  const fs = await import('node:fs');
  const fams = fs.readFileSync(new URL('../client/js/paint/index.js', import.meta.url), 'utf8').match(/FAMILIES = \[([^\]]*)\]/)[1].match(/'([^']+)'/g).map(s => s.slice(1, -1));
  const importsOf = src => [...src.matchAll(/\bimport\s*(?:[\w*{}\s,$]*?\bfrom\s*)?['"]([^'"]+)['"]|\bimport\s*\(\s*([^)]*)\)|\bexport\s+[*{][^;]*?\bfrom\s*['"]([^'"]+)['"]/g)].map(m => m[1] || m[2] || m[3]);
  const bad = fams.map(f => [f, importsOf(fs.readFileSync(new URL(`../client/js/paint/${f}.js`, import.meta.url), 'utf8'))]).filter(([, im]) => im.length !== 1 || im[0] !== './core.js');
  const coreIm = importsOf(fs.readFileSync(new URL('../client/js/paint/core.js', import.meta.url), 'utf8'));
  check(fams.length >= 8 && !bad.length && !coreIm.length, `textures: each of the ${fams.length} family modules imports only ./core.js, and core.js nothing (the cache key covers no other module)${bad.length ? `; ${bad.map(([f, im]) => `${f}: ${im.join(', ')}`).join('; ')}` : ''}${coreIm.length ? `; core.js: ${coreIm.join(', ')}` : ''}`);
  const faces = TC.systemFaces(fams.map(f => fs.readFileSync(new URL(`../client/js/paint/${f}.js`, import.meta.url), 'utf8')).join('\n'));
  check(['Georgia', 'Liberation Serif', 'DejaVu Sans', 'Arial Black', 'serif', 'sans-serif'].every(n => faces.includes(n)) && !faces.some(n => /px|\$|\{/.test(n)), `textures: the system font faces the families name are found for the cache key (${faces.length}: ${faces.join(', ')})`);
}

const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1', FRIENDSLOP_FAST: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('server did not start')), 8000); });

class Player {
  constructor(name) { this.name = name; this.q = []; this.waiters = []; this.snap = null; this.events = []; this.meta = null; this.pos = { x: 0, y: 0, z: 0 }; this.yaw = 0; this.pitch = 0; this.par = 0; }
  connect() {
    return new Promise(res => {
      this.ws = new WebSocket(`ws://localhost:${PORT}`);
      this.ws.on('open', res);
      this.ws.on('message', d => {
        const m = JSON.parse(d);
        if (m.t === 's') this.snap = m;
        if (m.t === 'meta') this.meta = m;
        if (m.t === 'ev') this.events.push(...m.list);
        if (m.t === 'welcome') this.id = m.id;
        if (m.t === 'tp') { this.pos = { x: m.x, y: m.y, z: m.z }; this.par = 0; }
        let consumed = false;
        for (const w of [...this.waiters]) if (!consumed && w.pred(m)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.res(m); consumed = true; }
        if (!consumed) this.q.push(m);
        if (this.q.length > 400) this.q.shift();
      });
    });
  }
  send(m) { this.ws.send(JSON.stringify(m)); }
  wait(pred, ms = 8000, label = '') {
    const hit = this.q.find(pred);
    if (hit) { this.q.splice(this.q.indexOf(hit), 1); return Promise.resolve(hit); }
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => { const i = this.waiters.indexOf(w); if (i >= 0) { this.waiters.splice(i, 1); rej(new Error(`${this.name} timed out waiting for ${label}`)); } }, ms);
    });
  }
  drain() { this.q.length = 0; this.events.length = 0; }
  pose(extra = {}) {
    Object.assign(this, extra);
    this.send({ t: 'p', par: this.par, x: this.pos.x, y: this.pos.y, z: this.pos.z, yaw: this.yaw, pitch: this.pitch, m: 0, f: 0, v: [0, 0, 0] });
  }
  at(x, y, z, yaw = this.yaw, pitch = 0, par = 0) { this.pos = { x, y, z }; this.yaw = yaw; this.pitch = pitch; this.par = par; this.pose(); }
  g() { return this.snap?.g; }
  rv() { const r = this.snap.rv; return { x: r[0], y: r[1], z: r[2] }; }
  prop(id) { const a = this.snap?.pr.find(p => p[0] === id); return a ? { x: a[1], y: a[2], z: a[3] } : null; }
  async until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (this.snap && fn(this.snap.g, this.snap)) return true; await sleep(40); } throw new Error(`${this.name}: timed out: ${label} — g=${JSON.stringify({ ...this.snap?.g, bj: undefined, flip: undefined })} rv=${JSON.stringify(this.snap?.rv.slice(0, 3))}`); }
  async hold(ms, fn) { const t0 = Date.now(); while (Date.now() - t0 < ms) { fn?.(); this.pose(); await sleep(33); } }
}

try {
  const A = new Player('Hosty'), B = new Player('Beans');
  await A.connect();
  A.send({ t: 'create', name: A.name, seed: SEED });
  const wA = await A.wait(m => m.t === 'welcome', 8000, 'welcome');
  const world = await A.wait(m => m.t === 'world', 8000, 'world');
  const props = await A.wait(m => m.t === 'props', 8000, 'props');
  check(world.seed === SEED && world.day === 1 && props.list.length > 10, `host got world (seed ${world.seed}, day 1) and ${props.list.length} props`);
  await B.connect();
  B.send({ t: 'join', name: B.name, room: wA.code });
  await B.wait(m => m.t === 'welcome', 8000, 'B welcome');
  await B.wait(m => m.t === 'tp', 8000, 'B tp');
  B.send({ t: 'join', name: 'x', room: 'ZZZZ' });   // already joined: ignored
  const bad = new Player('Nobody'); await bad.connect(); bad.send({ t: 'join', name: 'n', room: 'QQQQ' });
  const err = await bad.wait(m => m.t === 'error', 4000, 'error');
  check(/No RV/.test(err.msg), 'bad room code rejected');
  bad.ws.close();
  A.pose(); B.pose();
  await A.until((g, s) => s.pl.length === 2, 4000, 'two players in snapshot');
  ok('two players in the room, poses flowing');

  let W = generateLeg(SEED, 1);
  // ---- drive ----------------------------------------------------------------------------
  A.at(0.2, 0.05, 1.6, 0, 0.3, 1);
  A.send({ t: 'use', kind: 'seat0' });
  await A.wait(m => m.t === 'seat' && m.seat === 0, 4000, 'seat');
  const z0 = A.rv().z;
  await A.hold(3000, () => A.send({ t: 'drv', th: 1, st: 0, hb: 0 }));
  const z1 = A.rv().z;
  check(z1 - z0 > 6, `driver: RV drove ${(z1 - z0).toFixed(1)} m in 3 s`);
  A.send({ t: 'drv', th: 0, st: 0, hb: 1 });
  A.send({ t: 'use', kind: 'unseat' });
  await A.wait(m => m.t === 'seat' && m.seat === null, 4000, 'unseat');
  ok('got out of the driver seat');
  A.send({ t: 'dbg', op: 'tpRV', x: W.roadX(3), z: 3, yaw: 0 });
  await A.until(g => g.ph === 'road', 6000, 'phase road (rolled out of camp)');
  ok(`left camp — the clock is running (${A.g().clk.toFixed(2)})`);

  // ---- grab, carry, throw ------------------------------------------------------------------
  const gz = 60, gx = W.roadX(gz), gy = W.heightAt(gx, gz);
  A.at(gx, gy + 0.05, gz - 1.6, 0, 0.35, 0);
  A.send({ t: 'dbg', op: 'spawn', type: 'vase', x: gx, y: gy + 1.0, z: gz, value: 500 });
  const sp = await A.wait(m => m.t === 'dbg' && m.op === 'spawned', 4000, 'spawn');
  await sleep(800);
  const vp = A.prop(sp.id) || { x: gx, y: gy + 0.4, z: gz };
  A.send({ t: 'grab', kind: 'prop', id: sp.id, pt: [vp.x, vp.y, vp.z], d: 1.4 });
  const gr = await A.wait(m => m.t === 'grabbed', 4000, 'grabbed');
  check(gr.ok, 'grabbed the vase');
  await A.hold(1500, () => { A.pos.z += 0.08; });
  const held = A.prop(sp.id);
  check(held && held.z > gz + 1.5, `carried it (vase z ${held?.z.toFixed(2)}, player z ${A.pos.z.toFixed(2)})`);
  A.send({ t: 'rel', thr: 1, dir: [0, 0.3, 1] });
  await sleep(600);
  const thrown = A.prop(sp.id);
  const broke = A.events.find(e => (e.k === 'break' || e.k === 'dmg') && e.id === sp.id);
  check((thrown && thrown.z > held.z + 1.5) || broke, `threw it (${thrown ? `z ${thrown.z.toFixed(2)}` : 'gone'}${broke ? `, ${broke.k} -$${broke.lost}` : ''})`);

  // ---- gate keypad -------------------------------------------------------------------------
  const gate = W.obstacles.find(o => o.type === 'gate');
  const kp = W.uses.find(u => u.kind === 'keypad');
  A.at(kp.x, kp.y - 1.5, kp.z - 1.2, 0, 0, 0);
  await sleep(150);
  A.events.length = 0;
  A.send({ t: 'use', id: kp.id, code: gate.code === '1111' ? '2222' : '1111' });
  await A.until(() => A.events.some(e => e.k === 'buzz'), 3000, 'buzz');
  ok('wrong gate code buzzes');
  A.send({ t: 'use', id: kp.id, code: gate.code });
  await A.until(g => g.gates.includes(gate.gate), 3000, 'gate open');
  ok(`right code (${gate.code}) opens the ranger gate`);

  // ---- the winch up the grade --------------------------------------------------------------
  A.send({ t: 'dbg', op: 'clock', h: 8 });   // the test clock runs 30x fast; keep it daytime
  const grade = W.obstacles.find(o => o.type === 'grade');
  const rz = grade.z0 - 7, rx = W.roadX(rz);
  A.send({ t: 'dbg', op: 'tpRV', x: rx, z: rz, yaw: 0 });
  await sleep(1200);
  const rvp = A.rv();
  A.at(rvp.x, W.heightAt(rvp.x, rvp.z + 5.4) + 0.05, rvp.z + 5.4, Math.PI, 0.5, 0);
  await sleep(200);
  A.send({ t: 'use', kind: 'winch' });
  await A.wait(m => m.t === 'hooked' && m.on, 4000, 'hook taken');
  ok('took the winch hook off the bumper');
  const anc = W.anchors[0];
  const from = { ...A.pos };
  for (let i = 0; i <= 60; i++) {
    const f = i / 60;
    const x = from.x + (anc.x - 0.8 - from.x) * f, z = from.z + (anc.z - 0.8 - from.z) * f;
    A.at(x, W.heightAt(x, z) + 0.05, z, 0, 0, 0);
    await sleep(50);
  }
  await sleep(400);
  A.send({ t: 'use', kind: 'hook' });
  await A.wait(m => m.t === 'hooked' && !m.on, 4000, 'anchored');
  await A.until((g, s) => s.hk[0] === 2, 3000, 'hook anchored in snapshot');
  ok(`hooked the anchor post at the top of the grade (cable ${A.snap.hk[4].toFixed(1)} m)`);
  B.at(0.6, 0.05, 2.85, 0, 0, 1);
  B.send({ t: 'use', kind: 'seat0' });
  await B.wait(m => m.t === 'seat' && m.seat === 0, 4000, 'B seat');
  B.send({ t: 'use', kind: 'reel' });
  await A.until((g, s) => s.hk[5] === 1, 3000, 'reeling');
  // the driver feathers the throttle while the winch does the work
  const tGrade = Date.now();
  while (!(A.snap.rv[2] > grade.z1 + 1.5) && Date.now() - tGrade < 30000) { B.send({ t: 'drv', th: 0.5, st: 0, hb: 0 }); B.pose(); A.pose(); await sleep(50); }
  B.send({ t: 'drv', th: 0, st: 0, hb: 1 });
  if (!(A.snap.rv[2] > grade.z1 + 1.5)) throw new Error(`winch stalled at rv=${JSON.stringify(A.snap.rv.slice(0, 3))}`);
  ok(`winched the RV up the ${grade.h.toFixed(1)} m grade`);
  B.send({ t: 'use', kind: 'reel' });
  A.send({ t: 'use', kind: 'hook' });   // unhook
  B.send({ t: 'use', kind: 'unseat' });
  await B.wait(m => m.t === 'seat' && m.seat === null, 4000, 'B unseat');

  // ---- town: pawn shop -----------------------------------------------------------------------
  A.send({ t: 'dbg', op: 'clock', h: 8 });
  A.send({ t: 'dbg', op: 'tpRV', x: 0, z: W.LEN + 4, yaw: 0 });
  await A.until(g => g.town === 1, 4000, 'in town');
  ok('rolled into town');
  const T = W.town;
  A.send({ t: 'dbg', op: 'spawn', type: 'tv', x: T.pawn.x, y: T.pawn.y + 0.5, z: T.pawn.z, value: 300 });
  await A.wait(m => m.t === 'dbg' && m.op === 'spawned', 4000, 'tv');
  await A.until(g => g.pawn > 0, 4000, 'appraisal');
  const bell = W.uses.find(u => u.kind === 'pawnBell');
  A.at(bell.x - 1.6, T.y + 0.05, bell.z, Math.PI / 2, 0, 0);
  await sleep(100);
  const bank0 = A.g().bank, offer = A.g().pawn;
  A.send({ t: 'use', id: bell.id });
  await A.until(() => A.events.some(e => e.k === 'sold'), 3000, 'sold');
  await A.until(g => g.bank === bank0 + offer, 3000, 'bank up');
  ok(`pawned the TV: +$${offer} (bank $${A.g().bank})`);

  // ---- casino: blackjack ------------------------------------------------------------------------
  A.send({ t: 'dbg', op: 'clock', h: 9 });
  const bjU = arg => W.uses.find(u => u.kind === 'bj' && u.arg === arg);
  A.send({ t: 'dbg', op: 'bank', v: 1000 });
  const b500 = bjU('+500');
  A.at(b500.x - 1.2, T.y + 0.05, b500.z, Math.PI / 2, 0, 0);
  await sleep(100);
  A.send({ t: 'use', id: b500.id });
  await A.until(g => g.bj.bet === 500, 3000, 'bet 500');
  A.send({ t: 'use', id: bjU('deal').id });
  await A.until(g => g.bj.st !== 'bet', 3000, 'dealt');
  const st = T.bj.stand;
  A.at(st.x, T.y + 0.05, st.z, 0, 0, 0);
  B.at(st.x + 0.3, T.y + 0.05, st.z, 0, 0, 0);
  await A.until(g => g.bj.st === 'result', 12000, 'hand resolved');
  const out = A.g().bj.out, bankAfter = A.g().bank;
  const expect = { win: 1500, natural: 1750, push: 1000, lose: 500 }[out];
  check(bankAfter === expect, `blackjack by body-vote: ${out} — bank $1000 → $${bankAfter}`);

  // ---- casino: double or nothing ---------------------------------------------------------------
  A.send({ t: 'dbg', op: 'bank', v: 1000 });
  const fU = arg => W.uses.find(u => u.kind === 'flip' && u.arg === arg);
  A.at(fU('+100').x - 1.2, T.y + 0.05, fU('+100').z, Math.PI / 2, 0, 0);
  await sleep(100);
  A.send({ t: 'use', id: fU('+100').id });
  await A.until(g => g.flip.stake === 100, 3000, 'stake');
  A.events.length = 0;
  A.send({ t: 'use', id: fU('pull').id });
  await A.until(() => A.events.some(e => e.k === 'bet'), 6000, 'flip result');
  await sleep(100);
  check([900, 1100].includes(A.g().bank), `double or nothing: bank $1000 → $${A.g().bank}`);

  // ---- store -------------------------------------------------------------------------------------
  A.send({ t: 'dbg', op: 'bank', v: 1000 });
  const wk = W.uses.find(u => u.kind === 'buy' && u.arg === 'walkie');
  A.at(wk.x + 1.2, T.y + 0.05, wk.z, -Math.PI / 2, 0, 0);
  await sleep(100);
  A.send({ t: 'use', id: wk.id });
  await A.until(g => g.bank === 850, 3000, 'bought walkie');
  await sleep(150);
  check(A.meta.players.find(p => p.id === A.id)?.walkie === true, 'bought a walkie-talkie ($150)');

  // ---- pay the Repo Man, night, sleep → day 2 ---------------------------------------------------------
  A.send({ t: 'dbg', op: 'bank', v: QUOTAS[0] + 250 });
  const pay = W.uses.find(u => u.kind === 'pay');
  A.at(pay.x + 1, T.y + 0.05, pay.z, 0, 0, 0);
  await sleep(100);
  A.send({ t: 'use', id: pay.id });
  const rc = await A.wait(m => m.t === 'receipt', 4000, 'receipt');
  await A.until(g => g.ph === 'night' && g.bank === 250 && g.paid === 1, 3000, 'paid → night');
  check(rc.paid, `paid the Repo Man $${QUOTAS[0]} → night (bank $${A.g().bank}, receipt: sold $${rc.sold}, bills $${rc.bills})`);
  A.at(0, 0.62, -3.3, 0, 0, 1); B.at(0.4, 0.62, -3.4, 0, 0, 1);
  await sleep(200);
  A.send({ t: 'use', kind: 'bunk' }); B.send({ t: 'use', kind: 'bunk' });
  const w2 = await A.wait(m => m.t === 'world' && m.day === 2, 8000, 'day 2');
  check(w2.day === 2, 'everyone in a bunk → DAY 2');
  await A.until(g => g.day === 2 && g.ph === 'camp', 4000, 'day 2 camp');
  W = generateLeg(SEED, 2);

  // ---- KO bill ------------------------------------------------------------------------------------
  A.send({ t: 'dbg', op: 'clock', h: 8 });
  A.send({ t: 'dbg', op: 'bank', v: 1000 });
  await sleep(150);
  A.send({ t: 'ko', why: 'fall' });
  await sleep(150);
  A.send({ t: 'wake' });
  await A.until(g => g.bank === 1000 - medBill(2), 3000, 'billed');
  ok(`woke up alone after a KO: ambulance -$${medBill(2)}`);
  // revive path: B picks A up — no bill
  A.send({ t: 'ko', why: 'fall' });
  B.at(A.pos.x + 1, A.pos.y, A.pos.z, 0, 0, A.par);
  await sleep(150);
  B.send({ t: 'use', kind: 'revive', id: A.id });
  await A.wait(m => m.t === 'revived', 3000, 'revived');
  check(A.g().bank === 1000 - medBill(2), 'friend picked them up: no bill');

  // ---- getting run over ------------------------------------------------------------------------------
  A.send({ t: 'dbg', op: 'clock', h: 8 });
  let sz = 120;
  for (let z = 100; z < 400; z += 5) if (Math.abs(W.roadX(z + 30) - W.roadX(z)) < 1.5 && !W.obstacles.some(o => Math.abs(o.z - z) < 60)) { sz = z; break; }
  A.send({ t: 'dbg', op: 'tpRV', x: W.roadX(sz), z: sz, yaw: Math.atan2(W.roadX(sz + 20) - W.roadX(sz), 20) });
  await sleep(1200);
  A.at(0.6, 0.05, 2.85, 0, 0, 1);
  A.send({ t: 'use', kind: 'seat0' });
  await A.wait(m => m.t === 'seat' && m.seat === 0, 4000, 'seat for knock');
  const bz = sz + 22, bx = W.roadX(bz);
  B.at(bx, W.heightAt(bx, bz) + 0.05, bz, Math.PI, 0, 0);
  B.drain();
  let knocked = null;
  B.wait(m => m.t === 'knock', 12000, 'knock').then(m => { knocked = m; }).catch(() => {});
  await A.hold(9000, () => { if (!knocked) { A.send({ t: 'drv', th: 1, st: 0, hb: 0 }); B.pose(); } });
  check(!!knocked, `ran over Beans at speed (knock v=[${knocked?.v.map(n => n.toFixed(1))}], KO=${knocked?.ko})`);
  A.send({ t: 'drv', th: 0, st: 0, hb: 1 });
  A.send({ t: 'use', kind: 'unseat' });
  await sleep(300);

  // ---- missed payment → the Repo Man takes the doors -------------------------------------------------------
  await A.until(g => g.ph === 'road', 4000, 'road (day 2: the knock test rolled us out of camp)');
  A.send({ t: 'dbg', op: 'bank', v: 100 });
  A.send({ t: 'dbg', op: 'clock', h: 23.95 });
  const parts = await A.wait(m => m.t === 'parts', 6000, 'parts');
  await A.until(g => g.str === 1 && g.ph === 'night', 3000, 'strike 1');
  check(parts.parts.doors === false, 'missed midnight → strike 1, the Repo Man took the DOORS');

  // ---- strike 3 = repo'd → over → fresh run -----------------------------------------------------------------
  A.send({ t: 'dbg', op: 'day', d: 3 });
  await A.wait(m => m.t === 'world' && m.day === 3, 6000, 'day 3');
  await A.until(g => g.day === 3, 3000, 'day 3 state');
  A.send({ t: 'dbg', op: 'phase', ph: 'road' });
  A.send({ t: 'dbg', op: 'bank', v: 0 });
  A.send({ t: 'dbg', op: 'clock', h: 23.95 });
  const p2 = await A.wait(m => m.t === 'parts' && m.parts.roof === false, 6000, 'parts 2');
  await A.until(g => g.str === 2, 3000, 'strike 2');
  check(p2.parts.roof === false && p2.parts.doors === false, 'missed again → strike 2, the ROOF is gone (doors still gone)');
  A.send({ t: 'dbg', op: 'day', d: 4 });
  await A.wait(m => m.t === 'world' && m.day === 4, 6000, 'day 4');
  await A.until(g => g.day === 4, 3000, 'day 4 state');
  A.send({ t: 'dbg', op: 'phase', ph: 'road' });
  A.send({ t: 'dbg', op: 'bank', v: 0 });
  A.send({ t: 'dbg', op: 'clock', h: 23.95 });
  const over = await A.wait(m => m.t === 'over', 6000, 'over');
  check(over.won === false, "third strike → REPO'D (game over)");
  const fresh = await A.wait(m => m.t === 'world' && m.day === 1, 10000, 'new run');
  check(fresh.day === 1 && fresh.parts.doors && fresh.parts.roof, 'a fresh run starts: new RV, doors and roof back');

  // ---- win: pay the balloon on day 5 -------------------------------------------------------------------------
  A.send({ t: 'dbg', op: 'day', d: 5 });
  await A.wait(m => m.t === 'world' && m.day === 5, 6000, 'day 5');
  W = generateLeg(fresh.seed, 5);
  A.send({ t: 'dbg', op: 'tpRV', x: 0, z: W.LEN + 4, yaw: 0 });
  A.send({ t: 'dbg', op: 'bank', v: QUOTAS[4] + 1 });
  const pay5 = W.uses.find(u => u.kind === 'pay');
  A.at(pay5.x + 1, W.townY + 0.05, pay5.z, 0, 0, 0);
  await sleep(300);
  A.send({ t: 'use', id: pay5.id });
  const win = await A.wait(m => m.t === 'over', 6000, 'win');
  check(win.won === true, `paid the $${QUOTAS[4]} balloon on day 5 → YOU OWN THE RV`);

  // ---- disconnect -----------------------------------------------------------------------------------------------
  B.ws.close();
  await A.wait(m => m.t === 'meta' && m.players.length === 1, 4000, 'B left');
  ok('disconnect handled');
  A.ws.close();
} catch (e) {
  fail(e.message);
}
console.log(failed ? '\n💥 LOGIC TESTS FAILED' : '\n🎉 ALL LOGIC TESTS PASSED');
process.exit(failed ? 1 : 0);
