// What the loot looks like. Each mesh is centered on its physics collider.
import { THREE, flat, canvasTex, textCanvas, roughen, shadowy } from './gfx.js';
import { LOOT } from '/shared/loot.js';

const b = (w, h, d, c, x = 0, y = 0, z = 0, o = {}) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), flat(c, o)); m.position.set(x, y, z); return m; };
const cyl = (rt, rb, h, c, x = 0, y = 0, z = 0, seg = 10, o = {}) => { const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, seg), flat(c, o)); m.position.set(x, y, z); return m; };
const sph = (r, c, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(new THREE.SphereGeometry(r, 9, 7), flat(c)); m.position.set(x, y, z); return m; };

const texCache = new Map();
function cachedTex(key, make) { if (!texCache.has(key)) texCache.set(key, canvasTex(make())); return texCache.get(key); }

function elvis() {
  const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128;
  const g = cv.getContext('2d');
  g.fillStyle = '#120a1e'; g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#e6b07a'; g.beginPath(); g.ellipse(64, 66, 26, 34, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0b0b10'; g.beginPath(); g.ellipse(62, 36, 32, 18, -0.2, 0, Math.PI * 2); g.fill();
  g.fillRect(36, 40, 10, 34);
  g.fillStyle = '#f4f1ea'; g.fillRect(30, 104, 68, 24);
  g.fillStyle = '#8a1c1c'; g.fillRect(52, 84, 22, 4);
  return cv;
}

function tvStatic() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 48;
  const g = cv.getContext('2d');
  for (let i = 0; i < 900; i++) { const v = Math.random() * 255; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(Math.random() * 64, Math.random() * 48, 2, 2); }
  return cv;
}

export function mapCanvas(W) {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 380;
  const g = cv.getContext('2d');
  g.fillStyle = '#f3e9cf'; g.fillRect(0, 0, 512, 380);
  // fold lines
  g.strokeStyle = 'rgba(120,100,70,0.25)'; g.lineWidth = 2;
  for (const x of [171, 341]) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 380); g.stroke(); }
  g.beginPath(); g.moveTo(0, 190); g.lineTo(512, 190); g.stroke();
  // the road runs left -> right
  const z0 = W.Z0 + 30, z1 = W.Z1 - 20;
  const X = z => 30 + (z - z0) / (z1 - z0) * 452;
  const Y = x => 200 - x * 1.6;
  g.strokeStyle = '#d0342c'; g.lineWidth = 6; g.lineCap = 'round';
  g.beginPath();
  for (let z = z0; z <= z1; z += 8) { const px = X(z), py = Y(W.roadX(z)); if (z === z0) g.moveTo(px, py); else g.lineTo(px, py); }
  g.stroke();
  // distance ticks every 100 m from camp
  g.fillStyle = '#5b4a36'; g.font = 'bold 13px monospace'; g.textAlign = 'center';
  for (let z = 0; z <= W.LEN; z += 100) {
    const px = X(z), py = Y(W.roadX(z));
    g.fillRect(px - 1, py - 12, 2, 24);
    g.fillText(String(z), px, py + 28);
  }
  g.font = 'bold 16px Trebuchet MS';
  const icon = (z, x, txt, color) => { const px = X(z), py = Y(x); g.fillStyle = color; g.fillText(txt, px, py + 6); };
  for (const p of W.pois) {
    const ic = { gas: '⛽', semi: '🚚', yard: '🏷️', crash: '✈️', junk: '♻️', dino: '🦖' }[p.type] || '$';
    icon(p.z, p.x, ic, '#1b4965');
    g.fillStyle = '#1b4965'; g.font = 'bold 11px monospace'; g.fillText(p.type === 'crash' ? 'crash (mesa)' : p.type, X(p.z), Y(p.x) + 20); g.font = 'bold 16px Trebuchet MS';
  }
  for (const o of W.obstacles) {
    const lbl = { grade: '⛰ GRADE', mud: '〰 MUD', boulder: '🪨 ROCK', gate: '🚧 GATE' }[o.type];
    g.fillStyle = '#b5121b'; g.font = 'bold 13px Trebuchet MS';
    g.fillText(lbl, X(o.z), Y(W.roadX(o.z)) - 18);
  }
  for (const l of W.landmarks) {
    g.fillStyle = '#6a4c93'; g.font = 'italic 11px Georgia';
    g.fillText(l.kind === 'skull' ? '💀 cow skull' : `▭ "${l.label}"`, X(l.z), Y(l.x) - 4);
  }
  g.fillStyle = '#2d6a4f'; g.font = 'bold 16px Trebuchet MS';
  g.fillText('CAMP', X(-40), 360);
  g.fillText('TOWN 🎰', X(W.LEN + 60), 360);
  g.fillStyle = '#3a3a3a'; g.font = 'bold 18px Georgia'; g.textAlign = 'left';
  g.fillText(`DAY ${W.day} — ${W.LEN} m to town`, 12, 24);
  g.font = 'italic 12px Georgia';
  g.fillText('(no GPS. ask the driver what the odometer says.)', 12, 42);
  return cv;
}

export function buildProp(type, W) {
  const L = LOOT[type];
  const g = new THREE.Group();
  const [k, a, bb, c] = L.shape;
  switch (type) {
    case 'gnome': {
      g.add(cyl(0.11, 0.13, 0.22, '#2e5aac', 0, -0.12, 0, 8));
      g.add(sph(0.08, '#f2c9a0', 0, 0.04, 0.02));
      g.add(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.1, 6), flat('#f4f1ea')).translateY(-0.02).translateZ(0.06));
      const hat = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.22, 7), flat('#d62828')); hat.position.y = 0.17; g.add(hat);
      break;
    }
    case 'lamp': {
      g.add(cyl(0.12, 0.14, 0.04, '#b08d57', 0, -0.28, 0));
      g.add(cyl(0.02, 0.02, 0.3, '#b08d57', 0, -0.12, 0, 6));
      const shade = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.2, 8, 1, true), flat('#e76f51', { emissive: new THREE.Color('#5a2a10'), side: THREE.DoubleSide }));
      shade.position.y = 0.12; g.add(shade);
      for (let i = 0; i < 4; i++) g.add(b(0.06, 0.06, 0.01, ['#2a9d8f', '#e9c46a', '#264653', '#f4a261'][i], Math.cos(i * 1.57) * 0.11, 0.1, Math.sin(i * 1.57) * 0.11));
      break;
    }
    case 'toaster': {
      g.add(b(a * 2, bb * 2, c * 2, '#d7dbe0', 0, 0, 0, { metalness: 0.7, roughness: 0.25 }));
      g.add(b(0.04, 0.01, 0.12, '#333', -0.05, bb, 0)); g.add(b(0.04, 0.01, 0.12, '#333', 0.05, bb, 0));
      break;
    }
    case 'register': {
      g.add(b(a * 2, bb * 2, c * 2, '#5f6b73'));
      g.add(b(a * 1.8, 0.03, 0.02, '#c0c0c0', 0, 0, c));
      g.add(b(0.2, 0.05, 0.12, '#2ecc71', 0, bb + 0.01, -0.02));
      break;
    }
    case 'trophy': {
      g.add(b(0.14, 0.06, 0.14, '#4a2c1a', 0, -0.19, 0));
      g.add(cyl(0.025, 0.04, 0.16, '#f2c14e', 0, -0.08, 0, 8, { metalness: 0.8, roughness: 0.3 }));
      g.add(cyl(0.09, 0.03, 0.14, '#f2c14e', 0, 0.08, 0, 10, { metalness: 0.8, roughness: 0.3 }));
      g.add(sph(0.045, '#222', 0, 0.2, 0));
      break;
    }
    case 'vase': {
      const pts = [[0.0, -0.38], [0.12, -0.38], [0.19, -0.2], [0.2, 0.05], [0.13, 0.25], [0.08, 0.32], [0.11, 0.38]].map(([r, y]) => new THREE.Vector2(r, y));
      const v = new THREE.Mesh(new THREE.LatheGeometry(pts, 12), new THREE.MeshStandardMaterial({ map: cachedTex('vase', () => {
        const cv = document.createElement('canvas'); cv.width = 128; cv.height = 128; const x = cv.getContext('2d');
        x.fillStyle = '#f4f6fb'; x.fillRect(0, 0, 128, 128); x.strokeStyle = '#1d4e9e'; x.lineWidth = 5;
        for (let i = 0; i < 6; i++) { x.beginPath(); x.arc(20 + i * 20, 64, 12, 0, Math.PI * 2); x.stroke(); }
        x.fillStyle = '#1d4e9e'; x.fillRect(0, 10, 128, 6); x.fillRect(0, 112, 128, 6); return cv;
      }), roughness: 0.35, flatShading: true, side: THREE.DoubleSide }));
      g.add(v);
      break;
    }
    case 'tv': {
      g.add(b(a * 2, bb * 2, c * 2, '#6b4a2e'));
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(a * 1.5, bb * 1.4), new THREE.MeshBasicMaterial({ map: cachedTex('tv', tvStatic), toneMapped: false }));
      scr.position.set(-0.04, 0, c + 0.002); g.add(scr);
      g.add(cyl(0.025, 0.025, 0.02, '#ddd', a * 0.72, 0.08, c + 0.01, 8).rotateX(Math.PI / 2));
      g.add(b(0.01, 0.2, 0.01, '#999', -0.08, bb + 0.1, 0).rotateZ(0.4));
      g.add(b(0.01, 0.2, 0.01, '#999', 0.08, bb + 0.1, 0).rotateZ(-0.4));
      break;
    }
    case 'neon': {
      g.add(b(a * 2, bb * 2, c * 2, '#202020'));
      const s = new THREE.Mesh(new THREE.PlaneGeometry(a * 1.9, bb * 1.8), new THREE.MeshBasicMaterial({ map: cachedTex('neon', () => textCanvas(['OPEN'], { w: 256, h: 128, bg: '#111', fg: '#ff4fb0', neon: true })), toneMapped: false }));
      s.position.z = c + 0.002; g.add(s);
      const s2 = s.clone(); s2.rotation.y = Math.PI; s2.position.z = -c - 0.002; g.add(s2);
      break;
    }
    case 'guitar': {
      const body = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.08, 12), flat('#c0392b')); body.rotation.x = Math.PI / 2; body.position.y = -0.28; g.add(body);
      const body2 = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.08, 12), flat('#c0392b')); body2.rotation.x = Math.PI / 2; body2.position.y = -0.08; g.add(body2);
      g.add(b(0.05, 0.42, 0.03, '#5a3a22', 0, 0.22, 0)); g.add(b(0.08, 0.1, 0.03, '#222', 0, 0.46, 0));
      g.add(sph(0.04, '#111', 0, -0.2, 0.04));
      break;
    }
    case 'painting': {
      g.add(b(a * 2, bb * 2, c * 2, '#c9a227', 0, 0, 0, { metalness: 0.5 }));
      const s = new THREE.Mesh(new THREE.PlaneGeometry(a * 1.75, bb * 1.75), new THREE.MeshBasicMaterial({ map: cachedTex('elvis', elvis) }));
      s.position.z = c + 0.003; g.add(s);
      break;
    }
    case 'suitcase': {
      g.add(b(a * 2, bb * 2, c * 2, '#7b4b2a'));
      g.add(b(a * 2.02, 0.04, c * 2.02, '#3e2516', 0, 0, 0));
      g.add(b(0.16, 0.05, 0.03, '#222', 0, bb + 0.03, 0));
      for (const sx of [-1, 1]) g.add(b(0.04, 0.04, c * 2.04, '#c9a227', sx * a * 0.7, bb * 0.6, 0));
      break;
    }
    case 'tire': {
      const t = new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.11, 8, 14), flat('#1c1c1c')); t.rotation.x = Math.PI / 2; g.add(t);
      const w = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.03, 6, 14), flat('#f4f1ea')); w.rotation.x = Math.PI / 2; w.position.y = 0.11; g.add(w);
      break;
    }
    case 'slot': {
      g.add(b(a * 2, bb * 2, c * 2, '#c0392b'));
      g.add(b(a * 1.6, 0.3, 0.02, '#f4f1ea', 0, 0.2, c + 0.01));
      for (let i = 0; i < 3; i++) g.add(b(0.14, 0.22, 0.02, ['#f1c40f', '#e74c3c', '#2ecc71'][i], -0.18 + i * 0.18, 0.2, c + 0.02));
      g.add(cyl(0.025, 0.025, 0.4, '#c0c0c0', a + 0.05, 0.2, 0, 6)); g.add(sph(0.06, '#e74c3c', a + 0.05, 0.42, 0));
      g.add(b(a * 2.02, 0.12, c * 2.02, '#f2c14e', 0, bb - 0.06, 0, { emissive: new THREE.Color('#3a2a00') }));
      break;
    }
    case 'safe': {
      g.add(b(a * 2, bb * 2, c * 2, '#4b5d50', 0, 0, 0, { metalness: 0.5, roughness: 0.6 }));
      const dial = cyl(0.08, 0.08, 0.04, '#c0c0c0', 0, 0.05, c + 0.02, 12, { metalness: 0.8 }); dial.rotation.x = Math.PI / 2; g.add(dial);
      g.add(b(0.04, 0.2, 0.04, '#c0c0c0', 0.2, -0.05, c + 0.02));
      break;
    }
    case 'dino': {
      g.add(b(a * 2, bb * 1.2, c * 2, '#5aa469', 0, bb * 0.35, 0));
      g.add(b(a * 1.9, bb * 0.6, c * 1.7, '#4b8a58', 0, -bb * 0.55, 0.06));
      for (let i = 0; i < 6; i++) g.add(new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.12, 4), flat('#f4f1ea')).translateX(-a * 0.8 + i * a * 0.32).translateY(-0.05).translateZ(c * 0.9).rotateX(Math.PI));
      for (const s of [-1, 1]) { g.add(sph(0.09, '#fff', s * a * 0.55, bb * 0.6, c * 0.2)); g.add(sph(0.05, '#111', s * a * 0.6, bb * 0.62, c * 0.26)); }
      break;
    }
    case 'map': {
      const m = new THREE.Mesh(new THREE.BoxGeometry(a * 2, bb * 2, c * 2), [
        flat('#e8dcb8'), flat('#e8dcb8'),
        new THREE.MeshStandardMaterial({ map: W ? canvasTex(mapCanvas(W)) : null, roughness: 0.9 }),
        flat('#e8dcb8'), flat('#e8dcb8'), flat('#e8dcb8'),
      ]);
      g.add(m);
      break;
    }
    case 'boulder': {
      const geo = roughen(new THREE.BoxGeometry(a * 2, bb * 2, c * 2, 2, 2, 2), 0.35, 7);
      g.add(new THREE.Mesh(geo, flat('#a3593b')));
      break;
    }
    default:
      g.add(b(0.3, 0.3, 0.3, '#ff00ff'));
  }
  return shadowy(g);
}
