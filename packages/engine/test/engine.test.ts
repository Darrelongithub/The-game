// packages/engine/test/engine.test.ts
// The verdicts and the secret cards.
//
// The rules under test:
//   • Every verdict is backed by data. Weak data → no verdict.
//   • Only the allowed verdict kinds ever appear.
//   • A crush card exists ONLY for a mutual pick — and only for the two
//     people who picked each other.
//   • No verdict or card ever prints an orientation claim.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSecrets,
  computeResults,
  lookChains,
  mutualCrushes,
  assertNoOrientationLeak,
} from "../src/index.ts";
import type { VerdictKind } from "../../shared/src/contracts.ts";
import { ids, meta, peerRate, pick, selfRate, text, vote, pairPick, look, lookGuess, lookWhy } from "./fixtures.ts";

const ALLOWED: VerdictKind[] = [
  "hates", "core", "couple", "sex", "percent", "gaycouple",
  "bodycount", "bestinbed", "besties", "rivals", "freeagent", "blindspot",
];

describe("computeResults", () => {
  it("returns nothing when the night had no answers", () => {
    const results = computeResults([], meta);
    assert.equal(results.verdicts.length, 0);
    assertNoOrientationLeak(results);
  });

  it("only ever emits the allowed verdict kinds", () => {
    const log = [
      ...ids.map((id) => pick(id, "p1", "would-cheat", "friction")),
      pick("p2", "p1", "sex-desire", "couple"),
      pick("p1", "p2", "sex-desire", "couple"),
      pick("p3", "p4", "closest", "friendship"),
      pick("p4", "p3", "closest", "friendship"),
      vote("p3", "p1", "p2", 5, "couple-fit"),
      vote("p4", "p1", "p2", 5, "couple-fit"),
    ];
    const results = computeResults(log, meta);
    for (const verdict of results.verdicts) {
      assert.ok(ALLOWED.includes(verdict.kind), `unexpected verdict kind ${verdict.kind}`);
      assert.ok(verdict.text.length > 0, "a verdict must have text");
      assert.ok(Object.keys(verdict.numbers).length > 0, "a verdict must carry its numbers");
    }
  });

  it("builds a mutual-sex verdict only when both picked each other", () => {
    const log = [pick("p1", "p2", "sex-desire"), pick("p2", "p1", "sex-desire")];
    const results = computeResults(log, meta);
    const sex = results.verdicts.find((v) => v.kind === "sex");
    assert.ok(sex, "a mutual sex-desire pair should produce a sex verdict");
    assert.deepEqual([...sex!.subjects].sort(), ["p1", "p2"]);
  });

  it("does NOT build a sex verdict from a one-sided pick", () => {
    const log = [pick("p1", "p2", "sex-desire")];
    const results = computeResults(log, meta);
    assert.equal(results.verdicts.find((v) => v.kind === "sex"), undefined);
  });

  it("reports a ship verdict with the percentage of yes votes", () => {
    const log = [
      vote("p3", "p1", "p2", 5, "couple-fit"),
      vote("p4", "p1", "p2", 5, "couple-fit"),
      vote("p5", "p1", "p2", 1, "couple-fit"),
    ];
    const results = computeResults(log, meta);
    const couple = results.verdicts.find((v) => v.kind === "couple");
    assert.ok(couple, "a clear yes majority should produce a couple verdict");
    assert.equal(couple!.numbers.yes, 2);
    assert.equal(couple!.numbers.voters, 3);
    assert.match(couple!.text, /67%/);
  });

  it("does not ship a pair the room said no to", () => {
    const log = [
      vote("p3", "p1", "p2", 1, "couple-fit"),
      vote("p4", "p1", "p2", 1, "couple-fit"),
      vote("p5", "p1", "p2", 2, "couple-fit"),
    ];
    const results = computeResults(log, meta);
    assert.equal(results.verdicts.find((v) => v.kind === "couple"), undefined);
  });

  it("computes percent lines from OTHER players only", () => {
    // Three of the four other players pick p2 for sex.
    const log = [
      pick("p1", "p2", "sex-desire"),
      pick("p3", "p2", "sex-desire"),
      pick("p4", "p2", "sex-desire"),
    ];
    const results = computeResults(log, meta);
    const percent = results.verdicts.find((v) => v.kind === "percent" && v.subjects.includes("p2"));
    assert.ok(percent, "a spicy percent line should exist");
    // 5 players → 4 others → 3/4 = 75%
    assert.equal(percent!.numbers.voters, 3);
    assert.equal(percent!.numbers.eligible, 4);
    assert.match(percent!.text, /75%/);
  });

  it("produces a gay-hypothetical couple line without ever claiming anyone is gay", () => {
    const log = [
      vote("p1", "p3", "p4", 5, "gay-hypothetical"),
      vote("p2", "p3", "p4", 5, "gay-hypothetical"),
      vote("p5", "p3", "p4", 4, "gay-hypothetical"),
    ];
    const results = computeResults(log, meta);
    const gay = results.verdicts.find((v) => v.kind === "gaycouple");
    assert.ok(gay, "a gay-hypothetical verdict should exist");
    assert.match(gay!.text, /If .* were gay/);
    assert.doesNotMatch(gay!.text, /\bis gay\b/i);
    assertNoOrientationLeak(results);
  });

  it("finds a blind spot from a self-rating that disagrees with the room", () => {
    const log = [
      selfRate("p1", "loyalty", 9),
      peerRate("p2", "p1", "loyalty", 4),
      peerRate("p3", "p1", "loyalty", 5),
    ];
    const results = computeResults(log, meta);
    const blind = results.verdicts.find((v) => v.kind === "blindspot");
    assert.ok(blind, "a self-rating gap should produce a blind spot");
    assert.match(blind!.text, /loyal/);
    assert.equal(blind!.numbers.self, 9);
    assert.equal(blind!.numbers.raters, 2);
  });

  it("does not invent a blind spot when the room agrees", () => {
    const log = [
      selfRate("p1", "loyalty", 8),
      peerRate("p2", "p1", "loyalty", 8),
      peerRate("p3", "p1", "loyalty", 8),
    ];
    const results = computeResults(log, meta);
    assert.equal(results.verdicts.find((v) => v.kind === "blindspot"), undefined);
  });

  it("picks a free agent only when nobody claimed anyone", () => {
    // Three of the five players answer, and between them they claim p2, p3
    // and p4 — nobody claimed p5.
    const log = [
      pick("p1", "p2", "sex-desire"),
      pick("p1", "p3", "crush"),
      pick("p2", "p4", "crush"),
      pick("p3", "p2", "crush"),
    ];
    const results = computeResults(log, meta);
    const free = results.verdicts.find((v) => v.kind === "freeagent");
    assert.ok(free, "someone nobody picked should be a free agent");
    assert.ok(!["p2", "p3", "p4"].includes(free!.subjects[0]!));
  });

  it("does not name a free agent when barely anyone answered", () => {
    const log = [pick("p1", "p2", "crush")];
    const results = computeResults(log, meta);
    assert.equal(results.verdicts.find((v) => v.kind === "freeagent"), undefined);
  });

  it("picks the body-count champion from the room's picks", () => {
    const log = [
      pick("p1", "p3", "body-count"),
      pick("p2", "p3", "body-count"),
      pick("p4", "p3", "body-count"),
    ];
    const results = computeResults(log, meta);
    const body = results.verdicts.find((v) => v.kind === "bodycount");
    assert.ok(body);
    assert.deepEqual(body!.subjects, ["p3"]);
  });

  it("never prints a gay claim, whatever the log says", () => {
    const log = [
      ...ids.map((id) => pick(id, "p1", "gay-hypothetical")),
      vote("p2", "p1", "p3", 5, "gay-hypothetical"),
    ];
    const results = computeResults(log, meta);
    assertNoOrientationLeak(results);
    for (const verdict of results.verdicts) {
      assert.doesNotMatch(verdict.text, /\bis gay\b/i);
      assert.doesNotMatch(verdict.text, /\b(is|are) (straight|bi|gay|lesbian)\b/i);
    }
  });
});

describe("mutualCrushes", () => {
  it("returns only pairs where BOTH picked the other", () => {
    const log = [pick("p1", "p2", "crush"), pick("p2", "p1", "crush"), pick("p3", "p4", "crush")];
    const crushes = mutualCrushes(log);
    assert.equal(crushes.length, 1);
    assert.deepEqual([crushes[0]!.a, crushes[0]!.b].sort(), ["p1", "p2"]);
  });

  it("returns nothing for a one-sided crush", () => {
    const log = [pick("p1", "p2", "crush")];
    assert.equal(mutualCrushes(log).length, 0);
  });
});

describe("buildSecrets", () => {
  it("gives a mutual crush card to EXACTLY the two people who picked each other", () => {
    const log = [pick("p1", "p2", "crush"), pick("p2", "p1", "crush")];
    const results = computeResults(log, meta);
    const decks = buildSecrets(results, log, meta);

    assert.deepEqual([...decks.keys()].sort(), ["p1", "p2"]);
    const card = decks.get("p1")![0]!;
    assert.equal(card.kind, "crush");
    assert.match(card.facts.join(" "), /You and Player 2 like each other\./);
  });

  it("gives NO card for a one-sided crush — to anyone", () => {
    const log = [pick("p1", "p2", "crush")];
    const results = computeResults(log, meta);
    const decks = buildSecrets(results, log, meta);
    assert.equal(decks.size, 0, "a one-sided crush must never become a card");
  });

  it("gives no card at all when there is no data", () => {
    const results = computeResults([], meta);
    const decks = buildSecrets(results, [], meta);
    assert.equal(decks.size, 0);
  });

  it("makes a blind spot card from a self-rating gap", () => {
    const log = [
      selfRate("p1", "honesty", 10),
      peerRate("p2", "p1", "honesty", 2),
      peerRate("p3", "p1", "honesty", 3),
    ];
    const results = computeResults(log, meta);
    const decks = buildSecrets(results, log, meta);
    const card = decks.get("p1")?.[0];
    assert.ok(card);
    assert.equal(card!.kind, "blindspot");
  });

  it("never puts a verdict-derived card in a deck", () => {
    const log = [
      ...["p2", "p3", "p4", "p5"].map((id) => pick(id as never, "p1", "would-cheat", "friction")),
    ];
    const results = computeResults(log, meta);
    const decks = buildSecrets(results, log, meta);
    for (const cards of decks.values()) {
      for (const card of cards) {
        assert.ok(["crush", "blindspot", "lookchain"].includes(card.kind));
      }
    }
  });
});

describe("the digest", () => {
  it("reads a look chain back: the choice, the guesses and the reason", () => {
    const log = [
      look("p1", "p3", "chain-1"),
      lookGuess("p2", "p3", "chain-1"),
      lookGuess("p3", "p3", "chain-1"),
      lookGuess("p4", "p5", "chain-1"),
      lookWhy("p1", "Because we share a secret.", "chain-1"),
    ];
    const chains = lookChains(log);
    assert.equal(chains.length, 1, "one chain");
    const chain = chains[0]!;
    assert.equal(chain.actor, "p1");
    assert.equal(chain.target, "p3");
    assert.equal(chain.guessers, 3, "three people guessed");
    assert.equal(chain.guessedRight, 2, "two of them were right");
    assert.equal(chain.reason, "Because we share a secret.");
  });

  it("keeps two chains by the same actor apart", () => {
    const log = [
      look("p1", "p3", "chain-1"),
      lookGuess("p2", "p3", "chain-1"),
      lookWhy("p1", "The first one.", "chain-1"),
      look("p1", "p4", "chain-2"),
      lookGuess("p2", "p3", "chain-2"),
      lookGuess("p3", "p4", "chain-2"),
      lookWhy("p1", "The second one.", "chain-2"),
    ];
    const chains = lookChains(log);
    assert.equal(chains.length, 2, "two chains");
    const first = chains.find((c) => c.roundId === "chain-1")!;
    const second = chains.find((c) => c.roundId === "chain-2")!;
    assert.equal(first.target, "p3");
    assert.equal(first.guessers, 1, "the first chain has one guesser");
    assert.equal(first.reason, "The first one.");
    assert.equal(second.target, "p4");
    assert.equal(second.guessers, 2, "the second chain has two guessers");
    assert.equal(second.reason, "The second one.");
  });

  it("gives the actor their own look chain card and nobody else", () => {
    const log = [
      look("p1", "p3", "chain-1"),
      lookGuess("p2", "p3", "chain-1"),
      lookGuess("p3", "p3", "chain-1"),
      lookWhy("p1", "Because we share a secret.", "chain-1"),
    ];
    const decks = buildSecrets(computeResults(log, meta), log, meta);
    const actorDeck = decks.get("p1") ?? [];
    const card = actorDeck.find((c) => c.kind === "lookchain");
    assert.ok(card, "the actor gets a look chain card");
    assert.match(card!.facts.join(" "), /looked at/i);
    assert.match(card!.facts.join(" "), /2 of 2 guessed right/i);
    // Nobody else is told who X was looking at.
    assert.equal(decks.get("p2"), undefined, "a guesser gets nothing");
    assert.equal(decks.get("p3"), undefined, "the target gets nothing");
  });

  it("quotes verbatim and never invents", async () => {
    const { buildNightDigest } = await import("../src/index.ts");
    const log = [text("p1", "I once kissed two people at the same party last night")];
    const digest = buildNightDigest(log, meta);
    assert.equal(digest.quotes.length, 1);
    assert.equal(digest.quotes[0]!.text, "I once kissed two people at the same party last night");
    assert.equal(digest.quotes[0]!.alias, "Wanjiru");
  });
});
