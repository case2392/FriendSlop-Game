// Looks (shared/looks.js): hats, outfits and dyes at the general store's clothes rail, the RV's paint at Gus's.
// Unlocks are the crew's (whatever anyone aboard has brought or bought, anyone wears, and everyone's save keeps)
// and they're bought and changed only at the vendor; the save keeps them honest (shared/profile.js).
process.env.FRIENDSLOP_TEST = '1';
process.env.FRIENDSLOP_FAST = '1';
process.env.FRIENDSLOP_NOMOBS = '1';
const C = await import('../shared/constants.js');
const { Room } = await import('../server/room.js');
const { initPhysics } = await import('../server/sim.js');
const L = await import('../shared/looks.js');
const P = await import('../shared/profile.js');

let failed = false;
const ok = m => console.log('✅', m);
const fail = m => { console.error('❌', m); failed = true; };
const check = (c, m) => (c ? ok(m) : fail(m));

// ---- the catalogue and the save --------------------------------------------------------------------------
{
  const ids = L.LOOK_IDS;
  check(ids.length === Object.keys(L.HAT_LOOKS).length + 6 + Object.keys(L.DYE_LOOKS).length + Object.keys(L.RV_PAINTS).length && ids.every(id => L.lookOf(id)?.price > 0)
    && !L.isLook('hat:toString') && !L.isLook('kit:9') && !L.isLook('rv:') && !L.isLook(7),
    `looks: ${ids.length} looks to unlock, each with a price; nothing that isn't on the list`);
  const w = L.allowedWear({ hat: 'helm', kit: 3, dye: 'navy' }, ['hat:helm', 'dye:navy']);
  check(w.hat === 'helm' && w.kit === null && w.dye === 'navy' && L.cleanWear({ hat: 'crown', kit: '2', dye: 5 }).hat === null && L.cleanWear({ kit: 2 }).kit === 2,
    'looks: you wear only what the crew has unlocked (the rest is what your seat issued)');
  const p = P.fresh('0123456789abcdef');
  P.addLooks(p, ['hat:helm', 'rv:sky', 'junk', 'hat:helm']);
  p.looks.wear = { hat: 'helm', kit: 4, dye: null }; p.looks.rv = 'sky';
  const back = P.parse(P.serialize(p)).prof;
  check(back.looks.own.join() === 'hat:helm,rv:sky' && back.looks.wear.hat === 'helm' && back.looks.wear.kit === null && back.looks.rv === 'sky'
    && P.validate({}).looks.own.length === 0 && P.validate({ looks: 'x' }).looks.wear.hat === null,
    'looks: the save keeps the unlocks (once each, known ones), what you wear (only if you own it) and the RV\'s paint');
}

// ---- in a room ------------------------------------------------------------------------------------------
await initPhysics();
const HZ = C.SIM_HZ;
class FakeConn {
  constructor() { this.readyState = 1; this.sent = []; }
  send(s) { this.sent.push(typeof s === 'string' ? JSON.parse(s) : s); }
  close() { this.readyState = 3; }
  last(t) { return [...this.sent].reverse().find(m => m.t === t); }
  all(t) { return this.sent.filter(m => m.t === t); }
  toasts() { return this.all('toast').map(m => m.text); }
}
const tick = (room, secs) => { for (let i = 0; i < Math.round(secs * HZ); i++) room.tick(1 / HZ); };
const stand = (room, p, x, z) => room.onPose(p, { x, y: room.W.heightAt(x, z), z, yaw: 0, pitch: 0, m: C.MODE.WALK, f: 0, v: [0, 0, 0] });
const join = (room, name, looks) => { const c = new FakeConn(); const p = room.addPlayer(c, name).player; room.setProfile(p, { pid: undefined, wins: 0, looks }); room.welcome(p); p.conn = c; return p; };
const send = (room, p, m) => { tick(room, 0.35); room.handle(p, m); };
const metaOf = (p, id) => p.conn.last('meta')?.players.find(q => q.id === id);
{
  const room = new Room('LOOK', 4242);
  // Ann brings a helm and a sky-blue paint job from an earlier trip, and wears the helm
  const A = join(room, 'Ann', { own: ['hat:helm', 'rv:sky'], wear: { hat: 'helm' }, rv: 'sky' });
  const B = join(room, 'Bob', { own: ['dye:navy'], wear: { dye: 'navy', hat: 'visor' } });
  tick(room, 0.3);
  room.sendMeta();
  const pooled = room.looks.has('hat:helm') && room.looks.has('dye:navy') && room.rvPaint === 'sky'
    && B.conn.all('unlock').some(m => m.ids.includes('hat:helm')) && A.conn.all('unlock').some(m => m.ids.includes('dye:navy'))
    && metaOf(A, A.id).wear.hat === 'helm' && metaOf(A, B.id).wear.dye === 'navy' && metaOf(A, B.id).wear.hat === null && A.conn.last('meta').trip.rv === 'sky';
  check(pooled, 'looks: what each player brings is the crew\'s (and goes into everyone\'s save); each wears their own look as far as it goes (Bob\'s visor he never had: issued); the RV comes in Ann\'s paint');
  // Bob wears Ann's helm: only at the clothes rail
  const T = room.W.town.tailor;
  stand(room, B, T.x + 20, T.z);
  send(room, B, { t: 'wear', hat: 'helm' });
  const far = room.players.get(B.id).wearing.hat === null;
  stand(room, B, T.x, T.z);
  send(room, B, { t: 'wear', hat: 'helm' });
  send(room, B, { t: 'wear', kit: 2 });   // (not unlocked: stays issued)
  const worn = room.players.get(B.id).wearing.hat === 'helm' && room.players.get(B.id).wearing.kit === null && metaOf(A, B.id).wear.hat === 'helm';
  // buying a hat: from the bank, the crew's at once, on the buyer
  const bank0 = room.bank, price = L.HAT_LOOKS.straw.price;
  send(room, B, { t: 'lookBuy', id: 'hat:straw' });
  const bought = room.bank === bank0 - price && room.looks.has('hat:straw') && A.conn.all('unlock').some(m => m.ids.join() === 'hat:straw') && room.players.get(B.id).wearing.hat === 'straw';
  send(room, B, { t: 'lookBuy', id: 'hat:straw' });
  const once = room.bank === bank0 - price;
  room.bank = 10;
  send(room, B, { t: 'lookBuy', id: 'kit:5' });
  const short = !room.looks.has('kit:5');
  // back to issued
  room.bank = 5000;
  send(room, B, { t: 'wear', hat: null });
  const issued = room.players.get(B.id).wearing.hat === null;
  check(far && worn && bought && once && short && issued, `looks: at the clothes rail (not across the street: ${far}) Bob puts on Ann's helm (${worn}); a straw hat bought is the crew's and on his head (${bought}), once (${once}); short of the price, no (${short}); back to what he was issued (${issued})`);
  // paint: Gus, at night with the RV on his lot
  const G = room.W.town.gusBoard;
  stand(room, A, G.x + 1.2, G.z);
  send(room, A, { t: 'lookBuy', id: 'rv:flame' });
  const day = !room.looks.has('rv:flame') && /Repo Man's been paid/.test(A.conn.toasts().slice(-1)[0]);
  room.bank = 5000 + room.due; room.pay(); tick(room, 0.5);
  stand(room, A, G.x + 1.2, G.z);
  send(room, A, { t: 'lookBuy', id: 'rv:flame' });
  const painted = room.looks.has('rv:flame') && room.rvPaint === 'flame' && A.conn.last('meta').trip.rv === 'flame';
  send(room, A, { t: 'paint', id: 'sky' });
  const back = room.rvPaint === 'sky';
  send(room, A, { t: 'paint', id: 'midnight' });   // (not the crew's)
  const notOwned = room.rvPaint === 'sky';
  send(room, A, { t: 'paint', id: null });
  check(day && painted && back && notOwned && room.rvPaint === null, `looks: Gus paints the RV only at night once paid (${day}); a new paint job goes on (${painted}); he puts on one the crew has (${back}), not one it hasn't (${notOwned}), or the stock cream`);
}

if (failed) { console.error('💥 LOOKS TESTS FAILED'); process.exit(1); }
console.log('All looks checks passed');
process.exit(0);
