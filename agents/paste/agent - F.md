You are Agent F — SERVER. Read `agents/parts/preamble.md` first and follow it exactly. Then read `spec/spec.md` §1, 2, 3, 6, 7, 8, 9, 13 and all of `packages/shared/src/contracts.ts`.

## Your scope: `apps/server/`

1. Node + TypeScript + Express + socket.io v4. Env via `process.env` —
   `HOST` (default `0.0.0.0` — never localhost-only; phones on the LAN must
   reach it), `PORT` (3001), `XAI_API_KEY`/`GEMINI_API_KEY` optional. The
   root `host.mjs` loads `.env` for you; when started directly use
   `node --env-file=.env`. Serves the exported web app (`apps/web/out/`)
   statically from the SAME origin with an SPA fallback.
   **Boot banner (required):** log the local URL and EVERY LAN IPv4 URL
   (`os.networkInterfaces()`, e.g. `http://192.168.1.42:3001`), plus a
   scannable QR code of the primary LAN URL using `qrcode-terminal` — this
   dependency is explicitly authorized here (the only new dep allowed without
   a request note). Game night = friends point their phone camera at the
   terminal and they're in.
2. **Room manager**: `create` (code from alphabet, collision-checked),
   `join` (validate: room code, alias, 18+ consent, 4–11 cap; use
   `packages/shared/validate`), `resume` via session secret (regenerate each
   join), idle TTL 24h. `add_bot`: a server-side bot player (alias "🤖 Bot N")
   that answers every round kind with plausible delays (600–3500ms): random
   valid pick, canned texts, 5–8 self-ratings, random peer ratings, random
   ios, random minigame score, dares → done.
3. **State machine** per spec §2: phase gates (advance when every required
   player submitted, or timer + `GRACE_MS`, or host `skip_round`), heat-down
   majority vote (one level max, never up), interludes between phases (with a
   `buildNightDigest` teaser on `interlude.teaser`), `custom_prompts` (host,
   lobby only, ≤10 lines ≤160 chars, optional phase prefix — tonight's bank
   only). Rounds: prompts via `PromptProvider` (bank-first; pre-generate with
   the provider in the background during lobby — never blocking), substitute
   `{P1}` with a random alias for display ONLY, timers from `ROUND_TIMERS_MS`.
   `pair_dare` picks two players (the pair with fewest interactions so far) →
   creates two `debrief` rounds with `onlyPlayers` = the pair.
4. **Reveal** after each round: build `RevealView` (summary + items — text
   answers, shout majority word, dare outcomes with reasons, minigame
   leaderboard) and hold `REVEAL_HOLD_MS`.
5. **Finale**: `computeSignals` → `computeResults` → `buildNightDigest` →
   `buildSecrets` → narrator `buildSkeleton` + `writeFinale` → string-replace
   "Player N" → alias → emit the `finale` event to every socket
   (BROADCAST-SAFE: public slides only) — then, per socket that has a deck,
   emit `secrets` to that ONE socket. One socket, one deck. NEVER broadcast,
   never logged for other clients, never included in the room's persisted
   JSONL (decks live in memory only, purged with the room).
6. **Reconnect**: re-join replies with full `RoomView` snapshot + current seq
   (and re-emits that player's `secrets` deck if the finale already ran).
   `submit` idempotent via `clientUuid`; `dare_pass` requires a reason;
   `delete_room` (ANY player) → hard delete + `deleted` broadcast.
7. **Persistence**: in-memory + append-only JSONL per room in `data/`.
   Hourly purge of rooms older than `RETENTION_HOURS` (files included).
8. Every accepted response appends a `LogRecord` (with `coding` from the
   prompt and `latencyMs`).

## Acceptance
- `tsc --noEmit` clean; starts with no keys and serves the web app (or a
  placeholder `out/` note if the web build isn't merged yet — you still run).
- Boot banner prints at least one non-localhost URL reachable from another
  device on the same network.
- Manual socket test (or G's bots once merged): a 5-player scripted game
  reaches the finale; `finale` is identical on every socket; `secrets` frames
  land on exactly the owning sockets.

## Report
Files created, how to run, known gaps, contract requests.
