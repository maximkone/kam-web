# M5 AI research notes — the Advanced AI port (facts, 2026-10-17)

Research digest for the M5 milestone (owner priority: play vs the Advanced AI). **Not a frozen
contract** — `docs/M5-SPIKE.md` will freeze interfaces once M4 (combat) lands. All line refs into
`_ref/kam_remake/src` (r15472 lineage, GAME_REVISION_NUM 16409).

## 1. Enablement + lifecycle

- Commands: `!SET_AI_PLAYER` → `AddAIType(aitClassic)` (`mission/KM_MissionScript_Standard.pas:281-292`);
  `!SET_ADVANCED_AI_PLAYER` → `AddAIType(aitAdvanced)` (`:294-306`); both resolve the hand via
  `InRange(P[0],…) ? P[0] : fLastHand`. `TKMAIType = (aitNone, aitClassic, aitAdvanced)`
  (`game/KM_GameTypes.pas:22-23`).
- Per-hand AI instance exists unconditionally: `fAI := TKMHandAI.Create(fID)`
  (`hands/KM_Hand.pas:401`); `TKMHandAI.Create` builds BOTH families up front (`ai/KM_AI.pas:87-100`).
- The advanced AI is *selected* later: SP `game/KM_Game.pas:686-692` (`EnableAdvancedAI` when
  `fAIType = aitAdvanced` or advanced-only); MP `hands/KM_HandsCollection.pas:205-231`.
  `TKMHandAISetup.EnableAdvancedAI` (`ai/KM_AISetup.pas:156-161`) sets `NewAI := True` **and forces
  `AutoAttackRange := 0`** (units decide, not commands).
- Start: `gHands.AfterMissionInit` (`game/KM_Game.pas:770` → `KM_HandsCollection.pas:234-266`):
  Eye sees mines (`:252`), `PlaceFirstStorehouse` for hands that must place one (`:255-256`),
  `gAIFields.AfterMissionInit(canHaveAdvAIOnMap)` (`:259-260`) builds NavMesh/Influences (+Supervisor
  when advanced AI is possible), then per hand `fAI.AfterMissionInit` (`KM_Hand.pas:691` →
  `KM_AI.pas:529-545`): advanced → `Eye.OwnerUpdate` + `CityManagement.AfterMissionInit` +
  `ArmyManagement.AfterMissionInit`.
- Update: `TKMHand.UpdateState` runs `fAI.UpdateState(aTick, DoCheckGoals)` **every tick**
  (`hands/KM_Hand.pas:2123`, comment at 2122: the AI interleaves itself); goals checked when
  `(tick + owner) mod MAX_HANDS = 0` (`KM_AI.pas:559`). **`MAX_HANDS = 27`**
  (`common/KM_Defaults.pas:309`) — every cadence below uses 27, not the player count.

## 2. Architecture (newAI)

| file | lines | role |
|---|---|---|
| `newAI/KM_CityPlanner.pas` | 3605 | city layout: house/mine/quarry/woodcutter placement, field planning, road planning (`TKMPathFindingCityPlanner`), defence towers |
| `newAI/KM_CityBuilder.pas` | 2389 | executes building: build nodes for roads/fields/house plans, `BuildHouse`, `ChooseHousesToBuild`, influence lock/unlock |
| `newAI/KM_Eye.pas` | 1977 | per-hand map view: house mapping, soil/routes/flat arrays, mine/stone/forest lists, `TKMBuildFF` flood fill, `CanPlaceHouse`, `ScanLoc` |
| `newAI/KM_ArmyAttack.pas` | 1784 | **dead code — skip** (no references; in `.lpi` but not `.dproj`) |
| `newAI/KM_Supervisor.pas` | 1518 | game-wide coordinator: alliances/FFA, combat matrix, defence-position distribution, attack decisions (`AttackRequest`), mine division, army vector |
| `newAI/KM_CityManagement.pas` | 1132 | economy manager: drives Builder+Predictor, school training, market/store wares, repair, ware distribution, weapons balance |
| `newAI/KM_ArmyAttackNew.pas` | 921 | combat groups (`TKMCombatGroup`): targets, navmesh/pathfinding, traffic, walk/attack limits |
| `newAI/KM_CityPredictor.pas` | 911 | resource-flow prediction: required houses, ware balance, peace factor, worker count |
| `newAI/KM_AIParameters.pas` | 762 | `AI_Par[TAIPar]` tuning constants |
| `newAI/KM_ArmyDefence.pas` | 597 | defence positions: navmesh defence lines or fixed classic `General.DefencePositions`, group assignment, formations |
| `newAI/KM_ArmyManagement.pas` | 586 | army manager: recruit, group state/food, `CheckAttack` (Supervisor request or scripted attacks) |

Totals: `src/ai/**` 23,059 lines; `newAI` **16,182**; classic 6,877.

- Ownership: `TKMHandAI` owns CityManagement (→ Predictor + Builder → Planner) and ArmyManagement
  (→ AttackNew + Defence) (`KM_AI.pas:87-100`, `KM_CityManagement.pas:83-84`,
  `KM_CityBuilder.pas:129`, `KM_CityPlanner.pas:282-284`, `KM_ArmyManagement.pas:96-97`).
- Game-wide `gAIFields` (`ai/KM_AIFields.pas:12-59`): NavMesh, Influences (on NavMesh), **one shared
  `Eye`**, one shared `Supervisor`.
- **Gotcha: the Eye is a single shared instance for all hands** (`KM_AI.pas:569` →
  `KM_Eye.pas:764-768` only switches `fOwner`). Per-hand Eye data is context-switched per hand tick.
  A per-hand port would change behaviour.
- Cross-reads: Supervisor writes `AttackRequest` into `AutoAttack` hands (`KM_Supervisor.pas:1025-1033`);
  ArmyManagement reads it or falls back to the classic scripted `General.Attacks`
  (`KM_ArmyManagement.pas:514-529`); Supervisor splits iron/gold mines
  (`KM_Supervisor.pas:1224-1235`); ArmyDefence builds fixed defences from `General.DefencePositions`
  (`KM_ArmyDefence.pas:484-497`).

## 3. Tick integration + cadences

Game tick: `fScripting` → `gTerrain.UpdateState` → **`gAIFields.UpdateState(tick)`** →
`gHands.UpdateState(tick)` → … (`game/KM_Game.pas:3101-3114`). Inside `gAIFields.UpdateState`:
NavMesh → Influences → Eye (army-eval slice) → Supervisor (`KM_AIFields.pas:131-138`; skips all when
`not gHands.CanHaveAI` `:122-125`). Per hand (advanced): `Eye.OwnerUpdate` → `ArmyManagement` →
`CityManagement` (`KM_AI.pas:567-572`).

Cadences (all `mod MAX_HANDS = 27` unless noted):
- Army: `tick mod 27 = owner` → CheckAttack, RecruitSoldiers, CheckGroupsState, AttackNew, Defence
  (`KM_ArmyManagement.pas:546-568`).
- City: `mod 27 = owner` → Builder (+Planner first) + Predictor + ChooseHousesToBuild; `mod 54` →
  counts/markets/stores/repair/distribution/weapons (`KM_CityManagement.pas:151-194`).
- Defence: fast `27*5`, slow `27*20` (`KM_ArmyDefence.pas:508-522`); AttackNew walks groups each own
  tick (`KM_ArmyAttackNew.pas:628-661`).
- Supervisor: defence window `mod (10*27*10)` offset 500; attack window offset 10 (after peace +
  3 min); `UpdateAttacks` every 27 (`KM_Supervisor.pas:214-239`). **Fidelity oddity:** the same
  `Modulo` variable is reused, so attack updates and the defence window are mutually exclusive that
  tick (`:235`) — copy exactly.
- Eye: ArmyEvaluation one player per `27*10` ticks (`KM_Eye.pas:758-761`); BuildFF on demand.
- NavMesh every `27*330` (`navmesh/KM_NavMesh.pas:199-203`); Influences: city ownership every 150
  (step 15), army presence every 5 (`KM_AIInfluences.pas:714-748`); Predictor production refresh
  every `27*60*5 = 8100` (`KM_CityPredictor.pas:816-829`); CityPlanner runs from CityBuilder only
  (`KM_CityPlanner.pas:427-475`).

## 4. RNG usage (determinism)

`src/ai/**`: 17 `KaMRandom` calls, **none** `KaMRandomS1`. newAI's 5:
`KM_ArmyManagement.pas:256` (recruit group type, retries ≤10), `:373` (mobilization coefficient),
`KM_CityPlanner.pas:1855` (init-point probability), `:3343` (search-around probability),
`KM_Supervisor.pas:822` (random group index fallback). Classic AI has 12 more (city planner seeds,
general group type, mayor serf sample). All carry `DBG_RNG_SPY` labels.

## 5. Settings (`!SET_AI_*` → `TKMHandAISetup`, `ai/KM_AISetup.pas:11-83`)

Defaults: Aggressiveness 100, AutoAttack false, AutoBuild true, AutoDefend false, RepairMode
rmRepairNever, DefendAllies false, ArmyType atIronThenLeather, EquipRateIron 500, EquipRateLeather
1000, MaxSoldiers −1, WorkerCount 6, RecruitCount 5, RecruitDelay 0, SerfsPerHouse 1,
StartPosition (1,1), TownDefence 100, AutoAttackRange 4 (→0 with advanced AI), UnlimitedEquip false,
NewAI false.
Commands: `!SET_AI_CHARACTER` (`ATTACK_FACTOR`, `EQUIP_RATE[_IRON|_LEATHER]`, `MAX_SOLDIER`,
`CONSTRUCTORS`, `RECRUTS` (sic), `RECRUT_COUNT`, `WORKER_FACTOR`, `TOWN_DEFENSE`,
`AUTO_ATTACK_RANGE`, `TROUP_PARAM`) — handler `KM_MissionScript_Standard.pas:647-674`;
`!SET_AI_NO_BUILD` `:676`; `!SET_AI_AUTO_REPAIR` `:679`; `!SET_AI_AUTO_ATTACK` `:682`;
`!SET_AI_AUTO_DEFEND` `:685`; `!SET_AI_DEFEND_ALLIES` `:688`; `!SET_AI_UNLIMITED_EQUIP` `:691`;
`!SET_AI_ARMY_TYPE` `:694`; `!SET_AI_START_POSITION` `:697`; `!SET_AI_DEFENSE` `:760`;
`!SET_AI_ATTACK` `:771-793` (+`COPY_AI_ATTACK` `:795`, `CLEAR_AI_ATTACK` `:806`).
**Read by newAI**: ArmyType, EquipRate*, UnlimitedEquip, MaxSoldiers, RecruitDelay, AutoAttack,
AutoBuild, StartPosition, IsRepairAlways. Not read by newAI: Aggressiveness, TownDefence,
RecruitCount, SerfsPerHouse, WorkerCount, DefendAllies.
MP preset `ApplyMultiplayerSetup` (`KM_AISetup.pas:134-153`) overrides MapEd values.

## 6. Gap list (what the sim must expose before the port)

1. House construction pipeline (plans/reservations/builders/materials/completion/demolish/repair).
2. Worker/serf tasking + unit training (school queue, barracks equip, idle detection).
3. Unit groups & orders (the full group API: orders, fight state, food/condition, formations,
   split/link, `CanWalkTo`, `IsIdleToAI`).
4. Fields (corn/wine): `SetField`, plan API, tile queries, field evaluation.
5. Mines/resource tiles: stone/gold/iron/coal queries, `CanPlace*Mine`, stone flood, mine splitting.
6. Market/trade/ware economy: market orders, `WareDistribution` writes, `GetWareBalance`, weapons
   balance, exhausted-house cleanup.
7. Script-provided AI data: classic `General.DefencePositions` + `General.Attacks` (the `!SET_AI_*`
   records), plus all setup fields.
8. NavMesh + navmesh pathfinding + defence lines (+ army vector field).
9. Influence maps (ownership, presence, `AvoidBuilding`, eval/mark helpers).
10. Army evaluation (power/food comparisons).
11. Road pathfinding for city planning (`TKMPathFindingCityPlanner` variants).
12. Hand stats (`TKMHandStats`, incl. `WareDistribution`).
13. AI save/load state (every class has Save/Load/SyncLoad; UID-based pointer restore).
14. Fog of war — **not** an AI dependency (newAI has zero FOW refs) but needed for the human view.
15. Peace-time/options gates (`IsPeaceTime`, `Options.Peacetime`).
16. Damage/attack notifications into the AI (`HouseAttackNotification`, `UnitHPDecreaseNotification`,
    `UnitAttackNotification` from houses/units/projectiles/fight code).

## 7. Port strategy notes

- Order: M3 economy (running) → M3b maps → M4 combat (groups/orders, house HP, projectiles,
  notifications — gap items 2, 3, 16) → M5 AI in dependency order: Eye/Influences → CityPredictor →
  CityPlanner/Builder → CityManagement → ArmyManagement/AttackNew/Defence → Supervisor.
- Skip `KM_ArmyAttack.pas` (dead). Keep the shared-Eye singleton and the 27-tick cadences exact.
- The AI is deterministic-friendly: 5 RNG draws, all `KaMRandom`; the exact RNG port already exists.
- The classic AI (`KM_AIMayor`/`KM_AIGeneral`) stays as the fallback for `!SET_AI_PLAYER` maps.
