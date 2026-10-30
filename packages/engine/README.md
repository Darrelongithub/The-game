# @reveal/engine — scoring engine (Agent C)

Pure deterministic functions. Zero I/O, zero network, zero runtime
dependencies, no API keys. The LLM never produces a number here — every
score is code, and replaying a log always deep-equals itself.

## Run

```bash
npm --prefix packages/engine install   # dev tooling only (typescript, tsx, @types/node)
npm --prefix packages/engine test      # deterministic goldens, edge cases and scoring regressions
npm --prefix packages/engine run typecheck
```

Import (workspace source, consumed via `tsx` like the rest of the repo):

```ts
import { computeSignals, computeResults, buildNightDigest, buildSecrets }
  from "../engine/src/index.ts"; // or "@reveal/engine" under npm workspaces
```

## Public API (exact Agent C signatures)

- `computeSignals(log, meta): PairSignal[]` — all unordered pairs, `a < b`
  (string order), emitted in sorted-id order. Throws for < 4 or > 12
  players, or duplicate player ids.
- `computeResults(signals, log, meta, config = DEFAULT_WEIGHTS, tagOf?)`
  — `config` re-weights `pairScore` everywhere (matching included), so
  spec §14 tuning-by-replay works. `tagOf(recordId) => string[]` is the
  contempt-tag seam (defaults to empty → contempt density 0).
  `Results.computedAt` = the log's last `at` (deterministic, not wall
  clock), so the same log always produces deep-equal `Results`.
- `buildNightDigest(log, meta): NightDigest` — never throws; the server
  calls it mid-game on partial logs for interlude teasers.
- `buildSecrets(results, digest, meta): Map<PlayerId, SecretCard[]>` —
  only players with ≥ 1 card get an entry.

## Pair components (spec §5, each 0..1)

- `pickOverlap` — of pick rounds where both players picked and neither
  picked the other, the share choosing the same third target. 0 if none.
- `mutualPick` / `coupleEvidence` / `friendEvidence` / `negativeMutual` —
  one pooled normalisation, so all four are hand-computable the same way:
  `(a→b hits + b→a hits) / (a's picks + b's picks)` restricted to the
  coding set (couple+friendship, couple only, friendship only,
  friction+rivalry respectively). 0 when neither player made such a pick.
- `debriefSim` — token-Jaccard (lowercase alphanumeric token sets) of the
  pair's two debrief texts; missing data is omitted from measured components. Pairing is inferred from
  the log (no pair id exists in `LogRecord`): shared roundId with exactly
  2 writers → shared promptId with exactly 2 writers → the only 2
  debrief writers in the log. Gemini refinement, when it exists, arrives
  via Agent D's lane — the engine stays code-primary.
- `iosMean` — `(ios(a→b) + ios(b→a)) / 14`, averaging repeated records
  per direction first. A missing direction contributes zero.
- `traitAgreement` — `1 − |self − peer| / 9` per shared trait, averaged
  over traits, then over both directions (a's self vs b's peer-ratings of
  a, and vice versa). Repeated ratings are averaged per rater first, so
  one person gets one vote.
- `pairScore` — `DEFAULT_WEIGHTS` in `computeSignals`; re-weighted by
  `config` inside `computeResults`.

## Claims

Fixed emission order: ship → besties → spark → rival → toxic →
consensus → blindspot → onesided. Claim ids are deterministic
(`ship-p1-p2`, `consensus-<roundId>-<target>`, …). Evidence strings and
secret facts use `Player N` pseudonyms only (meta order) and avoid
numerals other than the pseudonym — every quantity lives in
`claim.numbers`, per spec §7's "numbers ONLY from claim.numbers".

- **ship** — brute-force maximum-weight matching over `pairScore`
  (ties → more pairs, then the lexicographically smallest pair list).
  Both players must have made a positive-coded pick of the other. If the
  evidence does not support a complete matching, the matching stays partial;
  it never invents an unsupported public pairing.
- **besties** — the same matching on reciprocal friendship-coded picks,
  weighted by `friendEvidence`. `Results.freeAgent` comes from the *ship*
  matching only when there is exactly one unmatched player.
- **spark** (private, always) — ship pairs with ≥ `SPARK_MIN_MUTUAL` (2)
  couple-coded picks in *each* direction, both players in `revealOptIn`, and
  high confidence: at least `CONFIDENCE_RULES.high.independentSignals` (3)
  independent measured signal types clearing the existing support bars.
  Mutual picks alone never announce a spark; `buildSecrets` also refuses any
  spark claim below high confidence.
- **toxic** — negative indegree over friction/rivalry pick rounds.
  Joker guard: a picker whose most-named target exceeds `0.70` of *all*
  their picks is downweighted ×`0.5`. Percentile = share of
  `MC_SIMULATIONS` (4000) seeded mulberry32 sims (fixed seed, uniform
  random targets ≠ picker, same round structure, same joker weights)
  landing strictly below the player's weighted indegree. Score =
  `TOXIC_WEIGHTS` → `0.6·percentile + 0.4·contemptDensity`, where density
  is the share of the player's authored texts whose `tagOf(recordId)`
  includes `"contempt"` (0 by default). Emitted only at percentile
  ≥ 0.95 with med+ confidence; if over half the weighted case rests on
  joker-guarded pickers the confidence is capped at low and the claim is
  omitted — one person's bit is not the room's verdict.
- **rival** — the pair maximising `negativeMutual + rivalryPooledRate`
  among truly-mutual negative pairs whose `pairScore` is mid-range
  (0.20–0.65). Omitted at low confidence (negative claims never go
  public half-proven).
- **consensus** — per non-neutral pick round with ≥ 3 voters: a target
  with share ≥ `0.70`. `numbers` = the real `{votes, of, share}`.
  Confidence: a single verdict round is med; the same target + coding
  clearing 70% in a second round makes both high.
- **blindspot** — per player × trait (all six contract traits are the
  spec's evaluative set): self-rating vs peer `groupMean`, `spread` =
  peer max−min. Emitted at `|gap| ≥ 2` with ≥ 2 distinct raters.
  Med+ → public; low → private (it can still feed Secret Cards).
- **onesided** (private, always) — directed positive-pick rate ≥ 0.5
  one way, ≤ 0.25 back, gap ≥ 0.5, over ≥ 2 positive picks. Subjects
  are `[picker, target]` — the card lands on the picker's phone.

**Confidence** counts independent signal types over above-chance bars
(`ENGINE_TUNING` in `src/internal.ts`): pick rates must clear ½
*strictly* (an exactly-half rate over a handful of rounds is
chance-sized), `iosMean ≥ 0.65`, `traitAgreement ≥ 0.80` (uniform-random
ratings average ≈ 0.633), measured `debriefSim > 0.6`; missing debrief is excluded. High = ≥ 3 types, med = 2
(`CONFIDENCE_RULES`). Low-confidence negative claims are never public:
toxic/rival lows are omitted entirely; blindspot lows go private.

## Night Digest (spec §15)

Quotes: text rounds only (debrief is private, never quoted), trimmed
length 20–160, must contain a letter/digit, deduped case-insensitively,
ranked by word count then length, ≤ 12. Stats: fastest/slowest single
`latencyMs` of the night, top dodger, tap-war champion. Dodges: every
passed dare's verbatim reason, in log order. Running gags: shout words
seen ≥ 2× (case-insensitive). Pick teasers are counts-only and name
nobody — no finale spoilers. `selfVsRoom`: every self+peers trait,
sorted by |gap| descending.

## Secret Cards (spec §7)

Order spark → onesided → blindspot → roomnote → stat, ≤
`SECRET_DECK_MAX`, 1–4 facts each, every fact ≤ 120 chars, numbers only
from claims/digest. Spark → both players (both must be `revealOptIn`).
One-sided → picker's phone only, and only if the picker opted in (the
private *claim* exists regardless; consent gates the card). Blindspot →
top ≤ 3 digest gaps ≥ 1 as facts on one card. Roomnote → the player's
strongest exactly-2-signal (med) positive pair that was neither
published (ship/besties) nor sparked — positive-only by construction.
Stat → that player's digest headlines (speed titles, tap war, dodges
with first verbatim reason, one honesty/chaos-boast-then-dodged
contradiction).

## Tests

Two hand-computed 5-player golden logs (arithmetic in the test
comments) assert exact pair components and the exact claim sets.
False-positive suite: (a) joker room → no toxic claim at all;
(b) seeded uniform-random rooms → zero high-confidence claims;
(c) n=4 works / n<4 throws; (d) n=5 → exactly one free agent;
(e) matching ≥ best of 10,000 random matchings; (f)(g)(h) results /
digest / secrets deep-equal on replay; (i) decks ≤ `SECRET_DECK_MAX`;
(j) card ids unique per phone, spark on exactly the two phones.

Honest residual: confidence is an evidence-count heuristic (only toxic
has a sampling distribution). In a *deliberately dense* uniform-random
sweep run while tuning (6 players, 18 pick rounds, every trait rated by
everyone, 60 seeds), 57/60 rooms produced zero high-confidence claims;
the other 3 produced a single high blindspot where five random raters
landed within 1 point of each other 4.6+ away from the self-rating —
i.e. the pattern literally exists in that generated data. A real night
rates far fewer trait×player combinations, so the multiple-comparisons
surface is much smaller.

## Contract requests

Appended to `NOTES/contract - requests.md` (filename as delivered):
stable `LogRecord` id for the `tagOf` seam (engine exports a composite
`logRecordId()` meanwhile), pair grouping on debrief records, the
dev-only dependencies note, and a `revealOptIn` scope clarification.
