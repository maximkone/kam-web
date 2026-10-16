# M0 spike — frozen spec (rxx → atlas → browser viewer)

Status: **DONE — accepted 2026-10-16** (proofs in `docs/DECISIONS.md` and the commit body).
Frozen 2026-10-16 for the two parallel M0 workers. Do not change field layouts or file names without the lead.

## 0. Environment rules (all workers)

- Repo root: `C:\empire\games\kam-web`. Work only inside it. `_ref\kam_remake` is a read-only reference clone of the AGPL source — read it, never edit it.
- Runtime: **Node 24 (`node file.ts` runs TypeScript natively, type-stripping)**. Therefore: erasable syntax only — **no `enum`, no `namespace`, no parameter properties**; plain `import`/`export`; **include `.ts` extensions in relative imports**.
- **Zero runtime dependencies** (node: builtins only). No npm install in M0.
- No commits, no `git add` — the lead commits.
- Every claim in your report needs a one-line proof: the exact command + its first/last output line.

## 1. What M0 proves

Decode the legacy KaM Remake sprite packs from the user's install, repack them into web-friendly PNG atlases + a JSON manifest, and render sprites in a browser via WebGL2.

## 2. RXX input format (verbatim from the source, verified empirically)

Reference: `_ref\kam_remake\src\res\KM_ResSprites.pas` lines 743–838 (`ReadRXZHeader`, `LoadFromRXXFile`).
Verified full parse of the real file `C:\Users\me\Desktop\KaM Remake\data\Sprites\Units.rxx` (spike scripts in `C:\Users\me\AppData\Local\Temp\opencode\rxx_*.mjs`, 0 leftover bytes, 8688 sprites).

### 2.1 Container

1. Read first 4 bytes:
   - `RXX1` → skip **32** more bytes → zlib stream follows.
   - `RXX2` → read **uint16 LE metadataLen** → skip **metadataLen** bytes → zlib stream follows.
   - first two bytes `78 DA` → **legacy (`rxx0`)**, zlib stream starts at offset 0.
   - anything else → reject (exit non-zero, name the file).
2. Inflate the remainder (node:zlib `inflateSync`) to buffer `B`.

### 2.2 Payload in `B`

```
i32   count
u8    flags[count]              // 1 = sprite present, 0 = empty slot
then, for every index i in 0..count-1 with flags[i]==1:
  RXX0 (legacy, VERIFIED against Units.rxx):
    u16 sizeX, u16 sizeY
    i32 pivotX, i32 pivotY
    u8  rgba[sizeX*sizeY*4]     // byte order R,G,B,A (verified visually: as-is = correct knights,
                                // swapped = blue — see spike decision log DECISIONS.md)
    u8  hasMask                 // 0 or 1
    u8  mask[sizeX*sizeY]       // only if hasMask==1 (team-color mask; 1 byte per pixel)
  RXX1/RXX2 (modern; from source, no local sample yet):
    same, EXCEPT: pivotX/pivotY are i16, and when the pack is Units there is an extra
    i16 i16 i16 i16 rect (SizeNoShadow: left,top,right,bottom) between pivot and rgba.
```

### 2.3 Validation (hard requirements)

- Parse completes with **0 leftover bytes**.
- Every sprite: `1 <= sizeX <= 4096`, `1 <= sizeY <= 4096`, `hasMask` ∈ {0,1}.
- If a legacy parse fails validation, retry as modern; if both fail → error out (no partial output).
- Report in the CLI output: `packs, sprites, sheets, bytes out`.

## 3. Output contract (converter)

`packages/assets/rxx.ts` — decoder lib:
```ts
export type RxxFormat = 'rxx0' | 'rxx1' | 'rxx2';
export interface RxxSprite { index: number; w: number; h: number; px: number; py: number; rgba: Buffer; mask: Buffer | null; }
export interface RxxPack { pack: string; format: RxxFormat; count: number; sprites: RxxSprite[]; }
export function decodeRxx(filePath: string, packName: string): RxxPack;
```

`packages/assets/atlas.ts` — shelf packer + manifest writer:
- Sheet size: width **2048**, max height 4096; shelf packing (sort not required, keep index order); open a new sheet when full. Masks (if any sprite has one) go to their own sheets.
- Writes `<out>/atlas/<Pack>.json` + `<out>/atlas/<Pack>.<n>.png`:

```json
{
  "pack": "Units", "format": "rxx0", "count": 9400, "present": 8688,
  "sheets":  [{"file": "Units.0.png", "w": 2048, "h": 1450}],
  "maskSheets": [{"file": "Units.m0.png", "w": 2048, "h": 1450}],
  "sprites": [
    { "i": 64, "w": 33, "h": 40, "px": -13, "py": -35, "s": 0, "x": 0, "y": 0, "ms": 0, "mx": 0, "my": 0 }
  ]
}
```
- `s`/`x`/`y` = sheet index and top-left of the sprite in the sheet; `ms`/`mx`/`my` = same for the mask (omit/`-1` when no mask).
- PNGs: RGBA8, straight alpha (no premultiply), color type 6. Encoder in `packages/assets/png.ts` (zero-dep, zlib deflate; working reference exists in the spike scripts `rxx_peek2.mjs`/`rxx_sheet.mjs` — copy that approach).

`tools/import/cli.ts`:
```
node tools/import/cli.ts --install "<KaM Remake root or data\Sprites dir>" [--out out] [--packs Units,Tileset] [--check]
```
- Locates `<root>/data/Sprites/<Pack>.rxx` (accept the direct Sprites dir too). Default packs: `Units,Tileset,Houses,Trees,GUI,GUIMain`.
- Prints one line per pack: `PACK <name> format=rxx0 sprites=<present> sheets=<n> out=out/atlas/<name>.json` and finishes with `DONE packs=<n> sprites=<total>`, non-zero exit on validation failure.
- `--check` additionally asserts for Units.rxx of the user's install: `present == 8688`, zero leftover, and sprite index 0 = `15x16 pivot(-1,-28)`; index 64 = `33x40 pivot(-13,-35)` mask=yes. Print `CHECK PASS`.
  Correction 2026-10-16 (lead): the first draft said pivot(-1,-1) for sprite 0; the spike script had read only the first i16 word of each i32 pivot. Full i32 pivot is (-1,-28); confirmed by the same zero-leftover full parse.

## 4. Output contract (web viewer)

`apps/web/serve.ts` — zero-dep static server over the repo root on `127.0.0.1:8123` (args: `--port`). Endpoints: static files, plus `GET /api/packs` → JSON list of available `out/atlas/*.json` pack names (read dir; empty list OK).

`apps/web/index.html` + `apps/web/demo.ts` — WebGL2 sprite browser:
- Dropdown of packs (from `/api/packs`; default `Units`), loads its JSON + textures.
- Renders the selected sprite centered, integer scale ×4, sprite origin/pivot marked by a crosshair (toggle `G`), checkerboard-free transparent background, mask overlay toggle `M` (draw mask sheet as red where set), grid/background toggle `B` (flat #202830 / checkerboard).
- Controls: ←/→ prev-next present sprite (note: indices can have gaps — step over `sprites` array order), input box for exact index + "go", "▶" cycles the next 8 present sprites as a fake animation at 8 fps.
- HUD text: pack, index, size, pivot(px,py), sheet/xy. No frameworks, no deps, ~1 file each.

## 5. Acceptance proofs (must all appear in the worker report)

1. `node tools/import/cli.ts --install "C:\Users\me\Desktop\KaM Remake" --check` → `CHECK PASS` + `DONE` lines.
2. `node tools/import/cli.ts --install "C:\Users\me\Desktop\KaM Remake" --packs Tileset` → ok line.
3. `node apps/web/serve.ts` running; `Invoke-WebRequest http://127.0.0.1:8123/api/packs` returns the pack list.
4. (Lead, after integration) headless-browser screenshot of the viewer showing a real sprite.

## 6. Non-goals for M0

No animations semantics (which ids are walk cycles), no team-color recoloring, no terrain rendering, no `.rxa`, no maps, no audio. Those are M1+.
