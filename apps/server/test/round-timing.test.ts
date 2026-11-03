// apps/server/test/round-timing.test.ts
// The timer is a CAP, not the pace. A case closes the instant the last
// required person answers — well inside one second — and no ready gate opens
// between cases.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoomManager } from "../src/room.ts";
import type { PlayerId, ResponseValue, RoomView } from "../../../packages/shared/src/contracts.ts";
import type { Segment } from "../src/game.ts";
import { adultProfile, FakeSocket, testServices } from "./helpers.ts";

const ALIASES = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo"];

function makeRand(): () => number {
  let n = 0;
  return () => {
    n += 1;
    return (n * 0.6180339887498949) % 1;
  };
}

function answerFor(segment: Segment, order: PlayerId[], playerId: PlayerId): ResponseValue {
  const other = order.find((id) => id !== playerId)!;
  switch (segment.kind) {
    case "pick":
      return { kind: "pick", target: other };
    case "rating":
      return {
        kind: "rating",
        trait: segment.trait ?? "chaos",
        about: segment.aboutSelf ? "self" : (segment.subjectId ?? "self"),
        value: 7,
      };
    case "dare":
      return { kind: "dare", status: "done" };
    case "pair_vote":
      return { kind: "pair_vote", pair: segment.pair ?? [other, order[1]!], value: 4 };
    case "pair_pick":
      return { kind: "pair_pick", pair: segment.options?.[0]?.members ?? [other, order[1]!] };
    default:
      return { kind: "text", text: "An honest answer." };
  }
}

const waitFor = async (condition: () => boolean, label: string, ms = 2_000): Promise<number> => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > ms) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return Date.now() - started;
};

describe("case timing", () => {
  it("closes within a second of the last answer and opens no gate before the end", { timeout: 10_000 }, async () => {
    const manager = new RoomManager(null, { services: testServices(), rand: makeRand(), seed: 11 });
    const room = manager.createRoom();
    const sockets: FakeSocket[] = [];
    for (const alias of ALIASES) {
      const result = manager.join(room.code, alias, adultProfile, true);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      const socket = new FakeSocket(alias);
      socket.playerId = result.player.id;
      manager.attachSocket(room.code, socket);
      sockets.push(socket);
    }
    await manager.start(room.code);
    assert.equal(room.phase, "play");

    const current = room.current!;
    const answered = new Set<string>();
    let lastAnswerAt = 0;
    for (;;) {
      const stage = current.stage ?? 0;
      const due = current.segments.filter((segment) => (segment.stage ?? 0) === stage);
      const open = due.filter((segment) => !answered.has(segment.id));
      if (open.length === 0) break;
      if (stage === (current.stageCount ?? 1) - 1) lastAnswerAt = Date.now();
      for (const segment of open) {
        for (const playerId of segment.players) {
          const result = manager.submit(room.code, playerId, answerFor(segment, room.order, playerId));
          assert.equal(result.ok, true, result.error);
        }
        answered.add(segment.id);
      }
    }
    assert.ok(lastAnswerAt > 0, "the last stage was answered");

    const elapsed = await waitFor(
      () => sockets[0]!.payloads("beat").length > 0 || room.current?.id !== current.id,
      "the case to close",
    );
    assert.ok(elapsed < 1_000, `the case took ${elapsed}ms to close after the last answer`);
    assert.equal(room.phase, "play", "no results gate between cases");
    for (const socket of sockets) {
      const views = socket.payloads<RoomView>("state");
      assert.equal(
        views.some((view) => view.ready !== undefined && view.ready.length > 0 && view.phase === "play"),
        false,
        "no ready gate between cases",
      );
    }
    manager.deleteRoom(room.code);
  });
});
