// packages/shared/src/contracts.ts
// SINGLE SOURCE OF TRUTH — brief v3.2.
//
// The game is a spicy party game for 4–11 friends, one phone each. Every
// question is ABOUT people in the room, and every answer feeds a verdict or a
// secret card. There is no quiz, no phase machinery and no per-round reveal:
// one night is a flat sequence of CASES, one ready gate at the end, and a
// reveal on the host laptop.
//
// Vocabulary used throughout:
//   CASE   one round. It is about ONE subject and is played at the same time
//          in three groups: observer PAIRS (each pair gets a different
//          question), the SUBJECT (a real question of their own) and, when the
//          observer count is odd, one SOLO player with a spicy prompt.
//   SEGMENT one question inside a case, shown to the players who answer it.
//          A player is in exactly one segment per case.
//   BAND   an internal generation bucket (warmup / spicy / deep / dare).
//          Bands are NOT phases: the night is shuffled, and no band name is
//          ever shown to a player.
//
// PSEUDONYM DISCIPLINE (unchanged): prompts are authored with {P1}..{P11}
// placeholders and real names are substituted server-side at display time.

export type PlayerId = string; // server-generated opaque id, e.g. "p3". NEVER "self".
export type RoomCode = string; // 4 chars from ROOM_CODE_ALPHABET

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const ROOM_CODE_LENGTH = 4;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 11;
export const RETENTION_HOURS = 48;  // rooms hard-deleted after this
export const IDLE_TTL_HOURS = 24;   // abandoned lobbies die after this
export const AGE_MIN = 18;

/**
 * Ollama wiring (env). The local model is the ONLY generator — it writes the
 * night's questions, dares and one-line verdicts.
 */
export const OLLAMA = {
    baseUrl: "http://127.0.0.1:11434",
    model: "dolphin-mistral",
    path: "/api/chat",
} as const;
export const MAX_PROMPT_CHARS = 160;

// ---------- Phases (player-facing only) ----------
// lobby → generating → play → results → closed
export type Phase = "lobby" | "generating" | "play" | "results" | "closed";

// ---------- Heat bands (internal generation buckets, never shown) ----------
export type Band = "warmup" | "spicy" | "deep" | "dare";
// Spicy first: if generation times out, the most important prompts already exist.
export const BAND_ORDER: readonly Band[] = ["spicy", "warmup", "deep", "dare"];

// ---------- Round kinds & answer kinds ----------
export type RoundKind =
  | "pick"         // choose ONE person in the room (forced, never yourself)
  | "text"         // short written answer (<= 140 chars)
  | "longtext"     // long written answer (<= 280 chars)
  | "rating"       // 1..10 rating of yourself or someone in the room
  | "dare"         // do it, or "I can't" plus a required reason
  | "pair_vote"    // vote on a proposed pair (yes / no)
  | "pair_pick";   // choose one pair from a list of pairs

export const ROUND_KINDS: readonly RoundKind[] = [
  "pick", "text", "longtext", "rating", "dare", "pair_vote", "pair_pick",
];

export type PromptCoding =
  | "couple" | "friendship" | "trust" | "friction" | "tease" | "rivalry" | "status" | "neutral";

/**
 * The role a prompt plays inside a case. It decides WHO answers it and which
 * names get substituted into its {P1}/{P2} slots.
 */
export type PromptRole =
  | "subject"          // asked to the subject, about themselves or their own view
  | "observer_subject" // asked to an observer pair, about the case subject
  | "observer_pair"    // asked to an observer pair, about ANOTHER pair in the room
  | "group"            // asked to everyone; results are counts only
  | "solo"             // the odd leftover observer gets a spicy prompt of their own
  | "dare";            // aimed at a named player

export const PROMPT_ROLES: readonly PromptRole[] = [
  "subject", "observer_subject", "observer_pair", "group", "solo", "dare",
];

// ---------- Metrics: what a prompt actually measures ----------
// The engine keys off these; the prompts carry them in `measures` as
// "metric:<key>" so a verdict can always point at the data behind it.
export const METRIC = {
  /** "who would you have sex with" — feeds the percent lines. */
  sexDesire: "sex-desire",
  /** "who has the highest body count here" */
  bodyCount: "body-count",
  /** "who is the best in bed here" */
  bestInBed: "best-in-bed",
  /** "who would snitch" */
  wouldSnitch: "would-snitch",
  /** "who would cheat" */
  wouldCheat: "would-cheat",
  /** "who is fake" */
  isFake: "is-fake",
  /** "who is the weirdest" */
  weirdest: "weirdest",
  /** "who is going to fall apart tonight" */
  crier: "crier",
  /** "who is the most dangerous" */
  mostDangerous: "most-dangerous",
  /** "who would you ruin a friendship for" */
  ruinFriendship: "ruin-friendship",
  /** "who has a crush on someone here" */
  crush: "crush",
  /** "who would make a good couple" */
  coupleFit: "couple-fit",
  /** "who is closest to you" */
  closest: "closest",
  /** "who do you trust" */
  trust: "trust",
  /** "who is the biggest liar" */
  liar: "liar",
  /** "who has the most money / spends the most" */
  money: "money",
  /** "who would betray the group" */
  betrayal: "betrayal",
  /** "who has the weirdest secret" */
  secret: "secret",
  /** "who is your ex" */
  ex: "ex",
  /** "who hooks up the most" */
  hookups: "hookups",
  /** A HYPOTHETICAL question about a pair. Never an orientation claim. */
  gayHypothetical: "gay-hypothetical",
  /** A look chain: the actor's own (hidden) choice. */
  lookchain: "lookchain",
  /** A look chain: somebody's guess at who the actor is looking at. */
  lookchainGuess: "lookchain-guess",
} as const;

export type MetricKey = (typeof METRIC)[keyof typeof METRIC];

export interface Prompt {
  id: string;
  source: "bank" | "host" | "ollama";
  band: Band;
  role: PromptRole;
  kind: RoundKind;
  text: string;              // {P1}..{P11} placeholders, substituted server-side for display ONLY
  measures: string[];        // signal names, "metric:<key>" first when it measures a verdict
  coding: PromptCoding;
  asksTarget: boolean;
}

// ---------- Responses & log ----------
export type TraitId = "loyalty" | "chaos" | "reliability" | "warmth" | "honesty" | "spice";
export const TRAITS: TraitId[] = ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"];

export type ResponseValue =
  | { kind: "pick"; target: PlayerId }                                  // != self, always
  | { kind: "pair_pick"; pair: [PlayerId, PlayerId] }                    // one of the offered pairs
  | { kind: "pair_vote"; pair: [PlayerId, PlayerId]; value: number }     // 1..5; >=4 counts as yes
  | { kind: "text"; text: string }                                       // <= 280 chars
  | { kind: "rating"; trait: TraitId; about: "self" | PlayerId; value: number } // 1..10
  | { kind: "dare"; status: "done" | "passed"; reason?: string };        // reason REQUIRED iff passed, <=140

export const TEXT_MAX_CHARS = 280;
export const SHORT_TEXT_MAX_CHARS = 140;
export const DARE_REASON_MAX_CHARS = 140;

export interface LogRecord {
    roomId: string;
    roundId: string;
    playerId: PlayerId;
    roundKind: RoundKind;
    promptId: string;
    coding: PromptCoding;        // denormalized from the Prompt so the engine needs no bank lookup
    value: ResponseValue;
    at: number;                  // epoch ms
    latencyMs: number;           // round open -> submit. Night-Digest fuel.
    /** Which segment of the case this answer belongs to. */
    segmentId?: string | undefined;
    /** The band the prompt came from (internal). */
    band?: Band | undefined;
    /** The metric this prompt measures, when it measures one. */
    metric?: MetricKey | undefined;
    /** The case subject, when the case had one. */
    subjectId?: PlayerId | undefined;
}

// ---------- Sign-up profile ----------
// Engine-needed only. NEVER printed on any screen, never compared against the
// room's guesses, never sent to a client, never sent to a model. The ONLY thing
// the engine does with a profile is the 18+ gate: the age decides whether the
// night happens at all. Nothing else is asked, because nothing else is used —
// there is no 'what are you here for tonight' question, no relationship history,
// no vibe check. A guess the room makes about somebody must never be traceable
// to what they typed at sign-up. The raw values die with the room.
export type Gender = "woman" | "man" | "nonbinary" | "other" | "undisclosed";
export type Sexuality = "straight" | "gay" | "bi" | "pan" | "queer" | "asexual" | "other" | "undisclosed";
export type Attraction = "women" | "men" | "everyone" | "nobody" | "undisclosed";

export interface ProfileAnswers {
    age: number;
    gender: Gender;
    sexuality: Sexuality;
    attractedTo: Attraction;
}

export const PROFILE_QUESTIONS = [
    { field: "age", label: "How old are you?", kind: "number" },
    { field: "gender", label: "Gender", kind: "select", options: ["woman", "man", "nonbinary", "other", "undisclosed"] },
    { field: "sexuality", label: "Sexuality", kind: "select", options: ["straight", "gay", "bi", "pan", "queer", "asexual", "other", "undisclosed"] },
    { field: "attractedTo", label: "Who are you attracted to?", kind: "select", options: ["women", "men", "everyone", "nobody", "undisclosed"] },
] as const;

// ---------- Engine: room metadata ----------
/** The engine's view of a room: who is in it, in order. No profile answers. */
export interface PlayerMeta { id: PlayerId; alias: string; }
export interface RoomMeta { roomId: string; players: PlayerMeta[]; }

// ---------- Engine: pair signals ----------
export interface PairSignal {
    room: string;
    a: PlayerId;                 // convention: a < b
    b: PlayerId;
    pickOverlap: number;         // 0..1
    mutualPick: number;          // 0..1
    componentsUsed: ("pickOverlap" | "mutualPick" | "traitAgreement")[];
    traitAgreement: number;      // 0..1
    pairScore: number;           // weighted, 0..1
    coupleEvidence: number;      // 0..1
    friendEvidence: number;      // 0..1
    negativeMutual: number;      // 0..1
}

// ---------- Engine: verdicts ----------
// The ONLY things the reveal is allowed to say. Every verdict is backed by
// data; if the data is weak the verdict does not exist.
export type VerdictKind =
  | "hates"        // "The group lowkey hates on X."
  | "core"         // "X and Y are the core of this group."
  | "couple"       // "A and B would lowkey be a good couple (80% said yes)."
  | "sex"          // "C and E should just have sex."
  | "percent"      // "30% of people here want to have sex with X."
  | "gaycouple"    // "If X and Y were gay they'd be a good couple."
  | "bodycount"    // "The room thinks X has the highest body count."
  | "bestinbed"    // "The room thinks X is the best in bed here."
  | "besties"      // "X and Y are inseparable."
  | "rivals"       // "X and Y cannot be in the same room."
  | "freeagent"    // "Nobody in this room is claiming X."
  | "blindspot";   // "X thinks they're 9/10 loyal, the room said 4."

export type VerdictTone = "mild" | "spicy" | "filthy";

export interface Verdict {
    id: string;
    kind: VerdictKind;
    subjects: PlayerId[];        // 1 for solo verdicts, 2 for pair verdicts
    tone: VerdictTone;
    /** The one-line verdict text, written from a template picked by data strength. */
    text: string;
    /** The numbers behind it — never invented, always derived from the log. */
    numbers: Record<string, number>;
    /** Strength of the underlying data (0..1). Templates are picked from this. */
    strength: number;
}

export interface Results {
    roomId: string;
    verdicts: Verdict[];
    pairScores: PairSignal[];
    freeAgent?: PlayerId | undefined;
    computedAt: number;
}

// ---------- Night Digest (data-milking layer) ----------
export interface DigestQuote { alias: string; text: string; context: string; }

export interface DigestStats {
    fastest?: { alias: string; ms: number };      // quickest finger tonight
    slowest?: { alias: string; ms: number };      // took the FULL timer on a feelings round
    topDodger?: { alias: string; count: number }; // most "I can't"s
}

export interface DigestLookChain {
    /** The id of the player who was looking. */
    actorId: PlayerId;
    /** The id of the player they were looking at. */
    targetId: PlayerId;
    /** The alias of the player who was looking. */
    actor: string;
    /** The alias they were looking at — the truth, only revealed at the end. */
    target: string;
    /** How many people guessed right. */
    guessedRight: number;
    /** How many people guessed at all. */
    guessers: number;
    /** The actor's own reason. */
    reason?: string | undefined;
}

export interface NightDigest {
    quotes: DigestQuote[];                          // <=12, verbatim, best material
    stats: DigestStats;
    runningGags: { word: string; count: number }[]; // shout words that keep winning
    pickTeasers: string[];                          // engine-written, no finale spoilers
    dodges: { alias: string; reason: string }[];    // verbatim excuses
    selfVsRoom: { alias: string; trait: TraitId; self: number; roomMean: number }[];
    /** The look chains played tonight — revealed only at the end. */
    lookChains?: DigestLookChain[] | undefined;
}

// ---------- Views ----------
export interface PlayerView { id: PlayerId; alias: string; connected: boolean; isBot: boolean; /** Lobby ready tick. */ ready: boolean; }

/** One question, shown to ONE player. Aliases are already substituted. */
export interface RoundView {
    roundId: string;
    segmentId: string;
    index: number;               // 1-based case number within the night
    kind: RoundKind;
    promptText: string;          // this player's question, aliases substituted
    /** The small grey line under the question: who it is about and who can see it. */
    note: string;
    closesAt: number;            // epoch ms — the CAP, not the pace
    youSubmitted: boolean;
    /** The pair being voted on (pair_vote rounds). */
    pair?: [PlayerId, PlayerId] | undefined;
    /** The candidate pairs to choose from (pair_pick rounds). */
    options?: { id: string; members: [PlayerId, PlayerId]; label: string }[] | undefined;
    /** The named player a dare is aimed at. */
    target?: PlayerId | undefined;
    /** The trait a rating is about. */
    trait?: TraitId | undefined;
    /** Whether the rating is about yourself. */
    aboutSelf?: boolean | undefined;
    /** Who the question is about — the case subject. */
    subjectId?: PlayerId | undefined;
    submitted?: PlayerId[] | undefined;
    /**
     * The look-chain stage: 1 = look, 2 = guess, 3 = why.
     * Undefined for an ordinary case.
     */
    stage?: number | undefined;
    /**
     * True when this phone only WATCHES. There is no answer to give — the
     * phone shows the line and waits.
     */
    passive?: boolean | undefined;
    /** Whose look it is, on a look chain. */
    chainActor?: PlayerId | undefined;
    /**
     * True when the answer stays hidden until the reveal. The room never sees
     * it during the night.
     */
    hidden?: boolean | undefined;
}

export interface RoomView {    // PUBLIC — contains nothing private
    code: RoomCode;
    phase: Phase;
    players: PlayerView[];
    round: RoundView | null;
    seq: number;
    /** The host laptop is connected. */
    hostPresent?: boolean | undefined;
    /** Present ONLY during the single end-of-night ready gate. */
    ready?: PlayerId[] | undefined;
    /** Lobby ready ticks — who has pressed "I'm ready" in the lobby. */
    lobbyReady?: PlayerId[] | undefined;
    /**
     * The players THIS player may pick — never themselves. Present only on a
     * player's own view; the laptop never answers, so it has no pick list.
     */
    pickOptions?: PlayerId[] | undefined;
    /** Case progress: how many cases are done and how many are coming. */
    progress?: { index: number; total: number } | undefined;
    /** Generation progress, shown on the loading screen. */
    generation?: { done: number; total: number } | undefined;
    /**
     * The public one-liner for the case that is open — the look chain's
     * "Everybody look at X." The laptop shows it; it is never private.
     */
    headline?: string | undefined;
}

/** The 1–2 second beat between cases. */
export interface BeatView {
    label: string;
    holdMs: number;
    /** The case this beat closes (absent for room-wide beats). */
    roundId?: string | undefined;
}

// ---------- Secret decks (private cards — ONE phone only) ----------
// Private material NEVER rides the broadcast `finale`. Each player with
// private material gets a personal deck via the `secrets` event, emitted only
// on their socket. Cards are face-down and HOLD-TO-REVEAL.
//
// There is exactly ONE crush card and it exists only for a MUTUAL pick:
// "You and X like each other." Nobody is ever told about a one-sided crush,
// who picked them, or that someone did not pick them back.
export type SecretKind = "crush" | "blindspot" | "lookchain";

export interface SecretCard {
    id: string;
    kind: SecretKind;
    title: string;               // pseudonym copy; server swaps "Player N" -> alias
    facts: string[];             // 1-4 short lines; numbers ONLY from engine verdicts/digest
}

export interface SecretDeckView {
    cards: SecretCard[];         // <= SECRET_DECK_MAX
}

export const SECRET_DECK_MAX = 6;    // cards per player, per night
export const SECRET_HOLD_MS = 400;   // press-and-hold ramp before a card opens

// ---------- Finale (host laptop) ----------
export type SlideBeat = "tease" | "escalate" | "land";

export interface FinaleSlide {
    beat: SlideBeat;
    flavor?: "claim" | "quote" | "stat" | "dodge" | "group";
    title: string;               // pseudonym copy ("Player 3"); server swaps aliases after narration
    body?: string;
    numbers?: Record<string, number>;
}

export interface FinaleView {  // BROADCAST-SAFE — public slides only, identical on every laptop
    slides: FinaleSlide[];
    summary: { couple?: string; core?: string; hates?: string; };
}

// ---------- Socket contract ----------
export interface Consent { age: boolean; terms: boolean; }

export interface JoinRequest {
    roomCode: RoomCode;
    alias: string;               // 2-14 chars
    consent: Consent;            // age must be true (18+)
    profile: ProfileAnswers;
    resume?: { playerId: PlayerId; secret: string };
}

export interface JoinReply {
    ok: boolean;
    you?: PlayerId;
    secret?: string;             // store in sessionStorage for reconnect
    state?: RoomView;
    error?: string;
}

export interface SubmitRequest { roundId: string; segmentId?: string; clientUuid: string; value: ResponseValue; }

export type ClientToServerEvents = {
    join: (p: JoinRequest, reply: (r: JoinReply) => void) => void;
    /** The host laptop binds to tonight's room with its token — no code to type. */
    host_join: (p: { token: string }, reply: (r: { ok: boolean; state?: RoomView; error?: string }) => void) => void;
    submit: (p: SubmitRequest, reply: (r: { ok: boolean; error?: string }) => void) => void;
    /** The lobby tick: "I'm in". */
    lobby_ready: (p: { ready: boolean }) => void;
    /** "Ready for the results" — the ONE ready gate, at the end of the night. */
    ready: () => void;
    start: () => void;                                   // host laptop only
    force_results: () => void;                           // host laptop only — skip the ready gate
    add_bot: () => void;                                 // host laptop only (fill seats / solo test)
    skip_round: () => void;                              // host laptop only
    delete_room: () => void;                             // ANY player
};

export type ServerToClientEvents = {
    state: (p: RoomView) => void;
    round: (p: RoundView) => void;
    beat: (p: BeatView) => void;
    finale: (p: FinaleView) => void;          // broadcast-safe: public slides only
    secrets: (p: SecretDeckView) => void;     // ONLY the owning player's socket — NEVER broadcast
    deleted: () => void;
    error: (p: { code: string; message: string }) => void;
};

// ---------- Tunables (config, not logic) ----------
export const DEFAULT_WEIGHTS = {
    pickOverlap: 0.45,
    mutualPick: 0.30,
    traitAgreement: 0.25,
} as const;

export const CONFIDENCE_RULES = {
    high: { independentSignals: 3, consensusShare: 0.70 },
    med: { independentSignals: 2, consensusShare: 0.55 },
} as const;

/** The provider cap for one night (both lanes share one ledger). */
export const MAX_PROVIDER_CALLS_PER_NIGHT = 8;

/**
 * The provider lanes. Ollama is the ONLY generator — it writes the night's
 * questions and dares. Gemini arranges the data (analysis only).
 */
export const PROVIDERS = {
    ollama: {
        baseUrl: OLLAMA.baseUrl,
        model: OLLAMA.model,
    },
    gemini: {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        tagModel: "gemini-2.5-flash",
        analyzeModel: "gemini-2.5-flash",
    },
} as const;

/** Gemini model resolution — env override wins, contract default otherwise. */
export function resolveGeminiModel(envModel?: string | undefined): string {
    const trimmed = typeof envModel === "string" ? envModel.trim() : "";
    return trimmed.length > 0 ? trimmed : PROVIDERS.gemini.analyzeModel;
}

/** Gemini safety thresholds — the game is adult consensual content by design. */
export const SAFETY_OFF = [
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
] as const;

/** Confidence levels for a data-backed claim. */
export type Confidence = "high" | "med" | "low";

/**
 * TIMING. A case ends the instant the last required person answers; the timer
 * is only a CAP. A player who runs out of time is skipped and the game
 * continues.
 */
export const ROUND_TIMERS_MS: Record<RoundKind, number> = {
    pick: 30_000,
    text: 45_000,
    longtext: 75_000,
    rating: 20_000,
    dare: 90_000,
    pair_vote: 30_000,
    pair_pick: 30_000,
};

/** The 1-2s "locked in" beat between cases. */
export const BEAT_HOLD_MS = 1_500;

/** How many cases a night runs. */
export const CASES_PER_NIGHT = 12;
/** Ship-vote cases (random pairs) inside a night. */
export const SHIP_VOTE_CASES = 3;
/** Dares scattered through the night. */
export const DARE_CASES = 2;
/** Look chains scattered through the night (6-8, depending on the room). */
export const LOOK_CHAIN_CASES = 6;
export const LOOK_CHAIN_CASES_MAX = 8;

/** The single ready gate at the end of the night. */
export const READY_GATE_GRACE_MS = 30_000;

/** Generation: the local model needs minutes, not seconds. */
export const GEN_TIMEOUT_MS = 120_000;      // per batch
export const GEN_SAFETY_CAP_MS = 180_000;   // whole generation; after this we start anyway
export const GEN_TARGET_PROMPTS = 40;       // "14/40 ready" on the loading screen

export const pseudonym = (index: number) => `Player ${index + 1}`; // ONLY this ever leaves the server
