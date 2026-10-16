// cli.ts — M2 `.rng` (DBG_RNG_SPY) draw-trace oracle for kam-web (docs/M2-SPIKE.md section 4.1).
// Parses the RNGCompressed container, the caller table and every per-tick record, flattens each draw
// as { tick, seq, seed, caller }, chain-checks that consecutive seeds are exactly one Park-Miller
// step apart, and summarizes the caller histogram.
// Independent of packages/** on purpose: own BigInt step (the sim's is a Schrage double path).
// Format source: _ref/kam_remake/src/game/misc/KM_RandomChecks.pas (SaveToPathAsync 427-484,
// LoadHeader 270-288, SaveTickToStream 220-242).
// Usage:
//   node tools/rnginfo/cli.ts <file.rng> [--json] [--top N] [--dump <tick>]
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { inflateSync } from 'node:zlib';

const RNG_M = 2147483647n; // 2^31 - 1, Park-Miller modulus (section 2.2)
const RNG_A = 16807n; // Park-Miller multiplier

// Own independent step: pure BigInt, nothing imported from packages/** (section 4.1).
function step(state: number): number {
  return Number((BigInt(state) * RNG_A) % RNG_M);
}

const RNG_MARKER = 'RNGCompressed';
const CALLERS_MARKER = 'CallersTable';
const CALLS_MARKER = 'KaMRandom_calls';
const VALUE_TYPE_NAMES: readonly string[] = ['none', 'int', 'single', 'ext'];
const EXTENDED_BYTES = 10; // FPC x86_64 `Extended` payload of lrtExt records

class FileError extends Error {}

interface RngRecord {
  tick: number;
  seq: number; // 0-based index of the record inside its tick
  seed: number; // post-draw Park-Miller state, 1..M-1 (same semantics as .rpl rands)
  valueType: number; // 0 none, 1 int, 2 single, 3 ext
  value: number; // decoded draw value (int / single / reduced-Extended)
  callerId: number;
  caller: string;
}

interface ParsedTick {
  tick: number;
  count: number;
  records: RngRecord[];
}

interface ParsedRng {
  file: string;
  callerNames: Map<number, string>;
  ticks: ParsedTick[];
}

interface RngSummary {
  file: string;
  records: number;
  firstTick: number;
  lastTick: number;
  chainOk: number;
  chainBad: number;
  firstSeed: number;
  lastSeed: number;
  callers: number;
  storeCommand: number;
  runtimer: number;
  top: Array<[string, number]>;
  callerHistogram: Record<string, number>;
  ticks: Array<{ tick: number; count: number }>;
}

interface Options {
  files: string[];
  json: boolean;
  top: number;
  dumpTick: number | null;
}

function usage(): string {
  return 'usage: node tools/rnginfo/cli.ts <file.rng> [--json] [--top N] [--dump <tick>]';
}

class Cursor {
  buf: Buffer;
  pos = 0;
  constructor(buf: Buffer) {
    this.buf = buf;
  }
  need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new FileError(`truncated payload at byte ${this.pos} (needed ${n} more)`);
    }
  }
  u8(): number {
    this.need(1);
    const v = this.buf.readUInt8(this.pos);
    this.pos += 1;
    return v;
  }
  u16(): number {
    this.need(2);
    const v = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return v;
  }
  i32(): number {
    this.need(4);
    const v = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  f32(): number {
    this.need(4);
    const v = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return v;
  }
  ansi(): string {
    const n = this.u16();
    this.need(n);
    const s = this.buf.toString('latin1', this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
  // FPC `Extended` on x86_64: 8-byte mantissa + u16 sign/exponent (10 bytes).
  extended(): number {
    this.need(EXTENDED_BYTES);
    const mantissa = this.buf.readBigUInt64LE(this.pos);
    const se = this.buf.readUInt16LE(this.pos + 8);
    this.pos += EXTENDED_BYTES;
    const sign = (se & 0x8000) !== 0 ? -1 : 1;
    const exp = se & 0x7fff;
    if (exp === 0 && mantissa === 0n) return 0;
    if (exp === 0x7fff) return mantissa === 0n ? sign * Infinity : NaN;
    if (exp === 0) return sign * (Number(mantissa) / 2 ** 63) * 2 ** -16382; // subnormal
    return sign * (Number(mantissa) / 2 ** 63) * 2 ** (exp - 16383);
  }
}

function expectMarker(c: Cursor, want: string): void {
  const got = c.ansi();
  if (got !== want) throw new FileError(`bad marker "${got}" (expected "${want}")`);
}

function readBytes(path: string): Buffer {
  try {
    return readFileSync(path);
  } catch (err) {
    throw new FileError(`cannot read ${path} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function parseRng(bytes: Buffer, file: string): ParsedRng {
  if (bytes.length < 2) throw new FileError('file too short for a container marker');
  const markerLen = bytes.readUInt16LE(0);
  if (bytes.length < 2 + markerLen) throw new FileError('truncated container marker');
  const rawMarker = bytes.toString('latin1', 2, 2 + markerLen);
  if (rawMarker !== RNG_MARKER) {
    const shown = rawMarker.slice(0, 40).replace(/[^\x20-\x7e]/g, '.');
    throw new FileError(`bad container marker "${shown}" (expected "${RNG_MARKER}")`);
  }
  let payload: Buffer;
  try {
    payload = inflateSync(bytes.subarray(2 + markerLen));
  } catch (err) {
    throw new FileError(`zlib inflate failed (${err instanceof Error ? err.message : String(err)})`);
  }

  const c = new Cursor(payload);
  expectMarker(c, CALLERS_MARKER);
  const callerCount = c.i32();
  if (callerCount < 0) throw new FileError(`negative caller count ${callerCount}`);
  const callerNames = new Map<number, string>();
  for (let i = 0; i < callerCount; i++) {
    const id = c.u8();
    callerNames.set(id, c.ansi());
  }
  expectMarker(c, CALLS_MARKER);
  const savedTicks = c.i32();
  if (savedTicks < 0) throw new FileError(`negative saved-tick count ${savedTicks}`);

  const ticks: ParsedTick[] = [];
  for (let t = 0; t < savedTicks; t++) {
    const size = c.u32();
    const start = c.pos;
    const tick = c.u32();
    const count = c.i32();
    if (count < 0) throw new FileError(`tick ${tick}: negative record count ${count}`);
    const records: RngRecord[] = [];
    for (let k = 0; k < count; k++) {
      const seed = c.i32();
      const valueType = c.u8();
      const callerId = c.u8();
      let value = 0;
      if (valueType === 1) value = c.i32();
      else if (valueType === 2) value = c.f32();
      else if (valueType === 3) value = c.extended();
      else if (valueType !== 0) throw new FileError(`tick ${tick}: record ${k}: unknown valueType ${valueType}`);
      records.push({
        tick,
        seq: k,
        seed,
        valueType,
        value,
        callerId,
        caller: callerNames.get(callerId) ?? `#${callerId}`,
      });
    }
    const used = c.pos - start;
    if (used !== size) {
      throw new FileError(`tick ${tick}: tickStreamSize=${size} but the record stream parsed to ${used} bytes`);
    }
    ticks.push({ tick, count, records });
  }
  if (c.pos !== payload.length) {
    throw new FileError(`payload has ${payload.length - c.pos} trailing byte(s)`);
  }
  return { file, callerNames, ticks };
}

function countCaller(histogram: Map<string, number>, suffix: string): number {
  let n = 0;
  for (const [name, count] of histogram) {
    if (name === suffix || name.endsWith(`.${suffix}`)) n += count;
  }
  return n;
}

function summarize(parsed: ParsedRng, topN: number): RngSummary {
  const histogram = new Map<string, number>();
  for (const name of parsed.callerNames.values()) histogram.set(name, 0);

  let records = 0;
  let chainOk = 0;
  let chainBad = 0;
  let firstSeed = 0;
  let lastSeed = 0;
  let prevSeed: number | null = null;
  const tickList: Array<{ tick: number; count: number }> = [];
  for (const t of parsed.ticks) {
    tickList.push({ tick: t.tick, count: t.count });
    for (const r of t.records) {
      records += 1;
      if (prevSeed !== null) {
        if (step(prevSeed) === r.seed) chainOk += 1;
        else chainBad += 1;
      }
      prevSeed = r.seed;
      if (records === 1) firstSeed = r.seed;
      lastSeed = r.seed;
      histogram.set(r.caller, (histogram.get(r.caller) ?? 0) + 1);
    }
  }

  const top = [...histogram.entries()]
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, topN);

  return {
    file: parsed.file,
    records,
    firstTick: tickList.length > 0 ? tickList[0].tick : 0,
    lastTick: tickList.length > 0 ? tickList[tickList.length - 1].tick : 0,
    chainOk,
    chainBad,
    firstSeed,
    lastSeed,
    callers: parsed.callerNames.size,
    storeCommand: countCaller(histogram, 'StoreCommand'),
    runtimer: countCaller(histogram, 'RunningTimer'),
    top,
    callerHistogram: Object.fromEntries(histogram),
    ticks: tickList,
  };
}

function textLine(s: RngSummary): string {
  const top = s.top.map(([name, count]) => `${name}:${count}`).join(',');
  return (
    `RNGINFO ${s.file} records=${s.records} ticks=${s.firstTick}..${s.lastTick} ` +
    `chainOk=${s.chainOk} chainBad=${s.chainBad} callers=${s.callers} ` +
    `storeCommand=${s.storeCommand} runtimer=${s.runtimer} top=${top}`
  );
}

function dumpTick(parsed: ParsedRng, tick: number): string[] {
  const t = parsed.ticks.find((x) => x.tick === tick);
  if (t === undefined) {
    const first = parsed.ticks.length > 0 ? parsed.ticks[0].tick : 0;
    const last = parsed.ticks.length > 0 ? parsed.ticks[parsed.ticks.length - 1].tick : 0;
    throw new FileError(`tick ${tick} not found (file covers ${first}..${last})`);
  }
  const lines = [`DUMP ${parsed.file} tick=${tick} records=${t.count}`];
  for (const r of t.records) {
    const type = VALUE_TYPE_NAMES[r.valueType] ?? `type${r.valueType}`;
    lines.push(`${r.seq} ${r.seed} ${type} ${r.caller}`);
  }
  return lines;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { files: [], json: false, top: 5, dumpTick: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}\n${usage()}`);
      return argv[i];
    };
    if (arg === '--json') opts.json = true;
    else if (arg === '--top') {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--top expects a non-negative integer, got "${raw}"\n${usage()}`);
      opts.top = n;
    } else if (arg === '--dump') {
      const raw = value();
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--dump expects a tick number, got "${raw}"\n${usage()}`);
      opts.dumpTick = n;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    } else {
      opts.files.push(arg);
    }
  }
  if (opts.files.length === 0) throw new Error(`a .rng file is required\n${usage()}`);
  if (opts.json && opts.files.length > 1) throw new Error(`--json supports exactly one file\n${usage()}`);
  if (opts.dumpTick !== null && opts.files.length > 1) throw new Error(`--dump supports exactly one file\n${usage()}`);
  if (opts.json && opts.dumpTick !== null) throw new Error(`--json and --dump are mutually exclusive\n${usage()}`);
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  for (const path of opts.files) {
    const parsed = parseRng(readBytes(path), basename(path));
    const summary = summarize(parsed, opts.top);
    if (opts.dumpTick !== null) {
      for (const line of dumpTick(parsed, opts.dumpTick)) console.log(line);
    } else if (opts.json) {
      console.log(JSON.stringify(summary, null, 2));
    } else {
      console.log(textLine(summary));
    }
  }
}

try {
  main();
} catch (err) {
  if (err instanceof FileError) {
    console.error(`ERROR ${err.message}`);
    process.exitCode = 2;
  } else {
    console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
