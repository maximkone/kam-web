// cli.ts — M5a buildsim: the deterministic scripted build on the Town Tutorial (docs/M5-SPIKE.md
// §6.1): place a hut plan for hand 1, let a builder dig the site, let the store's serfs deliver
// timber + stone (dkToConstruction), let the builders raise it through wood → stone → done and
// Activate it; also build a road (with the stone wait, dkToUnit) and a corn field.
// Usage:
//   node tools/buildsim/cli.ts --check        run TICKS, compare to expected.ts, BUILD CHECK PASS/FAIL
//   node tools/buildsim/cli.ts --ticks N      run N ticks, print the event log + summary
//   node tools/buildsim/cli.ts --json         print the JSON summary
//
// Reads the map/mission/defines from the frozen r15472 install (read-only). Data paths can be
// overridden with KAM_MAP, KAM_DATA (the defines directory) and KAM_MISSION (like econsim), or with
// --map/--mission. The scripted sites are the frozen tutorial locations; on another map the CLI
// fails loudly (canAddHousePlan/canAddFieldPlan) instead of silently building elsewhere.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseMapFile } from '../../packages/map/map.ts';
import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat, parseSerfCarry } from '../../packages/assets/unitdat.ts';
import { parseHousesDat } from '../../packages/assets/housedata.ts';
import { parseMissionScript } from '../../packages/mission/mission.ts';
import { createEconomyWorld, UNIT_BUILDER } from '../../packages/sim/economy.ts';
import type { EconomyWorld, SimEvent } from '../../packages/sim/economy.ts';
import { WARE_CNT } from '../../packages/assets/wares.ts';
import { TICKS, SCENARIO, EXPECTED } from './expected.ts';

const DEFAULT_MAP = 'C:/Users/me/Desktop/KaM Remake/Tutorials/Town Tutorial/Town Tutorial.map';
const DEFAULT_DEFINES = 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472/data/defines';
const DEFAULT_MISSION = 'C:/Users/me/Desktop/KaM Remake/Tutorials/Town Tutorial/Town Tutorial.dat';

interface Options {
  check: boolean;
  ticks: number | null;
  json: boolean;
  map: string;
  mission: string;
}

function usage(): string {
  return (
    'usage: node tools/buildsim/cli.ts --check        (run ' +
    `${TICKS} ticks, compare to expected.ts, BUILD CHECK PASS/FAIL)\n` +
    '       node tools/buildsim/cli.ts --ticks N      (run N ticks, event log + summary)\n' +
    '       node tools/buildsim/cli.ts --json         (JSON summary)\n' +
    '       node tools/buildsim/cli.ts --map <path>   (override the map; --mission <path>)\n' +
    'env: KAM_MAP, KAM_DATA (defines dir), KAM_MISSION'
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    check: false,
    ticks: null,
    json: false,
    map: process.env.KAM_MAP ?? DEFAULT_MAP,
    mission: process.env.KAM_MISSION ?? DEFAULT_MISSION,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--ticks') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--ticks needs a positive integer, got "${argv[i + 1]}"`);
      opts.ticks = n;
      i += 1;
    } else if (arg === '--json') opts.json = true;
    else if (arg === '--map') {
      opts.map = argv[i + 1];
      i += 1;
    } else if (arg === '--mission') {
      opts.mission = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    }
  }
  return opts;
}

function readDefine(name: string): Buffer {
  const definesDir = process.env.KAM_DATA ?? DEFAULT_DEFINES;
  const path = `${definesDir}/${name}`;
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
  builders: number;
  storeTimber: number;
  storeStone: number;
}

function loadSummary(w: EconomyWorld, mapName: string, missionStreets: number): LoadSummary {
  const store = w.findFirstHouse(11, SCENARIO.hand);
  return {
    map: mapName,
    mapSize: `${w.grid.mapX}x${w.grid.mapY}`,
    hands: w.handCount,
    houses: w.houses.length,
    streets: missionStreets,
    roadTiles: w.roadTileCount,
    units: w.units.length,
    builders: w.units.filter((u) => u.type === UNIT_BUILDER && u.owner === SCENARIO.hand).length,
    storeTimber: store !== null ? w.wareCount(store, 2) : -1,
    storeStone: store !== null ? w.wareCount(store, 1) : -1,
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
  const hand = SCENARIO.hand;
  const state = w.constructionState(hand);
  const houses = w.houses.map((h) => ({
    uid: h.uid,
    typeId: h.typeId,
    owner: h.owner,
    x: h.x,
    y: h.y,
    entrance: [h.entrance.x, h.entrance.y],
    state: h.state,
    buildState: h.buildState,
    buildingProgress: h.buildingProgress,
    buildSupplyWood: h.buildSupplyWood,
    buildSupplyStone: h.buildSupplyStone,
    buildReserve: h.buildReserve,
    readyToBeBuilt: h.readyToBeBuilt,
    wareIn: h.wareIn.slice(),
    wareOut: h.wareOut.slice(),
    workerUid: h.workerUid,
    animStep: h.animStep,
    workAnimStep: h.workAnimStep,
    damage: h.damage,
    destroyed: h.destroyed,
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
  const corn: number[][] = [];
  const road: number[][] = [];
  for (let y = 1; y <= w.grid.mapY - 1; y++) {
    for (let x = 1; x <= w.grid.mapX - 1; x++) {
      const at = w.treeAt(x, y);
      if (at !== null) trees.push([x, y, at.obj, at.age]);
      if (w.tileHasCornField(x, y)) corn.push([x, y]);
      if (w.tileHasRoad(x, y)) road.push([x, y]);
    }
  }
  const canonical = JSON.stringify({
    tick: w.tickCount,
    rngState: w.rngState,
    roadTiles: w.roadTileCount,
    plans: state.plans.map((p) => [p.uid, p.typeId, p.x, p.y, p.status, p.workerUid]),
    fields: state.fields.map((f) => [f.x, f.y, f.fieldType, f.status, f.workerUid]),
    sites: state.sites.map((s) => [s.houseUid, s.assigned]),
    workers: state.workers.slice().sort((a, b) => a - b),
    locks: state.locks.unlocked.map((u, i) => (u ? i : -1)).filter((i) => i >= 0),
    houses,
    units,
    trees,
    corn,
    road,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

interface FinalCounts {
  hutState: string;
  hutProgress: number;
  hutWood: number;
  hutStone: number;
  hutReserve: number;
  hutReady: boolean;
  hutWoodDelivered: number;
  hutStoneDelivered: number;
  hutHealth: number;
  houseWip: number;
  housePlanDigged: number;
  houseActivated: number;
  buildSupply: number;
  buildHouseAssigned: number;
  roadDigged: number;
  roadBuilt: number;
  fieldBuilt: number;
  doorRoad: boolean;
  roadAtSite: boolean;
  cornField: boolean;
  siteCount: number;
  planCount: number;
  fieldPlanCount: number;
  unitDelivered: number;
  sawmillUnlocked: boolean;
  storeUnlocked: boolean;
  barracksUnlocked: boolean;
  rngState: number;
}

function finalCounts(w: EconomyWorld): FinalCounts {
  const totals = eventTotals(w.events);
  const hand = SCENARIO.hand;
  const state = w.constructionState(hand);
  const hut = w.houses.find(
    (h) => h.typeId === SCENARIO.houseType && h.owner === hand && h.x === SCENARIO.loc.x && h.y === SCENARIO.loc.y,
  );
  return {
    hutState: hut !== undefined ? hut.buildState : 'none',
    hutProgress: hut !== undefined ? hut.buildingProgress : -1,
    hutWood: hut !== undefined ? hut.buildSupplyWood : -1,
    hutStone: hut !== undefined ? hut.buildSupplyStone : -1,
    hutReserve: hut !== undefined ? hut.buildReserve : -1,
    hutReady: hut !== undefined ? hut.readyToBeBuilt : false,
    hutWoodDelivered: hut !== undefined ? w.houseBuildWoodDelivered(hut) : -1,
    hutStoneDelivered: hut !== undefined ? w.houseBuildStoneDelivered(hut) : -1,
    hutHealth: hut !== undefined ? w.houseHealth(hut) : -1,
    houseWip: totals['house-wip'] ?? 0,
    housePlanDigged: totals['house-plan-digged'] ?? 0,
    houseActivated: totals['house-activated'] ?? 0,
    buildSupply: totals['build-supply'] ?? 0,
    buildHouseAssigned: totals['build-house-assigned'] ?? 0,
    roadDigged: totals['road-digged'] ?? 0,
    roadBuilt: totals['road-built'] ?? 0,
    fieldBuilt: totals['field-built'] ?? 0,
    doorRoad: w.isRoadTile(SCENARIO.loc.x, SCENARIO.loc.y),
    roadAtSite: w.isRoadTile(SCENARIO.road.x, SCENARIO.road.y),
    cornField: w.tileHasCornField(SCENARIO.corn.x, SCENARIO.corn.y),
    siteCount: state.sites.filter((s) => s.houseUid !== 0).length,
    planCount: state.plans.filter((p) => p.status !== 'empty').length,
    fieldPlanCount: state.fields.filter((f) => f.status !== 'empty').length,
    unitDelivered: w.events.filter((e) => e.text.startsWith('ware-delivered') && e.text.includes('unit#')).length,
    sawmillUnlocked: w.houseCanBuild(hand, 0), // script 0 = htSawmill (released by the hut)
    storeUnlocked: w.houseCanBuild(hand, 11), // script 11 = htStore (released at the start)
    barracksUnlocked: w.houseCanBuild(hand, 21), // script 21 = htBarracks (needs a sawmill)
    rngState: w.rngState,
  };
}

function buildWorld(opts: Options): { world: EconomyWorld; mapName: string; streets: number } {
  const map = parseMapFile(opts.map);
  const tiles = parseTilesJson(readDefine('tiles.json').toString('utf8'));
  const elems = parseMapElem(readDefine('mapelem.dat'));
  const unitBuf = readDefine('unit.dat');
  const unitSpecs = parseUnitDat(unitBuf);
  const serfCarry = parseSerfCarry(unitBuf);
  const houseSpecs = parseHousesDat(readDefine('houses.dat'));
  const mission = parseMissionScript(readFileSync(opts.mission), map.mapX, map.mapY);
  const world = createEconomyWorld({ map, tiles, elems, unitSpecs, serfCarry, houseSpecs, mission });
  return { world, mapName: map.file, streets: mission.streets.length };
}

/** The scripted build (docs/M5-SPIKE.md §6.1): plan → dig → materials → build → Activate + road + field. */
function scriptedBuild(w: EconomyWorld): void {
  const hand = SCENARIO.hand;
  if (!w.canAddHousePlan(hand, SCENARIO.houseType, SCENARIO.entrance.x, SCENARIO.entrance.y)) {
    throw new Error(
      `scripted build: the hut plan at (${SCENARIO.entrance.x},${SCENARIO.entrance.y}) is not placeable on this map ` +
        '(the scenario is frozen for the Town Tutorial)',
    );
  }
  const plan = w.addHousePlan(hand, SCENARIO.houseType, SCENARIO.entrance.x, SCENARIO.entrance.y);
  if (plan.x !== SCENARIO.loc.x || plan.y !== SCENARIO.loc.y) {
    throw new Error(`scripted build: plan Loc (${plan.x},${plan.y}) != the frozen (${SCENARIO.loc.x},${SCENARIO.loc.y})`);
  }
  if (!w.canAddFieldPlan(hand, SCENARIO.road.x, SCENARIO.road.y, 'road')) {
    throw new Error(`scripted build: the road plan at (${SCENARIO.road.x},${SCENARIO.road.y}) is not placeable`);
  }
  w.addFieldPlan(hand, SCENARIO.road.x, SCENARIO.road.y, 'road');
  if (!w.canAddFieldPlan(hand, SCENARIO.corn.x, SCENARIO.corn.y, 'corn')) {
    throw new Error(`scripted build: the corn plan at (${SCENARIO.corn.x},${SCENARIO.corn.y}) is not placeable`);
  }
  w.addFieldPlan(hand, SCENARIO.corn.x, SCENARIO.corn.y, 'corn');
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

  const { world, mapName, streets } = buildWorld(opts);
  const summary = loadSummary(world, mapName, streets);
  console.log(
    `BUILDSIM ${summary.map} ${summary.mapSize} hands=${summary.hands} houses=${summary.houses} ` +
      `streets=${summary.streets} roadTiles=${summary.roadTiles} units=${summary.units} builders=${summary.builders} ` +
      `storeTimber=${summary.storeTimber} storeStone=${summary.storeStone}`,
  );

  scriptedBuild(world);

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
      `TICKS ${world.tickCount} events=${world.events.length} hut=${finals.hutState} progress=${finals.hutProgress} ` +
        `road=${finals.roadAtSite} corn=${finals.cornField} sites=${finals.siteCount} rngState=${world.rngState} sha256=${sha}`,
    );
    return;
  }

  // --check: compare the frozen numbers.
  console.log(`EVENTS ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(
    `FINAL hut=${finals.hutState} progress=${finals.hutProgress} wood=${finals.hutWood} stone=${finals.hutStone} ` +
      `reserve=${finals.hutReserve} woodDelivered=${finals.hutWoodDelivered} stoneDelivered=${finals.hutStoneDelivered} ` +
      `wip=${finals.houseWip} digged=${finals.housePlanDigged} activated=${finals.houseActivated} ` +
      `supply=${finals.buildSupply} assigned=${finals.buildHouseAssigned} roadDigged=${finals.roadDigged} ` +
      `roadBuilt=${finals.roadBuilt} fieldBuilt=${finals.fieldBuilt} doorRoad=${finals.doorRoad} ` +
      `road=${finals.roadAtSite} corn=${finals.cornField} sites=${finals.siteCount} plans=${finals.planCount} ` +
      `fieldPlans=${finals.fieldPlanCount} unitDelivered=${finals.unitDelivered} sawmill=${finals.sawmillUnlocked} ` +
      `store=${finals.storeUnlocked} barracks=${finals.barracksUnlocked} rngState=${finals.rngState}`,
  );
  console.log(`SHA256 ${sha}`);

  const problems: string[] = [];
  compare('load', summary, EXPECTED.load, problems);
  compare('events', totals, EXPECTED.events, problems);
  compare('final', finals, EXPECTED.final, problems);
  compare('sha256', sha, EXPECTED.sha256, problems);

  if (problems.length === 0) {
    console.log(`BUILD CHECK PASS (${world.tickCount} ticks, ${world.events.length} events, ${elapsed} ms)`);
  } else {
    console.log(`BUILD CHECK FAIL:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
