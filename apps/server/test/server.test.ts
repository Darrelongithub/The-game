import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { io, type Socket } from "socket.io-client";
import type { ClientToServerEvents, LogRecord, ResponseValue, RoundView, ServerToClientEvents } from "../../../packages/shared/src/contracts.ts";
import { bootBanner, createGameServer, lanAddresses } from "../src/server.ts";
import { fallbackServices, type GameServices } from "../src/services.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const limit = <T>(promise: Promise<T>, ms = 6000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const event = <T>(socket: Client, name: string): Promise<T> => new Promise((resolve) => (socket as any).once(name, resolve));
async function socketFor(port: number): Promise<Client> {
  const socket: Client = io(`http://127.0.0.1:${port}`, { transports: ["polling", "websocket"], reconnection: false, autoConnect: false });
  socket.on("error", () => {}); const ready = event<void>(socket, "connect"); socket.connect(); await limit(ready); return socket;
}

test("same-origin HTTP static export and preview-proxy Socket.IO origins", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-http-")), web = join(dir, "web"), data = join(dir, "data");
  const server = createGameServer({ dataDir: data, webDir: web });
  const port = await server.listen(0, "127.0.0.1", false), base = `http://127.0.0.1:${port}`;
  t.after(async () => { await server.close(); rmSync(dir, { recursive: true, force: true }); });
  let response = await fetch(`${base}/`); assert.equal(response.status, 200); assert.match(await response.text(), /web app has not been built/i);
  mkdirSync(web); writeFileSync(join(web, "index.html"), "<h1>Game export</h1>"); writeFileSync(join(web, "app.js"), "console.log('ok')");
  response = await fetch(`${base}/`); assert.match(await response.text(), /Game export/);
  response = await fetch(`${base}/some/client/route`); assert.match(await response.text(), /Game export/);
  response = await fetch(`${base}/app.js`); assert.match(await response.text(), /console.log/);
  response = await fetch(`${base}/missing.js`); assert.equal(response.status, 404);
  const endpoint = `${base}/socket.io/?EIO=4&transport=polling`;
  response = await fetch(endpoint, { headers: { Origin: "https://evil.example" } }); assert.equal(response.status, 403);
  response = await fetch(endpoint, { headers: { Origin: "https://preview.e2b.app", "X-Forwarded-Host": "preview.e2b.app" } }); assert.equal(response.status, 200);
});

test("LAN banner includes every non-loopback IPv4 URL and a QR code", () => {
  const fake: ReturnType<typeof networkInterfaces> = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true, cidr: "127.0.0.1/8", netmask: "255.0.0.0", mac: "00:00:00:00:00:00" }],
    wifi: [{ address: "192.168.1.20", family: "IPv4", internal: false, cidr: "192.168.1.20/24", netmask: "255.255.255.0", mac: "00:00:00:00:00:01" }],
    hotspot: [{ address: "10.0.0.2", family: "IPv4", internal: false, cidr: "10.0.0.2/24", netmask: "255.255.255.0", mac: "00:00:00:00:00:02" }],
  };
  assert.deepEqual(lanAddresses(fake), ["10.0.0.2", "192.168.1.20"]);
  const original = console.log, output: string[] = [];
  try { console.log = (...args: unknown[]) => output.push(args.join(" ")); bootBanner(3001, "0.0.0.0", fake); } finally { console.log = original; }
  const text = output.join("\n");
  assert.match(text, /http:\/\/localhost:3001/); assert.match(text, /http:\/\/192\.168\.1\.20:3001/); assert.match(text, /http:\/\/10\.0\.0\.2:3001/);
  assert.match(text, /Scan to join/); assert.ok(output.length > 4, "QR code was rendered");
});

test("three built-in bots answer on the production 600–3500ms delay", { timeout: 7000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-bots-delay-")), server = createGameServer({ dataDir: dir });
  const port = await server.listen(0, "127.0.0.1", false), host = await socketFor(port);
  t.after(async () => { host.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const made = await new Promise<any>((resolve) => host.emit("create", { alias: "Host", consent: { age: true, terms: true, revealOptIn: true } }, resolve));
  assert.ok(made.ok);
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  const records = new Promise<LogRecord[]>((resolve) => {
    host.on("state", () => {
      const names = readdirSync(dir); if (!names.length) return;
      const text = readFileSync(join(dir, names[0]!), "utf8").trim();
      const rows: LogRecord[] = text ? text.split("\n").map((line) => JSON.parse(line)) : [];
      if (rows.length >= 3) resolve(rows);
    });
  });
  host.emit("start");
  const rows = await limit(records, 5000);
  assert.equal(rows.length, 3);
  for (const row of rows) { assert.ok(row.latencyMs >= 590, `latency ${row.latencyMs}ms`); assert.ok(row.latencyMs <= 3750, `latency ${row.latencyMs}ms`); assert.equal(row.value.kind, "pick"); }
});

test("one host and three in-server bots can finish the entire game without API keys", { timeout: 10000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-bots-full-"));
  let prepared = false, readBank = false, writerStarted = false;
  const services: GameServices = {
    ...fallbackServices,
    createPromptProvider: () => ({
      forPhase() { readBank = true; throw new Error("provider unavailable"); },
      prepare() { prepared = true; return new Promise<void>(() => {}); },
    }),
    writeFinale() { writerStarted = true; return new Promise(() => {}); },
  };
  const server = createGameServer({ dataDir: dir, services, writerTimeoutMs: 20, botDelayMs: [2, 5], revealHoldMs: 2, interludeHoldMs: 2, verdictDiscussMs: 0, roundTimers: { spotlight: 300, verdict: 300 } });
  const port = await server.listen(0, "127.0.0.1", false), host = await socketFor(port);
  t.after(async () => { host.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const made = await new Promise<any>((resolve) => host.emit("create", { alias: "Host", consent: { age: true, terms: true, revealOptIn: true } }, resolve));
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  const done = event(host, "finale"), seen = new Set<string>();
  host.on("round", (round: RoundView) => {
    if (round.youSubmitted || seen.has(round.roundId) || (round.onlyPlayers && !round.onlyPlayers.includes(made.you))) return;
    seen.add(round.roundId);
    let value: ResponseValue;
    switch (round.kind) {
      case "pick": value = { kind: "pick", target: "p2" }; break;
      case "shout": value = { kind: "shout", word: "vibes" }; break;
      case "text": case "debrief": value = { kind: "text", text: "I enjoyed a great conversation with someone here." }; break;
      case "rating": value = { kind: "rating", trait: "warmth", about: "self", value: 7 }; break;
      case "ios": value = { kind: "ios", about: "p2", value: 5 }; break;
      case "minigame": value = { kind: "minigame", score: 23 }; break;
      case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
      case "spotlight": value = { kind: "text", text: "Watching the room right now." }; break;
      case "verdict": value = { kind: "pick", target: "p2" }; break;
    }
    host.emit("submit", { roundId: round.roundId, clientUuid: `host-${round.roundId}`, value }, () => {});
  });
  host.emit("start"); await limit(done, 5000);
  const rows: LogRecord[] = readFileSync(join(dir, readdirSync(dir)[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const bots = rows.filter((r) => r.playerId !== made.you);
  assert.ok(prepared && readBank && writerStarted, "hung/failed providers were exercised without blocking play");
  assert.ok(bots.length > 30); assert.ok(bots.some((r) => r.roundKind === "pair_dare")); assert.ok(bots.some((r) => r.roundKind === "debrief"));
  assert.ok(bots.every((r) => r.value.kind !== "pick" || r.value.target !== r.playerId));
});


test("delete during pending narration purges data and suppresses late finale/secrets", { timeout: 8000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-delete-pending-"));
  let signalStarted!: () => void, releaseWriter!: () => void;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  const services: GameServices = {
    ...fallbackServices,
    buildSecrets: () => new Map([["p1", [{ id: "private", kind: "stat", title: "Only you", facts: ["PRIVATE_CARD"] }]]]),
    writeFinale(slides, decks) {
      signalStarted();
      return new Promise((resolve) => { releaseWriter = () => resolve({ slides, decks }); });
    },
  };
  const server = createGameServer({ dataDir: dir, services, writerTimeoutMs: 5000, botDelayMs: [10000, 10000], revealHoldMs: 10000, interludeHoldMs: 10000 });
  const port = await server.listen(0, "127.0.0.1", false), host = await socketFor(port);
  t.after(async () => { host.disconnect(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const made = await new Promise<any>((resolve) => host.emit("create", { alias: "Host", consent: { age: true, terms: true, revealOptIn: true } }, resolve));
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  let publicOrPrivateEvents = 0;
  host.on("finale", () => publicOrPrivateEvents++); host.on("secrets", () => publicOrPrivateEvents++);
  host.on("round", () => host.emit("skip_round")); host.on("reveal", () => host.emit("skip_round")); host.on("interlude", () => host.emit("skip_round"));
  host.emit("start"); await limit(started);
  const deleted = event<void>(host, "deleted"); host.emit("delete_room"); await limit(deleted);
  assert.deepEqual(readdirSync(dir), []);
  releaseWriter(); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(publicOrPrivateEvents, 0, "late provider response must not resurrect a deleted room");
  const another = await socketFor(port);
  const rejected = await new Promise<any>((resolve) => another.emit("join", { roomCode: made.code, alias: "Host", consent: { age: true, terms: true, revealOptIn: true }, resume: { playerId: made.you, secret: made.secret } }, resolve));
  another.disconnect(); assert.equal(rejected.ok, false);
});
