// The crash mesas' bodies (part of the terrain art pass). World gen makes each crash mesa a butte: two
// solid cylinders in W.cyls with mat 'mesa' (the main body, flat-topped at the wreck's height, and a
// lower bench tier on one end), standing on a talus mound in the heightfield. Here each cylinder is drawn
// as a rock column fitted to its collider: a wall of the biome's cliff rock (its beds level, in metres,
// so they keep the valley walls' scale), pulled in by up to ~0.25 m of noise so the outline never reads as
// a turned drum, and a cap of the biome's ground on top, exactly at the collider's top (players stand on it).
//
//   buildButtes(W) -> THREE.Group | null    (null when the day has no crash mesas)
import { THREE, tex, shadowy } from './gfx.js';

const SEG = 48, ROWS = 8, TILE = 12;   // segments round, rows up, metres per texture tile

function wallGeo(c, bottom, top, seed) {
  const pos = [], uv = [], idx = [];
  const n = (a, y) => 0.5 + 0.5 * Math.sin(a * 3 + seed) * Math.cos(y * 0.7 + seed * 2) * 0.6 + 0.2 * Math.sin(a * 11 + seed * 5);
  for (let j = 0; j <= ROWS; j++) {
    const y = bottom + (top - bottom) * j / ROWS;
    for (let i = 0; i <= SEG; i++) {
      const a = i / SEG * Math.PI * 2;
      const r = c.r - 0.25 * n(a, y);
      pos.push(c.x + Math.cos(a) * r, y, c.z + Math.sin(a) * r);
      uv.push(a * c.r / TILE, y / TILE);
    }
  }
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < SEG; i++) {
    const a = j * (SEG + 1) + i, b = a + SEG + 1;
    idx.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function capGeo(c, top) {
  const g = new THREE.CircleGeometry(c.r, SEG);
  g.rotateX(-Math.PI / 2);
  g.translate(c.x, top, c.z);
  const P = g.attributes.position, U = g.attributes.uv;
  for (let i = 0; i < P.count; i++) U.setXY(i, P.getX(i) / 8, P.getZ(i) / 8);   // the ground's own scale
  return g;
}

export function buildButtes(W) {
  const cyls = (W.cyls || []).filter(c => c.mat === 'mesa');
  if (!cyls.length) return null;
  const group = new THREE.Group();
  const rock = new THREE.MeshLambertMaterial({ map: tex(`cliff_${W.biome}`) });
  const cap = new THREE.MeshLambertMaterial({ map: tex(`ground_${W.biome}`) });
  cyls.forEach((c, k) => {
    const bottom = c.y - c.hh, top = c.y + c.hh;
    group.add(shadowy(new THREE.Mesh(wallGeo(c, bottom, top, k * 1.7 + c.x * 0.01), rock)));
    group.add(shadowy(new THREE.Mesh(capGeo(c, top + 0.01), cap)));
  });
  return group;
}
