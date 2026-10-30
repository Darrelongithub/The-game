import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import type { LogRecord, RoomMeta } from "../../shared/src/contracts.ts";
import { computeResults, computeSignals } from "../src/index.ts";

test("11-player computeResults stays under 2 seconds and is deterministic", () => {
  const players = Array.from({ length: 11 }, (_, i) => ({ id: `p${i + 1}`, alias: `Perf${i + 1}` }));
  const meta: RoomMeta = { roomId: "perf-11", players, revealOptIn: players.map(p => p.id), profiles: {} };
  const log: LogRecord[] = [];
  let seed = 0x51f15e;
  const rand = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let round = 0; round < 120; round++) for (const [i, picker] of players.entries()) {
    const target = players[(i + 1 + rand(10)) % players.length]!;
    log.push({ roomId: meta.roomId, roundId: `r${round}`, playerId: picker.id, roundKind: "pick", promptId: `p${round}`, coding: round % 3 === 0 ? "friction" : "couple", value: { kind: "pick", target: target.id }, at: round * 1000 + log.length, latencyMs: 1000 });
  }
  const signals = computeSignals(log, meta);
  const before = performance.now();
  const first = computeResults(signals, log, meta);
  const elapsed = performance.now() - before;
  const second = computeResults(signals, log, meta);
  assert.ok(elapsed < 2_000, `computeResults took ${elapsed.toFixed(1)}ms`);
  assert.deepEqual(first, second);
  console.info(`[perf] 11-player/1320-pick computeResults=${elapsed.toFixed(1)}ms`);
});
