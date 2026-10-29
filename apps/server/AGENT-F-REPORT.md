# Agent F report — server

## Files created

- `apps/server/package.json`, `package-lock.json`, `tsconfig.json`
- `apps/server/src/index.ts`, `server.ts`, `game.ts`, `services.ts`
- `apps/server/test/full-game.test.ts`, `protocol.test.ts`, `server.test.ts`, `services.test.ts`
- `apps/server/README.md` and this report
- `NOTES/contract-requests.md` (the extracted archive used the different name
  `NOTES/contract - requests.md`; the canonical requested path did not exist)

The archive was extracted without overwriting existing files. Both frozen
`packages/shared` source files still match the archive byte-for-byte.

## How to run

```sh
npm install --prefix apps/server
npm run --prefix apps/server start
```

Defaults to `0.0.0.0:3001`. The terminal prints all non-loopback IPv4 URLs and
a QR code. It serves `apps/web/out/` when available and otherwise a plain
placeholder. `apps/server/README.md` documents environment loading, service
injection, storage, and the safety boundary. No keys are needed.

## Tests and output

- `npm run --prefix apps/server typecheck`: **passed**, strict `tsc --noEmit`.
- `env -u XAI_API_KEY -u GEMINI_API_KEY npm run --prefix apps/server test`:
  **12 passed, 0 failed**. Includes a five-real-socket, 61-record full night,
  all nine kinds, pair selection and spectator restrictions; identical
  public finales; secrets only on their two selected owners, no deck for an
  opted-out player; replay-resistant rotated reconnect and post-finale deck
  replay; idempotency and invalid targets; consent/cap/host-only actions;
  deadline + grace, majority heat-down, pass reasons and custom prompts;
  real production bot delays; stalled providers and timeouts; deletion during
  pending narration; LAN banner/QR, static fallback and preview-origin tests;
  deterministic fallback arithmetic and privacy.
- `./apps/server/node_modules/.bin/tsx scripts/selfcheck.ts`:
  **ALL 31 CHECKS PASSED**.
- Started with both keys unset: banner printed `http://localhost:3001` and
  `http://169.254.0.21:3001`, QR rendered; HTTP returned 200 on both sandbox
  addresses. This is a sandbox link-local interface, not a real-phone test.

## Contract requests

Appended eight `AGENT-F` requests in `NOTES/contract-requests.md`: the required
server/test dependencies; shared service APIs; reconnect transient/target
metadata; 5 KB finale and Unicode reveal limitations; a privacy-safe narrator
boundary; a room-scoped provider budget; and a shared custom-prompt safety
filter. `qrcode-terminal` itself is explicitly authorized in Agent F's scope.

## Known gaps for Agent Z

1. The default server uses an intentionally small local bank and conservative
   deterministic scoring/narration fallbacks. Wire `GameServices` to the
   finished Agent C/D/E packages for the complete bank, scoring, narration,
   optional Grok/Gemini lanes and the cross-lane per-room call budget. Setting
   API keys alone does not activate those lanes in this standalone build.
2. Public narration intentionally receives no secret decks/private claims;
   private card text remains engine-written. Any integration that polishes
   secret copy must preserve this public/private boundary.
3. The local host-prompt guard is conservative and not a complete semantic
   safety filter. Wire Agent D's validated shared filter before deployment.
4. `RoomView` cannot express all transient screens or rating/IOS targets;
   reconnect event re-emission is a workaround. Worst-case UTF-8 reveals or
   finales can exceed 5 KB; no answers are silently discarded.
5. The exported web app and root host script are outside Agent F's scope and
   were not present. No real phone, LAN QR scan, or full merged-stack test was
   available. In-memory rooms are not restored after a server restart.
