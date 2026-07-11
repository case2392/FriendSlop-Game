import Gates from './gates.js';
import Gut from './gut.js';
import Tater from './tater.js';
import Walk from './walk.js';

// The Slop Pit, in expedition order.
export const CHAMBERS = [Gates, Gut, Tater, Walk];
export const BY_ID = Object.fromEntries(CHAMBERS.map(m => [m.id, m]));
