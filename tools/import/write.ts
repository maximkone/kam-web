// write.ts — the node side of the sprite import: read a .rxx from disk, decode it, write an atlas build.
// The pure halves live in packages/assets/{rxx,atlas}.ts, which the browser also runs (docs/DEPLOY.md 4);
// this file is the only part that needs node:fs / node:zlib. Used by tools/import/cli.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { buildAtlasData } from '../../packages/assets/atlas.ts';
import type { AtlasBuild } from '../../packages/assets/atlas.ts';
import { toPng } from '../../packages/assets/png.ts';
import { decodeRxxBytes } from '../../packages/assets/rxx.ts';
import type { RxxPack } from '../../packages/assets/rxx.ts';

export interface AtlasWriteResult {
  sheets: number;
  maskSheets: number;
  bytes: number;
  jsonPath: string;
}

/** Decode one `.rxx` file from disk (the node inflate is zlib.inflateSync). */
export function decodeRxxFile(filePath: string, packName: string): RxxPack {
  let file: Buffer;
  try {
    file = readFileSync(filePath);
  } catch (err) {
    throw new Error(`rxx: ${filePath}: cannot read file (${err instanceof Error ? err.message : String(err)})`);
  }
  return decodeRxxBytes(file, packName, (b) => inflateSync(b), filePath);
}

/** Write a build into `<outDir>/atlas/<Pack>.json` + `<Pack>.<n>.png` (+ `<Pack>.m<n>.png` masks). */
export function writeAtlas(build: AtlasBuild, outDir: string): AtlasWriteResult {
  const dir = join(outDir, 'atlas');
  mkdirSync(dir, { recursive: true });
  let bytes = 0;
  for (const sheet of [...build.sheets, ...build.maskSheets]) {
    const png = toPng(sheet.w, sheet.h, sheet.rgba);
    writeFileSync(join(dir, sheet.file), png);
    bytes += png.length;
  }
  const json = `${JSON.stringify(build.manifest)}\n`;
  const jsonPath = join(dir, `${build.manifest.pack}.json`);
  writeFileSync(jsonPath, json);
  bytes += Buffer.byteLength(json);
  return { sheets: build.sheets.length, maskSheets: build.maskSheets.length, bytes, jsonPath };
}
