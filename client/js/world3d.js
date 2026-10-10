// The world, assembled: terrain (terrain3d.js), nature (nature3d.js), roadside
// stops/gates/anchors/camp (roadside3d.js) and the town (town3d.js).
// main.js talks to this file only.
import { THREE } from './gfx.js';
import { buildTerrain } from './terrain3d.js';
import { buildNature } from './nature3d.js';
import { buildRoadside } from './roadside3d.js';
import { buildStructures } from './town3d.js';

export function buildWorld(W) {
  const terrain = buildTerrain(W);
  const nature = buildNature(W);
  const roadside = buildRoadside(W);
  const town = buildStructures(W);
  const group = new THREE.Group();
  group.add(terrain.group, nature.group, roadside.group, town.group);
  return { ...town, group, terrain, nature, roadside, town, gates: roadside.gates, fires: nature.fires };
}

export function updateWorld(w, dt, t, camPos) {
  w.terrain.update?.(dt, t, camPos);
  w.nature.update?.(dt, t, camPos);
  w.roadside.update?.(dt, t, camPos);
  w.town.update?.(dt, t, camPos);
}
