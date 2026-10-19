// zip.test.ts — the archive the pack is shipped in must be exactly reversible, because the thing inside it is
// the player's own KaM data: a silently truncated sprite pack would look like a crash in the game, not here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32, readZipDirectory, readZipEntry, unzipAll, writeZip } from './zip.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const deflate = (b: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(b));
const inflate = (b: Uint8Array): Uint8Array => new Uint8Array(inflateRawSync(b));

test('crc32 matches the standard test vector', () => {
  assert.equal(crc32(enc('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('a written archive reads back byte for byte', async () => {
  // a little of everything: deflated text, a stored (already compressed) blob, an empty file, a UTF-8 name
  const binary = new Uint8Array(4096);
  for (let i = 0; i < binary.length; i++) binary[i] = (i * 37) & 0xff;
  const input = [
    { name: 'data/defines/tiles.json', data: enc('{"a":[1,2,3]}\n'), deflate: true },
    { name: 'data/Sprites/Units.rxx', data: binary },
    { name: 'Maps/Zołta Łąka/Zołta Łąka.dat', data: enc('map dat'), deflate: true },
    { name: 'empty.txt', data: new Uint8Array(0), deflate: true },
  ];
  const zip = writeZip(input, deflate);
  const dir = readZipDirectory(zip);
  assert.deepEqual(
    dir.map((e) => e.name),
    input.map((e) => e.name),
  );
  assert.equal(dir[1].method, 0, 'the sprite pack is stored, not deflated twice');
  assert.equal(dir[0].method, 8);

  const back = await unzipAll(zip, inflate);
  assert.equal(back.size, input.length);
  for (const entry of input) {
    assert.deepEqual(Array.from(back.get(entry.name) ?? []), Array.from(entry.data), `${entry.name} survives the round trip`);
  }
  // the same input gives the same bytes (a fixed timestamp, no clock in the archive)
  assert.deepEqual(Array.from(writeZip(input, deflate)), Array.from(zip));
});

test('a corrupted archive is refused instead of half-read', async () => {
  const zip = writeZip([{ name: 'x.map', data: enc('0123456789'.repeat(50)), deflate: true }], deflate);
  const entry = readZipDirectory(zip)[0];
  const damaged = zip.slice();
  damaged[entry.offset + 30 + entry.name.length + 4] ^= 0xff; // a byte inside the compressed payload
  await assert.rejects(() => readZipEntry(damaged, entry, inflate), /CRC|bytes/);
});

test('a deflated entry needs an inflate function', async () => {
  const zip = writeZip([{ name: 'a.json', data: enc('{}'), deflate: true }], deflate);
  await assert.rejects(() => unzipAll(zip), /no inflate/);
  assert.throws(() => writeZip([{ name: 'a.json', data: enc('{}'), deflate: true }]), /no deflate function/);
});
