// apps/server/test/demo-mode.test.ts
// ROUND 4 — THE HOST CAN TEST THE WHOLE GAME ALONE ON ONE LAPTOP.
//
// A demo room is an ordinary room with `demo: true`: the host creates it, adds
// puppeted seats, and plays every seat from one device. These tests pin:
//   1. a demo room plays a full night to a finale with one real socket;
//   2. `demo_answer_as` writes an ordinary LogRecord (+ `impersonatedBy`
//      metadata) and the ENGINE IGNORES IT — parity with the same answers from
//      real phones;
//   3. manual puppets wait for the host; auto puppets answer themselves;
//   4. `demo_all_ready` / `demo_speed` do what they say;
//   5. every demo control is refused outside a demo room and by non-hosts;
//   6. no demo material (puppet identity, impersonation) rides a client payload.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents, FinaleView, JoinReply, LogRecord, RevealView, RoomView, RoundView, ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { computeSignals, computeResults, buildNightDigest, buildSecrets } from "../../../packages/engine/src/index.ts";
import { createGameServer, type GameServer } from "../src/server.ts";
import { fallbackServices } from "../src/services.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const limit = <T>(promise: Promise<T>, ms = 15_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const event = <T>(client: Client, name: string, predicate: (payload: T) => boolean = () => true): Promise<T> =>
  new Promise((resolve) => {
    const handler = (data: T): void => { if (predicate(data)) { (client as any).off(name, handler); resolve(data); } };
    (client as any).on(name, handler);
  });
const ack = <T>(client: Client, name: string, payload: unknown): Promise<T> =>
  new Promise((resolve) => (client as any).emit(name, payload, resolve));

async function harness(t: { after: (fn: () => Promise<void> | void) => void }, options: { readyGraceMs?: number; roundTimers?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reveal-demo-"));
  const server: GameServer = createGameServer({
    dataDir: dir,
    roundTimers: { pick: options.roundTimers ?? 4_000, shout: options.roundTimers ?? 4_000, text: options.roundTimers ?? 4_000,
      rating: options.roundTimers ?? 4_000, ios: options.roundTimers ?? 4_000, minigame: options.roundTimers ?? 4_000,
      dare: options.roundTimers ?? 4_000, pair_dare: options.roundTimers ?? 4_000, debrief: options.roundTimers ?? 4_000,
      spotlight: options.roundTimers ?? 4_000, verdict: options.roundTimers ?? 4_000 },
    verdictDiscussMs: 0, graceMs: 50, revealHoldMs: 20, interludeHoldMs: 20, botDelayMs: [5, 20],
    // Deliberately short: the demo tests press demo_all_ready where it matters.
    readyGraceMs: options.readyGraceMs ?? 400,
  });
  const port = await server.listen(0, "127.0.0.1", false);
  const base = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) client.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const connect = async (): Promise<Client> => {
    const socket: Client = io(base, { forceNew: true, transports: ["polling", "websocket"], reconnection: false, autoConnect: false });
    socket.on("error", () => {});
    clients.push(socket);
    const opened = event<void>(socket, "connect");
    socket.connect();
    await limit(opened);
    return socket;
  };
  const host = await connect();
  return { server, host, connect, base, dir };
}

const SEATS = ["Maya", "Kofi", "Zuri"];

/** A legal answer for any round kind, so a scripted seat can be answered. */
function valueFor(round: RoundView, other: string): any {
  switch (round.kind) {
    case "confess": return { kind: "confess", yes: true };
    case "pick": case "verdict": return { kind: "pick", target: other };
    case "shout": return { kind: "shout", word: "static" };
    case "rating": return { kind: "rating", trait: round.trait!, about: round.about!, value: 6 };
    case "ios": return { kind: "ios", about: other, value: 4 };
    case "minigame": return { kind: "minigame", score: 18 };
    case "dare": case "pair_dare": return { kind: "dare", status: "done" };
    default: return { kind: "text", text: "Answered on behalf of a demo seat." };
  }
}

test("a demo room plays a whole night to a finale from one laptop", { timeout: 60_000 }, async (t) => {
  const { host, dir } = await harness(t, { readyGraceMs: 5_000 });
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, demo: true }, resolve));
  assert.equal(made.ok, true);
  assert.equal(made.state?.demo, true, "the room says it is a demo room");

  const ids: string[] = [];
  for (const alias of SEATS) {
    const reply = await ack<{ ok: boolean; playerId?: string }>(host, "demo_add_player", { alias });
    assert.equal(reply.ok, true, `demo seat ${alias} was added`);
    ids.push(reply.playerId!);
  }
  // Everyone is in the lobby; start with far fewer than MIN_PLAYERS.
  const state = await (async () => {
    const next = event<RoomView>(host, "state", (view) => view.players.length === SEATS.length + 1);
    host.emit("start");
    return limit(next);
  })();
  assert.equal(state.demo, true);
  assert.equal(state.players.length, 4);

  const finale = event<FinaleView>(host, "finale", () => true);
  // Nothing internal rides a demo night either: same invisibility rule as §6a.
  const emitted: unknown[] = [];
  host.onAny((_name: string, payload: unknown) => emitted.push(payload));
  const errors: { code: string; message: string }[] = [];
  host.on("error", (error) => errors.push(error));
  // The host answers their own seat; the three puppets are auto and answer
  // themselves. `demo_all_ready` releases every pending moment.
  host.on("state", (view) => { if (view.ready) host.emit("demo_all_ready"); });
  host.on("round", (round) => {
    if (round.youSubmitted || round.expectsAnswer === false) return;
    const value = round.kind === "shout" ? { kind: "shout" as const, word: "mood" }
      : round.kind === "text" || round.kind === "spotlight" || round.kind === "debrief" ? { kind: "text" as const, text: "Testing the whole game alone." }
      : round.kind === "rating" ? { kind: "rating" as const, trait: round.trait!, about: round.about!, value: 7 }
      : round.kind === "ios" ? { kind: "ios" as const, about: ids[0]!, value: 5 }
      : round.kind === "minigame" ? { kind: "minigame" as const, score: 24 }
      : round.kind === "dare" || round.kind === "pair_dare" ? { kind: "dare" as const, status: "done" as const }
      : { kind: "pick" as const, target: ids[0]! };
    host.emit("submit", { roundId: round.roundId, clientUuid: `solo:${round.roundId}`, value }, () => {});
  });
  const view = await limit(finale, 45_000);
  assert.ok(view.slides.length > 3, "the night produced a real finale");
  assert.deepEqual(errors, [], "a solo demo night raises no errors");

  // The room log holds ordinary records. `impersonatedBy` appears only where
  // the host actually puppeted a seat, and never in anything a client sees.
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  assert.equal(files.length, 1);
  const records: LogRecord[] = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(records.length > 20, "every seat answered all night");
  for (const record of records) {
    assert.ok(record.playerId && record.roundId && record.value);
    assert.equal(record.impersonatedBy, undefined, "auto puppets answer for themselves, not as the host");
  }
  assert.ok(!JSON.stringify(view).includes("puppet"), "no puppet material in the finale");
  const leakMarkers = /hypothes|suspect|coverage|"priors"|"director"|openedAt|impersonatedBy/iu;
  for (const payload of emitted) assert.ok(!leakMarkers.test(JSON.stringify(payload)), "a demo night leaks no internal material");
});

test("demo_answer_as writes an ordinary record and the engine ignores the metadata (parity)", { timeout: 40_000 }, async (t) => {
  const { host, dir } = await harness(t, { readyGraceMs: 5_000, roundTimers: 1_500 });
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, demo: true }, resolve));
  assert.equal(made.ok, true);
  const ids: string[] = [];
  for (const alias of SEATS) {
    const reply = await ack<{ ok: boolean; playerId?: string }>(host, "demo_add_player", { alias });
    ids.push(reply.playerId!);
    // manual: the puppet waits for the host on every round
    host.emit("demo_set_bot_mode", { playerId: reply.playerId!, mode: "manual" });
  }
  await wait(40);

  const snapshots: RoomView[] = [];
  const answered = new Set<string>();
  host.on("state", (view) => { snapshots.push(view); if (view.ready) host.emit("demo_all_ready"); });
  host.on("round", (round) => {
    if (round.expectsAnswer === false) return;
    const allowed = (seat: string): boolean => !round.onlyPlayers || round.onlyPlayers.includes(seat);
    if (!round.youSubmitted && allowed(made.you!)) {
      host.emit("submit", { roundId: round.roundId, clientUuid: `host:${round.roundId}`, value: valueFor(round, ids[0]!) }, () => {});
    }
    for (const id of ids) {
      if (!allowed(id) || answered.has(`${round.roundId}:${id}`)) continue;
      answered.add(`${round.roundId}:${id}`);
      host.emit("demo_answer_as", { playerId: id, roundId: round.roundId, clientUuid: `demo:${round.roundId}:${id}`, value: valueFor(round, ids[1]!) });
    }
  });
  // Two rounds are plenty: the metadata question is per-record, not per-night.
  host.emit("start");
  await limit(new Promise<void>((resolve) => {
    let rounds = 0;
    const onRound = (): void => { rounds += 1; if (rounds >= 2) resolve(); };
    host.on("round", onRound);
  }), 20_000);
  await wait(250);

  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const records: LogRecord[] = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const puppeted = records.filter((record) => record.impersonatedBy === "p1");
  assert.ok(puppeted.length > 0, "the host's puppeted answers are flagged in the room log");
  assert.ok(puppeted.every((record) => record.playerId !== "p1"), "a seat is never impersonating itself");
  assert.ok(records.some((record) => record.playerId === "p1" && record.impersonatedBy === undefined), "the host's own answers are unmarked");
  // ...and nothing on the wire mentions it.
  assert.ok(!JSON.stringify(snapshots).includes("impersonatedBy"));

  // ENGINE PARITY: the exact same records, with the metadata stripped, produce
  // identical signals, claims, digest and secret decks. Impersonation is
  // metadata; it can never move a number.
  const meta = { roomId: "parity", players: ["p1", ...ids].map((id, index) => ({ id, alias: `Player ${index + 1}` })),
    revealOptIn: ["p1", ...ids] };
  const scoring = records.filter((record) => record.decoy !== true);
  const stripped = scoring.map(({ impersonatedBy: _ignored, ...rest }) => rest);
  assert.deepEqual(computeSignals(scoring, meta), computeSignals(stripped, meta), "signals ignore impersonation");
  const withMeta = computeResults(computeSignals(scoring, meta), scoring, meta);
  const withoutMeta = computeResults(computeSignals(stripped, meta), stripped, meta);
  assert.deepEqual(withMeta.claims, withoutMeta.claims, "claims ignore impersonation");
  const digest = buildNightDigest(scoring, meta);
  assert.deepEqual(digest, buildNightDigest(stripped, meta), "the digest ignores impersonation");
  assert.deepEqual([...buildSecrets(withMeta, digest, meta).entries()],
    [...buildSecrets(withoutMeta, buildNightDigest(stripped, meta), meta).entries()],
    "secret decks ignore impersonation");
});

test("manual seats wait for the host; auto seats answer themselves", { timeout: 30_000 }, async (t) => {
  const { host, dir } = await harness(t, { readyGraceMs: 5_000, roundTimers: 3_000 });
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, demo: true }, resolve));
  assert.equal(made.ok, true);
  const manual = (await ack<{ ok: boolean; playerId?: string }>(host, "demo_add_player", { alias: "Manual" })).playerId!;
  const auto = (await ack<{ ok: boolean; playerId?: string }>(host, "demo_add_player", { alias: "Auto" })).playerId!;
  host.emit("demo_set_bot_mode", { playerId: manual, mode: "manual" });

  const firstRound = event<RoomView>(host, "state", (view) => view.round !== null);
  host.emit("start");
  const opening = await limit(firstRound);
  const roundId = opening.round!.roundId;
  // Give the auto seat every chance to answer; the manual one must stay silent.
  await wait(400);
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  const records: LogRecord[] = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const forRound = records.filter((record) => record.roundId === roundId);
  if (opening.round!.expectsAnswer !== false) {
    // (the host's own seat is not scripted here, so only puppets may appear)
    assert.ok(forRound.some((record) => record.playerId === auto), "an auto seat answers itself");
  }
  assert.equal(forRound.filter((record) => record.playerId === manual).length, 0, "a manual seat waits for the host");
  // ...and the host can answer it by hand, which is the whole point.
  host.emit("demo_answer_as", { playerId: manual, roundId, clientUuid: `manual:${roundId}`,
    value: valueFor(opening.round!, auto) });
  await wait(200);
  const after = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) as LogRecord[];
  const manualRecord = after.find((record) => record.playerId === manual && record.roundId === roundId);
  assert.ok(manualRecord, "the host's hand answer landed");
  assert.equal(manualRecord!.impersonatedBy, "p1", "and is flagged as impersonated metadata");
});

test("demo controls are demo-only and host-only", { timeout: 20_000 }, async (t) => {
  const { host, connect } = await harness(t);
  // An ordinary room refuses every demo control.
  const real = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, profile }, resolve));
  assert.equal(real.ok, true);
  assert.equal(real.state?.demo, undefined, "an ordinary room is not a demo room");
  const refused = event<{ code: string }>(host, "error");
  const added = await ack<{ ok: boolean }>(host, "demo_add_player", { alias: "Ghost" });
  assert.equal(added.ok, false, "no demo seats in a real room");
  assert.equal((await limit(refused)).code, "DEMO_ONLY");
  for (const [name, payload] of [["demo_all_ready", undefined], ["demo_speed", { scale: 0.5 }],
    ["demo_set_bot_mode", { playerId: "p2", mode: "auto" }], ["demo_answer_as", { playerId: "p2", roundId: "x", clientUuid: "y", value: { kind: "text", text: "no" } }]] as const) {
    host.emit(name as any, payload as any);
  }
  const codes: string[] = [];
  host.on("error", (error) => codes.push(error.code));
  await wait(120);
  assert.ok(codes.includes("DEMO_ONLY"), "every demo control refuses a real room");

  // A demo room refuses a non-host. (A fresh socket: one socket holds one seat.)
  const second = await connect();
  const demo = await new Promise<JoinReply & { code?: string }>((resolve) => second.emit("create", { alias: "DemoHost", consent, demo: true }, resolve));
  assert.equal(demo.ok, true);
  const guest = await connect();
  const joined = await new Promise<JoinReply>((resolve) => guest.emit("join", { roomCode: demo.code!, alias: "Guest", consent, profile }, resolve));
  assert.equal(joined.ok, true);
  const guestSeat = await new Promise<{ ok: boolean; playerId?: string }>((resolve) => guest.emit("demo_add_player", { alias: "Proxy" }, resolve));
  assert.equal(guestSeat.ok, false, "only the host puppets seats");
  const hostOnly = event<{ code: string }>(guest, "error");
  guest.emit("demo_speed", { scale: 0.5 });
  assert.equal((await limit(hostOnly)).code, "HOST_ONLY");
});

test("demo_speed shortens timers; demo_all_ready releases a pending reveal", { timeout: 30_000 }, async (t) => {
  const { host } = await harness(t, { readyGraceMs: 6_000, roundTimers: 4_000 });
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, demo: true }, resolve));
  assert.equal(made.ok, true);
  const seat = (await ack<{ ok: boolean; playerId?: string }>(host, "demo_add_player", { alias: "Auto" })).playerId!;
  host.emit("demo_set_bot_mode", { playerId: seat, mode: "auto" });
  host.emit("demo_speed", { scale: 0.25 });
  await wait(60);

  let pending = false;
  host.on("state", (view) => { if (view.ready) pending = true; });
  host.on("round", (round) => {
    if (round.youSubmitted || round.expectsAnswer === false) return;
    // 4s × 0.25 = 1s: the round must close well before the unscaled timer.
    const ms = round.closesAt - Date.now();
    assert.ok(ms <= 1_100, `demo speed scaled the round timer (${ms}ms)`);
    host.emit("submit", { roundId: round.roundId, clientUuid: `h:${round.roundId}`,
      value: { kind: round.kind === "pick" || round.kind === "verdict" ? "pick" : round.kind === "shout" ? "shout" : "text",
        ...(round.kind === "pick" || round.kind === "verdict" ? { target: seat } : round.kind === "shout" ? { word: "zip" } : { text: "Quick one." }) } as any }, () => {});
  });
  host.emit("start");
  await limit(new Promise<void>((resolve) => { host.on("state", (view) => { if (view.ready) resolve(); }); }), 8_000);
  assert.equal(pending, true, "the reveal is pending");
  const reveal = event<RevealView>(host, "reveal");
  host.emit("demo_all_ready");
  const view = await limit(reveal, 2_000);
  assert.ok(view.summary.length > 0, "demo_all_ready released the moment immediately");
});
