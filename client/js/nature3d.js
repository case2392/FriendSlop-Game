// Nature: trees, bushes, rocks, flowers, cacti, bones, campfires — every
// W.decor entry of a natural kind, plus the dead-tree winch anchors.
// Owned by the nature art pass. API: buildNature(W) -> { group, fires, update(dt, t, camPos) }
// and PREVIEW = { name: () => Object3D } for tools/preview.mjs.
import { THREE, flat, roughen, shadowy } from './gfx.js';

export const NATURE_KINDS = new Set(['oak', 'pine', 'palm', 'bush', 'flowers', 'stump', 'fence', 'haybale', 'wheat', 'scarecrow', 'cactus', 'deadtree', 'rock', 'bones', 'skull', 'fire']);

function deadTree(c) {
  const g = new THREE.Group();
  const bark = flat('#6e5a4a');
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(c.r * 0.7, c.r, c.hh * 2, 6), bark);
  trunk.position.y = 0;
  g.add(trunk);
  for (let i = 0; i < 4; i++) {
    const br = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.11, 1.3, 5), bark);
    const a = i * 1.7;
    br.position.set(Math.cos(a) * 0.35, c.hh * 0.6 - i * 0.25, Math.sin(a) * 0.35);
    br.rotation.set(Math.sin(a) * 0.9, 0, Math.cos(a) * 0.9);
    g.add(br);
  }
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.05, 6, 12), flat('#f2c14e', { metalness: 0.6 }));
  ring.position.y = -c.hh + 1.1;
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  g.position.set(c.x, c.y, c.z);
  return shadowy(g);
}

function cactus(d) {
  const g = new THREE.Group();
  const m = flat('#4f9e4a');
  const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.27, d.h, 7), m);
  trunk.position.y = d.h / 2;
  g.add(trunk);
  const cap = new THREE.Mesh(new THREE.SphereGeometry(0.22, 7, 4), m);
  cap.position.y = d.h;
  g.add(cap);
  for (const s of [-1, 1]) {
    if (d.h < 2 && s > 0) continue;
    const arm = new THREE.Group();
    const a1 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.5, 6), m);
    a1.rotation.z = Math.PI / 2; a1.position.x = 0.3 * s;
    const a2 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.7, 6), m);
    a2.position.set(0.52 * s, 0.3, 0);
    const c2 = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 4), m);
    c2.position.set(0.52 * s, 0.65, 0);
    arm.add(a1, a2, c2);
    arm.position.y = d.h * (s > 0 ? 0.55 : 0.42);
    g.add(arm);
  }
  g.position.set(d.x, d.y, d.z);
  g.rotation.y = d.ry;
  return shadowy(g);
}

function rock(d) {
  const geo = roughen(new THREE.IcosahedronGeometry(d.s, 0), d.s * 0.25, Math.floor(d.x * 13 + d.z * 7));
  const m = new THREE.Mesh(geo, flat(['#b9573a', '#c97a4f', '#9e6a50'][Math.abs(Math.floor(d.x + d.z)) % 3]));
  m.position.set(d.x, d.y + d.s * 0.3, d.z);
  m.scale.y = 0.7;
  m.rotation.y = d.ry;
  return shadowy(m);
}

function campfire(d, fires) {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const s = new THREE.Mesh(new THREE.DodecahedronGeometry(0.22, 0), flat('#8d8d8d'));
    const a = i / 5 * Math.PI * 2;
    s.position.set(Math.cos(a) * 0.6, 0.1, Math.sin(a) * 0.6);
    g.add(s);
  }
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.4, 1.1, 6), new THREE.MeshBasicMaterial({ color: 0xffa23a, transparent: true, opacity: 0.9 }));
  flame.position.y = 0.55;
  const inner = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.7, 5), new THREE.MeshBasicMaterial({ color: 0xfff1a6 }));
  inner.position.y = 0.4;
  g.add(flame, inner);
  const light = new THREE.PointLight(0xff9a3c, 14, 16, 1.6);
  light.position.y = 1.2;
  g.add(light);
  g.position.set(d.x, d.y, d.z);
  fires.push({ flame, inner, light });
  return g;
}

function skull(d) {
  const g = new THREE.Group();
  const bone = flat('#f1ead8');
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 2.2), bone);
  head.position.y = 1.0;
  const snout = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.8, 1.2), bone);
  snout.position.set(0, 0.7, 1.4);
  g.add(head, snout);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.1), flat('#2a1d18'));
    eye.position.set(0.38 * s, 1.15, 1.11);
    const horn = new THREE.Mesh(new THREE.ConeGeometry(0.18, 1.8, 6), bone);
    horn.position.set(1.3 * s, 1.6, -0.4);
    horn.rotation.z = -s * 1.1;
    g.add(eye, horn);
  }
  g.position.set(d.x, d.y, d.z);
  g.rotation.y = d.ry;
  g.scale.setScalar(1.6);
  return shadowy(g);
}

// placeholders until the nature pass lands: chunky, smooth, readable
function placeholder(d) {
  const g = new THREE.Group();
  const s = d.s || 1;
  const add = (geo, color, y) => { const m = new THREE.Mesh(geo, flat(color)); m.position.y = y; g.add(m); };
  if (d.k === 'oak') { add(new THREE.CylinderGeometry(0.35 * s, 0.5 * s, 3.4 * s, 8), '#6b4a2e', 1.7 * s); add(new THREE.SphereGeometry(2.6 * s, 10, 8), '#4f7d2a', 4.4 * s); }
  else if (d.k === 'pine') { add(new THREE.CylinderGeometry(0.25 * s, 0.35 * s, 2.4 * s, 8), '#5a3d26', 1.2 * s); add(new THREE.ConeGeometry(1.8 * s, 5 * s, 9), '#2f5a32', 4.4 * s); }
  else if (d.k === 'palm') { add(new THREE.CylinderGeometry(0.2 * s, 0.3 * s, 5.5 * s, 8), '#8a6a44', 2.75 * s); add(new THREE.SphereGeometry(1.6 * s, 8, 4), '#5d8a35', 5.6 * s); }
  else if (d.k === 'bush') add(new THREE.SphereGeometry(0.9 * s, 9, 6), '#4e7a2c', 0.6 * s);
  else if (d.k === 'haybale') { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 1.2, 14), flat('#d8b860')); m.rotation.z = Math.PI / 2; m.position.y = 0.75; g.add(m); }
  else if (d.k === 'stump') add(new THREE.CylinderGeometry(0.45, 0.55, 0.6, 9), '#7a5a3a', 0.3);
  else if (d.k === 'scarecrow') { add(new THREE.CylinderGeometry(0.06, 0.06, 2.2, 6), '#6b4a2e', 1.1); add(new THREE.SphereGeometry(0.25, 8, 6), '#d8b860', 2.2); }
  else if (d.k === 'bones') add(new THREE.SphereGeometry(0.3, 8, 6), '#efe6cf', 0.15);
  else if (d.k === 'fence') { for (let i = 0; i < (d.len || 4); i++) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.12, 1.0, 0.12), flat('#7a5a3a')); p.position.set(i * 1.6, 0.5, 0); g.add(p); } const r = new THREE.Mesh(new THREE.BoxGeometry((d.len || 4) * 1.6, 0.1, 0.06), flat('#8a6a44')); r.position.set(((d.len || 4) - 1) * 0.8, 0.75, 0); g.add(r); }
  else if (d.k === 'flowers' || d.k === 'wheat') return null;   // ground clutter handles these
  g.position.set(d.x, d.y, d.z);
  g.rotation.y = d.ry || 0;
  return shadowy(g);
}

export function buildNature(W) {
  const group = new THREE.Group();
  const fires = [];
  for (const d of W.decor) {
    if (!NATURE_KINDS.has(d.k)) continue;
    let o = null;
    if (d.k === 'cactus') o = cactus(d);
    else if (d.k === 'rock') o = rock(d);
    else if (d.k === 'fire') o = campfire(d, fires);
    else if (d.k === 'skull') o = skull(d);
    else if (d.k === 'deadtree') o = deadTree({ x: d.x, y: d.y + 1.6 * (d.s || 1), z: d.z, r: 0.25, hh: 1.6 * (d.s || 1) });
    else o = placeholder(d);
    if (o) group.add(o);
  }
  for (const c of W.cyls) if (c.mat === 'deadtree') group.add(deadTree(c));
  return {
    group, fires,
    update(dt, t) {
      for (const f of fires) {
        const k = 1 + Math.sin(t * 13) * 0.08 + Math.sin(t * 7.3) * 0.06;
        f.flame.scale.set(1, k, 1);
        f.inner.scale.set(1, 1.1 - (k - 1), 1);
        f.light.intensity = 13 * k;
      }
    },
  };
}

const at = (k, extra = {}) => ({ k, x: 0, y: 0, z: 0, ry: 0.4, s: 1, ...extra });
export const PREVIEW = {
  oak: () => placeholder(at('oak')), pine: () => placeholder(at('pine')), palm: () => placeholder(at('palm')),
  bush: () => placeholder(at('bush')), stump: () => placeholder(at('stump')), haybale: () => placeholder(at('haybale')),
  scarecrow: () => placeholder(at('scarecrow')), fence: () => placeholder(at('fence', { len: 4 })), bones: () => placeholder(at('bones')),
  cactus: () => cactus(at('cactus', { h: 2.4 })), rock: () => rock(at('rock', { s: 1.4 })), skull: () => skull(at('skull')),
  deadtree: () => deadTree({ x: 0, y: 1.6, z: 0, r: 0.25, hh: 1.6 }), campfire: () => campfire(at('fire'), []),
};
