# AGENTS: kam-web

Repo rules (on top of `C:\empire\AGENTS.md`).

1. Read `docs/PLAN.md` + the newest `docs/M*-*.md` spec before working. Disk wins; pull before push.
2. **Only the lead commits.** Commit your own paths (`git add <paths>`), never `-A`, never force-push.
   A claim needs its one-line proof command result in the commit body.
3. `_ref/kam_remake` is a **read-only** reference clone of the upstream AGPL source. Never edit, never commit it.
4. Never commit assets or converter output: `out/`, `*.rxx`, anything from a KaM install stays out of git.
5. Code style: ESM TypeScript that **bare `node file.ts` runs** (Node >= 24 type stripping):
   no `enum`/`namespace`/parameter properties, relative imports include the `.ts` extension,
   zero runtime dependencies (node: builtins only) unless a spec says otherwise.
6. Never kill processes other than ones you started yourself in this repo; never touch other repos.
7. No secrets in files or logs; no paid services; free models only.
8. Proofs: every milestone doc lists its acceptance commands — run them before saying done.
