// map.test.ts — the Remake tile reader + header (docs/M3B-SPIKE.md 2.2/2.3) and the unchanged
// standard path (M1 contract). Run: node --test packages/map/map.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapFileBytes, readMapHeader } from './map.ts';

function utf16(s: string): Buffer {
  const out = Buffer.alloc(2 * s.length);
  for (let i = 0; i < s.length; i++) out.writeUInt16LE(s.charCodeAt(i), 2 * i);
  return out;
}

function remakeHeader(rev: string, mapX: number, mapY: number, mapDataSize: number): Buffer {
  const revBuf = utf16(rev);
  const head = Buffer.alloc(6 + revBuf.length + 4 + 8);
  head.writeInt32LE(0, 0); // the Remake marker
  head.writeUInt16LE(rev.length, 4);
  revBuf.copy(head, 6);
  head.writeUInt32LE(mapDataSize, 6 + revBuf.length);
  head.writeInt32LE(mapX, 10 + revBuf.length);
  head.writeInt32LE(mapY, 14 + revBuf.length);
  return head;
}

interface LayerSpec {
  terrain: number;
  rot: number;
}

interface TileSpec {
  terrain: number;
  rot: number;
  height: number;
  obj: number;
  isCustom?: number;
  overlay?: number;
  corners?: number;
  blending?: number;
  layers?: LayerSpec[];
}

function remakeRecord(rev: number, spec: TileSpec): Buffer {
  const parts: Buffer[] = [];
  const base = Buffer.alloc(7);
  base.writeUInt16LE(spec.terrain, 0);
  base.writeUInt8(spec.rot, 2);
  base.writeUInt8(spec.height, 3);
  base.writeUInt16LE(spec.obj, 4);
  base.writeUInt8(spec.isCustom ?? 0, 6);
  parts.push(base);
  if (rev > 10968) parts.push(Buffer.from([spec.overlay ?? 0]));
  const layers = spec.layers ?? [];
  parts.push(Buffer.from([layers.length]));
  if (layers.length > 0) {
    parts.push(Buffer.from([spec.corners ?? 0]));
    if (rev > 10745) parts.push(Buffer.from([spec.blending ?? 0]));
    for (const layer of layers) {
      const bytes = Buffer.alloc(3);
      bytes.writeUInt16LE(layer.terrain, 0);
      bytes.writeUInt8(layer.rot, 2);
      parts.push(bytes);
    }
  }
  return Buffer.concat(parts);
}

/** ADDN+TILE+u32 chunkSize+u32 cypher (16 B) + X*Y bytes of MapEd terrain kinds. */
function tail(mapX: number, mapY: number): Buffer {
  const head = Buffer.alloc(16);
  head.write('ADDN', 0, 'latin1');
  head.write('TILE', 4, 'latin1');
  head.writeUInt32LE(mapX * mapY, 8);
  head.writeUInt32LE(987654321, 12);
  return Buffer.concat([head, Buffer.alloc(mapX * mapY)]);
}

function remakeMap(rev: string, mapX: number, mapY: number, tiles: TileSpec[], tailExtra = 0): Buffer {
  const revNo = Number(rev.slice(1));
  const data = Buffer.concat(tiles.map((t) => remakeRecord(revNo, t)));
  const head = remakeHeader(rev, mapX, mapY, data.length + tailExtra);
  return Buffer.concat([head, data, Buffer.alloc(Math.max(0, tailExtra)), tail(mapX, mapY)]);
}

/** Standard KaM map: i32 mapX, i32 mapY, 23-byte records, 22-byte resHead, ADDN chunk. */
function standardMap(mapX: number, mapY: number, records: Buffer[], allocated = 0): Buffer {
  const head = Buffer.alloc(8);
  head.writeInt32LE(mapX, 0);
  head.writeInt32LE(mapY, 4);
  const resHead = Buffer.alloc(22);
  resHead.writeUInt16LE(0, 0);
  resHead.writeInt32LE(allocated, 2);
  return Buffer.concat([head, ...records, resHead, Buffer.alloc(17 * allocated), tail(mapX, mapY)]);
}

function standardRecord(terrain: number, height: number, rot: number, obj: number): Buffer {
  const rec = Buffer.alloc(23);
  rec.writeUInt8(terrain, 0);
  rec.writeUInt8(height, 2);
  rec.writeUInt8(rot, 3);
  rec.writeUInt8(obj, 5);
  return rec;
}

test('Remake r12485: header, tile records, overlay, layers and the tail', () => {
  const file = remakeMap('r12485', 2, 2, [
    { terrain: 263, rot: 5, height: 34, obj: 255 },
    { terrain: 7, rot: 1, height: 3, obj: 12, overlay: 5 },
    { terrain: 300, rot: 0, height: 1, obj: 0, overlay: 1, corners: 0b01_10_11_00, blending: 200, layers: [{ terrain: 400, rot: 2 }] },
    {
      terrain: 596, rot: 7, height: 9, obj: 3, overlay: 4, corners: 0b11_11_11_11, blending: 7,
      layers: [{ terrain: 100, rot: 1 }, { terrain: 101, rot: 2 }, { terrain: 102, rot: 3 }],
    },
  ]);
  const { map, region } = parseMapFileBytes(file, 'test.map');

  assert.equal(map.file, 'test.map');
  assert.equal(map.remake, true);
  assert.equal(map.rev, 12485);
  assert.equal(map.mapX, 2);
  assert.equal(map.mapY, 2);

  // tiles[] keeps the M1 4-byte shape: the terrain/obj bytes are the low bytes of the Words.
  assert.deepEqual(Array.from(map.tiles!), [
    263 & 0xff, 34, 5, 255,
    7, 3, 1, 12,
    300 & 0xff, 1, 0, 0,
    596 & 0xff, 9, 7, 3,
  ]);
  assert.deepEqual(Array.from(map.baseTerrain!), [263, 7, 300, 596]);
  assert.deepEqual(Array.from(map.overlay!), [0, 5, 1, 4]);
  assert.deepEqual(Array.from(map.layers!), [0, 0, 1, 3]);

  // Packed layer payloads: corners + blending + (terrain Word + rot) per layer.
  const expectedLayers = [
    0b01_10_11_00, 200, 400 & 0xff, 400 >> 8, 2,
    0b11_11_11_11, 7, 100 & 0xff, 100 >> 8, 1, 101 & 0xff, 101 >> 8, 2, 102 & 0xff, 102 >> 8, 3,
  ];
  assert.deepEqual(Array.from(map.layerBytes!), expectedLayers);

  // Region: the walked records, ending exactly at mapDataSize.
  const recordsLength = 9 + 9 + (9 + 1 + 1 + 3) + (9 + 1 + 1 + 9);
  assert.equal(region.length, recordsLength);
  assert.equal(region.start, 6 + 2 * 'r12485'.length + 4 + 8);
  assert.equal(map.tail.tailBytes, 16 + 4);
  assert.equal(map.tail.mapEdChunk, true);
  assert.equal(map.tail.resHead, null);
});

test('Remake r10968: 8-byte base records, no overlay byte', () => {
  const file = remakeMap('r10968', 1, 2, [
    { terrain: 100, rot: 2, height: 5, obj: 255, overlay: 5 }, // the overlay byte must not be read
    { terrain: 101, rot: 3, height: 6, obj: 9, layers: [{ terrain: 200, rot: 1 }] },
  ]);
  const { map, region } = parseMapFileBytes(file, 'r10968.map');
  assert.equal(map.rev, 10968);
  assert.deepEqual(Array.from(map.overlay!), [0, 0]);
  assert.deepEqual(Array.from(map.layers!), [0, 1]);
  assert.equal(region.length, 8 + (8 + 1 + 1 + 3));
  assert.deepEqual(Array.from(map.layerBytes!), [0, 0, 200 & 0xff, 200 >> 8, 1]);
});

test('Remake rev <= 10745: layered records carry no BlendingLvl byte (the reader code)', () => {
  // The writer always emits blending, so no such map exists in the install; the reader follows
  // KM_TerrainUtils.pas 187 (blending iff rev > 10745) and this test pins that shape.
  const file = remakeMap('r10000', 1, 1, [
    { terrain: 50, rot: 0, height: 1, obj: 255, layers: [{ terrain: 60, rot: 3 }, { terrain: 61, rot: 2 }] },
  ]);
  const { map, region } = parseMapFileBytes(file, 'r10000.map');
  assert.equal(map.rev, 10000);
  assert.equal(region.length, 8 + 1 + 3 * 2);
  assert.deepEqual(Array.from(map.layerBytes!), [0, 60 & 0xff, 60 >> 8, 3, 61 & 0xff, 61 >> 8, 2]);
});

test('Remake walk mismatch: the walked length must equal mapDataSize', () => {
  // mapDataSize one byte longer than the records (the extra byte lands before the tail).
  const file = remakeMap('r12485', 1, 1, [{ terrain: 1, rot: 0, height: 1, obj: 255 }], 1);
  assert.throws(() => parseMapFileBytes(file, 'bad.map'), /walk ended at 9 bytes, header says mapDataSize 10/);

  // mapDataSize smaller than the records: the walk reads into the declared tail and stops short.
  const short = remakeMap('r12485', 1, 1, [{ terrain: 1, rot: 0, height: 1, obj: 255 }], -1);
  assert.throws(() => parseMapFileBytes(short, 'bad.map'), /walk ended at 9 bytes, header says mapDataSize 8/);
});

test('Remake LayersCnt > 3 is rejected', () => {
  const file = remakeMap('r12485', 1, 1, [
    {
      terrain: 1, rot: 0, height: 1, obj: 255,
      layers: [{ terrain: 1, rot: 0 }, { terrain: 2, rot: 0 }, { terrain: 3, rot: 0 }, { terrain: 4, rot: 0 }],
    },
  ]);
  assert.throws(() => parseMapFileBytes(file, 'layers.map'), /LayersCnt 4 > 3/);
});

test('Remake header errors: revision, dimensions, truncated file', () => {
  assert.throws(() => readMapHeader(remakeHeader('r', 1, 1, 0), 'r.map'), /unexpected game revision "r"/);
  assert.throws(() => readMapHeader(remakeHeader('r12x', 1, 1, 0), 'r.map'), /unexpected game revision "r12x"/);
  assert.throws(() => readMapHeader(remakeHeader('r12485', 0, 4, 0), 'r.map'), /wrong dimensions \[0:4\]/);
  assert.throws(() => readMapHeader(remakeHeader('r12485', 257, 4, 0), 'r.map'), /wrong dimensions \[257:4\]/);

  const header = remakeHeader('r12485', 4, 4, 1000);
  assert.throws(() => readMapHeader(header, 'r.map'), /mapDataSize 1000 exceeds the 0 bytes left/);
  assert.throws(() => readMapHeader(Buffer.alloc(4), 'r.map'), /file shorter than 8 bytes/);
});

test('Remake header: rev string is the text minus its first character (TryStrToInt)', () => {
  // KM_Utils.pas 91 drops the first char, so a stray leading char parses as part of the number.
  const header = readMapHeader(remakeHeader('x12000', 2, 2, 0), 'r.map');
  assert.equal(header.rev, 12000);
  assert.equal(header.remake, true);
  assert.equal(header.tileStart, 6 + 2 * 'x12000'.length + 4 + 8);
});

test('standard maps keep the M1 path: 23-byte records, resHead, ADDN chunk', () => {
  const file = standardMap(2, 2, [
    standardRecord(192, 0, 0, 255),
    standardRecord(0, 34, 5, 12),
    standardRecord(209, 7, 3, 0),
    standardRecord(245, 100, 2, 254),
  ]);
  const { map, region } = parseMapFileBytes(file, 'standard.map');

  assert.equal(map.remake, false);
  assert.equal(map.rev, 0);
  assert.deepEqual(Array.from(map.tiles!), [192, 0, 0, 255, 0, 34, 5, 12, 209, 7, 3, 0, 245, 100, 2, 254]);
  assert.deepEqual(Array.from(map.baseTerrain!), [192, 0, 209, 245]);
  assert.deepEqual(Array.from(map.overlay!), [0, 0, 0, 0]);
  assert.deepEqual(Array.from(map.layers!), [0, 0, 0, 0]);
  assert.equal(map.layerBytes, null);
  assert.equal(region.start, 8);
  assert.equal(region.length, 23 * 4);
  assert.deepEqual(map.tail.resHead, { x1: 0, allocated: 0, qty1: 0, qty2: 0, x5: 0, len17: 0 });
  assert.equal(map.tail.mapEdChunk, true);
  assert.equal(map.tail.tailBytes, 22 + 16 + 4);
});

test('standard maps: a short tile region is rejected', () => {
  const file = standardMap(2, 2, [standardRecord(1, 0, 0, 255)]);
  assert.throws(() => parseMapFileBytes(file, 'short.map'), /tile region needs 92 bytes, only 65 left/);
});
