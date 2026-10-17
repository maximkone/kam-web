// cli.ts — M5b aisim: the Advanced AI's economy half on a real map (docs/M5-AI-NOTES.md §1–§3,
// docs/M5-SPIKE.md §6 wave 2). An AI hand (default 1) of MapsMP/Cursed Land — the map's script
// marks all four hands `!SET_ADVANCED_AI_PLAYER` — bootstraps like the game does
// (gHands.AfterMissionInit → PlaceFirstStorehouse, KM_HandsCollection.pas 234–266) and then builds
// its city: house plans, roads, fields, school training, ware management.
// Usage:
//   node tools/aisim/cli.ts --check        run TICKS, compare to expected.ts, AI CHECK PASS/FAIL
//   node tools/aisim/cli.ts --ticks N      run N ticks, print the event log + summary
//   node tools/aisim/cli.ts --json         print the JSON summary
//   node tools/aisim/cli.ts --map <kind>/<name>   pick another MapsMP map (default Cursed Land)
//   node tools/aisim/cli.ts --hand N       the AI hand (default 1)
//
// Reads the map/mission/defines from the frozen r15472 install (read-only). Data paths can be
// overridden with KAM_INSTALL and KAM_DATA (like the other tools).
//
// v0 scenario flags (documented, docs/M5-AI-NOTES.md §7):
//  - Cursed Land's script has no SET_HOUSE/ADD_WARE, so the AI's store is placed by
//    placeFirstStorehouse (the game path) and the scenario grants the RMG "Medium" starting kit
//    (KM_RandomMapGenerator.pas 582–594: stone 100, timber 70, gold 80, wine 70, bread 50,
//    sausage 30, fish 40 + 5 serfs, 4 builders) — a map-script start would carry the same wares
//    via !ADD_WARE / the choose-loc kit. The v0 economy has no mine/quarry/farm production (only
//    the hut and sawmill work, docs/M3-SPIKE.md), so the city stops growing once the kit runs out.
//  - The AI update runs with `tick = world.tickCount + 1` BEFORE `world.tick()`, mirroring the
//    game's gAIFields.UpdateState → gHands.UpdateState order (KM_Game.pas 3101–3114).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseMapFile } from '../../packages/map/map.ts';
import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat, parseSerfCarry } from '../../packages/assets/unitdat.ts';
import { parseHousesDat } from '../../packages/assets/housedata.ts';
import { parseMissionScript, parseMissionInfo } from '../../packages/mission/mission.ts';
import { createEconomyWorld } from '../../packages/sim/economy.ts';
import type { EconomyWorld, SimEvent } from '../../packages/sim/economy.ts';
import { WARE_CNT, WARE_NAMES } from '../../packages/assets/wares.ts';
import {
  AiPlayer,
  Eye,
  Influences,
  UT_BUILDER,
  UT_SERF,
  HT_STORE,
  applyMissionHouseUnlocks,
  parseAiSetups,
  placeFirstStorehouse,
} from '../../packages/sim/ai.ts';
import { TICKS, EXPECTED } from './expected.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const DEFINES_DIR = process.env.KAM_DATA ?? `${INSTALL}/data/defines`;

interface Options {
  check: boolean;
  ticks: number | null;
  json: boolean;
  map: string; // <kind>/<name>
  hand: number;
}

function usage(): string {
  return (
    'usage: node tools/aisim/cli.ts --check        (run ' +
    `${TICKS} ticks, compare to expected.ts, AI CHECK PASS/FAIL)\n` +
    '       node tools/aisim/cli.ts --ticks N      (run N ticks, event log + summary)\n' +
    '       node tools/aisim/cli.ts --json         (JSON summary)\n' +
    '       node tools/aisim/cli.ts --map <kind>/<name>  (default MapsMP/Cursed Land)\n' +
    '       node tools/aisim/cli.ts --hand N       (the AI hand, default 1)\n' +
    'env: KAM_INSTALL, KAM_DATA (defines dir)'
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, ticks: null, json: false, map: 'MapsMP/Battle Sun', hand: 1 };
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
    } else if (arg === '--hand') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0 || n >= 27) throw new Error(`--hand needs 0..26, got "${argv[i + 1]}"`);
      opts.hand = n;
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
  hand: number;
  advanced: string;
  hands: number;
  houses: number;
  streets: number;
  units: number;
  store: string;
  kit: string;
}

interface Sim {
  world: EconomyWorld;
  eye: Eye;
  ai: AiPlayer;
  setup: SetupSummary;
  summary: LoadSummary;
}

/** The economy-half setup values the AI honoured (docs/M5-AI-NOTES.md §5). */
interface SetupSummary {
  newAI: boolean;
  autoBuild: boolean;
  autoAttack: boolean;
  armyType: number;
  equipRateIron: number;
  equipRateLeather: number;
  maxSoldiers: number;
  recruitDelay: number;
  unlimitedEquip: boolean;
  repairAlways: boolean;
  startPosition: string;
  centerScreen: string;
}

/** The RMG "Medium" starting kit (KM_RandomMapGenerator.pas 582–594). */
const KIT_WARES: [number, number][] = [
  [1, 100], // stone
  [2, 70], // timber
  [7, 80], // gold
  [8, 70], // wine
  [10, 50], // bread
  [13, 30], // sausage
  [27, 40], // fish
];
const KIT_SERFS = 5;
const KIT_BUILDERS = 4;

function buildSim(opts: Options): Sim {
  const at = opts.map.indexOf('/');
  if (at <= 0) throw new Error(`--map wants <kind>/<name>, got "${opts.map}"`);
  const kind = opts.map.slice(0, at);
  const name = opts.map.slice(at + 1);
  const mapPath = `${INSTALL}/${kind}/${name}/${name}.map`;
  const missionPath = `${INSTALL}/${kind}/${name}/${name}.dat`;

  const map = parseMapFile(mapPath);
  const tiles = parseTilesJson(readDefine('tiles.json').toString('utf8'));
  const elems = parseMapElem(readDefine('mapelem.dat'));
  const unitBuf = readDefine('unit.dat');
  const unitSpecs = parseUnitDat(unitBuf);
  const serfCarry = parseSerfCarry(unitBuf);
  const houseSpecs = parseHousesDat(readDefine('houses.dat'));
  const missionBytes = readFileSync(missionPath);
  const mission = parseMissionScript(missionBytes, map.mapX, map.mapY);
  const info = parseMissionInfo(missionBytes, map.mapX, map.mapY);
  const setups = parseAiSetups(missionBytes, info, map.mapX, map.mapY);
  const setup = setups[opts.hand];
  if (setup === undefined) throw new Error(`no setup for hand ${opts.hand}`);

  const world = createEconomyWorld({ map, tiles, elems, unitSpecs, serfCarry, houseSpecs, mission });
  if (opts.hand >= world.handCount) throw new Error(`hand ${opts.hand} beyond the world's ${world.handCount} hands`);

  // The game's AfterMissionInit order (KM_HandsCollection.pas 234–266): Eye sees the mines, then
  // PlaceFirstStorehouse for hands that must place one, then the influences/eye init, then the
  // per-hand fAI.AfterMissionInit.
  const influences = new Influences(world);
  influences.initAvoidBuilding();
  const eye = new Eye(world, influences);
  eye.afterMissionInit();
  const store = world.findFirstHouse(HT_STORE, opts.hand);
  if (store === null) {
    // No mission store (Cursed Land style start): the AI places its first storehouse itself and
    // the scenario grants the RMG "Medium" kit (a map-script start carries it via !ADD_WARE).
    const seed = setup.centerScreen.x !== 0 ? setup.centerScreen : setup.startPosition;
    const storeUid = placeFirstStorehouse(world, eye, opts.hand, seed);
    if (storeUid === 0) throw new Error(`placeFirstStorehouse failed for hand ${opts.hand} (no store spot near ${seed.x},${seed.y})`);
  }
  influences.updateOwnership(opts.hand);
  const firstStore = world.findFirstHouse(HT_STORE, opts.hand);
  if (firstStore === null) throw new Error('no store for the hand after the bootstrap');
  // The map's starting houses unlock their build chains (the v0 world skips the mission-house
  // Activate — see applyMissionHouseUnlocks).
  applyMissionHouseUnlocks(world, opts.hand);
  if (mission.wares.every((w) => w.owner !== opts.hand)) {
    for (const [ware, amount] of KIT_WARES) world.addWareToStore(opts.hand, ware, amount);
  }
  if (world.handUnitCount(opts.hand, UT_SERF) === 0) {
    const below = { x: firstStore.entrance.x, y: firstStore.entrance.y + 1 };
    for (let i = 0; i < KIT_SERFS; i++) world.spawnCitizen(opts.hand, UT_SERF, below.x, below.y, 6);
    for (let i = 0; i < KIT_BUILDERS; i++) {
      const u = world.spawnCitizen(opts.hand, UT_BUILDER, below.x, below.y, 6);
      world.registerBuilder(opts.hand, u.uid);
    }
  }

  const ai = new AiPlayer(world, influences, eye, setup);
  ai.afterMissionInit();

  const advanced = info.advancedAI.map((v, i) => (v ? i : -1)).filter((i) => i >= 0).join(',');
  const summary: LoadSummary = {
    map: map.file,
    mapSize: `${map.mapX}x${map.mapY}`,
    hand: opts.hand,
    advanced,
    hands: world.handCount,
    houses: world.houses.length,
    streets: mission.streets.length,
    units: world.units.length,
    store: `${firstStore.x},${firstStore.y}`,
    kit: mission.wares.some((w) => w.owner === opts.hand) ? 'mission !ADD_WARE' : KIT_WARES.map(([w, a]) => `${WARE_NAMES[w]}=${a}`).join(' '),
  };
  const setupSummary: SetupSummary = {
    newAI: setup.newAI,
    autoBuild: setup.autoBuild,
    autoAttack: setup.autoAttack,
    armyType: setup.armyType,
    equipRateIron: setup.equipRateIron,
    equipRateLeather: setup.equipRateLeather,
    maxSoldiers: setup.maxSoldiers,
    recruitDelay: setup.recruitDelay,
    unlimitedEquip: setup.unlimitedEquip,
    repairAlways: setup.isRepairAlways,
    startPosition: `${setup.startPosition.x},${setup.startPosition.y}`,
    centerScreen: setup.centerScreen.x !== 0 ? `${setup.centerScreen.x},${setup.centerScreen.y}` : '-',
  };
  return { world, eye, ai, setup: setupSummary, summary };
}

function eventTotals(events: SimEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    const kind = e.text.split(' ')[0];
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

interface FinalCounts {
  plannedByType: Record<string, number>;
  plannedPlaced: number;
  plannedReserved: number;
  builtByType: Record<string, number>;
  completedHouses: number;
  wipHouses: number;
  roadTiles: number;
  cornFields: number;
  fieldBuiltEvents: number;
  roadBuiltEvents: number;
  housePlansDigged: number;
  housesActivated: number;
  unitsByType: Record<string, number>;
  trainedUnits: number;
  schoolQueued: number;
  workers: number;
  serfs: number;
  builders: number;
  wares: Record<string, number>;
  workerCount: number;
  requiredSchool: number;
  cityCompleted: boolean;
  rngState: number;
}

function finalCounts(sim: Sim): FinalCounts {
  const { world, ai } = sim;
  const hand = sim.summary.hand;
  const totals = eventTotals(world.events);
  const plannedByType: Record<string, number> = {};
  let plannedPlaced = 0;
  let plannedReserved = 0;
  for (let ht = 0; ht < 30; ht++) {
    const arr = ai.planner.plannedHouses[ht];
    if (arr.count === 0) continue;
    plannedByType[`house${ht}`] = arr.count;
    plannedPlaced += arr.completed + arr.underConstruction;
    plannedReserved += arr.planned;
  }

  const builtByType: Record<string, number> = {};
  let completedHouses = 0;
  let wipHouses = 0;
  for (const h of world.houses) {
    if (h.owner !== hand || h.destroyed) continue;
    builtByType[`house${h.typeId}`] = (builtByType[`house${h.typeId}`] ?? 0) + 1;
    if (h.buildState === 'done') completedHouses += 1;
    else wipHouses += 1;
  }
  const unitsByType: Record<string, number> = {};
  let workers = 0;
  let serfs = 0;
  let builders = 0;
  for (const u of world.units) {
    if (u.owner !== hand || u.dead) continue;
    unitsByType[`unit${u.type}`] = (unitsByType[`unit${u.type}`] ?? 0) + 1;
    if (u.type === UT_SERF) serfs += 1;
    if (u.type === UT_BUILDER) builders += 1;
  }
  workers = builders;
  let cornFields = 0;
  for (let y = 1; y <= world.mapY - 1; y++) {
    for (let x = 1; x <= world.mapX - 1; x++) {
      if (world.tileHasCornField(x, y)) cornFields += 1;
    }
  }
  const wares: Record<string, number> = {};
  for (let w = 0; w < WARE_CNT; w++) {
    const n = world.handWareBalance(hand, w);
    if (n > 0) wares[WARE_NAMES[w]] = n;
  }
  let schoolQueued = 0;
  for (const h of world.houses) {
    if (h.owner === hand && h.typeId === 19 && !h.destroyed) schoolQueued += world.schoolQueueCount(h.uid);
  }
  return {
    plannedByType,
    plannedPlaced,
    plannedReserved,
    builtByType,
    completedHouses,
    wipHouses,
    roadTiles: world.roadTileCount,
    cornFields,
    fieldBuiltEvents: totals['field-built'] ?? 0,
    roadBuiltEvents: totals['road-built'] ?? 0,
    housePlansDigged: totals['house-plan-digged'] ?? 0,
    housesActivated: totals['house-activated'] ?? 0,
    unitsByType,
    trainedUnits: totals['school-unit-trained'] ?? 0,
    schoolQueued,
    workers,
    serfs,
    builders,
    wares,
    workerCount: ai.predictor.workerCount,
    requiredSchool: ai.predictor.requiredHouses[19] ?? 0,
    cityCompleted: ai.predictor.cityCompleted,
    rngState: world.rngState,
  };
}

/** A canonical, order-stable serialization of the observable world + AI state, sha256'd. */
function stateSha(sim: Sim): string {
  const { world, ai } = sim;
  const hand = sim.summary.hand;
  const houses = world.houses.map((h) => ({
    uid: h.uid,
    typeId: h.typeId,
    owner: h.owner,
    x: h.x,
    y: h.y,
    buildState: h.buildState,
    buildingProgress: h.buildingProgress,
    buildSupplyWood: h.buildSupplyWood,
    buildSupplyStone: h.buildSupplyStone,
    wareIn: h.wareIn.slice(),
    wareOut: h.wareOut.slice(),
    wares: Array.from({ length: WARE_CNT }, (_, i) => world.wareCount(h, i)),
  }));
  const units = world.units.map((u) => ({
    uid: u.uid,
    owner: u.owner,
    type: u.type,
    pos: [u.posF.x, u.posF.y],
    action: u.action,
    taskKind: u.taskKind,
    inside: u.inside,
    homeUid: u.homeUid,
  }));
  const plans = world.constructionState(hand).plans.map((p) => [p.uid, p.typeId, p.x, p.y, p.status]);
  const fields = world.constructionState(hand).fields.map((f) => [f.x, f.y, f.fieldType, f.status]);
  const planned: number[][] = [];
  for (let ht = 0; ht < 30; ht++) {
    const arr = ai.planner.plannedHouses[ht];
    if (arr.count === 0) continue;
    planned.push([ht, arr.count, arr.completed, arr.underConstruction, arr.planned]);
  }
  const corn: number[][] = [];
  const road: number[][] = [];
  for (let y = 1; y <= world.mapY - 1; y++) {
    for (let x = 1; x <= world.mapX - 1; x++) {
      if (world.tileHasCornField(x, y)) corn.push([x, y]);
      if (world.tileHasRoad(x, y)) road.push([x, y]);
    }
  }
  const canonical = JSON.stringify({
    tick: world.tickCount,
    rngState: world.rngState,
    roadTiles: world.roadTileCount,
    houses,
    units,
    plans,
    fields,
    planned,
    corn,
    road,
    workerCount: ai.predictor.workerCount,
    required: ai.predictor.requiredHouses,
  });
  return createHash('sha256').update(canonical).digest('hex');
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
  const sim = buildSim(opts);
  const { world, ai, summary, setup } = sim;
  console.log(
    `AISIM ${summary.map} ${summary.mapSize} hand=${summary.hand} advanced=[${summary.advanced}] hands=${summary.hands} ` +
      `houses=${summary.houses} streets=${summary.streets} units=${summary.units} store=${summary.store}`,
  );
  console.log(`AISIM kit: ${summary.kit} + ${KIT_SERFS} serfs + ${KIT_BUILDERS} builders`);
  console.log(
    `AISIM setup: newAI=${setup.newAI} AutoBuild=${setup.autoBuild} AutoAttack=${setup.autoAttack} ArmyType=${setup.armyType} ` +
      `EquipIron=${setup.equipRateIron} EquipLeather=${setup.equipRateLeather} MaxSoldiers=${setup.maxSoldiers} ` +
      `RecruitDelay=${setup.recruitDelay} UnlimitedEquip=${setup.unlimitedEquip} RepairAlways=${setup.repairAlways} ` +
      `StartPos=(${setup.startPosition}) CenterScreen=(${setup.centerScreen})`,
  );

  const ticks = opts.check || (opts.json && opts.ticks === null) ? TICKS : opts.ticks ?? 0;
  const start = Date.now();
  for (let i = 0; i < ticks; i++) {
    // The game order: the AI sees the state at the end of tick N, then tick N+1 runs.
    ai.updateState(world.tickCount + 1);
    world.tick();
  }
  const elapsed = Date.now() - start;

  const totals = eventTotals(world.events);
  const finals = finalCounts(sim);
  const sha = stateSha(sim);

  if (opts.json) {
    console.log(JSON.stringify({ load: summary, setup, ticks: world.tickCount, events: totals, final: finals, sha256: sha, elapsedMs: elapsed }, null, 2));
    return;
  }
  if (opts.ticks !== null && !opts.check) {
    for (const e of world.events) console.log(`EVENT t=${e.tick} ${e.text}`);
    console.log(
      `TICKS ${world.tickCount} events=${world.events.length} planned=${JSON.stringify(finals.plannedByType)} built=${JSON.stringify(finals.builtByType)} ` +
        `completed=${finals.completedHouses} roadTiles=${finals.roadTiles} corn=${finals.cornFields} trained=${finals.trainedUnits} ` +
        `rngState=${world.rngState} sha256=${sha}`,
    );
    return;
  }

  console.log(`EVENTS ${Object.entries(totals).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  console.log(
    `FINAL planned=${JSON.stringify(finals.plannedByType)} placed=${finals.plannedPlaced} reserved=${finals.plannedReserved} ` +
      `built=${JSON.stringify(finals.builtByType)} completed=${finals.completedHouses} wip=${finals.wipHouses} ` +
      `roadTiles=${finals.roadTiles} roadBuilt=${finals.roadBuiltEvents} corn=${finals.cornFields} fieldBuilt=${finals.fieldBuiltEvents} ` +
      `digged=${finals.housePlansDigged} activated=${finals.housesActivated} units=${JSON.stringify(finals.unitsByType)} ` +
      `trained=${finals.trainedUnits} queued=${finals.schoolQueued} workers=${finals.builders} serfs=${finals.serfs} ` +
      `wares=${JSON.stringify(finals.wares)} workerCount=${finals.workerCount} reqSchool=${finals.requiredSchool} ` +
      `cityCompleted=${finals.cityCompleted} rngState=${finals.rngState}`,
  );
  console.log(`SHA256 ${sha}`);

  const problems: string[] = [];
  compare('load', summary, EXPECTED.load, problems);
  compare('events', totals, EXPECTED.events, problems);
  compare('final', finals, EXPECTED.final, problems);
  compare('sha256', sha, EXPECTED.sha256, problems);
  if (problems.length === 0) {
    console.log(`AI CHECK PASS (${world.tickCount} ticks, ${world.events.length} events, ${elapsed} ms)`);
  } else {
    console.log(`AI CHECK FAIL:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
