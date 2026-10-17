// aiarmy.test.ts — the M5c military half (packages/sim/aiarmy.ts, aisupervisor.ts) on a synthetic mini
// world, plus the !SET_AI_DEFENSE / !SET_AI_ATTACK records (packages/sim/ai.ts parseAiSetups).
// Run: node --test packages/sim/aiarmy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyWorld } from './economy.ts';
import type { EconomyWorld, EconomyWorldOptions } from './economy.ts';
import { TROOP_COST } from './economy.ts';
import { parseAiSetups, defaultAiSetup } from './ai.ts';
import { ArmyAttackNew, ArmyDefence } from './aiarmy.ts';
import { parseMissionInfo } from '../mission/mission.ts';
import type { Mission } from '../mission/mission.ts';
import { WT_AXE, WT_WOODEN_SHIELD, WT_LEATHER_ARMOR } from '../assets/wares.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { KaMap } from '../map/map.ts';

const TILES: TileFlags[] = [{ walkable: true, roadable: true, soil: true, corners: [0, 0, 0, 0] }];
const HT_STORE = 11;
const HT_BARRACKS = 21;
const UT_MILITIA = 14;
const UT_SERF = 0;
const UT_RECRUIT = 13;

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

function makeSpec(record: number, isWarrior: boolean): UnitSpec {
  const anim: AnimLoop[][] = [];
  for (let a = 0; a < 14; a++) {
    const dirs: AnimLoop[] = [];
    for (let d = 0; d < 8; d++) dirs.push(loop(a === 1 ? 12 : 8));
    anim.push(dirs);
  }
  return {
    speedRaw: 24,
    anim,
    miningRange: 0,
    hitPoints: isWarrior ? 3 : 1,
    attack: 35,
    attackHorse: 0,
    defence: 1,
    sight: 9,
    fightType: 'melee',
    isWarrior,
    record,
  };
}

function makeSpecs(): UnitSpec[] {
  const specs: UnitSpec[] = [];
  for (let i = 0; i < 31; i++) specs.push(makeSpec(i, i >= 14 && i <= 22));
  specs[UT_SERF] = makeSpec(UT_SERF, false);
  return specs;
}

function houseSpec(typeId: number, woodCost: number, stoneCost: number): HouseSpec {
  return {
    typeId,
    workerType: -1,
    resIn: [-1, -1, -1, -1],
    resOut: [-1, -1, -1, -1],
    productionX: 0,
    workerRest: 0,
    animCounts: [0, 0, 0, 0, 0],
    entranceDx: 0,
    woodPic: 0,
    stonePic: 0,
    maxHealth: (woodCost + stoneCost) * 50,
    woodCost,
    stoneCost,
    sight: 6,
  };
}

function makeHouseSpecs(): (HouseSpec | undefined)[] {
  const out: (HouseSpec | undefined)[] = new Array(30).fill(undefined);
  out[HT_STORE] = houseSpec(HT_STORE, 5, 5);
  out[HT_BARRACKS] = houseSpec(HT_BARRACKS, 4, 4);
  return out;
}

function makeMap(mapX = 32, mapY = 32): KaMap {
  return {
    file: 'mini',
    mapX,
    mapY,
    tiles: new Uint8Array(mapX * mapY * 4),
    remake: false,
    tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
  };
}

function makeWorld(): EconomyWorld {
  const mission: Mission = { mapName: 'mini', maxPlayers: 2, humanPlayer: 0, houses: [], streets: [], units: [], wares: [] };
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

/** The records of a scripted mission (text), as the tokenizer reads them. */
function scriptBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

test('the troop costs are the Pascal TROOP_COST table (KM_ResUnits.pas 168–177)', () => {
  assert.deepEqual(TROOP_COST[UT_MILITIA], [WT_AXE]);
  assert.deepEqual(TROOP_COST[15], [WT_WOODEN_SHIELD, WT_LEATHER_ARMOR, WT_AXE]);
  assert.equal(TROOP_COST[22].length, 4); // knight: iron shield, iron armour, sword, horse
});

test('!SET_AI_DEFENSE, !SET_AI_ATTACK (+COPY/CLEAR), TROUP_PARAM and AUTO_DEFEND are parsed per hand', () => {
  const text =
    '!SET_CURR_PLAYER 1 ' +
    '!SET_ADVANCED_AI_PLAYER ' +
    '!SET_AI_AUTO_DEFEND ' +
    '!SET_AI_CHARACTER TROUP_PARAM 0 8 4 ' +
    '!SET_AI_DEFENSE 10 12 2 0 6 1 ' +
    '!SET_AI_ATTACK TYPE 1 ' +
    '!SET_AI_ATTACK TOTAL_AMOUNT 20 ' +
    '!SET_AI_ATTACK COUNTER 300 ' +
    '!SET_AI_ATTACK TARGET 1 ' +
    '!SET_AI_ATTACK TROUP_AMOUNT 0 4 ' +
    '!COPY_AI_ATTACK ' +
    '!CLEAR_AI_ATTACK ' +
    '!SET_AI_ATTACK TYPE 2 ' +
    '!SET_AI_ATTACK TAKEALL ' +
    '!COPY_AI_ATTACK';
  const bytes = scriptBytes(text);
  const info = parseMissionInfo(bytes, 0, 0);
  const setups = parseAiSetups(bytes, info, 0, 0);
  const s = setups[1];
  assert.equal(s.newAI, true);
  assert.equal(s.autoDefend, true);
  assert.deepEqual(s.troopFormations[0], { numUnits: 8, unitsPerRow: 4 });
  assert.deepEqual(s.defencePositions, [{ pos: { x: 11, y: 13 }, dir: 3, groupType: 0, radius: 6, backLine: true }]);
  assert.equal(s.attacks.length, 2);
  const first = s.attacks[0];
  assert.equal(first.repeating, false); // TYPE 1 = aatOnce
  assert.equal(first.totalMen, 20);
  assert.equal(first.delay, 300);
  assert.equal(first.target, 1);
  assert.deepEqual(first.groupAmounts, [4, 0, 0, 0]);
  assert.equal(first.randomGroups, false);
  const second = s.attacks[1];
  assert.equal(second.repeating, true); // TYPE 2 = aatRepeating
  assert.equal(second.randomGroups, true); // TAKEALL
  assert.equal(second.totalMen, 0); // CLEAR_AI_ATTACK reset the record
  assert.notEqual(first.uid, second.uid);
  assert.equal(setups[0].attacks.length, 0);
  assert.equal(setups[0].newAI, false);
});

test('defaults: no records, no auto defend, the TKMArmyDefence formation (9 units, 3 per row)', () => {
  const d = defaultAiSetup(3);
  assert.equal(d.autoDefend, false);
  assert.equal(d.defencePositions.length, 0);
  assert.equal(d.attacks.length, 0);
  assert.deepEqual(d.troopFormations[2], { numUnits: 9, unitsPerRow: 3 });
});

test('barracks: a recruit waits inside, the wares are taken, the recruit is replaced by a warrior at the door', () => {
  const w = makeWorld();
  const store = w.spawnHouse(HT_STORE, 5, 5, 0);
  assert.ok(store.uid > 0);
  for (const [ware, n] of [
    [WT_AXE, 2],
    [WT_WOODEN_SHIELD, 1],
    [WT_LEATHER_ARMOR, 1],
  ] as const) {
    assert.equal(w.addWareToStore(0, ware, n), true);
  }
  const barracks = w.spawnHouse(HT_BARRACKS, 12, 5, 0);
  w.houseCreatedFor(0, HT_BARRACKS);
  const recruit = w.barracksAddRecruit(barracks.uid);
  assert.ok(recruit !== null);
  assert.equal(w.barracksRecruitCount(barracks.uid), 1);
  assert.equal(w.barracksCanEquip(barracks.uid, UT_MILITIA), true);
  assert.equal(w.barracksCanEquip(barracks.uid, 15), true); // axe fighter: the shield, the armour and an axe are in stock
  assert.equal(w.barracksCanEquip(barracks.uid, 22), false); // knight: iron armour, a sword and a horse are missing
  const warrior = w.barracksEquip(barracks.uid, UT_MILITIA);
  assert.ok(warrior !== null);
  assert.equal(warrior.type, UT_MILITIA);
  assert.equal(w.barracksRecruitCount(barracks.uid), 0);
  assert.equal(w.handWarriorCount(0), 1);
  assert.equal(w.barracksCanEquip(barracks.uid, UT_MILITIA), false); // no recruit and no axe left
  assert.equal(w.handUnitCount(0, UT_RECRUIT), 0);
  assert.equal(w.handUnitCount(0, UT_SERF), 0);
});

test('defence positions: a group takes the best free position, and the defence status counts the occupied ones', () => {
  const w = makeWorld();
  const setup = defaultAiSetup(0);
  const defence = new ArmyDefence(w, 0, setup);
  defence.updateDefences([
    { loc: { x: 5, y: 5 }, dir: 4, weight: 1, line: 0 },
    { loc: { x: 9, y: 5 }, dir: 4, weight: 1, line: 1 },
  ]);
  assert.equal(defence.count, 2);
  assert.equal(defence.firstLineCnt, 1);
  assert.equal(defence.defenceStatus(), 0);
  const g = w.spawnGroup(0, UT_MILITIA, 20, 20, 4, 3, 4);
  assert.equal(defence.findPlaceForGroup(g), true);
  assert.equal(defence.findPositionOf(g.uid), 0);
  assert.equal(defence.defenceStatus(), 1);
  // A second group of the same type fills the same position first (the highest weight, first on a tie).
  const g2 = w.spawnGroup(0, UT_MILITIA, 22, 20, 4, 3, 4);
  assert.equal(defence.findPlaceForGroup(g2), true);
  assert.equal(defence.findPositionOf(g.uid), 0);
  assert.ok(g.memberUids.length >= 4);
});

test('combat groups: a group without room takes the members of a new group of its type (LinkGroup)', () => {
  const w = makeWorld();
  const a = w.spawnGroup(0, UT_MILITIA, 10, 10, 4, 3, 7);
  const b = w.spawnGroup(0, UT_MILITIA, 14, 10, 4, 3, 4);
  const attack = new ArmyAttackNew(w, 0);
  assert.ok(attack.addGroup(a.uid) !== null);
  assert.equal(attack.isGroupInAction(a.uid), true);
  attack.linkGroup(b.uid);
  assert.equal(a.memberUids.length, 9); // 7 + 2 members, the group is full at 9
  assert.equal(b.memberUids.length, 2);
  assert.equal(attack.count, 1);
});
