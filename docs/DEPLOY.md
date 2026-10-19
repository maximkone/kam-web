# DEPLOY — play kam-web, on this PC, on the LAN, and (later) on a site

Status, 2026-10-19. Three ways to play, in the order they are ready. Read 4 before promising anyone a
public link: the art and the maps come from a KaM install and are never part of this repo.

## 1. On this PC

```powershell
cd C:\empire\games\kam-web
node apps/web/serve.ts --port 8290          # the game:  http://127.0.0.1:8290/game.html
node apps/server/relay.ts --port 8130       # multiplayer relay (only needed for rooms)
```

`Start skirmish` is a complete single-player game (the Remake's Advanced AI). The multiplayer panel talks
to the relay in its `Relay` field, which fills itself: a page on this PC points at `ws://127.0.0.1:8130`.

## 2. On the LAN — other people's PCs and phones in the same network

Both processes must listen on the network, not just loopback:

```powershell
cd C:\empire\games\kam-web
npm run relay:lan        # node apps/server/relay.ts --port 8130 --lan   (prints ws://<this machine>:8130)
npm run serve:lan        # node apps/web/serve.ts  --port 8290 --lan     (prints http://<this machine>:8290/game.html)
```

Give the others the `http://<this machine>:8290/game.html` address that `serve:lan` prints (e.g.
`http://192.168.43.208:8290/game.html`). Their page fills its relay field with `ws://<this machine>:8130`
by itself (`defaultRelayUrl` in `apps/web/game/lobby.ts`, tested in `apps/web/game/lobby.test.ts`), so
nobody types an address: one player clicks **Host game**, the others click **Relay rooms** → **Join**.
Four players per room, and empty slots can be set to **AI** by the host.

### If they cannot connect: Windows Firewall

Windows blocks inbound connections unless a rule allows them (this PC has no rule for 8290/8130). Run this
once **in an elevated PowerShell** (Administrator):

```powershell
netsh advfirewall firewall add rule name="kam-web LAN" dir=in action=allow protocol=TCP localport=8290,8130 profile=private,domain
```

Notes:
- `profile=private,domain` covers a work or home network. On a **hotspot or a network Windows classifies as
  Public** add `,public` to the profile — that also opens the ports to every device on that network, so only
  do it on a network you trust. `Get-NetConnectionProfile` shows the current category.
- To undo: `netsh advfirewall firewall delete rule name="kam-web LAN"`.
- The address must be reachable both ways: some office and guest Wi-Fi networks isolate clients from each
  other ("AP isolation"); nothing on our side fixes that, a phone hotspot or a normal home router does.

## 3. Over the internet without a server of our own (a tunnel)

If the host machine is online and the others are not on the same network, a free quick tunnel gives a public
https address served from this PC (the assets stay on this disk, nothing is uploaded):

```powershell
cloudflared tunnel --url http://127.0.0.1:8290      # prints https://<random>.trycloudflare.com
cloudflared tunnel --url http://127.0.0.1:8130      # a second tunnel for the relay (wss)
```

Then the page's `Relay` field must be set by hand to `wss://<the relay tunnel's host>` (a page loaded over
https may not open `ws://`). The address changes on every restart, the PC must stay on, and every player's
traffic goes through this machine. Fine for a game night; not a site.

## 4. A public site (GitHub Pages and a relay host) — not built yet

What the code already allows and what is missing:

- **Client on GitHub Pages** (free, https, custom domain): needs a static build. Today the JS is compiled
  per request by `apps/web/serve.ts`, so a build step must emit the same `out/web` graph plus the HTML/CSS
  to a publishable folder, with no server routes.
- **Art, maps, defines**: these are the KaM install's (`out/atlas` is rendered from `Sprites/*.rxx`), so they
  cannot be published. A public page must ask the player for their own `KaM Remake` folder once
  (`showDirectoryPicker`), read `data/defines`, `Maps`, `MapsMP` and the sprite packs from it, build the
  atlases in a Web Worker (the decoders in `packages/assets/{rxx,atlas,png}.ts` are already browser-safe;
  `tools/import/cli.ts` is the Node-only glue) and keep the result in IndexedDB. This is the big piece.
- **Relay**: GitHub Pages cannot run a WebSocket server. A free Node host (Render free web service, Fly.io,
  Koyeb) runs `apps/server/relay.ts` as it is; its `wss://` address becomes `RELAY_PUBLIC` in
  `apps/web/game/lobby.ts`, which is what an https page uses (`wss://`, never `ws://`).
- **Licence**: this repo is AGPL-3.0; a public deployment must offer its source, and must not ship KaM data.

## 5. Known limits of a room (say this before a game night)

- A player who drops is **out**: there is no rejoin and no spectator mode yet (`docs/M6-SPIKE.md` §12).
- The relay keeps rooms in memory: restarting it ends every match.
- An `ai` slot plays with the setup screen's default start (`MP_AI_START = 'normal'`); the room has no
  fields for AI start or peacetime, they are fixed values both clients agree on.
- The map and the defines are hashed in the lobby (`mapSha`, `definesSha`); a player whose KaM install
  differs is refused at join instead of desyncing, so everyone should use the same Remake version.
