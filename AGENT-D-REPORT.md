# AGENT D — PROMPTS & PROVIDERS — DONE

Full detail: `packages/prompts/REPORT.md`. Integration guide: `packages/prompts/README.md`.
Scope file: `agents/paste/agent - D.md`. Scope: `packages/prompts/` only.

## Delivered
- **Fallback bank** — `packages/prompts/src/bank/{warmup,spicy,deep,dare,unhinged}.json`
  18 / 25 / 23 / 24 prompts (SPICY_TIER on) → **90 total**; 63 with the tier off,
  still ≥15 per phase. All 40 research-brief seeds + all of u1–u27 (gated).
  Every entry passes the data-or-dead rule; every rating prompt carries
  `trait:<TraitId>`.
- **Provider layer** — `src/provider.ts` + `src/guard.ts`: Grok lane (generation
  only, JSON mode, 8 s abort) and Gemini lane (analysis/narration, `SAFETY_OFF`),
  one shared per-room `CallGuard` (cap 8, batch slots 4/1/1/1), both lanes
  optional and silent on failure. No key → bank/code, never throws.
- **Code-first analysis** — `src/analyze.ts`: 8-tag keyword lexicon, contempt
  density, token-Jaccard debrief similarity; ONE optional Gemini tag batch and
  ONE optional debrief batch per room per night, every value validated/clamped.
- **Generator** — `src/generate.ts`: ONE Grok call per phase, deterministic
  filter (schema, dedupe, banned patterns, 20–160 chars, `{P1}..{P11}`,
  data-or-dead), verbatim-only digest callbacks (~1 in 3 from spicy), refusal/
  timeout/429 → `[]` → bank.
- **Facade** — `src/facade.ts` `PromptProvider.forPhase(phase, n, used)`
  (bank-first, host lines → bank → generated) + `generateInBackground`.

## Verification
```
cd packages/prompts
npx tsc -p tsconfig.json --noEmit     # clean (strict)
node --test test/*.test.ts            # 94 tests, 94 pass, 0 fail — zero network
```
Covers: filter drops (empty measures, no room direction, banned, hard blocks,
length, placeholders, dedupe), bank completeness both tiers, no-key night,
refusal/timeout/429 → bank, lane independence (Grok-key-only makes zero Gemini
calls and vice versa), guard trips at the cap, callbacks (invented quotes
dropped), alias scrubbing.

## Contract requests filed (in `NOTES/contract - requests.md`)
`Prompt.trait`, `Prompt.callback`, verify `grok-4-1-fast`, `SAFETY_OFF` →
`BLOCK_NONE` on classic v1beta, shared `isPrompt()` guard.

## Blocker for Z
The kit refers to `NOTES/contract-requests.md`; the repo file is
`NOTES/contract - requests.md`. My five rows are in the existing file.
