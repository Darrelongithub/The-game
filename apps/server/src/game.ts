import { randomBytes, randomInt, timingSafeEqual, createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Server, Socket } from "socket.io";
import {
  GRACE_MS, HEAT_ORDER, IDLE_TTL_HOURS, INTERLUDE_HOLD_MS,
  MAX_PLAYERS, MIN_PLAYERS, RETENTION_HOURS, REVEAL_HOLD_MS, REVEAL_READY_GRACE_MS, ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH, ROUND_TIMERS_MS, SECRET_DECK_MAX, SPOTLIGHT_ANSWER_MAX,
  SPOTLIGHT_REVEAL_MS, TRAITS, VERDICT_DISCUSS_MS, VERDICT_REVEAL_MS, pseudonym,
  type ClientToServerEvents, type Consent, type FinaleSlide, type FinaleView, type InterludeView,
  type Claim, type Hypothesis, type JoinReply, type LogRecord, type NightDigest, type Phase, type PlayerId, type Prompt, type PromptCoding, type ProfileAnswers,
  type ResponseValue, type RevealView, type RoomMeta, type RoomView, type RoundKind,
  type RoundView, type SecretCard, type SecretDeckView, type ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { isAlias, isRoomCode, playerCountOk, validSubmit } from "../../../packages/shared/src/validate.ts";
import { phaseSlots } from "./schedule.ts";
import { safeCallbackQuotes } from "./safe-callback.ts";
import { BankPromptProvider, fallbackServices, type GameServices, type HeatPhase, type PromptProvider } from "./services.ts";
import { integratedServices } from "./integratedServices.ts";
import { DECOYS, SPOTLIGHT_IDLE_LINE, liveKindInPhase, livePrompt, liveSeeds, type LiveSeed } from "../../../packages/prompts/src/bank/live/index.ts";
import { checkBanned, checkHardBlocked } from "../../../packages/prompts/src/filter.ts";
import { bankForPhase, maxPlaceholderIndex } from "../../../packages/prompts/src/bank/index.ts";
import { pseudonymizeText as pseudonymizeAliasText, restoreAliases } from "./pseudonyms.ts";
import { accountSubjectKey, type AccountStore, type StoredHypothesis } from "./accounts.ts";
import {
  assertNoHypothesisLeak, carryOver, emptyDirectorState, planRound, recordSelection, updateHypotheses,
  type DirectorState,
} from "../../../packages/engine/src/director.ts";

type SocketData = { roomCode?: string; playerId?: string; display?: boolean };
const displayChannel = (code: string): string => `display:${code}`;
type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type GameIO = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>;
type Stage = "lobby" | "round" | "ready" | "reveal" | "interlude" | "finale-building" | "finale" | "deleted";
interface Player {
  id: string; alias: string; consent: Consent; profile: ProfileAnswers; secret: string; isBot: boolean; connected: boolean; socketId?: string;
  /** A pending versioned resume is bound to a client-generated secret nonce. */
  resumeRetry?: { secret: string; socketId: string; nonce?: string };
  /** ROUND 4: bound account (never emitted). */
  accountId?: string;
  /** Demo seat controlled by the host. */
  puppet?: { mode: "auto" | "manual" };
}
interface Definition {
  prompt: Prompt; phase: Phase; kind: RoundKind; text: string; onlyPlayers?: string[]; performer?: string;
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
  /**
   * ROUND 4: the subjects this round was DIRECTOR-chosen to probe, bound into
   * the first `{P1}`/`{P2}` slots so the prompt is about those people. The
   * round view still shows ordinary text — nothing points at a suspicion.
   */
  subjects?: string[];
}
/** Heat-phase dealing state: round slots first, then the live moments. */
interface PhasePlan { phase: HeatPhase; slots: RoundKind[]; live: RoundKind[] }
interface LiveRound extends Definition {
  id: string; index: number; startedAt: number; closesAt: number; responses: Map<string, ResponseValue>;
  targets?: Map<string, string>; trait?: typeof TRAITS[number]; pairPassed?: boolean;
  /** verdict: the secret simultaneous pick opens here (discussion before it). */
  voteOpensAt?: number;
}
interface SeenSubmit { roundId: string; fingerprint: string; }
interface TimedEvent<T> { value: T; endsAt: number; }
interface PersistedRoom { version: 1; id: string; code: string; createdAt: number; lastActivity: number; hostId: string; nextPlayer: number; players: Omit<Player, "connected" | "socketId" | "resumeRetry">[]; }
const metadataFile = (file: string): string => file.replace(/\.jsonl$/u, ".meta.json");
interface Room {
  id: string; code: string; createdAt: number; lastActivity: number; file: string; hostId: string;
  players: Player[]; phase: Phase; stage: Stage; seq: number; nextPlayer: number; roundIndex: number; dareCount: number;
  provider: PromptProvider; prepared: boolean; usedIds: Set<string>; custom: Prompt[]; log: LogRecord[];
  currentHeat?: HeatPhase; queue: Definition[]; round: LiveRound | null; pair?: [string, string];
  interactions: Map<string, number>; seen: Map<string, SeenSubmit>; votes: Set<string>;
  callbackPhases: Set<HeatPhase>; callbackQuotes: Set<string>;
  /** spotlight rotation: each player at most once a night, never back-to-back. */
  spotlighted: Set<string>; lastSubject?: string;
  pendingHeatDown?: HeatPhase; reveal?: TimedEvent<RevealView>; interlude?: TimedEvent<InterludeView>;
  finale?: FinaleView; decks: Map<string, SecretDeckView>; rng: () => number;
  /**
   * ROUND 4 — THE DIRECTOR'S MEMORY. INTERNAL: hypotheses, priors, the
   * coverage matrix and graduated claims live here and NOWHERE else. They are
   * never emitted, never written to the room log, never in a RoomView, and
   * never recapped at the finale. Players see only the rounds they caused.
   */
  hypotheses: Hypothesis[]; priors: Hypothesis[]; director: DirectorState;
  /** the phase being dealt, one round at a time (so every round re-plans) */
  plan?: PhasePlan;
  /** hypothesis the round in flight was built to test (cleared each round) */
  testedHypothesisId?: string;
  /**
   * ROUND 4 — THE READY GATE. A closed round's reveal is PENDING here until
   * every connected player has pressed ready (or the grace expires), so a
   * phone in a pocket never costs anyone the moment. `ready` only ever
   * contains player ids — nothing private.
   */
  pendingReveal?: RevealView; ready: Set<string>; readyClosesAt?: number;
  /** ROUND 4 demo room: the host plays every seat from one laptop. */
  demo: boolean; demoSpeed: number;
  timer?: ReturnType<typeof setTimeout>; botTimers: Set<ReturnType<typeof setTimeout>>;
}
export interface GameOptions {
  dataDir: string;
  services?: GameServices;
  /** In-process legacy test seam; production always uses finale-only anonymity. */
  revealMode?: "round" | "finale";
  /** ROUND 4 identity store. Absent = guest-only night, identical gameplay. */
  accounts?: AccountStore;
  now?: () => number;
  /** Testing seams, not environment overrides; production uses the frozen tunables. */
  roundTimers?: Partial<Record<RoundKind, number>>;
  /** Testing seam for the verdict debate window (production: VERDICT_DISCUSS_MS). */
  verdictDiscussMs?: number;
  graceMs?: number;
  revealHoldMs?: number;
  /** Testing seam for the ready gate (production: REVEAL_READY_GRACE_MS). */
  readyGraceMs?: number;
  interludeHoldMs?: number;
  botDelayMs?: [number, number];
  writerTimeoutMs?: number;
  /** Test seam: turn the hypothesis-leak guard off (never in production). */
  assertInvisible?: boolean;
  /** In-process test observer only; never configured by the production entry point. */
  audit?: {
    persisted(roomCode: string, file: string, request: { roundId: string; playerId: string; clientUuid: string }): void;
    /**
     * INTERNAL test observer: what the director CHOSE (never what a player
     * sees). Used to assert the anti-telegraph cap and cross-night probing
     * without exposing any of it on the wire.
     */
    directed?(roomCode: string, round: { mode: string; dimension: string; subjects: string[]; promptId: string; hypothesisId?: string }): void;
    decks(roomCode: string, roomId: string, players: string[], decks: ReadonlyMap<string, SecretDeckView>, results: import("../../../packages/shared/src/contracts.ts").Results): void;
  };
}
export function choosePhaseCandidate(candidates: readonly Prompt[], desiredKind: RoundKind, preferGenerated = false): Prompt | undefined {
  return candidates.find(p => p.source === "host") ??
    (preferGenerated ? candidates.find(p => p.source === "grok") : undefined) ??
    candidates.find(p => p.kind === desiredKind) ?? candidates[0];
}
const HOUR = 60 * 60 * 1000;
const PAIR_KEY = (a: string, b: string): string => [a, b].sort().join("\u0000");
const secret = (): string => randomBytes(32).toString("base64url");
const safeEqual = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/** A versioned value is still an opaque JoinRequest.resume.secret string.
 * Legacy bare tokens remain supported. The random nonce binds one pending
 * rotation to its original client without making an old bearer token reusable. */
function resumeProof(value: string): { token: string; nonce?: string } | null {
  if (!value.startsWith("rr1.")) return { token: value };
  const match = /^rr1\.([A-Za-z0-9_-]{43})\.([a-f0-9]{32})$/.exec(value);
  return match ? { token: match[1]!, nonce: match[2]! } : null;
}
const validConsent = (v: unknown): v is Consent => !!v && typeof v === "object" &&
  (v as Consent).age === true && (v as Consent).terms === true && typeof (v as Consent).revealOptIn === "boolean";
const validProfile = (v: unknown): v is ProfileAnswers => {
  if (!v || typeof v !== "object") return false;
  const p = v as ProfileAnswers;
  return Number.isInteger(p.age) && p.age >= 18 && p.age <= 120 && ["single", "dating", "committed", "married", "complicated"].includes(p.relationship) && Number.isInteger(p.partnersToDate) && p.partnersToDate >= 0 && p.partnersToDate <= 200 && Number.isInteger(p.longestMonths) && p.longestMonths >= 0 && p.longestMonths <= 1200 && typeof p.crushingHere === "boolean" && ["chaos", "vibes", "feelings", "mission"].includes(p.tonight);
};
const neutralProfile: ProfileAnswers = { age: 28, relationship: "single", partnersToDate: 2, longestMonths: 8, crushingHere: false, tonight: "vibes" };
const validAlias = (v: unknown): v is string => typeof v === "string" && isAlias(v) && !/[\u0000-\u001f\u007f]/u.test(v);
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
    ["couple", "friendship", "trust", "friction", "tease", "rivalry", "status", "neutral"].includes(p.coding) && typeof p.asksTarget === "boolean";
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly services: GameServices;
  private get finaleOnly(): boolean { return this.options.revealMode !== "round"; }
  private readonly now: () => number;
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  constructor(private readonly io: GameIO, private readonly options: GameOptions) {
    this.services = options.services ?? integratedServices;
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
    room.provider.dispose?.();
    room.log.length = 0; room.decks.clear(); room.seen.clear(); room.interactions.clear(); room.votes.clear(); room.usedIds.clear();
    room.callbackPhases.clear(); room.callbackQuotes.clear();
    room.players.forEach((p) => { p.secret = ""; p.alias = ""; p.resumeRetry = undefined; }); room.players.length = 0;
    room.round = null; room.queue = []; room.custom = []; room.pair = undefined; room.reveal = undefined; room.interlude = undefined; room.finale = undefined;
    room.currentHeat = undefined; room.pendingHeatDown = undefined; room.spotlighted.clear(); room.lastSubject = undefined;
    room.ready.clear(); room.pendingReveal = undefined; room.readyClosesAt = undefined;
    room.hypotheses.length = 0; room.priors.length = 0; room.director = emptyDirectorState(); room.plan = undefined; room.testedHypothesisId = undefined;
    room.provider = new BankPromptProvider();
  }
  private persistRoom(room: Room): void {
    const file = metadataFile(room.file), temporary = `${file}.tmp`;
    const state: PersistedRoom = { version: 1, id: room.id, code: room.code, createdAt: room.createdAt, lastActivity: room.lastActivity,
      hostId: room.hostId, nextPlayer: room.nextPlayer,
      players: room.players.map(({ connected: _connected, socketId: _socketId, resumeRetry: _retry, ...player }) => player) };
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
          try { const value = JSON.parse(line) as LogRecord; return value && value.roomId === state.id && typeof value.roundId === "string" && players.some(p => p.id === value.playerId) && validSubmit(value.value, value.playerId) ? [value] : []; }
          catch { return []; }
        });
        const createdAt = Number.isFinite(state.createdAt) ? state.createdAt : Number(entry.name.slice(0, 13));
        const lastActivity = Math.max(Number.isFinite(state.lastActivity) ? state.lastActivity : createdAt, ...records.map(r => r.at));
        const provider = this.services.createPromptProvider({ roomId: state.id });
        const room: Room = { id: state.id, code: state.code, createdAt, lastActivity, file, hostId: state.hostId, players,
          phase: "lobby", stage: "lobby", seq: records.length + 1, nextPlayer: Math.max(Number(state.nextPlayer) || 2, players.length + 1), roundIndex: records.reduce((max, r) => Math.max(max, Number(r.roundId.match(/(\d+)$/u)?.[1] ?? 0)), 0), dareCount: records.filter(r => r.roundKind === "dare").length,
          provider, prepared: false, usedIds: new Set(records.map(r => r.promptId)), custom: [], log: records, queue: [], round: null, interactions: new Map(), seen: new Map(), votes: new Set(), callbackPhases: new Set(), callbackQuotes: new Set(), spotlighted: new Set(), decks: new Map(), rng: seedRng(state.id), botTimers: new Set(), hypotheses: [], priors: [], director: emptyDirectorState(), ready: new Set(), demo: false, demoSpeed: 1 };
        this.rooms.set(room.code, room);
        if (records.length > 0) void this.finale(room);
      } catch { /* Invalid metadata or partial logs are ignored. */ }
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
    room.timer = setTimeout(() => {
      room.timer = undefined;
      if (room.stage === "deleted" || this.liveRoom(room.code) !== room) return;
      fn();
    }, Math.max(0, ms));
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
  private expired(room: Room): boolean {
    const now = this.now();
    return now - room.createdAt >= RETENTION_HOURS * HOUR || now - room.lastActivity >= IDLE_TTL_HOURS * HOUR;
  }
  private liveRoom(code: string): Room | undefined {
    const room = this.rooms.get(code);
    if (room && this.expired(room)) {
      // If disk deletion fails, deny access and let a later sweep retry it.
      this.deleteRoom(room);
      return undefined;
    }
    return room;
  }
  private identify(socket: GameSocket): { room: Room; player: Player } | undefined {
    const room = socket.data.roomCode ? this.liveRoom(socket.data.roomCode) : undefined;
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
  /** Demo events are accepted in demo rooms only (and say so when they are not). */
  private demoOnly(socket: GameSocket, room: Room): boolean {
    if (room.demo) return true;
    this.err(socket, "DEMO_ONLY", "That control only exists in a demo room.");
    return false;
  }
  private view(room: Room, playerId: string): RoomView {
    return { code: room.code, phase: room.phase, hostId: room.hostId,
      players: room.players.map(({ id, alias, connected, isBot }) => ({ id, alias, connected, isBot })),
      round: room.round ? this.roundView(room.round, playerId) : null, seq: room.seq,
      // Demo rooms say so (the host's puppet controls are gated on it); a real
      // room's snapshot stays byte-identical to before.
      ...(room.demo ? { demo: true } : {}),
      // Present ONLY while a reveal is pending — who has pressed ready for it.
      ...(room.stage === "ready" ? { ready: room.players.filter((p) => room.ready.has(p.id)).map((p) => p.id) } : {}) };
  }
  private displayView(room: Room): RoomView {
    const view = this.view(room, "");
    if (view.round) {
      const { about: _about, trait: _trait, performer: _performer, submitted: _submitted, onlyPlayers: _onlyPlayers, ...publicRound } = view.round;
      view.round = publicRound;
    }
    return view;
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
      ...(round.targets?.has(playerId) ? { about: round.targets.get(playerId) } : {}),
      ...(round.kind === "rating" && round.trait ? { trait: round.trait } : {}),
      ...(round.performer ? { performer: round.performer } : {}), ...(this.finaleOnly ? {} : { submitted: [...round.responses.keys()] }),
      ...(round.voteOpensAt !== undefined ? { voteOpensAt: round.voteOpensAt } : {}),
      ...(cover && round.idle ? { expectsAnswer: false } : {}) };
  }
  /**
   * INVISIBILITY GUARD. Every client-facing payload passes through here, so a
   * future edit that starts shipping a hypothesis fails loudly instead of
   * quietly showing players the game's private suspicions.
   */
  private guard<T>(payload: T): T {
    if (this.options.assertInvisible !== false) assertNoHypothesisLeak(payload);
    return payload;
  }
  private eachSocket(room: Room, fn: (socket: GameSocket, player: Player) => void): void {
    for (const p of room.players) if (!p.isBot && p.connected && p.socketId) {
      const socket = this.io.sockets.sockets.get(p.socketId);
      if (socket) fn(socket, p);
    }
  }
  private states(room: Room): void {
    this.eachSocket(room, (s, p) => s.emit("state", this.guard(this.view(room, p.id))));
    this.io.to(displayChannel(room.code)).emit("state", this.guard(this.displayView(room)));
  }
  private changed(room: Room): void { room.seq++; this.states(room); }
  private replay(room: Room, socket: GameSocket, player: Player): void {
    if (room.round) socket.emit("round", this.guard(this.roundView(room.round, player.id)));
    if (room.reveal) socket.emit("reveal", this.guard({ ...room.reveal.value, holdMs: Math.max(0, room.reveal.endsAt - this.now()) }));
    if (room.interlude) socket.emit("interlude", this.guard({ ...room.interlude.value, holdMs: Math.max(0, room.interlude.endsAt - this.now()) }));
    if (room.finale) {
      socket.emit("finale", this.guard(room.finale));
      const deck = room.decks.get(player.id);
      if (deck) socket.emit("secrets", this.guard(deck)); // exactly this authenticated socket
    }
  }
  private bind(socket: GameSocket): void {
    socket.on("display_join", (input, reply) => {
      const ack = typeof reply === "function" ? reply : () => {};
      if (!input || !isRoomCode(input.roomCode)) return ack({ ok: false, error: "Invalid room code." });
      const room = this.liveRoom(input.roomCode);
      if (!room || room.stage === "deleted") return ack({ ok: false, error: "Room not found." });
      socket.data = { roomCode: room.code, display: true };
      void socket.join(displayChannel(room.code));
      const state = this.guard(this.displayView(room));
      ack({ ok: true, state });
      socket.emit("state", state);
      if (room.round) socket.emit("round", this.guard(this.displayView(room).round!));
      if (room.reveal) socket.emit("reveal", this.guard({ ...room.reveal.value, holdMs: Math.max(0, room.reveal.endsAt - this.now()) }));
      if (room.interlude) socket.emit("interlude", this.guard({ ...room.interlude.value, holdMs: Math.max(0, room.interlude.endsAt - this.now()) }));
      if (room.finale) socket.emit("finale", this.guard(room.finale));
    });
    socket.on("create", (input, reply) => {
      const ack = typeof reply === "function" ? reply : () => {};
      if (socket.data.playerId) return ack({ ok: false, error: "Already joined a room." });
      if (!input || !validAlias(input.alias) || !validConsent(input.consent) || (!validProfile(input.profile) && input.demo !== true)) return ack({ ok: false, error: "Enter a valid alias, complete the 18+ profile, and accept the required consent." });
      const code = this.code(), now = this.now(), id = randomBytes(16).toString("hex");
      const file = join(this.options.dataDir, `${now}-${id}.jsonl`);
      try { writeFileSync(file, "", { flag: "wx", mode: 0o600 }); } catch { return ack({ ok: false, error: "Unable to create room storage." }); }
      const player: Player = { id: "p1", alias: input.alias.trim(), consent: { ...input.consent }, profile: validProfile(input.profile) ? input.profile : neutralProfile, secret: secret(), isBot: false, connected: true, socketId: socket.id };
      let provider: PromptProvider;
      try { provider = this.services.createPromptProvider({ roomId: id }); } catch { provider = new BankPromptProvider(); }
      const demo = (input as { demo?: unknown }).demo === true;
      const room: Room = { id, code, createdAt: now, lastActivity: now, file, hostId: player.id, players: [player], phase: "lobby", stage: "lobby", seq: 1, nextPlayer: 2, roundIndex: 0, dareCount: 0,
        provider, prepared: false, usedIds: new Set(), custom: [], log: [], queue: [], round: null, interactions: new Map(), seen: new Map(), votes: new Set(), callbackPhases: new Set(), callbackQuotes: new Set(), spotlighted: new Set(), decks: new Map(), rng: seedRng(id), botTimers: new Set(),
        hypotheses: [], priors: [], director: emptyDirectorState(), ready: new Set(), demo, demoSpeed: 1 };
      this.rooms.set(code, room); this.persistRoom(room); socket.data = { roomCode: code, playerId: player.id }; void socket.join(code);
      ack({ ok: true, code, you: player.id, secret: player.secret, state: this.view(room, player.id) });
      this.states(room);
    });
    socket.on("join", (input, reply) => {
      const ack: (r: JoinReply) => void = typeof reply === "function" ? reply : () => {};
      if (!input || !isRoomCode(input.roomCode) || !validAlias(input.alias) || !validConsent(input.consent) || (!input.resume && (input as { demo?: unknown }).demo !== true && !validProfile(input.profile))) return ack({ ok: false, error: "Invalid room code, alias, profile, or consent." });
      const room = this.liveRoom(input.roomCode);
      if (!room || room.stage === "deleted") return ack({ ok: false, error: "Room not found." });
      if (socket.data.playerId && (socket.data.roomCode !== room.code || socket.data.playerId !== input.resume?.playerId)) return ack({ ok: false, error: "Already joined a room." });
      let player: Player;
      if (input.resume) {
        const candidate = room.players.find((p) => p.id === input.resume?.playerId && !p.isBot);
        const supplied = input.resume.secret;
        if (!candidate || typeof supplied !== "string") return ack({ ok: false, error: "Invalid or expired session." });
        const proof = resumeProof(supplied);
        if (!proof) return ack({ ok: false, error: "Invalid or expired session." });
        const previous = candidate.resumeRetry;
        const sameAuthenticatedSocket = candidate.connected && candidate.socketId === socket.id &&
          socket.data.roomCode === room.code && socket.data.playerId === candidate.id && previous?.socketId === socket.id;
        // Legacy bare-token retries remain limited to the authenticated socket.
        // A versioned retry can cross sockets only when both the previous token
        // and the original 128-bit client nonce match the pending rotation.
        const retry = !!previous && safeEqual(previous.secret, proof.token) &&
          (proof.nonce ? !!previous.nonce && safeEqual(previous.nonce, proof.nonce) : !previous.nonce && sameAuthenticatedSocket);
        if (!retry && !safeEqual(candidate.secret, proof.token)) return ack({ ok: false, error: "Invalid or expired session." });
        player = candidate;
        if (player.socketId && player.socketId !== socket.id) {
          const old = this.io.sockets.sockets.get(player.socketId);
          if (old) { old.data = {}; void old.leave(room.code); this.err(old, "SESSION_REPLACED", "This session reconnected elsewhere."); old.disconnect(true); }
        }
        if (retry) {
          // Return the already-rotated token; do not spend it a second time.
          previous!.socketId = socket.id;
        } else {
          player.resumeRetry = { secret: player.secret, socketId: socket.id, ...(proof.nonce ? { nonce: proof.nonce } : {}) };
          player.secret = secret();
        }
        player.connected = true; player.socketId = socket.id;
      } else {
        if (room.stage !== "lobby") return ack({ ok: false, error: "The game has already started." });
        if (room.players.length >= MAX_PLAYERS) return ack({ ok: false, error: "Room is full." });
        if (room.players.some((p) => p.alias.toLocaleLowerCase() === input.alias.trim().toLocaleLowerCase())) return ack({ ok: false, error: "That alias is already in use." });
        player = { id: `p${room.nextPlayer++}`, alias: input.alias.trim(), consent: { ...input.consent }, profile: input.profile!, secret: secret(), isBot: false, connected: true, socketId: socket.id };
        room.players.push(player);
      }
      room.lastActivity = this.now(); socket.data = { roomCode: room.code, playerId: player.id }; void socket.join(room.code);
      room.seq++; this.persistRoom(room);
      ack({ ok: true, you: player.id, secret: player.secret, state: this.view(room, player.id) });
      this.states(room); this.replay(room, socket, player); this.prepare(room);
    });
    socket.on("ready", () => {
      const found = this.identify(socket); if (!found) return;
      const { room, player } = found;
      // A late tap from a phone that already saw the reveal is harmless.
      if (room.stage !== "ready" || room.ready.has(player.id)) return;
      room.ready.add(player.id);
      this.changed(room);
      if (this.everyoneReady(room)) this.showReveal(room);
    });
    socket.on("start", () => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (room.stage !== "lobby") return this.err(socket, "BAD_PHASE", "The game has already started.");
      // DEMO ROOMS (ROUND 4): the host plays every seat from one laptop, so the
      // ordinary 4–11 seat rule does not apply — but a night needs at least two
      // seats for the engine to have anything to compare.
      if (room.demo ? room.players.length < 2 : !playerCountOk(room.players.length)) {
        return this.err(socket, "PLAYER_COUNT", room.demo ? "Add at least one more demo seat to start." : `Start requires ${MIN_PLAYERS}–${MAX_PLAYERS} players.`);
      }
      this.prepare(room); this.loadPriors(room); this.enterHeat(room, "warmup");
    });
    socket.on("add_bot", () => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (room.stage !== "lobby") return this.err(socket, "BAD_PHASE", "Bots can only be added in the lobby.");
      if (room.players.length >= MAX_PLAYERS) return this.err(socket, "PLAYER_COUNT", "Room is full.");
      let n = 1; while (room.players.some((p) => p.alias.toLocaleLowerCase() === `🤖 Bot ${n}`.toLocaleLowerCase())) n++;
      room.players.push({ id: `p${room.nextPlayer++}`, alias: `🤖 Bot ${n}`, consent: { age: true, terms: true, revealOptIn: true }, profile: { ...neutralProfile }, secret: "", isBot: true, connected: true });
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
        // Host input must pass the same safety rules as generated prompts,
        // plus the existing conservative checks for additional harmful wording.
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
      else if (room.stage === "ready") this.showReveal(room);
      else if (room.stage === "reveal") this.afterReveal(room);
      else if (room.stage === "interlude") this.afterInterlude(room);
      else this.err(socket, "BAD_PHASE", "No round to skip.");
    });
    socket.on("vote_heat_down", () => {
      const found = this.identify(socket); if (!found) return;
      const { room, player } = found;
      if (!room.currentHeat || !["round", "ready", "reveal"].includes(room.stage) || room.pendingHeatDown) return this.err(socket, "BAD_PHASE", "Heat cannot be lowered here.");
      const i = HEAT_ORDER.indexOf(room.currentHeat);
      if (i <= 0) return this.err(socket, "MIN_HEAT", "The room is already at the lowest heat.");
      room.votes.add(player.id);
      this.checkVotes(room);
    });
    // -----------------------------------------------------------------------
    // DEMO ROOMS (ROUND 4) — host only, demo rooms only, puppeted seats only.
    // The host plays the whole game alone on one laptop: every extra seat is a
    // puppet that answers itself ("auto") or waits for the host ("manual").
    // The engine cannot tell the difference: puppet answers are ordinary
    // LogRecords (plus `impersonatedBy` metadata it ignores).
    // -----------------------------------------------------------------------
    socket.on("demo_add_player", (input, reply) => {
      const ack: (r: { ok: boolean; playerId?: PlayerId }) => void = typeof reply === "function" ? reply : () => {};
      const found = this.host(socket); if (!found) return ack({ ok: false });
      const { room } = found;
      if (!this.demoOnly(socket, room)) return ack({ ok: false });
      if (room.stage !== "lobby") { this.err(socket, "BAD_PHASE", "Demo seats are added in the lobby."); return ack({ ok: false }); }
      if (room.players.length >= MAX_PLAYERS) { this.err(socket, "PLAYER_COUNT", "Room is full."); return ack({ ok: false }); }
      const alias = typeof input?.alias === "string" ? input.alias.trim() : "";
      if (!validAlias(alias)) { this.err(socket, "INVALID_ALIAS", "Give the demo seat a 2–14 character name."); return ack({ ok: false }); }
      if (room.players.some((p) => p.alias.toLocaleLowerCase() === alias.toLocaleLowerCase())) {
        this.err(socket, "INVALID_ALIAS", "That name is already in the room."); return ack({ ok: false });
      }
      const player: Player = { id: `p${room.nextPlayer++}`, alias, consent: { age: true, terms: true, revealOptIn: true }, profile: neutralProfile,
        secret: "", isBot: false, connected: true, puppet: { mode: "auto" } };
      room.players.push(player);
      this.changed(room); this.prepare(room);
      ack({ ok: true, playerId: player.id });
    });
    socket.on("demo_remove_player", (input) => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (!this.demoOnly(socket, room)) return;
      if (room.stage !== "lobby") return this.err(socket, "BAD_PHASE", "Demo seats are removed in the lobby.");
      const target = room.players.find((p) => p.id === input?.playerId && p.puppet);
      if (!target) return this.err(socket, "NOT_A_PUPPET", "Only a demo seat can be removed.");
      room.players.splice(room.players.indexOf(target), 1);
      this.changed(room); this.prepare(room);
    });
    socket.on("demo_set_bot_mode", (input) => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (!this.demoOnly(socket, room)) return;
      const target = room.players.find((p) => p.id === input?.playerId && p.puppet);
      if (!target) return this.err(socket, "NOT_A_PUPPET", "Only a demo seat has a bot mode.");
      if (input.mode !== "auto" && input.mode !== "manual") return this.err(socket, "INVALID_MODE", "Mode must be auto or manual.");
      target.puppet = { mode: input.mode };
      // An auto seat readies itself; switching one to auto mid-gate can release it.
      if (room.stage === "ready") {
        if (input.mode === "auto") room.ready.add(target.id);
        else room.ready.delete(target.id);
        this.changed(room);
        if (this.everyoneReady(room)) this.showReveal(room);
        return;
      }
      this.changed(room);
    });
    socket.on("demo_answer_as", (input) => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (!this.demoOnly(socket, room)) return;
      const target = room.players.find((p) => p.id === input?.playerId && p.puppet);
      if (!target) return this.err(socket, "NOT_A_PUPPET", "Only a demo seat can be answered for.");
      const result = this.submit(room, target, input, found.player.id);
      if (!result.ok) this.err(socket, "DEMO_SUBMIT", result.error ?? "That answer was not accepted.");
    });
    socket.on("demo_all_ready", () => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (!this.demoOnly(socket, room)) return;
      if (room.stage !== "ready") return; // nothing pending: harmless no-op
      for (const player of room.players) room.ready.add(player.id);
      this.changed(room);
      this.showReveal(room);
    });
    socket.on("demo_speed", (input) => {
      const found = this.host(socket); if (!found) return;
      const { room } = found;
      if (!this.demoOnly(socket, room)) return;
      const scale = typeof input?.scale === "number" && Number.isFinite(input.scale) ? input.scale : NaN;
      if (!(scale >= 0.1 && scale <= 1)) return this.err(socket, "INVALID_SPEED", "Speed must be between 0.1 and 1.");
      // Applied to timers scheduled from now on; a round already in flight keeps
      // its closing time so nobody loses time to a mid-round change.
      room.demoSpeed = scale;
      this.changed(room);
    });
    socket.on("delete_room", () => {
      const found = this.identify(socket); if (!found) return;
      if (!this.deleteRoom(found.room)) this.err(socket, "DELETE_FAILED", "Could not remove room storage; try again.");
    });
    socket.on("disconnect", () => {
      const room = socket.data.roomCode ? this.liveRoom(socket.data.roomCode) : undefined;
      const player = room?.players.find((p) => p.id === socket.data.playerId && p.socketId === socket.id);
      if (!room || !player || room.stage === "deleted") return;
      player.connected = false; player.socketId = undefined;
      // A legacy retry is socket-bound; a nonce-bound pending request must
      // survive a dropped connection so the same client can safely retry it.
      if (!player.resumeRetry?.nonce) player.resumeRetry = undefined;
      room.votes.delete(player.id); room.lastActivity = this.now();
      this.changed(room); this.checkVotes(room); this.maybeComplete(room);
      // A pending reveal waits for everyone who is still here — and only them.
      if (room.stage === "ready" && this.everyoneReady(room)) this.showReveal(room);
    });
  }
  private prepare(room: Room): void {
    // A demo room may hold fewer seats than a real room and still wants the
    // same prompt variety, so only the real 4-seat floor blocks preparation.
    const floor = room.demo ? 2 : MIN_PLAYERS;
    if (room.prepared || room.stage !== "lobby" || room.players.length < floor || !room.provider.prepare) return;
    room.prepared = true;
    try {
      room.provider.setAliases?.(room.players.map((player) => player.alias));
      void Promise.resolve(room.provider.prepare({ playerCount: room.players.length, usedIds: [...room.usedIds], digest: emptyDigest() })).catch(() => { /* Bank remains available. */ });
    } catch { /* Bank remains available. */ }
  }
  private checkVotes(room: Room): void {
    if (!room.currentHeat || room.pendingHeatDown || !["round", "ready", "reveal"].includes(room.stage)) return;
    const active = room.players.filter((p) => p.connected);
    const votes = active.filter((p) => room.votes.has(p.id)).length;
    const index = HEAT_ORDER.indexOf(room.currentHeat);
    if (index > 0 && votes > active.length / 2) {
      room.pendingHeatDown = HEAT_ORDER[index - 1]; room.votes.clear();
      if (room.stage === "round") this.finishRound(room);
      else if (room.stage === "ready") this.showReveal(room);
      else this.afterReveal(room);
    }
  }
  /** Everything recruitable in a phase: host lines, provider output, the bank. */
  private candidatePool(room: Room, phase: HeatPhase): Prompt[] {
    let provided: Prompt[] = [];
    try { const result = room.provider.forPhase(phase, 100, room.usedIds, room.players.length); if (Array.isArray(result)) provided = result; } catch { /* fallback */ }
    const fallback = new BankPromptProvider().forPhase(phase, 100, new Set());
    // The packaged tap-war is authored as a warmup question. Reuse that same
    // neutral bank prompt later so warmup can gather a public text callback.
    const tapWar = phase === "deep" ? bankForPhase("warmup").filter((p) => p.kind === "minigame" && !room.usedIds.has(p.id)).map((p) => ({ ...p, phase })) : [];
    const extraDares = phase === "spicy" || phase === "deep"
      ? [...bankForPhase("dare"), ...new BankPromptProvider().forPhase("dare", 100, room.usedIds)]
        .filter((p) => p.kind === "dare" && !room.usedIds.has(p.id)).map((p) => ({ ...p, phase })) : [];
    return [...room.custom.filter((p) => p.phase === phase && !room.usedIds.has(p.id)), ...provided, ...tapWar, ...fallback, ...extraDares]
      .filter((p) => asSafePrompt(p, phase) && maxPlaceholderIndex(p.text) <= room.players.length);
  }
  private permittedIn(phase: HeatPhase, kind: RoundKind): (p: Prompt) => boolean {
    return phase === "dare" || kind === "dare" ? (p: Prompt): boolean => p.kind === kind : (p: Prompt): boolean => !["dare", "pair_dare", "debrief"].includes(p.kind);
  }
  /**
   * ROUND 4 — THE DIRECTOR DEALS ONE ROUND AT A TIME.
   *
   * Every heat round is chosen by the deterministic selector: 50% probing an
   * open hypothesis, 30% filling the least-covered pair × dimension cell, 20%
   * classic. The chosen prompt is an ordinary one; the director only decides
   * WHICH ordinary prompt comes next and which people its `{P1}`/`{P2}` slots
   * bind to. Nothing about the choice reaches a client.
   */
  private directedDefinition(room: Room, phase: HeatPhase, kind: RoundKind): Definition | undefined {
    let pool = this.candidatePool(room, phase).filter(this.permittedIn(phase, kind));
    if ((kind === "pair_dare" || phase === "spicy") && pool.some((p) => p.kind === kind && !p.id.startsWith("f-"))) pool = pool.filter((p) => !p.id.startsWith("f-"));
    // Generated Grok material fills flexible slots ahead of bank copy; the
    // explicit pick slots below retain their evidence-density coding floor.
    if (kind !== "pick") pool = [...pool].sort((a, b) => (a.source === "grok" ? -1 : 0) - (b.source === "grok" ? -1 : 0));
    // Host custom prompts are tonight's bank and always get their turn first
    // (spec §6) — they are ordinary "classic" rounds, not directed probes.
    const host = pool.find((p) => p.source === "host");
    if (host) {
      room.director = recordSelection(room.director, { subjects: [], dimension: host.coding, promptId: host.id });
      return { prompt: host, phase, kind: host.kind, text: host.text };
    }
    // Evidence variety is a HARD requirement the director must not eat: each
    // heat's pick slots stay on phase-appropriate claim codings. Warmup gets
    // friendship, spicy gets couple plus rivalry, and deep gets friendship.
    // The director still chooses the PAIR (test/explore) inside that coding.
    if (kind === "pick" && phase !== "dare") {
      const remainingPicks = room.plan?.phase === phase ? room.plan.slots.filter((slot) => slot === "pick").length : 0;
      const pickCoding: PromptCoding = phase === "warmup" ? "friendship"
        : phase === "spicy" ? (remainingPicks === 1 ? "couple" : "rivalry") : "friendship";
      const preferred = pool.filter((p) => p.kind === "pick" && p.coding === pickCoding && !room.usedIds.has(p.id));
      // Generated prompts come first in the pool, so a validated provider
      // candidate is preferred to a repeat of the bank.
      if (preferred.length > 0) pool = preferred;
    }
    const planned = planRound({
      hypotheses: room.hypotheses,
      state: room.director,
      candidates: pool,
      // Seeded by the round index: replaying a log replays the choices.
      seed: room.roundIndex + 1,
      kind,
      meta: this.meta(room),
    });
    if (!planned) return undefined;
    room.director = planned.state;
    room.testedHypothesisId = planned.hypothesisId;
    this.options.audit?.directed?.(room.code, {
      mode: planned.mode, dimension: planned.dimension, subjects: [...planned.subjects], promptId: planned.prompt.id,
      ...(planned.hypothesisId ? { hypothesisId: planned.hypothesisId } : {}),
    });
    return {
      prompt: planned.prompt, phase, kind: planned.prompt.kind, text: planned.prompt.text,
      ...(planned.subjects.length > 0 ? { subjects: [...planned.subjects] } : {}),
    };
  }
  /** Deal the next round of the phase; undefined means the phase is over. */
  private planNext(room: Room): Definition | undefined {
    const plan = room.plan;
    if (!plan) return undefined;
    while (plan.slots.length > 0) {
      const kind = plan.slots.shift()!;
      const definition = this.directedDefinition(room, plan.phase, kind);
      if (definition) return definition;
    }
    while (plan.live.length > 0) {
      const moment = plan.live.shift()!;
      const definition = moment === "spotlight" ? this.spotlightDefinition(room, plan.phase) : this.verdictDefinition(room, plan.phase);
      if (definition) return definition;
    }
    return undefined;
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
    room.queue = []; room.pair = undefined; room.interlude = undefined;
    // LIVE MOMENTS (spec §3): ~1 spotlight per phase from warmup on, ~1 verdict
    // per phase from spicy on. Both close the phase.
    room.plan = {
      phase,
      slots: phaseSlots(phase),
      live: [
        ...(liveKindInPhase("spotlight", phase) ? (["spotlight"] as RoundKind[]) : []),
        ...(liveKindInPhase("verdict", phase) ? (["verdict"] as RoundKind[]) : []),
      ],
    };
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
    return text.replace(/\{P(1[01]|[1-9])\}/g, (_whole, n: string) => room.players.find((p) => p.id === ids[Number(n) - 1])?.alias ?? "someone");
  }
  /** Add callbacks in later phases. Only already-public text
   * answers are eligible; private pair debriefs never enter this path. */
  private withCallback(room: Room, definition: Definition, question: string): string {
    const phase = definition.phase;
    if (phase === "warmup" || phase === "debrief" || phase === "interlude" || phase === "lobby" || phase === "finale" || phase === "closed" ||
        definition.kind === "spotlight" || definition.kind === "verdict" || definition.kind === "dare" || definition.kind === "pair_dare" ||
        definition.prompt.source === "host") return question;
    const marker = "\n\nEarlier, someone said: “";
    const maxQuote = 160 - question.length - marker.length - 2; // closing quote + optional ellipsis
    if (maxQuote < 20) return question;
    const quotes = this.finaleOnly
      ? safeCallbackQuotes(room.log, room.players.flatMap((p) => [p.alias, p.id]))
      : room.log.flatMap((record) => record.roundKind === "text" && record.value.kind === "text" ? [record.value.text.trim()] : [])
        .filter((quote) => quote.length >= 20 && !/[\u0000-\u001f\u007f“”]/u.test(quote) && !checkHardBlocked(quote));
    const quote = quotes.find((value) => !room.callbackQuotes.has(value)) ?? quotes[0];
    if (!quote) return question;
    if (this.finaleOnly && quote.length > maxQuote) return question;
    let excerpt = quote.slice(0, maxQuote);
    if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
    if (excerpt.length < quote.length) {
      const wordBoundary = excerpt.lastIndexOf(" ");
      if (wordBoundary >= 20) excerpt = excerpt.slice(0, wordBoundary);
    }
    excerpt = excerpt.trimEnd();
    if (excerpt.length < 20) return question;
    room.callbackPhases.add(phase);
    room.callbackQuotes.add(quote);
    return `${question}${marker}${excerpt}”${excerpt.length < quote.length ? "…" : ""}`;
  }
  private nextRound(room: Room): void {
    if (room.stage === "deleted") return;
    const definition = room.queue.shift() ?? this.planNext(room);
    if (!definition) {
      if (room.phase === "debrief") return this.beginInterlude(room, "finale");
      if (room.currentHeat === "dare") return room.pair ? this.beginInterlude(room, "debrief") : this.beginInterlude(room, "finale");
      const index = room.currentHeat ? HEAT_ORDER.indexOf(room.currentHeat) : -1;
      return this.beginInterlude(room, HEAT_ORDER[index + 1] ?? "finale");
    }
    this.clearTimers(room); room.reveal = undefined; room.interlude = undefined; room.stage = "round";
    if (definition.kind === "pair_dare") { room.pair = this.pair(room); definition.onlyPlayers = [...room.pair]; }
    if (definition.kind === "dare") {
      const roster = room.players.map(p => p.id);
      definition.performer = roster[room.dareCount % roster.length]!; room.dareCount++;
      definition.onlyPlayers = [definition.performer];
    }
    // Mark the spotlight rotation only when the moment actually starts: a
    // heat-down or host skip that drops the queue must not burn a player's turn.
    if (definition.kind === "spotlight" && definition.subjectId) {
      room.spotlighted.add(definition.subjectId); room.lastSubject = definition.subjectId;
    }
    const startedAt = this.now();
    const lengthMs = this.scale(room, this.options.roundTimers?.[definition.kind] ?? ROUND_TIMERS_MS[definition.kind]);
    // Use a function replacement: aliases can contain `$&` or other special characters.
    // `{S}` is the subject's alias — substituted for display only, exactly like `{P1}`.
    // A director-chosen round binds its probed subjects into the first slots.
    const question = definition.kind === "spotlight" && definition.subjectId
      ? definition.text.replace(/\{S\}/g, () => room.players.find((p) => p.id === definition.subjectId)?.alias ?? "someone")
      : definition.kind === "pair_dare"
        ? `You two: ${this.replacePlaceholders(room, definition.text, definition.onlyPlayers)}`
        : this.replacePlaceholders(room, definition.text, definition.kind === "dare" && definition.performer ? Array.from({ length: MAX_PLAYERS }, (_, i) => { const others = room.players.filter(p => p.id !== definition.performer); return others[i % others.length]!.id; }) : definition.subjects ?? definition.onlyPlayers);
    const round: LiveRound = { ...definition, text: this.withCallback(room, definition, question), id: `${room.id}-${++room.roundIndex}`, index: room.roundIndex, startedAt,
      closesAt: startedAt + lengthMs, responses: new Map(),
      ...(definition.kind === "verdict" ? { voteOpensAt: startedAt + Math.min(this.scale(room, this.options.verdictDiscussMs ?? VERDICT_DISCUSS_MS), lengthMs) } : {}) };
    if (round.kind === "rating" || round.kind === "ios") {
      const eligible = room.players.map(p => p.id);
      round.targets = new Map(eligible.map(id => { const others = eligible.filter(x => x !== id); return [id, others[Math.max(0, room.roundIndex - 1) % others.length]!] as const; }));
      if (round.kind === "rating") round.trait = TRAITS[(room.roundIndex - 1) % TRAITS.length]!;
    }
    room.round = round; room.usedIds.add(definition.prompt.id); this.changed(room);
    this.eachSocket(room, (socket, player) => socket.emit("round", this.guard(this.roundView(round, player.id))));
    this.io.to(displayChannel(room.code)).emit("round", this.guard(this.displayView(room).round!));
    this.schedule(room, round.closesAt - startedAt + this.scale(room, this.options.graceMs ?? GRACE_MS), () => this.finishRound(room));
    for (const player of room.players) if ((player.isBot || player.puppet?.mode === "auto") && (!round.onlyPlayers || round.onlyPlayers.includes(player.id))) this.scheduleBot(room, player, round);
    this.maybeComplete(room);
  }
  private scheduleBot(room: Room, player: Player, round: LiveRound, delayMs?: number): void {
    const [min, max] = this.options.botDelayMs ?? [600, 3500];
    const delay = delayMs ?? min + Math.floor(room.rng() * (max - min + 1));
    const timer = setTimeout(() => {
      room.botTimers.delete(timer);
      if (this.liveRoom(room.code) !== room || room.round?.id !== round.id || room.stage !== "round") return;
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
        case "rating": value = { kind: "rating", trait: round.trait ?? TRAITS[rand(TRAITS.length)]!, about: round.targets?.get(player.id) ?? other, value: 1 + rand(10) }; break;
        case "ios": value = { kind: "ios", about: round.targets?.get(player.id) ?? other, value: 1 + rand(7) }; break;
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
  /**
   * `impersonatedBy` is demo-room METADATA ONLY: the host puppeted this seat.
   * It is written to the room log and then ignored by every consumer — the
   * engine, the digest, the narrator and the claims never read it, so a demo
   * night scores exactly like the same answers from real phones (parity).
   */
  private submit(room: Room, player: Player, request: unknown, impersonatedBy?: PlayerId): { ok: boolean; error?: string } {
    if (!request || typeof request !== "object") return { ok: false, error: "Invalid submission." };
    const r = request as { roundId?: unknown; clientUuid?: unknown; value?: unknown };
    if (typeof r.roundId !== "string" || typeof r.clientUuid !== "string" || !r.clientUuid.trim() || r.clientUuid.length > 128) return { ok: false, error: "Invalid submission id." };
    if (!validSubmit(r.value, player.id)) return { ok: false, error: "Invalid answer." };
    const value = canonicalValue(r.value as ResponseValue);
    const key = `${player.id}\u0000${r.clientUuid}`, fingerprint = JSON.stringify(value);
    const previous = room.seen.get(key);
    if (previous) return previous.roundId === r.roundId && previous.fingerprint === fingerprint ? { ok: true } : { ok: false, error: "Submission id was already used." };
    const round = room.round;
    if (room.stage !== "round" || !round || r.roundId !== round.id || this.now() > round.closesAt + this.scale(room, this.options.graceMs ?? GRACE_MS)) return { ok: false, error: "This round is closed." };
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
    if (round.kind === "verdict" && value.kind === "pick" && value.target === player.id) return { ok: false, error: "Choose another player for the verdict." };
    if (round.kind === "spotlight" && value.kind === "text" && value.text.length > SPOTLIGHT_ANSWER_MAX) {
      return { ok: false, error: `Keep it to ${SPOTLIGHT_ANSWER_MAX} characters.` };
    }
    if (value.kind === "shout" && /\s/u.test(value.word.trim())) return { ok: false, error: "Shout must be one word." };
    const target = value.kind === "pick" ? value.target : value.kind === "ios" ? value.about : value.kind === "rating" && value.about !== "self" ? value.about : undefined;
    if (target !== undefined && !room.players.some((p) => p.id === target)) return { ok: false, error: "Unknown target." };
    if ((round.kind === "rating" || round.kind === "ios") && value.kind === round.kind) {
      if (value.about !== round.targets?.get(player.id)) return { ok: false, error: "Answer must use your assigned subject." };
      if (value.kind === "rating" && value.trait !== round.trait) return { ok: false, error: "Answer must use the assigned trait." };
    }
    if (round.kind === "pair_dare" && round.pairPassed && value.kind === "dare" && value.status !== "passed") return { ok: false, error: "Your partner passed; submit your own reason to close the pair dare." };
    const at = this.now();
    // The spotlight subject's answer answers the COVER round, not the moment.
    // Flagging it here means no downstream consumer can score it by accident.
    const decoy = round.kind === "spotlight" && round.subjectId === player.id;
    const record: LogRecord = { roomId: room.id, roundId: round.id, playerId: player.id, roundKind: round.kind, promptId: round.prompt.id, coding: round.prompt.coding,
      value, ...(round.kind === "pick" && value.kind === "pick" && value.target === player.id ? { selfSignal: "selfimage" as const } : {}), at, latencyMs: Math.max(0, at - round.startedAt), ...(decoy ? { decoy: true } : {}), ...(round.kind === "dare" && round.performer ? { performerId: round.performer } : round.kind === "pair_dare" ? { performerId: player.id } : {}), ...(impersonatedBy ? { impersonatedBy } : {}) };
    try { appendFileSync(room.file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 }); }
    catch { return { ok: false, error: "Unable to save the answer." }; }
    room.log.push(record); room.seen.set(key, { roundId: r.roundId, fingerprint }); round.responses.set(player.id, value); if (round.kind === "pair_dare" && value.kind === "dare" && value.status === "passed") round.pairPassed = true; room.lastActivity = at; this.persistRoom(room);
    this.options.audit?.persisted(room.code, room.file, { roundId: r.roundId, playerId: player.id, clientUuid: r.clientUuid });
    if (target && target !== player.id) { const k = PAIR_KEY(player.id, target); room.interactions.set(k, (room.interactions.get(k) ?? 0) + 1); }
    this.changed(room);
    if (!player.isBot && player.socketId) this.io.sockets.sockets.get(player.socketId)?.emit("round", this.guard(this.roundView(round, player.id)));
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
    this.clearTimers(room); room.round = null;
    // ROUND 4: the engine re-reads the room after EVERY round. Pure deterministic
    // code decides what it suspects; nothing here is emitted.
    this.refreshHypotheses(room, round.id);
    // ROUND 4: the reveal is PENDING, not shown. Nobody misses the moment.
    this.beginReady(room, this.buildReveal(room, round));
  }
  /** The reveal payload for a round that just closed. Pure formatting — the
   *  only side effect is the (internal) hypothesis refresh, done by the caller. */
  private buildReveal(room: Room, round: LiveRound): RevealView {
    if (this.finaleOnly && round.kind !== "spotlight") {
      return { roundId: round.id, summary: "Answers saved for the finale.", holdMs: this.scale(room, this.options.revealHoldMs ?? 2000) };
    }
    const items: NonNullable<RevealView["items"]> = [];
    if (round.kind === "shout") {
      const counts = new Map<string, { word: string; count: number }>();
      for (const value of round.responses.values()) if (value.kind === "shout") { const k = value.word.trim().toLocaleLowerCase(); const entry = counts.get(k) ?? { word: value.word.trim(), count: 0 }; entry.count++; counts.set(k, entry); }
      const winner = [...counts.values()].sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))[0];
      if (winner) items.push({ alias: "The room", text: `${winner.word} (${winner.count})` });
    } else if (round.kind === "minigame") {
      const leaderboard = [...round.responses].flatMap(([id, v]) => v.kind === "minigame" ? [{ id, score: v.score }] : []).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      for (const entry of leaderboard) items.push({ alias: room.players.find((p) => p.id === entry.id)?.alias ?? "Player", text: `${entry.score} taps` });
    } else if (round.kind !== "debrief" && round.kind !== "spotlight" && round.kind !== "verdict") {
      for (const [id, value] of round.responses) {
        if (value.kind === "text" && room.log.some((r) => r.decoy === true && r.roundId === round.id && r.playerId === id)) continue;
        const alias = room.players.find((p) => p.id === id)?.alias ?? "Player";
        if (value.kind === "text") items.push({ alias, text: value.text });
        if (value.kind === "dare") items.push({ alias, text: value.status === "done" ? "Done" : `Passed: ${value.reason}` });
        if (value.kind === "pick") items.push({ alias, text: value.target === id ? "picked THEMSELVES 💅" : "Submitted a pick." });
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
      const holdMs = this.scale(room, this.options.revealHoldMs ?? SPOTLIGHT_REVEAL_MS);
      return { roundId: round.id, kind: "spotlight", summary: `Live on ${subjectAlias}`,
        ...(items.length ? { items } : {}), subject: subjectAlias, ...(punchline ? { punchline } : {}), holdMs };
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
      const holdMs = this.scale(room, this.options.revealHoldMs ?? VERDICT_REVEAL_MS);
      return { roundId: round.id, kind: "verdict",
        summary: winner ? `The room decided: ${alias(winner[0])}` : "Nobody voted. The room argued for nothing.",
        ...(slide ? { slide } : {}), celebrate: round.couple ?? round.prompt.coding === "couple", holdMs };
    }
    const holdMs = this.scale(room, this.options.revealHoldMs ?? REVEAL_HOLD_MS);
    return { roundId: round.id, summary: round.kind === "debrief" ? "Their answers are private." : round.kind === "shout" ? "The room has spoken." : round.kind === "minigame" ? "Tap-war leaderboard" : "Round complete.", ...(items.length ? { items } : {}), holdMs };
  }
  // ---------------------------------------------------------------------------
  // THE READY GATE (ROUND 4)
  // A closed round's reveal is pending until every connected player has pressed
  // ready, so nobody misses the moment (a reconnecting phone still gets it).
  // The grace timer fires the reveal anyway — one AFK phone never stalls the
  // night. Bots and auto-puppeted demo seats are always ready: they have no
  // phone to look at.
  // ---------------------------------------------------------------------------
  private beginReady(room: Room, reveal: RevealView): void {
    room.stage = "ready"; room.ready.clear(); room.pendingReveal = reveal;
    if (this.finaleOnly) return this.showReveal(room);
    for (const player of room.players) if (player.isBot || player.puppet?.mode === "auto") room.ready.add(player.id);
    const grace = this.scale(room, this.options.readyGraceMs ?? REVEAL_READY_GRACE_MS);
    room.readyClosesAt = this.now() + grace;
    this.changed(room);
    if (this.everyoneReady(room)) return this.showReveal(room);
    this.schedule(room, grace, () => { if (room.stage === "ready") this.showReveal(room); });
  }
  /** A connected seat that has not pressed ready yet is the only thing a reveal waits for. */
  private everyoneReady(room: Room): boolean {
    return room.players.every((p) => !p.connected || room.ready.has(p.id));
  }
  private showReveal(room: Room): void {
    const reveal = room.pendingReveal;
    if (!reveal || room.stage !== "ready") return;
    this.clearTimers(room);
    room.pendingReveal = undefined; room.readyClosesAt = undefined; room.ready.clear();
    room.stage = "reveal";
    room.reveal = { value: reveal, endsAt: this.now() + reveal.holdMs };
    this.changed(room);
    this.io.to(room.code).emit("reveal", this.guard(reveal));
    this.io.to(displayChannel(room.code)).emit("reveal", this.guard(reveal));
    this.schedule(room, reveal.holdMs, () => this.afterReveal(room));
  }
  /** Timer scale: 1 everywhere except a demo room, where the host can speed up. */
  private scale(room: Room, ms: number): number {
    return room.demo ? Math.max(1, Math.round(ms * room.demoSpeed)) : ms;
  }
  private afterReveal(room: Room): void {
    if (room.stage !== "reveal") return;
    this.clearTimers(room); room.reveal = undefined;
    if (room.pendingHeatDown) { const next = room.pendingHeatDown; room.pendingHeatDown = undefined; room.queue = []; return this.beginInterlude(room, next, true); }
    this.nextRound(room);
  }
  private beginInterlude(room: Room, next: HeatPhase | "debrief" | "finale", cooled = false): void {
    this.clearTimers(room); room.stage = "interlude"; room.phase = "interlude"; room.round = null; room.reveal = undefined;
    if (next === "debrief" && room.provider.prepareAnalysis) {
      // Start the optional public-text batch while players do their private
      // debriefs. Never hold the next round or finale for an external service.
      try { void room.provider.prepareAnalysis(this.redactedLog(room)).catch(() => {}); } catch { /* local tags remain available */ }
    }
    const holdMs = this.scale(room, this.options.interludeHoldMs ?? INTERLUDE_HOLD_MS);
    const view: InterludeView = { headline: cooled ? "Cooling things down" : next === "finale" ? "The room has spoken" : `Next: ${next}`, sub: cooled ? "The room chose a gentler level." : "Take a breath before the next chapter.", holdMs };
    room.interlude = { value: view, endsAt: this.now() + holdMs };
    // Store the transition independently of the label exposed to clients.
    this.transitions.set(room.id, next); this.changed(room); this.io.to(room.code).emit("interlude", this.guard(view)); this.io.to(displayChannel(room.code)).emit("interlude", this.guard(view));
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
  /**
   * Recompute suspicions from the log so far (runs after every round). Any
   * claim a suspicion has GRADUATED into is kept for the finale, where it
   * arrives as an ordinary claim among the others.
   */
  private refreshHypotheses(room: Room, lastRoundId: string): void {
    try {
      const meta = this.meta(room);
      const log = this.redactedLog(room).filter((r) => r.decoy !== true);
      const signals = this.services.computeSignals(log, meta);
      const update = updateHypotheses(signals, log, meta, room.priors, {
        lastRoundId,
        ...(room.testedHypothesisId ? { testedHypothesisId: room.testedHypothesisId } : {}),
      });
      // Graduation is deliberately NOT accumulated round by round: at the
      // finale the engine re-derives it from the whole log, so every finale
      // claim is reproducible from the log alone.
      room.hypotheses = update.hypotheses;
    } catch {
      // A half-filled room cannot be scored yet; keep what we had.
    } finally {
      room.testedHypothesisId = undefined;
    }
  }
  /**
   * CROSS-NIGHT PRIORS. With accounts, last night's unresolved suspicions are
   * mapped onto tonight's pseudonymous ids and quietly probed again. Nobody is
   * told this is happening; guests simply carry nothing.
   */
  private loadPriors(room: Room): void {
    const accounts = this.options.accounts;
    if (!accounts) return;
    const accountToPlayer = new Map<string, string>();
    for (const player of room.players) if (player.accountId && !player.isBot) accountToPlayer.set(player.accountId, player.id);
    if (accountToPlayer.size === 0) return;
    const mapped = new Map<string, Hypothesis>();
    for (const accountId of accountToPlayer.keys()) {
      for (const prior of accounts.priors(accountId)) {
        const subjects: string[] = [];
        let usable = true;
        for (const key of prior.subjects) {
          const owner = key.split(":")[1];
          const tonight = owner ? accountToPlayer.get(owner) : undefined;
          if (!tonight) { usable = false; break; }
          subjects.push(tonight);
        }
        if (!usable || subjects.length === 0) continue;
        const id = `${prior.kind}-${[...subjects].sort().join("-")}`;
        mapped.set(id, {
          id, kind: prior.kind, subjects, status: "open", strength: prior.strength,
          evidence: [...prior.evidence], openedAt: prior.openedAt,
          ...(prior.lastTestedRound ? { lastTestedRound: prior.lastTestedRound } : {}),
        });
      }
    }
    room.priors = [...mapped.values()];
    room.hypotheses = room.priors.map((h) => ({ ...h, subjects: [...h.subjects], evidence: [...h.evidence] }));
  }
  /** Carry tonight's unresolved suspicions into the accounts that were here. */
  private savePriors(room: Room): void {
    const accounts = this.options.accounts;
    if (!accounts) return;
    const accountOf = new Map<string, string>();
    for (const player of room.players) if (player.accountId && !player.isBot) accountOf.set(player.id, player.accountId);
    if (accountOf.size === 0) return;
    const perAccount = new Map<string, StoredHypothesis[]>();
    for (const accountId of accountOf.values()) perAccount.set(accountId, []);
    for (const hypothesis of carryOver(room.hypotheses)) {
      const keys = hypothesis.subjects.map((id) => {
        const accountId = accountOf.get(id);
        return accountId ? accountSubjectKey(accountId, id) : undefined;
      });
      // A guest subject cannot be found again next night, so the suspicion dies
      // with the night rather than pointing at a stranger.
      if (keys.some((key) => key === undefined)) continue;
      for (const accountId of accountOf.values()) {
        perAccount.get(accountId)?.push({
          kind: hypothesis.kind, subjects: keys as string[], status: "unresolved",
          strength: hypothesis.strength, evidence: [...hypothesis.evidence], openedAt: hypothesis.openedAt,
          ...(hypothesis.lastTestedRound ? { lastTestedRound: hypothesis.lastTestedRound } : {}),
        });
      }
    }
    for (const [accountId, priors] of perAccount) accounts.setPriors(accountId, priors.slice(0, 20));
  }
  private meta(room: Room): RoomMeta {
    return { roomId: room.id, players: room.players.map((p, i) => ({ id: p.id, alias: pseudonym(i) })), revealOptIn: room.players.filter((p) => p.consent.revealOptIn).map((p) => p.id), profiles: Object.fromEntries(room.players.map(p => [p.id, p.profile])) };
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
    try { results = this.services.computeResults(signals, scoringLog, meta, room.provider); } catch { results = fallbackServices.computeResults(signals, scoringLog, meta); }
    // ROUND 4 pay-off: suspicions that graduated tonight arrive as ORDINARY
    // claims, re-derived from the whole log (plus any carried priors) so the
    // claim set stays reproducible from the log alone. One-sided ones are
    // private and become a Secret Card, never a public claim.
    try {
      const graduated = updateHypotheses(signals, scoringLog, meta, room.priors).claims;
      if (graduated.length > 0) {
        const known = new Set(results.claims.map((c) => c.id));
        results.claims.push(...graduated.filter((c) => !known.has(c.id)).map((c) => ({ ...c, subjects: [...c.subjects], evidence: [...c.evidence] })));
      }
    } catch { /* nothing graduates from an unscorable room */ }
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
    privateDebriefs.length = 0; log.length = 0; scoringLog.length = 0; signals = []; results = publicResults; digest = publicDigest;
    let skeleton: FinaleSlide[];
    try { skeleton = this.services.buildSkeleton(publicResults, publicDigest, meta); if (!Array.isArray(skeleton)) throw new Error("Invalid skeleton"); }
    catch { skeleton = fallbackServices.buildSkeleton(publicResults, publicDigest, meta); }
    // A provider polishing public slides receives public material only. In particular,
    // the private map never leaves this process or becomes input to public copy.
    // Engine-written secret copy remains the safe, useful no-key fallback.
    let written: { slides: FinaleSlide[]; decks: Map<PlayerId, SecretCard[]> } | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<undefined>((resolve) => { timeout = setTimeout(() => resolve(undefined), this.options.writerTimeoutMs ?? 10_000); timeout.unref(); });
      written = await Promise.race([Promise.resolve().then(() => this.services.writeFinale(structuredClone(skeleton), new Map(), structuredClone(publicResults), structuredClone(publicDigest), meta, room.provider)), deadline]);
    } catch { /* deterministic template */ } finally { if (timeout) clearTimeout(timeout); }
    if (room.stage !== "finale-building" || this.liveRoom(room.code) !== room) return;
    const publicIds = new Set(safeClaims.map((c) => c.id));
    const source = written && Array.isArray(written.slides) && written.slides.length === skeleton.length ? written.slides : skeleton;
    const slides: FinaleSlide[] = [];
    for (let i = 0; i < skeleton.length; i++) {
      const base = skeleton[i]!;
      if (base.claimId && !publicIds.has(base.claimId)) continue;
      const draft = source[i];
      const safeText = (candidate: unknown, original: string | undefined, title: boolean): string | undefined => {
        if (typeof candidate !== "string" || !candidate.trim() || candidate.length > (title ? 80 : 140) || (title && candidate.trim().split(/\s+/u).length > 6)) return original;
        // The network writer only sees a pseudonymous roster, so perform the
        // real-alias check here without ever sending that roster to a model.
        if (pseudonymizeText(candidate, room.players) !== candidate) return original;
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
    for (const record of room.log) {
      if (record.roundKind === "pick" && record.value.kind === "pick" && record.value.target === record.playerId) {
        const alias = room.players.find((p) => p.id === record.playerId)?.alias;
        if (alias) slides.push({ beat: "land", flavor: "stat", title: alias, body: `${alias} picked THEMSELVES 💅` });
      }
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
      this.savePriors(room);
    }
    room.finale = { slides, summary }; room.stage = "finale"; this.changed(room);
    this.io.to(room.code).emit("finale", this.guard(room.finale)); // public, identical on every socket
    this.io.to(displayChannel(room.code)).emit("finale", this.guard(room.finale));
    this.eachSocket(room, (socket, player) => { const deck = room.decks.get(player.id); if (deck) socket.emit("secrets", this.guard(deck)); });
  }
  private deleteRoom(room: Room): boolean {
    try { unlinkSync(room.file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    try { unlinkSync(metadataFile(room.file)); } catch { /* Metadata may not exist for legacy rooms. */ }
    room.stage = "deleted"; room.phase = "closed"; this.transitions.delete(room.id); this.rooms.delete(room.code);
    this.io.to(room.code).emit("deleted"); this.io.to(displayChannel(room.code)).emit("deleted");
    this.eachSocket(room, (socket) => { socket.data = {}; void socket.leave(room.code); });
    this.clearRoomMemory(room);
    return true;
  }
  /** Also reaps logs left after an unclean server shutdown. */
  purge(): void {
    const now = this.now();
    for (const room of this.rooms.values()) if (this.expired(room)) this.deleteRoom(room);
    const live = new Set([...this.rooms.values()].map((r) => r.file));
    try {
      for (const entry of readdirSync(this.options.dataDir, { withFileTypes: true })) {
        const match = entry.name.match(/^(\d{13})-[0-9a-f]{32}\.jsonl$/);
        if (!entry.isFile() || !match) continue;
        const file = join(this.options.dataDir, entry.name); if (live.has(file)) continue;
        try {
          const modified = statSync(file).mtimeMs;
          if (now - Number(match[1]) >= RETENTION_HOURS * HOUR || now - modified >= IDLE_TTL_HOURS * HOUR) { unlinkSync(file); try { unlinkSync(metadataFile(file)); } catch { /* Legacy log without metadata. */ } }
        } catch { /* Retry next sweep; never delete unrelated files. */ }
      }
    } catch { /* Retry next sweep. */ }
  }
}
