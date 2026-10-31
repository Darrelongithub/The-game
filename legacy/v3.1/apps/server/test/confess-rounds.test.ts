// apps/server/test/confess-rounds.test.ts
// STEP 5 (server) — CONFESS ROUNDS end to end, over real sockets.
//
// The night balances two voices: group questions ("Who here…") capture the
// room's PERCEPTION, confessions ("Have you ever…") capture REALITY — the same
// question to everyone, answered privately about themselves. These tests hold
// the HARD secrecy line at the only place it can leak: the reveal payload.
//
//   * a confess round collects PRIVATE answers; a phone that never answers
//     stays MISSING (it never becomes a "no");
//   * the WARM tier (warmup) is counts only — no alias, no PlayerId anywhere
//     in the payload (asserted by re-serialising the whole reveal);
//   * the SPICY tier attributes YES answers only, and a person who said NO is
//     never named in ANY tier, note included;
//   * notes are anonymous at warm and attributed at spicy;
//   * a twin (group seed → its confess twin 1–3 rounds later) is served inside
//     its window and its mismatch line reaches the finale WITHOUT naming a no.
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { io, type Socket } from "socket.io-client";
import type {
  ClientToServerEvents, ConfessRevealView, FinaleView, JoinReply, LogRecord, ResponseValue,
  RevealView, RoundView, ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { createGameServer } from "../src/server.ts";

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
const consent = { age: true, terms: true, revealOptIn: true };
const profile = { age: 28, relationship: "single" as const, partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" as const };
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const limit = <T>(promise: Promise<T>, ms = 20_000): Promise<T> => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
  promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});
const event = <T>(client: Client, name: string): Promise<T> => new Promise((resolve) => (client as any).once(name, resolve));

/** How one seat answers a confession this round. `"skip"` is NOT an option in
 *  the product — it models a phone that simply never got there in time. */
type ConfessScript = { yes: boolean; note?: string; target?: number } | "skip";

interface StyledEntry {
  roundIndex: number; style: string; kind: string; promptId: string;
  twin?: { groupPromptId: string; groupRoundIndex: number; dueAt: number };
}

interface ConfessNight {
  ids: string[];
  aliases: string[];
  rounds: RoundView[];
  reveals: RevealView[];
  finale: FinaleView;
  rows: LogRecord[];
  skipped: string[];
  styled: StyledEntry[];
}

async function playConfessNight(
  t: TestContext,
  options: {
    aliases: string[];
    script: (phase: string, seat: number) => ConfessScript;
    /** which seat this seat points at in a group pick (default: the next seat) */
    pickTarget?: (seat: number) => number;
  },
): Promise<ConfessNight> {
  const dir = mkdtempSync(join(tmpdir(), "reveal-confess-"));
  const styled: StyledEntry[] = [];
  const server = createGameServer({
    revealMode: "round", dataDir: dir,
    roundTimers: { pick: 500, shout: 400, minigame: 400, rating: 400, ios: 400, text: 500,
      dare: 400, pair_dare: 400, debrief: 400, spotlight: 400, verdict: 500, confess: 400 },
    verdictDiscussMs: 0, graceMs: 60, revealHoldMs: 5, interludeHoldMs: 5, botDelayMs: [5, 10],
    audit: {
      persisted: () => {}, decks: () => {},
      styled: (_code, entry) => styled.push(entry),
    },
  });
  const port = await server.listen(0, "127.0.0.1", false);
  const base = `http://127.0.0.1:${port}`;
  const sockets: Client[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  for (const alias of options.aliases) {
    const socket: Client = io(base, { forceNew: true, transports: ["polling", "websocket"], reconnection: false, autoConnect: false });
    sockets.push(socket);
    socket.on("error", () => {});
    socket.on("state", (view) => { if (view.ready) socket.emit("ready"); });
    const ready = event<void>(socket, "connect");
    socket.connect();
    await limit(ready);
  }
  const first = await new Promise<JoinReply & { code?: string }>((resolve) =>
    sockets[0]!.emit("create", { alias: options.aliases[0]!, consent, profile }, resolve));
  assert.equal(first.ok, true);
  const replies: JoinReply[] = [first];
  for (let i = 1; i < sockets.length; i++) {
    replies.push(await new Promise<JoinReply>((resolve) =>
      sockets[i]!.emit("join", { roomCode: first.code!, alias: options.aliases[i]!, consent, profile }, resolve)));
  }
  assert.ok(replies.every((reply) => reply.ok), "every player joined");
  const ids = replies.map((reply) => reply.you!);

  const rounds: RoundView[] = [];
  const reveals: RevealView[] = [];
  const seenReveals = new Set<string>();
  const skipped: string[] = [];
  const finales = sockets.map((socket) => event<FinaleView>(socket, "finale"));
  sockets.forEach((socket, i) => {
    socket.on("round", (round: RoundView) => {
      if (i === 0 && !rounds.some((seen) => seen.roundId === round.roundId)) rounds.push(round);
      if (round.expectsAnswer === false || round.youSubmitted) return;
      if (round.onlyPlayers && !round.onlyPlayers.includes(ids[i]!)) return;
      let value: ResponseValue;
      switch (round.kind) {
        case "confess": {
          const scripted = options.script(round.phase, i);
          if (scripted === "skip") { skipped.push(round.roundId); return; }
          value = {
            kind: "confess", yes: scripted.yes,
            ...(scripted.note ? { note: scripted.note } : {}),
            ...(scripted.target !== undefined ? { target: ids[scripted.target]! } : {}),
          };
          break;
        }
        case "pick": case "verdict":
          value = { kind: "pick", target: ids[(options.pickTarget ?? ((seat) => (seat + 1) % ids.length))(i)]! };
          break;
        case "shout": value = { kind: "shout", word: "vibes" }; break;
        case "text": case "spotlight": value = { kind: "text", text: `Caption from seat ${i} about the room.` }; break;
        case "debrief": value = { kind: "text", text: `PRIVATE_DEBRIEF_${i} stays private.` }; break;
        case "rating": value = { kind: "rating", trait: round.trait!, about: round.about!, value: 7 }; break;
        case "ios": value = { kind: "ios", about: round.about!, value: 5 }; break;
        case "minigame": value = { kind: "minigame", score: 20 + i }; break;
        case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
      }
      socket.emit("submit", { roundId: round.roundId, clientUuid: `seat-${i}-${round.roundId}`, value }, () => {});
    });
    socket.on("reveal", (view: RevealView) => {
      if (seenReveals.has(view.roundId)) return;
      seenReveals.add(view.roundId);
      reveals.push(view);
    });
  });
  sockets[0]!.emit("start");
  const finished = await Promise.all(finales.map((promise) => limit(promise)));
  await wait(80);
  const rows: LogRecord[] = readFileSync(join(dir, readdirSync(dir).find((name) => name.endsWith(".jsonl"))!), "utf8")
    .trim().split("\n").map((line) => JSON.parse(line));
  return { ids, aliases: options.aliases, rounds, reveals, finale: finished[0]!, rows, skipped, styled };
}

const confessReveals = (reveals: RevealView[]): { view: RevealView; confess: ConfessRevealView }[] =>
  reveals.flatMap((view) => (view.confess ? [{ view, confess: view.confess }] : []));

test("a confess round collects private answers, once per phone, and a missing phone stays missing", { timeout: 45_000 }, async (t) => {
  const night = await playConfessNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"], script: () => ({ yes: true }) });
  const confessions = night.rounds.filter((round) => round.kind === "confess");
  assert.ok(confessions.length >= 3, "every heat phase deals a confession: the second voice has a guaranteed seat");
  assert.ok(confessions.every((round) => /^Have you ever/iu.test(round.promptText)), "a confess round speaks in the second voice");
  assert.ok(confessions.every((round) => round.expectsAnswer !== false), "a confession expects an answer (there is no skip button)");

  const answers = night.rows.filter((row) => row.roundKind === "confess");
  const perRound = new Map<string, LogRecord[]>();
  for (const row of answers) perRound.set(row.roundId, [...(perRound.get(row.roundId) ?? []), row]);
  assert.equal(perRound.size, confessions.length, "every confess round persisted its answers");
  for (const [, records] of perRound) {
    assert.equal(records.length, 4, "exactly one record per phone — nothing synthesised, nothing doubled");
    assert.ok(records.every((record) => record.value.kind === "confess"), "confessions persist as confess values");
    assert.equal(new Set(records.map((record) => record.playerId)).size, 4, "answers stay per-player");
  }
  // A confession is about the SELF: no answer may smuggle another player's alias.
  const raw = JSON.stringify(night.rows);
  for (const alias of night.aliases) assert.ok(!raw.includes(alias), `an alias (${alias}) reached the room log`);
  assert.ok(!JSON.stringify(night.reveals).includes("PRIVATE_DEBRIEF_"), "private debrief text never reaches a reveal");
});

test("warm reveal is COUNT ONLY and the payload carries no name and no id", { timeout: 45_000 }, async (t) => {
  // Warmup: seat 0 yes+note, seat 1 no+note, seat 2 yes, seat 3 never answers.
  const night = await playConfessNight(t, {
    aliases: ["Alice", "Brian", "Chao", "Diana"],
    script: (phase, seat) => phase === "warmup"
      ? (seat === 0 ? { yes: true, note: "I really have." }
        : seat === 1 ? { yes: false, note: "Absolutely not." }
          : seat === 2 ? { yes: true } : "skip")
      : { yes: seat !== 1 },
  });
  assert.ok(night.skipped.length >= 1, "at least one phone really did miss a confession");
  const warmRound = night.rounds.find((round) => round.phase === "warmup" && round.kind === "confess");
  assert.ok(warmRound);
  const warm = confessReveals(night.reveals).find((entry) => entry.view.roundId === warmRound.roundId);
  assert.ok(warm, "the warm confession reveals through the ready gate like every other reveal");
  assert.equal(warm.confess.tier, "warm");
  assert.equal(warm.confess.of, 4);
  assert.equal(warm.confess.yes, 2);
  assert.equal(warm.confess.no, 1);
  assert.equal(warm.confess.missing, 1, "a phone that never answered is MISSING — never converted to a no");
  assert.equal(warm.confess.attributed, undefined, "warm names nobody, not even the yeses");
  assert.equal(warm.view.summary, "2 of 4 said yes.");
  assert.deepEqual(warm.confess.notes, [{ text: "I really have." }, { text: "Absolutely not." }],
    "warm notes are anonymised, including the one attached to a no");

  const payload = JSON.stringify(warm.view);
  for (const id of night.ids) assert.ok(!payload.includes(id), `warm reveal leaked a PlayerId (${id})`);
  for (const alias of night.aliases) assert.ok(!payload.includes(alias), `warm reveal leaked the alias ${alias}`);
  for (const item of warm.view.items ?? []) {
    assert.ok(!night.aliases.includes(item.alias ?? ""), "no reveal item may name a player at warm");
  }
  // The persisted log does not carry the note into any public line either.
  assert.ok(!JSON.stringify(night.rows.filter((row) => row.roundKind !== "confess")).includes("I really have."));
});

test("spicy attributes YES answers and notes, and never names a no — in any tier", { timeout: 45_000 }, async (t) => {
  const aliases = ["Alice", "Brian", "Chao", "Diana"];
  const night = await playConfessNight(t, {
    aliases,
    // Seat 1 says NO in every hotter phase, with a note that must stay anonymous.
    // Seats 0 and 3 say yes; seat 2 says yes and points at seat 0.
    script: (phase, seat) => phase === "warmup"
      ? { yes: seat === 3 }
      : (seat === 1 ? { yes: false, note: "Hard no." }
        : seat === 2 ? { yes: true, target: 0 }
          : { yes: true, note: seat === 0 ? "Yes, and I would again." : undefined }),
  });
  const confessions = new Map(night.rounds.filter((round) => round.kind === "confess").map((round) => [round.roundId, round]));
  const spicy = confessReveals(night.reveals).filter((entry) => entry.confess.tier === "spicy");
  assert.ok(spicy.length >= 2, "spicy AND deep confessions both reveal with attribution");
  const noAlias = aliases[1]!;
  for (const { view, confess } of spicy) {
    const round = confessions.get(view.roundId);
    assert.ok(round && round.phase !== "warmup");
    assert.equal(confess.of, 4);
    assert.equal(confess.yes, 3);
    assert.equal(confess.no, 1);
    assert.equal(confess.missing, 0);
    assert.ok(confess.attributed && confess.attributed.length === 3, "every yes is attributed, and only yeses");
    assert.deepEqual([...confess.attributed.map((entry) => entry.alias)].sort(), [aliases[0]!, aliases[2]!, aliases[3]!].sort());
    const payload = JSON.stringify(view);
    assert.ok(!payload.includes(noAlias), "a NO answerer is never named in any tier");
    for (const id of night.ids) assert.ok(!payload.includes(id), "no PlayerId ever reaches a reveal");
    for (const item of view.items ?? []) assert.notEqual(item.alias, noAlias, "a no never becomes a reveal item");
    assert.deepEqual(confess.notes, [{ text: "Hard no." }], "a note on a NO stays anonymous at spicy");
    if (round.phase === "spicy") {
      assert.equal(confess.attributed.find((entry) => entry.alias === aliases[0])?.note, "Yes, and I would again.",
        "a note on a YES is attributed at spicy");
    }
  }
  const hot = spicy[0]!;
  assert.match(hot.view.summary, /^3 of 4 said yes\./u);
  assert.ok(!JSON.stringify(confessReveals(night.reveals).map((entry) => entry.view)).includes(noAlias),
    "the no-answerer never appears in any confess reveal all night");
  // The target a yes pointed at is never exposed by the reveal either.
  for (const { view } of spicy) assert.ok(!view.summary.includes(aliases[0]!));
});

test("a twin is served 1–3 rounds after its group seed and the mismatch line never exposes a no", { timeout: 45_000 }, async (t) => {
  // Everyone points at seat 0, so any served group twin has a perceived target;
  // seat 1 says NO to every confession and must never be connected to one.
  const night = await playConfessNight(t, {
    aliases: ["Alice", "Brian", "Chao", "Diana"],
    script: (_phase, seat) => ({ yes: seat !== 1 }),
    pickTarget: (seat) => (seat === 0 ? 1 : 0),
  });
  const twins = night.styled.filter((entry) => entry.twin);
  assert.ok(twins.length >= 1, "the director scheduled at least one perception → reality twin");
  for (const twin of twins) {
    const gap = twin.roundIndex - twin.twin!.groupRoundIndex;
    assert.ok(gap >= 1 && gap <= 3, `a twin is served 1–3 rounds after its group seed (got ${gap})`);
    assert.equal(twin.roundIndex, twin.twin!.dueAt, "and it is served exactly when it was planned");
    assert.equal(twin.kind, "confess");
    assert.equal(twin.style, "confess");
  }
  assert.equal(new Set(twins.map((twin) => twin.roundIndex)).size, twins.length, "one round never serves two twins");

  const slides = night.finale.slides;
  const mismatch = slides.filter((slide) => slide.title === "Perception and reality");
  assert.ok(mismatch.length >= 1, "the scripted mismatch reaches the finale");
  const body = mismatch[0]!.body ?? "";
  assert.match(body, /^The room was sure it was Alice\. Three people just said yes\.$/u,
    "the payoff names the room's guess and counts the yeses — nothing else");
  assert.ok(!body.includes(night.aliases[1]!), "the person who said no is never named by the payoff");
  assert.ok(!/\bsaid no\b|\bno one\b|\bnope\b/iu.test(body), "the payoff never exposes a no");
  assert.ok(!/\bno\b/iu.test(body.replace(/nobody/giu, "")), "the payoff never exposes a no");
});

test("determinism: the same scripted night selects the same voices and reveals twice", { timeout: 60_000 }, async (t) => {
  const script = (phase: string, seat: number): ConfessScript => (phase === "warmup"
    ? (seat === 0 ? { yes: true, note: "I have." } : seat === 1 ? { yes: false, note: "No." } : { yes: true })
    : { yes: seat !== 2, ...(seat === 0 ? { note: "Still yes." } : {}) });
  const first = await playConfessNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"], script });
  const second = await playConfessNight(t, { aliases: ["Alice", "Brian", "Chao", "Diana"], script });
  const plan = (night: ConfessNight) => night.styled.map((entry) => `${entry.roundIndex}:${entry.style}:${entry.kind}:${entry.promptId}`);
  assert.deepEqual(plan(first), plan(second), "same log → the same selection, voice for voice");
  assert.deepEqual(
    confessReveals(first.reveals).map((entry) => entry.confess),
    confessReveals(second.reveals).map((entry) => entry.confess),
    "same log → the same reveals",
  );
});
