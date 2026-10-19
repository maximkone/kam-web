// pack.ts — the browser side of a "KaM data pack": the zip tools/pack/cli.ts builds out of a player's own KaM
// Remake install, read straight in the page.
//
// Why this exists next to the folder picker: a locked-down PC may not allow the File System Access API at
// all, and extracting an archive is another thing to be allowed to do. A plain <input type=file> is allowed
// everywhere, so the same data as one .zip makes the client work on any machine - with the art still never
// leaving the player's own devices.
import { readZipDirectory, readZipEntry } from '../../../packages/archive/zip.ts';
import type { ZipDirEntry } from '../../../packages/archive/zip.ts';
import type { DirListing, DirTree } from './localsource.ts';

/** Deflate expansion of a zip entry (method 8) in the page. */
export async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface ZipTree extends DirTree {
  /** Every entry, for the panel's own counts. */
  entries: ZipDirEntry[];
}

/** A read-only DirTree over the entries of an archive, so localsource.ts cannot tell it from a folder. */
export function zipTree(bytes: Uint8Array): ZipTree {
  const entries = readZipDirectory(bytes);
  const byName = new Map(entries.map((e) => [e.name, e]));
  const dirs = new Map<string, { dirs: Set<string>; files: string[] }>();
  const ensure = (dir: string): { dirs: Set<string>; files: string[] } => {
    let d = dirs.get(dir);
    if (d === undefined) {
      d = { dirs: new Set(), files: [] };
      dirs.set(dir, d);
    }
    return d;
  };
  ensure('');
  for (const entry of entries) {
    const parts = entry.name.split('/');
    const file = parts.pop();
    if (file === undefined) continue;
    let dir = '';
    for (const part of parts) {
      ensure(dir).dirs.add(part);
      dir = dir === '' ? part : `${dir}/${part}`;
    }
    ensure(dir).files.push(file);
  }

  return {
    entries,
    async list(rel: string): Promise<DirListing | null> {
      const d = dirs.get(rel);
      if (d === undefined) return null;
      return { dirs: [...d.dirs].sort(), files: [...d.files].sort() };
    },
    async read(rel: string): Promise<Uint8Array | null> {
      // map folders are named by their users, so a case difference must not hide a file
      const entry = byName.get(rel) ?? entries.find((e) => e.name.toLowerCase() === rel.toLowerCase());
      if (entry === undefined) return null;
      return readZipEntry(bytes, entry, inflateRaw);
    },
  };
}
