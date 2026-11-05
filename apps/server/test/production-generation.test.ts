// apps/server/test/production-generation.test.ts
// The production wiring must actually reach Ollama. It used to create the
// provider but hand the facade no fetch, so every night logged
// "unavailable:disabled" and quietly used the bank.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createProductionServices } from "../src/integratedServices.ts";
import { RoomManager } from "../src/room.ts";
import { roomViewFor } from "../src/game.ts";
import { ManualClock, adultProfile, testServices } from "./helpers.ts";
import { fakeOllamaContent } from "../../../scripts/fake-ollama.ts";
import { createPromptProvider } from "../../../packages/prompts/src/index.ts";

describe("the production generation lane", () => {
  it("sends the night's batches to the configured Ollama endpoint", async () => {
    const oldBase = process.env.GEN_BASE;
    const oldModel = process.env.GEN_MODEL;
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    process.env.GEN_BASE = "http://127.0.0.1:11500";
    process.env.GEN_MODEL = "fake-model";
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push(String(url));
      const body = typeof init?.body === "string" ? init.body : "";
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message: { content: fakeOllamaContent(body) } }),
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
      assert.ok(prompts.length > 20, "the model wrote a night's worth of questions");
      assert.ok(prompts.every((prompt) => prompt.source === "ollama"), "no bank line is played");
      assert.ok(!prompts.some((prompt) => prompt.source === "bank"));
    } finally {
      globalThis.fetch = originalFetch;
      if (oldBase === undefined) delete process.env.GEN_BASE;
      else process.env.GEN_BASE = oldBase;
      if (oldModel === undefined) delete process.env.GEN_MODEL;
      else process.env.GEN_MODEL = oldModel;
    }
  });
});

describe("a failed generation", () => {
  it("keeps the room in the lobby and shows the error instead of using the bank", async () => {
    const clock = new ManualClock();
    const services = {
      ...testServices(),
      createPromptProvider: () => ({
        draw: () => [],
        usedPromptIds: () => [],
        async generate() {
          throw new Error("Ollama is unreachable at http://127.0.0.1:11434. Check GEN_BASE.");
        },
      }),
    };
    const manager = new RoomManager(null, {
      now: clock.now,
      services,
      rand: () => 0.5,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const room = manager.createRoom();
    for (const alias of ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo"]) {
      assert.equal(manager.join(room.code, alias, adultProfile, true).ok, true);
    }
    await manager.start(room.code);
    assert.equal(room.phase, "lobby", "a failed night never starts");
    assert.match(room.generationError ?? "", /Ollama is unreachable/);
    assert.equal(room.cases.length, 0);
    assert.equal(roomViewFor(room, room.order[0]!, clock.now()).generationError?.includes("GEN_BASE"), true);
  });

  it("keeps the room in the lobby when the returned night cannot be dealt", async () => {
    const clock = new ManualClock();
    const services = {
      ...testServices(),
      createPromptProvider: () => ({
        mode: () => "ollama" as const,
        draw: () => [],
        lookChains: () => [],
        bestCouplePrompt: () => undefined,
        watcherPrompt: () => undefined,
        usedPromptIds: () => [],
        async generate() {
          return [];
        },
      }),
    };
    const manager = new RoomManager(null, {
      now: clock.now,
      services,
      rand: () => 0.5,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const room = manager.createRoom();
    for (const alias of ["Wanjiru", "Dee", "Kofi", "Zuri"]) {
      assert.equal(manager.join(room.code, alias, adultProfile, true).ok, true);
    }
    await manager.start(room.code);
    assert.equal(room.phase, "lobby");
    assert.match(room.generationError ?? "", /look-chain copy/);
    assert.equal(room.cases.length, 0);
  });
});


describe("a generated night", () => {
  it("plans every segment from Ollama, including dares, chains and the best couple", async () => {
    const aliases = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo", "Amara", "Bash"];
    const provider = createPromptProvider({
      playerCount: aliases.length,
      seed: 21,
      aliases,
      fetchImpl: async (_url: string, init?: { body?: string }) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          message: { role: "assistant", content: fakeOllamaContent(String(init?.body ?? "{}")) },
        }),
      }),
    });
    const clock = new ManualClock();
    const services = { ...testServices(), createPromptProvider: () => provider };
    const manager = new RoomManager(null, {
      now: clock.now,
      services,
      rand: () => 0.37,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const room = manager.createRoom();
    for (const alias of aliases) assert.equal(manager.join(room.code, alias, adultProfile, true).ok, true);
    await manager.start(room.code);
    assert.equal(room.phase, "play", room.generationError);
    assert.ok(room.cases.length > 0);
    const segments = room.cases.flatMap((c) => c.segments);
    assert.ok(segments.every((segment) => !/\{P\d+\}/.test(segment.text)), "no raw placeholder reaches a phone");
    assert.ok(segments.every((segment) => segment.prompt.source === "ollama"), "a bank prompt was played");
    assert.ok(segments.some((segment) => segment.kind === "dare"), "a generated dare is planned");
    assert.ok(segments.some((segment) => segment.id.endsWith("-watch")), "a generated watcher segment is planned");
    assert.ok(segments.some((segment) => segment.kind === "pair_pick"), "the generated best-couple pick is planned");
  });

  it("gives the leftover seat a solo question in every even-room case", async () => {
    const aliases = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo", "Amara"];
    const provider = createPromptProvider({
      playerCount: aliases.length,
      seed: 8,
      aliases,
      fetchImpl: async (_url: string, init?: { body?: string }) => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          message: { role: "assistant", content: fakeOllamaContent(String(init?.body ?? "{}")) },
        }),
      }),
    });
    const clock = new ManualClock();
    const services = { ...testServices(), createPromptProvider: () => provider };
    const manager = new RoomManager(null, {
      now: clock.now,
      services,
      rand: () => 0.41,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const room = manager.createRoom();
    for (const alias of aliases) assert.equal(manager.join(room.code, alias, adultProfile, true).ok, true);
    await manager.start(room.code);
    assert.equal(room.phase, "play", room.generationError);
    const ordinary = room.cases.filter((c) => c.segments.some((s) => s.id.endsWith("-subject")));
    assert.ok(ordinary.length >= 9, `only ${ordinary.length} ordinary cases`);
    for (const built of ordinary) {
      const covered = new Set(built.segments.flatMap((s) => s.players));
      assert.deepEqual([...covered].sort(), [...room.order].sort(), "one seat was left without a question");
      assert.ok(built.segments.some((s) => s.id.endsWith("-solo")), "the leftover got a solo question");
      assert.ok(built.segments.every((s) => s.prompt.source === "ollama"), "a bank line slipped into an even room");
    }
  });
});
