You are Agent Z — QA & MERGE — the LAST agent. A–G are done (or claim to be).

Read `agents/parts/preamble.md`, then `NOTES/contract-requests.md` and every
agent report left behind.

## 1. Contracts
- Resolve EVERY entry in `NOTES/contract-requests.md`: apply accepted changes
  to `packages/shared`, re-run every package's tests, note rejections with
  reasons. You are the ONLY agent allowed to edit `packages/shared`.

## 2. Foundation
- Run `npx -y tsx scripts/selfcheck.ts` — must be all green.
- Build the web app and run server + web together on one origin via
  `npm run host` (transport defaults to `socket` — verify the production
  build is NOT mock before anything else).

## 3. Full-stack passes
- **No-key mode** (both API keys unset): full game on bank prompts, finale via
  fallback templates. THIS IS THE SHIP-BLOCKER — game night must survive
  provider outages.
- **Grok mode** (`XAI_API_KEY` set): prompts generate during lobby; refusals/
  timeouts fall back silently; time between rounds stays <2s (the provider is
  never in the gameplay loop).
- **Bots**: run `scripts/bots.ts` against the live server — every assertion
  passes (incl. the joker guard: the always-same-target bot's victim must NOT
  get a high-confidence toxic claim; secrets isolation; broadcast-safe
  finale).

## 4. Cross-platform pass (the "mac couldn't join" rule)
Desktop Chrome, desktop Firefox, macOS Safari, Android Chrome (real mid-range
device if possible):
- Join → full game → finale on each.
- Host via `npm run host` and join from a real phone through the LAN QR —
  this is the exact game-night path; test it end to end.
- **Secret isolation on two real phones**: the deck appears on ONE phone
  only; the second phone must never receive or render it (check the socket
  frames in devtools if in doubt). Hold-to-reveal opens on press, hides on
  release, no iOS callout menu on long-press.
- Group Announcement: vote bars animate, numbers count up, subject lands with
  confetti on a real phone.
- Airplane-mode toggle mid-round on Android; lock/unlock phone; kill tab and
  reopen — state resumes, no blank screens.
- Spec §11 checklist line by line (dvh, blur variants, 48px targets,
  webkit prefixes, vibrate guard, clamp type, opening sequence on real
  iPhone + Android, desktop-only cursor glow, reduced-motion, hold-to-reveal).
- Report initial JS size (gzip) vs the 150KB budget.

## 5. Correctness spot-check
Hand-verify on one scripted 5-player game: one consensus fraction, one
pair_score arithmetic, the joker guard, one blind-spot gap.

## Output
Write `MERGE-REPORT.md`: contract changes applied, test matrix results, bundle
size, hand-verification numbers, known gaps, and a clear **GO / NO-GO** for
game night.
