import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { Provider, createPromptProvider } from "../src/index.ts";
import { candidate } from "./helpers.ts";

test("local HTTP generation augments the bank; missing model leaves a playable bank", async (t) => {
  const requests: { url?: string; authorization?: string; model: string }[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as { model: string };
    requests.push({ url: req.url, authorization: req.headers.authorization, model: body.model });
    res.setHeader("content-type", "application/json");
    if (body.model === "missing-model") {
      res.writeHead(404).end(JSON.stringify({ error: "model not found" }));
    } else {
      res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ prompts: [candidate()] }) } }] }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/v1`;
  const provider = new Provider({ env: { GEN_BASE: base } });
  const facade = createPromptProvider({ provider, playerCount: 6, room: "local-http" });
  const generated = await facade.generateInBackground("spicy");
  assert.equal(generated.length, 1);
  assert.deepEqual(requests[0], { url: "/v1/chat/completions", authorization: undefined, model: "dolphin-mistral" });
  assert.equal(provider.canAnalyze(), false);

  const missing = createPromptProvider({
    provider: new Provider({ env: { GEN_BASE: base, GEN_MODEL: "missing-model" } }),
    playerCount: 6, room: "missing-http",
  });
  assert.deepEqual(await missing.generateInBackground("spicy"), []);
  assert.equal(missing.generationState("spicy").lastReason, "http");
  for (const phase of ["warmup", "spicy", "deep", "dare"] as const) {
    const prompts = missing.forPhase(phase, 3);
    assert.equal(prompts.length, 3);
    assert.ok(prompts.every((prompt) => prompt.source === "bank"));
  }
});
