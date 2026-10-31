import assert from "node:assert/strict";
import { test } from "node:test";
import { validSubmit } from "../../shared/src/validate.ts";
import { computeSignals } from "../src/signals.ts";
import { computeResults } from "../src/results.ts";
import { LogBuilder, meta5 } from "./fixtures.ts";

test("self-picks are accepted but never move pair scores or claims", () => {
  assert.ok(validSubmit({kind: "pick", target: "p1"}, "p1"));
  const base = new LogBuilder("self");
  base.pickRound("a", "couple", [["p2", "p3"], ["p3", "p2"], ["p4", "p3"], ["p5", "p3"]]);
  const meta = meta5("self");
  const before = computeSignals(base.log, meta);
  const beforeResults = computeResults(before, base.log, meta);
  base.pickRound("a", "couple", [["p1", "p1"]]);
  const after = computeSignals(base.log, meta);
  assert.deepEqual(after, before);
  assert.deepEqual(computeResults(after, base.log, meta).claims, beforeResults.claims);
});
