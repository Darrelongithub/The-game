// packages/prompts/test/ollama.test.ts
// The Ollama lane.
//
// The rules under test:
//   • The model may ONLY rephrase a bank prompt (keeping its slots).
//   • Exactly four drop reasons exist: not-in-room, repeat, too-long, refusal.
//   • Every accepted line names a player in the room.
//   • On failure the bank prompt is used unchanged.
//   • The terminal report says "asked N, accepted N, dropped N (reasons)".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GEN_TARGET_PROMPTS,
  formatReasons,
  isRefusal,
  normalizeForMatch,
  ollamaConfig,
  parseLines,
  parseOllamaText,
  rephraseUserPrompt,
  validateGenerated,
  validateVerdictLine,
} from "../src/index.ts";
import { generateNight } from "../src/generate.ts";

describe("the config", () => {
  it("defaults to a local Ollama on dolphin-mistral", () => {
    const config = ollamaConfig({});
    assert.equal(config.baseUrl, "http://127.0.0.1:11434");
    assert.equal(config.model, "dolphin-mistral");
    assert.equal(config.timeoutMs, 120000);
  });

  it("reads GEN_BASE, GEN_MODEL and GEN_TIMEOUT_MS", () => {
    const config = ollamaConfig({
      GEN_BASE: "http://192.168.1.9:11434/",
      GEN_MODEL: "llama3",
      GEN_TIMEOUT_MS: "45000",
    });
    assert.equal(config.baseUrl, "http://192.168.1.9:11434");
    assert.equal(config.model, "llama3");
    assert.equal(config.timeoutMs, 45000);
  });
});

describe("the validation", () => {
  const seen = new Set<string>();

  it("accepts a rephrased line that keeps the room slot", () => {
    const check = validateGenerated({
      text: "Who do you think {P1} has been texting at 2am?",
      playerCount: 5,
      seen,
    });
    assert.equal(check.ok, true);
  });

  it("accepts a line that talks about the room without a slot", () => {
    const check = validateGenerated({
      text: "Who in this room would you take home?",
      playerCount: 5,
      seen,
    });
    assert.equal(check.ok, true);
  });

  it("drops a line that is not about anybody in the room", () => {
    const check = validateGenerated({
      text: "What is the best way to cook pasta for a large family gathering?",
      playerCount: 5,
      seen,
    });
    assert.equal(check.ok, false);
    assert.equal(check.reason, "not-in-room");
  });

  it("drops a repeat", () => {
    const text = "Who in this room has the best body?";
    const first = validateGenerated({ text, playerCount: 5, seen });
    assert.equal(first.ok, true);
    seen.add(normalizeForMatch(text));
    const second = validateGenerated({ text, playerCount: 5, seen });
    assert.equal(second.ok, false);
    assert.equal(second.reason, "repeat");
  });

  it("drops a line over 160 characters", () => {
    const check = validateGenerated({
      text: `Who in this room ${"really ".repeat(40)}?`,
      playerCount: 5,
      seen,
    });
    assert.equal(check.ok, false);
    assert.equal(check.reason, "too-long");
  });

  it("drops a refusal", () => {
    const check = validateGenerated({
      text: "I'm sorry, but I can't help with that request.",
      playerCount: 5,
      seen,
    });
    assert.equal(check.ok, false);
    assert.equal(check.reason, "refusal");
  });

  it("drops an 'as an AI' disclaimer", () => {
    const check = validateGenerated({
      text: "As an AI I cannot tell you who in this room would kiss first.",
      playerCount: 5,
      seen,
    });
    assert.equal(check.ok, false);
    assert.equal(check.reason, "refusal");
  });

  it("drops a line that is unchanged from the bank prompt", () => {
    const source = "Who in this room has the highest body count?";
    const check = validateGenerated({ text: source, playerCount: 5, seen, sourceText: source });
    assert.equal(check.ok, false);
    assert.equal(check.reason, "repeat");
  });

  it("only ever drops for the four allowed reasons", () => {
    const reasons = new Set(["not-in-room", "repeat", "too-long", "refusal"]);
    const cases = [
      { text: "nothing about anyone here", playerCount: 5, seen: new Set<string>() },
      { text: "x".repeat(200), playerCount: 5, seen: new Set<string>() },
      { text: "I cannot do that.", playerCount: 5, seen: new Set<string>() },
      { text: "Who in this room? {P1}", playerCount: 5, seen: new Set(["who in this room p1"]) },
    ];
    for (const c of cases) {
      const check = validateGenerated(c);
      if (!check.ok) assert.ok(reasons.has(check.reason!), `unexpected drop reason ${check.reason}`);
    }
  });
});

describe("the refusals", () => {
  it("spots the common ones", () => {
    assert.equal(isRefusal("I'm sorry, but I can't do that."), true);
    assert.equal(isRefusal("As an AI language model, I must decline."), true);
    assert.equal(isRefusal("Who in this room would you kiss?"), false);
  });
});

describe("the response parsing", () => {
  it("reads the native Ollama shape", () => {
    const raw = JSON.stringify({ message: { role: "assistant", content: "hello" } });
    assert.equal(parseOllamaText(raw), "hello");
  });

  it("reads the OpenAI-compatible shape", () => {
    const raw = JSON.stringify({ choices: [{ message: { content: "hello" } }] });
    assert.equal(parseOllamaText(raw), "hello");
  });

  it("returns null for junk", () => {
    assert.equal(parseOllamaText("not json"), null);
    assert.equal(parseOllamaText("{}"), null);
  });

  it("splits the reply into one candidate per line", () => {
    const lines = parseLines("1. first\n2. second\n\n- third");
    assert.deepEqual(lines, ["first", "second", "third"]);
  });
});

describe("the verdict line", () => {
  it("accepts a line that names a real player", () => {
    const check = validateVerdictLine("Wanjiru is the one everybody is watching tonight.", {
      playerCount: 5,
      allowedNames: ["Wanjiru", "Dee"],
      seen: new Set(),
    });
    assert.equal(check.ok, true);
  });

  it("drops a line that names nobody in the room", () => {
    const check = validateVerdictLine("Somebody here has the highest body count.", {
      playerCount: 5,
      allowedNames: ["Wanjiru", "Dee"],
      seen: new Set(),
    });
    assert.equal(check.ok, false);
    assert.equal(check.reason, "not-in-room");
  });

  it("drops a refusal", () => {
    const check = validateVerdictLine("As an AI I will not do this.", {
      playerCount: 5,
      allowedNames: ["Wanjiru"],
      seen: new Set(),
    });
    assert.equal(check.ok, false);
    assert.equal(check.reason, "refusal");
  });
});

describe("the generation run", () => {
  it("falls back to the bank when Ollama is not reachable", async () => {
    const lines: string[] = [];
    const report = await generateNight({
      playerCount: 5,
      seed: 1,
      fetchImpl: async () => { throw new Error("connection refused"); },
      log: (line) => lines.push(line),
    });
    assert.ok(report.prompts.length > 100, "the bank must carry the night");
    assert.equal(report.accepted, 0);
    assert.equal(report.offline, true);
    assert.ok(lines.some((l) => l.startsWith("Ollama: asked ")), "the terminal must report per batch");
  });

  it("uses the model's lines when they pass, and the bank for the rest", async () => {
    const report = await generateNight({
      playerCount: 5,
      seed: 2,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "Who in this room would you take home tonight?" } }],
        }),
      }),
    });
    assert.ok(report.accepted > 0, "a valid line should be accepted");
    assert.ok(report.prompts.some((p) => p.source === "ollama"), "the model's line should be used");
    assert.ok(report.prompts.some((p) => p.source === "bank"), "the bank must backfill the rest");
    assert.equal(report.target, GEN_TARGET_PROMPTS);
  });

  it("prints a per-batch report with the reasons", async () => {
    const lines: string[] = [];
    await generateNight({
      playerCount: 5,
      seed: 3,
      // A refusal for every candidate.
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          choices: [{ message: { content: "I'm sorry, but I can't help with that." } }],
        }),
      }),
      log: (line) => lines.push(line),
    });
    const batchLines = lines.filter((l) => l.startsWith("Ollama: asked "));
    assert.ok(batchLines.length >= 1);
    assert.match(batchLines[0]!, /^Ollama: asked \d+, accepted \d+, dropped \d+ \(.+\)$/);
    assert.match(batchLines[0]!, /refusal:\d+/);
  });

  it("formats the reasons the way the terminal prints them", () => {
    assert.equal(formatReasons({ "not-in-room": 1, repeat: 2 }), "not-in-room:1, repeat:2");
    assert.equal(formatReasons({}), "none");
  });

  it("asks the model to keep every placeholder", () => {
    const user = rephraseUserPrompt(["Who in this room has a crush on {P1}?"]);
    assert.match(user, /\{P1\}/);
  });
});
