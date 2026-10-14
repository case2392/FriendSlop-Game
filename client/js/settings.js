// The player's settings: one object in localStorage ('nmdSettings'), changed in the Settings panel and
// applied live by whoever listens (main.js, audio.js, gfx.js). Every value is checked against SPEC on
// the way in, so a hand-edited or old save can't break anything.
const KEY = 'nmdSettings';

// [default, kind, ...range or choices]
const SPEC = {
  sens: [1, 'num', 0.2, 3],                 // mouse sensitivity (x 0.0022 rad per pixel)
  invertY: [false, 'bool'],
  fov: [74, 'num', 60, 100],                 // degrees (sprinting adds 6)
  headBob: [true, 'bool'],                  // the view bobs a little as you walk, dips as you land
  master: [0.8, 'num', 0, 1],                // volumes: the bus gain is the square
  music: [0.5, 'num', 0, 1],
  sfx: [0.8, 'num', 0, 1],
  amb: [0.7, 'num', 0, 1],
  voice: [1, 'num', 0, 1],
  voiceMode: ['open', 'pick', 'open', 'ptt'],   // your mic: open (it sends while you talk) or push-to-talk (V)
  muteInBackground: [true, 'bool'],
  score: [true, 'bool'],                     // the score under the game (score.js)
  radio: [true, 'bool'],                     // the RV's radio plays while someone drives
  quality: ['auto', 'pick', 'auto', 'low', 'medium', 'high'],
  fpsCap: [0, 'pick', 0, 30, 60, 120],       // 0 = the display's own rate
  uiScale: [1, 'num', 0.8, 1.6],             // times the size picked for the window's height
  tutorial: [true, 'bool'],                  // first-trip hints in the quest tracker
};
export const DEFAULTS = Object.fromEntries(Object.entries(SPEC).map(([k, s]) => [k, s[0]]));

function clean(k, v) {
  const s = SPEC[k];
  if (!s) return undefined;
  if (s[1] === 'bool') return typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined;
  if (s[1] === 'num') { const x = Number(v); return Number.isFinite(x) ? Math.max(s[2], Math.min(s[3], x)) : undefined; }
  if (s[1] === 'pick') { const opts = s.slice(2); const hit = opts.find(o => String(o) === String(v)); return hit; }
  return undefined;
}

function load() {
  const out = { ...DEFAULTS };
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch {}
  if (saved && typeof saved === 'object') for (const k of Object.keys(SPEC)) { const v = clean(k, saved[k]); if (v !== undefined) out[k] = v; }
  else {
    // the settings that existed before this file: the mouse slider and the voice volume
    try {
      const sens = clean('sens', localStorage.getItem('nmdSens'));
      if (sens !== undefined && localStorage.getItem('nmdSens') != null) out.sens = sens;
      const vv = JSON.parse(localStorage.getItem('slopVoice.masterVol') || 'null');
      if (vv != null) out.voice = clean('voice', vv) ?? out.voice;
    } catch {}
  }
  return out;
}

export const settings = load();
const listeners = new Set();
export function onSettings(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} }
export function setSetting(k, v) {
  const x = clean(k, v);
  if (x === undefined || settings[k] === x) return;
  settings[k] = x;
  save();
  for (const fn of listeners) { try { fn(k, x); } catch (e) { console.error(e); } }
}
export function resetSettings() { for (const k of Object.keys(SPEC)) setSetting(k, DEFAULTS[k]); }
export const settingSpec = k => SPEC[k];
