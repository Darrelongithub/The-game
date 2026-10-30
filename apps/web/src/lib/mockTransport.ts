// src/lib/mockTransport.ts — MockTransport: an in-memory scripted 4-player game.
//
// It exists so every screen can be built and demoed with NO server running
// (`NEXT_PUBLIC_TRANSPORT=mock npm run dev`). It walks the FULL phase flow
// through the same event shapes the real server sends:
//
//   lobby → warmup (pick, text, shout) → interlude(teaser) → reveal(items)
//   → spicy (rating, ios, minigame) → interlude → deep (pick, text)
//   → dare (dare + one PASSED dare with a verbatim reason, pair_dare)
//   → debrief (debrief ×2, both carrying onlyPlayers)
//   → finale (broadcast-safe slides) → secrets (3 face-down cards, THIS phone)
//
// It also survives a reload: the whole script position is snapshotted into
// sessionStorage, so killing the tab mid-round and reopening resumes from the
// snapshot instead of a blank screen (acceptance criterion).
import type {
  Consent,
  DarePassRequest,
  FinaleSlide,
  FinaleView,
  InterludeView,
  JoinReply,
  JoinRequest,
  ProfileAnswers,
  PlayerId,
  PlayerView,
  Phase,
  PromptCoding,
  ResponseValue,
  RevealView,
  RoomCode,
  RoomView,
  RoundKind,
  RoundView,
  SecretCard,
  SecretDeckView,
  SubmitRequest,
  TraitId,
} from "@shared/contracts.ts";
import { MAX_PLAYERS, MIN_PLAYERS, ROUND_TIMERS_MS } from "@shared/contracts.ts";
import { isAlias, isResponseValue, targetsOther } from "@shared/validate.ts";
import { clearSession, saveSession } from "./session";
import type { Transport, TransportHandlers } from "./transport";

const MOCK_CODE: RoomCode = "MOCK";
const MOCK_SECRET = "mock-secret";
const SNAPSHOT_KEY = "reveal.mock.snapshot";
/** The mock mirrors the real ready gate: the reveal waits for the phone, then
 *  the grace fires it anyway (production: REVEAL_READY_GRACE_MS = 20s). */
const MOCK_READY_GRACE_MS = 8_000;

/** Demo pace: real timers (up to 330s) would make the mock unbearable.
 *  Everything is clamped to a human-scale window. */
const MOCK_CLAMP: Partial<Record<RoundKind, number>> = {
  pick: 20_000,
  text: 30_000,
  shout: 12_000,
  rating: 20_000,
  ios: 20_000,
  minigame: 12_000,
  dare: 45_000,
  pair_dare: 35_000,
  debrief: 25_000,
  spotlight: 20_000,
  verdict: 30_000,
};

interface RoundSpec {
  kind: RoundKind;
  phase: Phase;
  coding: PromptCoding;
  text: string; // {P1}..{P4} placeholders, substituted like the server does
  onlyPlayers?: PlayerId[];
  /** Authoritative rating/IOS assignment from the RoundView contract. */
  trait?: TraitId;
  about?: PlayerId;
  /** spotlight: who the room is watching (the local player may be the subject) */
  subject?: PlayerId;
  /** spotlight: the cover question the subject sees instead of the real one */
  decoy?: string;
  /** spotlight: the subject's cover answer, revealed last as the punchline */
  punchline?: string;
  /** verdict: how long the phones stay face-down before the secret pick */
  debateMs?: number;
  /** what the bots "said" — flavour + reveal fuel, never scored */
  botAnswers?: { who: PlayerId; value: ResponseValue }[];
}

interface Step {
  kind: "round" | "interlude" | "finale" | "secrets";
  spec?: RoundSpec;
  interlude?: InterludeView;
}

interface Snap {
  you: PlayerId;
  alias: string;
  players: PlayerView[];
  hostId: PlayerId;
  phase: Phase;
  seq: number;
  stepIndex: number;
  round: RoundView | null;
  closedAt: number;
  votes: number;
  /** a reveal that was waiting for the room when the tab was reloaded */
  pendingReveal?: RevealView | null;
}

const BOT_NAMES = ["🤖 Bot 1", "🤖 Bot 2", "🤖 Bot 3"];

export class MockTransport implements Transport {
  readonly mode = "mock" as const;

  private handlers: TransportHandlers = {};
  private you: PlayerId = "p1";
  private alias = "You";
  private hostId: PlayerId = "p1";
  private players: PlayerView[] = [];
  private phase: Phase = "lobby";
  private seq = 0;
  private round: RoundView | null = null;
  private stepIndex = -1;
  private steps: Step[] = [];
  private roundId = "";
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private finaleTimer: ReturnType<typeof setTimeout> | null = null;
  private heatDownVotes = 0;
  private restoredSnapshot: Snap | null = null;
  /** ROUND 4 ready gate — the computed reveal waiting for every phone. */
  private pendingReveal: RevealView | null = null;
  private readyIds: PlayerId[] = [];
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private demo = false;
  /** demo rooms: which seats the host puppets, and how each one answers */
  private readonly puppets = new Set<PlayerId>();
  private readonly puppetModes: Record<PlayerId, "auto" | "manual"> = {};

  constructor() {
    this.restoredSnapshot = this.readSnapshot();
  }

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
    // A live snapshot means this tab was reloaded mid-night: restore it.
    if (this.restoredSnapshot) this.hydrate(this.restoredSnapshot);
  }

  // ------------------------------------------------------------- snapshot
  private readSnapshot(): Snap | null {
    if (typeof window === "undefined") return null;
    try {
      const raw = window.sessionStorage.getItem(SNAPSHOT_KEY);
      if (!raw) return null;
      const snap = JSON.parse(raw) as Snap;
      if (!snap?.you || !Array.isArray(snap.players) || !snap.players.length) return null;
      return snap;
    } catch {
      return null;
    }
  }

  private writeSnapshot(): void {
    if (typeof window === "undefined") return;
    try {
      const snap: Snap = {
        you: this.you,
        alias: this.alias,
        players: this.players,
        hostId: this.hostId,
        phase: this.phase,
        seq: this.seq,
        stepIndex: this.stepIndex,
        round: this.round,
        closedAt: this.round?.closesAt ?? 0,
        votes: this.heatDownVotes,
        pendingReveal: this.pendingReveal,
      };
      window.sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snap));
    } catch {
      /* storage full / private mode — mock keeps running in memory */
    }
  }

  private hydrate(snap: Snap): void {
    this.restoredSnapshot = null;
    this.you = snap.you;
    this.alias = snap.alias;
    this.players = snap.players;
    this.hostId = snap.hostId;
    this.phase = snap.phase;
    this.seq = snap.seq;
    this.stepIndex = snap.stepIndex;
    this.heatDownVotes = snap.votes ?? 0;
    this.steps = buildScript(this.players);
    saveSession({ code: MOCK_CODE, you: this.you, secret: MOCK_SECRET, alias: this.alias });
    this.handlers.onConnection?.(true, { resuming: true });

    if (snap.pendingReveal) {
      // A reload during the ready gate: reopen it, waiting for this phone.
      this.seq += 1;
      this.publishPending(snap.pendingReveal);
      return;
    }
    if (snap.round) {
      // Re-open the interrupted round with a fresh (short) window, so the
      // player gets their time back rather than landing on a dead screen.
      const kind = snap.round.kind;
      const ms = MOCK_CLAMP[kind] ?? ROUND_TIMERS_MS[kind];
      this.round = {
        ...snap.round,
        closesAt: Date.now() + ms,
        youSubmitted: false,
        promptText: snap.round.promptText,
      };
      this.phase = snap.round.phase;
      this.emitState();
      this.handlers.onRound?.(this.round);
      this.armTimer(ms);
    } else {
      this.round = null;
      // Older mock snapshots marked the finale as closed after its deck. A
      // deleted mock removes its snapshot, so those snapshots are recoverable.
      if (this.phase === "closed") this.phase = "finale";
      this.emitState();
      if (this.phase === "finale") this.emitFinale();
    }
    this.handlers.onConnection?.(true, { resuming: false });
  }

  // ---------------------------------------------------------------- join
  async create(alias: string, consent: Consent, profile: ProfileAnswers, options?: { demo?: boolean }): Promise<JoinReply & { code?: RoomCode }> {
    if (!isAlias(alias)) return { ok: false, error: "Alias must be 2–14 characters." };
    if (!consent.age) return { ok: false, error: "18+ only. This room is adults." };
    if (!consent.terms) return { ok: false, error: "You have to accept the rules." };

    this.you = "p1";
    this.alias = alias.trim();
    this.hostId = "p1";
    this.demo = options?.demo === true;
    this.players = [
      { id: "p1", alias: this.alias, connected: true, isBot: false },
    ];
    this.phase = "lobby";
    this.stepIndex = -1;
    this.round = null;
    this.closed = false;
    this.seq = 0;
    this.emitState();
    saveSession({ code: MOCK_CODE, you: this.you, secret: MOCK_SECRET, alias: this.alias });
    this.handlers.onConnection?.(true);
    return {
      ok: true,
      code: MOCK_CODE,
      you: this.you,
      secret: MOCK_SECRET,
      state: this.view(),
    };
  }

  async join(req: JoinRequest): Promise<JoinReply> {
    if (!req.resume && !req.profile) return { ok: false, error: "Complete your adult profile." };
    if (req.resume) return this.resumeReply(req.resume.playerId, req.resume.secret);
    if (!isAlias(req.alias)) return { ok: false, error: "Alias must be 2–14 characters." };
    if (!req.consent.age) return { ok: false, error: "18+ only. This room is adults." };

    if (this.players.length >= 2) return this.resumeReply(this.you, MOCK_SECRET);

    // Joining the scripted room: you're the host, the other three are bots.
    this.you = "p1";
    this.alias = req.alias.trim();
    this.hostId = "p1";
    this.players = [
      { id: "p1", alias: this.alias, connected: true, isBot: false },
      ...BOT_NAMES.map((name, i) => ({
        id: `p${i + 2}`,
        alias: name,
        connected: true,
        isBot: true,
      })),
    ];
    this.phase = "lobby";
    this.seq += 1;
    this.emitState();
    saveSession({ code: MOCK_CODE, you: this.you, secret: MOCK_SECRET, alias: this.alias });
    this.handlers.onConnection?.(true);
    return { ok: true, you: this.you, secret: MOCK_SECRET, state: this.view() };
  }

  private resumeReply(playerId: PlayerId, secret: string): JoinReply {
    if (secret !== MOCK_SECRET) return { ok: false, error: "That session expired." };
    this.you = playerId;
    if (!this.players.length) {
      this.restoredSnapshot = this.readSnapshot();
      if (this.restoredSnapshot) this.hydrate(this.restoredSnapshot);
      else return { ok: false, error: "That room is gone." };
      return { ok: true, you: this.you, secret: MOCK_SECRET, state: this.view() };
    }
    this.handlers.onConnection?.(true, { resuming: true });
    this.emitState();
    if (this.round) this.handlers.onRound?.(this.round);
    this.handlers.onConnection?.(true, { resuming: false });
    return { ok: true, you: this.you, secret: MOCK_SECRET, state: this.view() };
  }

  resume(): void {
    if (!this.players.length) {
      const snap = this.readSnapshot();
      if (snap) this.hydrate(snap);
      else this.handlers.onConnection?.(true);
      return;
    }
    this.handlers.onConnection?.(true, { resuming: true });
    this.emitState();
    if (this.round) this.handlers.onRound?.(this.round);
    this.handlers.onConnection?.(true, { resuming: false });
  }

  // ------------------------------------------------------------- actions
  start(): void {
    if (this.you !== this.hostId) return;
    if (this.players.length < MIN_PLAYERS) {
      this.handlers.onError?.({
        code: "not_enough_players",
        message: `Need ${MIN_PLAYERS} players — tap “Add bot” to fill a seat.`,
      });
      return;
    }
    this.steps = buildScript(this.players);
    this.stepIndex = 0;
    this.phase = "warmup";
    this.closed = false;
    this.advance();
  }

  addBot(): void {
    if (this.you !== this.hostId || this.phase !== "lobby") return;
    const n = this.players.filter((p) => p.isBot).length + 1;
    this.players = [
      ...this.players,
      {
        id: `p${this.players.length + 1}`,
        alias: `🤖 Bot ${n}`,
        connected: true,
        isBot: true,
      },
    ];
    this.seq += 1;
    this.emitState();
  }

  skipRound(): void {
    if (this.you !== this.hostId) return;
    if (this.pendingReveal) { this.showReveal(); return; }
    if (!this.round) return;
    this.resolveRound(null);
  }

  /** ROUND 4: "I'm ready for the pending reveal." */
  ready(): void {
    if (!this.pendingReveal) return;
    if (!this.readyIds.includes(this.you)) this.readyIds.push(this.you);
    this.seq += 1;
    this.emitState();
    if (this.everyoneReady()) this.showReveal();
  }

  /** Bots have no phone to miss the moment — they are always ready. */
  private everyoneReady(): boolean {
    return this.players.filter((p) => p.connected).every((p) => this.readyIds.includes(p.id));
  }

  private publishPending(reveal: RevealView): void {
    this.pendingReveal = reveal;
    // Bots have no phone to miss the moment; the human still has to tap ready.
    this.readyIds = this.players.filter((p) => p.isBot).map((p) => p.id);
    this.emitState();
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = setTimeout(() => { this.readyTimer = null; this.showReveal(); }, MOCK_READY_GRACE_MS);
  }

  private showReveal(): void {
    const reveal = this.pendingReveal;
    if (!reveal) return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    this.pendingReveal = null;
    this.readyIds = [];
    this.handlers.onReveal?.(reveal);
    this.seq += 1;
    this.emitState();
    this.next();
  }

  customPrompts(lines: string[]): void {
    if (this.you !== this.hostId) return;
    const clean = lines
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 10)
      .map((l) => (l.length > 160 ? l.slice(0, 160) : l));
    // Mock acknowledges by echoing the count in the room state's seq bump —
    // the real server merges them into tonight's bank only.
    this.seq += 1;
    this.emitState();
    if (clean.length) {
      this.handlers.onError?.({
        code: "mock_custom_prompts",
        message: `${clean.length} custom prompt${clean.length === 1 ? "" : "s"} queued for tonight (mock).`,
      });
    }
  }

  voteHeatDown(): void {
    this.heatDownVotes += 1;
    const needed = Math.ceil(this.players.length / 2);
    if (this.heatDownVotes >= needed && this.phase !== "lobby" && this.phase !== "finale") {
      this.handlers.onInterlude?.({
        headline: "Heat voted down",
        sub: "The group said not yet. Nobody is going to argue with a majority.",
        teaser: "Nobody knows who voted for mercy.",
        holdMs: 3200,
      });
    }
  }

  deleteRoom(): void {
    this.stopTimer();
    this.pendingReveal = null;
    this.readyIds = [];
    this.players = [];
    this.round = null;
    this.phase = "closed";
    this.closed = true;
    clearSession();
    if (typeof window !== "undefined") {
      try {
        window.sessionStorage.removeItem(SNAPSHOT_KEY);
      } catch {
        /* ignore */
      }
    }
    this.handlers.onDeleted?.();
  }

  forgetSession(): void {
    this.stopTimer();
    this.pendingReveal = null;
    this.readyIds = [];
    this.players = [];
    this.round = null;
    this.phase = "lobby";
    this.closed = false;
    this.restoredSnapshot = null;
    clearSession();
    if (typeof window !== "undefined") {
      try { window.sessionStorage.removeItem(SNAPSHOT_KEY); } catch { /* ignore */ }
    }
  }

  disconnect(): void {
    this.stopTimer();
  }

  // ------------------------------------------------------------- demo rooms
  // The mock keeps the same shape as the server so the demo panel is usable
  // offline: seats are puppets that answer themselves.
  async demoAddPlayer(alias: string): Promise<{ ok: boolean; playerId?: PlayerId }> {
    if (!this.demo || this.you !== this.hostId || this.phase !== "lobby") return { ok: false };
    if (this.players.length >= MAX_PLAYERS) return { ok: false };
    const clean = alias.trim();
    if (!isAlias(clean) || this.players.some((p) => p.alias.toLowerCase() === clean.toLowerCase())) return { ok: false };
    const playerId = `p${this.players.length + 1}`;
    this.players = [...this.players, { id: playerId, alias: clean, connected: true, isBot: false }];
    this.puppets.add(playerId);
    this.seq += 1;
    this.emitState();
    return { ok: true, playerId };
  }
  demoRemovePlayer(playerId: PlayerId): void {
    if (!this.demo || this.you !== this.hostId || this.phase !== "lobby") return;
    if (!this.puppets.has(playerId)) return;
    this.puppets.delete(playerId);
    this.players = this.players.filter((p) => p.id !== playerId);
    this.seq += 1;
    this.emitState();
  }
  demoSetBotMode(playerId: PlayerId, mode: "auto" | "manual"): void {
    if (!this.demo || !this.puppets.has(playerId)) return;
    this.puppetModes[playerId] = mode;
    if (mode === "auto" && this.pendingReveal && !this.readyIds.includes(playerId)) {
      this.readyIds.push(playerId);
      this.seq += 1;
      this.emitState();
      if (this.everyoneReady()) this.showReveal();
    }
  }
  demoAnswerAs(p: { playerId: PlayerId; roundId: string; clientUuid: string; value: ResponseValue }): void {
    if (!this.demo || !this.puppets.has(p.playerId)) return;
    if (!this.round || this.round.roundId !== p.roundId) return;
    // The mock cannot hold two answers at once; it releases the round so the
    // host can keep walking the script with one seat.
    if (!targetsOther(p.value, p.playerId) && (p.value.kind === "pick" || p.value.kind === "ios")) return;
    this.round = { ...this.round, youSubmitted: true };
    this.resolveRound(p.value);
  }
  demoAllReady(): void {
    if (!this.demo) return;
    this.readyIds = this.players.filter((p) => p.connected).map((p) => p.id);
    this.seq += 1;
    this.emitState();
    this.showReveal();
  }
  demoSpeed(): void { /* the mock script owns its own pace */ }

  async submit(req: SubmitRequest): Promise<{ ok: boolean; error?: string }> {
    if (!this.round || req.roundId !== this.round.roundId) {
      return { ok: false, error: "That round already closed." };
    }
    if (!isResponseValue(req.value)) return { ok: false, error: "That answer isn't valid." };
    if (!targetsOther(req.value, this.you)) {
      return { ok: false, error: "You can't point at yourself here." };
    }
    if (this.round.onlyPlayers && !this.round.onlyPlayers.includes(this.you)) {
      return { ok: false, error: "This one isn't yours to answer." };
    }
    if (this.round.kind === "verdict" && (this.round.voteOpensAt ?? 0) > Date.now()) {
      return { ok: false, error: "Phones down. Argue it out first." };
    }
    // NOTE: no onRound re-emit here — the UI already flips `youSubmitted`
    // locally, and a second round event for the same roundId would make
    // innocent clients answer twice.
    this.round = { ...this.round, youSubmitted: true };
    this.resolveRound(req.value);
    return { ok: true };
  }

  async darePass(req: DarePassRequest): Promise<{ ok: boolean; error?: string }> {
    if (!this.round) return { ok: false, error: "No open dare." };
    const reason = req.reason.trim();
    if (!reason) return { ok: false, error: "A reason is required. That's the whole point." };
    if (reason.length > 140) return { ok: false, error: "Keep it under 140 characters." };
    return this.submit({
      roundId: this.round.roundId,
      clientUuid: `pass-${Date.now()}`,
      value: { kind: "dare", status: "passed", reason },
    });
  }

  // ------------------------------------------------------------- engine
  private advance(): void {
    if (this.closed) return;
    if (this.stepIndex >= this.steps.length) {
      this.goFinale();
      return;
    }
    const step = this.steps[this.stepIndex];
    if (step.kind === "interlude" && step.interlude) {
      this.round = null;
      this.phase = "interlude";
      this.emitState();
      this.handlers.onInterlude?.(step.interlude);
      this.armTimer(step.interlude.holdMs);
      return;
    }
    if (step.kind === "finale") {
      this.goFinale();
      return;
    }
    if (step.kind === "secrets") {
      this.emitSecrets();
      return;
    }
    if (step.kind === "round" && step.spec) {
      this.openRound(step.spec);
    }
  }

  private next(): void {
    this.stepIndex += 1;
    this.advance();
  }

  private openRound(spec: RoundSpec): void {
    this.roundId = `r${this.stepIndex + 1}`;
    const ms = MOCK_CLAMP[spec.kind] ?? ROUND_TIMERS_MS[spec.kind];
    this.phase = spec.phase;
    // The spotlight subject's own phone shows the COVER, never the question.
    const cover = spec.subject === this.you ? spec.decoy : undefined;
    this.round = {
      roundId: this.roundId,
      index: this.stepIndex + 1,
      phase: spec.phase,
      kind: spec.kind,
      promptText: cover ?? substitute(spec.text, this.players),
      closesAt: Date.now() + ms,
      youSubmitted: false,
      ...(spec.kind === "verdict" ? { voteOpensAt: Date.now() + Math.min(spec.debateMs ?? 16_000, Math.max(0, ms - 2_000)) } : {}),
      ...(spec.onlyPlayers ? { onlyPlayers: spec.onlyPlayers } : {}),
      // Rating/IOS intent is carried by the round, never inferred from prose.
      ...(spec.trait ? { trait: spec.trait } : {}),
      ...(spec.about ? { about: spec.about } : {}),
    } satisfies RoundView;
    this.seq += 1;
    this.emitState();
    this.handlers.onRound?.(this.round);
    this.armTimer(ms);
  }

  private resolveRound(answer: ResponseValue | null): void {
    if (!this.round) return;
    this.stopTimer();
    const spec = this.steps[this.stepIndex]?.spec;
    const mine = answer ?? autoAnswer(spec, this.round, this.you, this.players);
    const finalAnswer: ResponseValue = mine ?? { kind: "text", text: "Passed." };

    const reveal = buildReveal(this.round, spec, finalAnswer, this.players, this.you);
    this.round = null;
    // ROUND 4: the reveal is PENDING until this phone (and every other) is ready.
    this.publishPending(reveal);
  }

  private armTimer(ms: number): void {
    this.stopTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.round) this.resolveRound(null);
      else this.next();
    }, ms);
  }

  private stopTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.finaleTimer) clearTimeout(this.finaleTimer);
    this.timer = null;
    this.finaleTimer = null;
  }

  private goFinale(): void {
    this.round = null;
    this.phase = "finale";
    this.seq += 1;
    this.emitState();
    this.emitFinale();
    this.stepIndex = this.steps.length; // finale is terminal for the script
  }

  // --------------------------------------------------------------- events
  private view(): RoomView {
    return {
      code: MOCK_CODE,
      phase: this.phase,
      hostId: this.hostId,
      players: this.players,
      round: this.round,
      seq: this.seq,
      ...(this.demo ? { demo: true } : {}),
      ...(this.pendingReveal ? { ready: [...this.readyIds] } : {}),
    };
  }

  private emitState(): void {
    this.handlers.onState?.(this.view());
    this.handlers.onConnection?.(true);
    this.writeSnapshot();
  }

  private emitFinale(): void {
    const finale: FinaleView = {
      slides: finaleSlides(this.players),
      summary: {
        ship: `Player 1 & Player 2`,
        besties: `Player 3 & Player 4`,
        toxic: `Player 4`,
        rivals: `Player 2 & Player 4`,
      },
    };
    this.handlers.onFinale?.(finale);
    this.phase = "finale";
    this.writeSnapshot();
    // The UI keeps the deck closed until the public story ends. Track this
    // delayed event so deletion, start-over and unmount cannot revive a room.
    if (this.finaleTimer) clearTimeout(this.finaleTimer);
    this.finaleTimer = setTimeout(() => {
      this.finaleTimer = null;
      if (!this.closed && this.phase === "finale") this.emitSecrets();
    }, 600);
  }

  private emitSecrets(): void {
    const deck: SecretDeckView = { cards: secretCards(this.players) };
    this.handlers.onSecrets?.(deck);
    this.seq += 1;
    this.emitState();
  }
}

// ------------------------------------------------------------------ script
function buildScript(players: PlayerView[]): Step[] {
  const p = (i: number) => players[Math.min(i, players.length - 1)].id;
  const p1 = p(0);
  const p2 = p(1);
  const p3 = p(2);
  const p4 = p(3);

  const interludeTeaser = (teaser: string, headline: string, sub: string): Step => ({
    kind: "interlude",
    interlude: { headline, sub, teaser, holdMs: 3200 },
  });

  return [
    {
      kind: "round",
      spec: {
        kind: "pick",
        phase: "warmup",
        coding: "trust",
        text: "Who do you call first at 3am when it all goes wrong?",
        botAnswers: [
          { who: p2, value: { kind: "pick", target: p3 } },
          { who: p3, value: { kind: "pick", target: p2 } },
          { who: p4, value: { kind: "pick", target: p2 } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "text",
        phase: "warmup",
        coding: "neutral",
        text: "One thing you would never say to {P2} out loud. Tonight you type it.",
        botAnswers: [
          { who: p2, value: { kind: "text", text: "You laugh like a kettle and I love it." } },
          { who: p3, value: { kind: "text", text: "I still have your hoodie from June." } },
          { who: p4, value: { kind: "text", text: "You're the reason I stopped texting my ex." } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "shout",
        phase: "warmup",
        coding: "neutral",
        text: "One word for this group right now. Fifteen seconds.",
        botAnswers: [
          { who: p2, value: { kind: "shout", word: "chaos" } },
          { who: p3, value: { kind: "shout", word: "chaos" } },
          { who: p4, value: { kind: "shout", word: "menace" } },
        ],
      },
    },
    interludeTeaser(
      "Two of you already picked the same person twice. It is not who you think.",
      "Warmup over",
      "Now the questions get personal."
    ),
    {
      kind: "round",
      spec: {
        kind: "rating",
        phase: "spicy",
        coding: "friction",
        text: "Rate {P2}'s chaos, 1 to 10. Be honest, they'll never see the raw number.",
        trait: "chaos",
        about: p2,
        botAnswers: [
          { who: p2, value: { kind: "rating", trait: "chaos", about: "self", value: 9 } },
          { who: p3, value: { kind: "rating", trait: "chaos", about: p2, value: 8 } },
          { who: p4, value: { kind: "rating", trait: "chaos", about: p2, value: 7 } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "ios",
        phase: "spicy",
        coding: "friendship",
        text: "How close are you to {P3}? Circles, 1 to 7.",
        about: p3,
        botAnswers: [
          { who: p2, value: { kind: "ios", about: p3, value: 5 } },
          { who: p3, value: { kind: "ios", about: p2, value: 6 } },
          { who: p4, value: { kind: "ios", about: p3, value: 4 } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "minigame",
        phase: "spicy",
        coding: "status",
        text: "TAP WAR — most taps in 5 seconds. Winner picks someone's punishment later.",
        botAnswers: [
          { who: p2, value: { kind: "minigame", score: 61 } },
          { who: p3, value: { kind: "minigame", score: 58 } },
          { who: p4, value: { kind: "minigame", score: 47 } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "spotlight",
        phase: "spicy",
        coding: "couple",
        text: "Who here is {P3} trying to impress?",
        subject: p3,
        punchline: "What did you eat today? — nothing, I'm being watched.",
        botAnswers: [
          { who: p2, value: { kind: "text", text: "{P2}" } },
          { who: p4, value: { kind: "text", text: "{P2}, obviously" } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "verdict",
        phase: "spicy",
        coding: "couple",
        debateMs: 6_000,
        text: "THE VERDICT: who here would make the best couple? Debate. Decide.",
        botAnswers: [
          { who: p2, value: { kind: "pick", target: p3 } },
          { who: p3, value: { kind: "pick", target: p2 } },
          { who: p4, value: { kind: "pick", target: p3 } },
        ],
      },
    },
    interludeTeaser(
      "Someone's fastest answer tonight was faster than their excuse for being late last week.",
      "The room is warm",
      "Deep end next. No lifeguard."
    ),
    {
      kind: "round",
      spec: {
        kind: "pick",
        phase: "deep",
        coding: "trust",
        text: "Who here knows something about you that you never told the rest?",
        botAnswers: [
          { who: p2, value: { kind: "pick", target: p3 } },
          { who: p3, value: { kind: "pick", target: p4 } },
          { who: p4, value: { kind: "pick", target: p2 } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "text",
        phase: "deep",
        coding: "neutral",
        text: "What's something you pretend not to care about, but do?",
        botAnswers: [
          { who: p2, value: { kind: "text", text: "Whether anybody notices I left first." } },
          { who: p3, value: { kind: "text", text: "Being picked last. Every single time." } },
          { who: p4, value: { kind: "text", text: "Whether {P2} still has my hoodie." } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "dare",
        phase: "dare",
        coding: "status",
        text: "Ring the friend who owes you money. Ask on speaker. Whole room listens.",
        botAnswers: [
          {
            who: p2,
            value: { kind: "dare", status: "passed", reason: "my mother is watching" },
          },
          { who: p3, value: { kind: "dare", status: "done" } },
          { who: p4, value: { kind: "dare", status: "done" } },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "pair_dare",
        phase: "dare",
        coding: "couple",
        text: "{P1} and {P2}: five minutes, no phones. Give each other your honest first impression.",
        onlyPlayers: [p1, p2],
        botAnswers: [{ who: p2, value: { kind: "dare", status: "done" } }],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "debrief",
        phase: "debrief",
        coding: "couple",
        text: "What did {P2} admit that surprised you? They answer separately. You compare at the finale.",
        onlyPlayers: [p1, p2],
        botAnswers: [
          {
            who: p2,
            value: { kind: "text", text: "They said they knew before I did." },
          },
        ],
      },
    },
    {
      kind: "round",
      spec: {
        kind: "debrief",
        phase: "debrief",
        coding: "rivalry",
        text: "What did {P4} admit that surprised you?",
        onlyPlayers: [p3, p4],
        botAnswers: [
          { who: p3, value: { kind: "text", text: "That they were jealous of {P2} for a year." } },
          { who: p4, value: { kind: "text", text: "That they knew about the group chat." } },
        ],
      },
    },
    { kind: "finale" },
  ];
}

function substitute(text: string, players: PlayerView[]): string {
  return text.replace(/\{P(\d+)\}/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    return players[idx]?.alias ?? `Player ${n}`;
  });
}

function autoAnswer(
  spec: RoundSpec | undefined,
  round: RoundView,
  you: PlayerId,
  players: PlayerView[]
): ResponseValue | null {
  const other = players.find((p) => p.id !== you)?.id ?? you;
  switch (round.kind) {
    case "pick":
      return { kind: "pick", target: other };
    case "text":
      return { kind: "text", text: "Skipped. Take that as an answer." };
    case "shout":
      return { kind: "shout", word: "chaos" };
    case "rating":
      return round.trait && round.about ? { kind: "rating", trait: round.trait, about: round.about, value: 6 } : null;
    case "ios":
      return round.about ? { kind: "ios", about: round.about, value: 4 } : null;
    case "minigame":
      return { kind: "minigame", score: 1 };
    case "dare":
      return { kind: "dare", status: "done" };
    case "pair_dare":
      return { kind: "dare", status: "done" };
    case "debrief":
      return { kind: "text", text: "We mostly talked about who is buying the next round." };
    case "spotlight":
      return { kind: "text", text: "Watching the door, honestly." };
    case "verdict":
      return { kind: "pick", target: other };
    case "confess":
      // A mock phone confesses about itself — never about anyone else.
      return { kind: "confess", yes: true, ...(spec ? { note: "Only in the demo." } : {}) };
    default:
      return spec ? null : null;
  }
}

function buildReveal(
  round: RoundView,
  spec: RoundSpec | undefined,
  mine: ResponseValue,
  players: PlayerView[],
  you: PlayerId
): RevealView {
  const name = (id: PlayerId) => players.find((p) => p.id === id)?.alias ?? "Player";
  if (round.kind === "spotlight") {
    // Captions stack, then the subject's own decoy line lands last.
    const subject = spec?.subject === you ? name(you) : name(spec?.subject ?? players[0]!.id);
    const captions = (spec?.botAnswers ?? [])
      .filter((b) => b.who !== spec?.subject)
      .map((b) => ({ alias: name(b.who), text: b.value.kind === "text" ? b.value.text : describe(b.value, name) }));
    if (spec?.subject !== you && mine.kind === "text") captions.push({ alias: name(you), text: mine.text });
    return { roundId: round.roundId, kind: "spotlight", summary: `Live on ${subject}`, subject,
      items: captions, ...(spec?.punchline ? { punchline: spec.punchline } : {}), holdMs: 8000 };
  }
  if (round.kind === "verdict") {
    const votes = new Map<PlayerId, number>();
    for (const b of spec?.botAnswers ?? []) if (b.value.kind === "pick") votes.set(b.value.target, (votes.get(b.value.target) ?? 0) + 1);
    if (mine.kind === "pick") votes.set(mine.target, (votes.get(mine.target) ?? 0) + 1);
    const total = [...votes.values()].reduce((a, b) => a + b, 0);
    const winner = [...votes].sort((a, b) => b[1] - a[1])[0];
    return {
      roundId: round.roundId,
      kind: "verdict",
      summary: winner ? `The room decided: ${name(winner[0])}` : "Nobody voted. The room argued for nothing.",
      celebrate: spec?.coding === "couple",
      holdMs: 8000,
      ...(winner ? { slide: { beat: "land" as const, flavor: "group" as const, title: name(winner[0]), body: `${winner[1]} of ${total} said it out loud.`, numbers: { votes: winner[1], of: total, share: winner[1] / total } } } : {}),
    };
  }
  if (round.kind === "confess") {
    // Same secrecy rules as the server: warm is counts only, spicy attributes
    // YES answers only, and a "no" is a number forever.
    const warm = round.phase === "warmup";
    const answers = [...(spec?.botAnswers ?? []), { who: you, value: mine }];
    const yes = answers.filter((a) => a.value.kind === "confess" && a.value.yes);
    const notes = answers.flatMap((a) => {
      if (a.value.kind !== "confess" || !a.value.note) return [];
      const attributable = !warm && a.value.yes;
      return [{ ...(attributable ? { alias: name(a.who) } : {}), text: a.value.note }];
    });
    return {
      roundId: round.roundId,
      kind: "confess",
      summary: warm ? `${yes.length} of ${answers.length} said yes.` : `${yes.length} of ${answers.length} said yes.`,
      holdMs: 4200,
      confess: {
        tier: warm ? "warm" : "spicy",
        yes: yes.length,
        no: answers.length - yes.length,
        of: answers.length,
        missing: 0,
        ...(warm ? {} : { attributed: yes.map((a) => ({ alias: name(a.who) })) }),
        ...(notes.length > 0 ? { notes } : {}),
      },
    };
  }
  const items = (spec?.botAnswers ?? []).map((b) => ({
    alias: name(b.who),
    text: describe(b.value, name),
  }));
  items.push({ alias: name(you), text: describe(mine, name) });

  const summary =
    round.kind === "shout"
      ? "“chaos” won the room — 2 of 4 said it."
      : round.kind === "dare"
        ? "Two dares done. One “I can't” — reason on the record."
        : round.kind === "pair_dare"
          ? "They came back quieter than they left."
          : round.kind === "debrief"
            ? "Two versions of the same five minutes. Only one of them is exact."
            : round.kind === "minigame"
              ? "Bot 1 wins tap war with 61."
              : "Everyone answered. Nothing gets deleted.";

  return { roundId: round.roundId, summary, items, holdMs: 4200 };
}

function describe(value: ResponseValue, name: (id: PlayerId) => string): string {
  switch (value.kind) {
    case "pick":
      return `→ ${name(value.target)}`;
    case "text":
      return `“${value.text}”`;
    case "shout":
      return `“${value.word}”`;
    case "rating":
      return `${value.trait} ${value.value}/10`;
    case "ios":
      return `${value.value}/7 circles`;
    case "minigame":
      return `${value.score} taps`;
    case "dare":
      return value.status === "passed" ? `passed — “${value.reason}”` : "did it";
    case "confess":
      return value.yes ? "said yes" : "said no";
    default:
      return "";
  }
}

function finaleSlides(players: PlayerView[]): FinaleSlide[] {
  const name = (i: number) => players[Math.min(i, players.length - 1)]?.alias ?? `Player ${i + 1}`;
  return [
    {
      beat: "tease",
      flavor: "claim",
      title: "Nine prompts. Nobody held back.",
      body: "Every answer became data. Here's what the night decided.",
    },
    {
      beat: "escalate",
      flavor: "group",
      title: "GROUP ANNOUNCEMENT",
      body: "Three of four phones picked the same person. Same prompt. No coordination.",
      numbers: { votes: 3, of: 4, share: 0.75 },
    },
    {
      beat: "land",
      flavor: "claim",
      title: `Besties: ${name(2)} & ${name(3)}`,
      body: "Same target on two different prompts. That's not a coincidence, that's a pattern.",
    },
    {
      beat: "land",
      flavor: "quote",
      title: "Quote of the night",
      body: `“my mother is watching” — ${name(1)}, refusing a dare`,
    },
    {
      beat: "land",
      flavor: "dodge",
      title: "Dodge report",
      body: "One dare passed. One reason recorded forever. Nobody is letting that go.",
    },
    {
      beat: "land",
      flavor: "claim",
      title: `Ship: ${name(0)} & ${name(1)}`,
      body: "Mutual picks, matching circles, and one suspiciously fast answer.",
      numbers: { score: 0.78, picks: 2 },
    },
    {
      beat: "tease",
      flavor: "claim",
      title: "Your secrets are your own",
      body: "What's left lives on your phone only. Hold a card to open it.",
    },
  ];
}

function secretCards(players: PlayerView[]): SecretCard[] {
  const name = (i: number) => players[Math.min(i, players.length - 1)]?.alias ?? `Player ${i + 1}`;
  // Fixed order: spark → onesided → blindspot → roomnote → stat (spec §7).
  return [
    {
      id: "s1",
      kind: "spark",
      title: "Spark",
      facts: [
        `You and ${name(1)} picked each other on the same prompt.`,
        "Both of you opted into secrets. Neither said it first.",
      ],
    },
    {
      id: "s2",
      kind: "onesided",
      title: "One-sided",
      facts: [
        `You picked ${name(2)} three times tonight.`,
        `${name(2)} picked you once — in the warmup, gently.`,
      ],
    },
    {
      id: "s3",
      kind: "stat",
      title: "Your night in numbers",
      facts: [
        "Fastest answer of the night: 3.1s.",
        "Dodges: 1, with a reason that will follow you.",
        "Circle average given: 4.6/7.",
      ],
    },
  ];
}
