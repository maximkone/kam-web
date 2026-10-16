// mission.test.ts — mission script decode + tokenizer + the v0 command subset (docs/M3-SPIKE.md 2.1).
// Run: node --test packages/mission/mission.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeMissionScript,
  parseMissionScript,
  tokenizeMissionScript,
  HAND_ANIMAL,
} from './mission.ts';

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function xor239(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  for (let i = 0; i < out.length; i++) out[i] ^= 239;
  return out;
}

test('XOR-239 detection: an encoded script decodes to the same text as the plain one', () => {
  const plain =
    '!SET_MAP "data\\mission\\smaps\\mini.map" !SET_MAX_PLAYER 3 !SET_HUMAN_PLAYER 0 ' +
    '!SET_CURR_PLAYER 1 !SET_HOUSE 11 15 16 !SET_STREET 13 16 !SET_UNIT 9 14 17 !ADD_WARE 2 -1';
  const text = decodeMissionScript(latin1(plain));
  const encoded = decodeMissionScript(xor239(latin1(plain)));
  assert.equal(encoded, text);

  const a = parseMissionScript(latin1(plain));
  const b = parseMissionScript(xor239(latin1(plain)));
  assert.deepEqual(b, a);
  assert.equal(a.mapName, 'data\\mission\\smaps\\mini.map');
  assert.equal(a.maxPlayers, 3);
  assert.equal(a.humanPlayer, 0);
});

test('tabs/CR/LF become spaces and runs of two spaces or !! collapse to one', () => {
  const bytes = latin1('!SET_CURR_PLAYER\t0\n!!SET_HOUSE  11  15 16\r\n');
  const text = decodeMissionScript(bytes);
  assert.equal(text, '!SET_CURR_PLAYER 0 !SET_HOUSE 11 15 16 ');
  const m = parseMissionScript(bytes);
  assert.deepEqual(m.houses, [{ typeId: 11, x: 16, y: 17, owner: 0 }]);
});

test('tokenizer walks unknown commands and multi-command lines correctly', () => {
  const text =
    '!SET_CURR_PLAYER 1 !SET_AI_CHARACTER RECRUTS 5 !SET_AI_CHARACTER TROUP_PARAM 1 9 3 ' +
    '!SET_HOUSE 0 7 8 !BLOCK_HOUSE 10 !SET_UNIT 5 1 2 !SET_FIELD 3 4 !ADD_WARE 0 30';
  const commands = tokenizeMissionScript(text);
  const names = commands.map((c) => c.cmd);
  assert.deepEqual(names, [
    '!SET_CURR_PLAYER',
    '!SET_AI_CHARACTER',
    '!SET_AI_CHARACTER',
    '!SET_HOUSE',
    '!BLOCK_HOUSE',
    '!SET_UNIT',
    '!SET_FIELD',
    '!ADD_WARE',
  ]);
  // First param may be text, defaults are −1, params stop at the next '!'.
  assert.equal(commands[1].textParam, 'RECRUTS');
  assert.deepEqual(commands[1].params.slice(0, 2), [-1, 5]);
  assert.deepEqual(commands[2].params.slice(0, 4), [-1, 1, 9, 3]);
  assert.deepEqual(commands[4].params.slice(0, 1), [10]);

  const m = parseMissionScript(latin1(text), 128, 128);
  assert.deepEqual(m.houses, [{ typeId: 0, x: 8, y: 9, owner: 1 }]);
  assert.deepEqual(m.units, [{ typeId: 5, x: 2, y: 3, owner: 1 }]); // carpenter = record 5
  assert.deepEqual(m.wares, [{ ware: 0, amount: 30, owner: 1 }]);
  assert.equal(m.streets.length, 0);
});

test('SET_HOUSE / SET_STREET / SET_UNIT / ADD_WARE land in the right lists with +1 coords', () => {
  const text =
    '!SET_CURR_PLAYER 1 !SET_HOUSE 11 15 16 !SET_HOUSE 9 4 119 !SET_STREET 13 16 !SET_STREET 14 16 ' +
    '!SET_UNIT 0 14 18 !SET_UNIT 1 11 113 !ADD_WARE 0 30 !ADD_WARE 1 9000 !ADD_WARE 2 -1';
  const m = parseMissionScript(latin1(text), 128, 128);
  assert.deepEqual(m.houses, [
    { typeId: 11, x: 16, y: 17, owner: 1 }, // store
    { typeId: 9, x: 5, y: 120, owner: 1 }, // woodcutter hut
  ]);
  assert.deepEqual(m.streets, [
    { x: 14, y: 17, owner: 1 },
    { x: 15, y: 17, owner: 1 },
  ]);
  assert.deepEqual(m.units, [
    { typeId: 0, x: 15, y: 19, owner: 1 }, // serf
    { typeId: 1, x: 12, y: 114, owner: 1 }, // woodcutter
  ]);
  assert.deepEqual(m.wares, [
    { ware: 0, amount: 30, owner: 1 },
    { ware: 1, amount: 9000, owner: 1 },
    { ware: 2, amount: 65535, owner: 1 }, // −1 → High(Word)
  ]);
});

test('animals (old ids 24..31) are parsed with owner −1 and mapped to unit.dat records 30..37', () => {
  const text = '!SET_CURR_PLAYER 0 !SET_UNIT 24 3 4 !SET_UNIT 25 4 4 !SET_UNIT 31 5 4';
  const m = parseMissionScript(latin1(text), 128, 128);
  assert.deepEqual(m.units, [
    { typeId: 30, x: 4, y: 5, owner: HAND_ANIMAL }, // wolf
    { typeId: 31, x: 5, y: 5, owner: HAND_ANIMAL }, // fish
    { typeId: 37, x: 6, y: 5, owner: HAND_ANIMAL }, // duck
  ]);
});

test('commands before any SET_CURR_PLAYER are skipped (hand = HAND_NONE)', () => {
  const text = '!SET_HOUSE 11 15 16 !SET_STREET 1 1 !SET_UNIT 0 1 1 !ADD_WARE 0 5 !SET_CURR_PLAYER 2 !SET_HOUSE 0 7 8';
  const m = parseMissionScript(latin1(text), 128, 128);
  assert.deepEqual(m.houses, [{ typeId: 0, x: 8, y: 9, owner: 2 }]);
  assert.equal(m.streets.length, 0);
  assert.equal(m.units.length, 0);
  assert.equal(m.wares.length, 0);
});

test('PointInMap: out-of-map coordinates are dropped when the map size is known', () => {
  const text = '!SET_CURR_PLAYER 0 !SET_HOUSE 0 200 200 !SET_UNIT 0 0 -1 !SET_STREET 127 127';
  const withMap = parseMissionScript(latin1(text), 128, 128);
  assert.equal(withMap.houses.length, 0);
  assert.equal(withMap.units.length, 0);
  assert.deepEqual(withMap.streets, [{ x: 128, y: 128, owner: 0 }]); // (127+1, 127+1) is inside 128×128

  const noMap = parseMissionScript(latin1(text));
  assert.equal(noMap.houses.length, 1); // without a map size every coordinate is accepted
});

test('ADD_WARE clamps out-of-range amounts (999999 → 65535, −5 → 65535)', () => {
  const text = '!SET_CURR_PLAYER 0 !ADD_WARE 0 999999 !ADD_WARE 1 -5 !ADD_WARE 2 17';
  const m = parseMissionScript(latin1(text), 128, 128);
  assert.deepEqual(m.wares, [
    { ware: 0, amount: 65535, owner: 0 },
    { ware: 1, amount: 65535, owner: 0 },
    { ware: 2, amount: 17, owner: 0 },
  ]);
});

test('an empty script throws; a script without commands parses to an empty mission', () => {
  assert.throws(() => decodeMissionScript(new Uint8Array(0)), /empty/);
  const m = parseMissionScript(latin1('just some text without commands'));
  assert.deepEqual(m.houses, []);
  assert.equal(m.maxPlayers, 0);
  assert.equal(m.humanPlayer, 0);
  assert.equal(m.mapName, '');
});
