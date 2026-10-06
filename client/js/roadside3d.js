// Roadside: everything along the road that isn't nature or a building. The
// stops' furniture (statics tagged s.poi: semi trailers, yard-sale tables, the
// crashed plane, junk piles, gas pumps and counter, the dino statue), the
// gas canopy, umbrella, plane and wheel decor, the ranger gates and keypads,
// the winch anchor posts, the camp's log seats and the parked RVs in town.
// Owned by the roadside art pass.
// API: buildRoadside(W) -> { group, gates, update(dt, t, camPos) }, isRoadside(s), PREVIEW.
import { THREE, canvasTex, flat, shadowy } from './gfx.js';

const ROADSIDE_PARTS = new Set(['log_seat', 'parked_rv', 'keypad_post']);
// statics this module draws (the rest are town3d's). Note: tags can be 0, so test with !== undefined.
export const isRoadside = s => (s.poi !== undefined && s.bld === undefined && s.town === undefined) || ROADSIDE_PARTS.has(s.part);

const MAT_COLORS = {
  wood: '#8a5a30', metal: '#c9ccd1', pump: '#d64545', post: '#6b4a2e', log: '#6b4a2e', junk: '#7a6e64', dino: '#5aa469', rvjunk: '#e0d6c8',
};

export function buildRoadside(W) {
  const group = new THREE.Group();
  const gates = new Map();
  for (const s of W.statics) {
    if (!isRoadside(s)) continue;
    const color = s.col || MAT_COLORS[s.mat] || '#cccccc';
    const m = new THREE.Mesh(new THREE.BoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2), flat(color));
    m.position.set(s.x, s.y, s.z);
    m.rotation.y = s.ry;
    shadowy(m);
    group.add(m);
  }
  // winch anchor posts
  for (const c of W.cyls) {
    if (c.mat !== 'post') continue;
    const m = new THREE.Mesh(new THREE.CylinderGeometry(c.r, c.r * 1.1, c.hh * 2, 7), flat('#6b4a2e'));
    m.position.set(c.x, c.y, c.z);
    shadowy(m);
    group.add(m);
    // anchor ring on top
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.04, 6, 12), flat('#f2c14e', { metalness: 0.6 }));
    ring.position.set(c.x, c.y + c.hh - 0.15, c.z);
    ring.rotation.x = Math.PI / 2;
    group.add(ring);
  }

  for (const d of W.decor) {
    if (d.k === 'canopy') {
      const c = new THREE.Mesh(new THREE.BoxGeometry(8, 0.3, 4), flat('#f4f1ea'));
      c.position.set(d.x, d.y, d.z); c.rotation.y = d.ry; shadowy(c); group.add(c);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(8.05, 0.12, 4.05), flat('#d64545'));
      stripe.position.set(d.x, d.y - 0.1, d.z); stripe.rotation.y = d.ry; group.add(stripe);
    } else if (d.k === 'umbrella') {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 5), flat('#ddd'));
      pole.position.set(d.x, d.y + 1.1, d.z);
      const top = new THREE.Mesh(new THREE.ConeGeometry(1.4, 0.5, 8), flat('#e84a5f'));
      top.position.set(d.x, d.y + 2.3, d.z);
      group.add(shadowy(pole), shadowy(top));
    } else if (d.k === 'plane') {
      const nose = new THREE.Mesh(new THREE.ConeGeometry(0.7, 1.4, 8), flat('#f1f1f1'));
      const s = Math.sin(d.ry), c = Math.cos(d.ry);
      nose.position.set(d.x + s * 3.9, d.y + 0.7, d.z + c * 3.9);
      nose.rotation.set(Math.PI / 2, 0, 0); nose.rotation.order = 'YXZ'; nose.rotation.y = d.ry;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.3, 1.0), flat('#d83a3a'));
      fin.position.set(d.x - s * 2.9, d.y + 1.8, d.z - c * 2.9); fin.rotation.y = d.ry;
      group.add(shadowy(nose), shadowy(fin));
    } else if (d.k === 'wheels') {
      // semi trailer wheels poking out
    }
  }

  for (const g of W.gates) {
    const gg = new THREE.Group();
    const bars = new THREE.Group();
    const steel = flat('#c9c3b5', { metalness: 0.5, roughness: 0.5 });
    const rail = new THREE.Mesh(new THREE.BoxGeometry(g.hx * 2, 0.16, 0.16), steel);
    rail.position.y = g.hy - 0.1;
    const rail2 = rail.clone(); rail2.position.y = -g.hy + 0.25;
    bars.add(rail, rail2);
    for (let x = -g.hx + 0.4; x < g.hx; x += 0.55) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(0.07, g.hy * 2, 0.07), steel);
      b.position.x = x;
      bars.add(b);
    }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(g.hx * 2, 0.5, 0.2), new THREE.MeshStandardMaterial({ map: canvasTex(stripes()), roughness: 0.6 }));
    stripe.position.y = 0.2;
    bars.add(stripe);
    gg.add(bars);
    gg.position.set(g.x, g.y, g.z);
    group.add(shadowy(gg));
    gates.set(g.id, { bars, open: 0, target: 0, hx: g.hx });
  }

  for (const u of W.uses) {
    if (u.kind === 'keypad') {
      const k = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.08), new THREE.MeshStandardMaterial({ map: canvasTex(keypadCanvas()), roughness: 0.6 }));
      k.position.set(u.x, u.y, u.z);
      k.rotation.y = Math.PI;
      group.add(k);
    }
  }

  return {
    group, gates,
    update(dt) {
      for (const g of gates.values()) {
        g.open += (g.target - g.open) * Math.min(1, dt * 1.5);
        g.bars.position.x = g.open * g.hx * 1.9;
      }
    },
  };
}

function stripes() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 32;
  const g = cv.getContext('2d');
  for (let i = 0; i < 16; i++) { g.fillStyle = i % 2 ? '#d62828' : '#ffffff'; g.fillRect(i * 16, 0, 16, 32); }
  return cv;
}

function keypadCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 128; cv.height = 160;
  const g = cv.getContext('2d');
  g.fillStyle = '#2b2b2b'; g.fillRect(0, 0, 128, 160);
  g.fillStyle = '#7CFC00'; g.fillRect(12, 10, 104, 26);
  g.fillStyle = '#ddd';
  for (let r = 0; r < 4; r++) for (let c = 0; c < 3; c++) { g.fillRect(14 + c * 36, 46 + r * 28, 28, 22); }
  return cv;
}

export const PREVIEW = {};
