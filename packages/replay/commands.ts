// commands.ts — GIC command ordinals for the KaM Remake replay format.
//
// Ordinal order is frozen by the TKMGameInputCommandType enum in
// _ref/kam_remake/src/game/gip/KM_GameInputProcess.pas 43-134 (gicNone = 0 … gicTempDoNothing = 69),
// see docs/M2-SPIKE.md 2.3. Names are the enum identifiers verbatim.
export const CMD_NAMES: readonly string[] = [
  'gicNone', // 0
  // I. Army commands, only warriors
  'gicArmyFeed',
  'gicArmySplit',
  'gicArmySplitSingle',
  'gicArmyLink',
  'gicArmyAttackUnit',
  'gicArmyAttackHouse',
  'gicArmyHalt',
  'gicArmyFormation',
  'gicArmyWalk',
  'gicArmyStorm', // 10
  // II. Unit commands
  'gicUnitDismiss',
  'gicUnitDismissCancel',
  // III. Building/road plans
  'gicBuildToggleFieldPlan',
  'gicBuildRemoveFieldPlan',
  'gicBuildRemoveHouse',
  'gicBuildRemoveHousePlan',
  'gicBuildHousePlan',
  // IV. House repair/delivery/orders
  'gicHouseRepairToggle',
  'gicHouseDeliveryModeNext',
  'gicHouseDeliveryModePrev', // 20
  'gicHouseClosedForWorkerTgl',
  'gicHouseOrderProduct',
  'gicHouseMarketFrom',
  'gicHouseMarketTo',
  'gicHouseWoodcutterMode',
  'gicHouseArmorWSDeliveryToggle',
  'gicHouseStoreNotAcceptFlag',
  'gicHouseStoreNotAcceptAllFlag',
  'gicHStoreNotAllowTakeOutFlag',
  'gicHStoreNotAllowTakeOutAllFlag', // 30
  'gicHouseSchoolTrain',
  'gicHouseSchoolTrainChOrder',
  'gicHouseSchoolTrainChLastUOrder',
  'gicHouseBarracksAcceptFlag',
  'gicHouseBarracksAcceptAllFlag',
  'gicHBarracksNotAllowTakeOutFlag',
  'gicHBarracksNotAllowTakeOutAllFlag',
  'gicHBarracksAcceptRecruitsTgl',
  'gicHouseBarracksEquip',
  'gicHouseBarracksRally', // 40
  'gicHouseTownHallEquip',
  'gicHouseTownHallRally',
  'gicHouseTownHallMaxGold',
  'gicHouseRemoveTrain',
  'gicHouseWoodcuttersCutting',
  // V. Delivery ratios / game-global settings
  'gicWareDistributionChange',
  'gicWareDistributions', // 47
  // VI. Game changes
  'gicGameAlertBeacon',
  'gicGamePause',
  'gicGameSpeed', // 50
  'gicGameAutoSave',
  'gicGameAutoSaveAfterPT',
  'gicGameSaveReturnLobby',
  'gicGameLoadSave',
  'gicGameTeamChange',
  'gicGameHotkeySet',
  'gicGameMessageLogRead',
  'gicGameMessageListRead',
  'gicGamePlayerChange',
  'gicGamePlayerDefeat', // 60
  'gicGamePlayerAllianceSet',
  'gicGamePlayerAddDefGoals',
  // VII. Scripting
  'gicScriptConsoleCommand',
  'gicScriptSoundRemoveRq',
  // VIII. Temporary and debug commands
  'gicTempAddScout',
  'gicTempRevealMap',
  'gicTempVictory',
  'gicTempDefeat',
  'gicTempDoNothing', // 69
];

// Commands that do NOT get a random check in StoreCommand (KM_GameInputProcess.pas 172-173):
// gicGameAlertBeacon, gicGameSpeed, gicGameAutoSave, gicGameAutoSaveAfterPT,
// gicGameSaveReturnLobby, gicGameLoadSave.
export const SKIP_RANDOM_CHECKS_FOR: ReadonlySet<number> = new Set([48, 50, 51, 52, 53, 54]);

/** Command name for an ordinal, or `cmd(n)` when the ordinal is unknown. */
export function cmdName(cmd: number): string {
  return CMD_NAMES[cmd] ?? `cmd(${cmd})`;
}
