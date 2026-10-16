// unitdat.ts — parser for `unit.dat` (data/defines/unit.dat).
//
// Source of truth: KM_ResUnits.pas (r15472, read-only reference).
//  - LoadUnitsDat (686–711): 15680 bytes of serfCarry (28 wares × 8 dirs × 70) are skipped, then
//    41 records of 7898 bytes each. A record = legacy stats (22 bytes, TKMUnitSpecLegacy 16–29,
//    i16 fields with Speed at +10) + sprite block 7840 (TKMUnitSprite 31: 14 actions × 8 dirs ×
//    70-byte TKMAnimLoop) + sprite2 36 (18 × i16, skipped here).
//  - Record → unit type: UNIT_ID_TO_TYPE (146–157): 0..27 = utSerf..utVagabond, 28/29 are the
//    catapult/ballista placeholders (utNone), 30..37 = animals, 38..40 = utNone. The game skips
//    utNone records (704–705); this parser reads all 41 as records (indices stay meaningful).
//  - Mounted speed patch, PatchUnitSpec (590–598): utScout / utKnight / utVagabond (records
//    21/22/27) whose raw speed equals DEF_MOUNTED_SPEED = 39 are patched to 40, so StepsPerTile
//    becomes 6 and StepsPerTileDiag 8 instead of the 39-rounded 6/9. `speedRaw` is the patched
//    value (the one every consumer in the game sees).
//  - TKMAnimLoop (KM_CommonTypes.pas 71–75): Step[1..30] i16 (+0..59), Count i16 (+60),
//    MoveX i32 (+62), MoveY i32 (+66). Loop offset in the sprite block = ((action−120)*8 + (dir−1))*70
//    with uaWalk = 120 … uaUnknown = 133 (KM_Defaults.pas 731–734) and dirN = 1 … dirNW = 8
//    (KM_Points.pas 8).
//
// Browser-safe: no node: imports.
export interface AnimLoop {
  steps: Int16Array; // Step[1..30] — stored 0-based sprite ids
  count: number; // Count i16
  moveX: number; // MoveX i32
  moveY: number; // MoveY i32
}

export interface UnitSpec {
  speedRaw: number; // unit.dat speed after the mounted patch (tiles/tick = speedRaw / 240)
  anim: AnimLoop[][]; // [action − 120][dir − 1]
}

const SERF_CARRY_SIZE = 15680; // 28 * 8 * 70 (LoadUnitsDat 699)
const UNIT_DAT_COUNT = 41; // (688)
const RECORD_SIZE = 7898; // 22 + 7840 + 36
const LEGACY_SIZE = 22;
const ACTION_COUNT = 14; // uaWalk..uaUnknown (KM_Defaults.pas 731–734)
const DIR_COUNT = 8; // dirN..dirNW (KM_Points.pas 8)
const LOOP_SIZE = 70;
const DEF_MOUNTED_SPEED = 39; // PatchUnitSpec 572
const MOUNTED_RECORDS = [21, 22, 27]; // utScout / utKnight / utVagabond (591–598)

function readI16(buf: Uint8Array, o: number): number {
  const v = buf[o] | (buf[o + 1] << 8);
  return v < 0x8000 ? v : v - 0x10000;
}

function readI32(buf: Uint8Array, o: number): number {
  return buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24);
}

/** Parse unit.dat into 41 unit records (index = UNIT_ID_TO_TYPE id). */
export function parseUnitDat(buf: Uint8Array): UnitSpec[] {
  const needed = SERF_CARRY_SIZE + UNIT_DAT_COUNT * RECORD_SIZE;
  if (buf.length < needed) {
    throw new Error(`unit.dat: expected at least ${needed} bytes, got ${buf.length}`);
  }

  const out: UnitSpec[] = [];
  for (let i = 0; i < UNIT_DAT_COUNT; i++) {
    const base = SERF_CARRY_SIZE + i * RECORD_SIZE;

    let speedRaw = readI16(buf, base + 10); // Speed at +10 (TKMUnitSpecLegacy 16–29)
    if (MOUNTED_RECORDS.includes(i) && speedRaw === DEF_MOUNTED_SPEED) speedRaw = 40;

    const anim: AnimLoop[][] = [];
    for (let action = 0; action < ACTION_COUNT; action++) {
      const dirs: AnimLoop[] = [];
      for (let dir = 0; dir < DIR_COUNT; dir++) {
        const o = base + LEGACY_SIZE + (action * DIR_COUNT + dir) * LOOP_SIZE;
        const steps = new Int16Array(30);
        for (let k = 0; k < 30; k++) steps[k] = readI16(buf, o + k * 2);
        dirs.push({ steps, count: readI16(buf, o + 60), moveX: readI32(buf, o + 62), moveY: readI32(buf, o + 66) });
      }
      anim.push(dirs);
    }

    out.push({ speedRaw, anim });
  }
  return out;
}

/** Walk animation loop for one direction: anim[uaWalk − 120][dir − 1] (KM_ResUnits.pas 474–479). */
export function walkLoop(spec: UnitSpec, dir: number): AnimLoop {
  if (!Number.isInteger(dir) || dir < 1 || dir > 8) {
    throw new Error(`walkLoop: dir must be dirN..dirNW (1..8), got ${dir}`);
  }
  return spec.anim[0][dir - 1];
}
