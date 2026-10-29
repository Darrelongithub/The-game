# apps/web — the web shell (Agent A)

Next.js App Router · TypeScript strict · **Tailwind v3 pinned** · `output: "export"`.
The exported site is served BY the game server (same origin, no CORS, no
localhost calls). This app owns: the design-system foundation, the transport
seam, the room hook, Join/Lobby, the connection overlay, and the phase router.

## Run it

```bash
cd apps/web
npm install

# scripted demo, no server needed — full night, no API keys, no network
NEXT_PUBLIC_TRANSPORT=mock npm run dev      # → http://localhost:5173

# the real thing (needs apps/server running on :3001 in the same origin)
npm run dev                                 # transport defaults to "socket"

npm run build                               # emits ./out (static export)
```

`NEXT_PUBLIC_TRANSPORT` — `socket` (default, shipped build) or `mock`.
Dev binds `0.0.0.0:5173` so phones on the LAN and the Arena preview proxy can
reach it; `allowedDevOrigins` in `next.config.mjs` lists the preview hosts.

## Tests

```bash
npm run typecheck     # tsc --noEmit (strict)
npm run test:ssr      # 41 server-render smoke checks over every screen
npm run test:mock     # 53 checks: the full scripted night, headless
npm run test:live     # optional: same-contract smoke against a running server
                      # (run `npm run host` at the repo root first)
```

`test:mock` drives `MockTransport` end-to-end and asserts: all nine round
kinds, a passed dare **with** a verbatim reason, `pair_dare` + two `debrief`
rounds carrying `onlyPlayers` (one spectated), an interlude with a digest
teaser, a reveal with items, a broadcast-safe finale (slides + summary only),
a 3-card private deck in spark → onesided → stat order, stale-submit and
self-pick rejection, reload-resume from snapshot, and `delete_room` wiping
both the session and the snapshot.

Both runners use `npx -y tsx` so **no extra dependency** was added.

## What lives where

| Path | Owns |
|---|---|
| `src/app/layout.tsx` | fonts (self-hosted Clash Display + Inter), `AmbientBackground` mount |
| `src/app/globals.css` | design tokens verbatim, `--red-alert`, heat vars, mobile blur variants, `prefers-reduced-motion` |
| `src/app/page.tsx` | intro gate (once per session) → Join / Lobby / Play router |
| `src/lib/transport.ts` | `Transport` interface + factory behind `NEXT_PUBLIC_TRANSPORT` |
| `src/lib/socketTransport.ts` | socket.io v4: polling-first, auto-reconnect, visibilitychange re-join, stale-seq drop |
| `src/lib/mockTransport.ts` | scripted 4-player night, snapshotted to sessionStorage |
| `src/lib/useRoom.ts` | `RoomView`, your `PlayerId`, senders, reconnect state, private `secrets` deck |
| `src/lib/session.ts` | `you` / `secret` / `code` in sessionStorage + the `intro-done` flag |
| `src/components/JoinScreen.tsx` | create/join, alias, 3 consent gates (18+ hard gate) |
| `src/components/LobbyScreen.tsx` | room code, connection dots, host controls (start ≥4 incl. bots, add bot, custom prompts, delete) |
| `src/components/ConnectionLostOverlay.tsx` | auto-retry + manual retry |
| `src/components/play/*` | phase router + placeholder beat screens |

## Merged wiring (Agent Z: read this)

Agent A's placeholders were **removed** once the owning agents' real screens
landed; `src/components/play/PlayScreen.tsx` now routes to them:

| Beat | Rendered by |
|---|---|
| intro | `components/OpeningSequence.tsx` (B2) — gated once per session by Agent A (`intro-done`) |
| round | `screens/PromptScreen.tsx` — all 9 kinds + `onlyPlayers` spectator |
| interlude | `screens/InterludeScreen.tsx` |
| reveal | `screens/RevealScreen.tsx` |
| finale | `components/FinaleScreen.tsx` (B2) — broadcast-safe slides, GroupAnnouncement, ShareCard, press-and-hold secret deck |
| secrets | passed to `FinaleScreen` as `deck` — **only** from the per-socket `secrets` event |

Agent A keeps: the transport seam, `useRoom`, the phase order, session/resume,
and the guarantee that the private deck is never rendered publicly.
`screens/WaitingScreen.tsx` is available but unused — `PromptScreen` already
renders its own waiting/spectator states.

`src/components/__tests__/` is B2's standalone jsdom harness (run with
`npx tsx`); it is excluded from this workspace's `tsconfig` typecheck because
`jsdom` is not a vendored dependency.

## Deliberate deviations (documented, not accidental)

1. **Inter is self-hosted** (`public/fonts/Inter-Variable.woff2`) instead of
   `next/font/google`. Same typeface, but `next/font/google` fetches at BUILD
   time, which would break spec §13 ("zero internet after `npm install`").
   Fallback chain `Inter → system-ui` kept (ui-system-FIXES #6).
2. **Clash Display is committed** to `public/fonts/` (variable woff2, wght
   200–700) — required by FIXES #6; the build fails without it.
3. `RoundPanel` reads an interim `trait` / `about` shim from the round because
   `RoundView` cannot yet express it — filed as a contract request.
