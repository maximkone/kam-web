// cli.ts — M1 map info: parse a KaM .map, print a one-line summary, export the frozen viewer
// JSON (docs/M1-SPIKE.md section 3.2), or verify the frozen Town Tutorial check values.
// Usage:
//   node tools/mapinfo/cli.ts "<file.map>" [--export <out.json>] [--check]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { crc32 } from 'node:zlib';
import { parseMapFileBytes } from '../../packages/map/map.ts';
import type { KaMap, MapTile, MapTileRegion } from '../../packages/map/map.ts';

// Frozen values for Tutorials\Town Tutorial\Town Tutorial.map (M1-SPIKE.md section 2.2).
const CHECK = {
  size: 381214,
  mapX: 128,
  mapY: 128,
  resHead: 'x1=0 allocated=256 qty1=10 qty2=10 x5=9 len17=17',
  mapEdChunk: 'false',
  tailBytes: 4374,
  tileBytesCrc32: 'dc1c14b5',
  terrainCrc32: 'ad8ffcbd',
  distinctTerrain: 149,
  heightMin: 0,
  heightMax: 100,
  objNone: 15364,
  objZero: 16,
  objReal: 1004,
  rawRotGt3: 462,
  tile0: 'terrain=192 height=0 rot=0 obj=255',
  tileAt64: 'terrain=0 height=34 rot=1 obj=255',
  tileAt64Index: 8256, // y*128 + x for x = y = 64 on the 128x128 Town Tutorial map
};

interface Options {
  file: string;
  exportTo: string | null;
  check: boolean;
}

interface MapStats {
  size: number;
  tileBytesCrc32: string;
  terrainCrc32: string;
  distinctTerrain: number;
  heightMin: number;
  heightMax: number;
  objNone: number;
  objZero: number;
  objReal: number;
  rawRotGt3: number;
  tailBytes: number;
}

function usage(): string {
  return 'usage: node tools/mapinfo/cli.ts "<file.map>" [--export <out.json>] [--check]';
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { file: '', exportTo: null, check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}\n${usage()}`);
      return argv[i];
    };
    if (arg === '--export') opts.exportTo = value();
    else if (arg === '--check') opts.check = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    } else if (opts.file === '') {
      opts.file = arg;
    } else {
      throw new Error(`more than one map file given ("${opts.file}", "${arg}")\n${usage()}`);
    }
  }
  if (opts.file === '') throw new Error(`map file is required\n${usage()}`);
  return opts;
}

function readMapBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new Error(`map: ${path}: cannot read file (${why})`);
  }
}

function hex32(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0');
}

function computeStats(map: KaMap, file: Buffer, region: MapTileRegion): MapStats {
  const count = map.mapX * map.mapY;
  const terrain = Buffer.alloc(count);
  const seen = new Set<number>();
  let heightMin = 255;
  let heightMax = 0;
  let objNone = 0;
  let objZero = 0;
  let objReal = 0;
  let rawRotGt3 = 0;
  for (let i = 0, o = 0; i < count; i++, o += 4) {
    const h = map.tiles[o + 1];
    const rot = map.tiles[o + 2];
    const obj = map.tiles[o + 3];
    terrain[i] = map.tiles[o];
    seen.add(map.tiles[o]);
    if (h < heightMin) heightMin = h;
    if (h > heightMax) heightMax = h;
    if (obj === 255) objNone += 1;
    else if (obj === 0) objZero += 1;
    else objReal += 1;
    if (rot > 3) rawRotGt3 += 1;
  }
  return {
    size: file.length,
    tileBytesCrc32: hex32(crc32(file.subarray(region.start, region.start + region.length))),
    terrainCrc32: hex32(crc32(terrain)),
    distinctTerrain: seen.size,
    heightMin,
    heightMax,
    objNone,
    objZero,
    objReal,
    rawRotGt3,
    tailBytes: map.tail.tailBytes,
  };
}

function readTile(map: KaMap, index: number): MapTile | null {
  const at = index * 4;
  if (at + 4 > map.tiles.length) return null;
  return { terrain: map.tiles[at], height: map.tiles[at + 1], rot: map.tiles[at + 2], obj: map.tiles[at + 3] };
}

function describeTile(tile: MapTile | null): string {
  if (tile === null) return '<out of range>';
  return `terrain=${tile.terrain} height=${tile.height} rot=${tile.rot} obj=${tile.obj}`;
}

/** Print the section 2.2 values and return the list of mismatches (empty = pass). */
function runCheck(map: KaMap, stats: MapStats): string[] {
  const problems: string[] = [];
  const say = (label: string, actual: string | number, expected: string | number): void => {
    const ok = String(actual) === String(expected);
    console.log(`CHECK ${label}=${actual}${ok ? '' : ` (expected ${expected})`}`);
    if (!ok) problems.push(`${label}=${actual}, expected ${expected}`);
  };

  say('size', stats.size, CHECK.size);
  say('mapX', map.mapX, CHECK.mapX);
  say('mapY', map.mapY, CHECK.mapY);
  const resHead = map.tail.resHead;
  say(
    'resHead',
    resHead === null
      ? '<missing>'
      : `x1=${resHead.x1} allocated=${resHead.allocated} qty1=${resHead.qty1} qty2=${resHead.qty2} ` +
        `x5=${resHead.x5} len17=${resHead.len17}`,
    CHECK.resHead,
  );
  say('mapEdChunk', String(map.tail.mapEdChunk), CHECK.mapEdChunk);
  say('tailBytes', stats.tailBytes, CHECK.tailBytes);
  say('tileBytesCrc32', stats.tileBytesCrc32, CHECK.tileBytesCrc32);
  say('terrainCrc32', stats.terrainCrc32, CHECK.terrainCrc32);
  say('distinctTerrain', stats.distinctTerrain, CHECK.distinctTerrain);
  say('heightMin', stats.heightMin, CHECK.heightMin);
  say('heightMax', stats.heightMax, CHECK.heightMax);
  say('objNone', stats.objNone, CHECK.objNone);
  say('objZero', stats.objZero, CHECK.objZero);
  say('objReal', stats.objReal, CHECK.objReal);
  say('rawRotGt3', stats.rawRotGt3, CHECK.rawRotGt3);
  say('tile[0]', describeTile(readTile(map, 0)), CHECK.tile0);
  say(`tile[${CHECK.tileAt64Index}] (64,64)`, describeTile(readTile(map, CHECK.tileAt64Index)), CHECK.tileAt64);
  return problems;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const file = readMapBytes(opts.file);
  const { map, region } = parseMapFileBytes(file, opts.file);
  const stats = computeStats(map, file, region);

  console.log(
    `MAP ${map.file} ${map.mapX}x${map.mapY} terrain=${stats.distinctTerrain} ` +
      `height=${stats.heightMin}..${stats.heightMax} obj=${stats.objReal} tail=${stats.tailBytes}`,
  );

  if (opts.exportTo !== null) {
    const viewer = {
      file: map.file,
      mapX: map.mapX,
      mapY: map.mapY,
      tiles: Buffer.from(map.tiles.buffer, map.tiles.byteOffset, map.tiles.byteLength).toString('base64'),
      stats,
    };
    mkdirSync(dirname(opts.exportTo), { recursive: true });
    writeFileSync(opts.exportTo, JSON.stringify(viewer)); // no trailing newline: matches the lead's frozen file
    console.log(`EXPORT ${opts.exportTo.replace(/\\/g, '/')}`);
  }

  if (opts.check) {
    const problems = runCheck(map, stats);
    if (problems.length === 0) {
      console.log('MAP CHECK PASS');
    } else {
      console.log(`MAP CHECK FAIL: ${problems.join('; ')}`);
      process.exitCode = 1;
    }
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
