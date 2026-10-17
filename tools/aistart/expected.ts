// expected.ts - the frozen numbers of the rich-start fight check (tools/aistart/cli.ts --check).
// Battle Sun, hand 1 = the Advanced AI with aiStart 'normal', hand 0 = an idle human (no command).
// Frozen from the tuning run (docs/M5D-SPIKE.md "S2 record"). The ticks are the match end (the human defeated).
export const CHECK_TICKS = 4000;
export const CHECK_LEVEL = 'normal' as const;
export const EXPECTED = {
  minEquipped: 12,
  timeline: {
    endTick: 3240,
    firstRequest: 2711,
    firstCombatGroup: 2728,
    firstHumanHouseDamaged: 3124,
    firstHumanHouseLost: 3228,
    firstKillByAi: 3087,
    firstHumanLoss: 3087,
    equipped: 12,
    killsByAi: 4,
    killsByHuman: 0,
    humanLosses: 4,
    humanHousesEnd: 0,
    humanWarriorsEnd: 0,
    aiWarriorsEnd: 39,
    humanStatus: 'defeated',
    aiStatus: 'won',
    events: 391,
  },
  sha256: 'b97ee3bf383ae78e7322ad1dd53395ca687f4c69db9226cf895c051466c18481',
};
