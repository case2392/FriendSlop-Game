// Road Cards on the page (shared/cards.js has the catalogue and the odds). A card is HTML: a frame by its
// rarity (cream common, teal uncommon, brass kit, gilt rare), its picture, its name, its number (07/30) and
// its line. The picture is made once, in idle time, and kept as a data URL: an offscreen render of the
// game's own model (the loot from props3d.js, the critters from mobs3d.js, Honest Ed and the Repo Man from
// people.js, the way the party portraits are made), or an emblem inked here for the rest (the kit cards'
// emblems, the places, the money). Until it's ready the frame shows the card's set emblem.
import * as THREE from '/vendor/three.module.js';
import { CARD, SETS } from '/shared/cards.js';

const ART = new Map();     // card id -> data URL ('' while pending, or if it failed)
const jobs = [];
let busy = false;
const W_ART = 168, H_ART = 120;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// a card as HTML. state: 'owned' | 'seen' (had one in a glovebox, never kept) | 'lost' (the Repo Man took
// it before you ever kept one) | 'unseen' (a card back). n: copies (x2 shows); fresh: a NEW badge; note: a
// line under it ('Lost to the Repo Man, day 3')
export function cardHTML(id, { n = 0, fresh = false, state = 'owned', note = '', small = false } = {}) {
  const c = CARD[id];
  if (!c) return '';
  const sz = small ? ' small' : '';
  if (state === 'unseen') return `<div class="rcard back${sz}"><div class="rc-back"></div><div class="rc-no">${String(c.no).padStart(2, '0')}/30</div></div>`;
  const url = art(id), set = SETS[c.set - 1];
  return `<div class="rcard r-${c.rarity}${state !== 'owned' ? ' grey' : ''}${sz}" data-ck="${id}" title="${esc(`${c.name}: ${c.line}`)}"${url ? ` data-art="1" style="--art:url(${url})"` : ''}>`
    + `<div class="rc-art" data-emb="${set?.emblem || ''}"></div><div class="rc-name">${esc(c.name)}</div><div class="rc-line">${esc(c.line)}</div>`
    + `<div class="rc-no">${String(c.no).padStart(2, '0')}/30</div>${n > 1 ? `<div class="rc-n">x${n}</div>` : ''}${fresh ? '<div class="rc-new">NEW</div>' : ''}`
    + `${c.kind === 'kit' && state === 'owned' ? '<div class="rc-kit">Unlocks in the Garage soon</div>' : ''}${note ? `<div class="rc-note">${esc(note)}</div>` : ''}</div>`;
}
// the picture's data URL ('' till it's made: the elements showing it are filled in when it is)
function art(id) {
  if (!ART.has(id)) { ART.set(id, ''); jobs.push(id); setTimeout(pump, 0); }
  return ART.get(id);
}
export const cardArt = id => art(id);

async function pump() {
  if (busy || !jobs.length) return;
  busy = true;
  let r = null;
  try {
    while (jobs.length) {
      await new Promise(res => (window.requestIdleCallback || (f => setTimeout(f, 30)))(res, { timeout: 1500 }));
      const id = jobs.shift(), c = CARD[id];
      try {
        const [kind, what] = c.art.includes(':') ? c.art.split(':') : [c.art, ''];
        let url;
        if (kind === 'e' || kind === 'rv') url = emblem(kind === 'rv' ? 'rv' : what);
        else {
          r ||= new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true });
          url = await renderModel(r, kind, what);
        }
        ART.set(id, url);
        for (const el of document.querySelectorAll(`.rcard[data-ck="${id}"]`)) { el.style.setProperty('--art', `url(${url})`); el.dataset.art = '1'; }
      } catch (e) { console.warn('card art:', id, e.message); }
    }
  } finally {
    if (r) { r.dispose(); r.forceContextLoss(); }
    busy = false;
    if (jobs.length) setTimeout(pump, 0);
  }
}

// the model, framed three-quarters on from its front, lit like the portraits
async function renderModel(r, kind, what) {
  r.setPixelRatio(1); r.setSize(W_ART, H_ART, false);
  r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.NoToneMapping; r.setClearColor(0x000000, 0);
  let obj, head = false;
  if (kind === 'p') obj = (await import('./props3d.js')).buildProp(what, null);
  else if (kind === 'm') { const m = (await import('./mobs3d.js')).buildMob(what, { biome: 'meadow' }); obj = m.obj; for (let i = 0; i < 20; i++) m.view.update(1 / 30, i / 30, 0, null); }
  else if (kind === 'n') {
    const ppl = await import('./people.js');
    const ch = what === 'repoman' ? ppl.buildCharacter('#6b5640', { hatIndex: 0, skinIndex: 1, scale: 1.25, outfit: 'repo' })
      : ppl.buildCharacter('#c0392b', { hatIndex: 2, skinIndex: 3, outfit: 'ed' });
    ch.driven = true; obj = ch.root; head = ch.head;
  }
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#f0e4cc', '#4a3a2a', 1.7));
  const key = new THREE.DirectionalLight('#ffe2b4', 2.3); key.position.set(-1.4, 1.6, 2.2); scene.add(key);
  const back = new THREE.DirectionalLight('#9ab0ff', 1.0); back.position.set(1.6, 0.9, -1.6); scene.add(back);
  scene.add(obj);
  obj.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(30, W_ART / H_ART, 0.02, 60);
  if (head) {
    // (head and shoulders, like a portrait, a little wider)
    const h = new THREE.Vector3(); head.getWorldPosition(h);
    const look = h.clone().add(new THREE.Vector3(0, -0.08, 0));
    cam.position.copy(look).add(new THREE.Vector3(0.45, 0.08, 1.35));
    cam.lookAt(look);
  } else {
    const box = new THREE.Box3().setFromObject(obj), c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
    const R = Math.max(s.x, s.y, s.z) * 0.62 + 0.02, d = R / Math.tan(THREE.MathUtils.degToRad(15)) * 1.05;
    cam.position.copy(c).add(new THREE.Vector3(0.62, 0.42, 0.66).normalize().multiplyScalar(d));
    cam.lookAt(c);
  }
  r.render(scene, cam);
  const cv = document.createElement('canvas');
  cv.width = W_ART; cv.height = H_ART;
  cv.getContext('2d').drawImage(r.domElement, 0, 0);
  // (the geometry stays: the props' and the people's builders share and cache theirs)
  return cv.toDataURL('image/png');
}

// ---- the inked emblems ------------------------------------------------------------------------------------
// One per kit card and per place: a few strokes of brown ink on the card's paper, in the house style of the
// game's painted signs (no fonts but the numbers)
const INK = '#3b2410', WASH = 'rgba(122, 74, 30, 0.22)';
function emblem(kind) {
  const cv = document.createElement('canvas');
  cv.width = W_ART; cv.height = H_ART;
  const g = cv.getContext('2d');
  g.lineCap = 'round'; g.lineJoin = 'round'; g.strokeStyle = INK; g.fillStyle = WASH; g.lineWidth = 4;
  g.translate(W_ART / 2, H_ART / 2);
  const path = (pts, close = true) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); if (close) g.closePath(); };
  const both = () => { g.fill(); g.stroke(); };
  const circle = (x, y, r) => { g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); };
  const rrect = (x, y, w, h, r) => { g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, r) : g.rect(x, y, w, h); };
  const text = (s, x, y, px) => { g.fillStyle = INK; g.font = `bold ${px}px Georgia, serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(s, x, y); g.fillStyle = WASH; };
  switch (kind) {
    case 'gloves':
      for (const s of [-1, 1]) {
        g.save(); g.translate(s * 24, 4); g.rotate(s * 0.25); g.scale(s, 1);
        path([[-14, 30], [-16, -2], [-12, -26], [-4, -28], [-2, -6], [4, -24], [12, -22], [16, -4], [22, -10], [26, -4], [14, 14], [12, 30]]); both();
        path([[-14, 22], [12, 22]], false); g.stroke();
        g.restore();
      }
      break;
    case 'walkie':
      rrect(-20, -26, 40, 62, 6); both();
      path([[12, -26], [12, -48]], false); g.stroke(); circle(12, -50, 3); g.stroke();
      for (let i = 0; i < 4; i++) { path([[-12, -14 + i * 7], [12, -14 + i * 7]], false); g.stroke(); }
      rrect(-12, 16, 24, 12, 3); g.stroke();
      g.lineWidth = 2.5; for (const r of [10, 18]) { g.beginPath(); g.arc(30, -40, r, -0.9, 0.3); g.stroke(); }
      break;
    case 'bullbar':
      rrect(-56, -22, 112, 44, 14); g.stroke(); rrect(-46, -12, 92, 24, 8); g.stroke();
      for (const x of [-30, -10, 10, 30]) { path([[x, -22], [x, 22]], false); g.stroke(); }
      for (const x of [-40, 40]) { path([[x, 22], [x, 40]], false); g.stroke(); }
      break;
    case 'medic':
      rrect(-36, -18, 72, 46, 8); both();
      path([[-14, -18], [-10, -32], [10, -32], [14, -18]], false); g.stroke();
      g.fillStyle = '#9e2a1c'; g.fillRect(-5, -10, 10, 30); g.fillRect(-15, 0, 30, 10); g.fillStyle = WASH;
      break;
    case 'mud':
      g.beginPath(); g.ellipse(0, 18, 58, 16, 0, 0, Math.PI * 2); both();
      for (let k = 0; k < 3; k++) { g.beginPath(); for (let x = -46; x <= 46; x += 4) g.lineTo(x, -24 + k * 12 + Math.sin(x * 0.18 + k) * 4); g.stroke(); }
      circle(-20, 16, 4); g.stroke(); circle(18, 22, 6); g.stroke();
      break;
    case 'chalk':
      path([[-22, -16], [22, -16], [26, 30], [-26, 30]]); both();
      path([[-24, -16], [-20, -26], [20, -26], [24, -16]], false); g.stroke();
      g.fillStyle = INK; for (const [x, y] of [[-34, -34], [-26, -44], [30, -38], [38, -26], [-40, -20], [34, -48]]) { circle(x, y, 2.2); g.fill(); } g.fillStyle = WASH;
      break;
    case 'horn':
      path([[-46, -8], [-46, 8], [0, 14], [30, 30], [30, -30], [0, -14]]); both();
      g.lineWidth = 3; for (const r of [12, 22, 32]) { g.beginPath(); g.arc(34, 0, r, -0.7, 0.7); g.stroke(); }
      break;
    case 'rockfall':
      for (const [x, y, s] of [[-30, -30, 14], [8, -10, 18], [30, 26, 12], [-14, 28, 10]]) { path([[x - s, y], [x - s / 2, y - s], [x + s * 0.7, y - s * 0.8], [x + s, y + s * 0.2], [x + s / 3, y + s]]); both(); }
      g.lineWidth = 2.5; for (const [x, y] of [[-30, -52], [8, -36], [30, 4]]) { path([[x - 4, y - 14], [x - 4, y - 4]], false); g.stroke(); path([[x + 6, y - 16], [x + 6, y - 6]], false); g.stroke(); }
      break;
    case 'winch':
      rrect(-34, -26, 52, 52, 6); both(); circle(-8, 0, 14); g.stroke(); circle(-8, 0, 4); g.stroke();
      path([[6, 10], [30, 10], [44, 24]], false); g.stroke();
      g.beginPath(); g.arc(44, 34, 8, -Math.PI / 2, Math.PI * 0.9); g.stroke();
      break;
    case 'eye':
      g.beginPath(); g.moveTo(-56, 0); g.quadraticCurveTo(0, -46, 56, 0); g.quadraticCurveTo(0, 46, -56, 0); both();
      circle(0, 0, 16); g.stroke(); g.fillStyle = INK; circle(0, 0, 7); g.fill(); g.fillStyle = '#fff6e0'; circle(-4, -4, 2.5); g.fill(); g.fillStyle = WASH;
      g.lineWidth = 2.5; for (const [x, y] of [[44, -34], [52, -24]]) { path([[x - 6, y], [x + 6, y]], false); g.stroke(); path([[x, y - 6], [x, y + 6]], false); g.stroke(); }
      break;
    case 'crash':
      g.save(); g.rotate(0.35);
      rrect(-50, -8, 96, 16, 8); both(); path([[-6, -8], [-20, -40], [-4, -40], [16, -8]]); both(); path([[-44, -8], [-52, -24], [-42, -24], [-34, -8]]); both();
      g.restore();
      g.lineWidth = 3; for (const [x, y, r] of [[36, -26, 9], [46, -40, 12], [36, -54, 7]]) { circle(x, y, r); g.stroke(); }
      break;
    case 'hoard':
      for (const [x, y, w, h] of [[-50, 10, 34, 24], [-14, 2, 30, 32], [18, 12, 34, 22], [-30, -16, 26, 22], [4, -26, 26, 26]]) { rrect(x, y, w, h, 4); both(); }
      g.fillStyle = INK; circle(17, -13, 4); g.fill(); g.fillStyle = WASH;
      break;
    case 'wheel':
      circle(0, 0, 40); g.stroke(); circle(0, 0, 8); both();
      for (const a of [Math.PI / 2, Math.PI * 7 / 6, -Math.PI / 6]) { path([[Math.cos(a) * 8, Math.sin(a) * 8], [Math.cos(a) * 38, Math.sin(a) * 38]], false); g.stroke(); }
      break;
    case 'toolbox':
      rrect(-46, -12, 92, 44, 5); both(); path([[-46, 2], [46, 2]], false); g.stroke();
      path([[-16, -12], [-16, -28], [16, -28], [16, -12]], false); g.stroke();
      g.save(); g.rotate(-0.5); rrect(-6, -52, 12, 34, 3); g.stroke(); g.restore();
      break;
    case 'dice':
      for (const [x, y, a, n] of [[-24, 4, -0.2, 5], [24, -4, 0.25, 3]]) {
        g.save(); g.translate(x, y); g.rotate(a); rrect(-20, -20, 40, 40, 6); both();
        g.fillStyle = INK; const P = { 3: [[-10, -10], [0, 0], [10, 10]], 5: [[-10, -10], [10, -10], [0, 0], [-10, 10], [10, 10]] }[n];
        for (const [px, py] of P) { circle(px, py, 3.2); g.fill(); } g.fillStyle = WASH; g.restore();
      }
      break;
    case 'coin':
      circle(0, 0, 40); both(); circle(0, 0, 32); g.stroke(); text('$', 0, 2, 44);
      break;
    case 'balloon':
      g.beginPath(); g.ellipse(0, -10, 32, 40, 0, 0, Math.PI * 2); both();
      path([[0, 30], [-4, 38], [4, 38]]); g.stroke();
      g.beginPath(); g.moveTo(0, 38); g.bezierCurveTo(-12, 46, 12, 52, 0, 60); g.stroke();
      text('$', 0, -8, 34);
      break;
    case 'rv':
      rrect(-60, -24, 96, 46, 6); both(); path([[36, -10], [56, -2], [58, 22], [36, 22]]); both();
      path([[24, -38], [52, -38], [52, -24], [24, -24]]); both();
      for (const x of [-38, 36]) { circle(x, 24, 11); g.fillStyle = INK; g.fill(); g.fillStyle = WASH; }
      rrect(-48, -14, 18, 14, 2); g.stroke(); rrect(-22, -14, 18, 14, 2); g.stroke();
      break;
    default:
      circle(0, 0, 30); g.stroke(); text('?', 0, 2, 34);
  }
  return cv.toDataURL('image/png');
}
