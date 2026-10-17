// lockstep.test.ts — the pure lockstep engine (no sockets, no sim): set timing, broadcasts, CRC, desync, end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lockstep } from './lockstep.ts';
import type { ClientMessage, ServerMessage } from './protocol.ts';

function tickMsg(tick: number, commands: unknown[] = []): ServerMessage {
  return { kind: 'game/tick', tick, commands } as ServerMessage;
}

function sets(msgs: ClientMessage[]): { tick: number; commands: unknown[] }[] {
  return msgs.filter((m) => m.kind === 'game/commands').map((m) => ({ tick: m.tick, commands: m.commands }));
}

test('pump sends the sets up to nextTick + delay; the first delay sets are empty', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 2, endTick: 10, crcInterval: 0 });
  ls.pump();
  const out = sets(ls.drain());
  assert.deepEqual(out.map((s) => s.tick), [1, 2, 3]);
  assert.deepEqual(out.map((s) => s.commands), [[], [], []]);
  assert.equal(ls.sentUpTo, 3);
});

test('a submitted command goes out stamped with the set tick and this hand', () => {
  const ls = new Lockstep({ yourHand: 1, delayTicks: 2, endTick: 10, crcInterval: 0 });
  ls.submit({ type: 'groupHalt', groupUid: 4 });
  ls.pump();
  const out = sets(ls.drain());
  assert.deepEqual(out[2].commands, [{ hand: 1, type: 'groupHalt', groupUid: 4, tick: 3 }]);
});

test('the script runs once per set after the delay, with the set tick', () => {
  const asked: number[] = [];
  const ls = new Lockstep({
    yourHand: 0,
    delayTicks: 2,
    endTick: 10,
    crcInterval: 0,
    script: (t) => {
      asked.push(t);
      return [{ type: 'groupHalt', groupUid: t }];
    },
  });
  ls.pump();
  ls.pump();
  assert.deepEqual(asked, [3]);
  const out = sets(ls.drain());
  assert.deepEqual(out[2].commands, [{ hand: 0, type: 'groupHalt', groupUid: 3, tick: 3 }]);
});

test('sets never go past endTick', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 4, endTick: 3, crcInterval: 0 });
  ls.pump();
  assert.deepEqual(sets(ls.drain()).map((s) => s.tick), [1, 2, 3]);
});

test('a tick waits for its broadcast and runs in order', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 3, crcInterval: 0 });
  assert.equal(ls.peek(), null);
  ls.receive(tickMsg(1, []));
  const first = ls.peek();
  assert.deepEqual(first, { tick: 1, commands: [] });
  ls.done(1, () => 'unused');
  assert.equal(ls.nextTick, 2);
  assert.equal(ls.peek(), null);
  ls.receive(tickMsg(2, []));
  ls.done(2, () => 'unused');
  ls.receive(tickMsg(3, []));
  ls.done(3, () => 'unused');
  assert.equal(ls.nextTick, 4);
});

test('a broadcast command is validated and stamped for its tick', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 3, crcInterval: 0 });
  ls.receive(tickMsg(1, [{ hand: 1, tick: 1, type: 'groupHalt', groupUid: 2, junk: true }]));
  assert.deepEqual(ls.peek()?.commands, [{ hand: 1, tick: 1, type: 'groupHalt', groupUid: 2 }]);
  assert.equal(ls.detached, null);
});

test('a bad command in a broadcast detaches the engine', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 3, crcInterval: 0 });
  ls.receive(tickMsg(1, [{ hand: 1, tick: 1, type: 'groupHalt', groupUid: 'two' }]));
  assert.equal(ls.peek(), null);
  assert.match(ls.detached ?? '', /bad command/);
  assert.equal(ls.finished, true);
});

test('a command stamped for another tick in a broadcast detaches the engine', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 3, crcInterval: 0 });
  ls.receive(tickMsg(1, [{ hand: 0, tick: 2, type: 'groupHalt', groupUid: 1 }]));
  assert.match(ls.detached ?? '', /for tick 2/);
});

test('a broadcast ahead of the next tick is kept until its turn', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 5, crcInterval: 0 });
  ls.receive(tickMsg(3, []));
  assert.equal(ls.detached, null);
  assert.equal(ls.peek(), null);
});

test('a broadcast for a tick already run detaches the engine', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 5, crcInterval: 0 });
  ls.receive(tickMsg(1, []));
  ls.done(1, () => '');
  ls.receive(tickMsg(1, []));
  assert.match(ls.detached ?? '', /out of order/);
});

test('done() checks the tick and reports a CRC on checkpoints only', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 4, crcInterval: 2 });
  ls.receive(tickMsg(1, []));
  ls.receive(tickMsg(2, []));
  ls.done(1, () => 'nope');
  assert.throws(() => ls.done(3, () => 'nope'), /next tick is 2/);
  ls.done(2, () => '0badf00d');
  const crc = ls.drain().filter((m) => m.kind === 'game/crc');
  assert.deepEqual(crc, [{ kind: 'game/crc', tick: 2, value: '0badf00d' }]);
});

test('game/desync detaches the engine and records the tick', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 4, crcInterval: 2 });
  ls.receive({ kind: 'game/desync', tick: 50, values: { 0: '11111111', 1: '22222222' } });
  assert.equal(ls.desyncTick, 50);
  assert.equal(ls.finished, true);
  ls.receive(tickMsg(1, []));
  assert.equal(ls.peek(), null);
});

test('the engine is finished after game/end and the last tick', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 2, crcInterval: 0 });
  ls.receive({ kind: 'game/end', tick: 2 });
  assert.equal(ls.finished, false);
  ls.receive(tickMsg(1, []));
  ls.receive(tickMsg(2, []));
  ls.done(1, () => '');
  ls.done(2, () => '');
  assert.equal(ls.finished, true);
});

test('late, rejected and player-left notices are recorded', () => {
  const ls = new Lockstep({ yourHand: 0, delayTicks: 1, endTick: 9, crcInterval: 0 });
  assert.equal(ls.receive({ kind: 'game/late', tick: 4 } as ServerMessage), true);
  assert.equal(ls.receive({ kind: 'game/rejected', tick: 4, hand: 0, reason: 'no' } as ServerMessage), true);
  assert.equal(ls.receive({ kind: 'game/playerLeft', hand: 1, atTick: 6 } as ServerMessage), true);
  assert.equal(ls.receive({ kind: 'lobby/rooms', rooms: [] } as ServerMessage), false);
  assert.deepEqual(ls.lateTicks, [4]);
  assert.deepEqual(ls.rejected, [{ tick: 4, hand: 0, reason: 'no' }]);
  assert.deepEqual(ls.playerLeft, [{ hand: 1, atTick: 6 }]);
});
