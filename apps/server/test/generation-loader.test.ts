// apps/server/test/generation-loader.test.ts
// Start shows the loader while the model writes, and the first question waits
// for generation. A hardcoded 0/40 with no polling used to hide the work.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoomManager } from "../src/room.ts";
import { BANK, selectFromBank } from "../../../packages/prompts/src/index.ts";
import type { Prompt, RoomView } from "../../../packages/shared/src/contracts.ts";
import type { PromptProvider, PromptProviderContext } from "../src/services.ts";
import { adultProfile, FakeSocket, ManualClock, testServices } from "./helpers.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("the generation loader", () => {
  it("counts batches while generating and deals nothing until generation resolves", async () => {
    const clock = new ManualClock();
    const gate = deferred();
    let ready = 0;
    let providerCreated = false;

    const services = {
      ...testServices(),
      createPromptProvider: (context: PromptProviderContext): PromptProvider => {
        const used = new Set<string>();
        return {
          draw: ({ role, count, kinds }) => {
            const picked = selectFromBank(count, {
              role,
              playerCount: context.playerCount,
              seed: context.seed,
              excludeIds: [...used],
              ...(kinds ? { kinds } : {}),
            });
            for (const prompt of picked) used.add(prompt.id);
            return picked;
          },
          usedPromptIds: () => [...used],
          generate: async (): Promise<Prompt[]> => {
            providerCreated = true;
            await gate.promise;
            return [...BANK];
          },
          generationProgress: () => ({ done: ready, total: 40 }),
        };
      },
    };

    const manager = new RoomManager(null, {
      now: clock.now,
      services,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const room = manager.createRoom();
    const sockets: FakeSocket[] = [];
    for (const alias of ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo"]) {
      const result = manager.join(room.code, alias, adultProfile, true);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      const socket = new FakeSocket(alias);
      socket.playerId = result.player.id;
      manager.attachSocket(room.code, socket);
      sockets.push(socket);
    }

    const starting = manager.start(room.code);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(providerCreated, true, "Start must ask the provider to generate");
    assert.equal(room.phase, "generating");
    for (const socket of sockets) {
      const view = socket.last<RoomView>("state");
      assert.equal(view?.phase, "generating", "every phone shows the loader");
      assert.deepEqual(view?.generation, { done: 0, total: 40 });
      assert.equal(socket.payloads("round").length, 0, "no question before generation");
    }

    ready = 7;
    clock.advance(250);
    for (const socket of sockets) {
      const view = socket.last<RoomView>("state");
      assert.equal(view?.phase, "generating");
      assert.deepEqual(view?.generation, { done: 7, total: 40 }, "the loader counts real batches");
      assert.equal(socket.payloads("round").length, 0, "still no question before generation");
    }

    gate.resolve();
    await starting;

    assert.equal(room.phase, "play");
    for (const socket of sockets) {
      assert.ok(socket.payloads("round").length > 0, "the first question is dealt after generation");
      assert.ok(socket.payloads<RoomView>("state").some((view) => view.phase === "play"));
    }

    const states = sockets[0]!.payloads("state").length;
    clock.advance(2_000);
    assert.equal(sockets[0]!.payloads("state").length, states, "the poll timer stops when generation ends");
  });
});
