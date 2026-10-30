import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, FinaleView, LogRecord, ResponseValue, RoomMeta, RoundView, ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { computeResults, computeSignals, updateHypotheses } from "../../../packages/engine/src/index.ts";
import { bankForPhase } from "../../../packages/prompts/src/bank/index.ts";
import { createGameServer } from "../src/server.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const limit = <T>(promise: Promise<T>, ms = 6000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const event = <T>(client: Client, name: string): Promise<T> => new Promise((resolve) => (client as any).once(name, resolve));

test("production defaults use the full bank and deterministic engine in a complete no-key night", { timeout: 12000 }, async (t) => {
  // All fixtures are synthetic and this test must not call any external service.
  const oldXai = process.env.XAI_API_KEY, oldGemini = process.env.GEMINI_API_KEY;
  delete process.env.XAI_API_KEY; delete process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("network access in no-key game"); }) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "reveal-integrated-"));
  const server = createGameServer({ dataDir: dir, botDelayMs: [2, 5], revealHoldMs: 3, interludeHoldMs: 3, graceMs: 0,
    roundTimers: { spotlight: 300, verdict: 300 }, verdictDiscussMs: 0 });
  const port = await server.listen(0, "127.0.0.1", false);
  const host: Client = io(`http://127.0.0.1:${port}`, { reconnection: false, autoConnect: false });
  host.on("error", () => {});
  t.after(async () => {
    host.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    if (oldXai === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = oldXai;
    if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
  });
  const connected = event<void>(host, "connect"); host.connect(); await limit(connected);
  const made = await new Promise<any>((resolve) => host.emit("create", { alias: "Host", consent }, resolve));
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  const first = event<RoundView>(host, "round"), done = event<FinaleView>(host, "finale");
  const seen = new Set<string>(), shown: RoundView[] = [];
  host.on("round", (round: RoundView) => {
    if (!round.youSubmitted && !shown.some((r) => r.roundId === round.roundId)) shown.push(round);
    if (round.youSubmitted || round.expectsAnswer === false || seen.has(round.roundId) || (round.onlyPlayers && !round.onlyPlayers.includes(made.you))) return;
    seen.add(round.roundId);
    let value: ResponseValue;
    switch (round.kind) {
      case "pick": value = { kind: "pick", target: "p2" }; break;
      case "shout": value = { kind: "shout", word: "vibes" }; break;
      case "text": case "debrief": value = { kind: "text", text: "We enjoyed talking together tonight." }; break;
      case "rating": value = { kind: "rating", trait: "warmth", about: "self", value: 7 }; break;
      case "ios": value = { kind: "ios", about: "p2", value: 5 }; break;
      case "minigame": value = { kind: "minigame", score: 23 }; break;
      case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
      case "spotlight": value = { kind: "text", text: "A playful caption for the room." }; break;
      case "verdict": value = { kind: "pick", target: "p2" }; break;
    }
    host.emit("submit", { roundId: round.roundId, clientUuid: `host-${round.roundId}`, value }, () => {});
  });
  host.emit("start");
  const firstRound = await limit(first);
  assert.ok(bankForPhase("warmup").some((prompt) => prompt.text === firstRound.promptText), "default server must use the packaged bank, not the standalone f-w1 fallback");
  const finale = await limit(done);
  const rows: LogRecord[] = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(shown.some((round) => round.phase === "warmup" && round.kind === "text"), "warmup produces a public answer for later callbacks");
  for (const phase of ["spicy", "deep", "dare"] as const) {
    const callback = shown.find((round) => round.phase === phase && round.promptText.includes("\n\nEarlier, someone said: “"));
    assert.ok(callback, `${phase} recalls an earlier public answer`);
    assert.ok(callback.promptText.length <= 160);
    const excerpt = callback.promptText.match(/Earlier, someone said: “([^”]+)”/)?.[1];
    const earlierIds = new Set(shown.slice(0, shown.indexOf(callback)).map((round) => round.roundId));
    const publicTexts = rows.flatMap((record) => earlierIds.has(record.roundId) && record.roundKind === "text" && record.value.kind === "text" ? [record.value.text] : []);
    assert.ok(excerpt && publicTexts.some((text) => text.includes(excerpt)), "callback quotes an earlier public answer verbatim");
  }
  const pickCodings = new Set(rows.filter((r) => r.roundKind === "pick").map((r) => r.coding));
  assert.ok(pickCodings.has("friendship") && pickCodings.has("couple") && (pickCodings.has("friction") || pickCodings.has("rivalry")),
    "a no-key night must be capable of positive, romantic and negative nomination signals");
  assert.ok(rows.some((r) => r.promptId === "w6"), "group-signal bank prompts with asksTarget=false must remain playable");
  assert.ok(rows.some((r) => r.promptId === "dd5"), "the packaged pair dare must not be discarded");
  const meta: RoomMeta = { roomId: rows[0]!.roomId, players: [1, 2, 3, 4].map((i) => ({ id: `p${i}`, alias: `Player ${i}` })), revealOptIn: ["p1", "p2", "p3", "p4"] };
  const signals = computeSignals(rows, meta);
  const expected = computeResults(signals, rows, meta);
  // ROUND 4: the Director's graduated suspicions are deterministic engine
  // output too (re-derived from the log at the finale), so they are legitimate
  // public claims — but nothing else may appear on a slide.
  const graduated = updateHypotheses(signals, rows, meta).claims;
  const publicIds = [...expected.claims, ...graduated].filter((c) => c.audience === "public").map((c) => c.id);
  for (const slide of finale.slides) if (slide.claimId) assert.ok(publicIds.includes(slide.claimId), `not an engine public claim: ${slide.claimId}`);
  assert.ok(!JSON.stringify(finale).includes('"cards"'));
});

test("host custom prompts use the complete hard-block guard", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-custom-"));
  const server = createGameServer({ dataDir: dir });
  const port = await server.listen(0, "127.0.0.1", false);
  const host: Client = io(`http://127.0.0.1:${port}`, { reconnection: false, autoConnect: false });
  host.on("error", () => {});
  t.after(async () => { host.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const connected = event<void>(host, "connect"); host.connect(); await limit(connected);
  await new Promise((resolve) => host.emit("create", { alias: "Host", consent }, resolve));
  const error = event<{ code: string }>(host, "error");
  host.emit("custom_prompts", { lines: ["Who here would shoplift for the group?"] });
  assert.equal((await limit(error, 700)).code, "INVALID_PROMPTS");
});

test("custom prompts cannot silently wrap an out-of-roster placeholder onto another player", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-placeholder-"));
  const server = createGameServer({ dataDir: dir, botDelayMs: [10000, 10000] });
  const port = await server.listen(0, "127.0.0.1", false);
  const host: Client = io(`http://127.0.0.1:${port}`, { reconnection: false, autoConnect: false });
  host.on("error", () => {});
  t.after(async () => { host.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const connected = event<void>(host, "connect"); host.connect(); await limit(connected);
  await new Promise((resolve) => host.emit("create", { alias: "Host", consent }, resolve));
  host.emit("custom_prompts", { lines: ["Who here would trust {P11} with their diary?"] });
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  const first = event<RoundView>(host, "round"); host.emit("start");
  assert.doesNotMatch((await limit(first)).promptText, /their diary/, "a four-player room has no Player 11 to substitute");
});
