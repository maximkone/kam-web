# M3b spike — any-map loading + picker

Owner priority (2026-10-17, `docs/DECISIONS.md`): play on **real maps** from his own install.
Slice shape: parse **any** map from `Maps/` and `MapsMP/` (Remake + standard formats), list them
with metadata, and load a chosen one in the viewer (terrain + mission + economy world).

Workers: **G** = map parser + map list + CLI (`packages/map/**`, `packages/mission/**` additive,
`tools/mapscan/**`); **H** = viewer picker + loading (`apps/web/**`). Same rules as M2b/M3: bare
`node file.ts`, zero runtime deps, ESM with `.ts` imports, no `enum`/`namespace`.

## 1. Scope (v0)

In:
- **Remake `.map` reader** in `packages/map/map.ts`: revision-gated tile records (overlay, layers),
  the Remake header, the Remake tail. Standard maps keep working exactly as today (M1 contract).
- **Map list**: scan the install's map folders → `MapInfo[]` (name, size, format, rev, players,
  human/AI capability, AI start positions, tactic/building mode, validity).
- **Mission info extension**: the player/AI commands parsed into a `MissionInfo` (additive; the
  M3 `parseMissionScript` output is unchanged).
- **CLI** `tools/mapscan/cli.ts --check`: walk **all** maps, print the frozen counts + the
  per-map walk result summary; `MAPSCAN CHECK PASS/FAIL`.
- **Viewer picker**: a map list overlay (name, size, players, format) + loading the chosen map's
  `.map`/`.dat` (with the existing defines); the economy world for maps that place houses; the
  demo scenario only for the tutorial.

Out (v0): `.script` dynamic scripting (silently ignored, exactly like the game when missing),
`.libx` translations, `.txt` descriptions beyond `SmallDesc`, audio, `.mi` cache (ignored — it is a
regenerable cache), map editing.

## 2. Frozen facts (verified against the r15472 install; refs into `_ref/kam_remake/src`)

### 2.1 Inventory (research pass, all counts re-verified)

- `Maps/`: **35 maps, all Remake format**, each `<Name>\<Name>.map` + `<Name>.dat` (+ `.mi`,
  `.txt`, `.libx`, `.script`, per-map audio). `MapsMP/`: **208 maps — 197 Remake, 11 standard**,
  same pairing. **243/243 have both `.map` and `.dat`** (no map can be listed without a `.dat`,
  `KM_Maps.pas:383, 1932-1933`).
- Detection (`KM_Utils.pas:80-103`): first **i32 @0 == 0 → Remake**, else standard
  (`mapX = i32@0`, `mapY = i32@4`).
- The 11 standard maps (all in `MapsMP/`, each with an XOR-239 `.dat`): `!!!Bonsai_v.0.615_
  4playersEXTENDED_27085861` (256², 8P), `A Reverse Corner Zone` (256², 8P), `Atoll` (96², 3P),
  `Chlyssich in the Forest` (80×96, 2P), `E-Day` (256², 8P), `Equilibrium` (80², 4P), `Quicksand`
  (144×160, 8P), `Rain Season` (64², 2P), `Rocky Mountains` (80×96, 4P), `Snow Desert` (90², 2P),
  `The Beginning of Spring` (64², 2P).
- `.dat` encoding (`KM_MissionScript.pas:212-222`): count bytes in `{9,10,13,'0'..'9',0x20,'!'}`;
  fraction `< 0.20` → XOR-239 the whole file. Measured: **232 plain, 11 XOR** — exactly the 11
  standard maps. Then tab/CR/LF → space and collapse `  ` / `!!` (`:228-241`).
- `.mi` = regenerable scan cache (`KM_Maps.pas:702-798`; `Description.txt`: "can be safely
  deleted") → **ignore**. `.script`/`.libx`/`.pdf`/audio optional (missing = silently skipped).
  Per-map required files for a skirmish: **`<Name>.map` + `<Name>.dat` with `!SET_MAX_PLAYER`**.

### 2.2 Remake `.map` header (`KM_Utils.pas:80-103`; writer `KM_Terrain.pas:636-641`)

| off | size | field |
|---|---|---|
| 0 | 4 | i32 `0` (the Remake marker) |
| 4 | 2 | u16 revision-string char count |
| 6 | 2·n | UTF-16LE `"r<rev>"` (e.g. `r12485`) |
| 6+2n | 4 | u32 `mapDataSize` (total tile-region bytes) |
| 10+2n | 4 | i32 mapX |
| 14+2n | 4 | i32 mapY |

Rev must start with a non-digit (`TryStrToInt` on the rest); dimensions 1..256 else raise.
Real bytes (`MapsMP\Arena\Arena.map`): `00 00 00 00 | 06 00 | "r12485" UTF-16 | 00 24 00 00 |
20 00 00 00 | 20 00 00 00` = marker, rev r12485, mapDataSize 9216, 32×32.

### 2.3 Remake tile record (`KM_TerrainUtils.pas:114-228`; writer `:22-111`)

Base **9 bytes** (8 if rev ≤ 10968):

| off (rev>10968) | size | field |
|---|---|---|
| 0 | 2 | `Terrain` Word LE |
| 2 | 1 | `Rotation` raw (consumers use `rot mod 4`) |
| 3 | 1 | `Height` |
| 4 | 2 | `Obj` Word (255 = none; mapelem has 254 entries so the low byte is enough for our `tiles[]`) |
| 6 | 1 | `IsCustom` |
| 7 | 1 | `TileOverlay` — **only if rev > 10968** (10968 itself has no overlay byte: `Maps\Barbarians` r10968 is 8-byte records) |
| 8 | 1 | `LayersCnt` |

If `LayersCnt > 0`, immediately after: 1 byte **corners** (2 bits per corner, corner i at bits
2i..2i+1; 0 = base layer owns it, 1..3 = layer 0..2), 1 byte **BlendingLvl** (only if rev > 10745),
then **3 bytes per layer** (terrain Word — packed `terIdentInfo` when rev > 10745, legacy Word
otherwise — + 1 byte rotation). Max layers seen: 3. Verified real records (r11222 9-byte; r10968
8-byte; r13651 14-byte with 1 layer).
- **Landmine (documented, no map in this install hits it)**: a hypothetical `rev ≤ 10745` map with
  layers would be off by one byte per layered tile in the reader (writer always emits BlendingLvl).
  Our reader follows the reader code (blending iff rev > 10745); such maps would be rejected by the
  walk check rather than silently mis-parsed.
- Overlay enum (`terrain/KM_TerrainTypes.pas:11,176`): `0 toNone, 1 toDig1, 2 toDig2, 3 toDig3,
  4 toDig4, 5 toRoad`; render sprite ids `(0,249,251,253,255,254)`. 28 install maps carry non-zero
  overlays (max 3627 tiles). **Per-tile owner is NOT stored** — player roads come from the `.dat`
  (`!SET_STREET`), neutral roads from the map overlay.

### 2.4 Tail

`KM_TerrainPainter.pas:2041-2121`: after the tile region — Remake: **no resource block**, then
`'ADDN'`+`'TILE'`+u32 `chunkSize`+u32 `cypher` (16 bytes) + `X*Y` bytes of MapEd terrain kind.
Standard: the 22-byte resHead + `17*Allocated` bytes, then the same ADDN block. Verified on all 243
maps: Remake tail = `16 + X*Y` bytes, `chunkSize == X*Y` everywhere.

### 2.5 Map metadata for the list

From the **`.dat`** (`mission/KM_MissionScript_Info.pas:37-95`): `!SET_MAX_PLAYER` → player count;
`!SET_TACTIC` → fighting mode (absent = building mode); `!SET_HUMAN_PLAYER` / `!SET_USER_PLAYER` →
`CanBeHuman[]`; `!SET_AI_PLAYER` → classic-AI-capable; `!SET_ADVANCED_AI_PLAYER` → advanced-AI-
capable; `!SET_AI_START_POSITION x y` → per-hand start (all-zero stores (1,1)). Missing parameter =
−1. From the **`.map` header**: size only. `.txt` (optional): `Author`, `SmallDesc`, `BigDesc`,
flags (`SetCoop`, `PlayableAsSP`, …) — line-oriented, UTF-8 with ANSI fallback
(`KM_Maps.pas:1152-1236`). `.mi` = ignore.

### 2.6 Skirmish test set (verified from the real `.dat`s; humans/AI = per-hand flags)

| map | format | size | players | notes |
|---|---|---|---|---|
| `MapsMP\Arena` | Remake r12485 | 32×32 | 7 (humans 0-3) | fastest smoke test; tactic |
| `MapsMP\Cursed Land` | Remake r11222 | 64×64 | 4 (all human+classic+advanced) | clean 4P skirmish |
| `MapsMP\Cross` | Remake r15122 | 96×96 | 4 | tactic |
| `MapsMP\Battle Sun` | Remake r11222 | 128×128 | 4 | **building mode** (no `!SET_TACTIC`) |
| `MapsMP\Atoll` | **standard** 96×96 | 96×96 | 3 | XOR-239 `.dat` |
| `MapsMP\Equilibrium` | **standard** 80×80 | 80×80 | 4 | XOR-239 `.dat` |
| `MapsMP\Canyon` | Remake r12945 | 192×128 | 4 | 40 non-zero overlays |
| `MapsMP\A Way East` | Remake r12485 | 200×240 | 12 | 90 layered tiles, real AI starts |
| `MapsMP\Center Castle Looting` | Remake r13651 | 256×256 | 8 | stress: 8747 layered tiles + 264 overlays |

## 3. Interfaces (frozen)

- `packages/map/map.ts` — additive to `KaMap` (the M1 fields `tiles`, `tail`, `remake` stay; M1/M2b
  consumers unchanged):

  ```ts
  export interface KaMap {
    file: string; mapX: number; mapY: number;
    tiles: Uint8Array;        // 4 B/tile [terrain, height, rot, obj-low-byte] — unchanged contract
    remake: boolean;
    rev: number;              // parsed revision; 0 for standard maps
    overlay: Uint8Array;      // per tile: 0 none, 1..5 = toDig1..toRoad (zeros for standard)
    layers: Uint8Array;       // per tile: LayersCnt (zeros for standard)
    layerBytes: Uint8Array | null; // raw per-tile layer payload for future rendering (null = none)
    tail: { resHead: ... | null; mapEdChunk: boolean; tailBytes: number };
  }
  ```
  The reader must walk every tile record and **throw** when the walked length ≠ `mapDataSize`
  (Remake) or `23*X*Y` (standard) — the CLI proves 243/243.
- `packages/mission/mission.ts` — additive:

  ```ts
  export interface MissionInfo {
    maxPlayers: number; humanPlayer: number;
    canBeHuman: boolean[]; classicAI: boolean[]; advancedAI: boolean[]; // indexed by hand 0..26
    aiStart: { x: number; y: number }[];
    tactic: boolean; // !SET_TACTIC present
  }
  export function parseMissionInfo(bytes: Uint8Array): MissionInfo; // reuses the same decode+tokenizer
  ```
- `packages/map/maplist.ts`:

  ```ts
  export interface MapInfo {
    kind: string;            // 'Maps' | 'MapsMP' | ...
    name: string;            // folder name
    mapPath: string; datPath: string; txtPath: string | null;
    mapX: number; mapY: number; remake: boolean; rev: number;
    maxPlayers: number; canBeHuman: boolean[]; classicAI: boolean[]; advancedAI: boolean[];
    aiStart: { x: number; y: number }[];
    tactic: boolean; smallDesc: string; // '' when no .txt
    valid: boolean;          // map+dat present and maxPlayers > 0
  }
  export function scanMapFolders(roots: { kind: string; dir: string }[]): MapInfo[];
  ```
- `tools/mapscan/cli.ts`: `--check` (frozen totals + the full walk summary + `MAPSCAN CHECK PASS`),
  `--json` (the list), `--map <kind>/<name>` (one map's detail). Roots default to
  `<KAM_INSTALL>/Maps` + `MapsMP` (env override, like walksim).
- Viewer routes (`apps/web/serve.ts`) — **whitelist, never path-joined from user input**: the server
  runs `scanMapFolders` at startup and serves `/maps` (the `MapInfo[]` JSON) plus
  `/mapfile/<kind>/<name>/<map|dat|txt>` only for scanned entries.

## 4. Workers

- **Worker G** — `packages/map/map.ts` (Remake reader), `packages/map/maplist.ts`,
  `packages/mission/mission.ts` (additive `parseMissionInfo`), `tools/mapscan/**`, tests. Must not
  touch `apps/**`, `docs/**`, `package.json`; must keep the tutorial's grid sha
  (`556bfcb14a117834c62279bbdbc04afec5f67454ec41247d30afd2c8120ad3c1`) and all M0–M3 checks passing.
- **Worker H** — `apps/web/**` only: the picker UI, the routes, loading a chosen map into the
  existing viewers (terrain viewer and play viewer), overlay rendering for Remake maps' stored
  overlays.

## 5. Viewer (worker H)

- Map picker overlay (list from `/maps`: name, size, players, format `Remake r<rev>`/`Standard`,
  tactic/building) with a filter box; selecting a map loads it into `/play.html` (and `/map.html`).
- Rendering: base layer only for layered tiles (documented v0 simplification — the ground detail of
  up to 3 layers is not composited yet); stored overlays render with the road connectivity table
  (toRoad) and the dig sprite ids 249/251/253/255 (plain, rot 0).
- The economy world + demo scenario only when the chosen map is the tutorial (other maps load
  terrain + mission houses/units/streets as-is).

## 6. Acceptance (lead)

1. `node tools/mapscan/cli.ts --check` → `MAPSCAN CHECK PASS` (frozen: 243 maps = 35 + 208; 232
   Remake + 11 standard; every walk ends exactly at `mapDataSize` / `23*X*Y`; `chunkSize == X*Y`;
   the 11 XOR `.dat`s decoded; the 9 skirmish candidates listed with their metadata).
2. `npm test`, `npx tsc --noEmit` exit 0; regressions: M0 `CHECK PASS`, M1 `MAP CHECK PASS`, M2
   `replayinfo`, M2b `WALK CHECK PASS` + CDP 16/16, M3 `ECON CHECK PASS`.
3. Browser: the picker lists the maps; `Arena` (Remake 32×32), `Cursed Land` (64×64) and `Atoll`
   (standard + XOR `.dat`) each load and render with their mission houses/units; no exceptions;
   screenshots.
4. Lead's independent walker over all 243 maps (own script) → per-map (size, rev, walked length,
   overlay count) digest equals the parser's digest.

## 7. Acceptance record

### 7.1 Worker G — any-map loading: accepted

- `node tools/mapscan/cli.ts --check` → `MAPSCAN CHECK PASS (243 maps, 0 anomalies)` (exit 0):
  `maps=243 kinds(Maps=35 MapsMP=208) formats(remake=232 standard=11) dat(plain=232 xor239=11)`;
  `walk(ok=243 anomalies=0) chunk(ok=243/243) overlay(maps=28 tiles=6125 max=3627) layers(max=3
  tiles=29340)`; `terrain(words>255=49123 max=596; tiles[] keeps the low byte, baseTerrain the full
  Word)`; the 9 skirmish candidates match §2.6 exactly.
- Lead's independent walker (`%TEMP%\opencode\kamweb_m3b_leadwalk.mjs`, own implementation of the
  header + record rules): 243/232/11, 0 walk anomalies, overlay 28 maps / 6125 tiles, layered 29340 /
  max 3, 49,123 word-terrain tiles — identical totals; the 11 standard + 11 XOR `.dat` lists
  identical; per-map extremes match (K&M Tower Defense 3627 overlays, Center Castle Looting 264 +
  8747 layered, Omlott Falak 10075 layered, Center Trees 265 + 8297, The Flaming North 288). Digest
  `845fc9f0…baec` (lead's format). Note: the lead's walker prints 11 `chunkBad` for the standard
  maps because it does not skip the resource block — a script limitation, not a data finding (the
  parser and mapscan check them correctly).
- Tutorial regressions unchanged: `WALK CHECK PASS`, `ECON CHECK PASS` (sha `6d780b62…`),
  `MAP CHECK PASS`, the M2b grid sha `556bfcb1…ad3c1` YES; `npm test` **82/82** (G's 13 new tests
  wired into `package.json` by the lead); `npx tsc --noEmit` exit 0.
- Accepted deviations (G's flags): the §3 additions are optional in the type (7 pre-existing `KaMap`
  literals would break otherwise); **`baseTerrain: Uint16Array` added** because Remake maps use
  terrain ids > 255 (49,123 tiles — the low byte alone would flip walkability on 22,897 tiles);
  `aiStart` follows the standard mission parser (`+1`, `PointInMap`, default (1,1)); `layerBytes` =
  packed raw payloads in tile order; `LayersCnt > 3` throws; `maplist.ts` uses `node:fs`
  (server-side only — the browser viewer keeps its own reader; consolidating the browser-safe core
  out of `map.ts` is a follow-up refactor).

### 7.2 Worker H — map picker + viewer loading: accepted

- `npx tsc --noEmit` exit 0; `node apps/web/serve.ts --check` → `SERVE CHECK PASS (…, maps=243)`;
  H's own CDP runs: 43/43 + 6/6, plus worker F's M3 script 29/29 against H's server.
- Lead's independent run (`%TEMP%\opencode\kamweb_m3b_leadcdp.mjs`, live server on 8142):
  **RESULT PASS pass=21 fail=0** — `/maps` = 243 entries; Arena metadata (32×32, Remake r12485,
  7 players); **traversal route refused (404)** and bad extension refused; Arena `.map`/`.dat`
  served; Arena loads (7 mission serfs, 0 missing sprites, Remake); Atoll (standard + XOR-239 `.dat`)
  loads; Center Castle Looting (256×256, 8,747 layered tiles, 264 overlay tiles = 9 roads + 255
  digs) loads with 24 houses / 128 humanoids drawn; the tutorial reload keeps the M3 counters
  (21/34/159/30); 0 blocked requests; no page exceptions; screenshots.
- Accepted deviations (H's flags): the viewer keeps its own browser-side reader
  (`apps/web/mapread.ts`, 226 lines) because `packages/map/map.ts` imports `node:fs` —
  **dedupe follow-up: give the parser a browser-safe `Uint8Array` entry and point `mapread.ts` at
  it**; `baseTerrain` used for rendering (ids > 255); animals parsed-only, not drawn; `map.html`
  draws stored overlays only (no mission streets); layered tiles render the base layer; a failed map
  switch keeps the old terrain with the error in `#err`.
