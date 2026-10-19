# WORK-PC — the real KaM client on a machine that has no KaM

The goal: play the **real thing against the bots** on a PC that has no KaM install and no permission to
install anything - a locked work PC - with a plain browser. Nothing is published from your KaM folder; the
client stays public and asset-free, and the data stays yours.

## The one file

`kam-data.zip` (~32 MB) is built from your own KaM Remake install on this PC:

- `data/Sprites/{Units,Tileset,Houses,Trees,GUI,GUIMain}.rxx` - the six sprite packs the page decodes
- `data/defines/*` - tiles.json, mapelem.dat, unit.dat, houses.dat
- `Tutorials/**` - the mission the page boots into
- `Maps/**` and all **195 bot-capable `MapsMP/` skirmish maps**, `.map`/`.dat`/`.txt` only (a published
  map's `.wav`/`.pdf`/`.script` extras are 100+ MB a browser port never opens)

It sits in a **private** release on your own private repo, so fetching it needs your GitHub login - which is
the "password" - and nobody else can reach it:

    https://github.com/maximkone/empire/releases/tag/kam-data-2026-10-19

Why private and not on the site: the art is TopWare's and the Remake's readme assumes the player owns KaM.
That is exactly why the public client ships without assets and why this archive must never be published.

## On the work PC (once)

1. Log into GitHub and download **kam-data.zip** from the link above.
2. Open the client: `https://maximkone.github.io/kam-web/game.html`
   (a plain `file://` copy of the export works too, served over http).
3. Click **Use a KaM data pack (.zip)** and pick the downloaded file. The page reads it, builds the atlases
   in the browser (~40 s) and reloads itself. Nothing is uploaded anywhere.
4. Pick a skirmish map, leave the AI slot on **Advanced AI**, press Start.

That is the whole setup, and it is per browser: the pack is stored in that browser's IndexedDB, so the next
day you just open the page and play. **Forget** clears it again.

No extraction is needed - the page reads the zip directly - which matters because a locked PC may refuse
both the folder picker and installing anything. If a policy blocks even a file input, the fallback is to
carry the files on a stick and use **Use my KaM folder** with the extracted folder.

## Rebuilding or trimming the pack

    node tools/pack/cli.ts --check --maps 195      # every bot-capable map (~32 MB)
    node tools/pack/cli.ts --check --maps 40       # a smaller pack for a slow link
    node tools/pack/cli.ts --check --install "D:\KaM Remake" --out out\kam-data.zip

`--check` reads the archive back through the same reader the page uses and compares every entry with the file
it came from, so a pack that passes is a pack the browser will accept. Output goes to `out/` and is never
committed (`AGENTS.md` rule 4). Upload the new file as another private release asset when you make one.

## What is verified, and how

- `node tools/pack/cli.ts --check --maps 195` -> `PACK CHECK PASS (792 entries, 6 stored + 786 deflated,
  every file byte-identical to the install, 195/195 bot-capable skirmish maps)`, 94.29 MB of files -> 31.61 MB.
- Extract it and run the client's own asset check against the extracted tree:
  `node tools/localcheck/cli.ts --check --install <extracted>` -> `LOCAL CHECK PASS (24 files, 230 maps,
  atlases byte-identical)`. That is the proof the pack is *sufficient*: it yields the same atlases as your
  real install.
- `node tools/uicheck/b4.ts --check` -> `B4 PASS`: a real browser imports the archive through its file
  input, the page then reports running from it, lists the pack's **230** maps (the server alone has 243), reads
  a map's bytes out of the archive, decodes the sprite atlas, starts a match against the AI and renders real
  art (365 KB screenshot, no page errors).

## Other ways to play

- **This PC**: `npm run serve` -> `http://127.0.0.1:8123/game.html`, or use your KaM folder directly.
- **At home on the LAN**: `npm run relay:lan` + `npm run serve:lan` (docs/DEPLOY.md section 2).
- **Public site**: `https://maximkone.github.io/kam-web/` - the client only; with the pack imported it plays
  exactly like the local copy.
