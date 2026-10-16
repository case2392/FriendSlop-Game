// A town shop's catalogue (shared/shop.js, shared/looks.js): E at the vendor opens it (the server sends
// { t: 'shop', v }), it lists what they sell, what it does and costs, and what the crew already has; Buy (and
// Wear, and Paint) ask the server, which checks where you stand, the hour and the bank (server/room.js) and
// answers with a toast. It stays drawn from the game's state while it's open, so the bank, what's fitted and
// what the crew owns are always the server's.
// Every press says what happened, in the panel (the toasts are drawn behind it: main.js hands them to
// shopNote while it's open). A thing that can't be bought now isn't a dead button: pressed, it says why (the
// bank short, Gus by day, the RV off his lot), the server's own reasons, worked out from the same state.

import { VENDORS, goodsOf } from '/shared/shop.js';
import { HAT_LOOKS, KIT_LOOKS, DYE_LOOKS, RV_PAINTS } from '/shared/looks.js';
import { fmt$, LOOT } from '/shared/loot.js';
import { RVH } from '/shared/constants.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let ctx = null, vendor = null, drawn = '', pressing = false, noteTimer = 0;

// c: { open(id), close(id), send(msg), state() -> { g, meta, self, rv, town }, click() }
export function initShop(c) {
  ctx = c;
  $('shopClose').onclick = () => closeShop();
  // (not redrawn under a press: a button swapped between the mouse going down and up never gets its click)
  $('shopBody').addEventListener('pointerdown', () => { pressing = true; });
  addEventListener('pointerup', () => { pressing = false; });
  addEventListener('pointercancel', () => { pressing = false; });
  $('shopBody').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    ctx.click?.();
    if (b.dataset.why) { shopNote(b.dataset.why, true); return; }
    if (b.dataset.take) { ctx.send({ t: 'use', kind: 'locker', item: Number(b.dataset.take) }); closeShop(); return; }   // (out into your hands)
    if (b.dataset.buy) ctx.send({ t: 'shopBuy', v: vendor, id: b.dataset.buy });
    else if (b.dataset.look) ctx.send({ t: 'lookBuy', id: b.dataset.look });
    else if (b.dataset.wear) ctx.send({ t: 'wear', [b.dataset.wear]: b.dataset.val === '' ? null : b.dataset.wear === 'kit' ? Number(b.dataset.val) : b.dataset.val });
    else if (b.dataset.paint !== undefined) ctx.send({ t: 'paint', id: b.dataset.paint || null });
  });
}
export const shopOpen = () => !$('shop').classList.contains('hidden');
export const shopVendor = () => (shopOpen() ? vendor : null);
// the RV's locker, in the same panel: what's in it (the server's list: main.js S.locker), each to take out
export const LOCKER = '@locker';
export const openLocker = () => openShop(LOCKER);
export function openShop(v) {
  if (!VENDORS[v] && v !== LOCKER) return;
  vendor = v; drawn = '';
  shopNote('');
  renderShop();
  ctx.open('shop');
}
// a line at the top of the panel: what the server said (a toast) or why a button can't buy, for a few seconds
export function shopNote(text, bad = false, secs = 5) {
  const n = $('shopNote');
  clearTimeout(noteTimer);
  n.textContent = text;
  n.classList.toggle('hidden', !text);
  n.classList.toggle('bad', !!bad);
  if (text) noteTimer = setTimeout(() => n.classList.add('hidden'), Math.max(4, secs) * 1000);
}
export function closeShop() { if (shopOpen()) ctx.close('shop'); }

const swatch = col => `<i class="shop-swatch" style="background:${col}"></i>`;
// a buy button: live, or (why: the reason it can't buy now) grey, saying so when pressed
const buyBtn = (attr, price, why, colour = 'green') => why
  ? `<button class="btn small gray" ${attr} data-why="${esc(why)}">${why === SHORT ? `${fmt$(price)} (short)` : `Buy ${fmt$(price)}`}</button>`
  : `<button class="btn small ${colour}" ${attr}>Buy ${fmt$(price)}</button>`;
let SHORT = '';
const item = (name, btn, line = '', on = false, sw = '') => `<div class="kit-item${on ? ' on' : ''}"><div class="kit-head"><b>${sw}${esc(name)}</b>${btn}</div>${line ? `<ul><li class="have">${esc(line)}</li></ul>` : ''}</div>`;

// (cheap to call every frame: it redraws only when the bank, the hour, what's fitted or owned or worn changes)
export function renderShop() {
  if (!vendor) return;
  if (pressing) return;
  if (vendor === LOCKER) return lockerPanel(ctx.state().locker || []);
  const V = VENDORS[vendor], { g, meta, self, rv, town } = ctx.state(), trip = meta?.trip || {};
  const owns = new Set(trip.looks || []), me = (meta?.players || []).find(q => q.id === self), look = me?.wear || {};
  const bank = g?.bank ?? 0, night = g?.ph === 'night' && !!g?.paid;
  // (Gus works on the RV at his lot: within RVH.GUS_R of his bench, as the server has it)
  const gus = town?.gus, off = gus && rv ? Math.round(Math.max(0, Math.hypot(rv.x - gus.x, rv.z - gus.z) - RVH.GUS_R)) : 0;
  const key = JSON.stringify([vendor, bank, night, off > 0, g?.ph === 'over', trip.upg, trip.looks, trip.rv, look]);
  if (key === drawn) return;
  drawn = key;
  SHORT = `The crew's bank has ${fmt$(bank)}: not enough for that.`;
  $('shopTitle').textContent = V.name;
  let h = `<p class="shop-bank">The crew's bank: <b>${fmt$(bank)}</b></p>`;
  // why Gus can't fit or paint it now (null: he can)
  const gusWhy = !night ? 'Gus fits parts and paints at night, once the Repo Man\'s been paid for the day.'
    : off > 0 ? `Gus works on the RV at his lot: bring it round by his bench first (it's ${off} m too far off).` : null;
  if (V.looks) h += clothes(owns, look, bank);
  else {
    const GOODS = goodsOf(vendor), have = new Set(V.gear ? [] : trip.upg || []);
    // (Gus fits parts at night once the day's paid, the RV at his lot; the store's hardware is for sale whenever)
    const closed = V.gear ? (g?.ph === 'over' ? 'The trip is over.' : null) : gusWhy;
    h += V.gear ? '<p class="hint">Paid from the shared bank, and set down by the rack out front. Ed won\'t buy it back, and what\'s left behind on the road stays there: keep it in the RV.</p>'
      : !closed ? `<p class="hint">${esc(V.who)} fits it tonight, for the rest of the trip (a new trip starts with a new RV). Paid from the shared bank.</p>`
      : `<p class="hint bad">${esc(closed)}</p>`;
    h += '<div class="kit-list">';
    for (const id of V.goods) {
      const U = GOODS[id], got = have.has(id);
      const btn = got ? '<span class="shop-got">Fitted</span>' : buyBtn(`data-buy="${id}"`, U.price, closed || (bank < U.price ? SHORT : null));
      h += item(U.name, btn, U.line, got);
    }
    h += '</div>';
    if (vendor === 'gus') h += paint(owns, trip.rv ?? null, bank, gusWhy);
  }
  $('shopBody').innerHTML = h;
}

// the locker: the gear (a line a kind, how many) and the loot (dearest first), each with a button that takes it
// out into your hands (the server's 'use' locker with the item's id)
function lockerPanel(list) {
  const key = JSON.stringify([LOCKER, list]);
  if (key === drawn) return;
  drawn = key;
  $('shopTitle').textContent = 'The RV\'s Locker';
  const gear = new Map(), loot = [];
  for (const [id, type, value] of list) {
    if (LOOT[type]?.tool) { if (!gear.has(type)) gear.set(type, []); gear.get(type).push(id); } else loot.push([id, type, value]);
  }
  loot.sort((a, b) => b[2] - a[2]);
  const worth = loot.reduce((a, e) => a + e[2], 0);
  let h = `<p class="shop-bank">${list.length ? `${list.length} thing${list.length > 1 ? 's' : ''} in it${loot.length ? ` · the loot's worth <b>${fmt$(worth)}</b>` : ''}` : 'It\'s empty'}</p>`;
  h += '<p class="hint">Anything set down in the RV goes in here, safe from knocks. Ed buys the loot in it with the rest of the load at his loading zone; your gear stays in.</p>';
  if (gear.size) {
    h += '<h3>Gear</h3><div class="kit-list">';
    for (const [type, ids] of gear) h += item(`${LOOT[type].name}${ids.length > 1 ? ` ×${ids.length}` : ''}`, `<button class="btn small green" data-take="${ids[0]}">Take ${ids.length > 1 ? 'one' : 'it'} out</button>`);
    h += '</div>';
  }
  if (loot.length) {
    h += '<h3>Loot</h3><div class="kit-list">';
    for (const [id, type, value] of loot) h += item(LOOT[type]?.name || type, `<button class="btn small green" data-take="${id}">Take it out</button>`, fmt$(value));
    h += '</div>';
  }
  $('shopBody').innerHTML = h;
}

// the clothes rail: hats, outfits, dyes. Owned by anyone in the crew: wear it; else buy it (the crew's for
// good). "Issued" is what your seat gave you
function clothes(owns, look, bank) {
  let h = '<p class="hint">Bought once, the crew\'s for good: everyone aboard keeps it in their save, and anyone can wear it. You change here and nowhere else.</p>';
  const section = (title, kind, list, sw) => {
    h += `<h3>${title}</h3><div class="kit-list">`;
    const cur = look[kind] ?? null;
    h += item('Issued', cur == null ? '<span class="shop-got">Wearing</span>' : `<button class="btn small gray" data-wear="${kind}" data-val="">Wear</button>`, kind === 'dye' ? 'Your own colour' : 'What your seat gave you', cur == null);
    for (const [id, L] of Object.entries(list)) {
      const lid = `${kind}:${id}`, on = String(cur) === String(id), short = bank < L.price;
      const btn = owns.has(lid) ? (on ? '<span class="shop-got">Wearing</span>' : `<button class="btn small green" data-wear="${kind}" data-val="${id}">Wear</button>`)
        : buyBtn(`data-look="${lid}"`, L.price, short ? SHORT : null, 'pink');
      h += item(L.name, btn, '', on, sw ? swatch(L.col) : '');
    }
    h += '</div>';
  };
  section('Hats', 'hat', HAT_LOOKS);
  section('Outfits', 'kit', KIT_LOOKS);
  section('Tabard dye', 'dye', DYE_LOOKS, true);
  return h;
}
// Gus's paint: the RV's colour (the crew's paints, or a new one: at night once paid, the RV at his lot, like
// his parts; why: the reason he can't now, or null)
function paint(owns, cur, bank, why) {
  const again = (attr, colour) => why ? `<button class="btn small gray" ${attr} data-why="${esc(why)}">Paint it</button>` : `<button class="btn small ${colour}" ${attr}>Paint it</button>`;
  let h = `<h3>Paint</h3><p class="hint${why ? ' bad' : ''}">${why ? esc(why) : 'A paint job is the crew\'s for good, and Gus puts any of them on tonight.'}</p><div class="kit-list">`;
  h += item('Stock Cream', cur == null ? '<span class="shop-got">On it</span>' : again('data-paint=""', 'gray'), '', cur == null, swatch('#efe3c4'));
  for (const [id, P] of Object.entries(RV_PAINTS)) {
    const lid = `rv:${id}`, on = cur === id;
    const btn = owns.has(lid) ? (on ? '<span class="shop-got">On it</span>' : again(`data-paint="${id}"`, 'green'))
      : buyBtn(`data-look="${lid}"`, P.price, why || (bank < P.price ? SHORT : null), 'pink');
    h += item(P.name, btn, '', on, swatch(P.col));
  }
  return h + '</div>';
}
