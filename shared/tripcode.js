// Trip codes: the four digits a host reads out and a friend types under Join Game, 1000-9999. No
// leading zero, so the code reads the same as a number and as text (it always travels as text). The
// browser build's server, the desktop host (its Steam lobby carries the code, desktop/steam/host.cjs)
// and the page all use these.
//   isTripCode(s)                       '1234' -> true; '0123', '12a4', 1234 -> false
//   normalizeTripCode(v)                what a player typed or pasted -> digits only ('12 34' -> '1234')
//   randomTripCode(int, taken)          a fresh code, or null when every code is taken
export const TRIP_CODE_RE = /^[1-9]\d{3}$/;

export const isTripCode = s => typeof s === 'string' && TRIP_CODE_RE.test(s);

// full-width and other compatibility digits fold to 0-9; spaces, dashes and anything else go
export function normalizeTripCode(v) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  return String(v).normalize('NFKC').replace(/\D/g, '');
}

// codes nobody should be handed: one digit four times (7777), a straight run (1234, 6543)
export function easyTripCode(c) {
  if (/^(\d)\1{3}$/.test(c)) return true;
  const d = [...c].map(Number), up = d.every((x, i) => !i || x === d[i - 1] + 1), down = d.every((x, i) => !i || x === d[i - 1] - 1);
  return up || down;
}

// int(lo, hi): a random integer lo <= n < hi (crypto.randomInt on the server); taken(code): in use or
// cooling down. Random tries first, then a scan from a random start, so it ends even when nearly full.
export function randomTripCode(int, taken = () => false) {
  const ok = c => !easyTripCode(c) && !taken(c);
  for (let i = 0; i < 200; i++) { const c = String(int(1000, 10000)); if (ok(c)) return c; }
  const start = int(0, 9000);
  for (let i = 0; i < 9000; i++) { const c = String(1000 + (start + i) % 9000); if (ok(c)) return c; }
  return null;
}
