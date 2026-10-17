// protocol.test.ts — the frame validators of the relay and the client (pure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCommand, parseClientMessage, parseServerMessage, ProtocolError } from './protocol.ts';

const SHA = 'a'.repeat(64);

test('a valid lobby/create parses', () => {
  const m = parseClientMessage(JSON.stringify({ kind: 'lobby/create', mapId: 'MapsMP/Battle Sun', mapSha: SHA, definesSha: SHA, hands: 2, name: 'host' }));
  assert.equal(m.kind, 'lobby/create');
});

test('a malformed lobby/create is a ProtocolError with a reason', () => {
  assert.throws(
    () => parseClientMessage(JSON.stringify({ kind: 'lobby/create', mapId: '../etc/passwd', mapSha: SHA, definesSha: SHA, hands: 2, name: 'x' })),
    (err: unknown) => err instanceof ProtocolError && /mapId/.test(err.message),
  );
  assert.throws(() => parseClientMessage(JSON.stringify({ kind: 'lobby/create', mapId: 'MapsMP/Battle Sun', mapSha: 'short', definesSha: SHA, hands: 2, name: 'x' })), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.stringify({ kind: 'lobby/create', mapId: 'MapsMP/Battle Sun', mapSha: SHA, definesSha: SHA, hands: 9, name: 'x' })), ProtocolError);
});

test('frames that are not JSON objects are rejected', () => {
  assert.throws(() => parseClientMessage('{"kind": "lobby/list"'), ProtocolError);
  assert.throws(() => parseClientMessage('[1,2]'), ProtocolError);
  assert.throws(() => parseClientMessage('{"kind": 5}'), ProtocolError);
  assert.throws(() => parseClientMessage('{"kind": "nope"}'), ProtocolError);
});

test('game/commands needs an integer tick and at most 64 commands', () => {
  assert.equal(parseClientMessage(JSON.stringify({ kind: 'game/commands', tick: 5, commands: [] })).kind, 'game/commands');
  assert.throws(() => parseClientMessage(JSON.stringify({ kind: 'game/commands', tick: 0, commands: [] })), ProtocolError);
  assert.throws(() => parseClientMessage(JSON.stringify({ kind: 'game/commands', tick: 5, commands: new Array(65).fill({}) })), ProtocolError);
});

test('game/crc needs a hex value', () => {
  assert.equal(parseClientMessage(JSON.stringify({ kind: 'game/crc', tick: 50, value: '0badf00d' })).kind, 'game/crc');
  assert.throws(() => parseClientMessage(JSON.stringify({ kind: 'game/crc', tick: 50, value: 'xyz' })), ProtocolError);
});

test('checkCommand keeps only the known fields of a valid command', () => {
  const c = checkCommand({ hand: 1, tick: 7, type: 'groupHalt', groupUid: 3, extra: 'dropped' });
  assert.deepEqual(c, { ok: true, cmd: { hand: 1, tick: 7, type: 'groupHalt', groupUid: 3 } });
});

test('checkCommand refuses wrong types, unknown types and bad hands', () => {
  assert.equal(checkCommand({ hand: 1, tick: 7, type: 'groupHalt', groupUid: '3' }).ok, false);
  assert.equal(checkCommand({ hand: 1, tick: 7, type: 'destroyEverything' }).ok, false);
  assert.equal(checkCommand({ hand: 9, tick: 7, type: 'groupHalt', groupUid: 3 }).ok, false);
  assert.equal(checkCommand({ hand: 1, tick: 7, type: 'fieldPlan', kind: 'gold', x: 1, y: 1 }).ok, false);
  assert.equal(checkCommand('halt').ok, false);
});

test('checkCommand copies a road path and checks each point', () => {
  const ok = checkCommand({ hand: 0, tick: 2, type: 'roadPlanLine', path: [{ x: 1, y: 2, z: 9 }, { x: 1, y: 3 }] });
  assert.deepEqual(ok, { ok: true, cmd: { hand: 0, tick: 2, type: 'roadPlanLine', path: [{ x: 1, y: 2 }, { x: 1, y: 3 }] } });
  assert.equal(checkCommand({ hand: 0, tick: 2, type: 'roadPlanLine', path: [{ x: 1 }] }).ok, false);
});

test('server frames: game/tick parses, a broken game/start does not', () => {
  assert.equal(parseServerMessage(JSON.stringify({ kind: 'game/tick', tick: 4, commands: [] })).kind, 'game/tick');
  assert.throws(() => parseServerMessage(JSON.stringify({ kind: 'game/start', seed: -1 })), ProtocolError);
  assert.throws(() => parseServerMessage('{"kind":"lobby/state"}'), ProtocolError);
});
