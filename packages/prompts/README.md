# `@reveal/prompts` — the bank and the two lanes

The local generator, the remote analyst, the prompt bank used by tests, and
the call ledger that keeps both lanes on a budget. **Ollama writes every
question and dare for a real night.** If it cannot, the room does not start;
the bank is a deterministic fixture for tests, never a production fallback.
No model produces a number the engine scores, and nothing here decides who
wins anything.

```
src/bank/*.json  warmup 36 · spicy 63 · deep 37 · dare 34 · unhinged 30 = 200
src/bank/index.ts  the loader (unhinged FIRST, then the bands), the seeded
                 shuffle, and the spread-out selection
src/ollama.ts    THE LOCAL LANE — the HTTP client, refusals and the legacy
                 rephrase helpers (not used by a production night)
src/generate.ts  `generateNight` — role-planned original generation, heat,
                 slot and chain validation, no bank
src/provider.ts  THE GEMINI LANE — the analyst: pseudonyms in, reveal copy out
src/guard.ts     ONE per-room in-memory call ledger for BOTH lanes (cap 24)
src/facade.ts    `PromptProvider` — Ollama only; a shortfall throws
src/index.ts     the public surface
```

There is no curator, and no `filter.ts`. This is a party for the people in the
room, not an app that ships. Every real prompt is generated with `{P1}` slots
and bound at deal time. The generator does reject lines that are not adult
enough, name nobody in the room, leave a slot unbound, or repeat an earlier
line — that is correctness, not censorship.

## The bank

| file | prompts | notes |
|---|---|---|
| unhinged.json | 30 | the hottest tier; loaded **first**, always, no switch (`band: "spicy"`) |
| spicy.json | 63 | the night opens here (`BAND_ORDER[0] === "spicy"`) |
| warmup.json | 36 | includes 10+ that are already about kissing / sleeping with / body counts |
| deep.json | 37 | feelings, but never a therapy label |
| dare.json | 34 | the ones you have to actually do; generated dares are what a real night uses |

`bankCounts()` counts the unhinged tier inside `spicy` (93), because that is the
band its entries carry.

* Every line is about a person **in the room**: `{P1}..{P11}` slots (bound at
  deal time) or an explicit room reference.
* `measures` carry `metric:<MetricKey>` first — that is what the engine reads.
* `selectFromBank(n, opts)` is deterministic per seed, never repeats a template
  inside a night, and never puts two prompts of the same kind + metric back to
  back when the pool can avoid it.
* The floor the brief asks for is 150; the bank has 200. A real night does not play the bank; Ollama writes every line.

## The local lane (Ollama)

```
GEN_BASE        http://127.0.0.1:11434
GEN_MODEL       dolphin-mistral
GEN_TIMEOUT_MS  120000
```

The model gets ONE job: write the night's questions and dares from role plans.
A production request sends **no real names** — only `{P1}` slots and the role
brief. The model writes original lines; `restoreNames` is still used for the
legacy rephrase path, but the generated night binds its slots at deal time and
never needs names in the request.

A candidate is dropped when it is:

| reason | means |
|---|---|
| `not-in-room` | a slot is missing, out of range, or the line names nobody |
| `tame` | no adult heat (sex, desire, cheating, secrets, lies, risk, bodies); a dare must clear a stricter filthy-or-risky bar |
| `repeat` | says the same thing as a line already accepted |
| `too-long` | over `MAX_PROMPT_CHARS` (160) |
| `refusal` | empty, "as an AI", or commentary instead of a question |

Every role has an exact slot contract: subject/solo/best-couple use no slots;
a dare uses only `{P1}`; pair roles use exactly `{P1}` and `{P2}`; an
observer-subject question may use extra slots because the deal binds the whole
roster. A stray brace, a third pair slot or a half-written slot is refused, so
a phone never shows a raw placeholder. Look-chain copy must carry `{A}` in the
announcement and guess, no other braces, start the act with "Look at", and be
original; there is no code-written fallback announcement.

The run is role-planned, three calls at a time, and stops at
`GEN_SAFETY_CAP_MS` (180 s). It prints one line per plan to the host terminal:

```
Ollama: subject asked 12, accepted 11, dropped 0 (none)
```

A short batch is retried once for the missing lines. If the night is still short,
`generateNight` reports `error`, `PromptProvider.generate()` throws
`GenerationError`, and the room stays in the lobby with the error on the host
screen. Nothing is filled from the bank. `GEN_TARGET_PROMPTS` (40) is the
loading-screen target; the real count depends on room size.

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
`MAX_PROVIDER_CALLS_PER_NIGHT` (24), with slots `generate 20 / reveal 1`. A
missing key returns `no-key` and the network is never touched; a timeout, a 429
or garbage returns a reason. A short generation batch retries once, then the
room refuses to start rather than filling from the bank.

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

await provider.generate();                // throws if Ollama is short/down
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
