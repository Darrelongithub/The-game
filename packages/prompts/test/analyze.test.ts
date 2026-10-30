// packages/prompts/test/analyze.test.ts
// Code-first analysis: a deterministic lexicon and token-Jaccard are PRIMARY.
// Gemini may refine, once per batch per night, and can never invent a score.
import test from "node:test";
import assert from "node:assert/strict";
import {
  TAG_TAXONOMY,
  contemptDensity,
  debriefBatch,
  debriefSimilarity,
  isTag,
  primaryTag,
  tagBatch,
  tagText,
} from "../src/index.ts";
import { ALIASES, geminiReply, makeProvider, mockFetch } from "./helpers.ts";

test("lexicon tags every taxonomy family", () => {
  assert.ok(tagText("You're pathetic and everyone here knows it").includes("contempt"));
  assert.ok(tagText("You always do this to me").includes("criticism"));
  assert.ok(tagText("It's not my fault, you're overreacting").includes("defensiveness"));
  assert.ok(tagText("Whatever. I don't care.").includes("stonewalling"));
  assert.ok(tagText("I love that you called me first").includes("affection"));
  assert.ok(tagText("I genuinely respect how you handled that").includes("admiration"));
  assert.ok(tagText("It still hurt and it was unfair").includes("grievance"));
  assert.deepEqual(tagText("We ate rice at 7pm"), ["neutral"]);
  assert.deepEqual(tagText(""), ["neutral"]);
});

test("tags are multi-label, taxonomy-ordered and deterministic", () => {
  const text = "You always act like you're pathetic, but I still respect you.";
  const first = tagText(text);
  const second = tagText(text);
  assert.deepEqual(first, second);
  assert.ok(first.includes("contempt") && first.includes("criticism") && first.includes("admiration"));
  // Ordering follows the fixed taxonomy, never match position.
  const order = first.map((t) => TAG_TAXONOMY.indexOf(t));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.equal(primaryTag(text), "contempt");
});

test("taxonomy guard rejects anything outside the eight tags", () => {
  assert.equal(TAG_TAXONOMY.length, 8);
  assert.equal(isTag("contempt"), true);
  assert.equal(isTag("narcissist"), false);
  assert.equal(isTag(42), false);
});

test("contempt density is a 0..1 share over texts", () => {
  assert.equal(contemptDensity([]), 0);
  assert.equal(contemptDensity(["you're pathetic", "nice shirt"]), 0.5);
  assert.equal(contemptDensity(["pathetic", "useless"]), 1);
});

test("no Gemini key → tagBatch is pure code and makes zero calls", async () => {
  const mock = mockFetch(() => geminiReply("[]"));
  const provider = makeProvider({ fetchImpl: mock.fetchImpl });
  const tags = await tagBatch(["I love you both", "whatever, don't care"], { room: "r", provider });
  assert.deepEqual(tags, [["affection"], ["stonewalling"]]);
  assert.equal(mock.calls.length, 0);
});

test("tagBatch: ONE gemini call, taxonomy-validated, invalid rows ignored", async () => {
  const payload = JSON.stringify([
    { i: 0, tags: ["admiration"] },
    { i: 1, tags: ["narcissist", "contempt"] },
    { i: 99, tags: ["affection"] },
    { i: 2, tags: [] },
  ]);
  const mock = mockFetch(() => geminiReply(payload));
  const provider = makeProvider({ geminiApiKey: "k", fetchImpl: mock.fetchImpl });
  const tags = await tagBatch(["something plain", "something mean", "something else"], { room: "r1", provider });

  assert.equal(mock.calls.length, 1);
  assert.match(mock.calls[0]!.url, /gemini-3\.1-pro-preview/);
  assert.deepEqual(tags[0], ["admiration"]);
  assert.deepEqual(tags[1], ["contempt"], "unknown taxonomy tag must be ignored");
  assert.deepEqual(tags[2], ["neutral"], "an empty tag list falls back to the code result");
  assert.equal(provider.guard.purposeCount("r1", "tag"), 1);
});

test("tagBatch is capped at ONE tag call per room per night", async () => {
  const mock = mockFetch(() => geminiReply(JSON.stringify([{ i: 0, tags: ["affection"] }])));
  const provider = makeProvider({ geminiApiKey: "k", fetchImpl: mock.fetchImpl });
  await tagBatch(["a plain line"], { room: "same-room", provider });
  await tagBatch(["a plain line"], { room: "same-room", provider });
  assert.equal(mock.calls.length, 1, "the second batch must be skipped by the budget");
  assert.deepEqual(await tagBatch(["a plain line"], { room: "other-room", provider }), [["affection"]]);
  assert.equal(mock.calls.length, 2, "a different room has its own budget");
});

test("tagBatch never sends aliases", async () => {
  const mock = mockFetch(() => geminiReply("[]"));
  const provider = makeProvider({ geminiApiKey: "k", fetchImpl: mock.fetchImpl });
  await tagBatch(["Nadia said Tolu was lying"], { room: "r", provider, aliases: ALIASES });
  assert.doesNotMatch(mock.calls[0]!.raw, /Nadia|Tolu was/);
  assert.match(mock.calls[0]!.raw, /someone in the room/);
});

test("debriefSimilarity: token-Jaccard blank data has no midpoint", () => {
  assert.equal(debriefSimilarity("we talked about the wedding", "we talked about the wedding"), 1);
  assert.equal(debriefSimilarity("completely different topic entirely", "salt and pepper shakers"), 0);
  assert.equal(debriefSimilarity("", ""), 0);
  assert.equal(debriefSimilarity("we talked about the wedding", ""), 0);
  const partial = debriefSimilarity("we talked about your sister and the wedding", "we talked about the wedding");
  assert.ok(partial > 0 && partial < 1, `expected a partial score, got ${partial}`);
});

test("no Gemini key → debriefBatch uses Jaccard and makes zero calls", async () => {
  const mock = mockFetch(() => geminiReply("[]"));
  const provider = makeProvider({ fetchImpl: mock.fetchImpl });
  const scores = await debriefBatch([["we talked about the wedding", "we talked about the wedding"]], { room: "r", provider });
  assert.deepEqual(scores, [1]);
  assert.equal(mock.calls.length, 0);
});

test("debriefBatch: ONE analysis-model call, clamps and validates every score", async () => {
  const payload = JSON.stringify([
    { i: 0, score: 1.7 },
    { i: 1, score: -3 },
    { i: 2, score: "high" },
    { i: 3, similarity: 0.42 },
  ]);
  const mock = mockFetch(() => geminiReply(payload));
  const provider = makeProvider({ geminiApiKey: "k", fetchImpl: mock.fetchImpl });
  const pairs = [
    ["alpha beta gamma", "alpha beta gamma"],
    ["delta epsilon", "delta epsilon"],
    ["kappa lambda theta", "sigma omega upsilon"],
    ["one two three", "one two three"],
  ] as const;
  const scores = await debriefBatch(pairs, { room: "r", provider });

  assert.equal(mock.calls.length, 1);
  assert.match(mock.calls[0]!.url, /gemini-3\.1-pro-preview/);
  assert.equal(scores[0], 1, "clamped down");
  assert.equal(scores[1], 0, "clamped up");
  assert.equal(scores[2], 0, "non-numeric score keeps the Jaccard result");
  assert.equal(scores[3], 0.42, "similarity alias accepted");
  assert.equal(provider.guard.purposeCount("r", "analyze"), 1);
});

test("debriefBatch: garbage or refusal keeps the code result, never throws", async () => {
  const garbage = makeProvider({ geminiApiKey: "k", fetchImpl: mockFetch(() => geminiReply("not json")).fetchImpl });
  assert.deepEqual(await debriefBatch([["same words here", "same words here"]], { room: "r", provider: garbage }), [1]);

  const refused = makeProvider({
    geminiApiKey: "k",
    fetchImpl: mockFetch(() => ({ status: 400, text: "blocked: safety" })).fetchImpl,
  });
  assert.deepEqual(await debriefBatch([["same words here", "same words here"]], { room: "r", provider: refused }), [1]);
});

test("analysis lane independence: a Grok-only key never triggers Gemini", async () => {
  const mock = mockFetch(() => geminiReply("[]"));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const tags = await tagBatch(["I love this"], { room: "r", provider });
  const scores = await debriefBatch([["alpha beta gamma", "alpha beta gamma"]], { room: "r", provider });
  assert.deepEqual(tags, [["affection"]]);
  assert.deepEqual(scores, [1]);
  assert.equal(mock.calls.length, 0);
});
