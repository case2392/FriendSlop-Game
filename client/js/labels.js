// Text and the 2D interface skin. Owned by the UI art pass (docs/ART.md).
//
//   textCanvas(lines, opts)        a painted signboard face on a <canvas>
//   labelSprite(text, color, px)   a camera-facing text sprite; sprite.userData.set(text, color) updates it.
//                                  px >= 60: a painted icon for 📍 🔊 📻 (else a nameplate)
//                                  42..59:  floating combat text (outlined, no backing)
//                                  40..41:  a player nameplate (thin outline, WoW style)
//                                  34..39:  a small outlined object name (casino buttons)
//                                  <  34:   a small painted wooden placard (status lines)
//                                  known NPC names get a WoW "<Title>" line under the name.
//                                  Every label is capped to a fixed size on screen, so a
//                                  close one never covers a wall.
//   zoneText(title, sub)           the big gold WoW zone text that fades in when a day starts
//   uiText(s)                      strips emoji (the WoW UI has none) and turns emote toasts into "You laugh."
//
// On import this module also (1) waits for the vendored fonts and redraws any
// sprite drawn before they arrived, (2) paints the UI textures in paint/ui.js
// and exposes them to style.css as --tx-* custom properties (the title painting
// in stages, so the menu stays responsive), and (3) keeps emoji out of the prompt.
import * as THREE from '/vendor/three.module.js';
import { canvasTex } from './gfx.js';
import { canvasFor, hashStr, rngFrom } from './paint/index.js';
import { paintVista } from './paint/ui.js';

export const UI_FONT = "'NMD UI', 'Marcellus', 'Friz Quadrata TT', 'Friz Quadrata', 'Palatino Linotype', 'Book Antiqua', Palatino, Georgia, serif";
export const TITLE_FONT = "'Cinzel', 'Trajan Pro', 'Marcellus', 'Palatino Linotype', Georgia, serif";

// ---- fonts ------------------------------------------------------------------------------

let fontsReady = typeof document === 'undefined' || !document.fonts;
const redrawWhenFonts = new Set();
if (!fontsReady) {
  Promise.all([['40px "NMD UI"', 'Aa$0123456789'], ['40px Marcellus', 'Aa'], ['700 40px Cinzel', 'Aa'], ['900 40px Cinzel', 'Aa']].map(([f, t]) => document.fonts.load(f, t).catch(() => null)))
    .then(() => { fontsReady = true; for (const fn of redrawWhenFonts) fn(); redrawWhenFonts.clear(); });
}

// ---- emoji → nothing (or words) -----------------------------------------------------------

// Pictographs and dingbats, but not card suits (♠♣♥♦), ✓ or arrows.
const EMOJI_SRC = '(?:[\\u{1F000}-\\u{1FAFF}\\u{2600}-\\u{265F}\\u{2668}-\\u{26FF}\\u{2700}-\\u{2712}\\u{2715}-\\u{27BF}\\u{2B50}\\u{2B55}\\u{231A}\\u{231B}\\u{23E9}-\\u{23FA}]\\u{FE0F}?|\\u{FE0F}|\\u{200D})';
const EMOJI_G = new RegExp(EMOJI_SRC + '[ \\t]?', 'gu');
const EMOJI_1 = new RegExp(EMOJI_SRC, 'u');
const EMOTE_TEXT = { '😂': 'You laugh.', '😭': 'You cry.', '💀': 'You are dead inside.', '🤬': 'You curse loudly.', '👑': 'You feel like royalty.', '🤡': 'You clown around.' };

export function uiText(s) {
  const t = String(s ?? '');
  if (!EMOJI_1.test(t)) return t;
  const m = /^(\s*)you: (\S+)\s*$/u.exec(t);
  if (m && EMOTE_TEXT[m[2]]) return m[1] + EMOTE_TEXT[m[2]];
  return t.replace(EMOJI_G, '');
}
// a name or label made only of emoji keeps them rather than going blank
const keepText = s => { const t = uiText(s).trim(); return t || String(s ?? '').trim(); };

function sanitize(node) {
  if (node.nodeType === 3) { if (EMOJI_1.test(node.data)) node.data = uiText(node.data); return; }
  if (node.nodeType !== 1) return;
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (EMOJI_1.test(n.data)) n.data = uiText(n.data);
}
// Toasts are cleaned in main.js's toast template; the interaction prompt (main.js
// writes it from the targets' labels) is the only other place emoji still arrive.
function watchText() {
  if (typeof MutationObserver === 'undefined') return;
  for (const id of ['prompt']) {
    const el = document.getElementById(id);
    if (!el) continue;
    sanitize(el);
    new MutationObserver(recs => {
      for (const r of recs) {
        if (r.type === 'characterData') sanitize(r.target);
        else for (const n of r.addedNodes) sanitize(n);
      }
    }).observe(el, { subtree: true, childList: true, characterData: true });
  }
}

// ---- the CSS skin -----------------------------------------------------------------------

// what the menu card needs first, then the title painting (in stages), then the rest
const SKIN_FIRST = [
  ['frame-gold', 'ui_frame_gold'], ['btn-red', 'ui_btn_red'], ['editbox', 'ui_editbox'], ['filigree', 'ui_filigree'], ['stone', 'ui_stone'],
];
const SKIN_REST = [
  ['parchment', 'ui_parchment'], ['wood', 'ui_wood'], ['leather', 'ui_leather'], ['bar', 'ui_bar'],
  ['trim-gold', 'ui_trim_gold'], ['frame-silver', 'ui_frame_silver'], ['btn-stone', 'ui_btn_stone'],
  ['endcap', 'ui_endcap'], ['seal', 'ui_seal'], ['ring', 'ui_ring'],
  ...['crown', 'coin', 'hourglass', 'scroll', 'hook', 'key', 'sun', 'mic', 'micoff', 'speaker', 'speakeroff', 'walkie', 'gear', 'close', 'skull', 'bolt', 'ping']
    .map(n => [`ico-${n}`, `ui_ico_${n}`]),
];
function publish(key, cv, type = 'image/png') {
  const root = document.documentElement;
  cv.toBlob(b => { if (b) root.style.setProperty(`--tx-${key}`, `url("${URL.createObjectURL(b)}")`); }, type, 0.9);
}
// paint a list of registered textures, a few per task, then call next()
function paintList(list, next) {
  let i = 0;
  const step = () => {
    const t0 = performance.now();
    while (i < list.length && performance.now() - t0 < 16) {
      const [key, name] = list[i++];
      try { publish(key, canvasFor(name)); } catch (e) { console.warn('ui skin:', name, e.message); }
    }
    if (i < list.length) setTimeout(step, 0); else next?.();
  };
  setTimeout(step, 0);
}
// the title painting is a generator: one stage per task, published when done
function paintMenu(next) {
  let it;
  const cv = document.createElement('canvas');
  try {
    cv.width = 1280; cv.height = 720;
    const g = cv.getContext('2d');
    g.fillStyle = '#7f7f7f'; g.fillRect(0, 0, cv.width, cv.height);
    it = paintVista(g, cv.width, cv.height, rngFrom('ui_menu_bg'));
  } catch (e) { console.warn('ui skin: menu', e.message); next?.(); return; }
  const step = () => {
    const t0 = performance.now();
    try {
      let r;
      do { r = it.next(); } while (!r.done && performance.now() - t0 < 12);
      if (!r.done) { setTimeout(step, 0); return; }
      publish('menu', cv, 'image/jpeg');
    } catch (e) { console.warn('ui skin: menu', e.message); }
    next?.();
  };
  setTimeout(step, 0);
}

if (typeof document !== 'undefined' && document.getElementById('game')) {
  paintList(SKIN_FIRST, () => paintMenu(() => paintList(SKIN_REST)));
  watchText();
}

// ---- zone text ----------------------------------------------------------------------------

// "The Westmeadow Road" in big gold letters, fading in and out (WoW zone text).
// The fade starts on the second rendered frame after the call, so a long world
// build right after it can't eat the animation; 'show' comes off when it ends.
export function zoneText(title, sub = '') {
  const el = typeof document !== 'undefined' && document.getElementById('zoneText');
  if (!el) return;
  el.querySelector('.zt-title').textContent = title || '';
  el.querySelector('.zt-sub').textContent = sub || '';
  clearTimeout(el._t);
  el.classList.remove('hidden', 'show');
  el.classList.add('pending');                       // hides the DAY N flash meanwhile
  const token = (el._token = (el._token || 0) + 1);
  const start = () => {
    if (el._token !== token) return;
    el.classList.remove('pending');
    void el.offsetWidth;                             // restart the animation
    el.classList.add('show');
    const end = () => { if (el._token === token) el.classList.remove('show'); };
    el.addEventListener('animationend', end, { once: true });
    el.addEventListener('animationcancel', end, { once: true });
    el._t = setTimeout(end, 8000);                   // fallback, counted from the real start
  };
  const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : f => setTimeout(f, 16);
  raf(() => raf(start));
}

// ---- colors --------------------------------------------------------------------------------

// Callers pass a few neon-ish colors; map them onto the WoW text palette.
const SOFT = {
  '#7cfc00': '#4fd93a', '#ff5252': '#ff4a2e', '#ffd166': '#ffd100', '#ffe9a8': '#ffd86a', '#f4e6c0': '#f3e3b5',
  '#fff': '#ffffff', '#ffffff': '#ffffff', '#ff8a80': '#ff6a4a', '#ffb4a2': '#ff9a78', '#f2c14e': '#ffc42e',
};
const soft = c => SOFT[String(c).toLowerCase()] || c;
function hexRgb(c) {
  let s = String(c).trim().replace('#', '');
  if (s.length === 3) s = s.split('').map(ch => ch + ch).join('');
  const n = parseInt(s.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
}
const toHex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
// player names: 25% toward warm white, saturation clamped, like WoW class colours
function classColor(c) {
  let [r, g, b] = hexRgb(soft(c)).map(v => v / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  const sMax = 0.75;
  if (mx !== mn) {
    const s = l > 0.5 ? (mx - mn) / (2 - mx - mn) : (mx - mn) / (mx + mn);
    if (s > sMax) { const k = sMax / s; [r, g, b] = [r, g, b].map(v => l + (v - l) * k); }
  }
  const [wr, wg, wb] = [0xff, 0xf2, 0xd0].map(v => v / 255);
  return toHex((r * 0.75 + wr * 0.25) * 255, (g * 0.75 + wg * 0.25) * 255, (b * 0.75 + wb * 0.25) * 255);
}
const darker = (c, k) => { const [r, g, b] = hexRgb(c); return toHex(r * k, g * k, b * k); };

// Townsfolk get WoW nameplates: "Name" over "<Title>", colored by how they feel about you.
const NPCS = {
  'HONEST ED': ['Honest Ed', '<Pawnbroker>', '#4fd93a'],
  'CLERK': ['Clerk', '<General Goods>', '#4fd93a'],
  'THE DEALER': ['The Dealer', '<Games of Chance>', '#ffd100'],
  'THE REPO MAN': ['The Repo Man', '<Collections>', '#ff4a2e'],
};

const ICONS = { '📍': 'ui_ico_ping', '🔊': 'ui_ico_speaker', '📻': 'ui_ico_walkie', '🎙': 'ui_ico_mic', '🔇': 'ui_ico_micoff' };

// ---- signboards -----------------------------------------------------------------------------

// A painted signboard face: the bg color painted on with soft blotches and a
// little grain, a beveled frame, and letters with a dark carved edge and a lit
// lip. `neon` is kept for old callers and gives a warm lantern glow instead.
export function textCanvas(lines, { w = 512, h = 256, bg = '#fff', fg = '#111', font = 'Cinzel', bold = true, border = null, neon = false, painted = false } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  const rnd = rngFrom(hashStr(lines.join('|') + bg));
  const opaque = bg && bg !== 'transparent' && !/rgba\([^)]*,\s*0\)$/.test(bg);
  if (opaque) {
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 40; i++) {
      const x = rnd() * w, y = rnd() * h, r = 20 + rnd() * h * 0.5;
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const c = rnd() < 0.5 ? 'rgba(255,240,205,0.10)' : 'rgba(40,24,30,0.10)';
      gr.addColorStop(0, c); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.globalAlpha = 0.12;
    for (let i = 0; i < 28; i++) { const y = rnd() * h; g.fillStyle = rnd() < 0.5 ? '#2a1a10' : '#fff3d0'; g.fillRect(0, y, w, 1 + rnd() * 2); }
    g.globalAlpha = 1;
    const lg = g.createLinearGradient(0, 0, 0, h);
    lg.addColorStop(0, 'rgba(255,244,210,0.18)'); lg.addColorStop(0.5, 'rgba(0,0,0,0)'); lg.addColorStop(1, 'rgba(30,18,30,0.28)');
    g.fillStyle = lg; g.fillRect(0, 0, w, h);
  }
  if (border) {
    const bw = Math.max(8, Math.round(h * 0.055));
    g.lineWidth = bw; g.strokeStyle = border; g.strokeRect(bw / 2, bw / 2, w - bw, h - bw);
    g.lineWidth = 2; g.strokeStyle = 'rgba(255,240,200,0.45)'; g.strokeRect(bw * 0.25, bw * 0.25, w - bw * 0.5, h - bw * 0.5);
    g.strokeStyle = 'rgba(20,10,10,0.45)'; g.strokeRect(bw + 1, bw + 1, w - 2 * bw - 2, h - 2 * bw - 2);
  }
  const n = lines.length;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const fam = `'${font}', ${TITLE_FONT}`;
  lines.forEach((ln, i) => {
    ln = uiText(ln);
    let size = Math.floor(h / (n + 0.6) * (i === 0 ? 0.92 : 0.66));
    const set = () => { g.font = `${bold ? 'bold ' : ''}${size}px ${fam}`; };
    set();
    while (g.measureText(ln).width > w * 0.9 && size > 8) { size -= 2; set(); }
    const y = h * (i + 0.8) / (n + 0.6);
    if (neon) { g.save(); g.shadowColor = 'rgba(255,190,90,0.7)'; g.shadowBlur = size * 0.35; g.fillStyle = fg; g.fillText(ln, w / 2, y); g.restore(); }
    // carved: dark recess up-left, lit lip down-right, then the paint
    g.fillStyle = 'rgba(20,10,8,0.55)'; g.fillText(ln, w / 2 - Math.max(1, size * 0.04), y - Math.max(1, size * 0.04));
    g.fillStyle = 'rgba(255,240,205,0.35)'; g.fillText(ln, w / 2 + Math.max(1, size * 0.03), y + Math.max(1, size * 0.03));
    if (painted) { g.globalAlpha = 0.92; }
    g.fillStyle = fg; g.fillText(ln, w / 2, y);
    g.globalAlpha = 1;
  });
  return cv;
}

// ---- sprites --------------------------------------------------------------------------------

// WoW nameplate lettering: one thin dark outline and a 1px shadow down-right.
function outlined(g, text, x, y, fill, size) {
  const ow = Math.max(2.5, size * 0.08);
  g.lineJoin = 'round'; g.miterLimit = 2;
  g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillText(text, x + Math.max(1, size * 0.03), y + Math.max(1, size * 0.03));
  g.lineWidth = ow; g.strokeStyle = 'rgba(6,4,3,0.92)'; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
}
function fitFont(g, text, size, maxW, min = 12, weight = '') {
  const set = () => { g.font = `${weight}${size}px ${UI_FONT}`; };
  set();
  while (g.measureText(text).width > maxW && size > min) { size -= 2; set(); }
  return size;
}

// A small painted wooden placard: stained planks, a dark rim, four iron nails,
// cream letters cut into the wood (dark edge, lit lip); amounts in gold.
function drawPlacard(g, W, H, text, color) {
  let size = fitFont(g, text, 46, W - 76, 14);
  const tw = g.measureText(text).width;
  const pw = Math.min(W - 6, tw + 64), ph = Math.min(H - 6, size + 30);
  const x = (W - pw) / 2, y = (H - ph) / 2;
  g.save();
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.beginPath(); g.roundRect(x + 2, y + 3, pw, ph, 5); g.fill();
  g.beginPath(); g.roundRect(x, y, pw, ph, 5); g.clip();
  try { g.fillStyle = g.createPattern(canvasFor('ui_wood'), 'repeat'); } catch { g.fillStyle = '#5a3a22'; }
  g.fillRect(x, y, pw, ph);
  const sh = g.createLinearGradient(0, y, 0, y + ph);
  sh.addColorStop(0, 'rgba(255,226,170,0.22)'); sh.addColorStop(0.45, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(20,10,4,0.35)');
  g.fillStyle = sh; g.fillRect(x, y, pw, ph);
  g.restore();
  g.lineWidth = 2.5; g.strokeStyle = '#2e1c0c'; g.beginPath(); g.roundRect(x + 1.2, y + 1.2, pw - 2.4, ph - 2.4, 5); g.stroke();
  g.lineWidth = 1; g.strokeStyle = 'rgba(255,220,160,0.28)'; g.beginPath(); g.roundRect(x + 3.5, y + 3.5, pw - 7, ph - 7, 3); g.stroke();
  for (const [nx, ny] of [[x + 9, y + 9], [x + pw - 9, y + 9], [x + 9, y + ph - 9], [x + pw - 9, y + ph - 9]]) {
    g.fillStyle = 'rgba(10,6,2,0.6)'; g.beginPath(); g.arc(nx + 0.8, ny + 0.9, 3.4, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#5c616a'; g.beginPath(); g.arc(nx, ny, 2.8, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#b8bcc4'; g.beginPath(); g.arc(nx - 0.9, ny - 0.9, 1.1, 0, Math.PI * 2); g.fill();
  }
  // letters cut into the wood: the run is split so amounts can be gold
  g.textAlign = 'left'; g.textBaseline = 'middle';
  const base = color, gold = '#ffd100';
  const parts = base === '#f3e3b5' ? text.split(/([+\-]?\$[\d,]+|\b\d+\b)/) : [text];
  let cx = W / 2 - tw / 2;
  const cy = H / 2 + 1;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    const col = i % 2 ? gold : base;
    g.fillStyle = 'rgba(18,8,2,0.85)'; g.fillText(p, cx - 1, cy - 1.2);
    g.fillStyle = 'rgba(255,226,170,0.35)'; g.fillText(p, cx + 1, cy + 1.2);
    g.fillStyle = col; g.fillText(p, cx, cy);
    cx += g.measureText(p).width;
  }
  g.textAlign = 'center';
}
function placardColor(c) {
  const k = String(c).toLowerCase();
  if (k === '#7cfc00' || k === '#4fd93a') return '#8fe060';
  if (k === '#ff5252' || k === '#ff8a80') return '#ff7a5a';
  if (k === '#ffd166' || k === '#f2c14e') return '#ffd100';
  return '#f3e3b5';
}

function drawNameplate(g, W, H, text, color, size) {
  g.textAlign = 'center'; g.textBaseline = 'middle';
  size = fitFont(g, text, size, W - 24);
  outlined(g, text, W / 2, H / 2 + 2, color, size);
}
function drawNpcPlate(g, W, H, name, title, color) {
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const s1 = fitFont(g, name, 58, W - 24);
  outlined(g, name, W / 2, H * 0.32, color, s1);
  const s2 = fitFont(g, title, Math.round(s1 * 0.82), W - 24);
  outlined(g, title, W / 2, H * 0.76, darker(color, 0.86), s2);
}

function drawIcon(g, W, H, name) {
  // the sprites that carry icons are shown at 2:1, so pre-stretch to keep them round
  const img = canvasFor(name);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
  g.drawImage(img, W / 2 - H * (W / H) / 4, 0, H * (W / H) / 2, H);
  g.restore();
}

// on-screen cap (sprite height in CSS px) per kind
const CAP = { icon: 64, combat: 64, name: 40, npc: 70, button: 34, placard: 50 };
const _p = new THREE.Vector3(), _c = new THREE.Vector3(), _sz = new THREE.Vector2();

export function labelSprite(text, color = '#fff', px = 40) {
  const raw0 = String(text ?? '').trim();
  const npc0 = px < 40 ? NPCS[raw0] : null;          // town3d's NPC labels (players' own names never match)
  const W = 512, H = npc0 ? 168 : 96;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const tex = canvasTex(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, fog: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.4, 0.45, 1);
  if (npc0) sp.center.set(0.5, 0.1);                 // two-line plates grow upward, clear of the head
  const kind = px >= 60 ? 'icon' : px >= 42 ? 'combat' : px >= 40 ? 'name' : npc0 ? 'npc' : px >= 34 ? 'button' : 'placard';
  const draw = () => {
    const t = sp.userData.t, c = sp.userData.c;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const raw = String(t ?? '').trim();
    const npc = px < 40 ? NPCS[raw] : null;
    if (px >= 60 && ICONS[raw]) drawIcon(g, W, H, ICONS[raw]);
    else if (npc && H > 96) drawNpcPlate(g, W, H, npc[0], npc[1], npc[2]);
    else {
      const str = keepText(raw);
      if (!str) { /* blank */ } else if (kind === 'placard') drawPlacard(g, W, H, str, placardColor(c));
      else if (kind === 'button') drawNameplate(g, W, H, str, soft(c) === '#f3e3b5' ? '#ffd100' : soft(c), 50);
      else if (kind === 'combat') drawNameplate(g, W, H, str, soft(c), 60);
      else drawNameplate(g, W, H, str, kind === 'name' ? classColor(c) : soft(c), 52);
    }
    tex.needsUpdate = true;
  };
  sp.userData.set = (t, c = color) => {
    if (sp.userData.t === t && sp.userData.c === c) return;
    sp.userData.t = t; sp.userData.c = c;
    draw();
    if (!fontsReady) redrawWhenFonts.add(draw);
  };
  sp.userData.set(text, color);
  // Keep the label a fixed size on screen once it gets close: the caller's scale
  // is the size at a distance; nearer than that the sprite shrinks to stay under
  // CAP[kind] pixels tall. Text labels keep the canvas's aspect.
  const ud = sp.userData;
  sp.onBeforeRender = (renderer, scene, camera) => {
    if (!ud.base || sp.scale.x !== ud.lx || sp.scale.y !== ud.ly) ud.base = sp.scale.clone();
    let sx = ud.base.x, sy = kind === 'icon' ? ud.base.y : ud.base.x * H / W;
    if (camera.isPerspectiveCamera) {
      _p.setFromMatrixPosition(sp.matrixWorld);
      _c.setFromMatrixPosition(camera.matrixWorld);
      const d = Math.max(0.05, _p.distanceTo(_c));
      renderer.getSize(_sz);
      const onScreen = sy / (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1)) * _sz.y;
      if (onScreen > CAP[kind]) { const k = CAP[kind] / onScreen; sx *= k; sy *= k; }
    }
    if (sx !== sp.scale.x || sy !== sp.scale.y) { sp.scale.set(sx, sy, 1); sp.updateMatrixWorld(); }
    ud.lx = sp.scale.x; ud.ly = sp.scale.y;
  };
  // free the GPU texture when the sprite leaves the scene (three re-uploads it if it comes back)
  sp.addEventListener('removed', () => { tex.dispose(); mat.dispose(); redrawWhenFonts.delete(draw); });
  ud.dispose = () => { tex.dispose(); mat.dispose(); redrawWhenFonts.delete(draw); };
  return sp;
}
