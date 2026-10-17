// expected.ts — frozen numbers for tools/prodsim/cli.ts (docs/M5-SPIKE.md 7.7).
// The thresholds are the acceptance floors (N); the sha is the frozen state of the run.
// Re-freeze only with a written reason in docs/M5-SPIKE.md.

/** Ticks of the scripted production run (6000 ticks, 10 minutes of game time at 10 ticks/s). */
export const TICKS = 6000;

/** Floors (the run gives stone 30, axes 12, soldiers 5): stone that reached the store, axes produced,
 *  soldiers equipped (the five recruits are the limit). */
export const MIN = {
  stoneInStore: 20,
  weaponsProduced: 10,
  soldiersEquipped: 5,
};

/** The frozen state sha of one run (two runs in one process must match). */
export const EXPECTED_SHA: string = 'ed2e07fe73f453c73b7430ddf054799a050f24d70e5936b46466c51026a1bf19';
