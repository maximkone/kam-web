// tiledata.ts — parser for the KaM Remake `tiles.json` (data/defines/tiles.json).
//
// Source of truth (r15472 checkout, read-only reference):
//  - TKMTerrainKind order: KM_ResTilesetTypes.pas 54–85 (tkCustom = 0 … tkLava = 29).
//  - BASE_TERRAIN: KM_ResTilesetTypes.pas 120–121 — the terrain id each kind maps to; used by the
//    per-corner logic (KM_Terrain.pas 1801–1843) and the road checks.
//  - JSON shape (docs/M2B-SPIKE.md 2.8): {"Tiles":[{"ID":0,"Walkable":true,"Roadable":true,
//    "Soil":true,"CornersTerKinds":["tkGrass",…4…]}, …]}. Walkable/Roadable are exactly the flags
//    KM_Terrain's TileIsWalkable / TileIsRoadable read for standard maps (KM_Terrain.pas 1547–1595:
//    `HasNoLayers` → direct `fTileset.TileIsWalkable(BaseLayer.Terrain)` lookup).
//
// Browser-safe: no node: imports.
export type TerKind = number;

/** TKMTerrainKind names in enum order (KM_ResTilesetTypes.pas 54–85). Index = kind id. */
export const KIND_NAMES: string[] = [
  'tkCustom', 'tkGrass', 'tkMoss', 'tkPaleGrass', 'tkCoastSand', 'tkGrassSand1', 'tkGrassSand2',
  'tkGrassSand3', 'tkSand', 'tkGrassDirt', 'tkDirt', 'tkCobbleStone', 'tkGrassyWater', 'tkSwamp',
  'tkIce', 'tkSnowOnGrass', 'tkSnowOnDirt', 'tkSnow', 'tkDeepSnow', 'tkStone', 'tkGoldMount',
  'tkIronMount', 'tkAbyss', 'tkGravel', 'tkCoal', 'tkGold', 'tkIron', 'tkWater', 'tkFastWater',
  'tkLava',
];

/** Terrain id each kind maps to (KM_ResTilesetTypes.pas 120–121). Index = kind id. */
export const BASE_TERRAIN: number[] = [
  0, 0, 8, 17, 32, 26, 27, 28, 29, 34, 35, 215, 48, 40, 44, 315, 47, 46, 45, 132, 159, 164, 245, 20,
  155, 147, 151, 192, 209, 7,
];

export interface TileFlags {
  walkable: boolean;
  roadable: boolean;
  corners: number[]; // TKMTerrainKind ids, 4 per tile (index 0..3)
  // M5 (additive, docs/M5-SPIKE.md §2.2): the Soil flag (tiles.json "Soil"), read by
  // TileIsSoil → TileGoodForField (KM_Terrain.pas 1275–1284, 1523–1526). Optional so pre-M5
  // TileFlags literals still typecheck; the parser always sets it.
  soil?: boolean;
  // M5b (additive, the AI port): the resource deposits of the tile, read by TileIsStone/Coal/
  // Iron/Gold (KM_Terrain.pas 1385–1430) and the mine placement checks
  // (TileIsGoodForIronMine/GoldMine, KM_ResTileset.pas 506–518). `stone`/`coal`/`iron`/`gold`
  // are the deposit amounts (0 = none); optional so pre-M5b TileFlags literals still typecheck —
  // the parser always sets them.
  stone?: number;
  coal?: number;
  iron?: number;
  gold?: number;
  ironMinable?: boolean; // "IronMinable" (CanPlaceIronMine, KM_Terrain.pas 4711–4716)
  goldMinable?: boolean; // "GoldMinable" (CanPlaceGoldMine)
}

interface RawTile {
  ID?: number;
  Walkable?: boolean;
  Roadable?: boolean;
  Soil?: boolean;
  Stone?: number;
  Coal?: number;
  Iron?: number;
  Gold?: number;
  IronMinable?: boolean;
  GoldMinable?: boolean;
  CornersTerKinds?: string[];
}

/** Parse tiles.json into an array indexed by tile ID (flags + corner kinds as kind ids). */
export function parseTilesJson(text: string): TileFlags[] {
  const data = JSON.parse(text) as { Tiles?: RawTile[] };
  const raw = data.Tiles;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('tiles.json: missing "Tiles" array');

  const out: TileFlags[] = [];
  for (const tile of raw) {
    const id = tile.ID;
    if (typeof id !== 'number' || !Number.isInteger(id) || id < 0) {
      throw new Error(`tiles.json: bad tile ID ${String(id)}`);
    }
    if (out[id] !== undefined) throw new Error(`tiles.json: duplicate tile ID ${id}`);
    const kinds = tile.CornersTerKinds ?? [];
    if (kinds.length !== 4) {
      throw new Error(`tiles.json: tile ${id} has ${kinds.length} corner kinds, expected 4`);
    }
    const corners = kinds.map((name) => {
      const kind = KIND_NAMES.indexOf(name);
      if (kind < 0) throw new Error(`tiles.json: tile ${id} has unknown corner kind "${name}"`);
      return kind;
    });
    out[id] = {
      walkable: tile.Walkable === true,
      roadable: tile.Roadable === true,
      corners,
      soil: tile.Soil === true, // TileIsSoil (KM_Terrain.pas 1523–1526)
      // M5b resource deposits (LoadFromJson, KM_ResTileset.pas 783–789): Stone/Coal/Iron/Gold
      // are byte amounts, IronMinable/GoldMinable the mine-placement booleans.
      stone: typeof tile.Stone === 'number' ? tile.Stone : 0,
      coal: typeof tile.Coal === 'number' ? tile.Coal : 0,
      iron: typeof tile.Iron === 'number' ? tile.Iron : 0,
      gold: typeof tile.Gold === 'number' ? tile.Gold : 0,
      ironMinable: tile.IronMinable === true,
      goldMinable: tile.GoldMinable === true,
    };
  }
  for (let id = 0; id < out.length; id++) {
    if (out[id] === undefined) throw new Error(`tiles.json: no entry for tile ID ${id}`);
  }
  return out;
}
