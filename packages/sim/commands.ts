// commands.ts — M5d-A command layer (docs/M5D-SPIKE.md §1–§2). Every player action is a plain JSON
// command; the sim only changes through applyCommand(world, cmd). The UI, replays and (M6) the
// network all use this one function.
//
// Rules of this module:
//  - Commands are JSON data only (no functions, no Maps). Command = { hand, tick, type, ...args }.
//  - A bad command is rejected with a reason, never thrown and never half-applied: every check runs
//    before the first sim call, and the few multi-step commands roll back or pre-check their steps.
//  - No rule is duplicated: each command calls the existing sim function (construction.ts through the
//    economy world's plan API, economy.ts for schools/barracks/demolition, combat.ts for group orders).
//  - The optional gate (the skirmish's human-slot check) runs first; the sim itself does not know
//    which hands are human.
//
// Command types (docs/M5D-SPIKE.md §1, names frozen):
//   housePlan {typeId,x,y}                 → canAddHousePlan / addHousePlan
//   houseRemovePlan {x,y}                  → remHousePlan
//   roadPlan {x,y}                         → canAddFieldPlan / addFieldPlan ('road')
//   roadPlanLine {path:[{x,y}]}            → roadPlan for each tile, all or nothing
//   fieldPlan {x,y,kind:'corn'|'wine'}     → canAddFieldPlan / addFieldPlan; 'wine' is rejected (v0)
//   planRemove {x,y}                       → remFieldPlan, else remHousePlan
//   houseTrain {houseUid,unitType,count}   → schoolAddUnitToQueue (school queue, all or nothing)
//   houseEquip {houseUid,soldierType,count}→ barracksEquip, up to count (ok when at least one)
//   houseDeliveryMode {houseUid,mode}      → rejected: no delivery modes in the v0 economy
//   houseWareDemand {houseUid,ware,delta}  → rejected: no ware orders in the v0 economy
//   houseRepair {houseUid,on}              → rejected: repairs are out of v0 (economy.ts header)
//   houseDestroy {houseUid}                → demolishHouseByUid
//   groupWalk {groupUid,x,y,dir}           → groupOrderWalk (combat.ts), dir 0..8
//   groupAttackUnit {groupUid,targetUid}   → orderGroup 'attackUnit'
//   groupAttackHouse {groupUid,houseUid}   → orderGroup 'attackHouse'
//   groupHalt {groupUid}                   → orderGroup 'halt'
//   groupFormation {groupUid,unitsPerRow}  → groupSetUnitsPerRow (combat.ts)
// Left out (combat.ts header: "split/link/formation orders ... are out of v0"): groupSplit and
// groupLink. groupFormation is in: the sim has the units-per-row setter. gameSpeed and pause are not
// commands (client-local in single player; M6 makes them host commands).
//
// Browser-safe: no node: imports.
import type { EconomyWorld, EconHouse } from './economy.ts';
import { TROOP_COST } from './economy.ts';
import { HT_BARRACKS, HT_SCHOOL, UT_RECRUIT } from './ai.ts';
import { groupOrderWalk, groupSetUnitsPerRow } from './combat.ts';
import type { GroupState } from './combat.ts';

interface CommandBase {
  hand: number;
  tick: number;
  type: string;
}

export interface HousePlanCommand extends CommandBase {
  type: 'housePlan';
  typeId: number;
  x: number;
  y: number;
}

export interface HouseRemovePlanCommand extends CommandBase {
  type: 'houseRemovePlan';
  x: number;
  y: number;
}

export interface RoadPlanCommand extends CommandBase {
  type: 'roadPlan';
  x: number;
  y: number;
}

export interface RoadPlanLineCommand extends CommandBase {
  type: 'roadPlanLine';
  path: { x: number; y: number }[];
}

export interface FieldPlanCommand extends CommandBase {
  type: 'fieldPlan';
  x: number;
  y: number;
  kind: 'corn' | 'wine';
}

export interface PlanRemoveCommand extends CommandBase {
  type: 'planRemove';
  x: number;
  y: number;
}

export interface HouseTrainCommand extends CommandBase {
  type: 'houseTrain';
  houseUid: number;
  unitType: number;
  count: number;
}

export interface HouseEquipCommand extends CommandBase {
  type: 'houseEquip';
  houseUid: number;
  soldierType: number;
  count: number;
}

export interface HouseDeliveryModeCommand extends CommandBase {
  type: 'houseDeliveryMode';
  houseUid: number;
  mode: 'delivery' | 'takeOut' | 'closed';
}

export interface HouseWareDemandCommand extends CommandBase {
  type: 'houseWareDemand';
  houseUid: number;
  ware: number;
  delta: number;
}

export interface HouseRepairCommand extends CommandBase {
  type: 'houseRepair';
  houseUid: number;
  on: boolean;
}

export interface HouseDestroyCommand extends CommandBase {
  type: 'houseDestroy';
  houseUid: number;
}

export interface GroupWalkCommand extends CommandBase {
  type: 'groupWalk';
  groupUid: number;
  x: number;
  y: number;
  dir: number;
}

export interface GroupAttackUnitCommand extends CommandBase {
  type: 'groupAttackUnit';
  groupUid: number;
  targetUid: number;
}

export interface GroupAttackHouseCommand extends CommandBase {
  type: 'groupAttackHouse';
  groupUid: number;
  houseUid: number;
}

export interface GroupHaltCommand extends CommandBase {
  type: 'groupHalt';
  groupUid: number;
}

export interface GroupFormationCommand extends CommandBase {
  type: 'groupFormation';
  groupUid: number;
  unitsPerRow: number;
}

export type Command =
  | HousePlanCommand
  | HouseRemovePlanCommand
  | RoadPlanCommand
  | RoadPlanLineCommand
  | FieldPlanCommand
  | PlanRemoveCommand
  | HouseTrainCommand
  | HouseEquipCommand
  | HouseDeliveryModeCommand
  | HouseWareDemandCommand
  | HouseRepairCommand
  | HouseDestroyCommand
  | GroupWalkCommand
  | GroupAttackUnitCommand
  | GroupAttackHouseCommand
  | GroupHaltCommand
  | GroupFormationCommand;

export type CommandType = Command['type'];

export type CommandResult = { ok: true } | { ok: false; reason: string };

/** The optional gate of applyCommand: returns a reason to refuse the hand (null = allowed). */
export type CommandGate = (hand: number) => string | null;

export interface LoggedCommand {
  tick: number;
  cmd: Command;
}

/** The ordered command log: the commands that were applied, each with the tick it executed on. */
export type CommandLog = LoggedCommand[];

const COMMAND_TYPES: CommandType[] = [
  'housePlan',
  'houseRemovePlan',
  'roadPlan',
  'roadPlanLine',
  'fieldPlan',
  'planRemove',
  'houseTrain',
  'houseEquip',
  'houseDeliveryMode',
  'houseWareDemand',
  'houseRepair',
  'houseDestroy',
  'groupWalk',
  'groupAttackUnit',
  'groupAttackHouse',
  'groupHalt',
  'groupFormation',
];

/** Script ids of the house types the economy knows (HOUSE_ID_TO_TYPE, 0..29). */
const HOUSE_TYPE_MAX = 29;
const SCHOOL_QUEUE_MAX = 5;
const EQUIP_MAX = 20;
const ROAD_LINE_MAX = 64;
const DIR_MAX = 8;
const TRAINABLE_MAX = UT_RECRUIT;

function fail(reason: string): CommandResult {
  return { ok: false, reason };
}

const OK: CommandResult = { ok: true };

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function intIn(v: unknown, lo: number, hi: number): boolean {
  return isInt(v) && v >= lo && v <= hi;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shape and range checks on the JSON data (no sim state read yet). Returns a reason or null. */
function checkShape(world: EconomyWorld, raw: unknown): string | null {
  if (!isObject(raw)) return 'command must be a JSON object';
  const c = raw as Record<string, unknown>;
  if (!intIn(c.hand, 0, world.handCount - 1)) return `hand must be an integer 0..${world.handCount - 1}`;
  if (!isInt(c.tick)) return 'tick must be an integer';
  if (typeof c.type !== 'string' || !COMMAND_TYPES.includes(c.type as CommandType)) return `unknown command type ${String(c.type)}`;
  const xy = (x: unknown, y: unknown): string | null => {
    if (!isInt(x) || !isInt(y)) return 'x and y must be integers';
    if (!world.tileInMapCoords(x, y)) return `tile (${x},${y}) is outside the map`;
    return null;
  };
  switch (c.type) {
    case 'housePlan':
      if (!intIn(c.typeId, 0, HOUSE_TYPE_MAX)) return `typeId must be a house script id 0..${HOUSE_TYPE_MAX}`;
      return xy(c.x, c.y);
    case 'houseRemovePlan':
    case 'roadPlan':
    case 'planRemove':
      return xy(c.x, c.y);
    case 'fieldPlan':
      if (c.kind !== 'corn' && c.kind !== 'wine') return 'kind must be corn or wine';
      return xy(c.x, c.y);
    case 'roadPlanLine': {
      if (!Array.isArray(c.path) || c.path.length < 1 || c.path.length > ROAD_LINE_MAX) {
        return `path must hold 1..${ROAD_LINE_MAX} tiles`;
      }
      for (const p of c.path) {
        if (!isObject(p)) return 'path entries must be {x,y}';
        const bad = xy(p.x, p.y);
        if (bad !== null) return bad;
      }
      return null;
    }
    case 'houseTrain':
      if (!intIn(c.houseUid, 1, Number.MAX_SAFE_INTEGER)) return 'houseUid must be a positive integer';
      if (!intIn(c.unitType, 0, TRAINABLE_MAX)) return `unitType must be a unit record 0..${TRAINABLE_MAX}`;
      if (!intIn(c.count, 1, SCHOOL_QUEUE_MAX)) return `count must be 1..${SCHOOL_QUEUE_MAX}`;
      return null;
    case 'houseEquip':
      if (!intIn(c.houseUid, 1, Number.MAX_SAFE_INTEGER)) return 'houseUid must be a positive integer';
      if (!isInt(c.soldierType)) return 'soldierType must be an integer';
      if (!intIn(c.count, 1, EQUIP_MAX)) return `count must be 1..${EQUIP_MAX}`;
      return null;
    case 'houseDeliveryMode':
      if (!intIn(c.houseUid, 1, Number.MAX_SAFE_INTEGER)) return 'houseUid must be a positive integer';
      if (c.mode !== 'delivery' && c.mode !== 'takeOut' && c.mode !== 'closed') return 'mode must be delivery, takeOut or closed';
      return null;
    case 'houseWareDemand':
      if (!intIn(c.houseUid, 1, Number.MAX_SAFE_INTEGER)) return 'houseUid must be a positive integer';
      if (!intIn(c.ware, 0, 27)) return 'ware must be a ware id 0..27';
      if (!intIn(c.delta, -1, 1)) return 'delta must be -1, 0 or 1';
      return null;
    case 'houseRepair':
      if (!intIn(c.houseUid, 1, Number.MAX_SAFE_INTEGER)) return 'houseUid must be a positive integer';
      if (typeof c.on !== 'boolean') return 'on must be a boolean';
      return null;
    case 'houseDestroy':
      if (!intIn(c.houseUid, 1, Number.MAX_SAFE_INTEGER)) return 'houseUid must be a positive integer';
      return null;
    case 'groupWalk':
      if (!intIn(c.groupUid, 1, Number.MAX_SAFE_INTEGER)) return 'groupUid must be a positive integer';
      if (!intIn(c.dir, 0, DIR_MAX)) return `dir must be 0..${DIR_MAX}`;
      return xy(c.x, c.y);
    case 'groupAttackUnit':
      if (!intIn(c.groupUid, 1, Number.MAX_SAFE_INTEGER)) return 'groupUid must be a positive integer';
      if (!intIn(c.targetUid, 1, Number.MAX_SAFE_INTEGER)) return 'targetUid must be a positive integer';
      return null;
    case 'groupAttackHouse':
      if (!intIn(c.groupUid, 1, Number.MAX_SAFE_INTEGER)) return 'groupUid must be a positive integer';
      if (!intIn(c.houseUid, 1, Number.MAX_SAFE_INTEGER)) return 'houseUid must be a positive integer';
      return null;
    case 'groupHalt':
      if (!intIn(c.groupUid, 1, Number.MAX_SAFE_INTEGER)) return 'groupUid must be a positive integer';
      return null;
    case 'groupFormation':
      if (!intIn(c.groupUid, 1, Number.MAX_SAFE_INTEGER)) return 'groupUid must be a positive integer';
      if (!intIn(c.unitsPerRow, 1, 64)) return 'unitsPerRow must be 1..64';
      return null;
    default:
      return 'unknown command type';
  }
}

/** A house of this hand that is not destroyed, or a reason. */
function ownHouse(w: EconomyWorld, hand: number, uid: number): EconHouse | string {
  const h = w.houseByUid(uid);
  if (h === null || h.destroyed) return `house #${uid} does not exist`;
  if (h.owner !== hand) return `house #${uid} is not yours`;
  return h;
}

/** A group of this hand, or a reason. */
function ownGroup(w: EconomyWorld, hand: number, uid: number): GroupState | string {
  const g = w.groupByUid(uid);
  if (g === null) return `group #${uid} does not exist`;
  if (g.owner !== hand) return `group #${uid} is not yours`;
  return g;
}

function houseTrain(w: EconomyWorld, c: HouseTrainCommand): CommandResult {
  const h = ownHouse(w, c.hand, c.houseUid);
  if (typeof h === 'string') return fail(h);
  if (h.typeId !== HT_SCHOOL) return fail('houseTrain: that house is not a school');
  if (h.buildState !== 'done') return fail('houseTrain: the school is not finished');
  const free = w.schoolQueueOf(h.uid).slice(1).filter((q) => q === -1).length;
  if (free < c.count) return fail(`houseTrain: only ${free} free queue slots`);
  w.schoolAddUnitToQueue(h.uid, c.unitType, c.count);
  return OK;
}

function houseEquip(w: EconomyWorld, c: HouseEquipCommand): CommandResult {
  const h = ownHouse(w, c.hand, c.houseUid);
  if (typeof h === 'string') return fail(h);
  if (h.typeId !== HT_BARRACKS) return fail('houseEquip: that house is not a barracks');
  if (h.buildState !== 'done') return fail('houseEquip: the barracks is not finished');
  if (TROOP_COST[c.soldierType] === undefined) return fail(`houseEquip: unit ${c.soldierType} is not a soldier`);
  let equipped = 0;
  while (equipped < c.count && w.barracksEquip(h.uid, c.soldierType) !== null) equipped += 1;
  if (equipped === 0) return fail('houseEquip: no recruit or no wares for that soldier');
  return OK;
}

function roadPlanLine(w: EconomyWorld, c: RoadPlanLineCommand): CommandResult {
  const added: { x: number; y: number }[] = [];
  for (const p of c.path) {
    if (!w.canAddFieldPlan(c.hand, p.x, p.y, 'road')) {
      for (const q of added) w.remFieldPlan(c.hand, q.x, q.y);
      return fail(`roadPlanLine: tile (${p.x},${p.y}) cannot take a road plan`);
    }
    w.addFieldPlan(c.hand, p.x, p.y, 'road');
    added.push(p);
  }
  return OK;
}

function groupCommand(w: EconomyWorld, hand: number, uid: number): GroupState | CommandResult {
  const g = ownGroup(w, hand, uid);
  return typeof g === 'string' ? fail(g) : g;
}

/** Enemy check for the group orders (the sim's own alliance rule: a hand is an enemy of every other). */
function isEnemyOf(w: EconomyWorld, hand: number, owner: number): boolean {
  return owner >= 0 && w.allianceOf(hand, owner) === 'enemy';
}

function dispatch(w: EconomyWorld, c: Command): CommandResult {
  switch (c.type) {
    case 'housePlan': {
      if (w.houseSpecOf(c.typeId) === undefined) return fail(`housePlan: no house type ${c.typeId}`);
      if (!w.canAddHousePlan(c.hand, c.typeId, c.x, c.y)) return fail(`housePlan: type ${c.typeId} cannot go at (${c.x},${c.y})`);
      w.addHousePlan(c.hand, c.typeId, c.x, c.y);
      return OK;
    }
    case 'houseRemovePlan':
      if (w.remHousePlan(c.hand, c.x, c.y) === null) return fail(`houseRemovePlan: no house plan at (${c.x},${c.y})`);
      return OK;
    case 'roadPlan':
      if (!w.canAddFieldPlan(c.hand, c.x, c.y, 'road')) return fail(`roadPlan: (${c.x},${c.y}) cannot take a road plan`);
      w.addFieldPlan(c.hand, c.x, c.y, 'road');
      return OK;
    case 'roadPlanLine':
      return roadPlanLine(w, c);
    case 'fieldPlan': {
      if (c.kind === 'wine') return fail('fieldPlan: wine fields are not in the v0 sim');
      if (!w.canAddFieldPlan(c.hand, c.x, c.y, 'corn')) return fail(`fieldPlan: (${c.x},${c.y}) cannot take a corn field`);
      w.addFieldPlan(c.hand, c.x, c.y, 'corn');
      return OK;
    }
    case 'planRemove': {
      if (w.hasFieldPlan(c.hand, c.x, c.y) !== 'none') {
        w.remFieldPlan(c.hand, c.x, c.y);
        return OK;
      }
      if (w.remHousePlan(c.hand, c.x, c.y) !== null) return OK;
      return fail(`planRemove: no plan at (${c.x},${c.y})`);
    }
    case 'houseTrain':
      return houseTrain(w, c);
    case 'houseEquip':
      return houseEquip(w, c);
    case 'houseDeliveryMode':
      ownHouse(w, c.hand, c.houseUid);
      return fail('houseDeliveryMode: delivery modes are not in the v0 economy (no mode state in economy.ts)');
    case 'houseWareDemand':
      ownHouse(w, c.hand, c.houseUid);
      return fail('houseWareDemand: ware orders are not in the v0 economy (no order state in economy.ts)');
    case 'houseRepair':
      ownHouse(w, c.hand, c.houseUid);
      return fail('houseRepair: repairs are out of v0 (economy.ts header)');
    case 'houseDestroy': {
      const h = ownHouse(w, c.hand, c.houseUid);
      if (typeof h === 'string') return fail(h);
      w.demolishHouseByUid(h.uid, c.hand);
      return OK;
    }
    case 'groupWalk': {
      const g = groupCommand(w, c.hand, c.groupUid);
      if (!('uid' in g)) return g;
      if (!w.tileWalkable(c.x, c.y)) return fail(`groupWalk: (${c.x},${c.y}) is not walkable`);
      groupOrderWalk(w, g, { x: c.x, y: c.y }, true, 'none', c.dir, true);
      return OK;
    }
    case 'groupAttackUnit': {
      const g = groupCommand(w, c.hand, c.groupUid);
      if (!('uid' in g)) return g;
      const t = w.unitByUid(c.targetUid);
      if (t === null || t.dead) return fail(`groupAttackUnit: unit #${c.targetUid} does not exist`);
      if (!isEnemyOf(w, c.hand, t.owner)) return fail(`groupAttackUnit: unit #${c.targetUid} is not an enemy`);
      w.orderGroup(g.uid, 'attackUnit', 0, 0, t.uid);
      return OK;
    }
    case 'groupAttackHouse': {
      const g = groupCommand(w, c.hand, c.groupUid);
      if (!('uid' in g)) return g;
      const h = w.houseByUid(c.houseUid);
      if (h === null || h.destroyed) return fail(`groupAttackHouse: house #${c.houseUid} does not exist`);
      if (!isEnemyOf(w, c.hand, h.owner)) return fail(`groupAttackHouse: house #${c.houseUid} is not an enemy's`);
      w.orderGroup(g.uid, 'attackHouse', 0, 0, h.uid);
      return OK;
    }
    case 'groupHalt': {
      const g = groupCommand(w, c.hand, c.groupUid);
      if (!('uid' in g)) return g;
      w.orderGroup(g.uid, 'halt');
      return OK;
    }
    case 'groupFormation': {
      const g = groupCommand(w, c.hand, c.groupUid);
      if (!('uid' in g)) return g;
      if (c.unitsPerRow > Math.max(1, g.memberUids.length)) return fail(`groupFormation: ${g.memberUids.length} members`);
      groupSetUnitsPerRow(g, c.unitsPerRow);
      return OK;
    }
  }
}

/**
 * Apply one command to the world. Returns { ok: true } or { ok: false, reason }. Never throws: a
 * malformed or refused command changes nothing (every check runs before the first sim call).
 * `gate` (optional) refuses hands, e.g. an AI hand in a skirmish.
 */
export function applyCommand(world: EconomyWorld, cmd: Command, gate?: CommandGate): CommandResult {
  try {
    const shape = checkShape(world, cmd);
    if (shape !== null) return fail(shape);
    const denied = gate !== undefined ? gate(cmd.hand) : null;
    if (denied !== null) return fail(denied);
    return dispatch(world, cmd);
  } catch (err) {
    return fail(`internal: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The commands of a log that executed on one tick, in log order. */
export function commandsAtTick(log: CommandLog, tick: number): Command[] {
  return log.filter((e) => e.tick === tick).map((e) => e.cmd);
}

/** Serialize a command log to JSON (plain data; the order of entries is the execution order). */
export function commandLogToJson(log: CommandLog): string {
  return JSON.stringify(log.map((e) => ({ tick: e.tick, cmd: e.cmd })));
}

/**
 * Parse a command log from JSON. Checks the entry shape only (tick, hand, type); the commands are
 * validated again when they are applied. Throws on malformed JSON or a malformed entry.
 */
export function commandLogFromJson(text: string): CommandLog {
  const data: unknown = JSON.parse(text);
  if (!Array.isArray(data)) throw new Error('command log: expected a JSON array');
  return data.map((entry, i): LoggedCommand => {
    if (!isObject(entry) || !isInt(entry.tick) || !isObject(entry.cmd)) {
      throw new Error(`command log: entry ${i} needs {tick, cmd}`);
    }
    const cmd = entry.cmd;
    if (!isInt(cmd.hand) || typeof cmd.type !== 'string' || !isInt(cmd.tick)) {
      throw new Error(`command log: entry ${i} cmd needs integer hand and tick and a string type`);
    }
    return { tick: entry.tick, cmd: cmd as unknown as Command };
  });
}
