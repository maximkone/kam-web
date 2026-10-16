# M3 spike — economy slice v0: the woodcutter → sawmill → store chain, live

Next rung after M2b (`docs/PLAN.md` §3): **one production chain end-to-end (forest → sawmill →
boards), serfs** — on the real Town Tutorial village, deterministic, and visible in the browser.

Slice shape: load the real mission (`Town Tutorial.dat`) — 21 houses, 249 street tiles, 81 units,
22 starting-ware lines — run the chain headlessly at the frozen tick rate (`tools/econsim`), render
it in `play.html` (houses, roads, trees, wares, serfs).

Workers: **E** = mission/house data + economy sim + CLI (headless, `packages/**` + `tools/econsim/**`),
**F** = viewer (`apps/web/**`). The lead freezes this spec, verifies, commits. Same rules as M2b:
bare `node file.ts`, zero runtime deps, ESM with `.ts` imports, no `enum`/`namespace`.

## 1. Scope (v0)

In:
- **Mission script parser** (read-only, minimal): `!SET_MAP`, `!SET_CURR_PLAYER`, `!ENABLE_PLAYER`,
  `!SET_HOUSE`, `!SET_STREET`, `!SET_UNIT`, `!ADD_WARE`; every other command is skipped (the
  tokenizer still has to walk them correctly).
- **houses.dat parser**: worker type, in/out wares + production count, `WorkerRest`, `haWork1..5`
  anim counts, entrance offsets, build area, sprite ids (wood/stone/snow), MaxHealth, costs.
- **Ware ids 0..27** (the script/carry convention: 0 trunk, 1 stone, 2 timber, … 27 fish).
- **Economy sim**: houses (state, wares In/Out, worker), streets → `toRoad` overlay + `tpWalkRoad`
  grid, tree objects (`CHOPABLE_TREES` ages + `TreeAge`), unit tasks `TKMTaskGoHome` /
  `TKMTaskMining` (woodcutter cut + carpenter saw) / `TKMTaskDeliver` (serf), per-hand logistics
  offers/demands.
- **Tick order** = the game's real one (§2.5), not the M2b shortcut.
- **CLI** `tools/econsim/cli.ts --check`: load the tutorial mission + data, run a fixed number of
  ticks, print the frozen event log + final counts + state sha256; `ECON CHECK PASS/FAIL`.
- **Viewer**: `play.html` shows the village — houses (Houses.rxx + team tint), roads (connectivity
  sprites), trees (Trees.rxx incl. falling + stump), house ware stacks, serfs with carry overlays,
  HUD with tick, house wares, event line. Click-select keeps working.

**Demo scenario (v0, documented tweaks — same helper for CLI and viewer):**
1. **Seeded forest**: the tutorial's hut at (4,119) has only 1 choppable tree within its radius 10
   (lead's scan: 147 full trees on the map, 1 near the hut). `applyDemoScenario` plants
   `DEMO_FOREST_COUNT = 12` full trees (species 1, obj 90, `TreeAge = 40`) on the first 12 tree-free,
   walkable, house-free, non-road tiles in row-major order within Chebyshev 9 of the hut's
   `PointBelowEntrance`.
2. **Store timber order**: the store's `WareInput` is all `wtNone` → it never demands wares, so
   boards would pile at the sawmill (cap 5). `applyDemoScenario` adds one demand to hand 1's store:
   timber × 20 (`dtOnce`, the same mechanism the game's scripts use for construction,
   `scripting/KM_ScriptingActions.pas:1281-1282`). Without it the chain ends at the sawmill — both
   behaviors are the real game's; the order makes the chain complete for the slice.

Out (v0, later milestones): construction sites, fields/corn, mines/stone cutting, other chains, AI,
combat, save/load, fog of war, exact logistics bid math (§2.7).

## 2. Frozen facts (r15472; line refs into `_ref/kam_remake/src`)

### 2.1 Mission script `.dat`

- Decode: if the share of tab/CR/LF/digits/space/`!` bytes is < 0.20, XOR every byte with 239
  (`mission/KM_MissionScript.pas:212-222`); tab/CR/LF → space (`:228-230`); collapse double spaces
  and `!!` (`:233-241`). Tokenizer (`:264-310`): a command starts at `!` and runs to the first
  space; parameters follow until the next `!`; each parameter is an int, default −1.
- `!SET_HOUSE id x y` → `HOUSE_ID_TO_TYPE[id]` placed at `(x+1, y+1)` for the current hand
  (`mission/KM_MissionScript_Standard.pas:360-366`; table `res/KM_ResHouses.pas:193-199` — 30 ids:
  0 sawmill, 1 iron smithy, 2 weapon smithy, 3 coal mine, 4 iron mine, 5 gold mine, 6 fisherman,
  7 bakery, 8 farm, 9 woodcutters, 10 armor smithy, 11 store, 12 stables, 13 school, 14 quarry,
  15 metallurgists, 16 swine, 17 watchtower, 18 town hall, 19 weapon workshop, 20 armor workshop,
  21 barracks, 22 mill, 23 siege workshop, 24 butcher, 25 tannery, 26 none, 27 inn, 28 vineyard,
  29 market).
- `!SET_STREET x y` → `AddRoadToList((x+1, y+1))` (`:456-457`) — only appends to the hand's list
  (`hands/KM_Hand.pas:632-640`); at mission end `AfterMissionInit` (`:680-688`) calls
  `gTerrain.SetRoads(list, owner, …)` (`terrain/KM_Terrain.pas:2208-2243`): per tile
  `TileOwner := owner; TileOverlay := toRoad; FieldAge := 0;` remove wine/corn objects, then
  `UpdatePassability` + `UpdateWalkConnect([wcRoad])`.
- `!SET_UNIT id x y` → `UNIT_OLD_ID_TO_TYPE[id]` at `(x+1, y+1)` (`:408-421`;
  `res/KM_ResUnits.pas:128-135`: 0 serf, 1 woodcutter, 2 miner, 3 animal breeder, 4 farmer,
  5 carpenter, 6 baker, 7 butcher, 8 fisher, 9 builder, 10 stonemason, 11 smith, 12 metallurgist,
  13 recruit, 14 militia, 15 axe, 16 sword, 17 bowman, 18 crossbowman, 19 lance, 20 pikeman,
  21 scout, 22 knight, 23 barbarian, 24 wolf, 25 fish, 26 watersnake, 27 seastar, 28 crab,
  29 waterflower, 30 waterleaf, 31 duck).
- `!ADD_WARE ware amount` (`:479-489`): `qty = EnsureRange(amount, -1, High(Word))`, −1 → 65535;
  target = the hand's **first storehouse** (`FindHouse(htStore, 1)`); store version
  (`houses/KM_HouseStore.pas:96-112`) clamps the stock at 65535 and **creates an offer**
  (`AddOffer(store, ware, qty)`). `ware` = script id (0 trunk … 27 fish).
- `!SET_FIELD x y` (corn) parsed and ignored in v0 (`:459-460`).
- **Town Tutorial facts (lead's independent parse, `%TEMP%\opencode\kamweb_m3_leadmission.mjs`;
  corrected counts after the first probe)**: 21 houses / 249 streets / 81 units / 22 ware lines.
  hand 0 (human) = north village: store (16,17), streets 13–15 × 16–18 (9 streets), 7 units, 8 ware
  lines; **hand 1 (AI, start 14,112) = the economy village: 18 houses** incl. **woodcutter hut
  (4,119)**, **sawmill (8,115)**, **store (15,113)**, farms (14,118)/(10,122), quarry (10,112),
  school (19,116), inns, workshops, barracks, tannery, watchtowers; **221 street tiles** around
  x 3–35, y 90–122; 30 units; 10 ware lines (trunks 30, stone 9000, timber 20, iron 100, gold 9000,
  wine 20, bread 9000, leather 15, sausage 9000, horse 9000); hand 2 (AI) = NE village: 2 houses
  (store (116,8), inn (125,11)), 19 streets, 44 units, 4 ware lines. The slice demo = hand 1's
  village (all hands are loaded). Canonical sha256 of the parsed lists (lead's format):
  `e7d2c5ddcc00e87304139defe9a663533b7f33fb028cb98cafa4df1c10e894d3`.

### 2.2 `houses.dat`

- **51052 B = 2100 B beast block + 29 × 1688 B records** (verified by the lead). Loader
  `LoadHouseDat` (`res/KM_ResHouses.pas:902-926`): record slot i (0..28) → `HOUSE_ID_TO_TYPE[i]`;
  slot 26 (`htNone`) is a dummy (skipped); slot 29 (market) is not in the file (hardcoded,
  `:806-858`).
- Record `TKMHouseSpecLegacy` (packed 1688 B; all offsets verified against the file):

| field | off | type | notes |
|---|---|---|---|
| StonePic, WoodPic | 0, 2 | i16 | base sprites (render uses `+1`) |
| WoodPal, StonePal | 4, 6 | i16 | build-stage mask sources (dropped at load) |
| SupplyIn | 8 | 4×5 i16 | stored-wares sprite ids (per ware slot × count 1..5) |
| SupplyOut | 48 | 4×5 i16 | same for outputs |
| Anim | 88 | 19 × 70 B | `haWork1..5` = ordinals 0..4 → offsets 88/158/228/298/368; `Count` at +60 |
| WoodPicSteps, StonePicSteps | 1418, 1420 | u16 | build-stage counts |
| EntranceOffsetX/Y | 1424, 1425 | i8 | tile offsets |
| EntranceOffsetXpx/Ypx | 1426, 1427 | i8 | pixel offsets (unused v0) |
| BuildArea | 1428 | 10×10 i16 | footprint grid (see below) |
| WoodCost, StoneCost | 1528, 1529 | u8 | build cost amounts (wares fixed: timber, stone) |
| BuildSupply | 1530 | 2×6 i32 | (MoveX, MoveY) supply piles |
| SizeArea / SizeX / SizeY / sx2 / sy2 | 1628 / 1630 / 1631 / 1632 / 1633 | i16 / i8×4 | |
| WorkerWork, WorkerRest | 1634, 1636 | i16 | `AfterWorkIdle = WorkerRest*10` |
| WareInput, WareOutput | 1638, 1642 | 4× i16 | **ware ids 0..27** (−1 none) |
| ResProductionX | 1646 | i16 | output per cycle |
| MaxHealth (stored) | 1647 | i16 | accessor uses `(WoodCost+StoneCost)*50` |
| Sight | 1649 | i16 | |
| WorkerType | 1651 | i8 | unit.dat record, −1 = none |
| Foot1, Foot2 | 1652, 1664 | 12× i16 | sounds / sprite ids |

- **Footprint** (`houses/KM_Houses.pas:1109-1123`): the house occupies the `BuildArea` cells with
  row `I = Y − pos.Y + 4 ∈ 1..4` and col `K = X − pos.X + 3 ∈ 1..4` → tiles
  `(pos.X + K − 3, pos.Y + I − 4)`; nonzero cell = house tile.
  **Errata (worker E, verified by the lead):** the runtime `BuildArea` property reads the hardcoded
  `HOUSE_DAT_X[type].PlanYX` (`res/KM_ResHouses.pas:96, 599`, table `:232-560`), **not** the legacy
  record field @1428 (the loader never copies it). The parser/economy use the hardcoded PlanYX table
  (script-id keyed); proof: the legacy field would give the sawmill a 2-tile footprint, the hardcoded
  area gives its real one. The walkable drop 11883→11705 = 178 tiles = the 21 houses' newly blocked
  footprint tiles (some footprint cells were already unwalkable).
- **Entrance** (`:401-410`): `entrance = (pos.X + EntranceOffsetX, pos.Y)`;
  `PointBelowEntrance = (entrance.X, entrance.Y + 1)`.
- Verified dumps: **Sawmill** (slot 0): WoodPic 1, StonePic 0, WoodPicSteps 35, StonePicSteps 33,
  SupplyIn[1] = 10..14, SupplyOut[1] = 15..19, entrance (−1, 0), WoodCost 4, StoneCost 3,
  SizeX 4 SizeY 2 sx2 2 sy2 1, WorkerWork 30, **WorkerRest 5**, WareInput [0,−1,−1,−1],
  WareOutput [2,−1,−1,−1], ResProductionX 2, WorkerType 5 (carpenter), anim counts
  [haWork1..5] = [30,10,0,0,30].
  **Woodcutter hut** (slot 9): WoodPic 142, StonePic 141, SupplyOut[1] = 228..232, entrance (0,0),
  WoodCost 3, StoneCost 2, SizeX 3 SizeY 2, WorkerWork 3, **WorkerRest 5**, WareInput all −1,
  WareOutput [0,…] (trunk), ResProductionX 1, WorkerType 1 (woodcutter), work anim counts all 0
  (the unit animates).
  **Store** (slot 11): WoodPic 138, StonePic 137, entrance (−1,0), WoodCost 6, StoneCost 5,
  WorkerType −1, WareInput all −1, SupplyIn/Out all −1 (the store's stock is drawn by the HUD, not
  ground piles), WorkerRest 0.
- Sawmill cycle length (from §2.6): `T1 + T2 + T3 + WorkerRest*10 + 1 = 30 + 10*25 + 30 + 50 + 1 =
  **361 ticks per 2 timber**`.
- The file also carries an appended `THouseInfo` block (`KM_ResHouses.pas:218-230`: PlanYX,
  NeedsPlayerOrder, BuildIcon, TabletSpriteId, Input/Output, UnlockedByHouse, SnowSpriteId,
  GroundArea) after the 29 classic records — the runtime `WareInput`/`SnowPic` accessors read it.
  v0 parses the classic record only (values verified against the game's own recipes); snow is unused.

### 2.3 Wares

Ids = the script/carry convention (**0 trunk, 1 stone, 2 timber**, 3 iron ore, 4 gold ore, 5 coal,
6 iron, 7 gold, 8 wine, 9 corn, 10 bread, 11 flour, 12 leather, 13 sausage, 14 pig, 15 skin,
16 wooden shield, 17 iron shield, 18 leather armor, 19 iron armor, 20 axe, 21 sword, 22 lance,
23 pike, 24 bow, 25 crossbow, 26 horse, 27 fish; `WARE_CNT = 28`; `res/KM_ResTypes.pas:12-41`,
`res/KM_ResWares.pas:53-57`). houses.dat `WareInput`/`WareOutput` already use these ids.

- **serfCarry**: the first 15680 B of `unit.dat` = `array[ware, dirN..dirNW] of TKMAnimLoop`
  (`res/KM_ResUnits.pas:104, 699`); offset = `(ware*8 + dir)*70`, dir 0 = N … 7 = NW; all 28 wares
  have carry loops, `Count = 8` in every direction (verified). `GetSerfCarry` `:673-677`.

### 2.4 Trees

- `CHOPABLE_TREES[1..13, (age1, age2, age3, ageFull, fall, stump)]` (`res/KM_ResMapElements.pas:61-78`):
  S1 88/89/90/90/91/37 · S2 97/98/99/100/101/41 · S3 102/103/104/105/106/45 · S4 107/108/109/110/111/41
  · S5 112/113/114/114/115/25 · S6 116/117/118/119/120/25 · S7 92/93/94/95/96/49 · S8 121/122/123/124/125/64
  · S9 149/150/151/151/152/29 · S10 153/154/155/155/156/29 · S11 157/158/159/160/161/33 ·
  S12 162/163/164/165/166/33 · S13 167/168/169/170/171/33.
- mapelem fields (`res/KM_ResMapElements.pas:127-160`; 99 B records): `Anim@0` (19? no — per-object
  `TKMAnimLoop`), `CuttableTree@70` (set **only** on the ageFull column), `DiagonalBlocked@74`,
  `AllBlocked@78`, `DontPlantNear@90`, `Stump@94`, `CanBeRemoved@95`. Tree sprite for frame f =
  `Anim.Step[f] + 1` (1-based atlas ordinal, same convention as tiles/units).
- **TreeAge is a terrain-tile field, not in the legacy .map** (Byte; `terrain/KM_TerrainTypes.pas:103`).
  On map load the object id implies it: age1 → 1, age2 → 12, age3 → 25, full → **40**
  (`KM_Terrain.pas:535-538`; thresholds `TREE_AGE_1/2/FULL = 2400/5000/8000 div TERRAIN_PACE(200) =
  12/25/40`, `KM_ResMapElements.pas:81-83`). Our sim stores `TreeAge` per tile, initialised from the
  object id.
- **FallTree** (`KM_Terrain.pas:3233-3251`): `Obj := CHOPABLE_TREES[I, caAgeStump]` immediately;
  falling anim added as a separate render entity with start step. After `Anim.Count-1` ticks
  (`:5434-5436`) **ChopTree** (`:3255-3292`): `TreeAge := 0` (the stump stays as the tile object).
- Growth (`:5475-5489`): `Inc(TreeAge)` while 1..40; at 12/25/40 the object swaps to
  age2/age3/ageFull. Plant (`:3142-3172`): `Obj := new tree`, `TreeAge := 1`.
- Lead's map scan: 147 full trees, 7 young, 0 falling/stumps; only 1 full tree within radius 10 of
  the hut → the demo forest (§1).

### 2.5 Tick order (replaces the M2b shortcut)

Per tick (`game/KM_Game.pas:3081-3114`):

1. `IncTick`; `TakePlannedCommands` (`:3086`) — commands queued on the previous tick (our
   `applyOrders`).
2. Terrain update (`gTerrain.UpdateState` `:3102`): falling-tree animation end + tree growth.
3. `gHands.UpdateState(tick)` (`:3106`) — for each hand in ascending id order
   (`hands/KM_HandsCollection.pas:1241-1262`), `TKMHand.UpdateState` (`hands/KM_Hand.pas:2099-2135`):
   a. `fUnits.UpdateState` — units loop **Count−1 downto 0** (`units/KM_UnitsCollection.pas:352-373`):
      per unit `fAction.Execute`; while it continues the task is skipped; else `fTask.Execute`
      (`units/KM_Units.pas:2652-2676`).
   b. `fHouses.UpdateState` — houses loop **Count−1 downto 0**
      (`houses/KM_HouseCollection.pas:426-436`): only `IncAnimStep` (`houses/KM_Houses.pas:2391`).
   c. if `(tick mod gHands.Count) = handID`: `fConstructions.UpdateState` + `fDeliveries.UpdateState`
      (`KM_Hand.pas:2116-2120`) — the logistics pass.
4. `RunningTimer` (`:3114`): the one RNG draw + command application.

`Sim.tick()` keeps its shape (`updateUnits → rng draw → applyOrders`); step 1–3 replaces
`updateUnits`'s body. The M2b "stay/lock" concept: a unit's current action can lock it for N ticks
(`SetActionLockedStay`), during which the task does not run.

### 2.6 Unit tasks (exact state machines)

- `TKMTaskGoHome` (`units/tasks/KM_UnitTaskGoHome.pas:39-65`): 0 walk to `Home.PointBelowEntrance`;
  1 `SetActionGoIn(uaWalk, gdGoInside, Home)`; 2 `Home.SetState(hstIdle)` + stay 5.
- `TKMTaskMining` (`units/tasks/KM_UnitTaskMining.pas:220-429`), `Inc(fPhase)` each execution:
  - **Woodcutter** (`utWoodcutter` → `TKMUnitCitizen`): plan = cut (`KM_UnitWorkPlan.pas:266-268`):
    `ResourcePlan(wtNone,0,wtNone,0,wtTrunk)`; `WalkStyle(uaWalkBooty, uaWork, WorkCyc=15,
    AfterWorkDelay=20, uaWalkTool2, gsWoodCutterCut)`. Action indices: `uaWalk=0, uaWork=1, …,
    uaWalkBooty=10, uaWalkTool2=11` (`common/KM_Defaults.pas:731-734`; index = action − 120).
    Phases: 0 go outside (removes `haFlagpole`); 1 walk to the cutting spot; 2–3 locked stays (0);
    4 work stay `TimeToWork = WorkCyc × max(UnitAnim[uaWork,dir].Count, 1)`; 5 stay 10 (still frame
    5); 6 `FallTree(spot)` + stay 20 (still 5); 7 walk home (`uaWalkTool2`); 8 go inside; 9 →
    SKIP_WORK (woodcutter `ActCount = 0`); 35 `WareAddToOut(wtTrunk, ProdCount1 = ResProductionX)` +
    `SetState(hstIdle)` + stay `AfterWorkIdle−1 = WorkerRest*10−1`. The hut refuses a new cut at
    `CheckWareOut(wtTrunk) ≥ MAX_WARES_IN_HOUSE = 5` (`KM_Units.pas:748-752`;
    `common/KM_Defaults.pas:299`).
  - **Tree choice** (`KM_UnitWorkPlan.pas:187-237, 240-283`): centre = flag point (default
    `PointBelowEntrance`, `houses/KM_Houses.pas:2554`); radius `MiningRange` = 10 for utWoodcutter
    (hardcoded `res/KM_ResUnits.pas:423-433`); tile floodfill `STRAIGHT_COST 5 / DIAG_COST 7`,
    diagonal steps blocked by `DiagonalBlocked` (`terrain/KM_TerrainFinder.pas:215-264`); keep
    `dist ≤ radius`, `≠ avoid`; criteria: `ObjectIsChopableTree(caAgeFull)`, `TreeAge ≥ 40`,
    `CanCutTreeAtVertex`, `ChooseCuttingDirection` (`KM_Terrain.pas:2823-2869, 1744-1758,
    2756-2778`). Decision + RNG: chop if `treeList.Count > 8` or no plant candidates or
    `KaMRandom < count / (count + (best+secondBest)/15)` (`:202-204`); tree pick via
    `GetWeightedRandom` — **1 `KaMRandomS1(weightsSum)` draw**, weight `BASE_VAL/distance`, centre ×2
    (`common/KM_CommonClasses.pas:1312-1338`). **v0 RNG contract: 1 draw for the chop/plant
    decision + 1 draw for the tree pick, per plan.**
  - **Carpenter** (`utCarpenter` @ `htSawmill`, `KM_UnitWorkPlan.pas:376-382`):
    `ResourcePlan(wtTrunk,1,wtNone,0,wtTimber)`; `SubActAdd(haWork1,1)`, `(haWork2,25)`,
    `(haWork5,1)` → `TimeToWork = Round(Anim[act].Count × cycles)`. `HasToWalk = False` → phase 0
    jumps to 9. Phase 9: `WareTakeFromIn(wtTrunk,1)` + `SubActionWork(haWork1)` + stay `T1−1`
    (`T1 = 30`); phases 10–34: `haWork2` stay `T2−1` (`T2 = 10*25 = 250`), then `haWork5` stay
    `T3−2` (`T3 = 30`); then 35: `WareAddToOut(wtTimber, ResProductionX = 2)` +
    `SetState(hstIdle)` + stay `WorkerRest*10−1 = 49`. **Cycle = 361 ticks per 2 timber**
    (`KM_UnitTaskMining.pas:339-425`).
- `TKMTaskDeliver` (`units/tasks/KM_UnitTaskDelivery.pas:355-558`): 0 walk to
  `fFrom.PointBelowEntrance`; 1 go in; 2 stay 5 + `WareTakeFromOut(ware)` + `CarryGive` +
  `TakenOffer`; 3 go out (jumps to 5); 5 walk to `fToHouse.PointBelowEntrance`; 6 go in; 7 stay 5;
  8 `WareAddToIn(Carry)` + `CarryTake` + `GaveDemand` + `AbandonDelivery`. Serf idle between tasks:
  1 `KaMRandom(2)` draw + stay 60 (`units/KM_Units.pas:935-941`).
- **Worker assignment** (`units/KM_Units.pas:462-475, 640-643`): a unit without a home finds the
  nearest house with `WorkerType = its type`, not taken, complete, `RouteCanBeMade(tpWalk)` to
  `PointBelowEntrance` (`houses/KM_HouseCollection.pas:240-276`), then `SetWorker`; walks in
  (`TKMTaskGoHome`) and is invisible inside (`Visible := Step > 0`, `InHouse`). **No worker → no
  production.**

### 2.7 Logistics (offers/demands)

- `WareAddToOut` → `AddOffer(house, ware, count)`; `WareAddToIn` → `AddOffer` too (the store's
  script wares become offers, `houses/KM_HouseStore.pas:96-112`); demands come from `UpdateDemands`
  (`houses/KM_Houses.pas:2221-2277`): for each `WareInput` slot with a real ware, demand up to
  `GetWareDistribution(slot)` (default **5** — `hands/KM_WareDistribution.pas:71-88`), max 5
  outstanding demands; also `AddDemandsOnActivate` (`:649-666`) and script/construction demands
  (`scripting/KM_ScriptingActions.pas:1281-1282`). **The store's `WareInput` is all −1 → it never
  demands** (hence the demo order, §1).
- `TKMHandLogistics.UpdateState` (`hands/KM_HandLogistics.pas:503-611`) runs when
  `(tick mod gHands.Count) = handID`: queue update; remove extra serfs; idle serfs; offers/demands;
  match; `AssignDelivery` (`:2151-2194`) → `serf.Deliver`.
- Validity: house→house needs `RouteCanBeMade(from.PointBelowEntrance, to.PointBelowEntrance,
  tpWalkRoad)` (`:1218-1221`); the serf must `CanWalkTo(pos, offer.PointBelowEntrance, tpWalk)`
  (`:1287-1295`).
- **v0 rule (documented divergence)**: keep offers/demands, the `tick mod handCount` cadence, the
  distribution caps and the road-route validity check, but match **first valid offer → nearest valid
  demand (by road distance) → nearest idle eligible serf** (deterministic). The exact bid math
  (`TryCalculateBid`, importance, serf bids) is deferred; no parity claim in M3 — the CLI freezes
  *our* rule.

### 2.8 House state + wares

- State: `hstEmpty` / `hstIdle` / `hstWork` (`common/KM_Defaults.pas:759`).
- Wares: `ResIn[]`/`ResOut[]`, each ware capped at `MAX_WARES_IN_HOUSE = 5` for non-store houses
  (`KM_Houses.pas:1666-1673`); the store keeps a per-ware stock clamped at 65535
  (`KM_HouseStore.pas:107`).
- Handshakes: `WareTakeFromOut` (`:1973-2010`), `WareAddToIn` (`:1710-1739`), `WareTakeFromIn`
  (`:1939` decl), `WareAddToOut` (`:1742-1774`).
- The sawmill consumes 1 trunk at phase 9 of each cycle; the store's `WareAddToIn` also creates an
  offer (so a store's stock is re-distributable — the tutorial's 30 store trunks feed the sawmill).

### 2.9 Rendering (worker F)

- Houses: `AddHouse` (`render/KM_RenderPool.pas:760-824`): sprite = `WoodPic+1` / `StonePic+1`
  (complete houses draw the stone sprite); corner `= (pos.X−1, pos.Y−1) + pivot` with the size and
  the below-tile terrain height (`CornerX/CornerY` `:767-776`: `X = pos.X + Pivot.X/40 − 1`,
  `Y = pos.Y + (Pivot.Y + Size.Y)/40 − 1 − heightBelow/33.333`). Team colour via the Alt mask
  (rxHouses has team colours; base drawn white + Alt tinted, `:1226-1237`).
- House ware stacks: inputs `SupplyIn[slot, count]+1`, workshop outputs `SupplyOut[slot, count]+1`,
  `count = Min(wares, 5)` (`:878-949`); the store draws none (all −1).
- Carried wares: `AddUnitCarry` (`:1092-1108`): `A = SerfCarry[ware, dir]`; sprite id via
  `Interpolation.SerfCarry` (`res/KM_ResInterpolation.pas:133-150`: `step = aStep mod A.Count + 1`,
  fallback `A.Step[step]+1`); offset `A.MoveX/MoveY`.
- Trees: drawn from the tile object via rxTrees (`:488-494, 570-627`); sprite = `Anim.Step[f]+1`;
  falling trees drawn non-looping with elapsed steps (`:496-502`).
- **Roads**: a `toRoad` tile draws the connectivity sprite
  (`render/KM_RenderTerrain.pas:823-837`): mask bits N=1, E=2, S=4, W=8 → table
  `RoadsConnectivity[0..15] = (248,0)(248,0)(248,1)(250,3)(248,0)(248,0)(250,0)(252,0)(248,1)(250,2)
  (248,1)(252,3)(250,1)(252,2)(252,1)(254,0)` (`:808-812`) → `RenderTile(id, x, y, rot)` (atlas
  `i = id`, rot & 3 UV permutation as M1).

## 3. Interfaces (frozen)

- `packages/mission/mission.ts`:

  ```ts
  export interface MissionHouse { typeId: number; x: number; y: number; owner: number }
  export interface MissionStreet { x: number; y: number; owner: number }
  export interface MissionUnit { typeId: number; x: number; y: number; owner: number } // unit.dat record
  export interface MissionWare { ware: number; amount: number; owner: number }
  export interface Mission {
    mapName: string;
    maxPlayers: number;
    humanPlayer: number;
    houses: MissionHouse[];
    streets: MissionStreet[];
    units: MissionUnit[];
    wares: MissionWare[];
  }
  export function parseMissionScript(bytes: Uint8Array): Mission; // throws on malformed
  ```

- `packages/assets/housedata.ts`:

  ```ts
  export interface HouseSpec {
    typeId: number;        // 0..29 (HOUSE_ID_TO_TYPE id)
    workerType: number;    // unit.dat record, -1 = none
    resIn: number[];       // ware ids, -1 entries kept as parsed (4 slots)
    resOut: number[];      // ware ids
    productionX: number;
    workerRest: number;
    animCounts: number[];  // [haWork1..haWork5] Count values
    entranceDx: number;    // EntranceOffsetX (signed)
    woodPic: number; stonePic: number; // SnowPic lives in the appended THouseInfo block — not parsed v0
    maxHealth: number;     // (WoodCost+StoneCost)*50
    woodCost: number; stoneCost: number;
  }
  export function parseHousesDat(bytes: Uint8Array): (HouseSpec | undefined)[]; // index = typeId
  ```

- `packages/assets/wares.ts`: `export const WARE_CNT = 28;` `export const WARE_NAMES: string[];`
  `export const WT_TRUNK = 0; WT_STONE = 1; WT_TIMBER = 2;`.
- `packages/assets/unitdat.ts` (extend): `UnitSpec.miningRange: number` (woodcutter 10, farmer 10,
  stonemason 16, fisher 14, else 0) + `export function parseSerfCarry(buf: Uint8Array): AnimLoop[][]`
  (`[ware][dir]`, first 15680 bytes).
- `packages/sim/economy.ts`: the world. Public shape (frozen for the viewer):

  ```ts
  export interface EconHouse { uid: number; typeId: number; owner: number; x: number; y: number;
    entrance: {x,y}; state: 'empty'|'idle'|'work'; wareIn: number[]; wareOut: number[];
    workerUid: number; animStep: number; workAnimStep: number; }
  export interface EconUnit { uid: number; owner: number; type: number; posF: {x,y}; dir: number;
    animStep: number; action: 'stay'|'walk'; carry: number; inside: boolean; homeUid: number;
    taskKind: 'none'|'goHome'|'chop'|'saw'|'deliver'|'idle'; }
  export interface SimEvent { tick: number; text: string }
  export class EconomyWorld {
    readonly houses: EconHouse[]; readonly units: EconUnit[];
    readonly grid: PassGrid; readonly roadGrid: PassGrid;
    readonly tickCount: number; readonly events: SimEvent[];
    tick(): void;
    treeAt(x: number, y: number): { obj: number; age: number } | null;
    wareCount(h: EconHouse, ware: number): number; // in + out
  }
  export function createEconomyWorld(o: { map: KaMap; tiles: TileFlags[]; elems: MapElem[];
    unitSpecs: UnitSpec[]; serfCarry: AnimLoop[][]; houseSpecs: (HouseSpec|undefined)[];
    mission: Mission }): EconomyWorld;
  export function applyDemoScenario(w: EconomyWorld, o?: { forestCount?: number; storeTimberOrder?: number }): void;
  ```

- `tools/econsim/cli.ts`: `--check` (frozen numbers), `--ticks N` (event log), `--json`,
  `--no-scenario`. Data paths like `tools/walksim` (install read-only; env overrides).

## 4. Worker split

- **Worker E** — `packages/mission/**`, `packages/assets/{housedata,wares}.ts`, edits to
  `packages/assets/unitdat.ts` (miningRange + parseSerfCarry), `packages/sim/economy.ts` (+ minimal
  edits to `sim.ts`/`walk.ts`/`terrain.ts` where the economy needs hooks), `tools/econsim/**`,
  tests. Must not touch `apps/**`, `docs/**`, `package.json`.
- **Worker F** — `apps/web/**` only. Must not touch `packages/**`.

## 5. Viewer (worker F)

- `serve.ts`: new route `/mission/TownTutorial.dat` (raw bytes) from
  `process.env.KAM_MISSION ?? 'C:\\Users\\me\\Desktop\\KaM Remake\\Tutorials\\Town Tutorial\\Town Tutorial.dat'`;
  add `houses.dat` to the defines route list (`/defines/houses.dat`).
- `play.html` economy mode: load map + tiles + mapelem + unit.dat + houses.dat + mission, build the
  world, `applyDemoScenario`, run at 10 ticks/s (M2b catch-up cap). Draw: M1 terrain, road overlay
  pass (connectivity table), trees + falling/stumps, houses (stone sprite + team tint), ware stacks,
  serfs (carry overlays; hidden when inside), HUD (tick, houses, serfs, selected-house wares, last
  event), camera keys 1/2/3 jump to the north/south/NE village. Keep M2b select + click-to-move for
  hand-0 units without tasks.

## 6. Acceptance (lead)

1. `node tools/econsim/cli.ts --check` → `ECON CHECK PASS` (frozen event log + final counts + state
   sha256 — values frozen by the lead after the first deterministic run and written here).
2. `npm test` (new tests included) exit 0; `npx tsc --noEmit` exit 0.
3. Lead's independent checks: (a) own mission parser → house/street/unit/ware counts + a canonical
   sha over the parsed lists vs the sim's loaded world; (b) own houses.dat dump (already done,
   `%TEMP%\opencode\kamweb_m3_houses.mjs`) vs the parser's spec values; (c) browser CDP run:
   houses/trees/serfs drawn (page counters), the chain advances (tree count drops, trunk/timber
   counts move), no exceptions; screenshots.
4. Regressions: M0 `CHECK PASS`, M1 `MAP CHECK PASS`, M2 `replayinfo` §2.4 numbers, M2b
   `WALK CHECK PASS` + the CDP journey 16/16.

## 7. Acceptance record

### 7.1 Worker E — economy sim core: accepted

- `node tools/econsim/cli.ts --check` → `ECON CHECK PASS` (exit 0), 6000 ticks, 336 events; two
  consecutive runs print identical numbers and sha256
  `6d780b62b56f83b3c9f4b1aa2d414ae6186c0a84491843d315554d49f7fcbc41` (only the wall-clock ms differ).
- `npm test` → **62/62** (41 M0–M2b + 21 new); `npx tsc --noEmit` exit 0;
  `node tools/walksim/cli.ts --check` → `WALK CHECK PASS`; perturbed `expected.ts` → FAIL + exit 1.
- Lead's independent cross-check (`%TEMP%\opencode\kamweb_m3_leadvsE.mjs` vs the lead's own
  `kamweb_m3_leadmission.mjs` / `kamweb_m3_houses.mjs`): mission counts 21 houses / 249 streets /
  81 units / 22 ware lines and per-hand humanoids 7/30/12 (49 spawned + 32 animals parsed, not
  spawned) match; hand-1 chain houses `Store(15,113) Woodcutters(4,119) Sawmill(8,115)` and the
  10 ware lines match; sawmill/hut/store spec values (pics, wares, production, worker rest, anim
  counts, entrance, costs, worker type, health) match the raw `houses.dat` bytes; unit.dat
  woodcutter `miningRange 10`; serfCarry trunk dir0 `count 8 step1 321`.
- Frozen numbers (6000 ticks, scenario on): load houses 21, streets 249, roadTiles 249, units 49,
  animals 32, walkable 11705, trees 159 (147 map + 12 demo), storeTrunks 30, storeTimber 20; events
  worker-assigned 9, delivery-assigned 143, ware-delivered 143, chop-plan 5, trunk-taken 13,
  tree-fell 5, trunk-out 5, timber-out 13; final trunksProduced 5, trunksTaken 13, timberProduced
  13, treesFelled 5, timberDelivered 45, storeTimber 30, sawmillTimber 6, hutTrunks 5,
  rngState 619533300. The carpenter's cycle measures exactly 361 ticks (timber-out at 453/814/1175).
- Accepted v0 divergences (documented in module headers): carpenter cycle frozen at 361 ticks (the
  as-coded stay pattern measures 358 — a future parity task); goIn/goOut = 1 tick; logistics
  matching rule per §2.7; footprint from the hardcoded PlanYX per the §2.2 errata.
