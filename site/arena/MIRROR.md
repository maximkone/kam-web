# site/arena - a copy, not the source

This folder is a **copy** of the `arena` game (a tiny browser RTS that ships no assets at all, which is
why it can be hosted publicly for everyone). Its source of truth is `C:\empire\games\arena` in the
private empire monorepo, which this repository's Pages runner cannot read.

- Re-sync after any change: `npm run sync:arena` (this file is rewritten by that script)
- Published by `node apps/web/serve.ts --export dist` (copies this folder to `dist/arena`) and so by the
  `pages` workflow on every push to `master`.
- URL: `https://<owner>.github.io/<repo>/arena/`

The KaM client and this game are unrelated projects sharing one free static host. If the game gets its own
domain or a Cloudflare Pages project later, this copy can go.
