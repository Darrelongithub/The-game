# Agent G — Step 1: local generation

Implemented prompt-generation-only config and routing:
- `GEN_BASE`: `http://localhost:11434/v1` by default.
- `GEN_MODEL`: `dolphin-mistral` by default; explicit GEN_MODEL wins over
  legacy XAI_MODEL. Blank env values fall back.
- Generation needs no API key and sends no Authorization header.
- Existing validation, pseudonym redaction, deadlines, budget, and bank fallback
  remain in place. Legacy `grok` lane/source labels are retained for compatibility.
- Non-generation routing/model selection is unchanged.

Files changed: `.env.example`, `packages/prompts/src/provider.ts`,
`packages/prompts/README.md`, `packages/prompts/test/provider.test.ts`,
`packages/prompts/test/generate.test.ts`,
`apps/server/test/provider-integration.test.ts`. This report is newly created.
No dependencies or shared-contract changes; no contract requests appended.

Regression results:
- `npm run test --workspace @reveal/prompts`: 106 tests, 106 pass, 0 fail.
- `npm run typecheck --workspace @reveal/prompts`: exit 0.
- `npx tsx --test apps/server/test/provider-integration.test.ts`: 5 pass, 0 fail.
- `npm run test --workspace @reveal-game/server`: 68 pass, 0 fail.
- `git diff --check`: exit 0.

Initial server regression failed because its HTTP fixture classified only xAI
URLs as OpenAI-compatible. Updated that fixture to recognize local generation;
full suite rerun passed.

Known gaps / checkout discrepancy:
- Real Ollama/model inference on the host laptop was not exercised in this
  sandbox. Tests use synthetic HTTP responses, including service failure.
- This checkout's analysis resolver defaults to gemini-3.1-pro-preview and its
  reveal path uses Grok (Gemini reveal is explicitly disabled). `.env.example`
  already pins GEMINI_MODEL=gemini-3.5-flash-lite. Per the instruction not to
  touch analysis/reveal, those runtime paths and shared defaults are preserved.

## Completion pass — setup docs and real HTTP transport

Created `packages/prompts/test/local-http.test.ts`: starts an ephemeral local
OpenAI-compatible HTTP server and exercises native fetch through the production
Provider/facade. Confirms the endpoint, default model, absence of authentication,
validated generation, and playable bank prompts across every phase after a
model-not-found HTTP response. This is a protocol regression, not real Ollama
inference.

Updated `README.md`, `RUNBOOK.md`, and `apps/server/README.md` with local model
installation/download, host-local networking, optional health check, environment
precedence, restart guidance, and the existing timeout/fallback behavior.

Completion regression results:
- Prompt suite: 107 tests, 107 pass, 0 fail.
- Prompt typecheck: exit 0.
- Root `npm run typecheck`: exit 0 (all configured workspaces).
- Root `npm run selfcheck`: ALL 36 CHECKS PASSED.
- `git diff --check`: exit 0.

No additional contract requests or dependencies. Real host-laptop inference
remains the only environment-specific verification not performed here.
