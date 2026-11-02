// apps/server/test/player-token.test.ts
// A guest who types "Player 2" in a pass reason must see their own words in the
// finale — not a real guest's name.
//
// `restoreAliases` maps every whole "Player N" token back to the alias of seat
// N. Player-authored text is pseudonymised on the way to any service, so a
// sentence that already contains a token survived storage untouched and was
// rewritten on the way out: a guest's "Truth is, Player 2 should do this
// instead of me." was published as "Truth is, Ben should do this instead of
// me." — naming someone the sentence never named. The typed token is therefore
// taken out of the token grammar when the answer is stored.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents, JoinReply, LogRecord, RoomView, RoundView, ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { createGameServer, type GameServer } from "../src/server.ts";
import { restoreAliases } from "../src/pseudonyms.ts";

const consent = { revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const REASON = "Truth is, Player 2 should do this instead of me.";
const limit = <T>(promise: Promise<T>, ms = 30_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

test("a guest's typed pseudonym token is never rebound to a seat in public copy", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-player-token-"));
  let server: GameServer | undefined;
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await server?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  });
  server = createGameServer({
    dataDir: dir, graceMs: 60, revealHoldMs: 20, interludeHoldMs: 15, readyGraceMs: 200,
    roundTimers: { pick: 250, text: 250, shout: 250, rating: 250, ios: 250, minigame: 250, dare: 5_000, pair_dare: 5_000, debrief: 250, spotlight: 300, verdict: 800 },
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
  const made = await ack<JoinReply & { code?: string }>(host, "create", { alias: "Host", consent, profile });
  assert.ok(made.ok && made.code && made.you);
  const code = made.code!;
  const ids: string[] = [made.you!];
  const seats: Socket[] = [host as Socket];
  for (const alias of ["Ben", "Cleo", "Dara"]) {
    const socket = await connect();
    const reply = await ack<JoinReply>(socket, "join", { roomCode: code, alias, consent, profile });
    assert.ok(reply.ok && reply.you, `join ${alias}: ${reply.error ?? ""}`);
    ids.push(reply.you!); seats.push(socket as Socket);
  }

  const views: RoomView[] = [];
  const errors: unknown[] = [];
  let finale: { slides?: { flavor?: string; body?: string }[] } | undefined;
  let passed = false;
  host.on("finale", (value) => { finale = value as unknown as typeof finale; });
  seats.forEach((socket, index) => {
    const me = ids[index]!;
    socket.on("error", (error) => errors.push(error));
    socket.on("state", (view: RoomView) => {
      views.push(view);
      if (view.ready && !view.ready.includes(me)) void ack(socket, "ready", {});
    });
    socket.on("round", (round: RoundView) => { void (async () => {
      if (round.expectsAnswer === false || (round.onlyPlayers && !round.onlyPlayers.includes(me))) return;
      const base = { roundId: round.roundId, clientUuid: `t-${round.roundId}-${me}` };
      if (round.kind === "dare" || round.kind === "pair_dare") {
        // Only the performer may pass, and only once: this is the night's one
        // dare record, carrying a sentence that names a token, not a person.
        if (passed || (round.performer && round.performer !== me)) return;
        passed = true;
        const reply = await ack<{ ok: boolean; error?: string }>(socket, "submit", { ...base, value: { kind: "dare", status: "passed", reason: REASON } });
        assert.ok(reply.ok, `the performer's pass was accepted: ${reply.error ?? ""}`);
        return;
      }
      if (round.kind === "verdict" && round.voteOpensAt && Date.now() < round.voteOpensAt) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, round.voteOpensAt! - Date.now()) + 20));
      }
      const value = round.kind === "pick" || round.kind === "verdict" ? { kind: "pick", target: ids.find((id) => id !== me) }
        : round.kind === "shout" ? { kind: "shout", word: "chaos" }
        : round.kind === "rating" ? { kind: "rating", trait: round.trait, about: round.about, value: 6 }
        : round.kind === "ios" ? { kind: "ios", about: round.about, value: 4 }
        : round.kind === "minigame" ? { kind: "minigame", score: 40 }
        : { kind: "text", text: "a plain answer" };
      await ack(socket, "submit", { ...base, value });
    })(); });
  });

  host.emit("start");
  const started = Date.now();
  while (!finale && Date.now() - started < 25_000) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(passed, "a dare round reached its performer");
  assert.ok(finale, "the night reached its finale");

  const log: LogRecord[] = readdirSync(dir).filter((file) => file.endsWith(".jsonl"))
    .flatMap((file) => readFileSync(join(dir, file), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as LogRecord));
  const pass = log.find((record) => record.value.kind === "dare" && (record.value as { status?: string }).status === "passed");
  assert.ok(pass, "the pass reason reached the log");
  const stored = (pass!.value as { reason: string }).reason;
  const players = (views.at(-1)?.players ?? []).map((player) => ({ id: player.id, alias: player.alias }));
  assert.equal(stored.replace(/\u200B/g, ""), REASON, "the guest's words are stored verbatim");
  assert.equal(restoreAliases(stored, players), stored, "a typed token is never rebound to a seat");

  const dodge = (finale?.slides ?? []).find((slide) => slide.flavor === "dodge");
  assert.ok(dodge, "the pass reason is published as a dodge");
  assert.match(dodge!.body ?? "", /Player 2 should do this instead of me/);
  assert.doesNotMatch(dodge!.body ?? "", /Ben/, "the sentence never named Ben");
  assert.deepEqual(errors, [], "no submission was refused");
});
