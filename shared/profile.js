// A player's save: what they keep from one trip to the next, on their own machine (the page loads and
// writes it: client/js/profile.js). Pure, so the page, the tests and the tools share it. The host's server
// never sees more of it than forServer() in client/js/profile.js hands over (the profile id and the
// number of wins).
//
// Version 1, about 2-10 KB of JSON:
//   v      1
//   pid    16 random hex characters made on the first launch (never a Steam id)
//   made, saved    when it was made and last written (ms since 1970); rev: how many times it's been written
//   best   { std, bad }: the records, one board per loan terms (a Board: fast, splits, haul, clean)
//   crews  the 12 crews you've finished a whole trip with most recently: { key, names, trips, wins, fast, haul, at }
//   seeds  the 20 typed seeds you've practised on most recently: { seed, trips, wins, fast, haul, at }
//   life   lifetime counters: trips, wins (paid off with you aboard at the end: the wins the host's server
//          is told of), days paid, money pawned, knockouts, friends picked up, RV damage done driving, repairs
//   runs   the ids of the last 32 trips credited (a trip delivered twice counts once)
//   sum    an FNV-1a hash of the rest: it catches a torn write; it isn't anti-cheat (it's your save)
//
// Times: ROAD TIME is the game clock at each day's payment less 6:00, summed over the five days (a payment
// made by midnight's auto-pay counts 18 hours), shown as real time (45 s a game hour): paying at 2 PM every
// day is 40 game hours, 30:00.

export const PROFILE_V = 1;
export const MAX_BYTES = 64 * 1024;   // the most a save may take (a bigger one is refused, not trimmed)
export const ROAD_HOUR_SEC = 45;       // real seconds a game hour, for showing road time
const RUNS = 32, CREWS = 12, SEEDS = 20, NAMES = 6;
const TERMS = ['std', 'bad'];
export const LIFE = ['trips', 'wins', 'days', 'pawned', 'kos', 'revives', 'rvDmg', 'repairs'];

// ---- small checks ------------------------------------------------------------------------------------
const isObj = o => !!o && typeof o === 'object' && !Array.isArray(o);
// a number from a save: only a number or a numeric string counts (never converting an object, which can throw)
const toNum = v => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
const int = (v, lo, hi, d = lo) => { const x = Math.round(toNum(v)); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
const num = (v, lo, hi, d = lo) => { const x = toNum(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
const when = v => int(v, 0, 8.64e15, 0);
const name = v => (typeof v === 'string' ? v.replace(/[<>]/g, '').slice(0, 16) : '');
const names = v => (Array.isArray(v) ? v.slice(0, NAMES).map(name).filter(Boolean) : []);
export const isPid = v => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v);
export const isRun = v => typeof v === 'string' && /^[0-9a-f]{10}$/.test(v);
const hours = v => (v == null ? null : num(v, 0, 5 * 18, null));   // a road time, in game hours
const money = v => int(v, -1e9, 1e9, 0);

// FNV-1a, 32 bits, over the string's UTF-16 code units: 8 hex characters
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
// a crew, whoever's in it and in whatever order they joined: their hashed profile ids, sorted
export const crewKey = hashes => [...hashes].map(String).sort().join('.');

// ---- the shape ---------------------------------------------------------------------------------------
const board = () => ({ fast: null, splits: [null, null, null, null, null], haul: null, clean: null });
export function fresh(pid, now = 0) {
  return { v: PROFILE_V, pid, made: now, saved: now, rev: 0, best: { std: board(), bad: board() }, crews: [], seeds: [], life: Object.fromEntries(LIFE.map(k => [k, 0])), runs: [] };
}

function cleanBoard(b) {
  const o = board();
  if (!isObj(b)) return o;
  if (isObj(b.fast) && hours(b.fast.h) != null) o.fast = { h: hours(b.fast.h), at: when(b.fast.at), crew: names(b.fast.crew) };
  if (Array.isArray(b.splits)) for (let d = 0; d < 5; d++) { const s = b.splits[d]; if (isObj(s) && Number.isFinite(toNum(s.h))) o.splits[d] = { h: num(s.h, 6, 24), at: when(s.at) }; }
  if (isObj(b.haul)) o.haul = { sold: int(b.haul.sold, 0, 1e9), surplus: b.haul.surplus == null ? null : money(b.haul.surplus), casino: money(b.haul.casino), won: !!b.haul.won, at: when(b.haul.at) };
  if (isObj(b.clean)) o.clean = { hp: int(b.clean.hp, 0, 100), at: when(b.clean.at) };
  return o;
}
const cleanTally = (e, extra) => ({ ...extra, trips: int(e.trips, 0, 1e6), wins: int(e.wins, 0, 1e6), fast: hours(e.fast), haul: e.haul == null ? null : int(e.haul, 0, 1e9), at: when(e.at) });

// Everything a save may hold, checked field by field the way settings.js checks its own: unknown keys
// go, numbers are clamped, lists are cut to size. It never throws, whatever it's given; the pid it
// returns is null when the save had none worth keeping (the page makes one).
export function validate(o) {
  if (!isObj(o)) o = {};
  const p = fresh(isPid(o.pid) ? o.pid : null);
  p.made = when(o.made); p.saved = when(o.saved); p.rev = int(o.rev, 0, 1e9);
  if (isObj(o.best)) for (const k of TERMS) p.best[k] = cleanBoard(o.best[k]);
  if (Array.isArray(o.crews)) {
    p.crews = o.crews.filter(c => isObj(c) && typeof c.key === 'string' && /^[0-9a-f.]{8,200}$/.test(c.key))
      .slice(0, CREWS).map(c => cleanTally(c, { key: c.key, names: names(c.names) }));
  }
  if (Array.isArray(o.seeds)) {
    p.seeds = o.seeds.filter(s => isObj(s) && Number.isInteger(toNum(s.seed)) && toNum(s.seed) >= 0 && toNum(s.seed) <= 0xffffffff)
      .slice(0, SEEDS).map(s => cleanTally(s, { seed: toNum(s.seed) }));
  }
  if (isObj(o.life)) for (const k of LIFE) p.life[k] = int(o.life[k], 0, 1e12);
  if (Array.isArray(o.runs)) p.runs = [...new Set(o.runs.filter(isRun))].slice(-RUNS);
  return p;
}

// to the text written to disk (with its sum)
export function serialize(prof) {
  const rest = validate(prof);
  return JSON.stringify({ ...rest, sum: fnv1a(JSON.stringify(rest)) });
}

// from what's on disk: { prof, status } with status 'ok', 'empty' (nothing there: prof is null),
// 'corrupt' (unreadable, or its sum doesn't match: prof is null), or 'newer' (from a later version of the
// game: prof is what this version understands of it, to be shown but never written back)
export function parse(text) {
  if (text == null || text === '') return { prof: null, status: 'empty' };
  if (typeof text !== 'string' || text.length > MAX_BYTES) return { prof: null, status: 'corrupt' };
  let o;
  try { o = JSON.parse(text); } catch { return { prof: null, status: 'corrupt' }; }
  if (!isObj(o)) return { prof: null, status: 'corrupt' };
  if (toNum(o.v) > PROFILE_V) return { prof: validate(o), status: 'newer' };
  const { sum, ...rest } = o;
  let ok = false;
  try { ok = typeof sum === 'string' && fnv1a(JSON.stringify(rest)) === sum; } catch {}   // (thousands of brackets deep: too deep to sum)
  if (!ok) return { prof: null, status: 'corrupt' };
  const prof = validate(rest);
  return prof.pid ? { prof, status: 'ok' } : { prof: null, status: 'corrupt' };
}

// ---- a trip, credited ----------------------------------------------------------------------------------
// trip: the server's 'trip' message (server/room.js tripMsg). Returns { counted, dup, newRecords } and
// changes prof in place. The rules:
//   - a trip id seen before changes nothing (dup)
//   - practice 'test' (test levers, a fast clock, the wildlife off) records nothing, unless acceptTest
//     (the browser test's own forced wins)
//   - practice 'seed' (a typed menu seed) goes on that seed's board only
//   - the rest: the lifetime counters always; the records (fastest payoff, best splits, biggest haul,
//     cleanest delivery) and the crew's tally only when you were aboard when the RV left camp on day 1 and
//     still aboard at the end. A time record needs a win; the haul needs days 1-4 paid.
// newRecords: what this trip set: 'fast', 'haul', 'clean', 'split1'..'split5', 'crew'.
export function creditTrip(prof, trip, { acceptTest = false, now = 0 } = {}) {
  const res = { counted: false, dup: false, newRecords: [] };
  if (!isObj(trip) || !isRun(trip.run)) return res;
  if (prof.runs.includes(trip.run)) { res.dup = true; return res; }
  if (trip.practice === 'test' && !acceptTest) return res;
  prof.runs = [...prof.runs, trip.run].slice(-RUNS);
  res.counted = true;
  const won = !!trip.won, you = isObj(trip.you) ? trip.you : {};
  const whole = !!you.fromStart && !!you.atEnd;
  const paid = Array.isArray(trip.splits) ? trip.splits.slice(0, 5).map(h => (Number.isFinite(toNum(h)) ? num(h, 6, 24) : null)) : [];
  const days = paid.filter(h => h != null).length, first4 = paid.slice(0, 4).every(h => h != null) && paid.length >= 4;
  const time = won && days === 5 ? paid.reduce((a, h) => a + (h - 6), 0) : null;
  const sold = int(trip.sold, 0, 1e9);
  const record = k => res.newRecords.push(k);
  // (a tally: a crew's or a seed's)
  const tally = t => {
    t.trips++; if (won) t.wins++;
    if (time != null && (t.fast == null || time < t.fast)) t.fast = time;
    if (first4 && (t.haul == null || sold > t.haul)) t.haul = sold;
    t.at = now;
  };
  if (trip.practice === 'seed') {
    const seed = int(trip.seed, 0, 0xffffffff);
    let s = prof.seeds.find(x => x.seed === seed);
    if (!s) s = { seed, trips: 0, wins: 0, fast: null, haul: null, at: now };
    if (whole) tally(s); else { s.trips++; s.at = now; }
    prof.seeds = [s, ...prof.seeds.filter(x => x !== s)].slice(0, SEEDS);
    return res;
  }
  const L = prof.life;
  L.trips++; if (won && you.atEnd) L.wins++;
  L.days += days; L.pawned += sold;
  L.kos += int(you.kos, 0, 1e6); L.revives += int(you.revives, 0, 1e6); L.rvDmg += int(you.rvDmg, 0, 1e6);
  L.repairs += int(trip.repairs, 0, 1e9);
  if (!whole) return res;
  const b = prof.best[trip.tier === 'bad' ? 'bad' : 'std'];
  const crew = Array.isArray(trip.crew) ? trip.crew.filter(isObj) : [];
  if (time != null && (!b.fast || time < b.fast.h)) { b.fast = { h: time, at: now, crew: names(crew.map(c => c.name)) }; record('fast'); }
  paid.forEach((h, d) => { if (h != null && (!b.splits[d] || h < b.splits[d].h)) { b.splits[d] = { h, at: now }; record(`split${d + 1}`); } });
  if (first4 && (!b.haul || sold > b.haul.sold)) { b.haul = { sold, surplus: won ? money(trip.surplus) : null, casino: money(trip.casino), won, at: now }; record('haul'); }
  if (won && (!b.clean || int(trip.rvEnd, 0, 100) > b.clean.hp)) { b.clean = { hp: int(trip.rvEnd, 0, 100), at: now }; record('clean'); }
  // the crew: everyone aboard from day 1's departure to the end (a solo trip is a crew of one)
  const hs = crew.map(c => String(c.h || '')).filter(h => /^[0-9a-f]{8}$/.test(h));
  if (hs.length) {
    const key = crewKey(hs);
    let c = prof.crews.find(x => x.key === key);
    const before = c ? { fast: c.fast, haul: c.haul } : null;
    if (!c) c = { key, names: [], trips: 0, wins: 0, fast: null, haul: null, at: now };
    c.names = names(crew.map(x => x.name));
    tally(c);
    if (before && ((c.fast != null && c.fast !== before.fast) || (c.haul != null && c.haul !== before.haul))) record('crew');
    prof.crews = [c, ...prof.crews.filter(x => x !== c)].slice(0, CREWS);
  }
  return res;
}

// ---- for the screens -----------------------------------------------------------------------------------
// a road time (game hours) as real time: 40 h -> '30:00'; over an hour '1:02:30'
export function fmtRoad(h) {
  if (h == null) return '';
  const s = Math.round(h * ROAD_HOUR_SEC), hh = Math.floor(s / 3600), mm = Math.floor(s / 60) % 60, ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
// the game clock (hours since midnight) as '3:42 PM'
export function fmtClockH(h) {
  const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60 + 1e-6);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
}
// the crew board's row for these players (their hashed profile ids), if they've finished a trip together
export const crewBest = (prof, hashes) => (prof && hashes.length ? prof.crews.find(c => c.key === crewKey(hashes)) || null : null);
