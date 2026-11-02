// apps/server/test/verdict-tie.test.ts
// A 2–2 verdict is a split, not a decision.
//
// The verdict reveal used to sort the tally and name `ranked[0]` as "The room
// decided: X" even when the top count was shared, so a coin-flip tie was
// announced to the whole room as a verdict the log does not support. Both sides
// are named now, and the numbers stay the honest 2 of 4.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents, JoinReply, RoomView, RoundView, ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { createGameServer, type GameServer } from "../src/server.ts";

const consent = { revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const limit = <T>(promise: Promise<T>, ms = 30_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

test("a tied verdict is announced as a split, never as a decision", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-verdict-tie-"));
  let server: GameServer | undefined;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await server?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  server = createGameServer({
    dataDir: dir, graceMs: 60, revealHoldMs: 40, interludeHoldMs: 15, readyGraceMs: 200,
    roundTimers: { pick: 200, text: 200, shout: 200, rating: 200, ios: 200, minigame: 200, dare: 200, pair_dare: 200, debrief: 200, spotlight: 250, verdict: 1_500 },
    verdictDiscussMs: 40,
  });
  const port = await server.listen(0, "127.0.0.1", false);
  const connect = async (): Promise<Socket<ServerToClientEvents, ClientToServerEvents>> => {
    const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(`http://127.0.0.1:${port}`, { forceNew: true, transports: ["websocket"], reconnection: false });
    sockets.push(socket as Socket);
    await limit(new Promise<void>((resolve) => socket.on("connect", () => resolve())));
    return socket;
  };
  const ack = <T,>(socket: Socket, name: string, payload: unknown): Promise<T> => new Promise((resolve) => (socket as any).emit(name, payload, resolve));

  const host = await connect();
  const made = await ack<JoinReply & { code?: string }>(host, "create", { alias: "Ada", consent, profile });
  assert.ok(made.ok && made.code && made.you);
  const ids: string[] = [made.you!];
  const seats: Socket[] = [host as Socket];
  for (const alias of ["Ben", "Cleo", "Dara"]) {
    const socket = await connect();
    const reply = await ack<JoinReply>(socket, "join", { roomCode: made.code!, alias, consent, profile });
    assert.ok(reply.ok && reply.you, `join ${alias}: ${reply.error ?? ""}`);
    ids.push(reply.you!); seats.push(socket as Socket);
  }

  const views: RoomView[] = [];
  let verdictReveal: { summary?: string; slide?: { title?: string; body?: string; numbers?: { votes: number; of: number } } } | undefined;
  host.on("reveal", (reveal) => {
    const value = reveal as unknown as typeof verdictReveal;
    if (!verdictReveal && /verdict/i.test(String((reveal as { kind?: string }).kind ?? ""))) verdictReveal = value;
  });
  seats.forEach((socket, index) => {
    const me = ids[index]!;
    socket.on("state", (view: RoomView) => {
      views.push(view);
      if (view.ready && !view.ready.includes(me)) void ack(socket, "ready", {});
    });
    socket.on("round", (round: RoundView) => { void (async () => {
      if (round.expectsAnswer === false || (round.onlyPlayers && !round.onlyPlayers.includes(me))) return;
      const base = { roundId: round.roundId, clientUuid: `tie-${round.roundId}-${me}` };
      if (round.kind === "verdict") {
        if (round.voteOpensAt && Date.now() < round.voteOpensAt) {
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, round.voteOpensAt! - Date.now()) + 20));
        }
        // Seats 1 and 3 vote for the second guest, seats 2 and 4 for the first:
        // a fixed, verifiable 2–2 split.
        await ack(socket, "submit", { ...base, value: { kind: "pick", target: ids[index % 2 === 0 ? 1 : 0] } });
        return;
      }
      const value = round.kind === "pick" ? { kind: "pick", target: ids.find((id) => id !== me) }
        : round.kind === "shout" ? { kind: "shout", word: "chaos" }
        : round.kind === "rating" ? { kind: "rating", trait: round.trait, about: round.about, value: 6 }
        : round.kind === "ios" ? { kind: "ios", about: round.about, value: 4 }
        : round.kind === "minigame" ? { kind: "minigame", score: 40 }
        : round.kind === "dare" || round.kind === "pair_dare" ? { kind: "dare", status: "done" }
        : { kind: "text", text: "a plain answer" };
      await ack(socket, "submit", { ...base, value });
    })(); });
  });

  host.emit("start");
  const started = Date.now();
  while (!verdictReveal && Date.now() - started < 25_000) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(verdictReveal, "a verdict round reached its reveal");
  const summary = verdictReveal!.summary ?? "";
  assert.doesNotMatch(summary, /decided/i, `a 2–2 tie is not a decision (got ${JSON.stringify(summary)})`);
  assert.match(summary, /split/i);
  const players = (views.at(-1)?.players ?? []).map((player) => player.alias);
  const slide = verdictReveal!.slide;
  assert.ok(slide, "the verdict still draws its group slide");
  assert.deepEqual(slide!.numbers, { votes: 2, of: 4, share: 0.5 } as never, "the tally is the honest 2 of 4");
  for (const alias of [players[0], players[1]]) assert.match(slide!.title ?? "", new RegExp(alias!), "both sides of the split are named");
  assert.match(slide!.body ?? "", /2 of 4 each/);
});
