# Agent D — PROMPTS & PROVIDERS — report

Scope: `packages/prompts/`. Everything below ships inside that package; nothing
outside it was edited except one append to `NOTES/contract - requests.md`.

## Files created

| File | What it is |
|---|---|
| `packages/prompts/package.json` | `@reveal/prompts` (private, ESM). Scripts: `test`, `typecheck`. Dev deps: `typescript`, `@types/node` only. |
| `packages/prompts/tsconfig.json` | strict, NodeNext, `noEmit` (the repo's `.ts`-extension imports need it). |
| `src/bank/warmup.json` | 18 prompts (w1–w10 seeds + w11–w18 originals). |
| `src/bank/spicy.json` | 15 non-unhinged prompts (s1–s10 seeds + s11–s15 originals). |
| `src/bank/deep.json` | 15 non-unhinged prompts (d1–d10 seeds + d11–d15 originals). |
| `src/bank/dare.json` | 15 non-unhinged prompts (dd1–dd10 seeds + dd11–dd15 originals, incl. pair_dare + debrief). |
| `src/bank/unhinged.json` | u1–u27 verbatim from `reference/unhinged-tier.md` (SPICY_TIER only). |
| `src/bank/index.ts` | Loader (JSON per phase), `SPICY_TIER`/env resolution, placeholder parsing, deterministic `selectFromBank` (kind spread, player-count + used-id aware). |
| `src/text.ts` | Tokenizer, token-set Jaccard (0.5 = unknown), dedupe normaliser, `clamp01`. |
| `src/filter.ts` | Schema + banned patterns + hard blocks + placeholder hygiene + dedupe + DATA-OR-DEAD. Every drop carries a `DropReason`. |
| `src/guard.ts` | `CallGuard` — ONE per-room in-memory ledger for both lanes: total cap 8, purpose slots `generate 4 / tag 1 / analyze 1 / reveal 1`, `forget(room)`. |
| `src/provider.ts` | Grok lane (OpenAI-compatible `/chat/completions`, Bearer, JSON mode with one retry without `response_format`), Gemini lane (classic `generateContent`, `SAFETY_OFF` → `BLOCK_NONE` + literal-`OFF` retry), 8 s `AbortController`, failure reasons, alias scrubbing. |
| `src/analyze.ts` | Tag taxonomy + keyword lexicon (`tagText`), `contemptDensity`, token-Jaccard `debriefSimilarity`, ONE-call `tagBatch` / `debriefBatch` refinements (validated, clamped, row-by-row fallback). |
| `src/generate.ts` | ONE batched Grok call per phase → callback integrity check → deterministic filter → ~1-in-3 verbatim callback top-up. Never throws; returns `[]` on refusal/timeout/429/garbage. |
| `src/custom.ts` | Host lines: ≤10, ≤160 chars, `spicy:`/`deep:`/`dare:`/`warmup:` prefixes, kind inference, trait stamp, honest rejections. |
| `src/trait.ts` | `inferTrait`, `traitOfPrompt`, `trait:<id>` measure convention (contract gap stopgap). |
| `src/facade.ts` | `PromptProvider.forPhase(phase, n, used)`, `generateInBackground`, `augment`, `counts`, `remainingCalls`. |
| `src/index.ts` | Public surface (also re-exports the contract types/constants consumers need). |
| `test/helpers.ts` | Mock fetch (records calls/bodies), hanging fetch for timeouts, provider/candidate/digest factories. |
| `test/bank.test.ts` · `filter.test.ts` · `provider.test.ts` · `analyze.test.ts` · `generate.test.ts` · `facade.test.ts` · `night.test.ts` | 94 tests, zero network. |
| `README.md` | Integration guide for F (server), C (engine), B1 (screens), G (host). |

## Bank counts

| phase | SPICY_TIER on | SPICY_TIER off |
|---|---|---|
| warmup | **18** | 18 |
| spicy | **25** (15 + u1–u10) | 15 |
| deep | **23** (15 + u11–u18) | 15 |
| dare | **24** (15 + u19–u27) | 15 |
| total | **90** | **63** |

* All 40 research-brief seeds present; all 27 unhinged entries present and gated.
* Every entry passes DATA-OR-DEAD (coding + non-empty measures + room-directed);
  tested, not asserted by hand.
* Three seed wordings were fixed to obey data-or-dead without changing ids:
  `w3` and `d1` now name the room/group; `d4` names the room. All other seeds are
  verbatim.
* Every `rating` prompt carries `trait:<TraitId>` as its first measure, so the UI
  knows what it is rating (contract gap → request 1).
* The bank alone plays a complete night (warmup → spicy → deep → dare incl.
  `pair_dare` + `debrief`) for 4 and 11 players, with `SPICY_TIER` on or off —
  proven by `test/night.test.ts`.

## Tests + output

```
$ cd packages/prompts && node --test test/*.test.ts
# tests 94
# pass 94
# fail 0
# duration_ms ~1.3s

$ npx tsc -p tsconfig.json --noEmit
(clean)
```

Per file: bank 17, filter 18, provider 15, analyze 13, generate 15, facade 11,
night 5.

Acceptance coverage (from the scope file):

* **Filter logic** — accepts a valid candidate; drops a candidate with empty
  `measures`; drops a candidate with no room direction; drops banned patterns
  (favorites / zombies / desert island / untwisted "most likely to" /
  icebreakers); drops hard blocks (minors, non-consent, explicit acts, real
  people); drops <20 and >160 chars; drops `{P12}`/`{P0}`/`{name}`; drops a
  placeholder above the roster; dedupes vs bank, vs `usedIds`, and within batch
  (exact + Jaccard ≥ 0.8).
* **Bank completeness** — ≥15 per phase with `SPICY_TIER`; ≥15 per phase with it
  off; u1–u27 absent when off; every entry passes data-or-dead; the rating/trait
  invariant; pair_dare + debrief always reachable.
* **No-key mode** — every lane returns `no-key` with zero HTTP requests; a full
  night runs on the bank; the night test replaces `globalThis.fetch` with a
  throwing spy and asserts it is never called.
* **Refusal → bank** — 403 "content policy" → `refusal`; 429 → `rate-limit`;
  hanging fetch + 10 ms timeout → `timeout`; 500 → `http`; thrown fetch →
  `network`; all return `[]` and log a reason.
* **Lane independence** — XAI key only: zero Gemini HTTP calls, `canAnalyze()`
  false; GEMINI key only: zero Grok calls. Verified for both the provider layer
  and the analysis layer.
* **Call-count guard trips at the cap** — 3-call custom guard: 4th logical call
  returns `budget` with no HTTP request; another room still has its own budget.
  Default ledger: cap 8 with batch slots (2nd tag batch in a room → `budget`,
  another room → allowed).
* **Callbacks** — an invented quote is dropped (`invented-quote`), a `callback:
  true` without a quote is dropped (`no-quote`), a verbatim quote survives; the
  ~1-in-3 top-up appends only real digest quotes, stays ≤160 chars, and never
  runs in warmup.
* **Pseudonyms** — a digest full of real aliases leaves the process with none of
  them (whole-token matching, so a two-letter alias cannot mangle `"model"`).

## Contract requests appended (`NOTES/contract - requests.md`)

1. `Prompt.trait?: TraitId` (and `RoundView.trait`) — a rating round is
   unrenderable without knowing the trait. Stopgap: `trait:<id>` measure +
   `traitOfPrompt()`.
2. `Prompt.callback?: boolean` / `quote?: string` — the server cannot tell which
   prompts are callbacks. Stopgap: verbatim substring detection.
3. Verify `PROVIDERS.grok.generate` (`grok-4-1-fast`) — docs.x.ai is unreachable
   from this sandbox. Stopgap: `XAI_MODEL` env override.
4. `SAFETY_OFF` threshold semantics — classic `v1beta` wants `BLOCK_NONE`, not
   `"OFF"`. Stopgap: map + one retry.
5. `isPrompt()` in `packages/shared/src/validate.ts` — three copies of the prompt
   shape check would otherwise drift.

## Known gaps / notes for Agent Z

* **Filename mismatch:** the kit's docs call it `NOTES/contract-requests.md`, the
  file in this repo is `NOTES/contract - requests.md`. Requests were appended to
  the existing file.
* **Model ids are unverified offline.** If `grok-4-1-fast` 404s, the night falls
  back to the bank and logs `http`; set `XAI_MODEL` to the current id.
* **Gemini safety thresholds** were verified from the contract comment + API
  docs knowledge only; the provider retries once with the literal contract value
  if the endpoint rejects `BLOCK_NONE`. Both attempts share one budgeted call.
* **Retries are HTTP-level only:** a JSON-mode retry or a safety retry is ≤2
  requests for 1 budgeted call, so the ledger still hard-stops at 8 logical
  calls (≤16 requests worst case).
* **Dedupe is phase-limited for generated prompts:** generation dedupes text
  against the WHOLE bank and `usedIds`, but not against prompts generated for
  other phases (they are separate batches). Overlap across phases is unlikely;
  flagged for Z's spot-check.
* **Rating trait inference is a heuristic** (keywords → `TraitId`); a generated
  rating with no readable trait is dropped rather than guessed.
* **`spicy` tier switch:** `SPICY_TIER=false` in `.env` disables u1–u27 without a
  contract edit (contracts keeps `SPICY_TIER = true`).
* **No new runtime dependencies.** The package only imports `node:fs`,
  `node:test`/`node:assert` in tests, and the shared contracts; `typescript` +
  `@types/node` are dev-only.
* **Tests run on Node 22 native type stripping** (`node --test test/*.test.ts`)
  and also under `tsx`; the package avoids TS-only runtime syntax (no enums, no
  parameter properties, no decorators).
