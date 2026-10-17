// ai.test.ts — the M5b AI economy half (packages/sim/ai.ts) on a synthetic mini village.
// Run: node --test packages/sim/ai.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyWorld } from './economy.ts';
import type { EconomyWorld, EconomyWorldOptions } from './economy.ts';
import {
  AI_PAR,
  AiPlayer,
  AVOID_BUILDING_FOREST_MINIMUM,
  AVOID_BUILDING_HOUSE_INSIDE_LOCK,
  BuildFF,
  Eye,
  HT_SAWMILL,
  HT_SCHOOL,
  HT_STORE,
  HT_WOODCUTTERS,
  Influences,
  UT_BUILDER,
  UT_SERF,
  buildHousesMapping,
  distanceAbs,
  lengthDiag,
  parseAiSetups,
  placeFirstStorehouse,
  roadRoute,
} from './ai.ts';
import { decodeMissionScript, missionScriptIsXor239, parseMissionInfo } from '../mission/mission.ts';
import type { KaMap } from '../map/map.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import type { Mission } from '../mission/mission.ts';

const TILES: TileFlags[] = [
  { walkable: true, roadable: true, soil: true, corners: [0, 0, 0, 0] }, // 0 grass
  { walkable: false, roadable: false, soil: false, corners: [0, 0, 0, 0] }, // 1 water
  { walkable: false, roadable: false, soil: false, corners: [0, 0, 0, 0], stone: 5 }, // 2 stone
];

function makeElems(): MapElem[] {
  const out: MapElem[] = [];
  for (let i = 0; i < 256; i++) {
    out.push({
      cuttableTree: false,
      diagonalBlocked: false,
      allBlocked: false,
      wineOrCorn: false,
      canGrow: false,
      dontPlantNear: false,
      stump: 0,
      canBeRemoved: false,
      killByRoad: 'never',
    });
  }
  return out;
}

function loop(count: number): AnimLoop {
  return { steps: new Int16Array(30), count, moveX: 0, moveY: 0 };
}

function makeSpec(work: number): UnitSpec {
  const anim: AnimLoop[][] = [];
  for (let a = 0; a < 14; a++) {
    const dirs: AnimLoop[] = [];
    for (let d = 0; d < 8; d++) dirs.push(loop(a === 1 ? work : 8));
    anim.push(dirs);
  }
  return { speedRaw: 24, anim, miningRange: 0 };
}

function makeSpecs(): UnitSpec[] {
  const specs: UnitSpec[] = [];
  for (let i = 0; i < 10; i++) specs.push(makeSpec(5));
  return specs;
}

function makeHouseSpecs(): (HouseSpec | undefined)[] {
  const out: (HouseSpec | undefined)[] = new Array(30).fill(undefined);
  // script 9 = htWoodcutters (hut): wood 3, stone 2
  out[9] = {
    typeId: 9,
    workerType: 1,
    resIn: [-1, -1, -1, -1],
    resOut: [0, -1, -1, -1],
    productionX: 1,
    workerRest: 5,
    animCounts: [0, 0, 0, 0, 0],
    entranceDx: 0,
    woodPic: 142,
    stonePic: 141,
    maxHealth: 250,
    woodCost: 3,
    stoneCost: 2,
    sight: 10,
  };
  // script 11 = htStore: wood 6, stone 5, entranceDx −1
  out[11] = {
    typeId: 11,
    workerType: -1,
    resIn: [-1, -1, -1, -1],
    resOut: [-1, -1, -1, -1],
    productionX: 1,
    workerRest: 0,
    animCounts: [0, 0, 0, 0, 0],
    entranceDx: -1,
    woodPic: 138,
    stonePic: 137,
    maxHealth: 550,
    woodCost: 6,
    stoneCost: 5,
    sight: 13,
  };
  // script 13 = htSchool: gold in, entranceDx 0
  out[13] = {
    typeId: 13,
    workerType: -1,
    resIn: [7, -1, -1, -1], // gold
    resOut: [-1, -1, -1, -1],
    productionX: 1,
    workerRest: 5,
    animCounts: [30, 30, 30, 30, 30],
    entranceDx: 0,
    woodPic: 10,
    stonePic: 9,
    maxHealth: 300,
    woodCost: 3,
    stoneCost: 3,
    sight: 12,
  };
  // script 14 = htQuarry: stone in? (no inputs; output stone), entranceDx 0
  out[14] = {
    typeId: 14,
    workerType: 10, // stonemason
    resIn: [-1, -1, -1, -1],
    resOut: [1, -1, -1, -1],
    productionX: 1,
    workerRest: 5,
    animCounts: [0, 0, 0, 0, 0],
    entranceDx: 0,
    woodPic: 12,
    stonePic: 11,
    maxHealth: 400,
    woodCost: 2,
    stoneCost: 3,
    sight: 10,
  };
  return out;
}

function makeMap(mapX = 24, mapY = 24, stoneBlock = false): KaMap {
  const tiles = new Uint8Array(mapX * mapY * 4);
  for (let i = 0; i < mapX * mapY; i++) tiles[i * 4 + 3] = 255; // OBJ_NONE
  if (stoneBlock) {
    for (let y = 18; y <= 21; y++) {
      for (let x = 18; x <= 21; x++) tiles[((y - 1) * mapX + (x - 1)) * 4] = 2; // terrain 2 = stone
    }
  }
  return {
    file: 'mini',
    mapX,
    mapY,
    tiles,
    remake: false,
    tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
  };
}

function makeMission(): Mission {
  const streets: { x: number; y: number; owner: number }[] = [];
  for (let x = 5; x <= 14; x++) streets.push({ x, y: 6, owner: 1 });
  for (let y = 6; y <= 11; y++) streets.push({ x: 14, y, owner: 1 });
  for (let x = 5; x <= 14; x++) streets.push({ x, y: 11, owner: 1 });
  return {
    mapName: 'mini',
    maxPlayers: 2,
    humanPlayer: 0,
    houses: [
      { typeId: 9, x: 5, y: 5, owner: 1 },
      { typeId: 0, x: 10, y: 5, owner: 1 },
      { typeId: 11, x: 15, y: 5, owner: 1 },
    ],
    streets,
    units: [
      { typeId: 1, x: 5, y: 3, owner: 1 },
      { typeId: 5, x: 10, y: 3, owner: 1 },
      { typeId: 0, x: 15, y: 3, owner: 1 },
      { typeId: 0, x: 16, y: 3, owner: 1 },
      { typeId: 9, x: 6, y: 7, owner: 1 },
      { typeId: 9, x: 7, y: 7, owner: 1 },
    ],
    wares: [
      { ware: 2, amount: 30, owner: 1 }, // timber
      { ware: 1, amount: 30, owner: 1 }, // stone
      { ware: 7, amount: 20, owner: 1 }, // gold
    ],
  };
}

function makeWorld(o?: { stoneBlock?: boolean }): EconomyWorld {
  const options: EconomyWorldOptions = {
    map: makeMap(24, 24, o?.stoneBlock ?? false),
    tiles: TILES,
    elems: makeElems(),
    unitSpecs: makeSpecs(),
    serfCarry: [],
    houseSpecs: makeHouseSpecs(),
    mission: makeMission(),
  };
  return createEconomyWorld(options);
}

const HAND = 1;

/** A plain (non-XOR-239) mission script: padded with spaces until the decode heuristic sees it. */
function scriptBytes(text: string): Uint8Array {
  let s = text;
  while (missionScriptIsXor239(new TextEncoder().encode(s))) s += ' '.repeat(64);
  return new TextEncoder().encode(s);
}

// ---------------------------------------------------------------------------------------------

test('distance helpers: KMDistanceAbs and GetLengthDiag', () => {
  assert.equal(distanceAbs({ x: 1, y: 1 }, { x: 4, y: 5 }), 7);
  assert.equal(lengthDiag({ x: 1, y: 1 }, { x: 4, y: 1 }), 3);
  assert.ok(Math.abs(lengthDiag({ x: 0, y: 0 }, { x: 1, y: 1 }) - 1.41) < 1e-9);
});

test('parseAiSetups: defaults, !SET_AI_CHARACTER overrides and the advanced-AI flags', () => {
  const script = [
    '!SET_MAX_PLAYER 2',
    '!SET_CURR_PLAYER 0',
    '!SET_USER_PLAYER',
    '!SET_ADVANCED_AI_PLAYER',
    '!CENTER_SCREEN 7 53',
    '!SET_AI_START_POSITION 10 20',
    '!SET_AI_ARMY_TYPE 1',
    '!SET_AI_CHARACTER RECRUTS 5',
    '!SET_AI_CHARACTER WORKER_FACTOR 10',
    '!SET_AI_CHARACTER EQUIP_RATE_IRON 700',
    '!SET_AI_CHARACTER MAX_SOLDIER 30',
    '!SET_AI_CHARACTER AUTO_ATTACK_RANGE 4',
    '!SET_CURR_PLAYER 1',
    '!SET_AI_PLAYER',
    '!SET_AI_NO_BUILD',
    '!SET_AI_AUTO_REPAIR',
    '!SET_AI_UNLIMITED_EQUIP',
  ].join('\n');
  const bytes = scriptBytes(script);
  const info = parseMissionInfo(bytes, 64, 64);
  assert.equal(info.advancedAI[0], true);
  assert.equal(info.classicAI[1], true);
  const setups = parseAiSetups(bytes, info, 64, 64);
  // Hand 0: advanced → NewAI + AutoAttackRange 0; center screen (8,54); start (11,21).
  assert.equal(setups[0].newAI, true);
  assert.equal(setups[0].autoAttackRange, 0);
  assert.equal(setups[0].centerScreen.x, 8);
  assert.equal(setups[0].centerScreen.y, 54);
  assert.equal(setups[0].startPosition.x, 11);
  assert.equal(setups[0].startPosition.y, 21);
  assert.equal(setups[0].armyType, 1);
  assert.equal(setups[0].recruitDelay, 5); // RECRUTS
  assert.equal(setups[0].workerCount, 10); // WORKER_FACTOR
  assert.equal(setups[0].equipRateIron, 700);
  assert.equal(setups[0].maxSoldiers, 30);
  // Hand 1: classic → no newAI, NoBuild → autoBuild false, repair/unlimited flags on.
  assert.equal(setups[1].newAI, false);
  assert.equal(setups[1].autoBuild, false);
  assert.equal(setups[1].isRepairAlways, true);
  assert.equal(setups[1].unlimitedEquip, true);
  // Defaults (KM_AISetup.pas 11–83).
  assert.equal(setups[1].equipRateLeather, 1000);
  assert.equal(setups[1].recruitCount, 5);
  assert.equal(setups[1].autoAttack, false);
  assert.equal(AI_PAR.BUILDER_Shortage_Stone, 11.748311);
});

test('buildHousesMapping: plan vectors, surroundings and the entrance offset', () => {
  const specs = makeHouseSpecs();
  const mapping = buildHousesMapping(specs);
  // The hut (script 9, entranceDx 0): the plan's nonzero cells are rows 3–4, cols 1–3 → vectors
  // (x−3, y−4): (−2,−1), (−1,−1), (0,−1), (−2,0), (−1,0), (0,0).
  const hut = mapping[9];
  assert.equal(hut.tiles.length, 6);
  assert.deepEqual(
    hut.tiles.map((p) => [p.x, p.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    [
      [-2, -1],
      [-2, 0],
      [-1, -1],
      [-1, 0],
      [0, -1],
      [0, 0],
    ],
  );
  // The store (script 11, entranceDx −1): the same cells shift +1 in x.
  const store = mapping[11];
  assert.equal(store.tiles.length, 9);
  assert.ok(store.tiles.some((p) => p.x === -1 && p.y === -1));
  // Distance-1 surroundings exist in all four directions for every type.
  for (const ht of [0, 9, 11, 13, 14]) {
    for (let dir = 0; dir < 4; dir++) assert.ok(mapping[ht].surroundings[1][dir].length > 0);
  }
});

test('Influences: avoid marks, the forest ramp and the ownership flood', () => {
  const w = makeWorld();
  const inf = new Influences(w);
  inf.initAvoidBuilding();
  // A store-entrance area below the mission store (entrance (14,5) → rows 6..7, cols 13..15).
  assert.equal(inf.getAvoid(14, 6), 20); // AVOID_BUILDING_HOUSE_ENTRANCE
  inf.addAvoidBuilding(10, 10, 2);
  assert.equal(inf.getAvoid(10, 10), 255);
  assert.equal(inf.getAvoid(13, 10), 0); // outside the radius
  inf.markForest({ x: 12, y: 12 }, 3, 0.1);
  assert.ok(inf.getAvoid(12, 12) >= AVOID_BUILDING_FOREST_MINIMUM);
  assert.ok(inf.getAvoid(12, 12) <= 254);
  // Ownership: the store's point-below-entrance seeds 255; the flood decays 2 per 3-step tile.
  inf.updateOwnership(HAND);
  assert.equal(inf.getOwnership(HAND, 14, 6), 255);
  assert.equal(inf.getOwnership(HAND, 17, 6), 255 - 2 * 3 * 3);
  assert.equal(inf.getBestOwner(14, 6), HAND);
  const far = inf.getOwnership(HAND, 23, 23);
  assert.ok(far > 0 && far < 255); // still inside the ~40-tile reach, decayed
  assert.ok(inf.canPlaceHouseByInfluence(HAND, 14, 6));
});

test('roadRoute: a straight route, the cost table and the inside-lock block', () => {
  const w = makeWorld();
  const inf = new Influences(w);
  const route = roadRoute(w, inf, HAND, { x: 5, y: 8 }, { x: 10, y: 8 }, 'roads');
  assert.ok(route !== null);
  assert.deepEqual(route[0], { x: 5, y: 8 });
  assert.deepEqual(route[route.length - 1], { x: 10, y: 8 });
  assert.ok(route.length >= 6); // at least the 5 straight steps
  for (let i = 1; i < route.length; i++) {
    assert.equal(Math.max(Math.abs(route[i].x - route[i - 1].x), Math.abs(route[i].y - route[i - 1].y)), 1); // 8-directional steps
  }
  // An inside-lock tile is not walkable for the road planner.
  inf.setAvoid(7, 8, AVOID_BUILDING_HOUSE_INSIDE_LOCK);
  const blocked = roadRoute(w, inf, HAND, { x: 5, y: 8 }, { x: 10, y: 8 }, 'roads');
  assert.ok(blocked === null || blocked.every((p) => !(p.x === 7 && p.y === 8)));
  // The shortcut variant costs the same shape on a free map.
  const shortcut = roadRoute(w, inf, HAND, { x: 5, y: 9 }, { x: 10, y: 9 }, 'shortcuts');
  assert.ok(shortcut !== null);
  assert.equal(shortcut.length, 6);
});

test('school training: queue → gold → the self-train task spawns the citizen', () => {
  const w = makeWorld();
  const school = w.spawnHouse(13, 8, 8, HAND); // htSchool, entrance (8,8)
  assert.equal(w.schoolQueueCount(school.uid), 0);
  // A builder in the queue (the school starts training when gold arrives).
  assert.equal(w.schoolAddUnitToQueue(school.uid, UT_BUILDER, 1), 1);
  assert.equal(w.schoolQueueCount(school.uid), 1);
  assert.equal(w.schoolUnitWip(school.uid), 0); // no gold yet → no unit created
  assert.equal(w.addWareToHouseFromScript(school.uid, 7, 1), true); // gold
  const wip = w.schoolUnitWip(school.uid);
  assert.notEqual(wip, 0);
  assert.equal(w.schoolQueueCount(school.uid), 1); // slot 0 = the unit in training
  const buildersBefore = w.constructionState(HAND).workers.length;
  for (let i = 0; i < 200; i++) w.tick();
  assert.equal(w.schoolUnitWip(school.uid), 0); // training complete
  assert.equal(w.schoolQueueCount(school.uid), 0);
  assert.equal(w.handUnitCount(HAND, UT_BUILDER), buildersBefore + 1);
  assert.equal(w.constructionState(HAND).workers.length, buildersBefore + 1);
  // The gold was consumed by the training (1 unit of gold).
  assert.equal(w.wareCount(school, 7), 0);
});

test('BuildFF: candidates around the store, the forest mark blocks them', () => {
  const w = makeWorld();
  const inf = new Influences(w);
  inf.initAvoidBuilding();
  inf.updateOwnership(HAND);
  const eye = new Eye(w, inf);
  eye.afterMissionInit();
  eye.ownerUpdate(HAND);
  eye.buildFF.setTick(1);
  const store = w.findFirstHouse(HT_STORE, HAND);
  assert.ok(store !== null);
  const below = { x: (store as { entrance: { x: number; y: number } }).entrance.x, y: (store as { entrance: { x: number; y: number } }).entrance.y + 1 };
  eye.buildFF.findPlaceForHouse(
    { houseType: HT_WOODCUTTERS, ignoreTrees: false, ignoreAvoidBuilding: false, maxCnt: 20, maxDist: 30 },
    [below],
    true,
  );
  const free = eye.buildFF.locs.length;
  assert.ok(free > 0);
  const found = eye.buildFF.locs.slice();
  // Reserve every found candidate with a forest ramp → canBePlacedHouse rejects them all.
  for (const p of found) inf.markForest(p, 3, 0.01);
  eye.buildFF.setTick(2);
  eye.buildFF.findPlaceForHouse(
    { houseType: HT_WOODCUTTERS, ignoreTrees: false, ignoreAvoidBuilding: false, maxCnt: 20, maxDist: 30 },
    [below],
    true,
  );
  for (const p of found) assert.equal(eye.buildFF.canBePlacedHouse(p), false);
});

test('placeFirstStorehouse: a store with the three roads below, unlocking the school', () => {
  const w = makeWorld();
  const inf = new Influences(w);
  inf.initAvoidBuilding();
  const eye = new Eye(w, inf);
  eye.afterMissionInit();
  eye.ownerUpdate(HAND);
  // A stone mining spot (the map has none) seeds the placement.
  eye.stoneMiningTiles.push({ x: 20, y: 20 });
  inf.updateOwnership(HAND);
  const uid = placeFirstStorehouse(w, eye, HAND, { x: 21, y: 22 });
  assert.notEqual(uid, 0);
  const store = w.houseByUid(uid);
  assert.ok(store !== null);
  assert.equal(store?.buildState, 'done');
  // AddFirstStorehouse's three road tiles below the entrance.
  assert.equal(w.tileHasRoad(store!.entrance.x, store!.entrance.y + 1), true);
  // The store's Activate (hbsDone) unlocked the school (ReleasedBy = htStore).
  assert.equal(w.houseCanBuild(HAND, HT_SCHOOL), true);
});

test('AiPlayer: the economy half plans the school on the mini village and stays deterministic', () => {
  const w = makeWorld();
  const inf = new Influences(w);
  inf.initAvoidBuilding();
  const eye = new Eye(w, inf);
  eye.afterMissionInit();
  eye.ownerUpdate(HAND);
  inf.updateOwnership(HAND);
  w.houseCreatedFor(HAND, HT_STORE); // the mission store's Activate (see applyMissionHouseUnlocks)
  const setup = parseAiSetups(
    scriptBytes('!SET_CURR_PLAYER 1\n!SET_ADVANCED_AI_PLAYER\n'),
    parseMissionInfo(scriptBytes('!SET_MAX_PLAYER 2\n!SET_CURR_PLAYER 1\n!SET_ADVANCED_AI_PLAYER\n'), 24, 24),
    24,
    24,
  )[1];
  const ai = new AiPlayer(w, inf, eye, setup);
  ai.afterMissionInit();
  for (let i = 0; i < 400; i++) {
    ai.updateState(w.tickCount + 1);
    w.tick();
  }
  // The school gate: the predictor requires a school and the planner/plan API has a school plan.
  assert.ok(ai.planner.plannedHouses[HT_SCHOOL].count >= 1);
  const schoolPlan = ai.planner.plannedHouses[HT_SCHOOL].plans[0];
  assert.ok(schoolPlan.placed || schoolPlan.houseReservation);
  // The planner sees the mission houses (store + hut + sawmill of hand 1).
  assert.equal(ai.planner.plannedHouses[HT_STORE].completed, 1);
  assert.equal(ai.planner.plannedHouses[HT_WOODCUTTERS].completed, 1);
  assert.equal(ai.planner.plannedHouses[HT_SAWMILL].completed, 1);
  // Determinism: a second identical run produces the same observable state.
  const snapshot = (): string =>
    JSON.stringify({
      rng: w.rngState,
      plans: w.constructionState(HAND).plans.map((p) => [p.typeId, p.x, p.y, p.status]),
      fields: w.constructionState(HAND).fields.map((f) => [f.x, f.y, f.fieldType, f.status]),
      houses: w.houses.map((h) => [h.typeId, h.x, h.y, h.buildState, h.buildingProgress]),
      units: w.units.map((u) => [u.type, u.posF.x, u.posF.y, u.taskKind]),
      planned: ai.planner.plannedHouses.map((a) => [a.count, a.completed, a.underConstruction, a.planned]),
    });
  const first = snapshot();
  const w2 = makeWorld();
  const inf2 = new Influences(w2);
  inf2.initAvoidBuilding();
  const eye2 = new Eye(w2, inf2);
  eye2.afterMissionInit();
  inf2.updateOwnership(HAND);
  w2.houseCreatedFor(HAND, HT_STORE);
  const ai2 = new AiPlayer(w2, inf2, eye2, setup);
  ai2.afterMissionInit();
  for (let i = 0; i < 400; i++) {
    ai2.updateState(w2.tickCount + 1);
    w2.tick();
  }
  assert.equal(
    JSON.stringify({
      rng: w2.rngState,
      plans: w2.constructionState(HAND).plans.map((p) => [p.typeId, p.x, p.y, p.status]),
      fields: w2.constructionState(HAND).fields.map((f) => [f.x, f.y, f.fieldType, f.status]),
      houses: w2.houses.map((h) => [h.typeId, h.x, h.y, h.buildState, h.buildingProgress]),
      units: w2.units.map((u) => [u.type, u.posF.x, u.posF.y, u.taskKind]),
      planned: ai2.planner.plannedHouses.map((a) => [a.count, a.completed, a.underConstruction, a.planned]),
    }),
    first,
  );
});

test('decodeMissionScript + parseAiSetups agree on a XOR-239 mission script', () => {
  const script = '!SET_CURR_PLAYER 1\n!SET_ADVANCED_AI_PLAYER\n!SET_AI_CHARACTER RECRUTS 7\n';
  const plain = new TextEncoder().encode(script);
  const xored = Uint8Array.from(plain, (b) => b ^ 239);
  assert.equal(decodeMissionScript(xored).includes('!SET_ADVANCED_AI_PLAYER'), true);
  const info = parseMissionInfo(xored, 32, 32);
  const setups = parseAiSetups(xored, info, 32, 32);
  assert.equal(setups[1].newAI, true);
  assert.equal(setups[1].recruitDelay, 7);
});


