// NO MONEY DOWN — client entry.
import * as C from '/shared/constants.js';
import { generateLeg } from '/shared/world.js';
import { LOOT, fmt$ } from '/shared/loot.js';
import { RV_DIM, RV_SEATS, toWorld, toLocal, insideRV, qYaw } from '/shared/rv.js';
import * as net from './net.js';
import * as voice from './voice.js';
import { initAudio, sfx, setLoops } from './sfx.js';
import { THREE, initGfx, scene, camera, renderer, render, setTimeOfDay, updateSun, setBiome, labelSprite, flat } from './gfx.js';
import { initPhys, LocalWorld, G } from './phys.js';
import { Me } from './player.js';
import { Interp } from './interp.js';
import { buildWorld, updateWorld } from './world3d.js';
import { RVView } from './rv3d.js';
import { buildProp, mapCanvas, prewarm as prewarmProps } from './props3d.js';
import { PlayerView, Hands, prewarmPlayer } from './people.js';
import { zoneText, uiText } from './labels.js';

const $ = id => document.getElementById(id);
const S = window.__nmd = {
  selfId: null, code: null, meta: null, g: null, W: null, lw: null, wv: null,
  parts: { doors: true, roof: true }, door: false, phase: 'menu',
  props: new Map(), views: new Map(), interp: new Interp(), me: new Me(),
  rv: null, hook: null, gatesOpen: new Set(), seq: 0, odoStart: 0,
};
const me = S.me;
let rvView = null, hands = null;
let locked = false;
const isLocked = () => locked || !!S.forceLock;   // tests flip forceLock (headless has no pointer lock)
let lastPose = 0, lastDrive = 0;
const keys = {};
const inp = { f: 0, r: 0, jump: false, sprint: false, crouch: false, grab: false };
let target = null;            // what the crosshair is on
let reviveT = 0;
let mapRaised = true;
let lastWalkieTx = new Set();
let worldBuilding = false;

// ---- boot ---------------------------------------------------------------------------

initGfx($('canvas'));
const physReady = initPhys().then(() => { $('loading').classList.add('hidden'); });
rvView = new RVView(scene);
hands = new Hands(camera, '#7CFC00');
setTimeOfDay(9);
camera.position.set(0, 30, -120);
camera.lookAt(0, 0, 100);

$('nameInput').value = localStorage.getItem('nmdName') || '';
const myName = () => { const n = $('nameInput').value.trim() || 'Blob'; localStorage.setItem('nmdName', n); return n; };
async function ensureConnected() {
  if (net.connected()) return true;
  try { await net.connect(); return true; } catch (e) { $('menuError').textContent = e.message; return false; }
}
$('hostBtn').onclick = async () => {
  initAudio(); sfx.click();
  await physReady;
  if (await ensureConnected()) net.send({ t: 'create', name: myName(), seed: $('seedInput').value.trim() || null });
};
$('joinBtn').onclick = async () => {
  initAudio(); sfx.click();
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { $('menuError').textContent = 'Room codes are 4 letters.'; return; }
  await physReady;
  if (await ensureConnected()) net.send({ t: 'join', name: myName(), room: code });
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });
$('hCode').onclick = () => { navigator.clipboard?.writeText(S.code || ''); toast('Room code copied. Send it to the boys. 📋'); };

// ---- toasts & ui ---------------------------------------------------------------------

function toast(text, color = '#fff', secs = 4) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderColor = color;
  el.innerHTML = `<span class="tmsg" data-c="${color}" style="--c:${color}">${uiText(text)}</span>`;
  $('toasts').prepend(el);
  while ($('toasts').children.length > 5) $('toasts').lastChild.remove();
  setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 600); }, secs * 1000);
  sfx.toast();
}

function fmtClock(h) {
  const hh = Math.floor(h) % 24, mm = Math.floor((h % 1) * 60);
  return `${((hh + 11) % 12) + 1}:${String(mm).padStart(2, '0')} ${hh >= 12 ? 'PM' : 'AM'}`;
}

// ---- pointer lock & input -------------------------------------------------------------

const canvas = $('canvas');
const uiOpen = () => !$('keypad').classList.contains('hidden') || !$('voicePanel').classList.contains('hidden');
canvas.addEventListener('click', () => { if (!uiOpen()) canvas.requestPointerLock?.(); });
$('clickToPlay').addEventListener('click', () => { if (!uiOpen()) canvas.requestPointerLock?.(); });
document.addEventListener('pointerlockchange', () => {
  locked = document.pointerLockElement === canvas;
  $('clickToPlay').classList.toggle('hidden', locked || S.phase === 'menu' || uiOpen());
  if (!locked) { inp.grab = false; for (const k in keys) keys[k] = false; }
});
document.addEventListener('mousemove', e => {
  if (!locked) return;
  const sens = 0.0022 * (Number(localStorage.getItem('nmdSens')) || 1);
  me.yaw -= e.movementX * sens;
  me.pitch = Math.max(-1.45, Math.min(1.45, me.pitch + e.movementY * sens));
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
  const k = e.key.toLowerCase();
  if (k === ' ' || k === 'tab') e.preventDefault();
  if (keys[k]) return;
  keys[k] = true;
  if (S.phase === 'menu') return;
  if (k === 'e') onUse();
  else if (k === 'q') onDrop();
  else if (k === 'f') { mapRaised = !mapRaised; }
  else if (k === 'r' && me.mode === 'seat' && me.seat === 0) net.send({ t: 'use', kind: 'reel' });
  else if (k === 'h' && me.mode === 'seat' && me.seat === 0) net.send({ t: 'horn' });
  else if (k === 'v') voice.setPtt(true);
  else if (k === 'm') voice.toggleMute();
  else if (k === 't') voice.setWalkieKey(true);
  else if (k === 'f1' || k === '?') { e.preventDefault(); $('help').classList.toggle('hidden'); }
  else if (/^[1-6]$/.test(k)) net.send({ t: 'emote', e: C.EMOTES[Number(k) - 1] });
  else if (k === 'escape') closeKeypad();
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  keys[k] = false;
  if (k === 'v') voice.setPtt(false);
  if (k === 't') voice.setWalkieKey(false);
  if (k === 'e') reviveT = 0;
});
window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; inp.grab = false; });

// ---- interactions ----------------------------------------------------------------------

function excludeSet() {
  const s = new Set();
  if (me.holding && S.lw) { const h = S.lw.propCollider(me.holding.id); if (h != null) s.add(h); }
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
      if (d < (p.type === 'boulder' ? 3.4 : 2.0)) return { prop: p };
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
  if (me.mode === 'seat') return { kind: 'seat', label: me.seat === 0 ? '[E] get up · WASD drive · SPACE brake · R reel winch · H horn' : '[E] get up' };
  if (me.mode === 'ko') return null;
  if (me.hasHook) {
    const a = nearestAnchor();
    return { kind: 'hookhold', label: a ? (a.prop ? '[E] hook the winch onto it' : '[E] hook the winch here') : 'carrying the winch hook — find a post / dead tree · [Q] drop it' };
  }
  const eye = me.eye(S.rv), look = me.look();
  const hit = S.lw.ray(eye, look, C.PLAYER.REACH, G.WORLD | G.RV | G.PROP | G.PLAYER | G.USE | G.HOOK, excludeSet(), true);
  if (!hit) return doorNear() ? { kind: 'door', label: `[E] ${S.door ? 'close' : 'open'} the door` } : null;
  if (hit.kind === 'prop') {
    const p = S.props.get(hit.id);
    if (!p) return null;
    const L = LOOT[p.type];
    if (p.type === 'boulder') return { kind: 'prop', id: p.id, hit, label: 'A 2-ton rock. Shove it with friends (walk into it), or winch it.' };
    if (p.type === 'map') return { kind: 'prop', id: p.id, hit, label: '[Hold LMB] take the road map' };
    const heavy = L.cls === 'heavy' ? ' — HEAVY, get a friend' : '';
    const dmg = p.value < p.max ? ` (was ${fmt$(p.max)})` : '';
    return { kind: 'prop', id: p.id, hit, label: `[Hold LMB] ${L.name} · ${fmt$(p.value)}${dmg}${heavy}` };
  }
  if (hit.kind === 'use') {
    const u = S.W.uses[hit.id];
    if (u.kind === 'keypad' && S.gatesOpen.has(u.arg)) return null;
    return { kind: 'use', id: hit.id, u, label: `[E] ${u.label}` };
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
    if (!u && !me.par && lh.z > 3.8 && lh.y < 1.1) u = 'winch';
    if (u === 'seat0') return { kind: 'rvuse', use: 'seat0', label: '[E] DRIVE' };
    if (u === 'seat1') return { kind: 'rvuse', use: 'seat1', label: '[E] ride shotgun' };
    if (u === 'door') return { kind: 'rvuse', use: 'door', label: '[E] open the door' };
    if (u === 'bunk') return { kind: 'rvuse', use: 'bunk', label: S.g?.ph === 'night' ? '[E] sleep (everyone in a bunk = next day)' : 'bunks (bedtime is after the Repo Man gets paid)' };
    if (u === 'winch') return { kind: 'rvuse', use: 'winch', label: S.hook?.state === 0 ? '[E] take the winch hook' : `[E] ${S.hook?.reeling ? 'stop' : 'start'} reeling in` };
    if (doorNear()) return { kind: 'door', label: `[E] ${S.door ? 'close' : 'open'} the door` };
    if (Math.abs(hit.normal.y) < 0.6 && hit.toi < C.CLIMB.REACH + 0.6) return { kind: 'climb', label: '[Hold LMB] climb' };
    return null;
  }
  if (doorNear()) return { kind: 'door', label: `[E] ${S.door ? 'close' : 'open'} the door` };
  if ((hit.kind === 'terrain' || hit.kind === 'static') && hit.normal.y < 0.79 && hit.toi < C.CLIMB.REACH + 0.6) return { kind: 'climb', label: '[Hold LMB] climb' };
  if (hit.kind === 'gate') return { kind: 'gate', label: 'Locked. The keypad wants a 4-digit code.' };
  return null;
}

function onGrabPress() {
  if (me.mode === 'seat' || me.mode === 'ko' || me.holding || me.hasHook) return;
  const t = target;
  if (t?.kind === 'prop') {
    const p = S.props.get(t.id);
    if (!p) return;
    const eye = me.eye(S.rv);
    S.holdDist = Math.max(C.GRAB.HOLD_MIN, Math.min(C.GRAB.HOLD_MAX, t.hit.toi + 0.1));
    me.holding = { id: p.id, type: p.type };
    net.send({ t: 'grab', kind: 'prop', id: p.id, pt: [t.hit.point.x, t.hit.point.y, t.hit.point.z], d: S.holdDist });
    sfx.grab();
    inp.grab = false;   // holding something, not climbing
  }
}
function onGrabRelease() {
  if (me.holding) { net.send({ t: 'rel' }); me.holding = null; }
}
function onThrow() {
  if (!me.holding) return;
  const l = me.look();
  net.send({ t: 'rel', thr: 1, dir: [l.x, l.y + 0.15, l.z] });
  me.holding = null;
  sfx.throw();
}
function onDrop() {
  if (me.holding) { net.send({ t: 'rel' }); me.holding = null; }
  else if (me.hasHook) { net.send({ t: 'use', kind: 'dropHook' }); me.hasHook = false; }
}
function onPing() {
  const eye = me.eye(S.rv), l = me.look();
  const hit = S.lw?.ray(eye, l, 300, G.WORLD | G.RV | G.PROP | G.PLAYER, excludeSet(), false);
  if (hit) net.send({ t: 'ping', pt: [hit.point.x, hit.point.y, hit.point.z] });
}
function onUse() {
  initAudio();
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

async function buildDay(m) {
  worldBuilding = true;
  await physReady;
  const W = generateLeg(m.seed, m.day);
  if (S.wv) {
    scene.remove(S.wv.group);
    S.wv.terrain?.dispose?.();   // the grass clutter's instance buffers (materials are cached per biome)
    S.wv.group.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.isSkinnedMesh) o.skeleton?.dispose(); });
  }
  if (S.lw) S.lw.free();
  for (const p of S.props.values()) scene.remove(p.mesh);
  S.props.clear();
  S.W = W;
  S.parts = m.parts;
  S.door = !!m.door;
  S.gatesOpen = new Set();
  S.lw = new LocalWorld(W, S.parts);
  setBiome(W.biome);
  S.wv = buildWorld(W);
  scene.add(S.wv.group);
  S.mapCv = mapCanvas(W);
  prewarmProps(W);   // paint the loot atlas and build prop meshes while idle, so the first loot doesn't stall a frame
  rvView.setParts(S.parts);
  S.interp.reset();
  S.dayLabel = m.day;
  zoneText(W.biomeName, `Day ${m.day} of ${C.DAYS}`);   // after the build: the fade starts on the next rendered frames
  worldBuilding = false;
  for (const fn of S.pendingAfterWorld || []) fn();
  S.pendingAfterWorld = [];
}
const afterWorld = fn => { if (worldBuilding || !S.W) (S.pendingAfterWorld ||= []).push(fn); else fn(); };

function addProp(d) {
  if (S.props.has(d.id)) return;
  const mesh = buildProp(d.type, S.W);
  const q = { x: d.q[0], y: d.q[1], z: d.q[2], w: d.q[3] };
  const p = { x: d.x, y: d.y, z: d.z };
  mesh.position.set(p.x, p.y, p.z);
  mesh.quaternion.set(q.x, q.y, q.z, q.w);
  scene.add(mesh);
  S.props.set(d.id, { id: d.id, type: d.type, value: d.value, max: d.max, mesh, pose: { p, q } });
  S.lw.addProp(d.id, d.type, p, q);
  S.interp.seedProp(d.id, p, q);
}
function removeProp(id, fx = null) {
  const p = S.props.get(id);
  if (!p) return;
  if (fx) burst(p.mesh.position, fx.color, fx.n, fx.speed);
  scene.remove(p.mesh);
  S.props.delete(id);
  S.lw?.removeProp(id);
  S.interp.dropProp(id);
  if (me.holding?.id === id) me.holding = null;
}

// ---- network ------------------------------------------------------------------------------

net.on('welcome', m => {
  S.selfId = m.id; S.code = m.code;
  $('menuError').textContent = '';
  $('menu').classList.add('hidden');
  $('game').classList.remove('hidden');
  S.phase = 'game';
  $('clickToPlay').classList.remove('hidden');
  voice.initVoice(m.id, renderVoiceUI);
  renderVoiceUI();
  $('hCode').textContent = `CODE ${m.code}`;
  if (!localStorage.getItem('nmdHelpSeen')) { $('help').classList.remove('hidden'); localStorage.setItem('nmdHelpSeen', '1'); }
});
net.on('error', m => { if (S.phase === 'menu') $('menuError').textContent = m.msg; else toast(m.msg, '#ff8a80'); });
net.on('_close', () => {
  if (S.phase !== 'menu') { location.reload(); }
});
net.on('world', m => {
  const newDay = S.dayLabel != null && S.dayLabel !== m.day;
  buildDay(m).then(() => { if (newDay) { sfx.day(); flash(`DAY ${m.day}`); } });
  $('receipt').classList.add('hidden');
  $('overScreen').classList.add('hidden');
});
net.on('props', m => afterWorld(() => {
  for (const id of [...S.props.keys()]) removeProp(id);
  for (const d of m.list) addProp(d);
}));
net.on('tp', m => afterWorld(() => { me.teleport(m.x, m.y, m.z, m.yaw); me.mode = 'walk'; }));
net.on('meta', m => {
  S.meta = m;
  voice.syncPeers(m.players.map(p => ({ ...p, connected: true })));
  renderVoiceUI();
  const mine = m.players.find(p => p.id === S.selfId);
  if (mine) { hands.setColor(mine.color); S.myWalkie = mine.walkie; S.myColor = mine.color; }
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
  $('roster').innerHTML = m.players.map(p => `<div class="pm" style="--c:${p.color}"><span class="pf"><b>${escapeHtml((Array.from(String(p.name).trim())[0] || '?').toUpperCase())}</b>${p.id === m.host ? '<i class="ico ico-crown" title="trip leader"></i>' : ''}${p.voice ? '<i class="ico ico-speaker" title="in voice"></i>' : ''}${p.walkie ? '<i class="ico ico-walkie" title="has a walkie"></i>' : ''}</span><span class="pn">${escapeHtml(p.name)}</span><span class="pb"><i></i></span></div>`).join('');
});
net.on('s', m => {
  if (!S.W || worldBuilding) return;
  S.interp.push(m, performance.now());
  S.g = m.g;
  S.door = !!m.g.door;
  for (const id of m.g.gates) if (!S.gatesOpen.has(id)) { S.gatesOpen.add(id); S.lw.openGate(id); const gv = S.wv.gates.get(id); if (gv) gv.target = 1; }
});
net.on('toast', m => toast(m.text, m.color, m.secs));
net.on('knock', m => { me.knock(m.v, m.ko); sfx.knock(); shake(0.6); });
net.on('seat', m => {
  if (m.seat == null) { me.unsit(m.exit); }
  else { if (me.holding) onGrabRelease(); me.sit(m.seat); }
});
net.on('grabbed', m => { if (!m.ok && me.holding?.id === m.id) me.holding = null; });
net.on('hooked', m => { me.hasHook = !!m.on; if (m.on) sfx.hook(); });
net.on('drink', () => { me.buffT = 60; me.stamina = me.stamMax; sfx.drink(); });
net.on('revived', () => { me.revive(); sfx.wake(); });
net.on('parts', m => { S.parts = m.parts; rvView.setParts(m.parts); S.lw?.setParts(m.parts, S.door); });
net.on('emote', m => { const v = S.views.get(m.id); if (v) v.emote = { e: m.e, t: 3 }; if (m.id === S.selfId) toast(`you: ${m.e}`, '#fff', 1.5); });
net.on('ping', m => addPing(m));
net.on('receipt', m => showReceipt(m));
net.on('over', m => showOver(m));
net.on('ev', m => { for (const e of m.list) onEvent(e); });

function onEvent(e) {
  switch (e.k) {
    case 'spawn': afterWorld(() => addProp(e.p)); break;
    case 'break': {
      const p = S.props.get(e.id);
      if (p) { removeProp(e.id, { color: '#ffffff', n: 22, speed: 5 }); }
      positional(e, () => sfx.shatter());
      floatText(e, `-${fmt$(e.lost)} 💥`, '#ff5252');
      break;
    }
    case 'dmg': {
      const p = S.props.get(e.id);
      if (p) { p.value = e.value; if (e.lost >= 15) { floatText(p.mesh.position, `-${fmt$(e.lost)}`, '#ffb4a2'); positional(p.mesh.position, () => sfx.thunk(Math.min(1, e.lost / 120))); } }
      break;
    }
    case 'sold': for (const id of e.ids) removeProp(id, { color: '#7CFC00', n: 10, speed: 3 }); sfx.kaching(); break;
    case 'bill': sfx.bill(); break;
    case 'horn': sfx.horn(); break;
    case 'door': S.door = e.open; sfx.door(); break;
    case 'hook': sfx.hook(); if (e.what === 'yanked' && e.by === S.selfId) { me.hasHook = false; toast('The cable ran out — the hook got yanked out of your hands.', '#ffb4a2'); } break;
    case 'reel': toast(e.on ? 'Winch reeling in…' : 'Winch stopped.', '#f2c14e', 2); break;
    case 'creak': sfx.creak(); break;
    case 'gate': sfx.gate(); break;
    case 'buzz': sfx.buzz(); break;
    case 'slip': if (e.by === S.selfId) { me.holding = null; toast('It slipped out of your hands.', '#ffb4a2', 2); } break;
    case 'throw': break;
    case 'bet': S.bets = (S.bets || 0) + 1; S.lastBet = e; (e.won > 0 ? sfx.win : e.won < 0 ? sfx.lose : sfx.click)(); break;
    case 'flip': sfx.coin(); break;
    case 'repo': sfx.repo(); shake(0.4); break;
    case 'thud': sfx.thunk(1); break;
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
    ${row('Payment', m.paid ? `PAID ${fmt$(m.due)}` : `MISSED (${fmt$(m.due)})`, m.paid ? 'good' : 'bad')}
    ${row('Bank', fmt$(m.bank))}
    ${!m.paid ? `<p class="bad">The Repo Man took: <b>${!m.parts.doors && m.parts.roof ? 'the doors' : !m.parts.roof ? 'the roof' : 'nothing (yet)'}</b></p>` : ''}
    <p class="hint">Campfire's lit. The store is open. When everyone's in a bunk (E on the bed in the RV), day ${m.day + 1} starts.</p>
    <button class="btn small green" id="receiptClose">Okay</button>`;
  $('receipt').classList.remove('hidden');
  $('receiptClose').onclick = () => $('receipt').classList.add('hidden');
  sfx.sleep();
}
function showOver(m) {
  const s = m.stats || {};
  $('overScreen').innerHTML = m.won
    ? `<h1 class="won">You Own the RV</h1><div class="filigree"></div><p>Five days, ${fmt$(s.sold || 0)} of pawned junk, and the Slopmaster 9000 is finally, legally, yours.</p>`
    : `<h1 class="lost">Repo'd</h1><div class="filigree"></div><p>Day ${m.day}. The Repo Man hooks the Slopmaster and drives off into the sunset without you.</p>`;
  $('overScreen').innerHTML += `
    <div class="rrow"><span>Pawned in total</span><b>${fmt$(s.sold || 0)}</b></div>
    <div class="rrow"><span>Medical bills</span><b>${fmt$(s.bills || 0)}</b></div>
    <div class="rrow"><span>Loot destroyed</span><b>${fmt$(s.broken || 0)}</b></div>
    <div class="rrow"><span>Knockouts</span><b>${s.kos || 0}</b></div>
    ${s.bestWin ? `<div class="rrow good"><span>Best bet</span><b>${escapeHtml(s.bestWin.name || 'the crew')} +${fmt$(s.bestWin.amt)} (${s.bestWin.game})</b></div>` : ''}
    ${s.worstLoss ? `<div class="rrow bad"><span>Worst bet</span><b>${escapeHtml(s.worstLoss.name || 'the crew')} ${fmt$(s.worstLoss.amt)} (${s.worstLoss.game})</b></div>` : ''}
    <p class="hint">A new run starts in a few seconds.</p>`;
  $('overScreen').classList.remove('hidden');
  (m.won ? sfx.win : sfx.repo)();
}

// ---- little fx -------------------------------------------------------------------------------

const particles = [];
function burst(at, color, n = 12, speed = 4) {
  for (let i = 0; i < n; i++) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.06), flat(color));
    m.position.copy(at);
    scene.add(m);
    particles.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * speed, Math.random() * speed, (Math.random() - 0.5) * speed), life: 1.2 });
  }
}
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
let shakeAmt = 0;
function shake(a) { shakeAmt = Math.max(shakeAmt, a); }
function flash(text) {
  $('flash').textContent = text;
  $('flash').classList.remove('hidden');
  $('flash').style.animation = 'none'; void $('flash').offsetWidth; $('flash').style.animation = '';
  setTimeout(() => $('flash').classList.add('hidden'), 2600);
}
function positional(at, fn) {
  if (!at) return fn();
  const d = Math.hypot(at.x - camera.position.x, at.y - camera.position.y, at.z - camera.position.z);
  if (d < 45) fn();
}

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
    $('voiceTxHint').textContent = VV.muted ? 'muted (M)' : VV.mode === 'ptt' ? (VV.ptt ? 'talking…' : 'hold V to talk') : 'proximity mic';
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
$('sensInput').value = localStorage.getItem('nmdSens') || '1';
$('sensInput').oninput = e => localStorage.setItem('nmdSens', e.target.value);

// ---- the frame ------------------------------------------------------------------------------

let lastT = performance.now(), time = 0;
const _v = new THREE.Vector3();

function frame(now) {
  // test/debug hooks
S.aimAt = (x, y, z) => { const e = me.eye(S.rv); const dx = x - e.x, dy = y - e.y, dz = z - e.z; me.yaw = Math.atan2(dx, dz); me.pitch = -Math.atan2(dy, Math.hypot(dx, dz)); };
S.press = (fn) => ({ grab: onGrabPress, release: onGrabRelease, use: onUse, throw: onThrow, drop: onDrop })[fn]?.();
S.target = () => target;
S.send = m => net.send(m);
S.renderer = () => renderer;   // tools read draw-call counts
requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  time += dt;
  S.frames = (S.frames || 0) + 1;
  if (!S.W || worldBuilding || !S.lw) { if (!S.noRender) render(); return; }

  const rt = S.interp.time(now);
  S.renderT = rt;
  const rv = rt != null ? S.interp.sampleRV(rt) : null;
  S.rv = rv;
  S.hook = rt != null ? S.interp.sampleHook(rt) : null;
  if (rv) S.lw.setRV(rv.p, rv.q);
  S.lw.setParts(S.parts, S.door);
  S.lw.setHook(S.hook && S.hook.state !== 0 ? { x: S.hook.x, y: S.hook.y, z: S.hook.z } : null);
  for (const p of S.props.values()) {
    const s = rt != null ? S.interp.sampleProp(p.id, rt) : null;
    if (!s) continue;
    p.pose = s;
    p.mesh.position.set(s.p.x, s.p.y, s.p.z);
    p.mesh.quaternion.set(s.q.x, s.q.y, s.q.z, s.q.w);
    S.lw.setProp(p.id, s.p, s.q);
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
      others.set(p.id, { pos, yaw, pitch: s.pitch, mode: s.mode, flags: s.flags });
      S.lw.setPlayer(p.id, pos, s.mode === C.MODE.KO);
    }
  }
  S.lw.step();

  // me
  const typing = uiOpen();
  inp.f = typing ? 0 : (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0);
  inp.r = typing ? 0 : (keys.d || keys.arrowright ? 1 : 0) - (keys.a || keys.arrowleft ? 1 : 0);
  inp.jump = !typing && !!keys[' '] && !S.jumpLatch;
  S.jumpLatch = !!keys[' '];
  inp.sprint = !!keys.shift;
  inp.crouch = !!keys.control || !!keys.c;
  if (me.mode === 'seat') { inp.f = 0; inp.r = 0; inp.jump = false; }
  me.update(dt, { ...inp, grab: inp.grab && isLocked() }, S.lw, rv, excludeSet());
  for (const e of me.events) {
    if (e.k === 'step') sfx.step();
    else if (e.k === 'climbstep') sfx.climb();
    else if (e.k === 'jump') sfx.jump();
    else if (e.k === 'land') { sfx.land(e.s); if (e.s > 9) shake(Math.min(0.5, e.s / 30)); }
    else if (e.k === 'grabwall') sfx.wall();
    else if (e.k === 'lunge') sfx.lunge();
    else if (e.k === 'letgo' || e.k === 'exhausted') { sfx.letgo(); if (e.k === 'exhausted') toast('Out of stamina — you let go.', '#ffb4a2', 2); }
    else if (e.k === 'mantle') sfx.grab();
    else if (e.k === 'lurch') { sfx.thunk(Math.min(1, e.a / 20)); shake(Math.min(0.6, e.a / 40)); }
    else if (e.k === 'ko') { net.send({ t: 'ko', why: e.why }); sfx.ko(); if (me.holding) onGrabRelease(); if (me.hasHook) { net.send({ t: 'use', kind: 'dropHook' }); me.hasHook = false; } }
    else if (e.k === 'wake') { net.send({ t: 'wake' }); sfx.wake(); }
  }
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
    net.send(pose);
  }
  if (me.mode === 'seat' && me.seat === 0 && now - lastDrive > 50) {
    lastDrive = now;
    const typingNow = uiOpen();
    net.send({ t: 'drv', th: typingNow ? 0 : (keys.w || keys.arrowup ? 1 : 0) - (keys.s || keys.arrowdown ? 1 : 0), st: typingNow ? 0 : (keys.a || keys.arrowleft ? 1 : 0) - (keys.d || keys.arrowright ? 1 : 0), hb: keys[' '] ? 1 : 0 });
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
  camera.fov = 74 + (me.sprinting ? 6 : 0);
  camera.updateProjectionMatrix();

  // views of other players
  for (const [id, st] of others) {
    let v = S.views.get(id);
    const p = S.meta.players.find(q => q.id === id);
    if (!v) { v = new PlayerView(scene, p); S.views.set(id, v); }
    st.speaking = voice.V.speaking[id];
    st.walkieTx = !!(st.flags & C.FLAG.WALKIE_TX);
    v.update(dt, time, st);
  }
  for (const [id, v] of S.views) if (!others.has(id)) v.group.visible = false; else v.group.visible = true;

  // the RV, its hook, its dashboard
  const night = S.g ? (S.g.ph === 'night' || S.g.clk >= 20.2) : false;
  const odo = rv ? rv.p.z - S.W.camp.rv.z : 0;
  rvView.update(dt, rv, S.door, night, S.hook, odo, S.g ? fmtClock(S.g.clk) : '');
  if (S.g) setTimeOfDay(S.g.clk, S.g.ph === 'night');
  updateSun(me.pos);
  updateWorld(S.wv, dt, time, camera.position);
  updateCasino(dt);

  // hands & map
  hands.update(dt, me, Math.abs(inp.f) + Math.abs(inp.r) > 0 && me.grounded, me.sprinting);
  if (me.holding?.type === 'map' && mapRaised) hands.showMap(S.mapCv); else hands.hideMap();

  // what am I looking at
  target = computeTarget();
  $('prompt').textContent = target?.label || '';
  $('prompt').classList.toggle('hidden', !target?.label);
  if (target?.kind === 'revive' && keys.e && reviveT > 0) {
    reviveT += dt;
    if (reviveT >= C.PLAYER.REVIVE_HOLD) { net.send({ t: 'use', kind: 'revive', id: target.id }); reviveT = 0; }
  } else if (!keys.e) reviveT = 0;
  $('holdBar').classList.toggle('hidden', !(reviveT > 0));
  $('holdBar').firstElementChild.style.width = `${Math.min(100, reviveT / C.PLAYER.REVIVE_HOLD * 100)}%`;

  // fx
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.life -= dt; p.v.y -= 9.8 * dt;
    p.m.position.addScaledVector(p.v, dt);
    p.m.rotation.x += dt * 8;
    if (p.life <= 0) { scene.remove(p.m); particles.splice(i, 1); }
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    if (!f.ping) f.s.position.y += dt * 0.6;
    f.s.material.opacity = Math.min(1, f.life);
    if (f.life <= 0) { scene.remove(f.s); floaters.splice(i, 1); }
  }

  // audio
  const drv = S.g?.drv;
  const rvSpeed = rv ? Math.hypot(rv.v.x, rv.v.z) : 0;
  const rvDist = rv ? Math.hypot(rv.p.x - me.pos.x, rv.p.y - me.pos.y, rv.p.z - me.pos.z) : 999;
  setLoops({
    engineOn: !!drv, rpm: Math.min(1.4, rvSpeed / 12), near: Math.max(0, 1 - rvDist / 60),
    winchOn: !!S.hook?.reeling && rvDist < 50,
    windAmt: me.par ? Math.min(1, rvSpeed / 14) * (insideRV(...Object.values(me.lp || { x: 9, y: 9, z: 9 })) ? 0.2 : 1) : 0.15 + Math.max(0, me.pos.y - S.W.roadY(me.pos.z)) / 40,
  });
  updateVoice(others);
  // walkie static when someone keys up
  const tx = new Set([...others].filter(([, s]) => s.flags & C.FLAG.WALKIE_TX).map(([id]) => id));
  if (S.myWalkie) for (const id of tx) if (!lastWalkieTx.has(id)) sfx.radio();
  lastWalkieTx = tx;

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
    if (d > 1.5 && d < 46) {
      const hit = S.lw.ray(eye, { x: dx / d, y: dy / d, z: dz / d }, d - 0.6, G.WORLD | G.RV, null, false);
      occluded = !!hit;
    }
    const radio = !!(s.flags & C.FLAG.WALKIE_TX) && !!S.myWalkie;
    return { head, occluded, ko: s.mode === C.MODE.KO, radio };
  });
}

// ---- the casino table -----------------------------------------------------------------------

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
let lastCards = '';
function updateCasino(dt) {
  const w = S.wv, g = S.g;
  if (!w || !g) return;
  const bj = g.bj;
  const T = S.W.town;
  const key = JSON.stringify([bj.cards, bj.up, bj.dl]);
  if (key !== lastCards) {
    lastCards = key;
    while (w.cardGroup.children.length) w.cardGroup.remove(w.cardGroup.children[0]);
    const place = (codes, row) => codes.forEach((c, i) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(0.32, 0.44), new THREE.MeshStandardMaterial({ map: cardTexture(c), roughness: 0.6 }));
      m.rotation.x = -Math.PI / 2;
      const off = (i - (codes.length - 1) / 2) * 0.36;
      const s = Math.sin(T.bj.ry), co = Math.cos(T.bj.ry);
      const lx = off, lz = row;
      m.position.set(T.bj.table.x + lx * co + lz * s, T.bj.table.y + 0.01 + i * 0.002, T.bj.table.z - lx * s + lz * co);
      m.rotation.z = T.bj.ry;
      w.cardGroup.add(m);
    });
    if (bj.cards) place(bj.cards, 0.35);
    if (bj.dl) place(bj.dl, -0.45);
    else if (bj.up) place([bj.up, '??'], -0.45);
  }
  const voteTxt = bj.st === 'vote' ? `HIT ${bj.hit.length} · STAND ${bj.stand.length} · ${bj.left}s` : '';
  w.bjLabel.userData.set(
    bj.st === 'bet' ? `BLACKJACK · bet ${fmt$(bj.bet)}${bj.bet ? ' · press DEAL' : ''}`
      : bj.st === 'vote' ? `YOU: ${bj.tot} vs ${bj.up} · ${voteTxt}`
        : `${(bj.out || '').toUpperCase()} — you ${bj.tot} · dealer ${bj.dt}`,
    bj.st === 'result' ? (bj.out === 'win' || bj.out === 'natural' ? '#7CFC00' : bj.out === 'push' ? '#fff' : '#ff5252') : '#fff');
  const f = g.flip;
  w.flipLabel.userData.set(f.busy ? 'FLIPPING…' : f.last && f.last.ago < 4 ? (f.last.win ? `DOUBLED! +${fmt$(f.last.stake)}` : `NOTHING. -${fmt$(f.last.stake)}`) : `DOUBLE OR NOTHING · stake ${fmt$(f.stake)}`,
    f.busy ? '#ffd166' : f.last && f.last.ago < 4 ? (f.last.win ? '#7CFC00' : '#ff5252') : '#ffd166');
  w.coin.rotation.z += dt * (f.busy ? 25 : 0.6);
  w.pawnLabel.userData.set(g.pawn ? `ED OFFERS ${fmt$(g.pawn)} · ring the bell` : 'PUT LOOT ON THE COUNTER', g.pawn ? '#7CFC00' : '#ffe9a8');
  w.hitPad.material.emissiveIntensity = bj.st === 'vote' ? 0.4 + Math.sin(time * 6) * 0.2 : 0.15;
  w.standPad.material.emissiveIntensity = bj.st === 'vote' ? 0.4 + Math.cos(time * 6) * 0.2 : 0.15;
}

// ---- hud ------------------------------------------------------------------------------------------

function hud(rv) {
  const g = S.g;
  if (g) {
    $('hDay').textContent = `DAY ${Math.min(g.day, C.DAYS)}/${C.DAYS}`;
    $('hClock').textContent = g.ph === 'night' ? 'NIGHT' : g.ph === 'camp' ? `${fmtClock(g.clk)} · leave camp to start the clock` : fmtClock(g.clk);
    $('hClock').classList.toggle('late', g.ph === 'road' && g.clk >= 21);
    $('hBank').textContent = `BANK ${fmt$(g.bank)}`;
    $('hBank').classList.toggle('neg', g.bank < 0);
    $('hDue').textContent = g.paid ? `PAID ✓` : `DUE ${fmt$(g.due)} @ MIDNIGHT`;
    $('hDue').classList.toggle('ok', !!g.paid || g.bank >= g.due);
    $('hStrikes').textContent = `STRIKES ${g.str}/${C.STRIKES_TO_LOSE - 1}`;
    $('hStrikes').classList.toggle('red', g.str > 0);
    $('hStrikes').title = 'Missed payments. Two strikes take parts of the RV. The third takes the RV.';
  }
  const pct = Math.max(0, me.stamina / C.STAMINA.MAX * 100);
  $('stamFill').style.width = `${pct}%`;
  $('stamFill').classList.toggle('low', me.stamina < 25);
  $('stamCap').style.width = `${Math.max(0, (C.STAMINA.MAX - me.stamMax) / C.STAMINA.MAX * 100)}%`;
  $('stamina').classList.toggle('hidden', me.stamina >= me.stamMax - 0.5 && me.mode !== 'climb' && me.stamMax >= C.STAMINA.MAX);
  let held = '';
  if (me.holding) {
    const p = S.props.get(me.holding.id);
    held = p ? (p.type === 'map' ? 'ROAD MAP — [F] raise/lower · [Q] drop' : `${LOOT[p.type].name} · ${fmt$(p.value)} · [RMB] throw · [Q] drop · wheel: distance`) : '';
  } else if (me.hasHook) held = 'WINCH HOOK clipped to your belt';
  $('heldLabel').textContent = held;
  $('heldLabel').classList.toggle('hidden', !held);
  $('koOverlay').classList.toggle('hidden', me.mode !== 'ko');
  if (me.mode === 'ko') $('koT').textContent = `${Math.ceil(me.koT)}s — or until a friend picks you up (hold E). Waking up alone costs ${fmt$(C.medBill(g?.day || 1))}.`;
  const driving = me.mode === 'seat' && me.seat === 0;
  $('driveHint').classList.toggle('hidden', !driving);
  if (driving && rv) $('driveHint').textContent = `${Math.round(Math.hypot(rv.v.x, rv.v.z) * 3.6)} km/h${g?.mud ? ' · STUCK IN MUD — get the boys to push' : ''}${S.hook && S.hook.state !== 0 ? ` · winch ${S.hook.reeling ? 'REELING' : 'slack'} (R)` : ''}`;
  $('walkieHint').classList.toggle('hidden', !S.myWalkie);
  $('walkieHint').classList.toggle('tx', !!voice.V.walkieKey);
}

requestAnimationFrame(frame);
