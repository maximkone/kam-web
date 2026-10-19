// sync-arena.mjs — copy the arena game (C:\empire\games\arena) into this repo's site/arena, so the kam-web
// GitHub Pages deployment can host a second, asset-free game next to the KaM client.
//
// Why a copy lives here at all: kam-web is the public repo with a Pages site, while the empire repo (where
// games/arena lives) is private, so its CI cannot see it. `node tools/sync-arena.mjs` re-copies the files
// after any change in games/arena; the copy is committed because the Pages runner has no access to the
// monorepo. Source of truth is always games/arena.
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
// The mirror explains itself, and the sync rewrites this file so a re-sync cannot lose it.
writeFileSync(join(TO, 'MIRROR.md'), [
  '# site/arena - a copy, not the source',
  '',
  'This folder is a **copy** of the `arena` game (a tiny browser RTS that ships no assets at all, which is',
  'why it can be hosted publicly for everyone). Its source of truth is `C:\\empire\\games\\arena` in the',
  "private empire monorepo, which this repository's Pages runner cannot read.",
  '',
  '- Re-sync after any change: `npm run sync:arena` (this file is rewritten by that script)',
  '- Published by `node apps/web/serve.ts --export dist` (copies this folder to `dist/arena`) and so by the',
  '  `pages` workflow on every push to `master`.',
  '- URL: `https://<owner>.github.io/<repo>/arena/`',
  '',
  'The KaM client and this game are unrelated projects sharing one free static host. If the game gets its own',
  'domain or a Cloudflare Pages project later, this copy can go.',
  '',
].join('\n'));
console.log(`sync-arena: ${FROM} -> ${TO}`);
console.log(`sync-arena: ${readdirSync(join(TO, 'src')).length} src files, ${readdirSync(join(TO, 'tools')).length} tool files`);
