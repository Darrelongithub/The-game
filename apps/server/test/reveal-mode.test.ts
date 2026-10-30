// apps/server/test/reveal-mode.test.ts
// REVEAL_MODE — one env switch, two ways to run a night. DEFAULT-OFF.
//
//   "round"  (default) — today's night, byte-for-byte: every closed round is
//                        revealed on every phone and on the display, behind the
//                        ready gate.
//   "finale"           — per-round reveals are SUPPRESSED and QUEUED; the ready
//                        gate is bypassed mid-game (rounds advance on the gate's
//                        grace exactly as if the reveal had fired) and the whole
//                        night's reel is delivered to the DISPLAY role, in round
//                        order, at finale start. The phone finale is untouched.
//
// These tests pin:
//   1. the env parser: unset/empty/typo ⇒ "round" (a bad env line can never
//      change a night), "finale" is the only way in;
//   2. the golden "round" night: per-round reveals still fire, the gate still
//      parks a reveal, and no night queue is ever written;
//   3. the "finale" night: no per-round reveal anywhere, the queue lengthens by
//      exactly one per round in round order, the gate never parks, and the
//      display receives the full reel immediately before the finale;
//   4. a mid-night restart replays the queue intact (same entries, same order);
//   5. determinism: the queue is a pure function of its log — same lines ⇒
//      deeply equal queue, line order irrelevant, junk/duplicates dropped.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents, FinaleView, JoinReply, ResponseValue, RevealView, RoomView, RoundKind, RoundView,
  ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { createGameServer, type GameServer } from "../src/server.ts";
import { canonicalQueuedReveals, resolveRevealMode, revealQueueFile } from "../src/game.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const limit = <T>(promise: Promise<T>, ms = 15_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const event = <T>(client: Client, name: string, predicate: (payload: T) => boolean = () => true): Promise<T> =>
  new Promise((resolve) => {
    const handler = (data: T): void => { if (predicate(data)) { (client as any).off(name, handler); resolve(data); } };
    (client as any).on(name, handler);
  });

const ALL_KINDS: RoundKind[] = ["pick", "text", "shout", "rating", "ios", "minigame", "dare", "pair_dare", "debrief", "spotlight", "verdict", "confess"];
const fastTimers = (ms: number): Record<RoundKind, number> =>
  Object.fromEntries(ALL_KINDS.map((kind) => [kind, ms])) as Record<RoundKind, number>;
const connect = async (base: string, clients: Client[]): Promise<Client> => {
  const socket: Client = io(base, { forceNew: true, transports: ["polling", "websocket"], reconnection: false, autoConnect: false });
  socket.on("error", () => {});
  clients.push(socket);
  const opened = event<void>(socket, "connect");
  socket.connect();
  await limit(opened);
  return socket;
};

/** One line of the night queue, as it sits on disk. */
interface QueueLine { index: number; roundId: string; reveal: RevealView; }
const queueLines = (dir: string): QueueLine[] => {
  const name = readdirSync(dir).find((entry) => entry.endsWith(".reveals.log"));
  if (!name) return [];
  return readFileSync(join(dir, name), "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as QueueLine);
};

interface Night {
  server: GameServer; dir: string; code: string; host: Client; display: Client;
  /** Every round the host's phone was shown, in order (deduped by roundId). */
  rounds: RoundView[];
  /** Reveals the host's PHONE received — 0 for the whole night in finale mode. */
  hostReveals: RevealView[];
  /** Everything the DISPLAY received, in arrival order. */
  displayLog: { name: string; payload: unknown }[];
  displayReveals: RevealView[];
  states: RoomView[];
  /** The finale the DISPLAY received. */
  finale: FinaleView;
  /** The finale the host's PHONE received — must be identical. */
  hostFinale: FinaleView;
}

/**
 * A four-seat night (host + three bots) with a display joined, driven to the
 * ending. The host answers every round it is asked; in "round" mode it also
 * taps ready the moment a reveal is pending, so the golden night stays fast.
 */
async function playNight(
  t: { after: (fn: () => Promise<void> | void) => void },
  options: { revealMode: "round" | "finale"; readyGraceMs?: number; roundMs?: number; autoReady?: boolean; answerAsHost?: boolean },
): Promise<Night> {
  const dir = mkdtempSync(join(tmpdir(), "reveal-mode-"));
  const server = createGameServer({
    dataDir: dir,
    revealMode: options.revealMode,
    roundTimers: fastTimers(options.roundMs ?? 200),
    verdictDiscussMs: 0, graceMs: 40, revealHoldMs: 20, interludeHoldMs: 10,
    readyGraceMs: options.readyGraceMs ?? 25, botDelayMs: [5, 15],
  });
  const port = await server.listen(0, "127.0.0.1", false), base = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) client.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });

  const host = await connect(base, clients), display = await connect(base, clients);
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, profile }, resolve));
  assert.equal(made.ok, true);
  const myId = made.you!;
  const joined = await new Promise<{ ok: boolean }>((resolve) => display.emit("display_join", { roomCode: made.code! }, resolve));
  assert.equal(joined.ok, true);
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  await wait(40);

  const night = { server, dir, code: made.code!, host, display, rounds: [], hostReveals: [], displayLog: [], displayReveals: [], states: [] } as unknown as Omit<Night, "finale" | "hostFinale">;
  let others: string[] = [];
  host.on("state", (view) => {
    night.states.push(view);
    others = view.players.filter((player) => player.id !== myId).map((player) => player.id);
    if (view.ready && options.autoReady !== false) host.emit("ready");
  });
  display.on("state", (view) => night.displayLog.push({ name: "state", payload: view }));
  display.on("round", (round) => night.displayLog.push({ name: "round", payload: round }));
  display.on("interlude", (interlude) => night.displayLog.push({ name: "interlude", payload: interlude }));
  display.on("reveal", (reveal) => { night.displayReveals.push(reveal); night.displayLog.push({ name: "reveal", payload: reveal }); });
  display.on("finale", (finale) => night.displayLog.push({ name: "finale", payload: finale }));
  host.on("reveal", (reveal) => night.hostReveals.push(reveal));
  host.on("round", (round: RoundView) => {
    if (!night.rounds.some((seen) => seen.roundId === round.roundId)) night.rounds.push(round);
    if (options.answerAsHost === false) return;
    if (round.youSubmitted || round.expectsAnswer === false) return;
    if (round.onlyPlayers && !round.onlyPlayers.includes(myId)) return;
    const value: ResponseValue = round.kind === "shout" ? { kind: "shout", word: "chaos" }
      : round.kind === "confess" ? { kind: "confess", yes: true, note: "Yes, and I would do it again." }
      : round.kind === "text" || round.kind === "spotlight" ? { kind: "text", text: "An answer from the host seat." }
      : round.kind === "debrief" ? { kind: "text", text: "The pair debrief stayed private." }
      : round.kind === "rating" ? { kind: "rating", trait: round.trait!, about: round.about!, value: 6 }
      : round.kind === "ios" ? { kind: "ios", about: round.about!, value: 5 }
      : round.kind === "minigame" ? { kind: "minigame", score: 12 }
      : round.kind === "dare" || round.kind === "pair_dare" ? { kind: "dare", status: "done" }
      : { kind: "pick", target: others[0] ?? "p2" };
    host.emit("submit", { roundId: round.roundId, clientUuid: `host:${round.roundId}`, value }, () => {});
  });
  const hostFinale = event<FinaleView>(host, "finale");
  host.emit("start");
  const finale = await limit(event<FinaleView>(display, "finale"), 25_000);
  return { ...night, finale, hostFinale: await limit(hostFinale, 10_000) } as Night;
}

// ---------------------------------------------------------------------------
// 1. The switch itself. Anything unusable is today's night.
// ---------------------------------------------------------------------------
test("REVEAL_MODE resolves to today's night unless it says finale", () => {
  assert.equal(resolveRevealMode(undefined), "round", "unset ⇒ round");
  assert.equal(resolveRevealMode(""), "round", "empty ⇒ round");
  assert.equal(resolveRevealMode("  round "), "round");
  assert.equal(resolveRevealMode("FINALe"), "finale", "case/space tolerant");
  assert.equal(resolveRevealMode("final"), "round", "a typo can never change a game night");
  assert.equal(resolveRevealMode(42), "round", "non-strings are ignored");
  // The queue lives beside the room log and never pretends to be one.
  assert.equal(revealQueueFile("1700000000000-abc.jsonl"), "1700000000000-abc.reveals.log");
});

test("the env var reaches the room manager; no option means no change", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-mode-env-"));
  const server = createGameServer({ dataDir: dir });
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  assert.equal(server.rooms.revealMode, resolveRevealMode(process.env.REVEAL_MODE));
  const previous = process.env.REVEAL_MODE, other = mkdtempSync(join(tmpdir(), "reveal-mode-env2-"));
  try {
    process.env.REVEAL_MODE = "finale";
    const flipped = createGameServer({ dataDir: other });
    assert.equal(flipped.rooms.revealMode, "finale");
    await flipped.close();
  } finally {
    rmSync(other, { recursive: true, force: true });
    if (previous === undefined) delete process.env.REVEAL_MODE; else process.env.REVEAL_MODE = previous;
  }
});

// ---------------------------------------------------------------------------
// 2. GOLDEN "round" NIGHT — the default is byte-for-byte today's night.
// ---------------------------------------------------------------------------
test('"round" mode: per-round reveals still fire, the gate still parks, no queue is written', { timeout: 40_000 }, async (t) => {
  const night = await playNight(t, { revealMode: "round" });
  assert.ok(night.rounds.length >= 10, `a full night ran (${night.rounds.length} rounds)`);
  // Reveals fired per round, on the phone AND the display, exactly as today.
  assert.ok(night.hostReveals.length >= 1, "the phone still gets per-round reveals");
  const revealIds = night.displayReveals.map((reveal) => reveal.roundId);
  assert.ok(revealIds.length >= night.rounds.length, "the display saw a reveal for (at least) every round");
  assert.ok(revealIds.every((id) => night.rounds.some((round) => round.roundId === id)), "each reveal belongs to a real round");
  // The ready gate really parked at least one reveal (the `ready` list rode a snapshot).
  assert.ok(night.states.some((view) => view.ready), "the ready gate is live in round mode");
  // No night queue exists — round mode is untouched on disk.
  assert.deepEqual(readdirSync(night.dir).filter((name) => name.endsWith(".reveals.log")), [], "round mode writes no queue");
  // The phone finale is the real finale.
  assert.deepEqual(night.hostFinale, night.finale, "no private material rides the public finale");
  assert.ok(night.finale.slides.length > 0);
});

// ---------------------------------------------------------------------------
// 3. "finale" NIGHT — nothing per-round, everything at the end, gate bypassed.
// ---------------------------------------------------------------------------
test('"finale" mode: no per-round reveal, queue = rounds in round order, display gets the reel at the finale', { timeout: 40_000 }, async (t) => {
  const night = await playNight(t, { revealMode: "finale" });
  assert.equal(night.server.rooms.revealMode, "finale");
  assert.ok(night.rounds.length >= 10, `a full night ran (${night.rounds.length} rounds)`);

  // 1. Nothing per-round reached a phone.
  assert.deepEqual(night.hostReveals, [], "phones get NO per-round reveal in finale mode");
  // 2. The gate never parked mid-game — rounds advanced on the grace timer.
  assert.ok(night.states.every((view) => view.ready === undefined), "the ready gate is bypassed mid-game");
  // 3. No display reveal arrived before the night was over: the first one comes
  //    after the last round event, i.e. it is the finale reel, not a live reveal.
  const lastRound = night.displayLog.map((entry) => entry.name).lastIndexOf("round");
  const firstReveal = night.displayLog.map((entry) => entry.name).indexOf("reveal");
  assert.ok(firstReveal > lastRound, "the reel starts only after the last round");

  // 4. The queue is exactly the night: one entry per round, in round order.
  const lines = queueLines(night.dir);
  assert.equal(lines.length, night.rounds.length, "queue length = rounds played");
  assert.deepEqual(lines.map((line) => line.roundId), night.rounds.map((round) => round.roundId), "queue is in round order");
  assert.deepEqual(lines.map((line) => line.index), night.rounds.map((round) => round.index), "queue keeps the round index");
  // 5. The display received the whole reel, in round order, immediately before the finale.
  assert.deepEqual(night.displayReveals.map((reveal) => reveal.roundId), lines.map((line) => line.roundId), "display got the full queue in order");
  assert.deepEqual(night.displayReveals, lines.map((line) => line.reveal), "the delivered reel IS the persisted queue");
  const finaleAt = night.displayLog.map((entry) => entry.name).indexOf("finale");
  const lastRevealAt = night.displayLog.map((entry) => entry.name).lastIndexOf("reveal");
  assert.ok(lastRevealAt < finaleAt, "the reel lands before the finale event");
  // 6. The phone finale is identical to the display's: no queue, no extras.
  assert.deepEqual(night.hostFinale, night.finale);
});

// ---------------------------------------------------------------------------
// 3b. THE QUEUE IS INVISIBLE — and it dies with its room.
// ---------------------------------------------------------------------------
test('"finale" mode: a display that joins mid-night sees no queued reveal', { timeout: 20_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-mode-leak-"));
  const server = createGameServer({
    dataDir: dir, revealMode: "finale", roundTimers: fastTimers(300), verdictDiscussMs: 0,
    graceMs: 40, revealHoldMs: 20, interludeHoldMs: 10, readyGraceMs: 20, botDelayMs: [5, 10],
  });
  const port = await server.listen(0, "127.0.0.1", false), clients: Client[] = [];
  t.after(async () => { for (const client of clients) client.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const host = await connect(`http://127.0.0.1:${port}`, clients);
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, profile }, resolve));
  assert.equal(made.ok, true);
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  await wait(40);
  host.emit("start");
  const started = Date.now();
  while (queueLines(dir).length < 1 && Date.now() - started < 8_000) await wait(20);
  assert.ok(queueLines(dir).length >= 1, "a round closed and its reveal was queued");

  const late = await connect(`http://127.0.0.1:${port}`, clients);
  const leaked: RevealView[] = [];
  late.on("reveal", (reveal) => leaked.push(reveal));
  const ack = await new Promise<{ ok: boolean; state?: RoomView }>((resolve) => late.emit("display_join", { roomCode: made.code! }, resolve));
  assert.equal(ack.ok, true);
  assert.equal(ack.state?.phase !== "finale", true, "the night really is still running");
  await wait(600);
  assert.deepEqual(leaked, [], "the night queue is display-only AND finale-only");
});

test("the night queue is purged with its room, and a live room keeps it", { timeout: 20_000 }, async (t) => {
  let clock = 1_700_000_000_000;
  const dir = mkdtempSync(join(tmpdir(), "reveal-mode-purge-"));
  const server = createGameServer({
    dataDir: dir, revealMode: "finale", now: () => clock, roundTimers: fastTimers(120), verdictDiscussMs: 0,
    graceMs: 20, revealHoldMs: 10, interludeHoldMs: 5, readyGraceMs: 10, botDelayMs: [1, 2],
  });
  const port = await server.listen(0, "127.0.0.1", false), clients: Client[] = [];
  t.after(async () => { for (const client of clients) client.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const host = await connect(`http://127.0.0.1:${port}`, clients);
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, profile }, resolve));
  assert.equal(made.ok, true);
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  await wait(40);
  host.emit("start");
  const started = Date.now();
  while (queueLines(dir).length < 1 && Date.now() - started < 8_000) await wait(20);
  const queue = readdirSync(dir).filter((name) => name.endsWith(".reveals.log"));
  assert.equal(queue.length, 1, "the night wrote its queue beside the room log");
  server.rooms.purge();
  assert.equal(readdirSync(dir).filter((name) => name.endsWith(".reveals.log")).length, 1, "a live room keeps its queue");
  clock += 25 * 60 * 60 * 1000; // past IDLE_TTL_HOURS
  server.rooms.purge();
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".reveals.log")), [], "the queue dies with its room");
  assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith(".jsonl")), [], "…and so does the room log");
});

// ---------------------------------------------------------------------------
// 4. MID-NIGHT RESTART — the queue survives, intact, in round order.
// ---------------------------------------------------------------------------
test('"finale" mode: a mid-night restart replays the queue intact', { timeout: 40_000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-mode-restart-"));
  const servers: GameServer[] = [];
  const clients: Client[] = [];
  t.after(async () => { for (const client of clients) client.disconnect(); for (const server of servers) await server.close(); rmSync(dir, { recursive: true, force: true }); });

  const settings = { dataDir: dir, revealMode: "finale" as const, roundTimers: fastTimers(400), verdictDiscussMs: 0, graceMs: 40, revealHoldMs: 20, interludeHoldMs: 10, readyGraceMs: 15, botDelayMs: [5, 10] as [number, number] };
  const first = createGameServer(settings); servers.push(first);
  const port = await first.listen(0, "127.0.0.1", false);
  const host = await connect(`http://127.0.0.1:${port}`, clients);
  const made = await new Promise<JoinReply & { code?: string }>((resolve) => host.emit("create", { alias: "Host", consent, profile }, resolve));
  assert.equal(made.ok, true);
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  await wait(40);
  // The host never answers: every round runs its timer, so the night is still
  // mid-flight when we pull the plug.
  host.emit("start");
  const started = Date.now();
  while (queueLines(dir).length < 3 && Date.now() - started < 12_000) await wait(20);
  const before = queueLines(dir);
  assert.ok(before.length >= 3, `the night queued ${before.length} reveals before the restart`);
  assert.ok(before.length < 12, "the night really was cut short");
  await first.close();
  host.disconnect();

  // Same data dir, cold start: the queue is restored before the finale runs.
  const second = createGameServer(settings); servers.push(second);
  const restartedPort = await second.listen(0, "127.0.0.1", false);
  const display = await connect(`http://127.0.0.1:${restartedPort}`, clients);
  const reel: RevealView[] = [];
  const finalePromise = event<FinaleView>(display, "finale");
  display.on("reveal", (reveal) => reel.push(reveal));
  const ack = await new Promise<{ ok: boolean; state?: RoomView }>((resolve) => display.emit("display_join", { roomCode: made.code! }, resolve));
  assert.equal(ack.ok, true, "the room survived the restart");
  await limit(finalePromise, 20_000);

  const after = queueLines(dir);
  assert.deepEqual(after, before, "the queue file is untouched by the restart");
  assert.equal(reel.length, before.length, "the display replays the whole restored queue");
  assert.deepEqual(reel.map((reveal) => reveal.roundId), before.map((line) => line.roundId), "restored order is round order");
  assert.deepEqual(reel, before.map((line) => line.reveal), "every restored entry is delivered byte-for-byte");
  assert.deepEqual(canonicalQueuedReveals(after.map((line) => JSON.stringify(line))), canonicalQueuedReveals(before.map((line) => JSON.stringify(line))), "same log ⇒ same queue");
});

// ---------------------------------------------------------------------------
// 5. DETERMINISM — the queue is a pure function of its log.
// ---------------------------------------------------------------------------
test("the queue is deterministic: same lines ⇒ deeply equal queue, order from content", () => {
  const entries = [
    { index: 1, roundId: "room-1", reveal: { roundId: "room-1", summary: "Round complete.", holdMs: 10 } },
    { index: 2, roundId: "room-2", reveal: { roundId: "room-2", summary: "The room has spoken.", items: [{ alias: "A", text: "chaos (2)" }], holdMs: 10 } },
    { index: 3, roundId: "room-3", reveal: { roundId: "room-3", kind: "verdict", summary: "The room decided: A", holdMs: 10 } },
  ];
  const lines = entries.map((entry) => JSON.stringify(entry));
  const first = canonicalQueuedReveals(lines);
  assert.deepEqual(canonicalQueuedReveals(lines), first, "same log ⇒ deeply equal queue");
  assert.deepEqual(canonicalQueuedReveals([...lines].reverse()), first, "line order is irrelevant: the queue is sorted by round");
  assert.deepEqual(canonicalQueuedReveals([lines[2]!, "", "not json", "{}", ...lines.slice(0, 2)]), first, "junk lines are dropped, never crash the night");
  assert.deepEqual(canonicalQueuedReveals([lines[0]!, lines[0]!, ...lines.slice(1)]), first, "a doubled append cannot duplicate a round");
  assert.equal(canonicalQueuedReveals([]).length, 0);

  // A night's real queue round-trips: write it back out and re-read it.
  const dir = mkdtempSync(join(tmpdir(), "reveal-mode-queue-"));
  try {
    const file = join(dir, "1700000000000-0123456789abcdef0123456789abcdef.jsonl");
    writeFileSync(revealQueueFile(file), `${lines.join("\n")}\n`);
    const text = readFileSync(revealQueueFile(file), "utf8");
    assert.deepEqual(canonicalQueuedReveals(text.split("\n")), first);
    assert.deepEqual(canonicalQueuedReveals(readFileSync(revealQueueFile(file), "utf8").split("\n")), first, "a replay is idempotent");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
