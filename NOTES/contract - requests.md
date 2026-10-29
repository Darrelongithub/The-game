# Contract change requests

Agents do NOT edit `packages/shared`. Append requests here in the format
`AGENT-X | file | what | why` (one line per request). Agent Z resolves them at
merge — Z is the only agent allowed to touch `packages/shared`.

| Agent | File | What | Why |
|---|---|---|---|
| AGENT-E | `packages/shared/src/contracts.ts` | Add the roster (`{ id, alias }[]`, join order) to `Results`, or pass `RoomMeta.players` into the finale pipeline explicitly | `NightDigest` is alias-keyed (quotes/dodges/stats/selfVsRoom) while `Claim` is PlayerId-keyed. The narrator cannot map a digest alias → "Player N" without a crosswalk, so with the 2-arg call it drops attribution instead of guessing. `buildSkeleton(results, digest, meta.players ?? meta)` already accepts it — this is a wiring guarantee request. |
| AGENT-E | `packages/shared/src/contracts.ts` | `NightDigest.contradictions?: { alias: string; text: string }[]` | Spec §15 requires a contradiction slide ("Self-rated honesty 9/10. Passed on the honesty dare. Twice."), but no digest field can carry one and `Results`+`NightDigest` contain no dare↔trait join. The narrator currently derives a weaker self-vs-room + dodge contradiction from `stats.topDodger` + `selfVsRoom`. |
| AGENT-E | `packages/shared/src/contracts.ts` | `NightDigest.stats` needs a spicy+ speed signal (e.g. `fastestSpicy?: { alias: string; ms: number }`) | The SPEED RUNNER slide is specified as "fastest on spicy+ rounds", but `stats.fastest` is all-night and `LogRecord` carries no phase, so the engine cannot compute it either. Today the slide uses the all-night fastest (still engine-sourced, never invented). |
| AGENT-E | `packages/shared/src/contracts.ts` | `FinaleSlide.id?: string` (stable slide identity) | Narration is merged by array index over a stable skeleton. A stable id would make partial/out-of-order model responses safe and let the server re-emit the same finale after a reconnect without index drift. |
