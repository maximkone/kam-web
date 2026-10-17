// cli.ts — M5d-A skirmish: the playable-skirmish sim wrapper on a real map (docs/M5D-SPIKE.md §2, §4 A).
// A frozen scripted human (hand 0) plays MapsMP/Battle Sun against one Advanced AI (hand 1) through the
// command layer only (applyCommand via step), for a frozen number of ticks.
// Usage:
//   node tools/skirmish/cli.ts --check            run TICKS twice (identical sha), replay the logged
//                                                 commands onto a fresh world (same sha), negative checks,
//                                                 compare to expected.ts; SKIRMISH CHECK PASS/FAIL
//   node tools/skirmish/cli.ts --bench            1 human + 3 AI on MapsMP/Center Trees (256x256, 8 starts), BENCH_TICKS
//                                                 ticks: median and p95 ms per tick, then the hotspots
//   node tools/skirmish/cli.ts --ticks N          run N ticks on the check scenario, print the summary
//   node tools/skirmish/cli.ts --map <kind>/<name>  another map for --ticks (default MapsMP/Battle Sun)
// Reads the map, mission and defines from the frozen r15472 install (read-only). KAM_INSTALL overrides the
// install root, like the other tools.
//
// Scenario setup (not commands, the same in the live run and the replay; documented grants like aisim's):
//  - hand 0 gets a finished school beside its store (a map's SET_HOUSE would carry it);
//  - hand 0 gets one militia group of nine beside its store (a map's SET_UNIT would carry it);
//  - every AI hand gets six militia a few tiles south of its store (the garrison of the aisim attack run).
// The human's commands (humanCommands): a woodcutter plan, a road line, a corn field, a school queue,
// a formation, a walk, an attack on the nearest enemy unit, and a halt. Each is computed from the state at
// its own tick, so a command can fail (then it is logged as rejected and not replayed).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSkirmish, step, skirmishStatus, skirmishGate, humanHands } from '../../packages/sim/skirmish.ts';
import type { Skirmish, SkirmishSlot, SkirmishDefines, StepResult } from '../../packages/sim/skirmish.ts';
import { applyCommand, commandsAtTick, commandLogToJson, commandLogFromJson } from '../../packages/sim/commands.ts';
import type { Command, CommandLog, CommandResult } from '../../packages/sim/commands.ts';
import { HT_STORE, HT_SCHOOL, HT_WOODCUTTERS, UT_SERF, UT_MILITIA } from '../../packages/sim/ai.ts';
import type { EconomyWorld, SimEvent } from '../../packages/sim/economy.ts';
import { TICKS, BENCH_TICKS, EXPECTED } from './expected.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const DEFINES_DIR = `${INSTALL}/data/defines`;
const CHECK_MAP = 'MapsMP/Battle Sun';
const BENCH_MAP = 'MapsMP/Center Trees';
const HUMAN = 0;
const AI = 1;
const SCHOOL_TRAIN_TYPE = UT_SERF;
const FORMATION_ROW = 3;
const GROUP_SIZE = 9;
const ENEMY_GARRISON = 6;
const TICK_FORMATION = 50;
const TICK_WALK = 100;
const TICK_ATTACK = 400;
const TICK_HALT = 900;

interface Options {
  check: boolean;
  bench: boolean;
  ticks: number | null;
  map: string;
}

function usage(): string {
  return (
    'usage: node tools/skirmish/cli.ts --check        (' +
    `${TICKS} ticks, twice + replay + negatives, SKIRMISH CHECK PASS/FAIL)\n` +
    `       node tools/skirmish/cli.ts --bench        (1 human + 3 AI on ${BENCH_MAP}, ${BENCH_TICKS} ticks, ms per tick)\n` +
    '       node tools/skirmish/cli.ts --ticks N      (run N ticks, summary)\n' +
    '       node tools/skirmish/cli.ts --map <kind>/<name>  (default MapsMP/Battle Sun)\n' +
    'env: KAM_INSTALL (install root)'
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, bench: false, ticks: null, map: CHECK_MAP };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--bench') opts.bench = true;
    else if (arg === '--ticks') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--ticks needs a positive integer, got "${argv[i + 1]}"`);
      opts.ticks = n;
      i += 1;
    } else if (arg === '--map') {
      opts.map = argv[i + 1];
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`unknown argument "${arg}"\n${usage()}`);
    }
  }
  return opts;
}

function readDefine(name: string): Buffer {
  const path = `${DEFINES_DIR}/${name}`;
  try {
    return readFileSync(path);
  } catch (err) {
    throw new Error(`defines: ${path}: cannot read file (${err instanceof Error ? err.message : String(err)})`);
  }
}

function defines(): SkirmishDefines {
  return {
    tilesJson: readDefine('tiles.json').toString('utf8'),
    mapElem: new Uint8Array(readDefine('mapelem.dat')),
    unitDat: new Uint8Array(readDefine('unit.dat')),
    housesDat: new Uint8Array(readDefine('houses.dat')),
  };
}

function mapFiles(map: string): { mapPath: string; mapBytes: Uint8Array; missionDat: Uint8Array } {
  const at = map.indexOf('/');
  if (at <= 0) throw new Error(`--map wants <kind>/<name>, got "${map}"`);
  const base = `${INSTALL}/${map}/${map.slice(at + 1)}`;
  return {
    mapPath: `${base}.map`,
    mapBytes: new Uint8Array(readFileSync(`${base}.map`)),
    missionDat: new Uint8Array(readFileSync(`${base}.dat`)),
  };
}

/** The slots of a map: hand 0 human and every other hand in `aiHands` an AI (the check: hand 1 only). */
function slotsFor(aiHands: number[]): SkirmishSlot[] {
  return [{ hand: HUMAN, kind: 'human' }, ...aiHands.map((hand) => ({ hand, kind: 'ai' as const }))];
}

/** The scenario's own uids, made at setup time. */
interface Scenario {
  schoolUid: number;
  humanGroupUid: number;
  grants: string[];
}

/** The first walkable spot in rings around (x, y) that the predicate accepts, or null. */
function scanRing(w: EconomyWorld, x: number, y: number, rMin: number, rMax: number, ok: (sx: number, sy: number) => boolean): { x: number; y: number } | null {
  for (let r = rMin; r <= rMax; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const sx = x + dx;
        const sy = y + dy;
        if (!w.tileInMapCoords(sx, sy)) continue;
        if (ok(sx, sy)) return { x: sx, y: sy };
      }
    }
  }
  return null;
}

/** The setup grants (see the header): a school, a militia group, the enemy garrisons. */
function setupScenario(sk: Skirmish): Scenario {
  const w = sk.world;
  const grants: string[] = [];
  const store = w.findFirstHouse(HT_STORE, HUMAN);
  if (store === null) throw new Error('skirmish check: hand 0 has no store');
  const schoolSpec = w.houseSpecOf(HT_SCHOOL);
  if (schoolSpec === undefined) throw new Error('skirmish check: no school spec');
  const schoolSpot = (() => {
    for (let r = 4; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = store.x + dx;
          const y = store.y + dy;
          if (w.canPlaceHouse(HT_SCHOOL, x + schoolSpec.entranceDx, y)) return { x, y };
        }
      }
    }
    return null;
  })();
  if (schoolSpot === null) throw new Error('skirmish check: no school spot near the store of hand 0');
  const school = w.spawnHouse(HT_SCHOOL, schoolSpot.x, schoolSpot.y, HUMAN);
  w.houseCreatedFor(HUMAN, HT_SCHOOL);
  grants.push(`school#${school.uid}@(${schoolSpot.x},${schoolSpot.y})`);

  const entrance = store.entrance;
  const spot = scanRing(w, entrance.x, entrance.y + 3, 0, 5, (x, y) => w.tileWalkable(x, y) && w.houseAt(x, y) === null && !w.isRoadTile(x, y));
  if (spot === null) throw new Error('skirmish check: no group spot near the store of hand 0');
  const group = w.spawnGroup(HUMAN, UT_MILITIA, spot.x, spot.y, 4, FORMATION_ROW, GROUP_SIZE);
  grants.push(`militia group#${group.uid} x${GROUP_SIZE}@(${spot.x},${spot.y})`);

  for (const slot of sk.slots) {
    if (slot.kind !== 'ai') continue;
    const s = w.findFirstHouse(HT_STORE, slot.hand);
    if (s === null) throw new Error(`skirmish check: hand ${slot.hand} has no store`);
    const g = scanRing(w, s.entrance.x, s.entrance.y + 3, 0, 8, (x, y) => w.tileWalkable(x, y) && w.houseAt(x, y) === null && !w.isRoadTile(x, y));
    if (g === null) throw new Error(`skirmish check: no garrison spot for hand ${slot.hand}`);
    w.spawnGroup(slot.hand, UT_MILITIA, g.x, g.y, 4, 3, ENEMY_GARRISON);
    grants.push(`garrison hand${slot.hand} x${ENEMY_GARRISON}@(${g.x},${g.y})`);
  }
  return { schoolUid: school.uid, humanGroupUid: group.uid, grants };
}

/** A road line of three plannable tiles: the first ring tile around (x, y) that starts one, then a greedy walk. */
function roadLineFrom(w: EconomyWorld, x: number, y: number): { x: number; y: number }[] {
  const greedy = (sx: number, sy: number): { x: number; y: number }[] => {
    const path: { x: number; y: number }[] = [];
    let cur: { x: number; y: number } | null = null;
    for (let i = 0; i < 3; i++) {
      const from: { x: number; y: number } | null = cur;
      const cands: { x: number; y: number }[] =
        from === null
          ? [{ x: sx, y: sy }]
          : [
              { x: from.x, y: from.y + 1 },
              { x: from.x + 1, y: from.y },
              { x: from.x - 1, y: from.y },
            ];
      const next: { x: number; y: number } | undefined = cands.find(
        (p) => w.canAddFieldPlan(HUMAN, p.x, p.y, 'road') && !path.some((q) => q.x === p.x && q.y === p.y),
      );
      if (next === undefined) break;
      path.push(next);
      cur = next;
    }
    return path;
  };
  for (let r = 1; r <= 6; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const path = greedy(x + dx, y + dy);
        if (path.length === 3) return path;
      }
    }
  }
  return [];
}

/** The human's scripted commands for one tick, computed from the state at that tick (deterministic). */
function humanCommands(sk: Skirmish, scen: Scenario, tick: number): Command[] {
  const w = sk.world;
  const store = w.findFirstHouse(HT_STORE, HUMAN);
  if (store === null) return [];
  const at = (extra: object): Command => ({ hand: HUMAN, tick, ...extra }) as Command;
  switch (tick) {
    case 1: {
      const spot = scanRing(w, store.entrance.x, store.entrance.y, 3, 10, (x, y) => w.canAddHousePlan(HUMAN, HT_WOODCUTTERS, x, y));
      return spot === null ? [] : [at({ type: 'housePlan', typeId: HT_WOODCUTTERS, x: spot.x, y: spot.y })];
    }
    case 2: {
      const path = roadLineFrom(w, store.entrance.x, store.entrance.y + 2);
      return path.length === 0 ? [] : [at({ type: 'roadPlanLine', path })];
    }
    case 3: {
      const spot = scanRing(w, store.entrance.x, store.entrance.y, 4, 12, (x, y) => w.canAddFieldPlan(HUMAN, x, y, 'corn'));
      return spot === null ? [] : [at({ type: 'fieldPlan', kind: 'corn', x: spot.x, y: spot.y })];
    }
    case 4:
      return [at({ type: 'houseTrain', houseUid: scen.schoolUid, unitType: SCHOOL_TRAIN_TYPE, count: 2 })];
    case TICK_FORMATION:
      return [at({ type: 'groupFormation', groupUid: scen.humanGroupUid, unitsPerRow: FORMATION_ROW })];
    case TICK_WALK: {
      const enemy = w.findFirstHouse(HT_STORE, AI);
      if (enemy === null) return [];
      const mid = { x: Math.round((store.x + enemy.x) / 2), y: Math.round((store.y + enemy.y) / 2) };
      const spot = scanRing(w, mid.x, mid.y, 0, 12, (x, y) => w.tileWalkable(x, y));
      return spot === null ? [] : [at({ type: 'groupWalk', groupUid: scen.humanGroupUid, x: spot.x, y: spot.y, dir: 0 })];
    }
    case TICK_ATTACK: {
      const g = w.groupByUid(scen.humanGroupUid);
      const from = g !== null && g.memberUids.length > 0 ? w.unitByUid(g.memberUids[0]) : null;
      if (from === null) return [];
      let best: { uid: number; d: number } | null = null;
      for (const u of w.units) {
        if (u.dead || u.owner === HUMAN || u.owner < 0) continue;
        const d = Math.abs(u.posF.x - from.posF.x) + Math.abs(u.posF.y - from.posF.y);
        if (best === null || d < best.d || (d === best.d && u.uid < best.uid)) best = { uid: u.uid, d };
      }
      return best === null ? [] : [at({ type: 'groupAttackUnit', groupUid: scen.humanGroupUid, targetUid: best.uid })];
    }
    case TICK_HALT:
      return [at({ type: 'groupHalt', groupUid: scen.humanGroupUid })];
    default:
      return [];
  }
}

/** The check scenario: the same setup and the same commands for every run. */
function buildCheck(map: string, aiHands: number[]): { sk: Skirmish; scen: Scenario } {
  const files = mapFiles(map);
  const sk = createSkirmish({
    mapBytes: files.mapBytes,
    mapPath: files.mapPath,
    missionDat: files.missionDat,
    defines: defines(),
    seed: 1,
    slots: slotsFor(aiHands),
  });
  return { sk, scen: setupScenario(sk) };
}

function eventTotals(events: SimEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    const kind = e.text.split(' ')[0];
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** A canonical, order-stable serialization of the observable state, sha256'd. */
function stateSha(sk: Skirmish): string {
  const w = sk.world;
  const houses = w.houses.map((h) => [
    h.uid,
    h.typeId,
    h.owner,
    h.x,
    h.y,
    h.buildState,
    h.buildingProgress,
    h.buildSupplyWood,
    h.buildSupplyStone,
    h.damage,
    h.destroyed,
    h.wareIn.slice(),
    h.wareOut.slice(),
  ]);
  const units = w.units.map((u) => [u.uid, u.owner, u.type, u.posF.x, u.posF.y, u.action, u.taskKind, u.hitPoints, u.groupUid, u.fightState, u.dead, u.inside, u.homeUid]);
  const groups = w.groups.map((g) => ({
    uid: g.uid,
    owner: g.owner,
    members: g.memberUids.slice(),
    order: g.order,
    orderX: g.orderX,
    orderY: g.orderY,
    targetUid: g.targetUid,
    targetHouseUid: g.targetHouseUid,
    unitsPerRow: g.unitsPerRow,
  }));
  const projectiles = w.projectiles.map((p) => [p.uid, p.fromX, p.fromY, p.toX, p.toY, p.targetUid]);
  const plans: unknown[] = [];
  for (let h = 0; h < w.handCount; h++) {
    const cs = w.constructionState(h);
    plans.push(cs.plans.map((p) => [p.uid, p.typeId, p.x, p.y, p.status]), cs.fields.map((f) => [f.x, f.y, f.fieldType, f.status]));
  }
  const ai = sk.ais.map((a, h) => (a === undefined ? null : [h, a.predictor.workerCount, a.predictor.requiredHouses]));
  const canonical = JSON.stringify({
    tick: w.tickCount,
    rngState: w.rngState,
    houses,
    units,
    groups,
    projectiles,
    plans,
    status: sk.status.slice(0, w.handCount),
    ai,
    houseDamage: w.houseDamageTotal,
    logLength: sk.log.length,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function killsBy(events: SimEvent[], attacker: number): number {
  let n = 0;
  for (const e of events) {
    const m = /^unit-killed unit#\d+ owner=(-?\d+) from=(-?\d+)$/.exec(e.text);
    if (m !== null && Number(m[2]) === attacker && Number(m[1]) !== attacker) n += 1;
  }
  return n;
}

interface RunResult {
  sk: Skirmish;
  scen: Scenario;
  accepted: number;
  acceptedList: string[];
  rejected: string[];
  elapsedMs: number;
}

/** The live run: the scenario's human commands through step, every tick. */
function runScenario(map: string, aiHands: number[], ticks: number): RunResult {
  const { sk, scen } = buildCheck(map, aiHands);
  const rejected: string[] = [];
  const acceptedList: string[] = [];
  const start = performance.now();
  for (let t = 1; t <= ticks; t++) {
    const res: StepResult = step(sk, humanCommands(sk, scen, t));
    for (const r of res.results) {
      if (r.result.ok) acceptedList.push(`t${t} ${r.cmd.type}`);
      else rejected.push(`t${t} ${r.cmd.type}: ${r.result.reason}`);
    }
  }
  return { sk, scen, accepted: acceptedList.length, acceptedList, rejected, elapsedMs: performance.now() - start };
}

/** The replay: a fresh world (the same setup), then only the logged commands at their ticks. */
function replay(map: string, aiHands: number[], log: CommandLog, ticks: number): { sk: Skirmish; failures: string[] } {
  const { sk } = buildCheck(map, aiHands);
  const failures: string[] = [];
  for (let t = 1; t <= ticks; t++) {
    const res = step(sk, commandsAtTick(log, t));
    for (const r of res.results) if (!r.result.ok) failures.push(`t${t} ${r.cmd.type}: ${r.result.reason}`);
  }
  return { sk, failures };
}

interface CheckFinals {
  tick: number;
  accepted: number;
  rejectedCount: number;
  houses: number;
  housesDone: number;
  units: number;
  groups: number;
  kills: number;
  killed: number;
  statuses: string;
  matchOver: boolean;
  houseDamage: number;
}

function finals(sk: Skirmish, accepted: number, rejectedCount: number): CheckFinals {
  const w = sk.world;
  const st = skirmishStatus(sk);
  const humans = humanHands(sk);
  const kills = humans.reduce((s, h) => s + killsBy(w.events, h), 0);
  const killed = w.events.filter((e) => /^unit-killed unit#\d+ owner=\d+ from=\d+$/.test(e.text) && humans.includes(Number(/owner=(-?\d+)/.exec(e.text)?.[1] ?? -9))).length;
  return {
    tick: w.tickCount,
    accepted,
    rejectedCount,
    houses: w.houses.filter((h) => !h.destroyed).length,
    housesDone: w.houses.filter((h) => !h.destroyed && h.buildState === 'done').length,
    units: w.units.filter((u) => !u.dead).length,
    groups: w.groups.length,
    kills,
    killed,
    statuses: st.hands.map((h) => `${h.hand}:${h.kind}:${h.status}`).join(' '),
    matchOver: st.matchOver,
    houseDamage: w.houseDamageTotal,
  };
}

function compare(label: string, actual: unknown, expected: unknown, problems: string[]): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) problems.push(`${label}: ${a} != expected ${b}`);
}

function negatives(sk: Skirmish): { label: string; ok: boolean }[] {
  const w = sk.world;
  const store = w.findFirstHouse(HT_STORE, AI);
  const tick = w.tickCount + 1;
  const cases: { label: string; cmd: Command; gate: boolean }[] = [
    { label: 'invalid housePlan typeId 99 (hand 0)', cmd: { hand: HUMAN, tick, type: 'housePlan', typeId: 99, x: 10, y: 10 } as Command, gate: true },
    { label: 'housePlan for the AI hand 1', cmd: { hand: AI, tick, type: 'housePlan', typeId: HT_WOODCUTTERS, x: store?.entrance.x ?? 10, y: (store?.entrance.y ?? 10) - 4 } as Command, gate: true },
    { label: 'groupHalt of the AI hand 1 garrison', cmd: { hand: AI, tick, type: 'groupHalt', groupUid: w.groups.find((g) => g.owner === AI)?.uid ?? 1 } as Command, gate: true },
  ];
  const out: { label: string; ok: boolean }[] = [];
  for (const c of cases) {
    const before = stateSha(sk);
    const r: CommandResult = applyCommand(w, c.cmd, c.gate ? skirmishGate(sk) : undefined);
    const after = stateSha(sk);
    const verdict = r.ok ? 'ACCEPTED' : `rejected: ${r.reason}`;
    out.push({ label: `${c.label}: ${verdict}`, ok: !r.ok && before === after });
  }
  return out;
}

function printEvents(sk: Skirmish): void {
  console.log(`SKIRMISH EVENTS ${Object.entries(eventTotals(sk.world.events)).map(([k, v]) => `${k}=${v}`).join(' ')}`);
}

function printFinals(f: CheckFinals): void {
  console.log(
    `SKIRMISH FINAL tick=${f.tick} accepted=${f.accepted} rejected=${f.rejectedCount} houses=${f.houses} done=${f.housesDone} units=${f.units} ` +
      `groups=${f.groups} humanKills=${f.kills} humanLosses=${f.killed} houseDamage=${f.houseDamage} matchOver=${f.matchOver} status=[${f.statuses}]`,
  );
}

function check(): void {
  const problems: string[] = [];
  const aiHands = [AI];
  const a = runScenario(CHECK_MAP, aiHands, TICKS);
  const shaA = stateSha(a.sk);
  console.log(`SKIRMISH ${CHECK_MAP} ${a.sk.world.grid.mapX}x${a.sk.world.grid.mapY} slots=${a.sk.slots.map((s) => `${s.hand}:${s.kind}`).join(',')} seed=1 ticks=${TICKS}`);
  console.log(`SKIRMISH SETUP ${a.scen.grants.join('; ')}`);
  printEvents(a.sk);
  const fa = finals(a.sk, a.accepted, a.rejected.length);
  printFinals(fa);
  console.log(`SKIRMISH ACCEPTED ${a.acceptedList.join(', ')}`);
  for (const r of a.rejected) console.log(`SKIRMISH REJECTED ${r}`);
  console.log(`SKIRMISH SHA256 ${shaA} (run 1)`);

  const b = runScenario(CHECK_MAP, aiHands, TICKS);
  const shaB = stateSha(b.sk);
  console.log(`SKIRMISH SHA256 ${shaB} (run 2)`);
  compare('two runs identical sha', shaB, shaA, problems);

  const log = a.sk.log;
  const logJson = commandLogToJson(log);
  const log2 = commandLogFromJson(logJson);
  compare('command log JSON round trip', commandLogToJson(log2), logJson, problems);
  const r = replay(CHECK_MAP, aiHands, log2, TICKS);
  const shaR = stateSha(r.sk);
  console.log(`SKIRMISH REPLAY commands=${log.length} sha256=${shaR} failures=${r.failures.length}`);
  compare('replay sha', shaR, shaA, problems);
  if (r.failures.length > 0) problems.push(`replay: ${r.failures.length} logged commands failed on replay`);

  for (const n of negatives(a.sk)) {
    console.log(`SKIRMISH NEGATIVE ${n.label} -> ${n.ok ? 'no change' : 'FAILED'}`);
    if (!n.ok) problems.push(`negative: ${n.label}`);
  }
  const shaN = stateSha(a.sk);
  compare('sha unchanged after the negative commands', shaN, shaA, problems);

  compare('load', { map: CHECK_MAP, slots: a.sk.slots.map((s) => `${s.hand}:${s.kind}`) }, EXPECTED.load, problems);
  compare('events', eventTotals(a.sk.world.events), EXPECTED.events, problems);
  compare('final', { ...fa, rejectedCount: fa.rejectedCount }, EXPECTED.final, problems);
  compare('sha256', shaA, EXPECTED.sha256, problems);

  if (problems.length === 0) {
    console.log(`SKIRMISH CHECK PASS (${TICKS} ticks, ${a.sk.world.events.length} events, ${log.length} commands, ${Math.round(a.elapsedMs)} ms)`);
  } else {
    console.log(`SKIRMISH CHECK FAIL:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** The bench: the step time per tick (the real step), then a phase pass for the hotspots (same order). */
function bench(): void {
  const aiHands = [1, 2, 3];
  const map = BENCH_MAP;
  const { sk, scen } = buildCheck(map, aiHands);
  const w = sk.world;
  console.log(`SKIRMISH BENCH ${map} ${w.grid.mapX}x${w.grid.mapY} 1 human + ${aiHands.length} AI, ${BENCH_TICKS} ticks, slots=${sk.slots.map((s) => `${s.hand}:${s.kind}`).join(',')}`);
  const times: number[] = [];
  for (let t = 1; t <= BENCH_TICKS; t++) {
    const cmds = humanCommands(sk, scen, t);
    const s = performance.now();
    step(sk, cmds);
    times.push(performance.now() - s);
  }
  const sorted = times.slice().sort((x, y) => x - y);
  const median = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const max = sorted[sorted.length - 1];
  const sum = times.reduce((s, v) => s + v, 0);
  const PHASE_TICKS = Math.min(BENCH_TICKS, 1000);
  const firstSum = times.slice(0, PHASE_TICKS).reduce((s, v) => s + v, 0);
  console.log(
    `SKIRMISH BENCH step ms/tick: median ${median.toFixed(3)} p95 ${p95.toFixed(3)} max ${max.toFixed(3)} mean ${(sum / times.length).toFixed(3)} (${BENCH_TICKS} ticks, ${Math.round(sum)} ms total)`,
  );
  console.log(`SKIRMISH BENCH step first ${PHASE_TICKS} ticks: ${Math.round(firstSum)} ms total (the hotspot pass below covers these ticks)`);
  console.log(`SKIRMISH BENCH budget: 10 ticks/s at 1x = 100 ms per tick; p95 over 50 ms is a hotspot case`);

  // Phase pass: a fresh world, the same order as step(), cumulative timers per phase.
  const phase = new Map<string, number>();
  const { sk: ps, scen: pscen } = buildCheck(map, aiHands);
  const add = (name: string, ms: number): void => {
    phase.set(name, (phase.get(name) ?? 0) + ms);
  };
  for (let t = 1; t <= PHASE_TICKS; t++) {
    const tick = ps.world.tickCount + 1;
    const cmds = humanCommands(ps, pscen, t);
    let s = performance.now();
    for (const cmd of cmds) applyCommand(ps.world, cmd, skirmishGate(ps));
    add('commands', performance.now() - s);
    s = performance.now();
    ps.supervisor?.updateState(tick);
    add('supervisor', performance.now() - s);
    for (const slot of ps.slots) {
      const ai = ps.ais[slot.hand];
      if (ai === undefined) continue;
      s = performance.now();
      ai.updateState(tick);
      add(`ai hand ${slot.hand}`, performance.now() - s);
    }
    s = performance.now();
    ps.world.tick();
    add('world.tick (units, houses, combat, logistics, projectiles)', performance.now() - s);
  }
  const ranked = [...phase.entries()].sort((x, y) => y[1] - x[1]);
  for (const [name, ms] of ranked) console.log(`SKIRMISH HOTSPOT ${name}: ${ms.toFixed(0)} ms cumulative over ${PHASE_TICKS} ticks`);
}

function summary(opts: Options): void {
  const ticks = opts.ticks ?? TICKS;
  const aiHands = [AI];
  const r = runScenario(opts.map, aiHands, ticks);
  printEvents(r.sk);
  printFinals(finals(r.sk, r.accepted, r.rejected.length));
  console.log(`SKIRMISH ACCEPTED ${r.acceptedList.join(', ')}`);
  for (const x of r.rejected) console.log(`SKIRMISH REJECTED ${x}`);
  console.log(`SKIRMISH SHA256 ${stateSha(r.sk)} (${ticks} ticks, ${Math.round(r.elapsedMs)} ms)`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) return check();
  if (opts.bench) return bench();
  if (opts.ticks !== null) return summary(opts);
  console.log(usage());
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
