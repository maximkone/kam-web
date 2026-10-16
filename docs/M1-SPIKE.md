# M1 spike — map loader + terrain viewer (frozen spec)

Status: **frozen 2026-10-16** for two parallel M1 workers (parser / renderer). The lead owns this file.

## 0. Environment rules (same as M0)

- Repo root: `C:\empire\games\kam-web`. `_ref\kam_remake` is read-only.
- Node 24 runs `.ts` directly: erasable syntax only (no `enum`/`namespace`/parameter properties), relative imports include `.ts`, zero runtime deps.
- No commits. Every claim needs a one-line proof command + result.
- Do not break M0: `node tools/import/cli.ts --install "C:\Users\me\Desktop\KaM Remake" --check` must still print `CHECK PASS`, and `npx tsc --noEmit` must stay exit 0.

## 1. What M1 proves

Load a real KaM `.map` from the owner's install, expose it as browser data, and render its **terrain** with the KaM look: 40 px top-down tiles, per-corner heights, 4-way rotation, pan + zoom, tile HUD.

## 2. Verified facts (lead, 2026-10-16, all confirmed against the install + source)

### 2.1 `.map` container (standard KaM format)

- Header: `i32 mapX`, `i32 mapY` (mapX ≥ 1 → standard format). Remake format: first `i32` = 0, then UnicodeString (`u16 len` + UTF-16LE chars; `KM_CommonClasses.pas` `ReadW` reads a Word — the first draft of this spec said u32, the source and 356 real Remake-format maps in the owner's nested beta install say u16), `u32 mapDataSize`, `i32 mapX`, `i32 mapY` (`KM_Utils.pas` `LoadMapHeader`). M1 target maps are standard format; Remake-format files parse (header + skip tiles) but tile content is not decoded (see 3.1).
- Tiles: `mapX*mapY` records **23 bytes** each, row-major from (1,1):
  `byte0 terrain id (0..255)`, `byte1 unused`, `byte2 height (0..255)`, `byte3 rot (raw; use `rot & 3`; original maps have rot > 3)`, `byte4 unused`, `byte5 obj (255 = none, else 1..254 = mapelem.dat id)`, bytes 6..22 unused (17). Source: `KM_TerrainUtils.pas` `ReadTileFromStream` (KaM branch reads 6, seeks 17).
- Tail after tiles: 22-byte resHead `{ u16 x1; i32 Allocated; i32 Qty1; i32 Qty2; i32 x5; i32 Len17 }`, then `17*Allocated` bytes, then optionally `ADDN`+`TILE` + `u32 size` + `u32 cypher` + `mapX*mapY` bytes (MapEd terrain kinds, i8). Source: `KM_TerrainPainter.pas` `LoadFromFile` lines 2041-2121.
- Verified mechanically on 4 install maps (sizes reconcile exactly):
  Town Tutorial 128²: 381214 = 8 + 376832 + (22 + 17*256); Battle Tutorial 64²: 6310 tail = 22 + 17*128 + 4112 ADDN; Cross 96²: 3286 = 22 + 17*192; Gunplay 32²: 2150 = 22 + 17*64 + 1040 ADDN.

### 2.2 Town Tutorial check values (frozen)

`Tutorials\Town Tutorial\Town Tutorial.map`: size 381214; mapX = mapY = 128;
resHead `{x1:0, Allocated:256, Qty1:10, Qty2:10, x5:9, Len17:17}`; no ADDN chunk;
**crc32 of the 376832 tile bytes = `0xdc1c14b5`**, crc32 of the terrain column = `0xad8ffcbd`;
distinct terrain ids = 149; heights 0..100; obj = 255×15364, 0×16, 1..254×1004; raw rot > 3 on 462 tiles;
tile[0] = terrain 192 / height 0 / rot 0 / obj 255; tile at x=64,y=64 (index `y*128+x`=8256) = terrain 0 / height 34 / rot 1 / obj 255.

### 2.3 Terrain rendering (`KM_RenderTerrain.pas`, `RENDER_3D = False` → ortho top-down)

- Constants: `CELL_SIZE_PX = 40` (tile square on screen), `CELL_HEIGHT_DIV = 33.333` (`KM_Defaults.pas` lines 13-14). A height delta of 33.33 shifts a vertex by one tile (40 px); i.e. screen offset px = `height * 40 / 33.333 = height * 1.2`.
- Tile (tX,tY) (1-based) covers the world square `[tX-1..tX] x [tY-1..tY]` (times 40 px). Corner heights (`RenderQuadTexture`, lines 522-538):
  TL ← RenderHeight[tY, tX], BL ← [tY+1, tX], BR ← [tY+1, tX+1], TR ← [tY, tX+1]; each vertex `y -= RenderHeight / CELL_HEIGHT_DIV`. `RenderHeight` = the tile's height byte (`GetRenderHeight`, flat-terrain debug mode off). Reads outside the map = 0.
- Texture: `Tileset.rxx` sprite `BaseLayer.Terrain + 1` (32×32 px), from `out/atlas/Tileset.json` (sprite entry with `i == terrain` — errata 2026-10-16: the game binds `gGFXData[rxTiles, Terrain+1]` and atlas `i` = game render id − 1, so the atlas entry is `i == terrain`, not `terrain+1`); rotation via UV corner permutation (`GetTileUV` lines 233-270): base UV corners for quad corners TL,BL,BR,TR are (u1,v1),(u1,v2),(u2,v2),(u2,v1); `rot&1` rotates the corner mapping by one step (4-1-2-3), `rot&2` swaps 1↔3 and 2↔4. Apply `rot & 3`.
- The map border columns (X=1/MapX, Y=1/MapY) fade to black in the game (lighting) — **out of scope for M1**, note only.

## 3. Worker A — map parser + exporter (owns `packages/map/**`, `tools/mapinfo/**`)

### 3.1 `packages/map/map.ts`

```ts
export interface MapTile { terrain: number; height: number; rot: number; obj: number }
export interface KaMap {
  file: string;            // base name
  mapX: number; mapY: number;
  tiles: Uint8Array;       // mapX*mapY*4, row-major: [terrain, height, rot, obj]
  remake: boolean;         // true when the Remake header form was used
  tail: { resHead: { x1: number; allocated: number; qty1: number; qty2: number; x5: number; len17: number } | null; mapEdChunk: boolean; tailBytes: number };
}
export function parseMapFile(path: string): KaMap;
```
- Reject with a named error when: file < 8 bytes, mapX/mapY outside 1..256 (MAX_MAP_SIZE), tile region doesn't fit the file.
- Later tail bytes are best-effort: missing tail is OK (tailBytes = 0), truncated resHead → `resHead: null`.
- Remake-format files: parse the header; the tile region is variable-length (`mapDataSize`) — for M1, if the header is Remake format and `mapDataSize` fits, **skip** tiles (fill zeros) and mark `remake: true`. Only standard maps are rendered.

### 3.2 `tools/mapinfo/cli.ts`

```
node tools/mapinfo/cli.ts "<file.map>" [--export <out.json>] [--check]
```
- Default line: `MAP <name> <mapX>x<mapY> terrain=<distinct> height=<min>..<max> obj=<real count> tail=<tailBytes>`.
- `--export` writes the frozen viewer format (this exact shape):
```json
{ "file": "Town Tutorial.map", "mapX": 128, "mapY": 128,
  "tiles": "<base64 mapX*mapY*4 bytes [terrain,height,rot,obj]>",
  "stats": { "size": 381214, "tileBytesCrc32": "dc1c14b5", "terrainCrc32": "ad8ffcbd",
             "distinctTerrain": 149, "heightMin": 0, "heightMax": 100,
             "objNone": 15364, "objZero": 16, "objReal": 1004, "rawRotGt3": 462, "tailBytes": 4374 } }
```
  (`tileBytesCrc32` is zlib `crc32` of the raw 23-byte records slice, hex, no `0x`; `terrainCrc32` over the terrain column bytes.)
- `--check` on the Town Tutorial path prints the §2.2 values and ends with `MAP CHECK PASS` (exit 0) or `MAP CHECK FAIL: <reason>` (exit 1). `--export out/maps/TownTutorial.json` must reproduce every §2.2 number.
- The lead has pre-written `out/maps/TownTutorial.json` in the frozen format (`out/` is gitignored) — your exporter must produce compatible output when parsed back.

## 4. Worker B — map viewer (owns `apps/web/**`)

### 4.1 serve.ts: generalize the demo.js route

Replace the hardcoded `/apps/web/demo.js` route with `^/apps/web/([A-Za-z0-9_-]+)\.js$` → build `apps/web/<name>.ts` to `out/web/<name>.js` (same local-tsc single-file emit; rebuild when the `.ts` is newer). Keep everything else working.

### 4.2 `apps/web/map.html` + `apps/web/mapdemo.ts` (new; leave demo.* alone)

- Fetch `/out/maps/TownTutorial.json` (pre-made; the data contract is §3.2) + `/out/atlas/Tileset.json` + its sheet PNGs (reuse the atlas convention; you may import nothing — copy what you need from `demo.ts`).
- Build ONE static vertex buffer for all tiles (4 verts + 6 indices per tile, ~16384 tiles) and render with a single `drawElements` per frame; camera = uniform translate+scale.
- World coordinates: px, `x = tX*40`, `y = tY*40 - height*1.2` per corner per §2.3 (corner heights TL/BL/BR/TR as listed; out-of-map = 0). UVs: from the atlas sprite `terrain` rect (errata 2026-10-16, see §2.3 above), corners permuted by `rot & 3` per §2.3. Store UVs in vertex attributes so the shader needs only a camera uniform.
- Camera: starts fit-to-map (whole 128×128 map visible); drag pans; wheel zooms around the cursor (factor 1.5 per notch, clamp 0.25..8); `R` resets.
- HUD (bottom-left, like demo): map name, mapX×mapY, zoom, and the tile under the cursor: `tile (x,y) terrain=… rot=… height=… obj=…`.
- Background: flat `#202830`; tiles with alpha blend over it (some border tiles are transparent — that's also what the game shows over black).
- `nav` links between `/` and `/map.html` in both pages are nice-to-have, not required.

## 5. Acceptance proofs (must appear in the worker reports)

1. A: `node tools/mapinfo/cli.ts "C:\Users\me\Desktop\KaM Remake\Tutorials\Town Tutorial\Town Tutorial.map" --check` → `MAP CHECK PASS`; `--export` line; a second map (Battle Tutorial) prints sane stats; `npx tsc --noEmit` exit 0; `node tools/import/cli.ts ... --check` still `CHECK PASS`.
2. B: `node apps/web/serve.ts` running; headless-Edge screenshots `out/m1-map-town.png` (fit view: town with water/roads/trees-terrain visible) and `out/m1-map-town-zoom.png` (zoomed, showing height cliffs); HUD text line from the page; `npx tsc --noEmit` exit 0. Use the real-browser skill (`C:\empire\center\skills-shared\real-browser-automation\scripts\cdp.mjs`, import via `file:///C:/...`).
3. Lead: re-runs everything, views screenshots, commits.

## 6. Non-goals for M1

Object/tree/house sprites, fog of war, lighting/shadows, water animation frames, Remake-format tile layers/overlays, minimap, missions/`.dat`, editor.

## 7. Lead acceptance record (2026-10-16)

Fresh headless Edge run against the live dev server (`http://127.0.0.1:8124/map.html`, script
`%TEMP%\opencode\kamweb_m1_verify.mjs`): **`LEAD M1 VERIFY PASS (15 checks)`** — fit view
`128×128 zoom=0.138 cam=(2560,2560)` (= exact fit for 1256×708); 4 hover probes: HUD tile fields
byte-equal the frozen `out/maps/TownTutorial.json`; wheel zoom ×1.5 per notch with the world point
under the cursor fixed (<0.5 px world); `R` resets to fit; wheel-out clamps at fit; `#err` empty;
page console clean; `blocked: []`. Screenshots `out/m1-lead-fit.png`, `out/m1-lead-zoom.png`.

Accepted deviations from §4.2 as shipped (patched here at acceptance):

1. Wheel zoom minimum is `min(0.25, fitZoom)`, not flat `0.25`: on viewports where the fit zoom is
   below 0.25 (0.138 at 1256×708 for the 128×128 map) the fit view stays reachable. Maximum 8 unchanged.
2. HUD adds `index=` (tile index `(y-1)*mapX+(x-1)`, same as `--check` §2.2) and `cam=(x,y)`
   (world px of the view centre, rounded). All specced fields unchanged.

Black-quad check (worker B's claim, corrected twice — final 2026-10-16): the earlier finding was an
artifact of the sprite-index off-by-one (errata §2.3). With the correct mapping (`i = terrain`) the
pure black sprite belongs to **terrain 245 `tkAbyss`, 123 tiles** — the black cliff faces of the
iron-mountain band (bbox x 57..85, y 71..117, all obj=255), which the game renders black by design
(no special-casing in `KM_RenderTerrain.pas`); terrain 244 (`tkFastWater`, 5 tiles) is the teal
fast-water sprite; 164 (571 tiles) is the iron-mountain rock (mean RGB 152,113,36) and 230 (2 tiles)
the light grassy-water sprite. Proof: `%TEMP%\opencode\kamweb_offby1_check.mjs` (colour table) and
`%TEMP%\opencode\kamweb_align_render.mjs` (`%TEMP%\opencode\kamweb_align.png`: region (45,45)–(90,90),
left `i = terrain` renders a clean town, right `i = terrain+1` shows water/black speckles).
