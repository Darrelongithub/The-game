// apps/server/test/director.test.ts
// ROUND 4 STEP 5/6 (server side) — the Director is real, deterministic and
// INVISIBLE.
//
//   * no client-facing emit, payload, state snapshot or room-log line ever
//     contains a hypothesis, a prior or the coverage board;
//   * a scripted one-sided room produces no public claim anywhere — only a
//     finale Secret Card on the picker's phone;
//   * the anti-telegraph cap holds across a whole night;
//   * a night with carried-over suspicions keeps probing last night's case
//     (asserted through SELECTION patterns only);
//   * the same scripted night selects the same rounds twice.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { io, type Socket } from "socket.io-client";
import {
  ANTI_TELEGRAPH_MAX,
  type Claim,
  type ClientToServerEvents, type FinaleView, type JoinReply, type LogRecord, type Prompt, type PromptCoding,
  type ResponseValue, type RoundView, type SecretDeckView, type ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { accountSubjectKey } from "../src/accounts.ts";
import { computeSignals, formHypotheses, carryOver } from "../../../packages/engine/src/index.ts";
import { createGameServer, type GameServer, type ServerOptions } from "../src/server.ts";
import { fallbackServices, type GameServices, type PromptProvider } from "../src/services.ts";
import { LogBuilder } from "../../../packages/engine/test/fixtures.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
type Directed = { mode: string; dimension: string; subjects: string[]; promptId: string; hypothesisId?: string };
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const limit = <T>(promise: Promise<T>, ms = 20_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const event = <T>(client: Client, name: string, predicate: (payload: T) => boolean = () => true): Promise<T> =>
  new Promise((resolve) => {
    const handler = (data: T): void => { if (predicate(data)) { (client as any).off(name, handler); resolve(data); } };
    (client as any).on(name, handler);
  });

// ---------------------------------------------------------------------------
// A deterministic, placeholder-rich provider: the mix needs candidates on all
// seven codings, and a targeted prompt needs somewhere to bind a subject.
// ---------------------------------------------------------------------------
const prompt = (id: string, coding: PromptCoding, kind: Prompt["kind"]): Prompt => ({
  id, source: "bank", phase: "warmup", kind,
  text: `Who here fits {P1} best, and what would {P2} say about it?`,
  measures: ["pick"], coding, asksTarget: true,
});
const CODINGS: PromptCoding[] = ["couple", "friendship", "trust", "friction", "rivalry", "status", "neutral"];
const RICH: Prompt[] = CODINGS.flatMap((coding) => ["a", "b", "c", "d"].map((suffix) => prompt(`${coding}-${suffix}`, coding, "pick")));

const gameservices = (directed: Directed[], extra: Partial<GameServices> = {}): GameServices => {
  const provider: PromptProvider = {
    forPhase(phase, n, used) {
      return RICH.filter((p) => !used.has(p.id)).slice(0, n).map((p) => ({ ...p, phase }));
    },
  };
  void directed;
  return { ...fallbackServices, createPromptProvider: () => provider, ...extra };
};

interface NightResult {
  code: string;
  dir: string;
  ids: string[];
  events: { name: string; payload: unknown }[];
  finale: FinaleView;
  decks: SecretDeckView[];
  directed: Directed[];
  /** every claim the engine handed the finale (graduated suspicions included) */
  claims: Claim[];
}

interface NightOptions {
  aliases: string[];
  /** bind every player to a fresh account over REST before the night starts */
  accounts?: boolean;
  /** after binding, before `start` — where a carried-over case is seeded */
  onBound?: (ctx: { server: GameServer; ids: string[]; accountIds: string[] }) => void;
  services?: GameServices;
  timers?: Partial<Record<RoundView["kind"], number>>;
  strategy?: Strategy;
}

const TINY: Partial<Record<RoundView["kind"], number>> = {
  pick: 700, shout: 700, minigame: 700, rating: 700, ios: 700, text: 700,
  dare: 700, pair_dare: 700, debrief: 700, spotlight: 700, verdict: 700,
};

/**
 * How the scripted room answers pick rounds.
 *  - "onesided": the first player only ever picks the second (finale secret test)
 *  - "neutral":  everybody picks two seats along, so no pair piles up and a
 *                carried suspicion is left alone to be tested
 */
type Strategy = "onesided" | "neutral" | "couple";
const submitValue = (socket: Client, me: string, round: RoundView, ids: string[], strategy: Strategy = "onesided"): void => {
  const others = ids.filter((id) => id !== me);
  const index = ids.indexOf(me);
  const target = strategy === "neutral" ? ids[(index + 2) % ids.length]!
    : strategy === "couple" ? (ids[0] === me ? ids[1]! : ids[1] === me ? ids[0]! : ids[(index + 2) % ids.length]!)
    : ids[0] === me ? ids[1]! : ids[1] === me ? ids[2]! : others[0]!;
  let value: ResponseValue;
  switch (round.kind) {
    case "pick": case "verdict": value = { kind: "pick", target }; break;
    case "shout": value = { kind: "shout", word: "chaos" }; break;
    case "rating": value = { kind: "rating", trait: round.trait!, about: round.about!, value: 9 }; break;
    case "ios": value = { kind: "ios", about: round.about!, value: 5 }; break;
    case "minigame": value = { kind: "minigame", score: 30 }; break;
    case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
    case "debrief": value = { kind: "text", text: "We talked about the same thing twice." }; break;
    default: value = { kind: "text", text: "I would keep this room's secrets and tell none of them." };
  }
  socket.emit("submit", { roundId: round.roundId, clientUuid: `${round.roundId}:${me}`, value }, () => {});
};

async function playNight(t: TestContext, options: NightOptions): Promise<NightResult> {
  const dir = mkdtempSync(join(tmpdir(), "reveal-director-"));
  const directed: Directed[] = [];
  const claims: Claim[] = [];
  const baseServices = options.services ?? gameservices(directed);
  const services: GameServices = {
    ...baseServices,
    buildSecrets(results, digest, meta) {
      claims.push(...results.claims);
      return baseServices.buildSecrets(results, digest, meta);
    },
  };
  const serverOptions: ServerOptions = {
    dataDir: dir,
    services,
    roundTimers: options.timers ?? TINY,
    verdictDiscussMs: 0, graceMs: 150, revealHoldMs: 5, interludeHoldMs: 5, botDelayMs: [5, 10],
    audit: { persisted: () => {}, decks: () => {}, directed: (_code, round) => directed.push(round) },
  };
  const server = createGameServer(serverOptions);
  const port = await server.listen(0, "127.0.0.1", false);
  const base = `http://127.0.0.1:${port}`;
  const sockets: Client[] = [];
  const events: { name: string; payload: unknown }[] = [];
  const decks: SecretDeckView[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const alias of options.aliases) {
    const socket: Client = io(base, { forceNew: true, transports: ["polling", "websocket"], reconnection: false, autoConnect: false });
    sockets.push(socket);
    socket.on("error", () => {});
    // Simulated phones press ready the moment a reveal is pending (ROUND 4).
    socket.on("state", (view) => { if (view.ready) socket.emit("ready"); });
    socket.onAny((name: string, payload: unknown) => { events.push({ name, payload }); });
    const ready = event<void>(socket, "connect");
    socket.connect();
    await limit(ready);
  }
  const first = await new Promise<JoinReply & { code?: string }>((resolve) => sockets[0]!.emit("create", { alias: options.aliases[0]!, consent, profile }, resolve));
  assert.equal(first.ok, true);
  const replies: JoinReply[] = [first];
  for (let i = 1; i < sockets.length; i++) {
    replies.push(await new Promise<JoinReply>((resolve) => sockets[i]!.emit("join", { roomCode: first.code!, alias: options.aliases[i]!, consent, profile }, resolve)));
  }
  assert.ok(replies.every((r) => r.ok), "every player joined");
  const ids = replies.map((r) => r.you!);
  const accountIds: string[] = [];
  if (options.accounts) {
    for (let i = 0; i < ids.length; i++) {
      const created = await fetch(`${base}/api/account`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: `${options.aliases[i]!.toLowerCase()}_acct`, pin: "1234" }),
      });
      assert.equal(created.status, 201);
      const body = await created.json() as { token: string; account: { username: string } };
      const attach = await fetch(`${base}/api/account/night`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${body.token}` },
        body: JSON.stringify({ roomCode: first.code!, playerId: ids[i]!, playerSecret: replies[i]!.secret! }),
      });
      assert.equal(attach.status, 200, "a player's own session secret binds their account");
      const accountId = server.accounts.accountIdFor(body.token);
      assert.ok(accountId);
      accountIds.push(accountId);
    }
    options.onBound?.({ server, ids, accountIds });
  }

  const finalePromises = sockets.map((socket) => event<FinaleView>(socket, "finale"));
  sockets.forEach((socket, i) => {
    socket.on("secrets", (deck) => { if (i === 0) decks.push(deck); });
    socket.on("round", (round: RoundView) => {
      if (round.expectsAnswer === false) return;
      submitValue(socket, ids[i]!, round, ids, options.strategy ?? "onesided");
    });
  });
  sockets[0]!.emit("start");
  const finales = await Promise.all(finalePromises.map((promise) => limit(promise)));
  await wait(60);
  return { code: first.code!, dir, ids, events, finale: finales[0]!, decks, directed, claims };
}

const leakMarkers = /hypothes|suspect|coverage|case_?board|lastTestedRound|"priors"|"director"|openedAt/iu;

test("INVISIBILITY: no emit, snapshot or room-log line ever carries a hypothesis", { timeout: 45_000 }, async (t) => {
  const night = await playNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"] });
  assert.ok(night.events.length > 40, "a night's worth of events really was captured");
  const names = new Set(night.events.map((e) => e.name));
  for (const expected of ["state", "round", "reveal", "interlude", "finale"]) assert.ok(names.has(expected), `missing ${expected}`);

  for (const { name, payload } of night.events) {
    const json = JSON.stringify(payload);
    assert.ok(!leakMarkers.test(json), `emit "${name}" leaked internal director material: ${json.slice(0, 200)}`);
    const keys = new Set<string>();
    JSON.parse(json, (key, value) => { if (key) keys.add(key); return value; });
    for (const key of keys) assert.ok(!/hypothes|coverage|prior|director|strength/iu.test(key), `payload key "${key}" is internal`);
  }

  // A state snapshot is exactly the public contract, nothing more. `ready` is
  // the ONE ROUND 4 addition (who has pressed ready for a pending reveal) —
  // public player ids only, never any director material.
  for (const { payload } of night.events.filter((e) => e.name === "state")) {
    const keys = Object.keys(payload as object).sort();
    assert.deepEqual(keys.filter((key) => key !== "ready"), ["code", "hostId", "phase", "players", "round", "seq"]);
    if (keys.includes("ready")) assert.ok(Array.isArray((payload as { ready: unknown }).ready));
  }

  // The room log is the only thing that outlives the night — and it is records only.
  const files = readdirSync(night.dir).filter((name) => name.endsWith(".jsonl"));
  assert.ok(files.length > 0, "the night wrote a room log");
  for (const file of files) {
    const text = readFileSync(join(night.dir, file), "utf8");
    assert.ok(!leakMarkers.test(text), `${file} leaked director material`);
    for (const line of text.trim().split("\n")) {
      const record = JSON.parse(line) as LogRecord;
      // A LogRecord and nothing else (a spotlight decoy adds only `decoy`).
      const extra = Object.keys(record).filter((key) => !["at", "coding", "latencyMs", "playerId", "promptId", "roomId", "roundId", "roundKind", "value", "decoy", "performerId"].includes(key));
      assert.deepEqual(extra, [], `room log line carries unexpected fields: ${extra.join(", ")}`);
    }
  }
});

test("ONE-SIDED RULE: no public claim anywhere — only the picker's finale Secret Card", { timeout: 45_000 }, async (t) => {
  const night = await playNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"] });
  const publicText = JSON.stringify(night.finale);
  assert.ok(!/the other way happened/iu.test(publicText), "engine one-sided evidence must never reach the finale");
  assert.ok(!/dir-onesided|onesided-/iu.test(publicText), "no one-sided claim id rides the broadcast");
  assert.ok(!("onesided" in night.finale.summary), "the public summary has no one-sided slot");
  const slideText = night.finale.slides.map((slide) => `${slide.title} ${slide.body ?? ""}`).join(" ");
  assert.ok(!/kept choosing|kept picking/iu.test(slideText));
  // The picker does get it: face-down, on their own phone, and nowhere else.
  assert.ok(night.decks.some((deck) => deck.cards.some((card) => card.kind === "onesided")),
    "the one-sided card exists — on the picker's deck only");
});

test("ANTI-TELEGRAPH: a whole night never runs more than the cap on one pair", { timeout: 45_000 }, async (t) => {
  const night = await playNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"] });
  assert.ok(night.directed.length >= 8, `the director planned the night (saw ${night.directed.length})`);
  let run = 0;
  let previous: string | undefined;
  for (const round of night.directed) {
    const pair = [...round.subjects].sort().join("-");
    if (!pair) { previous = undefined; run = 0; continue; }
    run = pair === previous ? run + 1 : 1;
    previous = pair;
    assert.ok(run <= ANTI_TELEGRAPH_MAX, `"${round.promptId}" was the ${run}th consecutive round on ${pair}`);
  }
  assert.ok(new Set(night.directed.map((round) => round.dimension)).size >= 3,
    "the selector worked across several dimensions — a real mix, not a fixed script");
});

test("DETERMINISM: the same scripted night selects the same rounds twice", { timeout: 60_000 }, async (t) => {
  const shape = (night: NightResult) => night.directed.map((round) => `${round.mode}:${round.promptId}:${round.dimension}:${round.subjects.join("+")}`);
  const first = shape(await playNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"] }));
  const second = shape(await playNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"] }));
  assert.deepEqual(second, first, "replaying the night must replay the choices");
});

test("GRADUATION: only high-confidence suspicions with three independent signals can become ordinary claims", { timeout: 45_000 }, async (t) => {
  const night = await playNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"], strategy: "couple" });
  const graduated = night.claims.filter((claim) => claim.id.startsWith("dir-"));
  assert.ok(graduated.every((claim) => claim.confidence === "high" && Number(claim.numbers?.signals ?? 0) >= 3),
    "a suspicion cannot graduate on picks alone or with fewer than three independent signal types");
  for (const claim of graduated) {
    assert.ok(claim.audience === "private" || claim.audience === "public");
    const slideIds = new Set(night.finale.slides.map((slide) => slide.claimId).filter(Boolean));
    assert.ok(slideIds.has(claim.id), "graduated claims reach the finale as ordinary claims");
  }
  // The finale says nothing about WHY the room kept asking.
  assert.ok(!leakMarkers.test(JSON.stringify(night.finale)));
});

test("CROSS-NIGHT: carried suspicions keep probing last night's case (selection only)", { timeout: 60_000 }, async (t) => {
  // Night 1, played offline by the engine: build the log, form the suspicions,
  // and carry the unresolved ones over exactly as the finale does.
  const b = new LogBuilder("room-night-1");
  b.pickRound("C1", "couple", [["p1", "p2"], ["p2", "p3"], ["p3", "p4"], ["p4", "p5"], ["p5", "p3"]]);
  b.pickRound("C2", "couple", [["p1", "p2"], ["p2", "p4"], ["p3", "p5"], ["p4", "p1"], ["p5", "p4"]]);
  b.pickRound("C3", "couple", [["p1", "p2"], ["p2", "p5"], ["p3", "p2"], ["p4", "p3"], ["p5", "p1"]]);
  b.pickRound("C4", "couple", [["p1", "p3"], ["p2", "p1"], ["p3", "p4"], ["p4", "p2"], ["p5", "p3"]]);
  b.pickRound("C5", "couple", [["p1", "p4"], ["p2", "p5"], ["p3", "p1"], ["p4", "p3"], ["p5", "p2"]]);
  const meta = {
    roomId: "room-night-1",
    players: [1, 2, 3, 4, 5].map((i) => ({ id: `p${i}`, alias: `Player ${i}` })),
    revealOptIn: ["p1", "p2", "p3", "p4", "p5"],
  };
  const carried = carryOver(formHypotheses(computeSignals(b.log, meta), b.log, meta))
    .filter((h) => h.subjects.length === 2);
  assert.ok(carried.length > 0, "night 1 ended unsure about somebody");
  // Three open questions, one per pick coding, so the case survives whichever
  // lane the mix fires. (The night is deterministic: this cannot flake.)
  const cases = (["tension", "besties", "onesided"] as const).map((kind, index) => ({
    kind,
    dimension: kind === "tension" ? "friction" : kind === "besties" ? "friendship" : "couple",
    strength: 0.5 + index * 0.03,
  }));

  const night = await playNight(t, {
    aliases: ["Alice", "Brian", "Chao", "Diana"],
    accounts: true,
    strategy: "neutral",
    onBound: ({ server, accountIds }) => {
      // Store them under last night's account keys, exactly like savePriors().
      const evidence = carried[0]!.evidence;
      server.accounts.setPriors(accountIds[0]!, cases.map((entry) => ({
        kind: entry.kind,
        subjects: [accountSubjectKey(accountIds[0]!, "p1"), accountSubjectKey(accountIds[1]!, "p2")],
        status: "unresolved" as const, strength: entry.strength, evidence: [...evidence], openedAt: 1_700_000_000_000,
      })));
    },
  });

  const expected = new Map(cases.map((entry) => [`${entry.kind}-`, entry.dimension] as const));
  const tested = night.directed.filter((round) => round.hypothesisId && [...expected.keys()].some((prefix) => round.hypothesisId!.startsWith(prefix)));
  assert.ok(tested.length > 0, `night 2 kept probing a carried case (selection pattern, no client emit). directed=${JSON.stringify(night.directed)}`);
  for (const round of tested) {
    const prefix = [...expected.keys()].find((candidate) => round.hypothesisId!.startsWith(candidate))!;
    assert.equal(round.dimension, expected.get(prefix), "on the dimension it was unsure about");
  }
  // The two people it probes are TONIGHT's ids for those same two accounts.
  const subjects = new Set(tested.flatMap((round) => round.subjects));
  assert.ok(subjects.size > 0 && subjects.size <= 2, `probed exactly the carried pair, saw ${[...subjects].join(", ")}`);
  assert.ok([...subjects].every((id) => night.ids.includes(id)));
});
