# kam-web

Unofficial web port of **KaM Remake** (Knights and Merchants) — run in a browser, like
Chrono Divide does for Red Alert 2.

- Engine approach: **TypeScript + WebGL2**, simulation ported from the AGPL-3.0 source of
  KaM Remake (`reyandme/kam_remake`), assets imported from the player's own KaM install.
- Full plan: `docs/PLAN.md` · current spike contract: `docs/M0-SPIKE.md` · decision log: `docs/DECISIONS.md`.

## Status

**M0 — sprite pipeline spike** (in progress): decode the install's `.rxx` sprite packs into
PNG atlases + JSON manifest, view them in a WebGL2 browser page.

## Quickstart (Windows, Node >= 24)

```pwsh
# 1) Convert your own KaM Remake install (read-only!) into web atlases
node tools/import/cli.ts --install "C:\Users\me\Desktop\KaM Remake" --check

# 2) Serve the repo and open the viewer
node apps/web/serve.ts           # http://127.0.0.1:8123/
```

Output lands in `out/atlas/` (gitignored — never committed).

## Layout

```
apps/web/          browser client (serve.ts, index.html, demo.ts)
packages/assets/   rxx decoder, PNG encoder, atlas packer
tools/import/      CLI: install -> out/atlas
docs/              PLAN.md (roadmap), M0-SPIKE.md (frozen spec), DECISIONS.md
_ref/kam_remake/   read-only reference clone of the AGPL source (gitignored)
```

## Licensing

- This repo: **AGPL-3.0-or-later** (it will contain code ported from KaM Remake, which is AGPL-3.0).
- Game assets (sprites, sounds, maps) are **never** part of this repo. The importer reads the
  player's own legal KaM installation locally; nothing is uploaded or redistributed.
- "Knights and Merchants" is a trademark of its owners; this is a non-profit fan project.
