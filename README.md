# kam-web

Unofficial web port of **KaM Remake** (Knights and Merchants) — run in a browser, like
Chrono Divide does for Red Alert 2.

- Engine approach: **TypeScript + WebGL2**, simulation ported from the AGPL-3.0 source of
  KaM Remake (`reyandme/kam_remake`), assets imported from the player's own KaM install.
- Full plan: `docs/PLAN.md` · newest spec: `docs/M2-SPIKE.md` · decision log: `docs/DECISIONS.md`.

## Status

- **M0 — sprite pipeline: DONE** (accepted 2026-10-16). `.rxx` → PNG atlases + JSON manifest,
  WebGL2 sprite viewer with pivot/mask/rotation-agnostic display. Proofs in the M0 commit body.
- **M1 — map + terrain viewer: DONE** (accepted 2026-10-16). Real `.map` → terrain in the browser:
  corner heights, pan/zoom, tile HUD; `MAP CHECK PASS` + browser proofs in the M1 commit body,
  acceptance record in `docs/M1-SPIKE.md` §7.
- **M2a — replay-CRC parity harness: DONE** (accepted 2026-10-16). Exact RNG port, `.rpl` codec with
  structural round-trip, chain verifier (seed recovery + K prefix + sim-draw pair stats) on 6 real
  r15472 replays, `.rng` draw-trace oracle, synthetic-replay cross-checks. `M2 INTEGRATION PASS
  (97 checks)` — acceptance record in `docs/M2-SPIKE.md` §7, proofs in the M2 commit body.
- **M2b — deterministic sim core: next.** Fixed tick loop in the frozen §2.3 order, pathfinding +
  click-to-move; the harness and the `.rng` oracle are the parity instruments (K grows with the sim).

## Quickstart (Windows, Node >= 24)

```pwsh
# 1) Convert your own KaM Remake install (read-only!) into web atlases
node tools/import/cli.ts --install "C:\Users\me\Desktop\KaM Remake" --check

# 2) Export a map for the terrain viewer
node tools/mapinfo/cli.ts "C:\Users\me\Desktop\KaM Remake\Tutorials\Town Tutorial\Town Tutorial.map" --export out/maps/TownTutorial.json

# 3) Serve the repo and open the viewers
node apps/web/serve.ts           # sprite viewer http://127.0.0.1:8123/ , map viewer /map.html
                                 # if the port is taken: node apps/web/serve.ts --port 8124
```

Output lands in `out/` (gitignored — never committed).

## Layout

```
apps/web/          browser client (serve.ts, index.html + demo.ts sprite viewer, map.html + mapdemo.ts terrain viewer)
packages/assets/   rxx decoder, PNG encoder, atlas packer
packages/map/      .map parser (M1)
packages/sim/      exact KaM RNG port (M2a); deterministic sim core next (M2b)
packages/replay/   .rpl codec, command ordinals, chain verifier (M2a)
tools/import/      CLI: install -> out/atlas
tools/mapinfo/     CLI: .map -> out/maps (M1)
tools/replayinfo/  CLI: .rpl -> seed / K prefix / sim-draw pair report (M2a)
tools/rnginfo/     CLI: .rng DBG_RNG_SPY draw-trace oracle (M2a)
tools/synth/       CLI: synthetic .rpl generator for verifier cross-checks (M2a)
docs/              PLAN.md (roadmap), M0/M1/M2 spike specs, DECISIONS.md
_ref/kam_remake/   read-only reference clone of the AGPL source (gitignored)
```

## Licensing

- This repo: **AGPL-3.0-or-later** (it will contain code ported from KaM Remake, which is AGPL-3.0).
- Game assets (sprites, sounds, maps) are **never** part of this repo. The importer reads the
  player's own legal KaM installation locally; nothing is uploaded or redistributed.
- "Knights and Merchants" is a trademark of its owners; this is a non-profit fan project.
