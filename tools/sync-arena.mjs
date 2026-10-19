// sync-arena.mjs — copy the arena game (C:\empire\games\arena) into this repo's site/arena, so the kam-web
// GitHub Pages deployment can host a second, asset-free game next to the KaM client.
//
// Why a copy lives here at all: kam-web is the public repo with a Pages site, while the empire repo (where
// games/arena lives) is private, so its CI cannot see it. `node tools/sync-arena.mjs` re-copies the files
// after any change in games/arena; the copy is committed because the Pages runner has no access to the
// monorepo. Source of truth is always games/arena.
import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FROM = resolve(HERE, '..', '..', '..', 'games', 'arena'); // C:\empire\games\arena
const TO = resolve(HERE, '..', 'site', 'arena');

if (!statSync(FROM).isDirectory()) {
  console.error(`sync-arena: ${FROM} is not a directory`);
  process.exit(1);
}
rmSync(TO, { recursive: true, force: true });
mkdirSync(join(TO, 'src'), { recursive: true });
cpSync(join(FROM, 'index.html'), join(TO, 'index.html'));
for (const f of readdirSync(join(FROM, 'src'))) cpSync(join(FROM, 'src', f), join(TO, 'src', f));
mkdirSync(join(TO, 'tools'), { recursive: true });
for (const f of readdirSync(join(FROM, 'tools'))) cpSync(join(FROM, 'tools', f), join(TO, 'tools', f));
console.log(`sync-arena: ${FROM} -> ${TO}`);
console.log(`sync-arena: ${readdirSync(join(TO, 'src')).length} src files, ${readdirSync(join(TO, 'tools')).length} tool files`);
