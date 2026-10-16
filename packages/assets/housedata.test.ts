// housedata.test.ts — houses.dat parser: synthetic records + the real r15472 file's verified
// values (docs/M3-SPIKE.md 2.2). Run: node --test packages/assets/housedata.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseHousesDat, housePlan } from './housedata.ts';
import type { HouseSpec } from './housedata.ts';

const BEAST = 2100;
const REC = 1688;

function writeI16(buf: Uint8Array, o: number, v: number): void {
  buf[o] = v & 0xff;
  buf[o + 1] = (v >> 8) & 0xff;
}

/** A 51052-byte file with one slot filled by the caller. */
function makeFile(fill: (buf: Uint8Array, slot: number) => void): Uint8Array {
  const buf = new Uint8Array(BEAST + 29 * REC);
  for (let slot = 0; slot < 29; slot++) fill(buf, slot);
  return buf;
}

function writeSawmill(buf: Uint8Array, slot: number): void {
  const o = BEAST + slot * REC;
  writeI16(buf, o + 0, 0); // StonePic
  writeI16(buf, o + 2, 1); // WoodPic
  writeI16(buf, o + 88 + 60, 30); // haWork1 Count
  writeI16(buf, o + 88 + 70 + 60, 10); // haWork2 Count
  writeI16(buf, o + 88 + 280 + 60, 30); // haWork5 Count
  buf[o + 1424] = 0xff; // EntranceOffsetX = −1 (i8)
  buf[o + 1528] = 4; // WoodCost
  buf[o + 1529] = 3; // StoneCost
  writeI16(buf, o + 1636, 5); // WorkerRest
  buf[o + 1638] = 0; // WareInput[1] = trunk
  buf[o + 1639] = 0xff; // −1
  buf[o + 1640] = 0xff;
  buf[o + 1641] = 0xff;
  buf[o + 1642] = 2; // WareOutput[1] = timber
  buf[o + 1643] = 0xff;
  buf[o + 1644] = 0xff;
  buf[o + 1645] = 0xff;
  buf[o + 1646] = 2; // ResProductionX
  writeI16(buf, o + 1647, 350); // stored MaxHealth (ignored by the accessor)
  buf[o + 1651] = 5; // WorkerType = carpenter
}

test('parses a synthetic houses.dat record (sawmill slot 0)', () => {
  const specs = parseHousesDat(makeFile(writeSawmill));
  assert.equal(specs.length, 30);
  const sawmill = specs[0] as HouseSpec;
  assert.equal(sawmill.typeId, 0);
  assert.equal(sawmill.workerType, 5);
  assert.deepEqual(sawmill.resIn, [0, -1, -1, -1]);
  assert.deepEqual(sawmill.resOut, [2, -1, -1, -1]);
  assert.equal(sawmill.productionX, 2);
  assert.equal(sawmill.workerRest, 5);
  assert.deepEqual(sawmill.animCounts, [30, 10, 0, 0, 30]);
  assert.equal(sawmill.entranceDx, -1);
  assert.equal(sawmill.woodPic, 1);
  assert.equal(sawmill.stonePic, 0);
  assert.equal(sawmill.woodCost, 4);
  assert.equal(sawmill.stoneCost, 3);
  assert.equal(sawmill.maxHealth, (4 + 3) * 50); // accessor, not the stored field
});

test('slot 26 (htNone) is a dummy and slot 29 (market) is not in the file', () => {
  const specs = parseHousesDat(makeFile(() => undefined));
  assert.equal(specs[26], undefined);
  assert.equal(specs[29], undefined);
  assert.equal(specs.length, 30);
});

test('a short file throws', () => {
  assert.throws(() => parseHousesDat(new Uint8Array(1000)), /houses\.dat/);
});

test('HOUSE_PLAN carries the game\u2019s hardcoded 4×4 footprint (sawmill, store, hut)', () => {
  assert.deepEqual(housePlan(0), [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [1, 2, 1, 1],
  ]);
  assert.deepEqual(housePlan(11), [
    [0, 0, 0, 0],
    [1, 1, 1, 0],
    [1, 1, 1, 0],
    [1, 2, 1, 0],
  ]);
  assert.deepEqual(housePlan(9), [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [1, 1, 1, 0],
    [1, 1, 2, 0],
  ]);
  assert.deepEqual(housePlan(26), [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]);
});

// The real install is read-only and may be absent (CI); verify when present.
const REAL = 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472/data/defines/houses.dat';

test('real houses.dat matches the frozen spec values (sawmill / hut / store)', () => {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(REAL);
  } catch {
    return; // install not present — skip
  }
  assert.equal(bytes.length, 51052);
  const specs = parseHousesDat(bytes);
  const sawmill = specs[0] as HouseSpec;
  assert.deepEqual(
    [sawmill.workerType, sawmill.resIn[0], sawmill.resOut[0], sawmill.productionX, sawmill.workerRest],
    [5, 0, 2, 2, 5],
  );
  assert.deepEqual(sawmill.animCounts, [30, 10, 0, 0, 30]);
  assert.deepEqual([sawmill.entranceDx, sawmill.woodCost, sawmill.stoneCost], [-1, 4, 3]);
  assert.deepEqual([sawmill.woodPic, sawmill.stonePic], [1, 0]);

  const hut = specs[9] as HouseSpec;
  assert.deepEqual(hut.animCounts, [0, 0, 0, 0, 0]);
  assert.deepEqual([hut.workerType, hut.woodCost, hut.stoneCost], [1, 3, 2]);
  assert.deepEqual(hut.resOut, [0, -1, -1, -1]);

  const store = specs[11] as HouseSpec;
  assert.equal(store.workerType, -1);
  assert.deepEqual(store.resIn, [-1, -1, -1, -1]);
  assert.deepEqual([store.woodCost, store.stoneCost], [6, 5]);
});
