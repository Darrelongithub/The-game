// R27 — a spark is an announcement, not just a mutual pick. It must clear the
// existing high-confidence bar: >=3 independent measured signal types.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Results } from "../../shared/src/contracts.ts";
import { buildNightDigest, buildSecrets, computeResults, computeSignals } from "../src/index.ts";
import { LogBuilder, RANDOM_META, goldenLog1, meta5, randomLog } from "./fixtures.ts";

const sparkClaims = (results: Results) => results.claims.filter((c) => c.type === "spark");
const sparkCards = (results: Results, log: ReturnType<typeof goldenLog1>, meta: ReturnType<typeof meta5>) => {
  const decks = buildSecrets(results, buildNightDigest(log, meta), meta);
  return [...decks.values()].flatMap((cards) => cards).filter((card) => card.kind === "spark");
};

test("R27: seeded uniform-noise rooms never announce a spark", () => {
  // These seeds produced med-confidence spark cards before the gate.
  for (const seed of [22, 45, 50, 112]) {
    const log = randomLog(seed);
    const results = computeResults(computeSignals(log, RANDOM_META), log, RANDOM_META);
    assert.deepEqual(sparkClaims(results).map((c) => c.id), [], `seed ${seed} produced a spark claim`);
    assert.deepEqual(sparkCards(results, log, RANDOM_META).map((c) => c.id), [], `seed ${seed} announced a spark`);
  }
});

test("R27: two independent supports are measured, but are not enough to announce a spark", () => {
  const meta = { ...meta5("room-two-supports"), players: meta5("room-two-supports").players.slice(0, 4), revealOptIn: ["p1", "p2", "p3", "p4"] };
  const b = new LogBuilder(meta.roomId);
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p1"], ["p3", "p4"], ["p4", "p3"]]);
  b.pickRound("C2", "couple", [["p1", "p2"], ["p2", "p1"], ["p3", "p4"], ["p4", "p3"]]);
  b.ios("IOS1", "p1", "p2", 7).ios("IOS1", "p2", "p1", 7);
  const signals = computeSignals(b.log, meta);
  const pair = signals.find((s) => s.a === "p1" && s.b === "p2")!;
  assert.deepEqual([...pair.componentsUsed].sort(), ["iosMean", "mutualPick"]);
  assert.equal(pair.coupleEvidence, 1);
  assert.equal(pair.iosMean, 1);
  const results = computeResults(signals, b.log, meta);
  assert.deepEqual(sparkClaims(results), [], "mutual picks + IOS alone must not create a spark claim");
  assert.deepEqual(sparkCards(results, b.log, meta), [], "mutual picks + IOS alone must not announce a spark");
});

test("R27: the scripted mutual room still sparks on exactly the two holders' phones", () => {
  const log = goldenLog1();
  const meta = meta5("room-g1");
  const results = computeResults(computeSignals(log, meta), log, meta);
  const sparks = sparkClaims(results);
  assert.deepEqual(sparks.map((c) => ({ id: c.id, confidence: c.confidence, audience: c.audience })), [
    { id: "spark-p1-p2", confidence: "high", audience: "private" },
  ]);
  const pair = results.pairScores.find((s) => s.a === "p1" && s.b === "p2")!;
  assert.ok(pair.componentsUsed.length >= 3, "the mutual fixture keeps at least three independent measured supports");
  const decks = buildSecrets(results, buildNightDigest(log, meta), meta);
  assert.deepEqual([...decks.entries()].filter(([, cards]) => cards.some((c) => c.kind === "spark")).map(([id]) => id).sort(), ["p1", "p2"]);
});

test("R27: secret-card emission also refuses a downgraded spark claim", () => {
  const log = goldenLog1();
  const meta = meta5("room-g1");
  const results = computeResults(computeSignals(log, meta), log, meta);
  const downgraded: Results = {
    ...results,
    claims: results.claims.map((c) => c.type === "spark" ? { ...c, confidence: "med" as const } : c),
  };
  assert.deepEqual(sparkCards(downgraded, log, meta), [], "a med-confidence spark claim is never announced");
});

test("R27: the gate does not change deterministic replay", () => {
  for (const [log, meta] of [[randomLog(22), RANDOM_META], [goldenLog1(), meta5("room-g1")]] as const) {
    const signals = computeSignals(log, meta);
    const first = computeResults(signals, log, meta);
    const second = computeResults(computeSignals(log, meta), log, meta);
    assert.deepEqual(first, second);
    assert.deepEqual(buildSecrets(first, buildNightDigest(log, meta), meta), buildSecrets(second, buildNightDigest(log, meta), meta));
  }
});
