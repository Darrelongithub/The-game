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

# the real thing (needs apps/server running on :3001)
npm run dev                                 # transport defaults to "socket"

npm run build                               # emits ./out (static export)
```

`NEXT_PUBLIC_TRANSPORT` — `socket` (default, shipped build) or `mock`.
Dev binds `0.0.0.0:5173` so phones on the LAN and the Arena preview proxy can
reach it. Development requests to `/socket.io/` are proxied server-side to
`http://127.0.0.1:3001`; set `DEV_GAME_SERVER_URL` on the Next process to
change that backend. Browsers always connect to their current origin. Production
continues to export static files served by the game server.

## Tests

```bash
npm run typecheck     # tsc --noEmit (strict)
npm run test:ssr      # server-render smoke checks over every screen
npm run test:regressions # DOM, reconnect and lost-ack regressions
npm run test:transport # additional local socket lifecycle regression
npm run test:components # full component/jsdom harness
npm run test:mock     # the full scripted night, headless
npm run test:live     # optional: same-contract smoke against a running server
                      # (run `npm run host` at the repo root first)
# After npm run build at the repository root; provide a Chromium executable:
CHROMIUM_PATH=/path/to/chromium npm run test:browser
```

`test:mock` drives `MockTransport` end-to-end and asserts: all eleven round
kinds, a passed dare **with** a verbatim reason, `pair_dare` + two `debrief`
rounds carrying `onlyPlayers` (one spectated), an interlude with a digest
teaser, a reveal with items, a broadcast-safe finale (slides + summary only),
a 3-card private deck in spark → onesided → stat order, stale-submit and
self-pick rejection, reload-resume from snapshot, and `delete_room` wiping
both the session and the snapshot.

The component and behavioral tests use `jsdom` as a development-only
dependency; it is not included in the production client.

## What lives where

| Path | Owns |
|---|---|
| `src/app/layout.tsx` | fonts (self-hosted Clash Display + Inter), `AmbientBackground` mount |
| `src/app/globals.css` | design tokens verbatim, `--red-alert`, heat vars, mobile blur variants, `prefers-reduced-motion` |
| `src/app/page.tsx` | intro gate (once per session), lazy-loads the room app |
| `src/components/RoomApp.tsx` | Join / Lobby / Play router and reconnect overlay |
| `src/lib/transport.ts` | `Transport` interface + factory behind `NEXT_PUBLIC_TRANSPORT` |
| `src/lib/socketTransport.ts` | socket.io v4: polling-first, auto-reconnect, visibilitychange re-join, stale-seq drop |
| `src/lib/mockTransport.ts` | scripted 4-player night, snapshotted to sessionStorage |
| `src/lib/useRoom.ts` | `RoomView`, your `PlayerId`, senders, reconnect state, private `secrets` deck |
| `src/lib/session.ts` | `you` / `secret` / `code` in sessionStorage + the `intro-done` flag |
| `src/components/JoinScreen.tsx` | create/join and alias; sends required age/terms flags and offers a private-card opt-out under Privacy options |
| `src/components/LobbyScreen.tsx` | room code, connection dots, host controls (start ≥4 incl. bots, add bot, custom prompts, delete) |
| `src/components/ConnectionLostOverlay.tsx` | auto-retry + manual retry |
| `src/components/play/*` | phase router + placeholder beat screens |

## Merged wiring (Agent Z: read this)

Agent A's placeholders were **removed** once the owning agents' real screens
landed; `src/components/play/PlayScreen.tsx` now routes to them:

| Beat | Rendered by |
|---|---|
| intro | `components/OpeningSequence.tsx` (B2) — gated once per session by Agent A (`intro-done`) |
| round | `screens/PromptScreen.tsx` — all 11 kinds + `onlyPlayers` spectator |
| interlude | `screens/InterludeScreen.tsx` |
| reveal | `screens/RevealScreen.tsx` |
| finale | `components/FinaleScreen.tsx` (B2) — broadcast-safe slides, GroupAnnouncement, ShareCard, press-and-hold secret deck |
| secrets | passed to `FinaleScreen` as `deck` — **only** from the per-socket `secrets` event |

Agent A keeps: the transport seam, `useRoom`, the phase order, session/resume,
and the guarantee that the private deck is never rendered publicly.
`screens/WaitingScreen.tsx` is available but unused — `PromptScreen` already
renders its own waiting/spectator states.

For shipped rating and closeness prompts, the client matches the original bank
template and measures to preselect the intended trait and person, including
aliases with special characters. For other wording it uses conservative text
inference, leaving unclear choices explicit rather than inventing a target. A
structured `RoundView` would be more reliable for all providers; see
`NOTES/contract-requests.md`.

`src/components/__tests__/` contains the standalone jsdom and local Socket.IO
regressions. They run with the test scripts above and are excluded from the
production app's `tsconfig` project.

## Deliberate deviations (documented, not accidental)

1. **Inter is self-hosted** (`public/fonts/Inter-Variable.woff2`) instead of
   `next/font/google`. Same typeface, but `next/font/google` fetches at BUILD
   time, which would break spec §13 ("zero internet after `npm install`").
   Fallback chain `Inter → system-ui` kept (ui-system-FIXES #6).
2. **Clash Display is committed** to `public/fonts/` (variable woff2, wght
   200–700) — required by FIXES #6; the build fails without it.
3. `PromptScreen` uses best-effort trait and named-player defaults while
   keeping those controls editable. `RoundView` lacks authoritative rating
   trait and rating/IOS target metadata; this remains a contract request.
