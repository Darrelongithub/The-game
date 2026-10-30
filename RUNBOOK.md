# Runbook

This is a private 18+ game. Everyone must consent. Commands below run from the
repository root, with Node 20+ and npm installed. The web and server workspaces
must have been integrated first; the build kit alone is not a running game.

## Game night: same WiFi / hotspot

```sh
npm install
npm run host
```

Scan the QR code printed by the server on each phone (or open the printed LAN
URL). All devices must be on the same WiFi or on the host phone's hotspot. If
that does not work, check the firewall, WiFi client isolation and that `HOST`
is not restricted to localhost. Stop the host with Ctrl+C. The command builds
`apps/web/out/` and serves it from the game server's origin on port 3001.

No `.env` is required. With neither API key set, the finished game uses the
bank and templates without internet after installation. Prompt generation also
tries local Ollama, with no key required. Optional settings:

```sh
cp .env.example .env
# Edit .env only if desired; HOST, PORT, GEN_BASE, GEN_MODEL and cloud keys are optional.
```

Already-set environment variables take precedence over `.env`. Never commit or
share `.env`, room logs, session secrets or API keys.

## Local prompt generation (host laptop)

1. Install Ollama on the **same laptop** as the Node game server and start the
   Ollama service (normally bound to localhost port 11434).
2. Download the model once: `ollama pull dolphin-mistral`.
3. Leave the defaults in `.env`, or set:
   ```sh
   GEN_BASE=http://localhost:11434/v1
   GEN_MODEL=dolphin-mistral
   ```
4. Optional service check from the laptop: `curl http://localhost:11434/v1/models`.
   Then run `npm run host` normally. After changing `.env`, restart the host.

`GEN_MODEL` wins over the dormant legacy `XAI_MODEL` override. Generation uses
OpenAI-compatible `/chat/completions` without an Authorization header. It does
not use xAI, Google, an API key, or a cloud account. Existing cloud analysis and
reveal settings are independent and unchanged.

Do **not** expose Ollama to the LAN or put its URL in browser code: players'
phones talk only to the game server on port 3001. `localhost` here means the
server laptop. If the server is containerized, localhost is the container, so
configure `GEN_BASE` to a host-reachable address instead.

If Ollama is stopped, the model is missing, a request times out, or returned
prompts fail validation, bank prompts keep the game running. Generation remains
background-only with the existing eight-second request deadline; a slow laptop
may therefore use mostly bank prompts. No successful generation is required to
start or finish a night. Download dependencies and the model before going offline.

## Solo test

```sh
npm run host
```

Open the printed URL on the host's phone or computer, create a room, then use
**add bot** in the lobby three times (the `add_bot` action). Start the game.
These are server bots; they are separate from the external smoke-test bots.

### Demo room (the whole game on one laptop)

Tick **Demo room** on the Create tab. The room says `demo: true` and the host
puppets every other seat:

- **Add seat** creates a demo player (auto by default) — the room starts with
  two seats instead of the usual four.
- **Auto** seats answer and ready themselves. **Manual** seats wait for you;
  during a round tap **Answer this round for …** in the **Demo** panel.
- **Everyone's ready** releases a pending reveal without waiting out the grace.
- **Night speed** rescales every timer (0.1× is a fast rehearsal, 1× is the
  real clock). It applies to rounds scheduled after the change.

The engine cannot tell a demo night from a real one: puppet answers are ordinary
log records plus `impersonatedBy` metadata that nothing scores, so a rehearsal
produces the same claims and finale as the same answers from real phones. Demo
controls are refused outside a demo room and by anyone who is not the host.

### Rehearsal smoke test

```sh
npm run host          # in one terminal
npm run smoke:demo    # in another: plays a whole night alone at 0.1x speed
```

`scripts/demo-smoke.ts` creates a real demo room on the running server,
puppets three seats, walks the entire game, and asserts the ready gate, the
broadcast-safe finale and that no internal material (hypotheses, the director,
the impersonation metadata) ever reaches a client.

## Reveals wait for everyone

Every round's reveal is **pending** until each connected player taps **I'm
ready** — a phone in a pocket or a reconnecting tab never misses the moment.
The room shows who is still looking up; after `REVEAL_READY_GRACE_MS` (20s) the
reveal fires anyway so one AFK phone cannot stall the night. The host's **Skip
round** releases a pending reveal immediately.

## Remote friends

On Render, Railway or Fly use Node 20+, and configure:

```sh
npm install
npm run build
npm start
```

Use the platform's public HTTPS URL instead of a LAN address; bind to
`0.0.0.0` and respect the platform-provided `PORT`. Keep the service private or
otherwise restrict access to your invited adult group. For habitual play the
spec recommends Vultr Johannesburg (listed as $6/month in the kit; verify
current pricing and availability). Do not use Supabase realtime: the kit notes
that it has no Africa region. Remote deployment requires internet; the
no-keys/offline guarantee applies to a local LAN after installation.

## Accounts (optional — guest play is unchanged)

Accounts are **optional**. A room full of guests plays exactly the same game; an
account never gates a room, a round, a score or a claim.

- **Create:** username (3–16 chars, letters/numbers/underscore, case-insensitive
  unique) + a 4–6 digit PIN. The server shows a **one-time recovery code**.
  Write it down when you see it: **there is no email and no reset link** — that
  code is the only way back into the account. It rotates every time it is used.
- **Sign in:** username + PIN. Sessions are opaque tokens kept in the browser's
  `localStorage`; the server stores only scrypt hashes and hashed token seeds.
  Repeated wrong PINs lock the door for a few minutes.
- **Lost the PIN:** `recover` with the recovery code.
- **Delete:** the in-app delete-account action (`DELETE /api/account`, which
  requires an explicit confirmation) hard-wipes the identity, its night links and
  any carried-over suspicions. There is nothing left to restore.
- **Retention:** identity lives in `apps/server/data/accounts.json` (mode 0600)
  and is deliberately **not** touched by the 48-hour room purge — rooms are
  data, accounts are identity. Back up that file if you care about the accounts;
  delete it to wipe every account at once.
- Accounts never require a network: the whole API is served by the game server
  on the same origin.

## Logs, deletion and retention

Server room logs are specified as JSONL files under `apps/server/data/`; server
output goes to the host terminal, or to your hosting provider's process logs.
Treat logs as sensitive. Any player can use the in-game delete-room action
(`delete_room` socket event) for immediate room deletion. The specification also
requires a 48-hour hard purge and 24-hour idle-room expiry; verify these on the
integrated server before relying on them. Stopping the process alone is not a
substitute for deleting room logs.

## Verified no-key smoke game

The following independent in-process oracle exercises the actual production
adapter, using synthetic players, no API keys, a temporary data directory and
no public debug endpoint:

```sh
npm run smoke:verified
```

This command starts its **own isolated local server** with the production
adapters, keys disabled, an ephemeral port and a temporary data directory. It
runs five external Socket.IO players through a full game — including the
spotlight and verdict live moments (the bots wait out each verdict's 90-second
debate) — reconnects and deletes the room. It takes several minutes by design. A local test-only oracle independently records expected engine decks,
actual outgoing socket recipients, persisted submission counts, dare passes,
and joker weights. It is never exposed through HTTP or game events and is
removed after the run. Do not use this harness against a real game or commit
its temporary data.

To verify that the oracle catches a deliberately misdelivered secret frame, run
`SMOKE_INJECT_LEAK=1 npm run smoke:verified`; the underlying smoke must fail.
The injection is confined to that test harness. For a quicker synthetic check,
`SMOKE_FAST=1` shortens spotlight and verdict timers only in the two isolated
harnesses; it leaves the assertions unchanged and does not test production
90-second debate timing. `MERGE-REPORT.md` is the historical QA report for the
earlier integration; real device and LAN testing is still required before a
game night.

## External smoke bots

For a second self-contained, synthetic local smoke test with no provider keys, run:

```sh
npm run smoke:oracle
```

This starts an isolated server on a loopback port with a private temporary data
folder, runs the unchanged five-player smoke test with an independent server-side
oracle, and removes the files afterward. Do not use this fixture with real players.

## Round list (what a night actually runs)

Each heat phase opens with its normal rounds and closes with its live moments:

| phase | rounds | live moments |
|---|---|---|
| warmup | 3 questions (pick / shout / text …) | 1 spotlight |
| spicy | 3 questions (pick / rating / ios …) | 1 spotlight, 1 verdict |
| deep | 3 questions (text / minigame / pick …) | 1 spotlight, 1 verdict |
| dare | 2 dares + the pair dare | 1 spotlight, 1 verdict |
| debrief | 2 private pair texts (onlyPlayers) | — |

**spotlight (25s):** one player is watched; everyone else captions them in ≤80
characters. The subject's own phone shows a decoy question or an idle screen and
never the real prompt. The reveal is a caption wall that ends on the subject's
own decoy answer (~8s).

**verdict (105s):** the room argues for 90 seconds with phones face-down, then
everyone secretly picks at the same time (15s, self excluded). The reveal is a
Group Announcement — anonymous vote bars, count-up, then the answer lands
(~6s). Couple-coded verdicts get confetti.

Expect a full night to take noticeably longer than the question-only game:
verdicts alone add ~90s of real debate each, and the external smoke now allows
seven minutes (`SMOKE_TIMEOUT_MS`).

## Target a separately started server

To target a separately started server, first run `npm run host` or `npm start`
and then supply a suitable private oracle as described below. The default is
five external Socket.IO players at `http://localhost:3001`; for a different
server/count/timeout:

```sh
SMOKE_URL=http://localhost:3001 SMOKE_BOTS=5 SMOKE_TIMEOUT_MS=480000 npm run smoke
```

The test creates and deletes a real room, exercises rounds and resume, and
fails on any failed assertion. To pass, it also requires an **independent,
local-only test oracle** produced by the integrated server/test harness:

```sh
SMOKE_ORACLE=/absolute/path/to/private-oracle.json npm run smoke
```

The frozen public socket contract cannot establish which player's private deck
was intended for a frame, whether a duplicate actually persisted twice, or the
joker's scoring weight. The `smoke:oracle` fixture captures these facts from
server room state, persisted log entries, recipient emissions and the engine's
scoring helper. A separately started server needs its own equivalent oracle.
Do not serve it over HTTP, expose it to game clients, or commit it. It must
reflect independently captured server-side facts for the *current* smoke room,
not facts reconstructed from the bots' received messages. Write it atomically
once the finale is ready, and update it after a finale reconnect.
The smoke test expects this JSON shape:

```json
{
  "roomCode": "AB2C",
  "decks": { "player-id": { "cards": [] }, "player-without-deck": null },
  "secretFrames": [{ "recipient": "player-id", "owner": "player-id", "deck": { "cards": [] } }],
  "submissions": [{ "roundId": "round-id", "playerId": "player-id", "clientUuid": "uuid", "count": 1 }],
  "darePasses": [{ "playerId": "dodger-id", "reason": "My mother is watching." }],
  "joker": { "playerId": "joker-id", "target": "target-id", "pickRounds": 3, "sameTargetPicks": 3, "negativeNominations": 1, "nominationWeight": 0.5, "victimToxicConfidence": null }
}
```

Use actual generated IDs, the complete expected deck for every player (or
`null` for no deck), and actual per-delivery frames in order, including after
reconnect. A non-null deck must contain at least one real card. `count` is the
number actually persisted for the specified UUID. The trace must identify the
actual recipient and intended owner at emission, including unintended
broadcast recipients. The joker weight, negative nomination count and victim toxic-claim confidence
must be actual engine results, not assumptions. At least one negative nomination
is required to exercise the guard. Without this oracle the test deliberately fails rather than
claiming to have proved privacy or idempotence.
