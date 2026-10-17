// protocol.ts — message types and validators for kam-web multiplayer (M6, docs/M6-SPIKE.md).
// Pure: no node: imports, browser-safe. One WebSocket text frame = one JSON message { kind, ...fields }.
// The relay parses every client frame with parseClientMessage and every client parses the relay's
// frames with parseServerMessage; a malformed frame is a ProtocolError and is never acted on.
// Commands are checked one by one with checkCommand, which also strips unknown fields.

import type { Command, CommandType } from '../sim/commands.ts';

export type GameCommand = Command;
export type SlotKind = 'human' | 'ai';
export type RoomPhase = 'lobby' | 'playing' | 'ended';
export type ErrorCode = 'bad-message' | 'refused' | 'rate-limit' | 'not-allowed' | 'protocol';

export const MAX_HANDS = 8;
export const MAX_COMMANDS_PER_SET = 64;
export const MAX_NAME = 32;
export const MAX_CHAT = 200;
export const MAX_DELAY_TICKS = 16;
export const MAX_END_TICK = 100000;
const INT_LIMIT = 2147483647;

export interface LobbySlot {
  hand: number;
  kind: SlotKind;
  aiLevel?: 'advanced';
}

export interface LobbyPlayer {
  hand: number;
  name: string;
  ready: boolean;
}

export interface RoomState {
  roomId: string;
  mapId: string;
  mapSha: string;
  definesSha: string;
  phase: RoomPhase;
  slots: LobbySlot[];
  players: LobbyPlayer[];
}

export interface RoomInfo {
  roomId: string;
  mapId: string;
  hands: number;
  humans: number;
  players: number;
  phase: RoomPhase;
}

// client -> server
export interface LobbyCreateMsg { kind: 'lobby/create'; mapId: string; mapSha: string; definesSha: string; hands: number; name: string }
export interface LobbyListMsg { kind: 'lobby/list' }
export interface LobbyJoinMsg { kind: 'lobby/join'; roomId: string; mapSha: string; definesSha: string; name: string }
export interface LobbyLeaveMsg { kind: 'lobby/leave' }
export interface LobbyReadyMsg { kind: 'lobby/ready'; ready: boolean }
export interface LobbyChatMsg { kind: 'lobby/chat'; text: string }
export interface LobbySlotsMsg { kind: 'lobby/slots'; slots: LobbySlot[] }
export interface LobbyStartMsg { kind: 'lobby/start'; delayTicks: number; endTick: number; crcInterval: number }
export interface GameCommandsMsg { kind: 'game/commands'; tick: number; commands: unknown[] }
export interface GameCrcMsg { kind: 'game/crc'; tick: number; value: string }

export type ClientMessage =
  | LobbyCreateMsg
  | LobbyListMsg
  | LobbyJoinMsg
  | LobbyLeaveMsg
  | LobbyReadyMsg
  | LobbyChatMsg
  | LobbySlotsMsg
  | LobbyStartMsg
  | GameCommandsMsg
  | GameCrcMsg;

// server -> client
export interface LobbyCreatedMsg { kind: 'lobby/created'; roomId: string; hand: number }
export interface LobbyJoinedMsg { kind: 'lobby/joined'; roomId: string; hand: number }
export interface LobbyRoomsMsg { kind: 'lobby/rooms'; rooms: RoomInfo[] }
export interface LobbyStateMsg { kind: 'lobby/state'; room: RoomState }
export interface LobbyChatOutMsg { kind: 'lobby/chat'; hand: number; name: string; text: string }
export interface LobbyClosedMsg { kind: 'lobby/closed'; reason: string }
export interface GameStartMsg {
  kind: 'game/start';
  seed: number;
  mapId: string;
  mapSha: string;
  definesSha: string;
  delayTicks: number;
  endTick: number;
  crcInterval: number;
  slots: LobbySlot[];
  yourHand: number;
}
export interface GameTickMsg { kind: 'game/tick'; tick: number; commands: GameCommand[] }
export interface GameRejectedMsg { kind: 'game/rejected'; tick: number; hand: number; reason: string }
export interface GameLateMsg { kind: 'game/late'; tick: number }
export interface GamePlayerLeftMsg { kind: 'game/playerLeft'; hand: number; atTick: number }
export interface GameDesyncMsg { kind: 'game/desync'; tick: number; values: Record<string, string> }
export interface GameEndMsg { kind: 'game/end'; tick: number }
export interface ErrorMsg { kind: 'error'; code: ErrorCode; reason: string }

export type ServerMessage =
  | LobbyCreatedMsg
  | LobbyJoinedMsg
  | LobbyRoomsMsg
  | LobbyStateMsg
  | LobbyChatOutMsg
  | LobbyClosedMsg
  | GameStartMsg
  | GameTickMsg
  | GameRejectedMsg
  | GameLateMsg
  | GamePlayerLeftMsg
  | GameDesyncMsg
  | GameEndMsg
  | ErrorMsg;

export class ProtocolError extends Error {}

type FieldKind = 'int' | 'bool' | 'fieldKind' | 'deliveryMode' | 'path';
type Shape = Record<string, FieldKind>;

// One entry per sim command type (commands.ts). A field missing here is dropped by checkCommand.
const SHAPES: Record<CommandType, Shape> = {
  housePlan: { typeId: 'int', x: 'int', y: 'int' },
  houseRemovePlan: { x: 'int', y: 'int' },
  roadPlan: { x: 'int', y: 'int' },
  roadPlanLine: { path: 'path' },
  fieldPlan: { x: 'int', y: 'int', kind: 'fieldKind' },
  planRemove: { x: 'int', y: 'int' },
  houseTrain: { houseUid: 'int', unitType: 'int', count: 'int' },
  houseEquip: { houseUid: 'int', soldierType: 'int', count: 'int' },
  houseDeliveryMode: { houseUid: 'int', mode: 'deliveryMode' },
  houseWareDemand: { houseUid: 'int', ware: 'int', delta: 'int' },
  houseRepair: { houseUid: 'int', on: 'bool' },
  houseDestroy: { houseUid: 'int' },
  groupWalk: { groupUid: 'int', x: 'int', y: 'int', dir: 'int' },
  groupAttackUnit: { groupUid: 'int', targetUid: 'int' },
  groupAttackHouse: { groupUid: 'int', houseUid: 'int' },
  groupHalt: { groupUid: 'int' },
  groupFormation: { groupUid: 'int', unitsPerRow: 'int' },
};

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}

function isStr(v: unknown, min: number, max: number): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max;
}

export function isSha256Hex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
}

/** A map id is "<folder>/<name>" (for example "MapsMP/Battle Sun"): it names a file the client looks up, never a path. */
export function isMapId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 120 && /^[A-Za-z][A-Za-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(v);
}

export function isRoomId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9]{1,16}$/.test(v);
}

function isSlot(v: unknown): v is LobbySlot {
  return (
    isObj(v) &&
    isInt(v.hand, 0, MAX_HANDS - 1) &&
    (v.kind === 'human' || v.kind === 'ai') &&
    (v.aiLevel === undefined || v.aiLevel === 'advanced')
  );
}

function isSlots(v: unknown): v is LobbySlot[] {
  return Array.isArray(v) && v.length >= 1 && v.length <= MAX_HANDS && v.every(isSlot);
}

function fail(reason: string): never {
  throw new ProtocolError(reason);
}

function parseObject(text: string): Record<string, unknown> {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    fail('message is not valid JSON');
  }
  if (!isObj(obj)) fail('message must be a JSON object');
  if (typeof obj.kind !== 'string') fail('message needs a string kind');
  return obj;
}

/** Parses and validates one client frame. Throws ProtocolError with a reason. */
export function parseClientMessage(text: string): ClientMessage {
  const o = parseObject(text);
  switch (o.kind) {
    case 'lobby/create':
      if (!isMapId(o.mapId)) fail('lobby/create: mapId must be "<folder>/<name>"');
      if (!isSha256Hex(o.mapSha) || !isSha256Hex(o.definesSha)) fail('lobby/create: mapSha and definesSha must be 64 hex characters');
      if (!isInt(o.hands, 2, MAX_HANDS)) fail(`lobby/create: hands must be 2..${MAX_HANDS}`);
      if (!isStr(o.name, 1, MAX_NAME)) fail(`lobby/create: name must be 1..${MAX_NAME} characters`);
      return o as unknown as LobbyCreateMsg;
    case 'lobby/list':
      return o as unknown as LobbyListMsg;
    case 'lobby/join':
      if (!isRoomId(o.roomId)) fail('lobby/join: roomId is not a room id');
      if (!isSha256Hex(o.mapSha) || !isSha256Hex(o.definesSha)) fail('lobby/join: mapSha and definesSha must be 64 hex characters');
      if (!isStr(o.name, 1, MAX_NAME)) fail(`lobby/join: name must be 1..${MAX_NAME} characters`);
      return o as unknown as LobbyJoinMsg;
    case 'lobby/leave':
      return o as unknown as LobbyLeaveMsg;
    case 'lobby/ready':
      if (typeof o.ready !== 'boolean') fail('lobby/ready: ready must be true or false');
      return o as unknown as LobbyReadyMsg;
    case 'lobby/chat':
      if (!isStr(o.text, 1, MAX_CHAT)) fail(`lobby/chat: text must be 1..${MAX_CHAT} characters`);
      return o as unknown as LobbyChatMsg;
    case 'lobby/slots':
      if (!isSlots(o.slots)) fail('lobby/slots: slots must be 1..8 entries of { hand, kind, aiLevel? }');
      return o as unknown as LobbySlotsMsg;
    case 'lobby/start':
      if (!isInt(o.delayTicks, 1, MAX_DELAY_TICKS)) fail(`lobby/start: delayTicks must be 1..${MAX_DELAY_TICKS}`);
      if (!isInt(o.endTick, 1, MAX_END_TICK)) fail(`lobby/start: endTick must be 1..${MAX_END_TICK}`);
      if (!isInt(o.crcInterval, 1, 1000)) fail('lobby/start: crcInterval must be 1..1000');
      return o as unknown as LobbyStartMsg;
    case 'game/commands':
      if (!isInt(o.tick, 1, INT_LIMIT)) fail('game/commands: tick must be a positive integer');
      if (!Array.isArray(o.commands) || o.commands.length > MAX_COMMANDS_PER_SET) fail(`game/commands: commands must be an array of at most ${MAX_COMMANDS_PER_SET}`);
      return o as unknown as GameCommandsMsg;
    case 'game/crc':
      if (!isInt(o.tick, 1, INT_LIMIT)) fail('game/crc: tick must be a positive integer');
      if (typeof o.value !== 'string' || !/^[0-9a-f]{8,64}$/.test(o.value)) fail('game/crc: value must be 8..64 hex characters');
      return o as unknown as GameCrcMsg;
    default:
      fail(`unknown message kind ${String(o.kind)}`);
  }
}

export type CommandCheck = { ok: true; cmd: GameCommand } | { ok: false; reason: string };

function isPath(v: unknown): v is { x: number; y: number }[] {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= MAX_COMMANDS_PER_SET &&
    v.every((p) => isObj(p) && isInt(p.x, -INT_LIMIT, INT_LIMIT) && isInt(p.y, -INT_LIMIT, INT_LIMIT))
  );
}

/** Checks one command against its shape and returns a clean copy (only the known fields). */
export function checkCommand(raw: unknown): CommandCheck {
  if (!isObj(raw)) return { ok: false, reason: 'command is not an object' };
  if (!isInt(raw.hand, 0, MAX_HANDS - 1)) return { ok: false, reason: `command hand must be 0..${MAX_HANDS - 1}` };
  if (!isInt(raw.tick, 1, INT_LIMIT)) return { ok: false, reason: 'command tick must be a positive integer' };
  const type = raw.type;
  if (typeof type !== 'string' || !Object.hasOwn(SHAPES, type)) return { ok: false, reason: `unknown command type ${String(type)}` };
  const out: Record<string, unknown> = { hand: raw.hand, tick: raw.tick, type };
  for (const [field, kind] of Object.entries(SHAPES[type as CommandType])) {
    const v = raw[field];
    let ok: boolean;
    switch (kind) {
      case 'int':
        ok = isInt(v, -INT_LIMIT, INT_LIMIT);
        break;
      case 'bool':
        ok = typeof v === 'boolean';
        break;
      case 'fieldKind':
        ok = v === 'corn' || v === 'wine';
        break;
      case 'deliveryMode':
        ok = v === 'delivery' || v === 'takeOut' || v === 'closed';
        break;
      case 'path':
        ok = isPath(v);
        break;
    }
    if (!ok!) return { ok: false, reason: `${type}.${field} has the wrong type or value` };
    out[field] = kind === 'path' ? (v as { x: number; y: number }[]).map((p) => ({ x: p.x, y: p.y })) : v;
  }
  return { ok: true, cmd: out as unknown as GameCommand };
}

/** Parses and validates one server frame (the client side). Throws ProtocolError with a reason. */
export function parseServerMessage(text: string): ServerMessage {
  const o = parseObject(text);
  switch (o.kind) {
    case 'lobby/created':
      if (!isRoomId(o.roomId) || !isInt(o.hand, 0, MAX_HANDS - 1)) fail('lobby/created: bad fields');
      return o as unknown as LobbyCreatedMsg;
    case 'lobby/joined':
      if (!isRoomId(o.roomId) || !isInt(o.hand, 0, MAX_HANDS - 1)) fail('lobby/joined: bad fields');
      return o as unknown as LobbyJoinedMsg;
    case 'lobby/rooms':
      if (!Array.isArray(o.rooms)) fail('lobby/rooms: rooms must be an array');
      return o as unknown as LobbyRoomsMsg;
    case 'lobby/state':
      if (!isObj(o.room) || !isSlots(o.room.slots)) fail('lobby/state: bad room');
      return o as unknown as LobbyStateMsg;
    case 'lobby/chat':
      if (!isInt(o.hand, 0, MAX_HANDS - 1) || !isStr(o.text, 0, MAX_CHAT)) fail('lobby/chat: bad fields');
      return o as unknown as LobbyChatOutMsg;
    case 'lobby/closed':
      return o as unknown as LobbyClosedMsg;
    case 'game/start':
      if (!isInt(o.seed, 0, 4294967295) || !isMapId(o.mapId)) fail('game/start: bad seed or mapId');
      if (!isSha256Hex(o.mapSha) || !isSha256Hex(o.definesSha)) fail('game/start: bad shas');
      if (!isInt(o.delayTicks, 1, MAX_DELAY_TICKS) || !isInt(o.endTick, 1, MAX_END_TICK) || !isInt(o.crcInterval, 1, 1000)) fail('game/start: bad timing');
      if (!isSlots(o.slots) || !isInt(o.yourHand, 0, MAX_HANDS - 1)) fail('game/start: bad slots or yourHand');
      return o as unknown as GameStartMsg;
    case 'game/tick':
      if (!isInt(o.tick, 1, INT_LIMIT) || !Array.isArray(o.commands)) fail('game/tick: bad fields');
      return o as unknown as GameTickMsg;
    case 'game/rejected':
      if (!isInt(o.tick, 0, INT_LIMIT) || typeof o.reason !== 'string') fail('game/rejected: bad fields');
      return o as unknown as GameRejectedMsg;
    case 'game/late':
      if (!isInt(o.tick, 1, INT_LIMIT)) fail('game/late: bad tick');
      return o as unknown as GameLateMsg;
    case 'game/playerLeft':
      if (!isInt(o.hand, 0, MAX_HANDS - 1) || !isInt(o.atTick, 1, INT_LIMIT)) fail('game/playerLeft: bad fields');
      return o as unknown as GamePlayerLeftMsg;
    case 'game/desync':
      if (!isInt(o.tick, 1, INT_LIMIT) || !isObj(o.values)) fail('game/desync: bad fields');
      return o as unknown as GameDesyncMsg;
    case 'game/end':
      if (!isInt(o.tick, 1, INT_LIMIT)) fail('game/end: bad tick');
      return o as unknown as GameEndMsg;
    case 'error':
      if (typeof o.reason !== 'string') fail('error: reason must be a string');
      return o as unknown as ErrorMsg;
    default:
      fail(`unknown server message kind ${String(o.kind)}`);
  }
}
