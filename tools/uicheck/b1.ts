// tools/uicheck/b1.ts - REAL browser check of the B1 game shell (replaces the earlier stub that only printed PASS).
// Starts its own dev server and a headless Edge (both are this tool's children and are stopped at the end), drives the
// page over CDP (Node 24 built-in WebSocket + fetch, 127.0.0.1 only) and fails on any broken step.
//   node tools/uicheck/b1.ts --check [--web-port 8140] [--cdp-port 9340]
// Screenshots go to <TEMP>/opencode/b1/*.png (absolute path, printed).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const arg = (name: string, d: string): string => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : d; };
const WEB = Number(arg('--web-port', '8140'));
const CDP = Number(arg('--cdp-port', '9340'));
const SHOTS = join(process.env.TEMP ?? 'C:\\Windows\\Temp', 'opencode', 'b1');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let lastClient: Cdp | null = null;
const children: ChildProcess[] = [];
const stopChildren = (): void => { for (const ch of children) { try { ch.kill(); } catch { /* gone */ } } };
const failures: string[] = [];
const notes: string[] = [];
const expect = (ok: boolean, what: string): void => { if (!ok) failures.push(what); };
const step = (s: string): void => { if (process.env.B1_DEBUG) process.stderr.write('[b1] ' + s + '\n'); };

async function waitFor<T>(fn: () => Promise<T | null | false | undefined>, what: string, ms = 60000, every = 250): Promise<T> {
  const t = Date.now();
  for (;;) {
    let v: T | null | false | undefined = null;
    try { v = await fn(); } catch { v = null; }
    if (v !== null && v !== false && v !== undefined) return v;
    if (Date.now() - t > ms) throw new Error('timeout waiting for ' + what);
    await sleep(every);
  }
}

interface Cdp { send(method: string, params?: object): Promise<any>; eval(expr: string): Promise<any>; consoleErrors: string[]; close(): void }

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('ws error')); });
  let id = 0;
  const pending = new Map<number, (m: any) => void>();
  const consoleErrors: string[] = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') consoleErrors.push('exception: ' + (m.params?.exceptionDetails?.exception?.description ?? m.params?.exceptionDetails?.text ?? '?').toString().slice(0, 200));
    if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') consoleErrors.push('console.error: ' + (m.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error' && !String(m.params.entry.url ?? '').includes('favicon.ico')) consoleErrors.push('log: ' + String(m.params.entry.text).slice(0, 160) + ' ' + String(m.params.entry.url ?? '').slice(0, 80));
  };
  const send = (method: string, params: object = {}): Promise<any> => new Promise((res, rej) => {
    const myId = ++id;
    pending.set(myId, (m) => (m.error ? rej(new Error(method + ': ' + JSON.stringify(m.error))) : res(m.result)));
    ws.send(JSON.stringify({ id: myId, method, params }));
  });
  const evalExpr = async (expr: string): Promise<any> => {
    const r = await Promise.race([send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('eval timeout 20 s (page frozen?): ' + expr.slice(0, 60))), 20000))]) as any;
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
    return r.result?.value;
  };
  return { send, eval: evalExpr, consoleErrors, close: () => ws.close() };
}

async function shot(c: Cdp, name: string): Promise<number> {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.data as string, 'base64');
  writeFileSync(join(SHOTS, name + '.png'), buf);
  return buf.length;
}

async function check(): Promise<boolean> {
  mkdirSync(SHOTS, { recursive: true });
  try {
    step('start dev server');
    const server = spawn(process.execPath, ['apps/web/serve.ts', '--port', String(WEB)], { cwd: ROOT, stdio: 'ignore' });
    children.push(server);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${WEB}/maps`)).ok, 'dev server', 90000);
    step('dev server up; start edge');
    const profile = mkdtempSync(join(SHOTS, 'edge-profile-'));
    const edge = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${CDP}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=960,600', 'about:blank'], { stdio: 'ignore' });
    children.push(edge);
    const target = await waitFor(async () => {
      const list = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      return list.find((t) => t.type === 'page')?.webSocketDebuggerUrl ?? null;
    }, 'edge page target', 30000);
    step('edge target found; connect');
    const c = await connect(target);
    lastClient = c;
    await c.send('Runtime.enable'); await c.send('Log.enable'); await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 960, height: 600, deviceScaleFactor: 1, mobile: false });

    step('connected; open game.html');
    // 1. setup screen
    await c.send('Page.navigate', { url: `http://127.0.0.1:${WEB}/game.html` });
    const mapCount = await waitFor(async () => { const n = await c.eval("document.querySelectorAll('.maprow').length"); return n > 0 ? n : null; }, 'map list', 60000);
    expect(mapCount === 243, `setup lists 243 maps (got ${mapCount})`);
    const sz0 = await shot(c, 'setup');
    notes.push(`maps=${mapCount}`);

    step('setup ok; filter+start');
    // 2. filter + pick + start
    await c.eval("(() => { const f = document.getElementById('filter'); f.value = 'Battle Sun'; f.dispatchEvent(new Event('input', { bubbles: true })); })()");
    const filtered = await c.eval("document.querySelectorAll('.maprow').length");
    expect(filtered === 1, `filter 'Battle Sun' leaves 1 map (got ${filtered})`);
    const slotRows = await c.eval("document.querySelectorAll('#slottbl tr').length");
    expect(slotRows >= 2, `slot table has human + AI rows (got ${slotRows})`);
    await waitFor(async () => (await c.eval("!document.getElementById('startbtn').disabled")) === true, 'Start button enabled (renderer ready)', 90000);
    await c.eval("document.querySelector('.maprow').click()");
    await c.eval("document.getElementById('startbtn').click()");
    const tick = async (): Promise<number> => Number(await c.eval("document.getElementById('tick').textContent"));
    const t1 = await waitFor(async () => { const t = await tick(); return t >= 20 ? t : null; }, 'tick >= 20 (the game loop runs)', 45000);
    const setupHidden = await c.eval("document.getElementById('setup').classList.contains('hide')");
    expect(setupHidden === true, 'setup panel hides when the game starts');

    step('ticking; measure');
    // 3. ticks advance, canvas is a real scene
    await sleep(2000);
    const t2 = await tick();
    expect(t2 > t1 + 5, `ticks advance at 1x (${t1} -> ${t2})`);
    const sz1 = await shot(c, 'in-game');
    expect(sz1 > 80000, `the canvas shows a textured scene (screenshot ${sz1} bytes, a black screen is < 20000)`);
    const stock = await c.eval("document.getElementById('stock').textContent");
    expect(/trunks=\d+/.test(String(stock)), `top bar shows the stock (${stock})`);

    if (process.env.B1_SERIES) {
      const series: string[] = [];
      const sample = async (label: string, n: number): Promise<void> => { for (let i = 0; i < n; i++) { const st = await c.eval('JSON.stringify(window.__gameStats)'); series.push(`${label}:${await tick()}/${st}`); await sleep(500); } };
      const w0 = Date.now(); const p0 = Number(await c.eval('performance.now()')); const d0 = Number(await c.eval('Date.now()'));
      await sleep(1000);
      const w1 = Date.now(); const p1c = Number(await c.eval('performance.now()')); const d1 = Number(await c.eval('Date.now()'));
      console.log(`[clock] node wall ${w1 - w0} ms; page performance.now ${Math.round(p1c - p0)} ms; page Date.now ${d1 - d0} ms`);
      await sample('run1x', 10);
      await c.eval("document.getElementById('pausebtn').click()"); await sample('paused', 4);
      await c.eval("document.getElementById('pausebtn').click()"); await sample('resumed', 10);
      console.log('[series every 500ms] ' + series.join(' '));
    }    // 4. pause / resume
    await c.eval("document.getElementById('pausebtn').click()");
    await sleep(300);
    const p1 = await tick(); await sleep(1500); const p2 = await tick();
    expect(p2 - p1 <= 1, `pause stops the ticks (${p1} -> ${p2})`);
    await c.eval("document.getElementById('pausebtn').click()");
    await sleep(300);

    // 5. speed 1x vs 4x
    const a1 = await tick(); await sleep(2000); const a2 = await tick();
    await c.eval("document.getElementById('speedbtn').click()"); await c.eval("document.getElementById('speedbtn').click()");
    const speedLabel = await c.eval("document.getElementById('speedbtn').textContent");
    const b1 = await tick(); await sleep(2000); const b2 = await tick();
    expect(speedLabel === '4x', `speed button reads 4x (got ${speedLabel})`);
    expect((b2 - b1) > (a2 - a1) * 1.5, `4x runs faster than 1x (${a2 - a1} vs ${b2 - b1} ticks in 2 s)`);
    notes.push(`tick ${t1}->${t2}, 1x=${a2 - a1}/2s, 4x=${b2 - b1}/2s`);

    // 6. end screen + back to setup
    await c.eval("document.getElementById('endbtn').click()");
    await sleep(300);
    const endVisible = await c.eval("!document.getElementById('end').classList.contains('hide')");
    const endTitle = await c.eval("document.getElementById('endtitle').textContent");
    expect(endVisible === true && String(endTitle).length > 0, `end screen shows (title '${endTitle}')`);
    await shot(c, 'end');
    await c.eval("document.getElementById('backbtn').click()");
    const back = await c.eval("!document.getElementById('setup').classList.contains('hide')");
    expect(back === true, 'back to setup works');

    // 7. no console errors
    expect(c.consoleErrors.length === 0, `no console errors (${c.consoleErrors.slice(0, 3).join(' | ')})`);
    notes.push(`screenshots ${SHOTS} (setup ${sz0}, in-game ${sz1} bytes)`);
    c.close();
  } catch (e) {
    failures.push('check crashed: ' + (e instanceof Error ? e.message : String(e)));
    const lc = lastClient as Cdp | null;
    if (lc !== null) failures.push('console errors so far: ' + lc.consoleErrors.slice(0, 6).join(' | '));
  } finally {
    stopChildren();
  }
  return failures.length === 0;
}

if (process.argv.includes('--check')) {
  setTimeout(() => { stopChildren(); console.log('UI B1 CHECK FAIL (overall 170 s deadline)'); for (const f of failures) console.log('  - ' + f); const lc = lastClient as Cdp | null; if (lc !== null) console.log('  - console errors: ' + lc.consoleErrors.slice(0, 6).join(' | ')); process.exit(2); }, 170000).unref();
  const ok = await check();
  if (ok) console.log(`UI B1 CHECK PASS (${notes.join('; ')})`);
  else { console.log('UI B1 CHECK FAIL'); for (const f of failures) console.log('  - ' + f); }
  process.exit(ok ? 0 : 1);
} else {
  console.log('usage: node tools/uicheck/b1.ts --check [--web-port 8140] [--cdp-port 9340]');
}
