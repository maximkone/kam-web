// tools/uicheck/b1.ts - REAL browser check of the B1 game shell (setup, loop, speed/pause, end screen). Uses cdplib.ts.
//   node tools/uicheck/b1.ts --check [--web-port 8140] [--cdp-port 9340]
import { openBrowser, sleep, waitFor, startMatch } from './cdplib.ts';

const arg = (name: string, d: string): string => { const i = process.argv.indexOf(name); return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : d; };

if (!process.argv.includes('--check')) { console.log('usage: node tools/uicheck/b1.ts --check [--web-port 8140] [--cdp-port 9340]'); process.exit(1); }

const b = await openBrowser({ webPort: Number(arg('--web-port', '8140')), cdpPort: Number(arg('--cdp-port', '9340')) });
try {
  await b.goto('/game.html');
  const mapCount = await waitFor(async () => { const n = await b.eval("document.querySelectorAll('.maprow').length"); return n > 0 ? n : null; }, 'map list', 60000);
  b.expect(mapCount === 243, `setup lists 243 maps (got ${mapCount})`);
  const sz0 = await b.shot('b1-setup');
  await b.eval("(() => { const f = document.getElementById('filter'); f.value = 'Battle Sun'; f.dispatchEvent(new Event('input', { bubbles: true })); })()");
  const filtered = await b.eval("document.querySelectorAll('.maprow').length");
  b.expect(filtered === 1, `filter 'Battle Sun' leaves 1 map (got ${filtered})`);
  b.expect((await b.eval("document.querySelectorAll('#slottbl tr').length")) >= 2, 'slot table has human + AI rows');

  await startMatch(b, 'Battle Sun');
  const tick = async (): Promise<number> => Number(await b.eval("document.getElementById('tick').textContent"));
  b.expect((await b.eval("document.getElementById('setup').classList.contains('hide')")) === true, 'setup panel hides when the game starts');
  const t1 = await tick(); await sleep(2000); const t2 = await tick();
  b.expect(t2 > t1 + 5, `ticks advance at 1x (${t1} -> ${t2})`);
  const sz1 = await b.shot('b1-in-game');
  b.expect(sz1 > 80000, `the canvas shows a textured scene (screenshot ${sz1} bytes)`);
  b.expect(/trunks=\d+/.test(String(await b.eval("document.getElementById('stock').textContent"))), 'top bar shows the stock');

  await b.eval("document.getElementById('pausebtn').click()"); await sleep(300);
  const p1 = await tick(); await sleep(1500); const p2 = await tick();
  b.expect(p2 - p1 <= 1, `pause stops the ticks (${p1} -> ${p2})`);
  await b.eval("document.getElementById('pausebtn').click()"); await sleep(300);

  const a1 = await tick(); await sleep(2000); const a2 = await tick();
  await b.eval("document.getElementById('speedbtn').click()"); await b.eval("document.getElementById('speedbtn').click()");
  const b1v = await tick(); await sleep(2000); const b2v = await tick();
  b.expect((await b.eval("document.getElementById('speedbtn').textContent")) === '4x', 'speed button reads 4x');
  b.expect(b2v - b1v > (a2 - a1) * 1.5, `4x runs faster than 1x (${a2 - a1} vs ${b2v - b1v} ticks in 2 s)`);
  b.notes.push(`maps=${mapCount}`, `tick ${t1}->${t2}`, `1x=${a2 - a1}/2s 4x=${b2v - b1v}/2s`, `shots setup ${sz0} in-game ${sz1} bytes`);

  await b.eval("document.getElementById('endbtn').click()"); await sleep(300);
  b.expect((await b.eval("!document.getElementById('end').classList.contains('hide')")) === true && String(await b.eval("document.getElementById('endtitle').textContent")).length > 0, 'end screen shows');
  await b.shot('b1-end');
  await b.eval("document.getElementById('backbtn').click()");
  b.expect((await b.eval("!document.getElementById('setup').classList.contains('hide')")) === true, 'back to setup works');
} catch (e) {
  b.failures.push('check crashed: ' + (e instanceof Error ? e.message : String(e)));
}
const code = b.report('UI B1 CHECK');
await b.close();
process.exit(code);
