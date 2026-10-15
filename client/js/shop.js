// A town shop's catalogue (shared/shop.js, shared/looks.js): E at the vendor opens it (the server sends
// { t: 'shop', v }), it lists what they sell, what it does and costs, and what the crew already has; Buy (and
// Wear, and Paint) ask the server, which checks where you stand, the hour and the bank (server/room.js) and
// answers with a toast. It stays drawn from the game's state while it's open, so the bank, what's fitted and
// what the crew owns are always the server's.

import { VENDORS, goodsOf } from '/shared/shop.js';
import { HAT_LOOKS, KIT_LOOKS, DYE_LOOKS, RV_PAINTS } from '/shared/looks.js';
import { fmt$ } from '/shared/loot.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let ctx = null, vendor = null, drawn = '';

// c: { open(id), close(id), send(msg), state() -> { g, meta, self }, click() }
export function initShop(c) {
  ctx = c;
  $('shopClose').onclick = () => closeShop();
  $('shopBody').addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    ctx.click?.();
    if (b.dataset.buy) ctx.send({ t: 'shopBuy', v: vendor, id: b.dataset.buy });
    else if (b.dataset.look) ctx.send({ t: 'lookBuy', id: b.dataset.look });
    else if (b.dataset.wear) ctx.send({ t: 'wear', [b.dataset.wear]: b.dataset.val === '' ? null : b.dataset.wear === 'kit' ? Number(b.dataset.val) : b.dataset.val });
    else if (b.dataset.paint !== undefined) ctx.send({ t: 'paint', id: b.dataset.paint || null });
  });
}
export const shopOpen = () => !$('shop').classList.contains('hidden');
export function openShop(v) {
  if (!VENDORS[v]) return;
  vendor = v; drawn = '';
  renderShop();
  ctx.open('shop');
}
export function closeShop() { if (shopOpen()) ctx.close('shop'); }

const swatch = col => `<i class="shop-swatch" style="background:${col}"></i>`;
const item = (name, btn, line = '', on = false, sw = '') => `<div class="kit-item${on ? ' on' : ''}"><div class="kit-head"><b>${sw}${esc(name)}</b>${btn}</div>${line ? `<ul><li class="have">${esc(line)}</li></ul>` : ''}</div>`;

// (cheap to call every frame: it redraws only when the bank, the hour, what's fitted or owned or worn changes)
export function renderShop() {
  if (!vendor) return;
  const V = VENDORS[vendor], { g, meta, self } = ctx.state(), trip = meta?.trip || {};
  const owns = new Set(trip.looks || []), me = (meta?.players || []).find(q => q.id === self), look = me?.wear || {};
  const bank = g?.bank ?? 0, night = g?.ph === 'night' && !!g?.paid;
  const key = JSON.stringify([vendor, bank, night, g?.ph === 'over', trip.upg, trip.looks, trip.rv, look]);
  if (key === drawn) return;
  drawn = key;
  $('shopTitle').textContent = V.name;
  let h = `<p class="shop-bank">The crew's bank: <b>${fmt$(bank)}</b></p>`;
  if (V.looks) h += clothes(owns, look, bank);
  else {
    const GOODS = goodsOf(vendor), have = new Set(V.gear ? [] : trip.upg || []);
    // (Gus fits parts at night once the day's paid; the store's hardware is for sale whenever)
    const open = V.gear ? g?.ph !== 'over' : night;
    h += V.gear ? '<p class="hint">Paid from the shared bank, and set down by the rack out front. Ed won\'t buy it back, and what\'s left behind on the road stays there: keep it in the RV.</p>'
      : open ? `<p class="hint">${esc(V.who)} fits it tonight, for the rest of the trip (a new trip starts with a new RV). Paid from the shared bank.</p>`
      : `<p class="hint bad">${esc(V.who)} fits parts at night, once the Repo Man's been paid for the day: pay him first.</p>`;
    h += '<div class="kit-list">';
    for (const id of V.goods) {
      const U = GOODS[id], got = have.has(id), short = bank < U.price;
      const btn = got ? '<span class="shop-got">Fitted</span>'
        : `<button class="btn small ${short ? 'gray' : 'green'}" data-buy="${id}"${!open || short ? ' disabled' : ''}${short ? ' title="The bank is short"' : ''}>Buy ${fmt$(U.price)}</button>`;
      h += item(U.name, btn, U.line, got);
    }
    h += '</div>';
    if (vendor === 'gus') h += paint(owns, trip.rv ?? null, bank, night);
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
        : `<button class="btn small ${short ? 'gray' : 'pink'}" data-look="${lid}"${short ? ' disabled title="The bank is short"' : ''}>Buy ${fmt$(L.price)}</button>`;
      h += item(L.name, btn, '', on, sw ? swatch(L.col) : '');
    }
    h += '</div>';
  };
  section('Hats', 'hat', HAT_LOOKS);
  section('Outfits', 'kit', KIT_LOOKS);
  section('Tabard dye', 'dye', DYE_LOOKS, true);
  return h;
}
// Gus's paint: the RV's colour (the crew's paints, or a new one: at night once paid, like his parts)
function paint(owns, cur, bank, night) {
  let h = `<h3>Paint</h3><p class="hint${night ? '' : ' bad'}">${night ? 'A paint job is the crew\'s for good, and Gus puts any of them on tonight.' : 'Gus paints at night too, once the Repo Man\'s been paid.'}</p><div class="kit-list">`;
  h += item('Stock Cream', cur == null ? '<span class="shop-got">On it</span>' : `<button class="btn small gray" data-paint=""${night ? '' : ' disabled'}>Paint it</button>`, '', cur == null, swatch('#efe3c4'));
  for (const [id, P] of Object.entries(RV_PAINTS)) {
    const lid = `rv:${id}`, on = cur === id, short = bank < P.price;
    const btn = owns.has(lid) ? (on ? '<span class="shop-got">On it</span>' : `<button class="btn small green" data-paint="${id}"${night ? '' : ' disabled'}>Paint it</button>`)
      : `<button class="btn small ${short ? 'gray' : 'pink'}" data-look="${lid}"${!night || short ? ' disabled' : ''}>Buy ${fmt$(P.price)}</button>`;
    h += item(P.name, btn, '', on, swatch(P.col));
  }
  return h + '</div>';
}
