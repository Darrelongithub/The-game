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
const profile = { age: 28, relationship: "single", partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" } as const;
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
  const server = createGameServer({ revealMode: "round", dataDir: dir, revealHoldMs: 5, interludeHoldMs: 5, ...options });
  const port = await server.listen(0, "127.0.0.1", false), clients: Client[] = [], base = `http://127.0.0.1:${port}`;
  t.after(async () => { clients.forEach((c) => c.disconnect()); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const connect = async (): Promise<Client> => {
    const client: Client = io(base, { forceNew: true, transports: ["polling", "websocket"], reconnection: false, autoConnect: false });
    clients.push(client); client.on("error", () => {});
    client.on("state", (view) => { if (view.ready) client.emit("ready"); });
    const ready = event<void>(client, "connect"); client.connect(); await limit(ready); return client;
  };
  return { server, connect, dir, base };
}
const create = (client: Client, alias = "Host"): Promise<JoinReply & { code?: string }> => new Promise((resolve) => client.emit("create", { alias, consent, profile }, resolve));
const joinRoom = (client: Client, code: string, alias: string, resume?: {playerId:string; secret:string}): Promise<JoinReply> => new Promise((resolve) => client.emit("join", { roomCode: code, alias, consent, profile, ...(resume ? { resume } : {}) }, resolve));
const submit = (client: Client, roundId: string, value: ResponseValue, clientUuid = "test-uuid"): Promise<{ok:boolean;error?:string}> => new Promise((resolve) => client.emit("submit", { roundId, value, clientUuid }, resolve));
const expectError = async (client: Client, action: () => void, code: string): Promise<void> => { const promise = event<{code:string}>(client, "error"); action(); assert.equal((await limit(promise)).code, code); };

test("validation, host controls, maximum seats, custom prompts and submit idempotency", async (t) => {
  const { connect, dir } = await setup(t, { botDelayMs: [10000, 10000], roundTimers: { pick: 10000, shout: 10000, minigame: 10000, text: 10000, spotlight: 10000, verdict: 10000, confess: 400 }, verdictDiscussMs: 0, graceMs: 1000, revealHoldMs: 10000, interludeHoldMs: 10000 });
  const host = await connect(), guest = await connect(), extra = await connect();
  const underage: JoinReply = await new Promise((resolve) => host.emit("create", { alias: "Host", consent: { ...consent, age: false }, profile }, resolve));
  assert.equal(underage.ok, false);
  const missingProfile = await new Promise<JoinReply>((resolve) => (host as any).emit("create", { alias: "Host", consent }, resolve));
  assert.equal(missingProfile.ok, false, "creation requires all profile answers");
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
  assert.equal((await submit(host, round.roundId, { kind: "pick", target: "nonexistent" }, "unknown")).ok, false);
  assert.equal((await submit(host, round.roundId, { kind: "text", text: "wrong kind" }, "wrong")).ok, false);
  const v: ResponseValue = { kind: "pick", target: joined.you! };
  const untrusted = { ...v, extra: "EXTRANEOUS_PRIVATE_FIELD" } as ResponseValue;
  assert.equal((await submit(host, round.roundId, untrusted, "same-id")).ok, true);
  assert.equal((await submit(host, round.roundId, v, "same-id")).ok, true);
  assert.equal((await submit(host, round.roundId, { kind: "pick", target: "p3" }, "same-id")).ok, false);
  assert.equal((await submit(host, round.roundId, v, "different-id")).ok, false);
  const lines = readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith(".jsonl"))!), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]!.includes("EXTRANEOUS_PRIVATE_FIELD"));
  const spicy = event<RoundView>(host, "round", (r) => r.phase === "spicy");
  host.on("round", (r) => { if (r.phase === "warmup" && !r.youSubmitted) host.emit("skip_round"); });
  host.on("reveal", () => host.emit("skip_round"));
  host.on("interlude", () => host.emit("skip_round"));
  host.emit("skip_round");
  assert.match((await limit(spicy)).promptText, /funniest secrets/);
});


test("rating rounds assign every phone a non-self subject and trait without dropdown selection", async (t) => {
  const { connect } = await setup(t, { roundTimers: { pick: 10000, shout: 10000, minigame: 10000, rating: 10000 }, graceMs: 1000 });
  const clients = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const made = await create(clients[0]!); const replies = [made];
  for (let i = 1; i < clients.length; i++) replies.push(await joinRoom(clients[i]!, made.code!, `Rater${i}`));
  const observations = clients.map(c => event<RoundView>(c, "round", r => r.kind === "rating"));
  clients[0]!.on("round", r => { if (r.kind !== "rating") clients[0]!.emit("skip_round"); });
  clients[0]!.on("interlude", () => clients[0]!.emit("skip_round"));
  clients[0]!.emit("start");
  const rounds = await Promise.all(observations);
  for (let i = 0; i < rounds.length; i++) {
    assert.equal(rounds[i]!.roundId, rounds[0]!.roundId);
    assert.ok(rounds[i]!.about, "server must assign subject");
    assert.notEqual(rounds[i]!.about, replies[i]!.you, "subject must not be self");
    assert.ok(rounds[i]!.trait, "server must assign trait");
  }
});

test("IOS rounds assign each phone a non-self subject", async (t) => {
  const { connect } = await setup(t, { roundTimers: { pick: 10000, shout: 10000, minigame: 10000, rating: 10000, ios: 10000 }, graceMs: 1000 });
  const clients = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const made = await create(clients[0]!); const replies = [made];
  for (let i = 1; i < clients.length; i++) replies.push(await joinRoom(clients[i]!, made.code!, `IOS${i}`));
  const observations = clients.map(c => event<RoundView>(c, "round", r => r.kind === "ios"));
  clients[0]!.on("round", r => { if (r.kind !== "ios") clients[0]!.emit("skip_round"); });
  clients[0]!.on("interlude", () => clients[0]!.emit("skip_round"));
  clients[0]!.emit("start");
  const rounds = await Promise.all(observations);
  for (let i = 0; i < rounds.length; i++) {
    assert.equal(rounds[i]!.roundId, rounds[0]!.roundId);
    assert.ok(rounds[i]!.about, "server must assign an IOS subject");
    assert.notEqual(rounds[i]!.about, replies[i]!.you, "IOS subject must not be self");
  }
});

test("solo dare has one rotating performer; pair dare is shared and records both pass reasons", async (t) => {
  const { connect, dir } = await setup(t, { roundTimers: { dare: 10000, pair_dare: 10000 }, graceMs: 1000, revealHoldMs: 5, interludeHoldMs: 5 });
  const clients = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const made = await create(clients[0]!); const replies = [made];
  for (let i = 1; i < clients.length; i++) replies.push(await joinRoom(clients[i]!, made.code!, `Dare${i}`));
  const firstDareEvents = clients.map(c => event<RoundView>(c, "round", r => r.kind === "dare"));
  clients[0]!.on("round", r => { if (r.kind !== "dare" && r.kind !== "pair_dare") clients[0]!.emit("skip_round"); });
  clients[0]!.on("interlude", () => clients[0]!.emit("skip_round"));
  clients[0]!.emit("start");
  const dareViews = await Promise.all(firstDareEvents);
  const solo = dareViews[0]!;
  assert.ok(solo.performer);
  assert.deepEqual(solo.onlyPlayers, [solo.performer]);
  for (let i = 0; i < dareViews.length; i++) {
    assert.equal(dareViews[i]!.performer, solo.performer);
    const performerIndex = replies.findIndex(r => r.you === solo.performer);
    const performerAlias = performerIndex === 0 ? "Host" : `Dare${performerIndex}`;
    assert.ok(!solo.promptText.toLocaleLowerCase().includes(performerAlias.toLocaleLowerCase()), "dare copy must not name its performer");
  }
  const nonPerformer = replies.findIndex(r => r.you !== solo.performer);
  assert.equal((await submit(clients[nonPerformer]!, solo.roundId, { kind: "dare", status: "done" }, "spectator-dare")).ok, false);
  const secondDareEvents = clients.map(c => event<RoundView>(c, "round", r => r.kind === "dare" && r.roundId !== solo.roundId));
  const pairEvents = clients.map(c => event<RoundView>(c, "round", r => r.kind === "pair_dare"));
  clients[0]!.on("round", r => { if (r.kind === "dare" && r.roundId !== solo.roundId) clients[0]!.emit("skip_round"); });
  assert.equal((await submit(clients[replies.findIndex(r => r.you === solo.performer)]!, solo.roundId, { kind: "dare", status: "done" }, "performer-done")).ok, true);
  const secondDare = await Promise.all(secondDareEvents);
  assert.notEqual(secondDare[0]!.performer, solo.performer, "successive dare turns rotate the performer fairly");
  const pairViews = await Promise.all(pairEvents);
  const pair = pairViews[0]!;
  assert.ok(pair.onlyPlayers && pair.onlyPlayers.length === 2);
  assert.ok(pair.promptText.startsWith("You two:"));
  for (const id of pair.onlyPlayers!) {
    const index = replies.findIndex(r => r.you === id);
    assert.equal(pairViews[index]!.promptText, pair.promptText, "both participants receive identical instructions");
    assert.deepEqual(pairViews[index]!.onlyPlayers, pair.onlyPlayers);
  }
  const a = replies.findIndex(r => r.you === pair.onlyPlayers![0]);
  const b = replies.findIndex(r => r.you === pair.onlyPlayers![1]);
  assert.equal((await submit(clients[a]!, pair.roundId, { kind: "dare", status: "passed", reason: "I am not comfortable." }, "pair-pass-a")).ok, true);
  assert.equal((await submit(clients[b]!, pair.roundId, { kind: "dare", status: "done" }, "pair-done-b")).ok, false);
  assert.equal((await submit(clients[b]!, pair.roundId, { kind: "dare", status: "passed", reason: "Not tonight for me." }, "pair-pass-b")).ok, true);
  const rows = readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith(".jsonl"))!), "utf8").trim().split("\n").map(line => JSON.parse(line) as any);
  const soloRecord = rows.find(r => r.roundId === solo.roundId);
  assert.equal(soloRecord.performerId, solo.performer);
  const pairRecords = rows.filter(r => r.roundId === pair.roundId);
  assert.deepEqual(pairRecords.map(r => r.value.reason).sort(), ["I am not comfortable.", "Not tonight for me."].sort());
  assert.deepEqual(pairRecords.map(r => r.performerId).sort(), [...pair.onlyPlayers!].sort());
});

test("timer honors grace, skip advances, and reconnect restores the personalized submitted snapshot", async (t) => {
  const { connect } = await setup(t, { roundTimers: { pick: 90, shout: 5000, spotlight: 90, verdict: 90, confess: 90 }, verdictDiscussMs: 0, graceMs: 90, revealHoldMs: 5000, interludeHoldMs: 5000 });
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
  assert.ok(!(reveal.items ?? []).some((item) => /chose\s/i.test(item.text)), "pick targets must not be broadcast in round reveals");
  assert.ok(Date.now() >= first.closesAt + 90 - 15, "grace elapsed");
  const secondPromise = event<RoundView>(clients[0]!, "round", (r) => r.index === 2);
  clients[0]!.emit("skip_round");
  const second = await limit(secondPromise); assert.equal(second.index, 2);
  const secondAnswer: ResponseValue = second.kind === "pick" ? { kind: "pick", target: replies[0]!.you! } : { kind: "shout", word: "vibes" };
  assert.equal((await submit(clients[3]!, second.roundId, secondAnswer, "guest3")).ok, true);
  clients[3]!.disconnect();
  const resumed = await connect();
  const reconnect = await joinRoom(resumed, made.code!, "Guest3", { playerId: replies[3]!.you!, secret: replies[3]!.secret! });
  assert.ok(reconnect.ok && reconnect.secret && reconnect.secret !== replies[3]!.secret, "authenticated reconnect rotates the session secret");
  assert.equal(reconnect.state?.round?.roundId, second.roundId);
  assert.equal(reconnect.state?.round?.youSubmitted, true);
  assert.ok((reconnect.state?.seq ?? 0) > (made.state?.seq ?? 0));
  const replay = await connect();
  assert.equal((await joinRoom(replay, made.code!, "Guest3", { playerId: replies[3]!.you!, secret: replies[3]!.secret! })).ok, false);
  const secondReveal = event<RevealView>(clients[0]!, "reveal", (r) => r.roundId === second.roundId);
  assert.equal((await submit(clients[0]!, first.roundId, { kind: "pick", target: replies[1]!.you! }, "stale")).ok, false);
  clients[2]!.disconnect(); // an unanswered disconnected player cannot hold the phase hostage
  const reclaimed = await connect();
  const aliasResume = await joinRoom(reclaimed, made.code!, "Guest2", { playerId: replies[2]!.you!, secret: replies[2]!.secret! });
  assert.ok(aliasResume.ok && aliasResume.you === replies[2]!.you, "a valid session token reclaims the disconnected seat");
  assert.equal(aliasResume.state?.round?.roundId, second.roundId, "reclaim restores the active round snapshot");
  for (const i of [0, 1]) {
    const answer: ResponseValue = second.kind === "pick" ? { kind: "pick", target: replies[(i + 1) % replies.length]!.you! } : { kind: "shout", word: "vibes" };
    assert.equal((await submit(clients[i]!, second.roundId, answer, `guest-${i}`)).ok, true);
  }
  const reclaimedAnswer: ResponseValue = second.kind === "pick" ? { kind: "pick", target: replies[3]!.you! } : { kind: "shout", word: "vibes" };
  assert.equal((await submit(reclaimed, second.roundId, reclaimedAnswer, "reclaimed")).ok, true);
  const closedSecond = await limit(secondReveal);
  assert.equal(closedSecond.roundId, second.roundId, "the second round emitted a reveal after every eligible player answered");
  // R21: pick rounds still close and reveal, but their targets are never
  // rendered as generic reveal lines. Non-pick rounds keep their visible items.
  if (second.kind === "pick") assert.deepEqual(closedSecond.items ?? [], [], "pick reveals carry no pick lines");
  else assert.ok(closedSecond.items?.length, "non-pick reveals keep their visible items");
});

test("a lost rotation acknowledgement is recoverable only on its authenticated socket", async (t) => {
  const { connect } = await setup(t);
  const host = await connect(), attacker = await connect();
  const made = await create(host);
  const old = { playerId: made.you!, secret: made.secret! };
  const rotated = await joinRoom(host, made.code!, "Host", old);
  assert.ok(rotated.ok && rotated.secret && rotated.secret !== old.secret);
  // Treat the first acknowledgement as lost: the same authenticated socket
  // retries with the token it still knows and receives the identical result.
  const retry = await joinRoom(host, made.code!, "Host", old);
  assert.equal(retry.ok, true); assert.equal(retry.secret, rotated.secret);
  assert.equal((await joinRoom(attacker, made.code!, "Host", old)).ok, false, "old tokens cannot resume on another socket");
  const replaced = await joinRoom(attacker, made.code!, "Host", { playerId: made.you!, secret: rotated.secret! });
  assert.ok(replaced.ok && replaced.secret !== rotated.secret);
  const third = await connect();
  assert.equal((await joinRoom(third, made.code!, "Host", { playerId: made.you!, secret: rotated.secret! })).ok, false);
});

test("a nonce-bound lost rotation acknowledgement survives a new socket without accepting the old token alone", async (t) => {
  const { connect } = await setup(t);
  const host = await connect(), first = await connect(), attacker = await connect();
  const made = await create(host);
  const nonce = "1a".repeat(16);
  const attempt = { playerId: made.you!, secret: `rr1.${made.secret!}.${nonce}` };
  // Drop the acknowledgement entirely, then disconnect the authenticated
  // socket. The client knows only its original secret and its private nonce.
  const accepted = event(first, "state");
  first.emit("join", { roomCode: made.code!, alias: "Host", consent, resume: attempt }, undefined as any);
  await limit(accepted);
  assert.equal((await joinRoom(attacker, made.code!, "Host", { playerId: made.you!, secret: made.secret! })).ok, false, "the old bearer token alone stays invalid");
  assert.equal((await joinRoom(attacker, made.code!, "Host", { playerId: made.you!, secret: `rr1.${made.secret!}.${"2b".repeat(16)}` })).ok, false, "a guessed nonce cannot replay the request");
  first.disconnect();
  const retrySocket = await connect();
  const retry = await joinRoom(retrySocket, made.code!, "Host", attempt);
  assert.ok(retry.ok && retry.secret && retry.secret !== made.secret, "the exact pending request recovers the rotation");
  const next = await joinRoom(retrySocket, made.code!, "Host", { playerId: made.you!, secret: `rr1.${retry.secret}.${"3c".repeat(16)}` });
  assert.ok(next.ok && next.secret !== retry.secret);
  assert.equal((await joinRoom(attacker, made.code!, "Host", attempt)).ok, false, "a later rotation retires the old nonce");
});

test("a lost rotation acknowledgement is recoverable only on its authenticated socket", async (t) => {
  const { connect } = await setup(t);
  const host = await connect(), attacker = await connect();
  const made = await create(host);
  const old = { playerId: made.you!, secret: made.secret! };
  const rotated = await joinRoom(host, made.code!, "Host", old);
  assert.ok(rotated.ok && rotated.secret && rotated.secret !== old.secret);
  // Treat the first acknowledgement as lost: the same authenticated socket
  // retries with the token it still knows and receives the identical result.
  const retry = await joinRoom(host, made.code!, "Host", old);
  assert.equal(retry.ok, true); assert.equal(retry.secret, rotated.secret);
  assert.equal((await joinRoom(attacker, made.code!, "Host", old)).ok, false, "old tokens cannot resume on another socket");
  const replaced = await joinRoom(attacker, made.code!, "Host", { playerId: made.you!, secret: rotated.secret! });
  assert.ok(replaced.ok && replaced.secret !== rotated.secret);
  const third = await connect();
  assert.equal((await joinRoom(third, made.code!, "Host", { playerId: made.you!, secret: rotated.secret! })).ok, false);
});

test("a nonce-bound lost rotation acknowledgement survives a new socket without accepting the old token alone", async (t) => {
  const { connect } = await setup(t);
  const host = await connect(), first = await connect(), attacker = await connect();
  const made = await create(host);
  const nonce = "1a".repeat(16);
  const attempt = { playerId: made.you!, secret: `rr1.${made.secret!}.${nonce}` };
  // Drop the acknowledgement entirely, then disconnect the authenticated
  // socket. The client knows only its original secret and its private nonce.
  const accepted = event(first, "state");
  first.emit("join", { roomCode: made.code!, alias: "Host", consent, resume: attempt }, undefined as any);
  await limit(accepted);
  assert.equal((await joinRoom(attacker, made.code!, "Host", { playerId: made.you!, secret: made.secret! })).ok, false, "the old bearer token alone stays invalid");
  assert.equal((await joinRoom(attacker, made.code!, "Host", { playerId: made.you!, secret: `rr1.${made.secret!}.${"2b".repeat(16)}` })).ok, false, "a guessed nonce cannot replay the request");
  first.disconnect();
  const retrySocket = await connect();
  const retry = await joinRoom(retrySocket, made.code!, "Host", attempt);
  assert.ok(retry.ok && retry.secret && retry.secret !== made.secret, "the exact pending request recovers the rotation");
  const next = await joinRoom(retrySocket, made.code!, "Host", { playerId: made.you!, secret: `rr1.${retry.secret}.${"3c".repeat(16)}` });
  assert.ok(next.ok && next.secret !== retry.secret);
  assert.equal((await joinRoom(attacker, made.code!, "Host", attempt)).ok, false, "a later rotation retires the old nonce");
});

test("majority heat-down lowers exactly one level; repeated votes do not count twice", async (t) => {
  const { connect } = await setup(t, { roundTimers: { pick: 10000, shout: 10000, minigame: 10000, spotlight: 10000, verdict: 10000, confess: 400 }, verdictDiscussMs: 0, graceMs: 1000, revealHoldMs: 10000, interludeHoldMs: 10000 });
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
  const rows = readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith(".jsonl"))!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
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

test("an idle room cannot be revived on access at the 24-hour TTL", async (t) => {
  let now = Date.now();
  const { connect, dir } = await setup(t, { now: () => now });
  const host = await connect(), guest = await connect(), made = await create(host);
  now += 24 * 3600000;
  const deleted = event<void>(host, "deleted");
  const reply = await joinRoom(guest, made.code!, "Guest");
  assert.equal(reply.ok, false, "joining must not extend an already-expired room");
  await limit(deleted);
  assert.deepEqual(readdirSync(dir), []);
});

test("an active room cannot be revived on access after the 48-hour hard limit", async (t) => {
  let now = Date.now();
  const { connect, dir } = await setup(t, { now: () => now });
  const host = await connect(), guest = await connect(), made = await create(host);
  for (const count of [2, 3]) {
    now += 23 * 3600000;
    const changed = event<any>(host, "state", (state) => state.players.length === count);
    host.emit("add_bot"); await limit(changed);
  }
  now += 2 * 3600000;
  const deleted = event<void>(host, "deleted");
  const reply = await joinRoom(guest, made.code!, "Guest");
  assert.equal(reply.ok, false, "activity cannot extend the 48-hour retention deadline");
  await limit(deleted);
  assert.deepEqual(readdirSync(dir), []);
});

test("finale mode keeps ordinary round answers private and does not wait at ready gate", async (t) => {
  const { connect } = await setup(t, { revealMode: "finale", roundTimers: { pick: 10000 }, readyGraceMs: 10000, revealHoldMs: 10 });
  const players = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const made = await create(players[0]!, "Alpha");
  const ids = [made.you!];
  for (let i = 1; i < players.length; i++) ids.push((await joinRoom(players[i]!, made.code!, `Guest${i}`)).you!);
  for (const player of players) player.removeAllListeners("state");
  const snapshots: RoundView[] = [];
  players[0]!.on("round", r => snapshots.push(r));
  const first = event<RoundView>(players[0]!, "round");
  let leaked = false; players[0]!.on("reveal", () => { leaked = true; });
  const next = event<RoundView>(players[0]!, "round", r => r.roundId !== firstId);
  let firstId = "";
  players[0]!.emit("start");
  const round = await limit(first); firstId = round.roundId;
  for (let i = 0; i < players.length; i++) assert.equal((await submit(players[i]!, round.roundId, { kind: "pick", target: ids[(i+1)%4]! }, `x${i}`)).ok, true);
  await limit(next, 2000);
  assert.equal(leaked, false);
  assert.ok(snapshots.every(r => !r.submitted?.length), "submitted identities must be hidden");
});

test("finale mode waits for the last answer and closes immediately after it", async (t) => {
  const { connect } = await setup(t, { revealMode: "finale", roundTimers: { pick: 3000 }, revealHoldMs: 10 });
  const clients = await Promise.all(Array.from({ length: 4 }, () => connect()));
  const made = await create(clients[0]!); const ids = [made.you!];
  for (let i = 1; i < 4; i++) ids.push((await joinRoom(clients[i]!, made.code!, `Slow${i}`)).you!);
  let revealed = false;
  const first = event<RoundView>(clients[0]!, "round");
  let roundId = "";
  const done = event<RoundView>(clients[0]!, "round", r => r.roundId !== roundId);
  clients[0]!.on("reveal", () => { revealed = true; });
  clients[0]!.emit("start"); const round = await limit(first); roundId = round.roundId;
  for (let i = 0; i < 3; i++) assert.ok((await submit(clients[i]!, round.roundId, { kind: "pick", target: ids[(i + 1) % 4]! }, `early-${i}`)).ok);
  await wait(200); assert.equal(revealed, false, "a still-answering connected player is never cut short");
  const started = Date.now();
  assert.ok((await submit(clients[3]!, round.roundId, { kind: "pick", target: ids[0]! }, "last")).ok);
  await limit(done, 2000);
  assert.ok(Date.now() - started < 2000, "last answer closes round within two seconds");
});

test("default server mode keeps mid-game answers for the finale", async (t) => {
  const prior = process.env.REVEAL_MODE; delete process.env.REVEAL_MODE;
  t.after(() => { if (prior !== undefined) process.env.REVEAL_MODE = prior; });
  const { connect } = await setup(t, { revealMode: undefined, botDelayMs: [1, 2], revealHoldMs: 10 });
  const host = await connect(); const made = await create(host);
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  const round = event<RoundView>(host, "round"); let roundId = "";
  const next = event<RoundView>(host, "round", r => r.roundId !== roundId);
  let leaked = false; host.on("reveal", () => { leaked = true; });
  host.emit("start"); const current = await limit(round); roundId = current.roundId;
  assert.ok((await submit(host, current.roundId, { kind: "pick", target: made.you! })).ok);
  await limit(next);
  assert.equal(leaked, false);
});
