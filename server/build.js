// The build identity two machines must share to play together. Every client re-runs the world generator
// from (seed, day), so ANY difference in what both sides execute means different terrain and colliders
// on each side: builds match exactly, never by semver. It's the package version plus a hash of the code
// both sides run (shared/, server/ and the client's top-level modules), so two copies of the same
// release agree and a friend who hasn't updated is turned away with a clear message.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export function computeBuild(root = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const h = crypto.createHash('sha256');
  for (const dir of ['shared', 'server', 'client/js']) {
    for (const f of fs.readdirSync(path.join(root, dir)).filter(f => /\.m?js$/.test(f)).sort()) {
      h.update(f);
      h.update(fs.readFileSync(path.join(root, dir, f)));
    }
  }
  return `${pkg.version}+${h.digest('hex').slice(0, 10)}`;
}
