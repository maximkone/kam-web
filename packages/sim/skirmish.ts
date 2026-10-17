// skirmish.ts — M5d-A skirmish wrapper (docs/M5D-SPIKE.md §2): the economy world built from a map and
// its mission the way tools/aisim does it, one hand per slot (human or Advanced AI), the one fixed tick
// of a skirmish, and the victory/defeat rule of the Remake.
//
// The fixed tick (step), in this order:
//   1. commands for this tick (each must carry tick = the tick being run; human hands only;
//      a defeated human hand takes no command). Accepted commands go to the log.
//   2. the Supervisor (gAIFields.UpdateState), then each playing AI hand (gHands.UpdateState's AI part):
//      the same order as tools/aisim (KM_Game.pas 3101–3114).
//   3. world.tick(): terrain, then per hand groups → units → houses → FOW → logistics, then the
//      projectiles (combat and projectiles run inside the economy tick; the sim fuses them).
//   4. the victory check (CheckGoals, KM_AI.pas 180–269) for the one hand whose cadence falls on this tick.
// Deviation (recorded): the spec lists "sim tick, AI, combat" as separate steps; the existing sim runs
// combat inside world.tick(), and the AI must run before it (the order the aisim check verified).
//
// Victory / defeat (port of the Remake, read-only reference _ref/kam_remake/src):
//  - Each hand has a set of goals. Script goals (`!ADD_GOAL` = victory, `!ADD_LOST_GOAL` = survive,
//    KM_MissionScript_Standard.pas 728–757) win; a hand with no script goal gets the default goals
//    (KM_AI.pas 158–171 → KM_AIGoals.pas 189–205): survive = its own buildings (or troops in a
//    tactic/fighting mission), victory = the same condition on every enemy (alliance atEnemy).
//  - Condition (KM_AI.pas 196–213): gcBuildings = store/school/barracks/town hall > 0; gcTroops =
//    warriors > 0; gcMilitaryAssets = troops or a military house > 0; gcSerfsAndSchools = a school or a
//    serf > 0; gcEconomyBuildings = store/school/inn > 0. A victory goal is satisfied when its condition
//    is FALSE (gsFalse), a survive goal when it is TRUE.
//  - CheckGoals per hand (KM_AI.pas 229–268): a hand defeated when a survive goal fails; otherwise
//    won when it has victory goals and each is satisfied (an enemy already defeated counts as
//    satisfied, KM_AI.pas 237). Defeat overrides victory. Checked when (tick + hand) mod 27 = 0
//    (KM_AI.pas 559; MAX_HANDS = 27). Once defeated or won the status never changes (KM_AI.pas 127,
//    146, 554).
//  - matchOver: a human hand has won or lost (the single-player end: KM_Game.pas PlayerDefeat/RequestHold).
// Approximations (recorded): the house and unit counters are the live sim's (a house counts once it
// is 'done' and not destroyed; a unit counts while not dead) instead of the Remake's Initial/Built/Lost
// counters; the CheckGoals run is after world.tick() (the Remake runs it at the end of the hand's update).
//
// Hands without a slot are closed: their mission content (houses, units, streets, wares) is not loaded,
// so the Supervisor and the enemy list never see them. Team numbers are stored only: the sim's alliance
// rule is per hand (economy.ts allianceOf), so two hands with the same team are rejected.
//
// Browser-safe: no node: imports. Map bytes go through the Node Buffer of map.ts (see asBuffer): the
// browser needs a Uint8Array map entry first (apps/web/mapread.ts is the browser's copy of the reader).
import { parseMapFileBytes } from '../map/map.ts';
import type { KaMap } from '../map/map.ts';
import { parseTilesJson } from '../assets/tiledata.ts';
import { parseMapElem } from '../assets/mapelem.ts';
import { parseUnitDat, parseSerfCarry } from '../assets/unitdat.ts';
import { parseHousesDat } from '../assets/housedata.ts';
import { decodeMissionScript, parseMissionScript, parseMissionInfo, tokenizeMissionScript, MAX_HANDS } from '../mission/mission.ts';
import type { Mission, MissionInfo } from '../mission/mission.ts';
import { createEconomyWorld } from './economy.ts';
import { refreshFog } from './fowrefresh.ts';
import type { EconHouse, EconomyWorld } from './economy.ts';
import {
  AiPlayer,
  Eye,
  Influences,
  UT_SERF,
  UT_BUILDER,
  HT_STORE,
  HT_SCHOOL,
  HT_BARRACKS,
  HT_TOWN_HALL,
  HT_INN,
  HT_COAL_MINE,
  HT_IRON_MINE,
  HT_IRON_SMITHY,
  HT_WEAPON_SMITHY,
  HT_ARMOR_SMITHY,
  HT_WEAPON_WORKSHOP,
  HT_ARMOR_WORKSHOP,
  HT_STABLES,
  HT_SIEGE_WORKSHOP,
  applyMissionHouseUnlocks,
  defaultAiSetup,
  parseAiSetups,
  placeFirstStorehouse,
} from './ai.ts';
import type { AiSetup } from './ai.ts';
import { ArmyManagement } from './aiarmy.ts';
import { AiSupervisor } from './aisupervisor.ts';
import { applyCommand } from './commands.ts';
import type { Command, CommandLog, CommandResult } from './commands.ts';

export type SlotKind = 'human' | 'ai';
export type AiLevel = 'advanced' | 'classic';
export type HandStatus = 'playing' | 'defeated' | 'won';

export interface SkirmishSlot {
  hand: number;
  kind: SlotKind;
  aiLevel?: AiLevel;
  team?: number;
  color?: number;
}

/** The unit/house/terrain data files of the install (read by the caller; no file access here). */
export interface SkirmishDefines {
  tilesJson: string;
  mapElem: Uint8Array;
  unitDat: Uint8Array;
  housesDat: Uint8Array;
}

export interface CreateSkirmishOptions {
  mapBytes: Uint8Array;
  mapPath?: string;
  missionDat?: Uint8Array;
  defines: SkirmishDefines;
  seed: number;
  slots: SkirmishSlot[];
}

/** A goal of one hand: `hand` is the goal's target hand (HandIndex, KM_AIGoals.pas). */
export interface GoalRef {
  victory: boolean;
  condition: number;
  hand: number;
}

export interface Skirmish {
  readonly world: EconomyWorld;
  readonly slots: NormalizedSlot[];
  readonly status: HandStatus[]; // by hand; only slot hands are meaningful
  readonly goals: HandGoals[]; // by hand; only slot hands are meaningful
  readonly ais: (AiPlayer | undefined)[]; // by hand
  readonly supervisor: AiSupervisor | null;
  readonly log: CommandLog;
  readonly missionMode: 'building' | 'fighting';
}

export interface NormalizedSlot {
  hand: number;
  kind: SlotKind;
  aiLevel: AiLevel;
  team: number;
  color: number;
}

export interface HandGoals {
  survival: GoalRef[];
  victory: GoalRef[];
}

export interface StepResult {
  tick: number;
  results: { cmd: Command; result: CommandResult }[];
}

export interface SkirmishStatus {
  tick: number;
  hands: { hand: number; kind: SlotKind; status: HandStatus }[];
  matchOver: boolean;
}

// KM_MapTypes.pas 21–38: the goal conditions (the same numbers as the KaM script).
export const GC_BUILD_TUTORIAL = 1;
export const GC_TIME = 2;
export const GC_BUILDINGS = 3;
export const GC_TROOPS = 4;
export const GC_MILITARY_ASSETS = 6;
export const GC_SERFS_AND_SCHOOLS = 7;
export const GC_ECONOMY_BUILDINGS = 8;
/** GOALS_SUPPORTED (KM_MapTypes.pas 55–56). */
const GOALS_SUPPORTED = [GC_BUILDINGS, GC_TROOPS, GC_MILITARY_ASSETS, GC_SERFS_AND_SCHOOLS, GC_ECONOMY_BUILDINGS];
/** GOAL_BUILDINGS_HOUSES (KM_MapTypes.pas 52). */
const GOAL_BUILDINGS_HOUSES = [HT_STORE, HT_SCHOOL, HT_BARRACKS, HT_TOWN_HALL];
const GOAL_MILITARY_HOUSES = [
  HT_BARRACKS,
  HT_COAL_MINE,
  HT_WEAPON_WORKSHOP,
  HT_ARMOR_WORKSHOP,
  HT_STABLES,
  HT_IRON_MINE,
  HT_IRON_SMITHY,
  HT_WEAPON_SMITHY,
  HT_ARMOR_SMITHY,
  HT_TOWN_HALL,
  HT_SIEGE_WORKSHOP,
];
const GOAL_ECONOMY_HOUSES = [HT_STORE, HT_SCHOOL, HT_INN];
/** CheckGoals runs for hand h when (tick + h) mod MAX_HANDS = 0 (KM_AI.pas 559). */
const CHECK_CADENCE = MAX_HANDS;

/** The RMG "Medium" starting kit (KM_RandomMapGenerator.pas 582–594), as tools/aisim grants it. */
const KIT_WARES: [number, number][] = [
  [1, 100], // stone
  [2, 70], // timber
  [7, 80], // gold
  [8, 70], // wine
  [10, 50], // bread
  [13, 30], // sausage
  [27, 40], // fish
];
const KIT_SERFS = 5;
const KIT_BUILDERS = 4;

export interface ScriptGoal {
  hand: number;
  victory: boolean;
  condition: number;
  target: number;
}

/**
 * The goals of the mission script (`!ADD_GOAL` / `!ADD_LOST_GOAL`, KM_MissionScript_Standard.pas
 * 728–757), keyed by the current hand (`!SET_CURR_PLAYER`). The Remake reports a deprecated condition
 * or a message on ADD_GOAL and does not add the goal; the same goals are skipped here.
 */
export function parseScriptGoals(bytes: Uint8Array): ScriptGoal[] {
  const commands = tokenizeMissionScript(decodeMissionScript(bytes));
  const out: ScriptGoal[] = [];
  let hand = -1;
  for (const { cmd, params: p } of commands) {
    switch (cmd) {
      case '!SET_CURR_PLAYER':
        hand = p[0] >= 0 && p[0] < MAX_HANDS ? p[0] : -1;
        break;
      case '!ADD_GOAL':
        if (hand < 0 || !GOALS_SUPPORTED.includes(p[0]) || p[2] !== 0) break;
        if (p[3] >= 0 && p[3] < MAX_HANDS) out.push({ hand, victory: true, condition: p[0], target: p[3] });
        break;
      case '!ADD_LOST_GOAL':
        if (hand < 0 || !GOALS_SUPPORTED.includes(p[0])) break;
        if (p[3] >= 0 && p[3] < MAX_HANDS) out.push({ hand, victory: false, condition: p[0], target: p[3] });
        break;
      default:
        break;
    }
  }
  return out;
}

function houseQty(w: EconomyWorld, hand: number, types: number[]): number {
  let n = 0;
  for (const h of w.houses) {
    if (h.owner === hand && !h.destroyed && h.buildState === 'done' && types.includes(h.typeId)) n += 1;
  }
  return n;
}

function serfQty(w: EconomyWorld, hand: number): number {
  let n = 0;
  for (const u of w.units) if (u.owner === hand && !u.dead && u.type === UT_SERF) n += 1;
  return n;
}

/** The condition of a goal for one hand (KM_AI.pas 196–210, without the final reversal). */
function conditionHolds(w: EconomyWorld, condition: number, hand: number): boolean {
  switch (condition) {
    case GC_BUILD_TUTORIAL:
    case GC_TIME:
      return true; // KM_AI.pas 197–200: deprecated, always True
    case GC_BUILDINGS:
      return houseQty(w, hand, GOAL_BUILDINGS_HOUSES) > 0;
    case GC_TROOPS:
      return w.handWarriorCount(hand) > 0;
    case GC_MILITARY_ASSETS:
      return w.handWarriorCount(hand) > 0 || houseQty(w, hand, GOAL_MILITARY_HOUSES) > 0;
    case GC_SERFS_AND_SCHOOLS:
      return houseQty(w, hand, [HT_SCHOOL]) > 0 || serfQty(w, hand) > 0;
    case GC_ECONOMY_BUILDINGS:
      return houseQty(w, hand, GOAL_ECONOMY_HOUSES) > 0;
    default:
      throw new Error(`skirmish: unknown goal condition ${condition}`);
  }
}

/** One goal as the Remake reads it: a victory goal needs the condition FALSE (gsFalse), a survive goal TRUE. */
function goalMet(w: EconomyWorld, g: GoalRef): boolean {
  const holds = conditionHolds(w, g.condition, g.hand);
  return g.victory ? !holds : holds;
}

/**
 * CheckGoals for the one hand whose cadence falls on `tick` (KM_AI.pas 559–560): defeat when a survive
 * goal is not met; otherwise victory when there are victory goals and each is met (an enemy that has
 * lost counts as met, KM_AI.pas 237). The status changes in place and never changes again.
 */
export function checkGoalsForTick(w: EconomyWorld, sk: Pick<Skirmish, 'status' | 'goals' | 'slots'>, tick: number): void {
  for (const slot of sk.slots) {
    const hand = slot.hand;
    if (sk.status[hand] !== 'playing') continue;
    if ((tick + hand) % CHECK_CADENCE !== 0) continue;
    const g = sk.goals[hand];
    const survived = g.survival.every((s) => goalMet(w, s));
    const victoryOk = g.victory.every((v) => sk.status[v.hand] === 'defeated' || goalMet(w, v));
    if (!survived) sk.status[hand] = 'defeated';
    else if (g.victory.length > 0 && victoryOk) sk.status[hand] = 'won';
  }
}

/** Check the slot list against the map's hand count and normalize it (sorted by hand). Throws a named error. */
export function normalizeSlots(slots: SkirmishSlot[], handCount: number): NormalizedSlot[] {
  if (!Array.isArray(slots) || slots.length === 0) throw new Error('skirmish: slots must list at least one hand');
  const seen = new Set<number>();
  const teams = new Map<number, number>();
  const out: NormalizedSlot[] = [];
  for (const s of slots) {
    if (!Number.isInteger(s.hand) || s.hand < 0 || s.hand >= handCount) {
      throw new Error(`skirmish: slot hand ${s.hand} is outside the map's hands 0..${handCount - 1}`);
    }
    if (seen.has(s.hand)) throw new Error(`skirmish: hand ${s.hand} has two slots`);
    seen.add(s.hand);
    if (s.kind !== 'human' && s.kind !== 'ai') throw new Error(`skirmish: slot kind must be human or ai, got ${String(s.kind)}`);
    const aiLevel = s.aiLevel ?? 'advanced';
    if (aiLevel !== 'advanced') throw new Error('skirmish: the classic AI is not ported in v0; use advanced');
    const team = s.team ?? s.hand;
    if (teams.has(team)) {
      throw new Error(`skirmish: hands ${teams.get(team)} and ${s.hand} share team ${team}; v0 alliances are per hand`);
    }
    teams.set(team, s.hand);
    out.push({ hand: s.hand, kind: s.kind, aiLevel, team, color: s.color ?? s.hand });
  }
  if (!out.some((s) => s.kind === 'human')) throw new Error('skirmish: at least one human slot is needed');
  return out.sort((a, b) => a.hand - b.hand);
}

function emptyMission(maxPlayers: number): Mission {
  return { mapName: '', maxPlayers, humanPlayer: 0, houses: [], streets: [], units: [], wares: [] };
}

function emptyInfo(): MissionInfo {
  return {
    maxPlayers: 0,
    humanPlayer: 0,
    canBeHuman: new Array<boolean>(MAX_HANDS).fill(false),
    classicAI: new Array<boolean>(MAX_HANDS).fill(false),
    advancedAI: new Array<boolean>(MAX_HANDS).fill(false),
    aiStart: Array.from({ length: MAX_HANDS }, () => ({ x: 1, y: 1 })),
    tactic: false,
  };
}

/** The first store of a hand (the start house of the mission, or the AI's first storehouse). */
function firstStoreOf(w: EconomyWorld, hand: number): EconHouse | null {
  return w.findFirstHouse(HT_STORE, hand);
}

/** The hand count createEconomyWorld derives from a mission (SET_MAX_PLAYER and the owners). */
function missionHandCount(m: Mission): number {
  let n = Math.max(1, m.maxPlayers);
  for (const h of m.houses) n = Math.max(n, h.owner + 1);
  for (const u of m.units) if (u.owner >= 0) n = Math.max(n, u.owner + 1);
  return n;
}

/** Map a mission filter: closed hands' content is dropped (see the header). */
function keepOpenContent(mission: Mission, open: Set<number>): Mission {
  return {
    ...mission,
    houses: mission.houses.filter((h) => open.has(h.owner)),
    streets: mission.streets.filter((s) => open.has(s.owner)),
    units: mission.units.filter((u) => u.owner === -1 || open.has(u.owner)),
    wares: mission.wares.filter((w) => open.has(w.owner)),
  };
}

/**
 * Build a skirmish: the economy world from the map and mission (tools/aisim's bootstrap for every
 * open hand), the start of each hand (store, kit, serfs and builders), one AiPlayer per AI slot with
 * its army and the Supervisor. Throws on a bad slot list or a map that does not parse.
 */
export function createSkirmish(opts: CreateSkirmishOptions): Skirmish {
  if (!Number.isInteger(opts.seed) || opts.seed < 0) throw new Error('skirmish: seed must be a non-negative integer');
  const mapPath = opts.mapPath ?? 'skirmish.map';
  const map: KaMap = parseMapFileBytes(opts.mapBytes, mapPath).map;
  const tiles = parseTilesJson(opts.defines.tilesJson);
  const elems = parseMapElem(opts.defines.mapElem);
  const unitSpecs = parseUnitDat(opts.defines.unitDat);
  const serfCarry = parseSerfCarry(opts.defines.unitDat);
  const houseSpecs = parseHousesDat(opts.defines.housesDat);

  const fullMission = opts.missionDat !== undefined ? parseMissionScript(opts.missionDat, map.mapX, map.mapY) : null;
  const info = opts.missionDat !== undefined ? parseMissionInfo(opts.missionDat, map.mapX, map.mapY) : emptyInfo();
  const scriptGoals = opts.missionDat !== undefined ? parseScriptGoals(opts.missionDat) : [];
  const setups: AiSetup[] = opts.missionDat !== undefined
    ? parseAiSetups(opts.missionDat, info, map.mapX, map.mapY)
    : Array.from({ length: MAX_HANDS }, (_, h) => defaultAiSetup(h));

  const fullHands = fullMission !== null ? missionHandCount(fullMission) : 0;
  const slots = normalizeSlots(opts.slots, Math.max(fullHands, ...opts.slots.map((s) => s.hand + 1)));
  const open = new Set(slots.map((s) => s.hand));
  const baseMission = fullMission ?? emptyMission(Math.max(...slots.map((s) => s.hand + 1)));
  const mission = keepOpenContent(baseMission, open);

  const world = createEconomyWorld({ map, tiles, elems, unitSpecs, serfCarry, houseSpecs, mission });
  for (const s of slots) {
    if (s.hand >= world.handCount) throw new Error(`skirmish: hand ${s.hand} beyond the world's ${world.handCount} hands`);
  }
  for (let i = 0; i < opts.seed % 65536; i++) world.draw(); // the world's RNG has no seed input (see the header)

  const influences = new Influences(world);
  influences.initAvoidBuilding();
  const eye = new Eye(world, influences);
  eye.afterMissionInit();

  const ais: (AiPlayer | undefined)[] = Array.from({ length: world.handCount }, () => undefined);
  for (const s of slots) {
    if (firstStoreOf(world, s.hand) !== null) continue;
    const setup = setups[s.hand];
    const seedPoint = setup.centerScreen.x !== 0 ? setup.centerScreen : setup.startPosition;
    if (placeFirstStorehouse(world, eye, s.hand, seedPoint) === 0) {
      throw new Error(`skirmish: hand ${s.hand} has no store and placeFirstStorehouse found no spot near ${seedPoint.x},${seedPoint.y}`);
    }
  }
  for (const s of slots) if (s.kind === 'ai') influences.updateOwnership(s.hand);
  for (const s of slots) {
    applyMissionHouseUnlocks(world, s.hand);
    if (mission.wares.every((w) => w.owner !== s.hand)) {
      for (const [ware, amount] of KIT_WARES) world.addWareToStore(s.hand, ware, amount);
    }
    if (world.handUnitCount(s.hand, UT_SERF) === 0) {
      const store = firstStoreOf(world, s.hand);
      if (store === null) throw new Error(`skirmish: hand ${s.hand} has no store after the bootstrap`);
      const below = { x: store.entrance.x, y: store.entrance.y + 1 };
      for (let i = 0; i < KIT_SERFS; i++) world.spawnCitizen(s.hand, UT_SERF, below.x, below.y, 6);
      for (let i = 0; i < KIT_BUILDERS; i++) {
        const u = world.spawnCitizen(s.hand, UT_BUILDER, below.x, below.y, 6);
        world.registerBuilder(s.hand, u.uid);
      }
    }
  }

  const aiList: AiPlayer[] = [];
  for (const s of slots) {
    if (s.kind !== 'ai') continue;
    const setup: AiSetup = { ...setups[s.hand], hand: s.hand, newAI: true };
    const ai = new AiPlayer(world, influences, eye, setup);
    ai.attachArmy(new ArmyManagement(world, ai));
    ais[s.hand] = ai;
    aiList.push(ai);
  }
  let supervisor: AiSupervisor | null = null;
  if (aiList.length > 0) {
    supervisor = new AiSupervisor(world, eye, influences, aiList);
    supervisor.afterMissionInit();
    for (const ai of aiList) ai.afterMissionInit();
  }

  const tactic = info.tactic;
  const status: HandStatus[] = Array.from({ length: world.handCount }, () => 'playing');
  const goals = buildHandGoals(world, slots, scriptGoals.filter((g) => open.has(g.target)), tactic);

  return {
    world,
    slots,
    status,
    goals,
    ais,
    supervisor,
    log: [],
    missionMode: tactic ? 'fighting' : 'building',
  };
}

/**
 * The goals of every slot hand (KM_AI.pas 158–171, KM_AIGoals.pas 189–205): a hand with script goals
 * (`scriptGoals`, by its current hand) keeps only those; any other hand gets the default goals — survive
 * its own buildings (troops in a tactic mission) and win by the same condition on every enemy slot.
 */
export function buildHandGoals(w: EconomyWorld, slots: NormalizedSlot[], scriptGoals: ScriptGoal[], tactic: boolean): HandGoals[] {
  const goals: HandGoals[] = Array.from({ length: w.handCount }, () => ({ survival: [], victory: [] }));
  const condition = tactic ? GC_TROOPS : GC_BUILDINGS;
  for (const s of slots) {
    const own = scriptGoals.filter((g) => g.hand === s.hand);
    if (own.length > 0) {
      goals[s.hand] = {
        survival: own.filter((g) => !g.victory).map((g) => ({ victory: false, condition: g.condition, hand: g.target })),
        victory: own.filter((g) => g.victory).map((g) => ({ victory: true, condition: g.condition, hand: g.target })),
      };
      continue;
    }
    const enemies = slots.filter((e) => e.hand !== s.hand && w.allianceOf(s.hand, e.hand) === 'enemy').map((e) => e.hand);
    goals[s.hand] = {
      survival: [{ victory: false, condition, hand: s.hand }],
      victory: enemies.map((e) => ({ victory: true, condition, hand: e })),
    };
  }
  return goals;
}

/** The hand's own slot, or null for a hand without one. */
function slotOf(sk: Skirmish, hand: number): NormalizedSlot | null {
  return sk.slots.find((s) => s.hand === hand) ?? null;
}

function tickOf(cmd: unknown): unknown {
  return typeof cmd === 'object' && cmd !== null ? (cmd as { tick?: unknown }).tick : undefined;
}

/** The gate of the commands: human slots only, and a defeated hand takes no command (KM_GameInputProcess.pas 991). */
export function skirmishGate(sk: Skirmish): (hand: number) => string | null {
  return (hand: number): string | null => {
    const slot = slotOf(sk, hand);
    if (slot === null) return `hand ${hand} has no slot`;
    if (slot.kind !== 'human') return `hand ${hand} is an AI hand`;
    if (sk.status[hand] === 'defeated') return `hand ${hand} is defeated`;
    return null;
  };
}

/**
 * The one fixed tick of a skirmish (see the header). `commands` are the commands for the tick being run
 * (world.tickCount + 1); a command for another tick is rejected. Rejected commands are not logged.
 */
export function step(sk: Skirmish, commands: Command[]): StepResult {
  const tick = sk.world.tickCount + 1;
  const gate = skirmishGate(sk);
  const results: StepResult['results'] = [];
  for (const cmd of commands) {
    let result: CommandResult;
    if (tickOf(cmd) !== tick) result = { ok: false, reason: `command is for tick ${String(tickOf(cmd))}, this tick is ${tick}` };
    else result = applyCommand(sk.world, cmd, gate);
    if (result.ok) sk.log.push({ tick, cmd });
    results.push({ cmd, result });
  }
  sk.supervisor?.updateState(tick);
  for (const slot of sk.slots) {
    const ai = sk.ais[slot.hand];
    if (ai !== undefined && sk.status[slot.hand] === 'playing') ai.updateState(tick);
  }
  sk.world.tick();
  refreshFog(sk.world); // DynamicFOW refresh of standing units and finished houses (fowrefresh.ts)
  checkGoalsForTick(sk.world, sk, tick);
  return { tick, results };
}

/** The status of every slot hand and whether the match is over (a human hand has won or lost). */
export function skirmishStatus(sk: Skirmish): SkirmishStatus {
  const hands = sk.slots.map((s) => ({ hand: s.hand, kind: s.kind, status: sk.status[s.hand] }));
  const matchOver = sk.slots.some((s) => s.kind === 'human' && sk.status[s.hand] !== 'playing');
  return { tick: sk.world.tickCount, hands, matchOver };
}

/** The hands of a skirmish with their slots (for the UI and the CLI). */
export function humanHands(sk: Skirmish): number[] {
  return sk.slots.filter((s) => s.kind === 'human').map((s) => s.hand);
}
