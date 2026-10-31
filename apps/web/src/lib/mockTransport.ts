// src/lib/mockTransport.ts — an in-memory scripted night (development only).
//
// It mimics the v3.2 server closely enough to develop every screen without a
// running game server:
//   lobby → generating → play (one question at a time) → results → finale.
//
// The real server is the source of truth. This file never talks to a model.
import type {
  BeatView,
  FinaleSlide,
  FinaleView,
  JoinReply,
  JoinRequest,
  PlayerId,
  RoomCode,
  RoomView,
  RoundView,
  SecretDeckView,
  SubmitRequest,
} from "@shared/contracts.ts";
import type { Transport, TransportHandlers } from "./transport";

const CODE = "MOCK" as RoomCode;
/** The mock runs faster than the real night so screens can be rehearsed. */
const BOTS_ANSWER_MS = 200;
const BEAT_MS = 600;
const BOT_ALIASES = ["Dee", "Kofi", "Zuri", "Tayo"];

/** The questions the mock asks, in order. */
const QUESTIONS: { kind: RoundView["kind"]; text: string; note: string }[] = [
  { kind: "pick", text: "Who in this room would you take home from this party?", note: "About the room. They won't see this." },
  { kind: "text", text: "What is the most obviously fake thing about you?", note: "Your answer stays between you and the results." },
  { kind: "pick", text: "Who do you think has the highest body count in here?", note: "About the room. They won't see this." },
  { kind: "rating", text: "How chaotic are you, 1 to 10?", note: "Your answer stays between you and the results." },
  { kind: "text", text: "What would you do if you found out someone you like liked you back?", note: "Your answer stays between you and the results." },
  { kind: "pick", text: "Who would you wreck in bed?", note: "About the room. They won't see this." },
];

const SLIDES: FinaleSlide[] = [
  { beat: "tease", flavor: "claim", title: "Player 1 and Player 3", body: "You two are not subtle." },
  { beat: "escalate", flavor: "claim", title: "Three people picked the same person", body: "And she had no idea." },
  { beat: "land", flavor: "claim", title: "Player 2 and Player 5 would lowkey be a good couple", body: "83% said yes." },
  { beat: "land", flavor: "stat", title: "the room's honesty rating", body: "Not one of you told the truth.", numbers: { votes: 4 } },
];

export class MockTransport implements Transport {
  readonly mode = "mock" as const;

  private handlers: TransportHandlers = {};
  private phase: RoomView["phase"] = "lobby";
  private players: { id: PlayerId; alias: string; ready: boolean }[] = [];
  private you: PlayerId | null = null;
  private seq = 0;
  private questionIndex = 0;
  private generationTimer: ReturnType<typeof setTimeout> | null = null;
  private caseTimer: ReturnType<typeof setTimeout> | null = null;
  private submitted = false;
  private deleted = false;

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  private view(): RoomView {
    this.seq += 1;
    return {
      code: CODE,
      phase: this.phase,
      players: this.players.map((p) => ({ id: p.id, alias: p.alias, connected: true, isBot: p.id !== this.you, ready: p.ready })),
      round: null,
      seq: this.seq,
      hostPresent: true,
      lobbyReady: this.players.filter((p) => p.ready).map((p) => p.id),
      progress: { index: this.questionIndex, total: QUESTIONS.length },
      ...(this.phase === "generating" ? { generation: { done: this.questionIndex * 8, total: 40 } } : {}),
      ...(this.phase === "results" ? { ready: this.players.map((p) => p.id) } : {}),
    };
  }

  private push(): void {
    if (this.deleted) return;
    this.handlers.onState?.(this.view());
  }

  async join(req: JoinRequest): Promise<JoinReply> {
    this.deleted = false;
    const id = "p1-mock";
    this.you = id;
    this.players = [{ id, alias: req.alias, ready: true }];
    BOT_ALIASES.forEach((alias, index) => {
      this.players.push({ id: `p${index + 2}-mock`, alias, ready: index < 2 });
    });
    this.push();
    return { ok: true, you: id, secret: "mock-secret", state: this.view() };
  }

  async hostJoin(token: string): Promise<{ ok: boolean; error?: string }> {
    if (!token) return { ok: false, error: "That host link is not valid." };
    this.push();
    return { ok: true };
  }

  async submit(req: SubmitRequest): Promise<{ ok: boolean; error?: string }> {
    if (this.submitted) return { ok: false, error: "Already answered." };
    this.submitted = true;
    // The bots answer a beat later, then the case closes.
    this.caseTimer = setTimeout(() => {
      if (this.deleted) return;
      this.handlers.onBeat?.({ label: "Locked in.", holdMs: 1500 } satisfies BeatView);
      this.caseTimer = setTimeout(() => {
        if (this.deleted) return;
        this.nextCase();
      }, BEAT_MS);
    }, BOTS_ANSWER_MS);
    return { ok: true };
  }

  private nextCase(): void {
    this.questionIndex += 1;
    if (this.questionIndex >= QUESTIONS.length) {
      this.phase = "results";
      this.push();
      return;
    }
    this.phase = "play";
    this.submitted = false;
    const q = QUESTIONS[this.questionIndex]!;
    const round: RoundView = {
      roundId: `mock-case-${this.questionIndex}`,
      segmentId: `mock-case-${this.questionIndex}-you`,
      index: this.questionIndex + 1,
      kind: q.kind,
      promptText: q.text,
      note: q.note,
      closesAt: Date.now() + 30_000,
      youSubmitted: false,
      pair: undefined,
      options: undefined,
      target: undefined,
      trait: q.kind === "rating" ? "chaos" : undefined,
      aboutSelf: q.kind === "rating",
      submitted: [],
    };
    this.push();
    this.handlers.onRound?.(round);
  }

  lobbyReady(ready: boolean): void {
    const player = this.players.find((p) => p.id === this.you);
    if (player) player.ready = ready;
    this.push();
  }

  ready(): void {
    if (this.phase !== "results") return;
    const finale: FinaleView = {
      slides: SLIDES,
      summary: { couple: "Player 2 × Player 5", core: "Player 1 & Player 3", hates: "Player 4" },
    };
    this.handlers.onFinale?.(finale);
    const deck: SecretDeckView = {
      cards: [
        { id: "crush", kind: "crush", title: "Mutual crush", facts: ["You and Player 3 like each other."] },
      ],
    };
    this.handlers.onSecrets?.(deck);
  }

  start(): void {
    if (this.phase !== "lobby") return;
    this.phase = "generating";
    this.push();
    // The safety cap means the night always starts.
    this.generationTimer = setTimeout(() => {
      this.phase = "play";
      this.questionIndex = 0;
      this.push();
      this.nextCase();
    }, 900);
  }

  forceResults(): void {
    if (this.phase !== "play" && this.phase !== "results") return;
    this.phase = "results";
    this.push();
  }

  addBot(): void {
    if (this.players.length >= 10) return;
    this.players.push({ id: `p${this.players.length + 1}-bot`, alias: `Bot ${this.players.length}`, ready: true });
    this.push();
  }

  skipRound(): void {
    this.questionIndex += 1;
    if (this.questionIndex >= QUESTIONS.length) {
      this.phase = "results";
      this.push();
      return;
    }
    this.submitted = false;
    this.nextCase();
  }

  deleteRoom(): void {
    // Cancelling the room cancels every pending timer: no late state, no
    // late deck, nothing after the delete.
    this.deleted = true;
    if (this.generationTimer) clearTimeout(this.generationTimer);
    if (this.caseTimer) clearTimeout(this.caseTimer);
    this.generationTimer = null;
    this.caseTimer = null;
    this.handlers.onDeleted?.();
  }

  resume(): void {
    this.push();
  }

  forgetSession(): void {
    this.you = null;
    this.players = [];
    this.phase = "lobby";
    this.push();
  }

  disconnect(): void {
    if (this.generationTimer) clearTimeout(this.generationTimer);
    if (this.caseTimer) clearTimeout(this.caseTimer);
    this.generationTimer = null;
    this.caseTimer = null;
  }
}
