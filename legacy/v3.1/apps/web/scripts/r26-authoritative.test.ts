import assert from "node:assert/strict";
import { test } from "node:test";
import type { PlayerView, RoundView } from "@shared/contracts.ts";
import { demoAnswerValue } from "../src/lib/demoAnswer.ts";

const players: PlayerView[] = [1, 2, 3, 4].map((n) => ({ id: `p${n}`, alias: `Person ${n}`, connected: true, isBot: false }));
const base: RoundView = { roundId: "r26", index: 8, phase: "spicy", kind: "rating", promptText: "Give a number from one to ten.", closesAt: Date.now() + 60_000, youSubmitted: false };

test("R26: demo answers use the server-assigned rating trait and subject, not prompt wording or seat rotation", () => {
  const round: RoundView = { ...base, kind: "rating", trait: "honesty", about: "p4" };
  assert.deepEqual(demoAnswerValue(round, "p1", players), { kind: "rating", trait: "honesty", about: "p4", value: 5 });
  assert.deepEqual(demoAnswerValue({ ...round, about: "p2", trait: "chaos" }, "p3", players), { kind: "rating", trait: "chaos", about: "p2", value: 7 });
  assert.equal(demoAnswerValue({ ...base, kind: "rating", trait: undefined, about: "p4" }, "p1", players), null);
  assert.equal(demoAnswerValue({ ...base, kind: "rating", trait: "honesty", about: undefined }, "p1", players), null);
});

test("R26: demo closeness answers use the authoritative IOS subject", () => {
  const round: RoundView = { ...base, kind: "ios", about: "p3", promptText: "How close are you and Person 2, really?" };
  assert.deepEqual(demoAnswerValue(round, "p1", players), { kind: "ios", about: "p3", value: 2 });
  assert.equal(demoAnswerValue({ ...round, about: undefined }, "p1", players), null);
});
