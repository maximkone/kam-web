// economy-production.test.ts — M5e production: the quarry (stonemason), the weapon workshop (carpenter,
// PickOrder), the armour workshop and the barracks' own warfare stock, on a synthetic mini world.
// Run: node --test packages/sim/economy-production.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyWorld } from './economy.ts';
import type { EconomyWorld, EconomyWorldOptions } from './economy.ts';
import type { Mission } from '../mission/mission.ts';
import { WT_STONE, WT_TIMBER, WT_AXE } from '../assets/wares.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { KaMap } from '../map/map.ts';

const TILE_STONE = 1;
const TILES: TileFlags[] = [
  { walkable: true, roadable: true, soil: true, corners: [0, 0, 0, 0] },
  { walkable: true, roadable: true, soil: false, corners: [0, 0, 0, 0], stone: 3 },
];
const HT_STORE = 11;
const HT_QUARRY = 14;
const HT_WEAPON_WORKSHOP = 19;
const HT_ARMOR_WORKSHOP = 20;
const HT_BARRACKS = 21;
const UT_CARPENTER = 5;
const UT_STONEMASON = 10;
const UT_MILITIA = 14;

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

function makeSpec(record: number): UnitSpec {
  const anim: AnimLoop[][] = [];
  for (let a = 0; a < 14; a++) {
    const dirs: AnimLoop[] = [];
    for (let d = 0; d < 8; d++) dirs.push(loop(a === 1 ? 12 : 8));
    anim.push(dirs);
  }
  const warrior = record >= 14 && record <= 22;
  return {
    speedRaw: 24,
    anim,
    miningRange: record === UT_STONEMASON ? 16 : 0,
    hitPoints: warrior ? 3 : 1,
    attack: 35,
    attackHorse: 0,
    defence: 1,
    sight: 9,
    fightType: 'melee',
    isWarrior: warrior,
    record,
  };
}

function makeSpecs(): UnitSpec[] {
  const specs: UnitSpec[] = [];
  for (let i = 0; i < 31; i++) specs.push(makeSpec(i));
  return specs;
}

function houseSpec(typeId: number, o: Partial<HouseSpec>): HouseSpec {
  return {
    typeId,
    workerType: -1,
    resIn: [-1, -1, -1, -1],
    resOut: [-1, -1, -1, -1],
    productionX: 1,
    workerRest: 0,
    animCounts: [0, 0, 0, 0, 0],
    entranceDx: 0,
    woodPic: 0,
    stonePic: 0,
    maxHealth: 100,
    woodCost: 1,
    stoneCost: 1,
    sight: 6,
    ...o,
  };
}

/** The Pascal WareInput/WareOutput, worker types and ResProductionX of the four houses (reshouses.md, houses.dat). */
function makeHouseSpecs(): (HouseSpec | undefined)[] {
  const out: (HouseSpec | undefined)[] = new Array(30).fill(undefined);
  out[HT_STORE] = houseSpec(HT_STORE, { woodCost: 5, stoneCost: 5 });
  out[HT_QUARRY] = houseSpec(HT_QUARRY, { workerType: UT_STONEMASON, resOut: [1, -1, -1, -1], productionX: 3, animCounts: [0, 18, 0, 0, 30] });
  out[HT_WEAPON_WORKSHOP] = houseSpec(HT_WEAPON_WORKSHOP, {
    workerType: UT_CARPENTER,
    resIn: [2, -1, -1, -1],
    resOut: [20, 22, 24, -1],
    animCounts: [16, 30, 30, 30, 30],
  });
  out[HT_ARMOR_WORKSHOP] = houseSpec(HT_ARMOR_WORKSHOP, {
    workerType: UT_CARPENTER,
    resIn: [2, 12, -1, -1],
    resOut: [16, 18, -1, -1],
    animCounts: [0, 30, 30, 30, 0],
  });
  out[HT_BARRACKS] = houseSpec(HT_BARRACKS, { workerType: 13, woodCost: 4, stoneCost: 4 });
  return out;
}

function makeMap(mapX: number, mapY: number, stoneAt: Array<[number, number]>): KaMap {
  const tiles = new Uint8Array(mapX * mapY * 4);
  for (const [x, y] of stoneAt) tiles[((y - 1) * mapX + (x - 1)) * 4] = TILE_STONE;
  return { file: 'mini', mapX, mapY, tiles, remake: false, tail: { resHead: null, mapEdChunk: false, tailBytes: 0 } };
}

function makeWorld(stoneAt: Array<[number, number]> = []): EconomyWorld {
  const mission: Mission = { mapName: 'mini', maxPlayers: 2, humanPlayer: 0, houses: [], streets: [], units: [], wares: [] };
  const o: EconomyWorldOptions = {
    map: makeMap(40, 40, stoneAt),
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

function count(w: EconomyWorld, prefix: string): number {
  return w.events.filter((e) => e.text.startsWith(prefix)).length;
}

/** Deliveries are carried by idle serfs (type 0): one serf at the store door is enough for these worlds. */
function serfAt(w: EconomyWorld, house: { entrance: { x: number; y: number } }): void {
  w.spawnCitizen(0, 0, house.entrance.x, house.entrance.y + 1, 6);
}

function road(w: EconomyWorld, from: { x: number; y: number }, to: { x: number; y: number }): void {
  for (const p of w.findRoute(from.x, from.y, to.x, to.y) ?? []) if (!w.isRoadTile(p.x, p.y)) w.addRoadTile(p.x, p.y);
}

test('TileIsStone reads the tileset deposit (KM_Terrain.pas 1385–1388; tiles.json Stone)', () => {
  const w = makeWorld([[15, 8]]);
  assert.equal(w.tileIsStone(15, 8), 3);
  assert.equal(w.tileIsStone(16, 8), 0);
});

test('the quarry: a stonemason at a stone deposit produces stone that reaches the store (KM_UnitWorkPlan.pas 500–509)', () => {
  const stone: Array<[number, number]> = [];
  for (let x = 14; x <= 22; x++) stone.push([x, 8]);
  const w = makeWorld(stone);
  const store = w.spawnHouse(HT_STORE, 18, 20, 0);
  const quarry = w.spawnHouse(HT_QUARRY, 18, 11, 0);
  w.addInputDemands(quarry);
  road(w, { x: quarry.entrance.x, y: quarry.entrance.y + 1 }, { x: store.entrance.x, y: store.entrance.y + 1 });
  w.spawnCitizen(0, UT_STONEMASON, quarry.entrance.x, quarry.entrance.y + 1, 6);
  serfAt(w, store);
  const before = w.wareCount(store, WT_STONE);
  w.addScriptDemand(store, WT_STONE, 6);
  run(w, 2500);
  assert.ok(count(w, 'stone-out') >= 2, `stone cycles ${count(w, 'stone-out')}`);
  assert.ok(w.wareCount(store, WT_STONE) - before >= 2, 'stone reached the store');
});

test('the weapon workshop: two timber make one axe, the order is consumed, the axes exist (KM_UnitWorkPlan.pas 411–422)', () => {
  const w = makeWorld();
  const store = w.spawnHouse(HT_STORE, 18, 14, 0);
  const shop = w.spawnHouse(HT_WEAPON_WORKSHOP, 18, 10, 0);
  w.addInputDemands(shop);
  road(w, { x: shop.entrance.x, y: shop.entrance.y + 1 }, { x: store.entrance.x, y: store.entrance.y + 1 });
  w.spawnCitizen(0, UT_CARPENTER, shop.entrance.x, shop.entrance.y + 1, 6);
  w.addWareToStore(0, WT_TIMBER, 4);
  serfAt(w, store);
  w.setWareOrder(shop.uid, 1, 2);
  assert.equal(w.wareOrderOf(shop.uid, 1), 2);
  run(w, 2500);
  assert.ok(count(w, 'ware-produced') >= 1, 'an axe was produced');
  assert.equal(w.wareOrderOf(shop.uid, 1), 0, 'the two orders were consumed');
  assert.ok(w.handWareBalance(0, WT_AXE) >= 2, `axes in stock ${w.handWareBalance(0, WT_AXE)}`);
});

test('the workshop picks no product without its inputs (PickOrder, KM_Houses.pas 1590–1595)', () => {
  const w = makeWorld();
  const shop = w.spawnHouse(HT_WEAPON_WORKSHOP, 18, 10, 0);
  w.setWareOrder(shop.uid, 1, 3);
  w.spawnCitizen(0, UT_CARPENTER, shop.entrance.x, shop.entrance.y + 1, 6);
  run(w, 800);
  assert.equal(count(w, 'ware-produced'), 0, 'no timber, no axe');
  assert.equal(w.wareOrderOf(shop.uid, 1), 3, 'the order is kept');
});

test('the armour workshop makes a wooden shield from one timber (KM_UnitWorkPlan.pas 398–408)', () => {
  const w = makeWorld();
  const shop = w.spawnHouse(HT_ARMOR_WORKSHOP, 18, 10, 0);
  w.addInputDemands(shop);
  w.spawnCitizen(0, UT_CARPENTER, shop.entrance.x, shop.entrance.y + 1, 6);
  w.addWareToHouseFromScript(shop.uid, WT_TIMBER, 1);
  w.setWareOrder(shop.uid, 1, 1);
  run(w, 1500);
  assert.ok(count(w, 'ware-produced') >= 1, 'a shield was produced');
  assert.equal(w.wareOrderOf(shop.uid, 1), 0);
});

test('the barracks keeps its own warfare stock: an equip takes the wares from it (KM_HouseBarracks.pas 184–198, 331–380)', () => {
  const w = makeWorld();
  const barracks = w.spawnHouse(HT_BARRACKS, 12, 5, 0);
  w.houseCreatedFor(0, HT_BARRACKS);
  assert.equal(w.addWareToHouseFromScript(barracks.uid, WT_AXE, 1), true);
  assert.equal(w.handWareBalance(0, WT_AXE), 1, 'the barracks stock counts for the hand');
  assert.equal(w.barracksCanEquip(barracks.uid, UT_MILITIA), false, 'no recruit yet');
  assert.ok(w.barracksAddRecruit(barracks.uid) !== null);
  assert.equal(w.barracksCanEquip(barracks.uid, UT_MILITIA), true);
  assert.ok(w.barracksEquip(barracks.uid, UT_MILITIA) !== null);
  assert.equal(w.handWarriorCount(0), 1);
  assert.equal(w.handWareBalance(0, WT_AXE), 0, 'the axe was used up');
});
