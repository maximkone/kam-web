// combat.ts — M4 combat systems: warriors (melee + ranged), projectiles, unit groups, houses in
// combat, fog of war, notification stubs (docs/M4-SPIKE.md is the frozen contract).
//
// Tick order copied from KM_Game.PlayGameTick (game/KM_Game.pas 3031–3145) and KM_Hand.UpdateState
// (hands/KM_Hand.pas 2099–2135), wired by economy.ts:
//   IncTick → TakePlannedCommands → terrain → gAIFields → per hand [groups (mod 5 CheckForFight,
//   mod 7 CheckOrderDone, mod 10 hunger) → units descending → houses → FOW → logistics] →
//   gProjectiles.UpdateState (KM_Game.pas 3112) → RunningTimer RNG draw.
// Consequences (spec 2.1): melee kills land during the units pass (corpse removed a few ticks
// later when the die stay finishes, KM_UnitTaskDie.pas 59–116); arrow kills land after the units
// pass in the same tick; group orders land before member actions in the same tick (the group pass
// runs first and the warrior takes fNextOrder at the top of its own UpdateState); house destruction
// by arrow happens after that hand's house pass (in the projectiles pass).
//
// Per-warrior order (KM_UnitWarrior.UpdateState 1086–1127 — note the override runs its order
// taking and the mod 6 scan BEFORE the inherited common tick, i.e. before fAction.Execute; the
// spec 2.1 bullet lists the tail last, the code is the truth and is copied here):
//   IsDeadOrDying → inherited only; else UpdateOrderTargets → TakeNextOrder → mod 6 CheckForEnemy
//   (plus the AI-only CheckForEnemyPassingBy, skipped: all v0 hands are human) → common tick
//   (fKillASAP → fTicker++ → hunger every 10 → FOW INC every 10 → thoughts (none) → HP regen →
//   unwalkable kill (skipped, documented) → fAction.Execute → fTask.Execute) → if the action is
//   gone, SetActionStay(50).
//
// Deferred (documented drift, spec 2.4/§1): HungarianReorderMembers (KM_UnitGroup.pas 2071–2115) is
// NOT ported — it is deterministic but only changes which member walks to which formation slot, so
// member destinations after member reorder/formation changes can differ from the Pascal. Storm
// attack, tower rocks, split/link/formation orders, the worker repair task, sounds, and script
// events are out of v0.
//
// Headless approximations (flagged, spec has no frozen number for them):
//  - Projectile flight length is the flat start→target distance (the game's fLength includes screen
//    height and launch offsets, KM_Projectiles.pas 264–270) — flight ticks can differ by a few.
//  - MakeSound draws its KaMRandom(20) battle-cry roll always, then the game gates playback on the
//    spectator's FOW; headless there is no spectator, so playback is a no-op (the draw order, which
//    is the deterministic part, is copied).
//  - Vertex usage is the per-vertex orientation counter of KM_Terrain.pas 4301–4340 (vuNWSE/vuNESW),
//    shared by walking and fighting; the full walk-vs-fight compatibility matrix is not ported.
//  - The unwalkable-tile kill (KM_Units.pas 2618–2642) is skipped: v0 warriors only walk on tpWalk
//    routes and the check needs the mid-tile PositionNext bookkeeping.
//
// Browser-safe: no node: imports.
import type { UnitSpec } from '../assets/unitdat.ts';
import type { Walk } from './walk.ts';
import { delphiRound } from './walk.ts';

export interface Pt {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------------------------
// Frozen interfaces (docs/M4-SPIKE.md §3) + the internal state the systems need

/** The world's combat view of one unit (EconUnit is structurally assignable). */
export interface CombatUnit {
  uid: number;
  owner: number;
  type: number;
  posF: { x: number; y: number };
  dir: number;
  animStep: number;
  action?: 'stay' | 'walk'; // set by the host's action helpers
  hitPoints: number;
  groupUid: number;
  fightState: 'none' | 'fight' | 'die';
  dead: boolean;
}

/** The world's combat view of one house (EconHouse is structurally assignable). */
export interface CombatHouse {
  uid: number;
  typeId: number;
  owner: number;
  x: number;
  y: number;
  entrance: { x: number; y: number };
  maxHealth: number;
  damage: number;
  destroyed: boolean;
  fireLevel: number; // 0..8 — haFire1..haFire8 sub-actions (KM_Houses.pas 1348–1363)
}

export type WarriorOrder = 'none' | 'walk' | 'attackUnit' | 'attackHouse' | 'storm';

export type WarriorTask =
  | { kind: 'attackHouse'; phase: number; houseUid: number }
  | { kind: 'die'; phase: number; showAnimation: boolean };

/** Live per-warrior state; economy's UnitState embeds one of these per warrior. */
export interface WarriorState {
  ticker: number; // fTicker — starts at the unit UID (KM_Units.pas 1241)
  hitPointCounter: number; // fHitPointCounter — starts 1
  condition: number; // fCondition (hunger; drawn at spawn)
  stayActive: boolean; // a stay action is set (even a 0-tick one)
  stayLocked: boolean; // SetActionLockedStay vs SetActionStay
  stayStill: boolean; // the stay freezes the animation (SetActionStay default True)
  fightOpponentUid: number; // fOpponent (0 = none)
  fightDelay: number; // fFightDelay (−1 = uninitialized)
  fightVertex: Pt | null; // fVertexOccupied
  task: WarriorTask | null; // fTask
  order: WarriorOrder; // fOrder
  nextOrder: WarriorOrder; // fNextOrder
  nextOrderForced: boolean; // fNextOrderForced
  orderLoc: Pt; // fOrderLoc
  useExactTarget: boolean; // fUseExactTarget
  orderTargetUid: number; // fOrderTargetUnit (0 = none)
  orderTargetHouseUid: number; // fOrderTargetHouse (0 = none)
  attackingUid: number; // fAttackingUnit (0 = none)
  faceDir: number; // FaceDir (0 = dirNA)
  lastShootTime: number; // fLastShootTime (0 = never)
  killAsap: boolean; // fKillASAP
  killAsapShowAnimation: boolean;
  killedBy: number; // fKilledBy (hand id, −1 = HAND_NONE)
}

/** The live runtime of one unit (economy's UnitState is structurally assignable). */
export interface UnitRuntime {
  spec: UnitSpec;
  walk: Walk | null;
  actionLock: number;
  locked: boolean;
  warrior: WarriorState | null;
  task: unknown | null;
}

/** Frozen (docs/M4-SPIKE.md §3): one unit group. */
export interface SimGroup {
  uid: number;
  owner: number;
  memberUids: number[];
  groupType: number; // TKMGroupType: 2 melee, 3 antiHorse, 4 ranged, 5 mounted
  order: 'none' | 'walk' | 'attackUnit' | 'attackHouse' | 'halt';
  orderX: number;
  orderY: number;
  targetUid: number;
  targetHouseUid: number;
}

/** Internal group state (assignable to SimGroup). */
export interface GroupState extends SimGroup {
  ticker: number;
  offenders: number[]; // enemy warrior uids (fOffenders)
  unitsPerRow: number;
  orderDir: number; // fOrderLoc.Dir (0 = dirNA)
  orderWalkKind: 'none' | 'halt';
  targetGroupUid: number;
  targetFollowTicker: number;
  pushbackCommands: number;
  timeSinceHungryReminder: number;
  blockPlayerOrders: boolean;
  manualFormation: boolean;
  selectedUid: number; // UI only
}

/** Frozen (docs/M4-SPIKE.md §3): one projectile in flight. */
export interface SimProjectile {
  uid: number;
  kind: 'arrow' | 'bolt' | 'stone';
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  targetUid: number; // aimed-at unit (0 = none)
  targetHouseUid: number; // aimed-at house (0 = none)
  t: number; // fPosition along the route
  // Internal (the game's fItems record, KM_Projectiles.pas 14–29):
  ownerUid: number;
  speed: number;
  arc: number;
  length: number; // fLength
  maxLength: number; // fMaxLength
  aimX: number;
  aimY: number;
}

export type DamageSource = 'melee' | 'arrow' | 'script';

/** Everything the combat systems need from the world (EconomyWorld implements this). */
export interface CombatWorld {
  readonly tickCount: number;
  readonly mapX: number;
  readonly mapY: number;
  readonly handCount: number;

  // RNG (the world's single KaMRandom stream)
  draw(): number;
  drawN(max: number): number;
  drawS1(max: number): number;
  drawS2(range: number): number;

  // Terrain / routing
  tileWalkable(x: number, y: number): boolean;
  tileInMapCoords(x: number, y: number): boolean;
  canWalkDiagonal(fromX: number, fromY: number, x: number, y: number): boolean;
  walkConnectId(x: number, y: number): number;
  closestTile(x: number, y: number, fromX: number, fromY: number, exact: boolean): Pt;
  findRoute(fromX: number, fromY: number, toX: number, toY: number): Pt[] | null;

  // Units
  unitCount(): number;
  unitAt(index: number): CombatUnit;
  unitByUid(uid: number): CombatUnit | null;
  unitRuntime(u: CombatUnit): UnitRuntime;
  specOfType(type: number): UnitSpec;
  posFPoint(u: CombatUnit): Pt;
  posRound(u: CombatUnit): Pt;
  posNext(u: CombatUnit): Pt;
  posPrev(u: CombatUnit): Pt;
  movementVector(u: CombatUnit): Pt;
  unitAtTile(x: number, y: number): CombatUnit | null;
  unitAtTileF(x: number, y: number): CombatUnit | null;
  allianceOf(a: number, b: number): 'ally' | 'enemy';
  isVisible(u: CombatUnit): boolean;
  spawnUnit(owner: number, type: number, x: number, y: number, dir: number): CombatUnit;
  closeUnit(u: CombatUnit): void;

  // Groups
  groupList(): GroupState[];
  groupByUid(uid: number): GroupState | null;
  newGroup(owner: number, groupType: number, x: number, y: number, dir: number, unitsPerRow: number): GroupState;

  // Projectiles
  projectileList(): SimProjectile[];
  nextProjectileUid(): number;
  addProjectile(p: SimProjectile): void;
  compactProjectiles(): void;

  warriorState(u: CombatUnit): WarriorState | null;
  startWalkTo(u: CombatUnit, x: number, y: number): boolean;
  abandonWalk(u: CombatUnit): void;
  setStay(u: CombatUnit, ticks: number, locked: boolean, still: boolean, step: number): void;
  clearStay(u: CombatUnit): void;
  setFightState(u: CombatUnit, s: 'none' | 'fight' | 'die'): void;
  damageUnit(u: CombatUnit, amount: number, attackerUid: number, source: DamageSource): void;
  killUnit(u: CombatUnit, fromOwner: number, showAnim: boolean, forceDelay: boolean): void;

  // Houses
  houseAt(x: number, y: number): CombatHouse | null;
  houseByUid(uid: number): CombatHouse | null;
  houseDistance(h: CombatHouse, x: number, y: number): number;
  houseClosestCell(h: CombatHouse, x: number, y: number): Pt;
  houseCells(h: CombatHouse): Pt[];
  houseAddDamage(h: CombatHouse, amount: number, attackerUid: number): void;

  // FOW / vertices
  fog(hand: number): FogOfWar;
  vertexUsageCompatible(fromX: number, fromY: number, x: number, y: number): boolean;
  vertexAdd(fromX: number, fromY: number, x: number, y: number): void;
  vertexRemove(x: number, y: number): void;

  // Notification stubs (M4: no-op bodies; M5 wires the AI)
  unitAttackNotification(unitUid: number, attackerUid: number, isDefender: boolean): void;
  unitHPDecreaseNotification(unitUid: number, attackerUid: number): void;
  houseAttackNotification(houseUid: number, attackerUid: number): void;

  // Telemetry (CLI frozen numbers; not game events)
  emit(kind: string, detail: string): void;
}

// ---------------------------------------------------------------------------------------------
// Constants (KM_Defaults.pas, KM_ResUnits.pas, KM_Projectiles.pas)

export const FOG_OF_WAR_MIN = 80; // KM_Defaults.pas 531
export const FOG_OF_WAR_ACT = 160; // 532
export const FOG_OF_WAR_MAX = 255; // 533
export const FOG_OF_WAR_INC = 128; // 534
export const FOG_OF_WAR_DEC = 12; // 535
export const FOW_PACE = 10; // 18
export const RENDER_RADIUS_ADD = 5; // KM_FogOfWar.pas 111

export const MELEE_STRIKE_STEP = 5; // KM_UnitActionFight.pas 50
export const MELEE_PAUSE_STEPS = [0, 3, 6]; // 309

export const RANGE_MIN = 4; // KM_UnitWarrior.pas 837–839 (all three shooters)
export const RANGE_MAX = 10.99; // 855–857
export const MELEE_FIGHT_MIN = 0.5; // 437
export const MELEE_FIGHT_MAX = 1.42; // 424 (tile-based: 1)

export const BOWMAN_AIMING_MIN = 6; // KM_UnitWarrior.pas 790–795
export const BOWMAN_AIMING_ADD = 6;
export const CROSSBOWMAN_AIMING_MIN = 8;
export const CROSSBOWMAN_AIMING_ADD = 8;
export const ROGUE_AIMING_MIN = 0;
export const ROGUE_AIMING_ADD = 4;
export const ROGUE_FIRING_DELAY = 15; // 774
export const ROGUE_AIM_SOUND_DELAY = 2; // 811

// PROJECTILE_SPEED / _ARC / _JITTER / _JITTER_HOUSE / _PREDICT_JITTER (KM_Projectiles.pas 70–75),
// indexed arrow (ptArrow), bolt (ptBolt), stone (ptSlingRock).
export const PROJECTILE_SPEED = [0.75, 0.75, 0.6];
export const PROJECTILE_ARC = [
  [1.6, 0.5],
  [1.4, 0.4],
  [2.5, 1],
];
export const PROJECTILE_JITTER = [0.26, 0.29, 0.26];
export const PROJECTILE_JITTER_HOUSE = [0.6, 0.6, 0.6];
export const PROJECTILE_PREDICT_JITTER = [2, 2, 2];
export const H_TICKS = 6; // KM_Projectiles.pas 283 (hit-sound window; sound is a no-op headless)

export const HITPOINT_RESTORE_PACE = 100; // KM_Defaults.pas 360
export const UNIT_MAX_CONDITION = 45 * 60; // 371
export const UNIT_MIN_CONDITION = 6 * 60; // 372
export const UNIT_CONDITION_PACE = 10; // 369
export const UNIT_CONDITION_BASE = 0.6; // 374
export const UNIT_CONDITION_RANDOM = 0.1; // 375
export const TIME_BETWEEN_MESSAGES = 30000; // KM_Defaults.pas (hunger reminder pace)

// UNIT_TO_GROUP_TYPE (KM_Defaults.pas 685–698): records 14..27.
export const GT_MELEE = 2;
export const GT_ANTI_HORSE = 3;
export const GT_RANGED = 4;
export const GT_MOUNTED = 5;
const GROUP_TYPE_BY_RECORD: number[] = (() => {
  const t = new Array<number>(28).fill(GT_MELEE);
  t[17] = GT_RANGED;
  t[18] = GT_RANGED;
  t[19] = GT_ANTI_HORSE;
  t[20] = GT_ANTI_HORSE;
  t[21] = GT_MOUNTED;
  t[22] = GT_MOUNTED;
  t[24] = GT_ANTI_HORSE;
  t[25] = GT_RANGED;
  t[27] = GT_MOUNTED;
  return t;
})();

export function groupTypeOf(record: number): number {
  return GROUP_TYPE_BY_RECORD[record] ?? GT_MELEE;
}

// GetDefenceVsProjectiles (KM_ResUnits.pas 258–272): shielded records get a bonus.
const SHIELDED_RECORDS = new Set([15, 16, 21, 22]); // utAxeFighter, utSwordFighter, utScout, utKnight
export function defenceVsProjectiles(spec: UnitSpec, isBolt: boolean): number {
  let d = spec.defence ?? 0;
  if (SHIELDED_RECORDS.has(spec.record ?? -1)) d += isBolt ? 0.5 : 1;
  return d;
}

function recordOf(spec: UnitSpec): number {
  return spec.record ?? -1;
}

export function isWarriorSpec(spec: UnitSpec): boolean {
  return spec.isWarrior === true;
}

export function isRangedSpec(spec: UnitSpec): boolean {
  return spec.fightType === 'ranged';
}

export function fightRangeMin(spec: UnitSpec): number {
  return isRangedSpec(spec) ? RANGE_MIN : MELEE_FIGHT_MIN;
}

export function fightRangeMax(spec: UnitSpec, tileBased: boolean): number {
  if (isRangedSpec(spec)) return RANGE_MAX;
  return tileBased ? 1 : MELEE_FIGHT_MAX;
}

export function projectileKindOf(spec: UnitSpec): 'arrow' | 'bolt' | 'stone' {
  const r = recordOf(spec);
  if (r === 18) return 'bolt';
  if (r === 25) return 'stone';
  return 'arrow';
}

export function firingDelayOf(spec: UnitSpec): number {
  return recordOf(spec) === 25 ? ROGUE_FIRING_DELAY : 0;
}

export function aimSoundDelayOf(spec: UnitSpec): number {
  return recordOf(spec) === 25 ? ROGUE_AIM_SOUND_DELAY : 0;
}

/** GetAimingDelay (KM_UnitWarrior.pas 788–806): one KaMRandom draw for the random component. */
export function aimingDelayOf(spec: UnitSpec, drawN: (max: number) => number): number {
  const r = recordOf(spec);
  if (r === 17) return BOWMAN_AIMING_MIN + drawN(BOWMAN_AIMING_ADD);
  if (r === 18) return CROSSBOWMAN_AIMING_MIN + drawN(CROSSBOWMAN_AIMING_ADD);
  if (r === 25) return ROGUE_AIMING_MIN + drawN(ROGUE_AIMING_ADD);
  return 0;
}

/** GetDirModifier (KM_Points.pas 874–880): 0 = facing, 4 = attacked from behind. */
export function getDirModifier(dir1: number, dir2: number): number {
  let result = Math.abs(dir1 - ((dir2 + 4) % 8));
  if (result > 4) result = 8 - result;
  return result;
}

/** KMGetVertex (KM_Points.pas 900–906): direction → unit vector (float). */
const VERTEX_X = [0, 0, 0.7, 1, 0.7, 0, -0.7, -1, -0.7];
const VERTEX_Y = [0, -1, -0.7, 0, 0.7, 1, 0.7, 0, -0.7];
export function kmGetVertex(dir: number): Pt {
  return { x: VERTEX_X[dir] ?? 0, y: VERTEX_Y[dir] ?? 0 };
}

/** DIAG_DIRECTION (KM_Points.pas 244): dirNE/dirSE/dirSW/dirNW are diagonal. */
export function isDiagDir(dir: number): boolean {
  return dir === 2 || dir === 4 || dir === 6 || dir === 8;
}

export function samePoint(a: Pt, b: Pt): boolean {
  return a.x === b.x && a.y === b.y;
}

export function kmStepIsDiag(a: Pt, b: Pt): boolean {
  return b.x - a.x !== 0 && b.y - a.y !== 0;
}

export function kmStepIsDiagAdjust(a: Pt, b: Pt): boolean {
  return Math.abs(b.x - a.x) === 1 && Math.abs(b.y - a.y) === 1;
}

/** KMGetDiagVertex (KM_Points.pas 961–966). */
export function getDiagVertex(a: Pt, b: Pt): Pt {
  return { x: Math.max(a.x, b.x), y: Math.max(a.y, b.y) };
}

export function length(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function lengthSqr(a: Pt, b: Pt): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function inRange(v: number, lo: number, hi: number): boolean {
  return v >= lo && v <= hi;
}

/** GetPositionInGroup2 (utils/KM_CommonUtils.pas 618–646): formation slot, Delphi Round. */
export function getPositionInGroup2(
  originX: number,
  originY: number,
  dir: number,
  index: number,
  unitsPerRow: number,
  mapX: number,
  mapY: number,
): { x: number; y: number; fits: boolean } {
  const DirAngle = [0, 0, 45, 90, 135, 180, 225, 270, 315];
  const DirRatio = [0, 1, 1.41, 1, 1.41, 1, 1.41, 1, 1.41];
  let resultX: number;
  let resultY: number;
  if (index === 0) {
    resultX = originX;
    resultY = originY;
  } else {
    let i = index;
    if (i <= Math.floor(unitsPerRow / 2)) i -= 1;
    const placeX = (i % unitsPerRow) - Math.floor(unitsPerRow / 2);
    const placeY = Math.floor(i / unitsPerRow);
    const rad = (DirAngle[dir] / 180) * Math.PI;
    resultX = originX + delphiRound(placeX * DirRatio[dir] * Math.cos(rad) - placeY * DirRatio[dir] * Math.sin(rad));
    resultY = originY + delphiRound(placeX * DirRatio[dir] * Math.sin(rad) + placeY * DirRatio[dir] * Math.cos(rad));
  }
  const fits = resultX >= 1 && resultX <= mapX - 1 && resultY >= 1 && resultY <= mapY - 1;
  return { x: Math.min(Math.max(resultX, 1), mapX - 1), y: Math.min(Math.max(resultY, 1), mapY - 1), fits };
}

/** GetPositionFromIndex (utils/KM_CommonUtils.pas 650–689): ring-walk tiles around a point. */
export function getPositionFromIndex(origin: Pt, index: number): Pt {
  const Rings = [0, 1, 9, 25, 49, 81, 121, 169, 225, 289];
  if (index === 0) return { x: origin.x, y: origin.y };
  let ring = 0;
  do {
    ring += 1;
  } while (Rings[ring] <= index && ring < 10);
  ring -= 1;
  const span = ring * 2 - 2;
  const span2 = ring - 1;
  let orig = index - Rings[ring];
  const off1 = Math.min(orig, span2);
  orig -= off1;
  const off2 = Math.min(orig, span);
  orig -= off2;
  const off3 = Math.min(orig, span);
  orig -= off3;
  const off4 = Math.min(orig, span);
  orig -= off4;
  const off5 = Math.min(orig, span2 - 1);
  return { x: origin.x + off1 - off3 + off5, y: origin.y - span2 + off2 - off4 };
}

// ---------------------------------------------------------------------------------------------
// Fog of war (game/KM_FogOfWar.pas; the sim-mandatory parts, docs/M4-SPIKE.md 2.6)

/**
 * Per-hand FOW: vertex-based byte arrays over a mapX×mapY vertex grid (0-based), Revelation 0..255.
 * Frozen API (spec §3). The sim runs with dynamic FOW (decay on, INC pulses).
 */
export class FogOfWar {
  readonly revelation: Uint8Array;
  readonly renderRevelation: Uint8Array;
  private readonly revealedToMax: Uint8Array;
  private readonly mapX: number;
  private readonly mapY: number;
  private dynamic = true; // the sim runs with DynamicFOW; updateState refreshes it
  private coverCalled = false;

  constructor(mapX: number, mapY: number) {
    this.mapX = mapX;
    this.mapY = mapY;
    this.revelation = new Uint8Array(mapX * mapY);
    this.renderRevelation = new Uint8Array(mapX * mapY);
    this.revealedToMax = new Uint8Array(mapX * mapY);
  }

  /**
   * RevealCircle (KM_FogOfWar.pas 148–229). `max` = FOG_OF_WAR_MAX (one-shot) vs FOG_OF_WAR_INC.
   * `x`/`y` are tile coordinates (the game passes TKMPoint tile positions into the vertex arrays).
   */
  reveal(x: number, y: number, radius: number, max: boolean): void {
    const amount = max ? FOG_OF_WAR_MAX : FOG_OF_WAR_INC;
    this.revealFor(this.revelation, x, y, radius, amount, true);
    this.revealFor(this.renderRevelation, x, y, radius + RENDER_RADIUS_ADD, FOG_OF_WAR_MAX, false);
  }

  /** CoverCircle (232–274): revelation radius r, render radius r − 5. */
  cover(x: number, y: number, radius: number): void {
    this.coverFor(this.revelation, x, y, radius);
    this.coverFor(this.renderRevelation, x, y, Math.max(0, radius - RENDER_RADIUS_ADD));
    this.coverCalled = true;
  }

  /**
   * UpdateState (554–594): decay every tile once per FOW_PACE. `tick` is the game tick; the game's
   * fAnimStep increments per call, which equals the tick when called once per tick per hand.
   */
  updateState(dynamic: boolean, tick: number): void {
    this.dynamic = dynamic;
    if (!dynamic) return;
    for (let i = 0; i < this.mapY; i++) {
      for (let k = 0; k < this.mapX; k++) {
        if ((i * this.mapX + k + tick) % FOW_PACE !== 0) continue;
        const at = i * this.mapX + k;
        if (this.revelation[at] > FOG_OF_WAR_MAX - FOG_OF_WAR_DEC) {
          if (this.revealedToMax[at] === 0) {
            this.revelation[at] = Math.max(0, this.revelation[at] - FOG_OF_WAR_DEC);
          } else {
            this.revealedToMax[at] = 0;
          }
        } else {
          this.revelation[at] = Math.max(0, this.revelation[at] - FOG_OF_WAR_DEC);
        }
      }
    }
  }

  /** CheckVerticeRevelation (402–405 + 382–399): dynamic ≥ ACT → 255 else (F shl 8) div ACT. */
  checkVerticeRev(x: number, y: number): number {
    if (x < 0 || x >= this.mapX || y < 0 || y >= this.mapY) return 0;
    const f = this.revelation[y * this.mapX + x];
    if (this.dynamic) {
      if (f >= FOG_OF_WAR_ACT) return 255;
      return Math.floor((f * 256) / FOG_OF_WAR_ACT); // (F shl 8) div FOG_OF_WAR_ACT
    }
    return f >= FOG_OF_WAR_MIN ? 255 : 0;
  }

  /** CheckTileRevelation (414–417 + 457–474): max of the tile's four vertices (1..N tile coords). */
  checkTileRev(x: number, y: number): number {
    if (x <= 0 || x >= this.mapX || y <= 0 || y >= this.mapY) return 0;
    let result = this.checkVerticeRev(x - 1, y - 1);
    if (result === 255) return 255;
    result = Math.max(result, this.checkVerticeRev(x, y - 1));
    if (result === 255) return 255;
    result = Math.max(result, this.checkVerticeRev(x, y));
    if (result === 255) return 255;
    return Math.max(result, this.checkVerticeRev(x - 1, y));
  }

  private revealFor(arr: Uint8Array, x: number, y: number, radius: number, amount: number, forRevelation: boolean): void {
    const i1 = Math.max(y - radius, 0);
    const i2 = Math.min(y + radius, this.mapY - 1);
    const k1 = Math.max(x - radius, 0);
    const k2 = Math.min(x + radius, this.mapX - 1);
    const sqrRadius = radius * radius;
    for (let i = i1; i <= i2; i++) {
      const sqrI = (y - i) * (y - i);
      for (let k = k1; k <= k2; k++) {
        if ((x - k) * (x - k) + sqrI > sqrRadius) continue;
        const at = i * this.mapX + k;
        if (amount >= FOG_OF_WAR_MAX) {
          arr[at] = FOG_OF_WAR_MAX;
          if (forRevelation) this.revealedToMax[at] = 1;
        } else {
          arr[at] = Math.min(arr[at] + amount, FOG_OF_WAR_MAX);
          if (forRevelation && arr[at] === FOG_OF_WAR_MAX) this.revealedToMax[at] = 1;
        }
      }
    }
  }

  private coverFor(arr: Uint8Array, x: number, y: number, radius: number): void {
    const i1 = Math.max(y - radius, 0);
    const i2 = Math.min(y + radius, this.mapY - 1);
    const k1 = Math.max(x - radius, 0);
    const k2 = Math.min(x + radius, this.mapX - 1);
    const sqrRadius = radius * radius;
    for (let i = i1; i <= i2; i++) {
      for (let k = k1; k <= k2; k++) {
        if ((x - k) * (x - k) + (y - i) * (y - i) <= sqrRadius) arr[i * this.mapX + k] = 0;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Enemy scan (KM_Terrain.UnitsHitTestWithinRad 1913–2102) — includes FOW gate #1

function unitSpec(w: CombatWorld, u: CombatUnit): UnitSpec {
  return w.unitRuntime(u).spec;
}

export function isDeadOrDying(u: CombatUnit): boolean {
  return u.dead || u.fightState === 'die';
}

/** CheckVertex (KM_Terrain.pas 1953–1989): diagonal walkability + vertex usage compatibility. */
function checkVertex(w: CombatWorld, loc: Pt, posRound: Pt, posNext: Pt): boolean {
  let result =
    w.canWalkDiagonal(loc.x, loc.y, posNext.x, posNext.y) &&
    (Math.abs(loc.x - posNext.x) !== 1 ||
      Math.abs(loc.y - posNext.y) !== 1 ||
      w.vertexUsageCompatible(loc.x, loc.y, posNext.x, posNext.y));
  result =
    result &&
    (samePoint(posRound, posNext) ||
      !kmStepIsDiagAdjust(loc, posRound) ||
      (w.canWalkDiagonal(loc.x, loc.y, posRound.x, posRound.y) &&
        w.vertexUsageCompatible(loc.x, loc.y, posRound.x, posRound.y)));
  return result;
}

/**
 * UnitsHitTestWithinRad (KM_Terrain.pas 1913–2102): closest (or random warrior/citizen) enemy
 * within [minRad, maxRad] of aLoc, in the optional 90° sector for ranged units. The FOW gate
 * (line 2049) skips candidates whose tile revelation is not 255 for the scanning hand — this is
 * mandatory for fidelity (spec 2.6) and applies to archer and tower targeting alike.
 */
export function unitsHitTestWithinRad(
  w: CombatWorld,
  loc: Pt,
  minRad: number,
  maxRad: number,
  player: number,
  alliance: 'enemy' | 'ally',
  dir: number,
  chooseRandom: boolean,
  testDiagWalkable = true,
): CombatUnit | null {
  const warriors: CombatUnit[] = [];
  const citizens: CombatUnit[] = [];

  // Get90DegreeSectorRect (1930–1951), clipped to the map.
  const intRadius = delphiRound(maxRad + 1);
  let left: number;
  let right: number;
  let top: number;
  let bottom: number;
  if (dir === 2 || dir === 3 || dir === 4) left = loc.x + 1;
  else left = loc.x - intRadius;
  if (dir === 8 || dir === 7 || dir === 6) right = loc.x - 1;
  else right = loc.x + intRadius;
  if (dir === 4 || dir === 5 || dir === 6) top = loc.y + 1;
  else top = loc.y - intRadius;
  if (dir === 2 || dir === 1 || dir === 8) bottom = loc.y - 1;
  else bottom = loc.y + intRadius;
  left = Math.max(left, 1);
  right = Math.min(right, w.mapX);
  top = Math.max(top, 1);
  bottom = Math.min(bottom, w.mapY);

  for (let i = top; i <= bottom; i++) {
    for (let k = left; k <= right; k++) {
      const u = w.unitAtTile(k, i);
      if (u === null) continue;

      // Archer sector (2024–2033).
      const dX = k - loc.x;
      const dY = i - loc.y;
      switch (dir) {
        case 1:
          if (!(Math.abs(dX) <= -dY && dY < 0)) continue;
          break;
        case 2:
          if (!(dX > 0 && dY < 0)) continue;
          break;
        case 3:
          if (!(dX > 0 && Math.abs(dY) <= dX)) continue;
          break;
        case 4:
          if (!(dX > 0 && dY > 0)) continue;
          break;
        case 5:
          if (!(Math.abs(dX) <= dY && dY > 0)) continue;
          break;
        case 6:
          if (!(dX < 0 && dY > 0)) continue;
          break;
        case 7:
          if (!(dX < 0 && Math.abs(dY) <= -dX)) continue;
          break;
        case 8:
          if (!(dX < 0 && dY < 0)) continue;
          break;
        default:
          break; // dirNA: no sector filter
      }

      if (isDeadOrDying(u) || w.allianceOf(player, u.owner) !== alliance || !w.isVisible(u)) continue;

      const first = warriors.length > 0 ? warriors[0] : null;
      if (!chooseRandom && first !== null && lengthSqr(loc, { x: k, y: i }) >= lengthSqr(loc, w.posRound(first))) continue;

      // The mandatory FOW gate (2046–2049).
      if (w.fog(player).checkTileRev(k, i) !== 255) continue;

      const posNext = w.posNext(u);
      let requiredMaxRad = maxRad;
      if (maxRad === 1 && kmStepIsDiag(loc, posNext)) requiredMaxRad = 1.42;
      const posRound = w.posRound(u);
      if (
        (!testDiagWalkable || checkVertex(w, loc, posRound, posNext)) &&
        inRange(length(loc, u.posF), minRad, requiredMaxRad)
      ) {
        const spec = unitSpec(w, u);
        if (chooseRandom) {
          if (isWarriorSpec(spec)) warriors.push(u);
          else citizens.push(u);
        } else if (isWarriorSpec(spec)) {
          warriors[0] = u;
        } else {
          citizens[0] = u;
        }
      }
    }
  }

  if (chooseRandom) {
    if (warriors.length > 0) return warriors[w.drawN(warriors.length)];
    if (citizens.length > 0) return citizens[w.drawN(citizens.length)];
    return null;
  }
  return warriors[0] ?? citizens[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Projectiles (KM_Projectiles.pas 94–341) — the pass after gHands (KM_Game.pas 3112)

/** The canonical shooter attack values the projectile damage uses (KM_Projectiles.pas 316–318). */
function shooterAttack(w: CombatWorld, kind: 'arrow' | 'bolt' | 'stone'): number {
  const record = kind === 'arrow' ? 17 : kind === 'bolt' ? 18 : 25;
  return w.specOfType(record).attack ?? 0;
}

/**
 * AimTargetUnit (KM_Projectiles.pas 94–191): predict the target's position, draw speed + 2× jitter +
 * arc (in this exact order), clamp to the shooter's range, retarget allied blockers, add the item,
 * then UnitAttackNotification (stub, line 188). Returns the flight length in ticks (0 = no shot).
 */
export function aimTargetUnit(
  w: CombatWorld,
  shooter: CombatUnit,
  target: CombatUnit,
  kind: 'arrow' | 'bolt' | 'stone',
  maxRange: number,
  minRange: number,
): number {
  const kindIndex = kind === 'arrow' ? 0 : kind === 'bolt' ? 1 : 2;
  const start = w.posFPoint(shooter);
  const targetPosition = { x: target.posF.x - start.x, y: target.posF.y - start.y };
  const targetVector = w.movementVector(target);

  const speed = PROJECTILE_SPEED[kindIndex] + w.drawS2(0.05);

  const A = targetVector.x * targetVector.x + targetVector.y * targetVector.y - speed * speed;
  const B = 2 * (targetPosition.x * targetVector.x + targetPosition.y * targetVector.y);
  const C = targetPosition.x * targetPosition.x + targetPosition.y * targetPosition.y;
  const D = B * B - 4 * A * C;

  let timeToHit = 0;
  if (D >= 0 && A !== 0) {
    const time1 = (-B + Math.sqrt(D)) / (2 * A);
    const time2 = (-B - Math.sqrt(D)) / (2 * A);
    if (time1 > 0 && time2 > 0) timeToHit = Math.min(time1, time2);
    else if (time1 < 0 && time2 < 0) timeToHit = 0;
    else timeToHit = Math.max(time1, time2);
  }

  if (timeToHit === 0) return 0;

  const jitter = PROJECTILE_JITTER[kindIndex] + length({ x: 0, y: 0 }, targetVector) * PROJECTILE_PREDICT_JITTER[kindIndex];
  let tx = targetPosition.x + targetVector.x * timeToHit + w.drawS2(jitter);
  let ty = targetPosition.y + targetVector.y * timeToHit + w.drawS2(jitter);

  const distanceToHit = Math.sqrt(tx * tx + ty * ty);
  const distanceInRange = Math.min(Math.max(distanceToHit, minRange), maxRange);
  tx = start.x + (tx / distanceToHit) * distanceInRange;
  ty = start.y + (ty / distanceToHit) * distanceInRange;

  const arc =
    ((distanceInRange - minRange) / (maxRange - minRange)) *
    (PROJECTILE_ARC[kindIndex][0] + w.drawS2(PROJECTILE_ARC[kindIndex][1]));

  // Friendly unit at the predicted tile: shoot at the target's current position instead (178–183).
  if (w.tileInMapCoords(delphiRound(tx), delphiRound(ty))) {
    const u = w.unitAtTileF(delphiRound(tx), delphiRound(ty));
    if (u !== null && w.allianceOf(shooter.owner, u.owner) === 'ally') {
      tx = target.posF.x;
      ty = target.posF.y;
    }
  }

  const flight = addProjectile(
    w,
    start,
    { x: target.posF.x, y: target.posF.y },
    { x: tx, y: ty },
    speed,
    arc,
    maxRange,
    kind,
    shooter,
    target.uid,
    0,
  );
  w.unitAttackNotification(target.uid, shooter.uid, true); // arrows are in the air (188)
  return flight;
}

/** AimTargetHouse (194–214): random cell + jitter, arc draw, AddItem. */
export function aimTargetHouse(
  w: CombatWorld,
  shooter: CombatUnit,
  house: CombatHouse,
  kind: 'arrow' | 'bolt' | 'stone',
  maxRange: number,
  minRange: number,
): number {
  const kindIndex = kind === 'arrow' ? 0 : kind === 'bolt' ? 1 : 2;
  const start = w.posFPoint(shooter);
  const speed = PROJECTILE_SPEED[kindIndex] + w.drawS2(0.05);

  const aim = randomCellWithin(w, house);
  const tx = aim.x + w.drawS2(PROJECTILE_JITTER_HOUSE[kindIndex]);
  const ty = aim.y + w.drawS2(PROJECTILE_JITTER_HOUSE[kindIndex]);

  const distanceToHit = length(start, { x: tx, y: ty });
  const distanceInRange = Math.min(Math.max(distanceToHit, minRange), maxRange);
  const arcRandom = w.drawS2(PROJECTILE_ARC[kindIndex][1]);
  const arc = Math.max(
    ((distanceInRange - minRange) / (maxRange - minRange)) * PROJECTILE_ARC[kindIndex][0] + arcRandom,
    0,
  );
  return addProjectile(w, start, aim, { x: tx, y: ty }, speed, arc, maxRange, kind, shooter, 0, house.uid);
}

/** GetRandomCellWithin (KM_Houses.pas 1146–1156): TKMPointList.GetRandom. */
function randomCellWithin(w: CombatWorld, house: CombatHouse): Pt {
  const cells = w.houseCells(house);
  return cells[w.drawN(cells.length)];
}

/** AddItem (218–277): append the item; returns Round(fLength / fSpeed). */
function addProjectile(
  w: CombatWorld,
  start: Pt,
  aim: Pt,
  target: Pt,
  speed: number,
  arc: number,
  maxLength: number,
  kind: 'arrow' | 'bolt' | 'stone',
  owner: CombatUnit,
  targetUid: number,
  targetHouseUid: number,
): number {
  const endX = Math.min(Math.max(target.x, 0), w.mapX - 0.01);
  const endY = Math.min(Math.max(target.y, 0), w.mapY - 0.01);
  const lengthFlat = length(start, { x: endX, y: endY }); // flat: screen height/offsets are render-only
  w.addProjectile({
    uid: w.nextProjectileUid(),
    kind,
    fromX: start.x,
    fromY: start.y,
    toX: endX,
    toY: endY,
    targetUid,
    targetHouseUid,
    t: 0,
    ownerUid: owner.uid,
    speed,
    arc,
    length: lengthFlat,
    maxLength,
    aimX: aim.x,
    aimY: aim.y,
  });
  return delphiRound(lengthFlat / speed);
}

/**
 * UpdateState (281–341): advance every projectile, resolve the hit at the target tile — arrows skip
 * animals, arrow vs house = 1 HP, damage rolls draw in the game's order (miss roll, then the 101
 * roll only when the target is an enemy).
 */
export function updateProjectiles(w: CombatWorld): void {
  const list = w.projectileList();
  for (const p of list) {
    if (p.t < 0) continue; // resolved
    p.t += p.speed;
    if (p.t < p.length) continue;

    const u = w.unitAtTileF(p.toX, p.toY);
    // "U = nil" or the distance-dependent miss roll (304–306); the roll is drawn only when U != nil.
    const resolved = u === null || 1 - Math.min(length(u.posF, { x: p.toX, y: p.toY }), 1) > w.draw();
    if (resolved) {
      const owner = w.unitByUid(p.ownerUid);
      const canHit =
        u !== null &&
        owner !== null &&
        !isDeadOrDying(u) &&
        w.isVisible(u) &&
        !isAnimalRecord(u.type) && // arrows skip animals (311, 333)
        lengthSqr({ x: p.fromX, y: p.fromY }, u.posF) <= p.maxLength * p.maxLength;
      if (canHit) {
        const targetSpec = unitSpec(w, u as CombatUnit);
        let damage = shooterAttack(w, p.kind);
        damage = delphiRound(damage / Math.max(defenceVsProjectiles(targetSpec, p.kind === 'bolt'), 1));
        if (w.allianceOf((owner as CombatUnit).owner, (u as CombatUnit).owner) === 'enemy' && damage >= w.drawN(101)) {
          hitPointsDecrease(w, u as CombatUnit, 1, (owner as CombatUnit).uid, 'arrow');
        }
      } else {
        const h = w.houseAt(delphiRound(p.toX), delphiRound(p.toY));
        if (h !== null && owner !== null && w.allianceOf(owner.owner, h.owner) === 'enemy') {
          w.houseAddDamage(h, 1, owner.uid); // arrow vs house = 1 HP (326–330)
        }
      }
    }
    p.t = -1; // resolved
  }
  w.compactProjectiles();
}

/** Animals (unit.dat records 30..37) — arrows explicitly skip them (KM_Projectiles.pas 311, 333). */
export function isAnimalRecord(record: number): boolean {
  return record >= 30 && record <= 37;
}

// ---------------------------------------------------------------------------------------------
// Warrior state machine (KM_UnitWarrior.pas / KM_UnitActionFight.pas / KM_Units.pas)

/** MakeSound (KM_UnitActionFight.pas 162–187): the battle-cry roll is always drawn; playback is
 *  gated on the spectator FOW and is a no-op headless (flagged in the header). */
function makeSound(w: CombatWorld, u: CombatUnit, _isHit: boolean): void {
  w.drawN(20); // KaMRandom(20) = 0 → battle cry
}

/** TKMUnitWarrior.CanInterruptAction (761–768) + the action CanBeInterrupted flags. */
export function canInterruptAction(w: CombatWorld, u: CombatUnit, forced = true): boolean {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null) return true;
  if (!rt.walk && u.fightState !== 'fight' && ws.task !== null && ws.task.kind === 'attackHouse') return true;
  // The fight action is created Locked=True (KM_UnitActionFight.pas 66): only ranged fights are
  // interruptible (CanBeInterrupted, 388–391). This also stops FightEnemy's mutual recursion.
  if (u.fightState === 'fight') return isRangedSpec(rt.spec) && forced;
  if (!rt.walk) return !ws.stayLocked;
  return true; // walk: CanAbandonExternal and StepDone — always true in v0 (flagged)
}

/** TKMUnit.IsIdle (2428–2431): no task and an unlocked stay action. */
export function warriorIsIdle(w: CombatWorld, u: CombatUnit): boolean {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null) return false;
  if (ws.task !== null) return false;
  if (rt.walk !== null || u.fightState === 'fight') return false;
  return !ws.stayLocked;
}

/** TKMUnitWarrior.InFight (472–477): fighting a live warrior (citizens count only if asked). */
export function warriorInFight(w: CombatWorld, u: CombatUnit, countCitizens = false): boolean {
  const ws = w.warriorState(u);
  if (ws === null || u.fightState !== 'fight' || ws.fightOpponentUid === 0) return false;
  const opponent = w.unitByUid(ws.fightOpponentUid);
  if (opponent === null || isDeadOrDying(opponent)) return false;
  return countCitizens || isWarriorSpec(unitSpec(w, opponent));
}

/** TKMUnitWarrior.GetOrderTargetUnit (368–377): nil while the target is dead. */
export function orderTargetUnit(w: CombatWorld, u: CombatUnit): CombatUnit | null {
  const ws = w.warriorState(u);
  if (ws === null || ws.orderTargetUid === 0) return null;
  const target = w.unitByUid(ws.orderTargetUid);
  return target !== null && !isDeadOrDying(target) ? target : null;
}

/** TKMUnitWarrior.GetOrderHouseTarget (389–398): nil once destroyed. */
export function orderTargetHouse(w: CombatWorld, u: CombatUnit): CombatHouse | null {
  const ws = w.warriorState(u);
  if (ws === null || ws.orderTargetHouseUid === 0) return null;
  const house = w.houseByUid(ws.orderTargetHouseUid);
  return house !== null && !house.destroyed ? house : null;
}

/** TKMUnitWarrior.GetAttackingUnit (356–365): nil while the unit is dead. */
export function attackingUnit(w: CombatWorld, u: CombatUnit): CombatUnit | null {
  const ws = w.warriorState(u);
  if (ws === null || ws.attackingUid === 0) return null;
  const target = w.unitByUid(ws.attackingUid);
  return target !== null && !target.dead ? target : null;
}

/** TKMUnitWarrior.WithinFightRange (442–445): KMLength(PositionNext, aValue) ∈ [min, max]. */
export function warriorWithinFightRange(w: CombatWorld, u: CombatUnit, target: Pt): boolean {
  const spec = w.unitRuntime(u).spec;
  return inRange(length(w.posNext(u), target), fightRangeMin(spec), fightRangeMax(spec, false));
}

/** UpdateVertexUsage (KM_UnitActionFight.pas 121–159). */
function updateVertexUsage(w: CombatWorld, u: CombatUnit, ws: WarriorState, opponent: CombatUnit): boolean {
  const from = w.posRound(u);
  const to = w.posRound(opponent);
  if (kmStepIsDiag(from, to)) {
    const vert = getDiagVertex(from, to);
    if (ws.fightVertex !== null && samePoint(vert, ws.fightVertex)) return true;
    decVertex(w, ws);
    if (w.vertexUsageCompatible(from.x, from.y, to.x, to.y)) {
      w.vertexAdd(from.x, from.y, to.x, to.y);
      ws.fightVertex = vert;
      return true;
    }
    return false; // the vertex is in use, we cannot fight
  }
  decVertex(w, ws);
  return true;
}

function incVertex(w: CombatWorld, ws: WarriorState, from: Pt, to: Pt): void {
  w.vertexAdd(from.x, from.y, to.x, to.y);
  ws.fightVertex = getDiagVertex(from, to);
}

function decVertex(w: CombatWorld, ws: WarriorState): void {
  if (ws.fightVertex === null) return;
  w.vertexRemove(ws.fightVertex.x, ws.fightVertex.y);
  ws.fightVertex = null;
}

/** SetActionFight (KM_UnitWarrior.pas 721–736): the reload step is computed with the CURRENT
 *  direction (before the action turns the unit to face the opponent). */
export function setActionFight(w: CombatWorld, u: CombatUnit, opponent: CombatUnit): void {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null) return;
  const cycle = Math.max(rt.spec.anim[1][Math.max(u.dir - 1, 0)].count, 1);
  let step = 0;
  if (isRangedSpec(rt.spec) && ws.lastShootTime !== 0 && w.tickCount - ws.lastShootTime < cycle) {
    step = (firingDelayOf(rt.spec) + (w.tickCount - ws.lastShootTime)) % cycle;
  }
  u.dir = kmGetDirection2(u.posF, opponent.posF);
  ws.fightOpponentUid = opponent.uid;
  ws.fightDelay = -1;
  ws.fightVertex = null;
  w.setFightState(u, 'fight');
  w.abandonWalk(u); // SetAction frees the walk action
  w.clearStay(u); // the fight replaces the current stay action
  u.animStep = step;
  if (kmStepIsDiag(w.posRound(u), w.posRound(opponent)) && !isRangedSpec(rt.spec)) {
    incVertex(w, ws, w.posRound(u), w.posRound(opponent));
  }
}

/** KMGetDirection for a float pair (walk.ts kmGetDirection is tile-typed; same math). */
function kmGetDirection2(a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distSqr = dx * dx + dy * dy;
  if (!(distSqr > 0)) return 0;
  const ang = Math.atan2(dy / distSqr, dx / distSqr) + Math.PI / 2;
  const deg = (ang / Math.PI) * 180;
  const bucket = delphiRound(deg + 3600 + 22.5) % 360;
  return Math.floor(bucket / 45) + 1;
}

/** FightEnemy (739–757). */
export function warriorFightEnemy(w: CombatWorld, u: CombatUnit, enemy: CombatUnit): void {
  const ws = w.warriorState(u);
  if (ws === null) return;
  if (ws.task !== null) {
    if (ws.task.kind === 'attackHouse' && !isWarriorSpec(unitSpec(w, enemy))) ws.task.phase = 0;
    else ws.task = null;
  }
  ws.attackingUid = enemy.uid;
  setActionFight(w, u, enemy);
  if (isWarriorSpec(unitSpec(w, enemy))) warriorCheckForEnemy(w, enemy); // the opponent knows ASAP
}

/** CheckForEnemy (660–679). */
export function warriorCheckForEnemy(w: CombatWorld, u: CombatUnit): boolean {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null) return false;
  if (isRangedSpec(rt.spec) && (!warriorIsIdle(w, u) || (ws.faceDir !== u.dir && ws.faceDir !== 0))) return false;
  const enemy = warriorFindEnemy(w, u);
  if (enemy === null) return false;
  groupMemberPickedFight(w, u, enemy); // OnPickedFight (672)
  if (warriorWithinFightRange(w, u, w.posRound(enemy))) warriorFightEnemy(w, u, enemy);
  return true;
}

/** FindEnemy (682–718). `unlocked` mirrors the fight action's temporary Locked := False (205). */
export function warriorFindEnemy(w: CombatWorld, u: CombatUnit, unlocked = false): CombatUnit | null {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null) return null;
  if (!unlocked && !canInterruptAction(w, u)) return null;
  if (isRangedSpec(rt.spec)) {
    if (!unlocked && u.fightState === 'fight') return null; // Action.Locked
    if (ws.task !== null && ws.task.kind === 'attackHouse') return null;
    if (rt.walk !== null) {
      const ot = orderTargetUnit(w, u);
      if (ot === null || !warriorWithinFightRange(w, u, w.posRound(ot))) return null;
    }
  }
  const testDir = isRangedSpec(rt.spec) ? u.dir : 0;
  const range = fightRangeMax(rt.spec, true);
  let result = unitsHitTestWithinRad(w, w.posRound(u), fightRangeMin(rt.spec), range, u.owner, 'enemy', testDir, true);
  if (ws.task !== null && ws.task.kind === 'attackHouse' && rt.walk === null && u.fightState !== 'fight') {
    if (result === null || !isWarriorSpec(unitSpec(w, result))) result = null;
  }
  return result;
}

/** OrderDone (598–622) — the group's CheckOrderDone reads it per member. */
export function warriorOrderDone(w: CombatWorld, u: CombatUnit): boolean {
  const ws = w.warriorState(u);
  if (ws === null) return true;
  if (ws.nextOrder !== 'none') return false;
  switch (ws.order) {
    case 'none':
      return true;
    case 'walk':
      return !ws.useExactTarget || samePoint(w.posRound(u), ws.orderLoc);
    case 'attackUnit':
      return orderTargetUnit(w, u) === null;
    case 'attackHouse':
      return orderTargetHouse(w, u) === null;
    default:
      return false;
  }
}

/** ClearOrderTarget (322–329) / SetOrderTarget (338–344) / SetOrderHouseTarget (380–386). */
function clearOrderTarget(w: CombatWorld, u: CombatUnit, clearAttacking = true): void {
  const ws = w.warriorState(u);
  if (ws === null) return;
  ws.orderTargetUid = 0;
  ws.orderTargetHouseUid = 0;
  if (clearAttacking) ws.attackingUid = 0;
}

/** OrderWalk (587–595). */
export function orderWarriorWalk(w: CombatWorld, u: CombatUnit, x: number, y: number, exact: boolean, forced = true): void {
  const ws = w.warriorState(u);
  if (ws === null) return;
  clearOrderTarget(w, u);
  ws.nextOrder = 'walk';
  ws.nextOrderForced = forced;
  ws.orderLoc = { x, y };
  ws.useExactTarget = exact;
}

/** OrderAttackHouse (626–631). */
export function orderWarriorAttackHouse(w: CombatWorld, u: CombatUnit, houseUid: number, forced = true): void {
  const ws = w.warriorState(u);
  if (ws === null) return;
  ws.nextOrder = 'attackHouse';
  ws.nextOrderForced = forced;
  clearOrderTarget(w, u);
  ws.orderTargetHouseUid = houseUid;
}

/** OrderFight (634–638). */
export function orderWarriorFight(w: CombatWorld, u: CombatUnit, targetUid: number): void {
  const ws = w.warriorState(u);
  if (ws === null) return;
  ws.nextOrder = 'attackUnit';
  clearOrderTarget(w, u, false);
  ws.orderTargetUid = targetUid;
}

/** OrderNone (300–306). */
export function orderWarriorNone(w: CombatWorld, u: CombatUnit): void {
  const ws = w.warriorState(u);
  if (ws === null) return;
  clearOrderTarget(w, u);
  ws.nextOrder = 'none';
  ws.useExactTarget = false;
}

/** TakeNextOrder (888–980); woStorm is out of v0. */
export function warriorTakeNextOrder(w: CombatWorld, u: CombatUnit): void {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null) return;
  if (
    (ws.nextOrder === 'attackUnit' && orderTargetUnit(w, u) === null) ||
    (ws.nextOrder === 'attackHouse' && orderTargetHouse(w, u) === null)
  ) {
    ws.nextOrder = 'none';
  }

  switch (ws.nextOrder) {
    case 'none':
      break;
    case 'walk': {
      const loc = w.closestTile(ws.orderLoc.x, ws.orderLoc.y, w.posRound(u).x, w.posRound(u).y, ws.useExactTarget);
      if (rt.walk !== null) {
        // ChangeWalkTo (1099–1117): v0 rebuilds the route from the current tile (flagged).
        ws.task = null;
        w.startWalkTo(u, loc.x, loc.y);
        ws.nextOrder = 'none';
        ws.order = 'walk';
      } else if (canInterruptAction(w, u, ws.nextOrderForced)) {
        ws.task = null;
        if (isRangedSpec(rt.spec) || !samePoint(loc, w.posRound(u))) w.startWalkTo(u, loc.x, loc.y);
        ws.nextOrder = 'none';
        ws.order = 'walk';
      }
      break;
    }
    case 'attackUnit': {
      if (canInterruptAction(w, u, ws.nextOrderForced)) {
        const target = orderTargetUnit(w, u);
        if (target === null) {
          ws.nextOrder = 'none';
          break;
        }
        ws.task = null;
        ws.nextOrder = 'none';
        ws.order = 'attackUnit';
        ws.orderLoc = w.posRound(target);
        warriorFightEnemy(w, u, target);
      }
      break;
    }
    case 'attackHouse': {
      const target = orderTargetHouse(w, u);
      if (target === null) {
        ws.nextOrder = 'none';
        break;
      }
      const sameTask =
        ws.order === 'attackHouse' && ws.task !== null && ws.task.kind === 'attackHouse' && ws.task.houseUid === target.uid;
      if (!sameTask) {
        if (rt.walk !== null) w.abandonWalk(u); // AbandonWalk (948–951)
        if (canInterruptAction(w, u, ws.nextOrderForced)) {
          ws.task = { kind: 'attackHouse', phase: 0, houseUid: target.uid };
          ws.order = 'attackHouse';
          ws.orderLoc = w.posRound(u);
          ws.nextOrder = 'none';
        }
      }
      break;
    }
    case 'storm':
      break; // out of v0
  }
}

/** ExecuteValidateOpponent + ExecuteProcessRanged/Melee + Execute (KM_UnitActionFight.pas 190–371). */
export function executeFightAction(w: CombatWorld, u: CombatUnit): 'continues' | 'done' {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null || u.fightState !== 'fight') return 'done';
  const spec = rt.spec;
  const cycle = Math.max(spec.anim[1][Math.max(u.dir - 1, 0)].count, 1);
  let step = u.animStep % cycle;

  // ExecuteValidateOpponent
  let opponent = ws.fightOpponentUid !== 0 ? w.unitByUid(ws.fightOpponentUid) : null;
  const invalid =
    opponent === null ||
    isDeadOrDying(opponent) ||
    !w.isVisible(opponent) ||
    w.allianceOf(u.owner, opponent.owner) === 'ally' ||
    !warriorWithinFightRange(w, u, w.posRound(opponent)) ||
    (isRangedSpec(spec) && w.fog(u.owner).checkTileRev(w.posRound(opponent).x, w.posRound(opponent).y) !== 255) ||
    !w.canWalkDiagonal(w.posRound(u).x, w.posRound(u).y, w.posRound(opponent).x, w.posRound(opponent).y);

  if (invalid) {
    const old = opponent;
    const newEnemy = warriorFindEnemy(w, u, true); // Locked := False; ... FindEnemy; Locked := True
    if (newEnemy !== null) {
      w.emit('fight-retarget', `unit#${u.uid}${old !== null ? ` old#${old.uid}` : ''} new#${newEnemy.uid}`);
      opponent = newEnemy;
      ws.fightOpponentUid = newEnemy.uid;
      groupMemberPickedFight(w, u, newEnemy); // OnPickedFight (212)
      ws.fightDelay = -1;
      if (isRangedSpec(spec)) {
        u.dir = kmGetDirection2(u.posF, newEnemy.posF);
      } else if (step <= MELEE_STRIKE_STEP) {
        u.animStep = 0;
      }
    } else {
      if (isRangedSpec(spec) && ws.faceDir !== 0) u.dir = ws.faceDir;
      const gate =
        old !== null &&
        isRangedSpec(spec) &&
        !isDeadOrDying(old) &&
        w.isVisible(old) &&
        warriorWithinFightRange(w, u, w.posRound(old)) &&
        w.fog(u.owner).checkTileRev(w.posRound(old).x, w.posRound(old).y) !== 255;
      if (gate) w.emit('fow-drop', `shooter#${u.uid} target#${old.uid}`); // FOW gate #2 (199–200)
      ws.fightOpponentUid = 0;
      decVertex(w, ws);
      w.setFightState(u, 'none');
      return 'done';
    }
  }

  const live = opponent as CombatUnit;
  step = u.animStep % cycle; // can be changed by the validation, so recalculate
  if (step === 0) {
    const dir = kmGetDirection2(u.posF, live.posF);
    if (dir !== 0) u.dir = dir;
  }
  if (!isRangedSpec(spec)) {
    if (!updateVertexUsage(w, u, ws, live)) {
      ws.fightOpponentUid = 0;
      w.setFightState(u, 'none');
      return 'done';
    }
  }

  if (isRangedSpec(spec)) {
    if (processRanged(w, u, ws, live, step)) return 'continues';
  } else {
    if (processMelee(w, u, ws, live, step)) return 'continues';
  }
  u.animStep += 1;
  return 'continues';
}

/** ExecuteProcessRanged (234–267). */
function processRanged(w: CombatWorld, u: CombatUnit, ws: WarriorState, opponent: CombatUnit, step: number): boolean {
  const spec = w.unitRuntime(u).spec;
  if (step === 0) {
    if (ws.fightDelay === -1) ws.fightDelay = aimingDelayOf(spec, (max) => w.drawN(max));
    if (ws.fightDelay > 0) {
      ws.fightDelay -= 1;
      return true; // do not increment AnimStep, just exit
    }
  }
  if (step === aimSoundDelayOf(spec)) makeSound(w, u, false);
  if (step === firingDelayOf(spec)) {
    ws.lastShootTime = w.tickCount;
    const flight = aimTargetUnit(w, u, opponent, projectileKindOf(spec), RANGE_MAX, RANGE_MIN);
    w.emit('arrow-fired', `kind=${projectileKindOf(spec)} shooter#${u.uid} target#${opponent.uid} flight=${flight}`);
    ws.fightDelay = -1;
  }
  return false;
}

/** ExecuteProcessMelee (271–322). */
function processMelee(w: CombatWorld, u: CombatUnit, ws: WarriorState, opponent: CombatUnit, step: number): boolean {
  const spec = w.unitRuntime(u).spec;
  if (step === 1) {
    // Notifications (281–285): the defender's AI and, for melee warriors, the attacker's AI.
    w.unitAttackNotification(opponent.uid, u.uid, true);
    if (isWarriorSpec(unitSpec(w, opponent)) && !isRangedSpec(spec)) w.unitAttackNotification(u.uid, opponent.uid, false);
  }
  if (step === MELEE_STRIKE_STEP) {
    let damage = spec.attack ?? 0;
    if (groupTypeOf(opponent.type) === GT_MOUNTED) damage += spec.attackHorse ?? 0;
    damage = damage * (getDirModifier(u.dir, opponent.dir) + 1);
    damage = Math.floor(damage / Math.max(unitSpec(w, opponent).defence ?? 0, 1));
    const isHit = damage >= w.drawN(101);
    if (isHit) hitPointsDecrease(w, opponent, 1, u.uid, 'melee');
    makeSound(w, u, isHit);
  }
  if (step === 0 || step === 3 || step === 6) {
    if (ws.fightDelay === -1) ws.fightDelay = w.drawN(2);
    if (ws.fightDelay > 0) {
      ws.fightDelay -= 1;
      return true;
    }
    ws.fightDelay = -1;
  }
  return false;
}

/** HitPointsDecrease (KM_Units.pas 1627–1645): notification stub at 1637, Kill at 0 HP. */
export function hitPointsDecrease(w: CombatWorld, u: CombatUnit, amount: number, attackerUid: number, source: DamageSource): void {
  const spec = w.unitRuntime(u).spec;
  const max = spec.hitPoints ?? 0;
  if (u.hitPoints === max) {
    const ws = w.warriorState(u);
    if (ws !== null) ws.hitPointCounter = 1;
  }
  u.hitPoints = Math.max(u.hitPoints - amount, 0);
  w.unitHPDecreaseNotification(u.uid, attackerUid); // stub at 1637
  w.emit('hp-decrease', `unit#${u.uid} amount=${amount} hp=${u.hitPoints} source=${source} attacker#${attackerUid}`);
  if (u.hitPoints === 0 && !isDeadOrDying(u)) {
    w.emit('kill-source', `unit#${u.uid} source=${source} attacker#${attackerUid}`);
    const attacker = attackerUid !== 0 ? w.unitByUid(attackerUid) : null;
    killUnit(w, u, attacker !== null ? attacker.owner : -1, true, false);
  }
}

/** TKMUnit.Kill (1532–1566) + the TKMUnitWarrior override (270–286) incl. group bookkeeping. */
export function killUnit(w: CombatWorld, u: CombatUnit, fromOwner: number, showAnimation: boolean, forceDelay: boolean): void {
  if (isDeadOrDying(u)) return;
  const ws = w.warriorState(u);
  if (ws !== null) ws.killedBy = fromOwner;
  w.emit('unit-killed', `unit#${u.uid} owner=${u.owner} from=${fromOwner}`);
  if (forceDelay) {
    // KillASAP: the unit is killed when its current action allows it (no exchange in v0).
    if (ws !== null) {
      ws.killAsap = true;
      ws.killAsapShowAnimation = showAnimation;
    }
    return;
  }
  doKill(w, u, showAnimation);
  if (ws !== null) {
    clearOrderTarget(w, u);
    const group = u.groupUid !== 0 ? w.groupByUid(u.groupUid) : null;
    if (group !== null) groupMemberDied(w, group, u);
  }
}

/** DoKill (1569–1575): dispose of the action, create the die task (its constructor runs phase 1). */
export function doKill(w: CombatWorld, u: CombatUnit, showAnimation: boolean): void {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null) {
    // Citizen: the same TaskDie shape (a locked die stay, then CloseUnit), tracked via fightState.
    rt.walk = null;
    rt.task = null;
    rt.actionLock = showAnimation ? rt.spec.anim[3][Math.max(u.dir - 1, 0)].count : 0;
    w.setFightState(u, 'die');
    return;
  }
  rt.walk = null;
  ws.stayActive = false;
  ws.task = null;
  w.setFightState(u, 'die');
  ws.task = { kind: 'die', phase: 1, showAnimation };
  // TKMTaskDie.Create (29–40): when the unit is visible, phase 1 executes immediately.
  executeDieTask(w, u);
}

/** TKMTaskDie.Execute (59–116). */
export function executeDieTask(w: CombatWorld, u: CombatUnit): 'continues' | 'done' {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null || ws.task === null || ws.task.kind !== 'die') return 'done';
  const task = ws.task;
  if (task.phase === 0) {
    // Not visible (inside a house) — v0 warriors are always visible; kept for shape.
    w.setStay(u, 0, true, true, 0);
  } else if (task.phase === 1) {
    if (!task.showAnimation) {
      w.setStay(u, 0, true, false, 0);
    } else {
      const sequenceLength = rt.spec.anim[3][Math.max(u.dir - 1, 0)].count; // uaDie
      w.setStay(u, sequenceLength, true, false, 0);
    }
  } else {
    // Close the unit (KM_Units.pas CloseUnit 1416–1443): dead, erased from every list next pass.
    w.closeUnit(u);
    return 'continues';
  }
  task.phase += 1;
  return 'continues';
}

/** TKMTaskAttackHouse.Execute (81–204): melee 2 HP + 6-tick pause; ranged keep-distance + reload. */
export function executeAttackHouseTask(w: CombatWorld, u: CombatUnit): 'continues' | 'done' {
  const rt = w.unitRuntime(u);
  const ws = rt.warrior;
  if (ws === null || ws.task === null || ws.task.kind !== 'attackHouse') return 'done';
  const task = ws.task;
  const house = w.houseByUid(task.houseUid);
  if (house === null || house.destroyed) return 'done'; // WalkShouldAbandon
  const spec = rt.spec;

  switch (task.phase) {
    case 0: {
      if (isRangedSpec(spec)) {
        const dist = w.houseDistance(house, w.posRound(u).x, w.posRound(u).y);
        if (dist < RANGE_MIN) walkFromHouse(w, u, house, RANGE_MIN);
        else if (dist > RANGE_MAX) walkToHouse(w, u, house, RANGE_MAX);
        else w.setStay(u, 0, false, true, 0);
      } else {
        walkToHouse(w, u, house, 1);
      }
      break;
    }
    case 1: {
      if (isRangedSpec(spec)) {
        const dist = w.houseDistance(house, w.posRound(u).x, w.posRound(u).y);
        if (dist < RANGE_MIN || dist > RANGE_MAX) {
          w.setStay(u, 0, false, true, 0);
          return 'done';
        }
        let delay = aimingDelayOf(spec, (max) => w.drawN(max));
        const cycle = Math.max(spec.anim[1][Math.max(u.dir - 1, 0)].count, 1) - firingDelayOf(spec);
        if (ws.lastShootTime !== 0 && w.tickCount - ws.lastShootTime < cycle) {
          delay += cycle - (w.tickCount - ws.lastShootTime);
        }
        w.setStay(u, delay, true, false, 0);
        if (!samePoint(w.posRound(u), w.houseClosestCell(house, w.posRound(u).x, w.posRound(u).y))) {
          u.dir = kmGetDirection2(w.posNext(u), house.entrance);
        }
      } else {
        if (w.houseDistance(house, w.posRound(u).x, w.posRound(u).y) > fightRangeMax(spec, false)) {
          w.setStay(u, 0, false, true, 0);
          return 'done';
        }
        w.setStay(u, 0, true, false, 0);
        const closest = w.houseClosestCell(house, w.posNext(u).x, w.posNext(u).y);
        if (!samePoint(w.posNext(u), closest)) u.dir = kmGetDirection2(w.posNext(u), closest);
      }
      break;
    }
    case 2: {
      if (aimSoundDelayOf(spec) > 0) {
        w.setStay(u, aimSoundDelayOf(spec), true, false, 0);
      } else {
        task.phase += 1; // skip the rogue phase
        if (isRangedSpec(spec)) w.setStay(u, firingDelayOf(spec), true, false, 0);
        else w.setStay(u, 6, true, false, 0);
      }
      break;
    }
    case 3: {
      w.setStay(u, firingDelayOf(spec) - aimSoundDelayOf(spec), true, false, aimSoundDelayOf(spec));
      break;
    }
    default: {
      if (isRangedSpec(spec)) {
        const flight = aimTargetHouse(w, u, house, projectileKindOf(spec), RANGE_MAX, RANGE_MIN);
        w.emit('arrow-fired', `kind=${projectileKindOf(spec)} shooter#${u.uid} house#${house.uid} flight=${flight}`);
        ws.lastShootTime = w.tickCount;
        const animLength = spec.anim[1][Math.max(u.dir - 1, 0)].count;
        w.setStay(u, animLength - firingDelayOf(spec), true, false, firingDelayOf(spec));
        task.phase = 0;
      } else {
        w.setStay(u, 6, true, false, 6);
        w.houseAddDamage(house, 2, u.uid); // melee strike = 2 HP (192)
        task.phase = 1;
      }
      break;
    }
  }
  task.phase += 1;
  return 'continues';
}

/** SetActionWalkToHouse / FromHouse (KM_UnitTaskAttackHouse.pas 101–104; v0 approximations). */
function walkToHouse(w: CombatWorld, u: CombatUnit, house: CombatHouse, dist: number): void {
  const from = w.posRound(u);
  const approach = approachTile(w, house, from);
  if (approach === null) return;
  const route = w.findRoute(from.x, from.y, approach.x, approach.y);
  if (route === null) return;
  if (dist <= 1) {
    w.startWalkTo(u, route[route.length - 1].x, route[route.length - 1].y);
    return;
  }
  for (const node of route) {
    if (w.houseDistance(house, node.x, node.y) <= dist) {
      w.startWalkTo(u, node.x, node.y);
      return;
    }
  }
}

function walkFromHouse(w: CombatWorld, u: CombatUnit, house: CombatHouse, dist: number): void {
  const from = w.posRound(u);
  for (let i = 1; i <= 40; i++) {
    const p = getPositionFromIndex(from, i);
    if (!w.tileInMapCoords(p.x, p.y) || !w.tileWalkable(p.x, p.y)) continue;
    if (w.houseDistance(house, p.x, p.y) < dist) continue;
    if (w.findRoute(from.x, from.y, p.x, p.y) === null) continue;
    w.startWalkTo(u, p.x, p.y);
    return;
  }
}

/** The walkable tile next to the house closest to `from` (a v0 stand-in for SetActionWalkToHouse). */
function approachTile(w: CombatWorld, house: CombatHouse, from: Pt): Pt | null {
  const cells = w.houseCells(house);
  let best: Pt | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const c of cells) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const p = { x: c.x + dx, y: c.y + dy };
        if (!w.tileWalkable(p.x, p.y)) continue;
        const d = length(from, p);
        if (d < bestDist) {
          bestDist = d;
          best = p;
        }
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Unit groups (units/KM_UnitGroup.pas) — the orders API, cadences and predicates

export function groupMembers(w: CombatWorld, g: GroupState): CombatUnit[] {
  const out: CombatUnit[] = [];
  for (const uid of g.memberUids) {
    const u = w.unitByUid(uid);
    if (u !== null) out.push(u);
  }
  return out;
}

export function groupIsDead(g: GroupState): boolean {
  return g.memberUids.length === 0;
}

export function groupIsRanged(g: GroupState): boolean {
  return g.groupType === GT_RANGED;
}

export function groupFightMaxRange(w: CombatWorld, g: GroupState): number {
  let result = 0;
  for (const u of groupMembers(w, g)) {
    const max = fightRangeMax(w.unitRuntime(u).spec, false);
    if (max > result) result = max;
  }
  return result;
}

/** Condition (471–478): the minimum member condition. */
export function groupCondition(w: CombatWorld, g: GroupState): number {
  let result = UNIT_MAX_CONDITION;
  for (const u of groupMembers(w, g)) {
    const ws = w.warriorState(u);
    if (ws !== null) result = Math.min(result, ws.condition);
  }
  return result;
}

/** CanTakePlayerOrders (715–718). */
export function groupCanTakePlayerOrders(w: CombatWorld, g: GroupState): boolean {
  return (groupIsRanged(g) || !groupInFight(w, g)) && !g.blockPlayerOrders;
}

/** CanTakeOrdersByScript (722–725). */
export function groupCanTakeOrdersByScript(w: CombatWorld, g: GroupState): boolean {
  return groupIsRanged(g) || !groupInFight(w, g);
}

/** InFight (1131–1140): at least one member fighting a warrior (citizens count only if asked). */
export function groupInFight(w: CombatWorld, g: GroupState, countCitizens = false): boolean {
  for (const u of groupMembers(w, g)) if (warriorInFight(w, u, countCitizens)) return true;
  return false;
}

/** InFightAllMembers (1145–1154). */
export function groupInFightAllMembers(w: CombatWorld, g: GroupState, countCitizens = false): boolean {
  for (const u of groupMembers(w, g)) if (!warriorInFight(w, u, countCitizens)) return false;
  return true;
}

/** InFightAgaistGroups (1157–1196): the groups this group is fighting. */
export function groupInFightAgaistGroups(w: CombatWorld, g: GroupState): GroupState[] {
  const out: GroupState[] = [];
  for (const u of groupMembers(w, g)) {
    const ws = w.warriorState(u);
    if (ws === null || u.fightState !== 'fight' || ws.fightOpponentUid === 0) continue;
    const enemy = w.unitByUid(ws.fightOpponentUid);
    if (enemy === null || isDeadOrDying(enemy)) continue;
    const enemyGroup = enemy.groupUid !== 0 ? w.groupByUid(enemy.groupUid) : null;
    if (enemyGroup !== null && !out.includes(enemyGroup)) out.push(enemyGroup);
  }
  return out;
}

/** IsAttackingHouse (1199–1209). */
export function groupIsAttackingHouse(w: CombatWorld, g: GroupState): boolean {
  for (const u of groupMembers(w, g)) {
    const ws = w.warriorState(u);
    if (ws !== null && ws.task !== null && ws.task.kind === 'attackHouse') return true;
  }
  return false;
}

/** IsAttackingUnit (1212–1215). */
export function groupIsAttackingUnit(w: CombatWorld, g: GroupState): boolean {
  return g.order === 'attackUnit' && g.targetUid !== 0;
}

/** IsIdleToAI (1218–1230). */
export function groupIsIdleToAI(w: CombatWorld, g: GroupState, kinds: string[] = []): boolean {
  let result: boolean;
  if (g.order === 'walk') {
    const members = groupMembers(w, g);
    const pos = members.length > 0 ? w.posRound(members[0]) : { x: 0, y: 0 };
    result = kinds.includes(g.orderWalkKind) || diagLength(pos, g) < 2;
  } else {
    result = g.order === 'none';
  }
  result = result && !groupInFight(w, g, true);
  result = result && g.offenders.length === 0;
  return result;
}

function diagLength(a: Pt, g: GroupState): number {
  const dx = Math.abs(a.x - g.orderX);
  const dy = Math.abs(a.y - g.orderY);
  return dx > dy ? dx + dy * 0.41 : dy + dx * 0.41;
}

/** GetOrderText (1961–1971). */
export function groupOrderText(g: GroupState): string {
  const text =
    g.order === 'none'
      ? 'Idle'
      : g.order === 'walk'
        ? 'Walk'
        : g.order === 'attackHouse'
          ? 'Attack house'
          : g.order === 'attackUnit'
            ? 'Attack unit'
            : 'Storm';
  return `${text}(${g.offenders.length})`;
}

/** GetMemberLocExact (529–549): formation slot + exactness (on-map, walkable, same walk connect). */
export function groupGetMemberLocExact(w: CombatWorld, g: GroupState, index: number): { loc: Pt; exact: boolean } {
  const p = getPositionInGroup2(g.orderX, g.orderY, g.orderDir, index, g.unitsPerRow, w.mapX, w.mapY);
  const member = w.unitByUid(g.memberUids[index]);
  const exact =
    p.fits &&
    w.tileWalkable(p.x, p.y) &&
    member !== null &&
    w.walkConnectId(p.x, p.y) === w.walkConnectId(w.posRound(member).x, w.posRound(member).y);
  return { loc: { x: p.x, y: p.y }, exact };
}

/** IsPositioned (1233–1249). */
function groupIsPositioned(w: CombatWorld, g: GroupState, loc: Pt, dir: number): boolean {
  for (let i = 0; i < g.memberUids.length; i++) {
    const u = w.unitByUid(g.memberUids[i]);
    if (u === null) continue;
    const p = getPositionInGroup2(loc.x, loc.y, dir, i, g.unitsPerRow, w.mapX, w.mapY);
    if (!(warriorIsIdle(w, u) && samePoint(w.posRound(u), p) && u.dir === dir)) return false;
  }
  return true;
}

/** GetPushbackLimit (671–680). */
function groupPushbackLimit(g: GroupState): number {
  return delphiRound(Math.pow(g.memberUids.length, 1.07) * 2.5);
}

/** SetUnitsPerRow (661–667). */
export function groupSetUnitsPerRow(g: GroupState, count: number): void {
  g.unitsPerRow = Math.min(Math.max(count, 1), Math.max(g.memberUids.length, 1));
}

function setGroupOrder(g: GroupState, order: SimGroup['order']): void {
  g.order = order;
  g.pushbackCommands = 0;
}

/** ClearOffenders (2018–2029). */
export function groupClearOffenders(g: GroupState): void {
  g.offenders = [];
}

/** ClearOrderTarget (2009–2015). */
function groupClearOrderTarget(g: GroupState): void {
  g.targetUid = 0;
  g.targetGroupUid = 0;
  g.targetHouseUid = 0;
}

/** SetOrderTargetUnit (2154–2171): melee groups remember the target's group too. */
function groupSetOrderTargetUnit(w: CombatWorld, g: GroupState, unit: CombatUnit | null): void {
  groupClearOrderTarget(g);
  if (unit === null || isDeadOrDying(unit)) return;
  g.targetUid = unit.uid;
  if (isWarriorSpec(unitSpec(w, unit)) && !groupIsRanged(g)) {
    const targetGroup = unit.groupUid !== 0 ? w.groupByUid(unit.groupUid) : null;
    if (targetGroup !== null) g.targetGroupUid = targetGroup.uid;
  }
}

/** SetOrderTargetHouse (2174–2180). */
function groupSetOrderTargetHouse(g: GroupState, house: CombatHouse | null): void {
  groupClearOrderTarget(g);
  if (house === null || house.destroyed) return;
  g.targetHouseUid = house.uid;
}

/** UpdateOrderTargets (2184–2199). */
export function groupUpdateOrderTargets(w: CombatWorld, g: GroupState): void {
  if (g.targetUid !== 0) {
    const u = w.unitByUid(g.targetUid);
    if (u === null || isDeadOrDying(u) || !w.isVisible(u)) g.targetUid = 0;
  }
  if (g.targetHouseUid !== 0) {
    const h = w.houseByUid(g.targetHouseUid);
    if (h === null || h.destroyed) g.targetHouseUid = 0;
  }
  if (g.targetGroupUid !== 0) {
    const tg = w.groupByUid(g.targetGroupUid);
    if (tg === null || groupIsDead(tg)) g.targetGroupUid = 0;
  }
}

/** GetNearestMember(aLoc) (572–589). */
export function groupNearestMember(w: CombatWorld, g: GroupState, loc: Pt, exceptUid = 0): CombatUnit | null {
  let result: CombatUnit | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const u of groupMembers(w, g)) {
    if (u.uid === exceptUid || isDeadOrDying(u)) continue;
    const d = lengthSqr(loc, w.posRound(u));
    if (d < best) {
      best = d;
      result = u;
    }
  }
  return result;
}

/** Member_Died (792–834): list bookkeeping + order repeat; Hungarian reorder is deferred. */
export function groupMemberDied(w: CombatWorld, g: GroupState, member: CombatUnit): void {
  const i = g.memberUids.indexOf(member.uid);
  if (i < 0) return;
  if (g.selectedUid === member.uid) {
    const nearest = groupNearestMember(w, g, w.posRound(member), member.uid);
    g.selectedUid = nearest !== null ? nearest.uid : 0;
  }
  g.memberUids.splice(i, 1);
  if (i === 0) {
    const nearest = groupNearestMember(w, g, w.posRound(member), member.uid);
    if (nearest !== null) {
      const at = g.memberUids.indexOf(nearest.uid);
      if (at > 0) {
        g.memberUids.splice(at, 1);
        g.memberUids.unshift(nearest.uid);
      }
    }
  }
  groupSetUnitsPerRow(g, g.unitsPerRow);
  // HungarianReorderMembers (2071–2115) — DEFERRED (documented drift).
  if (groupIsDead(g)) {
    w.emit('group-died', `group#${g.uid}`);
  } else if (groupCanTakePlayerOrders(w, g) && !groupInFight(w, g)) {
    groupOrderRepeat(w, g, false);
  }
}

/** Member_PickedFight (840–849). */
export function groupMemberPickedFight(w: CombatWorld, u: CombatUnit, enemy: CombatUnit): void {
  if (!isWarriorSpec(unitSpec(w, enemy))) return;
  const g = u.groupUid !== 0 ? w.groupByUid(u.groupUid) : null;
  if (g === null) return;
  if (!g.offenders.includes(enemy.uid)) g.offenders.push(enemy.uid);
}

/** OffendersPrune (852–921). */
function groupOffendersPrune(w: CombatWorld, g: GroupState): void {
  const dontPruneRanged = new Set<number>();
  const dontPruneGroups = new Set<number>();
  const updateProtected = (): void => {
    dontPruneRanged.clear();
    dontPruneGroups.clear();
    for (const u of groupMembers(w, g)) {
      const ws = w.warriorState(u);
      if (ws === null || u.fightState !== 'fight' || ws.fightOpponentUid === 0) continue;
      const enemy = w.unitByUid(ws.fightOpponentUid);
      if (enemy === null || isDeadOrDying(enemy)) continue;
      if (isRangedSpec(unitSpec(w, enemy))) dontPruneRanged.add(enemy.uid);
      if (enemy.groupUid !== 0) dontPruneGroups.add(enemy.groupUid);
    }
  };

  const shouldForget = (offenderUid: number, forgetMinors: boolean): boolean => {
    const offender = w.unitByUid(offenderUid);
    if (offender === null || isDeadOrDying(offender)) return true;
    if (w.allianceOf(g.owner, offender.owner) === 'ally') return true;
    if (forgetMinors && isRangedSpec(unitSpec(w, offender)) && !dontPruneRanged.has(offenderUid)) return true;
    if (forgetMinors && !isRangedSpec(unitSpec(w, offender)) && !dontPruneGroups.has(offender.groupUid)) return true;
    return false;
  };

  let forgetMinors = false;
  if (!groupIsRanged(g)) {
    for (const uid of g.offenders) {
      const offender = w.unitByUid(uid);
      if (offender !== null && !isRangedSpec(unitSpec(w, offender))) {
        forgetMinors = true;
        break;
      }
    }
  }
  if (forgetMinors) updateProtected();

  for (let i = g.offenders.length - 1; i >= 0; i--) {
    if (shouldForget(g.offenders[i], forgetMinors)) {
      g.offenders.splice(i, 1);
      if (g.offenders.length === 0) groupOrderRepeat(w, g, true);
    }
  }
}

/** CheckForFight (925–987). */
export function groupCheckForFight(w: CombatWorld, g: GroupState): void {
  groupOffendersPrune(w, g);
  if (g.offenders.length === 0) return;

  if (groupIsRanged(g)) {
    let fightWasOrdered = false;
    for (const u of groupMembers(w, g)) {
      if (warriorInFight(w, u)) continue;
      for (const uid of g.offenders) {
        const offender = w.unitByUid(uid);
        if (offender === null) continue;
        if (warriorWithinFightRange(w, u, w.posRound(offender))) {
          orderWarriorFight(w, u, uid);
          fightWasOrdered = true;
        }
      }
    }
    if (!fightWasOrdered && !groupInFight(w, g)) {
      groupClearOffenders(g);
      groupOrderRepeat(w, g, true);
    }
  } else {
    for (const u of groupMembers(w, g)) {
      if (warriorInFight(w, u)) continue;
      let offender: CombatUnit | null = null;
      for (const uid of g.offenders) {
        const candidate = w.unitByUid(uid);
        if (candidate === null) continue;
        if (warriorIsAttackingUnit(w, u, candidate)) {
          offender = candidate;
          break;
        }
      }
      if (offender === null && g.offenders.length > 0) {
        offender = w.unitByUid(g.offenders[w.drawN(g.offenders.length)]);
      }
      if (offender === null) continue;
      orderWarriorWalk(w, u, w.posNext(offender).x, w.posNext(offender).y, false);
      const ws = w.warriorState(u);
      if (ws !== null) ws.attackingUid = offender.uid;
    }
  }
}

/** IsAttackingUnit (490–495). */
export function warriorIsAttackingUnit(w: CombatWorld, u: CombatUnit, target: CombatUnit): boolean {
  const ws = w.warriorState(u);
  if (ws === null) return false;
  return (ws.order === 'attackUnit' && orderTargetUnit(w, u) === target) || attackingUnit(w, u) === target;
}

/** CheckOrderDone (991–1126). */
export function groupCheckOrderDone(w: CombatWorld, g: GroupState): void {
  let orderExecuted = false;

  switch (g.order) {
    case 'none':
      orderExecuted = false;
      break;
    case 'walk': {
      orderExecuted = true;
      const pushbackLimit = groupPushbackLimit(g);
      for (const u of groupMembers(w, g)) {
        const pushbackReached = g.pushbackCommands > pushbackLimit;
        const done = warriorOrderDone(w, u);
        orderExecuted = orderExecuted && warriorIsIdle(w, u) && (done || pushbackReached);
        if (done) {
          if (warriorIsIdle(w, u) && g.orderDir !== 0 && u.dir !== g.orderDir) {
            u.dir = g.orderDir;
            w.setStay(u, 50, false, true, 0); // SetActionStay(50, uaWalk)
          }
        } else if (!pushbackReached && warriorIsIdle(w, u)) {
          const i = g.memberUids.indexOf(u.uid);
          const p = groupGetMemberLocExact(w, g, i);
          orderWarriorWalk(w, u, p.loc.x, p.loc.y, p.exact);
          g.pushbackCommands = Math.min(g.pushbackCommands + 1, 65535);
        }
      }
      break;
    }
    case 'attackHouse': {
      const house = g.targetHouseUid !== 0 ? w.houseByUid(g.targetHouseUid) : null;
      orderExecuted = house === null || w.allianceOf(g.owner, house.owner) === 'ally';
      break;
    }
    case 'attackUnit': {
      if (groupIsRanged(g)) {
        const target = groupOrderTargetUnit(w, g);
        orderExecuted = target === null || w.allianceOf(g.owner, target.owner) === 'ally';
        if (!orderExecuted && target !== null) {
          const leader = w.unitByUid(g.memberUids[0]);
          if (
            leader !== null &&
            length({ x: g.orderX, y: g.orderY }, w.posRound(target)) > fightRangeMax(w.unitRuntime(leader).spec, false)
          ) {
            groupOrderAttackUnit(w, g, target.uid, false);
          } else {
            for (let i = 0; i < g.memberUids.length; i++) {
              const u = w.unitByUid(g.memberUids[i]);
              if (u === null || !warriorIsIdle(w, u)) continue;
              const p = groupGetMemberLocExact(w, g, i);
              if (samePoint(w.posRound(u), p.loc) || length(w.posRound(u), w.posRound(target)) <= fightRangeMax(w.unitRuntime(u).spec, false)) {
                u.dir = kmGetDirection2(w.posNext(u), w.posNext(target));
                const ws = w.warriorState(u);
                if (ws !== null) ws.faceDir = u.dir;
                if (!warriorCheckForEnemy(w, u)) w.setStay(u, 10, false, true, 0);
              } else {
                orderWarriorWalk(w, u, p.loc.x, p.loc.y, p.exact);
                const ws = w.warriorState(u);
                if (ws !== null) ws.faceDir = g.orderDir;
              }
            }
          }
        }
      } else {
        const target = g.targetUid !== 0 ? w.unitByUid(g.targetUid) : null;
        const targetLive = target !== null && !isDeadOrDying(target) ? target : null;
        const targetGroup = g.targetGroupUid !== 0 ? w.groupByUid(g.targetGroupUid) : null;
        orderExecuted =
          (targetLive === null || w.allianceOf(g.owner, targetLive.owner) === 'ally') &&
          (targetGroup === null || w.allianceOf(g.owner, targetGroup.owner) === 'ally');

        if (targetLive !== null && w.allianceOf(g.owner, targetLive.owner) !== 'ally') {
          if (!samePoint(w.posNext(targetLive), { x: g.orderX, y: g.orderY })) {
            g.targetFollowTicker += 1;
            const leader = g.memberUids.length > 0 ? w.unitByUid(g.memberUids[0]) : null;
            const dist = leader !== null ? delphiRound(diagMetric(w.posRound(leader), w.posRound(targetLive))) : 0;
            const period = Math.max(Math.floor(dist / 4), 1);
            if (g.targetFollowTicker % period === 0) groupOrderAttackUnit(w, g, targetLive.uid, false);
          }
          for (let i = 0; i < g.memberUids.length; i++) {
            const u = w.unitByUid(g.memberUids[i]);
            if (u === null || !warriorIsIdle(w, u)) continue;
            const p = groupGetMemberLocExact(w, g, i);
            orderWarriorWalk(w, u, p.loc.x, p.loc.y, p.exact);
          }
        }

        if (targetLive === null && targetGroup !== null && w.allianceOf(g.owner, targetGroup.owner) !== 'ally') {
          const leader = g.memberUids.length > 0 ? w.unitByUid(g.memberUids[0]) : null;
          const nearest = groupNearestMember(w, targetGroup, leader !== null ? w.posRound(leader) : { x: 0, y: 0 });
          if (nearest !== null) groupOrderAttackUnit(w, g, nearest.uid, false);
          else orderExecuted = true;
        }
      }
      break;
    }
    default:
      orderExecuted = false; // goStorm — out of v0
      break;
  }

  if (orderExecuted) {
    for (const u of groupMembers(w, g)) {
      if (g.orderDir !== 0 && warriorIsIdle(w, u)) u.dir = g.orderDir;
    }
    groupOrderNone(w, g);
  }
}

function diagMetric(a: Pt, b: Pt): number {
  const dx = Math.abs(a.x - b.x);
  const dy = Math.abs(a.y - b.y);
  return dx > dy ? dx + dy * 0.41 : dy + dx * 0.41;
}

/** UpdateState (2258–2286): the per-tick cadences. */
export function groupUpdateState(w: CombatWorld, g: GroupState): void {
  g.ticker += 1;
  if (groupIsDead(g)) return;
  groupUpdateOrderTargets(w, g);
  if (g.ticker % 10 === 0) groupUpdateHungerMessage(w, g);
  if (g.ticker % 5 === 0) groupCheckForFight(w, g);
  let needCheckOrderDone = g.ticker % 7 === 0;
  if (needCheckOrderDone) {
    needCheckOrderDone = groupIsRanged(g) ? !groupInFightAllMembers(w, g) : !groupInFight(w, g);
  }
  if (needCheckOrderDone) groupCheckOrderDone(w, g);
}

/** UpdateHungerMessage (1975–2006): message/script events are no-ops in v0. */
function groupUpdateHungerMessage(w: CombatWorld, g: GroupState): void {
  if (groupIsDead(g)) return;
  let someoneHungry = false;
  for (const u of groupMembers(w, g)) {
    const ws = w.warriorState(u);
    if (ws === null || isDeadOrDying(u)) continue;
    if (ws.condition < UNIT_MIN_CONDITION) {
      someoneHungry = true;
      break;
    }
  }
  if (someoneHungry) {
    g.timeSinceHungryReminder -= 10;
    if (g.timeSinceHungryReminder < 1) {
      w.emit('group-hungry', `group#${g.uid}`);
      g.timeSinceHungryReminder = TIME_BETWEEN_MESSAGES;
    }
  } else {
    g.timeSinceHungryReminder = 0;
  }
}

/** The group's GetOrderTargetUnit (2118–2127): nil while the target is dead/dying. */
export function groupOrderTargetUnit(w: CombatWorld, g: GroupState): CombatUnit | null {
  if (g.targetUid === 0) return null;
  const u = w.unitByUid(g.targetUid);
  return u !== null && !isDeadOrDying(u) ? u : null;
}

/** The group's GetOrderTargetHouse (2142–2151). */
export function groupOrderTargetHouse(w: CombatWorld, g: GroupState): CombatHouse | null {
  if (g.targetHouseUid === 0) return null;
  const h = w.houseByUid(g.targetHouseUid);
  return h !== null && !h.destroyed ? h : null;
}

/** The group's GetOrderTargetGroup (2130–2139). */
export function groupOrderTargetGroup(w: CombatWorld, g: GroupState): GroupState | null {
  if (g.targetGroupUid === 0) return null;
  const tg = w.groupByUid(g.targetGroupUid);
  return tg !== null && !groupIsDead(tg) ? tg : null;
}

/** OrderWalk (1899–1939). */
export function groupOrderWalk(
  w: CombatWorld,
  g: GroupState,
  loc: Pt,
  clearOffenders: boolean,
  kind: 'none' | 'halt',
  dir = 0,
  forced = true,
): void {
  if (groupIsDead(g)) return;
  g.orderWalkKind = kind;
  if (clearOffenders && groupCanTakePlayerOrders(w, g)) groupClearOffenders(g);
  let newDir: number;
  if (dir === 0) newDir = g.orderDir === 0 ? (groupMembers(w, g)[0]?.dir ?? 0) : g.orderDir;
  else newDir = dir;
  g.orderX = loc.x;
  g.orderY = loc.y;
  g.orderDir = newDir;
  groupClearOrderTarget(g);
  if (groupIsPositioned(w, g, loc, newDir)) return; // all members already in place
  setGroupOrder(g, 'walk');
  // HungarianReorderMembers — DEFERRED (documented drift).
  for (let i = 0; i < g.memberUids.length; i++) {
    const u = w.unitByUid(g.memberUids[i]);
    if (u === null) continue;
    const p = groupGetMemberLocExact(w, g, i);
    orderWarriorWalk(w, u, p.loc.x, p.loc.y, p.exact, forced);
    const ws = w.warriorState(u);
    if (ws !== null) ws.faceDir = newDir;
  }
}

/** OrderAttackUnit (1344–1455). */
export function groupOrderAttackUnit(w: CombatWorld, g: GroupState, targetUid: number, clearOffenders: boolean, forced = true): void {
  const target = w.unitByUid(targetUid);
  if (target === null || isDeadOrDying(target)) return;
  if (w.allianceOf(g.owner, target.owner) !== 'enemy') return;
  if (clearOffenders && groupCanTakePlayerOrders(w, g)) groupClearOffenders(g);

  if (groupIsRanged(g)) {
    setGroupOrder(g, 'attackUnit');
    groupSetOrderTargetUnit(w, g, target);
    const leader = w.unitByUid(g.memberUids[0]);
    if (leader === null) return;
    const maxRange = fightRangeMax(w.unitRuntime(leader).spec, false);
    if (length(w.posRound(leader), w.posRound(target)) > maxRange) {
      const route = w.findRoute(w.posRound(leader).x, w.posRound(leader).y, w.posNext(target).x, w.posNext(target).y);
      let stop: Pt | null = null;
      if (route !== null) {
        for (const node of route) {
          if (length(node, w.posNext(target)) <= maxRange) {
            stop = node;
            break;
          }
        }
      }
      if (stop === null) {
        g.targetUid = 0; // target cannot be reached, abort completely
        setGroupOrder(g, 'none');
        return;
      }
      g.orderX = stop.x;
      g.orderY = stop.y;
      g.orderDir = kmGetDirection2(stop, w.posNext(target));
      // HungarianReorderMembers — DEFERRED.
    } else {
      g.orderX = w.posRound(leader).x;
      g.orderY = w.posRound(leader).y;
      g.orderDir = kmGetDirection2(w.posRound(leader), w.posNext(target));
    }
    for (let i = 0; i < g.memberUids.length; i++) {
      const u = w.unitByUid(g.memberUids[i]);
      if (u === null) continue;
      const spec = w.unitRuntime(u).spec;
      const p = groupGetMemberLocExact(w, g, i);
      const distNext = length(w.posNext(u), w.posRound(target));
      if (!samePoint(w.posRound(u), p.loc) && (distNext > fightRangeMax(spec, false) || distNext < fightRangeMin(spec))) {
        orderWarriorWalk(w, u, p.loc.x, p.loc.y, p.exact, forced);
        const ws = w.warriorState(u);
        if (ws !== null) ws.faceDir = g.orderDir;
      } else if (!warriorIsIdle(w, u)) {
        const ws = w.warriorState(u);
        if (ws !== null && (ws.faceDir !== g.orderDir || !warriorInFight(w, u, true))) {
          orderWarriorWalk(w, u, w.posNext(u).x, w.posNext(u).y, true, forced);
          ws.faceDir = g.orderDir;
        }
      } else {
        u.dir = kmGetDirection2(w.posNext(u), w.posNext(target));
        const ws = w.warriorState(u);
        if (ws !== null) ws.faceDir = u.dir;
        if (!warriorCheckForEnemy(w, u)) w.setStay(u, 10, false, true, 0);
      }
    }
  } else {
    // Melee: walk in formation towards the enemy; members attack when they arrive.
    groupOrderWalk(w, g, w.posNext(target), false, 'none', 0, forced);
    for (const u of groupMembers(w, g)) {
      const ws = w.warriorState(u);
      if (ws !== null) ws.attackingUid = target.uid;
    }
    setGroupOrder(g, 'attackUnit');
    g.orderX = w.posNext(target).x;
    g.orderY = w.posNext(target).y;
    g.orderDir = 0;
    groupSetOrderTargetUnit(w, g, target);
  }
}

/** OrderAttackHouse (1320–1341). */
export function groupOrderAttackHouse(w: CombatWorld, g: GroupState, houseUid: number, clearOffenders: boolean, forced = true): void {
  const house = w.houseByUid(houseUid);
  if (house === null) return;
  if (w.allianceOf(g.owner, house.owner) !== 'enemy') return;
  if (clearOffenders && groupCanTakePlayerOrders(w, g)) groupClearOffenders(g);
  setGroupOrder(g, 'attackHouse');
  g.orderX = 0;
  g.orderY = 0;
  g.orderDir = 0;
  groupSetOrderTargetHouse(g, house);
  for (const u of groupMembers(w, g)) orderWarriorAttackHouse(w, u, house.uid, forced);
}

/** OrderHalt (1494–1511): halt is OrderWalk to the current leader tile. */
export function groupOrderHalt(w: CombatWorld, g: GroupState, clearOffenders: boolean, forced = true): void {
  if (clearOffenders && groupCanTakePlayerOrders(w, g)) groupClearOffenders(g);
  const leader = groupMembers(w, g)[0];
  const target = leader !== undefined ? w.posNext(leader) : { x: g.orderX, y: g.orderY };
  groupOrderWalk(w, g, target, false, 'halt', 0, forced);
}

/** OrderNone (1562–1572). */
export function groupOrderNone(w: CombatWorld, g: GroupState): void {
  setGroupOrder(g, 'none');
  groupClearOrderTarget(g);
  for (const u of groupMembers(w, g)) orderWarriorNone(w, u);
}

/** OrderRepeat (1606–1617). */
export function groupOrderRepeat(w: CombatWorld, g: GroupState, forced = true): void {
  switch (g.order) {
    case 'none':
      groupOrderHalt(w, g, false, forced);
      break;
    case 'walk':
      groupOrderWalk(w, g, { x: g.orderX, y: g.orderY }, false, g.orderWalkKind, 0, forced);
      break;
    case 'attackHouse': {
      const house = groupOrderTargetHouse(w, g);
      if (house !== null) groupOrderAttackHouse(w, g, house.uid, false, forced);
      break;
    }
    case 'attackUnit': {
      const target = groupOrderTargetUnit(w, g);
      if (target !== null) groupOrderAttackUnit(w, g, target.uid, false, forced);
      break;
    }
    default:
      break; // goStorm — out of v0
  }
}

/** HitTest (1270–1279): a member stands on the tile. */
export function groupHitTest(w: CombatWorld, g: GroupState, x: number, y: number): boolean {
  for (const u of groupMembers(w, g)) {
    if (samePoint(w.posRound(u), { x, y }) && !isDeadOrDying(u)) return true;
  }
  return false;
}

/** GetGroupByMember (2442–2450). */
export function getGroupByMember(w: CombatWorld, u: CombatUnit): GroupState | null {
  if (u.groupUid === 0) return null;
  return w.groupByUid(u.groupUid);
}

/** GetClosestGroup (2518–2535). */
export function getClosestGroup(w: CombatWorld, point: Pt, types: number[] | null = null): GroupState | null {
  let result: GroupState | null = null;
  let best = Number.POSITIVE_INFINITY;
  for (const g of w.groupList()) {
    if (groupIsDead(g)) continue;
    if (types !== null && !types.includes(g.groupType)) continue;
    const members = groupMembers(w, g);
    if (members.length === 0) continue;
    const dist = lengthSqr(w.posRound(members[0]), point);
    if (dist < best) {
      best = dist;
      result = g;
    }
  }
  return result;
}

/** GetGroupsInRadius (2538–2566): every fifth member is sampled. */
export function getGroupsInRadius(w: CombatWorld, point: Pt, sqrRadius: number, types: number[] | null = null): GroupState[] {
  const out: GroupState[] = [];
  for (const g of w.groupList()) {
    if (groupIsDead(g) || (types !== null && !types.includes(g.groupType))) continue;
    const members = groupMembers(w, g);
    for (let k = 0; k < members.length; k += 5) {
      const u = members[k];
      if (isDeadOrDying(u)) continue;
      if (lengthSqr(w.posRound(u), point) <= sqrRadius) {
        out.push(g);
        break;
      }
    }
  }
  return out;
}

/** GetGroupsMemberInRadius (2569–2609): nearest member per group within the radius. */
export function getGroupsMemberInRadius(
  w: CombatWorld,
  point: Pt,
  sqrRadius: number,
  types: number[] | null = null,
): { units: CombatUnit[]; groups: GroupState[] } {
  const units: CombatUnit[] = [];
  const groups: GroupState[] = [];
  for (const g of w.groupList()) {
    if (groupIsDead(g) || (types !== null && !types.includes(g.groupType))) continue;
    const members = groupMembers(w, g);
    let best: CombatUnit | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let k = 0; k < members.length; k += 5) {
      const u = members[k];
      if (isDeadOrDying(u)) continue;
      const d = lengthSqr(w.posRound(u), point);
      if (d <= bestDist) {
        bestDist = d;
        best = u;
      }
    }
    if (best !== null && bestDist <= sqrRadius) {
      units.push(best);
      groups.push(g);
    }
  }
  return { units, groups };
}

// ---------------------------------------------------------------------------------------------
// Spawning (the game's script group constructor 279–337 and WarriorTrained 2455–2487)

/** Create a 1-member group around an existing warrior (WarriorTrained, hndComputer path). */
export function createSoloGroup(w: CombatWorld, u: CombatUnit, dir: number): GroupState {
  const g = w.newGroup(u.owner, groupTypeOf(u.type), w.posRound(u).x, w.posRound(u).y, dir, 1);
  addGroupMember(w, g, u, -1);
  return g;
}

/** AddMember (683–697). */
export function addGroupMember(w: CombatWorld, g: GroupState, u: CombatUnit, index = -1): void {
  if (index >= 0) g.memberUids.splice(index, 0, u.uid);
  else g.memberUids.push(u.uid);
  u.groupUid = g.uid;
  const ws = w.warriorState(u);
  if (ws !== null) ws.faceDir = g.orderDir;
}

/**
 * Spawn a whole group (TKMUnitGroup.Create from script 279–337): 1 group-condition draw, then one
 * unit per formation slot (each spawnUnit draws its own condition, which the group overrides).
 */
export function spawnGroup(
  w: CombatWorld,
  owner: number,
  type: number,
  x: number,
  y: number,
  dir: number,
  unitsPerRow: number,
  count: number,
): GroupState {
  if (dir < 1 || dir > 8) throw new Error(`spawnGroup: dir must be dirN..dirNW (1..8), got ${dir}`);
  const newCondition = delphiRound(UNIT_MAX_CONDITION * (UNIT_CONDITION_BASE + w.drawS2(UNIT_CONDITION_RANDOM)));
  const g = w.newGroup(owner, groupTypeOf(type), x, y, dir, unitsPerRow);
  for (let i = 0; i < count; i++) {
    const p = getPositionInGroup2(x, y, dir, i, unitsPerRow, w.mapX, w.mapY);
    if (!p.fits) continue;
    const u = w.spawnUnit(owner, type, p.x, p.y, dir);
    addGroupMember(w, g, u, -1);
    const ws = w.warriorState(u);
    if (ws !== null) ws.condition = newCondition;
  }
  groupSetUnitsPerRow(g, unitsPerRow);
  return g;
}
