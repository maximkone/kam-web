# Credits

kam-web is a derived work and is licensed AGPL-3.0 (see `LICENSE`).

- **KaM Remake** (https://github.com/reyandme/kam_remake), AGPL-3.0, by the KaM Remake team. The simulation, AI, economy and rules in `packages/sim` are hand-ported from its Pascal source. Every ported rule cites the Pascal file and line.
- **Knights and Merchants: The Shattered Kingdom** was made by Joymania Entertainment. This repo contains none of its assets. Players import data from their own install.
- **Vadim170/kam-remake-android** (AGPL-3.0) was studied as a reference for compiling the real engine (see `docs/PORT-FPC.md`, `docs/PORT-WASM.md`, `docs/PORT-HOST-CONTRACT.md`). No code from it is in `packages/` or `apps/`.
- **pl_mpeg** and other third-party code: none is shipped in this repo today. If any is added, its notice is kept with it.

Game data (`.rxx`, maps, sounds, music) is never committed: `out/`, `_ref/` and `_fpc/` are git-ignored.
