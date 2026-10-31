// packages/prompts/test/generate.test.ts
// ONE batched Grok call per phase, then deterministic code disposes of it.
// Any lane failure → [] and the bank carries the night.
import test from "node:test";
import assert from "node:assert/strict";
import { generateBatch, generateBatchReport } from "../src/index.ts";
import { BANK, BANK_PHASES, RAW_BANK } from "../src/bank/index.ts";
import { Provider, containsAlias } from "../src/provider.ts";
import { ALIASES, grokReply, hangingFetch, makeDigest, makeProvider, mockFetch, candidate } from "./helpers.ts";

const base = {
  phase: "spicy" as const,
  playerCount: 6,
  usedIds: [],
  room: "room-1",
};

test("local service unavailable → empty batch for bank fallback", async () => {
  const mock = mockFetch(() => { throw new Error("Ollama offline"); });
  const provider = makeProvider({ fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider });
  assert.deepEqual(report.prompts, []);
  assert.equal(report.reason, "network");
  assert.equal(report.called, true);
  assert.equal(mock.calls.length, 1);
});

test("ONE batched call produces filtered, contract-shaped prompts", async () => {
  const batch = [
    candidate(),
    candidate({
      text: "Rate {P2}'s loyalty 1–10. Do they even know you exist, honestly?",
      kind: "rating",
      coding: "friction",
      measures: ["spice trait agreement"],
      asksTarget: true,
    }),
    candidate({
      text: "Give {P3} a compliment you'd never say sober, out loud, right now.",
      kind: "dare",
      coding: "friendship",
    }),
  ];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider });

  assert.equal(mock.calls.length, 1, "exactly one generation call per phase");
  assert.equal(report.lane, "grok");
  assert.equal(report.called, true);
  assert.equal(report.candidates, 3);
  // The dare is wrong for the spicy phase → dropped, the other two survive.
  assert.equal(report.prompts.length, 2);
  assert.ok(report.prompts.every((p) => p.source === "grok" && p.phase === "spicy"));
  assert.ok(report.prompts.some((p) => p.kind === "rating" && p.measures[0]!.startsWith("trait:loyalty")));
  const ids = report.prompts.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
});

test("the deterministic filter drops empty-measure and undirected candidates", async () => {
  const batch = [
    candidate({ text: "Who here would you trust with a secret that could end you?" }),
    candidate({ text: "Who here would you trust with a secret that could ruin you?", measures: [] }),
    candidate({ text: "Describe the last film you watched alone in detail.", kind: "text", asksTarget: false }),
  ];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider });

  assert.equal(report.prompts.length, 1);
  const reasons = report.dropped.map((d) => d.reason);
  assert.ok(reasons.includes("measures"), "empty measures must be dropped");
  assert.ok(reasons.includes("not-room-directed"), "a prompt targeting nobody must be dropped");
});

test("banned patterns and hard blocks never reach a phone", async () => {
  const batch = [
    candidate({ text: "Who here is most likely to get us arrested tonight? Point." }),
    candidate({ text: "Who here would survive a zombie outbreak the longest? Point." }),
    candidate({ text: "Who here would hook up with a schoolgirl from a story? Point." }),
    candidate({ text: "Who here would you call first if everything fell apart?" }),
  ];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider });

  assert.equal(report.prompts.length, 1);
  const reasons = report.dropped.map((d) => d.reason);
  assert.ok(reasons.filter((r: string) => r === "banned").length >= 2);
  assert.ok(reasons.includes("hard-block"));
});

test("placeholders above the roster are dropped for small rooms", async () => {
  const batch = [
    candidate({ text: "Rate {P9}'s chaos, 1–10. Be honest about it tonight.", kind: "rating", measures: ["trait:chaos"] }),
    candidate({ text: "Rate {P2}'s chaos, 1–10. Be honest about it tonight.", kind: "rating", measures: ["trait:chaos"] }),
  ];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, playerCount: 4, provider });
  assert.equal(report.prompts.length, 1);
  assert.match(report.prompts[0]!.text, /\{P2\}/);
});

test("dedupe vs the bank, vs usedIds and within the batch", async () => {
  const batch = [
    candidate({ text: "Who here can make you laugh even when you are furious with them?" }), // bank w1
    candidate({ text: "Who here would you trust to delete your search history, no questions?" }),
    candidate({ text: "Who here would you trust to delete your search history with no questions?" }),
  ];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider });
  assert.equal(report.prompts.length, 1, "the bank duplicate and the near-duplicate must not ship");
});

test("a refusal, 429 or timeout falls back to the bank with a reason", async () => {
  const refused = makeProvider({
    xaiApiKey: "k",
    fetchImpl: mockFetch(() => ({ status: 403, text: "blocked by content policy" })).fetchImpl,
  });
  assert.deepEqual(await generateBatch({ ...base, provider: refused }), []);
  assert.equal((await generateBatchReport({ ...base, provider: refused })).reason, "refusal");

  const limited = makeProvider({ xaiApiKey: "k", fetchImpl: mockFetch(() => ({ status: 429, text: "rate" })).fetchImpl });
  assert.equal((await generateBatchReport({ ...base, provider: limited })).reason, "rate-limit");

  const slow = new Provider({
    env: {},
    xaiApiKey: "k",
    fetchImpl: hangingFetch().fetchImpl,
    timeoutMs: 10,
  });
  const timed = await generateBatchReport({ ...base, provider: slow });
  assert.deepEqual(timed.prompts, []);
  assert.equal(timed.reason, "timeout");
});

test("garbage output never throws", async () => {
  for (const text of ["not json", '{"prompts": "nope"}', "[]"]) {
    const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mockFetch(() => grokReply(text)).fetchImpl });
    const report = await generateBatchReport({ ...base, provider });
    assert.deepEqual(report.prompts, []);
  }
});

test("digest callbacks: verbatim quotes survive, invented quotes never do", async () => {
  const quote = "I once drove to Mombasa to avoid a group chat";
  const batch = [
    // verbatim → kept
    candidate({
      text: `Someone here said "${quote}" — who was avoiding whom, and why?`,
      kind: "text",
      asksTarget: false,
      callback: true,
    }),
    // invented quote → dropped
    candidate({
      text: 'Someone here said "I have never lied to this group about anything" — who was it?',
      kind: "text",
      asksTarget: false,
      callback: true,
    }),
    // claims callback but quotes nothing → dropped
    candidate({ text: "Who here has been lying about their weekend plans all night?", callback: true }),
  ];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider, digest: makeDigest() });

  const reasons = report.dropped.map((d) => d.reason);
  assert.ok(reasons.includes("invented-quote"), "an invented quote must be dropped");
  assert.ok(reasons.includes("no-quote"), "a callback flag without a quote must be dropped");
  assert.ok(report.prompts.length >= 1);
  assert.ok(report.callbacks >= 1, "the verbatim callback must be counted");
  assert.ok(report.prompts.some((p) => p.text.includes(quote)));
});

test("at least half the prompts can be callbacks from spicy on", async () => {
  // 6 candidates, no callbacks claimed: target is 3.
  const batch = [
    candidate({ text: "Who here would you lend your car to for a whole week?", callback: false }),
    candidate({ text: "What's the pettiest reason you ghosted someone here?", kind: "text", asksTarget: false, callback: false }),
    candidate({ text: "Who here would you trust to negotiate your bail?", callback: false }),
    candidate({ text: "Which person here gives the worst advice, and why?", kind: "text", asksTarget: false, callback: false }),
    candidate({ text: "Who here would you split a lottery win with?", callback: false }),
    candidate({ text: "Who here do you text the most, and why them?", kind: "text", asksTarget: false, callback: false }),
  ];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider, digest: makeDigest(), count: 6 });

  assert.ok(report.callbacks >= 3, `expected at least 3 callbacks, got ${report.callbacks}`);
  const digestQuotes = makeDigest().quotes.map((q) => q.text);
  for (const prompt of report.prompts) {
    if (prompt.text.includes("Callback:")) {
      assert.ok(
        digestQuotes.some((q) => prompt.text.includes(q)),
        "a callback must quote a real digest answer verbatim",
      );
      assert.ok(prompt.text.length <= 160, "topped-up prompts stay inside 160 chars");
    }
  }
});

test("warmup never gets callbacks, even with a digest", async () => {
  const batch = [candidate({ text: "Who here would you call first after the best news of the year?" })];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, phase: "warmup", provider, digest: makeDigest() });
  assert.equal(report.callbacks, 0);
  assert.doesNotMatch(report.prompts[0]?.text ?? "", /Callback:/);
});

test("pseudonyms only: digest aliases never leave the server", async () => {
  const batch = [candidate()];
  const mock = mockFetch(() => grokReply(JSON.stringify(batch)));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  await generateBatchReport({ ...base, provider, digest: makeDigest(), aliases: ALIASES });

  const body = mock.calls[0]!.raw;
  assert.equal(containsAlias(body, ALIASES), false, "an alias leaked to the provider");
  assert.match(body, /someone in the room|Mombasa/);
});

test("the system prompt carries the §6 rules and the roster size", async () => {
  const mock = mockFetch(() => grokReply(JSON.stringify([candidate()])));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  await generateBatchReport({ ...base, playerCount: 5, provider });

  const messages = mock.calls[0]!.body.messages as Array<{ role: string; content: string }>;
  const system = messages.find((m) => m.role === "system")!.content;
  assert.match(system, /DATA-OR-DEAD/);
  assert.match(system, /Player 1\.\.Player 5/);
  assert.match(system, /\{P1\}\.\.\{P5\}/);
  assert.match(system, /20-160 characters/);
  assert.match(system, /most likely to/);
  assert.match(system, /minors/);
});

test("system register and runtime bank examples match each phase", async () => {
  for (const phase of BANK_PHASES) {
    const mock = mockFetch(() => grokReply("[]"));
    const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
    await generateBatchReport({ ...base, phase, provider });
    const messages = mock.calls[0]!.body.messages as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === "system")!.content;
    for (const phrase of ["18+", "CLOSE FRIENDS", "one room", "phones", "GROUP about the GROUP", "flirty", "teasing", "roast-your-friends", "inside-joke", "one sentence", "No disclaimers", "no moralizing", "{P1}..{Pn}"]) {
      assert.ok(system.includes(phrase), `missing register: ${phrase}`);
    }
    const examples = system.split("Bank examples for inspiration (do not copy):\n")[1]!.split("\nReturn ONE JSON array")[0]!.split("\n").map((line) => line.slice(4));
    assert.ok(examples.length >= 4 && examples.length <= 6);
    assert.ok(examples.every((text) => RAW_BANK.phases[phase].some((row) => row.text === text)), `wrong-phase or non-bank seed in ${phase}`);
  }
});

test("examples are loaded from the bank at generation time", async () => {
  const seed = BANK.find((p) => p.phase === "warmup")!;
  const original = seed.text;
  seed.text = "A temporary distinctive bank seed about the friends in this room?";
  try {
    const mock = mockFetch(() => grokReply("[]"));
    await generateBatchReport({ ...base, phase: "warmup", provider: makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl }) });
    const messages = mock.calls[0]!.body.messages as Array<{ role: string; content: string }>;
    assert.ok(messages.find((m) => m.role === "system")!.content.includes(seed.text));
  } finally {
    seed.text = original;
  }
});

test("a `{prompts:[…]}` wrapper is accepted as well as a bare array", async () => {
  const mock = mockFetch(() => grokReply(JSON.stringify({ prompts: [candidate()] })));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const report = await generateBatchReport({ ...base, provider });
  assert.equal(report.prompts.length, 1);
});

test("generation respects the per-phase batch budget (4 calls a night)", async () => {
  const mock = mockFetch(() => grokReply(JSON.stringify([candidate()])));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const phases = ["warmup", "spicy", "deep", "dare"] as const;
  for (const phase of phases) await generateBatchReport({ ...base, phase, provider });
  // 5th batch → budget reason, no HTTP call.
  const fifth = await generateBatchReport({ ...base, phase: "spicy", provider });
  assert.equal(fifth.reason, "budget");
  assert.equal(mock.calls.length, 4);
});

test("generation voice includes room register and four actual bank examples", async () => {
  const { BANK } = await import("../src/bank/index.ts");
  const mock = mockFetch(() => grokReply("[]"));
  await generateBatchReport({ ...base, provider: makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl }) });
  const system = (mock.calls[0]!.body.messages as Array<{role: string; content: string}>).find(m => m.role === "system")!.content;
  assert.match(system, /close friends/i);
  assert.match(system, /phones/i);
  assert.match(system, /one sentence/i);
  assert.match(system, /no disclaimers/i);
  assert.ok(BANK.filter(p => p.phase === "spicy" && system.includes(p.text)).length >= 4);
});

test("generation logs every dropped candidate with a reason, never its text", async () => {
  const mock = mockFetch(() => grokReply(JSON.stringify([
    candidate({ text: "Who here would survive a zombie outbreak the longest? Point." }),
    candidate({ text: "Who here would you trust with a secret that could end you?", measures: [] }),
  ])));
  const logs: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => logs.push(args.join(" "));
  try {
    const report = await generateBatchReport({ ...base, provider: makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl }) });
    assert.equal(logs.length, report.dropped.length);
    for (const drop of report.dropped) assert.ok(logs.some(line => line.includes(drop.reason)));
    assert.ok(logs.every(line => !line.includes("zombie outbreak")));
  } finally { console.warn = original; }
});
