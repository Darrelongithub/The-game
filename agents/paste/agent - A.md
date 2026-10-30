You are Agent A — WEB SHELL & FOUNDATION. Read `agents/parts/preamble.md` first and follow it exactly. Then read `spec/spec.md` §1, 2, 7, 8, 10, 11 and all of `packages/shared/src/contracts.ts` and `reference/ui-system.md` + FIXES.

## Your scope: `apps/web/`

1. **Scaffold** Next.js (App Router, TypeScript, src dir) in `apps/web` with
   `output: "export"` in next.config. **Install Tailwind v3 explicitly**
   (`tailwindcss@3 postcss autoprefixer`) — create-next-app defaults to v4,
   which breaks the UI system. Deps: `framer-motion canvas-confetti clsx socket.io-client`.
2. **UI foundation, verbatim from ui-system.md + FIXES**: `app/layout.tsx`
   (Clash Display via next/font/local — download the variable woff2 from
   fontshare.com into `public/fonts/`; Inter via next/font/google),
   `app/globals.css` (tokens verbatim + `--red-alert: #ff4d6d` + heat vars),
   `tailwind.config.ts` (verbatim), and mount `AmbientBackground` in the layout.
3. **Transport** `src/lib/transport.ts`: a `Transport` interface over the
   socket contract, two implementations behind `NEXT_PUBLIC_TRANSPORT`
   (default `socket` — the shipped build must talk to the real same-origin
   server; run dev with `NEXT_PUBLIC_TRANSPORT=mock` for the scripted game):
   `SocketTransport` (socket.io-client, polling-first transports, auto-reconnect,
   re-join with stored secret on `visibilitychange`, drop stale seq) and
   `MockTransport` — an in-memory scripted 4-player game through the FULL
   phase flow (at least one of each round kind, one `passed` dare with reason,
   a pair_dare + two debriefs with `onlyPlayers`, an interlude with a teaser,
   a reveal with items, a broadcast-safe finale, then a `secrets` event for
   the local player with 3 face-down cards).
4. **`src/lib/useRoom.ts`**: React hook — current `RoomView`, your `PlayerId`,
   senders (`submit`, `dare_pass`, `vote_heat_down`), reconnect state, and the
   `secrets` event surfaced as state (deck for THIS phone only).
   Persist `you`/`secret`/`code` in sessionStorage.
5. **Screens**: `JoinScreen` (create OR join; alias; consent checkboxes incl.
   18+ age gate — action disabled until all true; auto-resume if sessionStorage
   has a session), `LobbyScreen` (big room code, player list with connection
   dots, host controls: start [enabled at ≥4 total incl. bots], add bot,
   custom-prompts textarea, delete room with confirm), connection-lost overlay
   with auto-retry + manual retry.
6. **Intro gate**: show `OpeningSequence` (B2 owns the component; stub a plain
   div if not merged) ONCE per session — set a `intro-done` sessionStorage
   flag; any tap during it skips to done.

## Acceptance
- `npm run dev` → Join screen; mock path completes a full game to finale + a
  3-card secret deck, zero console errors.
- Kill the tab mid-round, reopen: mock resumes from snapshot, no blank screen.
- `tsc --noEmit` clean. Runs in desktop Chrome AND WebKit (Safari) — this is
  the "mac couldn't join" rule.

## Report
Files created, how to run, known gaps, contract requests appended (if any).
