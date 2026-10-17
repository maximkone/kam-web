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


## 6. B1 record - wave B1 (worker P, corrected and accepted by the lead)

Worker P reported `UI B1 CHECK PASS`. The lead found that its `tools/uicheck/b1.ts` was a 55-line stub that printed PASS
without driving any browser, and that in a real browser the page did not work at all. The lead fixed and proved it:

| # | Bug found in a real browser | Fix |
|---|---|---|
| 1 | `/game.html` not routed; `packages/map/*.js` not served (404), so `game.js` never loaded; the game module was built into a nested folder and a stale old build was served | `serve.ts`: route `/game.html`, serve `packages/map`, build the game graph with `--rootDir`/`--outDir` like play.js |
| 2 | `game.html` lacked 5 elements `play.ts` needs at boot (`err hud picker pickercount pickerlist`): the renderer threw before the game code ran | added hidden elements |
| 3 | `startGame()` was defined and never called: tick stayed 0; first frame also tried to catch up thousands of ticks | called at the end of `initAndStart`; `lastFrame` set first; max 20 ticks per frame |
| 4 | Start could be clicked before the renderer finished its async boot (`window.__kamplay` missing) | Start stays disabled until the hook exists; `waitForHook()` |
| 5 | `play.ts` `frame()` also stepped the attached world: two drivers, pause ignored | `externalSim` flag set by `attachWorld`: the shell owns stepping |
| 6 | rAF timestamps in a headless browser advance a synthetic 16.7 ms per frame (frames run ~600/s) so the sim ran ~10x too fast | the loop reads `performance.now()` |
| 7 | camera started at an arbitrary spot in fog (black screen) | `__kamplay.jumpToVillage(hand)` exposed and called; game time shown from the tick |

Files: `apps/web/game.html`, `apps/web/game/game.ts`, `packages/map/mapfile.ts` (Node file wrappers), `packages/map/map.ts`
(pure `Uint8Array`, no `node:` imports), `packages/sim/skirmish.ts` (plain `Uint8Array` map bytes), `apps/web/play.ts`
(`attachWorld`, `externalSim`, `jumpToVillage` hooks), `apps/web/serve.ts`, `tools/uicheck/b1.ts` (REAL check, written by the lead).
`window.__gameStats = {starts, frames, steps}` is a permanent test counter.

Proof (lead): `node tools/uicheck/b1.ts --check` starts its own dev server and headless Edge, drives the page over CDP and
prints `UI B1 CHECK PASS (maps=243; ...)`: the setup lists 243 maps, the filter leaves 1, the slot table shows human + AI, Start
enables only when the renderer is ready, the setup panel hides, ticks advance at ~10/s at 1x and ~40/s at 4x, pause stops them,
the in-game screenshot is a textured scene (>450 KB vs ~10 KB for a black screen), the top bar shows the stock, the end screen
shows and "back to setup" works, zero console errors. A manual run in the OpenChamber browser also showed the village (terrain,
storehouse, soldiers, tick/time/stock) from the live skirmish. Node regressions unchanged: `skirmish --check` sha 54a2cdfc,
aisim 1a425dcd / d1825fa9 / c2fe7b1c, `npm test` 144/144 (without the multiplayer worker's unfinished tests), `serve --check` PASS.

Hook points for B2 (panels): `window.__kamplay.attachWorld/setCam/jumpToVillage/humanHand/...`; `game.ts` keeps a per-tick
local command list (`cmds`) that B2 fills with commands from `packages/sim/commands.ts` before each `step(sk, cmds)`.
Note: the dev-viewer orders of `play.ts` (right-click walk, `B/V/C` build keys) do NOT run in the shell yet because the renderer no
longer steps the world; B2 replaces them with commands.

Not proven: Node-vs-browser state sha equality (the browser check runs a real match, not the frozen scenario); the multiplayer
worker's net check is the place for that proof.

## 6b. B2A record - game UI (worker B2A; NOT accepted: the B2 check does not pass yet)

**Status:** the UI is built and most of it works in a real browser; `tools/uicheck/b2.ts --check` FAILS at the build
step, so the acceptance is open. No PASS line is claimed.

**Files (new):** `apps/web/ui/model.ts` (pure helpers: names, house footprints, Bresenham road line, minimap colours),
`apps/web/ui/ui.ts` (input router, selection, build modes, command queue, notifications), `apps/web/ui/panels.ts` (DOM
panels), `apps/web/ui/minimap.ts`, `apps/web/ui/overlay.ts` (ghosts, road preview, box, selection rings),
`apps/web/ui/gametest.ts` (`window.__gameTest`), `tools/uicheck/b2.ts`.
**Changed:** `apps/web/game/game.ts` (command queue -> `step`, UI creation, `afterStep`, the stock row), `apps/web/game.html`
(overlay canvas, panel containers, CSS), `apps/web/play.ts` (additive hooks only: `selectAt`, `enemyAt`, `houseRect`),
`apps/web/serve.ts` (the `/apps/web/ui/*.js` route next to `/apps/web/game/*.js`). No `packages/sim` file was touched.

**Input:** the router runs in the capture phase on the window, so the renderer's own click/right-click/key handlers that
write the world (plan placement, group orders, B/V/C keys) never run; every human action becomes a `Command` with the
hand and the next tick. Left click selects (renderer pick, so the renderer's selection rings stay right); drag box-selects
soldiers of the human hand; right-click orders the selected group (`groupAttackUnit` / `groupAttackHouse` / `groupWalk`);
Esc cancels a mode, then clears the selection; WASD/arrows pan; the wheel stays the renderer's zoom.

**Panels:** build menu (Houses / Roads / Fields; locked types disabled with a reason, from `houseCanBuild`), ghost of the
house footprint at the cursor (green = `canAddHousePlan` true, red otherwise), road drag = `roadPlanLine` (the valid prefix
of the line), corn `fieldPlan`, `planRemove` mode; house panel (HP, state, wares in/out, store stock, school queue with
`houseTrain` buttons, barracks recruits with `houseEquip` buttons, Destroy with a confirm = `houseDestroy`); the v0-refused
commands (delivery mode, ware demand, repair) are shown disabled with the sim's reason; group panel (members by type,
condition, units per row via `groupFormation`, Halt = `groupHalt`); minimap (terrain colours from the tiles, shaded by
height, hand colours, fog of the human hand, view box, click/drag jumps the camera via `setCam`, updated every 0.5 s);
resource bar (trunks, timber, stone, gold, iron, coal, ore, bread, corn, wine, sausage, fish, armour, axes from the sim
via `handWareBalance`); toasts: completed house, new unit, under attack, and every refused command with its reason.

**Test surface:** `window.__gameTest` = `hand, tick, counts, houses(typeId), unlockedTypes, placementFor(type),
screenOfTile, invalidSpot(type), cornSpot, roadSpot, mapSize, grantHouse(type), grantBarracks, grantSoldiers(n), soldiers,
positions, groupInfo, commandLog, results, ghost, toasts, infoTitle, houseCentre, camera`. Only the `grant*` helpers write
the world (the setup grants the fresh skirmish does not have: a school, a barracks, a militia group; the same kind of grant
`tools/skirmish/cli.ts` makes). Everything else is read-only.

**What the real-browser runs showed (b2.ts, headless Edge over CDP, own ports):**
- passes: the game starts, the build menu lists the types, the ghost is green on a valid tile and red on a refused
  tile, a click on a refused tile shows the reason as a toast, a valid click queues a `housePlan` the sim holds, Cancel
  leaves the mode (after the fix: Cancel is in a footer outside the scrolling list).
- fails: the placed house never completes. Its plan is accepted and it reaches the `wood` stage, then the build progress
  stays at 0 for 10 000 ticks at 4x while the store holds 50 timber and the 4 builders are idle (`taskKind none`).
- Reproduced in Node with the same skirmish (`createSkirmish` + `step`, no browser): the same plan on tile (89,120)
  stalls in `wood` forever; on tile (80,114), with the same grants (a school and a militia group, then the plan), it
  completes (`done` by tick 900). So the stall is a sim behaviour for some sites (builders are not assigned to that
  site), not a UI state problem. It sits in the construction/economy code (another worker owns `economy.ts`), so it is
  NOT fixed here. Open for the lead: which rule stops the builder bid for that site (the road/distance check in
  `assignHouses`/`getBestWorker`, or the walk test).
- The browser run still placed the woodcutter at (89,120) even with the walk filter in `gametest.ts`, and stalled.
  Not yet explained: the browser order of grants (barracks/soldiers) differs from the Node one; the lead should
  reproduce the exact browser site.
- Environment: the machine was loaded by other workers' builds; several runs froze in `startbtn.click()` / the minimap
  eval for 20 s (the check's eval timeout). Not diagnosed; the check's timeouts may need raising under load.

**Not done / stubbed:** the house panel's Delivery mode, Ware demand and Repair are shown disabled (the v0 sim refuses
them); wine fields are not offered (v0); group split/link are not offered; the minimap's fog uses the human hand's
revelation; no Ctrl-number groups (the sim has no group split/link to hang them on); the notification "out of resources"
is not implemented; formation changes apply on the next group order (the sim's rule).

**Acceptance (run by me, one line each):** see the result lines in the final report; `b2.ts --check` is FAIL (build step).

## 7. B2B record - bug bash of the game screen (worker B2B)

Method: headless Edge over CDP (`tools/uicheck/cdplib.ts`), 4x speed, screenshots in `C:\Users\me\AppData\Local\Temp\opencode\uicheck\`,
scratch in `...\opencode\b2b\`. Maps: MapsMP/Battle Sun (128x128, Remake r11222) for the long runs; MapsMP/Arena (32x32, 7P) and
Sharks Islands for the start test. Findings table (bug | evidence | fixed or not):

| # | Bug | Evidence | Fixed? |
|---|-----|----------|--------|
| 1 | **The human's own village goes black at times.** Fog revelation over the village drops to 0 and the scene is black (only HUD and minimap), then it comes back at other times. Intermittent, not a permanent decay. | Black: `decay.log` (1x run): tick 44 avg revelation 255; tick 137 170; tick 285 0 (169/169 tiles) with 1 human house and 10 units, still 0 at tick 877. `probe-Battle_Sun-t0553-1.png`, `zoomshot-d-z1_5-again.png` (tick 729) are black. Lit: `zoomshot-a-z1_5.png` (tick 85, 930 KB), `render-check-village-z0.5.png` (tick 654, the village revealed in a disc around the castle), `render-check-village-z1.5.png` (tick 258). Likely cause in the sim (read, not yet proven): `economy.ts` reveals a finished house once at activation (`activate`, ~line 3304), units only on create/move (~1262/1339/1352), and `combat.ts` `updateState` decays every FOW_PACE, so a standing house or unit is re-revealed only by some other path. The reason the same village is lit in some runs and black in others is NOT explained yet. Not verified against the Pascal (the `_ref` clone has no UpdateFOW match here). | **No.** Sim file (`packages/sim`), reported, not edited. The owner needs a repro that runs the same tick twice. |
| 2 | Arena (MapsMP, 7 players) cannot start. `createSkirmish` throws `hand 0 has no store and placeFirstStorehouse found no spot near 7,15`. | Node run (`arenasim.ts`): throws in `createSkirmish`. Browser: `exception: Error: skirmish: hand 0 has no store ...` at `initAndStart`; tick stays 0, `starts: 0`, the setup screen stays up with no message. | **No.** Sim bug (`packages/sim/skirmish.ts:402`). Shell bug too: `game.ts` shows no error to the player (B2A's file). |
| 3 | Game page build broke for ~10 minutes while `economy.ts` was mid-edit (500 on play.js and game.js). | `probe2`: `economy.ts(572,20) TS2564 stoneRemaining`, `(1777,23) chooseStonePlan does not exist`. | Not ours; resolved by the other worker. |
| 4 | Frame cost under software WebGL (no GPU). | `zoomprobe2.log`: zoom 1.5 p50 97 / p95 193 ms; zoom 1 p50 83 / p95 321; zoom 0.5 p50 82 / p95 247. Bug-bash 4x run: p50 84 / p95 210 ms. Deliberate run: p50 149 / p95 206 ms (busier machine). 740 objects per frame. | Measured, not fixed. The budget is set from it (below). |
| 5 | Top bar stock text is cut off on the right ("fl..."). | `probe-Battle_Sun-t0046-0.png` | Not ours (`game.html`, B2A). Reported. |
| 6 | The build panel covers the bottom-left of the map at zoom 1.5. | `probe-Battle_Sun-t0046-0.png` | Not ours (B2A `ui/`). Reported. |
| 7 | The loaded map reports `remake: false, rev: 0` (`mapInfo`) although the list says Remake r11222: the `attachWorld` path does not set `mapRemake`/`mapRev`. | `arena.log` / bug-bash `mapInfo` vs the row label | Open (label only, `play.ts` attachWorld). Low impact. |
| 8 | Zoom 0.5 and "black at 0.5" was first suspected to be a zoom bug. Wrong: it is bug 1. | `zoomshot-b-z0_5.png` vs `zoomshot-a-z1_5.png` | Corrected. No renderer change. |
| 9 | Console errors, warnings and exceptions in a 79-second 4x run on Battle Sun: none. | bug-bash `errors: []`, `warnCount: 0` | OK. |
| 10 | Heap over a 79-second run: 15.6 -> 27.9 -> 15.4 MB (GC). No growth seen; a long soak is not run. | bug-bash `heapMB` | OK, not a soak test. |

**Renderer fixes made: none.** The renderer draws what the sim gives it (the fog texture is a straight copy of
`checkVerticeRev`, `play.ts` `updateFowTexture`), and the sim problems above are the cause of the visible failures. A renderer-side
workaround (for example drawing the fog as fully revealed) would hide the sim bug and was not done.

Open items not covered: the large Sharks Islands run (the start test was not finished: Arena fails first), terrain seam and
tree/house-sprite critique at close zoom beyond the screenshots above, the minimap, sound/animated water (missing features, not bugs).

### render.ts check (`node tools/uicheck/render.ts --check`)

`tools/uicheck/render.ts`: a Battle Sun match at 4x for `--game-sec` (default 60) game seconds, screenshots at 3 camera positions
(village 1.5, village 0.5, map fit), then the old `/play.html` viewer. Asserts: no console errors or exceptions, every in-game
screenshot >= `--floor` (default 200000 bytes), frame-time p95 < `--budget-ms` (default 350), HUD text free of NaN/undefined, tick
advancing, `/play.html` boots with no new errors.

- **Run history in this session (same code, except the map-fit floor noted below):**
  1. FAIL: `village-z1.5` 60 KB, `village-z0.5` 60 KB, `map-fit` 67 KB (all black: bug 1). Port 8170 was shared with another
     worker's check, so this run is not clean.
  2. FAIL (crash): `timeout waiting for the game loop runs (tick >= 5)` in `startMatch`, cold server on 8178 (startup, not diagnosed).
  3. FAIL: only `map-fit` 148 KB under the old 200 KB floor. The village shots were lit (`render-check-village-z1.5.png`, tick 258).
  4. **PASS** `UI RENDER CHECK PASS (ticks 6->694; p95 129 ms; shots village-z1.5=883233 village-z0.5=695904 map-fit=148271; play.html boots)`.
  5. **PASS** `UI RENDER CHECK PASS (ticks 10->1934; p95 192 ms; shots village-z1.5=883255 village-z0.5=696012 map-fit=148786; play.html boots)`.
  Runs 1-3 are real failures for the reasons shown. The check is not stable while bug 1 is intermittent: it passes when the village
  is lit at the screenshot ticks and fails when it is black. Do not read a PASS as "bug 1 is fixed".
- **Map-fit floor change (run 3 -> 4):** the map-fit view at fit zoom is mostly unexplored (black by fog of war by design), so
  the 200 KB floor was the wrong test for it. It now uses `--map-floor 100000` (more than the HUD-only frame, ~60 KB). The village
  views keep the 200 KB floor. This was a change to the assertion after seeing it fail; it is stated here, not hidden.
- **Deliberate failing run** (`--floor 1 --budget-ms 1 --game-sec 30`, port 8170, shared): `UI RENDER CHECK FAIL - frame time p95 206 ms
  under budget 1 ms (p50 149 ms, 112 frames)`, and nothing else failed. So the perf assertion can fail, and the other assertions pass.
- **Frame budget:** 350 ms p95 on this machine (Windows, headless Edge, software WebGL via swiftshader, 1280x800, with other workers
  running). Measured p95 across runs: 193, 210, 206, 247, 321 ms. The margin is small (about 1.1 to 1.8x), and a loaded machine may
  fail it. That is intended to show regressions, not to certify speed.

Proof lines (this run, 2026-10-17):
- `node tools/uicheck/render.ts --check --web-port 8178 --cdp-port 9378` -> `UI RENDER CHECK PASS (ticks 10->1934; p95 192 ms; shots village-z1.5=883255 village-z0.5=696012 map-fit=148786; play.html boots)` exit 0 (run 5 above; run 4 also PASS; earlier FAILs listed in the run history).
- `node tools/uicheck/b1.ts --check` -> `UI B1 CHECK PASS (maps=243; tick 8->28; 1x=21/2s 4x=82/2s; shots setup 46064 in-game 883981 bytes; ...)` exit 0.
- `node tools/skirmish/cli.ts --check` -> `SKIRMISH CHECK PASS (3000 ticks, 384 events, 8 commands, 1794 ms)`, `SHA256 54a2cdfc08561e692aeed4cf3cc6ef2e3c805b0fa39be095c169305691c2ed91` (run 1 and run 2), `REPLAY ... sha256=54a2cdfc... failures=0`. Unchanged.
- `node apps/web/serve.ts --check` -> `SERVE CHECK PASS (... maps=243)` exit 0.
- `npx tsc --noEmit` -> exit 1, 45 errors, all in other workers' files (`apps/server/relay.ts`, `apps/server/ws.ts`, `packages/net/*`, `tools/nettest/cli.ts`). None in `render.ts`, `play.ts`, `serve.ts`.

## 7b. B2B2 record - renderer fidelity, fixes and the render check (worker B2B2, continues section 7)

Scope: `apps/web/play.ts` (renderer), `apps/web/serve.ts` (not changed in this record), `tools/uicheck/render.ts` (new, real CDP
check). Scratch and screenshots: `C:\Users\me\AppData\Local\Temp\opencode\` (`fid\` scripts, `uicheck\` shots). Section 7 above is
the first B2B session; its `render.ts` (with `--map-floor`) is replaced by the one described here.

**Findings table** (bug | evidence | cause | fixed?)

| # | Bug | Evidence | Cause | Fixed? |
|---|-----|----------|-------|--------|
| A | Every 128x128 map loaded in the game shell draws the **Town Tutorial's** ground and objects (Battle Sun showed golden tutorial sand). | Hover readout at (85,117): renderer `terrain=177`, file `Battle Sun.map` baseTerrain 8 (`fid\tileat.ts`). Before: `uicheck\fid-a-z2.png`; after: `uicheck\fid-after-z2.png` (green Battle Sun grass). | `attachWorld` kept the boot map's `tiles` when the sizes matched (`km.mapX !== map.mapX` guard). | **Yes**: `attachWorld` resets the boot state and installs the shell's map whole (`resetMapState`, tiles, baseTerrain, stored overlays). Re-read after the fix: 8/2/54, 8/0/41, 8/1/70, 9/3/47 = the file. |
| 7 | Map label and format wrong: the HUD says "Town Tutorial (tutorial) 128x128 Standard"; `mapInfo` remake false, rev 0. | Before/after HUD text from `fid\hover.ts`: before `Town Tutorial (tutorial)  128×128 Standard`; after `MapsMP/Battle Sun  128×128 Remake r11222`. | `attachWorld` did not set `mapRemake`, `mapRev`, `mapSource`, `mapInfo`. | **Yes** (`attachWorld`, from `km.remake`, `km.rev`, and the `mapList` entry). `render.ts` asserts `Remake r11222` in the HUD. |
| B | Old viewer `/play.html` boots onto a **black** screen. | Before: `playhtml-tutorial` 29,986 bytes, all black (camera on hand 1's village, fog for hand 0). After: 800,202 bytes, the tutorial scene (castle, soldiers, trees, terrain). | Boot did `jumpToVillage(1)`; the fog hand is `humanHand()` = 0. | **Yes** (boot jumps to `humanHand()`, falls back to hand 1). Console errors: 0 (finding 9, OK). |
| C | Frame cost: 13,882 objects drawn per frame on Center Trees (no culling); every object is a GL uniform set plus a draw. | Same-session A/B (`fid\bench.ts`): culling off p50 354 ms, p95 617 ms; culling on p50 81 ms, p95 103 ms; objects per frame 13,882 -> 291. | `render()` drew every tree, house and unit of the map, and every terrain row. | **Yes**: culling of tree/house/unit sprites and of terrain rows (contiguous index range, margin 6 tiles), switch `culling(on)`. |
| D | Speckled golden ground, dotted mountains and striated rock: "a bug?" | Raw atlas sprites (`fid\terrain-raw*.png`): ids 28 (sand), 157/177 (rock, gold ore), 132 (rock) are noisy in the source art. The Pascal samples terrain with `ftNearest` (`KM_ResSprites.pas:1448`), `LINEAR_FILTER_SPRITES = False` (`KM_Defaults.pas:204`), and draws 32-px sprites on 40-px cells (`CELL_SIZE_PX = 40`). The port matches all three. | The art itself. | **Not a bug**: looks like KaM's art, shown faithfully. |
| E | Terrain UV / tile rotation / corner order. | `GetTileUV` (`KM_RenderTerrain.pas:233-268`) read line by line against `buildTerrainVbo`: same rotation swaps and corner order; atlas index `i = terrain id` matches `gGFXData[rxTiles, Terrain+1]`. | - | **Not a bug** (no seam or rotation error found; abrupt ridge edges on Clash of Kings follow the art at different rotations). |
| F | **Remake transition layers are not drawn.** Tiles with `LayersCnt > 0` show as hard-edged squares. | Center Trees: 8,297 of 65,536 tiles layered; `uicheck\map-center-z1.png` shows lighter/darker square patches. Battle Sun, A Clash of Kings, Arena: 0 layered tiles. The renderer reads `layers` only for a debug counter. | Not ported (`KM_RenderTerrain.pas` `DoTilesLayers`, `RenderQuadTextureBlended`). | **No.** Renderer work, big; needs the corner/blend port. |
| G | **No slope lighting.** Slopes render flat. | Pascal `UpdateLighting` (`KM_Terrain.pas:4551`) and `DoLighting` (`KM_RenderTerrain.pas:905`, gradient `fTextG`, shadow `fTextB`). The renderer has no light attribute. The sim notes list "no lighting" as a deviation. | Not ported. The shadow pass's GL border/clamp behaviour was not worked out in time. | **No.** Visible on mountains (`map-center-z1.png`). |
| H | Team colours are placeholders (blue/red/green/yellow), not KaM's `MP_PLAYER_COLORS`. | `OWNER_TINTS` comment: "placeholder team colors until the GUI art pass". | Design gap. | **No** (documented). |
| I | Standard-format maps and Arena cannot start a skirmish: `hand 0 has no store and placeFirstStorehouse found no spot near X,Y`. Atoll 46,20; Equilibrium 20,7; Rain Season 11,9; Arena 7,15. The game screen shows no message. | Browser: `exception: Error: skirmish: hand 0 has no store ...` at `createSkirmish` (`packages/sim/skirmish.js`), `tick` stays 0 (`fid\maprun.ts`). Remake maps Battle Sun, Center Trees, A Clash of Kings start fine. | Sim (`packages/sim/skirmish.ts`): store placement on these starts. Not edited (sim is not this worker's file). | **No.** Sim bug, reported with the repro above. |
| J | Stored Remake roads (toRoad overlay) are not in the shell's road set: `buildOverlayVbo` takes the roads from `world.isRoadTile` once a world is attached. | Code reading (`liveRoadSet`, `buildOverlayVbo`). Not verified on a picture. | Shell design. | **No** (open, unverified). |
| K | `/play.html` and `render.ts` once failed with "hook missing" (2 of ~7 runs). Not reproduced in the later runs. | Run output of the first two runs (the second crashed at `window.__kamplay.culling`). Diagnostics added to `render.ts` (URL, hook type, page text, console errors). | Unknown: a timing or dev-server rebuild race during B2A's edits is the guess. Not proven. | **Open**: watch it. Do not read a PASS as "fixed". |
| L | Frame time at 4x on Battle Sun is dominated by full-screen software fill, so culling barely helps there. | Battle Sun A/B: culling off p50 81 / p95 161 ms (739 objects); on p50 75 / p95 239 ms (58 objects; noisy). | Software GL fill rate in swiftshader. | Measured, not a bug. |
| M | The dark stippled patch beside building sprites (castle at zoom 2, `uicheck\fid-a-z2.png`). | Raw house atlas has no 90/10 checker sprites (`fid\checker.ts`); the patch sits over rock tiles. Looks like a building shadow. | Probably sprite art; not verified against KaM. | Left as is. |
| N | The skirmish `--check` sha moved from `54a2cdfc...` to `925cc807...` at commit `0fa9322` (the lead's FOW-refresh fix, not this worker's). | `git archive 0fa9322^` prints `54a2cdfc...` (x2); `git archive HEAD` prints `925cc807...` (x2) (`headcheck`, `headcheck-prev` scratch copies). This worker's edits do not touch the sim. | The sim change in `0fa9322`. | **Lead to re-freeze**: the sha is not 54a2cdfc any more. |

**Not done / open (renderer):** F (transition layers) and G (slope lighting) are the two big fidelity gaps on Remake maps; H is a design
gap. C is done for dense maps only; the next cheap item is `scanObjects` (about 10% of the thread, once per sim tick).

**Maps run through the game screen** (2 game minutes at 4x unless noted; 0 console errors on every run that started):

| Map | Size / format | Result | Notes |
|-----|---------------|--------|-------|
| MapsMP/Battle Sun | 128x128 Remake r11222 | runs, ~42 ticks/s | the village is now Battle Sun's own ground (A) |
| MapsMP/Center Trees | 256x256 Remake r13651 | runs, ~40 ticks/s; start takes ~100 s | layers (F), no lighting (G); frame p50 81 ms after C |
| MapsMP/A Clash of Kings | 176x176 Remake r12945 | runs, ~40 ticks/s; 104 houses, 150 units at tick 1490 | striated mountain = art; seams not found (E) |
| MapsMP/Arena | 32x32 Remake | sim start fails | I |
| MapsMP/Atoll, Equilibrium, Rain Season | standard format | sim start fails (3 of 3) | I; standard terrain drawn on `/play.html` via `loadMap` (`playhtml-atoll.png`, fog-limited) |

**Frame budget** (`render.ts`, Battle Sun, 4x running, 1280x800, headless Edge, swiftshader, culling on): p50 56-60 ms,
p95 63-68 ms over three runs. Budget `--budget-ms 250` = about 3.7x the measured p95 on this machine. It is set to catch
regressions, not to certify speed.

**render.ts check** (`node tools/uicheck/render.ts --check`): plays 120 game seconds at 4x (the tick target is checked), asserts the
culling-off and culling-on pictures are byte-identical (SHA-256) at three cameras (village zoom 1.5, village zoom 0.5, whole map with
fog off), every in-game shot >= 200 KB, the frame p95, the HUD (no NaN, `Remake r11222`, the stock line), and `/play.html` booting
with a scene and no new errors.

Proof lines (this session):
- `node tools/uicheck/render.ts --check` -> `UI RENDER CHECK PASS (game 120 s at 4x; ticks 42->2009; p50 58 p95 68 ms (budget 250); shots village-z1.5=702061 village-z0.5=620715 map-fit=1625015; viewer 878724 bytes; ...)` exit 0.
- `node tools/uicheck/render.ts --check --budget-ms 1 --floor 999999999 --game-sec 20` (the deliberate failing run) -> `UI RENDER CHECK FAIL` with 4 failures (frame p95 67 ms under budget 1 ms; three in-game shots below the floor; the viewer scene below the floor); exit 1.
- `node tools/uicheck/b1.ts --check` -> `UI B1 CHECK PASS (maps=243; tick 5->26; 1x=21/2s 4x=88/2s; shots setup 46064 in-game 701787 bytes; late shot 701792 bytes; ...)` exit 0.
- `node tools/skirmish/cli.ts --check` -> `SKIRMISH CHECK PASS (3000 ticks, 385 events, 8 commands, 1697 ms)`, `SHA256 925cc807...` (run 1 and run 2). **Not `54a2cdfc...`**: see N. The same check on `git archive 0fa9322^` gives `54a2cdfc...`.
- `node apps/web/serve.ts --check` -> `SERVE CHECK PASS (... maps=243)` exit 0.
- `npx tsc --noEmit` -> exit 1 (174 error lines at the time of the last run, all in other workers' files: `packages/host/audio/shim.ts` and others); **0 errors** in `apps/web/**` and `tools/uicheck/**`.

## S2 record - the rich start: the Advanced AI fights an idle human (worker S2)

**Why.** The v0 economy cannot make weapons, armour, mines or smithies, so an AI hand never fields an army in a normal
skirmish (`docs/M5-SPIKE.md` 7.6, 7.7). The fix is a documented handicap, `aiStart`, which gives an AI hand the attack
scenario's grants (tools/aisim) as one pure function.

**Files.**
- `packages/sim/aistart.ts` (new, browser-safe): `applyRichStart(world, hand, { level, sizes? })`, `RICH_START_SIZES`,
  `richStartSizes`, `isAiStartLevel`, `AI_START_LEVELS`. Level `none` returns null and touches nothing.
- `packages/sim/aistart.test.ts` (new, 7 tests on a synthetic fake world + `normalizeSlots`), wired into `package.json` "test".
- `packages/sim/skirmish.ts` (additive): `SkirmishSlot.aiStart?` (default `'none'`), `NormalizedSlot.aiStart`, validation in
  `normalizeSlots` (bad value throws; `aiStart` on a human slot throws), and the hook in `createSkirmish` after the kit and serfs
  exist and before the AI players are built (the attack scenario's order).
- `tools/aistart/cli.ts` (new) and `tools/aistart/expected.ts` (new): the fight timeline and `--check`.

**What `applyRichStart` gives the hand** (the attack scenario's grants, sized by level): a kit of `kitPerWare` axes,
wooden shields and leather armours in the store; one finished barracks on the first spot 4-12 tiles from the store that
`canPlaceHouse` accepts on its entrance, with a road to the store; `recruits` recruits waiting in that barracks; `groups`
full-ish militia groups (`groupSize` each) on a grid 5-14 tiles from the store entrance.

**Levels (tuned numbers).**

| level | groups x militia | start warriors | recruits | kit per ware |
|---|---|---|---|---|
| none | - | 0 | 0 | 0 (today's behaviour, byte-identical) |
| light | 2 x 6 | 12 | 6 | 20 |
| normal | 3 x 9 | 27 | 12 | 40 |
| hard | 5 x 9 | 45 | 18 | 60 |

**Commands and one-line results (final state of this worker).**
- `node tools/aistart/cli.ts --check` -> `AISTART CHECK PASS (3240 ticks, 374 events, human defeated, ai won, equipped 12, attack 2711, killsByAi 4, sha ab6557cf, two runs identical)`; sha `ab6557cfb83733232e00b2e25ef2cfa747b915c799d9a35188efc0b835c54452` (run 1 and run 2).
- `node tools/skirmish/cli.ts --check` -> `SKIRMISH CHECK PASS (3000 ticks, 385 events, 8 commands, 1699 ms)`; sha `925cc8077efde947db92c7ed37016b89e260c0d740e0c96cf42d3004434b2951` (unchanged, so `none` is byte-identical).
- `node --test packages/sim/aistart.test.ts` -> `tests 7, pass 7, fail 0`.
- `npm test` -> `tests 163, pass 162, fail 1` (the one failure is `packages/net/lockstep.test.ts`, R's).
- `npx tsc --noEmit` -> no error in `packages/sim/aistart*`, `packages/sim/skirmish.ts`, `tools/aistart`, `tools/skirmish`; the errors are only in `packages/net` and `tools/nettest` (R's).
- `node tools/aisim/cli.ts --check` -> `AI CHECK FAIL`: the economy, attack and organic numbers moved (econ sha `fae374de...` vs frozen `18e3bcff...`; attack sha `72bf668e...` vs `4f3145e8...`; organic sha `f36f6bb4...` vs `d8f986f5...`). aisim does not import `aistart.ts` or the skirmish hook; the cause is the economy worker's in-progress edits to `economy.ts` (Q4). Not touched here.

**Fight timeline, Battle Sun, hand 0 idle (no command), hand 1 the AI with the level** (ticks; 10 ticks = 1 game second):

| case | first attack request | first combat group | first human house damaged | human's last house lost | human defeated at | AI end |
|---|---|---|---|---|---|---|
| none | - | - | - | - | never (12000 ticks, no attack) | playing |
| light | 2711 | 2728 | 3124 | 3344 | 3348 (5:35) | won |
| normal | 2711 | 2728 | 3124 | 3228 | 3240 (5:24) | won |
| hard | 2711 | 2728 | 3124 | 3195 | 3213 (5:21) | won |

Normal, idle, in detail: kills by the AI 4 (all human serfs/units; human militia 0), equipped 12 by the barracks, AI warriors
39 at the end, the human's one house is its store.

**The attack window (why no size moves the first attack).** The Supervisor attacks only in its window: `DEF_OR_ATT_DIVISION`
= 2700 ticks, the attack slot of team `t` is `10 + t` (`aisupervisor.ts` 41-43), and no attack is allowed before
`(peacetime + 3) x 600` = 1800 ticks (peacetime is the v0 constant 0). Team 1 in a 1v1 therefore first decides at **tick 2711
(4:31)**, and the next decision is at 5411 (9:01), then 8111 (13:31). Every level attacks at 2711. So "the AI attacks a human
base within roughly 6-10 game minutes at normal, sooner at hard" **is not met**: the first attack is 4:31 at every level.
The defensible timing levers are the army's strength and the human's garrison (below), not the level.

**Deterrence (the Supervisor's own rule, measured).** An attack is requested only when `(A - E) / (A + E) > 0.15` over the
warriors A of the AI team and E of the human (`aisupervisor.ts` MIN_ADVANTAGE, `compareAlliances`), i.e. A > 1.35 E. A human
garrison of idle militia therefore deters the AI until the AI outnumbers it. Measured at `normal` (3 x 9, idle garrison, Battle
Sun, 12000 ticks):

| human garrison | first attack | human defeated at | AI warriors at end |
|---|---|---|---|
| 0 | 2711 | 3240 | 39 |
| 9 | 2711 | 3267 | 36 |
| 18 | 2711 | 3348 | 38 |
| 24 | 2711 | 3348 | 38 |
| 30 | 8111 (13:31) | 8667 | 42 |

So a garrison of about 30 militia holds the AI back for two windows (the AI needs ~A > 1.35 x 30 = 41 warriors; it had 27 at
the start and 12 more equipped by then). The margin is near 24 (at 2711 the AI already had some equipped warriors).

**Defended human, scripted (`--defend`, a simple player).** Every 10 ticks, each garrison group attacks the nearest AI
warrior within 14 tiles of the human's store (`groupAttackUnit`, through the command layer). Results (normal, 3 x 9):
garrison 9 -> human defeated at 3321 (kills by the AI 11, by the human 5); garrison 18 -> human defeated at 3402 (kills by the
AI 18, by the human 4). hard + garrison 18 -> defeated at 3321 (earlier run). So a simple defence loses to these armies.
The defence is not tuned; a real player with better micro may do better (not measured).

**Recommendation for the UI (the lead's setup screen).** One dropdown per AI slot: `AI start: none / light / normal / hard`.
Set `aiStart` on the AI slot (`{ hand, kind: 'ai', aiStart: 'normal' }`); the default for the skirmish setup should be
**`normal`** (the owner's goal is a fight; `none` stays the `createSkirmish` default so every existing caller and frozen
check is unchanged). `hard` is the same window with a bigger army (the level changes strength, not timing).

**Simplifications (kept, documented):**
- The rich start is a grant, the way the aisim attack scenario does it: the kit is not produced (no smithy in v0), the
  barracks is placed by the economy's `canPlaceHouse` rule and joined to the store by a road laid directly, the recruits
  are placed in the barracks, and the groups stand on a grid (no map SET_UNIT).
- The attack, deterrence and equip rules are the Supervisor and ArmyManagement v0 rules of 7.5 (no NavMesh, no split).
- The fight is measured in 1v1 (Battle Sun, two slots); the test human has a single store (the map's start), so "an idle
  village" here is one store and a few serfs. Multi-AI and a human who builds are not measured.
- The `--check` sha depends on the economy, which the economy worker is editing: the `none` run to 12000 ticks moved from
  1513 to 1518 events during this work (the 3240-tick check still passed at the final state). Re-freeze when the economy lands.

**Not done / unproven:**
- The brief's "6-10 min at normal, sooner at hard" timing (see the attack window above): not met; the first attack is at
  4:31 at every level. A real delay would need a rule, e.g. the Remake's peace-time option (`peacetimeMinutes`, a v0 constant of
  `ai.ts` 2147 that also shapes the AI's build order); the lead decides. Not changed here.
- Balance against a human who builds a village and defends well (only a simple scripted defence was run).
- The UI is not wired (no dropdown yet); the browser was not used for this record (Node check only).
