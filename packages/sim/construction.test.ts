// construction.test.ts — the M5a construction slice on a synthetic mini village
// (docs/M5-SPIKE.md §1a/§2). Run: node --test packages/sim/construction.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyWorld } from './economy.ts';
import type { EconomyWorld, EconomyWorldOptions } from './economy.ts';
import { MAX_WORKERS, maxWorkersForHouse, plansWoodDemands, plansStoneDemands, canAddHousePlan } from './construction.ts';
import type { KaMap } from '../map/map.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import type { Mission } from '../mission/mission.ts';

const TILES: TileFlags[] = [
  { walkable: true, roadable: true, soil: true, corners: [0, 0, 0, 0] }, // 0 grass
  { walkable: false, roadable: false, soil: false, corners: [0, 0, 0, 0] }, // 1 water
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

/** 14 actions × 8 dirs; uaWork (action 1) gets `work` frames. */
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
  // script 9 = htWoodcutters (hut): wood 3, stone 2, entranceDx 0 (the real houses.dat values)
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
  // script 11 = htStore: wood 6, stone 5, entranceDx −1 (the real houses.dat values)
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
  // script 0 = htSawmill: wood 4, stone 3, entranceDx −1
  out[0] = {
    typeId: 0,
    workerType: 5,
    resIn: [0, -1, -1, -1],
    resOut: [2, -1, -1, -1],
    productionX: 2,
    workerRest: 5,
    animCounts: [30, 10, 0, 0, 30],
    entranceDx: -1,
    woodPic: 1,
    stonePic: 0,
    maxHealth: 350,
    woodCost: 4,
    stoneCost: 3,
    sight: 10,
  };
  return out;
}

function makeMap(mapX = 24, mapY = 24): KaMap {
  const tiles = new Uint8Array(mapX * mapY * 4); // terrain 0 (grass), height 0, rotation 0
  for (let i = 0; i < mapX * mapY; i++) tiles[i * 4 + 3] = 255; // OBJ_NONE
  return {
    file: 'mini',
    mapX,
    mapY,
    tiles,
    remake: false,
    tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
  };
}

/** All content belongs to hand 1 (like the tutorial's economy village). */
function makeMission(): Mission {
  const streets: { x: number; y: number; owner: number }[] = [];
  for (let x = 5; x <= 14; x++) streets.push({ x, y: 6, owner: 1 }); // the store row
  for (let y = 6; y <= 11; y++) streets.push({ x: 14, y, owner: 1 }); // the link column
  for (let x = 5; x <= 14; x++) streets.push({ x, y: 11, owner: 1 }); // the site row
  return {
    mapName: 'mini',
    maxPlayers: 2,
    humanPlayer: 0,
    houses: [
      { typeId: 9, x: 5, y: 5, owner: 1 }, // hut: entrance (5,5), below (5,6)
      { typeId: 0, x: 10, y: 5, owner: 1 }, // sawmill: entrance (9,5), below (9,6)
      { typeId: 11, x: 15, y: 5, owner: 1 }, // store: entrance (14,5), below (14,6)
    ],
    streets,
    units: [
      { typeId: 1, x: 5, y: 3, owner: 1 }, // woodcutter
      { typeId: 5, x: 10, y: 3, owner: 1 }, // carpenter
      { typeId: 0, x: 15, y: 3, owner: 1 }, // serf
      { typeId: 0, x: 16, y: 3, owner: 1 }, // serf
      { typeId: 9, x: 6, y: 7, owner: 1 }, // builder A
      { typeId: 9, x: 7, y: 7, owner: 1 }, // builder B
    ],
    wares: [
      { ware: 2, amount: 10, owner: 1 }, // timber
      { ware: 1, amount: 10, owner: 1 }, // stone
    ],
  };
}

function makeWorld(wares?: { ware: number; amount: number; owner: number }[]): EconomyWorld {
  const mission = makeMission();
  if (wares !== undefined) mission.wares = wares;
  const o: EconomyWorldOptions = {
    map: makeMap(),
    tiles: TILES,
    elems: makeElems(),
    unitSpecs: makeSpecs(),
    serfCarry: [],
    houseSpecs: makeHouseSpecs(),
    mission,
  };
  return createEconomyWorld(o);
}

function run(w: EconomyWorld, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.tick();
}

const HAND = 1;

test('MAX_WORKERS is the frozen positional table (barracks 12, store 10, sawmill 8, woodcutters 6, gold mine 3)', () => {
  assert.equal(maxWorkersForHouse(21), 12); // script 21 = htBarracks
  assert.equal(maxWorkersForHouse(11), 10); // script 11 = htStore
  assert.equal(maxWorkersForHouse(0), 8); // script 0 = htSawmill
  assert.equal(maxWorkersForHouse(9), 6); // script 9 = htWoodcutters
  assert.equal(maxWorkersForHouse(5), 3); // script 5 = htGoldMine
  assert.equal(maxWorkersForHouse(26), 0); // script 26 = htNone
  assert.equal(MAX_WORKERS.length, 31);
});

test('plan API: canAddHousePlan terrain + tile rules, AddHousePlan shifts the entrance, RemHousePlan closes', () => {
  const w = makeWorld();
  // Open grass at (8,10): the hut's BuildArea rows 3–4 are (6..8, 9..10).
  assert.equal(w.canAddHousePlan(HAND, 9, 8, 10), true);
  // Next to the sawmill (its 3×3 house lock): (10,5) cells cover (8,4)..(11,5).
  assert.equal(w.canAddHousePlan(HAND, 9, 9, 5), false);
  // Out of map coords (inset 1 from the border).
  assert.equal(w.canAddHousePlan(HAND, 9, 1, 10), false);

  const plan = w.addHousePlan(HAND, 9, 8, 10);
  assert.equal(plan.x, 8); // entranceDx 0
  assert.equal(plan.status, 'open');
  assert.equal(plan.workerUid, 0);
  assert.equal(w.plansWoodDemands(HAND), 3);
  assert.equal(w.plansStoneDemands(HAND), 2);
  assert.equal(plansWoodDemands(w.constructionState(HAND)), 3);

  // A plan of a type with EntranceOffsetX −1 (the store): Loc = entrance + 1.
  const storePlan = w.addHousePlan(HAND, 11, 10, 10);
  assert.equal(storePlan.x, 11);
  assert.equal(storePlan.y, 10);
  assert.equal(w.plansWoodDemands(HAND), 3 + 6);
  assert.equal(w.plansStoneDemands(HAND), 2 + 5);

  // HasHousePlan works on every BuildArea tile of the plan.
  assert.equal(w.hasHousePlan(HAND, 6, 9), true);
  assert.equal(w.hasHousePlan(HAND, 5, 9), false);
  // RemHousePlan by a covered tile (the store plan: (11,10) row 4 col 2 → (10,10)).
  const removed = w.remHousePlan(HAND, 10, 10);
  assert.equal(removed, storePlan);
  assert.equal(storePlan.status, 'empty');
  assert.equal(storePlan.typeId, 26); // htNone
  assert.equal(w.plansWoodDemands(HAND), 3);
  assert.equal(w.hasHousePlan(HAND, 10, 10), false);
});

test('field plan API: road/corn rules, HasField, FieldCount, RemFieldPlan', () => {
  const w = makeWorld();
  assert.equal(w.canAddFieldPlan(HAND, 10, 10, 'road'), true);
  assert.equal(w.canAddFieldPlan(HAND, 10, 6, 'road'), false); // (10,6) is already a street
  assert.equal(w.canAddFieldPlan(HAND, 12, 10, 'corn'), true);
  assert.equal(w.canAddFieldPlan(HAND, 0, 10, 'corn'), false); // outside the map
  assert.equal(w.canAddFieldPlan(HAND, 10, 10, 'none'), false);

  const road = w.addFieldPlan(HAND, 10, 10, 'road');
  assert.equal(road.status, 'open');
  assert.equal(w.hasFieldPlan(HAND, 10, 10), 'road');
  assert.equal(w.fieldPlanCount(HAND, 'road'), 1);
  assert.equal(w.fieldPlanCount(HAND, 'corn'), 0);

  // A road plan blocks a house plan on its tile (CanAddHousePlan checks ally field plans).
  assert.equal(w.canAddHousePlan(HAND, 9, 10, 10), false);

  const corn = w.addFieldPlan(HAND, 12, 10, 'corn');
  assert.equal(w.fieldPlanCount(HAND, 'corn'), 1);
  assert.equal(w.remFieldPlan(HAND, 12, 10), corn);
  assert.equal(corn.status, 'empty');
  assert.equal(w.hasFieldPlan(HAND, 12, 10), 'none');
});

test('the builder registry lists hand 1 builders; the staggered pass assigns plans and digs the site', () => {
  const w = makeWorld();
  const state = w.constructionState(HAND);
  assert.equal(state.workers.length, 2); // the two utBuilder units
  assert.equal(w.constructionState(0).workers.length, 0);

  const plan = w.addHousePlan(HAND, 9, 8, 10);
  run(w, 60);
  // The plan was taken and the WIP house exists (hbsNoGlyph).
  assert.equal(plan.status, 'empty'); // closed by the task's CancelThePlan at phase 1
  const wip = w.houses.find((h) => h.typeId === 9 && h.x === 8 && h.y === 10);
  assert.ok(wip !== undefined, 'the WIP house must exist after phase 1');
  assert.equal(wip.buildState, 'noGlyph');

  run(w, 400);
  // The dig completed: hbsWood + the ready list + both construction demands.
  assert.equal(wip.buildState, 'wood');
  assert.equal(w.siteOf(wip.uid) !== null, true);
  assert.equal(w.events.some((e) => e.text.startsWith('house-plan-digged')), true);
  // All 6 BuildArea cells are dug (tlDigged → no tpWalk).
  for (const [x, y] of [[6, 9], [7, 9], [8, 9], [6, 10], [7, 10], [8, 10]]) {
    assert.equal(w.tileWalkable(x, y), false, `tile (${x},${y}) must be dug`);
  }
  // The entrance tile got its road during the dig (KM_UnitTaskBuild.pas 742–743).
  assert.equal(w.isRoadTile(8, 10), true);
  assert.equal(w.plansWoodDemands(HAND), 0); // the plan was closed when the house was created
});

test('the full build: materials → wood → stone → done → Activate (locks + demands)', () => {
  const w = makeWorld();
  const plan = w.addHousePlan(HAND, 9, 8, 10);
  run(w, 1500);
  assert.equal(plan.status, 'empty');
  const hut = w.houses.find((h) => h.typeId === 9 && h.x === 8 && h.y === 10);
  assert.ok(hut !== undefined);
  assert.equal(hut.buildState, 'done');
  assert.equal(hut.buildingProgress, 250); // (WoodCost 3 + StoneCost 2) × 50
  assert.equal(hut.readyToBeBuilt, false);
  // The supplies are clamped to the costs (WareAddToBuild, KM_Houses.pas 1812–1813).
  assert.equal(hut.buildSupplyWood >= 0 && hut.buildSupplyWood <= 3, true);
  assert.equal(hut.buildSupplyStone >= 0 && hut.buildSupplyStone <= 2, true);
  // The delivered counters the AI reads (KM_Houses.pas 1197–1216).
  assert.equal(w.houseBuildWoodDelivered(hut), 3);
  assert.equal(w.houseBuildStoneDelivered(hut), 2);
  assert.equal(w.houseBuildResourceDelivered(hut), 5);
  assert.equal(w.houseIsComplete(hut), true);
  // Activate: the lock chain released the sawmill (hut → sawmill, KM_HandLocks.pas 69–83).
  assert.equal(w.houseCanBuild(HAND, 0), true);
  assert.equal(w.houseCanBuild(HAND, 11), true); // the store was released at the start
  assert.equal(w.houseCanBuild(HAND, 21), false); // stables stay locked (farm needed)
  assert.equal(w.events.some((e) => e.text.startsWith('house-activated')), true);
  // The ready list drops the complete site (RemoveExtraHouses) and the builders go idle again.
  assert.equal(w.siteOf(hut.uid) !== null, false);
  assert.equal(w.units.filter((u) => u.taskKind === 'buildHouse' || u.taskKind === 'buildHouseArea').length, 0);
  // The house accepts timber/stone deliveries (the site demands are gone).
  assert.equal(w.houseCheckResToBuild(hut), false);
  // The house gained the door road (SetHouse hsBuilt) and its health is the full MaxHealth.
  assert.equal(w.isRoadTile(8, 10), true);
  assert.equal(w.houseHealth(hut), 250);
  assert.equal(w.houseMaxHealth(hut), 250);
});

test('a road plan is built through the stone-wait phase (a serf delivers stone to the builder)', () => {
  const w = makeWorld();
  const road = w.addFieldPlan(HAND, 10, 10, 'road');
  run(w, 400);
  assert.equal(road.status, 'empty');
  assert.equal(w.isRoadTile(10, 10), true);
  assert.equal(w.tileWalkable(10, 10), true);
  // The stone was carried by a serf to the builder unit (dkToUnit).
  assert.equal(w.events.some((e) => e.text.startsWith('road-digged')), true);
  assert.equal(w.events.some((e) => e.text.startsWith('ware-delivered') && e.text.includes('unit#')), true);
  assert.equal(w.events.some((e) => e.text.startsWith('road-built')), true);
  // No field plans are left open.
  assert.equal(w.constructionState(HAND).fields.filter((f) => f.status !== 'empty').length, 0);
});

test('a corn field plan is built and reads back as TileIsCornField', () => {
  const w = makeWorld();
  const corn = w.addFieldPlan(HAND, 12, 10, 'corn');
  run(w, 200);
  assert.equal(corn.status, 'empty');
  assert.equal(w.tileHasCornField(12, 10), true);
  assert.equal(w.tileHasWineField(12, 10), false);
  assert.equal(w.events.some((e) => e.text.startsWith('field-built')), true);
});

test('the ready list assignment respects CheckResToBuild (a builder waits for materials)', () => {
  // A store with no timber/stone offers: the dug site stays in the ready list, unbuilt.
  const w = makeWorld([]);
  w.addHousePlan(HAND, 9, 8, 10);
  run(w, 400); // the dig is done, hbsWood, both demands created
  const hut = w.houses.find((h) => h.typeId === 9 && h.x === 8 && h.y === 10);
  assert.ok(hut !== undefined);
  assert.equal(hut.buildState, 'wood');
  assert.equal(w.houseCheckResToBuild(hut), false); // no materials yet
  // With no supply no builder may take the site (BestBid/GetAvailableJobsCount gate).
  const workers = w.units.filter((u) => u.type === 9);
  assert.equal(workers.some((u) => u.taskKind === 'buildHouse'), false);
  assert.equal(w.siteOf(hut.uid) !== null, true);
  assert.equal(w.plansWoodDemands(HAND), 0);
  // The site's demands are open but nothing offers timber/stone.
  assert.equal(hut.buildingProgress, 0);
});

test('two identical worlds with plans stay identical (deterministic)', () => {
  const a = makeWorld();
  const b = makeWorld();
  for (const w of [a, b]) {
    w.addHousePlan(HAND, 9, 8, 10);
    w.addFieldPlan(HAND, 10, 10, 'road');
    w.addFieldPlan(HAND, 12, 10, 'corn');
  }
  run(a, 1200);
  run(b, 1200);
  assert.equal(a.rngState, b.rngState);
  assert.equal(a.events.length, b.events.length);
  assert.deepEqual(
    a.houses.map((h) => [h.uid, h.typeId, h.buildState, h.buildingProgress, h.buildSupplyWood, h.buildSupplyStone]),
    b.houses.map((h) => [h.uid, h.typeId, h.buildState, h.buildingProgress, h.buildSupplyWood, h.buildSupplyStone]),
  );
  assert.deepEqual(
    a.units.map((u) => [u.uid, u.posF.x, u.posF.y, u.dir, u.taskKind, u.carry]),
    b.units.map((u) => [u.uid, u.posF.x, u.posF.y, u.dir, u.taskKind, u.carry]),
  );
  assert.deepEqual(
    a.events.map((e) => e.text),
    b.events.map((e) => e.text),
  );
});

test('a removed plan cancels the builder task and can be taken again', () => {
  const w = makeWorld();
  const plan = w.addHousePlan(HAND, 9, 8, 10);
  run(w, 1); // assigned (the construction pass runs when tick mod handCount = hand)
  assert.equal(plan.status, 'taken');
  w.remHousePlan(HAND, 6, 9);
  assert.equal(plan.status, 'empty');
  run(w, 5);
  assert.equal(w.units.some((u) => u.taskKind === 'buildHouseArea'), false);
});

test('canAddHousePlan blocks a tile covered by an allied plan (LocHasNoAllyPlans)', () => {
  const w = makeWorld();
  const plan = w.addHousePlan(HAND, 9, 8, 10);
  assert.ok(plan !== undefined);
  // A second hut one tile right of the first: its BuildArea would touch the first plan's cells.
  assert.equal(w.canAddHousePlan(HAND, 9, 9, 10), false);
  assert.equal(canAddHousePlan(w, HAND, 9, 9, 10), false);
  // Far enough away it works.
  assert.equal(w.canAddHousePlan(HAND, 9, 12, 14), true);
});
