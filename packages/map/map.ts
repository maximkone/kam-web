// map.ts — parser for KaM .map terrain files (standard KaM and Remake header forms).
//
// Header (docs/M1-SPIKE.md section 2.1; KM_Utils.pas LoadMapHeader 80-103):
//   standard: i32 mapX (>= 1), i32 mapY.
//   Remake:   i32 0, UnicodeString game revision, u32 mapDataSize, i32 mapX, i32 mapY.
//             The revision string is a u16 char count + UTF-16LE chars (KM_CommonClasses.pas
//             TKMemoryStreamBinary.ReadW); the spec text says u32 — the source is the truth.
//             The revision is the string minus its first character parsed as an int (KM_Utils.pas
//             91: TryStrToInt(Copy(GameRevision, 2, ...))) — e.g. "r12485" → 12485.
// Tiles (standard): mapX*mapY records of 23 bytes, row-major from (1,1):
//   byte0 terrain id, byte1 unused, byte2 height, byte3 rot (raw; consumers use rot & 3),
//   byte4 unused, byte5 obj (255 = none, else 1..254 = mapelem.dat id), bytes 6..22 unused.
//   Source: KM_TerrainUtils.pas ReadTileFromStream (KaM branch reads 6 bytes, then seeks 17).
// Tiles (Remake, docs/M3B-SPIKE.md 2.3; KM_TerrainUtils.pas ReadTileFromStream 155-224):
//   base record 9 bytes (8 when rev <= 10968): Terrain Word LE, Rotation raw, Height, Obj Word
//   LE, IsCustom, [TileOverlay only when rev > 10968], LayersCnt. When LayersCnt > 0:
//   1 byte corners (2 bits per corner), BlendingLvl only when rev > 10745, then LayersCnt
//   records of (Terrain Word LE + Rotation). The walk must end exactly at mapDataSize.
// Tail (standard, best-effort): 22-byte resource head {u16 x1; i32 Allocated, Qty1, Qty2, x5,
//   Len17}, then 17*Allocated bytes, then optionally ADDN + TILE + u32 size + u32 cypher +
//   mapX*mapY bytes of MapEd terrain kinds (i8). Source: KM_TerrainPainter.pas LoadFromFile
//   lines 2041-2121. Remake: no resource block — ADDN+TILE right after the tile region.
//
// Rendering rules (corner heights, UV rotation) are NOT here — see docs/M1-SPIKE.md 2.3.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

export interface MapTile { terrain: number; height: number; rot: number; obj: number }

export interface KaMap {
  file: string;            // base name
  mapX: number; mapY: number;
  tiles: Uint8Array;       // mapX*mapY*4, row-major: [terrain, height, rot, obj]
  remake: boolean;         // true when the Remake header form was used
  tail: { resHead: { x1: number; allocated: number; qty1: number; qty2: number; x5: number; len17: number } | null; mapEdChunk: boolean; tailBytes: number };
  // M3b additions (docs/M3B-SPIKE.md 3). Optional in the *type* so every pre-M3b KaMap literal
  // (apps/web/play.ts, the packages/sim tests) still typechecks — parseMapFile/parseMapFileBytes
  // always fill them (standard maps: rev 0, zeros, null, the terrain byte). Consumers of parsed
  // maps can read them; a hand-built literal must set them to opt in.
  rev?: number;             // game revision parsed from the header; 0 for standard maps
  overlay?: Uint8Array;     // per tile: 0 none, 1..5 = toDig1..toDig4/toRoad; zeros for standard maps
  layers?: Uint8Array;      // per tile: LayersCnt (0..3); zeros for standard maps
  layerBytes?: Uint8Array | null; // packed raw layer payloads of the tiles with layers (null = none)
  baseTerrain?: Uint16Array;      // per tile: the true terrain id (Remake Word LE; standard byte)
}

/** On-disk byte range of the tile data (raw 23-byte records for standard maps), so tooling can
 *  crc32 exactly the bytes that were parsed (the `stats` in the frozen viewer JSON). */
export interface MapTileRegion { start: number; length: number }

/** The header only (no tile walk) — enough for the map list (KM_Maps.pas LoadMapInfo). */
export interface MapHeader {
  mapX: number;
  mapY: number;
  remake: boolean;
  rev: number;          // 0 for standard maps
  mapDataSize: number;  // tile-region byte length (mapDataSize / 23*X*Y)
  tileStart: number;    // offset of the tile region in the file
}

export interface MapFileParse { map: KaMap; region: MapTileRegion }

const MAX_MAP_SIZE = 256;
const TILE_RECORD_SIZE = 23;
const RES_HEAD_SIZE = 22;
const RES_ENTRY_SIZE = 17;
const ADDN_HEAD_SIZE = 16; // 'ADDN' + 'TILE' + u32 size + u32 cypher
const REV_OVERLAY = 10968;  // TileOverlay byte exists only when rev > 10968 (KM_TerrainUtils.pas 164)
const REV_BLENDING = 10745; // BlendingLvl byte exists only when rev > 10745 (KM_TerrainUtils.pas 187)
const MAX_LAYERS = 3;       // TKMTerrainTileBasic.Layer[0..2] — the corner byte packs 0..3

function bail(path: string, why: string): never {
  throw new Error(`map: ${path}: ${why}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dimensionsFit(mapX: number, mapY: number): boolean {
  return mapX >= 1 && mapX <= MAX_MAP_SIZE && mapY >= 1 && mapY <= MAX_MAP_SIZE;
}

/** Pascal TryStrToInt: optional sign, decimal digits only, null when not a valid int. */
function tryStrToInt(s: string): number | null {
  if (!/^[+-]?\d+$/.test(s)) return null;
  const v = Number(s);
  return Number.isSafeInteger(v) ? v : null;
}

/**
 * Walk the header and locate the tile region; throws a named error on a malformed header.
 * Exported for the map list (size + format only, no tile walk).
 */
export function readMapHeader(file: Buffer, path: string): MapHeader {
  if (file.length < 8) bail(path, `file shorter than 8 bytes (${file.length})`);
  const first = file.readInt32LE(0);

  if (first !== 0) {
    const mapX = first;
    const mapY = file.readInt32LE(4);
    if (!dimensionsFit(mapX, mapY)) {
      bail(path, `wrong dimensions [${mapX}:${mapY}], expected 1..${MAX_MAP_SIZE}`);
    }
    const mapDataSize = TILE_RECORD_SIZE * mapX * mapY;
    if (8 + mapDataSize > file.length) {
      bail(path, `tile region needs ${mapDataSize} bytes, only ${file.length - 8} left`);
    }
    return { mapX, mapY, remake: false, rev: 0, mapDataSize, tileStart: 8 };
  }

  // Remake form: i32 0 | UnicodeString revision | u32 mapDataSize | i32 mapX | i32 mapY.
  let o = 4;
  if (o + 2 > file.length) bail(path, 'Remake header: truncated revision string length');
  const chars = file.readUInt16LE(o);
  o += 2;
  if (o + 2 * chars > file.length) {
    bail(path, `Remake header: revision string of ${chars} chars exceeds the file size`);
  }
  let revText = '';
  for (let i = 0; i < chars; i++) revText += String.fromCharCode(file.readUInt16LE(o + 2 * i));
  o += 2 * chars;
  // KM_Utils.pas 91: the revision is the string minus its first character, TryStrToInt'd.
  const rev = tryStrToInt(revText.slice(1));
  if (rev === null) bail(path, `unexpected game revision "${revText}" in the map header`);
  if (o + 4 > file.length) bail(path, 'Remake header: truncated mapDataSize');
  const mapDataSize = file.readUInt32LE(o);
  o += 4;
  if (o + 8 > file.length) bail(path, 'Remake header: truncated dimensions');
  const mapX = file.readInt32LE(o);
  const mapY = file.readInt32LE(o + 4);
  o += 8;
  if (!dimensionsFit(mapX, mapY)) {
    bail(path, `wrong dimensions [${mapX}:${mapY}], expected 1..${MAX_MAP_SIZE}`);
  }
  if (o + mapDataSize > file.length) {
    bail(path, `Remake mapDataSize ${mapDataSize} exceeds the ${file.length - o} bytes left`);
  }
  return { mapX, mapY, remake: true, rev, mapDataSize, tileStart: o };
}

/** Standard maps: copy [terrain, height, rot, obj] out of the 23-byte records (M1 contract). */
function readStandardTiles(file: Buffer, header: MapHeader): { tiles: Uint8Array; baseTerrain: Uint16Array } {
  const tiles = new Uint8Array(header.mapX * header.mapY * 4);
  const baseTerrain = new Uint16Array(header.mapX * header.mapY);
  for (let o = header.tileStart, t = 0; t < tiles.length; o += TILE_RECORD_SIZE, t += 4) {
    tiles[t] = file[o];         // record byte 0: terrain id
    tiles[t + 1] = file[o + 2]; // record byte 2: height
    tiles[t + 2] = file[o + 3]; // record byte 3: rot (raw)
    tiles[t + 3] = file[o + 5]; // record byte 5: obj
    baseTerrain[t >> 2] = file[o];
  }
  return { tiles, baseTerrain };
}

/**
 * Remake maps: walk every tile record (docs/M3B-SPIKE.md 2.3) and throw when the walked length
 * differs from the header's mapDataSize. The 4-byte `tiles` grid keeps the M1 shape: its terrain
 * byte is the low byte of the Terrain Word (obj is a Word too but mapelem has 254 entries, so its
 * low byte is exact). The full Word goes to `baseTerrain` — 207 distinct ids > 255 (49123 tiles)
 * exist in the r15472 install, and the low byte alone aliases walkability (e.g. 263 → 7).
 * `layerBytes` is the packed raw payload of the tiles that have layers, in tile order, so a
 * consumer walking `layers` can read each tile's corners/blending/layer records unchanged.
 */
function readRemakeTiles(
  file: Buffer,
  header: MapHeader,
  path: string,
): { tiles: Uint8Array; baseTerrain: Uint16Array; overlay: Uint8Array; layers: Uint8Array; layerBytes: Uint8Array | null } {
  const count = header.mapX * header.mapY;
  const tiles = new Uint8Array(count * 4);
  const baseTerrain = new Uint16Array(count);
  const overlay = new Uint8Array(count);
  const layers = new Uint8Array(count);
  const withOverlay = header.rev > REV_OVERLAY;
  const withBlending = header.rev > REV_BLENDING;
  const chunks: Uint8Array[] = [];
  let layerTotal = 0;

  let o = header.tileStart;
  for (let i = 0; i < count; i++) {
    const baseSize = withOverlay ? 9 : 8;
    if (o + baseSize > file.length) bail(path, `Remake tile ${i}: record exceeds the file size`);
    const terrain = file.readUInt16LE(o);
    const rot = file[o + 2];
    const height = file[o + 3];
    const obj = file.readUInt16LE(o + 4);
    o += 7;
    if (withOverlay) {
      overlay[i] = file[o];
      o += 1;
    }
    const layersCnt = file[o];
    o += 1;
    if (layersCnt > MAX_LAYERS) bail(path, `Remake tile ${i}: LayersCnt ${layersCnt} > ${MAX_LAYERS}`);

    const t = i * 4;
    tiles[t] = terrain & 0xff;
    tiles[t + 1] = height;
    tiles[t + 2] = rot; // raw (consumers use rot mod 4, KM_TerrainUtils.pas 158)
    tiles[t + 3] = obj & 0xff;
    baseTerrain[i] = terrain;
    layers[i] = layersCnt;

    if (layersCnt > 0) {
      const payload = 1 + (withBlending ? 1 : 0) + 3 * layersCnt; // corners [+ blending] + layers
      if (o + payload > file.length) bail(path, `Remake tile ${i}: layer payload exceeds the file size`);
      chunks.push(file.subarray(o, o + payload));
      layerTotal += payload;
      o += payload;
    }
  }

  const walked = o - header.tileStart;
  if (walked !== header.mapDataSize) {
    bail(path, `Remake tile walk ended at ${walked} bytes, header says mapDataSize ${header.mapDataSize}`);
  }

  let layerBytes: Uint8Array | null = null;
  if (chunks.length > 0) {
    layerBytes = new Uint8Array(layerTotal);
    let at = 0;
    for (const chunk of chunks) {
      layerBytes.set(chunk, at);
      at += chunk.length;
    }
  }
  return { tiles, baseTerrain, overlay, layers, layerBytes };
}

function readTail(file: Buffer, header: MapHeader): KaMap['tail'] {
  const tailStart = header.tileStart + header.mapDataSize;
  const tailBytes = file.length - tailStart;

  // resHead exists only in KaM-format files; a truncated tail leaves it null.
  let resHead: KaMap['tail']['resHead'] = null;
  if (!header.remake && tailBytes >= RES_HEAD_SIZE) {
    resHead = {
      x1: file.readUInt16LE(tailStart),
      allocated: file.readInt32LE(tailStart + 2),
      qty1: file.readInt32LE(tailStart + 6),
      qty2: file.readInt32LE(tailStart + 10),
      x5: file.readInt32LE(tailStart + 14),
      len17: file.readInt32LE(tailStart + 18),
    };
  }

  // ADDN+TILE follows the resource block (standard) or the mapDataSize region (Remake),
  // same as TKMTerrainPainter.LoadFromFile.
  let chunkAt = -1;
  if (header.remake) chunkAt = tailStart;
  else if (resHead !== null && resHead.allocated >= 0) {
    chunkAt = tailStart + RES_HEAD_SIZE + RES_ENTRY_SIZE * resHead.allocated;
  }
  let mapEdChunk = false;
  if (chunkAt >= 0 && chunkAt + ADDN_HEAD_SIZE + header.mapX * header.mapY <= file.length) {
    mapEdChunk =
      file.toString('latin1', chunkAt, chunkAt + 4) === 'ADDN' &&
      file.toString('latin1', chunkAt + 4, chunkAt + 8) === 'TILE';
  }

  return { resHead, mapEdChunk, tailBytes };
}

/** Parse one `.map` from an in-memory buffer; `path` is used for the file name and errors. */
export function parseMapFileBytes(file: Buffer, path: string): MapFileParse {
  const header = readMapHeader(file, path);
  const standard = header.remake ? null : readStandardTiles(file, header);
  const remake = header.remake ? readRemakeTiles(file, header, path) : null;
  const map: KaMap = {
    file: basename(path),
    mapX: header.mapX,
    mapY: header.mapY,
    tiles: standard !== null ? standard.tiles : remake!.tiles,
    remake: header.remake,
    rev: header.rev,
    overlay: remake !== null ? remake.overlay : new Uint8Array(header.mapX * header.mapY),
    layers: remake !== null ? remake.layers : new Uint8Array(header.mapX * header.mapY),
    layerBytes: remake !== null ? remake.layerBytes : null,
    baseTerrain: standard !== null ? standard.baseTerrain : remake!.baseTerrain,
    tail: readTail(file, header),
  };
  return { map, region: { start: header.tileStart, length: header.mapDataSize } };
}

/** Parse one `.map` file; throws an Error naming the file and the reason when malformed. */
export function parseMapFile(path: string): KaMap {
  let file: Buffer;
  try {
    file = readFileSync(path);
  } catch (err) {
    return bail(path, `cannot read file (${reason(err)})`);
  }
  return parseMapFileBytes(file, path).map;
}
