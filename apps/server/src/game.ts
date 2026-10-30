import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, Socket } from "socket.io";
import {
  DARE_ROUNDS, GRACE_MS, HEAT_ORDER, IDLE_TTL_HOURS, INTERLUDE_HOLD_MS,
  MAX_PLAYERS, MIN_PLAYERS, RETENTION_HOURS, REVEAL_HOLD_MS, ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH, ROUNDS_PER_PHASE, ROUND_TIMERS_MS, SECRET_DECK_MAX, SPOTLIGHT_ANSWER_MAX,
  SPOTLIGHT_REVEAL_MS, TRAITS, VERDICT_DISCUSS_MS, VERDICT_REVEAL_MS, VERDICT_VOTE_MS, pseudonym,
  type ClientToServerEvents, type Consent, type FinaleSlide, type FinaleView, type InterludeView,
  type JoinReply, type LogRecord, type NightDigest, type Phase, type PlayerId, type Prompt,
  type ResponseValue, type RevealView, type RoomMeta, type RoomView, type RoundKind,
  type RoundView, type SecretCard, type SecretDeckView, type ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { isAlias, isRoomCode, playerCountOk, validSubmit } from "../../../packages/shared/src/validate.ts";
import { BankPromptProvider, fallbackServices, type GameServices, type HeatPhase, type PromptProvider } from "./services.ts";
import { DECOYS, SPOTLIGHT_IDLE_LINE, liveKindInPhase, livePrompt, liveSeeds, type LiveSeed } from "../../../packages/prompts/src/bank/live/index.ts";
import { checkBanned, checkHardBlocked } from "../../../packages/prompts/src/filter.ts";
import type { AccountStore } from "./accounts.ts";

type SocketData = { roomCode?: string; playerId?: string };
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type GameIO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Stage = "lobby" | "round" | "reveal" | "interlude" | "finale-building" | "finale" | "deleted";
interface Player { id: string; alias: string; consent: Consent; secret: string; isBot: boolean; connected: boolean; socketId?: string; /** ROUND 4: bound account (never emitted). */ accountId?: string; }
interface Definition {
  prompt: Prompt; phase: Phase; kind: RoundKind; text: string; onlyPlayers?: string[];
  /** spotlight: the player the room is watching. Their round view is a cover. */
  subjectId?: string;
  /** spotlight: the cover question this subject sees instead of the real one. */
  decoyText?: string;
  /** spotlight: the subject gets no question at all — an idle cover screen. */
  idle?: boolean;
  /** spotlight: "name" seeds produce a name cluster (digest teaser), "text" seeds are captions. */
  cluster?: "name" | "text";
  /** verdict: couple-coded verdicts celebrate on the land beat. */
  couple?: boolean;
}
interface LiveRound extends Definition {
  id: string; index: number; startedAt: number; closesAt: number; responses: Map<string, ResponseValue>;
  /** verdict: the secret simultaneous pick opens here (discussion before it). */
  voteOpensAt?: number;
}
interface SeenSubmit { roundId: string; fingerprint: string; }
interface TimedEvent<T> { value: T; endsAt: number; }
interface Room {
  id: string; code: string; createdAt: number; lastActivity: number; file: string; hostId: string;
  players: Player[]; phase: Phase; stage: Stage; seq: number; nextPlayer: number; roundIndex: number;
  provider: PromptProvider; prepared: boolean; usedIds: Set<string>; custom: Prompt[]; log: LogRecord[];
  currentHeat?: HeatPhase; queue: Definition[]; round: LiveRound | null; pair?: [string, string];
  interactions: Map<string, number>; seen: Map<string, SeenSubmit>; votes: Set<string>;
  /** spotlight rotation: each player at most once a night, never back-to-back. */
  spotlighted: Set<string>; lastSubject?: string;
  pendingHeatDown?: HeatPhase; reveal?: TimedEvent<RevealView>; interlude?: TimedEvent<InterludeView>;
  finale?: FinaleView; decks: Map<string, SecretDeckView>; rng: () => number;
  timer?: ReturnType<typeof setTimeout>; botTimers: Set<ReturnType<typeof setTimeout>>;
}
export interface GameOptions {
  dataDir: string;
  services?: GameServices;
  /** ROUND 4 identity store. Absent = guest-only night, identical gameplay. */
  accounts?: AccountStore;
  now?: () => number;
  /** Testing seams, not environment overrides; production uses the frozen tunables. */
  roundTimers?: Partial<Record<RoundKind, number>>;
  /** Testing seam for the verdict debate window (production: VERDICT_DISCUSS_MS). */
  verdictDiscussMs?: number;
  graceMs?: number;
  revealHoldMs?: number;
  interludeHoldMs?: number;
  botDelayMs?: [number, number];
  writerTimeoutMs?: number;
  /** In-process test observer only; never configured by the production entry point. */
  audit?: {
    persisted(roomCode: string, file: string, request: { roundId: string; playerId: string; clientUuid: string }): void;
    decks(roomCode: string, roomId: string, players: string[], decks: ReadonlyMap<string, SecretDeckView>, results: import("../../../packages/shared/src/contracts.ts").Results): void;
  };
}
const HOUR = 60 * 60 * 1000;
const PAIR_KEY = (a: string, b: string): string => [a, b].sort().join("\u0000");
const secret = (): string => randomBytes(32).toString("base64url");
const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const validConsent = (v: unknown): v is Consent => !!v && typeof v === "object" &&
  (v as Consent).age === true && (v as Consent).terms === true && typeof (v as Consent).revealOptIn === "boolean";
const validAlias = (v: unknown): v is string => typeof v === "string" && isAlias(v) && !/[\u0000-\u001f\u007f]/u.test(v);
const emptyDigest = (): NightDigest => ({ quotes: [], stats: {}, runningGags: [], pickTeasers: [], dodges: [], selfVsRoom: [] });
const seedRng = (id: string): (() => number) => {
  let seed = createHash("sha256").update(id).digest().readUInt32LE(0);
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Replace aliases in arbitrary free text before a service can see the data. */
function pseudonymizeText(text: string, players: Player[]): string {
  const names = players.map((p, i) => ({ alias: p.alias, pseudo: pseudonym(i) })).sort((a, b) => b.alias.length - a.alias.length);
  if (!names.length) return text;
  const re = new RegExp(names.map((n) => escapeRegExp(n.alias)).join("|"), "giu");
  return text.replace(re, (match) => names.find((n) => n.alias.toLocaleLowerCase() === match.toLocaleLowerCase())?.pseudo ?? match);
}
function displayText(text: string, players: Player[]): string {
  return text.replace(/\bPlayer (1[01]|[1-9])\b/g, (match, n: string) => players[Number(n) - 1]?.alias ?? match);
}
/** Strip uncontracted properties before logging or handing an answer to any service. */
function canonicalValue(value: ResponseValue): ResponseValue {
  switch (value.kind) {
    case "pick": return { kind: "pick", target: value.target };
    case "text": return { kind: "text", text: value.text };
    case "shout": return { kind: "shout", word: value.word };
    case "rating": return { kind: "rating", trait: value.trait, about: value.about, value: value.value };
    case "ios": return { kind: "ios", about: value.about, value: value.value };
    case "minigame": return { kind: "minigame", score: value.score };
    case "dare": return value.status === "passed" ? { kind: "dare", status: "passed", reason: value.reason } : { kind: "dare", status: "done" };
  }
}
function validPlaceholders(text: string): boolean {
  return !/[{}]/u.test(text.replace(/\{P(?:1[01]|[1-9])\}/g, ""));
}
function redactValue(value: ResponseValue, players: Player[]): ResponseValue {
  if (value.kind === "text") return { ...value, text: pseudonymizeText(value.text, players) };
  if (value.kind === "shout") return { ...value, word: pseudonymizeText(value.word, players) };
  if (value.kind === "dare" && value.reason) return { ...value, reason: pseudonymizeText(value.reason, players) };
  return { ...value };
}
function asSafePrompt(x: unknown, phase: HeatPhase): x is Prompt {
  if (!x || typeof x !== "object") return false;
  const p = x as Prompt;
  return typeof p.id === "string" && p.id.length > 0 && p.phase === phase &&
    ["bank", "host", "grok"].includes(p.source) &&
    ["pick", "text", "shout", "rating", "ios", "minigame", "dare", "pair_dare"].includes(p.kind) &&
    typeof p.text === "string" && p.text.trim().length > 0 && p.text.length <= 160 && validPlaceholders(p.text) &&
    Array.isArray(p.measures) && p.measures.length > 0 && p.measures.every((m) => typeof m === "string" && m.length > 0) &&
    ["couple", "friendship", "trust", "friction", "rivalry", "status", "neutral"].includes(p.coding) && p.asksTarget === true;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly services: GameServices;
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  constructor(private readonly io: GameIO, private readonly options: GameOptions) {
    this.services = options.services ?? fallbackServices;
    this.now = options.now ?? Date.now;
    mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
    this.purge();
    this.sweepTimer = setInterval(() => this.purge(), HOUR);
    this.sweepTimer.unref();
    io.on("connection", (socket) => this.bind(socket));
  }
  close(): void {
    clearInterval(this.sweepTimer);
    for (const room of this.rooms.values()) { room.stage = "deleted"; this.clearRoomMemory(room); }
    this.transitions.clear(); this.rooms.clear();
  }
  private clearRoomMemory(room: Room): void {
    this.clearTimers(room);
    room.log.length = 0; room.decks.clear(); room.seen.clear(); room.interactions.clear(); room.votes.clear(); room.usedIds.clear();
    room.players.forEach((p) => { p.secret = ""; p.alias = ""; }); room.players.length = 0;
    room.round = null; room.queue = []; room.custom = []; room.pair = undefined; room.reveal = undefined; room.interlude = undefined; room.finale = undefined;
    room.currentHeat = undefined; room.pendingHeatDown = undefined; room.spotlighted.clear(); room.lastSubject = undefined;
    room.provider.dispose?.(); room.provider = new BankPromptProvider();
  }
  private code(): string {
    for (let tries = 0; tries < 10000; tries++) {
      let code = "";
      for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("No room code available");
  }
  private clearTimers(room: Room): void {
    if (room.timer) clearTimeout(room.timer);
    room.timer = undefined;
    for (const timer of room.botTimers) clearTimeout(timer);
    room.botTimers.clear();
  }
  private schedule(room: Room, ms: number, fn: () => void): void {
    if (room.timer) clearTimeout(room.timer);
    room.timer = setTimeout(() => { room.timer = undefined; if (room.stage !== "deleted") fn(); }, Math.max(0, ms));
    room.timer.unref();
  }
  /**
   * ROUND 4 — bind a joined player to an account (REST, after `join`). The
   * player's own session secret is the proof, so a room code alone cannot
   * attach somebody else. The binding never leaves the server and never changes
   * a payload: guests and account holders play exactly the same game.
   */
  bindAccount(input: { roomCode: string; playerId: string; playerSecret: string; accountId: string }): boolean {
    const room = this.rooms.get(input.roomCode);
    if (!room || room.stage === "deleted") return false;
    const player = room.players.find((p) => p.id === input.playerId && !p.isBot);
    if (!player || !player.secret || !safeEqual(player.secret, input.playerSecret)) return false;
    player.accountId = input.accountId;
    room.lastActivity = this.now();
    return true;
  }
  private err(socket: GameSocket, code: string, message: string): void { socket.emit("error", { code, message }); }
  private identify(socket: GameSocket): { room: Room; player: Player } | undefined {
    const room = socket.data.roomCode ? this.rooms.get(socket.data.roomCode) : undefined;
    const player = room?.players.find((p) => p.id === socket.data.playerId && p.socketId === socket.id && p.connected);
    if (!room || !player || room.stage === "deleted") { this.err(socket, "NOT_IN_ROOM", "Join a room first."); return undefined; }
    room.lastActivity = this.now();
    return { room, player };
  }
  private host(socket: GameSocket): { room: Room; player: Player } | undefined {
    const found = this.identify(socket);
    if (found && found.room.hostId !== found.player.id) { this.err(socket, "HOST_ONLY", "Only the host can do that."); return undefined; }
    return found;
  }
  private view(room: Room, playerId: string): RoomView {
    return { code: room.code, phase: room.phase, hostId: room.hostId,
      players: room.players.map(({ id, alias, connected, isBot }) => ({ id, alias, connected, isBot })),
      round: room.round ? this.roundView(room.round, playerId) : null, seq: room.seq };
  }
  /**
   * The ONLY place a round is rendered for a phone, which makes it the only
   * place the spotlight secret has to be kept.
   *
   * A spotlight subject gets the cover round — a decoy question or an idle
   * screen — and NEVER the real promptText. The real question does not ride
   * `state`, `round`, `reveal` or any other emit to that socket, and the reveal
   * payload carries captions only (never the question).
   */
  private roundView(round: LiveRound, playerId: string): RoundView {
    const cover = round.kind === "spotlight" && round.subjectId === playerId;
    const promptText = cover ? (round.idle ? SPOTLIGHT_IDLE_LINE : round.decoyText ?? SPOTLIGHT_IDLE_LINE) : round.text;
    return { roundId: round.id, index: round.index, phase: round.phase, kind: round.kind, promptText,
      closesAt: round.closesAt, youSubmitted: round.responses.has(playerId),
      ...(round.onlyPlayers ? { onlyPlayers: [...round.onlyPlayers] } : {}),
      ...(round.voteOpensAt !== undefined ? { voteOpensAt: round.voteOpensAt } : {}),
      ...(cover && round.idle ? { expectsAnswer: false } : {}) };
  }
  private eachSocket(room: Room, fn: (socket: GameSocket, player: Player) => void): void {
    for (const p of room.players) if (!p.isBot && p.connected && p.socketId) {
      const socket = this.io.sockets.sockets.get(p.socketId);
      if (socket) fn(socket, p);
    }
  }
  private states(room: Room): void { this.eachSocket(room, (s, p) => s.emit("state", this.view(room, p.id))); }
  private changed(room: Room): void { room.seq++; this.states(room); }
  private replay(room: Room, socket: GameSocket, player: Player): void {
    if (room.round) socket.emit("round", this.roundView(room.round, player.id));
    if (room.reveal) socket.emit("reveal", { ...room.reveal.value, holdMs: Math.max(0, room.reveal.endsAt - this.now()) });
    if (room.interlude) socket.emit("interlude", { ...room.interlude.value, holdMs: Math.max(0, room.interlude.endsAt - this.now()) });
    if (room.finale) {
      socket.emit("finale", room.finale);
      const deck = room.decks.get(player.id);
      if (deck) socket.emit("secrets", deck); // exactly this authenticated socket
    }
  }
  private bind(socket: GameSocket): void {
    socket.on("create", (input, reply) => {
      const ack = typeof reply === "function" ? reply : () => {};
      if (socket.data.playerId) return ack({ ok: false, error: "Already joined a room." });
      if (!input || !validAlias(input.alias) || !validConsent(input.consent)) return ack({ ok: false, error: "Enter a 2–14 character alias and accept the 18+ and terms consent." });
      const code = this.code(), now = this.now(), id = randomBytes(16).toString("hex");
      const file = join(this.options.dataDir, `${now}-${id}.jsonl`);
      try { writeFileSync(file, "", { flag: "wx", mode: 0o600 }); } catch { return ack({ ok: false, error: "Unable to create room storage." }); }
      const player: Player = { id: "p1", alias: input.alias.trim(), consent: { ...input.consent }, secret: secret(), isBot: false, connected: true, socketId: socket.id };
      let provider: PromptProvider;
      try { provider = this.services.createPromptProvider(id); } catch { provider = new BankPromptProvider(); }
      const room: Room = { id, code, createdAt: now, lastActivity: now, file, hostId: player.id, players: [player], phase: "lobby", stage: "lobby", seq: 1, nextPlayer: 2, roundIndex: 0,
        provider, prepared: false, usedIds: new Set(), custom: [], log: [], queue: [], round: null, interactions: new Map(), seen: new Map(), votes: new Set(), spotlighted: new Set(), decks: new Map(), rng: seedRng(id), botTimers: new Set() };
      this.rooms.set(code, room); socket.data = { roomCode: code, playerId: player.id }; void socket.join(code);
      ack({ ok: true, code, you: player.id, secret: player.secret, state: this.view(room, player.id) });
      this.states(room);
    });
    socket.on("join", (input, reply) => {
      const ack: (r: JoinReply) => void = typeof reply === "function" ? reply : () => {};
      if (!input || !isRoomCode(input.roomCode) || !validAlias(input.alias) || !validConsent(input.consent)) return ack({ ok: false, error: "Invalid room code, alias, or consent." });
      const room = this.rooms.get(input.roomCode);
      if (!room || room.stage === "deleted") return ack({ ok: false, error: "Room not found." });
      if (socket.data.playerId && (socket.data.roomCode !== room.code || socket.data.playerId !== input.resume?.playerId)) return ack({ ok: false, error: "Already joined a room." });
      let player: Player;
      if (input.resume) {
        const candidate = room.players.find((p) => p.id === input.resume?.playerId && !p.isBot);
        if (!candidate || typeof input.resume.secret !== "string" || !safeEqual(candidate.secret, input.resume.secret)) return ack({ ok: false, error: "Invalid or expired session." });
        player = candidate;
        if (player.socketId && player.socketId !== socket.id) {
          const old = this.io.sockets.sockets.get(player.socketId);
          if (old) { old.data = {}; void old.leave(room.code); this.err(old, "SESSION_REPLACED", "This session reconnected elsewhere."); old.disconnect(true); }
        }
        // Rotate on every successful re-join; previously issued tokens cannot be replayed.
        player.secret = secret(); player.connected = true; player.socketId = socket.id;
      } else {
        if (room.stage !== "lobby") return ack({ ok: false, error: "The game has already started." });
        if (room.players.length >= MAX_PLAYERS) return ack({ ok: false, error: "Room is full." });
        if (room.players.some((p) => p.alias.toLocaleLowerCase() === input.alias.trim().toLocaleLowerCase())) return ack({ ok: false, error: "That alias is already in use." });
        player = { id: `p${room.nextPlayer++}`, alias: input.alias.trim(), consent: { ...input.consent }, secret: secret(), isBot: false, connected: true, socketId: socket.id };
        room.players.push(player);
      }
      room.lastActivity = this.now(); socket.data = { roomCode: room.code, playerId: player.id }; void socket.join(room.code);
      room.seq++;
      ack({ ok: true, you: player.id, secret: player.secret, state: this.view(room, player.id) });
      this.states(room); this.replay(room, socket, player); this.prepare(room);
    });
    socket.on("start", () => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (room.stage !== "lobby") return this.err(socket, "BAD_PHASE", "The game has already started.");
      if (!playerCountOk(room.players.length)) return this.err(socket, "PLAYER_COUNT", `Start requires ${MIN_PLAYERS}–${MAX_PLAYERS} players.`);
      this.prepare(room); this.enterHeat(room, "warmup");
    });
    socket.on("add_bot", () => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (room.stage !== "lobby") return this.err(socket, "BAD_PHASE", "Bots can only be added in the lobby.");
      if (room.players.length >= MAX_PLAYERS) return this.err(socket, "PLAYER_COUNT", "Room is full.");
      let n = 1; while (room.players.some((p) => p.alias.toLocaleLowerCase() === `🤖 Bot ${n}`.toLocaleLowerCase())) n++;
      room.players.push({ id: `p${room.nextPlayer++}`, alias: `🤖 Bot ${n}`, consent: { age: true, terms: true, revealOptIn: true }, secret: "", isBot: true, connected: true });
      this.changed(room); this.prepare(room);
    });
    socket.on("custom_prompts", (input) => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (room.stage !== "lobby") return this.err(socket, "BAD_PHASE", "Custom prompts are lobby-only.");
      if (!input || !Array.isArray(input.lines) || input.lines.length > 10 || input.lines.some((s) => typeof s !== "string" || s.length > 160 || !s.trim() || /[\r\n]/u.test(s))) return this.err(socket, "INVALID_PROMPTS", "Use at most 10 nonempty lines of up to 160 characters.");
      const custom: Prompt[] = [];
      for (const [index, line] of input.lines.entries()) {
        const prefix = line.match(/^\s*(warmup|spicy|deep|dare)\s*:\s*/i);
        const phase = (prefix?.[1]?.toLowerCase() ?? "warmup") as HeatPhase;
        const text = line.slice(prefix?.[0].length ?? 0).trim();
        // Every host prompt must actually extract data about the room, not random spectacle.
        if (!text || !validPlaceholders(text) || !/(\{P(?:[1-9]|1[01])\}|\b(?:here|someone|anyone|person|people|player|friend|pair|room|each other|two of you)\b)/iu.test(text)) return this.err(socket, "INVALID_PROMPTS", "Every prompt must refer to someone in the room or a pair.");
        // Apply the same provider safety rules as generated prompts, in addition
        // to the host-specific checks (which cover some additional phrases).
        if (checkBanned(text) || checkHardBlocked(text) || /\b(?:favou?rites?|zombies?|desert island|most likely to|underage|minors?|children|child|teens?|rape|molest|non.?consensual|without consent|oral sex|intercourse|blow.?job|hand.?job)\b/iu.test(text)) return this.err(socket, "INVALID_PROMPTS", "That prompt is not allowed in this game.");
        const kind: Prompt["kind"] = phase === "dare" ? (/\b(pair|two of you|each other)\b/i.test(text) ? "pair_dare" : "dare") : (/^\s*(who|which)\b/i.test(text) ? "pick" : "text");
        const coding: Prompt["coding"] = /\b(flirt|crush|romance|kiss)\b/i.test(text) ? "couple" : /\b(friend|appreciate)\b/i.test(text) ? "friendship" : /\b(trust|secret|honest)\b/i.test(text) ? "trust" : /\b(rival|argue|conflict)\b/i.test(text) ? "rivalry" : "neutral";
        custom.push({ id: `host-${phase}-${index + 1}`, source: "host", phase, kind, text, asksTarget: true, coding, measures: [kind === "dare" || kind === "pair_dare" ? "dareCompliance" : kind] });
      }
      room.custom = custom; this.changed(room);
    });
    socket.on("submit", (request, reply) => {
      const ack = typeof reply === "function" ? reply : () => {};
      const found = this.identify(socket); if (!found) return ack({ ok: false, error: "Join a room first." });
      ack(this.submit(found.room, found.player, request));
    });
    socket.on("dare_pass", (request) => {
      const found = this.identify(socket); if (!found) return;
      const result = this.submit(found.room, found.player, { roundId: request?.roundId, clientUuid: `pass:${request?.roundId}`, value: { kind: "dare", status: "passed", reason: request?.reason } });
      if (!result.ok) this.err(socket, "INVALID_PASS", result.error ?? "A reason is required.");
    });
    socket.on("skip_round", () => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (room.stage === "round") this.finishRound(room);
      else if (room.stage === "reveal") this.afterReveal(room);
      else if (room.stage === "interlude") this.afterInterlude(room);
      else this.err(socket, "BAD_PHASE", "No round to skip.");
    });
    socket.on("vote_heat_down", () => {
      const found = this.identify(socket); if (!found) return;
      const { room, player } = found;
      if (!room.currentHeat || !["round", "reveal"].includes(room.stage) || room.pendingHeatDown) return this.err(socket, "BAD_PHASE", "Heat cannot be lowered here.");
      const i = HEAT_ORDER.indexOf(room.currentHeat);
      if (i <= 0) return this.err(socket, "MIN_HEAT", "The room is already at the lowest heat.");
      room.votes.add(player.id);
      this.checkVotes(room);
    });
    socket.on("delete_room", () => {
      const found = this.identify(socket); if (!found) return;
      if (!this.deleteRoom(found.room)) this.err(socket, "DELETE_FAILED", "Could not remove room storage; try again.");
    });
    socket.on("disconnect", () => {
      const room = socket.data.roomCode ? this.rooms.get(socket.data.roomCode) : undefined;
      const player = room?.players.find((p) => p.id === socket.data.playerId && p.socketId === socket.id);
      if (!room || !player || room.stage === "deleted") return;
      player.connected = false; player.socketId = undefined; room.votes.delete(player.id); room.lastActivity = this.now();
      this.changed(room); this.checkVotes(room); this.maybeComplete(room);
    });
  }
  private prepare(room: Room): void {
    if (room.prepared || room.stage !== "lobby" || room.players.length < MIN_PLAYERS || !room.provider.prepare) return;
    room.prepared = true;
    try {
      void Promise.resolve(room.provider.prepare({ playerCount: room.players.length, usedIds: [...room.usedIds], digest: emptyDigest() })).catch(() => { /* Bank remains available. */ });
    } catch { /* Bank remains available. */ }
  }
  private checkVotes(room: Room): void {
    if (!room.currentHeat || room.pendingHeatDown || !["round", "reveal"].includes(room.stage)) return;
    const active = room.players.filter((p) => p.connected);
    const votes = active.filter((p) => room.votes.has(p.id)).length;
    const index = HEAT_ORDER.indexOf(room.currentHeat);
    if (index > 0 && votes > active.length / 2) {
      room.pendingHeatDown = HEAT_ORDER[index - 1]; room.votes.clear();
      if (room.stage === "round") this.finishRound(room); else this.afterReveal(room);
    }
  }
  private phasePrompts(room: Room, phase: HeatPhase): Definition[] {
    let provided: Prompt[] = [];
    try { const result = room.provider.forPhase(phase, 100, room.usedIds); if (Array.isArray(result)) provided = result; } catch { /* fallback */ }
    const fallback = new BankPromptProvider().forPhase(phase, 100, new Set());
    const pool = [...room.custom.filter((p) => p.phase === phase && !room.usedIds.has(p.id)), ...provided, ...fallback].filter((p) => asSafePrompt(p, phase));
    const desired: RoundKind[] = phase === "warmup" ? ["pick", "shout", "minigame"] : phase === "spicy" ? ["pick", "rating", "ios"] : phase === "deep" ? ["text", "rating", "pick"] : [...Array<RoundKind>(DARE_ROUNDS).fill("dare"), "pair_dare"];
    const slots = phase === "dare" ? desired : desired.slice(0, ROUNDS_PER_PHASE);
    const chosen = new Set<string>();
    const rounds = slots.map((kind) => {
      const permitted = (p: Prompt): boolean => phase === "dare" ? p.kind === kind : !["dare", "pair_dare", "debrief"].includes(p.kind);
      const candidates = pool.filter((p) => permitted(p) && !chosen.has(p.id));
      const prompt = candidates.find((p) => p.source === "host" && !room.usedIds.has(p.id)) ??
        candidates.find((p) => p.kind === kind && !room.usedIds.has(p.id)) ?? candidates.find((p) => !room.usedIds.has(p.id)) ??
        candidates.find((p) => p.kind === kind) ?? candidates[0] ?? fallback.find((p) => p.kind === kind)!;
      chosen.add(prompt.id);
      return { prompt, phase, kind: prompt.kind, text: prompt.text };
    });
    // LIVE MOMENTS (spec §3): ~1 spotlight per phase from warmup on, ~1 verdict
    // per phase from spicy on. Both close the phase: the room ends on a moment
    // (eyes on one person, then the room's own verdict) instead of a question.
    const spotlight = this.spotlightDefinition(room, phase);
    const verdict = this.verdictDefinition(room, phase);
    return [...rounds, ...(spotlight ? [spotlight] : []), ...(verdict ? [verdict] : [])];
  }
  /**
   * Pick tonight's subject and cover. Rotation is per night: every player is
   * spotlighted at most once and never twice in a row (the previous subject is
   * excluded even when seats changed).
   */
  private spotlightDefinition(room: Room, phase: HeatPhase): Definition | undefined {
    if (!liveKindInPhase("spotlight", phase)) return undefined;
    const candidates = room.players.filter((p) => !room.spotlighted.has(p.id) && p.id !== room.lastSubject);
    if (!candidates.length) return undefined;
    const seeds: LiveSeed[] = liveSeeds("spotlight", phase, { excludeIds: room.usedIds });
    if (!seeds.length) return undefined;
    const subject = candidates[Math.floor(room.rng() * candidates.length)]!;
    const seed = seeds[Math.floor(room.rng() * seeds.length)]!;
    // The cover is re-drawn every spotlight — a decoy question from the pool,
    // or an idle screen — so a repeat subject cannot pattern-match it.
    const idle = room.rng() < 0.25;
    const decoy = DECOYS[Math.floor(room.rng() * DECOYS.length)]!;
    return { prompt: livePrompt(seed), phase, kind: "spotlight", text: seed.text, subjectId: subject.id,
      ...(idle ? { idle: true } : { decoyText: decoy.text }), ...(seed.cluster ? { cluster: seed.cluster } : {}) };
  }
  private verdictDefinition(room: Room, phase: HeatPhase): Definition | undefined {
    if (!liveKindInPhase("verdict", phase)) return undefined;
    const seeds: LiveSeed[] = liveSeeds("verdict", phase, { excludeIds: room.usedIds });
    if (!seeds.length) return undefined;
    const seed = seeds[Math.floor(room.rng() * seeds.length)]!;
    return { prompt: livePrompt(seed), phase, kind: "verdict", text: seed.text, couple: seed.couple === true };
  }
  private enterHeat(room: Room, phase: HeatPhase): void {
    this.clearTimers(room); room.phase = phase; room.currentHeat = phase; room.votes.clear(); room.pendingHeatDown = undefined;
    room.queue = this.phasePrompts(room, phase); room.pair = undefined; room.interlude = undefined;
    this.nextRound(room);
  }
  private pair(room: Room): [string, string] {
    const connected = room.players.filter((p) => p.connected);
    const candidates = connected.length >= 2 ? connected : room.players;
    let minimum = Infinity; const best: [string, string][] = [];
    for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]!.id, b = candidates[j]!.id, count = room.interactions.get(PAIR_KEY(a, b)) ?? 0;
      if (count < minimum) { minimum = count; best.length = 0; }
      if (count === minimum) best.push([a, b]);
    }
    return best[Math.floor(room.rng() * best.length)]!;
  }
  private replacePlaceholders(room: Room, text: string, pair?: string[]): string {
    const rest = room.players.map((p) => p.id).filter((id) => !pair?.includes(id));
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(room.rng() * (i + 1)); [rest[i], rest[j]] = [rest[j]!, rest[i]!]; }
    const ids = [...(pair ?? []), ...rest];
    return text.replace(/\{P(1[01]|[1-9])\}/g, (_whole, n: string) => room.players.find((p) => p.id === ids[(Number(n) - 1) % ids.length])?.alias ?? "someone");
  }
  private nextRound(room: Room): void {
    if (room.stage === "deleted") return;
    const definition = room.queue.shift();
    if (!definition) {
      if (room.phase === "debrief") return this.beginInterlude(room, "finale");
      if (room.currentHeat === "dare") return room.pair ? this.beginInterlude(room, "debrief") : this.beginInterlude(room, "finale");
      const index = room.currentHeat ? HEAT_ORDER.indexOf(room.currentHeat) : -1;
      return this.beginInterlude(room, HEAT_ORDER[index + 1] ?? "finale");
    }
    this.clearTimers(room); room.reveal = undefined; room.interlude = undefined; room.stage = "round";
    if (definition.kind === "pair_dare") { room.pair = this.pair(room); definition.onlyPlayers = [...room.pair]; }
    // Mark the spotlight rotation only when the moment actually starts: a
    // heat-down or host skip that drops the queue must not burn a player's turn.
    if (definition.kind === "spotlight" && definition.subjectId) {
      room.spotlighted.add(definition.subjectId); room.lastSubject = definition.subjectId;
    }
    const startedAt = this.now();
    const lengthMs = this.options.roundTimers?.[definition.kind] ?? ROUND_TIMERS_MS[definition.kind];
    // `{S}` is the subject's alias — substituted for display only, exactly like `{P1}`.
    const text = definition.kind === "spotlight" && definition.subjectId
      ? definition.text.replace(/\{S\}/g, room.players.find((p) => p.id === definition.subjectId)?.alias ?? "someone")
      : this.replacePlaceholders(room, definition.text, definition.onlyPlayers);
    const round: LiveRound = { ...definition, text, id: `${room.id}-${++room.roundIndex}`, index: room.roundIndex, startedAt,
      closesAt: startedAt + lengthMs, responses: new Map(),
      ...(definition.kind === "verdict" ? { voteOpensAt: startedAt + Math.min(this.options.verdictDiscussMs ?? VERDICT_DISCUSS_MS, lengthMs) } : {}) };
    room.round = round; room.usedIds.add(definition.prompt.id); this.changed(room);
    this.eachSocket(room, (socket, player) => socket.emit("round", this.roundView(round, player.id)));
    this.schedule(room, round.closesAt - startedAt + (this.options.graceMs ?? GRACE_MS), () => this.finishRound(room));
    for (const player of room.players) if (player.isBot && (!round.onlyPlayers || round.onlyPlayers.includes(player.id))) this.scheduleBot(room, player, round);
    this.maybeComplete(room);
  }
  private scheduleBot(room: Room, player: Player, round: LiveRound, delayMs?: number): void {
    const [min, max] = this.options.botDelayMs ?? [600, 3500];
    const delay = delayMs ?? min + Math.floor(room.rng() * (max - min + 1));
    const timer = setTimeout(() => {
      room.botTimers.delete(timer);
      if (room.round?.id !== round.id || room.stage !== "round") return;
      // A verdict's pick window is closed during the debate: wait it out.
      if (round.kind === "verdict" && round.voteOpensAt !== undefined && this.now() < round.voteOpensAt) {
        this.scheduleBot(room, player, round, Math.max(0, round.voteOpensAt - this.now()) + 30 + Math.floor(room.rng() * 400));
        return;
      }
      const others = room.players.filter((p) => p.id !== player.id);
      const other = others[Math.floor(room.rng() * others.length)]!.id;
      const rand = (n: number): number => Math.floor(room.rng() * n);
      let value: ResponseValue;
      switch (round.kind) {
        case "pick": value = { kind: "pick", target: other }; break;
        case "text": case "debrief": value = { kind: "text", text: ["I appreciate the way someone here shows up for me.", "We talked about a time the group surprised us.", "Someone in this room always makes me laugh."][rand(3)]! }; break;
        case "shout": value = { kind: "shout", word: ["chaos", "vibes", "legend"][rand(3)]! }; break;
        case "rating": {
          const about = rand(2) ? "self" : other;
          value = { kind: "rating", trait: TRAITS[rand(TRAITS.length)]!, about, value: about === "self" ? 5 + rand(4) : 1 + rand(10) }; break;
        }
        case "ios": value = { kind: "ios", about: other, value: 1 + rand(7) }; break;
        case "minigame": value = { kind: "minigame", score: 10 + rand(51) }; break;
        case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
        // Live moments. A bot cannot know whether it is the spotlight subject
        // (the cover round looks identical), so it always sends a short text —
        // exactly what the server expects from both sides of the moment.
        case "spotlight": value = { kind: "text", text: ["Just vibing, honestly.", "Watching the room.", "Thinking about food.", "Nothing, I swear."][rand(4)]! }; break;
        case "verdict": value = { kind: "pick", target: other }; break;
      }
      this.submit(room, player, { roundId: round.id, clientUuid: `bot:${round.id}:${player.id}`, value });
    }, Math.max(0, delay));
    timer.unref(); room.botTimers.add(timer);
  }
  private submit(room: Room, player: Player, request: unknown): { ok: boolean; error?: string } {
    if (!request || typeof request !== "object") return { ok: false, error: "Invalid submission." };
    const r = request as { roundId?: unknown; clientUuid?: unknown; value?: unknown };
    if (typeof r.roundId !== "string" || typeof r.clientUuid !== "string" || !r.clientUuid.trim() || r.clientUuid.length > 128) return { ok: false, error: "Invalid submission id." };
    if (!validSubmit(r.value, player.id)) return { ok: false, error: "Invalid answer." };
    const value = canonicalValue(r.value as ResponseValue);
    const key = `${player.id}\u0000${r.clientUuid}`, fingerprint = JSON.stringify(value);
    const previous = room.seen.get(key);
    if (previous) return previous.roundId === r.roundId && previous.fingerprint === fingerprint ? { ok: true } : { ok: false, error: "Submission id was already used." };
    const round = room.round;
    if (room.stage !== "round" || !round || r.roundId !== round.id || this.now() > round.closesAt + (this.options.graceMs ?? GRACE_MS)) return { ok: false, error: "This round is closed." };
    if (!player.connected || (round.onlyPlayers && !round.onlyPlayers.includes(player.id))) return { ok: false, error: "You are spectating this round." };
    if (round.responses.has(player.id)) return { ok: false, error: "You already answered this round." };
    // Verdict: the phones stay face-down until the debate window closes.
    if (round.kind === "verdict" && round.voteOpensAt !== undefined && this.now() < round.voteOpensAt) {
      return { ok: false, error: "Phones down. Argue it out first." };
    }
    const expected = round.kind === "pair_dare" ? "dare"
      : round.kind === "debrief" || round.kind === "spotlight" ? "text"
      : round.kind === "verdict" ? "pick" : round.kind;
    if (value.kind !== expected) return { ok: false, error: "Answer does not match the round." };
    if (round.kind === "spotlight" && value.kind === "text" && value.text.length > SPOTLIGHT_ANSWER_MAX) {
      return { ok: false, error: `Keep it to ${SPOTLIGHT_ANSWER_MAX} characters.` };
    }
    if (value.kind === "shout" && /\s/u.test(value.word.trim())) return { ok: false, error: "Shout must be one word." };
    const target = value.kind === "pick" ? value.target : value.kind === "ios" ? value.about : value.kind === "rating" && value.about !== "self" ? value.about : undefined;
    if (target !== undefined && !room.players.some((p) => p.id === target)) return { ok: false, error: "Unknown target." };
    const at = this.now();
    // The spotlight subject's answer answers the COVER round, not the moment.
    // Flagging it here means no downstream consumer can score it by accident.
    const decoy = round.kind === "spotlight" && round.subjectId === player.id;
    const record: LogRecord = { roomId: room.id, roundId: round.id, playerId: player.id, roundKind: round.kind, promptId: round.prompt.id, coding: round.prompt.coding,
      value, at, latencyMs: Math.max(0, at - round.startedAt), ...(decoy ? { decoy: true } : {}) };
    try { appendFileSync(room.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }); }
    catch { return { ok: false, error: "Unable to save the answer." }; }
    room.log.push(record); room.seen.set(key, { roundId: r.roundId, fingerprint }); round.responses.set(player.id, value); room.lastActivity = at;
    this.options.audit?.persisted(room.code, room.file, { roundId: r.roundId, playerId: player.id, clientUuid: r.clientUuid });
    if (target) { const k = PAIR_KEY(player.id, target); room.interactions.set(k, (room.interactions.get(k) ?? 0) + 1); }
    this.changed(room);
    if (!player.isBot && player.socketId) this.io.sockets.sockets.get(player.socketId)?.emit("round", this.roundView(round, player.id));
    this.maybeComplete(room);
    return { ok: true };
  }
  private maybeComplete(room: Room): void {
    const round = room.round;
    if (room.stage !== "round" || !round) return;
    const required = room.players.filter((p) => p.connected && (!round.onlyPlayers || round.onlyPlayers.includes(p.id)));
    // Do not burn through the entire game when every phone disconnected.
    if (room.players.some((p) => p.connected) && required.every((p) => round.responses.has(p.id))) this.finishRound(room);
  }
  private finishRound(room: Room): void {
    const round = room.round; if (room.stage !== "round" || !round) return;
    this.clearTimers(room); room.round = null; room.stage = "reveal";
    const items: NonNullable<RevealView["items"]> = [];
    if (round.kind === "shout") {
      const counts = new Map<string, { word: string; count: number }>();
      for (const value of round.responses.values()) if (value.kind === "shout") { const k = value.word.trim().toLocaleLowerCase(); const entry = counts.get(k) ?? { word: value.word.trim(), count: 0 }; entry.count++; counts.set(k, entry); }
      const winner = [...counts.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))[0];
      if (winner) items.push({ alias: "The room", text: `${winner.word} (${winner.count})` });
    } else if (round.kind === "minigame") {
      const leaderboard = [...round.responses].flatMap(([id, v]) => v.kind === "minigame" ? [{ id, score: v.score }] : []).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      for (const entry of leaderboard) items.push({ alias: room.players.find((p) => p.id === entry.id)?.alias ?? "Player", text: `${entry.score} taps` });
    } else if (round.kind !== "debrief") {
      for (const [id, value] of round.responses) {
        if (value.kind === "text" && room.log.some((r) => r.decoy === true && r.roundId === round.id && r.playerId === id)) continue;
        const alias = room.players.find((p) => p.id === id)?.alias ?? "Player";
        if (value.kind === "text") items.push({ alias, text: value.text });
        if (value.kind === "dare") items.push({ alias, text: value.status === "done" ? "Done" : `Passed: ${value.reason}` });
        if (value.kind === "pick") items.push({ alias, text: `Chose ${room.players.find((p) => p.id === value.target)?.alias ?? "someone"}` });
      }
    }
    const alias = (id: string | undefined): string => room.players.find((p) => p.id === id)?.alias ?? "Player";
    if (round.kind === "spotlight") {
      // RAPID CAPTION WALL: the room's one-liners stack in submission order, and
      // the subject's own decoy answer lands LAST, biggest. Captions only — the
      // question never rides the reveal, so the subject cannot read it back.
      const subjectAlias = alias(round.subjectId);
      for (const [id, value] of round.responses) {
        if (id === round.subjectId) continue;
        if (value.kind === "text") items.push({ alias: alias(id), text: value.text });
      }
      const cover = round.subjectId ? round.responses.get(round.subjectId) : undefined;
      const punchline = cover?.kind === "text" ? cover.text : undefined;
      const holdMs = this.options.revealHoldMs ?? SPOTLIGHT_REVEAL_MS;
      const reveal: RevealView = { roundId: round.id, kind: "spotlight", summary: `Live on ${subjectAlias}`,
        ...(items.length ? { items } : {}), subject: subjectAlias, ...(punchline ? { punchline } : {}), holdMs };
      room.reveal = { value: reveal, endsAt: this.now() + holdMs }; this.changed(room);
      this.io.to(room.code).emit("reveal", reveal);
      this.schedule(room, holdMs, () => this.afterReveal(room));
      return;
    }
    if (round.kind === "verdict") {
      // Anonymous tallies only — never a voter's name (spec §7). The winner is
      // the room's answer: a Group Announcement mini-finale.
      const counts = new Map<string, number>();
      for (const value of round.responses.values()) if (value.kind === "pick") counts.set(value.target, (counts.get(value.target) ?? 0) + 1);
      const total = [...counts.values()].reduce((a, b) => a + b, 0);
      const ranked = [...counts].sort((a, b) => b[1] - a[1] || alias(a[0]).localeCompare(alias(b[0])));
      const winner = ranked[0];
      const slide: FinaleSlide | undefined = winner ? {
        beat: "land", flavor: "group", title: alias(winner[0]),
        body: `${winner[1]} of ${total} said it out loud.`, numbers: { votes: winner[1], of: total, share: winner[1] / total },
      } : undefined;
      const holdMs = this.options.revealHoldMs ?? VERDICT_REVEAL_MS;
      const reveal: RevealView = { roundId: round.id, kind: "verdict",
        summary: winner ? `The room decided: ${alias(winner[0])}` : "Nobody voted. The room argued for nothing.",
        ...(slide ? { slide } : {}), celebrate: round.couple ?? round.prompt.coding === "couple", holdMs };
      room.reveal = { value: reveal, endsAt: this.now() + holdMs }; this.changed(room);
      this.io.to(room.code).emit("reveal", reveal);
      this.schedule(room, holdMs, () => this.afterReveal(room));
      return;
    }
    const holdMs = this.options.revealHoldMs ?? REVEAL_HOLD_MS;
    const reveal: RevealView = { roundId: round.id, summary: round.kind === "debrief" ? "Their answers are private." : round.kind === "shout" ? "The room has spoken." : round.kind === "minigame" ? "Tap-war leaderboard" : "Round complete.", ...(items.length ? { items } : {}), holdMs };
    room.reveal = { value: reveal, endsAt: this.now() + holdMs }; this.changed(room);
    this.io.to(room.code).emit("reveal", reveal);
    this.schedule(room, holdMs, () => this.afterReveal(room));
  }
  private afterReveal(room: Room): void {
    if (room.stage !== "reveal") return;
    this.clearTimers(room); room.reveal = undefined;
    if (room.pendingHeatDown) { const next = room.pendingHeatDown; room.pendingHeatDown = undefined; room.queue = []; return this.beginInterlude(room, next, true); }
    this.nextRound(room);
  }
  private beginInterlude(room: Room, next: HeatPhase | "debrief" | "finale", cooled = false): void {
    this.clearTimers(room); room.stage = "interlude"; room.phase = "interlude"; room.round = null; room.reveal = undefined;
    let digest: NightDigest;
    try { digest = this.services.buildNightDigest(this.redactedLog(room).filter((r) => r.roundKind !== "debrief"), this.meta(room)); } catch { digest = emptyDigest(); }
    const teaser = digest.pickTeasers[0] ? displayText(digest.pickTeasers[0], room.players) : undefined;
    const holdMs = this.options.interludeHoldMs ?? INTERLUDE_HOLD_MS;
    const view: InterludeView = { headline: cooled ? "Cooling things down" : next === "finale" ? "The room has spoken" : `Next: ${next}`, sub: cooled ? "The room chose a gentler level." : "Take a breath before the next chapter.", ...(teaser ? { teaser } : {}), holdMs };
    room.interlude = { value: view, endsAt: this.now() + holdMs };
    // Store the transition independently of the label exposed to clients.
    this.transitions.set(room.id, next); this.changed(room); this.io.to(room.code).emit("interlude", view);
    this.schedule(room, holdMs, () => this.afterInterlude(room));
  }
  private readonly transitions = new Map<string, HeatPhase | "debrief" | "finale">();
  private afterInterlude(room: Room): void {
    if (room.stage !== "interlude") return;
    this.clearTimers(room); room.interlude = undefined;
    const next = this.transitions.get(room.id); this.transitions.delete(room.id);
    if (!next) return;
    if (next === "finale") { void this.finale(room); return; }
    if (next === "debrief") {
      if (!room.pair) { void this.finale(room); return; }
      room.phase = "debrief"; room.votes.clear();
      const base: Prompt = { id: `debrief-${room.roundIndex}`, source: "bank", phase: "dare", kind: "debrief", text: "", coding: "trust", measures: ["debrief"], asksTarget: true };
      room.queue = ["Privately describe the conversation you just shared.", "What stood out to you about the other person's perspective?"].map((text, index) => ({ phase: "debrief", kind: "debrief", prompt: { ...base, id: `${base.id}-${index + 1}`, text }, text, onlyPlayers: [...room.pair!] }));
      this.nextRound(room); return;
    }
    this.enterHeat(room, next);
  }
  private meta(room: Room): RoomMeta {
    return { roomId: room.id, players: room.players.map((p, i) => ({ id: p.id, alias: pseudonym(i) })), revealOptIn: room.players.filter((p) => p.consent.revealOptIn).map((p) => p.id) };
  }
  private redactedLog(room: Room): LogRecord[] { return room.log.map((r) => ({ ...r, value: redactValue(r.value, room.players) })); }
  private async finale(room: Room): Promise<void> {
    if (room.stage === "deleted" || room.stage === "finale" || room.stage === "finale-building") return;
    this.clearTimers(room); room.stage = "finale-building"; room.phase = "finale"; room.round = null; room.currentHeat = undefined; this.changed(room);
    const meta = this.meta(room), log = this.redactedLog(room);
    // Spotlight decoy answers answer nothing: they never reach signals, scores,
    // claims or secrets. (The engine also defends itself — see computeSignals.)
    const scoringLog = log.filter((r) => r.decoy !== true);
    let signals, results, digest: NightDigest, decks: Map<PlayerId, SecretCard[]>;
    try { signals = this.services.computeSignals(scoringLog, meta); } catch { signals = fallbackServices.computeSignals(scoringLog, meta); }
    try { results = this.services.computeResults(signals, scoringLog, meta); } catch { results = fallbackServices.computeResults(signals, scoringLog, meta); }
    // Debrief answers remain private even from the public digest and narrator.
    // Decoys DO ride the digest: pairing them with the captions is the joke.
    const publicLog = log.filter((r) => r.roundKind !== "debrief");
    try { digest = this.services.buildNightDigest(publicLog, meta); } catch { digest = fallbackServices.buildNightDigest(publicLog, meta); }
    try { decks = this.services.buildSecrets(results, digest, meta); if (!(decks instanceof Map)) throw new Error("Invalid decks"); }
    catch { decks = fallbackServices.buildSecrets(results, digest, meta); }
    // Store decks only on the room, so a deletion can synchronously purge them
    // even while the optional public narrator is still running.
    room.decks.clear();
    const order: SecretCard["kind"][] = ["spark", "onesided", "blindspot", "roomnote", "stat"];
    for (const player of room.players) {
      if (!player.consent.revealOptIn) continue;
      const sourceCards = decks.get(player.id);
      if (!Array.isArray(sourceCards)) continue;
      const cards: SecretCard[] = sourceCards.filter((c) => c && typeof c.id === "string" && order.includes(c.kind) && typeof c.title === "string" && Array.isArray(c.facts) && c.facts.every((f) => typeof f === "string"))
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, SECRET_DECK_MAX)
        .map((c) => ({ id: c.id, kind: c.kind, title: displayText(c.title, room.players), facts: c.facts.filter((f) => f.length > 0).slice(0, 4).map((f) => displayText(f.slice(0, 120), room.players)) }))
        .filter((c) => c.facts.length > 0);
      if (cards.length) room.decks.set(player.id, { cards });
    }
    this.options.audit?.decks(room.code, room.id, room.players.map((p) => p.id), room.decks, results);
    decks.clear();
    const privateDebriefs = log.flatMap((r) => r.roundKind === "debrief" && r.value.kind === "text" ? [r.value.text.toLocaleLowerCase()] : []);
    const safeClaims = results.claims.filter((c) => c.audience === "public" && c.type !== "spark" && c.type !== "onesided" && !(c.confidence === "low" && (c.type === "toxic" || c.type === "rival"))).map((c) => ({ ...c, evidence: c.evidence.filter((e) => !privateDebriefs.some((d) => d.length >= 10 && e.toLocaleLowerCase().includes(d))) }));
    // Copy only frozen contract fields. Unrecognized service fields must not
    // accidentally carry private data into a network-enabled narrator.
    const publicResults = {
      roomId: results.roomId, claims: safeClaims.map((c) => ({ id: c.id, type: c.type, subjects: [...c.subjects], audience: c.audience,
        confidence: c.confidence, evidence: [...c.evidence], ...(c.numbers ? { numbers: { ...c.numbers } } : {}) })),
      pairScores: [], ...(results.freeAgent ? { freeAgent: results.freeAgent } : {}), computedAt: results.computedAt,
    };
    const publicDigest: NightDigest = {
      quotes: digest.quotes.map((q) => ({ alias: q.alias, text: q.text, context: q.context })),
      stats: { ...(digest.stats.fastest ? { fastest: { alias: digest.stats.fastest.alias, ms: digest.stats.fastest.ms } } : {}),
        ...(digest.stats.slowest ? { slowest: { alias: digest.stats.slowest.alias, ms: digest.stats.slowest.ms } } : {}),
        ...(digest.stats.topDodger ? { topDodger: { alias: digest.stats.topDodger.alias, count: digest.stats.topDodger.count } } : {}),
        ...(digest.stats.tapWar ? { tapWar: { alias: digest.stats.tapWar.alias, score: digest.stats.tapWar.score } } : {}) },
      runningGags: digest.runningGags.map((g) => ({ word: g.word, count: g.count })),
      pickTeasers: [...digest.pickTeasers], dodges: digest.dodges.map((d) => ({ alias: d.alias, reason: d.reason })), selfVsRoom: [],
    };
    // Do not retain private scoring/debrief objects in this async continuation.
    // If the room is deleted while narration is pending, its deck and log can
    // therefore be purged immediately rather than waiting for the provider.
    privateDebriefs.length = 0; log.length = 0; signals = []; results = publicResults; digest = publicDigest;
    let skeleton: FinaleSlide[];
    try { skeleton = this.services.buildSkeleton(publicResults, publicDigest, meta); if (!Array.isArray(skeleton)) throw new Error("Invalid skeleton"); }
    catch { skeleton = fallbackServices.buildSkeleton(publicResults, publicDigest); }
    // A provider polishing public slides receives public material only. In particular,
    // the private map never leaves this process or becomes input to public copy.
    // Engine-written secret copy remains the safe, useful no-key fallback.
    let written: { slides: FinaleSlide[]; decks: Map<PlayerId, SecretCard[]> } | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), this.options.writerTimeoutMs ?? 10_000); timeout.unref(); });
      written = await Promise.race([Promise.resolve().then(() => this.services.writeFinale(structuredClone(skeleton), new Map(), structuredClone(publicResults), structuredClone(publicDigest), meta)), deadline]);
    } catch { /* deterministic template */ } finally { if (timeout) clearTimeout(timeout); }
    if (room.stage !== "finale-building" || this.rooms.get(room.code) !== room) return;
    const publicIds = new Set(safeClaims.map((c) => c.id));
    const source = written && Array.isArray(written.slides) && written.slides.length === skeleton.length ? written.slides : skeleton;
    const slides: FinaleSlide[] = [];
    for (let i = 0; i < skeleton.length; i++) {
      const base = skeleton[i]!;
      if (base.claimId && !publicIds.has(base.claimId)) continue;
      const draft = source[i];
      const safeText = (candidate: unknown, original: string | undefined, title: boolean): string | undefined => {
        if (typeof candidate !== "string" || !candidate.trim() || candidate.length > (title ? 80 : 140) || (title && candidate.trim().split(/\s+/u).length > 6)) return original;
        // Numbers and player references may only come from the deterministic source.
        const numbers = (s: string): string[] => s.match(/\d+(?:\.\d+)?/g) ?? [];
        const allowed = new Set(numbers(`${original ?? ""} ${JSON.stringify(base.numbers ?? {})}`));
        if (numbers(candidate).some((n) => !allowed.has(n))) return original;
        const playersInOriginal = new Set(original?.match(/\bPlayer (?:1[01]|[1-9])\b/g) ?? []);
        if ((candidate.match(/\bPlayer \d+\b/g) ?? []).some((name) => !playersInOriginal.has(name))) return original;
        if (/toxic person|red flag|soulmate|science says|love language|diagnos|narcissis|therapy/i.test(candidate)) return original;
        return candidate;
      };
      // Quotations and pass reasons must remain verbatim and attributed.
      const verbatim = base.flavor === "quote" || base.flavor === "dodge";
      const title = (verbatim ? base.title : safeText(draft?.title, base.title, true)) ?? base.title;
      const body = verbatim ? base.body : safeText(draft?.body, base.body, false);
      slides.push({ beat: base.beat, ...(base.flavor ? { flavor: base.flavor } : {}), ...(base.claimId ? { claimId: base.claimId } : {}), title: displayText(title, room.players),
        ...(body ? { body: displayText(body, room.players) } : {}), ...(base.numbers ? { numbers: { ...base.numbers } } : {}) });
    }
    const summary: FinaleView["summary"] = {};
    const summaryType = { ship: "ship", besties: "besties", toxic: "toxic", rival: "rivals" } as const;
    for (const c of safeClaims) if (c.type in summaryType) {
      const key = summaryType[c.type as keyof typeof summaryType];
      if (!summary[key]) summary[key] = c.subjects.map((id) => room.players.find((p) => p.id === id)?.alias).filter((v): v is string => !!v).join(" & ");
    }
    // ROUND 4 identity bookkeeping. A night counts once per room; carried-over
    // hypotheses are written to the account AFTER they are mapped to account
    // keys — nothing about a hypothesis is ever emitted to any socket.
    if (this.options.accounts) {
      for (const player of room.players) if (player.accountId && !player.isBot) this.options.accounts.recordNight(player.accountId, room.id);
    }
    room.finale = { slides, summary }; room.stage = "finale"; this.changed(room);
    this.io.to(room.code).emit("finale", room.finale); // public, identical on every socket
    this.eachSocket(room, (socket, player) => { const deck = room.decks.get(player.id); if (deck) socket.emit("secrets", deck); });
  }
  private deleteRoom(room: Room): boolean {
    try { unlinkSync(room.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    room.stage = "deleted"; room.phase = "closed"; this.transitions.delete(room.id); this.rooms.delete(room.code);
    this.io.to(room.code).emit("deleted");
    this.eachSocket(room, (socket) => { socket.data = {}; void socket.leave(room.code); });
    this.clearRoomMemory(room);
    return true;
  }
  /** Also reaps logs left after an unclean server shutdown. */
  purge(): void {
    const now = this.now();
    for (const room of this.rooms.values()) if (now - room.createdAt >= RETENTION_HOURS * HOUR || now - room.lastActivity >= IDLE_TTL_HOURS * HOUR) this.deleteRoom(room);
    const live = new Set([...this.rooms.values()].map((r) => r.file));
    try {
      for (const entry of readdirSync(this.options.dataDir, { withFileTypes: true })) {
        const match = entry.name.match(/^(\d{13})-[0-9a-f]{32}\.jsonl$/);
        if (!entry.isFile() || !match) continue;
        const file = join(this.options.dataDir, entry.name); if (live.has(file)) continue;
        try {
          const modified = statSync(file).mtimeMs;
          if (now - Number(match[1]) >= RETENTION_HOURS * HOUR || now - modified >= IDLE_TTL_HOURS * HOUR) unlinkSync(file);
        } catch { /* Retry next sweep; never delete unrelated files. */ }
      }
    } catch { /* Retry next sweep. */ }
  }
}
