// localassets.ts — the browser side of running the game from the player's own KaM Remake folder
// (docs/DEPLOY.md section 4): pick the folder once, build the bundle in the page, keep it in IndexedDB,
// and answer the page's own requests for /defines, /maps, /mapfile, /mission and /out/atlas from there.
//
// Nothing leaves the machine: the art and the maps stay on the player's disk, which is the only legal way
// to put this client on a public host (the game's art is TopWare's; see docs/DEPLOY.md section 4).
//
// The heavy lifting is in localsource.ts (shared with the node check); this file is the browser plumbing:
// a FileSystemDirectoryHandle tree, DecompressionStream('deflate'), OffscreenCanvas PNG encoding, IDB.
import { buildBundle } from './localsource.ts';
import type { DirListing, DirTree, LocalBundle, Progress } from './localsource.ts';

const DB_NAME = 'kam-web-local';
const DB_VERSION = 1;
const FILE_STORE = 'files';
const META_STORE = 'meta';
const META_KEY = 'bundle';
const HANDLE_KEY = 'folder';

export type LocalStatus = 'none' | 'building' | 'ready' | 'error';

export interface LocalState {
  status: LocalStatus;
  detail: string;
  files: number;
  maps: number;
  packs: number;
  builtAt: string;
  folder: string;
}

interface Meta {
  builtAt: string;
  files: number;
  maps: number;
  packs: number;
  folder: string;
}

let db: IDBDatabase | null = null;
let memory = new Map<string, Uint8Array>();
let meta: Meta | null = null;
let rootHandle: FileSystemDirectoryHandle | null = null;
let shimInstalled = false;

/** The routes this module answers instead of the network; anything else goes to the real fetch. */
const LOCAL_ROUTES = [
  /^\/defines\/[A-Za-z0-9_.-]+$/,
  /^\/maps$/,
  /^\/mission\/TownTutorial\.dat$/,
  /^\/out\/atlas\/[A-Za-z0-9_.-]+$/,
  /^\/mapfile\/[^/]+\/[^/]+\/(map|dat|txt)$/,
];

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.dat': 'application/octet-stream',
  '.map': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};

// ---- small helpers ----------------------------------------------------------

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function openDb(): Promise<IDBDatabase> {
  if (db !== null) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(FILE_STORE)) d.createObjectStore(FILE_STORE);
      if (!d.objectStoreNames.contains(META_STORE)) d.createObjectStore(META_STORE);
    };
    req.onsuccess = () => {
      db = req.result;
      resolve(req.result);
    };
    req.onerror = () => reject(new Error(`cannot open the local asset database: ${req.error?.message ?? 'unknown'}`));
  });
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(store, mode);
        const req = run(t.objectStore(store));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(new Error(`indexeddb: ${req.error?.message ?? 'request failed'}`));
      }),
  );
}

function mimeFor(url: string): string {
  const dot = url.lastIndexOf('.');
  return (dot < 0 ? undefined : MIME[url.slice(dot).toLowerCase()]) ?? 'application/octet-stream';
}

function responseFor(bytes: Uint8Array, url: string): Response {
  return new Response(new Blob([bytes as unknown as BlobPart]), {
    status: 200,
    headers: { 'content-type': mimeFor(url), 'cache-control': 'no-store' },
  });
}

// ---- the picked folder as a DirTree ----------------------------------------

/** The picked folder (and the file under it) as the DirTree localsource.ts builds from. */
function handleTree(handle: FileSystemDirectoryHandle): DirTree {
  return {
    async list(rel: string): Promise<DirListing | null> {
      const dir = await dirAtFor(handle, rel);
      if (dir === null) return null;
      const out: DirListing = { dirs: [], files: [] };
      const iterable = dir as unknown as { values(): AsyncIterable<FileSystemHandle> };
      try {
        for await (const entry of iterable.values()) {
          if (entry.kind === 'directory') out.dirs.push(entry.name);
          else out.files.push(entry.name);
        }
      } catch {
        return null;
      }
      return out;
    },
    async read(rel: string): Promise<Uint8Array | null> {
      const parts = rel.split('/').filter((p) => p !== '');
      const name = parts.pop();
      if (name === undefined) return null;
      const dir = await dirAtFor(handle, parts.join('/'));
      if (dir === null) return null;
      try {
        const file = await (await dir.getFileHandle(name)).getFile();
        return new Uint8Array(await file.arrayBuffer());
      } catch {
        return null;
      }
    },
  };
}

async function dirAtFor(handle: FileSystemDirectoryHandle, rel: string): Promise<FileSystemDirectoryHandle | null> {
  const parts = rel.split('/').filter((p) => p !== '');
  let cur = handle;
  for (const part of parts) {
    try {
      cur = await cur.getDirectoryHandle(part);
    } catch {
      return null;
    }
  }
  return cur;
}

// ---- the browser build environment -----------------------------------------

async function inflate(zlibBytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([zlibBytes as unknown as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function encodePng(w: number, h: number, rgba: Uint8Array): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('the browser refused a 2d canvas for the atlas');
  ctx.putImageData(new ImageData(Uint8ClampedArray.from(rgba), w, h), 0, 0);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

// ---- the bundle in IndexedDB ------------------------------------------------

async function putBundle(bundle: LocalBundle, folder: string): Promise<Meta> {
  const d = await openDb();
  const info: Meta = {
    builtAt: bundle.builtAt,
    files: bundle.files.size,
    maps: bundle.maps,
    packs: bundle.packs,
    folder,
  };
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction([FILE_STORE, META_STORE], 'readwrite');
    const files = t.objectStore(FILE_STORE);
    files.clear();
    for (const [url, bytes] of bundle.files) files.put(bytes, url);
    t.objectStore(META_STORE).put(info, META_KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(new Error(`indexeddb: ${t.error?.message ?? 'write failed'}`));
    t.onabort = () => reject(new Error('indexeddb: the bundle write was aborted'));
  });
  return info;
}

/** One file of the stored bundle: from memory, else from IndexedDB. */
async function bundleFile(url: string): Promise<Uint8Array | null> {
  const hit = memory.get(url);
  if (hit !== undefined) return hit;
  const bytes = await tx<Uint8Array | undefined>(FILE_STORE, 'readonly', (s) => s.get(url));
  if (bytes === undefined) return null;
  memory.set(url, bytes);
  return bytes;
}

/** The map files are not stored in the bundle: they are read from the picked folder when a map is played. */
async function mapFile(url: string): Promise<Uint8Array> {
  const hit = memory.get(url);
  if (hit !== undefined) return hit;
  const parts = url.split('/').filter((p) => p !== '');
  // /mapfile/<kind>/<name>/<ext>
  const kind = parts[1] ?? '';
  const name = parts[2] ?? '';
  const ext = parts[3] ?? 'map';
  const tree = rootHandle === null ? null : handleTree(rootHandle);
  if (tree === null) throw new Error('the KaM folder is not connected any more: choose it again');
  let bytes: Uint8Array | null = null;
  try {
    bytes = await tree.read(`${kind}/${name}/${name}.${ext}`);
  } catch (err) {
    throw new Error(`the KaM folder needs permission again (${message(err)}): click "Reconnect KaM folder"`);
  }
  if (bytes === null) throw new Error(`not in the picked folder: ${kind}\\${name}\\${name}.${ext}`);
  memory.set(url, bytes);
  return bytes;
}

function installShim(): void {
  if (shimInstalled) return;
  shimInstalled = true;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;
    if (LOCAL_ROUTES.some((r) => r.test(url))) {
      const bytes = url.startsWith('/mapfile/') ? await mapFile(url) : await bundleFile(url);
      if (bytes !== null) return responseFor(bytes, url);
    }
    return real(input as RequestInfo, init);
  };
}

// ---- the public API the page uses -------------------------------------------

function stateFromMeta(status: LocalStatus, detail: string): LocalState {
  return {
    status,
    detail,
    files: meta?.files ?? 0,
    maps: meta?.maps ?? 0,
    packs: meta?.packs ?? 0,
    builtAt: meta?.builtAt ?? '',
    folder: meta?.folder ?? '',
  };
}

/** Called at page load: if a bundle is stored, answer the page's asset requests from it. */
export async function attachLocalAssets(): Promise<LocalState> {
  try {
    const stored = await tx<Meta | undefined>(META_STORE, 'readonly', (s) => s.get(META_KEY));
    if (stored === undefined) return stateFromMeta('none', 'assets come from the server (or pick your KaM folder)');
    meta = stored;
    rootHandle = (await tx<FileSystemDirectoryHandle | undefined>(META_STORE, 'readonly', (s) => s.get(HANDLE_KEY))) ?? null;
    const count = await tx<number>(FILE_STORE, 'readonly', (s) => s.count());
    meta.files = count;
    installShim();
    return stateFromMeta('ready', `your KaM folder (${count} files, built ${stored.builtAt.slice(0, 16).replace('T', ' ')})`);
  } catch (err) {
    return stateFromMeta('error', message(err));
  }
}

/**
 * Open the folder picker, read the packs/defines/maps from it, build the atlases and keep everything in
 * this browser. Must be called from a click: the picker needs a user gesture.
 */
export async function useKaMFolder(onProgress: Progress = () => {}): Promise<LocalState> {
  try {
    const picker = (globalThis as unknown as { showDirectoryPicker?: (o: { mode: string; id: string }) => Promise<FileSystemDirectoryHandle> })
      .showDirectoryPicker;
    if (picker === undefined) {
      return stateFromMeta('error', 'this browser has no folder picker (Chrome or Edge can read your KaM folder)');
    }
    const handle = await picker.call(globalThis, { mode: 'read', id: 'kam-remake' });
    onProgress(`reading ${handle.name} ...`);
    const tree = handleTree(handle);
    const bundle = await buildBundle({ tree, inflate, encodePng }, (m) => {
      onProgress(m);
    });
    onProgress('saving the bundle in this browser ...');
    meta = await putBundle(bundle, handle.name);
    rootHandle = handle;
    memory = new Map(bundle.files);
    await tx<undefined>(META_STORE, 'readwrite', (s) => s.put(handle, HANDLE_KEY) as unknown as IDBRequest<undefined>);
    installShim();
    return stateFromMeta('ready', `your KaM folder (${bundle.files.size} files, ${bundle.maps} maps)`);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return stateFromMeta('none', 'no folder chosen');
    return stateFromMeta('error', message(err));
  }
}

/** Ask again for read permission on the stored folder (a click is required by the browser). */
export async function reconnectLocalAssets(): Promise<LocalState> {
  try {
    if (rootHandle === null) return stateFromMeta('none', 'no KaM folder is stored in this browser');
    const h = rootHandle as unknown as {
      queryPermission?: (o: { mode: string }) => Promise<PermissionState>;
      requestPermission?: (o: { mode: string }) => Promise<PermissionState>;
    };
    const now = (await h.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (now === 'granted') return stateFromMeta('ready', 'the KaM folder is connected');
    const asked = (await h.requestPermission?.({ mode: 'read' })) ?? 'denied';
    if (asked !== 'granted') return stateFromMeta('error', 'the browser refused read access to the KaM folder');
    memory = new Map();
    return stateFromMeta('ready', 'the KaM folder is connected again');
  } catch (err) {
    return stateFromMeta('error', message(err));
  }
}

/** Drop the stored bundle (the page then needs the server's assets again). */
export async function forgetLocalAssets(): Promise<LocalState> {
  const d = await openDb();
  await new Promise<void>((resolve, reject) => {
    const t = d.transaction([FILE_STORE, META_STORE], 'readwrite');
    t.objectStore(FILE_STORE).clear();
    t.objectStore(META_STORE).delete(META_KEY);
    t.objectStore(META_STORE).delete(HANDLE_KEY);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(new Error('indexeddb: could not forget the bundle'));
  });
  memory = new Map();
  meta = null;
  rootHandle = null;
  return stateFromMeta('none', 'the stored bundle was removed; reload the page to use the server assets');
}

/** The URL paths the shim answers (for the panel's own messages and the checks). */
export const LOCAL_SHIM_ROUTES = LOCAL_ROUTES.map((r) => r.source);
