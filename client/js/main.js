import * as C from '/shared/constants.js';
import * as net from './net.js';
import { initAudio, sfx } from './sfx.js';
import { initRender, frame, applySnapshot, resetArena, confetti, emoteAt, getCamYaw, turnCam } from './render.js';

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

function sendChat() {
  const v = $('chatInput').value.trim();
  if (!v) return;
  net.send({ t: 'chat', msg: v });
  $('chatInput').value = '';
  $('chatInput').blur(); // hands back on the wheel
}
$('chatInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendChat();
  e.stopPropagation();
});

function ruleStrip() {
  const m = S.meta;
  if (!m) return '';
  const info = C.MINIGAME_INFO[m.minigame] || {};
  if (S.phase === 'play') {
    return `<b>${info.icon || ''} ${info.name || ''}</b> — ${info.desc || ''}`;
  }
  if (m.hubMode === 'lobby') {
    return m.players.length < 2
      ? `Welcome to <b>THE DEN</b>. You need at least 2 blobs — send the code <b>${S.code}</b> to the boys${m.hostId === S.selfId ? ' or hit <b>+ BOT</b>' : ''}.`
      : `<b>${info.icon || ''} CHAMBER 1: ${info.name || ''}</b> — walk the squad into the glowing gate to descend.`;
  }
  if (m.hubMode === 'gate') {
    return `<b>${info.icon || ''} CHAMBER ${m.chamber + 1}: ${info.name || ''}</b>${m.attempts > 0 ? ` (attempt ${m.attempts + 1})` : ''} — walk into the gate when the boys are ready.`;
  }
  if (m.hubMode === 'blackjack') {
    return `<b>🎩 THE PIT BOSS DEALS.</b> Walk onto a floor zone to vote — <b>HIT 👊</b> left, <b>STAND ✋</b> right. Majority of bodies rules. Ties hit.`;
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
  else if (k === 'enter' && S.phase !== 'menu') $('chatInput').focus();
  else if (/^[1-6]$/.test(k) && S.phase !== 'menu') net.send({ t: 'emote', e: C.EMOTES[Number(k) - 1] });
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (KEYMAP[k] && keys[KEYMAP[k]]) { keys[KEYMAP[k]] = false; pushInput(); }
});

// ---- net handlers ------------------------------------------------------------------

net.on('welcome', m => {
  S.selfId = m.id;
  S.code = m.code;
  $('menuError').textContent = '';
  window.__slop = S; // debug/test handle
  setTimeout(() => toast('🖱️ click the world to look around · WASD walk · SPACE dash', 5200), 800);
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

net.on('chat', m => {
  const log = $('chatLog');
  const div = document.createElement('div');
  const nm = document.createElement('span');
  nm.className = 'cname';
  const p = S.meta?.players.find(q => q.id === m.id);
  nm.style.color = p?.color || '#fff';
  nm.textContent = m.name + ': ';
  div.appendChild(nm);
  div.appendChild(document.createTextNode(m.msg));
  log.appendChild(div);
  while (log.children.length > 40) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
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
