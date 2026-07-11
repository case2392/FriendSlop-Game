import Dig from './dig.js';
import Rv from './rv.js';
import Cham from './cham.js';
import Casino from './casino.js';
import { makeMountain } from './mountain.js';

// CHAINED TOGETHER: chained squad, shorter wall, rising slop tide.
export const Chained = makeMountain({
  id: 'chained',
  chained: true,
  linkLen: 195,          // the pit is generous with slack. barely.
  summitY: 240,
  maxTime: 130,
  tide: { speed: 3.6 },
  lives: n => 2 + Math.ceil(n * 0.7),
});

// THE PEAK: no chain, full-height wall, falling slop, pure nerve.
export const Peak = makeMountain({
  id: 'peak',
  chained: false,
  summitY: 70,
  maxTime: 170,
  globs: true,
});

// The Slop Pit, in expedition order — one homage per friendslop classic.
export const CHAMBERS = [Dig, Rv, Cham, Casino, Chained, Peak];
export const BY_ID = Object.fromEntries(CHAMBERS.map(m => [m.id, m]));
