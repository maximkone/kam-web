# Decision log

Newest first. Only decisions the lead/owner actually made, with evidence.

## 2026-10-17 - M5c accepted: the Advanced AI's military half (worker N)

- Lead re-ran everything independently: `AI CHECK PASS (economy 30000 ticks, 843 events; attack 12000
  ticks)` twice identical (economy sha `1a425dcd...`, attack sha `d1825fa9...`: kills 9, house damage 550,
  one enemy store destroyed), `npm test` 125/125, `tsc` 0; WALK / ECON (`6d780b62`) / COMBAT (`09a19821`) /
  BUILD (`98b80525`) / MAPSCAN (243, 0 anomalies) all unchanged.
- The frozen economy sha moved `f62714ce...` -> `1a425dcd...` on purpose: the Supervisor's mine division
  (gold-mine cap, iron reserve) is the faithful behaviour; switching it off reproduces the old sha exactly.
  Accepted; the new numbers are frozen (record: `docs/M5-SPIKE.md` 7.5).
- **Not done, blocks M5d:** the attack phase runs on scenario grants (kit, barracks, recruits, army). In the
  organic economy run the AI never places its barracks (planner reserves it, builder never builds it) and
  the school stalls on gold (store has 56, demand count 0). An AI that never raises an army is not an
  opponent, so the next worker (N2) fixes both and proves an organic army without grants before M5d starts.
- Simplifications kept (all in 7.5): no NavMesh, v0 defence lines, no group split, no soldier food,
  warrior-count strength, army-vector orders not ported.

## 2026-10-17 - M5 wave 2a: the Advanced AI's economy half runs (worker M)

- `node tools/aisim/cli.ts --check` → `AI CHECK PASS` deterministic (sha `f62714ce…`): on
  `MapsMP/Battle Sun` the AI **plans and builds its own economy village** — sawmill, coal mine, farm,
  woodcutters, store, school and 5 quarries planned; 5 built; 86 road tiles laid; 7 sites dug;
  39 units trained (serfs/builders/metallurgists/miners); the production chain runs. 119/119 tests;
  all earlier frozen shas unchanged; record in `docs/M5-SPIKE.md` §7.4 (simplifications listed there).
- Next: wave 2b — the military half (ArmyManagement/ArmyAttackNew/ArmyDefence/Supervisor + the
  scripted attack/defence records), then a browser match vs the AI on a real map.

## 2026-10-17 — M4 accepted: combat slice (workers I + J)

- Worker I (combat sim): `COMBAT CHECK PASS` deterministic (sha `09a19821…`, two runs identical),
  `npm test` 98/98; the lead-reproduced crash (a house demolished mid-delivery crashed the next
  tick) was fixed with uid house references + graceful delivery abandonment + worker relocation and
  regression-tested — all frozen numbers unchanged; record in `docs/M4-SPIKE.md` §7.1.
- Worker J (combat viewer): the lead's independent CDP run **16/16** — fog of war (inside 255 /
  outside 0 / toggles), arrows in flight (max 6) and deaths, house HP → collapse → 4 rubble objects,
  **200 ticks after a demolish with no crash** (the fixed path in the browser), the economy keeps
  running (storeTrunks 30→20, events 39→470), M3b picker intact; §7.2.
- Regressions: M0/M1/M2/M2b/M3/M3b all green; `npm test` 98/98; tsc 0.
- Next: **M5 advanced AI** — `docs/M5-AI-NOTES.md` is the research; its gap list makes a
  construction slice (house plans/builders/materials — what the AI's CityBuilder drives) the first
  wave, then the newAI port itself.

## 2026-10-17 — M3b accepted: any-map loading + picker (workers G + H)

- Worker G (loader): `MAPSCAN CHECK PASS (243 maps, 0 anomalies)` — 35 `Maps` + 208 `MapsMP`, 232
  Remake + 11 standard formats, every walk exact, the 11 XOR `.dat`s decoded; the lead's independent
  walker reproduced every total and the per-map extremes; deviations in `docs/M3B-SPIKE.md` §7.1
  (notably `baseTerrain` — Remake maps use terrain ids > 255 on 49,123 tiles).
- Worker H (picker/viewer): lead's CDP run **21/21** — `/maps` = 243 entries, traversal refused
  (404), Arena / Atoll / Center Castle Looting (256×256, 8,747 layered tiles) all load and render
  with their mission houses/units, the tutorial keeps the M3 counters; §7.2. Follow-up flagged: the
  viewer's browser-side reader duplicates the parser (`packages/map/map.ts` imports `node:fs`) —
  dedupe planned.
- Regressions: M0/M1/M2/M2b/M3 all pass; `npm test` 82/82; tsc 0.
- Next: **M4 combat** (spec `docs/M4-SPIKE.md` frozen 2026-10-17) → M5 advanced AI → M6 multiplayer.

## 2026-10-17 — M3 accepted: the economy village runs (workers E + F)

- Worker E (sim core) verified by the lead: `ECON CHECK PASS` (6000 ticks; two runs identical,
  sha256 `6d780b62…c41`); `npm test` 62/62; the lead's independent mission/houses dumps match E's
  parsers on every count and spec value; accepted v0 divergences in `docs/M3-SPIKE.md` §7.1
  (carpenter cycle frozen at 361 ticks; footprint = the hardcoded PlanYX per the §2.2 errata).
- Worker F (viewer) verified by the lead: CDP run **22/22** on a live server — the real village
  renders (houses, roads, trees, serfs, team tints) and the chain advances in the browser (trees
  felled → stumps, timber 100→113, store trunks 30→18; the HUD event line shows timber → store
  deliveries); M2b click-to-move still works on the M3 page; record in §7.2.
- Regressions re-run by the lead: M0 `CHECK PASS` · M1 `MAP CHECK PASS` · M2 autosave01 exact §2.4
  numbers · M2b `WALK CHECK PASS` · M3 `ECON CHECK PASS` + `npm test` 62/62 + tsc 0.
- Next: **M3b** (any-map + picker; spec `docs/M3B-SPIKE.md` frozen) → M4 combat → M5 advanced AI
  (owner priority) → M6 multiplayer.

## 2026-10-17 — Owner directive: play vs the Advanced AI on real maps

- Maxim (empire chat, verbatim): "mm can u integrate there advanced ai from C:\Users\me\Desktop\
  KaM Remake\KaM Remake Beta r15472 for the one we doing i want to play vs advanced ai and maps".
- Read: the target experience is a skirmish game — pick a map from the owner's own install and play
  against the Remake's **Advanced AI** (`src/ai/newAI/**`), not the classic AI and not a simplified
  placeholder. The advanced AI is a first-class port target; map loading for the install's own
  `Maps/` + `MapsMP/` folders (356 maps, standard + Remake formats, each with its mission `.dat`)
  becomes its own milestone so every later slice is tested on real maps.
- Ladder updated in `docs/PLAN.md`: M3 economy (running) → **M3b any-map + picker** → M4 combat →
  **M5 advanced AI** → M6 multiplayer. Nothing dropped; M5's "may start simplified" wording is
  replaced by the real newAI as the deliverable.
- Logged here for the same reason as the 2026-10-16 directive: kam-web is not a center loop (no
  `owner.mjs` verb logs a non-loop repo order); this file is the project's log.

## 2026-10-16 — M2b accepted: deterministic sim core + playable slice (workers C + D)

- Worker C (sim core, headless) verified by the lead: `WALK CHECK PASS` (walkable 11883/16129),
  `npm test` 41/41, `npx tsc --noEmit` exit 0; C's passability grid is **byte-identical** to the
  lead's independent checker (sha256 `556bfcb1…0ad3c1`); frozen route table in `docs/M2B-SPIKE.md`
  §7.1. Accepted deviation: mapelem.dat = 254 records on disk / 256 parser entries (§3's "255" fixed).
- Worker D (playable viewer) verified after the lead's sprite-index fix: CDP journey 16/16 — select,
  right-click (53,61) (12-node route), arrival 124 ticks = simTicks, wheel zoom, 0 blocked requests,
  no exceptions; `SERVE CHECK PASS`; record in `docs/M2B-SPIKE.md` §7.2.
- Lead corrections during acceptance: (1) the terrain/unit sprite-index off-by-one (entry below);
  (2) D's arrival-tick check accounting → `expected = simTicks = moves + 2`, browser tolerance ±2
  (exact ticks are walksim's job).
- Regressions re-run by the lead: M0 `CHECK PASS` · M1 `MAP CHECK PASS` + `LEAD M1 VERIFY PASS (15)`
  · M2 autosave01 exact §2.4 numbers. Next on the ladder: M3 economy (per `docs/PLAN.md`).

## 2026-10-16 — M1 errata: terrain sprite index off-by-one (caught during M2b, fixed)

- The M1 viewer (and M1's §2.3 wording) used atlas entry `i = terrain+1`; the correct entry is
  `i = terrain`. Game sprite ids are 1-based (`KM_ResSprites.pas:780` `aStartingIndex = 1`, callers
  2035/2041) and M0's atlas `i` is the 0-based rxx file ordinal, so `atlas i = game render id − 1`;
  the terrain renderer binds `gGFXData[rxTiles, BaseLayer.Terrain + 1]` (`KM_RenderTerrain.pas:634`).
- Proven two ways before touching code: rendering Town Tutorial (45,45)–(90,90) with raw sprites
  gives a clean town at `i = terrain` (grass, cobble road, bridge, rock) and water/black speckles at
  `i = terrain+1` (`%TEMP%\opencode\kamweb_align_render.mjs` → `kamweb_align.png`); colour families
  confirm (`kamweb_offby1_check.mjs`): sprite 245 `tkAbyss` pure black, 244 `tkFastWater` teal, 164
  iron-mountain rock. Unit side: `i = step` gives a coherent 8-frame walk cycle, `i = step+1` wraps
  to a foreign sprite (`kamweb_unit_align.mjs` → `kamweb_unit_align_0_6.png`).
- Fix: `apps/web/mapdemo.ts` and `apps/web/play.ts` use `i = terrain` (play.ts: `SPRITE_ID_ADD = 0`);
  errata written into M1-SPIKE §2.3 and §7. Re-verified: `LEAD M1 VERIFY PASS` on a fresh server
  (8126) and D's CDP journey 16/16 (arrival 124 = simTicks).
- The old "terrain 244 is the pure black sprite" claim was this artifact: the black sprite belongs to
  terrain 245 (`tkAbyss`, 123 tiles — the black cliff faces of the iron-mountain band), and the M1
  screenshots' dark patches were real abyss content plus off-by-one speckles.

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
