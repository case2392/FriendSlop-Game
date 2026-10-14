// NO MONEY DOWN — client entry.
import * as C from '/shared/constants.js';
import { generateLeg, BIOME_BY_DAY, BIOMES } from '/shared/world.js';
import { LOOT, fmt$ } from '/shared/loot.js';
import { RV_DIM, RV_SEATS, RV_HATCH, toWorld, toLocal, insideRV, qYaw } from '/shared/rv.js';
import { isTripCode, normalizeTripCode, tripCodeIn, tripCodeError } from '/shared/tripcode.js';
import * as net from './net.js';
import * as voice from './voice.js';
import { initAudio, sfx, setLoops, at as sfxAt } from './sfx.js';
import { THREE, initGfx, scene, camera, renderer, render, setTimeOfDay, updateSun, setBiome, labelSprite, flat, setRenderQuality, guessQuality, gpuName } from './gfx.js';
import { settings, setSetting, onSettings, resetSettings, settingSpec } from './settings.js';
import { audioCtx, bus, panner, setListener } from './audio.js';
import { updateAmbience, quietAmbience } from './ambience.js';
import { createRadio } from './music.js';
import { setClutterQuality } from './terrain3d.js';
import { initPhys, LocalWorld, G } from './phys.js';
import { Me } from './player.js';
import { Interp } from './interp.js';
import { buildWorld, updateWorld } from './world3d.js';
import { RVView } from './rv3d.js';
import { buildProp, mapCanvas, prewarm as prewarmProps, setBeaconRange, beaconRange } from './props3d.js';
import { kitMods, PERKS, PARTS, ROMAN } from '/shared/garage.js';
import { buildMob } from './mobs3d.js';
import { RST, GST, RT, ST_MASK, ST_CARRY } from '/shared/mobs.js';
import { PlayerView, Hands, prewarmPlayer } from './people.js';
import { zoneText, uiText, portraitAttrs } from './labels.js';
import * as texPrep from './texprep.js';
import { keyName, keyLabel, keysIn, relabelPage } from './keys.js';
import { profile, profileStatus, forServer, credit, myKit } from './profile.js';
import { initGarage, renderGarage, garageOpen, recordLines } from './garage.js';
import { cardHTML } from './cards.js';
import { TINS } from '/shared/cards.js';
import { fmtRoad, fmtClockH, crewBest } from '/shared/profile.js';

const $ = id => document.getElementById(id);
const S = window.__nmd = {
  selfId: null, code: null, meta: null, g: null, W: null, lw: null, wv: null,
  door: false, phase: 'menu',
  props: new Map(), views: new Map(), interp: new Interp(), me: new Me(),
  rv: null, hook: null, gatesOpen: new Set(), seq: 0, odoStart: 0,
};
const me = S.me;
let rvView = null, hands = null;
let locked = false;
const isLocked = () => locked || !!S.forceLock;   // tests flip forceLock (headless has no pointer lock)
let lastPose = 0;
const keys = {};
const inp = { f: 0, r: 0, jump: false, sprint: false, crouch: false, grab: false };
let target = null;            // what the crosshair is on
let reviveT = 0;
let fixHeld = false;   // holding E at the engine hatch (the server counts the seconds: room.js fixStep)
let mapRaised = true;
let lastWalkieTx = new Set();
let worldBuilding = false;

// ---- boot ---------------------------------------------------------------------------

// a game that can't start 3D (a blocklisted or broken driver, an old GPU) says so, instead of sitting on
// its menu with buttons that do nothing
function fatal(title, body) {
  $('loading').classList.add('hidden');
  const el = document.createElement('div');
  el.className = 'panel parchment net-modal';
  el.innerHTML = `<h2>${title}</h2><p>${body}</p>`;
  document.body.appendChild(el);
  window.desktop?.log?.('fatal', title, body);
}
try { initGfx($('canvas')); }
catch (e) {
  fatal('Your graphics couldn\'t start 3D', 'NO MONEY DOWN needs WebGL 2. Update your graphics driver, and on a laptop run the game on the dedicated GPU. If it still fails, set the Steam launch option <b>--use-angle=gl</b> (or <b>d3d11</b>, <b>vulkan</b>).');
  throw e;
}
const physReady = initPhys().then(() => { if (!worldBuilding) $('loading').classList.add('hidden'); }, e => { fatal('The physics engine couldn\'t start', String(e?.message || e)); throw e; });
// errors: logged (the desktop build keeps a log file), and after a few a word to the player
let pageErrors = 0;
const noteError = msg => {
  window.desktop?.log?.('page error', msg);
  if (++pageErrors === 3) setTimeout(() => toast('Something went wrong in the game. If it misbehaves, restart it.', '#ff8a80', 6));
};
window.addEventListener('error', e => noteError(String(e.message)));
window.addEventListener('unhandledrejection', e => noteError(String(e.reason?.message || e.reason)));
// the GPU driver reset (or the context was taken away): three.js rebuilds everything once it's back
$('canvas').addEventListener('webglcontextlost', e => { e.preventDefault(); S.gpuLost = true; connOverlay('Graphics driver reset — recovering…'); });
$('canvas').addEventListener('webglcontextrestored', () => { S.gpuLost = false; connOverlay(null); });
// the paint workers and the texture cache's source hashes, once the page has loaded (texprep.js); while
// the menu is up they get the first day's textures ready (a trip starts on day 1), all off this thread
// (the few the page must paint itself only in long idle stretches while nobody is typing or moving the
// mouse: a mouse on the move is on its way to a button, and a paint started then could hold up the click)
let lastInput = 0;
for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel']) window.addEventListener(ev, () => { lastInput = performance.now(); }, { capture: true, passive: true });
const titleDone = () => !!document.documentElement.dataset.menuArt;   // labels.js: the title screen is painted
const menuIdle = () => (S.phase !== 'menu' || S.W ? null : titleDone() && !document.hidden && performance.now() - lastInput > 2000);
// Started once the title screen has finished painting (labels.js marks it with data-menu-art) or 2 s
// after load, whichever is first, or as soon as a trip starts (prepare() starts them itself).
let texPrepStarted = false;
const startTexPrep = () => {
  if (texPrepStarted) return;
  texPrepStarted = true;
  texPrep.init().then(() => { if (S.phase === 'menu' && !S.W) texPrep.prepare(texPrep.dayList(BIOME_BY_DAY[0]), { prio: 2, page: 'idle', idleOk: menuIdle }).then(() => texPrep.flush()); });
};
const t0Boot = performance.now();
const waitTitle = () => { if (texPrepStarted) return; if (titleDone() || S.phase !== 'menu' || performance.now() - t0Boot > 2000) startTexPrep(); else setTimeout(waitTitle, 250); };
if (document.readyState === 'complete') waitTitle(); else window.addEventListener('load', waitTitle, { once: true });
S.texCache = { idle: texPrep.idle, stats: texPrep.stats, pagePainted: texPrep.pagePainted };
S.texRecording = () => texPrep.recorded() !== null;
rvView = new RVView(scene);
hands = new Hands(camera, '#7CFC00');
setTimeOfDay(9);
camera.position.set(0, 30, -120);
camera.lookAt(0, 0, 100);

$('nameInput').value = localStorage.getItem('nmdName') || window.desktop?.steam?.name || '';
const myName = () => { const n = $('nameInput').value.trim() || 'Blob'; localStorage.setItem('nmdName', n); return n; };
// what the last trip left to say (the host ended it, you left it), on the fresh menu
try { const note = sessionStorage.getItem('nmdMenuNote'); if (note) { $('menuError').textContent = note; sessionStorage.removeItem('nmdMenuNote'); } } catch {}
const BUILD = () => window.desktop?.build ?? null;   // the desktop build checks it runs the same game as the host
// a seat to come back to: the server's resume token for this trip (kept for this tab's session)
const savedSession = code => { try { const s = JSON.parse(sessionStorage.getItem('nmdSession') || 'null'); return s && s.code === code ? s.token : null; } catch { return null; } };

// ---- the desktop build (the one on Steam) ----------------------------------------------------------
// A trip is hosted on the player's own PC. Friends come in by typing its 4-digit trip code under Join
// Game (the shell finds the trip on Steam), from a Steam invite, or with Join Game in their friends list.
// Without Steam running it plays solo.
const DESK = window.desktop || null;
const STEAM = DESK?.steam?.ok ? DESK.steam : null;
// the menu's small print: the version (the build fingerprint after the + is what friends must share)
const showVersion = build => { if (build) $('versionLabel').textContent = `Version ${build.split('+')[0]} (build ${build.split('+')[1] || '?'})`; };
showVersion(DESK?.build);
relabelPage();   // the help page's and the hints' key names, in the player's keyboard layout
if (DESK) {
  $('quitBtn').classList.remove('hidden');
  $('quitBtn').onclick = () => DESK.quit();
  $('ctpQuit').classList.remove('hidden');
  $('menuSteam').classList.remove('hidden');
  $('menuSteam').textContent = STEAM
    ? `On Steam as ${STEAM.name || 'you'}. Host a game and read out your 4-digit trip code: friends type it under Join Game. Steam invites work too.`
    : `${DESK.steam?.reason || 'Steam isn\'t running, so friends can\'t join.'} You can still drive solo.`;
}
// friends can join once the trip is up: a Steam lobby that carries the trip code
async function startHosting(code) {
  if (!STEAM) return;
  const r = await DESK.host(code).catch(e => ({ ok: false, msg: e.message }));
  if (r?.ok) { S.lobbyId = r.lobby || null; $('ctpInvite').classList.remove('hidden'); showTripCode(code); announceCode(code); }
  else toast(`Friends can't join this trip: ${r?.msg || 'Steam said no.'}`, '#ffb4a2', 6);
}
// the trip code, where the crew can read it: the HUD's chip (click: copy) and the Esc card
function showTripCode(code) {
  if (!isTripCode(code)) return;
  $('hCode').innerHTML = `<span class="k">Trip code</span>${escapeHtml(code)}`;
  $('hCode').title = 'Your trip code: friends click Join Game and type it in. Click to copy.';
  $('hCode').classList.remove('hidden');
  $('ctpCodeNum').textContent = code;
  $('ctpCode').classList.remove('hidden');
}
// the host hears their code once the first day is up and its zone text has faded (a toast during the
// load or under the zone text would go unseen); it stays on the HUD and the Esc card
function announceCode(code) {
  const t0 = performance.now();
  const k = setInterval(() => {
    if (S.phase !== 'game' || S.tripOver || performance.now() - t0 > 180000) { clearInterval(k); return; }
    if (!S.W || worldBuilding) return;
    clearInterval(k);
    setTimeout(() => { if (S.phase === 'game' && S.code === code) toast(`Your trip code is ${code}. Friends click Join Game and type it in. (It's on the Esc menu too.)`, '#7CFC00', 12); }, 8000);
  }, 500);
}
const menuStatus = text => { $('menuStatus').textContent = text || ''; };
async function inviteFriends() {
  if (!STEAM) return;
  document.exitPointerLock?.();
  const r = await DESK.invite().catch(e => ({ ok: false, msg: e.message }));
  if (!r?.ok) toast(r?.msg || 'Steam\'s invite window didn\'t open. Invite them from your Steam friends list instead.', '#ffb4a2', 5);
}
// a friend's trip, from an invite or Join Game (a lobby id) or from its trip code (a Steam search): the
// lobby, then the bridge to the host's game, which the page connects to as if it were a server. The
// menu stays busy until the shell answers (it gives up by itself: about a minute at the most).
const joinFriend = id => joinViaSteam(() => DESK.joinLobby(id), 'Joining your friend\'s trip…');
async function joinViaSteam(find, status) {
  if (!STEAM || S.phase !== 'menu' || $('hostBtn').disabled) return false;
  const my = ++attempt, stale = () => my !== attempt || S.phase !== 'menu';
  initAudio();
  menuBusy('joinBtn', 120000);
  $('menuError').textContent = ''; menuStatus(status);
  const r = await find().catch(e => ({ ok: false, msg: e.message }));
  if (stale()) return false;                  // given up on: the shell moves on with the next thing asked
  if (!r?.ok) { menuBusy(null); menuStatus(''); $('menuError').textContent = r?.msg || 'Couldn\'t join that trip.'; return false; }
  menuStatus(`Joining ${r.hostName || 'your friend'}'s trip…`);
  menuBusy('joinBtn', 20000);
  await physReady;
  try { await net.connect(r.wsUrl); }
  catch (e) { if (!stale()) { menuBusy(null); menuStatus(''); $('menuError').textContent = e.message; DESK.leave(); } return false; }
  if (stale()) { net.close(); return false; }
  S.hosting = false; S.viaSteam = true; S.lobbyId = r.lobby || null;
  net.send({ t: 'join', name: myName(), room: r.code, build: BUILD(), rdy: 1, prof: forServer() });
  return true;
}
// an invite accepted while the game runs: straight in from the menu; mid-trip, ask first (unless it's
// to this very trip). While the menu is busy (joining by code, hosting) the latest invite waits
let inviteT = 0;
function onLobbyInvite(id) {
  clearTimeout(inviteT);
  if (S.phase === 'menu' && $('hostBtn').disabled) { inviteT = setTimeout(() => onLobbyInvite(id), 1000); return; }
  if (S.phase === 'menu') { DESK.takeLobby(); joinFriend(id); return; }
  if (id === S.lobbyId) { DESK.takeLobby(); return; }
  netModal('Join your friend\'s trip?', S.hosting ? 'You\'re hosting a trip right now: leaving ends it for everyone on it. Join theirs?' : 'You\'re on a trip right now. Leave it and join theirs?', [
    ['Join them', () => backToMenu(null)],          // the invite waits in the shell for the menu to take it
    ['Stay here', () => { DESK.takeLobby(); $('netModal')?.remove(); }],
  ]);
}
// the friends list shows what the crew is up to (Steam's rich presence)
let presKey = '';
function updatePresence() {
  if (!STEAM) return;
  const ph = S.phase === 'menu' ? 'menu' : S.g?.ph || 'camp', day = S.dayLabel || 1;
  if (`${ph}|${day}` === presKey) return;
  presKey = `${ph}|${day}`;
  DESK.presence({ ph, day, biome: BIOME_BY_DAY[Math.min(day, BIOME_BY_DAY.length) - 1] });
}
if (STEAM) {
  updatePresence();
  DESK.onEvent(ev => { if (ev?.t === 'lobby') onLobbyInvite(String(ev.id)); });
  DESK.takeLobby().then(id => { if (id) joinFriend(id); });
}
// While the menu waits for an answer the buttons say so, and a second click can't open a second socket.
// Each Host or Join (or invite) is an attempt: an answer that comes back for an older one is dropped.
let menuBusyT = 0, attempt = 0, lastMiss = { code: '', at: 0 };
function menuBusy(which, ms = 15000) {
  clearTimeout(menuBusyT);
  for (const [id, text] of [['hostBtn', 'Starting…'], ['joinBtn', 'Joining…']]) {
    const b = $(id);
    b.dataset.label ??= b.textContent;
    b.disabled = !!which;
    b.textContent = which === id ? text : b.dataset.label;
  }
  if (which) menuBusyT = setTimeout(giveUp, ms);
}
// no answer in time: drop what was under way (an answer that still comes is ignored) and say so
function giveUp() {
  attempt++;
  menuBusy(null); menuStatus('');
  $('menuError').textContent = 'No answer. Try again.';
  net.close();
  if (S.viaSteam) { S.viaSteam = false; DESK?.leave(); }
}
// this PC's own game server (never wherever the last socket went: a friend's bridge, after a Steam join)
async function ensureConnected() {
  if (net.connected() && net.at() === net.socketUrl()) return true;
  net.close();
  try { await net.connect(net.socketUrl()); return true; } catch (e) { $('menuError').textContent = e.message; return false; }
}
$('hostBtn').onclick = async () => {
  if ($('hostBtn').disabled) return;
  initAudio(); sfx.click();
  const my = ++attempt;
  menuBusy('hostBtn', STEAM ? 45000 : 15000);
  $('menuError').textContent = ''; menuStatus('');
  S.viaSteam = false; hostLeft = null;
  await physReady;
  // on Steam, a trip code that no other trip has right now (the shell asks Steam; else the server picks)
  const pick = STEAM ? await DESK.pickCode?.().catch(() => null) : null;
  if (my !== attempt) return;
  S.hosting = true;
  if (await ensureConnected()) { if (my === attempt) net.send({ t: 'create', name: myName(), seed: $('seedInput').value.trim() || null, code: pick?.ok ? pick.code : undefined, build: BUILD(), rdy: 1, prof: forServer() }); }
  else menuBusy(null);
};
// Join Game: the trip code a friend read out. The browser build asks its server; the desktop build has
// the shell find the trip on Steam, then gets in the way an invite does
$('joinBtn').onclick = async () => {
  if ($('joinBtn').disabled) return;
  initAudio(); sfx.click();
  const code = normalizeTripCode($('codeInput').value);
  $('codeInput').value = code;
  const bad = tripCodeError(code, 'Your friend sees theirs at the top right of their screen.');
  if (bad) { $('menuError').textContent = bad; return; }
  if (DESK) {
    if (!STEAM) { $('menuError').textContent = DESK.steam?.reason || 'Joining a friend needs Steam running.'; return; }
    // the same code again at once: Steam's answer to it is still on screen (another code goes straight in)
    if (code === lastMiss.code && performance.now() - lastMiss.at < 2000) return;
    if (!await joinViaSteam(() => DESK.joinCode(code), `Looking for trip ${code} on Steam…`)) lastMiss = { code, at: performance.now() };
    return;
  }
  const my = ++attempt;
  menuBusy('joinBtn');
  $('menuError').textContent = ''; menuStatus('');
  S.hosting = false; hostLeft = null;
  await physReady;
  if (await ensureConnected()) { if (my === attempt) net.send({ t: 'join', name: myName(), room: code, resume: savedSession(code), build: BUILD(), rdy: 1, prof: forServer() }); }
  else menuBusy(null);
};
// trip codes are digits: keep only those, four at most (a pasted "12 34" or "code: 4821, 8pm" works too)
$('codeInput').addEventListener('input', () => { const el = $('codeInput'), v = tripCodeIn(el.value).slice(0, 4); if (el.value !== v) el.value = v; });
$('helpOk').onclick = () => { $('help').classList.add('hidden'); askVoice(); };
// Proximity voice is half the game: the first trip asks once (a card by the voice button, not a modal:
// nobody is held up), and remembers the answer
function askVoice() {
  let asked = null;
  try { asked = localStorage.getItem('nmdVoiceAsked'); } catch {}
  if (asked || voice.V.on || !voice.V.supported || $('voiceAsk')) return;
  const el = document.createElement('div');
  el.id = 'voiceAsk'; el.className = 'voice-ask panel parchment';
  el.innerHTML = '<b>Proximity voice chat</b><p>Hear whoever is within about 25 m of you in the game, from where they stand. Farther than that takes walkie-talkies. Press Esc to use the mouse.</p><div class="row"><button class="btn small green" id="voiceAskYes">Use my mic</button><button class="btn small gray" id="voiceAskNo">Not now</button></div>';
  $('game').appendChild(el);
  const done = () => { try { localStorage.setItem('nmdVoiceAsked', '1'); } catch {} el.remove(); };
  $('voiceAskYes').onclick = () => { done(); initAudio(); voice.joinVoice(); };
  $('voiceAskNo').onclick = done;
  setTimeout(() => { if (el.isConnected) el.remove(); }, 45000);
}
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('hostBtn').click(); });
$('hCode').onclick = async () => {
  if (!isTripCode(S.code)) return;
  const code = S.code, copied = await (navigator.clipboard?.writeText(code).then(() => true, () => false) ?? false);
  toast(copied ? `Trip code ${code} copied. Friends click Join Game and type it in.` : `Your trip code is ${code}. Friends click Join Game and type it in.`);
};

// ---- toasts & ui ---------------------------------------------------------------------

function toast(text, color = '#fff', secs = 4) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderColor = color;
  el.innerHTML = `<span class="tmsg" data-c="${color}" style="--c:${color}">${uiText(text)}</span>`;
  $('toasts').prepend(el);
  while ($('toasts').children.length > 5) $('toasts').lastChild.remove();
  setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 600); }, secs * 1000);
  sfx.toast(/^#(7cfc00|9be15d|8bc34a|a5d6a7)/i.test(color) ? 'good' : /^#(ff8a80|ff5252|ffb4a2|e57373)/i.test(color) ? 'bad' : 'info');
}

function fmtClock(h) {
  const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
}

// ---- pointer lock & input -------------------------------------------------------------

const canvas = $('canvas');
const uiOpen = () => !$('keypad').classList.contains('hidden') || !$('voicePanel').classList.contains('hidden') || !!$('netModal')
  || !$('settings').classList.contains('hidden') || !$('credits').classList.contains('hidden') || garageOpen();
canvas.addEventListener('click', () => { if (!uiOpen()) canvas.requestPointerLock?.(); });
$('clickToPlay').addEventListener('click', e => { if (!e.target.closest('.ctp-row, .ctp-code') && !uiOpen()) canvas.requestPointerLock?.(); });
// Esc: the pointer comes free and this card offers the rest (the world keeps going: it's co-op)
$('ctpInvite').onclick = () => inviteFriends();
$('ctpLeave').onclick = () => netModal('Leave the trip?', (DESK && S.hosting ? 'The trip runs on your PC: if you leave, it ends for everyone.' : 'Your seat goes to whoever joins next.') + waitingSummaries(), [
  ['Leave', () => backToMenu(null)], ['Stay', () => $('netModal')?.remove()],
]);
$('ctpQuit').onclick = () => netModal('Quit the game?', (S.hosting ? 'The trip runs on your PC: quitting ends it for everyone.' : 'Your friends keep driving without you.') + waitingSummaries(), [
  ['Quit', () => DESK?.quit()], ['Stay', () => $('netModal')?.remove()],
]);
// the desktop host's game holds a friend's trip summary (their records) till they come back for it:
// leaving ends that ('Ann hasn't got her trip summary yet.')
function waitingSummaries() {
  const who = DESK && S.hosting ? S.meta?.trip?.pending || [] : [];
  if (!who.length) return '';
  const names = who.slice(0, 3).join(', ') + (who.length > 3 ? ` and ${who.length - 3} more` : '');
  return ` ${names} ${who.length > 1 ? 'haven\'t' : 'hasn\'t'} got ${who.length > 1 ? 'their' : 'the'} trip summary yet: it waits on your PC till they reconnect, and leaving loses it.`;
}
document.addEventListener('pointerlockerror', () => { if (S.phase === 'game') toast('Click again to look around.', '#fff', 2); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  $('clickToPlay').classList.toggle('hidden', locked || S.phase === 'menu' || uiOpen());
  if (!locked) { inp.grab = false; for (const k in keys) keys[k] = false; letGoOfTheWheel(); }
});
// the driver's hands leave the controls: say so at once (a frozen or hidden page sends nothing at all,
// and the server only lets go of a silent driver's throttle after a moment)
function letGoOfTheWheel() {
  if (me.mode === 'seat' && me.seat === 0) net.send({ t: 'drv', th: 0, st: 0, hb: 0 });
  if (fixHeld) { fixHeld = false; net.send({ t: 'fix', on: 0 }); }   // (and of the engine: a hidden tab runs no frames to say so)
}
// The wheel and the pedals go to the server 20 times a second on their own clock, not once a frame: on a
// slow PC (a frame a second) the server would let go of a driver it hasn't heard from for a second
setInterval(() => {
  if (S.phase !== 'game' || me.mode !== 'seat' || me.seat !== 0 || !net.connected()) return;
  const typingNow = uiOpen() || !isLocked();
  net.send({ t: 'drv', th: typingNow ? 0 : (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0), st: typingNow ? 0 : (keys.a || keys.arrowleft ? 1 : 0) - (keys.d || keys.arrowright ? 1 : 0), hb: keys[' '] ? 1 : 0 });
}, 50);
document.addEventListener('visibilitychange', () => { if (document.hidden) letGoOfTheWheel(); });
window.addEventListener('pagehide', letGoOfTheWheel);
document.addEventListener('mousemove', e => {
  if (!locked) return;
  const sens = 0.0022 * settings.sens;
  me.yaw -= e.movementX * sens;
  me.pitch = Math.max(-1.45, Math.min(1.45, me.pitch + e.movementY * sens * (settings.invertY ? -1 : 1)));
});
document.addEventListener('mousedown', e => {
  if (!isLocked()) return;
  initAudio();
  if (e.button === 0) { inp.grab = true; onGrabPress(); }
  if (e.button === 2) onThrow();
  if (e.button === 1) onPing();
});
document.addEventListener('mouseup', e => {
  if (e.button === 0) { inp.grab = false; onGrabRelease(); }
});
document.addEventListener('contextmenu', e => { if (locked) e.preventDefault(); });
document.addEventListener('wheel', e => {
  if (!locked || !me.holding) return;
  S.holdDist = Math.max(C.GRAB.HOLD_MIN, Math.min(C.GRAB.HOLD_MAX, (S.holdDist || C.GRAB.HOLD_DEFAULT) - Math.sign(e.deltaY) * 0.2));
  net.send({ t: 'hd', d: S.holdDist });
}, { passive: true });

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  // in game, Ctrl (crouch) and Cmd combinations are ours, not the browser's or the desktop shell's
  // (Ctrl+W, Ctrl+R and friends used to close or reload the game mid-crouch)
  if ((e.ctrlKey || e.metaKey) && S.phase !== 'menu') e.preventDefault();
  const k = keyName(e);   // by position: WASD is ZQSD on AZERTY (keys.js)
  if (k === ' ' || k === 'tab') e.preventDefault();
  if (keys[k]) return;
  keys[k] = true;
  if (S.phase === 'menu') return;
  // the Garage holds the game's keys while it's open (it closes on G or Esc; the voice keys still work)
  if (garageOpen() && !['g', 'escape', 'v', 't', 'm'].includes(k)) return;
  // the night's receipt (shown while the mouse is captured): any of these keys puts it away
  if (!$('receipt').classList.contains('hidden') && (k === 'e' || k === 'enter' || k === ' ' || k === 'escape')) { $('receipt').classList.add('hidden'); return; }
  if (k === 'e') onUse();
  else if (k === 'q') onDrop();
  else if (k === 'f') { mapRaised = !mapRaised; }
  else if (k === 'r' && me.mode === 'seat' && me.seat === 0) net.send({ t: 'use', kind: 'reel' });
  else if (k === 'h' && me.mode === 'seat' && me.seat === 0) net.send({ t: 'horn' });
  else if (k === 'v') voice.setPtt(true);
  else if (k === 'm') {
    if (!voice.V.on) toast('Voice chat is off. JOIN VOICE is at the bottom left (press Esc for the mouse).', '#fff', 4);
    else { voice.toggleMute(); toast(voice.V.muted ? `Mic muted (${keyLabel('M')})` : 'Mic on', voice.V.muted ? '#ffb4a2' : '#7CFC00', 2); }
  }
  else if (k === 't') voice.setWalkieKey(true);
  else if (k === 'f1' || k === '?') { e.preventDefault(); $('help').classList.toggle('hidden'); }
  else if (k === 'g' && !e.repeat) { if (garageOpen()) closePanel('garage'); else openPanel('garage'); }   // (held down: not open-then-shut)
  else if (/^[1-8]$/.test(k) && casinoKey(Number(k))) { /* (at a casino station the number keys play it) */ }
  else if (/^[1-6]$/.test(k)) net.send({ t: 'emote', e: C.EMOTES[Number(k) - 1] });
  else if (k === 'escape') { closeKeypad(); if (garageOpen()) closePanel('garage'); }
});
window.addEventListener('keyup', e => {
  const k = keyName(e);
  keys[k] = false;
  if (k === 'v') voice.setPtt(false);
  if (k === 't') voice.setWalkieKey(false);
  if (k === 'e') reviveT = 0;
});
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; inp.grab = false; letGoOfTheWheel(); });

// ---- interactions ----------------------------------------------------------------------

function excludeSet() {
  const s = new Set();
  if (me.holding && S.lw) { const h = S.lw.propCollider(me.holding.id); if (h != null) s.add(h); }
  return s;
}
// what my own body walks through: that, and a grumphorn on the move. Who it hits is the server's business
// (its horns toss, its flank stumbles, and it spares anyone down and whoever kneels by them); its capsule
// here would only shove you along in front of it
function moveExclude() {
  const s = excludeSet();
  if (S.lw) for (const p of S.props.values()) {
    if (p.type !== 'grumphorn') continue;
    const st = (p.st ?? 0) & ST_MASK;
    if (st === GST.CHARGE || st === GST.WINDED || (p.view?.speed || 0) > 2) { const h = S.lw.propCollider(p.id); if (h != null) s.add(h); }
  }
  return s;
}

function nearestAnchor() {
  if (!S.W) return null;
  let best = null, bd = 3.2;
  for (const a of S.W.anchors) {
    const d = Math.hypot(a.x - me.pos.x, a.y - (me.pos.y + 1), a.z - me.pos.z);
    if (d < bd) { bd = d; best = a; }
  }
  if (!best) {
    for (const p of S.props.values()) {
      if (LOOT[p.type].mass < 60 || !p.pose) continue;
      const d = Math.hypot(p.pose.p.x - me.pos.x, p.pose.p.z - me.pos.z);
      if (d < (p.type === 'boulder' ? 3.4 : LOOT[p.type].mob ? 2.6 : 2.0)) return { prop: p };
    }
  }
  return best;
}

function doorNear() {
  if (!S.rv) return false;
  const l = toLocal(S.rv.p, S.rv.q, me.eye(S.rv));
  return Math.hypot(l.x + 1.2, l.z - RV_DIM.DOOR_Z) < 2.2 && l.y > 0 && l.y < 2.6;
}

function computeTarget() {
  if (!S.lw) return null;
  if (me.mode === 'seat') return { kind: 'seat', label: me.seat === 0 ? '[E] get up · WASD drive · SPACE brake · [R] reel winch · [H] horn' : (mapWanted() ? '[E] get up (stand to read the map)' : '[E] get up') };
  if (me.mode === 'ko') return null;
  if (me.hasHook) {
    const a = nearestAnchor();
    return { kind: 'hookhold', label: a ? (a.prop ? '[E] hook the winch onto it' : '[E] hook the winch here') : 'carrying the winch hook — find a post / dead tree · [Q] drop it' };
  }
  const eye = me.eye(S.rv), look = me.look();
  const hit = S.lw.ray(eye, look, C.PLAYER.REACH, G.WORLD | G.RV | G.PROP | G.PLAYER | G.USE | G.HOOK, excludeSet(), true);
  // broken down, and standing behind it: the engine hatch (looking at the RV's back, the ground or the sky)
  const fix = atHatch() ? { kind: 'fix', label: `[Hold E] fix the engine${S.g.fix ? ` (${S.g.fix}%)` : ''}` } : null;
  // Keen Eye II: a thing's price read from further off than a hand reaches (nothing to grab there)
  if (!hit && !fix && !me.holding && me.mods.labelReach > C.PLAYER.REACH) {
    const far = S.lw.ray(eye, look, me.mods.labelReach, G.WORLD | G.RV | G.PROP, excludeSet(), true);
    const p = far?.kind === 'prop' ? S.props.get(far.id) : null, L = p && LOOT[p.type];
    if (L && !L.mob && !L.find && p.type !== 'boulder' && p.type !== 'map') return { kind: 'peek', label: `${L.name} · ${fmt$(p.value)}${p.value < p.max ? ` (was ${fmt$(p.max)})` : ''}` };
  }
  if (!hit) return fix || (doorNear() ? { kind: 'door', label: `[E] ${S.door ? 'close' : 'open'} the door` } : null);
  if (hit.kind === 'prop') {
    if (me.holding) return null;   // hands full: a grab would do nothing, so don't promise one
    const p = S.props.get(hit.id);
    if (!p) return null;
    const L = LOOT[p.type];
    if (p.type === 'boulder') return { kind: 'prop', id: p.id, hit, label: 'A 2-ton rock. Shove it with friends (walk into it), or winch it.' };
    if (L.mob) return { kind: 'prop', id: p.id, hit, label: mobLabel(p) };
    if (p.type === 'map') { const no = mapNo(); return no ? { kind: 'mapwait', label: no } : { kind: 'prop', id: p.id, hit, label: `[Hold LMB] take the road map and call out the road to ${driverName()}` }; }
    if (L.find) return { kind: 'prop', id: p.id, hit, label: `[Hold LMB] ${L.name}: set it down in the RV to keep it (${TINS[L.find]} cards)` };
    const heavy = L.cls === 'heavy' ? ' — HEAVY, get a friend' : '';
    const dmg = p.value < p.max ? ` (was ${fmt$(p.max)})` : '';
    return { kind: 'prop', id: p.id, hit, label: `[Hold LMB] ${L.name} · ${fmt$(p.value)}${dmg}${heavy}` };
  }
  if (hit.kind === 'use') {
    const u = S.W.uses[hit.id];
    if (u.kind === 'keypad' && S.gatesOpen.has(u.arg)) return null;
    return { kind: 'use', id: hit.id, u, label: u.kind === 'repair' ? gusPrompt(u.arg) : `[E] ${u.label}` };
  }
  if (hit.kind === 'hook') {
    return { kind: 'hook', label: S.hook?.state === 2 ? '[E] unhook the winch' : '[E] pick up the winch hook' };
  }
  if (hit.kind === 'player') {
    const st = S.interp.samplePlayer(hit.id, S.renderT);
    const p = S.meta?.players.find(q => q.id === hit.id);
    if (st?.mode === C.MODE.KO) return { kind: 'revive', id: hit.id, label: `[Hold E] pick ${p?.name || 'them'} up off the ground` };
    return null;
  }
  if (hit.kind === 'rv') {
    let u = hit.use;
    // the whole lower front of the RV is "the winch" if you're standing outside in front of it
    const lh = toLocal(S.rv.p, S.rv.q, hit.point);
    if (fix && !u && lh.z < -3.7) return fix;
    if (!u && !me.par && lh.z > 3.8 && lh.y < 1.1) u = 'winch';
    if (u === 'seat0') {
      // (the server says who may take the wheel, room.js mayDrive: the day's driver; while they're away anyone,
      // somebody who hasn't seen the map first)
      const d = roleOf('drv'), may = S.meta?.roles?.wheel?.includes(S.selfId) ?? true;
      const label = !d || d === S.selfId ? '[E] DRIVE'
        : !roleAway('drv') ? `${roleName('drv')} drives today. ${roleOf('nav') === S.selfId ? 'You read the map.' : 'You ride along.'}`
        : may ? `[E] DRIVE till ${roleName('drv')} is back` : `${roleName('drv')} is away. Somebody who hasn't seen the map takes the wheel.`;
      return { kind: 'rvuse', use: 'seat0', label };
    }
    if (u === 'seat1') return { kind: 'rvuse', use: 'seat1', label: '[E] ride shotgun' };
    if (u === 'door') return { kind: 'rvuse', use: 'door', label: '[E] open the door' };
    if (u === 'bunk') return { kind: 'rvuse', use: 'bunk', label: S.g?.ph === 'night' ? '[E] sleep (everyone in a bunk = next day)' : 'bunks (bedtime is after the Repo Man gets paid)' };
    if (u === 'winch') return { kind: 'rvuse', use: 'winch', label: S.hook?.state === 0 ? '[E] take the winch hook' : `[E] ${S.hook?.reeling ? 'stop' : 'start'} reeling in` };
    if (doorNear()) return { kind: 'door', label: `[E] ${S.door ? 'close' : 'open'} the door` };
    if (Math.abs(hit.normal.y) < 0.6 && hit.toi < C.CLIMB.REACH + 0.6) return { kind: 'climb', label: '[Hold LMB] climb' };
    return null;
  }
  if (fix && (hit.kind === 'terrain' || hit.kind === 'static')) return fix;
  if (doorNear()) return { kind: 'door', label: `[E] ${S.door ? 'close' : 'open'} the door` };
  if ((hit.kind === 'terrain' || hit.kind === 'static') && hit.normal.y < 0.79 && hit.toi < C.CLIMB.REACH + 0.6) return { kind: 'climb', label: '[Hold LMB] climb' };
  if (hit.kind === 'gate') return { kind: 'gate', label: 'Locked. The keypad wants a 4-digit code.' };
  return null;
}

// broken down, and I'm on my feet outside, within reach of the engine hatch on its back wall, the RV standing
// still: where holding E fixes it (the server checks the same: room.js fixStep)
function atHatch() {
  if (!S.g?.brk || !S.rv || me.par || me.mode !== 'walk') return false;
  if (Math.hypot(S.rv.v.x, S.rv.v.z) >= C.RVH.FIX_V) return false;
  const h = toWorld(S.rv.p, S.rv.q, RV_HATCH);
  return Math.hypot(me.pos.x - h.x, me.pos.z - h.z) < C.RVH.FIX_R - 0.15 && Math.abs(me.pos.y - h.y) < 2;
}
// Gus's buttons: what the next press costs, live (the server says no with a reason when it can't)
function gusPrompt(arg) {
  const g = S.g;
  if (!g) return '';
  if ((g.rvh ?? 100) >= 100) return 'Gus: "Nothing to fix. She\'s running fine."';
  if (g.day >= C.DAYS || g.ph === 'over') return 'Gus: "Closed. Last day, kid: get her home."';
  if (g.ph !== 'night' || !g.paid) return '[E] Gus fixes the RV (once the Repo Man is paid)';
  const q = C.repairQuote(g.day, g.rvh);
  return arg === 'loan' ? `[E] Gus: fix ${q.pts}% for ${fmt$(q.loan)} on ${g.day === C.DAYS - 1 ? 'the balloon payment' : 'tomorrow\'s payment'}`
    : `[E] Gus: fix ${q.pts}% for ${fmt$(q.cash)} cash`;
}

// what the crosshair says about a critter (shared/mobs.js states)
function mobLabel(p) {
  const st = (p.st ?? 0) & ST_MASK;
  if (p.type === 'ringtail') {
    if ((p.st ?? 0) & ST_CARRY) return '[Hold LMB] grab the ringtail: it drops what it stole · [RMB] shove it';
    if (st === RST.NIP) return 'An angry ringtail, seeing you off its den. [RMB] shove it · [Hold LMB] grab it';
    if (st === RST.RAID || st === RST.INRV) return 'A ringtail after what\'s in the RV! [Hold LMB] grab it · [RMB] shove it';
    if (st === RST.STUN || st === RST.FLUNG) return 'A dizzy ringtail. [Hold LMB] grab it · [RMB] shove it';
    return '[Hold LMB] grab the ringtail · [RMB] shove it';
  }
  if (st === GST.SLEEP || st === GST.DOZE) return 'A sleeping Grumphorn. Let it sleep: crouch past it (C), or creep the RV by. (Two of you [RMB] shoving its side together tip it over.)';
  if (st === GST.TIPPED) return 'A tipped-over Grumphorn! It\'s up in a moment: get by it now.';
  if (st === GST.LEFT || st === GST.LEAVE) return 'A Grumphorn that has had enough of you.';
  if (st === GST.WINDED) return 'The Grumphorn is winded: pelt it, shove it, ram it. [Hold LMB] its horns';
  return 'GRUMPHORN. Get out of its way!';
}

// who is at the wheel right now, if it's somebody else
function driverName() {
  const id = S.g?.drv;
  if (!id || id === S.selfId) return null;
  return S.meta?.players.find(q => q.id === id)?.name || 'the driver';
}
// the day's roles (server/room.js drawRoles): who drives and who reads the map today. While a role's player
// is away (dropped: their seat is kept, meta.away has their name; or not moved for a minute), anyone stands in
const roleOf = job => S.meta?.roles?.[job] || 0;
const roleAway = job => !!roleOf(job) && !!S.meta?.roles?.[job + 'Away'];
const roleName = job => [...(S.meta?.players || []), ...(S.meta?.away || [])].find(q => q.id === roleOf(job))?.name || (job === 'drv' ? 'Somebody else' : 'the navigator');
// Why I can't take the road map now (null: I can). The server's rule (server/room.js mapRefusal): only today's
// navigator takes it (or anyone but the driver while the navigator has dropped), only while somebody else is
// at the wheel. This only words the prompt: the server decides
function mapNo() {
  if (!roleOf('nav')) return 'The road map. It takes two: one drives, one reads it out.';
  if (roleOf('drv') === S.selfId) return 'The road map. You drive today: no peeking.';
  if (roleOf('nav') !== S.selfId && !roleAway('nav')) return `The road map. Only ${roleName('nav')} reads it today.`;
  if (!driverName()) return `The road map. ${roleAway('drv') ? 'Somebody' : roleName('drv')} has to be at the wheel first.`;
  return null;
}
// should I (today's navigator) take the map now: the driver is at the wheel, the road ahead matters (camp, or
// the road before town), and the map lies in the RV with nobody reading it
function mapWanted() {
  const g = S.g;
  if (!g || roleOf('nav') !== S.selfId || !driverName() || !(g.ph === 'camp' || (g.ph === 'road' && !g.town)) || mapOut()) return false;
  const mp = [...S.props.values()].find(p => p.type === 'map');
  if (!mp?.pose || !S.rv) return false;
  const l = toLocal(S.rv.p, S.rv.q, mp.pose.p);
  return insideRV(l.x, l.y, l.z, 0.3);
}
// while a day loads, what the crosshair was on belongs to the old world (or none): nothing to grab, use or ping
function onGrabPress() {
  if (worldBuilding) return;
  if (me.mode === 'seat' || me.mode === 'ko' || me.holding || me.hasHook) return;
  const t = target;
  if (t?.kind === 'mapwait') { inp.grab = false; return; }   // not yet (the prompt says why); and no climbing the dash behind it
  if (t?.kind === 'prop') {
    const p = S.props.get(t.id);
    if (!p) return;
    const eye = me.eye(S.rv);
    S.holdDist = Math.max(C.GRAB.HOLD_MIN, Math.min(C.GRAB.HOLD_MAX, t.hit.toi + 0.1));
    me.holding = { id: p.id, type: p.type };
    if (p.type === 'ringtail') tutDone('ringtail');
    net.send({ t: 'grab', kind: 'prop', id: p.id, pt: [t.hit.point.x, t.hit.point.y, t.hit.point.z], d: S.holdDist });
    sfx.grab();
    inp.grab = false;   // holding something, not climbing
  }
}
function onGrabRelease() {
  if (me.holding) { net.send({ t: 'rel' }); me.holding = null; }
}
function onThrow() {
  if (!me.holding) return onShove();
  const l = me.look();
  net.send({ t: 'rel', thr: 1, dir: [l.x, l.y + 0.15, l.z] });
  me.holding = null;
  sfx.throw();
}
// right mouse with empty hands: a two-handed shove at whatever is in front of you (the server decides what it
// hits: server/sim.js shove). It costs stamina, so it can't be spammed
function onShove() {
  if (worldBuilding || me.mode !== 'walk' || me.hasHook) return;
  const now = performance.now();
  if (now < (S.shoveCd || 0) || me.stamina < C.SHOVE.STAMINA) return;
  S.shoveCd = now + C.SHOVE.COOLDOWN * 1000;
  S.shoveUntil = now + 300;
  me.spend(C.SHOVE.STAMINA);
  net.send({ t: 'shove' });
  hands.shove();
  sfx.whoosh();
  tutDone('shove');
  if (target?.kind === 'prop' && S.props.get(target.id)?.type === 'ringtail') tutDone('ringtail');
}
function onDrop() {
  if (me.holding) { net.send({ t: 'rel' }); me.holding = null; }
  else if (me.hasHook) { net.send({ t: 'use', kind: 'dropHook' }); me.hasHook = false; }
}
function onPing() {
  if (worldBuilding) return;
  const eye = me.eye(S.rv), l = me.look();
  const hit = S.lw?.ray(eye, l, 300, G.WORLD | G.RV | G.PROP | G.PLAYER, excludeSet(), false);
  if (hit) net.send({ t: 'ping', pt: [hit.point.x, hit.point.y, hit.point.z] });
}
function onUse() {
  initAudio();
  if (worldBuilding) return;
  if (me.mode === 'seat') { net.send({ t: 'use', kind: 'unseat' }); return; }
  const t = target;
  if (!t) return;
  if (t.kind === 'hookhold') { net.send({ t: 'use', kind: 'hook' }); return; }
  if (t.kind === 'hook') { net.send({ t: 'use', kind: 'hook' }); return; }
  if (t.kind === 'door') { net.send({ t: 'use', kind: 'door' }); return; }
  if (t.kind === 'rvuse') { net.send({ t: 'use', kind: t.use }); return; }
  if (t.kind === 'revive') { reviveT = 0.0001; return; }
  if (t.kind === 'use') {
    if (t.u.kind === 'keypad') { openKeypad(t.id); return; }
    net.send({ t: 'use', id: t.id });
    sfx.click();
  }
}

// keypad
let keypadUse = null;
function openKeypad(id) {
  keypadUse = id;
  S.kpCrouch = me.crouch;   // crouched at the keypad stays crouched while typing (the mouse coming free lets go of every key)
  $('keypad').classList.remove('hidden');
  $('kpInput').value = '';
  document.exitPointerLock?.();
  setTimeout(() => $('kpInput').focus(), 30);
}
function closeKeypad() {
  if ($('keypad').classList.contains('hidden')) return;
  $('keypad').classList.add('hidden');
  keypadUse = null;
  canvas.requestPointerLock?.();
}
$('kpInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { net.send({ t: 'use', id: keypadUse, code: $('kpInput').value }); closeKeypad(); }
  if (e.key === 'Escape') closeKeypad();
});
$('kpGo').onclick = () => { net.send({ t: 'use', id: keypadUse, code: $('kpInput').value }); closeKeypad(); };
$('kpCancel').onclick = closeKeypad;

// ---- world (re)build ----------------------------------------------------------------------

// The loading screen (the boot bar, reused): shown from the world message until the new world has
// drawn a frame; the bar follows the day's textures getting ready.
const TIPS = [
  'The Repo Man collects at midnight, every night. Miss one payment and he takes the RV.',
  'Loot loses value every time it gets knocked about. Carry it gently.',
  'Hold the left mouse button on a rock wall to climb it. Space lunges up.',
  'Each morning picks a driver and a navigator. The driver can\'t see the map: the navigator reads it out.',
  'Walk into the RV to push it out of the mud.',
  'Crouch in the RV to brace for a crash: braced, a crash can\'t knock you out.',
  'A Grumphorn sleeps past an obstacle some days. Crouch past it, creep the RV by, or wear out its patience: ram it, winch it, throw junk at it.',
  'Right mouse with empty hands shoves whatever is in front of you: friends, loot, wildlife.',
  'Ringtails steal loot nobody is watching and pile it at their den near the stop. Stand facing your pile, or go and take it back.',
  'From day 2, leave the RV\'s door open with nobody by it and a ringtail may hop in and help itself. Shut the door, stay by it, or bungee the cargo down.',
  'From day 2, ringtails nip anyone who comes close to their den: you stumble and drop what you carry.',
  'From day 3, loose rock sits above the narrows. Honk at the yellow LOOSE ROCK sign and it comes down before you get there.',
  'A hard hat from the store ($80) turns your next knockout into a knock.',
  'Ringtails can\'t resist a cheese wheel ($30 at the store). Put it where you want them: away from your loot, or out past their den.',
  'Day 5 has a Hoard: a den with up to six ringtails and the week\'s best stash. Bring friends.',
  'Throw junk at a friend and it knocks them over (never out). Everyone hears who did it.',
  'Hold E on a knocked-out friend to pick them up. Waiting it out costs a doctor\'s bill.',
  'Voices carry about 25 m. Past that you need walkie-talkies: $150 each at the store, and it takes two.',
  'Use the game\'s own voice chat, not a call: who hears you depends on where you stand.',
  'The winch: take the hook from the front bumper, clip it to a post, and the driver reels in with R.',
  'Everyone in a bunk starts the next day.',
  'Crashes and the wildlife dent the RV. Worn down it\'s slower, and at 0% it breaks down: everyone out, and hold E at the engine hatch at the back.',
  'Gus fixes the RV by the lot at night, once the Repo Man is paid: cash, or on tomorrow\'s payment.',
  'The casino pays out to the whole crew. So do its losses.',
  'Every trip is timed and counted. G opens the Garage: your fastest payoff, your biggest haul, your crews.',
  'A trip from a typed seed is practice: it counts only on that seed\'s board in your Logbook.',
  'Road Card tins wait at the dangerous places: up a crash butte, by a ringtail den, in a sleeping Grumphorn\'s fur. Set one down in the RV and it goes in the glovebox.',
  'Pay off the RV on day 5 and everyone aboard keeps a copy of every Road Card in the glovebox. Miss a payment and the Repo Man takes the glovebox too.',
];
let tipN = Math.floor(Math.random() * TIPS.length);
function loadingBar(on, frac = 0, text = 'Loading the road') {
  const el = $('loading');
  if (!on) { el.classList.add('hidden'); return; }
  if (el.classList.contains('hidden') || !el.dataset.tip) { el.dataset.tip = '1'; $('loadingTip').textContent = TIPS[tipN++ % TIPS.length]; }
  el.classList.remove('hidden');
  el.classList.add('day');
  el.querySelector('span').textContent = text;
  const b = el.querySelector('b');
  b.style.animation = 'none';
  b.style.width = `${Math.round(6 + 90 * Math.max(0, Math.min(1, frac)))}%`;
}
let buildSeq = 0, prefetched = null, recordTimer = 0, loadingDay = 'Loading the road';
// Get the day's textures ready off the main thread before the build asks for them (texprep.js): from
// the texture cache, else painted by the workers, the few that can't be painted there painted here
// meanwhile. Never waits on a stuck worker: after 20 s without progress the build goes ahead and
// canvasFor paints whatever is missing, as before.
async function prepareDay(W) {
  const names = texPrep.dayList(W.biome);
  texPrep.keepOnly(names);
  let last = performance.now();
  const t0 = performance.now();
  // none of this is needed to build: on any failure canvasFor paints what's missing, as before
  const p = texPrep.prepare(names, { page: true, onProgress: (d, n) => { last = performance.now(); loadingBar(true, 0.85 * d / Math.max(1, n), loadingDay); } })
    .catch(e => { console.warn('textures:', e?.message || e); return null; });
  let stuck = false, done = false;
  p.then(() => { done = true; });
  await Promise.race([p, new Promise(res => { const chk = () => (done ? res() : performance.now() - last > 20000 ? (stuck = true, res()) : setTimeout(chk, 500)); chk(); })]);
  const r = stuck ? null : await p;
  performance.measure?.(`textures day ${W.day}`, { start: t0, end: performance.now() });
  if (stuck) console.warn('textures: the paint workers stalled; painting the rest here');
  return r;
}

async function buildDay(m) {
  const my = ++buildSeq;
  worldBuilding = true;
  // the build before this one may still be learning what its biome asks for (see below): what this
  // one paints belongs to another day
  clearTimeout(recordTimer);
  texPrep.record(false);
  texPrep.building(true);   // no texture-cache writes competing with the build
  const biome = BIOMES[BIOME_BY_DAY[Math.min(m.day, BIOME_BY_DAY.length) - 1]];
  loadingDay = `Day ${m.day} of ${C.DAYS} · ${biome?.name || 'the road'}`;
  S.rockDown = null;   // (yesterday's rockfalls)
  $('loading').dataset.tip = '';
  loadingBar(true, 0, loadingDay);
  await physReady;
  prefetched = null;
  const W = generateLeg(m.seed, m.day);
  await prepareDay(W);
  if (my !== buildSeq) return false;   // another world message came in meanwhile: that build takes over
  const t0 = performance.now();
  S.seed = m.seed;
  texPrep.record(true, W.biome);   // learn what this biome's build asks for (next time it's ready first)
  if (S.wv) {
    scene.remove(S.wv.group);
    S.wv.terrain?.dispose?.();   // the grass clutter's instance buffers (materials are cached per biome)
    S.wv.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.isSkinnedMesh) o.skeleton?.dispose(); });
  }
  if (S.lw) S.lw.free();
  for (const p of S.props.values()) { scene.remove(p.mesh); p.view?.dispose(); }
  S.props.clear();
  freeDerby();
  S.casAt = null;
  S.W = W;
  S.door = !!m.door;
  S.gatesOpen = new Set();
  // where campfires crackle (ambience.js)
  S.fires = [W.camp?.fire, W.town?.fire].filter(Boolean).map(f => ({ x: f.x, y: W.heightAt(f.x, f.z), z: f.z }));
  newDayMusic();
  S.lw = new LocalWorld(W);
  setBiome(W.biome);
  S.wv = buildWorld(W);
  scene.add(S.wv.group);
  S.mapCv = mapCanvas(W);
  prewarmProps(W);   // paint the loot atlas and build prop meshes while idle, so the first loot doesn't stall a frame
  S.interp.reset();
  S.dayLabel = m.day;
  zoneText(W.biomeName, `Day ${m.day} of ${C.DAYS}`);   // after the build: the fade starts on the next rendered frames
  performance.measure?.(`build day ${m.day}`, { start: t0, end: performance.now() });
  worldBuilding = false;
  // the messages that came while the day loaded, in order (afterWorld); one that throws mustn't take
  // the rest, or the end of the build (the loading screen stays up), with it (it is still a page error:
  // the browser tests fail on it). What came for a world whose build was superseded (another world
  // message came in mid-build) is dropped: its props list, events or teleport were that world's,
  // and the newer world's own came after it.
  const queued = S.pendingAfterWorld || [];
  S.pendingAfterWorld = [];
  for (const q of queued) {
    if (q.seq && q.seq < my) { S.staleDropped = (S.staleDropped || 0) + 1; continue; }
    try { q.fn(); } catch (e) { (window.reportError || console.error)(e); }
  }
  S.builtAt = performance.now();   // tools/loadtime.mjs: the world (and its loot) is in
  if ($('help').classList.contains('hidden')) setTimeout(askVoice, 1500);
  // the loading screen stays up until the new world has drawn; then, once things are quiet, what was
  // painted this session goes into the texture cache (the workers encode and write it in the
  // background) and the list of what this build asked for is kept for next time
  const f0 = S.frames || 0;
  const afterFrames = () => {
    if (my !== buildSeq) return;
    if ((S.frames || 0) < f0 + 2) { requestAnimationFrame(afterFrames); return; }
    loadingBar(false);
    clearTimeout(recordTimer);
    recordTimer = setTimeout(() => { if (my === buildSeq) { texPrep.record(false); texPrep.building(false); texPrep.flush(); } }, 3000);
  };
  requestAnimationFrame(afterFrames);
  return true;
}

// At nightfall, get tomorrow's textures ready behind the night scene, decoded from the cache or painted
// by the workers. Nothing here paints or builds on the main thread (not even tomorrow's world data: its
// biome is all the list needs, and generating the leg is one long task, a visible hitch on a fast GPU;
// the morning build does it under the loading bar); the morning build only copies what's ready.
let lastPhase = null;
function onPhase(ph) {
  if (ph === lastPhase) return;
  lastPhase = ph;
  if (ph !== 'night' || !S.W || S.seed == null) return;
  const day = S.W.day + 1, seed = S.seed;
  if (day > C.DAYS || (prefetched && prefetched.day === day && prefetched.seed === seed)) return;
  const idle = window.requestIdleCallback || (f => setTimeout(f, 200));
  idle(() => {
    if (lastPhase !== 'night' || S.W?.day !== day - 1) return;
    const t0 = performance.now();
    prefetched = { seed, day };
    texPrep.prepare(texPrep.dayList(BIOME_BY_DAY[Math.min(day, BIOME_BY_DAY.length) - 1]), { prio: 1, page: false }).then(r => {
      performance.measure?.(`prefetch day ${day}`, { start: t0, end: performance.now() });
      S.prefetch = { day, ...r };
      texPrep.flush();   // and into the cache with them, in the background, while the night lasts
    });
  }, { timeout: 3000 });
}
// While a day loads (prepareDay waits seconds for its textures), the messages after the world message
// wait for the new world and are then handled in the order they came, as when the build ran straight
// after the world message. A prop that breaks or is pawned meanwhile must not be taken out of the old
// world (or out of none, on a joiner) and then come back with the queued props list as a ghost with
// a collider; a 'dmg' must not be lost; a toast must not run out under the loading screen.
// Each waits with the build it came during (seq), so a build that is superseded doesn't hand its
// world's messages to the next world.
const afterWorld = fn => { if (worldBuilding || !S.W) (S.pendingAfterWorld ||= []).push({ fn, seq: buildSeq }); else fn(); };
// the same for a message that needs no world, only its place in the order (roster, toasts, your seat)
const inOrder = fn => m => { if (worldBuilding) (S.pendingAfterWorld ||= []).push({ fn: () => fn(m) }); else fn(m); };

function addProp(d) {
  if (S.props.has(d.id)) return;
  // wildlife: its own mesh and a view that poses it from its state (mobs3d.js)
  const mob = LOOT[d.type]?.mob ? buildMob(d.type, S.W) : null;
  const mesh = mob ? mob.obj : buildProp(d.type, S.W);
  const q = { x: d.q[0], y: d.q[1], z: d.q[2], w: d.q[3] };
  const p = { x: d.x, y: d.y, z: d.z };
  mesh.position.set(p.x, p.y, p.z);
  mesh.quaternion.set(q.x, q.y, q.z, q.w);
  scene.add(mesh);
  if (mob) { mob.view.onPuff = puff; if (d.tip) mob.view.tipSide = d.tip; }   // (a grumphorn tipped over before this page came)
  S.props.set(d.id, { id: d.id, type: d.type, value: d.value, max: d.max, mesh, pose: { p, q }, view: mob?.view || null, st: d.st ?? 0 });
  S.lw.addProp(d.id, d.type, p, q);
  S.interp.seedProp(d.id, p, q, d.st);
}
function removeProp(id, fx = null) {
  const p = S.props.get(id);
  if (!p) return;
  if (fx) burst(p.mesh.position, fx.color, fx.n, fx.speed);
  scene.remove(p.mesh);
  p.view?.dispose();
  S.props.delete(id);
  S.lw?.removeProp(id);
  S.interp.dropProp(id);
  if (me.holding?.id === id) me.holding = null;
}

// ---- losing the connection ---------------------------------------------------------------------
// The host's game IS the server: when it closes, the trip is over, and every guest is told why. Anything
// else is a dropped connection: the server keeps the seat for 90 s, so come back to it with the token.
let hostLeft = null, reconnecting = false, welcomeWait = null, lagShown = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function connOverlay(text) {
  let el = $('connBox');
  if (!text) { el?.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'connBox'; el.className = 'conn-box'; document.body.appendChild(el); }
  el.textContent = text;
}
function netModal(title, body, buttons) {
  $('netModal')?.remove();
  const el = document.createElement('div');
  el.id = 'netModal';
  el.className = 'panel parchment net-modal';
  el.innerHTML = `<h2>${escapeHtml(title)}</h2><p>${escapeHtml(body)}</p><div class="row"></div>`;
  for (const [label, fn] of buttons) { const b = document.createElement('button'); b.className = 'btn big'; b.textContent = label; b.onclick = fn; el.querySelector('.row').appendChild(b); }
  document.body.appendChild(el);
  document.exitPointerLock?.();
}
function endTrip(why) {
  connOverlay(null);
  reconnecting = false;
  S.tripOver = why;
  netModal('The trip is over', why, [['Back to menu', () => backToMenu(why)]]);
}
async function backToMenu(note) {
  quietAmbience();
  net.send({ t: 'leave' });
  net.close(1000, 'left');
  try { await DESK?.leave(); } catch {}          // the desktop: the host's trip ends; a guest leaves the lobby
  try { sessionStorage.removeItem('nmdSession'); if (note) sessionStorage.setItem('nmdMenuNote', note); } catch {}
  // (the browser build: if its server is gone too, a reload would land on the browser's error page)
  if (/^https?:$/.test(location.protocol)) {
    try { await fetch(location.href, { cache: 'no-store' }); }
    catch { netModal('The game server is gone', 'Close this tab, or start the game again.', []); return; }
  }
  location.reload();
}
S.backToMenu = backToMenu;
S.testDrop = () => net.drop();
S.lastMsgAt = () => net.lastMessageAt();
S.setSetting = setSetting;     // tools: S.setSetting('tutorial', false) before screenshots
async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  const t0 = performance.now();
  let delay = 1000;
  while (reconnecting && performance.now() - t0 < 60000) {
    connOverlay(`Connection lost — reconnecting… (${Math.ceil((60000 - (performance.now() - t0)) / 1000)} s)`);
    try {
      await net.connect();
      const got = new Promise((resolve, reject) => { welcomeWait = { resolve, reject }; setTimeout(() => reject({ code: 'timeout' }), 8000); });
      net.send({ t: 'join', name: myName(), room: S.code, resume: savedSession(S.code), build: BUILD(), rdy: 1, prof: forServer() });
      await got;
      welcomeWait = null;
      reconnecting = false;
      connOverlay(null);
      toast('Reconnected.', '#7CFC00', 3);
      return;
    } catch (e) {
      welcomeWait = null;
      if (e?.code === 'noroom' || e?.code === 'version' || e?.code === 'full') { reconnecting = false; endTrip(e.msg || 'The trip is gone.'); return; }
      net.close();
    }
    await sleep(delay);
    delay = Math.min(5000, delay * 2);
  }
  if (reconnecting) { reconnecting = false; endTrip('Couldn\'t reach the trip again. The host may have closed the game.'); }
}
// no word from the host for 3 s: say so; for 15 s: treat it as a dropped connection
function watchdog(now) {
  if (S.phase !== 'game' || worldBuilding || reconnecting || S.tripOver || S.gpuLost || !net.connected()) {
    if (lagShown) { lagShown = false; connOverlay(null); }
    return;
  }
  const quiet = now - net.lastMessageAt();
  if (quiet > 15000) { lagShown = false; net.close(4005, 'timeout'); reconnect(); return; }
  if ((quiet > 3000) !== lagShown) { lagShown = quiet > 3000; connOverlay(lagShown ? 'Connection problem… waiting for the host' : null); }
}

// ---- network ------------------------------------------------------------------------------

net.on('welcome', m => {
  menuBusy(null);
  const back = S.phase === 'game';          // a reconnect: the game's screen is already up
  S.selfId = m.id; S.code = m.code;
  welcomeWait?.resolve(m);
  // say whether this page is in voice: a reloaded page rejoins its seat out of voice (the host forgets it:
  // room.js resume), a reconnected one that's still in voice says so again
  net.send({ t: 'voice', on: !!voice.V.on });
  if (back) return;
  hostLeft = null;
  $('menuError').textContent = '';
  $('menu').classList.add('hidden');
  $('game').classList.remove('hidden');
  S.phase = 'game';
  $('clickToPlay').classList.remove('hidden');
  voice.initVoice(m.id, renderVoiceUI);
  renderVoiceUI();
  // the trip code (the gate's keypad wants a different one): in the browser build at once; a desktop
  // host's once its Steam lobby is up (a code nobody can find yet would only mislead); a guest who came
  // in over Steam has the host's, to pass on
  menuStatus('');
  $('hCode').classList.add('hidden');
  if (!DESK || S.viaSteam) showTripCode(m.code);
  if (STEAM && S.viaSteam) $('ctpInvite').classList.remove('hidden');
  if (DESK && S.hosting) startHosting(m.code);
  else if (!DESK && S.hosting) announceCode(m.code);
  updatePresence();
  if (!localStorage.getItem('nmdHelpSeen')) { $('help').classList.remove('hidden'); localStorage.setItem('nmdHelpSeen', '1'); }
});
net.on('session', m => { showVersion(m.build); try { sessionStorage.setItem('nmdSession', JSON.stringify({ code: S.code, token: m.resume })); } catch {} });
net.on('hostleft', m => { hostLeft = m.msg || 'The host ended the trip.'; });
net.on('error', m => {
  menuBusy(null); menuStatus('');
  if (welcomeWait) { welcomeWait.reject(m); return; }
  if (S.phase === 'menu' && S.viaSteam) { S.viaSteam = false; net.close(); DESK?.leave(); }
  if (S.phase === 'menu') $('menuError').textContent = m.msg; else toast(m.msg, '#ff8a80');
});
net.on('_close', ev => {
  const waiting = $('hostBtn').disabled;
  menuBusy(null);
  if (S.phase === 'menu') {
    // the trip closed before its welcome came (the host left, or Steam lost them on the way in)
    if (waiting || S.viaSteam) { menuStatus(''); $('menuError').textContent = hostLeft || 'Lost the connection. Try again.'; }
    if (S.viaSteam) { S.viaSteam = false; DESK?.leave(); }
    hostLeft = null;
    return;
  }
  if (S.tripOver) return;
  if (hostLeft || ev.code === 4000) return endTrip(hostLeft || 'The host ended the trip.');
  if (ev.code === 4002) return endTrip('You joined this trip again from somewhere else.');
  reconnect();
});
net.on('world', m => {
  me.hasHook = false;   // a new world comes with the hook on its winch
  me.holding = null;    // and with empty hands: a new day (or a seat taken back after a dropped connection)
                        // holds nothing for you. A map kept in hand overnight showed the next day's map in camp
  // back after a dropped connection, on the same day: the world is already built (the props, the
  // teleport and the rest follow as usual)
  if (S.W && !worldBuilding && S.seed === m.seed && S.dayLabel === m.day) {
    S.door = !!m.door;
    net.send({ t: 'ready' });
    return;
  }
  const newDay = S.dayLabel != null && S.dayLabel !== m.day;
  buildDay(m).then(built => {
    if (!built) return;
    net.send({ t: 'ready' });   // snapshots wait for this (a page still building would only drop them)
    if (newDay) { sfx.day(); flash(`DAY ${m.day}`); }
  }, e => {
    worldBuilding = false;
    loadingBar(false);
    (window.reportError || console.error)(e);
    netModal('Couldn\'t build the day', String(e?.message || e), [['Try again', () => { $('netModal')?.remove(); buildDay(m).then(ok => { if (ok) net.send({ t: 'ready' }); }, () => backToMenu('The day couldn\'t be built.')); }], ['Back to menu', () => backToMenu(null)]]);
  });
  $('receipt').classList.add('hidden');
  $('overScreen').classList.add('hidden');
});
net.on('props', m => afterWorld(() => {
  for (const id of [...S.props.keys()]) removeProp(id);
  for (const d of m.list) addProp(d);
}));
net.on('tp', m => afterWorld(() => { me.teleport(m.x, m.y, m.z, m.yaw); me.mode = 'walk'; }));
// A roster update during a build waits for it (the build used to block it out): what it paints
// (portraits, other players' looks, your hands in your color) comes after the town's people, as
// before. The character painter's pixels depend on what it painted before (texmanifest IN_ORDER).
net.on('meta', inOrder(onMeta));
function onMeta(m) {
  S.meta = m;
  voice.syncPeers(m.players.map(p => ({ ...p, connected: true })));
  renderVoiceUI();
  const mine = m.players.find(p => p.id === S.selfId);
  if (mine) { hands.setColor(mine.color); S.myWalkie = mine.walkie; S.myColor = mine.color; me.hat = !!mine.hat; }
  // my kit as the host's server has it (the Garage's perks: shared/garage.js), and the RV's fitted parts
  if (mine) { S.myKit = mine.kit || null; me.mods = kitMods(S.myKit); }
  rvView?.setParts(m.trip?.parts || {});
  // the loan terms: the trip leader can ask for Standard in day-1 camp (a crew of veterans is on Bad Credit)
  const termsBtn = $('ctpTerms'), canAsk = m.host === S.selfId && !!m.trip?.kitOpen && S.g?.ph !== 'over' && (m.trip.tier === 'bad' || m.trip.askStd);
  termsBtn.classList.toggle('hidden', !canAsk);
  termsBtn.textContent = m.trip?.askStd ? 'Back to Bad Credit terms' : 'Ask for Standard terms';
  // paint other players' looks while the browser is idle, so someone joining mid-game doesn't stall a frame
  const idle = window.requestIdleCallback || (f => setTimeout(f, 30));
  for (const p of m.players) {
    if (p.id === S.selfId || S.views.has(p.id) || (S.prewarmed ||= new Set()).has(p.id)) continue;
    S.prewarmed.add(p.id);
    idle(() => { try { prewarmPlayer(p); } catch (e) { console.warn('prewarm failed', e); } });
  }
  for (const [id, v] of S.views) {
    const p = m.players.find(q => q.id === id);
    if (!p) { v.dispose(scene); S.views.delete(id); S.lw?.removePlayer(id); S.interp.dropPlayer(id); }
    else v.setName(p.name, p.color);
  }
  $('roster').innerHTML = m.players.map(p => `<div class="pm" data-id="${p.id}" style="--c:${p.color}"><span class="pf"${portraitAttrs(p.color, p.id)}><b>${escapeHtml((Array.from(String(p.name).trim())[0] || '?').toUpperCase())}</b>${p.id === m.host ? '<i class="ico ico-crown" title="trip leader"></i>' : ''}${p.voice ? '<i class="ico ico-speaker" title="in voice"></i>' : ''}${p.walkie ? '<i class="ico ico-walkie" title="has a walkie"></i>' : ''}</span><span class="pn"><span class="nm">${escapeHtml(p.name)}</span>${m.roles?.drv === p.id ? '<em class="role">driver</em>' : m.roles?.nav === p.id ? '<em class="role">map</em>' : ''}</span><span class="pb"><i></i><em></em>${p.id === S.selfId ? '<s></s>' : ''}</span></div>`).join('');   // hud() drives the bars
}
net.on('s', m => {
  if (!S.W || worldBuilding) return;
  S.interp.push(m, performance.now());
  S.g = m.g;
  if (!m.g.gb && S.glove?.length) S.glove = [];   // (a new trip: an empty glovebox)
  setBeaconRange(m.g.ph === 'night' || m.g.clk >= 20 ? me.mods.farNight : me.mods.far);   // (Keen Eye)
  onPhase(m.g.ph);
  updatePresence();
  S.door = !!m.g.door;
  for (const id of m.g.gates) if (!S.gatesOpen.has(id)) { S.gatesOpen.add(id); S.lw.openGate(id); const gv = S.wv.gates.get(id); if (gv) gv.target = 1; }
});
net.on('toast', inOrder(m => toast(m.text, m.color, m.secs)));
net.on('knock', inOrder(m => {
  const n = me.events.length;
  me.knock(m.v, m.ko, m.why || 'rv', !!m.rel, S.rv);
  // (what the knock did, told now: the next frame's update starts a fresh list. A knockout from the server
  // (a rock, a toss, the RV) never used to reach it: no pick-up, no bill, and a hard hat that never wore out)
  for (const e of me.events.splice(n)) meEvent(e);
  if ((m.why === 'shove' || m.why === 'nip' || m.why === 'bean') && !m.ko) { sfx.stumble(); shake(0.3); } else { sfx.knock(); shake(0.6); }
}));
// what my body did (this frame's update, or a knock just now): its sounds, and what the server must hear
function meEvent(e) {
  if (e.k === 'step') sfx.step();
  else if (e.k === 'climbstep') sfx.climb();
  else if (e.k === 'jump') sfx.jump();
  else if (e.k === 'land') { sfx.land(e.s); if (e.s > 9) shake(Math.min(0.5, e.s / 30)); }
  else if (e.k === 'grabwall') sfx.wall();
  else if (e.k === 'lunge') sfx.lunge();
  else if (e.k === 'letgo' || e.k === 'exhausted') { sfx.letgo(); if (e.k === 'exhausted') toast('Out of stamina — you let go.', '#ffb4a2', 2); }
  else if (e.k === 'mantle') sfx.grab();
  else if (e.k === 'lurch') { sfx.thunk(Math.min(1, e.a / 20)); shake(Math.min(0.6, e.a / 40)); }
  else if (e.k === 'hat') { net.send({ t: 'hat', why: e.why }); sfx.clang(); shake(0.35); }
  else if (e.k === 'ko') { net.send({ t: 'ko', why: e.why }); sfx.ko(); if (me.holding) onGrabRelease(); if (me.hasHook) { net.send({ t: 'use', kind: 'dropHook' }); me.hasHook = false; } }
  else if (e.k === 'wake') { net.send({ t: 'wake' }); sfx.wake(); }
}
net.on('seat', inOrder(m => {
  if (m.seat == null) { me.unsit(m.exit); }
  else { if (me.holding) onGrabRelease(); me.sit(m.seat); }
}));
// the server's answer to a grab: no, and the hands are empty again; yes, and (the map) its sheet can go up
net.on('grabbed', inOrder(m => { if (me.holding?.id !== m.id) return; if (m.ok) me.holding.ok = true; else me.holding = null; }));
net.on('hooked', inOrder(m => { me.hasHook = !!m.on; if (m.on) sfx.hook(); }));
net.on('drink', inOrder(() => { me.buffT = 60; me.stamina = me.stamMax; sfx.drink(); }));
net.on('revived', inOrder(m => { me.revive(m.stam); sfx.wake(); }));   // (stam: a Medic Bag gets you up with more)
net.on('emote', inOrder(m => { const v = S.views.get(m.id); if (v) v.emote = { e: m.e, t: 3 }; if (m.id === S.selfId) toast(`you: ${m.e}`, '#fff', 1.5); }));
net.on('ping', inOrder(addPing));
net.on('receipt', inOrder(showReceipt));
net.on('over', inOrder(showOver));
// a trip's summary for my save (sent after the game-over; held by the server till this page says it has it,
// so one that arrives on a reconnect is a trip that ended while I was away)
net.on('trip', inOrder(m => {
  const res = credit(m, { acceptTest: !!S.acceptTestRuns });
  // the server holds it till the page says it's saved (a failed write: it comes again on the next welcome)
  res.saved.then(ok => { if (ok) net.send({ t: 'tripAck', run: m.run }); });
  if (res.dup) return;   // (already shown: the game-over keeps its lines, see showOver)
  S.lastTrip = { m, res };
  if (res.unlocked?.length) sendKit();   // (a perk the trip unlocked takes an empty slot: the next trip has it)
  if (m.run === S.overRun && !$('overScreen').classList.contains('hidden')) { const el = $('overRecords'); if (el) el.innerHTML = recordLines(m, res); }
  else if (res.counted) toast(`Your last trip (${m.won ? 'paid off' : 'repo\'d'}) is in your Logbook${res.newRecords.length ? ': a new record!' : '.'} (G)`, '#ffd166', 6);
}));
// what's in the glovebox already (on joining a trip): its cards flipped up as they go in after that
net.on('glovebox', inOrder(m => { S.glove = Array.isArray(m.list) ? m.list : []; }));
net.on('ev', m => afterWorld(() => { for (const e of m.list) onEvent(e); }));

function onEvent(e) {
  switch (e.k) {
    case 'spawn': afterWorld(() => addProp(e.p)); break;
    case 'break': {
      const p = S.props.get(e.id);
      if (p) { removeProp(e.id, { color: '#ffffff', n: 22, speed: 5 }); }
      positional(e, () => sfx.shatter());
      floatText(e, `-${fmt$(e.lost)}`, '#ff5252');
      break;
    }
    case 'dmg': {
      const p = S.props.get(e.id);
      if (p) { p.value = e.value; if (e.lost >= 15) { floatText(p.mesh.position, `-${fmt$(e.lost)}`, '#ffb4a2'); positional(p.mesh.position, () => sfx.thunk(Math.min(1, e.lost / 120))); } }
      break;
    }
    case 'sold': for (const id of e.ids) removeProp(id, { color: '#7CFC00', n: 10, speed: 3 }); sfx.kaching(); break;
    // Road Cards into the glovebox (a tin set down in the RV, or a card Ed found in what he bought): the
    // glovebox clicks, and the cards flip up at the bottom of the screen
    case 'stow': (S.glove ||= []).push({ cards: e.cards, kind: e.kind, day: S.g?.day, by: e.by }); revealCards(e); sfx.click(); break;
    case 'bill': sfx.bill(); break;
    case 'horn': sfx.horn(); break;
    case 'door': S.door = e.open; sfx.door(); if (e.pop && S.rv) { positional(S.rv.p, () => sfx.thunk(0.7), 50); if (me.par) shake(0.3); } break;
    // the RV took a knock (the server priced it): how much, where it landed, a thud, a jolt for whoever's aboard
    case 'rvhit': {
      const at = e.at ? { x: e.at[0], y: e.at[1], z: e.at[2] } : S.rv?.p;
      if (at) floatText(at, `-${e.amt}% RV`, '#ff8a65');
      positional(at, () => sfx.crunch(e.amt), 70);
      // (where it landed, for the dents: the sides by the hit's zone; rocks on the roof dent no side)
      if (['front', 'rear', 'left', 'right'].includes(e.zone)) { S.rvZones ||= {}; S.rvZones[e.zone] = (S.rvZones[e.zone] || 0) + e.amt; }
      if (me.par || me.mode === 'seat') shake(Math.min(0.6, 0.12 + e.amt / 40));
      rvFlash();
      break;
    }
    case 'rvfix': {
      const at = S.rv ? toWorld(S.rv.p, S.rv.q, RV_HATCH) : null;
      if (at) { floatText(at, `RUNNING · RV ${e.hp}%`, '#7CFC00'); burst(at, '#cfcfcf', 10, 1.5, 0.2, 1.2); }
      positional(at, () => sfx.crank(), 50);
      break;
    }
    case 'hook':
      sfx.hook();
      if (e.what === 'yanked' && e.by === S.selfId) { me.hasHook = false; toast('The cable ran out — the hook got yanked out of your hands.', '#ffb4a2'); }
      if (e.what === 'stowed') me.hasHook = false;   // back on the winch (nightfall, a tow): nobody holds it
      break;
    case 'reel':
      // the server rips the hook out of whoever holds it when the winch starts reeling
      if (e.on && me.hasHook) { me.hasHook = false; toast('The winch ripped the hook out of your hands.', '#ffb4a2'); }
      else toast(e.on ? 'Winch reeling in…' : 'Winch stopped.', '#f2c14e', 2);
      break;
    case 'creak': sfx.creak(); break;
    case 'gate': sfx.gate(); break;
    case 'buzz': sfx.buzz(); break;
    case 'slip': if (e.by === S.selfId) { me.holding = null; toast({ bean: 'Beaned! You dropped it.', bite: 'OW. It bit you, and you let go.', wriggle: 'It wriggled free.', nip: 'A ringtail nipped you, and you dropped it. Keep away from their den, or see them off first.', rock: 'A rock bowled you over, and you dropped it.' }[e.why] || 'It slipped out of your hands.', '#ffb4a2', e.why === 'nip' ? 4 : 2); } break;
    case 'throw': break;
    // a game settled: your own is a fanfare; a friend's win rings the till (the bank went up), a loss is quiet
    case 'bet': S.bets = (S.bets || 0) + 1; S.lastBet = e; (S.betLog ||= []).push(e); if (S.betLog.length > 20) S.betLog.shift(); (e.by === S.selfId ? (e.won > 0 ? sfx.win : e.won < 0 ? sfx.lose : sfx.click) : e.won > 0 ? sfx.kaching : () => {})(); break;
    // a coin spun, the dice thrown: heard at the machine or the table
    case 'flip': case 'dice': { const st = casStation(e.s), y = S.W?.town?.casino?.y ?? 0; sfxAt(st ? { x: st.x, y: y + 1, z: st.z } : null, e.k === 'flip' ? sfx.coin : sfx.dice); break; }
    case 'repo': shake(0.4); break;   // (the game-over screen that follows plays the Repo Man's sting)
    // somebody else knocked about: heard where they are (my own knock has its own sound)
    case 'thud': { const o = e.id !== S.selfId && S.others?.get(e.id); if (o) positional(o.pos, () => sfx.thunk(e.why === 'shove' ? 0.5 : 1), 40); break; }
    // the wildlife leaves for the night (or a critter gives up for the day): a puff of dust where each one was
    case 'gone': for (const id of e.ids || []) removeProp(id, { color: '#cdbb9a', n: 12, speed: 2.5 }); break;
    case 'mob': onMobEvent(e); break;
    case 'bean': { const o = S.others?.get(e.id); positional(e.id === S.selfId ? null : o?.pos, () => sfx.bonk(), 40); break; }
    case 'shove': S.lastShove = e; positional({ x: e.at[0], y: e.at[1], z: e.at[2] }, () => { if (e.by !== S.selfId) sfx.whoosh(); if (e.hit) sfx.thunk(0.6); }); break;
  }
}

// the cards going into the glovebox, for 4 s (NEW against my own Album)
let revealTimer = 0;
function revealCards(e) {
  let el = $('cardReveal');
  if (!el) { el = document.createElement('div'); el.id = 'cardReveal'; el.className = 'hidden'; document.body.appendChild(el); }
  const p = profile(), n = e.cards.length, name = LOOT[e.kind]?.name || 'tin';
  const title = e.by === 'Ed' ? `Ed pried the ${name} open: a Road Card` : `${e.by ? escapeHtml(e.by) : 'Somebody'} set a ${name} down in the RV: ${n} card${n > 1 ? 's' : ''}`;
  el.innerHTML = `<div class="rv-title">${title} · in the glovebox</div><div class="rv-cards">${e.cards.map(id => cardHTML(id, { fresh: !p.cards[id] && !p.seen.includes(id) })).join('')}</div>`;
  el.classList.remove('hidden');
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => el.classList.add('hidden'), 4000);
}

// what the wildlife does, heard and seen (the server words the toasts)
function onMobEvent(e) {
  const p = S.props.get(e.id), at = p?.mesh.position;
  const near = at ? at.distanceTo(camera.position) : 99;
  switch (e.s) {
    case 'wake': positional(at, () => sfx.bellow(), 90); break;
    case 'glare': positional(at, () => sfx.snort(), 40); break;
    case 'charge': positional(at, () => { sfx.stampede(); sfx.clang(); }, 70); if (near < 10) shake(0.35); break;
    case 'toss': positional(at, () => sfx.thunk(1), 60); if (near < 12) shake(0.5); break;
    case 'winded': positional(at, () => sfx.snort(), 30); if (at) puff(at.clone().add(new THREE.Vector3(0, 0.3, 0)), '#e8e4dc'); break;
    case 'leave': positional(at, () => sfx.clang(), 60); tutDone('grumph'); break;
    // tipped over by two friends: a thump, and it lies on that side for a while
    case 'tip': { positional(at, () => sfx.thunk(1.3), 60); const p = S.props.get(e.id); if (p?.view) p.view.tipSide = e.side; break; }
    // the ringtails: a yoink as they make off with something (a STOLEN tag rides on it for a while), the
    // jaws letting go, a squeal when they're held, stunned or run over
    case 'steal': {
      positional(at, () => sfx.yoink(), 45);
      const it = S.props.get(e.item);
      // (the stop's own loot that nobody had touched yet: not yours to lose, but there it goes)
      if (it) { floatText(it.mesh.position, e.ours === false || LOOT[it.type]?.find ? 'YOINK!' : `STOLEN ${fmt$(e.value)}`, '#ff6b5a'); markStolen(e.item); }
      break;
    }
    case 'stash': case 'trapped': positional(at, () => sfx.chitter(), 25); break;
    case 'drop': positional(at, () => sfx.snap(), 25); unmark(e.item); break;
    case 'bite':
      positional(at, () => { sfx.snap(); sfx.squeal(); }, 30);
      if (e.by === S.selfId) { me.spend(RT.BITE_STAMINA); shake(0.25); }
      break;
    case 'wriggle': positional(at, () => sfx.squeal(), 30); break;
    case 'stun': positional(at, () => sfx.bonk(), 30); break;
    case 'nip': positional(at, () => { sfx.snap(); sfx.chitter(); }, 30); if (e.by === S.selfId) tutDone('den'); break;
    case 'squash': positional(at, () => { sfx.squeal(); sfx.thunk(0.5); }, 40); break;
    // a rockfall: the rumble and dust off the lip (a moment to get clear), each rock cracking loose, a hit
    case 'rumble': {
      (S.rockDown ||= new Set()).add(e.rf);
      tutDone('rock');
      const rim = (e.rim || []).map(([x, y, z]) => new THREE.Vector3(x, y, z)), mid = rim[Math.floor(rim.length / 2)];
      if (!mid) break;
      positional(mid, () => sfx.rumble(), 110);
      if (mid.distanceTo(camera.position) < 45) shake(0.3);
      for (let k = 0; k < 3; k++) setTimeout(() => { for (const p of rim) burst(p, '#a8957a', 5, 1.6, 0.3, 1.4); }, k * 450);
      break;
    }
    case 'rockfall': positional(at, () => sfx.crack(), 70); if (at) burst(at, '#a8957a', 6, 2, 0.5); break;
    case 'rockhit': positional(at, () => sfx.thunk(1), 50); break;
    case 'recovered': {
      unmark(e.item);
      const it = S.props.get(e.item);
      if (it) floatText(it.mesh.position, LOOT[it.type]?.find ? 'GOT IT BACK' : `GOT IT BACK ${fmt$(e.value)}`, '#7CFC00');
      break;
    }
  }
}

function escapeHtml(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function showReceipt(m) {
  const row = (k, v, cls = '') => `<div class="rrow ${cls}"><span>${k}</span><b>${v}</b></div>`;
  $('receipt').innerHTML = `
    <h2>Day ${m.day} Receipt</h2>
    <div class="filigree"></div>
    ${row('Pawned', (m.sold ? '+' : '') + fmt$(m.sold), m.sold ? 'good' : '')}
    ${row('Gambling', (m.gamble > 0 ? '+' : '') + fmt$(m.gamble), m.gamble > 0 ? 'good' : m.gamble < 0 ? 'bad' : '')}
    ${row('Medical bills', (m.bills ? '-' : '') + fmt$(m.bills), m.bills ? 'bad' : '')}
    ${row('Loot broken', fmt$(m.broken) + ' of stuff', m.broken ? 'bad' : '')}
    ${m.stolen ? row('Stolen by ringtails', `${fmt$(m.stolen)}${m.recovered ? ` (got ${fmt$(m.recovered)} back)` : ''}`, m.recovered >= m.stolen ? '' : 'bad') : ''}
    ${m.rv ? row('The RV', `${m.rv.hp}%${m.rv.today ? ` (-${m.rv.today}% today: ${rvBlame(m.rv.src)})` : ''}`, m.rv.today ? 'bad' : '') : ''}
    ${row('Payment', `PAID ${fmt$(m.due)}${m.paidAt != null ? ` at ${fmtClockH(m.paidAt)}${paidBest(m) ? ` <small>(your best day ${m.day}: ${fmtClockH(paidBest(m))})</small>` : ''}` : ''}`, 'good')}
    ${row('Bank', fmt$(m.bank))}
    ${m.rv && m.rv.hp < 100 ? `<p class="hint">Gus fixes it by the lot tonight: ${m.rv.quote.pts}% for ${fmt$(m.rv.quote.cash)}, or ${fmt$(m.rv.quote.loan)} on ${m.day === C.DAYS - 1 ? 'the balloon payment' : 'tomorrow\'s payment'}.</p>` : ''}
    <p class="hint">Campfire's lit. The store is open. When everyone's in a bunk (E on the bed in the RV), day ${m.day + 1} starts.</p>
    <button class="btn small green" id="receiptClose">[E] Okay</button>`;
  $('receipt').classList.remove('hidden');
  $('receiptClose').onclick = () => $('receipt').classList.add('hidden');
  sfx.sleep();
}
// my best time of day for paying this day (any whole trip on Standard terms), from my save
const paidBest = m => profile()?.best.std.splits[m.day - 1]?.h ?? null;
// who and what dented the RV today, worst first ('Sam -18%, the Grumphorn -8%, rocks -9%')
function rvBlame(src) {
  return Object.entries(src || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${escapeHtml(k === 'nobody' ? 'nobody at the wheel' : k)} -${v}%`).join(', ');
}
let overTimer = 0;
function showOver(m) {
  const s = m.stats || {};
  S.overRun = m.run?.id ?? null;
  const practice = m.run?.practice === 'seed' ? '<p class="hint">Practice trip (typed seed): it counts only on that seed\'s board in your Logbook.</p>'
    : m.run?.practice === 'test' ? '<p class="hint">Test trip: nothing is recorded.</p>' : '';
  $('overScreen').innerHTML = m.won
    ? `<h1 class="won">You Own the RV</h1><div class="filigree"></div><p>Five days, ${fmt$(s.sold || 0)} of pawned junk, and the Slopmaster 9000 is finally, legally, yours.</p>`
    : `<h1 class="lost">Repo'd</h1><div class="filigree"></div><p>Day ${m.day} of ${C.DAYS}. ${m.short > 0 ? `${fmt$(m.short)} short of the ${fmt$(m.due)} ${m.day >= C.DAYS ? 'balloon payment' : 'payment'} at midnight. ` : ''}The Repo Man hooks the Slopmaster and drives off into the sunset without you.</p>`;
  $('overScreen').innerHTML += `
    <div class="rrow"><span>Pawned in total</span><b>${fmt$(s.sold || 0)}</b></div>
    <div class="rrow"><span>Medical bills</span><b>${fmt$(s.bills || 0)}</b></div>
    <div class="rrow"><span>Loot destroyed</span><b>${fmt$(s.broken || 0)}</b></div>
    <div class="rrow"><span>Knockouts</span><b>${s.kos || 0}</b></div>
    ${s.stolen ? `<div class="rrow"><span>Stolen by ringtails</span><b>${fmt$(s.stolen)} (got ${fmt$(s.recovered || 0)} back)</b></div>` : ''}
    ${!m.won && m.short > 0 && s.stolen - (s.recovered || 0) >= m.short ? `<div class="rrow bad"><span>The ringtails cost you the RV.</span><b></b></div>` : ''}
    ${s.beasts ? `<div class="rrow good"><span>Grumphorns seen off</span><b>${s.beasts}</b></div>` : ''}
    ${s.rv ? `<div class="rrow${s.rv.end <= 30 ? ' bad' : ''}"><span>The RV at the end</span><b>${s.rv.end}%${s.rv.breakdowns ? ` (broke down ${s.rv.breakdowns === 1 ? 'once' : `${s.rv.breakdowns} times`})` : ''}</b></div>` : ''}
    ${s.rv?.crashes ? `<div class="rrow"><span>Crashes</span><b>${s.rv.crashes}${s.rv.worst ? ` (worst: ${escapeHtml(s.rv.worst.by || 'nobody')} into ${escapeHtml(s.rv.worst.what || 'something')}, -${s.rv.worst.amt}%)` : ''}</b></div>` : ''}
    ${s.rv?.cash || s.rv?.loan ? `<div class="rrow"><span>Gus's repairs</span><b>${[s.rv.cash ? `${fmt$(s.rv.cash)} cash` : '', s.rv.loan ? `${fmt$(s.rv.loan)} on the loan` : ''].filter(Boolean).join(' + ')}</b></div>` : ''}
    ${s.beanings ? `<div class="rrow"><span>Friends beaned</span><b>${s.beanings}</b></div>` : ''}
    ${s.bestWin ? `<div class="rrow good"><span>Best bet</span><b>${escapeHtml(s.bestWin.name || 'the crew')} +${fmt$(s.bestWin.amt)} (${s.bestWin.game})</b></div>` : ''}
    ${s.worstLoss ? `<div class="rrow bad"><span>Worst bet</span><b>${escapeHtml(s.worstLoss.name || 'the crew')} ${fmt$(s.worstLoss.amt)} (${s.worstLoss.game})</b></div>` : ''}
    ${m.run?.tier === 'bad' ? '<div class="rrow bad"><span>Loan terms</span><b>BAD CREDIT (payments +15%)</b></div>' : ''}
    <div id="overRecords">${S.lastTrip?.m.run === S.overRun && S.overRun ? recordLines(S.lastTrip.m, S.lastTrip.res) : ''}</div>
    ${practice}
    <p class="hint" id="overNext"></p>
    <div class="row"><button class="btn small pink" id="overLeave">Leave Trip</button></div>`;
  $('overScreen').classList.remove('hidden');
  $('overLeave').onclick = () => {
    const wait = waitingSummaries();
    if (!wait) { backToMenu(null); return; }
    netModal('Leave the trip?', 'The trip runs on your PC: if you leave, it ends for everyone.' + wait, [['Leave', () => backToMenu(null)], ['Stay', () => $('netModal')?.remove()]]);
  };
  const until = performance.now() + (m.next ?? 25) * 1000;
  clearInterval(overTimer);
  overTimer = setInterval(() => {
    const left = Math.ceil((until - performance.now()) / 1000);
    if (!$('overNext') || left < 0) { clearInterval(overTimer); return; }
    $('overNext').textContent = left > 0 ? `A new trip starts in ${left} s.` : 'Starting a new trip…';
  }, 250);
  document.exitPointerLock?.();
  (m.won ? sfx.owned : sfx.repo)();
}

// ---- little fx -------------------------------------------------------------------------------

const particles = [];
const chipGeo = new THREE.BoxGeometry(0.06, 0.06, 0.06);   // one shared shape (flat() caches the materials)
function burst(at, color, n = 12, speed = 4, grav = 1, life = 1.2) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(chipGeo, flat(color));
    m.position.copy(at);
    scene.add(m);
    particles.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed), life, g: grav });
  }
}
// steam from a nostril, dust from a hoof: a few chips drifting up and away
const puff = (at, color) => burst(at, color, 4, 0.9, -0.08, 0.9);
const floaters = [];
function floatText(at, text, color) {
  const s = labelSprite(text, color, 44);
  s.position.set(at.x, at.y + 0.6, at.z);
  scene.add(s);
  floaters.push({ s, life: 1.6 });
}
function addPing(m) {
  const s = labelSprite('📍', '#fff', 64);
  s.scale.set(1.2, 0.6, 1);
  s.position.set(m.pt[0], m.pt[1] + 0.8, m.pt[2]);
  s.material.depthTest = false;
  scene.add(s);
  floaters.push({ s, life: 5, ping: true });
  sfx.ping();
}
// a red $ riding on something a ringtail just took, for a few seconds (so you can see where it went)
const marks = [];
let markMat = null;
function markStolen(id) {
  if (!markMat) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    g.font = 'bold 54px Georgia, serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = 7; g.strokeStyle = '#3a0a06'; g.strokeText('$', 32, 34);
    g.fillStyle = '#ff4a3a'; g.fillText('$', 32, 34);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    markMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false });
  }
  unmark(id);
  const sp = new THREE.Sprite(markMat);
  sp.scale.set(0.4, 0.4, 1);
  sp.renderOrder = 10;
  scene.add(sp);
  marks.push({ id, sp, until: performance.now() + 6000 });
}
function unmark(id) { for (let i = marks.length - 1; i >= 0; i--) if (marks[i].id === id) { scene.remove(marks[i].sp); marks.splice(i, 1); } }
let shakeAmt = 0;
function shake(a) { shakeAmt = Math.max(shakeAmt, a); }
function flash(text) {
  $('flash').textContent = text;
  $('flash').classList.remove('hidden');
  $('flash').style.animation = 'none'; void $('flash').offsetWidth; $('flash').style.animation = '';
  setTimeout(() => $('flash').classList.add('hidden'), 2600);
}
// range: how far off it can still be heard (a beast's bellow carries further than a thud)
function positional(at, fn, range = 60) {
  if (!at) return fn();
  const d = Math.hypot(at.x - camera.position.x, at.y - camera.position.y, at.z - camera.position.z);
  if (d < range) sfxAt({ x: at.x, y: at.y, z: at.z }, fn);
}


// ---- sound around you: other players' feet, the engine, brakes; the radio and the casino's band ------

const feet = new Map();          // id -> where they were last frame and how far they've walked since a step
let lastDrv = null, lastRvSpeed = 0, brakeAt = 0;
function worldSounds(dt, rv, rvSpeed, others) {
  for (const [id, st] of others) {
    const here = st.par ? st.lp : st.pos;
    const f = feet.get(id);
    if (!f || f.par !== !!st.par) { feet.set(id, { x: here.x, z: here.z, par: !!st.par, walked: 0 }); continue; }
    const d = Math.hypot(here.x - f.x, here.z - f.z);
    f.x = here.x; f.z = here.z;
    if (st.mode !== C.MODE.WALK || d / Math.max(dt, 1e-3) < 0.8 || d > 2) continue;
    f.walked += d;
    if (f.walked > 1.7) {
      f.walked = 0;
      if (Math.hypot(st.pos.x - camera.position.x, st.pos.z - camera.position.z) < 25) sfxAt(st.pos, () => sfx.step(0.9));
    }
  }
  for (const id of feet.keys()) if (!others.has(id)) feet.delete(id);
  // the engine turning over or dying, and the brakes when the RV slows hard
  const drv = S.g?.drv ?? null;
  if (rv && lastDrv !== null && !!drv !== !!lastDrv) sfxAt(rv.p, () => (drv ? sfx.engineStart() : sfx.engineStop()));
  lastDrv = drv;
  if (rv) {
    const decel = (lastRvSpeed - rvSpeed) / Math.max(dt, 1e-3);
    if (rvSpeed > 3 && decel > 5 && performance.now() - brakeAt > 1500) { brakeAt = performance.now(); sfxAt(rv.p, () => sfx.brake(Math.min(1, decel / 10))); }
    lastRvSpeed = rvSpeed;
  }
}

// Music: the menu plays the country station; in a trip, the RV's radio plays while someone drives (from
// the dash: muffled from outside), switching to the 'midnight' station in the last hour before the
// Repo Man; the casino has its lounge band. All of it is music.js, synthesized.
const R = { menu: null, rv: null, casino: null };
function radioIn(out, seed, station) { const r = createRadio(audioCtx(), out, { seed, station }); r.on = false; r.station = station; return r; }
function setRadio(r, on) { if (!r || r.on === on) return; r.on = on; if (on) r.start(0); else r.stop(); }
function place(p, at) { if (p.positionX) { p.positionX.value = at.x; p.positionY.value = at.y; p.positionZ.value = at.z; } else p.setPosition(at.x, at.y, at.z); }
function newDayMusic() {
  // (a new day: a new tune; the old radios fade out and are let go)
  for (const k of ['rv', 'casino']) if (R[k]) { setRadio(R[k], false); const old = R[k]; setTimeout(() => { try { old.out.disconnect(); } catch {} }, 3000); R[k] = null; }
}
function updateMusic(rv, inMyRV) {
  const ctx = audioCtx();
  if (!ctx || ctx.state !== 'running') return;
  if (!R.menu) R.menu = radioIn(bus.music, 7, 'country');
  setRadio(R.menu, S.phase === 'menu');
  if (S.phase !== 'game' || !S.W) { setRadio(R.rv, false); setRadio(R.casino, false); return; }
  const g = S.g;
  if (!R.rv) {
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 20000;
    const pan = panner({ x: 0, y: -1000, z: 0 }, { ref: 4, max: 70, out: bus.music });
    lp.connect(pan);
    R.rv = radioIn(lp, (S.seed || 1) * 7 + (S.dayLabel || 1), 'country');
    R.rv.lp = lp; R.rv.pan = pan; R.rv.out = pan;
  }
  setRadio(R.rv, !!(settings.radio && g?.drv && rv && g.ph !== 'night' && g.ph !== 'over'));
  if (R.rv.on && rv) {
    const late = g.ph === 'road' && g.clk >= 22.5;
    const st = late ? 'midnight' : 'country';
    if (st !== R.rv.station) { R.rv.setStation(st); R.rv.station = st; }
    if (late) R.rv.setTension((g.clk - 22.5) / 1.5);
    place(R.rv.pan, toWorld(rv.p, rv.q, { x: 0, y: 1.3, z: 3.4 }));
    R.rv.lp.frequency.setTargetAtTime(inMyRV ? 20000 : 1300, ctx.currentTime, 0.2);
  }
  const cas = S.W.town?.casino;
  if (cas) {
    if (!R.casino) {
      const pan = panner({ x: cas.x, y: (cas.y ?? S.W.heightAt(cas.x, cas.z)) + 2, z: cas.z }, { ref: 5, max: 45, out: bus.music });
      R.casino = radioIn(pan, 3 + (S.dayLabel || 1), 'lounge');
      R.casino.out = pan;
    }
    setRadio(R.casino, g?.ph !== 'over' && Math.hypot(cas.x - me.pos.x, cas.z - me.pos.z) < 50);
  }
}
// the menu's music starts with the first click (browsers keep audio off until one) or at once in the
// desktop build
const menuTick = () => { if (S.phase === 'menu') updateMusic(null, false); };
setInterval(menuTick, 500);
window.addEventListener('pointerdown', () => initAudio(), { once: true, capture: true });
if (DESK) initAudio();

// ---- settings (Settings panel: the menu's button, or the Esc card) ---------------------------------

const pct = v => `${Math.round(v * 100)}%`;
const SETTINGS_UI = [
  ['Controls'],
  ['sens', 'Mouse sensitivity', 'range', 0.3, 2.5, 0.05, v => v.toFixed(2)],
  ['invertY', 'Invert mouse up and down', 'check'],
  ['fov', 'Field of view', 'range', 60, 100, 1, v => `${v}°`],
  ['Audio'],
  ['master', 'Master volume', 'range', 0, 1, 0.05, pct],
  ['music', 'Music', 'range', 0, 1, 0.05, pct],
  ['sfx', 'Sound effects', 'range', 0, 1, 0.05, pct],
  ['amb', 'Ambience', 'range', 0, 1, 0.05, pct],
  ['voice', 'Voice chat', 'range', 0, 1, 0.05, pct],
  ['radio', 'The RV radio plays while someone drives', 'check'],
  ['muteInBackground', 'Mute when the game is in the background', 'check'],
  ['Video'],
  ['quality', 'Graphics', 'select', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]],
  ['fpsCap', 'Frame rate limit', 'select', [[0, 'None'], [30, '30'], [60, '60'], [120, '120']]],
  ['Interface'],
  ['uiScale', 'Interface size', 'range', 0.8, 1.6, 0.05, pct],
  ['tutorial', 'First-trip hints in the quest tracker', 'check'],
];
function renderSettings() {
  const body = $('settingsBody');
  body.innerHTML = '';
  for (const [k, label, kind, ...a] of SETTINGS_UI) {
    if (!label) { const h = document.createElement('h3'); h.textContent = k; body.appendChild(h); continue; }
    const row = document.createElement('label'); row.className = 'srow';
    const name = document.createElement('span'); name.textContent = label;
    const val = document.createElement('span'); val.className = 'sval';
    let input;
    if (kind === 'range') {
      input = document.createElement('input'); input.type = 'range'; input.min = a[0]; input.max = a[1]; input.step = a[2]; input.value = settings[k];
      val.textContent = a[3](settings[k]);
      input.oninput = () => { setSetting(k, input.value); val.textContent = a[3](settings[k]); };
    } else if (kind === 'check') {
      input = document.createElement('input'); input.type = 'checkbox'; input.checked = settings[k];
      input.onchange = () => setSetting(k, input.checked);
    } else {
      input = document.createElement('select');
      for (const [v, t] of a[0]) { const o = document.createElement('option'); o.value = v; o.textContent = t; if (String(settings[k]) === String(v)) o.selected = true; input.appendChild(o); }
      input.onchange = () => setSetting(k, input.value);
      if (k === 'quality') val.textContent = settings.quality === 'auto' ? S.quality : '';
    }
    input.dataset.setting = k;
    row.append(name, input, val);
    body.appendChild(row);
  }
  if (DESK) {
    const row = document.createElement('div'); row.className = 'srow';
    const name = document.createElement('span'); name.textContent = 'Fullscreen (F11)';
    const b = document.createElement('button'); b.className = 'btn small gray'; b.textContent = 'Toggle';
    b.onclick = () => DESK.setFullscreen(null);
    row.append(name, b, document.createElement('span'));
    $('settingsBody').appendChild(row);
  }
}
function openPanel(id) {
  document.exitPointerLock?.();
  if (id === 'settings') renderSettings();
  if (id === 'garage') renderGarage();
  $(id).classList.remove('hidden');
  $('clickToPlay').classList.add('hidden');
}
function closePanel(id) {
  $(id).classList.add('hidden');
  if (S.phase === 'game' && !locked) $('clickToPlay').classList.remove('hidden');
}
$('settingsBtn').onclick = () => { sfx.click(); openPanel('settings'); };
$('garageBtn').onclick = () => { sfx.click(); openPanel('garage'); };
$('ctpGarage').onclick = () => openPanel('garage');
$('ctpTerms').onclick = () => { sfx.click(); net.send({ t: 'terms', std: !S.meta?.trip?.askStd }); };
$('garageClose').onclick = () => closePanel('garage');
initGarage({ canImport: () => S.phase === 'menu', glovebox: () => S.glove || [], kitOpen: () => !S.meta || !!S.meta.trip?.kitOpen, onKit: sendKit });
// my kit to the host's server (it takes it in camp on day 1 and during the game-over; otherwise it says so)
function sendKit() { if (S.phase !== 'menu' && S.meta?.trip?.kitOpen) net.send({ t: 'kit', kit: myKit() }); }
$('ctpSettings').onclick = () => openPanel('settings');
$('settingsClose').onclick = () => closePanel('settings');
$('settingsReset').onclick = () => { resetSettings(); renderSettings(); };
$('creditsBtn').onclick = () => { sfx.click(); openPanel('credits'); };
$('creditsClose').onclick = () => closePanel('credits');
for (const b of document.querySelectorAll('.btn')) b.addEventListener('pointerenter', () => sfx.hover());

// graphics quality: 'auto' guesses from the GPU's name, then watches the first minute of play and steps
// down if frames come too slowly (and says so once). Tools force one with ?quality=high.
const forcedQ = new URLSearchParams(location.search).get('quality');
let autoQ = null;
try { autoQ = localStorage.getItem('nmdAutoQ'); } catch {}
function qualityLevel() {
  if (/^(low|medium|high)$/.test(forcedQ || '')) return forcedQ;
  if (settings.quality !== 'auto') return settings.quality;
  return (autoQ ||= guessQuality());
}
function applyQuality() { const q = qualityLevel(); setRenderQuality(q); setClutterQuality(q); S.quality = q; }
applyQuality();
const probe = { t: 0, frames: [], done: false };
function probeQuality(dt) {
  if (probe.done || settings.quality !== 'auto' || forcedQ || worldBuilding || S.phase !== 'game') return;
  probe.t += dt;
  if (probe.t < 5) return;                 // (the first seconds after a load are never typical)
  probe.frames.push(dt);
  if (probe.t < 20) return;
  probe.done = true;
  const f = probe.frames.sort((a, b) => a - b), p90 = f[Math.floor(f.length * 0.9)] * 1000;
  const down = { high: 'medium', medium: 'low' }[S.quality];
  if (p90 > 30 && down) {
    autoQ = down;
    try { localStorage.setItem('nmdAutoQ', down); } catch {}
    applyQuality();
    toast(`Graphics set to ${down[0].toUpperCase() + down.slice(1)} for this PC (it was running slow). Change it in Settings.`, '#fff', 7);
  }
}
S.gpu = () => ({ name: gpuName(), quality: S.quality });
// the interface grows with the window (900 px tall = 1x, up to 2x) and the Interface size setting
function applyUiScale() {
  const base = Math.min(2, Math.max(1, window.innerHeight / 900)) * (DESK?.steam?.deck ? 1.1 : 1);
  document.documentElement.style.setProperty('--ui-scale', (base * settings.uiScale).toFixed(3));
}
window.addEventListener('resize', applyUiScale);
applyUiScale();
onSettings(k => {
  if (k === 'quality') { applyQuality(); if (S.W) toast('The grass follows on the next day.', '#fff', 3); }
  if (k === 'uiScale') applyUiScale();
  if (k === 'sens') $('sensInput').value = settings.sens;
});

// ---- voice ui (dock + settings panel) ---------------------------------------------------------

const VV = voice.V;
window.__nmdVoice = VV;
function renderVoiceUI() {
  $('voiceJoinBtn').classList.toggle('hidden', VV.on);
  $('voiceJoinBtn').disabled = VV.connecting;
  $('voiceJoinBtn').textContent = VV.connecting ? 'JOINING…' : 'JOIN VOICE';   // the mic icon is painted by CSS
  $('voiceLive').classList.toggle('hidden', !VV.on);
  $('voiceErr').classList.toggle('hidden', !VV.err);
  $('voiceErr').textContent = VV.err || '';
  if (VV.on) {
    $('voiceMuteBtn').textContent = '';   // CSS paints the mic / muted-mic icon from the .off class
    $('voiceMuteBtn').classList.toggle('off', VV.muted);
    $('voiceTxHint').textContent = VV.muted ? `muted (${keyLabel('M')})` : VV.mode === 'ptt' ? (VV.ptt ? 'talking…' : `hold ${keyLabel('V')} to talk`) : 'proximity mic';
  }
  const rows = $('voicePeerRows');
  rows.innerHTML = '';
  for (const [id, peer] of VV.peers) {
    const p = S.meta?.players.find(q => q.id === id);
    const row = document.createElement('div'); row.className = 'voice-peer-row';
    const nm = document.createElement('span'); nm.className = 'vp-name'; nm.style.color = p?.color || '#fff'; nm.textContent = p?.name || `player ${id}`;
    const vol = document.createElement('input'); vol.type = 'range'; vol.min = 0; vol.max = 1.5; vol.step = 0.05; vol.value = peer.vol;
    vol.oninput = () => voice.setPeerVol(id, Number(vol.value));
    const mute = document.createElement('button'); mute.className = 'voice-btn' + (peer.muted ? ' off' : ''); mute.textContent = '';   // CSS paints the speaker / muted icon from the .off class
    mute.onclick = () => voice.togglePeerMute(id);
    row.append(nm, vol, mute); rows.appendChild(row);
  }
  const sel = $('voiceMicSel'); const cur = sel.value; sel.innerHTML = '';
  for (const m of VV.mics) { const o = document.createElement('option'); o.value = m.deviceId; o.textContent = m.label; if (m.deviceId === (VV.micId || cur)) o.selected = true; sel.appendChild(o); }
  if (!VV.mics.length) { const o = document.createElement('option'); o.textContent = 'default mic'; sel.appendChild(o); }
  document.querySelectorAll('input[name=voiceMode]').forEach(r => { r.checked = r.value === VV.mode; });
  $('voiceMasterVol').value = VV.masterVol;
}
$('voiceJoinBtn').onclick = () => { initAudio(); voice.joinVoice(); };
$('voiceLeaveBtn').onclick = () => { voice.leaveVoice(); $('voicePanel').classList.add('hidden'); };
$('voiceMuteBtn').onclick = () => voice.toggleMute();
$('voiceCfgBtn').onclick = () => { $('voicePanel').classList.toggle('hidden'); voice.refreshMics(); if (!$('voicePanel').classList.contains('hidden')) document.exitPointerLock?.(); };
$('voicePanelClose').onclick = () => $('voicePanel').classList.add('hidden');
$('voiceMicSel').onchange = e => voice.setMic(e.target.value);
$('voiceMasterVol').oninput = e => voice.setMasterVol(Number(e.target.value));
document.querySelectorAll('input[name=voiceMode]').forEach(r => { r.onchange = () => voice.setMode(r.value); });
$('sensInput').value = settings.sens;
$('sensInput').oninput = e => setSetting('sens', e.target.value);

// ---- the frame ------------------------------------------------------------------------------

let lastT = performance.now(), time = 0;
const _v = new THREE.Vector3();

// if a frame's logic throws, the view still draws (and the error is reported once per frame, as before)
let lastFrameAt = 0;
function frame(now) {
  // a frame-rate limit (Settings > Video): skip this display refresh if the last frame was too recent
  if (settings.fpsCap && now - lastFrameAt < 1000 / settings.fpsCap - 2) { requestAnimationFrame(frame); return; }
  lastFrameAt = now;
  try { frameInner(now); }
  catch (e) { (window.reportError || console.error)(e); try { if (!S.noRender && S.W && !worldBuilding) render(); } catch {} }
}
function frameInner(now) {
  // test/debug hooks
S.aimAt = (x, y, z) => { const e = me.eye(S.rv); const dx = x - e.x, dy = y - e.y, dz = z - e.z; me.yaw = Math.atan2(dx, dz); me.pitch = -Math.atan2(dy, Math.hypot(dx, dz)); };
S.press = (fn) => ({ grab: onGrabPress, release: onGrabRelease, use: onUse, throw: onThrow, drop: onDrop })[fn]?.();
S.key = (k, down) => { keys[k] = !!down; };   // (a key held or let go, for the tests: the E of a held fix)
S.uiOpen = () => uiOpen();   // (tests: a panel is up, and the game's keys are off)
S.profile = profile; S.profileStatus = profileStatus;   // (tests: this player's save)
S.beacon = beaconRange;   // (tests: how far loot glints reach, Keen Eye's)
S.rvWorld = l => toWorld(S.rv.p, S.rv.q, l); S.rvYaw = () => qYaw(S.rv.q);   // (tests: a spot in the RV, wherever it's parked)
S.target = () => target;
S.send = m => net.send(m);
S.mapUp = () => !!hands?.map?.visible;   // tests: is the road map up on this screen?
S.renderer = () => renderer;   // tools read draw-call counts
S.rvView = () => rvView;       // tests read the RV's condition as it shows (smoke, the dial, the hazard lamps)
requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  time += dt;
  S.frames = (S.frames || 0) + 1;
  S.frameAt = now;
  watchdog(now);
  // while a day loads, the last frame stays up under the loading bar: re-rendering the old scene would
  // only take time from the paint workers (and on a software GPU a night frame costs seconds)
  if (!S.W || worldBuilding || !S.lw) { if (!S.noRender && !worldBuilding) render(); return; }

  const rt = S.interp.time(now);
  S.renderT = rt;
  const rv = rt != null ? S.interp.sampleRV(rt) : null;
  S.rv = rv;
  S.hook = rt != null ? S.interp.sampleHook(rt) : null;
  if (rv) S.lw.setRV(rv.p, rv.q);
  S.lw.setDoor(S.door);
  S.lw.setHook(S.hook && S.hook.state !== 0 ? { x: S.hook.x, y: S.hook.y, z: S.hook.z } : null);
  for (const p of S.props.values()) {
    const s = rt != null ? S.interp.sampleProp(p.id, rt) : null;
    if (!s) continue;
    p.pose = s;
    // (the map hides while it's read: on its reader's screen the sheet is up, everyone else sees it in
    // their hands; held, it would float a metre ahead of them, in front of the windshield)
    if (p.type === 'map') p.mesh.visible = !(me.holding?.id === p.id ? (me.holding.ok && mapRaised) : mapOut());
    p.mesh.position.set(s.p.x, s.p.y, s.p.z);
    p.mesh.quaternion.set(s.q.x, s.q.y, s.q.z, s.q.w);
    S.lw.setProp(p.id, s.p, s.q);
    if (p.view) {
      if (s.st != null) p.st = s.st;
      p.view.update(dt, time, p.st, camera.position);
      // a sleeping grumphorn snores (you hear it before you see it, within 25 m)
      if (p.type === 'grumphorn' && (p.st & ST_MASK) === GST.SLEEP && (p.snoreT = (p.snoreT ?? Math.random() * 3) - dt) <= 0) {
        p.snoreT = 3;
        positional(p.mesh.position, () => sfx.snore(), 25);
      }
    }
  }
  // other players
  const others = new Map();
  if (rt != null && S.meta) {
    for (const p of S.meta.players) {
      if (p.id === S.selfId) continue;
      const s = S.interp.samplePlayer(p.id, rt);
      if (!s) continue;
      let pos = s.p, yaw = s.yaw;
      if (s.par && rv) { pos = toWorld(rv.p, rv.q, s.p); yaw = s.yaw + qYaw(rv.q); }
      others.set(p.id, { pos, yaw, pitch: s.pitch, mode: s.mode, flags: s.flags, par: s.par, lp: s.p });
      S.lw.setPlayer(p.id, pos, s.mode === C.MODE.KO);
    }
  }
  S.others = others;
  S.lw.step();

  // me
  const typing = uiOpen();
  inp.f = typing ? 0 : (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0);
  inp.r = typing ? 0 : (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
  inp.jump = !typing && !!keys[' '] && !S.jumpLatch;
  S.jumpLatch = !!keys[' '];
  inp.sprint = !!keys.shift;
  inp.crouch = !!keys.control || !!keys.c || (!!S.kpCrouch && !$('keypad').classList.contains('hidden'));
  if (me.mode === 'seat') { inp.f = 0; inp.r = 0; inp.jump = false; }
  me.update(dt, { ...inp, grab: inp.grab && isLocked() }, S.lw, rv, moveExclude());
  for (const e of me.events) meEvent(e);
  for (const p of me.pushes) net.send({ t: 'push', ...p });
  if (me.pos.y < (S.W.heightAt(me.pos.x, me.pos.z) - 20)) {
    // fell through the world somehow
    me.teleport(me.pos.x, S.W.heightAt(me.pos.x, me.pos.z) + 1, me.pos.z);
  }

  // net out
  if (now - lastPose > 1000 / C.POSE_HZ) {
    lastPose = now;
    const pose = me.pose(rv);
    if (voice.V.walkieKey && S.myWalkie) pose.f |= C.FLAG.WALKIE_TX;
    if (now < (S.shoveUntil || 0)) pose.f |= C.FLAG.SHOVE;
    net.send(pose);
  }


  // camera
  const eye = me.eye(rv), look = me.look();
  let ex = eye.x, ey = eye.y, ez = eye.z;
  if (shakeAmt > 0) { ex += (Math.random() - 0.5) * shakeAmt * 0.3; ey += (Math.random() - 0.5) * shakeAmt * 0.3; shakeAmt = Math.max(0, shakeAmt - dt * 1.5); }
  camera.position.set(ex, ey, ez);
  if (me.mode === 'ko') {
    camera.lookAt(ex + Math.sin(me.yaw), ey + 0.9, ez + Math.cos(me.yaw));
    camera.rotation.z += Math.sin(time * 0.7) * 0.25;
  } else camera.lookAt(ex + look.x, ey + look.y, ez + look.z);
  camera.fov = settings.fov + (me.sprinting ? 6 : 0);
  camera.updateProjectionMatrix();

  // views of other players
  for (const [id, st] of others) {
    let v = S.views.get(id);
    const p = S.meta.players.find(q => q.id === id);
    if (!v) { v = new PlayerView(scene, p); S.views.set(id, v); }
    st.speaking = voice.V.speaking[id];
    st.walkieTx = !!(st.flags & C.FLAG.WALKIE_TX);
    st.hat = !!p?.hat;
    v.update(dt, time, st);
  }
  for (const [id, v] of S.views) if (!others.has(id)) v.group.visible = false; else v.group.visible = true;

  // the RV, its hook, its dashboard
  const night = S.g ? (S.g.ph === 'night' || S.g.clk >= 20.2) : false;
  const odo = rv ? rv.p.z : 0;   // the metres the map's ticks count, from the end of camp (it reads 0 in camp)
  // (the RV's condition as it shows: dents a side from the hits this page has seen, smoke, the dial, hazards)
  const cond = S.g ? { hp: S.g.rvh ?? 100, brk: !!S.g.brk, zones: S.rvZones } : null;
  rvView.update(dt, rv, S.door, night, S.hook, odo, S.g ? fmtClock(S.g.clk) : '', cond);
  rvSounds(dt, rvDistNow(rv));
  if (S.g) setTimeOfDay(S.g.clk, S.g.ph === 'night');
  updateSun(me.pos);
  updateWorld(S.wv, dt, time, camera.position);
  updateCasino(dt);
  updateTownLabels();

  // hands & map
  hands.update(dt, me, Math.abs(inp.f) + Math.abs(inp.r) > 0 && me.grounded, me.sprinting, rvView.steeringWheel);
  // the real map shows only on its reader's own screen, once the server has said the grab took (a refused
  // grab never flashes it), and never in a seat (nobody seated holds anything anyway)
  const reading = me.holding?.type === 'map' && !!me.holding.ok && mapRaised && me.mode !== 'seat';
  if (reading) hands.showMap(S.mapCv); else hands.hideMap();

  // what am I looking at
  target = computeTarget();
  $('prompt').textContent = keysIn(target?.label || '');
  $('prompt').classList.toggle('hidden', !target?.label || reading);   // the raised map covers the view
  if (target?.kind === 'revive' && keys.e && reviveT > 0) {
    reviveT += dt;
    if (reviveT >= me.mods.holdT) { net.send({ t: 'use', kind: 'revive', id: target.id }); reviveT = 0; }
  } else if (!keys.e) reviveT = 0;
  // the roadside fix: E held at the engine hatch. It starts with the hatch in view (its prompt up), however
  // long E has been down, and goes on while E is down and I'm still at the hatch, whatever crosses the
  // crosshair (a friend, a ringtail, loot); E let go, or I walked off (or it's running again): stop
  const fixWant = !!keys.e && atHatch() && (fixHeld || target?.kind === 'fix');
  if (fixWant !== fixHeld) { fixHeld = fixWant; net.send({ t: 'fix', on: fixWant ? 1 : 0 }); }
  $('holdBar').classList.toggle('hidden', !(reviveT > 0 || fixHeld));
  $('holdBar').firstElementChild.style.width = `${fixHeld ? Math.min(100, S.g?.fix || 0) : Math.min(100, reviveT / me.mods.holdT * 100)}%`;

  // fx
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt; p.v.y -= 9.8 * (p.g ?? 1) * dt;
    p.m.position.addScaledVector(p.v, dt);
    p.m.rotation.x += dt * 8;
    if (p.life <= 0) { scene.remove(p.m); particles.splice(i, 1); }
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    if (!f.ping) f.s.position.y += dt * 0.6;
    f.s.material.opacity = Math.min(1, f.life);
    if (f.life <= 0) { scene.remove(f.s); f.s.material.map?.dispose(); f.s.material.dispose(); floaters.splice(i, 1); }   // each label has its own canvas texture
  }
  for (let i = marks.length - 1; i >= 0; i--) {
    const m = marks[i], p = S.props.get(m.id), now = performance.now();
    if (!p || now > m.until) { scene.remove(m.sp); marks.splice(i, 1); continue; }
    m.sp.position.copy(p.mesh.position);
    m.sp.position.y += 0.75 + Math.sin(now / 160) * 0.06;
  }

  // audio
  const drv = S.g?.drv;
  const rvSpeed = rv ? Math.hypot(rv.v.x, rv.v.z) : 0;
  const rvDist = rv ? Math.hypot(rv.p.x - me.pos.x, rv.p.y - me.pos.y, rv.p.z - me.pos.z) : 999;
  const inMyRV = !!me.par && insideRV(...Object.values(me.lp || { x: 9, y: 9, z: 9 }));
  setListener(camera.position, look);
  setLoops({
    cond: S.g ? { hp: S.g.rvh ?? 100, brk: !!S.g.brk, stl: !!S.g.stl } : null,
    engineOn: !!drv, rpm: Math.min(1.4, rvSpeed / 12), near: Math.max(0, 1 - rvDist / 60),
    winchOn: !!S.hook?.reeling && rvDist < 50,
    windAmt: me.par ? Math.min(1, rvSpeed / 14) * (inMyRV ? 0.2 : 1) : 0.15 + Math.max(0, me.pos.y - S.W.roadY(me.pos.z)) / 40,
    rv: rv?.p, speed: rv ? rvSpeed : 0,
  });
  worldSounds(dt, rv, rvSpeed, others);
  probeQuality(dt);
  tutWatch(inMyRV);
  updateAmbience({ pos: camera.position, biome: S.W.biome, night, inside: inMyRV, fires: S.fires }, dt);
  updateMusic(rv, inMyRV);
  updateVoice(others);
  // walkie static when someone keys up
  const tx = new Set([...others].filter(([, s]) => s.flags & C.FLAG.WALKIE_TX).map(([id]) => id));
  if (S.myWalkie) for (const id of tx) if (!lastWalkieTx.has(id)) sfx.radio();
  lastWalkieTx = tx;
  updateCallsigns(others, tx);
  steadyHands(dt, rv);

  hud(rv);
  if (!S.noRender) render();
}

function updateVoice(others) {
  if (!voice.V.on) return;
  const l = me.look();
  const eye = me.eye(S.rv);
  voice.spatialize({ pos: eye, fwd: l }, id => {
    const s = others.get(id);
    if (!s) return null;
    const head = { x: s.pos.x, y: s.pos.y + (s.mode === C.MODE.KO ? 0.3 : 1.6), z: s.pos.z };
    const dx = head.x - eye.x, dy = head.y - eye.y, dz = head.z - eye.z;
    const d = Math.hypot(dx, dy, dz);
    let occluded = false;
    if (d > 1.5 && d < C.VOICE.RANGE + 1) {
      const hit = S.lw.ray(eye, { x: dx / d, y: dy / d, z: dz / d }, d - 0.6, G.WORLD | G.RV, null, false);
      occluded = !!hit;
    }
    const radio = !!(s.flags & C.FLAG.WALKIE_TX) && !!S.myWalkie;
    return { head, occluded, ko: s.mode === C.MODE.KO, radio };
  });
  earshotNudge(eye, others);
}
// Call Sign (a perk): while somebody who has it talks on their walkie, everyone else holding one sees a radio
// marker over them however far off; level II adds an arrow at the edge of the screen, with how far
const callMarks = new Map();   // player id -> { sp, el }
let callMat = null;
const callV = new THREE.Vector3();
function callMarker() {
  if (!callMat) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    g.lineCap = 'round'; g.lineWidth = 5;
    g.strokeStyle = '#1b130b'; g.fillStyle = '#ffd166';
    g.beginPath(); g.roundRect(22, 22, 20, 34, 5); g.fill(); g.stroke();      // the walkie
    g.beginPath(); g.moveTo(37, 22); g.lineTo(37, 6); g.stroke();             // its aerial
    g.strokeStyle = '#ffd166'; g.lineWidth = 4;
    for (const r of [12, 20]) { g.beginPath(); g.arc(37, 10, r, -1.0, -0.2); g.stroke(); g.beginPath(); g.arc(37, 10, r, Math.PI + 0.2, Math.PI + 1.0); g.stroke(); }
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    callMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false, sizeAttenuation: false });
  }
  const sp = new THREE.Sprite(callMat);
  sp.scale.set(0.06, 0.06, 1);
  sp.renderOrder = 11;
  scene.add(sp);
  const el = document.createElement('div');
  el.className = 'callArrow hidden';
  el.innerHTML = '<i></i><span></span>';
  document.body.appendChild(el);
  return { sp, el };
}
function updateCallsigns(others, tx) {
  const seen = new Set();
  if (S.myWalkie) for (const id of tx) {
    const lv = S.meta?.players.find(q => q.id === id)?.kit?.perks?.callsign || 0, s = others.get(id);
    if (!lv || !s) continue;
    seen.add(id);
    let m = callMarks.get(id);
    if (!m) callMarks.set(id, m = callMarker());
    m.sp.visible = true;
    m.sp.position.set(s.pos.x, s.pos.y + 2.3, s.pos.z);
    // (level II) off the screen: an arrow at its edge, pointing their way, with how far
    callV.copy(m.sp.position).project(camera);
    const behind = callV.z > 1, onScreen = !behind && Math.abs(callV.x) < 0.95 && Math.abs(callV.y) < 0.9;
    if (lv < 2 || onScreen) { m.el.classList.add('hidden'); continue; }
    let x = behind ? -callV.x : callV.x, y = behind ? -callV.y : callV.y;
    const k = 0.9 / Math.max(Math.abs(x), Math.abs(y), 1e-3);
    x *= k; y *= k;
    m.el.classList.remove('hidden');
    m.el.style.left = `${(x * 0.5 + 0.5) * 100}%`;
    m.el.style.top = `${(-y * 0.5 + 0.5) * 100}%`;
    m.el.firstElementChild.style.transform = `rotate(${-Math.atan2(y, x)}rad)`;
    m.el.lastElementChild.textContent = `${Math.round(Math.hypot(s.pos.x - me.pos.x, s.pos.z - me.pos.z))} m`;
  }
  for (const [id, m] of callMarks) if (!seen.has(id)) { m.sp.visible = false; m.el.classList.add('hidden'); }
}

// Steady Hands (a perk), at the wheel. Level I: a creak and the tip lamp when the RV leans hard (past 0.6 g
// sideways: its speed times its turn rate, smoothed over a sixth of a second), and reversing beeps that
// quicken as the back nears something (three rays back from the rear bumper, in this page's physics).
// Level II's stability control is the server's (sim.js).
let tipG = 0, tipYaw = null, creakAt = 0, beepAt = 0;
const REAR_RAYS = [-0.9, 0, 0.9];
function steadyHands(dt, rv) {
  let lamp = false;
  if (rv && me.mode === 'seat' && me.seat === 0 && me.mods.tipWarn) {
    const yaw = qYaw(rv.q), sp = Math.hypot(rv.v.x, rv.v.z), now = performance.now();
    if (tipYaw != null && dt > 0) {
      const dy = Math.atan2(Math.sin(yaw - tipYaw), Math.cos(yaw - tipYaw));
      tipG += (Math.abs(sp * dy / dt) / 9.81 - tipG) * Math.min(1, dt / 0.16);
    }
    tipYaw = yaw;
    lamp = tipG > 0.6;
    if (lamp && now - creakAt > 700) { creakAt = now; sfx.creak(); }
    const f = toWorld(rv.p, rv.q, { x: 0, y: 0, z: 1 }), back = (f.x - rv.p.x) * rv.v.x + (f.y - rv.p.y) * rv.v.y + (f.z - rv.p.z) * rv.v.z < -0.3;
    if (back && S.lw) {
      let d = Infinity;
      for (const x of REAR_RAYS) {
        const o = toWorld(rv.p, rv.q, { x, y: -0.2, z: -4.3 }), e = toWorld(rv.p, rv.q, { x, y: -0.2, z: -5.3 });
        const hit = S.lw.ray(o, { x: e.x - o.x, y: e.y - o.y, z: e.z - o.z }, 6, G.WORLD | G.PROP | G.PLAYER, null, true);
        if (hit) d = Math.min(d, hit.toi);
      }
      const gap = d < 0.8 ? 120 : d < 2 ? 250 : d < 4 ? 450 : d < 6 ? 800 : 0;
      if (gap && now - beepAt > gap) { beepAt = now; sfx.beep(d < 0.8 ? 2000 : 1600); }
    }
  } else { tipYaw = null; tipG = 0; }
  $('tipLamp').classList.toggle('on', lamp);
}

// Talking, and nobody in voice is close enough to hear it (nor on a walkie line with me): say so, once a
// day. Voices carry C.VOICE.RANGE m; past that only walkie-talkies get through
let earshotDay = null;
function earshotNudge(eye, others) {
  const V = voice.V;
  if (!V.speaking[V._selfId] || V.walkieKey || earshotDay === S.g?.day) return;
  let heard = 0;
  for (const p of S.meta?.players || []) {
    if (p.id === S.selfId || !p.voice) continue;
    const s = others.get(p.id);
    if (!s) continue;
    if (Math.hypot(s.pos.x - eye.x, s.pos.y + 1.6 - eye.y, s.pos.z - eye.z) < C.VOICE.RANGE || (S.myWalkie && p.walkie)) return;   // someone hears, or could on the walkie
    heard++;
  }
  if (!heard) return;   // (nobody else in voice: nothing to say)
  earshotDay = S.g?.day;
  toast(`Nobody's close enough to hear you. Voices carry about ${C.VOICE.RANGE} m; walkie-talkies ($150 at the store) reach anyone else who has one.`, '#fff', 6);
}

// ---- the casino: one bank, a game each --------------------------------------------------------
// (server/casino.js) g.cas has every station's game; the cards, dice, coins and the Derby's ringtails are
// laid out from it here. S.casAt is the station this page sat down at (the server said so: 'cas'), kept while
// you stand within reach of it: then the number keys play it (the emotes come back when you walk off).

const TAU = Math.PI * 2;
const cardTex = new Map();
function cardTexture(code) {
  if (cardTex.has(code)) return cardTex.get(code);
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 176;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 176);
  g.strokeStyle = '#ccc'; g.lineWidth = 4; g.strokeRect(2, 2, 124, 172);
  if (code === '??') { g.fillStyle = '#b8336a'; g.fillRect(10, 10, 108, 156); g.fillStyle = '#ffd166'; g.font = 'bold 50px serif'; g.textAlign = 'center'; g.fillText('$', 64, 105); }
  else {
    const red = /[♥♦]/.test(code);
    g.fillStyle = red ? '#d62828' : '#111';
    g.font = 'bold 54px serif'; g.textAlign = 'center';
    g.fillText(code.slice(0, -1), 64, 78);
    g.font = '60px serif'; g.fillText(code.slice(-1), 64, 148);
  }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  cardTex.set(code, t);
  return t;
}
// one card shape and one material per card face, shared by every deal (a hand is re-laid on each change);
// a seat's cards overlap like a dealt fan, so five fit in its box on the felt (paint: felt_table)
const cardGeo = new THREE.PlaneGeometry(0.24, 0.33), cardMats = new Map();
function cardMaterial(code) {
  if (!cardMats.has(code)) cardMats.set(code, new THREE.MeshStandardMaterial({ map: cardTexture(code), roughness: 0.6 }));
  return cardMats.get(code);
}
const betChipGeo = new THREE.CylinderGeometry(0.04, 0.04, 0.012, 12), betChipMats = ['#e8dcc0', '#c0392b', '#2e4a7a', '#1e1a20'].map(c => new THREE.MeshLambertMaterial({ color: c }));
// a point in a table's frame (x along it, z toward its players)
const onTable = (o, ry, lx, ly, lz) => new THREE.Vector3(o.x + lx * Math.cos(ry) + lz * Math.sin(ry), o.y + ly, o.z - lx * Math.sin(ry) + lz * Math.cos(ry));
// a stack of chips for a bet: one chip a $100, at most ten (white $100s, red $500s, blue $1,000s, black more)
function chipStack(group, amount, p) {
  if (!(amount > 0)) return;
  const n = Math.min(10, Math.max(1, Math.round(amount / 100))), m = betChipMats[amount >= 5000 ? 3 : amount >= 1000 ? 2 : amount >= 500 ? 1 : 0];
  for (let i = 0; i < n; i++) { const c = new THREE.Mesh(betChipGeo, m); c.position.set(p.x + (i % 3) * 0.002, p.y + 0.008 + i * 0.012, p.z); group.add(c); }
}
const nameOfId = id => S.meta?.players.find(q => q.id === id)?.name || 'Somebody';
const GAME_NAME = { bj: 'Blackjack', craps: 'Craps', flip: 'Double or Nothing', derby: 'The Ringtail Derby' };
const OUT_WORD = { win: 'WIN', natural: 'BLACKJACK!', push: 'PUSH', lose: 'LOSE' };
const moneyCol = won => (won > 0 ? '#7CFC00' : won < 0 ? '#ff5252' : '#fff');
const casStation = id => S.W?.town?.casino_stations?.find(s => s.id === id);
const myStation = () => {
  const id = S.casAt, st = id && casStation(id), v = id && S.g?.cas?.[id];
  if (!st || !v || !me.pos || me.mode === 'seat') return null;
  if (Math.hypot(me.pos.x - st.x, me.pos.z - st.z) > C.CASINO.SEAT_R) return null;
  if (st.kind !== 'derby' && v.o !== S.selfId) return null;
  return { id, st, v };
};
net.on('cas', m => { S.casAt = m.at; sfx.click(); });
// the number keys at a station: 1-4 set the stake (+$100, +$500, all in, clear); 5 deals (hits, in a hand),
// rolls or pulls, 6 stands; at the Derby 5-8 buy a ticket on ringtail 1-4
function casinoKey(n) {
  const at = myStation();
  if (!at) return false;
  const send = (a, x) => net.send({ t: 'cas', s: at.id, a, n: x });
  if (n <= 4) { send(['b100', 'b500', 'ball', 'bclr'][n - 1]); sfx.click(); return true; }
  if (at.st.kind === 'derby') { send('go', n - 4); return true; }
  if (n === 5) send(at.st.kind === 'bj' && at.v.st === 'play' ? 'hit' : 'go');
  else if (n === 6 && at.st.kind === 'bj') send('stand');
  else return n <= 6;
  return true;
}
function casinoPanel(at, g) {
  const el = $('casPanel');
  if (!at) { el.classList.add('hidden'); return; }
  const v = at.v, k = at.st.kind, seat = at.id.replace(/\D/g, '');
  const bet = k === 'derby' ? v.bets?.[S.selfId] || 0 : v.bet;
  const title = k === 'bj' ? `Blackjack · seat ${seat}` : k === 'craps' ? `Craps · rail ${seat}` : GAME_NAME[k];
  let line = '', keysTxt = '';
  const K = (n, t) => `<kbd>${n}</kbd> ${t}`;
  const stakeKeys = [K(1, '+$100'), K(2, '+$500'), K(3, 'ALL IN'), K(4, 'clear')].join(' ');
  if (k === 'bj') {
    if (v.st === 'play') { line = `You ${v.tot} · the dealer shows ${v.up}`; keysTxt = `${K(5, 'HIT')} ${K(6, 'STAND')}`; }
    else { line = v.st === 'result' ? `${OUT_WORD[v.out] || ''} ${v.won ? (v.won > 0 ? '+' : '') + fmt$(v.won) : ''} · you ${v.tot}, the dealer ${v.dt ?? '-'}` : 'Blackjack pays 3 to 2. The dealer stands on 17.'; keysTxt = `${stakeKeys} ${K(5, 'DEAL')}`; }
  } else if (k === 'craps') {
    const rolling = v.dice && !v.land;
    line = rolling ? 'Rolling…' : v.st === 'point' ? `The point is ${v.pt}: roll a ${v.pt} before a 7` : v.st === 'result' ? `${v.won > 0 ? 'Winner' : 'Loser'}: ${v.dice ? v.dice[0] + v.dice[1] : ''} · ${v.won > 0 ? '+' : ''}${fmt$(v.won)}` : 'The pass line: a 7 or 11 wins, 2, 3 or 12 loses, anything else is the point. Even money.';
    keysTxt = v.st === 'point' ? K(5, 'ROLL') : `${stakeKeys} ${K(5, 'ROLL')}`;
  } else if (k === 'flip') {
    line = v.spin ? 'Flipping…' : v.st === 'result' ? (v.won > 0 ? `DOUBLED! +${fmt$(v.won)}` : `NOTHING. ${fmt$(v.won)}`) : 'Your stake doubles or it\'s gone. It stays set: pull again.';
    keysTxt = `${stakeKeys} ${K(5, 'PULL')}`;
  } else {
    const mine = (v.tix || []).filter(x => x[0] === S.selfId).map(x => `${fmt$(x[2])} on No. ${x[1]}`);
    line = v.st === 'race' ? 'They\'re off!' : v.st === 'result' ? `No. ${v.order?.[0]} wins: tickets on it pay x3.8` : v.left != null ? `Off in ${v.left} s${mine.length ? ` · yours: ${mine.join(', ')}` : ''}` : 'Four ringtails, one winner, x3.8. The race runs 12 s after the first ticket.';
    keysTxt = `${stakeKeys} · a ticket on ${[1, 2, 3, 4].map(n => K(n + 4, `No. ${n}`)).join(' ')}`;
  }
  const html = `<div class="cas-h">${title}<span>the bank ${fmt$(g.bank)}</span></div><div class="cas-l">${line}</div><div class="cas-b">${k === 'derby' ? 'Your ticket' : 'Bet'} <b>${fmt$(bet)}</b>${v.stake && (v.st === 'play' || v.st === 'point' || v.spin) ? ` · in play ${fmt$(v.stake)}` : ''}</div><div class="cas-k">${keysTxt}</div><div class="cas-x">Walk away to leave it</div>`;
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
  el.classList.remove('hidden');
}
// the dice: thrown from the rail to the far wall, a bounce back, then lying with their numbers up
// (box faces: +x 3, -x 4, +y 1, -y 6, +z 2, -z 5)
const DIE_UP = { 1: [0, 0, 0], 6: [Math.PI, 0, 0], 2: [-Math.PI / 2, 0, 0], 5: [Math.PI / 2, 0, 0], 3: [0, 0, Math.PI / 2], 4: [0, 0, -Math.PI / 2] };
const diceRoll = new Map();
function placeDice(T, rail, pair, v) {
  if (!v.dice) { for (const d of pair) d.visible = false; diceRoll.delete(rail.id); return; }
  let r = diceRoll.get(rail.id);
  if (!r || v.roll < r.last - 0.05 || r.key !== v.dice.join()) {
    const h = (v.dice[0] * 7 + v.dice[1] * 13 + Math.floor(time * 10)) % 997, R = n => ((h * 9301 + n * 49297) % 233280) / 233280;
    r = { key: v.dice.join(), t0: time - (v.roll || 0), spin: [0, 1].map(i => ({ ax: new THREE.Vector3(R(i * 5) - 0.5, R(i * 5 + 1) - 0.5, R(i * 5 + 2) - 0.5).normalize(), w: 18 + R(i * 5 + 3) * 10, yaw: R(i * 5 + 4) * TAU, dx: (i ? 0.07 : -0.07) + (R(i + 9) - 0.5) * 0.08, dz: (R(i + 11) - 0.5) * 0.12 })) };
    diceRoll.set(rail.id, r);
  }
  r.last = v.roll || 0;
  const u = Math.min(1, (time - r.t0) / 1.3), C2 = T.craps, top = 0.04;
  pair.forEach((d, i) => {
    const sp = r.spin[i], x = rail.dx * 0.55 + sp.dx;
    // flight to the far wall (0 - 0.55), the bounce back (0.55 - 0.85), still (0.85 - 1)
    const z0 = 0.62, z1 = -0.52, z2 = -0.32 + sp.dz;
    let z, y;
    if (u < 0.55) { const k = u / 0.55; z = z0 + (z1 - z0) * k; y = top + 0.25 * Math.sin(Math.PI * k) + 0.18 * (1 - k); }
    else if (u < 0.85) { const k = (u - 0.55) / 0.3; z = z1 + (z2 - z1) * Math.sin(k * Math.PI / 2); y = top + 0.06 * Math.sin(Math.PI * k); }
    else { z = z2; y = top; }
    d.position.copy(onTable(C2.table, C2.ry, x, y, z));
    d.visible = true;
    const face = DIE_UP[v.dice[i]] || [0, 0, 0], left = Math.max(0, 1 - u / 0.9);
    d.rotation.set(0, sp.yaw + C2.ry, 0);
    const die = d.children[0];
    die.rotation.set(face[0], 0, face[2]);
    if (left > 0) die.rotateOnWorldAxis(sp.ax, sp.w * left * left);
  });
}
// the Derby's ringtails: four of the real thing, small, numbered; each lane's progress drawn from the race's
// seed, the winner first over the line (lane 1 nearest the players)
let derby = null;
const LANE_COLS = ['#c8322a', '#2e5aa8', '#2e8a44', '#e0b020'];
function buildDerby() {
  const T = S.W?.town;
  if (!T?.derby) return null;
  const racers = [0, 1, 2, 3].map(i => {
    const { obj, view } = buildMob('ringtail', S.W);
    obj.scale.setScalar(0.42);
    const cv = document.createElement('canvas'); cv.width = cv.height = 64;
    const g = cv.getContext('2d');
    g.fillStyle = '#f4ecd8'; g.beginPath(); g.arc(32, 32, 30, 0, TAU); g.fill();
    g.fillStyle = LANE_COLS[i]; g.beginPath(); g.arc(32, 32, 25, 0, TAU); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 38px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(String(i + 1), 32, 34);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
    tag.scale.set(0.16, 0.16, 1);
    scene.add(obj, tag);
    return { obj, view, tag, tex };
  });
  return { racers, race: -1, t0: 0 };
}
function freeDerby() {
  if (!derby) return;
  for (const r of derby.racers) { scene.remove(r.obj, r.tag); r.view.dispose(); r.tag.material.dispose(); r.tex.dispose(); }
  derby = null;
}
const raceRng = seed => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
function updateDerby(dt, v) {
  const T = S.W?.town?.derby;
  if (!T || !v) return;
  if (!derby) derby = buildDerby();
  const near = camera.position.distanceTo(new THREE.Vector3(T.x, T.y, T.z)) < 40;
  const rt = v.rt || 7;
  let el = 0;
  if (v.st === 'race') {
    if (derby.race !== v.race) { derby.race = v.race; derby.t0 = time - (v.el || 0); }
    el = time - derby.t0;
    if (Math.abs(el - (v.el || 0)) > 0.6) { derby.t0 = time - (v.el || 0); el = v.el || 0; }
  } else if (v.st === 'result' && v.order) el = rt;
  const x0 = -2.82, x1 = 2.7, w = T.w, lz = T.lz ?? 0;
  derby.racers.forEach((r, i) => {
    let p = 0;
    if (v.order && el > 0) {
      const place = v.order.indexOf(i + 1), R = raceRng((v.seed | 0) + i * 7919);
      const f = rt * (0.72 + 0.065 * place + 0.02 * R()), a = 0.045 + 0.015 * R(), b = 1 + Math.floor(R() * 2), ph = R() * TAU;
      const u = Math.min(1, el / f);
      p = el < f ? u + a * Math.sin(Math.PI * u) * Math.sin(TAU * b * u + ph) : 1 + Math.min(0.05, (el - f) * 0.12);
    }
    const pos = onTable(T, T.ry, x0 + (x1 - x0) * p, 0, lz + w / 2 - w / 8 - i * w / 4);
    r.obj.position.copy(pos);
    r.obj.rotation.y = T.ry + Math.PI / 2;
    r.tag.position.set(pos.x, pos.y + 0.36, pos.z);
    r.obj.visible = r.tag.visible = near;
    if (near) r.view.update(dt, time, v.st === 'race' && p < 1.04 ? RST.RUN : RST.SNEAK, camera.position);
  });
}
function updateCasino(dt) {
  const w = S.wv, g = S.g, T = S.W?.town;
  if (!w || !g || !T) return;
  const cas = g.cas || null, c = w.cas;
  // the cards and chips are re-laid whenever any seat's hand or bet changes
  const key = cas ? JSON.stringify(T.bj.seats.map(s => { const v = cas[s.id]; return v ? [v.cards, v.up, v.dl, v.bet, v.stake, v.st] : 0; }).concat(T.craps.rails.map(r => [cas[r.id]?.bet, cas[r.id]?.stake, cas[r.id]?.st]))) : '';
  if (key !== lastCards) {
    lastCards = key;
    while (c.cards.children.length) c.cards.remove(c.cards.children[0]);
    const lay = (seat, codes, row) => codes.forEach((code, i) => {
      const m = new THREE.Mesh(cardGeo, cardMaterial(code));
      m.rotation.x = -Math.PI / 2;
      m.rotation.z = T.bj.ry;
      m.position.copy(onTable(T.bj.table, T.bj.ry, seat.dx + (i - (codes.length - 1) / 2) * 0.17, 0.01 + i * 0.002, row));
      c.cards.add(m);
    });
    if (cas) for (const seat of T.bj.seats) {
      const v = cas[seat.id];
      if (!v) continue;
      if (v.cards) lay(seat, v.cards, 0.42);
      if (v.dl) lay(seat, v.dl, -0.62);
      else if (v.up) lay(seat, [v.up, '??'], -0.62);
      chipStack(c.cards, v.st === 'play' || v.st === 'result' ? v.stake : v.bet, onTable(T.bj.table, T.bj.ry, seat.dx, 0, 0.8));
    }
    if (cas) for (const rail of T.craps.rails) { const v = cas[rail.id]; if (v) chipStack(c.cards, v.st === 'point' || v.st === 'roll' ? v.stake : v.bet, onTable(T.craps.table, T.craps.ry, rail.dx, 0, 0.62)); }
  }
  if (!cas) { casinoPanel(null); return; }
  // the placards over each station
  for (const [id, l] of c.labels) {
    const v = cas[id];
    if (!v) continue;
    const who = v.o ? nameOfId(v.o).toUpperCase() : null, n = id.replace(/\D/g, '');
    let t = '', col = '#fff';
    if (v.k === 'bj') {
      if (!who) { t = `SEAT ${n} · OPEN`; col = '#c8b890'; }
      else if (v.st === 'play') t = `${who} · ${v.tot} vs ${v.up}`;
      else if (v.st === 'result') { t = `${who} · ${OUT_WORD[v.out] || ''} ${v.won ? (v.won > 0 ? '+' : '') + fmt$(v.won) : ''}`; col = moneyCol(v.won); }
      else t = `${who} · BET ${fmt$(v.bet)}`;
    } else if (v.k === 'craps') {
      if (!who) { t = `RAIL ${n} · OPEN`; col = '#c8b890'; }
      else if (v.dice && !v.land) t = `${who} · ROLLING…`;
      else if (v.st === 'point') t = `${who} · POINT ${v.pt}`;
      else if (v.st === 'result') { t = `${who} · ${v.won > 0 ? 'WINNER' : 'LOSER'} ${v.won > 0 ? '+' : ''}${fmt$(v.won)}`; col = moneyCol(v.won); }
      else t = `${who} · BET ${fmt$(v.bet)}`;
    } else if (v.k === 'flip') {
      if (v.spin) { t = 'FLIPPING…'; col = '#ffd166'; }
      else if (v.st === 'result') { t = v.won > 0 ? `DOUBLED! +${fmt$(v.won)}` : `NOTHING. ${fmt$(v.won)}`; col = moneyCol(v.won); }
      else { t = who ? `${who} · STAKE ${fmt$(v.bet)}` : 'DOUBLE OR NOTHING'; col = '#ffd166'; }
    } else if (v.k === 'derby') {
      col = '#ffd166';
      t = v.st === 'race' ? 'THEY\'RE OFF!' : v.st === 'result' ? `No. ${v.order?.[0]} WINS! · PAYS x3.8` : v.left != null ? `RINGTAIL DERBY · OFF IN ${v.left} s · ${(v.tix || []).length} TICKETS` : 'RINGTAIL DERBY · TICKETS AT THE COUNTER';
    }
    l.userData.set(t, col);
  }
  for (const [id, coin] of c.coins) coin.rotation.z += dt * (cas[id]?.spin ? 25 : 0.6);
  for (const rail of T.craps.rails) placeDice(T, rail, c.dice.get(rail.id), cas[rail.id] || {});
  updateDerby(dt, cas.derby);
  const at = myStation();
  if (!at && S.casAt) {
    const st = casStation(S.casAt);
    if (!st || !me.pos || Math.hypot(me.pos.x - st.x, me.pos.z - st.z) > C.CASINO.SEAT_R + 0.5) S.casAt = null;
  }
  casinoPanel(at, g);
}
let lastCards = '';
function updateTownLabels() {
  const w = S.wv, g = S.g;
  if (!w || !g) return;
  const offer = (g.pawn || 0) + (g.dock || 0);
  w.pawnLabel.userData.set(offer ? `ED OFFERS ${fmt$(offer)}${g.dock ? ' FOR THE LOT' : ''} · ring the bell` : 'LOOT ON THE COUNTER, OR THE RV OUTSIDE', offer ? '#7CFC00' : '#ffe9a8');
  if (w.gusLabel) {
    const hp = g.rvh ?? 100, q = C.repairQuote(g.day, hp), open = g.ph === 'night' && g.paid;
    w.gusLabel.userData.set(hp >= 100 ? 'SHE\'S RUNNING FINE' : g.day >= C.DAYS || g.ph === 'over' ? `RV ${hp}% · CLOSED: NO NIGHT ON THE LAST DAY` : !open ? `RV ${hp}% · OPEN ONCE THE REPO MAN'S PAID`
      : `RV ${hp}% · ${q.pts}% FOR ${fmt$(q.cash)} · ${fmt$(q.loan)} ON THE ${g.day === C.DAYS - 1 ? 'BALLOON' : 'LOAN'}`, hp < 100 && open ? '#7CFC00' : '#ffe9a8');
  }
}

// ---- hud ------------------------------------------------------------------------------------------

function hud(rv) {
  const g = S.g;
  if (g) {
    $('hDay').textContent = `DAY ${Math.min(g.day, C.DAYS)}/${C.DAYS}`;
    $('hClock').textContent = g.ph === 'night' ? 'NIGHT' : fmtClock(g.clk);   // what to do next is in the quest tracker
    $('hClock').classList.toggle('late', g.ph === 'road' && g.clk >= 21);
    $('hBank').textContent = `BANK ${fmt$(g.bank)}`;
    $('hBank').classList.toggle('neg', g.bank < 0);
    $('hDue').textContent = g.paid ? `PAID ✓` : g.bank >= g.due ? `DUE ${fmt$(g.due)} · COVERED ✓` : `DUE ${fmt$(g.due)} @ MIDNIGHT`;
    $('hDue').classList.toggle('ok', !!g.paid || g.bank >= g.due);
    // the RV's condition: out of sight at 100%; amber smoking, red limping, blinking broken down
    const hp = g.rvh ?? 100, el = $('hRV');
    el.textContent = hp >= 100 ? '' : g.brk ? 'RV BROKEN DOWN' : `RV ${hp}%`;
    el.classList.toggle('warn', hp <= 60 && hp > 30);
    el.classList.toggle('bad', hp <= 30);
    el.classList.toggle('dead', !!g.brk);
  }
  const pct = Math.max(0, me.stamina / C.STAMINA.MAX * 100);
  $('stamFill').style.width = `${pct}%`;
  $('stamFill').classList.toggle('low', me.stamina < 25);
  $('stamCap').style.width = `${Math.max(0, (C.STAMINA.MAX - me.stamMax) / C.STAMINA.MAX * 100)}%`;
  $('stamina').classList.toggle('hidden', me.stamina >= me.stamMax - 0.5 && me.mode !== 'climb' && me.stamMax >= C.STAMINA.MAX);
  let held = '';
  if (me.holding) {
    const p = S.props.get(me.holding.id);
    held = !p ? '' : p.type === 'map' ? 'ROAD MAP — [F] raise/lower · [Q] drop'
      : p.type === 'ringtail' ? `RINGTAIL · ${S.W?.day > 1 ? 'it bites if you hold it alone' : 'it wriggles'} · [RMB] throw it · [Q] let go`
      : p.type === 'grumphorn' ? 'GRUMPHORN, by the horns · it will shake you off'
      : LOOT[p.type].find ? `${LOOT[p.type].name} · set it down in the RV to keep its cards · [RMB] throw · [Q] drop`
      : `${LOOT[p.type].name} · ${fmt$(p.value)} · [RMB] throw · [Q] drop · wheel: distance`;
  } else if (me.hasHook) held = 'WINCH HOOK clipped to your belt';
  $('heldLabel').textContent = held;
  $('heldLabel').classList.toggle('hidden', !held);
  $('koOverlay').classList.toggle('hidden', me.mode !== 'ko');
  if (me.mode === 'ko') {
    const alone = (S.meta?.players.length || 1) < 2;
    $('koT').textContent = alone ? `You'll wake up in ${Math.ceil(me.koT)}s. The doctor's bill: ${fmt$(C.medBill(g?.day || 1))}.` : `${Math.ceil(me.koT)}s — or until a friend picks you up (hold ${keyLabel('E')}). Waking up alone costs ${fmt$(C.medBill(g?.day || 1))}.`;
    $('koOverlay').querySelector('.ko-btn').textContent = alone ? 'Hang in there…' : 'Waiting for a friend…';
  }
  const driving = me.mode === 'seat' && me.seat === 0;
  $('driveHint').classList.toggle('hidden', !driving);
  if (driving && rv) $('driveHint').textContent = `${Math.round(Math.hypot(rv.v.x, rv.v.z) * 3.6)} km/h${g?.brk ? ` · BROKEN DOWN: somebody hold ${keyLabel('E')} at the engine hatch on the back` : ''}${g?.mud ? ' · STUCK IN MUD — get the boys to push' : ''}${S.hook && S.hook.state !== 0 ? ` · winch ${S.hook.reeling ? 'REELING' : 'slack'} (${keyLabel('R')})` : ''}`;
  $('walkieHint').classList.toggle('hidden', !S.myWalkie);
  $('walkieHint').classList.toggle('tx', !!voice.V.walkieKey);
  questTracker(g);
  rosterBars();
}

// the RV's own noises: the engine dying in a stall, a sputter now and then when it's limping, the ratchet of
// whoever is fixing it (everyone near hears it)
let rvStalled = false, sputterT = 0, ratchetT = 0;
const rvDistNow = rv => rv ? Math.hypot(rv.p.x - camera.position.x, rv.p.y - camera.position.y, rv.p.z - camera.position.z) : 999;
function rvSounds(dt, dist) {
  const g = S.g;
  if (!g || !S.rv) return;
  const hp = g.rvh ?? 100, drv = !!g.drv;   // (somebody at the wheel: the engine is running; 0 is nobody)
  if (!!g.stl !== rvStalled) { rvStalled = !!g.stl; if (rvStalled && dist < 60) positional(S.rv.p, () => sfx.stall(), 60); }
  sputterT -= dt;
  if (drv && hp > 0 && hp <= 30 && !g.stl && sputterT <= 0) { sputterT = 1.5 + Math.random() * 3; if (dist < 50) positional(S.rv.p, () => sfx.sputter(), 50); }
  ratchetT -= dt;
  if (g.fix > 0 && ratchetT <= 0) { ratchetT = 0.4; const h = toWorld(S.rv.p, S.rv.q, RV_HATCH); positional(h, () => sfx.ratchet(), 25); }
  if ((g.rvh ?? 100) >= 100) S.rvZones = {};   // (good as new: Gus took the dents out)
}

// the condition pill flashes when the RV takes a knock
let rvFlashT = 0;
function rvFlash() {
  const el = $('hRV');
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
  clearTimeout(rvFlashT);
  rvFlashT = setTimeout(() => el.classList.remove('flash'), 750);   // (then a broken-down pill blinks again)
}

// The quest tracker (top right, WoW's quest watch): the day's town as the title, then what to
// do next. Objectives turn white when done. Rewritten only when it changes.
let townOf = null, townNm = '', questKey = '';
function townName(W) {
  if (townOf !== W) {
    townOf = W;
    const sign = W.signs?.find(x => /^POP\./.test(String(x.lines?.[1] || '')));
    townNm = sign ? String(sign.lines[0]).toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase()) : 'Town';
  }
  return townNm;
}
// first-trip hints (Settings > Interface): each shows until it's been done once, on this PC
const tut = (() => { try { return new Set(JSON.parse(localStorage.getItem('nmdTutorial') || '[]')); } catch { return new Set(); } })();
function tutDone(k) { if (tut.has(k)) return; tut.add(k); try { localStorage.setItem('nmdTutorial', JSON.stringify([...tut])); } catch {} }
function tutWatch(inMyRV) {
  if (me.mode === 'seat' && me.seat === 0) tutDone('drive');
  if (me.holding?.type === 'map' && me.holding.ok) tutDone('map');
  if (me.holding && me.holding.type !== 'map') { tutDone('grab'); if (inMyRV) tutDone('load'); }
  if ((S.g?.pawn || 0) > 0 || (S.g?.dock || 0) > 0) tutDone('pawn');
}
// is the road map out: in my hands, or in another player's (their pose carries the MAP flag)?
function mapOut() {
  if (me.holding?.type === 'map') return true;
  if (S.renderT == null || !S.meta) return false;
  return S.meta.players.some(p => p.id !== S.selfId && (S.interp.samplePlayer(p.id, S.renderT)?.flags & C.FLAG.MAP));
}
function tutTip(g, town) {
  if (!settings.tutorial) return null;
  // someone else took the wheel and nobody has the map out: a passenger navigates
  if (!tut.has('map') && mapWanted()) return `Hint: you navigate today. ${driverName()} can't see the map: grab it off the dash and call out what's coming`;
  if (g.ph === 'camp') return tut.has('drive') || (roleOf('drv') && roleOf('drv') !== S.selfId) ? null : keysIn('Hint: [E] on the RV\'s driver seat, then drive out of camp (WASD)');
  if (g.ph !== 'road') return null;
  if (!tut.has('grumph') && beastNear(35)) return keysIn('Hint: a Grumphorn! Crouch [C] to sneak past it, creep the RV by, or wear out its patience (ram it, winch it, pelt it)');
  if (!tut.has('ringtail') && critterNear('ringtail', 15)) return keysIn('Hint: ringtails steal loot nobody is watching. Stand facing your pile, grab the thief (it drops it), or [RMB] shove it');
  if (!tut.has('rock') && rockAhead(90)) return keysIn('Hint: loose rock above the narrows ahead. The driver honks [H] at the LOOSE ROCK sign, and it comes down before you get there');
  if (!tut.has('den') && S.W.day >= 2 && denNear(14)) return keysIn('Hint: ringtails nip anyone who comes close to their den, and you drop what you carry. [RMB] shove them off, or be quick');
  if (!tut.has('grab')) return 'Hint: hold the left mouse button on glittering junk to carry it';
  if (!tut.has('load')) return 'Hint: carry your loot into the RV, then drive on';
  if (!tut.has('pawn')) return `Hint: in ${town}, park in the pawn shop's loading zone (or carry loot to the counter) and ring the bell`;
  return null;
}
// loose rock still up on the narrows ahead of me, within r metres
function rockAhead(r) {
  for (const f of S.W.rockfalls || []) {
    if (S.rockDown?.has(f.id) || S.g?.rfd?.includes(f.id)) continue;
    const dz = f.obz - me.pos.z;
    if (dz > 0 && dz < r && Math.abs(me.pos.x - S.W.roadX(me.pos.z)) < 25) return true;
  }
  return false;
}
// a ringtail den within r metres of me
function denNear(r) {
  for (const d of S.W.dens || []) if (Math.hypot(d.x - me.pos.x, d.z - me.pos.z) < r) return true;
  return false;
}
// a critter of this type within r metres of me
function critterNear(type, r) {
  for (const p of S.props.values()) if (p.type === type && p.pose && Math.hypot(p.pose.p.x - me.pos.x, p.pose.p.z - me.pos.z) < r) return true;
  return false;
}
// a grumphorn (still in the road, not gone off for good) within r metres of me
function beastNear(r) {
  for (const p of S.props.values()) {
    if (p.type !== 'grumphorn' || !p.pose || (p.st & ST_MASK) === GST.LEFT || (p.st & ST_MASK) === GST.LEAVE) continue;
    if (Math.hypot(p.pose.p.x - me.pos.x, p.pose.p.z - me.pos.z) < r) return true;
  }
  return false;
}
// 'Your kit: Work Gloves II, Climbing Chalk I; you bring the Winch Motor II' (or nothing, with no kit)
function kitLine(kit) {
  const perks = Object.entries(kit?.perks || {}).map(([id, lv]) => `${PERKS[id]?.name} ${ROMAN[lv]}`);
  const part = kit?.part ? `you bring the ${PARTS[kit.part.id]?.name} ${ROMAN[kit.part.lv]}` : '';
  if (!perks.length && !part) return '';
  return `Your kit: ${[perks.join(', '), part].filter(Boolean).join('; ')}`;
}
function questTracker(g) {
  if (!g || !S.W || g.ph === 'over' || g.ph === 'menu') { $('tracker').classList.add('hidden'); questKey = ''; return; }
  const town = townName(S.W), L = [];
  const tip = tutTip(g, town);
  if (tip) L.push([tip, 'qt-tip']);   // (not 'tip': that's the silver tooltip frame, absolutely positioned)
  if (roleOf('drv') && (g.ph === 'camp' || g.ph === 'road')) {
    const d = roleOf('drv') === S.selfId, n = roleOf('nav') === S.selfId, nav = roleOf('nav') ? roleName('nav') : null;
    L.push([d ? `You drive today${nav ? `. ${nav} reads the map` : ''}` : n ? `You read the map today. ${roleName('drv')} drives` : `You ride along today. ${roleName('drv')} drives${nav ? `, ${nav} reads the map` : ''}`, '']);
    // a role's player who's away: anyone stands in (and if it's me: moving brings me back)
    const away = (job, what) => roleOf(job) === S.selfId ? `You seem to be away: ${what} till you move` : `${roleName(job)} is away: ${what} till they're back`;
    if (roleAway('drv')) L.push([away('drv', 'anyone can drive'), '']);
    if (roleAway('nav')) L.push([away('nav', 'anyone but the driver can read the map'), '']);
  }
  // the RV's condition, while it matters: broken down (what to do), or worn
  const hp = g.rvh ?? 100;
  if ((g.ph === 'camp' || g.ph === 'road') && g.brk) L.push([keysIn('BROKEN DOWN: hold [E] at the engine hatch on the back of the RV'), 'warn']);
  else if ((g.ph === 'camp' || g.ph === 'road') && hp <= 60) L.push([`RV ${hp}%: ${hp > 30 ? 'smoking, down on power' : 'limping, a knock stalls it'}`, 'warn']);
  if (g.ph === 'camp') L.push([roleOf('drv') && roleOf('drv') !== S.selfId && !roleAway('drv') ? `${roleName('drv')} drives out of camp to start the clock` : 'Drive out of camp to start the clock', '']);
  if (g.ph === 'camp' && g.day === 1) {
    const pr = S.meta?.trip?.practice;
    if (pr === 'seed') L.push(['Practice trip (typed seed): it counts only on that seed\'s board', 'warn']);
    else if (pr === 'test') L.push(['Test trip: nothing is recorded', 'warn']);
    const crew = crewBest(profile(), (S.meta?.players || []).map(p => p.h).filter(Boolean));
    if (crew && !pr) L.push([`Best with this crew: ${crew.fast != null ? fmtRoad(crew.fast) : `${crew.wins}/${crew.trips} paid off`}${crew.haul != null ? `, ${fmt$(crew.haul)} pawned` : ''}`, '']);
    const terms = S.meta?.trip?.tier;
    if (terms === 'bad') L.push([`Loan terms: BAD CREDIT. Everyone here has paid off an RV twice. Payments +15%${S.meta.host === S.selfId ? ' (Esc: ask for Standard)' : ''}`, 'warn']);
    else if (S.meta?.trip?.askStd) L.push(['Loan terms: Standard, as the trip leader asked. No rare cards drop', '']);
    const kit = kitLine(S.myKit);
    if (kit) L.push([keysIn(`${kit}. Change it in the Garage [G] till the RV leaves`), '']);
  }
  else if (g.ph === 'road') {
    if (!g.town) {
      const left = S.rv ? Math.max(0, S.W.LEN - 8 - S.rv.p.z) : 0;
      L.push([`Drive the RV to ${town}${left > 40 ? `: ${(Math.round(left / 50) * 50).toLocaleString('en-US')} m` : ''}`, '']);
    }
    L.push([`Money for the Repo Man: ${fmt$(Math.max(0, g.bank))}/${fmt$(g.due)}`, g.bank >= g.due ? 'done' : '']);
    L.push(['Pay the Repo Man before midnight', '']);
    if (g.thf > 0) L.push([`Ringtails have ${fmt$(g.thf)} of your stuff at their den`, 'warn']);
    if (g.gb > 0) L.push([`Glovebox: ${g.gb} Road Card${g.gb > 1 ? 's' : ''}. Yours if you pay off the RV on day 5`, '']);
  } else if (g.ph === 'night') {
    L.push([`Paid the Repo Man ${fmt$(g.due)}`, 'done']);
    const n = S.meta?.players.length || 1, b = Math.min(n, g.beds?.length || 0);
    L.push([`Asleep in the RV's bunks: ${b}/${n}`, b >= n ? 'done' : '']);
    if (hp < 100) {
      const q = C.repairQuote(g.day, hp);
      L.push([`RV ${hp}%: Gus fixes ${q.pts}% by the lot for ${fmt$(q.cash)}, or ${fmt$(q.loan)} on ${g.day === C.DAYS - 1 ? 'the balloon payment' : 'tomorrow\'s payment'}`, '']);
    }
    if (g.nxt) L.push([`Tomorrow's payment: ${fmt$(g.nxt)} (with Gus's repairs)`, 'warn']);
  }
  const title = `Day ${Math.min(g.day, C.DAYS)}: ${town}`;
  const key = title + JSON.stringify(L);
  if (key === questKey) return;
  questKey = key;
  $('qtTitle').textContent = title;
  $('qtLines').innerHTML = L.map(([t, c]) => `<div class="qt-line${c ? ' ' + c : ''}">${c === 'done' ? '✓ ' : ''}${escapeHtml(t)}</div>`).join('');
  $('tracker').classList.remove('hidden');
}

// The roster's bars show real state: your own is your stamina; the others' are green while
// they're up, and red while knocked out, draining with the seconds before they wake up alone
// (and pay the doctor), refilling green while you hold E on them.
const koSince = new Map();
function rosterBars() {
  const now = performance.now();
  for (const el of $('roster').children) {
    const id = Number(el.dataset.id);
    let st = 'up', f = 1, r = 0, cap = 0, t = '';
    if (id === S.selfId) {
      if (me.mode === 'ko') { st = 'ko'; f = me.koT / C.PLAYER.KO_TIME; t = `Knocked out ${Math.max(0, Math.ceil(me.koT))}s`; }
      else { st = me.stamina < 25 ? 'low' : 'stam'; f = me.stamina / C.STAMINA.MAX; cap = (C.STAMINA.MAX - me.stamMax) / C.STAMINA.MAX; }
    } else {
      const s = S.renderT != null ? S.interp.samplePlayer(id, S.renderT) : null;
      if (s?.mode === C.MODE.KO) {
        if (!koSince.has(id)) koSince.set(id, now);
        const left = Math.max(0, C.PLAYER.KO_TIME - (now - koSince.get(id)) / 1000);
        st = 'ko'; f = left / C.PLAYER.KO_TIME; t = `Knocked out ${Math.ceil(left)}s`;
        if (target?.kind === 'revive' && target.id === id && reviveT > 0) { r = Math.min(1, reviveT / me.mods.holdT); t = 'Picking up...'; }
      } else if (s) koSince.delete(id);
    }
    f = Math.max(0, Math.min(1, f)); cap = Math.max(0, Math.min(1, cap));
    const key = `${st}|${Math.round(f * 300)}|${Math.round(r * 100)}|${Math.round(cap * 100)}|${t}`;
    if (el._bar === key) continue;
    el._bar = key;
    el.dataset.st = st;
    const pb = el.querySelector('.pb');
    if (!pb) continue;
    pb.style.setProperty('--f', f.toFixed(3));
    pb.style.setProperty('--r', r.toFixed(3));
    pb.style.setProperty('--cap', cap.toFixed(3));
    pb.dataset.t = t;
  }
}

requestAnimationFrame(frame);
