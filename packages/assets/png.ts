// png.ts — zero-dependency PNG encoder: RGBA8, color type 6, straight alpha.
// Approach copied from the verified spike (rxx_peek2.mjs / rxx_sheet.mjs):
// filter-0 rows + zlib deflate. Straight alpha, no premultiply, no interlace.
import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

/** Encode `w`x`h` RGBA8 pixels (row-major, 4 bytes/px, straight alpha) as a PNG file buffer. */
export function toPng(w: number, h: number, rgba: Buffer): Buffer {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error(`png: bad dimensions ${w}x${h}`);
  }
  if (rgba.length < w * h * 4) {
    throw new Error(`png: ${w}x${h} needs ${w * h * 4} rgba bytes, got ${rgba.length}`);
  }
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    // filter byte 0 (None); transparent areas stay all-zero and compress well
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
