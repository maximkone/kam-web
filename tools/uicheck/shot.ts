// tools/uicheck/shot.ts - a plain screenshot of a page of the dev server, for looking at the interface.
//   node tools/uicheck/shot.ts --path / --name launcher [--web-port 8380] [--cdp-port 9399] [--width 1280] [--height 900]
import { openBrowser } from './cdplib.ts';

const arg = (name: string, d: string): string => {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1]! : d;
};

const b = await openBrowser({
  webPort: Number(arg('--web-port', '8380')),
  cdpPort: Number(arg('--cdp-port', '9399')),
  width: Number(arg('--width', '1280')),
  height: Number(arg('--height', '900')),
});
try {
  const path = arg('--path', '/');
  await b.goto(path);
  const title = await b.eval('document.title');
  const size = await b.shot(arg('--name', 'page'));
  console.log(`shot: ${path} -> "${title}", ${size} bytes, ${b.consoleErrors.length} console error(s)`);
  for (const e of b.consoleErrors.slice(0, 3)) console.log(`  console: ${e}`);
} finally {
  console.log(b.report('SHOT'));
  await b.close();
  process.exit(0);
}
