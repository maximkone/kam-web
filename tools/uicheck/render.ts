// tools/uicheck/render.ts - REAL browser check of the game screen's renderer (B2B). Uses cdplib.ts.
//   node tools/uicheck/render.ts --check [--web-port 8170] [--cdp-port 9370]
//        [--game-sec 120] [--floor 200000] [--budget-ms 250]
// Starts a dev server and headless Edge, plays Battle Sun at 4x for --game-sec game seconds, then asserts:
//  - zero console errors / exceptions (the game screen and /play.html);
//  - at 3 cameras (village zoom 1.5, village zoom 0.5, whole map) the picture with culling off equals the picture
//    with culling on, byte for byte (same paused tick: the culling change is invisible);
//  - every in-game screenshot is above --floor bytes (a black frame is ~60 KB);
//  - frame time p95 (rAF gaps, 4x, running) under --budget-ms;
//  - the tick advances; the HUD text has no NaN/undefined and names the map with its format (finding 7: Remake r11222);
//  - the old dev viewer /play.html boots and draws a non-black scene.
// Budget measured on this machine (software WebGL, swiftshader, 1280x800): see docs/M5D-SPIKE.md section 6, B2B record.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser, startMatch, sleep, waitFor, SHOTS } from './cdplib.ts';

const arg = (name: string, d: string): string => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : d; };

if (!process.argv.includes('--check')) { console.log('usage: node tools/uicheck/render.ts --check [--web-port 8170] [--cdp-port 9370] [--game-sec 120] [--floor 200000] [--budget-ms 250]'); process.exit(1); }

const GAME_SEC = Number(arg('--game-sec', '120'));
const FLOOR = Number(arg('--floor', '200000'));
const BUDGET_MS = Number(arg('--budget-ms', '250'));
const TIMED_MS = 12000;

const RAF_SPY = `(() => { window.__rafGaps = []; let last = 0; const f = (t) => { const n = performance.now(); if (last) window.__rafGaps.push(n - last); last = n; requestAnimationFrame(f); }; requestAnimationFrame(f); })();`;

const b = await openBrowser({ webPort: Number(arg('--web-port', '8170')), cdpPort: Number(arg('--cdp-port', '9370')), deadlineMs: 900000 }).catch((e: unknown) => {
  console.log('UI RENDER CHECK FAIL');
  console.log('  - the browser did not start: ' + (e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
const tick = async (): Promise<number> => Number(await b.eval("document.getElementById('tick').textContent"));
const pausedNow = async (): Promise<boolean> => (await b.eval("document.getElementById('pausebtn').textContent")) === 'Resume';
const setPaused = async (want: boolean): Promise<void> => { if ((await pausedNow()) !== want) { await b.eval("document.getElementById('pausebtn').click()"); await sleep(300); } };
const sha = (name: string): string => createHash('sha256').update(readFileSync(join(SHOTS, name + '.png'))).digest('hex');
const percentile = (xs: number[], p: number): number => { const s = [...xs].sort((x, y) => x - y); return s.length === 0 ? -1 : s[Math.min(s.length - 1, Math.floor(s.length * p))]!; };
const shots: { name: string; bytes: number }[] = [];
let p95 = -1;
let p50 = -1;
let frames = 0;

try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: RAF_SPY });
  await startMatch(b, 'Battle Sun');
  await b.eval("document.getElementById('speedbtn').click()");
  await b.eval("document.getElementById('speedbtn').click()");
  const t0 = await tick();
  const target = t0 + Math.round(GAME_SEC * 10);
  await waitFor(async () => ((await tick()) >= target ? true : null), `game tick ${target}`, 600000, 500);

  const cams = [
    { name: 'village-z1.5', run: '(() => { window.__kamplay.jumpToVillage(0); })()' },
    { name: 'village-z0.5', run: '(() => { const h = window.__kamplay; const c = h.cam(); h.setCam(c.x, c.y, 0.5); })()' },
    // the whole map is mostly fog for hand 0 (by design), so this view is checked with the fog off
    { name: 'map-fit', noFow: true, run: '(() => { const h = window.__kamplay; const m = h.mapInfo(); h.setCam(m.mapX * 20, m.mapY * 20, Math.min(innerWidth / (m.mapX * 40), innerHeight / (m.mapY * 40))); })()' },
  ];
  for (const cam of cams) {
    await setPaused(true);
    if (cam.noFow) await b.eval('window.__kamplay.fowToggle(false)');
    await b.eval(cam.run);
    await sleep(400);
    await b.eval('window.__kamplay.culling(false)');
    await sleep(500);
    const ref = await b.shot(`render-ref-${cam.name}`);
    await b.eval('window.__kamplay.culling(true)');
    await sleep(500);
    const cull = await b.shot(`render-cull-${cam.name}`);
    if (cam.noFow) await b.eval('window.__kamplay.fowToggle(true)');
    b.expect(sha(`render-ref-${cam.name}`) === sha(`render-cull-${cam.name}`), `culling changes the picture at ${cam.name} (ref ${ref} bytes, culled ${cull} bytes)`);
    shots.push({ name: cam.name, bytes: cull });
    await setPaused(false);
    await sleep(300);
  }

  // timed frames: running at 4x, the village at zoom 1.5 (the usual view)
  await b.eval("window.__kamplay.jumpToVillage(0)");
  await b.eval('window.__rafGaps = []');
  const tA = await tick();
  await sleep(TIMED_MS);
  const tB = await tick();
  const gaps = (await b.eval('window.__rafGaps.slice()')) as number[];
  frames = gaps.length;
  p95 = percentile(gaps, 0.95);
  p50 = percentile(gaps, 0.5);
  b.expect(frames > 20 && p95 < BUDGET_MS, `frame time p95 ${p95.toFixed(0)} ms under budget ${BUDGET_MS} ms (p50 ${p50.toFixed(0)} ms, ${frames} frames)`);
  const tRate = (tB - tA) / (TIMED_MS / 1000);
  b.expect(tB > tA + 50, `the tick advances (${tA} -> ${tB}, ${tRate.toFixed(1)} ticks/s at 4x)`);
  b.expect(tB >= target, `the tick reached the game-time target ${target} (now ${tB})`);

  const hud = String(await b.eval("(document.getElementById('hud')?.textContent ?? '') + ' | ' + (document.getElementById('stock')?.textContent ?? '')"));
  b.expect(!/NaN|undefined|Infinity/.test(hud), `no NaN/undefined in the HUD text`);
  b.expect(hud.includes('Remake r11222'), `the HUD names the map with its format (finding 7; got: ${hud.slice(0, 80)})`);
  b.expect(/trunks=\d+/.test(hud), 'the top bar shows the stock');

  // the Standard maps with no gold, iron or stone near the start (docs/M5D-SPIKE.md 7c): each must start and run
  for (const name of ['Atoll', 'Equilibrium', 'Rain Season', 'Arena']) {
    await startMatch(b, name);
    const t1 = await tick();
    await sleep(1500);
    const t2 = await tick();
    const shotName = `render-start-${name.replace(/ /g, '-')}`;
    const bytes = await b.shot(shotName);
    const h = String(await b.eval("(document.getElementById('hud')?.textContent ?? '')"));
    b.expect(t2 > t1, `${name} starts and runs (tick ${t1} -> ${t2})`);
    b.expect(h.includes(name), `the HUD names ${name} (got: ${h.slice(0, 60)})`);
    shots.push({ name: shotName, bytes });
  }

  // the old dev viewer
  const errBefore = b.consoleErrors.length;
  await b.goto('/play.html');
  const hookOk = await waitFor(async () => (await b.eval("typeof window.__kamplay === 'object' && typeof window.__kamplay.tick === 'function'")) === true ? true : null, 'old viewer /play.html renderer hook', 120000, 500).then(() => true).catch(() => false);
  await sleep(2500);
  if (!hookOk) b.notes.push(`viewer diag: url ${String(await b.eval('location.href'))}, text ${String(await b.eval("document.body ? document.body.innerText.slice(0, 120) : 'no body'")).replace(/\s+/g, ' ')}, errors ${JSON.stringify(b.consoleErrors.slice(errBefore, errBefore + 3)).slice(0, 300)}`);
  b.expect(hookOk, 'the old dev viewer /play.html boots (renderer hook present)');
  const viewerShot = hookOk ? await b.shot('render-playhtml') : 0;
  b.expect(viewerShot >= FLOOR, `the old viewer draws a scene (${viewerShot} bytes, floor ${FLOOR})`);
  b.expect(b.consoleErrors.length === errBefore, `/play.html loads without console errors (${b.consoleErrors.length - errBefore} new)`);

  for (const s of shots) b.expect(s.bytes >= FLOOR, `in-game screenshot ${s.name} is not black (${s.bytes} bytes, floor ${FLOOR})`);
  b.notes.push(`game ${GAME_SEC} s at 4x`, `ticks ${t0}->${tB}`, `p50 ${p50.toFixed(0)} p95 ${p95.toFixed(0)} ms (budget ${BUDGET_MS})`, `shots ${shots.map((s) => `${s.name}=${s.bytes}`).join(' ')}`, `viewer ${viewerShot} bytes`);
} catch (e) {
  b.failures.push('check crashed: ' + (e instanceof Error ? e.message : String(e)));
  const diag = await b.eval("JSON.stringify({ url: location.href, hook: typeof window.__kamplay, text: (document.body ? document.body.innerText : '').slice(0, 100) })").catch((e2: unknown) => 'diag failed: ' + String(e2));
  b.failures.push(`page at the failure: ${String(diag).slice(0, 300)}; console errors: ${JSON.stringify(b.consoleErrors.slice(0, 3)).slice(0, 300)}`);
}
const code = b.report('UI RENDER CHECK');
await b.close();
process.exit(code);
