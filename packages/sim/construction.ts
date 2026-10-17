// construction.ts — M5a headless construction slice: the per-hand plan stores (house plans, field
// plans, ready-to-build sites, hand locks) and the AI-facing queries (docs/M5-SPIKE.md §1a/§2).
//
// Source of truth: hands/KM_HandConstructions.pas (r15472, read-only reference) —
//  - TKMHousePlan {UID, HouseType, Loc, JobStatus, Worker} (:43-50), JobStatus jsEmpty/jsOpen/
//    jsTaken (:11-15); TKMHousePlanList (:55-88) with AddPlan (:686-705), BestBid (:708-727),
//    GiveTask (:791-796), ClosePlan (:741-747), RemPlan (:827-843), TryGetPlan (:846-862),
//    ReOpenPlan (:866-870), HasPlan (:799-816), GetPlansWoodDemands/GetPlansStoneDemands
//    (:1421-1440, derived from WoodCost/StoneCost — nothing stored per plan).
//  - TKMFieldPlan {Loc, FieldType, JobStatus, Worker} (:91-96); TKMFieldworksList (:100-143) with
//    AddField (:515-537), HasField (:579-591), RemFieldPlan (:562-575), CloseField (:421-431),
//    ReOpenField (:633-637), FieldCount (:460-468), BestBid (:389-407).
//  - TKMHouseList (ready-to-build sites, :18-40): AddHouse (:258-274), BestBid (:277-302,
//    reversed loop, CheckResToBuild + Assigned < MAX_WORKERS[type] + CanWalkTo), RemWorker
//    (:324-328), RemoveExtraHouses (:332-339), GetAvailableJobsCount (:305-313).
//  - MAX_WORKERS (:226-234) positional by TKMHouseType — barracks 12, store 10, sawmill 8,
//    woodcutters 6, gold mine 3.
//  - Hand plan API: CanAddHousePlan (KM_Hand.pas:1081-1115), AddHousePlan (:1294-1307, the given
//    entrance is shifted by EntranceOffsetX before storing), RemHousePlan (:1338-1350),
//    HasHousePlan (:1310-1313), CanAddFieldPlan (:1052-1058), LocHasNoAllyPlans (:1007-1017).
//  - Locks (hands/KM_HandLocks.pas): fHouseUnlocked (store released at start :62), HouseCreated →
//    UpdateReqDone (:69-83) unlocks every house whose gRes.Houses[H].ReleasedBy = aType;
//    HouseCanBuild (:87-95) = the hlDefault case of the effective lock.
//
// v0 divergences (documented, docs/M5-SPIKE.md §1a/§2):
//  - v0 hands are all allied (KM_HandsCollection default) and none is a computer, so the FOW
//    branch of CanAddHousePlan (1098-1100) is skipped — the AI ignores FOW and the human FOW check
//    is a viewer concern; `isComputer` is not modeled.
//  - Repairs, fake fields, demolition-from-plan and the "choose first storehouse" flow are out of
//    scope (spec §1a); the plan stores here are the live ones only.
//  - Plan/site/field arrays keep tombstone slots (jsEmpty entries stay in place) exactly like the
//    Pascal arrays — workers address them by index and Add* reuses the first empty slot.
//
// Browser-safe: no node: imports.
import type { HouseSpec } from '../assets/housedata.ts';
import { housePlan, houseTypeId, releasedByHouse } from '../assets/housedata.ts';

/** TKMJobStatus (:11-15). */
export type JobStatus = 'empty' | 'open' | 'taken';

/** TKMFieldType essentials (ftNone/ftRoad/ftCorn/ftWine; ftInitWine is a terrain stage). */
export type FieldType = 'none' | 'road' | 'corn' | 'wine';

/** TKMHouseBuildState (houses/KM_Houses.pas 89-95): hbsNone/hbsNoGlyph/hbsWood/hbsStone/hbsDone. */
export type BuildState = 'none' | 'noGlyph' | 'wood' | 'stone' | 'done';

/** The script id of htNone (HOUSE_ID_TO_TYPE[26] = 0). Plan slots store this when closed. */
export const HOUSE_TYPE_NONE = 26;

/** TKMHousePlan (:43-50). `x`/`y` = Loc = the house position (entrance − EntranceOffsetX). */
export interface HousePlan {
  uid: number;
  typeId: number;
  x: number;
  y: number;
  status: JobStatus;
  workerUid: number; // 0 = none (the Pascal's nil pointer)
}

/** TKMFieldPlan (:91-96). */
export interface FieldPlan {
  x: number;
  y: number;
  fieldType: FieldType;
  status: JobStatus;
  workerUid: number;
}

/** One TKMHouseList slot (:18-40): the WIP house and how many workers are on it. */
export interface BuildSite {
  houseUid: number; // 0 = empty slot
  assigned: number;
}

/** TKMHandLocks (:14-25) — the v0 subset: fHouseUnlocked by script id (hlDefault only). */
export interface HandLocks {
  unlocked: boolean[]; // indexed by script id 0..29
}

/** The per-hand construction store (docs/M5-SPIKE.md §3). */
export interface ConstructionState {
  hand: number;
  plans: HousePlan[];
  fields: FieldPlan[];
  sites: BuildSite[];
  locks: HandLocks;
  /** The builder registry (TKMHandConstructions.fWorkers, :182–185): unit uids. */
  workers: number[];
  specs: (HouseSpec | undefined)[]; // the world's houses.dat table (shared reference)
}

/** The world side of the plan API (EconomyWorld implements this structurally). */
export interface ConstructionQueries {
  readonly handCount: number;
  constructionState(hand: number): ConstructionState;
  /** The world's houses.dat table entry for a script id. */
  houseSpecOf(typeId: number): HouseSpec | undefined;
  /** tpBuild at a tile (KM_Terrain.pas 3792-3806). */
  tileBuildable(x: number, y: number): boolean;
  /** TileInMapCoords(x, y, inset) (KM_Terrain.pas 1130–1134): the usable box, inset from the border. */
  tileInMapCoordsInset(x: number, y: number, inset: number): boolean;
  /** TileGoodForField (KM_Terrain.pas 1275-1284). */
  tileGoodForField(x: number, y: number): boolean;
  /** tpMakeRoads at a tile (KM_Terrain.pas 3808-3813) — CanAddField(ftRoad). */
  tileMakeRoads(x: number, y: number): boolean;
  /** TileIsCornField. */
  tileHasCornField(x: number, y: number): boolean;
  /** TileIsWineField. */
  tileHasWineField(x: number, y: number): boolean;
  /** TileHasRoad. */
  tileHasRoad(x: number, y: number): boolean;
  /** RouteCanBeMade(a, b, tpWalk) — TKMUnit.CanWalkTo(aTo, 0). */
  canWalkTo(fromX: number, fromY: number, toX: number, toY: number): boolean;
}

// ---------------------------------------------------------------------------------------------
// Frozen tables

// MAX_WORKERS (KM_HandConstructions.pas 226-234), indexed by TKMHouseType id (0..30).
export const MAX_WORKERS: number[] = [
  0, 0, // htNone, htAny
  8, 8, 8, 12, 8, // htArmorSmithy, htArmorWorkshop, htBakery, htBarracks, htButchers
  6, 8, 6, 3, 10, // htCoalMine, htFarm, htFisherHut, htGoldMine, htInn
  4, 8, 10, 8, 8, // htIronMine, htIronSmithy, htMarketplace, htMetallurgists, htMill
  6, 8, 10, 8, 10, // htQuary, htSawmill, htSchool, htSiegeWorkshop, htStables
  10, 8, 8, 10, 6, // htStore, htSwine, htTannery, htTownHall, htWatchTower
  8, 8, 8, 6, // htWeaponSmithy, htWeaponWorkshop, htWineyard, htWoodcutters
];

export const BID_MODIF = 5; // KM_HandConstructions.pas 222

/** MAX_WORKERS for a script id (0..29). */
export function maxWorkersForHouse(typeId: number): number {
  const type = houseTypeId(typeId);
  return type >= 0 && type < MAX_WORKERS.length ? MAX_WORKERS[type] : 0;
}

/** The house type a script id unlocks (gRes.Houses[H].ReleasedBy); −1 for htNone. */
export function unlockedByHouse(typeId: number): number {
  return releasedByHouse(typeId);
}

/** GetLengthDiag (KM_Points.pas 273-284): the KaM diagonal metric. */
export function diagDistance(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return dx > dy ? dx + dy * 0.41 : dy + dx * 0.41;
}

// ---------------------------------------------------------------------------------------------
// State

/** A fresh per-hand construction store: store unlocked, everything else locked (KM_HandLocks 62). */
export function createConstructionState(hand: number, specs: (HouseSpec | undefined)[]): ConstructionState {
  const unlocked = new Array<boolean>(30).fill(false);
  unlocked[11] = true; // htStore released at the start (KM_HandLocks.pas 62)
  return { hand, plans: [], fields: [], sites: [], locks: { unlocked }, workers: [], specs };
}

/** AddWorker (:1156–1163). */
export function addWorker(state: ConstructionState, unitUid: number): void {
  state.workers.push(unitUid);
}

/** RemWorker (:1166–1174) — by uid (the port's tasks hold uids, not indices). */
export function remWorker(state: ConstructionState, unitUid: number): void {
  const at = state.workers.indexOf(unitUid);
  if (at >= 0) state.workers.splice(at, 1);
}

/** RemoveExtraWorkers (:1178–1185): dead or dying builders leave the registry. */
export function removeExtraWorkers(state: ConstructionState, isDead: (unitUid: number) => boolean): void {
  for (let i = state.workers.length - 1; i >= 0; i--) {
    if (isDead(state.workers[i])) state.workers.splice(i, 1);
  }
}

/** HouseCreated → UpdateReqDone (KM_HandLocks.pas 69-83): unlock every house released by aType. */
export function houseCreated(locks: HandLocks, typeId: number): void {
  for (let t = 0; t < locks.unlocked.length; t++) {
    if (unlockedByHouse(t) === typeId) locks.unlocked[t] = true;
  }
}

/** HouseCanBuild (KM_HandLocks.pas 87-95), the hlDefault case (v0 has no mission locks). */
export function houseCanBuild(locks: HandLocks, typeId: number): boolean {
  return typeId >= 0 && typeId < locks.unlocked.length && locks.unlocked[typeId];
}

/** The house spec of a script id, or null. */
export function specOf(state: ConstructionState, typeId: number): HouseSpec | null {
  const spec = state.specs[typeId];
  return spec === undefined ? null : spec;
}

/** EntranceOffsetX of a script id (0 when the spec is missing). */
export function entranceOffsetX(state: ConstructionState, typeId: number): number {
  const spec = specOf(state, typeId);
  return spec !== null ? spec.entranceDx : 0;
}

/** The plan's entrance: Loc.X + EntranceOffsetX, Loc.Y (KM_Hand.pas 1298, :766). */
export function planEntrance(state: ConstructionState, plan: HousePlan): { x: number; y: number } {
  return { x: plan.x + entranceOffsetX(state, plan.typeId), y: plan.y };
}

// ---------------------------------------------------------------------------------------------
// House plan API

/**
 * TKMHousePlanList.HasPlan/TryGetPlan/RemPlan coverage test (:799-816): (x,y) is inside the plan's
 * BuildArea. Row I = y − Loc.Y + 4, col K = x − Loc.X + 3 (1..4), cell nonzero.
 */
export function planCoversTile(state: ConstructionState, plan: HousePlan, x: number, y: number): boolean {
  if (plan.status === 'empty') return false;
  const k = x - plan.x + 3;
  const i = y - plan.y + 4;
  if (i < 1 || i > 4 || k < 1 || k > 4) return false;
  const area = housePlan(plan.typeId);
  return area[i - 1][k - 1] !== 0;
}

/** HasPlan(aLoc) — the first plan covering the tile, or null. */
export function tryGetPlan(w: ConstructionQueries, hand: number, x: number, y: number): HousePlan | null {
  const state = w.constructionState(hand);
  for (const p of state.plans) if (planCoversTile(state, p, x, y)) return p;
  return null;
}

/** HasPlan(aLoc) (KM_Hand.pas:1310-1313). */
export function hasHousePlan(w: ConstructionQueries, hand: number, x: number, y: number): boolean {
  return tryGetPlan(w, hand, x, y) !== null;
}

/**
 * CanPlaceHouse (KM_Terrain.pas 4758-4781): every nonzero BuildArea cell must be tpBuild; (x,y) is
 * the entrance (shifted by EntranceOffsetX before the loop).
 */
export function canPlaceHouse(w: ConstructionQueries, typeId: number, entranceX: number, entranceY: number): boolean {
  const spec = w.houseSpecOf(typeId);
  const locX = entranceX - (spec !== undefined ? spec.entranceDx : 0);
  const area = housePlan(typeId);
  for (let i = 1; i <= 4; i++) {
    for (let k = 1; k <= 4; k++) {
      if (area[i - 1][k - 1] === 0) continue;
      if (!w.tileBuildable(locX + k - 3, entranceY + i - 4)) return false;
    }
  }
  return true;
}

/**
 * TKMHand.CanAddHousePlan (KM_Hand.pas:1081-1115): CanPlaceHouse + per BuildArea cell the map
 * coords, no field plans / house plans of allies (v0: all hands) on or around the cell.
 */
export function canAddHousePlan(w: ConstructionQueries, hand: number, typeId: number, entranceX: number, entranceY: number): boolean {
  if (!canPlaceHouse(w, typeId, entranceX, entranceY)) return false;
  const state = w.constructionState(hand);
  const offset = entranceOffsetX(state, typeId);
  const area = housePlan(typeId);
  for (let i = 1; i <= 4; i++) {
    for (let k = 1; k <= 4; k++) {
      if (area[i - 1][k - 1] === 0) continue;
      const tx = entranceX - offset + k - 3;
      const ty = entranceY + i - 4;
      if (!w.tileInMapCoordsInset(tx, ty, 1)) return false;
      for (let j = 0; j < w.handCount; j++) {
        if (hasFieldPlan(w, j, tx, ty) !== 'none') return false;
        for (let s = -1; s <= 1; s++) {
          for (let t = -1; t <= 1; t++) {
            if (hasHousePlan(w, j, tx + s, ty + t)) return false;
          }
        }
      }
    }
  }
  return true;
}

/**
 * TKMHandPlanList.AddPlan (KM_Hand.pas:1294-1301 + KM_HandConstructions.pas:686-705): the given
 * entrance is shifted by EntranceOffsetX, the plan goes into the first empty slot as jsOpen.
 * The caller checks canAddHousePlan (the Pascal command layer does).
 */
export function addHousePlan(
  w: ConstructionQueries,
  hand: number,
  typeId: number,
  entranceX: number,
  entranceY: number,
  uid: number,
): HousePlan {
  const state = w.constructionState(hand);
  const plan: HousePlan = {
    uid,
    typeId,
    x: entranceX - entranceOffsetX(state, typeId),
    y: entranceY,
    status: 'open',
    workerUid: 0,
  };
  let at = state.plans.findIndex((p) => p.status === 'empty');
  if (at < 0) {
    at = state.plans.length;
    state.plans.push(plan);
  } else {
    state.plans[at] = plan;
  }
  return plan;
}

/** RemPlan (:827-843) + KM_Hand.RemHousePlan (:1338-1350). Returns the removed plan, or null. */
export function remHousePlan(w: ConstructionQueries, hand: number, x: number, y: number): HousePlan | null {
  const plan = tryGetPlan(w, hand, x, y);
  if (plan === null) return null;
  const state = w.constructionState(hand);
  closePlan(plan);
  return plan;
}

/** ClosePlan (:741–747): the slot becomes jsEmpty and the type htNone. */
export function closePlan(plan: HousePlan): void {
  plan.typeId = HOUSE_TYPE_NONE;
  plan.x = 0;
  plan.y = 0;
  plan.status = 'empty';
  plan.workerUid = 0;
}

/** ReOpenPlan (:866-870): a dead/cancelled worker's plan becomes open again. */
export function reopenPlan(plan: HousePlan): void {
  plan.status = 'open';
  plan.workerUid = 0;
}

/** GiveTask (:791-796): the plan is taken by a worker. */
export function takePlan(plan: HousePlan, workerUid: number): void {
  plan.status = 'taken';
  plan.workerUid = workerUid;
}

/** GetAvailableJobsCount (:730-738). */
export function openPlanCount(state: ConstructionState): number {
  let n = 0;
  for (const p of state.plans) if (p.status === 'open') n += 1;
  return n;
}

/** BestBid (:708-727): the nearest open plan the worker can walk to (forward loop, strict <). */
export function bestBidPlan(
  w: ConstructionQueries,
  hand: number,
  workerX: number,
  workerY: number,
): HousePlan | null {
  const state = w.constructionState(hand);
  let best: HousePlan | null = null;
  let bestBid = Number.POSITIVE_INFINITY;
  for (const p of state.plans) {
    if (p.status !== 'open') continue;
    if (!w.canWalkTo(workerX, workerY, p.x, p.y)) continue;
    const bid = diagDistance(workerX, workerY, p.x, p.y);
    if (bid < bestBid) {
      bestBid = bid;
      best = p;
    }
  }
  return best;
}

/** GetPlansWoodDemands (:1432-1440): every plan with HouseType <> htNone counts. */
export function plansWoodDemands(state: ConstructionState): number {
  let sum = 0;
  for (const p of state.plans) {
    if (p.typeId === HOUSE_TYPE_NONE) continue;
    const spec = specOf(state, p.typeId);
    if (spec !== null) sum += spec.woodCost;
  }
  return sum;
}

/** GetPlansStoneDemands (:1421-1429). */
export function plansStoneDemands(state: ConstructionState): number {
  let sum = 0;
  for (const p of state.plans) {
    if (p.typeId === HOUSE_TYPE_NONE) continue;
    const spec = specOf(state, p.typeId);
    if (spec !== null) sum += spec.stoneCost;
  }
  return sum;
}

// ---------------------------------------------------------------------------------------------
// Field plan API

/** TKMFieldworksList.HasField (:579-591): the first field plan on the tile. */
export function hasFieldPlan(w: ConstructionQueries, hand: number, x: number, y: number): FieldType {
  const state = w.constructionState(hand);
  for (const f of state.fields) {
    if (f.status !== 'empty' && f.x === x && f.y === y) return f.fieldType;
  }
  return 'none';
}

/** TKMFieldworksList.FieldCount (:460-468). */
export function fieldCount(state: ConstructionState, fieldType: FieldType): number {
  let n = 0;
  for (const f of state.fields) if (f.fieldType === fieldType) n += 1;
  return n;
}

/** GetAvailableJobsCount (:410-418). */
export function openFieldCount(state: ConstructionState): number {
  let n = 0;
  for (const f of state.fields) if (f.status === 'open') n += 1;
  return n;
}

/**
 * TKMHand.CanAddFieldPlan (KM_Hand.pas:1052-1058): gTerrain.CanAddField + no field plan here + no
 * house plan here + no ally field/house plans (v0: all hands are allied).
 */
export function canAddFieldPlan(w: ConstructionQueries, hand: number, x: number, y: number, fieldType: FieldType): boolean {
  let ok: boolean;
  switch (fieldType) {
    case 'road':
      ok = w.tileMakeRoads(x, y); // CanAddField ftRoad: tpMakeRoads (KM_Terrain.pas 4858)
      break;
    case 'corn':
    case 'wine':
      ok = w.tileGoodForField(x, y); // TileGoodForField (KM_Terrain.pas 4860)
      break;
    default:
      return false;
  }
  if (!ok) return false;
  if (hasFieldPlan(w, hand, x, y) !== 'none') return false;
  if (hasHousePlan(w, hand, x, y)) return false;
  for (let j = 0; j < w.handCount; j++) {
    if (j === hand) continue;
    if (hasFieldPlan(w, j, x, y) !== 'none') return false;
    if (hasHousePlan(w, j, x, y)) return false;
  }
  return true;
}

/** AddField (:515-537): first empty slot, jsOpen. The caller checks canAddFieldPlan. */
export function addFieldPlan(w: ConstructionQueries, hand: number, x: number, y: number, fieldType: FieldType): FieldPlan {
  const state = w.constructionState(hand);
  const field: FieldPlan = { x, y, fieldType, status: 'open', workerUid: 0 };
  let at = state.fields.findIndex((f) => f.status === 'empty');
  if (at < 0) {
    at = state.fields.length;
    state.fields.push(field);
  } else {
    state.fields[at] = field;
  }
  return field;
}

/** RemFieldPlan (:562-575). Returns the removed field, or null. */
export function remFieldPlan(w: ConstructionQueries, hand: number, x: number, y: number): FieldPlan | null {
  const state = w.constructionState(hand);
  for (const f of state.fields) {
    if (f.status !== 'empty' && f.x === x && f.y === y) {
      closeField(f);
      return f;
    }
  }
  return null;
}

/** CloseField (:421–431): the slot becomes jsEmpty. */
export function closeField(field: FieldPlan): void {
  field.x = 0;
  field.y = 0;
  field.fieldType = 'none';
  field.status = 'empty';
  field.workerUid = 0;
}

/** ReOpenField (:633-637). */
export function reopenField(field: FieldPlan): void {
  field.status = 'open';
  field.workerUid = 0;
}

/** GiveTask (:471-476). */
export function takeField(field: FieldPlan, workerUid: number): void {
  field.status = 'taken';
  field.workerUid = workerUid;
}

/** BestBid (:389-407): the nearest open field the worker can walk to. */
export function bestBidField(
  w: ConstructionQueries,
  hand: number,
  workerX: number,
  workerY: number,
): FieldPlan | null {
  const state = w.constructionState(hand);
  let best: FieldPlan | null = null;
  let bestBid = Number.POSITIVE_INFINITY;
  for (const f of state.fields) {
    if (f.status !== 'open') continue;
    if (!w.canWalkTo(workerX, workerY, f.x, f.y)) continue;
    const bid = diagDistance(workerX, workerY, f.x, f.y);
    if (bid < bestBid) {
      bestBid = bid;
      best = f;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Ready-to-build site list (TKMHouseList)

/** AddHouse (:258-274): first slot with no house, Assigned = 0. */
export function addSite(state: ConstructionState, houseUid: number): BuildSite {
  const site: BuildSite = { houseUid, assigned: 0 };
  let at = state.sites.findIndex((s) => s.houseUid === 0);
  if (at < 0) {
    at = state.sites.length;
    state.sites.push(site);
  } else {
    state.sites[at] = site;
  }
  return site;
}

/** The site of a house, or null. */
export function siteOf(state: ConstructionState, houseUid: number): BuildSite | null {
  for (const s of state.sites) if (s.houseUid === houseUid) return s;
  return null;
}

/** RemoveExtraHouses (:332-339): destroyed/complete sites with no workers left. */
export function removeExtraSites(state: ConstructionState, isGoneOrComplete: (houseUid: number) => boolean): void {
  for (const s of state.sites) {
    if (s.houseUid === 0 || s.assigned !== 0) continue;
    if (isGoneOrComplete(s.houseUid)) s.houseUid = 0;
  }
}

/** RemWorker (:324-328). */
export function remSiteWorker(site: BuildSite): void {
  site.assigned -= 1;
}

/** GetAvailableJobsCount (:305-313): sites with a house that can be built. */
export function siteJobCount(state: ConstructionState, canBuild: (houseUid: number) => boolean): number {
  let n = 0;
  for (const s of state.sites) {
    if (s.houseUid === 0) continue;
    if (canBuild(s.houseUid)) n += 1;
  }
  return n;
}

/**
 * TKMHouseList.BestBid (:277-302): the reversed loop (a tie keeps the highest index), filtered by
 * CheckResToBuild, Assigned < MAX_WORKERS[type] and a walk route to PointBelowEntrance.
 */
export function bestBidSite(
  w: ConstructionQueries,
  hand: number,
  workerX: number,
  workerY: number,
  houseOf: (houseUid: number) => { typeId: number; x: number; y: number; entranceX: number; entranceY: number; checkRes: boolean } | null,
): BuildSite | null {
  const state = w.constructionState(hand);
  let best: BuildSite | null = null;
  let bestBid = Number.POSITIVE_INFINITY;
  for (let i = state.sites.length - 1; i >= 0; i--) {
    const site = state.sites[i];
    if (site.houseUid === 0) continue;
    const house = houseOf(site.houseUid);
    if (house === null || !house.checkRes) continue;
    if (site.assigned >= maxWorkersForHouse(house.typeId)) continue;
    if (!w.canWalkTo(workerX, workerY, house.entranceX, house.entranceY + 1)) continue;
    const bid = diagDistance(workerX, workerY, house.x, house.y) + site.assigned * BID_MODIF;
    if (bid < bestBid) {
      bestBid = bid;
      best = site;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Build state + progress helpers (houses/KM_Houses.pas)

/** The build-state fields the helpers read (EconHouse satisfies this structurally). */
export interface BuildStateHouse {
  buildState: BuildState;
  buildSupplyWood: number;
  buildSupplyStone: number;
  buildReserve: number;
  buildingProgress: number;
  readyToBeBuilt: boolean;
  woodCost: number;
  stoneCost: number;
}

/** IsComplete (:1425-1428). */
export function isComplete(h: BuildStateHouse): boolean {
  return h.buildState === 'done';
}

/** IsStone (:1418-1421). */
export function isStone(h: BuildStateHouse): boolean {
  return h.buildState === 'stone';
}

/** CheckResToBuild (:1655-1663). */
export function checkResToBuild(h: BuildStateHouse): boolean {
  if (h.buildState === 'wood') return h.buildSupplyWood > 0 || h.buildReserve > 0;
  if (h.buildState === 'stone') return h.buildSupplyStone > 0 || h.buildReserve > 0;
  return false;
}

/** GetBuildWoodDelivered (:1197-1205) — what the AI reads. */
export function buildWoodDelivered(h: BuildStateHouse): number {
  switch (h.buildState) {
    case 'stone':
    case 'done':
      return h.woodCost;
    case 'wood':
      return h.buildSupplyWood + Math.ceil(h.buildingProgress / 50);
    default:
      return 0;
  }
}

/** GetBuildStoneDelivered (:1208-1216). */
export function buildStoneDelivered(h: BuildStateHouse): number {
  switch (h.buildState) {
    case 'done':
      return h.stoneCost;
    case 'wood':
      return h.buildSupplyStone;
    case 'stone':
      return h.buildSupplyStone + Math.ceil(h.buildingProgress / 50) - h.woodCost;
    default:
      return 0;
  }
}

/** GetBuildResourceDelivered (:1219-1222). */
export function buildResourceDelivered(h: BuildStateHouse): number {
  return buildWoodDelivered(h) + buildStoneDelivered(h);
}

/** GetBuildResDeliveredPercent (:1225-1228). */
export function buildResDeliveredPercent(h: BuildStateHouse): number {
  const total = h.woodCost + h.stoneCost;
  return total === 0 ? 0 : buildResourceDelivered(h) / total;
}
