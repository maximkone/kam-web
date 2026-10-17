// aistart.test.ts - the rich start (packages/sim/aistart.ts) on a synthetic world, and the aiStart slot
// validation of skirmish.ts normalizeSlots. The world is a small fake that implements only the economy
// calls the rich start makes (the real world is covered by tools/aistart --check).
// Run: node --test packages/sim/aistart.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { EconomyWorld } from './economy.ts';
import { applyRichStart, isAiStartLevel, richStartSizes, RICH_START_SIZES } from './aistart.ts';
import { normalizeSlots } from './skirmish.ts';
import { HT_BARRACKS, HT_STORE, UT_MILITIA } from './ai.ts';
import { WT_AXE, WT_WOODEN_SHIELD, WT_LEATHER_ARMOR } from '../assets/wares.ts';

const STORE = { uid: 1, x: 20, y: 20, entrance: { x: 20, y: 21 } };
const MAP = 40;

interface FakeLog {
  wares: [number, number][];
  barracks: { x: number; y: number; uid: number }[];
  recruits: number[];
  groups: { uid: number; x: number; y: number; count: number; type: number }[];
  roads: number;
  routeCalls: number;
}

/** A 40x40 open map with one store, a barracks slot east of the store, and the recording of every call. */
function fakeWorld(opts: { barracksFree?: boolean; walkable?: boolean } = {}): { world: EconomyWorld; log: FakeLog } {
  const barracksFree = opts.barracksFree ?? true;
  const walkable = opts.walkable ?? true;
  const log: FakeLog = { wares: [], barracks: [], recruits: [], groups: [], roads: 0, routeCalls: 0 };
  let nextUid = 100;
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < MAP && y < MAP;
  const world = {
    findFirstHouse: (typeId: number, hand: number) => (typeId === HT_STORE && hand === 0 ? STORE : null),
    houseSpecOf: (typeId: number) => (typeId === HT_BARRACKS ? { entranceDx: 0 } : undefined),
    canPlaceHouse: (typeId: number, ex: number) => barracksFree && typeId === HT_BARRACKS && ex >= 24 && inside(ex, 0),
    spawnHouse: (typeId: number, x: number, y: number) => {
      const uid = nextUid++;
      log.barracks.push({ x, y, uid });
      return { uid, typeId, x, y, entrance: { x, y: y + 1 } };
    },
    houseCreatedFor: () => undefined,
    findRoute: (fx: number, fy: number, tx: number, ty: number) => {
      log.routeCalls += 1;
      return [
        { x: fx, y: fy },
        { x: tx, y: ty },
      ];
    },
    isRoadTile: () => false,
    addRoadTile: () => {
      log.roads += 1;
    },
    addWareToStore: (hand: number, ware: number, amount: number) => {
      log.wares.push([ware, amount]);
      return true;
    },
    barracksAddRecruit: (uid: number) => {
      log.recruits.push(uid);
      return { uid: nextUid++ };
    },
    tileInMapCoords: (x: number, y: number) => inside(x, y),
    tileWalkable: () => walkable,
    houseAt: () => null,
    spawnGroup: (owner: number, type: number, x: number, y: number, _dir: number, _upr: number, count: number) => {
      const uid = nextUid++;
      log.groups.push({ uid, x, y, count, type });
      return { uid, owner, memberUids: Array.from({ length: count }, (_, i) => uid * 100 + i) };
    },
  };
  return { world: world as unknown as EconomyWorld, log };
}

test('level none changes nothing: the world is never touched', () => {
  const untouched = new Proxy({}, { get: (_t, p) => { throw new Error(`world touched: ${String(p)}`); } });
  assert.equal(applyRichStart(untouched as EconomyWorld, 1, { level: 'none' }), null);
});

test('normal: kit, one barracks by the placement rule, 12 recruits, 3 full groups', () => {
  const { world, log } = fakeWorld();
  const r = applyRichStart(world, 0, { level: 'normal' });
  assert.ok(r !== null);
  const k = RICH_START_SIZES.normal.kitPerWare;
  assert.deepEqual(log.wares, [
    [WT_AXE, k],
    [WT_WOODEN_SHIELD, k],
    [WT_LEATHER_ARMOR, k],
  ]);
  assert.equal(log.barracks.length, 1);
  assert.deepEqual([log.barracks[0].x, log.barracks[0].y], [24, 16]); // first spot in ring 4, east-north
  assert.equal(log.recruits.length, RICH_START_SIZES.normal.recruits);
  assert.ok(log.recruits.every((uid) => uid === r.barracksUid));
  assert.equal(log.groups.length, RICH_START_SIZES.normal.groups);
  assert.ok(log.groups.every((g) => g.count === RICH_START_SIZES.normal.groupSize && g.type === UT_MILITIA));
  assert.equal(r.groupUids.length, RICH_START_SIZES.normal.groups);
  assert.equal(log.routeCalls, 1);
  assert.ok(log.roads > 0);
});

test('the groups stand 5-14 tiles from the store entrance, never on it', () => {
  const { world, log } = fakeWorld();
  applyRichStart(world, 0, { level: 'hard' });
  for (const g of log.groups) {
    const d = Math.max(Math.abs(g.x - STORE.entrance.x), Math.abs(g.y - STORE.entrance.y));
    assert.ok(d >= 5 && d <= 14, `group at (${g.x},${g.y}) is ${d} tiles from the entrance`);
  }
});

test('sizes: overrides replace the level values; bad sizes throw by name', () => {
  assert.deepEqual(richStartSizes('light', { recruits: 0 }), { ...RICH_START_SIZES.light, recruits: 0 });
  assert.throws(() => richStartSizes('light', { groupSize: 10 }), /groupSize must be <= 9/);
  assert.throws(() => richStartSizes('light', { groupSize: 0 }), /groupSize must be an integer >= 1/);
  assert.throws(() => richStartSizes('normal', { groups: -1 }), /groups must be an integer >= 0/);
  assert.throws(() => richStartSizes('hard', { recruits: 1.5 }), /recruits must be an integer/);
});

test('sizes grow with the level: light < normal < hard', () => {
  const total = (s: { kitPerWare: number; recruits: number; groups: number; groupSize: number }): number =>
    s.groups * s.groupSize + s.recruits + s.kitPerWare;
  assert.ok(total(RICH_START_SIZES.light) < total(RICH_START_SIZES.normal));
  assert.ok(total(RICH_START_SIZES.normal) < total(RICH_START_SIZES.hard));
});

test('a bad level throws; no barracks spot starts without a barracks; no room for the groups throws by name', () => {
  assert.equal(isAiStartLevel('normal'), true);
  assert.equal(isAiStartLevel('expert'), false);
  const { world: w1 } = fakeWorld();
  assert.throws(() => applyRichStart(w1, 0, { level: 'expert' as never }), /level must be one of none, light, normal, hard/);
  const { world: w2 } = fakeWorld({ barracksFree: false });
  const noBarracks = applyRichStart(w2, 0, { level: 'light' });
  assert.equal(noBarracks?.barracksUid, -1);
  assert.equal(noBarracks?.recruitsWaiting, 0);
  assert.ok((noBarracks?.groupUids.length ?? 0) > 0);
  const { world: w3 } = fakeWorld({ walkable: false });
  assert.throws(() => applyRichStart(w3, 0, { level: 'light' }), /start groups fit/);
});

test('normalizeSlots: aiStart defaults to none, a bad value or a human slot with aiStart throws', () => {
  const plain = normalizeSlots([{ hand: 0, kind: 'human' }, { hand: 1, kind: 'ai' }], 4);
  assert.equal(plain[1].aiStart, 'none');
  assert.equal(plain[0].aiStart, 'none');
  const set = normalizeSlots([{ hand: 0, kind: 'human' }, { hand: 1, kind: 'ai', aiStart: 'hard' }], 4);
  assert.equal(set[1].aiStart, 'hard');
  assert.throws(() => normalizeSlots([{ hand: 0, kind: 'human' }, { hand: 1, kind: 'ai', aiStart: 'expert' as never }], 4), /aiStart must be one of/);
  assert.throws(() => normalizeSlots([{ hand: 0, kind: 'human', aiStart: 'light' }, { hand: 1, kind: 'ai' }], 4), /is human; only an AI slot/);
});
