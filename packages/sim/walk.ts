// walk.ts — port of the TKMUnitActionWalkTo.Execute essentials (KM_UnitActionWalkTo.pas 1147–1326)
// plus the speed/direction math the walk needs (KM_ResUnits.pas, KM_Points.pas).
//
// Frozen essentials (docs/M2B-SPIKE.md 2.4), all line refs into the r15472 checkout:
//  - done when fWalkFrom = fWalkTo (1158); abort when fNodeList.Count = 0 (1162);
//  - arrival check `KMSamePointF(PositionF, node[nodePos], distance/2)` where `distance` is the
//    ORTHO effective speed (1176–1179) and the comparison is axis-wise |dx| < eps ∧ |dy| < eps
//    (KM_Points.pas 525–528); on arrival snap PositionF to the node (1182), report walk complete
//    when nodePos >= count−1 (1221, CheckWalkComplete with fDistance = 0), else update the unit
//    direction `KMGetDirection(node[nodePos], node[nodePos+1])` (1254) and Inc(nodePos) (1294);
//  - per-axis move: dx = Sign(walkX), dy = Sign(walkY), step = diag iff dx ≠ 0 ∧ dy ≠ 0 (1318),
//    `PositionF.X += dx * Min(distance, |walkX|)` (1320–1321); AnimStep++ once per moved tick (1323).
//  - v0 skips: interaction/exchange, obstacle checks, route smoothing (SmoothDiagSideStep), target
//    following — none exist in the headless slice.
//
// Direction contract: walkTick returns 0 (dirNA) when there is no direction to set (the unit keeps
// its current direction) and otherwise the direction of the segment being walked, which is exactly
// what line 1254 stores at each arrival.
//
// Browser-safe: no node: imports.
import type { PassGrid } from './terrain.ts';
import { findPath } from './astar.ts';

export interface Walk {
  nodeList: { x: number; y: number }[];
  nodePos: number;
  walkFrom: { x: number; y: number };
  walkTo: { x: number; y: number };
  done: boolean;
  aborted: boolean;
}

export interface WalkTickResult {
  dir: number; // 0 = dirNA = no update, else dirN..dirNW (1..8)
  animStep: number; // 1 on a moved tick, else 0
  status: 'walking' | 'done' | 'aborted';
}

/**
 * Build the walk: AssembleTheRoute's Route_Make call (KM_UnitActionWalkTo.pas 480–483) with the
 * shipped AStarNew pathfinder. Returns null when no route exists (Route_Make False → empty list →
 * the action aborts; v0 reports that as null).
 */
export function startWalk(
  g: PassGrid,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Walk | null {
  const route = findPath(g, from, to);
  if (route === null) return null;
  return {
    nodeList: route,
    nodePos: 0,
    walkFrom: { x: from.x, y: from.y },
    walkTo: { x: to.x, y: to.y },
    done: false,
    aborted: false,
  };
}

/**
 * One tick of the walk action; mutates `posF` (the unit's float position) and `w`.
 * `speed` comes from walkSpeeds(spec.speedRaw).
 */
export function walkTick(
  g: PassGrid,
  w: Walk,
  posF: { x: number; y: number },
  speed: { ortho: number; diag: number },
): WalkTickResult {
  if (w.done) return { dir: 0, animStep: 0, status: 'done' };
  if (w.aborted) return { dir: 0, animStep: 0, status: 'aborted' };

  // (1) Happens when e.g. a serf stays in front of the Store and gets a Deliver task (1157–1159).
  if (w.walkFrom.x === w.walkTo.x && w.walkFrom.y === w.walkTo.y) {
    w.done = true;
    return { dir: 0, animStep: 0, status: 'done' };
  }

  // (2) Route was not built (1161–1163).
  if (w.nodeList.length === 0) {
    w.aborted = true;
    return { dir: 0, animStep: 0, status: 'aborted' };
  }

  // (3) Walk complete guard: NodePos cannot be greater than NodeCount (1165–1172).
  if (w.nodePos > w.nodeList.length - 1) {
    w.done = true;
    return { dir: 0, animStep: 0, status: 'done' };
  }

  const node = w.nodeList[w.nodePos];

  // (4) Arrival check (1176–1179): tolerance is the ortho step / 2, compared axis-wise.
  const tolerance = speed.ortho / 2;
  if (Math.abs(posF.x - node.x) < tolerance && Math.abs(posF.y - node.y) < tolerance) {
    posF.x = node.x; // snap to the exact node (1182)
    posF.y = node.y;

    // Walk complete (1220–1227): CheckWalkComplete with fDistance = 0 is "reached the last node".
    if (w.nodePos >= w.nodeList.length - 1) {
      w.done = true;
      return { dir: 0, animStep: 0, status: 'done' };
    }

    // Duplicate node: Inc the node pos and skip this step (1234–1239); dense routes never do this.
    const next = w.nodeList[w.nodePos + 1];
    if (next.x === node.x && next.y === node.y) {
      w.nodePos += 1;
      return { dir: 0, animStep: 0, status: 'walking' };
    }

    w.nodePos += 1; // Inc(fNodePos) (1294)
  }

  // (5) Move toward node[nodePos] (1313–1325).
  const target = w.nodeList[w.nodePos];
  const walkX = target.x - posF.x;
  const walkY = target.y - posF.y;
  const dx = walkX > 0 ? 1 : walkX < 0 ? -1 : 0; // Sign(walkX)
  const dy = walkY > 0 ? 1 : walkY < 0 ? -1 : 0; // Sign(walkY)
  const step = dx !== 0 && dy !== 0 ? speed.diag : speed.ortho; // 1318
  posF.x += dx * Math.min(step, Math.abs(walkX)); // 1320
  posF.y += dy * Math.min(step, Math.abs(walkY)); // 1321

  return { dir: currentDir(w), animStep: 1, status: 'walking' }; // AnimStep++ per moved tick (1323)
}

/** Direction of the segment the unit is walking (line 1254 stores the same value at each arrival). */
function currentDir(w: Walk): number {
  if (w.nodePos < 1) return 0; // first segment: keep the unit's previous/order direction
  const from = w.nodeList[w.nodePos - 1];
  const to = w.nodeList[w.nodePos];
  return kmGetDirection(to.x - from.x, to.y - from.y);
}

/**
 * Delphi Math.Round port: round half to even (the game's Round is Delphi's, used by StepsPerTile
 * and the direction bucket — exact .5 values must round to the even side to match).
 */
export function delphiRound(x: number): number {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (frac > 0.5) return floor + 1;
  if (frac < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * Effective walk steps per tick (tiles/tick) from the raw unit.dat speed:
 * speed = raw / 240 (GetSpeed 436–440), StepsPerTile = Round(1/speed) (602),
 * StepsPerTileDiag = Round(1.41/speed) (603), effective step = 1 / StepsPerTile (443–453).
 * Speed 24 → ortho 1/10, diag 1/14; patched mounted speed 40 → 1/6, 1/8.
 */
export function walkSpeeds(speedRaw: number): { ortho: number; diag: number } {
  const speed = speedRaw / 240;
  return {
    ortho: 1 / delphiRound(1 / speed),
    diag: 1 / delphiRound(1.41 / speed),
  };
}

/**
 * KMGetDirection(X, Y) — KM_Points.pas 834–849 + 826–831: dirNA (0) for a zero delta, else
 * ang = atan2(Y/d², X/d²) + π/2 and bucket = Round(deg + 3600 + 22.5) mod 360 div 45 + 1,
 * so dirN = 1 … dirNW = 8 (KM_Points.pas 8).
 */
export function kmGetDirection(dx: number, dy: number): number {
  const distSqr = dx * dx + dy * dy;
  if (!(distSqr > 0)) return 0; // dirNA (841–848, threshold 0)
  const ang = Math.atan2(dy / distSqr, dx / distSqr) + Math.PI / 2; // (843–845)
  const deg = (ang / Math.PI) * 180;
  const bucket = delphiRound(deg + 3600 + 22.5) % 360; // (830)
  return Math.floor(bucket / 45) + 1;
}
