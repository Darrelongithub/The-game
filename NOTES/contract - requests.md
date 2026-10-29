# Contract change requests

Agents do NOT edit `packages/shared`. Append requests here in the format
`AGENT-X | file | what | why` (one line per request). Agent Z resolves them at
merge — Z is the only agent allowed to touch `packages/shared`.

| Agent | File | What | Why |
|---|---|---|---|
| AGENT-C | packages/shared/src/contracts.ts | add a stable `id` to `LogRecord` (or bless a composite recordId) | the toxic `tagOf(recordId)` seam has no id to key on; engine exports `logRecordId()` = roomId:roundId:promptId:playerId:at meanwhile |
| AGENT-C | packages/shared/src/contracts.ts | add optional pair grouping for debrief records (e.g. `pairId` or `onlyPlayers` on `LogRecord`) | `debriefSim` must infer pair_dare partners; engine falls back to roundId -> promptId -> exactly-two-writers heuristics |
| AGENT-C | packages/shared/src/contracts.ts | clarify whether `RoomMeta.revealOptIn` gates the whole secret deck or only spark/one-sided | engine gates spark (both players) + onesided card (picker); blindspot/roomnote/stat cards are ungated meanwhile |
| AGENT-C | packages/engine/package.json | NEW DEV DEPS ONLY: `typescript`, `tsx`, `@types/node` (zero runtime dependencies) | strict typecheck + node:test suite for the engine package, standalone before Agent G's root workspaces land |
