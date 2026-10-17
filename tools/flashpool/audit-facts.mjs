import fs from 'node:fs';
import path from 'node:path';
const root = 'C:/empire/games/kam-web/_ref/kam_remake/src';
const out = process.argv[2] ?? 'C:/Users/me/AppData/Local/Temp/opencode/m3c-out/'; // dir of <id>.txt tables written by flashpool
const idx = new Map();
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.pas')) idx.set(e.name.toLowerCase(), p); } })(root);
const cache = new Map();
const lines = (f) => { const p = idx.get(f.toLowerCase()); if (!p) return null; if (!cache.has(p)) cache.set(p, fs.readFileSync(p, 'utf8').split(/\r?\n/)); return cache.get(p); };
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
let totalAll = 0, okAll = 0;
for (const f of fs.readdirSync(out).filter((x) => x.endsWith('.txt')).sort()) {
  const txt = fs.readFileSync(out + f, 'utf8');
  const rows = txt.split('\n').filter((l) => l.trim().startsWith('|') && !/^\|[\s:-]+\|/.test(l.trim()) && !/\bsrc\b.*\bquote\b/i.test(l));
  let ok = 0, bad = 0, noRef = 0; const badEx = [];
  for (const r of rows) {
    const cells = r.split('|').slice(1, -1).map((c) => c.trim());
    const quote = (cells[cells.length - 1] || '').replace(/^[`'"]+|[`'"]+$/g, '');
    const src = cells[cells.length - 2] || '';
    const m = /([A-Za-z0-9_]+\.pas)\s*:\s*(\d+)(?:\s*[-–]\s*(\d+))?/.exec(src);
    if (!m || !quote || /NOT-IN-FILE/i.test(quote)) { noRef++; continue; }
    const L = lines(m[1]); if (!L) { bad++; badEx.push(src + ' (no file)'); continue; }
    const a = Math.max(1, Number(m[2]) - 3), b = Math.min(L.length, (m[3] ? Number(m[3]) : Number(m[2])) + 3);
    const hay = norm(L.slice(a - 1, b).join(' '));
    if (hay.includes(norm(quote))) ok++; else { bad++; if (badEx.length < 3) badEx.push(`${src} "${quote.slice(0, 40)}"`); }
  }
  totalAll += ok + bad; okAll += ok;
  console.log(`${f.padEnd(18)} rows=${String(rows.length).padStart(3)} verified=${String(ok).padStart(3)} wrong=${String(bad).padStart(3)} noRef=${noRef}  ${badEx.length ? 'e.g. ' + badEx.join(' ; ') : ''}`);
}
console.log(`TOTAL verified ${okAll} of ${totalAll} checkable rows (${totalAll ? Math.round((100 * okAll) / totalAll) : 0}%)`);

