// Trip codes: the four digits a host reads out and a friend types under Join Game, 1000-9999. No
// leading zero, so the code reads the same as a number and as text (it always travels as text). The
// browser build's server, the desktop host (its Steam lobby carries the code, desktop/steam/host.cjs)
// and the page all use these.
//   isTripCode(s)                       '1234' -> true; '0123', '12a4', 1234 -> false
//   normalizeTripCode(v)                what a player typed -> digits only ('12 34' -> '1234', '۱۲۳۴' -> '1234')
//   tripCodeIn(v)                       what a player pasted -> the code in it ('code: 4821, 8pm' -> '4821')
//   tripCodeError(s, more)              why a typed code can't be a trip's, for the player ('' when it can)
//   randomTripCode(int, taken)          a fresh code, or null when every code is taken
export const TRIP_CODE_RE = /^[1-9]\d{3}$/;
// more than anyone types or pastes; nothing longer is looked at (a join can't make the server fold 64 KB)
const MAX_TYPED = 200;

export const isTripCode = s => typeof s === 'string' && TRIP_CODE_RE.test(s);

// Every decimal digit as 0-9: NFKC folds the compatibility ones (full-width, mathematical), and the rest
// (Persian ۴, Arabic-Indic ٤, Devanagari ४, Thai ๔...) are worked out: Unicode only ever encodes decimal
// digits in runs of ten from zero, so a digit's value is its distance from the start of its run (two runs
// can sit back to back, hence the % 10)
const ND = /\p{Nd}/u;
function digit(c) {
  const cp = c.codePointAt(0);
  let lo = cp;
  while (lo > cp - 100 && ND.test(String.fromCodePoint(lo - 1))) lo--;
  return String((cp - lo) % 10);
}
const foldDigits = v => String(v).slice(0, MAX_TYPED).normalize('NFKC').replace(/\p{Nd}/gu, c => (c >= '0' && c <= '9' ? c : digit(c)));
const typed = v => typeof v === 'string' || typeof v === 'number';

// spaces, dashes and anything else that isn't a digit go
export function normalizeTripCode(v) {
  return typed(v) ? foldDigits(v).replace(/\D/g, '') : '';
}

// A pasted chat line: its one lone group of four digits ('the code is 4821, see you at 8' -> '4821'),
// else all its digits ('48 21' -> '4821'). Typing one digit at a time gives the same as normalizeTripCode.
export function tripCodeIn(v) {
  if (!typed(v)) return '';
  const s = foldDigits(v), lone = [...s.matchAll(/(?:^|\D)(\d{4})(?!\d)/g)];   // (no lookbehind: older Safari)
  return lone.length === 1 ? lone[0][1] : s.replace(/\D/g, '');
}

// more: a hint for the player, added when the code isn't even four digits
export function tripCodeError(c, more = '') {
  if (isTripCode(c)) return '';
  if (/^\d{4}$/.test(c)) return `No trip with code ${c}: trip codes never start with 0. Check the number with your friend.`;
  return more ? `Trip codes are 4 digits. ${more}` : 'Trip codes are 4 digits.';
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
