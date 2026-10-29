# Contract change requests

Agents do NOT edit `packages/shared`. Append requests here in the format
`AGENT-X | file | what | why` (one line per request). Agent Z resolves them at
merge — Z is the only agent allowed to touch `packages/shared`.

| Agent | File | What | Why |
|---|---|---|---|
| AGENT-B2 | root package.json (devDeps) | add `jsdom` (dev-only) so `npx tsx apps/web/src/components/__tests__/run.tsx` runs | B2's 102-check behavioral suite (hold-to-reveal, confetti gates, opening-sequence timers, share PNG) renders the real components in jsdom; runtime app deps unchanged |
