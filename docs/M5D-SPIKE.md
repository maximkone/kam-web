# M5d spike - the playable skirmish (a real game on top of the sim)

Owner goal (2026-10-17): **finish KaM Remake on the web properly.** Today the browser client is a dev
viewer (keyboard hotkeys, no menus, no minimap, no AI hands, no end of game). M5d turns it into a game:
pick a real map, pick opponents (the Remake's Advanced AI), play it with a normal RTS UI, win or lose.
Then M6 adds multiplayer on the same command layer.

Order: **M5c** (AI military half, worker N) -> **M5d-A** (command layer + skirmish sim, worker O) ->
**M5d-B** (game UI, worker P, then Q) -> **M6** (relay + lobby + lockstep).

## 1. The key design rule: commands

Every player action is a plain serializable **command**; the sim only changes through
`applyCommand(world, cmd)`. The UI, the AI-for-human helpers, replays and (M6) the network all use the
same function. Nothing in the UI may mutate sim state directly. This is what makes lockstep and
replay-CRC possible later.

```
Command = { hand: number, tick: number, type: string, ...args }   // JSON only, no functions, no Maps
```

Required command types (names frozen; args are the obvious ids/tiles):
`housePlan {typeId,x,y}`, `houseRemovePlan {x,y}`, `roadPlan {x,y}`/`roadPlanLine {path}`,
`fieldPlan {x,y,kind}` (corn; wine if supported), `planRemove {x,y}`,
`houseTrain {houseUid, unitType, count}` (school queue), `houseEquip {houseUid, soldierType, count}`
(barracks queue), `houseDeliveryMode {houseUid, mode}`, `houseWareDemand {houseUid, ware, delta}`,
`houseRepair {houseUid, on}`, `houseDestroy {houseUid}`,
`groupWalk {groupUid,x,y,dir}`, `groupAttackUnit`, `groupAttackHouse`, `groupHalt`, `groupFormation`
(units per row), `groupSplit`/`groupLink` (if the combat sim has it; otherwise out + documented),
`gameSpeed`/`pause` are NOT commands (client-local in single player; M6 makes them host commands).

## 2. M5d-A scope (worker O: sim, no `apps/**`)

Files: `packages/sim/commands.ts`, `packages/sim/skirmish.ts`, tests, `tools/skirmish/**`.

- `commands.ts`: the command union + `applyCommand` + validation (a bad command is rejected with a
  reason, never throws, never desyncs: same input -> same result), a `CommandLog` (ordered list of
  commands with their execution tick). Reuse the existing sim functions (`construction.ts`,
  `combat.ts`, `economy.ts`); do not duplicate rules.
- `skirmish.ts`: `createSkirmish({ mapBytes, missionDat?, seed, slots })`, slots =
  `{ hand, kind: 'human' | 'ai', aiLevel?: 'advanced' | 'classic'?, team?, color? }`. It builds the
  economy world from the map + mission, starts the first store/units per hand as the Remake does,
  creates one `AiPlayer` per AI slot (worker M/N code), and exposes
  `step(world, commandsForThisTick)` = the one fixed tick: execute commands, sim tick, AI update,
  combat update, victory check. Human commands only for human slots (an AI hand never takes a
  command).
- **Victory / defeat**: port the Remake's real rule (find it in `_ref/kam_remake/src`: hand defeat
  when it has no houses/units that count, team victory when all enemies are defeated; script goals
  honoured when the mission has them). Document the exact rule and file:line in the record. Output
  `skirmishStatus(world)`: per hand `playing | defeated | won`, plus a `matchOver` flag.
- `tools/skirmish/cli.ts --check` -> `SKIRMISH CHECK PASS`: a frozen scripted human (hand 0) on a
  frozen real map (e.g. `MapsMP/Battle Sun`) vs 1 Advanced AI for a frozen number of ticks;
  prints event counts and a state sha256; **two runs identical; AND replaying only the logged
  commands onto a fresh world gives the same sha** (the multiplayer foundation).
- `tools/skirmish/cli.ts --bench` prints ms per tick (median, p95) for 1 human + 3 AI on a 256x256
  map; the number goes into the record (the browser must hold 10 ticks/s at 1x with room to spare;
  if p95 is over 50 ms, list the top 3 hotspots and fix the cheapest).
- Must not change any frozen sha of M0-M5c checks.

## 3. M5d-B scope (worker P, then Q: `apps/web/**`)

The game shell (new files under `apps/web/game/` + `apps/web/ui/`; `play.ts` is the 170 KB renderer
and is only changed where a hook is needed; extract, do not rewrite):

- **Setup screen**: map list (the 243 install maps, with size/players), player slots (you + up to 7
  AI, AI level, color, team), start. Skirmish starts in the browser straight from the player's own
  imported install (existing import path).
- **In-game UI** (DOM over the canvas, KaM-style panels; sprites from `GUI`/`GUIMain` packs where
  they exist, plain styled boxes where they do not):
  - top bar: stock summary, game speed (1x/2x/4x) + pause, menu;
  - **build menu**: tabs for houses (all types the hand has unlocked), roads, fields; ghost preview
    with valid/invalid colors; right-click/Esc cancels;
  - **minimap**: terrain + hand colors + fog, click to jump, drag the view box;
  - **house panel**: name, HP, workers, stock in/out with demand +/-, delivery mode, repair,
    destroy; **school** (train queue), **barracks** (equip queue), **store** (stock);
  - **group panel**: soldier icons, condition, formation, halt/attack; box-select + click-select,
    Ctrl-number groups;
  - **notifications**: under attack, building done, unit trained, out of resources;
  - **end of game**: victory/defeat screen from `skirmishStatus`, then back to setup.
- All actions go through `applyCommand` (the UI keeps a local command queue and calls the skirmish
  `step`). The existing dev hotkeys may stay behind a `?dev=1` flag.
- Keyboard: arrow/WASD pan, wheel zoom, Space pause, +/- speed, number-key groups, Esc.
- Sound/music: out of M5d (own milestone); no placeholder noise.

## 4. Acceptance

**A (lead):** `node tools/skirmish/cli.ts --check` PASS twice identical + command-replay sha equal;
`--bench` recorded; `npm test`, `npx tsc --noEmit` 0; M0..M5c checks unchanged.
**B (lead, real browser via CDP):** setup screen lists 243 maps; start Battle Sun vs 1 Advanced AI;
place a house through the build menu and watch it complete; the minimap click moves the view; train
a unit at the school and equip a soldier at the barracks through the panels; select a group by box
and send it; the AI attacks you within the run; a decisive scripted ending produces the
victory/defeat screen; zero console errors; screenshots in the record.

## 5. Out of M5d (later)

Multiplayer (M6), campaigns and mission scripts beyond what the skirmish needs (M7), map editor,
sound, replays UI, mobile layout, save/load.

## 6. Acceptance record

### 6.1 Worker O - M5d-A: command layer + skirmish sim (accepted by the worker; the lead re-runs)

**Files (new):** `packages/sim/commands.ts`, `packages/sim/skirmish.ts`, `packages/sim/commands.test.ts` (9
tests), `packages/sim/skirmish.test.ts` (10 tests), `tools/skirmish/cli.ts`, `tools/skirmish/expected.ts`. **Changed:** `package.json` only (the two test files in `test`, and a
`skirmish` script). No sim file of N2 (`ai.ts`, `aiarmy.ts`, `aisupervisor.ts`, `economy.ts`) and no
`apps/**` was touched; the working tree held no AI edits when the numbers below were taken.

**Commands** (`commands.ts`, `applyCommand(world, cmd, gate?) -> {ok:true} | {ok:false, reason}`; never
throws; every check runs before the first sim call; the multi-step ones are atomic):
- applied: `housePlan` (canAddHousePlan/addHousePlan), `houseRemovePlan` (remHousePlan), `roadPlan` and
  `roadPlanLine` (all or nothing, rollback), `fieldPlan` kind corn (canAddFieldPlan/addFieldPlan), `planRemove`
  (field plan, else house plan), `houseTrain` (school queue; all or nothing against the free slots),
  `houseEquip` (barracksEquip up to `count`; ok when at least one), `houseDestroy` (demolishHouseByUid),
  `groupWalk` (groupOrderWalk with dir 0..8), `groupAttackUnit`/`groupAttackHouse`/`groupHalt` (orderGroup),
  `groupFormation` (groupSetUnitsPerRow; takes effect at the next group order, the sim's formation is set on orders).
- accepted as a type, refused with a reason (nothing in the v0 economy to call): `houseDeliveryMode`,
  `houseWareDemand`, `houseRepair` (economy.ts has no delivery-mode state, no ware orders, no repairs);
  `fieldPlan` kind wine (construction.ts: wine out of v0).
- left out: `groupSplit`, `groupLink` (combat.ts header: "split/link ... orders ... are out of v0").
- not commands: gameSpeed, pause. `CommandLog` = `{tick, cmd}[]`; `commandLogToJson`, `commandLogFromJson`
  (shape check), `commandsAtTick`.

**Skirmish** (`skirmish.ts`): `createSkirmish({mapBytes, mapPath?, missionDat?, defines, seed, slots})`
(slots `{hand, kind:'human'|'ai', aiLevel?, team?, color?}`; `defines` is the install's tiles.json, mapelem.dat,
unit.dat, houses.dat, which the spec's signature did not list). `step(sk, commands)` = one tick in this order:
accepted commands (the human slots only, the tick must equal the tick being run, a defeated human takes none)
-> Supervisor -> each playing AI (the aisim order, KM_Game.pas 3101-3114) -> `world.tick()` (groups, units,
houses, logistics, projectiles, all inside the economy tick) -> the victory check of the hand whose cadence falls
on this tick. `skirmishStatus(sk)` -> per hand `playing|defeated|won` and `matchOver` (a human hand decided).
`skirmishGate(sk)` is the gate used by `step`. `normalizeSlots` and `buildHandGoals` are exported for tests.

**Victory / defeat rule (ported; Remake = read-only `_ref/kam_remake/src`):**
- Goals per hand: script goals win (`!ADD_GOAL` = victory, `!ADD_LOST_GOAL` = survive; the Remake reports a
  deprecated condition or a message on ADD_GOAL and does not add it, KM_MissionScript_Standard.pas:728-757). A
  hand with no script goal gets the default goals: survive its own buildings (troops in a tactic mission), and win
  by the same condition on every enemy (KM_AI.pas:158-171, KM_AIGoals.pas:189-205; enemy = alliance atEnemy,
  the default, KM_Hand.pas:424). Building mode vs tactic: KM_HandsCollection.pas:1142-1148, KM_MapTypes.pas:42.
- Conditions (KM_AI.pas:196-213; the numbers KM_MapTypes.pas:27-38): gcBuildings = a store, school, barracks or
  town hall (GOAL_BUILDINGS_HOUSES, KM_MapTypes.pas:52); gcTroops = warriors > 0 (GetArmyCount,
  KM_HandStats.pas:572-579); gcMilitaryAssets, gcSerfsAndSchools, gcEconomyBuildings as KM_AI.pas:203-208.
  A victory goal is met when its condition is FALSE (gsFalse, KM_AI.pas:211-212); a survive goal when TRUE.
- CheckGoals (KM_AI.pas:229-268): defeat when a survive goal fails; otherwise won when the hand has victory goals
  and each is met (an enemy that has lost counts as met, KM_AI.pas:237). Defeat overrides victory (KM_AI.pas:261).
  Run for hand h when `(tick + h) mod 27 = 0` (KM_AI.pas:559, MAX_HANDS 27), i.e. each hand every 27 ticks.
  Sticky: no change after defeat or win (KM_AI.pas:127, 146, 554). Defeated AIs stop (KM_AI.pas:554).
- Commands of a defeated human are refused (KM_GameInputProcess.pas:991). matchOver = a human hand decided
  (single-player end: KM_Game.pas PlayerDefeat, the RequestHold path).
- Approximations: the counters are live (a house counts once `done` and not destroyed; a unit while not dead),
  not the Remake's Initial/Built/Lost counters (KM_HandStats.pas:352-364); the check runs after `world.tick()`.

**Scenario and check** (`tools/skirmish`): MapsMP/Battle Sun, hand 0 human vs hand 1 Advanced AI, 3000 ticks,
seed 1, through `step` only. Setup grants (not commands, the same in the live run and the replay): a finished
school beside hand 0's store, a militia group of nine, six militia garrisons for each AI hand. The human's
scripted commands at ticks 1 housePlan (woodcutter spot), 2 roadPlanLine, 3 fieldPlan corn, 4 houseTrain (school,
serf x2), 50 groupFormation, 100 groupWalk (midpoint between the stores), 400 groupAttackUnit (nearest enemy unit),
900 groupHalt. All 8 accepted, 0 rejected. Hands 2 and 3 are closed: their mission content is not loaded.
Hand-level numbers at 3000 ticks: houses 8 (6 done), units 33, human kills 6, losses 5, match not over.

**Results (one-line, my own runs):**
- `node tools/skirmish/cli.ts --check` -> `SKIRMISH CHECK PASS (3000 ticks, 384 events, 8 commands, 1849 ms)`.
  Run 1 and run 2 sha256 `54a2cdfc08561e692aeed4cf3cc6ef2e3c805b0fa39be095c169305691c2ed91` (identical); replay
  of the 8 logged commands on a fresh world: `sha256=54a2cdfc...` `failures=0` (equal); the command log JSON
  round-trips. Negatives: an invalid housePlan (typeId 99), a housePlan and a groupHalt for AI hand 1 are each
  rejected and leave the sha unchanged. Two separate processes gave the same sha (`--ticks 3000`).
- Frozen (`expected.ts`): load `Battle Sun 0:human 1:ai`, the 22 event kinds, the final block, sha above.
- `node tools/skirmish/cli.ts --bench` (1 human + 3 AI on **MapsMP/Center Trees**, 256x256, 8 starts; 3000 ticks):
  final run `median 1.649 ms, p95 6.963 ms, max 71.125 ms, mean 2.460 ms` (7379 ms total). Earlier runs on the
  same machine (N2 working in parallel): median 1.787/1.416/2.950, p95 6.801/5.701/10.743 ms. p95 is under
  50 ms, so no fix is needed. The informational phase pass (first 1000 ticks, cumulative): `world.tick`
  2393 ms (economy, combat, logistics; not my files), `ai hand 2` 122 ms, `ai hand 1` 111 ms, `ai hand 3` 59 ms,
  commands 13 ms, Supervisor 9 ms. The 10 ticks/s budget (100 ms per tick) has a wide margin.
- `npm test` -> `ℹ tests 144`, `ℹ pass 144`, `ℹ fail 0` (125 before + 19 new in commands.test.ts and skirmish.test.ts;
  the new commands/skirmish tests wired into the `test` script).
- `npx tsc --noEmit` -> exit 0.
- Regressions, unchanged: `WALK CHECK PASS`; `ECON CHECK PASS (6000 ticks, 336 events, 1576 ms)` sha
  `6d780b62b56f83b3c9f4b1aa2d414ae6186c0a84491843d315554d49f7fcbc41`; `COMBAT CHECK PASS (900 ticks, 69 events,
  124 ms)` sha `09a19821bab67969bad8d1e0e45d3aa3c026c7ee08119cb43927ee0f5c6a30a8`; `BUILD CHECK PASS (2000 ticks,
  281 events, 518 ms)` sha `98b805259afc4f7020f07f378dd9d6368f30a111d3f5952936855d74ca7315e3`; `MAPSCAN CHECK
  PASS (243 maps, 0 anomalies)`. (aisim not re-run by me: no AI file touched. Its shas are N2's.)

**Simplifications and deviations (documented in the headers):**
- The step order: the spec lists "tick, AI, combat"; the existing sim runs combat inside `world.tick()`, and the AI
  must run before it (the aisim order). The victory check runs after `world.tick()`.
- `step` and `skirmishStatus` take the `Skirmish` object (the world plus the status, goals and AI players),
  not the bare world the spec wrote; the world is `sk.world`.
- Team numbers are stored; two hands with the same team are rejected (`economy.allianceOf` is per hand).
- The classic AI is not ported: `aiLevel: 'classic'` is rejected. An advanced slot forces `newAI` on.
- Closed hands: a hand without a slot has its mission content (houses, units, streets, wares) not loaded.
- The world's RNG has no seed input (economy.ts `rng = 1`): `createSkirmish` burns `seed mod 65536` draws.
- Hands with no store get `placeFirstStorehouse` (the AI's rule) for human hands too; the Remake lets the human
  choose the spot. Hands with no mission wares get the aisim RMG "Medium" kit and serfs/builders.
- `houseEquip` equips as many as possible (up to `count`) and is ok when at least one is equipped.
- Sharks Islands (the spec's "try") is 256x256 but its mission has no starting houses or units at all (no hand
  can start), so the bench uses MapsMP/Center Trees (256x256, a store for each of the 8 hands).
- The check's frozen sha depends on the Advanced AI (`ai.ts`, `aiarmy.ts`, `aisupervisor.ts`): an AI change
  moves it. It must then be re-frozen with the reason in the record, like aisim's numbers.
- The browser: `createSkirmish` reads the map through `parseMapFileBytes`, which takes a Node `Buffer`
  (`map.ts`). Node works; the browser needs a `Uint8Array` map entry first (`apps/web/mapread.ts` is the browser's
  copy; it is not imported here, to keep `packages/sim` free of `apps`).
- Test worlds: the unit tests use synthetic worlds (no install), as the other sim tests do; createSkirmish with a
  real map is covered by the `--check`.

**Wished-for sim functions (not done here; the UI and M6 need them):**
1. A seed input for `createEconomyWorld` (the RNG is fixed; `createSkirmish` burns draws).
2. A per-pair alliance setter (teams), so `allianceOf` can follow the lobby teams.
3. House delivery modes (per house: delivery / take out / closed), ware orders (the +/- demand of a house's wares),
   and house repair. Each would back one command type that is refused today.
4. A barracks equip queue (the UI shows a queue; `barracksEquip` is immediate today).
5. Group split and link (combat), and what `manualFormation` means (it is set nowhere).
6. A browser-safe `.map` reader taking `Uint8Array` (the same wish as `apps/web/mapread.ts`).
7. A "buildable house types" list for the build menu (per hand: `houseCanBuild` for each type, as a query).
8. Stat counters per hand (Initial/Built/Lost, as KM_HandStats) instead of the live counts used by the goals.
9. A real closed-slot flag (`Enabled`) for hands, instead of dropping their content.

**Open:** the browser match and the UI are M5d-B. The `--check` numbers move with N2's AI work (re-freeze when it
lands). The lead's independent re-run is the acceptance step.
