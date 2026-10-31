// packages/prompts/test/night.test.ts
// THE SHIP-BLOCKER, from this package's side: with ZERO API keys the bank must
// carry a whole night — warmup → spicy → deep → dare, including the pair-dare
// and its two private debriefs — for the smallest and largest legal rooms.
import test from "node:test";
import assert from "node:assert/strict";
import { createPromptProvider, type Prompt, type PromptPhase } from "../src/index.ts";

function playNight(playerCount: number, spicy: boolean): Prompt[] {
  const provider = createPromptProvider({ playerCount, provider: null, spicy, room: `night-${playerCount}` });
  const used: Prompt[] = [];
  const take = (phase: PromptPhase, n: number) => {
    const picked = provider.forPhase(phase, n, used.map((p) => p.id));
    used.push(...picked);
    return picked;
  };

  for (const phase of ["warmup", "spicy", "deep"] as const) {
    for (let i = 0; i < 3; i += 1) assert.equal(take(phase, 1).length, 1, `${phase} round ${i} came up empty`);
  }
  // Dare phase: solo dares until the night has its pair_dare and its debrief
  // template (the server opens two private debriefs off the pair round).
  for (let i = 0; i < 6 && !used.some((p) => p.kind === "pair_dare"); i += 1) take("dare", 1);
  for (let i = 0; i < 6 && !used.some((p) => p.kind === "debrief"); i += 1) take("dare", 1);
  take("dare", 2); // two solo dares for flavour
  return used;
}

test("a full no-key night runs on the bank for 4 players", () => {
  const prompts = playNight(4, true);
  assert.ok(prompts.length >= 13);
  assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length, "no prompt repeats in a night");
  assert.ok(prompts.every((p) => p.source === "bank"));
  assert.ok(prompts.every((p) => p.measures.length > 0 && p.coding));
  assert.ok(prompts.some((p) => p.kind === "pair_dare"), "the night needs its pair_dare");
  assert.ok(prompts.some((p) => p.kind === "debrief"), "the night needs a debrief template");
});

test("a full no-key night runs on the bank for 11 players", () => {
  const prompts = playNight(11, true);
  assert.equal(new Set(prompts.map((p) => p.id)).size, prompts.length);
  assert.ok(prompts.some((p) => /\{P\d+\}/.test(p.text)), "a big room should get placeholder prompts");
});

test("a tame night (SPICY_TIER off) is still a complete night", () => {
  const prompts = playNight(6, false);
  assert.ok(prompts.length >= 13);
  assert.ok(prompts.every((p) => !/^u\d+$/.test(p.id)));
  assert.ok(prompts.every((p) => p.measures.length > 0));
});

test("every night can reach every phase's minimum round count from the bank alone", () => {
  for (const spicy of [true, false]) {
    const provider = createPromptProvider({ playerCount: 5, provider: null, spicy });
    for (const phase of ["warmup", "spicy", "deep"] as const) {
      // 3 rounds per phase + headroom for the server asking twice.
      assert.ok(provider.forPhase(phase, 6).length >= 6, `${phase} lacks headroom (spicy=${spicy})`);
    }
    const dare = provider.forPhase("dare", 6);
    assert.ok(dare.length >= 6, `dare lacks headroom (spicy=${spicy})`);
    assert.ok(dare.some((p) => p.kind === "dare"));
    assert.ok(dare.some((p) => p.kind === "pair_dare"));
    assert.ok(dare.some((p) => p.kind === "debrief"));
  }
});

test("the whole night makes ZERO provider calls and never throws", async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("network access in a no-key night");
  }) as typeof fetch;
  try {
    const provider = createPromptProvider({ playerCount: 5, provider: null });
    const night = [...provider.forPhase("warmup", 3), ...provider.forPhase("spicy", 3), ...provider.forPhase("deep", 3)];
    assert.equal(provider.canGenerate(), false);
    assert.deepEqual(await provider.generateInBackground("spicy"), []);
    assert.ok(night.length === 9);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
