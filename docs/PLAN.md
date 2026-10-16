# kam-web — plan (v1, 2026-10-16)

Unofficial **web port of KaM Remake** — playable in a browser, in the spirit of Chrono Divide
(RA2 in the browser). Owner: Maxim. Lead/engineer: empire chat agents.

## Locked decisions (owner, 2026-10-16)

1. **Engine approach: TypeScript + WebGL2**, simulation ported from the AGPL-3.0 Pascal source
   (`reyandme/kam_remake`, actively maintained). DOM UI replaces the Delphi control framework.
2. **Project created directly at `C:\empire\games\kam-web`** by the lead on the owner's word —
   explicitly *not* via loopkit ("no loopkit yes games kam web u make it urself not via loops
   no halts just big dispatches of agents here and finish here").
3. **Assets: player-supplied.** The importer reads the player's own KaM Remake install locally
   (File System Access API / CLI); we never redistribute TopWare art. Code is AGPL-3.0.

## Why this is cheaper than Chrono Divide's road

| | Chrono Divide (RA2) | kam-web (KaM) |
|---|---|---|
| Source code | lost (EA) — 5 years of blind reverse engineering by 1 dev | **AGPL-3.0 source + tests + docs**, active in 2026 |
| Netcode | re-derived | documented lockstep: +10 tick buffer, per-tick CRC (`Docs/Network.txt`) |
| Assets | re-based on original .mix | `.rxx` = zlib → plain RGBA32 (verified), source ships exporters |
| Content | original maps ported | 767 maps / 683 mission scripts already on the owner's disk |

## Architecture

```
apps/web/       WebGL2 sprite renderer, camera, minimap, DOM UI, WebAudio
apps/server/    (M6) Node: lobby + relay + chat; lockstep commands + CRC relay
packages/sim/   pure deterministic TS sim, fixed tick, port order:
                Points -> Pathfinding(JPS) -> Terrain -> Units/Houses/Hands -> AI -> Projectiles/FoW
packages/assets/rxx decoder, atlas packer, defines (.dat) parser, map (.map) parser
tools/import/   install -> out/atlas (CLI now; in-browser importer later)
```

Multiplayer model = the remake's own documented one: only commands travel; executed +10 ticks
later; CRC per tick; mismatch → pause + resync.

## Milestones (proof bar per milestone — a claim counts only with its proof)

- **M0 sprite pipeline** (current): `.rxx` → PNG atlases + JSON; WebGL2 viewer; `CHECK PASS` on
  the real install. Contract: `docs/M0-SPIKE.md`.
- **M1 map + terrain**: parse one real `.map` + Tileset; isometric terrain + camera; minimap.
  Proof: browser shows `Tutorials/Town Tutorial.map`.
- **M2 deterministic sim core**: fixed tick, own RNG, pathfinding port, click-to-move;
  **replay-CRC parity harness** vs a desktop `.rpl`. Proof: matching CRC line.
- **M3 economy slice**: one production chain end-to-end (forest → sawmill → boards), serfs.
- **M4 combat slice**: warriors, houses HP, projectiles, fog of war.
- **M5 skirmish AI**: ported AI mayor/general (may start simplified, same interfaces).
- **M6 multiplayer**: relay + lobby + lockstep + resync; two browsers finish one match. ("the
  Chrono Divide bar")
- **M7 parity extras**: mission scripts/campaigns, replays, map editor, mods, mobile, quick match.

## Risks (top)

- Cross-browser determinism (mitigation: own RNG, no transcendentals in sim, CRC detection,
  resync; parity harness from M2).
- Scope: big; keep vertical slices; scripts/campaigns last.
- Asset quirks (team-color masks, generated tile transitions, `.fntx` fonts) — solved per-slice.
- Legal: AGPL obligations (satisfied: repo is AGPL), assets stay with the player.
