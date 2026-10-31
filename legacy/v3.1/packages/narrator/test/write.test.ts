// test/write.test.ts — ONE provider call, every response validated, silence
// on every failure. Zero real network: fetch is always mocked.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FinaleSlide, PlayerId, SecretCard } from "../../shared/src/contracts.ts";
import { buildSkeleton, sourceOf } from "../src/slides.ts";
import { narrateNight, writeFinale } from "../src/write.ts";
import { applyAliasesToDecks, applyAliasesToSlides } from "../src/index.ts";
import { derivePseudonyms, scrubAliases, swapPseudonyms } from "../src/roster.ts";
import { night, ROSTER } from "./fixtures.ts";

const READY = (): {
  skeleton: FinaleSlide[];
  decks: Map<PlayerId, SecretCard[]>;
  night: ReturnType<typeof night>;
} => {
  const fresh = night();
  return {
    skeleton: buildSkeleton(fresh.results, fresh.digest, ROSTER),
    decks: fresh.decks,
    night: fresh,
  };
};

interface Call {
  url: string;
  init: RequestInit;
}

type Responder = (call: Call) => Response | Promise<Response>;

const mockFetch = (respond: Responder): { impl: typeof fetch; calls: Call[] } => {
  const calls: Call[] = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
};

const envelope = (payload: unknown): Response =>
  new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

const rawEnvelope = (text: string): Response =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const grokOptions = (fetchImpl: typeof fetch, roster = ROSTER) => ({
  roster,
  grok: async (payload: Record<string, unknown>) => {
    const response = await fetchImpl("https://api.x.ai/v1/chat/completions", {
      method: "POST", headers: { authorization: "Bearer synthetic-test-key" },
      body: JSON.stringify({ model: "grok-4-1-fast", messages: [{ role: "user", content: JSON.stringify(payload) }] }),
    });
    if (!response.ok) throw new Error(`Grok mock HTTP ${response.status}`);
    const envelope = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    const text = envelope.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    return JSON.parse(text) as unknown;
  },
});

const validCopy = {
  title: "THE ROOM HAS SPOKEN",
  body: "This is the story of the night, told by the numbers.",
};

/** Quote / dodge slides must keep their verbatim material (see keepsVerbatim). */
const bodyFor = (slide: FinaleSlide): string => sourceOf(slide)?.verbatim ? (slide.body ?? "") : validCopy.body;

const fullResponse = (slides: readonly FinaleSlide[]) => ({
  slides: slides.map((slide, index) => ({ i: index, title: validCopy.title, body: bodyFor(slide) })),
  secretCards: [],
});

const sortedDeck = (decks: Map<PlayerId, SecretCard[]>): Record<string, SecretCard[]> =>
  Object.fromEntries([...decks.entries()].sort(([a], [b]) => a.localeCompare(b)));

describe("canonical alias privacy", () => {
  it("scrubs Unicode-equivalent names while preserving unrelated verbatim text", () => {
    const data = night();
    const roster = [{ id: "p1", alias: "Zoë" }];
    const ps = derivePseudonyms(data.results, data.digest, roster);
    assert.equal(scrubAliases("Zoe\u0308 told me co\u0308operate", ps, roster), "Player 1 told me co\u0308operate");
    assert.equal(scrubAliases("A totally unrelated co\u0308operative", ps, roster), "A totally unrelated co\u0308operative");
    const otherRoster = [{ id: "p1", alias: "İris" }, { id: "p2", alias: "ΟΣΣ" }];
    const other = derivePseudonyms(data.results, data.digest, otherRoster);
    assert.equal(scrubAliases("İris and οσσ", other, otherRoster), "Player 1 and Player 2");
  });
});

describe("no key — the whole show runs on the engine", () => {
  it("makes zero network calls and returns the skeleton untouched", async () => {
    const { skeleton, decks, night: data } = READY();
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      roster: ROSTER,
    });
    assert.deepEqual(out.slides, skeleton);
    assert.deepEqual(sortedDeck(out.decks), sortedDeck(decks));
  });

  it("runs with deterministic copy when no Grok callback is configured", async () => {
    const { skeleton, decks, night: data } = READY();
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      roster: ROSTER,
    });
    assert.equal(out.slides.length, skeleton.length);
  });

  it("returns fully populated slides and decks from evidence alone", async () => {
    const { skeleton, decks, night: data } = READY();
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      roster: ROSTER,
    });

    assert.ok(out.slides.length >= 10);
    for (const slide of out.slides) {
      assert.ok(slide.title.trim().length > 0);
      assert.ok((slide.body ?? "").trim().length > 0);
    }
    assert.ok(out.decks.size >= 3);
    for (const [, cards] of out.decks) {
      for (const card of cards) {
        assert.ok(card.title.trim().length > 0);
        assert.ok(card.facts.length >= 1 && card.facts.length <= 4);
        for (const fact of card.facts) assert.ok(fact.trim().length > 0);
      }
    }
  });
});

describe("Grok reveal lane", () => {
  it("uses one injected Grok request with structured pseudonymous payload", async () => {
    const { skeleton, decks, night: data } = READY();
    const { impl, calls } = mockFetch(() => envelope(fullResponse(skeleton)));
    const copy = await writeFinale(skeleton, decks, data.results, data.digest, grokOptions(impl));
    assert.equal(copy.slides.length, skeleton.length);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /api\.x\.ai\/v1\/chat\/completions/u);
    assert.equal(JSON.parse(String(calls[0]!.init.body)).model, "grok-4-1-fast");
  });

  it("keeps deterministic copy when the Grok lane refuses or fails", async () => {
    const { skeleton, decks, night: data } = READY();
    const { impl, calls } = mockFetch(() => new Response("rate limited", { status: 429 }));
    const copy = await writeFinale(skeleton, decks, data.results, data.digest, grokOptions(impl));
    assert.equal(calls.length, 1);
    assert.deepEqual(copy.slides, skeleton);
  });
});

describe("validation on every response", () => {
  it("merges valid copy", async () => {
    const { skeleton, decks, night: data } = READY();
    const { impl } = mockFetch(() => envelope(fullResponse(skeleton)));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    out.slides.forEach((slide, index) => {
      const base = skeleton[index] as FinaleSlide;
      assert.equal(slide.title, validCopy.title);
      assert.equal(slide.body, bodyFor(base));
    });
  });

  it("falls back per slide when the model invents a number", async () => {
    const { skeleton, decks, night: data } = READY();
    const blind = skeleton.findIndex((slide) => slide.claimId === "c-blind");
    const response = fullResponse(skeleton);
    (response.slides[blind] as { body: string }).body = "The room gives 47 nominations.";

    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });

    assert.equal(out.slides[blind]?.body, skeleton[blind]?.body);
    assert.equal(out.slides[blind + 1]?.body, bodyFor(skeleton[blind + 1] as FinaleSlide));
  });

  it("falls back when the model names a player outside the roster", async () => {
    const { skeleton, decks, night: data } = READY();
    const response = fullResponse(skeleton);
    (response.slides[3] as { body: string }).body = "Player 9 did this to us.";
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.equal(out.slides[3]?.body, skeleton[3]?.body);
  });

  it("falls back when the model names a player who is not on that slide", async () => {
    const { skeleton, decks, night: data } = READY();
    const rival = skeleton.findIndex((slide) => slide.claimId === "c-rival");
    const response = fullResponse(skeleton);
    (response.slides[rival] as { body: string }).body = "Player 1 started it.";
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.equal(out.slides[rival]?.body, skeleton[rival]?.body);
  });

  it("falls back on a banned phrase, a long body and a long title", async () => {
    const { skeleton, decks, night: data } = READY();
    const response = fullResponse(skeleton);
    (response.slides[1] as { body: string }).body = "Honestly, that is a red flag.";
    (response.slides[2] as { body: string }).body = "x".repeat(141);
    (response.slides[3] as { title: string }).title = "THIS TITLE HAS SEVEN WORDS IN IT NOW";
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });

    assert.equal(out.slides[1]?.body, skeleton[1]?.body);
    assert.equal(out.slides[2]?.body, skeleton[2]?.body);
    assert.equal(out.slides[3]?.title, skeleton[3]?.title);
    assert.equal(out.slides[3]?.body, bodyFor(skeleton[3] as FinaleSlide));
  });

  it("rejects an alias and a refusal in model copy", async () => {
    const { skeleton, decks, night: data } = READY();
    const response = fullResponse(skeleton);
    (response.slides[4] as { body: string }).body = "Maya said it best.";
    (response.slides[5] as { body: string }).body = "I'm sorry, but I can't help with that.";
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.equal(out.slides[4]?.body, skeleton[4]?.body);
    assert.equal(out.slides[5]?.body, skeleton[5]?.body);
  });

  it("rejects a paraphrase of verbatim digest material", async () => {
    const { skeleton, decks, night: data } = READY();
    const quote = skeleton.findIndex((slide) => slide.flavor === "quote");
    const dodge = skeleton.findIndex((slide) => slide.flavor === "dodge");
    const response = fullResponse(skeleton);
    (response.slides[quote] as { body: string }).body = "They said they would fight a bus for this group.";
    (response.slides[dodge] as { body: string }).body = "\"My mum was watching.\" — Player 2";

    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });

    assert.equal(out.slides[quote]?.body, skeleton[quote]?.body);
    assert.equal(out.slides[dodge]?.body, skeleton[dodge]?.body);
  });

  it("accepts a verbatim quote with new framing around it", async () => {
    const { skeleton, decks, night: data } = READY();
    const quote = skeleton.findIndex((slide) => slide.flavor === "quote");
    const response = fullResponse(skeleton);
    (response.slides[quote] as { body: string }).body =
      "Player 1, mid-round: \"I would fight a bus for this group, and I would lose.\"";

    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });

    assert.equal(out.slides[quote]?.body, response.slides[quote]?.body);
  });

  it("ignores entries that try to rewrite the beat or the numbers", async () => {
    const { skeleton, decks, night: data } = READY();
    const toxic = skeleton.findIndex((slide) => slide.flavor === "group");
    const response = fullResponse(skeleton);
    Object.assign(response.slides[toxic] as object, {
      beat: "tease",
      flavor: "stat",
      numbers: { votes: 99 },
      claimId: "c-onesided",
    });
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.equal(out.slides[toxic]?.beat, skeleton[toxic]?.beat);
    assert.equal(out.slides[toxic]?.flavor, skeleton[toxic]?.flavor);
    assert.deepEqual(out.slides[toxic]?.numbers, skeleton[toxic]?.numbers);
    assert.equal(out.slides[toxic]?.claimId, skeleton[toxic]?.claimId);
  });

  it("keeps engine copy for slides the model skipped or invented", async () => {
    const { skeleton, decks, night: data } = READY();
    const response = {
      slides: [
        { i: 0, ...validCopy },
        { i: 999, ...validCopy },
        { i: -1, ...validCopy },
        { i: "x", ...validCopy },
      ],
      secretCards: [],
    };
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.equal(out.slides[0]?.body, bodyFor(skeleton[0] as FinaleSlide));
    for (let index = 1; index < skeleton.length; index += 1) {
      assert.deepEqual(out.slides[index], skeleton[index]);
    }
  });
});

describe("secret cards", () => {
  const cardIndex = (out: Map<PlayerId, SecretCard[]>, player: PlayerId, id: string): SecretCard => {
    const card = (out.get(player) ?? []).find((candidate) => candidate.id === id);
    assert.ok(card, `missing card ${id}`);
    return card;
  };

  it("merges validated card copy and keeps order and ids", async () => {
    const { skeleton, decks, night: data } = READY();
    const response = {
      slides: [],
      secretCards: [
        { i: 0, title: "SPARK", facts: decks.get("p2")![0]!.facts },
        { i: 3, title: "BLIND SPOT", facts: ["You are louder than you think."] },
      ],
    };
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });

    assert.deepEqual([...(out.decks.get("p2") ?? [])].map((card) => card.id), ["s-spark", "s-stat"]);
    assert.deepEqual(cardIndex(out.decks, "p2", "s-spark").facts, decks.get("p2")![0]!.facts);
    assert.equal(cardIndex(out.decks, "p2", "s-spark").kind, "spark");
  });

  it("rejects a card fact with an invented number and keeps the engine card", async () => {
    const { skeleton, decks, night: data } = READY();
    const response = {
      slides: [],
      secretCards: [{ i: 0, title: "SPARK", facts: ["You picked each other 5 times."] }],
    };
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.deepEqual(cardIndex(out.decks, "p2", "s-spark").facts, decks.get("p2")?.[0]?.facts);
  });

  it("rejects banned phrases and oversized facts on cards", async () => {
    const { skeleton, decks, night: data } = READY();
    const engineFacts = decks.get("p6")?.[0]?.facts;
    const response = {
      slides: [],
      secretCards: [
        { i: 2, title: "BLIND SPOT", facts: ["You are a walking red flag."] },
        { i: 3, title: "BLIND SPOT", facts: ["x".repeat(121)] },
      ],
    };
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.deepEqual(cardIndex(out.decks, "p6", "s-blindspot").facts, engineFacts);
  });

  it("never puts a card on a phone that had none", async () => {
    const { skeleton, decks, night: data } = READY();
    const response = { slides: [], secretCards: [{ i: 0, title: "SPARK", facts: ["Nice."] }] };
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.deepEqual([...out.decks.keys()].sort(), ["p1", "p2", "p6"]);
  });
});

describe("degradation is silent and total", () => {
  it("times out to pure fallback", async () => {
    const { skeleton, decks, night: data } = READY();
    const impl = (async () => { throw Object.assign(new Error("timed out"), { name: "AbortError" }); }) as unknown as typeof fetch;

    const started = Date.now();
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.ok(Date.now() - started < 3_000);
    assert.deepEqual(out.slides, skeleton);
  });

  it("falls back on HTTP errors, junk JSON and prose", async () => {
    const { skeleton, decks, night: data } = READY();
    const cases: Responder[] = [
      () => new Response("overloaded", { status: 429 }),
      () => new Response("not json at all", { status: 200 }),
      () => rawEnvelope("Sure! Here is your finale: it was a fun night."),
      () => new Response(JSON.stringify({ promptFeedback: { blockReason: "OTHER" } }), { status: 200 }),
      () => envelope({ slides: "nope", secretCards: 42 }),
    ];
    for (const respond of cases) {
      const { impl } = mockFetch(respond);
      const out = await writeFinale(skeleton, decks, data.results, data.digest, {
        ...grokOptions(impl),
        roster: ROSTER,
      });
      assert.deepEqual(out.slides, skeleton);
      assert.deepEqual(sortedDeck(out.decks), sortedDeck(decks));
    }
  });

  it("never accepts empty strings from the model", async () => {
    const { skeleton, decks, night: data } = READY();
    const response = { slides: skeleton.map((_, i) => ({ i, title: "", body: "  " })), secretCards: [] };
    const { impl } = mockFetch(() => envelope(response));
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.deepEqual(out.slides, skeleton);
  });

  it("survives a thrown fetch", async () => {
    const { skeleton, decks, night: data } = READY();
    const impl = (async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const out = await writeFinale(skeleton, decks, data.results, data.digest, {
      ...grokOptions(impl),
      roster: ROSTER,
    });
    assert.deepEqual(out.slides, skeleton);
  });
});

describe("facade & the server's alias swap", () => {
  it("narrateNight builds the skeleton and narrates it in one call", async () => {
    const data = night();
    const out = await narrateNight({
      results: data.results,
      digest: data.digest,
      decks: data.decks,
      roster: ROSTER,
    });
    assert.ok(out.slides.length > 10);
    assert.equal(out.slides.at(-1)?.title, "THAT'S THE NIGHT");
    assert.equal(out.decks.size, 3);
  });

  it("swaps Player N back to aliases without prefix collisions", () => {
    const roster = Array.from({ length: 12 }, (_, index) => ({
      id: `p${index + 1}`,
      alias: `Alias${index + 1}`,
    }));
    assert.equal(swapPseudonyms("Player 1 and Player 10", roster), "Alias1 and Alias10");
    assert.equal(swapPseudonyms("Player 2 picked Player 10", roster), "Alias2 picked Alias10");
  });

  it("applies the swap to public slides and to a single phone's deck", () => {
    const { skeleton, decks } = READY();
    const slides = applyAliasesToSlides(skeleton, ROSTER);
    const quote = slides.find((slide) => slide.flavor === "quote");
    assert.match(quote?.body ?? "", /— Maya$/);

    const swapped = applyAliasesToDecks(decks, ROSTER);
    assert.equal(
      swapped.get("p1")?.[0]?.facts[0],
      "You kept picking Zed. They kept picking Imani.",
    );
    assert.equal(swapped.get("p2")?.[0]?.title, "SPARK: Zed + Tunde");
    assert.equal(swapped.get("p2")?.[0]?.kind, "spark");
    // the input map is never mutated
    assert.equal(decks.get("p2")?.[0]?.title, "SPARK: Player 2 + Player 5");
  });
});
