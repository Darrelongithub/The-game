# Fix & feature report — ROUND 4: THE DIRECTOR + ACCOUNTS
(ROUND 3 report continues below.)

## ROUND 4 status: SHIPPED (contract + engine + server + accounts + tests + spec)

**Hypotheses are invisible to players BY DESIGN.** The engine develops private
suspicions about the room and quietly interrogates them; players never see a
hypothesis — no board, no event, no interlude line, no recap, and no "what the
game suspected" beat at the finale. The only player-visible effect is that
rounds keep feeling fresh, relevant and slightly uncanny. Hypotheses exist to
steer selection; the only place one can ever surface is as an ORDINARY finale
claim it graduated into.

### 1. Contract (approved edits, `packages/shared/src/contracts.ts`)
- `Hypothesis` / `HypothesisKind` / `HypothesisStatus`, marked INTERNAL
  ("never serialized to any client"), with the fields exactly as approved.
- `AccountInfo { username, createdAt, nightsPlayed }` (no email field, by design).
- Tunables: `HYPOTHESIS_FORM_BAND = { lo: 0.35, hi: 0.65 }`,
  `ROUND_MIX = { test: 0.5, explore: 0.3, classic: 0.2 }`,
  `ANTI_TELEGRAPH_MAX = 2`.
- Regression test `packages/engine/test/contracts.test.ts`: band is a real
  mid-band, the mix sums to exactly 1, the cap stays 2..4, no email-shaped field
  exists anywhere in the source, and no `Hypothesis` rides `ServerToClientEvents`.

### 2. Accounts — username + PIN + one-time recovery code (no email, ever)
- `apps/server/src/accounts.ts`: `AccountStore` (scrypt PIN/recovery hashes,
  hashed token seeds, case-insensitive unique usernames, failed-login lockout,
  nights-played bookkeeping, per-account priors, hard wipe). Stored at
  `apps/server/data/accounts.json` (0600), so identity survives the 48h room
  purge while night data does not.
- `apps/server/src/account-routes.ts`: `POST /api/account` (returns the code
  ONCE — "store it, there is no email"), `/login`, `/recover` (rotates the code),
  `/night` (binds tonight's room using the player's own session secret),
  `GET /api/account`, `DELETE /api/account` (hard wipe). Unknown fields are
  refused, Bearer tokens only, same-origin only, mounted before the SPA
  catch-all. Accounts ride REST, so guest play is untouched and fully available.
- `apps/web/src/lib/account.ts`: client helpers (localStorage token, alias
  suggestion, attach-night, wipe). **Known gap:** the login UI itself is not
  wired into `JoinScreen` in this round (no screen files were touched, to keep
  the frozen UI system intact) — the helpers are ready for it.

### 3. The Director (`packages/engine/src/director.ts`, pure + deterministic)
- `formHypotheses(signals, log, meta, priors?)` / `updateHypotheses(...)`: six
  kinds (`tension`, `besties`, `secret`, `selfimage`, `onesided`, `freeagent`),
  MID-BAND only; above band with ≥3 independent signals it GRADUATES into an
  ordinary claim and leaves the set; a contradicted suspicion is REFUTED; below
  band is noise. Evidence is engine-written and pseudonymous, `openedAt` comes
  from the log (or a previous night).
- `directNextRound(hypotheses, coverage, candidates, seed)` / `planRound(...)`:
  the 50/30/20 mix over a **(pair × dimension)** coverage matrix, seeded by the
  round index, with `ANTI_TELEGRAPH_MAX` and graceful lane fallthrough.
- **One-sided rule (unchanged, hard):** one-sided material can only graduate to
  a PRIVATE claim → a finale Secret Card on the picker's phone.
- **Cross-night, invisible:** unresolved suspicions ride into the next night as
  priors (accounts only, mapped back onto tonight's pseudonymous ids). Nobody is
  told; guests carry nothing.
- `assertNoHypothesisLeak(payload)`: the invisibility seam.

### 4. Server
- Rounds are dealt ONE AT A TIME (`planNext` → `planRound`), so every round is
  chosen from the freshest suspicions; the probed subjects bind into the
  prompt's `{P1}`/`{P2}` slots; host custom prompts keep priority.
- `refreshHypotheses()` runs after every round; graduated claims merge into the
  finale's results as ordinary claims (subject to every existing filter).
- `loadPriors()` / `savePriors()` around the night; `audit.directed` is an
  in-process TEST observer only (never configured by the production entry point).
- Every client-facing emit passes the leak guard, so a future edit that ships a
  hypothesis fails loudly instead of quietly.

### 5. What players see
Nothing new. No `case_board` event, no interlude line, no recap, no "case
closed" block. Freshness surfaces only through the selector's choices, the
digest teasers and callbacks, and the finale's ordinary claims.

### 6. Tests (all green; each was written to fail before the feature landed)
- `packages/engine/test/contracts.test.ts` (6): contract/tunable invariants,
  no-email scan, no hypothesis on the wire.
- `packages/engine/test/director.test.ts` (14): lifecycle open → strengthen →
  graduate/refute, mid-band-only noise, one-sided privacy, mix split 50/30/20,
  test-mix targets open-hypothesis subjects, explore only fills starved cells, a
  12-round night, ≤2 consecutive rounds per pair, carry-over priors keep
  `openedAt`, determinism twice, pseudonymity of hypothesis text.
- `apps/server/test/accounts.test.ts` (8): create/login/recover/delete-wipe,
  case-insensitive uniqueness, recovery-code rotation and replay rejection,
  unknown-field (no-email) refusal, PIN lockout, purge survival, guest parity.
- `apps/server/test/director.test.ts` (6): invisibility across every emit,
  snapshot and room-log line; one-sided gives NO public claim and only the
  picker's finale card; anti-telegraph across a whole night; graduation appears
  as an ordinary public claim in the finale; carried suspicions keep probing
  (selection patterns only); identical nights select identical rounds.

```
packages/engine:  35/35 tests, tsc --noEmit clean
apps/server:      35/35 tests, tsc --noEmit clean
scripts/selfcheck.ts: ALL 36 CHECKS PASSED (incl. the 4 new ROUND 4 tunable checks)
```

### Known gaps / notes
- Login/signup SCREENS are not built (helpers + REST are); see §2.
- `savePriors` only carries suspicions whose subjects both hold accounts — a
  guest subject dies with the night, by design.
- Hypotheses live in memory and in the per-account prior file only; they are
  never written to a room log (asserted in the invisibility test).

---

# Fix & feature report — ROUND 3: LIVE GROUP MOMENTS

Two new round kinds — **spotlight** ("everyone look at X") and **verdict**
("discuss it, then decide") — added to the working game. They are not more
questions: they are MOMENTS that put the room's eyes on one person, or make
everyone argue.

---

## ROUND 3 status: SHIPPED (contract + server + engine + UI + tests)

### 1. Contract (approved edits, `packages/shared/src/contracts.ts`)

| Change | Why |
|---|---|
| `RoundKind` += `"spotlight" \| "verdict"` | the two new round kinds |
| `ROUND_TIMERS_MS.spotlight = 25_000`, `ROUND_TIMERS_MS.verdict = 105_000` (`VERDICT_DISCUSS_MS` 90s + `VERDICT_VOTE_MS` 15s) | spec timers, tunables in the contract per §14 |
| `RoundView.voteOpensAt?: number` | verdict: open discussion until then, then the secret simultaneous pick |
| `RoundView.expectsAnswer?: boolean` | the spotlight subject's idle cover screen offers no input |
| `LogRecord.decoy?: boolean` | the subject's cover answer — excluded from every signal/score/claim |
| `SPOTLIGHT_ANSWER_MAX = 80`, `SPOTLIGHT_REVEAL_MS = 8_000`, `VERDICT_REVEAL_MS = 6_000` | new tunables |
| `RevealView` += `kind? / subject? / punchline? / slide? / celebrate?` | the caption wall (header + punchline) and the verdict Group Announcement payload; filed in `NOTES/contract-requests.md` as `AGENT-R` |

`RevealView` is the one area that needed more than the brief listed: `RevealItem
{alias, text}` cannot carry a subject header, a punchline, or vote counts, and
nothing identified a reveal as a live moment. All five fields are optional and
additive; nothing else in the contract changed.

### 2. Bank — `packages/prompts/src/bank/live/`

- `spotlight.json` — 10 seeds (the 8 from the brief + phase variants), `{S}` =
  subject alias, name-cluster and caption rows, the spicy one behind `SPICY_TIER`.
- `verdict.json` — 9 seeds; couple-coded ones marked `couple: true` for confetti.
- `decoys.json` — the cover pool ("What did you eat today?", …).
- `index.ts` — `liveSeeds()`, `livePrompt()`, `liveKindInPhase()`,
  `SPOTLIGHT_IDLE_LINE`, `DECOYS`. **Kept out of `loadBank()`**: live moments are
  scheduled by the server's planner, never mixed into the per-phase question pool.
- `packages/prompts/test/live.test.ts` — 8 new checks (shapes, `{S}`, spicy
  gating, no repeats, decoys give nothing away).

### 3. Server (`apps/server/src/game.ts`)

- **Spotlight rotation** — each player at most once a night, never back-to-back
  (`room.spotlighted`, `room.lastSubject`); marked only when the moment actually
  starts, so a heat-down or host skip never burns a player's turn.
- **The cover round** — `roundView()` is the single place a round is rendered, so
  it is the single place the secret is kept. The subject gets a decoy question or
  the idle line, re-drawn every spotlight; the real prompt never rides `round`,
  `state`, `reveal` or any other emit to that socket.
- **Verdict** — `voteOpensAt = start + 90s`; submits before it are refused with
  "Phones down. Argue it out first."; the pick grid is self-excluded.
- **Reveals** — caption wall (`subject`, `items`, `punchline` = the subject's own
  decoy answer, 8s) and Group Announcement slide (`numbers: {votes, of, share}`,
  `celebrate` only for couple-coded verdicts, 6s). Neither reveal contains the
  question.
- **Decoys never score** — flagged `decoy: true` on the record; the finale
  filters them out of `computeSignals`/`computeResults`; the engine filters again
  defensively (see below).
- **Bots** — spotlight: short text; verdict: wait for `voteOpensAt`, then a valid
  pick (in-server bots and `scripts/bots.ts`).

### 4. Engine (`packages/engine/src/live.ts` + digest/signals/results)

- `detectNamedPlayers` / `clusterNames` — conservative same-name detection: full
  alias, distinctive alias token (≥4 chars, not a common word), `Player N`,
  ≥4-char nickname prefix. Ambiguous captions naming two players count for
  neither; 2–3 character tokens never count alone.
- `nameClusterTeaser` — fires only on ≥3 matching answers **and** a strict
  majority, so 2 of 7 stays silent. It is a **digest teaser, never a Claim**.
- `decoyPairings` / `decoyQuote` — *"While the room captioned X, X wrote: '…'"*
  leads the digest quotes.
- `computeSignals` / `computeResults` filter `decoy === true` themselves, so a
  caller that forgets cannot score a decoy.

### 5. UI (`apps/web`)

- `components/CaptionWall.tsx` — new: subject header, captions stack, punchline
  lands last and biggest; `clamp()` type (320px → tablet), staggered
  framer-motion, fully still under `prefers-reduced-motion`.
- `screens/RevealScreen.tsx` — routes `spotlight` → CaptionWall, `verdict` →
  `<GroupAnnouncement celebrate={…}>`, everything else unchanged.
- `screens/PromptScreen.tsx` — spotlight captions use the ordinary short-text
  surface (≤80); `expectsAnswer === false` renders the idle cover; verdict shows
  "PHONES DOWN. ARGUE IT OUT." + countdown, then the secret pick grid.
- `components/GroupAnnouncement.tsx` — `celebrate?: boolean` (default true) so
  non-couple verdicts land with haptics but no confetti.
- `lib/mockTransport.ts` — the scripted demo night now includes a spotlight
  (subject: a bot, punchline included) and a verdict (6s debate → pick → land).

---

## Tests (each was written to fail before the change)

| Check | Command | Result |
|---|---|---|
| Contract/timers selfcheck (11 kinds) | `npm run selfcheck` | **ALL 32 CHECKS PASSED** |
| Server suite incl. live moments | `npm test --workspace apps/server` | **22 pass / 0 fail** (16 before + 6 new) |
| Engine suite | `npx tsx --test packages/engine/test/engine.test.ts` | **15 pass / 0 fail** |
| Bank + live bank | `npx tsx --test packages/prompts/test/*.test.ts` | **102 pass / 0 fail** (incl. the 8 live-bank tests from STEP 1) |
| Component (jsdom) suite | `npm run test:components` | **ALL 127 CHECKS PASSED** (102 before + 25 new) |
| Mock transport flow | `npm run test:mock --workspace apps/web` | **ALL 56 CHECKS PASSED** (54 before) |
| Typecheck (all workspaces + scripts) | `npm run typecheck` | clean |
| Production no-key bot game | `npm run smoke:verified` | **PASS** (see below) |

New: `apps/server/test/live-moments.test.ts` (6 tests) —
1. **Spotlight rotation**: one spotlight per heat phase, no player twice, never
   back-to-back.
2. **Secrecy**: for every spotlight, the subject's socket is checked against the
   WHOLE question pool for that subject (every seed, alias-substituted) across
   every frame it ever received — round views, snapshots, reveals, interludes,
   finale — and never sees one. The subject's round view is always a decoy or the
   idle line.
3. **Decoys**: flagged in the JSONL, absent from every log that reaches
   `computeSignals`/`computeResults`, present in the digest pairing and as the
   reveal punchline (which is the last thing on the wall).
4. **Verdict secrecy**: an early vote is refused ("Phones down…"), every frame
   that arrives during the debate window is tally-free (`numbers`/`slide`/`Chose`
   all absent), and the reveal shows anonymous counts only — never a voter name.
5. **Bots**: a host + three server bots finish a night; spotlight captions and a
   verdict slide with real votes land.
6. **Name clustering unit test**: same-name detection, alias variants
   (`brian!` / `BRIAN` / `Wachuki` / `WACHUKI!`), no cluster on 2 of 7, no cluster
   on exactly half, ambiguous captions ignored, 3-character tokens ignored.

Component tests added (25 checks): caption wall at 320px (header, every caption,
punchline last, no fixed width wider than the viewport), reduced-motion wall,
spotlight cover (looks like a normal text round, 80-char cap), idle cover (no
input), verdict debate → pick grid (self excluded) → submitted pick, verdict
reveal reuses GroupAnnouncement (bars fill one per vote, the answer lands,
haptics, **no confetti** without `celebrate`), reduced-motion verdict bars
(instant, `transition: none`, zero confetti).

## Bot run (production adapters, no API keys)

`npm run smoke:verified` — five external Socket.IO players, ephemeral port,
temporary data dir, independent oracle:

```
Smoke room 52XA: 5 players at http://127.0.0.1:38503
PASS: phases, finale equality, secret ownership and deck limits, duplicate persistence, active and finale resume, dare pass, deletion
PASS (ROUND 3): live moments played — spotlight + verdict; 4 cover screen(s) seen on subject phones
```

Both new kinds are exercised in the real game loop: the bots caption spotlights,
wait out each verdict's 90-second debate, vote, and the night still reaches a
public finale that is identical on every phone. The `4 cover screens` are the
four spotlights of that night seen from the subject's own phone — each one
recognised by the runner as a decoy question or the idle line, never as the real
prompt (a cover that leaked the question would fail the assert). The run is
slower by design — three verdicts plus their debates — so `SMOKE_TIMEOUT_MS` is
now 420s.

## Known gaps / notes

- **`RevealView` additions** were needed beyond the brief's listed contract
  edits (see §1). Filed as `AGENT-R` in `NOTES/contract-requests.md`.
- **Reconnect mid-spotlight**: a subject who reconnects is re-sent the cover
  round (same decoy for that round) — by design, the disguise holds. A phone
  that reconnects during the *reveal* gets the caption wall without the round
  context; the generic reveal fallback covers older clients.
- **Verdict nights are long**: 90s of real debate per verdict (3 per night). This
  is the point of the round, but it is the main length cost of ROUND 3.
- The cover is deliberately *not* themed to the phase — a decoy that looked like
  a spotlight question would defeat the disguise.
- `MERGE-REPORT.md`'s NO-GO reasons (rating/IOS intent, real-device matrix) are
  unchanged by this round; no real phone has been tested here.
- Mock-dev timing is clamped (spotlight 20s, verdict 30s with a 6s debate) so the
  demo stays watchable.
