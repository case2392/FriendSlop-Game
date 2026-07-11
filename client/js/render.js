// FRIENDSLOP 3D renderer — Three.js, no assets, everything procedural.
// Server plane (x, y) maps to world (x, 0, z).
import * as THREE from '/vendor/three.module.js';
import * as C from '/shared/constants.js';
import { sfx } from './sfx.js';

export const blobs = new Map(); // id -> logical state {x,y,tx,ty,alive,...}

const BG = 0x14101f;
const CX = C.ARENA_W / 2, CZ = C.ARENA_H / 2;

let renderer, scene, camera, canvas;
let time = 0, shakeAmt = 0;
let lastW = 0, lastH = 0;
let camYaw = 0;                 // mouse-look yaw; 0 = facing north (the gate)
let camPos = null;              // smoothed camera position
export function getCamYaw() { return camYaw; }
export function turnCam(d) { camYaw += d; }

let arena = null; // { kind, group, ...per-scene refs }
const views = new Map();
const gremViews = new Map();
const chainPool = [];
const particles = [];
const floaters = [];
const corpses = [];

// ---- shared geometry / materials --------------------------------------------

const GEO = {
  body: new THREE.SphereGeometry(C.PLAYER_RADIUS, 24, 18),
  torso: new THREE.CapsuleGeometry(15, 24, 6, 14),
  leg: new THREE.CapsuleGeometry(7, 13, 4, 10),
  arm: new THREE.CapsuleGeometry(5.5, 14, 4, 10),
  head: new THREE.SphereGeometry(16, 20, 16),
  eyeH: new THREE.SphereGeometry(5, 10, 8),
  pupilH: new THREE.SphereGeometry(2.6, 8, 6),
  eye: new THREE.SphereGeometry(8, 12, 10),
  pupil: new THREE.SphereGeometry(4, 8, 8),
  aura: new THREE.SphereGeometry(C.PLAYER_RADIUS + 12, 16, 12),
  link: new THREE.SphereGeometry(7, 8, 6),
  particle: new THREE.SphereGeometry(5, 6, 5),
  gremlin: new THREE.IcosahedronGeometry(24, 0),
  card: new THREE.PlaneGeometry(66, 92),
};
const MAT = {
  eyeWhite: new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 }),
  pupil: new THREE.MeshStandardMaterial({ color: 0x1a1426, roughness: 0.4 }),
  link: new THREE.MeshStandardMaterial({ color: 0x4a4260, roughness: 0.35, metalness: 0.7 }),
  gremlin: new THREE.MeshStandardMaterial({ color: 0x2c2140, roughness: 0.6, flatShading: true }),
  gremlinEye: new THREE.MeshBasicMaterial({ color: 0xff3030 }),
};
const bodyMats = new Map();
function bodyMat(color) {
  if (!bodyMats.has(color)) bodyMats.set(color, new THREE.MeshStandardMaterial({ color, roughness: 0.35 }));
  return bodyMats.get(color);
}
const particleMats = new Map();
function particleMat(color) {
  if (!particleMats.has(color)) particleMats.set(color, new THREE.MeshBasicMaterial({ color, transparent: true }));
  return particleMats.get(color);
}

// ---- humanoid slop-people ------------------------------------------------------
// Chunky low-poly characters: colored suit, lighter face, stubby limbs, a hat.
const charMatCache = new Map();
function charMats(color) {
  if (!charMatCache.has(color)) {
    const base = new THREE.Color(color);
    charMatCache.set(color, {
      suit: new THREE.MeshStandardMaterial({ color: base, roughness: 0.5 }),
      skin: new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color('#ffffff'), 0.35), roughness: 0.45 }),
      limb: new THREE.MeshStandardMaterial({ color: base.clone().lerp(new THREE.Color('#000000'), 0.25), roughness: 0.55 }),
    });
  }
  return charMatCache.get(color);
}
const HAT_DARK = new THREE.MeshStandardMaterial({ color: 0x14101f, roughness: 0.6 });
const HAT_RED = new THREE.MeshStandardMaterial({ color: 0xd8333f, roughness: 0.6 });
const HAT_GOLD = new THREE.MeshStandardMaterial({ color: 0xffd84d, roughness: 0.4, metalness: 0.4 });

function makeHat(i) {
  const hat = new THREE.Group();
  if (i === 1) { // top hat
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 3, 16), HAT_DARK);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 18, 16), HAT_DARK);
    top.position.y = 10;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(10.5, 10.5, 5, 16), HAT_RED);
    band.position.y = 4;
    hat.add(brim, top, band);
  } else if (i === 2) { // cap
    const dome = new THREE.Mesh(new THREE.SphereGeometry(13, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2), HAT_RED);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(12, 2.5, 14), HAT_RED);
    brim.position.set(12, 1, 0);
    hat.add(dome, brim);
  } else if (i === 3) { // fez
    const fez = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 13, 14), HAT_RED);
    fez.position.y = 5;
    hat.add(fez);
  } else if (i === 4) { // lil crown
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(10, 11, 7, 10), HAT_GOLD);
    ring.position.y = 2;
    hat.add(ring);
  }
  return hat;
}

// Root sits at ground level; feet reach y≈3. Local +x is forward.
function buildCharacter(color, { hatIndex = 0, eyeColor = null, scale = 1 } = {}) {
  const m = charMats(color);
  const root = new THREE.Group();

  const legL = new THREE.Group();
  const legR = new THREE.Group();
  for (const [pivot, side] of [[legL, -1], [legR, 1]]) {
    pivot.position.set(0, 28, side * 9);
    const leg = new THREE.Mesh(GEO.leg, m.limb);
    leg.position.y = -14;
    leg.castShadow = true;
    pivot.add(leg);
    root.add(pivot);
  }

  const torso = new THREE.Mesh(GEO.torso, m.suit);
  torso.position.y = 48;
  torso.castShadow = true;
  root.add(torso);

  const armL = new THREE.Group();
  const armR = new THREE.Group();
  for (const [pivot, side] of [[armL, -1], [armR, 1]]) {
    pivot.position.set(0, 64, side * 20);
    const arm = new THREE.Mesh(GEO.arm, m.limb);
    arm.position.y = -13;
    arm.castShadow = true;
    pivot.add(arm);
    root.add(pivot);
  }

  const head = new THREE.Mesh(GEO.head, m.skin);
  head.position.y = 90;
  head.castShadow = true;
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(GEO.eyeH, MAT.eyeWhite);
    eye.position.set(12.5, 2, side * 6.5);
    const pupil = new THREE.Mesh(GEO.pupilH, eyeColor ? new THREE.MeshBasicMaterial({ color: eyeColor }) : MAT.pupil);
    pupil.position.set(3.6, 0.3, 0);
    eye.add(pupil);
    head.add(eye);
  }
  const hat = makeHat(hatIndex);
  hat.position.y = 12;
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
    sprite.material.map = new THREE.CanvasTexture(cv);
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
  const tex = new THREE.CanvasTexture(cv);
  cardTexCache.set(code, tex);
  return tex;
}

function makeCardMesh(code) {
  const m = new THREE.Mesh(GEO.card, new THREE.MeshBasicMaterial({
    map: cardTexture(code), transparent: true, side: THREE.DoubleSide,
  }));
  m.rotation.x = -0.95; // tilted up toward the camera
  return m;
}

// ---- init -------------------------------------------------------------------------

export function initRender(cv) {
  canvas = cv;
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  scene.fog = new THREE.Fog(BG, 2400, 4600);

  camera = new THREE.PerspectiveCamera(62, 16 / 9, 10, 6000);
  canvas.addEventListener('click', () => canvas.requestPointerLock?.());
  document.addEventListener('mousemove', e => {
    if (document.pointerLockElement === canvas) camYaw += e.movementX * 0.0026;
  });

  scene.add(new THREE.AmbientLight(0x9080b8, 1.35));
  scene.add(new THREE.HemisphereLight(0x8878c0, 0x2a1f3a, 0.9));
  const sun = new THREE.DirectionalLight(0xfff2e0, 2.0);
  sun.position.set(500, 1500, 900);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
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
}

function carpetTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 512;
  const g = cv.getContext('2d');
  g.fillStyle = '#3d1230';
  g.fillRect(0, 0, 512, 512);
  const colors = ['#a03b28', '#c76b1e', '#1f7a6e', '#7a1f4e'];
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < 8; i++) {
      const x = (i % 4) * 128 + 64 + (ring ? 64 : 0);
      const y = Math.floor(i / 4) * 256 + 64 + ring * 128;
      g.strokeStyle = colors[i % colors.length];
      g.lineWidth = 10;
      g.beginPath(); g.arc(x % 512, y % 512, 38, 0, Math.PI * 2); g.stroke();
      g.fillStyle = colors[(i + 1) % colors.length];
      g.beginPath(); g.arc(x % 512, y % 512, 16, 0, Math.PI * 2); g.fill();
      g.strokeStyle = '#e8b93c88';
      g.lineWidth = 4;
      g.beginPath(); g.arc((x + 64) % 512, (y + 64) % 512, 52, 0.3, 2.4); g.stroke();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 3);
  return tex;
}

function wallpaperTexture() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#4a3550';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = '#6b4a66';
  g.lineWidth = 3;
  for (let x = -256; x < 512; x += 64) {
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x + 128, 256); g.stroke();
    g.beginPath(); g.moveTo(x + 128, 0); g.lineTo(x, 256); g.stroke();
  }
  g.fillStyle = '#c9a3402e';
  for (let x = 32; x < 256; x += 64) {
    for (let y = 32; y < 256; y += 64) {
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 3);
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
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

// ---- arena builders ---------------------------------------------------------------------

function addCave(group) {
  const cave = new THREE.Mesh(
    new THREE.CylinderGeometry(2600, 2600, 600, 24, 1, true),
    new THREE.MeshStandardMaterial({ color: 0x171126, roughness: 1, side: THREE.BackSide }),
  );
  cave.position.set(CX, 180, CZ);
  group.add(cave);
}

function buildArena(kind) {
  if (arena) clearGroup(arena.group);
  const group = new THREE.Group();
  scene.add(group);
  arena = { kind, group };

  const floorBox = (w, d, color, map = null, y = -22, h = 44) => {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.9, map }),
    );
    m.position.set(CX, y, CZ);
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  const gateArch = (x, z) => {
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a3d75, roughness: 0.7 });
    const geo = new THREE.BoxGeometry(90, 360, 90);
    for (const px of [x - 330, x + 330]) {
      const p = new THREE.Mesh(geo, mat);
      p.position.set(px, 180, z);
      p.castShadow = true;
      group.add(p);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(760, 80, 100), mat);
    beam.position.set(x, 400, z);
    group.add(beam);
    const opening = new THREE.Mesh(
      new THREE.BoxGeometry(560, 300, 18),
      new THREE.MeshBasicMaterial({ color: 0x05030c }),
    );
    opening.position.set(x, 150, z - 10);
    group.add(opening);
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(560, 260, 46),
      new THREE.MeshStandardMaterial({ color: 0x6b5a9e, roughness: 0.5, emissive: 0x2a1a4a, emissiveIntensity: 0.6 }),
    );
    door.position.set(x, 130, z);
    door.castShadow = true;
    group.add(door);
    return door;
  };

  if (kind === 'hub') {
    // patterned casino carpet
    const carpet = new THREE.Mesh(
      new THREE.BoxGeometry(1700, 44, 1000),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, map: carpetTexture() }),
    );
    carpet.position.set(CX, -22, CZ);
    carpet.receiveShadow = true;
    group.add(carpet);

    // wallpapered walls (inward-facing planes so the camera never blocks)
    const wp = wallpaperTexture();
    const mkWall = (w, x, z, ry) => {
      const wall = new THREE.Mesh(
        new THREE.PlaneGeometry(w, 520),
        new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, map: wp }),
      );
      wall.position.set(x, 260, z);
      wall.rotation.y = ry;
      group.add(wall);
      return wall;
    };
    mkWall(1740, CX, -20, 0);
    mkWall(1740, CX, C.ARENA_H + 20, Math.PI);
    mkWall(1040, -20, CZ, Math.PI / 2);
    mkWall(1040, C.ARENA_W + 20, CZ, -Math.PI / 2);
    // baseboard glow
    const trimMat = new THREE.MeshBasicMaterial({ color: 0xff6ec7 });
    for (const [w, d, x, z] of [[1660, 8, CX, -12], [1660, 8, CX, C.ARENA_H + 12], [8, 940, -12, CZ], [8, 940, C.ARENA_W + 12, CZ]]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(w, 10, d), trimMat);
      t.position.set(x, 6, z);
      group.add(t);
    }
    // ceiling with recessed light panels
    const ceil = new THREE.Mesh(
      new THREE.PlaneGeometry(1740, 1040),
      new THREE.MeshStandardMaterial({ color: 0x241a3e, roughness: 1 }),
    );
    ceil.position.set(CX, 520, CZ);
    ceil.rotation.x = Math.PI / 2;
    group.add(ceil);
    for (let i = 0; i < 6; i++) {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(220, 6, 120),
        new THREE.MeshBasicMaterial({ color: 0xbfa8ff }),
      );
      panel.position.set(300 + (i % 3) * 500, 516, 250 + Math.floor(i / 3) * 400);
      group.add(panel);
    }
    // neon wall art
    const crown = makeTextSprite('👑', { px: 90, color: '#FFD84D' });
    crown.position.set(90, 330, CZ - 120);
    group.add(crown);
    const bolt = makeTextSprite('🃏', { px: 90, color: '#FF6EC7' });
    bolt.position.set(C.ARENA_W - 90, 330, CZ + 60);
    group.add(bolt);
    const moodA = new THREE.PointLight(0xff6ec7, 14000, 900);
    moodA.position.set(220, 300, 200);
    group.add(moodA);
    const moodB = new THREE.PointLight(0x00e5ff, 12000, 900);
    moodB.position.set(C.ARENA_W - 220, 300, 700);
    group.add(moodB);

    // THE GATE (north)
    arena.door = gateArch(C.HUB.GATE.x, 40);
    const zone = new THREE.Mesh(
      new THREE.BoxGeometry(C.HUB.GATE.w, 3, C.HUB.GATE.h),
      new THREE.MeshBasicMaterial({ color: 0x00e5ff, transparent: true, opacity: 0.16 }),
    );
    zone.position.set(C.HUB.GATE.x, 2, C.HUB.GATE.y);
    group.add(zone);
    arena.gateZone = zone;
    arena.gateSign = makeTextSprite(' ', { px: 46, color: '#00E5FF', w: 1024 });
    arena.gateSign.position.set(C.HUB.GATE.x, 350, 60);
    group.add(arena.gateSign);
    const marquee = makeTextSprite('✨ F R I E N D S L O P ✨', { px: 54, color: '#FF6EC7', w: 1024 });
    marquee.position.set(C.HUB.GATE.x, 500, 40);
    group.add(marquee);
    arena.gateCd = makeTextSprite(' ', { px: 62, color: '#7CFC00' });
    arena.gateCd.position.set(C.HUB.GATE.x, 210, C.HUB.GATE.y + 70);
    group.add(arena.gateCd);

    // THE PIT BOSS'S TABLE (south)
    const felt = new THREE.Mesh(
      new THREE.CylinderGeometry(130, 138, 46, 32),
      new THREE.MeshStandardMaterial({ color: 0x1c6b3a, roughness: 0.6 }),
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
    // the boss himself: a towering slop-man in a top hat
    const bossChar = buildCharacter('#241d35', { hatIndex: 1, eyeColor: 0xff3030, scale: 1.45 });
    const boss = bossChar.root;
    const bowtie = new THREE.Mesh(new THREE.BoxGeometry(4, 6, 14), HAT_RED);
    bowtie.position.set(13, 74, 0);
    boss.add(bowtie);
    // he faces the table (south, toward the players)
    boss.rotation.y = -Math.PI / 2;
    boss.position.set(C.HUB.TABLE.x, 0, C.HUB.TABLE.y - 215);
    arena.bossChar = bossChar;
    const deck = makeCardMesh('BACK');
    deck.rotation.x = -Math.PI / 2;
    deck.position.set(C.HUB.TABLE.x + 60, 48, C.HUB.TABLE.y - 20);
    group.add(deck);
    group.add(boss);
    arena.boss = boss;
    const bossLight = new THREE.PointLight(0xffd84d, 24000, 700);
    bossLight.position.set(C.HUB.TABLE.x, 260, C.HUB.TABLE.y);
    group.add(bossLight);

    // vote zones
    const mkZone = (z, color) => {
      const disc = new THREE.Mesh(
        new THREE.CylinderGeometry(z.r, z.r, 4, 36),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22 }),
      );
      disc.position.set(z.x, 2, z.y);
      group.add(disc);
      return disc;
    };
    arena.hitZone = mkZone(C.HUB.HIT, 0x7cfc00);
    arena.standZone = mkZone(C.HUB.STAND, 0xff6ec7);
    arena.hitLabel = makeTextSprite('HIT 👊', { px: 46, color: '#7CFC00' });
    arena.hitLabel.position.set(C.HUB.HIT.x, 150, C.HUB.HIT.y);
    arena.standLabel = makeTextSprite('STAND ✋', { px: 46, color: '#FF6EC7' });
    arena.standLabel.position.set(C.HUB.STAND.x, 150, C.HUB.STAND.y);
    group.add(arena.hitLabel, arena.standLabel);

    // cards + table talk
    arena.cardMeshes = [];
    arena.cardSig = '';
    arena.bjInfo = makeTextSprite(' ', { px: 44, color: '#FFD84D', w: 1024 });
    arena.bjInfo.position.set(C.HUB.TABLE.x, 290, C.HUB.TABLE.y - 40);
    group.add(arena.bjInfo);

    // big banner + standings
    arena.banner = makeTextSprite(' ', { px: 40, color: '#FFD84D', w: 1024 });
    arena.banner.position.set(CX, 440, CZ - 60);
    arena.banner.scale.set(1024 * 0.44, 56, 1);
    group.add(arena.banner);
    arena.standRows = [];
    arena.confettiT = 0;
  } else if (kind === 'gates') {
    addCave(group);
    floorBox(1760, 1020, 0x322a52, noiseTexture('#322a52', '#221b3a'));
    arena.door = gateArch(CX, -60);
    arena.plates = []; // created on demand — plate count scales with the squad
  } else if (kind === 'gut') {
    addCave(group);
    arena.floor = floorBox(1760, 1020, 0x7a3352, noiseTexture('#7a3352', '#5a1f3c'));
    const acid = new THREE.Mesh(
      new THREE.BoxGeometry(1760, 26, 1020),
      new THREE.MeshStandardMaterial({
        color: 0x9dff2e, emissive: 0x71c216, emissiveIntensity: 0.9,
        transparent: true, opacity: 0.85, roughness: 0.2,
      }),
    );
    acid.position.set(CX, -40, CZ);
    group.add(acid);
    arena.acid = acid;
    arena.islands = [];
  } else if (kind === 'tater') {
    addCave(group);
    floorBox(1660, 960, 0x2e2749, noiseTexture('#2e2749', '#1e1834'));
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x4a3d75, roughness: 0.7 });
    const mkWall = (w, d, x, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, 70, d), wallMat);
      m.position.set(x, 35, z);
      m.castShadow = true;
      group.add(m);
    };
    mkWall(1700, 40, CX, -20); mkWall(1700, 40, CX, C.ARENA_H + 20);
    mkWall(40, 1000, -20, CZ); mkWall(40, 1000, C.ARENA_W + 20, CZ);

    const drainHole = new THREE.Mesh(
      new THREE.CylinderGeometry(85, 85, 6, 32),
      new THREE.MeshBasicMaterial({ color: 0x05030c }),
    );
    drainHole.position.y = 2;
    group.add(drainHole);
    const drainRing = new THREE.Mesh(
      new THREE.TorusGeometry(92, 7, 12, 40),
      new THREE.MeshStandardMaterial({ color: 0xffd84d, emissive: 0xffb020, emissiveIntensity: 1.0 }),
    );
    drainRing.rotation.x = Math.PI / 2;
    drainRing.position.y = 6;
    group.add(drainRing);
    arena.drainHole = drainHole;
    arena.drainRing = drainRing;

    const stone = new THREE.Mesh(
      new THREE.SphereGeometry(20, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0x7a5230, roughness: 0.8, flatShading: true }),
    );
    stone.castShadow = true;
    const stoneLight = new THREE.PointLight(0xff4020, 0, 320);
    group.add(stone, stoneLight);
    arena.stone = stone;
    arena.stoneLight = stoneLight;
    arena.fuse = makeTextSprite(' ', { px: 52, color: '#ffd84d' });
    group.add(arena.fuse);
  } else if (kind === 'walk') {
    addCave(group);
    const startLedge = new THREE.Mesh(
      new THREE.BoxGeometry(170, 44, 1020),
      new THREE.MeshStandardMaterial({ color: 0x3a2f5c, roughness: 0.8 }),
    );
    startLedge.position.set(80, -22, CZ);
    startLedge.receiveShadow = true;
    group.add(startLedge);
    const exitLedge = new THREE.Mesh(
      new THREE.BoxGeometry(170, 44, 1020),
      new THREE.MeshStandardMaterial({ color: 0x2c5c2c, emissive: 0x2fbb2f, emissiveIntensity: 0.5, roughness: 0.6 }),
    );
    exitLedge.position.set(1520, -22, CZ);
    exitLedge.receiveShadow = true;
    group.add(exitLedge);
    const exitSign = makeTextSprite('EXIT →', { px: 60, color: '#7CFC00' });
    exitSign.position.set(1520, 140, CZ);
    group.add(exitSign);
    arena.tiles = [];
    arena.tileStates = [];
  }
  return arena;
}

function ensureArena(kind) {
  if (!kind) return;
  if (!arena || arena.kind !== kind) buildArena(kind);
}

// ---- hub updates -----------------------------------------------------------------------

function updateHub(dt, ex, S) {
  const mode = ex?.hub;
  const m = S.meta;

  // gate
  const gateActive = mode === 'lobby' || mode === 'gate';
  const info = C.MINIGAME_INFO[m?.minigame] || {};
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

  // blackjack table
  const bj = ex?.bj;
  const zonesActive = bj && bj.state === 'voting';
  arena.hitZone.material.opacity = zonesActive ? 0.3 + Math.sin(time * 8) * 0.1 : 0.08;
  arena.standZone.material.opacity = zonesActive ? 0.3 + Math.cos(time * 8) * 0.1 : 0.08;
  arena.hitLabel.userData.set(zonesActive ? `HIT 👊 ×${bj.hitIds.length}` : 'HIT 👊');
  arena.standLabel.userData.set(zonesActive ? `STAND ✋ ×${bj.standIds.length}` : 'STAND ✋');
  arena.boss.rotation.y = -Math.PI / 2 + Math.sin(time * 0.9) * 0.12;
  if (arena.bossChar) {
    arena.bossChar.armR.rotation.z = -1.1 + Math.sin(time * 2.2) * 0.15; // dealing hand
    arena.bossChar.armL.rotation.z = Math.sin(time * 1.7) * 0.1;
  }

  if (bj) {
    const dealerCards = bj.dealer || [bj.dealerUp, 'BACK'];
    const sig = bj.squad.join() + '|' + dealerCards.join() + '|' + (bj.outcome || '');
    if (sig !== arena.cardSig) {
      arena.cardSig = sig;
      for (const c of arena.cardMeshes) arena.group.remove(c);
      arena.cardMeshes = [];
      const deal = (codes, z, y) => {
        codes.forEach((code, i) => {
          const mesh = makeCardMesh(code);
          mesh.userData.cardCode = code;
          const x = C.HUB.TABLE.x - ((codes.length - 1) * 74) / 2 + i * 74;
          mesh.position.set(C.HUB.TABLE.x + 240, 160, C.HUB.TABLE.y - 160); // from the boss's hand
          mesh.userData.target = new THREE.Vector3(x, y, z);
          arena.group.add(mesh);
          arena.cardMeshes.push(mesh);
        });
      };
      deal(dealerCards, C.HUB.TABLE.y - 60, 150);
      deal(bj.squad, C.HUB.TABLE.y + 105, 110);
      sfx.click();
    }
    for (const c of arena.cardMeshes) {
      c.position.lerp(c.userData.target, Math.min(1, dt * 7));
    }
    if (bj.state === 'done') {
      const msg = bj.outcome === 'natural' ? `💎 NATURAL 21 — THE BOYS (${bj.squadTotal})`
        : bj.outcome === 'win' ? `🎉 BOYS ${bj.squadTotal} — BOSS ${bj.dealerTotal}`
        : bj.outcome === 'push' ? `😤 PUSH ${bj.squadTotal}–${bj.dealerTotal}`
        : `💀 BOSS ${bj.dealerTotal > 21 ? 'BUST?! no—' : bj.dealerTotal} — BOYS ${bj.squadTotal}`;
      arena.bjInfo.userData.set(msg, bj.outcome === 'lose' ? '#FF7676' : bj.outcome === 'push' ? '#FFD84D' : '#7CFC00');
    } else {
      arena.bjInfo.userData.set(
        `THE BOYS: ${bj.squadTotal} — votes lock in ${Math.ceil(bj.voteLeft ?? 0)}`,
        '#FFD84D',
      );
    }
    arena.bjInfo.visible = true;
  } else {
    arena.bjInfo.visible = false;
    if (arena.cardMeshes.length) {
      for (const c of arena.cardMeshes) arena.group.remove(c);
      arena.cardMeshes = [];
      arena.cardSig = '';
    }
  }

  // banner
  if (ex?.banner) {
    arena.banner.visible = true;
    arena.banner.userData.set(ex.banner.text, ex.banner.color);
  } else {
    arena.banner.visible = false;
  }

  // celebrate standings
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

// ---- chamber updates ------------------------------------------------------------------

function updateArena(dt, extra, S) {
  if (!arena) return;
  if (arena.kind === 'hub') { updateHub(dt, extra, S); return; }

  if (arena.kind === 'gates') {
    if (extra?.plates) {
      while (arena.plates.length < extra.plates.length) {
        const plate = new THREE.Mesh(
          new THREE.CylinderGeometry(100, 108, 10, 32),
          new THREE.MeshStandardMaterial({ color: 0x5a2338, emissive: 0xff3860, emissiveIntensity: 0.35, roughness: 0.4 }),
        );
        plate.position.y = 5;
        plate.receiveShadow = true;
        arena.group.add(plate);
        arena.plates.push(plate);
      }
      arena.plates.forEach((plate, i) => { plate.visible = i < extra.plates.length; });
      extra.plates.forEach(([x, y, r, cov], i) => {
        const plate = arena.plates[i];
        if (!plate) return;
        plate.position.x = x; plate.position.z = y;
        const mt = plate.material;
        if (cov) {
          mt.color.set(0x1f5a2e); mt.emissive.set(0x36ff6e);
          mt.emissiveIntensity = 0.7 + Math.sin(time * 8) * 0.25;
        } else {
          mt.color.set(0x5a2338); mt.emissive.set(0xff3860);
          mt.emissiveIntensity = 0.3 + Math.sin(time * 3 + i) * 0.1;
        }
      });
    }
    if (extra && arena.door) {
      const t = Math.min(1, (extra.prog || 0) / (extra.need || 1));
      arena.door.position.y = 160 + t * 300;
      if (arena.doorT !== undefined && t > arena.doorT) shakeAmt = Math.max(shakeAmt, 1.5);
      arena.doorT = t;
    }
    syncGremlins(extra?.gremlins || []);
  } else if (arena.kind === 'gut') {
    const isles = extra?.islands || [];
    while (arena.islands.length < isles.length) {
      const isle = new THREE.Mesh(
        new THREE.CylinderGeometry(1, 1.08, 16, 28),
        new THREE.MeshStandardMaterial({ color: 0x3f9d4c, emissive: 0x2fbb2f, emissiveIntensity: 0.35, roughness: 0.6 }),
      );
      isle.receiveShadow = true;
      arena.group.add(isle);
      arena.islands.push(isle);
    }
    arena.islands.forEach((isle, i) => {
      const data = isles[i];
      isle.visible = !!data;
      if (!data) return;
      isle.position.set(data[0], 8, data[1]);
      isle.scale.set(data[2], 1, data[2]);
      isle.material.emissiveIntensity = extra.state === 'warn' ? 0.5 + Math.sin(time * 10) * 0.4 : 0.35;
    });
    if (arena.acid) {
      const target = extra?.state === 'flood' ? 4 : -40;
      arena.acid.position.y += (target - arena.acid.position.y) * Math.min(1, dt * 10);
      arena.acid.material.emissiveIntensity = 0.7 + Math.sin(time * 14) * 0.25;
      if (extra?.state === 'flood') shakeAmt = Math.max(shakeAmt, 3);
    }
    if (arena.floor) {
      const angry = extra?.state === 'warn' ? 0.12 : 0.05;
      arena.floor.material.emissive.setRGB(angry + Math.sin(time * 2.4) * 0.03, 0, 0.02);
    }
  } else if (arena.kind === 'tater') {
    if (extra?.hole) {
      arena.drainHole.position.x = extra.hole[0]; arena.drainHole.position.z = extra.hole[1];
      arena.drainRing.position.x = extra.hole[0]; arena.drainRing.position.z = extra.hole[1];
      arena.drainRing.material.emissiveIntensity = 0.8 + Math.sin(time * 6) * 0.4;
      arena.drainRing.rotation.z += dt * 0.8;
    }
    const holder = extra?.taterId != null ? blobs.get(extra.taterId) : null;
    const show = !!(holder && holder.alive);
    arena.stone.visible = show;
    arena.fuse.visible = show;
    arena.stoneLight.intensity = show ? 30000 + Math.sin(time * 10) * 20000 : 0;
    if (show) {
      arena.stone.position.set(holder.rx, 130 + Math.sin(time * 5) * 6, holder.rz);
      arena.stone.rotation.y += dt * 3;
      arena.stoneLight.position.set(holder.rx, 160, holder.rz);
      arena.fuse.position.set(holder.rx, 192, holder.rz);
      const f = extra.fuse ?? 0;
      arena.fuse.userData.set(f.toFixed(1), f < 4 ? '#ff5252' : '#ffd84d');
    }
  } else if (arena.kind === 'walk') {
    const tiles = extra?.tiles;
    if (tiles && extra.cols) {
      const { cols, rows, tile, offX, offY } = extra;
      if (!arena.tiles.length) {
        const geo = new THREE.BoxGeometry(tile - 5, 24, tile - 5);
        for (let i = 0; i < cols * rows; i++) {
          const mm = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x4a3d75, roughness: 0.85 }));
          mm.position.set(offX + (i % cols) * tile + tile / 2, -12, offY + Math.floor(i / cols) * tile + tile / 2);
          mm.receiveShadow = true;
          arena.group.add(mm);
          arena.tiles.push(mm);
          arena.tileStates.push('0');
        }
      }
      for (let i = 0; i < tiles.length && i < arena.tiles.length; i++) {
        const s = tiles[i], prev = arena.tileStates[i];
        const mm = arena.tiles[i];
        if (s === prev) {
          if (s === '1') mm.position.y = -12 + Math.sin(time * 30 + i) * 2;
          if (mm.userData.falling) {
            mm.userData.vy -= 2600 * dt;
            mm.position.y += mm.userData.vy * dt;
            mm.rotation.x += dt * 2;
            if (mm.position.y < -900) { mm.visible = false; mm.userData.falling = false; }
          }
          continue;
        }
        arena.tileStates[i] = s;
        if (s === '1') mm.material.color.set(0x8a6a3a);
        else if (s === '2') { mm.userData.falling = true; mm.userData.vy = -50; }
        else { mm.material.color.set(0x4a3d75); mm.visible = true; mm.position.y = -12; mm.rotation.x = 0; mm.userData.falling = false; }
      }
    }
  }
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
      const e1 = new THREE.Mesh(GEO.pupil, MAT.gremlinEye);
      const e2 = new THREE.Mesh(GEO.pupil, MAT.gremlinEye);
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

// ---- blobs ----------------------------------------------------------------------------

function makeBlobView(b) {
  const group = new THREE.Group();
  const yaw = new THREE.Group();
  group.add(yaw);

  const char = buildCharacter(b.color, { hatIndex: b.id % 5 });
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

  group.position.set(b.x, 0, b.y);
  scene.add(group);
  return { group, yaw, char, aura, label, face: 0, phase: 0 };
}

function spawnCorpse(b) {
  const char = buildCharacter(b.color, { hatIndex: b.id % 5 });
  const group = char.root;
  group.position.set(b.rx ?? b.x, 10, b.rz ?? b.y);
  scene.add(group);
  corpses.push({ group, vy: -60, t: 0 });
}

function updateBlobViews(dt) {
  for (const [id, b] of blobs) {
    let v = views.get(id);
    if (!b.alive) {
      if (v) { scene.remove(v.group); views.delete(id); }
      continue;
    }
    if (!v) { v = makeBlobView(b); views.set(id, v); }

    const k = 1 - Math.pow(0.00002, dt);
    const jump = Math.hypot(b.tx - b.x, b.ty - b.y);
    if (jump > 380) { b.x = b.tx; b.y = b.ty; }
    else { b.x += (b.tx - b.x) * k; b.y += (b.ty - b.y) * k; }
    b.rx = b.x; b.rz = b.y;

    const vx = b.tx - b.x, vy = b.ty - b.y;
    const sp = Math.hypot(vx, vy);
    if (sp > 2) {
      const target = Math.atan2(vy, vx);
      let d = target - v.face;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      v.face += d * Math.min(1, dt * 10);
    }
    v.yaw.rotation.y = -v.face;

    // walk cycle from actual render-space velocity
    const mvx = b.rx - (v.px ?? b.rx), mvz = b.rz - (v.pz ?? b.rz);
    const vel = Math.hypot(mvx, mvz) / Math.max(dt, 1e-4);
    v.px = b.rx; v.pz = b.rz;
    const st = Math.min(1, vel / 340);
    v.phase += dt * (3 + vel * 0.055);
    const sw = Math.sin(v.phase);
    const ch = v.char;
    if (b.dashing) {
      ch.armL.rotation.z = -1.7;
      ch.armR.rotation.z = -1.7;
      ch.legL.rotation.z = sw * 1.2;
      ch.legR.rotation.z = -sw * 1.2;
      ch.root.rotation.z = -0.5;
    } else {
      ch.legL.rotation.z = sw * 0.85 * st;
      ch.legR.rotation.z = -sw * 0.85 * st;
      ch.armL.rotation.z = -sw * 0.6 * st;
      ch.armR.rotation.z = sw * 0.6 * st;
      ch.root.rotation.z = -0.14 * st + Math.sin(time * 2 + id) * 0.02;
    }
    ch.root.position.y = Math.abs(Math.sin(v.phase)) * 4 * st;
    v.group.position.set(b.x, 0, b.y);

    v.label.userData.set(b.money != null ? `${b.name} ${b.money}💰` : b.name, b.color);

    v.aura.visible = !!b.dashing;
    if (b.dashing) v.aura.material.opacity = 0.2 + Math.sin(time * 30) * 0.1;
  }
  for (const [id, v] of views) {
    if (!blobs.has(id)) { scene.remove(v.group); views.delete(id); }
  }
}

// ---- the chain -------------------------------------------------------------------------

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
  const ordered = [...blobs.values()].filter(b => b.alive && views.has(b.id));
  const resp = extra?.resp || {};
  const runs = [];
  let run = [];
  for (const b of ordered) {
    if (resp[b.id]) { if (run.length > 1) runs.push(run); run = []; continue; }
    run.push(b);
  }
  if (run.length > 1) runs.push(run);

  for (const r of runs) {
    for (let i = 0; i < r.length - 1; i++) {
      const a = r[i], b = r[i + 1];
      const dist = Math.hypot(b.rx - a.rx, b.rz - a.rz);
      const slack = Math.max(0, C.LINK_LEN - dist);
      const sag = 6 + slack * 0.45;
      for (let j = 1; j <= LINKS_PER_PAIR; j++) {
        const t = j / (LINKS_PER_PAIR + 1);
        const link = getLink(li++);
        link.visible = true;
        link.position.set(
          a.rx + (b.rx - a.rx) * t,
          44 - Math.sin(t * Math.PI) * sag + Math.sin(time * 6 + j) * 1.5,
          a.rz + (b.rz - a.rz) * t,
        );
      }
    }
  }
  for (; li < chainPool.length; li++) chainPool[li].visible = false;
}

// ---- particles / floaters / corpses ------------------------------------------------------

function burst(x, z, color, n, { speed = 320, up = 300, life = 0.8, size = 1 } = {}) {
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
    p.mesh.position.set(x, C.PLAYER_RADIUS, z);
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
    p.mesh.scale.setScalar(1 + Math.random());
  }
}

function addFloater(x, z, text, color = '#fff', px = 48) {
  const s = makeTextSprite(text, { px, color });
  s.position.set(x, 110, z);
  scene.add(s);
  floaters.push({ sprite: s, life: 1.7 });
}

export function emoteAt(id, e) {
  const b = blobs.get(id);
  if (b && b.alive) addFloater(b.rx ?? b.x, (b.rz ?? b.y), e, '#fff', 72);
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
    if (p.mesh.position.y < 4) { p.mesh.position.y = 4; p.vy *= -0.4; p.vx *= 0.7; p.vz *= 0.7; }
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
    if (c.t > 1.4 || c.group.position.y < -800) {
      scene.remove(c.group);
      corpses.splice(i, 1);
    }
  }
}

// ---- snapshots ----------------------------------------------------------------------------

export function applySnapshot(snap, meta, selfId) {
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
    if (info) { b.money = info.coins; b.name = info.name; }

    if (b.wasAlive && !alive) {
      spawnCorpse(b);
      burst(b.rx, b.rz, b.color, 20, { speed: 400, life: 1 });
      shakeAmt = Math.max(shakeAmt, 12);
    }
    b.wasAlive = b.alive = !!alive;

    for (const ev of events || []) {
      const px = b.rx ?? x, pz = b.rz ?? y;
      if (ev === 'dash') { burst(px, pz, '#ffffff', 5, { speed: 120, up: 80, life: 0.35 }); if (id === selfId) sfx.dash(); }
      else if (ev === 'bonk') { burst(px, pz, '#ffffff', 8, { speed: 240, life: 0.4 }); sfx.bonk(); }
      else if (ev === 'boom') { burst(px, pz, '#ff9040', 40, { speed: 520, up: 420, life: 1.1, size: 1.6 }); shakeAmt = Math.max(shakeAmt, 26); sfx.boom(); }
      else if (ev === 'burn') { burst(px, pz, '#9dff2e', 22, { speed: 350, life: 0.8 }); shakeAmt = Math.max(shakeAmt, 10); sfx.splat(); addFloater(px, pz, '-1 ❤️', '#ff5252', 40); }
      else if (ev === 'dunk') { burst(px, pz, '#ffd84d', 26, { speed: 380, up: 460, life: 0.9 }); sfx.coin(); addFloater(px, pz, 'DUNKED!', '#ffd84d', 46); }
      else if (ev === 'tater') { burst(px, pz, '#ffb060', 10, { speed: 200, life: 0.5 }); sfx.tater(); }
      else if (ev === 'fall') { spawnCorpse(b); shakeAmt = Math.max(shakeAmt, 8); sfx.splat(); addFloater(px, pz, '-1 ❤️', '#ff5252', 40); }
      else if (ev === 'escape') { burst(px, pz, '#7CFC00', 24, { speed: 300, up: 500, life: 1 }); sfx.go(); addFloater(px, pz, 'SAFE!', '#7CFC00', 46); }
    }
  }
  for (const id of blobs.keys()) if (!seen.has(id)) blobs.delete(id);
}

// ---- frame -----------------------------------------------------------------------------

export function frame(dt, S) {
  if (!renderer) return;
  time += dt;
  resizeIfNeeded();

  ensureArena(S.scene);
  updateArena(dt, S.snap?.extra, S);
  updateBlobViews(dt);
  updateGremlinViews(dt);
  updateChain(S.snap?.extra);
  updateEffects(dt);

  shakeAmt = Math.max(0, shakeAmt - dt * 40);
  const sx = (Math.random() - 0.5) * shakeAmt;
  const sy = (Math.random() - 0.5) * shakeAmt;

  const self = blobs.get(S.selfId);
  const fx = Math.sin(camYaw), fz = -Math.cos(camYaw);
  let want, look;
  if (self && self.alive) {
    const DIST = 300, H = 235;
    want = new THREE.Vector3(self.rx - fx * DIST + sx, H + sy, self.rz - fz * DIST);
    look = new THREE.Vector3(self.rx + fx * 160, 5, self.rz + fz * 160);
  } else {
    // spectate: slow orbit of the whole scene
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
