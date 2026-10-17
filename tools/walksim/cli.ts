// cli.ts — M2b walksim: data cross-checks + the frozen route table (docs/M2B-SPIKE.md 4, 7).
// Usage:
//   node tools/walksim/cli.ts --check   data cross-checks + route table + WALK CHECK PASS/FAIL
//   node tools/walksim/cli.ts --routes  print the route table only
//
// Reads the map via packages/map/map.ts and the defines from the frozen r15472 install (read-only).
import { readFileSync } from 'node:fs';
import { parseMapFile } from '../../packages/map/mapfile.ts';
import type { KaMap } from '../../packages/map/map.ts';
import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import type { TileFlags } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import type { MapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat } from '../../packages/assets/unitdat.ts';
import type { UnitSpec } from '../../packages/assets/unitdat.ts';
import { buildPassGrid, canWalkDiagonal, tileWalkable } from '../../packages/sim/terrain.ts';
import type { PassGrid } from '../../packages/sim/terrain.ts';
import { findPath } from '../../packages/sim/astar.ts';
import { startWalk, walkSpeeds, walkTick } from '../../packages/sim/walk.ts';
import { Sim, demoSpawns } from '../../packages/sim/sim.ts';

// Frozen installs (docs/M2B-SPIKE.md 2.8), read-only.
const MAP_PATH = 'C:/Users/me/Desktop/KaM Remake/Tutorials/Town Tutorial/Town Tutorial.map';
const DEFINES_DIR = 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472/data/defines';

// unit.dat layout offsets re-derived here on purpose (cross-check of packages/assets/unitdat.ts):
// 15680 serfCarry + 41 records × 7898, legacy Speed at +10 (KM_ResUnits.pas 686–711).
const SERF_CARRY_SIZE = 15680;
const RECORD_SIZE = 7898;

const CHECK = {
  mapSize: '128x128',
  walkableTiles: 11883,
  unitDatSize: 339498,
  unitDatRecords: 41,
  speeds: 'Serf=24 Militia=24 Scout=40 Knight=40 Vagabond=40 Wolf=39',
  mountedPatch: 'raw 21=39 22=39 27=39 -> 40,40,40; Wolf raw 39 -> 39',
  mapElemSize: 25146,
  mapElemRecords: 254,
  mapElemEntries: 256,
  tilesCount: 597,
  tilesWalkable: 'id0=true id192=false id209=false id187=false',
  demoSpawns: '[{"type":0,"x":64,"y":64},{"type":14,"x":63,"y":63},{"type":22,"x":64,"y":63}]',
};

interface Pt {
  x: number;
  y: number;
}

interface WalkRow {
  kind: 'walk';
  name: string;
  from: Pt;
  to: Pt;
  unit: number; // unit.dat record (0 = Serf, speed 24)
  steps: number;
  ortho: number;
  diag: number;
  cost: number;
  moves: number; // walkTick ticks with AnimStep++ (direct loop)
  simTicks: number; // ticks from orderWalk issue to action 'stay' again
  dir: number; // final KMGetDirection bucket (1..8)
}

interface BlockedRow {
  kind: 'blocked';
  name: string;
  from: Pt;
  to: Pt;
  terrain: number; // terrain id at the target (tiles.json says not walkable)
}

type RouteRow = WalkRow | BlockedRow;

// Frozen route table (worker C freeze; the lead copies these numbers into §7).
const ROUTES: RouteRow[] = [
  {
    kind: 'walk', name: 'long-water', from: { x: 64, y: 63 }, to: { x: 32, y: 120 }, unit: 0,
    steps: 82, ortho: 75, diag: 7, cost: 848, moves: 848, simTicks: 850, dir: 5,
  },
  { kind: 'blocked', name: 'blocked-target', from: { x: 64, y: 63 }, to: { x: 89, y: 25 }, terrain: 187 },
  {
    kind: 'walk', name: 'forced-diagonal', from: { x: 114, y: 64 }, to: { x: 115, y: 65 }, unit: 0,
    steps: 1, ortho: 0, diag: 1, cost: 14, moves: 14, simTicks: 16, dir: 4,
  },
  {
    kind: 'walk', name: 'equal-length-metric', from: { x: 32, y: 40 }, to: { x: 34, y: 40 }, unit: 0,
    steps: 2, ortho: 2, diag: 0, cost: 20, moves: 20, simTicks: 22, dir: 3,
  },
  {
    kind: 'walk', name: 'diag-shortcut', from: { x: 20, y: 20 }, to: { x: 22, y: 22 }, unit: 0,
    steps: 2, ortho: 0, diag: 2, cost: 28, moves: 28, simTicks: 30, dir: 4,
  },
];

function usage(): string {
  return (
    'usage: node tools/walksim/cli.ts --check   (data cross-checks + route table + WALK CHECK PASS/FAIL)\n' +
    '       node tools/walksim/cli.ts --routes  (route table only)'
  );
}

interface Options {
  check: boolean;
  routes: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, routes: false };
  for (const arg of argv) {
    if (arg === '--check') opts.check = true;
    else if (arg === '--routes') opts.routes = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    }
  }
  return opts;
}

function readDefine(name: string): Buffer {
  const path = `${DEFINES_DIR}/${name}`;
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`defines: ${path}: cannot read file (${err instanceof Error ? err.message : String(err)})`);
  }
}

function pt(p: Pt): string {
  return `(${p.x},${p.y})`;
}

function countWalkable(g: PassGrid): number {
  let n = 0;
  for (let y = 1; y <= g.mapY - 1; y++) {
    for (let x = 1; x <= g.mapX - 1; x++) {
      if (tileWalkable(g, x, y)) n += 1;
    }
  }
  return n;
}

function stats(route: Pt[]): { steps: number; ortho: number; diag: number; cost: number } {
  let ortho = 0;
  let diag = 0;
  for (let i = 1; i < route.length; i++) {
    const dx = Math.abs(route[i].x - route[i - 1].x);
    const dy = Math.abs(route[i].y - route[i - 1].y);
    if (dx === 1 && dy === 1) diag += 1;
    else ortho += 1;
  }
  return { steps: route.length - 1, ortho, diag, cost: ortho * 10 + diag * 14 };
}

/** Direct startWalk + walkTick loop: ticks to status 'done', moved ticks, last direction. */
function directWalk(g: PassGrid, spec: UnitSpec, from: Pt, to: Pt): { ticks: number; moves: number; dir: number; end: Pt } {
  const w = startWalk(g, from, to);
  if (w === null) throw new Error(`directWalk: no route ${pt(from)} -> ${pt(to)}`);
  const posF = { x: from.x, y: from.y };
  const speed = walkSpeeds(spec.speedRaw);
  let ticks = 0;
  let moves = 0;
  let dir = 0;
  for (;;) {
    const r = walkTick(g, w, posF, speed);
    ticks += 1;
    moves += r.animStep;
    if (r.dir !== 0) dir = r.dir;
    if (r.status !== 'walking') break;
    if (ticks > 100000) throw new Error('directWalk: walkTick did not finish');
  }
  return { ticks, moves, dir, end: { x: posF.x, y: posF.y } };
}

/** Sim path: orderWalk on tick 1 (applies at its end), then walk ticks until the action clears. */
function simWalk(
  g: PassGrid,
  units: UnitSpec[],
  type: number,
  from: Pt,
  to: Pt,
): { ok: boolean; ticks: number; dir: number; animStep: number; end: Pt } {
  const sim = new Sim(g, units);
  const u = sim.addUnit(type, from.x, from.y);
  const ok = sim.orderWalk(u.uid, to.x, to.y);
  let ticks = 0;
  sim.tick(); // the queued order executes at the end of this tick
  ticks += 1;
  while (ticks < 100000 && u.action === 'walk') {
    sim.tick();
    ticks += 1;
  }
  return { ok, ticks, dir: u.dir, animStep: u.animStep, end: { x: u.posF.x, y: u.posF.y } };
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.check && !opts.routes) {
    console.log(usage());
    return;
  }

  const map = parseMapFile(MAP_PATH);
  const tiles = parseTilesJson(readDefine('tiles.json').toString('utf8'));
  const elemsBuf = readDefine('mapelem.dat');
  const elems = parseMapElem(elemsBuf);
  const unitBuf = readDefine('unit.dat');
  const units = parseUnitDat(unitBuf);
  const g = buildPassGrid(map, tiles, elems);

  console.log(`WALKSIM ${map.file} ${map.mapX}x${map.mapY} walkable=${countWalkable(g)}`);

  const problems: string[] = [];
  const check = (label: string, actual: string | number | boolean, expected: string | number | boolean, printOk: boolean): void => {
    const ok = String(actual) === String(expected);
    if (ok) {
      if (printOk) console.log(`CHECK ${label}=${actual}`);
    } else {
      console.log(`CHECK ${label}=${actual} (expected ${expected})`);
      problems.push(`${label}=${actual}, expected ${expected}`);
    }
  };

  if (opts.check) dataChecks(g, map, tiles, elems, elemsBuf, unitBuf, units, check);

  routeChecks(g, map, units, opts.check, check);

  if (opts.check) {
    if (problems.length === 0) {
      console.log('WALK CHECK PASS');
    } else {
      console.log(`WALK CHECK FAIL: ${problems.join('; ')}`);
      process.exitCode = 1;
    }
  }
}

type CheckFn = (label: string, actual: string | number | boolean, expected: string | number | boolean, printOk: boolean) => void;

function dataChecks(
  g: PassGrid,
  map: KaMap,
  tiles: TileFlags[],
  elems: MapElem[],
  elemsBuf: Buffer,
  unitBuf: Buffer,
  units: UnitSpec[],
  check: CheckFn,
): void {
  check('map.size', `${map.mapX}x${map.mapY}`, CHECK.mapSize, true);
  check('walkableTiles', countWalkable(g), CHECK.walkableTiles, true);

  check('unit.dat.size', unitBuf.length, CHECK.unitDatSize, true);
  check('unit.dat.records', units.length, CHECK.unitDatRecords, true);
  const names: [number, string][] = [[0, 'Serf'], [14, 'Militia'], [21, 'Scout'], [22, 'Knight'], [27, 'Vagabond'], [30, 'Wolf']];
  check('unit.dat.speeds', names.map(([i, n]) => `${n}=${units[i].speedRaw}`).join(' '), CHECK.speeds, true);
  const rawSpeed = (i: number): number => unitBuf.readInt16LE(SERF_CARRY_SIZE + i * RECORD_SIZE + 10);
  const patched = `${units[21].speedRaw},${units[22].speedRaw},${units[27].speedRaw}`;
  check(
    'unit.dat.mountedPatch',
    `raw 21=${rawSpeed(21)} 22=${rawSpeed(22)} 27=${rawSpeed(27)} -> ${patched}; Wolf raw ${rawSpeed(30)} -> ${units[30].speedRaw}`,
    CHECK.mountedPatch,
    true,
  );

  check('mapelem.dat.size', elemsBuf.length, CHECK.mapElemSize, true);
  check('mapelem.dat.records', elemsBuf.length / 99, CHECK.mapElemRecords, true);
  check('mapelem.entries', elems.length, CHECK.mapElemEntries, true);
  check('mapelem[61].allBlocked', elems[61].allBlocked, true, true);
  check(
    'mapelem[63]',
    `stump=${elems[63].stump} canBeRemoved=${elems[63].canBeRemoved} allBlocked=${elems[63].allBlocked}`,
    'stump=-1 canBeRemoved=true allBlocked=false',
    true,
  );
  check(
    'mapelem[255]',
    `allBlocked=${elems[255].allBlocked} diagonalBlocked=${elems[255].diagonalBlocked} canBeRemoved=${elems[255].canBeRemoved} stump=${elems[255].stump}`,
    'allBlocked=false diagonalBlocked=false canBeRemoved=false stump=0',
    true,
  );

  check('tiles.json.count', tiles.length, CHECK.tilesCount, true);
  check(
    'tiles.json.walkable',
    `id0=${tiles[0].walkable} id192=${tiles[192].walkable} id209=${tiles[209].walkable} id187=${tiles[187].walkable}`,
    CHECK.tilesWalkable,
    true,
  );

  check('demoSpawns', JSON.stringify(demoSpawns(g)), CHECK.demoSpawns, true);
}

function routeChecks(g: PassGrid, map: KaMap, units: UnitSpec[], verbose: boolean, check: CheckFn): void {
  for (const row of ROUTES) {
    if (row.kind === 'blocked') {
      const rec = (row.to.y - 1) * map.mapX + (row.to.x - 1);
      const terrain = map.tiles[rec * 4];
      const path = findPath(g, row.from, row.to);
      console.log(
        `ROUTE ${row.name} ${pt(row.from)}->${pt(row.to)} blocked=true terrain=${terrain} ` +
          `walkable=${tileWalkable(g, row.to.x, row.to.y)} path=${path === null ? 'null' : 'FOUND'}`,
      );
      check(`${row.name}.terrain`, terrain, row.terrain, false);
      check(`${row.name}.walkable`, tileWalkable(g, row.to.x, row.to.y), false, false);
      check(`${row.name}.path`, path === null ? 'null' : 'found', 'null', false);
      continue;
    }

    const route = findPath(g, row.from, row.to);
    if (route === null) {
      console.log(`ROUTE ${row.name} ${pt(row.from)}->${pt(row.to)} path=null`);
      check(`${row.name}.path`, 'null', 'route', false);
      continue;
    }
    const st = stats(route);
    const direct = directWalk(g, units[row.unit], row.from, row.to);
    const sim = simWalk(g, units, row.unit, row.from, row.to);
    console.log(
      `ROUTE ${row.name} ${pt(row.from)}->${pt(row.to)} unit=${row.unit} steps=${st.steps} ortho=${st.ortho} ` +
        `diag=${st.diag} cost=${st.cost} moves=${direct.moves} directTicks=${direct.ticks} simTicks=${sim.ticks} ` +
        `dir=${sim.dir} end=${pt(sim.end)}`,
    );
    check(`${row.name}.steps`, st.steps, row.steps, false);
    check(`${row.name}.ortho`, st.ortho, row.ortho, false);
    check(`${row.name}.diag`, st.diag, row.diag, false);
    check(`${row.name}.cost`, st.cost, row.cost, false);
    check(`${row.name}.moves`, direct.moves, row.moves, false);
    check(`${row.name}.directTicks`, direct.ticks, row.moves + 1, false);
    check(`${row.name}.simTicks`, sim.ticks, row.simTicks, false);
    check(`${row.name}.dir`, sim.dir, row.dir, false);
    check(`${row.name}.directDir`, direct.dir, row.dir, false);
    check(`${row.name}.end`, pt(sim.end), pt(row.to), false);
    check(`${row.name}.animStep`, sim.animStep, row.moves, false);
    check(`${row.name}.orderOk`, sim.ok, true, false);
  }

  // long-water: the straight line between the two tiles crosses unwalkable terrain (the 82-step
  // route detours around it); sampled every ~1/200 of the segment.
  let blockedSamples = 0;
  for (let i = 0; i <= 200; i++) {
    const x = Math.round(64 + ((32 - 64) * i) / 200);
    const y = Math.round(63 + ((120 - 63) * i) / 200);
    if (!tileWalkable(g, x, y)) blockedSamples += 1;
  }
  check('long-water.straightLine', blockedSamples > 0 ? 'blocked' : 'open', 'blocked', verbose);

  // forced-diagonal: the ortho corners are unwalkable, so the route must use the diagonal.
  const cornerA = tileWalkable(g, 115, 64);
  const cornerB = tileWalkable(g, 114, 65);
  const diagOk = canWalkDiagonal(g, { x: 114, y: 64 }, 115, 65);
  check(
    'forced-diagonal.orthoCorners',
    `(115,64)=${cornerA ? 'walkable' : 'blocked'} (114,65)=${cornerB ? 'walkable' : 'blocked'} diagAllowed=${diagOk}`,
    '(115,64)=blocked (114,65)=blocked diagAllowed=true',
    verbose,
  );

  // equal-length-metric: a second 2-step route exists via (33,39) at cost 28; the 10/14 metric
  // picks the orthogonal one (cost 20).
  const alt1 = findPath(g, { x: 32, y: 40 }, { x: 33, y: 39 });
  const alt2 = findPath(g, { x: 33, y: 39 }, { x: 34, y: 40 });
  const altCost = alt1 !== null && alt2 !== null ? stats(alt1).cost + stats(alt2).cost : -1;
  const altSteps = alt1 !== null && alt2 !== null ? stats(alt1).steps + stats(alt2).steps : -1;
  check(
    'equal-length-metric.altRoute',
    `via (33,39) steps=${altSteps} cost=${altCost}`,
    'via (33,39) steps=2 cost=28',
    verbose,
  );
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
