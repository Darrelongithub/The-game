// packages/prompts/test/facade.test.ts
// The prompt FACADE — the object the server actually talks to.
//
// The rules under test:
//   • The night OPENS hot: the opening prompts come from the spicy tier.
//   • Two prompts of the same TYPE never land back to back.
//   • A template is never used twice in one night.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPromptProvider, promptTypeKey } from "../src/index.ts";

describe("the prompt facade", () => {
  it("opens the night with the spicy tier", () => {
    const provider = createPromptProvider({ playerCount: 6, seed: 11, offline: true });
    const opening = provider.draw({ role: "observer_subject", count: 6 });
    assert.ok(opening.length > 0, "no opening prompts drawn");
    for (const prompt of opening) {
      assert.equal(prompt.band, "spicy", `opening prompt ${prompt.id} is not spicy`);
    }
  });

  it("never plays two prompts of the same type back to back", () => {
    const provider = createPromptProvider({ playerCount: 6, seed: 5, offline: true });
    const played: string[] = [];
    for (let i = 0; i < 8; i++) {
      const batch = provider.draw({ role: "observer_subject", count: 2 });
      for (const prompt of batch) played.push(promptTypeKey(prompt));
    }
    for (let i = 1; i < played.length; i++) {
      assert.notEqual(played[i], played[i - 1], "two prompts of the same type landed back to back");
    }
  });

  it("never uses a template twice in one night", () => {
    const provider = createPromptProvider({ playerCount: 6, seed: 3, offline: true });
    const used = new Set<string>();
    for (let i = 0; i < 10; i++) {
      for (const prompt of provider.draw({ role: "observer_subject", count: 2 })) {
        assert.ok(!used.has(prompt.id), `template ${prompt.id} was used twice`);
        used.add(prompt.id);
      }
    }
  });
});
