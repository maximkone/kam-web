# Decision log

Newest first. Only decisions the lead/owner actually made, with evidence.

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
