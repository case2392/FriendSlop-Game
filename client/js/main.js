import * as C from '/shared/constants.js';
import * as net from './net.js';
import { initAudio, sfx } from './sfx.js';
import { initRender, frame, applySnapshot, resetArena, confetti, emoteAt, getCamYaw, turnCam } from './render.js';
import * as voice from './voice.js';

const $ = id => document.getElementById(id);

const S = {
  selfId: null,
  code: null,
  meta: null,
  snap: null,
  minigame: null,   // current/upcoming chamber id
  scene: null,      // 'hub' or chamber id — what the renderer should draw
  phase: 'menu',
  hubMode: null,
  lastCountdown: null,
  celebrated: false,
};

function showScreen(name) {
  for (const s of ['menu', 'game']) $(s).classList.toggle('hidden', s !== name);
}

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---- menu ---------------------------------------------------------------------

$('nameInput').value = localStorage.getItem('slopName') || '';

function myName() {
  const n = $('nameInput').value.trim() || 'Blob';
  localStorage.setItem('slopName', n);
  return n;
}

async function ensureConnected() {
  if (net.connected()) return true;
  try { await net.connect(); return true; }
  catch (e) { $('menuError').textContent = e.message; return false; }
}

$('hostBtn').onclick = async () => {
  initAudio(); sfx.click();
  if (await ensureConnected()) net.send({ t: 'create', name: myName() });
};
$('joinBtn').onclick = async () => {
  initAudio(); sfx.click();
  const code = $('codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { $('menuError').textContent = 'Room codes are 4 letters.'; return; }
  if (await ensureConnected()) net.send({ t: 'join', name: myName(), room: code });
};
$('codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('joinBtn').click(); });

// ---- in-world UI ---------------------------------------------------------------

$('hudCode').onclick = () => {
  navigator.clipboard?.writeText(S.code || '');
  toast('Code copied. Send it to the boys. 📋');
};
$('addBotBtn').onclick = () => { sfx.click(); net.send({ t: 'addbot' }); };
$('kickBotBtn').onclick = () => { sfx.click(); net.send({ t: 'kickbot' }); };

// ---- voice chat UI ---------------------------------------------------------------

const VV = voice.V;
S.voice = VV; // render + tests read speaking state from here

function renderVoiceUI() {
  $('voiceJoinBtn').classList.toggle('hidden', VV.on);
  $('voiceJoinBtn').disabled = VV.connecting;
  $('voiceJoinBtn').textContent = VV.connecting ? '🎙 …' : '🎙 JOIN VOICE';
  $('voiceLive').classList.toggle('hidden', !VV.on);

  const err = $('voiceErr');
  err.classList.toggle('hidden', !VV.err);
  err.textContent = VV.err || '';

  if (VV.on) {
    const tx = !VV.muted && (VV.mode === 'open' || VV.ptt);
    const mb = $('voiceMuteBtn');
    mb.textContent = VV.muted ? '🔇' : '🎙';
    mb.classList.toggle('off', VV.muted);
    const hint = $('voiceTxHint');
    hint.textContent = VV.muted ? 'muted (M)'
      : VV.mode === 'ptt' ? (VV.ptt ? 'talking…' : 'hold V to talk')
      : (VV.speaking[S.selfId] ? 'talking…' : 'open mic');
    hint.classList.toggle('hot', tx && !!VV.speaking[S.selfId]);
  }

  // roster chips: everyone in voice, lit while talking
  const roster = $('voiceRoster');
  roster.innerHTML = '';
  if (VV.on) {
    for (const p of S.meta?.players || []) {
      if (!p.voice || !p.connected) continue;
      const chip = document.createElement('span');
      chip.className = 'voice-chip' + (VV.speaking[p.id] ? ' talking' : '');
      chip.style.color = p.color;
      chip.textContent = (VV.speaking[p.id] ? '🔊 ' : '') + p.name;
      roster.appendChild(chip);
    }
  }

  // per-player rows in the settings panel
  const rows = $('voicePeerRows');
  rows.innerHTML = '';
  for (const [id, peer] of VV.peers) {
    const p = S.meta?.players.find(q => q.id === id);
    const row = document.createElement('div');
    row.className = 'voice-peer-row';
    const nm = document.createElement('span');
    nm.className = 'vp-name';
    nm.style.color = p?.color || '#fff';
    nm.textContent = p?.name || `player ${id}`;
    const vol = document.createElement('input');
    vol.type = 'range'; vol.min = 0; vol.max = 1.5; vol.step = 0.05; vol.value = peer.vol;
    vol.oninput = () => voice.setPeerVol(id, Number(vol.value));
    const mute = document.createElement('button');
    mute.className = 'voice-btn' + (peer.muted ? ' off' : '');
    mute.textContent = peer.muted ? '🔇' : '🔊';
    mute.onclick = () => voice.togglePeerMute(id);
    row.append(nm, vol, mute);
    rows.appendChild(row);
  }

  // mic list
  const sel = $('voiceMicSel');
  const cur = sel.value;
  sel.innerHTML = '';
  for (const m of VV.mics) {
    const o = document.createElement('option');
    o.value = m.deviceId; o.textContent = m.label;
    if (m.deviceId === (VV.micId || cur)) o.selected = true;
    sel.appendChild(o);
  }
  if (!VV.mics.length) {
    const o = document.createElement('option');
    o.textContent = 'default mic';
    sel.appendChild(o);
  }

  document.querySelectorAll('input[name=voiceMode]').forEach(r => { r.checked = r.value === VV.mode; });
  $('voiceMasterVol').value = VV.masterVol;
}

$('voiceJoinBtn').onclick = () => { initAudio(); sfx.click(); voice.joinVoice(); };
$('voiceLeaveBtn').onclick = () => { sfx.click(); voice.leaveVoice(); $('voicePanel').classList.add('hidden'); };
$('voiceMuteBtn').onclick = () => { sfx.click(); voice.toggleMute(); };
$('voiceCfgBtn').onclick = () => { sfx.click(); $('voicePanel').classList.toggle('hidden'); voice.refreshMics(); };
$('voicePanelClose').onclick = () => $('voicePanel').classList.add('hidden');
$('voiceMicSel').onchange = e => voice.setMic(e.target.value);
$('voiceMasterVol').oninput = e => voice.setMasterVol(Number(e.target.value));
document.querySelectorAll('input[name=voiceMode]').forEach(r => {
  r.onchange = () => voice.setMode(r.value);
});

function ruleStrip() {
  const m = S.meta;
  if (!m) return '';
  const info = C.MINIGAME_INFO[m.minigame] || {};
  const cred = info.based ? ` <span style="opacity:.65">· an homage to ${info.based}</span>` : '';
  if (S.phase === 'play') {
    if (m.minigame === 'casino') {
      return `<b>${info.icon} ${info.name}</b> — walk onto a floor zone to vote: <b>HIT 👊</b> left, <b>STAND ✋</b> right. Majority of bodies rules. Ties hit.${cred}`;
    }
    return `<b>${info.icon || ''} ${info.name || ''}</b> — ${info.desc || ''}${cred}`;
  }
  if (m.hubMode === 'lobby') {
    return m.players.length < 2
      ? `Welcome to <b>THE DEN</b>. You need at least 2 slop-people — send the code <b>${S.code}</b> to the boys${m.hostId === S.selfId ? ' or hit <b>+ BOT</b>' : ''}.`
      : `<b>${info.icon || ''} CHAMBER 1: ${info.name || ''}</b>${cred} — walk the squad into the glowing gate to descend.`;
  }
  if (m.hubMode === 'gate') {
    return `<b>${info.icon || ''} CHAMBER ${m.chamber + 1}/${m.chambers}: ${info.name || ''}</b>${m.attempts > 0 ? ` (attempt ${m.attempts + 1})` : ''}${cred} — walk into the gate when the boys are ready.`;
  }
  return '';
}

// ---- emotes ---------------------------------------------------------------------

const emoteBar = $('emoteBar');
C.EMOTES.forEach((e, i) => {
  const b = document.createElement('button');
  b.textContent = e;
  b.title = `key ${i + 1}`;
  b.onclick = () => net.send({ t: 'emote', e });
  emoteBar.appendChild(b);
});

// ---- input ------------------------------------------------------------------------

// WASD is camera-relative: W walks where you're looking (mouse-look via
// pointer lock; Q/E also turn for the mouseless).
const keys = { fwd: false, back: false, left: false, right: false, q: false, e: false };
const KEYMAP = {
  w: 'fwd', arrowup: 'fwd',
  s: 'back', arrowdown: 'back',
  a: 'left', arrowleft: 'left',
  d: 'right', arrowright: 'right',
  q: 'q', e: 'e',
};

let lastSent = '';
function pushInput(dash = false) {
  const f = (keys.fwd ? 1 : 0) - (keys.back ? 1 : 0);
  const r = (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  const yaw = getCamYaw();
  let mx = Math.sin(yaw) * f + Math.cos(yaw) * r;
  let my = -Math.cos(yaw) * f + Math.sin(yaw) * r;
  const len = Math.hypot(mx, my);
  if (len > 1) { mx /= len; my /= len; }
  const msg = { t: 'input', mx: Math.round(mx * 100) / 100, my: Math.round(my * 100) / 100, dash };
  const sig = JSON.stringify(msg);
  if (dash || sig !== lastSent) { lastSent = sig; net.send(msg); }
}
// while walking, keep re-sending so mouse turns steer the run
setInterval(() => { if (keys.fwd || keys.back || keys.left || keys.right) pushInput(); }, 90);

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (KEYMAP[k] && !keys[KEYMAP[k]]) { keys[KEYMAP[k]] = true; pushInput(); }
  else if (k === ' ' || k === 'shift') { e.preventDefault(); pushInput(true); }
  else if (k === 'v') voice.setPtt(true);
  else if (k === 'm') voice.toggleMute();
  else if (/^[1-6]$/.test(k) && S.phase !== 'menu') net.send({ t: 'emote', e: C.EMOTES[Number(k) - 1] });
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (KEYMAP[k] && keys[KEYMAP[k]]) { keys[KEYMAP[k]] = false; pushInput(); }
  else if (k === 'v') voice.setPtt(false);
});

// ---- net handlers ------------------------------------------------------------------

net.on('welcome', m => {
  S.selfId = m.id;
  S.code = m.code;
  $('menuError').textContent = '';
  window.__slop = S; // debug/test handle
  voice.initVoice(m.id, renderVoiceUI);
  renderVoiceUI();
  setTimeout(() => toast('🖱️ click the world to look around · WASD walk · SPACE dash · 🎙 voice bottom-left', 5200), 800);
});

net.on('error', m => {
  if (S.phase === 'menu') $('menuError').textContent = m.msg;
  else toast(m.msg);
});

net.on('_close', () => {
  if (S.phase !== 'menu') {
    showScreen('menu');
    S.phase = 'menu';
    $('menuError').textContent = 'Lost connection to the slop server.';
  }
});

net.on('emote', m => emoteAt(m.id, m.e));

net.on('podium', m => {
  if (m.escaped) { confetti(); confetti(); sfx.win(); }
  else sfx.lose();
});

net.on('state', m => {
  S.snap = m;
  applySnapshot(m, S.meta, S.selfId);
  if (S.phase === 'play' && m.countdown !== S.lastCountdown) {
    S.lastCountdown = m.countdown;
    const el = $('countdownBig');
    if (m.countdown > 0) {
      el.classList.remove('hidden');
      el.textContent = m.countdown;
      el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
      sfx.tick();
    } else {
      el.textContent = 'SLOP!';
      sfx.go();
      setTimeout(() => el.classList.add('hidden'), 600);
    }
  }
});

net.on('meta', m => {
  const prevScene = S.scene;
  S.meta = m;
  voice.syncPeers(m.players);
  renderVoiceUI();
  S.minigame = m.minigame;
  S.phase = m.phase;
  S.hubMode = m.hubMode;
  S.scene = m.phase === 'play' ? m.minigame : 'hub';

  showScreen('game');
  $('hud').classList.remove('hidden');
  $('hostTools').classList.toggle('hidden', !(m.hostId === S.selfId && m.hubMode === 'lobby' && m.phase === 'hub'));

  if (S.scene !== prevScene) {
    S.snap = null;
    S.lastCountdown = null;
    resetArena();
    if (m.phase === 'play') sfx.go();
  }

  $('hudCode').textContent = S.code || '';
  $('hudChamber').textContent = `CHAMBER ${Math.min(m.chamber + 1, m.chambers)}/${m.chambers}`;
  const me = m.players.find(p => p.id === S.selfId);
  $('hudMoney').textContent = `${me?.coins ?? 0} 💰`;
});

// ---- render loop ---------------------------------------------------------------------

initRender($('canvas'));
let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (keys.q) turnCam(-dt * 2.6);
  if (keys.e) turnCam(dt * 2.6);

  if (S.phase !== 'menu') {
    const ex = S.snap?.extra;
    const strip = ruleStrip();
    $('ruleStrip').innerHTML = strip;
    $('ruleStrip').classList.toggle('hidden', !strip);

    if (S.phase === 'play') {
      $('hudTimer').textContent = ex?.tl ?? '';
      $('hudTimer').classList.toggle('hidden', ex?.tl == null);
      $('hudGoal').textContent = ex?.goal || '';
      const lives = ex?.lives;
      $('hudLives').textContent = lives != null ? '❤️'.repeat(Math.max(0, lives)) : '';
      $('hudLives').classList.toggle('hidden', lives == null);
      $('hudGoal').classList.remove('hidden');
    } else {
      const cd = ex?.gate?.cd;
      const bjLeft = ex?.bj?.voteLeft;
      const t = cd != null ? Math.ceil(cd) : bjLeft != null ? Math.ceil(bjLeft) : '';
      $('hudTimer').textContent = t;
      $('hudTimer').classList.toggle('hidden', t === '');
      $('hudGoal').classList.add('hidden');
      $('hudLives').classList.add('hidden');
    }
    frame(dt, S);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
