// This player's save, on this machine (the rules are shared/profile.js). Loaded once when the page starts:
//   - the desktop build: save/profile.json in the game's folder (the shell reads it before the page runs and
//     writes it atomically: desktop/main.cjs); a bad file falls back to save/profile.bak.json, and the bad
//     one is moved into save/corrupt
//   - the browser: localStorage 'nmdProfile', falling back to 'nmdProfile.bak' (per browser and per server
//     address: the Garage's Save tab names it, and Export / Import move a save between them)
// It's written when a trip is credited (and when an import replaces it), never during play.
import { PROFILE_V, MAX_BYTES, fresh, parse, serialize, validate, creditTrip, isPid } from '/shared/profile.js';

const KEY = 'nmdProfile', BAK = 'nmdProfile.bak', BAD = 'nmdProfile.bad';
const DESK = window.desktop?.profile || null;
// status: 'ok' (saved here), 'fresh' (a new save, made now), 'bak' (the save was unreadable: restored from
// the backup), 'reset' (the save and its backup were unreadable: started over, the bad one kept aside),
// 'newer' (from a later version of the game: shown, never written), 'nostore' (this window can't keep one)
let prof = null, status = 'fresh', readOnly = false, lastError = '';

const randHex = n => {
  const a = new Uint8Array(n / 2);
  crypto.getRandomValues(a);
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('');
};
const ls = {
  get: k => { try { return localStorage.getItem(k); } catch { return undefined; } },
  set: (k, v) => { try { localStorage.setItem(k, v); return true; } catch { return false; } },
};

function load() {
  const boot = DESK?.boot || null;
  const mainText = DESK ? boot?.text ?? null : ls.get(KEY);
  if (mainText === undefined) { prof = fresh(randHex(16), Date.now()); status = 'nostore'; return; }
  const main = parse(mainText);
  if (main.status === 'ok') { prof = main.prof; status = 'ok'; return; }
  if (main.status === 'newer') { prof = main.prof; status = 'newer'; readOnly = true; if (!isPid(prof.pid)) prof.pid = randHex(16); return; }
  const bak = parse(DESK ? boot?.bak ?? null : ls.get(BAK));
  if (main.status === 'corrupt') {
    // the bad one is kept aside (the desktop shell moves it into save/corrupt)
    if (DESK) DESK.quarantine?.().catch?.(() => {});
    else ls.set(BAD, mainText);
  }
  if (bak.status === 'ok') { prof = bak.prof; status = main.status === 'corrupt' ? 'bak' : 'ok'; save(); return; }
  prof = fresh(randHex(16), Date.now());
  status = main.status === 'corrupt' ? 'reset' : 'fresh';
  save();   // (the profile id has to last: a trip's summary finds its player by it)
}

// write it (never a save from a newer version); false if it couldn't be
export function save() {
  if (readOnly || !prof) return false;
  prof.saved = Date.now(); prof.rev++;
  const text = serialize(prof);
  if (text.length > MAX_BYTES) { lastError = 'too big'; return false; }
  if (DESK) {
    DESK.save(text).then(r => { if (r && r.ok === false) { lastError = r.msg || 'not saved'; console.warn('profile not saved:', lastError); } }, e => { lastError = e.message; });
    return true;
  }
  const old = ls.get(KEY);
  if (old) ls.set(BAK, old);
  if (!ls.set(KEY, text)) { lastError = 'storage full or blocked'; status = 'nostore'; return false; }
  return true;
}

export const profile = () => prof;
export const profileStatus = () => ({ status, readOnly, error: lastError, desktop: !!DESK, where: DESK ? 'this PC' : location.host });
// what the host's server is told of it (shared/profile.js says why no more)
export const forServer = () => ({ v: PROFILE_V, pid: prof.pid, wins: prof.life.wins });

// a trip's summary from the server: into the save. Returns creditTrip's answer ({ counted, dup, newRecords })
export function credit(trip, { acceptTest = false } = {}) {
  if (readOnly) return { counted: false, dup: false, newRecords: [] };
  const r = creditTrip(prof, trip, { acceptTest, now: Date.now() });
  if (r.counted) save();
  return r;
}

// Export / Import: the whole save as one line of text to copy and paste (base64 of what's on disk)
export function exportCode() {
  const bytes = new TextEncoder().encode(serialize(prof));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return 'NMD1.' + btoa(bin);
}
// -> { ok, msg }: a pasted code replaces this save (the old one stays as the backup)
export function importCode(code) {
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
  if (!save()) return { ok: false, msg: 'This window can\'t keep a save.' };
  status = 'ok';
  return { ok: true, msg: 'Save imported.' };
}

load();
