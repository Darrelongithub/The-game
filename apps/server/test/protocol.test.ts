import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, InterludeView, JoinReply, ResponseValue, RevealView, RoundView, ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { createGameServer, type ServerOptions } from "../src/server.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const limit = <T>(promise: Promise<T>, ms = 4000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
function event<T>(client: Client, name: string, predicate: (payload: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve) => {
    const handler = (data: T): void => { if (predicate(data)) { (client as any).off(name, handler); resolve(data); } };
    (client as any).on(name, handler);
  });
}
async function setup(t: TestContext, options: ServerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reveal-protocol-"));
  const server = createGameServer({ dataDir: dir, ...options });
  const port = await server.listen(0, "127.0.0.1", false), clients: Client[] = [], base = `http://127.0.0.1:${port}`;
  t.after(async () => { clients.forEach((c) => c.disconnect()); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const connect = async (): Promise<Client> => {
    const client: Client = io(base, { forceNew: true, transports: ["polling", "websocket"], reconnection: false, autoConnect: false });
    clients.push(client); client.on("error", () => {});
    const ready = event<void>(client, "connect"); client.connect(); await limit(ready); return client;
  };
  return { server, connect, dir, base };
}
const create = (client: Client, alias = "Host"): Promise<JoinReply & { code?: string }> => new Promise((resolve) => client.emit("create", { alias, consent }, resolve));
const joinRoom = (client: Client, code: string, alias: string, resume?: {playerId:string; secret:string}): Promise<JoinReply> => new Promise((resolve) => client.emit("join", { roomCode: code, alias, consent, ...(resume ? { resume } : {}) }, resolve));
const submit = (client: Client, roundId: string, value: ResponseValue, clientUuid = "test-uuid"): Promise<{ok:boolean;error?:string}> => new Promise((resolve) => client.emit("submit", { roundId, value, clientUuid }, resolve));
const expectError = async (client: Client, action: () => void, code: string): Promise<void> => { const promise = event<{code:string}>(client, "error"); action(); assert.equal((await limit(promise)).code, code); };

test("validation, host controls, maximum seats, custom prompts and submit idempotency", async (t) => {
  const { connect, dir } = await setup(t, { botDelayMs: [10000, 10000], roundTimers: { pick: 10000, shout: 10000, minigame: 10000, text: 10000, spotlight: 10000, verdict: 10000 }, verdictDiscussMs: 0, graceMs: 1000, revealHoldMs: 10000, interludeHoldMs: 10000 });
  const host = await connect(), guest = await connect(), extra = await connect();
  const underage: JoinReply = await new Promise((resolve) => host.emit("create", { alias: "Host", consent: { ...consent, age: false } }, resolve));
  assert.equal(underage.ok, false);
  assert.equal((await create(host, "x")).ok, false);
  const made = await create(host); assert.ok(made.ok && made.code && made.you);
  assert.equal((await joinRoom(guest, "OOOO", "Guest")).ok, false);
  assert.equal((await joinRoom(extra, made.code!, "Host")).ok, false, "aliases must be unique");
  const joined = await joinRoom(guest, made.code!, "Guest"); assert.ok(joined.ok && joined.you);
  await expectError(guest, () => guest.emit("start"), "HOST_ONLY");
  await expectError(guest, () => guest.emit("add_bot"), "HOST_ONLY");
  await expectError(host, () => host.emit("start"), "PLAYER_COUNT");
  await expectError(host, () => host.emit("custom_prompts", { lines: ["Drink some water"] }), "INVALID_PROMPTS");
  await expectError(host, () => host.emit("custom_prompts", { lines: ["Who killed a historical figure?"] }), "INVALID_PROMPTS");
  await expectError(host, () => host.emit("custom_prompts", { lines: ["Who in this room likes a minor?"] }), "INVALID_PROMPTS");
  await expectError(host, () => host.emit("custom_prompts", { lines: ["Who here would send nudes?"] }), "INVALID_PROMPTS");
  await expectError(host, () => host.emit("custom_prompts", { lines: ["Who here would play two truths and a lie?"] }), "INVALID_PROMPTS");
  await expectError(host, () => host.emit("custom_prompts", { lines: ["Who here knows {P12}?"] }), "INVALID_PROMPTS");
  await expectError(host, () => host.emit("custom_prompts", { lines: ["Who here?\nWho else?"] }), "INVALID_PROMPTS");
  await expectError(host, () => host.emit("custom_prompts", { lines: Array(11).fill("Who here?") }), "INVALID_PROMPTS");
  await expectError(host, () => host.emit("custom_prompts", { lines: ["Who " + "x".repeat(161)] }), "INVALID_PROMPTS");
  host.emit("custom_prompts", { lines: ["spicy: Who here keeps the funniest secrets?"] });
  const full = event<any>(host, "state", (s) => s.players.length === 11);
  for (let i = 0; i < 9; i++) host.emit("add_bot");
  await limit(full);
  assert.equal((await joinRoom(extra, made.code!, "Extra")).ok, false, "12th player is rejected");
  const firstRound = event<RoundView>(host, "round", (r) => !r.youSubmitted);
  host.emit("start"); const round = await limit(firstRound); assert.equal(round.kind, "pick");
  assert.equal((await submit(host, round.roundId, { kind: "pick", target: made.you! }, "self")).ok, false);
  assert.equal((await submit(host, round.roundId, { kind: "pick", target: "nonexistent" }, "unknown")).ok, false);
  assert.equal((await submit(host, round.roundId, { kind: "text", text: "wrong kind" }, "wrong")).ok, false);
  const v: ResponseValue = { kind: "pick", target: joined.you! };
  const untrusted = { ...v, extra: "EXTRANEOUS_PRIVATE_FIELD" } as ResponseValue;
  assert.equal((await submit(host, round.roundId, untrusted, "same-id")).ok, true);
  assert.equal((await submit(host, round.roundId, v, "same-id")).ok, true);
  assert.equal((await submit(host, round.roundId, { kind: "pick", target: "p3" }, "same-id")).ok, false);
  assert.equal((await submit(host, round.roundId, v, "different-id")).ok, false);
  const lines = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("EXTRANEOUS_PRIVATE_FIELD"));
  const spicy = event<RoundView>(host, "round", (r) => r.phase === "spicy");
  host.on("round", (r) => { if (r.phase === "warmup" && !r.youSubmitted) host.emit("skip_round"); });
  host.on("reveal", () => host.emit("skip_round"));
  host.on("interlude", () => host.emit("skip_round"));
  host.emit("skip_round");
  assert.match((await limit(spicy)).promptText, /funniest secrets/);
});

test("timer honors grace, skip advances, and reconnect restores the personalized submitted snapshot", async (t) => {
  const { connect } = await setup(t, { roundTimers: { pick: 90, shout: 5000, spotlight: 90, verdict: 90 }, verdictDiscussMs: 0, graceMs: 90, revealHoldMs: 5000, interludeHoldMs: 5000 });
  const clients = await Promise.all([connect(), connect(), connect(), connect()]);
  const made = await create(clients[0]!); const replies = [made];
  for (let i = 1; i < clients.length; i++) replies.push(await joinRoom(clients[i]!, made.code!, `Guest${i}`));
  assert.ok(replies.every((r) => r.ok));
  const firstPromise = event<RoundView>(clients[0]!, "round");
  let early = false; clients[0]!.on("reveal", () => { early = true; });
  const revealPromise = event<RevealView>(clients[0]!, "reveal");
  clients[0]!.emit("start"); const first = await limit(firstPromise);
  await wait(120); assert.equal(early, false, "timer alone must not close before grace");
  const reveal = await limit(revealPromise); assert.equal(reveal.roundId, first.roundId);
  assert.ok(Date.now() >= first.closesAt + 90 - 15, "grace elapsed");
  const secondPromise = event<RoundView>(clients[0]!, "round", (r) => r.index === 2);
  clients[0]!.emit("skip_round");
  const second = await limit(secondPromise); assert.equal(second.kind, "shout");
  assert.equal((await submit(clients[3]!, second.roundId, { kind: "shout", word: "vibes" }, "guest3")).ok, true);
  clients[3]!.disconnect();
  const resumed = await connect();
  const reconnect = await joinRoom(resumed, made.code!, "Guest3", { playerId: replies[3]!.you!, secret: replies[3]!.secret! });
  assert.ok(reconnect.ok && reconnect.secret !== replies[3]!.secret);
  assert.equal(reconnect.state?.round?.roundId, second.roundId);
  assert.equal(reconnect.state?.round?.youSubmitted, true);
  assert.ok((reconnect.state?.seq ?? 0) > (made.state?.seq ?? 0));
  const replay = await connect();
  assert.equal((await joinRoom(replay, made.code!, "Guest3", { playerId: replies[3]!.you!, secret: replies[3]!.secret! })).ok, false);
  const secondReveal = event<RevealView>(clients[0]!, "reveal", (r) => r.roundId === second.roundId);
  assert.equal((await submit(clients[0]!, first.roundId, { kind: "pick", target: replies[1]!.you! }, "stale")).ok, false);
  clients[2]!.disconnect(); // an unanswered disconnected player cannot hold the phase hostage
  for (const i of [0, 1]) assert.equal((await submit(clients[i]!, second.roundId, { kind: "shout", word: "vibes" }, `guest-${i}`)).ok, true);
  assert.ok((await limit(secondReveal)).items?.[0]?.text.includes("vibes"));
});

test("majority heat-down lowers exactly one level; repeated votes do not count twice", async (t) => {
  const { connect } = await setup(t, { roundTimers: { pick: 10000, shout: 10000, minigame: 10000, spotlight: 10000, verdict: 10000 }, verdictDiscussMs: 0, graceMs: 1000, revealHoldMs: 10000, interludeHoldMs: 10000 });
  const clients = await Promise.all(Array.from({length:5}, () => connect()));
  const made = await create(clients[0]!);
  for (let i = 1; i < clients.length; i++) assert.ok((await joinRoom(clients[i]!, made.code!, `Guest${i}`)).ok);
  let reachedSpicy = false;
  const spicy = event<RoundView>(clients[0]!, "round", (r) => r.phase === "spicy");
  clients[0]!.on("round", (r) => { if (r.phase === "spicy") reachedSpicy = true; if (r.phase === "warmup" && !reachedSpicy) clients[0]!.emit("skip_round"); });
  clients[0]!.on("reveal", () => { if (!reachedSpicy) clients[0]!.emit("skip_round"); });
  clients[0]!.on("interlude", () => { if (!reachedSpicy) clients[0]!.emit("skip_round"); });
  clients[0]!.emit("start"); assert.equal((await limit(spicy)).phase, "spicy");
  let cooling = false;
  clients[0]!.on("interlude", (v) => { if (v.headline === "Cooling things down") cooling = true; });
  clients[0]!.emit("vote_heat_down"); clients[0]!.emit("vote_heat_down"); clients[1]!.emit("vote_heat_down");
  await wait(40); assert.equal(cooling, false);
  const reveal = event<RevealView>(clients[0]!, "reveal");
  clients[2]!.emit("vote_heat_down"); await limit(reveal);
  const cool = event<InterludeView>(clients[0]!, "interlude", (v) => v.headline === "Cooling things down");
  clients[0]!.emit("skip_round"); assert.equal((await limit(cool)).headline, "Cooling things down");
  const warmup = event<RoundView>(clients[0]!, "round", (r) => r.phase === "warmup");
  clients[0]!.emit("skip_round"); assert.equal((await limit(warmup)).phase, "warmup");
});

test("dare pass requires a bounded nonblank reason, including for the direct dare_pass event", async (t) => {
  const { connect, dir } = await setup(t, { botDelayMs: [10000, 10000], revealHoldMs: 10000, interludeHoldMs: 10000 });
  const host = await connect(), made = await create(host); assert.ok(made.ok);
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  const dare = event<RoundView>(host, "round", (r) => r.kind === "dare");
  host.on("round", (r) => { if (r.kind !== "dare" && !r.youSubmitted) host.emit("skip_round"); });
  host.on("reveal", () => host.emit("skip_round")); host.on("interlude", () => host.emit("skip_round"));
  host.emit("start"); const current = await limit(dare);
  await expectError(host, () => host.emit("dare_pass", { roundId: current.roundId, reason: "   " }), "INVALID_PASS");
  await expectError(host, () => host.emit("dare_pass", { roundId: current.roundId, reason: "x".repeat(141) }), "INVALID_PASS");
  assert.equal((await submit(host, current.roundId, {kind:"dare",status:"passed"}, "bad")).ok, false);
  const accepted = event<RoundView>(host, "round", (r) => r.roundId === current.roundId && r.youSubmitted);
  host.emit("dare_pass", { roundId: current.roundId, reason: "My ankle needs a break." }); await limit(accepted);
  const rows = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(rows.length, 1); assert.equal(rows[0].value.reason, "My ankle needs a break.");
});

test("hourly purge rules delete expired rooms and orphan files, not unrelated files", async (t) => {
  let now = Date.now();
  const { connect, dir, server } = await setup(t, { now: () => now });
  const host = await connect(), made = await create(host); assert.ok(made.ok);
  const stale = join(dir, `${now - 49 * 3600000}-${"a".repeat(32)}.jsonl`);
  const unrelated = join(dir, "my-notes.jsonl"); writeFileSync(stale, "old"); writeFileSync(unrelated, "keep");
  utimesSync(stale, new Date(now - 49 * 3600000), new Date(now - 49 * 3600000));
  const deleted = event<void>(host, "deleted"); now += 25 * 3600000; server.rooms.purge();
  await limit(deleted); assert.deepEqual(readdirSync(dir), ["my-notes.jsonl"]);
});
