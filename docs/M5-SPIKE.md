# M5 spike — construction slice + the Advanced AI

Owner priority (2026-10-17): **play vs the Advanced AI on real maps.** Two waves:
- **M5a — construction slice** (this document, §1a/§2): house/field plans, builder tasks, build
  materials, activation, roads/fields — the pipeline the AI's CityBuilder drives.
- **M5b — the newAI port** (§1b/§3): Eye, CityPredictor, CityPlanner/Builder/Management, Army
  management (AttackNew/Defence), Supervisor, with the mission's `!SET_AI_*` settings honoured.
  Facts: `docs/M5-AI-NOTES.md` (the AI research digest).

Workers: **K** = construction sim (`packages/sim/**` + `tools/buildsim/**`); **L** = construction
viewer (`apps/web/**`); **M** (later) = the AI port. Same rules as M2b–M4.

## 1a. M5a scope (construction)

In:
- **Plan stores** per hand: house plans, field plans, ready-to-build house list, worker registry,
  locks (`fHouseUnlocked`/`ReleasedBy` chain).
- **Plan API**: `CanAddHousePlan` (terrain + BuildArea tile rules), `AddHousePlan` (entrance→Loc
  shift), `RemHousePlan`, `HasHousePlan`, field plans (`AddField`/`RemFieldPlan`).
- **Builder tasks** (`TKMTaskBuildHouseArea`, `TKMTaskBuildHouse`, `TKMTaskBuildRoad`,
  `TKMTaskBuildField`) with their real phases/timings and the demands they create.
- **Materials**: the construction delivery path (serf `dkToConstruction` phases), `WareAddToBuild`,
  delivered counters, supply piles.
- **Progress + activation**: +5 per hammer hit, +50 reserve per delivered ware unit, stage
  transitions, `Activate` (locks + FOW + demands + flag).
- **AI-facing queries**: plan wood/stone demands, `IsComplete`, `BuildingProgress`, field counts,
  tile queries (`TileIsWalkableRoad`/`TileIsCornField`/`TileIsWineField`).

Out (documented): repair list + repair task, demolition-from-plan, fake fields, wine fields
(`TKMTaskBuildWine`), script events/stats, save/load of the lists, walls (there is **no wall system**
in this revision — watchtowers build through the normal house path).

## 2. M5a frozen facts (r15472; refs into `_ref/kam_remake/src`)

### 2.1 Plans

- `TKMHousePlan = {UID, HouseType, Loc, JobStatus, Worker}` (`hands/KM_HandConstructions.pas:43-50`);
  `JobStatus = jsEmpty/jsOpen/jsTaken` (`:11-15`). `Loc` = the house position: `AddHousePlan` shifts
  the given entrance by `EntranceOffsetX` before storing (`hands/KM_Hand.pas:1294-1301`).
- `TKMHousePlanList` (`KM_HandConstructions.pas:55-88`): `AddPlan` (`:686-705`, UID from the tracker,
  `jsOpen`), `BestBid` (nearest idle-capable worker, `:708-727`), `GiveTask` (`:791-796` →
  `BuildHouseArea`, marks `jsTaken`), `RemPlan` (`:827-843`, cancels the worker's task),
  `TryGetPlan`/`ReOpenPlan`/`ClosePlan`, `GetOutlines`/`GetTablets` (`:873-922`, tablet point =
  `Loc.X + EntranceOffsetX`), demands `GetPlansWoodDemands`/`GetPlansStoneDemands` (`:1421-1440`,
  derived from `WoodCost`/`StoneCost` — nothing stored per plan).
- `TKMFieldPlan = {Loc, FieldType, JobStatus, Worker}` (`:91-96`); `TKMFieldworksList` (`:100-143`)
  with `AddField`/`RemFieldPlan`/`HasField`/`GiveTask` (`:471-476` → `BuildField`).
- Hand API: `CanAddHousePlan` (`KM_Hand.pas:1081-1115`), `CanAddHousePlanAI` (`:1118-1194` — the
  extra AI rules: no blocking roads, `Influences.AvoidBuilding`, entrance owner, choke point, road
  row below, allied fields/plans), `AddHousePlan` (`:1294-1307`), `RemHousePlan` (`:1338-1350`),
  `HasHousePlan` (`:1310-1313`).
- Locks (`hands/KM_HandLocks.pas`): `HouseCanBuild` (`:87-95`, default = `fHouseUnlocked[type]`),
  `HouseCreated` (`:80-83`) → `UpdateReqDone` (`:69-76`) unlocks every house whose
  `gRes.Houses[H].ReleasedBy = aType`; `htStore` released at start (`:62`); `GetUnitBlocked`
  (`:138-147`, barracks equip gate; may start all-false).

### 2.2 Builder tasks (`units/tasks/KM_UnitTaskBuild.pas`)

| task | refs | key facts |
|---|---|---|
| `TKMTaskBuildRoad` | `:19-34, 218-291` | 0 walk; 1 lock `tlRoadWork` + `ClosePlan` + `AddDemand(wtStone,1)`, stay 11; 2-3 dig stay 11; **4 waits for stone (stay 30, repeats)**; 5-6 dig stay 11; 7 dig + `FlattenTerrain` + `RemoveObject`; 8 `SetRoad` + `RemoveObjectsKilledByRoad` + unlock |
| `TKMTaskBuildField` | `:53-66, 503-543` | 1 lock + `ClosePlan`; 2 stay 11 ×10 (dig at 6/8); 3 `SetField(ftCorn)` |
| `TKMTaskBuildHouseArea` | `:68-91, 681-765` | 1 `AddHouseWIP`; 2-6 walk/dig/flatten the `BuildArea` cells (reversed), entrance road, tile lock `tlDigged`; 7 step out → `fHouseReadyToBuild`; **on success its destructor sets `hbsWood`, adds the house to the list, and creates both demands** (`:633-639`) |
| `TKMTaskBuildHouse` | `:93-109, 845-901` | `PickRandomSpot` + walk; hit = `IncBuildingProgress` + `SetActionLockedStay(6, uaWork)`; **5 hits per spot** then a new spot; sets terrain `hsBuilt` when stone starts (`:877-878`) |
| `TKMTaskBuildWine` | `:36-51, 363-435` | out of v0 |

- Assignment (`KM_HandConstructions.pas`): `UpdateState` (`:1389-1418`) runs **staggered**
  `tick mod gHands.Count = handID` (`KM_Hand.pas:2116-2120` — note: `gHands.Count`, **not**
  `MAX_HANDS`) and does `AssignRepairs → AssignHousePlans → AssignFieldworks → AssignHouses`;
  `BestBid` = diagonal distance + `Assigned*BID_MODIF(5)`; per-site builder caps `MAX_WORKERS`
  (positional array `:226-234`, e.g. barracks 12, store 10, sawmill 8, woodcutters 6, gold mine 3).
- Progress (`houses/KM_Houses.pas`): `IncBuildingProgress` (`:1234-1271`) — **+5 per hit**, a reserve
  of **+50 per delivered ware unit** (`:1240-1249`); `hbsWood → hbsStone` at `WoodCost*50`
  (`:1254-1256`), `→ hbsDone` at `+StoneCost*50` (`:1258-1261`); `MaxHealth = (WoodCost+StoneCost)*50`
  (`res/KM_ResHouses.pas:629-633`); `CheckResToBuild` (`:1655-1663`).
- Completion → `Activate(True)` (`:1264`): locks (`:684`), FOW reveal by BuildArea with house `Sight`
  (`:689-694`), flag sub-actions (`:697-698`), `AddDemandsOnActivate` (`:701`). **No `AfterBuilt`
  exists** — `Activate` is the hook.

### 2.3 Materials

- Demands are created when the digged site joins the house list:
  `AddDemand(fHouse, nil, wtTimber, WoodCost, dtOnce, diHigh4)` + stone (`KM_UnitTaskBuild.pas:637-638`).
- Delivery: `fDeliverKind = dkToConstruction` (chosen when the target house is not complete,
  `KM_UnitTaskDelivery.pas:81-86`); phases 5/6/7 (`:454-483`): walk to `PointBelowEntrance` at 1.42
  speed, if a builder is hitting **from the entrance** walk diagonally to the entrance, then
  `WareAddToBuild(Carry)`; only `IsDestroyed` abandons a construction delivery (`:193-198`).
- `WareAddToBuild` (`KM_Houses.pas:1805-1817`): timber/stone only, clamped to the costs; sets
  `ReadyToBeBuilt`; `GetBuildWoodDelivered`/`GetBuildStoneDelivered` (`:1197-1216`) are what the AI
  reads; queue rule: WIP houses always accept (`KM_HandLogistics.pas:1229-1231`).
- Supply piles: `hbsWood/hbsStone` only (`KM_Houses.pas:2406, 2411`); wood sprite `260+n-1`, stone
  `267+n-1`, offsets from `BuildSupply` (`render/KM_RenderPool.pas:716-743`).

### 2.4 AI terrain changes — corrected premise

**Live `KM_CityBuilder` never mutates terrain.** Its live code only queries (`:565, 573-581, 761,
792`) and places **plans**: `FieldworksList.AddField(...)` for roads/fields (`:596-609, 662, 722,
769, 781, 1614-1615`) and `AddHousePlan` (`:953`); the `BuildHouse_GA_MODE` block (`:1767-2385`,
619 lines) is dead (`GA_PLANNER` is defined nowhere). The only live direct terrain mutation in
`src/ai` is `PlaceFirstStorehouse` (`ai/KM_AI.pas:595-665`). **Consequence: the AI's road/field
building requires the builder tasks** (`TKMTaskBuildRoad/Field` apply `SetRoad`/`SetField`/
`FlattenTerrain`/`RemoveObject`).

### 2.5 Training + equip (M5a adds the pieces the AI drives)

- School (`houses/KM_HouseSchool.pas`): queue `fQueue[0..5]` (slot 0 trains), `AddUnitToQueue`
  (`:116-133`), `StartTrainingUnit` needs `wtGold` (`:249-262`), `UnitTrainingComplete` (`:266-283`),
  `GetTrainingProgress` 0..150 (`:293-305`); training task `KM_UnitTaskSelfTrain.pas:70-118`
  (5×29 stays + 9 idle ≈ 154 ticks).
- Barracks (`houses/KM_HouseBarracks.pas`): `CanEquip` (`:331-341`), `EquipWarrior` (`:344-380`),
  `Equip` (`:385-401`), `TROOP_COST` (`res/KM_ResUnits.pas:168`), `TROOPS_TRAINED_CONDITION = 0.6`
  (`common/KM_Defaults.pas:376`); exit → `WarriorWalkedOut` (`KM_Hand.pas:568-605`) → AI
  `WarriorEquipped` (`ai/newAI/KM_ArmyManagement.pas:189-196`).
- AI recruit path: `RecruitSoldiers` (`:199-287`) — group type `KaMRandom(4)` with ≤10 retries
  (`:254-258`), per-barracks equip loop (`:276-283`), cadence `tick mod 27 = owner`.

## 3. M5b interfaces (frozen now, implemented in wave 2)

- `packages/sim/construction.ts`: `HousePlan {uid, typeId, x, y, status, workerUid}`, `FieldPlan`,
  `ConstructionState` per hand (`plans`, `fields`, `sites`, `locks`), API
  `addHousePlan(hand, typeId, x, y)`, `canAddHousePlan(...)`, `remHousePlan(...)`,
  `addFieldPlan(hand, x, y)`, plus the builder-task glue in `economy.ts`.
- `packages/sim/ai.ts` (wave 2): `AiPlayer` with `eye`, `cityPlanner`, `cityBuilder`,
  `cityManagement`, `armyManagement`, `supervisor` per the notes' order; `updateState(tick)`;
  the world exposes what the notes' §3 checklist needs (stats, locks, influences, navmesh-lite).
- `tools/buildsim/cli.ts` (wave 1) and `tools/aisim/cli.ts` (wave 2): deterministic checks with
  frozen numbers + state sha256.

## 4. Workers

- **Worker K** — `packages/sim/construction.ts` (+ additive `economy.ts`/`housedata.ts` edits),
  `tools/buildsim/**`, tests. Must not touch `apps/**`, `docs/**`, `package.json`.
- **Worker L** — `apps/web/**`: building stages (wood/stone blend), supply piles, plan markers
  (outlines/tablets), the site dig visuals, school/barracks basics for the human (queue + equip
  buttons are optional v0; the HUD shows progress), plus keeping every existing hook working.
- **Worker M** (wave 2) — `packages/sim/ai.ts` + `tools/aisim/**` against `docs/M5-AI-NOTES.md`.

## 5. Viewer (worker L)

- WIP houses: `hbsNoGlyph` invisible, `hbsWood`/`hbsStone` drawn with the wood/stone stage sprites
  and progress blend (`KM_Houses.pas:2395-2435`, `KM_RenderPool.pas:760-824`), supply piles
  (`260+n-1`/`267+n-1`), plan outlines + tablets for the human's plans.
- HUD: selected house shows build state/progress/HP; the picker/combat/economy features stay intact.

## 6. Acceptance (lead)

**Wave 1 (construction):**
1. `node tools/buildsim/cli.ts --check` → `BUILD CHECK PASS` (frozen: a scripted build on the
   tutorial/Arena — plan → dig → materials → build → activate, plus a road and a field; event log +
   state sha256).
2. `npm test`, `npx tsc --noEmit` exit 0; regressions M0–M4 all green.
3. Lead's independent check: the frozen scenario re-run twice identical; a second scenario (build a
   road + field) deterministic; browser CDP: place a plan (or use a scripted build), watch the site
   get dug, materials delivered (supply piles grow), the house rise through wood/stone and activate;
   screenshots.
4. Regressions: M0 `CHECK PASS`, M1 `MAP CHECK PASS`, M2 §2.4, M2b `WALK CHECK PASS`, M3 `ECON
   CHECK PASS`, M3b `MAPSCAN CHECK PASS`, M4 `COMBAT CHECK PASS`.

**Wave 2 (AI):** the `aisim --check` deterministic AI-vs-idle skirmish (the AI builds its city —
houses/roads/fields/mines — trains and equips soldiers, forms groups, attacks; frozen event counts +
sha256), then a browser match where the human can fight it on a real map.

## 7. Acceptance record

### 7.1 Worker K — construction sim: accepted (wave 1)

- `node tools/buildsim/cli.ts --check` → `BUILD CHECK PASS` (2000 ticks, 281 events) (exit 0); two
  runs identical sha256 `98b805259afc4f7020f07f378dd9d6368f30a111d3f5952936855d74ca7315e3`;
  perturbed `expected.ts` → FAIL.
- Frozen numbers (tutorial, hand 1): hut plan → dug → **materials delivered** (woodDelivered 3,
  stoneDelivered 2, supply 5) → built (`hut=done progress=250`) → `activated=1`; road dug+built,
  corn field built, `doorRoad=true`; events incl. `build-area-assigned=1 build-house-assigned=9
  house-wip=1 house-plan-digged=1 house-activated=1 road-built=2 field-built=1`.
- `npm test` **109/109** (construction.test.ts wired in by the lead); `npx tsc --noEmit` exit 0.
- Regressions: WALK CHECK PASS, ECON CHECK PASS (sha `6d780b62…` unchanged), COMBAT CHECK PASS (sha
  `09a19821…` unchanged), MAPSCAN CHECK PASS.
- Accepted v0 divergences (K's flags): `1.42` in the spec is a distance tolerance, not a speed
  (implemented as the distance intent); `FlattenTerrain` simplified (half-mix toward the corner
  average, no `tpElevate`/recursion/lighting); `GetOutOfTheWay` ported with the weighted-random
  neighbour, `JamMeter`/tower checks skipped; `CanAddHousePlan` FOW branch skipped and
  `CanAddHousePlanAI` deferred to wave 2; wine fields out; `dkToUnit` minimal (builders only);
  repairs/demolition-from-plan/fake fields/save-load out; three additive parser fields
  (`tiledata.soil`, `mapelem.killByRoad`, `terrain.checkHeightPass(limit)`).

### 7.2 Worker L — construction viewer: accepted (wave 1)

- `npx tsc --noEmit` exit 0; `SERVE CHECK PASS`; L's own CDP run **44/44** — the full sequence with
  real clicks on the tutorial (store plan at entrance (19,14) → Loc (20,14)): dug (tick 118) → wood
  (644) → serfs deliver (piles grow, max wood 4 / stone 5) → stone (1250, 300/550) → **done and
  activated (1546, 550/550)**; roads 249→256; corn field built; screenshots (plan markers, road
  plans, site dug, wood stage, supply piles, stone stage, complete house, corn built).
- Lead's independent browser run (`%TEMP%\opencode\kamweb_m5a_leadcdp.mjs`, live server on 8144):
  boot counters hold (21/34/159/30), FOW 255 at the village, a **real click places a store plan**
  (plan `taken` by a builder), the site **digs and reaches the wood stage** (house state log
  `digging → wood`), and with the plan off the road network no materials arrive — the documented
  road-connection rule (`ValidDelivery`). The delivery-dependent completion is proven by the
  headless check (§7.1, lead-run) and L's run above. Regressions on the same page: economy ticking,
  M3b picker loads Arena, 0 blocked requests, no exceptions.
- Accepted viewer deviations (L's flags): placement calls the construction module directly
  (`canAddHousePlan`/`addHousePlan`; a world wrapper would be nicer); the dug site shows fences +
  live flattened terrain (the game sets no dig overlay for house areas); deliveries need a road
  connection; wine placement out; plan markers cover the human hand.

### 7.3 Wave 2 (the AI) — next

`docs/M5-AI-NOTES.md` + §3 of this document; worker M (economy AI: Eye/Influences/CityPredictor/
CityPlanner/CityBuilder/CityManagement), then worker N (military AI: ArmyManagement/ArmyAttackNew/
ArmyDefence/Supervisor). Acceptance: `tools/aisim` deterministic AI-vs-idle skirmish + a browser
match on a real map.
