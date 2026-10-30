// packages/shared/src/contracts.ts
// SINGLE SOURCE OF TRUTH. Agents A–G never edit this file.
// Change requests go to NOTES/contract-requests.md; Agent Z resolves them.

// ---------- Identity & rooms ----------
export type PlayerId = string; // server-generated opaque id, e.g. "p3". NEVER the literal "self".
export type RoomCode = string; // 4 chars from ROOM_CODE_ALPHABET

export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const ROOM_CODE_LENGTH = 4;
export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 11;
export const RETENTION_HOURS = 48;  // rooms hard-deleted after this
export const IDLE_TTL_HOURS = 24;   // abandoned lobbies die after this
export const AGE_MIN = 18;
export const SPICY_TIER = true;     // include unhinged-tier bank prompts (private adult group)

// ---------- Phases & rounds ----------
export type Phase =
| "lobby" | "warmup" | "spicy" | "deep" | "dare" | "debrief"
| "interlude" | "finale" | "closed";

export const HEAT_ORDER = ["warmup", "spicy", "deep", "dare"] as const;

export type RoundKind =
| "pick" | "text" | "shout" | "rating" | "ios"
| "minigame" | "dare" | "pair_dare" | "debrief"
// Live moments (ROUND 3). Both are group-theatre rounds, not more questions:
//   spotlight — everyone EXCEPT one subject answers a question about the live
//               moment; the subject gets a DECOY round and never sees it.
//   verdict   — open discussion for VERDICT_DISCUSS_MS, then a simultaneous
//               secret pick; the reveal is a Group Announcement mini-finale.
| "spotlight" | "verdict";

export type PromptCoding =
| "couple" | "friendship" | "trust" | "friction" | "rivalry" | "status" | "neutral";

export interface Prompt {
    id: string;
    source: "bank" | "host" | "grok" | "gemini";
    phase: "warmup" | "spicy" | "deep" | "dare";
    kind: RoundKind;
    text: string;                // {P1}..{P11} placeholders, substituted server-side for display ONLY
    measures: string[];
    coding: PromptCoding;
    asksTarget: boolean;
}

// ---------- Responses & log ----------
export type TraitId = "loyalty" | "chaos" | "reliability" | "warmth" | "honesty" | "spice";
export const TRAITS: TraitId[] = ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"];

export type ResponseValue =
| { kind: "pick"; target: PlayerId }                                  // ≠ self
| { kind: "text"; text: string }                                      // ≤280 chars
| { kind: "shout"; word: string }                                     // ≤24 chars
| { kind: "rating"; trait: TraitId; about: "self"; value: number }    // 1..10
| { kind: "rating"; trait: TraitId; about: PlayerId; value: number }  // 1..10, ≠ self
| { kind: "ios"; about: PlayerId; value: number }                     // 1..7, ≠ self
| { kind: "minigame"; score: number }
| { kind: "dare"; status: "done" | "passed"; reason?: string };       // reason REQUIRED iff passed, ≤140

export interface LogRecord {
    roomId: string;
    roundId: string;
    playerId: PlayerId;
    roundKind: RoundKind;
    promptId: string;
    coding: PromptCoding;        // denormalized from the Prompt so the engine needs no bank lookup
    value: ResponseValue;
    at: number;                  // epoch ms
    latencyMs: number;           // round open → submit. Night-Digest fuel.
    /** Spotlight decoy answer: the subject's throwaway reply to the cover
     *  round. EXCLUDED from every signal, score and claim (data-or-dead does
     *  not apply — it answers nothing). It is digest gold only: it pairs with
     *  the captions ("While the room captioned X, X wrote: …") and lands last
     *  in the caption-wall reveal. */
    decoy?: boolean;
}

export interface RoomMeta {
    roomId: string;
    players: { id: PlayerId; alias: string }[];
    revealOptIn: PlayerId[];     // consented to private spark / one-sided / secret cards
}

// ---------- Engine: pair signals ----------
export interface PairSignal {
    room: string;
    a: PlayerId;                 // convention: a < b
    b: PlayerId;
    pickOverlap: number;         // 0..1
    mutualPick: number;          // 0..1
    debriefSim: number;          // 0..1 (0.5 = unknown)
    iosMean: number;             // 0..1
    traitAgreement: number;      // 0..1
    pairScore: number;           // weighted, 0..1
    coupleEvidence: number;      // 0..1
    friendEvidence: number;      // 0..1
    negativeMutual: number;      // 0..1
}

// ---------- Engine: claims & results ----------
export type ClaimType =
| "ship" | "besties" | "toxic" | "rival" | "blindspot"
| "onesided" | "consensus" | "spark";
export type Audience = "public" | "private";
export type Confidence = "low" | "med" | "high";

export interface Claim {
    id: string;
    type: ClaimType;
    subjects: PlayerId[];            // 1 for solo awards, 2 for pairs
    audience: Audience;              // onesided + spark are ALWAYS private (→ Secret Cards)
    confidence: Confidence;
    evidence: string[];              // engine-written; the narrator quotes these
    numbers?: Record<string, number>;
}

export interface Results {
    roomId: string;
    claims: Claim[];
    pairScores: PairSignal[];
    freeAgent?: PlayerId;            // odd-n leftover from matching
    computedAt: number;
}

// ---------- Night Digest (data-milking layer) ----------
export interface DigestQuote { alias: string; text: string; context: string; }

export interface DigestStats {
    fastest?: { alias: string; ms: number };      // quickest finger tonight
    slowest?: { alias: string; ms: number };      // took the FULL 90s on feelings
    topDodger?: { alias: string; count: number }; // most "I can't"s
    tapWar?: { alias: string; score: number };    // minigame champion
}

export interface NightDigest {
    quotes: DigestQuote[];                          // ≤12, verbatim, best material
    stats: DigestStats;
    runningGags: { word: string; count: number }[]; // shout words that keep winning
    pickTeasers: string[];                          // engine-written, no finale spoilers
    dodges: { alias: string; reason: string }[];    // verbatim excuses
    selfVsRoom: { alias: string; trait: TraitId; self: number; roomMean: number }[];
}

// ---------- Views ----------
export interface PlayerView { id: PlayerId; alias: string; connected: boolean; isBot: boolean; }

export interface RoundView {
    roundId: string;
    index: number;               // 1-based within the night
    phase: Phase;
    kind: RoundKind;
    promptText: string;          // aliases already substituted
    closesAt: number;            // epoch ms
    youSubmitted: boolean;
    onlyPlayers?: PlayerId[];    // pair_dare/debrief rounds; everyone else watches
    /** verdict rounds: open discussion until this epoch ms, then the secret
     *  simultaneous pick opens (closesAt = voteOpensAt + VERDICT_VOTE_MS). */
    voteOpensAt?: number;
    /** false for the spotlight subject's IDLE cover screen — the phone waits
     *  the round out without offering an input. Absent means "answer me". */
    expectsAnswer?: boolean;
}

export interface RoomView {    // PUBLIC — contains nothing private
    code: RoomCode;
    phase: Phase;
    hostId: PlayerId;            // host = creator: start/skip/add_bot/custom_prompts
    players: PlayerView[];
    round: RoundView | null;
    seq: number;
}

export interface InterludeView {
    headline: string;
    sub: string;
    teaser?: string;             // Night-Digest data drop
    holdMs: number;
}

export interface RevealItem { alias: string; text: string; }
export interface RevealView {
    roundId: string;
    summary: string;
    items?: RevealItem[];        // text answers, shout winner, dare outcomes…
    holdMs: number;
    /** Present for live moments so the phone can render the specialised
     *  reveal instead of the generic list. */
    kind?: RoundKind;
    /** spotlight: the alias being watched — the caption wall's header. The
     *  question itself is NEVER part of the reveal payload. */
    subject?: string;
    /** spotlight: the subject's decoy answer. It lands LAST and biggest. */
    punchline?: string;
    /** verdict: the Group Announcement mini-finale (anonymous bars, count-up,
     *  then the room's answer lands). Numbers are counts only. */
    slide?: FinaleSlide;
    /** verdict: couple-coded prompts get confetti on the land beat. */
    celebrate?: boolean;
}

export type SlideBeat = "tease" | "escalate" | "land";

export interface FinaleSlide {
    beat: SlideBeat;
    flavor?: "claim" | "quote" | "stat" | "dodge" | "group";  // "group" → Group Announcement treatment
    claimId?: string;
    title: string;               // pseudonym copy ("Player 3"); server swaps aliases after narration
    body?: string;
    numbers?: Record<string, number>;  // vote counts / shares — fuels the Group Announcement animations
}

export interface FinaleView {  // BROADCAST-SAFE — public slides only, identical on every phone
    slides: FinaleSlide[];
    summary: { ship?: string; besties?: string; toxic?: string; rivals?: string };
}

// ---------- Secret decks (private cards — ONE phone only) ----------
// Private material NEVER rides the broadcast `finale`. Each player with
// private material gets a personal deck via the `secrets` event, emitted only
// on their socket. Cards are face-down and HOLD-TO-REVEAL: press and hold to
// open, release to hide again — shoulder-surfers see nothing. A deck is a
// bunch of facts about YOU.
export type SecretKind = "spark" | "onesided" | "blindspot" | "roomnote" | "stat";

export interface SecretCard {
    id: string;
    kind: SecretKind;
    title: string;               // pseudonym copy; server swaps "Player N" → alias after narration
    facts: string[];             // 1–4 short lines; numbers ONLY from engine claims/digest
}

export interface SecretDeckView {
    cards: SecretCard[];         // ≤ SECRET_DECK_MAX; ordered spark → onesided → blindspot → roomnote → stat
}

export const SECRET_DECK_MAX = 6;    // cards per player, per night
export const SECRET_HOLD_MS = 400;   // press-and-hold ramp before a card opens; release hides it again

// ---------- Socket contract ----------
export interface Consent { age: boolean; terms: boolean; revealOptIn: boolean; }

export interface JoinRequest {
    roomCode: RoomCode;
    alias: string;               // 2–14 chars
    consent: Consent;            // age must be true (18+)
    resume?: { playerId: PlayerId; secret: string };
}

export interface JoinReply {
    ok: boolean;
    you?: PlayerId;
    secret?: string;             // store in sessionStorage for reconnect
    state?: RoomView;
    error?: string;
}

export interface SubmitRequest { roundId: string; clientUuid: string; value: ResponseValue; }
export interface DarePassRequest { roundId: string; reason: string; }   // reason REQUIRED, ≤140

export type ClientToServerEvents = {
    create: (p: { alias: string; consent: Consent }, reply: (r: JoinReply & { code?: RoomCode }) => void) => void;
    join: (p: JoinRequest, reply: (r: JoinReply) => void) => void;
    submit: (p: SubmitRequest, reply: (r: { ok: boolean; error?: string }) => void) => void;
    dare_pass: (p: DarePassRequest) => void;
    start: () => void;                                   // host only
    add_bot: () => void;                                 // host only (fill seats / solo test)
    skip_round: () => void;                              // host only
    custom_prompts: (p: { lines: string[] }) => void;    // host only, lobby, ≤10 lines, ≤160 chars each
    vote_heat_down: () => void;
    delete_room: () => void;                             // ANY player
};

export type ServerToClientEvents = {
    state: (p: RoomView) => void;
    round: (p: RoundView) => void;
    reveal: (p: RevealView) => void;
    interlude: (p: InterludeView) => void;
    finale: (p: FinaleView) => void;          // broadcast-safe: public slides only
    secrets: (p: SecretDeckView) => void;     // ONLY the owning player's socket — NEVER broadcast
    deleted: () => void;
    error: (p: { code: string; message: string }) => void;
};

// ---------- Tunables (config, not logic) ----------
export const DEFAULT_WEIGHTS = {
    pickOverlap: 0.30,
    mutualPick: 0.20,
    debriefSim: 0.20,
    iosMean: 0.15,
    traitAgreement: 0.15,
} as const;

export const TOXIC_WEIGHTS = { indegree: 0.6, contemptTags: 0.4 } as const;

export const CONFIDENCE_RULES = {
    high: { independentSignals: 3, consensusShare: 0.70 },
    med: { independentSignals: 2, consensusShare: 0.55 },
} as const;

export const JOKER_GUARD = { sameTargetShare: 0.70, downweight: 0.5 } as const;

export const MC_SIMULATIONS = 4000;   // seeded PRNG → deterministic

/** verdict: seconds of open debate ("PHONES DOWN. ARGUE IT OUT.") */
export const VERDICT_DISCUSS_MS = 90_000;
/** verdict: simultaneous secret pick window after the debate */
export const VERDICT_VOTE_MS = 15_000;
/** spotlight: a short caption, not an essay */
export const SPOTLIGHT_ANSWER_MAX = 80;
/** spotlight: how long the caption wall holds (stack, then the punchline) */
export const SPOTLIGHT_REVEAL_MS = 8_000;
/** verdict: the room's answer lands, then the phase moves on */
export const VERDICT_REVEAL_MS = 6_000;

export const ROUND_TIMERS_MS: Record<RoundKind, number> = {
    pick: 45_000, text: 90_000, shout: 15_000, rating: 40_000, ios: 40_000,
    minigame: 12_000, dare: 300_000, pair_dare: 330_000, debrief: 60_000,
    // Live moments. Spotlight = 25s of captioning. Verdict = 90s of arguing
    // with phones face-down, then 15s of secret simultaneous picking.
    spotlight: 25_000, verdict: VERDICT_DISCUSS_MS + VERDICT_VOTE_MS,
};

export const REVEAL_HOLD_MS = 4200;
export const INTERLUDE_HOLD_MS = 3200;
export const GRACE_MS = 8000;         // extra wait after timer for stragglers
export const ROUNDS_PER_PHASE = 3;    // warmup / spicy / deep
export const DARE_ROUNDS = 2;         // solo dares before the pair dare

// ---------- LLM providers ----------
// TWO INDEPENDENT LANES — deterministic code is primary everywhere (bank
// prompts, Jaccard similarity, lexicon tags, template finale); providers only
// augment. Each lane checks only its own key and degrades to code silently:
//   Grok   (XAI_API_KEY)    → unhinged prompt generation ONLY.
//   Gemini (GEMINI_API_KEY) → data analysis + finale narration (higher tier).
// Gemini never generates game prompts (it soft-refuses spicy); Grok never
// analyzes or narrates. Neither key → full game, zero internet.
export const PROVIDERS = {
    grok: {
        // OpenAI-compatible REST: POST {baseUrl}/chat/completions with Bearer XAI_API_KEY.
        // grok-4-1-fast: $0.20 in / $0.50 out per 1M (verified Oct 2026) — batched,
        // ONE call per phase (~15 candidates), in the lobby background only.
        // VERIFY the id at https://docs.x.ai/docs/models before wiring; if it 404s,
        // request the current one via NOTES/contract-requests.md.
        // Envelope ≈ "R-rated movie" (verified Oct 2026): adult banter / dark
        // humour / innuendo pass; explicit sexual acts, minors, real-person sexual
        // content, non-consent are hard-blocked. xAI has NO per-category threshold
        // knobs — our deterministic filter (banned patterns, length, placeholders)
        // is the guardrail.
        baseUrl: "https://api.x.ai/v1",
        generate: "grok-4-1-fast", // unhinged generation + callbacks — Grok's only job
    },
    gemini: {
        // Analysis + narration lane — the higher tier. All calls BATCHED:
        // tags once per night (all texts), debrief-similarity once (all pairs),
        // reveal+secrets copy ONCE per night. SAFETY_OFF attached (see below) so
        // it can analyze spicy text without refusing.
        tag: "gemini-3.5-flash-lite",       // cheap classification, one batch call
        analyze: "gemini-3.1-pro-preview",  // pair-dare debrief judgment
        reveal: "gemini-3.1-pro-preview",   // finale slides + secret card copy, ONE call/night
    },
} as const;

// Hard API budget: generation 4 (one per phase) + tag 1 + debrief 1 +
// reveal+secrets 1 = 7. "Most things are done through code" — the cap is
// enforced in code, not vibes.
export const MAX_PROVIDER_CALLS_PER_NIGHT = 8;

// Gemini-only request field: set all four adjustable filters to the most
// permissive threshold the current API accepts ("OFF" on the new interactions
// API; "BLOCK_NONE" on classic v1beta — agent D verifies which applies).
export const SAFETY_OFF = [
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
] as const;

export const pseudonym = (index: number) => `Player ${index + 1}`; // ONLY this ever leaves the server
