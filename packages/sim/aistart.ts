// aistart.ts - the rich start of an Advanced AI hand (M5d-S2, docs/M5D-SPIKE.md "S2 record").
// The v0 economy cannot yet make weapons, armour, mines or smithies, so an AI hand never fields an army
// in a normal skirmish (docs/M5-SPIKE.md 7.6, 7.7). This is the documented handicap that fixes it: the
// attack scenario's grants (tools/aisim/cli.ts) as one pure function, sized by a level:
//  - a military kit in the hand's store (axes, wooden shields, leather armours; no smithy in v0),
//  - a finished barracks on the first free spot 4-12 tiles from the store (the economy's canPlaceHouse
//    rule on the entrance), joined to the store by a road (the route the road builder would lay),
//  - recruits waiting in that barracks (the v0 school stalls on gold, docs/M5-SPIKE.md 7.5),
//  - starting militia groups around the store (a map's SET_UNIT would carry them).
// 'none' changes nothing, so a skirmish without a rich start is byte-identical to before.
// Call it after the hand's store and serfs exist and before its AiPlayer is built (the attack scenario's order).
//
// Browser-safe: no node: imports.
import type { EconomyWorld } from './economy.ts';
import { HT_BARRACKS, HT_STORE, UT_MILITIA } from './ai.ts';
import { WT_AXE, WT_WOODEN_SHIELD, WT_LEATHER_ARMOR } from '../assets/wares.ts';

export type AiStartLevel = 'none' | 'light' | 'normal' | 'hard';

export const AI_START_LEVELS: readonly AiStartLevel[] = ['none', 'light', 'normal', 'hard'];

export interface RichStartSizes {
  /** Each of axes, wooden shields and leather armours in the store (the kit). */
  kitPerWare: number;
  /** Recruits waiting in the barracks. */
  recruits: number;
  /** Starting militia groups beside the store. */
  groups: number;
  /** Militia per starting group (MAX_SOLDIERS_IN_GROUP = 9). */
  groupSize: number;
}

/** The sizes of each level (tuned in docs/M5D-SPIKE.md S2; the numbers are the record). */
export const RICH_START_SIZES: Record<Exclude<AiStartLevel, 'none'>, RichStartSizes> = {
  light: { kitPerWare: 20, recruits: 6, groups: 2, groupSize: 6 },
  normal: { kitPerWare: 40, recruits: 12, groups: 3, groupSize: 9 },
  hard: { kitPerWare: 60, recruits: 18, groups: 5, groupSize: 9 },
};

export interface RichStartOptions {
  level: AiStartLevel;
  /** Overrides for the level's sizes (each one optional). */
  sizes?: Partial<RichStartSizes>;
}

export interface RichStartReport {
  level: Exclude<AiStartLevel, 'none'>;
  sizes: RichStartSizes;
  barracksUid: number;
  recruitsWaiting: number;
  groupUids: number[];
  kit: [number, number][];
}

const MAX_SOLDIERS_IN_GROUP = 9;
const GROUP_RING_MIN = 5;
const GROUP_RING_MAX = 14;
const BARRACKS_RING_MIN = 4;
const BARRACKS_RING_MAX = 12;

export function isAiStartLevel(v: unknown): v is AiStartLevel {
  return typeof v === 'string' && (AI_START_LEVELS as readonly string[]).includes(v);
}

/** The level's sizes with the overrides applied; throws a named error for a bad size. */
export function richStartSizes(level: Exclude<AiStartLevel, 'none'>, overrides: Partial<RichStartSizes> = {}): RichStartSizes {
  const sizes: RichStartSizes = { ...RICH_START_SIZES[level], ...overrides };
  const whole = (name: keyof RichStartSizes, min: number): void => {
    const v = sizes[name];
    if (!Number.isInteger(v) || v < min) throw new Error(`aistart: ${name} must be an integer >= ${min}, got ${String(v)}`);
  };
  whole('kitPerWare', 0);
  whole('recruits', 0);
  whole('groups', 0);
  whole('groupSize', 1);
  if (sizes.groupSize > MAX_SOLDIERS_IN_GROUP) throw new Error(`aistart: groupSize must be <= ${MAX_SOLDIERS_IN_GROUP}, got ${sizes.groupSize}`);
  return sizes;
}

/**
 * The barracks on the first spot 4-12 tiles from the store that the economy accepts (canPlaceHouse on the
 * entrance), built as a finished house with its road to the store. Throws when no spot is free.
 */
function placeBarracks(world: EconomyWorld, hand: number): number {
  const store = world.findFirstHouse(HT_STORE, hand);
  const spec = world.houseSpecOf(HT_BARRACKS);
  if (store === null || spec === undefined) throw new Error(`aistart: hand ${hand} has no store or no barracks spec`);
  for (let r = BARRACKS_RING_MIN; r <= BARRACKS_RING_MAX; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = store.x + dx;
        const y = store.y + dy;
        if (!world.canPlaceHouse(HT_BARRACKS, x + spec.entranceDx, y)) continue;
        const house = world.spawnHouse(HT_BARRACKS, x, y, hand);
        world.houseCreatedFor(hand, HT_BARRACKS);
        const route = world.findRoute(house.entrance.x, house.entrance.y + 1, store.entrance.x, store.entrance.y + 1);
        if (route === null) throw new Error(`aistart: no walk route from the barracks at (${x},${y}) to the store of hand ${hand}`);
        for (const p of route) if (!world.isRoadTile(p.x, p.y)) world.addRoadTile(p.x, p.y);
        return house.uid;
      }
    }
  }
  throw new Error(`aistart: no barracks spot near the store of hand ${hand}`);
}

/** Full militia groups on a grid around the store entrance, as a map's SET_UNIT records would place them. */
function placeStartGroups(world: EconomyWorld, hand: number, groups: number, perGroup: number): number[] {
  const store = world.findFirstHouse(HT_STORE, hand);
  if (store === null) throw new Error(`aistart: hand ${hand} has no store`);
  const uids: number[] = [];
  for (let r = GROUP_RING_MIN; r <= GROUP_RING_MAX && uids.length < groups; r++) {
    for (let dy = -r; dy <= r && uids.length < groups; dy += 3) {
      for (let dx = -r; dx <= r && uids.length < groups; dx += 3) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = store.entrance.x + dx;
        const y = store.entrance.y + dy;
        if (!world.tileInMapCoords(x, y) || !world.tileWalkable(x, y) || world.houseAt(x, y) !== null || world.isRoadTile(x, y)) continue;
        const g = world.spawnGroup(hand, UT_MILITIA, x, y, 4, 3, perGroup);
        if (g.memberUids.length > 0) uids.push(g.uid);
      }
    }
  }
  if (uids.length < groups) throw new Error(`aistart: only ${uids.length} of ${groups} start groups fit around the store of hand ${hand}`);
  return uids;
}

/**
 * Give an AI hand its rich start. Throws a named error when the hand has no store or the map has no room
 * for the barracks or the groups. Level 'none' returns null and changes nothing.
 */
export function applyRichStart(world: EconomyWorld, hand: number, options: RichStartOptions): RichStartReport | null {
  if (!isAiStartLevel(options.level)) throw new Error(`aistart: level must be one of ${AI_START_LEVELS.join(', ')}, got ${String(options.level)}`);
  if (options.level === 'none') return null;
  const sizes = richStartSizes(options.level, options.sizes);
  const kit: [number, number][] = [
    [WT_AXE, sizes.kitPerWare],
    [WT_WOODEN_SHIELD, sizes.kitPerWare],
    [WT_LEATHER_ARMOR, sizes.kitPerWare],
  ];
  for (const [ware, amount] of kit) world.addWareToStore(hand, ware, amount);
  const barracksUid = placeBarracks(world, hand);
  for (let i = 0; i < sizes.recruits; i++) world.barracksAddRecruit(barracksUid);
  const groupUids = placeStartGroups(world, hand, sizes.groups, sizes.groupSize);
  return { level: options.level, sizes, barracksUid, recruitsWaiting: sizes.recruits, groupUids, kit };
}
