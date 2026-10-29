// packages/prompts/test/facade.test.ts
// PromptProvider.forPhase(phase, n, used) — bank-first, always. Generated
// prompts only ever AUGMENT; host lines are tonight-only and vetted.
import test from "node:test";
import assert from "node:assert/strict";
import {
  PromptProvider,
  bankForPhase,
  bankCounts,
  createPromptProvider,
  parseHostLines,
  inferKind,
  traitOfPrompt,
} from "../src/index.ts";
import { candidate, grokReply, makeProvider, mockFetch } from "./helpers.ts";

test("no keys: a full night of bank prompts, zero network", () => {
  const provider = createPromptProvider({ playerCount: 6, room: "r1", provider: null });
  assert.equal(provider.canGenerate(), false);
  assert.equal(provider.canAnalyze(), false);
  assert.equal(provider.remainingCalls(), 0);

  const warmup = provider.forPhase("warmup", 3);
  assert.equal(warmup.length, 3);
  assert.ok(warmup.every((p) => p.source === "bank" && p.phase === "warmup"));

  // A whole night: 3 warmup + 3 spicy + 3 deep + 2 dares + pair rounds.
  const night = [
    ...provider.forPhase("spicy", 3),
    ...provider.forPhase("deep", 3),
    ...provider.forPhase("dare", 3),
  ];
  assert.equal(night.length, 9);
  assert.equal(new Set(night.map((p) => p.id)).size, 9, "prompts must not repeat");
  assert.ok(night.some((p) => p.kind === "pair_dare" || p.kind === "debrief"), "the dare phase needs pair rounds");
});

test("forPhase is deterministic and never repeats across calls", () => {
  const a = createPromptProvider({ playerCount: 6, provider: null });
  const b = createPromptProvider({ playerCount: 6, provider: null });
  assert.deepEqual(a.forPhase("deep", 3).map((p) => p.id), b.forPhase("deep", 3).map((p) => p.id));

  const first = a.forPhase("deep", 3).map((p) => p.id);
  const second = a.forPhase("deep", 3).map((p) => p.id);
  assert.equal(second.filter((id) => first.includes(id)).length, 0, "the second call must not repeat prompts");
});

test("explicit usedIds are excluded (restored from the room log)", () => {
  const provider = createPromptProvider({ playerCount: 6, provider: null });
  const used = bankForPhase("warmup", { spicy: true }).slice(0, 4).map((p) => p.id);
  const picked = provider.forPhase("warmup", 3, used);
  assert.ok(picked.every((p) => !used.includes(p.id)));
});

test("player count gates {Pn} prompts", () => {
  const provider = createPromptProvider({ playerCount: 4, provider: null });
  for (const phase of ["warmup", "spicy", "deep", "dare"] as const) {
    for (const prompt of provider.forPhase(phase, 12)) {
      assert.ok(!/\{P([5-9]|1[01])\}/.test(prompt.text), `${prompt.id} needs more than 4 players`);
    }
  }
});

test("SPICY_TIER off: no unhinged prompt is ever served", () => {
  const provider = createPromptProvider({ playerCount: 8, spicy: false, provider: null });
  assert.deepEqual(provider.counts(), bankCounts({ spicy: false }));
  const all = [
    ...provider.forPhase("spicy", 20),
    ...provider.forPhase("deep", 20),
    ...provider.forPhase("dare", 20),
  ];
  assert.ok(all.every((p) => !/^u\d+$/.test(p.id)));
});

test("host custom lines: prefixes, phase placement, and honest rejections", () => {
  const lines = [
    "spicy: Who here would you avoid being alone with, and why?",
    "dare: Let {P2} pick your next haircut, no veto.",
    "deep: What's something you've only ever told one person in this room?",
    "Tell me about your commute.", // not room-directed → rejected
    "Who here is the best cook? Point.", // no prefix → spicy slot
    "Rate {P3}'s chaos, 1–10.", // inferred rating + trait stamp
    "Who here would survive a zombie outbreak? Point.", // banned
  ];
  const { prompts, rejected } = parseHostLines(lines);
  assert.equal(prompts.length, 5);
  assert.equal(prompts[0]!.source, "host");
  assert.equal(prompts[0]!.phase, "spicy");
  assert.equal(prompts[1]!.phase, "dare");
  assert.equal(prompts[1]!.kind, "dare");
  assert.equal(prompts[2]!.phase, "deep");
  assert.equal(prompts[3]!.phase, "spicy");
  assert.equal(prompts[4]!.kind, "rating");
  assert.ok(traitOfPrompt(prompts[4]!), "a host rating line needs a readable trait");

  const reasons = rejected.map((r) => r.reason);
  assert.ok(reasons.includes("not-room-directed"));
  assert.ok(reasons.includes("banned"));

  const provider = createPromptProvider({ playerCount: 6, provider: null, customPrompts: lines });
  const spicy = provider.forPhase("spicy", 3);
  assert.ok(spicy.some((p) => p.source === "host"), "host lines lead their phase");
});

test("host limits: 10 lines max and 160 chars each", () => {
  const many = Array.from({ length: 12 }, (_, i) => `Who here would you lend book ${i + 1} to, and why?`);
  const { prompts, rejected } = parseHostLines(many);
  assert.equal(prompts.length, 10);
  assert.equal(rejected.filter((r) => r.reason === "too-many").length, 2);

  const long = parseHostLines([`Who here ${"really ".repeat(30)}cares?`]);
  assert.equal(long.prompts.length, 0);
  assert.equal(long.rejected[0]!.reason, "too-long");
});

test("kind inference for host lines is deterministic", () => {
  assert.equal(inferKind("Who here would you call first? Point.", "warmup"), "pick");
  assert.equal(inferKind("Rate {P2}'s loyalty 1–10.", "warmup"), "rating");
  assert.equal(inferKind("How close are you and {P3}? Circles.", "warmup"), "ios");
  assert.equal(inferKind("Tap war: go.", "warmup"), "minigame");
  assert.equal(inferKind("One word for this room.", "spicy"), "shout");
  assert.equal(inferKind("Tell us the thing you never said.", "deep"), "text");
  assert.equal(inferKind("You two: five minutes alone.", "dare"), "pair_dare");
});

test("augmented (generated) prompts only fill in after the bank", async () => {
  const mock = mockFetch(() =>
    grokReply(
      JSON.stringify([
        candidate({ text: "Who here would you trust to fake your alibi without asking why?" }),
      ]),
    ),
  );
  const lane = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const provider = new PromptProvider({ playerCount: 5, room: "r1", provider: lane });

  // Bank-first: the very first call is bank content even with a live lane.
  const first = provider.forPhase("spicy", 2);
  assert.ok(first.every((p) => p.source === "bank"));

  const generated = await provider.generateInBackground("spicy", { count: 1 });
  assert.equal(generated.length, 1);
  assert.equal(generated[0]!.source, "grok");
  assert.equal(provider.generatedFor("spicy").length, 1);
  assert.equal(provider.generationState("spicy").accepted, 1);
  assert.equal(provider.generationState("spicy").inFlight, false);

  // Exhaust the bank → the generated prompt is now served.
  const usedBank = bankForPhase("spicy", { spicy: true }).map((p) => p.id);
  const topped = provider.forPhase("spicy", 1, usedBank);
  assert.equal(topped.length, 1);
  assert.equal(topped[0]!.source, "grok");
  assert.equal(mock.calls.length, 1);
});

test("generateInBackground degrades silently with no lane and never throws", async () => {
  const provider = createPromptProvider({ playerCount: 5, room: "r1", provider: null });
  assert.deepEqual(await provider.generateInBackground("spicy"), []);
  assert.equal(provider.generationState("spicy").accepted, 0);
  assert.equal(provider.generationState("spicy").inFlight, false);

  const mock = mockFetch(() => ({ status: 500, text: "boom" }));
  const broken = new PromptProvider({ playerCount: 5, room: "r2", provider: makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl }) });
  assert.deepEqual(await broken.generateInBackground("deep"), []);
  assert.equal(broken.forPhase("deep", 2).length, 2, "the bank still fills the slots");
});

test("counts() mirrors the bank for the resolved tier", () => {
  assert.deepEqual(createPromptProvider({ provider: null, spicy: true }).counts(), bankCounts({ spicy: true }));
});
