// rpl.ts — KaM Remake .rpl replay container reader/writer (docs/M2-SPIKE.md 2.1, 3.2).
//
// File    = [u16 markerLen=13]["GIPCompressed"][zlib stream] -> payload
// Payload = [u16 revLen]["r15472"][i32 count][u32 extra] + (count+1) * 22-byte records
// Record  = { u32 tick; u32 rand; u8 cmd; i8 hand; u8 data[12] }  (row-major; record 0 = zero dummy)
// Sources: KM_GameInputProcess.pas SaveToStream 1417-1441 / LoadFromStream 1482-1496,
// TKMemoryStreamBinary.PlaceMarker/WriteA (u16 length prefix + ANSI bytes).
//
// Round-trip contract is structural: payload bytes + parsed fields + length identity. Compressed-layer
// byte equality with files written by the game is NOT achievable (different zlib build) and not required.
import { readFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

export interface RplRecord {
  tick: number;
  rand: number;
  cmd: number;
  hand: number; // i8, -1 = no hand
  data: Uint8Array; // exactly 12 bytes
}

export interface RplFile {
  rev: string; // echoed verbatim; reader accepts any u16-length revision
  extra: number; // GIP variant extra (u32); 0 for the r15472 corpus
  records: RplRecord[]; // records[0] = dummy; records.length === count + 1
}

const MARKER = 'GIPCompressed';
const RECORD_SIZE = 22;
const DATA_SIZE = 12;
const ZLIB_MAX_OUTPUT = 512 * 1024 * 1024; // runaway-inflate guard for garbage input

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Parse a whole .rpl container. Named errors: bad marker, truncated payload, bad length. */
export function parseRpl(bytes: Uint8Array): RplFile {
  if (bytes.length < 2) throw new Error(`bad marker: file too short (${bytes.length} bytes)`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const markerLen = view.getUint16(0, true);
  if (2 + markerLen > bytes.length) {
    throw new Error(`bad marker: marker length ${markerLen} exceeds file (${bytes.length} bytes)`);
  }
  const marker = Buffer.from(bytes.subarray(2, 2 + markerLen)).toString('latin1');
  if (marker !== MARKER) {
    const shown = marker.length > 16 ? `${marker.slice(0, 16)}... (${marker.length} bytes)` : marker;
    throw new Error(`bad marker: expected ${JSON.stringify(MARKER)}, got ${JSON.stringify(shown)}`);
  }

  let payload: Uint8Array;
  try {
    payload = inflateSync(bytes.subarray(2 + markerLen), { maxOutputLength: ZLIB_MAX_OUTPUT });
  } catch (err) {
    throw new Error(`truncated payload: zlib inflate failed (${reason(err)})`);
  }

  if (payload.length < 16) {
    throw new Error(`truncated payload: ${payload.length} bytes, header needs at least 16`);
  }
  const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const revLen = pv.getUint16(0, true);
  if (2 + revLen + 8 > payload.length) {
    throw new Error(`truncated payload: revision length ${revLen} exceeds ${payload.length} bytes`);
  }
  const rev = Buffer.from(payload.subarray(2, 2 + revLen)).toString('latin1');
  const count = pv.getInt32(2 + revLen, true);
  const extra = pv.getUint32(2 + revLen + 4, true);
  const recordBase = 2 + revLen + 8;
  const expected = recordBase + RECORD_SIZE * (count + 1);
  if (count < 0 || payload.length !== expected) {
    throw new Error(`bad length: payload ${payload.length} bytes for count ${count} (expected ${expected})`);
  }

  const records: RplRecord[] = [];
  for (let i = 0; i <= count; i++) {
    const o = recordBase + i * RECORD_SIZE;
    records.push({
      tick: pv.getUint32(o, true),
      rand: pv.getUint32(o + 4, true),
      cmd: pv.getUint8(o + 8),
      hand: pv.getInt8(o + 9),
      data: new Uint8Array(payload.subarray(o + 10, o + 10 + DATA_SIZE)), // independent copy
    });
  }
  return { rev, extra, records };
}

/** Read + parse a .rpl file; fs errors become a short named error as well. */
export function readRplFile(path: string): RplFile {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (err) {
    throw new Error(`rpl: ${path}: cannot read file (${reason(err)})`);
  }
  return parseRpl(bytes);
}

/** Serialize the payload only: [u16 revLen][rev][i32 count][u32 extra] + 22-byte records. */
export function writeRplPayload(f: RplFile): Uint8Array {
  const rev = Buffer.from(f.rev, 'latin1');
  if (rev.length > 0xffff) throw new Error(`bad length: revision is ${rev.length} bytes, does not fit u16`);
  if (f.records.length === 0) throw new Error('bad length: no records (record 0 is the dummy)');
  const count = f.records.length - 1;
  const out = Buffer.alloc(2 + rev.length + 4 + 4 + RECORD_SIZE * (count + 1));
  out.writeUInt16LE(rev.length, 0);
  rev.copy(out, 2);
  let o = 2 + rev.length;
  out.writeInt32LE(count, o);
  out.writeUInt32LE(f.extra, o + 4);
  o += 8;
  for (let i = 0; i < f.records.length; i++, o += RECORD_SIZE) {
    const r = f.records[i];
    if (r.data.length !== DATA_SIZE) {
      throw new Error(`bad length: record ${i} data is ${r.data.length} bytes, expected ${DATA_SIZE}`);
    }
    out.writeUInt32LE(r.tick, o);
    out.writeUInt32LE(r.rand, o + 4);
    out.writeUInt8(r.cmd, o + 8);
    out.writeInt8(r.hand, o + 9);
    out.set(r.data, o + 10);
  }
  return out;
}

/** Serialize the whole container: [u16 13]["GIPCompressed"][zlib deflate level 6 of payload]. */
export function writeRplFile(f: RplFile): Uint8Array {
  const marker = Buffer.from(MARKER, 'latin1');
  const payload = writeRplPayload(f);
  const body = deflateSync(payload, { level: 6 });
  const out = Buffer.alloc(2 + marker.length + body.length);
  out.writeUInt16LE(marker.length, 0);
  marker.copy(out, 2);
  body.copy(out, 2 + marker.length);
  return out;
}
