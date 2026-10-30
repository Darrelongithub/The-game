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

> Historical report for PR #10. Subsequent integration adds the purple shell,
> local earlier-answer callbacks, improved rating/IOS defaults and secure resume
> retry. Real-device, LAN, live-provider and public-proxy testing remain open.

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

---

## R1–R20 remediation carry-forward — adapted to current `main`

This section records the R1–R20 branch status (the ROUND 4 report above is historical). **The branch is now reconciled with `main`.** The ROUND 4 ready-gate and demo-room features were adapted together with the R1–R20 remediation instead of taking either side wholesale: the shared contract is the additive union (`profile`/`role`/structured rating intent **plus** `ready`/`demo`/`impersonatedBy`), the server keeps the ready gate and demo seats while still requiring the 18+ profile for an ordinary room, the web entry collects the profile and consents and also offers the demo-room toggle, rating/IOS keeps the server-assigned trait/target (no silent client defaults), and narrator reveals stay Grok-only (Gemini is analysis-only).

Re-validated after the merge (Node 22.22.3): `selfcheck` 36/36; engine 40/40; prompts 104/104; narrator 81/81; server 68/68; web typecheck + 39 SSR checks + 56 mock-flow checks + UI/socket/transport/mock/privacy regressions all passing; jsdom component suite 151/151 (including the ROUND 4 ready-screen and demo-console checks); production build, `bundle:check` (player 145.2 KiB / 150 KiB; display 115.7 KiB / 120 KiB) and `npm audit --omit=dev` (0 vulnerabilities) pass; `smoke:verified`, `smoke:demo` (42 round events, 12 finale slides) and the jsdom export smoke pass against the built server. The real-browser `test:browser` still needs a Chromium executable, and the physical-device/LAN/live-provider matrix remains outstanding (see below).

### Remediation and regression status

| Item | Adapted outcome / regression evidence |
|---|---|
| R1 | Entry validates 18+ profile and required consent; the private-card opt-out remains available. UI and server fixtures now submit the current profile contract. |
| R2 | Rating and IOS subjects (and rating traits) are assigned by the server, personalized in the round view, validated on submit, and no longer left to client defaults. Protocol and UI regressions cover non-self assignments and locked intent. |
| R3 | Dare performer/pair assignment and pass-with-reason flow remain enforced; regression covers solo performer rotation and both pair pass reasons. |
| R4 | Public display joins through its dedicated role/event path; snapshots and finals exclude player secrets and per-player decks. Server display-role regression passes. |
| R5 | Provider-bound text is pseudonymized; Unicode NFC/NFD alias variants are covered by server and provider regressions. |
| R6 | Reconnect uses authenticated, rotating session credentials and nonce-bound lost-ack recovery; protocol and real SocketTransport regressions pass. |
| R7 | Public prompt selection keeps host prompts first and generated prompts ahead of bank fallback only in eligible non-pick slots; regression passes. |
| R8 | Engine confidence/claim rules preserve mutual nomination and measured-signal gates; exact-result and no-high-confidence-on-picks-only checks pass. |
| R9 | `tease` is accepted as a prompt coding while remaining outside negative-score coding; prompt validation and deterministic scoring suites pass. |
| R10 | Rating/IOS intent is explicit in the current profile/round contract; SSR, transport, and server protocol tests use the assigned values. |
| R11 | Phase schedule retains four slots per heat and now provides two pick slots per heat; full-game, bot, and phase round-count regressions pass. |
| R12 | LAN output reports all non-loopback IPv4 addresses and QR data; automated server regression passes. |
| R13 | Room metadata is atomically persisted beside the JSONL log and validated/replayed on restart; two-restart deep-equality regression passes. |
| R14 | Production finale polishing uses the Grok `reveal` lane; deterministic engine copy remains the fallback. Mocked one-call Grok regression passes. |
| R15 | Generated prompts augment rather than replace bank coverage; host prompts retain precedence and generated prompts are prioritized for eligible slots. Regression passes. |
| R16 | Lobby exposes the public-display link; SSR and component checks pass. |
| R17 | Web entry remains lazy-loaded/static-exported; production bundle guard passes for player and display entrypoints. |
| R18 | Zero is measured and absence is not; measured-component weights renormalize, debrief has no 0.5 fallback, and high-confidence claims require at least three independent measured signal types. Golden fixtures and engine regressions pass. |
| R19 | Removed the narrator package’s Gemini HTTP/reveal helper and exports. Gemini remains analysis-only; `GEMINI_MODEL` uses the shared resolver for Gemini call sites. Grok reveal integration and a negative Gemini-reveal provider regression pass. Contract and spec wording now agree. |
| R20 | Engine code remains deterministic and wall-clock independent. Monte Carlo is bounded by `MC_SIMULATIONS`; noise tests are summarized per night. Same-log results are deeply equal, including restart replay. The 11-player/1,320-pick performance guard passes. |
| R21 | **CONFESS ROUNDS (the second voice).** Every night now runs two voices: group questions ("Who here…", everyone picks someone) and confessions ("Have you ever…", everyone answers about themselves, privately). Contract deltas are owner-approved; `STYLE_MIX` balances the flexible question slots to 50/50, each heat phase deals two confessions, and a twin links a group seed to its confess seed 1–3 rounds later. Warm reveals are counts only, spicy reveals attribute YES answers only, a no is never named in any tier, and a missing phone never becomes a no. Engine, prompts, server and web regressions cover all of it. |

### CONFESS ROUNDS — what changed and how it is held

**The two voices.** A group question captures the room's *perception* ("Who here
would you set up with someone else in this room?"). A confession captures
*reality*: the same "Have you ever…" question on every phone, answered about the
respondent, privately. `PromptStyle = "group" | "confess"` tags every seed and
every generated prompt; `STYLE_MIX = { group: 0.5, confess: 0.5 }` and a
deterministic, round-index-seeded selector (error diffusion) keeps the flexible
question slots inside ±1 of that mix for a whole night.

**The round.** `RoundKind` gained `"confess"`, `ROUND_TIMERS_MS.confess` is
20s, and `ResponseValue` gained `{ kind: "confess"; yes: boolean; target?:
PlayerId; note?: string }`. There is no skip: a phone that never answers is
counted as MISSING and is never converted to a "no". A confess answer that
names a target feeds the pair machinery as the new `"confession"` component —
evidence with weight 0, so a confession alone never graduates a claim.

**The reveal (secrecy is structural).** `apps/server/src/confessReveal.ts` never
sees a `PlayerId`; it is handed aliases or nothing, so a warm reveal cannot name
anyone even by accident.

| tier | phases | shown |
|---|---|---|
| warm | warmup | `N of M said yes.` only — no names, no hints; notes as "someone wrote: …" |
| spicy | spicy / deep / dare | YES answers by alias, yes-notes attributed; NO is a NUMBER; a note attached to a no stays anonymous; `K stayed quiet.` when phones missed it |

The reveal goes through the ready gate like every other reveal.

**The payoff.** A group seed may carry `twinId`; the director schedules its
confession 1–3 rounds later, at most once per phase, and — when it is due — deals
it as its own round, so the two questions really do sit one to three rounds
apart. At the finale, `confessMismatches` compares the room's guess with the
confessions and the night gets one extra slide: "The room was sure it was Player
3. Two people just said yes." The line names the room's *guess* and counts the
yeses; no-attribution is absolute even there.

**Gen lane.** Generation requests carry the style, and the generator's system
prompt teaches both registers: second-person self-report ("Have you ever…") plus
4–6 confession few-shots loaded from the bank at runtime alongside the group
ones (a register without examples produces off-voice output).

**Tests added (each fails on the old contract).** Contracts/validation
(`isResponseValue`, `targetsOther`), engine (`chooseStyle` mix within ±1 over a
12-round night, twin planning window, tally/missing, yes-rate, `"confession"`
component, mismatch line), prompts (every question seed tagged, ten confession
seeds per phase in the second voice, twin pairs, both voices in the gen system
prompt with ≥4 bank few-shots), server (`confess-rounds.test.ts`: private
answers with a missing phone, warm counts-only payload with no id/alias, spicy
yeses-only attribution with a no never named in any tier, anonymous-vs-attributed
notes, twin served inside its window plus the mismatch slide, and same-script
determinism), web (`confess.tsx`: the answer sheet with no skip, "no" drops any
target, warm reveal names nobody, spicy reveal never names a no).

### Validation on this branch (with CONFESS ROUNDS)

- `npm run typecheck`: passed across server, web, engine, narrator, and prompts.
- Server: **73/73** tests passed, including the new `confess-rounds` suite (private answers with a missing phone, warm counts-only payload, spicy yeses-only attribution, anonymous-vs-attributed notes, twin window + mismatch slide, same-script determinism), demo-mode, reveal-ready gate, full-game, restart replay, protocol, provider integration, and bot coverage.
- Engine: **55/55** passed. Same-log results, digest, secrets and the style/twin plans are deeply equal; `planStyles(12)` stays inside ±1 of `STYLE_MIX`.
- Prompts: **117/117** passed (including the local-Ollama generation lane merged from `main`) — every question seed is tagged with a voice, each heat phase carries ten confession seeds in the second voice, twin pairs link different voices, and the gen system prompt ships both registers with ≥4 bank few-shots. Narrator: **81/81**.
- Web: **39 SSR checks**, **151** component checks, **56** mock-flow checks, all UI/socket/transport/mock/privacy regressions, **1/1** transport regression, plus the new **4** confess UI regressions (answer sheet with no skip, "no" drops the target, warm names nobody, spicy never names a no).
- `npm run selfcheck`: **43 checks passed** (includes `STYLE_MIX` sums to 1 and the twelve round kinds).
- `npm run smoke:demo`: passed against a live local server — **51 round events, 31 reveals, 62 ready-gate snapshots, 11 finale slides**.
- Merge with `main` (which landed the `GEN_BASE`/`GEN_MODEL` local-Ollama lane in `packages/prompts`): one import conflict in `generate.ts`, resolved by keeping BOTH lanes — the Ollama provider changes stay untouched and the two-voice register block rides on top. Nothing from `main` was reverted; prompt suite at 117 proves both survive.
- `npm run build`: passed (Next static export). `npm run bundle:check`: player **145.2 KiB gzip / 150 KiB**; display **115.7 KiB / 120 KiB**.
- Not re-run in this session: the private-oracle `smoke:verified` (needs an external oracle) and the on-device checklist below.

### Release disposition: **NO-GO / REQUIRES HUMAN**

Automated coverage is green, but no real Android or iPhone device results have been recorded. Do not mark GO or treat merge authorization as release approval. Complete this 10-minute on-device script on both platforms and enter device model, OS/browser version, result, and any issue in this report:

1. **0:00–1:00** — Open the hosted game on Android Chrome, then iPhone Safari. Confirm layout, 18+ profile and required consent gates; exercise the private-card opt-out.
2. **1:00–3:00** — One phone creates a room and opens the public display; three additional phones join by code/link. Confirm the display has no player controls or private card content.
3. **3:00–6:00** — Start the game. Submit pick, rating, IOS, text, and a dare pass with a reason. Confirm assigned rating/IOS intent cannot be changed and all phones advance without refresh. Answer at least one confession with Yes, one with No plus a note, and leave one phone untouched: the warmup reveal must be a bare count that names nobody, and the hot reveal must name the yeses only — never the person who said no, and never the phone that stayed quiet.
4. **6:00–8:00** — Background one phone, return, and verify authenticated reconnect restores the active round without duplicate submission. Rotate one device to portrait/landscape and check the display remains legible.
5. **8:00–10:00** — Finish through the finale. Confirm all player phones show the same public finale, only each eligible owner sees their private deck, and delete-room removes the room from all clients.

| Device | Model | OS + browser | Result / notes | Date |
|---|---|---|---|---|
| Android | _pending_ | _pending_ | **REQUIRES HUMAN** | _pending_ |
| iPhone | _pending_ | _pending_ | **REQUIRES HUMAN** | _pending_ |


**AGENT H1 — REVEAL QUEUE (`REVEAL_MODE`, server, DEFAULT-OFF)** — `"round"` is today's night byte-for-byte; `"finale"` suppresses every per-round reveal, appends the already-computed payload to an append-only `*.reveals.log` night queue beside the room log (0600, restart-safe, deterministic: same log ⇒ same queue, order from round index), bypasses the ready gate mid-game (rounds advance on the gate's grace exactly as if the reveal had fired — the gate itself is untouched and still protects the finale), and at finale start delivers the whole reel, in round order, as `reveal` events on the DISPLAY channel only, immediately before `finale` (a display joining mid-finale is caught up the same way; phones never see the queue and the phone finale is unchanged). Unset/empty/misspelt env ⇒ `"round"`. Proof: `apps/server/test/reveal-mode.test.ts` 8/8 (fails on pre-feature code: missing export), server suite 76/76 (68 pre-existing untouched), engine 40/40, prompts 104/104, narrator 81/81, web SSR 39/39 + transport 1/1, `npm run typecheck` clean, `npm run selfcheck` 36/36.
- Agent H3 — Added lobby Host screen labeling and link copying (with LAN fallback), preserving public-display and invite actions; SSR, web/component tests, build, bundle check, and selfcheck (43/43) passed.
