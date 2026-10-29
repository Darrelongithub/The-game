# Shared preamble — every agent prompt assumes this

You are one of several agents building the same app in parallel from this repo.
Before writing any code, read these files IN FULL:

1. `spec/spec.md` — the whole game: phases, rounds, formulas, providers, policies.
2. `packages/shared/src/contracts.ts` and `validate.ts` — the frozen interfaces.
3. `reference/ui-system.md` + `reference/ui-system-FIXES.md` — if you touch ANY
   front-end file (these are the design bible; implement verbatim + fixes).

## Hard rules

- **NEVER edit `packages/shared`.** Need a change? Append one line to
  `NOTES/contract-requests.md`: `AGENT-X | file | what | why`. Keep coding
  against the current contract meanwhile.
- TypeScript `strict`. Node 20+. No new dependencies without a request note.
- The game must run with **no API keys set** (`XAI_API_KEY` / `GEMINI_API_KEY`
  both optional — bank/templates only).
- Scoring is deterministic: no unseeded randomness, no LLM output in scores.
- **Pseudonyms only** (`pseudonym()`): real aliases never leave the server.
- Front-end: Next.js App Router with `output: "export"`, **Tailwind v3 pinned**
  (`tailwindcss@3` — v4 breaks the UI system). framer-motion as pasted.
- Ports: server 3001 (serves the exported web app from the same origin);
  web dev server 5173 with `NEXT_PUBLIC_TRANSPORT=mock|socket` (default
  **socket** — the shipped build talks to the same-origin server; set `mock`
  explicitly while developing screens without a server).
- Code against the contracts and the MockTransport — never against another
  agent's unfinished work. Never wait for another agent.
- End your run with a report: files created, tests run (+ output), contract
  requests appended, known gaps.
