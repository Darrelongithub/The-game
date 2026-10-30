import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProfileAnswers, ResponseValue, RoomView, RoundView, SecretDeckView } from "@shared/contracts.ts";
import { createGameServer } from "../../server/src/server.ts";
import { fallbackServices } from "../../server/src/services.ts";
import { SocketTransport } from "../src/lib/socketTransport.ts";
import { clearSession, loadSession, saveSession } from "../src/lib/session.ts";

const profile: ProfileAnswers = { age: 31, relationship: "complicated", partnersToDate: 4, longestMonths: 18, crushingHere: true, tonight: "feelings" };
const consent = { age: true, terms: true, revealOptIn: true };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 15000;
  while (!predicate()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await wait(10); }
}
class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}
function browser() {
  const local = new MemoryStorage(), session = new MemoryStorage();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  return { local, session, document, window: { localStorage: local, sessionStorage: session } };
}
function install(phone: ReturnType<typeof browser>) {
  Object.assign(globalThis, { window: phone.window, document: phone.document });
}
function valueFor(round: RoundView, me: string, players: RoomView["players"]): ResponseValue | null {
  if (round.youSubmitted || round.expectsAnswer === false || (round.onlyPlayers && !round.onlyPlayers.includes(me))) return null;
  const other = players.find((player) => player.id !== me)!.id;
  switch (round.kind) {
    case "pick": case "verdict": return { kind: "pick", target: other };
    case "rating": return { kind: "rating", trait: round.trait!, about: round.about!, value: 7 };
    case "ios": return { kind: "ios", about: round.about!, value: 6 };
    case "shout": return { kind: "shout", word: "vibes" };
    case "minigame": return { kind: "minigame", score: 20 };
    case "dare": case "pair_dare": return { kind: "dare", status: "done" };
    default: return { kind: "text", text: "The same seat remembers this answer." };
  }
}

test("R24: localStorage survives a new tab, migrates legacy sessions, and clears both stores", () => {
  const phone = browser(); install(phone);
  const saved = { code: "AB2C", you: "p7", secret: "opaque-token", alias: "Guest", consent, profile };
  assert.equal(saveSession(saved), true);
  assert.deepEqual(JSON.parse(phone.local.getItem("reveal.session")!), saved);
  assert.equal(phone.session.getItem("reveal.session"), null);
  phone.session.clear(); // a new tab gets fresh sessionStorage, not a new identity
  assert.deepEqual(loadSession(), saved);
  clearSession(); assert.equal(loadSession(), null);
  phone.session.setItem("reveal.session", JSON.stringify(saved));
  assert.deepEqual(loadSession(), saved, "legacy tab credentials remain recoverable");
  assert.deepEqual(JSON.parse(phone.local.getItem("reveal.session")!), saved);
  assert.equal(phone.session.getItem("reveal.session"), null, "migration removes the old credential");
  clearSession();
});

test("R24: real reloads reclaim guest/host seats, answers, profile and private deck; purge clears identity", { timeout: 30000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-r24-"));
  let now = Date.now();
  let expectedDeck: SecretDeckView | undefined;
  const privateDeck: SecretDeckView = { cards: [{ id: "only-p4", kind: "stat", title: "Your night", facts: ["Still the same seat."] }] };
  const server = createGameServer({
    dataDir: dir, now: () => now, services: {
      ...fallbackServices,
      buildSecrets(results, digest, meta) {
        assert.deepEqual(meta.profiles?.p4, profile, "the server keeps the original profile on rejoin");
        const decks = fallbackServices.buildSecrets(results, digest, meta);
        decks.set("p4", privateDeck.cards); return decks;
      },
    },
    botDelayMs: [5, 10], revealHoldMs: 5, interludeHoldMs: 5, readyGraceMs: 1000,
    roundTimers: { pick: 60000, text: 60000, shout: 60000, rating: 60000, ios: 60000, minigame: 60000, dare: 60000, pair_dare: 60000, debrief: 60000, spotlight: 200, verdict: 60000 },
    graceMs: 50, verdictDiscussMs: 0,
    audit: { persisted() {}, decks(_code, _id, _players, decks) { expectedDeck = structuredClone(decks.get("p4")); } },
  });
  const port = await server.listen(0, "127.0.0.1", false);
  process.env.NEXT_PUBLIC_SERVER_URL = `http://127.0.0.1:${port}`;
  const hostPhone = browser(), guestPhone = browser();
  const transports: SocketTransport[] = [];
  t.after(async () => { transports.forEach((transport) => transport.disconnect()); await server.close(); rmSync(dir, { recursive: true, force: true }); delete process.env.NEXT_PUBLIC_SERVER_URL; });
  const makeTransport = (phone: ReturnType<typeof browser>) => {
    install(phone); const transport = new SocketTransport(); transports.push(transport); return transport;
  };
  let hostState: RoomView | undefined, guestState: RoomView | undefined, guestRound: RoundView | undefined;
  let host = makeTransport(hostPhone);
  host.setHandlers({ onState: (state) => { hostState = state; } });
  const created = await host.create("Host", consent, { ...profile, age: 35 });
  assert.ok(created.ok && created.code);
  assert.ok(hostPhone.local.getItem("reveal.session"), "create persists in localStorage before the game starts");
  host.addBot(); host.addBot();
  await until(() => hostState?.players.length === 3, "both bots occupy their seats");
  host.disconnect();
  let guest = makeTransport(guestPhone);
  const joined = await guest.join({ roomCode: created.code, alias: "Guest", consent, profile });
  assert.ok(joined.ok);
  assert.equal(joined.you, "p4");
  assert.ok(guestPhone.local.getItem("reveal.session"), "join persists in localStorage, not just this tab");
  guest.setHandlers({ onState: (state) => { guestState = state; }, onRound: (round) => { guestRound = round; } });
  // Resume the host to start, then reload it while the guest keeps its own store.
  hostState = undefined;
  host = makeTransport(hostPhone);
  host.setHandlers({ onState: (state) => { hostState = state; } });
  await until(() => hostState?.phase === "lobby", "host lobby reclaim");
  assert.equal(hostState!.hostId, "p1");
  host.start();
  install(guestPhone);
  await until(() => guestRound?.kind === "pick", "started pick round");
  const originalRoundId = guestRound!.roundId;
  assert.equal(guestState!.players.length, 4);
  const answer = { kind: "pick" as const, target: "p2" };
  assert.ok((await guest.submit({ roundId: guestRound!.roundId, clientUuid: "before-reload", value: answer })).ok);
  await until(() => guestState?.round?.youSubmitted === true, "answer acknowledgement");
  guest.disconnect();
  guestPhone.session.clear(); // reload into a fresh tab session
  guestState = undefined; guestRound = undefined;
  guest = makeTransport(guestPhone);
  guest.setHandlers({ onState: (state) => { guestState = state; }, onRound: (round) => { guestRound = round; } });
  await until(() => guestState?.phase === "warmup" && guestState.round?.youSubmitted === true, "guest active reload");
  assert.equal(guestState!.players.length, 4, "no duplicate seat");
  assert.equal(guestState!.players.filter((player) => player.id === "p4").length, 1);
  assert.equal(guestRound!.roundId, originalRoundId, "reload replays the same active round");
  const logFile = readdirSync(dir).find((file) => file.endsWith(".jsonl"))!;
  const rows = readFileSync(join(dir, logFile), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(rows.filter((row) => row.playerId === "p4").map((row) => row.value), [answer]);
  const metadata = JSON.parse(readFileSync(join(dir, logFile.replace(/\.jsonl$/, ".meta.json")), "utf8"));
  assert.deepEqual(metadata.players.find((player: { id: string }) => player.id === "p4").profile, profile);
  assert.equal(loadSession()!.you, "p4");
  guest.disconnect();
  host.disconnect();
  hostPhone.session.clear();
  hostState = undefined;
  host = makeTransport(hostPhone);
  host.setHandlers({ onState: (state) => { hostState = state; } });
  await until(() => hostState?.round?.youSubmitted === false, "host active reload");
  assert.equal(hostState!.hostId, "p1", "host reload reclaims host, never creates a seat");
  assert.equal(hostState!.players.length, 4);

  let finished = false, reloadedDeck: SecretDeckView | undefined;
  const playErrors: string[] = [];
  const play = (transport: SocketTransport, me: string, isGuest: boolean) => {
    const seen = new Set<string>();
    transport.setHandlers({
      onState: (state) => { if (isGuest) guestState = state; else hostState = state; if (state.ready) transport.ready(); },
      onRound: (round) => {
        if (isGuest) guestRound = round;
        const value = valueFor(round, me, (isGuest ? guestState : hostState)!.players);
        if (!value || seen.has(round.roundId)) return;
        seen.add(round.roundId);
        void transport.submit({ roundId: round.roundId, clientUuid: `${me}-${round.roundId}`, value }).then((reply) => { if (!reply.ok) playErrors.push(`${me}: submit: ${reply.error ?? "rejected"}`); });
      },
      onError: (error) => playErrors.push(`${me}: ${error.code}: ${error.message}`),
      onFinale: () => { if (isGuest) finished = true; },
      onSecrets: (deck) => { if (isGuest) reloadedDeck = deck; },
    });
  };
  play(host, "p1", false);
  // The reloaded host has an open, unanswered round already in its snapshot.
  const openHostRound = hostState!.round;
  if (openHostRound) {
    const value = valueFor(openHostRound, "p1", hostState!.players);
    if (value) await host.submit({ roundId: openHostRound.roundId, clientUuid: "p1-after-reload", value });
  }
  guest = makeTransport(guestPhone); play(guest, "p4", true);
  await until(() => finished || playErrors.length > 0, "finale after reloads");
  assert.deepEqual(playErrors, []);
  await wait(30);
  assert.deepEqual(expectedDeck, privateDeck);
  assert.deepEqual(reloadedDeck, expectedDeck);
  guest.disconnect(); guestPhone.session.clear(); reloadedDeck = undefined;
  guest = makeTransport(guestPhone);
  guest.setHandlers({ onState: (state) => { guestState = state; }, onSecrets: (deck) => { reloadedDeck = deck; } });
  await until(() => reloadedDeck !== undefined, "private deck redelivery after finale reload");
  assert.deepEqual(reloadedDeck, expectedDeck);
  assert.equal(guestState!.players.length, 4);
  assert.ok(!guestPhone.local.getItem("reveal.session")!.includes("Still the same seat"), "private deck is never copied into browser persistence");
  const stale = loadSession(); assert.ok(stale);
  host.disconnect(); // only the guest phone is installed for the purge broadcast
  now += 49 * 60 * 60 * 1000; server.rooms.purge();
  await until(() => loadSession() === null, "purge broadcast clears localStorage");
  saveSession(stale); // a phone that missed the broadcast must still fail closed on load
  guest = makeTransport(guestPhone);
  let rejected = false;
  guest.setHandlers({ onError: (error) => { if (error.code === "resume_failed") rejected = true; } });
  await until(() => rejected, "purged room rejects stale credentials");
  assert.equal(loadSession(), null);
  assert.equal(guestPhone.local.getItem("reveal.session"), null);
});

test("R24: a purged room returns the real app to JoinScreen and forgets the durable seat", { timeout: 15000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "reveal-r24-app-"));
  const server = createGameServer({ dataDir: dir, services: fallbackServices });
  const port = await server.listen(0, "127.0.0.1", false);
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: `http://127.0.0.1:${port}/`, pretendToBeVisual: true });
  const w = dom.window as any, g = globalThis as any;
  const oldTransport = process.env.NEXT_PUBLIC_TRANSPORT;
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, "location");
  g.window = w; g.document = w.document; g.location = w.location;
  Object.defineProperty(g, "navigator", { value: w.navigator, configurable: true });
  for (const key of ["HTMLElement", "Element", "Node", "SVGElement", "MouseEvent", "KeyboardEvent", "Event", "getComputedStyle"]) g[key] = w[key];
  g.requestAnimationFrame = w.requestAnimationFrame.bind(w); g.cancelAnimationFrame = w.cancelAnimationFrame.bind(w);
  g.IS_REACT_ACT_ENVIRONMENT = true;
  w.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  w.HTMLCanvasElement.prototype.getContext = () => null;
  process.env.NEXT_PUBLIC_TRANSPORT = "socket";
  w.sessionStorage.setItem("reveal.intro-done", "1");
  w.localStorage.setItem("reveal.session", JSON.stringify({ code: "AB2C", you: "p9", secret: "expired-token", alias: "Ghost", consent, profile }));
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { default: PlayPage } = await import("../src/app/page.tsx");
  const mount = w.document.createElement("div"); w.document.body.appendChild(mount);
  const root = createRoot(mount);
  t.after(async () => {
    await React.act(async () => root.unmount()); dom.window.close(); await server.close(); rmSync(dir, { recursive: true, force: true });
    if (oldTransport === undefined) delete process.env.NEXT_PUBLIC_TRANSPORT; else process.env.NEXT_PUBLIC_TRANSPORT = oldTransport;
    if (oldNavigator) Object.defineProperty(globalThis, "navigator", oldNavigator); else delete g.navigator;
    if (oldLocation) Object.defineProperty(globalThis, "location", oldLocation); else delete g.location;
    delete g.window; delete g.document;
  });
  await React.act(async () => { root.render(React.createElement(PlayPage)); await wait(50); });
  await React.act(async () => { await until(() => mount.querySelector("#alias") !== null && w.localStorage.getItem("reveal.session") === null, "JoinScreen after rejected durable session"); });
  assert.match(mount.textContent ?? "", /Create a room/);
  assert.ok(!/Taking you back to the room/.test(mount.textContent ?? ""), "resume splash is gone");
  assert.equal(w.localStorage.getItem("reveal.session"), null);
  assert.equal(w.sessionStorage.getItem("reveal.session"), null);
});
