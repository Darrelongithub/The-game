# Contract change requests

Agents do NOT edit `packages/shared`. Append requests here in the format
`AGENT-X | file | what | why` (one line per request). Agent Z resolves them at
merge — Z is the only agent allowed to touch `packages/shared`.

| Agent | File | What | Why |
|---|---|---|---|
| AGENT-D | packages/shared/src/contracts.ts | add optional `trait?: TraitId` to `Prompt` (and to `RoundView` for rating rounds) | the client cannot render a 1–10 rating about "a trait" without knowing WHICH trait; today we stamp a `trait:<id>` measure on every rating prompt as a stopgap, which B1/F must read |
| AGENT-D | packages/shared/src/contracts.ts | add optional `callback?: boolean` (or `quote?: string`) to `Prompt` | the server/engine cannot tell which generated prompts are verbatim Night-Digest callbacks; today we re-detect by substring-matching the prompt text against the digest quotes |
| AGENT-D | packages/shared/src/contracts.ts | confirm `PROVIDERS.grok.generate = "grok-4-1-fast"` before game night (docs.x.ai was unreachable from the build sandbox) | a 404 on the model id degrades silently to bank-only; we added an `XAI_MODEL` env override as a stopgap so the host can fix it without a contract edit |
| AGENT-D | packages/shared/src/contracts.ts | `SAFETY_OFF` thresholds: classic `v1beta:generateContent` rejects `"OFF"` and expects `"BLOCK_NONE"` (the literal "OFF" belongs to the newer interactions API) | we map OFF→BLOCK_NONE for the classic endpoint and retry once with the literal contract value on a 400, but the contract comment should say which surface it targets |
| AGENT-D | packages/shared/src/validate.ts | export `isPrompt(p: unknown): p is Prompt` | the bank loader, the Grok filter and the host-custom-line parser all re-implement the same prompt-shape check; one shared guard stops three copies drifting apart |
| AGENT-A | packages/shared/src/contracts.ts | `RoundView`: add an optional structured payload — `trait?: TraitId`, `about?: PlayerId`, `coding?: PromptCoding` (or one `payload?: Record<string, unknown>`) | A `rating` / `ios` round cannot be answered legally without knowing WHICH trait and WHICH player it asks about: `ResponseValue` requires `trait` + `about`, but `RoundView` only carries `promptText`. The client currently has to guess from prose (Agent A ships a documented shim + graceful fallback). |
| AGENT-A | packages/shared/src/contracts.ts | `ClientToServerEvents.dare_pass`: give it an ack `(r: { ok: boolean; error?: string }) => void` | The "I can't" escape REQUIRES a reason (≤140). Today the phone fires and forgets, so a rejected reason looks identical to an accepted one and the player has no idea their excuse wasn't recorded. |
| AGENT-A | packages/shared/src/contracts.ts | `RoomView`: include the current beat on a reconnect snapshot — optional `interlude?: InterludeView`, `reveal?: RevealView`, `finale?: FinaleView` (broadcast-safe only) | Spec §1 promises reconnect = FULL snapshot, but interludes/reveals/finale are one-shot events with no replay. A phone that wakes up mid-interlude shows a holding screen until the next event, and one that reconnects after the finale never learns the night ended. |
