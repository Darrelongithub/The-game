// apps/server/src/room.ts
// THE ROOM MANAGER — the night's state machine.
//
// lobby → generating → play → results → closed
//
//   • The room is created AT STARTUP and bound to the host laptop by token.
//     Nobody types a room code; the QR carries it.
//   • Players join, fill a short profile, tick ready.
//   • The host presses Start. Ollama generates the night's prompts (spicy
//     first) while every phone shows the loading screen. The safety cap cuts
//     it off and the bank carries the night.
//   • Cases play one after another. A case closes the INSTANT the last
//     required person answers; a 1–2s "locked in" beat follows, then the next
//     case.
//   • After the last case: ONE ready gate ("Ready for the results?"). When
//     everyone is ready (or the host forces it), the reveal plays and each
//     phone gets its own secret deck.
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  READY_GATE_GRACE_MS,
  ROUND_TIMERS_MS,
  type ClientToServerEvents,
  type FinaleSlide,
  type LogRecord,
  type NightDigest,
  type PlayerId,
  type ProfileAnswers,
  type ResponseValue,
  type RoomCode,
  type RoomMeta,
  type RoomView,
  type SecretCard,
  type ServerToClientEvents,
} from "../../../packages/shared/src/contracts.ts";
import { isAlias, isProfileAnswers, isResponseValue, targetsOther } from "../../../packages/shared/src/validate.ts";
import {
  BEAT_MS,
  answerKindFor,
  buildBestCoupleCase,
  buildCase,
  buildDareCase,
  buildLookChainCase,
  buildShipVoteCase,
  caseViewFor,
  daresFor,
  logAnswer,
  lookChainsFor,
  makeRoomCode,
  makeToken,
  roomView,
  roomViewFor,
  shipVotesFor,
  totalCasesFor,
  type Case,
  type Player,
  type Room,
  type Segment,
} from "./game.ts";
import { LOOK_CHAIN_VARIANTS } from "./lookchain.ts";
import type { GameServices, PromptProvider } from "./services.ts";
import { integratedServices } from "./integratedServices.ts";
import { applyAliasesToDecks, applyAliasesToSlides } from "../../../packages/narrator/src/index.ts";

type SocketData = { roomCode?: string; playerId?: string; isHost?: boolean };

export interface SocketLike {
  id: string;
  data: SocketData;
  /** The player this socket belongs to, if any. */
  playerId?: PlayerId | undefined;
  emit: (event: string, payload?: unknown) => void;
  leave: (room: string) => void;
  join: (room: string) => void;
}

export interface SocketServerLike {
  to: (room: string) => { emit: (event: string, payload?: unknown) => void };
  fetchSockets: () => Promise<{ id: string; data: SocketData }[]>;
}
export interface GameOptions {
  now?: () => number;
  services?: GameServices;
  /** Seed for the night's shuffle. */
  seed?: number;
  rand?: () => number;
  /** Print the Ollama per-batch report to the terminal. */
  log?: (line: string) => void;
  /**
   * Timer factory. Injected so the night can be driven deterministically
   * (tests advance a manual clock instead of waiting on the wall clock).
   */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** How long the loading screen waits before the bank carries the night. */
const GENERATION_SAFETY_CAP_MS = 180_000;

export class RoomManager {
  private readonly rooms = new Map<RoomCode, Room>();
  private readonly now: () => number;
  private readonly services: GameServices;
  private readonly rand: () => number;
  private readonly log: (line: string) => void;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly providers = new Map<RoomCode, PromptProvider>();
  private readonly timers = new Map<string, unknown>();
  /** The sockets currently in each room. */
  private readonly sockets = new Map<RoomCode, Set<SocketLike>>();
  /** The room this process is hosting — bound at startup. */
  nightRoom?: Room;
  /** The token the host laptop uses to bind. */
  hostToken = "";

  constructor(private readonly io: SocketServerLike | null = null, options: GameOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.services = options.services ?? integratedServices;
    this.rand = options.rand ?? Math.random;
    this.log = options.log ?? ((line: string) => console.log(line));
    this.setTimer =
      options.setTimer ??
      ((fn: () => void, ms: number) => {
        const timer = setTimeout(fn, ms);
        if (typeof timer.unref === "function") timer.unref();
        return timer;
      });
    this.clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as never));
  }

  // -------------------------------------------------------------------------
  // room lifecycle
  // -------------------------------------------------------------------------

  /** Create THE night's room. Bound at startup — the host token goes with it. */
  createRoom(): Room {
    const code = this.uniqueCode();
    const hostToken = makeToken(this.rand);
    const room: Room = {
      code,
      hostToken,
      createdAt: this.now(),
      phase: "lobby",
      players: new Map(),
      order: [],
      hostConnected: false,
      seed: this.options_seed(),
      cases: [],
      caseIndex: 0,
      log: [],
      usedPromptIds: new Set(),
      pool: [],
      finalReady: new Set(),
      revealed: false,
      totalCases: 0,
      shipPairsUsed: new Set(),
      lookChains: [],
      seq: 0,
      deleted: false,
    };
    this.rooms.set(code, room);
    this.nightRoom = room;
    this.hostToken = hostToken;
    return room;
  }

  private options_seed(): number {
    return Math.floor(this.rand() * 0xffffffff) >>> 0;
  }

  private uniqueCode(): string {
    for (let i = 0; i < 50; i++) {
      const code = makeRoomCode(this.rand);
      if (!this.rooms.has(code)) return code;
    }
    return makeRoomCode(this.rand);
  }

  get(code: RoomCode): Room | undefined {
    return this.rooms.get(code);
  }

  /** The room the host laptop is bound to. */
  roomForHostToken(token: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.hostToken === token) return room;
    }
    return undefined;
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  // -------------------------------------------------------------------------
  // joining
  // -------------------------------------------------------------------------

  /** A player joins the room. */
  join(
    code: RoomCode,
    alias: string,
    profile: ProfileAnswers,
    consentAge: boolean,
  ): { ok: true; room: Room; player: Player } | { ok: false; error: string } {
    const room = this.rooms.get(code);
    if (!room) return { ok: false, error: "That room code does not exist." };
    if (room.deleted) return { ok: false, error: "That room has been deleted." };
    if (room.phase !== "lobby") return { ok: false, error: "This game has already started." };
    if (!isAlias(alias)) return { ok: false, error: "Pick a name between 2 and 14 characters." };
    if (!isProfileAnswers(profile)) return { ok: false, error: "Please answer every question." };
    if (!consentAge) return { ok: false, error: "You must be 18 or over to play." };
    if (room.players.size >= MAX_PLAYERS) return { ok: false, error: "This room is full." };

    const id = `p${room.players.size + 1}-${Math.floor(this.rand() * 1e6).toString(36)}`;
    const player: Player = {
      id,
      alias: alias.trim(),
      secret: makeToken(this.rand),
      connected: true,
      isBot: false,
      profile,
      ready: false,
      finalReady: false,
      joinedAt: this.now(),
    };
    room.players.set(id, player);
    room.order.push(id);
    this.broadcastState(room);
    return { ok: true, room, player };
  }

  /** A player reclaims their seat after a disconnect. */
  reclaim(code: RoomCode, playerId: PlayerId, secret: string): Player | undefined {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player || player.secret !== secret) return undefined;
    player.connected = true;
    this.broadcastState(room);
    return player;
  }

  /** A bot takes a seat (host only) — for filling a room during testing. */
  addBot(code: RoomCode): Player | undefined {
    const room = this.rooms.get(code);
    if (!room || room.players.size >= MAX_PLAYERS) return undefined;
    const index = room.players.size + 1;
    const player: Player = {
      id: `p${index}-bot`,
      alias: `Bot ${index}`,
      secret: makeToken(this.rand),
      connected: true,
      isBot: true,
      ready: true,
      finalReady: false,
      joinedAt: this.now(),
    };
    room.players.set(player.id, player);
    room.order.push(player.id);
    this.broadcastState(room);
    return player;
  }

  /** Mark a player ready in the lobby. */
  setReady(code: RoomCode, playerId: PlayerId, ready: boolean): void {
    const room = this.rooms.get(code);
    const player = room?.players.get(playerId);
    if (!room || !player) return;
    player.ready = ready;
    this.broadcastState(room);
  }

  // -------------------------------------------------------------------------
  // the night
  // -------------------------------------------------------------------------

  /**
   * The host presses Start. Ollama generates the night's prompts while every
   * phone shows the loading screen. The safety cap means the night always
   * starts.
   */
  async start(code: RoomCode): Promise<void> {
    const room = this.rooms.get(code);
    if (!room || room.phase !== "lobby") return;
    if (room.players.size < MIN_PLAYERS) return;

    room.phase = "generating";
    room.totalCases = totalCasesFor(room.order.length);
    room.generation = { done: 0, total: 40 };
    this.broadcastState(room);

    // The provider owns the bank + anything Ollama wrote.
    const provider = this.services.createPromptProvider({
      roomId: room.code,
      playerCount: room.order.length,
      seed: room.seed,
      aliases: room.order.map((id) => this.aliasOf(room, id)),
    });
    this.providers.set(room.code, provider);

    let prompts: Awaited<ReturnType<NonNullable<PromptProvider["generate"]>>> = [];
    try {
      prompts = (await provider.generate?.()) ?? [];
    } catch {
      prompts = [];
    }
    room.pool = prompts;
    room.generation = { done: prompts.length, total: 40 };
    this.broadcastState(room);

    // Build the night's cases.
    room.cases = this.planCases(room);
    room.caseIndex = 0;
    room.phase = "play";
    this.broadcastState(room);
    this.dealNextCase(room);
  }

  /**
   * Plan the whole night: cases, ship votes, dares and the best-couple pick,
   * shuffled so no two cases in a row are the same shape.
   */
  private planCases(room: Room): Case[] {
    const cases: Case[] = [];
    const now = this.now();
    let chainIndex = 0;
    // Players who have already acted in a chain — a second turn only after
    // everybody has had one.
    const chainActors = new Set<PlayerId>();
    const shipCount = shipVotesFor(room.order.length);
    const dareCount = daresFor(room.order.length);
    const caseCount = room.totalCases;

    const chainCount = lookChainsFor(room.order.length);
    const shapes: ("case" | "ship" | "bestcouple" | "dare" | "lookchain")[] = [];
    for (let i = 0; i < caseCount; i++) shapes.push("case");
    for (let i = 0; i < shipCount; i++) shapes.push("ship");
    shapes.push("bestcouple");
    for (let i = 0; i < dareCount; i++) shapes.push("dare");
    for (let i = 0; i < chainCount; i++) shapes.push("lookchain");
    // Shuffle, then make sure the shapes never repeat back to back.
    for (let i = shapes.length - 1; i > 0; i--) {
      const j = Math.floor(this.rand() * (i + 1));
      [shapes[i], shapes[j]] = [shapes[j]!, shapes[i]!];
    }
    // The night OPENS with a real case about somebody in the room.
    if (shapes[0] !== "case") {
      const first = shapes.findIndex((s) => s === "case");
      if (first > 0) [shapes[0], shapes[first]] = [shapes[first]!, shapes[0]!];
    }
    for (let i = 1; i < shapes.length; i++) {
      if (shapes[i] === shapes[i - 1]) {
        const swap = shapes.findIndex((s, idx) => idx > i && s !== shapes[i]);
        if (swap > 0) [shapes[i], shapes[swap]] = [shapes[swap]!, shapes[i]!];
      }
    }

    for (let i = 0; i < shapes.length; i++) {
      const shape = shapes[i]!;
      const index = i;
      let built: Case | undefined;
      if (shape === "ship") {
        built = buildShipVoteCase({ room, index, aliasOf: (id) => this.aliasOf(room, id), now, rand: this.rand });
      } else if (shape === "bestcouple") {
        built = buildBestCoupleCase({ room, index, aliasOf: (id) => this.aliasOf(room, id), now, rand: this.rand });
      } else if (shape === "dare") {
        // One dare per case — a dare template never repeats inside a night.
        const prompt = this.drawPrompts(room, "dare", 1)[0];
        if (prompt) {
          built = buildDareCase({ room, index, aliasOf: (id) => this.aliasOf(room, id), now, rand: this.rand, prompt });
        }
      } else if (shape === "lookchain") {
        // A fresh chain flavour every time — the copy never repeats tonight.
        const variant = LOOK_CHAIN_VARIANTS[chainIndex % LOOK_CHAIN_VARIANTS.length]!;
        chainIndex += 1;
        built = buildLookChainCase({
          room, index, aliasOf: (id) => this.aliasOf(room, id), now, rand: this.rand, variant,
          acted: chainActors,
        });
        if (built?.subjectId) chainActors.add(built.subjectId);
      } else {
        built = buildCase({
          room,
          index,
          draw: (role, count, opts) => this.drawPrompts(room, role, count, opts),
          aliasOf: (id) => this.aliasOf(room, id),
          now,
        });
      }
      if (built) cases.push(built);
    }
    return cases;
  }

  /** Draw prompts for a role, never repeating a template tonight. */
  private drawPrompts(
    room: Room,
    role: Parameters<PromptProvider["draw"]>[0]["role"],
    count: number,
    opts?: { kinds?: readonly import("../../../packages/shared/src/contracts.ts").RoundKind[]; metric?: string },
  ): import("../../../packages/shared/src/contracts.ts").Prompt[] {
    const provider = this.providers.get(room.code);
    if (!provider) return [];
    const picked = provider.draw({ role, count, kinds: opts?.kinds, metric: opts?.metric });
    for (const p of picked) room.usedPromptIds.add(p.id);
    return picked;
  }

  // -------------------------------------------------------------------------
  // playing
  // -------------------------------------------------------------------------

  /** Deal the next case, or finish the night. */
  private dealNextCase(room: Room): void {
    if (room.phase !== "play") return;
    const next = room.cases[room.caseIndex];
    if (!next) {
      this.finishNight(room);
      return;
    }
    room.current = next;
    room.caseIndex += 1;
    // The cap starts when the case is DEALT, not when the night was planned —
    // a case that is dealt ten minutes later still gets its full time.
    const now = this.now();
    next.startedAt = now;
    next.stage = 0;
    for (const segment of next.segments) {
      segment.closesAt = now + ROUND_TIMERS_MS[segment.kind];
    }
    this.scheduleCaseTimers(room, next);
    this.broadcastCase(room);
    // The state carries the round too, so a phone that is NOT in this case
    // (a ship vote they are not part of, a look chain stage they only watch)
    // clears the question it was holding.
    this.broadcastState(room);
  }

  /** Cap each segment of the OPEN stage. When it runs out, those players are skipped. */
  private scheduleCaseTimers(room: Room, current: Case): void {
    const stage = current.stage ?? 0;
    for (const segment of current.segments) {
      if ((segment.stage ?? 0) !== stage) continue;
      const delay = Math.max(0, segment.closesAt - this.now());
      const key = `${current.id}:${segment.id}`;
      const timer = this.setTimer(() => {
        this.timers.delete(key);
        segment.skipped = true;
        this.maybeCloseCase(room, current);
      }, delay);
      this.timers.set(key, timer);
    }
  }

  private clearCaseTimers(room: Room, current: Case): void {
    for (const segment of current.segments) {
      const key = `${current.id}:${segment.id}`;
      const timer = this.timers.get(key);
      if (timer !== undefined) {
        this.clearTimer(timer);
        this.timers.delete(key);
      }
    }
  }

  /** A player answers. */
  submit(code: RoomCode, playerId: PlayerId, value: ResponseValue, roundId?: string): { ok: boolean; error?: string } {
    const room = this.rooms.get(code);
    if (!room || room.phase !== "play") return { ok: false, error: "No question right now." };
    const current = room.current;
    if (!current || current.closed) return { ok: false, error: "That question has closed." };
    if (roundId && roundId !== current.id) return { ok: false, error: "That question has closed." };
    const stage = current.stage ?? 0;
    const segment = current.segments.find((s) => (s.stage ?? 0) === stage && s.players.includes(playerId));
    if (!segment) return { ok: false, error: "You have no question right now." };
    if (segment.answered.has(playerId)) return { ok: false, error: "Already answered." };
    if (this.now() > segment.closesAt) return { ok: false, error: "Time is up on that one." };

    // Server-enforced rules: never yourself, never skip a pick.
    if (!isResponseValue(value)) {
      return { ok: false, error: "That answer is not valid." };
    }
    if (value.kind !== answerKindFor(segment.kind)) {
      return { ok: false, error: "That answer does not fit the question." };
    }
    if (!targetsOther(value, playerId)) {
      return { ok: false, error: "You cannot pick yourself." };
    }
    if (value.kind === "dare" && value.status === "passed" && !value.reason?.trim()) {
      return { ok: false, error: "Say why you cannot do it." };
    }

    segment.answered.add(playerId);
    logAnswer(room, playerId, segment, value, this.now(), this.now() - current.startedAt);
    this.broadcastState(room);
    this.maybeCloseCase(room, current);
    return { ok: true };
  }

  /**
   * The case closes the INSTANT the last required person answers.
   * A player who timed out counts as skipped, not as an answer.
   */
  private maybeCloseCase(room: Room, current: Case): void {
    if (current.closed || room.current !== current) return;
    const stage = current.stage ?? 0;
    for (const segment of current.segments) {
      if ((segment.stage ?? 0) !== stage) continue;
      const resolved = segment.skipped || segment.answered.size >= segment.players.length;
      if (!resolved) return;
    }
    this.clearCaseTimers(room, current);

    // A look chain runs its stages one after another: act → guess → why.
    if (stage + 1 < (current.stageCount ?? 1)) {
      current.stage = stage + 1;
      const now = this.now();
      for (const segment of current.segments) {
        segment.closesAt = now + ROUND_TIMERS_MS[segment.kind];
      }
      this.scheduleCaseTimers(room, current);
      this.broadcastCase(room);
      return;
    }

    current.closed = true;

    // The 1–2s "locked in" beat, then the next case.
    this.broadcastBeat(room, "Locked in.", BEAT_MS, current.id);
    const timer = this.setTimer(() => {
      this.timers.delete(`${current.id}:beat`);
      if (room.phase === "play") this.dealNextCase(room);
    }, BEAT_MS);
    this.timers.set(`${current.id}:beat`, timer);
  }

  // -------------------------------------------------------------------------
  // the end of the night
  // -------------------------------------------------------------------------

  /** The last case is done — open the ONE ready gate. */
  private finishNight(room: Room): void {
    room.phase = "results";
    room.current = undefined;
    room.finalReady.clear();
    this.broadcastState(room);

    // The host may force the reveal after the grace period.
    const timer = this.setTimer(() => {
      this.timers.delete(`${room.code}:gate`);
      this.reveal(room);
    }, READY_GATE_GRACE_MS);
    this.timers.set(`${room.code}:gate`, timer);
  }

  /** A player says "Ready for the results". */
  finalReady(code: RoomCode, playerId: PlayerId): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== "results") return;
    room.finalReady.add(playerId);
    this.broadcastState(room);
    const everyone = room.order.filter((id) => room.players.get(id)?.connected);
    if (everyone.every((id) => room.finalReady.has(id))) this.reveal(room);
  }

  /** The host forces the reveal. */
  forceResults(code: RoomCode): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== "results") return;
    this.reveal(room);
  }

  /** Skip the current case (host only). */
  skipCase(code: RoomCode): void {
    const room = this.rooms.get(code);
    if (!room || room.phase !== "play" || !room.current) return;
    const current = room.current;
    current.closed = true;
    this.clearCaseTimers(room, current);
    this.broadcastBeat(room, "Moving on.", BEAT_MS, current.id);
    const timer = this.setTimer(() => {
      this.timers.delete(`${current.id}:beat`);
      if (room.phase === "play") this.dealNextCase(room);
    }, BEAT_MS);
    this.timers.set(`${current.id}:beat`, timer);
  }

  /**
   * THE REVEAL. The laptop plays the finale; every phone gets its own deck.
   * The decks are emitted per socket — never broadcast.
   */
  private async reveal(room: Room): Promise<void> {
    if (room.revealed) return;
    room.revealed = true;
    const timer = this.timers.get(`${room.code}:gate`);
    if (timer !== undefined) {
      this.clearTimer(timer);
      this.timers.delete(`${room.code}:gate`);
    }

    const meta = this.roomMeta(room);
    const results = this.services.computeResults(room.log, meta);
    const digest = this.services.buildNightDigest(room.log, meta);
    const decks = this.services.buildSecrets(results, room.log, meta);

    const roster = meta.players;
    const skeleton = this.services.buildSkeleton(results, digest, meta);

    let slides: FinaleSlide[];
    let finalDecks: Map<PlayerId, SecretCard[]> = decks;
    try {
      const written = await this.services.writeFinale(skeleton, decks, results, digest, meta);
      slides = written.slides;
      finalDecks = written.decks;
    } catch {
      slides = skeleton;
    }

    // Pseudonym → alias swap happens server-side, on the way out.
    const publicSlides = applyAliasesToSlides(slides, roster);
    const aliasedDecks = applyAliasesToDecks(finalDecks, roster);

    this.broadcastFinale(room, { slides: publicSlides, summary: {} });

    // The secret decks go to ONE socket each.
    for (const [playerId, cards] of aliasedDecks) {
      this.emitToPlayer(room, playerId, "secrets", { cards: cards.slice(0, 6) });
    }
  }

  /** Delete the room. Any player can do this. */
  deleteRoom(code: RoomCode): void {
    const room = this.rooms.get(code);
    if (!room) return;
    room.deleted = true;
    this.providers.get(code)?.dispose?.();
    this.providers.delete(code);
    for (const [key, timer] of this.timers) {
      if (key.startsWith(code)) {
        this.clearTimer(timer);
        this.timers.delete(key);
      }
    }
    this.io?.to(code).emit("deleted");
    this.rooms.delete(code);
    if (this.nightRoom?.code === code) this.nightRoom = undefined;
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  aliasOf(room: Room, id: PlayerId): string {
    return room.players.get(id)?.alias ?? id;
  }

  roomMeta(room: Room): RoomMeta {
    return {
      roomId: room.code,
      players: room.order
        .map((id) => room.players.get(id))
        .filter((p): p is Player => Boolean(p))
        .map((p) => ({ id: p.id, alias: p.alias })),
    };
  }

  /** Emit the room state to every socket in the room. */
  broadcastState(room: Room): void {
    room.seq += 1;
    const now = this.now();
    for (const socket of this.socketsFor(room)) {
      // The host laptop has no player seat — it gets the room view only.
      const view = socket.playerId
        ? roomViewFor(room, socket.playerId, now)
        : roomView(room, now);
      socket.emit("state", view);
    }
  }

  /** Emit the case to every socket — each player gets their own question. */
  private broadcastCase(room: Room): void {
    const now = this.now();
    for (const socket of this.socketsFor(room)) {
      if (!socket.playerId) continue; // the laptop never answers
      const view = caseViewFor(room, socket.playerId, now);
      if (view) socket.emit("round", view);
    }
  }

  private broadcastBeat(room: Room, label: string, holdMs: number, roundId?: string): void {
    for (const socket of this.socketsFor(room)) {
      socket.emit("beat", { label, holdMs, ...(roundId ? { roundId } : {}) });
    }
  }

  private broadcastFinale(room: Room, finale: { slides: FinaleSlide[]; summary: Record<string, string> }): void {
    for (const socket of this.socketsFor(room)) {
      socket.emit("finale", finale);
    }
  }

  private emitToPlayer(room: Room, playerId: PlayerId, event: string, payload: unknown): void {
    for (const socket of this.socketsFor(room)) {
      if (socket.playerId === playerId) socket.emit(event, payload);
    }
  }

  /** Every socket currently in the room. */
  socketsFor(room: Room): SocketLike[] {
    return [...(this.sockets.get(room.code) ?? [])];
  }

  /**
   * Register a socket with the room. The server calls this when a socket
   * joins or reclaims a seat, and `detachSocket` when it leaves.
   */
  attachSocket(code: RoomCode, socket: SocketLike): void {
    let set = this.sockets.get(code);
    if (!set) {
      set = new Set();
      this.sockets.set(code, set);
    }
    set.add(socket);
  }

  /** Remove a socket from the room. */
  detachSocket(code: RoomCode, socket: SocketLike): void {
    const set = this.sockets.get(code);
    if (!set) return;
    set.delete(socket);
    if (set.size === 0) this.sockets.delete(code);
  }

  close(): void {
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    for (const provider of this.providers.values()) provider.dispose?.();
    this.providers.clear();
    this.sockets.clear();
  }
}
