// Asset preview: /preview.html?assets=oak,rv,player&biome=meadow&hour=10&dist=1.0[&band=y0,y1[&tight=1][&fov=16]][&cam=fp]
// Lays the named PREVIEW assets out in a row on a patch of biome ground under the
// game's lighting, frames them, and sets window.__previewDone when rendered.
import { THREE, initGfx, scene, camera, render, setTimeOfDay, updateSun, setBiome, painted } from './gfx.js';
import { has } from './paint/index.js';

const q = new URLSearchParams(location.search);
const errEl = document.getElementById('err');
try {
  // one module at a time, so a half-edited module elsewhere doesn't block your preview
  const files = ['./nature3d.js', './roadside3d.js', './town3d.js', './people.js', './rv3d.js', './props3d.js', './mobs3d.js'];
  const settled = await Promise.allSettled(files.map(m => import(m)));
  settled.forEach((r, i) => { if (r.status === 'rejected') console.warn(`preview: ${files[i]} failed to load: ${r.reason}`); });
  const REG = Object.assign({}, ...settled.filter(r => r.status === 'fulfilled').map(r => r.value.PREVIEW || {}));
  const names = (q.get('assets') || Object.keys(REG).slice(0, 6).join(',')).split(',').filter(Boolean);
  const biome = q.get('biome') || 'meadow';
  // band=y0,y1: a close look at that slice of height (faces about 1.35,1.95; hands 0.7,1.15): the row
  // packed tight, the camera level with the band and just far enough back to fit it and the row
  const band = (q.get('band') || '').split(',').map(Number);
  const banded = band.length === 2 && band.every(Number.isFinite) && band[1] > band[0];
  const hour = Number(q.get('hour') || 10);
  initGfx(document.getElementById('c'));
  setBiome?.(biome);
  setTimeOfDay(hour);

  const items = [];
  let x = 0;
  for (const n of names) {
    const fn = REG[n];
    if (!fn) { errEl.textContent += `unknown asset "${n}" (have: ${Object.keys(REG).join(', ')})\n`; continue; }
    const obj = fn({ biome });
    if (!obj) continue;
    if (obj.userData.fp) { scene.add(obj); items.push({ n, obj, x: 0, w: 0, h: 0, fp: true }); continue; }   // (camera space: cam=fp)
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const w = Math.max(size.x, size.z, 0.6);
    obj.position.x += x + w / 2 - (box.min.x + box.max.x) / 2;
    obj.position.z -= (box.min.z + box.max.z) / 2;
    obj.position.y -= box.min.y;
    scene.add(obj);
    items.push({ n, obj, x: x + w / 2, w, h: size.y });
    x += w + (banded ? 0.12 : Math.max(0.6, w * 0.25));
  }
  const span = Math.max(1, x);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(span * 3 + 20, span * 2 + 20),
    has(`ground_${biome}`) ? painted(`ground_${biome}`, { repeat: [(span * 3 + 20) / 6, (span * 2 + 20) / 6] }) : new THREE.MeshLambertMaterial({ color: '#6b8f4a' }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(span / 2, 0, 0);
  ground.receiveShadow = true;
  scene.add(ground);
  scene.traverse(o => { if (o.isMesh && o !== ground) { o.castShadow = true; o.receiveShadow = true; } });

  const maxH = Math.max(1, ...items.map(i => i.h));
  const dist = Number(q.get('dist') || 1) * Math.max(span * 0.85, maxH * 1.6, 3);
  const center = new THREE.Vector3(span / 2, maxH * 0.42, 0);
  const yaw = Number(q.get('yaw') || 0.55);
  camera.position.set(center.x + Math.sin(yaw) * dist * 0.35, center.y + dist * 0.32 + maxH * 0.2, center.z + Math.cos(yaw) * dist);
  camera.lookAt(center);
  if (banded) {
    // a long lens from further back, so each item in the row is seen straight on (a close wide-angle
    // camera sees the ones off to the side at a slant)
    camera.fov = Number(q.get('fov') || 16);
    camera.updateProjectionMatrix();
    const [y0, y1] = band, t = Math.tan(camera.fov * Math.PI / 360);
    // (tight=1: fit the band only; whatever is wider runs off the sides: one person's face up close)
    const d = Number(q.get('dist') || 1) * 1.08 * Math.max((y1 - y0) / 2 / t, q.get('tight') ? 0 : span / 2 / (t * camera.aspect));
    center.set(span / 2, (y0 + y1) / 2, 0);
    camera.position.set(center.x + Math.sin(yaw) * d, center.y + d * 0.02, center.z + Math.cos(yaw) * d);
    camera.lookAt(center);
  }
  // cam=fp: the game's first-person camera at the origin (eyes 1.6 m up), looking down -z; the
  // camera-space items (the first-person hands) stay where they are, the ground lies below
  if (q.get('cam') === 'fp') {
    camera.fov = 72; camera.updateProjectionMatrix();
    ground.position.y = -1.6;
    camera.position.set(0, 0, 0); camera.lookAt(0, -0.05, -1);
    center.set(0, -1.6, -3);
  }
  updateSun(center);
  const labels = document.getElementById('labels');
  for (let f = 0; f < 3; f++) { render(); await new Promise(r => requestAnimationFrame(r)); }
  for (const it of items) {
    const p = new THREE.Vector3(it.x, -0.05, 0).project(camera);
    const d = document.createElement('div');
    d.textContent = it.n;
    d.style.left = `${(p.x + 1) / 2 * innerWidth}px`;
    d.style.top = `${(1 - p.y) / 2 * innerHeight + 6}px`;
    labels.appendChild(d);
  }
  render();
} catch (e) { errEl.textContent += e.stack || String(e); }
window.__previewDone = true;
