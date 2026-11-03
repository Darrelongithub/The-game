// apps/server/test/pair-rotation.test.ts
// Every pair must meet once before any pair meets twice.
//
// The old greedy rotation repeated a pair after only a handful of cases in a
// 4- or 6-player room. These tests pin the round-robin planner and then play a
// real six-player night, printing each round's subject and pairs on failure.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoomManager } from "../src/room.ts";
import { planPairings, type Segment } from "../src/game.ts";
import type { PlayerId, ResponseValue } from "../../../packages/shared/src/contracts.ts";
import { adultProfile, FakeSocket, ManualClock, testServices } from "./helpers.ts";

const ALIASES = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo", "Amina", "Baraka", "Chidi", "Dalila", "Emeka", "Farida"];

function makeRand(): () => number {
  let n = 0;
  return () => {
    n += 1;
    return (n * 0.6180339887498949) % 1;
  };
}

function makeNight(count: number) {
  const clock = new ManualClock();
  const manager = new RoomManager(null, {
    now: clock.now,
    services: testServices(),
    rand: makeRand(),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const room = manager.createRoom();
  for (const alias of ALIASES.slice(0, count)) {
    const result = manager.join(room.code, alias, adultProfile, true);
    assert.equal(result.ok, true, `sign-up failed for ${alias}`);
    if (!result.ok) throw new Error("unreachable");
    const socket = new FakeSocket(alias);
    socket.playerId = result.player.id;
    manager.attachSocket(room.code, socket);
  }
  return { clock, manager, room };
}

function answerFor(segment: Segment, room: { order: PlayerId[] }, playerId: PlayerId): ResponseValue {
  const other = room.order.find((id) => id !== playerId)!;
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
      return { kind: "pair_vote", pair: segment.pair ?? [other, room.order[1]!], value: 4 };
    case "pair_pick":
      return { kind: "pair_pick", pair: segment.options?.[0]?.members ?? [other, room.order[1]!] };
    default:
      return { kind: "text", text: "An honest answer." };
  }
}

/** Ordinary cases only: no ship votes, no best-couple, no dares, no chains. */
function isOrdinary(caseItem: { subjectId?: PlayerId; segments: Segment[] }): boolean {
  return (
    caseItem.subjectId !== undefined &&
    caseItem.segments.some((s) => s.players.length === 2) &&
    !caseItem.segments.some((s) => s.kind === "pair_pick")
  );
}

describe("pair rotation", () => {
  for (const count of [4, 5, 6, 7, 11]) {
    it(`covers all ${(count * (count - 1)) / 2} pairs in a ${count}-player room before repeating one`, () => {
      const order = Array.from({ length: count }, (_, i) => `p${i}`);
      const totalPairs = (count * (count - 1)) / 2;
      const plans = planPairings(order, 12);
      const seen = new Set<string>();
      const repeatsWithUnseen: string[] = [];
      for (const [index, plan] of plans.entries()) {
        const subject = plan.subjectId;
        const inRound = new Set<string>();
        for (const [a, b] of plan.pairs) {
          assert.notEqual(a, subject, `case ${index + 1}: the subject is paired with someone`);
          assert.notEqual(b, subject, `case ${index + 1}: the subject is paired with someone`);
          assert.equal(inRound.has(a), false, `case ${index + 1}: ${a} appears in two pairs`);
          assert.equal(inRound.has(b), false, `case ${index + 1}: ${b} appears in two pairs`);
          assert.equal(a.startsWith("\u0000") || b.startsWith("\u0000"), false, "a dummy seat leaked into a pair");
          inRound.add(a);
          inRound.add(b);
          const key = [a, b].sort().join("+");
          if (seen.has(key) && seen.size < totalPairs) {
            repeatsWithUnseen.push(`case ${index + 1}: ${key} repeated while ${totalPairs - seen.size} pairs were unseen`);
          }
          seen.add(key);
        }
        assert.equal(plan.pairs.length, Math.floor((count - 1) / 2), `case ${index + 1}: wrong slot count`);
      }
      assert.deepEqual(repeatsWithUnseen, []);
      assert.equal(seen.size, totalPairs, "every pair should meet at least once");
    });
  }

  it("is arithmetic, not a bug, that a ten-player room can cover only 44 of 45 pairs in eleven cases", () => {
    const order = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const eleven = planPairings(order, 11);
    const seen = new Set<string>();
    for (const plan of eleven) for (const [a, b] of plan.pairs) seen.add([a, b].sort().join("+"));
    assert.equal(eleven.length * 4, 44, "(n-1)/2 = 4 pairs per case");
    assert.equal(seen.size, 44, "four slots per case cannot reach 45 pairs in eleven cases");

    const twelve = planPairings(order, 12);
    const all = new Set<string>();
    for (const plan of twelve) for (const [a, b] of plan.pairs) all.add([a, b].sort().join("+"));
    assert.equal(all.size, 45, "the twelfth case can schedule the one pair eleven rounds could not fit");
  });

  it("gives a six-player room different questions and a full cast in every case, with no pair twice before all have met", async () => {
    const { clock, manager, room } = makeNight(6);
    await manager.start(room.code);
    const name = (id: PlayerId) => room.players.get(id)?.alias ?? id;
    const seenPairs = new Set<string>();
    const seenPrompts = new Set<string>();
    const trace: string[] = [];
    const problems: string[] = [];
    let firstRepeatWithUnseen = "";

    const inspected = new Set<string>();
    let guard = 0;
    while (room.phase === "play" && guard++ < 400) {
      const current = room.current!;
      if (!inspected.has(current.id) && isOrdinary(current)) {
        inspected.add(current.id);
        const subjectSegments = current.segments.filter((s) => s.players.length === 1);
        if (!subjectSegments.some((s) => s.players[0] === current.subjectId)) {
          problems.push(`${current.id}: the subject has no question of their own`);
        }
        const pairSegments = current.segments.filter((s) => s.players.length === 2);
        const texts = new Set<string>();
        const roundPairs: string[] = [];
        for (const segment of pairSegments) {
          const [a, b] = segment.players as [PlayerId, PlayerId];
          const key = [a, b].sort().join("+");
          if (texts.has(segment.text)) problems.push(`${current.id}: two pairs got the same question`);
          texts.add(segment.text);
          if (seenPairs.has(key) && seenPairs.size < 15 && !firstRepeatWithUnseen) {
            firstRepeatWithUnseen = `case ${current.index + 1}: ${name(a)}+${name(b)} repeated while ${15 - seenPairs.size} pairs were unseen`;
          }
          seenPairs.add(key);
          roundPairs.push(`${name(a)}-${name(b)}`);
        }
        for (const segment of current.segments) {
          if (seenPrompts.has(segment.prompt.id) && segment.prompt.role !== "group") {
            problems.push(`${current.id}: prompt ${segment.prompt.id} was used twice in one night`);
          }
          seenPrompts.add(segment.prompt.id);
        }
        const cast = new Set(current.segments.flatMap((s) => s.players));
        if (cast.size !== room.order.length) {
          problems.push(`${current.id}: ${cast.size}/${room.order.length} players got a question`);
        }
        trace.push(`case ${current.index + 1}: subject=${name(current.subjectId!)} pairs=[${roundPairs.join(", ")}]`);
      }
      const stage = current.stage ?? 0;
      for (const segment of current.segments) {
        if ((segment.stage ?? 0) !== stage) continue;
        for (const playerId of segment.players) manager.submit(room.code, playerId, answerFor(segment, room, playerId));
      }
      clock.advance(2_000);
    }

    assert.deepEqual(problems, [], `six-player night problems:\n${trace.join("\n")}`);
    assert.equal(firstRepeatWithUnseen, "", trace.join("\n"));
    assert.equal(seenPairs.size, 15, `six players should meet all 15 pairs:\n${trace.join("\n")}`);
  });
});
