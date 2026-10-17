// commands.test.ts — the M5d-A command layer (docs/M5D-SPIKE.md §1–§2): every command type applies and
// rejects bad input, the log round trip, and determinism. The worlds are synthetic (no install needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyWorld, TROOP_COST } from './economy.ts';
import type { EconomyWorld, EconomyWorldOptions } from './economy.ts';
import { applyCommand, commandLogFromJson, commandLogToJson, commandsAtTick } from './commands.ts';
import type { Command, CommandLog } from './commands.ts';
import { applyMissionHouseUnlocks } from './ai.ts';
import { WT_AXE } from '../assets/wares.ts';
import type { KaMap } from '../map/map.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import type { Mission } from '../mission/mission.ts';

const TILES: TileFlags[] = [{ walkable: true, roadable: true, soil: true, corners: [0, 0, 0, 0] }];
const HT_STORE = 11;
const HT_SCHOOL = 13;
const HT_BARRACKS = 21;
const HT_WOODCUTTERS = 9;
const UT_SERF = 0;
const UT_MILITIA = 14;
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
  out[HT_SCHOOL] = houseSpec(HT_SCHOOL, 5, 5);
  out[HT_BARRACKS] = houseSpec(HT_BARRACKS, 4, 4);
  out[HT_WOODCUTTERS] = houseSpec(HT_WOODCUTTERS, 3, 2);
  return out;
}

function makeMap(mapX = 32, mapY = 32): KaMap {
  const tiles = new Uint8Array(mapX * mapY * 4);
  for (let t = 0; t < mapX * mapY; t++) tiles[t * 4 + 3] = 255; // obj 255 = OBJ_NONE (economy.test.ts)
  return {
    file: 'mini',
    mapX,
    mapY,
    tiles,
    remake: false,
    tail: { resHead: null, mapEdChunk: false, tailBytes: 0 },
  };
}

/** Hand 0 and hand 1 each have a store and two serfs (the mission is only the stores and the serfs). */
function makeMission(): Mission {
  return {
    mapName: 'mini',
    maxPlayers: 2,
    humanPlayer: 0,
    houses: [
      { typeId: HT_STORE, x: 6, y: 6, owner: 0 },
      { typeId: HT_STORE, x: 26, y: 26, owner: 1 },
    ],
    streets: [],
    units: [
      { typeId: UT_SERF, x: 6, y: 9, owner: 0 },
      { typeId: UT_SERF, x: 7, y: 9, owner: 0 },
      { typeId: UT_SERF, x: 26, y: 29, owner: 1 },
    ],
    wares: [],
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
  const w = createEconomyWorld(o);
  applyMissionHouseUnlocks(w, 0);
  applyMissionHouseUnlocks(w, 1);
  return w;
}

/** A finished house of the given type at (x, y) for a hand (the house-level setup of a test). */
function finishedHouse(w: EconomyWorld, typeId: number, x: number, y: number, owner: number) {
  return w.spawnHouse(typeId, x, y, owner);
}

/** The first tile (scanning rings around (x0, y0)) where a house of this type can be planned, or null. */
function planSpot(w: EconomyWorld, hand: number, typeId: number, x0: number, y0: number): { x: number; y: number } | null {
  for (let r = 0; r <= 12; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (w.canAddHousePlan(hand, typeId, x0 + dx, y0 + dy)) return { x: x0 + dx, y: y0 + dy };
      }
    }
  }
  return null;
}

/** The observable state a rejected command must not move. */
function snap(w: EconomyWorld): string {
  return JSON.stringify({
    rng: w.rngState,
    units: w.units.map((u) => [u.uid, u.posF.x, u.posF.y, u.action, u.taskKind]),
    groups: w.groups.map((g) => [g.uid, g.order, g.orderX, g.orderY, g.unitsPerRow, g.memberUids]),
    houses: w.houses.map((h) => [h.uid, h.buildState, h.destroyed, w.schoolQueueOf(h.uid)]),
    plans: [0, 1].map((hand) => [
      w.constructionState(hand).plans.filter((p) => p.status !== 'empty').length,
      w.constructionState(hand).fields.filter((f) => f.status !== 'empty').length,
    ]),
  });
}

test('every command type applies on a valid world', () => {
  const w = makeWorld();
  const t = w.tickCount + 1;
  const ok = (cmd: object) => {
    const r = applyCommand(w, { hand: 0, tick: t, ...cmd } as Command);
    assert.deepEqual(r, { ok: true }, JSON.stringify(cmd));
  };

  const spot = planSpot(w, 0, HT_STORE, 14, 14);
  assert.ok(spot !== null, 'a store plan spot exists near the middle of the map');
  ok({ type: 'housePlan', typeId: HT_STORE, x: spot.x, y: spot.y });
  assert.equal(w.hasHousePlan(0, spot.x, spot.y), true);
  ok({ type: 'houseRemovePlan', x: spot.x, y: spot.y });
  assert.equal(w.hasHousePlan(0, spot.x, spot.y), false);

  ok({ type: 'roadPlan', x: 9, y: 9 });
  assert.equal(w.hasFieldPlan(0, 9, 9), 'road');
  ok({ type: 'roadPlanLine', path: [{ x: 10, y: 9 }, { x: 11, y: 9 }, { x: 12, y: 9 }] });
  assert.equal(w.hasFieldPlan(0, 12, 9), 'road');

  ok({ type: 'fieldPlan', kind: 'corn', x: 16, y: 16 });
  assert.equal(w.hasFieldPlan(0, 16, 16), 'corn');
  ok({ type: 'planRemove', x: 16, y: 16 });
  assert.equal(w.hasFieldPlan(0, 16, 16), 'none');
  ok({ type: 'planRemove', x: 9, y: 9 });
  assert.equal(w.hasFieldPlan(0, 9, 9), 'none');
});

test('house commands: train a school queue, equip a barracks, destroy an own house', () => {
  const w = makeWorld();
  const school = finishedHouse(w, HT_SCHOOL, 14, 14, 0);
  const t = w.tickCount + 1;
  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'houseTrain', houseUid: school.uid, unitType: UT_SERF, count: 2 }), { ok: true });
  assert.equal(w.schoolQueueCount(school.uid), 2); // no gold in the school: nothing starts, two queued
  assert.equal(applyCommand(w, { hand: 0, tick: t, type: 'houseTrain', houseUid: school.uid, unitType: UT_SERF, count: 4 }).ok, false, 'only 3 free slots');
  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'houseTrain', houseUid: school.uid, unitType: UT_SERF, count: 3 }), { ok: true });
  assert.equal(w.schoolQueueCount(school.uid), 5);

  const barracks = finishedHouse(w, HT_BARRACKS, 20, 14, 0);
  w.barracksAddRecruit(barracks.uid);
  w.barracksAddRecruit(barracks.uid);
  assert.equal(w.addWareToHouseFromScript(barracks.uid, WT_AXE, 2), true); // KM_HouseBarracks.pas 331-341: CanEquip reads the barracks' own stock
  assert.deepEqual(TROOP_COST[UT_MILITIA], [WT_AXE]);
  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'houseEquip', houseUid: barracks.uid, soldierType: UT_MILITIA, count: 3 }), { ok: true });
  assert.equal(w.barracksRecruitCount(barracks.uid), 0, 'both recruits were equipped (the third had none)');
  const again = applyCommand(w, { hand: 0, tick: t, type: 'houseEquip', houseUid: barracks.uid, soldierType: UT_MILITIA, count: 1 });
  assert.equal(again.ok, false);

  const hut = finishedHouse(w, HT_WOODCUTTERS, 8, 20, 0);
  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'houseDestroy', houseUid: hut.uid }), { ok: true });
  w.tick();
  assert.equal(w.houseByUid(hut.uid)?.destroyed ?? true, true);
});

test('the commands the v0 economy cannot run are refused with a reason (nothing changes)', () => {
  const w = makeWorld();
  const store = w.findFirstHouse(HT_STORE, 0);
  assert.ok(store !== null);
  const t = w.tickCount + 1;
  for (const cmd of [
    { type: 'houseDeliveryMode', houseUid: store.uid, mode: 'closed' },
    { type: 'houseWareDemand', houseUid: store.uid, ware: 2, delta: 1 },
    { type: 'houseRepair', houseUid: store.uid, on: true },
    { type: 'fieldPlan', kind: 'wine', x: 16, y: 16 },
  ]) {
    const r = applyCommand(w, { hand: 0, tick: t, ...cmd } as Command);
    assert.equal(r.ok, false, cmd.type);
    if (!r.ok) assert.match(r.reason, /v0|not in the v0|out of v0/, cmd.type);
  }
  assert.equal(w.hasFieldPlan(0, 16, 16), 'none');
});

test('group commands: walk, attack a unit, attack a house, halt, formation', () => {
  const w = makeWorld();
  const mine = w.spawnGroup(0, UT_MILITIA, 10, 20, 4, 3, 6);
  const enemy = w.spawnGroup(1, UT_MILITIA, 20, 20, 4, 3, 3);
  const enemyHouse = w.houseByUid(w.findFirstHouse(HT_STORE, 1)?.uid ?? -1);
  assert.ok(enemyHouse !== null);
  const t = w.tickCount + 1;
  const enemyUnit = enemy.memberUids[0];

  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'groupWalk', groupUid: mine.uid, x: 12, y: 20, dir: 4 }), { ok: true });
  assert.equal(w.groupByUid(mine.uid)?.order, 'walk');
  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'groupAttackUnit', groupUid: mine.uid, targetUid: enemyUnit }), { ok: true });
  assert.equal(w.groupByUid(mine.uid)?.order, 'attackUnit');
  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'groupAttackHouse', groupUid: mine.uid, houseUid: enemyHouse.uid }), { ok: true });
  assert.equal(w.groupByUid(mine.uid)?.order, 'attackHouse');
  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'groupHalt', groupUid: mine.uid }), { ok: true });
  assert.equal(w.groupByUid(mine.uid)?.orderWalkKind, 'halt');
  assert.deepEqual(applyCommand(w, { hand: 0, tick: t, type: 'groupFormation', groupUid: mine.uid, unitsPerRow: 2 }), { ok: true });
  assert.equal(w.groupByUid(mine.uid)?.unitsPerRow, 2);
});

test('bad input is rejected with a reason and never throws', () => {
  const w = makeWorld();
  const mine = w.spawnGroup(0, UT_MILITIA, 10, 20, 4, 3, 6);
  const enemy = w.spawnGroup(1, UT_MILITIA, 20, 20, 4, 3, 3);
  const t = w.tickCount + 1;
  const bad: unknown[] = [
    null,
    'housePlan',
    [],
    { hand: 0, tick: t },
    { hand: 0, tick: t, type: 'teleport' },
    { hand: 9, tick: t, type: 'roadPlan', x: 9, y: 9 },
    { hand: -1, tick: t, type: 'roadPlan', x: 9, y: 9 },
    { hand: 0, tick: 1.5, type: 'roadPlan', x: 9, y: 9 },
    { hand: 0, tick: t, type: 'roadPlan', x: 999, y: 9 },
    { hand: 0, tick: t, type: 'roadPlan', x: '9', y: 9 },
    { hand: 0, tick: t, type: 'housePlan', typeId: 99, x: 9, y: 9 },
    { hand: 0, tick: t, type: 'housePlan', typeId: HT_WOODCUTTERS, x: 999, y: 9 },
    { hand: 0, tick: t, type: 'roadPlanLine', path: [] },
    { hand: 0, tick: t, type: 'houseTrain', houseUid: 1, unitType: UT_SERF, count: 6 },
    { hand: 0, tick: t, type: 'houseTrain', houseUid: 999999, unitType: UT_SERF, count: 1 },
    { hand: 0, tick: t, type: 'houseEquip', houseUid: 1, soldierType: UT_SERF, count: 1 },
    { hand: 0, tick: t, type: 'groupWalk', groupUid: mine.uid, x: 10, y: 10, dir: 9 },
    { hand: 0, tick: t, type: 'groupWalk', groupUid: enemy.uid, x: 10, y: 10, dir: 0 },
    { hand: 0, tick: t, type: 'groupAttackUnit', groupUid: mine.uid, targetUid: mine.memberUids[0] },
    { hand: 0, tick: t, type: 'groupAttackUnit', groupUid: mine.uid, targetUid: 999999 },
    { hand: 0, tick: t, type: 'groupAttackHouse', groupUid: mine.uid, houseUid: w.findFirstHouse(HT_STORE, 0)?.uid ?? 1 },
    { hand: 0, tick: t, type: 'groupFormation', groupUid: mine.uid, unitsPerRow: 50 },
    { hand: 0, tick: t, type: 'groupHalt', groupUid: 999999 },
    { hand: 0, tick: t, type: 'houseDestroy', houseUid: w.findFirstHouse(HT_STORE, 1)?.uid ?? 1 },
  ];
  const before = snap(w);
  for (const cmd of bad) {
    const r = applyCommand(w, cmd as Command);
    assert.equal(r.ok, false, JSON.stringify(cmd));
    if (!r.ok) assert.equal(typeof r.reason, 'string');
    assert.equal(snap(w), before, `a rejected command changed the state: ${JSON.stringify(cmd)}`);
  }
});

test('roadPlanLine is all or nothing: a bad tile in the line plans no road', () => {
  const w = makeWorld();
  const t = w.tickCount + 1;
  const before = snap(w);
  const r = applyCommand(w, { hand: 0, tick: t, type: 'roadPlanLine', path: [{ x: 9, y: 9 }, { x: 10, y: 9 }, { x: 10, y: 9 }] });
  assert.equal(r.ok, false);
  assert.equal(w.hasFieldPlan(0, 9, 9), 'none', 'the first tile was rolled back');
  assert.equal(snap(w), before);
});

test('a gate refuses hands (the skirmish gate of an AI hand)', () => {
  const w = makeWorld();
  const t = w.tickCount + 1;
  const r = applyCommand(w, { hand: 1, tick: t, type: 'roadPlan', x: 9, y: 9 }, (hand) => (hand === 1 ? 'hand 1 is an AI hand' : null));
  assert.deepEqual(r, { ok: false, reason: 'hand 1 is an AI hand' });
  assert.equal(w.hasFieldPlan(1, 9, 9), 'none');
});

test('the command log round-trips through JSON and filters by tick', () => {
  const log: CommandLog = [
    { tick: 1, cmd: { hand: 0, tick: 1, type: 'housePlan', typeId: 9, x: 12, y: 12 } },
    { tick: 1, cmd: { hand: 0, tick: 1, type: 'roadPlanLine', path: [{ x: 10, y: 9 }] } },
    { tick: 3, cmd: { hand: 0, tick: 3, type: 'groupHalt', groupUid: 7 } },
  ];
  const json = commandLogToJson(log);
  const back = commandLogFromJson(json);
  assert.deepEqual(back, log);
  assert.equal(commandLogToJson(back), json);
  assert.equal(commandsAtTick(back, 1).length, 2);
  assert.equal(commandsAtTick(back, 2).length, 0);
  assert.throws(() => commandLogFromJson('{"not":"an array"}'), /expected a JSON array/);
  assert.throws(() => commandLogFromJson('[{"tick":1}]'), /needs \{tick, cmd\}/);
  assert.throws(() => commandLogFromJson('[{"tick":1,"cmd":{"hand":0,"tick":1}}]'), /string type/);
});

test('determinism: the same commands on two worlds give the same state', () => {
  const script = (w: EconomyWorld): void => {
    for (let i = 0; i < 400; i++) {
      const t = w.tickCount + 1;
      if (t === 1) {
        const spot = planSpot(w, 0, HT_STORE, 14, 14);
        if (spot !== null) applyCommand(w, { hand: 0, tick: t, type: 'housePlan', typeId: HT_STORE, x: spot.x, y: spot.y });
      }
      if (t === 2) applyCommand(w, { hand: 0, tick: t, type: 'roadPlanLine', path: [{ x: 9, y: 9 }, { x: 10, y: 9 }] });
      if (t === 3) applyCommand(w, { hand: 0, tick: t, type: 'fieldPlan', kind: 'corn', x: 16, y: 16 });
      w.tick();
    }
  };
  const snap = (w: EconomyWorld): string =>
    JSON.stringify({
      tick: w.tickCount,
      rng: w.rngState,
      houses: w.houses.map((h) => [h.uid, h.typeId, h.buildState, h.buildingProgress]),
      units: w.units.map((u) => [u.uid, u.posF.x, u.posF.y, u.taskKind]),
      events: w.events.map((e) => e.text),
    });
  const a = makeWorld();
  const b = makeWorld();
  script(a);
  script(b);
  assert.equal(snap(a), snap(b));
  assert.equal(a.constructionState(0).plans.length, 1, 'the store plan was placed on both worlds');
  assert.equal(a.hasFieldPlan(0, 16, 16), 'corn');
});
