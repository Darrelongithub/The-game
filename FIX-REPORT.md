# Remediation report

**Decision: NO-GO — REQUIRES HUMAN DEVICE TESTING.** R1–R20 implementation and automated regression work is complete on this branch. A real Android + iPhone pass has not been performed; do not merge or treat this as a release-ready build until the device checklist below is completed and recorded.

## Completed

- **Step 1 — contract baseline:** Added `tease`, personalized RoundView metadata, dare performer log metadata, role/profile contract and `PROFILE_QUESTIONS`, requested tunables, and updated provider constants. Mirrored the contract summary in `spec/spec.md`; added optional model overrides in `.env.example`; added selfcheck assertions for all three new tunables.
  - Evidence: `npx -y tsx scripts/selfcheck.ts` — **34 checks passed**.
- **R4 — pick secrecy:** Removed the round-reveal `Chose <name>` entry. Added a protocol regression assertion that fails if a pick reveal contains a “Chose” item.
  - Evidence: protocol test passed in the suite run below.
- **Contract integration cleanup:** Added empty profile maps to existing RoomMeta fixtures and adjusted stale Gemini `reveal` model references so the contract typechecks. This is compile compatibility only; it does not implement profile collection or route finale narration through Grok.
  - Evidence: `npm run typecheck` passed.

## Completed remediation requirements

- **R1 — rating/IOS subjects:** Implemented server-assigned non-self subjects and rating traits, submit enforcement, personalized RoundView metadata, live submitted IDs, and removed client dropdowns. Protocol regressions verify all four rating assignments and each IOS subject; SSR regression verifies the assigned subject/trait is displayed.
- **R2 — solo dares:** One rotating performer per dare; only that phone can answer, prompts are substituted without naming the performer, spectators see the same prompt, and `performerId` is persisted.
- **R3 — pair dares:** Both players receive identical “You two:” instructions. A pass blocks the other player from marking it done; both must submit a required reason, recorded separately. Debriefs remain `onlyPlayers`-private.
- **R5 — profile collection/enforcement:** Added a `PROFILE_QUESTIONS`-driven join flow for age, relationship, dating history, private-crush status, and tonight intent; age is hard-gated at 18+, and existing consent choices remain required. Create and first-time join now validate and store bounded profile data; room metadata carries profiles into the engine, bots receive deterministic neutral profiles, and resume/reclaim paths retain the seat's stored profile. Added protocol regressions for missing create/join profiles. Raw profile answers are not included in RoomView or shown directly in UI. Regression coverage rejects missing profiles at both creation and first join. The web mock-flow (53 checks), Socket.IO transport test, strict typecheck, selfcheck, server validation, and profile UI SSR checks passed. The R5 implementation and profile-required mock/bot flows are committed.
- **R6 — rejoin:** Resume credentials stay stable; active credential replay cannot displace an already-connected seat; disconnected seat can be reclaimed mid-round by alias + room code. Protocol test verifies same seat and active-round snapshot.
- **R7 — pseudonymization:** Implemented Unicode word-boundary substitution, stable alias table, and deterministic swap-back; tests cover Ian/Brian, overlapping aliases, and reverse mapping.
- **R8 — statistical gates:** Spark requires at least two mutual couple-coded picks in each direction; consensus uses the picker threshold and allows below-threshold claims only when unanimous, capped at medium confidence. Secret generation suppresses low-confidence claims. Single-mutual spark regression passes. Consensus high confidence now requires the same target on the same coding to clear the threshold in three independent rounds. A 500-night n=4 randomized regression recorded 0 high-confidence consensus false positives (≤2%).
- **R9 — tease coding:** Toxic indegree remains limited to friction/rivalry; added `tease` to server prompt validation and recoded w4, s2, u8, u16 in the prompt bank/source references. Added a tease-heavy no-toxic-claim regression test.
- **R10 — profile-derived signals:** The engine derives a low-stakes shared-intent note when two players selected the same `tonight` intent. It is private to each person in the pair, requires both reveal-card opt-ins, and explicitly says it is not proof of compatibility. Relationship history and private-crush answers are not used for inference or exposed. Regression checks dual delivery, opt-in gating, and profile privacy.
- **R11 — pick-round density:** Warmup, spicy, and deep now each schedule two pick rounds (six total), while preserving the phase's other formats; `ROUNDS_PER_PHASE` is four. Full-game regression asserts two picks in each heat phase (six total). The focused full-game server test and strict TypeScript check passed.
- **R12 — LAN interface selection:** Added a deterministic preferred IPv4 selector that prioritizes named Wi-Fi/Ethernet interfaces over virtual bridges, VPNs, and tunnel adapters; the banner QR uses that address while still listing all usable LAN IPv4s. Added selection regression with Wi-Fi, hotspot, and Docker interfaces.
- **R13 — deterministic JSONL replay:** Room/player metadata is atomically stored in a mode-0600 sidecar beside the JSONL answer log; at startup the server validates metadata and replays valid records into engine services. A mid-game restart closes into a replayed finale rather than attempting to resume an ephemeral timer/queue. Regression restarts twice and asserts deep-equal results for the same JSONL, then verifies a resumed credential receives the replayed finale.
- **R14 — Grok reveal narration:** Added one guarded Grok reveal call for public slides plus structured private-card copy, with pseudonymized payloads, existing source/number/person/fact validators, deterministic fallback, and no Gemini reveal path. Narrator regression verifies alias scrubbing and safe fallback. Narrator and integrated-service regressions verify pseudonymized request content, exactly one reveal-budget slot, consented private-card narration, filtering of private phrases from public slide copy, and deterministic fallback.
- **R15 — generated prompt share:** The server now prioritizes available Grok-generated prompts in non-pick slots after host-authored prompts, while retaining designated pick slots to preserve the R11 density floor. Regression verifies Grok-over-bank preference and host precedence.
- **R16 — display-role/stage UI:** Added a broadcast-only display join path that does not create a player seat, require consent/profile, or receive private cards. Server sends sanitized public state/round, reveal, interlude, and finale events; display prompts omit personalized assignment/pass metadata. Added `/display?code=...` UI and a lobby link to launch it. Socket regression verifies public stage/finale delivery, no player credentials, no control authority, and zero secret-deck events.
- **R17 — bundle/audit:** The player client remains lazily loaded after the intro; added `npm run bundle:check` to enforce gzip first-load caps (player ≤150 KiB, display ≤120 KiB). Latest production build measured player 145.5 KiB and display 115.8 KiB. `npm audit --audit-level=moderate` reports zero vulnerabilities. No Android/iPhone real-device pass was performed.
- **Automated acceptance verification:** Full workspaces suites pass (server, web SSR, engine including the 11-player perf test, prompts, and narrator); additional UI component checks, mock flow, Socket.IO transport, and `npm run smoke:verified` pass. The verified bot suite covers phases, finale equality, secret ownership/deck limits, duplicate persistence, active/finale resume, dare pass, and deletion. Dedicated protocol regressions cover profiles, assigned rating/IOS targets, solo/pair dares, display privacy, prompt selection, and JSONL replay.

## Follow-up clarifications R18–R20

- **R18 — measured-only pair scoring:** Implemented `PairSignal.componentsUsed`, renormalization over measured components only, and removed the 0.5 debrief unknown default. Measured zero is retained as data; missing components are excluded. Pair confidence counts only independent measured components. Regression covers a picks-only pair scoring 1.0 while yielding no high-confidence claim.
- **R19 — Gemini reveal removal/model override:** Removed Gemini narration from `writeFinale`; it is deterministic template output. Gemini reveal requests are explicitly rejected before network access. `GEMINI_MODEL` is resolved by one shared helper for both provider analysis call sites and the legacy narrator transport helper. Tests assert zero Gemini network calls for finale and override coverage.
- **R20 — deterministic runtime:** No wall-clock APIs/cutoffs exist in `packages/engine/src`. Toxic Monte Carlo is one room-level simulation over all candidates. Noise tests print one line per seed/night; same-log determinism is asserted. For an 11-player / 1,320-pick log, isolated 5-run medians were **362.2 ms before** and **424.5 ms after** the measured-component change (single-process timings were noisy); the final isolated perf test measured **308.2 ms**; a subsequent regression run measured **278.8 ms**, both below the 2 s requirement. No MC change was needed.

## Validation run

- `npm test --workspaces --if-present` — PASS, **238 tests** across server (25), web SSR (39), engine (21, including 11-player performance), narrator (57), and prompts (96).
- `npm run test:components` — PASS, 102 checks.
- `npm run test:mock --workspace @reveal/web` — PASS, 53 mock-flow checks.
- `npm run test:transport --workspace @reveal/web` — PASS, socket transport regression.
- `npm run typecheck` — PASS; `npm run selfcheck` — PASS, 34/34 tunable/invariant checks.
- `npm run smoke:verified` — PASS: phases, finale equality, secret ownership/deck limits, duplicate persistence, active/finale resume, dare pass, deletion.
- `npm run build` — PASS; `npm run bundle:check` — PASS (player 145.5/150 KiB gzip, display 115.8/120 KiB gzip).
- `npm audit --audit-level=moderate` — PASS, zero vulnerabilities.

### REQUIRES HUMAN — 10-minute real-device acceptance (Android + iPhone)

Use the same Wi-Fi/hotspot and a four-player room (the two real phones plus two desktop/browser seats). Record device model, OS version, browser and result for every step.

1. **0:00–1:00 — join/profile:** Open the host URL on Android and the room link/QR on iPhone. Complete profile + consent on both; verify under-18 ages are blocked and neither raw profile is shown in the lobby.
2. **1:00–2:00 — assigned rounds:** On rating and IOS prompts, verify each phone sees a named non-self subject (and rating trait), has no subject dropdown, and can submit successfully.
3. **2:00–4:00 — solo and pair dares:** On solo dare, verify only the named performer can act. On pair dare, verify both assigned phones see the same dare; submit a pass reason on one, then confirm the other cannot mark it done and both reasons are required/recorded.
4. **4:00–5:00 — pick privacy:** Submit picks from both phones; confirm neither phone or public display reveals picker→target identities before the finale.
5. **5:00–6:00 — reconnect/reclaim:** Background the Android browser during a round, return and verify active resume; then clear that tab's site session storage and use alias + room code to reclaim the same seat without creating a duplicate.
6. **6:00–8:00 — display/private separation:** Open `/display?code=ROOM` on a large screen. Verify public stage/finale beats update, display has no player controls/credentials, and secret decks/facts never appear there. Check each opt-in player's private deck only on that player's phone.
7. **8:00–10:00 — restart/final check:** Restart the host server once the room has records; rejoin and verify the persisted log produces the same finale/results. Record any failure, screenshots only if consented, and mark Android and iPhone separately PASS/FAIL.

Until this checklist is completed and recorded, status remains **NO-GO / REQUIRES HUMAN** and no merge is authorized.
