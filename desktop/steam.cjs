'use strict';
// Steam through steamworks.js, in the main process only. Everything is guarded: with no Steam client
// running, no steamworks.js, or --no-steam, start() returns { ok: false, reason } and the game runs on
// its own (solo). NEVER call a steamworks.js API after a failed init(): its native side unwraps the
// missing client and panics, which takes the whole main process down.
const path = require('node:path');
const fs = require('node:fs');

const TEST_APP = 480;          // Spacewar: Valve's public test app (any Steam account can use it)

function start({ enabled = true, appId = TEST_APP, log = console.log, packaged = false } = {}) {
  const S = { ok: false, reason: 'Steam is switched off (--no-steam).', restarting: false, client: null, sw: null, onJoin: null, ready: Promise.resolve() };
  S.info = () => (S.ok
    ? { ok: true, appId: safe(() => S.client.utils.getAppId()), name: safe(() => S.client.localplayer.getName()),
        steamId: safe(() => String(S.client.localplayer.getSteamId().steamId64)), deck: safe(() => S.client.utils.isSteamRunningOnSteamDeck()) }
    : { ok: false, reason: S.reason });
  S.shutdown = () => {};
  if (!enabled) return S;
  // tests (never a packaged build): test/fakesteam stands in for the Steam client
  if (process.env.NMD_FAKE_STEAM && !packaged) {
    S.ready = import(path.join(__dirname, '../test/fakesteam/client.mjs')).then(async fake => {
      S.client = await fake.initFakeSteam({ port: Number(process.env.NMD_FAKE_STEAM), steamId: BigInt(process.env.NMD_FAKE_ID || '76561190000000001'), name: process.env.NMD_FAKE_NAME || 'Tester' });
      S.ok = true; S.reason = '';
      log('[steam] the fake Steam is up', JSON.stringify(S.info()));
      S.client.callback.register(fake.SteamCallback.GameLobbyJoinRequested, v => { log('[steam] join requested: lobby', String(v.lobby_steam_id)); S.onJoin?.(String(v.lobby_steam_id)); });
    }).catch(e => { S.reason = 'The fake Steam did not start.'; log('[steam] fake Steam failed:', e.message); });
    return S;
  }

  let sw;
  try { sw = require('steamworks.js'); }
  catch (e) { S.reason = 'Steam support did not load.'; log('[steam] steamworks.js did not load:', e.message); return S; }
  S.sw = sw;
  // Steam sets SteamAppId for a game it starts: then init() takes the App ID from there
  const fromSteam = Number(process.env.SteamAppId) || null;
  // A release build started from its .exe (not through Steam): Steam starts it again, properly, and this
  // copy quits. Never for the test app: restartAppIfNecessary(480) would start Valve's Spacewar. Not with
  // steam_appid.txt beside the executable (a developer's build) either.
  const devFile = fs.existsSync(path.join(path.dirname(process.execPath), 'steam_appid.txt'));
  if (packaged && !fromSteam && appId && appId !== TEST_APP && !devFile) {
    try { if (sw.restartAppIfNecessary(appId)) { log('[steam] not started by Steam: asking Steam to start the game'); S.restarting = true; return S; } }
    catch (e) { log('[steam] restartAppIfNecessary failed:', e.message); }
  }
  const t0 = Date.now();
  try {
    S.client = sw.init(fromSteam ? undefined : appId);
    S.ok = true; S.reason = '';
  } catch (e) {
    S.reason = 'Steam isn\'t running, so friends can\'t join. Start Steam, then the game.';
    log(`[steam] init failed after ${Date.now() - t0} ms: ${e?.message || e}`);
    return S;
  }
  log('[steam] ready', JSON.stringify(S.info()));
  // the overlay: Chromium needs its GPU in this process and a repaint every frame (before 'ready')
  try { sw.electronEnableSteamOverlay(); } catch (e) { log('[steam] the overlay could not be set up:', e.message); }
  // a friend's invite accepted (or Join Game in the friends list) while the game is running
  try {
    S.client.callback.register(sw.SteamCallback.GameLobbyJoinRequested, v => {
      const id = String(v.lobby_steam_id);
      log('[steam] join requested: lobby', id);
      S.onJoin?.(id);
    });
  } catch (e) { log('[steam] the join callback could not be registered:', e.message); }
  return S;
}

function safe(fn) { try { return fn(); } catch { return null; } }

module.exports = { start };
