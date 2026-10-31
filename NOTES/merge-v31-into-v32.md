# Merging `origin/main` (v3.1) into the v3.2 rebuild

Owner's ruling on how this merge was to be done: **additive** — keep main's files
and tests, append ours, never resolve 60 conflicts by taking our side wholesale
and letting main's work vanish. That ruling is what produced this merge; this file
is its ledger.

State at the merge: main had **44 commits and 108 files** changed since our common
base `483121a`; we had **8 commits and 142 files**; **65 files** were changed on
both sides and **62 of those conflicted** — 38 both-modified, 24 deleted-here but
modified-there.

## The rule applied per class of file

1. **The spine (contracts, engine, prompts, server, transports, screens).** v3.2's
   shape wins. This is not a preference: the two lines disagree about what a round
   *is* (phases and a heat score versus 12 cases of 7 segment shapes), so a file
   cannot hold both. Main's version of every such file is retrievable from the
   merge commit — `git show origin/main:<path>` — and the parts that were rewritten
   rather than merely edited are also copied into `legacy/v3.1/`.
2. **Data (the prompt banks).** Same story in JSON: main's 116 entries use v3.1
   kinds (`confess`, `ios`, `shout`, `minigame`, `debrief`, `pair_dare`) and free-text
   `measures`, which the v3.2 metric registry cannot digest. All five bank files are
   preserved verbatim in `legacy/v3.1/packages/prompts/src/bank/`; the live bank is
   the 194 hand-written v3.2 entries.
3. **Files v3.2 deleted on purpose** (`filter.ts`, `director.ts`, the demo answer
   shim, the per-round screens, the old server suite): the deletion stands, and
   main's updated version is kept under `legacy/v3.1/` rather than dropped.
4. **Files only main added** (29 of them): each one was asked a single question —
   *does it run against the v3.2 tree as it stands?* Those that do are kept live
   and are in the suite. The rest are archived verbatim at their own path under
   `legacy/v3.1/`, which is excluded from every tsconfig and every test glob.

## Ported and running, not archived

| file | why it needed nothing |
|---|---|
| `lib/aliases.ts` | pure string policy, no v3.1 imports |
| `apps/server/test/r22-aliases.test.ts` | `derivePseudonyms` / `scrubAliases` / `swapPseudonyms` all exist in v3.2's `roster.ts`; only its `Results` fixture moved (`claims: []` → `verdicts: []`) |
| `apps/server/test/r23-lan.test.ts` | `server.ts` already exports `lanAddresses` / `selectLanAddress` / `bootBanner` |
| `apps/web/scripts/jsdom.d.ts`, `scripts/gen-voice-probe.mjs`, `NOTES/agent-g-local-generation.md` | ambient types, an offline probe, a report |

Keeping those two test files live paid for itself immediately: they were failing
against our code, and both failures were real bugs on our side.

- `packages/prompts/src/provider.ts` carried its own alias matcher with a
  **2-character** floor while every other recode in the game used the shared
  **3-character** policy — so a two-letter alias was scrubbed on the way to Gemini
  and left alone everywhere else. The private matcher is gone; `lib/aliases.ts` is
  now the one policy the whole server uses.
- `lanAddresses` sorted addresses as **strings** and filtered only `internal` and
  `127.*`. On a laptop that printed `http://169.254.x.x:3001` — a link-local
  address, unreachable by definition — as a join URL, and buried `192.168.*` under
  `10.*` lexicographically. It now drops link-local, ranks private ranges first
  (`192.168` → `10` → `172.16–31` → other) and ties numerically;
  `selectLanAddress` (the QR) keeps the interface-name penalty in front of the same
  ranking, so the banner and the code agree.

## Unwired

`apps/web/package.json` and the root `package.json` inherited main's run targets —
`test:display`, `test:authoritative`, a `confess.tsx` step in `test:regressions`,
`r24-session.test.ts` in `test:transport`, and `measure:sparks`. Their files are in
`legacy/v3.1/`, so those targets were removed rather than left as commands that
fail. Two blocks main added to `apps/web/src/components/__tests__/run.tsx` (the
v3.1 `ReadyScreen`, the `DemoPanel` demo console) are archived to
`legacy/v3.1/apps/web/src/components/__tests__/ready-and-demo-blocks.tsx`; v3.2's
single end-of-night `ReadyGate` is covered in the phone-layout block above them.

`scripts/check-bundle.mjs` measures the phone bundle and the laptop bundle against
the routes v3.2 actually ships: `/page` and `/host/page` (there is no `/display`
route). This closes the check that had been red on this branch since the rebuild.
The phone ceiling is untouched at 150 KiB (145.4 today). main's 120 KiB on the
laptop was deleted rather than loosened (owner's call): that number was paid for by
a `/display/page` that rendered the reel and nothing else, and v3.2's laptop page
also carries the room controls and the join QR — so holding it to a viewer's budget
would only ever measure the wrong page. The laptop size is still computed and
printed on every run (`laptop=167.7 KiB gzip (measured, no ceiling)`), and the
assertion that keeps the phone route light — `RoomApp` stays lazily imported, which
moves both numbers if it regresses — is untouched. Should v3.2 ever ship its own lean
`/display` route, that route is what deserves a ceiling.

`RUNBOOK.md` keeps main's three added sections with a `v3.1 lane, parked` banner
on each; `packages/engine/README.md` no longer describes a `spark` secret the v3.2
engine cannot produce; `apps/server/README.md` and the runbook's Ollama setup now
name the endpoints and defaults this code actually uses (native `/api/chat`,
`/v1/chat/completions` fallback, no `XAI_MODEL`).

## After the merge commit: the silent deletions too

The merge only ever *asks* about a file both sides touched. 29 more paths existed
on main's tip and not on ours — v3.2 deleted them (the accounts lane, `DemoPanel`,
`ReadyScreen`, `screens/`, `engine/src/live.ts` + `matching.ts`, the live bank
directory, shared test helpers) and main had never edited them, so git resolved the
deletion without a conflict anyone could have reconsidered. They are archived the
same way, out of the same reason. `legacy/v3.1/` is now 84 files and 14,233 lines,
and this is mechanically true:

```sh
# every path main's tip carries is live in the app or readable under legacy/v3.1/
comm -23 <(git ls-tree -r --name-only origin/main | sort) \
         <(git ls-tree -r --name-only HEAD | sort) | while read f; do
  [ -f "legacy/v3.1/$f" ] || echo "MISSING $f"; done   # -> no output
```

## Ledger

## archived verbatim under legacy/v3.1/ (23)
- apps/server/src/confessReveal.ts
- apps/server/src/safe-callback.ts
- apps/server/src/schedule.ts
- apps/server/test/confess-rounds.test.ts
- apps/server/test/night-pacing.test.ts
- apps/server/test/r21-reveal.test.ts
- apps/server/test/reveal-mode.test.ts
- apps/server/test/safe-callback.test.ts
- apps/web/scripts/r24-session.test.ts
- apps/web/scripts/r26-authoritative.test.ts
- apps/web/src/app/display/FinaleTheatre.tsx
- apps/web/src/app/display/queuedReveals.ts
- apps/web/src/components/ConfessReveal.tsx
- apps/web/src/components/__tests__/confess.tsx
- apps/web/src/components/__tests__/display-theatre-integration.tsx
- apps/web/src/components/__tests__/display-theatre.tsx
- packages/engine/src/confess.ts
- packages/engine/test/confess.test.ts
- packages/engine/test/r27-spark.test.ts
- packages/engine/test/self-picks.test.ts
- packages/prompts/test/confess.test.ts
- packages/prompts/test/local-http.test.ts
- scripts/spark-incidence.ts

## bank data: v3.2 bank is live, main's file archived verbatim (6)
- packages/prompts/src/bank/dare.json
- packages/prompts/src/bank/deep.json
- packages/prompts/src/bank/index.ts
- packages/prompts/src/bank/spicy.json
- packages/prompts/src/bank/unhinged.json
- packages/prompts/src/bank/warmup.json

## deleted here, updated on main - the v3.2 deletion stands (24)
- apps/server/src/integrated-services.ts
- apps/server/test/accounts.test.ts
- apps/server/test/demo-mode.test.ts
- apps/server/test/director.test.ts
- apps/server/test/full-game.test.ts
- apps/server/test/integrated-services.test.ts
- apps/server/test/integration-audit.test.ts
- apps/server/test/live-moments.test.ts
- apps/server/test/protocol.test.ts
- apps/server/test/provider-integration.test.ts
- apps/server/test/pseudonyms.test.ts
- apps/server/test/ready-gate.test.ts
- apps/web/src/app/display/page.tsx
- apps/web/src/lib/demoAnswer.ts
- apps/web/src/screens/PromptScreen.tsx
- apps/web/src/screens/RevealScreen.tsx
- packages/engine/src/director.ts
- packages/engine/test/contracts.test.ts
- packages/engine/test/director.test.ts
- packages/narrator/test/write.test.ts
- packages/prompts/src/filter.ts
- packages/prompts/test/analyze.test.ts
- packages/prompts/test/generate.test.ts
- packages/prompts/test/provider.test.ts

## docs: v3.2 README is the live one (2)
- README.md
- packages/prompts/README.md

## main's bank content saved under legacy/v3.1/ (6)
- packages/prompts/src/bank/dare.json
- packages/prompts/src/bank/deep.json
- packages/prompts/src/bank/index.ts
- packages/prompts/src/bank/spicy.json
- packages/prompts/src/bank/unhinged.json
- packages/prompts/src/bank/warmup.json

## main's version of a file we deleted saved under legacy/v3.1/ (24)
- apps/server/src/integrated-services.ts
- apps/server/test/accounts.test.ts
- apps/server/test/demo-mode.test.ts
- apps/server/test/director.test.ts
- apps/server/test/full-game.test.ts
- apps/server/test/integrated-services.test.ts
- apps/server/test/integration-audit.test.ts
- apps/server/test/live-moments.test.ts
- apps/server/test/protocol.test.ts
- apps/server/test/provider-integration.test.ts
- apps/server/test/pseudonyms.test.ts
- apps/server/test/ready-gate.test.ts
- apps/web/src/app/display/page.tsx
- apps/web/src/lib/demoAnswer.ts
- apps/web/src/screens/PromptScreen.tsx
- apps/web/src/screens/RevealScreen.tsx
- packages/engine/src/director.ts
- packages/engine/test/contracts.test.ts
- packages/engine/test/director.test.ts
- packages/narrator/test/write.test.ts
- packages/prompts/src/filter.ts
- packages/prompts/test/analyze.test.ts
- packages/prompts/test/generate.test.ts
- packages/prompts/test/provider.test.ts

## ported: kept live and running (6)
- NOTES/agent-g-local-generation.md - a report, not code
- apps/server/test/r22-aliases.test.ts - derivePseudonyms/scrubAliases/swapPseudonyms live in v3.2 roster.ts
- apps/server/test/r23-lan.test.ts - server.ts already exports lanAddresses/selectLanAddress/bootBanner
- apps/web/scripts/jsdom.d.ts - ambient types the web tests need
- lib/aliases.ts - pure alias helpers, no v3.1 imports
- scripts/gen-voice-probe.mjs - offline voice probe, no engine imports

## spine: v3.2 shape wins, main's version archived where it is a rewrite (30)
- .env.example
- apps/server/src/game.ts
- apps/server/src/index.ts
- apps/server/src/server.ts
- apps/server/src/services.ts
- apps/server/test/server.test.ts
- apps/web/scripts/mock-flow.test.ts
- apps/web/scripts/ssr-smoke.test.ts
- apps/web/src/components/LobbyScreen.tsx
- apps/web/src/components/__tests__/regressions.tsx
- apps/web/src/lib/mockTransport.ts
- apps/web/src/lib/socketTransport.ts
- apps/web/src/lib/useRoom.ts
- packages/engine/src/digest.ts
- packages/engine/src/index.ts
- packages/engine/src/internal.ts
- packages/engine/src/results.ts
- packages/engine/src/secrets.ts
- packages/engine/src/signals.ts
- packages/engine/test/engine.test.ts
- packages/engine/test/fixtures.ts
- packages/prompts/src/facade.ts
- packages/prompts/src/generate.ts
- packages/prompts/src/index.ts
- packages/prompts/src/provider.ts
- packages/prompts/test/bank.test.ts
- packages/shared/src/contracts.ts
- packages/shared/src/validate.ts
- scripts/bots.ts
- scripts/selfcheck.ts
