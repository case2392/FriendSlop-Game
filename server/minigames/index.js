import Sumo from './sumo.js';
import Tater from './tater.js';
import Grab from './grab.js';
import Floor from './floor.js';

export const MINIGAMES = [Sumo, Tater, Grab, Floor];
export const BY_ID = Object.fromEntries(MINIGAMES.map(m => [m.id, m]));
