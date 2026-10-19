// zip.ts — a minimal ZIP writer and reader, pure and injectable.
//
// Why hand-rolled: the workspace forbids runtime dependencies, and this needs to work both in node
// (tools/pack writes a pack of the player's own KaM files) and in a browser (the page will read that pack
// back). Only what this project uses is implemented: no encryption, no zip64, no data descriptors - entries
// carry their own CRC and sizes, which is what makes the archive verifiable after the fact.
//
// Compression is injected (zlib.deflateRawSync in node, DecompressionStream('deflate-raw') in a browser) so
// this file stays free of any environment.

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_END = 0x06054b50;
/** Bit 11: the name is UTF-8 (map names are not all ASCII). */
const FLAG_UTF8 = 0x800;
/** A fixed DOS timestamp (1980-01-01) so the same input always produces the same archive. */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** The standard CRC-32 of a byte range (what a zip entry stores). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  /** '/'-separated path inside the archive. */
  name: string;
  data: Uint8Array;
  /** Compress it (needs `deflateRaw`). Sprite packs are already deflated, so they are stored instead. */
  deflate?: boolean;
}

export interface ZipDirEntry {
  name: string;
  method: number;
  crc: number;
  compSize: number;
  size: number;
  /** Offset of the local file header. */
  offset: number;
}

interface Bytes {
  buf: Uint8Array;
  at: number;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function putU16(b: Bytes, v: number): void {
  b.buf[b.at++] = v & 0xff;
  b.buf[b.at++] = (v >>> 8) & 0xff;
}

function putU32(b: Bytes, v: number): void {
  b.buf[b.at++] = v & 0xff;
  b.buf[b.at++] = (v >>> 8) & 0xff;
  b.buf[b.at++] = (v >>> 16) & 0xff;
  b.buf[b.at++] = (v >>> 24) & 0xff;
}

function getU16(bytes: Uint8Array, at: number): number {
  return view(bytes).getUint16(at, true);
}

function getU32(bytes: Uint8Array, at: number): number {
  return view(bytes).getUint32(at, true);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Build a zip. `deflateRaw` is required only for entries with `deflate: true`; it may be absent when every
 * entry is stored.
 */
export function writeZip(entries: ZipEntryInput[], deflateRaw?: (b: Uint8Array) => Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const wantDeflate = entry.deflate === true;
    if (wantDeflate && deflateRaw === undefined) throw new Error(`zip: no deflate function for ${entry.name}`);
    const body = wantDeflate && deflateRaw !== undefined ? deflateRaw(entry.data) : entry.data;
    const method = wantDeflate ? 8 : 0;
    const crc = crc32(entry.data);

    const local = new Uint8Array(30 + name.length);
    const lb: Bytes = { buf: local, at: 0 };
    putU32(lb, SIG_LOCAL);
    putU16(lb, 20);
    putU16(lb, FLAG_UTF8);
    putU16(lb, method);
    putU16(lb, DOS_TIME);
    putU16(lb, DOS_DATE);
    putU32(lb, crc);
    putU32(lb, body.length);
    putU32(lb, entry.data.length);
    putU16(lb, name.length);
    putU16(lb, 0);
    local.set(name, 30);
    locals.push(local, body);

    const head = new Uint8Array(46 + name.length);
    const cb: Bytes = { buf: head, at: 0 };
    putU32(cb, SIG_CENTRAL);
    putU16(cb, 20);
    putU16(cb, 20);
    putU16(cb, FLAG_UTF8);
    putU16(cb, method);
    putU16(cb, DOS_TIME);
    putU16(cb, DOS_DATE);
    putU32(cb, crc);
    putU32(cb, body.length);
    putU32(cb, entry.data.length);
    putU16(cb, name.length);
    putU16(cb, 0);
    putU16(cb, 0);
    putU16(cb, 0);
    putU16(cb, 0);
    putU32(cb, 0o100644 << 16); // a normal file, so an extractor does not mark it executable
    putU32(cb, offset);
    head.set(name, 46);
    central.push(head);

    offset += local.length + body.length;
  }

  const centralBytes = concat(central);
  const end = new Uint8Array(22);
  const eb: Bytes = { buf: end, at: 0 };
  putU32(eb, SIG_END);
  putU16(eb, 0);
  putU16(eb, 0);
  putU16(eb, entries.length);
  putU16(eb, entries.length);
  putU32(eb, centralBytes.length);
  putU32(eb, offset);
  putU16(eb, 0);
  return concat([...locals, centralBytes, end]);
}

/** Every entry of an archive, read from its central directory (the authoritative list). */
export function readZipDirectory(bytes: Uint8Array): ZipDirEntry[] {
  // the end-of-central-directory record sits at the end, after an optional comment
  let at = -1;
  const first = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= first; i--) {
    if (getU32(bytes, i) === SIG_END) {
      at = i;
      break;
    }
  }
  if (at < 0) throw new Error('zip: no end-of-central-directory record (not a zip file?)');
  const count = getU16(bytes, at + 10);
  let cur = getU32(bytes, at + 16);
  const decoder = new TextDecoder('utf-8');
  const out: ZipDirEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (getU32(bytes, cur) !== SIG_CENTRAL) throw new Error(`zip: central directory entry ${i} is malformed`);
    const nameLen = getU16(bytes, cur + 28);
    const extraLen = getU16(bytes, cur + 30);
    const commentLen = getU16(bytes, cur + 32);
    out.push({
      name: decoder.decode(bytes.subarray(cur + 46, cur + 46 + nameLen)),
      method: getU16(bytes, cur + 10),
      crc: getU32(bytes, cur + 16),
      compSize: getU32(bytes, cur + 20),
      size: getU32(bytes, cur + 24),
      offset: getU32(bytes, cur + 42),
    });
    cur += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * The bytes of one entry, with its CRC checked (a truncated or edited archive cannot pass quietly).
 * The inflate function may be synchronous (zlib in node) or asynchronous (DecompressionStream in a browser).
 */
export async function readZipEntry(
  bytes: Uint8Array,
  entry: ZipDirEntry,
  inflateRaw?: (b: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<Uint8Array> {
  if (getU32(bytes, entry.offset) !== SIG_LOCAL) throw new Error(`zip: ${entry.name} has no local header`);
  const nameLen = getU16(bytes, entry.offset + 26);
  const extraLen = getU16(bytes, entry.offset + 28);
  const start = entry.offset + 30 + nameLen + extraLen;
  const comp = bytes.subarray(start, start + entry.compSize);
  let out: Uint8Array;
  if (entry.method === 0) out = comp.slice();
  else if (entry.method === 8) {
    if (inflateRaw === undefined) throw new Error(`zip: ${entry.name} is deflated and no inflate was given`);
    out = await inflateRaw(comp);
  } else throw new Error(`zip: ${entry.name} uses unsupported compression method ${entry.method}`);
  if (out.length !== entry.size) throw new Error(`zip: ${entry.name} is ${out.length} bytes, expected ${entry.size}`);
  const got = crc32(out);
  if (got !== entry.crc) throw new Error(`zip: ${entry.name} fails its CRC (${got.toString(16)} != ${entry.crc.toString(16)})`);
  return out;
}

/** Every entry decompressed and checked, keyed by name. */
export async function unzipAll(
  bytes: Uint8Array,
  inflateRaw?: (b: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const entry of readZipDirectory(bytes)) out.set(entry.name, await readZipEntry(bytes, entry, inflateRaw));
  return out;
}
