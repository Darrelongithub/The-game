// packages/prompts/test/provider.test.ts
// Two independent lanes, one shared budget, zero real network calls.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CallGuard,
  MAX_PROVIDER_CALLS_PER_NIGHT,
  PURPOSE_SLOTS,
  Provider,
  containsAlias,
  extractText,
  geminiSafetySettings,
  parseJsonLoose,
  redactAliases,
} from "../src/index.ts";
import { resolveGeminiModel } from "../../shared/src/contracts.ts";
import { ALIASES, geminiReply, grokReply, hangingFetch, makeProvider, mockFetch } from "./helpers.ts";

const messages = [{ role: "user" as const, content: "Give me 3 prompts." }];

test("no keys: both lanes are silent and never touch the network", async () => {
  const mock = mockFetch(() => grokReply("[]"));
  const provider = makeProvider({ fetchImpl: mock.fetchImpl });
  assert.equal(provider.canGenerate(), false);
  assert.equal(provider.canAnalyze(), false);
  assert.deepEqual(provider.lanes(), { grok: false, gemini: false });

  const grok = await provider.grok({ room: "r1", messages });
  assert.equal(grok.ok, false);
  assert.equal(grok.reason, "no-key");
  const gem = await provider.gemini({ room: "r1", purpose: "tag", model: "x", user: "hi" });
  assert.equal(gem.ok, false);
  assert.equal(gem.reason, "no-key");
  assert.equal(mock.calls.length, 0);
  assert.equal(provider.guard.remaining("r1"), MAX_PROVIDER_CALLS_PER_NIGHT);
});

test("grok lane: OpenAI-compatible request with Bearer key, JSON mode, temp 0.9", async () => {
  const mock = mockFetch(() => grokReply('{"prompts":[]}'));
  const provider = makeProvider({ xaiApiKey: "xai-test", fetchImpl: mock.fetchImpl });
  const result = await provider.grok({ room: "r1", messages });

  assert.equal(result.ok, true);
  assert.equal(result.text, '{"prompts":[]}');
  assert.equal(mock.calls.length, 1);
  const call = mock.calls[0]!;
  assert.match(call.url, /^https:\/\/api\.x\.ai\/v1\/chat\/completions$/);
  assert.equal(call.headers.authorization, "Bearer xai-test");
  assert.equal(call.body.model, "grok-4-1-fast");
  assert.equal(call.body.temperature, 0.9);
  assert.deepEqual(call.body.response_format, { type: "json_object" });
  assert.equal(provider.guard.count("r1"), 1);
});

test("grok lane: XAI_MODEL overrides the contract id without a contract change", () => {
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mockFetch(() => grokReply("[]")).fetchImpl, env: { XAI_MODEL: "grok-9-fast" } });
  assert.equal(provider.modelFor("grok"), "grok-9-fast");
});

test("json mode fallback: a 400 on response_format retries once without it", async () => {
  let n = 0;
  const mock = mockFetch(() => {
    n += 1;
    return n === 1
      ? { status: 400, text: '{"error":"unknown parameter: response_format"}' }
      : grokReply("```json\n[{\"text\":\"ok\"}]\n```");
  });
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  const { result, value } = await provider.grokJson({ room: "r1", messages });
  assert.equal(result.ok, true);
  assert.deepEqual(value, [{ text: "ok" }]);
  assert.equal(mock.calls.length, 2);
  assert.equal(mock.calls[1]!.body.response_format, undefined);
  // A retry is still ONE budgeted logical call.
  assert.equal(provider.guard.count("r1"), 1);
});

test("refusal, rate limit and timeout are reasons — never exceptions", async () => {
  const refusal = makeProvider({
    xaiApiKey: "k",
    fetchImpl: mockFetch(() => ({ status: 403, text: "blocked by content policy" })).fetchImpl,
  });
  const r1 = await refusal.grok({ room: "r", messages });
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, "refusal");

  const limited = makeProvider({
    xaiApiKey: "k",
    fetchImpl: mockFetch(() => ({ status: 429, text: "slow down" })).fetchImpl,
  });
  const r2 = await limited.grok({ room: "r", messages });
  assert.equal(r2.reason, "rate-limit");

  const broken = makeProvider({
    xaiApiKey: "k",
    fetchImpl: mockFetch(() => ({ status: 500, text: "boom" })).fetchImpl,
  });
  assert.equal((await broken.grok({ room: "r", messages })).reason, "http");

  const throwing = makeProvider({
    xaiApiKey: "k",
    fetchImpl: (() => Promise.reject(new Error("dns"))) as never,
  });
  assert.equal((await throwing.grok({ room: "r", messages })).reason, "network");
});

test("Grok timeout aborts at the AbortController deadline (8s default, tiny in tests)", async () => {
  const hang = hangingFetch();
  const provider = new Provider({ env: {}, xaiApiKey: "k", fetchImpl: hang.fetchImpl, timeoutMs: 10 });
  const started = Date.now();
  const result = await provider.grok({ room: "r", messages });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "timeout");
  assert.ok(Date.now() - started < 2_000, "abort should be prompt, not a hang");
  assert.equal(hang.calls.length, 1);
});

test("gemini lane: classic generateContent, SAFETY_OFF mapped to BLOCK_NONE, JSON mime", async () => {
  const mock = mockFetch(() => geminiReply('{"tags":[]}'));
  const provider = makeProvider({ geminiApiKey: "gem-test", fetchImpl: mock.fetchImpl });
  const result = await provider.gemini({
    room: "r1",
    purpose: "tag",
    model: provider.modelFor("gemini", "tag"),
    system: "classify",
    user: "lines",
  });
  assert.equal(result.ok, true);
  const call = mock.calls[0]!;
  assert.match(call.url, /\/models\/gemini-3\.5-flash-lite:generateContent\?key=gem-test$/);
  assert.equal(call.headers.authorization, undefined, "Gemini uses ?key=, not a bearer header");
  assert.equal(call.body.generationConfig !== undefined, true);
  const config = call.body.generationConfig as Record<string, unknown>;
  assert.equal(config.responseMimeType, "application/json");
  const safety = call.body.safetySettings as Array<{ category: string; threshold: string }>;
  assert.equal(safety.length, 4);
  assert.ok(safety.every((s) => s.threshold === "BLOCK_NONE"), "classic v1beta wants BLOCK_NONE");
  assert.deepEqual(
    safety.map((s) => s.category),
    ["HARM_CATEGORY_HARASSMENT", "HARM_CATEGORY_HATE_SPEECH", "HARM_CATEGORY_SEXUALLY_EXPLICIT", "HARM_CATEGORY_DANGEROUS_CONTENT"],
  );
  assert.deepEqual((call.body.systemInstruction as { parts: Array<{ text: string }> }).parts[0]!.text, "classify");
});

test("gemini safety retry: a rejected threshold falls back to the literal contract value", async () => {
  let n = 0;
  const mock = mockFetch(() => {
    n += 1;
    if (n === 1) return { status: 400, text: '{"error":"Invalid safety threshold BLOCK_NONE"}' };
    return geminiReply('{"ok":true}');
  });
  const provider = makeProvider({ geminiApiKey: "k", fetchImpl: mock.fetchImpl });
  const result = await provider.gemini({ room: "r", purpose: "tag", model: "m", user: "x" });
  assert.equal(result.ok, true);
  assert.equal(mock.calls.length, 2);
  const safety = mock.calls[1]!.body.safetySettings as Array<{ threshold: string }>;
  assert.ok(safety.every((s) => s.threshold === "OFF"), "retry uses the literal contract thresholds");
  assert.equal(provider.guard.count("r"), 1);
});

test("LANE INDEPENDENCE: Grok key only → zero Gemini calls, and vice versa", async () => {
  const mock = mockFetch((call) => (call.url.includes("x.ai") ? grokReply("[]") : geminiReply("[]")));
  const grokOnly = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  assert.equal(grokOnly.canGenerate(), true);
  assert.equal(grokOnly.canAnalyze(), false);
  await grokOnly.grok({ room: "r", messages });
  const gem = await grokOnly.gemini({ room: "r", purpose: "analyze", model: "m", user: "x" });
  assert.equal(gem.reason, "no-key");
  assert.equal(mock.calls.filter((c) => c.url.includes("generativelanguage")).length, 0);

  mock.calls.length = 0;
  const gemOnly = makeProvider({ geminiApiKey: "k", fetchImpl: mock.fetchImpl });
  assert.equal(gemOnly.canAnalyze(), true);
  assert.equal(gemOnly.canGenerate(), false);
  await gemOnly.gemini({ room: "r", purpose: "tag", model: "m", user: "x" });
  const grok = await gemOnly.grok({ room: "r", messages });
  assert.equal(grok.reason, "no-key");
  assert.equal(mock.calls.filter((c) => c.url.includes("x.ai")).length, 0);
});

test("call-count guard hard-stops at the cap, per room", async () => {
  const guard = new CallGuard(3, { generate: 9, tag: 9, analyze: 9, reveal: 9 });
  const mock = mockFetch(() => grokReply("[]"));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl, guard });

  for (let i = 0; i < 3; i += 1) assert.equal((await provider.grok({ room: "A", messages })).ok, true);
  const fourth = await provider.grok({ room: "A", messages });
  assert.equal(fourth.ok, false);
  assert.equal(fourth.reason, "budget");
  assert.equal(mock.calls.length, 3, "no HTTP request past the cap");
  assert.equal(guard.remaining("A"), 0);

  // Per-room: another room still has its own budget.
  assert.equal((await provider.grok({ room: "B", messages })).ok, true);
  assert.equal(guard.count("B"), 1);
});

test("batching slots: ONE tag call and ONE debrief call per room, 4 generation batches", async () => {
  const guard = new CallGuard();
  const mock = mockFetch(() => grokReply("[]"));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl, guard });

  for (let i = 0; i < 4; i += 1) assert.equal((await provider.grok({ room: "r", purpose: "generate", messages })).ok, true);
  assert.equal((await provider.grok({ room: "r", purpose: "generate", messages })).reason, "budget");

  // Purpose slots are shared across lanes.
  assert.equal((await provider.gemini({ room: "r", purpose: "tag", model: "m", user: "x" })).reason, "no-key");
  const gemProvider = makeProvider({ geminiApiKey: "k", fetchImpl: mockFetch(() => geminiReply("{}")).fetchImpl, guard });
  assert.equal((await gemProvider.gemini({ room: "r", purpose: "tag", model: "m", user: "x" })).ok, true);
  assert.equal((await gemProvider.gemini({ room: "r", purpose: "tag", model: "m", user: "x" })).reason, "budget");
  assert.equal(PURPOSE_SLOTS.tag, 1);
  assert.equal(PURPOSE_SLOTS.analyze, 1);
  assert.equal(PURPOSE_SLOTS.reveal, 1);
});

test("forget() drops a room's ledger with the room", async () => {
  const guard = new CallGuard();
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mockFetch(() => grokReply("[]")).fetchImpl, guard });
  await provider.grok({ room: "r", messages });
  assert.equal(guard.count("r"), 1);
  guard.forget("r");
  assert.equal(guard.count("r"), 0);
  assert.equal(guard.snapshot("r").used, 0);
});

test("pseudonyms only: aliases are scrubbed out of every outgoing payload", async () => {
  const mock = mockFetch(() => grokReply("[]"));
  const provider = makeProvider({ xaiApiKey: "k", fetchImpl: mock.fetchImpl });
  await provider.grok({
    room: "r",
    messages: [{ role: "user", content: "Nadia told tolu that Mo was lying about Kendi." }],
    aliases: ALIASES,
  });
  const raw = mock.calls[0]!.raw;
  assert.equal(containsAlias(raw, ALIASES), false, "a real alias left the server");
  assert.match(raw, /someone in the room/);
  assert.equal(redactAliases("Mo and mo again", ALIASES), "someone in the room and someone in the room again");
  assert.equal(redactAliases("Zoe\u0308 is here", ["Zoë"]), "someone in the room is here", "NFD aliases are redacted after canonical Unicode normalization");
  assert.equal(containsAlias("Zoe\u0308 is here", ["Zoë"]), true);
});

test("parseJsonLoose handles fences, prose and garbage; extractText reads both APIs", () => {
  assert.deepEqual(parseJsonLoose('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseJsonLoose('Here you go:\n[{"a":1},{"b":2}]\nEnjoy.'), [{ a: 1 }, { b: 2 }]);
  assert.equal(parseJsonLoose("not json at all"), null);
  assert.equal(parseJsonLoose(""), null);
  assert.equal(parseJsonLoose(undefined), null);

  assert.equal(extractText("grok", JSON.stringify({ choices: [{ message: { content: "hi" } }] })), "hi");
  assert.equal(extractText("gemini", JSON.stringify({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] })), "ab");
  assert.equal(extractText("gemini", JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })), null);
  assert.equal(extractText("grok", "{}"), null);
});

test("geminiSafetySettings maps OFF → BLOCK_NONE only for the classic endpoint", () => {
  assert.ok(geminiSafetySettings("classic").every((s) => s.threshold === "BLOCK_NONE"));
  assert.ok(geminiSafetySettings("literal").every((s) => s.threshold === "OFF"));
});

test("Gemini resolver defaults to flash-lite and preserves overrides", () => {
  assert.equal(resolveGeminiModel(), "gemini-3.5-flash-lite");
  assert.equal(resolveGeminiModel("  "), "gemini-3.5-flash-lite");
  assert.equal(resolveGeminiModel(" custom-model "), "custom-model");
  const provider = new Provider({ env: {} });
  assert.equal(provider.modelFor("gemini", "analyze"), "gemini-3.5-flash-lite");
});

test("GEMINI_MODEL overrides both Gemini analysis call sites through one resolver", () => {
  const provider = new Provider({ env: { GEMINI_API_KEY: "key", GEMINI_MODEL: "gemini-overridden" } });
  assert.equal(provider.modelFor("gemini", "tag"), "gemini-overridden");
  assert.equal(provider.modelFor("gemini", "analyze"), "gemini-overridden");
  assert.throws(() => provider.modelFor("gemini", "reveal"), /disabled/);
});

test("Gemini reveal purpose is rejected without making a network request", async () => {
  const mock = mockFetch(() => { throw new Error("must not send Gemini reveal"); });
  const provider = makeProvider({ geminiApiKey: "key", fetchImpl: mock.fetchImpl });
  const result = await provider.gemini({ room: "finale-room", purpose: "reveal", model: "gemini-test", user: "narrate" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "disabled");
  assert.equal(mock.calls.length, 0);
});
