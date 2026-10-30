import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import { buildNightDigest, computeResults, computeSignals } from "../../../packages/engine/src/index.ts";
import type { ClientToServerEvents, JoinReply, LogRecord, RevealView, RoomMeta, RoundView, ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { createGameServer } from "../src/server.ts";
import { fallbackServices } from "../src/services.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single", partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" } as const;

function next<T>(socket: Client, name: "round" | "reveal", predicate: (value: T) => boolean = () => true): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.off(name, handler as never); reject(new Error(`Timed out waiting for ${name}`)); }, 5000);
    const handler = (value: T): void => { if (predicate(value)) { clearTimeout(timer); socket.off(name, handler as never); resolve(value); } };
    socket.on(name, handler as never);
  });
}

test("R21: scripted picks stay in scoring and digest, but never become reveal lines", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-r21-"));
  const server = createGameServer({ dataDir: dir, services: fallbackServices, revealHoldMs: 60_000, interludeHoldMs: 60_000 });
  const port = await server.listen(0, "127.0.0.1", false);
  const clients: Client[] = [];
  t.after(async () => { clients.forEach((client) => client.disconnect()); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const replies: JoinReply[] = [];
  for (let index = 0; index < 4; index++) {
    const client = io(`http://127.0.0.1:${port}`, { forceNew: true, reconnection: false, autoConnect: false });
    clients.push(client);
    client.on("state", (state) => { if (state.ready) client.emit("ready"); });
    const connected = next<void>(client, "connect" as never);
    client.connect(); await connected;
    const reply = await new Promise<JoinReply & { code?: string }>((resolve) => index === 0
      ? client.emit("create", { alias: `Picker${index}`, consent, profile }, resolve)
      : client.emit("join", { roomCode: replies[0]!.state!.code, alias: `Picker${index}`, consent, profile }, resolve));
    assert.equal(reply.ok, true); replies.push(reply);
  }
  const host = clients[0]!;
  host.emit("custom_prompts", { lines: [
    "warmup: Who here would you trust with your unlocked phone?",
    "warmup: Who here would you call first after a difficult day?",
  ] });
  const targets = [1, 0, 0, 0];
  for (let index = 0; index < 2; index++) {
    const rounds = clients.map((client) => next<RoundView>(client, "round", (round) => !round.youSubmitted));
    if (index === 0) host.emit("start"); else host.emit("skip_round");
    const views = await Promise.all(rounds);
    assert.ok(views.every((round) => round.kind === "pick" && round.roundId === views[0]!.roundId));
    const reveal = next<RevealView>(host, "reveal");
    await Promise.all(clients.map((client, i) => new Promise<void>((resolve, reject) => client.emit("submit", {
      roundId: views[i]!.roundId, clientUuid: `r21-${index}-${i}`, value: { kind: "pick", target: replies[targets[i]!]!.you! },
    }, (reply) => reply.ok ? resolve() : reject(new Error(reply.error))))));
    const card = await reveal;
    assert.equal(card.roundId, views[0]!.roundId);
    assert.deepEqual(card.items ?? [], [], "picks must not render any reveal lines");
    assert.ok(!/submitted a pick|chose|picked/i.test(JSON.stringify(card)));
  }
  const file = join(dir, readdirSync(dir).find((name) => name.endsWith(".jsonl"))!);
  const log = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as LogRecord);
  assert.equal(log.length, 8);
  assert.ok(log.every((row) => row.value.kind === "pick"));
  const meta: RoomMeta = { roomId: "r21", players: replies.map((reply) => ({ id: reply.you!, alias: reply.state!.players.find((player) => player.id === reply.you)!.alias })), revealOptIn: replies.map((reply) => reply.you!) };
  const signals = computeSignals(log, meta);
  const results = computeResults(signals, log, meta);
  // Three of four eligible voters chose p1 in each neutral (trust-measuring)
  // round. Preserve that consensus and the underlying pair overlap exactly;
  // only the presentation changes. Claim ids contain the random room id.
  assert.deepEqual(results.claims.map(({ type, subjects, confidence, numbers }) => ({ type, subjects, confidence, numbers })), [
    { type: "consensus", subjects: ["p1"], confidence: "med", numbers: { votes: 3, of: 4, share: 0.75 } },
  ], "removing reveal copy must not change Results");
  assert.equal(signals.find((pair) => pair.a === "p3" && pair.b === "p4")?.pickOverlap, 1);
  assert.deepEqual(results, computeResults(computeSignals(log, meta), log, meta));
  assert.ok(buildNightDigest(log, meta).pickTeasers.some((line) => line.includes("8 picks")), "picks still feed the digest");
});
