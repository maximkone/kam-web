// ui/gametest.ts — window.__gameTest, the read-only test surface of the game screen (B2A). tools/uicheck/b2.ts
// drives the page with real mouse input and reads these helpers. Only `grant*` helpers write the world, and
// only as a test setup (the same kind of setup grant tools/skirmish/cli.ts makes); the human's actions never go
// through them: they are the UI's commands.
import type { Skirmish } from '../../../packages/sim/skirmish.ts';
import type { EconomyWorld } from '../../../packages/sim/economy.ts';
import { CELL } from './model.ts';
import type { GameUi, PlayView } from './ui.ts';

export interface GameTestEnv {
  sk: () => Skirmish | null;
  hand: () => number;
  view: PlayView;
  ui: GameUi;
}

const HT_STORE = 11;
const HT_SCHOOL = 13;
const HT_BARRACKS = 21;
const UT_MILITIA = 14;

/** The straight road from tile (ax, ay) in one of four directions to the store's paved road block: the road tiles
 *  to lay (from (ax, ay), at least two, none already a road), or null. Checked in Node first (scratch plot probe). */
function roadLineFrom(w: EconomyWorld, hand: number, c: { x: number; y: number }, ax: number, ay: number, ex: number, ey: number): { x: number; y: number }[] | null {
  for (const [ux, uy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
    const line: { x: number; y: number }[] = [];
    let ok = false;
    for (let k = 0; k <= 8; k++) {
      const x = ax + ux * k;
      const y = ay + uy * k;
      if (x === ex && y === ey) break; // the house's own entrance is taken by its plan
      if (w.isRoadTile(x, y)) {
        ok = k >= 2 && Math.max(Math.abs(x - c.x), Math.abs(y - c.y)) <= 3;
        break;
      }
      if (!w.canAddFieldPlan(hand, x, y, 'road')) break;
      line.push({ x, y });
    }
    if (ok) return line;
  }
  return null;
}

/** Install window.__gameTest. */
export function installGameTest(env: GameTestEnv): void {
  const world = (): EconomyWorld => {
    const s = env.sk();
    if (s === null) throw new Error('__gameTest: no skirmish running');
    return s.world;
  };

  // The renderer's picker and its drawn tiles do not share one centre (a tile's centre picks the tile two rows lower),
  // so search a wide grid of points for one that the picker maps back to this tile.
  const screenOfTile = (x: number, y: number): { x: number; y: number } | null => {
    const offs = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1, 1.25, -1.25, 1.5, -1.5];
    for (const oy of offs) {
      for (const ox of offs) {
        const p = env.view.viewportOf((x - 0.5 + ox) * CELL, (y - 0.5 + oy) * CELL);
        const t = env.view.tileAtViewport(p.x, p.y);
        if (t !== null && t.x === x && t.y === y) return p;
      }
    }
    return null;
  };

  const storeOf = (w: EconomyWorld, hand: number): { x: number; y: number } => {
    const s = w.findFirstHouse(HT_STORE, hand);
    if (s === null) throw new Error('__gameTest: the hand has no store');
    return { x: s.entrance.x, y: s.entrance.y };
  };

  /** A spot near the store where a house of this type is built the way a player builds it: the plan, and a straight
   *  road from the tile below its entrance to the store's paved road block (wares travel by road only). In tiles and
   *  screen px; `road` is the drag from the first to the last road tile, or null when no screen spot was found. */
  const placementFor = (typeId: number, stats?: Record<string, number>): { x: number; y: number; sx: number; sy: number; road: { a: { sx: number; sy: number }; b: { sx: number; sy: number } } | null } | null => {
    const w = world();
    const count = (k: string): void => {
      if (stats !== undefined) stats[k] = (stats[k] ?? 0) + 1;
    };
    const hand = env.hand();
    const c = storeOf(w, hand);
    const onScreen = (p: { x: number; y: number }): boolean => {
      if (p.x <= 40 || p.x >= window.innerWidth - 40 || p.y <= 90 || p.y >= window.innerHeight - 90) return false;
      for (const id of ['buildmenu', 'minimap', 'info']) {
        const el = document.getElementById(id);
        if (el === null || el.classList.contains('hide')) continue;
        const r = el.getBoundingClientRect();
        if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) return false;
      }
      return true;
    };
    for (let r = 4; r <= 14; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = c.x + dx;
          const y = c.y + dy;
          if (!w.canAddHousePlan(hand, typeId, x, y)) continue;
          count('plan');
          if (!w.canWalkTo(c.x, c.y + 1, x, y + 1)) continue; // the builder's point: the tile below the entrance (sim getBestWorker)
          count('walk');
          const line = roadLineFrom(w, hand, c, x, y + 1, x, y);
          if (line === null) continue;
          count('road');
          const pe = screenOfTile(x, y);
          const pa = screenOfTile(line[0]!.x, line[0]!.y);
          const pb = screenOfTile(line[line.length - 1]!.x, line[line.length - 1]!.y);
          if (pe === null || pa === null || pb === null) {
            count('noScreenTile');
            continue;
          }
          if (!onScreen(pe) || !onScreen(pa) || !onScreen(pb)) {
            count('offScreen');
            continue;
          }
          const road = {
            a: { sx: Math.round(pa.x), sy: Math.round(pa.y) },
            b: { sx: Math.round(pb.x), sy: Math.round(pb.y) },
          };
          return { x, y, sx: Math.round(pe.x), sy: Math.round(pe.y), road };
        }
      }
    }
    return null;
  };

  const scanSpot = (w: EconomyWorld, hand: number, r0: number, r1: number): { x: number; y: number } | null => {
    const c = storeOf(w, hand);
    for (let r = r0; r <= r1; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = c.x + dx;
          const y = c.y + dy;
          if (w.tileWalkable(x, y) && w.houseAt(x, y) === null && !w.isRoadTile(x, y)) return { x, y };
        }
      }
    }
    return null;
  };

  const api = {
    hand: (): number => env.hand(),
    tick: (): number => env.sk()?.world.tickCount ?? -1,
    counts(): { tick: number; houses: number; done: number; plans: number; fields: number; units: number; soldiers: number } {
      const w = world();
      const hand = env.hand();
      const cs = w.constructionState(hand);
      const mine = w.houses.filter((h) => h.owner === hand && !h.destroyed);
      const units = w.units.filter((u) => u.owner === hand && !u.dead);
      return {
        tick: w.tickCount,
        houses: mine.length,
        done: mine.filter((h) => h.buildState === 'done').length,
        plans: cs.plans.filter((p) => p.status !== 'empty').length,
        fields: cs.fields.length,
        units: units.length,
        soldiers: units.filter((u) => w.groupOf(u.uid) !== null).length,
      };
    },
    houses(typeId?: number): { uid: number; typeId: number; state: string; x: number; y: number; done: boolean }[] {
      const w = world();
      const hand = env.hand();
      return w.houses
        .filter((h) => h.owner === hand && !h.destroyed && (typeId === undefined || h.typeId === typeId))
        .map((h) => ({ uid: h.uid, typeId: h.typeId, state: h.buildState, x: h.x, y: h.y, done: h.buildState === 'done' }));
    },
    /** The house types the hand can build now, cheapest (wood + stone) first. */
    unlockedTypes(): number[] {
      const w = world();
      const out: number[] = [];
      for (let t = 0; t < 30; t++) if (w.houseSpecOf(t) !== undefined && w.houseCanBuild(env.hand(), t)) out.push(t);
      const cost = (t: number): number => (w.houseSpecOf(t)?.woodCost ?? 0) + (w.houseSpecOf(t)?.stoneCost ?? 0);
      return out.sort((a, b) => cost(a) - cost(b));
    },
    placementFor,
    placementDebug(typeId: number): Record<string, number> {
      const stats: Record<string, number> = { viewW: window.innerWidth, viewH: window.innerHeight };
      stats.found = placementFor(typeId, stats) === null ? 0 : 1;
      return stats;
    },
    screenOfTile,
    mapSize(): { mapX: number; mapY: number } {
      const w = world();
      return { mapX: w.mapX, mapY: w.mapY };
    },
    /** A tile where a corn field can go (canAddFieldPlan), near the store, in tiles and screen px. */
    cornSpot(): { x: number; y: number; sx: number; sy: number } | null {
      const w = world();
      const hand = env.hand();
      const c = storeOf(w, hand);
      for (let r = 2; r <= 14; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = c.x + dx;
            const y = c.y + dy;
            if (!w.canAddFieldPlan(hand, x, y, 'corn')) continue;
            const p = screenOfTile(x, y);
            if (p !== null) return { x, y, sx: Math.round(p.x), sy: Math.round(p.y) };
          }
        }
      }
      return null;
    },
    /** Three road-able tiles in a row (x, y), (x+1, y), (x+2, y) near the store: the ends in screen px. */
    roadSpot(): { a: { x: number; y: number; sx: number; sy: number }; b: { x: number; y: number; sx: number; sy: number } } | null {
      const w = world();
      const hand = env.hand();
      const c = storeOf(w, hand);
      for (let r = 2; r <= 16; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = c.x + dx;
            const y = c.y + dy;
            if (!w.canAddFieldPlan(hand, x, y, 'road') || !w.canAddFieldPlan(hand, x + 1, y, 'road') || !w.canAddFieldPlan(hand, x + 2, y, 'road')) continue;
            const pa = screenOfTile(x, y);
            const pb = screenOfTile(x + 2, y);
            if (pa === null || pb === null) continue;
            return {
              a: { x, y, sx: Math.round(pa.x), sy: Math.round(pa.y) },
              b: { x: x + 2, y, sx: Math.round(pb.x), sy: Math.round(pb.y) },
            };
          }
        }
      }
      return null;
    },
    /** A reachable tile next to the store where a house plan is refused (a clear invalid placement). */
    invalidSpot(typeId: number): { x: number; y: number; sx: number; sy: number } | null {
      const w = world();
      const hand = env.hand();
      const c = storeOf(w, hand);
      for (let r = 1; r <= 12; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = c.x + dx;
            const y = c.y + dy;
            if (w.canAddHousePlan(hand, typeId, x, y)) continue;
            const p = screenOfTile(x, y);
            const onScreen = p !== null && p.x > 40 && p.x < window.innerWidth - 40 && p.y > 90 && p.y < window.innerHeight - 90;
            if (p !== null && onScreen) return { x, y, sx: Math.round(p.x), sy: Math.round(p.y) };
          }
        }
      }
      return null;
    },
    /** Make a finished house of a type beside the hand's store (a setup grant, like tools/skirmish). */
    grantHouse(typeId: number): number {
      const w = world();
      const hand = env.hand();
      const spec = w.houseSpecOf(typeId);
      if (spec === undefined) return -1;
      const c = storeOf(w, hand);
      for (let r = 4; r <= 16; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
            const x = c.x + dx;
            const y = c.y + dy;
            if (!w.canPlaceHouse(typeId, x + spec.entranceDx, y)) continue;
            const h = w.spawnHouse(typeId, x, y, hand);
            w.houseCreatedFor(hand, typeId);
            return h.uid;
          }
        }
      }
      return -1;
    },
    /** A barracks with one recruit (a setup grant). */
    grantBarracks(): number {
      const uid = api.grantHouse(HT_BARRACKS);
      if (uid > 0) world().barracksAddRecruit(uid);
      return uid;
    },
    /** A militia group of n for the human hand near its store (a setup grant). */
    grantSoldiers(n: number): number {
      const w = world();
      const hand = env.hand();
      const spot = scanSpot(w, hand, 3, 9);
      if (spot === null) return -1;
      return w.spawnGroup(hand, UT_MILITIA, spot.x, spot.y, 4, 3, n).uid;
    },
    /** The human's soldiers with their group and screen position. */
    soldiers(): { uid: number; groupUid: number; x: number; y: number; sx: number | null; sy: number | null }[] {
      const w = world();
      const hand = env.hand();
      const out: { uid: number; groupUid: number; x: number; y: number; sx: number | null; sy: number | null }[] = [];
      for (const u of w.units) {
        if (u.owner !== hand || u.dead || u.inside) continue;
        const g = w.groupOf(u.uid);
        if (g === null) continue;
        const p = env.view.viewportOfUnit(u.uid);
        out.push({ uid: u.uid, groupUid: g.uid, x: u.posF.x, y: u.posF.y, sx: p === null ? null : Math.round(p.x), sy: p === null ? null : Math.round(p.y) });
      }
      return out;
    },
    positions(uids: number[]): { uid: number; x: number; y: number }[] {
      const w = world();
      return uids.map((uid) => {
        const u = w.unitByUid(uid);
        return { uid, x: u === null ? -1 : u.posF.x, y: u === null ? -1 : u.posF.y };
      });
    },
    groupInfo(groupUid: number): { order: string; halt: boolean; members: number; unitsPerRow: number; orderX: number; orderY: number } | null {
      const g = world().groupByUid(groupUid);
      if (g === null) return null;
      const halt = g.orderWalkKind === 'halt' && (g.order === 'walk' || g.order === 'none');
      return { order: g.order, halt, members: g.memberUids.length, unitsPerRow: g.unitsPerRow, orderX: g.orderX, orderY: g.orderY };
    },
    /** Accepted commands, in log order (the sim's own CommandLog). */
    commandLog(): { tick: number; type: string; hand: number }[] {
      const s = env.sk();
      if (s === null) return [];
      return s.log.map((e) => ({ tick: e.tick, type: e.cmd.type, hand: e.cmd.hand }));
    },
    /** Every command result of the UI so far (accepted and refused), with the refusal reason. */
    results(): { tick: number; type: string; ok: boolean; reason: string }[] {
      return env.ui.inspect().results;
    },
    ghost(): ReturnType<GameUi['inspect']> {
      return env.ui.inspect();
    },
    toasts(): string[] {
      return env.ui.inspect().toasts;
    },
    /** The panel's visible title text (house name, group, unit) or ''. */
    infoTitle(): string {
      const el = document.querySelector('#info .title');
      return el === null ? '' : (el.textContent ?? '');
    },
    /** Viewport centre of a house's sprite (for a real click), or null. */
    houseCentre(uid: number): { x: number; y: number } | null {
      const r = env.view.houseRect(uid);
      return r === null ? null : { x: Math.round(r.x + r.w / 2), y: Math.round(r.y + r.h / 2) };
    },
    /** For each tile: 'road' (built), 'plan' (a road plan the builders have not finished) or 'none'. */
    roadStates(tiles: { x: number; y: number }[]): ('road' | 'plan' | 'none')[] {
      const w = world();
      const hand = env.hand();
      return tiles.map((t) => (w.isRoadTile(t.x, t.y) ? 'road' : w.hasFieldPlan(hand, t.x, t.y) === 'road' ? 'plan' : 'none'));
    },
    /** The renderer's camera and zoom. */
    camera(): { x: number; y: number; zoom: number } {
      const c = env.view.cam();
      return { x: c.x, y: c.y, zoom: env.view.zoom() };
    },
  };
  (window as unknown as Record<string, unknown>).__gameTest = api;
}
