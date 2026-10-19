// browsercheck.js — the real-browser check: node tools/browsercheck.js [--port 8400] [--cdp-port 9410]
//
// Starts its own headless Edge over CDP, opens the game, and proves in a real browser what the headless
// check cannot: the page boots, the frame loop runs (the tick advances), the sim answers a command, and
// something is actually drawn. Node's global WebSocket does the CDP talking, so there is still no
// dependency and no build step (the same rule as the game itself).
import { spawn } from 'node:child_process';
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
};
const webPort = Number(arg('--port', 8400));
const cdpPort = Number(arg('--cdp-port', 9410));
const url = arg('--url', `http://127.0.0.1:${webPort}/`);

const problems = [];
const ok = (cond, msg) => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!cond) problems.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(path) {
  const res = await fetch(`http://127.0.0.1:${cdpPort}${path}`);
  return res.json();
}

const profile = mkdtempSync(join(tmpdir(), 'arena-cdp-'));
const edge = EDGE_CANDIDATES.find((p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
});
if (edge === undefined) {
  console.error('BROWSER CHECK FAIL: no Edge or Chrome found');
  process.exit(1);
}

const proc = spawn(
  edge,
  [
    '--headless=new',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1280,900',
    'about:blank',
  ],
  { stdio: 'ignore', windowsHide: true },
);

let ws = null;
let nextId = 1;
const pending = new Map();
const consoleErrors = [];

function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate failed');
  return r.result?.value;
}

async function main() {
  // wait for the browser's debugging endpoint, then attach to the page target
  let target = null;
  for (let i = 0; i < 60 && target === null; i++) {
    try {
      const list = await http('/json/list');
      target = list.find((t) => t.type === 'page') ?? null;
    } catch {
      await sleep(250);
    }
  }
  if (target === null) throw new Error('the browser never opened a debugging port');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cannot attach to the browser')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params?.exceptionDetails?.text ?? 'exception');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  // A headless tab is not focused and not "visible": without these two the page never runs rAF, which is
  // how a game silently comes up frozen (this exact trap bit the kam-web checks too).
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.setWebLifecycleState', { state: 'active' });
  await send('Page.navigate', { url });
  await sleep(2500);

  const boot = await evaluate('({ hook: typeof window.__arena, seed: window.__arena ? window.__arena.seed() : -1, title: document.title })');
  ok(boot.hook === 'object', `the page booted and published its hook (title "${boot.title}")`);

  const t1 = await evaluate('window.__arena.state().tick');
  await sleep(1500);
  const t2 = await evaluate('window.__arena.state().tick');
  ok(t2 > t1, `the frame loop runs in a real browser (tick ${t1} -> ${t2})`);

  const hud1 = await evaluate("document.getElementById('gold').textContent");
  const units = await evaluate('window.__arena.state().units.length');
  ok(units >= 4, `both sides start with units on the field (${units})`);
  ok(hud1 !== '0', `the HUD is wired to the sim (gold reads ${hud1})`);

  // a command must travel the same door the bots use
  const before = await evaluate('window.__arena.state().gold[0]');
  await evaluate("window.__arena.queue({ tick: window.__arena.state().tick + 2, player: 0, kind: 'train', unit: 'knight' })");
  await sleep(700);
  const after = await evaluate('window.__arena.state().gold[0]');
  const trained = await evaluate('window.__arena.state().units.filter((u) => u.owner === 0).length');
  ok(after <= before, `training through the queue spends gold (${before} -> ${after})`);
  ok(trained >= 3, `a knight joined the fight (${trained} of mine, 2 at the start)`);

  // and something must be on the canvas
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const file = join(profile, 'arena.png');
  writeFileSync(file, Buffer.from(shot.data, 'base64'));
  ok(statSync(file).size > 20000, `the canvas is drawn (screenshot ${statSync(file).size} bytes)`);

  if (consoleErrors.length > 0) {
    for (const e of consoleErrors.slice(0, 4)) ok(false, `page error: ${e}`);
  } else {
    ok(true, 'no page errors');
  }
  console.log(`BROWSER CHECK screenshot: ${file}`);
}

try {
  await main();
} catch (err) {
  ok(false, `the check could not finish: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (ws !== null) ws.close();
  // Edge spreads work over child processes; kill only the tree this check started, by its own profile dir.
  spawn('powershell', [
    '-NoProfile',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`,
  ], { stdio: 'ignore', windowsHide: true }).on('exit', () => {
    if (problems.length > 0) {
      console.error(`BROWSER CHECK FAIL (${problems.length} problem(s))`);
      process.exit(1);
    }
    console.log('BROWSER CHECK PASS (boots, ticks, takes commands, draws - in a real browser)');
    process.exit(0);
  });
}
