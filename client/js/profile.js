// This player's save, on this machine (the rules are shared/profile.js). Loaded once when the page starts:
//   - the desktop build: save/profile.json in the game's folder (the shell reads it before the page runs and
//     writes it atomically: desktop/main.cjs); a bad file falls back to save/profile.bak.json, and the bad
//     one is moved into save/corrupt
//   - the browser: localStorage 'nmdProfile', falling back to 'nmdProfile.bak' (per browser and per server
//     address: the Garage's Save tab names it, and Export / Import move a save between them)
// It's written when a trip is credited, a pick is spent or the Garage's kit changes (and when an import
// replaces it), never during play.
import { PROFILE_V, MAX_BYTES, fresh, parse, serialize, validate, creditTrip, isPid, kitFor, spendPick, setKit, addLooks, cleanLooks } from '/shared/profile.js';

const KEY = 'nmdProfile', BAK = 'nmdProfile.bak', BAD = 'nmdProfile.bad';
const DESK = window.desktop?.profile || null;
// status: 'ok' (saved here), 'fresh' (a new save, made now), 'bak' (the save was unreadable: restored from
// the backup), 'reset' (the save and its backup were unreadable: started over, the bad one kept aside),
// 'newer' (from a later version of the game: shown, never written), 'nostore' (this window can't keep one)
let prof = null, status = 'fresh', readOnly = false, lastError = '';
let unsaved = false;     // the last write failed: the next trip summary (even one already counted) writes again
let newerText = null;    // a save from a later version, exactly as read (Export hands that out, not our cut of it)

const randHex = n => {
  const a = new Uint8Array(n / 2);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
};
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return undefined; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};

function load() {
  const boot = DESK?.boot || null;
  const mainText = DESK ? boot?.text ?? null : ls.get(KEY);
  if (mainText === undefined) { prof = fresh(randHex(16), Date.now()); status = 'nostore'; return; }
  const main = parse(mainText);
  if (main.status === 'ok') { prof = main.prof; status = 'ok'; return; }
  if (main.status === 'newer') { prof = main.prof; status = 'newer'; readOnly = true; newerText = mainText; if (!isPid(prof.pid)) prof.pid = randHex(16); return; }
  const bak = parse(DESK ? boot?.bak ?? null : ls.get(BAK));
  if (main.status === 'corrupt') {
    // the bad one is kept aside (the desktop shell moves it into save/corrupt)
    if (DESK) DESK.quarantine?.().catch?.(() => {});
    else { ls.set(BAD, mainText); ls.del(KEY); }   // (so the write below doesn't make it the backup)
  }
  if (bak.status === 'ok') { prof = bak.prof; status = main.status === 'corrupt' ? 'bak' : 'ok'; save(); return; }
  prof = fresh(randHex(16), Date.now());
  status = main.status === 'corrupt' ? 'reset' : 'fresh';
  save();   // (the profile id has to last: a trip's summary finds its player by it)
}

// write it (never a save from a newer version) -> a promise of whether it's on the disk (or in the browser's
// storage) now
export function save() {
  if (readOnly || !prof) return Promise.resolve(false);
  prof.saved = Date.now(); prof.rev++;
  const text = serialize(prof);
  const done = ok => { unsaved = !ok; if (ok) lastError = ''; else console.warn('profile not saved:', lastError); return ok; };
  if (text.length > MAX_BYTES) { lastError = 'too big'; return Promise.resolve(done(false)); }
  if (DESK) {
    return DESK.save(text).then(r => {
      if (r && r.ok === false) lastError = r.msg || 'not saved';
      return done(!(r && r.ok === false));
    }, e => { lastError = e?.message || 'not saved'; return done(false); });
  }
  const old = ls.get(KEY);
  if (old) ls.set(BAK, old);
  if (!ls.set(KEY, text)) { lastError = 'storage full or blocked'; status = 'nostore'; return Promise.resolve(done(false)); }
  return Promise.resolve(done(true));
}

export const profile = () => prof;
export const profileStatus = () => ({ status, readOnly, error: lastError, desktop: !!DESK, where: DESK ? 'this PC' : location.host });
// what the host's server is told of it (shared/profile.js says why no more)
export const forServer = () => ({ v: PROFILE_V, pid: prof.pid, wins: prof.life.wins, kit: kitFor(prof), looks: prof.looks });
// the kit's levels, as the host's server is told them (the Garage's KIT tab, a pick, a trip's unlocks)
export const myKit = () => kitFor(prof);

// the Garage: spend a pick on a card, or change what you take -> whether it changed (and is being saved)
export function spend(id) {
  if (readOnly || !spendPick(prof, id)) return false;
  save();
  return true;
}
export function changeKit(k) {
  if (readOnly) return false;
  const before = JSON.stringify(prof.kit);
  setKit(prof, k);
  if (JSON.stringify(prof.kit) === before) return false;
  save();
  return true;
}

// looks (shared/looks.js): what the crew has unlocked comes into this save for good; what I wear and the RV's
// paint, as I last chose them (written only when they change)
export function unlockLooks(ids) { if (!readOnly && addLooks(prof, ids)) save(); }
export function keepLook({ wear, rv } = {}) {
  if (readOnly) return;
  const before = JSON.stringify(prof.looks);
  prof.looks = cleanLooks({ ...prof.looks, ...(wear !== undefined ? { wear } : {}), ...(rv !== undefined ? { rv } : {}) });
  if (JSON.stringify(prof.looks) !== before) save();
}

// a trip's summary from the server: into the save. Returns creditTrip's answer ({ counted, dup, newRecords })
// and saved: a promise of whether the save has it now (the page tells the server it has the summary only then)
export function credit(trip, { acceptTest = false } = {}) {
  if (readOnly) return { counted: false, dup: false, newRecords: [], saved: Promise.resolve(true) };
  const r = creditTrip(prof, trip, { acceptTest, now: Date.now() });
  // (one already counted whose write failed: it's in the save in memory, this writes it again)
  r.saved = r.counted || unsaved ? save() : Promise.resolve(true);
  return r;
}

// Export / Import: the whole save as one line of text to copy and paste (base64 of what's on disk)
export function exportCode() {
  const bytes = new TextEncoder().encode(status === 'newer' && newerText ? newerText : serialize(prof));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'NMD1.' + btoa(bin);
}
// -> a promise of { ok, msg }: a pasted code replaces this save (the old one stays as the backup)
export async function importCode(code) {
  const s = String(code || '').trim().replace(/\s+/g, '');
  if (!s.startsWith('NMD1.')) return { ok: false, msg: 'That isn\'t a save code. It starts with NMD1.' };
  let text;
  try { const bin = atob(s.slice(5)); text = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }
  catch { return { ok: false, msg: 'That code is cut short or garbled. Copy all of it.' }; }
  const r = parse(text);
  if (r.status === 'newer') return { ok: false, msg: 'That save is from a newer version of the game. Update this one first.' };
  if (r.status !== 'ok') return { ok: false, msg: 'That code is cut short or garbled. Copy all of it.' };
  if (readOnly) return { ok: false, msg: 'This save is from a newer version of the game: update the game first.' };
  prof = validate(r.prof);
  if (!(await save())) return { ok: false, msg: DESK ? `It couldn't be saved (${lastError}).` : 'This window can\'t keep a save.' };
  status = 'ok';
  return { ok: true, msg: 'Save imported.' };
}

load();
