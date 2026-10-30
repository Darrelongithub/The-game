import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, Socket } from "socket.io";
import {
  DARE_ROUNDS, GRACE_MS, HEAT_ORDER, IDLE_TTL_HOURS, INTERLUDE_HOLD_MS,
  MAX_PLAYERS, MIN_PLAYERS, RETENTION_HOURS, REVEAL_HOLD_MS, ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH, ROUNDS_PER_PHASE, ROUND_TIMERS_MS, SECRET_DECK_MAX, TRAITS, pseudonym,
  type ClientToServerEvents, type Consent, type FinaleSlide, type FinaleView, type InterludeView,
  type JoinReply, type LogRecord, type ProfileAnswers, type NightDigest, type Phase, type PlayerId, type Prompt,
  type ResponseValue, type RevealView, type RoomMeta, type RoomView, type RoundKind,
  type RoundView, type SecretCard, type SecretDeckView, type ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { isAlias, isRoomCode, playerCountOk, validSubmit } from "../../../packages/shared/src/validate.ts";
import { BankPromptProvider, fallbackServices, type GameServices, type HeatPhase, type PromptProvider } from "./services.ts";
import { checkBanned, checkHardBlocked } from "../../../packages/prompts/src/filter.ts";
import { pseudonymizeText as pseudonymizeAliasText, restoreAliases } from "./pseudonyms.ts";

type SocketData = { roomCode?: string; playerId?: string };
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type GameIO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Stage = "lobby" | "round" | "reveal" | "interlude" | "finale-building" | "finale" | "deleted";
interface Player { id: string; alias: string; consent: Consent; profile: ProfileAnswers; secret: string; isBot: boolean; connected: boolean; socketId?: string; }
interface Definition { prompt: Prompt; phase: Phase; kind: RoundKind; text: string; onlyPlayers?: string[]; performer?: string; }
interface LiveRound extends Definition { id: string; index: number; startedAt: number; closesAt: number; responses: Map<string, ResponseValue>; targets?: Map<string, string>; trait?: typeof TRAITS[number]; pairPassed?: boolean; }
interface SeenSubmit { roundId: string; fingerprint: string; }
interface TimedEvent<T> { value: T; endsAt: number; }
interface PersistedRoom { version: 1; id: string; code: string; createdAt: number; lastActivity: number; hostId: string; nextPlayer: number; players: Omit<Player, "connected" | "socketId">[]; }
interface Room {
  id: string; code: string; createdAt: number; lastActivity: number; file: string; hostId: string;
  players: Player[]; phase: Phase; stage: Stage; seq: number; nextPlayer: number; roundIndex: number; dareCount: number;
  provider: PromptProvider; prepared: boolean; usedIds: Set<string>; custom: Prompt[]; log: LogRecord[];
  currentHeat?: HeatPhase; queue: Definition[]; round: LiveRound | null; pair?: [string, string];
  interactions: Map<string, number>; seen: Map<string, SeenSubmit>; votes: Set<string>;
  pendingHeatDown?: HeatPhase; reveal?: TimedEvent<RevealView>; interlude?: TimedEvent<InterludeView>;
  finale?: FinaleView; decks: Map<string, SecretDeckView>; rng: () => number;
  timer?: ReturnType<typeof setTimeout>; botTimers: Set<ReturnType<typeof setTimeout>>;
}
export interface GameOptions {
  dataDir: string;
  services?: GameServices;
  now?: () => number;
  /** Testing seams, not environment overrides; production uses the frozen tunables. */
  roundTimers?: Partial<Record<RoundKind, number>>;
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
const metadataFile = (file: string): string => file.replace(/\.jsonl$/u, ".meta.json");
const PAIR_KEY = (a: string, b: string): string => [a, b].sort().join("\u0000");
const secret = (): string => randomBytes(32).toString("base64url");
const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const validProfile = (v: unknown): v is ProfileAnswers => {
  if (!v || typeof v !== "object") return false;
  const p = v as ProfileAnswers;
  return Number.isInteger(p.age) && p.age >= 18 && p.age <= 120 &&
    ["single", "dating", "committed", "married", "complicated"].includes(p.relationship) &&
    Number.isInteger(p.partnersToDate) && p.partnersToDate >= 0 && p.partnersToDate <= 200 &&
    Number.isInteger(p.longestMonths) && p.longestMonths >= 0 && p.longestMonths <= 1200 &&
    typeof p.crushingHere === "boolean" && ["chaos", "vibes", "feelings", "mission"].includes(p.tonight);
};
const validConsent = (v: unknown): v is Consent => !!v && typeof v === "object" &&
  (v as Consent).age === true && (v as Consent).terms === true && typeof (v as Consent).revealOptIn === "boolean";
const validAlias = (v: unknown): v is string => typeof v === "string" && isAlias(v) && !/[\u0000-\u001f\u007f]/u.test(v);
const privatePhraseLeak = (copy: string, privateFacts: readonly string[]): boolean => {
  const normalize = (value: string): string => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const text = ` ${normalize(copy)} `;
  return privateFacts.some((fact) => {
    const words = normalize(fact).split(/\s+/u).filter(Boolean);
    if (words.length < 4) return false;
    if (text.includes(` ${words.join(" ")} `)) return true;
    for (let i = 0; i + 6 <= words.length; i++) if (text.includes(` ${words.slice(i, i + 6).join(" ")} `)) return true;
    return false;
  });
};
const emptyDigest = (): NightDigest => ({ quotes: [], stats: {}, runningGags: [], pickTeasers: [], dodges: [], selfVsRoom: [] });
const seedRng = (id: string): (() => number) => {
  let seed = createHash("sha256").update(id).digest().readUInt32LE(0);
  return () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
};
/** Replace aliases in arbitrary free text before a service can see the data. */
function pseudonymizeText(text: string, players: Player[]): string {
  return pseudonymizeAliasText(text, players);
}
function displayText(text: string, players: Player[]): string {
  return restoreAliases(text, players);
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
    ["couple", "friendship", "trust", "friction", "tease", "rivalry", "status", "neutral"].includes(p.coding) && p.asksTarget === true;
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
    this.restore();
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
    room.currentHeat = undefined; room.pendingHeatDown = undefined; room.provider.dispose?.(); room.provider = new BankPromptProvider();
  }
  private persistRoom(room: Room): void {
    const file = metadataFile(room.file), temporary = `${file}.tmp`;
    const state: PersistedRoom = {
      version: 1, id: room.id, code: room.code, createdAt: room.createdAt, lastActivity: room.lastActivity,
      hostId: room.hostId, nextPlayer: room.nextPlayer,
      players: room.players.map(({ connected: _connected, socketId: _socketId, ...player }) => player),
    };
    try { writeFileSync(temporary, JSON.stringify(state), { encoding: "utf8", mode: 0o600 }); renameSync(temporary, file); }
    catch { try { unlinkSync(temporary); } catch { /* ignore */ } }
  }
  private restore(): void {
    let entries;
    try { entries = readdirSync(this.options.dataDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !/^\d{13}-[0-9a-f]{32}\.jsonl$/u.test(entry.name)) continue;
      const file = join(this.options.dataDir, entry.name), metaFile = metadataFile(file);
      try {
        const state = JSON.parse(readFileSync(metaFile, "utf8")) as PersistedRoom;
        if (state.version !== 1 || typeof state.id !== "string" || !isRoomCode(state.code) || !Array.isArray(state.players) || this.rooms.has(state.code)) continue;
        const players: Player[] = state.players.map((p) => ({ ...p, connected: false })).filter((p) => validAlias(p.alias) && validConsent(p.consent) && validProfile(p.profile) && typeof p.id === "string" && typeof p.secret === "string" && typeof p.isBot === "boolean");
        if (players.length !== state.players.length || players.length === 0 || !players.some(p => p.id === state.hostId)) continue;
        const records = readFileSync(file, "utf8").split(/\r?\n/u).filter(Boolean).flatMap((line) => {
          try {
            const value = JSON.parse(line) as LogRecord;
            return value && value.roomId === state.id && typeof value.roundId === "string" && players.some(p => p.id === value.playerId) && validSubmit(value.value, value.playerId) ? [value] : [];
          } catch { return []; }
        });
        const createdAt = Number.isFinite(state.createdAt) ? state.createdAt : Number(entry.name.slice(0, 13));
        const lastActivity = Math.max(Number.isFinite(state.lastActivity) ? state.lastActivity : createdAt, ...records.map(r => r.at));
        const provider = this.services.createPromptProvider(state.id);
        const room: Room = {
          id: state.id, code: state.code, createdAt, lastActivity, file, hostId: state.hostId, players,
          phase: "lobby", stage: "lobby", seq: records.length + 1, nextPlayer: Math.max(Number(state.nextPlayer) || 2, players.length + 1),
          roundIndex: records.reduce((max, r) => Math.max(max, Number(r.roundId.match(/-(\d+)$/u)?.[1] ?? 0)), 0),
          dareCount: records.filter(r => r.roundKind === "dare").length, provider, prepared: false, usedIds: new Set(records.map(r => r.promptId)), custom: [], log: records,
          queue: [], round: null, interactions: new Map(), seen: new Map(), votes: new Set(), decks: new Map(), rng: seedRng(state.id), botTimers: new Set(),
        };
        this.rooms.set(room.code, room);
        if (records.length > 0) void this.finale(room);
      } catch { /* Incomplete or corrupt metadata is ignored; never execute malformed replay data. */ }
    }
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
  private roundView(round: LiveRound, playerId: string): RoundView {
    return { roundId: round.id, index: round.index, phase: round.phase, kind: round.kind, promptText: round.text,
      closesAt: round.closesAt, youSubmitted: round.responses.has(playerId), ...(round.onlyPlayers ? { onlyPlayers: [...round.onlyPlayers] } : {}), ...(round.targets?.has(playerId) ? { about: round.targets.get(playerId) } : {}), ...(round.kind === "rating" && round.trait ? { trait: round.trait } : {}), ...(round.performer ? { performer: round.performer } : {}), submitted: [...round.responses.keys()] };
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
      if (!input || !validAlias(input.alias) || !validConsent(input.consent) || !validProfile(input.profile)) return ack({ ok: false, error: "Enter an alias, complete the adult profile, and accept consent." });
      const code = this.code(), now = this.now(), id = randomBytes(16).toString("hex");
      const file = join(this.options.dataDir, `${now}-${id}.jsonl`);
      try { writeFileSync(file, "", { flag: "wx", mode: 0o600 }); } catch { return ack({ ok: false, error: "Unable to create room storage." }); }
      const player: Player = { id: "p1", alias: input.alias.trim(), consent: { ...input.consent }, profile: { ...input.profile }, secret: secret(), isBot: false, connected: true, socketId: socket.id };
      let provider: PromptProvider;
      try { provider = this.services.createPromptProvider(id); } catch { provider = new BankPromptProvider(); }
      const room: Room = { id, code, createdAt: now, lastActivity: now, file, hostId: player.id, players: [player], phase: "lobby", stage: "lobby", seq: 1, nextPlayer: 2, roundIndex: 0, dareCount: 0,
        provider, prepared: false, usedIds: new Set(), custom: [], log: [], queue: [], round: null, interactions: new Map(), seen: new Map(), votes: new Set(), decks: new Map(), rng: seedRng(id), botTimers: new Set() };
      this.rooms.set(code, room); this.persistRoom(room); socket.data = { roomCode: code, playerId: player.id }; void socket.join(code);
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
        if (player.connected && player.socketId && player.socketId !== socket.id) return ack({ ok: false, error: "This player session is already connected." });
        player.connected = true; player.socketId = socket.id;
      } else {
        if (room.stage !== "lobby") {
          const reclaimed = room.players.find((p) => !p.isBot && !p.connected && p.alias.toLocaleLowerCase() === input.alias.trim().toLocaleLowerCase());
          if (!reclaimed) return ack({ ok: false, error: "The game has already started." });
          player = reclaimed; player.connected = true; player.socketId = socket.id;
        } else {
          if (!validProfile(input.profile)) return ack({ ok: false, error: "An adult profile is required before joining." });
          if (room.players.length >= MAX_PLAYERS) return ack({ ok: false, error: "Room is full." });
          if (room.players.some((p) => p.alias.toLocaleLowerCase() === input.alias.trim().toLocaleLowerCase())) return ack({ ok: false, error: "That alias is already in use." });
          player = { id: `p${room.nextPlayer++}`, alias: input.alias.trim(), consent: { ...input.consent }, profile: { ...input.profile }, secret: secret(), isBot: false, connected: true, socketId: socket.id };
          room.players.push(player);
        }
      }
      room.lastActivity = this.now(); this.persistRoom(room); socket.data = { roomCode: room.code, playerId: player.id }; void socket.join(room.code);
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
      room.players.push({ id: `p${room.nextPlayer++}`, alias: `🤖 Bot ${n}`, consent: { age: true, terms: true, revealOptIn: true }, profile: { age: 30, relationship: "single", partnersToDate: 0, longestMonths: 0, crushingHere: false, tonight: "vibes" }, secret: "", isBot: true, connected: true });
      this.persistRoom(room); this.changed(room); this.prepare(room);
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
    const desired: RoundKind[] = phase === "warmup" ? ["pick", "shout", "minigame", "pick"] : phase === "spicy" ? ["pick", "rating", "ios", "pick"] : phase === "deep" ? ["text", "rating", "pick", "pick"] : [...Array<RoundKind>(DARE_ROUNDS).fill("dare"), "pair_dare"];
    const slots = phase === "dare" ? desired : desired.slice(0, ROUNDS_PER_PHASE);
    const chosen = new Set<string>();
    return slots.map((kind) => {
      const permitted = (p: Prompt): boolean => phase === "dare" ? p.kind === kind : !["dare", "pair_dare", "debrief"].includes(p.kind);
      const candidates = pool.filter((p) => permitted(p) && !chosen.has(p.id));
      const prompt = candidates.find((p) => p.source === "host" && !room.usedIds.has(p.id)) ??
        candidates.find((p) => p.kind === kind && !room.usedIds.has(p.id)) ?? candidates.find((p) => !room.usedIds.has(p.id)) ??
        candidates.find((p) => p.kind === kind) ?? candidates[0] ?? fallback.find((p) => p.kind === kind)!;
      chosen.add(prompt.id);
      return { prompt, phase, kind: prompt.kind, text: prompt.text };
    });
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
    if (definition.kind === "dare") {
      const roster = room.players.map((p) => p.id);
      definition.performer = roster[room.dareCount % roster.length]!;
      room.dareCount++;
      definition.onlyPlayers = [definition.performer];
    }
    const startedAt = this.now();
    const displayPrompt = definition.kind === "pair_dare"
      ? `You two: ${this.replacePlaceholders(room, definition.text, definition.onlyPlayers)}`
      : this.replacePlaceholders(room, definition.text, definition.kind === "dare" && definition.performer ? [definition.performer] : definition.onlyPlayers);
    const round: LiveRound = { ...definition, text: displayPrompt, id: `${room.id}-${++room.roundIndex}`, index: room.roundIndex, startedAt,
      closesAt: startedAt + (this.options.roundTimers?.[definition.kind] ?? ROUND_TIMERS_MS[definition.kind]), responses: new Map() };
    if (round.kind === "rating" || round.kind === "ios") {
      const eligible = room.players.map((p) => p.id);
      round.targets = new Map(eligible.map((id) => {
        const others = eligible.filter((candidate) => candidate !== id);
        const offset = Math.max(0, room.roundIndex - 1) % others.length;
        return [id, others[offset]!];
      }));
      if (round.kind === "rating") round.trait = TRAITS[(room.roundIndex - 1) % TRAITS.length]!;
    }
    room.round = round; room.usedIds.add(definition.prompt.id); this.changed(room);
    this.eachSocket(room, (socket, player) => socket.emit("round", this.roundView(round, player.id)));
    this.schedule(room, round.closesAt - startedAt + (this.options.graceMs ?? GRACE_MS), () => this.finishRound(room));
    for (const player of room.players) if (player.isBot && (!round.onlyPlayers || round.onlyPlayers.includes(player.id))) this.scheduleBot(room, player, round);
    this.maybeComplete(room);
  }
  private scheduleBot(room: Room, player: Player, round: LiveRound): void {
    const [min, max] = this.options.botDelayMs ?? [600, 3500];
    const delay = min + Math.floor(room.rng() * (max - min + 1));
    const timer = setTimeout(() => {
      room.botTimers.delete(timer);
      if (room.round?.id !== round.id || room.stage !== "round") return;
      const others = room.players.filter((p) => p.id !== player.id);
      const other = others[Math.floor(room.rng() * others.length)]!.id;
      const rand = (n: number): number => Math.floor(room.rng() * n);
      let value: ResponseValue;
      switch (round.kind) {
        case "pick": value = { kind: "pick", target: other }; break;
        case "text": case "debrief": value = { kind: "text", text: ["I appreciate the way someone here shows up for me.", "We talked about a time the group surprised us.", "Someone in this room always makes me laugh."][rand(3)]! }; break;
        case "shout": value = { kind: "shout", word: ["chaos", "vibes", "legend"][rand(3)]! }; break;
        case "rating": {
          const about = round.targets?.get(player.id) ?? other;
          value = { kind: "rating", trait: round.trait ?? TRAITS[rand(TRAITS.length)]!, about, value: 1 + rand(10) }; break;
        }
        case "ios": value = { kind: "ios", about: round.targets?.get(player.id) ?? other, value: 1 + rand(7) }; break;
        case "minigame": value = { kind: "minigame", score: 10 + rand(51) }; break;
        case "dare": case "pair_dare": value = { kind: "dare", status: "done" }; break;
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
    const expected = round.kind === "pair_dare" ? "dare" : round.kind === "debrief" ? "text" : round.kind;
    if (value.kind !== expected) return { ok: false, error: "Answer does not match the round." };
    if (value.kind === "shout" && /\s/u.test(value.word.trim())) return { ok: false, error: "Shout must be one word." };
    const target = value.kind === "pick" ? value.target : value.kind === "ios" ? value.about : value.kind === "rating" && value.about !== "self" ? value.about : undefined;
    if (target !== undefined && !room.players.some((p) => p.id === target)) return { ok: false, error: "Unknown target." };
    if ((round.kind === "rating" || round.kind === "ios") && value.kind === round.kind) {
      if (value.about !== round.targets?.get(player.id)) return { ok: false, error: "Answer must use your assigned subject." };
      if (value.kind === "rating" && value.trait !== round.trait) return { ok: false, error: "Answer must use the assigned trait." };
    }
    const at = this.now();
    if (round.kind === "pair_dare" && round.pairPassed && value.kind === "dare" && value.status !== "passed") return { ok: false, error: "Your partner passed; submit your own reason to close the pair dare." };
    const record: LogRecord = { roomId: room.id, roundId: round.id, playerId: player.id, roundKind: round.kind, promptId: round.prompt.id, coding: round.prompt.coding,
      value, at, latencyMs: Math.max(0, at - round.startedAt), ...(round.kind === "dare" && round.performer ? { performerId: round.performer } : round.kind === "pair_dare" ? { performerId: player.id } : {}) };
    try { appendFileSync(room.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }); }
    catch { return { ok: false, error: "Unable to save the answer." }; }
    room.log.push(record); room.seen.set(key, { roundId: r.roundId, fingerprint }); round.responses.set(player.id, value); if (round.kind === "pair_dare" && value.kind === "dare" && value.status === "passed") round.pairPassed = true; room.lastActivity = at; this.persistRoom(room);
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
        const alias = room.players.find((p) => p.id === id)?.alias ?? "Player";
        if (value.kind === "text") items.push({ alias, text: value.text });
        if (value.kind === "dare") items.push({ alias, text: value.status === "done" ? "Done" : `Passed: ${value.reason}` });
      }
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
    return { roomId: room.id, players: room.players.map((p, i) => ({ id: p.id, alias: pseudonym(i) })), revealOptIn: room.players.filter((p) => p.consent.revealOptIn).map((p) => p.id), profiles: Object.fromEntries(room.players.map((p) => [p.id, p.profile])) };
  }
  private redactedLog(room: Room): LogRecord[] { return room.log.map((r) => ({ ...r, value: redactValue(r.value, room.players) })); }
  private async finale(room: Room): Promise<void> {
    if (room.stage === "deleted" || room.stage === "finale" || room.stage === "finale-building") return;
    this.clearTimers(room); room.stage = "finale-building"; room.phase = "finale"; room.round = null; room.currentHeat = undefined; this.changed(room);
    const meta = this.meta(room), log = this.redactedLog(room);
    let signals, results, digest: NightDigest, decks: Map<PlayerId, SecretCard[]>;
    try { signals = this.services.computeSignals(log, meta); } catch { signals = fallbackServices.computeSignals(log, meta); }
    try { results = this.services.computeResults(signals, log, meta); } catch { results = fallbackServices.computeResults(signals, log, meta); }
    // Debrief answers remain private even from the public digest and narrator.
    const publicLog = log.filter((r) => r.roundKind !== "debrief");
    try { digest = this.services.buildNightDigest(publicLog, meta); } catch { digest = fallbackServices.buildNightDigest(publicLog, meta); }
    try { decks = this.services.buildSecrets(results, digest, meta); if (!(decks instanceof Map)) throw new Error("Invalid decks"); }
    catch { decks = fallbackServices.buildSecrets(results, digest, meta); }
    // Store decks only on the room, so a deletion can synchronously purge them
    // even while the optional public narrator is still running.
    room.decks.clear();
    const order: SecretCard["kind"][] = ["spark", "onesided", "blindspot", "roomnote", "stat"];
    const narrationDecks = new Map<PlayerId, SecretCard[]>();
    for (const player of room.players) {
      if (!player.consent.revealOptIn) continue;
      const sourceCards = decks.get(player.id);
      if (!Array.isArray(sourceCards)) continue;
      const safeSource: SecretCard[] = sourceCards.filter((c) => c && typeof c.id === "string" && order.includes(c.kind) && typeof c.title === "string" && Array.isArray(c.facts) && c.facts.every((f) => typeof f === "string"))
        .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)).slice(0, SECRET_DECK_MAX)
        .map((c) => ({ id: c.id, kind: c.kind, title: c.title.slice(0, 80), facts: c.facts.filter((f) => f.length > 0).slice(0, 4).map((f) => f.slice(0, 120)) }))
        .filter((c) => c.facts.length > 0);
      if (safeSource.length) {
        narrationDecks.set(player.id, structuredClone(safeSource));
        room.decks.set(player.id, { cards: safeSource.map((c) => ({ ...c, title: displayText(c.title, room.players), facts: c.facts.map((f) => displayText(f, room.players)) })) });
      }
    }
    this.options.audit?.decks(room.code, room.id, room.players.map((p) => p.id), room.decks, results);
    const privateFacts = [...narrationDecks.values()].flatMap(cards => cards.flatMap(card => [card.title, ...card.facts]));
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
    // Grok receives public slide sources and private cards in a single guarded
    // reveal request. It returns separately indexed sections; narrator validators
    // reject unsupported copy and private-fact leakage into public slides. The
    // engine-authored public and private copy remains the deterministic fallback.
    let written: { slides: FinaleSlide[]; decks: Map<PlayerId, SecretCard[]> } | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), this.options.writerTimeoutMs ?? 10_000); timeout.unref(); });
      written = await Promise.race([Promise.resolve().then(() => this.services.writeFinale(structuredClone(skeleton), structuredClone(narrationDecks), structuredClone(publicResults), structuredClone(publicDigest), meta)), deadline]);
    } catch { /* deterministic template */ } finally { if (timeout) clearTimeout(timeout); narrationDecks.clear(); }
    if (room.stage !== "finale-building" || this.rooms.get(room.code) !== room) { privateFacts.length = 0; return; }
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
        if (privatePhraseLeak(candidate, privateFacts)) return original;
        return candidate;
      };
      // Quotations and pass reasons must remain verbatim and attributed.
      const verbatim = base.flavor === "quote" || base.flavor === "dodge";
      const title = (verbatim ? base.title : safeText(draft?.title, base.title, true)) ?? base.title;
      const body = verbatim ? base.body : safeText(draft?.body, base.body, false);
      slides.push({ beat: base.beat, ...(base.flavor ? { flavor: base.flavor } : {}), ...(base.claimId ? { claimId: base.claimId } : {}), title: displayText(title, room.players),
        ...(body ? { body: displayText(body, room.players) } : {}), ...(base.numbers ? { numbers: { ...base.numbers } } : {}) });
    }
    if (written?.decks instanceof Map) {
      const allowedKinds: SecretCard["kind"][] = ["spark", "onesided", "blindspot", "roomnote", "stat"];
      for (const [playerId, cards] of written.decks) {
        if (!room.decks.has(playerId) || !Array.isArray(cards)) continue;
        const safeCards = cards.filter(c => c && allowedKinds.includes(c.kind) && typeof c.id === "string" && typeof c.title === "string" && Array.isArray(c.facts))
          .sort((a, b) => allowedKinds.indexOf(a.kind) - allowedKinds.indexOf(b.kind)).slice(0, SECRET_DECK_MAX)
          .map(c => ({ id: c.id, kind: c.kind, title: displayText(c.title.slice(0, 80), room.players), facts: c.facts.filter((f): f is string => typeof f === "string" && f.trim().length > 0).slice(0, 4).map(f => displayText(f.slice(0, 120), room.players)) }))
          .filter(c => c.facts.length > 0);
        if (safeCards.length) room.decks.set(playerId, { cards: safeCards });
      }
    }
    const summary: FinaleView["summary"] = {};
    const summaryType = { ship: "ship", besties: "besties", toxic: "toxic", rival: "rivals" } as const;
    for (const c of safeClaims) if (c.type in summaryType) {
      const key = summaryType[c.type as keyof typeof summaryType];
      if (!summary[key]) summary[key] = c.subjects.map((id) => room.players.find((p) => p.id === id)?.alias).filter((v): v is string => !!v).join(" & ");
    }
    privateFacts.length = 0;
    room.finale = { slides, summary }; room.stage = "finale"; this.changed(room);
    this.io.to(room.code).emit("finale", room.finale); // public, identical on every socket
    this.eachSocket(room, (socket, player) => { const deck = room.decks.get(player.id); if (deck) socket.emit("secrets", deck); });
  }
  private deleteRoom(room: Room): boolean {
    try { unlinkSync(room.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    try { unlinkSync(metadataFile(room.file)); } catch { /* legacy room without metadata */ }
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
          if (now - Number(match[1]) >= RETENTION_HOURS * HOUR || now - modified >= IDLE_TTL_HOURS * HOUR) { unlinkSync(file); try { unlinkSync(metadataFile(file)); } catch { /* absent sidecar */ } }
        } catch { /* Retry next sweep; never delete unrelated files. */ }
      }
    } catch { /* Retry next sweep. */ }
  }
}
