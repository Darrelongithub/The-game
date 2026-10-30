// apps/server/test/ready-gate.test.ts
// ROUND 4 — REVEALS WAIT FOR EVERYONE.
//
// The contract: a closed round's reveal is PENDING until every CONNECTED player
// has pressed ready, so a phone that was in a pocket, in the bathroom, or
// reconnecting does not miss the moment. One AFK phone never stalls the night:
// the pending reveal fires after REVEAL_READY_GRACE_MS regardless.
//
// These tests pin the observable rules:
//   1. the reveal does NOT fire while a connected phone has not pressed ready;
//   2. it fires the instant the last phone presses (no waiting for the timer);
//   3. a phone that drops out stops being waited for (nobody is held hostage);
//   4. the grace fallback fires the reveal with an AFK phone still silent;
//   5. `ready` in the snapshot is public ids only, and stale taps are harmless;
//   6. bots never block the gate — the host's solo night still flows.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents, JoinReply, RevealView, RoomView, ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { createGameServer, type GameServer } from "../src/server.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const limit = <T>(promise: Promise<T>, ms = 10_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const event = <T>(client: Client, name: string, predicate: (payload: T) => boolean = () => true): Promise<T> =>
  new Promise((resolve) => {
    const handler = (data: T): void => { if (predicate(data)) { (client as any).off(name, handler); resolve(data); } };
    (client as any).on(name, handler);
  });

/** A four-seat room that never presses ready on its own. */
async function room(t: { after: (fn: () => Promise<void> | void) => void }, options: { readyGraceMs: number; bots?: number }) {
  const dir = mkdtempSync(join(tmpdir(), "reveal-ready-"));
  const server: GameServer = createGameServer({
    dataDir: dir,
    roundTimers: { pick: 1_200, shout: 1_200, text: 1_200, rating: 1_200, ios: 1_200, minigame: 1_200, dare: 1_200, pair_dare: 1_200, debrief: 1_200, spotlight: 1_200, verdict: 1_200, confess: 400 },
    verdictDiscussMs: 0, graceMs: 50, revealHoldMs: 400, interludeHoldMs: 20, botDelayMs: [5, 10],
    readyGraceMs: options.readyGraceMs,
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
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, profile }, resolve));
  assert.equal(made.ok, true);
  for (let i = 0; i < (options.bots ?? 3); i++) host.emit("add_bot");
  if ((options.bots ?? 3) === 0) {
    for (let i = 1; i < 4; i++) {
      const socket = await connect();
      const reply = await new Promise<JoinReply>((resolve) => socket.emit("join", { roomCode: made.code!, alias: `Guest${i}`, consent, profile }, resolve));
      assert.equal(reply.ok, true);
    }
  }
  await wait(60);
  return { server, host, clients, code: made.code! };
}

test("the reveal waits for every connected phone, then fires on the last ready", { timeout: 20_000 }, async (t) => {
  const { host, clients } = await room(t, { readyGraceMs: 8_000, bots: 0 });
  const everyone = clients; // host is clients[0]
  const revealPromises = everyone.map((client) => event<RevealView>(client, "reveal"));
  let fired = false;
  void Promise.all(revealPromises).then(() => { fired = true; });

  // Everyone answers the first round; nobody presses ready.
  for (const [index, client] of everyone.entries()) {
    client.on("round", (round) => {
      if (round.youSubmitted || round.expectsAnswer === false) return;
      const value = round.kind === "shout" ? { kind: "shout" as const, word: "vibes" }
        : round.kind === "text" || round.kind === "spotlight" || round.kind === "debrief" ? { kind: "text" as const, text: "A quiet answer from the room." }
        : round.kind === "rating" ? { kind: "rating" as const, trait: round.trait!, about: round.about!, value: 6 }
        : round.kind === "ios" ? { kind: "ios" as const, about: index === 0 ? "p2" : "p1", value: 5 }
        : round.kind === "minigame" ? { kind: "minigame" as const, score: 12 }
        : round.kind === "dare" || round.kind === "pair_dare" ? { kind: "dare" as const, status: "done" as const }
        : { kind: "pick" as const, target: index === 0 ? "p2" : "p1" };
      client.emit("submit", { roundId: round.roundId, clientUuid: `${round.roundId}:${index}`, value }, () => {});
    });
  }
  let pending: RoomView | null = null;
  host.on("state", (view) => { if (view.ready) pending = view; });
  host.emit("start");

  // The gate opens: `ready` appears in the snapshot and NO reveal has fired.
  const started = Date.now();
  while (!pending && Date.now() - started < 5_000) await wait(20);
  assert.ok(pending, "a reveal became pending");
  const snapshot: RoomView = pending!;
  assert.deepEqual(snapshot.ready, [], "nobody has pressed ready yet");
  assert.equal(snapshot.round, null);
  await wait(300);
  assert.equal(fired, false, "the reveal must not fire while phones have not pressed ready");

  // Three of four press: still pending.
  for (let i = 0; i < 3; i++) everyone[i]!.emit("ready");
  await wait(250);
  assert.equal(fired, false, "one silent phone still holds the moment");

  // The last phone presses: the reveal fires immediately, not after the grace.
  everyone[3]!.emit("ready");
  const reveals = await limit(Promise.all(revealPromises), 3_000);
  assert.ok(reveals.every((reveal) => reveal.roundId === reveals[0]!.roundId), "every phone saw the same moment");
  assert.ok(Date.now() - started < 8_000, "ready, not the grace timer, released the moment");
  for (const reveal of reveals) assert.ok(reveal.summary.length > 0);
});

test("a phone that drops out is no longer waited for", { timeout: 20_000 }, async (t) => {
  const { host, clients } = await room(t, { readyGraceMs: 8_000, bots: 0 });
  const allReveals = clients.slice(0, 3).map((client) => event<RevealView>(client, "reveal"));
  let pending: RoomView | null = null;
  host.on("state", (view) => { if (view.ready) pending = view; });
  for (const [index, client] of clients.entries()) {
    client.on("round", (round) => {
      if (round.youSubmitted || round.expectsAnswer === false) return;
      const value = round.kind === "shout" ? { kind: "shout" as const, word: "chaos" }
        : round.kind === "text" || round.kind === "spotlight" || round.kind === "debrief" ? { kind: "text" as const, text: "Still here, mostly." }
        : round.kind === "rating" ? { kind: "rating" as const, trait: round.trait!, about: round.about!, value: 4 }
        : round.kind === "ios" ? { kind: "ios" as const, about: index === 0 ? "p3" : "p1", value: 4 }
        : round.kind === "minigame" ? { kind: "minigame" as const, score: 9 }
        : round.kind === "dare" || round.kind === "pair_dare" ? { kind: "dare" as const, status: "done" as const }
        : { kind: "pick" as const, target: index === 0 ? "p3" : "p1" };
      client.emit("submit", { roundId: round.roundId, clientUuid: `${round.roundId}:${index}`, value }, () => {});
    });
  }
  host.emit("start");
  const started = Date.now();
  while (!pending && Date.now() - started < 5_000) await wait(20);
  assert.ok(pending, "a reveal became pending");

  // Three press ready; the fourth walks out of signal instead.
  for (let i = 0; i < 3; i++) clients[i]!.emit("ready");
  await wait(150);
  clients[3]!.disconnect();
  const reveals = await limit(Promise.all(allReveals), 3_000);
  assert.ok(reveals.length === 3);
});

test("the grace fallback reveals anyway so one AFK phone cannot stall the night", { timeout: 20_000 }, async (t) => {
  const { host } = await room(t, { readyGraceMs: 300, bots: 3 });
  const reveal = event<RevealView>(host, "reveal");
  let pendingAt = 0;
  host.on("state", (view) => { if (view.ready && !pendingAt) pendingAt = Date.now(); });
  host.on("round", (round) => {
    if (round.youSubmitted || round.expectsAnswer === false) return;
    const value = round.kind === "shout" ? { kind: "shout" as const, word: "mood" }
      : round.kind === "text" || round.kind === "spotlight" || round.kind === "debrief" ? { kind: "text" as const, text: "An answer from the host seat." }
      : round.kind === "rating" ? { kind: "rating" as const, trait: round.trait!, about: round.about!, value: 5 }
      : round.kind === "ios" ? { kind: "ios" as const, about: round.about!, value: 5 }
      : round.kind === "minigame" ? { kind: "minigame" as const, score: 20 }
      : round.kind === "dare" || round.kind === "pair_dare" ? { kind: "dare" as const, status: "done" as const }
      : { kind: "pick" as const, target: "p2" };
    host.emit("submit", { roundId: round.roundId, clientUuid: `host:${round.roundId}`, value }, () => {});
  });
  host.emit("start");
  // The host never presses ready: bots do not block, and the grace fires.
  const view = await limit(reveal, 5_000);
  assert.ok(pendingAt > 0, "the gate really was pending first");
  assert.ok(view.summary.length > 0);
  // Snapshot after the reveal carries no stale `ready` list.
  await wait(80);
  const latest = await new Promise<RoomView>((resolve) => host.once("state", resolve));
  assert.equal(latest.ready, undefined, "ready is present only while a reveal is pending");
});

test("a lone host with bots never blocks on the gate (solo testing still flows)", { timeout: 20_000 }, async (t) => {
  const { host } = await room(t, { readyGraceMs: 5_000, bots: 3 });
  const reveals: RevealView[] = [];
  host.on("reveal", (reveal) => reveals.push(reveal));
  host.on("round", (round) => {
    if (round.youSubmitted || round.expectsAnswer === false) return;
    const value = round.kind === "shout" ? { kind: "shout" as const, word: "solo" }
      : round.kind === "text" || round.kind === "spotlight" || round.kind === "debrief" ? { kind: "text" as const, text: "Testing alone tonight." }
      : round.kind === "rating" ? { kind: "rating" as const, trait: round.trait!, about: round.about!, value: 8 }
      : round.kind === "ios" ? { kind: "ios" as const, about: round.about!, value: 3 }
      : round.kind === "minigame" ? { kind: "minigame" as const, score: 15 }
      : round.kind === "dare" || round.kind === "pair_dare" ? { kind: "dare" as const, status: "done" as const }
      : { kind: "pick" as const, target: "p2" };
    host.emit("submit", { roundId: round.roundId, clientUuid: `solo:${round.roundId}`, value }, () => {});
  });
  // Ready taps are stale-safe: sending one before any round ends is ignored.
  host.emit("ready");
  host.emit("start");
  await limit(event<void>(host, "round"));
  await wait(120);
  assert.equal(reveals.length, 0, "no reveal before the round closes");
  // The gate opens; the host taps ready and it moves on — no 5s grace wait.
  await limit(new Promise<void>((resolve) => { host.on("state", (view) => { if (view.ready) resolve(); }); }));
  host.emit("ready");
  const reveal = await limit(event<RevealView>(host, "reveal"), 2_000);
  assert.ok(reveal.summary.length > 0);
});
