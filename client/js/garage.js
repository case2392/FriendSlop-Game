// The Garage: your save's own panel (the menu's Garage button, the Esc card's, or G on a trip). It stops the
// game's keys while it's open, like Settings.
//   KIT      the upgrades your kit cards unlock (shared/garage.js): the three perks you take, the RV part you
//            bring, and the picks your doubles and MINT wins have earned
//   ALBUM    your Road Cards (shared/cards.js), set by set: the ones you keep (and how many), the ones you've
//            seen go by, the ones the Repo Man took, card backs for the rest; the odds; this trip's glovebox
//   LOGBOOK  your records (one board per loan terms), the crews you've finished trips with, the seeds you've
//            practised on, and your lifetime counters
//   SAVE     where the save lives and how it is; Export and Import (a code to copy and paste)
import { fmt$ } from '/shared/loot.js';
import { fmtRoad, fmtClockH, pickable, partOf, DOUBLES_PER_PICK, MINT_HP } from '/shared/profile.js';
import { profile, profileStatus, exportCode, importCode, spend, changeKit } from './profile.js';
import { CARDS, CARD, SETS, odds } from '/shared/cards.js';
import { PERKS, PARTS, PERK_IDS, PART_IDS, SLOTS, ROMAN, levelFrom } from '/shared/garage.js';
import { cardHTML } from './cards.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const row = (k, v, cls = '') => `<div class="rrow ${cls}"><span>${k}</span><b>${v}</b></div>`;
const date = ms => (ms ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '');
const TERMS = { std: 'Standard terms', bad: 'Bad Credit' };
let tab = 'kit', canImport = () => true, glovebox = () => [], kitOpen = () => true, onKit = () => {};
const fresh = new Set();   // cards new to the album this session (NEW marks)
export const markFresh = ids => { for (const id of ids || []) fresh.add(id); };

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
  h += row('Road Cards kept', L.cards) + row('Road Cards lost to the Repo Man', L.cardsLost);
  return h;
}

// what a level does, the level you have lit
function levels(def, lv) {
  return def.lv.map((t, i) => `<li class="${lv > i ? 'have' : ''}"><b>${ROMAN[i + 1]}</b> ${esc(t)}</li>`).join('');
}
function kit() {
  const p = profile(), k = p.kit, part = partOf(p);
  let h = `<p class="hint">One copy of a kit card unlocks its level I, a second level II. ${kitOpen() ? 'Your kit goes with you when the RV leaves camp on day 1.' : 'This trip\'s kit is set: what you change now is for your next trip.'}</p>`;
  h += `<h3>Perks: yours, up to ${SLOTS} (${k.perks.length} taken)</h3><div class="kit-list">`;
  for (const id of PERK_IDS) {
    const lv = levelFrom(p.cards, id), on = k.perks.includes(id), full = !on && k.perks.length >= SLOTS;
    const btn = !lv ? `<span class="kit-need">Keep a ${esc(CARD[id].name)} card</span>`
      : `<button class="btn small ${on ? 'green' : 'gray'}" data-perk="${id}"${full ? ' disabled title="Three perks at most: put one back first"' : ''}>${on ? 'Taken' : 'Take it'}</button>`;
    h += `<div class="kit-item${lv ? '' : ' locked'}${on ? ' on' : ''}"><div class="kit-head"><b>${esc(PERKS[id].name)}${lv ? ` ${ROMAN[lv]}` : ''}</b>${btn}</div><ul>${levels(PERKS[id], lv)}</ul></div>`;
  }
  h += `</div><h3>RV parts: the crew's (you bring one)</h3><p class="hint">The RV leaves camp fitted with the best of each kind anyone aboard brings. ${k.part ? '' : 'Yours is your best one till you choose.'}</p><div class="kit-list">`;
  for (const id of PART_IDS) {
    const lv = levelFrom(p.cards, id), on = part === id;
    const btn = !lv ? `<span class="kit-need">Keep a ${esc(CARD[id].name)} card</span>`
      : `<button class="btn small ${on ? 'green' : 'gray'}" data-part="${id}">${on ? 'Bringing it' : 'Bring it'}</button>`;
    h += `<div class="kit-item${lv ? '' : ' locked'}${on ? ' on' : ''}"><div class="kit-head"><b>${esc(PARTS[id].name)}${lv ? ` ${ROMAN[lv]}` : ''}</b>${btn}</div><ul>${levels(PARTS[id], lv)}</ul></div>`;
  }
  h += '</div><h3>Picks</h3>';
  h += `<p class="hint">A copy past what's worth keeping (a kit card's third, any other card's second) is a double: every ${DOUBLES_PER_PICK} doubles make a pick, and so does a MINT win (the RV paid off at ${MINT_HP}% or better). A pick is a copy of any card you're missing, never a rare. You have ${p.picks} pick${p.picks === 1 ? '' : 's'}, and ${p.doubles} of ${DOUBLES_PER_PICK} doubles toward the next.</p>`;
  if (p.picks > 0) {
    // (the kit cards first: a pick is most often a level)
    const ids = pickable(p).sort((a, b) => (CARD[a].kind === 'kit' ? 0 : 1) - (CARD[b].kind === 'kit' ? 0 : 1) || CARD[a].no - CARD[b].no);
    h += `<div class="album-cards picks">${ids.map(id => `<div class="pick">${cardHTML(id, { small: true, n: p.cards[id] || 0, state: p.cards[id] ? 'owned' : p.seen.includes(id) ? 'seen' : 'unseen' })}<button class="btn small pink" data-pick="${id}">Pick ${CARD[id].kind === 'kit' ? `(${ROMAN[(p.cards[id] || 0) + 1]})` : ''}</button></div>`).join('')}</div>`;
  }
  return h;
}

function album() {
  const p = profile(), n = CARDS.filter(c => p.cards[c.id]).length, copies = Object.values(p.cards).reduce((a, x) => a + x, 0);
  const o = odds('std'), pc = x => Math.round(x * 100);
  let h = `<p class="album-odds">${n} of 30 cards kept (${copies} copies). Tins at the dangerous places, and in the safes and suitcases Ed pries open: set a tin down in the RV and it's in the glovebox; pay the RV off on day 5 and everyone aboard keeps a copy.</p>`;
  const gb = glovebox().flatMap(g => g.cards);
  if (gb.length) h += `<h3>In the glovebox this trip</h3><div class="album-cards">${gb.map(id => cardHTML(id, { small: true, fresh: !p.cards[id] && !p.seen.includes(id) })).join('')}</div>`;
  for (const set of SETS) {
    const list = CARDS.filter(c => c.set === set.n);
    h += `<div class="album-set"><h3>${set.n}. ${esc(set.name)}</h3><div class="album-cards">`;
    for (const c of list) {
      const kept = p.cards[c.id] || 0, lost = p.lost[c.id];
      const state = kept ? 'owned' : lost ? 'lost' : p.seen.includes(c.id) ? 'seen' : 'unseen';
      h += cardHTML(c.id, { n: kept, state, fresh: fresh.has(c.id), small: true, note: lost && !kept ? `Lost to the Repo Man, day ${lost}` : '' });
    }
    h += '</div></div>';
  }
  h += `<p class="album-odds">A card is from the day's road 85% of the time, an earlier road's 15%. On Standard terms: kit ${pc(o.kit)}%, common ${pc(o.common)}%, uncommon ${pc(o.uncommon)}%. The rare cards come only on Bad Credit. A safe holds a card half the time, a suitcase a quarter.</p>`;
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
  $('garageBody').innerHTML = tab === 'save' ? saveTab() : tab === 'album' ? album() : tab === 'kit' ? kit() : logbook();
  if (tab === 'kit') {
    const p = profile(), k = p.kit;
    const changed = ok => { if (ok) onKit(); render(); };
    for (const b of document.querySelectorAll('#garageBody [data-perk]')) b.onclick = () => {
      const id = b.dataset.perk;
      changed(changeKit({ ...k, perks: k.perks.includes(id) ? k.perks.filter(x => x !== id) : [...k.perks, id] }));
    };
    for (const b of document.querySelectorAll('#garageBody [data-part]')) b.onclick = () => changed(changeKit({ ...k, part: b.dataset.part }));
    for (const b of document.querySelectorAll('#garageBody [data-pick]')) b.onclick = () => { markFresh([b.dataset.pick]); changed(spend(b.dataset.pick)); };
    return;
  }
  if (tab !== 'save') return;
  $('gxExport').onclick = () => { $('gxOut').value = exportCode(); $('gxOut').select(); };
  $('gxCopy').onclick = async () => {
    if (!$('gxOut').value) $('gxOut').value = exportCode();
    $('gxOut').select();
    const done = await (navigator.clipboard?.writeText($('gxOut').value).then(() => true, () => false) ?? false);
    if (!done) document.execCommand?.('copy');
  };
  if ($('gxImport')) $('gxImport').onclick = async () => {
    const r = await importCode($('gxIn').value);
    if (!r.ok) { $('gxMsg').textContent = r.msg; return; }
    tab = 'log'; render();
  };
}

// opts.canImport: () => true while a save may change (on the menu); opts.glovebox: () => this trip's glovebox
// opts.kitOpen: () => whether the trip takes a new kit now; opts.onKit: the kit changed (main.js tells the server)
export function initGarage(opts = {}) {
  if (opts.canImport) canImport = opts.canImport;
  if (opts.glovebox) glovebox = opts.glovebox;
  if (opts.kitOpen) kitOpen = opts.kitOpen;
  if (opts.onKit) onKit = opts.onKit;
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
  return records(trip, res) + cardLines(trip, res);
}
// the trip's cards on the game-over: into the album, or TAKEN
function cardLines(trip, res) {
  if (res.cards?.length) {
    markFresh(res.fresh);
    const uniq = [...new Set(res.cards)];
    const ups = (res.unlocked || []).filter((u, i, a) => !a.some((v, j) => j > i && v.id === u.id));   // (the highest each)
    return `<div class="rrow good"><span>Into your album</span><b>${res.cards.length} card${res.cards.length > 1 ? 's' : ''}${res.fresh.length ? ` (${res.fresh.length} new)` : ''}</b></div>`
      + `<div class="over-cards">${uniq.slice(0, 12).map(id => cardHTML(id, { small: true, fresh: res.fresh.includes(id) })).join('')}</div>`
      + (ups.length ? row('Unlocked in the Garage', ups.map(u => `${esc((PERKS[u.id] || PARTS[u.id]).name)} ${ROMAN[u.lv]}`).join(', '), 'good') : '')
      + (res.picks ? row(res.mint ? `MINT: the RV paid off at ${trip.rvEnd}%` : 'Doubles', `+${res.picks} pick${res.picks > 1 ? 's' : ''} (spend ${res.picks > 1 ? 'them' : 'it'} in the Garage's Kit tab)`, 'good') : '');
  }
  if (res.picks) return row(`MINT: the RV paid off at ${trip.rvEnd}%`, `+${res.picks} pick (spend it in the Garage's Kit tab)`, 'good');
  if (res.lost?.length) {
    const uniq = [...new Set(res.lost)];
    return `<div class="rrow bad"><span>The glovebox went with the Repo Man</span><b>${res.lost.length} card${res.lost.length > 1 ? 's' : ''}${res.lostNew.length ? `, ${res.lostNew.length} you've never had` : ''}</b></div>`
      + `<div class="over-cards"><div class="taken">${uniq.slice(0, 6).map(id => cardHTML(id, { small: true })).join('')}</div></div>`;
  }
  return '';
}
function records(trip, res) {
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
