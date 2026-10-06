// Chunky little humans (ported from the Slop Pit build, now in meters) and
// your own first-person hands.
import { THREE, flat, labelSprite, canvasTex } from './gfx.js';
import * as C from '/shared/constants.js';

const U = 0.0165;   // the character was modeled in "centimeters-ish"
const GEO = {
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
  eye: new THREE.SphereGeometry(5.4, 12, 10).scale(1, 1.2, 1),
  pupil: new THREE.SphereGeometry(2.8, 8, 6),
};
const SKINS = ['#f2c9a0', '#e8ab72', '#c98e55', '#9a6b42', '#f6d7b8', '#7a5236'];
const HAIRS = ['#3a2a1e', '#191922', '#6b4a2e', '#8a8a92', '#b8862e', '#2e1c14'];
const EYE_WHITE = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.3 });
const PUPIL = new THREE.MeshStandardMaterial({ color: 0x1a1426, roughness: 0.4 });
const SHOE = flat('#2a2233');
const HAT_DARK = flat('#14101f'), HAT_RED = flat('#d8333f'), HAT_GOLD = flat('#ffd84d', { metalness: 0.4, roughness: 0.4 });

function makeHat(i) {
  const hat = new THREE.Group();
  if (i === 1) {
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(15, 15, 3, 14), HAT_DARK);
    const top = new THREE.Mesh(new THREE.CylinderGeometry(10, 10, 18, 14), HAT_DARK); top.position.y = 10;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(10.5, 10.5, 5, 14), HAT_RED); band.position.y = 4;
    hat.add(brim, top, band);
  } else if (i === 2) {
    const dome = new THREE.Mesh(new THREE.SphereGeometry(13, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), HAT_RED);
    const brim = new THREE.Mesh(new THREE.BoxGeometry(12, 2.5, 14), HAT_RED); brim.position.set(12, 1, 0);
    hat.add(dome, brim);
  } else if (i === 3) {
    const fez = new THREE.Mesh(new THREE.CylinderGeometry(7, 10, 13, 12), HAT_RED); fez.position.y = 5;
    hat.add(fez);
  } else if (i === 4) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(10, 11, 7, 10), HAT_GOLD); ring.position.y = 2;
    hat.add(ring);
  } else if (i === 5) {
    // trucker cap
    const dome = new THREE.Mesh(new THREE.SphereGeometry(13.5, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), flat('#f4f1ea'));
    const brim = new THREE.Mesh(new THREE.BoxGeometry(13, 2.5, 15), flat('#2e86ab')); brim.position.set(12, 1, 0);
    hat.add(dome, brim);
  }
  hat.scale.setScalar(1.25);
  return hat;
}

const matCache = new Map();
function mats(color, skin) {
  const k = color + skin;
  if (!matCache.has(k)) {
    const base = new THREE.Color(color);
    matCache.set(k, {
      shirt: flat('#' + base.getHexString()),
      pants: flat('#' + base.clone().lerp(new THREE.Color('#14101f'), 0.5).getHexString()),
      skin: flat(SKINS[skin % SKINS.length]),
      hair: flat(HAIRS[skin % HAIRS.length]),
    });
  }
  return matCache.get(k);
}

// Root at the feet. Inner model faces local +x; root.rotation.y = -PI/2 turns it to face +z.
export function buildCharacter(color, { hatIndex = 0, skinIndex = 0, scale = 1, eyeColor = null } = {}) {
  const m = mats(color, skinIndex);
  const root = new THREE.Group();
  const body = new THREE.Group();
  body.scale.setScalar(U * scale);
  root.add(body);
  const legL = new THREE.Group(), legR = new THREE.Group();
  for (const [pivot, side] of [[legL, -1], [legR, 1]]) {
    pivot.position.set(0, 30, side * 9.5);
    const thigh = new THREE.Mesh(GEO.thigh, m.pants); thigh.position.y = -13;
    const shoe = new THREE.Mesh(GEO.shoe, SHOE); shoe.position.set(3.5, -26, 0);
    pivot.add(thigh, shoe);
    body.add(pivot);
  }
  const torso = new THREE.Mesh(GEO.torso, m.shirt);
  torso.position.y = 50; torso.scale.set(1.14, 1, 1.06);
  body.add(torso);
  const armL = new THREE.Group(), armR = new THREE.Group();
  for (const [pivot, side] of [[armL, -1], [armR, 1]]) {
    pivot.position.set(0, 66, side * 20.5);
    const sleeve = new THREE.Mesh(GEO.sleeve, m.shirt); sleeve.position.y = -5;
    const fore = new THREE.Mesh(GEO.forearm, m.skin); fore.position.y = -15;
    const hand = new THREE.Mesh(GEO.hand, m.skin); hand.position.y = -24;
    pivot.add(sleeve, fore, hand);
    body.add(pivot);
  }
  const head = new THREE.Group();
  head.position.y = 90;
  const skull = new THREE.Mesh(GEO.head, m.skin);
  head.add(skull);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(GEO.eye, EYE_WHITE); eye.position.set(13.8, 3.5, side * 6.8);
    const pupil = new THREE.Mesh(GEO.pupil, eyeColor ? new THREE.MeshBasicMaterial({ color: eyeColor }) : PUPIL); pupil.position.set(4, 0.3, 0);
    eye.add(pupil);
    const brow = new THREE.Mesh(GEO.brow, m.hair); brow.position.set(14.6, 10, side * 6.8);
    const ear = new THREE.Mesh(GEO.ear, m.skin); ear.position.set(0, 0.5, side * 16);
    head.add(eye, brow, ear);
  }
  const nose = new THREE.Mesh(GEO.nose, m.skin); nose.position.set(16.2, -1.5, 0);
  const hair = new THREE.Mesh(GEO.hair, m.hair); hair.position.set(-1.5, 2.5, 0); hair.rotation.z = 0.3;
  const hat = makeHat(hatIndex); hat.position.y = 14;
  head.add(nose, hair, hat);
  body.add(head);
  body.rotation.y = 0;
  root.userData.body = body;
  const inner = new THREE.Group();
  inner.add(root);
  root.rotation.y = -Math.PI / 2;
  return { root: inner, body, legL, legR, armL, armR, torso, head };
}

// ---- other players --------------------------------------------------------------

const spring = (s, target, dt, k = 170, d = 11) => { s.v += (target - s.a) * k * dt; s.v *= Math.max(0, 1 - d * dt); s.a += s.v * dt; return s.a; };
const sp = () => ({ a: 0, v: 0 });

export class PlayerView {
  constructor(scene, p) {
    this.id = p.id;
    this.group = new THREE.Group();
    this.ch = buildCharacter(p.color, { hatIndex: p.id % 6, skinIndex: (p.id * 7) % 6 });
    this.ch.root.traverse(o => { if (o.isMesh) o.castShadow = true; });
    this.tilt = new THREE.Group();
    this.tilt.add(this.ch.root);
    this.group.add(this.tilt);
    this.label = labelSprite(p.name, p.color, 40);
    this.label.position.y = 2.25;
    this.group.add(this.label);
    this.mic = labelSprite('🔊', '#fff', 60);
    this.mic.scale.set(0.9, 0.45, 1);
    this.mic.position.y = 2.65;
    this.mic.visible = false;
    this.group.add(this.mic);
    this.walkie = labelSprite('📻', '#fff', 60);
    this.walkie.scale.set(0.9, 0.45, 1);
    this.walkie.position.y = 2.65;
    this.walkie.visible = false;
    this.group.add(this.walkie);
    this.phase = 0;
    this.s = { lL: sp(), lR: sp(), aL: sp(), aR: sp(), lean: sp(), tip: sp(), head: sp(), drop: sp() };
    this.prev = null;
    this.emote = null;
    scene.add(this.group);
  }

  setName(name, color) { this.label.userData.set(name, color); }

  dispose(scene) { scene.remove(this.group); }

  update(dt, t, st) {
    // st: {pos, yaw, pitch, mode, flags, speaking, walkieTx}
    this.group.position.set(st.pos.x, st.pos.y, st.pos.z);
    this.group.rotation.y = st.yaw;
    const v = this.prev ? Math.hypot(st.pos.x - this.prev.x, st.pos.z - this.prev.z) / Math.max(dt, 1e-3) : 0;
    this.prev = { ...st.pos };
    const speed = Math.min(1.4, v / 4.4);
    this.phase += dt * (3 + v * 2.1);
    const sw = Math.sin(this.phase);
    const M = C.MODE, F = C.FLAG;
    let lL = 0, lR = 0, aL = 0, aR = 0, lean = 0, tip = 0, head = -st.pitch * 0.6, drop = 0;
    if (st.mode === M.KO) {
      tip = Math.PI / 2 - 0.1;
      lL = Math.sin(t * 3 + this.id) * 0.2; lR = -lL; aL = 2.6; aR = 2.3; head = 0.3;
    } else if (st.mode === M.SEAT) {
      lL = 1.5; lR = 1.5; aL = 1.2; aR = 1.2; drop = -0.45; head = -st.pitch * 0.4;
    } else if (st.mode === M.CLIMB) {
      const c = Math.sin(t * 5 + this.id);
      aL = 2.7 + c * 0.35; aR = 2.7 - c * 0.35; lL = 0.5 + c * 0.4; lR = 0.5 - c * 0.4; lean = 0.15;
    } else if (st.mode === M.AIR) {
      lL = 0.6; lR = -0.2; aL = 2.4; aR = 2.0; lean = 0.1;
    } else {
      lL = sw * 0.85 * speed; lR = -sw * 0.85 * speed;
      aL = -sw * 0.6 * speed; aR = sw * 0.6 * speed;
      lean = (st.flags & F.SPRINT ? 0.22 : 0.08) * speed;
      if (st.flags & F.CROUCH) { drop = -0.35; lL += 0.9; lR += 0.9; lean += 0.3; }
    }
    if ((st.flags & F.HOLDING) && st.mode !== M.KO && st.mode !== M.CLIMB) {
      aL = st.flags & F.MAP ? 1.0 : 1.45; aR = aL;
    }
    if (this.emote) {
      this.emote.t -= dt;
      const e = this.emote.e;
      if (e === '😂') { aL = 2.6 + Math.sin(t * 14) * 0.3; aR = 2.6 - Math.sin(t * 14) * 0.3; drop = Math.abs(Math.sin(t * 14)) * 0.08; }
      else if (e === '😭') { aL = 0.2; aR = 0.2; head = 0.6; lean = 0.3; }
      else if (e === '💀') { tip = Math.PI / 2 - 0.15; aL = Math.sin(t * 19) * 1.8; aR = -aL; }
      else if (e === '🤬') { aL = 2.4 + Math.sin(t * 22) * 0.6; aR = 2.4 - Math.sin(t * 22) * 0.6; lL = Math.sin(t * 19); lR = -lL; }
      else if (e === '👑') { aL = 3; aR = 3; lean = -0.2; }
      else { this.tilt.rotation.y += dt * 12; }
      if (this.emote.t <= 0) { this.emote = null; this.tilt.rotation.y = 0; }
    }
    const ch = this.ch, s = this.s;
    ch.legL.rotation.z = spring(s.lL, lL, dt);
    ch.legR.rotation.z = spring(s.lR, lR, dt);
    ch.armL.rotation.z = spring(s.aL, aL, dt, 150, 9);
    ch.armR.rotation.z = spring(s.aR, aR, dt, 150, 9);
    ch.body.rotation.z = -spring(s.lean, lean, dt, 120, 9);
    ch.head.rotation.z = spring(s.head, head, dt, 130, 9);
    this.tilt.rotation.x = -spring(s.tip, tip, dt, 60, 7);
    this.tilt.position.y = spring(s.drop, drop + (st.mode === M.KO ? 0.25 : 0), dt, 90, 9);
    this.mic.visible = !!st.speaking && !st.walkieTx;
    this.walkie.visible = !!st.walkieTx;
    if (this.mic.visible || this.walkie.visible) {
      const k = 0.9 + Math.sin(t * 10) * 0.08;
      (this.mic.visible ? this.mic : this.walkie).scale.set(k, k / 2, 1);
    }
    this.label.visible = st.mode !== M.KO || Math.sin(t * 4) > 0;
  }
}

// ---- first-person hands ----------------------------------------------------------

export class Hands {
  constructor(camera, color) {
    this.g = new THREE.Group();
    camera.add(this.g);
    const glove = flat(color);
    const cuff = flat('#f4f1ea');
    this.L = this.mitt(glove, cuff, -1);
    this.R = this.mitt(glove, cuff, 1);
    this.g.add(this.L, this.R);
    this.t = 0;
    this.map = null;
    this.state = 'idle';
  }
  mitt(glove, cuff, side) {
    const h = new THREE.Group();
    const palm = new THREE.Mesh(new THREE.SphereGeometry(0.062, 9, 7).scale(1, 0.75, 1.25), glove);
    const thumb = new THREE.Mesh(new THREE.SphereGeometry(0.032, 7, 5).scale(1, 1, 1.6), glove);
    thumb.position.set(-side * 0.065, 0.015, -0.02);
    const c = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.012, 5, 12), cuff);
    c.position.z = 0.07;
    h.add(palm, thumb, c);
    h.userData.side = side;
    return h;
  }
  setColor(color) {
    const m = flat(color);
    for (const h of [this.L, this.R]) h.children.forEach((c, i) => { if (i !== 2) c.material = m; });
  }
  showMap(canvas) {
    if (!this.map) {
      this.mapTex = canvasTex(canvas);
      this.map = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.34), new THREE.MeshBasicMaterial({ map: this.mapTex, side: THREE.DoubleSide, fog: false, toneMapped: false }));
      this.map.position.set(0, -0.06, -0.42);
      this.map.rotation.x = -0.12;
      this.g.add(this.map);
    }
    this.mapTex.image = canvas;
    this.mapTex.needsUpdate = true;
    this.map.visible = true;
  }
  hideMap() { if (this.map) this.map.visible = false; }

  update(dt, me, moving, sprinting) {
    this.t += dt * (sprinting ? 13 : 8.5);
    const bob = moving ? Math.sin(this.t) * 0.012 : Math.sin(this.t * 0.25) * 0.004;
    const pose = (h, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const k = Math.min(1, dt * 14);
      h.position.x += (x - h.position.x) * k; h.position.y += (y - h.position.y) * k; h.position.z += (z - h.position.z) * k;
      h.rotation.x += (rx - h.rotation.x) * k; h.rotation.y += (ry - h.rotation.y) * k; h.rotation.z += (rz - h.rotation.z) * k;
    };
    const st = me.mode;
    this.g.visible = st !== 'ko';
    if (st === 'climb') {
      const c = Math.sin(performance.now() / 160);
      pose(this.L, -0.2, 0.06 + (moving ? c * 0.07 : 0), -0.42, 0.5, 0, 0.2);
      pose(this.R, 0.2, 0.06 - (moving ? c * 0.07 : 0), -0.42, 0.5, 0, -0.2);
    } else if (st === 'seat' && me.seat === 0) {
      pose(this.L, -0.18, -0.2, -0.45, 0.6, 0, 0.5);
      pose(this.R, 0.18, -0.2, -0.45, 0.6, 0, -0.5);
    } else if (me.holding?.type === 'map') {
      pose(this.L, -0.24, -0.16 + bob, -0.44, 0.2, 0, 0.4);
      pose(this.R, 0.24, -0.16 + bob, -0.44, 0.2, 0, -0.4);
    } else if (me.holding) {
      pose(this.L, -0.17, -0.17 + bob, -0.5, 0.15, 0.3, 0.3);
      pose(this.R, 0.17, -0.17 + bob, -0.5, 0.15, -0.3, -0.3);
    } else {
      pose(this.L, -0.3, -0.29 + bob, -0.44, 0.1, 0.2, 0.15);
      pose(this.R, 0.3, -0.29 - bob, -0.44, 0.1, -0.2, -0.15);
    }
  }
}

// ---- preview (tools/preview.mjs) ----
export const PREVIEW = {
  player: () => buildCharacter('#7CFC00', { hatIndex: 5, skinIndex: 1 }).root,
  player2: () => buildCharacter('#FF6EC7', { hatIndex: 2, skinIndex: 3 }).root,
  player3: () => buildCharacter('#00E5FF', { hatIndex: 0, skinIndex: 5 }).root,
  dealer: () => buildCharacter('#111111', { hatIndex: 1, skinIndex: 4, eyeColor: '#d62828' }).root,
  repoman: () => buildCharacter('#6b5640', { hatIndex: 0, skinIndex: 1, scale: 1.25 }).root,
};
