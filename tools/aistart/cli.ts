// cli.ts - M5d-S2 rich start: the Advanced AI fights an IDLE human on a real map (docs/M5D-SPIKE.md "S2 record").
// Battle Sun, hand 0 = a human who gives no command (idle), hand 1 = the Advanced AI with an aiStart level
// (packages/sim/aistart.ts). Every tick runs the skirmish step with no commands; the timeline records the
// first attack request, the first combat group, the first human house damaged, the kills both ways, and the
// match end (the idle human is defeated once its store, school, barracks and town hall are gone).
// Usage:
//   node tools/aistart/cli.ts --check                  the frozen fight (CHECK_TICKS, run twice); AISTART CHECK PASS/FAIL
//   node tools/aistart/cli.ts --level normal --ticks N the timeline for N ticks (default 12000, stops at match end)
//   node tools/aistart/cli.ts --level none --ticks N   the same with no rich start (the AI has no army)
// Reads the map, mission and defines from the frozen r15472 install (read-only). KAM_INSTALL overrides the root.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createSkirmish, step, skirmishStatus } from '../../packages/sim/skirmish.ts';
import type { Skirmish, SkirmishDefines, SkirmishSlot, HandStatus } from '../../packages/sim/skirmish.ts';
import { ArmyManagement } from '../../packages/sim/aiarmy.ts';
import { isAiStartLevel, AI_START_LEVELS } from '../../packages/sim/aistart.ts';
import type { AiStartLevel } from '../../packages/sim/aistart.ts';
import type { Command } from '../../packages/sim/commands.ts';
import { HT_BARRACKS, HT_STORE, UT_KNIGHT, UT_MILITIA } from '../../packages/sim/ai.ts';
import type { SimEvent } from '../../packages/sim/economy.ts';
import { CHECK_TICKS, CHECK_LEVEL, EXPECTED } from './expected.ts';

const INSTALL = process.env.KAM_INSTALL ?? 'C:/Users/me/Desktop/KaM Remake/KaM Remake Beta r15472';
const DEFINES_DIR = `${INSTALL}/data/defines`;
const MAP = 'MapsMP/Battle Sun';
const HUMAN = 0;
const AI = 1;
const DEFAULT_TICKS = 12000;
const GARRISON_GROUP = 9;
const DEFEND_EVERY = 10;
const DEFEND_RANGE = 14;

interface Options {
  check: boolean;
  level: AiStartLevel;
  ticks: number;
  garrison: number;
  defend: boolean;
  peace: number;
}

function usage(): string {
  return (
    `usage: node tools/aistart/cli.ts --check                 (${CHECK_TICKS} ticks at ${CHECK_LEVEL}, twice, AISTART CHECK PASS/FAIL)\n` +
    `       node tools/aistart/cli.ts --level <${AI_START_LEVELS.join('|')}> --ticks N [--garrison M] [--peace M]  (fight timeline, default ${DEFAULT_TICKS})\n` +
    '       --garrison M: the human gets M militia beside its store (default 0); --defend: its garrison attacks the enemy near the store\n' +
    '       --peace M: the AI peacetime in minutes (0..240, default 0); the AI neither attacks nor defends while it lasts\n' +
    'env: KAM_INSTALL (install root)'
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { check: false, level: 'normal', ticks: DEFAULT_TICKS, garrison: 0, defend: false, peace: 0 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--check') opts.check = true;
    else if (arg === '--defend') opts.defend = true;
    else if (arg === '--peace') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0 || n > 240) throw new Error(`--peace needs an integer 0..240, got "${argv[i + 1]}"`);
      opts.peace = n;
      i += 1;
    }
    else if (arg === '--level') {
      const v = argv[i + 1];
      if (!isAiStartLevel(v)) throw new Error(`--level needs ${AI_START_LEVELS.join(', ')}, got "${String(v)}"`);
      opts.level = v;
      i += 1;
    } else if (arg === '--ticks') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--ticks needs a positive integer, got "${argv[i + 1]}"`);
      opts.ticks = n;
      i += 1;
    } else if (arg === '--garrison') {
      const n = Number(argv[i + 1]);
      if (!Number.isInteger(n) || n < 0) throw new Error(`--garrison needs an integer >= 0, got "${argv[i + 1]}"`);
      opts.garrison = n;
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
  const base = `${INSTALL}/${map}/${map.slice(at + 1)}`;
  return {
    mapPath: `${base}.map`,
    mapBytes: new Uint8Array(readFileSync(`${base}.map`)),
    missionDat: new Uint8Array(readFileSync(`${base}.dat`)),
  };
}

/** A garrison for the human: militia in groups of nine, south of its store (the skirmish CLI's grant style).
 *  Returns the garrison's group uids (the scripted defence commands them). */
function garrisonHuman(sk: Skirmish, count: number): number[] {
  const groups: number[] = [];
  if (count <= 0) return groups;
  const w = sk.world;
  const store = w.findFirstHouse(HT_STORE, HUMAN);
  if (store === null) throw new Error('aistart: the human hand has no store');
  let left = count;
  for (let r = 3; r <= 10 && left > 0; r++) {
    for (let dy = -r; dy <= r && left > 0; dy += 2) {
      for (let dx = -r; dx <= r && left > 0; dx += 3) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = store.entrance.x + dx;
        const y = store.entrance.y + 3 + dy;
        if (!w.tileInMapCoords(x, y) || !w.tileWalkable(x, y) || w.houseAt(x, y) !== null || w.isRoadTile(x, y)) continue;
        const n = Math.min(GARRISON_GROUP, left);
        const g = w.spawnGroup(HUMAN, UT_MILITIA, x, y, 4, 3, n);
        if (g.memberUids.length > 0) {
          left -= n;
          groups.push(g.uid);
        }
      }
    }
  }
  if (left > 0) throw new Error(`aistart: no room for ${count} human garrison soldiers near the store`);
  return groups;
}

interface Built {
  sk: Skirmish;
  garrison: number[];
}

function build(level: AiStartLevel, garrison: number, peace: number): Built {
  const files = mapFiles(MAP);
  const slots: SkirmishSlot[] = [
    { hand: HUMAN, kind: 'human' },
    { hand: AI, kind: 'ai', aiStart: level },
  ];
  const sk = createSkirmish({ mapBytes: files.mapBytes, mapPath: files.mapPath, missionDat: files.missionDat, defines: defines(), seed: 1, slots, peaceMinutes: peace });
  return { sk, garrison: garrisonHuman(sk, garrison) };
}

/**
 * The scripted defence (optional, --defend): every DEFEND_EVERY ticks, while an enemy warrior is within
 * DEFEND_RANGE tiles of the human's store, each garrison group attacks the nearest such warrior (the
 * skirmish command groupAttackUnit). It is a simple player, not a tuned one.
 */
function defendCommands(sk: Skirmish, garrison: number[], tick: number): Command[] {
  if (garrison.length === 0 || tick % DEFEND_EVERY !== 0) return [];
  const w = sk.world;
  const store = w.findFirstHouse(HT_STORE, HUMAN);
  if (store === null) return [];
  let best: { uid: number; d: number } | null = null;
  for (const u of w.units) {
    if (u.dead || u.owner !== AI || u.type < UT_MILITIA || u.type > UT_KNIGHT) continue;
    const d = Math.abs(u.posF.x - store.entrance.x) + Math.abs(u.posF.y - store.entrance.y);
    if (d > DEFEND_RANGE) continue;
    if (best === null || d < best.d || (d === best.d && u.uid < best.uid)) best = { uid: u.uid, d };
  }
  if (best === null) return [];
  const cmds: Command[] = [];
  for (const groupUid of garrison) {
    const g = w.groupByUid(groupUid);
    if (g === null || g.memberUids.length === 0) continue;
    cmds.push({ hand: HUMAN, tick, type: 'groupAttackUnit', groupUid, targetUid: best.uid } as Command);
  }
  return cmds;
}

const KILL_RE = /^unit-killed unit#\d+ owner=(-?\d+) from=(-?\d+)$/;

export interface Timeline {
  level: AiStartLevel;
  peaceMinutes: number;
  endTick: number;
  firstRequest: number | null;
  firstCombatGroup: number | null;
  firstHumanHouseDamaged: number | null;
  firstHumanHouseLost: number | null;
  firstKillByAi: number | null;
  firstHumanLoss: number | null;
  equipped: number;
  aiBarracks: number;
  humanHousesStart: number;
  humanHousesEnd: number;
  humanWarriorsEnd: number;
  aiWarriorsEnd: number;
  killsByAi: number;
  killsByHuman: number;
  humanLosses: number;
  humanStatus: HandStatus;
  aiStatus: HandStatus;
  matchOver: boolean;
  sha256: string;
  events: number;
  elapsedMs: number;
}

function eventTotals(events: SimEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) {
    const kind = e.text.split(' ')[0];
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function humanHouses(sk: Skirmish): number {
  return sk.world.houses.filter((h) => h.owner === HUMAN && !h.destroyed).length;
}

function stateSha(sk: Skirmish): string {
  const w = sk.world;
  const canonical = JSON.stringify({
    tick: w.tickCount,
    rngState: w.rngState,
    houses: w.houses.map((h) => [h.uid, h.typeId, h.owner, h.x, h.y, h.buildState, h.buildingProgress, h.damage, h.destroyed, h.wareIn.slice(), h.wareOut.slice()]),
    units: w.units.map((u) => [u.uid, u.owner, u.type, u.posF.x, u.posF.y, u.action, u.hitPoints, u.groupUid, u.fightState, u.dead]),
    groups: w.groups.map((g) => [g.uid, g.owner, g.memberUids.slice(), g.order, g.targetUid, g.targetHouseUid]),
    status: sk.status.slice(0, w.handCount),
    houseDamage: w.houseDamageTotal,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/** The fight: the AI's rich start as set in the slot, the human idle or (defend) its garrison scripted, up to `ticks` or the match end. */
export function fight(level: AiStartLevel, ticks: number, garrison = 0, defend = false, peace = 0): { sk: Skirmish; t: Timeline } {
  const start = Date.now();
  const { sk, garrison: garrisonGroups } = build(level, garrison, peace);
  const ai = sk.ais[AI];
  const army = ai !== undefined && ai.army instanceof ArmyManagement ? ai.army : null;
  const w = sk.world;
  const hStart = humanHouses(sk);
  const t: Timeline = {
    level,
    peaceMinutes: peace,
    endTick: 0,
    firstRequest: null,
    firstCombatGroup: null,
    firstHumanHouseDamaged: null,
    firstHumanHouseLost: null,
    firstKillByAi: null,
    firstHumanLoss: null,
    equipped: 0,
    aiBarracks: w.houses.filter((h) => h.owner === AI && !h.destroyed && h.typeId === HT_BARRACKS).length,
    humanHousesStart: hStart,
    humanHousesEnd: hStart,
    humanWarriorsEnd: 0,
    aiWarriorsEnd: 0,
    killsByAi: 0,
    killsByHuman: 0,
    humanLosses: 0,
    humanStatus: 'playing',
    aiStatus: 'playing',
    matchOver: false,
    sha256: '',
    events: 0,
    elapsedMs: 0,
  };
  let prevRequest: unknown = army?.attackRequest;
  let seen = 0;
  for (let i = 0; i < ticks; i++) {
    const cmds = defend ? defendCommands(sk, garrisonGroups, sk.world.tickCount + 1) : [];
    const res = step(sk, cmds);
    const tick = res.tick;
    if (army !== null && army.attackRequest !== prevRequest) {
      if (army.attackRequest.active && t.firstRequest === null) t.firstRequest = tick;
      prevRequest = army.attackRequest;
    }
    if (army !== null && t.firstCombatGroup === null && army.attack.count > 0) t.firstCombatGroup = tick;
    if (t.firstHumanHouseDamaged === null && w.houses.some((h) => h.owner === HUMAN && !h.destroyed && h.damage > 0)) t.firstHumanHouseDamaged = tick;
    const now = humanHouses(sk);
    if (t.firstHumanHouseLost === null && now < hStart) t.firstHumanHouseLost = tick;
    t.humanHousesEnd = now;
    for (; seen < w.events.length; seen++) {
      const e: SimEvent = w.events[seen];
      const m = KILL_RE.exec(e.text);
      if (m === null) continue;
      const victim = Number(m[1]);
      const killer = Number(m[2]);
      if (killer === AI && victim !== AI) {
        t.killsByAi += 1;
        if (t.firstKillByAi === null) t.firstKillByAi = e.tick;
      }
      if (killer === HUMAN && victim !== HUMAN && victim >= 0) t.killsByHuman += 1;
      if (victim === HUMAN && killer >= 0 && killer !== HUMAN) {
        t.humanLosses += 1;
        if (t.firstHumanLoss === null) t.firstHumanLoss = e.tick;
      }
    }
    const st = skirmishStatus(sk);
    t.endTick = tick;
    if (st.matchOver) {
      t.matchOver = true;
      break;
    }
  }
  const st = skirmishStatus(sk);
  t.humanStatus = st.hands.find((h) => h.hand === HUMAN)?.status ?? 'playing';
  t.aiStatus = st.hands.find((h) => h.hand === AI)?.status ?? 'playing';
  t.equipped = w.events.filter((e) => e.text.startsWith('barracks-equipped ')).length;
  t.humanWarriorsEnd = w.handWarriorCount(HUMAN);
  t.aiWarriorsEnd = w.handWarriorCount(AI);
  t.sha256 = stateSha(sk);
  t.events = w.events.length;
  t.elapsedMs = Date.now() - start;
  return { sk, t };
}

function line(t: Timeline): string {
  const at = (v: number | null): string => (v === null ? '-' : String(v));
  return (
    `AISTART level=${t.level} endTick=${t.endTick} matchOver=${t.matchOver} human=${t.humanStatus} ai=${t.aiStatus} ` +
    `firstRequest=${at(t.firstRequest)} firstCombatGroup=${at(t.firstCombatGroup)} firstHumanHouseDamaged=${at(t.firstHumanHouseDamaged)} ` +
    `firstHumanHouseLost=${at(t.firstHumanHouseLost)} firstKillByAi=${at(t.firstKillByAi)} firstHumanLoss=${at(t.firstHumanLoss)}`
  );
}

function printTimeline(t: Timeline): void {
  console.log(line(t));
  console.log(
    `AISTART equipped=${t.equipped} killsByAi=${t.killsByAi} killsByHuman=${t.killsByHuman} humanLosses=${t.humanLosses} humanHouses=${t.humanHousesStart}->${t.humanHousesEnd} ` +
      `warriors(human)=${t.humanWarriorsEnd} warriors(ai)=${t.aiWarriorsEnd} events=${t.events}`,
  );
  console.log(`AISTART SHA256 ${t.sha256} (${t.elapsedMs} ms)`);
}

/** The frozen fields of a timeline (the sha is compared on its own). */
function frozenFields(t: Timeline): Record<string, unknown> {
  return {
    endTick: t.endTick,
    firstRequest: t.firstRequest,
    firstCombatGroup: t.firstCombatGroup,
    firstHumanHouseDamaged: t.firstHumanHouseDamaged,
    firstHumanHouseLost: t.firstHumanHouseLost,
    firstKillByAi: t.firstKillByAi,
    firstHumanLoss: t.firstHumanLoss,
    equipped: t.equipped,
    killsByAi: t.killsByAi,
    killsByHuman: t.killsByHuman,
    humanLosses: t.humanLosses,
    humanHousesEnd: t.humanHousesEnd,
    humanWarriorsEnd: t.humanWarriorsEnd,
    aiWarriorsEnd: t.aiWarriorsEnd,
    humanStatus: t.humanStatus,
    aiStatus: t.aiStatus,
    events: t.events,
  };
}

function check(): void {
  const problems: string[] = [];
  const a = fight(CHECK_LEVEL, CHECK_TICKS, 0, false, 0);
  const ta = a.t;
  console.log(`AISTART SETUP ${MAP} human idle (garrison 0) ai=${CHECK_LEVEL} ticks<=${CHECK_TICKS}`);
  console.log(`AISTART EVENTS ${Object.entries(eventTotals(a.sk.world.events)).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  printTimeline(ta);
  const tb = fight(CHECK_LEVEL, CHECK_TICKS).t;
  console.log(`AISTART SHA256 ${tb.sha256} (run 2)`);

  if (ta.sha256 !== tb.sha256) problems.push(`two runs differ: ${ta.sha256} != ${tb.sha256}`);
  if (ta.aiBarracks < 1) problems.push(`the AI has no barracks (${ta.aiBarracks})`);
  if (ta.equipped < EXPECTED.minEquipped) problems.push(`equipped ${ta.equipped} < ${EXPECTED.minEquipped}`);
  if (ta.firstRequest === null || ta.firstCombatGroup === null) problems.push('no attack request or combat group');
  if (ta.killsByAi < 1) problems.push('the AI killed no human unit');
  if (ta.firstHumanHouseDamaged === null) problems.push('no human house was damaged');
  if (ta.humanStatus !== 'defeated') problems.push(`human status ${ta.humanStatus}, expected defeated`);
  compare('timeline', frozenFields(ta), EXPECTED.timeline, problems);
  compare('sha256', ta.sha256, EXPECTED.sha256, problems);

  if (problems.length === 0) {
    console.log(
      `AISTART CHECK PASS (${ta.endTick} ticks, ${ta.events} events, human ${ta.humanStatus}, ai ${ta.aiStatus}, equipped ${ta.equipped}, ` +
        `attack ${ta.firstRequest}, killsByAi ${ta.killsByAi}, sha ${ta.sha256.slice(0, 8)}, two runs identical)`,
    );
  } else {
    console.log(`AISTART CHECK FAIL:\n  ${problems.join('\n  ')}`);
    process.exitCode = 1;
  }
}

function compare(label: string, actual: unknown, expected: unknown, problems: string[]): void {
  const x = JSON.stringify(actual);
  const y = JSON.stringify(expected);
  if (x !== y) problems.push(`${label}: ${x} != expected ${y}`);
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.check) return check();
  const r = fight(opts.level, opts.ticks, opts.garrison, opts.defend, opts.peace);
  console.log(`AISTART SETUP ${MAP} human garrison=${opts.garrison} defend=${opts.defend} ai=${opts.level} peace=${opts.peace}`);
  printTimeline(r.t);
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
