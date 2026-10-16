// rpl.test.ts — .rpl codec round-trip + error cases, command ordinals, and the frozen
// early-stream verify vectors of docs/M2-SPIKE.md 2.4 / 3.2 / 3.3 (worker A).
// Run: node --test packages/replay/rpl.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { parseRpl, writeRplFile, writeRplPayload } from './rpl.ts';
import type { RplFile, RplRecord } from './rpl.ts';
import { CMD_NAMES, SKIP_RANDOM_CHECKS_FOR, cmdName } from './commands.ts';
import { verifyRpl } from './verify.ts';
import { step } from '../sim/rng.ts';

function dummy(): RplRecord {
  return { tick: 0, rand: 0, cmd: 0, hand: 0, data: new Uint8Array(12) };
}

function rec(tick: number, rand: number, cmd: number, hand: number, data?: Uint8Array): RplRecord {
  return { tick, rand, cmd, hand, data: data ?? new Uint8Array(12) };
}

/** Container around an arbitrary payload: [u16 13]["GIPCompressed"][zlib]. */
function pack(payload: Uint8Array): Buffer {
  const marker = Buffer.from('GIPCompressed', 'latin1');
  const body = deflateSync(payload);
  const out = Buffer.alloc(2 + marker.length + body.length);
  out.writeUInt16LE(marker.length, 0);
  marker.copy(out, 2);
  body.copy(out, 2 + marker.length);
  return out;
}

test('CMD_NAMES: 70 ordinals, frozen endpoints and zero-rand commands', () => {
  assert.equal(CMD_NAMES.length, 70);
  assert.equal(CMD_NAMES[0], 'gicNone');
  assert.equal(CMD_NAMES[47], 'gicWareDistributions');
  assert.equal(CMD_NAMES[48], 'gicGameAlertBeacon');
  assert.equal(CMD_NAMES[50], 'gicGameSpeed');
  assert.equal(CMD_NAMES[51], 'gicGameAutoSave');
  assert.equal(CMD_NAMES[52], 'gicGameAutoSaveAfterPT');
  assert.equal(CMD_NAMES[53], 'gicGameSaveReturnLobby');
  assert.equal(CMD_NAMES[54], 'gicGameLoadSave');
  assert.equal(CMD_NAMES[69], 'gicTempDoNothing');
  assert.equal(cmdName(69), 'gicTempDoNothing');
  assert.equal(cmdName(70), 'cmd(70)');
  assert.equal(cmdName(-1), 'cmd(-1)');
  assert.deepEqual([...SKIP_RANDOM_CHECKS_FOR].sort((a, b) => a - b), [48, 50, 51, 52, 53, 54]);
});

test('round trip: payload bytes + parsed fields + length identity', () => {
  const data = new Uint8Array(12);
  data[0] = 7;
  data[11] = 250;
  const f: RplFile = {
    rev: 'r15472',
    extra: 0,
    records: [dummy(), rec(4, 2135059644, 69, 4), rec(4, 0, 47, -1, data), rec(5, 524178204, 50, -1)],
  };

  const payload = writeRplPayload(f);
  assert.equal(payload.length, 16 + 22 * f.records.length); // 2 + 6 + 4 + 4 + 22*(count+1)

  const bytes = writeRplFile(f);
  const container = Buffer.from(bytes);
  assert.equal(container.readUInt16LE(0), 13);
  assert.equal(container.subarray(2, 15).toString('latin1'), 'GIPCompressed');

  const back = parseRpl(bytes);
  assert.equal(back.rev, 'r15472');
  assert.equal(back.extra, 0);
  assert.equal(back.records.length, f.records.length);
  assert.deepEqual(back.records, f.records);
  assert.deepEqual(back.records[2].data, data); // independent copy, not shared

  assert.equal(Buffer.compare(Buffer.from(writeRplPayload(back)), Buffer.from(payload)), 0);
});

test('revision is preserved verbatim for any u16 length', () => {
  const f: RplFile = { rev: 'r1', extra: 7, records: [dummy(), rec(1, 16807, 69, 0)] };
  const payload = writeRplPayload(f);
  assert.equal(payload.length, 2 + 2 + 4 + 4 + 22 * 2);
  const back = parseRpl(writeRplFile(f));
  assert.deepEqual(back, f);
});

test('parseRpl errors: bad marker / truncated payload / bad length', () => {
  assert.throws(() => parseRpl(new Uint8Array(0)), /bad marker/);
  assert.throws(() => parseRpl(new Uint8Array([13, 0, 71])), /bad marker/); // markerLen > file
  const wrongMarker = Buffer.concat([Buffer.from([4, 0]), Buffer.from('NOPE', 'latin1'), Buffer.from([1, 2, 3])]);
  assert.throws(() => parseRpl(wrongMarker), /bad marker/);

  const goodHeader = Buffer.from([13, 0]);
  const marker = Buffer.from('GIPCompressed', 'latin1');
  const garbage = Buffer.concat([goodHeader, marker, Buffer.from([0xde, 0xad, 0xbe, 0xef])]);
  assert.throws(() => parseRpl(garbage), /truncated payload/);
  assert.throws(() => parseRpl(pack(Buffer.from([1, 2, 3]))), /truncated payload/); // payload < 16 bytes

  const badLength = Buffer.alloc(16 + 22);
  badLength.writeUInt16LE(6, 0);
  badLength.write('r15472', 2, 'latin1');
  badLength.writeInt32LE(5, 8); // count 5 but only one record present
  badLength.writeUInt32LE(0, 12);
  assert.throws(() => parseRpl(pack(badLength)), /bad length/);
});

test('writeRplPayload guards record data size', () => {
  const short: RplFile = { rev: 'r15472', extra: 0, records: [dummy(), rec(1, 5, 69, 0, new Uint8Array(11))] };
  assert.throws(() => writeRplPayload(short), /bad length/);
});

// autosave01 records #1..#18 exactly as in docs/M2-SPIKE.md 2.4 (identical in all six files).
const EARLY: ReadonlyArray<readonly [number, number, number, number]> = [
  [4, 50, -1, 0], // #1 gicGameSpeed (SKIP, no draw)
  [4, 69, 4, 2135059644], // #2 first check
  [4, 47, 4, 0], // #3 continuation of #4
  [4, 47, 4, 1643178985], // #4
  [4, 69, 0, 269500475], // #5
  [4, 47, 0, 0], // #6 continuation of #7
  [4, 47, 0, 451471802], // #7
  [5, 69, 4, 524178204], // #8
  [5, 69, 0, 885154634], // #9
  [6, 69, 4, 1548408412], // #10
  [6, 69, 0, 893346138], // #11
  [8, 69, 4, 934538962], // #12 (tick 7 has no records - top draw only)
  [8, 69, 0, 100940176], // #13
  [9, 69, 4, 1043294615], // #14
  [9, 69, 0, 448616550], // #15
  [10, 69, 4, 615217756], // #16 first fail: 8 sim draws at tick 10
  [10, 69, 0, 1978548434], // #17
  [11, 69, 4, 519284878], // #18
];

test('verifyRpl on the frozen early stream: seed, K=12, first fail #16 sim=1527758834', () => {
  const f: RplFile = {
    rev: 'r15472',
    extra: 0,
    records: [dummy(), ...EARLY.map(([tick, cmd, hand, rand]) => rec(tick, rand, cmd, hand))],
  };
  const report = verifyRpl(f);

  assert.equal(report.rev, 'r15472');
  assert.equal(report.count, 18);
  assert.equal(report.checks, 15);
  assert.equal(report.lastRecordTick, 11);
  assert.equal(report.lastCheckTick, 11);
  assert.equal(report.seed, 1247813158);
  assert.equal(report.seedAppliedBack, 5);
  assert.deepEqual(report.firstCheck, {
    index: 2,
    tick: 4,
    cmd: 69,
    cmdName: 'gicTempDoNothing',
    hand: 4,
    rand: 2135059644,
  });

  assert.equal(report.k, 12);
  assert.deepEqual(report.firstFail, {
    index: 16,
    tick: 10,
    cmd: 69,
    cmdName: 'gicTempDoNothing',
    hand: 4,
    fileRand: 615217756,
    simRand: 1527758834,
  });

  assert.deepEqual(report.pairs, { ok: 12, bad: 2, anomalies: 0 });
  assert.deepEqual(report.extraPairs, [
    [8, 1],
    [39, 1],
  ]); // #15->#16 (8 sim draws at tick 10), #17->#18 (39 sim draws at tick 11)
});

test('verifyRpl on a clean synthetic file: K = checks, no fail, no extras', () => {
  // One check per listed tick, some ticks empty (top draws only), one SKIP record (cmd 51, rand 0).
  let state = 777001;
  let tick = 0;
  const records: RplRecord[] = [dummy()];
  const check = (at: number, cmd = 69, hand = 0): void => {
    while (tick < at) {
      state = step(state);
      tick += 1;
    }
    state = step(state);
    records.push(rec(at, state, cmd, hand));
  };
  check(1);
  check(2);
  records.push(rec(2, 0, 51, 4)); // gicGameAutoSave mid-tick: no draw
  check(3);
  records.push(rec(4, 0, 50, -1)); // gicGameSpeed on an otherwise empty tick: no draw
  check(5, 50, -1);
  check(8);

  const report = verifyRpl({ rev: 'r15472', extra: 0, records });
  assert.equal(report.seed, 777001);
  assert.equal(report.checks, 5);
  assert.equal(report.k, 5);
  assert.equal(report.firstFail, null);
  assert.deepEqual(report.pairs, { ok: 4, bad: 0, anomalies: 0 });
  assert.deepEqual(report.extraPairs, []);
});
