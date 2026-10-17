// aiarmy.ts — M5c: the Advanced AI's military half (docs/M5-SPIKE.md 7.5, docs/M5-AI-NOTES.md §2–§3).
//
// Ported from the r15472 newAI army classes (read-only reference, src/ai/newAI/):
//  - KM_ArmyManagement.pas — RecruitSoldiers (199–287), CheckGroupsState (291–330), CheckAttack with the
//    attack request and the scripted attacks (333–530), UpdateState cadence `tick mod 27 = owner` (546–568).
//  - KM_ArmyAttackNew.pas — TKMCombatGroup.UpdateState (303–492) and PlanPath (495–564); the group list
//    AddGroup(s)/ReleaseGroup/LinkGroup (704–759); UpdateState walks the groups in reverse (628–661).
//  - KM_ArmyDefence.pas — TKMDefencePosition (169–192), FindPlaceForGroup (291–350), UpdateDefences
//    (421–474), UpdateFixedDefences (477–499), UpdateState fast 27·5 / slow 27·20 (508–522).
//  - ai/KM_AIAttacks.pas — CanOccur (62–84) and HasOccured (87–90).
//
// Simplifications (flagged; each is deliberate and listed in docs/M5-SPIKE.md 7.5):
//  - No NavMesh: PlanPath keeps the Pascal's distance thresholds (AI_Par ATTACK_SQUAD) and walks straight
//    at the target; the group's own tile router walks it. AvoidEnemyRoute/AvoidTrafficRoute are not ported.
//  - No split: v0 combat has no OrderSplitUnit/OrderSplitLinkTo, so linking moves whole members (as many as
//    fit) and a group is placed whole at a defence position.
//  - Ranged groups do not reposition in formation (MoveRangedInFormation is skipped): they attack as melee.
//  - Food: no OrderFood (v0 has no soldier food logistics); FoodProblems is always false.
//  - Equip: economy.barracksEquip takes the wares from the hand's stock; the warrior stands at the door at
//    once and WarriorEquipped runs in the same call (the Pascal waits for WarriorWalkedOut).
//  - Targets: a combat group without a target takes the nearest house of the attack request's enemies, in
//    TARGET_HOUSES first (the Pascal's army-vector cluster orders, EvaluateEnemy, are not ported).
//  - Scripted attacks hand the found target to the released groups. The Pascal's OrderAttack drops its
//    target point, so this is a deviation (the scripted target is the intent of the record).
//
// Pascal behaviour kept on purpose (observed in the source, see docs/M5-SPIKE.md 7.5 "Pascal notes"):
//  - OrderAttack passes the whole group array to AddGroups, including the entries past the counted ones.
//  - FilterGroups adds the member count of the element displaced by the swap, not the chosen one.
//  - The traffic counter is capped at ATTACK_SQUAD_TrafficDetection_Limit (1), so StuckInTraffic can never
//    be set (threshold 10).
//
// Browser-safe: no node: imports.
import type { EconomyWorld, EconHouse } from './economy.ts';
import type { GroupState, CombatUnit } from './combat.ts';
import {
  addGroupMember,
  groupCanTakePlayerOrders,
  groupFightMaxRange,
  groupIsDead,
  groupIsIdleToAI,
  groupIsRanged,
  groupMembers,
  isDeadOrDying,
  GT_MELEE,
} from './combat.ts';
import type { AiPlayer, AiSetup, Pt, ScriptAttack, ArmySlot } from './ai.ts';
import {
  AI_PAR,
  distanceAbs,
  distanceSqr,
  HT_BARRACKS,
  HT_SCHOOL,
  HT_STORE,
  HT_TOWN_HALL,
  UT_AXE_FIGHTER,
  UT_BOWMAN,
  UT_CROSSBOWMAN,
  UT_KNIGHT,
  UT_LANCE_CARRIER,
  UT_MILITIA,
  UT_PIKEMAN,
  UT_SCOUT,
  UT_SWORD_FIGHTER,
} from './ai.ts';
import { MAX_HANDS } from '../mission/mission.ts';

/** TKMCombatPhase (KM_ArmyAttackNew.pas 18). */
export type CombatPhase = 'idle' | 'walk' | 'attack' | 'dead';
/** TKMTargetType (KM_ArmyAttackNew.pas 17). */
export type TargetType = 'none' | 'point' | 'house' | 'group' | 'unit';

/** TKMCombatGroup (KM_ArmyAttackNew.pas 27–76): one attacking squad of the army. */
export interface CombatGroupAI {
  groupUid: number;
  targetType: TargetType;
  phase: CombatPhase;
  onPlace: boolean;
  targetChanged: boolean;
  targetGroupUid: number;
  targetUnitUid: number;
  targetHouseUid: number;
  targetPos: { x: number; y: number; dir: number } | null;
  targetAim: Pt;
  walkTimeLimit: number;
  attackTimeLimit: number;
  stuckCounter: number;
  stuckInTraffic: boolean;
  prevPos: Pt;
}

/** TKMAttackRequest (KM_ArmyManagement.pas 21–26), written by the Supervisor. */
export interface AttackRequest {
  active: boolean;
  foodShortage: boolean;
  ffa: boolean;
  bestAllianceCmp: number;
  worstAllianceCmp: number;
  bestEnemy: number;
  enemies: number[];
}

/** TKMDefencePosition (KM_ArmyDefence.pas 17–41) without the pointer: the group is a uid (0 = empty). */
export interface DefencePosition {
  loc: Pt;
  dir: number;
  weight: number;
  line: number;
  groupUid: number;
}

/** One requested defence position (the UpdateDefences input record, DefencePosition array). */
export interface DefencePositionRequest {
  loc: Pt;
  dir: number;
  weight: number;
  line: number;
}

/** A scripted or chosen target for a released group. */
interface ArmyTarget {
  kind: 'house' | 'unit' | 'point';
  uid: number;
  pos: Pt;
}

interface AvailableGroups {
  count: number;
  arr: (GroupState | null)[];
  groupsAvailable: number[]; // indexed by group type (2..5)
  menAvailable: number[];
}

const GROUP_TYPE_COUNT = 4; // gtMelee..gtMounted (script index = type − 2)
/** TKMArmyType (KM_ResTypes.pas): atLeather = 1, atIron = 2. */
const AT_LEATHER = 1;
const AT_IRON = 2;
/** MAX_SOLDIERS_IN_GROUP (KM_ArmyDefence.pas 86). */
const MAX_SOLDIERS_IN_GROUP = 9;
/** MIN_DEF_RATIO, ATT_ADVANTAGE, MIN_GROUPS_IN_ATTACK, MIN_TROOPS_IN_GROUP (KM_ArmyManagement.pas 344–477). */
const MIN_DEF_RATIO = 1.2;
const ATT_ADVANTAGE = 0.2;
const MIN_GROUPS_IN_ATTACK = 4;
const MIN_TROOPS_IN_GROUP = 4;
/** TARGET_HOUSES (KM_ArmyAttackNew.pas 115): the houses a group is sent to first. */
const TARGET_HOUSES = [HT_BARRACKS, HT_STORE, HT_SCHOOL, HT_TOWN_HALL];
/** AI_TROOP_TRAIN_ORDER (KM_Defaults.pas 701–705): per group type (melee..mounted), the warriors trained
 *  first to last; −1 = utNone. */
const AI_TROOP_TRAIN_ORDER: number[][] = [
  [UT_SWORD_FIGHTER, UT_AXE_FIGHTER, UT_MILITIA],
  [UT_PIKEMAN, UT_LANCE_CARRIER, -1],
  [UT_CROSSBOWMAN, UT_BOWMAN, -1],
  [UT_KNIGHT, UT_SCOUT, -1],
];
/** WARRIORS_IRON (KM_Defaults.pas 656). */
const WARRIORS_IRON = new Set([UT_SWORD_FIGHTER, UT_CROSSBOWMAN, UT_PIKEMAN, UT_KNIGHT]);
/** FAST_UPDATE / SLOW_UPDATE (KM_ArmyDefence.pas 510–511) with MAX_HANDS = 27. */
const FAST_UPDATE = MAX_HANDS * 5;
const SLOW_UPDATE = MAX_HANDS * 20;

function samePoint(a: Pt, b: Pt): boolean {
  return a.x === b.x && a.y === b.y;
}

/** The group's Position: its first living member (TKMUnitGroup.Position → GetAliveMember). */
function groupPosition(w: EconomyWorld, g: GroupState): Pt {
  for (const u of groupMembers(w, g)) if (!isDeadOrDying(u)) return w.posRound(u);
  return { x: g.orderX, y: g.orderY };
}

function aliveMemberUid(w: EconomyWorld, g: GroupState): number {
  for (const u of groupMembers(w, g)) if (!isDeadOrDying(u)) return u.uid;
  return 0;
}

/** The house's walk point: the tile below its entrance (the attack and the defence walk aim). */
function houseAim(h: EconHouse): Pt {
  return { x: h.entrance.x, y: h.entrance.y + 1 };
}

/** Move up to `n` members from the front of `src` into `dst` (LinkGroup without a split). */
function moveGroupMembers(w: EconomyWorld, src: GroupState, dst: GroupState, n: number): void {
  const moved = src.memberUids.splice(0, Math.max(0, Math.min(n, src.memberUids.length)));
  for (const uid of moved) {
    const u = w.unitByUid(uid);
    if (u !== null) addGroupMember(w, dst, u, -1);
  }
}

function newCombatGroup(groupUid: number, pos: Pt): CombatGroupAI {
  return {
    groupUid,
    targetType: 'none',
    phase: 'idle',
    onPlace: false,
    targetChanged: true,
    targetGroupUid: 0,
    targetUnitUid: 0,
    targetHouseUid: 0,
    targetPos: null,
    targetAim: { x: 0, y: 0 },
    walkTimeLimit: 0,
    attackTimeLimit: 0,
    stuckCounter: 0,
    stuckInTraffic: false,
    prevPos: pos,
  };
}

// ---------------------------------------------------------------------------------------------
// ArmyAttackNew

/** TKMArmyAttackNew: the combat groups of one hand (KM_ArmyAttackNew.pas 78–111). */
export class ArmyAttackNew {
  readonly owner: number;
  readonly cgs: CombatGroupAI[] = [];
  private readonly world: EconomyWorld;

  constructor(world: EconomyWorld, owner: number) {
    this.world = world;
    this.owner = owner;
  }

  get count(): number {
    return this.cgs.length;
  }

  getCombatGroup(groupUid: number): CombatGroupAI | undefined {
    return this.cgs.find((c) => c.groupUid === groupUid);
  }

  /** IsGroupInAction (698–701). */
  isGroupInAction(groupUid: number): boolean {
    return this.getCombatGroup(groupUid) !== undefined;
  }

  /** AddGroup (704–718): a live group joins the attack once. */
  addGroup(groupUid: number): CombatGroupAI | null {
    const g = this.world.groupByUid(groupUid);
    if (g === null || groupIsDead(g)) return null;
    const existing = this.getCombatGroup(groupUid);
    if (existing !== undefined) return existing;
    const cg = newCombatGroup(groupUid, groupPosition(this.world, g));
    this.cgs.push(cg);
    return cg;
  }

  /** AddGroups (721–727): the Pascal passes the whole array; null entries are skipped (AddGroup 706). */
  addGroups(groupUids: (number | null)[]): void {
    for (const uid of groupUids) if (uid !== null && uid !== 0) this.addGroup(uid);
  }

  /** ReleaseGroup (730–737). */
  releaseGroup(groupUid: number): void {
    const i = this.cgs.findIndex((c) => c.groupUid === groupUid);
    if (i >= 0) this.cgs.splice(i, 1);
  }

  /** LinkGroup (746–759): a new group joins the first attack group of its type that has room. */
  linkGroup(groupUid: number): void {
    const src = this.world.groupByUid(groupUid);
    if (src === null) return;
    for (const cg of this.cgs) {
      const dst = this.world.groupByUid(cg.groupUid);
      if (dst === null || dst.groupType !== src.groupType || dst.memberUids.length >= MAX_SOLDIERS_IN_GROUP) continue;
      moveGroupMembers(this.world, src, dst, MAX_SOLDIERS_IN_GROUP - dst.memberUids.length);
      dst.unitsPerRow = Math.max(3, dst.unitsPerRow);
      if (src.memberUids.length === 0) return;
    }
  }

  /** The target of a group that has none: the nearest house of the enemies (TARGET_HOUSES first). */
  private assignTargets(enemies: number[]): void {
    if (enemies.length === 0) return;
    for (const cg of this.cgs) {
      if (cg.phase === 'dead' || cg.targetType !== 'none' || cg.targetPos !== null) continue;
      const g = this.world.groupByUid(cg.groupUid);
      if (g === null || groupIsDead(g)) continue;
      const from = groupPosition(this.world, g);
      const house = nearestEnemyHouse(this.world, this.owner, enemies, from, TARGET_HOUSES) ?? nearestEnemyHouse(this.world, this.owner, enemies, from, null);
      if (house !== null) setTargetHouse(this.world, cg, house.uid);
    }
  }

  /** AttackNew.UpdateState (628–661): assign the targets, then walk every group in reverse order. */
  updateState(tick: number, enemies: number[]): void {
    this.assignTargets(enemies);
    for (let k = this.cgs.length - 1; k >= 0; k--) {
      const cg = this.cgs[k];
      this.updateCombatGroup(cg, tick);
      if (cg.phase === 'dead') this.cgs.splice(k, 1);
    }
  }

  /** TKMCombatGroup.UpdateState (303–492). */
  private updateCombatGroup(cg: CombatGroupAI, tick: number): void {
    const w = this.world;
    cg.onPlace = false;
    const g = w.groupByUid(cg.groupUid);
    if (g === null || groupIsDead(g)) {
      cg.phase = 'dead';
      return;
    }
    if (!groupCanTakePlayerOrders(w, g)) return; // InFight (KM_ArmyAttackNew.pas 402)

    if (cg.targetGroupUid !== 0) {
      const tg = w.groupByUid(cg.targetGroupUid);
      if (tg === null || groupIsDead(tg)) setTargetGroup(w, cg, 0);
    }
    if (cg.targetUnitUid !== 0) {
      const tu = w.unitByUid(cg.targetUnitUid);
      if (tu === null || isDeadOrDying(tu)) {
        if (cg.targetGroupUid !== 0) {
          const tg = w.groupByUid(cg.targetGroupUid) as GroupState;
          changeTargetUnit(w, cg, aliveMemberUid(w, tg));
          cg.targetAim = unitAim(w, cg);
          const pos = groupPosition(w, g);
          const range = groupFightMaxRange(w, g);
          if (distanceSqr(cg.targetAim, pos) > range * range) {
            cg.targetType = 'group';
            cg.phase = 'attack';
            return;
          }
        } else setTargetUnit(w, cg, 0);
      }
    }
    if (cg.targetHouseUid !== 0) {
      const th = w.houseByUid(cg.targetHouseUid);
      if (th === null || th.destroyed) setTargetHouse(w, cg, 0);
    }

    const actPos = groupPosition(w, g);
    const ranged = groupIsRanged(g);
    if (cg.targetUnitUid !== 0 || cg.targetGroupUid !== 0) {
      cg.targetAim = unitAim(w, cg);
      if (planPath(cg, ranged, tick, actPos, cg.targetAim, true, false)) {
        w.orderGroup(g.uid, 'walk', cg.targetAim.x, cg.targetAim.y);
      } else if (
        cg.targetChanged ||
        distanceSqr(cg.targetAim, actPos) > 12 * 12 ||
        g.order === 'none' ||
        g.order === 'attackHouse' ||
        g.order === 'walk' ||
        cg.attackTimeLimit < tick
      ) {
        cg.attackTimeLimit = tick + Math.round(AI_PAR.ATTACK_SQUAD_ChangeTarget_Delay);
        cg.targetChanged = false;
        w.orderGroup(g.uid, 'attackUnit', 0, 0, cg.targetUnitUid);
      }
      cg.onPlace = true;
    } else if (cg.targetHouseUid !== 0) {
      const th = w.houseByUid(cg.targetHouseUid) as EconHouse;
      cg.targetAim = houseAim(th);
      if (planPath(cg, ranged, tick, actPos, cg.targetAim, false, true)) {
        w.orderGroup(g.uid, 'walk', cg.targetAim.x, cg.targetAim.y);
      } else if (!ranged || cg.targetChanged || cg.attackTimeLimit < tick) {
        cg.attackTimeLimit = tick + Math.round(AI_PAR.ATTACK_SQUAD_ChangeTarget_Delay);
        cg.targetChanged = false;
        w.orderGroup(g.uid, 'attackHouse', 0, 0, cg.targetHouseUid);
      }
      cg.onPlace = true;
    } else if (cg.targetPos !== null) {
      cg.targetAim = { x: cg.targetPos.x, y: cg.targetPos.y };
      if (planPath(cg, ranged, tick, actPos, cg.targetAim, false, false)) {
        w.orderGroup(g.uid, 'walk', cg.targetAim.x, cg.targetAim.y);
      } else if (!samePoint(actPos, cg.targetPos)) {
        w.orderGroup(g.uid, 'walk', cg.targetPos.x, cg.targetPos.y);
      }
    } else {
      w.orderGroup(g.uid, 'none');
    }

    cg.targetType = 'none';
    cg.phase = 'attack';
    if (cg.targetHouseUid !== 0) cg.targetType = 'house';
    else if (cg.targetGroupUid !== 0) cg.targetType = 'group';
    else if (cg.targetUnitUid !== 0) cg.targetType = 'unit';
    else if (cg.targetPos !== null) {
      cg.targetType = 'point';
      cg.phase = 'walk';
    } else cg.phase = 'idle';

    // Traffic detection (KM_ArmyAttackNew.pas 488–491). The counter is capped at the Limit (1), so
    // stuckInTraffic stays false — the Pascal's behaviour, kept.
    const walked = distanceAbs(cg.prevPos, groupPosition(w, g));
    cg.stuckCounter = Math.min(
      Math.round(AI_PAR.ATTACK_SQUAD_TrafficDetection_Limit),
      Math.max(0, (cg.phase === 'walk' ? 1 : 0) * cg.stuckCounter + (walked <= 1 ? 1 : 0) * 2 - 1),
    );
    cg.stuckInTraffic = cg.stuckCounter > AI_PAR.ATTACK_SQUAD_TrafficDetection_Threshold;
    cg.prevPos = groupPosition(w, g);
  }
}

/** TKMCombatGroup.PlanPath (495–564) without the navmesh: the Pascal's reach thresholds, then a direct walk. */
function planPath(cg: CombatGroupAI, ranged: boolean, tick: number, actual: Pt, target: Pt, attack: boolean, destroy: boolean): boolean {
  const sq = distanceSqr(actual, target);
  const sqr = (v: number): number => v * v;
  const reached =
    (!(attack || destroy) && cg.walkTimeLimit < tick) ||
    sq < sqr(AI_PAR.ATTACK_SQUAD_TargetReached_Position) ||
    (attack && sq < sqr(AI_PAR.ATTACK_SQUAD_TargetReached_Unit)) ||
    (destroy && sq < sqr(AI_PAR.ATTACK_SQUAD_TargetReached_House)) ||
    ((attack || destroy) && ranged && sq < sqr(AI_PAR.ATTACK_SQUAD_TargetReached_RangedSquad));
  if (reached) {
    cg.onPlace = true;
    return false;
  }
  return true;
}

/** The aim of a unit or group target (GetTargetUnitPosition, without the ranged closest-member pick). */
function unitAim(w: EconomyWorld, cg: CombatGroupAI): Pt {
  const u = w.unitByUid(cg.targetUnitUid);
  return u !== null ? w.posRound(u) : cg.targetAim;
}

function setTargetGroup(w: EconomyWorld, cg: CombatGroupAI, groupUid: number): void {
  if (groupUid === cg.targetGroupUid) return;
  const g = groupUid !== 0 ? w.groupByUid(groupUid) : null;
  if (g === null || groupIsDead(g)) {
    cg.targetGroupUid = 0;
    setTargetUnit(w, cg, 0);
    return;
  }
  cg.targetGroupUid = groupUid;
  changeTargetUnit(w, cg, aliveMemberUid(w, g));
}

function setTargetUnit(w: EconomyWorld, cg: CombatGroupAI, unitUid: number): void {
  if (unitUid === cg.targetUnitUid) return;
  cg.targetGroupUid = 0;
  const u = unitUid !== 0 ? w.unitByUid(unitUid) : null;
  if (u !== null && !isDeadOrDying(u)) changeTargetUnit(w, cg, unitUid);
  else cg.targetUnitUid = 0;
}

/** ChangeTargetUnit (255–261): the change flag is set unless the old target is dead or the same group. */
function changeTargetUnit(w: EconomyWorld, cg: CombatGroupAI, unitUid: number): void {
  const old = cg.targetUnitUid !== 0 ? w.unitByUid(cg.targetUnitUid) : null;
  const neu = unitUid !== 0 ? w.unitByUid(unitUid) : null;
  cg.targetChanged =
    old === null ||
    !isDeadOrDying(old) ||
    (neu !== null && old.groupUid !== neu.groupUid && old.groupUid !== 0 && neu.groupUid !== 0);
  cg.targetUnitUid = unitUid;
}

function setTargetHouse(w: EconomyWorld, cg: CombatGroupAI, houseUid: number): void {
  if (houseUid !== 0) setTargetGroup(w, cg, 0);
  if (cg.targetHouseUid === houseUid) return;
  cg.targetChanged = true;
  cg.targetHouseUid = houseUid;
}

function setTargetPosition(w: EconomyWorld, cg: CombatGroupAI, loc: Pt, dir: number, tick: number): void {
  setTargetGroup(w, cg, 0);
  cg.targetHouseUid = 0;
  cg.targetPos = { x: loc.x, y: loc.y, dir };
  const g = w.groupByUid(cg.groupUid);
  const from = g !== null ? groupPosition(w, g) : loc;
  cg.walkTimeLimit = tick + distanceAbs(loc, from) * 5;
}

/** The nearest completed house of the enemies (GetClosestHouse, KM_HandsCollection.pas): the house
 *  types, or any house when `types` is null. Ties keep the first in creation order. */
function nearestEnemyHouse(w: EconomyWorld, owner: number, enemies: number[], from: Pt, types: number[] | null): EconHouse | null {
  let best: EconHouse | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  for (const h of w.houses) {
    if (h.destroyed || h.buildState !== 'done' || !enemies.includes(h.owner) || h.owner === owner) continue;
    if (types !== null && !types.includes(h.typeId)) continue;
    const d = distanceSqr(from, { x: h.entrance.x, y: h.entrance.y + 1 });
    if (d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// ArmyDefence

/** TKMArmyDefence (KM_ArmyDefence.pas 44–83): the defence positions of one hand. */
export class ArmyDefence {
  readonly owner: number;
  readonly positions: DefencePosition[] = [];
  firstLineCnt = 0;
  private readonly world: EconomyWorld;
  private readonly setup: AiSetup;

  constructor(world: EconomyWorld, owner: number, setup: AiSetup) {
    this.world = world;
    this.owner = owner;
    this.setup = setup;
  }

  get count(): number {
    return this.positions.length;
  }

  private formationOf(groupType: number): { numUnits: number; unitsPerRow: number } {
    return this.setup.troopFormations[groupType - GT_MELEE] ?? { numUnits: MAX_SOLDIERS_IN_GROUP, unitsPerRow: 3 };
  }

  /** The live group of a position (null when empty or the group is dead). */
  private liveGroup(p: DefencePosition): GroupState | null {
    if (p.groupUid === 0) return null;
    const g = this.world.groupByUid(p.groupUid);
    return g !== null && !groupIsDead(g) ? g : null;
  }

  /** TKMArmyDefence.GroupsCount (GetGroupsCount): positions with a group. */
  groupsCount(): number {
    let n = 0;
    for (const p of this.positions) if (this.liveGroup(p) !== null) n += 1;
    return n;
  }

  /** TKMDefencePosition.CanAccept (169–173): empty, or the same group type with room. */
  private canAccept(p: DefencePosition, g: GroupState): boolean {
    const occupant = this.liveGroup(p);
    if (occupant === null) return true;
    return occupant.groupType === g.groupType && occupant.memberUids.length < this.formationOf(g.groupType).numUnits;
  }

  /** DefenceStatus (405–418): the occupied positions over the first line. */
  defenceStatus(): number {
    if (this.positions.length === 0) return 0;
    return this.groupsCount() / Math.max(1, this.firstLineCnt);
  }

  /** FindPositionOf (354–368): the index of the group's position, −1 when none. */
  findPositionOf(groupUid: number, ignoreFirstLine = false): number {
    const k = this.positions.findIndex((p) => p.groupUid === groupUid);
    if (k < 0) return -1;
    if (ignoreFirstLine && this.positions[k].line <= 0) return -1;
    return k;
  }

  /** ReleaseGroup (371–378). */
  releaseGroup(groupUid: number): void {
    const k = this.findPositionOf(groupUid);
    if (k >= 0) this.positions[k].groupUid = 0;
  }

  /** ReleaseAllGroups (388–401): the groups of all positions, positions emptied. */
  releaseAllGroups(): number[] {
    const out: number[] = [];
    for (const p of this.positions) {
      if (p.groupUid !== 0) out.push(p.groupUid);
      p.groupUid = 0;
    }
    return out;
  }

  /** FindPlaceForGroup (291–350): the best accepting position (highest weight, first on a tie); a new
   *  position takes the whole group; a filled one takes as many members as it needs. */
  findPlaceForGroup(g: GroupState): boolean {
    const formation = this.formationOf(g.groupType);
    let bestIdx = -1;
    let bestWeight = 0;
    for (let k = 0; k < this.positions.length; k++) {
      const p = this.positions[k];
      if (this.canAccept(p, g) && bestWeight < p.weight) {
        bestIdx = k;
        bestWeight = p.weight;
      }
    }
    if (bestIdx < 0) return false;
    const p = this.positions[bestIdx];
    let ug: GroupState | null;
    if (p.groupUid === 0) {
      p.groupUid = g.uid;
      ug = g;
      this.world.orderGroup(g.uid, 'walk', p.loc.x, p.loc.y);
    } else {
      ug = this.liveGroup(p);
      if (ug === null) return false;
      const needed = formation.numUnits - ug.memberUids.length;
      moveGroupMembers(this.world, g, ug, g.memberUids.length <= needed ? g.memberUids.length : needed);
    }
    if (ug.unitsPerRow !== formation.unitsPerRow) ug.unitsPerRow = formation.unitsPerRow;
    return true;
  }

  /** UpdateDefences (421–474): keep the positions that still match, drop the others, add the new ones,
   *  recount the first line, and re-place the groups of the positions that are no longer full. */
  updateDefences(requests: DefencePositionRequest[]): void {
    if (requests.length === 0) return;
    const visitedNew = requests.map(() => false);
    const visitedExist = this.positions.map(() => false);
    for (let i = 0; i < requests.length; i++) {
      for (let k = 0; k < this.positions.length; k++) {
        if (!samePoint(this.positions[k].loc, requests[i].loc)) continue;
        visitedNew[i] = true;
        visitedExist[k] = true;
        this.positions[k].weight = requests[i].weight;
        this.positions[k].line = requests[i].line;
        break;
      }
    }
    for (let k = this.positions.length - 1; k >= 0; k--) if (!visitedExist[k]) this.positions.splice(k, 1);
    for (let i = 0; i < requests.length; i++) {
      if (visitedNew[i]) continue;
      const r = requests[i];
      this.positions.push({ loc: { x: r.loc.x, y: r.loc.y }, dir: r.dir, weight: r.weight, line: r.line, groupUid: 0 });
    }
    this.firstLineCnt = 0;
    for (let k = this.positions.length - 1; k >= 0; k--) {
      const p = this.positions[k];
      if (p.line <= 0) this.firstLineCnt += 1;
      const g = this.liveGroup(p);
      if (g !== null && g.memberUids.length < this.formationOf(g.groupType).numUnits) {
        p.groupUid = 0;
        this.findPlaceForGroup(g);
      }
    }
  }

  /** UpdateFixedDefences (477–499): the script's !SET_AI_DEFENSE list, all on the second line. */
  updateFixedDefences(): void {
    this.updateDefences(this.setup.defencePositions.map((d) => ({ loc: d.pos, dir: d.dir, weight: 1, line: 1 })));
  }

  /** TKMDefencePosition.UpdateState (176–192): release the dead/fighting/attacking groups, and walk an idle
   *  group to its position. */
  private updatePosition(p: DefencePosition): void {
    const w = this.world;
    let g = this.liveGroup(p);
    if (g === null || !groupCanTakePlayerOrders(w, g) || g.order === 'attackHouse' || g.order === 'attackUnit') {
      p.groupUid = 0;
      g = null;
    }
    if (g !== null && groupIsIdleToAI(w, g, ['halt']) && w.canWalkTo(g.orderX, g.orderY, p.loc.x, p.loc.y)) {
      w.orderGroup(g.uid, 'walk', p.loc.x, p.loc.y);
    }
  }

  /** UpdateState (508–522). */
  updateState(tick: number): void {
    if (tick % FAST_UPDATE !== this.owner) return;
    for (const p of this.positions) this.updatePosition(p);
    if (tick % SLOW_UPDATE === this.owner && !this.setup.autoDefend) this.updateFixedDefences();
  }
}

// ---------------------------------------------------------------------------------------------
// ArmyManagement

/** TKMArmyManagement (KM_ArmyManagement.pas 28–68): the army of one AI hand. */
export class ArmyManagement implements ArmySlot {
  readonly world: EconomyWorld;
  readonly ai: AiPlayer;
  readonly attack: ArmyAttackNew;
  readonly defence: ArmyDefence;
  attackRequest: AttackRequest = {
    active: false,
    foodShortage: false,
    ffa: false,
    bestAllianceCmp: 0,
    worstAllianceCmp: 0,
    bestEnemy: -1,
    enemies: [],
  };
  private lastEquippedIron = 0;
  private lastEquippedLeather = 0;
  private readonly foodProblems = false;

  constructor(world: EconomyWorld, ai: AiPlayer) {
    this.world = world;
    this.ai = ai;
    this.attack = new ArmyAttackNew(world, ai.hand);
    this.defence = new ArmyDefence(world, ai.hand, ai.setup);
  }

  get owner(): number {
    return this.ai.hand;
  }

  /** AfterMissionInit (173–178): both parts are empty at the start (no-op, as in the Pascal). */
  afterMissionInit(): void {}

  /** SetAttackRequest (533–543). */
  setAttackRequest(ar: AttackRequest): void {
    this.attackRequest = { ...ar, enemies: ar.enemies.slice() };
  }

  /** WarriorEquipped (189–196), called with the new warrior's group. */
  warriorEquipped(groupUid: number): void {
    const g = this.world.groupByUid(groupUid);
    if (g === null) return;
    if (this.defence.groupsCount() === 0 && this.attack.count > 0 && !this.foodProblems) this.attack.linkGroup(g.uid);
    const again = this.world.groupByUid(groupUid);
    if (again !== null && again.memberUids.length > 0) this.defence.findPlaceForGroup(again);
  }

  /** CanEquipIron / CanEquipLeather (200–209). */
  private canEquipIron(tick: number): boolean {
    const s = this.ai.setup;
    return s.armyType !== AT_LEATHER && (s.unlimitedEquip || tick >= this.lastEquippedIron + s.equipRateIron);
  }

  private canEquipLeather(tick: number): boolean {
    const s = this.ai.setup;
    return s.armyType !== AT_IRON && (s.unlimitedEquip || tick >= this.lastEquippedLeather + s.equipRateLeather);
  }

  /** RecruitSoldiers (199–287): the barracks equip the warriors the city's demands ask for. */
  private recruitSoldiers(tick: number): void {
    const w = this.world;
    const owner = this.owner;
    const setup = this.ai.setup;
    if (
      this.ai.predictor.isPeaceTime(tick) ||
      (setup.maxSoldiers !== -1 && w.handWarriorCount(owner) >= setup.maxSoldiers) ||
      (!this.canEquipIron(tick) && !this.canEquipLeather(tick)) ||
      w.handHouseCount(owner, HT_BARRACKS) === 0 ||
      this.defence.count === 0
    ) {
      return;
    }
    const demands = this.ai.cityManagement.warriorsDemands;
    // GroupReq[GT] = Σ (WarriorsDemands[ut] + 1) over the group's trainable types (always ≥ 1 per type).
    const groupReq = [0, 0, 0, 0, 0, 0];
    for (let gi = 0; gi < GROUP_TYPE_COUNT; gi++) {
      for (const ut of AI_TROOP_TRAIN_ORDER[gi]) {
        if (ut < 0) continue;
        groupReq[gi + GT_MELEE] += (demands[ut - UT_MILITIA] ?? 0) + 1;
      }
    }
    const barracks = w.houses.filter((h) => h.owner === owner && h.typeId === HT_BARRACKS && !h.destroyed && h.buildState === 'done');
    for (const b of barracks) {
      // A random group type, at most 10 draws (KaMRandom(4) + GROUP_TYPE_MIN_OFF; KM_ArmyManagement.pas 254–258).
      let gt = GT_MELEE;
      let draws = 0;
      do {
        gt = GT_MELEE + w.drawN(4);
        draws += 1;
      } while (!(groupReq[gt] > 0 || draws > 9));
      if (groupReq[gt] === 0) continue;
      for (const ut of AI_TROOP_TRAIN_ORDER[gt - GT_MELEE]) {
        if (ut < 0) continue;
        const iron = WARRIORS_IRON.has(ut);
        if (iron ? !this.canEquipIron(tick) : !this.canEquipLeather(tick)) continue;
        while (
          w.barracksCanEquip(b.uid, ut) &&
          groupReq[gt] > 0 &&
          (setup.maxSoldiers === -1 || w.handWarriorCount(owner) < setup.maxSoldiers)
        ) {
          const unit = w.barracksEquip(b.uid, ut);
          if (unit === null) break;
          groupReq[gt] -= 1;
          if (iron) this.lastEquippedIron = tick;
          else this.lastEquippedLeather = tick;
          this.warriorEquipped(unit.groupUid);
        }
      }
    }
  }

  /** CheckGroupsState (291–330): feed the idle groups into the attack or a defence position. */
  private checkGroupsState(tick: number): void {
    const w = this.world;
    for (const g of w.groupList().slice()) {
      if (g.owner !== this.owner || groupIsDead(g) || !groupCanTakePlayerOrders(w, g)) continue;
      if (this.isPeaceTime(tick)) continue;
      if (this.attack.isGroupInAction(g.uid)) continue;
      if (this.defence.findPositionOf(g.uid) >= 0) continue;
      if (this.defence.groupsCount() === 0 && this.attack.count > 0) this.attack.linkGroup(g.uid);
      const cur = w.groupByUid(g.uid);
      if (cur !== null && cur.memberUids.length > 0) this.defence.findPlaceForGroup(cur);
    }
  }

  private isPeaceTime(tick: number): boolean {
    return this.ai.predictor.isPeaceTime(tick);
  }

  /** GetGroups (342–387): the owner's groups available for the attack, with the Pascal's array layout
   *  (the counted groups first; later slots keep what the last scan wrote). */
  private getGroups(mobilization: number): AvailableGroups {
    const list = this.world.groupList().filter((g) => g.owner === this.owner);
    const arr: (GroupState | null)[] = list.map(() => null);
    let count = 0;
    for (const g of list) {
      if (groupIsDead(g) || (mobilization < 1 && g.memberUids.length < MIN_TROOPS_IN_GROUP)) continue;
      arr[count] = g;
      if (mobilization === 1) {
        if (!this.attack.isGroupInAction(g.uid)) count += 1;
      } else {
        const ignoreFirst = this.world.draw() < mobilization;
        if (this.defence.findPositionOf(g.uid, ignoreFirst) >= 0) count += 1;
      }
    }
    const groupsAvailable = [0, 0, 0, 0, 0, 0];
    const menAvailable = [0, 0, 0, 0, 0, 0];
    for (let k = 0; k < count; k++) {
      const g = arr[k];
      if (g === null) continue;
      groupsAvailable[g.groupType] += 1;
      menAvailable[g.groupType] += g.memberUids.length;
    }
    return { count, arr, groupsAvailable, menAvailable };
  }

  /** FilterGroups (389–426), with the Pascal's element bookkeeping. */
  private filterGroups(totalMen: number, groupAmounts: number[], ag: AvailableGroups): void {
    if (totalMen === 0) return;
    let startIdx = 0;
    let menCnt = 0;
    let actIdx = 0;
    for (let gi = 0; gi < GROUP_TYPE_COUNT; gi++) {
      const gt = GT_MELEE + gi;
      let gCnt = groupAmounts[gi] ?? 0;
      actIdx = startIdx;
      while (gCnt > 0 && actIdx < ag.count) {
        const cand = ag.arr[actIdx];
        if (cand !== null && cand.groupType === gt) {
          const first = ag.arr[startIdx];
          ag.arr[startIdx] = ag.arr[actIdx];
          ag.arr[actIdx] = first;
          const displaced = ag.arr[actIdx];
          menCnt += displaced !== null ? displaced.memberUids.length : 0;
          startIdx += 1;
          gCnt -= 1;
        }
        actIdx += 1;
      }
    }
    while (menCnt < totalMen && actIdx < ag.count) {
      const g = ag.arr[actIdx];
      menCnt += g !== null ? g.memberUids.length : 0;
      actIdx += 1;
    }
    ag.count = actIdx;
    ag.arr.length = actIdx;
  }

  /** CanOccur (KM_AIAttacks.pas 62–81). */
  private canOccur(attack: ScriptAttack, ag: AvailableGroups, tick: number): boolean {
    let totalMen = 0;
    for (let gi = 0; gi < GROUP_TYPE_COUNT; gi++) {
      if (attack.randomGroups || attack.groupAmounts[gi] > 0) totalMen += ag.menAvailable[GT_MELEE + gi];
    }
    let result = (attack.repeating || !attack.hasOccured) && tick >= attack.delay && totalMen >= attack.totalMen && totalMen > 0;
    if (!attack.randomGroups) {
      for (let gi = 0; gi < GROUP_TYPE_COUNT; gi++) result = result && ag.groupsAvailable[GT_MELEE + gi] >= attack.groupAmounts[gi];
    }
    return result;
  }

  /** FindScriptedTarget (428–459) for a script's TKMAIAttackTarget. */
  private findScriptedTarget(g: GroupState, attack: ScriptAttack): ArmyTarget | null {
    const w = this.world;
    const enemies = this.allEnemies();
    const pos = groupPosition(w, g);
    const closestUnit = (from: Pt): CombatUnit | null => {
      let best: CombatUnit | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const u of w.units) {
        if (u.dead || isDeadOrDying(u) || w.allianceOf(this.owner, u.owner) === 'ally') continue;
        const d = distanceSqr(from, w.posRound(u));
        if (d < bestD) {
          bestD = d;
          best = u;
        }
      }
      return best;
    };
    switch (attack.target) {
      case 0: {
        const u = closestUnit(pos);
        return u !== null ? { kind: 'unit', uid: u.uid, pos: w.posRound(u) } : null;
      }
      case 1:
      case 2: {
        const from = attack.target === 1 ? pos : this.ai.setup.startPosition;
        const h = nearestEnemyHouse(w, this.owner, enemies, from, TARGET_HOUSES);
        return h !== null ? { kind: 'house', uid: h.uid, pos: houseAim(h) } : null;
      }
      case 3: {
        const at = attack.customPosition;
        const house = w.houseAt(at.x, at.y);
        if (house !== null && w.allianceOf(this.owner, house.owner) === 'enemy') {
          const h = w.houseByUid(house.uid);
          if (h !== null) return { kind: 'house', uid: h.uid, pos: houseAim(h) };
        }
        for (const u of w.units) {
          if (u.dead || isDeadOrDying(u) || w.allianceOf(this.owner, u.owner) === 'ally') continue;
          const p = w.posRound(u);
          if (p.x === at.x && p.y === at.y) return { kind: 'unit', uid: u.uid, pos: p };
        }
        return { kind: 'point', uid: 0, pos: { x: at.x, y: at.y } };
      }
      default:
        return null;
    }
  }

  /** The hands the army attacks: the attack request's enemies (the Pascal's Enemies list). */
  private enemyHands(): number[] {
    return this.attackRequest.enemies.filter((h) => h !== this.owner);
  }

  /** Every hand this one is at war with (the scripted targets search the whole enemy side). */
  private allEnemies(): number[] {
    const out: number[] = [];
    for (let h = 0; h < this.world.handCount; h++) if (h !== this.owner && this.world.allianceOf(this.owner, h) === 'enemy') out.push(h);
    return out;
  }

  /** OrderAttack (462–471): the groups leave the defence and join the attack (with the target, when a
   *  scripted attack gives one). */
  private orderAttack(ag: AvailableGroups, target: ArmyTarget | null, tick: number): void {
    for (let k = 0; k < ag.count; k++) {
      const g = ag.arr[k];
      if (g !== null) this.defence.releaseGroup(g.uid);
    }
    const uids = ag.arr.map((g) => (g !== null ? g.uid : null));
    this.attack.addGroups(uids);
    if (target === null) return;
    for (let k = 0; k < ag.count; k++) {
      const g = ag.arr[k];
      const cg = g !== null ? this.attack.getCombatGroup(g.uid) : undefined;
      if (cg === undefined) continue;
      if (target.kind === 'house') setTargetHouse(this.world, cg, target.uid);
      else if (target.kind === 'unit') setTargetUnit(this.world, cg, target.uid);
      else setTargetPosition(this.world, cg, target.pos, 0, tick);
    }
  }

  /** CheckAttack (333–530): the attack request, or the scripted attacks of a non-auto hand. */
  private checkAttack(tick: number): void {
    const ar = this.attackRequest;
    if (ar.active) {
      ar.active = false;
      const defRatio = this.defence.defenceStatus();
      if (ar.ffa && !ar.foodShortage && defRatio < MIN_DEF_RATIO) return;
      let mobilization = 1;
      if (ar.ffa) {
        const relDef = Math.max(0, (defRatio - 1) / Math.max(1, defRatio));
        mobilization = Math.min(1, (1 + ATT_ADVANTAGE) / (1 + ar.bestAllianceCmp)) * (1 - relDef);
      }
      const ag = this.getGroups(mobilization);
      if (mobilization < 1 && ag.count < MIN_GROUPS_IN_ATTACK) return;
      this.orderAttack(ag, null, tick);
      return;
    }
    if (this.ai.setup.autoAttack) return;
    const ag = this.getGroups(1);
    for (const attack of this.ai.setup.attacks) {
      if (!this.canOccur(attack, ag, tick)) continue;
      this.filterGroups(attack.totalMen, attack.groupAmounts, ag);
      const first = ag.arr[0];
      if (first === null || first === undefined) continue;
      const target = this.findScriptedTarget(first, attack);
      if (target === null) continue;
      this.orderAttack(ag, target, tick);
      attack.hasOccured = true;
      break;
    }
  }

  /** UpdateState (546–568): every 27 ticks, the hand's own slot. */
  updateState(tick: number): void {
    if (tick % MAX_HANDS !== this.owner) return;
    if (!this.isPeaceTime(tick)) {
      this.checkAttack(tick);
      this.recruitSoldiers(tick);
    }
    this.checkGroupsState(tick);
    this.attack.updateState(tick, this.enemyHands());
    this.defence.updateState(tick);
  }
}

