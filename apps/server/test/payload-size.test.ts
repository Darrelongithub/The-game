// apps/server/test/payload-size.test.ts
// Eleven 280-character answers, emoji-heavy: no submit is refused and no
// broadcast event breaks on the way back out.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoomManager } from "../src/room.ts";
import type { PlayerId, ResponseValue, RoomView } from "../../../packages/shared/src/contracts.ts";
import type { Segment } from "../src/game.ts";
import { adultProfile, FakeSocket, ManualClock, testServices } from "./helpers.ts";

const ALIASES = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo", "Amina", "Baraka", "Chidi", "Dalila", "Emeka", "Farida"];

/** Exactly TEXT_MAX_CHARS UTF-16 units, but emoji-heavy. */
const EMOJI_ANSWER = "🔥".repeat(140);

function makeRand(): () => number {
  let n = 0;
  return () => {
    n += 1;
    return (n * 0.6180339887498949) % 1;
  };
}

function answerFor(segment: Segment, order: PlayerId[], playerId: PlayerId): ResponseValue {
  const others = order.filter((id) => id !== playerId);
  const other = others[0]!;
  const pair = segment.pair && !segment.pair.includes(playerId) ? segment.pair : [others[0]!, others[1]!] as [PlayerId, PlayerId];
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
      return { kind: "pair_vote", pair, value: 4 };
    case "pair_pick": {
      const option = segment.options?.find((entry) => !entry.members.includes(playerId));
      return { kind: "pair_pick", pair: option?.members ?? pair };
    }
    default:
      return { kind: "text", text: EMOJI_ANSWER };
  }
}

describe("payload size", () => {
  it("plays a full eleven-player night with 280-unit emoji answers and no broken event", async () => {
    assert.equal(EMOJI_ANSWER.length, 280);
    const clock = new ManualClock();
    const manager = new RoomManager(null, {
      now: clock.now,
      services: testServices(),
      rand: makeRand(),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
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

    let textCount = 0;
    let guard = 0;
    while (room.phase === "play" && guard++ < 400) {
      const current = room.current!;
      const stage = current.stage ?? 0;
      for (const segment of current.segments) {
        if ((segment.stage ?? 0) !== stage) continue;
        for (const playerId of segment.players) {
          const value = answerFor(segment, room.order, playerId);
          if (value.kind === "text") textCount += 1;
          const result = manager.submit(room.code, playerId, value);
          assert.equal(result.ok, true, `${segment.id} (${segment.kind}, ${playerId}): ${result.error}`);
        }
      }
      clock.advance(2_000);
    }

    assert.equal(room.phase, "results");
    assert.ok(textCount >= 11, `expected at least eleven text answers, saw ${textCount}`);
    const payload = JSON.stringify(sockets[0]!.last<RoomView>("state"));
    assert.ok(Buffer.byteLength(payload, "utf8") > 200, "the snapshot really carries the text");
    for (const socket of sockets) {
      for (const sent of socket.sent) {
        const size = Buffer.byteLength(JSON.stringify(sent.payload ?? null), "utf8");
        assert.ok(size < 512_000, `${sent.event} grew to ${size} bytes`);
        assert.doesNotThrow(() => JSON.stringify(sent.payload));
      }
    }
  });
});
