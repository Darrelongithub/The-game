import assert from "node:assert/strict";
import { test } from "node:test";
import type { LogRecord, ResponseValue, RoomMeta, RoundKind } from "../../../packages/shared/src/contracts.ts";
import { buildNightDigest, buildSecrets, buildSkeleton, computeResults, computeSignals } from "../src/services.ts";

test("offline signals, digest and secrets are deterministic and private", () => {
  const meta: RoomMeta = { roomId: "room", players: [1,2,3,4].map((i) => ({ id: `p${i}`, alias: `Player ${i}` })), revealOptIn: ["p1", "p2", "p3"], profiles: {} };
  const row = (roundId: string, playerId: string, value: ResponseValue, roundKind: RoundKind = value.kind): LogRecord => ({ roomId: "room", roundId, playerId, roundKind, promptId: "prompt", coding: "couple", value, at: 1000, latencyMs: 400 });
  const log: LogRecord[] = [
    row("pick", "p1", { kind:"pick",target:"p2" }), row("pick", "p2", { kind:"pick",target:"p1" }),
    row("ios", "p1", { kind:"ios",about:"p2",value:7 }), row("ios", "p2", { kind:"ios",about:"p1",value:7 }),
    row("self1", "p1", {kind:"rating",trait:"warmth",about:"self",value:7}),
    row("peer1", "p2", {kind:"rating",trait:"warmth",about:"p1",value:7}),
    row("self2", "p2", {kind:"rating",trait:"warmth",about:"self",value:7}),
    row("peer2", "p1", {kind:"rating",trait:"warmth",about:"p2",value:7}),
    row("deb", "p1", {kind:"text",text:"same words here"}, "debrief"),
    row("deb", "p2", {kind:"text",text:"same words here"}, "debrief"),
  ];
  const signals = computeSignals(log, meta), pair = signals.find((s) => s.a === "p1" && s.b === "p2")!;
  assert.equal(pair.pickOverlap, 0); assert.equal(pair.mutualPick, 1); assert.equal(pair.debriefSim, 1);
  assert.equal(pair.iosMean, 1); assert.equal(pair.traitAgreement, 1); assert.equal(pair.pairScore, 1, "all measured positive pair components score 1; absent overlap is not a vote");
  assert.deepEqual(computeSignals(log, meta), signals);
  const results = computeResults(signals, log, meta), digest = buildNightDigest(log, meta);
  assert.deepEqual(computeResults(signals, log, meta), results);
  assert.deepEqual(buildNightDigest(log, meta), digest);
  assert.ok(results.claims.some((c) => c.type === "spark" && c.audience === "private"));
  const decks = buildSecrets(results, digest, meta);
  assert.deepEqual(buildSecrets(results, digest, meta), decks);
  assert.ok(decks.get("p1")?.some((c) => c.kind === "spark"));
  assert.ok(decks.get("p2")?.some((c) => c.kind === "spark"));
  assert.ok(!decks.get("p3")?.some((c) => c.kind === "spark"));
  assert.equal(decks.has("p4"), false);
  const slides = buildSkeleton(results, digest);
  assert.ok(slides.every((s) => !s.claimId?.startsWith("spark-")));
  assert.ok(!JSON.stringify(slides).includes("same words here"), "private debrief text is not quoted");
});
