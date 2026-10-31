// apps/server/test/server.test.ts
// The wire: the boot banner, the socket protocol, one night over a socket.
//
// The acceptance list this covers:
//   • `npm run host` prints a PLAYER link + QR and a HOST link.
//   • A phone joins with the room code; the laptop binds with the host token.
//   • The laptop never holds a player seat.
//   • One question per phone, with the small grey line under it.
//   • Different pairs get different questions; the subject has their own.
//   • The case closes as soon as the last required person answers.
//   • One ready gate, then the laptop reveal.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { io as ioClient, type Socket } from "socket.io-client";
import { bootBanner, createGameServer } from "../src/server.ts";
import type {
  RoundView,
  RoomView,
  SecretDeckView,
} from "../../../packages/shared/src/contracts.ts";
import { adultProfile, ManualClock, testServices } from "./helpers.ts";

const ALIASES = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo"];

/** A predictable but varied random source. */
function makeRand(): () => number {
  let n = 0;
  return () => {
    n += 1;
    return (n * 0.6180339887498949) % 1;
  };
}

/** Everything a socket has received, in order. */
interface Recorder {
  socket: Socket;
  events: { event: string; payload: unknown }[];
  last<T>(event: string): T | undefined;
  all<T>(event: string): T[];
}

function record(socket: Socket): Recorder {
  const events: { event: string; payload: unknown }[] = [];
  for (const name of ["state", "round", "beat", "finale", "secrets", "deleted"]) {
    socket.on(name, (payload: unknown) => { events.push({ event: name, payload }); });
  }
  return {
    socket,
    events,
    last<T>(event: string): T | undefined {
      const list = events.filter((e) => e.event === event);
      return list.length ? (list[list.length - 1]!.payload as T) : undefined;
    },
    all<T>(event: string): T[] {
      return events.filter((e) => e.event === event).map((e) => e.payload as T);
    },
  };
}

/** Wait until a condition holds (or give up). */
async function waitUntil(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for the server");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Emit and wait for the acknowledgement. */
function ask<T>(socket: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no reply to "${event}"`)), 8_000);
    socket.emit(event as never, payload as never, (reply: T) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

/** The whole server, wired to a manual clock. */
async function bootServer() {
  const clock = new ManualClock();
  const server = createGameServer({
    services: testServices(),
    now: clock.now,
    rand: makeRand(),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const port = await server.listen(0, "127.0.0.1", false);
  const room = server.rooms.nightRoom!;
  const recorders: Recorder[] = [];
  const connect = (): Recorder => {
    const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true });
    const rec = record(socket);
    recorders.push(rec);
    return rec;
  };
  return {
    clock,
    server,
    room,
    connect,
    recorders,
    async close() {
      for (const rec of recorders) rec.socket.disconnect();
      await server.close();
    },
  };
}

/** Let the server breathe, then move the night forward. */
async function tick(clock: ManualClock, ms = 2_000): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 15));
  clock.advance(ms);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * Answer whatever is open on the phones right now.
 *
 * A look chain runs in stages: the actor answers, then everybody else, then
 * the actor again. A phone that is only WATCHING has no answer to give.
 */
async function answerOpen(
  phones: Recorder[],
  roster: string[],
  answered: Set<string>,
): Promise<void> {
  for (let guard = 0; guard < 20; guard++) {
    const views = phones.map((p) => p.last<RoundView>("round")!);
    let pending = 0;
    for (let index = 0; index < phones.length; index++) {
      const view = views[index];
      if (!view || view.passive) continue; // only watching
      const key = `${index}:${view.segmentId}`;
      if (answered.has(key)) continue;
      pending += 1;
      const reply = await ask<{ ok: boolean; error?: string }>(phones[index]!.socket, "submit", {
        roundId: view.roundId,
        value: answerFor(view, roster, roster[index]!),
      });
      assert.equal(reply.ok, true, reply.error);
      answered.add(key);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    if (pending === 0) {
      // Nothing left to answer — either the stage moved on or the case closed.
      const after = phones.map((p) => p.last<RoundView>("round")!);
      const moved = after.some((v, i) => !v || !views[i] || v.segmentId !== views[i]!.segmentId);
      if (!moved) return;
    }
  }
}

/** The answer a phone would send for the question it was given. */
function answerFor(view: RoundView, roster: string[], me: string): unknown {
  const other = roster.find((id) => id !== me)!;
  switch (view.kind) {
    case "pick": return { kind: "pick", target: other };
    case "rating":
      return {
        kind: "rating",
        trait: view.trait ?? "chaos",
        about: view.aboutSelf ? "self" : (view.subjectId ?? "self"),
        value: 7,
      };
    case "dare": return { kind: "dare", status: "done" };
    case "pair_vote": return { kind: "pair_vote", pair: view.pair ?? [other, roster[1]!], value: 4 };
    case "pair_pick": return { kind: "pair_pick", pair: view.options?.[0]?.members ?? [other, roster[1]!] };
    default: return { kind: "text", text: "An honest answer." };
  }
}

describe("the boot banner", () => {
  it("prints a PLAYER link with a QR and a HOST link", () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      bootBanner(
        3001,
        "0.0.0.0",
        { eth0: [{ address: "192.168.1.24", family: "IPv4", internal: false }] } as never,
        { code: "WXYZ", hostToken: "tokentokentokentoken12" },
      );
    } finally {
      console.log = original;
    }
    const out = lines.join("\n");
    assert.match(out, /PLAYER link/i);
    assert.match(out, /http:\/\/192\.168\.1\.24:3001\/\?room=WXYZ/);
    assert.match(out, /HOST link/i);
    assert.match(out, /http:\/\/192\.168\.1\.24:3001\/host\?token=tokentokentokentoken12/);
    assert.match(out, /[█▀▄]/, "a QR code is printed");
  });
});

describe("the wire", () => {
  it("runs a night from join to reveal", async () => {
    const { clock, server, room, connect, close } = await bootServer();
    try {
      // ---- the laptop binds with the host token, no code typed ----
      const host = connect();
      await waitUntil(() => host.socket.connected);
      const hostReply = await ask<{ ok: boolean }>(host.socket, "host_join", { token: room.hostToken });
      assert.equal(hostReply.ok, true, "the host link binds the room");
      const badHost = await ask<{ ok: boolean }>(connect().socket, "host_join", { token: "nope" });
      assert.equal(badHost.ok, false, "a wrong token does not bind");

      // ---- the phones join with the code ----
      const phones: Recorder[] = [];
      for (const alias of ALIASES) {
        const phone = connect();
        await waitUntil(() => phone.socket.connected);
        const reply = await ask<{ ok: boolean; you?: string }>(phone.socket, "join", {
          roomCode: room.code,
          alias,
          profile: adultProfile,
          consent: { age: true },
        });
        assert.equal(reply.ok, true, `${alias} joined`);
        assert.ok(reply.you, "the phone gets its player id");
        phones.push(phone);
      }

      // The laptop sees the roster but holds no seat.
      await waitUntil(() => (host.last<RoomView>("state")?.players.length ?? 0) === ALIASES.length);
      const hostState = host.last<RoomView>("state")!;
      assert.equal(hostState.phase, "lobby");
      assert.equal(hostState.pickOptions, undefined, "the laptop never picks");

      // ---- Start ----
      host.socket.emit("start");
      await waitUntil(() => phones.every((p) => p.all("round").length > 0));
      const views = phones.map((p) => p.last<RoundView>("round")!);

      // One question per phone, with the small grey line under it.
      for (const view of views) {
        assert.ok(view.promptText.length > 0, "a question is on the phone");
        assert.ok(view.note.length > 0, "the grey line is on the phone");
        assert.ok(!/\{P\d/.test(view.promptText), "no raw placeholder");
      }

      // The room does not see one shared question: pairs differ, the subject
      // has their own.
      const questions = new Set(views.map((v) => v.promptText));
      assert.ok(questions.size >= 2, "different groups get different questions");

      // ---- Answer, and the case closes on the last answer ----
      const roster = hostState.players.map((p) => p.id);
      const answered = new Set<string>();
      await answerOpen(phones, roster, answered);

      // The next case arrives after the beat. (Not every phone gets a
      // question in every case — a ship vote leaves the couple out — so the
      // room itself is the witness.)
      const firstRoundId = views[0]!.roundId;
      await tick(clock);
      await waitUntil(() => (host.last<RoomView>("state")?.progress?.index ?? 0) >= 2);
      const moved = phones.some((p) => {
        const round = p.last<RoundView>("round");
        return Boolean(round) && round!.roundId !== firstRoundId;
      });
      assert.ok(moved, "the night moves on");

      // ---- Run the rest of the night (the host skips the cases) ----
      for (let i = 0; i < 60 && server.rooms.get(room.code)!.phase === "play"; i++) {
        host.socket.emit("skip_round");
        await tick(clock);
      }
      assert.equal(server.rooms.get(room.code)!.phase, "results", "the night ends at the gate");

      // ---- ONE ready gate, then the reveal ----
      for (const phone of phones) phone.socket.emit("ready");
      await waitUntil(() => phones.every((p) => p.all("finale").length > 0));
      assert.equal(server.rooms.get(room.code)!.revealed, true);

      // No data, no card: nothing was answered, so nobody gets a deck.
      for (const phone of phones) {
        assert.equal(phone.all<SecretDeckView>("secrets").length, 0, "no card, no deck");
      }
    } finally {
      await close();
    }
  });

  it("refuses a join with a bad code and an underage player", async () => {
    const { room, connect, close } = await bootServer();
    try {
      const phone = connect();
      await waitUntil(() => phone.socket.connected);
      const wrong = await ask<{ ok: boolean }>(phone.socket, "join", {
        roomCode: "ZZZZ", alias: "Wanjiru", profile: adultProfile, consent: { age: true },
      });
      assert.equal(wrong.ok, false, "a bad code does not join");
      const young = await ask<{ ok: boolean }>(phone.socket, "join", {
        roomCode: room.code, alias: "Wanjiru", profile: { ...adultProfile, age: 16 }, consent: { age: true },
      });
      assert.equal(young.ok, false, "an underage player does not join");
      const noConsent = await ask<{ ok: boolean }>(phone.socket, "join", {
        roomCode: room.code, alias: "Wanjiru", profile: adultProfile, consent: { age: false },
      });
      assert.equal(noConsent.ok, false, "no 18+ consent, no seat");
    } finally {
      await close();
    }
  });
});
