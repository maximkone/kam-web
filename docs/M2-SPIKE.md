# M2 spike — replay-CRC parity harness (frozen spec)

Status: **frozen 2026-10-16** for two parallel M2 workers:
**A** = RNG port + `.rpl` codec + chain verifier CLI · **B** = `.rng` draw-trace oracle + independent synthetic-`.rpl` generator.
The lead owns this file.

## 0. Environment rules (same as M0/M1)

- Repo root: `C:\empire\games\kam-web`. `_ref\kam_remake` is read-only.
- Node 24 runs `.ts` directly: erasable syntax only (no `enum`/`namespace`/parameter properties),
  relative imports include `.ts`, zero runtime deps (node: builtins only).
- `tsconfig.json` already includes `packages/**` and `tools/**`: every new `.ts` (tests included)
  is type-checked by `npx tsc --noEmit` — keep it exit 0.
- Run tests with explicit files: `node --test packages/sim/rng.test.ts` (verified working on Node 24.14).
- **No commits.** Every claim needs a one-line proof command + its result.
- Do not break M0/M1: `node tools/import/cli.ts --install "C:\Users\me\Desktop\KaM Remake" --check`
  → `CHECK PASS`; `node tools/mapinfo/cli.ts "<Town Tutorial.map>" --check` → `MAP CHECK PASS`.
- Fixtures (read-only, never copied into the repo):
  `C:\Users\me\Desktop\KaM Remake\KaM Remake Beta r15472\SavesMP\{autosave01..05, autosave_after_pt_end}\<same-name>.rpl` (and `.rng` next to them).
- Do not touch `package.json`, `docs/**`, `apps/**`, `packages/{assets,map}/**`, or the other worker's paths.

## 1. What M2 proves

The `.rpl` command stream and the game's RNG choreography are decoded and **reproduced exactly in TS**:
from a real desktop replay (AGPL r15472 build) our code recovers the session seed backwards, re-walks
the top-draw / per-command-draw / compare schedule, and reports (a) the matched-prefix **K** of checks
that need no game logic, (b) a classification of every adjacent check pair as "no sim draw between"
(`k == model0`) or carrying an exact count of **sim draws** (M3's target). The full draw model is
ground-truthed by the `DBG_RNG_SPY` `.rng` trace of the same session (6290/6290 exact). The sim port
(M3+) shrinks the sim-draw set until K grows toward the full file.

## 2. Verified facts (lead-verified 2026-10-16; source line refs)

### 2.1 container + layout

- File = `[u16 markerLen=13]["GIPCompressed"][zlib stream]` → payload.
  Payload = `[u16 revLen=6]["r15472"][i32 count][u32 extra]` + **`(count+1)` × 22-byte records**
  `{ u32 tick; u32 rand; u8 cmd; i8 hand; u8 data[12] }`, row-major, record 0 = all-zero dummy
  (tick 0, cmd 0 = gicNone). Source: `KM_GameInputProcess.pas` `SaveToStream` 1417-1441 (`WriteA(GAME_REVISION)`,
  `Write(fCount)`, `SaveExtra`, raw `fQueue[0]` array dump `SizeOf = 22B`); `LoadFromStream` 1482-1496.
- `extra` = GIP-variant extra: base `NO_LAST_TICK_VALUE = 0` (line 506); `GIP_Single` stores
  `LastReplayTickLocal`. All 6 files: `extra = 0`.
- Length identity (verified): `payloadLen === 16 + 22*(count+1)` (autosave01: 1868366).
- **Compressed-layer byte equality with the original files is NOT achievable**: Node `zlib.deflateSync`
  at levels 1..9 gives 631306..635981 B vs the file's 614624 B (different zlib build).
  Round-trip contract = *payload bytes + parsed fields + length identity*, never compressed bytes.
- `rev` must be preserved verbatim (writer echoes the parsed string; reader accepts any `u16`-length rev).

### 2.2 RNG (exact)

- Park–Miller with **M = 2147483647**, **A = 16807**; `step(x)`: `c2 = ⌊x/127773⌋`, `c1 = x mod 127773`,
  `n = 16807*c1 − 2836*c2`, `n > 0 ? n : n + M` — exact in JS doubles.
- **`KaMRandom(MaxInt)` returns the raw post-step state; the stored `rand` IS that state** (no −1).
  Ground truth (earlier session, re-verified by re-running the final chain script): `.rng` consecutive
  logged seeds 175517/175517 exactly 1 step apart; `.rpl` nonzero rands == `.rng` StoreCommand values
  **6291/6291** in order; dlog step-count == flat trace distance **6290/6290**.
- Backwards: `invStep = ·modinv(16807, M)`; `modinv` via extended Euclid on BigInt.
- Seed recovery: first check = record index `i`, tick `T`: `seed = invStep^(T + #nonzero(1..i−1) + 1)(rand_i)`.
  All 6 files: first check `#2 t=4 rand=2135059644` → **seed 1247813158** (invert 5 draws).
  (Also confirmed in `KM_Game.pas` 2159: saves store `GetKaMSeed` for consistency.)

### 2.3 draw schema (frozen from source)

- `StoreCommand` (1531-1565): a logical command → 1+ records (`GicToStoredCommands`); **all** get
  `Rand := 0`; then the **last** record gets `KaMRandom(MaxInt)` — unless the command is in
  `SKIP_RANDOM_CHECKS_FOR`, which stores 0 instead. So: a non-SKIP group draws exactly once, and
  `rand ≠ 0` on a record ⟺ that record is its group's last. Continuation records have `rand = 0`.
- `SKIP_RANDOM_CHECKS_FOR` (line ~172) = `{ gicGameAlertBeacon 48, gicGameSpeed 50, gicGameAutoSave 51,
  gicGameAutoSaveAfterPT 52, gicGameSaveReturnLobby 53, gicGameLoadSave 54 }`.
- Replay side `ReplayTimer` (`KM_GameInputProcess_Single.pas` 37-83): **per tick one unconditional top
  draw** (line 43); per group due this tick (`fQueue[fCursor].Tick == aTick`): SKIP → `myRand := 0`
  (no draw, line 55-56); else 1 draw compared against the **last** record of the group (line 65, after
  `ParseNextStoredPackedCommand` advanced `fCursor` over the group's records). Mismatch → replay stops.
- Record-side tick order (`KM_Game.pas` `PlayGameTick` 3064-3145): `IncTick` → `TakePlannedCommands` →
  sim [`fScripting`, `gTerrain`, `gAIFields`, `gHands`, `gMySpectator`, `fPathfinding`, `gProjectiles`]
  `.UpdateState` (= game-logic draws) → `GIP.RunningTimer` (top draw first — line 449 "must go before
  commands" — then network commands stored+executed) → `DBG_AGGRESSIVE_REPLAYS` on: `CmdTemp(gicTempDoNothing)`
  → (tick 1) ware distribution from settings.
- Replay side (`PlayReplayTick` 3185-3200): same `UpdateState` chain, then `ReplayTimer`.
- **model0** (all draws with zero sim involvement): for adjacent checks at records `ia < ib`:
  `model0 = (tick_b − tick_a) + #nonzero records in (ia, ib]` (top draws of ticks `(ta, tb]` + one draw per
  group-end record). True `k = model0 + simDraws`, so **`k ≥ model0` always**; `k < model0` or `k`-dlog
  failure ⇔ model anomaly (exit 3, must stay 0 on the corpus).

### 2.4 the six r15472 replays — frozen expectations

All six: `rev=r15472`, `extra=0`, **seed 1247813158**, first check `#2 t=4 rand=2135059644`, first fail
`#16 t=10 gicTempDoNothing hand=4 fileRand=615217756 simRand=1527758834`, **K=12**.

| file | bytes | sha256[:16] | count | checks | lastRecordTick | lastCheckTick | pairs ok | pairs bad |
|---|---|---|---|---|---|---|---|---|
| autosave01.rpl | 614639 | `8761baf2b6e92f60` | 84924 | 84852 | 40803 | 40802 | 51311 | 33540 |
| autosave02.rpl | 605721 | `f53f2bee7e4e037e` | 83685 | 83614 | 40203 | 40202 | 50679 | 32934 |
| autosave03.rpl | 596014 | `db680d99b3b47832` | 82376 | 82306 | 39604 | 39603 | 49958 | 32347 |
| autosave04.rpl | 586954 | `9d1f7b82e0b0f18c` | 81130 | 81061 | 39003 | 39002 | 49266 | 31794 |
| autosave05.rpl | 577924 | `86b686b4fb028d77` | 79884 | 79816 | 38403 | 38402 | 48575 | 31240 |
| autosave_after_pt_end.rpl | 541002 | `87c97b600a1e3f95` | 74842 | 74778 | 36004 | 36003 | 45830 | 28947 |

- `pairs.ok + pairs.bad == checks − 1` and `Σ histogram counts == pairs.bad` (invariants).
- Zero-rand records (dummy excluded): autosave01..05 = 72/71/70/69/68, after_pt_end = 64;
  by cmd: `{47 (gicWareDistributions): 2, 50: 2, 51: N, 52: 1}` (the 2 cmd-47 records are the tick-4
  continuations #3/#6; `51` counts grow by 1 per autosave command — all SKIP). No mid-file `gicNone`.
- Early stream (autosave01, records #1..#18 — identical in all six):
  ```
  #  tick cmd                  hand rand
  1  4    gicGameSpeed         -1   0                    (SKIP, no draw)
  2  4    gicTempDoNothing      4   2135059644
  3  4    gicWareDistributions  4   0                    (continuation of #4)
  4  4    gicWareDistributions  4   1643178985
  5  4    gicTempDoNothing      0   269500475
  6  4    gicWareDistributions  0   0                    (continuation of #7)
  7  4    gicWareDistributions  0   451471802
  8  5    gicTempDoNothing      4   524178204
  9  5    gicTempDoNothing      0   885154634
  10 6    gicTempDoNothing      4   1548408412
  11 6    gicTempDoNothing      0   893346138
  12 8    gicTempDoNothing      4   934538962        (tick 7 has no records — top draw only)
  13 8    gicTempDoNothing      0   100940176
  14 9    gicTempDoNothing      4   1043294615
  15 9    gicTempDoNothing      0   448616550
  16 10   gicTempDoNothing      4   615217756        (first fail: 8 sim draws at tick 10)
  17 10   gicTempDoNothing      0   1978548434
  18 11   gicTempDoNothing      4   519284878
  ```
- Exact step chain between consecutive checks (k from dlog, ties to the table above; **use as test vector**):
  `(seed 1247813158) −5→ 2135059644 −1→ 1643178985 −1→ 269500475 −1→ 451471802 −2→ 524178204 −1→
  885154634 −2→ 1548408412 −1→ 893346138 −3→ 934538962 −1→ 100940176 −2→ 1043294615 −1→ 448616550
  −10→ 615217756 −1→ 1978548434 −41→ 519284878`.
- Extra-draw histogram (autosave01, `extra = k − model0` over the 33540 bad pairs), entries ≤24:
  `[[1,3245],[2,1773],[3,849],[4,740],[5,650],[6,811],[7,619],[8,827],[9,930],[10,1213],[11,1267],
  [12,1634],[13,1748],[14,1772],[15,1748],[16,1703],[17,1517],[18,1370],[19,1122],[20,970],[21,792],
  [22,616],[23,509],[24,429]]` (+ more entries above 24; full array in `--json`).
- Why K=12 and not "the model is wrong": ticks 1..9 have **zero** sim draws in this test map; the first
  sim activity lands in tick 10 (8 draws → fail #16) and tick 11 (39 draws, #17→#18 k=41). Verified
  against the tick-loop order in §2.3.

### 2.5 `.rng` DBG_RNG_SPY trace (oracle; worker B)

- `C:\Users\me\Desktop\KaM Remake\KaM Remake Beta r15472\SavesMP\autosave01\autosave01.rng` —
  `[u16 len]"RNGCompressed"[zlib]` → payload. Authoritative layout: `_ref\kam_remake\src\game\misc\KM_RandomChecks.pas`
  (`SaveToPathAsync` 427-484, header 270-288). Reverse-engineered shape (verify by parsing):
  ANSI marker `CallersTable` (u16 len + bytes), `i32` caller count, count × `{ u8 id; u16 len + ansi name }`,
  marker `KaMRandom_calls`, `i32 savedTicks`, then per tick `{ u32 tickStreamSize; u32 tick; i32 count;
  count × { i32 seed; u8 valueType; u8 callerId; value (4B int / 4B single / 10B reduced-Extended) } }`.
  Enum size 1; `seed` is the post-draw state (same semantics as `.rpl` rands).
- Frozen expectations for autosave01.rng: **175518 records**, ticks **37803..40802** (3000 ticks);
  consecutive seeds all exactly **1 step apart** (chainOk=175517, chainBad=0); `StoreCommand` draws =
  **6291**; `TKMGameInputProcess_Multi.RunningTimer` = 3000 (one per tick). Dominant sim callers:
  `TKMDeliveries.TryCalculateBidBasic` (+`2`/`3` suffixed variants), `TKMUnitActionSteer.ChooseNextStep`,
  `TKMPointList.GetRandom`, `TKMTerrain.*`, `TKMProjectiles.*`, `TKMUnitWarrior.GetAimingDelay`,
  `TKMUnitActionFight.*`.
- Same session as the replays: `.rpl` nonzero rands == `.rng` StoreCommand values 6291/6291 in order (proof B above).

## 3. Worker A — `packages/sim/rng.ts`, `packages/replay/**`, `tools/replayinfo/**`

### 3.1 `packages/sim/rng.ts` (no fs, no deps)

```ts
export const RNG_M = 2147483647;   // 2^31 - 1
export const RNG_A = 16807;
export function step(state: number): number;          // Schrage, numeric, exact; state in 1..M-1
export function invStep(state: number): number;       // A^-1 mod M (BigInt internally)
export function modInv(a: number): number;            // extended Euclid mod M (BigInt)
export function powStep(state: number, k: number): number;  // step^k, BigInt modpow internally
export function dlogK(from: number, to: number): number | null; // k with step^k(from)=to, Pohlig-Hellman mod M-1; null if none
export function seedFromCheck(value: number, drawsBefore: number): number; // invStep^(drawsBefore+1)(value)
```
- Factors of M−1 for the dlog: `2 · 3² · 7 · 11 · 31 · 151 · 331` (BSGS per prime power, CRT).
- `step` must be a plain-number Schrage (hot path); `powStep`/`modInv`/`dlogK` may use BigInt.
- Tests `packages/sim/rng.test.ts` must include: step(1)=16807, step(16807)=282475249; the full
  §2.4 step-chain vector; `invStep(step(x)) === x` and `step(invStep(x)) === x` on 1000 deterministic
  states; `dlogK(a, step^k(a)) === k` for a spread of k (1, 2, 5, 41, 6290, 100000); 
  `seedFromCheck(2135059644, 4) === 1247813158`.

### 3.2 `packages/replay/rpl.ts` + `packages/replay/commands.ts`

```ts
// commands.ts
export const CMD_NAMES: readonly string[];              // 70 entries, ordinal order, see §2.3 sources
export const SKIP_RANDOM_CHECKS_FOR: ReadonlySet<number>; // {48,50,51,52,53,54}
export function cmdName(cmd: number): string;           // name or `cmd(${n})`
// rpl.ts
export interface RplRecord { tick: number; rand: number; cmd: number; hand: number; data: Uint8Array; } // data.length === 12
export interface RplFile { rev: string; extra: number; records: RplRecord[]; } // records[0] = dummy; records.length === count+1
export function parseRpl(bytes: Uint8Array): RplFile;   // named errors: bad marker, truncated payload, bad length
export function readRplFile(path: string): RplFile;
export function writeRplFile(f: RplFile): Uint8Array;   // [u16 13]["GIPCompressed"][zlib(deflateSync level 6)] + payload
export function writeRplPayload(f: RplFile): Uint8Array; // payload only (used by tests/roundtrip)
```
- `CMD_NAMES` order from `KM_GameInputProcess.pas` enum 43-134 (gicNone=0 … gicTempDoNothing=69); 70 names.
- Round-trip is **structural**: `writeRplPayload(parseRpl(b))` must equal the original *inflated payload*
  byte-for-byte on all 6 fixtures; `parseRpl(writeRplFile(f))` field-equal to `f`; `payloadLen` identity §2.1.
- Errors: never crash on garbage (truncated zlib, wrong marker, `(count+1)*22` not matching payload) —
  throw `Error` with a short reason; CLI turns it into exit 2.

### 3.3 `packages/replay/verify.ts` + `tools/replayinfo/cli.ts`

```ts
// verify.ts (pure, no fs)
export interface FirstFail { index: number; tick: number; cmd: number; cmdName: string; hand: number; fileRand: number; simRand: number; }
export interface VerifyReport {
  rev: string; count: number; checks: number;
  lastRecordTick: number; lastCheckTick: number | null;
  seed: number; seedAppliedBack: number;
  firstCheck: { index: number; tick: number; cmd: number; cmdName: string; hand: number; rand: number } | null;
  k: number; firstFail: FirstFail | null;
  pairs: { ok: number; bad: number; anomalies: number };
  extraPairs: Array<[number, number]>;   // sorted by extra; only for bad pairs (extra = k - model0)
}
export function verifyRpl(f: RplFile): VerifyReport;
```
- Walk exactly per §2.3: state = seed recovered from the first nonzero record; for each record
  `i = 1..count`: advance `state = step(state)` once per tick crossed (`while tick < r.tick`); if
  `r.rand !== 0`: `state = step(state)` (the group draw), compare — first mismatch sets `firstFail`
  and stops the K walk at K = number of matches so far; else no draw. `k` = matched check count.
- Pairs: consecutive nonzero records `ia < ib`; `model0 = (tick_b − tick_a) + nonzeroCount(ia, ib]`;
  ok if `step^model0(rand_a) === rand_b` (fast path), else `k = dlogK(rand_a, rand_b)`; `bad++` and
  `extraPairs[extra]++` where `extra = k − model0`; if `k === null || k < model0` → `anomalies++`
  (and do **not** add to histogram).
- `tools/replayinfo/cli.ts`:
  ```
  node tools/replayinfo/cli.ts <file.rpl> [--json] [--roundtrip]
  ```
  - text (default): one line per file, exactly this shape (numbers per §2.4):
    ```
    autosave01.rpl rev=r15472 count=84924 checks=84852 lastRecordTick=40803 lastCheckTick=40802
      seed=1247813158 (back 5 draws)
      first check #2 tick=4 gicTempDoNothing h=4 rand=2135059644
      K=12/84852 first fail #16 tick=10 gicTempDoNothing h=4 file=615217756 sim=1527758834
      pairs ok=51311 bad=33540 anomalies=0
      extra top24: [[1,3245],[2,1773],...,[24,429]]
    ```
    (`extra top24` = the first ≤24 entries of `extraPairs`, same `JSON.stringify` slice as above; on a
    clean file: `K=<checks>/<checks> ALL` and no first-fail line, `extra top24: []`.)
  - `--json`: `JSON.stringify(report, null, 2)` with keys exactly as `VerifyReport` (plus `"file": basename`).
  - `--roundtrip`: additionally parse → write → re-inflate both → byte-compare payloads + re-parse
    field equality; prints `ROUNDTRIP OK payloadSha=<sha256[:16]> records=<count+1>` (exit 1 on mismatch).
  - Exit codes: 0 = ran fine (K < checks is a measurement, not an error); 2 = unreadable/invalid file;
    3 = `anomalies > 0`; 1 = bad usage.
  - Must handle multiple files in one invocation (loop). One file < 180 s on this machine.

## 4. Worker B — `tools/rnginfo/**` (oracle) + `tools/synth/**` (independent generator)

### 4.1 `tools/rnginfo/cli.ts`

```
node tools/rnginfo/cli.ts <file.rng> [--json] [--top N]
```
- Parse the `.rng` container + caller table + per-tick records exactly enough to flatten
  `{ tick, seq, seed, caller }` for every record; independent code (may share nothing with A).
- Chain check: for consecutive records in file order, `step^{?}` — a record's `seed` must equal
  `step(previousSeed)` (exactly 1 step; count `chainOk`/`chainBad`); also report first/last tick and
  `firstSeed`/`lastSeed`.
- Text line (frozen shape): `RNGINFO <name> records=175518 ticks=37803..40802 chainOk=175517 chainBad=0 callers=<n> storeCommand=6291 runtimer=3000 top=<caller:count,...>`
  (`--top` controls the buyer list length, default 5). `--json`: all of it + full `callerHistogram`
  (name → count) + `ticks` array of `{ tick, count }`.
- Acceptance: `node tools/rnginfo/cli.ts "<SavesMP>\autosave01\autosave01.rng"` → `records=175518 ticks=37803..40802 chainOk=175517 chainBad=0 storeCommand=6291 runtimer=3000` (§2.5). Loop the other 5 `.rng`s and report their numbers too (no hard expectation — report actual).
- The tool is the M3 sim-draw oracle: keep a `--dump <tick>` mode printing each record
  (`seq seed valueType caller`) for one tick (used later to diff sim draws).

### 4.2 `tools/synth/cli.ts` — independent synthetic `.rpl` generator

```
node tools/synth/cli.ts --out <dir> [--records N] [--seed S]
```
- **Independent oracle rule**: implement its own Park–Miller `step` via BigInt only (deliberately a
  different code path from A's Schrage doubles) and its own container writer (zlib). Import nothing
  from `packages/**`.
- Writes (`--records 1000 --seed 777001` defaults, deterministic):
  - `exact.rpl` + `exact.expect.json`: `--records` non-SKIP groups, one record per group except the
    dummy; ticks 1..: groups assigned with a deterministic LCG, **some ticks empty** (e.g. skip every
    97th tick) to exercise top-draw-only advancement; every check `= step(state)` per the §2.3 model.
    Expected report: `checks = count`, `k = checks`, `firstFail = null`, `pairs.bad = 0`, `anomalies = 0`,
    `extraPairs = []`, `seed` = `S`, empty-tick behavior proven by `lastRecordTick > checks`-style spread.
  - `corrupt.rpl` + `corrupt.expect.json`: exact, then record **index 777**'s rand := `(orig + 1) MOD M`;
    expected `k = 776`, `firstFail.index = 777`, `firstFail.fileRand` = injected value,
    `firstFail.simRand` = the true chain value, `seed` unchanged (first check untouched).
  - `multirec.rpl` + `multirec.expect.json`: groups stored as 1-3 records (continuations `rand=0`) plus
    SKIP commands (`cmd 51 gicGameAutoSave`, `cmd 50 gicGameSpeed`, `rand=0`, single record) interleaved;
    model0-exact by construction; expected `k = checks` (only nonzero records count), `bad = 0`.
  - Expect files use **exactly** the `--json` key set of §3.3 (`file` = basename) so `diff`-style
    comparison is trivial for the lead.
- Container written per §2.1 (`rev "r15472"`, `extra 0`); marker `"GIPCompressed"` u16-prefixed.
- Acceptance (the cross-check): after A's CLI exists, in one command chain produce the three files and verify:
  `node tools/replayinfo/cli.ts out/synth/<f>.rpl --json` matches `out/synth/<f>.expect.json` on every
  frozen key (report the actual compare command + result). `out/` is gitignored — never commit outputs.

## 5. Acceptance proofs (must appear in the worker reports as one-liners)

1. **A**: `node --test packages/sim/rng.test.ts packages/replay/rpl.test.ts` → all pass;
   `npx tsc --noEmit` exit 0;
   `node tools/replayinfo/cli.ts <autosave01.rpl>` → the §2.4 numbers for that file;
   the same for all 6 files (report the `K=/pairs` line of each; must equal §2.4);
   `node tools/replayinfo/cli.ts <autosave01.rpl> --roundtrip` → `ROUNDTRIP OK …` for all 6;
   M0/M1 regressions still pass (`CHECK PASS`, `MAP CHECK PASS`).
2. **B**: `node tools/rnginfo/cli.ts <autosave01.rng> [--json]` → the §2.5 line (report all 6);
   `node tools/synth/cli.ts --out out/synth` → writes 6 files, exit 0;
   the three `replayinfo` comparisons vs `expect.json` (all equal) — or, until A lands, run B's own
   independent reader over the generated files and report `SELFCHECK OK` + the generator's internal assertions.
3. **Lead**: re-runs everything on the corpus, diffs `--json` against §2.4, checks `tsc` + regressions,
   commits by path.

## 6. Non-goals for M2

Sim internals (units/houses/deliveries/pathfinding), browser/viewer integration, MP/lockstep,
`.rng`↔sim parity (that is M3's use of 4.1), editing/re-encoding replays for the game (writer is for
tests only — never produce files meant to be replayed by the original game), pre-r15472 `.rpl`
variants, `--experimental` compression tricks, compressed-layer byte equality.

## 7. Lead acceptance record (2026-10-16)

Workers: **A** (`packages/sim/rng.ts`, `packages/replay/**`, `tools/replayinfo/**`) and **B**
(`tools/rnginfo/**`, `tools/synth/**`). The lead re-ran every worker proof; the independent integration
verifier (`%TEMP%\opencode\kamweb_m2_verify.mjs`, all results in `%TEMP%\opencode\m2-verify-out.txt`):

- **`M2 INTEGRATION PASS (97 checks)`**
- All six replays: sha16, seed 1247813158, count/checks/lastRecordTick/lastCheckTick, K=12, first fail
  `#16 t=10 gicTempDoNothing h=4 file=615217756 sim=1527758834` == §2.4; invariants `ok+bad == checks−1`,
  `ΣextraPairs == bad`, `anomalies = 0`; autosave01 `extra top24` == §2.4.
- `--roundtrip` all six: written payload == the lead's own `inflate(original)` byte-for-byte
  (payload sha recomputed independently by the lead); record-count identity holds; ~1 s per file.
- `node --test packages/sim/rng.test.ts packages/replay/rpl.test.ts` → 16/16 pass; `npx tsc --noEmit` exit 0.
- B: `rnginfo` reproduces §2.5 exactly on `autosave01.rng`; all six `.rng` files parse with `chainBad=0`
  (one-step links 147653 / 121435 / 116527 / 106807 / 101105 on autosave02..05, after_pt_end).
- Adversarial cross-check: B's independently generated fixtures (`exact`, `corrupt`, `multirec`) driven
  through A's `replayinfo --json` — key sets and every value equal to B's `expect.json`
  (incl. `corrupt`: k=776, firstFail.index=777). Two independent RNG + BSGS implementations agree.
- **Lead correction to §2.4 found by this verification**: `autosave_after_pt_end.rpl` ends with *two*
  trailing SKIP records (`#74841 cmd=50`, `#74842 cmd=52`, both tick 36004) → `lastRecordTick=36004`,
  `lastCheckTick=36003` (the table above is patched; worker A's tool was right, the lead's draft
  expectation was wrong — the lead's facts-extractor had an off-by-one read offset).
- Regressions re-run by the lead: `CHECK PASS` (M0 converter), `MAP CHECK PASS` (M1) — both exit 0.
