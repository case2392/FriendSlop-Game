// Keys are read by where they sit on the keyboard (e.code), not by the letter printed on them, so WASD
// is the same four keys on every layout: ZQSD on a French AZERTY board, and Q (drop) is the key next to
// them that AZERTY marks A. Text that names a key ([E], WASD, "hold V") uses the QWERTY name of that
// position; keyLabel() and keysIn() turn it into what the player's own keyboard prints there, from
// navigator.keyboard.getLayoutMap() (Chromium, so the desktop build; elsewhere the names stay QWERTY's).
//
//   keyName(e)        the name the game's handlers use: 'w', '1', ' ', or e.key lowercased ('shift', 'f1')
//   keyLabel('Q')     'A' on AZERTY, 'Q' on QWERTY
//   keysIn(text)      '[E] drive · WASD' -> each [X] and WASD in the player's labels
//   relabelPage()     the same for every <kbd> on the page (the help, the hints) and "(X)" in tooltips
let layout = null;
const ready = (async () => {
  try { layout = (await navigator.keyboard?.getLayoutMap?.()) || null; } catch { layout = null; }
})();

export const keyName = e => /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase()
  : /^Digit[0-9]$/.test(e.code) ? e.code.slice(5)
  : e.code === 'Space' ? ' '
  : (e.key || '').toLowerCase();

export function keyLabel(L) {
  const c = layout?.get('Key' + L.toUpperCase());
  return c && c.length === 1 && c.trim() ? c.toUpperCase() : L.toUpperCase();
}

export const keysIn = s => !layout || !s ? s
  : s.replace(/\[([A-Z])\]/g, (_, L) => `[${keyLabel(L)}]`).replace(/\bWASD\b/g, () => 'WASD'.split('').map(keyLabel).join(''));

export function relabelPage(root = document) {
  ready.then(() => {
    if (!layout) return;
    for (const k of root.querySelectorAll('kbd')) {
      const t = (k.dataset.key ??= k.textContent.trim());
      if (/^[A-Z]$/.test(t)) k.textContent = keyLabel(t);
      else if (t === 'WASD') k.textContent = keysIn(t);
    }
    for (const el of root.querySelectorAll('[title]')) {
      const t = (el.dataset.title ??= el.title);
      el.title = t.replace(/\(([A-Z])\)/g, (_, L) => `(${keyLabel(L)})`);
    }
  });
}
