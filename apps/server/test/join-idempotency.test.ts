// apps/server/test/join-idempotency.test.ts
// A join whose reply was lost must not lock the player out. The retry carries
// the same join id and gets the same seat — even after Start, when a new join
// is refused.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoomManager } from "../src/room.ts";
import { adultProfile, ManualClock, testServices } from "./helpers.ts";

describe("join idempotency", () => {
  it("returns the same seat and secret to a retried join after Start", async () => {
    const clock = new ManualClock();
    const manager = new RoomManager(null, {
      now: clock.now,
      services: testServices(),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const room = manager.createRoom();

    const first = manager.join(room.code, "Wanjiru", adultProfile, true, "lost-ack-1");
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const secret = first.player.secret;

    for (const alias of ["Dee", "Kofi", "Zuri", "Tayo"]) {
      const result = manager.join(room.code, alias, adultProfile, true);
      assert.equal(result.ok, true);
    }
    await manager.start(room.code);
    assert.equal(room.phase, "play");

    const retried = manager.reclaimJoin(room.code, "lost-ack-1");
    assert.ok(retried, "the retried join reclaims the seat after Start");
    assert.equal(retried!.id, first.player.id);
    assert.equal(retried!.secret, secret, "the secret did not rotate behind the lost ack");
    assert.equal(room.players.size, 5, "the retry takes no second seat");

    const fresh = manager.join(room.code, "Newcomer", adultProfile, true, "brand-new");
    assert.equal(fresh.ok, false, "a genuinely new player is still blocked after Start");
  });

  it("reclaims the same seat mid-game after a tab sleeps", async () => {
    const clock = new ManualClock();
    const manager = new RoomManager(null, {
      now: clock.now,
      services: testServices(),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    const room = manager.createRoom();
    const seats = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo"].map((alias) => {
      const result = manager.join(room.code, alias, adultProfile, true);
      assert.equal(result.ok, true);
      if (!result.ok) throw new Error("unreachable");
      return { alias, player: result.player };
    });
    await manager.start(room.code);
    const sleeping = seats[2]!;
    const reclaimed = manager.reclaim(room.code, sleeping.player.id, sleeping.player.secret);
    assert.ok(reclaimed, "a valid secret reclaims the seat after Start");
    assert.equal(reclaimed!.id, sleeping.player.id);
    assert.equal(room.players.size, 5, "reclaiming does not add a seat");
    const fresh = manager.join(room.code, "Newcomer", adultProfile, true);
    assert.equal(fresh.ok, false, "a new phone is still blocked after Start");
  });

  it("refuses an unknown join id instead of inventing a seat", () => {
    const manager = new RoomManager(null, { services: testServices() });
    const room = manager.createRoom();
    assert.equal(manager.reclaimJoin(room.code, "never-seen"), undefined);
  });
});
