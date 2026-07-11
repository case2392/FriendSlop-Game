import * as C from '/shared/constants.js';
import * as net from './net.js';
import { initAudio, sfx } from './sfx.js';
import { initRender, frame, applySnapshot, resetArena, confetti, emoteAt, blobs } from './render.js';

const $ = id => document.getElementById(id);

const S = {
  selfId: null,
  code: null,
  meta: null,
  snap: null,
  minigame: null,
  phase: 'menu',
  betTarget: null,
  lastCountdown: null,
  podium: null,
};

// ---- screens ----------------------------------------------------------------

function showScreen(name) {
  for (const s of ['menu', 'lobby', 'game']) $(s).classList.toggle('hidden', s !== name);
}

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

// ---- menu ---------------------------------------------------------------------

const savedName = localStorage.getItem('slopName') || '';
$('nameInput').value = savedName;

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

// ---- lobby --------------------------------------------------------------------

$('roomCode').onclick = () => {
  navigator.clipboard?.writeText(S.code || '');
  toast('Code copied. Send it to the boys. 📋');
};
$('addBotBtn').onclick = () => { sfx.click(); net.send({ t: 'addbot' }); };
$('kickBotBtn').onclick = () => { sfx.click(); net.send({ t: 'kickbot' }); };
$('startBtn').onclick = () => { sfx.click(); net.send({ t: 'start' }); };

function sendChat() {
  const v = $('chatInput').value.trim();
  if (!v) return;
  net.send({ t: 'chat', msg: v });
  $('chatInput').value = '';
}
$('chatSend').onclick = sendChat;
$('chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); e.stopPropagation(); });

function renderLobby() {
  const m = S.meta;
  $('roomCode').textContent = S.code || '----';
  const isHost = m.hostId === S.selfId;
  $('addBotBtn').classList.toggle('hidden', !isHost);
  $('kickBotBtn').classList.toggle('hidden', !isHost);
  $('startBtn').classList.toggle('hidden', !isHost);
  $('lobbyHint').textContent = isHost
    ? (m.players.length < 2 ? 'You need at least 2 blobs. Add a bot or wait for friends.' : 'Ready when you are, host.')
    : 'Waiting for the host to start…';

  const wrap = $('lobbyPlayers');
  wrap.innerHTML = '';
  for (const p of m.players) {
    const div = document.createElement('div');
    div.className = 'lobby-player' + (p.id === m.hostId ? ' host' : '');
    const dot = document.createElement('div');
    dot.className = 'blob-dot';
    dot.style.background = p.color;
    const nm = document.createElement('div');
    nm.className = 'pname';
    nm.textContent = p.name;
    const tag = document.createElement('div');
    tag.className = 'ptag';
    tag.textContent = p.id === m.hostId ? '👑 host' : (p.isBot ? 'bot' : (p.id === S.selfId ? 'you' : 'friend'));
    div.append(dot, nm, tag);
    wrap.appendChild(div);
  }
}

// ---- betting ------------------------------------------------------------------

function renderBetting() {
  const m = S.meta;
  const info = C.MINIGAME_INFO[m.minigame] || {};
  $('betGameIcon').textContent = info.icon || '❓';
  $('betGameName').textContent = `ROUND ${m.round}/${m.rounds}: ${info.name || ''}`;
  $('betGameDesc').textContent = info.desc || '';
  $('betJackpot').textContent = m.jackpot > 0 ? `JACKPOT: ${m.jackpot} 🪙` : '';

  const me = m.players.find(p => p.id === S.selfId);
  const wrap = $('betTargets');
  wrap.innerHTML = '';
  for (const p of m.players) {
    if (!p.connected) continue;
    const div = document.createElement('div');
    div.className = 'bet-target' + (S.betTarget === p.id ? ' selected' : '');
    const dot = document.createElement('div');
    dot.className = 'blob-dot';
    dot.style.background = p.color;
    const nm = document.createElement('div');
    nm.className = 'bname';
    nm.textContent = p.id === S.selfId ? `${p.name} (you)` : p.name;
    const coins = document.createElement('div');
    coins.className = 'bcoins';
    coins.textContent = `${p.coins} 🪙`;
    const backers = document.createElement('div');
    backers.className = 'backers';
    const bs = m.players.filter(q => q.bet && q.bet.target === p.id);
    backers.textContent = bs.length ? bs.map(q => `${q.name.split(' ')[0]}:${q.bet.amount}`).join(' ') : '';
    div.append(dot, nm, coins, backers);
    div.onclick = () => {
      S.betTarget = p.id;
      sfx.click();
      renderBetting();
    };
    wrap.appendChild(div);
  }
  const myBet = me?.bet;
  $('betCurrent').textContent = myBet
    ? `${myBet.amount} 🪙 on ${m.players.find(p => p.id === myBet.target)?.name || '?'}`
    : 'no bet yet, coward';
}

for (const btn of document.querySelectorAll('.bet-amounts .chip')) {
  btn.onclick = () => {
    const me = S.meta?.players.find(p => p.id === S.selfId);
    if (!me) return;
    if (!S.betTarget) { toast('Pick a blob to bet on first! 👆'); return; }
    const amount = Math.max(1, Math.floor(me.coins * Number(btn.dataset.frac)));
    net.send({ t: 'bet', target: S.betTarget, amount });
    sfx.bet();
  };
}

// ---- results / podium -----------------------------------------------------------

function resultsRow(p, place, delta, coins, winner) {
  const row = document.createElement('div');
  row.className = 'results-row' + (winner ? ' winner' : '');
  const pl = document.createElement('div');
  pl.className = 'place';
  pl.textContent = ['🥇', '🥈', '🥉'][place] || `${place + 1}.`;
  const dot = document.createElement('div');
  dot.className = 'blob-dot';
  dot.style.background = p.color;
  const nm = document.createElement('div');
  nm.className = 'rname';
  nm.textContent = p.name;
  const d = document.createElement('div');
  d.className = 'delta' + (delta < 0 ? ' neg' : '');
  d.textContent = delta ? (delta > 0 ? `+${delta}` : `${delta}`) : '';
  const c = document.createElement('div');
  c.className = 'rcoins';
  c.textContent = `${coins} 🪙`;
  row.append(pl, dot, nm, d, c);
  return row;
}

function renderResults() {
  const m = S.meta;
  const r = m.lastResults;
  if (!r) return;
  const info = C.MINIGAME_INFO[r.minigame] || {};
  $('resultsTitle').textContent = `${info.icon || ''} ${info.name || ''} — RESULTS`;
  const list = $('resultsList');
  list.innerHTML = '';

  r.rankings.forEach((id, i) => {
    const p = m.players.find(q => q.id === id);
    if (!p) return;
    const pays = (r.payouts[id] || []).reduce((s, x) => s + x.amt, 0);
    const betLoss = r.bets.find(b => b.id === id && b.target !== r.winnerId)?.amount || 0;
    list.appendChild(resultsRow(p, i, pays - betLoss, p.coins, id === r.winnerId));
  });

  const potEl = $('resultsPot');
  if (r.pot > 0 && r.potWon) {
    const winners = r.bets.filter(b => b.target === r.winnerId)
      .map(b => m.players.find(p => p.id === b.id)?.name).filter(Boolean);
    potEl.textContent = `💰 POT OF ${r.pot} 🪙 WON BY: ${winners.join(', ')}`;
  } else if (r.pot > 0) {
    potEl.textContent = `😱 NOBODY called it — ${r.pot} 🪙 rolls into the JACKPOT!`;
  } else {
    potEl.textContent = 'No bets. Cowards, all of you.';
  }

  if (r.winnerId === S.selfId) { confetti(); sfx.win(); }
  else if (r.rankings[r.rankings.length - 1] === S.selfId) sfx.lose();
}

function renderPodium(standings) {
  const list = $('podiumList');
  list.innerHTML = '';
  standings.forEach((p, i) => list.appendChild(resultsRow(p, i, 0, p.coins, i === 0)));
  if (standings[0]?.id === S.selfId) { confetti(); sfx.win(); }
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

const keys = { up: false, down: false, left: false, right: false };
const KEYMAP = {
  w: 'up', arrowup: 'up',
  s: 'down', arrowdown: 'down',
  a: 'left', arrowleft: 'left',
  d: 'right', arrowright: 'right',
};

function pushInput(dash = false) {
  net.send({ t: 'input', keys: { ...keys, dash } });
}

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (KEYMAP[k] && !keys[KEYMAP[k]]) { keys[KEYMAP[k]] = true; pushInput(); }
  else if (k === ' ' || k === 'shift') { e.preventDefault(); pushInput(true); }
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
  log.scrollTop = log.scrollHeight;
});

net.on('emote', m => emoteAt(m.id, m.e));

net.on('podium', m => { S.podium = m.standings; });

net.on('state', m => {
  S.snap = m;
  applySnapshot(m, S.meta, S.selfId);
  if (m.countdown !== S.lastCountdown) {
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
  const prevPhase = S.meta?.phase;
  S.meta = m;
  S.minigame = m.minigame;
  S.phase = m.phase;

  if (m.phase === 'lobby') {
    showScreen('lobby');
    renderLobby();
    return;
  }

  showScreen('game');
  $('hud').classList.remove('hidden');
  const overlays = { betOverlay: m.phase === 'betting', resultsOverlay: m.phase === 'results', podiumOverlay: m.phase === 'podium' };
  for (const [id, show] of Object.entries(overlays)) $(id).classList.toggle('hidden', !show);

  if (m.phase === 'betting') {
    if (prevPhase !== 'betting') { S.betTarget = null; S.snap = null; resetArena(); }
    renderBetting();
  } else if (m.phase === 'play' && prevPhase !== 'play') {
    S.lastCountdown = null;
  } else if (m.phase === 'results') {
    renderResults();
  } else if (m.phase === 'podium' && S.podium) {
    renderPodium(S.podium);
  }

  $('hudRound').textContent = m.round ? `ROUND ${m.round}/${m.rounds}` : '';
  $('hudJackpot').textContent = m.jackpot > 0 ? `JACKPOT ${m.jackpot} 🪙` : '';
  $('hudJackpot').classList.toggle('hidden', m.jackpot <= 0);
});

// ---- render loop ---------------------------------------------------------------------

initRender($('canvas'));
let lastT = performance.now();
function loop(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;

  if (S.phase === 'betting' || S.phase === 'results') {
    const left = Math.max(0, Math.ceil((S.meta.phaseEnds - Date.now()) / 1000));
    $('betTimer').textContent = `bets lock in ${left}…`;
    $('resultsTimer').textContent = `next round in ${left}…`;
    $('hudTimer').textContent = left;
  } else if (S.phase === 'play') {
    $('hudTimer').textContent = S.snap?.extra?.tl ?? (S.minigame === 'tater' ? '🥔' : '');
  }

  if (S.phase !== 'menu' && S.phase !== 'lobby') frame(dt, S);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
