# M2b spike — playable slice v0 (frozen 2026-10-16)

Status: **frozen** (lead), workers C (sim core) + D (playable viewer) build against it in parallel.
Acceptance record goes to §7. Read `docs/M2-SPIKE.md` (tick order + RNG) first; this spec extends it.

## 1. Goal

The first **playable** slice: on the real Town Tutorial map, units stand at spawn, left-click selects,
right-click orders a walk, the unit walks there with the remake's exact timing (tile costs, diag speed,
animation frames), in the browser, on top of the headless sim. No houses, no combat, no RNG parity claim
yet — but the tick skeleton is the one M2 froze so parity work later grows K instead of rewriting.

Out of scope (deferred, do not build): road overlay / tpWalkRoad, walk-connect regions, formations with
>1 member, tile occupancy bookkeeping (`UnitWalk` internals), steer/animals, projectiles, houses, serfs,
interpolation blending (`interp.dat`), storm speed, sounds, RNG-parity claims.

## 2. Frozen facts (source is the truth; line numbers as of the 2026-10-16 checkout)

### 2.1 Tile passability (`tpWalk`) — `KM_Terrain.pas`

- `UpdatePassability` (3752–3782) is the only producer of `tpWalk` for our scope:
  `if TileIsWalkable(aLoc) and not gMapElements[Land^[Y,X].Obj].AllBlocked and CheckHeightPass(aLoc, hpWalking) then AddPassability(tpWalk);`
- `TileIsWalkable` (1589–1595) → `TileHasParameter(X, Y, fTileset.TileIsWalkable, aAllow2CornerTiles=True)` (1547–1585):
  - `Land^[Y,X].HasNoLayers` (`LayersCnt = 0`, `KM_TerrainTypes.pas:299–302`) → **standard maps**:
    `Walkable[BaseLayer.Terrain]` — direct tiles.json lookup, no corner logic.
  - else (Remake 9-byte maps): per corner K=0..3, `TileCornerTerKind` (1824–1843):
    `kind = tiles.json[terrain].CornersTerKinds[(K + 4 − rot) mod 4]` (BaseLayer.Corner[K] is true for
    standard tiles — worker verifies; layer branch out of scope); if kind ∈ {tkLava, tkAbyss} → false;
    count corners where `Walkable[BASE_TERRAIN[kind]]`; result = `Cnt >= 3 or (Cnt = 2 and Walkable[terrain])`.
- `CheckHeightPass(aLoc, hpWalking)` (4868–4919) = `TestHeight(25)` on the 4 corner heights
  `p1=H(X,Y), p2=H(X+1,Y), p3=H(X,Y+1), p4=H(X+1,Y+1)` (X2=min(X+1,mapX), Y2=min(Y+1,mapY));
  pass ⇔ `|p1−p2|<25 ∧ |p3−p4|<25 ∧ |p3−p1|<25 ∧ |p4−p2|<50 ∧ |p1−p4|<25 ∧ |p3−p2|<50` (two doubled diagonals, as coded).
- Bounds: usable tiles are `1 ≤ X ≤ mapX−1`, `1 ≤ Y ≤ mapY−1` (`TileInMapCoords`, 1137–1141). The last
  row/column is border. Pathfinding never leaves that box; out-of-box tiles are unwalkable.

### 2.2 Map objects — `mapelem.dat` + `KM_ResMapElements.pas`

- `gMapElements: array[0..255]` (KM_ResMapElements.pas:49–55), tile side: `Obj` byte, `255 = none`,
  `254 = invisible block`, `61 = OBJ_BLOCK` (KM_TerrainTypes.pas:170–172).
- File `mapelem.dat`: 99-byte records (`ELEMENT_SIZE = 99`, 127–145), fields in order:
  Anim 0–69 (70), CuttableTree 70–73, **DiagonalBlocked 74–77**, **AllBlocked 78–81**, WineOrCorn 82–85,
  CanGrow 86–89, DontPlantNear 90–93, Stump 94 (i8), CanBeRemoved 95–98. LongBool = 4 bytes (0/1).
  `KillByRoad` is NOT in the file (set from the OBJ_KILL_BY_ROAD table, 107–123).
- Load-time overrides in `LoadFromFile` (147+): read the whole block and apply every override
  (e.g. `[63].Anim.Count := 1; [63].Anim.Step[1] := 16; [63].CuttableTree := False; [63].DiagonalBlocked := False;` …).

### 2.3 Pathfinding — shipped default is **AStarNew** (not JPS!)

- `PATHFINDER_TO_USE = 1` (KM_Game.pas:331) → `TKMPathFindingAStarNew`. JPS exists but is only reachable
  by recompiling with 2. **Port AStarNew.** (This corrects the PLAN's "Pathfinding(JPS)" wording.)
- Node `TANodeRec` (11–17): `{RouteID, X, Y, CostTo, Estim, Parent}`; storage `fOpenRef[0..MapX,0..MapY]`
  generation-checked (69–74), open list = binary heap keyed by `Estim`, `C_CLOSED = High(Cardinal)` (85).
- `MakeRoute` (92–170): `if not IsWalkableTile(fLocA.X, fLocA.Y) then Exit(False)` (92, as-coded; comment
  says "destination" — keep as-coded); push start (CostTo=0, Parent=nil, Estim=h); loop: pop min,
  `DestinationReached` → done; mark closed; scan 3×3 neighbours `X ∈ [max(x−1,1), min(x+1, MapX−1)]`
  (same for Y); `if CanWalkTo(from, X, Y)` then `if IsWalkableTile(X,Y)` push with
  `CostTo = min.CostTo + MovementCost`, `Estim = h` else mark closed; relaxation
  `if min.CostTo + newCost < N.CostTo then N.CostTo := …; N.Parent := …` — **no heap re-sort** (as-coded);
  break when heap empty. No iteration cap.
- `CanWalkTo` (KM_PathFinding.pas:259–262) = `gTerrain.CanWalkDiagonally`; `CanWalkDiagonally`
  (KM_Terrain.pas:2150–2169): non-diagonal → True; diagonal checks
  `not gMapElements[Land[tile].Obj].DiagonalBlocked` on: `(from.X<aX, from.Y<aY) → Land[aY,aX]`;
  `(from.X<aX, from.Y>aY) → Land[aY+1,aX]`; `(from.X>aX, from.Y>aY) → Land[from.Y,from.X]`;
  `(from.X>aX, from.Y<aY) → Land[from.Y+1,from.X]` — port as coded, including the asymmetry.
  **No both-neighbours-walkable rule in AStarNew.**
- Costs (KM_PathFinding.pas:274–288, 316–321): `MovementCost = DX>DY ? DX*10+DY*4 : DY*10+DX*4`
  (10 ortho, 14 diag); heuristic identical. `DestinationReached` pdLocation = exact tile (worker verifies body).
- `ReturnRoute` (174–194): Parent chain from the final node, `NodeList.Add`, then `Inverse` → **dense
  tile-by-tile route, includes start tile first and destination last**. No SparseToDense (that is JPS-only).
- `Route_Make` wrapper (KM_PathFinding.pas:79–81): v0 skips the route cache (result-equal; note in code).

### 2.4 Unit walk — `KM_UnitActionWalkTo.pas` + `KM_ResUnits.pas`

- Route call (480–483): `Route_Make(fWalkFrom, fWalkTo, [fPass], fDistance=0, fTargetHouse=nil, fNodeList)`.
  `fPass` = `DesiredPassability` (ResUnits 353–359): citizens except builder → `tpWalkRoad`, builder +
  warriors → `tpWalk`. v0: warrior walk = `tpWalk`; road preference deferred.
- Speeds (ResUnits 436–462, 590–606): `speed = unit.dat Speed / 240` tiles/tick;
  `StepsPerTile = Round(1/speed)`, `StepsPerTileDiag = Round(1.41/speed)`;
  effective step = `1/StepsPerTile` (ortho) or `1/StepsPerTileDiag` (diag). Speed 24 → 10/14 steps per
  tile (0.1 / 1/14 per tick). Mounted 39 is patched to 40 in code (utScout/utKnight/utVagabond, 590–598)
  → 6/8 steps. Terrain type does NOT change speed.
- `Execute` per tick (1147–1326) — the frozen essentials (worker ports the whole body faithfully):
  done when `fWalkFrom = fWalkTo`; abort when `fNodeList.Count = 0`; arrival:
  `KMSamePointF(PositionF, KMPointF(node[nodePos]), distance/2)` → snap `PositionF := node`;
  `Direction := KMGetDirection(node[nodePos], node[nodePos+1])` (1254); on reaching a node:
  `Inc(fNodePos); PositionNext := node[nodePos];` (1294–1296) then `Walk(prev,next)` pre-occupy (1303,
  bookkeeping deferred in v0); per-axis move: `dx=Sign(walkX), dy=Sign(walkY)`,
  `distance = speed(diag iff dx≠0 ∧ dy≠0)`, `PositionF.X += dx*Min(distance,|walkX|)`, same for Y (1313–1321);
  `Inc(AnimStep)` once per moved tick (1323).
- `PositionF` is float tile coords; nodes are integer tiles; draw offset `UNIT_OFF_X=-0.5, UNIT_OFF_Y=-0.4`
  (ResUnits 188–189) is applied only at render time.
- `KMGetDirection` (KM_Points.pas:826–861): `dirNA` for zero delta; else
  `ang = atan2(Y/d, X/d) + π/2`, bucket = `Round(deg+3600+22.5) mod 360 div 45 + 1` (dirN=1 … dirNW=8).

### 2.5 Order chain (click → walk)

- UI right-click (KM_InterfaceGamePlay.pas:4050–4121): own group + `group.CanWalkTo(P, 0)` pre-check →
  `gGame.GameInputProcess.CmdArmy(gicArmyWalk, group, P, fSelectedDirection)` (4116–4121; dirNA unless the
  direction selector is active; minimap path uses dirNA, 762).
- Command (KM_GameInputProcess.pas): `gicArmyWalk` (54), packed `Int1SmInt3` = `(groupUID, X, Y, dir)` (234),
  `CmdArmy` (1211–1215). Executed on tick (1012):
  `srcGroup.OrderWalk(KMPoint(X,Y), True, wtokPlayerOrder, dir)`.
- Group (KM_UnitGroup.pas:1899–1934): `IsPositioned` → exit; per member
  `P := GetMemberLocExact(I); fMembers[I].OrderWalk(P.Loc, P.Exact); FaceDir := dir`.
  `GetMemberLocExact` (529–549) = formation spot (`GetPositionInGroup2`, 532–535) ∧ `CheckPassability(Loc, tpWalk)`
  ∧ walk-connect equal. **v0: single-member groups only** — formation for count=1 (worker ports the
  count=1 result exactly; expected: the order tile itself) and the walk-connect term is deferred.
- Warrior (KM_UnitWarrior.pas:587–595, 888–928): `woWalk` queued, `TakeNextOrder` → if walking,
  `ChangeWalkTo(loc, 0)`, else `SetActionWalkToSpot(loc, uaWalk)`; gate `IsRanged or (loc <> PositionRound)`.
  v0 can go straight to `startWalk` (no action stack) — same observable result for a walk order.

### 2.6 Tick order — `KM_Game.pas` `PlayGameTick` (3064–3145)

`IncTick` → `TakePlannedCommands` → UpdateStates in order: scripting, terrain, AI fields, **hands (units)**,
spectator, pathfinding, projectiles → **`RunningTimer`** (the 1 RNG draw per tick + issues all commands for
the tick) → (aggressive builds) `CmdTemp(gicTempDoNothing)`. v0 `Sim.tick()` mirrors this:
`updateUnits() → rng draw (running timer) → apply queued commands`. Command application point is frozen
here so M2c parity work starts from the right skeleton.

### 2.7 `unit.dat` — speeds + animation loops

- Size 339498 = 15680 serfCarry (28×8×70, skipped) + 41 × 7898 (`KM_ResUnits.pas:686–711`):
  legacy 22 bytes (i16 fields; **Speed at +10**) + sprite block 7840 (14 actions × 8 dirs × 70) + 36
  (`sprite2`, skipped). Unit order = `UNIT_MIN..UNIT_MAX` from KM_ResTypes (worker validates; 41 records).
- `TKMAnimLoop` (KM_CommonTypes.pas:71–75): `Step[1..30]` i16 (0–59), `Count` i16 (60–61), `MoveX` i32
  (62–65), `MoveY` i32 (66–69). Loop offset in sprite block = `((action−120)*8 + (dir−1))*70`;
  actions `uaWalk=120 … uaUnknown=133` (KM_Defaults.pas:731–734); dirs `dirN=1 … dirNW=8` (KM_Points.pas:8).
- Frame (KM_ResInterpolation.pas:80–98): `step := AnimStep mod Count + 1; spriteId := Step[step]`
  (stored ids are 0-based; the renderer uses `+1`). Atlas `i` = stored value — verified by the lead
  2026-10-16: game sprite ids are 1-based (`KM_ResSprites.pas:780` `aStartingIndex = 1`) and atlas `i`
  is the 0-based rxx file ordinal, so `atlas i = game render id − 1` (units `i = stored step`; terrain
  `i = terrain`, the same convention — M1 errata in DECISIONS.md). D's first cut used `stored + 1`; the
  lead corrected it (proof `%TEMP%\opencode\kamweb_unit_align_0_6.png`: `i = step` is a coherent
  8-frame walk cycle, `i = step + 1` wraps to a foreign sprite).
  Still frame: `Step[(UNIT_STILL_FRAMES[dir] mod Count) + 1]` with `UNIT_STILL_FRAMES` =
  `(NA 0, N 3, NE 2, E 2, SE 1, S 6, SW 7, W 6, NW 6)` (ResUnits 181). `AnimStep` advances once per moved tick.

### 2.8 Data + map files (the owner's installs, read-only)

- Map: `C:\Users\me\Desktop\KaM Remake\Tutorials\Town Tutorial\Town Tutorial.map` (standard 23-byte form,
  the M1 map; frozen check values M1 §2.2; parsed by `packages/map/map.ts`). Viewer keeps loading the
  pre-made `out/maps/TownTutorial.json` (M1 §3.2 contract).
- Defines: `C:\Users\me\Desktop\KaM Remake\KaM Remake Beta r15472\data\defines\{tiles.json, mapelem.dat,
  unit.dat}` (this r15472 install HAS tiles.json — an older install does not; use the r15472 path).
  `tiles.json` shape: `{"Tiles":[{"ID":0,"Walkable":true,"Roadable":true,"Soil":true,
  "CornersTerKinds":["tkGrass",…4…]}, …]}`.
- Sprites: `out/atlas/{Units,Tileset}.json` (M0 output; Units has mask sheets for team tint).

## 3. Interfaces (frozen — workers code against exactly these names)

All new code: ESM TS, bare `node file.ts` runnable, no deps, `.ts` import suffixes, browser-safe modules
must not import node builtins (CLI tools may).

- `packages/assets/tiledata.ts` — `export type TerKind = number` (index into `KIND_NAMES`), 
  `export const KIND_NAMES: string[]` (TKMTerrainKind order), `export const BASE_TERRAIN: number[]`,
  `export interface TileFlags { walkable: boolean; roadable: boolean; corners: number[] }`,
  `export function parseTilesJson(text: string): TileFlags[]` (index = ID).
- `packages/assets/mapelem.ts` — `export interface MapElem { cuttableTree: boolean; diagonalBlocked: boolean;
  allBlocked: boolean; wineOrCorn: boolean; canGrow: boolean; dontPlantNear: boolean; stump: number;
  canBeRemoved: boolean }`, `export function parseMapElem(buf: Uint8Array): MapElem[]` (255 entries, overrides applied).
- `packages/assets/unitdat.ts` — `export interface AnimLoop { steps: Int16Array; count: number; moveX: number;
  moveY: number }`, `export interface UnitSpec { speedRaw: number; anim: AnimLoop[][] /* [action−120][dir−1] */ }`,
  `export function parseUnitDat(buf: Uint8Array): UnitSpec[]` (41), `export function walkLoop(spec: UnitSpec, dir: number): AnimLoop`.
- `packages/sim/terrain.ts` — `export interface PassGrid { mapX: number; mapY: number; walk: Uint8Array;
  obj: Uint8Array; height: Uint8Array; elems: MapElem[]; tiles: TileFlags[] }`,
  `export function buildPassGrid(map: KaMap, tiles: TileFlags[], elems: MapElem[]): PassGrid`,
  `export function tileWalkable(g: PassGrid, x: number, y: number): boolean`,
  `export function canWalkDiagonal(g: PassGrid, from: {x:number,y:number}, x: number, y: number): boolean`,
  `export function checkHeightPass(g: PassGrid, x: number, y: number): boolean`.
- `packages/sim/astar.ts` — `export function findPath(g: PassGrid, from: {x:number,y:number},
  to: {x:number,y:number}): {x:number,y:number}[] | null` (dense, start..end inclusive).
- `packages/sim/walk.ts` — `export interface Walk { nodeList: {x:number,y:number}[]; nodePos: number;
  walkFrom: {x:number,y:number}; walkTo: {x:number,y:number}; done: boolean; aborted: boolean }`,
  `export function startWalk(g: PassGrid, from: {x:number,y:number}, to: {x:number,y:number}): Walk | null`,
  `export function walkTick(g: PassGrid, w: Walk, posF: {x:number,y:number}, speed: {ortho:number, diag:number}):
  { dir: number; animStep: number; status: 'walking'|'done'|'aborted' }` (mutates posF/w).
- `packages/sim/sim.ts` — `export interface SimUnit { uid: number; owner: number; type: number;
  posF: {x:number,y:number}; dir: number; animStep: number; action: 'stay'|'walk'; walk: Walk | null;
  speed: {ortho:number, diag:number} }`, `export class Sim { readonly units: SimUnit[];
  readonly tickCount: number; constructor(g: PassGrid, units: UnitSpec[]);
  addUnit(type: number, x: number, y: number, owner?: number): SimUnit;
  orderWalk(uid: number, x: number, y: number): boolean; tick(): void }`,
  `export function demoSpawns(g: PassGrid): {type: number; x: number; y: number}[]` (3 single-member
  spawns near the town centre; throws unless every tile is walkable).
- `tools/walksim/cli.ts` — `node tools/walksim/cli.ts --check` → `WALK CHECK PASS` (exit 0) or
  `WALK CHECK FAIL: <reason>` (exit 1); also `--routes` prints the §7 table. Reads the map via
  `packages/map/map.ts` and the defines from the r15472 install.

`Sim.tick()` = §2.6 order: updateUnits → rng draw → commands (commands queued by `orderWalk` execute on
the next tick, like the game).

## 4. Worker C — sim core (headless)

Deliverables: the six modules + `tools/walksim/cli.ts` + `packages/sim/*.test.ts` (node:test style like
`rng.test.ts`). Proofs to paste in the report:

1. `node tools/walksim/cli.ts --check` → `WALK CHECK PASS`, plus the route table it verifies.
2. `npm test` (all suites) and `npx tsc --noEmit` exit 0.
3. Data cross-checks printed once: unit.dat size 339498; speeds for Militia/Serf/Knight = 24/24/40 (raw 39
   patched for mounted — worker confirms the patch list); mapelem.dat 255 records, `[61].allBlocked`,
   `[255]` (none) flags sane; tiles.json ID 0 Walkable, ID 192/209 (water kinds) not walkable.
4. Rule tests on synthetic mini-maps (hand-computed): height wall (≥25 step) blocks; water blocks; tree
   AllBlocked blocks; DiagonalBlocked corner forbids the diagonal but a detour exists; border row/col
   (mapX) unreachable; cost metric 10/14 picks the expected among two equal-length routes.
5. Town Tutorial cases: (a) a long route (≥ 40 tiles) around water: length + tick count; (b) an unwalkable
   target → `null`; (c) a route that must use a diagonal: one step counted as diag cost 14 and 14 ticks for
   speed-24 unit; (d) two routes of equal tile length where 10/14 metric prefers the orthogonal-heavy one.

## 5. Worker D — playable viewer (browser)

New `apps/web/play.html` + `apps/web/play.ts` (transpiled by `serve.ts` like `mapdemo.ts`), reusing the M1
renderer (terrain VBO + camera) and adding:

- Loads `/out/maps/TownTutorial.json`, `/out/atlas/Tileset.json`, `/out/atlas/Units.json` (+ sheets), and
  defines via new `serve.ts` routes: `/defines/tiles.json`, `/defines/mapelem.dat`, `/defines/unit.dat`
  served from `KAM_DATA` (env var; default `C:\Users\me\Desktop\KaM Remake\KaM Remake Beta r15472\data\defines`).
- Builds the `Sim` with `demoSpawns(g)`; runs 10 sim ticks/s (accumulator, catch-up ≤ 5 ticks/frame).
- Draws each unit: sprite = `walkLoop(spec, dir).steps[animStep mod count]` while walking, still frame when
  stay; anchor `world = ((posF.x + UNIT_OFF_X) * 40, (posF.y + UNIT_OFF_Y) * 40)` minus terrain height
  (bilinear from the corner-height grid — visual check only, exact anchoring later); team tint via mask
  sheet (owner 0 = default, others tinted).
- Input: left-click selects the nearest unit within 24 css px (else deselects); right-click on terrain →
  `sim.orderWalk(selected, tile)`; if `findPath` returns null, flash the HUD red instead. HUD: tile under
  cursor, tick, selected uid/type, `#err` on exceptions.
- Selection ring: simple white ellipse quad under the unit (placeholder until GUI art pass).
- Camera: M1 pan/zoom kept; keys 1/2/3 jump to spawn units.

Proofs: `npx tsc --noEmit` exit 0; `node apps/web/serve.ts --check`-style boot check (worker may add);
a headless-Edge scripted run (CDP over 127.0.0.1; see the `real-browser-automation` skill): page loads
clean (`#err` empty), unit visible at spawn, click selects (HUD shows uid), right-click far tile → unit
posF moves over ticks and arrives at the target (assert within 1 tick of the expected count), screenshot.
Worker D may not modify `packages/sim/*` — interface problems go back to the lead.

## 6. Acceptance (lead)

1. `node tools/walksim/cli.ts --check` → `WALK CHECK PASS`; `npm test`; `npx tsc --noEmit` exit 0.
2. Lead re-derives passability independently (small script: tiles.json + mapelem.dat + map bytes → spot
   check spawn tiles + the route table's blocked case) and re-runs the browser CDP script against the live
   server; screenshots.
3. Regressions: M0 `CHECK PASS`, M1 `MAP CHECK PASS`, M2 `replayinfo` on one replay (same §2.4 numbers).
4. Commit by path; §7 filled with the frozen numbers + the proof lines.

## 7. Acceptance record

### 7.1 Worker C — sim core: accepted (lead re-ran every proof)

- `node tools/walksim/cli.ts --check` → `WALK CHECK PASS` (exit 0): walkable=11883/16129, unit.dat
  339498 B / 41 records, speeds Serf=24 Militia=24 Scout=40 Knight=40 Vagabond=40 Wolf=39 (mounted
  21/22/27 patched 39→40), mapelem.dat 25146 B = 254 records / 256 entries, tiles.json 597,
  spawns (64,64)/(63,63)/(64,63); route table frozen below.
- `npm test` → `tests 41 / pass 41 / fail 0` (exit 0); `npx tsc --noEmit` → exit 0.
- Lead's independent passability check (`%TEMP%\opencode\kamweb_m2b_leadcheck.mjs`, own parsers, no
  repo imports) vs C's grid (`%TEMP%\opencode\kamweb_m2b_leadverify.mjs`, C's modules): both walkable
  **11883/16129** and both grids sha256
  **556bfcb14a117834c62279bbdbc04afec5f67454ec41247d30afd2c8120ad3c1** (byte-identical 127×127 dump).
  Probes: (115,64)/(114,65) blocked by obj 61, (115,65) walkable, (89,25) terrain-blocked,
  (65,66)/(70,66) walkable, (60,66) not.
- Accepted deviation: `mapelem.dat` is 254 records on disk (25146 B) with 256 parser entries —
  §3's "255 entries" corrected in the module header (gMapElements[0..255], OBJ_NONE=255).

Frozen route table (`--routes`):

| name | from→to | unit | steps | ortho | diag | cost | moves | directTicks | simTicks | dir | end |
|---|---|---|---|---|---|---|---|---|---|---|---|
| long-water | (64,63)→(32,120) | 0 | 82 | 75 | 7 | 848 | 848 | 849 | 850 | 5 | (32,120) |
| blocked-target | (64,63)→(89,25) | — | terrain 187 not walkable, path=null | | | | | | | | |
| forced-diagonal | (114,64)→(115,65) | 0 | 1 | 0 | 1 | 14 | 14 | 15 | 16 | 4 | (115,65) |
| equal-length-metric | (32,40)→(34,40) | 0 | 2 | 2 | 0 | 20 | 20 | 21 | 22 | 3 | (34,40) |
| diag-shortcut | (20,20)→(22,22) | 0 | 2 | 0 | 2 | 28 | 28 | 29 | 30 | 4 | (22,22) |

Tick accounting: `moves` = movement ticks (AnimStep++), `directTicks` = startWalk+walkTick loop
(moves+1, arrival-recognition tick), `simTicks` = via `Sim.orderWalk` (moves+2: order applies at the
end of tick 1, movement starts tick 2).

### 7.2 Worker D — playable viewer: accepted after the lead's sprite-index fix

- D's CDP journey re-run by the lead on the fixed build (`%TEMP%\opencode\kamweb_d_verify.mjs`, fresh
  headless Edge against a live server): **RESULT PASS pass=16 fail=0** — `#err` empty, 3 units drawn,
  missingSprites=0, tick pacing 10/s, left-click selects uid 1, HUD `tick=13 units=3 selected=1`,
  right-click (53,61) (12-node route) → walked (112 walking samples), arrived snapped on the tile,
  arrival **124 ticks = simTicks**, wheel zoom, 0 blocked requests, no page exceptions; screenshot
  `%TEMP%\opencode\kamweb_m2b_shot.png`.
- Accounting fix by the lead in the verify script: `expected = moves + 2` (simTicks), browser tolerance
  ±2 (CDP dispatch + 100 ms poll quantization); the exact deterministic tick count is proven by
  `tools/walksim` (headless). `npx tsc --noEmit` exit 0; `node apps/web/serve.ts --check` →
  `SERVE CHECK PASS` (D's report).
- Lead fix in D's file (errata, not a re-dispatch): `apps/web/play.ts` terrain `i = terrain`,
  `SPRITE_ID_ADD = 0` (see §2.7); terrain rendering visually confirmed — grass/dirt/rock/water/abyss
  all correct, no wrong-sprite speckles (screenshot reviewed).

### 7.3 Regressions (lead, all exit 0)

- M0: `node tools/import/cli.ts --install "C:\Users\me\Desktop\KaM Remake" --check` → `CHECK PASS`
  (packs=6 sprites=11962).
- M1: `node tools/mapinfo/cli.ts "…\Town Tutorial.map" --check` → `MAP CHECK PASS`.
- M2: `node tools/replayinfo/cli.ts …\autosave01\autosave01.rpl` → seed=1247813158, first check #2
  t=4 rand=2135059644, K=12/84852, first fail #16 t=10 file=615217756 sim=1527758834, pairs
  ok=51311 bad=33540, anomalies=0 (the §2.4 numbers).
- M1 viewer re-verified after the off-by-one fix: `LEAD M1 VERIFY PASS (15 checks)` on a fresh server
  (port 8126) + fresh screenshot `out/m1-lead-fit.png` (clean terrain). The stale 8124 server
  (worker B era, old transpiled code) was left running untouched; verification used a fresh port.
