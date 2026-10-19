// atlas.ts — shelf packer + manifest builder: decoded RXX packs -> sheet pixels + JSON manifest. Pure:
// no node builtins, so the browser packs the same sheets in a worker (docs/DEPLOY.md section 4) and turns
// them into PNGs with a canvas; the node side (`toPng` + writing files) is tools/import/write.ts.
//
// Output contract: docs/M0-SPIKE.md section 3. Sheets are 2048 wide, max 4096 tall,
// sprites keep index order, a full sheet is sealed and a new one opened.
// Masks go to their own sheets; the mask byte is encoded as alpha with RGB (255,0,0) where set
// (pixels with mask 0 stay all-zero/transparent), so "draw the mask sheet as red where set"
// is a plain alpha-blended overlay.
import type { RxxPack } from './rxx.ts';

export const SHEET_W = 2048;
export const SHEET_H = 4096;

export interface AtlasSheet {
  file: string;
  w: number;
  h: number;
}

export interface AtlasSpriteEntry {
  i: number;
  w: number;
  h: number;
  px: number;
  py: number;
  s: number;
  x: number;
  y: number;
  ms: number;
  mx: number;
  my: number;
}

export interface AtlasManifest {
  pack: string;
  format: string;
  count: number;
  present: number;
  sheets: AtlasSheet[];
  maskSheets: AtlasSheet[];
  sprites: AtlasSpriteEntry[];
}

/** One sealed sheet's pixels (RGBA8, row-major) plus the name the manifest refers to it by. */
export interface AtlasSheetData extends AtlasSheet {
  rgba: Uint8Array;
}

export interface AtlasBuild {
  manifest: AtlasManifest;
  sheets: AtlasSheetData[];
  maskSheets: AtlasSheetData[];
}

interface Shelf {
  penX: number;
  penY: number;
  shelfH: number;
  usedH: number;
}

interface Sheet {
  data: Uint8Array;
  shelf: Shelf;
}

function newSheet(): Sheet {
  return { data: new Uint8Array(SHEET_W * SHEET_H * 4), shelf: { penX: 0, penY: 0, shelfH: 0, usedH: 0 } };
}

/** Place a w x h sprite on the sheet's current shelf; null when a fresh sheet is needed first. */
function place(sheet: Sheet, w: number, h: number): { x: number; y: number } | null {
  const s = sheet.shelf;
  if (s.penX + w > SHEET_W) {
    s.penY += s.shelfH;
    s.penX = 0;
    s.shelfH = 0;
  }
  if (s.penY + h > SHEET_H) return null;
  const at = { x: s.penX, y: s.penY };
  s.penX += w;
  if (h > s.shelfH) s.shelfH = h;
  if (s.penY + s.shelfH > s.usedH) s.usedH = s.penY + s.shelfH;
  return at;
}

function blit(sheet: Sheet, x: number, y: number, w: number, h: number, rgba: Uint8Array): void {
  for (let row = 0; row < h; row++) {
    sheet.data.set(rgba.subarray(row * w * 4, (row + 1) * w * 4), ((y + row) * SHEET_W + x) * 4);
  }
}

function blitMask(sheet: Sheet, x: number, y: number, w: number, h: number, mask: Uint8Array): void {
  for (let row = 0; row < h; row++) {
    let d = ((y + row) * SHEET_W + x) * 4;
    let s = row * w;
    for (let col = 0; col < w; col++, d += 4, s++) {
      const a = mask[s]!;
      if (a !== 0) {
        sheet.data[d] = 255; // red
        sheet.data[d + 3] = a;
      }
    }
  }
}

/** Pack a decoded pack into sheets + manifest (`<Pack>.json`, `<Pack>.<n>.png`, `<Pack>.m<n>.png`). */
export function buildAtlasData(pack: RxxPack): AtlasBuild {
  const sheets: AtlasSheetData[] = [];
  const maskSheets: AtlasSheetData[] = [];
  const entries: AtlasSpriteEntry[] = [];

  let dataSheet: Sheet | null = null;
  let maskSheet: Sheet | null = null;

  function seal(sheet: Sheet, file: string, into: AtlasSheetData[]): void {
    const h = sheet.shelf.usedH;
    into.push({ file, w: SHEET_W, h, rgba: sheet.data.slice(0, SHEET_W * h * 4) });
  }

  for (const sp of pack.sprites) {
    if (sp.w > SHEET_W || sp.h > SHEET_H) {
      throw new Error(
        `atlas: ${pack.pack}: sprite ${sp.index} is ${sp.w}x${sp.h}, larger than sheet ${SHEET_W}x${SHEET_H}`,
      );
    }

    if (dataSheet === null) dataSheet = newSheet();
    let at = place(dataSheet, sp.w, sp.h);
    if (at === null) {
      seal(dataSheet, `${pack.pack}.${sheets.length}.png`, sheets);
      dataSheet = newSheet();
      at = place(dataSheet, sp.w, sp.h);
    }
    if (at === null) throw new Error(`atlas: ${pack.pack}: sprite ${sp.index} does not fit a fresh sheet`);
    blit(dataSheet, at.x, at.y, sp.w, sp.h, sp.rgba);

    let ms = -1;
    let mx = 0;
    let my = 0;
    if (sp.mask !== null) {
      if (maskSheet === null) maskSheet = newSheet();
      let mat = place(maskSheet, sp.w, sp.h);
      if (mat === null) {
        seal(maskSheet, `${pack.pack}.m${maskSheets.length}.png`, maskSheets);
        maskSheet = newSheet();
        mat = place(maskSheet, sp.w, sp.h);
      }
      if (mat === null) {
        throw new Error(`atlas: ${pack.pack}: sprite ${sp.index} does not fit a fresh mask sheet`);
      }
      blitMask(maskSheet, mat.x, mat.y, sp.w, sp.h, sp.mask);
      ms = maskSheets.length;
      mx = mat.x;
      my = mat.y;
    }

    entries.push({
      i: sp.index,
      w: sp.w,
      h: sp.h,
      px: sp.px,
      py: sp.py,
      s: sheets.length, // index of the still-open data sheet, sealed in order
      x: at.x,
      y: at.y,
      ms,
      mx,
      my,
    });
  }

  if (dataSheet !== null) seal(dataSheet, `${pack.pack}.${sheets.length}.png`, sheets);
  if (maskSheet !== null) seal(maskSheet, `${pack.pack}.m${maskSheets.length}.png`, maskSheets);

  const manifest: AtlasManifest = {
    pack: pack.pack,
    format: pack.format,
    count: pack.count,
    present: pack.sprites.length,
    sheets: sheets.map((s) => ({ file: s.file, w: s.w, h: s.h })),
    maskSheets: maskSheets.map((s) => ({ file: s.file, w: s.w, h: s.h })),
    sprites: entries,
  };
  return { manifest, sheets, maskSheets };
}
