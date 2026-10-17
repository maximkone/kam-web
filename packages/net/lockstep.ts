// lockstep.ts — the pure lockstep engine of one client (M6, docs/M6-SPIKE.md §4-§5). No sockets, no sim calls:
// the caller (client.ts or a test) feeds it the server's messages, runs the sim on what it returns, and sends
// what it drains. Rules:
//  - the client sends its set for tick t (its commands, stamped t) before it executes tick t - delayTicks,
//    so every set is in flight `delayTicks` ticks ahead of the tick it changes;
//  - a tick executes only when the relay has broadcast it (game/tick); the commands executed are exactly the
//    broadcast ones, including this client's own (never a local copy);
//  - every crcInterval ticks the client reports its state CRC (game/crc) after executing the tick;
//  - a desync, a bad broadcast or a bad command frame detaches the engine (it runs nothing more).
// Browser-safe: imports protocol.ts only.

import { checkCommand } from './protocol.ts';
import type { ClientMessage, GameCommand, ServerMessage } from './protocol.ts';

export type CommandInput = Record<string, unknown>;

export interface LockstepOptions {
  yourHand: number;
  delayTicks: number;
  endTick: number;
  crcInterval: number;
  /** Commands this client chooses for a set (called once per set, with the set's tick; the caller's state). */
  script?: (forTick: number) => CommandInput[];
}

export interface PlayerLeft {
  hand: number;
  atTick: number;
}

export class Lockstep {
  readonly yourHand: number;
  readonly delayTicks: number;
  readonly endTick: number;
  readonly crcInterval: number;
  /** The next tick to execute (1-based). It runs once the relay has broadcast it. */
  nextTick = 1;
  /** The last tick whose set this client has sent. */
  sentUpTo = 0;
  /** Set when the engine stops: a desync, a bad broadcast, or a bad frame from the relay. */
  detached: string | null = null;
  /** The tick of game/end, once received. */
  endedAt: number | null = null;
  playerLeft: PlayerLeft[] = [];
  rejected: { tick: number; hand: number; reason: string }[] = [];
  lateTicks: number[] = [];
  desyncTick: number | null = null;
  setsSent = 0;
  ticksExecuted = 0;
  private script: ((forTick: number) => CommandInput[]) | undefined;
  private queued: CommandInput[] = [];
  private ready = new Map<number, GameCommand[]>();
  private outbox: ClientMessage[] = [];

  constructor(opts: LockstepOptions) {
    this.yourHand = opts.yourHand;
    this.delayTicks = opts.delayTicks;
    this.endTick = opts.endTick;
    this.crcInterval = opts.crcInterval;
    this.script = opts.script;
  }

  /** Queues a local command; it goes out in the next set (stamped with that set's tick). */
  submit(cmd: CommandInput): void {
    this.queued.push(cmd);
  }

  /** Sends the sets this client owes: up to nextTick + delayTicks (never past endTick). Call before peek(). */
  pump(): void {
    if (this.detached !== null) return;
    const limit = Math.min(this.nextTick + this.delayTicks, this.endTick);
    while (this.sentUpTo < limit) {
      const t = this.sentUpTo + 1;
      this.sentUpTo = t;
      this.setsSent++;
      const inputs: CommandInput[] = [];
      if (t > this.delayTicks) {
        if (this.script !== undefined) inputs.push(...this.script(t));
        inputs.push(...this.queued.splice(0));
      }
      const commands = inputs.map((c) => ({ hand: this.yourHand, ...c, tick: t }));
      this.outbox.push({ kind: 'game/commands', tick: t, commands });
    }
  }

  /** The broadcast commands of nextTick, when the relay has sent them; null while the engine waits. */
  peek(): { tick: number; commands: GameCommand[] } | null {
    if (this.detached !== null || this.nextTick > this.endTick) return null;
    const commands = this.ready.get(this.nextTick);
    return commands === undefined ? null : { tick: this.nextTick, commands };
  }

  /** Call after executing `tick` (the peek() tick). crc() runs only when this tick is a checkpoint. */
  done(tick: number, crc: () => string): void {
    if (tick !== this.nextTick) throw new Error(`lockstep: done(${tick}) but the next tick is ${this.nextTick}`);
    this.ready.delete(tick);
    this.nextTick = tick + 1;
    this.ticksExecuted++;
    if (this.crcInterval > 0 && tick % this.crcInterval === 0) {
      this.outbox.push({ kind: 'game/crc', tick, value: crc() });
    }
  }

  /** The messages to send to the relay, in order. Clears the outbox. */
  drain(): ClientMessage[] {
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  /** Whether the game is over for this engine: the last tick ran, or it detached. */
  get finished(): boolean {
    return this.detached !== null || (this.endedAt !== null && this.nextTick > this.endTick);
  }

  /** Feeds one relay message in. Returns false when the message is not a game message this engine uses. */
  receive(msg: ServerMessage): boolean {
    switch (msg.kind) {
      case 'game/tick': {
        if (this.detached !== null) return true;
        if (msg.tick < this.nextTick || msg.tick > this.endTick || this.ready.has(msg.tick)) {
          this.detach(`broadcast for tick ${msg.tick} is out of order (next ${this.nextTick})`);
          return true;
        }
        const commands: GameCommand[] = [];
        for (const raw of msg.commands) {
          const c = checkCommand(raw);
          if (!c.ok) {
            this.detach(`broadcast for tick ${msg.tick} has a bad command: ${c.reason}`);
            return true;
          }
          if (c.cmd.tick !== msg.tick) {
            this.detach(`broadcast for tick ${msg.tick} has a command for tick ${c.cmd.tick}`);
            return true;
          }
          commands.push(c.cmd);
        }
        this.ready.set(msg.tick, commands);
        return true;
      }
      case 'game/late':
        this.lateTicks.push(msg.tick);
        return true;
      case 'game/rejected':
        this.rejected.push({ tick: msg.tick, hand: msg.hand, reason: msg.reason });
        return true;
      case 'game/playerLeft':
        this.playerLeft.push({ hand: msg.hand, atTick: msg.atTick });
        return true;
      case 'game/desync':
        this.desyncTick = msg.tick;
        this.detach(`desync at tick ${msg.tick}`);
        return true;
      case 'game/end':
        this.endedAt = msg.tick;
        return true;
      default:
        return false;
    }
  }

  /** Stops the engine (no more steps, no more sets) with a reason. */
  detach(reason: string): void {
    if (this.detached === null) this.detached = reason;
  }
}
