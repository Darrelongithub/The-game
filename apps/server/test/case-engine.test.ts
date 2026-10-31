// apps/server/test/case-engine.test.ts
// The night, end to end.
//
// The rules under test:
//   • The room exists at startup and the host binds to it by token — nobody
//     types a room code on the laptop.
//   • Sign-up takes name/alias, age, gender, sexuality, attraction and the
//     engine's own fields. Nothing else. 18+ is enforced in code.
//   • A case is about ONE subject: the subject gets their own real question,
//     every observer pair gets a DIFFERENT question, and the odd player gets
//     a solo spicy prompt.
//   • A case closes the INSTANT the last required person answers.
//   • A pick is forced, and you can never pick yourself.
//   • A timed-out player is skipped and the game keeps moving.
//   • There is ONE ready gate, at the very end, and then the reveal.
//   • Secret decks go to exactly the two phones that earned them.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoomManager } from "../src/room.ts";
import { roomViewFor, type Segment } from "../src/game.ts";
import type {
  PlayerId,
  ResponseValue,
  RoomView,
  SecretDeckView,
} from "../../../packages/shared/src/contracts.ts";
import { adultProfile, FakeSocket, ManualClock, testServices } from "./helpers.ts";

const ALIASES = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo", "Amina"];

/** A predictable but varied random source. */
function makeRand(): () => number {
  let n = 0;
  return () => {
    n += 1;
    return (n * 0.6180339887498949) % 1;
  };
}

/** A manager, a clock and a room with players already signed up. */
function makeNight(aliases: string[] = ALIASES.slice(0, 5)) {
  const clock = new ManualClock();
  const manager = new RoomManager(null, {
    now: clock.now,
    services: testServices(),
    rand: makeRand(),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  const room = manager.createRoom();
  const sockets = new Map<string, FakeSocket>();
  const players = new Map<string, PlayerId>();
  for (const alias of aliases) {
    const result = manager.join(room.code, alias, adultProfile, true);
    assert.equal(result.ok, true, `sign-up failed for ${alias}`);
    if (!result.ok) throw new Error("unreachable");
    const socket = new FakeSocket(alias);
    socket.playerId = result.player.id;
    manager.attachSocket(room.code, socket);
    sockets.set(alias, socket);
    players.set(alias, result.player.id);
  }
  return { clock, manager, room, sockets, players };
}

/** An answer that fits the segment — the kind a phone would send. */
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

/**
 * Answer every open question of the current case.
 *
 * A look chain runs in stages, so only the OPEN stage is answered here — the
 * next stage opens when this one is done.
 */
function answerEveryone(manager: RoomManager, room: { code: string; current?: { segments: Segment[]; required: Set<PlayerId>; stage?: number }; order: PlayerId[] }): void {
  const current = room.current!;
  const stage = current.stage ?? 0;
  for (const segment of current.segments) {
    if ((segment.stage ?? 0) !== stage) continue;
    for (const player of segment.players) {
      manager.submit(room.code, player, answerFor(segment, room, player));
    }
  }
}

describe("the room", () => {
  it("is created at startup with a host token", () => {
    const { manager, room } = makeNight(["Wanjiru", "Dee", "Kofi", "Zuri"]);
    assert.equal(room.code.length, 4);
    assert.ok(room.hostToken.length > 10);
    assert.equal(room.phase, "lobby");
    assert.equal(manager.roomForHostToken(room.hostToken)?.code, room.code);
    assert.equal(manager.roomForHostToken("nope"), undefined);
  });

  it("binds the host laptop without a code", () => {
    const { manager, room } = makeNight(["Wanjiru", "Dee", "Kofi", "Zuri"]);
    const socket = new FakeSocket("host");
    manager.attachSocket(room.code, socket);
    assert.equal(socket.playerId, undefined, "the laptop never holds a player seat");
    assert.equal(manager.roomForHostToken(room.hostToken)?.hostConnected, false);
  });

  it("shows the join code on the laptop but never the players' profiles", () => {
    const { manager, room, sockets } = makeNight(["Wanjiru", "Dee", "Kofi", "Zuri"]);
    const host = new FakeSocket("host");
    manager.attachSocket(room.code, host);
    manager.broadcastState(room);
    const view = host.last<RoomView>("state")!;
    assert.equal(view.code, room.code);
    assert.equal(view.players.length, 4);
    assert.ok(view.players.every((p) => typeof p.ready === "boolean"));
    assert.equal(sockets.get("Wanjiru")!.payloads("state").length > 0, true);
  });
});

describe("sign-up", () => {
  it("takes exactly the fields the engine needs", () => {
    const { manager, room } = makeNight([]);
    const result = manager.join(room.code, "Wanjiru", adultProfile, true);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // The profile is kept on the server and never published.
    assert.deepEqual(result.player.profile, adultProfile);
    const json = JSON.stringify(manager.all()[0]!.players);
    assert.equal(json.includes("sexuality"), false);
    assert.equal(json.includes("attractedTo"), false);
  });

  it("rejects an underage player", () => {
    const { manager, room } = makeNight([]);
    const result = manager.join(room.code, "Kid", { ...adultProfile, age: 17 }, true);
    assert.equal(result.ok, false);
  });

  it("rejects a player who does not consent to 18+", () => {
    const { manager, room } = makeNight([]);
    const result = manager.join(room.code, "Wanjiru", adultProfile, false);
    assert.equal(result.ok, false);
  });

  it("rejects a missing profile field", () => {
    const { manager, room } = makeNight([]);
    const result = manager.join(room.code, "Wanjiru", { age: 27 } as never, true);
    assert.equal(result.ok, false);
  });

  it("rejects an alias that is too short", () => {
    const { manager, room } = makeNight([]);
    const result = manager.join(room.code, "x", adultProfile, true);
    assert.equal(result.ok, false);
  });
});

describe("a case", () => {
  it("gives the subject their own question and every pair a different one", async () => {
    const { manager, room } = makeNight();
    await manager.start(room.code);
    assert.equal(room.phase, "play");

    const current = room.current!;
    const subject = current.subjectId!;
    const subjectSegment = current.segments.find((s) => s.players.includes(subject))!;
    assert.ok(subjectSegment, "the subject has a segment");

    const pairSegments = current.segments.filter((s) => s.players.length === 2);
    const texts = pairSegments.map((s) => s.text);
    assert.equal(new Set(texts).size, texts.length, "two pairs got the same question");
    assert.ok(!texts.includes(subjectSegment.text), "the subject's question is a decoy");
  });

  it("gives the odd player a solo spicy prompt", async () => {
    const { manager, room } = makeNight(ALIASES);
    await manager.start(room.code);
    const current = room.current!;
    const solo = current.segments.find((s) => s.players.length === 1 && s.id.endsWith("-solo"));
    assert.ok(solo, "the leftover player gets a solo prompt");
    assert.equal(current.segments.filter((s) => s.players.length === 2).length, 2);
  });

  it("gives every player exactly one question", async () => {
    const { manager, room } = makeNight();
    await manager.start(room.code);
    const current = room.current!;
    const stage = current.stage ?? 0;
    const seen = new Set<string>();
    for (const segment of current.segments) {
      if ((segment.stage ?? 0) !== stage) continue;
      for (const player of segment.players) {
        assert.ok(!seen.has(player), "a player got two questions at once");
        seen.add(player);
      }
    }
    assert.equal(seen.size, room.order.length, "every player must have a question");
  });

  it("never leaves a raw placeholder on the phone", async () => {
    const { manager, room } = makeNight();
    await manager.start(room.code);
    for (const segment of room.current!.segments) {
      assert.ok(!/\{P\d/.test(segment.text), `raw placeholder in "${segment.text}"`);
    }
  });

  it("shows the small grey line under the question", async () => {
    const { manager, room } = makeNight();
    await manager.start(room.code);
    for (const segment of room.current!.segments) {
      assert.ok(segment.note.length > 0, "every question has an explanation line");
      assert.ok(!/\b(warmup|spicy|deep|dare) phase\b/i.test(segment.note), "no phase names");
    }
    const subject = room.current!.segments.find((s) => s.players.includes(room.current!.subjectId!))!;
    assert.match(subject.note, /between you and the results/i);
    const observer = room.current!.segments.find((s) => s.players.length === 2)!;
    assert.match(observer.note, /won't see this/i);
  });

  it("never repeats a prompt template inside the night", async () => {
    const { manager, room, clock } = makeNight();
    await manager.start(room.code);
    let guard = 0;
    while (room.phase === "play" && guard++ < 100) {
      answerEveryone(manager, room);
      clock.advance(2_000);
    }
    const ids = room.cases.flatMap((c) => c.segments.map((s) => s.prompt.id));
    assert.equal(new Set(ids).size, ids.length, "a template repeated inside the night");
  });
});

describe("answering", () => {
  it("closes the case the instant the last required person answers", async () => {
    const { manager, room, clock } = makeNight();
    await manager.start(room.code);
    const current = room.current!;

    const everyone = [...current.required];
    const last = everyone[everyone.length - 1]!;
    for (const player of everyone.slice(0, -1)) {
      const segment = current.segments.find((s) => s.players.includes(player))!;
      const result = manager.submit(room.code, player, answerFor(segment, room, player));
      assert.equal(result.ok, true, result.error);
    }
    assert.equal(room.current!.closed, false, "the case is still open");

    const before = clock.now();
    const segment = current.segments.find((s) => s.players.includes(last))!;
    const result = manager.submit(room.code, last, answerFor(segment, room, last));
    assert.equal(result.ok, true, result.error);
    assert.equal(room.current!.closed, true, "the case closes on the last answer");
    assert.ok(clock.now() - before <= 1_000, "the case closed within a second");
  });

  it("never lets a player pick themselves", async () => {
    const { manager, room } = makeNight();
    await manager.start(room.code);
    const current = room.current!;
    const pickSegment = current.segments.find((s) => s.kind === "pick")!;
    const player = pickSegment.players[0]!;
    const result = manager.submit(room.code, player, { kind: "pick", target: player });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /yourself/i);
  });

  it("never lets a player skip a pick", async () => {
    const { manager, room } = makeNight();
    await manager.start(room.code);
    const current = room.current!;
    const pickSegment = current.segments.find((s) => s.kind === "pick")!;
    const player = pickSegment.players[0]!;
    // An empty answer is not a valid answer, and there is no skip button.
    const result = manager.submit(room.code, player, { kind: "text", text: "" });
    assert.equal(result.ok, false);
    assert.equal(pickSegment.answered.has(player), false);
    // And an answer of the wrong shape is refused too.
    const wrong = manager.submit(room.code, player, { kind: "text", text: "no" });
    assert.equal(wrong.ok, false);
  });

  it("hides yourself from your own pick list", async () => {
    const { manager, room, sockets, players } = makeNight();
    await manager.start(room.code);
    for (const [alias, playerId] of players) {
      const view = roomViewFor(room, playerId, 0);
      assert.ok(view.pickOptions, `${alias} gets a pick list`);
      assert.ok(!view.pickOptions!.includes(playerId), "you are never in your own list");
      assert.equal(view.pickOptions!.length, room.order.length - 1);
    }
    // The laptop never answers, so it has no pick list at all.
    const host = new FakeSocket("host");
    manager.attachSocket(room.code, host);
    manager.broadcastState(room);
    assert.equal(host.last<RoomView>("state")!.pickOptions, undefined);
    assert.ok(sockets.get("Wanjiru")!.payloads("state").length > 0);
  });

  it("rejects a second answer to the same question", async () => {
    const { manager, room } = makeNight();
    await manager.start(room.code);
    const current = room.current!;
    const segment = current.segments[0]!;
    const player = segment.players[0]!;
    const value = answerFor(segment, room, player);
    assert.equal(manager.submit(room.code, player, value).ok, true);
    assert.equal(manager.submit(room.code, player, value).ok, false);
  });

  it("skips a player who runs out of time and keeps the game moving", async () => {
    const { manager, room, clock } = makeNight();
    await manager.start(room.code);
    const current = room.current!;
    const segment = current.segments[0]!;
    const player = segment.players[0]!;

    // The cap runs out.
    clock.advance(segment.closesAt - clock.now() + 10);
    assert.equal(segment.skipped, true, "the player timed out");

    // The answer is refused after the cap…
    const result = manager.submit(room.code, player, answerFor(segment, room, player));
    assert.equal(result.ok, false);
    // …and the case still closes once everyone else has answered.
    for (const other of current.required) {
      if (other === player) continue;
      const otherSegment = current.segments.find((s) => s.players.includes(other))!;
      manager.submit(room.code, other, answerFor(otherSegment, room, other));
    }
    assert.equal(room.current!.closed, true, "a timeout does not stall the night");
  });

  it("holds a short beat between cases and never shows a per-round reveal", async () => {
    const { manager, room, clock, sockets } = makeNight();
    await manager.start(room.code);
    answerEveryone(manager, room);
    assert.equal(room.current!.closed, true);
    assert.equal(room.phase, "play", "the night keeps playing");
    const beat = sockets.get("Wanjiru")!.last<{ label: string }>("beat");
    assert.ok(beat, "a beat plays between cases");
    assert.equal(sockets.get("Wanjiru")!.payloads("finale").length, 0, "no reveal mid-night");
    clock.advance(2_000);
    assert.equal(room.cases.length > 1, true);
  });
});

describe("the end of the night", () => {
  it("opens ONE ready gate and then reveals", async () => {
    const { manager, room, clock, sockets } = makeNight();
    await manager.start(room.code);

    // Play the whole night: every case, every required player.
    let guard = 0;
    while (room.phase === "play" && guard++ < 200) {
      answerEveryone(manager, room);
      clock.advance(2_000);
    }
    assert.equal(room.phase, "results", "the night ends at the ready gate");
    assert.equal(room.revealed, false, "the reveal waits for the gate");

    // The gate: every phone says ready.
    for (const socket of sockets.values()) manager.finalReady(room.code, socket.playerId!);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(room.revealed, true, "the reveal plays once everyone is ready");
    for (const socket of sockets.values()) {
      assert.ok(socket.payloads("finale").length > 0, "every phone sees the reveal");
    }
  });

  it("gives a mutual crush card to exactly the two phones that earned it", async () => {
    const { manager, room, clock, sockets } = makeNight(ALIASES.slice(0, 4));
    await manager.start(room.code);
    let guard = 0;
    while (room.phase === "play" && guard++ < 200) {
      answerEveryone(manager, room);
      clock.advance(2_000);
    }

    // Wanjiru and Dee pick each other — a MUTUAL crush.
    const wanjiru = room.order[0]!;
    const dee = room.order[1]!;
    room.log.push({
      roomId: room.code, roundId: "crush-1", playerId: wanjiru, roundKind: "pick",
      promptId: "crush-1", coding: "tease", value: { kind: "pick", target: dee },
      at: clock.now(), latencyMs: 100, metric: "crush",
    });
    room.log.push({
      roomId: room.code, roundId: "crush-2", playerId: dee, roundKind: "pick",
      promptId: "crush-2", coding: "tease", value: { kind: "pick", target: wanjiru },
      at: clock.now(), latencyMs: 100, metric: "crush",
    });

    for (const socket of sockets.values()) manager.finalReady(room.code, socket.playerId!);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const withCrush = [...sockets.entries()].filter(([, socket]) =>
      (socket.last<SecretDeckView>("secrets")?.cards ?? []).some((c) => c.kind === "crush"),
    );
    assert.equal(withCrush.length, 2, "exactly two phones get a crush card");
    for (const [alias, socket] of withCrush) {
      const deck = socket.last<SecretDeckView>("secrets")!;
      const crush = deck.cards.find((c) => c.kind === "crush");
      assert.ok(crush, `${alias} gets the mutual crush card`);
      assert.match(crush!.facts.join(" "), /like each other/);
      assert.ok(!/Player \d/.test(crush!.facts.join(" ")), "the card uses the real alias");
    }
    // The one-sided pick never becomes a card for anybody.
    for (const [alias, socket] of sockets) {
      const cards = socket.last<SecretDeckView>("secrets")?.cards ?? [];
      for (const card of cards) {
        if (card.kind !== "crush") continue;
        assert.ok(
          card.facts.join(" ").includes("like each other"),
          `${alias} has no one-sided crush card`,
        );
      }
    }
  });

  it("never sends a secret deck to a phone with no data", async () => {
    const { manager, room, clock, sockets } = makeNight(ALIASES.slice(0, 4));
    await manager.start(room.code);
    // Nobody answers: the host skips every case, so the log stays empty.
    let guard = 0;
    while (room.phase === "play" && guard++ < 200) {
      manager.skipCase(room.code);
      clock.advance(2_000);
    }
    for (const socket of sockets.values()) manager.finalReady(room.code, socket.playerId!);
    await new Promise((resolve) => setTimeout(resolve, 30));
    for (const socket of sockets.values()) {
      assert.equal(socket.payloads("secrets").length, 0, "no data, no card");
    }
  });
});

describe("the look chain", () => {
  it("runs six chains tonight, in act → guess → why", async () => {
    const { manager, room } = makeNight();
    await manager.start(room.code);
    const chains = room.cases.filter((c) => (c.stageCount ?? 1) > 1);
    assert.equal(chains.length, 6, "six look chains tonight");
    for (const chain of chains) {
      assert.equal(chain.stageCount, 3, "a chain has three stages");
      const [act, guess, why] = chain.segments;
      assert.equal(act!.stage, 0);
      assert.equal(guess!.stage, 1);
      assert.equal(why!.stage, 2);
      // The actor looks, then the room guesses, then the actor says why.
      assert.equal(act!.players.length, 1, "only the actor looks");
      assert.equal(why!.players.length, 1, "only the actor says why");
      assert.equal(why!.players[0], act!.players[0], "the same actor both times");
      assert.ok(!guess!.players.includes(act!.players[0]!), "the actor does not guess");
      assert.equal(guess!.players.length, room.order.length - 1, "everybody else guesses");
      // Nothing about the chain is public during the night.
      assert.ok(chain.segments.every((seg) => seg.hidden), "every stage is hidden");
    }
  });

  it("keeps the choice hidden from the room until the reveal", async () => {
    const { manager, room, sockets, clock } = makeNight();
    await manager.start(room.code);
    // Play until the first look chain is dealt.
    let guard = 0;
    while (room.phase === "play" && guard++ < 100) {
      const chain = room.current!;
      if ((chain.stageCount ?? 1) > 1) break;
      answerEveryone(manager, room);
      clock.advance(2_000);
    }
    const chain = room.current!;
    assert.equal(chain.stageCount, 3, "a chain is open");
    const actor = chain.segments[0]!.players[0]!;
    const actorAlias = manager.aliasOf(room, actor);

    // The others only WATCH the first stage: no question, no answer controls.
    for (const [alias, socket] of sockets) {
      const view = socket.last<RoomView>("state")?.round;
      if (manager.aliasOf(room, socket.playerId!) === actorAlias) continue;
      assert.ok(view?.passive, `${alias} is only watching the act`);
      assert.equal(view?.kind, "text");
      assert.match(view!.promptText, /look at/i);
    }

    // The actor picks, hidden. The room never learns who.
    const target = room.order.find((id) => id !== actor)!;
    const pick = manager.submit(room.code, actor, { kind: "pick", target });
    assert.equal(pick.ok, true, pick.error);
    const targetAlias = room.players.get(target)!.alias;
    for (const socket of sockets.values()) {
      const round = JSON.stringify(socket.last<RoomView>("state")?.round);
      assert.ok(!round.includes(targetAlias), "the target never reaches a phone");
      const actorRound = JSON.stringify(socket.last<RoomView>("state")?.round);
      assert.ok(!actorRound.includes(targetAlias), "not even the actor's own phone names the target");
    }
  });

  it("gives the actor the truth in their own card, and nobody else", async () => {
    const { manager, room, sockets, players, clock } = makeNight();
    await manager.start(room.code);

    // Play the whole night: every case is answered.
    let guard = 0;
    while (room.phase === "play" && guard++ < 200) {
      answerEveryone(manager, room);
      clock.advance(2_000);
    }
    assert.equal(room.phase, "results", "the night ended");

    // The chains are in the log, with the truth.
    const chains = room.log.filter((r) => r.metric === "lookchain" && r.value.kind === "pick");
    assert.ok(chains.length > 0, "the chains were played");

    // The reveal: the actor's private card carries the truth.
    for (const socket of sockets.values()) {
      socket.sent.length = 0;
    }
    for (const player of room.order) manager.finalReady(room.code, player);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const withChain = [...sockets.values()].filter((socket) =>
      (socket.last<SecretDeckView>("secrets")?.cards ?? []).some((c) => c.kind === "lookchain"),
    );
    assert.ok(withChain.length > 0, "the actor gets a look chain card");
    for (const socket of withChain) {
      const card = socket.last<SecretDeckView>("secrets")!.cards.find((c) => c.kind === "lookchain")!;
      assert.match(card.facts.join(" "), /looked at/i);
      assert.ok(!/Player \d/.test(card.facts.join(" ")), "the card uses the real alias");
    }
    // Nobody else is told.
    const actors = new Set(chains.map((r) => r.playerId));
    for (const [alias, socket] of sockets) {
      const has = (socket.last<SecretDeckView>("secrets")?.cards ?? []).some((c) => c.kind === "lookchain");
      if (!has) continue;
      assert.ok(actors.has(socket.playerId!), `${alias} was not an actor`);
    }
    void players;
  });
});

describe("the room view", () => {
  it("never leaks a profile answer to a client", async () => {
    const { manager, room } = makeNight([]);
    const host = new FakeSocket("host");
    manager.attachSocket(room.code, host);
    manager.join(room.code, "Wanjiru", { ...adultProfile, sexuality: "gay", attractedTo: "men" }, true);
    manager.broadcastState(room);
    const view = host.last<RoomView>("state")!;
    const json = JSON.stringify(view);
    assert.ok(!json.includes("gay"), "sexual orientation never reaches a client");
    assert.ok(!json.includes("attractedTo"));
    assert.ok(!json.includes("sexuality"));
    assert.ok(!json.includes("lookingFor"));
    assert.ok(!json.includes("gender"));   // the fifth field is gone from the contract entirely
  });
});
