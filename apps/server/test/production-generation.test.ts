// apps/server/test/production-generation.test.ts
// The production wiring must actually reach Ollama. It used to create the
// provider but hand the facade no fetch, so every night logged
// "unavailable:disabled" and quietly used the bank.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProductionServices } from "../src/integratedServices.ts";

describe("the production generation lane", () => {
  it("sends the night's batches to the configured Ollama endpoint", async () => {
    const oldBase = process.env.GEN_BASE;
    const oldModel = process.env.GEN_MODEL;
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    process.env.GEN_BASE = "http://127.0.0.1:11500";
    process.env.GEN_MODEL = "fake-model";
    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push(String(url));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message: { content: "Who in this room would you take home tonight?" } }),
      } as Response;
    }) as typeof fetch;

    try {
      const services = createProductionServices();
      const provider = services.createPromptProvider({
        roomId: "GEN1",
        playerCount: 5,
        seed: 3,
        aliases: ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo"],
        log: () => {},
      });
      const prompts = await provider.generate!();
      assert.ok(calls.length > 0, "the production lane made no HTTP call at all");
      assert.ok(calls.every((url) => url.startsWith("http://127.0.0.1:11500/")), calls.join(", "));
      assert.ok(calls.some((url) => url.endsWith("/api/chat")), "the native Ollama shape is tried first");
      assert.ok(prompts.length > 100, "the bank still carries the rest of the night");
      assert.ok(prompts.some((prompt) => prompt.source === "bank"));
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBase === undefined) delete process.env.GEN_BASE;
      else process.env.GEN_BASE = oldBase;
      if (oldModel === undefined) delete process.env.GEN_MODEL;
      else process.env.GEN_MODEL = oldModel;
    }
  });
});
