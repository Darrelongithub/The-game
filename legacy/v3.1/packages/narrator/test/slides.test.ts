// test/slides.test.ts — skeleton shape, order, arithmetic and privacy.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FinaleSlide, NightDigest, Results } from "../../shared/src/contracts.ts";
import {
  buildSkeleton,
  clip,
  NARRATOR_TUNING,
  pickContradiction,
  sourceOf,
} from "../src/slides.ts";
import { sourceOf as _sourceOf } from "../src/slides.ts";
import { LIMITS, validateBody, validateTitle } from "../src/validate.ts";
import { night, PRIVATE_CLAIM_IDS, ROSTER } from "./fixtures.ts";

const titles = (slides: FinaleSlide[]): string[] => slides.map((slide) => slide.title);

const EMPTY_DIGEST: NightDigest = {
  quotes: [],
  stats: {},
  runningGags: [],
  pickTeasers: [],
  dodges: [],
  selfVsRoom: [],
};

describe("story order", () => {
  const skeleton = buildSkeleton(night().results, night().digest, ROSTER);

  it("opens on the title and closes on the closing slide", () => {
    assert.equal(skeleton[0]?.title, "THE ROOM HAS SPOKEN");
    assert.equal(skeleton[0]?.beat, "tease");
    assert.equal(skeleton.at(-1)?.title, "THAT'S THE NIGHT");
    assert.equal(skeleton.at(-1)?.beat, "land");
  });

  it("plays besties as tease → escalate → land", () => {
    const besties = skeleton.filter((slide) => slide.claimId === "c-besties");
    assert.deepEqual(
      besties.map((slide) => slide.beat),
      ["tease", "escalate", "land"],
    );
    assert.deepEqual(besties.map((slide) => slide.flavor), ["claim", "claim", "claim"]);
  });

  it("puts rivals before consensus and wilder claims before blind spots", () => {
    const index = (claimId: string) => skeleton.findIndex((slide) => slide.claimId === claimId);
    assert.ok(index("c-rival") > index("c-besties"));
    assert.ok(index("c-consensus") > index("c-rival"));
    assert.ok(index("c-blind") > index("c-consensus"));
    assert.ok(index("c-toxic") > index("c-blind"));
  });

  it("lands the SHIP last and biggest — after toxic", () => {
    const toxic = skeleton.findIndex((slide) => slide.claimId === "c-toxic");
    const shipSlides = skeleton.filter((slide) => slide.claimId === "c-ship");
    const shipLand = skeleton.findIndex(
      (slide) => slide.claimId === "c-ship" && slide.beat === "land",
    );
    assert.ok(toxic >= 0 && shipLand > toxic, "toxic must land before the ship");
    assert.deepEqual(shipSlides.map((slide) => slide.beat), ["tease", "escalate", "land"]);
    assert.equal(skeleton[shipLand]?.title, "SHIPPED");
  });

  it("runs the digest block: quote → dodge report → speed runner", () => {
    const quote = skeleton.findIndex((slide) => slide.flavor === "quote");
    const dodge = skeleton.findIndex((slide) => slide.flavor === "dodge");
    const speed = skeleton.findIndex((slide) => slide.title === "SPEED RUNNER");
    assert.ok(quote >= 0 && dodge > quote && speed > dodge);
    assert.ok(speed < skeleton.findIndex((slide) => slide.claimId === "c-toxic"));
  });

  it("quotes the night verbatim, attributed as Player N", () => {
    const quote = skeleton.find((slide) => slide.flavor === "quote");
    assert.ok(quote);
    assert.match(quote.body ?? "", /I would fight a bus for this group, and I would lose\./);
    assert.match(quote.body ?? "", /— Player 1$/);
  });

  it("lists every excuse verbatim in the Dodge Report", () => {
    const dodges = skeleton.filter((slide) => slide.flavor === "dodge");
    assert.equal(dodges.length, 2);
    assert.ok(dodges.some((slide) => (slide.body ?? "").includes("my mother is watching this game")));
    assert.ok(dodges.some((slide) => (slide.body ?? "").includes("I have a thing. It is a real thing.")));
    assert.match(dodges[0]?.body ?? "", /— Player 2$/);
  });

  it("gives the speed runner a real millisecond number", () => {
    const speed = skeleton.find((slide) => slide.title === "SPEED RUNNER");
    assert.ok(speed);
    assert.equal(speed.flavor, "stat");
    assert.deepEqual(speed.numbers, { ms: 940 });
    assert.match(speed.body ?? "", /Player 3 .*940ms/);
  });

  it("derives one contradiction from digest data", () => {
    const derived = pickContradiction(night().digest);
    assert.deepEqual(derived, {
      trait: "honesty",
      self: 9,
      roomMean: 5,
      dodges: 1,
      who: "Zed",
    });
    const slide = skeleton.find((candidate) => candidate.title === "CONTRADICTION WATCH");
    assert.ok(slide);
    assert.equal(slide.flavor, "stat");
    assert.deepEqual(slide.numbers, { self: 9, roomMean: 5, dodges: 1 });
    assert.match(slide.body ?? "", /Player 2 gave their own honesty a 9/);
  });

  it("gives the free agent their own slide", () => {
    const slide = skeleton.find((candidate) => candidate.title === "FREE AGENT");
    assert.ok(slide);
    assert.match(slide.body ?? "", /Player 7/);
  });
});

describe("group announcements", () => {
  const skeleton = buildSkeleton(night().results, night().digest, ROSTER);

  it("marks consensus claims as group announcements with untouched numbers", () => {
    const consensus = skeleton.find((slide) => slide.claimId === "c-consensus");
    assert.ok(consensus);
    assert.equal(consensus.flavor, "group");
    assert.deepEqual(consensus.numbers, { votes: 6, of: 8, share: 0.75 });
    assert.match(consensus.body ?? "", /6 of 8/);
  });

  it("treats the most-toxic land beat as a group announcement", () => {
    const toxic = skeleton.find((slide) => slide.claimId === "c-toxic");
    assert.ok(toxic);
    assert.equal(toxic.flavor, "group");
    assert.equal(toxic.beat, "land");
    assert.deepEqual(toxic.numbers, { percentile: 0.93, nominations: 11 });
  });

  it("never groups a private or low-confidence claim", () => {
    for (const slide of skeleton) {
      if (slide.flavor !== "group") continue;
      assert.ok(!PRIVATE_CLAIM_IDS.includes(slide.claimId as never));
    }
  });
});

describe("privacy — no private slide, ever", () => {
  it("never emits a onesided or spark slide", () => {
    const skeleton = buildSkeleton(night().results, night().digest, ROSTER);
    for (const slide of skeleton) {
      assert.ok(
        !PRIVATE_CLAIM_IDS.includes(slide.claimId as never),
        `private claim leaked onto a slide: ${slide.claimId}`,
      );
    }
    const text = skeleton.map((slide) => `${slide.title} ${slide.body ?? ""}`).join(" ");
    assert.ok(!text.includes("picks someone else"), "private evidence leaked into public copy");
    assert.ok(!text.includes("opted in"), "spark evidence leaked into public copy");
  });

  it("drops a low-confidence negative even if upstream marked it public", () => {
    const skeleton = buildSkeleton(night().results, night().digest, ROSTER);
    const text = skeleton.map((slide) => slide.body ?? "").join(" ");
    assert.ok(!text.includes("stray nomination"));
    assert.equal(skeleton.some((slide) => slide.claimId === "c-toxic-low"), false);
  });

  it("emits no real alias anywhere, even with the full roster available", () => {
    const skeleton = buildSkeleton(night().results, night().digest, ROSTER);
    const text = JSON.stringify(skeleton).toLowerCase();
    for (const { alias } of ROSTER) {
      assert.ok(!text.includes(alias.toLowerCase()), `alias "${alias}" leaked into a slide`);
    }
  });

  it("drops attribution instead of guessing when no roster is given", () => {
    const skeleton = buildSkeleton(night().results, night().digest);
    const quote = skeleton.find((slide) => slide.flavor === "quote");
    assert.ok(quote);
    assert.match(quote.body ?? "", /I would fight a bus/);
    assert.ok(!(quote.body ?? "").includes("— Player"), "no roster must mean no guessed attribution");
  });
});

describe("engine fallbacks — every slide is populated and self-consistent", () => {
  const skeleton = buildSkeleton(night().results, night().digest, ROSTER);

  it("always has a non-empty title within the limit", () => {
    for (const slide of skeleton) {
      assert.ok(slide.title.trim().length > 0);
      assert.ok(slide.title.trim().split(/\s+/).length <= NARRATOR_TUNING.titleMaxWords);
      assert.ok(slide.title.length <= LIMITS.titleMaxChars);
    }
  });

  it("always has a non-empty body within 140 chars", () => {
    for (const slide of skeleton) {
      assert.ok((slide.body ?? "").trim().length > 0, `empty body on "${slide.title}"`);
      assert.ok((slide.body ?? "").length <= LIMITS.bodyMaxChars);
    }
  });

  it("passes its own validator: numbers, players and aliases are all sourced", () => {
    for (const slide of skeleton) {
      const source = sourceOf(slide);
      assert.ok(source, `missing source for "${slide.title}"`);
      const limits = {
        numbers: source.numbers,
        players: source.players,
        maxPlayer: ROSTER.length,
        aliases: ROSTER.map((entry) => entry.alias),
      };
      const title = validateTitle(slide.title, limits);
      assert.equal(title.ok, true, `engine title rejected: ${JSON.stringify(title)}`);
      const body = validateBody(slide.body, limits);
      assert.equal(body.ok, true, `engine body rejected: ${JSON.stringify(body)}`);
    }
  });

  it("renders from evidence alone when the digest is empty", () => {
    const slides = buildSkeleton(night().results, EMPTY_DIGEST, ROSTER);
    assert.ok(slides.length >= 8);
    assert.equal(slides.some((slide) => slide.flavor === "quote"), false);
    assert.equal(slides.some((slide) => slide.flavor === "dodge"), false);
    for (const slide of slides) assert.ok((slide.body ?? "").length > 0);
  });

  it("degrades to title + closing when the engine found nothing", () => {
    const bare: Results = {
      roomId: "AB2C",
      claims: [],
      pairScores: [],
      computedAt: 1,
    };
    const slides = buildSkeleton(bare, EMPTY_DIGEST);
    assert.deepEqual(titles(slides), ["THE ROOM HAS SPOKEN", "THAT'S THE NIGHT"]);
  });

  it("still fills a body when a claim has no evidence", () => {
    const bare: Results = {
      roomId: "AB2C",
      claims: [
        {
          id: "c-ship",
          type: "ship",
          subjects: ["p1", "p2"],
          audience: "public",
          confidence: "med",
          evidence: [],
        },
      ],
      pairScores: [],
      computedAt: 1,
    };
    const slides = buildSkeleton(bare, EMPTY_DIGEST);
    const land = slides.find((slide) => slide.title === "SHIPPED");
    assert.ok(land);
    assert.ok((land.body ?? "").length > 0);
  });
});

describe("determinism & tuning", () => {
  it("is a pure function of its inputs", () => {
    const first = buildSkeleton(night().results, night().digest, ROSTER);
    const second = buildSkeleton(night().results, night().digest, ROSTER);
    assert.deepEqual(first, second);
  });

  it("does not mutate the engine payload", () => {
    const { results, digest } = night();
    const before = JSON.stringify({ results, digest });
    buildSkeleton(results, digest, ROSTER);
    assert.equal(JSON.stringify({ results, digest }), before);
  });

  it("caps the noisy sections", () => {
    const skeleton = buildSkeleton(night().results, night().digest, ROSTER);
    assert.ok(skeleton.filter((slide) => slide.flavor === "dodge").length <= NARRATOR_TUNING.maxDodgeSlides);
    assert.ok(skeleton.filter((slide) => slide.claimId === "c-blind").length <= NARRATOR_TUNING.maxBlindspotSlides);
  });

  it("clips long text on a word boundary", () => {
    const clipped = clip("one two three four five six", 14);
    assert.ok(clipped.length <= 14);
    assert.ok(clipped.endsWith("…"));
    assert.ok(!clipped.includes("  "));
  });

  it("exposes its source channel", () => {
    const slides = buildSkeleton(night().results, night().digest, ROSTER);
    assert.equal(_sourceOf(slides[0] as FinaleSlide)?.claimId, undefined);
    const ship = slides.find((slide) => slide.claimId === "c-ship");
    assert.ok(ship);
    assert.deepEqual(sourceOf(ship)?.subjects, ["Player 2", "Player 5"]);
  });
});
