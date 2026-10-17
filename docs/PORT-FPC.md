# PORT-FPC: building the real KaM engine with Free Pascal on Windows

Spike A, 2026-10-17, continued. **Status: partial.** LazUtils builds on win64. The engine (android-ref r16398 tree) compiles up to `KM_CommonUtils.pas`, where one syntax error is still open. No runner exists, so there is no replay run, no CRC verdict, no tick count, no ticks per second and no memory figure.

## 1. Milestones

| # | Milestone | State | Proof (real output) |
|---|---|---|---|
| M0 | FPC 3.2.2 win64 runs | done | `fpc -iV` -> `3.2.2`; hello-world: `hello from FPC 3.2.2 x86_64-Win64` |
| M1 | LazUtils precompiled in objfpc mode (as android `build_lazutils.sh`) | **done** | `lazutils fpc exit=0`; 23 `.ppu` in `_fpc\native\lazutils-out` |
| M2 | Engine compiles for win64 (console program, shims, no GL context) | **partial** | build logs: up to `KM_CommonUtils.pas`, open error below |
| M3 | Headless runner, tick loop, state checksum | **not started** | none |
| M4 | Replay CRC verdict (owner r15472 replays or a self-recorded one) | **not started** | none |

## 2. Trees, compilers, sources

| Item | Value |
|---|---|
| Engine tree built | **android-ref r16398** copied to `_fpc\native\tree` (not `_ref` r15472). `KM_Revision.inc` in that copy describes r16398. Replay compatibility with the owner's r15472 saves is still untested. |
| Compiler | FPC 3.2.2 win64, official tarball (`downloads.freepascal.org/fpc/dist/3.2.2/x86_64-win64/`), unpacked to `_fpc\fpc\root`; `fpc.cfg` holds the RTL `-Fu` paths |
| LazUtils source | Lazarus **lazarus_3_0** (same tag as `setup_toolchain.sh`), `_fpc\lazarus30\components\lazutils` |
| PascalScript | `reyandme/pascalscript` @ `ce8590dd7b9cf48fd0e446731989603e09e239b8` (the pinned commit), then the Android patch `android-ref\android\toolchain\patches\pascalscript-aarch64.patch` applied with `git apply --directory=...` (its hunk fixes the same inline-`var` line that failed in the first attempt) |
| Lazarus / lazbuild | not used: `make lazbuild` in the 3.8 tree failed (`make.exe[2]: *** [lazbuild.exe] Error 1`); the Android route uses shims and needs no LCL |

## 3. Commands (all in the git-ignored work area `_fpc\`)

```
# M1: LazUtils, objfpc mode, as build_lazutils.sh does
pwsh C:\empire\games\kam-web\_fpc\native\build-lazutils.ps1
#  -> lazutils fpc exit=0   (compiles lazutils_all.pas: -MObjFPC -Scghi -O2 -g -gl)

# M2: engine, console program
pwsh C:\empire\games\kam-web\_fpc\native\build-native.ps1
#  ppcx64: -Mdelphi -Sh -Sa -Cr -Ci -Co -Ct -dANDROID -uMSWINDOWS -uWINDOWS -dANDROID_PORT
#          -dDBG_SKIP_SECURE_AUTH -dNO_MULTIPLAYER_UI -dBorland -dVer150 -dDelphi7 -dCompiler6_Up -dPUREPASCAL
#          -O2 -gl -vewn  program: tree\android\pascal\headless.lpr
```

Why these choices:
- `-Mdelphi`: the `.lpi` says `SyntaxMode Delphi`; the Android build uses `-MDelphi`. It is kept for fidelity. It does not change the overload errors: builds 14 (without `-Mdelphi`) and 15 (with it) both report 19 errors in `KM_CommonUtils`.
- `-dANDROID -uMSWINDOWS -uWINDOWS`: `-dANDROID` selects the shim/Android branches. Plain `-dANDROID` on win64 also keeps `MSWINDOWS` on, and the two branches collide (see E6-E8). `-u` undefines `MSWINDOWS`/`WINDOWS` so only the Android branch is compiled.
- `-Cr -Ci -Co -Ct`: range, IO, overflow and stack checks, as set in `KaM_Remake.lpi`.

## 4. Error table (every error class hit, count, fix)

Counts are from the build logs in `_fpc\native\` (`build1.log` ... `build-GetOther.log`); a "count" is the number of error lines of that class in the failing run.

| ID | Error (first line) | Unit | Count | Fix | State |
|---|---|---|---|---|---|
| E1 | `Fatal: Can't find unit cthreads` | kamcore.lpr | 1 | Windows program without `cthreads`/`cwstring` (`headless.lpr`) | fixed, patch 0002 |
| E2 | `Error: Illegal expression` on inline `var bType := ...` | pascalscript `uPSCompiler.pas` | 1 | Android patch hunk `bType: TPSBaseType` (the upstream fix) | fixed by applying the Android patch |
| E3 | `Can't find unit KM_Log` / `lconvencoding` / `Masks` | search path | 3 | build script: root `src\`, LazUtils output dir, stale `out\units\masks.ppu` (cleaned) | script fixed |
| E4 | `Error: Illegal expression` on `Param+=Params[p]` | `lazfileutils.pas` (LazUtils) | 3 | LazUtils compiled **separately** with `-MObjFPC` (step M1) | fixed |
| E5 | `Can't find unit ExtCtrls` | `KM_RenderControl.pas` | 1 | `-dANDROID` branch (no ExtCtrls) | fixed (by E6 fix) |
| E6 | `Error: Duplicate identifier "DGLOPENGL"` | `KM_RenderControl.pas` | 1 | define collision `ANDROID`+`MSWINDOWS` on win64 | avoided by `-uMSWINDOWS` |
| E7 | `Incompatible type ... PWideChar, expected PChar` | `KM_FileIO.pas` (CopyFile, SHFileOperation, GetFileAttributesEx) | 5 (build8.log), then 2 (build9.log: SHFileOperationW needs `@ShOp`) | Windows-branch W-API calls (only when MSWINDOWS is on) | avoided by `-uMSWINDOWS`; the W-API edits were reverted |
| E8 | `KromOGLUtils.pas`: `Identifier not found TPixelFormatDescriptor, PFD_*` | `KromOGLUtils.pas` | 43 (build11.log) | Windows OpenGL branch, MSWINDOWS on | avoided by `-uMSWINDOWS` |
| E9 | `Not all declarations of "X" are declared with OVERLOAD` (MapSizeText, Max3, Min3, GetColorBrightness, GetColorDistance, WrapColor, KaMRandom*, KaMRandomWSeed, StrSubstring, DeleteFromArray, TryExecuteMethod(Proc), GetAllPathsInDir, GetGameVersionNum) | `KM_CommonUtils.pas` (implementation headers) | 19 | add `overload` to every implementation header of an overloaded name (`add-overload.ps1`, handles multi-line headers) | fixed in patch 0001 |
| E10 | `Wrong number of parameters ... GetAllPathsInDir` | `KM_CommonUtils.pas` | 1 | consequence of E9 | fixed by E9 |
| E11 | default parameter values repeated in implementation headers (`aAttemps: Byte = DEFAULT...`, `aLogRng: Boolean = True`) | `KM_CommonUtils.pas` | 11 header lines | defaults stripped from implementation headers (interface keeps them) | fixed in patch 0001 |
| **E12** | **`Syntax error, "BEGIN" expected but "INITIALIZATION" found`** | `KM_CommonUtils.pas(2104,1)` | 1 | **OPEN.** Bisect (section 5) shows it appears only when `overload` is on the implementation headers of `GetAllPathsInDir` and/or `GetGameVersionNum` (removing both removes it). Those bodies look well-formed; the cause is not yet identified. | open |

Total: 12 error classes, 4 fixed by source patches or the Android patch (E1, E2, E9, E11), 4 by build-script or build-order changes (E3, E4, E5, E6/E7/E8 avoided by `-uMSWINDOWS`), 1 open syntax error (E12), 1 consequence (E10).

## 5. Bisect of E12 (every run is a real build log)

| Run | Change from the full state | Result |
|---|---|---|
| build23 (full) | `overload` on all 47 implementation headers, defaults stripped | `2104 BEGIN expected` |
| build24 | **bad** replacement (`' overload;'` -> `';'`, produced `;;`) | not evidence |
| build25 | remove `overload` from A-K names (correct replacement) | overload errors only, **no** E12 |
| build27 | remove from A-F | E12 stays |
| build28 | remove from G-names | **no** E12 |
| build29 | remove from KM* names | E12 stays |
| build31 | remove from `KaMRandom` | E12 stays |
| build-GetColorSet | remove from `GetColor*` | E12 stays |
| build-GetOther | remove from `GetAllPathsInDir`, `GetGameVersionNum` | **no** E12 (6 semantic errors only) |

The compiler also says `GetAllPathsInDir(const UnicodeString;TStringList;Boolean) is nested` when that header lacks `overload`, so an earlier routine may not be closed in its eyes. I did not find an unclosed `begin`/`end` by reading lines 1576-1641.

## 6. Patches (`_fpc\patches\`, unified diffs against android-ref r16398)

| No. | File | What | Status |
|---|---|---|---|
| 0001 | `0001-KM_CommonUtils-overload-and-default-values.patch` | `overload` on implementation headers, default values stripped (E9, E11); the file still fails at E12 | incomplete |
| 0002 | `0002-headless-program-from-kamcore.patch` | `kamcore.lpr` -> `headless.lpr` (program, no exports, no `cthreads`/`cwstring`) | done |
| ref | `pascalscript-aarch64.patch` (Android, applied with `git apply`) | PascalScript fixes for aarch64 and the inline-var hunk | applied, not copied here |
| - | `ExtCtrls` shim, `KM_RenderControl`, `KM_FileIO` edits | tried and reverted (they are the MSWINDOWS mix) | none |

## 7. Timings and memory

- LazUtils (23 units, objfpc): one `fpc` run, exit 0; time not separately recorded.
- Engine attempts: each run compiles PascalScript and the engine units in order until the first failing unit. A failure at `KM_CommonUtils` took about 1-2 minutes per run in this session (a fail at `KM_FileIO` took seconds). No full-engine build time exists yet.
- Ticks per second and memory: not measured (no headless run).

## 8. What remains

**(a) Headless native sim you can drive**
1. Fix E12 in `KM_CommonUtils.pas`. Next step: compile `KM_CommonUtils` alone with the build flags and read the parser state at `GetAllPathsInDir`/`GetGameVersionNum`; check the nested-routine message. Effort: 30-60 min.
2. Continue compiling the rest of the engine; expect more errors (not yet seen): the first failing file after `KM_CommonUtils` is unknown. Effort: 1-3 h.
3. Write `headless.lpr` runner: init without forms, `SKIP_RENDER`/`SKIP_SOUND` on, a dummy `gRender` for `TKMGame.Create`, resources from a junction to the owner's `data\` (read-only), settings and saves in `_fpc\native\run\`. Load a map, tick N times, print tick count and state checksum. Effort: 2-4 h.
4. Replay: the owner's `.rpl` are r15472. The engine built here is r16398; check the replay format first (`KM_GameInputProcess.pas` `LoadFromStream`). If incompatible, record a skirmish with this build (the engine's own replay writer) and replay it. CRC verdict from `KM_GameInputProcess_Single.ReplayTimer` (mismatch branch at lines 64-79). Effort: 1-2 h.

**(b) Full GUI exe**: needs the real LCL (lazbuild failed on this PC, see section 2), BGRABitmap, Virtual-TreeView, LazarusOpenGL, and real Windows OpenGL/forms in the MSWINDOWS branch. Effort: 1+ day. Not attempted.

## 9. Reproduce

```
pwsh C:\empire\games\kam-web\_fpc\native\build-lazutils.ps1    # M1
pwsh C:\empire\games\kam-web\_fpc\native\build-native.ps1      # M2, stops at KM_CommonUtils (E12)
```
Logs: `_fpc\native\lazutils.log`, `_fpc\native\build*.log`. Work tree: `_fpc\native\tree` (android-ref r16398 copy with the edits listed above). `_fpc\` is git-ignored; nothing was committed or staged.
