// cli.ts — M0 sprite import: KaM Remake .rxx packs -> web atlases (PNG + JSON manifest).
// Usage (docs/M0-SPIKE.md section 3):
//   node tools/import/cli.ts --install "<KaM Remake root or data\Sprites dir>" [--out out] [--packs Units,Tileset] [--check]
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildAtlasData } from '../../packages/assets/atlas.ts';
import { decodeRxxFile, writeAtlas } from './write.ts';
import type { RxxPack } from '../../packages/assets/rxx.ts';

const DEFAULT_PACKS = ['Units', 'Tileset', 'Houses', 'Trees', 'GUI', 'GUIMain'];
// Expected values for the reference Units.rxx (M0-SPIKE.md section 3). Two profiles, because the M0
// install's Units.rxx is an RXX0 container with 8688 present sprites while the r15472 install's is RXX2
// with 8696 (same 9400 declared, and sprite 0 and 64 are identical in both, so a decoder regression still
// fails). Verified 2026-10-19: the r15472 file starts with "RXX2"; `out/atlas` had been built from the
// older RXX0 file and was rebuilt then.
const CHECK_EXPECT: { format: string; present: number }[] = [
  { format: 'rxx0', present: 8688 },
  { format: 'rxx2', present: 8696 },
];
const CHECK_SPRITES = {
  sprite0: { w: 15, h: 16, px: -1, py: -28 },
  sprite64: { w: 33, h: 40, px: -13, py: -35 },
};

interface Options {
  install: string;
  out: string;
  packs: string[];
  check: boolean;
}

function usage(): string {
  return [
    'usage: node tools/import/cli.ts --install "<KaM Remake root or data\\Sprites dir>"',
    '         [--out out] [--packs Units,Tileset,...] [--check]',
    `default packs: ${DEFAULT_PACKS.join(',')}`,
  ].join('\n');
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { install: '', out: 'out', packs: [...DEFAULT_PACKS], check: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}\n${usage()}`);
      return argv[i];
    };
    if (arg === '--install') opts.install = value();
    else if (arg === '--out') opts.out = value();
    else if (arg === '--packs') {
      opts.packs = value()
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.length > 0);
    } else if (arg === '--check') opts.check = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else throw new Error(`unknown argument "${arg}"\n${usage()}`);
  }
  if (opts.install === '') throw new Error(`--install is required\n${usage()}`);
  if (opts.packs.length === 0) throw new Error('--packs is empty');
  return opts;
}

function hasRxxFiles(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => f.toLowerCase().endsWith('.rxx'));
  } catch {
    return false;
  }
}

/** Accept the KaM Remake root or the data\Sprites directory itself. */
function findSpritesDir(install: string): string {
  if (hasRxxFiles(install)) return install;
  const nested = join(install, 'data', 'Sprites');
  if (hasRxxFiles(nested)) return nested;
  throw new Error(`no .rxx files in "${install}" nor "${nested}" — pass the KaM Remake root or its data\\Sprites dir`);
}

function checkProblems(units: RxxPack): string[] {
  const problems: string[] = [];
  if (units.leftover !== 0) problems.push(`leftover bytes = ${units.leftover}, expected 0`);
  const profile = CHECK_EXPECT.find((p) => p.format === units.format);
  if (profile === undefined) {
    problems.push(`format ${units.format} is not one of the known profiles (${CHECK_EXPECT.map((p) => p.format).join(', ')})`);
  } else if (units.sprites.length !== profile.present) {
    problems.push(`present sprites = ${units.sprites.length}, expected ${profile.present} for ${profile.format}`);
  }
  const s0 = units.sprites.find((s) => s.index === 0);
  const e0 = CHECK_SPRITES.sprite0;
  if (s0 === undefined) problems.push('sprite 0 missing');
  else {
    if (s0.w !== e0.w || s0.h !== e0.h) problems.push(`sprite 0 is ${s0.w}x${s0.h}, expected ${e0.w}x${e0.h}`);
    if (s0.px !== e0.px || s0.py !== e0.py) problems.push(`sprite 0 pivot (${s0.px},${s0.py}), expected (${e0.px},${e0.py})`);
  }
  const s64 = units.sprites.find((s) => s.index === 64);
  const e64 = CHECK_SPRITES.sprite64;
  if (s64 === undefined) problems.push('sprite 64 missing');
  else {
    if (s64.w !== e64.w || s64.h !== e64.h) problems.push(`sprite 64 is ${s64.w}x${s64.h}, expected ${e64.w}x${e64.h}`);
    if (s64.px !== e64.px || s64.py !== e64.py) problems.push(`sprite 64 pivot (${s64.px},${s64.py}), expected (${e64.px},${e64.py})`);
    if (s64.mask === null) problems.push('sprite 64 has no mask, expected mask');
  }
  return problems;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const spritesDir = findSpritesDir(opts.install);
  const display = (p: string): string => p.replace(/\\/g, '/');

  let packs = 0;
  let sprites = 0;
  let sheets = 0;
  let bytes = 0;
  let units: RxxPack | null = null;

  for (const name of opts.packs) {
    const file = join(spritesDir, `${name}.rxx`);
    if (!existsSync(file)) throw new Error(`pack file not found: ${file}`);
    const decoded = decodeRxxFile(file, name);
    const result = writeAtlas(buildAtlasData(decoded), opts.out);
    packs += 1;
    sprites += decoded.sprites.length;
    sheets += result.sheets;
    bytes += result.bytes;
    if (name === 'Units') units = decoded;
    const json = display(join(opts.out, 'atlas', `${name}.json`));
    console.log(
      `PACK ${name} format=${decoded.format} sprites=${decoded.sprites.length} sheets=${result.sheets} out=${json}`,
    );
  }

  if (opts.check) {
    if (units === null) {
      console.log('CHECK SKIP: Units not in --packs');
    } else {
      const problems = checkProblems(units);
      if (problems.length > 0) {
        for (const p of problems) console.error(`CHECK FAIL: ${p}`);
        process.exitCode = 1;
      } else {
        console.log(`CHECK PASS (Units format=${units.format} present=${units.sprites.length})`);
      }
    }
  }

  console.log(`DONE packs=${packs} sprites=${sprites} sheets=${sheets} bytes=${bytes}`);
}

try {
  main();
} catch (err) {
  console.error(`ERROR ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
