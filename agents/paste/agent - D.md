You are Agent D — PROMPTS & PROVIDERS. Read `agents/parts/preamble.md` first and follow it exactly. Then read `spec/spec.md` §6, 15, `packages/shared/src/contracts.ts` (PROVIDERS), `reference/research-brief.md` §1, and `reference/unhinged-tier.md`.

## Your scope: `packages/prompts/`

1. **Fallback bank FIRST** (`src/bank/`, one JSON per phase):
   - Seed from the 40 tagged examples in research-brief §1 (map their tags to
     `PromptCoding`) + ALL of unhinged-tier u1–u27 (behind `SPICY_TIER=true`;
     filtered out when false).
   - **Data-or-dead rule (spec §6):** every entry is directed at someone in
     the room (or a pair), carries a coding, and has non-empty `measures`
     that feed the engine. A dare that targets no one and measures nothing
     is random spectacle — it does not ship. Reject/fix any seed that fails.
   - Result: ≥15 prompts per phase usable at runtime. Every entry: `id`,
     `phase`, `kind`, `text` (`{P1}`-style placeholders where a player is
     named), `measures`, `coding`, `asksTarget`.
   - The bank alone must make a full night playable with ZERO API calls.
2. **Provider layer** (`src/provider.ts`) — TWO INDEPENDENT LANES:
   - `canGenerate()` = `XAI_API_KEY` present → **Grok lane (unhinged
     generation ONLY)**: plain `fetch` to `POST {baseUrl}/chat/completions`,
     Bearer key, model `PROVIDERS.grok.generate`. JSON mode if the current xAI
     API supports it (check docs.x.ai) — else strict-parse a JSON fence. 8s
     timeout via AbortController.
   - `canAnalyze()` = `GEMINI_API_KEY` present → **Gemini lane (analysis +
     narration support)**: classic REST `generateContent` with `SAFETY_OFF`;
     models from `PROVIDERS.gemini`. Gemini NEVER generates game prompts.
   - Missing key in a lane → that lane stays silent (bank / code fallback).
     Never throw, never block gameplay.
   - Both lanes go through ONE shared `callCount` guard that hard-stops at
     `MAX_PROVIDER_CALLS_PER_NIGHT` (counted per room, in-memory).
3. **Code-first analysis** (`src/analyze.ts`) — deterministic PRIMARY
   implementations, LLM refinement optional:
   - `tagText(text)`: keyword lexicon → tags from the fixed taxonomy
     (contempt, criticism, defensiveness, stonewalling, affection, admiration,
     grievance, neutral). `tagBatch(texts[])` may refine with ONE
     `PROVIDERS.gemini.tag` call per night when the key exists; validate every
     returned tag against the taxonomy, ignore anything else.
   - `debriefSimilarity(a, b)`: token-Jaccard (0..1). With the key,
     `debriefBatch(pairs[])` = ONE `PROVIDERS.gemini.analyze` (higher tier)
     call judging all pairs; clamp/validate each score to 0..1, else keep
     Jaccard. Invalid output = code result, never an error.
   - `buildNightDigest` is NOT yours (Agent C owns it, pure code).
4. **Generator** (`src/generate.ts`) — BATCHED:
   `generateBatch({ phase, playerCount, usedIds, digest }) → Prompt[]` — ONE
   Grok call per phase asking for ~15 candidates as a JSON array (temp 0.9),
   then the deterministic filter (schema, dedupe vs bank+usedIds+within-batch,
   banned patterns, 20–160 chars, valid `{P1}..{P11}` only, AND data-or-dead:
   room-directed + coded + non-empty `measures` — drop any candidate that
   fails) keeps the best.
   **Callbacks:** from spicy onward ~1 in 3 must reference an actual digest
   quote VERBATIM (never invent an earlier answer). On refusal/timeout/429 →
   bank. **Pseudonyms only.** Called from the lobby background, never the
   gameplay loop.
5. Facade `PromptProvider.forPhase(phase, n, used)` — bank-first always;
   generated prompts only AUGMENT the bank.

## Acceptance
- Unit tests with mocked fetch: filter logic (incl. a candidate with empty
  `measures` / no room-direction is dropped), bank completeness (≥15/phase
  with SPICY_TIER, sensible set with it off), every bank entry passes
  data-or-dead (coding + non-empty measures), no-key mode, refusal→bank path,
  lane independence (Grok key only → zero Gemini calls and vice versa),
  call-count guard trips at the cap.
- Zero real network calls in tests.

## Report
Files created, bank counts per phase, test output, contract requests.
