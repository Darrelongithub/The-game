# Contract change requests

Agents do NOT edit `packages/shared`. Append requests here in the format
`AGENT-X | file | what | why` (one line per request). Agent Z resolves them at
merge — Z is the only agent allowed to touch `packages/shared`.

| Agent | File | What | Why |
|---|---|---|---|
| AGENT-A | packages/shared/src/contracts.ts | `RoundView`: add an optional structured payload — `trait?: TraitId`, `about?: PlayerId`, `coding?: PromptCoding` (or one `payload?: Record<string, unknown>`) | A `rating` / `ios` round cannot be answered legally without knowing WHICH trait and WHICH player it asks about: `ResponseValue` requires `trait` + `about`, but `RoundView` only carries `promptText`. The client currently has to guess from prose (Agent A ships a documented shim + graceful fallback). |
| AGENT-A | packages/shared/src/contracts.ts | `ClientToServerEvents.dare_pass`: give it an ack `(r: { ok: boolean; error?: string }) => void` | The "I can't" escape REQUIRES a reason (≤140). Today the phone fires and forgets, so a rejected reason looks identical to an accepted one and the player has no idea their excuse wasn't recorded. |
| AGENT-A | packages/shared/src/contracts.ts | `RoomView`: include the current beat on a reconnect snapshot — optional `interlude?: InterludeView`, `reveal?: RevealView`, `finale?: FinaleView` (broadcast-safe only) | Spec §1 promises reconnect = FULL snapshot, but interludes/reveals/finale are one-shot events with no replay. A phone that wakes up mid-interlude shows a holding screen until the next event, and one that reconnects after the finale never learns the night ended. |
