# Reveal — server

The server owns room state, scoring, timers, persistence, token rotation and
Socket.IO fan-out. It listens on `0.0.0.0:3001` and serves the exported web
client from `apps/web/out` when present. Install at the repository root and
follow the root `RUNBOOK.md` for game-night setup and configuration.

```sh
npm ci
npm run build
npm run start             # start the previously built game
npm test --workspace apps/server
```

No API keys are required. The startup banner prints localhost, every non-loopback
IPv4 address and a QR code. Phones need the same LAN/hotspot and a firewall
that allows the selected port. `HOST` and `PORT` override the defaults; the
root host launcher loads `.env`.

Accepted responses are appended to per-room JSONL files under `apps/server/data/`
(mode `0600`). Live room state, session tokens and private decks are memory-only;
restarting the server does not restore them. Programmatic callers can isolate
logs via `createGameServer({ dataDir })`. Any player can delete a room. The
hourly sweep removes rooms idle for 24 hours and all rooms after 48 hours,
including recognized orphan logs after restart. Access checks also prevent
expired rooms from being revived before the sweep.

## Integration and fallbacks

`RoomManager` uses `src/integratedServices.ts` by default: prompts, scoring,
digests, private decks and narration are connected to the workspace packages.
`src/services.ts` retains conservative injectable fallback implementations for
provider failure, defensive error handling and tests. It is not the default
production scoring pipeline. The older `src/integrated-services.ts` injectable
adapter is retained for compatibility and synthetic provider tests; production
uses `src/integratedServices.ts`. `createGameServer({ services })` remains the
injectable test seam; each room has its own prompt provider. Lobby preparation
runs in the background and `forPhase()` returns already-available prompts.
Transient reveal, interlude and finale events are re-emitted on reconnect.

With no `GEMINI_API_KEY`, bank prompts and deterministic local copy make the
game playable without cloud calls. Generation independently tries a local Ollama
(`GEN_BASE`, default `http://127.0.0.1:11434`; `GEN_MODEL`, default
`dolphin-mistral`) without a key. Provider failure leaves bank prompts available.
See the root `RUNBOOK.md` for laptop setup. Each room shares a
physical HTTP-attempt budget across prompt generation and narration; retries
count and deleting a room aborts pending calls. Narration receives pseudonymous,
public-only material, never secret decks or private debriefs. Provider output is
validated and falls back to deterministic copy when rejected.

Prompt generation starts in the lobby, before answers exist. During play a local
callback adds a clearly marked verbatim excerpt from an earlier public text
answer to one eligible non-host prompt per later phase. It skips the callback
when there is no suitable answer, or it would exceed the prompt length limit;
private debriefs are never candidates, and authored spotlight/verdict prompts
remain unchanged. Warmup includes a text round, and the same neutral tap-war
bank prompt appears in the deep phase.

When a Gemini key is present, pseudonymized public text can be tagged once in
the background during debrief. A completed positive tag may supply a bounded
style hint to narration; numeric scores and claims always use deterministic
local tags, regardless of provider output or timing. Spotlight cover answers
are not classified; their already-revealed punchlines may appear in the public
digest. Private debriefs are never sent to a provider and use local similarity only. Reconnect rotation supports a
nonce-bound retry across a dropped acknowledgement for updated clients; older
clients retain same-socket recovery.
See `NOTES/contract-requests.md` for frozen-contract gaps, including worst-case
reveal/finale payloads that can exceed 5 KB without a chunking interface, and
`RUNBOOK.md` for the independent smoke-oracle requirements.

Server tests cover real five-client play, private-deck ownership, reconnects,
authorization, timers, retention and deletion, as well as synthetic provider
requests and cancellation.
