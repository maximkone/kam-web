// sim.ts — headless sim skeleton: tick order + units + walk orders (docs/M2B-SPIKE.md 2.6, 3).
//
// Tick order frozen by M2 (KM_Game.pas PlayGameTick 3064–3145): updateUnits (hands) → the single
// RNG draw (RunningTimer) → apply queued commands. orderWalk() only queues a command; it executes
// on the next tick, exactly like gicArmyWalk (KM_GameInputProcess.pas 1012, 1211–1215).
// The RNG state is seeded deterministically (1) for v0 — no parity claim yet, only the draw count
// (one per tick) is frozen so M2c can thread the real seed.
//
// Order application (v0, no action stack — docs/M2B-SPIKE.md 2.5):
//  - idle unit: route from its current tile (fWalkFrom := fUnit.Position, KM_UnitActionWalkTo 168);
//  - walking unit: route from the node it is heading to (fWalkFrom := fNodeList[fNodePos], 517 —
//    the game applies this at the next node arrival via CheckForNewDestination; building it at
//    order time gives the same route on static terrain while the unit keeps walking the current
//    segment). When the new route fails, the game aborts at the next node arrival (1210); v0 keeps
//    the current walk instead (no mid-tile freeze; the viewer pre-checks findPath for its HUD flash).
//
// Browser-safe: no node: imports.
import type { PassGrid } from './terrain.ts';
import { tileWalkable } from './terrain.ts';
import type { UnitSpec } from '../assets/unitdat.ts';
import type { Walk } from './walk.ts';
import { startWalk, walkSpeeds, walkTick } from './walk.ts';
import { step as rngStep } from './rng.ts';

export interface SimUnit {
  uid: number;
  owner: number;
  type: number; // unit.dat record index (UNIT_ID_TO_TYPE id: 0 = Serf, 14 = Militia, 22 = Knight)
  posF: { x: number; y: number };
  dir: number; // 0 = dirNA until an arrival sets it (KM_UnitActionWalkTo 1254)
  animStep: number;
  action: 'stay' | 'walk';
  walk: Walk | null;
  speed: { ortho: number; diag: number };
}

interface PendingOrder {
  uid: number;
  x: number;
  y: number;
}

export class Sim {
  readonly units: SimUnit[] = [];

  private readonly g: PassGrid;
  private readonly specs: UnitSpec[];
  private readonly orders: PendingOrder[] = [];
  private rngState = 1; // fixed v0 seed; one draw per tick below
  private tickNumber = 0;
  private uidCounter = 1;

  constructor(g: PassGrid, units: UnitSpec[]) {
    this.g = g;
    this.specs = units;
  }

  get tickCount(): number {
    return this.tickNumber;
  }

  addUnit(type: number, x: number, y: number, owner = 0): SimUnit {
    if (!Number.isInteger(type) || type < 0 || type >= this.specs.length) {
      throw new Error(`addUnit: unit type must be a unit.dat record 0..${this.specs.length - 1}, got ${type}`);
    }
    const unit: SimUnit = {
      uid: this.uidCounter++,
      owner,
      type,
      posF: { x, y },
      dir: 0,
      animStep: 0,
      action: 'stay',
      walk: null,
      speed: walkSpeeds(this.specs[type].speedRaw),
    };
    this.units.push(unit);
    return unit;
  }

  /** Queue a walk order (gicArmyWalk). Returns false for an unknown uid; the command runs next tick. */
  orderWalk(uid: number, x: number, y: number): boolean {
    if (!this.units.some((u) => u.uid === uid)) return false;
    this.orders.push({ uid, x, y });
    return true;
  }

  /** One game tick: units → RNG draw → commands (docs/M2B-SPIKE.md 2.6). */
  tick(): void {
    this.updateUnits();
    this.rngState = rngStep(this.rngState); // RunningTimer: the one draw per tick
    this.applyOrders();
    this.tickNumber += 1;
  }

  private updateUnits(): void {
    for (const u of this.units) {
      if (u.action !== 'walk' || u.walk === null) continue;
      const r = walkTick(this.g, u.walk, u.posF, u.speed);
      if (r.dir !== 0) u.dir = r.dir;
      u.animStep += r.animStep;
      if (r.status !== 'walking') {
        u.action = 'stay';
        u.walk = null;
      }
    }
  }

  private applyOrders(): void {
    while (this.orders.length > 0) {
      const order = this.orders.shift() as PendingOrder;
      const u = this.units.find((v) => v.uid === order.uid);
      if (u === undefined) continue;
      const from =
        u.walk !== null && !u.walk.done && !u.walk.aborted
          ? { x: u.walk.nodeList[u.walk.nodePos].x, y: u.walk.nodeList[u.walk.nodePos].y }
          : { x: u.posF.x, y: u.posF.y };
      const w = startWalk(this.g, from, { x: order.x, y: order.y });
      if (w === null) continue; // no route: the unit keeps its current state (see header note)
      u.walk = w;
      u.action = 'walk';
    }
  }
}

/**
 * Three single-member spawns near the town centre (~64,64 on the 128×128 Town Tutorial map):
 * one Serf (0), one Militia (14), one Knight (22, patched mounted speed). Deterministic ring scan
 * from the centre; throws unless every returned tile is walkable.
 */
export function demoSpawns(g: PassGrid): { type: number; x: number; y: number }[] {
  const centreX = 64;
  const centreY = 64;
  const types = [0, 14, 22]; // Serf, Militia, Knight (unit.dat records)
  const picked: { x: number; y: number }[] = [];

  const maxR = Math.min(g.mapX, g.mapY);
  for (let r = 0; r <= maxR && picked.length < types.length; r++) {
    for (let y = centreY - r; y <= centreY + r && picked.length < types.length; y++) {
      for (let x = centreX - r; x <= centreX + r && picked.length < types.length; x++) {
        if (Math.max(Math.abs(x - centreX), Math.abs(y - centreY)) !== r) continue; // ring only
        if (!tileWalkable(g, x, y)) continue;
        if (picked.some((p) => p.x === x && p.y === y)) continue;
        picked.push({ x, y });
      }
    }
  }

  if (picked.length < types.length) {
    throw new Error(`demoSpawns: found only ${picked.length} walkable tiles near (${centreX},${centreY})`);
  }
  for (const p of picked) {
    if (!tileWalkable(g, p.x, p.y)) throw new Error(`demoSpawns: tile (${p.x},${p.y}) is not walkable`);
  }
  return types.map((type, i) => ({ type, x: picked[i].x, y: picked[i].y }));
}
