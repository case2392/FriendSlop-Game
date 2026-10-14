// Integration test: the whole run over real WebSockets with two fake players.
// Physics is real (Rapier on the server); the clock runs fast (FRIENDSLOP_FAST).
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { generateLeg, butteRadius } from '../shared/world.js';
import { QUOTAS, medBill } from '../shared/constants.js';
import { Blackjack, handTotal } from '../server/blackjack.js';
import { Casino, FLIP_ODDS, DERBY } from '../server/casino.js';
import http from 'node:http';
import { mulberry32 } from '../shared/rng.js';

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

// --- world gen: the gate code's paint is clear of the ground; every boulder has its sign (pure logic) ---
// (codes used to be brushed at a fixed spot on the rim, and 1 in 5 had a ridge of grass through the digits)
{
  let codes = 0, buried = 0, boulders = 0, signed = 0;
  for (let i = 0; i < 24; i++) {
    const seed = (Math.imul(i + 7, 2654435761) >>> 0) % 1e9;
    for (let day = 1; day <= 5; day++) {
      const W = generateLeg(seed, day);
      for (const s of W.signs.filter(s => s.flat)) {
        codes++;
        // the slab's top as world.js rimSlab and town3d.js rimCode make it (a plane fitted to the ground
        // around it, lifted clear of the bumps by up to 0.6 m, 0.24 m up), against the ground under the paint
        const yaw = Math.atan2(s.x - W.roadX(s.z), 0) + Math.PI, c = Math.cos(yaw), sn = Math.sin(yaw);
        const gy = (lx, lz) => W.heightAt(s.x + lx * c + lz * sn, s.z - lx * sn + lz * c);
        const hx = s.w / 2 + 0.5, hz = s.h / 2 + 0.45;
        let n = 0, sy = 0, sxy = 0, szy = 0, sxx = 0, szz = 0, lift = 0, poke = -1;
        for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) { const lx = (a / 4 - 0.5) * 2.2 * hx, lz = (b / 4 - 0.5) * 2.2 * hz, y = gy(lx, lz); n++; sy += y; sxy += lx * y; szy += lz * y; sxx += lx * lx; szz += lz * lz; }
        const a0 = sy / n, bx = sxy / sxx, bz = szy / szz;
        for (let a = 0; a <= 4; a++) for (let b = 0; b <= 4; b++) { const lx = (a / 4 - 0.5) * (s.w + 0.3), lz = (b / 4 - 0.5) * (s.h + 0.3); lift = Math.max(lift, gy(lx, lz) - (a0 + bx * lx + bz * lz)); }
        const top0 = a0 + Math.min(lift, 0.6) + 0.24;
        for (let a = 0; a <= 20; a++) for (let b = 0; b <= 12; b++) { const lx = (a / 20 - 0.5) * s.w, lz = (b / 12 - 0.5) * s.h; poke = Math.max(poke, gy(lx, lz) - (top0 + bx * lx + bz * lz)); }
        if (poke > 0) buried++;
      }
      for (const o of W.obstacles.filter(o => o.type === 'boulder')) {
        boulders++;
        const s = W.signs.find(s => s.lines[0] === 'ROCKFALL' && s.z < o.z && o.z - s.z < 40);
        if (s && Math.abs(W.heightAt(s.x, s.z) - W.roadY(s.z)) < 0.3) signed++;
      }
    }
  }
  check(codes > 80 && buried === 0, `world: no gate code has the ground poking through its paint (${buried} of ${codes})`);
  check(boulders > 50 && signed === boulders, `world: every boulder has a ROCKFALL sign on flat ground before it (${signed} of ${boulders})`);
}

// --- world gen: the crash buttes are angular, leaning masses with room on top and clear of the road ---
// (convex rings that hold their centre, the wreck's 5.6 m, every loot prop a metre inside the top, the
// foot at the talus line 7.6 m off the road's centre, the bench 2.5 m over the talus, the same every time)
{
  const { sdPoly, polyArea } = await import('../shared/butte.js');
  let sites = 0, bad = [];
  for (let i = 0; i < 16; i++) {
    const seed = (Math.imul(i + 3, 2246822519) >>> 0) % 1e9;
    for (let day = 1; day <= 5; day++) {
      const W = generateLeg(seed, day), W2 = generateLeg(seed, day);
      W.mesas.forEach((p, k) => {
        sites++;
        const M = p.mesa, yC = M.base + M.talus, mains = M.parts.filter(q => q.part !== 'butte_bench');
        for (const q of M.parts) {
          if (q.top.length < 5 || polyArea(q.top) <= 0) bad.push(`${seed}/${day} ${q.part}: ${q.top.length} corners, area ${polyArea(q.top).toFixed(1)}`);
        }
        // the main tier's outline is one radius per bearing (what the renderer wraps the wall round): every
        // point from the centre out to butteRadius lies in the rock
        for (let a = 0; a < 90; a++) {
          const th = a / 90 * Math.PI * 2, R = butteRadius(p, th);
          for (let t = 0.25; t < R - 0.05; t += 0.25) {
            const x = p.x + Math.cos(th) * t, z = p.z + Math.sin(th) * t;
            if (!mains.some(q => sdPoly(q.top, x, z) <= 1e-6)) { bad.push(`${seed}/${day} a gap in the top ${t.toFixed(2)} m out at bearing ${a * 4}`); a = 90; break; }
          }
        }
        const body = M.parts.find(q => q.part === 'butte');
        if (-sdPoly(body.top, p.x, p.z) < 5.55) bad.push(`${seed}/${day} the top is ${(-sdPoly(body.top, p.x, p.z)).toFixed(2)} m from the centre to its nearest face`);
        for (const pr of W.props.filter(pr => Math.hypot(pr.x - p.x, pr.z - p.z) < M.bound && pr.y > M.base + M.h - 0.5)) {
          const inside = Math.max(...mains.map(q => -sdPoly(q.top, pr.x, pr.z)));
          if (inside < 0.75) bad.push(`${seed}/${day} loot ${pr.type} ${inside.toFixed(2)} m inside the top`);
        }
        for (const q of mains) for (const v of q.polyAt(yC)) if (Math.abs(v[0] - W.roadX(v[1])) < 7.55) { bad.push(`${seed}/${day} the foot ${Math.abs(v[0] - W.roadX(v[1])).toFixed(2)} m off the road`); break; }
        if (M.bench.top < yC + 2.45) bad.push(`${seed}/${day} the bench ${(M.bench.top - yC).toFixed(2)} m over the talus`);
        const q2 = W2.mesas[k].mesa.parts;
        if (M.parts.some((q, j) => q.top.length !== q2[j].top.length || q.top.some((v, n) => v[0] !== q2[j].top[n][0] || v[1] !== q2[j].top[n][1]))) bad.push(`${seed}/${day} not the same twice`);
      });
    }
  }
  check(sites > 40 && !bad.length, `world: ${sites} crash buttes are convex leaning masses with room on top, clear of the road, the same every time${bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''}`);
}

// --- the casino: one bank, a game each (pure logic: server/casino.js) ---
{
  const W = generateLeg(4242, 1), spots = W.town.casino_stations;
  const kinds = spots.reduce((o, s) => ({ ...o, [s.kind]: (o[s.kind] || 0) + 1 }), {});
  check(kinds.bj === 3 && kinds.craps === 2 && kinds.flip === 2 && kinds.derby === 1 && W.uses.filter(u => u.kind === 'cas').length === 8,
    `casino: three blackjack seats, two craps rails, two Double or Nothing machines and the Derby, each with its button (${JSON.stringify(kinds)})`);
  const at = (p, id) => { const s = spots.find(q => q.id === id); p.pos = { x: s.x, y: 0, z: s.z }; };
  const mk = (id, name) => ({ id, name, connected: true, pos: null });
  // Ann at blackjack, Bob at craps, Cy on Double or Nothing: all at once, all out of one bank
  const cas = new Casino(spots, mulberry32(77));
  const A = mk(1, 'Ann'), B = mk(2, 'Bob'), Cy = mk(3, 'Cy'), players = new Map([[1, A], [2, B], [3, Cy]]);
  at(A, 'bj1'); at(B, 'craps1'); at(Cy, 'flip1');
  let bank = 3000, t = 0;
  const done = [];   // every settled game, as it settles
  const play = (p, id, a, n) => { const r = cas.act(p, id, a, n, t, bank); bank -= r.spend || 0; for (const x of r.results || []) { bank += x.back; done.push(x); } return r; };
  const settle = list => { for (const x of list) { bank += x.back; done.push(x); } return list; };
  check(cas.sit(A, 'bj1').ok && cas.sit(B, 'craps1').ok && cas.sit(Cy, 'flip1').ok && cas.sit(B, 'bj1').err && play(B, 'bj1', 'b100').err,
    'casino: a seat is whoever sat down first; somebody else can\'t sit there or bet on it');
  play(A, 'bj1', 'b500'); play(B, 'craps1', 'b500'); play(B, 'craps1', 'b100'); play(Cy, 'flip1', 'b100'); play(Cy, 'flip1', 'b100');
  const bets = [cas.st.get('bj1').bet, cas.st.get('craps1').bet, cas.st.get('flip1').bet];
  const r1 = play(A, 'bj1', 'go'), r2 = play(B, 'craps1', 'go'), r3 = play(Cy, 'flip1', 'go');
  const spent = (r1.spend || 0) + (r2.spend || 0) + (r3.spend || 0);
  check(bets.join() === '500,600,200' && spent === 1300 && bank === 3000 - 1300 + (r1.results?.[0]?.back || 0),
    `casino: three games at once take their own stakes from the one bank ($${bets.join(', $')}: $${spent} out, bank $${bank})`);
  // Ann plays her hand out; the dice and the coin land on their own time
  for (let i = 0; i < 12 && cas.st.get('bj1').state === 'play'; i++) play(A, 'bj1', cas.st.get('bj1').hand.squadTotal() < 15 ? 'hit' : 'stand');
  const settled = id => done.filter(x => x.id === id);
  for (t = 0; t < 400 && (!settled('craps1').length || !settled('flip1').length); t += 0.5) {
    settle(cas.tick(t));
    const c = cas.st.get('craps1');
    if (c.state === 'point' && !c.pend) play(B, 'craps1', 'go');
  }
  const one = ['bj1', 'craps1', 'flip1'].map(id => settled(id));
  const net = done.reduce((a, x) => a + x.won, 0);
  check(one.every(l => l.length === 1) && bank === 3000 + net && one[0][0].p === A && one[1][0].p === B && one[2][0].p === Cy,
    `casino: each game settles back into the bank, credited to who played it (blackjack ${one[0][0]?.won}, craps ${one[1][0]?.won}, the coin ${one[2][0]?.won}: bank $${bank} = $3,000 ${net >= 0 ? '+' : '-'} $${Math.abs(net)})`);
  // one game at a time: Bob moving over to the other rail gives up the one he had (nothing on it now)
  const moved = cas.sit(B, 'craps2', t);
  check(moved.ok && !moved.results.length && cas.st.get('craps1').owner === null && cas.st.get('craps2').owner === B.id,
    'casino: one game at a time: sitting down at another gives up the one you had');
  cas.sit(B, 'craps1', t);
  // walking off mid-hand: the house plays it out (you stand) and the seat is free again
  t += 10; settle(cas.tick(t));
  play(A, 'bj1', 'b100');
  let dealt = null;
  for (let k = 0; k < 20 && !dealt; k++) { const r = play(A, 'bj1', 'go'); if (cas.st.get('bj1').state === 'play') dealt = r; else { t += 10; settle(cas.tick(t)); } }
  const b0 = bank;
  A.pos = { x: A.pos.x + 5, y: 0, z: A.pos.z };
  const gone = settle(cas.release(players, t));
  check(dealt && gone.length === 1 && gone[0].p === A && cas.st.get('bj1').owner === null && cas.st.get('bj1').state === 'result' && bank === b0 + gone[0].back,
    `casino: walk away mid-hand and the dealer plays it out as a stand (${gone[0]?.won >= 0 ? '+' : ''}${gone[0]?.won}); the seat is free`);
  // last call: a point on the table rolls on to a decision, the Derby runs with its tickets
  const cas2 = new Casino(spots, mulberry32(5));
  const D = mk(4, 'Di'), E = mk(5, 'Ed');
  at(D, 'craps2'); at(E, 'derby');
  cas2.sit(D, 'craps2');
  let bk = 5000, pointed = false, clock = 0;
  cas2.act(D, 'craps2', 'b100', 0, clock, bk);
  for (let k = 0; k < 50 && !pointed; k++) {
    const g = cas2.act(D, 'craps2', 'go', 0, clock, bk); bk -= g.spend || 0;
    clock += 5; for (const x of cas2.tick(clock)) bk += x.back;
    pointed = cas2.st.get('craps2').state === 'point';
    if (!pointed) { clock += 10; for (const x of cas2.tick(clock)) bk += x.back; }
  }
  cas2.act(E, 'derby', 'b500', 0, clock, bk); const tk = cas2.act(E, 'derby', 'go', 3, clock, bk); bk -= tk.spend || 0;
  const inPlay = cas2.inPlay(), last = cas2.closeAll(clock + 1);
  for (const x of last) bk += x.back;
  const dv = cas2.st.get('derby');
  check(pointed && inPlay === 600 && last.length === 2 && cas2.inPlay() === 0 && dv.order && last.find(x => x.p === E).back === (dv.order[0] === 3 ? 500 * DERBY.PAYS : 0),
    `casino: last call settles a point still being rolled and runs the Derby (${inPlay} in play; ringtail ${dv.order?.[0]} won, the ticket on 3 paid $${last.find(x => x.p === E)?.back})`);
  // the house's edge, played many times: the pass line wins 244 in 495, Double or Nothing 48.5%, a Derby ticket 1 in 4 at x3.8
  const cas3 = new Casino(spots, mulberry32(9)), P = mk(9, 'Pat');
  let wins = 0, games = 0, flips = 0, fw = 0, tt = 0;
  const S = cas3.st.get('craps1'), Fm = cas3.st.get('flip2');
  // (one game at a time: the craps first, then the coin; a refused roll or pull ends the loop short)
  at(P, 'craps1'); cas3.sit(P, 'craps1'); S.bet = 100;
  for (let i = 0; games < 20000 && i < 400000; i++) {
    cas3.act(P, 'craps1', 'go', 0, tt, 1e9);
    if (!S.pend) { tt += 1; continue; }
    const r = cas3.crapsLand(S, tt);
    if (r.length) { games++; if (r[0].won > 0) wins++; S.state = 'bet'; }
  }
  at(P, 'flip2'); cas3.sit(P, 'flip2'); Fm.bet = 100;
  for (let i = 0; flips < 20000 && i < 40000; i++) { if (cas3.act(P, 'flip2', 'go', 0, tt, 1e9).err) continue; const r = cas3.flipLand(Fm, tt); flips++; if (r[0].won > 0) fw++; Fm.state = 'bet'; }
  const pr = wins / games, fr = fw / flips;
  check(games === 20000 && flips === 20000 && Math.abs(pr - 244 / 495) < 0.012 && Math.abs(fr - FLIP_ODDS) < 0.012 && DERBY.PAYS * 0.25 < 1,
    `casino: the house wins in the long run (the pass line won ${(pr * 100).toFixed(1)}% of ${games}, theory 49.3%; the coin ${(fr * 100).toFixed(1)}%; a Derby ticket returns ${(DERBY.PAYS * 25).toFixed(0)}%)`);
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

// --- the save (shared/profile.js): checked on the way in, never thrown by junk, a trip counted once, and the
// record rules (pure logic) ---
{
  const P = await import('../shared/profile.js');
  const { CARD } = await import('../shared/cards.js');
  const rnd = mulberry32(99);
  // P1: whatever a save holds (junk, wrong types, huge lists, nesting), validate() returns something in bounds
  const junk = d => {
    const r = rnd();
    if (d > 3 || r < 0.15) return [null, undefined, NaN, Infinity, -1e300, 1e300, '', 'x'.repeat(40), '0123456789abcdef', 7.5, -3, true, '<b>'][Math.floor(rnd() * 13)];
    if (r < 0.45) return Array.from({ length: Math.floor(rnd() * 60) }, () => junk(d + 1));
    const o = {};
    for (const k of ['v', 'pid', 'made', 'saved', 'rev', 'best', 'std', 'bad', 'fast', 'h', 'at', 'crew', 'splits', 'haul', 'sold', 'surplus', 'casino', 'won', 'clean', 'hp', 'crews', 'key', 'names', 'trips', 'wins', 'seeds', 'seed', 'life', 'runs', 'days', 'pawned', 'kos', 'sum', 'cards', 'seen', 'lost', 'gnome', 'gloves', '__proto__', 'constructor'])
      if (rnd() < 0.35) o[k] = junk(d + 1);
    return o;
  };
  let threw = 0, out = 0;
  const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  for (let i = 0; i < 2000; i++) {
    let p;
    try { p = P.validate(junk(0)); } catch { threw++; continue; }
    const boards = ['std', 'bad'].map(k => p.best[k]);
    const okBoard = b => b.splits.length === 5 && b.splits.every(x => x === null || inRange(x.h, 6, 24))
      && (b.fast === null || (inRange(b.fast.h, 0, 90) && b.fast.crew.length <= 6)) && (b.haul === null || inRange(b.haul.sold, 0, 1e9)) && (b.clean === null || inRange(b.clean.hp, 0, 100));
    const good = (p.pid === null || P.isPid(p.pid)) && boards.every(okBoard) && p.crews.length <= 12 && p.seeds.length <= 20 && p.runs.length <= 32
      && p.runs.every(P.isRun) && Object.values(p.life).every(v => inRange(v, 0, 1e12)) && Object.keys(p.life).length === P.LIFE.length
      && p.crews.every(c => c.names.length <= 6 && c.names.every(n => typeof n === 'string' && n.length <= 16 && !/[<>]/.test(n)))
      && Object.entries(p.cards).every(([id, n]) => CARD[id] && Number.isInteger(n) && n >= 1 && n <= 99) && p.seen.every(id => CARD[id]) && Object.entries(p.lost).every(([id, d]) => CARD[id] && !p.cards[id] && d >= 1 && d <= 5);
    if (!good) out++;
    try { P.serialize(p); } catch { threw++; }
  }
  check(!threw && !out, `save: validate() takes 2,000 junk saves without throwing, and everything it returns is in bounds (${threw} threw, ${out} out of bounds)`);
  // P2: a torn write, a newer version, nothing at all
  const pid = '0123456789abcdef', base = P.fresh(pid, 1000), text = P.serialize(base);
  const torn = text.slice(0, text.length - 9), edited = text.replace('"rev":0', '"rev":5');
  const newer = JSON.stringify({ ...JSON.parse(text), v: 2 });
  check(P.parse(text).status === 'ok' && P.parse(text).prof.pid === pid && P.parse(torn).status === 'corrupt' && P.parse(edited).status === 'corrupt'
    && P.parse(newer).status === 'newer' && P.parse('').status === 'empty' && P.parse(null).status === 'empty' && P.parse('[1,2]').status === 'corrupt',
    'save: a good save reads back; a torn write or an edit without its sum is corrupt; v 2 is newer (read-only); nothing there is empty');
  // P3, P4: the record rules
  const trip = ({ run = 'a', you = {}, ...o } = {}) => ({ run: run.padEnd(10, '0'), won: true, practice: null, tier: 'std', splits: [14, 14, 14, 14, 14], sold: 20000, surplus: 1500, casino: -200, rvEnd: 80, repairs: 245,
    crew: [{ h: '0a0b0c0d', name: 'Ann' }, { h: '01020304', name: 'Bob' }], ...o, you: { fromStart: true, atEnd: true, kos: 1, revives: 2, rvDmg: 9, ...you } });
  const p = P.fresh(pid, 0);
  const r1 = P.creditTrip(p, trip({ run: 'a1' })), snap = JSON.stringify(p), r2 = P.creditTrip(p, trip({ run: 'a1' }));
  check(r1.counted && !r2.counted && r2.dup && JSON.stringify(p) === snap && p.life.trips === 1 && p.life.wins === 1 && p.best.std.fast.h === 40 && p.best.std.haul.sold === 20000,
    `save: the same trip credited twice counts once (road time ${P.fmtRoad(p.best.std.fast.h)}, ${r1.newRecords.length} records the first time, none the second)`);
  const q = P.fresh(pid, 0);
  const test = P.creditTrip(q, trip({ run: 'b1', practice: 'test' })), testOk = P.creditTrip(P.fresh(pid, 0), trip({ run: 'b2', practice: 'test' }), { acceptTest: true });
  const seeded = P.creditTrip(q, trip({ run: 'b3', practice: 'seed', seed: 777 }));
  const late = P.creditTrip(q, trip({ run: 'b4', you: { fromStart: false } })), left = P.creditTrip(q, trip({ run: 'b5', you: { atEnd: false } }));
  check(!test.counted && testOk.counted && seeded.counted && q.seeds.length === 1 && q.seeds[0].seed === 777 && q.seeds[0].fast === 40 && q.life.trips === 2
    && late.counted && left.counted && !q.best.std.fast && !q.best.std.haul && q.crews.length === 0,
    `save: a test trip records nothing (unless the browser test asks); a typed seed's goes on its seed board only; joining late or leaving early counts the trip but sets no record (life ${q.life.trips} trips, ${q.seeds.length} seed board)`);
  const w = P.fresh(pid, 0);
  P.creditTrip(w, trip({ run: 'c1', won: false, splits: [13, 13, 13, 13, null], sold: 30000 }));
  const lostOk = !w.best.std.fast && w.best.std.haul?.sold === 30000 && w.best.std.splits[3].h === 13 && w.best.std.splits[4] === null && !w.best.std.clean;
  P.creditTrip(w, trip({ run: 'c2', won: false, splits: [12, 12, 12, null, null], sold: 90000 }));
  const short = w.best.std.haul.sold === 30000 && w.best.std.splits[0].h === 12;
  const fast2 = P.creditTrip(w, trip({ run: 'c3', splits: [15, 15, 15, 15, 15], rvEnd: 95 }));
  check(lostOk && short && fast2.newRecords.includes('fast') && fast2.newRecords.includes('clean') && !fast2.newRecords.includes('haul') && w.best.std.fast.h === 45 && w.life.wins === 1 && w.crews[0].trips === 3,
    'save: a loss sets no time record but its splits and haul count; a haul needs days 1 to 4 paid; a slower win still sets the first fastest payoff and the cleanest RV');
  // P5: every table full stays well under 16 KB
  const full = P.fresh(pid, Date.now());
  for (let i = 0; i < 40; i++) {
    const hs = Array.from({ length: 6 }, (_, k) => ((i * 7 + k) * 2654435761 >>> 0).toString(16).padStart(8, '0'));
    P.creditTrip(full, { ...trip({ run: i.toString(16).padStart(10, '0') }), crew: hs.map((h, k) => ({ h, name: 'Abcdefghijklmnop'.slice(0, 16 - k) })), tier: i % 2 ? 'bad' : 'std' }, { now: Date.now() });
    P.creditTrip(full, { ...trip({ run: (1000 + i).toString(16).padStart(10, 'f') }), practice: 'seed', seed: 4000000000 - i }, { now: Date.now() });
  }
  for (const id of Object.keys(CARD)) { full.cards[id] = 99; full.seen.push(id); }
  const bytes = P.serialize(full).length;
  check(full.crews.length === 12 && full.seeds.length === 20 && full.runs.length === 32 && bytes <= 16 * 1024, `save: with every table full (12 crews of six, 20 seeds, 32 trips, both boards, all 30 cards) it is ${(bytes / 1024).toFixed(1)} KB (at most 16)`);
}

// --- Road Cards (shared/cards.js): the catalogue, the odds, and what a trip puts in your save ---
{
  const K = await import('../shared/cards.js'), P = await import('../shared/profile.js');
  // F9: 30 cards, unique; each set 2 kit cards, 2 common, 1 uncommon, 1 rare; the kit cards are the Garage's
  // ten (its PR: shared/garage.js); on Standard terms a set's odds are kit 33%, common 50%, uncommon 17%, rare 0
  const ids = K.CARDS.map(c => c.id), sets = [1, 2, 3, 4, 5].map(n => K.CARDS.filter(c => c.set === n));
  const shape = sets.every(s => s.length === 6 && ['kit', 'kit', 'common', 'common', 'uncommon', 'rare'].every((r, i, a) => s.filter(c => c.rarity === r).length === a.filter(x => x === r).length));
  const kit = K.CARDS.filter(c => c.kind === 'kit').map(c => c.id).sort().join();
  const o = K.odds('std'), b = K.odds('bad'), pct = x => Math.round(x * 100);
  check(new Set(ids).size === 30 && shape && kit === 'bullbar,callsign,chalk,eye,gloves,horn,medic,steady,toolbox,winch'
    && pct(o.kit) === 33 && pct(o.common) === 50 && pct(o.uncommon) === 17 && !o.rare && Math.abs(b.rare - 1 / 13) < 1e-9,
    `cards: 30 of them in five sets of six (2 kit, 2 common, 1 uncommon, 1 rare); Standard odds kit ${pct(o.kit)}%, common ${pct(o.common)}%, uncommon ${pct(o.uncommon)}%, no rares; Bad Credit's rare ${(b.rare * 100).toFixed(1)}%`);
  // the draws: day 1 always set 1; later days mostly the day's set; a gold tin's first card is a kit card; no rare on Standard
  const rnd = mulberry32(5);
  let d1 = 0, own = 0, n = 0, gold = 0, rare = 0;
  for (let i = 0; i < 4000; i++) {
    if (K.CARD[K.rollCard(1, 'std', rnd)].set === 1) d1++;
    const c = K.CARD[K.rollCard(4, 'std', rnd)]; n++; if (c.set === 4) own++; if (c.rarity === 'rare') rare++;
    if (K.CARD[K.rollTin('goldtin', 3, 'std', rnd)[0]].kind === 'kit') gold++;
  }
  check(d1 === 4000 && Math.abs(own / n - 0.85) < 0.03 && gold === 4000 && rare === 0 && K.rollTin('tin', 2, 'std', rnd).length === 2 && K.rollTin('goldtin', 5, 'std', rnd).length === 3,
    `cards: day 1 draws only set 1; day 4 draws its own set ${(own / n * 100).toFixed(0)}% of the time (85%); a gold tin holds three, the first a kit card; no rare on Standard`);
  // P6: into the save. Won: a copy of each (a second copy counts); lost: the ones you never had are marked;
  // a practice trip keeps nothing; ids nobody has heard of are dropped
  const pid = '0123456789abcdef', trip = (run, o) => ({ run: run.padEnd(10, '0'), won: true, practice: null, tier: 'std', splits: [14, 14, 14, 14, 14], sold: 1000, day: 5, crew: [], ...o });
  const p = P.fresh(pid, 0);
  const w = P.creditTrip(p, trip('d1', { you: { fromStart: true, atEnd: true, cards: ['gnome', 'gloves', 'gloves', 'bogus'] } }));
  const l = P.creditTrip(p, trip('d2', { won: false, day: 3, splits: [14, 14, null, null, null], you: { fromStart: true, atEnd: true, cards: [], lost: ['gnome', 'ed'] } }));
  const pr = P.creditTrip(p, trip('d3', { practice: 'seed', seed: 9, you: { fromStart: true, atEnd: true, cards: ['vase'] } }));
  const back = P.parse(P.serialize(p)).prof;
  check(p.cards.gnome === 1 && p.cards.gloves === 2 && !p.cards.bogus && w.fresh.join() === 'gnome,gloves' && l.lostNew.join() === 'ed' && p.lost.ed === 3 && !p.lost.gnome
    && !p.cards.vase && pr.counted && p.life.cards === 3 && p.life.cardsLost === 2 && JSON.stringify(back.cards) === JSON.stringify(p.cards) && back.seen.length === 3,
    `save: a win's cards go in (gnome x${p.cards.gnome}, Work Gloves x${p.cards.gloves}, ${w.fresh.length} new); a loss marks the ones you never had (Honest Ed, day ${p.lost.ed}); a practice trip keeps nothing; it all reads back`);
}

// --- the Garage (shared/garage.js): the kit a server takes, the levels cards give, the parts the RV is fitted with ---
{
  const Gx = await import('../shared/garage.js'), P = await import('../shared/profile.js'), { mulberry32: rng } = await import('../shared/rng.js'), { CARD: CARD_OF } = await import('../shared/cards.js');
  // K1: clampKit: unknown ids go, levels are the integers 1 and 2, at most 3 perks (in the catalogue's order), one part;
  // anything that isn't an object is an empty kit
  const r = rng(77), pick = a => a[Math.floor(r() * a.length)];
  const IDS = [...Gx.PERK_IDS, ...Gx.PART_IDS, 'bogus', 'toString', '__proto__', 'constructor', ''], LVS = [0, 1, 2, 3, 1.5, '2', -1, null, NaN, 2, 1];
  let bad = 0;
  for (let i = 0; i < 4000; i++) {
    const perks = {};
    for (let j = 0; j < 1 + Math.floor(r() * 8); j++) perks[pick(IDS)] = pick(LVS);
    const raw = pick([{ perks, part: { id: pick(IDS), lv: pick(LVS) } }, { perks }, null, 7, 'kit', [1, 2], { perks: [1, 2] }, { part: 'winch' }]);
    const k = Gx.clampKit(raw), ids = Object.keys(k.perks);
    if (ids.length > 3 || ids.some(id => !Gx.PERK_IDS.includes(id) || ![1, 2].includes(k.perks[id])) || ids.join() !== Gx.PERK_IDS.filter(id => ids.includes(id)).join()) bad++;
    if (k.part && (!Gx.PART_IDS.includes(k.part.id) || ![1, 2].includes(k.part.lv) || Object.keys(k.part).length !== 2)) bad++;
    const m = Gx.kitMods(raw);
    if (!(m.fmax <= 1045 && m.slip <= 2.2 && m.climbMul >= 0.76 && m.far <= 38 && m.farNight <= 45 && m.holdT >= 1.6 && m.stam <= 60)) bad++;
  }
  const five = Gx.clampKit({ perks: { medic: 2, eye: 2, gloves: 2, chalk: 1, steady: 9, bogus: 2 }, part: { id: 'winch', lv: 2 } });
  check(bad === 0 && JSON.stringify(five) === '{"perks":{"gloves":2,"chalk":1,"eye":2},"part":{"id":"winch","lv":2}}' && JSON.stringify(Gx.clampKit('x')) === '{"perks":{},"part":null}',
    `garage: 4000 fuzzed kits clamp to known ids at levels 1-2, at most 3 perks and 1 part (five asked for: ${Object.keys(five.perks).join(', ')}); no number past its cap`);
  // K2: levelFrom: 1 copy I, 2 II, 5 still II; 3 doubles make a pick; a pick can't take a rare
  const pid = '0123456789abcdef', trip = (run, o) => ({ run: run.padEnd(10, '0'), won: true, practice: null, tier: 'std', splits: [14, 14, 14, 14, 14], sold: 1000, day: 5, rvEnd: 50, crew: [], ...o });
  const p = P.fresh(pid, 0);
  const t1 = P.creditTrip(p, trip('a1', { you: { fromStart: true, atEnd: true, cards: ['gloves', 'gloves', 'gloves', 'gnome', 'gnome', 'gnome', 'winch'] } }));
  const lvs = [0, 1, 2, 5].map(n => Gx.levelFrom({ gloves: n }, 'gloves'));
  const rare = P.spendPick(p, 'slopmaster'), spent = P.spendPick(p, 'chalk');
  const t2 = P.creditTrip(p, trip('a2', { rvEnd: 85, you: { fromStart: true, atEnd: true, cards: [] } }));
  const back = P.parse(P.serialize(p)).prof;
  check(lvs.join() === '0,1,2,2' && t1.picks === 1 && p.doubles === 0 && !rare && spent && p.cards.chalk === 1 && P.pickable(p).every(id => CARD_OF[id].rarity !== 'rare')
    && t2.mint && t2.picks === 1 && p.picks === 1 && JSON.stringify(p.kit) === '{"perks":["gloves","chalk"],"part":null}' && P.partOf(p) === 'winch'
    && JSON.stringify(P.kitFor(p)) === '{"perks":{"gloves":2,"chalk":1},"part":{"id":"winch","lv":1}}' && back.picks === 1 && JSON.stringify(back.kit) === JSON.stringify(p.kit),
    `garage: a card's copies give levels ${lvs.join(', ')} (0, 1, 2, 5 copies); 3 doubles made a pick, spent on Climbing Chalk (a rare refused); a MINT win (RV ${t2.mint ? 85 : '?'}%) made another; new perks took empty slots; it reads back`);
  // K3: fitParts: one part each, the best level per kind (the first to bring it on a tie), the rest spares
  const f = Gx.fitParts([{ id: 1, name: 'Ann', part: { id: 'winch', lv: 1 } }, { id: 2, name: 'Bob', part: { id: 'winch', lv: 2 } }, { id: 3, name: 'Cat', part: { id: 'horn', lv: 1 } },
    { id: 4, name: 'Dan', part: { id: 'horn', lv: 1 } }, { id: 5, name: 'Eve', part: null }, { id: 6, name: 'Fay', part: { id: 'toString', lv: 2 } }]);
  check(JSON.stringify(f.parts) === '{"winch":2,"horn":1}' && f.by.winch === 'Bob' && f.by.horn === 'Cat' && f.spares.length === 2 && Gx.spareLine(f.spares[0]) === "Ann's Winch Motor I is a spare: Bob's II is fitted",
    `garage: fitted ${JSON.stringify(f.parts)}; spares: ${f.spares.map(Gx.spareLine).join('; ')}`);
}

// --- the desktop build's save files (desktop/save.cjs): an atomic write leaves the last save as the backup,
// an unreadable one goes aside (the last 3 kept), and a player's copy never takes test switches ---
{
  const { createRequire } = await import('node:module');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const SV = createRequire(import.meta.url)('../desktop/save.cjs');
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nmd-save-')), 'save');
  const none = SV.readSave(dir);
  const ONE = '{"n":1}', TWO = '{"n":2}', THREE = '{"n":3}';
  SV.writeSave(dir, ONE); SV.writeSave(dir, TWO);
  const two = SV.readSave(dir), listed = fs.readdirSync(dir).sort().join(',');
  for (let i = 0; i < 5; i++) { fs.writeFileSync(path.join(dir, 'profile.json'), `bad${i}`); SV.quarantineSave(dir, 1000 + i); }
  const kept = fs.readdirSync(path.join(dir, 'corrupt')).sort().join(','), after = SV.readSave(dir);
  const big = SV.writeSave(dir, 'x'.repeat(SV.SAVE_MAX + 1));
  fs.writeFileSync(path.join(dir, 'profile.json'), 'garbage');   // (one that doesn't read doesn't push out the backup)
  SV.writeSave(dir, THREE);
  const three = SV.readSave(dir);
  check(none.text === null && two.text === TWO && two.bak === ONE && listed === 'profile.bak.json,profile.json' && kept === 'profile-1002.json,profile-1003.json,profile-1004.json' && after.text === null && after.bak === ONE && !big.ok
    && three.text === THREE && three.bak === ONE,
    `desktop save: written atomically with the last one as the backup (no .tmp left: ${listed}), an unreadable one kept aside (the last 3: ${kept}) and never made the backup, a save too big refused`);
  const env = { FRIENDSLOP_TEST: '1', FRIENDSLOP_FAST: '1', friendslop_nomobs: '1', PATH: '/bin' };
  check(Object.keys(SV.serverEnv(env, true)).join() === 'PATH' && Object.keys(SV.serverEnv(env, false)).length === 4,
    'desktop save: a packaged game\'s server never takes FRIENDSLOP_* test switches from its environment (an unpackaged one does, for the tests)');
}

const server = spawn(process.execPath, ['server/index.js'], { env: { ...process.env, PORT: String(PORT), FRIENDSLOP_TEST: '1', FRIENDSLOP_FAST: '1', FRIENDSLOP_NOMOBS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => { try { server.kill('SIGKILL'); } catch {} });
await new Promise((res, rej) => { server.stdout.on('data', d => { if (String(d).includes('rolling')) res(); }); setTimeout(() => rej(new Error('server did not start')), 8000); });

// --- the static file server: bad paths get an error, never a crash and never a file outside client/ or shared/ ---
{
  const get = path => new Promise(res => {
    const r = http.request({ host: 'localhost', port: PORT, path, method: 'GET' }, rs => { let n = 0; rs.on('data', d => { n += d.length; }); rs.on('end', () => res({ code: rs.statusCode, n })); });
    r.on('error', e => res({ code: 0, err: e.message }));
    r.end();
  });
  const bad = await get('/%E0%A4%A');
  const nul = await get('/%00');
  const up1 = await get('/shared/../server/room.js');
  const up2 = await get('/shared/%2e%2e/package.json');
  const up3 = await get('/../server/room.js');
  const okShared = await get('/shared/world.js');
  const okRoot = await get('/');
  check(bad.code === 400 && nul.code === 400, `server: a malformed URL escape and a NUL byte get 400 (${bad.code}, ${nul.code})`);
  check([up1, up2, up3].every(r => r.code === 403 || r.code === 404), `server: '..' out of shared/ or client/ is refused (${up1.code}, ${up2.code}, ${up3.code})`);
  check(okShared.code === 200 && okShared.n > 1000 && okRoot.code === 200, 'server: still serves /shared/world.js and / (alive after the bad requests)');
}

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
  async until(fn, ms = 8000, label = '') { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (this.snap && fn(this.snap.g, this.snap)) return true; await sleep(40); } throw new Error(`${this.name}: timed out: ${label} — g=${JSON.stringify({ ...this.snap?.g, cas: undefined })} rv=${JSON.stringify(this.snap?.rv.slice(0, 3))}`); }
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
  check(/^[1-9]\d{3}$/.test(wA.code), `the trip code is 4 digits (${wA.code})`);
  const other = wA.code === '5000' ? '5001' : '5000';
  B.send({ t: 'join', name: 'x', room: other });   // already joined: ignored
  const bad = new Player('Nobody'); await bad.connect(); bad.send({ t: 'join', name: 'n', room: other });
  const err = await bad.wait(m => m.t === 'error', 4000, 'error');
  check(err.code === 'noroom' && /No trip with that code/.test(err.msg), 'a well-formed code with no trip is turned away');
  bad.send({ t: 'join', name: 'n', room: 'QQQQ' });
  const err2 = await bad.wait(m => m.t === 'error' && m !== err, 4000, 'error 2');
  check(err2.code === 'noroom' && /4 digits/.test(err2.msg), 'letters are not a trip code (the old format)');
  bad.ws.close();
  // the code as a player might type or paste it: spaces and a dash fold away
  const typo = new Player('Typo'); await typo.connect(); typo.send({ t: 'join', name: 'Typo', room: ` ${wA.code.slice(0, 2)}-${wA.code.slice(2)} ` });
  await typo.wait(m => m.t === 'welcome', 8000, 'typo welcome');
  ok(`"${wA.code.slice(0, 2)}-${wA.code.slice(2)}" with spaces still finds trip ${wA.code}`);
  typo.send({ t: 'leave' }); typo.ws.close();
  A.pose(); B.pose();
  await A.until((g, s) => s.pl.length === 2, 4000, 'two players in snapshot');
  ok('two players in the room, poses flowing');

  let W = generateLeg(SEED, 1);
  {
    // the shove, over the wire: Beans faces Hosty a step away and shoves; Hosty's page is told it was a shove
    const x = W.camp.rv.x + 8, z = W.camp.rv.z - 3, y = W.heightAt(x, z);
    A.at(x, y, z + 1.4, Math.PI); B.at(x, y, z, 0);
    await sleep(200);
    B.send({ t: 'shove' });
    const k = await A.wait(m => m.t === 'knock', 4000, 'the shove\'s knock');
    check(k.why === 'shove' && !k.ko && !k.rel && k.v[2] > 2, `a shove over the wire knocks the other player back along it (${JSON.stringify(k.v)}), says why (${k.why}), and never knocks them out`);
  }
  {
    // a ringtail over the wire: Hosty grabs one and throws it; it lands stunned, and every page hears so
    const x = W.camp.rv.x + 8, z = W.camp.rv.z - 3, y = W.heightAt(x, z);
    A.at(x, y, z, 0); B.at(x + 6, y, z, 0);
    await sleep(200);
    A.send({ t: 'dbg', op: 'mob', type: 'ringtail', x, z: z + 1.4, yaw: Math.PI });
    const mb = await A.wait(m => m.t === 'dbg' && m.op === 'mob', 4000, 'the ringtail');
    await sleep(300);
    A.send({ t: 'grab', kind: 'prop', id: mb.id, pt: [x, W.heightAt(x, z + 1.4) + 0.24, z + 1.4], d: 1.4 });
    const gr = await A.wait(m => m.t === 'grabbed' && m.id === mb.id, 4000, 'grabbed');
    check(gr.ok, 'a ringtail can be grabbed over the wire');
    await sleep(300);
    A.send({ t: 'rel', thr: 1, dir: [0, 0.5, 1] });
    const st = await B.wait(m => m.t === 'ev' && m.list.some(e => e.k === 'mob' && e.id === mb.id && e.s === 'stun'), 4000, 'the stun').catch(() => null);
    check(!!st, 'thrown, it lands stunned, and every page hears it');
    A.send({ t: 'dbg', op: 'mobs', on: false });   // (that clears it away)
    await sleep(100);
  }
  // only the day's driver takes the wheel (drawn at random each morning: set here through the test lever, on
  // the driver's own socket, so it lands before their 'use')
  const roles = (drv, nav) => drv.send({ t: 'dbg', op: 'roles', drv: drv.id, nav: nav.id });
  // ---- drive ----------------------------------------------------------------------------
  roles(A, B);
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
  // today Hosty drives: Beans is refused the wheel, and told why
  B.at(0.6, 0.05, 2.85, 0, 0, 1);
  B.send({ t: 'use', kind: 'seat0' });
  await B.wait(m => m.t === 'toast' && /Hosty drives today\. Ride along/.test(m.text), 4000, 'refused the wheel');
  ok('the day\'s roles: Beans is refused the wheel while Hosty drives today');
  roles(B, A);   // Beans drives while Hosty minds the hook
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

  // ---- casino: a game each, one bank ---------------------------------------------------------------
  // Ann sits down at blackjack seat 1 while Bob plays Double or Nothing: neither waits on the other
  A.send({ t: 'dbg', op: 'clock', h: 9 });
  A.send({ t: 'dbg', op: 'bank', v: 1000 });
  const casU = id => W.uses.find(u => u.kind === 'cas' && u.arg === id);
  const casAt = id => W.town.casino_stations.find(q => q.id === id);
  const bjS = casAt('bj1'), fS = casAt('flip1');
  A.at(bjS.x, T.y + 0.05, bjS.z, 0, 0, 0);
  B.at(fS.x, T.y + 0.05, fS.z, 0, 0, 0);
  await sleep(150);
  A.send({ t: 'use', id: casU('bj1').id });
  B.send({ t: 'use', id: casU('flip1').id });
  await A.wait(m => m.t === 'cas' && m.at === 'bj1', 3000, 'a blackjack seat');
  await B.wait(m => m.t === 'cas' && m.at === 'flip1', 3000, 'a machine');
  A.send({ t: 'cas', s: 'bj1', a: 'b500' });
  B.send({ t: 'cas', s: 'flip1', a: 'b100' });
  await A.until(g => g.cas?.bj1?.bet === 500 && g.cas?.flip1?.bet === 100 && g.cas.bj1.o === A.id && g.cas.flip1.o === B.id, 3000, 'two bets');
  B.send({ t: 'cas', s: 'bj1', a: 'b500' });   // (not his seat)
  await sleep(150);
  const poached = A.g().cas.bj1.bet !== 500;
  A.events.length = 0;
  A.send({ t: 'cas', s: 'bj1', a: 'go' });
  B.send({ t: 'cas', s: 'flip1', a: 'go' });
  await A.until(g => g.cas.bj1.st !== 'bet', 3000, 'dealt');
  if (A.g().cas.bj1.st === 'play') A.send({ t: 'cas', s: 'bj1', a: 'stand' });
  await A.until(() => A.events.filter(e => e.k === 'bet').length >= 2, 8000, 'both settled');
  await sleep(150);
  const bjOut = A.events.find(e => e.k === 'bet' && e.by === A.id), flOut = A.events.find(e => e.k === 'bet' && e.by === B.id);
  check(!poached && bjOut && flOut && A.g().bank === 1000 + bjOut.won + flOut.won,
    `casino over the wire: Ann's blackjack (${bjOut?.won}) and Bob's coin (${flOut?.won}) played at once out of one bank ($1,000 -> $${A.g().bank}); Bob can't bet on Ann's seat`);
  // Ann walks off: her seat is free again
  A.at(bjS.x + 4, T.y + 0.05, bjS.z, 0, 0, 0);
  await A.until(g => g.cas.bj1.o == null, 3000, 'the seat freed');
  ok('casino: walking off a seat frees it');

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
  check(rc.due === QUOTAS[0], `paid the Repo Man $${QUOTAS[0]} → night (bank $${A.g().bank}, receipt: sold $${rc.sold}, bills $${rc.bills})`);
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
  roles(A, B);
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

  // ---- a missed payment, on any day, ends the run --------------------------------------------------------
  await A.until(g => g.ph === 'road', 4000, 'road (day 2: the knock test rolled us out of camp)');
  A.drain();
  A.send({ t: 'dbg', op: 'bank', v: 100 });
  A.send({ t: 'dbg', op: 'clock', h: 23.95 });
  const over = await A.wait(m => m.t === 'over', 6000, 'over');
  const repoEv = A.events.some(e => e.k === 'repo');
  check(over.won === false && over.day === 2 && over.due === QUOTAS[1] && over.short === QUOTAS[1] - 100 && repoEv && !A.q.some(m => m.t === 'receipt'),
    `missed the day-2 payment by $${over.short} → REPO'D on the spot: game over, no night (day ${over.day}, due $${over.due})`);
  const fresh = await A.wait(m => m.t === 'world' && m.day === 1, 10000, 'new run');
  await A.until(g => g.day === 1 && g.bank === 200, 3000, 'new run state');
  check(fresh.day === 1 && A.g().bank === 200, 'a fresh run starts: day 1, a new RV, $200');

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

  // ---- short on the day-5 balloon: the RV is gone -----------------------------------------------------------
  await A.wait(m => m.t === 'world' && m.day === 1, 10000, 'new run after the win');
  A.send({ t: 'dbg', op: 'day', d: 5 });
  await A.wait(m => m.t === 'world' && m.day === 5, 6000, 'day 5 (run 2)');
  await A.until(g => g.day === 5, 3000, 'day 5 state (run 2)');
  A.send({ t: 'dbg', op: 'phase', ph: 'road' });
  A.send({ t: 'dbg', op: 'bank', v: 0 });
  A.send({ t: 'dbg', op: 'clock', h: 23.95 });
  const lost = await A.wait(m => m.t === 'over', 6000, 'over (missed balloon)');
  check(lost.won === false && lost.day === 5 && lost.short === QUOTAS[4], `short on the day-5 balloon → the RV is gone (won=${lost.won}, $${lost.short} short)`);

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
