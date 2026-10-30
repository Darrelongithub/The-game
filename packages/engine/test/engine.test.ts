// packages/engine/test/engine.test.ts
// Golden fixtures (hand-computed) + the false-positive suite (a)–(j).
// Run: npm --prefix packages/engine test
import assert from "node:assert/strict";
import { test } from "node:test";
import { SECRET_DECK_MAX, type Claim, type PairSignal } from "../../shared/src/contracts.ts";
import {
  buildNightDigest,
  buildSecrets,
  computeResults,
  computeSignals,
  constrainedMatching,
  maximumWeightMatching,
  mulberry32,
  pairScoreOf,
} from "../src/index.ts";
import { RANDOM_META, digestLog, goldenLog1, goldenLog2, jokerLog, meta5, randomLog } from "./fixtures.ts";

const approx = (actual: number, expected: number, label: string): void => {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);
};

const signal = (signals: PairSignal[], a: string, b: string): PairSignal => {
  const s = signals.find((x) => x.a === a && x.b === b);
  assert.ok(s, `missing signal ${a}-${b}`);
  return s;
};

const claimSummary = (claims: Claim[]) =>
  claims.map((c) => ({ id: c.id, type: c.type, subjects: c.subjects, audience: c.audience, confidence: c.confidence }));

// ---------------------------------------------------------------------------
// Golden fixture 1 — signals, hand-computed.
// p1–p2: overlap rounds where neither picked the other are F1 (p3,p3 ✓),
// F2 (p3,p4 ✗), N1 (p3,p3 ✓) → 2/3. Positive picks: p1 hit p2 twice of 4,
// p2 hit p1 twice of 4 → pooled mutualPick 4/8 = 0.5, couple 4/4 = 1,
// friend 0/4 = 0. Debrief Jaccard 4/6. IOS (6+7)/14. Trait agreement:
// dir(p1) = mean(1−|8−7|/9, 1−|6−8|/9) = 0.8333…, dir(p2) = 1 → 0.9166….
// pairScore = .30(2/3)+.20(.5)+.20(4/6)+.15(13/14)+.15(11/12) = 0.710119…
// ---------------------------------------------------------------------------
test("golden 1: pair components are hand-computable", () => {
  const signals = computeSignals(goldenLog1(), meta5("room-g1"));
  assert.equal(signals.length, 10); // C(5,2)
  assert.ok(signals.every((s) => s.a < s.b && s.room === "room-g1"));

  const s12 = signal(signals, "p1", "p2");
  approx(s12.pickOverlap, 2 / 3, "p1p2 overlap");
  approx(s12.mutualPick, 0.5, "p1p2 mutualPick");
  approx(s12.coupleEvidence, 1, "p1p2 coupleEvidence");
  approx(s12.friendEvidence, 0, "p1p2 friendEvidence");
  approx(s12.debriefSim, 4 / 6, "p1p2 debriefSim");
  approx(s12.iosMean, 13 / 14, "p1p2 iosMean");
  approx(s12.traitAgreement, 11 / 12, "p1p2 traitAgreement");
  approx(s12.pairScore, 0.3 * (2 / 3) + 0.2 * 0.5 + 0.2 * (4 / 6) + 0.15 * (13 / 14) + 0.15 * (11 / 12), "p1p2 pairScore");

  // p3–p4: eligible overlap rounds C2 (p1,p1 ✓), N1 (p5,p5 ✓) → 1.
  // Positive pooled hits (3+2)/8 = 0.625; couple (1+0)/4; friend (2+2)/4 = 1.
  // IOS (5+5)/14. Trait: dir(p3)=mean(1−3/9, 1−1/9)=7/9, dir(p4)=1 → 8/9.
  const s34 = signal(signals, "p3", "p4");
  approx(s34.pickOverlap, 1, "p3p4 overlap");
  approx(s34.mutualPick, 5 / 8, "p3p4 mutualPick");
  approx(s34.coupleEvidence, 1 / 4, "p3p4 coupleEvidence");
  approx(s34.friendEvidence, 1, "p3p4 friendEvidence");
  assert.equal(s34.componentsUsed.includes("debriefSim"), false, "missing debrief is not measured");
  approx(s34.iosMean, 10 / 14, "p3p4 iosMean");
  approx(s34.traitAgreement, 8 / 9, "p3p4 traitAgreement");
  approx(s34.pairScore, pairScoreOf(s34), "p3p4 renormalized pairScore");
  approx(s34.pairScore, (0.3 + 0.2 * (5 / 8) + 0.15 * (10 / 14) + 0.15 * (8 / 9)) / 0.8, "p3p4 excludes missing debrief weight");

  // p1–p5: eligible overlap rounds F1 (p3,p4 ✗), N1 (p3,p3 ✓) → 1/2.
  // Positive pooled: p5 hit p1 3 times, p1 never hit p5 → 3/8. No IOS → 0.
  const s15 = signal(signals, "p1", "p5");
  approx(s15.pickOverlap, 0.5, "p1p5 overlap");
  approx(s15.mutualPick, 3 / 8, "p1p5 mutualPick");
  approx(s15.iosMean, 0, "p1p5 iosMean");
  for (const s of signals) {
    for (const v of [s.pickOverlap, s.mutualPick, s.debriefSim, s.iosMean, s.traitAgreement, s.pairScore, s.coupleEvidence, s.friendEvidence, s.negativeMutual]) {
      assert.ok(v >= 0 && v <= 1, `component out of range: ${v}`);
    }
  }
});

test("golden 1: exact claim set, free agent, and claim numbers", () => {
  const log = goldenLog1();
  const meta = meta5("room-g1");
  const results = computeResults(computeSignals(log, meta), log, meta);
  assert.deepEqual(claimSummary(results.claims), [
    { id: "ship-p1-p2", type: "ship", subjects: ["p1", "p2"], audience: "public", confidence: "high" },
    { id: "ship-p3-p4", type: "ship", subjects: ["p3", "p4"], audience: "public", confidence: "high" },
    { id: "besties-p1-p5", type: "besties", subjects: ["p1", "p5"], audience: "public", confidence: "low" }, // overlap exactly 1/2 does not count; trait agreement only
    { id: "besties-p3-p4", type: "besties", subjects: ["p3", "p4"], audience: "public", confidence: "high" },
    { id: "spark-p1-p2", type: "spark", subjects: ["p1", "p2"], audience: "private", confidence: "high" },
    { id: "consensus-C2-p1", type: "consensus", subjects: ["p1"], audience: "public", confidence: "med" }, // single verdict round = med
    { id: "blindspot-p3-loyalty", type: "blindspot", subjects: ["p3"], audience: "public", confidence: "high" },
    { id: "onesided-p5-p1", type: "onesided", subjects: ["p5", "p1"], audience: "private", confidence: "low" }, // picks only, no IOS asymmetry
  ]);
  assert.equal(results.freeAgent, "p5");

  const consensus = results.claims.find((c) => c.type === "consensus");
  assert.deepEqual(consensus?.numbers, { votes: 4, of: 5, share: 0.8 }); // real fraction, always
  const blind = results.claims.find((c) => c.type === "blindspot");
  assert.equal(blind?.numbers?.self, 5);
  approx(blind?.numbers?.groupMean ?? NaN, 8.25, "blindspot groupMean"); // (8+9+8+8)/4
  assert.equal(blind?.numbers?.spread, 1); // max−min of {8,9,8,8}
  const onesided = results.claims.find((c) => c.type === "onesided");
  assert.deepEqual(onesided?.numbers, { rate: 0.75, reverseRate: 0, hits: 3, of: 4 });
  // Evidence uses pseudonyms only, never aliases.
  for (const c of results.claims) {
    for (const line of c.evidence) {
      assert.ok(!/(Ana|Ben|Cia|Dan|Eli)/.test(line), `alias leaked into evidence: ${line}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Golden fixture 2 — toxic by hand: p4 receives 4+4+2 friction + 2+1 rivalry
// = 13 raw negative picks of 25. Same-target shares per picker across all 8
// pick rounds peak at 5/8 (p3) → nobody is joker-guarded → weighted = 13.
// Rivals p1–p5: negative pooled 6/10 = 0.6, rivalry pooled 4/4 = 1,
// pairScore .30(.8)+.20(0)+.20(.5)+.15(8/14)+.15(1) = 0.5757… (mid-range).
// ---------------------------------------------------------------------------
test("golden 2: toxic percentile case, rivals, consensus — exact claim set", () => {
  const log = goldenLog2();
  const meta = meta5("room-g2");
  const signals = computeSignals(log, meta);
  const s15 = signal(signals, "p1", "p5");
  approx(s15.pickOverlap, 4 / 5, "rivals overlap");
  approx(s15.negativeMutual, 0.6, "rivals negativeMutual");
  approx(s15.pairScore, pairScoreOf(s15), "rivals renormalized pairScore");

  const results = computeResults(signals, log, meta);
  assert.deepEqual(claimSummary(results.claims), [
    { id: "ship-p1-p2", type: "ship", subjects: ["p1", "p2"], audience: "public", confidence: "high" },
    { id: "ship-p3-p5", type: "ship", subjects: ["p3", "p5"], audience: "public", confidence: "med" }, // mutualPick exactly 1/2 does not count
    { id: "besties-p1-p2", type: "besties", subjects: ["p1", "p2"], audience: "public", confidence: "med" }, // friendEvidence exactly 1/2 does not count
    { id: "besties-p3-p5", type: "besties", subjects: ["p3", "p5"], audience: "public", confidence: "med" },
    { id: "rival-p1-p5", type: "rival", subjects: ["p1", "p5"], audience: "public", confidence: "med" }, // both pick rates strong; ratings agree, so no 3rd type
    { id: "toxic-p4", type: "toxic", subjects: ["p4"], audience: "public", confidence: "high" },
    { id: "consensus-X1-p4", type: "consensus", subjects: ["p4"], audience: "public", confidence: "med" },
    { id: "consensus-X2-p4", type: "consensus", subjects: ["p4"], audience: "public", confidence: "med" },
  ]);
  assert.equal(results.freeAgent, "p4");
  const toxic = results.claims.find((c) => c.type === "toxic");
  assert.equal(toxic?.numbers?.votes, 13);
  assert.equal(toxic?.numbers?.of, 25);
  approx(toxic?.numbers?.share ?? NaN, 13 / 25, "toxic share");
  assert.equal(toxic?.numbers?.weightedVotes, 13); // no picker is joker-guarded here
  assert.ok((toxic?.numbers?.percentile ?? 0) >= 0.99, `percentile ${toxic?.numbers?.percentile}`);
  approx(toxic?.numbers?.score ?? NaN, 0.6 * (toxic?.numbers?.percentile ?? 0), "toxic score = .6*pct (tags 0)");
  const rival = results.claims.find((c) => c.type === "rival");
  approx(rival?.numbers?.rivalryRate ?? NaN, 1, "rivalry pooled rate");
  approx(rival?.numbers?.score ?? NaN, 1.6, "rival score 0.6 + 1.0");
});

test("toxic tag seam: tagOf contempt density feeds TOXIC_WEIGHTS", () => {
  const log = goldenLog2();
  const meta = meta5("room-g2");
  const signals = computeSignals(log, meta);
  const plain = computeResults(signals, log, meta);
  const tagged = computeResults(signals, log, meta, undefined, (recordId) =>
    recordId.includes(":p4:") ? ["contempt"] : [],
  );
  const plainScore = plain.claims.find((c) => c.type === "toxic")?.numbers?.score ?? 0;
  const taggedScore = tagged.claims.find((c) => c.type === "toxic")?.numbers?.score ?? 0;
  // p4 authored exactly one text → contempt density 1 → score += 0.4 * 1.
  approx(taggedScore - plainScore, 0.4, "contempt density contribution");
});

test("config weights re-weight pairScore (tuning replay)", () => {
  const log = goldenLog1();
  const meta = meta5("room-g1");
  const signals = computeSignals(log, meta);
  const iosOnly = computeResults(signals, log, meta, { pickOverlap: 0, mutualPick: 0, debriefSim: 0, iosMean: 1, traitAgreement: 0 });
  approx(signal(iosOnly.pairScores, "p1", "p2").pairScore, 13 / 14, "ios-only pairScore");
});

// ---------- (a) joker guard ----------
test("(a) everyone picks the same friend every round → NO high-confidence toxic claim", () => {
  const log = jokerLog();
  const meta = meta5("room-joker");
  const results = computeResults(computeSignals(log, meta), log, meta);
  assert.deepEqual(results.claims.filter((c) => c.type === "toxic"), []); // stronger: no toxic claim at all
});

// ---------- (b) uniform random room ----------
test("(b) uniform random rooms → zero high-confidence claims", () => {
  for (const seed of [7, 42, 1234]) {
    const log = randomLog(seed);
    const results = computeResults(computeSignals(log, RANDOM_META), log, RANDOM_META);
    const high = results.claims.filter((c) => c.confidence === "high");
    console.info(`[noise] seed=${seed} players=${RANDOM_META.players.length} claims=${results.claims.length} high=${high.length}`);
    assert.deepEqual(high.map((c) => c.id), [], `seed ${seed} produced high-confidence claims`);
  }
});

test("n=4 random-night consensus high-confidence false positives stay below 2%", () => {
  const meta4: typeof RANDOM_META = { ...RANDOM_META, roomId: "room-random-4", players: RANDOM_META.players.slice(0, 4), revealOptIn: [], profiles: {} };
  const nights = 500;
  let falsePositiveNights = 0;
  for (let seed = 1; seed <= nights; seed++) {
    const log = randomLog(seed, 4);
    const results = computeResults(computeSignals(log, meta4), log, meta4);
    if (results.claims.some(c => c.type === "consensus" && c.confidence === "high")) falsePositiveNights++;
  }
  console.info(`[noise] n=4 random consensus nights=${nights} false-high=${falsePositiveNights}`);
  assert.ok(falsePositiveNights / nights <= 0.02, `${falsePositiveNights}/${nights} random nights had a high-confidence consensus claim`);
});

test("profile-derived shared-intent notes stay private and require both reveal opt-ins", () => {
  const meta = { ...meta5("profile-intents"), profiles: {
    p1: { age: 29, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: true, tonight: "vibes" as const },
    p2: { age: 33, relationship: "committed" as const, partnersToDate: 4, longestMonths: 24, crushingHere: false, tonight: "vibes" as const },
    p3: { age: 30, relationship: "single" as const, partnersToDate: 0, longestMonths: 0, crushingHere: false, tonight: "chaos" as const },
    p4: { age: 34, relationship: "dating" as const, partnersToDate: 1, longestMonths: 4, crushingHere: false, tonight: "mission" as const },
    p5: { age: 31, relationship: "single" as const, partnersToDate: 3, longestMonths: 12, crushingHere: false, tonight: "feelings" as const },
  } };
  const results = computeResults([], [], meta);
  const decks = buildSecrets(results, buildNightDigest([], meta), meta);
  const a = decks.get("p1")?.find(c => c.id === "secret-profile-intent-p1-p2");
  const b = decks.get("p2")?.find(c => c.id === "secret-profile-intent-p2-p1");
  assert.ok(a && b, "both consenting players receive the matched-intent note");
  assert.ok(a.facts.join(" ").includes("not proof of compatibility"));
  assert.ok(!JSON.stringify([...decks.values()]).includes("crushingHere"));
  assert.ok(!JSON.stringify([...decks.values()]).includes("committed"));
  const oneOptOut = { ...meta, revealOptIn: ["p1", "p3"] };
  const privateOnly = buildSecrets(computeResults([], [], oneOptOut), buildNightDigest([], oneOptOut), oneOptOut);
  assert.ok(![...privateOnly.values()].flat().some(c => c.id.includes("profile-intent-p1-p2")));
});

// ---------- (c) player-count bounds ----------
test("(c) n=4 works, n<4 throws", () => {
  const meta4: typeof RANDOM_META = {
    roomId: "room-4",
    players: RANDOM_META.players.slice(0, 4),
    revealOptIn: [],
    profiles: {},
  };
  const signals = computeSignals([], meta4);
  assert.equal(signals.length, 6);
  const results = computeResults(signals, [], meta4);
  assert.deepEqual(results.claims, []); // no data → no claims (debrief "unknown" alone is not evidence)
  assert.equal(results.freeAgent, undefined);
  const meta3 = { ...meta4, players: meta4.players.slice(0, 3) };
  assert.throws(() => computeSignals([], meta3), /at least 4 players/);
  assert.throws(() => computeResults([], [], meta3), /at least 4 players/);
});

// ---------- (d) exactly one free agent at n=5 ----------
test("(d) n=5 → exactly one freeAgent (ship matching)", () => {
  const log = goldenLog1();
  const meta = meta5("room-g1");
  const results = computeResults(computeSignals(log, meta), log, meta);
  assert.equal(results.freeAgent, "p5");
  const shipPairs = results.claims.filter((c) => c.type === "ship").flatMap((c) => c.subjects);
  assert.equal(new Set(shipPairs).size, 4);
  assert.ok(!shipPairs.includes("p5"));
});

// ---------- (e) matching optimality ----------
test("(e) matching beats 10,000 random matchings on total weight", () => {
  const log = goldenLog1();
  const meta = meta5("room-g1");
  const signals = computeSignals(log, meta);
  const weight = new Map(signals.map((s) => [`${s.a}|${s.b}`, s.pairScore]));
  const w = (a: string, b: string): number => weight.get(a < b ? `${a}|${b}` : `${b}|${a}`) ?? 0;
  const ids = meta.players.map((p) => p.id);
  const optimal = maximumWeightMatching(ids, w);
  const alsoShip = constrainedMatching(ids, w, (a, b) => {
    const s = signals.find((x) => x.a === (a < b ? a : b) && x.b === (a < b ? b : a));
    return (s?.coupleEvidence ?? 0) > 0 || (s?.friendEvidence ?? 0) > 0;
  });
  approx(alsoShip.totalWeight, optimal.totalWeight, "constrained ship reaches the unconstrained optimum here");

  const rng = mulberry32(99);
  let bestRandom = 0;
  for (let i = 0; i < 10_000; i++) {
    const shuffled = [...ids];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(rng() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k] as string, shuffled[j] as string];
    }
    let total = 0;
    for (let j = 0; j + 1 < shuffled.length; j += 2) total += w(shuffled[j] as string, shuffled[j + 1] as string);
    if (total > bestRandom) bestRandom = total;
  }
  assert.ok(optimal.totalWeight >= bestRandom - 1e-9, `optimal ${optimal.totalWeight} < random ${bestRandom}`);
});

// ---------- (f)(g)(h) determinism ----------
test("(f)(g)(h) same log twice → deep-equal results, digest, and secrets", () => {
  const log = goldenLog2(); // includes the Monte-Carlo path
  const meta = meta5("room-g2");
  const r1 = computeResults(computeSignals(log, meta), log, meta);
  const r2 = computeResults(computeSignals(log, meta), log, meta);
  assert.deepEqual(r1, r2);
  const d1 = buildNightDigest(log, meta);
  assert.deepEqual(d1, buildNightDigest(log, meta));
  assert.deepEqual([...buildSecrets(r1, d1, meta).entries()], [...buildSecrets(r2, d1, meta).entries()]);
});

// ---------- digest golden ----------
test("digest: quotes filtered/deduped/ranked, dodges verbatim, gags, stats, teasers", () => {
  const digest = buildNightDigest(digestLog(), meta5("room-digest"));
  assert.deepEqual(digest.quotes.map((q) => q.alias), ["Ben", "Ana", "Ana"]); // ranked by word count (9, 8, 8→longer first)
  assert.equal(digest.quotes[0]?.text, "nobody here can keep a secret past midnight honestly");
  assert.ok(digest.quotes.every((q) => q.text.length >= 20 && q.text.length <= 160));
  assert.ok(!digest.quotes.some((q) => q.text.includes("finances")), "debrief text must never be quoted");
  assert.deepEqual(digest.dodges, [
    { alias: "Ben", reason: "absolutely not in these shoes" },
    { alias: "Ben", reason: "my mother follows this account" },
  ]);
  assert.deepEqual(digest.runningGags, [{ word: "chaos", count: 3 }]);
  assert.deepEqual(digest.stats.topDodger, { alias: "Ben", count: 2 });
  assert.deepEqual(digest.stats.tapWar, { alias: "Cia", score: 55 });
  assert.deepEqual(digest.stats.fastest, { alias: "Dan", ms: 250 });
  assert.deepEqual(digest.stats.slowest, { alias: "Ana", ms: 89000 });
  assert.deepEqual(digest.pickTeasers, [
    "The room has cast 5 picks so far.",
    "One player has quietly collected 3 of those picks.",
    "In 1 round, at least half the room pointed at the same person.",
  ]);
  const gap = digest.selfVsRoom.find((e) => e.alias === "Ana" && e.trait === "chaos");
  assert.deepEqual(gap, { alias: "Ana", trait: "chaos", self: 9, roomMean: 5 });
  assert.deepEqual(buildNightDigest([], meta5("room-digest")), {
    quotes: [], stats: {}, runningGags: [], pickTeasers: [], dodges: [], selfVsRoom: [],
  });
});

// ---------- secrets + (i)(j) ----------
test("secrets: spark on exactly two phones, one-sided on the picker's only, decks capped + ordered", () => {
  const log = goldenLog1();
  const meta = meta5("room-g1");
  const results = computeResults(computeSignals(log, meta), log, meta);
  const decks = buildSecrets(results, buildNightDigest(log, meta), meta);

  const sparkHolders: string[] = [];
  const allIds: string[] = [];
  const kindRank = (k: string): number => ["spark", "onesided", "blindspot", "roomnote", "stat"].indexOf(k);
  for (const [player, cards] of decks) {
    assert.ok(cards.length <= SECRET_DECK_MAX, `(i) deck cap for ${player}`); // (i)
    assert.deepEqual(cards.map((c) => kindRank(c.kind)), [...cards.map((c) => kindRank(c.kind))].sort((x, y) => x - y));
    for (const c of cards) {
      allIds.push(c.id);
      assert.ok(c.facts.length >= 1 && c.facts.length <= 4);
      for (const f of c.facts) assert.ok(f.length <= 120, `fact too long: ${f}`);
      if (c.kind === "spark") sparkHolders.push(player);
    }
  }
  // (j) no card id appears on more than one phone; the spark PAIR appears on exactly two.
  assert.equal(new Set(allIds).size, allIds.length);
  assert.deepEqual(sparkHolders.sort(), ["p1", "p2"]);
  assert.ok(decks.get("p1")?.find((c) => c.kind === "spark")?.facts.join(" ").includes("Player 2"));
  assert.ok(decks.get("p2")?.find((c) => c.kind === "spark")?.facts.join(" ").includes("Player 1"));

  // One-sided: picker p5 gets the card; target p1 does not.
  assert.ok(!(decks.get("p5") ?? []).some((c) => c.kind === "onesided" && results.claims.find(claim => claim.type === "onesided" && claim.subjects[0] === "p5")?.confidence === "low"), "low-confidence secret claims are suppressed");
  assert.ok(!(decks.get("p1") ?? []).some((c) => c.kind === "onesided"));

  // Blind spot: only p3 has a gap ≥ 1 in this fixture (loyalty 5 vs 8.25).
  const blindHolders = [...decks.entries()].filter(([, cs]) => cs.some((c) => c.kind === "blindspot")).map(([p]) => p);
  assert.deepEqual(blindHolders, ["p3"]);
  assert.match(decks.get("p3")?.find((c) => c.kind === "blindspot")?.facts[0] ?? "", /loyalty 5 out of 10; the room averaged 8\.3/);

  // Stat: p2 dodged with a verbatim reason in this fixture.
  const stat = decks.get("p2")?.find((c) => c.kind === "stat");
  assert.ok(stat?.facts.some((f) => f.includes("my shoes are cursed honestly")));
});

test("secrets consent gates: spark needs both opt-ins; one-sided needs the picker's", () => {
  const log = goldenLog1();
  const noP2 = meta5("room-g1", ["p1", "p3", "p4", "p5"]);
  const rNoP2 = computeResults(computeSignals(log, noP2), log, noP2);
  assert.deepEqual(rNoP2.claims.filter((c) => c.type === "spark"), []); // p2 not opted in → no spark claim
  const decksNoP2 = buildSecrets(rNoP2, buildNightDigest(log, noP2), noP2);
  assert.ok(![...decksNoP2.values()].flat().some((c) => c.kind === "spark"));

  const noP5 = meta5("room-g1", ["p1", "p2", "p3", "p4"]);
  const rNoP5 = computeResults(computeSignals(log, noP5), log, noP5);
  assert.ok(rNoP5.claims.some((c) => c.type === "onesided")); // private claim exists as engine truth…
  const decksNoP5 = buildSecrets(rNoP5, buildNightDigest(log, noP5), noP5);
  assert.ok(!(decksNoP5.get("p5") ?? []).some((c) => c.kind === "onesided")); // …but no card without consent
});

test("private material never becomes public: spark + onesided audiences across fixtures", () => {
  for (const [log, meta] of [
    [goldenLog1(), meta5("room-g1")],
    [goldenLog2(), meta5("room-g2")],
    [jokerLog(), meta5("room-joker")],
    [randomLog(42), RANDOM_META],
  ] as const) {
    const results = computeResults(computeSignals(log, meta), log, meta);
    for (const c of results.claims) {
      if (c.type === "spark" || c.type === "onesided") assert.equal(c.audience, "private");
      if ((c.type === "toxic" || c.type === "rival") && c.confidence === "low") {
        assert.fail(`low-confidence negative claim emitted: ${c.id}`);
      }
    }
  }
});


test("a single mutual couple pick is noise and cannot produce a spark card", () => {
  const meta = meta5("one-mutual");
  const log = (["p1", "p2"] as const).map((playerId, i) => ({ roomId: "one-mutual", roundId: "only", playerId, roundKind: "pick" as const, promptId: "only", coding: "couple" as const, value: { kind: "pick" as const, target: i === 0 ? "p2" : "p1" }, at: i, latencyMs: 10 }));
  const results = computeResults(computeSignals(log, meta), log, meta);
  assert.equal(results.claims.some(c => c.type === "spark"), false);
});

test("tease-coded picks never contribute to toxic indegree", () => {
  const meta = meta5("tease-heavy");
  const log = Array.from({ length: 5 }, (_, round) => meta.players.filter((p, i) => i !== round % 5).map((p, j) => ({
    roomId: "tease-heavy", roundId: `tease-${round}`, playerId: p.id, roundKind: "pick" as const,
    promptId: `tease-${round}`, coding: "tease" as const,
    value: { kind: "pick" as const, target: meta.players[(round + j + 1) % 5]!.id }, at: round * 10 + j, latencyMs: 10,
  }))).flat();
  const claims = computeResults(computeSignals(log, meta), log, meta).claims;
  assert.equal(claims.some(c => c.type === "toxic"), false);
});


test("pairScore renormalizes only measured components and thin evidence is not high confidence", () => {
  const onlyPick = { pickOverlap: 1, mutualPick: 0, debriefSim: 0, iosMean: 0, traitAgreement: 0, componentsUsed: ["pickOverlap"] as PairSignal["componentsUsed"] };
  assert.equal(pairScoreOf(onlyPick), 1, "a measured picks-only pair can score 1 for matching");
  const log: import("../../shared/src/contracts.ts").LogRecord[] = [];
  const meta = meta5("thin");
  const signals: PairSignal[] = [{room:"thin",a:"p1",b:"p2",...onlyPick,pairScore:1,coupleEvidence:0,friendEvidence:0,negativeMutual:0}];
  const results = computeResults(signals, log, meta);
  assert.ok(results.claims.every(c => c.confidence !== "high"), "thin components cannot generate high-confidence claims");
  const coupleLog = (["p1", "p2"] as const).map((playerId, i) => ({ roomId: "thin", roundId: `mutual-${i}`, playerId, roundKind: "pick" as const, promptId: `mutual-${i}`, coding: "couple" as const, value: { kind: "pick" as const, target: i === 0 ? "p2" : "p1" }, at: i, latencyMs: 10 }));
  const measuredPickOnly: PairSignal[] = [{room:"thin",a:"p1",b:"p2",pickOverlap:0,mutualPick:1,debriefSim:0,iosMean:0,traitAgreement:0,componentsUsed:["mutualPick"],pairScore:1,coupleEvidence:1,friendEvidence:0,negativeMutual:0}];
  const pickOnlyClaims = computeResults(measuredPickOnly, coupleLog, meta).claims;
  const pairClaims = pickOnlyClaims.filter(c => c.subjects.includes("p1") && c.subjects.includes("p2"));
  assert.ok(pairClaims.length > 0);
  assert.ok(pairClaims.every(c => c.confidence !== "high"), "one measured type never yields high-confidence public claims");
});


