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

(Workers fill their part: commands + files, one-line results, shas, simplifications; the lead adds
the independent re-run.)
