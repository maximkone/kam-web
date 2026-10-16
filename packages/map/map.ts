// map.ts — parser for KaM .map terrain files (standard KaM and Remake header forms).
//
// Header (docs/M1-SPIKE.md section 2.1; KM_Utils.pas LoadMapHeader):
//   standard: i32 mapX (>= 1), i32 mapY.
//   Remake:   i32 0, UnicodeString game revision, u32 mapDataSize, i32 mapX, i32 mapY.
//             The revision string is a u16 char count + UTF-16LE chars (KM_CommonClasses.pas
//             TKMemoryStreamBinary.ReadW); the spec text says u32 — the source is the truth.
// Tiles (standard): mapX*mapY records of 23 bytes, row-major from (1,1):
//   byte0 terrain id, byte1 unused, byte2 height, byte3 rot (raw; consumers use rot & 3),
//   byte4 unused, byte5 obj (255 = none, else 1..254 = mapelem.dat id), bytes 6..22 unused.
//   Source: KM_TerrainUtils.pas ReadTileFromStream (KaM branch reads 6 bytes, then seeks 17).
// Tail (standard, best-effort): 22-byte resource head {u16 x1; i32 Allocated, Qty1, Qty2, x5,
//   Len17}, then 17*Allocated bytes, then optionally ADDN + TILE + u32 size + u32 cypher +
//   mapX*mapY bytes of MapEd terrain kinds (i8). Source: KM_TerrainPainter.pas LoadFromFile
//   lines 2041-2121.
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
}

/** On-disk byte range of the tile data (raw 23-byte records for standard maps), so tooling can
 *  crc32 exactly the bytes that were parsed (the `stats` in the frozen viewer JSON). */
export interface MapTileRegion { start: number; length: number }

export interface MapFileParse { map: KaMap; region: MapTileRegion }

const MAX_MAP_SIZE = 256;
const TILE_RECORD_SIZE = 23;
const RES_HEAD_SIZE = 22;
const RES_ENTRY_SIZE = 17;
const ADDN_HEAD_SIZE = 16; // 'ADDN' + 'TILE' + u32 size + u32 cypher

function bail(path: string, why: string): never {
  throw new Error(`map: ${path}: ${why}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dimensionsFit(mapX: number, mapY: number): boolean {
  return mapX >= 1 && mapX <= MAX_MAP_SIZE && mapY >= 1 && mapY <= MAX_MAP_SIZE;
}

interface FileLayout {
  mapX: number;
  mapY: number;
  remake: boolean;
  tileStart: number;  // offset of the tile data in the file
  tileLength: number; // its length in bytes (23-byte records for standard maps)
}

/** Walk the header and locate the tile region; throws a named error on a malformed header. */
function parseLayout(file: Buffer, path: string): FileLayout {
  if (file.length < 8) bail(path, `file shorter than 8 bytes (${file.length})`);
  const first = file.readInt32LE(0);

  if (first !== 0) {
    const mapX = first;
    const mapY = file.readInt32LE(4);
    if (!dimensionsFit(mapX, mapY)) {
      bail(path, `wrong dimensions [${mapX}:${mapY}], expected 1..${MAX_MAP_SIZE}`);
    }
    const tileLength = TILE_RECORD_SIZE * mapX * mapY;
    if (8 + tileLength > file.length) {
      bail(path, `tile region needs ${tileLength} bytes, only ${file.length - 8} left`);
    }
    return { mapX, mapY, remake: false, tileStart: 8, tileLength };
  }

  // Remake form: i32 0 | UnicodeString revision | u32 mapDataSize | i32 mapX | i32 mapY.
  let o = 4;
  if (o + 2 > file.length) bail(path, 'Remake header: truncated revision string length');
  const chars = file.readUInt16LE(o);
  o += 2;
  if (o + 2 * chars > file.length) {
    bail(path, `Remake header: revision string of ${chars} chars exceeds the file size`);
  }
  o += 2 * chars;
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
  return { mapX, mapY, remake: true, tileStart: o, tileLength: mapDataSize };
}

/** Standard maps: copy [terrain, height, rot, obj] out of the 23-byte records. */
function readTiles(file: Buffer, layout: FileLayout): Uint8Array {
  const tiles = new Uint8Array(layout.mapX * layout.mapY * 4);
  if (layout.remake) return tiles; // Remake tile layers are out of M1 scope; zeros per spec.
  for (let o = layout.tileStart, t = 0; t < tiles.length; o += TILE_RECORD_SIZE, t += 4) {
    tiles[t] = file[o];         // record byte 0: terrain id
    tiles[t + 1] = file[o + 2]; // record byte 2: height
    tiles[t + 2] = file[o + 3]; // record byte 3: rot (raw)
    tiles[t + 3] = file[o + 5]; // record byte 5: obj
  }
  return tiles;
}

function readTail(file: Buffer, layout: FileLayout): KaMap['tail'] {
  const tailStart = layout.tileStart + layout.tileLength;
  const tailBytes = file.length - tailStart;

  // resHead exists only in KaM-format files; a truncated tail leaves it null.
  let resHead: KaMap['tail']['resHead'] = null;
  if (!layout.remake && tailBytes >= RES_HEAD_SIZE) {
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
  if (layout.remake) chunkAt = tailStart;
  else if (resHead !== null && resHead.allocated >= 0) {
    chunkAt = tailStart + RES_HEAD_SIZE + RES_ENTRY_SIZE * resHead.allocated;
  }
  let mapEdChunk = false;
  if (chunkAt >= 0 && chunkAt + ADDN_HEAD_SIZE + layout.mapX * layout.mapY <= file.length) {
    mapEdChunk =
      file.toString('latin1', chunkAt, chunkAt + 4) === 'ADDN' &&
      file.toString('latin1', chunkAt + 4, chunkAt + 8) === 'TILE';
  }

  return { resHead, mapEdChunk, tailBytes };
}

/** Parse one `.map` from an in-memory buffer; `path` is used for the file name and errors. */
export function parseMapFileBytes(file: Buffer, path: string): MapFileParse {
  const layout = parseLayout(file, path);
  const map: KaMap = {
    file: basename(path),
    mapX: layout.mapX,
    mapY: layout.mapY,
    tiles: readTiles(file, layout),
    remake: layout.remake,
    tail: readTail(file, layout),
  };
  return { map, region: { start: layout.tileStart, length: layout.tileLength } };
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
