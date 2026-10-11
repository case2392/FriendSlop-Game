// Fails when a name we must not ship turns up in text a player could see: another game's places and
// terms, other games' titles, real brands and people. It reads every string literal and template's text in
// the shipped code (client/js, shared, server, desktop), the HTML pages' text and attributes and the
// stylesheet's declarations. Comments are skipped: they never reach a screen.
//   node tools/namecheck.mjs [root]        prints file:line and the string of each hit; exit 1 on any
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
// whole words, any case
export const BANNED = [
  // Blizzard: World of Warcraft's places, factions and terms
  'Elwynn', 'Westfall', 'Dun Morogh', 'Kharanos', 'Goldshire', 'Tanaris', 'Gadgetzan', 'Steamwheedle', 'Barrens',
  'Durotar', 'Stranglethorn', 'Booty Bay', 'Ironforge', 'Stormwind', 'Orgrimmar', 'Azeroth', 'Kalimdor',
  'Thousand Needles', 'Lakeshire', 'Redridge', 'Duskwood', 'Northshire', 'Defias', 'Murloc', 'Hearthstone',
  'Warcraft', 'Blizzard', 'Friz Quadrata',
  // Jagex: RuneScape
  'RuneScape', 'OSRS', 'Lumbridge', 'Varrock', 'Falador', 'Gielinor', 'Jagex',
  // other games
  'Lethal Company', 'R.E.P.O.', 'Gamble With Your Friends', 'We Were Here', 'R.V. There Yet',
  // real brands and people
  'Goodyear', 'Goblinyear', 'Toastmaster', 'Elvis', 'Tiffany',
];
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE = new RegExp(`(?<![A-Za-z])(${BANNED.map(esc).join('|')})(?![A-Za-z])`, 'i');

// The strings of a JS source, each with the line it starts on: quoted literals and the text chunks of
// template literals (their ${} code is lexed like the rest). Enough of a lexer for this: comments,
// strings, templates, and a regex literal told from a division by what came before it.
export function jsStrings(src) {
  const out = [], n = src.length, KW = /^(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;
  let i = 0, line = 1, regexOK = true;
  const quoted = q => {
    const l = line; let t = ''; i++;
    while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') { if (src[i + 1] === '\n') line++; t += src[i] + src[i + 1]; i += 2; } else t += src[i++]; }
    i++; out.push([t, l]);
  };
  const template = () => {
    let l = line, t = ''; i++;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { if (src[i + 1] === '\n') line++; t += c + src[i + 1]; i += 2; continue; }
      if (c === '`') { i++; break; }
      if (c === '$' && src[i + 1] === '{') { out.push([t, l]); t = ''; i += 2; code(true); l = line; continue; }
      if (c === '\n') line++;
      t += c; i++;
    }
    out.push([t, l]);
  };
  const code = inSub => {
    let depth = 0;
    while (i < n) {
      const c = src[i], d = src[i + 1];
      if (c === '\n') { line++; i++; continue; }
      if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
      if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2), end = e < 0 ? n : e + 2; for (let k = i; k < end; k++) if (src[k] === '\n') line++; i = end; continue; }
      if (c === '"' || c === "'") { quoted(c); regexOK = false; continue; }
      if (c === '`') { template(); regexOK = false; continue; }
      if (c === '/') {
        if (!regexOK) { i++; regexOK = true; continue; }        // a division
        let cls = false; i++;                                    // a regex literal: to its closing slash, then its flags
        while (i < n && src[i] !== '\n') { const r = src[i]; if (r === '\\') { i += 2; continue; } if (r === '[') cls = true; else if (r === ']') cls = false; else if (r === '/' && !cls) break; i++; }
        i++; while (i < n && /[a-z]/i.test(src[i])) i++;
        regexOK = false; continue;
      }
      if (/[\w$]/.test(c) || c.charCodeAt(0) > 127) {           // a word: a name, a keyword or a number
        const s = i; while (i < n && (/[\w$]/.test(src[i]) || src.charCodeAt(i) > 127)) i++;
        regexOK = KW.test(src.slice(s, i)); continue;
      }
      if (c === '{') depth++;
      else if (c === '}') { if (inSub && depth === 0) { i++; return; } depth--; }
      regexOK = c !== ')' && c !== ']' && c !== '}';
      i++;
    }
  };
  code(false);
  return out;
}

function files(dir, test, skip = /^(vendor|node_modules)$/) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skip.test(e.name)) out.push(...files(p, test, skip)); } else if (test.test(e.name)) out.push(p);
  }
  return out;
}

export function namecheck(root = ROOT) {
  const hits = [];
  const js = ['client/js', 'shared', 'server', 'desktop'].flatMap(d => files(path.join(root, d), /\.(m|c)?js$/));
  for (const f of js) {
    const rel = path.relative(root, f);
    for (const [s, line] of jsStrings(fs.readFileSync(f, 'utf8'))) { const m = s.match(RE); if (m) hits.push({ rel, line, name: m[1], s }); }
  }
  // the pages and the stylesheet, comments blanked (line numbers kept)
  const blank = m => m.replace(/[^\n]/g, ' ');
  for (const f of [...files(path.join(root, 'client'), /\.html$/, /^(js|vendor|fonts|css)$/), ...files(path.join(root, 'client/css'), /\.css$/)]) {
    const rel = path.relative(root, f);
    const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, blank).replace(/\/\*[\s\S]*?\*\//g, blank);
    src.split('\n').forEach((l, k) => { const m = l.match(RE); if (m) hits.push({ rel, line: k + 1, name: m[1], s: l.trim() }); });
  }
  return { hits, files: js.length };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { hits, files: n } = namecheck();
  for (const h of hits) console.log(`  ${h.rel}:${h.line}  ${h.name}: ${JSON.stringify(h.s).slice(0, 120)}`);
  console.log(hits.length ? `❌ NAME CHECK: ${hits.length} name(s) we must not ship, in ${n} scripts and the pages` : `✅ name check: no borrowed names in ${n} scripts and the pages`);
  process.exit(hits.length ? 1 : 0);
}
