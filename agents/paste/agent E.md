You are Agent E — NARRATOR. Read `agents/parts/preamble.md` first and follow it exactly. Then read `spec/spec.md` §7, 15 and all of `packages/shared/src/contracts.ts`.

## Your scope: `packages/narrator/`

1. **Skeleton builder** (`src/slides.ts`) — PURE:
   `buildSkeleton(results: Results, digest: NightDigest): FinaleSlide[]`
   - PUBLIC slides only — the `finale` event is broadcast-safe (identical on
     every phone). Order: title → besties (tease/escalate/land) → rivals →
     consensus → blind spots → **digest comedy block**: QUOTE OF THE NIGHT
     (flavor "quote", verbatim + attributed), DODGE REPORT (flavor "dodge",
     every excuse verbatim), SPEED RUNNER (flavor "stat", fastest on spicy+
     rounds) + one contradiction if the digest has one → toxic → **SHIP**
     (3 beats, biggest) → closing.
   - Consensus claims and the most-toxic land beat get flavor `"group"` —
     they render as Group Announcements. Copy the claim's `numbers` into
     `slide.numbers` untouched (votes/of/share fuel the animations).
   - NO private slides exist — private material is Secret Cards (below).
   - Engine `evidence` strings become the fallback `body` of every slide.
2. **Copy writer** (`src/write.ts`) — ONE provider call for everything:
   `writeFinale(skeleton, decks, results, digest) → Promise<{ slides: FinaleSlide[]; decks: Map<PlayerId, SecretCard[]> }>`
   - ONE call on `PROVIDERS.gemini.reveal` (higher-tier Gemini — analysis +
     narration is Gemini's lane; SAFETY_OFF attached so it can handle spicy
     text) via a thin fetch helper you own in this package. Send the
     pseudonymized claims + digest material + the skeleton beats + the
     per-player secret cards + tone spec (roast-warm, dry, never mean-spirited,
     never clinical — secret cards lean KIND: they land on one phone, alone,
     at midnight).
   - **Hard rules in the system prompt:** numbers ONLY from `claim.numbers`;
     players ONLY as "Player N" verbatim; never invent quotes/stat/labels;
     title ≤6 words; body ≤140 chars; each secret fact ≤120 chars.
   - No `GEMINI_API_KEY` → engine fallback strings from `evidence`/`facts`
     as-is. 10s timeout → all-fallback. Never empty text. (Grok is NOT used
     here — generation is its lane, narration is Gemini's.)
3. **Validator** (`src/validate.ts`) — runs on EVERY model response, on slides
   AND card facts:
   - Reject digits not present in that claim's `numbers` (whitelist the
     "Player 3" token format).
   - Reject player references not matching `Player \d+`.
   - Banned phrases: "toxic person", "red flag", "soulmate", "science says",
     "love language", "diagnos", "narcissis", "therapy".
   - Any rejected slide/fact → engine fallback string.
4. No key → all-fallback templates. Never empty text.

## Acceptance
- Tests with mocked fetch: validator catches invented numbers, bad references,
  banned phrases (on slides AND card facts); skeleton ordering (toxic before
  ship, group flavors carry numbers, ZERO private slides ever); no-key path
  returns fully-populated slides + decks from evidence alone.

## Report
Files created, test output, contract requests.
