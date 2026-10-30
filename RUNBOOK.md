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

## Verified no-key smoke game

```sh
npm ci
npm run smoke:verified
```

This command starts its **own isolated local server** with the production
adapters, keys disabled, an ephemeral port and a temporary data directory. It
runs five external Socket.IO players through a full game, reconnects and deletes
the room. A local test-only oracle independently records expected engine decks,
actual outgoing socket recipients, persisted submission counts, dare passes,
and joker weights. It is never exposed through HTTP or game events and is
removed after the run. Do not use this harness against a real game or commit
its temporary data.

Check the checker (expected: the underlying smoke fails with
`secret frame delivered to a non-owner`):

```sh
SMOKE_INJECT_LEAK=1 npm run smoke:verified
```

The deliberate leak exists only in this local test harness, not in the
production server. A generic `npm run smoke` against an independently started
server still requires a separately supplied private `SMOKE_ORACLE` file; the
public wire alone cannot establish ownership or persistence. The verified
harness is the recommended repeatable command.

## Additional checks

```sh
npm run selfcheck
npm run typecheck
npm test --workspace apps/server
npm run test:transport --workspace apps/web
npm run test:components
npm run test:mock --workspace apps/web
npm audit --omit=dev
# After npm run build and npm start in another terminal:
node scripts/jsdom-export-smoke.mjs
```

The jsdom test exercises the exported bundle and creates and deletes a test
room. It is not a browser, phone, or LAN test. Test on actual iOS and Android
devices and the target desktop browsers before game night. See
`MERGE-REPORT.md` for known gaps, test results and bundle measurement.
