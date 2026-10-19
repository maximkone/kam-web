// tools/uicheck/b4.ts - REAL browser check of the KaM data pack path (docs/WORK-PC.md).
//
// The point of a pack is a machine that has no KaM install and may not allow the folder picker at all, so
// this check drags the archive into the page's own <input type=file> over CDP and then insists on the real
// thing: the map list must be the pack's own list, a map's bytes must come out of the archive, the atlases
// must reach the renderer, and a match against the AI must actually tick.
//
//   node tools/uicheck/b4.ts --check [--web-port 8360] [--cdp-port 9390] [--pack out/kam-data.zip]
//   build the pack first: node tools/pack/cli.ts --check --maps 195
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { scanMaps } from '../../apps/web/game/localsource.ts';
import { zipTree } from '../../apps/web/game/pack.ts';
import { openBrowser, startMatch, waitFor } from './cdplib.ts';

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : d;
};

if (!process.argv.includes('--check')) {
  console.log('usage: node tools/uicheck/b4.ts --check [--web-port 8360] [--cdp-port 9390] [--pack out/kam-data.zip]');
  process.exit(1);
}

const pack = resolve(arg('--pack', 'out/kam-data.zip'));
if (statSync(pack, { throwIfNoEntry: false }) === undefined) {
  console.error(`B4 FAIL: no pack at ${pack} - build it with: node tools/pack/cli.ts --check --maps 195`);
  process.exit(1);
}

// The expected side of every assertion comes from the archive itself, through the very reader the page uses
// (zipTree over DecompressionStream) - so this also proves that reader outside a browser.
console.log(`B4 pack=${pack}`);
const bytes = new Uint8Array(readFileSync(pack));
const tree = zipTree(bytes);
const expected = await scanMaps(tree);
const skirmish = expected.find((m) => m.kind === 'MapsMP' && m.advancedAI.some(Boolean));
const expectedMapBytes = skirmish === undefined ? 0 : (await tree.read(skirmish.mapPath))?.length ?? 0;
console.log(
  `B4 pack: ${tree.entries.length} entries, ${expected.length} maps in the node scan, ` +
    `${expected.filter((m) => m.kind === 'MapsMP').length} of them skirmish, ${(bytes.length / 1048576).toFixed(1)} MB`,
);

const b = await openBrowser({ webPort: Number(arg('--web-port', '8360')), cdpPort: Number(arg('--cdp-port', '9390')) });
try {
  await b.goto('/game.html');
  const serverMaps = await waitFor(
    async () => {
      const n = await b.eval("document.querySelectorAll('.maprow').length");
      return n > 0 ? n : null;
    },
    'map list',
    60000,
  );
  b.notes.push(`the dev server's own list has ${serverMaps} maps`);
  const startText = await b.eval("document.getElementById('localstatus').textContent");
  // a ready bundle is the only thing that says "... files, built ...": the idle message names the pack
  // button too, so matching on the words alone would pass before anything was imported
  b.expect(typeof startText === 'string' && !/files, built/.test(startText), `no assets are attached at the start ("${String(startText).slice(0, 60)}")`);

  const doc = await b.send('DOM.getDocument');
  const node = await b.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#localpackinput' });
  b.expect(node.nodeId > 0, 'the page offers a data-pack file input (the only import a locked-down PC allows)');
  const t0 = Date.now();
  await b.send('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [pack] });

  // the page reads the archive, builds the atlases and reloads itself with the bundle stored
  const status = await waitFor(
    async () => {
      const t = await b.eval("document.getElementById('localstatus').textContent");
      return typeof t === 'string' && /files, built/.test(t) ? t : null;
    },
    'the pack to be built and attached',
    420000,
  );
  const built = await b.eval("document.getElementById('localstatus').textContent");
  void status;
  b.expect(String(built).includes('kam-data.zip'), `the page names the pack it is running from ("${String(built).slice(0, 90)}")`);

  // the map list must be the pack's list, not the server's
  const maps = await waitFor(
    async () => {
      const n = await b.eval('window.__mapList ? window.__mapList.length : 0');
      return n > 0 ? n : null;
    },
    'the map list from the pack',
    120000,
  );
  const names = await b.eval('window.__mapList.map((m) => m.kind + "/" + m.name).sort().join("|")');
  const expectedNames = expected.map((m) => `${m.kind}/${m.name}`).sort().join('|');
  b.expect(maps === expected.length, `the page lists the pack's ${expected.length} maps (got ${maps}, the server alone had ${serverMaps})`);
  b.expect(names === expectedNames, 'every map name matches the pack, field for field on the name (not the server\'s list)');

  // a map's bytes must come out of the archive
  if (skirmish !== undefined) {
    const got = await b.eval(`fetch(${JSON.stringify(`/mapfile/${skirmish.kind}/${skirmish.name}/map`)}).then((r) => r.arrayBuffer()).then((a) => a.byteLength)`);
    b.expect(got === expectedMapBytes, `the map file is read out of the pack (${skirmish.name}: ${got} bytes, archive says ${expectedMapBytes})`);
  } else {
    b.expect(false, 'the pack holds at least one skirmish map that supports the bots');
  }

  // the atlases must reach the renderer, and the game must run from them
  const atlas = await b.eval("fetch('/out/atlas/Units.json').then((r) => r.json()).then((j) => (j.sprites || []).length)");
  b.expect(atlas > 1000, `the sprite atlas is decoded from the pack (${atlas} sprites in Units.json)`);
  const name = skirmish === undefined ? 'Battle Sun' : skirmish.name;
  await startMatch(b, name);
  const sz = await b.shot('b4-pack-match');
  b.expect(sz > 100000, `a match from the pack renders real art, not an empty canvas (${sz} bytes)`);
  b.notes.push(`pack imported and played in ${((Date.now() - t0) / 1000).toFixed(1)} s, map ${name}`);
  b.expect(b.consoleErrors.length === 0, `no page errors (${b.consoleErrors.length})`);
} catch (err) {
  // An exception is a failure: without this a check that dies on its first step would report PASS with no notes.
  b.expect(false, `the check could not finish: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  const code = b.report('B4');
  await b.close();
  process.exit(code);
}
