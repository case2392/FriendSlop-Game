// Road Cards (shared/cards.js, shared/finds.js, server/room.js): where the tins lie, the glovebox, the cards
// in Ed's safes and suitcases, and who keeps what. In process (Room + Sim with fake connections, fixed
// 1/60 s ticks). The ringtails and the Grumphorn's part are in test/mobs.mjs.
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { toWorld, RV_DIM } = await import('../shared/rv.js');
const { generateLeg } = await import('../shared/world.js');
const { findSpots, clearAt } = await import('../shared/finds.js');
const { CARD } = await import('../shared/cards.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

await initPhysics();
class FakeConn {
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() { this.readyState = 3; }
  last(t) { return [...this.sent].reverse().find(m => m.t === t); }
  has(pred) { return this.sent.some(pred); }
}
const tick = (room, secs) => { for (let i = 0; i < Math.round(secs * C.SIM_HZ); i++) room.tick(1 / C.SIM_HZ); };
const evs = (conn, k) => conn.sent.filter(m => m.t === 'ev').flatMap(m => m.list).filter(e => e.k === k);
function crew(names, opts = {}) {
  const room = new Room('CARD', 4242, opts);
  const ps = names.map((n, i) => {
    const c = new FakeConn(), p = room.addPlayer(c, n).player;
    p.key = 'tok:' + n; room.setProfile(p, { pid: String(i + 1).repeat(16) }); room.welcome(p); p.conn = c;
    return p;
  });
  tick(room, 0.2);
  return { room, ps };
}

// ---- F1: where the tins lie --------------------------------------------------------------------------
{
  const bad = [];
  let n = 0, tops = 0;
  for (const seed of [4242, 7, 777]) for (let day = 1; day <= 5; day++) {
    const W = generateLeg(seed, day), spots = findSpots(W);
    const look = spots.filter(s => s.kind === 'lookout'), den = spots.filter(s => s.kind === 'den'), gold = spots.filter(s => s.kind === 'gold');
    const crash = W.pois.filter(p => p.type === 'crash' && p.mesa).sort((a, b) => a.z - b.z)[0];
    const where = `${seed}/${day}`;
    if (look.length !== 1) bad.push(`${where}: ${look.length} lookout spots`);
    else if (crash) {
      const M = crash.mesa, t = M.topAt(look[0].x, look[0].z);
      if (t == null || Math.abs(t - (M.base + M.h)) > 0.05) bad.push(`${where}: the day has a crash butte, but its lookout tin isn't on top`); else tops++;
    } else if (!W.obstacles.some(o => o.codeAt) && !W.obstacles.some(o => o.type === 'grade')) bad.push(`${where}: a lookout with nowhere to be`);
    if (den.length !== (day >= 2 ? 1 : 0)) bad.push(`${where}: ${den.length} den spots`);
    else if (den[0]) {
      const d = W.dens.find(x => x.id === den[0].den), it = d && W.props.find(p => p.id === d.stash[0]);
      if (!d || d.hoard || !it || Math.hypot(it.x - den[0].x, it.z - den[0].z) > 2) bad.push(`${where}: the den tin isn't beside a den's stash`);
    }
    if (gold.length !== (day === 5 ? 1 : 0)) bad.push(`${where}: ${gold.length} gold spots`);
    else if (gold[0] && !W.dens.find(x => x.id === gold[0].den)?.hoard) bad.push(`${where}: the gold tin isn't the Hoard's`);
    for (const s of spots) {
      n++;
      const under = W.topAt(s.x, s.z);
      if (Math.abs(s.y - under) > 0.2) bad.push(`${where} ${s.kind}: ${(s.y - under).toFixed(2)} m off the ground`);
      if (!clearAt(W, s.x, s.y, s.z, 0.5)) bad.push(`${where} ${s.kind}: within 0.5 m of something`);
      const grade = s.kind === 'lookout' && !crash && !W.obstacles.some(o => o.codeAt);
      if (!grade && Math.abs(s.x - W.roadX(s.z)) < 4) bad.push(`${where} ${s.kind}: on the road`);
    }
  }
  check(!bad.length, `finds: a lookout tin every day (${tops} on a crash butte's top), a den tin on days 2-5, the gold tin by the Hoard on day 5; on the ground, clear of everything, off the road (${n} spots${bad.length ? ': ' + bad.slice(0, 4).join('; ') : ''})`);
}

// ---- F2: findSpots never touches the world --------------------------------------------------------------
{
  const ser = W => JSON.stringify(W, (k, v) => (ArrayBuffer.isView(v) ? Array.from(v) : typeof v === 'function' ? undefined : v));
  let same = true;
  for (const day of [1, 3, 5]) {
    const a = generateLeg(777, day), b = generateLeg(777, day);
    const before = ser(a);
    findSpots(a);
    same = same && ser(a) === before && ser(a) === ser(b);
  }
  check(same, 'finds: generateLeg is the same world, byte for byte, with or without its tins worked out');
}

// ---- F3: the glovebox ------------------------------------------------------------------------------------
{
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  const sim = room.sim, r = sim.rvPose();
  const put = l => { const p = sim.addProp('tin', toWorld(r.p, r.q, l), r.q, 0, 0); p.lastBy = A.id; return p; };
  const n0 = room.glovebox.length;
  const tin = put({ x: 0.2, y: 0.3, z: -1 });
  const held = put({ x: -0.3, y: 0.3, z: -2 }); held.holders.add(B.id);
  const roof = put({ x: 0, y: RV_DIM.ROOF_Y + 0.2, z: 0 });
  const g = { x: r.p.x + 7, z: r.p.z + 3 }, out = sim.addProp('tin', { x: g.x, y: room.W.heightAt(g.x, g.z) + 0.3, z: g.z }, r.q, 0, 0);
  tick(room, 2 / C.SIM_HZ);
  const st = evs(A.conn, 'stow'), e = room.glovebox[n0];
  check(!sim.props.has(tin.id) && st.length === 1 && st[0].cards.length === 2 && st[0].cards.every(id => CARD[id]) && e?.by === 'Ann' && e.kind === 'tin'
    && e.aboard.length === 2 && e.aboard.includes(A.pid) && e.aboard.includes(B.pid) && room.gameState().gb === 2,
    `glovebox: a tin set down in the RV is gone on the next tick: one 'stow' with 2 cards (${st[0]?.cards.map(id => CARD[id]?.name).join(', ')}), found by ${e?.by}, both of the crew aboard for it`);
  tick(room, 1);
  check(sim.props.has(held.id) && sim.props.has(roof.id) && sim.props.has(out.id) && room.glovebox.length === n0 + 1,
    'glovebox: a tin somebody is holding in the RV, one on the roof and one outside all stay where they are');
  // a late joiner is told what's in it
  const c = new FakeConn(), L = room.addPlayer(c, 'Lou').player;
  room.welcome(L);
  check(c.last('glovebox')?.list?.[0]?.cards?.length === 2 && !('aboard' in c.last('glovebox').list[0]), 'glovebox: a page that joins is sent what\'s in it (not who was aboard)');
  room.sim.free?.();
}

// ---- F4: the cards in Ed's safes and suitcases -----------------------------------------------------------
{
  let R = 0.1;
  const { room, ps: [A] } = crew(['Ann'], { rand: () => R });
  room.phase = 'road'; room.inTown = true;
  const W = room.W, sim = room.sim, pawn = W.town.pawn;
  const sell = (type, roll) => {
    R = roll;
    sim.addProp(type, { x: pawn.x, y: pawn.y + 0.5, z: pawn.z }, { x: 0, y: 0, z: 0, w: 1 }, 500, 500);
    tick(room, 0.5);
    const n = room.gloveCards();
    room.sellCounter(A.id);
    return room.gloveCards() - n;
  };
  const got = { safeLow: sell('safe', 0.1), safeHigh: sell('safe', 0.9), suitcase: sell('suitcase', 0.2), toaster: sell('toaster', 0.01) };
  const told = A.conn.has(m => m.t === 'toast' && /Ed pried the Rusty Safe open: a Road Card! It's in the glovebox\./.test(m.text));
  // a docked load
  R = 0.1;
  const d = W.town.dock;
  sim.placeRV(d.x, d.z, 0); tick(room, 1);
  const rp = sim.rvPose();
  sim.addProp('safe', toWorld(rp.p, rp.q, { x: 0, y: 0.5, z: -1.5 }), rp.q, 500, 500);
  tick(room, 1);
  const n1 = room.gloveCards();
  room.sellCounter(A.id);
  const docked = room.gloveCards() - n1;
  // Ed's own ring-up at midnight
  room.bank = 1e6;
  sim.addProp('safe', { x: pawn.x, y: pawn.y + 0.5, z: pawn.z }, { x: 0, y: 0, z: 0, w: 1 }, 500, 500);
  tick(room, 0.5);
  const n2 = room.gloveCards();
  room.midnight();
  const late = room.gloveCards() - n2;
  // and nothing during the game-over
  room.phase = 'over';
  sim.addProp('safe', { x: pawn.x, y: pawn.y + 0.5, z: pawn.z }, { x: 0, y: 0, z: 0, w: 1 }, 500, 500);
  room.over = { won: true, at: room.t, day: 1 };
  const n3 = room.gloveCards();
  room.sellCounter(A.id);
  const over = room.gloveCards() - n3;
  check(got.safeLow === 1 && got.safeHigh === 0 && got.suitcase === 1 && got.toaster === 0 && told && docked === 1 && late === 1 && over === 0 && evs(A.conn, 'stow').some(e => e.kind === 'safe' && e.by === 'Ed'),
    `containers: a safe Ed opens has a card at a roll of 0.1, none at 0.9; a suitcase at 0.2; a toaster never; a docked load and his midnight ring-up roll too; nothing during the game-over (${JSON.stringify({ ...got, docked, late, over })})`);
  room.sim.free?.();
}

// ---- F5: who keeps what --------------------------------------------------------------------------------
{
  const run = won => {
    const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
    room.phase = 'road'; room.ride();   // (out on the road: a trip summary is for whoever rode)
    room.stow(['gnome', 'toaster'], 'tin', 'Ann');               // 1: Ann and Bob
    const cc = new FakeConn(), Cc = room.addPlayer(cc, 'Cid').player;
    Cc.key = 'tok:Cid'; room.setProfile(Cc, { pid: '3'.repeat(16) }); room.welcome(Cc); room.ride();
    room.stow(['ed'], 'safe', 'Ed');                              // 2: all three
    room.removePlayer(B.id, 'left');
    room.stow(['tire', 'mudbog'], 'tin', 'Cid');                 // 3: Ann and Cid (Bob's gone)
    const cb = new FakeConn(), B2 = room.addPlayer(cb, 'Bob').player;
    B2.key = 'tok:Bob2'; room.setProfile(B2, { pid: '2'.repeat(16) }); room.welcome(B2); room.ride();
    room.stow(['vase', 'looserock'], 'tin', 'Bob');              // 4: all three again
    room.finish(won);
    const trip = conn => conn.last('trip')?.you;
    const res = { a: trip(A.conn), b: trip(cb), c: trip(cc), all: room.glovebox.flatMap(g => g.cards) };
    room.newRun();
    res.next = room.glovebox.length + room.gloveCards();
    room.sim.free?.();
    return res;
  };
  const w = run(true), l = run(false);
  const same = (a, b) => JSON.stringify([...(a || [])].sort()) === JSON.stringify([...b].sort());
  check(same(w.a.cards, w.all) && same(w.b.cards, ['gnome', 'toaster', 'ed', 'vase', 'looserock']) && same(w.c.cards, ['ed', 'tire', 'mudbog', 'vase', 'looserock'])
    && !w.a.lost.length && w.next === 0,
    `the award: paid off, each keeps a copy of every card stowed while they were aboard (Ann ${w.a.cards.length}, Bob ${w.b.cards.length}: not the tin found while he was away, Cid ${w.c.cards.length}: not the one before he came); the next trip's glovebox is empty`);
  check(!l.a.cards.length && !l.b.cards.length && same(l.a.lost, l.all) && same(l.c.lost, l.all) && l.next === 0,
    `the award: repo'd, nobody keeps anything and every trip message lists the glovebox as lost (${l.a.lost.length} cards)`);
}

if (failed) { console.error('\nSome Road Card checks FAILED'); process.exit(1); }
console.log('\nAll Road Card checks passed');
process.exit(0);
