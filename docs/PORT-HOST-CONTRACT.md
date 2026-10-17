# PORT-HOST-CONTRACT: what a web host must give the KaM Remake Pascal engine

Status: research, read-only. Nothing in `_ref/` or `_fpc/` was changed. Scratch scripts and outputs live in `C:\Users\me\AppData\Local\Temp\opencode\hc\`.

## 0. Sources and how the numbers were measured

| Tag | Tree | Entry point used for the compile closure | Defines |
|---|---|---|---|
| **A** | `_ref/kam_remake` = upstream r15472 (AGPL, read-only) | `KaM_Remake.dpr` (the `.lpi` is stale: it lists `src\net\other\KM_DedicatedServer.pas`, which does not exist) | `FPC,UNIX` |
| **B** | `_fpc/android-ref` = Android port repo, engine r16398 (lead note; the README says r16397) | `android/pascal/kamcore.lpr` (the Android `libkamcore.so` entry) | `FPC,UNIX,ANDROID,ANDROID_PORT,DBG_SKIP_SECURE_AUTH,NO_MULTIPLAYER_UI` (flags from `android/build_native.sh`) |

- The compile closure was computed by a uses-clause walker (`hc/closure.mjs`) with a simple `{$IFDEF}`/`{$DEFINE}` evaluator. For B, unit names resolve **shims first** and skip `forms`, `BGRABitmap`, `LazarusOpenGL`, `Overbyte`, `unused`, which mirrors the `-Fu` order in `build_native.sh`.
- Closure sizes: A = 380 files (352 engine `src/`, 27 `src/ext`); B = 382 files (344 engine, 24 ext, 14 `android/pascal` files: 12 shims, `kamcore.lpr`, `KM_AndroidExports.pas`).
- "Calls" are textual occurrences of a name in closure files (comment lines skipped). Code under a branch the evaluator cannot decide is counted. Known over-approximation: `{$IFDEF MSWINDOWS AND DEBUG_NavMesh}` (`src/navmesh/KM_NavMeshGenerator.pas:11`) is not evaluated, so `Windows` shows as an import.
- Where A and B differ, both are given and labelled.

## 1. Headline numbers

| Metric | A (r15472, desktop-style FPC closure) | B (r16398, Android closure) | Source |
|---|---|---|---|
| GL/GLU function names used | **79** (864 call tokens) | **84** (915 tokens) | `hc/gl2-*.txt` |
| GL shader calls (glCreateShader/glUseProgram/glUniform*) | **0** | **0** | closure grep |
| GL_ constants used | 89 | 106 | `hc/gl2-*.txt` |
| BASS calls (`KM_Music.pas`) | 12 names, 27 tokens | 12 names, 27 tokens | `hc/audio-calls-*.txt` |
| OpenAL + ALC + ALUT calls (`KM_Sound.pas`) | 21 names, 43 tokens | same file, same count | `hc/audio-calls.txt` |
| libVLC calls | 22 names, 89 tokens (KM_VLC 66 + KM_Video 23) | 20 names, 23 tokens (KM_Video only; `KM_VLC` is not in the closure) | `hc/audio-calls-*.txt` |
| Install data, whole folder | 1,936.7 MB, 18,127 files | (same install) | `hc/install.txt` |
| Install data the Android port needs (data, Campaigns, Maps, MapsMP, Music, Sounds, Tutorials) | **515.7 MB** | same | `hc/install.txt`, `android/README.md:56` |
| Thread-type occurrences (TThread, TCriticalSection, TEvent...) | 141 in 18 files | 122 in 16 files | `hc/misc-*.txt` |
| Thread creations (BeginThread, CreateAnonymousThread, TKMWorkerThread.Create) | 12 in 5 files | 12 in 4 files | `hc/misc-*.txt` |
| PascalScript methods registered for scripts | **494** `RegisterMethodCheck` calls | **494** | `src/scripting/KM_Scripting.pas:324-1736` |
| Distinct script method signatures (crude regex) | 166 | (not re-run) | `hc/misc.mjs` note |
| Platform units that must be stubbed or provided | 101 unresolved non-engine names | **52** names (after shims) | `hc/closure-*.txt` |
| Android shim units written by the port | n/a | **12 units, 917 lines** | `android/pascal/shims/*.pas` |
| `Extended` occurrences (float type that differs by platform) | 62 in 5 files | 62 in 5 files | `hc/misc-*.txt` |
| Engine `.pas` files under `src/` | 681 (756 incl. `.inc`/`.pp`/ext) | 781 (866 incl. `.inc`/`.pp`/ext); B has 110 files that A lacks, A has 0 that B lacks (B is a superset) | `Get-ChildItem` diff |
| Exported C API (`kam_*`) | n/a | **18** exports + **7** host callbacks | `android/pascal/KM_AndroidExports.pas:15-54` |
| Android-specific glue lines | n/a | **4,156** (listed files) / **5,419** (all android text files) | `hc/` line counts (the brief's "8,500" is **not reproduced**) |

## 2. OpenGL (item 1)

### 2.1 Which units touch GL

| Unit | Role | Closure in A | Closure in B |
|---|---|---|---|
| `src/ext/dglOpenGL.pas` | dynamic GL loader, 2,500 `TglXxx` types; `Assigned(glX)` checks | yes | yes |
| `src/render/KM_Render.pas` | context init, textures, viewport, FBO, readback | 137 tokens | 137 tokens |
| `src/render/KM_RenderTerrain.pas` | terrain: VBO + client arrays (2D), immediate fallback | 383 | 407 |
| `src/render/KM_RenderUI.pas` | UI sprites/lines, clip planes | 304 | 304 |
| `src/render/KM_RenderAux.pas` | debug/aux lines and polygons | 184 | 184 |
| `src/render/KM_RenderPool.pas` | sprite pool: per-sprite immediate quads, stencil+alpha progress | 151 | 151 |
| `src/render/KM_RenderQuery.pas` | GL timer queries (perf only) | 24 | 24 |
| `src/media/KM_Video.pas` | video texture upload (libVLC frames) | 9 | 9 |
| `src/utils/KromOGLUtils.pas` | font display list helpers | 7 | 7 |
| `src/ext/BGRABitmap/bgraopengl.pas` (GLSL, 189 GL tokens) | **not compiled** in A or B | no | no |
| `src/ext/LazarusOpenGL/*` (GLX/WGL contexts) | desktop Lazarus contexts | openglcontext.pas only | shim `android/pascal/shims/OpenGLContext.pas` replaces it |
| `android/pascal/KM_AndroidExports.pas` | debug GL hooks (DbgPopMatrix, LogGLState, LogGLErrors) | - | 70 tokens |

### 2.2 Full GL function list used by the closure (A, r15472; B adds only debug hooks and 5 more names)

Category counts are A's (`hc/gl2-FPC_UNIX.txt`); B's category counts are in the same file under `gl2-android16398.txt`.

| Category | Names (A) | Tokens (A) | Notes and evidence |
|---|---|---|---|
| Immediate mode and fixed-function state | 32 | 658 | `glBegin` 82, `glEnd` 79, `glVertex2f` 140, `glTexCoord2f` 60, `glColor4f` 41, `glColor4ubv` 40, `glVertex3f` 36, `glTexCoord1f` 32, `glRotatef` 7, `glTranslatef` 17, `glPushMatrix`/`glPopMatrix` 11, `glMatrixMode`, `glLoadIdentity`, `glOrtho`, `glTexEnvi`, `glShadeModel`, `glAlphaFunc` 3, `glRasterPos2f`, `glVertexPointer` 7, `glTexCoordPointer` 7, `glClientActiveTexture` 7, `glEnableClientState` 13, `glDisableClientState` 13 |
| State (blend, depth, stencil, lines, points, clear) | 16 | 84 | `glBlendFunc` 18, `glLineWidth` 18, `glEnable` 15, `glDisable` 12, `glStencilFunc` 2, `glStencilOp` 3, `glPolygonMode`, `glDepthFunc`, `glHint`, `glClear`, `glClearColor`, `glClearStencil`, `glViewport`, `glFinish`, `glLineStipple`, `glPointSize` |
| VBO / index buffers | 5 | 43 | `glGenBuffers`, `glBindBuffer`, `glBufferData` (8 sites in `KM_RenderTerrain.pas:1192-1229`), `glDrawElements` (GL_UNSIGNED_INT indices, `KM_RenderTerrain.pas:613`), `glDeleteBuffers` |
| Attribute stack | 2 | 18 | `glPushAttrib(GL_COLOR_BUFFER_BIT)` / `glPopAttrib` around the stencil mask (`KM_RenderPool.pas:1272`, `:1319`) |
| Textures | 5 | 16 | `glGenTextures`, `glBindTexture`, `glTexImage2D` (5), `glTexParameteri` (5), `glDeleteTextures` |
| Framebuffers / renderbuffers | 8 | 13 | created in `KM_Render.pas:165-170` (`InitFBO`); used by WDC readback only |
| Timer queries | 4 | 16 | `glGenQueries`, `glQueryCounter` (GL_TIMESTAMP), `glGetQueryObjectui64v` (`KM_RenderQuery.pas:58-121`); perf logging only |
| Query state | 2 | 11 | `glGetIntegerv` (8: `GL_MAX_TEXTURE_SIZE`, `GL_MAX_VIEWPORT_DIMS`, `GL_LINE_WIDTH`), `glGetString` (3: vendor, renderer, version, `KM_Render.pas:129-131`) |
| Readback | 2 | 2 | `glReadPixels` is inside `{$IFDEF WDC}` (`KM_Render.pas:331-357`), so **not executed in FPC/Android builds** |
| Display lists | 2 | 2 | `glListBase`, `glCallLists` (`KromOGLUtils.pas:245-246`, font drawing) |
| GLU | 1 | 1 | `gluPerspective` (`KM_Render.pas:210`), only in `rm3D`; `RENDER_3D = False` (`common/KM_Defaults.pas:203`) |
| **Shaders (GLSL)** | **0** | **0** | no `glCreateShader`/`glUseProgram`/`glUniform*` outside `bgraopengl.pas`, which is not compiled |

### 2.3 Usage details that a WebGL layer must reproduce

| Feature | Evidence (A unless noted) | WebGL2 consequence |
|---|---|---|
| Per-sprite immediate quads | `KM_RenderPool.pas:1286-1291`: `glBegin(GL_QUADS)` + 4x `glTexCoord2f`/`glVertex2f`; sprites are drawn this way | the hot path; batch into one dynamic VBO per frame in JS |
| Alpha test (construction progress) | `KM_RenderPool.pas:1277-1316`: `glEnable(GL_ALPHA_TEST)`, `glAlphaFunc(GL_GREATER, 1 - progress)` | no fixed-function alpha test in WebGL2; needs a fragment-shader uniform and `discard` |
| Stencil masking (construction) | `KM_RenderPool.pas:1265-1322`: `glStencilFunc`, `glStencilOp(GL_REPLACE/GL_DECR/GL_KEEP)`, `glColorMask(False,...)` | WebGL2 supports stencil if the context is created with `stencil: true` |
| User clip planes | `KM_RenderUI.pas:93-109`: `glClipPlane` for PLANE0..3 (4 calls each) | no clip planes in WebGL; use `discard` against a uniform plane equation, or `scissor` for axis-aligned clips |
| Line width | `glLineWidth(fViewport.Zoom * 2)` (`KM_RenderPool.pas:274`), `glLineWidth` 18 sites | WebGL lineWidth is 1 in practice; draw lines as thin quads |
| Point size | `glPointSize(fViewport.Zoom * 5)` (`KM_RenderPool.pas:275`), `glPointSize(3)` (`KM_RenderAux.pas:672`) | point sprites are not in WebGL2 core; draw quads |
| Polygon primitives | `GL_POLYGON` 6 sites (`KM_RenderAux.pas:151-183`, `KM_RenderUI.pas:669-983`) | triangulate as a fan (convex only) |
| Texture env | `glTexEnvi(GL_TEXTURE_ENV, GL_TEXTURE_ENV_MODE, GL_MODULATE)` (`KM_Render.pas:228`) | fragment multiply of texture and vertex colour |
| Texture formats | `KM_Render.pas:301` `GL_RGB5_A1`, `:303` `GL_RGBA`, `:305` **`GL_ALPHA`** internal format, all uploaded as `GL_RGBA/GL_UNSIGNED_BYTE` | `GL_ALPHA` as an internal format is not valid in WebGL2: map to `R8` with a swizzle or store RGBA |
| Wrap and filter | `GL_CLAMP` (`KM_Render.pas:239-240`), `TEX_FILTER` NEAREST/LINEAR (`:13`), `GL_TEXTURE_MAX_LEVEL 0` (`:236`) | `GL_CLAMP` maps to `CLAMP_TO_EDGE`; no mipmaps needed |
| Power-of-two textures | `KM_Render.pas:290` assert: "Game designed to handle only POT textures" | atlases must be POT (WebGL1-style limit, kept) |
| Max texture size | `glGetIntegerv(GL_MAX_TEXTURE_SIZE)` (`KM_Render.pas:270`) | answer from `gl.getParameter(MAX_TEXTURE_SIZE)` |
| Terrain | `VBOSupported`: lines 217-220; `DoUseVBO = VBOSupported and not RENDER_3D` (`KM_RenderTerrain.pas:229`); client arrays + `glDrawElements(GL_TRIANGLES, GL_UNSIGNED_INT)` (`:606-613`); `glTexCoord1f` 32 sites (`:954-1166`) | VBO plus client arrays: upload from wasm memory views, indices as `Uint32Array` (WebGL2 supports 32-bit indices) |
| Frame buffer / FBO | `InitFBO` at `KM_Render.pas:374`; FBO size capped at `MAX_FBO_BUFFER_SIZE = 10200` (`:90`) | create a WebGL framebuffer on demand; cap at the context's `MAX_RENDERBUFFER_SIZE` |
| GL version gate | `IsOldGLVersion` requires `GL_VERSION_1_4` (`KM_Render.pas:312-315`) | report GL 2.1-equivalent |

### 2.4 How the Android port runs it

- The engine's fixed-function GL is **not rewritten**. `android/README.md:69-70` says the desktop GL runs on GLES2 through **gl4es** (ptitSeb) with two patches in `android/toolchain/patches/gl4es-android-host-context.patch` (3,668 bytes; touches `src/CMakeLists.txt`, `src/gl/listdraw.c`, `src/glx/hardext.c`).
- gl4es translates immediate mode, display lists, client arrays and the matrix stack into GLES2. The Android code does not implement any of those itself. `android/pascal/shims/OpenGLContext.pas` (6 lines) stubs the Lazarus context; `KaMView.java` (294 lines) owns the EGL surface on a `GLSurfaceView` (`RENDERMODE_CONTINUOUSLY`, line 53).

### 2.5 Verdict on a hand-written fixed-function-to-WebGL2 layer

**Feasible, and smaller than gl4es.** The closure uses 79 names, no shaders, no lighting, no fog, no display-list-heavy paths beyond the font helper, and no readback on FPC builds. The required JS work:

| Piece | Estimate (lines of TypeScript) | Why |
|---|---|---|
| Immediate-mode batcher (glBegin/glEnd -> VBO triangles; QUADS, TRIANGLES, TRIANGLE_FAN, POLYGON, LINES, POINTS) | 300-400 | one vertex stream per frame |
| Matrix stacks (ModelView/Projection; glOrtho, gluPerspective, translate/rotate/scale) | 150-200 | 2D ortho is the common path |
| Shader set: textured+colour, alpha test uniform, clip-plane discard | 150-250 | three or four programs |
| Texture manager (glGenTextures, upload formats, filters, clamp, POT check) | 200-300 | `GL_ALPHA` mapping |
| State machine (enable/disable, blend, depth, stencil, colour mask, push/pop attrib) | 250-350 | `glPushAttrib` must save and restore colour, line, point and depth |
| VBO + client arrays (terrain) | 150-200 | reads from wasm linear memory |
| Framebuffers, queries (timer queries return 0), readback stub | 100-150 | queries are perf-only |
| **Total** | **~1,300-1,850** | estimate, not measured |

Pascal-side work that remains: `dglOpenGL.pas` expects function pointers that are `Assigned()`-checked. A web build needs a replacement loader (or `external` declarations for the 79 names), estimated 150-250 lines of Pascal (UNVERIFIED).

Alternative: Emscripten + gl4es (GLES backend) would reuse the Android path. Whether gl4es builds against Emscripten's WebGL2 is **UNVERIFIED**.

## 3. Audio (item 2)

### 3.1 Calls by library (closure, both trees, same counts)

| Library | Unit that calls it | Distinct names | Tokens | Names (most used first) |
|---|---|---|---|---|
| BASS (music streams) | `src/media/KM_Music.pas` | 12 | 27 | `BASS_StreamFree` 4, `BASS_ChannelStop` 4, `BASS_ChannelPlay` 4, `BASS_StreamCreateFile` 2, `BASS_ErrorGetCode` 2, `BASS_ChannelSetAttribute` 2, `BASS_ChannelIsActive` 2, `BASS_ChannelSlideAttribute` 2 (volume fades), `BASS_ChannelPause` 2, `BASS_SetConfig`, `BASS_Init`, `BASS_ChannelGetAttribute` |
| OpenAL Soft (effects) | `src/media/KM_Sound.pas` | 13 `al*` names | 34 | `alSourcef` 8, `alSourcei` 7 (looping), `alBufferData` 4, `alListenerfv` 2, `alSourcefv` 2, `alSourceStop` 4, `alDeleteBuffers`, `alGenBuffers`, `alGenSources`, `alSourcePlay`, `alGetSourcei`, `alDistanceModel` |
| ALC | `KM_Sound.pas` | 5 | 6 | `alcOpenDevice`, `alcCreateContext`, `alcMakeContextCurrent`, `alcGetIntegerv`, `alcGetError` |
| ALUT (WAV loader) | `KM_Sound.pas` | 3 | 3 | `alutLoadWAVFile`, `alutUnloadWAV`, `AlutExit` |
| libVLC (video, not audio) | `KM_VLC.pas` (A only) and `KM_Video.pas` | 22 (A) / 20 (B) | 89 (A) / 23 (B) | `libvlc_media_player_*`, `libvlc_video_set_callbacks` |

- Positional sound is real: `alListenerfv`, `alSourcefv`, `alDistanceModel` are used in `KM_Sound.pas`. A WebAudio port maps each source to a `PannerNode`, the listener to `AudioListener`.
- Loops: `alSourcei` (7 tokens) carries the loop flag; `KM_ScriptSound.pas` has `aLooped` / `aLoopedOnly` parameters that feed it.
- Fades: `BASS_ChannelSlideAttribute` (2) in `KM_Music.pas`.

### 3.2 What the Android port implements (`android/native/bass_android.c`, 564 lines)

- Exports 17 `BASS_*` functions with `API` tags (lines 393-608). **All 12 names the engine calls are among them**: SetConfig, GetConfig, GetVersion, ErrorGetCode, Init, Free, Stop, Start, StreamCreateFile, StreamFree, ChannelPlay, ChannelStop, ChannelPause, ChannelIsActive, ChannelSetAttribute, ChannelGetAttribute, ChannelSlideAttribute.
- Decoding: `minimp3_ex.h` (MP1/2/3) and `vorbis/vorbisfile.h` (OGG). Streaming runs on a pthread (`stream_thread`, line 357; `pthread_create` line 432).
- OpenAL Soft for SFX (`<AL/al.h>`, `<AL/alc.h>`, line 7-8).

### 3.3 What a WebAudio host needs

| Need | Data in the install | Browser path | Status |
|---|---|---|---|
| WAV SFX | 9,309 `.wav` files, 430.8 MB (includes `Sounds/` 12 files, 4.0 MB) | parse PCM directly (8/16-bit) or `decodeAudioData` | standard |
| MP3 music | 642 `.mp3` files, 183.1 MB (`Campaigns/` 302, `Music/` 2) | `decodeAudioData` | standard |
| OGG | 69 `.ogg`, 9.7 MB | `decodeAudioData` | standard in Chromium/Firefox |
| **MP2 music** | **44 `.mp2` files, 159.6 MB** (`Music/` 22 of 24 files; `KaM Remake Beta r15472/` 22) | **UNVERIFIED**: `decodeAudioData` is not expected to decode MPEG-1 Layer II. Plan a wasm/JS MP2 decoder (minimp3 covers MP1/2/3 in the Android port) | risk |
| Streaming vs decode-all | 159.6 MB of MP2 + 183 MB of MP3 | stream long tracks through `<audio>` or chunked `AudioBufferSourceNode` | design choice |

Audio calls are not called from a thread the engine owns: `KM_Sound.pas:185` uses `TThread.CreateAnonymousThread`, which can run synchronously on wasm (see section 5).

## 4. Files (item 3)

### 4.1 What the engine reads at startup and during play

| Path (relative to `ExeDir`) | Evidence (A) | Used for |
|---|---|---|
| `data/defines/tiles.json` | `res/KM_ResTileset.pas:113` | tileset (JSON) |
| `data/defines/mapelem.dat`, `unit.dat`, `houses.dat`, `interp.dat` | `res/KM_Resource.pas:192,252`, `KM_ResUnits.pas:531`, `KM_ResHouses.pas:799` | game definitions (`LoadHouseDat` returns a CRC, `KM_ResHouses.pas:799`) |
| `data/gfx/` (palettes, fonts) | `res/KM_Resource.pas:161`, `KM_ResFonts.pas:77` (`data/gfx/fonts/`) | palettes, `.fntx` fonts |
| `data/Sprites/*.rxx`, `*_a.rxx`, `*.rxa` | `res/KM_ResSprites.pas:1912,2033-2041` | sprite atlases (RXX zlib, RXA folders) |
| `data/text/text.<locale>.libx` | `res/KM_Resource.pas:215` | localisation |
| `data/locales.txt` | `res/KM_Resource.pas:212` | locale list |
| `data/sfx/sounds.dat`, `data/sfx/speech.<locale>/` | `res/KM_ResSound.pas:319-323,453-537` | SFX table and speech |
| `data/cursors/*` | `KM_System.pas:179` | cursors (desktop only) |
| `Campaigns/`, `Maps/`, `MapsMP/`, `MapsDL/`, `Tutorials/` (`*.map`, `*.dat`, `*.script`, `*.libx`) | `common/KM_Defaults.pas:544` (`MAPS_FOLDER_NAME = 'Maps'`), `mission/KM_Maps.pas`, `KM_Campaigns.pas` | maps, mission defines, scripts |
| `Music/*.mp2, *.mp3` | `media/KM_Music.pas` | music |
| `Sounds/*.wav` | `res/KM_ResSound.pas:215` (`NEW_SFX_FOLDER = 'Sounds/'`) | new SFX |

Sizes come from `hc/install.txt`: `data` 144.1 MB (4,548 files: 4,476 `.wav`, 10 `.rxx`, 11 `.dat`, 26 `.libx`), `Campaigns` 129.0 MB (1,345 files: 302 `.mp3`, 67 `.map`, 67 `.dat`, 835 `.libx`), `Maps` 17.3 MB (253), `MapsMP` 130.7 MB (1,307), `Music` 89.2 MB (24), `Sounds` 4.0 MB (12), `Tutorials` 1.4 MB (48). **Total 515.7 MB.** `MapsDL` (211.9 MB, 773 files) is not in the Android list.

### 4.2 What the engine writes

| Path | Evidence | Notes |
|---|---|---|
| `Logs/KaM_<timestamp>.log` | `KM_Main.pas:276,282` | `CreateDir` on start; old-log deleter thread (`KM_Log.pas:112`) |
| Startup write probe | `KM_Main.pas:189` `TryWriteIntoGameFolder` | the engine tests that the folder is writable; the web host must answer yes |
| `Saves/`, `SavesMP/` (`.sav`, `.bas`, `.rpl`) | install folders: `SavesMP` 37 files, 90.7 MB | saves and replays (`KM_Game.pas:2216-2345`, save workers) |
| `KaM_Remake_Settings.ini` | install top level | settings (`settings/KM_GameAppSettings.pas`) |
| `*.mi` map caches | `KM_Main.pas:340-341,767-770` (`TTMapsCacheUpdater`, background thread) | optional; skip on web |
| `crashreport` | `common/KM_Defaults.pas:331` | optional |
| `Export/` | `res/KM_ResExporter.pas`, `KM_ResSound.pas:418`, `KM_ResFonts.pas:587` | developer tools only |

### 4.3 Random access and memory

- File access is `TFileStream` (8 `TFileStream.Create` sites in `res/` and `utils/io/`) and `Seek` (7 sites). `.rxx` atlases are loaded through `LoadFromRXXFile` (`KM_ResSprites.pas:2035-2041`). No `mmap` was seen in these directories. Not verified across the whole tree.
- **Engine RAM use is not documented in the source (UNVERIFIED).** Do not claim a number until a headless run measures it.

### 4.4 Recommendation for the browser file system

Constraints: WASI and the Pascal RTL call **synchronous** `fd_read`/`fd_seek`. A browser `Blob` or `File` read is asynchronous. Therefore:

1. **Engine runs in a dedicated Worker**, and the same worker holds the OPFS `FileSystemSyncAccessHandle` for each file (sync, Worker-only API). The canvas goes to the worker via `OffscreenCanvas`. Input and audio cross by `postMessage`.
2. **Read-only game data** lives in OPFS, imported once from the player's folder (the 515.7 MB set). Keep it on disk and read lazily through sync handles. Do not copy it all into wasm memory. A pre-built index (path -> OPFS file) avoids directory walks.
3. **Writable state** (`Logs/`, `Saves/`, `SavesMP/`, settings) goes to OPFS directories with the same sync handles.
4. **In-memory FS** (copy everything into a JS `Map` at start) is the fallback for small test maps. It costs 515.7 MB of JS heap plus the same in wasm, which is too much for a 4 GB wasm32 budget with the engine's own data.
5. Memory budget (UNVERIFIED until measured): wasm32 is limited to 4 GiB linear memory. Sprite CPU copies, map data and the engine heap stay in wasm; GPU atlases stay on the GPU; sounds stream from OPFS.

## 5. Threads (item 4)

Browsers give WASI no threads in the target the port would use (`wasi-threads` is a proposal). Every thread must become a synchronous call or be removed.

| Thread or lock | Evidence (A) | Can be synchronous? | Plan |
|---|---|---|---|
| `TKMWorkerThread` (save worker) with 4 holders | `common/KM_WorkerThread.pas:19` (class), `:73-88` (ctor), `:135` (Execute), `:192-245` (`QueueWork`, `QueueWorkAndLog`, `QueueWorkAndCallback`), `:242` `WaitForAllWorkToComplete`; holders `KM_Game.pas:95-98`, `KM_GameApp.pas:43-46,238-241` | yes | **seam:** make `QueueWork*` run the proc inline and call the callback at once; `WaitForAllWorkToComplete` becomes a no-op |
| `TKMCampaignsScanner(TThread)` | `mission/KM_Campaigns.pas:154`, `:83,174,240` (`TCriticalSection`) | yes | run the scan inline on first use |
| `TKMOldLogsDeleter(TThread)` | `KM_Log.pas:112`, `:130`, `:175` (`TCriticalSection`) | yes (skip) | skip on web |
| `TTMapsCacheUpdater` (map cache) | `KM_Main.pas:34,770` | yes (skip) | skip on web |
| `TThread.CreateAnonymousThread` (sound) | `media/KM_Sound.pas:185` | yes | inline or drop |
| Video callbacks | `media/KM_Video.pas:34,144` (`TCriticalSection`) | yes | video via HTML `<video>` (see 3) |
| Lock-only sites | `KM_Log.pas:175` and `KM_Video.pas:144` create critical sections; `KM_Game.pas:2376` `Sleep(10000)` (context not read) | yes | no-op locks |
| Frame timing | `KM_MainAndroid.inc:321-` uses `TimeGet`/`TimeSince` (wall clock), no thread | yes | `performance.now()` |

Counts (closure): thread-type names 141 occurrences in 18 files (A) / 122 in 16 files (B); thread creations 12 in 5 files (A) / 4 in 4 files (B); sync and wait (`Sleep`, `WaitFor`, `Synchronize`, `Enter`, `Leave`...) 100 in 17 files (A) / 102 in 16 files (B).

Fine-grained locks in `KM_Log.pas` and `KM_Video.pas` are the only ones left after the seam, both can be no-ops in a single-threaded worker.

## 6. Network (item 5)

### 6.1 The stack

| Part | Evidence | Notes |
|---|---|---|
| Socket layer (FPC) | `net/KM_NetServerLNet.pas` (15 socket tokens), `KM_NetClientLNet.pas` (12), `KM_NetUDPLNet.pas` (6), `KM_HTTPClientLNet.pas` (2); LNet source in `src/ext/LNet/` (`lnet.pp`, `lcommon.pp`, ...) | the closure for both A and B uses LNet (`{$IFDEF FPC}`) |
| Socket layer (Delphi, not in the Android build) | `KM_NetClientOverbyte.pas`, `KM_NetServerOverbyte.pas`, `KM_NetUDPOverbyte.pas` (Overbyte ICS 8) | not compiled for FPC |
| Client protocol API | `net/KM_NetClient.pas:62` `ConnectTo(aAddress, aPort)`, `:124-133` | the interface a web client would replace |
| Server | `net/KM_NetServer.pas` (TCP), `net/KM_NetDedicatedServer.pas` (headless server, in B's closure) | the same protocol as the desktop |
| Defaults | `settings/KM_ServerSettings.pas:150` `ServerPort = '56789'` (TCP); `:151` `UDPScanPort`; `common/KM_Defaults.pas:410` `SERVER_DEFAULT_UDP_SCAN_PORT = 56788`, `:411` `SERVER_DEFAULT_UDP_ANNOUNCE_PORT = 56789` | game traffic is TCP; LAN discovery is UDP |
| Authentication | `KM_NetAuthSecure` is **absent from both trees**; `KM_NetAuthUnsecure` replaces it (`kamcore.lpr`, `DBG_SKIP_SECURE_AUTH`) | interop with the official server's auth is **UNVERIFIED** |
| Protocol revision | `KM_NetProtocolRevision.inc` (root of both trees, not read) | must match the server build |
| Dedicated server binaries in the install | `KaM_Remake_Server_x86_64` 2.8 MB, `KaM_Remake_Server_x86` 2.2 MB, `KaM_Remake_Server_win32.exe` 1.3 MB | can run the real server headless for tests |
| Dedicated server source | `Utils/DedicatedServer/` (`.dpr`, `.lpi`, `build_x86_64.sh`) in both trees | built with FPC on Linux |
| Multiplayer switch in the Android port | `NO_MULTIPLAYER_UI` hides the menu (`android/build_native.sh`); the README says "not finished" | MP is off on Android |

### 6.2 Plug-in point for a WebSocket client

The engine needs a socket object with `Connect(host, port)`, `Send(bytes)`, `OnReceive(bytes)`, `OnError`, `OnDisconnect`, and for discovery a UDP send/receive pair. A WebSocket replacement implements the TCP part as a websocket-backed class and must add a pluggable `TKMNetClient` factory (the engine currently instantiates `TKMNetClientLNet` directly, `KM_NetClientLNet.pas:77-87`). Estimate: 400-600 lines JS plus 60-100 lines Pascal glue (UNVERIFIED).

### 6.3 Can a browser client talk to the real dedicated server?

**Yes, through a websockify-style bridge**, because the server speaks plain TCP on 56789. Limits:

- UDP LAN discovery (ports 56788/56789) does not work from a browser. Use a manual address or an HTTP server list (`KM_HTTPClientLNet.pas` already fetches over HTTP).
- The secure auth unit is missing from both trees. Interop with the public official server is UNVERIFIED.
- Lockstep timing: the server's tick rate and the browser's wall-clock tick (section 9) must be compared under latency. This is an M6 test, not measured here.

## 7. PascalScript (item 6)

### 7.1 Where the call bridge lives

| Item | Evidence (B, the fetched submodule; A's submodule is **empty**) |
|---|---|
| Submodule | `src/ext/pascalscript_submodule/Source/` (B). In A, `src/ext/pascalscript_submodule` exists but has **0 files** (`.gitmodules` lists it; not fetched). A cannot build the bridge |
| Bridge entry | `uPSRuntime.pas:672` `InnerfuseCall` (called from `:10540-10735` and `:11122-11645`) |
| Bridge selection | `uPSRuntime.pas:10144-10192`: whole block is `{$IFNDEF FPC}` for Delphi; the FPC branch is `:10170-10190`: `{$if defined(cpu86)} x86.inc`, `cpupowerpc` powerpc.inc, `cpuarm` arm.inc, `CPUX86_64` x64.inc, `{$else} {$fatal Pascal Script is not supported for your architecture at the moment!}` (`:10185-10186`) |
| CPU bridge files | `x86.inc` 766 lines (6 `asm` lines), `x64.inc` 730, `arm.inc` 356, `powerpc.inc`; generic RTTI `InvokeCall.inc` (not used for FPC: `USEINVOKECALL` is only set under `{$IFNDEF FPC}`, line 10150) |
| KaM switch | `PS_KMR.inc:6` `{$DEFINE PS_USECLASSICINVOKE}` |

### 7.2 What the Android patch changes (`android/toolchain/patches/pascalscript-aarch64.patch`, 32,189 bytes)

- Files touched: `Source/PascalScript.inc`, `Source/PascalScriptFPC.inc`, `Source/uPSCompiler.pas`, `Source/uPSRuntime.pas` (edits) and new `Source/aarch64.inc`, `Source/aarch64methods.inc`. Totals: 889 added lines, 4 removed.
- `aarch64.inc` implements `aarch64call` as an **assembler** routine (`nostackframe`, line 67 of the patch) and the caller (line 510). Its comment: FPC 3.2.2 "has no Rtti.Invoke manager for aarch64" (patch line 20).
- `aarch64methods.inc`: the `MyAllMethodsHandler` for the FPC aarch64 ABI (patch line 562).
- The bridge chain gains `{$elseif defined(cpuaarch64)} {$include aarch64.inc}` (patch lines 1022-1025).
- `{$OPTIMIZATION NOCSE}` for aarch64 (patch lines 9-10): "FPC 3.2.2 aarch64 node CSE (enabled by -O2) generates invalid code".

### 7.3 Equivalent for wasm32

- **There is no non-assembly fallback** in the submodule. `InvokeCall.inc` uses RTTI invocation that FPC does not support, and `x86/x64/arm/powerpc` are native-call code. WebAssembly has no way to call a function pointer of arbitrary signature, so a native-style bridge cannot be ported.
- **Options for wasm32:**
  1. **Generated dispatch (recommended):** replace the bridge with a generated `case` over the 494 registered methods. Each case unpacks typed arguments from the PascalScript stack and calls the real function directly. The 166 distinct signatures (crude count) are mostly `Integer`/`Byte`/`Boolean`, which map to `i32`. Estimate: 1,000-1,500 lines generated Pascal (UNVERIFIED).
  2. **Stub the bridge:** raise a runtime error when a script calls a method. Skirmish still works (see 7.4), campaigns and scripted maps do not.
- Compiler: the Free Pascal wiki documents a demo that compiles Pascal "to Wasm using FPC WASI target" (websearch, 2026). Maturity and whether FPC 3.2.2 supports it are **UNVERIFIED**; the Android path is FPC 3.2.2 for aarch64-android.

### 7.4 What works without scripting (verified)

- Script events are guarded: `scripting/KM_ScriptingEvents.pas:1218-1222` (`ProcPlayerVictory`: `if MethodAssigned(evtPlayerVictory) then CallEventHandlers(...)`) and `ProcHouseDamaged` likewise. With no script loaded, nothing reaches PascalScript.
- The AI does **not** reference the script engine: `gScripting` appears 0 times under `src/ai/` and `src/ai/newAI/`. The AI calls `gScriptEvents` five times (`KM_AI.pas:135,154,376`, others), each guarded as above.
- So **skirmish against the Advanced AI does not run PascalScript code**, provided the map has no `.script`. Scripted maps and campaigns need the bridge. Install: 683 `.script` files (27.2 MB), 6 `.spt`, 798 `.dat` mission definitions.
- The PascalScript units still have to **compile** for wasm32, so the bridge stub must exist at build time even when unused.

## 8. Platform units (item 7)

### 8.1 Closure imports that are not engine code

| Group | Units (B closure, after shims; A's list is larger) |
|---|---|
| Provided by the Android shims (12) | `Forms`, `Controls`, `Dialogs`, `Graphics`, `Clipbrd`, `LCLIntf`, `LCLType`, `Mouse`, `OpenGLContext`, `KM_FormLogistics`, plus `KMAndroidHost`, `KMAndroidLog` (917 lines in total) |
| FPC RTL (no stub needed) | `SysUtils` (275 importers), `Math` (220), `Classes` (217), `StrUtils` (56), `TypInfo` (46), `Generics.Collections` (37), `Types` (20), `SyncObjs` (6), `Contnrs` (3), `DateUtils` (3), `cthreads`, `cwstring`, `unix`, `baseunix`, `UnixUtil`, `DynLibs`, `Generics.Defaults`, `Generics.Hashes`, `base64`, `Variants` |
| FCL / packages (must be built for aarch64/wasm) | `zstream` (paszlib, 4), `INIfiles` (4), `fpjson`, `jsonparser`, `jsonscanner`, `FPImage`, `FPReadPNG`, `FPWritePNG`, `FPWriteBMP` (fcl-image; replaces BGRABitmap for PNG), `RegExpr`, `FPTimer`, `URIParser`, `Errors` |
| LazUtils (built by `build_lazutils.sh`) | `LazUTF8`, `lconvencoding`, `LazFileUtils`, `FileUtil`, `laz2_DOM`, `laz2_XMLRead`, `laz2_XMLWrite` |
| Windows / OS (guarded or false positive) | `Windows` (2: `KM_NavMeshGenerator.pas:11` guarded by `MSWINDOWS AND DEBUG_NavMesh`, and `uPSCompiler.pas`), `Ole2` (`uPSCompiler`, `uPSRuntime`, probably `PS_FPC_HAS_COM`) |
| Name artifacts (not units) | `const`, `type`, `classes`, `types`, `strutils`, `sysutils`, `syncobjs`, `typInfo`, `cTypes`, `Interfaces` (LCL, desktop only) |
| Desktop-only excluded by `kamcore.lpr` | `KM_FormMain`, `KM_FormLogistics`, `KM_FormLoading`, `KM_VclMenuHint`, `KM_VclHelpers`, `iaWin.NameDelphiThreads`, `KM_DevPerfLogForm`, `KM_VLC`, `KM_ResExporter`, `KM_SettingsDev`, `KromShellUtils`, `KM_NetAuthSecure` (not in sources) |

### 8.2 Which Android shim covers what

| Shim | Lines | Covers |
|---|---|---|
| `Forms.pas` | 126 | `Application` loop hooks, `TForm` stubs |
| `Controls.pas` | 114 | `TControl`, `TMouseButton`, `TShiftState` |
| `Graphics.pas` | 198 | `TBitmap`, `TCanvas` over FPC image units |
| `LCLType.pas` / `LCLIntf.pas` | 174 / 55 | key codes, `Application.ProcessMessages`, timers |
| `Clipbrd.pas` | 100 | clipboard, via host callbacks |
| `Dialogs.pas` | 38 | `ShowMessage` through host callback |
| `Mouse.pas` | 24 | cursor shape stubs |
| `KMAndroidHost.pas` | 35 | the host callback table |
| `KMAndroidLog.pas` | 17 | logcat |
| `KM_FormLogistics.pas` | 30 | desktop form stub |
| `OpenGLContext.pas` | 6 | GL context stub |

A web port needs the same set, with `KMAndroidHost` replaced by the JS bridge (7 callbacks, section 10).

## 9. Floating point (item 8)

### 9.1 `Extended` (80-bit on x86 Windows and x86-64 Linux; platform-dependent on aarch64 and wasm)

Only **5 files** use `Extended` (62 occurrences, identical in A and B):

| File | Count | Where it matters |
|---|---|---|
| `utils/KM_CommonUtils.pas` | 11 | **the game's RNG**: `KaMRandom(): Extended` (line 81), `KaMRandomWSeed(var aSeed): Extended` (line 77, impl. 1425-1450). The Park-Miller LCG is integer; then `Result := aSeed / M` (a division in `Extended`), and `KaMRandomWSeed(seed, aMax) := Trunc(KaMRandomWSeed(aSeed) * aMax)` (in `Extended`) |
| `common/KM_CommonClasses.pas` | 11 | **save and replay formats**: `TKMemoryStreamBinary.Write(Extended)` = `WriteBuffer(Value, SizeOf(Value))` (line 1621), `Read` (1600); text variant (1748, 1843); `TKMWeightedPointList.GetWeightedRandom` uses `weightsSum, rnd: Extended` (line 1045) |
| `scripting/KM_Scripting.pas` | 14 | script float parameters |
| `scripting/KM_ScriptingUtils.pas` | 24 | script float marshalling |
| `common/KM_CommonClassesExt.pas` | 2 | helpers |

The Android README (line 79-80) says saves and replays made on Windows "may not load" because scripts stored `Extended` values (80-bit vs 64-bit on arm64). The source confirms the mechanism: `SizeOf(Extended)` differs per platform, so binary streams are not portable.

**Determinism risk for the RNG:** the desktop computes `Trunc((seed/M) * aMax)` with 80-bit intermediates. A 64-bit `Double` path can round differently near an integer boundary. The kam-web M2 harness reproduced 6 real r15472 replays (`docs/PLAN.md:55-56`), which is evidence the 64-bit path matches in practice but not proof for every draw. The check to run: compare the CRC chain for every replay, and any RNG difference shows as a first-divergence tick.

### 9.2 `Single` and `Double` in simulation

| Type | Count (A) | Where | Determinism |
|---|---|---|---|
| `Single` | 1,668 tokens in 116 engine files (B: 1,667 in 115) | `KM_Points.pas:24-25` `TKMPointF = record X,Y: Single`; `KM_Units.pas`, `KM_Terrain.pas`, `KM_Projectiles.pas`, `KM_UnitGroup.pas`, `KM_Game.pas`, `KM_Viewport.pas` | IEEE binary32 on x86-64 SSE and on wasm `f32`: same results if no fused multiply-add is introduced. Safe |
| `Double` | 17 tokens in 4 files | `KM_CommonUtils.pas` 9, `KM_CityPlanner.pas` (AI) 6, `KM_Game.pas` 1, `KM_NavMeshGenerator.pas` 1 | IEEE binary64 on all targets. Safe |
| `Extended` | 62 tokens in 5 files | section 9.1 | **platform dependent**: risk |
| Trig and transcendental (`Sin`, `Cos`, `ArcTan`, `ArcTan2`, `Power`, `Ln`, `Exp`...) | 61 in 19 files | `KM_ScriptingUtils.pas` 12, `KM_Points.pas` 7, `KM_CommonUtils.pas` 6, `KM_Units.pas` 3, `KM_UnitGroup.pas` 2, `KM_NavMesh*` | `Sqrt` is correctly rounded (safe). `ArcTan`/`ArcTan2`/`Sin`/`Cos` come from the platform libm and are **not** guaranteed bit-identical across libm and JS `Math`. The kam-web rule "no transcendentals in sim" (`docs/PLAN.md:90`) must be checked against the 7 `KM_Points.pas` uses (UNVERIFIED which are sim-reached) |
| `Random`/`Randomize` (FPC RTL) | 70 occurrences in 23 files (B: 69/22); `KM_RandomMapGenerator.pas` 21 | RMG and some sim code | must not reach the sim; the sim uses `KaMRandom` |

## 10. Main loop and exports (item 9)

### 10.1 Desktop loop (A)

- `KM_Main.pas:561` `TKMMain.DoIdle` (the LCL `Application.OnIdle` handler, set at `:335`), `:516` `DoRender` calls `gGameApp.UpdateStateIdle` (`:523`) and `gGameApp.Render` (`:524`), `:604` `gGameApp.UpdateState`, `:344` `Application.ProcessMessages`. Timer precision: `TimeBeginPeriod(1)` (`:270`).

### 10.2 Android loop (B, `src/KM_MainAndroid.inc`, 370 lines)

- `KaMView.java:121` `onDrawFrame` (GL thread) calls `KaMNative`, which calls `kam_frame` -> `TKMMain.Frame` (`KM_MainAndroid.inc:321`).
- `Frame`: runs game ticks at a fixed interval (`fGameTickInterval`), up to `MAX_TICKS_PER_FRAME = 10` (line 324), skips the backlog if behind, calls `gGameApp.UpdateState` every 100 ms (`UI_UPDATE_INTERVAL`), then renders. Time is wall clock (`TimeGet`, `TimeSince`).
- Lifecycle: `Start(w,h)` (`:52`), `SurfaceResized` (`:54`), `AppPause`/`AppResume` (`:55-56`), `Stop` (`:60`).

### 10.3 Exports a web host calls (`android/pascal/KM_AndroidExports.pas`, lines 37-54)

| # | Export | Purpose |
|---|---|---|
| 1 | `kam_set_callbacks(PKMHostCallbacks)` | register host callbacks |
| 2 | `kam_init(dataDir, w, h)` | start the engine, returns status |
| 3 | `kam_frame()` | one frame: ticks, UI update, render |
| 4 | `kam_resize(w, h)` | surface size |
| 5 | `kam_pause()` | app to background |
| 6 | `kam_resume()` | app to foreground |
| 7 | `kam_shutdown()` | stop |
| 8 | `kam_touch(action, pointers, x0, y0, x1, y1)` | touch input (Single coords) |
| 9 | `kam_mouse(action, button, x, y)` | mouse |
| 10 | `kam_wheel(steps, x, y)` | wheel |
| 11 | `kam_key(action, vk, shift)` | keyboard |
| 12 | `kam_char(unicode)` | text input |
| 13 | `kam_back()` | Esc / back |
| 14 | `kam_text_input_active()` | query: soft keyboard wanted |
| 15 | `kam_video_finished()` | video ended (host -> engine) |
| 16 | `kam_in_game()` | query |
| 17 | `kam_text_input_bottom()` | query: layout |
| 18 | `kam_text_field_tapped()` | query |

**Host callbacks the engine calls** (`TKMHostCallbacks`, lines 15-23): `ShowMessage(title, text)`, `ClipboardSet(text)`, `ClipboardGet(): PAnsiChar`, `OpenURL(url)`, `Quit()`, `PlayVideo(path, volume, stretch)`, `StopVideo()`. That is **7 callbacks**.

Touch gestures are translated in Pascal (`kam_touch`, 658-822: tap = left click, long press = right click, pinch = zoom), so a web host sends raw touch or mouse events and does not need gesture logic.

## 11. Size summary and ranked risks (item 10)

### 11.1 Glue to write for a web host (estimates)

| Component | JS/TS lines (est.) | Android counterpart (B, measured) |
|---|---|---|
| WebGL2 fixed-function layer (79 names) | 1,300-1,850 | gl4es (external C project), `KaMView.java` 294, `OpenGLContext.pas` 6 |
| Audio (BASS-compatible 12 calls, OpenAL/ALC/ALUT 21, streams, MP2 decoder hook) | 500-800 | `bass_android.c` 564, `KM_Sound` (engine side) |
| File system (WASI-like fd table over OPFS sync handles, in-memory fallback, import of the 515.7 MB set) | 400-600 | `DataInstaller.java` 59 (`push_data.sh` is a shell script, not counted) |
| Input (kam_* API, key map, touch/mouse/wheel/char) | 300-450 | `KeyMap.java` 62, `KaMView.java` 294, `KaMActivity.java` 267 |
| Network (WebSocket adapter behind an LNet-like interface; websockify on the server side) | 400-600 | LNet is the Android transport (no port) |
| Loop, timing, host callbacks, video (HTML `<video>`) | 200-300 | `kamhost.c` 255, `VideoOverlay.java` 82 |
| Worker/canvas/bootstrap | 150-250 | `KaMActivity.java` (part) |
| **Total JS/TS (est.)** | **~3,250-4,950** | |
| Pascal side: dglOpenGL replacement (150-250), platform shims (reuse 917 lines), synchronous thread seam (100-150), PascalScript bridge stub or generated dispatch (1,000-1,500 generated) | ~1,300-2,000 (new Pascal) | `KM_MainAndroid.inc` 370, `KM_AndroidExports.pas` 839, `kamcore.lpr` 387, shims 917, `pascalscript-aarch64.patch` 889 added lines |
| **Measured Android glue (for comparison)** | | **4,156 lines** (listed files) / **5,419 lines** (all android text files) |

The brief's figure of 8,500 lines is not reproduced by any count here. The count depends on which files are included (the patch file, gradle, and the data scripts). The table above lists exactly what was counted.

### 11.2 Ranked risks

| # | Risk | Severity | Evidence | Mitigation |
|---|---|---|---|---|
| 1 | **No PascalScript bridge for wasm32**; campaigns and scripted maps are blocked (683 scripts, 494 methods) | High | `uPSRuntime.pas:10185-10186` `{$fatal}`; no non-asm fallback; patch needed `aarch64.inc` | ship skirmish first (events guarded, AI needs no script); then generated dispatch |
| 2 | **FPC wasm32 toolchain maturity** unknown (WASI target mentioned by the FPC wiki) | High | websearch; FPC 3.2.2 is the Android compiler | prove a hello-world and the `Frame` loop on FPC wasm32 before any other work |
| 3 | **`Extended` in the RNG and saves/replays** | High (sim parity) | `KM_CommonUtils.pas:81,1425-1450`; `KM_CommonClasses.pas:1621`; README:79-80 | run the 6-replay CRC parity on the wasm build; keep one RNG path and test `Trunc((seed/M)*aMax)` on boundary cases |
| 4 | **Memory and I/O**: 515.7 MB data, wasm32 4 GiB, synchronous reads | High | `hc/install.txt`; `KM_ResSprites.pas:2035-2041` | OPFS sync handles in a Worker; measure engine RSS on a headless run (UNVERIFIED) |
| 5 | **GL fidelity**: alpha test and stencil in construction (`KM_RenderPool.pas:1262-1331`), clip planes (`KM_RenderUI.pas:93-109`), line widths (`KM_RenderPool.pas:274`) | Medium | sections 2.2-2.3 | shader uniforms for alpha and clip; scissor for axis clips; quads for lines and points |
| 6 | **Multiplayer transport**: LNet TCP/UDP, no UDP in browsers, secure auth missing | Medium | `KM_ServerSettings.pas:150-151`, `KM_Defaults.pas:410-411`, `KM_NetAuthSecure` absent | websockify bridge to the real server (TCP only); manual or HTTP server list; test the official server's auth (UNVERIFIED) |
| 7 | **MP2 music** (44 files, 159.6 MB) is not decodable by WebAudio (UNVERIFIED) | Medium | `hc/install.txt` extension table | minimp3-based wasm decoder (the Android port already uses minimp3) |
| 8 | **Revision drift**: A (r15472) has an empty PascalScript submodule, B (r16398) has it; the Android port is based on r16397 | Medium | `_ref` submodule dir has 0 files; B has `KM_MainAndroid.inc` and 110 extra src files | choose the base revision explicitly; r16398 is the only tree that builds the bridge |
| 9 | **Transcendental math in sim** (ArcTan/ArcTan2 in 7 `KM_Points` uses) | Low-Medium | `hc/misc-*.txt` | confirm which are sim-reached; replace with table or integer-safe versions where needed |
| 10 | **Threads**: none on wasm32 | Low | section 5 | synchronous seam at `KM_WorkerThread.pas:192-245` |

## 12. Open questions and UNVERIFIED items

| # | Item | How to settle it |
|---|---|---|
| U1 | Engine RAM use on a full map | headless run of the engine with a memory counter |
| U2 | Whether FPC 3.2.2 (or trunk) produces wasm32 for this code | hello-world plus the `KM_Render` unit |
| U3 | Whether `Delphi6UP` is defined for FPC (decides `{$fatal}` vs `x86.inc` at `uPSRuntime.pas:10176-10189`) | compile the submodule for wasm32 and read the error |
| U4 | `SizeOf(Extended)` on aarch64 FPC and on wasm32 | `writeln(SizeOf(Extended))` on each target |
| U5 | Whether `decodeAudioData` decodes MP2 in target browsers | test in the target browsers |
| U6 | Whether gl4es builds for Emscripten/WebGL2 | build test |
| U7 | Protocol revision value (`KM_NetProtocolRevision.inc`) and whether the official server requires secure auth | read the file; connect with the bridge |
| U8 | Whether `rm3D` (and so `gluPerspective`) is reachable in the shipped build (`KM_RenderPool.pas:255`) | trace callers |
| U9 | Whether the 7 `KM_Points` trig calls are sim-reached | call-graph check |
| U10 | Call-site count of `Sleep(10000)` at `KM_Game.pas:2376` | read the context |
| U11 | Exact share of `Single`-vs-`Extended` in the RNG path (the RNG returns `Extended` even though Single is used for positions) | instrument `KaMRandom` in a debug build |
| U12 | Whether the `.lpi` (stale in A) or `.dpr` is what the Android build used for module order | compare the two unit lists |

## 13. Reproduction

Scripts in `C:\Users\me\AppData\Local\Temp\opencode\hc\`:

- `closure.mjs`: env `KROOT`, `ENTRY`, `DEFS`, `TAG`, `ANDROIDPATH=1` (shims first). A: `TAG=ref15472 DEFS=FPC,UNIX`. B: `KROOT=<android-ref> ANDROIDPATH=1 TAG=android16398 ENTRY=android/pascal/kamcore.lpr DEFS=FPC,UNIX,ANDROID,ANDROID_PORT,DBG_SKIP_SECURE_AUTH,NO_MULTIPLAYER_UI`.
- `gl2.mjs` (env `CL`, `KROOT`), `audio.mjs` (env `CFILE`, `KROOT`), `misc.mjs` (env `CFILE`, `KROOT`), `install.mjs` (install sizes).
- The Android files were read from the local clone `_fpc/android-ref`; the GitHub raw URLs were not needed after the lead's note.
