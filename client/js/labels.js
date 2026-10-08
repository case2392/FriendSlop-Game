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
import { canvasTex, tex, painted } from './gfx.js';
import { canvasFor, hashStr, rngFrom } from './paint/index.js';
import { paintVista, finishVista } from './paint/ui.js';

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
// as a blob URL, decoded before the custom property is set, so first use never paints empty
function publish(key, cv, type = 'image/png', done = null) {
  const root = document.documentElement;
  cv.toBlob(b => {
    if (!b) return;
    const url = URL.createObjectURL(b), im = new Image();
    im.src = url;
    const set = () => { root.style.setProperty(`--tx-${key}`, `url("${url}")`); done?.(); };
    (im.decode ? im.decode() : Promise.resolve()).then(set, set);
  }, type, 0.9);
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
// ---- the title screen --------------------------------------------------------------------
//
// A painted sky and mountains (paint/ui.js paintVista, backdrop stages only), the real game
// assets in front of them as a lit 3D diorama (the RV coming down the dirt road, the big oak,
// pines, rocks, a rail fence and a signpost, grass tufts; rendered once in an offscreen WebGL
// canvas that is thrown away after), then the painted atmosphere over the lot (finishVista).
// If the 3D modules can't load, the whole scene is painted in 2D instead.

// The layout, in meters: the camera at the origin looking down -Z, level, the horizon lens-
// shifted to 60% down the frame (verticals stay vertical, like a painting). Golden hour on
// the meadow (atmosphere.js keys), the sun low on the left.
const DIO = {
  fov: 36, eye: 2.4, hz: 0.6,
  sun: [-0.62, 0.42, 0.36], sunC: '#ffd49a', sunI: 2.05, sky: '#e6e0cf', gnd: '#6a7a42', hemiI: 1.7,
  fog: '#b2b994', fogNear: 45, fogFar: 430, fade: [70, 200],
  road: [[1.4, 10], [0.8, -2], [-0.4, -9], [-2.4, -16], [-5.4, -22], [-8.6, -28], [-10.6, -36], [-10.4, -46], [-7.6, -58], [-3.4, -74], [0.8, -98], [2.2, -136], [0.8, -190], [-0.4, -300], [0, -700]],
  rvZ: -27.5,
};
const tick = () => new Promise(r => setTimeout(r, 0));
const menuShown = () => { const m = document.getElementById('menu'); return !!m && !m.classList.contains('hidden'); };

// Lambert with the map laid in world space at two scales (no visible tiling), a broad warm/
// cool drift, and alpha falling off with view distance so the painted fields show through.
function groundMat(map, tileA, tileB, fade) {
  const m = new THREE.MeshLambertMaterial({ map, transparent: true });
  m.onBeforeCompile = sh => {
    sh.uniforms.uFade = { value: new THREE.Vector2(fade[0], fade[1]) };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp; varying float vFd;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWp = (modelMatrix * vec4(transformed, 1.0)).xyz; vFd = -mvPosition.z;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vWp; varying float vFd; uniform vec2 uFade;')
      .replace('#include <map_fragment>', `
        vec2 gp = vWp.xz;
        vec4 tA = texture2D(map, gp / ${tileA.toFixed(2)});
        vec4 tB = texture2D(map, mat2(0.8, -0.6, 0.6, 0.8) * gp / ${tileB.toFixed(2)} + vec2(0.31, 0.77));
        float gn = 0.5 + 0.25 * sin(gp.x * 0.071 + sin(gp.y * 0.043) * 2.0) + 0.25 * sin(gp.y * 0.063 + 1.7 + sin(gp.x * 0.037) * 1.6);
        vec4 gt = mix(tA, tB, smoothstep(0.3, 0.7, gn));
        float gm = 0.5 + 0.5 * sin(gp.x * 0.029 + 0.6) * sin(gp.y * 0.023 + 1.3);
        gt.rgb *= mix(vec3(0.86, 0.95, 1.0), vec3(1.1, 1.03, 0.8), gm);
        diffuseColor *= gt;`)
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= 1.0 - smoothstep(uFade.x, uFade.y, vFd);');
  };
  return m;
}
function fadeMat(opts, fade) {
  const m = new THREE.MeshLambertMaterial(opts);
  m.onBeforeCompile = sh => {
    sh.uniforms.uFade = { value: new THREE.Vector2(fade[0], fade[1]) };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vFd;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFd = -mvPosition.z;');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vFd; uniform vec2 uFade;')
      .replace('#include <dithering_fragment>', '#include <dithering_fragment>\ngl_FragColor.a *= 1.0 - smoothstep(uFade.x, uFade.y, vFd);');
  };
  return m;
}

// The dirt road: a ribbon along the curve, the road texture across it (grassy ragged edges
// painted in), its outer edge feathered into the grass with a little jitter.
function roadMesh(curve, hw, fade) {
  const L = curve.getLength(), N = Math.ceil(L / 0.7), P = curve.getSpacedPoints(N);
  const U = [0, 0.06, 0.13, 0.87, 0.94, 1], A = [0, 0.7, 1, 1, 0.7, 0];
  const rnd = rngFrom('title-road');
  const pos = [], uv = [], col = [], nor = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const p = P[i], a = P[Math.max(0, i - 1)], b = P[Math.min(N, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z, tl = Math.hypot(tx, tz) || 1, nx = tz / tl, nz = -tx / tl;
    for (let k = 0; k < U.length; k++) {
      const u = U[k] + (k === 1 ? 1 : k === 4 ? -1 : 0) * (rnd() - 0.3) * 0.05;
      const off = (u - 0.5) * 2 * hw;
      pos.push(p.x + nx * off, 0.015, p.z + nz * off);
      uv.push(u, i * (L / N) / (2 * hw));
      nor.push(0, 1, 0);
      col.push(1, 1, 1, A[k] * (k === 1 || k === 4 ? 0.5 + rnd() * 0.5 : 1));
    }
  }
  for (let i = 0; i < N; i++) for (let k = 0; k < U.length - 1; k++) {
    const a = i * U.length + k, b = a + U.length;
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  const m = fadeMat({ map: tex('road_meadow'), vertexColors: true, transparent: true, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, fade);
  const mesh = new THREE.Mesh(geo, m);
  mesh.receiveShadow = true; mesh.renderOrder = 1;
  return { mesh, P };
}

// Grass tufts and flowers from the terrain's clutter atlas (4 x 2 cells of 256 px): three
// crossed quads each, normals up so they light like the ground. Transparent texels take
// their cell's average color so the mipmaps don't grow dark fringes.
function clutterTexture() {
  const cv = canvasFor('clutter_meadow'), w = cv.width, h = cv.height;
  const src = cv.getContext('2d').getImageData(0, 0, w, h).data, out = new Uint8Array(w * h * 4);
  const CX = Math.round(w / 256), CY = Math.round(h / 256), avg = [];
  for (let cy = 0; cy < CY; cy++) for (let cx = 0; cx < CX; cx++) {
    let r = 0, gg = 0, b = 0, n = 0;
    for (let y = cy * 256; y < (cy + 1) * 256; y += 2) for (let x = cx * 256; x < (cx + 1) * 256; x += 2) { const k = (y * w + x) * 4; if (src[k + 3] > 200) { r += src[k]; gg += src[k + 1]; b += src[k + 2]; n++; } }
    avg.push(n ? [r / n, gg / n, b / n] : [90, 110, 60]);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const k = (y * w + x) * 4, o = ((h - 1 - y) * w + x) * 4, a = src[k + 3];
    const c = a < 24 ? avg[Math.floor(y / 256) * CX + Math.floor(x / 256)] : [src[k], src[k + 1], src[k + 2]];
    out[o] = c[0]; out[o + 1] = c[1]; out[o + 2] = c[2]; out[o + 3] = a;
  }
  const t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
function clutterMesh(spots, map) {
  const pos = [], uv = [], nor = [], idx = [];
  for (const { x, z, s, cell, rot } of spots) {
    const cx = cell % 4, cy = Math.floor(cell / 4), u0 = cx / 4, u1 = (cx + 1) / 4, vb = 1 - (cy + 1) / 2, vt = 1 - cy / 2;
    for (let q = 0; q < 3; q++) {
      const a = rot + q * Math.PI / 3, c = Math.cos(a) * 0.5 * s, sn = Math.sin(a) * 0.5 * s, b = pos.length / 3;
      pos.push(x - c, 0, z - sn, x + c, 0, z + sn, x + c, s, z + sn, x - c, s, z - sn);
      uv.push(u0, vb, u1, vb, u1, vt, u0, vt);
      for (let k = 0; k < 4; k++) nor.push(0, 1, 0);
      idx.push(b, b + 1, b + 2, b, b + 2, b + 3, b, b + 2, b + 1, b, b + 3, b + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const m = new THREE.MeshLambertMaterial({ map, alphaTest: 0.42 });
  m.alphaToCoverage = true;
  const mesh = new THREE.Mesh(geo, m);
  mesh.receiveShadow = true;
  return mesh;
}

// A crossroads signpost: an oak post, two arrow boards with the names cut into the wood.
function signBoard(text, dir) {
  const W = 512, H = 112, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d'), rnd = rngFrom('sign' + text);
  const tip = dir > 0 ? [[W - 70, 6], [W - 4, H / 2], [W - 70, H - 6]] : [[70, H - 6], [4, H / 2], [70, 6]];
  const p = new Path2D();
  if (dir > 0) { p.moveTo(4, 8); p.lineTo(...tip[0]); p.lineTo(...tip[1]); p.lineTo(...tip[2]); p.lineTo(4, H - 8); }
  else { p.moveTo(W - 4, 8); p.lineTo(W - 4, H - 8); p.lineTo(...tip[0]); p.lineTo(...tip[1]); p.lineTo(...tip[2]); }
  p.closePath();
  g.save(); g.clip(p);
  try { g.fillStyle = g.createPattern(canvasFor('board_rough'), 'repeat'); } catch { g.fillStyle = '#8a5f36'; }
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(150,96,48,0.35)'; g.fillRect(0, 0, W, H);
  const sh = g.createLinearGradient(0, 0, 0, H);
  sh.addColorStop(0, 'rgba(255,226,170,0.3)'); sh.addColorStop(0.5, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(30,14,4,0.45)');
  g.fillStyle = sh; g.fillRect(0, 0, W, H);
  g.restore();
  g.lineWidth = 6; g.strokeStyle = 'rgba(40,22,10,0.85)'; g.stroke(p);
  g.lineWidth = 2; g.strokeStyle = 'rgba(255,214,150,0.35)'; g.save(); g.translate(0, 2); g.stroke(p); g.restore();
  g.font = `bold 58px ${TITLE_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
  let size = 58; while (g.measureText(text).width > W - 150 && size > 30) { size -= 2; g.font = `bold ${size}px ${TITLE_FONT}`; }
  const tx = dir > 0 ? (W - 66) / 2 : W / 2 + 33, ty = H / 2 + 3;
  g.fillStyle = 'rgba(20,10,4,0.8)'; g.fillText(text, tx - 2, ty - 2);
  g.fillStyle = 'rgba(255,226,170,0.45)'; g.fillText(text, tx + 1.5, ty + 1.5);
  g.fillStyle = '#f0d9a8'; g.fillText(text, tx, ty);
  for (const nx of dir > 0 ? [26] : [W - 26]) { g.fillStyle = '#2a2420'; g.beginPath(); g.arc(nx, H / 2, 6, 0, Math.PI * 2); g.fill(); g.fillStyle = '#9a9aa0'; g.beginPath(); g.arc(nx - 1.5, H / 2 - 1.5, 2.2, 0, Math.PI * 2); g.fill(); }
  for (let i = 0; i < 6; i++) { g.fillStyle = `rgba(60,90,40,${0.2 + rnd() * 0.2})`; g.beginPath(); g.ellipse(rnd() * W, H - 8 - rnd() * 10, 6 + rnd() * 16, 3 + rnd() * 4, 0, 0, Math.PI * 2); g.fill(); }
  const t = canvasTex(cv);
  const shape = new THREE.Shape();
  const pts = dir > 0 ? [[0, 0.07], [0.86, 0.05], [1, 0.5], [0.86, 0.95], [0, 0.93]] : [[1, 0.07], [1, 0.93], [0.14, 0.95], [0, 0.5], [0.14, 0.05]];
  pts.forEach(([x, y], i) => (i ? shape.lineTo(x, y) : shape.moveTo(x, y)));
  const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false });
  geo.scale(1.55, 0.34, 1);
  return new THREE.Mesh(geo, [new THREE.MeshLambertMaterial({ map: t }), painted('timber_dark')]);
}
function signpost(x, z, ry) {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.1, 2.7, 8), painted('bark_oak', { repeat: [1, 2] }));
  post.position.y = 1.35;
  const cap = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.16, 8), painted('timber_dark'));
  cap.position.y = 2.78;
  const a = signBoard('GOLDSHIRE', -1); a.position.set(-1.62, 2.2, 0.08);
  const b = signBoard('LOST WAGES', 1); b.position.set(0.04, 1.72, 0.08); b.rotation.y = 0.28;
  g.add(post, cap, a, b);
  g.position.set(x, 0, z); g.rotation.y = ry;
  g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return g;
}

function dustTexture() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const g = cv.getContext('2d'), gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return canvasTex(cv);
}

// Builds and renders the diorama at W x H; resolves to a canvas with a transparent sky.
async function renderDiorama(W, H) {
  const dbg = s => { (window.__dio ||= []).push(s + ' ' + Math.round(performance.now())); };
  dbg('start');
  const [nat, rvm] = await Promise.all([import('./nature3d.js'), import('./rv3d.js')]);
  if (!menuShown()) return null;
  dbg('imported');
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(DIO.fog, DIO.fogNear, DIO.fogFar);
  scene.add(new THREE.HemisphereLight(DIO.sky, DIO.gnd, DIO.hemiI));
  const sunDir = new THREE.Vector3(...DIO.sun).normalize();
  const sun = new THREE.DirectionalLight(DIO.sunC, DIO.sunI);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: 1, far: 220 });
  sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.04;
  if ('intensity' in sun.shadow) sun.shadow.intensity = 0.62;
  const focus = new THREE.Vector3(-3, 0, -24);
  sun.position.copy(focus).addScaledVector(sunDir, 100); sun.target.position.copy(focus);
  scene.add(sun, sun.target);

  const curve = new THREE.CatmullRomCurve3(DIO.road.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600).rotateX(-Math.PI / 2), groundMat(tex('ground_meadow'), 7, 11.3, DIO.fade));
  ground.position.z = -600; ground.receiveShadow = true;
  scene.add(ground);
  const { mesh: road, P } = roadMesh(curve, 4.7, DIO.fade);
  scene.add(road);
  dbg('ground');
  await tick();

  // the road's x at a given z, and the distance off it
  const rx = z => { for (let i = 1; i < P.length; i++) if (P[i].z <= z) { const t = (z - P[i - 1].z) / ((P[i].z - P[i - 1].z) || 1); return P[i - 1].x + (P[i].x - P[i - 1].x) * t; } return 0; };
  const rnd = rngFrom('title-diorama');
  const R = (a, b) => a + (b - a) * rnd();

  // the nature: the framing oak, pines on the right, oaks and pines further off, rocks, bushes, a fence
  const decor = [
    { k: 'oak', x: -6.2, z: -14.5, s: 1.45, ry: 2.2 },
    { k: 'pine', x: 5.6, z: -10.5, s: 1.55, ry: 0.4 },
    { k: 'pine', x: 8.6, z: -21, s: 1.25, ry: 1.9 },
    { k: 'pine', x: 13.5, z: -33, s: 1.1, ry: 3.1 },
    { k: 'pine', x: 4.6, z: -46, s: 1.0, ry: 0.8 },
    { k: 'oak', x: 16, z: -62, s: 1.2, ry: 0.5 },
    { k: 'oak', x: -24, z: -70, s: 1.3, ry: 4.1 },
    { k: 'pine', x: -19, z: -54, s: 1.05, ry: 2.6 },
    { k: 'pine', x: -30, z: -96, s: 1.2, ry: 1.1 },
    { k: 'oak', x: 26, z: -110, s: 1.4, ry: 5.2 },
    { k: 'rock', x: 4.4, z: -17.5, s: 1.5, ry: 0.6 },
    { k: 'rock', x: -3.6, z: -10.6, s: 0.8, ry: 2.2 },
    { k: 'rock', x: -15, z: -34, s: 1.8, ry: 1.4 },
    { k: 'rock', x: 9.5, z: -40, s: 1.3, ry: 4.4 },
    { k: 'bush', x: -4.4, z: -18, s: 1.0, ry: 0.3 },
    { k: 'bush', x: 3.2, z: -13, s: 0.9, ry: 1.3 },
    { k: 'bush', x: -14, z: -26, s: 1.1, ry: 2.2 },
    { k: 'bush', x: 2.6, z: -30, s: 1.0, ry: 0.9 },
    { k: 'stump', x: -8.4, z: -21.5, s: 1.0, ry: 0.7 },
    { k: 'fence', x: 4.3, z: -24, len: 6, ry: 1.25 },
    { k: 'fence', x: 2.4, z: -33, len: 6, ry: 1.0 },
  ];
  const nature = nat.buildNature({ biome: 'meadow', decor: decor.map(d => ({ y: 0, ...d })), cyls: [], anchors: [], heightAt: () => 0 });
  nature.update?.(0.016, 1.3, new THREE.Vector3(0, DIO.eye, 0));
  scene.add(nature.group);
  dbg('nature');
  await tick();
  if (!menuShown()) return null;

  // the RV, coming down the road toward us
  const rv = rvm.PREVIEW.rv();
  const u = (() => { let best = 0, bd = 1e9; for (let i = 0; i <= 200; i++) { const p = curve.getPointAt(i / 200); const d = Math.abs(p.z - DIO.rvZ); if (d < bd) { bd = d; best = i / 200; } } return best; })();
  const at = curve.getPointAt(u), tg = curve.getTangentAt(u);
  rv.position.set(at.x, 0, at.z);
  rv.rotation.y = Math.atan2(-tg.x, -tg.z);       // the curve runs away from us; the RV faces back down it
  scene.add(rv);
  // dust kicked up behind it, back along the road
  const dmap = dustTexture();
  for (let i = 0; i < 9; i++) {
    const p = curve.getPointAt(Math.max(0, u - 0.004 - i * 0.0035));
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dmap, color: i % 2 ? '#e8d2a6' : '#d9bf94', transparent: true, opacity: 0.32 - i * 0.022, depthWrite: false, fog: true }));
    const s = 2.4 + i * 0.7;
    sp.position.set(p.x + R(-0.8, 0.8), s * 0.32, p.z);
    sp.scale.set(s * 1.5, s, 1);
    sp.renderOrder = 3;
    scene.add(sp);
  }
  scene.add(signpost(4.6, -14.2, -0.35));
  dbg('rv');
  await tick();
  if (!menuShown()) return null;

  // tufts: thick along the road's ragged edges, scattered over the fields, denser near us
  const spots = [];
  for (let i = 0; i < 1500; i++) {
    const z = -Math.exp(R(Math.log(6), Math.log(90)));
    const x = R(-1, 1) * (0.6 * -z + 3);
    const d = Math.abs(x - rx(z));
    if (d < 3.4) continue;
    const verge = d < 5.6;
    if (!verge && rnd() < 0.45) continue;
    const r = rnd(), cell = verge ? (r < 0.4 ? 0 : r < 0.7 ? 6 : r < 0.85 ? 1 : 4) : (r < 0.3 ? 0 : r < 0.5 ? 1 : r < 0.62 ? 4 : r < 0.72 ? 6 : r < 0.8 ? 5 : r < 0.88 ? 7 : r < 0.95 ? 2 : 3);
    spots.push({ x, z, s: R(0.5, 0.95) * (cell === 4 ? 1.25 : 1), cell, rot: R(0, Math.PI) });
  }
  scene.add(clutterMesh(spots, clutterTexture()));

  scene.traverse(o => { if (o.isMesh && o !== ground && o !== road) { o.castShadow = true; o.receiveShadow = true; } });
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
  try {
    r.setPixelRatio(1); r.setSize(W, H, false);
    r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
    r.setClearColor(0x000000, 0);
    const fullH = H * 2 * DIO.hz;
    const cam = new THREE.PerspectiveCamera(DIO.fov, W / fullH, 0.1, 1500);
    cam.setViewOffset(W, fullH, 0, 0, W, H);
    cam.position.set(0, DIO.eye, 0); cam.lookAt(0, DIO.eye, -10);
    cam.updateMatrixWorld();
    dbg('compile');
    await r.compileAsync?.(scene, cam).catch(() => {});
    dbg('compiled');
    if (!menuShown()) return null;
    r.render(scene, cam);
    dbg('rendered');
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    out.getContext('2d').drawImage(cv, 0, 0);
    // where the RV sits on screen, for the painted dust and light around it
    const v = new THREE.Vector3(at.x, 1.6, at.z).project(cam);
    out.rv = [(v.x + 1) / 2 * W, (1 - v.y) / 2 * H];
    return out;
  } finally {
    r.dispose(); r.forceContextLoss();
  }
}

// The title, in stages so the menu stays responsive: the painted backdrop (a stage per
// task), the diorama, the finishing glaze; published once. 1280 x 720, or 1600 x 900 on
// big screens (the backdrop is painted at 1280 and scaled; the diorama renders at size).
async function paintMenu() {
  const big = (window.devicePixelRatio || 1) * window.innerWidth > 1400;
  const W = big ? 1600 : 1280, H = big ? 900 : 720;
  const bw = 1280, bh = 720;
  const back = document.createElement('canvas');
  back.width = bw; back.height = bh;
  const bg = back.getContext('2d');
  bg.fillStyle = '#7f7f7f'; bg.fillRect(0, 0, bw, bh);
  const rnd = rngFrom('ui_menu_bg');
  let full = false;
  const run = async it => {
    for (;;) {
      const t0 = performance.now();
      let r;
      do { r = it.next(); } while (!r.done && performance.now() - t0 < 12);
      if (r.done) return;
      await tick();
    }
  };
  await run(paintVista(bg, bw, bh, rnd, { full: false }));
  let dio = null;
  try { dio = await renderDiorama(W, H); }
  catch (e) { console.warn('ui skin: title diorama unavailable, painting it instead:', e.message); }
  if (!dio) {
    if (!menuShown()) return;
    full = true;
    const it = paintVista(bg, bw, bh, rngFrom('ui_menu_bg'), { full: true });
    await run(it);
  }
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.drawImage(back, 0, 0, W, H);
  if (dio) {
    g.drawImage(dio, 0, 0);
    g.save(); g.scale(W / bw, H / bh); finishVista(g, bw, bh, rngFrom('ui_menu_finish')); g.restore();
  }
  publish('menu', cv, 'image/jpeg', () => { document.documentElement.dataset.menuArt = full ? 'painted' : 'diorama'; });
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
