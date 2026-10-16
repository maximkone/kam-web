// housedata.ts — parser for `houses.dat` (data/defines/houses.dat), the v0 subset (docs/M3-SPIKE.md 2.2).
//
// Source of truth: res/KM_ResHouses.pas (r15472, read-only reference).
//  - 51052 B = 2100 B beast block + 29 × 1688 B `TKMHouseSpecLegacy` records (LoadHouseDat 902–926).
//    Record slot i (0..28) is house type HOUSE_ID_TO_TYPE[i] (193–199); slot 26 (htNone) is a dummy
//    and is skipped; slot 29 (htMarket) is not in the file (hardcoded, 806–858) and stays undefined.
//  - Record layout (packed, all offsets verified against the shipped file):
//      StonePic 0, WoodPic 2, WoodPal 4, StonePal 6 (i16);
//      SupplyIn 8 (4×5 i16), SupplyOut 48 (4×5 i16);
//      Anim 88 (19 × 70 B: haWork1..5 at +0/+70/+140/+210/+280, Count at +60);
//      WoodPicSteps 1418, StonePicSteps 1420 (u16); a1 1422; EntranceOffsetX/Y 1424/1425 (i8);
//      EntranceOffsetXpx/Ypx 1426/1427; BuildArea 1428 (10×10 i8); WoodCost 1528, StoneCost 1529
//      (u8); BuildSupply 1530 (2×6 × 8 B); a5 1626, SizeArea 1628; SizeX/Y/sx2/sy2 1630–1633;
//      WorkerWork 1634, WorkerRest 1636 (i16); WareInput 1638, WareOutput 1642 (4× ShortInt);
//      ResProductionX 1646 (i8); MaxHealth 1647, Sight 1649 (i16); WorkerType 1651 (i8);
//      Foot1 1652 (12 × i8), Foot2 1664 (12 × i16).
//    WareInput/WareOutput hold the script ware ids 0..27 (−1 = none); the runtime accessors read
//    Remake's hardcoded tables instead — for the v0 houses (sawmill/hut/store) both agree with the
//    shipped file (verified).
//  - MaxHealth accessor = (WoodCost + StoneCost) * 50 (630–633) — the stored field is ignored.
//  - WorkerType is a unit.dat record index (−1 = none; GetWorkerType 658–665 maps via UNIT_ID_TO_TYPE,
//    which is the identity for the citizen records the file stores).
//  - The footprint used by the game (GetListOfCellsWithin, houses/KM_Houses.pas 1109–1123) is the
//    hardcoded HOUSE_DAT_X[fHouseType].PlanYX 4×4 table (KM_ResHouses.pas 234–560), NOT the legacy
//    BuildArea field: nonzero cell at row I = Y − pos.Y + 4 ∈ 1..4, col K = X − pos.X + 3 ∈ 1..4 is
//    a house tile (pos.X + K − 3, pos.Y + I − 4). HOUSE_PLAN below carries that table keyed by
//    script id (spec 2.2 "Footprint"; the v0 parser itself reads the classic record only).
//
// Browser-safe: no node: imports.

export interface HouseSpec {
  typeId: number; // 0..29 (HOUSE_ID_TO_TYPE index = the script id)
  workerType: number; // unit.dat record, -1 = none
  resIn: number[]; // ware ids, -1 entries kept as parsed (4 slots)
  resOut: number[]; // ware ids
  productionX: number;
  workerRest: number;
  animCounts: number[]; // [haWork1..haWork5] Count values
  entranceDx: number; // EntranceOffsetX (signed)
  woodPic: number;
  stonePic: number; // SnowPic lives in the appended THouseInfo block — not parsed v0
  maxHealth: number; // (WoodCost+StoneCost)*50
  woodCost: number;
  stoneCost: number;
}

const BEAST_BLOCK = 2100; // SizeOf(fBeastAnim) = 30 × 70 (913)
const RECORD_SIZE = 1688;
const RECORD_COUNT = 29; // KaM has only 28 houses + the htNone slot (916)
const NEEDED = BEAST_BLOCK + RECORD_COUNT * RECORD_SIZE; // 51052
const HOUSE_DAT_COUNT = 30; // HOUSE_DAT_COUNT (191)

// HOUSE_ID_TO_TYPE (193–199): script id → TKMHouseType id.
const HOUSE_ID_TO_TYPE: number[] = [
  18, 13, 27, 7, 12, 10, 9, 4, 8, 30, 2, 22, 21, 19, 17, 15, 23, 26, 25, 28, 3, 5, 16, 20, 6, 24, 0, 11,
  29, 14,
];

// HOUSE_DAT_X PlanYX (KM_ResHouses.pas 234–560), indexed by TKMHouseType id (2..30):
// htArmorSmithy 2 … htWoodcutters 30. Row-major [I−1][K−1], values 0..4 (nonzero = house tile).
const PLANYX_BY_TYPE: number[][][] = [];
function setPlan(type: number, rows: number[][]): void {
  PLANYX_BY_TYPE[type] = rows;
}
setPlan(2, [[0, 0, 0, 0], [0, 1, 1, 0], [1, 1, 1, 1], [1, 2, 1, 1]]); // htArmorSmithy
setPlan(3, [[0, 0, 0, 0], [0, 1, 1, 0], [0, 1, 1, 1], [0, 2, 1, 1]]); // htArmorWorkshop
setPlan(4, [[0, 0, 0, 0], [0, 1, 1, 1], [0, 1, 1, 1], [0, 1, 1, 2]]); // htBakery
setPlan(5, [[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]]); // htBarracks
setPlan(6, [[0, 0, 0, 0], [0, 1, 1, 0], [0, 1, 1, 1], [0, 1, 1, 2]]); // htButchers
setPlan(7, [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 0], [1, 2, 1, 0]]); // htCoalMine
setPlan(8, [[0, 0, 0, 0], [1, 1, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]]); // htFarm
setPlan(9, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 0], [0, 2, 1, 1]]); // htFishermans
setPlan(10, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 2, 0]]); // htGoldMine
setPlan(11, [[0, 0, 0, 0], [0, 1, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]]); // htInn
setPlan(12, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 2, 1]]); // htIronMine
setPlan(13, [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [1, 1, 2, 1]]); // htIronSmithy
setPlan(14, [[0, 0, 0, 0], [0, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 2]]); // htMarket
setPlan(15, [[0, 0, 0, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 2, 1, 0]]); // htMetallurgists
setPlan(16, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 1], [0, 1, 2, 1]]); // htMill
setPlan(17, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 1], [0, 1, 2, 1]]); // htQuarry
setPlan(18, [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [1, 2, 1, 1]]); // htSawmill
setPlan(19, [[0, 0, 0, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 2, 1, 0]]); // htSchool
setPlan(20, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 1], [0, 2, 1, 1]]); // htSiegeWorkshop
setPlan(21, [[0, 0, 0, 0], [1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 2, 1]]); // htStables
setPlan(22, [[0, 0, 0, 0], [1, 1, 1, 0], [1, 1, 1, 0], [1, 2, 1, 0]]); // htStore
setPlan(23, [[0, 0, 0, 0], [0, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 2]]); // htSwine
setPlan(24, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 1], [0, 1, 2, 1]]); // htTannery
setPlan(25, [[0, 0, 0, 0], [1, 1, 1, 1], [1, 1, 1, 1], [1, 2, 1, 1]]); // htTownHall
setPlan(26, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 0], [0, 1, 2, 0]]); // htWatchTower
setPlan(27, [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [1, 2, 1, 1]]); // htWeaponSmithy
setPlan(28, [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 1], [1, 2, 1, 1]]); // htWeaponWorkshop
setPlan(29, [[0, 0, 0, 0], [0, 0, 0, 0], [0, 1, 1, 1], [0, 1, 1, 2]]); // htVineyard
setPlan(30, [[0, 0, 0, 0], [0, 0, 0, 0], [1, 1, 1, 0], [1, 1, 2, 0]]); // htWoodcutters

/** PlanYX 4×4 for a script id (0..29); htNone (26) is all zeroes. Returns a fresh copy. */
export function housePlan(typeId: number): number[][] {
  const type = typeId >= 0 && typeId < HOUSE_ID_TO_TYPE.length ? HOUSE_ID_TO_TYPE[typeId] : 0;
  const rows = type >= 2 && type <= 30 ? PLANYX_BY_TYPE[type] : null;
  if (rows === undefined || rows === null) return [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  return rows.map((r) => r.slice());
}

function readI16(buf: Uint8Array, o: number): number {
  const v = buf[o] | (buf[o + 1] << 8);
  return v < 0x8000 ? v : v - 0x10000;
}

function readI8(buf: Uint8Array, o: number): number {
  return buf[o] < 128 ? buf[o] : buf[o] - 256;
}

/** Parse houses.dat into 30 entries (index = script id); undefined = not in the file (dummy/market). */
export function parseHousesDat(bytes: Uint8Array): (HouseSpec | undefined)[] {
  if (bytes.length < NEEDED) {
    throw new Error(`houses.dat: expected at least ${NEEDED} bytes, got ${bytes.length}`);
  }

  const out: (HouseSpec | undefined)[] = new Array(HOUSE_DAT_COUNT).fill(undefined);
  for (let slot = 0; slot < RECORD_COUNT; slot++) {
    const o = BEAST_BLOCK + slot * RECORD_SIZE;

    // Slot 26 is htNone — a dummy record, skipped at load (916–920).
    if (HOUSE_ID_TO_TYPE[slot] === 0) continue;

    const resIn = [0, 1, 2, 3].map((i) => readI8(bytes, o + 1638 + i));
    const resOut = [0, 1, 2, 3].map((i) => readI8(bytes, o + 1642 + i));
    const animCounts = [0, 1, 2, 3, 4].map((i) => readI16(bytes, o + 88 + i * 70 + 60));
    const woodCost = bytes[o + 1528];
    const stoneCost = bytes[o + 1529];

    out[slot] = {
      typeId: slot,
      workerType: readI8(bytes, o + 1651),
      resIn,
      resOut,
      productionX: readI8(bytes, o + 1646),
      workerRest: readI16(bytes, o + 1636),
      animCounts,
      entranceDx: readI8(bytes, o + 1424),
      woodPic: readI16(bytes, o + 2),
      stonePic: readI16(bytes, o + 0),
      maxHealth: (woodCost + stoneCost) * 50, // MaxHealth accessor 630–633
      woodCost,
      stoneCost,
    };
  }
  return out;
}
