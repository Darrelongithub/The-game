// packages/narrator/test/narrator.test.ts
// The finale: deterministic slides from the verdicts, and the pseudonym
// discipline that keeps real aliases out of the broadcast.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyAliasesToDecks,
  applyAliasesToSlides,
  buildSkeleton,
  derivePseudonyms,
  narrateNight,
  summaryFor,
  writeFinale,
} from "../src/index.ts";
import type { NightDigest, Results, SecretCard } from "../../shared/src/contracts.ts";

const meta = {
  roomId: "TEST",
  players: [
    { id: "p1", alias: "Wanjiru" },
    { id: "p2", alias: "Dee" },
    { id: "p3", alias: "Kofi" },
    { id: "p4", alias: "Zuri" },
  ],
};

const results: Results = {
  roomId: "TEST",
  verdicts: [
    {
      id: "couple-p1-p2",
      kind: "couple",
      subjects: ["p1", "p2"],
      tone: "spicy",
      text: "Player 1 and Player 2 would lowkey be a good couple (67% said yes).",
      numbers: { yes: 2, voters: 3, share: 0.67 },
      strength: 0.67,
    },
    {
      id: "percent-sex-desire-p3",
      kind: "percent",
      subjects: ["p3"],
      tone: "spicy",
      text: "75% of people here want to have sex with Player 3.",
      numbers: { voters: 3, eligible: 4, share: 0.75 },
      strength: 0.75,
    },
    {
      id: "weak-p4",
      kind: "freeagent",
      subjects: ["p4"],
      tone: "mild",
      text: "Nobody in this room is claiming Player 4.",
      numbers: { asked: 4 },
      strength: 0.1,
    },
  ],
  pairScores: [],
  computedAt: 0,
};

const digest: NightDigest = {
  quotes: [{ alias: "Wanjiru", text: "I once woke up in the wrong apartment entirely", context: "q1" }],
  stats: { fastest: { alias: "Dee", ms: 1200 } },
  runningGags: [],
  pickTeasers: [],
  dodges: [{ alias: "Kofi", reason: "My mother would know my location" }],
  selfVsRoom: [],
};

describe("the skeleton", () => {
  it("builds one slide per verdict that has the strength to play", () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const slides = buildSkeleton(results, digest, ps);
    assert.ok(slides.length >= 2);
    // The weak verdict does not make the show.
    assert.ok(!slides.some((s) => s.body?.includes("Player 4")));
  });

  it("never contains a real alias — only Player N", () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const slides = buildSkeleton(results, digest, ps);
    for (const slide of slides) {
      const text = `${slide.title} ${slide.body ?? ""}`;
      for (const alias of ["Wanjiru", "Dee", "Kofi", "Zuri"]) {
        assert.ok(!text.includes(alias), `slide leaks the alias ${alias}`);
      }
    }
  });

  it("quotes the night verbatim, with attribution", () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const slides = buildSkeleton(results, digest, ps);
    const quote = slides.find((s) => s.flavor === "quote");
    assert.ok(quote);
    assert.match(quote!.body!, /I once woke up in the wrong apartment entirely/);
  });

  it("summarises the night for the reveal header", () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const summary = summaryFor(results, ps);
    assert.equal(summary.couple, "Player 1");
  });
});

describe("the alias swap", () => {
  it("puts the real names back on the way out", () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const slides = buildSkeleton(results, digest, ps);
    const swapped = applyAliasesToSlides(slides, meta.players);
    const text = swapped.map((s) => `${s.title} ${s.body ?? ""}`).join(" ");
    assert.ok(text.includes("Wanjiru"));
    assert.ok(!text.includes("Player 1"));
  });

  it("swaps the aliases inside a secret deck too", () => {
    const decks = new Map<string, SecretCard[]>([
      ["p1", [{ id: "c1", kind: "crush", title: "Mutual crush", facts: ["You and Player 2 like each other."] }]],
    ]);
    const swapped = applyAliasesToDecks(decks as never, meta.players);
    assert.match(swapped.get("p1")![0]!.facts[0]!, /Wanjiru|Dee|Kofi|Zuri/);
  });
});

describe("writeFinale", () => {
  it("returns the deterministic slides when there is no model", async () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const skeleton = buildSkeleton(results, digest, ps);
    const out = await writeFinale(skeleton, new Map(), results, digest, { roster: meta.players });
    assert.equal(out.slides.length, skeleton.length);
  });

  it("keeps the engine line when the model says something unusable", async () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const skeleton = buildSkeleton(results, digest, ps);
    const out = await writeFinale(skeleton, new Map(), results, digest, {
      roster: meta.players,
      gemini: async () => ({
        slides: [{ i: 0, title: "As an AI I cannot do this", body: "Also 47 elephants." }],
      }),
    });
    assert.ok(!out.slides[0]!.title!.toLowerCase().includes("as an ai"));
    assert.ok(!out.slides[0]!.body!.includes("47"));
  });

  it("takes a good line from the model", async () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const skeleton = buildSkeleton(results, digest, ps);
    const out = await writeFinale(skeleton, new Map(), results, digest, {
      roster: meta.players,
      gemini: async () => ({
        slides: [{ i: 0, title: "The numbers", body: "Player 3 is the one everybody wants to take home tonight." }],
      }),
    });
    assert.equal(out.slides[0]!.body, "Player 3 is the one everybody wants to take home tonight.");
  });

  it("rejects a model line that names a player who is not on the slide", async () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const skeleton = buildSkeleton(results, digest, ps);
    const out = await writeFinale(skeleton, new Map(), results, digest, {
      roster: meta.players,
      gemini: async () => ({
        slides: [{ i: 0, title: "The numbers", body: "Player 1 and Player 2 would absolutely wreck it tonight." }],
      }),
    });
    assert.equal(out.slides[0]!.body, "75% of people here want to have sex with Player 3.");
  });

  it("hands the analyst the whole night, with no real names in it", async () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const skeleton = buildSkeleton(results, digest, ps);
    let sent: Record<string, unknown> | null = null;
    await writeFinale(skeleton, new Map(), results, digest, {
      roster: meta.players,
      gemini: async (payload) => {
        sent = payload;
        return null;
      },
    });
    const seen = sent as Record<string, unknown> | null;
    assert.ok(seen, "the analysis lane is called once");
    const night = seen!.night as Record<string, unknown>;
    assert.ok(Array.isArray(night!.quotes) && night.quotes.length > 0, "the night's lines are in it");
    assert.ok(Array.isArray(night!.dodges), "the excuses are in it");
    assert.ok(Array.isArray(night!.selfVsRoom), "self vs room is in it");
    const json = JSON.stringify(seen);
    for (const player of meta.players) assert.ok(!json.includes(player.alias), `no real alias (${player.alias})`);
  });

  it("never lets the model print a real alias", async () => {
    const ps = derivePseudonyms(results, digest, meta.players);
    const skeleton = buildSkeleton(results, digest, ps);
    const out = await writeFinale(skeleton, new Map(), results, digest, {
      roster: meta.players,
      gemini: async () => ({
        slides: [{ i: 0, title: "Wanjiru", body: "Wanjiru is the one everybody is watching." }],
      }),
    });
    const text = out.slides.map((s) => `${s.title} ${s.body ?? ""}`).join(" ");
    assert.ok(!text.includes("Wanjiru"));
  });
});

describe("narrateNight", () => {
  it("builds and writes in one call", async () => {
    const out = await narrateNight(results, digest, new Map(), { roster: meta.players });
    assert.ok(out.slides.length > 0);
  });
});
