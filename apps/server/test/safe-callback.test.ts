import { test } from "node:test";
import assert from "node:assert/strict";
import type { LogRecord } from "../../../packages/shared/src/contracts.ts";
import { safeCallbackQuotes } from "../src/safe-callback.ts";

const quote = "This group makes every night feel like a celebration.";
const record = (playerId: string, text: string, roundKind: LogRecord["roundKind"] = "text"): LogRecord => ({
  roomId: "r", roundId: "r1", playerId, roundKind, promptId: "q", coding: "neutral", value: {kind: "text", text}, at: 1, latencyMs: 1,
});

test("finale callbacks require several independent matching answers and safe, non-identifying wording", () => {
  const aliases = ["Alice.*", "p2", "Player 4", "A+B"];
  assert.deepEqual(safeCallbackQuotes([record("p1", quote), record("p2", quote)], aliases), []);
  assert.deepEqual(safeCallbackQuotes([record("p1", quote), record("p2", quote), record("p3", quote)], aliases), [quote]);
  assert.deepEqual(safeCallbackQuotes([record("p1", quote), record("p1", quote), record("p1", quote)], aliases), []);
  for (const unsafe of ["Alice.* makes every night feel like a celebration.", "Player 4 makes every night feel like a celebration.", "I hid my secret in the kitchen on Tuesday."]) {
    assert.deepEqual(safeCallbackQuotes([record("p1", unsafe), record("p2", unsafe), record("p3", unsafe)], aliases), []);
  }
  assert.deepEqual(safeCallbackQuotes([record("p1", quote, "debrief"), record("p2", quote, "debrief"), record("p3", quote, "debrief")], aliases), []);
});
