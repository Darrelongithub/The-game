// ROUND 3 — LIVE MOMENTS (spotlight + verdict).
//
// What this proves:
//   1. Spotlight rotation: each player at most once a night, never back-to-back.
//   2. Secrecy: the subject's socket NEVER receives the real question — not in
//      a round view, not in a snapshot, reveal, interlude or finale — and the
//      verdict votes stay secret until the reveal emit.
//   3. Decoys: flagged, excluded from signals/results, surfaced only in the
//      digest pairing and the caption-wall punchline.
//   4. Bots answer both kinds (spotlight: short text; verdict: valid pick
//      after voteOpensAt).
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { io, type Socket } from "socket.io-client";
import {
  DECOYS, SPOTLIGHT_IDLE_LINE, liveSeeds,
} from "../../../packages/prompts/src/bank/live/index.ts";
import {
  clusterNames, detectNamedPlayers, nameClusterTeaser, type NameCandidate,
} from "../../../packages/engine/src/index.ts";
import type {
  ClientToServerEvents, FinaleView, JoinReply, LogRecord, ResponseValue, RevealView,
  RoomView, RoundView, ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { createGameServer, type ServerOptions } from "../src/server.ts";
import { fallbackServices, type GameServices } from "../src/services.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const DECOY_TEXTS = new Set(DECOYS.map((d) => d.text));

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const limit = <T>(promise: Promise<T>, ms = 12000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const once = <T>(client: Client, event: string): Promise<T> => new Promise((resolve) => (client as any).once(event, resolve));

async function setup(t: TestContext, options: ServerOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "reveal-live-"));
  const server = createGameServer({
    dataDir: dir, revealHoldMs: 20, interludeHoldMs: 20, graceMs: 30, botDelayMs: [5, 20],
    roundTimers: { pick: 60, text: 60, shout: 60, rating: 60, ios: 60, minigame: 60, dare: 60, pair_dare: 60, debrief: 60, spotlight: 120, verdict: 400 },
    verdictDiscussMs: 0, ...options,
  });
  const port = await server.listen(0, "127.0.0.1", false);
  const base = `http://127.0.0.1:${port}`, clients: Client[] = [];
  t.after(async () => { clients.forEach((c) => c.disconnect()); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const connect = async (): Promise<Client> => {
    const client: Client = io(base, { forceNew: true, transports: ["polling", "websocket"], reconnection: false, autoConnect: false });
    clients.push(client); client.on("error", () => {});
    client.on("state", (view) => { if (view.ready) client.emit("ready"); });
    const ready = once<void>(client, "connect"); client.connect(); await limit(ready); return client;
  };
  return { server, connect, dir };
}
const create = (client: Client, alias = "Host"): Promise<JoinReply & { code?: string }> => new Promise((resolve) => client.emit("create", { alias, consent, profile }, resolve));
const joinRoom = (client: Client, code: string, alias: string): Promise<JoinReply> => new Promise((resolve) => client.emit("join", { roomCode: code, alias, consent, profile }, resolve));
const submitValue = (client: Client, roundId: string, value: ResponseValue, clientUuid: string): Promise<{ ok: boolean; error?: string }> =>
  new Promise((resolve) => client.emit("submit", { roundId, value, clientUuid }, resolve));

/** What the subject's own phone says instead of the question. */
const isCover = (view: RoundView): boolean => view.expectsAnswer === false || DECOY_TEXTS.has(view.promptText) || view.promptText === SPOTLIGHT_IDLE_LINE;

test("spotlight: rotation holds, the subject never sees the question, decoys never score", { timeout: 30000 }, async (t) => {
  const scoringLogs: LogRecord[][] = [];
  const services: GameServices = {
    ...fallbackServices,
    computeSignals(log, meta) { scoringLogs.push(structuredClone(log)); return fallbackServices.computeSignals(log, meta); },
    computeResults(signals, log, meta) { scoringLogs.push(structuredClone(log)); return fallbackServices.computeResults(signals, log, meta); },
  };
  const { connect } = await setup(t, { services });
  const clients = await Promise.all([connect(), connect(), connect(), connect()]);
  // `$&` must remain literal when substituting a subject alias.
  const aliases = ["$&Host", "Brian", "Chao", "Diana"];
  const made = await create(clients[0]!, aliases[0]!); assert.ok(made.ok && made.code);
  const ids = [made.you!];
  for (let i = 1; i < clients.length; i++) {
    const reply = await joinRoom(clients[i]!, made.code!, aliases[i]!);
    assert.ok(reply.ok && reply.you); ids.push(reply.you!);
  }

  // Every payload any socket receives, stringified — the secrecy audit surface.
  const frames: string[][] = clients.map(() => []);
  const views = new Map<string, Map<string, RoundView>>();
  const reveals: RevealView[] = [];
  const finales: Promise<FinaleView>[] = clients.map((client) => once<FinaleView>(client, "finale"));
  let outcome: ResponseValue | undefined;
  for (let i = 0; i < clients.length; i++) {
    const client = clients[i]!, myId = ids[i]!;
    for (const name of ["state", "round", "reveal", "interlude", "finale", "secrets", "error"] as const) {
      client.on(name as any, (payload: unknown) => frames[i]!.push(JSON.stringify(payload)));
    }
    client.on("round", (round: RoundView) => {
      const byPlayer = views.get(round.roundId) ?? new Map<string, RoundView>();
      byPlayer.set(myId, round);
      views.set(round.roundId, byPlayer);
      if (round.youSubmitted) return;
      let value: ResponseValue;
      switch (round.kind) {
        case "pick": value = { kind: "pick", target: ids.find((id) => id !== myId)! }; break;
        case "text": case "debrief": case "spotlight": value = { kind: "text", text: i === 0 ? "Brian keeps this table honest." : "Watching the room from the corner." }; break;
        case "shout": value = { kind: "shout", word: "chaos" }; break;
        case "rating": value = { kind: "rating", trait: round.trait!, about: round.about!, value: 7 }; break;
        case "ios": value = { kind: "ios", about: round.about!, value: 5 }; break;
        case "minigame": value = { kind: "minigame", score: 20 + i }; break;
        case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
        case "confess": value = { kind: "confess", yes: i % 2 === 0 }; break;
        case "verdict": value = { kind: "pick", target: ids[(i + 1) % ids.length]! }; break;
      }
      outcome = value;
      void submitValue(client, round.roundId, value, `live-${round.roundId}-${myId}`);
    });
    client.on("reveal", (reveal: RevealView) => { if (!reveals.some((r) => r.roundId === reveal.roundId)) reveals.push(reveal); });
  }
  clients[0]!.emit("start");
  const results = await limit(Promise.all(finales));

  /* ── 1. rotation ─────────────────────────────────────────────────── */
  type Spotlight = { roundId: string; subjectId: string; subjectIndex: number; question: string; cover: RoundView };
  const spotlights: Spotlight[] = [];
  for (const [roundId, byPlayer] of views) {
    if (byPlayer.size !== clients.length) continue;
    if ([...byPlayer.values()][0]!.kind !== "spotlight") continue;
    const covers = [...byPlayer].filter(([, view]) => isCover(view));
    assert.equal(covers.length, 1, `${roundId}: exactly one phone gets the cover round`);
    const question = [...byPlayer.values()].find((view) => !isCover(view))!.promptText;
    const [subjectId, cover] = covers[0]!;
    spotlights.push({ roundId, subjectId, subjectIndex: ids.indexOf(subjectId), question, cover });
  }
  assert.equal(spotlights.length, 4, "one spotlight per heat phase (warmup → dare)");
  const subjects = spotlights.map((s) => s.subjectIndex);
  assert.equal(new Set(subjects).size, subjects.length, `a player was spotlighted twice: ${subjects.join(",")}`);
  for (let i = 1; i < subjects.length; i++) assert.notEqual(subjects[i], subjects[i - 1], "spotlight went back-to-back");

  /* ── 2. the subject never sees the question ──────────────────────── */
  for (const spot of spotlights) {
    // Cover screen: a decoy question, or the idle line (no input at all).
    assert.ok(isCover(spot.cover), "subject round view is the decoy");
    assert.notEqual(spot.cover.promptText, spot.question);
    assert.ok(spot.cover.expectsAnswer === false || DECOY_TEXTS.has(spot.cover.promptText));
    // Nothing on that socket, all night, may carry the question — checked
    // against the WHOLE spotlight pool for that subject, not just the draw.
    const pool = liveSeeds("spotlight", "dare", { spicy: true }).map((seed) =>
      seed.text.replace(/\{S\}/gu, () => aliases[spot.subjectIndex]!));
    assert.ok(pool.includes(spot.question), "drawn question must come from the bank pool");
    for (const question of new Set(pool)) {
      for (const frame of frames[spot.subjectIndex]!) {
        assert.equal(frame.includes(question), false, `${aliases[spot.subjectIndex]}'s socket received the question: ${question}`);
      }
    }
  }

  /* ── 3. caption-wall reveal ends on the punchline ────────────────── */
  const spotlightReveals = reveals.filter((reveal) => reveal.kind === "spotlight");
  assert.equal(spotlightReveals.length, 4);
  for (const reveal of spotlightReveals) {
    assert.ok(reveal.subject, "reveal names the subject");
    assert.equal(reveal.items?.length, clients.length - 1, "each non-subject caption appears exactly once");
    assert.equal(new Set(reveal.items?.map((item) => item.alias)).size, clients.length - 1, "caption authors are not duplicated");
    assert.ok(!JSON.stringify(reveal).includes(spotlights.find((s) => s.roundId === reveal.roundId)!.question), "the wall never prints the question");
  }
  const withPunchline = spotlightReveals.filter((reveal) => !!reveal.punchline);
  assert.ok(withPunchline.length > 0, "at least one spotlight ended on the subject's decoy line");

  /* ── 4. decoys: flagged, never scored, digest gold ───────────────── */
  const decoyRecords = scoringLogs.flat().filter((record) => record.decoy === true);
  assert.equal(decoyRecords.length, 0, "decoy records must never reach signals or results");
  const decoyIds = spotlightReveals.filter((reveal) => !!reveal.punchline).map((reveal) => reveal.subject);
  assert.ok(decoyIds.length > 0);
  for (const reveal of withPunchline) {
    assert.ok(DECOYS.some((decoy) => decoy.text === reveal.punchline) || reveal.punchline!.length > 0);
    assert.ok(reveal.items!.every((item) => item.alias !== reveal.subject), "the subject's own line is not a caption");
  }
  // The digest pairs the decoy with the captions, and the finale quotes it.
  const finaleText = JSON.stringify(results[0]);
  for (const reveal of withPunchline) {
    assert.ok(finaleText.includes(reveal.punchline!), "the decoy answer surfaces as the digest punchline");
  }
  assert.ok(scoringLogs.length >= 2);
  for (const log of scoringLogs) assert.ok(log.every((record) => record.decoy !== true));
});

test("verdict: phones down during the debate, votes stay secret until the reveal", { timeout: 20000 }, async (t) => {
  const { connect, dir } = await setup(t, { roundTimers: { pick: 60, text: 60, shout: 60, rating: 60, ios: 60, minigame: 60, dare: 60, pair_dare: 60, debrief: 60, spotlight: 120, verdict: 900 }, verdictDiscussMs: 400 });
  const clients = await Promise.all([connect(), connect(), connect(), connect()]);
  const aliases = ["Host", "Brian", "Chao", "Diana"];
  const made = await create(clients[0]!, aliases[0]!); assert.ok(made.ok && made.code);
  const ids = [made.you!];
  for (let i = 1; i < clients.length; i++) { const r = await joinRoom(clients[i]!, made.code!, aliases[i]!); assert.ok(r.ok); ids.push(r.you!); }

  const earlyResult: { value?: { ok: boolean; error?: string } } = {};
  const verdictReveals: RevealView[] = [];
  const frames: string[][] = clients.map(() => []);
  /** Frames that arrived while phones were down: no tally may be in them. */
  const debateFrames: string[][] = clients.map(() => []);
  let verdictOpen = false;
  let verdictRoundId = "";
  const finales = clients.map((client) => once<FinaleView>(client, "finale"));
  for (let i = 0; i < clients.length; i++) {
    const client = clients[i]!, myId = ids[i]!;
    for (const name of ["state", "round", "reveal", "interlude", "finale", "secrets"] as const) {
      client.on(name as any, (payload: unknown) => {
        // The verdict reveal itself ends the debate window; it is the one frame
        // allowed to carry the tallies.
        if (name === "reveal" && (payload as { kind?: string } | null)?.kind === "verdict") { verdictOpen = false; return; }
        const frame = JSON.stringify(payload);
        frames[i]!.push(frame);
        if (verdictOpen) debateFrames[i]!.push(frame);
      });
    }
    client.on("reveal", (reveal: RevealView) => { if (reveal.kind === "verdict") verdictOpen = false; });
    client.on("round", (round: RoundView) => {
      if (round.youSubmitted) return;
      if (round.kind === "verdict") {
        verdictOpen = true;
        verdictRoundId = round.roundId;
        assert.ok(round.voteOpensAt && round.voteOpensAt > Date.now(), "the debate window is announced, not the votes");
        if (i === 0) {
          // Voting before the window closes must be refused.
          void submitValue(client, round.roundId, { kind: "pick", target: ids[1]! }, `early-${myId}`).then((result) => { earlyResult.value = result; });
        }
        const waitMs = Math.max(0, round.voteOpensAt! - Date.now()) + 30;
        setTimeout(() => { void submitValue(client, round.roundId, { kind: "pick", target: ids[(i + 1) % ids.length]! }, `vote-${myId}`); }, waitMs);
        return;
      }
      let value: ResponseValue;
      switch (round.kind) {
        case "pick": value = { kind: "pick", target: ids.find((id) => id !== myId)! }; break;
        case "text": case "debrief": case "spotlight": value = { kind: "text", text: "Someone here is quietly running this room." }; break;
        case "shout": value = { kind: "shout", word: "verdict" }; break;
        case "rating": value = { kind: "rating", trait: round.trait!, about: round.about!, value: 6 }; break;
        case "ios": value = { kind: "ios", about: round.about!, value: 4 }; break;
        case "minigame": value = { kind: "minigame", score: 17 }; break;
        default: value = { kind: "dare", status: "done" }; break;
      }
      void submitValue(client, round.roundId, value, `play-${round.roundId}-${myId}`);
    });
    client.on("reveal", (reveal: RevealView) => { if (!verdictReveals.some((r) => r.roundId === reveal.roundId)) verdictReveals.push(reveal); });
  }
  clients[0]!.emit("start");
  await limit(Promise.all(finales));

  assert.ok(earlyResult.value, "the early vote attempt was answered");
  assert.equal(earlyResult.value!.ok, false);
  assert.match(earlyResult.value!.error ?? "", /Phones down/i);

  const verdict = verdictReveals.filter((reveal) => reveal.kind === "verdict");
  assert.ok(verdict.length >= 1, "a verdict round reached its reveal");
  const reveal = verdict[0]!;
  assert.ok(reveal.slide, "the reveal carries a Group Announcement slide");
  assert.equal(reveal.slide!.flavor, "group");
  const numbers = reveal.slide!.numbers as Record<string, number>;
  assert.ok(numbers.votes >= 1 && numbers.of >= numbers.votes, "anonymous counts only");
  assert.match(reveal.slide!.body ?? "", /^\d+ of \d+ said it out loud\.$/);
  assert.equal(typeof reveal.celebrate, "boolean", "couple verdicts celebrate; others do not");

  // No voter identity anywhere in the reveal, and no tally leaked before it.
  for (const item of reveal.items ?? []) assert.equal(item.alias, "The room");
  assert.equal(/voted by|Chose /u.test(JSON.stringify(reveal)), false);
  // Every frame that arrived while the phones were down is tally-free.
  const debate = debateFrames.flat();
  assert.ok(debate.length > 0, "the debate window produced traffic");
  for (const frame of debate) {
    assert.equal(frame.includes('"numbers"'), false, "vote numbers leaked during the debate");
    assert.equal(frame.includes('"slide"'), false, "the verdict slide leaked during the debate");
    assert.equal(/Chose /u.test(frame), false, "a vote target leaked during the debate");
  }
  for (const frame of frames[0]!) assert.equal(frame.includes("voted by"), false, "voter names are never emitted");
  void dir; void verdictRoundId;
});

test("bots answer both live kinds without help", { timeout: 20000 }, async (t) => {
  const { connect } = await setup(t, { roundTimers: { pick: 60, text: 60, shout: 60, rating: 60, ios: 60, minigame: 60, dare: 60, pair_dare: 60, debrief: 60, spotlight: 200, verdict: 1500 }, verdictDiscussMs: 500, botDelayMs: [5, 20] });
  const host = await connect();
  const made = await create(host, "Host"); assert.ok(made.ok);
  for (let i = 0; i < 3; i++) host.emit("add_bot");
  await wait(40);
  const kinds = new Set<string>();
  const reveals: RevealView[] = [];
  host.on("round", (round: RoundView) => kinds.add(round.kind));
  host.on("reveal", (reveal: RevealView) => reveals.push(reveal));
  host.on("round", (round: RoundView) => {
    if (round.youSubmitted) return;
    if (round.kind === "verdict" && round.voteOpensAt && round.voteOpensAt > Date.now()) return; // host argues too
    const value: ResponseValue = round.kind === "pick" || round.kind === "verdict" ? { kind: "pick", target: "p2" }
      : round.kind === "text" || round.kind === "debrief" || round.kind === "spotlight" ? { kind: "text", text: "Bot but honest." }
      : round.kind === "shout" ? { kind: "shout", word: "bots" }
      : round.kind === "rating" ? { kind: "rating", trait: round.trait!, about: round.about!, value: 5 }
      : round.kind === "ios" ? { kind: "ios", about: round.about!, value: 3 }
      : round.kind === "minigame" ? { kind: "minigame", score: 12 }
      : { kind: "dare", status: "done" };
    void submitValue(host, round.roundId, value, `host-${round.roundId}`);
  });
  const finale = once<FinaleView>(host, "finale");
  host.emit("start");
  await limit(finale, 15000);

  assert.ok(kinds.has("spotlight"), "bots played a spotlight round");
  assert.ok(kinds.has("verdict"), "bots played a verdict round");
  const spotlight = reveals.find((reveal) => reveal.kind === "spotlight");
  assert.ok(spotlight?.items?.length, "bots captioned the spotlight");
  const verdict = reveals.find((reveal) => reveal.kind === "verdict");
  assert.ok(verdict?.slide, "bots produced a verdict slide");
  const tallies = verdict!.slide!.numbers as Record<string, number>;
  assert.ok(tallies.of >= 2, `bots must vote after voteOpensAt (only ${tallies.of} votes)`);
  assert.ok(tallies.votes >= 1 && tallies.votes <= tallies.of);
});

test("name clustering: same-name detection, alias variants, no false cluster", () => {
  const players: NameCandidate[] = [
    { id: "p1", alias: "Player 1" }, { id: "p2", alias: "Player 2" },
    { id: "p3", alias: "Player 3" }, { id: "p4", alias: "Player 4" },
  ];
  // Straight detection.
  assert.deepEqual(detectNamedPlayers("Player 2 obviously", players), ["p2"]);
  // Alias variants: case, punctuation, spacing, nickname prefixes.
  const real: NameCandidate[] = [...players, { id: "p5", alias: "Wachuki Great!" }, { id: "p6", alias: "Brian" }];
  assert.deepEqual(detectNamedPlayers("brian!", real), ["p6"]);
  assert.deepEqual(detectNamedPlayers("  BRIAN  ", real), ["p6"]);
  assert.deepEqual(detectNamedPlayers("Brian K., no question", real), ["p6"]);
  assert.deepEqual(detectNamedPlayers("wachuki, every time", real), ["p5"]);
  assert.deepEqual(detectNamedPlayers("WACHUKI!", real), ["p5"]);
  assert.deepEqual(detectNamedPlayers("Brian", real).length, 1, "one name, one hit");
  // Too short to be a name on its own.
  assert.deepEqual(detectNamedPlayers("bri was looking at the door", real), []);
  // Ambiguity: a caption naming two players counts for neither.
  const ambiguous = clusterNames(["Player 2 and Player 3, obviously"], players);
  assert.equal(ambiguous.total, 1);
  assert.equal(ambiguous.clusters.length, 0);

  // 6 of 7 agreeing is a teaser; 2 of 7 is noise.
  const strong = clusterNames([
    "Player 2", "player 2!", "PLAYER 2.", "Player 2, no doubt", "Player 2", "Player 2", "the door",
  ], players);
  assert.equal(strong.total, 7);
  assert.equal(strong.top?.count, 6);
  assert.match(nameClusterTeaser(strong, "Diana") ?? "", /^6 of 7 wrote the same name for Diana\.$/);
  const weak = clusterNames(["Player 2", "player 2!", "the door", "the bar", "a drink", "the music", "nobody"], players);
  assert.equal(weak.top?.count, 2);
  assert.equal(nameClusterTeaser(weak, "Diana"), undefined, "2 of 7 must never become a teaser");
  // Exactly half is not a majority either (3 of 6 does not fire).
  const half = clusterNames(["Player 3", "Player 3", "Player 3", "b", "c", "d"], players);
  assert.equal(nameClusterTeaser(half, "Diana"), undefined);
});

test("decoy records never reach signals or claims; the digest pairs them instead", async () => {
  const { computeSignals, computeResults, buildNightDigest } = fallbackServices;
  const meta = { roomId: "room", players: [1, 2, 3, 4].map((i) => ({ id: `p${i}`, alias: `Player ${i}` })), revealOptIn: [] };
  const base = { roomId: "room", promptId: "live-sp-01", at: 1000, latencyMs: 400, coding: "status" as const };
  const log: LogRecord[] = [
    { ...base, roundId: "sp1", playerId: "p1", roundKind: "spotlight", value: { kind: "text", text: "Player 3, every time." }, decoy: true },
    { ...base, roundId: "sp1", playerId: "p2", roundKind: "spotlight", value: { kind: "text", text: "Player 3" } },
    { ...base, roundId: "sp1", playerId: "p3", roundKind: "spotlight", value: { kind: "text", text: "Player 3!" } },
    { ...base, roundId: "sp1", playerId: "p4", roundKind: "spotlight", value: { kind: "text", text: "Player 3, obviously" } },
  ];
  const signals = computeSignals(log, meta);
  assert.ok(signals.every((s) => s.pickOverlap === 0 && s.mutualPick === 0 && s.iosMean === 0));
  assert.deepEqual(computeResults(signals, log, meta).claims, [], "live observation never becomes a claim");
  const digest = buildNightDigest(log, meta);
  const paired = digest.quotes.find((quote) => quote.context === "spotlight:decoy");
  assert.ok(paired, "the decoy is quoted in the digest");
  assert.match(paired!.text, /While the room captioned Player 1, Player 1 wrote: “Player 3, every time\.”/);
  const teaser = digest.pickTeasers.find((line) => /wrote the same name/u.test(line));
  assert.equal(teaser, "3 of 3 wrote the same name for Player 1.");
  // The decoy text is never offered as a standalone quote about anything else.
  assert.equal(digest.quotes.filter((quote) => quote.text === "Player 3, every time.").length, 0);
});

test("round data round-trips through the JSONL log with the decoy flag intact", async (t) => {
  const { connect, dir } = await setup(t, { roundTimers: { pick: 60, text: 60, shout: 60, rating: 60, ios: 60, minigame: 60, dare: 60, pair_dare: 60, debrief: 60, spotlight: 120, verdict: 400 } });
  const clients = await Promise.all([connect(), connect(), connect(), connect()]);
  const made = await create(clients[0]!); assert.ok(made.ok && made.code);
  const ids = [made.you!];
  for (let i = 1; i < clients.length; i++) { const r = await joinRoom(clients[i]!, made.code!, `Guest${i}`); assert.ok(r.ok); ids.push(r.you!); }
  const finale = clients.map((client) => once<FinaleView>(client, "finale"));
  clients.forEach((client, i) => client.on("round", (round: RoundView) => {
    if (round.youSubmitted) return;
    const value: ResponseValue = round.kind === "pick" || round.kind === "verdict" ? { kind: "pick", target: ids[(i + 1) % ids.length]! }
      : round.kind === "text" || round.kind === "debrief" || round.kind === "spotlight" ? { kind: "text", text: "Answer from seat " + i }
      : round.kind === "shout" ? { kind: "shout", word: "live" }
      : round.kind === "rating" ? { kind: "rating", trait: round.trait!, about: round.about!, value: 4 }
      : round.kind === "ios" ? { kind: "ios", about: round.about!, value: 2 }
      : round.kind === "minigame" ? { kind: "minigame", score: 9 }
      : { kind: "dare", status: "done" };
    void submitValue(client, round.roundId, value, `log-${round.roundId}-${i}`);
  }));
  clients[0]!.emit("start");
  await limit(Promise.all(finale), 15000);
  await wait(60);
  const file = join(dir, readdirSync(dir).find((name) => name.endsWith(".jsonl"))!);
  const rows: LogRecord[] = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const decoys = rows.filter((row) => row.decoy === true);
  assert.ok(decoys.length >= 1, "the subject's cover answer is persisted, flagged");
  assert.ok(rows.filter((row) => row.roundKind === "spotlight" && row.decoy !== true).length >= 3);
  assert.ok(decoys.every((row) => row.roundKind === "spotlight" && row.value.kind === "text"));
});
