// npm start: the browser build. One GameHost (server/host.js) serves the client's files and every
// player's WebSocket; the tools and tests start it the same way. The desktop build runs the same host
// in a utility process instead (desktop/server-process.mjs).
import * as C from '../shared/constants.js';
import { GameHost } from './host.js';

const portArg = process.argv.indexOf('--port');
const PORT = Number(process.env.PORT || (portArg !== -1 ? process.argv[portArg + 1] : 0) || 3000);
const HOST = process.env.NMD_HOST || undefined;      // (not HOST: some shells set that to the machine name)

// a stray exception must not take every room down with it: log it and keep serving
process.on('uncaughtException', e => console.error('uncaught exception:', e));
process.on('unhandledRejection', e => console.error('unhandled rejection:', e));

const host = await new GameHost().init();
host.start();
try {
  await host.listen({ port: PORT, host });
} catch (e) {
  console.error(e.code === 'EADDRINUSE'
    ? `Port ${PORT} is already in use: another copy of the game (or something else) is running. Try --port <another>.`
    : `Could not start the server: ${e.message}`);
  process.exit(1);
}
console.log(`NO MONEY DOWN server rolling on http://localhost:${PORT}${C.TEST ? ' (test mode)' : ''}`);

// Ctrl+C / a kill: tell every crew the trip is over instead of just vanishing
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => {
  host.closeAll('The server shut down.');
  setTimeout(() => process.exit(0), 200);
});
