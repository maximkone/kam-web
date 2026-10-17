# M6 spike - multiplayer (relay + lobby + lockstep)

## 1. Transport: WebSocket (RFC 6455), JSON text frames
- Server: Node.js with `node:http` upgrade + minimal frame codec
  - Handshake with Sec-WebSocket-Accept
  - Masked client frames (unmask on server)
  - Text frames only (opcode 0x1)
  - Ping/pong (opcodes 0x9/0xA)
  - Close frame (opcode 0x8)
  - Max payload: 64 KB, reject larger with close code 1009
- Clients:
  - Browser: native WebSocket
  - Node 24: global WebSocket (used by tests)
- Zero dependencies: only Node.js built-ins

## 2. Lobby: rooms with create / list / join / leave / ready / chat
- Room state:
  - id: string (server-generated, short)
  - mapId: string (filename without extension)
  - slots: array of { hand, kind, aiLevel?, team?, color? }
  - chat: array of { hand, text }
- Operations:
  - create: host creates room, becomes hand 0
  - list: get all rooms with basic info (id, mapId, slot count)
  - join: player joins room as next available hand
  - leave: player leaves room (host leaving disbands room)
  - ready: toggle ready state (only for human hands)
  - chat: send text message to all in room
- Host privileges:
  - Pick mapId
  - Assign slots (hand, kind, aiLevel, team, color)
  - Start game when all humans are ready
- Validation:
  - Join verifies joiner's map file sha256 equals host's
  - Join verifies joiner's defines sha256 equals host's
  - Refuse with clear reason string if validation fails

## 3. Start: server sends `start {seed, mapId, slots, mapSha, delayTicks}`
- Server generates seed (uint32)
- mapId: from lobby state
- slots: from lobby state (normalized by hand)
- mapSha: sha256 of the .map file
- delayTicks: configurable, default 4 (can be overridden in lobby)
- Every client:
  - Verifies mapSha matches their local .map
  - Verifies defines (tiles.json, mapelem.dat, unit.dat, houses.dat) match host
  - Builds identical `createSkirmish` inputs
  - Initializes lockstep engine with delayTicks

## 4. Lockstep: clients send commands stamped for tick `T + delayTicks`
- Command format: `{ hand, tick, type, ...args }` (same as skirmish.ts)
- Per tick:
  - Each human player sends their commands for tick `T + delayTicks`
  - Server collects commands per tick from all human players
  - For each tick k, server broadcasts `tick {k, cmds:[...]}` once:
    - Every live player has sent its set for k, OR
    - Per-tick deadline passed (200ms default)
  - Canonical order: sort by hand, then by arrival index within hand
  - Late player's commands for tick k are rejected and reported to that player
- Clients:
  - Execute `step(sk, cmds)` ONLY with what server broadcast
  - Process ticks in order, never ahead of server
  - Game speed: server-clocked (10 ticks/s at 1x)
  - Host may pause; clients never run faster than server's tick messages

## 5. Desync detection: every N ticks (default 50) each client sends `crc {tick, value}`
- CRC: reuse sha256 state hashing function from tools/skirmish/cli.ts
  - If not cheap enough, use CRC32 over compact state summary
  - Compact state: houses (uid, typeId, owner, x, y, buildState, destroyed, wareIn, wareOut),
    units (uid, owner, type, posF.x, posF.y, action, taskKind, hitPoints, groupUid, fightState, dead, inside, homeUid),
    groups (uid, owner, memberUids, order, orderX, orderY, targetUid, targetHouseUid, unitsPerRow),
    projectiles (uid, fromX, fromY, toX, toY, targetUid)
- Server:
  - Compares CRC values from all clients
  - On mismatch: broadcasts `desync {tick, per-player values}` and stops match
  - Reports first tick where mismatch occurred
- Resync: OUT OF SCOPE (report clearly and stop)

## 6. Leave/disconnect: dropped or leaving player removed deterministically
- Detection:
  - Socket close/error
  - No ping response for 3 seconds
- Removal:
  - Server broadcasts `playerLeft {hand, atTick}` 
  - atTick: current server tick + 2 (allows in-flight messages)
  - Deterministic rule: hand stops sending commands, treated as eliminated at atTick
  - Simple implementation: removed hand's units/houses become neutral/gaia
- Clients:
  - Apply same rule at atTick: ignore future commands from that hand
  - Continue simulation deterministically

## 7. Security basics
- Validate every incoming message:
  - JSON parsing
  - Required fields present
  - Field types correct
  - Value ranges valid
  - Size limits (max 64 KB WebSocket frame)
- Per-connection rate limit: max 50 messages/second
- Player can only send commands for its own hand(s)
- Room/player IDs: server-generated (opaque strings)
- No path/file access from messages

## 8. Files to create
- `packages/net/protocol.ts`: message types, validators (pure)
- `packages/net/lockstep.ts`: pure client-side lockstep engine
  - Feed server messages → yield ordered steps + crc reports
  - Fully unit-testable without sockets
- `packages/net/client.ts`: browser-safe client over global WebSocket
  - Lobby calls + lockstep wiring
  - No node: imports (browser-safe)
- `apps/server/ws.ts`: minimal WebSocket server
- `apps/server/relay.ts`: lobby + lockstep relay
  - `node apps/server/relay.ts --port 8130 --host 127.0.0.1`
- `tools/nettest/cli.ts`: with `--check` mode
- Tests: `packages/net/*.test.ts` wired into package.json "test"

## 9. Additive edits only
- `packages/sim/commands.ts`: 
  - Add validation for new command types if needed (none planned)
- `packages/sim/skirmish.ts`:
  - Export `skirmishStateHash` function for CRC calculation
  - Add optional seed input to `createEconomyWorld` (for deterministic resync testing)
- `package.json`: add test files to "test" script

## 10. Acceptance criteria for `node tools/nettest/cli.ts --check`
Must print `NET CHECK PASS` after:
1. Relay starts in-process on random localhost port
2. Two Node clients join one room (frozen scenario: MapsMP/Battle Sun, 2 human slots)
3. Each sends scripted commands
4. Run 3000 ticks over real sockets with injected random latency/jitter
5. Both clients end with identical state sha
6. Identical sha equals single-process reference run (replaying server's tick log)
7. DESYNC INJECTION: flip state in one client → server detects at next crc → reports first bad tick
8. DISCONNECT: one client closes socket → other keeps running deterministically to end
9. LOBBY TESTS:
   - Joiner with different map sha → refused with reason
   - Client sending commands for another player's hand → rejected
   - Oversized/malformed frame → rejected without crashing server
10. LOAD NOTE: print messages/sec and ms/tick of relay for two-player run
Everything deterministic given seeds: run check twice → print both shas

## 11. Usage (what exists now)
- Relay (lobby + lockstep orderer, runs no sim, reads no file):
  - `node apps/server/relay.ts --port 8130 --host 127.0.0.1 [--late-ms 200] [--seed N]`
  - In-process: `startRelay({ port: 0 })` from `apps/server/relay.ts` (the nettest and the relay tests use it)
- Client (browser-safe, global WebSocket):
  - `packages/net/client.ts`: `NetClient` (lobby calls, lockstep loop). Hooks: `createSkirmish(start)` (the caller loads its own map and defines), optional `script(sk, tick)` and `beforeStep(sk, tick)`.
  - `packages/net/browserclient.ts`: `openRelay(url, hooks)`, `sha256Hex`, `definesSha` (crypto.subtle). Not wired into apps/web yet.
  - `packages/net/lockstep.ts`: `Lockstep`, the pure engine (no sockets, no sim).
  - `packages/net/statehash.ts`: `canonicalState(sk)` and `stateCrc(sk)` (CRC32 of the canonical state, 8 hex).
- Checks:
  - `node --test packages/net/*.test.ts` (protocol, lockstep, client over a fake socket, relay over real sockets)
  - `node tools/nettest/cli.ts --check` (the full check, see below)
  - `node tools/nettest/cli.ts --break` (client B corrupts one command in its local copy, the first command with an x coordinate, x+1; CRC32 is checked every tick; prints `DESYNC at tick T` with the first CRC mismatch, then `NET CHECK FAIL` and exits 1 by design)
- Browser usage (`packages/net/browserclient.ts`, not wired into apps/web yet):
  ```ts
  import { openRelay, sha256Hex, definesSha } from './packages/net/browserclient.ts';
  const client = await openRelay('ws://127.0.0.1:8130', {
    createSkirmish: (start) => buildLocalSkirmish(start), // the caller loads and checks its own map and defines
    script: (sk, tick) => [], // this client's commands for a set of tick `tick`, from its own state
  });
  client.onMessage = (msg) => console.log(msg.kind);
  client.send({ kind: 'lobby/create', mapId: 'MapsMP/Battle Sun', mapSha, definesSha: dsha, hands: 2, name: 'me' });
  // on 'game/start' the NetClient builds the skirmish, runs the lockstep and reports 'game/end' through onFinished
  ```
- Protocol, one JSON object per text frame: `packages/net/protocol.ts` (`parseClientMessage`, `parseServerMessage`, `checkCommand`).

## 12. Record (M6 partial, as of the 2026-10-17 session)
- Exists:
  - WebSocket transport on node:http (`apps/server/ws.ts`): handshake, masked frames, ping every 1 s, idle close after 3 s, 64 KB frame limit (close 1009).
  - Relay (`apps/server/relay.ts`): rooms (create, list, join with map and defines sha check, leave, ready, chat, host slots, start with a server seed), lockstep ordering (sets per tick, merged in hand order, late deadline 200 ms, game/late and game/rejected), CRC checkpoints (game/desync stops the match), player left (game/playerLeft, the hand stops at next + 2), per-connection rate limit (50 lobby and 1000 game messages per second).
  - Lockstep engine and client (`packages/net/lockstep.ts`, `client.ts`, `browserclient.ts`).
  - Nettest (`tools/nettest/cli.ts`): the real sim on both clients, a single-process reference, the lobby battery, the disconnect run, and `--break`.
- Commands: see section 11.
- Measured (the lead re-runs these; numbers from the 2026-10-17 session):
  - `node tools/nettest/cli.ts --check` (two runs, MapsMP/Battle Sun, 3000 ticks, delay 4, CRC every 50, 0-20 ms jitter per client send, 2 humans): both runs `NET CHECK PASS (2 clients, 3000 ticks, 16 commands, hash 457b6316, identical)`; run 1 relay 779 msgs/s and 5.20 ms/tick (6127 in, 6018 out, wall 15.6 s), run 2 794 msgs/s and 5.10 ms/tick (wall 15.3 s); the lobby battery and the disconnect run pass; whole check about 35 s.
  - Same match with CRC every tick and no corruption (throwaway copy, not committed): PASS, 1183 msgs/s, 5.08 ms/tick.
  - `node tools/nettest/cli.ts --break`: DESYNC with the corrupted copy at tick 5 on client B; the first CRC mismatch is reported at tick 5 (lead re-run 2026-10-17: `NET DESYNC first bad tick 5`, `NET CHECK FAIL: DESYNC at tick 5`); exit 1 by design.
  - `node --test packages/net/*.test.ts`: 34 pass, 0 fail. `node --test packages/sim/*.test.ts`: 131 pass, 0 fail. `node tools/skirmish/cli.ts --check`: SKIRMISH CHECK PASS. `npx tsc --noEmit`: no errors.
- Not done:
  - Lobby UI in apps/web (browserclient.ts is not wired in; apps/web was not touched).
  - Rejoin after a drop (a dropped hand stays out for the rest of the match).
  - Spectators.
  - Resync (out of scope, the match stops at the first desync).
  - Server-clocked speed (10 ticks per second at 1x, pause): the relay broadcasts a tick as soon as its sets are in, so the match runs as fast as the slowest client.
  - Neutral conversion of a dropped hand (its units stay as they are).
  - AI-controlled slots over the wire (the relay accepts `ai` slots, the nettest uses humans only).
  - Team and colour slot fields (accepted by the protocol, unused).
- Deviations from section 4-6 above: the rate limit is 1000 game messages per second per connection (a 50/s cap would throttle the lockstep sets); the CRC is CRC32 of the canonical state string (not sha256; the nettest prints the sha256 of the same string).