You are Agent G — HOST, BOTS, SMOKE TEST & DEPLOY. Read `agents/parts/preamble.md` first and follow it exactly. Then read `spec/spec.md` §1, 2, 7, 13 and `packages/shared/src/contracts.ts`.

## Your scope: root scripts, `scripts/`, deploy config, repo docs

1. **Root `package.json`** (npm workspaces: `apps/*`, `packages/*`; devDeps
   `typescript`, `tsx`). Scripts:
   - `host` → `npm run build && node host.mjs` (the game-night command —
     same convention as Adapt)
   - `start` → `node host.mjs` (no rebuild — for Render/Railway which build
     separately)
   - `build` → web build (produces `apps/web/out/`)
   - `selfcheck` → `npx -y tsx scripts/selfcheck.ts`
   - `smoke` → `npx tsx scripts/bots.ts`
   - `typecheck` → all packages
2. **`host.mjs`** (repo root) — one-command LAN hosting:
   - Read `.env` if present (tiny KEY=VALUE parser, no dotenv dep), merge
     into env (never overwrite already-set variables).
   - Sanity check: if `apps/web/out/index.html` is missing, print
     "web not built — run `npm run host`" and exit 1.
   - Spawn the server (`npx tsx apps/server/src/index.ts`) with stdio
     inherited — the server's boot banner prints the LAN URLs + QR code.
   - `NEXT_TELEMETRY_DISABLED=1` by default (nothing phones home).
   - Forward SIGINT/SIGTERM to the child, wait, exit — Ctrl+C kills the
     whole tree, no orphans.
3. **`scripts/bots.ts`** — an EXTERNAL smoke-test bot army (socket.io-client,
   runs against a live server):
   - Spawns N bot players (default 5) that create/join a room via the real
     socket contract, answer every round kind with realistic delays, and play
     to the finale.
   - Bot personalities: one joker (ALWAYS picks the same target every pick
     round — the joker-guard test), one dodger (passes one dare with a
     verbatim reason), one speed demon (submits in <1s).
   - Asserts: all phases reached; `finale` received by every socket AND
     deep-equal across sockets (broadcast-safe); `secrets` arrive ONLY on the
     owning bot's socket — every other bot must NOT receive a secrets frame;
     each deck ≤ `SECRET_DECK_MAX`; duplicate `submit` with the same
     `clientUuid` doesn't double-count; a forced disconnect + re-join resumes
     from the snapshot (and re-receives its secrets deck if post-finale);
     `delete_room` ends everything.
   - Exit 0 only if every assertion passes. Print a clean summary.
4. **Deploy kit**:
   - `.env.example` already exists at the repo root — read it, don't recreate
     it; the server must use exactly those names (`HOST`, `PORT`,
     `XAI_API_KEY`, `GEMINI_API_KEY`).
   - `Dockerfile` (node:20-slim, install → build → host) — optional but nice.
5. **`RUNBOOK.md`**: exact, copy-pasteable commands —
   - **Game night (LAN):** `npm install` once; `npm run host`; scan the QR
     in the terminal; everyone joins on the same WiFi (or the host's phone
     hotspot). With no API keys the whole night runs offline after install.
   - **Solo test:** `npm run host`, then `add_bot` ×3 from the lobby.
   - **Remote friends:** Render/Railway/Fly (`npm install`, `npm run build`,
     `npm start`). Habitual play: Vultr Johannesburg ($6/mo, best Nairobi
     latency; never Supabase realtime — no Africa region).
   - Where logs live, how to nuke a room, how to run `npm run smoke`.

## Acceptance
- `npm run host` on your machine prints a LAN URL reachable from another
  device on the same network (or a phone hotspot).
- `bots.ts` compiles (`tsc --noEmit`) and its assertions are real.
- RUNBOOK commands match the actual repo layout.

## Report
Files created, assertion list, contract requests (if any).
