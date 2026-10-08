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
//                                  Names keep a fixed size on screen (gone by 40 m);
//                                  everything else is capped, so a close one never covers a
//                                  wall; buttons name only the one nearest the crosshair.
//   zoneText(title, sub)           the big gold WoW zone text that fades in when a day starts
//   uiText(s)                      strips emoji (the WoW UI has none) and turns emote toasts into "You laugh."
//                                  main.js's toast template and the signboards run their text through it
//   portraitAttrs(color, id)       attributes for a roster portrait: the player's character, rendered
//
// Names and townsfolk titles are drawn over the world (like WoW's): a sign post, a cart or a
// tree between you and the Repo Man never slices his plate. Buildings, big solids (semis, rocks,
// junk heaps), the RV's walls (not its windows) and hills hide every name, and so does the wall
// between an interior and the street; anything in your hands covers it too (the plate is pulled
// to just past them, at the same size on screen). See "what hides a name" below.
//
// On import this module also (1) waits for the vendored fonts and redraws any
// sprite drawn before they arrived, (2) paints the UI textures in paint/ui.js
// and exposes them to style.css as --tx-* custom properties, and (3) builds the title
// screen (a painted backdrop, then a lit diorama of the game's own RV, trees and
// road rendered once offscreen over it).
import * as THREE from '/vendor/three.module.js';
import { canvasTex, tex, painted } from './gfx.js';
import { canvasFor, hashStr, rngFrom } from './paint/index.js';
import { paintVista, finishVista } from './paint/ui.js';
import { RV_ART } from './paint/vehicle.js';
import { RV_DIM, toLocal, insideRV } from '/shared/rv.js';

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

// ---- the CSS skin -----------------------------------------------------------------------

// what the menu card needs first, then the title painting (in stages), then the rest
const SKIN_FIRST = [
  ['frame-gold', 'ui_frame_gold'], ['btn-red', 'ui_btn_red'], ['editbox', 'ui_editbox'], ['filigree', 'ui_filigree'], ['stone', 'ui_stone'],
];
const SKIN_REST = [
  ['parchment', 'ui_parchment'], ['wood', 'ui_wood'], ['leather', 'ui_leather'], ['bar', 'ui_bar'],
  ['trim-gold', 'ui_trim_gold'], ['frame-silver', 'ui_frame_silver'], ['btn-stone', 'ui_btn_stone'],
  ['endcap', 'ui_endcap'], ['seal', 'ui_seal'], ['ring', 'ui_ring'],
  ...['crown', 'coin', 'hourglass', 'scroll', 'hook', 'door', 'sun', 'mic', 'micoff', 'speaker', 'speakeroff', 'walkie', 'gear', 'close', 'skull', 'bolt', 'ping']
    .map(n => [`ico-${n}`, `ui_ico_${n}`]),
  ...['sun', 'hourglass', 'coin', 'scroll', 'hook', 'door', 'mic', 'micoff', 'speaker', 'speakeroff', 'gear', 'close', 'walkie']
    .map(n => [`slot-${n}`, `ui_slot_${n}`]),
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
  fov: 36, eye: 3.4, hz: 0.6,
  sun: [-0.5, 0.56, 0.66], sunC: '#ffd08e', sunI: 2.2, sky: '#efe2c6', gnd: '#6a7a42', hemiI: 1.8,
  fog: '#bcc09c', fogNear: 60, fogFar: 520, fade: [80, 230],
  road: [[0.4, 8], [0.9, -4], [1.4, -14], [0.6, -21], [-1.6, -26.5], [-5, -31.5], [-9.4, -35.4], [-14.2, -39.4], [-18.2, -45.5], [-19, -55], [-15.6, -70], [-9, -90], [-3, -120], [0.6, -170], [0, -260], [-1, -420], [0, -800]],
  rvZ: -35.4,
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
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  const m = fadeMat({ map: tex('road_meadow'), vertexColors: true, transparent: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }, fade);
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
  const [nat, rvm, ppl] = await Promise.all([import('./nature3d.js'), import('./rv3d.js'), import('./people.js').catch(() => null)]);
  if (!menuShown()) return null;
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
  await tick();

  // the road's x at a given z, and the distance off it
  const rx = z => { for (let i = 1; i < P.length; i++) if (P[i].z <= z) { const t = (z - P[i - 1].z) / ((P[i].z - P[i - 1].z) || 1); return P[i - 1].x + (P[i].x - P[i - 1].x) * t; } return 0; };
  const rnd = rngFrom('title-diorama');
  const R = (a, b) => a + (b - a) * rnd();

  // the nature: the framing oak, pines on the right, oaks and pines further off, rocks, bushes, a fence
  const decor = [
    { k: 'oak', x: -6.4, z: -14.2, s: 1.0, ry: 2.6 },
    { k: 'pine', x: 9.4, z: -17.5, s: 1.2, ry: 0.4 },
    { k: 'pine', x: 10.6, z: -28, s: 1.1, ry: 1.9 },
    { k: 'pine', x: 15, z: -40, s: 1.15, ry: 3.1 },
    { k: 'pine', x: 7.2, z: -52, s: 0.9, ry: 0.8 },
    { k: 'oak', x: 21, z: -66, s: 1.15, ry: 0.5 },
    { k: 'oak', x: -30, z: -66, s: 1.25, ry: 4.1 },
    { k: 'pine', x: -26, z: -48, s: 1.05, ry: 2.6 },
    { k: 'pine', x: -34, z: -92, s: 1.2, ry: 1.1 },
    { k: 'oak', x: 30, z: -112, s: 1.4, ry: 5.2 },
    { k: 'oak', x: -6, z: -150, s: 1.3, ry: 2.2 },
    { k: 'rock', x: 7.6, z: -29, s: 1.7, ry: 0.6 },
    { k: 'rock', x: -5.2, z: -12.6, s: 0.7, ry: 2.2 },
    { k: 'rock', x: -21, z: -36, s: 1.6, ry: 1.4 },
    { k: 'rock', x: 12.5, z: -46, s: 1.3, ry: 4.4 },
    { k: 'bush', x: -3.8, z: -17.6, s: 0.9, ry: 0.3 },
    { k: 'bush', x: 4.4, z: -14, s: 0.9, ry: 1.3 },
    { k: 'bush', x: -12.5, z: -30, s: 1.1, ry: 2.2 },
    { k: 'bush', x: 5.4, z: -36, s: 1.0, ry: 0.9 },
    { k: 'stump', x: -9.6, z: -22.5, s: 1.0, ry: 0.7 },
    { k: 'fence', x: 4.6, z: -20.5, len: 6, ry: 1.35 },
    { k: 'fence', x: 4.0, z: -27, len: 6, ry: 1.05 },
  ];
  // a forest edge across the far fields, thinning toward the road
  for (let i = 0; i < 40; i++) {
    const side = i % 2 ? 1 : -1, z = -R(100, 240), x = rx(z) + side * R(0.1, 0.55) * -z;
    if (Math.abs(x - rx(z)) < 12) continue;
    decor.push({ k: rnd() < 0.55 ? 'oak' : 'pine', x, z, s: R(1.0, 1.5), ry: R(0, 6.28) });
  }
  const nature = nat.buildNature({ biome: 'meadow', decor: decor.map(d => ({ y: 0, ...d })), cyls: [], anchors: [], heightAt: () => 0 });
  nature.update?.(0.016, 1.3, new THREE.Vector3(0, DIO.eye, 0));
  scene.add(nature.group);
  await tick();
  if (!menuShown()) return null;

  // the RV, coming down the road toward us
  const rv = rvm.PREVIEW.rv();
  const u = (() => { let best = 0, bd = 1e9; for (let i = 0; i <= 3000; i++) { const p = curve.getPointAt(i / 3000); const d = Math.abs(p.z - DIO.rvZ); if (d < bd) { bd = d; best = i / 3000; } } return best; })();
  const at = curve.getPointAt(u), tg = curve.getTangentAt(u);
  rv.position.set(at.x, 0, at.z);
  rv.rotation.y = Math.atan2(-tg.x, -tg.z);       // the curve runs away from us; the RV faces back down it
  scene.add(rv);
  // dust kicked up behind it, back along the road
  const dmap = dustTexture();
  for (let i = 0; i < 10; i++) {
    const p = curve.getPointAt(Math.max(0, u + 0.006 + i * 0.004));
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: dmap, color: i % 2 ? '#ecd8b0' : '#d8c096', transparent: true, opacity: 0.26 - i * 0.02, depthWrite: false, fog: true }));
    const s = 1.4 + i * 0.32;
    sp.position.set(p.x + R(-0.6, 0.6), s * 0.34, p.z + R(-0.6, 0.6));
    sp.scale.set(s * 1.6, s, 1);
    sp.renderOrder = 3;
    scene.add(sp);
  }
  scene.add(signpost(5.2, -19.5, -0.5));
  // the boys: one riding on the roof, one walking alongside
  try {
    const P = ppl?.PREVIEW;
    if (P?.sitter) { const c = P.sitter(); c.position.set(0.55, 2.92, 3.55); rv.add(c); }
    if (P?.walking) { const c = P.walking(); c.position.set(-2.4, 0, 3.3); c.rotation.y = -0.1; rv.add(c); }
  } catch (e) { console.warn('title: crew', e.message); }
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
  const tufts = clutterMesh(spots, clutterTexture());
  scene.add(tufts);

  scene.traverse(o => { if (o.isMesh && o !== ground && o !== road) { o.castShadow = true; o.receiveShadow = true; } });
  tufts.castShadow = false;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const r = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true, preserveDrawingBuffer: true });
  try {
    r.setPixelRatio(1); r.setSize(W, H, false);
    r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.NoToneMapping;
    r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
    r.setClearColor(0x000000, 0);
    const fullH = H * 2 * DIO.hz;
    const cam = new THREE.PerspectiveCamera(DIO.fov, W / fullH, 0.1, 1500);
    cam.setViewOffset(W, fullH, 0, 0, W, H);
    cam.position.set(0, DIO.eye, 0); cam.lookAt(0, DIO.eye, -10);
    cam.updateMatrixWorld();
    r.compile(scene, cam);
    await tick();
    if (!menuShown()) return null;
    r.render(scene, cam);
    const out = document.createElement('canvas');
    out.width = W; out.height = H;
    out.getContext('2d').drawImage(cv, 0, 0);
    return out;
  } finally {
    r.dispose(); r.forceContextLoss();
  }
}

// The title, in stages so the menu stays responsive: the painted backdrop (a stage per
// task; shown at once as a quiet meadow), then the diorama over it, faded in when ready.
// 1280 x 720, or 1600 x 900 on big screens (the backdrop is painted at 1280 and scaled;
// the diorama renders at size). Without WebGL, the whole scene is painted in 2D.
async function paintMenu(afterBackdrop) {
  const big = (window.devicePixelRatio || 1) * window.innerWidth > 1400;
  const W = big ? 1600 : 1280, H = big ? 900 : 720, bw = 1280, bh = 720;
  const back = document.createElement('canvas');
  back.width = bw; back.height = bh;
  const bg = back.getContext('2d');
  bg.fillStyle = '#7f7f7f'; bg.fillRect(0, 0, bw, bh);
  const run = async it => {
    for (;;) {
      const t0 = performance.now();
      let r;
      do { r = it.next(); } while (!r.done && performance.now() - t0 < 12);
      if (r.done) return;
      await tick();
    }
  };
  const finish = (src, scale) => {
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const g = cv.getContext('2d');
    g.drawImage(back, 0, 0, W, H);
    if (src) g.drawImage(src, 0, 0);
    g.save(); g.scale(W / bw, H / bh); finishVista(g, bw, bh, rngFrom('ui_menu_finish'), { sat: scale }); g.restore();
    return cv;
  };
  await run(paintVista(bg, bw, bh, rngFrom('ui_menu_bg'), { full: false }));
  let dio = null, err = null;
  // ?title=painted skips the diorama (to check the all-2D fallback)
  const painted2d = new URLSearchParams(location.search).get('title') === 'painted';
  const pending = painted2d ? Promise.resolve(null) : renderDiorama(W, H).catch(e => { err = e; return null; });
  await tick();
  publish('menu', finish(null, 0.14), 'image/jpeg');
  afterBackdrop?.();
  dio = await pending;
  if (dio) {
    publish('menu-final', finish(dio, 0.05), 'image/jpeg', () => {
      document.getElementById('menu')?.classList.add('art-final');
      document.documentElement.dataset.menuArt = 'diorama';
    });
    return;
  }
  if (!menuShown()) return;
  if (err) console.warn('ui skin: title diorama unavailable, painting it instead:', err.message);
  await run(paintVista(bg, bw, bh, rngFrom('ui_menu_bg'), { full: true }));
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  cv.getContext('2d').drawImage(back, 0, 0, W, H);
  publish('menu-final', cv, 'image/jpeg', () => {
    document.getElementById('menu')?.classList.add('art-final');
    document.documentElement.dataset.menuArt = 'painted';
  });
}

if (typeof document !== 'undefined' && document.getElementById('game')) {
  // the menu card's pieces, the title's backdrop, then the in-game skin (while the diorama builds)
  let rest = false;
  const paintRest = () => { if (!rest) { rest = true; paintList(SKIN_REST); } };
  paintList(SKIN_FIRST, () => paintMenu(paintRest).catch(e => console.warn('ui skin: menu', e.message)).finally(paintRest));
}

// ---- party portraits ------------------------------------------------------------------------
//
// WoW unit-frame portraits: each player's real character (people.js), head and shoulders,
// rendered once in a small offscreen WebGL canvas over a dark vignette in their color, and
// cached as a data URL. portraitAttrs(color, id) gives the roster's portrait element its
// attributes; until the picture is ready the frame shows the player's initial.
const PORTRAITS = new Map();      // key -> data URL, '' while pending or if it failed
const portraitJobs = [];
let portraitBusy = false;
export function portraitAttrs(color, id) {
  const key = `${id}|${color}`;
  if (!PORTRAITS.has(key)) { PORTRAITS.set(key, ''); portraitJobs.push({ key, color, id }); setTimeout(pumpPortraits, 0); }
  const url = PORTRAITS.get(key);
  return ` data-pk="${key}"` + (url ? ` data-pic="1" style="--pic:url(${url})"` : '');
}
async function pumpPortraits() {
  if (portraitBusy || !portraitJobs.length) return;
  portraitBusy = true;
  let r = null;
  try {
    const ppl = await import('./people.js');
    while (portraitJobs.length) {
      await new Promise(res => (window.requestIdleCallback || (f => setTimeout(f, 30)))(res, { timeout: 1500 }));
      const job = portraitJobs.shift();
      try {
        r ||= new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, alpha: true, preserveDrawingBuffer: true });
        const url = renderPortrait(r, ppl, job);
        PORTRAITS.set(job.key, url);
        for (const el of document.querySelectorAll('.pf[data-pk]')) if (el.dataset.pk === job.key) { el.style.setProperty('--pic', `url(${url})`); el.dataset.pic = '1'; }
      } catch (e) { console.warn('portrait:', e.message); }
    }
  } catch (e) { console.warn('portraits unavailable:', e.message); }
  finally {
    if (r) { r.dispose(); r.forceContextLoss(); }
    portraitBusy = false;
    if (portraitJobs.length) setTimeout(pumpPortraits, 0);
  }
}
function renderPortrait(r, ppl, { color, id }) {
  const S = 96;
  r.setPixelRatio(1); r.setSize(S, S, false);
  r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.NoToneMapping; r.setClearColor(0x000000, 0);
  const ch = ppl.buildCharacter(color, { hatIndex: id % 6, skinIndex: (id * 7) % 6, variant: id % 6 });
  ch.driven = true;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight('#f0e4cc', '#4a3a2a', 1.7));
  const key = new THREE.DirectionalLight('#ffe2b4', 2.3); key.position.set(-1.4, 1.6, 2.2); scene.add(key);
  const back = new THREE.DirectionalLight('#9ab0ff', 1.1); back.position.set(1.6, 0.9, -1.6); scene.add(back);
  scene.add(ch.root);
  ch.root.updateMatrixWorld(true);
  const head = new THREE.Vector3();
  ch.head.getWorldPosition(head);
  const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  const look = head.clone().add(new THREE.Vector3(0, 0.03, 0));
  cam.position.copy(look).add(new THREE.Vector3(0.32, 0.06, 0.95));
  cam.lookAt(look);
  r.render(scene, cam);
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const bg = g.createRadialGradient(S * 0.45, S * 0.4, 4, S / 2, S / 2, S * 0.62);
  const [cr, cg, cb] = hexRgb(soft(color));
  bg.addColorStop(0, `rgb(${cr * 0.35 + 40},${cg * 0.35 + 30},${cb * 0.35 + 24})`); bg.addColorStop(1, '#0c0806');
  g.fillStyle = bg; g.fillRect(0, 0, S, S);
  g.drawImage(r.domElement, 0, 0);
  return cv.toDataURL('image/png');
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
// player names: the player's own hue as a strong WoW class colour (full and light, not washed
// toward cream), so a friend's name reads at a glance on snow, sand and grass; blues and violets
// look darker at the same lightness, so they get a lift. A grey or white stays white.
function classColor(c) {
  const [r, g, b] = hexRgb(soft(c)).map(v => v / 255);
  const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b);
  if (d < 0.08) return '#ffffff';
  const h = 60 * (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4);
  const s = 0.82, l = h > 200 && h < 300 ? 0.68 : 0.6;
  const C = (1 - Math.abs(2 * l - 1)) * s, X = C * (1 - Math.abs((h / 60) % 2 - 1)), m = l - C / 2;
  const [R, G, B] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return toHex((R + m) * 255, (G + m) * 255, (B + m) * 255);
}
const lighter = (c, k) => { const [r, g, b] = hexRgb(c); return toHex(r + (255 - r) * k, g + (255 - g) * k, b + (255 - b) * k); };

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

// WoW nameplate lettering: a soft dark halo, one dark outline, then the fill.
function outlined(g, text, x, y, fill, size) {
  const ow = Math.max(3.5, size * 0.11);
  g.lineJoin = 'round'; g.miterLimit = 2;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.45)'; g.shadowBlur = 4; g.shadowOffsetY = 1;
  g.lineWidth = ow; g.strokeStyle = 'rgba(6,4,3,0.92)'; g.strokeText(text, x, y);
  g.restore();
  g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillText(text, x + Math.max(1, size * 0.03), y + Math.max(1, size * 0.03));
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
  return (g.measureText(text).width + size * 0.25) / W;     // the lettering's share of the width (with its outline)
}
function drawNpcPlate(g, W, H, name, title, color) {
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const s1 = fitFont(g, name, 58, W - 24);
  outlined(g, name, W / 2, H * 0.32, color, s1);
  const w1 = g.measureText(name).width + s1 * 0.25;
  const s2 = fitFont(g, title, Math.round(s1 * 0.82), W - 24);
  outlined(g, title, W / 2, H * 0.76, lighter(color, 0.1), s2);
  return Math.max(w1, g.measureText(title).width + s2 * 0.25) / W;
}

function drawIcon(g, W, H, name) {
  // the sprites that carry icons are shown at 2:1, so pre-stretch to keep them round
  const img = canvasFor(name);
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.5)'; g.shadowBlur = 6; g.shadowOffsetY = 2;
  g.drawImage(img, W / 2 - H * (W / H) / 4, 0, H * (W / H) / 2, H);
  g.restore();
}

// Names (players and townsfolk) keep a fixed size on screen like WoW's: the sprite's
// height in px at 720p (scaled with the window), fading out between 32 and 40 m.
// Everything else scales with distance but is capped (CSS px) so a close one never
// covers a wall. Clickable buttons show one name at a time: the one nearest the
// crosshair within reach (the [E] prompt names the rest).
const FIXED = { name: 30, npc: 44 };     // a friend's name at 16 px, a townsman's at 15 px over his title
const CAP = { icon: 64, combat: 64, button: 34, placard: 50 };
const NAME_FADE = [32, 40], BTN_REACH = 2.6;
const BTN = { frame: -1, best: null, ang: Infinity, prev: null };
const _p = new THREE.Vector3(), _c = new THREE.Vector3(), _f = new THREE.Vector3(), _q = new THREE.Vector3(), _sz = new THREE.Vector2();
// Names (players, townsfolk) draw over the world like WoW's: each frame the plate is moved to
// PULL m from the eye along its own sight line and shrunk to match, so it covers the same
// pixels but sits in front of every post, sign, cart and tree; the first-person hands and the
// held map (nearer than that) still cover it. What the plate can't see through is tested below.
const PULL = 0.7, PLATE_ORDER = 10;

// ---- what hides a name ----------------------------------------------------------------------
//
// Each plate re-tests the line from the eye to it every SIGHT_MS (staggered across plates; the
// first test of a plate coming into range is immediate) and fades out over ~0.2 s when it crosses:
//   an interior   you and he aren't in the same walk-in building: you in the casino, he out front;
//                 you on the street, Ed behind his counter. In the same room a name always shows.
//   a building    its walls (and timber's jettied upper storey) to the eaves, then a hipped roof
//                 volume per town style (steep gables, low shed roofs and false fronts, flat adobe)
//   a big solid   semis, parked RVs, junk heaps, the dino, rock ledges, hoodoos, desert mounds,
//                 the arch's lintel and the lookout tower (world.js statics and rocks over 1.2 m)
//   the RV        its walls, but not its windows, an open or missing door or a missing roof: the
//                 Repo Man's plate shows through the windshield as you drive into town
//   a hill        the heightfield
// Trees, posts, signs, carts, fences and lamps never hide a name (WoW draws over them). Nothing
// past NAME_FADE shows, and a name sliding off the edge of the screen fades instead of being cut.
const SIGHT_MS = 180;
let plateSeq = 0;
const terrainHides = (W, c, p, d) => {
  const n = Math.min(24, Math.max(7, Math.ceil(d / 2)));
  for (let i = 1; i < n; i++) {
    const t = i / n, y = c.y + (p.y - c.y) * t;
    if (W.heightAt(c.x + (p.x - c.x) * t, c.z + (p.z - c.z) * t) > y + 0.35) return true;
  }
  return false;
};
// segment a + t d (t in 0..1) against an axis-aligned box: on a hit, T0..T1 is the part inside and
// A0 / A1 the axes (0 x, 1 y, 2 z) it enters and leaves by (-1: that end is already inside)
let T0 = 0, T1 = 1, A0 = -1, A1 = -1;
function axisClip(a, p, d, lo, hi) {
  if (Math.abs(d) < 1e-9) return p >= lo && p <= hi;
  let u = (lo - p) / d, v = (hi - p) / d;
  if (u > v) { const w = u; u = v; v = w; }
  if (u > T0) { T0 = u; A0 = a; }
  if (v < T1) { T1 = v; A1 = a; }
  return T0 <= T1;
}
function slab(ax, ay, az, dx, dy, dz, x0, x1, y0, y1, z0, z1) {
  T0 = 0; T1 = 1; A0 = -1; A1 = -1;
  return axisClip(0, ax, dx, x0, x1) && axisClip(1, ay, dy, y0, y1) && axisClip(2, az, dz, z0, z1);
}
// squared distance (xz) from a point to the segment
function seg2(px, pz, ax, az, dx, dz) {
  const L = dx * dx + dz * dz;
  let t = L > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = ax + dx * t - px, ez = az + dz * t - pz;
  return ex * ex + ez * ez;
}
// a rock: an upright cylinder
function cylHit(o, ax, ay, az, dx, dy, dz) {
  const fx = ax - o.x, fz = az - o.z, A = dx * dx + dz * dz, B = fx * dx + fz * dz, C = fx * fx + fz * fz - o.r * o.r;
  let ta = 0, tb = 1;
  if (A < 1e-9) { if (C > 0) return false; } else {
    const disc = B * B - A * C;
    if (disc <= 0) return false;
    const sq = Math.sqrt(disc);
    ta = Math.max(0, (-B - sq) / A); tb = Math.min(1, (-B + sq) / A);
    if (ta > tb) return false;
  }
  const ya = ay + dy * ta, yb = ay + dy * tb;
  return Math.min(ya, yb) < o.y1 && Math.max(ya, yb) > o.y0;
}

// What stands over a building's walls, per town style (town_build.js STYLES): timber's jettied upper
// storey (1.7 m, 0.34 m out), what rises straight over the eaves (frontier false fronts, adobe
// parapets) and the ridge (its rise capped at tp x the half span, as the pitch does).
const ROOF = {
  timber: { up: 1.7, out: 0.34, top: 0, rise: 5, tp: 1.03 },
  farm: { up: 0, out: 0, top: 0, rise: 5.2, tp: 1.19 },
  alpine: { up: 0, out: 0, top: 0, rise: 5.2, tp: 1.03 },
  frontier: { up: 0, out: 0, top: 1.2, rise: 1.6, tp: 0.34 },
  adobe: { up: 0, out: 0, top: 0.6, rise: 0, tp: 0 },
};
// the leg's occluders, built once per world: k 1 a building, 0 a box, 2 a rock; br bounds them in xz
const OCC = new WeakMap();
function occluders(W) {
  let L = OCC.get(W);
  if (L) return L;
  L = [];
  const B = W.buildings || [];
  for (const b of B) {
    const R = ROOF[b.style] || ROOF.timber;
    const hx = b.w / 2 + 0.15 + R.out, hz = b.dep / 2 + 0.15 + R.out;
    const y1 = b.y + b.h + R.up * (b.h > 4.5 ? 1.12 : 1) + R.top, rise = Math.min(R.rise, R.tp * Math.min(hx, hz));
    L.push({ k: 1, x: b.x, z: b.z, c: Math.cos(b.ry), s: Math.sin(b.ry), hx, hz, y0: b.y - 0.6, y1, rise, ex: hx + 0.5, ez: hz + 0.5, br: Math.hypot(hx, hz) + 0.8 });
  }
  const inside = (x, z) => B.some(b => {
    const dx = x - b.x, dz = z - b.z, c = Math.cos(b.ry), s = Math.sin(b.ry);
    return Math.abs(dx * c - dz * s) < b.w / 2 + 0.3 && Math.abs(dx * s + dz * c) < b.dep / 2 + 0.3;
  });
  for (const s of W.statics || []) {
    const lintel = s.part === 'arch_span';
    if (s.bld != null || s.mat === 'floor' || s.mat === 'roof' || (s.mat === 'invisible' && !lintel)) continue;
    if (!lintel && (2 * s.hy < 1.2 || 2 * Math.max(s.hx, s.hz) < 1.2)) continue;   // crates, pumps, posts, benches
    if (inside(s.x, s.z)) continue;                                                     // a room's own furniture
    L.push({ k: 0, x: s.x, y: s.y, z: s.z, c: Math.cos(s.ry || 0), s: Math.sin(s.ry || 0), hx: s.hx, hy: s.hy, hz: s.hz, br: Math.hypot(s.hx, s.hz) });
  }
  for (const r of W.cyls || []) {
    if (r.mat !== 'rock' || 2 * r.hh < 1.2 || r.r < 0.5) continue;
    L.push({ k: 2, x: r.x, z: r.z, y0: r.y - r.hh, y1: r.y + r.hh, r: r.r * 0.85, br: r.r });
  }
  OCC.set(W, L);
  return L;
}

// The RV's hull (rv3d.js's layout): a face point is an opening if it's a window, the door while it's
// open or gone, or the top while the roof is gone. a: the face's axis (0 sides, 1 top/bottom, 2 ends).
const RV_OPEN = 0.04;
const inRect = (u, v, u0, u1, v0, v1) => u > u0 - RV_OPEN && u < u1 + RV_OPEN && v > v0 - RV_OPEN && v < v1 + RV_OPEN;
function rvOpen(S, a, sg, hx, hy, hz) {
  if (a === 1) return sg > 0 && S.parts?.roof === false;
  if (a === 2) { const w = sg > 0 ? RV_ART.shield : RV_ART.rearWin; return inRect(hx, hy, -w.x, w.x, w.y0, w.y1); }
  const D = RV_ART.door;
  if (sg < 0 && (S.door || S.parts?.doors === false) && inRect(hz, hy, D.z0, D.z1, D.y0, D.y1)) return true;
  for (const w of sg > 0 ? RV_ART.winL : RV_ART.winR) {
    if (w.r ? !w.frost && Math.hypot(hz - w.z, hy - w.y) < w.r + RV_OPEN : inRect(hz, hy, w.z0, w.z1, w.y0, w.y1)) return true;
  }
  return false;
}
// One end inside: the hull from floor to ceiling, where the line leaves it. Both outside: the body
// from its skirts to the roof, where the line goes in and where it comes out (both must be glass).
function rvHides(S, c, p) {
  const rv = S?.rv;
  if (!rv?.p || !rv.q) return false;
  const a = toLocal(rv.p, rv.q, c), b = toLocal(rv.p, rv.q, p);
  const ia = insideRV(a.x, a.y, a.z), ib = insideRV(b.x, b.y, b.z);
  if (ia && ib) return false;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, XW = RV_DIM.HALF_W - 0.05, ZL = RV_DIM.HALF_L;
  const y0 = ia || ib ? 0 : RV_ART.y0, y1 = ia || ib ? RV_DIM.WALL_H : RV_ART.y1;
  if (!slab(a.x, a.y, a.z, dx, dy, dz, -XW, XW, y0, y1, -ZL, ZL)) return false;
  const t0 = T0, t1 = T1, a0 = A0, a1 = A1;
  const open = (t, ax) => {
    if (ax < 0) return true;
    const hx = a.x + dx * t, hy = a.y + dy * t, hz = a.z + dz * t;
    return rvOpen(S, ax, ax === 0 ? Math.sign(hx) : ax === 1 ? Math.sign(hy - (y0 + y1) / 2) : Math.sign(hz), hx, hy, hz);
  };
  return !open(t0, a0) || !open(t1, a1);
}
// the walk-in building (world.js buildings: centered frames, w across, dep deep) a point is in, or -1
function buildingAt(W, p) {
  const B = W.buildings || [];
  for (let i = 0; i < B.length; i++) {
    const b = B[i], dx = p.x - b.x, dz = p.z - b.z, c = Math.cos(b.ry), s = Math.sin(b.ry);
    if (Math.abs(dx * c - dz * s) < b.w / 2 && Math.abs(dx * s + dz * c) < b.dep / 2 && p.y > b.y - 1 && p.y < b.y + b.h + 3) return i;
  }
  return -1;
}
// Is the line from the eye c to the plate at p (d apart) blocked?
function sightBlocked(S, W, c, p, d) {
  const bc = buildingAt(W, c);
  if (bc !== buildingAt(W, p)) return true;           // an interior and the world outside it
  if (bc >= 0) return false;                           // the same room
  if (rvHides(S, c, p)) return true;
  const ax = c.x, ay = c.y, az = c.z, dx = p.x - ax, dy = p.y - ay, dz = p.z - az;
  for (const o of occluders(W)) {
    if (seg2(o.x, o.z, ax, az, dx, dz) > o.br * o.br) continue;
    if (o.k === 2) { if (cylHit(o, ax, ay, az, dx, dy, dz)) return true; continue; }
    const rx = ax - o.x, rz = az - o.z;
    const lx = rx * o.c - rz * o.s, lz = rx * o.s + rz * o.c, ldx = dx * o.c - dz * o.s, ldz = dx * o.s + dz * o.c;
    if (o.k === 0) { if (slab(lx, ay - o.y, lz, ldx, dy, ldz, -o.hx, o.hx, -o.hy, o.hy, -o.hz, o.hz)) return true; continue; }
    if (slab(lx, ay, lz, ldx, dy, ldz, -o.hx, o.hx, o.y0, o.y1, -o.hz, o.hz)) return true;                // the walls
    if (o.rise > 0 && slab(lx, ay, lz, ldx, dy, ldz, -o.ex, o.ex, o.y1, o.y1 + o.rise, -o.ez, o.ez)) {     // the roof
      const ta = T0, tb = T1;
      for (let i = 0; i <= 8; i++) {
        const t = ta + (tb - ta) * i / 8, x = Math.abs(lx + ldx * t), z = Math.abs(lz + ldz * t);
        if (ay + dy * t < o.y1 + o.rise * Math.min(1 - x / o.ex, 1 - z / o.ez)) return true;
      }
    }
  }
  return d > 6 && terrainHides(W, c, p, d);
}

export function labelSprite(text, color = '#fff', px = 40) {
  const raw0 = String(text ?? '').trim();
  const npc0 = px < 40 ? NPCS[raw0] : null;          // town3d's NPC labels (players' own names never match)
  const W = 512, H = npc0 ? 168 : 96;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const tex = canvasTex(cv);
  const kind = px >= 60 ? 'icon' : px >= 42 ? 'combat' : px >= 40 ? 'name' : npc0 ? 'npc' : px >= 34 ? 'button' : 'placard';
  const plate = kind === 'name' || kind === 'npc';
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true, depthWrite: !plate, fog: false });
  if (px >= 34 && px < 40 && !npc0) mat.opacity = 0;      // buttons fade in when picked
  const sp = new THREE.Sprite(mat);
  sp.scale.set(2.4, 0.45, 1);
  if (npc0) sp.center.set(0.5, 0.1);                 // two-line plates grow upward, clear of the head
  if (plate) sp.renderOrder = PLATE_ORDER;           // after the world's other see-through things
  const draw = () => {
    const t = sp.userData.t, c = sp.userData.c;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, W, H);
    const raw = String(t ?? '').trim();
    const npc = px < 40 ? NPCS[raw] : null;
    let tw = 0;
    if (px >= 60 && ICONS[raw]) drawIcon(g, W, H, ICONS[raw]);
    else if (npc && H > 96) tw = drawNpcPlate(g, W, H, npc[0], npc[1], npc[2]);
    else {
      const str = keepText(raw);
      if (!str) { /* blank */ } else if (kind === 'placard') drawPlacard(g, W, H, str, placardColor(c));
      else if (kind === 'button') drawNameplate(g, W, H, str, soft(c) === '#f3e3b5' ? '#ffd100' : soft(c), 50);
      else if (kind === 'combat') drawNameplate(g, W, H, str, soft(c), 60);
      else tw = drawNameplate(g, W, H, str, kind === 'name' ? classColor(c) : soft(c), 52);
    }
    sp.userData.tw = tw;
    tex.needsUpdate = true;
  };
  sp.userData.set = (t, c = color) => {
    if (sp.userData.t === t && sp.userData.c === c) return;
    sp.userData.t = t; sp.userData.c = c;
    draw();
    if (!fontsReady) redrawWhenFonts.add(draw);
  };
  sp.userData.set(text, color);
  const ud = sp.userData;
  ud.vis = 1; ud.hid = false; ud.sightAt = 0; ud.jit = (plateSeq++ % 6) * 11;
  // where the lettering sits on the sprite, as fractions of its height above / below the anchor
  const UP = npc0 ? 0.76 : 0.3, DOWN = npc0 ? 0.02 : 0.3;
  sp.onBeforeRender = (renderer, scene, camera) => {
    if (plate) sp.updateMatrixWorld(true);           // the pull below only ever touches matrixWorld: start from the real spot
    if (!ud.base || sp.scale.x !== ud.lx || sp.scale.y !== ud.ly) ud.base = sp.scale.clone();
    let sx = ud.base.x, sy = kind === 'icon' ? ud.base.y : ud.base.x * H / W, alpha = 1, d = 0;
    if (camera.isPerspectiveCamera) {
      _p.setFromMatrixPosition(sp.matrixWorld);
      _c.setFromMatrixPosition(camera.matrixWorld);
      d = Math.max(0.05, _p.distanceTo(_c));
      const view = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) / (camera.zoom || 1);   // world height of the screen at d
      if (FIXED[kind]) {
        sy = FIXED[kind] / 720 * view; sx = sy * W / H;
        alpha = 1 - THREE.MathUtils.smoothstep(d, NAME_FADE[0], NAME_FADE[1]);
        const S = typeof window !== 'undefined' ? window.__nmd : null, world = S?.W;
        const now = performance.now();
        if (alpha <= 0 || typeof world?.heightAt !== 'function') ud.sightAt = 0;   // out of range: test again the moment it's back
        else if (now >= ud.sightAt) {
          const first = ud.sightAt === 0;
          ud.hid = sightBlocked(S, world, _c, _p, d);
          ud.sightAt = now + SIGHT_MS + ud.jit;
          if (first) ud.vis = ud.hid ? 0 : 1;        // coming into range behind a wall: never flash up first
        }
        const dt = ud.tVis ? Math.min(1, (now - ud.tVis) / 1000) : 1;
        ud.tVis = now;
        ud.vis += ((ud.hid ? 0 : 1) - ud.vis) * (1 - Math.exp(-dt * 12));   // ~0.2 s fades
        alpha *= ud.vis;
        if (alpha > 0.002) {
          // at the edge of the screen: fade out as the lettering reaches it instead of being cut in half
          renderer.getSize(_sz);
          _q.copy(_p).project(camera);
          const ph = FIXED[kind] / 720 * _sz.y, hw = (ud.tw || 0.3) * ph * W / H / 2;
          const x = (_q.x + 1) / 2 * _sz.x, y = (1 - _q.y) / 2 * _sz.y;
          const m = Math.min(x - hw, _sz.x - x - hw, y - ph * UP, _sz.y - y - ph * DOWN);
          alpha *= THREE.MathUtils.smoothstep(m, -8, 8);
        }
      } else {
        renderer.getSize(_sz);
        const onScreen = sy / view * _sz.y;
        if (onScreen > CAP[kind]) { const k = CAP[kind] / onScreen; sx *= k; sy *= k; }
        if (kind === 'button') {
          const fr = renderer.info.render.frame;
          if (fr !== BTN.frame) { BTN.prev = BTN.best; BTN.frame = fr; BTN.best = null; BTN.ang = Infinity; }
          camera.getWorldDirection(_f);
          const ang = _f.angleTo(_p.sub(_c));
          if (d < BTN_REACH && ang < BTN.ang) { BTN.ang = ang; BTN.best = sp; }
          alpha = BTN.prev === sp ? THREE.MathUtils.clamp((BTN_REACH - d) / 0.8, 0, 1) : 0;
        }
      }
    }
    if (kind === 'button') alpha = mat.opacity + (alpha - mat.opacity) * 0.35;
    if (Math.abs(mat.opacity - alpha) > 0.002) mat.opacity = alpha;
    if (sx !== sp.scale.x || sy !== sp.scale.y) { sp.scale.set(sx, sy, 1); sp.updateMatrixWorld(); }
    ud.lx = sp.scale.x; ud.ly = sp.scale.y;
    if (plate && d > PULL) {
      const k = PULL / d, m = sp.matrixWorld.elements;
      m[12] = _c.x + (m[12] - _c.x) * k; m[13] = _c.y + (m[13] - _c.y) * k; m[14] = _c.z + (m[14] - _c.z) * k;
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) m[i] *= k;
    }
  };
  // free the GPU texture when the sprite leaves the scene (three re-uploads it if it comes back)
  sp.addEventListener('removed', () => { tex.dispose(); mat.dispose(); redrawWhenFonts.delete(draw); });
  ud.dispose = () => { tex.dispose(); mat.dispose(); redrawWhenFonts.delete(draw); };
  return sp;
}
