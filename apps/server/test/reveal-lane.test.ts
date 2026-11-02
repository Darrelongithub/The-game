// apps/server/test/reveal-lane.test.ts
// THE ANALYSIS LANE, at the seam where the server uses it.
//
//   • Gemini writes the reveal. The `reveal` purpose is a normal call now —
//     capped at ONE per night, like everything else.
//   • The local lane is handed the room's real names. Gemini is not: only
//     pseudonyms leave the process towards a remote API.
//   • No key, no answer, a bad answer — any of those means the engine's own
//     copy stands. The reveal never waits on a model.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Provider } from "../../../packages/prompts/src/index.ts";
import { SYSTEM_PROMPT } from "../../../packages/narrator/src/index.ts";
import { createProductionServices } from "../src/integratedServices.ts";
import { testServices } from "./helpers.ts";
import { ids, meta as ROSTER, pick, vote } from "../../../packages/engine/test/fixtures.ts";

/** A night with something in it: friction, a ship, a mutual. */
const NIGHT_LOG = [
  ...ids.map((id) => pick(id, "p1", "would-cheat", "friction")),
  pick("p2", "p1", "sex-desire", "couple"),
  pick("p1", "p2", "sex-desire", "couple"),
  pick("p3", "p4", "closest", "friendship"),
  pick("p4", "p3", "closest", "friendship"),
  vote("p3", "p1", "p2", 5, "couple-fit"),
  vote("p4", "p1", "p2", 5, "couple-fit"),
];

describe("the gemini reveal call", () => {
  it("is allowed at all — the guard has a slot for it", async () => {
    const seen: { url: string; body: Record<string, never> }[] = [];
    const provider = new Provider({
      geminiApiKey: "test-key",
      env: { GEMINI_MODEL: "gemini-test" },
      fetchImpl: (async (url: string, init: { body?: string }) => {
        seen.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"slides":[]}' }] } }] }),
        };
      }) as never,
    });

    const first = await provider.geminiJson({
      room: "R1",
      purpose: "reveal",
      model: provider.modelFor("gemini", "reveal"),
      system: SYSTEM_PROMPT,
      user: JSON.stringify({ slides: [{ i: 0, players: ["Player 1"] }] }),
      aliases: ["Wanjiru", "Dee"],
    });
    assert.equal(first.result.ok, true, "a reveal call is a call like any other");
    assert.deepEqual(first.value, { slides: [] });
    assert.match(seen[0]!.url, /:generateContent/);

    // ONE per room per night, then the slot is spent.
    const second = await provider.geminiJson({
      room: "R1",
      purpose: "reveal",
      model: "gemini-test",
      user: "{}",
    });
    assert.equal(second.result.ok, false, "the night only gets one reveal call");
    assert.equal(second.result.reason, "budget");

    const body = seen[0]!.body as unknown as {
      systemInstruction: { parts: { text: string }[] };
      contents: { parts: { text: string }[] }[];
    };
    assert.match(body.systemInstruction.parts[0]!.text, /analyst/);
    const sent = JSON.stringify(body.contents);
    assert.ok(!sent.includes("Wanjiru"), "no real name goes to a remote API");
    assert.ok(sent.includes("Player 1"), "the pseudonyms do");
  });

  it("says so on the terminal when Gemini is not there", async () => {
    const key = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const logs: string[] = [];
      const services = createProductionServices();
      const provider = services.createPromptProvider({
        roomId: "R2",
        playerCount: 5,
        seed: 3,
        aliases: ROSTER.players.map((p) => p.alias),
        log: (line) => logs.push(line),
      });
      assert.equal(typeof provider.analyse, "function", "the room's provider is the analysis lane");
      const value = await provider.analyse!({ slides: [{ i: 0 }], secretCards: [{ i: 0 }] });
      assert.equal(value, null, "no key means no copy, and no throw");
      assert.ok(
        logs.some((line) => /^Gemini: asked 2, used 0 \(unavailable:no-key\)$/.test(line)),
        `the terminal reports it: ${logs.join(" | ")}`,
      );
    } finally {
      if (key !== undefined) process.env.GEMINI_API_KEY = key;
    }
  });
});

describe("the finale the room actually sees", () => {
  it("is the analyst's copy, merged over the engine skeleton", async () => {
    let asked = 0;
    const services = testServices({
      analyse: async (payload) => {
        asked += 1;
        const slides = (payload.slides as { i: number; players?: string[] }[] | undefined) ?? [];
        return {
          slides: slides.map((slide) => ({
            i: slide.i,
            title: "THE ROOM TALKED",
            body: `Nobody warned us about ${slide.players?.[0] ?? "the room"}.`,
          })),
        };
      },
    });
    const provider = services.createPromptProvider({
      roomId: "R3",
      playerCount: ROSTER.players.length,
      seed: 1,
      aliases: ROSTER.players.map((p) => p.alias),
    });
    const results = services.computeResults(NIGHT_LOG, ROSTER);
    const digest = services.buildNightDigest(NIGHT_LOG, ROSTER);
    const skeleton = services.buildSkeleton(results, digest, ROSTER);
    assert.ok(skeleton.length > 0, "a night with data has slides");

    const out = await services.writeFinale(skeleton, new Map(), results, digest, ROSTER, provider);
    assert.equal(asked, 1, "the analyst is asked once, for the whole night");
    assert.ok(
      out.slides.every((slide) => slide.title === "THE ROOM TALKED"),
      "what Gemini wrote is what the room sees",
    );
    assert.ok(
      out.slides.every((slide) => !JSON.stringify(slide).includes("Wanjiru")),
      "the merged copy is still pseudonymised",
    );

    // Without a provider the engine copy stands, untouched.
    const alone = await services.writeFinale(skeleton, new Map(), results, digest, ROSTER);
    assert.deepEqual(
      alone.slides.map((slide) => slide.title),
      skeleton.map((slide) => slide.title),
      "no analyst, no rewrite",
    );
  });

  it("hands the share card the slides' own headline lines", async () => {
    const services = testServices();
    const results = services.computeResults(NIGHT_LOG, ROSTER);
    const digest = services.buildNightDigest(NIGHT_LOG, ROSTER);
    const skeleton = services.buildSkeleton(results, digest, ROSTER);
    const out = await services.writeFinale(skeleton, new Map(), results, digest, ROSTER);
    assert.ok(Object.keys(out.summary).length > 0, "a night with a ship has a headline");
    for (const [key, line] of Object.entries(out.summary)) {
      assert.ok(["couple", "core", "hates"].includes(key), `only the three headline lines: ${key}`);
      assert.ok(
        out.slides.some((slide) => slide.body === line || slide.title === line),
        "a share-card line is a slide line, never a new sentence",
      );
      assert.ok(!String(line).includes("Wanjiru"), "and it is pseudonymised");
    }
  });
});
