// relay.ts — lobby + lockstep relay for kam-web multiplayer (M6, docs/M6-SPIKE.md). It orders and broadcasts
// only: it runs no sim and reads no file. Per game tick it waits for every live human's set (or the late
// deadline), broadcasts the merged commands once (sorted by hand, then arrival), compares the clients' CRC
// checkpoints and stops the match on the first mismatch (game/desync).
// Usage: node apps/server/relay.ts --port 8130 --host 127.0.0.1 [--late-ms 200] [--seed N]
// In-process use: startRelay({ port: 0 }) (the nettest and the relay tests).

import { randomBytes, randomInt } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WsServer } from './ws.ts';
import type { WsConn } from './ws.ts';
import { checkCommand, parseClientMessage } from '../../packages/net/protocol.ts';
import type {
  ClientMessage,
  ErrorCode,
  GameCommand,
  GameCommandsMsg,
  GameCrcMsg,
  LobbyCreateMsg,
  LobbyJoinMsg,
  LobbySlot,
  LobbySlotsMsg,
  LobbyStartMsg,
  RoomInfo,
  RoomState,
  ServerMessage,
} from '../../packages/net/protocol.ts';

const LOBBY_RATE = 50;
const GAME_RATE = 1000;
const MAX_AHEAD = 64;
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export interface RelayOptions {
  host?: string;
  port?: number;
  /** A fixed game seed (tests); omitted = a random uint32 per game. */
  seed?: number;
  /** How long a tick waits for a missing set before it goes on without it (game/late). */
  lateMs?: number;
}

export interface RelayStats {
  startedAt: number;
  messagesIn: number;
  messagesOut: number;
  ticksBroadcast: number;
  lateSets: number;
  rejected: number;
  playerLeft: number;
  desyncs: number;
  gameStartAt: number | null;
  gameEndAt: number | null;
  rooms: number;
}

interface Conn {
  ws: WsConn;
  roomId: string | null;
  rateStart: number;
  rateLobby: number;
  rateGame: number;
}

interface Member {
  conn: Conn;
  hand: number;
  name: string;
  ready: boolean;
  gone: boolean;
  removedAt: number | null;
}

interface Game {
  seed: number;
  delayTicks: number;
  endTick: number;
  crcInterval: number;
  next: number;
  sets: Map<number, Map<number, GameCommand[]>>;
  crcs: Map<number, Map<number, string>>;
  crcPending: Set<number>;
  waitSince: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  over: boolean;
}

interface Room {
  id: string;
  mapId: string;
  mapSha: string;
  definesSha: string;
  phase: 'lobby' | 'playing' | 'ended';
  slots: LobbySlot[];
  members: (Member | null)[];
  hostConn: Conn;
  game: Game | null;
}

function randomId(): string {
  let s = '';
  for (const b of randomBytes(8)) s += ALPHABET[b % ALPHABET.length];
  return s;
}

export class Relay {
  private server: WsServer;
  private rooms = new Map<string, Room>();
  private seed: number | null;
  private lateMs: number;
  private portNumber = 0;
  private startedAt = Date.now();
  private gameStartAt: number | null = null;
  private gameEndAt: number | null = null;
  private counts = { messagesIn: 0, messagesOut: 0, ticksBroadcast: 0, lateSets: 0, rejected: 0, playerLeft: 0, desyncs: 0 };

  constructor(opts: RelayOptions = {}) {
    this.seed = opts.seed ?? null;
    this.lateMs = opts.lateMs ?? 200;
    this.server = new WsServer({ host: opts.host ?? '127.0.0.1', port: opts.port ?? 0 });
    this.server.onconnection = (ws: WsConn) => this.onConnection(ws);
  }

  async start(): Promise<number> {
    this.portNumber = await this.server.start();
    this.startedAt = Date.now();
    return this.portNumber;
  }

  get port(): number {
    return this.portNumber;
  }

  async stop(): Promise<void> {
    for (const room of this.rooms.values()) {
      if (room.game?.timer) clearTimeout(room.game.timer);
    }
    this.rooms.clear();
    await this.server.stop();
  }

  stats(): RelayStats {
    return {
      startedAt: this.startedAt,
      messagesIn: this.counts.messagesIn,
      messagesOut: this.counts.messagesOut,
      ticksBroadcast: this.counts.ticksBroadcast,
      lateSets: this.counts.lateSets,
      rejected: this.counts.rejected,
      playerLeft: this.counts.playerLeft,
      desyncs: this.counts.desyncs,
      gameStartAt: this.gameStartAt,
      gameEndAt: this.gameEndAt,
      rooms: this.rooms.size,
    };
  }

  private onConnection(ws: WsConn): void {
    const conn: Conn = { ws, roomId: null, rateStart: Date.now(), rateLobby: 0, rateGame: 0 };
    ws.onmessage = (text: string) => this.onText(conn, text);
    ws.onclose = () => this.leaveRoom(conn, 'disconnected');
  }

  private onText(conn: Conn, text: string): void {
    this.counts.messagesIn++;
    let msg: ClientMessage;
    try {
      msg = parseClientMessage(text);
    } catch (err) {
      this.error(conn, 'bad-message', err instanceof Error ? err.message : String(err));
      return;
    }
    if (!this.withinRate(conn, msg.kind)) {
      this.error(conn, 'rate-limit', 'too many messages per second on this connection');
      return;
    }
    try {
      this.handle(conn, msg);
    } catch (err) {
      this.error(conn, 'protocol', `internal: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private withinRate(conn: Conn, kind: string): boolean {
    const now = Date.now();
    if (now - conn.rateStart >= 1000) {
      conn.rateStart = now;
      conn.rateLobby = 0;
      conn.rateGame = 0;
    }
    if (kind.startsWith('game/')) return ++conn.rateGame <= GAME_RATE;
    return ++conn.rateLobby <= LOBBY_RATE;
  }

  private handle(conn: Conn, msg: ClientMessage): void {
    switch (msg.kind) {
      case 'lobby/create':
        return this.create(conn, msg);
      case 'lobby/list':
        return this.list(conn);
      case 'lobby/join':
        return this.join(conn, msg);
      case 'lobby/leave':
        return this.leaveRoom(conn, 'left');
      case 'lobby/ready':
        return this.ready(conn, msg.ready);
      case 'lobby/chat':
        return this.chat(conn, msg.text);
      case 'lobby/slots':
        return this.setSlots(conn, msg);
      case 'lobby/start':
        return this.startGame(conn, msg);
      case 'game/commands':
        return this.commands(conn, msg);
      case 'game/crc':
        return this.crc(conn, msg);
    }
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.send(JSON.stringify(msg))) this.counts.messagesOut++;
  }

  private error(conn: Conn, code: ErrorCode, reason: string): void {
    this.send(conn, { kind: 'error', code, reason });
  }

  private roomOf(conn: Conn): Room | null {
    return conn.roomId === null ? null : (this.rooms.get(conn.roomId) ?? null);
  }

  private memberOf(room: Room, conn: Conn): Member | null {
    return room.members.find((m) => m !== null && m.conn === conn) ?? null;
  }

  private connected(room: Room): Member[] {
    return room.members.filter((m): m is Member => m !== null && !m.gone);
  }

  private humanHands(room: Room): number[] {
    return room.slots.filter((s) => s.kind === 'human').map((s) => s.hand);
  }

  private create(conn: Conn, m: LobbyCreateMsg): void {
    if (conn.roomId !== null) return this.error(conn, 'refused', 'you are already in a room');
    let id = randomId();
    while (this.rooms.has(id)) id = randomId();
    const room: Room = {
      id,
      mapId: m.mapId,
      mapSha: m.mapSha,
      definesSha: m.definesSha,
      phase: 'lobby',
      slots: Array.from({ length: m.hands }, (_, h) => ({ hand: h, kind: 'human' as const })),
      members: Array.from({ length: m.hands }, () => null),
      hostConn: conn,
      game: null,
    };
    this.rooms.set(id, room);
    conn.roomId = id;
    room.members[0] = { conn, hand: 0, name: m.name, ready: false, gone: false, removedAt: null };
    this.send(conn, { kind: 'lobby/created', roomId: id, hand: 0 });
    this.broadcastState(room);
  }

  private list(conn: Conn): void {
    const rooms: RoomInfo[] = [...this.rooms.values()].map((r) => ({
      roomId: r.id,
      mapId: r.mapId,
      hands: r.slots.length,
      humans: this.humanHands(r).length,
      players: this.connected(r).length,
      phase: r.phase,
    }));
    this.send(conn, { kind: 'lobby/rooms', rooms });
  }

  private join(conn: Conn, m: LobbyJoinMsg): void {
    if (conn.roomId !== null) return this.error(conn, 'refused', 'you are already in a room');
    const room = this.rooms.get(m.roomId);
    if (room === undefined) return this.error(conn, 'refused', 'no such room');
    if (room.phase === 'playing') return this.error(conn, 'refused', 'the game already started');
    if (room.phase === 'ended') return this.error(conn, 'refused', 'the game has ended');
    if (m.mapSha !== room.mapSha) return this.error(conn, 'refused', 'map differs from the host (sha256 mismatch)');
    if (m.definesSha !== room.definesSha) return this.error(conn, 'refused', 'defines differ from the host (sha256 mismatch)');
    const hand = room.slots.findIndex((s, h) => s.kind === 'human' && room.members[h] === null);
    if (hand < 0) return this.error(conn, 'refused', 'room is full');
    room.members[hand] = { conn, hand, name: m.name, ready: false, gone: false, removedAt: null };
    conn.roomId = room.id;
    this.send(conn, { kind: 'lobby/joined', roomId: room.id, hand });
    this.broadcastState(room);
  }

  private leaveRoom(conn: Conn, reason: string): void {
    const room = this.roomOf(conn);
    if (room === null) return;
    const member = this.memberOf(room, conn);
    conn.roomId = null;
    if (member === null) return;
    if (room.phase === 'lobby') {
      if (conn === room.hostConn) {
        for (const m of this.connected(room)) {
          if (m.conn !== conn) {
            m.conn.roomId = null;
            this.send(m.conn, { kind: 'lobby/closed', reason: 'the host left' });
          }
        }
        room.members.fill(null);
        this.rooms.delete(room.id);
        return;
      }
      room.members[member.hand] = null;
      this.send(conn, { kind: 'lobby/closed', reason: `you ${reason}` });
      this.broadcastState(room);
      return;
    }
    this.send(conn, { kind: 'lobby/closed', reason: `you ${reason}` });
    this.dropFromGame(room, member);
    if (room.members.every((m) => m === null || m.gone)) this.rooms.delete(room.id);
  }

  private ready(conn: Conn, ready: boolean): void {
    const room = this.roomOf(conn);
    if (room === null) return this.error(conn, 'refused', 'you are not in a room');
    if (room.phase !== 'lobby') return this.error(conn, 'refused', 'the game has started');
    const member = this.memberOf(room, conn);
    if (member === null) return this.error(conn, 'refused', 'you are not in a room');
    member.ready = ready;
    this.broadcastState(room);
  }

  private chat(conn: Conn, text: string): void {
    const room = this.roomOf(conn);
    if (room === null) return this.error(conn, 'refused', 'you are not in a room');
    const member = this.memberOf(room, conn);
    if (member === null) return this.error(conn, 'refused', 'you are not in a room');
    for (const m of this.connected(room)) this.send(m.conn, { kind: 'lobby/chat', hand: member.hand, name: member.name, text });
  }

  private setSlots(conn: Conn, msg: LobbySlotsMsg): void {
    const room = this.roomOf(conn);
    if (room === null || conn !== room.hostConn) return this.error(conn, 'not-allowed', 'only the host sets the slots');
    if (room.phase !== 'lobby') return this.error(conn, 'refused', 'the game has started');
    if (msg.slots.length !== room.slots.length) return this.error(conn, 'refused', `slots must list all ${room.slots.length} hands`);
    for (let h = 0; h < msg.slots.length; h++) {
      const s = msg.slots[h];
      if (s.hand !== h) return this.error(conn, 'refused', `slot ${h} has hand ${s.hand}`);
      if (h === 0 && s.kind !== 'human') return this.error(conn, 'refused', 'hand 0 is the host and stays human');
      if (s.kind === 'ai' && room.members[h] !== null) return this.error(conn, 'refused', `hand ${h} has a player`);
    }
    room.slots = msg.slots.map((s) => (s.kind === 'ai' ? { hand: s.hand, kind: 'ai' as const, aiLevel: s.aiLevel } : { hand: s.hand, kind: 'human' as const }));
    this.broadcastState(room);
  }

  private startGame(conn: Conn, msg: LobbyStartMsg): void {
    const room = this.roomOf(conn);
    if (room === null || conn !== room.hostConn) return this.error(conn, 'not-allowed', 'only the host starts the game');
    if (room.phase !== 'lobby') return this.error(conn, 'refused', 'the game has started');
    for (const h of this.humanHands(room)) {
      const m = room.members[h];
      if (m === null) return this.error(conn, 'refused', `hand ${h} has no player`);
      if (!m.ready) return this.error(conn, 'refused', `${m.name} (hand ${h}) is not ready`);
    }
    const seed = this.seed ?? randomInt(0, 4294967296);
    const game: Game = {
      seed,
      delayTicks: msg.delayTicks,
      endTick: msg.endTick,
      crcInterval: msg.crcInterval,
      next: 1,
      sets: new Map(),
      crcs: new Map(),
      crcPending: new Set(),
      waitSince: null,
      timer: null,
      over: false,
    };
    room.game = game;
    room.phase = 'playing';
    this.gameStartAt = Date.now();
    for (const m of this.connected(room)) {
      this.send(m.conn, {
        kind: 'game/start',
        seed,
        mapId: room.mapId,
        mapSha: room.mapSha,
        definesSha: room.definesSha,
        delayTicks: game.delayTicks,
        endTick: game.endTick,
        crcInterval: game.crcInterval,
        slots: room.slots,
        yourHand: m.hand,
      });
    }
    this.broadcastState(room);
    this.tryBroadcast(room);
  }

  private commands(conn: Conn, msg: GameCommandsMsg): void {
    const room = this.roomOf(conn);
    const member = room === null ? null : this.memberOf(room, conn);
    if (room === null || member === null || room.game === null || room.phase !== 'playing') {
      return this.error(conn, 'refused', 'no game is running for you');
    }
    const game = room.game;
    const tick = msg.tick;
    if (tick > game.endTick) return this.reject(conn, tick, member.hand, 'the tick is past the end of the game');
    if (tick < game.next) {
      this.counts.lateSets++;
      this.send(conn, { kind: 'game/late', tick });
      return;
    }
    if (tick > game.next + MAX_AHEAD) return this.reject(conn, tick, member.hand, 'the set is too far ahead');
    let sets = game.sets.get(tick);
    if (sets === undefined) {
      sets = new Map();
      game.sets.set(tick, sets);
    }
    if (sets.has(member.hand)) return this.reject(conn, tick, member.hand, 'duplicate set for this tick');
    const accepted: GameCommand[] = [];
    for (const raw of msg.commands) {
      const c = checkCommand(raw);
      if (!c.ok) {
        this.reject(conn, tick, member.hand, c.reason);
        continue;
      }
      if (c.cmd.hand !== member.hand) {
        this.reject(conn, tick, member.hand, `command is for hand ${c.cmd.hand}, you are hand ${member.hand}`);
        continue;
      }
      if (c.cmd.tick !== tick) {
        this.reject(conn, tick, member.hand, `command is for tick ${c.cmd.tick}, the set is for tick ${tick}`);
        continue;
      }
      accepted.push(c.cmd);
    }
    sets.set(member.hand, accepted);
    this.tryBroadcast(room);
  }

  private crc(conn: Conn, msg: GameCrcMsg): void {
    const room = this.roomOf(conn);
    const member = room === null ? null : this.memberOf(room, conn);
    if (room === null || member === null || room.game === null || room.phase !== 'playing') {
      return this.error(conn, 'refused', 'no game is running for you');
    }
    const game = room.game;
    if (msg.tick >= game.next || msg.tick % game.crcInterval !== 0) {
      return this.reject(conn, msg.tick, member.hand, 'crc for a tick that is not a checkpoint already run');
    }
    let reports = game.crcs.get(msg.tick);
    if (reports === undefined) {
      reports = new Map();
      game.crcs.set(msg.tick, reports);
    }
    if (!reports.has(member.hand)) reports.set(member.hand, msg.value);
    this.checkCrc(room, msg.tick);
  }

  private reject(conn: Conn, tick: number, hand: number, reason: string): void {
    this.counts.rejected++;
    this.send(conn, { kind: 'game/rejected', tick, hand, reason });
  }

  private activeAt(room: Room, hand: number, tick: number): boolean {
    const m = room.members[hand];
    return m !== null && (m.removedAt === null || m.removedAt > tick);
  }

  /** Broadcasts every tick whose sets are complete, or whose late deadline has passed. */
  private tryBroadcast(room: Room): void {
    const game = room.game;
    if (game === null || game.over || room.phase !== 'playing') return;
    while (game.next <= game.endTick) {
      const t = game.next;
      const expected = this.humanHands(room).filter((h) => this.activeAt(room, h, t));
      if (expected.length === 0) {
        this.finish(room, game.next - 1);
        return;
      }
      const sets = game.sets.get(t) ?? new Map<number, GameCommand[]>();
      const missing = expected.filter((h) => !sets.has(h));
      if (missing.length > 0) {
        const now = Date.now();
        if (game.waitSince === null) game.waitSince = now;
        const left = this.lateMs - (now - game.waitSince);
        if (left > 0) {
          if (game.timer === null) {
            game.timer = setTimeout(() => {
              game.timer = null;
              this.tryBroadcast(room);
            }, left);
            game.timer.unref?.();
          }
          return;
        }
      }
      for (const h of missing) {
        const m = room.members[h];
        if (m !== null && !m.gone) this.send(m.conn, { kind: 'game/late', tick: t });
        this.counts.lateSets++;
      }
      const commands: GameCommand[] = [];
      for (const h of [...sets.keys()].sort((a, b) => a - b)) commands.push(...(sets.get(h) ?? []));
      for (const m of this.connected(room)) this.send(m.conn, { kind: 'game/tick', tick: t, commands });
      this.counts.ticksBroadcast++;
      game.sets.delete(t);
      game.next = t + 1;
      game.waitSince = null;
      if (game.timer !== null) {
        clearTimeout(game.timer);
        game.timer = null;
      }
      if (t % game.crcInterval === 0) game.crcPending.add(t);
    }
    this.maybeFinish(room);
  }

  private checkCrc(room: Room, tick: number): void {
    const game = room.game;
    if (game === null || game.over) return;
    const reports = game.crcs.get(tick) ?? new Map<number, string>();
    const expected = this.humanHands(room).filter((h) => {
      const m = room.members[h];
      return m !== null && !m.gone && this.activeAt(room, h, tick);
    });
    if (!expected.every((h) => reports.has(h))) return;
    game.crcs.delete(tick);
    game.crcPending.delete(tick);
    const values = new Set(reports.values());
    if (values.size > 1) {
      this.counts.desyncs++;
      const byHand: Record<string, string> = {};
      for (const [h, v] of reports) byHand[String(h)] = v;
      for (const m of this.connected(room)) this.send(m.conn, { kind: 'game/desync', tick, values: byHand });
      game.over = true;
      if (game.timer !== null) clearTimeout(game.timer);
      game.timer = null;
      room.phase = 'ended';
      this.gameEndAt = Date.now();
      return;
    }
    this.maybeFinish(room);
  }

  private maybeFinish(room: Room): void {
    const game = room.game;
    if (game === null || game.over) return;
    if (game.next > game.endTick && game.crcPending.size === 0) this.finish(room, game.endTick);
  }

  private finish(room: Room, tick: number): void {
    const game = room.game;
    if (game === null || game.over) return;
    game.over = true;
    if (game.timer !== null) clearTimeout(game.timer);
    game.timer = null;
    room.phase = 'ended';
    this.gameEndAt = Date.now();
    for (const m of this.connected(room)) this.send(m.conn, { kind: 'game/end', tick });
  }

  /** A player left a running game: the hand stops at tick next + 2 (in-flight sets), the others go on. */
  private dropFromGame(room: Room, member: Member): void {
    member.gone = true;
    const game = room.game;
    if (game === null || room.phase !== 'playing') return;
    member.removedAt = game.next + 2;
    this.counts.playerLeft++;
    for (const m of this.connected(room)) this.send(m.conn, { kind: 'game/playerLeft', hand: member.hand, atTick: member.removedAt });
    if (this.connected(room).length === 0) {
      game.over = true;
      if (game.timer !== null) clearTimeout(game.timer);
      game.timer = null;
      room.phase = 'ended';
      this.gameEndAt = Date.now();
      return;
    }
    for (const t of [...game.crcPending]) this.checkCrc(room, t);
    this.tryBroadcast(room);
  }

  private broadcastState(room: Room): void {
    const state: RoomState = {
      roomId: room.id,
      mapId: room.mapId,
      mapSha: room.mapSha,
      definesSha: room.definesSha,
      phase: room.phase,
      slots: room.slots,
      players: this.connected(room).map((m) => ({ hand: m.hand, name: m.name, ready: m.ready })),
    };
    for (const m of this.connected(room)) this.send(m.conn, { kind: 'lobby/state', room: state });
  }
}

export async function startRelay(opts: RelayOptions = {}): Promise<Relay> {
  const relay = new Relay(opts);
  await relay.start();
  return relay;
}

function argValue(args: string[], name: string): string | null {
  const at = args.indexOf(name);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const port = Number(argValue(args, '--port') ?? 8130);
  const host = argValue(args, '--host') ?? '127.0.0.1';
  const lateMs = Number(argValue(args, '--late-ms') ?? 200);
  const seedArg = argValue(args, '--seed');
  const relay = new Relay({ host, port, lateMs, seed: seedArg === null ? undefined : Number(seedArg) });
  const bound = await relay.start();
  console.log(`relay listening on ws://${host}:${bound} (late deadline ${lateMs} ms)`);
  process.on('SIGINT', () => {
    relay.stop().then(() => process.exit(0));
  });
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`relay: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
