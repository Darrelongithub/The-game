# Spec — "The Reveal Game" v2 (Oct 2026)

Night-length party game for 4–11 friends, one phone each, room code, no install.
Escalating prompts — forced-choice "pick someone here", deep questions, shouting
rounds, mini-games, dares with an "I can't" escape that demands a reason. Every
response is data; the night gets milked for jokes. Deterministic code scores
everything. End of night, Wrapped-style reveal: ship, besties, most toxic,
rivals, consensus facts, blind spots — plus Secret Cards that live on one phone
only.

## 0. Non-negotiables
1. **Deterministic scoring.** The LLM never produces a number.
2. **Fully playable with NO API keys** — handwritten bank carries the whole night.
3. **Two LLM lanes; code carries the night.** Grok (xAI) generates the
   unhinged prompts (`XAI_API_KEY`). Higher-tier Gemini analyzes the data and
   narrates the finale (`GEMINI_API_KEY`). Everything else — bank, similarity,
   tags, digest, every number — is deterministic code. Lanes are independent
   and optional: no keys at all = a fully playable night on the bank, offline.
4. **18+ only.** Private friend group, self-hosted by the host.
5. **Pseudonyms only** ("Player 1..N") to ANY provider. Real aliases never leave.
6. Raw data purged after **48h**; ANY player can delete the room instantly.
7. Cross-platform web — the "mac couldn't join" rule (§11 checklist).
8. **UI = `reference/ui-system.md` VERBATIM + `reference/ui-system-FIXES.md`.**
9. **Secrets stay on one phone.** Spark, one-sided, blind spots and personal
   stats are Secret Cards: delivered only to the owning player's socket,
   face-down, hold-to-reveal (release hides again). Never broadcast, never on
   anyone else's screen, never in the share card.

## 1. Rooms & players
- Room code: 4 chars from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`. Idle TTL 24h.
- 4–11 players. Host = creator (start/skip/add_bot/custom_prompts only).
  Server authoritative; rounds auto-advance when all required players submit or
  timer + `GRACE_MS` expires. `add_bot` fills a seat with a server bot (alias
  "🤖 Bot N") so the host can test solo.
- Join = alias (2–14 chars) + consent (age 18+, terms, reveal opt-in).
- **Demo rooms (ROUND 4).** The host may create a room with `demo: true`: every
  seat but the host's is puppeted from one laptop so the whole game can be
  tested alone (`demo_add_player`, `demo_set_bot_mode` auto/manual,
  `demo_answer_as`, `demo_all_ready`, `demo_speed` 0.1–1.0). Demo rooms start
  with 2+ seats instead of 4. Puppet answers are ordinary log records carrying
  `impersonatedBy` metadata that the engine ignores — scoring parity is the
  point. The controls are host-only and demo-room-only; nothing about them
  reaches a payload besides `RoomView.demo`.
- Reconnect: session secret in sessionStorage; `visibilitychange` → re-join →
  full `RoomView` snapshot + seq. No diff replay.
- **Accounts (optional, ROUND 4).** `POST /api/account` with a username and a
  4–6 digit PIN returns a **one-time recovery code** — shown once, "store it,
  there is no email". `POST /api/account/login`, `POST /api/account/recover`
  (code rotates on use), `POST /api/account/night` (binds tonight's room to the
  account using the player's own session secret), `GET /api/account`,
  `DELETE /api/account` (hard wipe: identity, night links, carried suspicions).
  The server stores scrypt hashes of the PIN, the recovery code and the token
  seeds — never an email address, because no email field exists anywhere.
  Token lives in `localStorage`; login pre-fills the alias suggestion (still
  editable per night). **Guest parity is absolute:** an account is never
  required, never gates a room, and never changes a round, a score or a claim.
  Identity outlives the 48h room purge; a night's data does not.

## 1a. Reveals wait for everyone (ROUND 4)
A closed round's reveal is **pending**: `RoomView.ready` lists who has pressed
`ready`, no phone shows the moment yet, and the reveal fires when every
connected player is ready. A player who drops out stops being waited for, bots
never block, and `REVEAL_READY_GRACE_MS` (20s) reveals anyway so one AFK phone
cannot stall the night. The host may release it early with `skip_round`.

## 2. Session flow
`lobby → warmup → spicy → deep → dare → debrief → finale → closed`
Interludes (with Night-Digest teasers) between phases. Escalation gate: a phase
ends only when every connected player answered its rounds (or host force-advance).
Group may vote heat DOWN one level (majority); never up. Never skip a level.
After the public finale story ends on a phone, that player's Secret Deck
unlocks (§7) — only if they have cards.

## 3. Round types & timers
| kind | timer | input |
|---|---|---|
| pick | 45s | choose a player (≠ self) |
| text | 90s | free text ≤280 |
| shout | 15s | one word ≤24 (majority word wins) |
| rating | 40s | 1–10 on a trait, about self or a named player |
| ios | 40s | 1–7 closeness circles about a named player |
| minigame | 12s | score (tap war: most taps in 5s) |
| dare | 300s | done, or passed + REQUIRED reason ≤140 |
| pair_dare | 330s | two players leave together, questioned separately after |
| debrief | 60s | private text from each pair member, compared at the finale |
| spotlight | 25s | short text ≤80 about the LIVE moment (the subject gets a cover) |
| verdict | 105s | 90s of open debate (`voteOpensAt`) then a simultaneous secret pick |

`pair_dare` and `debrief` rounds carry `onlyPlayers` — everyone else gets a
spectator screen ("They're talking…"). Each response records `latencyMs`.

### 3a. Live moments — spotlight & verdict

Not more questions: MOMENTS that put the room's eyes on one person, or make
everyone argue. **~1 spotlight per phase from warmup on; ~1 verdict per phase
from spicy on.** Both close their phase (the room ends on a moment, not a
question); together they are the phase's mini-finale.

- **spotlight — "everyone look at X."** The server picks a subject (rotation:
  each player spotlighted at most once a night, never back-to-back). Everyone
  except the subject answers a name-cluster or caption question about the live
  moment (bank `live/spotlight.json`, `{S}` = subject alias).
  - **The subject never sees the question.** Their round view is a COVER: a
    random decoy from `live/decoys.json` ("What did you eat today?"), or an
    idle screen ("Nothing for you right now. Soak it in." — `expectsAnswer:
    false`), re-drawn every spotlight so a repeat subject cannot pattern-match.
    The real prompt never rides `round`, `state`, `reveal` or any other emit to
    that socket, and the reveal payload carries captions only.
  - Their answer is logged with `decoy: true`. **Decoys never score** — no
    signal, no claim, no secret: they answer nothing. They are digest gold
    (see §15) and the punchline of the reveal.
  - **Reveal** (~8s hold): a RAPID CAPTION WALL — the room's one-liners stack
    live in big type under the subject's alias, and the subject's own decoy
    answer lands LAST, biggest.
- **verdict — "discuss it, then decide."** The prompt lands on every phone with
  "PHONES DOWN. ARGUE IT OUT." and a 90-second countdown (`voteOpensAt` = round
  start + 90s). Then 15 seconds of SIMULTANEOUS SECRET pick (normal pick grid,
  self excluded, no early votes: "Phones down. Argue it out first.").
  - **Reveal** (~6s hold): anonymous vote bars fill one per vote, numbers count
    up, then the room's answer LANDS full-screen with haptics — the
    Group Announcement component, i.e. the round's mini-finale. Confetti only
    for couple-coded verdicts (`celebrate`).
  - Verdict picks are normal coded picks and feed consensus / one-sided / pick
    overlap. Post-deliberation conformity is the room's choice, not a bug.

## 4. Signals (engine inputs)
Directed picks, self+peer trait ratings, IOS, shout words, minigame scores, dare
compliance + verbatim pass reasons, pair debrief texts, response latencies.

## 5. Scoring (deterministic; every component 0..1)
pair_score(i,j) = 0.30*pickOverlap + 0.20*mutualPick + 0.20*debriefSim
                + 0.15*iosMean     + 0.15*traitAgreement
- `pickOverlap`: share of pick rounds where i and j chose the same target
  (excluding rounds where they chose each other).
- `mutualPick`: normalized mutual couple/friend-coded picks between i and j.
- `debriefSim`: pair-dare transcript similarity 0..1 — token-Jaccard is
  PRIMARY; one batched higher-tier Gemini call refines it when
  `GEMINI_API_KEY` exists; 0.5 = unknown.
- `iosMean`: (ios(i→j) + ios(j→i)) / 14.
- `traitAgreement`: i's self-ratings vs j's peer-ratings of i (and vice versa).
- **ship** = maximum-weight matching over `pair_score` (brute-force enumeration;
  n≤12 → ≤10,395 matchings), constrained to pairs with ≥1 mutual positive
  signal. Odd n: exactly one **free agent** (own slide).
- **besties** = same matching on friend-coded signals only.
- **toxic(i)** = 0.6 * negIndegreePct + 0.4 * contemptTagDensity. negIndegreePct
  = Monte-Carlo percentile (4,000 seeded sims of random picks, same round
  structure). Joker guard: a picker naming the same target in >70% of pick
  rounds gets all nominations downweighted 50%.
- **rivals** = pair maximizing (mutual negative picks + rivalry-coded hits)
  where pair_score is mid-range.
- **consensus**: ≥70% of pickers chose the same target on a coded prompt →
  "the room keeps saying X about Y" (always show the real fraction).
- **blind spot**: per trait |self − groupMean| with spread shown. Evaluative
  traits only: loyalty, chaos, reliability, warmth, honesty, spice.
- **one-sided**: pick(i→j) high percentile while pick(j→i) low → PRIVATE
  Secret Card on the picker's phone only.
- **spark**: ship-pair with mutual couple-coded picks AND both in
  `revealOptIn` → PRIVATE Secret Card for EACH of the two.
- **Confidence:** high = ≥3 independent signal types (and ≥70% consensus where
  applicable); med = 2; low = 1. Low-confidence negative claims are NEVER public.
- **Formation band & graduation (ROUND 4).** The engine also keeps PRIVATE
  suspicions — `Hypothesis` objects, INTERNAL, see §6a. A suspicion only forms
  when its deterministic strength lands inside `HYPOTHESIS_FORM_BAND`
  (`{lo: .35, hi: .65}`): strong enough to be worth probing, weak enough to stay
  a suspicion. Above the band, with ≥3 independent signals meeting
  `CONFIDENCE_RULES.high`, it **graduates**: it leaves the hypothesis set and
  becomes an ORDINARY claim (subject to every rule above — the finale pays it
  off like any other claim, with no memory of why the room was asking). A
  suspicion the latest round contradicts is **refuted**; below the band is
  noise. **One-sided material is unchanged and absolute:** it can only ever
  graduate to a PRIVATE claim → a Secret Card on the picker's phone.
  With accounts, unresolved suspicions survive the night as priors and are
  quietly probed again next time (§6a). Nobody is told this is happening.

## 6. Prompt engine — providers & the code-first rule
- **Code-first, LLM-garnish.** Deterministic code is the PRIMARY
  implementation of everything: the handwritten bank carries all prompts,
  token-Jaccard scores debrief similarity, a keyword lexicon tags
  contempt/affection, the digest and every number are pure code. Providers
  only ADD on top; every LLM output is validated then merged, never trusted
  raw. Hard cap: ≤ `MAX_PROVIDER_CALLS_PER_NIGHT` provider calls per night.
- **Fallback bank FIRST**: ≥15 prompts per phase in `packages/prompts/src/bank/`,
  seeded from `reference/research-brief.md` §1 (40 tagged examples) + ALL of
  `reference/unhinged-tier.md` (u1–u27) behind `SPICY_TIER=true`. The bank makes
  a full night playable with zero API calls.
- **Two independent lanes:**
  - **Grok (xAI) = unhinged generation ONLY** (`XAI_API_KEY`).
    OpenAI-compatible REST `POST https://api.x.ai/v1/chat/completions`,
    Bearer key, model `grok-4-1-fast` ($0.20/$0.50 per 1M, verified Oct
    2026 — verify the id at docs.x.ai/docs/models). Grok's envelope ≈
    "R-rated movie": adult banter / dark humour / innuendo pass; explicit
    sexual acts, minors, real-person sexual content, non-consent are
    hard-blocked — the unhinged tier lives inside that. No safety knobs
    exist; the deterministic filter is the guardrail.
  - **Gemini = analysis only** (`GEMINI_API_KEY`, higher tier):
    `GEMINI_MODEL` resolves once for Gemini calls; it tags public text and
    judges paired debrief similarity in bounded batches. Gemini is never used
    to write the finale or secret cards. `SAFETY_OFF` applies to analysis.
    Gemini NEVER generates game prompts (it soft-refuses them).
- **Lane independence:** each lane checks only its own key and degrades to
  code silently. No XAI key → bank-only generation and deterministic finale.
  No Gemini key → lexicon tags + Jaccard similarity. Neither → full game,
  zero internet needed after install.
- **Batching (the call budget):** generation = ONE call per phase (~15
  candidates per call, JSON array) in the lobby background — never in the
  gameplay loop; tag = ONE call; debrief = ONE call; Grok reveal+secrets = ONE
  call. ≈7 calls worst case, cap 8.
- **Generation:** the deterministic filter (schema, dedupe vs
  bank+usedIds+within-batch, banned patterns, 20–160 chars, valid
  `{P1}..{P11}` placeholders) picks the best of the batch. Generated
  prompts AUGMENT the bank — the bank alone runs the night.
- **Callbacks**: from spicy onward ~1 in 3 generated prompts must reference
  an actual earlier answer from the Night Digest (quote verbatim, never
  invent).
- **Pseudonymize**: only "Player 1..N" ever leaves the server.
- **Banned patterns** (system instruction + filter): favorites, zombies, desert
  island, untwisted "most likely to", generic icebreakers.
- **Host custom prompts**: lobby, ≤10 lines, ≤160 chars each, optional
  `spicy:`/`deep:`/`dare:` prefix — tonight's bank only, deleted with the room.
  - **Data-or-dead rule.** Every prompt — bank, host, or generated — must
  extract a signal: directed at someone in the room (or a pair), coded, with
  non-empty `measures` that feed the engine. A dare that targets no one and
  measures nothing is random spectacle and is banned.

### 6a. The Director — the invisible selector (ROUND 4)
The engine develops suspicions about the room and quietly interrogates them.
**Players never see hypotheses.** No board, no event, no interlude line, no
recap, no "what the game suspected" beat — nothing. The only player-visible
effect of the Director is that rounds keep feeling fresh, relevant and slightly
uncanny.

- **Formation.** After EVERY round `formHypotheses(signals, log, meta, priors?)`
  re-reads the log (mid-band rule, §5) across six kinds: `tension`, `besties`,
  `secret`, `selfimage`, `onesided`, `freeagent`. Strength and evidence are
  deterministic code; subjects are pseudonymous in any LLM context; `openedAt`
  is the epoch ms of the first supporting answer (or a previous night).
- **Selection.** `directNextRound(hypotheses, coverage, candidates, seed)` deals
  one round at a time, seeded by the round index (replay = identical choices):
  - **50% TEST** (`ROUND_MIX.test`) — an OPEN suspicion's subjects on its
    dimension (`couple`/`friendship`/`trust`/`status`/`friction`/`neutral`),
    bound into the prompt's `{P1}`/`{P2}` slots. Grok may generate targeted
    candidates, pseudonymized and never telegraphing: "a spicy prompt that would
    reveal whether Player 3 is into Player 5" is fine; "is Player 3 into Player
    5?" is not. A targeted prompt must read as organic.
  - **30% EXPLORE** (`ROUND_MIX.explore`) — the least-covered **(pair ×
    dimension)** cell of the coverage matrix, so fresh material begets fresh
    suspicions. `coverage` is a plain count map that never leaves the server.
  - **20% CLASSIC** (`ROUND_MIX.classic`) — bank/callback rounds as before.
  Lanes fall through gracefully: a test slot with nothing testable becomes
  explore, a covered matrix becomes classic.
- **Anti-telegraph.** Never more than `ANTI_TELEGRAPH_MAX` (2) CONSECUTIVE
  rounds touching the same subject pair. Without it the engine machine-guns two
  people, the room clocks it, and the invisibility breaks.
- **Cross-night (accounts only).** Unresolved suspicions are stored per account
  and re-mapped onto tonight's player ids as priors; the game keeps probing old
  suspects, silently. Guests carry nothing.
- **What players see: nothing new.** Freshness surfaces only through existing
  channels — the selector's choices, digest teasers, callbacks — and the
  finale's CLAIMS, which is where graduated suspicions pay off as ordinary
  claims. The one-sided rule (§5) is untouched.
- **Invisibility is an assertion, not a hope:** `assertNoHypothesisLeak()` runs
  over every client-facing emit, `Hypothesis` never appears in any
  `ServerToClientEvents` payload, and no room-log line or client-side log ever
  contains one.

## 7. Narrator, Group Announcements & Secret decks
- Input: `Results` + `NightDigest`. Output: public slide copy ("Player N"
  only) + Secret Card copy. The `finale` event is **broadcast-safe** (public
  slides only, identical on every phone); private material flows only through
  the per-socket `secrets` event.
- **Public skeleton order**: title → besties (tease/escalate/land) → rivals →
  consensus → blind spots → QUOTE OF THE NIGHT → DODGE REPORT → SPEED RUNNER
  (digest comedy block) → toxic → **SHIP (biggest beat, confetti)** → closing.
- **Group Announcements** (slide flavor `"group"`): consensus claims and the
  most-toxic land beat render as the big room-verdict moment — "GROUP
  ANNOUNCEMENT" title treatment, anonymous vote bars filling one per vote
  (NEVER voter names — count only), counting numbers from `slide.numbers`
  (e.g. votes/of/share, tabular-nums count-up), then the subject's name LANDS
  full-screen with confetti + haptics.
- **Secret decks**: after the closing slide, players with private material see
  "You have N secrets — only on this phone." Cards are face-down (glass +
  grain + glyph); **press-and-hold** to open (`SECRET_HOLD_MS` ramp, release
  hides it again — shoulder-surfers see nothing); tap/swipe for the next card.
  Card kinds: `spark` (mutual + both opted in — one card for EACH of the two),
  `onesided` (picker's phone only), `blindspot` (your top self-vs-room gaps),
  `roomnote` (med-confidence directional notes the engine chose not to
  publish — never low-confidence, never unkind), `stat` (your digest stats:
  dodges, speed, contradictions — self-roast fuel). Facts: 1–4 lines per
  card, numbers only from claims/digest, ≤ `SECRET_DECK_MAX` cards, fixed
  order spark → onesided → blindspot → roomnote → stat. The share card and
  every other phone NEVER include secret content.
- **Hard rules:** quote numbers ONLY from `claim.numbers`; players only as
  "Player N" verbatim; never invent quotes/stat/psychology labels; title ≤6
  words; body ≤140 chars; secret fact ≤120 chars; roast-warm tone (secret
  cards lean KIND — they land on one phone, alone, at midnight). Server swaps
  "Player N" → alias after narration (deterministic string replace).
- **Fallback**: template sentences from engine `evidence` when no provider.

## 8. Transport & reconnection
- Socket.io v4; HTTP polling fallback enabled by default (flaky mobile data).
- Server authoritative. `submit` idempotent via `clientUuid`. Stale seq dropped.
- Reconnect = full snapshot. Payloads <5KB, JSON only.

## 9. Persistence & retention
- v1: in-memory + one JSONL log per room (`apps/server/data/`).
- Hourly purge: rooms older than 48h hard-deleted (files included).
- `delete_room` by ANY player → immediate hard delete + `deleted` broadcast.

## 10. Front-end stack & UI system
- **Next.js (App Router, TypeScript) with `output: "export"`** — the exported
  static site is served BY the game server (single origin: no CORS, no
  localhost calls, works behind any proxy/tunnel). This matches the UI system's
  Next.js code verbatim (see §0.8).
- **Tailwind v3 — PINNED.** The UI system's `@tailwind` directives +
  `tailwind.config.ts` are v3 syntax; current create-next-app defaults to
  Tailwind v4, which silently breaks them. Install `tailwindcss@3`.
- Deps: `framer-motion` (as pasted), `canvas-confetti`, `clsx`,
  `socket.io-client`.
- Files (layout.tsx with Clash Display + Inter, globals.css tokens, tailwind
  config, AmbientBackground, Flame, OpeningSequence, AnimatedWords, GlassCard,
  GlowButton) = `reference/ui-system.md` verbatim, with `ui-system-FIXES.md`
  applied (7 fixes — ember memoization, viewport-scaled wipe, timer cleanup,
  intro-once, Tailwind pin, rAF throttle, font fallback). Game-layer signature
  components — **GroupAnnouncement**, **SecretDeck with HoldToReveal** — are
  built new in the same design language (§7, §12).

## 11. Cross-platform checklist (non-negotiable)
1. `dvh` not `vh` anywhere full-screen (iOS Safari address bar).
2. Blur effects get the lighter mobile variant already in globals.css.
3. Touch targets ≥48×48px.
4. `-webkit-backdrop-filter` always accompanies `backdrop-filter`.
5. Feature-detect `navigator.vibrate` (iOS Safari lacks it).
6. Headlines use `clamp()`, never fixed px.
7. Test the opening sequence on a real iPhone AND a real Android.
8. Cursor glow is desktop-only (`pointer: coarse` gate).
9. `prefers-reduced-motion` block stays.
10. Opening sequence plays ONCE per session + tap-to-skip (see FIXES).
11. Sockets: polling-first transport, visibilitychange re-join, snapshot resume.
12. Hold-to-reveal suppresses long-press callout/copy menus
    (`-webkit-touch-callout: none; user-select: none`) and works with both
    touch and mouse.

## 12. Design tokens
Base palette (verbatim from ui-system.md): `--bg-base #0d0617`,
`--purple-primary #8b2fe0`, `--blue-secondary #2f5fe0`, `--blue-glow #3b82f6`,
`--lime-accent #b6ff3c`, `--white-text #f5f3ff`. Glass cards, grain, blobs.
Heat mapping (game layer): warmup `#3b82f6` · spicy `#b6ff3c` · deep `#8b2fe0`
· dare `#ff4d6d` (add `--red-alert: #ff4d6d` — also for "most toxic" moments).
Secret cards: face-down = glass + grain + a lock/eye glyph on the heat
gradient; hold = card scales 1.02 + progress ring; revealed = full heat
gradient + lime flash; release = back to face-down. Group Announcement uses
`--red-alert` accents for verdicts and lime for the count-up.

## 13. Deployment & hosting
- **Game night = `npm run host`** (root; Adapt convention: `npm run build &&
  node host.mjs`). `host.mjs` loads `.env`, spawns the server bound to `HOST`
  (default `0.0.0.0`) : `PORT` (default 3001) with clean Ctrl+C shutdown and
  `NEXT_TELEMETRY_DISABLED=1`. The server's boot banner prints every LAN URL
  (`http://192.168.x.x:3001`) plus a terminal QR code — friends on the same
  WiFi or the host's phone hotspot scan and play: no install, nothing to type.
  The exported web app is served BY the server from the same origin (no CORS,
  no localhost calls).
- **Offline by default:** with no API keys the entire night runs on the LAN
  with zero internet after `npm install`.
- **Remote friends (fallback):** any Node host — Render/Railway/Fly free tier
  (`npm install`, `npm run build`, `npm start`). Habitual play: Vultr
  Johannesburg ($6/mo, best Nairobi latency). Never Supabase realtime
  (no Africa region).
- **Env:** copy `.env.example` → `.env` (git-ignored): `HOST`, `PORT`,
  `XAI_API_KEY`, `GEMINI_API_KEY` — all optional.

## 14. Tuning
All weights/timers/thresholds live in `contracts.ts` constants. Tuning =
replaying recorded JSONL logs against new configs, never editing logic.

## 15. The Night Digest — milking the data
Jokes come from the night itself, so they work with whoever shows up.
**Captured:** latency per response, every "I can't" + verbatim excuse, shout
words (running gags), minigame champions, pick clusters, self-vs-room gaps.
**Used:** (1) interlude teasers — one roast line between phases, no spoilers;
(2) callback prompts (~1 in 3 from spicy on, quoting the digest verbatim);
(3) finale digest slides — Quote of the Night, Dodge Report, Speed Runner,
contradictions ("Self-rated honesty 9/10. Passed on the honesty dare. Twice.").
Every joke must trace to digest/claims data — the narrator never invents.

**Live moments are digest fuel (ROUND 3).**
- **Caption walls** are quote material: every spotlight caption is a normal
  text answer and competes for Quote of the Night.
- **Decoy pairing** is the best line of the night: the digest leads its quotes
  with *"While the room captioned {S}, {S} wrote: '<decoy answer>'"* — the
  subject answered a throwaway cover question while the room described them.
- **Name clusters** are ONE teaser per spotlight round — *"6 of 7 wrote the same
  name for {S}"*. Fires only on ≥3 matching answers AND a strict majority, so
  2 of 7 is silence. A cluster is **never** a formal engine claim: live
  observation is fun, not evidence. Ambiguous captions that name two players
  count for neither.
