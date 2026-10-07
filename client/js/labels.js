// Text and the 2D interface skin. Owned by the UI art pass (docs/ART.md).
//
//   textCanvas(lines, opts)        a painted signboard face on a <canvas>
//   labelSprite(text, color, px)   a camera-facing text sprite; sprite.userData.set(text, color) updates it.
//                                  px >= 40: a WoW-style nameplate (outlined text, no backing)
//                                  px <  40: a small dark tooltip plaque with a gold rim (status labels)
//                                  known NPC names get a WoW "<Title>" line; a few emoji become painted icons
//   zoneText(title, sub)           the big gold WoW zone text that fades in when a day starts
//   uiText(s)                      strips emoji (the WoW UI has none) and turns emote toasts into "You laugh."
//
// On import this module also (1) waits for the vendored fonts and redraws any
// sprite drawn before they arrived, (2) paints the UI textures in paint/ui.js
// and exposes them to style.css as --tx-* custom properties, and (3) keeps
// emoji out of the HUD text that main.js writes.
import * as THREE from '/vendor/three.module.js';
import { canvasTex } from './gfx.js';
import { canvasFor, hashStr, rngFrom } from './paint/index.js';

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

function sanitizeTree(node) {
  if (node.nodeType === 3) { if (EMOJI_1.test(node.data)) node.data = uiText(node.data); return; }
  if (node.nodeType !== 1) return;
  const walk = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) if (EMOJI_1.test(n.data)) n.data = uiText(n.data);
}
function watchText() {
  const root = document.getElementById('game');
  if (!root || typeof MutationObserver === 'undefined') return;
  sanitizeTree(root);
  new MutationObserver(recs => {
    for (const r of recs) {
      if (r.type === 'characterData') sanitizeTree(r.target);
      else for (const n of r.addedNodes) sanitizeTree(n);
    }
  }).observe(root, { subtree: true, childList: true, characterData: true });
}

// ---- the CSS skin -----------------------------------------------------------------------

const SKIN = [
  ['menu', 'ui_menu_bg', 'image/jpeg'],
  ['parchment', 'ui_parchment'], ['stone', 'ui_stone'], ['wood', 'ui_wood'], ['leather', 'ui_leather'], ['bar', 'ui_bar'],
  ['frame-gold', 'ui_frame_gold'], ['frame-silver', 'ui_frame_silver'], ['editbox', 'ui_editbox'],
  ['btn-red', 'ui_btn_red'], ['btn-stone', 'ui_btn_stone'],
  ['filigree', 'ui_filigree'], ['endcap', 'ui_endcap'], ['seal', 'ui_seal'],
  ...['crown', 'coin', 'hourglass', 'scroll', 'hook', 'key', 'sun', 'mic', 'micoff', 'speaker', 'speakeroff', 'walkie', 'gear', 'close', 'skull']
    .map(n => [`ico-${n}`, `ui_ico_${n}`]),
];
function installSkin() {
  const root = document.documentElement;
  let i = 0;
  const step = () => {
    const t0 = performance.now();
    while (i < SKIN.length && performance.now() - t0 < 24) {
      const [key, name, type = 'image/png'] = SKIN[i++];
      try {
        const cv = canvasFor(name);
        cv.toBlob(b => { if (b) root.style.setProperty(`--tx-${key}`, `url("${URL.createObjectURL(b)}")`); }, type, 0.92);
      } catch (e) { console.warn('ui skin:', name, e.message); }
    }
    if (i < SKIN.length) setTimeout(step, 0);
  };
  setTimeout(step, 0);
}

if (typeof document !== 'undefined' && document.getElementById('game')) {
  installSkin();
  watchText();
}

// ---- zone text ----------------------------------------------------------------------------

// "The Westmeadow Road" in big gold letters, fading in and out (WoW zone text).
export function zoneText(title, sub = '') {
  const el = typeof document !== 'undefined' && document.getElementById('zoneText');
  if (!el) return;
  el.querySelector('.zt-title').textContent = title || '';
  el.querySelector('.zt-sub').textContent = sub || '';
  el.classList.remove('hidden', 'show');
  void el.offsetWidth;            // restart the animation
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 7200);
}

// ---- colors --------------------------------------------------------------------------------

// Callers pass a few neon-ish colors; map them onto the WoW text palette.
const SOFT = {
  '#7cfc00': '#4fd93a', '#ff5252': '#ff4a2e', '#ffd166': '#ffd100', '#ffe9a8': '#ffd86a', '#f4e6c0': '#f3e3b5',
  '#fff': '#ffffff', '#ffffff': '#ffffff', '#ff8a80': '#ff6a4a', '#ffb4a2': '#ff9a78', '#f2c14e': '#ffc42e',
};
const soft = c => SOFT[String(c).toLowerCase()] || c;

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

function outlined(g, text, x, y, fill, ow) {
  g.lineJoin = 'round'; g.miterLimit = 2;
  g.lineWidth = ow + 3; g.strokeStyle = 'rgba(0,0,0,0.35)'; g.strokeText(text, x + 2, y + 3);   // soft drop
  g.lineWidth = ow; g.strokeStyle = 'rgba(8,5,4,0.95)'; g.strokeText(text, x, y);
  g.fillStyle = fill; g.fillText(text, x, y);
}

function drawPlaque(g, W, H, text, color, px) {
  let size = Math.round(px * 1.4);       // short labels grow a little; long ones shrink to fit
  const font = () => { g.font = `${size}px ${UI_FONT}`; };
  font();
  while (g.measureText(text).width > W - 70 && size > 12) { size -= 2; font(); }
  const tw = g.measureText(text).width;
  const pw = Math.min(W - 8, tw + 54), ph = Math.min(H - 8, size + 30);
  const x = (W - pw) / 2, y = (H - ph) / 2;
  // tooltip body: deep blue-black, a little translucent
  g.fillStyle = 'rgba(6,8,20,0.84)';
  g.beginPath(); g.roundRect(x, y, pw, ph, 9); g.fill();
  const sh = g.createLinearGradient(0, y, 0, y + ph);
  sh.addColorStop(0, 'rgba(120,130,170,0.18)'); sh.addColorStop(0.5, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.25)');
  g.fillStyle = sh; g.fill();
  // gold rim with a lit top edge
  const rim = g.createLinearGradient(0, y, 0, y + ph);
  rim.addColorStop(0, '#f6dc8a'); rim.addColorStop(0.5, '#b88a34'); rim.addColorStop(1, '#6e4a16');
  g.lineWidth = 3.5; g.strokeStyle = rim; g.beginPath(); g.roundRect(x + 2, y + 2, pw - 4, ph - 4, 8); g.stroke();
  g.lineWidth = 1.2; g.strokeStyle = 'rgba(10,6,2,0.9)'; g.beginPath(); g.roundRect(x + 0.6, y + 0.6, pw - 1.2, ph - 1.2, 9); g.stroke();
  for (const cx of [x + 10, x + pw - 10]) { g.fillStyle = '#e8c76a'; g.beginPath(); g.arc(cx, y + ph / 2, 3, 0, Math.PI * 2); g.fill(); g.fillStyle = 'rgba(60,30,8,0.9)'; g.beginPath(); g.arc(cx + 0.8, y + ph / 2 + 0.8, 1.4, 0, Math.PI * 2); g.fill(); }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  outlined(g, text, W / 2, H / 2 + 2, color, 5);
}

function drawNameplate(g, W, H, text, color, px, sub = null) {
  g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = sub ? 46 : px;
  const font = () => { g.font = `${size}px ${UI_FONT}`; };
  font();
  while (g.measureText(text).width > W - 24 && size > 12) { size -= 2; font(); }
  const ow = Math.max(5, size * 0.17);
  if (!sub) { outlined(g, text, W / 2, H / 2 + 2, color, ow); return; }
  outlined(g, text, W / 2, H * 0.33, color, ow);
  let s2 = Math.round(size * 0.6);
  g.font = `${s2}px ${UI_FONT}`;
  while (g.measureText(sub).width > W - 24 && s2 > 10) { s2 -= 2; g.font = `${s2}px ${UI_FONT}`; }
  outlined(g, sub, W / 2, H * 0.8, color, Math.max(4, s2 * 0.2));
}

function drawIcon(g, W, H, name) {
  // the sprites that carry icons are shown at 2:1, so pre-stretch to keep them round
  const img = canvasFor(name);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
  g.drawImage(img, W / 2 - H * (W / H) / 4, 0, H * (W / H) / 2, H);
  g.restore();
}

export function labelSprite(text, color = '#fff', px = 40) {
  const W = 512, H = 96;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const tex = canvasTex(cv);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, fog: false });
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.4, 0.45, 1);
  const draw = () => {
    const t = sp.userData.t, c = sp.userData.c;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const raw = String(t ?? '');
    if (ICONS[raw.trim()]) drawIcon(g, W, H, ICONS[raw.trim()]);
    else {
      const npc = px < 40 ? NPCS[raw.trim()] : null;     // town3d's NPC labels (players' own names never match)
      const str = uiText(raw).trim();
      if (npc) drawNameplate(g, W, H, npc[0], npc[2], px, npc[1]);
      else if (str && px < 40) drawPlaque(g, W, H, str, soft(c), px);
      else if (str) drawNameplate(g, W, H, str, soft(c), px);
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
  return sp;
}
