# Reveal Game Kit — build repo

Everything needed to build the game with parallel AI agents. The kit is the
professor; the agents are the workers.

spec/spec.md                      the whole game (read this first)
packages/shared/src/contracts.ts  FROZEN interfaces + constants + tunables
packages/shared/src/validate.ts   FROZEN runtime guards
scripts/selfcheck.ts              run this BEFORE spawning agents
agents/parts/preamble.md          rules every agent follows
agents/paste/agent-A.md … Z.md    one paste-ready prompt per agent session
reference/research-brief.md       research + the 40 seed prompts (§1)
reference/unhinged-tier.md        u1–u27 spicy/sexual tier (SPICY_TIER)
reference/ui-system.md            THE UI (paste your UI code here verbatim)
reference/ui-system-FIXES.md      7 fixes that must be applied to it
NOTES/contract-requests.md        agents append; Agent Z resolves
.env.example                      copy to .env — every key optional

## Setup (2 minutes)
1. Put the UI code in `reference/ui-system.md` (the paste from your UI agent).
2. Run `npx -y tsx scripts/selfcheck.ts` — must print ALL CHECKS PASSED.
3. Copy `.env.example` → `.env`. Every setting is optional. The handwritten
   bank runs the whole night even if every provider is unavailable.
   - **Local generation (no key):** install Ollama on the host laptop, start its
     service, and run `ollama pull dolphin-mistral`. The Node server connects to
     `GEN_BASE=http://localhost:11434/v1` using `GEN_MODEL=dolphin-mistral`.
     Phones never connect directly to Ollama. After downloading the model,
     generation requires no internet. See `RUNBOOK.md` for setup and fallback.
   - Existing optional cloud analysis/reveal configuration is unchanged;
     no cloud key is needed for local generation.

## Run it (game night)
`npm run host` — builds the web app, starts the server on your LAN
(`0.0.0.0:3001`), prints the LAN URL + a QR code in the terminal. Friends on
the same WiFi (or your phone hotspot) scan and play. `npm start` re-hosts
without rebuilding.

## Spawn order (maximum parallelism)
- **Wave 1 (all at once):** A, B1, B2, C, D, E, F, G — one session each,
  paste the matching file from `agents/paste/`.
- **Wave 2 (after all report done):** Z — resolves contract requests, wires
  the real transport, runs bots + cross-platform pass, writes MERGE-REPORT.md
  with GO / NO-GO.

Why 9 and not 20: every extra agent adds contract churn that Agent Z must
arbitrate; the critical path is B1+F regardless. 9 is the max parallelism that
doesn't slow the merge down.

## The four rules
1. `packages/shared` is frozen — requests go to `NOTES/contract-requests.md`.
2. Code against contracts + MockTransport, never another agent's WIP.
3. Fully playable with no API keys — the bank runs the whole night, offline.
4. The LLM never produces a number — scoring is deterministic code.
