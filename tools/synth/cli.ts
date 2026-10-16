// cli.ts — M2 independent synthetic .rpl generator + self-check reader (docs/M2-SPIKE.md section 4.2).
// Writes exact.rpl, corrupt.rpl, multirec.rpl and one *.expect.json per file; the expect keys are
// exactly worker A's `--json` key set from section 3.3, with `file` = basename of the .rpl.
// Independent oracle by design: own BigInt Park-Miller step, own zlib container writer, own
// verification model; imports nothing from packages/**.
// Draw model (section 2.3): one unconditional top draw per tick (even for empty ticks); one stored
// rand on the LAST record of each non-SKIP group; continuation records and SKIP commands
// (48/50/51/52/53/54) carry rand=0.
// Usage:
//   node tools/synth/cli.ts --out <dir> [--records N] [--seed S] [--selfcheck]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const RNG_M = 2147483647n; // 2^31 - 1, Park-Miller modulus (section 2.2)
const RNG_A = 16807n; // Park-Miller multiplier

const GIP_MARKER = 'GIPCompressed';
const RPL_REV = 'r15472';
const DUMMY_COUNT = 0;

const GIC_NONE = 0;
const GIC_WARE_DISTRIBUTIONS = 47;
const GIC_GAME_SPEED = 50; // gicGameSpeed, in SKIP_RANDOM_CHECKS_FOR
const GIC_GAME_AUTO_SAVE = 51; // gicGameAutoSave, in SKIP_RANDOM_CHECKS_FOR
const GIC_TEMP_DO_NOTHING = 69;
const CORRUPT_INDEX = 777; // record index to patch in corrupt.rpl (dummy = index 0)

const CMD_NAMES = new Map<number, string>([
  [GIC_NONE, 'gicNone'],
  [GIC_WARE_DISTRIBUTIONS, 'gicWareDistributions'],
  [GIC_GAME_SPEED, 'gicGameSpeed'],
  [GIC_GAME_AUTO_SAVE, 'gicGameAutoSave'],
  [GIC_TEMP_DO_NOTHING, 'gicTempDoNothing'],
]);

function cmdName(cmd: number): string {
  return CMD_NAMES.get(cmd) ?? `cmd(${cmd})`;
}

const FILE_NAMES = ['exact.rpl', 'corrupt.rpl', 'multirec.rpl'];

let assertionCount = 0;

function assert(cond: boolean, msg: string): void {
  assertionCount += 1;
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

// ---------------------------------------------------------------- BigInt RNG

function stepBig(state: bigint): bigint {
  return (state * RNG_A) % RNG_M;
}

function step(state: number): number {
  return Number(stepBig(BigInt(state)));
}

function modpow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if ((e & 1n) === 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

// step^k(state) = state * A^k mod M (NOT state^k), the same semantic as the sim's powStep.
function powStep(state: number, k: number): number {
  return Number((BigInt(state) * modpow(RNG_A, BigInt(k), RNG_M)) % RNG_M);
}

const INV_A = modpow(RNG_A, RNG_M - 2n, RNG_M); // A^-1 mod M (M is prime)

function invPow(value: number, k: number): number {
  return Number((BigInt(value) * modpow(INV_A, BigInt(k), RNG_M)) % RNG_M);
}

const DLOG_M = 46342; // ceil(sqrt(M-1)); i*m+j covers [0, M-2] for i,j < m
let dlogTable: Map<bigint, number> | null = null;

// Own discrete log: k with step^k(from) === to, canonical k in [0, M-2], or null when impossible.
// Baby-step/giant-step over h = to/from = A^k. A = 16807 is a primitive root mod 2^31-1, so a
// solution exists for every pair of nonzero states; null is kept for the interface contract.
function dlogK(from: number, to: number): number | null {
  const f = BigInt(from) % RNG_M;
  const t = BigInt(to) % RNG_M;
  if (f === 0n || t === 0n) return null;
  const h = (t * modpow(f, RNG_M - 2n, RNG_M)) % RNG_M; // A^k = to / from
  if (h === 1n) return 0;
  if (dlogTable === null) {
    dlogTable = new Map<bigint, number>();
    let e = 1n;
    for (let j = 0; j < DLOG_M; j++) {
      if (!dlogTable.has(e)) dlogTable.set(e, j);
      e = (e * RNG_A) % RNG_M;
    }
  }
  const m = BigInt(DLOG_M);
  const invAm = modpow(modpow(RNG_A, m, RNG_M), RNG_M - 2n, RNG_M); // A^-m
  let gamma = h;
  for (let i = 0n; i < m; i++) {
    const j = dlogTable.get(gamma);
    if (j !== undefined) return Number(i * m + BigInt(j));
    gamma = (gamma * invAm) % RNG_M;
  }
  return null;
}

// ------------------------------------------------------------ records + LCG

interface SynthRecord {
  tick: number;
  rand: number;
  cmd: number;
  hand: number;
  data: Uint8Array; // exactly 12 bytes
}

interface Built {
  records: SynthRecord[];
  drawsAt: number[]; // per record: draws performed up to and including this record's own draw
  totalDraws: number;
  emptyTicks: number;
}

function lcgNext(x: number): number {
  return (Math.imul(x, 1103515245) + 12345) & 0x7fffffff;
}

function lcgFill(x: number, n: number): { out: Uint8Array; next: number } {
  const out = new Uint8Array(n);
  let s = x;
  for (let i = 0; i < n; i++) {
    s = lcgNext(s);
    out[i] = (s >>> 16) & 0xff;
  }
  return { out, next: s };
}

function dummyRecord(): SynthRecord {
  return { tick: 0, rand: 0, cmd: GIC_NONE, hand: 0, data: new Uint8Array(12) };
}

// exact.rpl: `n` non-SKIP groups, one record each; every 97th tick is empty (top draw only).
function buildExact(n: number, seedNum: number): Built {
  const records: SynthRecord[] = [dummyRecord()];
  const drawsAt: number[] = [0];
  let draws = 0;
  let state = BigInt(seedNum);
  let lcg = seedNum & 0x7fffffff;
  let groups = 0;
  let tick = 0;
  let emptyTicks = 0;
  while (groups < n) {
    tick += 1;
    state = stepBig(state); // unconditional top draw of this tick
    draws += 1;
    if (tick % 97 === 0) {
      emptyTicks += 1; // no records at all on this tick
      continue;
    }
    groups += 1;
    state = stepBig(state); // the group draw, stored on its last = only record
    draws += 1;
    lcg = lcgNext(lcg);
    const cmd = groups % 2 === 1 ? GIC_TEMP_DO_NOTHING : GIC_WARE_DISTRIBUTIONS;
    const hand = (lcg % 9) - 1;
    lcg = lcgNext(lcg);
    const fill = lcgFill(lcg, 12);
    lcg = fill.next;
    records.push({ tick, rand: Number(state), cmd, hand, data: fill.out });
    drawsAt.push(draws);
  }
  return { records, drawsAt, totalDraws: draws, emptyTicks };
}

// multirec.rpl: same draw choreography, but groups span 1-3 records (continuations rand=0) and
// single-record SKIP commands (51/50, rand=0) are interleaved; a trailing SKIP record on the next
// tick makes lastRecordTick differ from lastCheckTick.
function buildMultirec(n: number, seedNum: number): Built {
  const records: SynthRecord[] = [dummyRecord()];
  const drawsAt: number[] = [0];
  let draws = 0;
  let state = BigInt(seedNum);
  let lcg = (seedNum ^ 0x7a3c1f) & 0x7fffffff;
  let groups = 0;
  let tick = 0;
  let emptyTicks = 0;
  while (groups < n) {
    tick += 1;
    state = stepBig(state); // unconditional top draw of this tick
    draws += 1;
    if (tick % 97 === 0) {
      emptyTicks += 1;
      continue;
    }
    lcg = lcgNext(lcg);
    const withSkip = lcg % 4 === 0;
    const skipFirst = ((lcg >>> 7) & 1) === 0;
    let skipRec: SynthRecord | null = null;
    if (withSkip) {
      const skipCmd = ((lcg >>> 8) & 1) === 0 ? GIC_GAME_AUTO_SAVE : GIC_GAME_SPEED;
      const fill = lcgFill(lcg ^ 0x1234567, 12);
      skipRec = { tick, rand: 0, cmd: skipCmd, hand: -1, data: fill.out }; // SKIP: no draw
    }
    groups += 1;
    lcg = lcgNext(lcg);
    const size = 1 + (lcg % 3); // 1..3 records in this group
    const cmd = groups % 2 === 1 ? GIC_WARE_DISTRIBUTIONS : GIC_TEMP_DO_NOTHING;
    const hand = ((lcg >>> 9) % 9) - 1;
    const group: SynthRecord[] = [];
    for (let j = 0; j < size; j++) {
      const last = j === size - 1;
      let rand = 0;
      if (last) {
        state = stepBig(state); // one draw per non-SKIP group, on its last record
        draws += 1;
        rand = Number(state);
      }
      const fill = lcgFill(lcg + j, 12);
      lcg = fill.next;
      group.push({ tick, rand, cmd, hand, data: fill.out });
    }
    if (skipRec !== null && skipFirst) {
      records.push(skipRec);
      drawsAt.push(0); // SKIP: no draw
      records.push(...group);
      for (let j = 0; j < size; j++) drawsAt.push(j === size - 1 ? draws : 0);
    } else {
      records.push(...group);
      for (let j = 0; j < size; j++) drawsAt.push(j === size - 1 ? draws : 0);
      if (skipRec !== null) {
        records.push(skipRec);
        drawsAt.push(0);
      }
    }
  }
  // Trailing zero-rand SKIP command: last check is NOT the last record (section 3.3 reporting).
  tick += 1;
  state = stepBig(state); // top draw of the trailing tick
  draws += 1;
  const fill = lcgFill(lcg, 12);
  records.push({ tick, rand: 0, cmd: GIC_GAME_SPEED, hand: -1, data: fill.out });
  drawsAt.push(0);
  return { records, drawsAt, totalDraws: draws, emptyTicks };
}

// Independent confirmation that the model formula matches the actual draw count between every pair
// of adjacent nonzero records (draw bookkeeping, not the arithmetic identity).
function assertModel0Exact(built: Built, label: string): number {
  const idx: number[] = [];
  for (let i = 1; i < built.records.length; i++) if (built.records[i].rand !== 0) idx.push(i);
  let pairs = 0;
  for (let n = 1; n < idx.length; n++) {
    const ia = idx[n - 1];
    const ib = idx[n];
    let between = 0;
    for (let j = ia + 1; j <= ib; j++) if (built.records[j].rand !== 0) between += 1;
    const model0 = built.records[ib].tick - built.records[ia].tick + between;
    const drawn = built.drawsAt[ib] - built.drawsAt[ia];
    assert(drawn === model0, `${label}: record ${ia}->${ib}: ${drawn} draws but model0=${model0}`);
    pairs += 1;
  }
  return pairs;
}

// -------------------------------------------------------------- verification

interface CheckInfo {
  index: number;
  tick: number;
  cmd: number;
  cmdName: string;
  hand: number;
  rand: number;
}

interface FirstFail {
  index: number;
  tick: number;
  cmd: number;
  cmdName: string;
  hand: number;
  fileRand: number;
  simRand: number;
}

interface ExpectReport {
  rev: string;
  count: number;
  checks: number;
  lastRecordTick: number;
  lastCheckTick: number | null;
  seed: number;
  seedAppliedBack: number;
  firstCheck: CheckInfo | null;
  k: number;
  firstFail: FirstFail | null;
  pairs: { ok: number; bad: number; anomalies: number };
  extraPairs: Array<[number, number]>;
  file: string;
}

// Section 3.3 semantics: seed recovered backwards from the first nonzero record, one step per tick
// crossed + one step per nonzero record, K = matched prefix, pairs classified by model0 vs dlogK.
function analyze(records: SynthRecord[], rev: string, file: string): ExpectReport {
  const count = records.length - 1;
  const nonzero: number[] = [];
  for (let i = 1; i <= count; i++) if (records[i].rand !== 0) nonzero.push(i);
  const checks = nonzero.length;

  let seed = 0;
  let seedAppliedBack = 0;
  let firstCheck: CheckInfo | null = null;
  if (checks > 0) {
    const i = nonzero[0];
    const t = records[i].tick;
    let prior = 0;
    for (let j = 1; j < i; j++) if (records[j].rand !== 0) prior += 1;
    seedAppliedBack = t + prior + 1;
    seed = invPow(records[i].rand, seedAppliedBack);
    firstCheck = {
      index: i,
      tick: t,
      cmd: records[i].cmd,
      cmdName: cmdName(records[i].cmd),
      hand: records[i].hand,
      rand: records[i].rand,
    };
  }

  let state = BigInt(seed);
  let tick = 0;
  let k = 0;
  let firstFail: FirstFail | null = null;
  for (let i = 1; i <= count; i++) {
    const r = records[i];
    while (tick < r.tick) {
      state = stepBig(state);
      tick += 1;
    }
    if (r.rand !== 0) {
      state = stepBig(state);
      if (state !== BigInt(r.rand)) {
        firstFail = {
          index: i,
          tick: r.tick,
          cmd: r.cmd,
          cmdName: cmdName(r.cmd),
          hand: r.hand,
          fileRand: r.rand,
          simRand: Number(state),
        };
        break;
      }
      k += 1;
    }
  }

  let ok = 0;
  let bad = 0;
  let anomalies = 0;
  const histogram = new Map<number, number>();
  for (let n = 1; n < nonzero.length; n++) {
    const ia = nonzero[n - 1];
    const ib = nonzero[n];
    let between = 0;
    for (let j = ia + 1; j <= ib; j++) if (records[j].rand !== 0) between += 1;
    const model0 = records[ib].tick - records[ia].tick + between;
    const ra = records[ia].rand;
    const rb = records[ib].rand;
    if (powStep(ra, model0) === rb) {
      ok += 1;
      continue;
    }
    const dk = dlogK(ra, rb);
    if (dk === null || dk < model0) {
      anomalies += 1;
      continue;
    }
    bad += 1;
    const extra = dk - model0;
    histogram.set(extra, (histogram.get(extra) ?? 0) + 1);
  }

  return {
    rev,
    count,
    checks,
    lastRecordTick: count >= 1 ? records[count].tick : 0,
    lastCheckTick: checks > 0 ? records[nonzero[checks - 1]].tick : null,
    seed,
    seedAppliedBack,
    firstCheck,
    k,
    firstFail,
    pairs: { ok, bad, anomalies },
    extraPairs: [...histogram.entries()].sort((a, b) => a[0] - b[0]),
    file,
  };
}

// ---------------------------------------------------------- container writer

function writeRpl(records: SynthRecord[], rev: string, extra: number): Buffer {
  const count = records.length - 1;
  const payload = Buffer.alloc(16 + 22 * records.length);
  let o = 0;
  const revBytes = Buffer.from(rev, 'latin1');
  payload.writeUInt16LE(revBytes.length, o);
  o += 2;
  revBytes.copy(payload, o);
  o += revBytes.length;
  payload.writeInt32LE(count, o);
  o += 4;
  payload.writeUInt32LE(extra, o);
  o += 4;
  for (const r of records) {
    payload.writeUInt32LE(r.tick, o);
    payload.writeInt32LE(r.rand, o + 4);
    payload.writeUInt8(r.cmd, o + 8);
    payload.writeInt8(r.hand, o + 9);
    Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength).copy(payload, o + 10);
    o += 22;
  }
  if (o !== payload.length) throw new Error(`payload writer short-write: ${o} != ${payload.length}`);
  const marker = Buffer.from(GIP_MARKER, 'latin1');
  const head = Buffer.alloc(2);
  head.writeUInt16LE(marker.length, 0);
  return Buffer.concat([head, marker, deflateSync(payload)]);
}

interface ReadRpl {
  rev: string;
  extra: number;
  count: number;
  records: SynthRecord[];
}

function readRpl(bytes: Buffer): ReadRpl {
  if (bytes.length < 2) throw new Error('file too short for a container marker');
  const markerLen = bytes.readUInt16LE(0);
  if (bytes.length < 2 + markerLen) throw new Error('truncated container marker');
  const marker = bytes.toString('latin1', 2, 2 + markerLen);
  if (marker !== GIP_MARKER) throw new Error(`bad container marker "${marker}" (expected "${GIP_MARKER}")`);
  const payload = inflateSync(bytes.subarray(2 + markerLen));
  let o = 0;
  const revLen = payload.readUInt16LE(o);
  o += 2;
  const rev = payload.toString('latin1', o, o + revLen);
  o += revLen;
  const count = payload.readInt32LE(o);
  o += 4;
  const extra = payload.readUInt32LE(o);
  o += 4;
  const want = 16 + 22 * (count + 1);
  if (payload.length !== want) {
    throw new Error(`payload length ${payload.length}, expected ${want} (16 + 22*(count+1) identity)`);
  }
  const records: SynthRecord[] = [];
  for (let i = 0; i <= count; i++) {
    const tick = payload.readUInt32LE(o);
    const rand = payload.readInt32LE(o + 4);
    const cmd = payload.readUInt8(o + 8);
    const hand = payload.readInt8(o + 9);
    const data = Uint8Array.from(payload.subarray(o + 10, o + 22));
    records.push({ tick, rand, cmd, hand, data });
    o += 22;
  }
  return { rev, extra, count, records };
}

interface Mismatch {
  path: string;
  expected: unknown;
  actual: unknown;
}

function compare(expected: unknown, actual: unknown, path = '$'): Mismatch | null {
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return { path, expected, actual };
    if (expected.length !== actual.length) {
      return { path: `${path}.length`, expected: expected.length, actual: actual.length };
    }
    for (let i = 0; i < expected.length; i++) {
      const m = compare(expected[i], actual[i], `${path}[${i}]`);
      if (m !== null) return m;
    }
    return null;
  }
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    const e = expected as Record<string, unknown>;
    const a = actual as Record<string, unknown>;
    const ek = Object.keys(e).sort();
    const ak = Object.keys(a).sort();
    if (ek.join('\u0000') !== ak.join('\u0000')) {
      return { path: `${path}.keys`, expected: ek.join(','), actual: ak.join(',') };
    }
    for (const key of ek) {
      const m = compare(e[key], a[key], `${path}.${key}`);
      if (m !== null) return m;
    }
    return null;
  }
  return Object.is(expected, actual) ? null : { path, expected, actual };
}

// --------------------------------------------------------------- self-check

function expectPathFor(name: string): string {
  return name.replace(/\.rpl$/, '.expect.json');
}

function runSelfcheck(outDir: string): boolean {
  let allOk = true;
  for (const name of FILE_NAMES) {
    const bytes = readFileSync(join(outDir, name));
    const parsed = readRpl(bytes);
    const report = analyze(parsed.records, parsed.rev, name);
    assert(parsed.rev === RPL_REV, `${name}: rev ${parsed.rev} === ${RPL_REV}`);
    assert(parsed.extra === 0, `${name}: extra is 0`);
    assert(parsed.count === parsed.records.length - 1, `${name}: count === records-1`);
    assert(
      parsed.records[0].tick === 0 && parsed.records[0].rand === 0 && parsed.records[0].cmd === DUMMY_COUNT,
      `${name}: record 0 is the all-zero dummy`,
    );
    const want = JSON.parse(readFileSync(join(outDir, expectPathFor(name)), 'utf8')) as ExpectReport;
    const mismatch = compare(want, report);
    if (mismatch === null) {
      console.log(
        `SELFCHECK OK ${name} keys=${Object.keys(want).length} bytes=${bytes.length} records=${parsed.records.length}`,
      );
    } else {
      allOk = false;
      console.log(
        `SELFCHECK FAIL ${name} at ${mismatch.path}: expected=${JSON.stringify(mismatch.expected)} actual=${JSON.stringify(mismatch.actual)}`,
      );
    }
  }
  if (allOk) console.log(`SELFCHECK OK files=${FILE_NAMES.length} (independent reader vs expect.json, every key)`);
  return allOk;
}

// --------------------------------------------------------------------- main

interface Options {
  out: string;
  records: number;
  seed: number;
  selfcheck: boolean;
}

function usage(): string {
  return 'usage: node tools/synth/cli.ts --out <dir> [--records N] [--seed S] [--selfcheck]';
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { out: '', records: 1000, seed: 777001, selfcheck: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}\n${usage()}`);
      return argv[i];
    };
    if (arg === '--out') opts.out = value();
    else if (arg === '--records') opts.records = Number(value());
    else if (arg === '--seed') opts.seed = Number(value());
    else if (arg === '--selfcheck') opts.selfcheck = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    }
  }
  if (opts.out === '') throw new Error(`--out is required\n${usage()}`);
  if (!Number.isInteger(opts.records) || opts.records < 1) {
    throw new Error(`--records expects a positive integer, got "${opts.records}"\n${usage()}`);
  }
  if (!Number.isInteger(opts.seed) || opts.seed < 1 || opts.seed >= Number(RNG_M)) {
    throw new Error(`--seed expects an integer in 1..${RNG_M - 1n}, got "${opts.seed}"\n${usage()}`);
  }
  if (opts.records <= CORRUPT_INDEX) {
    throw new Error(`--records must be > ${CORRUPT_INDEX} (corrupt.rpl patches record index ${CORRUPT_INDEX})\n${usage()}`);
  }
  return opts;
}

function writeOut(path: string, data: Buffer | string): void {
  writeFileSync(path, data);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selfcheck) {
    if (!runSelfcheck(opts.out)) process.exitCode = 1;
    return;
  }
  mkdirSync(opts.out, { recursive: true });

  // 1. exact.rpl
  const exact = buildExact(opts.records, opts.seed);
  const exactExpect = analyze(exact.records, RPL_REV, 'exact.rpl');
  const exactPairs = assertModel0Exact(exact, 'exact');
  assert(exactExpect.checks === opts.records, `exact: checks=${exactExpect.checks} === --records`);
  assert(exactExpect.k === opts.records, `exact: k=${exactExpect.k} === checks`);
  assert(exactExpect.firstFail === null, 'exact: no first fail');
  assert(exactPairs === opts.records - 1, `exact: ${exactPairs} adjacent check pairs`);
  assert(exactExpect.pairs.ok === opts.records - 1 && exactExpect.pairs.bad === 0 && exactExpect.pairs.anomalies === 0, 'exact: all pairs ok');
  assert(exactExpect.extraPairs.length === 0, 'exact: extraPairs empty');
  assert(exactExpect.seed === opts.seed, `exact: recovered seed ${exactExpect.seed} === --seed`);
  assert(exactExpect.seedAppliedBack === 2, 'exact: first check backs out 2 draws (tick 1 top + group draw)');
  assert(exact.emptyTicks > 0, 'exact: empty ticks exist (top-draw-only advancement)');
  assert(exactExpect.lastRecordTick > exactExpect.checks, 'exact: lastRecordTick > checks (empty ticks spread ticks)');
  for (let i = 1; i < exact.records.length; i++) {
    assert(exact.records[i].rand !== 0, `exact: no zero-rand record at index ${i}`);
  }
  const exactBytes = writeRpl(exact.records, RPL_REV, 0);
  writeOut(join(opts.out, 'exact.rpl'), exactBytes);
  writeOut(join(opts.out, 'exact.expect.json'), `${JSON.stringify(exactExpect, null, 2)}\n`);
  console.log(
    `WROTE ${join(opts.out, 'exact.rpl').replace(/\\/g, '/')} bytes=${exactBytes.length} count=${exactExpect.count} records=${exact.records.length}`,
  );

  // 2. corrupt.rpl = exact with record index 777 patched to (orig + 1) mod M
  const corrupt = exact.records.map((r) => ({ ...r, data: Uint8Array.from(r.data) }));
  const origRand = corrupt[CORRUPT_INDEX].rand;
  const injected = (origRand + 1) % Number(RNG_M);
  assert(injected !== 0 && injected !== origRand, 'corrupt: injected rand is a nonzero change');
  corrupt[CORRUPT_INDEX] = { ...corrupt[CORRUPT_INDEX], rand: injected };
  const corruptExpect = analyze(corrupt, RPL_REV, 'corrupt.rpl');
  assert(corruptExpect.k === CORRUPT_INDEX - 1, `corrupt: k=${corruptExpect.k} === ${CORRUPT_INDEX - 1}`);
  assert(corruptExpect.firstFail !== null && corruptExpect.firstFail.index === CORRUPT_INDEX, `corrupt: first fail at index ${CORRUPT_INDEX}`);
  assert(corruptExpect.firstFail !== null && corruptExpect.firstFail.fileRand === injected, 'corrupt: fileRand is the injected value');
  assert(corruptExpect.firstFail !== null && corruptExpect.firstFail.simRand === origRand, 'corrupt: simRand is the true chain value');
  assert(corruptExpect.firstFail !== null && corruptExpect.firstFail.index === 777 && corruptExpect.firstFail.cmd === exact.records[777].cmd, 'corrupt: first fail carries the record fields');
  assert(corruptExpect.seed === opts.seed, 'corrupt: seed unchanged (first check untouched)');
  assert(corruptExpect.checks === opts.records, 'corrupt: checks unchanged');
  assert(corruptExpect.firstCheck !== null && compare(corruptExpect.firstCheck, exactExpect.firstCheck) === null, 'corrupt: first check unchanged');
  assert(corruptExpect.pairs.anomalies === 0, 'corrupt: patched pairs classify as bad, not anomalies');
  assert(corruptExpect.pairs.bad === 2, `corrupt: exactly the two patched pairs are bad (got ${corruptExpect.pairs.bad})`);
  assert(corruptExpect.pairs.ok === opts.records - 3, 'corrupt: remaining pairs ok');
  const corruptBytes = writeRpl(corrupt, RPL_REV, 0);
  writeOut(join(opts.out, 'corrupt.rpl'), corruptBytes);
  writeOut(join(opts.out, 'corrupt.expect.json'), `${JSON.stringify(corruptExpect, null, 2)}\n`);
  console.log(
    `WROTE ${join(opts.out, 'corrupt.rpl').replace(/\\/g, '/')} bytes=${corruptBytes.length} count=${corruptExpect.count} records=${corrupt.length} injectedRand=${injected}`,
  );

  // 3. multirec.rpl
  const multi = buildMultirec(opts.records, opts.seed);
  const multiExpect = analyze(multi.records, RPL_REV, 'multirec.rpl');
  const multiPairs = assertModel0Exact(multi, 'multirec');
  assert(multiExpect.checks === opts.records, `multirec: checks=${multiExpect.checks} === --records (only nonzero records count)`);
  assert(multiExpect.k === multiExpect.checks, `multirec: k=${multiExpect.k} === checks`);
  assert(multiExpect.firstFail === null, 'multirec: no first fail');
  assert(multiExpect.pairs.bad === 0 && multiExpect.pairs.anomalies === 0, 'multirec: model0-exact pairs');
  assert(multiExpect.extraPairs.length === 0, 'multirec: extraPairs empty');
  assert(multiPairs === opts.records - 1, `multirec: ${multiPairs} adjacent check pairs`);
  assert(multiExpect.seed === opts.seed, `multirec: recovered seed ${multiExpect.seed} === --seed`);
  assert(multiExpect.seedAppliedBack === 2, 'multirec: first check backs out 2 draws');
  assert(multiExpect.lastRecordTick === (multiExpect.lastCheckTick ?? -1) + 1, 'multirec: trailing zero-rand SKIP record after the last check');
  const zeroRand = multi.records.slice(1).filter((r) => r.rand === 0);
  const skips = zeroRand.filter((r) => r.cmd === GIC_GAME_SPEED || r.cmd === GIC_GAME_AUTO_SAVE);
  assert(skips.length >= 2, `multirec: SKIP commands interleaved (${skips.length})`);
  let continuations = 0;
  for (let i = 1; i < multi.records.length - 1; i++) {
    const a = multi.records[i];
    const b = multi.records[i + 1];
    if (a.rand === 0 && b.rand !== 0 && a.tick === b.tick && a.cmd === b.cmd) continuations += 1;
  }
  assert(continuations > 0, `multirec: continuation records exist (${continuations})`);
  assert(zeroRand.length === multi.records.length - 1 - opts.records, 'multirec: every non-check record carries rand=0');
  const multiBytes = writeRpl(multi.records, RPL_REV, 0);
  writeOut(join(opts.out, 'multirec.rpl'), multiBytes);
  writeOut(join(opts.out, 'multirec.expect.json'), `${JSON.stringify(multiExpect, null, 2)}\n`);
  console.log(
    `WROTE ${join(opts.out, 'multirec.rpl').replace(/\\/g, '/')} bytes=${multiBytes.length} count=${multiExpect.count} records=${multi.records.length} zeroRand=${zeroRand.length}`,
  );

  console.log(`ASSERTIONS PASS count=${assertionCount}`);
  const ok = runSelfcheck(opts.out);
  if (ok) console.log(`SYNTH OK files=6 out=${opts.out.replace(/\\/g, '/')}`);
  else process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
