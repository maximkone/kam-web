// smalldesc.ts — the `SmallDesc` reader of a map .txt (KM_Maps.pas 1210-1213).
// Lives in its own module because maplist.ts (the node scanner) is not browser-safe while the browser's
// own scan (apps/web/game/localsource.ts) needs exactly this function.
/** The value on the line after the line that reads "SmallDesc" (case-insensitive); '' when there is none. */
export function parseTxtSmallDesc(text: string): string {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  for (let i = 0; i + 1 < lines.length; i++) {
    if (lines[i]!.toLowerCase() === 'smalldesc') return lines[i + 1]!;
  }
  return '';
}
