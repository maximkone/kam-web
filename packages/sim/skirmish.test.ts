// skirmish.test.ts — the M5d-A skirmish wrapper (docs/M5D-SPIKE.md §2): slot checks, the goals of a
// hand (default and script), the victory/defeat rule on hand-built cases, the fixed tick with its gate,
// and the command-log replay. The worlds are synthetic; the install-based build is the --check of
// tools/skirmish (createSkirmish needs the real map and defines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEconomyWorld } from './economy.ts';
import type { EconomyWorld, EconomyWorldOptions } from './economy.ts';
import { applyCommand, commandsAtTick } from './commands.ts';
import type { Command, CommandLog } from './commands.ts';
import {
  buildHandGoals,
  checkGoalsForTick,
  GC_BUILDINGS,
  GC_TROOPS,
  normalizeSlots,
  parseScriptGoals,
  skirmishStatus,
  step,
} from './skirmish.ts';
import type { HandGoals, HandStatus, NormalizedSlot, Skirmish } from './skirmish.ts';
import type { KaMap } from '../map/map.ts';
import type { TileFlags } from '../assets/tiledata.ts';
import type { MapElem } from '../assets/mapelem.ts';
import type { AnimLoop, UnitSpec } from '../assets/unitdat.ts';
import type { HouseSpec } from '../assets/housedata.ts';
import type { Mission } from '../mission/mission.ts';

const TILES: TileFlags[] = [{ walkable: true, roadable: true, soil: true, corners: [0, 0, 0, 0] }];
const HT_STORE = 11;
const UT_SERF = 0;
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

function makeHouseSpecs(): (HouseSpec | undefined)[] {
  const out: (HouseSpec | undefined)[] = new Array(30).fill(undefined);
  out[HT_STORE] = {
    typeId: HT_STORE,
    workerType: -1,
    resIn: [-1, -1, -1, -1],
    resOut: [-1, -1, -1, -1],
    productionX: 0,
    workerRest: 0,
    animCounts: [0, 0, 0, 0, 0],
    entranceDx: 0,
    woodPic: 0,
    stonePic: 0,
    maxHealth: 550,
    woodCost: 5,
    stoneCost: 5,
    sight: 6,
  };
  return out;
}

function makeMap(mapX = 32, mapY = 32): KaMap {
  const tiles = new Uint8Array(mapX * mapY * 4);
  for (let t = 0; t < mapX * mapY; t++) tiles[t * 4 + 3] = 255; // obj 255 = OBJ_NONE
  return { file: 'mini', mapX, mapY, tiles, remake: false, tail: { resHead: null, mapEdChunk: false, tailBytes: 0 } };
}

/** Hands 0 and 1 each have a store and one serf. */
function makeWorld(): EconomyWorld {
  const mission: Mission = {
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
      { typeId: UT_SERF, x: 26, y: 29, owner: 1 },
    ],
    wares: [],
  };
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

function slotsOf(...kinds: ('human' | 'ai')[]): NormalizedSlot[] {
  return normalizeSlots(kinds.map((kind, hand) => ({ hand, kind })), kinds.length);
}

/** A Skirmish over a synthetic world: the parts the wrapper reads (no AI players, no supervisor). */
function skirmishOf(w: EconomyWorld, slots: NormalizedSlot[], goals: HandGoals[]): Skirmish {
  return {
    world: w,
    slots,
    status: Array.from({ length: w.handCount }, () => 'playing' as HandStatus),
    goals,
    ais: [],
    supervisor: null,
    log: [],
    missionMode: 'building',
  };
}

function removeStore(w: EconomyWorld, hand: number): void {
  const store = w.findFirstHouse(HT_STORE, hand);
  assert.ok(store !== null, `hand ${hand} has a store`);
  assert.equal(w.demolishHouseByUid(store.uid, hand), true);
  w.tick();
}

test('slots: a valid list is sorted; a bad list throws a named error', () => {
  const ok = normalizeSlots([{ hand: 2, kind: 'ai' }, { hand: 0, kind: 'human', color: 5 }], 3);
  assert.deepEqual(
    ok.map((s) => [s.hand, s.kind, s.aiLevel, s.team, s.color]),
    [
      [0, 'human', 'advanced', 0, 5],
      [2, 'ai', 'advanced', 2, 2],
    ],
  );
  assert.throws(() => normalizeSlots([{ hand: 0, kind: 'ai' }], 2), /at least one human/);
  assert.throws(() => normalizeSlots([{ hand: 0, kind: 'human' }, { hand: 0, kind: 'ai' }], 2), /two slots/);
  assert.throws(() => normalizeSlots([{ hand: 5, kind: 'human' }], 2), /outside the map's hands/);
  assert.throws(() => normalizeSlots([{ hand: 0, kind: 'human' }, { hand: 1, kind: 'ai', aiLevel: 'classic' }], 2), /classic AI is not ported/);
  assert.throws(() => normalizeSlots([{ hand: 0, kind: 'human', team: 3 }, { hand: 1, kind: 'ai', team: 3 }], 2), /share team 3/);
  assert.throws(() => normalizeSlots([{ hand: 0, kind: 'bot' as 'human' }], 2), /human or ai/);
  assert.throws(() => normalizeSlots([], 2), /at least one hand/);
});

test('default goals: survive your own buildings, win by the same condition on every enemy', () => {
  const w = makeWorld();
  const goals = buildHandGoals(w, slotsOf('human', 'ai'), [], false);
  assert.deepEqual(goals[0], {
    survival: [{ victory: false, condition: GC_BUILDINGS, hand: 0 }],
    victory: [{ victory: true, condition: GC_BUILDINGS, hand: 1 }],
  });
  assert.deepEqual(goals[1].victory, [{ victory: true, condition: GC_BUILDINGS, hand: 0 }]);
  const tactic = buildHandGoals(w, slotsOf('human', 'ai'), [], true);
  assert.equal(tactic[0].survival[0].condition, GC_TROOPS, 'a tactic (fighting) mission uses troops');
});

test('script goals: ADD_GOAL and ADD_LOST_GOAL per hand; deprecated or message goals are skipped', () => {
  const text =
    '!SET_CURR_PLAYER 0 !ADD_GOAL 3 1 0 1 !ADD_LOST_GOAL 4 0 0 0 !ADD_GOAL 2 1 0 1 !ADD_GOAL 3 1 500 1 ' +
    '!SET_CURR_PLAYER 1 !ADD_GOAL 8 0 0 0';
  const parsed = parseScriptGoals(new TextEncoder().encode(text));
  assert.deepEqual(parsed, [
    { hand: 0, victory: true, condition: 3, target: 1 },
    { hand: 0, victory: false, condition: 4, target: 0 },
    { hand: 1, victory: true, condition: 8, target: 0 },
  ]);

  const w = makeWorld();
  const goals = buildHandGoals(w, slotsOf('human', 'ai'), parsed, false);
  assert.deepEqual(goals[0], {
    survival: [{ victory: false, condition: 4, hand: 0 }],
    victory: [{ victory: true, condition: 3, hand: 1 }],
  }, 'hand 0 keeps only its script goals');
  assert.deepEqual(goals[1].victory, [{ victory: true, condition: 8, hand: 0 }]);
  assert.deepEqual(goals[1].survival, [], 'hand 1 has a script goal, so no default survive goal');
});

test('victory rule: the hand whose enemy lost its buildings wins; a hand without buildings is defeated; both are sticky', () => {
  const w = makeWorld();
  const sk = skirmishOf(w, slotsOf('human', 'ai'), buildHandGoals(w, slotsOf('human', 'ai'), [], false));
  checkGoalsForTick(w, sk, 27); // hand 0's cadence: both still have a store
  assert.deepEqual(sk.status.slice(0, 2), ['playing', 'playing']);

  removeStore(w, 1);
  checkGoalsForTick(w, sk, 26); // hand 1's cadence (26 + 1 = 27): no buildings, survive fails
  assert.equal(sk.status[1], 'defeated');
  checkGoalsForTick(w, sk, 54); // hand 0's cadence: the enemy has lost, so the victory goal is met
  assert.equal(sk.status[0], 'won');

  checkGoalsForTick(w, sk, 81);
  checkGoalsForTick(w, sk, 80);
  assert.deepEqual(sk.status.slice(0, 2), ['won', 'defeated'], 'a decided hand never changes again');
});

test('defeat overrides victory: with no buildings left on either side, the hand is defeated, not won', () => {
  const w = makeWorld();
  const slots = slotsOf('human', 'ai');
  const sk = skirmishOf(w, slots, buildHandGoals(w, slots, [], false));
  removeStore(w, 0);
  removeStore(w, 1);
  checkGoalsForTick(w, sk, 27);
  assert.equal(sk.status[0], 'defeated');
});

test('a hand with no enemy has no victory goal and never wins', () => {
  const w = makeWorld();
  const slots = slotsOf('human');
  const sk = skirmishOf(w, slots, buildHandGoals(w, slots, [], false));
  checkGoalsForTick(w, sk, 27);
  assert.equal(sk.status[0], 'playing');
});

test('the troops condition of a tactic mission: a hand with no warriors is defeated', () => {
  const w = makeWorld();
  const slots = slotsOf('human', 'ai');
  const sk = skirmishOf(w, slots, buildHandGoals(w, slots, [], true));
  checkGoalsForTick(w, sk, 27);
  assert.equal(sk.status[0], 'defeated', 'hand 0 has serfs only');
});

test('step: commands run only for human hands on their own tick; the others are rejected and not logged', () => {
  const w = makeWorld();
  const slots = slotsOf('human', 'ai');
  const sk = skirmishOf(w, slots, buildHandGoals(w, slots, [], false));
  const res = step(sk, [
    { hand: 0, tick: 1, type: 'roadPlan', x: 9, y: 9 },
    { hand: 1, tick: 1, type: 'roadPlan', x: 9, y: 9 },
    { hand: 0, tick: 9, type: 'roadPlan', x: 10, y: 10 },
  ]);
  assert.equal(res.tick, 1);
  assert.deepEqual(res.results[0].result, { ok: true });
  assert.equal(res.results[1].result.ok, false);
  assert.match(res.results[1].result.ok ? '' : res.results[1].result.reason, /AI hand/);
  assert.equal(res.results[2].result.ok, false);
  assert.match(res.results[2].result.ok ? '' : res.results[2].result.reason, /is for tick 9/);
  assert.equal(sk.log.length, 1);
  assert.equal(sk.log[0].tick, 1);
  assert.equal(w.tickCount, 1);

  sk.status[0] = 'defeated';
  const late = step(sk, [{ hand: 0, tick: 2, type: 'roadPlan', x: 11, y: 11 }]);
  assert.equal(late.results[0].result.ok, false);
  assert.match(late.results[0].result.ok ? '' : late.results[0].result.reason, /defeated/);
  assert.equal(sk.log.length, 1);
});

test('step: the log replays onto a fresh skirmish to the same state', () => {
  const script = (sk: Skirmish): void => {
    for (let i = 0; i < 80; i++) {
      const t = sk.world.tickCount + 1;
      const cmds: Command[] = [];
      if (t === 1) cmds.push({ hand: 0, tick: t, type: 'roadPlan', x: 9, y: 9 });
      if (t === 2) cmds.push({ hand: 0, tick: t, type: 'roadPlanLine', path: [{ x: 10, y: 9 }, { x: 11, y: 9 }] });
      if (t === 40) cmds.push({ hand: 0, tick: t, type: 'fieldPlan', kind: 'corn', x: 16, y: 16 });
      step(sk, cmds);
    }
  };
  const snap = (w: EconomyWorld): string =>
    JSON.stringify({
      tick: w.tickCount,
      rng: w.rngState,
      units: w.units.map((u) => [u.uid, u.posF.x, u.posF.y, u.taskKind]),
      plans: [w.constructionState(0).fields.length, w.constructionState(1).fields.length],
      events: w.events.map((e) => e.text),
    });
  const slots = slotsOf('human', 'ai');
  const wa = makeWorld();
  const a = skirmishOf(wa, slots, buildHandGoals(wa, slots, [], false));
  script(a);
  const log: CommandLog = a.log;
  assert.ok(log.length >= 3);
  const wb = makeWorld();
  const b = skirmishOf(wb, slots, buildHandGoals(wb, slots, [], false));
  for (let t = 1; t <= 80; t++) {
    const res = step(b, commandsAtTick(log, t));
    for (const r of res.results) assert.equal(r.result.ok, true, `replayed ${r.cmd.type} at ${t}`);
  }
  assert.equal(snap(wb), snap(wa));
});

test('skirmishStatus: the match is over when a human hand has won or lost, not for the AI alone', () => {
  const w = makeWorld();
  const slots = slotsOf('human', 'ai');
  const sk = skirmishOf(w, slots, buildHandGoals(w, slots, [], false));
  assert.equal(skirmishStatus(sk).matchOver, false);
  sk.status[1] = 'defeated';
  assert.equal(skirmishStatus(sk).matchOver, false, 'an AI defeat alone does not end the match');
  sk.status[0] = 'won';
  const st = skirmishStatus(sk);
  assert.equal(st.matchOver, true);
  assert.deepEqual(st.hands, [
    { hand: 0, kind: 'human', status: 'won' },
    { hand: 1, kind: 'ai', status: 'defeated' },
  ]);
});
