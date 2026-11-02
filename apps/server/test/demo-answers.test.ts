// apps/server/test/demo-answers.test.ts
// DEMO ROOMS — the host hand-answers a puppet seat and the answer must land.
//
// A rating round assigns ONE subject per seat (and one trait for the round); an
// ios round assigns one subject per seat. `submit` accepts exactly that
// assignment. But the assignment is rendered only on the owning socket: the
// host's snapshot carries the HOST's subject, never the puppet's, so the shipped
// demo panel (`demoAnswerAs` -> `demoAnswerValue`) always sends the wrong
// subject for a puppet and every tap came back as
// "Answer must use your assigned subject." — the round then only closed on its
// timer. The server owns the assignment, so it binds the puppet's answer to the
// seat exactly as its own auto-puppet path does.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents, JoinReply, ResponseValue, RoomView, RoundView, ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { createGameServer, type GameServer } from "../src/server.ts";
import { assignDemoValue } from "../src/game.ts";

test("assignDemoValue binds a puppet's answer to its own server assignment", () => {
  const targets = new Map([["p2", "p4"], ["p3", "p1"], ["p4", "p2"]]);
  const rating = { kind: "rating" as const, trait: "honesty" as const, targets };
  // Whatever the panel guessed (self, another person, another trait), the seat's
  // own assignment is what reaches the engine.
  assert.deepEqual(assignDemoValue(rating, "p3", { kind: "rating", trait: "chaos", about: "self", value: 7 }),
    { kind: "rating", trait: "honesty", about: "p1", value: 7 });
  assert.deepEqual(assignDemoValue(rating, "p4", { kind: "rating", trait: "warmth", about: "p1", value: 5 }),
    { kind: "rating", trait: "honesty", about: "p2", value: 5 });
  const ios = { kind: "ios" as const, targets };
  assert.deepEqual(assignDemoValue(ios, "p2", { kind: "ios", about: "p3", value: 4 }), { kind: "ios", about: "p4", value: 4 });
  // Every other round kind is untouched: a pick is the seat's own choice.
  assert.deepEqual(assignDemoValue({ kind: "pick" as const }, "p2", { kind: "pick", target: "p1" }), { kind: "pick", target: "p1" });
  assert.deepEqual(assignDemoValue(null, "p2", { kind: "ios", about: "p1", value: 2 } as never), { kind: "ios", about: "p1", value: 2 });
});

const consent = { age: true, terms: true, revealOptIn: true };
const limit = <T>(promise: Promise<T>, ms = 20_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

test("every puppet seat can hand-answer a rating round", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-demo-answers-"));
  let server: GameServer | undefined;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await server?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  server = createGameServer({
    dataDir: dir, graceMs: 40, revealHoldMs: 20, interludeHoldMs: 20, readyGraceMs: 60,
    roundTimers: { pick: 250, text: 250, shout: 250, rating: 5_000, ios: 250, minigame: 250, dare: 250, pair_dare: 250, debrief: 250, spotlight: 250, verdict: 400 },
    verdictDiscussMs: 0, botDelayMs: [100_000, 100_000],
  });
  const port = await server.listen(0, "127.0.0.1", false);
  const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(`http://127.0.0.1:${port}`, { forceNew: true, transports: ["websocket"], reconnection: false, autoConnect: false });
  sockets.push(socket);
  const errors: { code: string; message: string }[] = [];
  socket.on("error", (error) => errors.push(error));
  const opened = new Promise<void>((resolve) => socket.on("connect", () => resolve()));
  socket.connect(); await limit(opened);
  const views: RoomView[] = [];
  socket.on("state", (view) => { views.push(view); if (view.ready && !view.ready.includes(view.hostId)) socket.emit("ready"); });
  const rounds: RoundView[] = [];
  socket.on("round", (round) => rounds.push(round));
  const ack = <T>(name: string, payload: unknown): Promise<T> => new Promise((resolve) => (socket as any).emit(name, payload, resolve));

  const made = await ack<JoinReply & { code?: string }>("create", { alias: "Host", consent, demo: true });
  assert.ok(made.ok && made.code && made.you);
  for (const alias of ["Seat B", "Seat C", "Seat D"]) await ack("demo_add_player", { alias });
  const seats = (views.at(-1)?.players ?? []).filter((p) => p.id !== made.you).map((p) => p.id);
  assert.equal(seats.length, 3);
  for (const id of seats) socket.emit("demo_set_bot_mode", { playerId: id, mode: "manual" });
  socket.emit("start");

  // Wait for the spicy phase's rating round (warmup 4 + spotlight, then spicy).
  const rating = await limit(new Promise<RoundView>((resolve) => {
    const poll = setInterval(() => {
      const found = rounds.find((round) => round.kind === "rating" && !round.youSubmitted);
      if (found) { clearInterval(poll); resolve(found); }
    }, 20);
  }), 25_000);
  assert.ok(rating.about && rating.trait, "the server assigned a subject and a trait");
  errors.length = 0;
  // The shipped demo panel answers every seat the same way it always has: its
  // own plausible value, which for a puppet is NOT the seat's assignment.
  for (const [index, id] of seats.entries()) {
    const value: ResponseValue = index % 2 === 0
      ? { kind: "rating", trait: rating.trait, about: "self", value: 6 }
      : { kind: "rating", trait: rating.trait, about: rating.about, value: 6 };
    socket.emit("demo_answer_as", { playerId: id, roundId: rating.roundId, clientUuid: `demo-${id}`, value });
  }
  const answered = await limit(new Promise<RoundView>((resolve) => {
    const poll = setInterval(() => {
      const next = rounds.at(-1);
      if (next && next.roundId === rating.roundId) { clearInterval(poll); resolve(next); }
    }, 20);
  }), 3_000).catch(() => rating);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(errors, [], "no seat's answer is refused");
  const latest = views.at(-1)?.round;
  const submitted = latest?.roundId === rating.roundId ? latest.submitted ?? [] : answered.submitted ?? [];
  for (const id of seats) assert.ok(submitted.includes(id), `seat ${id} was recorded as having answered`);
});
