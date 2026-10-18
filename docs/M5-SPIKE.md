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

### 7.6 Worker N2 — the organic army: investigated, not raised (the chain is blocked by production scope)

Goal: the AI raises its own army in the organic run, no scenario grants. **Result: no link of the chain is
reached.** The two bugs of 7.5 were reproduced and traced; neither is the cause, and no fix landed. Premises
corrected below. The measured chain is frozen so a future production change shows up as a moved number.

- `node tools/aisim/cli.ts --check` → `AI CHECK PASS (economy 30000 ticks, 843 events; attack 12000 ticks; organic
  60000 ticks)` (exit 0), run twice, identical: economy sha `1a425dcd…` (unchanged), attack sha `d1825fa9…`
  (unchanged), **organic sha `c2fe7b1c5fdc15b49a6c23792fa6790053fce96abab9a40adfcd268d385b3eb8`** (new, frozen in
  `tools/aisim/expected.ts` as `EXPECTED_ORGANIC`). The organic phase is the economy scenario with **no military
  grants** (no kit, no barracks, no recruits, no start army, no garrison) for 60000 ticks; the check takes about
  40–50 s in total.
- **Organic chain (60000 ticks, hand 1, Battle Sun)** — every link is "no":

  | link | reached | first tick | value |
  |---|---|---|---|
  | quarry produces stone (`stone-*` events) | no | – | 0 stone events (5 quarries built, 0 produced) |
  | sawmill placed (`house-wip type=0`) | no | – | 0 sawmills |
  | barracks wanted (predictor `requiredHouses[21] > 0`) | no | – | 0 |
  | barracks placed (`house-wip type=21`) | no | – | 0 |
  | barracks built (`house-activated type=21`) | no | – | 0 |
  | recruits trained (`school-unit-trained type=13`) | no | – | 0 |
  | weapons/armour produced (`ware-produced`) | no | – | 0 (the port has no workshop or smithy output) |
  | warfare wares in stock at the end | no | – | 0 |
  | soldiers equipped (`barracks-equipped`) | no | – | 0 |
  | army groups formed (military groups with members) | no | – | 0 (81 units, all civilians) |

- **Bug 1 (barracks never placed): the premise was wrong for the organic run.** No barracks is reserved or
  planned at any tick. The reservation is the **sawmill** (the barracks' unlock prerequisite,
  `_ref/.../src/res/KM_ResHouses.pas:275` `UnlockedByHouse: htSawmill`): planned at (43,106) with `placed=false,
  houseReservation=true` from about t=3000 (the woodcutter, which unlocks the sawmill, is complete at about t=6000).
  Root cause, traced by probes (`dbg2`–`dbg4`, scratch, not committed):
  1. The builder's `CheckHouseReservation` only considers `RESERVATION_FullSet[0..STONE_SHORTAGE_IDX=2]` (school,
     inn, quarry) while `fStoneShortage` holds (`KM_CityBuilder.pas:1330–1332`; port `ai.ts:4664`). The sawmill
     is index 5, so its reservation is never placed under a stone shortage.
  2. Stone stock falls 80 → 58 → 15 → 5 (t 1000 → 3000 → 6000 → 10000): roads (1 stone per tile) and houses consume
     it. The shortage flag is set from t≈6000 on (`checkBasicMaterials`, `KM_CityBuilder.pas:837`, port
     `ai.ts:4334`; the nine constants checked against `KM_AIParameters.pas` 264–274 and 319 are equal).
  3. The stone never comes back, because **the port has no quarry production**: the economy builds 5 quarries and
     trains 3 stonemasons, but `economy.ts` has no quarry work (no `stone-*` event exists; the M3 economy models
     only the woodcutter and the sawmill).
  4. Even with stone, the barracks is wanted only when `warfare > 0` and tick > 18000
     (`KM_CityPredictor.pas:468`, port `ai.ts:2310–2315`). The organic economy has no weapons or armour, so the
     predictor never asks for a barracks. Weapons come from workshops and smithies, which the port does not run.
  So the blocker is **missing production** (quarry, mines, coal/iron/gold, smithies, weapon and armour
  workshops), an M3-scope extension, not a placement or reservation defect in the builder.
- **Bug 2 (school stalls on gold): the premise was wrong for the organic run.** In the organic run the school's gold
  slot is full (`wareIn=[5,0,0,0]`), its gold demand is 0 by design, and its queue is empty from about t=12000:
  no unit type is demanded, because mines and smithies do not exist in v0 (`dbg5`).
  In the **attack run** the stall is real (`dbg5`, `dbg6`): school #131 has a free gold demand (5 available),
  the store holds 54 gold, the gold offer and an idle serf both exist, but `roadDistances(store → school) = -1`.
  The school's only road is cut at (40,118) and (42,118), which are now `tlDigged` (`lock=1`). The digging comes
  from a second school (#160) placed at t=2873 (`house-wip`) over those road tiles and dug at t=3413
  (`dbg8`–`dbg10`). The port's rule matches the Pascal's: the planner accepts a footprint over a built road
  tile because `tpBuild` does not exclude the road overlay (`economy.ts:2420–2440` vs `KM_Terrain.pas:3792–3806`,
  `KM_Eye.pas:1618`, `KM_Eye.pas:851`), and digging takes every footprint cell (`KM_UnitTaskBuild.pas:741`). I could
  not prove a divergence from the Pascal here, so **no fix**. Open decision for the lead: whether the AI should be
  stopped from planning over its own road (a rule the Pascal may enforce elsewhere; not verified).
- **No fix landed**, so no regression test was added for the two bugs. The change is the organic phase only
  (`tools/aisim/cli.ts` `organicRun` / `printOrganic`; `expected.ts` `ORGANIC_TICKS`, `EXPECTED_ORGANIC`).
- Regressions (unchanged): `WALK CHECK PASS`; `ECON CHECK PASS` sha `6d780b62…`; `COMBAT CHECK PASS` sha `09a19821…`;
  `BUILD CHECK PASS` sha `98b80525…`; `MAPSCAN CHECK PASS (243 maps, 0 anomalies)`.
- `npm test` **125/125** (`# pass 125`, `# fail 0`).
- `npx tsc --noEmit` **exit 1**, all four errors in `tools/skirmish/cli.ts` (lines 196, 201: implicit `any`). That
  directory and `packages/sim/skirmish.ts` are **untracked and not from this worker**; the aisim changes add no
  error. Left untouched for their owner.

**What would move the chain (ordered by impact, for the next worker):** (1) quarry production (a stonemason at a
quarry cuts stone into the store), which unblocks the sawmill reservation; (2) a weapon workshop (timber → axe)
so `warfare > 0` and the predictor asks for the barracks; (3) armour/shield production, the school's recruits
and barracks equip; (4) mines plus a smithy for the metal weapons. Each step is an M3-style production model in
`economy.ts`; the chain table above is the test for each.

### 7.7 Worker Q3 - the organic army: the store and bid fixes; the chain now stops at the stone crisis (not raised)

Goal (as 7.6): the Advanced AI raises its own army in the organic run, no scenario grants. **Result: not reached.**
The chain now gets past the first two links with real stone and a sawmill, but the barracks is still never wanted.
Q2's production (quarry, sawmill, workshops, barracks pipeline) was verified first; the two breakages are fixed.
Also fixed: the economy had no store demand and no bid importance (both Pascal rules), which the organic chain needed.

**Commands and one-line results (run on the final state):**
- `node tools/prodsim/cli.ts --check` -> `PROD CHECK PASS (6000 ticks, stone in store 30 >= 20, weapons 12 >= 10, soldiers 5 >= 5, two runs identical)`, sha `f20ca3ae...` (unchanged).
- `node tools/aisim/cli.ts --check` run 1 and run 2 -> `AI CHECK PASS (economy 30000 ticks, 1596 events; attack 12000 ticks; organic 60000 ticks)`, identical. Economy sha `18e3bcff6f6547cfa82de45b934f338d8f7ff09fbf7bc517dd5f2a525f5c94cf`; attack sha `4f3145e82388821523cdee2a852a4b2a19c8140ca0e5eb7aa3bf8cc6d1c9269d`; organic sha `d8f986f5488938f29435bc2c473de83de47e881a29a7a25668b9d435b176e58a`.
- `node tools/skirmish/cli.ts --check` -> `SKIRMISH CHECK PASS (3000 ticks, 385 events, 8 commands, 1933 ms)`, sha `925cc8077efde947db92c7ed37016b89e260c0d740e0c96cf42d3004434b2951` (was `54a2cdfc...`; re-frozen, see below).
- `npm test` -> `tests 156, pass 154, fail 2`: `packages/net/lockstep.test.ts` (R's, not touched) and `packages/sim/economy.test.ts:203` "carpenter saw cycle" (store-driven, see decision 2).
- `npx tsc --noEmit` -> no error in `packages/sim`, `tools/prodsim`, `tools/aisim`, `tools/skirmish`, `packages/assets`; the remaining errors are in `apps/server`, `packages/net` and `tools/nettest` only (R's, not touched).
- `node tools/walksim/cli.ts --check` -> `WALK CHECK PASS`; `node tools/combatsim/cli.ts --check` -> `COMBAT CHECK PASS`, sha `09a19821...` (unchanged); `node tools/mapscan/cli.ts --check` -> `MAPSCAN CHECK PASS (243 maps, 0 anomalies)`.
- **Moved, not re-frozen (decision 2):** `node tools/econsim/cli.ts --check` FAIL, sha `3758caa3...` (was `6d780b62...`); `node tools/buildsim/cli.ts --check` FAIL, sha `895b56e1...` (was `98b80525...`).

**Organic chain (60000 ticks, hand 1, Battle Sun, no military grants; `node tools/aisim/cli.ts --check`):**

| link | reached | first tick | value |
|---|---|---|---|
| quarry produces stone (`stone-out`) | yes | 2923 | 48 stone events |
| sawmill placed (`house-wip type=0`) | yes | 5745 | 1 |
| barracks wanted (predictor `requiredHouses[21] > 0`) | no | - | 0 |
| barracks placed (`house-wip type=21`) | no | - | 0 |
| barracks built (`house-activated type=21`) | no | - | 0 |
| recruits trained (`school-unit-trained type=13`) | no | - | 0 |
| weapons/armour produced (`ware-produced`) | no | - | 0 |
| warfare wares in stock at the end | no | - | 0 |
| soldiers equipped (`barracks-equipped`) | no | - | 0 |
| army groups formed | no | - | 0 |

**Fixes (each one traced to the Pascal):**
1. `tools/prodsim/expected.ts`: `EXPECTED_SHA: string` (tsc TS2367: a literal type compared with `''`). Not a rule.
2. `packages/sim/commands.test.ts` (one line): the house-equip test put the axes in the hand's store. `CanEquip` reads the barracks' own warfare stock, `fResourceCount` (`KM_HouseBarracks.pas 331-341`), which Q2's `barracksCanEquip` uses (the committed version read the hand's out-wares). The test now stocks the barracks.
3. **The store takes wares (the root of the stall).** `packages/sim/economy.ts` `addStoreDemands` (new), called from `buildDemands` and `addDemandsOnActivate`: an always-on demand per ware, `dtAlways`, no cap (`KM_Houses.pas 657-660` wtAll expansion; `KM_HandLogistics.pas 1372`, `1863-1870`). Before this, quarry stone and sawmill timber had no destination: the stone stock fell to 12 and stayed there, `stoneCrisis` (`KM_CityBuilder.pas 867-870`, port `ai.ts 4353`) stayed on, and while it was on only quarries, schools and inns could be placed (`KM_CityBuilder.pas 1167`, port `ai.ts 4576`), so no weapon workshop, no barracks. The M3 `applyDemoScenario` comment (`economy.ts`, "the store never demands on its own") described this as a simplification; it is no longer true.
4. Warfare goes to a store only when the hand has no barracks: `storeAccepts` (`KM_HandLogistics.pas 1243-1250`).
5. House>Store bid penalty: `STORE_BID_PENALTY = 1000` on a store demand (`KM_HandLogistics.pas 1583-1590`, `IncAddition(1000)` for `wtAll`).
6. **Bid importance** (`KM_HandLogistics.pas 30-35`, `551-577`): `DI_*` constants, `houseDemandImportance` (gold to a school `diHigh1`, food to an inn `diHigh3`, `1160-1171`); construction materials and the road builder's stone and timber are `diHigh4` (`addConstructionDemand`, `addUnitDemand`; `KM_UnitTaskBuild.pas 241, 388, 637-638`). Offers are served in order of their best open demand's importance (stable: offer order among equals); within an offer the most important demand wins, then the nearest.

**Movements and their causes (decision 2 for the lead):**
- Economy numbers (aisim economy and M3 econsim/buildsim): the store now takes wares, so trunks and boards reach the store (`storeTimber` up, `sawmillTimber` down in econsim).
- Skirmish: `ware-delivered` 59 -> 60 (one more ware reaches the store); the `final` block is unchanged; re-frozen in `tools/skirmish/expected.ts`.
- Attack phase (re-frozen): equipped 12 (unchanged), warriors at the end 63 -> 54, kills by hand 9 -> 8, kills by enemies 3 -> 12, losses 3 -> 12, enemy warriors at the end 12 -> 13. The combat code is unchanged; the economy feeds different soldiers and wares into the same scenario. Not analysed further.
- The organic numbers (re-frozen with the chain table above).

**The next blocker (diagnosed, not fixed):** stone. After fix 3 the stone production works for about 24 stones, then quarries stop. The Eye's stone list (`KM_Eye.pas 933-972`, port `ai.ts 1728`) has 25 locations 16-37 tiles from the store. The five built quarries sit 15-37 tiles from them. Minable stone tiles (a walkable tile below the deposit, reachable inside the stonemason's cost-limited walk, `KM_Terrain.pas 2584-2608`, port `economy.ts 2836`) are reachable from **none** of the five quarries (`Q3QREACH`, `Q3QDIAG` in the scratch probe). The stonemason logic matches the Pascal line by line; the planner's `FindPlaceForQuary` (`KM_CityPlanner.pas 2151-2232`, port `ai.ts 3643`) also matches; the drift is in where the quarries are placed (the build-field distance / `FindPlaceForHouse` inputs, `KM_CityPlanner`). Next step for the next worker: compare `BuildFF` distance, `getDistanceInitPoint` and `findPlaceForHouse` (`KM_TerrainFinder` / `KM_AIFields`) against the Pascal on this map.
With stone at 1, the stone crisis holds, nothing except quarries can be placed (fix 3), so the weapon workshop (requested from tick 2000: `WEAP_WORKSHOP_DELAY` is off because `peacetimeMinutes = 0`, `KM_CityPredictor.pas 713, 773`) is never placed, warfare stays 0, and the barracks is never wanted (`KM_CityPredictor.pas 468`). In an earlier run (before fix 5) two workshops were built and five axes produced, and the barracks was placed as a site at tick ~18000, then starved for timber; fix 5 (Pascal-correct) changed that outcome, so the earlier result came from the unfaithful store take-all, not from the chain. Serfs are not the blocker (24 serfs, all idle with no task at the end).

**Not reached, so not claimed:** barracks built, recruits at the school (the gold-to-school `diHigh1` rule is in; no recruit was trained for the army), equip, groups.

**Simplifications (7.7):**
- Bids: no random element (`KaMRandom(10)`, `KM_HandLogistics.pas ~1580`), no "fewer supply" bid (`+20 x CheckWareIn`, `~1585`). Offer order by importance is an approximation of the Pascal's bid over (offer, demand) pairs.
- A barracks warfare demand is capped at one concurrent delivery (`1 - being`), a v0 approximation kept from 7.5; a store demand is uncapped (`dtAlways`).
- `FindPlaceForQuary` and the stonemason use the port's walk (`tilesWithinDistance`, `routeCanBeMade`), not the Pascal's full `TKMTerrain` routes; the quarry geometry above is the first thing to check.
- `StoneRemaining` is a per-tile shadow (7.6): a depleted tile stops giving stone; the map terrain is not changed.

**Decisions for the lead:**
1. Keep the store take-all and the bid rules (faithful, the organic chain's first real fix) or revert them to keep the M3 numbers. Reverting puts the organic chain back to the 7.6 stall (stone stuck at 12).
2. Re-freeze or accept the moved M3 numbers: `econsim` (`3758caa3...`), `buildsim` (`895b56e1...`), and `economy.test.ts:203` (the saw cycle's third delta is now 1511 ticks: the sawmill waits for a trunk once the store takes them; not traced). Left as they are, so the checks show it.
3. Performance: the economy run takes 20-26 s (was ~18 s; 120 s once when run in parallel with `tsc`).

### 7.8 Worker Q4 - the saw-cycle stall: the bid rule and a foreign-worker bug; the movement re-frozen

**Root cause of the 1511-tick stall (not the store rules).** Demo probe (`economy.test.ts` setup, scratch log): the
sawmill's timber output piles up (`timber-out` 2, 4, 6 at ticks 439, 800, 1161) while the one serf keeps carrying
trunks (store to sawmill, hut to store). The timber offer sat behind them until tick 1977. Cause: `logistics()` walked
the offers in order of their best importance, and took the **first** offer that had a valid demand, then its best demand.
At equal importance (all `diNorm`), the store's trunk offers always came first, so the sawmill's timber (offered later)
waited. Pascal does not do that: `TKMDeliveries.UpdateState`'s loop bids over **all** (offer, demand) pairs, keeps the
highest importance, then the lowest cost (`KM_HandLogistics.pas 551–577`, `CompareBids` 2356–2367). The cost of
`TryCalculateBidBasic` (1492–1591) adds `+1000` when the demand is `wtAll` (a store) **and** when the offer house is a
store and the ware is not warfare (1587–1590). The TS had the first half only. With the global bid the timber
(sawmill to store, +1000) and the trunks (store to sawmill, +1000) compete on road cost, as in Pascal.

**Changes (packages/sim/economy.ts):**
1. `logistics()` rewritten as one global bid over all valid (offer, demand) pairs: most important demand first, then the
   lowest cost; a tie keeps the first pair found (deterministic). `KM_HandLogistics.pas 551–577, 2356–2367`. A candidate
   needs an idle serf that can walk to the offer house (`AnySerfCanDoDelivery`). The assignment code is unchanged.
2. Store-offer penalty: `+STORE_BID_PENALTY` when the offer house is a store and the ware is not warfare
   (`KM_HandLogistics.pas 1587–1590`). Not separately ablated (it is only meaningful inside the global bid).
3. A unit demand's cost is its walk-route step count (`findPath`, the tpWalk route, 1223–1226) instead of the euclidean
   distance. Not shown necessary: with the euclidean cost the aisim numbers also move (other shas). Kept because it is the
   closer approximation; the lead may revert it (`git` diff of the `d.unitUid !== 0` branch) if a smaller change is wanted.
4. `findEmptyHouse` only offers houses of the unit's own hand: `if (h.owner !== u.owner) continue;`
   (`KM_Units.pas 467`: `gHands[Owner].Houses.FindEmptyHouse`). Found while probing Battle Sun: the AI's woodcutter (owner 1)
   worked in the human's woodcutter (home 27, owner 0), and the AI's carpenter (owner 1) in the human's sawmill (home 26,
   owner 0) (`NOGRANT=1` probe, `WU` lines: before the fix; after it, no cross-owner home).

The six Q3 rules stay (none is shown to be wrong). The `applyDemoScenario` stall was not a store problem: the store
rules only made the store take the wares that then competed.

**Evidence, demo test (`economy.test.ts`, unchanged):** `timber-out` every 361 ticks; the last three deltas `361,361,361`
(the test passes, 8/8). Probe log: sawmill outputs at 439, 800, 1161, 1522, 1883, 2244, 2605, 2966 (all 361), timber
delivered 14 times (was: stalled after 1161).

**Evidence, realistic (MapsMP/Battle Sun, hand 0, woodcutter + sawmill by `housePlan` commands with BFS roads, granted
woodcutter and carpenter workers at the store; scratch probe, not in the repo):**
- Current tree: sawmill outputs 1602, 1963, 2324, 2685, 3046, 3707, 4068, 4479, 6390; deltas `361,361,361,361,661,361,411,1911`.
  Every output is 310 ticks after a `trunk-taken`, and every gap equals the gap in trunk intake (2736 to 3397 = 661,
  3758 to 4169 = 411, 4169 to 6080 = 1911). The sawmill never waits with a trunk in hand: the gaps are the woodcutter's idle
  periods (no `chop-plan` between 4011 and 5169).
- Committed M3 (`git show HEAD:packages/sim/economy.ts`): 3 outputs (1602, 1963, 2324) and then none in 9000 ticks; store
  timber flat at 43. The Q3 state was not run with these grants (without grants it gave 7977, 8338, 8699, with the
  owner bug in play), so the claim against Q3 rests on the demo and the econsim numbers above.
- Without workers (`NOGRANT=1`, before the owner fix) the human's sawmill was staffed by an AI carpenter; after the fix it
  stays empty until a human carpenter exists (the Pascal rule; training needs gold and a school, see the probe notes).

**Movements, decomposed (each re-frozen; the Q3 numbers reproduce exactly on a scratch copy of the Q3 economy):**
- `econsim` (`3758caa3...` -> `bde47e76...`): every count equals Q3 except `rngState`, and `hutTrunks` 5 -> 0,
  `sawmillTimber` 6 -> 0, `storeTimber` 30 -> 38. Those are the store taking wares, as Q3 said; the hut and the sawmill no
  longer stop with full output. `deliveries` 143 -> 160 and trees felled 5 -> 7 (the hut no longer blocks).
- `buildsim` (`895b56e1...` -> `6d9d96ed...`): the Q3 movement was deliveries 119 -> 127 (the store). The bid order makes
  it 126 deliveries and 8 house assignments (Q3 9); the hut completes at tick 1137 (`house-activated`), against 1098 in Q3
  and 1284 in the committed M3 economy. Still faster than the base a human plays.
- `skirmish` unchanged (`925cc807...`, 67 deliveries, 60 `ware-delivered`): no re-freeze needed.
- `aisim` (all three phases re-frozen; the owner fix changes nothing there, checked on a scratch copy):
  economy `18e3bcff...` -> `fae374de...` (1478 events; houses completed 8 -> 7); attack `4f3145e8...` -> `72bf668e...`
  (kills by hand 8 -> 9, by enemy 12 -> 7); organic `d8f986f5...` -> `f36f6bb4...` (quarry 2923 unchanged, sawmill placed
  5745 -> 5573, barracks still never wanted).
- **Open, for the lead:** in the aisim economy window the AI no longer builds its farm and corn fields (`field-built`
  14 -> 0, `cornFields` 14 -> 0) nor its inn (`house27` built 1 -> 0). Cause: the bid order now gives road builders' stone
  (diHigh4, unit demand) and construction stone (diHigh4) to the cheapest demand, so stone (quarry output unchanged, 24)
  goes elsewhere. This is what Pascal's rule implies, but it is a worse AI food build-out than Q3 in this window. Not fixed.
  Choosing: keep (faithful, fixes the stall) or find the unit-demand priority difference first.

**Acceptance (run on the final state):**
- `node --test packages/sim/economy.test.ts` -> `tests 8, pass 8, fail 0` (361,361,361 asserted; expectations untouched).
- `node tools/econsim/cli.ts --check` -> `ECON CHECK PASS (6000 ticks, 379 events)`, sha `bde47e76...` (re-frozen).
- `node tools/buildsim/cli.ts --check` -> `BUILD CHECK PASS (2000 ticks, 295 events)`, sha `6d9d96ed...` (re-frozen).
- `node tools/prodsim/cli.ts --check` -> `PROD CHECK PASS (6000 ticks, ... two runs identical)`, sha `f20ca3ae...` (unchanged).
- `node tools/aisim/cli.ts --check` -> `AI CHECK PASS (economy 30000 ticks, 1478 events; attack 12000 ticks; organic 60000 ticks)`,
  twice, identical (economy `fae374de...`, attack `72bf668e...`, organic `f36f6bb4...`) (re-frozen).
- `node tools/skirmish/cli.ts --check` -> `SKIRMISH CHECK PASS (3000 ticks, 385 events, 8 commands)`, sha `925cc807...` (unchanged).
- `node tools/combatsim/cli.ts --check` -> `COMBAT CHECK PASS`, sha `09a19821...` (unchanged).
- `node tools/walksim/cli.ts --check` -> `WALK CHECK PASS`; `node tools/mapscan/cli.ts --check` -> `MAPSCAN CHECK PASS (243 maps, 0 anomalies)`.
- `npm test` -> `tests 163, pass 162, fail 1` (the failure is `packages/net/lockstep.test.ts`, worker R's, not touched).
- `npx tsc --noEmit` -> no error in `packages/sim`, `tools/econsim`, `tools/buildsim`, `tools/prodsim`, `tools/aisim`,
  `tools/skirmish`; the errors left are `apps/server`, `packages/net`, `tools/nettest` (R's) and `tools/host/pack.ts(92,15)`
  (not mine, not in the brief's list: a call with one argument where two or three are expected; left for its owner).

**Not done:** the store always-on demand is not reverted (no flag added; the stall had another cause). The realistic probe
is in scratch only (`C:\Users\me\AppData\Local\Temp\opencode\q4\battle-sun-saw.ts`), not a repo tool.

### 7.9 Worker H3 - the AI food build-out regression: the bid's random and construction terms (Pascal), not the priority table

**Result: fixed.** The corn fields and the inn come back in the aisim economy window (`corn` 0 -> 28, inn placed at
tick 9169). The cause was not the priority table: the table matches Pascal. The bid **cost** lacked three Pascal terms, so
road-builder stone (a unit demand) always beat construction stone (a house demand) in the cheapest-road tie-break.

**Priority table, line by line (all match Pascal except one unused value):**
| demand | Pascal (file:line) | TS (`economy.ts`) |
|---|---|---|
| house construction wood/stone | diHigh4, `KM_UnitTaskBuild.pas 637–638` | `addConstructionDemand` `DI_HIGH4` (match) |
| road-builder stone | diHigh4, `KM_UnitTaskBuild.pas 241` | `addUnitDemand` `DI_HIGH4` (match) |
| wine planting timber | diHigh4, `KM_UnitTaskBuild.pas 388` (`TKMTaskBuildWine`) | none: wine fields are out of v0 by spec (`economy.ts` line 65) |
| corn field planting | no demand, `KM_UnitTaskBuild.pas 503–543` | no demand (match) |
| inn food | diHigh3, `KM_HandLogistics.pas 1169–1171` | `houseDemandImportance` `DI_HIGH3` (match) |
| school gold | diHigh1, `KM_HandLogistics.pas 1164–1166` | `DI_HIGH1` (match) |
| store, barracks, ordinary house inputs | diNorm, `KM_Houses.pas 659–660, 2263` | `DI_NORM` (match) |
| warrior food | diHigh2, `KM_UnitWarrior.pas 294` | not modelled (no warrior food demand in economy.ts; combat sim) |

`DI_HIGH2` is not in the TS table because no TS demand uses it; the enum order (diNorm 0, diHigh4 1, diHigh3 2, diHigh2 3,
diHigh1 4, `KM_HandLogistics.pas 30–35`) is what the bid compares, and it is the same as the TS constants.

**The bid's Addition terms (what was missing), `packages/sim/economy.ts` `logistics()`:**
1. House demand: `KaMRandom(16 - 3*distr)` (`KM_HandLogistics.pas 1554`); `distr` from `wareDistribution` (`KM_WareDistribution.pas 12–17, 71–88`; 5 for every pair without a setting). Drawn even when the result is 0 (Pascal `KaMRandom(1)` consumes a draw).
2. Construction site (not built): `−4 × buildResDeliveredPercent` (`KM_HandLogistics.pas 1576`), and `+0.1` for stone (`1578–1579`). Port: `construction.ts` `buildResDeliveredPercent` (`KM_Houses.pas 1225–1228`).
3. Finished house and unit demand: `KaMRandom(10)` (`KM_HandLogistics.pas 1585`). Unit demand (road builder) also gets it after its walk route (`1559–1565`).
4. Fewer supply: `+20 × CheckWareIn` for a house demand, except store, barracks (warfare) and town hall (`1614–1618`); `wareInCount` is the port of `CheckWareIn` (`KM_Houses.pas 1523`).
5. Barracks: `+10000` for a weapon taken from a store while the barracks holds more than 50 (`1633–1637`).
6. The serf check comes before the cost (`AnySerfCanDoDelivery`, `KM_HandLogistics.pas 565`), so a pair with no serf draws nothing.
The existing rules stay: House>Store `+1000` (`1587–1590`), store-offer penalty (`1587–1590`), importance-first bid (`551–577`).

**Why this fixes the food chain:** before, a road builder's stone (walk route, no random) beat a construction site's stone
whenever its walk was shorter, so the farm and the inn sites starved of stone. Pascal gives the construction site a
discount (`−4 × share`, up to −4) and gives the builder a random `0–9`; the house site wins more often. The TS now has both.

**Before / after (aisim economy window, 30000 ticks, Battle Sun hand 1; "before" = HEAD `economy.ts`, aisim sha `fae374de`; "after" = sha `8d7bf8e7`; counts from `node tools/aisim/cli.ts --json`):**
| metric | before | after | note |
|---|---|---|---|
| corn fields (`cornFields`, `field-built`) | 0 | 28 | first at t=3128 |
| farm (HT 8) planned / placed | 0 / 0 | 1 / 0 | planned, never placed in the window; its fields come from the reserved field area (`PlanFarmFields`, `KM_CityPlanner.pas 1099`, `PlanFields` 1226) |
| inn (HT 27) planned / placed | 0 / 0 | 1 / 1 | `house-wip` t=9169, site dug t=9849, not finished (no `house-activated type=27`) |
| woodcutter (HT 9) planned / built | 2 / 2 | 0 / 0 | **worse**: one completed woodcutter `house#93` (activated t=7423) was destroyed at t=18900 (`house-destroyed`, `home-lost` 1); the second was not re-planned. Cause of the destruction not traced |
| quarry (HT 14) planned / built | 5 / 4 | 5 / 5 | |
| completed houses | 7 | 5 | **worse** (the woodcutter above) |
| stone produced (`stone-out` events) | 24 | 19 | **worse**: road builders and construction now share stone; the quarry output itself is unchanged |
| trained recruits (`school-unit-trained`) | 47 | 44 | **worse**, small |
| road tiles | 234 | 221 | |

Attack phase (12000 ticks, `node tools/aisim/cli.ts --check`): passes, sha `6ab42294...` (was `72bf668e...`). Organic (60000 ticks): passes, sha `62a4cbd2...` (was `f36f6bb4...`). The organic chain still stops before the barracks: `weapons/armour in stock`, `soldiers equipped` and `army groups formed` are all `reached=no` (the 7.7 frontier, unchanged). The per-link timings of the earlier draft notes were not re-measured here and are not claimed.

**Movements of the other gates (each re-frozen; the cause is the new random draws in the bid):**
- `econsim` `bde47e76...` -> `fd51da4a...`: deliveries 160 -> 157, `timberDelivered` 53 -> 52, `rngState` changed.
- `buildsim` `6d9d96ed...` -> `5d17abc1...`: `build-house-assigned` 8 -> 9; the hut still completes (`house-activated`, `hutState done`).
- `prodsim` `f20ca3ae...` -> `ed2e07fe...`: the thresholds still hold (stone in store 27 >= 20, weapons 12 >= 10, soldiers 5 >= 5, two runs identical).
- `skirmish` `925cc807...` -> `3bdddedb...`: deliveries 67 -> 65, `ware-delivered` 60 -> 58, `build-house-assigned` 28 -> 35, units at the end 33 -> 34, kills 6 unchanged, `killed` 5 -> 4. Re-frozen; the changes are the bid's random order, not a rule. Checked: with HEAD's `packages/sim/skirmish.ts` (H2b's uncommitted edit left out) the sha is the same `3bdddedb...`, so the move is this change's, not H2b's. This worker did not edit `skirmish.ts`.
- `aistart` `ab6557cf...` -> `b97ee3bf...`: first AI kill 3089 -> 3087, events 374 -> 391; the outcome is unchanged (human defeated, AI won, equipped 12, 4 kills).
- `aisim` economy `fae374de...` -> `8d7bf8e7...` (1464 events, houses completed 7 -> 5, see the table above), attack `72bf668e...` -> `6ab42294...`, organic `f36f6bb4...` -> `62a4cbd2...`.
- `combatsim` `09a19821...`: unchanged (the combat code is not touched).

**Not ported (remaining deviations, not hacked around):**
- The Pascal ranks bids by the fast cost (`KMLengthDiag`, `KM_HandLogistics.pas 2809–2812`), keeps the best `BIDS_TO_COMPARE` = 5 candidates (`385`, `1983`), then re-costs them by the path (`TryEvaluateAccurate`, path × 0.9). The TS takes the global minimum by BFS road steps. The result differs only when two candidates are close.
- The random draws follow Pascal's rule per pair, but the pair order (TS: offers outer; Pascal: demands outer, `556–575`) differs, so the RNG stream is not Pascal's bit for bit. The distribution is Pascal's; the sha is new.
- The weapons branch (`1513–1529`: `KaMRandom(16 - 3*distr)` with a fixed `5 + (5 - distr)*4` value for smithies with orders) is not ported (only affects weapon smithies).
- Warrior food (`diHigh2`, `KM_UnitWarrior.pas 294`) and wine planting (`diHigh4` timber, `KM_UnitTaskBuild.pas 388`): not modelled (see the table).
- The farm is still not placed in the economy window (its fields are built from the planned field area). If the Pascal planner places the farm before its fields in the same window, the timing differs; not checked line by line here.

**Commands and one-line results (final state, after the expected re-freeze):**
- `node --test packages/sim/economy.test.ts` -> `ℹ tests 8` / `ℹ pass 8` / `ℹ fail 0`.
- `node tools/econsim/cli.ts --check` -> `ECON CHECK PASS (6000 ticks, 373 events, 10471 ms)`, sha `fd51da4a...`.
- `node tools/buildsim/cli.ts --check` -> `BUILD CHECK PASS (2000 ticks, 296 events, 6174 ms)`, sha `5d17abc1...`.
- `node tools/prodsim/cli.ts --check` -> `PROD CHECK PASS (6000 ticks, stone in store 27 >= 20, weapons 12 >= 10, soldiers 5 >= 5, two runs identical)`, sha `ed2e07fe...`.
- `node tools/aisim/cli.ts --check` -> `AI CHECK PASS (economy 30000 ticks, 1464 events; attack 12000 ticks; organic 60000 ticks)`.
- `node tools/skirmish/cli.ts --check` -> `SKIRMISH CHECK PASS (3000 ticks, 374 events, 8 commands, 3916 ms)`, sha `3bdddedb...`.
- `node tools/aistart/cli.ts --check` -> `AISTART CHECK PASS (3240 ticks, 391 events, human defeated, ai won, equipped 12, attack 2711, killsByAi 4, sha b97ee3bf, two runs identical)`.
- `node tools/combatsim/cli.ts --check` -> `COMBAT CHECK PASS (900 ticks, 69 events, 277 ms)`, sha `09a19821...` (unchanged).
- `node --test packages/sim/*.test.ts` -> `ℹ tests 131` / `ℹ pass 131` / `ℹ fail 0` (final tree; the count includes H2b's new `startplace.test.ts`).
- `npx tsc --noEmit` -> no output (clean, the whole tree, this run).

## 7.10 The AI economy gaps of 7.9 closed (2026-10-18)

The four items 7.9 listed as "not ported" are ported (a worker on `opencode/deepseek-v4.1-flash-free`,
re-run here by the lead). Each line names the Pascal it follows:

- **Weapons bid branch** (`KM_HandLogistics.pas 1513-1529`): a done house that `DoesOrders` (`KM_ResHouses.pas
  605-608`) or an iron smithy, with `offer.count <= 2` and `wareInCount <= 1`, bids `5 + (5-distr)*4 +
  KaMRandom(16-3*distr)` and skips the route check (`tpWalkRoad`, as the Pascal marks it valid without one).
- **Town-hall gold** (`KM_HandLogistics.pas 1620-1628`): a town-hall demand takes `+5000` when it already
  holds more than 500 of the offered ware, else `+2`.
- **Warrior food** (`KM_UnitWarrior.pas 290-297`, `KM_HandLogistics.pas 1639-1647`, `1179-1185`,
  `KM_ArmyManagement.pas 304-313`): a group below `TROOPS_FEED_MAX` (`KM_Defaults.pas 373` = 0.55) orders
  `wtFood` for its hungry members (`WT_FOOD = 30`; the ware enum is 0-based here, so `wtFood` = index-1, and
  `WARES_FOOD = [wtWine, wtBread, wtSausage, wtFish]` as in `KM_ResTypes.pas`); a delivered food restores the
  warrior to full condition. The order runs before the peacetime skip, as in `CheckGroupsState`.
- **Wine field** (`KM_UnitTaskBuild.pas 363-435`): `TKMTaskBuildWine` with its `diHigh4` timber demand
  (line 388), the dig/stay phases and the phase-5 timber wait; a delivery waits for phase < 5
  (`KM_UnitTaskDelivery.pas 504-505`), and the field overlay is `SetField(ftWine)`.
- **Farm/forest placement** (`KM_CityPlanner.pas 1747`, `1765`, `2437`; `KM_AIInfluences.pas 575-592`): the
  ally term and the forest bid use `getBestAllianceOwnership(owner, x, y, 'ally')` instead of the owner's own
  ownership, and that function now honours its `alliance` argument. Behaviour-inert while every other hand is
  an enemy to `allianceOf`, which is v0's rule today.

**One gate moved, by the RNG stream only:** the attack run is `6ab42294...` -> `afc512cd...`
(`rngState` 2104583360 -> 702198609). Every observable counter is identical (`killsByHand` 9,
`killsByEnemy` 6, `houseDamage` 550, `houseDestroyedEvents` 1, `enemyHouses` 3 -> 2, `enemyWarriors`
18 -> 12, `equipped` 12); the food demands consume `KaMRandom` draws, so the stream after them differs. A
control run with `TROOPS_FEED_MAX` set to 0 restores `6ab42294...` exactly (the worker's measurement): the
other four changes move no gate.

**Unchanged gates (this run):** economy `8d7bf8e7...`, organic `62a4cbd2...`, `econsim` `fd51da4a...`,
`buildsim` `5d17abc1...`, `prodsim` `ed2e07fe...`, `skirmish` `3bdddedb...`, `aistart` `b97ee3bf...`,
`combatsim` `09a19821...`, mapscan 243 maps / 0 anomalies, `npm test` 210/210, `npx tsc --noEmit` clean.

**Open:** the new logic has no unit test of its own; `node tools/aisim/cli.ts --check` is its acceptance run
(it exercises the bid, the food demand, the delivery and the wine task end to end).
