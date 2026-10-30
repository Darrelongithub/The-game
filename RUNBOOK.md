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
bank and templates without internet after installation. Optional settings:

```sh
cp .env.example .env
# Edit .env only if desired; HOST, PORT, XAI_API_KEY and GEMINI_API_KEY are optional.
```

Already-set environment variables take precedence over `.env`. Never commit or
share `.env`, room logs, session secrets or API keys.

## Solo test

```sh
npm run host
```

Open the printed URL on the host's phone or computer, create a room, then use
**add bot** in the lobby three times (the `add_bot` action). Start the game.
These are server bots; they are separate from the external smoke-test bots.

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

## Logs, deletion and retention

Server room logs are specified as JSONL files under `apps/server/data/`; server
output goes to the host terminal, or to your hosting provider's process logs.
Treat logs as sensitive. Any player can use the in-game delete-room action
(`delete_room` socket event) for immediate room deletion. The specification also
requires a 48-hour hard purge and 24-hour idle-room expiry; verify these on the
integrated server before relying on them. Stopping the process alone is not a
substitute for deleting room logs.

## External smoke bots

For a self-contained, synthetic local smoke test with no provider keys, run:

```sh
npm run smoke:oracle
```

This starts an isolated server on a loopback port with a private temporary data
folder, runs the unchanged five-player smoke test with an independent server-side
oracle, and removes the files afterward. Do not use this fixture with real players.

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
