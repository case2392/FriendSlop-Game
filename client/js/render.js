// FRIENDSLOP 3D renderer — Three.js, no assets, everything procedural.
// Flat scenes map server (x, y) to world (x, 0, z). The mountain finales map
// the same plane onto a cliff face instead: y becomes altitude.
import * as THREE from '/vendor/three.module.js';
import * as C from '/shared/constants.js';
import { sfx } from './sfx.js';

export const blobs = new Map(); // id -> logical state {x,y,tx,ty,alive,...}

// Canvas colors are sRGB — every texture must say so or it renders washed out.
function canvasTex(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const BG = 0x14101f;
const CX = C.ARENA_W / 2, CZ = C.ARENA_H / 2;

let renderer, scene, camera, canvas;
let time = 0, shakeAmt = 0;
let lastW = 0, lastH = 0;
let camYaw = 0;                 // mouse-look yaw; 0 = facing north
let yawLocked = false;          // mountains fix the camera on the wall
let camPos = null;
export function getCamYaw() { return camYaw; }
export function turnCam(d) { if (!yawLocked) camYaw += d; }

let arena = null;
let mapMode = 'flat';           // 'flat' | 'mountain'
let curExtra = null;            // latest snapshot extra (for lifts/effects)
let speakingIds = null;         // voice chat: who's talking (id -> true)
const views = new Map();
const gremViews = new Map();
const chainPool = [];
const particles = [];
const floaters = [];
const corpses = [];

// ---- world mapping ---------------------------------------------------------

function toWorld(x, y, lift = 0) {
  if (mapMode === 'mountain') {
    const alt = 900 - y;
    return new THREE.Vector3(x, alt * 0.92 + lift, 720 - alt * 0.34);
  }
  return new THREE.Vector3(x, lift, y);
}

function liftFor(id) {
  // dig: each layer down is a real 130-unit drop
  const l = curExtra?.pl?.[id];
  return l ? -l * 130 : 0;
}

// ---- shared geometry / materials --------------------------------------------

const GEO = {
  // chunky little HUMANS in faceted toy-diorama low poly: big gem-cut head
  // with a real face, tapered barrel torso, sleeves ending in mitts, boots.
  // Segment counts are LOW on purpose — the facets are the art style.
  torso: new THREE.CylinderGeometry(13, 17.5, 36, 8),
  sleeve: new THREE.CapsuleGeometry(6.8, 6, 2, 7),
  forearm: new THREE.CapsuleGeometry(5.6, 9, 2, 7),
  hand: new THREE.SphereGeometry(6.2, 7, 5),
  thigh: new THREE.CapsuleGeometry(7.5, 12, 2, 7),
  shoe: new THREE.SphereGeometry(8.5, 7, 5).scale(1.35, 0.75, 1.05),
  head: new THREE.SphereGeometry(16.5, 9, 6),
  nose: new THREE.SphereGeometry(4.6, 6, 4).scale(1.25, 1, 1),
  ear: new THREE.SphereGeometry(3.6, 6, 4),
  brow: new THREE.BoxGeometry(2.4, 2.2, 6.5),
  hair: new THREE.SphereGeometry(17.3, 9, 5, 0, Math.PI * 2, 0, Math.PI * 0.52),
  // the 2004 de-make set
  torsoB: new THREE.BoxGeometry(26, 46, 36),
  legB: new THREE.BoxGeometry(12, 27, 14),
  armB: new THREE.BoxGeometry(10, 27, 12),
  headB: new THREE.BoxGeometry(26, 24, 28),
  eyeB: new THREE.BoxGeometry(3, 6, 6),
  eyeH: new THREE.SphereGeometry(5.4, 14, 12).scale(1, 1.2, 1),
  pupilH: new THREE.SphereGeometry(2.8, 10, 8),
  aura: new THREE.SphereGeometry(C.PLAYER_RADIUS + 12, 16, 12),
  link: new THREE.SphereGeometry(7, 8, 6),
  particle: new THREE.SphereGeometry(5, 6, 5),
  gremlin: new THREE.IcosahedronGeometry(24, 0),
  glob: new THREE.SphereGeometry(28, 10, 8),
  card: new THREE.PlaneGeometry(66, 92),
};
const MAT = {
  eyeWhite: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3, userData: { smooth: true } }),
  pupil: new THREE.MeshStandardMaterial({ color: 0x1a1426, roughness: 0.4, userData: { smooth: true } }),
  link: new THREE.MeshStandardMaterial({ color: 0x4a4260, roughness: 0.35, metalness: 0.7 }),
  gremlin: new THREE.MeshStandardMaterial({ color: 0x2c2140, roughness: 0.6, flatShading: true }),
  gremlinEye: new THREE.MeshBasicMaterial({ color: 0xff3030 }),
  glob: new THREE.MeshStandardMaterial({ color: 0x6b8a2e, roughness: 0.4, flatShading: true }),
  statueBase: new THREE.MeshStandardMaterial({ color: 0x55506e, roughness: 0.8 }),
};
const particleMats = new Map();
function particleMat(color) {
  if (!particleMats.has(color)) particleMats.set(color, new THREE.MeshBasicMaterial({ color, transparent: true }));
  return particleMats.get(color);
}

// Soft contact-shadow blob — the cheap trick that glues toys to the diorama.
let blobShadowTex = null;
function blobShadow(radius = 42, opacity = 0.34) {
  if (!blobShadowTex) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const g = cv.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 6, 64, 64, 62);
    grad.addColorStop(0, 'rgba(10,6,20,1)');
    grad.addColorStop(0.7, 'rgba(10,6,20,0.55)');
    grad.addColorStop(1, 'rgba(10,6,20,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    blobShadowTex = canvasTex(cv);
  }
  const m = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 20),
    new THREE.MeshBasicMaterial({ map: blobShadowTex, transparent: true, opacity, depthWrite: false }),
  );
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 1;
  return m;
}

// ---- humanoid slop-people ------------------------------------------------------

// Real skin tones + hair colors, keyed per player so the squad looks like a
// crew of little dudes instead of a bag of gumballs.
const SKINS = ['#f2c9a0', '#e8ab72', '#c98e55', '#9a6b42', '#f6d7b8', '#7a5236'];
const HAIRS = ['#3a2a1e', '#191922', '#6b4a2e', '#8a8a92', '#b8862e', '#2e1c14'];
const SHOE_MAT = new THREE.MeshStandardMaterial({ color: 0x2a2233, roughness: 0.6, flatShading: true });

const charMatCache = new Map();
function charMats(color, skinIndex = 0, blocky = false) {
  const key = `${color}#${skinIndex}${blocky ? 'B' : ''}`;
  if (!charMatCache.has(key)) {
    const base = new THREE.Color(color);
    if (blocky) {
      const opts = { flatShading: true, roughness: 1 };
      charMatCache.set(key, {
        suit: new THREE.MeshStandardMaterial({ color: base, roughness: 0.5, ...opts }),
        skin: new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color('#ffffff'), 0.35), roughness: 0.45, ...opts }),
        limb: new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color('#000000'), 0.25), roughness: 0.55, ...opts }),
      });
    } else {
      // flat shading everywhere — clean toy-diorama facets
      charMatCache.set(key, {
        shirt: new THREE.MeshStandardMaterial({ color: base, roughness: 0.6, flatShading: true }),
        pants: new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color('#14101f'), 0.45), roughness: 0.65, flatShading: true }),
        skin: new THREE.MeshStandardMaterial({ color: SKINS[skinIndex % SKINS.length], roughness: 0.55, flatShading: true }),
        hair: new THREE.MeshStandardMaterial({ color: HAIRS[skinIndex % HAIRS.length], roughness: 0.75, flatShading: true }),
      });
    }
  }
  return charMatCache.get(key);
}
const AXE_COLORS = ['#9d9d9d', '#f8f8f8', '#1eff00', '#0070dd', '#a335ee'];
const AXE_NAMES = ['Worn', 'Common', 'Uncommon', 'Rare', 'Epic'];
const WOOD_MAT = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.85 });
function buildAxe(tier) {
  const g = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(2.6, 3.4, 42, 7), WOOD_MAT);
  g.add(handle);
  const headMat = new THREE.MeshStandardMaterial({
    color: AXE_COLORS[tier], roughness: 0.35, metalness: 0.6,
    emissive: tier >= 2 ? AXE_COLORS[tier] : '#000000',
    emissiveIntensity: tier >= 2 ? 0.4 : 0,
  });
  const head = new THREE.Mesh(new THREE.BoxGeometry(20, 9, 6), headMat);
  head.position.set(6, 18, 0);
  const spike = new THREE.Mesh(new THREE.ConeGeometry(4.5, 12, 6), headMat);
  spike.rotation.z = Math.PI / 2 + 0.5;
  spike.position.set(18, 16, 0);
  g.add(head, spike);
  if (tier >= 4) { // epic gets the glow
    const glow = new THREE.PointLight(0xa335ee, 1600, 160);
    glow.position.set(6, 18, 0);
    g.add(glow);
  }
  return g;
}
function attachAxe(v, tier) {
  if (v.axeMesh) { v.char.armR.remove(v.axeMesh); v.axeMesh = null; }
  v.axeShown = tier;
  if (tier < 0) return;
  v.axeMesh = buildAxe(tier);
  v.axeMesh.position.set(6, -26, 2);
  v.axeMesh.rotation.z = -0.5;
  v.char.armR.add(v.axeMesh);
}

const HAT_DARK = new THREE.MeshStandardMaterial({ color: 0x14101f, roughness: 0.6 });
const HAT_RED = new THREE.MeshStandardMaterial({ color: 0xd8333f, roughness: 0.6 });
const HAT_GOLD = new THREE.MeshStandardMaterial({ color: 0xffd84d, roughness: 0.4, metalness: 0.4 });

function makeHat(i) {
  const hat = new THREE.Group();
  if (i === 1) {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 3, 16), HAT_DARK);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 18, 16), HAT_DARK);
    top.position.y = 10;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(10.5, 10.5, 5, 16), HAT_RED);
    band.position.y = 4;
    hat.add(brim, top, band);
  } else if (i === 2) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(13, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), HAT_RED);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(12, 2.5, 14), HAT_RED);
    brim.position.set(12, 1, 0);
    hat.add(dome, brim);
  } else if (i === 3) {
    const fez = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 13, 14), HAT_RED);
    fez.position.y = 5;
    hat.add(fez);
  } else if (i === 4) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(10, 11, 7, 10), HAT_GOLD);
    ring.position.y = 2;
    hat.add(ring);
  }
  hat.scale.setScalar(1.25); // sized for the big toy head
  return hat;
}

// Root sits at ground level; feet reach y≈0. Local +x is forward.
// blocky=true builds the 2004 de-make: box limbs, flat shading, dead eyes.
function buildCharacter(color, { hatIndex = 0, eyeColor = null, scale = 1, blocky = false, skinIndex = 0 } = {}) {
  const m = charMats(color, skinIndex, blocky);
  const root = new THREE.Group();

  if (blocky) {
    const legL = new THREE.Group();
    const legR = new THREE.Group();
    for (const [pivot, side] of [[legL, -1], [legR, 1]]) {
      pivot.position.set(0, 28, side * 9);
      const leg = new THREE.Mesh(GEO.legB, m.limb);
      leg.position.y = -14;
      leg.castShadow = true;
      pivot.add(leg);
      root.add(pivot);
    }
    const torso = new THREE.Mesh(GEO.torsoB, m.suit);
    torso.position.y = 51;
    torso.castShadow = true;
    root.add(torso);
    const armL = new THREE.Group();
    const armR = new THREE.Group();
    for (const [pivot, side] of [[armL, -1], [armR, 1]]) {
      pivot.position.set(0, 64, side * 24);
      const arm = new THREE.Mesh(GEO.armB, m.limb);
      arm.position.y = -13;
      arm.castShadow = true;
      pivot.add(arm);
      root.add(pivot);
    }
    const head = new THREE.Mesh(GEO.headB, m.skin);
    head.position.y = 89;
    head.castShadow = true;
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(GEO.eyeB, eyeColor ? new THREE.MeshBasicMaterial({ color: eyeColor }) : MAT.pupil);
      eye.position.set(13.5, 2, side * 7);
      head.add(eye);
    }
    const hat = makeHat(hatIndex);
    hat.position.y = 12;
    head.add(hat);
    root.add(head);
    root.scale.setScalar(scale);
    return { root, legL, legR, armL, armR, torso, head };
  }

  // ---- the little human ----
  const legL = new THREE.Group();
  const legR = new THREE.Group();
  for (const [pivot, side] of [[legL, -1], [legR, 1]]) {
    pivot.position.set(0, 30, side * 9.5);
    const thigh = new THREE.Mesh(GEO.thigh, m.pants);
    thigh.position.y = -13;
    thigh.castShadow = true;
    const shoe = new THREE.Mesh(GEO.shoe, SHOE_MAT);
    shoe.position.set(3.5, -26, 0);
    shoe.castShadow = true;
    pivot.add(thigh, shoe);
    root.add(pivot);
  }

  const torso = new THREE.Mesh(GEO.torso, m.shirt);
  torso.position.y = 50;
  torso.scale.set(1.14, 1, 1.06); // a respectable belly
  torso.castShadow = true;
  root.add(torso);

  const armL = new THREE.Group();
  const armR = new THREE.Group();
  for (const [pivot, side] of [[armL, -1], [armR, 1]]) {
    pivot.position.set(0, 66, side * 20.5);
    const sleeve = new THREE.Mesh(GEO.sleeve, m.shirt);
    sleeve.position.y = -5;
    sleeve.castShadow = true;
    const forearm = new THREE.Mesh(GEO.forearm, m.skin);
    forearm.position.y = -15;
    forearm.castShadow = true;
    const hand = new THREE.Mesh(GEO.hand, m.skin);
    hand.position.y = -24;
    hand.castShadow = true;
    pivot.add(sleeve, forearm, hand);
    root.add(pivot);
  }

  const head = new THREE.Mesh(GEO.head, m.skin);
  head.position.y = 90;
  head.castShadow = true;
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(GEO.eyeH, MAT.eyeWhite);
    eye.position.set(13.8, 3.5, side * 6.8);
    const pupil = new THREE.Mesh(GEO.pupilH, eyeColor ? new THREE.MeshBasicMaterial({ color: eyeColor }) : MAT.pupil);
    pupil.position.set(4, 0.3, 0);
    eye.add(pupil);
    head.add(eye);
    const brow = new THREE.Mesh(GEO.brow, m.hair);
    brow.position.set(14.6, 10, side * 6.8);
    head.add(brow);
    const ear = new THREE.Mesh(GEO.ear, m.skin);
    ear.position.set(0, 0.5, side * 16);
    head.add(ear);
  }
  const nose = new THREE.Mesh(GEO.nose, m.skin);
  nose.position.set(16.2, -1.5, 0);
  head.add(nose);
  const hair = new THREE.Mesh(GEO.hair, m.hair);
  hair.position.set(-1.5, 2.5, 0);
  hair.rotation.z = 0.3; // tip the mop back so the face stays clear
  head.add(hair);
  const hat = makeHat(hatIndex);
  hat.position.y = 14;
  head.add(hat);
  root.add(head);

  root.scale.setScalar(scale);
  return { root, legL, legR, armL, armR, torso, head };
}

// ---- text sprites -------------------------------------------------------------

function makeTextSprite(text, { px = 44, color = '#fff', w = 512, stroke = true } = {}) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = 128;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
  const draw = (t, col) => {
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, 128);
    g.font = `bold ${px}px 'Trebuchet MS', sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (stroke) { g.lineWidth = 9; g.strokeStyle = '#14101fee'; g.strokeText(t, w / 2, 64); }
    g.fillStyle = col;
    g.fillText(t, w / 2, 64);
    if (sprite.material.map) sprite.material.map.dispose();
    sprite.material.map = canvasTex(cv);
    sprite.material.needsUpdate = true;
  };
  draw(text, color);
  sprite.scale.set(w * 0.30, 38, 1);
  sprite.userData.text = text;
  sprite.userData.color = color;
  sprite.userData.set = (t, col = sprite.userData.color) => {
    if (t !== sprite.userData.text || col !== sprite.userData.color) {
      sprite.userData.text = t; sprite.userData.color = col;
      draw(t, col);
    }
  };
  return sprite;
}

// ---- playing cards --------------------------------------------------------------

const cardTexCache = new Map();
function cardTexture(code) {
  if (cardTexCache.has(code)) return cardTexCache.get(code);
  const cv = document.createElement('canvas');
  cv.width = 176; cv.height = 246;
  const g = cv.getContext('2d');
  const rr = (x, y, w, h, r) => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };
  if (code === 'BACK') {
    rr(4, 4, 168, 238, 16);
    g.fillStyle = '#47215f';
    g.fill();
    g.save(); g.clip();
    g.strokeStyle = '#5c2d7a'; g.lineWidth = 10;
    for (let i = -240; i < 240; i += 26) {
      g.beginPath(); g.moveTo(i, 250); g.lineTo(i + 250, 0); g.stroke();
    }
    g.restore();
    g.strokeStyle = '#c9a3e8'; g.lineWidth = 5; rr(4, 4, 168, 238, 16); g.stroke();
  } else {
    const suit = code.slice(-1);
    const rank = code.slice(0, -1);
    const red = suit === '♥' || suit === '♦';
    rr(4, 4, 168, 238, 16);
    g.fillStyle = '#f7f3ea';
    g.fill();
    g.strokeStyle = '#b7ad9d'; g.lineWidth = 4; g.stroke();
    g.fillStyle = red ? '#c02020' : '#1a1a1a';
    g.font = 'bold 52px Trebuchet MS';
    g.textAlign = 'left';
    g.fillText(rank, 14, 56);
    g.font = '44px serif';
    g.fillText(suit, 14, 102);
    g.font = '110px serif';
    g.textAlign = 'center';
    g.fillText(suit, 88, 190);
  }
  const tex = canvasTex(cv);
  cardTexCache.set(code, tex);
  return tex;
}

function makeCardMesh(code) {
  const m = new THREE.Mesh(GEO.card, new THREE.MeshBasicMaterial({
    map: cardTexture(code), transparent: true, side: THREE.DoubleSide,
  }));
  m.rotation.x = -0.95;
  m.userData.cardCode = code;
  return m;
}

// ---- init -------------------------------------------------------------------------

export function initRender(cv) {
  canvas = cv;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 2400, 4600);

  camera = new THREE.PerspectiveCamera(62, 16 / 9, 10, 6000);
  canvas.addEventListener('click', () => canvas.requestPointerLock?.());
  document.addEventListener('mousemove', e => {
    if (!yawLocked && document.pointerLockElement === canvas) camYaw += e.movementX * 0.0026;
  });

  // The concept-art look lives or dies on CONTRAST: a strong warm sun and a
  // modest cool fill, so lit faces glow and shadowed faces actually go dark.
  scene.add(new THREE.AmbientLight(0xc8bcf0, 0.5));
  scene.add(new THREE.HemisphereLight(0x9ec8ff, 0xd8a878, 0.85));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.7);
  sun.position.set(500, 1500, 900);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.normalBias = 4; // flat-shaded facets shadow-acne without this
  Object.assign(sun.shadow.camera, { left: -1300, right: 1300, top: 1300, bottom: -1300, near: 100, far: 3500 });
  sun.target.position.set(CX, 0, CZ);
  scene.add(sun, sun.target);

  const starGeo = new THREE.BufferGeometry();
  const pts = [];
  for (let i = 0; i < 300; i++) {
    pts.push((Math.random() - 0.5) * 6000, -600 - Math.random() * 800, (Math.random() - 0.5) * 6000);
  }
  starGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x5c4d8a, size: 5 })));
}

function resizeIfNeeded() {
  const w = canvas.clientWidth || window.innerWidth;
  const h = canvas.clientHeight || window.innerHeight;
  if (w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

// ---- arena lifecycle -----------------------------------------------------------------

function clearGroup(g) {
  g.traverse(o => {
    if (o.geometry && !Object.values(GEO).includes(o.geometry)) o.geometry.dispose();
    if (o.material && o.material.map && !cardTexCache.has(o.userData?.cardCode)) o.material.map.dispose();
  });
  scene.remove(g);
}

export function resetArena() {
  if (arena) { clearGroup(arena.group); arena = null; }
  for (const v of views.values()) scene.remove(v.group);
  views.clear();
  for (const v of gremViews.values()) scene.remove(v.group);
  gremViews.clear();
  for (const p of particles) p.mesh.visible = false;
  for (const f of floaters) scene.remove(f.sprite);
  floaters.length = 0;
  for (const c of corpses) scene.remove(c.group);
  corpses.length = 0;
  blobs.clear();
  curExtra = null;
}

// ---- procedural textures ---------------------------------------------------------

// Big flowing swirl carpet — the Gamble With Friends casino floor look:
// cream base, fat black waves, hot pink + cyan ribbons weaving through.
function carpetTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#f2e6e0';
  g.fillRect(0, 0, 512, 512);
  // sine ribbons tile in x; drawing each at y±512 keeps the vertical seam clean
  const ribbon = (col, w, y0, amp, ph, freq = 1) => {
    g.strokeStyle = col;
    g.lineWidth = w;
    g.lineCap = 'round';
    for (const oy of [-512, 0, 512]) {
      g.beginPath();
      for (let x = -24; x <= 536; x += 8) {
        const y = y0 + oy + Math.sin((x / 512) * Math.PI * 2 * freq + ph) * amp;
        x === -24 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
  };
  ribbon('#221728', 58, 90, 46, 0.4);
  ribbon('#ff6ec7', 30, 168, 38, 2.1);
  ribbon('#221728', 64, 300, 52, 3.6);
  ribbon('#31c9d8', 18, 388, 34, 1.2, 2);
  ribbon('#ffd84d', 12, 452, 40, 5.0);
  ribbon('#f2b8d8', 26, 20, 30, 4.2, 2);
  const tex = canvasTex(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  return tex;
}

// Bright white casino-mall walls with a faint pastel lattice.
function wallpaperTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#f6f0f4';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#e4d0e6';
  g.lineWidth = 4;
  for (let x = -256; x < 512; x += 64) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 128, 256); g.stroke();
    g.beginPath(); g.moveTo(x + 128, 0); g.lineTo(x, 256); g.stroke();
  }
  g.fillStyle = '#ffd84d66';
  for (let x = 32; x < 256; x += 64) {
    for (let y = 32; y < 256; y += 64) {
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill();
    }
  }
  const tex = canvasTex(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 3);
  return tex;
}

// The whole dig field painted as ONE continuous ground (tiles carve it up
// via planar UVs, so there is no checkerboard — just terrain that breaks).
function goldshireField() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 576;
  const g = cv.getContext('2d');
  g.fillStyle = '#3f8f2c';
  g.fillRect(0, 0, 1024, 576);
  // painterly grass mottling
  const tones = ['#357a24', '#2d6e1f', '#4a9a34', '#26611b', '#38852a'];
  for (let i = 0; i < 1100; i++) {
    g.fillStyle = tones[i % tones.length];
    g.globalAlpha = 0.16 + Math.random() * 0.22;
    g.beginPath();
    g.ellipse(Math.random() * 1024, Math.random() * 576, 8 + Math.random() * 26, 5 + Math.random() * 14, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  // the winding village road (heads up toward the inn)
  const road = (jx, w, col, alpha) => {
    g.strokeStyle = col;
    g.globalAlpha = alpha;
    g.lineWidth = w;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(-20 + jx, 400 + jx);
    g.bezierCurveTo(300 + jx, 330, 420 - jx, 240, 512 + jx, 60);
    g.stroke();
    g.beginPath();
    g.moveTo(512 + jx, 60);
    g.bezierCurveTo(600, 220 + jx, 820 - jx, 300, 1050, 360 + jx);
    g.stroke();
  };
  road(0, 74, '#8a6b42', 1);
  road(3, 60, '#a08050', 1);
  road(-2, 40, '#b09461', 0.9);
  for (let i = 0; i < 260; i++) { // dirt speckle on the road band
    g.fillStyle = Math.random() < 0.5 ? '#8a6b42' : '#c0a470';
    g.globalAlpha = 0.35;
    const t = Math.random();
    const rx = t < 0.5 ? (-20 + t * 2 * 532) : (512 + (t - 0.5) * 2 * 538);
    const ry = t < 0.5 ? 400 - t * 2 * 320 + (Math.random() - 0.5) * 46 : 60 + (t - 0.5) * 2 * 300 + (Math.random() - 0.5) * 46;
    g.fillRect(rx, ry, 3, 2);
  }
  g.globalAlpha = 1;
  // flowers
  const petals = ['#ffffff', '#ffe93b', '#ff6ec7', '#ff5252'];
  for (let i = 0; i < 130; i++) {
    g.fillStyle = petals[i % petals.length];
    const fx = Math.random() * 1024, fy = Math.random() * 576;
    g.fillRect(fx, fy, 3, 3);
    g.fillStyle = '#ffd84d';
    g.fillRect(fx + 1, fy + 1, 1, 1);
  }
  const tex = canvasTex(cv);
  return tex;
}

function dirtField() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 288;
  const g = cv.getContext('2d');
  g.fillStyle = '#8a6a3a';
  g.fillRect(0, 0, 512, 288);
  for (let i = 0; i < 500; i++) {
    g.fillStyle = ['#7a5a30', '#9a7a46', '#6b4f2a', '#a58852'][i % 4];
    g.globalAlpha = 0.2 + Math.random() * 0.25;
    g.beginPath();
    g.ellipse(Math.random() * 512, Math.random() * 288, 4 + Math.random() * 16, 3 + Math.random() * 8, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 0.8;
  for (let i = 0; i < 60; i++) { // pebbles + roots
    g.fillStyle = '#5a452a';
    g.fillRect(Math.random() * 512, Math.random() * 288, 4 + Math.random() * 6, 3);
  }
  g.globalAlpha = 1;
  return canvasTex(cv);
}

function rockField() {
  const cv = document.createElement('canvas');
  cv.width = 64; cv.height = 36;
  const g = cv.getContext('2d');
  g.fillStyle = '#8a8a92';
  g.fillRect(0, 0, 64, 36);
  const tones = ['#6b6b74', '#a3a3ac', '#55555e', '#7a7a84'];
  for (let i = 0; i < 240; i++) {
    g.fillStyle = tones[i % 4];
    g.fillRect(Math.floor(Math.random() * 64), Math.floor(Math.random() * 36), 1 + Math.floor(Math.random() * 2), 1);
  }
  const tex = canvasTex(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  return tex;
}

// 16x16 nearest-filter texture — instant 2004
function pixelTexture(base, accents, repeat = 6) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 16;
  const g = cv.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 16, 16);
  for (let i = 0; i < 46; i++) {
    g.fillStyle = accents[i % accents.length];
    g.globalAlpha = 0.25 + Math.random() * 0.4;
    g.fillRect(Math.floor(Math.random() * 16), Math.floor(Math.random() * 16), 1 + Math.floor(Math.random() * 2), 1);
  }
  const tex = canvasTex(cv);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  return tex;
}

function noiseTexture(base, blotch, n = 46, size = 512) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  g.fillStyle = blotch;
  for (let i = 0; i < n; i++) {
    g.globalAlpha = 0.08 + Math.random() * 0.14;
    g.beginPath();
    g.arc(Math.random() * size, Math.random() * size, 12 + Math.random() * 46, 0, Math.PI * 2);
    g.fill();
  }
  const tex = canvasTex(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// Concept-art ground: big soft tonal patches, dense speckle, hairline cracks.
// A flat plane painted like this reads as terrain instead of a void.
function paintedGround(base, tones, { cracks = 10, speckle = 420, size = 1024 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, size, size);
  for (let i = 0; i < 70; i++) { // broad patches
    g.fillStyle = tones[i % tones.length];
    g.globalAlpha = 0.10 + Math.random() * 0.16;
    g.beginPath();
    g.ellipse(Math.random() * size, Math.random() * size,
      40 + Math.random() * 150, 25 + Math.random() * 90, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  g.globalAlpha = 1;
  for (let i = 0; i < speckle; i++) { // pebble speckle
    g.fillStyle = tones[i % tones.length];
    g.globalAlpha = 0.25 + Math.random() * 0.3;
    const s = 2 + Math.random() * 5;
    g.fillRect(Math.random() * size, Math.random() * size, s, s * 0.7);
  }
  g.globalAlpha = 1;
  g.strokeStyle = 'rgba(20,10,6,0.28)';
  for (let i = 0; i < cracks; i++) { // wandering hairline cracks
    g.lineWidth = 1.5 + Math.random() * 2;
    let x = Math.random() * size, y = Math.random() * size;
    let a = Math.random() * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 9; s++) {
      a += (Math.random() - 0.5) * 1.3;
      x += Math.cos(a) * (18 + Math.random() * 26);
      y += Math.sin(a) * (18 + Math.random() * 26);
      g.lineTo(x, y);
    }
    g.stroke();
  }
  const tex = canvasTex(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---- arena builders ---------------------------------------------------------------------

// jitter vertices so primitives read as hand-carved rock, not math
function roughen(geo, amp) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(i,
      pos.getX(i) + (Math.random() - 0.5) * amp,
      pos.getY(i) + (Math.random() - 0.5) * amp,
      pos.getZ(i) + (Math.random() - 0.5) * amp);
  }
  geo.computeVertexNormals();
  return geo;
}

function skyDome(group, top, horizon, low) {
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 512;
  const g = cv.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, top);
  grad.addColorStop(0.55, horizon);
  grad.addColorStop(1, low);
  g.fillStyle = grad;
  g.fillRect(0, 0, 4, 512);
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(3800, 20, 14),
    new THREE.MeshBasicMaterial({ map: canvasTex(cv), side: THREE.BackSide, fog: false }),
  );
  dome.position.set(CX, 0, CZ);
  group.add(dome);
  return dome;
}

const cloudTexCache = [];
function cloudTexture() {
  if (cloudTexCache.length) return cloudTexCache[0];
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const g = cv.getContext('2d');
  for (let i = 0; i < 9; i++) {
    const grad = g.createRadialGradient(40 + i * 22, 64 + Math.sin(i) * 14, 4, 40 + i * 22, 64 + Math.sin(i) * 14, 42);
    grad.addColorStop(0, 'rgba(255,255,255,0.6)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 128);
  }
  const t = canvasTex(cv);
  cloudTexCache.push(t);
  return t;
}

function addClouds(group, n, yBase, tint = 0xffffff, opacity = 0.55) {
  for (let i = 0; i < n; i++) {
    const c = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTexture(), color: tint, transparent: true, opacity: opacity * (0.6 + Math.random() * 0.4), fog: false, depthWrite: false }));
    const sc = 500 + Math.random() * 700;
    c.scale.set(sc, sc * 0.42, 1);
    c.position.set(Math.random() * 5000 - 1700, yBase + Math.random() * 380, CZ - 1300 - Math.random() * 1400);
    group.add(c);
    const speed = 12 + Math.random() * 18;
    arena.fx.push(dt => {
      c.position.x += speed * dt;
      if (c.position.x > 3600) c.position.x = -2200;
    });
  }
}

function addDrifters(group, { count = 90, color = 0xfff2d0, size = 5, opacity = 0.4, box = [0, 1600, 20, 420, 0, 900], vy = 9 }) {
  const geo = new THREE.BufferGeometry();
  const pts = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pts[i * 3] = box[0] + Math.random() * (box[1] - box[0]);
    pts[i * 3 + 1] = box[2] + Math.random() * (box[3] - box[2]);
    pts[i * 3 + 2] = box[4] + Math.random() * (box[5] - box[4]);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  const points = new THREE.Points(geo, new THREE.PointsMaterial({ color, size, transparent: true, opacity, depthWrite: false }));
  group.add(points);
  arena.fx.push(dt => {
    const a = geo.attributes.position.array;
    for (let i = 0; i < count; i++) {
      a[i * 3 + 1] += vy * dt;
      a[i * 3] += Math.sin(time * 0.7 + i) * 6 * dt;
      if (a[i * 3 + 1] > box[3]) a[i * 3 + 1] = box[2];
      if (a[i * 3 + 1] < box[2]) a[i * 3 + 1] = box[3];
    }
    geo.attributes.position.needsUpdate = true;
  });
}

const flameTexCache = [];
function flameTexture() {
  if (flameTexCache.length) return flameTexCache[0];
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const g = cv.getContext('2d');
  const grad = g.createRadialGradient(32, 40, 2, 32, 34, 30);
  grad.addColorStop(0, 'rgba(255,240,180,0.95)');
  grad.addColorStop(0.4, 'rgba(255,150,50,0.8)');
  grad.addColorStop(1, 'rgba(255,80,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = canvasTex(cv);
  flameTexCache.push(t);
  return t;
}

function torch(group, x, y, z) {
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 56, 7), new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.9 }));
  stick.position.set(x, y + 24, z);
  stick.rotation.z = 0.16;
  const flame = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTexture(), transparent: true, depthWrite: false }));
  flame.position.set(x + 8, y + 62, z);
  flame.scale.set(46, 46, 1);
  const light = new THREE.PointLight(0xff9040, 9000, 620);
  light.position.set(x + 8, y + 66, z + 20);
  group.add(stick, flame, light);
  const seed = Math.random() * 10;
  arena.fx.push(() => {
    const f = 0.85 + Math.sin(time * 11 + seed) * 0.12 + Math.sin(time * 23 + seed * 2) * 0.06;
    light.intensity = 9000 * f;
    flame.scale.set(46 * f, 46 * (2 - f), 1);
  });
}

function setMood(bg, fogNear = 2400, fogFar = 4600) {
  scene.background.set(bg);
  scene.fog.color.set(bg);
  scene.fog.near = fogNear;
  scene.fog.far = fogFar;
}

// ---- Slopshire set dressing (a certain vanilla village) --------------------------

function timberHouse(group, x, z, ry, sx = 1) {
  const house = new THREE.Group();
  const plaster = new THREE.MeshStandardMaterial({ color: 0xe8dfc8, roughness: 0.9 });
  const timber = new THREE.MeshStandardMaterial({ color: 0x4a3220, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a4a2e, roughness: 0.85 });
  const W = 300 * sx, D = 210 * sx, H = 130 * sx;
  const body = new THREE.Mesh(new THREE.BoxGeometry(W, H, D), plaster);
  body.position.y = H / 2;
  body.castShadow = true;
  house.add(body);
  for (const [px, pz] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) {
    const post = new THREE.Mesh(new THREE.BoxGeometry(14, H, 14), timber);
    post.position.set(px, H / 2, pz);
    house.add(post);
  }
  for (const by of [H * 0.33, H * 0.66]) {
    const band = new THREE.Mesh(new THREE.BoxGeometry(W + 4, 9, D + 4), timber);
    band.position.y = by;
    house.add(band);
  }
  // gabled roof: two leaning slabs
  const slabLen = Math.hypot(W / 2 + 24, 80 * sx);
  for (const side of [-1, 1]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(slabLen, 10, D + 60), roofMat);
    slab.position.set(side * (W / 4 + 6), H + 40 * sx, 0);
    slab.rotation.z = side * -Math.atan2(80 * sx, W / 2 + 24);
    slab.castShadow = true;
    house.add(slab);
  }
  const chimney = new THREE.Mesh(new THREE.BoxGeometry(26, 70, 26), new THREE.MeshStandardMaterial({ color: 0x777083 }));
  chimney.position.set(W / 4, H + 60 * sx, D / 4);
  house.add(chimney);
  house.position.set(x, 0, z);
  house.rotation.y = ry;
  group.add(house);
  return house;
}

function tree(group, x, z, s = 1) {
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(9 * s, 13 * s, 70 * s, 8),
    new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 }));
  trunk.position.set(x, 35 * s, z);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7d2c, roughness: 0.9, flatShading: true });
  const lo = new THREE.Mesh(new THREE.IcosahedronGeometry(48 * s, 1), leafMat);
  lo.position.set(x, 95 * s, z);
  const hi = new THREE.Mesh(new THREE.IcosahedronGeometry(32 * s, 1), leafMat);
  hi.position.set(x + 10 * s, 135 * s, z - 6 * s);
  lo.castShadow = hi.castShadow = trunk.castShadow = true;
  group.add(trunk, lo, hi);
}

function lamppost(group, x, z) {
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(4, 5, 110, 8), HAT_DARK);
  pole.position.set(x, 55, z);
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(11, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0xffd84d, emissive: 0xffb020, emissiveIntensity: 1.2 }));
  lamp.position.set(x, 116, z);
  const light = new THREE.PointLight(0xffc860, 6000, 420);
  light.position.set(x, 120, z);
  group.add(pole, lamp, light);
}

// ---- Grand Slopchange set dressing (a certain grand marketplace) ------------------

function buildSlopchange(group, baseY) {
  const stone = new THREE.MeshStandardMaterial({ color: 0xcbb98a, roughness: 1, flatShading: true, map: pixelTexture('#cbb98a', ['#b3a276', '#dbc99a', '#9a8a64'], 2) });
  const darkStone = new THREE.MeshStandardMaterial({ color: 0x9a8a64, roughness: 1, flatShading: true, map: pixelTexture('#9a8a64', ['#8a7a54', '#ab9b74'], 2) });
  // circular plaza inlay
  const plaza = new THREE.Mesh(new THREE.CylinderGeometry(340, 340, 6, 40), darkStone);
  plaza.position.set(CX, baseY + 4, CZ);
  group.add(plaza);
  // the fountain
  const tiers = [[110, 26], [70, 34], [34, 46]];
  let ty = baseY + 6;
  for (const [r, h] of tiers) {
    const tier = new THREE.Mesh(new THREE.CylinderGeometry(r, r + 8, h, 24), stone);
    tier.position.set(CX, ty + h / 2, CZ);
    tier.castShadow = true;
    group.add(tier);
    ty += h;
  }
  const water = new THREE.Mesh(new THREE.CylinderGeometry(96, 96, 6, 24),
    new THREE.MeshStandardMaterial({ color: 0x4db8e8, emissive: 0x1a6a9a, emissiveIntensity: 0.5, roughness: 0.15 }));
  water.position.set(CX, baseY + 30, CZ);
  group.add(water);
  // banker booths around the circle
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const bx = CX + Math.cos(a) * 430, bz = CZ + Math.sin(a) * 300;
    const desk = new THREE.Mesh(new THREE.BoxGeometry(150, 55, 55), new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.8 }));
    desk.position.set(bx, baseY + 28, bz);
    desk.rotation.y = -a + Math.PI / 2;
    desk.castShadow = true;
    group.add(desk);
    const awning = new THREE.Mesh(new THREE.BoxGeometry(170, 8, 90), HAT_GOLD);
    awning.position.set(bx, baseY + 120, bz);
    awning.rotation.y = -a + Math.PI / 2;
    awning.rotation.x = 0.18;
    group.add(awning);
    for (const side of [-70, 70]) {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(3.5, 3.5, 110, 8), HAT_DARK);
      pole.position.set(bx + Math.cos(-a + Math.PI / 2) * side, baseY + 58, bz + Math.sin(-a + Math.PI / 2) * side);
      group.add(pole);
    }
    // coin piles by the desks
    for (let c = 0; c < 5; c++) {
      const coin = new THREE.Mesh(new THREE.SphereGeometry(9 + Math.random() * 7, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xffd84d, metalness: 0.5, roughness: 0.35 }));
      coin.position.set(bx + (Math.random() - 0.5) * 120, baseY + 10, bz + 50 + Math.random() * 30);
      group.add(coin);
    }
  }
  // merchants yelling eternal nonsense
  const cries = [
    ['selling lobbies 150gp', '#ffd84d'],
    ['buying gf 10k', '#ff6ec7'],
    ['DOUBLING MONEY (trust)', '#7cfc00'],
  ];
  cries.forEach(([txt, col], i) => {
    const a = (i / 3) * Math.PI * 2 + 0.6;
    const mx = CX + Math.cos(a) * 210, mz = CZ + Math.sin(a) * 160;
    const merch = buildCharacter(['#9a8a64', '#6b7a8a', '#8a6b7a'][i], { hatIndex: (i + 2) % 5, blocky: true });
    merch.root.position.set(mx, baseY + 3, mz);
    merch.root.rotation.y = -a - Math.PI / 2;
    merch.armL.rotation.z = -2.2;
    group.add(merch.root);
    const cry = makeTextSprite(txt, { px: 34, color: col });
    cry.position.set(mx, baseY + 150, mz);
    group.add(cry);
  });
  const sign = makeTextSprite('🪙 THE GRAND SLOPCHANGE 🪙', { px: 48, color: '#FFD84D', w: 1024 });
  sign.position.set(CX, baseY + 300, CZ - 120);
  group.add(sign);
  const glow = new THREE.PointLight(0xffd8a0, 30000, 1200);
  glow.position.set(CX, baseY + 260, CZ);
  group.add(glow);
}

function addCave(group) {
  const cave = new THREE.Mesh(
    new THREE.CylinderGeometry(2600, 2600, 600, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x171126, roughness: 1, side: THREE.BackSide }),
  );
  cave.position.set(CX, 180, CZ);
  group.add(cave);
}

function floorBox(group, w, d, color, map = null, y = -22, h = 44) {
  const m = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, roughness: 0.9, map }),
  );
  m.position.set(CX, y, CZ);
  m.receiveShadow = true;
  group.add(m);
  return m;
}

// Casino-den interior shared by the hub and the Boss's Casino chamber.
function buildDenRoom(group) {
  const carpet = new THREE.Mesh(
    new THREE.BoxGeometry(1700, 44, 1000),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, map: carpetTexture() }),
  );
  carpet.position.set(CX, -22, CZ);
  carpet.receiveShadow = true;
  group.add(carpet);

  const wp = wallpaperTexture();
  const mkWall = (w, x, z, ry) => {
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(w, 520),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, map: wp }),
    );
    wall.position.set(x, 260, z);
    wall.rotation.y = ry;
    group.add(wall);
  };
  mkWall(1740, CX, -20, 0);
  mkWall(1740, CX, C.ARENA_H + 20, Math.PI);
  mkWall(1040, -20, CZ, Math.PI / 2);
  mkWall(1040, C.ARENA_W + 20, CZ, -Math.PI / 2);

  const trimMat = new THREE.MeshBasicMaterial({ color: 0xff6ec7 });
  for (const [w, d, x, z] of [[1660, 8, CX, -12], [1660, 8, CX, C.ARENA_H + 12], [8, 940, -12, CZ], [8, 940, C.ARENA_W + 12, CZ]]) {
    const t = new THREE.Mesh(new THREE.BoxGeometry(w, 10, d), trimMat);
    t.position.set(x, 6, z);
    group.add(t);
  }
  // white ceiling with a glass skylight grid (GWF atrium style)
  const ceil = new THREE.Mesh(
    new THREE.PlaneGeometry(1740, 1040),
    new THREE.MeshStandardMaterial({ color: 0xf2ecf6, roughness: 1 }),
  );
  ceil.position.set(CX, 520, CZ);
  ceil.rotation.x = Math.PI / 2;
  group.add(ceil);
  for (let gx = 0; gx < 4; gx++) {
    for (let gz = 0; gz < 3; gz++) {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(240, 6, 160),
        new THREE.MeshBasicMaterial({ color: 0xbfe6ff }),
      );
      panel.position.set(230 + gx * 380, 516, 190 + gz * 260);
      group.add(panel);
    }
  }
  // indoor palms in every corner, because casino
  palmTree(group, 130, 130, 1.0);
  palmTree(group, C.ARENA_W - 130, 130, 1.1);
  palmTree(group, 130, C.ARENA_H - 130, 1.1);
  palmTree(group, C.ARENA_W - 130, C.ARENA_H - 130, 0.95);
  const moodA = new THREE.PointLight(0xff6ec7, 18000, 900);
  moodA.position.set(220, 300, 200);
  group.add(moodA);
  const moodB = new THREE.PointLight(0x00e5ff, 15000, 900);
  moodB.position.set(C.ARENA_W - 220, 300, 700);
  group.add(moodB);
}

// ---- Chaos Canyon set dressing: faceted desert diorama pieces ---------------

// A stacked terracotta butte: tapered 8-sided slabs, lighter toward the top.
const MESA_TONES = [0xb3502a, 0xc4652f, 0xd4784a, 0xe08a56];
function mesa(group, x, z, s = 1) {
  const butte = new THREE.Group();
  let y = 0;
  const tiers = 3 + Math.floor(Math.random() * 2);
  for (let t = 0; t < tiers; t++) {
    const rTop = (250 - t * 55) * (0.82 + Math.random() * 0.3);
    const h = 150 - t * 22;
    const slab = new THREE.Mesh(
      new THREE.CylinderGeometry(rTop, rTop * 1.22, h, 8),
      new THREE.MeshStandardMaterial({ color: MESA_TONES[Math.min(t, MESA_TONES.length - 1)], roughness: 1, flatShading: true }),
    );
    slab.rotation.y = Math.random() * Math.PI;
    slab.position.y = y + h / 2;
    slab.castShadow = true;
    butte.add(slab);
    y += h * 0.92;
  }
  butte.position.set(x, 0, z);
  butte.scale.setScalar(s);
  group.add(butte);
}

// A saguaro: faceted trunk + two elbowed arms.
const CACTUS_MAT = new THREE.MeshStandardMaterial({ color: 0x4fae4a, roughness: 0.85, flatShading: true });
function cactus(group, x, z, s = 1) {
  const cac = new THREE.Group();
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(13, 16, 130, 7), CACTUS_MAT);
  trunk.position.y = 65;
  trunk.castShadow = true;
  cac.add(trunk);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(13, 7, 4), CACTUS_MAT);
  cap.position.y = 130;
  cac.add(cap);
  for (const [side, hy] of [[-1, 60], [1, 82]]) {
    const out = new THREE.Mesh(new THREE.CylinderGeometry(8, 9, 34, 6), CACTUS_MAT);
    out.rotation.x = side * Math.PI / 2;
    out.position.set(0, hy, side * 27);
    cac.add(out);
    const up = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 8.5, 46, 6), CACTUS_MAT);
    up.position.set(0, hy + 20, side * 42);
    cac.add(up);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(8, 6, 4), CACTUS_MAT);
    knob.position.set(0, hy + 43, side * 42);
    cac.add(knob);
  }
  cac.position.set(x, 0, z);
  cac.scale.setScalar(s);
  group.add(cac);
}

// Faceted sandstone chunks and dry desert brush for floor dressing.
const ROCK_MATS = [0xc4652f, 0xb3502a, 0xd4784a].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 1, flatShading: true }));
function desertRock(group, x, z, s = 1) {
  const rock = new THREE.Mesh(
    new THREE.DodecahedronGeometry(26, 0),
    ROCK_MATS[Math.floor(Math.random() * ROCK_MATS.length)],
  );
  rock.scale.set(s * (0.8 + Math.random() * 0.5), s * 0.7, s * (0.8 + Math.random() * 0.5));
  rock.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
  rock.position.set(x, 10 * s, z);
  rock.castShadow = true;
  group.add(rock);
}
const BUSH_MAT = new THREE.MeshStandardMaterial({ color: 0x8a8a3c, roughness: 1, flatShading: true });
function dryBush(group, x, z, s = 1) {
  const bush = new THREE.Mesh(new THREE.IcosahedronGeometry(16, 0), BUSH_MAT);
  bush.scale.set(s * 1.3, s * 0.8, s * 1.2);
  bush.rotation.y = Math.random() * 3;
  bush.position.set(x, 9 * s, z);
  bush.castShadow = true;
  group.add(bush);
}

// A weathered roadside billboard on two posts.
function billboard(group, x, z, text, color) {
  const posts = new THREE.MeshStandardMaterial({ color: 0x6b5a4a, roughness: 1, flatShading: true });
  for (const dx of [-170, 170]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 260, 7), posts);
    post.position.set(x + dx, 130, z);
    group.add(post);
  }
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(480, 180, 14),
    new THREE.MeshStandardMaterial({ color: 0xf2e2c4, roughness: 0.9, flatShading: true }),
  );
  board.position.set(x, 330, z);
  board.castShadow = true;
  group.add(board);
  const sign = makeTextSprite(text, { px: 58, color, w: 1024 });
  sign.position.set(x, 330, z + 20);
  group.add(sign);
}

// A chunky cartoon palm: leaning trunk segments + a mop of droopy leaves.
const PALM_TRUNK = new THREE.MeshStandardMaterial({ color: 0xc79a5e, roughness: 0.9, flatShading: true });
const PALM_LEAF = new THREE.MeshStandardMaterial({ color: 0x3fae52, roughness: 0.8, side: THREE.DoubleSide, flatShading: true });
const PALM_LEAF_GEO = new THREE.ConeGeometry(13, 110, 6).scale(1, 1, 0.28);
function palmTree(group, x, z, s = 1) {
  const palm = new THREE.Group();
  const lean = Math.random() * 0.5 - 0.25;
  let px = 0, py = 0;
  for (let i = 0; i < 5; i++) {
    const seg = new THREE.Mesh(new THREE.CylinderGeometry(9 - i, 11 - i, 62, 10), PALM_TRUNK);
    px += lean * 16;
    py += 55;
    seg.position.set(px, py - 28, 0);
    seg.rotation.z = -lean * 0.35;
    seg.castShadow = true;
    palm.add(seg);
  }
  for (let i = 0; i < 7; i++) {
    const piv = new THREE.Group();
    piv.position.set(px, py + 8, 0);
    piv.rotation.y = (i / 7) * Math.PI * 2;
    const leaf = new THREE.Mesh(PALM_LEAF_GEO, PALM_LEAF);
    leaf.position.x = 46;
    leaf.rotation.z = -Math.PI / 2 - 0.45; // tip out and drooping
    leaf.castShadow = true;
    piv.add(leaf);
    palm.add(piv);
  }
  const coco = new THREE.Mesh(new THREE.SphereGeometry(11, 10, 8), PALM_TRUNK);
  coco.position.set(px, py, 0);
  palm.add(coco);
  palm.position.set(x, 0, z);
  palm.scale.setScalar(s);
  group.add(palm);
  return palm;
}

// The Pit Boss's felt table, zones, and card rig.
function buildBjTable(group) {
  const refs = {};
  const felt = new THREE.Mesh(
    new THREE.CylinderGeometry(130, 138, 46, 12),
    new THREE.MeshStandardMaterial({ color: 0x148a4a, roughness: 0.6 }),
  );
  felt.position.set(C.HUB.TABLE.x, 23, C.HUB.TABLE.y);
  felt.castShadow = true;
  group.add(felt);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(132, 7, 12, 40),
    new THREE.MeshStandardMaterial({ color: 0xffd84d, emissive: 0xcf9b10, emissiveIntensity: 0.5, metalness: 0.6, roughness: 0.3 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.set(C.HUB.TABLE.x, 46, C.HUB.TABLE.y);
  group.add(rim);

  const bossChar = buildCharacter('#241d35', { hatIndex: 1, eyeColor: 0xff3030, scale: 1.45, skinIndex: 4 });
  const boss = bossChar.root;
  const bowtie = new THREE.Mesh(new THREE.BoxGeometry(4, 6, 14), HAT_RED);
  bowtie.position.set(21, 62, 0);
  boss.add(bowtie);
  boss.rotation.y = -Math.PI / 2;
  boss.position.set(C.HUB.TABLE.x, 0, C.HUB.TABLE.y - 215);
  group.add(boss);
  refs.boss = boss;
  refs.bossChar = bossChar;
  const bossLight = new THREE.PointLight(0xffd84d, 24000, 700);
  bossLight.position.set(C.HUB.TABLE.x, 260, C.HUB.TABLE.y);
  group.add(bossLight);
  const deck = makeCardMesh('BACK');
  deck.rotation.x = -Math.PI / 2;
  deck.position.set(C.HUB.TABLE.x + 60, 48, C.HUB.TABLE.y - 20);
  group.add(deck);

  const mkZone = (z, color) => {
    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(z.r, z.r, 4, 36),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1 }),
    );
    disc.position.set(z.x, 2, z.y);
    group.add(disc);
    return disc;
  };
  refs.hitZone = mkZone(C.HUB.HIT, 0x7cfc00);
  refs.standZone = mkZone(C.HUB.STAND, 0xff6ec7);
  refs.hitLabel = makeTextSprite('HIT 👊', { px: 46, color: '#7CFC00' });
  refs.hitLabel.position.set(C.HUB.HIT.x, 150, C.HUB.HIT.y);
  refs.standLabel = makeTextSprite('STAND ✋', { px: 46, color: '#FF6EC7' });
  refs.standLabel.position.set(C.HUB.STAND.x, 150, C.HUB.STAND.y);
  group.add(refs.hitLabel, refs.standLabel);

  refs.cardMeshes = [];
  refs.cardSig = '';
  refs.bjInfo = makeTextSprite(' ', { px: 44, color: '#FFD84D', w: 1024 });
  refs.bjInfo.position.set(C.HUB.TABLE.x, 290, C.HUB.TABLE.y - 40);
  group.add(refs.bjInfo);
  return refs;
}

function updateBjTable(dt, refs, bj) {
  const zonesActive = bj && bj.state === 'voting';
  refs.hitZone.material.opacity = zonesActive ? 0.3 + Math.sin(time * 8) * 0.1 : 0.08;
  refs.standZone.material.opacity = zonesActive ? 0.3 + Math.cos(time * 8) * 0.1 : 0.08;
  refs.hitLabel.userData.set(zonesActive ? `HIT 👊 ×${bj.hitIds.length}` : 'HIT 👊');
  refs.standLabel.userData.set(zonesActive ? `STAND ✋ ×${bj.standIds.length}` : 'STAND ✋');
  refs.boss.rotation.y = -Math.PI / 2 + Math.sin(time * 0.9) * 0.12;
  refs.bossChar.armR.rotation.z = -1.1 + Math.sin(time * 2.2) * 0.15;
  refs.bossChar.armL.rotation.z = Math.sin(time * 1.7) * 0.1;

  if (bj) {
    const dealerCards = bj.dealer || [bj.dealerUp, 'BACK'];
    const sig = bj.squad.join() + '|' + dealerCards.join() + '|' + (bj.outcome || '');
    if (sig !== refs.cardSig) {
      refs.cardSig = sig;
      for (const c of refs.cardMeshes) c.parent.remove(c);
      refs.cardMeshes = [];
      const deal = (codes, z, y) => {
        codes.forEach((code, i) => {
          const mesh = makeCardMesh(code);
          const x = C.HUB.TABLE.x - ((codes.length - 1) * 74) / 2 + i * 74;
          mesh.position.set(C.HUB.TABLE.x + 240, 160, C.HUB.TABLE.y - 160);
          mesh.userData.target = new THREE.Vector3(x, y, z);
          arena.group.add(mesh);
          refs.cardMeshes.push(mesh);
        });
      };
      deal(dealerCards, C.HUB.TABLE.y - 60, 150);
      deal(bj.squad, C.HUB.TABLE.y + 105, 110);
      sfx.click();
    }
    for (const c of refs.cardMeshes) c.position.lerp(c.userData.target, Math.min(1, dt * 7));
    if (bj.state === 'done') {
      const msg = bj.outcome === 'natural' ? `💎 NATURAL 21 — THE BOYS (${bj.squadTotal})`
        : bj.outcome === 'win' ? `🎉 BOYS ${bj.squadTotal} — BOSS ${bj.dealerTotal}`
        : bj.outcome === 'push' ? `😤 PUSH ${bj.squadTotal}–${bj.dealerTotal}`
        : `💀 BOSS ${bj.dealerTotal} — BOYS ${bj.squadTotal}`;
      refs.bjInfo.userData.set(msg, bj.outcome === 'lose' ? '#FF7676' : bj.outcome === 'push' ? '#FFD84D' : '#7CFC00');
    } else {
      refs.bjInfo.userData.set(`THE BOYS: ${bj.squadTotal} — votes lock in ${Math.ceil(bj.voteLeft ?? 0)}`, '#FFD84D');
    }
    refs.bjInfo.visible = true;
  } else {
    refs.bjInfo.visible = false;
    if (refs.cardMeshes.length) {
      for (const c of refs.cardMeshes) c.parent.remove(c);
      refs.cardMeshes = [];
      refs.cardSig = '';
    }
  }
}

// The whole world is faceted toy-diorama low poly: every environment material
// gets flat shading (eyes and anything marked userData.smooth stay round).
function facetify(root) {
  root.traverse(o => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m.isMeshStandardMaterial && !m.flatShading && !m.userData.smooth) {
        m.flatShading = true;
        m.needsUpdate = true;
      }
    }
  });
}

function buildArena(kind) {
  if (arena) clearGroup(arena.group);
  const group = new THREE.Group();
  scene.add(group);
  arena = { kind, group, fx: [] };
  mapMode = (kind === 'chained' || kind === 'peak') ? 'mountain' : 'flat';
  if (kind !== 'dig') setMood(BG);

  if (kind === 'hub') {
    buildDenRoom(group);
    addDrifters(group, { count: 60, color: 0xffd890, size: 4, opacity: 0.28, box: [100, 1500, 60, 440, 60, 840], vy: 7 });
    // THE GATE (north): a big dumb faceted arch, like every good cartoon canyon
    const archMat = new THREE.MeshStandardMaterial({ color: 0x52c25e, roughness: 0.8, flatShading: true });
    const arch = new THREE.Mesh(new THREE.TorusGeometry(330, 62, 6, 9, Math.PI), archMat);
    arch.position.set(C.HUB.GATE.x, 20, 40);
    arch.castShadow = true;
    group.add(arch);
    for (let i = 1; i < 8; i++) { // studs along the arch, because the arch demanded them
      const a = (i / 8) * Math.PI;
      const stud = new THREE.Mesh(new THREE.SphereGeometry(16, 6, 4), new THREE.MeshStandardMaterial({ color: 0x3a9a46, roughness: 0.8, flatShading: true }));
      stud.position.set(C.HUB.GATE.x + Math.cos(a) * 330, 20 + Math.sin(a) * 330, 105);
      group.add(stud);
    }
    const opening = new THREE.Mesh(new THREE.BoxGeometry(480, 300, 18), new THREE.MeshBasicMaterial({ color: 0x05030c }));
    opening.position.set(C.HUB.GATE.x, 150, 30);
    group.add(opening);
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(480, 250, 46),
      new THREE.MeshStandardMaterial({ color: 0x6b5a9e, roughness: 0.5, emissive: 0x2a1a4a, emissiveIntensity: 0.6 }),
    );
    door.position.set(C.HUB.GATE.x, 125, 40);
    door.castShadow = true;
    group.add(door);
    arena.door = door;
    const zone = new THREE.Mesh(
      new THREE.BoxGeometry(C.HUB.GATE.w, 3, C.HUB.GATE.h),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.16 }),
    );
    zone.position.set(C.HUB.GATE.x, 2, C.HUB.GATE.y);
    group.add(zone);
    arena.gateZone = zone;
    arena.gateSign = makeTextSprite(' ', { px: 46, color: '#00E5FF', w: 1024 });
    arena.gateSign.position.set(C.HUB.GATE.x, 440, 60);
    group.add(arena.gateSign);
    const marquee = makeTextSprite('✨ F R I E N D S L O P ✨', { px: 54, color: '#FF6EC7', w: 1024 });
    marquee.position.set(C.HUB.GATE.x, 500, 40);
    group.add(marquee);
    arena.gateCd = makeTextSprite(' ', { px: 62, color: '#7CFC00' });
    arena.gateCd.position.set(C.HUB.GATE.x, 210, C.HUB.GATE.y + 70);
    group.add(arena.gateCd);
    // the boss's corner (decor between runs — his real table is in the casino)
    arena.bj = buildBjTable(group);
    const crown = makeTextSprite('👑', { px: 90, color: '#FFD84D' });
    crown.position.set(90, 330, CZ - 120);
    group.add(crown);
    // big banner + standings
    arena.banner = makeTextSprite(' ', { px: 40, color: '#FFD84D', w: 1024 });
    arena.banner.position.set(CX, 440, CZ - 60);
    arena.banner.scale.set(1024 * 0.44, 56, 1);
    group.add(arena.banner);
    arena.standRows = [];
    arena.confettiT = 0;
  } else if (kind === 'casino') {
    buildDenRoom(group);
    addDrifters(group, { count: 60, color: 0xffd890, size: 4, opacity: 0.28, box: [100, 1500, 60, 440, 60, 840], vy: 7 });
    arena.bj = buildBjTable(group);
    const marquee = makeTextSprite("🎩 THE BOSS'S CASINO 🎩", { px: 52, color: '#FFD84D', w: 1024 });
    marquee.position.set(CX, 470, 60);
    group.add(marquee);
  } else if (kind === 'dig') {
    setMood(0xa8d0e8, 3000, 6800); // daylight up in Slopshire
    skyDome(group, '#4a8ac8', '#a8d0e8', '#d8e8c8');
    addClouds(group, 6, 750);
    // grassy village ground framing the dig site (a hole needs a rim)
    const grass = new THREE.MeshStandardMaterial({ color: 0x3f8f2c, roughness: 0.95, map: paintedGround('#3f8f2c', ['#2d6e1f', '#4a9a34', '#26611b', '#57ab3e'], { cracks: 0 }) });
    for (const [w, d, x, z] of [
      [4600, 1500, CX, -760], [4600, 1500, CX, C.ARENA_H + 760],
      [1500, 960, -760, CZ], [1500, 960, C.ARENA_W + 760, CZ],
    ]) {
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w, 40, d), grass);
      strip.position.set(x, -21, z);
      strip.receiveShadow = true;
      group.add(strip);
    }
    // SLOPSHIRE: the inn, cottages, trees, lamps
    const inn = timberHouse(group, CX, -420, 0, 1.4);
    const innSign = makeTextSprite("🦁 THE LION'S SLOP INN", { px: 44, color: '#FFD84D', w: 1024 });
    innSign.position.set(CX, 330, -300);
    group.add(innSign);
    const shire = makeTextSprite('⚔️ SLOPSHIRE ⚔️', { px: 40, color: '#e8dfc8', w: 1024 });
    shire.position.set(CX, 470, -430);
    group.add(shire);
    timberHouse(group, -360, 300, 0.9, 0.9);
    timberHouse(group, C.ARENA_W + 380, 620, -0.8, 0.85);
    tree(group, -280, 750, 1.2); tree(group, -420, 60, 1);
    tree(group, C.ARENA_W + 300, 130, 1.1); tree(group, C.ARENA_W + 460, 380, 0.9);
    tree(group, 220, -350, 1); tree(group, 1420, -390, 1.15);
    tree(group, 380, C.ARENA_H + 320, 1.05); tree(group, 1240, C.ARENA_H + 380, 0.95);
    lamppost(group, -60, -60); lamppost(group, C.ARENA_W + 60, -60);
    lamppost(group, -60, C.ARENA_H + 60); lamppost(group, C.ARENA_W + 60, C.ARENA_H + 60);
    // the shaft walls, earthier now
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 1 });
    for (const [w, x, z, ry] of [[1700, CX, -8, 0], [1700, CX, C.ARENA_H + 8, Math.PI], [940, -8, CZ, Math.PI / 2], [940, C.ARENA_W + 8, CZ, -Math.PI / 2]]) {
      const wall = new THREE.Mesh(new THREE.PlaneGeometry(w, 1000), wallMat);
      wall.position.set(x, -440, z);
      wall.rotation.y = ry;
      group.add(wall);
    }
    // and all the way down: THE GRAND SLOPCHANGE
    const gePlate = floorBox(group, 1700, 1000, 0xffffff, pixelTexture('#cbb98a', ['#b3a276', '#dbc99a'], 10), -420, 30);
    gePlate.material.flatShading = true;
    buildSlopchange(group, -405);
    arena.digLayers = []; // built on demand from extras
  } else if (kind === 'rv') {
    // CHAOS CANYON: bright blue sky, stacked terracotta mesas, cacti —
    // faceted toy-diorama low poly
    skyDome(group, '#3f96e8', '#a8d8f0', '#f2d4a0');
    setMood(0xd8a870, 2600, 6200);
    addClouds(group, 6, 700, 0xffffff, 0.75);
    const canyon = new THREE.Mesh(
      roughen(new THREE.CylinderGeometry(2500, 2400, 1500, 26, 6, true), 70),
      new THREE.MeshStandardMaterial({ color: 0xc4652f, roughness: 1, flatShading: true, side: THREE.BackSide }),
    );
    canyon.position.set(CX, 500, CZ);
    group.add(canyon);
    // stacked mesa buttes around the rim — chamfered slabs, lighter every tier
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.35;
      mesa(group, CX + Math.cos(a) * 1720, CZ + Math.sin(a) * 1320, 0.8 + Math.random() * 0.7);
    }
    // cacti dotted around the pit floor edges and the rim
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 1.1;
      cactus(group, CX + Math.cos(a) * (1150 + Math.random() * 350), CZ + Math.sin(a) * (800 + Math.random() * 300), 0.8 + Math.random() * 0.8);
    }
    cactus(group, 120, 90, 1.1); cactus(group, C.ARENA_W - 90, C.ARENA_H - 70, 0.9);
    // the big dumb billboard
    billboard(group, CX - 350, -640, 'R.V. SLOP YET? →', '#c23a2e');
    // rubble + dry brush so the pit floor reads as desert, not a void
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + 0.7;
      desertRock(group,
        CX + Math.cos(a) * (920 + Math.random() * 260),
        CZ + Math.sin(a) * (620 + Math.random() * 220),
        0.5 + Math.random() * 1.4);
    }
    for (let i = 0; i < 10; i++) {
      dryBush(group, 60 + Math.random() * (C.ARENA_W - 120), Math.random() < 0.5 ? 40 + Math.random() * 90 : C.ARENA_H - 40 - Math.random() * 90, 0.7 + Math.random() * 0.8);
    }
    addDrifters(group, { count: 70, color: 0xffcf90, size: 5, opacity: 0.3, box: [0, 1600, 10, 300, 0, 900], vy: 6 });
    floorBox(group, 1760, 1020, 0xdca55e, paintedGround('#dca55e', ['#c28f4a', '#e8b878', '#ab7a3c', '#d19a52'], { cracks: 14 }));
    arena.mudDiscs = [];
    // exit garage on the east wall
    const garage = new THREE.Mesh(
      new THREE.BoxGeometry(30, 260, 420),
      new THREE.MeshStandardMaterial({ color: 0x2c5c2c, emissive: 0x2fbb2f, emissiveIntensity: 0.6 }),
    );
    garage.position.set(C.ARENA_W + 10, 130, CZ);
    group.add(garage);
    const exitSign = makeTextSprite('EXIT →', { px: 60, color: '#7CFC00' });
    exitSign.position.set(C.ARENA_W - 80, 260, CZ);
    group.add(exitSign);
    // the RV itself
    const rv = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(200, 105, 110),
      new THREE.MeshStandardMaterial({ color: 0xf5eedd, roughness: 0.55 }));
    body.position.y = 85;
    body.castShadow = true;
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(202, 22, 112),
      new THREE.MeshStandardMaterial({ color: 0xc2502a, roughness: 0.55 }));
    stripe.position.y = 78;
    const cab = new THREE.Mesh(new THREE.BoxGeometry(70, 70, 104),
      new THREE.MeshStandardMaterial({ color: 0xb8ae96, roughness: 0.5 }));
    cab.position.set(125, 60, 0);
    cab.castShadow = true;
    const winMat = new THREE.MeshStandardMaterial({ color: 0x9adfff, roughness: 0.2, emissive: 0x224455, emissiveIntensity: 0.4 });
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(6, 34, 84), winMat);
    windshield.position.set(161, 70, 0);
    rv.add(body, stripe, cab, windshield);
    arena.wheels = [];
    for (const [wx, wz] of [[-60, -58], [-60, 58], [90, -58], [90, 58]]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(26, 26, 16, 14), HAT_DARK);
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(wx, 26, wz);
      rv.add(wheel);
      arena.wheels.push(wheel);
    }
    group.add(rv);
    arena.rv = rv;
  } else if (kind === 'cham') {
    skyDome(group, '#12124a', '#2a2a6e', '#141438');
    setMood(0x1c1c52, 2000, 5200);
    addCave(group);
    floorBox(group, 1760, 1020, 0x3d3468, paintedGround('#3d3468', ['#2a2250', '#4a4080', '#332b5c'], { cracks: 8, speckle: 300 }));
    const moonSprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: flameTexture(), color: 0xd8e0ff, transparent: true, opacity: 0.95, fog: false }));
    moonSprite.scale.set(260, 260, 1);
    moonSprite.position.set(CX + 900, 1100, CZ - 1600);
    group.add(moonSprite);
    const moon = new THREE.PointLight(0xa0b0ff, 26000, 1600);
    moon.position.set(CX, 520, CZ);
    group.add(moon);
    addDrifters(group, { count: 50, color: 0x9dff2e, size: 4, opacity: 0.5, box: [100, 1500, 20, 200, 100, 800], vy: 4 });
    arena.statues = new Map();
  } else { // chained | peak — same wall, two different worlds
    const base = toWorld(CX, 900), top = toWorld(CX, 0);
    const mid = base.clone().add(top).multiplyScalar(0.5);
    const len = base.distanceTo(top) + 260;
    const cliffGeo = roughen(new THREE.PlaneGeometry(2300, len, 42, 22), 34);
    let cliffMat;
    if (kind === 'chained') {
      setMood(0x0c1410, 1500, 3400);
      cliffMat = new THREE.MeshStandardMaterial({ color: 0x24343a, roughness: 1, flatShading: true });
      // cave all around
      const cave = new THREE.Mesh(
        roughen(new THREE.CylinderGeometry(2400, 2400, 3200, 26, 6, true), 90),
        new THREE.MeshStandardMaterial({ color: 0x101d18, roughness: 1, flatShading: true, side: THREE.BackSide }),
      );
      cave.position.set(CX, 800, CZ);
      group.add(cave);
      // green murk drifting up from the tide
      addDrifters(group, { count: 80, color: 0x9dff2e, size: 6, opacity: 0.35, box: [-200, 1800, 0, 800, 100, 800], vy: 26 });
    } else {
      // dawn on the mountain — pink alpenglow, soft clay rock
      skyDome(group, '#3a4a94', '#ff9a6a', '#ffd0a0');
      setMood(0xe09a72, 2600, 5600);
      addClouds(group, 7, 620, 0xffd8c0, 0.55);
      cliffMat = new THREE.MeshStandardMaterial({ color: 0x8a6a5c, roughness: 1, flatShading: true });
      // distant range
      for (let i = 0; i < 4; i++) {
        const mtn = new THREE.Mesh(
          roughen(new THREE.ConeGeometry(600 + Math.random() * 400, 900 + Math.random() * 500, 7), 60),
          new THREE.MeshStandardMaterial({ color: 0x584a80, roughness: 1, flatShading: true }),
        );
        mtn.position.set(-1400 + i * 1200 + Math.random() * 300, 260, -1700 - Math.random() * 700);
        group.add(mtn);
      }
      // falling snow
      addDrifters(group, { count: 130, color: 0xffffff, size: 5, opacity: 0.7, box: [-200, 1800, 0, 950, -200, 900], vy: -34 });
      const sun = new THREE.PointLight(0xffb070, 60000, 4000);
      sun.position.set(2200, 900, -800);
      group.add(sun);
    }
    const cliff = new THREE.Mesh(cliffGeo, cliffMat);
    cliff.position.set(mid.x, mid.y, mid.z - 44);
    cliff.rotation.x = -Math.atan2(base.z - top.z, top.y - base.y);
    cliff.receiveShadow = true;
    group.add(cliff);
    floorBox(group, 4000, 3000, kind === 'chained' ? 0x0d1a12 : 0x2a2438, null, -40, 40);
    arena.ledgeMeshes = [];
    arena.vineMeshes = [];
    arena.globViews = new Map();
    if (kind === 'chained') {
      const tide = new THREE.Mesh(
        new THREE.BoxGeometry(2400, 60, 1400),
        new THREE.MeshStandardMaterial({
          color: 0x9dff2e, emissive: 0x71c216, emissiveIntensity: 0.9,
          transparent: true, opacity: 0.85, roughness: 0.2,
        }),
      );
      tide.position.set(CX, -80, 760);
      group.add(tide);
      arena.tideMesh = tide;
      const tideLight = new THREE.PointLight(0x8ae82e, 40000, 2200);
      tideLight.position.set(CX, -60, 720);
      group.add(tideLight);
      arena.tideLight = tideLight;
      arena.fx.push(() => { tideLight.intensity = 40000 * (0.85 + Math.sin(time * 6) * 0.15); });
    }
    const flag = makeTextSprite('🏁 THE TOP 🏁', { px: 52, color: '#7CFC00' });
    const fp = toWorld(CX, 40, 130);
    flag.position.copy(fp);
    group.add(flag);
  }
  facetify(group);
  return arena;
}

function ensureArena(kind) {
  if (!kind) return;
  if (!arena || arena.kind !== kind) buildArena(kind);
}

// ---- arena updates -----------------------------------------------------------------

function updateHub(dt, ex, S) {
  const m = S.meta;
  const info = C.MINIGAME_INFO[m?.minigame] || {};
  const gateActive = ex?.hub === 'lobby' || ex?.hub === 'gate';
  arena.gateSign.userData.set(
    gateActive ? `${info.icon || ''} CHAMBER ${(m?.chamber ?? 0) + 1}: ${info.name || ''}` : ' ',
  );
  if (ex?.gate) {
    const g = ex.gate;
    const armed = g.cd != null;
    arena.gateZone.material.color.set(armed ? 0x7cfc00 : 0x00e5ff);
    arena.gateZone.material.opacity = (armed ? 0.3 : 0.16) + Math.sin(time * (armed ? 10 : 3)) * 0.06;
    arena.gateCd.userData.set(
      armed ? `${Math.ceil(g.cd)}` : `${g.in.length}/${g.total} in — need ${g.need}`,
      armed ? '#7CFC00' : '#9b8fc0',
    );
    const doorTarget = armed ? 380 : 130;
    arena.door.position.y += (doorTarget - arena.door.position.y) * Math.min(1, dt * 3);
  } else {
    arena.gateCd.userData.set(' ');
    arena.gateZone.material.opacity = 0.06;
    arena.door.position.y += (130 - arena.door.position.y) * Math.min(1, dt * 3);
  }

  updateBjTable(dt, arena.bj, null);

  if (ex?.banner) {
    arena.banner.visible = true;
    arena.banner.userData.set(ex.banner.text, ex.banner.color);
  } else {
    arena.banner.visible = false;
  }

  const st = ex?.standings;
  if (st) {
    while (arena.standRows.length < st.length) {
      const row = makeTextSprite(' ', { px: 40, color: '#fff', w: 1024 });
      arena.group.add(row);
      arena.standRows.push(row);
    }
    st.forEach((s, i) => {
      const row = arena.standRows[i];
      row.visible = true;
      row.userData.set(`${['🥇', '🥈', '🥉'][i] || (i + 1) + '.'} ${s.name} — ${s.coins}💰`, s.color);
      row.position.set(CX, 380 - i * 48, CZ - 30);
    });
    for (let i = st.length; i < arena.standRows.length; i++) arena.standRows[i].visible = false;
    arena.confettiT -= dt;
    if (ex.escaped && arena.confettiT <= 0) { arena.confettiT = 1.4; confetti(); }
  } else {
    for (const r of arena.standRows) r.visible = false;
  }
}

function updateDig(dt, ex, S) {
  if (!ex?.layers) return;
  const { cols, rows, tile } = ex;
  if (!arena.digLayers.length) {
    // one continuous painted ground per floor — tiles carve it, no checkerboard
    const plates = [
      { tex: goldshireField(), tint: 0x9a7a52 },
      { tex: dirtField(), tint: 0x6b4f2e },
      { tex: rockField(), tint: 0x666670 },
    ];
    for (let l = 0; l < ex.layers.length; l++) {
      const p = plates[Math.min(l, plates.length - 1)];
      const baseMat = new THREE.MeshStandardMaterial({ map: p.tex, roughness: 0.92 });
      const crackMat = new THREE.MeshStandardMaterial({ map: p.tex, roughness: 1, color: p.tint });
      const meshes = [];
      for (let i = 0; i < cols * rows; i++) {
        const tx = (i % cols) * tile, tz = Math.floor(i / cols) * tile;
        const geo = new THREE.BoxGeometry(tile, 26, tile);
        // planar-project UVs so the field texture flows across every tile
        const pos = geo.attributes.position, uv = geo.attributes.uv;
        for (let vI = 0; vI < uv.count; vI++) {
          uv.setXY(vI,
            (tx + tile / 2 + pos.getX(vI)) / (cols * tile),
            1 - (tz + tile / 2 + pos.getZ(vI)) / (rows * tile));
        }
        const m = new THREE.Mesh(geo, baseMat);
        m.userData.baseMat = baseMat;
        m.userData.crackMat = crackMat;
        m.position.set(tx + tile / 2, -13 - l * 130, tz + tile / 2);
        m.receiveShadow = true;
        arena.group.add(m);
        meshes.push(m);
      }
      arena.digLayers.push({ meshes, states: new Array(cols * rows).fill('0') });
    }
  }
  // floors above you get out of the camera's way
  const selfLayer = ex.pl?.[S.selfId] ?? 0;
  for (let l = 0; l < ex.layers.length && l < arena.digLayers.length; l++) {
    const str = ex.layers[l];
    const layer = arena.digLayers[l];
    const hidden = l < selfLayer;
    for (let i = 0; i < str.length; i++) {
      const st = str[i], prev = layer.states[i];
      const m = layer.meshes[i];
      if (st === prev) {
        if (m.userData.falling) {
          m.userData.vy -= 2600 * dt;
          m.position.y += m.userData.vy * dt;
          m.rotation.x += dt * 2;
          if (m.position.y < -900) { m.userData.falling = false; m.userData.gone = true; }
        }
        m.visible = !hidden && !m.userData.gone && (st !== '2' || m.userData.falling);
        continue;
      }
      layer.states[i] = st;
      if (st === '1') m.material = m.userData.crackMat;
      else if (st === '2') { m.userData.falling = true; m.userData.vy = -50; }
      else m.material = m.userData.baseMat;
      m.visible = !hidden;
    }
  }
}

function updateRv(dt, ex) {
  if (ex?.mud && !arena.mudDiscs.length) {
    for (const [x, y, r] of ex.mud) {
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(r, r, 6, 30),
        new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.25 }),
      );
      disc.position.set(x, 2, y);
      arena.group.add(disc);
      arena.mudDiscs.push(disc);
    }
  }
  if (ex?.rv && arena.rv) {
    const [x, y] = ex.rv;
    const prev = arena.rv.position.clone();
    arena.rv.position.lerp(new THREE.Vector3(x, 0, y), Math.min(1, dt * 8));
    const moved = arena.rv.position.distanceTo(prev) / Math.max(dt, 1e-4);
    for (const w of arena.wheels) w.rotation.z -= moved * dt * 0.04;
    arena.rv.position.y = Math.abs(Math.sin(time * 7)) * (ex.inMud ? 1 : Math.min(4, moved * 0.02));
    arena.rv.rotation.z = Math.sin(time * 5) * Math.min(0.03, moved * 0.0002);
  }
  syncGremlins(ex?.gremlins || []);
}

function updateCham(dt, ex, S) {
  if (!ex?.decoys) return;
  const seen = new Set();
  for (const [id, x, y, mimic, face] of ex.decoys) {
    seen.add(id);
    let st = arena.statues.get(id);
    if (!st) {
      const info = S.meta?.players.find(p => p.id === mimic);
      const char = buildCharacter(info?.color || '#888888', { hatIndex: mimic % 5, skinIndex: mimic % 6 });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(44, 50, 10, 20), MAT.statueBase);
      base.position.set(x, 5, y);
      char.root.position.set(x, 10, y);
      char.root.rotation.y = -face;
      // statues pose: arms slightly raised, mid-stride
      char.armL.rotation.z = -0.5;
      char.armR.rotation.z = 0.4;
      char.legL.rotation.z = 0.25;
      char.legR.rotation.z = -0.25;
      arena.group.add(base, char.root);
      st = { char, base, x, y };
      arena.statues.set(id, st);
    }
    // the tell: the real one twitches
    if (ex.tell === id) {
      st.char.root.rotation.z = Math.sin(time * 26) * 0.09;
      st.char.head.rotation.y = Math.sin(time * 18) * 0.35;
    } else {
      st.char.root.rotation.z = 0;
      st.char.head.rotation.y = 0;
    }
  }
  for (const [id, st] of arena.statues) {
    if (!seen.has(id)) {
      burst3(new THREE.Vector3(st.x, 40, st.y), '#8a8298', 24, { speed: 340, life: 0.8 });
      burst3(new THREE.Vector3(st.x, 40, st.y), '#55506e', 14, { speed: 220, life: 0.7 });
      arena.group.remove(st.char.root, st.base);
      arena.statues.delete(id);
    }
  }
}

const SLAB_DEFS = [
  { big: '0FFBRAND', small: 'r.i.p. — no longer a company', fg: '#ffffff', bg: '#101014' },
  { big: '0TK', small: 'ONE TRUE SLOP', fg: '#14100a', bg: '#d8c9a0' },
  { big: 'F4ZE', small: '#SLOPPEDUP', fg: '#ff3838', bg: '#0b0b0d' },
];
function slabTexture(def) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = def.bg;
  g.fillRect(0, 0, 512, 256);
  g.strokeStyle = def.fg;
  g.lineWidth = 10;
  g.strokeRect(14, 14, 484, 228);
  g.fillStyle = def.fg;
  g.textAlign = 'center';
  g.font = 'bold 96px Trebuchet MS';
  g.fillText(def.big, 256, 128);
  g.font = 'bold 30px Trebuchet MS';
  g.fillText(def.small, 256, 196);
  return canvasTex(cv);
}
function dropSlab(idx, leaderId) {
  const def = SLAB_DEFS[idx % SLAB_DEFS.length];
  const lead = views.get(leaderId) || [...views.values()][0];
  if (!lead) return;
  const mat = new THREE.MeshStandardMaterial({ map: slabTexture(def), roughness: 0.6 });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(300, 150, 34), mat);
  const lp = lead.group.position;
  const groundY = lp.y;
  slab.position.set(Math.max(220, Math.min(1380, lp.x + 150)), lp.y + 950, lp.z - 30);
  slab.rotation.y = -0.25;
  slab.castShadow = true;
  arena.group.add(slab);
  let vy = 0, landed = false;
  arena.fx.push(dt2 => {
    if (landed) return;
    vy -= 2400 * dt2;
    slab.position.y += vy * dt2;
    slab.rotation.x = Math.sin(time * 3) * 0.05;
    if (slab.position.y <= groundY + 75) {
      slab.position.y = groundY + 75;
      landed = true;
      slab.rotation.z = 0.06;
      shakeAmt = Math.max(shakeAmt, 26);
      sfx.boom();
      burst3(slab.position.clone().setY(groundY + 20), '#c9b9a0', 30, { speed: 420, up: 260, life: 0.9, size: 1.4 });
      addFloater(slab.position.clone().setY(groundY), 'A VERY IMPORTANT SPONSOR', '#ffd84d', 36);
    }
  });
}

function updateMountain(dt, ex) {
  if (!ex?.ledges) return;
  if ((ex.milestone || 0) > (arena.mileShown || 0)) {
    for (let m = (arena.mileShown || 0); m < ex.milestone; m++) dropSlab(m, ex.mileLeader);
    arena.mileShown = ex.milestone;
  }
  if (!arena.ledgeMeshes.length) {
    const chained = arena.kind === 'chained';
    const rockMat = new THREE.MeshStandardMaterial({
      color: chained ? 0x35494a : 0x7a6a5c, roughness: 1, flatShading: true,
    });
    const snowMat = new THREE.MeshStandardMaterial({ color: 0xeef2f8, roughness: 0.85 });
    ex.ledges.forEach(([x, y, w], i) => {
      const p = toWorld(x, y);
      const m = new THREE.Mesh(roughen(new THREE.BoxGeometry(w, 22, 96, Math.max(2, Math.round(w / 90)), 1, 2), 9), rockMat);
      m.position.set(p.x, p.y - 6, p.z);
      m.receiveShadow = true;
      m.castShadow = true;
      arena.group.add(m);
      arena.ledgeMeshes.push(m);
      if (!chained) {
        const cap = new THREE.Mesh(new THREE.BoxGeometry(w - 8, 7, 86), snowMat);
        cap.position.set(p.x, p.y + 6, p.z);
        arena.group.add(cap);
      } else if (i % 2 === 1) {
        torch(arena.group, p.x - w / 2 + 26, p.y, p.z + 30);
      }
    });
    const vineMat = chained
      ? new THREE.MeshStandardMaterial({ color: 0x3f9d4c, emissive: 0x3fdb3f, emissiveIntensity: 0.55, roughness: 0.6 })
      : new THREE.MeshStandardMaterial({ color: 0x7da05c, emissive: 0x2f5b1f, emissiveIntensity: 0.15, roughness: 0.8, flatShading: true });
    for (const [x, w, yTop, yBot] of ex.climbs) {
      const a = toWorld(x, yTop), b = toWorld(x, yBot);
      const mid = a.clone().add(b).multiplyScalar(0.5);
      const len = a.distanceTo(b);
      const m = new THREE.Mesh(roughen(new THREE.BoxGeometry(w, len, 12, 2, Math.max(2, Math.round(len / 70)), 1), 6), vineMat);
      m.position.set(mid.x, mid.y, mid.z + 8);
      m.rotation.x = -Math.atan2(b.z - a.z, a.y - b.y);
      arena.group.add(m);
      arena.vineMeshes.push(m);
    }
  }
  // globs
  const seen = new Set();
  for (const [gid, x, y] of ex.globs || []) {
    seen.add(gid);
    let g = arena.globViews.get(gid);
    if (!g) {
      g = new THREE.Mesh(GEO.glob, MAT.glob);
      arena.group.add(g);
      arena.globViews.set(gid, g);
    }
    const p = toWorld(x, y, 24);
    g.position.lerp(p, Math.min(1, dt * 14));
    g.rotation.x += dt * 6;
  }
  for (const [gid, g] of arena.globViews) {
    if (!seen.has(gid)) { arena.group.remove(g); arena.globViews.delete(gid); }
  }
  // the tide
  if (arena.tideMesh && ex.tide != null) {
    const p = toWorld(CX, ex.tide, -26);
    arena.tideMesh.position.y += (p.y - arena.tideMesh.position.y) * Math.min(1, dt * 5);
    arena.tideMesh.position.z = p.z + 60;
    arena.tideMesh.material.emissiveIntensity = 0.7 + Math.sin(time * 9) * 0.25;
    if (arena.tideLight) {
      arena.tideLight.position.y = arena.tideMesh.position.y + 60;
      arena.tideLight.position.z = arena.tideMesh.position.z - 100;
    }
  }
}

function updateArena(dt, extra, S) {
  if (!arena) return;
  for (const fn of arena.fx) fn(dt);
  if (arena.kind === 'hub') updateHub(dt, extra, S);
  else if (arena.kind === 'casino') {
    updateBjTable(dt, arena.bj, extra?.bj || null);
  } else if (arena.kind === 'dig') updateDig(dt, extra, S);
  else if (arena.kind === 'rv') updateRv(dt, extra);
  else if (arena.kind === 'cham') updateCham(dt, extra, S);
  else updateMountain(dt, extra);
}

// ---- gremlins ---------------------------------------------------------------------

function syncGremlins(list) {
  const seen = new Set();
  for (const [gid, x, y, dashing] of list) {
    seen.add(gid);
    let v = gremViews.get(gid);
    if (!v) {
      const group = new THREE.Group();
      const body = new THREE.Mesh(GEO.gremlin, MAT.gremlin);
      body.castShadow = true;
      const e1 = new THREE.Mesh(GEO.pupilH, MAT.gremlinEye);
      const e2 = new THREE.Mesh(GEO.pupilH, MAT.gremlinEye);
      e1.position.set(16, 8, -8); e2.position.set(16, 8, 8);
      group.add(body, e1, e2);
      group.position.set(x, 24, y);
      scene.add(group);
      v = { group, body, x, y };
      gremViews.set(gid, v);
    }
    v.tx = x; v.ty = y; v.dashing = dashing;
  }
  for (const [gid, v] of gremViews) {
    if (!seen.has(gid)) { scene.remove(v.group); gremViews.delete(gid); }
  }
}

function updateGremlinViews(dt) {
  for (const v of gremViews.values()) {
    const k = 1 - Math.pow(0.00002, dt);
    v.x += ((v.tx ?? v.x) - v.x) * k;
    v.y += ((v.ty ?? v.y) - v.y) * k;
    const dx = (v.tx ?? v.x) - v.x, dy = (v.ty ?? v.y) - v.y;
    v.group.position.set(v.x, 24 + Math.abs(Math.sin(time * 9)) * 6, v.y);
    if (Math.hypot(dx, dy) > 1) v.group.rotation.y = -Math.atan2(dy, dx);
    v.body.rotation.x += dt * (v.dashing ? 9 : 2);
  }
}

// ---- ragdolly players ------------------------------------------------------------------

function mkSpring() { return { a: 0, v: 0 }; }
function spring(s, target, dt, k = 170, damp = 11) {
  s.v += (target - s.a) * k * dt;
  s.v *= Math.max(0, 1 - damp * dt);
  s.a += s.v * dt;
  return s.a;
}

function makeBlobView(b) {
  const group = new THREE.Group();
  const yaw = new THREE.Group();
  group.add(yaw);

  const char = buildCharacter(b.color, { hatIndex: b.id % 5, skinIndex: b.id % 6 });
  yaw.add(char.root);

  const aura = new THREE.Mesh(GEO.aura, new THREE.MeshBasicMaterial({
    color: b.color, transparent: true, opacity: 0.3, depthWrite: false,
  }));
  aura.position.y = 50;
  aura.visible = false;
  group.add(aura);

  const label = makeTextSprite(b.name, { px: 40, color: b.color });
  label.position.y = 132;
  group.add(label);

  // voice chat: pops over your head while you're talking
  const mic = makeTextSprite('🔊', { px: 60, stroke: false });
  mic.position.y = 175;
  mic.scale.set(46, 46, 1);
  mic.visible = false;
  group.add(mic);

  const shadow = blobShadow(44);
  shadow.position.y = 1.5;
  group.add(shadow);

  scene.add(group);
  return {
    group, yaw, char, aura, label, mic, shadow,
    face: 0, phase: 0, spinY: 0,
    flailT: 0, emote: null,
    sp: { lL: mkSpring(), lR: mkSpring(), aL: mkSpring(), aR: mkSpring(), lean: mkSpring(), tip: mkSpring(), head: mkSpring() },
  };
}

export function emoteBody(id, e) {
  const v = views.get(id);
  if (v) v.emote = { e, t: 1.6 };
}

function spawnCorpse(b) {
  const char = buildCharacter(b.color, { hatIndex: b.id % 5, skinIndex: b.id % 6 });
  const group = char.root;
  const w = toWorld(b.rx ?? b.x, b.rz ?? b.y, liftFor(b.id) + 10);
  group.position.copy(w);
  scene.add(group);
  corpses.push({ group, char, vy: -60, t: 0 });
}

function updateBlobViews(dt) {
  for (const [id, b] of blobs) {
    let v = views.get(id);
    if (!b.alive) {
      if (v) { scene.remove(v.group); views.delete(id); }
      continue;
    }
    if (!v) { v = makeBlobView(b); views.set(id, v); }

    // THE DE-MAKE: digging deep enough turns you into your 2004 self
    const wantBlocky = arena?.kind === 'dig' && (curExtra?.pl?.[id] ?? 0) >= 2;
    if (v.blocky !== wantBlocky) {
      v.blocky = wantBlocky;
      v.yaw.remove(v.char.root);
      v.char = buildCharacter(b.color, { hatIndex: b.id % 5, blocky: wantBlocky, skinIndex: b.id % 6 });
      v.yaw.add(v.char.root);
      v.axeMesh = null;
      v.axeShown = -2;
      burst3(toWorld(b.rx, b.rz, liftFor(id) + 40), '#e8dfc8', 16, { speed: 200, up: 180, life: 0.6 });
      if (id === selfIdCache) sfx.tater();
    }
    const wantAxe = (arena?.kind === 'dig' || (b.axe || 0) > 0) ? (b.axe || 0) : -1;
    if (v.axeShown !== wantAxe) attachAxe(v, wantAxe);

    const k = 1 - Math.pow(0.00002, dt);
    const jump = Math.hypot(b.tx - b.x, b.ty - b.y);
    if (jump > 380) { b.x = b.tx; b.y = b.ty; }
    else { b.x += (b.tx - b.x) * k; b.y += (b.ty - b.y) * k; }
    b.rx = b.x; b.rz = b.y;

    const dirx = b.tx - b.x, diry = b.ty - b.y;
    const sp = Math.hypot(dirx, diry);
    if (sp > 2) {
      const target = Math.atan2(diry, dirx);
      let d = target - v.face;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      v.face += d * Math.min(1, dt * 10);
    }
    v.yaw.rotation.y = -v.face;

    // real velocity for the walk cycle
    const mvx = b.rx - (v.px ?? b.rx), mvz = b.rz - (v.pz ?? b.rz);
    const vel = Math.hypot(mvx, mvz) / Math.max(dt, 1e-4);
    v.px = b.rx; v.pz = b.rz;
    const st = Math.min(1, vel / 340);
    v.phase += dt * (3 + vel * 0.055);
    const sw = Math.sin(v.phase);

    // ---- pick limb targets: emote > flail > dash > walk ----
    v.flailT = Math.max(0, v.flailT - dt);
    if (v.emote) { v.emote.t -= dt; if (v.emote.t <= 0) v.emote = null; }

    let tLL, tLR, tAL, tAR, tLean, tTip = 0, tHead = 0, bounce = 0, spin = 0;
    if (v.emote) {
      const e = v.emote.e;
      if (e === '😂') {
        bounce = Math.abs(Math.sin(time * 14)) * 10;
        tAL = -2.4 + Math.sin(time * 14) * 0.3; tAR = -2.4 - Math.sin(time * 14) * 0.3;
        tLL = 0; tLR = 0; tLean = 0.12; tHead = Math.sin(time * 14) * 0.15;
      } else if (e === '😭') {
        tAL = 0.15; tAR = -0.15; tLL = 0; tLR = 0;
        tLean = 0.32; tHead = 0.55 + Math.sin(time * 3) * 0.05;
      } else if (e === '💀') {
        tTip = Math.PI / 2 - 0.15;                            // full flop
        tLL = Math.sin(time * 20) * 1.4; tLR = -Math.sin(time * 21) * 1.4;
        tAL = Math.sin(time * 19) * 1.8; tAR = -Math.sin(time * 23) * 1.8;
        tLean = 0;
      } else if (e === '🤬') {
        tLL = Math.sin(time * 19) * 1.1; tLR = -Math.sin(time * 19) * 1.1;
        tAL = -2.2 + Math.sin(time * 22) * 0.8; tAR = -2.2 - Math.sin(time * 22) * 0.8;
        tLean = -0.15; tHead = Math.sin(time * 22) * 0.2; bounce = Math.abs(Math.sin(time * 19)) * 5;
      } else if (e === '👑') {
        tAL = -2.9; tAR = -2.9; tLL = 0; tLR = 0; tLean = -0.2;
        bounce = Math.abs(Math.sin(time * 5)) * 4;
      } else { // 🤡
        spin = dt * 10;
        tLL = 0.4; tLR = -0.4; tAL = -1.4; tAR = -1.4; tLean = 0;
      }
    } else if (v.flailT > 0) {
      tLL = Math.sin(time * 22 + id) * 2.1; tLR = Math.sin(time * 25 + id * 2) * 2.1;
      tAL = Math.sin(time * 27 + id) * 2.4; tAR = Math.sin(time * 21 + id * 3) * 2.4;
      tLean = Math.sin(time * 13) * 0.3;
      tTip = Math.sin(time * 11 + id) * 0.45;
    } else if (b.dashing) {
      tAL = -1.7; tAR = -1.7;
      tLL = sw * 1.2; tLR = -sw * 1.2;
      tLean = -0.5;
    } else {
      tLL = sw * 0.85 * st; tLR = -sw * 0.85 * st;
      tAL = -sw * 0.6 * st; tAR = sw * 0.6 * st;
      tLean = -0.14 * st + Math.sin(time * 2 + id) * 0.02;
      bounce = Math.abs(Math.sin(v.phase)) * 4 * st;
    }

    // floppy springs toward the targets — this is the ragdoll feel
    const ch = v.char;
    ch.legL.rotation.z = spring(v.sp.lL, tLL, dt);
    ch.legR.rotation.z = spring(v.sp.lR, tLR, dt);
    ch.armL.rotation.z = spring(v.sp.aL, tAL, dt, 150, 9);
    ch.armR.rotation.z = spring(v.sp.aR, tAR, dt, 150, 9);
    ch.root.rotation.z = spring(v.sp.lean, tLean, dt, 120, 9);
    ch.root.rotation.x = spring(v.sp.tip, tTip, dt, 90, 8);
    ch.head.rotation.z = spring(v.sp.head, tHead - v.sp.lean.a * 0.5, dt, 130, 9);
    v.spinY += spin;
    if (!spin) v.spinY *= Math.max(0, 1 - 5 * dt);
    ch.root.rotation.y = v.spinY;
    ch.root.position.y = bounce;

    const w = toWorld(b.x, b.y, liftFor(id));
    v.group.position.copy(w);

    v.label.userData.set(b.money != null ? `${b.name} ${b.money}💰` : b.name, b.color);

    v.mic.visible = !!speakingIds?.[id];
    if (v.mic.visible) {
      const pulse = 44 + Math.sin(time * 10) * 5;
      v.mic.scale.set(pulse, pulse, 1);
    }
    v.shadow.visible = mapMode !== 'mountain'; // no flat ground on a cliff face

    v.aura.visible = !!b.dashing;
    if (b.dashing) v.aura.material.opacity = 0.2 + Math.sin(time * 30) * 0.1;
  }
  for (const [id, v] of views) {
    if (!blobs.has(id)) { scene.remove(v.group); views.delete(id); }
  }
}

// ---- the chain (only when the pit chains you) --------------------------------------------

const LINKS_PER_PAIR = 6;
function getLink(i) {
  while (chainPool.length <= i) {
    const m = new THREE.Mesh(GEO.link, MAT.link);
    m.castShadow = true;
    m.visible = false;
    scene.add(m);
    chainPool.push(m);
  }
  return chainPool[i];
}

function updateChain(extra) {
  let li = 0;
  if (extra?.chained) {
    const ordered = [...blobs.values()].filter(b => b.alive && views.has(b.id));
    for (let i = 0; i < ordered.length - 1; i++) {
      const a = ordered[i], b = ordered[i + 1];
      const wa = toWorld(a.rx, a.rz, 44), wb = toWorld(b.rx, b.rz, 44);
      const dist = wa.distanceTo(wb);
      const slack = Math.max(0, 195 - dist);
      const sag = 6 + slack * 0.45;
      for (let j = 1; j <= LINKS_PER_PAIR; j++) {
        const t = j / (LINKS_PER_PAIR + 1);
        const link = getLink(li++);
        link.visible = true;
        link.position.lerpVectors(wa, wb, t);
        link.position.y += -Math.sin(t * Math.PI) * sag + Math.sin(time * 6 + j) * 1.5;
      }
    }
  }
  for (; li < chainPool.length; li++) chainPool[li].visible = false;
}

// ---- particles / floaters / corpses ------------------------------------------------------

function burst3(w, color, n, { speed = 320, up = 300, life = 0.8, size = 1 } = {}) {
  for (let i = 0; i < n; i++) {
    let p = particles.find(q => !q.mesh.visible);
    if (!p) {
      if (particles.length > 350) break;
      p = { mesh: new THREE.Mesh(GEO.particle, particleMat(color)) };
      scene.add(p.mesh);
      particles.push(p);
    }
    p.mesh.material = particleMat(color);
    p.mesh.visible = true;
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.3 + Math.random() * 0.7);
    p.vx = Math.cos(a) * s;
    p.vz = Math.sin(a) * s;
    p.vy = up * (0.4 + Math.random() * 0.9);
    p.life = p.maxLife = life * (0.6 + Math.random() * 0.6);
    p.floor = w.y - 26;
    p.mesh.position.copy(w);
    p.mesh.scale.setScalar(size * (0.7 + Math.random() * 0.6));
  }
}

export function confetti() {
  for (let i = 0; i < 130; i++) {
    let p = particles.find(q => !q.mesh.visible);
    if (!p) {
      if (particles.length > 350) break;
      p = { mesh: new THREE.Mesh(GEO.particle, particleMat('#fff')) };
      scene.add(p.mesh);
      particles.push(p);
    }
    p.mesh.material = particleMat(C.SLOP_COLORS[i % C.SLOP_COLORS.length]);
    p.mesh.visible = true;
    p.mesh.position.set(Math.random() * C.ARENA_W, 500 + Math.random() * 300, Math.random() * C.ARENA_H);
    p.vx = (Math.random() - 0.5) * 120;
    p.vz = (Math.random() - 0.5) * 120;
    p.vy = -100 - Math.random() * 150;
    p.life = p.maxLife = 2.5 + Math.random() * 2;
    p.floor = 4;
    p.mesh.scale.setScalar(1 + Math.random());
  }
}

function addFloater(w, text, color = '#fff', px = 48) {
  const s = makeTextSprite(text, { px, color });
  s.position.copy(w);
  s.position.y += 110;
  scene.add(s);
  floaters.push({ sprite: s, life: 1.7 });
}

export function emoteAt(id, e) {
  const b = blobs.get(id);
  if (b && b.alive) {
    addFloater(toWorld(b.rx ?? b.x, b.rz ?? b.y, liftFor(id)), e, '#fff', 60);
    emoteBody(id, e);
  }
}

function updateEffects(dt) {
  for (const p of particles) {
    if (!p.mesh.visible) continue;
    p.life -= dt;
    if (p.life <= 0) { p.mesh.visible = false; continue; }
    p.vy -= 900 * dt;
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;
    const fl = p.floor ?? 4;
    if (p.mesh.position.y < fl) { p.mesh.position.y = fl; p.vy *= -0.4; p.vx *= 0.7; p.vz *= 0.7; }
    p.mesh.material.opacity = Math.max(0, p.life / p.maxLife);
  }
  for (let i = floaters.length - 1; i >= 0; i--) {
    const f = floaters[i];
    f.life -= dt;
    f.sprite.position.y += dt * 55;
    f.sprite.material.opacity = Math.min(1, f.life);
    if (f.life <= 0) {
      f.sprite.material.map?.dispose();
      scene.remove(f.sprite);
      floaters.splice(i, 1);
    }
  }
  for (let i = corpses.length - 1; i >= 0; i--) {
    const c = corpses[i];
    c.t += dt;
    c.vy -= 1800 * dt;
    c.group.position.y += c.vy * dt;
    c.group.rotation.x += dt * 4;
    c.char.armL.rotation.z = Math.sin(time * 24) * 2;
    c.char.armR.rotation.z = Math.sin(time * 22) * 2;
    c.char.legL.rotation.z = Math.sin(time * 26) * 1.6;
    c.char.legR.rotation.z = -Math.sin(time * 24) * 1.6;
    if (c.t > 1.4 || c.group.position.y < -800) {
      scene.remove(c.group);
      corpses.splice(i, 1);
    }
  }
}

// ---- snapshots ----------------------------------------------------------------------------

let selfIdCache = null;
export function applySnapshot(snap, meta, selfId) {
  selfIdCache = selfId;
  curExtra = snap.extra || curExtra;
  const seen = new Set();
  for (const [id, x, y, alive, score, dashCd, dashing, events] of snap.players) {
    seen.add(id);
    let b = blobs.get(id);
    const info = meta?.players.find(p => p.id === id);
    if (!b) {
      b = {
        id, x, y, tx: x, ty: y, rx: x, rz: y,
        alive: !!alive, score, dashCd, dashing: !!dashing,
        color: info?.color || '#ffffff', name: info?.name || '?', wasAlive: !!alive,
      };
      blobs.set(id, b);
    }
    b.tx = x; b.ty = y;
    b.score = score; b.dashCd = dashCd; b.dashing = !!dashing;
    if (info) { b.money = info.coins; b.name = info.name; b.axe = info.axe || 0; }

    if (b.wasAlive && !alive) {
      spawnCorpse(b);
      shakeAmt = Math.max(shakeAmt, 12);
    }
    b.wasAlive = b.alive = !!alive;

    const w = () => toWorld(b.rx ?? x, b.rz ?? y, liftFor(id) + 26);
    const flail = t => { const v = views.get(id); if (v) v.flailT = Math.max(v.flailT, t); };
    for (const ev of events || []) {
      if (ev === 'dash') { burst3(w(), '#ffffff', 5, { speed: 120, up: 80, life: 0.35 }); if (id === selfId) sfx.dash(); }
      else if (ev === 'bonk') { burst3(w(), '#ffffff', 8, { speed: 240, life: 0.4 }); sfx.bonk(); flail(0.7); }
      else if (ev === 'boom') { burst3(w(), '#ff9040', 40, { speed: 520, up: 420, life: 1.1, size: 1.6 }); shakeAmt = Math.max(shakeAmt, 26); sfx.boom(); flail(0.9); }
      else if (ev === 'burn') { burst3(w(), '#9dff2e', 22, { speed: 350, life: 0.8 }); shakeAmt = Math.max(shakeAmt, 10); sfx.splat(); addFloater(w(), '-1 ❤️', '#ff5252', 40); flail(0.9); }
      else if (ev === 'crack') { burst3(w(), '#a88a4a', 14, { speed: 260, up: 220, life: 0.6 }); sfx.bonk(); }
      else if (ev === 'dig') { burst3(w(), '#8a6a3a', 6, { speed: 140, up: 160, life: 0.4 }); if (id === selfId) sfx.tick(); }
      else if (ev === 'fall') { burst3(w(), '#8a6a3a', 10, { speed: 180, life: 0.5 }); if (id === selfId) sfx.dash(); }
      else if (ev === 'catch') { burst3(w(), '#ffd84d', 26, { speed: 380, up: 460, life: 0.9 }); sfx.coin(); addFloater(w(), 'GOT IT!', '#ffd84d', 46); }
      else if (ev === 'smash') { burst3(w(), '#8a8298', 20, { speed: 300, life: 0.7 }); sfx.splat(); addFloater(w(), '-1 ❤️', '#ff5252', 40); flail(0.8); }
      else if (ev === 'escape') { burst3(w(), '#7CFC00', 24, { speed: 300, up: 500, life: 1 }); sfx.go(); addFloater(w(), 'SAFE!', '#7CFC00', 46); }
      else if (ev.startsWith('loot')) {
        const t = Number(ev.slice(4)) || 0;
        addFloater(w(), `[${AXE_NAMES[t]} Slopaxe]`, AXE_COLORS[t], 46);
        burst3(w(), AXE_COLORS[t], 18, { speed: 260, up: 360, life: 0.8 });
        sfx.coin();
        if (id === selfIdCache) sfx.win();
      }
    }
  }
  for (const id of blobs.keys()) if (!seen.has(id)) blobs.delete(id);
}

// ---- frame -----------------------------------------------------------------------------

export function frame(dt, S) {
  if (!renderer) return;
  time += dt;
  speakingIds = S.voice?.speaking || null;
  resizeIfNeeded();

  ensureArena(S.scene);
  yawLocked = mapMode === 'mountain';
  if (yawLocked) camYaw *= Math.max(0, 1 - 4 * dt);

  updateArena(dt, S.snap?.extra, S);
  updateBlobViews(dt);
  updateGremlinViews(dt);
  updateChain(S.snap?.extra);
  updateEffects(dt);

  shakeAmt = Math.max(0, shakeAmt - dt * 40);
  const sx = (Math.random() - 0.5) * shakeAmt;
  const sy = (Math.random() - 0.5) * shakeAmt;

  const selfView = views.get(S.selfId);
  const self = blobs.get(S.selfId);
  let want, look;
  if (self && self.alive && selfView) {
    const w = selfView.group.position;
    if (mapMode === 'mountain') {
      want = new THREE.Vector3(Math.max(240, Math.min(C.ARENA_W - 240, w.x)) + sx, w.y + 250 + sy, w.z + 560);
      look = new THREE.Vector3(w.x, w.y + 70, w.z - 160);
    } else {
      const fx = Math.sin(camYaw), fz = -Math.cos(camYaw);
      want = new THREE.Vector3(w.x - fx * 300 + sx, w.y + 235 + sy, w.z - fz * 300);
      look = new THREE.Vector3(w.x + fx * 160, w.y + 5, w.z + fz * 160);
    }
  } else {
    const a = time * 0.15;
    want = new THREE.Vector3(CX + Math.sin(a) * 950 + sx, 620 + sy, CZ + Math.cos(a) * 950);
    look = new THREE.Vector3(CX, 0, CZ);
  }
  if (!camPos) camPos = want.clone();
  camPos.lerp(want, Math.min(1, dt * 7));
  camera.position.copy(camPos);
  camera.lookAt(look);

  renderer.render(scene, camera);
}
