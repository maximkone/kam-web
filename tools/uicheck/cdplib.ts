// tools/uicheck/cdplib.ts - the shared REAL browser driver for every UI check (zero dependencies).
// Starts the dev server and a headless Edge as children of the calling check, connects over CDP (Node 24 built-in WebSocket
// + fetch, 127.0.0.1 only) and gives helpers to drive the page. A check built on this can genuinely fail; never print PASS
// from a check that did not drive the page (the first B1 check did exactly that and was rejected).
//
//   const b = await openBrowser({ webPort: 8150, cdpPort: 9350 });   // distinct ports per check run
//   await b.goto('/game.html'); await b.eval('document.title'); await b.shot('name');  b.expect(cond, 'what'); await b.close();
//   process.exit(b.report('UI X CHECK'));
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, openSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const SHOTS = join(process.env.TEMP ?? 'C:\\Windows\\Temp', 'opencode', 'uicheck');
export const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

export async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, what: string, ms = 60000, every = 250): Promise<T> {
  const t = Date.now();
  for (;;) {
    let v: T | null | false | undefined = null;
    try { v = await fn(); } catch { v = null; }
    if (v !== null && v !== false && v !== undefined) return v;
    if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what);
    await sleep(every);
  }
}

export interface Browser {
  /** Evaluate an expression in the page (20 s timeout, returns the JSON value). */
  eval(expr: string): Promise<any>;
  send(method: string, params?: object): Promise<any>;
  goto(pathOrUrl: string): Promise<void>;
  /** Save a PNG under SHOTS and return its size in bytes (a black WebGL screen is ~10 KB, a textured scene > 100 KB). */
  shot(name: string): Promise<number>;
  /** Real mouse input at page CSS pixels. */
  click(x: number, y: number, opts?: { button?: 'left' | 'right'; shift?: boolean }): Promise<void>;
  drag(x1: number, y1: number, x2: number, y2: number, opts?: { button?: 'left' | 'right' }): Promise<void>;
  key(key: string, code?: string): Promise<void>;
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  consoleErrors: string[];
  failures: string[];
  notes: string[];
  expect(ok: boolean, what: string): void;
  webBase: string;
  close(): Promise<void>;
  /** Print `<name> PASS (...)` or `<name> FAIL` plus the failures; returns the exit code. */
  report(name: string): number;
}

/** Kill a process and all its children: Edge's renderer and GPU processes outlive the main process by seconds. */
function killTree(ch: ChildProcess): void {
  if (ch.pid !== undefined && ch.exitCode === null) spawnSync('taskkill', ['/PID', String(ch.pid), '/T', '/F'], { stdio: 'ignore' });
}

/** Stop every msedge started with this run's profile dir: Edge hands its work to child processes that a tree kill of the
 *  launcher can miss (measured: a run-4 browser survived its own check with the port closed). Only processes we started match. */
function killEdgeProfile(profile: string): void {
  if (profile === '') return;
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }`], { stdio: 'ignore' });
}

/** True while something answers this URL. */
async function answers(url: string): Promise<boolean> {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}

/** Wait until nothing answers at url: a port held by another run (or an Edge still shutting down) would make this run read that
 *  process's server or browser instead of its own. Fails with a clear message instead of a timeout deep in the run. */
async function waitFree(url: string, what: string, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (await answers(url)) {
    if (Date.now() > until) throw new Error(`${what} is still answered by another process after ${ms / 1000} s; pass another port`);
    await sleep(250);
  }
}

export async function openBrowser(opts: { webPort: number; cdpPort: number; width?: number; height?: number; deadlineMs?: number }): Promise<Browser> {
  mkdirSync(SHOTS, { recursive: true });
  const width = opts.width ?? 1280, height = opts.height ?? 800;
  const children: ChildProcess[] = [];
  let profile = '';
  const failures: string[] = [];
  const notes: string[] = [];
  const consoleErrors: string[] = [];
  const stop = (): void => { for (const ch of children) { if (ch.spawnfile === EDGE) { killTree(ch); killEdgeProfile(profile); } else { try { ch.kill(); } catch { /* already gone */ } } } };
  const deadline = setTimeout(() => { stop(); console.log('UI CHECK FAIL (overall deadline)'); for (const f of failures) console.log('  - ' + f); if (consoleErrors.length > 0) console.log('  - console errors: ' + consoleErrors.slice(0, 6).join(' | ')); process.exit(2); }, opts.deadlineMs ?? 280000);
  deadline.unref();
  process.once('exit', stop);

  await waitFree(`http://127.0.0.1:${opts.webPort}/maps`, `web port ${opts.webPort}`, 20000);
  const server = spawn(process.execPath, ['apps/web/serve.ts', '--port', String(opts.webPort)], { cwd: ROOT, stdio: 'ignore' });
  children.push(server);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${opts.webPort}/maps`)).ok, 'dev server', 90000);
  // An earlier browser still holding the port would make this one fail silently (its CDP never binds): wait for it to go.
  await waitFree(`http://127.0.0.1:${opts.cdpPort}/json/version`, `CDP port ${opts.cdpPort}`, 20000);
  profile = mkdtempSync(join(SHOTS, 'edge-profile-'));
  // Edge's own log (why DevTools did not bind, if it did not) is kept next to the shots for the failure message.
  const edgeLog = `${profile}.stderr.log`;
  const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${opts.cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', `--window-size=${width},${height}`, '--enable-logging=stderr', '--v=0', 'about:blank'],
  { stdio: ['ignore', openSync(edgeLog, 'w'), 'ignore'] });
  children.push(edge);
  let edgeExit = '';
  edge.on('exit', (code, signal) => { edgeExit = `exited (${code ?? signal})`; });
  const wsUrl = await waitFor(async () => {
    const list = (await (await fetch(`http://127.0.0.1:${opts.cdpPort}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
    return list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
  }, 'edge page target', 30000).catch((e: Error) => { throw new Error(`${e.message} (CDP port ${opts.cdpPort}; Edge ${edgeExit || 'still running'}; Edge log ${edgeLog})`); });

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + String(m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? '?').slice(0, 220));
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') consoleErrors.push('console.error: ' + (m.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 220));
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error' && !String(m.params.entry.url ?? '').includes('favicon.ico')) consoleErrors.push('log: ' + String(m.params.entry.text).slice(0, 160) + ' ' + String(m.params.entry.url ?? '').slice(0, 80));
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evalExpr = async (expr: string): Promise<any> => {
    const r = (await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('eval timeout 20 s (page frozen?): ' + expr.slice(0, 60))), 20000))])) as any;
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  };
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });

  const mouse = async (type: string, x: number, y: number, button: string, buttons: number, extra: object = {}): Promise<void> => { await send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: 1, ...extra }); };
  const b: Browser = {
    eval: evalExpr, send,
    webBase: `http://127.0.0.1:${opts.webPort}`,
    goto: async (p) => { await send('Page.navigate', { url: p.startsWith('http') ? p : `http://127.0.0.1:${opts.webPort}${p}` }); },
    shot: async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); const buf = Buffer.from(r.data as string, 'base64'); writeFileSync(join(SHOTS, name + '.png'), buf); return buf.length; },
    click: async (x, y, o) => { const btn = o?.button ?? 'left'; const bs = btn === 'left' ? 1 : 2; const mod = o?.shift ? { modifiers: 8 } : {}; await mouse('mouseMoved', x, y, 'none', 0, mod); await mouse('mousePressed', x, y, btn, bs, mod); await mouse('mouseReleased', x, y, btn, 0, mod); },
    drag: async (x1, y1, x2, y2, o) => { const btn = o?.button ?? 'left'; const bs = btn === 'left' ? 1 : 2; await mouse('mouseMoved', x1, y1, 'none', 0); await mouse('mousePressed', x1, y1, btn, bs); for (let i = 1; i <= 8; i++) await mouse('mouseMoved', x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8, btn, bs); await mouse('mouseReleased', x2, y2, btn, 0); },
    key: async (key, code) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: code ?? key, text: key.length === 1 ? key : undefined }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: code ?? key }); },
    wheel: async (x, y, deltaY) => { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY }); },
    consoleErrors, failures, notes,
    expect: (ok, what) => { if (!ok) failures.push(what); },
    close: async () => {
      clearTimeout(deadline);
      try { ws.close(); } catch { /* closed */ }
      stop();
      const freeBy = Date.now() + 10000;
      while (await answers(`http://127.0.0.1:${opts.cdpPort}/json/version`) && Date.now() < freeBy) await sleep(250);
    },
    report: (name) => {
      if (consoleErrors.length > 0) failures.push(`console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 3).join(' | ')}`);
      if (failures.length === 0) { console.log(`${name} PASS (${notes.join('; ')}; screenshots ${SHOTS})`); return 0; }
      console.log(`${name} FAIL`); for (const f of failures) console.log('  - ' + f); return 1;
    },
  };
  return b;
}

/** Common flow: open /game.html, wait until the renderer is ready, pick a map by (filtered) name and start; resolves when the tick runs. */
export async function startMatch(b: Browser, mapName = 'Battle Sun'): Promise<void> {
  await b.goto('/game.html');
  await waitFor(async () => (await b.eval("document.querySelectorAll('.maprow').length")) > 0, 'map list', 60000).catch(async (e: Error) => {
    const t = Date.now();
    const probe = await fetch(`${b.webBase}/maps`, { signal: AbortSignal.timeout(60000) }).then((r) => `status ${r.status}`, (err: Error) => `failed (${err.message})`);
    throw new Error(`${e.message}; node GET /maps: ${probe} in ${Date.now() - t} ms`);
  });
  await b.eval(`(() => { const f = document.getElementById('filter'); f.value = ${JSON.stringify(mapName)}; f.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await waitFor(async () => (await b.eval("!document.getElementById('startbtn').disabled")) === true, 'Start enabled (renderer ready)', 90000);
  await b.eval(`[...document.querySelectorAll('.maprow')].find((r) => r.dataset.name === ${JSON.stringify(mapName)}).click()`);
  await b.eval("document.getElementById('startbtn').click()");
  await waitFor(async () => Number(await b.eval("document.getElementById('tick').textContent")) >= 5 ? true : null, 'the game loop runs (tick >= 5)', 90000);
}
