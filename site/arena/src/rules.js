// rules.js — every number of the game in one place. Integers only: the sim is fixed point (FP sub-units
// per tile) so two machines running the same commands stay identical, which is what netcode will need.

export const FP = 16; // sub-units per tile
export const W = 48; // tiles
export const H = 32; // tiles
export const TPS = 20; // ticks per second
export const MATCH_TICKS = 5 * 60 * TPS; // five minutes, then the healthier base wins

export const UNIT = {
  knight: {
    cost: 30,
    hp: 60,
    speed: 2, // sub-units per tick (2.5 tiles/s)
    range: 14, // sub-units, melee
    damage: 12,
    cooldown: 20, // ticks between hits
    radius: 6,
  },
  archer: {
    cost: 40,
    hp: 40,
    speed: 1, // 1.25 tiles/s
    range: 44, // ~2.75 tiles
    damage: 8,
    cooldown: 26,
    radius: 5,
  },
};

export const BASE_HP = 400;
export const BASE_RADIUS = 12;
export const START_GOLD = 60;
export const INCOME_TICKS = TPS; // one gold a second
export const INCOME_AMOUNT = 1;
export const PILE_GOLD = 150; // per pile
export const PILE_REACH = FP + 4; // a unit this close to the pile's centre collects
export const PILE_RATE_TICKS = TPS; // ten gold a second while collecting
export const PILE_RATE_AMOUNT = 10;
export const AUTO_ACQUIRE = 34; // an idle unit engages an enemy this close
export const SEPARATION = 11; // units this close push apart (no unit is blocked by another)

export const TILE = { GRASS: 0, SAND: 1, WALL: 2, PILE: 3 };

/** Fixed-point helpers: positions are integers in sub-units, so all maths stays exact. */
export function dist2(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

export function within(ax, ay, bx, by, range) {
  return dist2(ax, ay, bx, by) <= range * range;
}

/** Integer square root (Newton, no floats) - used only for pushing units apart. */
export function isqrt(n) {
  if (n <= 0) return 0;
  let x = n;
  let y = (x + 1) >> 1;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1;
  }
  return x;
}
