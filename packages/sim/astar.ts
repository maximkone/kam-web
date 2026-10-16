// astar.ts — port of TKMPathFindingAStarNew, the shipped pathfinder (PATHFINDER_TO_USE = 1,
// KM_Defaults.pas:104 → AStarNew; docs/M2B-SPIKE.md 2.3).
//
// Source of truth: KM_PathFindingAStarNew.pas MakeRoute (83–171) + ReturnRoute (174–194) and
// KM_PathFinding.pas (MovementCost 274–288, EstimateToFinish 310–322, DestinationReached 325–334,
// IsWalkableTile 265–270). Ported as-coded, including:
//  - the start-tile gate is on fLocA (line 92; the comment says "destination" — keep as-coded);
//  - the start node is seeded directly as fMinN, not pushed on the heap (106–114);
//  - the neighbour scan includes the centre cell and runs Y outer / X inner over
//    X ∈ [max(x−1,1), min(x+1,mapX−1)] (121–122) — the scan order decides tie-breaking;
//  - unwalkable neighbours are marked closed (Estim = C_CLOSED) and never revisited (139, 145);
//  - relaxation updates Parent/CostTo without re-sorting the heap (149–155, the game's own TODO);
//  - the loop ends when the heap empties (161–162); no iteration cap;
//  - the route is the Parent chain reversed: dense, start..end inclusive (174–194).
//  - v0: Route_Make's path cache is skipped (KM_PathFinding.pas 161–163; result-equal — no route
//    caching exists yet, docs/M2B-SPIKE.md 2.3) and MovementCost's road/unit/locked penalties do
//    not apply (no roads, no units, no locks in the headless slice) so only the 10/14 metric is used.
//
// Browser-safe: no node: imports.
import type { PassGrid } from './terrain.ts';
import { canWalkDiagonal, tileWalkable } from './terrain.ts';

interface Node {
  x: number;
  y: number;
  costTo: number;
  estim: number;
  parent: Node | null;
}

const C_CLOSED = 0xffffffff; // High(Cardinal) (85)

/** MovementCost / EstimateToFinish metric: 10 per ortho step, 14 per diagonal (274–288, 316–321). */
function stepCost(dx: number, dy: number): number {
  return dx > dy ? dx * 10 + dy * 4 : dy * 10 + dx * 4;
}

/** BinaryHeap.Push — heap.js algorithm ported via BinaryHeap.pas 55–61, 102–120. */
function heapPush(items: Node[], x: Node): void {
  items.push(x);
  siftdown(items, 0, items.length - 1);
}

/** BinaryHeap.Pop — BinaryHeap.pas 65–84, 123–144. */
function heapPop(items: Node[]): Node {
  const last = items.pop() as Node;
  if (items.length === 0) return last;
  const ret = items[0];
  items[0] = last;
  siftup(items, 0);
  return ret;
}

/** Cmp(A,B) = key(A) < key(B) with key = Estim + CostTo (HeapCmp 77–80; no nil items are pushed). */
function less(a: Node, b: Node): boolean {
  return a.estim + a.costTo < b.estim + b.costTo;
}

function siftdown(items: Node[], startpos: number, pos: number): void {
  const newitem = items[pos];
  while (pos > startpos) {
    const parentpos = (pos - 1) >> 1;
    const parent = items[parentpos];
    if (less(newitem, parent)) {
      items[pos] = parent;
      pos = parentpos;
      continue;
    }
    break;
  }
  items[pos] = newitem;
}

function siftup(items: Node[], pos: number): void {
  const endpos = items.length;
  const startpos = pos;
  const newitem = items[pos];
  let childpos = 2 * pos + 1;
  while (childpos < endpos) {
    const rightpos = childpos + 1;
    if (rightpos < endpos && !less(items[childpos], items[rightpos])) childpos = rightpos;
    items[pos] = items[childpos];
    pos = childpos;
    childpos = 2 * pos + 1;
  }
  items[pos] = newitem;
  siftdown(items, startpos, pos);
}

/**
 * Find a route from `from` to `to` (dense, start..end inclusive) or null when none exists.
 * DestinationReached for a location target with fDistance = 0 is the exact tile (325–334).
 */
export function findPath(
  g: PassGrid,
  from: { x: number; y: number },
  to: { x: number; y: number },
): { x: number; y: number }[] | null {
  if (!tileWalkable(g, from.x, from.y)) return null; // line 92 (as-coded)

  const stride = g.mapX + 1;
  const visited = new Map<number, Node>(); // generation-checked fOpenRef (69–74)
  const key = (x: number, y: number): number => y * stride + x;
  const reached = (n: Node): boolean => n.x === to.x && n.y === to.y;

  const start: Node = {
    x: from.x,
    y: from.y,
    costTo: 0,
    estim: stepCost(Math.abs(to.x - from.x), Math.abs(to.y - from.y)),
    parent: null,
  };
  visited.set(key(from.x, from.y), start);

  const heap: Node[] = [];
  let minN: Node = start; // Seed (114): the start node is fMinN directly, no heap push

  while (!reached(minN)) {
    minN.estim = C_CLOSED; // (118)

    const yFrom = Math.max(minN.y - 1, 1);
    const yTo = Math.min(minN.y + 1, g.mapY - 1);
    const xFrom = Math.max(minN.x - 1, 1);
    const xTo = Math.min(minN.x + 1, g.mapX - 1);
    for (let y = yFrom; y <= yTo; y++) {
      for (let x = xFrom; x <= xTo; x++) {
        const k = key(x, y);
        const n = visited.get(k);
        if (n === undefined) {
          if (!canWalkDiagonal(g, minN, x, y)) continue;
          const fresh: Node = { x, y, costTo: 0, estim: 0, parent: minN };
          visited.set(k, fresh);
          if (tileWalkable(g, x, y)) {
            fresh.costTo = minN.costTo + stepCost(Math.abs(minN.x - x), Math.abs(minN.y - y));
            fresh.estim = stepCost(Math.abs(to.x - x), Math.abs(to.y - y));
            heapPush(heap, fresh);
          } else {
            fresh.estim = C_CLOSED; // (139)
          }
        } else if (n.estim !== C_CLOSED) {
          if (!canWalkDiagonal(g, minN, x, y)) continue;
          const newCost = stepCost(Math.abs(minN.x - x), Math.abs(minN.y - y));
          if (minN.costTo + newCost < n.costTo) {
            n.parent = minN;
            n.costTo = minN.costTo + newCost; // no heap re-sort (149–155, as-coded)
          }
        }
      }
    }

    if (heap.length === 0) break; // (161–162)
    minN = heapPop(heap);
  }

  if (!reached(minN)) return null;

  const route: { x: number; y: number }[] = [];
  for (let n: Node | null = minN; n !== null; n = n.parent) route.push({ x: n.x, y: n.y });
  route.reverse(); // ReturnRoute (174–194)
  return route;
}
