# `@reveal/prompts` — Agent D (PROMPTS & PROVIDERS)

The fallback bank, the algorithm guardrail, and the two optional LLM lanes.
**Everything here is code-first**: with no API keys the bank carries the whole
night, offline. Providers only *augment*, and never produce a number the engine
scores.

```
src/bank/        warmup.json  spicy.json  deep.json  dare.json  unhinged.json
src/bank/index.ts  loader, SPICY_TIER gate, {{{Pn}}} / player-count aware selection
src/filter.ts    THE guardrail: schema, dedupe, banned patterns, 20–160 chars,
                 valid {P1}..{P11}, hard blocks, DATA-OR-DEAD
src/guard.ts     ONE per-room in-memory call ledger for BOTH lanes (cap 8, slots)
src/provider.ts  Grok lane (generation/reveal) + Gemini lane (analysis only)
src/analyze.ts   lexicon tags + token-Jaccard (primary), one optional Gemini refine
src/generate.ts  ONE Grok call per phase → filtered prompts, callbacks verified
src/custom.ts    host custom lines (≤10, ≤160, optional spicy:/deep:/dare: prefix)
src/trait.ts     which TraitId a rating prompt is about (trait:<id> measure)
src/facade.ts    PromptProvider.forPhase(phase, n, used) — bank-first
```

## Bank

| phase | SPICY_TIER on | SPICY_TIER off |
|---|---|---|
| warmup | 18 | 18 |
| spicy | 25 (13 seeds/extras + u1–u10) | 15 |
| deep | 23 (15 + u11–u18) | 15 |
| dare | 24 (15 + u19–u27) | 15 |
| **total** | **90** | **63** |

* Seeds: all 40 of `reference/research-brief.md` §1, tags mapped to `PromptCoding`.
* Unhinged tier: all of u1–u27, included **only** when `SPICY_TIER` is on
  (`SPICY_TIER=false` in `.env` also switches it off — no contract edit).
* Every entry passes the data-or-dead rule (`coding` + non-empty `measures` +
  room-directed), carries `id, phase, kind, text, measures, coding, asksTarget`,
  and every `rating` prompt starts its measures with `trait:<TraitId>`.
* Two research-brief seeds were reworded to satisfy data-or-dead (`w3`, `d1`)
  and one (`d4`) to name the room; the ids are unchanged.

## Use it (Agent F / server)

```ts
import { createPromptProvider } from "../../prompts/src/index.ts";

const prompts = createPromptProvider({
  playerCount: 5,          // gates {P5}..{P11} prompts
  room: roomId,            // per-room provider budget
  // provider: undefined → created from env (XAI/GEMINI keys optional)
  customPrompts: hostLines,
  aliases: players.map(p => p.alias), // scrubbed before any provider call
});

const round = prompts.forPhase("spicy", 1);          // bank-first, never empty
void prompts.generateInBackground("spicy");          // lobby only, fire-and-forget
```

* `forPhase(phase, n, used)` — deterministic, never repeats an id, serves host
  lines → bank → generated. Treat the result as `Prompt[]`; substitute `{Pn}`
  server-side for display only.
* `generateInBackground(phase, { digest })` — one batched Grok call per phase
  (max 4/room/night). Returns `[]` on any failure; never throws, never blocks.
* `remainingCalls()`, `canGenerate()`, `canAnalyze()` for the boot banner.
* Rating rounds: `traitOfPrompt(prompt)` → `TraitId` (until the contract gains
  `Prompt.trait`; see `NOTES/contract - requests.md`).

## Analysis (Agent C / narrator)

```ts
import { tagText, tagBatch, debriefSimilarity, debriefBatch } from "@reveal/prompts";

tagText("you always do this");                       // ["criticism"] — pure code
await tagBatch(texts, { room, provider });           // ONE gemini.tag call/night
appliedWeightsSimilarity = debriefSimilarity(a, b);  // token-Jaccard 0..1
await debriefBatch(pairs, { room, provider });       // ONE gemini.analyze call/night
```

Code results are always computed first and stand in for any invalid model row.
`tagBatch`/`debriefBatch` are optional refinements — never call them in the
gameplay loop.

## Lanes & budget

| lane | key | job | model |
|---|---|---|---|
| Local OpenAI-compatible (Ollama) | none | prompt generation only | `GEN_MODEL` (default `dolphin-mistral`; legacy fallback `XAI_MODEL`) |
| Grok | `XAI_API_KEY` | existing validated reveal polish call only (unchanged) | `PROVIDERS.grok.generate` (override: `XAI_MODEL`) |
| Gemini | `GEMINI_API_KEY` | tagging and debrief analysis only; no reveal path | `PROVIDERS.gemini.tag/analyze` |

All spend from one `CallGuard` per room: total ≤ `MAX_PROVIDER_CALLS_PER_NIGHT`
(8) with batching slots `generate 4 / tag 1 / analyze 1 / reveal 1`. Missing cloud key →
that cloud lane returns `no-key` and the network is never touched. 8 s
`AbortController` timeout. Refusal / 429 / timeout / garbage → the caller falls
back to the bank or to code, silently.

## Tests

```bash
cd packages/prompts && npm install        # typescript + @types/node only
npm test                                  # node --test (94 tests, zero network)
npm run typecheck                         # tsc --noEmit, strict
```

Every provider call in the suite goes through a mock fetch; the no-key night
test asserts that `globalThis.fetch` is never called at all.

### Local prompt generation

On the same laptop as the Node game server, start Ollama and run
`ollama pull dolphin-mistral`. `GEN_BASE` defaults to
`http://localhost:11434/v1`; `GEN_MODEL` defaults to `dolphin-mistral`.
An explicit `GEN_MODEL` wins over the legacy `XAI_MODEL` override. Blank values
use defaults. Generation sends no Authorization header, even if an xAI key is
configured. Phones only talk to the LAN game server, never directly to Ollama.
No cloud/key/internet is needed for generation after the model is downloaded.
If Ollama is stopped, the model is missing, or output is invalid, the existing
bank-first fallback continues the night. Analysis and reveal routing are unchanged.
