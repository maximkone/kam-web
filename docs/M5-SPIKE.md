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

### 7.4 Worker M — the AI economy half: accepted

- `node tools/aisim/cli.ts --check` → `AI CHECK PASS (30000 ticks, 789 events)` (exit 0); two runs
  identical sha256 `f62714ce8f5aada2634107349e8fac4b8bc9d3f9ae646f9ebc53e85bcdbbf91a`.
- Frozen scenario (`MapsMP/Battle Sun` 128×128, hand 1, advanced AI on 4 hands): the AI **plans and
  builds its economy village** — planned 8 (sawmill, coal mine, farm, woodcutters, store, school,
  quarry ×5), placed 8, built 5, **86 road tiles built**, 7 sites dug, 4 houses activated; **39 units
  trained** (serfs 22, builders 21, metallurgists 3, miners 3); the chain runs (tree-fell 5,
  trunk-out 5, deliveries 149); wares trunk 5 / timber 35 / goldOre 30 / coal 30 / gold 31 / wine 30 /
  bread 40 / sausage 20 / fish 10; `cityCompleted=false` inside the 30k-tick window (the AI is still
  expanding — expected).
- `npm test` **119/119** (ai.test.ts wired in — by the audit commit, verified); `npx tsc --noEmit`
  exit 0; regressions unchanged: WALK / ECON (sha) / COMBAT (sha) / BUILD (sha) / MAPSCAN.
- Documented simplifications (M's report): influence reach 3/5 per tile (≈40 tiles) instead of the
  game's 10/14 (≈12) — a one-line constant if stricter fidelity is wanted (the quarry chain would
  stall earlier); the Eye is shared/context-switched per the game's gotcha; `tpOwn` mapped from
  `ownership > 0`; heavily simplified BuildFF; only the planner's init-point RNG draw;
  `!SET_AI_CHARACTER` values outside the notes' "read by newAI" set are stored but unused; schools
  are done (queue → gold → self-train → spawn → `UnitTrained`); barracks equip is worker N's
  interface. Two Pascal bugs were found and fixed during the port (school script id 13, not 19;
  `GetHousesToUnlock` loop condition `K <> High(HTArr)`).
- External note: audit commit `80ac063` (by center) landed between the M5a commits and this one
  (`serve.ts` 400 on bad percent-encoding + ai tests wired into `package.json`); verified compatible.

### 7.5 Worker N — the AI military half (M5c): accepted (aisim attack phase; browser match open)

Files: `packages/sim/aiarmy.ts` (ArmyManagement, ArmyAttackNew, ArmyDefence), `packages/sim/aisupervisor.ts`
(Supervisor), `packages/sim/ai.ts` (`!SET_AI_DEFENSE`/`!SET_AI_ATTACK`/COPY/CLEAR/TROUP_PARAM/AUTO_DEFEND
records, `AiPlayer.attachArmy`), `packages/sim/economy.ts` (additive barracks API: `barracksAddRecruit`,
`barracksCanEquip`, `barracksEquip`, `barracksRecruitCount`, `handWarriorCount`; school recruits enter the
barracks), `packages/sim/aiarmy.test.ts` (6 tests), `tools/aisim/cli.ts` (attack phase, `--scenario attack`),
`tools/aisim/expected.ts` (attack numbers frozen).

- `node tools/aisim/cli.ts --check` → `AI CHECK PASS (economy 30000 ticks, 843 events; attack 12000 ticks)`
  (exit 0). Two runs identical: economy sha `1a425dcd44f3672a9d5b5059f0f8ca8b4f2ee4c15130d81737b013a63eb2fe0e`,
  attack sha `d1825fa9985e904f3ac9c1281b5095a75f33b586518d7d18dcda4e6221cb7c59`.
- **Attack phase** (`MapsMP/Battle Sun`, hand 1, 12000 ticks, the scenario grants below): equipped 12 (the AI's
  RecruitSoldiers equips 12 warriors from the granted recruits), 63 warriors alive at the end; the Supervisor
  issued 1 attack request (FFA, four teams); 5 groups joined the attack (combat groups max 5); kills by hand 1
  **9**, kills by the enemies 3 (losses 3); house damage **550**; one enemy store destroyed (enemy houses 3→2);
  enemy warriors 18→12.
- **Economy numbers moved** (rule of 7.4 — explained): the frozen economy run is now `1a425dcd…` (was
  `f62714ce…`). Cause: the Supervisor's DivideResources (mine division, KM_Supervisor.pas 1153–1238) runs in
  every advanced-AI game and writes the predictor's `ironMineCnt`/`maxGoldMineCnt` (fields already wired:
  the iron reserve and the gold-mine cap, KM_CityPredictor.pas 561, 796). Proof: the same run with the
  division switched off (`--ticks 30000`) prints `sha256=f62714ce…`. Effect: the coal mine and the farm are no
  longer planned, one inn is planned and built; events 789→843. The attack phase does not touch this run
  (no barracks is equipped in the economy run). **The lead decides whether to keep the new economy numbers.**
- `npm test` **125/125** (aiarmy.test.ts wired into `package.json`); `npx tsc --noEmit` exit 0.
- Regressions: `WALK CHECK PASS`; `ECON CHECK PASS (6000 ticks)` sha `6d780b62…` unchanged; `COMBAT CHECK PASS`
  sha `09a19821…` unchanged; `BUILD CHECK PASS` sha `98b80525…` unchanged; `MAPSCAN CHECK PASS (243 maps, 0 anomalies)`.

**Attack-scenario grants** (`tools/aisim/cli.ts`, documented; they stand in for what the v0 world cannot yet
make, the way the RMG kit does for the economy): hand 1 gets a military kit (40 axes, 40 wooden shields,
40 leather armours in the store — no smithy in v0); a finished barracks on the first valid spot 4–12 tiles
from the store (a map's SET_HOUSE would carry it); 12 recruits waiting in that barracks (the v0 school
stalls, see open items); a start army of 6 full militia groups (54 militia) around the store (a map's
SET_UNIT records would carry it; four groups is the minimum for an attack, and they must pass the draws);
every other hand gets a 6-militia garrison beside its store.

**Documented simplifications (M5c):**
- No NavMesh: PlanPath keeps the Pascal's reach thresholds (AI_Par ATTACK_SQUAD) and walks straight at the
  target; the group's tile router walks it. AvoidEnemyRoute/AvoidTrafficRoute, the navmesh defence lines
  (FindTeamDefences) and the navmesh distances are not ported.
- Defence positions: a v0 line generator (rings 4–14 around the city centre, reachable, 3 tiles apart, nearest
  third to the enemy on line 0; count = round(troops/8)+5). The fixed `!SET_AI_DEFENSE` list (UpdateFixedDefences,
  all on line 1) is ported as written.
- No split: combat has no OrderSplitUnit/OrderSplitLinkTo, so linking moves whole members (up to 9) and a
  group is placed whole.
- Ranged groups do not reposition in formation (MoveRangedInFormation); they attack like melee.
- No food: no OrderFood, FoodProblems is false. Soldiers never eat; condition 2700 falls by 1 every 10 ticks,
  so unfed soldiers starve after roughly 16000–19000 ticks (the attack run ends at 12000).
- Equip: `barracksEquip` takes the wares from the hand's stock (no barracks WareOrder in v0), skips the
  Locks.GetUnitBlocked check, and places the warrior at the door at once (no WarriorWalkedOut walk);
  WarriorEquipped runs in the same call.
- The Supervisor: alliances are the v0 rule (same hand allies, else enemies), so each team is one hand;
  CompareAllianceStrength is the warrior count (A−E)/(A+E), not the army-power model; the combat status matrix
  (UpdateCombatStatus) and the army-vector clusters (UpdateAttacks, DivideForces, FindPositions, EvaluateEnemy)
  are not ported; AttackNew targets come from the request's enemies (nearest house, TARGET_HOUSES first).
- Mine division: one hand per team; the Pascal's unstable SortCustom is replaced by a stable sort (ties).
- Scripted attacks (`!SET_AI_ATTACK`) hand the found target to the released groups; the Pascal's OrderAttack
  drops it (see Pascal notes). Kills and losses are read from the combat sim's `unit-killed` events.

**Pascal notes (kept as the source does them, not fixed):**
1. KM_ArmyManagement.pas 484–512: the attack-request branch passes `TargetPoint`, which is never assigned;
   OrderAttack ignores it anyway.
2. KM_ArmyManagement.pas 462–471 + 342–387: `OrderAttack` calls `AddGroups(aAG.GroupArr)` with the whole array,
   so the slots past the counted groups (written by the scan, not counted) are added too. Reproduced.
3. KM_ArmyManagement.pas 404–414 (FilterGroups): after the swap, `Inc(MenCnt, GroupArr[ActIdx].Count)` adds
   the displaced group's count, not the chosen group's. Reproduced.
4. KM_ArmyAttackNew.pas 488–490: `StuckCounter` is capped at `ATTACK_SQUAD_TrafficDetection_Limit` (1) but
   `StuckInTraffic` needs `> Threshold` (10), so it can never be set. Reproduced.
5. KM_Supervisor.pas CompareAlliances: `DistCoef` (DISTANCE_COEF_1v1/FFA) is computed and never used in the
   comparison. Not used here either.
6. KM_Supervisor.pas UpdateState: the defence and attack windows share one modulo variable, so they are
   exclusive in a tick (by design of the window offsets; copied).

**Open items (found, not fixed — economy half and the v0 world):**
- The barracks is reserved by the planner (`houseReservation` plan, placed=false) and never placed; the
  planner's reserved count is what the city stats read, so `requiredHouses[barracks]` drops to 0 at the first
  predictor update (warfare>0 is needed later). In the economy run no barracks is built. (Economy half: the
  reserved plan needs the builder's placement path; not investigated further here.)
- The school stalls: in the attack run the completed school stopped after 14 units (builders queued), its gold
  stock is 0 while the store holds 56 gold, and its gold demand has count 0 at 60000 ticks (the second school is
  still a WIP). So the v0 economy trains almost no recruits; the attack scenario therefore grants 12 recruits.
- `recruitsTrained=0` in the frozen attack run is this stall, not the military code.

**Not done:** the browser match against the AI on a real map (the spec's browser step; the aisim check is the
acceptance here). The viewer does not show the army (groups, defence lines) yet.
