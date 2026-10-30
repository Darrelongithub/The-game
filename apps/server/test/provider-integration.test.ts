import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { io, type Socket } from "socket.io-client";
import { MAX_PROVIDER_CALLS_PER_NIGHT, type ClientToServerEvents, type FinaleView, type LogRecord, type ResponseValue, type RoomMeta, type RoundView, type ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { createGameServer } from "../src/server.ts";
import { integratedServices } from "../src/integratedServices.ts";
import { logRecordId } from "../../../packages/engine/src/index.ts";
import type { GameServices } from "../src/services.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const limit = <T>(promise: Promise<T>, ms = 8000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const once = <T>(socket: Client, event: string): Promise<T> => new Promise((resolve) => (socket as any).once(event, resolve));

async function setup(t: TestContext, fakeFetch: typeof fetch, services?: GameServices) {
  const oldXai = process.env.XAI_API_KEY, oldGemini = process.env.GEMINI_API_KEY, oldFetch = globalThis.fetch;
  process.env.XAI_API_KEY = "synthetic-xai-key"; process.env.GEMINI_API_KEY = "synthetic-gemini-key";
  globalThis.fetch = fakeFetch;
  const dir = mkdtempSync(join(tmpdir(), "reveal-provider-test-"));
  const server = createGameServer({ dataDir: dir, botDelayMs: [2, 5], revealHoldMs: 2, interludeHoldMs: 2, graceMs: 0,
    roundTimers: { spotlight: 300, verdict: 300 }, verdictDiscussMs: 0, services });
  const port = await server.listen(0, "127.0.0.1", false);
  const clients: Client[] = [];
  t.after(async () => {
    clients.forEach((s) => s.disconnect()); await server.close(); rmSync(dir, { recursive: true, force: true });
    globalThis.fetch = oldFetch;
    if (oldXai === undefined) delete process.env.XAI_API_KEY; else process.env.XAI_API_KEY = oldXai;
    if (oldGemini === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldGemini;
  });
  const connect = async () => {
    const socket: Client = io(`http://127.0.0.1:${port}`, { forceNew: true, reconnection: false, autoConnect: false });
    clients.push(socket); socket.on("error", () => {});
    const ready = once<void>(socket, "connect"); socket.connect(); await limit(ready); return socket;
  };
  return { connect, dir, server };
}
const create = (socket: Client, alias: string): Promise<any> => new Promise((resolve) => socket.emit("create", { alias, consent, profile }, resolve));
const joinRoom = (socket: Client, roomCode: string, alias: string): Promise<any> => new Promise((resolve) => socket.emit("join", { roomCode, alias, consent, profile }, resolve));

// These are entirely synthetic fixtures and fake HTTP responses. No request is
// ever sent to an external endpoint by this file.
test("real integration filters generated prompts and sends only pseudonymous public material to narration", { timeout: 15000 }, async (t) => {
  const calls: { url: string; body: string }[] = [];
  let generated!: () => void;
  const allGenerated = new Promise<void>((resolve) => { generated = resolve; });
  const candidate = "Who here would laugh first during a serious group photo? Point at them.";
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input), body = String(init?.body ?? ""); calls.push({ url, body });
    if (url.includes("x.ai")) {
      const xaiCalls = calls.filter((call) => call.url.includes("x.ai")).length;
      if (xaiCalls === 4) generated();
      if (xaiCalls > 4) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ slides: [], secretCards: [] }) } }] }), { status: 200 });
      const choices = [
        { text: "Who here would shoplift something for the group? Point at them.", kind: "pick", coding: "friction", measures: ["social risk"], asksTarget: true },
        { text: candidate, kind: "pick", coding: "friction", measures: ["social risk"], asksTarget: true },
      ];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(choices) } }] }), { status: 200 });
    }
    const request = JSON.parse(body) as { contents: { parts: { text: string }[] }[] };
    const payload = JSON.parse(request.contents[0]!.parts[0]!.text) as { slides?: unknown[]; secretCards?: unknown[]; lines?: { i: number; text: string }[]; night?: { publicToneHint?: string } };
    if (payload.lines) {
      const tags = payload.lines.map(({ i }) => ({ i, tags: ["contempt", "admiration"] }));
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(tags) }] } }] }), { status: 200 });
    }
    assert.deepEqual(payload.secretCards, [], "public narrator must never receive private decks");
    assert.equal(payload.night?.publicToneHint, "warm", "completed public tags can suggest a bounded narration style");
    const bad = { slides: payload.slides!.map((_, i) => i === 0
      ? { i, title: "Alice.*", body: "A quiet opening." }
      : { i, title: "INVENTED 999999", body: "Alice.* invented 999999 facts." }), cards: [] };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(bad) }] } }] }), { status: 200 });
  };
  let observedTags: { public: (string[] | undefined)[]; private: (string[] | undefined)[] } | undefined;
  const services: GameServices = {
    ...integratedServices,
    computeResults(signals, log, meta, provider) {
      const text = log.filter((record) => record.value.kind === "text");
      observedTags = {
        public: text.filter((record) => record.roundKind !== "debrief").map((record) => provider?.tagsFor?.(logRecordId(record))),
        private: text.filter((record) => record.roundKind === "debrief").map((record) => provider?.tagsFor?.(logRecordId(record))),
      };
      return integratedServices.computeResults(signals, log, meta, provider);
    },
  };
  const { connect, dir } = await setup(t, fakeFetch, services);
  const clients = await Promise.all([connect(), connect(), connect(), connect()]);
  const aliases = ["Alice.*", "Brian", "Chao", "Zoë"];
  const first = await create(clients[0]!, aliases[0]!);
  const replies = [first];
  for (let i = 1; i < clients.length; i++) replies.push(await joinRoom(clients[i]!, first.code, aliases[i]!));
  assert.ok(replies.every((reply) => reply.ok));
  await limit(allGenerated);
  // Let the mocked response bodies finish parsing before the phase selects.
  await new Promise((resolve) => setTimeout(resolve, 25));
  const ids = replies.map((reply) => reply.you as string);
  const errors: string[] = [], seen = clients.map(() => new Set<string>()), rounds: RoundView[] = [];
  const finales = clients.map((client) => once<FinaleView>(client, "finale"));
  for (let i = 0; i < clients.length; i++) {
    clients[i]!.on("round", (round: RoundView) => {
      if (i === 0) rounds.push(round);
      if (round.youSubmitted || round.expectsAnswer === false || seen[i]!.has(round.roundId) || (round.onlyPlayers && !round.onlyPlayers.includes(ids[i]!))) return;
      seen[i]!.add(round.roundId);
      const target = ids[(i + 1) % ids.length]!;
      let value: ResponseValue;
      switch (round.kind) {
        case "pick": value = { kind: "pick", target }; break;
        case "shout": value = { kind: "shout", word: "vibes" }; break;
        case "text": value = { kind: "text", text: "Alice.* and Zoe\u0308 make the whole group laugh during dinner." }; break;
        case "debrief": value = { kind: "text", text: `PRIVATE_DEBRIEF_${i} Alice.* discussed a secret.` }; break;
        case "rating": value = { kind: "rating", trait: round.trait!, about: round.about!, value: 7 }; break;
        case "ios": value = { kind: "ios", about: round.about!, value: 5 }; break;
        case "minigame": value = { kind: "minigame", score: 23 }; break;
        case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
        case "spotlight": value = { kind: "text", text: "Alice.* is enjoying this synthetic moment." }; break;
        case "verdict": value = { kind: "pick", target }; break;
      }
      const submit = () => clients[i]!.emit("submit", { roundId: round.roundId, clientUuid: `synthetic-${i}-${round.roundId}`, value }, (result) => { if (!result.ok) errors.push(result.error ?? "submission rejected"); });
      // Give the synthetic, immediate tag response time to finish while the
      // pair is answering. No actual provider call is made by this test.
      if (round.kind === "debrief") setTimeout(submit, 25); else submit();
    });
  }
  clients[0]!.emit("start");
  const views = await limit(Promise.all(finales), 10000);
  assert.deepEqual(errors, []);
  assert.equal(rounds[0]!.promptText, candidate, "validated generated prompts augment the bank");
  assert.ok(rounds.every((round) => !round.promptText.includes("shoplift")), "hard-blocked model output never reaches a phone");
  assert.equal(calls.filter((call) => call.url.includes("x.ai")).length, 5, "four prompt-generation requests plus one Grok reveal request");
  assert.equal(calls.filter((call) => call.url.includes("generativelanguage")).length, 1, "Gemini is used only for the public tag batch, never finale narration");
  assert.ok(observedTags && observedTags.public.length > 0 && observedTags.public.every((tags) => tags?.includes("contempt")), "completed public classification is available without affecting scores");
  assert.ok(observedTags.private.length > 0 && observedTags.private.every((tags) => tags === undefined), "private debriefs are never sent for classification");
  for (const { body } of calls) {
    for (const alias of aliases) assert.ok(!body.normalize("NFC").toLowerCase().includes(alias.normalize("NFC").toLowerCase()), `alias ${alias} leaked to provider payload ${body.slice(0, 1200)}`);
    assert.ok(!body.includes("PRIVATE_DEBRIEF_"), "private debrief must not reach the public narrator");
  }
  assert.ok(!JSON.stringify(views).includes("PRIVATE_DEBRIEF_"));
  assert.ok(!JSON.stringify(views).includes("999999"), "invented provider facts must be rejected");
  assert.notEqual(views[0]!.slides[0]!.title, "Alice.*", "provider copy may not introduce a real alias");
  const raw = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8");
  assert.ok(raw.includes("PRIVATE_DEBRIEF_"), "the privacy assertion exercises a real debrief fixture");
});

test("HTTP retries count toward each room's physical call cap", { timeout: 15000 }, async (t) => {
  const urls: string[] = [];
  let notify!: () => void;
  let changed = new Promise<void>((resolve) => { notify = resolve; });
  const fakeFetch: typeof fetch = async (input) => {
    urls.push(String(input)); notify();
    changed = new Promise<void>((resolve) => { notify = resolve; });
    return new Response("invalid schema", { status: 400 });
  };
  const { connect } = await setup(t, fakeFetch);
  const host = await connect(); await create(host, "Host");
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  while (urls.length < MAX_PROVIDER_CALLS_PER_NIGHT) await limit(changed);
  const done = once<FinaleView>(host, "finale");
  host.on("round", () => host.emit("skip_round"));
  host.on("reveal", () => host.emit("skip_round"));
  host.on("interlude", () => host.emit("skip_round"));
  host.emit("start"); await limit(done);
  assert.equal(urls.length, MAX_PROVIDER_CALLS_PER_NIGHT, "narration must not exceed the cap after generation retries");
  const deleted = once<void>(host, "deleted"); host.emit("delete_room"); await limit(deleted);
  await create(host, "Other Host");
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  while (urls.length < 2 * MAX_PROVIDER_CALLS_PER_NIGHT) await limit(changed);
  assert.equal(urls.length, 2 * MAX_PROVIDER_CALLS_PER_NIGHT, "a new room gets its own budget");
});

test("provider classifications cannot change deterministic numeric scores", () => {
  const meta: RoomMeta = { roomId: "score", players: [1, 2, 3, 4].map((i) => ({ id: `p${i}`, alias: `Player ${i}` })), revealOptIn: [] };
  const log: LogRecord[] = [];
  const add = (playerId: string, roundId: string, coding: LogRecord["coding"], value: LogRecord["value"]) =>
    log.push({ roomId: meta.roomId, playerId, roundId, roundKind: value.kind, promptId: roundId, coding, value, at: log.length + 1, latencyMs: 1 });
  for (const player of ["p1", "p2", "p3"]) add(player, "friction", "friction", { kind: "pick", target: "p4" });
  for (const [player, target] of [["p1", "p2"], ["p2", "p3"], ["p3", "p1"], ["p4", "p1"]] as const)
    add(player, "friendship", "friendship", { kind: "pick", target });
  add("p4", "text", "trust", { kind: "text", text: "Everyone was helpful tonight." });
  const signals = integratedServices.computeSignals(log, meta);
  const local = integratedServices.computeResults(signals, log, meta);
  const provider = { tagsFor: () => ["contempt"] } as never;
  const withProvider = integratedServices.computeResults(signals, log, meta, provider);
  assert.ok(local.claims.some((claim) => claim.type === "toxic"), "fixture exercises a weighted public score");
  assert.deepEqual(withProvider, local, "a model response must not affect scores or claims");
});

test("pending public tagging never blocks scoring and is cancelled on disposal", async (t) => {
  const oldKey = process.env.GEMINI_API_KEY, oldFetch = globalThis.fetch;
  process.env.GEMINI_API_KEY = "synthetic-key";
  let started!: () => void, aborted = false, body = "";
  const ready = new Promise<void>((resolve) => { started = resolve; });
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    body = String(init?.body ?? ""); started();
    init?.signal?.addEventListener("abort", () => { aborted = true; reject(Object.assign(new Error("aborted"), { name: "AbortError" })); }, { once: true });
  });
  t.after(() => { globalThis.fetch = oldFetch; if (oldKey === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = oldKey; });
  const provider = integratedServices.createPromptProvider({ roomId: "synthetic-analysis" });
  const meta: RoomMeta = { roomId: "synthetic-analysis", players: [1, 2, 3, 4].map((n) => ({ id: `p${n}`, alias: `Player ${n}` })), revealOptIn: ["p1", "p2", "p3", "p4"] };
  const base: LogRecord = { at: 1, roomId: meta.roomId, roundId: "public", promptId: "p", roundKind: "text", coding: "trust", playerId: "p1", value: { kind: "text", text: "A completely synthetic public answer." }, latencyMs: 1 };
  const log: LogRecord[] = [base,
    { ...base, roundId: "private", roundKind: "debrief", value: { kind: "text", text: "PRIVATE_DEBRIEF_MARKER" } },
    { ...base, roundId: "cover", roundKind: "spotlight", decoy: true, value: { kind: "text", text: "COVER_ANSWER_MARKER" } },
  ];
  const pending = provider.prepareAnalysis!(log);
  await limit(ready);
  assert.ok(!body.includes("PRIVATE_DEBRIEF_MARKER"));
  assert.ok(!body.includes("COVER_ANSWER_MARKER"), "spotlight cover answers are not sent for classification");
  const signals = integratedServices.computeSignals(log, meta);
  assert.deepEqual(integratedServices.computeResults(signals, log, meta, provider), integratedServices.computeResults(signals, log, meta), "pending network work falls back synchronously");
  provider.dispose!(); await limit(pending);
  assert.equal(aborted, true);
  assert.equal(provider.tagsFor?.(logRecordId(base)), undefined, "disposed results are not retained");
});

test("deleting a room aborts its pending real provider requests", async (t) => {
  let started = 0, aborted = 0;
  let startNotify!: () => void, abortNotify!: () => void;
  const allStarted = new Promise<void>((resolve) => { startNotify = resolve; });
  const allAborted = new Promise<void>((resolve) => { abortNotify = resolve; });
  const fakeFetch: typeof fetch = async (_input, init) => new Promise((_resolve, reject) => {
    if (++started === 4) startNotify();
    init?.signal?.addEventListener("abort", () => {
      if (++aborted === 4) abortNotify();
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
  const { connect, dir } = await setup(t, fakeFetch);
  const host = await connect(); await create(host, "Host");
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  await limit(allStarted);
  const deleted = once<void>(host, "deleted"); host.emit("delete_room"); await limit(deleted); await limit(allAborted);
  assert.deepEqual(readdirSync(dir), []);
  assert.equal(started, 4); assert.equal(aborted, 4);
});
