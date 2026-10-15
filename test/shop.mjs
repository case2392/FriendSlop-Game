// The town shops (shared/shop.js, server/room.js shopBuy): Gus's RV upgrades. What buying takes (standing at
// his parts board, at night once the day's paid, the RV at his lot, the bank), what it costs and where it shows
// (the meta, the next day, a new trip), and that each upgrade does what its line says, measured on the server's
// own physics: the frame's knocks, the winch's cable, the V8 and a shot of nitrous on the road, the tyres in mud.
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const { UPGRADES, UPGRADE_IDS, VENDORS, NITRO, HEAVY, rvMods } = await import('../shared/shop.js');
const { partMods } = await import('../shared/garage.js');
const { qRotate } = await import('../shared/rv.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

await initPhysics();
const HZ = C.SIM_HZ;
class FakeConn {
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() { this.readyState = 3; }
  last(t) { return [...this.sent].reverse().find(m => m.t === t); }
  toasts() { return this.sent.filter(m => m.t === 'toast').map(m => m.text); }
}
const tick = (room, secs) => { for (let i = 0; i < Math.round(secs * HZ); i++) room.tick(1 / HZ); };
function crew(names, day = 1, seed = 4242) {
  const room = new Room('SHOP', seed);
  const ps = names.map(n => { const c = new FakeConn(); const p = room.addPlayer(c, n).player; room.welcome(p); p.conn = c; return p; });
  if (day > 1) room.debug(ps[0], { op: 'day', d: day });
  tick(room, 0.2);
  return { room, ps };
}
const stand = (room, p, x, z, yaw = 0) => room.onPose(p, { x, y: room.W.heightAt(x, z), z, yaw, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
const atBoard = (room, p) => { const b = room.W.town.gusBoard; stand(room, p, b.x + 1.2, b.z, -Math.PI / 2); };
// the day paid: night, the RV parked at the lot
function night(room, bank = 5000) {
  room.bank = bank + room.due;
  room.pay();
  tick(room, 0.5);
}
const lastToast = p => p.conn.toasts().slice(-1)[0] || '';
const roadYaw = (W, z) => Math.atan2(W.roadX(z + 3) - W.roadX(z - 3), 6);

// ---- the catalogue -----------------------------------------------------------------------------------
{
  const stock = rvMods(null, null), all = rvMods(null, Object.fromEntries(UPGRADE_IDS.map(id => [id, 1])));
  const base = partMods(null);
  const same = Object.keys(base).every(k => stock[k] === base[k]);
  check(same && stock.hitX === 1 && stock.cable === C.WINCH.MAX_LEN && stock.pull === C.WINCH.FORCE && stock.engineX === 1 && stock.topX === 1 && stock.mudSlip === C.RV.MUD_SLIP && stock.mudDragX === 1 && !stock.padlock && !stock.nitro,
    'shop: with nothing bought the RV is the stock RV (the Garage\'s parts unchanged under it)');
  check(all.hitX === 0.7 && all.cable === HEAVY.CABLE && all.pull === C.WINCH.FORCE * HEAVY.PULL && all.engineX === 1.25 && Math.abs(all.topX * C.RV.TOP_SPEED - 20) < 1e-9 && all.mudSlip === 2 * C.RV.MUD_SLIP && all.mudDragX === 0.5 && all.padlock && all.nitro,
    `shop: Gus's ${UPGRADE_IDS.length} upgrades each set what their lines say (${UPGRADE_IDS.map(id => `${UPGRADES[id].name} $${UPGRADES[id].price}`).join(', ')})`);
  const junk = rvMods(null, { toString: 1, __proto__: { frame: 1 }, hull: 1 });
  check(junk.hitX === 1 && Object.keys(VENDORS).every(v => VENDORS[v].goods.every(id => UPGRADES[id])), 'shop: an id that isn\'t on the list (or an inherited one) fits nothing');
}

// ---- buying ------------------------------------------------------------------------------------------
{
  const { room, ps: [A, B] } = crew(['Ann', 'Bob']);
  const W = room.W, bank0 = room.bank;
  // (a buy a moment after the last: the room drops one sent within 0.3 s of the last)
  const buy = (p, m) => { tick(room, 0.35); room.handle(p, { t: 'shopBuy', v: 'gus', ...m }); };
  // E on the parts board: the catalogue opens (the page draws it)
  const use = W.uses.find(u => u.kind === 'shop' && u.arg === 'gus');
  atBoard(room, A);
  room.handle(A, { t: 'use', id: use.id });
  const opened = A.conn.last('shop')?.v === 'gus';
  // in the morning: not till the day's paid
  buy(A, { id: 'frame' });
  const morning = room.bank === bank0 && !room.upg.frame && /Repo Man's been paid/.test(lastToast(A));
  night(room);
  const b1 = room.bank;
  // from across the lot: he can't hear you
  stand(room, B, W.town.gus.x + 12, W.town.gus.z);
  buy(B, { id: 'frame' });
  const far = room.bank === b1 && !room.upg.frame && /can't hear you/.test(lastToast(B));
  // at the board: fitted
  atBoard(room, A);
  buy(A, { id: 'frame' });
  tick(room, 0.1);
  const bought = room.bank === b1 - UPGRADES.frame.price && room.upg.frame === 1 && room.partMods.hitX === 0.7 && room.sim.parts.hitX === 0.7
    && A.conn.last('meta')?.trip?.upg?.includes('frame') && B.conn.last('meta')?.trip?.upg?.includes('frame') && /fit the Reinforced Frame/.test(lastToast(B));
  // again: it's already on; an id he doesn't sell, another vendor, junk: nothing
  buy(A, { id: 'frame' });
  for (const m of [{ v: 'gus', id: 'toString' }, { v: 'toString', id: 'frame' }, { v: 'ed', id: 'winch' }, { v: 'gus', id: { x: 1 } }]) buy(A, m);
  const twice = room.bank === b1 - UPGRADES.frame.price && Object.keys(room.upg).join() === 'frame';
  // the bank short: no
  room.bank = UPGRADES.engine.price - 1;
  buy(A, { id: 'engine' });
  const short = !room.upg.engine && room.bank === UPGRADES.engine.price - 1;
  // the RV taken off the lot: bring it round
  room.bank = 5000;
  room.sim.placeRV(W.roadX(W.town.z - 30), W.town.z - 30, 0);
  buy(A, { id: 'winch' });
  const away = !room.upg.winch && /Bring the RV round/.test(lastToast(A));
  check(opened && morning && far && bought && twice && short && away,
    `shop: E on Gus's board opens his catalogue (${opened}); he fits nothing before the day's paid (${morning}), nor for someone across the lot (${far}), nor with the RV off his lot (${away}); at the board at night the frame is fitted from the bank, for the crew, and they're told (${bought}); once only, and nothing for junk (${twice}) or short of the price (${short})`);
  // into tomorrow, and gone with a new trip
  room.sim.placeRV(W.town.lot.x, W.town.lot.z, W.town.lot.yaw);
  tick(room, 0.5);
  buy(A, { id: 'nitro' });
  room.nextDay();
  tick(room, 0.5);
  const tomorrow = room.day === 2 && room.upg.frame && room.upg.nitro && room.sim.parts.hitX === 0.7 && room.sim.parts.nitro && room.nos === NITRO.SHOTS && room.gameState().nos?.[0] === NITRO.SHOTS;
  room.newRun();
  tick(room, 0.2);
  const fresh = !Object.keys(room.upg).length && room.sim.parts.hitX === 1 && !room.gameState().nos;
  check(tomorrow && fresh, `shop: what Gus fits stays on the RV into tomorrow (${tomorrow}), and a new trip starts with the stock RV (${fresh})`);
}

// ---- the Reinforced Frame: a crash, a beast, a rock cost 30% less (a window as ever) ----------------------
{
  const amts = [];
  for (const frame of [false, true]) {
    const { room } = crew(['Ann']);
    if (frame) { room.upg.frame = 1; room.partMods = rvMods(null, room.upg); }
    room.phase = 'road';
    const r = [];
    for (const e of [{ why: 'crash', dv: 7, zone: 'side' }, { why: 'beast', amt: 10, zone: 'side' }, { why: 'rock', amt: C.RVH.ROCK, zone: 'roof' }, { why: 'window', amt: C.RVH.WINDOW, zone: 'side' }]) {
      const hp = room.rvc.hp;
      room.rvc.inc = null;
      room.onRVHit(e);
      r.push(hp - room.rvc.hp);
      room.t += 10;
    }
    amts.push(r);
  }
  const [s, f] = amts;
  check(f[0] === Math.round(s[0] * 0.7) && f[1] === Math.round(s[1] * 0.7) && f[2] === Math.round(s[2] * 0.7) && f[3] === s[3] && s[0] > 0,
    `shop: with the Reinforced Frame a crash costs ${f[0]}% (stock ${s[0]}%), a Grumphorn ${f[1]}% (${s[1]}%), a rock ${f[2]}% (${s[2]}%), a ringtail out a window ${f[3]}% as ever`);
}

// ---- the Heavy-Duty Winch: the hook carried 50 m out is still in hand (stock: yanked away past 42 m) ---------
{
  const res = [];
  for (const heavy of [false, true]) {
    const { room, ps: [A] } = crew(['Ann']);
    const sim = room.sim, W = room.W;
    if (heavy) { room.upg.winch = 1; room.partMods = rvMods(null, room.upg); sim.setParts(room.partMods); }
    sim.placeRV(W.roadX(150), 150, roadYaw(W, 150));
    tick(room, 1);
    const w = sim.winchWorld();
    stand(room, A, w.x, w.z + 1);
    tick(room, 0.1);
    sim.takeHook(A.id, A);
    // walk it up the road at 4 m/s
    let held = 0;
    for (let d = 1; d <= 50; d += 4 / HZ) {
      const z = w.z + d;
      stand(room, A, W.roadX(z), z);
      room.tick(1 / HZ);
      if (sim.hook.holder === A.id) held = d;
    }
    res.push(held);
  }
  check(res[0] > 38 && res[0] < 46 && res[1] >= 49.9, `shop: the hook walked out up the road: stock it's yanked from your hands at ${res[0].toFixed(0)} m; with the Heavy-Duty Winch it's still in hand at ${res[1].toFixed(0)} m (${HEAVY.CABLE} m of cable)`);
}

// ---- the V8 and the nitrous: faster up the road -------------------------------------------------------
// full throttle up day 1's road from a standstill, steering along it, for `secs` (nitro: a shot at `shotAt` s)
function run(upg, secs, shotAt = null) {
  const { room, ps: [A] } = crew(['Ann']);
  const sim = room.sim, W = room.W;
  room.upg = { ...upg }; room.partMods = rvMods(null, room.upg); sim.setParts(room.partMods);
  room.phase = 'road';
  const z0 = 60;
  sim.placeRV(W.roadX(z0), z0, roadYaw(W, z0));
  tick(room, 1);
  A.seat = 0;
  let top = 0, at = [];
  for (let i = 0; i < secs * HZ; i++) {
    const p = sim.rv.translation(), f = qRotate(sim.rv.rotation(), { x: 0, y: 0, z: 1 }), gz = p.z + 14, tx = W.roadX(gz) - p.x, tz = gz - p.z;
    const err = -Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz);
    room.handle(A, { t: 'drv', th: 1, st: Math.max(-1, Math.min(1, err * 2.5)), hb: 0 });
    if (shotAt != null && Math.abs(i / HZ - shotAt) < 0.5 / HZ) room.handle(A, { t: 'nos' });
    room.tick(1 / HZ);
    top = Math.max(top, sim.rvSpeed());
    at.push(sim.rvSpeed());
  }
  return { top, at, room, A };
}
{
  const stock = run({}, 22), v8 = run({ engine: 1 }, 22);
  // (the road's bends and grades hold both under their top ends in 22 s: how fast each gets, and gets to 12 m/s)
  const to12 = r => r.at.findIndex(v => v >= 12) / HZ;
  check(stock.top <= C.RV.TOP_SPEED + 0.2 && v8.top > stock.top + 1.5 && to12(v8) > 0 && to12(v8) < 0.8 * to12(stock),
    `shop: up day 1's road flat out for 22 s, the stock RV gets to ${(stock.top * 2.237).toFixed(0)} mph and the Big-Block V8 to ${(v8.top * 2.237).toFixed(0)} mph, and it's at 27 mph in ${to12(v8).toFixed(1)} s (stock ${to12(stock).toFixed(1)} s)`);
  const plain = run({ nitro: 1 }, 14), nos = run({ nitro: 1 }, 14, 9);
  const gain = nos.at[Math.round(12.5 * HZ)] - plain.at[Math.round(12.5 * HZ)];
  check(gain > 1.2 && nos.room.nos === NITRO.SHOTS - 1, `shop: a shot of nitrous at cruise: ${(gain * 2.237).toFixed(0)} mph more 3.5 s later than without, and a shot fewer left today (${nos.room.nos})`);
  // three shots, then none; not from the passenger seat; not without the kit
  const { room, A } = run({ nitro: 1 }, 1);
  const before = room.nos;
  room.sim.nitroUntil = 0;
  for (let k = 0; k < 5; k++) { room.handle(A, { t: 'nos' }); room.sim.nitroUntil = 0; room.t += 1; }
  const used = before - room.nos;
  const none = run({}, 1);
  none.room.handle(none.A, { t: 'nos' });
  check(used === NITRO.SHOTS && room.nos === 0 && /Out of nitrous/.test(lastToast(A)) && none.room.sim.nitroUntil === 0,
    `shop: ${NITRO.SHOTS} shots of nitrous a day, then "out of nitrous" (${used} fired of 5 asked); none without the kit`);
}

// ---- Mud Tires: through the mud -----------------------------------------------------------------------
{
  // the first day with a mud hole on seed 4242: flat out into it from 15 m short, how far past its start in 12 s
  let day = 1, W = null;
  for (; day <= 5; day++) { const c = crew(['Ann'], day); if (c.room.W.obstacles.some(o => o.type === 'mud')) { W = c.room.W; break; } }
  const mud = W.obstacles.find(o => o.type === 'mud');
  const res = [];
  for (const tires of [false, true]) {
    const { room, ps: [A] } = crew(['Ann'], day);
    const sim = room.sim, W2 = room.W;
    if (tires) { room.upg.tires = 1; room.partMods = rvMods(null, room.upg); sim.setParts(room.partMods); }
    room.phase = 'road';
    const z0 = mud.z - 15;
    sim.placeRV(W2.roadX(z0), z0, roadYaw(W2, z0));
    tick(room, 1);
    A.seat = 0;
    for (let i = 0; i < 12 * HZ; i++) {
      const p = sim.rv.translation(), f = qRotate(sim.rv.rotation(), { x: 0, y: 0, z: 1 }), gz = p.z + 12, tx = W2.roadX(gz) - p.x, tz = gz - p.z;
      const err = -Math.atan2(f.x * tz - f.z * tx, f.x * tx + f.z * tz);
      room.handle(A, { t: 'drv', th: 1, st: Math.max(-1, Math.min(1, err * 2.5)), hb: 0 });
      room.tick(1 / HZ);
    }
    res.push(sim.rv.translation().z - mud.z);
  }
  check(res[1] > res[0] + 8, `shop: flat out into day ${day}'s mud for 12 s the stock RV gets ${res[0].toFixed(0)} m in; on Mud Tires ${res[1].toFixed(0)} m`);
}

if (failed) { console.error('💥 SHOP TESTS FAILED'); process.exit(1); }
console.log('All shop checks passed');
process.exit(0);
