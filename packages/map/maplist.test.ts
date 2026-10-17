// maplist.test.ts — scanMapFolders on a synthetic install (docs/M3B-SPIKE.md 2.5/3).
// Run: node --test packages/map/maplist.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseTxtSmallDesc, scanMapFolders } from './maplist.ts';

function utf16(s: string): Buffer {
  const out = Buffer.alloc(2 * s.length);
  for (let i = 0; i < s.length; i++) out.writeUInt16LE(s.charCodeAt(i), 2 * i);
  return out;
}

/** A Remake map (r12485): header + plain 9-byte records + the ADDN tail. */
function remakeMap(mapX = 1, mapY = 1): Buffer {
  const rev = utf16('r12485');
  const head = Buffer.alloc(6 + rev.length + 4 + 8);
  head.writeInt32LE(0, 0);
  head.writeUInt16LE('r12485'.length, 4);
  rev.copy(head, 6);
  const records: Buffer[] = [];
  for (let i = 0; i < mapX * mapY; i++) {
    const record = Buffer.alloc(9);
    record.writeUInt16LE(263, 0);
    record.writeUInt8(4, 2);
    record.writeUInt8(5, 3);
    record.writeUInt16LE(255, 4);
    records.push(record);
  }
  const data = Buffer.concat(records);
  head.writeUInt32LE(data.length, 6 + rev.length);
  head.writeInt32LE(mapX, 10 + rev.length);
  head.writeInt32LE(mapY, 14 + rev.length);
  const tail = Buffer.alloc(16 + mapX * mapY);
  tail.write('ADDN', 0, 'latin1');
  tail.write('TILE', 4, 'latin1');
  tail.writeUInt32LE(mapX * mapY, 8);
  return Buffer.concat([head, data, tail]);
}

function latin1(text: string): Buffer {
  return Buffer.from(text, 'latin1');
}

function xor239(bytes: Buffer): Buffer {
  const out = Buffer.from(bytes);
  for (let i = 0; i < out.length; i++) out[i] ^= 239;
  return out;
}

// Realistic mission scripts: the XOR-239 heuristic (common bytes < 20%) false-positives on very
// short scripts, so the fixtures carry coordinates like a real .dat.
const ALPHA_SCRIPT =
  '!SET_MAP "maps\\alpha.map" !SET_MAX_PLAYER 3 !SET_TACTIC !SET_CURR_PLAYER 0 !SET_HUMAN_PLAYER 0 !SET_USER_PLAYER -1 ' +
  '!SET_CURR_PLAYER 1 !SET_AI_PLAYER -1 !SET_AI_START_POSITION 5 6 ' +
  '!SET_HOUSE 11 15 16 !SET_HOUSE 0 17 18 !SET_HOUSE 9 4 119 !SET_UNIT 0 20 21 !SET_UNIT 14 22 23 ' +
  '!SET_STREET 13 16 !SET_STREET 14 16 !ADD_WARE 2 -1 !ADD_WARE 0 30 !ADD_WARE 1 9000';
const BETA_SCRIPT = '!SET_CURR_PLAYER 0 !SET_HOUSE 11 1 1 !SET_HOUSE 0 2 2 !SET_UNIT 0 3 4 !SET_STREET 1 1 !ADD_WARE 0 10';
const XOR_SCRIPT = '!SET_MAX_PLAYER 4 !SET_TACTIC !SET_CURR_PLAYER 0 !SET_HOUSE 11 5 6 !SET_UNIT 0 7 8 !ADD_WARE 2 17';

interface Fixture {
  root: string;
  cleanup: () => void;
}

function makeRoot(): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'kam-maplist-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function put(root: string, folder: string, file: string, bytes: Buffer): void {
  mkdirSync(join(root, folder), { recursive: true });
  writeFileSync(join(root, folder, file), bytes);
}

test('scanMapFolders: required files, metadata, smallDesc and validity', () => {
  const { root, cleanup } = makeRoot();
  try {
    // Alpha: full map + plain .dat + .txt with SmallDesc.
    put(root, 'Alpha', 'Alpha.map', remakeMap(8, 8));
    put(root, 'Alpha', 'Alpha.dat', latin1(ALPHA_SCRIPT));
    put(root, 'Alpha', 'Alpha.txt', Buffer.from('Author\nSomeone\n\nSmallDesc\nA test map\n\nBigDesc\nMore text\n', 'utf8'));
    // Beta: no SET_MAX_PLAYER -> invalid; no .txt -> smallDesc ''.
    put(root, 'Beta', 'Beta.map', remakeMap(8, 8));
    put(root, 'Beta', 'Beta.dat', latin1(BETA_SCRIPT));
    // Skipped: a folder without .dat, one without .map, and a stray file.
    put(root, 'NoDat', 'NoDat.map', remakeMap());
    put(root, 'NoMap', 'NoMap.dat', latin1(BETA_SCRIPT));
    writeFileSync(join(root, 'stray.txt'), 'not a map folder');

    const list = scanMapFolders([{ kind: 'Maps', dir: root }]);
    assert.deepEqual(list.map((m) => m.name), ['Alpha', 'Beta']);

    const alpha = list[0];
    assert.equal(alpha.kind, 'Maps');
    assert.equal(alpha.mapX, 8);
    assert.equal(alpha.mapY, 8);
    assert.equal(alpha.remake, true);
    assert.equal(alpha.rev, 12485);
    assert.equal(alpha.mapPath, join(root, 'Alpha', 'Alpha.map'));
    assert.equal(alpha.datPath, join(root, 'Alpha', 'Alpha.dat'));
    assert.equal(alpha.txtPath, join(root, 'Alpha', 'Alpha.txt'));
    assert.equal(alpha.maxPlayers, 3);
    assert.equal(alpha.tactic, true);
    assert.deepEqual(
      alpha.canBeHuman.map((v, i) => (v ? i : -1)).filter((i) => i >= 0),
      [0],
    );
    assert.deepEqual(
      alpha.classicAI.map((v, i) => (v ? i : -1)).filter((i) => i >= 0),
      [1],
    );
    assert.deepEqual(alpha.aiStart[1], { x: 6, y: 7 });
    assert.deepEqual(alpha.aiStart[0], { x: 1, y: 1 });
    assert.equal(alpha.smallDesc, 'A test map');
    assert.equal(alpha.valid, true);

    const beta = list[1];
    assert.equal(beta.maxPlayers, 0);
    assert.equal(beta.tactic, false);
    assert.equal(beta.txtPath, null);
    assert.equal(beta.smallDesc, '');
    assert.equal(beta.valid, false);
  } finally {
    cleanup();
  }
});

test('scanMapFolders: XOR-239 .dat decodes, a broken header keeps size 0', () => {
  const { root, cleanup } = makeRoot();
  try {
    put(root, 'Xor', 'Xor.map', remakeMap());
    put(root, 'Xor', 'Xor.dat', xor239(latin1(XOR_SCRIPT)));
    put(root, 'Broken', 'Broken.map', Buffer.alloc(4)); // shorter than a header
    put(root, 'Broken', 'Broken.dat', latin1(ALPHA_SCRIPT));

    const list = scanMapFolders([{ kind: 'MapsMP', dir: root }]);
    const xor = list.find((m) => m.name === 'Xor');
    assert.ok(xor);
    assert.equal(xor.maxPlayers, 4);
    assert.equal(xor.tactic, true);
    assert.equal(xor.valid, true);

    const broken = list.find((m) => m.name === 'Broken');
    assert.ok(broken);
    assert.equal(broken.mapX, 0);
    assert.equal(broken.mapY, 0);
    assert.equal(broken.remake, false);
    assert.equal(broken.rev, 0);
    assert.equal(broken.maxPlayers, 3); // from ALPHA_SCRIPT
    assert.equal(broken.valid, true); // dat present and LocCount > 0 (KM_Maps.pas IsValid)
  } finally {
    cleanup();
  }
});

test('scanMapFolders: a missing root contributes nothing and never throws', () => {
  const list = scanMapFolders([{ kind: 'Maps', dir: join(tmpdir(), 'kam-maplist-does-not-exist') }]);
  assert.deepEqual(list, []);
});

test('parseTxtSmallDesc: the line after "SmallDesc", case-insensitive, BOM-safe', () => {
  assert.equal(parseTxtSmallDesc('Author\nA\nSmallDesc\nHello\nBigDesc\nB\n'), 'Hello');
  assert.equal(parseTxtSmallDesc('smalldesc\nlower\n'), 'lower');
  assert.equal(parseTxtSmallDesc('\uFEFFSmallDesc\nBOM\n'), 'BOM');
  assert.equal(parseTxtSmallDesc('Author\nA\n'), '');
  assert.equal(parseTxtSmallDesc('SmallDesc\n'), ''); // last line: nothing after it
  assert.equal(parseTxtSmallDesc('SmallDescish\nnot the key\n'), '');
});
