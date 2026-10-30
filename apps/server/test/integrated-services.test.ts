import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io } from "socket.io-client";
import { goldenLog1, meta5 } from "../../../packages/engine/test/fixtures.ts";
import { CallGuard, Provider } from "../../../packages/prompts/src/index.ts";
import { candidate, grokReply, mockFetch } from "../../../packages/prompts/test/helpers.ts";
import type { NightDigest, ResponseValue, RoundView } from "../../../packages/shared/src/contracts.ts";
import { createIntegratedServices } from "../src/integrated-services.ts";
import { createGameServer } from "../src/server.ts";

const empty: NightDigest = { quotes: [], stats: {}, runningGags: [], pickTeasers: [], dodges: [], selfVsRoom: [] };
const offline = () => createIntegratedServices(new Provider({ env: {}, guard: new CallGuard() }));

test("production adapter uses the full bank, golden scoring and public narrator offline", async () => {
  const services = offline(), prompts = services.createPromptProvider("room");
  await prompts.prepare!({ playerCount: 5, usedIds: [], digest: empty });
  for (const phase of ["warmup", "spicy", "deep", "dare"] as const) {
    const pool = prompts.forPhase(phase, 100, new Set());
    assert.ok(pool.length >= 15, `${phase} has ${pool.length}`);
    assert.ok(pool.every(p => p.source === "bank"));
    const exclude = new Set([pool[0]!.id]);
    assert.ok(prompts.forPhase(phase, 100, exclude).every(p => !exclude.has(p.id)));
  }
  const log = goldenLog1(), meta = meta5("room-g1");
  const signals = services.computeSignals(log, meta), pair = signals.find(s => s.a === "p1" && s.b === "p2")!;
  assert.ok(Math.abs(pair.pairScore - (0.3 * 2/3 + 0.2 * 0.5 + 0.2 * 4/6 + 0.15 * 13/14 + 0.15 * 11/12)) < 1e-10);
  const results = services.computeResults(signals, log, meta), digest = services.buildNightDigest(log, meta);
  assert.deepEqual(results.claims.find(c => c.type === "consensus")?.numbers, { votes: 4, of: 5, share: 0.8 });
  const pub = { ...results, claims: results.claims.filter(c => c.audience === "public") };
  const slides = services.buildSkeleton(pub, digest, meta);
  assert.ok(slides.length > 5);
  assert.ok(slides.every(s => !s.claimId?.startsWith("spark-")));
  const written = await services.writeFinale(slides, new Map(), pub, digest, meta);
  assert.equal(written.slides.length, slides.length);
  prompts.dispose?.();
});

test("integrated Grok narrator spends exactly one reveal slot on structured pseudonyms", async () => {
  const fetch = mockFetch(() => grokReply(JSON.stringify({ slides: [], secretCards: [] })));
  const provider = new Provider({ env: {}, xaiApiKey: "test-only", fetchImpl: fetch.fetchImpl, guard: new CallGuard() });
  const services = createIntegratedServices(provider);
  const log = goldenLog1(), meta = meta5("grok-reveal-room"), signals = services.computeSignals(log, meta);
  const results = services.computeResults(signals, log, meta), digest = services.buildNightDigest(log, meta);
  const slides = services.buildSkeleton({ ...results, claims: results.claims.filter(c => c.audience === "public") }, digest, meta);
  const copy = await services.writeFinale(slides, new Map(), results, digest, meta);
  assert.equal(copy.slides.length, slides.length);
  assert.equal(fetch.calls.length, 1);
  assert.equal(provider.guard.snapshot("grok-reveal-room").byPurpose.reveal, 1);
  assert.deepEqual(fetch.calls[0]!.body["response_format"], { type: "json_object" });
});

test("five-player hand-verification fixture includes a guarded joker", () => {
  const services = offline(), meta = meta5("room-g1"), log = goldenLog1();
  for (let n = 0; n < 5; n++) {
    for (const [playerId, target] of [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p3"], ["p5", "p1"]]) {
      const base = log.find(r => r.playerId === playerId && r.value.kind === "pick")!;
      log.push({ ...base, roundId: `joker-${n}`, promptId: `joker-${n}`, coding: "friction", at: 50000 + n, value: { kind: "pick", target } });
    }
  }
  const p5 = log.filter(r => r.playerId === "p5" && r.value.kind === "pick");
  assert.equal(p5.length, 10);
  assert.equal(p5.filter(r => r.value.kind === "pick" && r.value.target === "p1").length, 8);
  const signals = services.computeSignals(log, meta), results = services.computeResults(signals, log, meta);
  assert.ok(Math.abs(signals.find(s => s.a === "p1" && s.b === "p2")!.pairScore - 0.7101190476190476) < 1e-10);
  assert.deepEqual(results.claims.find(c => c.id === "consensus-C2-p1")?.numbers, { votes: 4, of: 5, share: 0.8 });
  assert.deepEqual(results.claims.find(c => c.id === "blindspot-p3-loyalty")?.numbers, { self: 5, groupMean: 8.25, spread: 1, gap: 3.25, raters: 4 });
  assert.ok(!results.claims.some(c => c.type === "toxic" && c.subjects.includes("p1") && c.confidence === "high"));
});

test("mock Grok lobby work is nonblocking, per-room budgeted, and falls back on refusal", async () => {
  const fetch = mockFetch(() => grokReply(JSON.stringify([candidate()])));
  const provider = new Provider({ env: {}, xaiApiKey: "test-only", fetchImpl: fetch.fetchImpl, guard: new CallGuard() });
  const services = createIntegratedServices(provider), p = services.createPromptProvider("grok-room");
  const preparation = p.prepare!({ playerCount: 4, usedIds: [], digest: empty });
  assert.ok(p.forPhase("warmup", 100, new Set()).some(q => q.source === "bank"));
  await preparation;
  assert.equal(fetch.calls.length, 4);
  assert.equal(provider.guard.count("grok-room"), 4);
  assert.ok((["warmup", "spicy", "deep", "dare"] as const).some(phase => p.forPhase(phase, 100, new Set()).some(q => q.source === "grok")));
  p.dispose?.(); assert.equal(provider.guard.count("grok-room"), 0);
  const refusedFetch = mockFetch(() => ({ status: 403, text: "blocked by content policy" }));
  const refused = createIntegratedServices(new Provider({ env: {}, xaiApiKey: "test-only", fetchImpl: refusedFetch.fetchImpl, guard: new CallGuard() })).createPromptProvider("refusal");
  await refused.prepare!({ playerCount: 4, usedIds: [], digest: empty });
  assert.ok(refused.forPhase("spicy", 100, new Set()).some(q => q.source === "bank"));
  refused.dispose?.();
});

test("integrated no-key server completes a game on the production adapters", { timeout: 12000 }, async t => {
  const dataDir = mkdtempSync(join(tmpdir(), "reveal-integrated-"));
  const services = offline();
  const server = createGameServer({ dataDir, services, botDelayMs: [2, 5], revealHoldMs: 2, interludeHoldMs: 2 });
  const port = await server.listen(0, "127.0.0.1", false);
  const socket = io(`http://127.0.0.1:${port}`, { reconnection: false });
  t.after(async () => { socket.disconnect(); await server.close(); rmSync(dataDir, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("connect_error", reject); });
  const created = await socket.timeout(2000).emitWithAck("create", { alias: "Host", consent: { age: true, terms: true, revealOptIn: true }, profile: { age: 28, relationship: "single", partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" } });
  assert.equal(created.ok, true);
  for (let i = 0; i < 3; i++) socket.emit("add_bot");
  const seen = new Set<string>();
  const finale = new Promise<any>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("finale timeout")), 10000); socket.once("finale", value => { clearTimeout(timer); resolve(value); }); });
  socket.on("round", (round: RoundView) => {
    if (round.youSubmitted || seen.has(round.roundId) || (round.onlyPlayers && !round.onlyPlayers.includes(created.you))) return;
    seen.add(round.roundId);
    let value: ResponseValue;
    switch (round.kind) {
      case "pick": value = { kind: "pick", target: "p2" }; break;
      case "shout": value = { kind: "shout", word: "chaos" }; break;
      case "text": value = { kind: "text", text: "Someone here made the whole evening memorable." }; break;
      case "debrief": value = { kind: "text", text: "We had a great conversation together tonight." }; break;
      case "rating": value = { kind: "rating", trait: round.trait!, about: round.about!, value: 7 }; break;
      case "ios": value = { kind: "ios", about: round.about!, value: 5 }; break;
      case "minigame": value = { kind: "minigame", score: 20 }; break;
      case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
    }
    socket.emit("submit", { roundId: round.roundId, clientUuid: `integrated-${round.roundId}`, value }, () => {});
  });
  socket.emit("start");
  const result = await finale;
  assert.ok(result.slides.length > 5);
  assert.ok(seen.size >= 12);
  assert.ok(!JSON.stringify(result).includes("We had a great conversation together tonight."), "private debrief must not appear verbatim in finale");
});
