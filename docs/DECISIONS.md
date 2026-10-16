# Decision log

Newest first. Only decisions the lead/owner actually made, with evidence.

## 2026-10-16 — Owner directive: full playability, correct LAN/internet, he hosts

- Maxim (empire chat, verbatim): "i see there just choosing items can u make it fully workable and
  lan or internet we can add correctly and ill host it on some site".
- Read: the shipped viewers (sprite picker, map viewer) are instruments, not the product; the target
  is the playable game. "Correctly" for MP = the remake's own lockstep design (command-only wire,
  +10 tick buffer, per-tick CRC, resync) on top of the deterministic sim the M2 harness validates —
  not a bolt-on. Hosting = static client bundle + one small Node relay; LAN and internet run the
  same relay code path.
- Effect on the ladder: M2b (playable slice) stays next; M6 (multiplayer) is a first-class target,
  not an extra; nothing is re-scoped away. Logged here because kam-web is not a center loop (there
  is no `owner.mjs` verb that would log a non-loop repo order; this file is the project's log).

## 2026-10-16 — M2a accepted: replay-CRC parity harness lands (workers A + B)

- **`M2 INTEGRATION PASS (97 checks)`** (lead, `%TEMP%\opencode\kamweb_m2_verify.mjs`): all six r15472
  replays reproduce `docs/M2-SPIKE.md` §2.4 exactly (seed 1247813158, K=12, first fail #16, pair stats,
  invariants, payload round-trips with the payload sha recomputed by the lead); 16/16 tests pass,
  `tsc --noEmit` exit 0, M0/M1 regressions pass. Acceptance record: `docs/M2-SPIKE.md` §7.
- Worker B's `rnginfo` reproduces the `.rng` ground truth (175518 records, chain 175517/175517,
  StoreCommand 6291); B's independently generated synthetic replays cross-check through A's
  `replayinfo` — every key equal (two independent RNG/BSGS implementations agree).
- Lead correction: `autosave_after_pt_end.rpl` §2.4 ticks fixed to `lastRecordTick=36004`,
  `lastCheckTick=36003` (the file ends with two trailing SKIP records). Worker A's implementation was
  correct; the lead's draft expectation had an off-by-one (facts-extractor read offset).
- Next: **M2b** = deterministic sim core (fixed tick loop in the frozen §2.3 order, pathfinding port,
  click-to-move), with the harness as the parity instrument and `.rng` tick dumps as the sim-draw test.

## 2026-10-16 — M2 scope frozen: replay-CRC parity harness (`docs/M2-SPIKE.md`)

- M2 proof target redefined by the lead after ground-truth work: full desktop parity needs the sim,
  so the honest M2 bar is a **chain verifier** on real `.rpl`s — recover the session seed backwards
  from the first check, then report the matched-prefix **K** and per-pair sim-draw counts (`k − model0`).
  Frozen on the 6 r15472 replays (one session): seed **1247813158** (all six), first check
  `#2 t=4 rand=2135059644`, K=12, first fail `#16 t=10 file=615217756 sim=1527758834`, per-file pair
  stats in §2.4 (`node %TEMP%\opencode\kamweb_chain_final.mjs <6 rpls>`, re-run by the lead).
- RNG semantics corrected against `DBG_RNG_SPY` ground truth: `KaMRandom(MaxInt)` returns the raw
  **post-step** state (stored Rand = state; the earlier "state−1" model was wrong); `step` = Schrage
  Park–Miller (M = 2^31−1, A = 16807); seed recovery `seed = invStep^(ticks + draws + 1)(first check)`.
- Draw schema frozen from source: `StoreCommand` writes the check on the **last** record of a group;
  `ReplayTimer` = 1 top draw/tick + 1 draw per non-SKIP group compared at the group's last record;
  SKIP set `{48,50,51,52,53,54}`; record-side tick order = sim UpdateStates → running timer → aggressive DoNothing.
- Container/round-trip contract: `payloadLen = 16 + 22*(count+1)`; compressed-layer byte equality with
  the original files is impossible (Node zlib ≠ Delphi zlib: 631306 vs 614624 B at level 9) — never claimed.
- K=12 explanation (not a model bug): ticks 1..9 of this test map perform **zero** sim draws; the first
  sim activity lands in tick 10 (8 draws) and tick 11 (39 draws). The M3+ sim is what makes K grow.
- `.rng` trace numbers frozen as the oracle for M3 (`§2.5`): 175518 records, ticks 37803..40802,
  chain 175517/175517 one-step, StoreCommand 6291.

## 2026-10-16 — M1 accepted: Town Tutorial renders in the browser (viewer = worker B)

- Lead re-run, fresh headless Edge against the live dev server: **`LEAD M1 VERIFY PASS (15 checks)`**
  — fit `128×128 zoom=0.138 cam=(2560,2560)`; 4 hover probes: HUD tile values byte-equal the frozen
  `out/maps/TownTutorial.json` (e.g. `tile (65,66) index=8384 terrain=0 rot=2 height=36 obj=255`);
  wheel ×1.5/notch with the world point under the cursor fixed (<0.5 px); `R` resets; wheel-out
  clamps at fit; `#err` empty; console clean; `blocked: []` (`%TEMP%\opencode\kamweb_m1_verify.mjs`).
- Deviations accepted, §4.2 patched (`docs/M1-SPIKE.md` §7): wheel minimum is `min(0.25, fitZoom)`
  so the 128² fit view (0.138 at 1256×708) stays reachable; HUD adds `index=` and `cam=(x,y)`.
- Black-quad claim (worker B), corrected by the lead: of the 149 terrains in Town Tutorial only
  **244 (5 tiles) is a pure black sprite**; 164 (571) and 230 (2) are dark but structured
  (mean RGB ≈ 10). Dark cliff shadows are real `Tileset.rxx` content, not a renderer bug
  (`%TEMP%\opencode\kamweb_black_scan.mjs`, dumps `out/check-terrain-{164,230,244}.png`).
- Regressions re-run by the lead: `CHECK PASS` (M0 converter, exit 0) · `MAP CHECK PASS` (17/17,
  exit 0) · `npx tsc --noEmit` exit 0. Viewer math reviewed against `KM_RenderTerrain.pas` 2D branch.
- Dev server situation settled: stale 8123 (lead, pre-viewer code) stopped; 8123 now serves the
  current code (detached pid 12180), worker B's 8124 left running — both current code.

## 2026-10-16 — M1 parser accepted (worker A) — proofs re-run by the lead

- `node tools/mapinfo/cli.ts "…\Town Tutorial\Town Tutorial.map" --check` → `MAP CHECK PASS`
  (17/17 frozen values, exit 0, re-run by the lead).
- `--export out/maps/verify.json` → SHA256 identical to the frozen `out/maps/TownTutorial.json`
  (`0B7E2853…D2D6A754`), re-checked by the lead.
- Battle Tutorial `64x64 terrain=55 height=0..100 obj=610 tail=6310`; Gameplay/Cross tail=3286.
- Correction to the M1 spec (lead): the Remake-format revision string length is **u16**, not u32
  (`TKMemoryStreamBinary.ReadW` reads a Word). Verified on a real Remake-format map in the
  nested beta install (`KaM Remake Beta r15472\Tutorials\Town Tutorial\Town Tutorial.map`):
  header `i32 0 | u16 6 "r14281" | u32 147456 | 128 128`, 9 bytes/tile — parses, exit 0.
- Finding for later: the nested beta install holds 356 Remake-format maps (of 767) — a second
  real test corpus for M1.5+ (tile layers / 9-byte tile format), listed by worker A.

## 2026-10-16 — M0 accepted (lead) — proofs in commit body

- Converter (worker A): `packages/assets/{rxx,png,atlas}.ts` + `tools/import/cli.ts`; `--check`
  gives `CHECK PASS` / `DONE packs=6 sprites=11962 sheets=7 bytes=13015030`; `npx tsc --noEmit`
  exit 0. Extra worker proofs: synthetic RXX1/RXX2 layout test + atlas round-trip vs decoded rxx
  (temp scripts).
- Viewer (worker B returned empty; **built by the lead**): `apps/web/serve.ts` +
  `index.html` + `demo.ts`. Headless Edge run: HUD `pack=Units idx=0 15x16 pivot(-1,-28)
  ... pos 1/8688`, `blocked: []`; interaction proof (type 64, Enter, click M) renders the
  33x40 golden knight with the red team-color mask overlay (`out/m0-viewer*.png`, gitignored).
- Spec fix: sprite 0 pivot is **(-1,-28)** (the spike printed only the first i16 word of each
  i32 pivot as (-1,-1)); `cli.ts` + `docs/M0-SPIKE.md` corrected.
- Pivot semantics for later milestones (from `KM_RenderPool.pas`): sprite top-left =
  anchor + (PivotX,PivotY); sprite bottom = anchor + (PivotY + h).
- TypeScript here is **7.0.2 (native)** — no stable programmatic `transpileModule`; the dev
  server builds `out/web/demo.js` through the local `tsc` single-file emit and rebuilds when stale.
- Dev server left running for the owner: `node apps/web/serve.ts` → http://127.0.0.1:8123/.

## 2026-10-16 — map format facts for M1 (evidence)

- Standard KaM `.map`: i32 mapX + i32 mapY header (8 B), then mapX*mapY records of **23 bytes**
  (`terrain u8`, skip1, `height u8`, `rot u8`, skip1, `obj u8`, skip17), then a tail:
  22-byte resource header (`x1 u16`, `Allocated i32`, `Qty1`, `Qty2`, `x5`, `Len17`),
  `17*Allocated` opaque bytes, and optionally an `ADDN`+`TILE` u32 size + u32 cypher +
  X*Y bytes of MapEd terrain kinds (i8, negative = hand-placed).
- Byte-exact on 4 install maps: Town Tutorial 128² (leftover 4374 = 22+17*256), Battle Tutorial
  64² (6310 = 22+17*128+4112 ADDN), Cross 96² (3286 = 22+17*192), Gunplay 32² (2150 = 22+17*64+1040 ADDN).
- Terrain tiles render from `Tileset.rxx`: sprite `BaseLayer.Terrain + 1`, 4 rotations baked in
  the UV lookup; `House`/`trees` etc. from `Houses.rxx`/`Trees.rxx`.

## 2026-10-16 — M0 format facts verified (evidence)

- Legacy `rxx0` payload layout: `Size u16,u16` + `Pivot i32,i32`, **no** SizeNoShadow; modern
  `RXX1/RXX2` use `Pivot i16,i16` (+ `i16x4` SizeNoShadow for Units). Verified by full parse of
  `C:\Users\me\Desktop\KaM Remake\data\Sprites\Units.rxx`: count=9400, present=8688, **leftover
  bytes = 0** (spike scripts in `%TEMP%\opencode\rxx_variants.mjs`).
- Pixel channel order = **R,G,B,A bytes as stored** (no swap). Verified visually: as-is sheet
  shows warm gold/brown knights (correct), channel-swapped variant renders blue
  (`%TEMP%\opencode\sheet_asis.png` vs `sheet_swapped.png`).
- The 4 top-level `data\Sprites\*.rxx` files in the owner's install are legacy-format and parse
  cleanly; the r15472 game itself loads `.rxa` atlases from its own subfolder.

## 2026-10-16 — project + approach (owner)

- Owner picked **TypeScript + WebGL2** (recommended option).
- Owner ordered: create `games\kam-web` **directly, not via loopkit**, no halt files, "big
  dispatches of agents here and finish here". Repo created by the lead; identity
  `center <center@local>`; source reference cloned to `_ref\kam_remake` (gitignored).
- Owner picked **player-supplied assets** (local import; never host/redistribute game art).
- M0 launched as two parallel general-agent workers (converter / viewer), spec frozen in
  `docs/M0-SPIKE.md` before dispatch.
