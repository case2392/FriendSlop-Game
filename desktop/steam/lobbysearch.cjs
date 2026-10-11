'use strict';
// Finding a trip by its code: a Steam lobby search for lobbies whose data says nmd_code = the code,
// anywhere in the world (the host's lobby is Public, so searches list it: host.cjs).
//
// steamworks.js 0.4.0's matchmaking.getLobbies() takes no filters, but Steam keeps lobby-list filters on
// the ISteamMatchmaking interface until the next RequestLobbyList, which is the call getLobbies() makes.
// So the filters go in through Steam's own flat API, called with koffi on the very steam_api library
// steamworks.js loaded (dlopen/LoadLibrary hand back the copy already in the process), right before
// getLobbies(), one search at a time. Every result is checked again here, so a filter Steam didn't apply
// can only mean "not found", never a wrong trip; without the FFI, the search still works unfiltered
// (Steam's default: up to 50 lobbies in nearby regions).
//
// The fake Steam (test/fakesteam) hands in filters with the same three methods, so tests run this logic.
//   ffiFilters()                                     -> { stringFilter, distanceFilter, resultCountFilter } | null
//   findLobbies(client, filters, key, value, opts)   -> { lobbies, filtered, seen }   (rejects on timeout)
//   findTripByCode(client, filters, code, opts)      -> { ok, lobbyId, hostName } | { ok: false, code, msg }
//   pickFreeCode(client, filters, draw, opts)        -> a code no open trip on Steam carries (best effort)
const path = require('node:path');

const EQUAL = 0;        // ELobbyComparison::k_ELobbyComparisonEqual
const WORLDWIDE = 3;    // ELobbyDistanceFilter::k_ELobbyDistanceFilterWorldwide
let ffi;                // undefined: not tried yet; null: unavailable (ffiError says why)
let ffiError = null;

// the Steam library next to steamworks.js's addon (the one its addon links against); never inside
// app.asar, which LoadLibrary/dlopen can't read
function steamLibrary() {
  const [dir, file] = process.platform === 'win32' ? ['win64', 'steam_api64.dll'] : process.platform === 'darwin' ? ['osx', 'libsteam_api.dylib'] : ['linux64', 'libsteam_api.so'];
  return path.join(path.dirname(require.resolve('steamworks.js')), 'dist', dir, file).replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

// Call ONLY after steamworks.js init() succeeded: the interface pointer is null before, and a null self
// crashes inside steam_api, taking the main process with it (hence the check on every call).
function ffiFilters() {
  if (ffi === undefined) {
    try {
      const koffi = require('koffi'), lib = koffi.load(steamLibrary());
      const f = {
        mm: lib.func('void *SteamAPI_SteamMatchmaking_v009()'),
        str: lib.func('void SteamAPI_ISteamMatchmaking_AddRequestLobbyListStringFilter(void *self, const char *key, const char *value, int cmp)'),
        dist: lib.func('void SteamAPI_ISteamMatchmaking_AddRequestLobbyListDistanceFilter(void *self, int filter)'),
        count: lib.func('void SteamAPI_ISteamMatchmaking_AddRequestLobbyListResultCountFilter(void *self, int max)'),
      };
      const self = () => { const p = f.mm(); if (p == null) throw new Error('Steam matchmaking is not ready.'); return p; };
      ffi = {
        stringFilter: (key, value, cmp = EQUAL) => f.str(self(), String(key), String(value), cmp),
        distanceFilter: d => f.dist(self(), d),
        resultCountFilter: n => f.count(self(), n),
      };
    } catch (e) { ffi = null; ffiError = e; }
  }
  return ffi;
}

const withTimeout = (p, ms, msg) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(Object.assign(new Error(msg), { code: 'search' })), ms);
  p.then(v => { clearTimeout(t); res(v); }, e => { clearTimeout(t); rej(e); });
});

// lobby data, safely: getFullData() can't panic on bad UTF-8 the way getData() can
function lobbyData(l) { try { return l.getFullData() || {}; } catch { return {}; } }

// Filters are process-wide and used up by the next RequestLobbyList, and a new RequestLobbyList cancels
// one in flight (its promise would never settle): one search at a time.
let queue = Promise.resolve();
function findLobbies(client, filters, key, value, { max = 10, timeoutMs = 15000, log = () => {} } = {}) {
  const run = queue.then(async () => {
    let filtered = false;
    if (filters) {
      try { filters.stringFilter(key, value, EQUAL); filters.distanceFilter(WORLDWIDE); filters.resultCountFilter(max); filtered = true; }
      catch (e) { log(`[steam] lobby search filters not set (${e.message}): searching nearby lobbies only`); }
    }
    const list = await withTimeout(client.matchmaking.getLobbies(), timeoutMs, 'Steam took too long to answer. Try again.');
    const lobbies = (list || []).map(l => ({ lobby: l, data: lobbyData(l) })).filter(x => x.data[key] === value);
    return { lobbies, filtered, seen: (list || []).length };
  });
  queue = run.catch(() => {});
  return run;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The trip a typed code belongs to: lobbies whose nmd_code is the code, minus your own. A trip that has
// only just opened can take a moment to show up in searches, so an empty answer gets a second look. Two
// trips on one code (rare: the host checks first): the one on this game's version, then the newest.
async function findTripByCode(client, filters, code, { me = '', build = '', retryMs = 1500, timeoutMs = 15000, log = () => {} } = {}) {
  let found = [], mine = false;
  for (let attempt = 0; attempt < 2 && !found.length; attempt++) {
    if (attempt) await sleep(retryMs);
    const r = await findLobbies(client, filters, 'nmd_code', code, { timeoutMs, log });
    found = r.lobbies.filter(x => x.data.host !== me);
    mine = r.lobbies.length > found.length;
    log(`[steam] trip code ${code}: ${r.lobbies.length} lobby(s) of ${r.seen} listed${r.filtered ? '' : ' (unfiltered: nearby lobbies only)'}`);
  }
  if (!found.length) {
    return mine ? { ok: false, code: 'self', msg: 'That\'s your own trip\'s code.' }
      : { ok: false, code: 'noroom', msg: `No trip with code ${code}. Check the number with your friend. (A full trip doesn't show up either.)` };
  }
  found.sort((a, b) => (b.data.build === build) - (a.data.build === build) || Number(b.data.since || 0) - Number(a.data.since || 0));
  return { ok: true, lobbyId: String(found[0].lobby.id), hostName: String(found[0].data.name || ''), matches: found.length };
}

// Hosting: a code that no open trip on Steam carries right now (draw() makes a candidate). A search that
// fails or takes too long just takes its code: the joiner's side copes with two trips on one code.
async function pickFreeCode(client, filters, draw, { tries = 3, timeoutMs = 5000, log = () => {} } = {}) {
  for (let i = 0; i < tries; i++) {
    const code = draw();
    try {
      const r = await findLobbies(client, filters, 'nmd_code', code, { timeoutMs, log });
      if (!r.lobbies.length) return code;
      log(`[steam] trip code ${code} is in use on Steam: drawing another`);
    } catch (e) { log('[steam] checking a trip code:', e.message); return code; }
  }
  return draw();
}

module.exports = { ffiFilters, findLobbies, findTripByCode, pickFreeCode, steamLibrary, lobbyData, ffiError: () => ffiError, EQUAL, WORLDWIDE };
