// wares.ts — the KaM ware ids (the script/carry convention) and their names.
//
// Source of truth: KM_ResTypes.pas 12–41 (r15472, read-only reference):
//   TKMWareType = (wtNone, wtTrunk, wtStone, wtTimber, wtIronOre, wtGoldOre, wtCoal, wtIron, wtGold,
//                  wtWine, wtCorn, wtBread, wtFlour, wtLeather, wtSausage, wtPig, wtSkin,
//                  wtWoodenShield, wtIronShield, wtLeatherArmor, wtIronArmor, wtAxe, wtSword,
//                  wtLance, wtPike, wtBow, wtCrossbow, wtHorse, wtFish, wtAll, wtWarfare, wtFood)
// WARE_MIN = wtTrunk, WARE_MAX = wtFish, WARE_CNT = 28 (KM_ResTypes.pas 29–41). The script ids
// (0 trunk … 27 fish, `res/KM_ResWares.pas:53–57` WARE_ID_TO_TYPE) are the enum index minus 1;
// houses.dat WareInput/WareOutput and unit.dat's serfCarry block already use these ids
// (docs/M3-SPIKE.md 2.3).
//
// Browser-safe: no node: imports.

export const WARE_CNT = 28;

/** Ware names in id order (0 trunk … 27 fish) — the enum names after wtNone. */
export const WARE_NAMES: string[] = [
  'trunk', 'stone', 'timber', 'ironOre', 'goldOre', 'coal', 'iron', 'gold', 'wine', 'corn', 'bread',
  'flour', 'leather', 'sausage', 'pig', 'skin', 'woodenShield', 'ironShield', 'leatherArmor',
  'ironArmor', 'axe', 'sword', 'lance', 'pike', 'bow', 'crossbow', 'horse', 'fish',
];

// The ids the economy slice needs by name (id = enum index − 1).
export const WT_TRUNK = 0;
export const WT_STONE = 1;
export const WT_TIMBER = 2;
export const WT_IRON_ORE = 3;
export const WT_GOLD_ORE = 4;
export const WT_COAL = 5;
export const WT_IRON = 6;
export const WT_GOLD = 7;
export const WT_WINE = 8;
export const WT_CORN = 9;
export const WT_BREAD = 10;
export const WT_FLOUR = 11;
export const WT_LEATHER = 12;
export const WT_SAUSAGE = 13;
export const WT_PIG = 14;
export const WT_SKIN = 15;
export const WT_WOODEN_SHIELD = 16;
export const WT_IRON_SHIELD = 17;
export const WT_LEATHER_ARMOR = 18;
export const WT_IRON_ARMOR = 19;
export const WT_AXE = 20;
export const WT_SWORD = 21;
export const WT_LANCE = 22;
export const WT_PIKE = 23;
export const WT_BOW = 24;
export const WT_CROSSBOW = 25;
export const WT_HORSE = 26;
export const WT_FISH = 27;
