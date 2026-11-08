// packages/prompts/test/ollama.test.ts
// The Ollama lane.
//
// The rules under test:
//   • Production generation sends no real names; it writes from slots.
//   • Every accepted line is adult enough, names a player in the room, and has
//     its slots bound exactly.
//   • Tame lines, unbound slots, repeats and refusals are dropped.
//   • On failure the night is refused; the bank is never used.
//   • The terminal report says "asked N, accepted N, dropped N (reasons)".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GEN_TARGET_PROMPTS,
  formatReasons,
  isRefusal,
  normalizeForMatch,
  ollamaConfig,
  fillNames,
  parseLines,
  parseOllamaText,
  resolveGeminiModel,
  restoreNames,
  validateGenerated,
  Provider,
  createPromptProvider,
} from "../src/index.ts";
import { generateNight, isFilthyDare, isSpicy } from "../src/generate.ts";
import { fakeOllamaContent } from "../../../scripts/fake-ollama.ts";

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

describe("the generated night", () => {
  const names = ["Wanjiru", "Kamau", "Dee", "Otieno", "Zawadi"];

  /**
   * A stand-in model: it reads the role and line count from the request and
   * returns exactly that many valid lines. Nothing here comes from the bank.
   */
  function fakeModel(init?: { body?: string }): string {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      messages?: { role: string; content: string }[];
    };
    const user = body.messages?.find((m) => m.role === "user")?.content ?? "";
    const role = /PLAN: ([a-z-]+)/.exec(user)?.[1] ?? /ROLE: ([a-z_-]+)/.exec(user)?.[1] ?? "";
    const want = Number(/exactly (\d+)(?: JSON)? lines/.exec(user)?.[1] ?? 0);
    const lines: string[] = [];
    for (let i = 0; i < want; i++) {
      const n = i + 1;
      if (role === "look-chain") {
        lines.push(JSON.stringify({
          announce: "Everybody look at {A}.",
          act: `Look at someone you would sleep with tonight. Flavour ${n}.`,
          guess: `Who is {A} sleeping with tonight? Flavour ${n}.`,
          why: `Why that one? Flavour ${n}.`,
        }));
      } else if (role === "subject") {
        if (i % 3 === 0) lines.push(JSON.stringify({ kind: "pick", metric: "sex-desire", text: `Who would you take home tonight? Number ${n}.` }));
        else if (i % 3 === 1) lines.push(JSON.stringify({ kind: "rating", metric: "trust", text: `Rate your own sex appeal from 1 to 10. Number ${n}.` }));
        else lines.push(JSON.stringify({ kind: "text", metric: "liar", text: `What is the worst lie you told this week? Number ${n}.` }));
      } else if (role === "observer-subject") {
        lines.push(JSON.stringify({ kind: "pick", metric: "would-cheat", text: `Who would {P1} most likely sleep with tonight? Number ${n}.` }));
      } else if (role === "observer-pair") {
        lines.push(JSON.stringify({ kind: "text", metric: "couple-fit", text: `Which of {P1} and {P2} would cheat first? Number ${n}.` }));
      } else if (role === "solo") {
        lines.push(JSON.stringify({ kind: "text", text: `What is the filthiest thought you had today? Number ${n}.` }));
      } else if (role === "ship-vote") {
        lines.push(JSON.stringify({ kind: "pair_vote", metric: "gay-hypothetical", text: `If {P1} and {P2} were gay, would they make a good couple? Number ${n}.` }));
      } else if (role === "best-couple") {
        lines.push(JSON.stringify({ kind: "pair_pick", text: `Who do you think would make the best couple here? Number ${n}.` }));
      } else if (role === "dare") {
        lines.push(JSON.stringify({ kind: "dare", text: `{P1}, text your ex the filthiest thing you ever thought about them. Dare ${n}.` }));
      } else if (role === "dare-watch") {
        lines.push(JSON.stringify({ kind: "text", text: `Look at {P1} and {P2}. They were just given a dare. Do you think they will do it? Number ${n}.` }));
      }
    }
    return JSON.stringify({ choices: [{ message: { content: lines.join("\n") } }] });
  }

  const fakeFetch = async (_url: string, init?: { body?: string }) => ({
    ok: true,
    status: 200,
    text: async () => fakeModel(init),
  });

  it("writes every question and dare itself, with no bank lines", async () => {
    const report = await generateNight({
      playerCount: 5,
      seed: 4,
      aliases: names,
      fetchImpl: fakeFetch,
    });
    assert.equal(report.error, undefined);
    assert.ok(report.prompts.length >= 30, "a full night of questions");
    assert.ok(report.prompts.every((p) => p.source === "ollama"), "no bank line is played");
    assert.ok(report.prompts.every((p) => p.id.endsWith("-ollama")));
    for (const prompt of report.prompts) {
      if (prompt.measures.includes("flavour:dare-watch")) continue;
      assert.ok(isSpicy(prompt.text), `tame line was played: ${prompt.text}`);
    }
    assert.equal(report.chains.length, 6, "six generated look chains");
    assert.ok(report.chains.every((chain) => chain.guess.includes("{A}")));
    assert.ok(report.chains.every((chain) => isSpicy(chain.act)), "a tame chain act was played");
    const rating = report.prompts.find((p) => p.kind === "rating");
    assert.ok(rating, "a rating question was generated");
    assert.ok(rating!.measures.some((m) => m.startsWith("trait:")), "a generated rating has a trait for the UI");
    assert.ok(report.bestCouple, "a generated best-couple question");
    assert.equal(report.bestCouple!.source, "ollama");
    assert.equal(report.watchers.length, 2, "a generated watcher question per dare");
    for (const role of ["subject", "observer_subject", "observer_pair", "group", "dare"]) {
      assert.ok(report.prompts.some((p) => p.role === role), `no ${role} question was generated`);
    }
    for (const dare of report.prompts.filter((p) => p.role === "dare")) {
      assert.match(dare.text, /\{P1\}/, "a generated dare names its target slot");
    }
    for (const watcher of report.watchers) {
      assert.match(watcher.text, /\{P1\}/);
      assert.match(watcher.text, /\{P2\}/);
    }
  });

  it("writes enough for every room size, including the pair split", async () => {
    for (const playerCount of [4, 5, 6, 7, 8, 11]) {
      const report = await generateNight({
        playerCount,
        seed: 10 + playerCount,
        fetchImpl: fakeFetch,
      });
      assert.equal(report.error, undefined, `${playerCount} players: ${report.error ?? ""}`);
      assert.ok(report.prompts.length > 20, `${playerCount} players got a night`);
      assert.ok(report.chains.length >= 6, `${playerCount} players got chains`);
      assert.equal(report.watchers.length, Math.max(1, Math.min(2, playerCount - 3)), `${playerCount} players got watcher questions`);
      assert.ok(report.bestCouple, `${playerCount} players got the best-couple question`);
    }
  });

  it("does not send the room's real names to the model", async () => {
    let sent = "";
    await generateNight({
      playerCount: 5,
      seed: 5,
      aliases: names,
      fetchImpl: async (_url, init) => {
        sent = String(init?.body ?? "");
        return { ok: true, status: 200, text: async () => fakeModel(init) };
      },
    });
    for (const name of names) assert.ok(!sent.includes(name), `the request leaked ${name}`);
    assert.match(sent, /\{P1\}/);
  });

  it("retries a short reply instead of reaching for the bank", async () => {
    let subjectCalls = 0;
    const report = await generateNight({
      playerCount: 5,
      seed: 11,
      fetchImpl: async (_url, init) => {
        const body = String(init?.body ?? "");
        const isSubject = body.includes("PLAN: subject");
        if (isSubject) subjectCalls += 1;
        let content = fakeOllamaContent(body);
        if (isSubject && subjectCalls === 1) {
          content = content.split("\n").slice(0, 3).join("\n");
        } else if (isSubject) {
          content = content.split("\n").map((line) => line.replace("Number", "Retry Number")).join("\n");
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content } }) };
      },
    });
    assert.equal(report.error, undefined);
    assert.ok(subjectCalls >= 2, "the short subject batch was retried");
    assert.ok(report.prompts.every((p) => p.source === "ollama"));
    const subjectBatch = report.batches.find((b) => b.label === "subject");
    assert.ok(subjectBatch && subjectBatch.asked > 13, "the retry asked for the missing lines");
  });

  it("rejects tame questions instead of playing a safe night", async () => {
    const report = await generateNight({
      playerCount: 5,
      seed: 12,
      fetchImpl: async (_url, init) => {
        const body = String(init?.body ?? "");
        let content = fakeOllamaContent(body);
        if (body.includes("PLAN: subject")) {
          content = content
            .replace(/Who would you take home tonight\?/g, "What is your favourite colour?")
            .replace(/Rate your own sex appeal from 1 to 10\./g, "Rate your own patience from 1 to 10.")
            .replace(/What is the worst lie you told this week\?/g, "What is your favourite season?");
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content } }) };
      },
    });
    assert.ok(report.error);
    assert.match(report.error!, /subject/);
    assert.equal(report.prompts.filter((p) => p.role === "subject").length, 0);
    assert.equal(isSpicy("What is your favourite colour?"), false);
    assert.equal(isSpicy("Who would you take home tonight?"), true);
    assert.equal(isFilthyDare("Text your ex hello."), false);
    assert.equal(isFilthyDare("Text your ex the filthiest thing you ever thought about them."), true);
    assert.equal(isFilthyDare("{P1}, do ten push-ups."), false);
  });

  it("turns a mislabelled pick into a real pick question", async () => {
    const report = await generateNight({
      playerCount: 5,
      seed: 13,
      fetchImpl: async (_url, init) => {
        const body = String(init?.body ?? "");
        let content = fakeOllamaContent(body);
        if (body.includes("PLAN: subject")) {
          content = content.split("\n").map((line) => line.includes("Who would you take home")
            ? line.replace('"kind":"pick"', '"kind":"text"')
            : line).join("\n");
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content } }) };
      },
    });
    assert.equal(report.error, undefined);
    const pick = report.prompts.find((p) => p.role === "subject" && /take home/.test(p.text));
    assert.ok(pick);
    assert.equal(pick!.kind, "pick");
  });

  it("rejects a dare or pair question with an unbound third slot", async () => {
    const report = await generateNight({
      playerCount: 5,
      seed: 14,
      fetchImpl: async (_url, init) => {
        const body = String(init?.body ?? "");
        let content = fakeOllamaContent(body);
        if (body.includes("PLAN: dare")) {
          content = content.replace(/\{P1\},/g, "{P1}, look at {P2},");
        }
        if (body.includes("PLAN: ship-vote")) {
          content = content.replace(/\{P2\}/g, "{P2} and {P3}");
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content } }) };
      },
    });
    assert.ok(report.error);
    assert.match(report.error!, /dare/);
    assert.match(report.error!, /ship-vote/);
    assert.ok(!report.prompts.some((p) => /\{P3\}/.test(p.text)));
    assert.equal(report.prompts.filter((p) => p.role === "dare").length, 0);
  });

  it("drops a look-chain line that omits the announcement instead of inventing one", async () => {
    const report = await generateNight({
      playerCount: 5,
      seed: 15,
      fetchImpl: async (_url, init) => {
        const body = String(init?.body ?? "");
        let content = fakeOllamaContent(body);
        if (body.includes("PLAN: look-chain")) {
          content = content.replace(/"announce":"Everybody look at \{A\}\."/g, '"announce":"Everybody look."');
        }
        return { ok: true, status: 200, text: async () => JSON.stringify({ message: { content } }) };
      },
    });
    assert.ok(report.error);
    assert.match(report.error!, /look-chain/);
    assert.equal(report.chains.length, 0);
  });

  it("refuses to start from the bank when Ollama is down", async () => {
    const report = await generateNight({
      playerCount: 5,
      seed: 6,
      fetchImpl: async () => { throw new Error("connection refused"); },
    });
    assert.equal(report.offline, true);
    assert.equal(report.prompts.length, 0);
    assert.ok(report.error);
    assert.match(report.error!, /Ollama is unreachable/);
    assert.match(report.error!, /press Start again/i);
  });

  it("reports progress while it writes", async () => {
    const counts: number[] = [];
    const report = await generateNight({
      playerCount: 5,
      seed: 7,
      fetchImpl: fakeFetch,
      onProgress: (accepted) => counts.push(accepted),
    });
    assert.ok(counts.length > 0);
    assert.deepEqual([...counts].sort((a, b) => a - b), counts, "progress never goes backwards");
    assert.equal(counts[counts.length - 1], report.accepted);
  });

  it("throws instead of starting with a bank night", async () => {
    const provider = createPromptProvider({
      playerCount: 5,
      seed: 8,
      aliases: names,
      fetchImpl: async () => { throw new Error("down"); },
    });
    await assert.rejects(() => provider.generate(), /Ollama is unreachable/);
  });

  it("still lets tests use the bank explicitly, without calling a model", async () => {
    const provider = createPromptProvider({ playerCount: 5, seed: 9, offline: true });
    const prompts = await provider.generate();
    assert.ok(prompts.length > 100);
    assert.ok(prompts.every((p) => p.source === "bank"));
  });
});

describe("the room's real names", () => {
  it("fills the slots on the way in and puts them back on the way out", () => {
    const names = ["Wanjiru", "Kamau", "Dee"];
    assert.equal(fillNames("Who here would kiss {P1}?", names), "Who here would kiss Wanjiru?");
    assert.equal(restoreNames("Would Kamau text Dee at 3am?", names), "Would {P2} text {P3} at 3am?");
    assert.equal(restoreNames("Is orange the worst flavour?", names), "Is orange the worst flavour?");
    assert.equal(restoreNames("WANJIRU likes Kamau", names), "{P1} likes {P2}");
    assert.equal(fillNames("Kiss {P9}?", names), "Kiss {P9}?");
  });
});

describe("the model ids", () => {
  it("defaults to the safe Gemini model when GEMINI_MODEL is empty", () => {
    assert.equal(resolveGeminiModel(), "gemini-3.5-flash-lite");
    assert.equal(resolveGeminiModel("   "), "gemini-3.5-flash-lite");
  });

  it("lets .env choose the model for the analysis lane", () => {
    const provider = new Provider({ env: { GEMINI_API_KEY: "key", GEMINI_MODEL: "gemini-3.5-flash-lite" } });
    assert.equal(provider.modelFor("gemini", "reveal"), "gemini-3.5-flash-lite");
    const overridden = new Provider({ env: { GEMINI_API_KEY: "key", GEMINI_MODEL: "gemini-overridden" } });
    assert.equal(overridden.modelFor("gemini", "reveal"), "gemini-overridden");
  });

  it("carries none of the retired ids", () => {
    for (const retired of ["grok-4-1-fast", "gemini-3.1-pro-preview"]) {
      assert.notEqual(resolveGeminiModel(), retired);
    }
  });
});
