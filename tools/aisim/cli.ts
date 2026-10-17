// cli.ts — M5 aisim: the Advanced AI on a real map (docs/M5-AI-NOTES.md §1–§3, docs/M5-SPIKE.md §6 wave 2,
// docs/M5-SPIKE.md 7.4 the economy half, 7.5 the military half). An AI hand (default 1) of MapsMP/Battle
// Sun — the map's script marks all four hands `!SET_ADVANCED_AI_PLAYER` — bootstraps like the game does
// (gHands.AfterMissionInit → PlaceFirstStorehouse, KM_HandsCollection.pas 234–266) and then runs its city
// (house plans, roads, fields, school training, ware management) and its army (recruit/equip at the
// barracks, combat groups, defence positions, the Supervisor's attack requests).
// Usage:
//   node tools/aisim/cli.ts --check        the economy run (frozen, TICKS) then the attack run (ATTACK_TICKS);
//                                          compares both to expected.ts; AI CHECK PASS/FAIL
//   node tools/aisim/cli.ts --ticks N      run N ticks, print the event log + summary (economy scenario)
//   node tools/aisim/cli.ts --scenario attack --ticks N   the attack scenario (military kit, enemy garrison)
//   node tools/aisim/cli.ts --json         print the JSON summary
//   node tools/aisim/cli.ts --map <kind>/<name>   pick another MapsMP map (default Battle Sun)
//   node tools/aisim/cli.ts --hand N       the AI hand (default 1)
//
// Reads the map/mission/defines from the frozen r15472 install (read-only). Data paths can be
// overridden with KAM_INSTALL and KAM_DATA (like the other tools).
//
// Scenario flags (documented):
//  - The economy scenario (worker M): hand 1 of Battle Sun, the map's store and !ADD_WARE start, the
//    AI's economy half for TICKS ticks. Battle Sun's script sets AUTO_ATTACK and AUTO_DEFEND for all hands,
//    so the military half is live in this run too (no barracks is built within TICKS, so no soldier is made).
//  - The attack scenario (worker N): the same hand with a military kit (40 axes, 40 wooden shields, 40
//    leather armours in the store — the economy has no smithy, so this stands in for the weapon production)
//    and hand 2 (the enemy) with a 6-militia garrison beside its store. The Supervisor decides the attack
//    from the warrior counts; the army equips at the barracks, forms the groups and attacks hand 2.
//  - Cursed Land / RMG-style starts keep the Medium kit (KM_RandomMapGenerator.pas 582–594) and a
//    placeFirstStorehouse store — the economy scenario of earlier waves; Battle Sun has !ADD_WARE.
//  - The AI update runs with `tick = world.tickCount + 1` BEFORE `world.tick()`, mirroring the game's
//    gAIFields.UpdateState → gHands.UpdateState order (KM_Game.pas 3101–3114): the Supervisor first.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { parseMapFile } from '../../packages/map/map.ts';
import { parseTilesJson } from '../../packages/assets/tiledata.ts';
import { parseMapElem } from '../../packages/assets/mapelem.ts';
import { parseUnitDat, parseSerfCarry } from '../../packages/assets/unitdat.ts';
import { parseHousesDat } from '../../packages/assets/housedata.ts';
import { parseMissionScript, parseMissionInfo } from '../../packages/mission/mission.ts';
import { createEconomyWorld } from '../../packages/sim/economy.ts';
import type { EconHouse, EconomyWorld, SimEvent } from '../../packages/sim/economy.ts';
import { WARE_CNT, WARE_NAMES, WT_AXE, WT_WOODEN_SHIELD, WT_LEATHER_ARMOR } from '../../packages/assets/wares.ts';
import {
  AiPlayer,
  Eye,
  Influences,
  UT_BUILDER,
  UT_MILITIA,
  UT_RECRUIT,
  UT_SERF,
  HT_BARRACKS,
  HT_STORE,
  applyMissionHouseUnlocks,
  parseAiSetups,
  placeFirstStorehouse,
} from '../../packages/sim/ai.ts';
import { ArmyManagement } from '../../packages/sim/aiarmy.ts';
import { AiSupervisor } from '../../packages/sim/aisupervisor.ts';
import { TICKS, ATTACK_TICKS, EXPECTED, EXPECTED_ATTACK } from './expected.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const DEFINES_DIR = process.env.KAM_DATA ?? `${INSTALL}/data/defines`;

/** economy: the frozen economy run (worker M's scenario); attack: the military run (worker N, 7.5). */
type Scenario = 'economy' | 'attack';

interface Options {
  check: boolean;
  ticks: number | null;
  json: boolean;
  map: string; // <kind>/<name>
  hand: number;
  scenario: Scenario;
}

function usage(): string {
  return (
    'usage: node tools/aisim/cli.ts --check        (economy ' +
    `${TICKS} ticks + attack ${ATTACK_TICKS} ticks, compare to expected.ts, AI CHECK PASS/FAIL)\n` +
    '       node tools/aisim/cli.ts --ticks N      (run N ticks, event log + summary)\n' +
    '       node tools/aisim/cli.ts --scenario economy|attack  (default economy)\n' +
    '       node tools/aisim/cli.ts --json         (JSON summary)\n' +
    '       node tools/aisim/cli.ts --map <kind>/<name>  (default MapsMP/Battle Sun)\n' +
    '       node tools/aisim/cli.ts --hand N       (the AI hand, default 1)\n' +
    'env: KAM_INSTALL, KAM_DATA (defines dir)'
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, ticks: null, json: false, map: 'MapsMP/Battle Sun', hand: 1, scenario: 'economy' };
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
    } else if (arg === '--scenario') {
      const s = argv[i + 1];
      if (s !== 'economy' && s !== 'attack') throw new Error(`--scenario needs economy or attack, got "${s}"`);
      opts.scenario = s;
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
  army: ArmyManagement;
  supervisor: AiSupervisor;
  setup: SetupSummary;
  summary: LoadSummary;
}

/** The AI setup values the AI honoured (docs/M5-AI-NOTES.md §5). */
interface SetupSummary {
  newAI: boolean;
  autoBuild: boolean;
  autoAttack: boolean;
  autoDefend: boolean;
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

/** The attack scenario's enemies: every other hand, each with a militia garrison beside its store. */
const ENEMY_GARRISON = 6;
/** The attack scenario's starting army of the AI hand: six full groups (MIN_GROUPS_IN_ATTACK = 4 groups
 *  must pass the mobilization draws, so four would rarely be enough). */
const START_GROUPS = 6;
const START_GROUP_SIZE = 9;
/** Recruits waiting in the barracks at the start (see docs/M5-SPIKE.md 7.5: the v0 school stalls on gold). */
const START_RECRUITS = 12;
/** The attack scenario's military kit (documented v0 grant: the economy has no smithy, so the weapons
 *  and armour of the barracks come from the start stock, as the RMG kit does for the economy). */
const MILITARY_KIT: [number, number][] = [
  [WT_AXE, 40],
  [WT_WOODEN_SHIELD, 40],
  [WT_LEATHER_ARMOR, 40],
];

/**
 * A finished barracks for the hand, placed by the economy's own rule (canPlaceHouse on the entrance)
 * on the first free spot 4–12 tiles from the store. The map's start would carry it as a SET_HOUSE; the
 * v0 economy does not build the AI's reserved barracks (docs/M5-SPIKE.md 7.5, open items).
 */
function grantBarracks(world: EconomyWorld, hand: number): EconHouse {
  const store = world.findFirstHouse(HT_STORE, hand);
  const spec = world.houseSpecOf(HT_BARRACKS);
  if (store === null || spec === undefined) throw new Error('attack scenario: no store or barracks spec');
  for (let r = 4; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = store.x + dx;
        const y = store.y + dy;
        if (!world.canPlaceHouse(HT_BARRACKS, x + spec.entranceDx, y)) continue;
        const house = world.spawnHouse(HT_BARRACKS, x, y, hand);
        world.houseCreatedFor(hand, HT_BARRACKS);
        return house;
      }
    }
  }
  throw new Error(`attack scenario: no barracks spot near the store of hand ${hand}`);
}

/**
 * The attack scenario's starting army: full militia groups around the store, as a map's !SET_UNIT
 * records would place them (the v0 economy trains soldiers too slowly to reach the Pascal's
 * four-group attack threshold on its own, see docs/M5-SPIKE.md 7.5).
 */
function addStartArmy(world: EconomyWorld, hand: number, groups: number, perGroup: number): void {
  const store = world.findFirstHouse(HT_STORE, hand);
  if (store === null) throw new Error(`attack scenario: hand ${hand} has no store`);
  let placed = 0;
  for (let r = 5; r <= 14 && placed < groups; r++) {
    for (let dy = -r; dy <= r && placed < groups; dy += 3) {
      for (let dx = -r; dx <= r && placed < groups; dx += 3) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = store.entrance.x + dx;
        const y = store.entrance.y + dy;
        if (!world.tileInMapCoords(x, y) || !world.tileWalkable(x, y) || world.houseAt(x, y) !== null || world.isRoadTile(x, y)) continue;
        const g = world.spawnGroup(hand, UT_MILITIA, x, y, 4, 3, perGroup);
        if (g.memberUids.length > 0) placed += 1;
      }
    }
  }
  if (placed < groups) throw new Error(`attack scenario: only ${placed} of ${groups} start groups fit around the store`);
}

/** The garrison of the enemy hand: militia a few tiles south of its store. */
function addEnemyGarrison(world: EconomyWorld, enemy: number): void {
  if (enemy >= world.handCount) throw new Error(`attack scenario: the map has no hand ${enemy}`);
  const store = world.findFirstHouse(HT_STORE, enemy);
  if (store === null) throw new Error(`attack scenario: hand ${enemy} has no store`);
  for (let dy = 3; dy <= 8; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = store.entrance.x + dx;
      const y = store.entrance.y + dy;
      if (!world.tileInMapCoords(x, y) || !world.tileWalkable(x, y) || world.houseAt(x, y) !== null || world.isRoadTile(x, y)) continue;
      world.spawnGroup(enemy, UT_MILITIA, x, y, 4, 3, ENEMY_GARRISON);
      return;
    }
  }
  throw new Error(`attack scenario: no garrison spot near the store of hand ${enemy}`);
}

function buildSim(opts: Options, scenario: Scenario): Sim {
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
  if (scenario === 'attack') {
    for (const [ware, amount] of MILITARY_KIT) world.addWareToStore(opts.hand, ware, amount);
    const barracks = grantBarracks(world, opts.hand);
    for (let i = 0; i < START_RECRUITS; i++) world.barracksAddRecruit(barracks.uid);
    addStartArmy(world, opts.hand, START_GROUPS, START_GROUP_SIZE);
    for (let h = 0; h < world.handCount; h++) if (h !== opts.hand) addEnemyGarrison(world, h);
  }

  const ai = new AiPlayer(world, influences, eye, setup);
  const army = new ArmyManagement(world, ai);
  ai.attachArmy(army);
  // gAIFields.AfterMissionInit (the Supervisor) runs before the hands' AfterMissionInit (KM_HandsCollection.pas 259–266).
  const supervisor = new AiSupervisor(world, eye, influences, [ai]);
  supervisor.afterMissionInit();
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
    autoDefend: setup.autoDefend,
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
  return { world, eye, ai, army, supervisor, setup: setupSummary, summary };
}

/** One tick of the game order: gAIFields (the Supervisor) → gHands (the AI) → the world (KM_Game.pas 3101–3114). */
function advance(sim: Sim, ticks: number, onTick?: (tick: number) => void): void {
  for (let i = 0; i < ticks; i++) {
    const tick = sim.world.tickCount + 1;
    sim.supervisor.updateState(tick);
    sim.ai.updateState(tick);
    sim.world.tick();
    if (onTick !== undefined) onTick(tick);
  }
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
  let serfs = 0;
  let builders = 0;
  for (const u of world.units) {
    if (u.owner !== hand || u.dead) continue;
    unitsByType[`unit${u.type}`] = (unitsByType[`unit${u.type}`] ?? 0) + 1;
    if (u.type === UT_SERF) serfs += 1;
    if (u.type === UT_BUILDER) builders += 1;
  }
  const workers = builders;
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

/** The military part of the canonical state (attack scenario only; keys are added after the economy's). */
function armyCanonical(sim: Sim): Record<string, unknown> {
  const { world, army } = sim;
  const groups = world.groupList().map((g) => ({
    uid: g.uid,
    owner: g.owner,
    type: g.groupType,
    members: g.memberUids.slice(),
    order: g.order,
    orderXY: [g.orderX, g.orderY],
    targets: [g.targetUid, g.targetHouseUid],
  }));
  const combat = army.attack.cgs.map((c) => ({
    g: c.groupUid,
    t: c.targetType,
    p: c.phase,
    house: c.targetHouseUid,
    unit: c.targetUnitUid,
    group: c.targetGroupUid,
    pos: c.targetPos,
  }));
  const defence = army.defence.positions.map((p) => [p.loc.x, p.loc.y, p.dir, p.weight, p.line, p.groupUid]);
  const ar = army.attackRequest;
  return {
    groups,
    combat,
    defence,
    request: [ar.active, ar.ffa, ar.bestEnemy, ar.enemies],
    houseDamage: world.houseDamageTotal,
  };
}

/** A canonical, order-stable serialization of the observable world + AI state, sha256'd. */
function stateSha(sim: Sim, attack = false): string {
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
    ...(attack ? armyCanonical(sim) : {}),
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function compare(label: string, actual: unknown, expected: unknown, problems: string[]): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) problems.push(`${label}: ${a} != expected ${b}`);
}

/** The economy run (worker M's frozen check, unchanged scenario). */
function economyRun(opts: Options, ticks: number): { sim: Sim; elapsed: number } {
  const sim = buildSim(opts, 'economy');
  const { summary, setup } = sim;
  console.log(
    `AISIM ${summary.map} ${summary.mapSize} hand=${summary.hand} advanced=[${summary.advanced}] hands=${summary.hands} ` +
      `houses=${summary.houses} streets=${summary.streets} units=${summary.units} store=${summary.store}`,
  );
  console.log(`AISIM kit: ${summary.kit} + ${KIT_SERFS} serfs + ${KIT_BUILDERS} builders`);
  console.log(
    `AISIM setup: newAI=${setup.newAI} AutoBuild=${setup.autoBuild} AutoAttack=${setup.autoAttack} AutoDefend=${setup.autoDefend} ArmyType=${setup.armyType} ` +
      `EquipIron=${setup.equipRateIron} EquipLeather=${setup.equipRateLeather} MaxSoldiers=${setup.maxSoldiers} ` +
      `RecruitDelay=${setup.recruitDelay} UnlimitedEquip=${setup.unlimitedEquip} RepairAlways=${setup.repairAlways} ` +
      `StartPos=(${setup.startPosition}) CenterScreen=(${setup.centerScreen})`,
  );
  const start = Date.now();
  advance(sim, ticks);
  return { sim, elapsed: Date.now() - start };
}

interface AttackFinals {
  ticks: number;
  hand: number;
  equipped: number;
  recruitsTrained: number;
  warriors: number;
  requests: number;
  combatGroupsMax: number;
  groupsAddedToAttack: number;
  combatGroupsEnd: number;
  killsByHand: number;
  killsByEnemy: number;
  lossesByEnemy: number;
  houseDamage: number;
  houseDestroyedEvents: number;
  enemyHousesStart: number;
  enemyHousesEnd: number;
  enemyWarriorsStart: number;
  enemyWarriorsEnd: number;
  rngState: number;
}

/** The units of other hands that `attacker` killed (the combat sim's `unit-killed` events, from=attacker). */
function killsBy(events: SimEvent[], attacker: number): number {
  let n = 0;
  for (const e of events) {
    const m = /^unit-killed unit#\d+ owner=(-?\d+) from=(-?\d+)$/.exec(e.text);
    if (m !== null && Number(m[2]) === attacker && Number(m[1]) !== attacker) n += 1;
  }
  return n;
}

/** The units of `hand` that other hands killed. */
function lossesTo(events: SimEvent[], hand: number): number {
  let n = 0;
  for (const e of events) {
    const m = /^unit-killed unit#\d+ owner=(-?\d+) from=(-?\d+)$/.exec(e.text);
    if (m !== null && Number(m[1]) === hand && Number(m[2]) >= 0 && Number(m[2]) !== hand) n += 1;
  }
  return n;
}

/** The attack run (worker N's military check): the economy plus the army against the enemy store. */
function attackRun(opts: Options, ticks: number): { sim: Sim; finals: AttackFinals; elapsed: number } {
  const sim = buildSim(opts, 'attack');
  const { world, army } = sim;
  const hand = sim.summary.hand;
  const enemies = Array.from({ length: world.handCount }, (_, h) => h).filter((h) => h !== hand);
  const enemyHouses = (): number => world.houses.filter((h) => h.owner !== hand && h.owner >= 0 && !h.destroyed).length;
  const enemyWarriors = (): number => enemies.reduce((s, h) => s + world.handWarriorCount(h), 0);
  const enemyStart = enemyHouses();
  const enemyWarriorsStart = enemyWarriors();
  let prevRequest: unknown = army.attackRequest;
  let requests = 0;
  let prevCount = 0;
  let adds = 0;
  let combatMax = 0;
  const start = Date.now();
  advance(sim, ticks, () => {
    if (army.attackRequest !== prevRequest) {
      if (army.attackRequest.active) requests += 1;
      prevRequest = army.attackRequest;
    }
    const c = army.attack.count;
    if (c > prevCount) adds += c - prevCount;
    prevCount = c;
    combatMax = Math.max(combatMax, c);
  });
  const elapsed = Date.now() - start;
  const finals: AttackFinals = {
    ticks: world.tickCount,
    hand,
    equipped: world.events.filter((e) => e.text.startsWith('barracks-equipped ')).length,
    recruitsTrained: world.events.filter((e) => e.text.startsWith('school-unit-trained ') && e.text.endsWith(` type=${UT_RECRUIT}`)).length,
    warriors: world.handWarriorCount(hand),
    requests,
    combatGroupsMax: combatMax,
    groupsAddedToAttack: adds,
    combatGroupsEnd: army.attack.count,
    killsByHand: killsBy(world.events, hand),
    killsByEnemy: enemies.reduce((s, h) => s + killsBy(world.events, h), 0),
    lossesByEnemy: lossesTo(world.events, hand),
    houseDamage: world.houseDamageTotal,
    houseDestroyedEvents: world.events.filter((e) => e.text.startsWith('house-destroyed ')).length,
    enemyHousesStart: enemyStart,
    enemyHousesEnd: enemyHouses(),
    enemyWarriorsStart,
    enemyWarriorsEnd: enemyWarriors(),
    rngState: world.rngState,
  };
  return { sim, finals, elapsed };
}

function printAttack(sim: Sim, finals: AttackFinals, sha: string): void {
  console.log(
    `ATTACK equipped=${finals.equipped} recruitsTrained=${finals.recruitsTrained} warriors(hand${finals.hand})=${finals.warriors} ` +
      `requests=${finals.requests} combatGroupsMax=${finals.combatGroupsMax} groupsAddedToAttack=${finals.groupsAddedToAttack} ` +
      `combatGroupsEnd=${finals.combatGroupsEnd}`,
  );
  console.log(
    `ATTACK kills(by hand${finals.hand})=${finals.killsByHand} kills(by enemies)=${finals.killsByEnemy} losses=${finals.lossesByEnemy} ` +
      `houseDamage=${finals.houseDamage} houseDestroyed=${finals.houseDestroyedEvents} ` +
      `enemyHouses=${finals.enemyHousesStart}->${finals.enemyHousesEnd} enemyWarriors=${finals.enemyWarriorsStart}->${finals.enemyWarriorsEnd} ` +
      `rngState=${finals.rngState}`,
  );
  console.log(`ATTACK SHA256 ${sha} (units=${sim.world.units.length} groups=${sim.world.groupList().length})`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.check && opts.ticks === null && !opts.json && opts.scenario === 'economy') {
    console.log(usage());
    return;
  }

  if (opts.check) {
    const problems: string[] = [];
    const eco = economyRun(opts, TICKS);
    const { sim } = eco;
    const summary = sim.summary;
    console.log(`EVENTS ${Object.entries(eventTotals(sim.world.events)).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    const finals = finalCounts(sim);
    console.log(
      `FINAL planned=${JSON.stringify(finals.plannedByType)} placed=${finals.plannedPlaced} reserved=${finals.plannedReserved} ` +
        `built=${JSON.stringify(finals.builtByType)} completed=${finals.completedHouses} wip=${finals.wipHouses} ` +
        `roadTiles=${finals.roadTiles} roadBuilt=${finals.roadBuiltEvents} corn=${finals.cornFields} fieldBuilt=${finals.fieldBuiltEvents} ` +
        `digged=${finals.housePlansDigged} activated=${finals.housesActivated} units=${JSON.stringify(finals.unitsByType)} ` +
        `trained=${finals.trainedUnits} queued=${finals.schoolQueued} workers=${finals.builders} serfs=${finals.serfs} ` +
        `wares=${JSON.stringify(finals.wares)} workerCount=${finals.workerCount} reqSchool=${finals.requiredSchool} ` +
        `cityCompleted=${finals.cityCompleted} rngState=${finals.rngState}`,
    );
    const sha = stateSha(sim);
    console.log(`SHA256 ${sha}`);
    compare('load', summary, EXPECTED.load, problems);
    compare('events', eventTotals(sim.world.events), EXPECTED.events, problems);
    compare('final', finals, EXPECTED.final, problems);
    compare('sha256', sha, EXPECTED.sha256, problems);
    console.log(`AI ECON CHECK ${problems.length === 0 ? 'PASS' : 'FAIL'} (${sim.world.tickCount} ticks, ${sim.world.events.length} events, ${eco.elapsed} ms)`);

    const attackProblems: string[] = [];
    const run = attackRun(opts, ATTACK_TICKS);
    const attackSha = stateSha(run.sim, true);
    printAttack(run.sim, run.finals, attackSha);
    compare('attack', run.finals, EXPECTED_ATTACK.final, attackProblems);
    compare('attack sha256', attackSha, EXPECTED_ATTACK.sha256, attackProblems);
    console.log(`AI ATTACK CHECK ${attackProblems.length === 0 ? 'PASS' : 'FAIL'} (${run.finals.ticks} ticks, ${run.elapsed} ms)`);

    const all = [...problems.map((p) => `econ ${p}`), ...attackProblems.map((p) => `attack ${p}`)];
    if (all.length === 0) {
      console.log(`AI CHECK PASS (economy ${sim.world.tickCount} ticks, ${sim.world.events.length} events; attack ${run.finals.ticks} ticks)`);
    } else {
      console.log(`AI CHECK FAIL:\n  ${all.join('\n  ')}`);
      process.exitCode = 1;
    }
    return;
  }

  if (opts.scenario === 'attack') {
    const ticks = opts.ticks ?? ATTACK_TICKS;
    const run = attackRun(opts, ticks);
    if (opts.json) {
      console.log(JSON.stringify({ final: run.finals, sha256: stateSha(run.sim, true), elapsedMs: run.elapsed }, null, 2));
      return;
    }
    printAttack(run.sim, run.finals, stateSha(run.sim, true));
    return;
  }

  const ticks = opts.json && opts.ticks === null ? TICKS : opts.ticks ?? 0;
  const eco = economyRun(opts, ticks);
  const { sim, elapsed } = eco;
  const totals = eventTotals(sim.world.events);
  const finals = finalCounts(sim);
  const sha = stateSha(sim);

  if (opts.json) {
    console.log(JSON.stringify({ load: sim.summary, setup: sim.setup, ticks: sim.world.tickCount, events: totals, final: finals, sha256: sha, elapsedMs: elapsed }, null, 2));
    return;
  }
  for (const e of sim.world.events) console.log(`EVENT t=${e.tick} ${e.text}`);
  console.log(
    `TICKS ${sim.world.tickCount} events=${sim.world.events.length} planned=${JSON.stringify(finals.plannedByType)} built=${JSON.stringify(finals.builtByType)} ` +
      `completed=${finals.completedHouses} roadTiles=${finals.roadTiles} corn=${finals.cornFields} trained=${finals.trainedUnits} ` +
      `rngState=${sim.world.rngState} sha256=${sha}`,
  );
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
