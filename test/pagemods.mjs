// Lets node import the page's own modules (client/js/*: the player's controller, its physics world), which
// import by the page's paths ('/shared/...', '/vendor/rapier.mjs' as server/host.js serves them): a resolve hook
// maps those onto the repo. Import this first, then the page modules.
import { register, createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const ROOT = new URL('../', import.meta.url).href;
const RAPIER = pathToFileURL(path.join(path.dirname(createRequire(import.meta.url).resolve('@dimforge/rapier3d-compat')), 'rapier.mjs')).href;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(spec, ctx, next) {
    if (spec.startsWith('/shared/')) return next(${JSON.stringify(ROOT)} + spec.slice(1), ctx);
    if (spec === '/vendor/rapier.mjs') return next(${JSON.stringify(RAPIER)}, ctx);
    return next(spec, ctx);
  }`));
