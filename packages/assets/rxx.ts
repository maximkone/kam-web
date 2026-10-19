// rxx.ts — decoder for KaM Remake sprite containers (.rxx). Pure: bytes in, bytes out, no node builtins,
// so the browser can run the same decoder (docs/DEPLOY.md section 4); the node side (readFileSync +
// zlib.inflateSync) lives in tools/import/write.ts, the browser side injects DecompressionStream.
//
// Container (docs/M0-SPIKE.md section 2.1, KM_ResSprites.pas ReadRXZHeader):
//   'RXX1' + 32 metadata bytes + zlib | 'RXX2' + u16 metadataLen + metadataLen bytes + zlib | '78 da' zlib at 0.
// Payload (section 2.2, verified for rxx0 against the user's Units.rxx; modern layout per
// KM_ResSpritesEdit.pas SaveToRXXFile, where Pivot is SmallInt and rxUnits packs carry a
// 4 x SmallInt SizeNoShadow rect between pivot and RGBA):
//   i32 count | u8 flags[count] | per present sprite: u16 sizeX,sizeY | pivot (i32,i32 legacy / i16,i16 modern)
//   | [i16 left,top,right,bottom if modern Units] | rgba[sizeX*sizeY*4] | u8 hasMask | u8 mask[sizeX*sizeY] if set.
//
// Auto-detect: try the legacy layout first, on validation failure retry modern; both failing throws.

export type RxxFormat = 'rxx0' | 'rxx1' | 'rxx2';

export interface RxxSprite {
  index: number;
  w: number;
  h: number;
  px: number;
  py: number;
  rgba: Uint8Array;
  mask: Uint8Array | null;
}

export interface RxxPack {
  pack: string;
  format: RxxFormat;
  count: number;
  sprites: RxxSprite[];
  /** Bytes left after the parse. A valid parse always yields 0; exposed for the CLI's --check. */
  leftover: number;
}

interface Layout {
  modern: boolean;
  unitsRect: boolean;
}

const MAX_DIM = 4096;

function bail(what: string, why: string): never {
  throw new Error(`rxx: ${what}: ${why}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Where the zlib payload starts in a container, and which format it is. Pure: the caller inflates
 * `file.subarray(headerLen)` itself (node: zlib.inflateSync, browser: DecompressionStream('deflate'),
 * both of which read the same zlib wrapper).
 */
export function readRxxContainer(file: Uint8Array): { format: RxxFormat; headerLen: number } {
  if (file.length < 2) bail('file', 'file shorter than 2 bytes');
  const magic = String.fromCharCode(file[0]!, file[1]!, file[2]!, file[3]!);
  if (magic === 'RXX1') {
    if (file.length < 4 + 32) bail('file', `RXX1 header truncated (${file.length} bytes)`);
    return { format: 'rxx1', headerLen: 4 + 32 };
  }
  if (magic === 'RXX2') {
    if (file.length < 6) bail('file', `RXX2 header truncated (${file.length} bytes)`);
    const metadataLen = file[4]! | (file[5]! << 8);
    if (file.length < 6 + metadataLen) {
      bail('file', `RXX2 metadata length ${metadataLen} exceeds file size ${file.length}`);
    }
    return { format: 'rxx2', headerLen: 6 + metadataLen };
  }
  if (file[0] === 0x78 && file[1] === 0xda) return { format: 'rxx0', headerLen: 0 };
  const head = Array.from(file.subarray(0, 4), (b) => b.toString(16).padStart(2, '0')).join(' ');
  bail('file', `unknown container: first bytes ${head} (expected RXX1, RXX2 or a legacy zlib 78 da header)`);
}

function parsePayload(payload: Uint8Array, layout: Layout): { count: number; sprites: RxxSprite[] } {
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const bad = (why: string): never => {
    throw new Error(why);
  };
  if (payload.length < 4) bad('payload shorter than the 4-byte sprite count');
  const count = view.getInt32(0, true);
  if (count < 0 || 4 + count > payload.length) {
    bad(`sprite count ${count} does not fit the ${payload.length}-byte payload`);
  }

  let o = 4;
  const flags = payload.subarray(o, o + count);
  o += count;

  const sprites: RxxSprite[] = [];
  for (let i = 0; i < count; i++) {
    const flag = flags[i]!;
    if (flag === 0) continue;
    if (flag !== 1) bad(`flag[${i}] = ${flag}, expected 0 or 1`);

    if (o + 4 > payload.length) bad(`sprite ${i}: truncated before size`);
    const w = view.getUint16(o, true);
    const h = view.getUint16(o + 2, true);
    o += 4;
    if (w < 1 || w > MAX_DIM || h < 1 || h > MAX_DIM) {
      bad(`sprite ${i}: size ${w}x${h} outside 1..${MAX_DIM}`);
    }

    let px: number;
    let py: number;
    if (layout.modern) {
      if (o + 4 > payload.length) bad(`sprite ${i}: truncated before pivot`);
      px = view.getInt16(o, true);
      py = view.getInt16(o + 2, true);
      o += 4;
      if (layout.unitsRect) {
        if (o + 8 > payload.length) bad(`sprite ${i}: truncated before SizeNoShadow rect`);
        o += 8; // left/top/right/bottom, not part of the M0 output contract
      }
    } else {
      if (o + 8 > payload.length) bad(`sprite ${i}: truncated before pivot`);
      px = view.getInt32(o, true);
      py = view.getInt32(o + 4, true);
      o += 8;
    }

    const pixels = w * h;
    if (o + pixels * 4 > payload.length) {
      bad(`sprite ${i}: rgba needs ${pixels * 4} bytes, only ${payload.length - o} left`);
    }
    const rgba = payload.subarray(o, o + pixels * 4);
    o += pixels * 4;

    if (o + 1 > payload.length) bad(`sprite ${i}: missing hasMask byte`);
    const hasMask = payload[o]!;
    o += 1;
    if (hasMask !== 0 && hasMask !== 1) bad(`sprite ${i}: hasMask = ${hasMask}, expected 0 or 1`);

    let mask: Uint8Array | null = null;
    if (hasMask === 1) {
      if (o + pixels > payload.length) {
        bad(`sprite ${i}: mask needs ${pixels} bytes, only ${payload.length - o} left`);
      }
      mask = payload.subarray(o, o + pixels);
      o += pixels;
    }
    sprites.push({ index: i, w, h, px, py, rgba, mask });
  }

  const leftover = payload.length - o;
  if (leftover !== 0) bad(`parse left ${leftover} trailing byte(s)`);
  return { count, sprites };
}

function layoutName(layout: Layout): string {
  if (!layout.modern) return 'rxx0 legacy';
  return layout.unitsRect ? 'RXX1/RXX2 modern + Units rect' : 'RXX1/RXX2 modern';
}

/** Decode one already-inflated payload (the container header stripped, the zlib stream expanded). */
export function decodeRxxPayload(payload: Uint8Array, packName: string, format: RxxFormat = 'rxx0'): RxxPack {
  const attempts: Layout[] = [
    { modern: false, unitsRect: false },
    { modern: true, unitsRect: /^units/i.test(packName) },
  ];
  const problems: string[] = [];
  for (const layout of attempts) {
    try {
      const parsed = parsePayload(payload, layout);
      return { pack: packName, format, count: parsed.count, sprites: parsed.sprites, leftover: 0 };
    } catch (err) {
      problems.push(`${layoutName(layout)}: ${reason(err)}`);
    }
  }
  return bail(packName, `no layout validated — ${problems.join(' | ')}`);
}

/**
 * Decode one `.rxx` pack from its file bytes. `inflate` expands the zlib stream the container holds:
 * node passes `(b) => inflateSync(b)`, the browser passes a DecompressionStream wrapper (async callers
 * can await their own inflate first and call `decodeRxxPayload` directly). `label` only names the file
 * in error messages.
 */
export function decodeRxxBytes(
  file: Uint8Array,
  packName: string,
  inflate: (zlibBytes: Uint8Array) => Uint8Array,
  label = packName,
): RxxPack {
  let container: { format: RxxFormat; headerLen: number };
  try {
    container = readRxxContainer(file);
  } catch (err) {
    return bail(label, reason(err).replace(/^rxx: file: /, ''));
  }
  let payload: Uint8Array;
  try {
    payload = inflate(file.subarray(container.headerLen));
  } catch (err) {
    return bail(label, `zlib inflate failed (${reason(err)})`);
  }
  const pack = decodeRxxPayload(payload, packName, container.format);
  return pack;
}
