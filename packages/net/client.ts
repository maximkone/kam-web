// client.ts — the browser-safe multiplayer client (M6, docs/M6-SPIKE.md §2-§5): one WebSocket to the relay,
// the lobby calls, and the lockstep loop that runs the sim on the relay's broadcasts (lockstep.ts).
// Uses the global WebSocket by default (browsers, Node 24); a test passes its own socket factory.
// Browser-safe: no node: imports. The caller supplies the map and defines (createSkirmish) through the hooks.

import { step } from '../sim/skirmish.ts';
import type { Skirmish, StepResult } from '../sim/skirmish.ts';
import { parseServerMessage, ProtocolError } from './protocol.ts';
import type { ClientMessage, GameCommand, GameStartMsg, ServerMessage } from './protocol.ts';
import { Lockstep } from './lockstep.ts';
import type { CommandInput } from './lockstep.ts';
import { stateCrc } from './statehash.ts';

export type SocketFactory = (url: string) => WebSocket;

export interface GameHooks {
  /** Builds the sim of a game/start (the caller loads and checks its own map and defines, then createSkirmish). */
  createSkirmish: (start: GameStartMsg) => Skirmish;
  /** The commands this client chooses for a set of tick `forTick`, from its own state. Optional. */
  script?: (sk: Skirmish, forTick: number) => CommandInput[];
  /** Runs before tick `tick` executes (tests use it to inject a fault). Optional. */
  beforeStep?: (sk: Skirmish, tick: number) => void;
  /** Changes this client's LOCAL copy of a broadcast tick before it is stepped (the desync injection). Optional. */
  tamper?: (tick: number, commands: GameCommand[]) => GameCommand[];
}

export interface NetClientOptions {
  url: string;
  makeSocket?: SocketFactory;
}

export class NetClient {
  readonly url: string;
  status: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  roomId: string | null = null;
  hand: number | null = null;
  start: GameStartMsg | null = null;
  lockstep: Lockstep | null = null;
  sk: Skirmish | null = null;
  hooks: GameHooks | null = null;
  onMessage: ((msg: ServerMessage) => void) | null = null;
  onStep: ((tick: number, result: StepResult) => void) | null = null;
  onFinished: ((reason: string) => void) | null = null;
  onError: ((reason: string) => void) | null = null;
  onClose: ((code: number) => void) | null = null;
  private socket: WebSocket | null = null;
  private makeSocket: SocketFactory;
  private finishedNotified = false;

  constructor(opts: NetClientOptions) {
    this.url = opts.url;
    this.makeSocket = opts.makeSocket ?? ((u: string) => new WebSocket(u));
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.status = 'connecting';
      const ws = this.makeSocket(this.url);
      this.socket = ws;
      ws.onopen = () => {
        this.status = 'open';
        resolve();
      };
      ws.onerror = () => {
        if (this.status === 'connecting') reject(new Error(`cannot connect to ${this.url}`));
      };
      ws.onmessage = (ev: MessageEvent) => this.onRaw(String(ev.data));
      ws.onclose = (ev: CloseEvent) => {
        const wasConnecting = this.status === 'connecting';
        this.status = 'closed';
        if (wasConnecting) reject(new Error(`connection closed (${ev.code})`));
        this.onClose?.(ev.code);
      };
    });
  }

  /** Sends one client message as a text frame. */
  send(msg: ClientMessage): void {
    this.sendRaw(JSON.stringify(msg));
  }

  /** Sends raw text as a frame (tests use it for malformed frames). */
  sendRaw(text: string): void {
    if (this.socket === null || this.status !== 'open') throw new Error(`cannot send: status is ${this.status}`);
    this.socket.send(text);
  }

  close(code: number = 1000): void {
    this.socket?.close(code);
    this.status = 'closed';
  }

  /** Runs every tick whose broadcast has arrived; sends the sets and CRCs that are due. Returns the steps run. */
  advance(): number {
    const ls = this.lockstep;
    const sk = this.sk;
    if (ls === null || sk === null) return 0;
    let n = 0;
    for (;;) {
      ls.pump();
      this.flush();
      const next = ls.peek();
      if (next === null) break;
      this.hooks?.beforeStep?.(sk, next.tick);
      const commands = this.hooks?.tamper?.(next.tick, next.commands) ?? next.commands;
      const result = step(sk, commands);
      ls.done(next.tick, () => stateCrc(sk));
      this.flush();
      this.onStep?.(next.tick, result);
      n++;
    }
    if (ls.finished && !this.finishedNotified) {
      this.finishedNotified = true;
      this.onFinished?.(ls.detached ?? `ended at tick ${ls.endedAt}`);
    }
    return n;
  }

  private flush(): void {
    const ls = this.lockstep;
    if (ls === null) return;
    for (const m of ls.drain()) this.send(m);
  }

  private onRaw(text: string): void {
    let msg: ServerMessage;
    try {
      msg = parseServerMessage(text);
    } catch (err) {
      this.onError?.(err instanceof ProtocolError ? err.message : String(err));
      return;
    }
    this.onMessage?.(msg);
    if (msg.kind === 'lobby/created' || msg.kind === 'lobby/joined') {
      this.roomId = msg.roomId;
      this.hand = msg.hand;
      return;
    }
    if (msg.kind === 'game/start') {
      this.beginGame(msg);
      this.advance();
      return;
    }
    if (msg.kind.startsWith('game/')) {
      this.lockstep?.receive(msg);
      this.advance();
    }
  }

  private beginGame(start: GameStartMsg): void {
    if (this.hooks === null) {
      this.onError?.('game/start received without game hooks');
      return;
    }
    this.start = start;
    this.hand = start.yourHand;
    this.sk = this.hooks.createSkirmish(start);
    const hooks = this.hooks;
    const sk = this.sk;
    this.lockstep = new Lockstep({
      yourHand: start.yourHand,
      delayTicks: start.delayTicks,
      endTick: start.endTick,
      crcInterval: start.crcInterval,
      script: hooks.script === undefined ? undefined : (t: number) => hooks.script!(sk, t),
    });
  }
}
