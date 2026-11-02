# `@reveal/prompts` — the bank and the two lanes

The prompt bank, the local generator, the remote analyst, and the call ledger
that keeps both of them on a budget. **Everything here is code-first**: with no
model and no key the handwritten bank carries the whole night, offline. A
provider only ever *sharpens* the wording — it never produces a number the
engine scores, and nothing in this package decides who wins anything.

```
src/bank/*.json  warmup 36 · spicy 63 · deep 37 · dare 28 · unhinged 30 = 194
src/bank/index.ts  the loader (unhinged FIRST, then the bands), the seeded
                 shuffle, and the spread-out selection
src/ollama.ts    THE LOCAL LANE — fillNames/restoreNames, the rephrase prompt,
                 the four drop reasons, the per-band batch, the terminal report
src/generate.ts  `generateNight` — the whole run: bands, safety cap, backfill
src/provider.ts  THE GEMINI LANE — the analyst: pseudonyms in, reveal copy out
src/guard.ts     ONE per-room in-memory call ledger for BOTH lanes (cap 8)
src/facade.ts    `PromptProvider` — bank-first, never blocks the game
src/index.ts     the public surface
```

There is no content filter, and no `filter.ts`. This is a party for the people
in the room, not an app that ships.

## The bank

| file | prompts | notes |
|---|---|---|
| unhinged.json | 30 | the hottest tier; loaded **first**, always, no switch (`band: "spicy"`) |
| spicy.json | 63 | the night opens here (`BAND_ORDER[0] === "spicy"`) |
| warmup.json | 36 | includes 10+ that are already about kissing / sleeping with / body counts |
| deep.json | 37 | feelings, but never a therapy label |
| dare.json | 28 | the ones you have to actually do |

`bankCounts()` counts the unhinged tier inside `spicy` (93), because that is the
band its entries carry.

* Every line is about a person **in the room**: `{P1}..{P11}` slots (bound at
  deal time) or an explicit room reference.
* `measures` carry `metric:<MetricKey>` first — that is what the engine reads.
* `selectFromBank(n, opts)` is deterministic per seed, never repeats a template
  inside a night, and never puts two prompts of the same kind + metric back to
  back when the pool can avoid it.
* The floor the brief asks for is 150; the bank has 194.

## The local lane (Ollama)

```
GEN_BASE        http://127.0.0.1:11434
GEN_MODEL       dolphin-mistral
GEN_TIMEOUT_MS  120000
```

The model gets ONE job: rephrase the night's questions and dares. It is handed
the room's **real names** (`fillNames`) — the questions are about these people,
and a local model has nothing to be careful about — and every name it writes
back is turned into its `{Pn}` slot again (`restoreNames`) before the line is
kept. The slot is what the night stores, so the case engine still does the
casting: a line the model rewrote against roster player 1 may be dealt to
anyone, and it reads the same either way.

A candidate is dropped for exactly four reasons, and nothing else:

| reason | means |
|---|---|
| `not-in-room` | after the names go back to slots, nobody in the room is named |
| `repeat` | says the same thing as a line already accepted, or is the bank line unchanged |
| `too-long` | over `MAX_PROMPT_CHARS` (160) |
| `refusal` | empty, "as an AI", or commentary instead of a question |

The run walks the bands in `BAND_ORDER`, stops at `GEN_SAFETY_CAP_MS` (180 s)
and prints one line per batch to the host terminal:

```
Ollama: asked 15, accepted 12, dropped 3 (not-in-room:1, repeat:2)
```

Anything not accepted is served from the bank, unchanged. `GEN_TARGET_PROMPTS`
(40) is what the loading screen counts toward.

## The remote lane (Gemini)

```
GEMINI_API_KEY  unset → the lane is off, silently
GEMINI_MODEL    optional; resolveGeminiModel() picks the tier
```

Gemini does not write questions. At the end of the night it gets the whole
pseudonymised data set (`buildRequestPayload` in the narrator) and writes the
reveal and the secret-card copy. Only pseudonyms go out — `redactAliases`
scrubs every alias from the request — and the copy comes back through the
narrator's validators, so a line with an invented number, a banned phrase or a
name that is not on the slide is dropped in favour of the engine's line.

`geminiSafetySettings` is turned off. There is no curator.

## Lanes & budget

| lane | config | job | when |
|---|---|---|---|
| Ollama | `GEN_*`, no key needed | the night's questions and dares | before the night starts |
| Gemini | `GEMINI_API_KEY` | the analysis: reveal + secret-card copy | once, at the reveal |

Both spend from one `CallGuard` per room: total ≤
`MAX_PROVIDER_CALLS_PER_NIGHT` (8), with slots `generate 4 / reveal 1`. A
missing key returns `no-key` and the network is never touched; a timeout, a 429
or garbage returns a reason and the caller falls back, silently. No retry, ever.

## Use it (the server)

```ts
import { createPromptProvider } from "@reveal/prompts";

const provider = createPromptProvider({
  room: roomId,
  playerCount: 5,            // gates {P5}..{P11} prompts out of a 5-player room
  seed: room.seed,           // one seed per night → the same night twice
  aliases: players.map((p) => p.alias),   // into the local lane's prompts
  log: (line) => terminal(line),          // the "Ollama: asked …" lines
});

await provider.generate();                // Ollama first, bank under it
provider.draw({ role: "observer_subject", count: 2, kinds: ["pick"] });
```

`draw` never blocks and never returns an empty list. `usedPromptIds()` keeps a
night free of repeats.

## Tests

```bash
cd packages/prompts && npm install
npm test           # 51 tests, zero network — every call goes through a mock fetch
npm run typecheck  # strict tsc, no emit
```
