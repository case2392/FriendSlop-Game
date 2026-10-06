// Structures: buildings, stops' furniture, signs, the ranger gates, the town
// (pawn shop, store, casino furniture, the Repo Man and his truck), NPCs.
// Owned by the architecture art pass.
// API: buildStructures(W) -> { group, near, gates, npcs, pawnLabel, bjLabel, flipLabel,
//      cardGroup, coin, hitPad, standPad, update(dt, t, camPos) } and PREVIEW.
import { THREE, canvasTex, flat, textCanvas, labelSprite, roughen, shadowy } from './gfx.js';
import { buildCharacter } from './people.js';

const MAT_COLORS = {
  floor: '#cfc6b8', roof: '#7a4b3a', wood: '#8a5a30', metal: '#c9ccd1', pump: '#d64545', felt: '#1f7a4d',
  machine: '#d4af37', casino: '#6a2c70', post: '#6b4a2e', log: '#6b4a2e', junk: '#7a6e64', dino: '#5aa469',
  rvjunk: '#e0d6c8', stucco: '#e9d8b4', wall: '#e9d8b4',
};

function buildStatics(W, group) {
  for (const s of W.statics) {
    if (s.mat === 'invisible') continue;
    const color = s.col || MAT_COLORS[s.mat] || '#cccccc';
    const opts = s.mat === 'machine' ? { emissive: new THREE.Color(color).multiplyScalar(0.25) } : s.mat === 'casino' ? { emissive: new THREE.Color('#2a0d2e') } : {};
    const m = new THREE.Mesh(new THREE.BoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2), flat(color, opts));
    m.position.set(s.x, s.y, s.z);
    m.rotation.y = s.ry;
    shadowy(m);
    group.add(m);
    if (s.mat === 'stucco' || s.mat === 'casino') {
      // a little trim along the top so buildings don't look like tofu
      const trim = new THREE.Mesh(new THREE.BoxGeometry(s.hx * 2 + 0.08, 0.18, s.hz * 2 + 0.08), flat(s.mat === 'casino' ? '#ffd700' : '#8c5a3c'));
      trim.position.set(s.x, s.y + s.hy - 0.09, s.z);
      trim.rotation.y = s.ry;
      group.add(trim);
    }
  }
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
}

function buildSigns(W, group, near) {
  for (const s of W.signs) {
    const cv = textCanvas(s.lines, { w: 512, h: Math.round(512 * s.h / s.w), bg: s.bg, fg: s.fg, neon: s.neon, painted: s.painted, border: s.billboard ? '#ffffff' : null });
    const tex = canvasTex(cv);
    const mat = new THREE.MeshStandardMaterial({ map: tex, transparent: !!s.painted, roughness: 0.8, side: THREE.DoubleSide,
      emissive: s.neon ? new THREE.Color('#ffffff') : new THREE.Color('#000000'), emissiveMap: s.neon ? tex : null, emissiveIntensity: s.neon ? 0.9 : 0,
      polygonOffset: !!s.flat, polygonOffsetFactor: -3 });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(s.w, s.h), mat);
    m.position.set(s.x, s.y, s.z);
    m.rotation.y = s.ry;
    if (s.flat) {
      m.rotation.set(-Math.PI / 2, 0, s.ry, 'YXZ');
      m.rotation.order = 'YXZ';
      m.rotation.y = s.ry; m.rotation.x = -Math.PI / 2;
      m.visible = false;
      near.push({ mesh: m, x: s.x, y: s.y, z: s.z, r: s.near || 10 });
    }
    group.add(m);
    if (s.post || s.billboard) {
      const legs = s.billboard ? [-s.w * 0.35, s.w * 0.35] : [-s.w * 0.4, s.w * 0.4];
      const hgt = s.y;
      for (const lx of legs) {
        const L = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1, 0.14), flat(s.billboard ? '#5d4a3a' : '#7a6a58'));
        const cx = s.x + Math.cos(s.ry) * lx, cz = s.z - Math.sin(s.ry) * lx;
        const gy = W.heightAt(cx, cz);
        const top = hgt - s.h / 2;
        L.scale.y = Math.max(0.3, top - gy + 0.3);
        L.position.set(cx, (top + gy) / 2, cz);
        shadowy(L);
        group.add(L);
      }
      // back panel so signs aren't paper-thin from behind
      const back = new THREE.Mesh(new THREE.BoxGeometry(s.w + 0.1, s.h + 0.1, 0.08), flat('#5d5148'));
      back.position.set(s.x - Math.sin(s.ry) * 0.06, s.y, s.z - Math.cos(s.ry) * 0.06);
      back.rotation.y = s.ry;
      shadowy(back);
      group.add(back);
    }
  }
}

function towTruck(t) {
  const g = new THREE.Group();
  const body = flat('#4a5160'), chrome = flat('#c8ccd2', { metalness: 0.7, roughness: 0.3 });
  const cab = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.9, 2.2), body); cab.position.set(0, 1.55, 2.0);
  const bed = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.5, 4.2), body); bed.position.set(0, 0.95, -1.2);
  const glass = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.7, 0.05), flat('#2d3b4f', { metalness: 0.4, roughness: 0.2 })); glass.position.set(0, 2.0, 3.12);
  const boom = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 3.2), flat('#f2c14e')); boom.position.set(0, 2.2, -2.2); boom.rotation.x = 0.45;
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.06, 6, 10, Math.PI * 1.4), chrome); hook.position.set(0, 2.2, -3.9);
  g.add(cab, bed, glass, boom, hook);
  for (const [x, z] of [[-1.15, 2.0], [1.15, 2.0], [-1.15, -2.2], [1.15, -2.2]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.4, 10), flat('#151515'));
    w.rotation.z = Math.PI / 2; w.position.set(x, 0.55, z); g.add(w);
  }
  const lbl = new THREE.Mesh(new THREE.PlaneGeometry(2.0, 0.6), new THREE.MeshBasicMaterial({ map: canvasTex(textCanvas(['REPO'], { w: 256, h: 80, bg: '#4a5160', fg: '#f2c14e' })) }));
  lbl.position.set(1.21, 1.6, 2.0); lbl.rotation.y = Math.PI / 2;
  g.add(lbl);
  const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.15, 0.25), new THREE.MeshBasicMaterial({ color: 0xffa500 }));
  beacon.position.set(0, 2.6, 2.0);
  g.add(beacon);
  g.position.set(t.x, t.y, t.z);
  g.rotation.y = t.ry;
  return shadowy(g);
}

function button(u, color, text) {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.15, 0.08, 12), flat(color, { emissive: new THREE.Color(color).multiplyScalar(0.35) }));
  g.add(b);
  if (text) {
    const s = labelSprite(text, '#fff', 34);
    s.scale.set(0.9, 0.17, 1);
    s.position.y = 0.22;
    g.add(s);
  }
  g.position.set(u.x, u.y - 0.04, u.z);
  return g;
}

export function buildStructures(W) {
  const group = new THREE.Group();
  const near = [];
  const gates = new Map();
  const npcs = [];
  buildStatics(W, group);
  buildSigns(W, group, near);

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
    } else if (d.k === 'lamp') {
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 5, 6), flat('#3c3c44'));
      pole.position.set(d.x, d.y + 2.5, d.z);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0xfff1c1 }));
      head.position.set(d.x, d.y + 5.0, d.z);
      group.add(shadowy(pole), head);
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

  const T = W.town;
  // NPCs: Honest Ed, the clerk, the dealer, the Repo Man
  const npc = (spot, color, opts, label) => {
    const ch = buildCharacter(color, opts);
    ch.root.position.set(spot.x, spot.y, spot.z);
    ch.root.rotation.y = spot.ry ?? 0;
    shadowy(ch.root);
    group.add(ch.root);
    if (label) {
      const s = labelSprite(label, '#ffe9a8', 30);
      s.position.set(spot.x, spot.y + 2.25, spot.z);
      s.scale.set(1.9, 0.36, 1);
      group.add(s);
    }
    npcs.push(ch);
    return ch;
  };
  npc({ ...T.pawnKeeper, ry: T.pawnKeeper.ry }, '#c0392b', { hatIndex: 2, skinIndex: 3 }, 'HONEST ED');
  npc({ ...T.clerk, ry: T.clerk.ry }, '#2e86ab', { hatIndex: 0, skinIndex: 4 }, 'CLERK');
  npc({ ...T.bj.dealer, ry: T.bj.ry + Math.PI }, '#111111', { hatIndex: 1, skinIndex: 4, eyeColor: '#d62828' }, 'THE DEALER');
  const repoSpot = { x: T.repo.x - 2.4, y: T.repo.y, z: T.repo.z + 0.6, ry: -Math.PI / 2 };   // street side, facing you
  const repo = npc(repoSpot, '#6b5640', { hatIndex: 0, skinIndex: 1, scale: 1.25 }, 'THE REPO MAN');
  // sunglasses
  const shades = new THREE.Mesh(new THREE.BoxGeometry(4, 5, 30), flat('#0a0a0a'));
  shades.position.set(16.5, 4, 0);
  repo.head.add(shades);
  group.add(towTruck(T.repo));

  // pawn counter appraisal + casino furniture
  const pawnLabel = labelSprite('', '#7CFC00', 44);
  pawnLabel.position.set(T.pawn.x, T.pawn.y + 1.95, T.pawn.z);
  pawnLabel.scale.set(2.6, 0.5, 1);
  group.add(pawnLabel);

  const bj = T.bj;
  const pad = (z, text, color) => {
    const cv = textCanvas([text], { w: 256, h: 256, bg: 'rgba(0,0,0,0)', fg: '#ffffff' });
    const g2 = cv.getContext('2d');
    g2.globalCompositeOperation = 'destination-over';
    g2.fillStyle = color; g2.beginPath(); g2.arc(128, 128, 124, 0, Math.PI * 2); g2.fill();
    const m = new THREE.Mesh(new THREE.CircleGeometry(z.r, 28), new THREE.MeshStandardMaterial({ map: canvasTex(cv), transparent: true, emissive: new THREE.Color(color), emissiveIntensity: 0.25, polygonOffset: true, polygonOffsetFactor: -4 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(z.x, T.y + 0.13, z.z);
    group.add(m);
    return m;
  };
  const hitPad = pad(bj.hit, 'HIT 👊', '#d62828');
  const standPad = pad(bj.stand, 'STAND ✋', '#1d70b8');
  const cardGroup = new THREE.Group();
  group.add(cardGroup);
  const bjLabel = labelSprite('', '#fff', 36);
  bjLabel.position.set(bj.table.x, bj.table.y + 1.25, bj.table.z);
  bjLabel.scale.set(3.4, 0.64, 1);
  group.add(bjLabel);
  const flipLabel = labelSprite('', '#ffd166', 38);
  flipLabel.position.set(T.flip.x, T.flip.y + 2.9, T.flip.z);
  flipLabel.scale.set(3.0, 0.56, 1);
  group.add(flipLabel);
  // the coin
  const coin = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.05, 20), flat('#f2c14e', { metalness: 0.8, roughness: 0.3, emissive: new THREE.Color('#3a2a00') }));
  coin.position.set(T.flip.x, T.flip.y + 2.3, T.flip.z);
  coin.rotation.x = Math.PI / 2;
  group.add(coin);
  // casino carpet + lights
  const carpet = new THREE.Mesh(new THREE.PlaneGeometry(21, 17), new THREE.MeshStandardMaterial({ map: canvasTex(carpetCanvas(), { repeat: [3, 3] }), roughness: 1, polygonOffset: true, polygonOffsetFactor: -2 }));
  carpet.rotation.x = -Math.PI / 2; carpet.rotation.z = Math.PI / 2;
  carpet.position.set(T.casino.x, T.casino.y + 0.115, T.casino.z);
  group.add(carpet);
  const cl = new THREE.PointLight(0xff4fb0, 18, 22, 1.4); cl.position.set(T.casino.x, T.casino.y + 4.2, T.casino.z); group.add(cl);
  const cl2 = new THREE.PointLight(0xffe0a0, 14, 18, 1.4); cl2.position.set(T.bj.table.x, T.casino.y + 3.6, T.bj.table.z); group.add(cl2);
  const pl = new THREE.PointLight(0xffe2b0, 10, 14, 1.4); pl.position.set(T.pawn.x, T.y + 3.2, T.pawn.z); group.add(pl);

  // interactable bits
  for (const u of W.uses) {
    if (u.kind === 'keypad') {
      const k = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.44, 0.08), new THREE.MeshStandardMaterial({ map: canvasTex(keypadCanvas()), roughness: 0.6 }));
      k.position.set(u.x, u.y, u.z);
      k.rotation.y = Math.PI;
      group.add(k);
    } else if (u.kind === 'pawnBell') {
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2), flat('#f2c14e', { metalness: 0.8, roughness: 0.25 }));
      b.position.set(u.x, u.y - 0.08, u.z);
      group.add(b);
    } else if (u.kind === 'bj') {
      group.add(button(u, u.arg === 'deal' ? '#2ecc71' : u.arg === 'all' ? '#e74c3c' : u.arg === 'clear' ? '#7f8c8d' : '#f1c40f', u.label.replace('Bet ', '')));
    } else if (u.kind === 'flip') {
      if (u.arg === 'pull') {
        const lever = new THREE.Group();
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.8, 6), flat('#c0c0c0', { metalness: 0.7 }));
        rod.position.y = 0.4;
        const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), flat('#e74c3c'));
        ball.position.y = 0.8;
        lever.add(rod, ball);
        lever.position.set(u.x, u.y - 0.3, u.z);
        group.add(lever);
      } else group.add(button(u, u.arg === 'all' ? '#e74c3c' : '#f1c40f', u.label.replace('Stake ', '')));
    } else if (u.kind === 'buy') {
      const item = u.arg === 'walkie'
        ? new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.24, 0.06), flat('#2c3e50'))
        : u.arg === 'drink' ? new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.16, 10), flat('#39ff14', { emissive: new THREE.Color('#0a3a05') }))
          : new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.03, 6, 12), flat('#e67e22'));
      item.position.set(u.x, u.y - 0.05, u.z);
      group.add(item);
      const price = { walkie: '$150 WALKIE', drink: '$40 DRINK', bungee: '$90 BUNGEES' }[u.arg];
      const s = labelSprite(price, '#fff', 30);
      s.scale.set(1.1, 0.2, 1);
      s.position.set(u.x, u.y + 0.3, u.z);
      group.add(s);
    }
  }

  return {
    group, near, gates, npcs,
    update(dt, t, camPos) {
      for (const n of near) n.mesh.visible = Math.hypot(camPos.x - n.x, camPos.y - n.y, camPos.z - n.z) < n.r;
      for (const g of gates.values()) {
        g.open += (g.target - g.open) * Math.min(1, dt * 1.5);
        g.bars.position.x = g.open * g.hx * 1.9;
      }
    },
    pawnLabel, bjLabel, flipLabel, cardGroup, coin, hitPad, standPad,
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

function carpetCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 256;
  const g = cv.getContext('2d');
  g.fillStyle = '#5b1a4a'; g.fillRect(0, 0, 256, 256);
  const cols = ['#ff2e88', '#ffd166', '#06d6a0', '#118ab2'];
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = cols[i % 4]; g.lineWidth = 4;
    g.beginPath();
    const x = (i * 53) % 256, y = (i * 97) % 256;
    g.arc(x, y, 10 + (i % 5) * 6, 0, Math.PI * 1.4);
    g.stroke();
  }
  return cv;
}

export const PREVIEW = {
  towtruck: () => towTruck({ x: 0, y: 0, z: 0, ry: 0.6 }),
};
