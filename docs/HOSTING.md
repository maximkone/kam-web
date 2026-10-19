# HOSTING — putting kam-web online for real, and what tournaments need

Written 2026-10-19 for Maxim. `docs/DEPLOY.md` covers playing (this PC, LAN, a tunnel); this file is about
running it as a service on your own site, with real multiplayer, a ladder and tournaments.

## 0. The one thing that cannot be hosted: the art

Our code is AGPL-3.0 and can be published anywhere. **KaM's art and its maps cannot.** They belong to ACE
TopWare (the Remake's own readme: commercial use prohibited, "we assume that you own a licensed copy of the
game KaM"), and I checked both fan "replacement sprite" collections: neither carries a licence of its own,
so they cannot be shipped either. `docs/DEPLOY.md` section 4 has the details.

What that means in practice, and it is not a dead end:

- **Your site ships our code only** (1.8 MB). Nothing else.
- **Each visitor brings their own KaM Remake data.** They already own it or they download the Remake free;
  then the page asks for their folder once and builds the atlases in their browser (already built and
  verified: `npm run localcheck` proves the browser path produces byte-identical atlases).
- So the audience is "people who own KaM" — which is exactly who a KaM tournament is for. For an audience
  with no KaM at all you need a different game with our own/CC0 art (a new, much smaller project).

## 1. The client on your site (free, no accounts beyond your host)

Three ways, pick one:

- **Keep GitHub Pages and point a subdomain at it.** Pages is live now at
  `https://maximkone.github.io/kam-web/`; add a `CNAME` in your site's DNS (`kam.yoursite.com` →
  `maximkone.github.io`) and set that domain as the custom domain in the repo's Settings → Pages. Free TLS,
  no build machine of your own.
- **Upload the exported folder to your web host** (FTP/Plesk/cPanel): `npm run export` writes `dist/`
  (71 files, 1.82 MB, `index.html` + `game.html` + `relay-config.js`). Upload its *contents* to a folder and
  open it; it is plain static files, no Node on the server.
- **Cloudflare Pages** (free, no bandwidth cap): connect the repo, build command
  `node apps/web/serve.ts --export dist`, output directory `dist`.

The exported HTML uses relative script paths, so it works at a subpath (`/kam/`) and at a subdomain alike.
`.github/workflows/pages.yml` rebuilds and republishes on every push to `master`.

## 2. Real multiplayer: the relay (free tier, ~10 minutes, needs your Render account)

1. Sign in at render.com with GitHub, then **New → Blueprint**, pick `maximkone/kam-web`. Render reads
   `render.yaml` and offers the `kam-relay` service; click **Apply**.
2. When it is live, Render shows a hostname like `kam-relay.onrender.com`. The relay speaks WebSocket at
   `wss://kam-relay.onrender.com`.
3. Put that address into the client: `npm run export -- --relay wss://kam-relay.onrender.com` (the Pages
   workflow does this too once you pass it — edit the `--export dist` line in `.github/workflows/pages.yml`).
   It lands in `relay-config.js`, which `apps/web/game/lobby.ts` reads, so every visitor's Relay field is
   filled in automatically. An https page must use `wss://`; `ws://` is blocked by the browser.
4. Free tier caveat, say it in the lobby: the service sleeps after 15 minutes idle and the first player
   waits ~1 minute. The relay keeps rooms in memory, so a restart ends running matches (a player who drops
   is out — no rejoin yet).

**2b. If you want it always awake:** Fly.io with one small always-on machine is about $2–3/month, or a
Cloudflare Worker + Durable Object is $0 but needs the relay ported (the protocol stays the same).

## 3. Tournaments and a rating (a real server, this is the next project)

The relay already sees every match: who plays, the map, the seed, the per-tick command sets and the CRC
checkpoints. What a ladder needs on top:

- **A backend with a database.** Cheapest real options: Cloudflare Workers + D1 (free tier), or Supabase
  (free Postgres + auth). Not the relay's host: Render's free disk is not persistent.
- **Accounts.** A nickname + a secret, or "sign in with GitHub" (free), so a rating belongs to someone.
- **Match reporting.** Add one message to the protocol: `game/finished` with the winner, the final tick and
  the last CRC, sent by the host and checked against what the relay saw. Only the relay may write a result
  (a shared secret between relay and backend), so nobody can report a win they did not play.
- **Elo (or Glicko) and a ladder page.** A static page on your site that reads the backend's JSON: rating,
  games, streak, last matches with times in the visitor's own timezone.
- **Tournaments.** Single/double elimination from a list of registered names: a bracket page, a deadline per
  round ("play your match before Sunday 20:00"), and the result feeding the same Elo. Swiss is more fun for
  small fields and harder to build; start with single elimination and a "best of 1, 12 minutes" rule.
- **Anti-flake.** A match only counts when both clients' final CRC agree (the relay already compares them),
  which is why this is honest by construction.

Effort, honest: accounts + ladder + single-elimination brackets + the pages ≈ 1–2 weeks of work for me,
plus one free account of yours (Cloudflare or Supabase). Nothing in it needs KaM art, so it can all be
public.

## 4. Modding (later, and cheap once the zip import exists)

The client already reads *all* game data from the player's own folder, so a "mod" is just a different set of
files: a mod pack (a zip with `data/defines` + maps + optionally sprites) that the page loads instead of the
install's. Steps when we get to it: the one-file/zip import (option 2 in the chat), a pack picker in the
setup screen, and a shared hash in the lobby (`definesSha` already refuses mismatched games) so everyone in a
room plays the same mod. Sharing *scripts and scenarios* is fine; sharing the original art inside a pack is
the same line as section 0.

## 5. What it costs

| Piece | Free option | Awake 24/7 |
|---|---|---|
| Client | GitHub Pages / Cloudflare Pages: $0 | $0 |
| Relay | Render free (15 min sleep, ~1 min cold start) | Fly.io ≈ $2–3/mo |
| Ladder + tournaments | Cloudflare Workers + D1, or Supabase: $0 | $0 on free tiers |
| Domain | your existing site's subdomain | — |

## 6. Order I would do it in

1. `--relay wss://…` in the Pages workflow → multiplayer on your site for people who own KaM. (I can do this
   the moment you have the Render hostname.)
2. Accounts + Elo ladder page.
3. Tournaments (single elimination, then Swiss).
4. Mod packs.
5. A second, asset-free game for an audience that owns no KaM at all.
