// verify.ts — pure replay-stream verifier (docs/M2-SPIKE.md 2.3, 3.3).
//
// Three independent measurements over the parsed record stream:
//  1. Seed recovery: the first nonzero `rand` inverts (tick + drawsBefore + 1) RNG steps.
//  2. K walk: re-run the deterministic draw schedule (one top draw per tick crossed, one group draw
//     per check) and count the matched prefix K before game logic (sim draws) is involved. The first
//     mismatch is reported as `firstFail` with the stored `fileRand` and our `simRand`.
//  3. Pair classification: for consecutive checks, model0 = (tick_b − tick_a) + #nonzero records in
//     (ia, ib] — the draws that need no sim involvement. step^model0(rand_a) === rand_b means the pair
//     needs no sim draw (ok); otherwise the exact draw count k comes from dlogK and `extra = k − model0`
//     is the number of sim draws between the checks (bad). k < model0 or no solution is an anomaly.
import { cmdName } from './commands.ts';
import { dlogK, powStep, seedFromCheck, step } from '../sim/rng.ts';
import type { RplFile, RplRecord } from './rpl.ts';

export interface FirstFail {
  index: number;
  tick: number;
  cmd: number;
  cmdName: string;
  hand: number;
  fileRand: number;
  simRand: number;
}

export interface VerifyReport {
  rev: string;
  count: number;
  checks: number;
  lastRecordTick: number;
  lastCheckTick: number | null;
  seed: number;
  seedAppliedBack: number;
  firstCheck: { index: number; tick: number; cmd: number; cmdName: string; hand: number; rand: number } | null;
  k: number;
  firstFail: FirstFail | null;
  pairs: { ok: number; bad: number; anomalies: number };
  extraPairs: Array<[number, number]>; // sorted by extra; bad pairs only (extra = k - model0)
}

const FAST_PATH_LIMIT = 1024; // plain-step loop below this; powStep above (garbage ticks stay bounded)

/** step^k via repeated plain-number steps for small k, BigInt modpow otherwise. */
function stepsAhead(state: number, k: number): number {
  if (k > FAST_PATH_LIMIT) return powStep(state, k);
  let out = state;
  for (let i = 0; i < k; i++) out = step(out);
  return out;
}

export function verifyRpl(f: RplFile): VerifyReport {
  const records = f.records;
  const count = records.length - 1;
  const checks: Array<{ index: number; rec: RplRecord }> = [];
  for (let i = 1; i < records.length; i++) {
    if (records[i].rand !== 0) checks.push({ index: i, rec: records[i] });
  }

  const lastRecordTick = records[records.length - 1].tick;
  const lastCheckTick = checks.length > 0 ? checks[checks.length - 1].rec.tick : null;

  // 1. seed recovery from the first check (spec 2.2): seed = invStep^(T + #nonzero(1..i-1) + 1)(rand).
  let seed = 0;
  let seedAppliedBack = 0;
  let firstCheck: VerifyReport['firstCheck'] = null;
  if (checks.length > 0) {
    const { index, rec } = checks[0];
    let nonzeroBefore = 0;
    for (let i = 1; i < index; i++) {
      if (records[i].rand !== 0) nonzeroBefore += 1;
    }
    seedAppliedBack = rec.tick + nonzeroBefore + 1;
    seed = seedFromCheck(rec.rand, rec.tick + nonzeroBefore);
    firstCheck = {
      index,
      tick: rec.tick,
      cmd: rec.cmd,
      cmdName: cmdName(rec.cmd),
      hand: rec.hand,
      rand: rec.rand,
    };
  }

  // 2. K walk (spec 3.3): stops at the first mismatch; K = matched checks so far.
  let k = 0;
  let firstFail: FirstFail | null = null;
  if (checks.length > 0) {
    let state = seed;
    let tick = 0;
    for (let i = 1; i < records.length; i++) {
      const r = records[i];
      while (tick < r.tick) {
        state = step(state); // unconditional top draw per tick
        tick += 1;
      }
      if (r.rand !== 0) {
        state = step(state); // one group draw per non-SKIP group
        if (state === r.rand) {
          k += 1;
          continue;
        }
        firstFail = {
          index: i,
          tick: r.tick,
          cmd: r.cmd,
          cmdName: cmdName(r.cmd),
          hand: r.hand,
          fileRand: r.rand,
          simRand: state,
        };
        break;
      }
    }
  }

  // 3. pair classification between consecutive checks.
  let ok = 0;
  let bad = 0;
  let anomalies = 0;
  const histogram = new Map<number, number>();
  for (let p = 0; p + 1 < checks.length; p++) {
    const a = checks[p].rec;
    const b = checks[p + 1].rec;
    // Consecutive nonzero records contribute exactly one to #nonzero(ia, ib] — b itself.
    const model0 = b.tick - a.tick + 1;
    if (stepsAhead(a.rand, model0) === b.rand) {
      ok += 1;
      continue;
    }
    const kPair = dlogK(a.rand, b.rand);
    if (kPair === null || kPair < model0) {
      anomalies += 1;
      continue;
    }
    bad += 1;
    const extra = kPair - model0;
    histogram.set(extra, (histogram.get(extra) ?? 0) + 1);
  }
  const extraPairs = [...histogram.entries()].sort((x, y) => x[0] - y[0]);

  return {
    rev: f.rev,
    count,
    checks: checks.length,
    lastRecordTick,
    lastCheckTick,
    seed,
    seedAppliedBack,
    firstCheck,
    k,
    firstFail,
    pairs: { ok, bad, anomalies },
    extraPairs,
  };
}
