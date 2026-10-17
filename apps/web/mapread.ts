// mapread.ts — browser-side KaM `.map` reader for the M3b viewers (worker H).
//
// Produces the frozen M3b section 3 `KaMap` shape (packages/map/map.ts): tiles (4 B/tile
// [terrain, height, rot, obj-low-byte]), remake, rev, overlay, layers, layerBytes, tail.
//
// Why this file exists (deviation, flagged in the worker H report): the frozen section 3 contract
// freezes the KaMap *shape* for packages/map/map.ts but not a browser-safe byte-level entry — the
// node-side reader takes a Buffer and imports node:fs, so a browser import of it would break the
// page until worker G lands a Uint8Array entry. This reader is the viewer's own walk of the same
// bytes, line for line with the frozen record layout (docs/M3B-SPIKE.md 2.2-2.4) and the Pascal
// source it cites (KM_Utils.pas 80-103, KM_TerrainUtils.pas 114-228, KM_TerrainPainter.pas
// 2041-2121). If G's reader gains a browser-safe entry, play.ts/mapdemo.ts can delegate here.
//
// Layout (Remake; marker i32 0 at offset 0):
//   4 marker | u16 revChars | UTF-16LE "r<rev>" | u32 mapDataSize | i32 mapX | i32 mapY | tiles
//   tile record (rev > 10968: 9 B, else 8 B):
//     0 u16 terrain | 2 u8 rot(raw) | 3 u8 height | 4 u16 obj | 6 u8 isCustom
//     7 u8 overlay (only rev > 10968) | 7/8 u8 layersCnt
//   if layersCnt > 0: u8 corners | (rev > 10745: u8 blending) | layersCnt * (u16 terrain, u8 rot)
// Standard: i32 mapX | i32 mapY | mapX*mapY records of 23 B
//   (0 terrain | 2 height | 3 rot | 5 obj; bytes 6..22 opaque).
// Walked tile-region length must equal mapDataSize (Remake) / 23*X*Y (standard) or this throws.
// Tail: standard = 22 B resHead + 17*Allocated, then optional 'ADDN'+'TILE' chunk; Remake = the
// ADDN chunk directly after the tile region.
//
// Browser-safe: no node: imports, zero deps.

export interface MapResHead {
  x1: number;
  allocated: number;
  qty1: number;
  qty2: number;
  x5: number;
  len17: number;
}

export interface MapTail {
  resHead: MapResHead | null;
  mapEdChunk: boolean;
  tailBytes: number;
}

/** The frozen M3b section 3 KaMap shape (packages/map/map.ts), produced browser-side. */
export interface LoadedMap {
  file: string;
  mapX: number;
  mapY: number;
  tiles: Uint8Array;
  remake: boolean;
  rev: number;
  overlay: Uint8Array;
  layers: Uint8Array;
  layerBytes: Uint8Array | null;
  /** Per tile: the true Terrain id (Remake Word LE, standard byte) — like worker G's baseTerrain. */
  baseTerrain: Uint16Array;
  tail: MapTail;
}

const MAX_MAP_SIZE = 256;
const TILE_RECORD_SIZE = 23;
const RES_HEAD_SIZE = 22;
const RES_ENTRY_SIZE = 17;
const ADDN_HEAD_SIZE = 16; // 'ADDN' + 'TILE' + u32 size + u32 cypher

function bail(path: string, why: string): never {
  throw new Error(`mapread: ${path}: ${why}`);
}

function dimensionsFit(mapX: number, mapY: number): boolean {
  return mapX >= 1 && mapX <= MAX_MAP_SIZE && mapY >= 1 && mapY <= MAX_MAP_SIZE;
}

/** UTF-16LE string of `chars` characters starting at byte `o` (TKMemoryStreamBinary.ReadW). */
function readW(bytes: Uint8Array, o: number, chars: number): string {
  let s = '';
  for (let i = 0; i < chars; i++) s += String.fromCharCode(bytes[o + i * 2]! | (bytes[o + i * 2 + 1]! << 8));
  return s;
}

function readLatin1(bytes: Uint8Array, o: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[o + i]!);
  return s;
}

function readI32(bytes: Uint8Array, o: number): number {
  return (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) | 0;
}

function readU32(bytes: Uint8Array, o: number): number {
  return (bytes[o]! | (bytes[o + 1]! << 8) | (bytes[o + 2]! << 16) | (bytes[o + 3]! << 24)) >>> 0;
}

function readU16(bytes: Uint8Array, o: number): number {
  return bytes[o]! | (bytes[o + 1]! << 8);
}

/**
 * Parse one `.map` from bytes; `path` is used for the file name and errors. Throws on a malformed
 * header, a truncated tile region, or a walked length that does not match the declared size.
 */
export function parseMapBytes(bytes: Uint8Array, path: string): LoadedMap {
  if (bytes.length < 8) bail(path, `file shorter than 8 bytes (${bytes.length})`);
  const first = readI32(bytes, 0);

  if (first !== 0) {
    // Standard KaM format: i32 mapX, i32 mapY, then 23-byte records.
    const mapX = first;
    const mapY = readI32(bytes, 4);
    if (!dimensionsFit(mapX, mapY)) bail(path, `wrong dimensions [${mapX}:${mapY}], expected 1..${MAX_MAP_SIZE}`);
    const tileLength = TILE_RECORD_SIZE * mapX * mapY;
    if (8 + tileLength > bytes.length) bail(path, `tile region needs ${tileLength} bytes, only ${bytes.length - 8} left`);
    const n = mapX * mapY;
    const tiles = new Uint8Array(n * 4);
    const baseTerrain = new Uint16Array(n);
    for (let t = 0, o = 8; t < n; t++, o += TILE_RECORD_SIZE) {
      tiles[t * 4] = bytes[o]!; // record byte 0: terrain id
      tiles[t * 4 + 1] = bytes[o + 2]!; // record byte 2: height
      tiles[t * 4 + 2] = bytes[o + 3]!; // record byte 3: rot (raw)
      tiles[t * 4 + 3] = bytes[o + 5]!; // record byte 5: obj
      baseTerrain[t] = bytes[o]!;
    }
    const tailStart = 8 + tileLength;
    return {
      file: path,
      mapX,
      mapY,
      tiles,
      remake: false,
      rev: 0,
      overlay: new Uint8Array(n),
      layers: new Uint8Array(n),
      layerBytes: null,
      baseTerrain,
      tail: readTail(bytes, tailStart, mapX, mapY, false),
    };
  }

  // Remake format: i32 0 | UnicodeString revision | u32 mapDataSize | i32 mapX | i32 mapY.
  let o = 4;
  if (o + 2 > bytes.length) bail(path, 'Remake header: truncated revision string length');
  const chars = readU16(bytes, o);
  o += 2;
  if (o + 2 * chars > bytes.length) bail(path, `Remake header: revision string of ${chars} chars exceeds the file size`);
  const revStr = readW(bytes, o, chars);
  o += 2 * chars;
  // TryStrToInt(Copy(GameRevision, 2, Length-1)) — the first char is the non-digit marker ("r").
  const rev = /^[^0-9]\d+$/.test(revStr) ? Number(revStr.slice(1)) : NaN;
  if (!Number.isInteger(rev)) bail(path, `Unexpected game revision in map header ("${revStr}")`);
  if (o + 4 > bytes.length) bail(path, 'Remake header: truncated mapDataSize');
  const mapDataSize = readU32(bytes, o);
  o += 4;
  if (o + 8 > bytes.length) bail(path, 'Remake header: truncated dimensions');
  const mapX = readI32(bytes, o);
  const mapY = readI32(bytes, o + 4);
  o += 8;
  if (!dimensionsFit(mapX, mapY)) bail(path, `wrong dimensions [${mapX}:${mapY}], expected 1..${MAX_MAP_SIZE}`);
  if (o + mapDataSize > bytes.length) bail(path, `Remake mapDataSize ${mapDataSize} exceeds the ${bytes.length - o} bytes left`);

  const n = mapX * mapY;
  const hasOverlay = rev > 10968;
  const hasBlending = rev > 10745;
  const base = hasOverlay ? 9 : 8;
  const tiles = new Uint8Array(n * 4);
  const baseTerrain = new Uint16Array(n);
  const overlay = new Uint8Array(n);
  const layers = new Uint8Array(n);
  const parts: Uint8Array[] = [];
  let partLen = 0;
  const tileStart = o;

  for (let t = 0; t < n; t++) {
    if (o + base > bytes.length) bail(path, `tile ${t}: record truncated (${bytes.length - o} bytes left)`);
    const terrain = readU16(bytes, o);
    tiles[t * 4] = terrain & 0xff; // low byte: the 4 B/tile viewer contract
    tiles[t * 4 + 1] = bytes[o + 3]!; // height
    tiles[t * 4 + 2] = bytes[o + 2]!; // rot (raw; consumers use rot & 3)
    tiles[t * 4 + 3] = readU16(bytes, o + 4) & 0xff; // obj low byte (mapelem has 254 entries)
    baseTerrain[t] = terrain;
    if (hasOverlay) overlay[t] = bytes[o + 7]!;
    const layersCnt = bytes[o + base - 1]!;
    layers[t] = layersCnt;
    o += base;
    if (layersCnt > 0) {
      const start = o;
      o += 1; // corners
      if (hasBlending) o += 1;
      o += 3 * layersCnt;
      if (o > bytes.length) bail(path, `tile ${t}: layer payload truncated`);
      parts.push(bytes.subarray(start, o));
      partLen += o - start;
    }
  }
  if (o - tileStart !== mapDataSize) {
    bail(path, `walked ${o - tileStart} tile bytes, mapDataSize says ${mapDataSize}`);
  }

  let layerBytes: Uint8Array | null = null;
  if (partLen > 0) {
    layerBytes = new Uint8Array(partLen);
    let at = 0;
    for (const p of parts) {
      layerBytes.set(p, at);
      at += p.length;
    }
  }

  return {
    file: path,
    mapX,
    mapY,
    tiles,
    remake: true,
    rev,
    overlay,
    layers,
    layerBytes,
    baseTerrain,
    tail: readTail(bytes, o, mapX, mapY, true),
  };
}

/** Tail per KM_TerrainPainter.pas 2041-2121 (the M1 readTail, walked from the tile-region end). */
function readTail(bytes: Uint8Array, tailStart: number, mapX: number, mapY: number, remake: boolean): MapTail {
  const tailBytes = bytes.length - tailStart;

  let resHead: MapResHead | null = null;
  if (!remake && tailBytes >= RES_HEAD_SIZE) {
    resHead = {
      x1: readU16(bytes, tailStart),
      allocated: readI32(bytes, tailStart + 2),
      qty1: readI32(bytes, tailStart + 6),
      qty2: readI32(bytes, tailStart + 10),
      x5: readI32(bytes, tailStart + 14),
      len17: readI32(bytes, tailStart + 18),
    };
  }

  let chunkAt = -1;
  if (remake) chunkAt = tailStart;
  else if (resHead !== null && resHead.allocated >= 0) chunkAt = tailStart + RES_HEAD_SIZE + RES_ENTRY_SIZE * resHead.allocated;
  let mapEdChunk = false;
  if (chunkAt >= 0 && chunkAt + ADDN_HEAD_SIZE + mapX * mapY <= bytes.length) {
    mapEdChunk = readLatin1(bytes, chunkAt, 4) === 'ADDN' && readLatin1(bytes, chunkAt + 4, 4) === 'TILE';
  }

  return { resHead, mapEdChunk, tailBytes };
}
