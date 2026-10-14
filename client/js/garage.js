// The Garage: your save's own panel (the menu's Garage button, the Esc card's, or G on a trip). It stops the
// game's keys while it's open, like Settings.
//   LOGBOOK  your records (one board per loan terms), the crews you've finished trips with, the seeds you've
//            practised on, and your lifetime counters
//   SAVE     where the save lives and how it is; Export and Import (a code to copy and paste)
import { fmt$ } from '/shared/loot.js';
import { fmtRoad, fmtClockH } from '/shared/profile.js';
import { profile, profileStatus, exportCode, importCode } from './profile.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const row = (k, v, cls = '') => `<div class="rrow ${cls}"><span>${k}</span><b>${v}</b></div>`;
const date = ms => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const TERMS = { std: 'Standard terms', bad: 'Bad Credit' };
let tab = 'log', canImport = () => true;

// a board: the fastest payoff, the best time of day each day was paid, the biggest haul, the cleanest
// delivery. Empty: what it takes to set one
function board(b, key) {
  const any = b.fast || b.haul || b.clean || b.splits.some(Boolean);
  if (!any) return key === 'std' ? '<p class="hint">No records yet. Pay off an RV from day 1 to the end and your time goes here; pay days 1 to 4 and your haul does.</p>' : '';
  let h = '';
  h += row('Fastest payoff', b.fast ? `${fmtRoad(b.fast.h)}${b.fast.crew.length ? ` <small>(${b.fast.crew.map(esc).join(', ')})</small>` : ''} <small>${date(b.fast.at)}</small>` : '<small>not yet</small>');
  h += row('Biggest haul', b.haul ? `${fmt$(b.haul.sold)} pawned${b.haul.won && b.haul.surplus != null ? ` <small>(${fmt$(b.haul.surplus)} left${b.haul.casino ? `; the casino ${b.haul.casino > 0 ? '+' : ''}${fmt$(b.haul.casino)}` : ''})</small>` : ''}` : '<small>not yet</small>');
  h += row('Cleanest delivery', b.clean ? `RV ${b.clean.hp}%` : '<small>not yet</small>');
  h += row('Best payment times', b.splits.map((s, d) => `<span class="split">D${d + 1} ${s ? fmtClockH(s.h) : '—'}</span>`).join(' '));
  return h;
}

function logbook() {
  const p = profile(), L = p.life;
  let h = '';
  for (const k of ['std', 'bad']) {
    const inner = board(p.best[k], k);
    if (inner) h += `<h3>Records · ${TERMS[k]}</h3>${inner}`;
  }
  h += '<p class="hint">Road time: the clock at each day\'s payment less 6:00, added up over the five days, in real time (a game hour is 45 s). A record needs you aboard from day 1\'s departure to the end.</p>';
  if (p.crews.length) {
    h += '<h3>Crews</h3>';
    for (const c of p.crews) h += row(c.names.length ? c.names.map(esc).join(', ') : 'a crew', `${c.wins}/${c.trips} paid off${c.fast != null ? ` · ${fmtRoad(c.fast)}` : ''}${c.haul != null ? ` · ${fmt$(c.haul)}` : ''}`);
  }
  if (p.seeds.length) {
    h += '<h3>Practice seeds</h3><p class="hint">A trip from a typed seed counts only here.</p>';
    for (const s of p.seeds) h += row(`Seed ${s.seed}`, `${s.wins}/${s.trips} paid off${s.fast != null ? ` · ${fmtRoad(s.fast)}` : ''}${s.haul != null ? ` · ${fmt$(s.haul)}` : ''}`);
  }
  h += '<h3>Lifetime</h3>';
  h += row('Trips', L.trips) + row('RVs paid off', L.wins) + row('Days paid', L.days) + row('Pawned', fmt$(L.pawned));
  h += row('Knocked out', L.kos) + row('Friends picked up', L.revives) + row('RV damage as the driver', `${L.rvDmg}%`) + row('Spent at Gus\'s', fmt$(L.repairs));
  return h;
}

function saveTab() {
  const st = profileStatus(), p = profile();
  const where = st.desktop
    ? 'On this PC, in the game\'s own folder (save/profile.json). Steam Cloud keeps a copy once the game is on Steam.'
    : `In this browser, for ${esc(st.where)}. Another browser, or this game at another address, has a save of its own: Export here and Import there to move it.`;
  const how = { ok: 'Saved.', fresh: 'A new save, started now.', bak: 'The save couldn\'t be read: restored from the backup.',
    reset: 'The save and its backup couldn\'t be read: started over (the bad one is kept aside).',
    newer: 'Read-only: this save is from a newer version of the game. Nothing will be written to it.',
    nostore: 'This window can\'t keep a save: nothing will be kept.' }[st.status] || st.status;
  let h = `<h3>Where it lives</h3><p class="note">${where}</p>`;
  h += `<h3>State</h3><p class="note${st.status === 'ok' || st.status === 'fresh' ? '' : ' bad'}">${how}${st.error ? ` (last write: ${esc(st.error)})` : ''}</p>`;
  h += row('Last saved', p.saved ? new Date(p.saved).toLocaleString() : '—') + row('Trips in it', p.life.trips);
  h += '<h3>Export</h3><p class="note">The whole save as one line of text, to keep or to Import somewhere else.</p>';
  h += '<div class="garage-io"><textarea id="gxOut" readonly rows="3" placeholder="Press Export"></textarea><div class="row"><button id="gxExport" class="btn small gray">Export</button><button id="gxCopy" class="btn small gray">Copy</button></div></div>';
  h += '<h3>Import</h3>';
  if (canImport()) h += '<p class="note">Paste a code from Export. It replaces this save (the old one stays as the backup).</p><div class="garage-io"><textarea id="gxIn" rows="3" placeholder="NMD1..."></textarea><div class="row"><button id="gxImport" class="btn small pink">Import</button></div><p id="gxMsg" class="note"></p></div>';
  else h += '<p class="note">Back on the menu: a save can\'t change in the middle of a trip.</p>';
  return h;
}

function render() {
  for (const b of document.querySelectorAll('#garage .gtab')) b.classList.toggle('on', b.dataset.tab === tab);
  $('garageBody').innerHTML = tab === 'save' ? saveTab() : logbook();
  if (tab !== 'save') return;
  $('gxExport').onclick = () => { $('gxOut').value = exportCode(); $('gxOut').select(); };
  $('gxCopy').onclick = async () => {
    if (!$('gxOut').value) $('gxOut').value = exportCode();
    $('gxOut').select();
    const done = await (navigator.clipboard?.writeText($('gxOut').value).then(() => true, () => false) ?? false);
    if (!done) document.execCommand?.('copy');
  };
  if ($('gxImport')) $('gxImport').onclick = () => {
    const r = importCode($('gxIn').value);
    if (!r.ok) { $('gxMsg').textContent = r.msg; return; }
    tab = 'log'; render();
  };
}

// opts.canImport: () => true while a save may change (on the menu)
export function initGarage(opts = {}) {
  if (opts.canImport) canImport = opts.canImport;
  for (const b of document.querySelectorAll('#garage .gtab')) b.onclick = () => { tab = b.dataset.tab; render(); };
}
// (main.js shows the panel: openPanel('garage') renders it first)
export function renderGarage(which = null) {
  if (which) tab = which;
  render();
}
export const garageOpen = () => !$('garage').classList.contains('hidden');
// the game-over's lines for what this trip set ('NEW RECORD'), from creditTrip's answer
export function recordLines(trip, res) {
  if (!trip || !res?.counted) return '';
  const p = profile(), b = p.best[trip.tier === 'bad' ? 'bad' : 'std'], NEW = ' <span class="newrec">NEW RECORD</span>';
  const has = k => res.newRecords.includes(k);
  let h = '';
  if (trip.time != null) h += row('Road time', `${fmtRoad(trip.time)}${has('fast') ? NEW : b.fast ? ` <small>(best ${fmtRoad(b.fast.h)})</small>` : ''}`);
  if (has('haul')) h += row('Your biggest haul', `${fmt$(trip.sold)}${NEW}`);
  if (has('clean')) h += row('Cleanest delivery', `RV ${trip.rvEnd}%${NEW}`);
  const splits = res.newRecords.filter(k => k.startsWith('split')).map(k => +k.slice(5));
  if (splits.length) h += row('Best payment times', `${splits.map(d => `D${d} ${fmtClockH(trip.splits[d - 1])}`).join(', ')}${NEW}`);
  if (has('crew')) h += row('With this crew', `a new best${NEW}`);
  return h;
}
