# M4 spike — combat slice v0: warriors, arrows, house damage, groups, fog of war

Next rung (`docs/PLAN.md`): **warriors, houses HP, projectiles, fog of war** — the substrate the
Advanced AI (M5) needs to fight. The slice must let a human fight: select warriors, order an attack,
watch melee/ranged combat resolve with the game's real timing, damage and destroy a house, and see
fog of war.

Workers: **I** = combat sim (headless: `packages/sim/**`, `packages/assets/unitdat.ts` additive,
`tools/combatsim/**`); **J** = viewer (`apps/web/**`). Same rules as M2b/M3: bare `node file.ts`,
zero runtime deps, ESM with `.ts` imports, no `enum`/`namespace`.

## 1. Scope (v0)

In (each with exact source refs in §2):
- **Warriors**: the fight action (melee + ranged), enemy acquisition, orders, damage/death.
- **Projectiles**: arrows/bolts (the sim half: flight, hit, damage) in the real tick slot.
- **Unit groups**: formation, the orders API (`OrderWalk`/`OrderAttackUnit`/`OrderAttackHouse`/
  `OrderHalt`/`OrderNone`), the per-tick cadences, offenders/`CheckForFight`, `IsIdleToAI` — this is
  exactly the AI's gap items 3/16 (`docs/M5-AI-NOTES.md`).
- **Houses in combat**: `AddDamage`/`GetHealth`/`Demolish` + rubble (its RNG), melee vs arrow damage.
- **Fog of war**: per-hand byte arrays + reveal/decay + **the two sim gates** (archer/tower targeting
  and ranged-fight continuation filter on the shooter's own hand FOW).
- **Notification stubs** with the exact signatures/positions (`HouseAttackNotification`,
  `UnitHPDecreaseNotification`, `UnitAttackNotification`) — bodies no-op until M5.
- **CLI** `tools/combatsim/cli.ts --check`: a deterministic scripted skirmish on a real map (Arena
  from M3b), frozen numbers + state sha256.
- **Viewer**: FOW dim/blackout, projectiles in flight, fight/die animations, house damage + fire
  sprites, rubble, group selection + attack orders.

Out (v0, documented): storm attack, tower rocks, split/link/formation orders, the worker repair task
+ `RepairList`, hunger/thoughts polish, sounds/alerts/script events, Hungarian member reorder
(**flagged**: it is deterministic and changes member slot destinations — deferred with documented
drift), animals as arrow/rock targets (the game explicitly skips them).

## 2. Frozen facts (r15472; line refs into `_ref/kam_remake/src`)

### 2.1 Tick order (combat)

`KM_Game.PlayGameTick` (`game/KM_Game.pas:3031-3145`): `IncTick` → `TakePlannedCommands` →
`fScripting` → `gTerrain` → `gAIFields` → **`gHands.UpdateState`** → `gMySpectator` →
`fPathfinding` → **`gProjectiles.UpdateState`** (`:3112`) → `RunningTimer`.

Per hand (`hands/KM_Hand.pas:2099-2135`): **groups first** (`fUnitGroups.UpdateState` `:2108`; per
group `mod 5` `CheckForFight`, `mod 7` `CheckOrderDone`, `mod 10` hunger —
`units/KM_UnitGroup.pas:2258-2286`) → units (`KM_UnitsCollection.pas:352-391`, **descending index**;
live units `UpdateState` then `UpdateVisualState`; dead units deleted here when pointer-free) →
houses (`houses/KM_HouseCollection.pas:426-436`) → FOW (`KM_Hand.pas:2113`) → constructions/
deliveries (staggered) → AI.

Per unit (`units/KM_Units.pas:2560-2683`): kill/dismiss ASAP → `fTicker++` → hunger (every 10) →
FOW reveal → thoughts → HP regen → unwalkable-tile kill → **`fAction.Execute`** (fight strikes,
projectile launches, die-anim start) → **`fTask.Execute`** (`TaskDie` phases, `TaskAttackHouse`
hits) → warrior tail (`TakeNextOrder`, `mod 6` enemy scan — `KM_UnitWarrior.pas:1107-1117`).

**Copy exactly**: melee kills land during the units pass (corpse removed next tick); arrow kills land
**after** the units pass in the same tick; group orders land before member actions in the same tick;
house destruction by arrow happens after that hand's house pass.

### 2.2 Warriors + the fight action

- Stats: `TKMUnitSpecLegacy` (`res/KM_ResUnits.pas:16-29`): HitPoints, Attack, AttackHorse, x4,
  Defence, Speed, x7, Sight, x9, x10, CanWalkOut, x11 — plus `PatchUnitSpec` overrides
  (`:566-607`), the fight-type table (`:362-378`), shield projectile defence (`:258-272`),
  `SupportsAction` (`:283-319`).
- `TKMUnitActionFight` (`units/actions/KM_UnitActionFight.pas:325-371` + subroutines): melee vs
  ranged; `fFightDelay`; the `[0,3,6]` pause rolls; ranged aim/fire steps (`ExecuteProcessRanged`);
  the ranged continuation FOW gate (`:199-200`); **RNG draws happen before the FOW gate by design**
  (`:167-172`) — copy that order.
- Order flow: `TKMUnitWarrior.TakeNextOrder` (`:888-980`), `FightEnemy` (`:739-757`), enemy scan
  (`:660-718`), `WithinFightRange` (`:413-445`), the `mod 6` scan (`:1110-1117`).
- Damage/death: `HitPointsDecrease` (`KM_Units.pas:1627-1645`), `Kill`/`DoKill` (`:1532-1575`),
  `KM_UnitTaskDie.pas:59-116`, group bookkeeping `OnWarriorDied` (`KM_UnitWarrior.pas:270-286`,
  `KM_UnitGroup.pas:792-834`).
- Notifications (stubs in M4, exact positions): `HouseAttackNotification` (`KM_Houses.pas:1317`),
  `UnitHPDecreaseNotification` (`KM_Units.pas:1637`), `UnitAttackNotification`
  (`KM_UnitActionFight.pas:281,285`, `KM_Projectiles.pas:188`).

### 2.3 Projectiles

`KM_Projectiles.pas`: types + constants (`:67-75`), flight/hit/damage (`:94-341`), the FOW-gated
render check (`:1008-1012` is render-side), RNG draw order (`:298-300`), arrows skip animals
(`:311,333`). Tick slot: after `gHands` (`KM_Game.pas:3112`). Arrow vs house = 1 HP
(`:326-330`).

### 2.4 Unit groups

`units/KM_UnitGroup.pas` (2696 lines): member list + formation `GetPositionInGroup2`
(`utils/KM_CommonUtils.pas:618-646`), `UnitsPerRow`; orders `OrderWalk`/`OrderAttackUnit`/
`OrderAttackHouse`/`OrderHalt`/`OrderNone`/`OrderRepeat` (`:715-718, 925-987, 991-1126, 1320-1341`);
per-tick `UpdateState` (`:2258-2286`); `CheckForFight`/`CheckOrderDone`; `CanTakePlayerOrders`
(`:1218-1230`); `IsIdleToAI`; `InFight*` predicates (`:1131-1196`); `FightMaxRange` (`:428-436`);
`Condition` (`:471-478`). Member order execution: `KM_UnitWarrior.UpdateState`
(`KM_UnitWarrior.pas:1086-1127`) — the group runs before units, so same-tick orders apply.
Collection APIs (`KM_UnitGroups`, `:198-235`): `GetClosestGroup`, `GetGroupsInRadius`,
`GetGroupsMemberInRadius`, `HitTest`, `GetGroupByMember` — the AI reads these.
**Deferred**: `HungarianReorderMembers` (`:2071-2115`, `utils/algorithms/KM_Hungarian.pas`, feature
default true) — deterministic but only affects member slot destinations; documented drift.

### 2.5 Houses in combat

- `AddDamage(aAmount, aAttacker)` (`houses/KM_Houses.pas:1296-1330`): clamp to MaxHealth; if complete
  → repair list + `UpdateDamage`; **AI notify**; demolish at `GetHealth = 0`.
- `GetHealth = Max(fBuildingProgress − fDamage, 0)` (`:1173-1176`); `UpdateDamage` adds
  `haFire1..haFire8` sub-actions by damage level (`:1348-1363`); **no per-tick fire damage**.
- Melee strike on a house = **2 HP** (`units/tasks/KM_UnitTaskAttackHouse.pas:192` + 6-tick pause);
  arrows = **1 HP**; ranged attack task (`:96-204`) incl. the ranged keep-distance logic.
- `Demolish` (`:730-786`): OnDestroyed → rubble (`terrain/KM_Terrain.pas:4922-4947`, one
  `KaMRandom(6)` per tile for stone/done builds), road removal, script event; object deleted one tick
  later.
- Repair (`AddRepair` `:1334-1344`) is out of v0.

### 2.6 Fog of war (sim-mandatory)

- Per-hand `TKMFogOfWar` (`game/KM_FogOfWar.pas:23-88`): byte arrays `Revelation` (vertex-based,
  0..255); `FOG_OF_WAR_INC = 128`, `FOG_OF_WAR_MAX = 255`, `FOG_OF_WAR_DEC = 12`,
  `FOW_PACE = 10` (`common/KM_Defaults.pas:531-535, 18`); radius from unit/house `Sight`
  (`res/KM_ResUnits.pas:79`, `res/KM_ResHouses.pas:91`).
- Reveal: units one-shot max on tile change (`KM_Units.pas:1744-1752`) + `INC` every 10 ticks
  (`:2611-2612`); houses full on activate (`KM_Houses.pas:689-695`) + `INC` every 10 (`:2204-2212`).
- Decay: `TKMFogOfWar.UpdateState` every tick, each tile once per 10 ticks (`:554-594`).
- Checks: `CheckVerticeRev` (`:382-399`: dynamic `≥160 → 255` else `(F shl 8) div 160`; static
  `≥80 → 255` else 0), `CheckTileRev` (`:457-474`, max of 4 vertices).
- **Two sim gates**: archer/tower targeting requires `CheckTileRevelation = 255` for the shooter's
  hand (`terrain/KM_Terrain.pas:2049`, from `KM_UnitWarrior.pas:653,713`; tower `KM_Units.pas:767`);
  ranged fight continuation drops unrevealed opponents (`KM_UnitActionFight.pas:199-200`).
- The **AI never reads FOW** (`docs/M5-AI-NOTES.md` §6.14).

### 2.7 Rendering (worker J)

- FOW: dim/black tiles by `RenderRevelation` (the render copy adds `RENDER_RADIUS_ADD = 5`,
  `KM_FogOfWar.pas:111,207`; exact render-radius optimisation is visual-only — a faithful
  approximation is accepted for v0).
- Projectiles: sprites + arcs (`render/KM_RenderPool.pas` projectile pass; arrows skip animals).
- Fight/die animations: unit actions `uaWork`/`uaWork1`/`uaWork2`/`uaSpec`/`uaDie` frames
  (`unit.dat` anims, already parsed); house fires `haFire1..8` (house anims, parsed); rubble objects
  (mapelem + Tileset sprites).
- Group selection UI: click selects a group (the game's `HitTest`), right-click orders
  walk/attack (attack = enemy unit or house under the cursor).

## 3. Interfaces (frozen)

- `packages/assets/unitdat.ts` (additive on `UnitSpec`): `hitPoints`, `attack`, `attackHorse`,
  `defence`, `sight` (numbers), `fightType: 'melee' | 'ranged'` (from the fight-type table),
  `isWarrior: boolean`.
- `packages/sim/combat.ts` (new): the combat systems used by the world:

  ```ts
  export interface SimGroup { uid: number; owner: number; memberUids: number[];
    groupType: number; order: 'none'|'walk'|'attackUnit'|'attackHouse'|'halt';
    orderX: number; orderY: number; targetUid: number; targetHouseUid: number; }
  export interface SimProjectile { uid: number; kind: 'arrow'|'bolt'|'stone'; fromX: number;
    fromY: number; toX: number; toY: number; targetUid: number; targetHouseUid: number; t: number; }
  export class FogOfWar { constructor(mapX: number, mapY: number);
    reveal(x: number, y: number, radius: number, max: boolean): void;
    cover(x: number, y: number, radius: number): void;
    updateState(dynamic: boolean, tick: number): void;
    checkTileRev(x: number, y: number): number; checkVerticeRev(x: number, y: number): number; }
  ```
- `packages/sim/economy.ts` (additive on `EconomyWorld`): `groups: SimGroup[]`,
  `projectiles: SimProjectile[]`, `fow: FogOfWar[]` (per hand), `orderGroup(uid, kind, x, y, target?)`,
  `damageHouse(houseUid, amount, attackerUid)`, `unitHealth(uid)`, `groupOf(uid)`; `EconUnit` gains
  `hitPoints`, `groupUid`, `fightState` (`'none'|'fight'|'die'`), `dead: boolean`.
- `tools/combatsim/cli.ts`: `--check` (frozen skirmish numbers + sha256), `--ticks N`, `--json`,
  `--map <kind>/<name>` (default `MapsMP/Arena`).

## 4. Workers

- **Worker I** — `packages/sim/combat.ts` (+ additive `economy.ts`/`unitdat.ts` edits),
  `tools/combatsim/**`, tests. Must not touch `apps/**`, `docs/**`, `package.json`; all M0–M3b
  checks must keep passing.
- **Worker J** — `apps/web/**` only: FOW rendering, projectiles, fight/die anims, house damage/fire/
  rubble, group selection + orders, HUD combat fields.

## 5. Viewer (worker J)

- On the M3 page (and after M3b lands, on any map): warriors render with fight/die anims;
  arrows fly and stick/skip; houses show damage (fire sub-actions) and collapse to rubble when
  destroyed; fog of war dims everything outside the human hand's `RenderRevelation` (toggle key);
  click selects a unit/group, right-click orders walk or attack (enemy unit/house under cursor);
  HUD shows the selected group (count, order, condition) and the human hand's house HP when damaged.

## 6. Acceptance (lead)

1. `node tools/combatsim/cli.ts --check` → `COMBAT CHECK PASS` (frozen: kills by melee and by arrow,
   a house destroyed with rubble, FOW-gated targeting behaviour, the state sha256).
2. `npm test` (new tests) exit 0; `npx tsc --noEmit` exit 0.
3. Lead's independent check: the frozen skirmish re-run twice → identical sha; a second scenario
   (ranged vs melee on a different map) deterministic; browser CDP run: select a group, order an
   attack, arrows in flight, a house loses HP and collapses, FOW dims outside sight; screenshots.
4. Regressions: M0 `CHECK PASS`, M1 `MAP CHECK PASS`, M2 `replayinfo` §2.4, M2b `WALK CHECK PASS`,
   M3 `ECON CHECK PASS`, M3b `MAPSCAN CHECK PASS`.

## 7. Acceptance record

### 7.1 Worker I — combat sim: accepted

- `node tools/combatsim/cli.ts --check` → `COMBAT CHECK PASS (900 ticks, 69 events)` (exit 0); two
  runs identical sha256 `09a19821bab67969bad8d1e0e45d3aa3c026c7ee08119cb43927ee0f5c6a30a8`; perturbed
  `expected.ts` → FAIL (exit 1); `--map MapsMP/Cross` deterministic (sha `a694d656…`).
- Frozen numbers (Arena, 900 ticks): load `32x32 hands=7 houses=1 streets=2 units=20 warriors=13
  house=hut#18@(16,28)`; events arrow-fired 26, fight-retarget 3, fow-drop 1, group-died 2,
  house-destroyed 1, hp-decrease 24, kill-source 6, unit-killed 6; final meleeKills 4, rangedKills 2,
  arrows 26/hits 13, fowDrops 1, houseDamage 250, rubble 2, unitsAlive 14, groupsAlive 4,
  rngState 590275977.
- `npm test` **98/98** (combat.test.ts wired in by the lead); `npx tsc --noEmit` exit 0.
- **Crash found by worker J, reproduced by the lead, fixed by worker I**: economy tasks held house
  *array indices* while destroyed houses were spliced out → `Cannot read properties of undefined
  (reading 'entrance')` one tick after any demolish (repro `%TEMP%\opencode\kamweb_m4_sim_repro.mjs`).
  Fix: all house references are uids (`houseByUid`, uid-keyed state map), deliveries abandon
  gracefully (`ShouldAbandonDeliveryTo` semantics + a `delivery-abandoned` event), workers lose dead
  homes and relocate, units inside a destroyed house are placed at the entrance, demands/offers are
  pruned; the deletion contract is unchanged (the house leaves `world.houses` one tick after
  Demolish). Regression test added (demolish mid-delivery, 300 ticks, no crash). All frozen numbers
  and shas unchanged.
- Accepted v0 divergences (I's flags): warrior tail runs before the inherited common tick (matches the
  Pascal override); walk interaction/push not ported (the walk-arrival enemy check is what starts
  melee fights); projectile flight length is flat; `MakeSound`'s RNG roll always drawn; Hungarian
  reorder deferred; unwalkable-tile kill skipped; storm/split/link/repair/sounds/script events out.

### 7.2 Worker J — combat viewer: accepted

- `npx tsc --noEmit` exit 0; `SERVE CHECK PASS`; J's own CDP run **58/58** (FOW inside/outside +
  toggle + hand switch; house fire levels + HUD HP; collapse → 4 rubble objects; scripted fight with
  real clicks, arrows ≤6 in flight, 2 deaths; picker Arena/Atoll; tutorial reload) + the lead's M3b
  script 21/21 against J's build.
- Lead's independent CDP run (`%TEMP%\opencode\kamweb_m4_leadcdp.mjs`, live server on 8143):
  **RESULT PASS pass=16 fail=0** — M3 counters hold; FOW 255 inside the hand-0 village / 0 far away /
  toggles; `scriptedFight()` spawns 10 warriors in 4 groups; arrows seen in flight (max 6) and deaths
  happen (59→56); a house loses HP (550→350) and **ticking 200 after the demolish shows no crash**
  (the fixed bug path in the browser), the house leaves the world (21→20) and 4 rubble objects
  appear; the economy keeps advancing afterwards (storeTrunks 30→20, events 39→470); Arena still
  loads clean (M3b); 0 blocked requests; no page exceptions; screenshots.
- Accepted deviations (J's flags): FOW uses `Revelation`/`checkVerticeRev` (the game's darkness
  source), per-vertex + LINEAR, projectile hiding by containing tile; group condition is
  viewer-derived; house fire anims parsed viewer-side; UI orders only the human hand's groups;
  scanned maps stay static until `enableCombatWorld()`/`scriptedFight()`.

### 7.3 Regressions (lead, all exit 0)

M0 `CHECK PASS` · M1 `MAP CHECK PASS` · M2 §2.4 numbers · M2b `WALK CHECK PASS` · M3 `ECON CHECK
PASS` (sha unchanged) · M3b `MAPSCAN CHECK PASS` · `npm test` 98/98 · `npx tsc --noEmit` exit 0.
