# Agent Z merge and QA report

> Historical report for the earlier integration (PR #9). Follow-up work added
> local current-night callbacks, nonce-bound reconnect recovery and an automated
> full-game Chromium regression. The remaining real-device, LAN and live-provider
> checks below still apply; see the current runbook and package READMEs. The
> intermittent server-test failure noted below was traced to counting only
> rounds where the host participates; the follow-up now checks all 14 observed
> rounds and every eligible host response.

## Decision: **NO-GO for game night**

The no-key five-player game and independent local privacy oracle now pass; the
production dependency audit is clean and the modern introductory HTML scripts
meet the 150 KB limit by a narrow margin. **NO-GO remains** because rating/IOS
intent cannot be reliably enforced through the frozen contract, and the
required real-device/browser/LAN matrix has not been run. Legacy polyfills and
later chunks exceed the budget if included. Do not interpret the preview or
automated suites as release certification.

## Merge and changes

- Fast-forwarded this session branch to the completed A–G merges on main.
- Wired the production server to the full prompt bank, background Grok lane,
  deterministic engine and lexicon, and narrator templates/optional public
  Gemini narration. The narrator receives only public, pseudonymized inputs and
  an empty private-deck map; secret cards remain server-side and per-socket.
  The Grok and narration adapters share the provider's per-room logical call
  ledger. Server service injection and the small fallback remain available.
- Passed the pseudonymized roster to the narrator and disposed of the room's
  provider ledger on deletion/close. Grok work is launched in the lobby and
  does not block gameplay.
- Fixed Flame's reduced-motion mode to remove embers and stop flicker. Added
  the requested dev-only `jsdom` dependency and a repeatable component-test
  runner. Switched the prompts/narrator test commands to `tsx` so they also
  work on Node 20.
- Added the in-process-only verified smoke oracle. It observes the real deck
  before delivery, actual per-socket outgoing secret frames, real JSONL counts,
  and actual engine joker weights. It does not add a network debug endpoint.
  An intentional test-only leak is caught by the oracle.
- Fixed prompt submit acknowledgments and dare-pass acknowledgment by routing
  passes through the existing `submit` event. Coalesced racing reconnects and
  removed visibility listeners on disconnect. Host custom prompts now apply
  the provider banned/hard-block checks plus the previous conservative guard.
- Reduced the initial bundle via lazy room/screen/transport loading, and moved
  haptics/reduced-motion helpers out of the confetti import. Added loading
  fallbacks. Ratings now require the player to explicitly choose trait/subject
  instead of silently defaulting to loyalty/self; this only mitigates the
  missing structured intent and does not enforce the right selection.
- Overrode Next's PostCSS to 8.5.32, verified with clean `npm ci` and audit.
- **No changes to `packages/shared`**. Requested a replay-safe resume protocol
  in `NOTES/contract-requests.md`. Contract-dependent changes remain deferred.

New files for integration/fixes: `apps/server/src/integrated-services.ts`,
`apps/server/test/integrated-services.test.ts`,
`apps/web/src/components/{RoomApp,deviceFeedback}.tsx`/`.ts` (respectively),
`apps/web/scripts/socket-transport.test.ts`,
`scripts/{verified-smoke.ts,test-components.mjs,jsdom-export-smoke.mjs}`, and
this report. Modified server game/index/services and protocol tests; web page,
transport, hook, play/prompt components, Flame/OpeningSequence/feedback and web
scripts; engine results; bot and TS test scripts; root/web/prompts/narrator
manifests and root lock; runbook and contract notes. The full workspace was
already present from the merged agents; Git status in this sandbox lists it as
untracked, so this list describes the integration work, not all repository files.

## Tests and output

| Test | Result |
|---|---|
| `npx -y tsx scripts/selfcheck.ts` | **ALL 31 CHECKS PASSED** |
| `npm run typecheck` | **PASS**, all five workspaces |
| Engine tests | **15 passed, 0 failed** |
| Prompt tests | **94 passed, 0 failed** |
| Narrator tests | **86 passed, 0 failed** |
| Server tests | **16 passed, 0 failed**, including integrated no-key game, privacy guard fixture, and five-player spot-check |
| Web tests | **39 SSR checks passed**; **53 mock-flow checks passed** |
| `npm run test:components` | **102 checks passed** in jsdom; earlier run exposed a reduced-motion Flame failure, now fixed |
| Node 20.20.2 | Production build **PASS**; prompt/narrator suites **94/94 and 86/86 passed** |
| No-key `npm run host` | **PASS**: static export built; server bound to `0.0.0.0:3001`; HTTP `/` returned 200. Source defaults to `socket` unless mock explicitly selected; live Socket.IO smoke passed. |
| `npm run smoke:verified`, keys disabled | **PASS**: five external sockets, all phases, equal public finale, independent per-recipient secret/deck checks, disk idempotency, dare passes, active/finale resume, deletion, actual joker weight and confidence. Harness uses shortened timings. |
| `SMOKE_INJECT_LEAK=1 npm run smoke:verified` | **PASS as a negative test**: the deliberately corrupted harness exits nonzero with `secret frame delivered to a non-owner`. |
| `npm run test:transport --workspace apps/web` | **1/1 PASS**: coalesced resume, listener cleanup and rejected pass acknowledgement with real local sockets. |
| `node scripts/jsdom-export-smoke.mjs` with built server | **PASS**: exported bundle hydrates, intro→join→room creation→lobby→deletion. jsdom is not a real browser. |
| `npm ci` | **PASS** from root lockfile, Next uses PostCSS 8.5.32. |
| Grok/refusal/timeout | **PARTIAL**: mock-fetch package and adapter tests pass, including 4 background calls, refusal fallback and nonblocking bank access. No real key/provider access; real model, real latency and inter-round <2 s remain unverified. Lobby generation receives an empty digest, so earlier-answer callbacks are not integrated. |
| Gemini | **PARTIAL**: mocked narrator package tests pass; the public-only adapter reserves a reveal slot. Live API/model/safety settings unverified. The optional tag/debrief Gemini analysis batches are not wired into the server; private cards remain deterministic. |
| `npm audit --omit=dev` | **PASS**, 0 vulnerabilities. |

The live socket smoke tests the transport protocol, not a real browser. Its
18+ check reuses an already-joined socket; the server package validation tests
provide separate coverage, but this smoke alone does not prove the age gate.
The no-key server integration test uses shortened timings and in-server bots.
One earlier server-suite run failed during a concurrent production build; its
truncated output did not identify the cause. Two subsequent server runs passed
16/16, including under parallel test load, so a load-related flake is possible
but unconfirmed.

## Bundle measurement

Final production build: Next reports `/` **149 kB first-load JS**. Python
`gzip.compress(..., mtime=0)` level 9, summed over unique `index.html` script
URLs: **149,548 bytes (146.04 KiB)** excluding the `nomodule` polyfill; this is
just below 150,000 bytes and 150 KiB for the modern introductory page. With
that polyfill included: **188,921 bytes (184.49 KiB)**. CSS, fonts and data are
not included.

This is not a claim that the playable app stays under budget: the jsdom export
smoke records **189,146 bytes** of gzipped scripts at intro including its
nomodule download and **213,324 bytes** by the lobby; dynamic room, socket and
screen chunks account for another **24,178 bytes**. Node zlib and Python gzip
produce slightly different sizes. Real browser transfers, cache and compression
settings were not measured. No actual legacy browser was tested. Build warns
about root and nested web lockfiles; clean root install works.

## One five-player scripted arithmetic check

`apps/server/test/integrated-services.test.ts` extends the engine's golden
fixture with five complete friction rounds; the production adapter computes:

- Consensus C2: **4/5 = 0.8** for p1.
- p1/p2 pair score: `0.30*(2/3) + 0.20*(1/2) + 0.20*(4/6) + 0.15*(13/14) + 0.15*(11/12) = 0.710119047619`.
- p5 picks p1 **8/10 = 0.8**, exceeding 0.7. The engine observer records the
  five added negative nominations at weight **0.5 each**, total **2.5**. The
  result contains no high-confidence toxic
  claim for p1. The separate live verified-bot game also observes actual joker
  weights through the engine callback.
- p3 loyalty: self **5**, peers **8, 9, 8, 8**, mean **8.25**, spread **1**,
  absolute gap **3.25**.

This is a scripted fixture, not a full physical-device game.

## Cross-platform matrix / §11

No desktop Chrome/Firefox, macOS Safari, real iPhone or Android device is
available in this sandbox. Therefore full games, LAN QR joining, two-phone
secret-frame isolation, iOS long-press/callout behavior, real-phone group
announcement, airplane-mode/lock/reopen recovery and device performance are
**NOT TESTED**. The printed `169.254.*` sandbox address is not proof of a
reachable game-night LAN. Session storage intentionally does not guarantee a
reopened *new* tab retains its session; test the exact kill/reopen scenario.

Static inspection finds `dvh`, mobile blur variants, prefixed backdrop filter,
feature-detected vibration, clamp display sizes, reduced-motion CSS, touch
callout suppression, session intro gate, polling-first sockets and visibility
resume. The jsdom suite checks hold/release, group animations, reduced motion,
and intro timing. These do **not** establish that every target is 48×48, every
headline is fluid, or that any behavior works on the required physical devices.
All twelve §11 items still require a device-by-device pass.

## Contract-request dispositions

Requests were read from **both** `NOTES/contract-requests.md` and the archive's
`NOTES/contract - requests.md`; duplicates below are grouped. “Deferred” means
not rejected as unnecessary: it needs a contract decision and remains open.

| Request | Disposition |
|---|---|
| G root dev tooling; F server dependencies; C engine dev tooling | Already present in merged package manifests/lockfile; tests run. |
| B2 dev-only jsdom | Accepted and installed at root; `npm run test:components` passes. |
| G local-only independent oracle | Implemented via local-only in-process harness and observer callbacks; no network debug API. Positive and intentional-leak negative tests pass. |
| B1/D/A rating trait and rating/IOS target metadata | Deferred under shared freeze. Current UI permits selecting trait/target; it cannot reliably know prompt intent. |
| B1 submitted IDs and heat vote count | Deferred under shared freeze; public snapshot cannot show these faithfully. |
| B1 pair-dare/debrief response mapping | Convention implemented in server: pair-dare uses `dare`, debrief uses `text`; shared contract documentation remains deferred. |
| C stable log ID | Existing composite `logRecordId` used by integrated lexicon; dedicated contract ID deferred. |
| C debrief pair grouping | Deferred: engine infers pairing, which is not an explicit contract. |
| C reveal opt-in scope | Server currently gates **all** secret-deck delivery by recipient opt-in; engine itself gates spark/one-sided. Product/contract clarification remains deferred. |
| D callback marker | Deferred under shared freeze; live lobby generation also cannot use future answers as callbacks. |
| D Grok model confirmation | Unverified: external xAI docs/API unavailable; `XAI_MODEL` override and bank fallback exist. |
| D Gemini safety thresholds | Deferred contract comment change; provider/narrator map to classic `BLOCK_NONE` with retry. Live endpoint behavior unverified. |
| D shared `isPrompt` | Deferred under shared freeze; duplicated guards can drift. |
| F shared service interfaces | No shared change; production adapter now wires concrete packages through server-local interfaces. Shared standardization deferred. |
| F/A transient reconnect snapshot | Shared change deferred; server replays current transient event to a rejoining socket. Physical lifecycle behavior unverified. |
| F payload-size conflict for verbatim excuses and Unicode reveal/finale | Deferred: no chunk protocol under frozen contract; worst-case <5 KB is not proven and must not be assumed. |
| F public-only narrator interface | Server currently sends public claims/digest and an empty deck map; fixture tests exercise separation. Shared formal interface remains deferred. |
| F per-room provider budget | Local shared logical ledger now covers adapter Grok generation and public narration. Shared formal interface and optional analysis wiring deferred; provider HTTP retries can exceed the logical-call count. |
| F reuse full custom-prompt filter | Partial: shared `checkBanned`/`checkHardBlocked` are now enforced in addition to the local guard. Full `parseHostLines` parity (including default phase, kind, measures, data-or-dead) remains unresolved. |
| E roster crosswalk | Accepted without shared change: pass pseudonymized `meta.players` into skeleton and narrator. |
| E contradiction field | Deferred under shared freeze; no full dare↔trait contradiction field. |
| E spicy-only fastest signal | Deferred under shared freeze; all-night fastest is not the requested spicy+ measure. |
| E stable finale slide ID | Deferred under shared freeze; narration uses array position. |
| A dare-pass acknowledgment | Addressed for the web transport without shared changes by sending a validated pass through the already-acknowledged `submit` event. The direct `dare_pass` event remains fire-and-forget for other clients. |
| Z replay-safe resume rotation | Requested: a lost successful join acknowledgment can strand the client with a stale rotated secret. Coalescing concurrent resumes mitigates a separate race but does not solve lost-ack recovery. |

## Remaining release work

Resolve rating/IOS intent and other frozen-contract/safety gaps through a
contract decision; fully align custom prompt parsing; verify replay-safe resume
under lost acknowledgment; validate real provider lanes; then execute the full
real-device/browser/LAN/privacy and recovery matrix. Modern intro script budget
has little headroom, and inclusive/lobby sizes are still above budget. A new
GO/NO-GO decision should follow those results.
