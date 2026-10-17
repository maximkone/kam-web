// economy.test.ts — the M3 v0 economy sim on a synthetic mini village (docs/M3-SPIKE.md 2.5–2.7).
// Run: node --test packages/sim/economy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyWorld, applyDemoScenario, CHOPABLE_TREES, TREE_AGE_FULL } from './economy.ts';
import type { EconomyWorld, EconomyWorldOptions } from './economy.ts';
import type { KaMap } from '../map/map.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import type { Mission } from '../mission/mission.ts';

const TILES: TileFlags[] = [
  { walkable: true, roadable: true, corners: [0, 0, 0, 0] }, // 0 grass
  { walkable: false, roadable: false, corners: [0, 0, 0, 0] }, // 1 water
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
    });
  }
  // Mirror the real file: every CHOPABLE_TREES object blocks diagonals, none blocks tpWalk.
  for (const t of CHOPABLE_TREES) for (const obj of t) out[obj].diagonalBlocked = true;
  return out;
}

function loop(count: number): AnimLoop {
  return { steps: new Int16Array(30), count, moveX: 0, moveY: 0 };
}

/** 14 actions × 8 dirs; uaWork (action 1) gets `work` frames. */
function makeSpec(work: number, miningRange = 0): UnitSpec {
  const anim: AnimLoop[][] = [];
  for (let a = 0; a < 14; a++) {
    const dirs: AnimLoop[] = [];
    for (let d = 0; d < 8; d++) dirs.push(loop(a === 1 ? work : 8));
    anim.push(dirs);
  }
  return { speedRaw: 24, anim, miningRange };
}

function makeSpecs(): UnitSpec[] {
  const specs: UnitSpec[] = [];
  for (let i = 0; i < 6; i++) specs.push(makeSpec(5, i === 1 ? 10 : 0));
  return specs;
}

function makeHouseSpecs(): (HouseSpec | undefined)[] {
  const out: (HouseSpec | undefined)[] = new Array(30).fill(undefined);
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
  };
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
  };
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
  };
  return out;
}

function makeMap(mapX = 24, mapY = 24): KaMap {
  return {
    file: 'mini',
    mapX,
    mapY,
    tiles: new Uint8Array(mapX * mapY * 4), // terrain 0 (grass), obj 255 = OBJ_NONE
    remake: false,
    tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
  };
}

/** All content belongs to hand 1 (like the tutorial's economy village). */
function makeMission(): Mission {
  return {
    mapName: 'mini',
    maxPlayers: 2,
    humanPlayer: 0,
    houses: [
      { typeId: 9, x: 5, y: 5, owner: 1 }, // hut: entrance (5,5), below (5,6)
      { typeId: 0, x: 10, y: 5, owner: 1 }, // sawmill: entrance (9,5), below (9,6)
      { typeId: 11, x: 15, y: 5, owner: 1 }, // store: entrance (14,5), below (14,6)
    ],
    streets: [5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map((x) => ({ x, y: 6, owner: 1 })),
    units: [
      { typeId: 1, x: 5, y: 3, owner: 1 }, // woodcutter
      { typeId: 5, x: 10, y: 3, owner: 1 }, // carpenter
      { typeId: 0, x: 15, y: 3, owner: 1 }, // serf
      { typeId: 0, x: 16, y: 3, owner: 1 }, // serf
    ],
    wares: [{ ware: 0, amount: 100, owner: 1 }], // store trunks
  };
}

function makeWorld(): EconomyWorld {
  const o: EconomyWorldOptions = {
    map: makeMap(),
    tiles: TILES,
    elems: makeElems(),
    unitSpecs: makeSpecs(),
    serfCarry: [],
    houseSpecs: makeHouseSpecs(),
    mission: makeMission(),
  };
  return createEconomyWorld(o);
}

function run(w: EconomyWorld, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.tick();
}

test('world build: houses complete, footprints removed, roads marked, store stock from !ADD_WARE', () => {
  const w = makeWorld();
  assert.equal(w.houses.length, 3);
  assert.equal(w.units.length, 4);
  assert.equal(w.handCount, 2);
  assert.equal(w.roadTileCount, 10);

  const hut = w.findFirstHouse(9) as NonNullable<ReturnType<EconomyWorld['findFirstHouse']>>;
  assert.deepEqual(hut.entrance, { x: 5, y: 5 });
  // htWoodcutters PlanYX rows 3–4 → tiles (3,4),(4,4),(5,4),(3,5),(4,5),(5,5) are blocked.
  for (const [x, y] of [[3, 4], [4, 4], [5, 4], [3, 5], [4, 5], [5, 5]]) {
    assert.equal(w.grid.walk[y * (w.grid.mapX + 1) + x], 0, `tile (${x},${y}) must be a house tile`);
  }
  const store = w.findFirstHouse(11, 1) as NonNullable<ReturnType<EconomyWorld['findFirstHouse']>>;
  assert.equal(w.wareCount(store, 0), 100); // 100 trunks
  assert.ok(w.isRoadTile(9, 6) && w.isRoadTile(14, 6) && !w.isRoadTile(9, 5));
  assert.equal(w.roadGrid.walk[6 * (w.grid.mapX + 1) + 9], 1); // road grid walkable
});

test('worker assignment: woodcutter and carpenter find their houses and go inside', () => {
  const w = makeWorld();
  run(w, 200);
  const woodcutter = w.units[0];
  const carpenter = w.units[1];
  assert.equal(woodcutter.homeUid, w.houses[0].uid);
  assert.equal(carpenter.homeUid, w.houses[1].uid);
  assert.equal(woodcutter.inside, true);
  assert.equal(carpenter.inside, true);
  assert.equal(w.houses[0].workerUid, woodcutter.uid);
  assert.equal(w.houses[1].workerUid, carpenter.uid);
  assert.notEqual(w.houses[0].state, 'empty'); // idle or working (a chop cycle may already run)
  assert.notEqual(w.houses[1].state, 'empty');
  assert.ok(w.events.some((e) => e.text.startsWith('worker-assigned')));
});

test('store trunks are delivered to the sawmill (offer → demand → serf)', () => {
  const w = makeWorld();
  run(w, 400);
  const sawmill = w.houses[1];
  const delivered = w.events.filter((e) => e.text.startsWith('ware-delivered') && e.text.includes(`house#${sawmill.uid}`));
  assert.ok(delivered.length >= 1, 'at least one trunk must reach the sawmill');
  assert.ok(w.wareCount(sawmill, 0) >= 0);
});

test('carpenter saw cycle: 361 ticks per 2 timber, timber reaches the store', () => {
  const w = makeWorld();
  applyDemoScenario(w);
  run(w, 3000);
  const timberOut = w.events.filter((e) => e.text.startsWith('timber-out')).map((e) => e.tick);
  assert.ok(timberOut.length >= 4, `expected several productions, got ${timberOut.length}`);
  const deltas: number[] = [];
  for (let i = 1; i < timberOut.length; i++) deltas.push(timberOut[i] - timberOut[i - 1]);
  assert.deepEqual(deltas.slice(-3), [361, 361, 361]);

  const store = w.houses[2];
  assert.ok(w.wareCount(store, 2) >= 2, 'timber must reach the store');
  assert.ok(w.events.some((e) => e.text.startsWith('ware-delivered') && e.text.includes(`house#${store.uid}`)));
});

test('woodcutter chops a demo tree: tree-fell, then the stump after the fall animation', () => {
  const w = makeWorld();
  applyDemoScenario(w);
  run(w, 3000);
  const fell = w.events.find((e) => e.text.startsWith('tree-fell'));
  assert.ok(fell !== undefined, 'a tree must fall');
  const m = /\((\d+),(\d+)\)/.exec(fell.text);
  assert.ok(m !== null);
  const x = Number(m[1]);
  const y = Number(m[2]);
  const at = w.treeAt(x, y);
  assert.ok(at !== null);
  assert.equal(at.age, 0); // ChopTree ran after FALL_TICKS
  assert.equal(at.obj, 37); // species 1 stump
  assert.ok(w.events.some((e) => e.text.startsWith('trunk-out')), 'the hut must gain a trunk');
});

test('two worlds with the same seed stay identical (deterministic)', () => {
  const a = makeWorld();
  const b = makeWorld();
  applyDemoScenario(a);
  applyDemoScenario(b);
  run(a, 800);
  run(b, 800);
  assert.equal(a.rngState, b.rngState);
  assert.equal(a.events.length, b.events.length);
  assert.deepEqual(
    a.units.map((u) => [u.posF.x, u.posF.y, u.dir, u.carry, u.inside, u.homeUid, u.taskKind]),
    b.units.map((u) => [u.posF.x, u.posF.y, u.dir, u.carry, u.inside, u.homeUid, u.taskKind]),
  );
});

test('applyDemoScenario plants 12 full trees within Chebyshev 9 of the hut and orders 20 timber', () => {
  const w = makeWorld();
  applyDemoScenario(w);
  const hut = w.houses[0];
  const center = { x: hut.entrance.x, y: hut.entrance.y + 1 };
  let planted = 0;
  for (let y = 1; y <= w.grid.mapY - 1; y++) {
    for (let x = 1; x <= w.grid.mapX - 1; x++) {
      const at = w.treeAt(x, y);
      if (at === null || at.obj !== 90 || at.age !== TREE_AGE_FULL) continue;
      if (Math.max(Math.abs(x - center.x), Math.abs(y - center.y)) > 9) continue;
      planted += 1;
    }
  }
  assert.equal(planted, 12);
  // The order: the store must receive timber (run long enough for the sawmill to produce).
  run(w, 4000);
  assert.ok(w.wareCount(w.houses[2], 2) >= 2);
});

// M4 fix (worker J's crash repro): destroying a house while economy tasks reference it must not
// crash the next tick. Houses are resolved by uid, a destroyed house is deleted only when the pass
// runs (KM_HouseCollection.pas 426–436), and an in-flight delivery abandons gracefully
// (KM_UnitTaskDelivery.pas 361; the ware returns to the from-house when it still exists).
test('demolishing a house mid-delivery abandons the delivery and never crashes', () => {
  const w = makeWorld();
  applyDemoScenario(w);
  const store = w.houses[2]; // the hand-1 store: the demo timber demand target
  let inFlight = false;
  for (let i = 0; i < 3000 && !inFlight; i++) {
    w.tick();
    inFlight = w.units.some((u) => u.taskKind === 'deliver');
  }
  assert.ok(inFlight, 'a delivery must be in flight');
  assert.ok(w.events.some((e) => e.text.startsWith('delivery-assigned')));

  w.damageHouse(store.uid, 1_000_000, 0);
  assert.equal(store.destroyed, true);
  const demolishTick = w.tickCount;

  // No exception on the following ticks (the repro crashed on the next tick); the in-flight
  // delivery is abandoned.
  let abandoned = false;
  for (let i = 0; i < 300 && !abandoned; i++) {
    w.tick();
    abandoned = w.events.some((e) => e.text.startsWith('delivery-abandoned'));
  }
  assert.ok(abandoned, 'the delivery must be abandoned gracefully');
  for (let i = 0; i < 200; i++) w.tick(); // the crash happened one tick after the demolish

  assert.equal(w.houses.length, 2); // the store was deleted one tick after Demolish
  assert.ok(w.tickCount - demolishTick >= 200, 'the world must keep ticking past the demolish');
  assert.ok(!w.units.some((u) => u.homeUid === store.uid));
  assert.ok(w.units.every((u) => !u.inside || u.homeUid !== 0), 'no unit may stay inside a gone house');
  assert.equal(w.units.filter((u) => u.taskKind === 'deliver').length, 0, 'no delivery may outlive its houses');
});
