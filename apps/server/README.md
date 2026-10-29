# Agent F: game server

Node 20+; Express and Socket.IO v4. The default host is `0.0.0.0:3001`.
The server serves `apps/web/out/` and the Socket.IO endpoint from the same
origin. If the export is not present yet, `/` shows a build note instead.

## Run independently (before the other agents are merged)

From the repository root:

```sh
npm install --prefix apps/server
npm run --prefix apps/server typecheck
npm run --prefix apps/server test
npm run --prefix apps/server start
```

No API keys are needed. The banner prints localhost, **every** non-loopback
IPv4 LAN URL and a terminal QR for the first LAN address. Phones must be on the
same LAN/hotspot and the host firewall must allow the selected port. Set
`HOST`/`PORT` in the environment if necessary. Agent G's root `host.mjs` will
load `.env`; when launching this TypeScript entry directly with a root `.env`:

```sh
cd apps/server
node --env-file=../../.env --import tsx src/index.ts
```

The standalone server has a small local bank and conservative deterministic
results/digest/secrets/template narration. They are **integration fallbacks**,
not a substitute for Agent C's complete scoring and Agent D's full prompt bank.
The standalone fallback deliberately does not make network/API calls, even if a
key happens to be set. An unfinished web export is not a playable UI.

## Integration contract for Agent Z

`createGameServer({ services })` accepts the `GameServices` interface in
`src/services.ts`. Inject the finished prompt, engine and narrator packages
here; nothing imports an unfinished agent's files. Each room gets its own
`createPromptProvider()` instance. `prepare()` is started once in the lobby at
four players, without blocking play; `forPhase()` must return an already
available bank synchronously. Its second argument is the requested maximum
number of prompts (not the player count), so adapt another provider's signature
if needed. Provider failure and narration timeout use the local fallback.
Share a room-scoped provider-call budget across the agents' optional lanes.

All scoring/digest/narration inputs use pseudonymized room metadata and text;
real aliases are restored only for client-facing display. Debriefs are used by
scoring but excluded from public digest/reveals. For a strong isolation
boundary, public `buildSkeleton`/`writeFinale` see only public claims, a digest
without private debriefs or blind spots, and an **empty** secret-deck map.
Private cards retain the deterministic engine copy. Do not pass private decks
to a model that can produce public slides without a separately enforceable
privacy boundary. `finale` contains only public material and is the same for all
sockets; `secrets` is emitted individually to the current authenticated socket
for each opted-in owner, including on resume.

A majority cooling vote moves to the immediately preceding heat phase; ordinary
phase progression can resume one level at a time afterward. For transient
reveal/interlude/finale reconnects the server re-emits the corresponding event
with the remaining hold time after the full `RoomView` snapshot.

## Storage and retention

Accepted responses are appended as individual `LogRecord` lines under
`apps/server/data/`, created with file mode `0600`. Private decks and session
secrets are memory-only and never written to those files. Any joined player can
send `delete_room`; the server deletes the file, clears private memory, and
notifies the room. The hourly sweep removes idle rooms after 24 hours and all
rooms after 48 hours, including recognized orphan logs after a restart. Restart
does not restore live room state. The frozen contract currently cannot express
chunking: a worst-case 11-player Unicode reveal/finale can exceed 5 KB. See
`NOTES/contract-requests.md` rather than silently losing answers.

Tests include an actual five-client scripted Socket.IO game, ownership and
reconnect isolation, timers and grace, heat voting, host authorization, bots,
LAN/QR output, static export/preview-origin handling, malformed answers, and
retention/deletion (including while narration is pending).
