# AGENT R — ROUND 5 report

Branch: `arena/b866c916-the-game`
Scope: R21, R22, R23, R24, R26, R27. **R25 skipped** by instruction.
Base: `483121a` (Round 4 already landed).

## Commits (in order)

| Commit | Item | Summary |
|---|---|---|
| `e8adc9b` | R21 | Omit pick lines from server round reveals; picks still score/feed digest. |
| `a50ae8f` | R22 | Bounded, escaped, case-insensitive, idempotent alias replacement/recodes. |
| `4bf52e9` | R23 | Print every usable LAN IPv4 URL in preference order; never link-local/loopback. |
| `0384515` | R24 | Persist/reclaim authenticated room seats in localStorage; purge clears session. |
| `5112635` | R26 | Use authoritative `RoundView.trait`/`about`; remove web bank-guessing shim. |
| `2f44a54` | R21 test follow-up | Protocol reconnect test accepts intentionally empty pick reveals. |
| `5f8c225` | R27 | Gate spark announcements on ≥3 independent measured supports; add incidence harness. |

## Files created

- `lib/aliases.ts` — shared bounded alias replacement helper (`ALIAS_REPLACE_MIN = 3`).
- `apps/server/test/r21-reveal.test.ts`, `r22-aliases.test.ts`, `r23-lan.test.ts` — per-fix server regressions.
- `apps/web/scripts/r24-session.test.ts`, `apps/web/scripts/jsdom.d.ts` — real-server reload/purge regression + JSDOM typing.
- `apps/web/scripts/r26-authoritative.test.ts` — assigned trait/subject regression.
- `packages/engine/test/r27-spark.test.ts` — noise/mutual/downgraded-claim/determinism regressions.
- `scripts/spark-incidence.ts` — reproducible before/after spark measurement (`npm run measure:sparks`).

## Principal files changed

- Server: `apps/server/src/game.ts` (R21 reveal), `apps/server/src/server.ts` (R23 LAN), `apps/server/src/pseudonyms.ts` (R22).
- Alias consumers: `packages/prompts/src/provider.ts`, `packages/narrator/src/roster.ts`.
- Web session/rejoin: `apps/web/src/lib/session.ts`, `socketTransport.ts`, `useRoom.ts`.
- Web authoritative answers: `apps/web/src/lib/demoAnswer.ts`, `mockTransport.ts`, `apps/web/src/screens/PromptScreen.tsx`; deleted dead `apps/web/src/lib/promptHints.ts`.
- Engine spark gate: `packages/engine/src/results.ts`, `packages/engine/src/secrets.ts`, `packages/engine/README.md`.
- Harness wiring: root `package.json`, `scripts/tsconfig.json`, `apps/web/package.json`.
- Reports/requests: `FIX-REPORT.md`, `NOTES/contract-requests.md`.

## Contract requests

- **R26 only:** `RoundView.about?: PlayerId` and `RoundView.trait?: TraitId` were already present and owner-approved. R26 makes the web consume them authoritatively; `trait` remains `TraitId` per the owner's confirmation. No other shared-contract field changed.
- Recorded in `NOTES/contract-requests.md` as applied/owner-approved.
- No new contract request is needed for R21–R24 or R27.

## R27 measurement (before → after)

`npm run measure:sparks`; raw logs in `.test-results/r27-before.txt` and `.test-results/r27-after.txt`.
Per-round = spark secret cards / completed rounds. Per-night = nights with ≥1 spark card / nights.

| Cohort | Policy | Nights | Rounds | Cards before → after | Cards/round before → after | Nights with spark before → after |
|---|---:|---:|---:|---:|---:|---:|
| fixtures | noise | 200 | 4400 | 8 → 0 | 0.001818 → 0 | 2.00% → 0% |
| fixtures | mutual | 10 | 140 | 20 → 20 | 0.142857 → 0.142857 | 100% → 100% |
| live bots | noise | 30 | 720 | 4 → 0 | 0.005556 → 0 | 6.67% → 0% |
| live bots | mutual | 10 | 240 | 20 → 20 | 0.083333 → 0.083333 | 100% → 100% |

The gate reuses `pairSupportCount`, `confidenceFromCount`, `CONFIDENCE_RULES.high.independentSignals` and existing `ENGINE_TUNING.support` bars. No new scoring or numerical tunable was added. `buildSecrets` also refuses spark claims below high confidence.

## Tests run / output

- `npm run typecheck`: passed (server, web, engine, narrator, prompts, scripts).
- `npm run selfcheck`: **36/36**.
- `npm test --workspace apps/server`: **75/75** (`.test-results/r27-server-suite.txt`).
- `npm test --workspace packages/engine`: **45/45** (`.test-results/r27-engine-suite.txt`).
- `npm test --workspace packages/prompts`: **104/104**.
- `npm test --workspace packages/narrator`: **81/81**.
- `npm run test --workspace apps/web`: passed — SSR **39**, UI/socket/mock/privacy regressions, transport **4/4**, authoritative **2/2**.
- `npm run test:components`: **131/131**.
- `npm run test:mock --workspace apps/web`: **56/56**.
- `npm run build`: static export passed.
- `npm run bundle:check`: player **145.4 KiB gzip / 150 KiB**, display **115.7 KiB / 120 KiB**.
- `SMOKE_FAST=1 npm run smoke:verified`: passed (smoke room `4PW5`, 5 players, keys disabled).
- Per-fix before/after logs are retained under `.test-results/r21-*`, `r22-*`, `r23-*`, `r24-*`, `r26-*`, `r27-*`.

## Known gaps

- **Release disposition remains NO-GO / REQUIRES HUMAN:** no real Android/iPhone device matrix was run in this checkout.
- The live spark cohort is observational (server-chosen room id/live seeds); the seeded fixture cohort is the byte-reproducible before/after evidence.
- Live server rating/IOS subjects are non-self, so `traitAgreement` is rarely a measured support in live bot nights. The spark gate is deliberately conservative: mutual picks alone no longer announce a spark.
- The retained standalone server fallback services remain a test/last-resort seam; the production host uses the integrated production engine measured above.
- R24 reload stability was proven with shortened test timers (`spotlight: 200`, `graceMs: 50`); production timers are unchanged. An idle spotlight subject still closes on the existing timer path.
