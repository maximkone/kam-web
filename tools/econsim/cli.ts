// cli.ts — M3 econsim: headless economy slice on the real Town Tutorial village (docs/M3-SPIKE.md).
// Usage:
//   node tools/econsim/cli.ts --check        run TICKS, compare to expected.ts, ECON CHECK PASS/FAIL
//   node tools/econsim/cli.ts --ticks N      run N ticks, print the event log + summary
//   node tools/econsim/cli.ts --json         print the JSON summary
//   node tools/econsim/cli.ts --no-scenario  skip applyDemoScenario
//
// Reads the map/mission/defines from the frozen r15472 install (read-only). Data paths can be
// overridden with KAM_MAP, KAM_DATA (the defines directory) and KAM_MISSION.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseMapFile } from '../../packages/map/mapfile.ts';
import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat, parseSerfCarry } from '../../packages/assets/unitdat.ts';
import { parseHousesDat } from '../../packages/assets/housedata.ts';
import { parseMissionScript } from '../../packages/mission/mission.ts';
import { createEconomyWorld, applyDemoScenario, CHOPABLE_TREES, TREE_AGE_FULL } from '../../packages/sim/economy.ts';
import type { EconomyWorld, SimEvent } from '../../packages/sim/economy.ts';
import { WARE_CNT } from '../../packages/assets/wares.ts';
import { TICKS, EXPECTED } from './expected.ts';

const MAP_PATH =
  process.env.KAM_MAP ?? 'C:/Users/me/Desktop/KaM Remake/Tutorials/Town Tutorial/Town Tutorial.map';
const DEFINES_DIR =
  process.env.KAM_DATA ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472/data/defines';
const MISSION_PATH =
  process.env.KAM_MISSION ?? 'C:/Users/me/Desktop/KaM Remake/Tutorials/Town Tutorial/Town Tutorial.dat';

interface Options {
  check: boolean;
  ticks: number | null;
  json: boolean;
  noScenario: boolean;
}

function usage(): string {
  return (
    'usage: node tools/econsim/cli.ts --check        (run ' +
    `${TICKS} ticks, compare to expected.ts, ECON CHECK PASS/FAIL)\n` +
    '       node tools/econsim/cli.ts --ticks N      (run N ticks, event log + summary)\n' +
    '       node tools/econsim/cli.ts --json         (JSON summary)\n' +
    '       node tools/econsim/cli.ts --no-scenario  (skip applyDemoScenario)\n' +
    'env: KAM_MAP, KAM_DATA (defines dir), KAM_MISSION'
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, ticks: null, json: false, noScenario: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--ticks') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--ticks needs a positive integer, got "${argv[i + 1]}"`);
      opts.ticks = n;
      i += 1;
    } else if (arg === '--json') opts.json = true;
    else if (arg === '--no-scenario') opts.noScenario = true;
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

interface LoadSummary {
  map: string;
  mapSize: string;
  hands: number;
  houses: number;
  streets: number;
  roadTiles: number;
  units: number;
  animals: number;
  walkable: number;
  treesFull: number;
  storeTrunks: number;
  storeTimber: number;
  scenario: boolean;
}

function loadSummary(
  w: EconomyWorld,
  mapName: string,
  missionUnits: number,
  missionAnimals: number,
  missionStreets: number,
  scenario: boolean,
): LoadSummary {
  let walkable = 0;
  for (let y = 1; y <= w.grid.mapY - 1; y++) {
    for (let x = 1; x <= w.grid.mapX - 1; x++) {
      if (w.grid.walk[y * (w.grid.mapX + 1) + x] === 1) walkable += 1;
    }
  }
  let treesFull = 0;
  for (let y = 1; y <= w.grid.mapY - 1; y++) {
    for (let x = 1; x <= w.grid.mapX - 1; x++) {
      const at = w.treeAt(x, y);
      if (at === null) continue;
      let full = false;
      for (const t of CHOPABLE_TREES) if (t[3] === at.obj) full = true;
      if (full && at.age >= TREE_AGE_FULL) treesFull += 1;
    }
  }
  const store = w.findFirstHouse(11, 1);
  return {
    map: mapName,
    mapSize: `${w.grid.mapX}x${w.grid.mapY}`,
    hands: w.handCount,
    houses: w.houses.length,
    streets: missionStreets,
    roadTiles: w.roadTileCount,
    units: missionUnits,
    animals: missionAnimals,
    walkable,
    treesFull,
    storeTrunks: store !== null ? w.wareCount(store, 0) : -1,
    storeTimber: store !== null ? w.wareCount(store, 2) : -1,
    scenario,
  };
}

function eventTotals(events: SimEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    const kind = e.text.split(' ')[0];
    out[kind] = (out[kind] ?? 0) + 1;
  }
  // Sorted keys so the JSON comparison against expected.ts is order-insensitive.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A canonical, order-stable serialization of the observable world state, sha256'd. */
function stateSha(w: EconomyWorld): string {
  const houses = w.houses.map((h) => ({
    uid: h.uid,
    typeId: h.typeId,
    owner: h.owner,
    x: h.x,
    y: h.y,
    entrance: [h.entrance.x, h.entrance.y],
    state: h.state,
    wareIn: h.wareIn.slice(),
    wareOut: h.wareOut.slice(),
    workerUid: h.workerUid,
    animStep: h.animStep,
    workAnimStep: h.workAnimStep,
    wares: Array.from({ length: WARE_CNT }, (_, i) => w.wareCount(h, i)),
  }));
  const units = w.units.map((u) => ({
    uid: u.uid,
    owner: u.owner,
    type: u.type,
    pos: [u.posF.x, u.posF.y],
    dir: u.dir,
    animStep: u.animStep,
    action: u.action,
    carry: u.carry,
    inside: u.inside,
    homeUid: u.homeUid,
    taskKind: u.taskKind,
  }));
  const trees: number[][] = [];
  for (let y = 1; y <= w.grid.mapY - 1; y++) {
    for (let x = 1; x <= w.grid.mapX - 1; x++) {
      const at = w.treeAt(x, y);
      if (at !== null) trees.push([x, y, at.obj, at.age]);
    }
  }
  const canonical = JSON.stringify({
    tick: w.tickCount,
    rngState: w.rngState,
    roadTiles: w.roadTileCount,
    houses,
    units,
    trees,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

interface FinalCounts {
  trunksProduced: number;
  trunksTaken: number;
  timberProduced: number;
  treesFelled: number;
  deliveriesAssigned: number;
  wareDelivered: number;
  timberDelivered: number;
  workersAssigned: number;
  chopPlans: number;
  storeTimber: number;
  sawmillTimber: number;
  hutTrunks: number;
  rngState: number;
}

function finalCounts(w: EconomyWorld): FinalCounts {
  const totals = eventTotals(w.events);
  const timberDelivered = w.events.filter((e) => e.text.startsWith('ware-delivered') && e.text.includes('ware=2')).length;
  const store = w.findFirstHouse(11, 1);
  const sawmill = w.findFirstHouse(0, 1);
  const hut = w.findFirstHouse(9, 1);
  return {
    trunksProduced: totals['trunk-out'] ?? 0,
    trunksTaken: totals['trunk-taken'] ?? 0,
    timberProduced: totals['timber-out'] ?? 0,
    treesFelled: totals['tree-fell'] ?? 0,
    deliveriesAssigned: totals['delivery-assigned'] ?? 0,
    wareDelivered: totals['ware-delivered'] ?? 0,
    timberDelivered,
    workersAssigned: totals['worker-assigned'] ?? 0,
    chopPlans: totals['chop-plan'] ?? 0,
    storeTimber: store !== null ? w.wareCount(store, 2) : -1,
    sawmillTimber: sawmill !== null ? w.wareCount(sawmill, 2) : -1,
    hutTrunks: hut !== null ? w.wareCount(hut, 0) : -1,
    rngState: w.rngState,
  };
}

function buildWorld(noScenario: boolean): { world: EconomyWorld; summary: LoadSummary } {
  const map = parseMapFile(MAP_PATH);
  const tiles = parseTilesJson(readDefine('tiles.json').toString('utf8'));
  const elems = parseMapElem(readDefine('mapelem.dat'));
  const unitBuf = readDefine('unit.dat');
  const unitSpecs = parseUnitDat(unitBuf);
  const serfCarry = parseSerfCarry(unitBuf);
  const houseSpecs = parseHousesDat(readDefine('houses.dat'));
  const mission = parseMissionScript(readFileSync(MISSION_PATH), map.mapX, map.mapY);

  const world = createEconomyWorld({ map, tiles, elems, unitSpecs, serfCarry, houseSpecs, mission });
  if (!noScenario) applyDemoScenario(world);

  const humans = mission.units.filter((u) => u.owner >= 0).length;
  const animals = mission.units.length - humans;
  const summary = loadSummary(world, map.file, humans, animals, mission.streets.length, !noScenario);
  return { world, summary };
}

function compare(label: string, actual: unknown, expected: unknown, problems: string[]): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) problems.push(`${label}: ${a} != expected ${b}`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.check && opts.ticks === null && !opts.json) {
    console.log(usage());
    return;
  }

  const { world, summary } = buildWorld(opts.noScenario);
  console.log(
    `ECONSIM ${summary.map} ${summary.mapSize} hands=${summary.hands} houses=${summary.houses} ` +
      `streets=${summary.streets} roadTiles=${summary.roadTiles} units=${summary.units} animals=${summary.animals} ` +
      `walkable=${summary.walkable} treesFull=${summary.treesFull} scenario=${summary.scenario ? 'on' : 'off'}`,
  );

  const ticks = opts.check || (opts.json && opts.ticks === null) ? TICKS : opts.ticks ?? 0;
  const start = Date.now();
  for (let i = 0; i < ticks; i++) world.tick();
  const elapsed = Date.now() - start;

  const totals = eventTotals(world.events);
  const finals = finalCounts(world);
  const sha = stateSha(world);

  if (opts.json) {
    console.log(
      JSON.stringify(
        { load: summary, ticks: world.tickCount, events: totals, final: finals, sha256: sha, elapsedMs: elapsed },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.ticks !== null && !opts.check) {
    for (const e of world.events) console.log(`EVENT t=${e.tick} ${e.text}`);
    console.log(
      `TICKS ${world.tickCount} events=${world.events.length} ` +
        `trunks=${finals.trunksProduced} timber=${finals.timberProduced} felled=${finals.treesFelled} ` +
        `delivered=${finals.wareDelivered} storeTimber=${finals.storeTimber} rngState=${world.rngState} sha256=${sha}`,
    );
    return;
  }

  // --check: compare the frozen numbers.
  console.log(`EVENTS ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(
    `FINAL trunks=${finals.trunksProduced} trunksTaken=${finals.trunksTaken} timber=${finals.timberProduced} ` +
      `felled=${finals.treesFelled} deliveries=${finals.deliveriesAssigned} delivered=${finals.wareDelivered} ` +
      `timberDelivered=${finals.timberDelivered} workers=${finals.workersAssigned} chopPlans=${finals.chopPlans} ` +
      `storeTimber=${finals.storeTimber} sawmillTimber=${finals.sawmillTimber} hutTrunks=${finals.hutTrunks} rngState=${finals.rngState}`,
  );
  console.log(`SHA256 ${sha}`);

  const problems: string[] = [];
  compare('load', summary, EXPECTED.load, problems);
  compare('events', totals, EXPECTED.events, problems);
  compare('final', finals, EXPECTED.final, problems);
  compare('sha256', sha, EXPECTED.sha256, problems);

  if (problems.length === 0) {
    console.log(`ECON CHECK PASS (${world.tickCount} ticks, ${world.events.length} events, ${elapsed} ms)`);
  } else {
    console.log(`ECON CHECK FAIL:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
