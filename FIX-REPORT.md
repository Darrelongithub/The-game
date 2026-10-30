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
