// A town shop's catalogue (shared/shop.js): E at the vendor opens it (the server sends { t: 'shop', v }), it
// lists what they sell, what it does and costs, and what the crew already has; Buy asks the server, which
// checks where you stand, the hour and the bank (server/room.js shopBuy) and answers with a toast. It stays
// drawn from the game's state while it's open, so the bank and what's fitted are always the server's.

import { UPGRADES, VENDORS } from '/shared/shop.js';
import { fmt$ } from '/shared/loot.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let ctx = null, vendor = null, drawn = '';

// c: { open(id), close(id), send(msg), state() -> { g, meta }, click() }
export function initShop(c) {
  ctx = c;
  $('shopClose').onclick = () => closeShop();
  $('shopBody').addEventListener('click', e => {
    const b = e.target.closest('[data-buy]');
    if (!b || b.disabled) return;
    ctx.click?.();
    ctx.send({ t: 'shopBuy', v: vendor, id: b.dataset.buy });
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

// (cheap to call every frame: it redraws only when the bank, the hour or what's fitted has changed)
export function renderShop() {
  if (!vendor) return;
  const V = VENDORS[vendor], { g, meta } = ctx.state(), have = new Set(meta?.trip?.upg || []);
  const bank = g?.bank ?? 0, open = g?.ph === 'night' && !!g?.paid;
  const key = JSON.stringify([vendor, bank, open, [...have]]);
  if (key === drawn) return;
  drawn = key;
  $('shopTitle').textContent = V.name;
  let h = `<p class="shop-bank">The crew's bank: <b>${fmt$(bank)}</b></p>`;
  h += open ? `<p class="hint">${esc(V.who)} fits it tonight, for the rest of the trip (a new trip starts with a new RV). Paid from the shared bank.</p>`
    : `<p class="hint bad">${esc(V.who)} fits parts at night, once the Repo Man's been paid for the day: pay him first.</p>`;
  h += '<div class="kit-list">';
  for (const id of V.goods) {
    const U = UPGRADES[id], got = have.has(id), short = bank < U.price;
    const btn = got ? '<span class="shop-got">Fitted</span>'
      : `<button class="btn small ${short ? 'gray' : 'green'}" data-buy="${id}"${!open || short ? ' disabled' : ''}${short ? ' title="The bank is short"' : ''}>Buy ${fmt$(U.price)}</button>`;
    h += `<div class="kit-item${got ? ' on' : ''}"><div class="kit-head"><b>${esc(U.name)}</b>${btn}</div><ul><li class="have">${esc(U.line)}</li></ul></div>`;
  }
  h += '</div>';
  $('shopBody').innerHTML = h;
}
