// packages/engine/test/confess.test.ts
// CONFESS ROUNDS — STEP 2/5/7 regression suite for the second voice.
// Every test here was written to FAIL before the feature landed:
//   • a confess round collects private answers and missing stays MISSING;
//   • a confess answer with a target is a "confession" pair component, and is
//     never sufficient alone (it can raise confidence, never create a claim);
//   • the 50/50 style selector holds STYLE_MIX within ±1 over a 12-round night;
//   • twin scheduling lands 1–3 rounds after its group twin, exactly when due;
//   • the mismatch line may name the room's suspect and a YES count — never a no;
//   • everything is deterministic: same log, same selection, same reveal numbers.
// Run: npm --prefix packages/engine test
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  STYLE_MIX,
  TWIN_WINDOW,
  type LogRecord,
  type RoomMeta,
} from "../../shared/src/contracts.ts";
import {
  buildNightDigest,
  chooseStyle,
  confessAnswers,
  confessMismatches,
  confessTally,
  confessYesRate,
  confessionComponent,
  computeResults,
  computeSignals,
  emptyStyleServed,
  planStyles,
  planTwin,
  recordStyle,
  styleDrift,
  twinDue,
  updateHypotheses,
  type StyleServed,
  type TwinPlan,
} from "../src/index.ts";
import { LogBuilder, meta5 } from "./fixtures.ts";

const count = (styles: readonly string[], style: string): number => styles.filter((s) => s === style).length;

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

test("confess round collects private answers; missing answers stay missing (never 'no')", () => {
  const b = new LogBuilder("room-confess-1");
  b.confess("c1", "p1", true);
  b.confess("c1", "p2", false);
  b.confess("c1", "p3", true, { note: "years ago" });
  // p4 and p5 never answer — no skip option exists, so they simply don't land.
  const log = b.log;
  const meta = meta5("room-confess-1");

  const answers = confessAnswers(log);
  assert.equal(answers.length, 3, "only the three players who answered exist in the log");
  assert.deepEqual(answers.map((a) => a.playerId), ["p1", "p2", "p3"]);

  const tally = confessTally(log, "c1", meta);
  assert.deepEqual(tally, { yes: 2, no: 1, answered: 3, of: 5, missing: 2 });
  assert.equal(tally.yes + tally.no + tally.missing, tally.of, "every player is yes, no or missing");
  assert.notEqual(tally.no, tally.of - tally.yes, "a missing phone must never be counted as a no");
  assert.equal(tally.no, 1, "exactly one explicit no");
});

test("a whole silent confess round reads as missing, not as unanimity", () => {
  const b = new LogBuilder("room-confess-silent");
  b.pickRound("w1", "friendship", [["p1", "p2"]]); // some other round, no confessions
  const tally = confessTally(b.log, "c-empty", meta5("room-confess-silent"));
  assert.deepEqual(tally, { yes: 0, no: 0, answered: 0, of: 5, missing: 5 });
  assert.equal(confessYesRate(b.log), 0, "no answers is a 0 yes-rate, not a fabricated one");
});

// ---------------------------------------------------------------------------
// The pair component — evidence, never ground truth
// ---------------------------------------------------------------------------

test("a confess answer with a target appears as a 'confession' component on the pair", () => {
  const b = new LogBuilder("room-confess-pair");
  b.confess("c1", "p1", true, { target: "p2" });
  b.confess("c1", "p2", true, { target: "p1" });
  const log = b.log;
  const meta = meta5("room-confess-pair");

  const signals = computeSignals(log, meta);
  const pair = signals.find((s) => s.a === "p1" && s.b === "p2");
  assert.ok(pair, "p1/p2 pair signal exists");
  assert.ok(pair.componentsUsed.includes("confession"), "confession is a component type on the pair");
  assert.equal(pair.confession, 1, "both named each other");
  assert.equal(confessionComponent(log, "p1", "p2").used, true);

  // Weight 0: a confession never moves the weighted pair score.
  assert.equal(pair.pairScore, 0, "self-reports carry no score weight");
  // And it is not laundered into the perception machinery either.
  assert.equal(pair.mutualPick, 0, "a confession is not a pick");
  assert.equal(pair.pickOverlap, 0);
});

test("a confession alone never graduates anything to a claim", () => {
  const b = new LogBuilder("room-confess-alone");
  b.confess("c1", "p1", true, { target: "p2" });
  b.confess("c1", "p2", true, { target: "p1" });
  b.confess("c2", "p1", true, { target: "p2" });
  const log = b.log;
  const meta = meta5("room-confess-alone");

  const signals = computeSignals(log, meta);
  const results = computeResults(signals, log, meta);
  const pairClaims = results.claims.filter((c) => c.subjects.includes("p1") && c.subjects.includes("p2"));
  assert.deepEqual(pairClaims, [], "no ship, besties, spark or rival from self-reports alone");

  // The director agrees: nothing graduates from a confession-only log.
  const update = updateHypotheses(signals, log, meta);
  assert.deepEqual(update.claims, [], "a confession can never graduate a suspicion on its own");
});

test("a confession counts toward the ≥3 independent-types rule like any component", () => {
  const build = (withConfession: boolean): ReturnType<typeof computeResults> => {
    const b = new LogBuilder(withConfession ? "room-confess-3a" : "room-confess-3b");
    // Two people keep choosing each other (mutualPick) and rate each other close
    // (iosMean) — two independent types, i.e. "med" on their own.
    b.pickRound("r1", "couple", [["p1", "p2"], ["p2", "p1"], ["p3", "p1"], ["p4", "p5"]]);
    b.ios("r2", "p1", "p2", 7);
    b.ios("r2", "p2", "p1", 7);
    if (withConfession) b.confess("c1", "p1", true, { target: "p2" });
    const meta = meta5(withConfession ? "room-confess-3a" : "room-confess-3b");
    return computeResults(computeSignals(b.log, meta), b.log, meta);
  };

  const without = build(false).claims.find((c) => c.type === "ship" && c.subjects.includes("p1") && c.subjects.includes("p2"));
  const withConfession = build(true).claims.find((c) => c.type === "ship" && c.subjects.includes("p1") && c.subjects.includes("p2"));
  assert.equal(without?.confidence, "med", "two types alone is med");
  assert.equal(withConfession?.confidence, "high", "the confession is the third independent type");
  assert.ok(
    withConfession?.evidence.some((line) => /confessed/i.test(line)),
    "the confession is visible as evidence, not silently folded in",
  );
});

// ---------------------------------------------------------------------------
// THE 50/50 — style selection
// ---------------------------------------------------------------------------

test("a scripted 12-round night lands within ±1 of STYLE_MIX", () => {
  const styles = planStyles(12, 1);
  const group = count(styles, "group");
  const confess = count(styles, "confess");
  assert.equal(styles.length, 12);
  assert.ok(Math.abs(group - 12 * STYLE_MIX.group) <= 1, `group ${group} within ±1 of ${12 * STYLE_MIX.group}`);
  assert.ok(Math.abs(confess - 12 * STYLE_MIX.confess) <= 1, `confess ${confess} within ±1 of ${12 * STYLE_MIX.confess}`);

  // And the drift never exceeds one round at ANY point of the night.
  let served: StyleServed = emptyStyleServed();
  for (const style of styles) {
    served = recordStyle(served, style);
    assert.ok(styleDrift(served) <= 1, `drift ${styleDrift(served)} after ${served.group}/${served.confess}`);
  }
});

test("style selection is deterministic and seeded by the round index", () => {
  assert.deepEqual(planStyles(12, 1), planStyles(12, 1), "same seed → same plan");
  // Replaying from the same served state at the same index gives the same style.
  const served = recordStyle(recordStyle(emptyStyleServed(), "group"), "confess");
  assert.equal(chooseStyle(served, 7), chooseStyle(served, 7));
  // The mix is a real target: a caught-up state can go either way, a lagging
  // state is forced so the night can never skew.
  assert.equal(chooseStyle({ group: 6, confess: 0 }, 3), "confess", "far behind on confessions → forced");
  assert.equal(chooseStyle({ group: 0, confess: 6 }, 3), "group", "far ahead on confessions → forced");
});

// ---------------------------------------------------------------------------
// TWINS — perception, then reality
// ---------------------------------------------------------------------------

test("the twin fires 1–3 rounds later exactly when the plan says", () => {
  // Find a seed that schedules (the director is occasional, not deterministic
  // about firing at all) and one that refuses — both behaviours are asserted.
  const seeds = Array.from({ length: 40 }, (_, i) => i + 1);
  const plans = seeds
    .map((seed) => planTwin({ groupRoundIndex: 4, groupPromptId: "g1", confessPromptId: "c1", seed, scheduledThisPhase: false }))
    .filter((plan): plan is TwinPlan => plan !== undefined);

  assert.ok(plans.length > 0, "some seeds schedule a twin (the payoff must be reachable)");
  assert.ok(plans.length < seeds.length, "not every seed schedules one — occasionally, not always");
  for (const plan of plans) {
    const offset = plan.dueAt - 4;
    assert.ok(offset >= TWIN_WINDOW.min && offset <= TWIN_WINDOW.max, `twin scheduled ${offset} rounds later`);
    assert.equal(plan.confessPromptId, "c1");
    assert.equal(twinDue(plan, plan.dueAt - 1), false, "not due early");
    assert.equal(twinDue(plan, plan.dueAt), true, "due exactly on its round");
    assert.equal(twinDue(plan, plan.dueAt + 1), true, "still due if a group slot came first");
  }

  // Deterministic: same input, same plan.
  assert.deepEqual(
    planTwin({ groupRoundIndex: 4, groupPromptId: "g1", confessPromptId: "c1", seed: 2, scheduledThisPhase: false }),
    planTwin({ groupRoundIndex: 4, groupPromptId: "g1", confessPromptId: "c1", seed: 2, scheduledThisPhase: false }),
  );

  // At most one twin per phase.
  assert.equal(
    planTwin({ groupRoundIndex: 4, groupPromptId: "g2", confessPromptId: "c2", seed: 2, scheduledThisPhase: true }),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// THE PAYOFF — the mismatch line
// ---------------------------------------------------------------------------

test("the mismatch line appears exactly when the room was sure and ≥2 said yes — and never names a no", () => {
  const b = new LogBuilder("room-mismatch");
  // Group twin: the room was sure it was p3 (4 of 5 picks).
  b.pickRound("g1", "couple", [["p1", "p3"], ["p2", "p3"], ["p3", "p1"], ["p4", "p3"], ["p5", "p3"]]);
  // Confess twin: p3 and p5 say yes about themselves, p1 and p2 say no, p4 stays missing.
  b.confess("c1", "p3", true, { promptId: "g1-twin" });
  b.confess("c1", "p5", true, { promptId: "g1-twin" });
  b.confess("c1", "p1", false, { promptId: "g1-twin" });
  b.confess("c1", "p2", false, { promptId: "g1-twin" });
  const meta = meta5("room-mismatch");

  const links = [{ groupPromptId: "g1-prompt", confessPromptId: "g1-twin" }];
  const mismatches = confessMismatches(b.log, meta, links);
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0]!.target, "p3");
  assert.equal(mismatches[0]!.yes, 2);
  assert.equal(
    mismatches[0]!.line,
    "The room was sure it was Player 3. Two people just said yes.",
  );

  // HARD RULE: no "no", no count of no, no attribution of a no — ever.
  assert.ok(!/\bno\b|didn't|did not|denied/i.test(mismatches[0]!.line), "the line must not expose a no");
  assert.ok(!/Player 1|Player 2|Player 4/.test(mismatches[0]!.line), "nobody else is named");
  // The yes-answerer is only referenced as the ROOM's suspect — the line never
  // says who said yes. (p5 said yes and is not named.)
  assert.ok(!/Player 5/.test(mismatches[0]!.line));

  // No majority in the group round → no line.
  const flat = new LogBuilder("room-mismatch-flat");
  flat.pickRound("g1", "couple", [["p1", "p2"], ["p2", "p1"], ["p3", "p4"], ["p4", "p5"]]);
  flat.confess("c1", "p3", true, { promptId: "g1-twin" });
  flat.confess("c1", "p5", true, { promptId: "g1-twin" });
  assert.deepEqual(confessMismatches(flat.log, meta5("room-mismatch-flat"), links), [], "no room consensus, no mismatch");

  // One yes is not a mismatch — it is a private moment.
  const single = new LogBuilder("room-mismatch-single");
  single.pickRound("g1", "couple", [["p1", "p3"], ["p2", "p3"], ["p3", "p1"], ["p4", "p3"]]);
  single.confess("c1", "p3", true, { promptId: "g1-twin" });
  assert.deepEqual(confessMismatches(single.log, meta5("room-mismatch-single"), links), [], "one yes is not a mismatch line");
});

// ---------------------------------------------------------------------------
// Room temperature — informational, never a gate
// ---------------------------------------------------------------------------

test("aggregate yes-rate reads room warmth but gates nothing", () => {
  const warm = new LogBuilder("room-warm");
  for (const id of ["p1", "p2", "p3", "p4"]) warm.confess("c1", id, true);
  const cool = new LogBuilder("room-cool");
  for (const id of ["p1", "p2", "p3", "p4"]) cool.confess("c1", id, false);
  assert.equal(confessYesRate(warm.log), 1);
  assert.equal(confessYesRate(cool.log), 0);
  // It shows up in the digest as a count-only teaser — never as a rule.
  const digest = buildNightDigest(warm.log, meta5("room-warm"));
  assert.ok(digest.pickTeasers.some((line) => /4 of 4 confessions tonight were a yes/.test(line)));
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

test("determinism: the same log yields the same signals, claims and digest twice", () => {
  const b = new LogBuilder("room-determinism");
  b.pickRound("g1", "couple", [["p1", "p3"], ["p2", "p3"], ["p3", "p1"], ["p4", "p3"], ["p5", "p3"]]);
  b.confess("c1", "p3", true, { target: "p1", note: "not telling" });
  b.confess("c1", "p1", true, { target: "p3" });
  b.confess("c1", "p2", false);
  b.ios("r2", "p1", "p3", 6);
  b.ios("r2", "p3", "p1", 6);
  b.text("t1", "p2", "Somebody here always knows the plan before anyone else does.");
  const meta: RoomMeta = meta5("room-determinism");
  const log: LogRecord[] = [...b.log];

  const first = {
    signals: computeSignals(log, meta),
    claims: computeResults(computeSignals(log, meta), log, meta).claims,
    digest: buildNightDigest(log, meta),
    styles: planStyles(12, 1),
    twins: planStyles(12, 1).map((_, i) => planTwin({ groupRoundIndex: i, groupPromptId: "g1", confessPromptId: "c1", seed: i + 1, scheduledThisPhase: false })),
  };
  const second = {
    signals: computeSignals(log, meta),
    claims: computeResults(computeSignals(log, meta), log, meta).claims,
    digest: buildNightDigest(log, meta),
    styles: planStyles(12, 1),
    twins: planStyles(12, 1).map((_, i) => planTwin({ groupRoundIndex: i, groupPromptId: "g1", confessPromptId: "c1", seed: i + 1, scheduledThisPhase: false })),
  };
  assert.deepEqual(first, second);
});
