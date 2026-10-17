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
    firstKillByAi: 3089,
    firstHumanLoss: 3089,
    equipped: 12,
    killsByAi: 4,
    killsByHuman: 0,
    humanLosses: 4,
    humanHousesEnd: 0,
    humanWarriorsEnd: 0,
    aiWarriorsEnd: 39,
    humanStatus: 'defeated',
    aiStatus: 'won',
    events: 374,
  },
  sha256: 'ab6557cfb83733232e00b2e25ef2cfa747b915c799d9a35188efc0b835c54452',
};
