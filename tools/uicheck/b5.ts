// tools/uicheck/b5.ts - REAL browser check of what a public deployment must say when it has no KaM files.
//
// A static host (GitHub Pages here) ships the client without a single sprite, so /maps and /out/atlas are
// 404. Maxim hit what that used to produce on the live site: pressing start gave "Error: fetch
// /out/atlas/GUI.json: 404" and a game that never drew anything.
//
// The dev server cannot reproduce that (it always answers), so this check exports the site exactly as the
// pages workflow does, serves the folder with a plain static server, and drives a real browser over CDP.
//
//   node tools/uicheck/b5.ts --check
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => existsSync(p));
if (EDGE === undefined) {
  console.error('B5 FAIL: no Edge or Chrome found');
  process.exit(1);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
};
const PORT = 8195;
const CDP = 9385;
const site = resolve(join(process.env.TEMP ?? tmpdir(), 'opencode', 'b5-export'));
const profile = mkdtempSync(join(tmpdir(), 'kam-b5-'));
const problems: string[] = [];
const notes: string[] = [];
const ok = (cond: boolean, what: string): void => {
  if (!cond) problems.push(what);
  notes.push(`${cond ? 'ok  ' : 'FAIL'} ${what}`);
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 1. the deployed shape: the export the pages workflow uploads, served as a static host serves it
rmSync(site, { recursive: true, force: true });
const exported = spawnSync(process.execPath, ['--no-warnings', 'apps/web/serve.ts', '--export', site], { encoding: 'utf8' });
ok(exported.status === 0 && existsSync(join(site, 'game.html')), `the export produced a site (${exported.stdout.trim().split('\n').pop()})`);

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (path.endsWith('/')) path += 'index.html';
  const abs = join(site, normalize(path).replace(/^[/\\]+/, ''));
  if (!abs.startsWith(site) || !existsSync(abs) || !statSync(abs).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`404 ${path}`);
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' });
  createReadStream(abs).pipe(res);
});
await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));

// 2. a real browser on that host
const edge = spawn(EDGE, [
  '--headless=new',
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1280,900',
  'about:blank',
], { stdio: 'ignore', windowsHide: true });

let ws: WebSocket | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const consoleErrors: string[] = [];
const send = (method: string, params: object = {}): Promise<any> => {
  const id = nextId++;
  ws!.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
};
const evaluate = async (expr: string): Promise<any> => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate failed');
  return r.result?.value;
};

try {
  let target: any = null;
  for (let i = 0; i < 60 && target === null; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json() as any[];
      target = list.find((t) => t.type === 'page') ?? null;
    } catch {
      await sleep(250);
    }
  }
  if (target === null) throw new Error('the browser never opened a debugging port');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((res, rej) => {
    ws!.addEventListener('open', () => res(), { once: true });
    ws!.addEventListener('error', () => rej(new Error('cannot attach to the browser')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params?.exceptionDetails?.text ?? 'exception');
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push((msg.params.args ?? []).map((a: any) => a.value ?? a.description ?? '').join(' '));
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  // a headless tab is neither focused nor visible, and without both the page never runs its loops
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await send('Page.setWebLifecycleState', { state: 'active' });
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/game.html` });
  await sleep(3000);

  const status = String(await evaluate("document.getElementById('localstatus').textContent"));
  const startDisabled = await evaluate("document.getElementById('startbtn').disabled");
  const startLabel = String(await evaluate("document.getElementById('startbtn').textContent"));
  const rows = await evaluate("document.querySelectorAll('.maprow').length");
  const body = String(await evaluate('document.body.innerText'));
  notes.push(`panel "${status.slice(0, 80)}", ${rows} map row(s), start "${startLabel}" (disabled=${startDisabled})`);

  ok(/no assets/i.test(status), 'the setup screen reports that it has no KaM files');
  ok(/use my KaM folder/i.test(status), 'and names the button that fixes it');
  ok(startDisabled === true, 'start is refused while there is nothing to draw with');
  ok(/use my KaM folder first/i.test(startLabel), `the start button says why ("${startLabel}")`);
  ok(rows === 0, `no maps are offered (${rows})`);
  ok(!/Error: fetch \/out\/atlas/.test(body), 'the bare "Error: fetch /out/atlas/...: 404" is gone');

  // Expected here: the page legitimately asks for files this host does not have (they 404). Anything else
  // - an uncaught exception in particular - is a failure.
  const unexpected = consoleErrors.filter((m) => !/Failed to load resource|404|ERR_/.test(m));
  for (const m of unexpected.slice(0, 3)) ok(false, `unexpected console error: ${m}`);
  ok(unexpected.length === 0, `no uncaught exception on a host without KaM files (${consoleErrors.length} expected 404 message(s))`);
} catch (err) {
  ok(false, `the check could not finish: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  if (ws !== null) ws.close();
  server.close();
  spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${profile.replace(/\\/g, '\\\\')}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { stdio: 'ignore' });
  for (const n of notes) console.log(n);
  if (problems.length === 0) {
    console.log('B5 PASS (a host with no KaM files explains itself and refuses to start)');
    process.exit(0);
  }
  console.log(`B5 FAIL (${problems.length} problem(s))`);
  process.exit(1);
}
