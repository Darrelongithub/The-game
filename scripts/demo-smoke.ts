// scripts/demo-smoke.ts — ROUND 4 end-to-end: the whole game alone on one laptop.
//
// Talks to a REAL running server over Socket.IO (same origin as the shipped
// build), creates a demo room, puppets three seats, runs the entire night at
// 0.1× speed and asserts:
//   * the room reports `demo: true`;
//   * every reveal is pending first (`state.ready`) and `demo_all_ready`
//     releases it;
//   * the finale lands, is broadcast-safe, and no internal material (a
//     hypothesis, the director, or the impersonation metadata) ever appears;
//   * the demo controls are refused by a real room.
//
//   SMOKE_URL=http://localhost:3001 npx tsx scripts/demo-smoke.ts
import { strict as assert } from "node:assert";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents, FinaleView, JoinReply, RoomView, RoundView, SecretDeckView, ServerToClientEvents,
} from "../packages/shared/src/contracts.ts";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
const address = process.env.SMOKE_URL ?? "http://localhost:3001";
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? "180000");
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const timers: ReturnType<typeof setTimeout>[] = [];
const later = (fn: () => void, ms: number): void => { const timer = setTimeout(fn, ms); timer.unref?.(); timers.push(timer); };
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(resolve, ms); timer.unref?.(); timers.push(timer); });

const errors: string[] = [];
const emitted: unknown[] = [];

async function connect(): Promise<GameSocket> {
  const socket: GameSocket = io(address, { transports: ["polling", "websocket"], reconnection: true, forceNew: true });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  socket.on("error", (error) => {
    // DEMO_ONLY / stale-round refusals are expected in the negative checks below.
    if (!["DEMO_ONLY", "NOT_A_PUPPET", "BAD_PHASE"].includes(error.code)) errors.push(`${error.code}: ${error.message}`);
  });
  socket.onAny((_name: string, payload: unknown) => emitted.push(payload));
  return socket;
}

async function main(): Promise<void> {
  const host = await connect();
  const demo = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, profile, demo: true }, resolve));
  assert.equal(demo.ok, true, "demo room created");
  assert.equal(demo.state?.demo, true, "the room is a demo room");

  const seats: string[] = [];
  for (const alias of ["Maya", "Kofi", "Zuri"]) {
    const reply = await new Promise<{ ok: boolean; playerId?: string }>((resolve) => host.emit("demo_add_player", { alias }, resolve));
    assert.equal(reply.ok, true, `seat ${alias}`);
    seats.push(reply.playerId!);
  }
  host.emit("demo_speed", { scale: 0.1 });
  await sleep(60);

  host.emit("start");

  let readySnapshots = 0;
  let reveals = 0;
  let roundEvents = 0;
  const decks: SecretDeckView[] = [];
  host.on("secrets", (deck) => decks.push(deck));
  const finale = new Promise<FinaleView>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("finale timeout")), timeoutMs);
    timer.unref?.();
    host.once("finale", (view) => { clearTimeout(timer); resolve(view); });
  });
  host.on("state", (view) => {
    if (view.ready) {
      readySnapshots += 1;
      // The host holds every phone: one tap releases everyone.
      later(() => host.emit("demo_all_ready"), 10);
    }
  });
  host.on("reveal", () => { reveals += 1; });
  host.on("round", (round: RoundView) => {
    roundEvents += 1;
    if (round.youSubmitted || round.expectsAnswer === false) return;
    const value = round.kind === "pick" || round.kind === "verdict" ? { kind: "pick" as const, target: seats[0]! }
      : round.kind === "shout" ? { kind: "shout" as const, word: "solo" }
      : round.kind === "rating" ? { kind: "rating" as const, trait: round.trait!, about: round.about!, value: 7 }
      : round.kind === "ios" ? { kind: "ios" as const, about: round.about!, value: 5 }
      : round.kind === "minigame" ? { kind: "minigame" as const, score: 22 }
      : round.kind === "dare" || round.kind === "pair_dare" ? { kind: "dare" as const, status: "done" as const }
      : round.kind === "confess" ? { kind: "confess" as const, yes: true }
      : { kind: "text" as const, text: "One laptop, whole night." };
    host.emit("submit", { roundId: round.roundId, clientUuid: `host-${round.roundId}`, value }, () => {});
  });

  const view = await finale;
  assert.ok(view.slides.length > 3, "a real finale came out of a solo demo night");
  assert.deepEqual(errors, [], "no unexpected server errors");
  assert.ok(readySnapshots > 0, "reveals went through the ready gate");
  assert.ok(reveals > 0, "reveals actually landed");
  const leak = /hypothes|suspect|coverage|"priors"|"director"|openedAt|impersonatedBy|puppet/iu;
  for (const payload of emitted) assert.ok(!leak.test(JSON.stringify(payload)), "no internal material on the wire");
  assert.ok(!JSON.stringify(view).includes("PRIVATE"), "the finale is broadcast-safe");

  // A plain room must refuse the demo console outright.
  const plain = await connect();
  const real = await new Promise<JoinReply & { code?: string }>((resolve) => plain.emit("create", { alias: "Plain", consent, profile }, resolve));
  assert.equal(real.ok, true);
  const refused = await new Promise<{ ok: boolean }>((resolve) => plain.emit("demo_add_player", { alias: "Nope" }, resolve));
  assert.equal(refused.ok, false, "demo controls do not exist in a real room");
  plain.disconnect();

  await sleep(400);
  for (const timer of timers) clearTimeout(timer);
  host.disconnect();
  console.log(`DEMO SMOKE OK — ${roundEvents} round events, ${reveals} reveals, ${readySnapshots} pending-ready snapshots, ${view.slides.length} finale slides`);
}

main().catch((error: unknown) => {
  console.error("DEMO SMOKE FAILED:", error);
  process.exit(1);
});
