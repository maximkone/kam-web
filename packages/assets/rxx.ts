// rxx.ts — decoder for KaM Remake sprite containers (.rxx).
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
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export type RxxFormat = 'rxx0' | 'rxx1' | 'rxx2';

export interface RxxSprite {
  index: number;
  w: number;
  h: number;
  px: number;
  py: number;
  rgba: Buffer;
  mask: Buffer | null;
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

function bail(filePath: string, why: string): never {
  throw new Error(`rxx: ${filePath}: ${why}`);
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function inflate(filePath: string, bytes: Buffer): Buffer {
  try {
    return inflateSync(bytes);
  } catch (err) {
    return bail(filePath, `zlib inflate failed (${reason(err)})`);
  }
}

function readContainer(filePath: string, file: Buffer): { format: RxxFormat; payload: Buffer } {
  if (file.length < 2) bail(filePath, 'file shorter than 2 bytes');
  const magic = file.subarray(0, 4).toString('latin1');
  if (magic === 'RXX1') {
    if (file.length < 4 + 32) bail(filePath, `RXX1 header truncated (${file.length} bytes)`);
    return { format: 'rxx1', payload: inflate(filePath, file.subarray(4 + 32)) };
  }
  if (magic === 'RXX2') {
    if (file.length < 6) bail(filePath, `RXX2 header truncated (${file.length} bytes)`);
    const metadataLen = file.readUInt16LE(4);
    if (file.length < 6 + metadataLen) {
      bail(filePath, `RXX2 metadata length ${metadataLen} exceeds file size ${file.length}`);
    }
    return { format: 'rxx2', payload: inflate(filePath, file.subarray(6 + metadataLen)) };
  }
  if (file[0] === 0x78 && file[1] === 0xda) {
    return { format: 'rxx0', payload: inflate(filePath, file) };
  }
  bail(
    filePath,
    `unknown container: first bytes ${file.subarray(0, 4).toString('hex')} ` +
      '(expected RXX1, RXX2 or a legacy zlib 78 da header)',
  );
}

function parsePayload(payload: Buffer, layout: Layout): { count: number; sprites: RxxSprite[] } {
  const bad = (why: string): never => {
    throw new Error(why);
  };
  if (payload.length < 4) bad('payload shorter than the 4-byte sprite count');
  const count = payload.readInt32LE(0);
  if (count < 0 || 4 + count > payload.length) {
    bad(`sprite count ${count} does not fit the ${payload.length}-byte payload`);
  }

  let o = 4;
  const flags = payload.subarray(o, o + count);
  o += count;

  const sprites: RxxSprite[] = [];
  for (let i = 0; i < count; i++) {
    const flag = flags[i];
    if (flag === 0) continue;
    if (flag !== 1) bad(`flag[${i}] = ${flag}, expected 0 or 1`);

    if (o + 4 > payload.length) bad(`sprite ${i}: truncated before size`);
    const w = payload.readUInt16LE(o);
    const h = payload.readUInt16LE(o + 2);
    o += 4;
    if (w < 1 || w > MAX_DIM || h < 1 || h > MAX_DIM) {
      bad(`sprite ${i}: size ${w}x${h} outside 1..${MAX_DIM}`);
    }

    let px: number;
    let py: number;
    if (layout.modern) {
      if (o + 4 > payload.length) bad(`sprite ${i}: truncated before pivot`);
      px = payload.readInt16LE(o);
      py = payload.readInt16LE(o + 2);
      o += 4;
      if (layout.unitsRect) {
        if (o + 8 > payload.length) bad(`sprite ${i}: truncated before SizeNoShadow rect`);
        o += 8; // left/top/right/bottom, not part of the M0 output contract
      }
    } else {
      if (o + 8 > payload.length) bad(`sprite ${i}: truncated before pivot`);
      px = payload.readInt32LE(o);
      py = payload.readInt32LE(o + 4);
      o += 8;
    }

    const pixels = w * h;
    if (o + pixels * 4 > payload.length) {
      bad(`sprite ${i}: rgba needs ${pixels * 4} bytes, only ${payload.length - o} left`);
    }
    const rgba = payload.subarray(o, o + pixels * 4);
    o += pixels * 4;

    if (o + 1 > payload.length) bad(`sprite ${i}: missing hasMask byte`);
    const hasMask = payload[o];
    o += 1;
    if (hasMask !== 0 && hasMask !== 1) bad(`sprite ${i}: hasMask = ${hasMask}, expected 0 or 1`);

    let mask: Buffer | null = null;
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

/** Decode one `.rxx` sprite pack; throws an Error naming the file and reason when no layout validates. */
export function decodeRxx(filePath: string, packName: string): RxxPack {
  let file: Buffer;
  try {
    file = readFileSync(filePath);
  } catch (err) {
    return bail(filePath, `cannot read file (${reason(err)})`);
  }
  const { format, payload } = readContainer(filePath, file);

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
  return bail(filePath, `no layout validated — ${problems.join(' | ')}`);
}
