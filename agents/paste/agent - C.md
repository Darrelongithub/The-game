You are Agent C — SCORING ENGINE. Read `agents/parts/preamble.md` first and follow it exactly. Then read `spec/spec.md` §5, 7, 14, 15 and all of `packages/shared/src/contracts.ts`.

## Your scope: `packages/engine/` — PURE functions, zero I/O, zero network

Public API (exact signatures):
- `computeSignals(log: LogRecord[], meta: RoomMeta): PairSignal[]`
- `computeResults(signals: PairSignal[], log: LogRecord[], meta: RoomMeta, config = DEFAULT_WEIGHTS): Results`
- `buildNightDigest(log: LogRecord[], meta: RoomMeta): NightDigest`
- `buildSecrets(results: Results, digest: NightDigest, meta: RoomMeta): Map<PlayerId, SecretCard[]>`

Implement spec §5 exactly:
1. Components: `pickOverlap`, `mutualPick`, `debriefSim` (token-Jaccard of the
   pair's two debrief texts; 0.5 when absent), `iosMean`, `traitAgreement`
   (1 − |self − peer|/9, averaged both directions). `pairScore` via
   `DEFAULT_WEIGHTS`; keep raw components in `PairSignal`.
2. **ship**: maximum-weight matching by brute-force enumeration (n≤12 →
   ≤10,395 matchings; recursion: pair first player or leave them out),
   constrained to pairs with `coupleEvidence > 0 || friendEvidence > 0`.
   Odd n: exactly one `freeAgent`. If constraints leave >1 player out on even
   n, rerun unconstrained. **besties**: same but weight on friend-coded signals.
3. **toxic**: negative indegree = nominations received on friction/rivalry-
   coded pick rounds, with the `JOKER_GUARD` downweight applied to any picker
   whose same-target share > 0.70. Percentile via `MC_SIMULATIONS` seeded sims
   (mulberry32, fixed seed) of uniform-random picks over the same round
   structure. `TOXIC_WEIGHTS` (contemptTags = 0 for now — the tag seam exists,
   accept `tagOf?: (recordId) => string[]` defaulting empty).
4. **rivals**, **consensus** (≥70% same target on a coded prompt; put the real
   fraction in `numbers`), **blindspot** (evaluative traits; self + groupMean +
   spread in `numbers`), **onesided** (always private), **spark** (couple-coded
   mutual + both in `meta.revealOptIn`; always private).
5. Confidence per `CONFIDENCE_RULES`; low-confidence negative claims never public.
6. **`buildNightDigest`** per spec §15: latencies (fastest/slowest per round),
   every "I can't" + verbatim excuse, shout running gags, minigame champion,
   pick-cluster teaser lines (NO finale spoilers), self-vs-room gaps, best
   quotes (≤12, length 20–160, deduped, not emoji-only). Deterministic.
7. **`buildSecrets`** per spec §7 — deterministic, numbers ONLY from
   claims/digest:
   - `spark` → one card for EACH of the two (only when both `revealOptIn`).
   - `onesided` → card on the PICKER's phone only.
   - `blindspot` → each player's top ≤3 self-vs-room gaps as facts.
   - `roomnote` → med-confidence directional notes the engine chose NOT to
     publish (never low-confidence, never unkind).
   - `stat` → that player's digest stats: dodges (+ reasons), fastest/
     slowest, one contradiction if they have one.
   - ≤ `SECRET_DECK_MAX` cards per player; fixed order
     spark → onesided → blindspot → roomnote → stat; titles + facts written
     by the ENGINE as plain strings (the narrator may polish later — keep the
     interface `facts: string[]`).

## Tests (the package is nothing without them)
- Golden fixtures: two hand-computed 5-player logs → exact expected `Results`.
- **False-positive suite**: (a) everyone picks the same friend every round → NO
  high-confidence toxic claim (joker guard); (b) uniform random room → zero
  high-confidence claims; (c) n=4 works, n<4 throws; (d) n=5 → exactly one
  freeAgent; (e) matching beats 10,000 random matchings on total weight;
  (f) same log twice → deep-equal Results (determinism); (g) same log twice →
  deep-equal digest; (h) same log twice → deep-equal secrets; (i) every deck
  ≤ `SECRET_DECK_MAX`; (j) no secret card appears on more than one phone
  except spark (which appears on exactly the two).

## Report
Files created, test output, contract requests appended (if any).
