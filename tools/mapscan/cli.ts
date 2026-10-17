// cli.ts — M3b mapscan: walk every map in the install and prove the parser (docs/M3B-SPIKE.md 6).
// Usage:
//   node tools/mapscan/cli.ts --check        all maps: full walk + frozen totals, MAPSCAN CHECK PASS/FAIL
//   node tools/mapscan/cli.ts --json         the scanned MapInfo[] list
//   node tools/mapscan/cli.ts --map <kind>/<name>   one map's detail (walk + mission info)
//
// Roots default to <KAM_INSTALL>/Maps + <KAM_INSTALL>/MapsMP (the r15472 install, read-only).
// The frozen totals come from docs/M3B-SPIKE.md 2.1/2.3/2.4/2.6.
import { readFileSync } from 'node:fs';
import { parseMapFileBytes } from '../../packages/map/map.ts';
import type { KaMap, MapTileRegion } from '../../packages/map/map.ts';
import { scanMapFolders } from '../../packages/map/maplist.ts';
import type { MapInfo } from '../../packages/map/maplist.ts';
import { missionScriptIsXor239 } from '../../packages/mission/mission.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const ROOTS = [
  { kind: 'Maps', dir: `${INSTALL}/Maps` },
  { kind: 'MapsMP', dir: `${INSTALL}/MapsMP` },
];

// Frozen totals (docs/M3B-SPIKE.md 2.1, 2.3, 2.4).
const CHECK = {
  maps: 243,
  kinds: 'Maps=35 MapsMP=208',
  formats: 'remake=232 standard=11',
  dat: 'plain=232 xor239=11',
  chunk: 243,
  overlayMaps: 28,
  overlayMaxTiles: 3627,
  layersMax: 3,
};

// The skirmish test set (docs/M3B-SPIKE.md 2.6) — the frozen fields are checked, the rest printed.
interface SkirmishRow {
  kind: string;
  name: string;
  format: string;
  size: string;
  players: number;
  humans?: string;
  classic?: string;
  advanced?: string;
  tactic?: boolean;
  overlay?: number;
  layered?: number;
  aiStarts?: number;
}

const SKIRMISH: SkirmishRow[] = [
  { kind: 'MapsMP', name: 'Arena', format: 'Remake r12485', size: '32x32', players: 7, humans: '0,1,2,3', tactic: true },
  { kind: 'MapsMP', name: 'Cursed Land', format: 'Remake r11222', size: '64x64', players: 4, humans: '0,1,2,3', classic: '0,1,2,3', advanced: '0,1,2,3', tactic: true },
  { kind: 'MapsMP', name: 'Cross', format: 'Remake r15122', size: '96x96', players: 4, tactic: true },
  { kind: 'MapsMP', name: 'Battle Sun', format: 'Remake r11222', size: '128x128', players: 4, tactic: false },
  { kind: 'MapsMP', name: 'Atoll', format: 'Standard', size: '96x96', players: 3, tactic: true },
  { kind: 'MapsMP', name: 'Equilibrium', format: 'Standard', size: '80x80', players: 4, tactic: true },
  { kind: 'MapsMP', name: 'Canyon', format: 'Remake r12945', size: '192x128', players: 4, overlay: 40 },
  { kind: 'MapsMP', name: 'A Way East', format: 'Remake r12485', size: '200x240', players: 12, layered: 90, aiStarts: 8 },
  { kind: 'MapsMP', name: 'Center Castle Looting', format: 'Remake r13651', size: '256x256', players: 8, overlay: 264, layered: 8747 },
];

interface Options {
  check: boolean;
  json: boolean;
  map: string | null;
}

function usage(): string {
  return (
    'usage: node tools/mapscan/cli.ts --check              (all maps: walk + frozen totals + MAPSCAN CHECK PASS/FAIL)\n' +
    '       node tools/mapscan/cli.ts --json               (the scanned MapInfo[] list)\n' +
    '       node tools/mapscan/cli.ts --map <kind>/<name>  (one map: walk + mission info)\n' +
    `env: KAM_INSTALL (default ${INSTALL})`
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, json: false, map: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--map') {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for --map\n${usage()}`);
      opts.map = argv[i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    }
  }
  return opts;
}

function formatOf(map: KaMap): string {
  return map.remake ? `Remake r${map.rev ?? 0}` : 'Standard';
}

/** ADDN+TILE chunk offset, re-derived here on purpose (cross-check of readTail in map.ts). */
function chunkOffset(map: KaMap, region: MapTileRegion, fileLength: number): number {
  const tailStart = region.start + region.length;
  if (map.remake) return tailStart;
  const resHead = map.tail.resHead;
  if (resHead === null || resHead.allocated < 0) return -1;
  const at = tailStart + 22 + 17 * resHead.allocated;
  return at + 16 <= fileLength ? at : -1;
}

interface WalkRow {
  info: MapInfo;
  format: string;
  walked: number;    // tile-region bytes the reader consumed
  overlay: number;   // tiles with a non-zero overlay
  layered: number;   // tiles with LayersCnt > 0
  layersMax: number; // the map's highest LayersCnt
  tailBytes: number;
  chunkSize: number;
  mapEdChunk: boolean;
  wordsGt255: number;
  maxTerrain: number;
  xor: boolean;
  ok: boolean;
  why: string;
}

function countIf(values: Uint8Array, predicate: (v: number) => boolean): number {
  let n = 0;
  for (const v of values) if (predicate(v)) n += 1;
  return n;
}

function walkOne(info: MapInfo): WalkRow {
  const file = readFileSync(info.mapPath);
  const { map, region } = parseMapFileBytes(file, info.mapPath);
  const tailStart = region.start + region.length;
  const at = chunkOffset(map, region, file.length);
  const chunkSize = at >= 0 ? file.readUInt32LE(at + 8) : -1;
  const mapEdChunk = at >= 0 && file.toString('latin1', at, at + 8) === 'ADDNTILE';

  // parseMapFileBytes always fills the M3b fields; the ?? keeps the optional type honest.
  const baseTerrain = map.baseTerrain ?? new Uint16Array(0);
  const overlay = map.overlay ?? new Uint8Array(0);
  const layers = map.layers ?? new Uint8Array(0);

  let wordsGt255 = 0;
  let maxTerrain = 0;
  for (const t of baseTerrain) {
    if (t > 255) wordsGt255 += 1;
    if (t > maxTerrain) maxTerrain = t;
  }
  let layersMax = 0;
  for (const v of layers) if (v > layersMax) layersMax = v;

  const problems: string[] = [];
  // The reader throws when the walk does not end at mapDataSize; this catches the standard
  // region shape (23 bytes per tile) and the tail on top of it.
  if (!map.remake && region.length !== 23 * map.mapX * map.mapY) {
    problems.push(`standard region ${region.length} != 23*X*Y (${23 * map.mapX * map.mapY})`);
  }
  if (chunkSize !== map.mapX * map.mapY) problems.push(`chunkSize ${chunkSize} != ${map.mapX * map.mapY}`);
  if (!mapEdChunk) problems.push('no ADDN+TILE chunk');
  if (!map.remake && map.tail.resHead === null) problems.push('no resource head');

  return {
    info,
    format: formatOf(map),
    walked: region.length,
    overlay: countIf(overlay, (v) => v !== 0),
    layered: countIf(layers, (v) => v > 0),
    layersMax,
    tailBytes: file.length - tailStart,
    chunkSize,
    mapEdChunk,
    wordsGt255,
    maxTerrain,
    xor: missionScriptIsXor239(readFileSync(info.datPath)),
    ok: problems.length === 0,
    why: problems.join('; '),
  };
}

function list(values: boolean[]): string {
  const on = values.map((v, i) => (v ? i : -1)).filter((i) => i >= 0);
  return on.length > 0 ? on.join(',') : '-';
}

function aiStartCount(info: MapInfo): number {
  return info.aiStart.filter((s) => s.x !== 1 || s.y !== 1).length;
}

function checkSkirmish(rows: Map<string, WalkRow>, problems: string[]): void {
  for (const row of SKIRMISH) {
    const key = `${row.kind}/${row.name}`;
    const walk = rows.get(key);
    if (walk === undefined) {
      console.log(`SKIRMISH ${key} MISSING`);
      problems.push(`skirmish ${key}: not scanned`);
      continue;
    }
    const info = walk.info;
    console.log(
      `SKIRMISH ${key} format=${walk.format} size=${info.mapX}x${info.mapY} players=${info.maxPlayers} ` +
        `humans=${list(info.canBeHuman)} classic=${list(info.classicAI)} advanced=${list(info.advancedAI)} ` +
        `tactic=${info.tactic} overlay=${walk.overlay} layered=${walk.layered} aiStart=${aiStartCount(info)}`,
    );
    const say = (label: string, actual: string | number | boolean, expected: string | number | boolean): void => {
      if (String(actual) !== String(expected)) problems.push(`skirmish ${key}.${label}: ${actual} != ${expected}`);
    };
    say('format', walk.format, row.format);
    say('size', `${info.mapX}x${info.mapY}`, row.size);
    say('players', info.maxPlayers, row.players);
    if (row.humans !== undefined) say('humans', list(info.canBeHuman), row.humans);
    if (row.classic !== undefined) say('classic', list(info.classicAI), row.classic);
    if (row.advanced !== undefined) say('advanced', list(info.advancedAI), row.advanced);
    if (row.tactic !== undefined) say('tactic', info.tactic, row.tactic);
    if (row.overlay !== undefined) say('overlay', walk.overlay, row.overlay);
    if (row.layered !== undefined) say('layered', walk.layered, row.layered);
    if (row.aiStarts !== undefined) say('aiStarts', aiStartCount(info), row.aiStarts);
  }
}

function runCheck(): void {
  const scan = scanMapFolders(ROOTS);
  const problems: string[] = [];
  const rows = new Map<string, WalkRow>();

  let anomalies = 0;
  for (const info of scan) {
    let row: WalkRow;
    try {
      row = walkOne(info);
    } catch (err) {
      anomalies += 1;
      const why = err instanceof Error ? err.message : String(err);
      console.log(`MAP ${info.kind}/${info.name} ANOMALY ${why}`);
      problems.push(`walk ${info.kind}/${info.name}: ${why}`);
      continue;
    }
    if (!row.ok) {
      anomalies += 1;
      problems.push(`walk ${info.kind}/${info.name}: ${row.why}`);
    }
    rows.set(`${info.kind}/${info.name}`, row);
    console.log(
      `MAP ${info.kind}/${info.name} ${row.info.mapX}x${row.info.mapY} ${row.format} walked=${row.walked} ` +
        `overlay=${row.overlay} layered=${row.layered} tail=${row.tailBytes} chunk=${row.chunkSize} ` +
        `${row.ok ? 'ok' : `ANOMALY ${row.why}`}`,
    );
  }

  // Totals over the walk rows.
  const kinds = ROOTS.map(({ kind }) => `${kind}=${scan.filter((m) => m.kind === kind).length}`).join(' ');
  const remake = scan.filter((m) => m.remake).length;
  const standard = scan.length - remake;
  let plain = 0;
  let xor239 = 0;
  let overlayMaps = 0;
  let overlayMaxTiles = 0;
  let overlayTiles = 0;
  let layeredTiles = 0;
  let layersMax = 0;
  let chunkOk = 0;
  let wordsGt255 = 0;
  let maxTerrain = 0;
  for (const row of rows.values()) {
    if (row.xor) xor239 += 1;
    else plain += 1;
    if (row.overlay > 0) overlayMaps += 1;
    if (row.overlay > overlayMaxTiles) overlayMaxTiles = row.overlay;
    overlayTiles += row.overlay;
    layeredTiles += row.layered;
    if (row.layersMax > layersMax) layersMax = row.layersMax;
    if (row.chunkSize === row.info.mapX * row.info.mapY) chunkOk += 1;
    wordsGt255 += row.wordsGt255;
    if (row.maxTerrain > maxTerrain) maxTerrain = row.maxTerrain;
  }

  console.log(
    `MAPSCAN maps=${scan.length} kinds(${kinds}) formats(remake=${remake} standard=${standard}) ` +
      `dat(plain=${plain} xor239=${xor239})`,
  );
  console.log(
    `MAPSCAN walk(ok=${rows.size - anomalies} anomalies=${anomalies}) chunk(ok=${chunkOk}/${scan.length}) ` +
      `overlay(maps=${overlayMaps} tiles=${overlayTiles} max=${overlayMaxTiles}) layers(max=${layersMax} tiles=${layeredTiles})`,
  );
  console.log(
    `MAPSCAN terrain(words>255=${wordsGt255} max=${maxTerrain}; tiles[] keeps the low byte, baseTerrain the full Word)`,
  );

  const say = (label: string, actual: string | number, expected: string | number): void => {
    if (String(actual) !== String(expected)) problems.push(`${label}: ${actual} != ${expected}`);
  };
  say('maps', scan.length, CHECK.maps);
  say('kinds', kinds, CHECK.kinds);
  say('formats', `remake=${remake} standard=${standard}`, CHECK.formats);
  say('dat', `plain=${plain} xor239=${xor239}`, CHECK.dat);
  say('chunk', chunkOk, CHECK.chunk);
  say('overlayMaps', overlayMaps, CHECK.overlayMaps);
  say('overlayMaxTiles', overlayMaxTiles, CHECK.overlayMaxTiles);
  say('layersMax', layersMax, CHECK.layersMax);
  say('anomalies', anomalies, 0);

  checkSkirmish(rows, problems);

  if (problems.length === 0) {
    console.log(`MAPSCAN CHECK PASS (${scan.length} maps, ${anomalies} anomalies)`);
  } else {
    console.log(`MAPSCAN CHECK FAIL:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

function runMap(target: string): void {
  const at = target.indexOf('/');
  if (at <= 0 || at === target.length - 1) throw new Error(`--map wants <kind>/<name>, got "${target}"\n${usage()}`);
  const kind = target.slice(0, at);
  const name = target.slice(at + 1);
  const info = scanMapFolders(ROOTS).find((m) => m.kind === kind && m.name === name);
  if (info === undefined) throw new Error(`map not found: ${kind}/${name}`);

  const row = walkOne(info);
  console.log(`MAP ${kind}/${name} ${info.mapX}x${info.mapY} ${row.format} ${info.valid ? 'valid' : 'invalid'}`);
  console.log(`  files map=${info.mapPath} dat=${info.datPath} txt=${info.txtPath ?? '-'}`);
  console.log(
    `  walk walked=${row.walked} tail=${row.tailBytes} chunk=${row.chunkSize} mapEdChunk=${row.mapEdChunk} ` +
      `overlay=${row.overlay} layered=${row.layered} terrain(words>255=${row.wordsGt255} max=${row.maxTerrain})`,
  );
  console.log(
    `  mission players=${info.maxPlayers} canBeHuman=${list(info.canBeHuman)} ` +
      `classic=${list(info.classicAI)} advanced=${list(info.advancedAI)} tactic=${info.tactic}`,
  );
  const starts = info.aiStart
    .map((s, i) => (s.x !== 1 || s.y !== 1 ? `${i}=(${s.x},${s.y})` : null))
    .filter((s) => s !== null);
  console.log(`  aiStart ${starts.length > 0 ? starts.join(' ') : '-'} smallDesc=${JSON.stringify(info.smallDesc)}`);
  if (!row.ok) {
    console.log(`MAPSCAN MAP FAIL: ${row.why}`);
    process.exitCode = 1;
  }
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.check && !opts.json && opts.map === null) {
    console.log(usage());
    return;
  }
  if (opts.check) runCheck();
  if (opts.map !== null) runMap(opts.map);
  if (opts.json) {
    const scan = scanMapFolders(ROOTS);
    console.log(JSON.stringify(scan, null, 2));
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
