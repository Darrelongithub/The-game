# BUGSCAN REPORT — The Reveal Game v3.2

Branch: `arena/6196d2b4-the-game`
Baseline: `3fb73f2` · Report tip: `f41aaa3`
Date: 2026-11-04
Method: read the code, reproduce each defect, fix the root cause, pin it with a test that fails without the fix, then play the game live.

The brief file `GAME-BRIEF-v3.2.md` is **not present** in this repository or its git
history. I used `packages/shared/src/contracts.ts` as the v3.2 source of truth and
`spec/spec.md` only where it agrees with the contracts. `spec/spec.md` is stale for
several v3.2 behaviours (old phase list, per-round gates); it was never used to
override the contracts.

---

## 1. Result at a glance

| Area | Result |
|---|---|
| STEP 1 verification | 11 / 11 PASS (item 1 only after the P0 fix below) |
| STEP 2 known defects | 8 / 8 addressed; Windows execution not testable here |
| STEP 3 simulated nights | 3 / 3 PASS — 4, 7 and 11 players, final code; plus a 60-second fake-Ollama loader run |
| Typecheck | PASS — 5 workspaces |
| Server tests | 64 / 64 PASS |
| Package tests (engine, prompts, narrator) | 103 / 103 PASS |
| Web | SSR 31, components 137, regressions 5 suites, mock 1/1, transport 1/1 — all PASS |
| Foundation selfcheck | 87 / 87 PASS |
| `npm audit` (prod and dev) | 0 vulnerabilities |
| Bundle | player 145.4 KiB gzip / 150 cap; laptop 167.6 KiB gzip — both under the 250 KiB no-chase line |
| Build | Next 15.5.28 static export, `/` 149 kB first-load, `/host` 171 kB |

---

## 2. Defects found, fixed, and proven

| # | Issue | Evidence | Fix | Test that proves it | Status |
|---|---|---|---|---|---|
| **P0** | **Production generation never called Ollama.** `IntegratedPromptProvider` built the `Provider` but handed the prompt facade no `fetchImpl` or model config, so every batch logged `unavailable:disabled` and the bank silently carried every night. | Live `npm run host`: `Ollama: asked 15, accepted 0, dropped 15 (unavailable:disabled)` on every band, before any network attempt. A fake Ollama on `GEN_BASE` received **zero** requests. | `apps/server/src/integratedServices.ts`: pass `config: this.provider.ollama` and `fetchImpl: this.network.fetch` into `createPromptProvider`. | `apps/server/test/production-generation.test.ts` — fails before the fix with *“the production lane made no HTTP call at all”*, passes after; asserts calls to `/api/chat` on the configured base URL. | **FIXED** |
| 1 | Pair rotation repeated pairs early (4 and 6 players). | Old greedy `pairUp`: 4 players first repeat at case 5; 6 players repeat at case 8 with only 14/15 pairs met. | `planPairings()` in `apps/server/src/game.ts`: circle-method round-robin over dummy seats; odd rooms walk every pair in `n` rounds, even rooms miss one pair and the spare case schedules it. Wired in `room.ts planCases`. | `apps/server/test/pair-rotation.test.ts`: 4/5/6/7/11 cover all pairs before a repeat; 6-player full night prints every round; 10-player arithmetic exception pinned (44/45 in 11 cases, 45/45 in 12). | **FIXED** |
| 2 | The prompt queue over-drew, exhausting the bank before the last 11-player case. The final pair(s) got no question at all. | Probe: 11-player case 12 had **3 pairs instead of 5** and 4 players with no question; 53/55 pairs seen. | `makeQueue` now draws one prompt at a time instead of a queue of `pairCount` and throwing the unused remainder away. | Same test file, 11-player test: every paired case has 5 pairs and all 11 players; 55/55 pairs. It fails on the old queue with *“3 pairs instead of 5”* / *“Amina got no question”*. | **FIXED** |
| 3 | Loading screen showed a hardcoded `0/40` and never polled generation. | `room.start()` wrote `{ done: 0, total: 40 }`, awaited `generate()`, then jumped to play. No `generationProgress()` call anywhere in the server. | Progress callback through `ollama.ts` → `generate.ts` → `facade.ts`; `room.ts` polls every 250 ms and broadcasts real counts, stopping in `finally`. | `apps/server/test/generation-loader.test.ts`: phones see `generating 0/40`, then `7/40`, no `round` event before generation resolves, first question after. `packages/prompts/test/ollama.test.ts` asserts monotonic progress. | **FIXED** |
| 4 | Wrong default Gemini model (`gemini-2.5-flash`) instead of the brief's `gemini-3.5-flash-lite`. | `PROVIDERS.gemini` in contracts. | Defaults changed in `contracts.ts` and `.env.example`; `GEMINI_MODEL` still overrides. | `packages/prompts/test/ollama.test.ts` “the model ids”: default and override; retired ids asserted absent. | **FIXED** |
| 5 | Narrator could accept a model-written orientation claim. | `BANNED_PHRASES` had no orientation words; Gemini copy is merged into slides. | `packages/narrator/src/validate.ts`: `findOrientationClaim()` rejects “is gay”, “came out”, “the gay one”, etc., while allowing the room's own “if … were gay” hypothetical. | `packages/narrator/test/narrator.test.ts` unit cases; `apps/server/test/reveal-lane.test.ts` end-to-end: malicious `Player 1 is gay / came out` copy falls back to the engine slide. | **FIXED** |
| 6 | The brief's two hypothetical gay prompts had been removed/de-escalated. | `unhinged.json`: `un-10` had become a search-history pick, `un-08` a plain couple question; the brief explicitly requires “If there were someone gay in this room, who would it be?” and “If X and Y were gay, would they make a good couple?”. | Restored `un-10` as the exact single pick and `un-08` as “Hypothetically speaking, if {P1} and {P2} were gay, would they make a good couple?”, both `metric:gay-hypothetical`. `sp-12` keeps the clean pair wording. | `packages/prompts/test/bank.test.ts`: both prompts exist and every gay prompt is framed as a hypothetical. `packages/engine/test/engine.test.ts`: a gay-hypothetical pair vote yields only the `gaycouple` verdict (never an ordinary couple/sex line), and a gay-guess pick never names its target. | **FIXED** |
| 7 | Resume sent a stub consent/profile (`age: 18`, all `undisclosed`) instead of the player's answers. | `socketTransport.ts` `tryResume`. | Store consent/profile in `lastJoin` and `reveal.session`; resume sends them back. | `apps/web/scripts/socket-transport.test.ts`: stored session and resume retain the real profile; reload reclaims one seat. | **FIXED** |
| 8 | A join reply lost in transit could lock the player out (retry either took a second seat or was refused after Start). | Server had no idempotency key; the secret is returned only in the reply. | `JoinRequest.joinId`; server maps join id → seat and hands back the same player/secret even after Start; client reuses its join id on retry. | `apps/server/test/join-idempotency.test.ts`: retry after Start gets the same seat/secret, no second seat, genuinely new player still blocked. Transport test repeats a join with the same id. | **FIXED** |
| 9 | `dev:mock` used POSIX `KEY=value command` syntax, which fails in Windows PowerShell/cmd. | `apps/web/package.json`. | `apps/web/scripts/dev-mock.mjs` sets the env var in Node and starts Next; no new dependency (`cross-env` avoided). | Ran `npm run dev:mock` here: Next 15.5.28 “Ready in 1786ms”. Windows execution is **not** verified (no Windows host). | **FIXED (code), Windows untested** |
| 10 | No-LAN banner built a malformed link (`http://localhost:3001:3001`). | `base` fallback already contained the port, then the template added it again. | `apps/server/src/server.ts`: explicit localhost fallback without a second port. | `apps/server/test/r23-lan.test.ts`: loopback-only laptop prints one valid PLAYER and HOST link, warns that phones cannot reach it. | **FIXED** |
| 11 | One-sided-crush test was vacuous: it added only mutual picks, then asserted no one-sided card. | `case-engine.test.ts` loop over existing cards. | Added a third player's one-sided pick to the test and asserted neither of those two phones gets a crush card. | `apps/server/test/case-engine.test.ts` — 4 phones, exactly 2 cards. | **FIXED (test)** |

---

## 3. STEP 1 — item-by-item evidence

| Item | Verdict | Evidence |
|---|---|---|
| **1. Ollama path and timeouts** | **PASS (after P0 fix)** | Generation now really calls the configured endpoint (fake Ollama received `/api/chat`; live log changed from `unavailable:disabled` to `unavailable:network` when the endpoint was closed). `GEN_TIMEOUT_MS` is 120 000 ms; `GEN_SAFETY_CAP_MS` is 180 000 ms in `ollama.ts`; `provider.ts` `DEFAULT_TIMEOUT_MS = 8_000` is the Gemini lane only. The terminal prints each batch: `Ollama: asked 15, accepted 0, dropped 15 (unavailable:network)` — observed live on every night. |
| **2. Generate after Start** | **PASS** | Automated loader test (every phone `generating`, no `round` before resolve). Live with a fake Ollama that delays **60 s per call**: `0.0s generating 0/40` → `60.1s generating 1/40` → `180.1s play, first question`. No question before generation. With Ollama off, the 4-player night still started and finished from the bank. |
| **3. Models / keys** | **PASS** | No `grok-4-1-fast` or `gemini-3.1-pro-preview` in source (grep). Default is now `gemini-3.5-flash-lite`, overridable by `GEMINI_MODEL`. Keyless live nights reached a non-empty finale; terminal shows `Gemini: asked N, used 0 (unavailable:no-key)` and never errors. |
| **4. Rejoin** | **PASS** | `reveal.session` in localStorage; a reloaded tab resumes with the stored secret and one seat (transport test). A mid-game `reclaim()` with the same secret succeeds and creates no new seat; a fresh join after Start is refused (`join-idempotency.test.ts`). The stub consent/profile defect was fixed. |
| **5. Pair rotation** | **PASS** | 6-player night: 15/15 pairs seen, first repeat at case 18 only after all 15 had met. Example (printed by the probe): case 1 subject Ben — pairs Cleo–Fay, Dev–Eli, solo Ana; case 5 subject Fay — pairs Ben–Eli, Cleo–Dev; case 7 subject Eli — Ana–Fay, Ben–Cleo; every case has a different question per pair, the subject has their own question, and no template repeats. 11 players now covers 55/55; 10 players is the arithmetic 44/45 case. |
| **6. One question per screen** | **PASS (code + component tests)** | `QuestionScreen` renders one `<h1>` and one `question-note` line. Component suite asserts exactly one question and the grey line on pick, text, watching and look-chain screens (137 checks). Fan-out screens (finale/secret deck) were not visually inspected on a real phone. |
| **7. Round timing / gates** | **PASS** | Real-timer test: case closes **14.5 ms** after the last answer (< 1 s), no ready gate between cases, no results phase mid-night. Live bots check every `beat` against the last answer for all 3 nights and pass. `BEAT_HOLD_MS = 1 500` is the deliberate hold before the next case, not a close delay. |
| **8. Crush cards** | **PASS** | Engine `mutualCrushes()` requires both directions; `buildSecrets` adds a card to exactly those two players. Server test injects one mutual pair plus one one-sided pick: exactly 2 phones get a crush card; neither one-sided phone gets a card or hint. |
| **9. Results / orientation** | **PASS** | Engine verdicts are data-backed (thresholds in `results.ts`); `assertNoOrientationLeak` guards engine copy; narrator rejects model orientation claims; a malicious Gemini rewrite falls back to engine copy. The brief's two hypothetical prompts are restored, but a gay-hypothetical pair vote is now used **only** by the `gaycouple` verdict (never an ordinary couple/never line), and a gay-guess pick is never printed or made a verdict subject. `gaycouple` remains only the hypothetical the room voted on. |
| **10. Secrets isolation** | **PASS (4 sockets, stronger than the requested 3)** | `case-engine.test.ts`: mutual crush reaches exactly two phones; look-chain truth reaches only the actor, not the guessers. Secret decks are emitted per socket (`emitToPlayer`), never broadcast. |
| **11. Forced picks** | **PASS** | Server `submit` rejects self-picks, skipped values, wrong kinds, empty text, late answers; `targetsOther` rejects a pair containing the voter. Bots assert every pick target ≠ self across all live nights; case-engine tests cover the rejections. |

---

## 4. STEP 2 — known defects

| Defect | Result |
|---|---|
| Windows `dev:mock` Mac-only syntax | Fixed with `apps/web/scripts/dev-mock.mjs`; no `cross-env` dependency. `npm run dev:mock` verified on Linux. **Not executed on Windows.** |
| `npm run host` in Windows PowerShell + both links | `host.mjs` already uses `npx.cmd` + `shell` on Windows and `taskkill /T /F` on stop; the banner prints PLAYER + QR + HOST + room code. I inspected this path but **could not run Windows PowerShell**. RUNBOOK now has the Windows section. **Code-verified only.** |
| RUNBOOK Windows firewall / Private / `ipconfig` / hotspot | Added: `Get-NetConnectionProfile`, `Set-NetConnectionProfile`, `New-NetFirewallRule` for TCP 3001 on the Private profile, `ipconfig` IPv4, hotspot guidance, and the multi-adapter ranking note. |
| LAN QR with several adapters | `lanAddresses` prints every usable IPv4, ranked `192.168.*` → `10.*` → `172.16–31.*`, with Docker/veth/tun/WireGuard/VirtualBox penalties; QR uses the first. Tests cover the ranking and the loopback-only fallback. **No real VPN/VirtualBox/WSL adapters in this sandbox.** |
| Lost-ack resume | Fixed with join-id idempotency (see P0 table #8). The simulated lost reply is a repeated `join` with the same id after Start. **A real dropped TCP reply was not reproduced.** |
| Payload size | `payload-size.test.ts`: 11-player full night, every text answer 280 UTF-16 units of `🔥` (140 emoji), all submits accepted, every outgoing payload serialisable and under 512 kB. Note: the length check is UTF-16 code units, so 280 *emoji* would be 560 units and rejected; the UI uses the same unit. |
| `npm audit` | 0 vulnerabilities, dev and prod. Nothing to fix. |
| Bundle | Player 145.4 KiB gzip / 150 KiB cap; laptop 167.6 KiB. Under the 250 KiB no-chase line; the guard also asserts `RoomApp` stays lazily imported. |

---

## 5. STEP 3 — simulated nights (final code)

All three ran against the live server with a closed `GEN_BASE` (Ollama off), no API keys, real Socket.IO clients from `scripts/bots.ts`, and the acceptance checks in that script.

| Players | Duration | Round events / phone | Result | Terminal |
|---|---|---|---|---|
| 4 | 31.1 s | 30 | `SMOKE PASSED ✅` — finale on every phone, mutual crush cards only on the pair, ≤1 s closes | 4 batch lines `unavailable:network`, `Gemini … no-key`, no errors |
| 7 | 36.2 s | 34 | `SMOKE PASSED ✅` | same; no errors |
| 11 | 40.5 s | 39 | `SMOKE PASSED ✅` — all 55 pairs met | same; no errors |

“Round events” counts every stage of a look chain and every case, not just the 12 cases.

`npm run host` itself was also run end to end: it built the web export (Next compiled in 4.8 s) and then booted the server, printing the PLAYER link + QR, the HOST link and the room code.

**Slow-model run:** fake Ollama at `GEN_BASE` with a 60 000 ms delay and `GEN_TIMEOUT_MS=65000`. Observed: `0.0s generating 0/40`, `60.1s generating 1/40`, `180.1s play`, first question at `180.1s`. The 180 s safety cap ended generation and the bank carried the night. The probe stopped after the first question, so this was **not** a full slow-model night.

**Verdicts:** every simulated night reached a non-empty finale; the engine tests pin the data thresholds behind each verdict kind. I did not manually audit all 30–39 slides per game for narrative quality.

---

## 6. What I could NOT test (honest list)

- **Real phones/tablets** — no iOS Safari or Android Chrome, no real touch/QR scanning, no pocketed-phone sleep/reconnect.
- **Real LAN** — no Windows machine, no real Wi-Fi/hotspot, no VPN/VirtualBox/WSL adapter mix, no firewall prompt. LAN and Windows are code/test-verified only.
- **Real Ollama** — no `dolphin-mistral` model here. I used a fake HTTP Ollama (60 s delay, one valid line) and a closed port. Real model quality, real token latency and real malformed output are untested.
- **Real Gemini** — no API key. Keyless fallback, no-key logging and malicious-copy rejection were tested; a real Gemini response was not.
- **Real network loss** — lost acks and mid-game reconnects were simulated in-process, not by dropping packets.
- **Visual layout** — jsdom component tests, not a browser screenshot on every screen size.
- **Long-run housekeeping** — 48 h purge / 24 h idle expiry not exercised.
- **Windows execution** of `npm run host`, `dev:mock`, firewall and `taskkill` stop path.

---

## 7. GO / NO-GO

**GO** for a friends' game night, after a two-minute pre-flight on the actual host laptop: run `npm run host`, open the PLAYER link on one real phone on the same Wi-Fi/hotspot, join the lobby, and only then invite the room (keep Ollama optional; the bank carries the night).

**Single biggest risk:** real-device networking on the Windows host — firewall profile, Private vs Public Wi-Fi, hotspot client isolation and multiple adapters. It is the one mandatory path that could not be exercised here; everything downstream of a phone reaching the server is covered by the three simulated nights and 300+ tests.
