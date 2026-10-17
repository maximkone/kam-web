// mapelem.ts — parser for `mapelem.dat` (data/defines/mapelem.dat).
//
// Source of truth: KM_ResMapElements.pas (r15472, read-only reference).
//  - 99-byte on-disk records (ELEMENT_SIZE, 129). Field offsets inside TKMMapElement (14–31):
//    Anim 0–69, CuttableTree 70–73, DiagonalBlocked 74–77, AllBlocked 78–81, WineOrCorn 82–85,
//    CanGrow 86–89, DontPlantNear 90–93, Stump 94 (i8), CanBeRemoved 95–98 (LongBool = 4 bytes).
//  - gMapElements is array[0..255] and LoadFromFile (138–142) reads ELEMENT_SIZE bytes per entry for
//    all 256 of them; the shipped file only has 254 records (25146 / 99), so [254] and [255] stay
//    zero. OBJ_NONE = 255 must still index (e.g. KM_Terrain.pas 3768 reads .AllBlocked for any Obj
//    byte), so this parser returns 256 entries and fills the tail with the all-false record.
//  - [63] overrides (147–156): Anim.Count 1, Anim.Step[1] 16, CuttableTree/DiagonalBlocked/
//    AllBlocked/WineOrCorn/CanGrow/DontPlantNear false, Stump −1, CanBeRemoved true. The two Anim
//    overrides only affect sprite rendering and have no field in this interface.
//
// Browser-safe: no node: imports.
export interface MapElem {
  cuttableTree: boolean;
  diagonalBlocked: boolean;
  allBlocked: boolean;
  wineOrCorn: boolean;
  canGrow: boolean;
  dontPlantNear: boolean;
  stump: number; // i8, −1 = no stump
  canBeRemoved: boolean;
  // M5 (additive, docs/M5-SPIKE.md §2.2): KillByRoad (kbrNever/kbrNWCorner/kbrWest) — the
  // hardcoded OBJ_KILL_BY_ROAD table (KM_ResMapElements.pas 106–123), read by
  // RemoveObjectsKilledByRoad (KM_Terrain.pas 3309–3339). Optional so pre-M5 MapElem literals
  // still typecheck; the parser always sets it.
  killByRoad?: 'never' | 'nwCorner' | 'west';
}

// OBJ_KILL_BY_ROAD (KM_ResMapElements.pas 107–123), Byte values 0/1/2 (TKMKillByRoad).
const OBJ_KILL_BY_ROAD: number[] = [
  1, 2, 2, 2, 2, 2, 1, 1, 0, 0, 2, 2, 2, 1, 1, 1,
  1, 2, 2, 2, 1, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0,
  0, 0, 0, 0, 0, 1, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 2, 2, 0, 0, 1, 0, 1, 1, 1, 1, 0, 2, 2, 2,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
];

function killByRoadName(v: number): 'never' | 'nwCorner' | 'west' {
  return v === 1 ? 'nwCorner' : v === 2 ? 'west' : 'never';
}

const ELEMENT_SIZE = 99;
/** gMapElements: array[0..255] (KM_ResMapElements.pas 49–55). */
const ELEM_COUNT = 256;

function readLongBool(buf: Uint8Array, o: number): boolean {
  return buf[o] !== 0 || buf[o + 1] !== 0 || buf[o + 2] !== 0 || buf[o + 3] !== 0;
}

function emptyElem(): MapElem {
  return {
    cuttableTree: false,
    diagonalBlocked: false,
    allBlocked: false,
    wineOrCorn: false,
    canGrow: false,
    dontPlantNear: false,
    stump: 0,
    canBeRemoved: false,
    killByRoad: 'never',
  };
}

/** Parse mapelem.dat into 256 entries (0..255), with the [63] overrides applied. */
export function parseMapElem(buf: Uint8Array): MapElem[] {
  const out: MapElem[] = [];
  for (let i = 0; i < ELEM_COUNT; i++) {
    const o = i * ELEMENT_SIZE;
    if (o + ELEMENT_SIZE > buf.length) {
      out.push(emptyElem()); // beyond EOF the game's stream read leaves the record untouched (zeros)
      continue;
    }
    out.push({
      cuttableTree: readLongBool(buf, o + 70),
      diagonalBlocked: readLongBool(buf, o + 74),
      allBlocked: readLongBool(buf, o + 78),
      wineOrCorn: readLongBool(buf, o + 82),
      canGrow: readLongBool(buf, o + 86),
      dontPlantNear: readLongBool(buf, o + 90),
      stump: buf[o + 94] < 128 ? buf[o + 94] : buf[o + 94] - 256,
      canBeRemoved: readLongBool(buf, o + 95),
      killByRoad: killByRoadName(OBJ_KILL_BY_ROAD[i]), // hardcoded table (141)
    });
  }

  // LoadFromFile overrides (KM_ResMapElements.pas 147–156).
  out[63] = {
    cuttableTree: false,
    diagonalBlocked: false,
    allBlocked: false,
    wineOrCorn: false,
    canGrow: false,
    dontPlantNear: false,
    stump: -1,
    canBeRemoved: true,
    killByRoad: killByRoadName(OBJ_KILL_BY_ROAD[63]),
  };
  return out;
}
