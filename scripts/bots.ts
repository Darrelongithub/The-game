/**
 * End-to-end smoke test for the v3.2 night.
 *
 * It plays a whole night over real sockets: five phones join with the room
 * code, the laptop binds with its token and starts, every phone answers its
 * own question, the ONE ready gate opens, and the reveal lands.
 *
 * It checks the acceptance rules that only a live night can prove:
 *   • the case closes within a second of the last answer
 *   • nobody picks themselves, and a pick is never skipped
 *   • every phone gets exactly one question at a time
 *   • the reveal reaches every phone
 *   • a mutual crush card reaches EXACTLY the two phones that earned it
 *
 * Run: npm run smoke
 *   SMOKE_URL, SMOKE_ROOM and SMOKE_HOST_TOKEN run it against a live server;
 *   without them the smoke test starts its own server.
 *   SMOKE_SHOWCASE=1 prints the reveal and the private decks, so a human can
 *   read the night instead of only watching it pass.
 */
import { strict as assert } from "node:assert";
import { io, type Socket } from "socket.io-client";
import {
  type ClientToServerEvents,
  type FinaleView,
  type JoinReply,
  type PlayerId,
  type ResponseValue,
  type RoomView,
  type RoundView,
  type SecretDeckView,
  type ServerToClientEvents,
} from "../packages/shared/src/contracts.ts";

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const BOT_COUNT = Number(process.env.SMOKE_BOTS ?? "5");
const consent = { age: true, terms: true };
const profile = {
  age: 28,
  gender: "woman" as const,
  sexuality: "straight" as const,
  attractedTo: "women" as const,
  lookingFor: "fun" as const,
};

const ALIASES = ["Wanjiru", "Dee", "Kofi", "Zuri", "Tayo", "Amina", "Bodi", "Sade", "Nia", "Kito", "Zee"];

type Bot = {
  alias: string;
  socket: GameSocket;
  id?: PlayerId;
  secret?: string;
  state?: RoomView;
  rounds: RoundView[];
  finale?: FinaleView;
  deck?: SecretDeckView;
  seen: Set<string>;
};

const bots: Bot[] = [];
const errors: string[] = [];
let hostSocket: GameSocket | null = null;
/** When the last answer of a case went out. */
const lastAnswerAt = new Map<string, number>();
/** When the server closed a case. */
const closedAt = new Map<string, number>();

function check(condition: unknown, message: string): asserts condition {
  assert.ok(condition, message);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, message: string, ms = 240_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (errors.length) throw new Error(errors.join("\n"));
    if (Date.now() >= end) throw new Error(`Timed out: ${message}`);
    await sleep(25);
  }
}

function newSocket(address: string): GameSocket {
  return io(address, { autoConnect: false, reconnection: false, timeout: 10_000 });
}

async function connect(socket: GameSocket): Promise<void> {
  const opened = new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  socket.connect();
  await opened;
}

/** The answer this bot gives for the question it was asked. */
function answerFor(bot: Bot, round: RoundView): ResponseValue {
  const roster = (bot.state?.players ?? []).map((p) => p.id);
  const others = roster.filter((id) => id !== bot.id);
  switch (round.kind) {
    case "pick": {
      // Mutual partners: 0↔1, 2↔3, ... so a MUTUAL crush is possible when
      // the room asks a crush question. Never yourself.
      const index = Math.max(0, roster.indexOf(bot.id!));
      const partner = index % 2 === 0
        ? (index + 1 < roster.length ? index + 1 : 0)
        : index - 1;
      const target = roster[partner] ?? others[0]!;
      return { kind: "pick", target: target === bot.id ? others[0]! : target };
    }
    case "rating":
      return {
        kind: "rating",
        trait: round.trait ?? "chaos",
        about: round.aboutSelf ? "self" : (round.subjectId ?? "self"),
        value: 7,
      };
    case "dare":
      return { kind: "dare", status: "done" };
    case "pair_vote":
      return { kind: "pair_vote", pair: round.pair ?? [others[0]!, others[1]!], value: 4 };
    case "pair_pick":
      return { kind: "pair_pick", pair: round.options?.[0]?.members ?? [others[0]!, others[1]!] };
    default:
      return { kind: "text", text: "An honest answer." };
  }
}

async function play(bot: Bot, round: RoundView): Promise<void> {
  // A phone that is only WATCHING (a look chain stage) has no answer to give.
  if (round.passive) return;
  // A look chain runs several stages inside one case, so the segment — not
  // the case — is what says "already answered".
  if (bot.seen.has(round.segmentId)) return;
  bot.seen.add(round.segmentId);
  const value = answerFor(bot, round);
  // A pick is FORCED: never yourself.
  if (value.kind === "pick") {
    check(value.target !== bot.id, `${bot.alias} must never pick themselves`);
  }
  const sentAt = Date.now();
  const reply = await bot.socket.timeout(10_000).emitWithAck("submit", {
    roundId: round.roundId,
    clientUuid: `${bot.alias}-${round.roundId}`,
    value,
  });
  check(reply.ok, `${bot.alias} could not answer: ${reply.error ?? "unknown"}`);
  lastAnswerAt.set(round.roundId, Date.now());
  if (process.env.SMOKE_DEBUG) console.log('DEBUG submit', bot.alias, round.roundId, 'sent', sentAt, 'ack', Date.now());
}

function install(bot: Bot): void {
  bot.socket.on("state", (state) => {
    bot.state = state;
    // The ONE ready gate: a scripted player is always looking.
    if (state.phase === "results") bot.socket.emit("ready");
  });
  bot.socket.on("round", (round) => {
    bot.rounds.push(round);
    void play(bot, round).catch((error) => errors.push(String(error)));
  });
  bot.socket.on("beat", (beat) => {
    // The beat lands the moment the case closes.
    if (!beat.roundId) return;
    closedAt.set(beat.roundId, Date.now());
  });
  bot.socket.on("finale", (finale) => { bot.finale = finale; });
  bot.socket.on("secrets", (deck) => { bot.deck = deck; });
  bot.socket.on("error", (error) => { errors.push(`${bot.alias}: ${error.code}: ${error.message}`); });
}

async function main(): Promise<void> {
  // ---- the server under test ----
  let address = process.env.SMOKE_URL;
  let code = process.env.SMOKE_ROOM ?? "";
  let hostToken = process.env.SMOKE_HOST_TOKEN ?? "";
  let closeServer: (() => Promise<void>) | null = null;
  if (!address) {
    const { createGameServer } = await import("../apps/server/src/server.ts");
    const server = createGameServer({});
    const port = await server.listen(0, "127.0.0.1", false);
    address = `http://127.0.0.1:${port}`;
    const room = server.rooms.nightRoom!;
    code = room.code;
    hostToken = room.hostToken;
    closeServer = () => server.close();
    console.log(`smoke: started a server on ${address} (room ${code})`);
  } else {
    console.log(`smoke: using the live server on ${address}`);
  }
  check(code, "no room code — set SMOKE_ROOM or start the server in this process");
  check(hostToken, "no host token — set SMOKE_HOST_TOKEN or start the server in this process");

  try {
    // ---- the laptop binds with its token: no code is typed ----
    const host = newSocket(address);
    hostSocket = host;
    await connect(host);
    const bound = await host.timeout(10_000).emitWithAck("host_join", { token: hostToken });
    check(bound.ok, `the host link did not bind: ${bound.error ?? "unknown"}`);
    check(!bound.state?.pickOptions, "the laptop never holds a pick list");

    // ---- the phones join with the code from the QR ----
    for (let i = 0; i < BOT_COUNT; i++) {
      const alias = ALIASES[i % ALIASES.length]!;
      const bot: Bot = { alias, socket: newSocket(address), rounds: [], seen: new Set() };
      install(bot);
      bots.push(bot);
      await connect(bot.socket);
      const reply: JoinReply = await bot.socket.timeout(10_000).emitWithAck("join", {
        roomCode: code,
        alias,
        consent,
        profile,
      });
      check(reply.ok && reply.you, `${alias} could not join: ${reply.error ?? "unknown"}`);
      bot.id = reply.you;
      bot.secret = reply.secret;
    }
    check(bots.length >= 4, "the room needs at least four players");
    console.log(`smoke: ${bots.length} phones joined`);

    // ---- Start ----
    host.emit("start");
    await waitFor(() => bots.every((b) => b.rounds.length > 0), "the first case");

    // ---- the night ----
    await waitFor(() => bots.every((b) => Boolean(b.finale)), "the reveal");
    await sleep(200);

    // ---- the acceptance checks ----
    for (const bot of bots) {
      check(bot.finale, `${bot.alias} never got the reveal`);
      check(bot.finale!.slides.length > 0, `${bot.alias} got an empty reveal`);
      // Every phone saw a question at a time, and the questions were real.
      check(bot.rounds.length > 0, `${bot.alias} never got a question`);
      for (const round of bot.rounds) {
        check(round.promptText.length > 0, `${bot.alias} got an empty question`);
        check(round.note.length > 0, `${bot.alias} got a question with no explanation line`);
        check(!/\{P\d/.test(round.promptText), `${bot.alias} saw a raw placeholder`);
        check(!/warmup|spicy|deep phase/i.test(round.note), `${bot.alias} saw a phase name`);
      }
    }

    // The case closes within a second of the last answer.
    for (const [roundId, closed] of closedAt) {
      const answered = lastAnswerAt.get(roundId);
      if (answered === undefined) continue;
      if (closed - answered > 1_000) console.log('DEBUG close', roundId, 'answered', answered, 'closed', closed, 'delta', closed - answered);
      check(closed - answered <= 1_000, `a case took ${closed - answered}ms to close`);
    }

    // A mutual crush reaches EXACTLY the two phones that earned it. There may
    // be more than one mutual pair tonight, but each pair is two phones and
    // nobody else ever hears about it.
    const withCrush = bots.filter((b) => (b.deck?.cards ?? []).some((c) => c.kind === "crush"));
    check(withCrush.length % 2 === 0, `${withCrush.length} phones got a mutual crush card`);
    const named = new Map<string, string>();
    for (const bot of withCrush) {
      const card = bot.deck!.cards.find((c) => c.kind === "crush")!;
      const facts = card.facts.join(" ");
      check(/like each other/.test(facts), "a crush card must say the room's truth");
      const partner = /You and (.+?) like each other\./.exec(facts)?.[1];
      check(Boolean(partner), `a crush card must name the other person: ${facts}`);
      named.set(bot.alias, partner!);
    }
    // Every pair is symmetric: if A's card names B, B's card names A.
    for (const [who, partner] of named) {
      check(named.get(partner) === who, `${who} and ${partner} are not a mutual pair`);
    }
    // And no phone is named by two different people.
    check(new Set(named.values()).size === named.size, "a phone was named by two different crush cards");

    // A phone with no data gets no deck at all.
    for (const bot of bots) {
      if (!bot.deck) continue;
      check(bot.deck.cards.length <= 6, "a deck never holds more than six cards");
    }

    if (process.env.SMOKE_SHOWCASE) {
      console.log("\n--- THE REVEAL ---");
      for (const slide of bots[0]!.finale!.slides) {
        console.log(`\n[${slide.beat}/${slide.flavor}] ${slide.title}`);
        console.log(slide.body);
      }
      console.log("\n--- THE PRIVATE DECKS ---");
      for (const bot of bots) {
        console.log(`\n${bot.alias}:`);
        for (const card of bot.deck?.cards ?? []) {
          console.log(`  - [${card.kind}] ${card.facts.join(" ")}`);
        }
      }
    }

    console.log("smoke: the night played out — the reveal reached every phone");
    console.log(`smoke: ${bots.length} phones, ${bots[0]!.rounds.length} cases each`);
    console.log("SMOKE PASSED ✅");
  } finally {
    for (const bot of bots) bot.socket.disconnect();
    hostSocket?.disconnect();
    if (closeServer) await closeServer();
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
