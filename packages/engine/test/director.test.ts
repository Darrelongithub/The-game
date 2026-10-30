// packages/engine/test/director.test.ts
// ROUND 4 STEP 3 + 4 — the Director: mid-band formation, graduation, the
// one-sided hard rule, the 50/30/20 mix, the coverage matrix, anti-telegraph,
// cross-night priors and replay determinism. No client is involved: these are
// pure functions over (signals, log, meta).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANTI_TELEGRAPH_MAX,
  HYPOTHESIS_FORM_BAND,
  ROUND_MIX,
  type Claim,
  type Hypothesis,
  type LogRecord,
  type Prompt,
  type PromptCoding,
  type RoundKind,
} from "../../shared/src/contracts.ts";
import {
  carryOver,
  consecutiveTouches,
  coverageCells,
  emptyDirectorState,
  formHypotheses,
  planRound,
  recordSelection,
  starvedCells,
  updateHypotheses,
  type DirectorState,
} from "../src/index.ts";
import { computeSignals } from "../src/signals.ts";
import { LogBuilder, meta5 } from "./fixtures.ts";

const meta = meta5("room-director");

const hypothesesOf = (log: LogRecord[], priors: Hypothesis[] = []) =>
  formHypotheses(computeSignals(log, meta), log, meta, priors);

const find = (list: Hypothesis[], kind: Hypothesis["kind"], subjects?: string[]) =>
  list.find((h) => h.kind === kind && (!subjects || [...h.subjects].sort().join(",") === [...subjects].sort().join(",")));

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

test("a mid-band suspicion OPENS, and its evidence grows with new answers", () => {
  // p1 chose p2 in 2 of 4 positive picks, p2 never chose back: rate .5,
  // reverse 0 → strength .5 — squarely inside the mid-band.
  const b = new LogBuilder("room-director");
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p3"]]);
  b.pickRound("C2", "couple", [["p1", "p2"], ["p2", "p4"], ["p3", "p5"], ["p4", "p1"], ["p5", "p4"]]);
  b.pickRound("C3", "couple", [["p1", "p3"], ["p2", "p1"], ["p3", "p2"], ["p4", "p3"], ["p5", "p1"]]);
  b.pickRound("C4", "couple", [["p1", "p4"], ["p2", "p5"], ["p3", "p4"], ["p4", "p2"], ["p5", "p3"]]);
  const opened = hypothesesOf(b.log);
  const suspicion = find(opened, "onesided", ["p1", "p2"]);
  assert.ok(suspicion, "a .5 one-sided read is exactly the kind of thing to be suspicious about");
  assert.equal(suspicion.status, "open");
  assert.ok(suspicion.strength >= HYPOTHESIS_FORM_BAND.lo && suspicion.strength <= HYPOTHESIS_FORM_BAND.hi);
  assert.ok(suspicion.openedAt > 0, "openedAt is a real epoch ms");
  assert.equal(suspicion.evidence.length, 1);
  assert.match(suspicion.evidence[0]!, /Player 1 chose Player 2 2 times/u, "evidence is engine-written and pseudonymous");

  // One more p1→p2 pick strengthens it (rate 3/5 = .6) and adds evidence.
  b.pickRound("C5", "couple", [["p1", "p2"], ["p2", "p5"], ["p3", "p1"], ["p4", "p5"], ["p5", "p2"]]);
  const stronger = find(hypothesesOf(b.log), "onesided", ["p1", "p2"]);
  assert.ok(stronger);
  assert.ok(stronger.strength > suspicion.strength, `expected strength to grow, got ${suspicion.strength} → ${stronger.strength}`);
  assert.match(stronger.evidence[0]!, /3 times/u, "the evidence line is rewritten with the new count");
});

test("above the band with 3+ independent signals GRADUATES to a claim and leaves the set", () => {
  const b = new LogBuilder("room-director");
  // p1 → p2 every single time (rate 1, reverse 0, 3 hits).
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p3"]]);
  b.pickRound("C2", "couple", [["p1", "p2"], ["p2", "p4"], ["p3", "p5"], ["p4", "p1"], ["p5", "p4"]]);
  b.pickRound("C3", "couple", [["p1", "p2"], ["p2", "p5"], ["p3", "p2"], ["p4", "p3"], ["p5", "p1"]]);
  const signals = computeSignals(b.log, meta);
  const update = updateHypotheses(signals, b.log, meta);
  assert.equal(find(update.hypotheses, "onesided", ["p1", "p2"]), undefined, "a graduated suspicion leaves the set");
  const claim = update.claims.find((c) => c.type === "onesided" && c.subjects.includes("p1") && c.subjects.includes("p2"));
  assert.ok(claim, "it left the set because it became a claim");
  assert.equal(claim.audience, "private", "ONE-SIDED RULE: private, forever");
  assert.equal(claim.confidence, "high");
  assert.ok(claim.id.startsWith("dir-"));
  assert.ok(Number(claim.numbers?.signals) >= 3);
});

test("a suspicion that the latest round contradicts is REFUTED, not silently dropped", () => {
  const b = new LogBuilder("room-director");
  // In-band after round C1 alone: p1 chose p2 2 of 4, never the reverse.
  b.pickRound("C1", "couple", [["p1", "p2"], ["p1", "p2"], ["p1", "p3"], ["p1", "p4"], ["p3", "p5"], ["p4", "p5"], ["p5", "p3"]]);
  const opening = find(hypothesesOf(b.log), "onesided", ["p1", "p2"]);
  assert.ok(opening);
  assert.equal(opening.status, "open");
  // The final round: p2 answers the same way twice. The one-sided read dies.
  b.pickRound("C2", "couple", [["p2", "p1"], ["p2", "p1"], ["p3", "p4"], ["p4", "p3"], ["p5", "p1"]]);
  const refuted = find(hypothesesOf(b.log), "onesided", ["p1", "p2"]);
  assert.ok(refuted, "a refuted suspicion stays visible to the ENGINE for the rest of the night");
  assert.equal(refuted.status, "refuted");
  assert.ok(refuted.strength < HYPOTHESIS_FORM_BAND.lo);
  assert.ok(refuted.evidence.some((line) => /pulled the other way/u.test(line)));
});

test("below the band is noise: no hypothesis, no claim", () => {
  const b = new LogBuilder("room-director");
  // One lonely pick: rate 1/1 but only one hit, so one-sided never opens.
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p3"]]);
  const update = updateHypotheses(computeSignals(b.log, meta), b.log, meta);
  assert.equal(find(update.hypotheses, "onesided", ["p1", "p2"]), undefined);
  assert.deepEqual(update.claims, []);
});

test("carryOver turns open questions into UNRESOLVED priors and still probes them next night", () => {
  const b = new LogBuilder("room-director");
  // p1 picks p2 in 3 of 5 (rate .6), reverse 1 of 5 → strength .48: mid-band.
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p3"]]);
  b.pickRound("C2", "couple", [["p1", "p2"], ["p2", "p4"], ["p3", "p5"], ["p4", "p1"], ["p5", "p4"]]);
  b.pickRound("C3", "couple", [["p1", "p2"], ["p2", "p5"], ["p3", "p2"], ["p4", "p3"], ["p5", "p1"]]);
  b.pickRound("C4", "couple", [["p1", "p3"], ["p2", "p1"], ["p3", "p4"], ["p4", "p2"], ["p5", "p3"]]);
  b.pickRound("C5", "couple", [["p1", "p4"], ["p2", "p5"], ["p3", "p1"], ["p4", "p3"], ["p5", "p2"]]);
  const tonight = hypothesesOf(b.log);
  const carried = carryOver(tonight);
  assert.ok(carried.length > 0);
  assert.ok(carried.every((h) => h.status === "unresolved"));

  // Night 2 starts with no log at all — the priors must survive untouched.
  const carriedPrior = carried.find((h) => h.kind === "onesided")!;
  const early = formHypotheses([], [], meta, carried);
  const stillThere = early.find((h) => h.id === carriedPrior.id);
  assert.ok(stillThere, "the old suspect is still on the list before any new evidence");
  assert.equal(stillThere.openedAt, carriedPrior.openedAt, "it remembers the night it OPENED");
  assert.equal(stillThere.status, "open", "a carried suspicion is a live question again");
});

// ---------------------------------------------------------------------------
// Selection: the mix, the matrix, anti-telegraph
// ---------------------------------------------------------------------------

const prompt = (id: string, coding: PromptCoding, kind: RoundKind = "pick"): Prompt => ({
  id, source: "bank", phase: "warmup", kind,
  text: `Who here fits {P1} and {P2} on the ${coding} question?`,
  measures: [kind], coding, asksTarget: true,
});

const POOL: Prompt[] = [
  "couple", "friendship", "trust", "friction", "rivalry", "status", "neutral",
].flatMap((coding) => Array.from({ length: 20 }, (_, i) => prompt(`${coding}-${i}`, coding as PromptCoding)));

test("the mix splits roughly 50/30/20 over many seeds", () => {
  const counts = { test: 0, explore: 0, classic: 0 };
  const runs = 600;
  for (let seed = 1; seed <= runs; seed++) {
    const hypothesis: Hypothesis = {
      id: "dir-onesided-p1-p2", kind: "onesided", subjects: ["p1", "p2"], status: "open",
      strength: 0.5, evidence: [], openedAt: 1,
    };
    const planned = planRound({ hypotheses: [hypothesis], state: emptyDirectorState(), candidates: POOL, seed, meta });
    assert.ok(planned);
    counts[planned.mode] += 1;
  }
  for (const [mode, share] of Object.entries(ROUND_MIX)) {
    const actual = counts[mode as keyof typeof counts] / runs;
    assert.ok(Math.abs(actual - share) < 0.08, `${mode}: expected ~${share}, got ${actual.toFixed(2)}`);
  }
});

test("test-mix prompts probe the OPEN hypothesis's subjects on its dimension", () => {
  const hypothesis: Hypothesis = {
    id: "dir-onesided-p2-p4", kind: "onesided", subjects: ["p2", "p4"], status: "open",
    strength: 0.55, evidence: [], openedAt: 1,
  };
  let tested = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const planned = planRound({ hypotheses: [hypothesis], state: emptyDirectorState(), candidates: POOL, seed, meta });
    if (!planned || planned.mode !== "test") continue;
    tested++;
    assert.equal(planned.dimension, "couple", "onesided probes the couple dimension");
    assert.deepEqual(planned.subjects, ["p2", "p4"], "and it probes THESE two people");
    assert.match(planned.prompt.text, /\{P1\}/u, "a targeted prompt keeps ordinary placeholders — it must read organic");
  }
  assert.ok(tested > 50, `expected a healthy number of test rounds, got ${tested}`);
});

test("explore only ever fills a STILL-EMPTY cell while one is reachable", () => {
  let state: DirectorState = emptyDirectorState();
  let explored = 0;
  // 60 rounds is fewer than the 70 cells, so starvation must remain provable.
  for (let seed = 1; seed <= 60; seed++) {
    const before = state;
    const planned = planRound({ hypotheses: [], state, candidates: POOL, seed, meta });
    assert.ok(planned);
    if (planned.mode === "explore") {
      explored++;
      const key = `${planned.subjects.slice().sort().join("\u0000")}|${planned.dimension}`;
      assert.equal(before.coverage[key] ?? 0, 0, "explore must never re-touch a covered cell while starved ones exist");
    }
    state = planned.state;
    if (starvedCells(state, meta).length === 0) break;
  }
  assert.ok(explored > 0, "the explore lane must actually fire");
  assert.ok(starvedCells(state, meta).length > 0, "a 120-round night still leaves unvisited pair×dimension cells");
});

test("a 12-round scripted night starves no cell the explore lane could have hit", () => {
  const b = new LogBuilder("room-director");
  let state = emptyDirectorState();
  let hypotheses: Hypothesis[] = [];
  const touched: string[] = [];
  for (let round = 1; round <= 12; round++) {
    const planned = planRound({ hypotheses, state, candidates: POOL, seed: round, meta });
    assert.ok(planned, `round ${round} must be plannable`);
    touched.push(planned.prompt.id);
    state = planned.state;
    // Deterministic answers: p1 keeps choosing p2, everybody else rotates.
    const targets = ["p2", "p3", "p4", "p5", "p3"];
    const roundId = `R${round}`;
    b.pickRound(roundId, "couple", [
      ["p1", planned.subjects[1] ?? "p2"], ["p2", targets[round % 5]!], ["p3", targets[(round + 1) % 5]!],
      ["p4", targets[(round + 2) % 5]!], ["p5", targets[(round + 3) % 5]!],
    ]);
    hypotheses = formHypotheses(computeSignals(b.log, meta), b.log, meta);
  }
  assert.equal(new Set(touched).size, 12, "twelve distinct prompts, no repeats");
  // 12 rounds cannot cover 10 pairs × 7 dimensions — but every cell the explore
  // lane DID take was starved at the time, and every round touched exactly one
  // cell of the matrix.
  const covered = Object.values(state.coverage).reduce((n, v) => n + v, 0);
  assert.equal(covered, 12, "every planned round is recorded exactly once in the matrix");
});

test("ANTI-TELEGRAPH: never more than the cap of consecutive rounds on one pair", () => {
  const stuck: Hypothesis = {
    id: "dir-onesided-p1-p2", kind: "onesided", subjects: ["p1", "p2"], status: "open",
    strength: 0.9, evidence: [], openedAt: 1,
  };
  let state = emptyDirectorState();
  const pairs: string[] = [];
  for (let seed = 1; seed <= 60; seed++) {
    // The strongest suspicion is ALWAYS the same pair: the cap is the only
    // thing stopping the engine from machine-gunning it.
    const planned = planRound({ hypotheses: [stuck], state, candidates: POOL, seed, meta });
    assert.ok(planned);
    state = planned.state;
    const pair = planned.subjects.slice().sort().join("\u0000");
    if (pair) pairs.push(pair);
    assert.ok(consecutiveTouches(state.recentPairs, pair || "none") <= ANTI_TELEGRAPH_MAX,
      `seed ${seed}: ${ANTI_TELEGRAPH_MAX + 1} consecutive rounds touched one pair`);
  }
  // And the run-length view really does cap: build one deliberately.
  const forced = recordSelection(recordSelection(recordSelection(emptyDirectorState(), { subjects: ["p1", "p2"], dimension: "couple", promptId: "a" }),
    { subjects: ["p1", "p2"], dimension: "couple", promptId: "b" }), { subjects: ["p1", "p2"], dimension: "couple", promptId: "c" });
  assert.equal(consecutiveTouches(forced.recentPairs, "p1\u0000p2"), 3);
});

test("determinism: same log → same hypotheses, same payloads, twice", () => {
  const b = new LogBuilder("room-director");
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p3"]]);
  b.pickRound("C2", "couple", [["p1", "p2"], ["p2", "p4"], ["p3", "p5"], ["p4", "p1"], ["p5", "p4"]]);
  b.rating("R1", "p1", "honesty", "self", 9).rating("R1", "p2", "honesty", "p1", 4);
  b.rating("R1", "p3", "honesty", "p1", 5);
  const first = updateHypotheses(computeSignals(b.log, meta), b.log, meta);
  const second = updateHypotheses(computeSignals(b.log, meta), b.log, meta);
  assert.deepEqual(second.hypotheses, first.hypotheses);
  assert.deepEqual(second.claims, first.claims);

  const state = emptyDirectorState();
  const plannedFirst = planRound({ hypotheses: first.hypotheses, state, candidates: POOL, seed: 7, meta });
  const plannedSecond = planRound({ hypotheses: second.hypotheses, state, candidates: POOL, seed: 7, meta });
  assert.deepEqual(plannedSecond, plannedFirst);
});

test("two identical nights select the identical sequence of prompts", () => {
  const run = () => {
    let state = emptyDirectorState();
    let hypotheses: Hypothesis[] = [];
    const ids: string[] = [];
    const b = new LogBuilder("room-director");
    for (let round = 1; round <= 10; round++) {
      const planned = planRound({ hypotheses, state, candidates: POOL, seed: round, meta });
      assert.ok(planned);
      ids.push(`${planned.mode}:${planned.prompt.id}:${planned.subjects.join("+")}`);
      state = planned.state;
      b.pickRound(`R${round}`, "couple", [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p3"]]);
      hypotheses = formHypotheses(computeSignals(b.log, meta), b.log, meta);
    }
    return ids;
  };
  assert.deepEqual(run(), run());
});

test("hypotheses are internal: their ids and evidence never name a real alias", () => {
  const b = new LogBuilder("room-director");
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p3"]]);
  b.pickRound("C2", "couple", [["p1", "p2"], ["p2", "p4"], ["p3", "p5"], ["p4", "p1"], ["p5", "p4"]]);
  const update = updateHypotheses(computeSignals(b.log, meta), b.log, meta);
  const text = JSON.stringify(update);
  for (const alias of ["Ana", "Ben", "Cia", "Dan", "Eli"]) {
    assert.ok(!text.includes(alias), `a hypothesis must stay pseudonymous (${alias} leaked)`);
  }
  assert.ok(text.includes("Player 1"), "it uses the same pseudonyms as every other engine artefact");
});

test("coverage matrix keys are pair × dimension and count is monotone", () => {
  const cells = coverageCells(emptyDirectorState(), meta);
  assert.equal(cells.length, (5 * 4) / 2 * 7, "10 pairs × 7 dimensions");
  assert.ok(cells.every((cell) => cell.count === 0));
  const once = recordSelection(emptyDirectorState(), { subjects: ["p1", "p2"], dimension: "trust", promptId: "x" });
  const twice = recordSelection(once, { subjects: ["p2", "p1"], dimension: "trust", promptId: "y" });
  assert.equal(twice.coverage["p1\u0000p2|trust"], 2, "subject order does not matter");
  assert.equal(starvedCells(twice, meta).length, cells.length - 1);
});
