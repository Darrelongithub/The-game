# AGENT R — ROUND 4 report

Branch: `arena/35987c29-the-game` · Commits: STEP 1 → STEP 3 + docs + smoke

The three parts of the vision, in this order of work:

1. **The engine quietly develops suspicions** — the Director (`packages/engine/src/director.ts`,
   wired in `apps/server/src/game.ts`) was already landed on this branch from the earlier
   ROUND 4 pass; it is unchanged here and re-verified (see tests below). Its contract
   (`Hypothesis`, `HYPOTHESIS_FORM_BAND`, `ROUND_MIX`, `ANTI_TELEGRAPH_MAX`, accounts/priors)
   was present and is untouched.
2. **Reveals wait for everyone** — built in this run (ready gate).
3. **The host can test the whole game alone** — built in this run (demo rooms).

Every number stays in deterministic code. Nothing in this run adds an LLM path: the
Director picks rounds, the ready gate only gates timing, and demo seats write ordinary
log records.

## STEP 1 — Contract changes (owner-approved, applied first)

`packages/shared/src/contracts.ts` (all additive; nothing else changed):

| addition | why |
|---|---|
| `REVEAL_READY_GRACE_MS = 20_000` | auto-reveal fallback so one AFK phone never stalls the night |
| `ClientToServerEvents.ready: () => void` | "I'm ready for the pending reveal" |
| `RoomView.ready?: PlayerId[]` | who has pressed ready, present **only** while a reveal is pending |
| `RoomView.demo?: boolean` | demo-room flag (real rooms keep a byte-identical snapshot) |
| six `demo_*` events | add/remove puppeted seats, auto/manual, answer-as, all-ready, speed |
| `create` payload `demo?: boolean` | a demo room has to be created somehow (`RoomView.demo` alone cannot) |
| `LogRecord.impersonatedBy?: PlayerId` | demo metadata; the engine ignores it — parity is the point |

`Hypothesis` / `AccountInfo` / the three director tunables were already in the file and are
unchanged. Notes appended to `NOTES/contract-requests.md`.

## STEP 2 — Reveals wait for everyone

Server (`apps/server/src/game.ts`):
- `finishRound` now computes the reveal payload (`buildReveal`) and hands it to
  `beginReady`: stage `ready`, `room.pendingReveal`, `room.ready`, `readyClosesAt`.
- The reveal fires when every **connected** player has pressed ready, immediately on the
  last tap — not on the timer. `REVEAL_READY_GRACE_MS` fires it anyway.
- Bots and auto-puppeted demo seats are always ready (no phone to miss the moment).
- A player who disconnects stops being waited for (re-evaluated on disconnect); a host
  `skip_round` releases a pending reveal; heat-down votes work from the ready stage too.
- `RoomView.ready` is emitted only while pending; `everyoneReady` ignores seats that left.
- Every broadcast now goes through `assertNoHypothesisLeak` (the interlude broadcast was
  the one un-guarded emit; it is guarded now).

Client:
- `Transport.ready()` on both transports; `useRoom` exposes `ready`, `awaitingReady`,
  `youAreReady`.
- New `components/ReadyScreen.tsx` (design-bible language, `dvh`, 48px targets, a short
  arming beat) — shows the phones still to look up, never a hint about the round.
- `PlayScreen` renders it whenever the snapshot carries `ready`; host skip is offered there.
- `MockTransport` mirrors the same gate so the offline mock still exercises the screen.

## STEP 3 — Demo rooms (host tests the whole game on one laptop)

Server:
- `create` with `demo: true`; `RoomView.demo`; demo rooms start with 2+ seats instead of 4.
- `demo_add_player` / `demo_remove_player` (lobby), `demo_set_bot_mode` (auto answers and
  readies itself, manual waits for the host), `demo_answer_as`, `demo_all_ready`,
  `demo_speed` (0.1–1.0, applied to timers scheduled after the change).
- Every control is refused outside a demo room (`DEMO_ONLY`) and by anyone but the host
  (`HOST_ONLY`); targets must be actual puppeted seats (`NOT_A_PUPPET`).
- `demo_answer_as` goes through the ordinary `submit` path, so validation, idempotence,
  latency, decoys and the log are identical to a real phone. The only difference is the
  `impersonatedBy` metadata that nothing reads.

Client:
- "Demo room" toggle on the Create tab; the lobby starts at 2 seats in a demo room.
- New `components/DemoPanel.tsx`: seat list with Auto/Manual, remove, add seat, per-seat
  "Answer this round for …", "Everyone's ready", night-speed slider. Shown in the lobby and
  behind a **Demo** button during play. `lib/demoAnswer.ts` builds a legal value per kind.

## Tests (all run, all passing)

```
npm run typecheck                 → 0 errors (server, web, engine, narrator, prompts)
apps/server: npx tsx --test …      → 57 tests, 57 pass, 0 fail
  new: test/ready-gate.test.ts     → 4 tests (waits, drops-out, grace, solo-host)
  new: test/demo-mode.test.ts      → 5 tests (full solo night, parity, manual/auto,
                                     demo-only/host-only, speed + all-ready)
npm run test:components           → ALL 151 CHECKS PASSED ✅
  (+12 ROUND 4 checks: ready screen ×8, demo console ×12 → 151 total)
npm run build                     → static export OK
npm run smoke:demo (real server)  → DEMO SMOKE OK — 39 round events, 21 reveals,
                                     42 pending-ready snapshots, 8 finale slides
npm run smoke (4 external bots)   → the whole night completes; finales identical across
                                     sockets; stops only at the pre-existing
                                     "SMOKE_ORACLE is required" check (no oracle file).
```

Parity is asserted twice: the engine test compares `computeSignals`, `computeResults`
claims, the digest and the secret decks with the same records, once with `impersonatedBy`
and once with it stripped — deep-equal. The demo night also asserts no internal marker
(`hypothes|suspect|coverage|priors|director|openedAt|impersonatedBy|puppet`) appears in any
emit, in any room-log line, or in the finale.

## Known gaps / notes

- `demo_speed` applies to timers scheduled after the change; a round already in flight keeps
  its closing time (changing it would steal time from players).
- Demo seats are added/removed in the lobby only (same rule as `add_bot`); modes, answers,
  all-ready and speed work at any time.
- `demo_answer_as` uses a deterministic, plausible value per round kind (the host can also
  flip the seat to auto). There is no per-seat free-text editor in the panel.
- The ready gate covers reveals (the "moment"); interludes and the finale are not gated —
  the finale is broadcast-safe and replayed on reconnect.
- The mock transport's demo mode is a one-seat approximation; the real gate and console are
  the socket paths.
- `readyGraceMs` is a test seam like the existing `roundTimers`/`graceMs`; production always
  uses `REVEAL_READY_GRACE_MS`.
