# PORT-WASM: FPC to WebAssembly spike (kam-web)

Status: spike, partial. Time-boxed. Not part of the shipped game. Work area: `_fpc\wasm\` (git-ignored).

## Verdict (short)

- **Toolchain: works.** Free Pascal trunk (3.3.1) cross-compiles to `wasm32-wasip1`; output runs under `node:wasi`.
- **Language smoke test: passes** (Int64, Single/Double, generics, TStringList, TMemoryStream, records with operators, classes, exceptions). One real trap: division by zero is a raw wasm trap, not `EDivByZero`.
- **Engine core: partial.** Foundation units 26/26 compile. Full sim-core closure: 106 of 440 units compile. Remaining blockers are listed below.
- **Not reached:** `kamsim.wasm` (ticks + state checksum). Not built.

## Toolchain recipe (what worked)

1. Bootstrap: FPC 3.2.2 win64 binary, from `https://downloads.freepascal.org/fpc/dist/3.2.2/x86_64-win64/fpc-3.2.2.x86_64-win64.tar` (nested tars; extract all `*.tar.gz` into `_fpc\wasm\fpc322`). `fpc322\bin\x86_64-win64\fpc.exe -iV` prints `3.2.2`.
2. Source: `git clone --depth 1 https://gitlab.com/freepascal.org/fpc/source.git _fpc\wasm\fpcsrc` (about 26k files, a few minutes).
3. Cross build (run in background, log to file):
   `make all OS_TARGET=wasip1 CPU_TARGET=wasm32 BINUTILSPREFIX= "OPT=-O-" PP=fpc` with `fpc322\bin\x86_64-win64` first on PATH.
   - The compiler cycle and the wasm32 compiler + RTL build. The run then ends with `Error 2` in `packages_all` (host win64 `system.ioutils.pp`: `GetLastOSError` not found). This does not affect the wasm RTL, which is already built. Packages were used from source via `-Fu` instead.
4. Result: `fpcsrc\compiler\ppcrosswasm32.exe -iV` prints `3.3.1`; `-iTO` prints `wasip1`; `-iTP` prints `wasm32`.

Build line for programs:
`ppcrosswasm32.exe -Twasip1 -Pwasm32 -Mdelphi -Sh -Sci -CTbfexceptions -O- -Fu<units...> -Fi<...> prog.pas`
Run: `node run-wasi.mjs prog.wasm` (uses `node:wasi`, `returnOnExit`).

Wall time: not measured per step. The whole spike (toolchain, smoke test, compile tables) ran about 2 hours wall-clock, within the spike session.

## Proof lines (copied from runs)

```
hello (tests\out\hello.wasm, node run-wasi.mjs):
hello42
exit 0

smoke (tests\smoke.pas, -CTbfexceptions):
int64 3074457345618258602 6148914691236517204
single 1.4142
double 1.86886228
generic list sum 385 count 10
dict b=2
stringlist 3 one,two,three
memstream 12345 size 4
vec 13,24 eq=FALSE
class dog
exception boom
second catch EMyError
smoke done
exit 0
```

## Engine tree used

- `_fpc\android-ref` (Vadim170/kam-remake-android, HEAD `a03f82a`, `GAME_REVISION_NUM=16398`). Lead-provided read-only clone. We compile its `src` (copied to `_fpc\wasm\src`); the older `_ref` r15472 copy is kept as `_fpc\wasm\src-r15472`, not used.
- Shims: `android-ref\android\pascal\shims` (copied to `_fpc\wasm\stubs`).
- Lazarus-only units: sparse clone of `components/lazutils` from gitlab `freepascal.org/lazarus/lazarus` (`_fpc\wasm\lazarus`). Gives LazUTF8, FileUtil, LazFileUtils, lconvencoding, laz2_* without renaming.
- Real FPC packages from `fpcsrc` (by `-Fu`): paszlib, hash (crc), fcl-xml, fcl-json, fcl-base, fcl-process (dummy pipes), fcl-image, rtl-generics, rtl-objpas, rtl-extra.

## Patches (work-area copy only, never _ref or android-ref)

1. **overload directives**: trunk rejects overloaded free routines whose implementation lacks `overload`. `fix-overloads.mjs` adds `; overload;` after the header terminator (handles multi-line headers). The native 3.2.2 compile does not need this, so the patch is harmless for both.
2. **UTCNow** (KM_CommonUtils.pas): no body when neither `MSWindows` nor `Unix` is defined. Added a fallback `Result := Now`. This was the real cause of a parse error (`BEGIN expected`) at the end of the unit.
3. **KromUtils**: `MAXBYTE` replaced by `255` (only Windows defines it).
4. **zbase/paszlib**: shadow copies in `stubs\` with `{$mode objfpc}` (Delphi mode trips on `tree[n]` in trees.pas and on `str()`); `zbase.pas` also casts `str(Integer(err), ...)`.
5. **uPSRuntime.pas** (PascalScript): tried to enable the RTTI-Invoke bridge for `CPUWASM32`. Current state: the define now takes effect, but `InvokeCall.inc` fails (`TValue.From` has a different signature in FPC's Rtti). Not working yet.
6. **Stubs** (minimal, for compile only): `Windows` (constants only), `BaseUnix`/`Unix` (`fpChmod`), `LazHelpHTML` (empty), `MMSystem` (empty), plus the Android shims (`Forms`, `Controls`, `Graphics`, `LCLIntf`, `LCLType`, `Dialogs`, `Mouse`, `Clipbrd`, `OpenGLContext`, `KMAndroidHost`, `KMAndroidLog`, `KM_FormLogistics`).

Compile flags: `-Sci` (C-style operators, Lazarus default; needed by lazutils).

## Unit compile results

- L0 (`KM_Points`, `KM_CommonTypes`, `KM_CommonUtils` closure): **26 of 26 OK**.
- Sim-core closure (roots: KM_Terrain, KM_Hands, KM_Houses, KM_Units, KM_AI, KM_GameInputProcess + L0): **106 of 440 OK**, 334 FAIL (run `simcore2.json`).

Per folder (OK / units; `blockedByDep` = failed only because a dependency failed):

| folder | OK / units | own-code fails | blocked by dep |
|---|---|---|---|
| common | 12 / 12 | 0 | 0 |
| res | 15 / 21 | 0 | 6 |
| utils | 17 / 22 | 3 | 2 |
| settings | 10 / 11 | 1 | 0 |
| game | 8 / 16 | 0 | 8 |
| mission | 6 / 12 | 0 | 6 |
| scripting | 5 / 13 | 0 | 8 |
| terrain | 1 / 10 | 0 | 9 |
| hands | 1 / 11 | 0 | 10 |
| houses | 0 / 11 | 0 | 11 |
| units | 1 / 25 | 0 | 24 |
| ai | 4 / 23 | 0 | 19 |
| gui | 2 / 76 | 1 | 73 |

Own-code failures in the core/GUI area: `KromOGLUtils` (syntax at line 13), `KM_ControlsUtils` (`VK_SHIFT`), `KM_Viewport` (`TPoint`), `KM_FormMain`, `KM_FormLoading`, `KM_FormLogistics`, `KM_VclHelpers`, `KM_VclMenuHint`, `KM_RenderControl`, `KM_SettingsDev`, `KM_CommonShellUtils`, `KM_Exceptions` (MadExcept), `KM_Crashreport` (MadExcept), `libZPlay`, `Ogg`, `openal`, `openglcontext`, `dglOpenGL` (`TRect`).

Trunk-specific failures outside the engine: `uPSCompiler.pas(6844)` ("Illegal expression"), `VirtualTrees` / `JsonDataObjects` / `FastMM4LockFreeStack` (`AnsiString(0)` vs `Int64`/`Extended`).

## Blockers, ranked by risk

1. **PascalScript call bridge** (`uPSRuntime.pas`): no wasm path; `{$fatal}` for unknown CPUs. FPC's RTTI `Invoke` exists for wasm32 (`rtl-objpas\src\wasm32\invoke.inc`), but `InvokeCall.inc` is written against Delphi's `TValue` API. Needs a port or a host-side call table. Mission scripts depend on it.
2. **Rendering tangled into the sim**: sim units (`KM_Houses`, `KM_HandEntity`, `KM_TerrainSelection`) import `KM_RenderPool`, `KM_RenderAux`, `KromOGLUtils`. `dglOpenGL` alone blocks 88 units. Splitting the sim from render is a refactor, not a build flag.
3. **Global singletons and load order**: many `g*` globals in units initialised in `initialization`; not measured here.
4. **Extended**: x87 80-bit on desktop, 64-bit on wasm32. Any sim path that uses `Extended` gives different results, which breaks replay CRC parity. Not audited here.
5. **Threads**: trunk wasip1 has no threads (`wasip1threads` is separate). The engine uses worker threads; they need a single-thread fallback.
6. **File IO and sockets**: WASI preopens cover reads; no sockets on wasip1 (fcl-net `Sockets` absent). LNet and Overbyte are out.
7. **Platform stubs**: LCL, MadExcept, FastMM, Windows API, BASS/OpenAL/Ogg, VLC.
8. **Trunk-vs-3.2.2 differences**: overload strictness, `UTCNow`-style missing branches, `uPSCompiler` line 6844. Patches are in the work copy only.

## Verdict and effort estimates (rough, one experienced Pascal developer)

- **(a) Sim core as wasm, driven by the existing TypeScript renderer:** requires (1) a render-free sim module (cut `KM_Render*` out of sim units), (2) a working script bridge or a no-script mode, (3) a Winsock-free, no-threads build, (4) a `kamsim.wasm` with a state checksum matched against desktop replays. Estimate **3 to 5 weeks**. Risk: Extended and singletons, which can only be measured by running parity.
- **(b) Whole engine including GUI and OpenGL:** LCL controls (76 gui units) and fixed-function OpenGL. The Android port runs OpenGL through gl4es on GLES2. gl4es has Emscripten support, so a wasm32 build of gl4es linked with the FPC output behind a JS WebGL2 bridge is the likely route. **Not verified here**: no gl4es wasm build was attempted, and the time box did not cover it. Estimate **2 to 4 months**, dominated by GUI porting, not the compiler.

## Not done (time box)

- `kamsim.wasm` (ticks + state checksum over WASI preopens) not built. The `_ref` replay parity was not run.
- PascalScript bridge still failing (item 1).
- No commits. Only `docs\PORT-WASM.md` is new in the repo; `_fpc\` is git-ignored.

## Work-area scripts (in `_fpc\wasm`, not committed)

- `percompile.mjs`: per-unit compile of a uses-closure with the trunk cross compiler (`node percompile.mjs <roots> <prefix>`).
- `deps.mjs`: static uses-closure report.
- `fix-overloads.mjs`: applies the overload patch to `src`.
- `run-wasi.mjs`: runs a wasm32-wasip1 program under `node:wasi`.
 `try..except` kills the process with `RuntimeError: divide by zero` (a wasm trap). It is not an `EDivByZero`, and stdout that was not flushed is lost. Guard divisions in the engine or add a runtime check.
