import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, FinaleView, JoinReply, LogRecord, ResponseValue, RoundView, SecretDeckView, ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { createGameServer } from "../src/server.ts";
import { fallbackServices, type GameServices } from "../src/services.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = <T>(promise: Promise<T>, ms = 8000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const once = <T>(s: Client, event: string): Promise<T> => new Promise((resolve) => (s as any).once(event, resolve));
async function connected(base: string): Promise<Client> {
  const s: Client = io(base, { transports: ["polling", "websocket"], forceNew: true, reconnection: false, autoConnect: false });
  s.on("error", () => {});
  // Simulated phones press ready the moment a reveal is pending (ROUND 4).
  s.on("state", (view) => { if (view.ready) s.emit("ready"); });
  const done = once<void>(s, "connect"); s.connect(); await deadline(done); return s;
}
const create = (s: Client, alias: string): Promise<JoinReply & { code?: string }> => new Promise((resolve) => s.emit("create", { alias, consent, profile }, resolve));
const joinRoom = (s: Client, code: string, alias: string, optIn = true, resume?: { playerId: string; secret: string }): Promise<JoinReply> =>
  new Promise((resolve) => s.emit("join", { roomCode: code, alias, consent: { ...consent, revealOptIn: optIn }, profile, ...(resume ? { resume } : {}) }, resolve));
const ackSubmit = (s: Client, payload: { roundId: string; clientUuid: string; value: ResponseValue }): Promise<{ok: boolean; error?: string}> => new Promise((resolve) => s.emit("submit", payload, resolve));

test("five real sockets complete all rounds; public finale is identical; private decks and reconnect are isolated", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-full-"));
  const captured: string[] = [];
  const services: GameServices = {
    ...fallbackServices,
    computeSignals(log, meta) { captured.push(JSON.stringify({ log, meta })); return fallbackServices.computeSignals(log, meta); },
    buildSecrets(_results, _digest, _meta) {
      return new Map([
        ["p1", [{ id: "only-p1", kind: "stat", title: "Player 1's secret", facts: ["PRIVATE_SECRET_ONE"] }]],
        ["p3", [{ id: "only-p3", kind: "stat", title: "Player 3's secret", facts: ["PRIVATE_SECRET_THREE"] }]],
        ["p5", [{ id: "unconsented", kind: "stat", title: "Not allowed", facts: ["PRIVATE_SECRET_FIVE"] }]],
      ]);
    },
    async writeFinale(slides, decks, results, digest) {
      assert.equal(decks.size, 0, "public narration never sees the secret decks");
      assert.ok(results.claims.every((c) => c.audience === "public"));
      captured.push(JSON.stringify({ slides, results, digest }));
      return { slides: slides.map((slide) => slide.flavor === "quote" || slide.flavor === "dodge" ? { ...slide, title: "Fabricated attribution", body: "A fabricated version." } : slide), decks };
    },
  };
  const server = createGameServer({ dataDir: dir, services, revealHoldMs: 5, interludeHoldMs: 5, roundTimers: { pick: 1500, shout: 1500, minigame: 1500, rating: 1500, ios: 1500, text: 1500, dare: 1500, pair_dare: 1500, debrief: 1500, spotlight: 1500, verdict: 1500 }, verdictDiscussMs: 0, graceMs: 50 });
  const port = await server.listen(0, "127.0.0.1", false), base = `http://127.0.0.1:${port}`;
  const clients: Client[] = [];
  t.after(async () => { for (const c of clients) c.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < 5; i++) clients.push(await connected(base));
  const aliases = ["Alice.*", "Brian", "Chao", "Diana", "Emanuel"];
  const first = await create(clients[0]!, aliases[0]!); assert.equal(first.ok, true); assert.ok(first.code && first.secret && first.you);
  const replies: JoinReply[] = [first];
  for (let i = 1; i < clients.length; i++) replies.push(await joinRoom(clients[i]!, first.code!, aliases[i]!, i !== 4));
  assert.ok(replies.every((r) => r.ok));
  const ids = replies.map((r) => r.you!);
  const phases = new Set<string>(), kinds = new Set<string>(), reveals: unknown[] = [], interludes: unknown[] = [], errors: string[] = [];
  const decks: SecretDeckView[][] = clients.map(() => []);
  const finals: Promise<FinaleView>[] = [];
  const answered = clients.map(() => new Set<string>());
  const interactions = new Map<string, number>();
  const key = (a: string, b: string): string => [a, b].sort().join("|");
  let pairChecked = false, duplicateChecked = false, spectatorChecked = false, emptyTargetChecked = false;
  for (let i = 0; i < clients.length; i++) {
    const socket = clients[i]!, myId = ids[i]!;
    socket.on("secrets", (deck) => decks[i]!.push(deck));
    finals.push(once<FinaleView>(socket, "finale"));
    if (i === 0) {
      socket.on("reveal", (view) => reveals.push(view));
      socket.on("interlude", (view) => interludes.push(view));
    }
    socket.on("round", (round: RoundView) => {
      phases.add(round.phase); kinds.add(round.kind);
      if (i === 0 && round.kind === "pair_dare") {
        const actual = interactions.get(key(...round.onlyPlayers as [string, string])) ?? 0;
        let min = Infinity;
        for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) min = Math.min(min, interactions.get(key(ids[a]!, ids[b]!)) ?? 0);
        if (actual !== min) errors.push(`pair interaction count ${actual}, expected ${min}`);
        pairChecked = true;
      }
      if (round.onlyPlayers && !round.onlyPlayers.includes(myId)) {
        if (!spectatorChecked && round.kind === "pair_dare") {
          spectatorChecked = true;
          void ackSubmit(socket, { roundId: round.roundId, clientUuid: "spectator-attempt", value: { kind: "dare", status: "done" } }).then((result) => { if (result.ok) errors.push("spectator was allowed to answer"); });
        }
        return;
      }
      if (round.youSubmitted || answered[i]!.has(round.roundId)) return;
      answered[i]!.add(round.roundId);
      if (i === 0 && round.kind === "ios") {
        emptyTargetChecked = true;
        void ackSubmit(socket, { roundId: round.roundId, clientUuid: "empty-target", value: { kind: "ios", about: "", value: 4 } }).then((result) => { if (result.ok) errors.push("empty IOS target accepted"); });
      }
      const target = ids[i % 2 === 0 && i < 4 ? i + 1 : i % 2 === 1 ? i - 1 : 0]!;
      let value: ResponseValue;
      switch (round.kind) {
        case "pick": value = { kind: "pick", target }; break;
        case "shout": value = { kind: "shout", word: i < 3 ? "chaos" : "vibes" }; break;
        case "text": value = { kind: "text", text: "Alice.* always turns a difficult evening into a funny story." }; break;
        case "debrief": value = { kind: "text", text: `PRIVATE_DEBRIEF_${i} this must not appear in public.` }; break;
        case "rating": value = { kind: "rating", trait: round.trait!, about: round.about!, value: 7 }; break;
        case "ios": value = { kind: "ios", about: round.about!, value: 5 }; break;
        case "minigame": value = { kind: "minigame", score: 20 + i }; break;
        case "dare": value = i === 0 ? { kind: "dare", status: "passed", reason: "Alice.* is watching." } : { kind: "dare", status: "done" }; break;
        case "pair_dare": value = { kind: "dare", status: "done" }; break;
        case "spotlight": value = { kind: "text", text: `Live caption number ${i}.` }; break;
        case "verdict": value = { kind: "pick", target }; break;
      }
      const directed = value.kind === "pick" ? value.target : value.kind === "ios" ? value.about : value.kind === "rating" && value.about !== "self" ? value.about : undefined;
      if (directed) interactions.set(key(myId, directed), (interactions.get(key(myId, directed)) ?? 0) + 1);
      const request = { roundId: round.roundId, clientUuid: `player-${i}-${round.roundId}`, value };
      void ackSubmit(socket, request).then((result) => { if (!result.ok) errors.push(result.error ?? "submit failed"); });
      if (i === 0 && !duplicateChecked) {
        duplicateChecked = true;
        void ackSubmit(socket, request).then((result) => { if (!result.ok) errors.push("idempotent retry rejected"); });
      }
    });
  }
  clients[0]!.emit("start");
  const allFinales = await deadline(Promise.all(finals), 10000);
  await wait(40);
  assert.deepEqual(errors, []);
  assert.ok(pairChecked && duplicateChecked && spectatorChecked && emptyTargetChecked);
  assert.deepEqual([...kinds].sort(), ["dare", "debrief", "ios", "minigame", "pair_dare", "pick", "rating", "shout", "text", "spotlight", "verdict"].sort());
  assert.deepEqual([...phases].sort(), ["warmup", "spicy", "deep", "dare", "debrief"].sort());
  for (const finale of allFinales) assert.deepEqual(finale, allFinales[0]);
  assert.ok(allFinales[0]!.slides.some((slide) => slide.flavor === "quote" && slide.body === "Alice.* always turns a difficult evening into a funny story."));
  assert.ok(allFinales[0]!.slides.some((slide) => slide.flavor === "dodge" && slide.body === "Alice.* is watching."));
  assert.ok(!JSON.stringify(allFinales).includes("fabricated"));
  assert.deepEqual(decks.map((d) => d.length), [1, 0, 1, 0, 0]);
  assert.equal(decks[0]![0]!.cards[0]!.facts[0], "PRIVATE_SECRET_ONE");
  assert.equal(decks[2]![0]!.cards[0]!.facts[0], "PRIVATE_SECRET_THREE");
  assert.ok(!JSON.stringify({ allFinales, reveals, interludes }).includes("PRIVATE_SECRET"));
  assert.ok(!JSON.stringify({ allFinales, reveals, interludes }).includes("PRIVATE_DEBRIEF"));
  assert.ok(captured.length >= 2);
  for (const payload of captured) assert.ok(!payload.includes("Alice.*"), "real alias must not reach a service");
  assert.ok(!captured.at(-1)!.includes("PRIVATE_DEBRIEF"), "private debriefs never reach public writer");
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl")); assert.equal(files.length, 1);
  const rawLog = readFileSync(join(dir, files[0]!), "utf8");
  assert.ok(!rawLog.includes("PRIVATE_SECRET"));
  const records: LogRecord[] = rawLog.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(records.length, 103); // 68 question answers + 4 spotlights × 5 + 3 verdicts × 5
  assert.ok(records.every((r) => r.coding && r.latencyMs >= 0));
  assert.equal(records.filter((r) => r.roundId === records[0]!.roundId && r.playerId === ids[0]).length, 1, "retry persisted exactly once");
  assert.equal(records.filter((r) => r.roundKind === "debrief").length, 4);
  assert.ok(records.some((r) => r.value.kind === "dare" && r.value.status === "passed" && !!r.value.reason));

  const resumed = await connected(base); clients.push(resumed);
  const resumedFinale = once<FinaleView>(resumed, "finale"), resumedDeck = once<SecretDeckView>(resumed, "secrets");
  const resumeReply = await joinRoom(resumed, first.code!, aliases[0]!, true, { playerId: ids[0]!, secret: first.secret! });
  assert.ok(resumeReply.ok && resumeReply.secret && resumeReply.secret !== first.secret);
  assert.equal(resumeReply.state?.phase, "finale");
  assert.deepEqual(await deadline(resumedFinale), allFinales[0]);
  assert.deepEqual(await deadline(resumedDeck), decks[0]![0]);
  const replay = await connected(base); clients.push(replay);
  const rejected = await joinRoom(replay, first.code!, aliases[0]!, true, { playerId: ids[0]!, secret: first.secret! });
  assert.equal(rejected.ok, false, "rotated token cannot be replayed");
  const deleted = once<void>(resumed, "deleted");
  clients[3]!.emit("delete_room"); // any player, not only the host
  await deadline(deleted);
  assert.deepEqual(readdirSync(dir), []);
});
