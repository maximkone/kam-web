// cli.ts — inspect KaM Remake .rpl replays: parser summary, seed recovery, K walk, pair
// classification (docs/M2-SPIKE.md 3.3) and the structural round-trip check.
// Usage:
//   node tools/replayinfo/cli.ts <file.rpl>... [--json] [--roundtrip]
// Exit codes: 0 = ran fine (K < checks is a measurement); 1 = bad usage / round-trip mismatch;
//             2 = unreadable or invalid file; 3 = pair anomalies > 0.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { parseRpl, writeRplFile, writeRplPayload } from '../../packages/replay/rpl.ts';
import type { RplFile } from '../../packages/replay/rpl.ts';
import { verifyRpl } from '../../packages/replay/verify.ts';
import type { VerifyReport } from '../../packages/replay/verify.ts';

const USAGE = 'usage: node tools/replayinfo/cli.ts <file.rpl>... [--json] [--roundtrip]';

class UsageError extends Error {}

interface Options {
  files: string[];
  json: boolean;
  roundtrip: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { files: [], json: false, roundtrip: false };
  for (const arg of argv) {
    if (arg === '--json') opts.json = true;
    else if (arg === '--roundtrip') opts.roundtrip = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg.startsWith('-')) {
      throw new UsageError(`unknown argument "${arg}"\n${USAGE}`);
    } else {
      opts.files.push(arg);
    }
  }
  if (opts.files.length === 0) throw new UsageError(`a .rpl file is required\n${USAGE}`);
  return opts;
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Text report, frozen shape of docs/M2-SPIKE.md 3.3. */
function printText(name: string, report: VerifyReport): void {
  console.log(
    `${name} rev=${report.rev} count=${report.count} checks=${report.checks} ` +
      `lastRecordTick=${report.lastRecordTick} lastCheckTick=${report.lastCheckTick === null ? 'null' : report.lastCheckTick}`,
  );
  console.log(`  seed=${report.seed} (back ${report.seedAppliedBack} draws)`);
  if (report.firstCheck === null) {
    console.log('  first check <none>');
  } else {
    const c = report.firstCheck;
    console.log(`  first check #${c.index} tick=${c.tick} ${c.cmdName} h=${c.hand} rand=${c.rand}`);
  }
  if (report.firstFail === null) {
    console.log(`  K=${report.k}/${report.checks} ALL`);
  } else {
    const g = report.firstFail;
    console.log(
      `  K=${report.k}/${report.checks} first fail #${g.index} tick=${g.tick} ${g.cmdName} ` +
        `h=${g.hand} file=${g.fileRand} sim=${g.simRand}`,
    );
  }
  console.log(`  pairs ok=${report.pairs.ok} bad=${report.pairs.bad} anomalies=${report.pairs.anomalies}`);
  console.log(`  extra top24: ${JSON.stringify(report.extraPairs.slice(0, 24))}`);
}

/** Inflate the payload of a .rpl container ([u16 markerLen][marker][zlib]). */
function inflateContainer(container: Uint8Array): Buffer {
  if (container.length < 2) throw new Error(`container too short (${container.length} bytes)`);
  const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
  const markerLen = view.getUint16(0, true);
  const marker = Buffer.from(container.subarray(2, 2 + markerLen)).toString('latin1');
  if (marker !== 'GIPCompressed') throw new Error(`bad marker ${JSON.stringify(marker)}`);
  return inflateSync(container.subarray(2 + markerLen));
}

function assertSameFile(a: RplFile, b: RplFile): void {
  if (a.rev !== b.rev) throw new Error(`revision differs (${a.rev} vs ${b.rev})`);
  if (a.extra !== b.extra) throw new Error(`extra differs (${a.extra} vs ${b.extra})`);
  if (a.records.length !== b.records.length) {
    throw new Error(`record count differs (${a.records.length} vs ${b.records.length})`);
  }
  for (let i = 0; i < a.records.length; i++) {
    const x = a.records[i];
    const y = b.records[i];
    const same =
      x.tick === y.tick &&
      x.rand === y.rand &&
      x.cmd === y.cmd &&
      x.hand === y.hand &&
      Buffer.compare(Buffer.from(x.data), Buffer.from(y.data)) === 0;
    if (!same) throw new Error(`record ${i} differs after re-parse`);
  }
}

/** Round-trip: parse -> write -> re-inflate both -> byte-compare payloads + re-parse field equality. */
function roundtrip(bytes: Buffer, f: RplFile): string {
  const originalPayload = inflateContainer(bytes);
  const canonical = Buffer.from(writeRplPayload(f));
  if (Buffer.compare(originalPayload, canonical) !== 0) {
    throw new Error(
      `payload mismatch: original ${originalPayload.length} bytes vs written ${canonical.length} bytes`,
    );
  }
  const written = writeRplFile(f);
  const reinflated = inflateContainer(written);
  if (Buffer.compare(originalPayload, reinflated) !== 0) {
    throw new Error('re-inflated payload differs from original payload');
  }
  assertSameFile(f, parseRpl(written));
  return createHash('sha256').update(originalPayload).digest('hex').slice(0, 16);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  let invalid = false;
  let roundtripFail = false;
  let anomalies = false;

  for (const path of opts.files) {
    let bytes: Buffer;
    let f: RplFile;
    let report: VerifyReport;
    try {
      bytes = readFileSync(path);
      f = parseRpl(bytes);
      report = verifyRpl(f);
    } catch (err) {
      console.error(`ERROR ${path}: ${reason(err)}`);
      invalid = true;
      continue;
    }

    if (opts.json) console.log(JSON.stringify({ file: basename(path), ...report }, null, 2));
    else printText(basename(path), report);
    if (report.pairs.anomalies > 0) anomalies = true;

    if (opts.roundtrip) {
      try {
        const sha = roundtrip(bytes, f);
        console.log(`ROUNDTRIP OK payloadSha=${sha} records=${f.records.length}`);
      } catch (err) {
        console.error(`ROUNDTRIP FAIL ${path}: ${reason(err)}`);
        roundtripFail = true;
      }
    }
  }

  if (invalid) process.exitCode = 2;
  else if (roundtripFail) process.exitCode = 1;
  else if (anomalies) process.exitCode = 3;
}

try {
  main();
} catch (err) {
  if (err instanceof UsageError) {
    console.error(`ERROR ${err.message}`);
    process.exitCode = 1;
  } else {
    console.error(`ERROR ${reason(err)}`);
    process.exitCode = 1;
  }
}
