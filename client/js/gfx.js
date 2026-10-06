// Renderer, camera, and the shared material helpers. The look is WoW Classic:
// hand-painted textures (client/js/paint/) on smooth-shaded chunky geometry.
// See docs/ART.md. Sky/sun/fog live in atmosphere.js; text in labels.js.
import * as THREE from '/vendor/three.module.js';
import { canvasFor, meta as texMeta } from './paint/index.js';
import { initAtmosphere } from './atmosphere.js';

export { THREE };
export { setTimeOfDay, updateSun, setBiome } from './atmosphere.js';
export { textCanvas, labelSprite } from './labels.js';
export let renderer, scene, camera;

export function canvasTex(cv, { repeat = null, nearest = false } = {}) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat[0], repeat[1]); }
  if (nearest) { t.magFilter = THREE.NearestFilter; }
  return t;
}

// A painted texture by registry name (client/js/paint/*), as a THREE texture.
// Repeats are per-clone; the image is shared.
const texBase = new Map(), texClones = new Map();
export function tex(name, rx = 1, ry = rx) {
  if (!texBase.has(name)) {
    const t = canvasTex(canvasFor(name));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    texBase.set(name, t);
  }
  if (rx === 1 && ry === 1) return texBase.get(name);
  const key = `${name}|${rx}|${ry}`;
  if (!texClones.has(key)) {
    const t = texBase.get(name).clone();
    t.repeat.set(rx, ry);
    t.needsUpdate = true;
    texClones.set(key, t);
  }
  return texClones.get(key);
}

// The standard material: smooth Lambert with a painted map.
//   painted('wood_planks', { repeat: [2, 1], tint: '#ffe0c0', alphaTest: 0.5, side: THREE.DoubleSide })
const matCache = new Map();
export function painted(name, { repeat = [1, 1], tint = null, alphaTest = 0, side = THREE.FrontSide, transparent = false, emissive = null, emissiveIntensity = 1, vertexColors = false } = {}) {
  const key = JSON.stringify([name, repeat, tint, alphaTest, side, transparent, emissive, emissiveIntensity, vertexColors]);
  if (!matCache.has(key)) {
    const m = new THREE.MeshLambertMaterial({
      map: name ? tex(name, repeat[0], repeat[1]) : null,
      color: tint || 0xffffff, alphaTest, side, transparent, vertexColors,
    });
    if (emissive) { m.emissive = new THREE.Color(emissive); m.emissiveIntensity = emissiveIntensity; if (name) m.emissiveMap = m.map; }
    matCache.set(key, m);
  }
  return matCache.get(key);
}

// Untextured smooth material (accents, small parts). Kept for older code:
// it no longer flat-shades anything.
export function flat(color, opts = {}) {
  const key = color + JSON.stringify(opts);
  if (!matCache.has(key)) {
    const { metalness, roughness, flatShading, ...rest } = opts;
    matCache.set(key, new THREE.MeshLambertMaterial({ color, ...rest }));
  }
  return matCache.get(key);
}

export function initGfx(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;     // classic look: no filmic grading
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(72, 1, 0.05, 1600);
  scene.add(camera);
  initAtmosphere(scene, camera, renderer);

  window.addEventListener('resize', resize);
  resize();
}

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

export function render() { renderer.render(scene, camera); }

// jiggle vertices for a hand-made faceted look
export function roughen(geo, amp, seed = 1) {
  const p = geo.attributes.position;
  let s = seed * 9301;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280 - 0.5; };
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(k)) seen.set(k, [rnd() * amp, rnd() * amp, rnd() * amp]);
    const d = seen.get(k);
    p.setXYZ(i, p.getX(i) + d[0], p.getY(i) + d[1], p.getZ(i) + d[2]);
  }
  geo.computeVertexNormals();
  return geo;
}

export function shadowy(obj, cast = true, receive = true) {
  obj.traverse(o => { if (o.isMesh) { o.castShadow = cast; o.receiveShadow = receive; } });
  return obj;
}
