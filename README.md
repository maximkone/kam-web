# kam-web

Unofficial web port of **KaM Remake** (Knights and Merchants) — run in a browser, like
Chrono Divide does for Red Alert 2.

- Engine approach: **TypeScript + WebGL2**, simulation ported from the AGPL-3.0 source of
  KaM Remake (`reyandme/kam_remake`), assets imported from the player's own KaM install.
- Full plan: `docs/PLAN.md` · newest spec: `docs/M2B-SPIKE.md` · decision log: `docs/DECISIONS.md`.

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
- **M2b — playable slice v0: DONE** (accepted 2026-10-16). Fixed tick loop in the frozen §2.3 order,
  AStarNew pathfinding port (shipped default), walk kinematics, click-to-move playable viewer at
  `/play.html`; workers C (sim core) + D (playable viewer). Lead-verified: `WALK CHECK PASS` + grid
  sha256 identical to the lead's independent checker, CDP journey 16/16, `npm test` 41/41; acceptance
  record in `docs/M2B-SPIKE.md` §7 (includes the lead's sprite-index off-by-one errata fix).
  The harness and the `.rng` oracle stay the parity instruments (K grows with the sim).

## Quickstart (Windows, Node >= 24)

```pwsh
# 1) Convert your own KaM Remake install (read-only!) into web atlases
node tools/import/cli.ts --install "C:\Users\me\Desktop\KaM Remake" --check

# 2) Export a map for the terrain viewer
node tools/mapinfo/cli.ts "C:\Users\me\Desktop\KaM Remake\Tutorials\Town Tutorial\Town Tutorial.map" --export out/maps/TownTutorial.json

# 3) Serve the repo and open the viewers
node apps/web/serve.ts           # sprite viewer http://127.0.0.1:8123/ , map viewer /map.html ,
                                 # playable slice /play.html (M2b)
                                 # if the port is taken: node apps/web/serve.ts --port 8124
```

Output lands in `out/` (gitignored — never committed).

## Layout

```
apps/web/          browser client (serve.ts; demo.ts sprite viewer, mapdemo.ts terrain viewer,
                   play.ts playable slice — M2b)
packages/assets/   rxx decoder, PNG encoder, atlas packer; defines parsers (tiles/mapelem/unit — M2b)
packages/map/      .map parser (M1)
packages/sim/      exact KaM RNG port (M2a) + sim core: passability, AStarNew, walk, tick (M2b)
packages/replay/   .rpl codec, command ordinals, chain verifier (M2a)
tools/import/      CLI: install -> out/atlas
tools/mapinfo/     CLI: .map -> out/maps (M1)
tools/replayinfo/  CLI: .rpl -> seed / K prefix / sim-draw pair report (M2a)
tools/rnginfo/     CLI: .rng DBG_RNG_SPY draw-trace oracle (M2a)
tools/synth/       CLI: synthetic .rpl generator for verifier cross-checks (M2a)
tools/walksim/     CLI: headless walk demo + WALK CHECK (M2b)
docs/              PLAN.md (roadmap), M0/M1/M2/M2B spike specs, DECISIONS.md
_ref/kam_remake/   read-only reference clone of the AGPL source (gitignored)
```

## Licensing

- This repo: **AGPL-3.0-or-later** (it will contain code ported from KaM Remake, which is AGPL-3.0).
- Game assets (sprites, sounds, maps) are **never** part of this repo. The importer reads the
  player's own legal KaM installation locally; nothing is uploaded or redistributed.
- "Knights and Merchants" is a trademark of its owners; this is a non-profit fan project.
