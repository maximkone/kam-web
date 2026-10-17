// tools/uicheck/b2.ts - REAL browser check of the B2A game UI (build menu + plans, roads, fields, minimap, house
// panels, box select + group orders, notifications). Every map action is real mouse or keyboard input through
// cdplib.ts; the sim is read through window.__gameTest (apps/web/ui/gametest.ts). Three setup grants a fresh
// skirmish does not have (a school, a barracks, a militia group: the same kind of grant tools/skirmish makes)
// are made through __gameTest. A failing step prints its name and the reason; PASS is printed only after
// the page was really driven.
// The house is built the way a player builds it: the plan, then a straight road from its builder point to the
// store's road block (wares travel by road only; a house with no road never gets its timber: docs/H1 note).
//   node tools/uicheck/b2.ts --check [--web-port 8160] [--cdp-port 9360]
//   node tools/uicheck/b2.ts --check --break [--web-port 8160] [--cdp-port 9360]   (negative: the road is skipped, so the check MUST FAIL)
import { openBrowser, sleep, waitFor } from './cdplib.ts';

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : d;
};

if (!process.argv.includes('--check')) {
  console.log('usage: node tools/uicheck/b2.ts --check [--break] [--web-port 8160] [--cdp-port 9360]');
  process.exit(1);
}
const BREAK = process.argv.includes('--break');

const b = await openBrowser({ webPort: Number(arg('--web-port', '8160')), cdpPort: Number(arg('--cdp-port', '9360')), deadlineMs: 900000 });
let current = 'start';
const step = (name: string): void => {
  current = name;
};
const must = (cond: boolean, what: string): void => {
  if (!cond) throw new Error(what);
};
const gt = async (expr: string): Promise<any> => b.eval(`window.__gameTest.${expr}`);
const rectOf = async (sel: string): Promise<{ x: number; y: number; w: number; h: number; left: number; top: number } | null> =>
  b.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top }; })()`);
const clickSel = async (sel: string): Promise<void> => {
  let r: Awaited<ReturnType<typeof rectOf>> = null;
  await waitFor(async () => {
    r = await rectOf(sel);
    return r !== null && r.w > 0 ? true : null;
  }, `visible element ${sel}`, 8000);
  await b.click(r!.x, r!.y);
};
const hover = async (x: number, y: number): Promise<void> => {
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
};
const tickNow = async (): Promise<number> => Number(await b.eval("document.getElementById('tick').textContent"));
const minimapClick = async (tx: number, ty: number): Promise<void> => {
  const mm = await rectOf('#mm');
  must(mm !== null, 'no minimap canvas');
  const size = await gt('mapSize()');
  const scale = 200 / Math.max(size.mapX, size.mapY);
  const left = mm!.x - mm!.w / 2;
  const top = mm!.y - mm!.h / 2;
  await b.click(left + (tx - 0.5) * scale, top + (ty - 0.5) * scale);
  await sleep(250);
};

try {
  step('start a Battle Sun skirmish');
  await b.goto('/game.html');
  await waitFor(async () => (await b.eval("document.querySelectorAll('.maprow').length")) > 0, 'map list', 60000);
  await b.eval("(() => { const f = document.getElementById('filter'); f.value = 'Battle Sun'; f.dispatchEvent(new Event('input', { bubbles: true })); })()");
  await waitFor(async () => (await b.eval("!document.getElementById('startbtn').disabled")) === true, 'Start enabled (renderer ready)', 90000);
  await b.eval("document.getElementById('aistart').value = 'none'");
  await b.eval("document.querySelector('.maprow').click()");
  await b.eval("document.getElementById('startbtn').click()");
  await waitFor(async () => Number(await b.eval("document.getElementById('tick').textContent")) >= 5 ? true : null, 'the game loop runs (tick >= 5)', 90000);
  must((await b.eval("window.__gameSk().slots.find((s) => s.kind === 'ai').aiStart")) === 'none', 'the check runs with AI start none (it tests the UI, not a fight)');
  await waitFor(async () => (await b.eval("!document.getElementById('buildmenu').classList.contains('hide')")) === true, 'build menu visible', 20000);
  must((await b.eval("document.querySelectorAll('#buildmenu .btn').length")) >= 5, 'the build menu lists the house types');
  must((await b.eval("!document.getElementById('minimap').classList.contains('hide')")) === true, 'the minimap is shown');
  await b.shot('b2-start');

  step('setup grants: a school, a barracks, a militia group (test setup, not human orders)');
  const school0 = await gt('grantHouse(13)');
  const group0 = await gt('grantSoldiers(9)');
  must(school0 > 0, 'could not grant a school near the store');
  must(group0 > 0, 'could not grant a militia group near the store');
  await sleep(300);

  step('build menu: pick a house type the hand can build');
  const unlocked: number[] = await gt('unlockedTypes()');
  const houseType = unlocked[0];
  must(houseType !== undefined, 'no house type is unlocked for the human hand');
  const place0 = await gt(`placementFor(${houseType})`);
  must(place0 !== null, `no valid tile for house type ${houseType} near the store (${JSON.stringify(await gt(`placementDebug(${houseType})`))})`);
  const counts0 = await gt('counts()');
  await clickSel(`#buildmenu [data-act="mode:house:${houseType}"]`);
  await sleep(200);
  let ghost = await gt('ghost()');
  must(ghost.mode === 'house' && ghost.houseType === houseType, `build mode did not start (mode ${ghost.mode})`);
  await b.shot('b2-build-menu');

  step('ghost is green on a valid tile');
  await hover(place0.sx, place0.sy);
  await sleep(300);
  ghost = await gt('ghost()');
  must(ghost.ghostOk === true, `ghost on a valid tile is not valid (ghostOk ${ghost.ghostOk})`);
  await b.shot('b2-ghost-valid');

  step('ghost is red on an invalid tile, and the refused plan shows its reason');
  const inv = await gt(`invalidSpot(${houseType})`);
  must(inv !== null, 'no invalid tile to test');
  await hover(inv.sx, inv.sy);
  await sleep(300);
  ghost = await gt('ghost()');
  must(ghost.ghostOk === false, `ghost on an invalid tile should be red (ghostOk ${ghost.ghostOk}, hover ${JSON.stringify(ghost.hover)}, expected ${inv.x},${inv.y} at ${inv.sx},${inv.sy} type ${houseType}; valid spot was ${place0.x},${place0.y} at ${place0.sx},${place0.sy})`);
  await b.shot('b2-ghost-invalid');
  await b.click(inv.sx, inv.sy);
  await waitFor(async () => (await gt('results()')).some((r: { type: string; ok: boolean }) => r.type === 'housePlan' && r.ok === false) ? true : null, 'the refused housePlan result', 8000);
  const refused = (await gt('results()')).filter((r: { type: string; ok: boolean; reason: string }) => r.type === 'housePlan' && !r.ok);
  must(refused[0].reason.length > 0, 'the refused plan has no reason text');
  must((await gt('toasts()')).some((t: string) => t.startsWith('housePlan:')), 'the refused plan did not show a notification');

  step('a valid click queues a house plan that the sim holds');
  await b.click(place0.sx, place0.sy);
  await waitFor(async () => ((await gt('counts()')).plans > counts0.plans ? true : null), 'the house plan in the sim', 8000);
  must((await gt('commandLog()')).some((c: { type: string }) => c.type === 'housePlan'), 'no housePlan command was applied');
  await clickSel('#buildmenu [data-act="cancel"]');
  await sleep(150);
  ghost = await gt('ghost()');
  must(ghost.mode === 'none', 'Cancel did not leave the build mode');

  step('road to the house: a player drags a road from the builder point to the store road block');
  must(place0.road !== null, 'no straight road from the house site to the store road block on screen');
  if (!BREAK) {
    const fieldsBefore = (await gt('counts()')).fields;
    await clickSel('#buildmenu [data-act="tab:roads"]');
    await clickSel('#buildmenu [data-act="mode:road"]');
    await sleep(150);
    await b.drag(place0.road!.a.sx, place0.road!.a.sy, place0.road!.b.sx, place0.road!.b.sy);
    await waitFor(async () => ((await gt('counts()')).fields > fieldsBefore ? true : null), 'the road plans of the house in the sim', 8000);
    must((await gt('commandLog()')).some((c: { type: string }) => c.type === 'roadPlanLine' || c.type === 'roadPlan'), 'the house road was not sent as a road command');
    await b.key('Escape', 'Escape');
    await sleep(150);
  }

  step('fast-forward (4x) until the house is built: count up and a completion notice');
  await b.eval("document.getElementById('speedbtn').click()");
  await b.eval("document.getElementById('speedbtn').click()");
  must((await b.eval("document.getElementById('speedbtn').textContent")) === '4x', 'speed did not reach 4x');
  const houses0 = counts0.houses;
  const t0 = await tickNow();
  try {
    await waitFor(async () => ((await gt(`houses(${houseType})`)).some((h: { x: number; y: number; done: boolean }) => h.done && h.x === place0.x && h.y === place0.y) ? true : null), 'the placed house to be built (4x)', BREAK ? 60000 : 240000, 1000);
  } catch (err) {
    const hs = await gt(`houses(${houseType})`);
    const dump = await gt('counts()');
    const bs = hs.length > 0 ? await b.eval(`window.__kamplay.houseBuildState(${hs[0].uid})`) : null;
    const wares = await b.eval(`(() => { const w = window.__kamplay.world; const s = w.houses.find(h => h.typeId === 11 && h.owner === 0); return s ? { timber: w.wareCount(s, 2), stone: w.wareCount(s, 1), trunk: w.wareCount(s, 0) } : null; })()`);
    const idle = await b.eval(`(() => { const w = window.__kamplay.world; return w.units.filter(u => u.owner === 0 && !u.dead).map(u => u.type + ':' + u.taskKind).join(' '); })()`);
    throw new Error(`${err instanceof Error ? err.message : String(err)}; placed ${JSON.stringify(place0)}; counts ${JSON.stringify(dump)}; house ${JSON.stringify(hs)}; build ${JSON.stringify(bs)}; store ${JSON.stringify(wares)}; hand0 units ${String(idle)}`);
  }
  const after = await gt('counts()');
  must(after.houses > houses0, `the human's house count did not go up (${houses0} -> ${after.houses})`);
  await waitFor(async () => ((await gt('toasts()')).some((t: string) => t.endsWith('completed')) ? true : null), 'the completion notice', 8000);
  step('notice and house are on screen');
  must((await gt('houses(' + houseType + ')')).some((h: { done: boolean }) => h.done), 'no finished house of the placed type');
  await b.shot('b2-house-done');
  b.notes.push(`house built in ${(await tickNow()) - t0} ticks at 4x (type ${houseType})`);

  step('road: drag a line of three road plans');
  await clickSel('#buildmenu [data-act="tab:roads"]');
  await clickSel('#buildmenu [data-act="mode:road"]');
  await sleep(150);
  ghost = await gt('ghost()');
  must(ghost.mode === 'road', 'road mode did not start');
  const rs = await gt('roadSpot()');
  must(rs !== null, 'no three road tiles near the store');
  const fields0 = (await gt('counts()')).fields;
  await b.drag(rs.a.sx, rs.a.sy, rs.b.sx, rs.b.sy);
  const line3 = [{ x: rs.a.x, y: rs.a.y }, { x: rs.a.x + 1, y: rs.a.y }, { x: rs.b.x, y: rs.b.y }];
  try {
    await waitFor(async () => ((await gt(`roadStates(${JSON.stringify(line3)})`)).every((s: string) => s !== 'none') ? true : null), 'three road tiles (plan or road) in the sim', 8000);
  } catch (err) {
    const states = JSON.stringify(await gt(`roadStates(${JSON.stringify(line3)})`));
    const cmds = JSON.stringify((await gt('commandLog()')).slice(-4));
    const res = JSON.stringify((await gt('results()')).slice(-4));
    const toasts = JSON.stringify((await gt('toasts()')).slice(-3));
    throw new Error(`${err instanceof Error ? err.message : String(err)}; tiles ${JSON.stringify(line3)} states ${states}; fields ${fields0} -> ${(await gt('counts()')).fields}; last commands ${cmds}; results ${res}; toasts ${toasts}`);
  }
  must((await gt('commandLog()')).some((c: { type: string }) => c.type === 'roadPlanLine'), 'the road line was not sent as roadPlanLine');
  await b.shot('b2-road');
  await b.key('Escape', 'Escape');
  await sleep(150);

  step('fields: a corn field on a click');
  await clickSel('#buildmenu [data-act="tab:fields"]');
  await clickSel('#buildmenu [data-act="mode:corn"]');
  const cs = await gt('cornSpot()');
  must(cs !== null, 'no corn field tile near the store');
  await b.click(cs.sx, cs.sy);
  await waitFor(async () => ((await gt('results()')).some((r: { type: string; ok: boolean }) => r.type === 'fieldPlan' && r.ok) ? true : null), 'an accepted corn fieldPlan', 8000);

  must((await gt('commandLog()')).some((c: { type: string; kind?: string }) => c.type === 'fieldPlan'), 'no fieldPlan command was applied');
  await b.key('Escape', 'Escape');
  await sleep(150);
  ghost = await gt('ghost()');
  must(ghost.mode === 'none', 'Escape did not leave the field mode');
  await b.shot('b2-fields');

  step('minimap click moves the camera (and a click far away moves it again)');
  const cam0 = await gt('camera()');
  await minimapClick(2, 2);
  const cam1 = await gt('camera()');
  const dist1 = Math.hypot(cam1.x - cam0.x, cam1.y - cam0.y);
  must(dist1 > 100, `a minimap click did not move the camera (${Math.round(dist1)} px)`);
  const size = await gt('mapSize()');
  await minimapClick(size.mapX - 2, size.mapY - 2);
  const cam2 = await gt('camera()');
  must(Math.hypot(cam2.x - cam1.x, cam2.y - cam1.y) > 100, 'a second minimap click did not move the camera');
  b.notes.push(`minimap moved the camera ${Math.round(dist1)} px`);
  await b.shot('b2-minimap');

  step('school: click it, the house panel shows its name, queue a serf');
  const sch = (await gt('houses(13)'))[0];
  must(sch !== undefined, 'no school of the hand');
  await minimapClick(sch.x, sch.y);
  const sc = await gt(`houseCentre(${sch.uid})`);
  must(sc !== null, 'the school has no sprite on screen after the minimap jump');
  await b.click(sc.x, sc.y);
  await waitFor(async () => (String(await gt('infoTitle()')).includes('school') ? true : null), 'the school panel (title school)', 8000);
  await b.shot('b2-panel-school');
  await clickSel('#info [data-act="train:0"]');
  await waitFor(async () => ((await gt('results()')).some((r: { type: string; ok: boolean }) => r.type === 'houseTrain' && r.ok) ? true : null), 'an accepted houseTrain', 8000);
  must((await gt('commandLog()')).some((c: { type: string }) => c.type === 'houseTrain'), 'the houseTrain command was not applied');

  step('store: click it, the panel shows its name and its stock');
  const store = (await gt('houses(11)'))[0];
  must(store !== undefined, 'no store of the hand');
  await minimapClick(store.x, store.y);
  const stc = await gt(`houseCentre(${store.uid})`);
  must(stc !== null, 'the store has no sprite on screen');
  await b.click(stc.x, stc.y);
  await waitFor(async () => (String(await gt('infoTitle()')).includes('store') ? true : null), 'the store panel (title store)', 8000);
  await b.shot('b2-panel-store');

  step('barracks: click it, the equip buttons are real or disabled with a reason');
  const barracks0 = await gt('grantBarracks()');
  must(barracks0 > 0, 'could not grant a barracks near the store');
  await sleep(300);
  const bar = (await gt('houses(21)'))[0];
  must(bar !== undefined, 'no barracks of the hand');
  await minimapClick(bar.x, bar.y);
  const bc = await gt(`houseCentre(${bar.uid})`);
  must(bc !== null, 'the barracks has no sprite on screen');
  await b.click(bc.x, bc.y);
  await waitFor(async () => (String(await gt('infoTitle()')).includes('barracks') ? true : null), 'the barracks panel (title barracks)', 8000);
  const equipDisabled = await b.eval("(() => { const e = document.querySelector('#info [data-act=\"equip:14\"]') || [...document.querySelectorAll('#info button')].find(x => x.textContent.includes('militia')); return e ? { disabled: e.disabled, title: e.title || '' } : null; })()");
  must(equipDisabled !== null, 'no militia equip button in the barracks panel');
  if (equipDisabled.disabled) must(String(equipDisabled.title).length > 0, 'a disabled equip button has no reason');
  else {
    await clickSel('#info [data-act="equip:14"]');
    await waitFor(async () => ((await gt('results()')).some((r: { type: string }) => r.type === 'houseEquip') ? true : null), 'a houseEquip result', 8000);
  }
  await b.shot('b2-panel-barracks');

  step('box-select the militia group, right-click a destination, the group walks there');
  await b.key('Escape', 'Escape'); // clears the barracks selection, so its panel does not cover the soldiers
  await minimapClick(store.x, store.y);
  await sleep(200);
  const sold: { uid: number; groupUid: number; sx: number | null; sy: number | null }[] = await gt('soldiers()');
  must(sold.length >= 9, `the militia group is not in the sim (${sold.length} soldiers)`);
  const onScreen = sold.filter((s) => s.sx !== null && s.sy !== null);
  must(onScreen.length >= 9, `the soldiers are not on screen (${onScreen.length}/9)`);
  const xs = onScreen.map((s) => s.sx!);
  const ys = onScreen.map((s) => s.sy!);
  // press at the bottom-right corner and drag up-left: the top-left corner may lie under the top bar, which takes the press
  await b.drag(Math.max(...xs) + 25, Math.max(...ys) + 25, Math.min(...xs) - 25, Math.min(...ys) - 25);
  await sleep(300);
  const selectedGroups: number[] = (await gt('ghost()')).groups;
  const selectedUnits: number[] = (await gt('ghost()')).units;
  must(selectedGroups.length >= 1, 'the box select picked no group');
  must(selectedUnits.length >= 9, `the box select picked ${selectedUnits.length} soldiers, expected 9`);
  await b.shot('b2-group-panel');
  const cx = xs.reduce((a, c) => a + c, 0) / xs.length;
  const cy = ys.reduce((a, c) => a + c, 0) / ys.length;
  const dest = await b.eval(`(() => {
    const k = window.__kamplay;
    for (let d = 60; d <= 400; d += 20) {
      for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d]]) {
        const t = k.tileAtViewport(${cx} + dx, ${cy} + dy);
        if (t && k.tileWalkable(t.x, t.y)) return { x: ${cx} + dx, y: ${cy} + dy, tx: t.x, ty: t.y };
      }
    }
    return null;
  })()`);
  must(dest !== null, 'no walkable tile near the soldiers');
  const before = await gt(`positions(${JSON.stringify(selectedUnits)})`);
  await b.click(dest.x, dest.y, { button: 'right' });
  try {
    await waitFor(async () => ((await gt('results()')).some((r: { type: string; ok: boolean }) => r.type === 'groupWalk' && r.ok) ? true : null), 'an accepted groupWalk', 8000);
  } catch (err) {
    const res = JSON.stringify((await gt('results()')).slice(-3));
    const toasts = JSON.stringify((await gt('toasts()')).slice(-3));
    const sel = JSON.stringify(await gt('ghost()').then((g: { mode: string; groups: number[]; units: number[] }) => ({ mode: g.mode, groups: g.groups, units: g.units.length })));
    throw new Error(`${err instanceof Error ? err.message : String(err)}; right-click at ${dest.x},${dest.y} (tile ${dest.tx},${dest.ty}); selection ${sel}; results ${res}; toasts ${toasts}`);
  }
  await sleep(4000);
  const after2 = await gt(`positions(${JSON.stringify(selectedUnits)})`);
  const moved = before.filter((p: { x: number; y: number }, i: number) => Math.hypot(after2[i].x - p.x, after2[i].y - p.y) > 0.5).length;
  must(moved >= 5, `the group did not move (${moved} of ${before.length} soldiers moved)`);
  const gi = await gt(`groupInfo(${selectedGroups[0]})`);
  must(gi !== null && gi.orderX === dest.tx && gi.orderY === dest.ty, `the group's order is not the clicked tile (${JSON.stringify(gi)} vs ${dest.tx},${dest.ty})`);
  b.notes.push(`group of ${selectedUnits.length} walked: ${moved} soldiers moved to (${dest.tx},${dest.ty})`);

  step('halt the group from its panel');
  await clickSel('#info [data-act="halt"]');
  await waitFor(async () => ((await gt(`groupInfo(${selectedGroups[0]})`))?.halt === true ? true : null), 'the group halted', 8000);

  step('final: the notices of the run');
  const toasts: string[] = await gt('toasts()');
  must(toasts.some((t) => t.endsWith('completed')), 'no completion notice in the run');
  must(toasts.some((t) => t.startsWith('housePlan:')), 'no refused-plan notice in the run');
  await b.shot('b2-game-full');
  b.notes.push(`toasts ${toasts.length}`, `commands ${(await gt('commandLog()')).length} applied`);
} catch (e) {
  b.failures.push(`step "${current}": ${e instanceof Error ? e.message : String(e)}`);
}
const code = b.report('UI B2 CHECK');
await b.close();
process.exit(code);
