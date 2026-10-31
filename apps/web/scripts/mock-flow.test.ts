// apps/web/scripts/mock-flow.test.ts
//   npx -y tsx --tsconfig scripts/tsconfig.test.json scripts/mock-flow.test.ts
// The mock transport walks the whole v3.2 night: lobby → generating → play →
// results → reveal. It is the offline rehearsal of the real server's shape.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BeatView, FinaleView, RoomView, RoundView, SecretDeckView } from "@shared/contracts.ts";
import { MockTransport } from "../src/lib/mockTransport";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("the mock walks a whole v3.2 night", { timeout: 20_000 }, async () => {
  const transport = new MockTransport();
  const states: RoomView[] = [];
  const rounds: RoundView[] = [];
  const beats: BeatView[] = [];
  let finale: FinaleView | undefined;
  let secrets: SecretDeckView | undefined;

  transport.setHandlers({
    onState: (view) => states.push(view),
    onRound: (view) => rounds.push(view),
    onBeat: (beat) => beats.push(beat),
    onFinale: (view) => { finale = view; },
    onSecrets: (deck) => { secrets = deck; },
  });

  // ---- join ----
  const joined = await transport.join({
    roomCode: "MOCK",
    alias: "Wanjiru",
    consent: { age: true, terms: true },
    profile: { age: 27, gender: "woman", sexuality: "straight", attractedTo: "women", lookingFor: "fun" },
  });
  assert.equal(joined.ok, true);
  assert.ok(joined.you);
  assert.equal(states.at(-1)?.phase, "lobby");
  assert.equal(states.at(-1)?.players.length, 5);

  // ---- the lobby tick ----
  transport.lobbyReady(true);
  assert.ok(states.at(-1)?.lobbyReady?.includes(joined.you!));

  // ---- start: the loading screen, then play ----
  transport.start();
  assert.equal(states.at(-1)?.phase, "generating");
  assert.ok(states.at(-1)?.generation);
  await sleep(1100);
  assert.equal(states.at(-1)?.phase, "play");
  assert.equal(rounds.length, 1, "the phone gets ONE question");

  // ---- the question: one question, one grey line ----
  const first = rounds[0]!;
  assert.ok(first.promptText.length > 0);
  assert.ok(first.note.length > 0);
  assert.equal(first.youSubmitted, false);

  // ---- answer it ----
  const answered = await transport.submit({ roundId: first.roundId, clientUuid: "u1", value: { kind: "text", text: "An honest answer." } });
  assert.equal(answered.ok, true);
  await sleep(1000);
  assert.ok(beats.length > 0, "a beat plays between cases");
  assert.equal(rounds.length, 2, "the next case arrives");

  // ---- play the night out ----
  for (let i = 0; i < 20; i++) {
    if (states.at(-1)?.phase === "results") break;
    const round = rounds.at(-1);
    if (!round) break;
    await transport.submit({ roundId: round.roundId, clientUuid: `u${i}`, value: { kind: "text", text: "answer" } });
    await sleep(1000);
  }

  // ---- the ONE ready gate, then the reveal ----
  assert.equal(states.at(-1)?.phase, "results");
  transport.ready();
  assert.ok(finale, "the reveal lands after the gate");
  assert.ok(secrets, "the phone gets its own deck");
  assert.ok(finale!.slides.length > 0);
  transport.disconnect();
});
