// packages/prompts/src/filter.ts
// THE GUARDRAIL. Grok has no per-category safety knobs (spec §6), so this
// deterministic filter is what stands between model output and a room of
// friends: schema, dedupe, banned patterns, 20–160 chars, valid {P1}..{P11}
// placeholders, and the DATA-OR-DEAD rule — a prompt that targets nobody and
// measures nothing is random spectacle and does not ship.
//
// Pure functions only: no I/O, no randomness, no provider calls. Every drop is
// reported with a reason so the caller can log it (never to players).
import { MAX_PLAYERS, type Prompt, type PromptCoding, type RoundKind } from "../../shared/src/contracts.ts";
import { ANY_BRACE_RE, PHASE_KINDS, type PromptPhase } from "./bank/index.ts";
import { jaccard, normalizeForDedupe } from "./text.ts";

export const MIN_PROMPT_CHARS = 20;
export const MAX_PROMPT_CHARS = 160;
/** Near-duplicate threshold for token-Jaccard between two prompt texts. */
export const DUPLICATE_JACCARD = 0.8;

export const CODINGS: readonly PromptCoding[] = [
  "couple",
  "friendship",
  "trust",
  "friction",
  "rivalry",
  "status",
  "neutral",
] as const;

export const ROUND_KINDS: readonly RoundKind[] = [
  "pick",
  "text",
  "shout",
  "rating",
  "ios",
  "minigame",
  "dare",
  "pair_dare",
  "debrief",
] as const;

/** Kinds a self-rating may use (they feed blind spots — evaluative traits only). */
export const EVALUATIVE_TRAITS = ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"] as const;

export interface BannedRule {
  id: string;
  re: RegExp;
  why: string;
}

/** Spec §6 banned patterns: favorites, zombies, desert island, untwisted
 *  "most likely to", generic icebreakers. */
export const BANNED_PATTERNS: readonly BannedRule[] = [
  { id: "favorites", re: /\bfavo(u)?rite(s)?\b/i, why: "favorites prompt" },
  { id: "zombies", re: /\bzombies?\b/i, why: "zombie scenario" },
  { id: "desert-island", re: /\bdesert(ed)?\s+island\b/i, why: "desert island" },
  { id: "most-likely-to", re: /\bmost\s+likely\s+to\b/i, why: "untwisted 'most likely to'" },
  { id: "icebreaker-truths", re: /\btwo\s+truths?\s+and\s+a\s+lie\b/i, why: "generic icebreaker" },
  { id: "icebreaker-wyr", re: /\bwould\s+you\s+rather\b/i, why: "generic icebreaker" },
  { id: "icebreaker-dinner", re: /\bif\s+you\s+could\s+(have\s+)?(dinner|a\s+drink|meet)\b/i, why: "generic icebreaker" },
  { id: "icebreaker-funfact", re: /\b(fun\s+fact|ice\s?breaker|highs?\s+and\s+lows?)\b/i, why: "generic icebreaker" },
  { id: "icebreaker-animal", re: /\bif\s+you\s+(were|had\s+to\s+be)\s+an?\s+(animal|colour|color|object)\b/i, why: "generic icebreaker" },
];

/**
 * Hard blocks that mirror the provider policies (xAI "R-rated movie" envelope,
 * Gemini core harms): minors, non-consent, explicit sexual acts, real-person
 * sexual content, illegal acts. The unhinged tier lives INSIDE that envelope;
 * anything past it never reaches a phone.
 */
export const HARD_BLOCKED: readonly BannedRule[] = [
  {
    id: "minors",
    re: /\b(under-?age|minors?|preteen|schoolgirl|schoolboy|loli|child|children|toddler)\b/i,
    why: "minors",
  },
  {
    id: "non-consent",
    re: /\b(rape[ds]?|raping|non-?consensual|drugged|roofie|roofies|coerced?)\b/i,
    why: "non-consent",
  },
  {
    id: "explicit-act",
    re: /\b(blow\s?job|hand\s?job|penetrat\w*|ejaculat\w*|orgasms?|porn\w*|sex\s+tape|nudes?)\b/i,
    why: "explicit sexual act",
  },
  {
    id: "illegal",
    re: /\b(shoplift|burglar\w*|break\s+in|assault|punch\s+(him|her|them)|stab|kill\s+(him|her|them))\b/i,
    why: "illegal or violent",
  },
  {
    id: "real-person",
    re: /\b(celebrity|real[- ]person|famous\s+person)\b/i,
    why: "real-person sexual content",
  },
];

/** Textual markers that make a prompt directed at someone in THIS room. */
export const ROOM_REFERENCES: readonly RegExp[] = [
  /\{P\d{1,2}\}/, // a {Pn} placeholder names someone in this room
  /\bin\s+this\s+room\b/i,
  /\bthis\s+room\b/i,
  /\bthe\s+room\b/i,
  /\bsomeone\s+here\b/i,
  /\banyone\s+here\b/i,
  /\b(every|some)one\s+(in|at)\s+the\s+(room|group)\b/i,
  /\beveryone\s+here\b/i,
  /\bwho\s+here\b/i,
  /\bthis\s+group\b/i,
  /\b(in|at)\s+the\s+group\b/i,
  /\bhere\s+tonight\b/i,
  /\b(people|person|person|member|members)\s+here\b/i,
  /\bthe\s+group\b/i,
  /\byou\s+two\b/i,
  /\btwo\s+(people|of\s+you)\b/i,
  /\bthe\s+pair\b/i,
  /\beach\s+other\b/i,
  /\bpoint\s+at\b/i,
  /\bnominate\b/i,
  /\bPlayer\s+\d{1,2}\b/,
];

/** Round kinds whose answer is necessarily someone in the room (contract §3). */
const INHERENTLY_DIRECTED: ReadonlySet<RoundKind> = new Set(["pick", "ios", "pair_dare", "debrief"]);
/** Group-signal kinds: a shout word / tap-war score is room data (digest §15). */
const GROUP_SIGNAL: ReadonlySet<RoundKind> = new Set(["shout", "minigame"]);

const KIND_ALIASES: Record<string, RoundKind> = {
  question: "text",
  prompt: "text",
  free_text: "text",
  freetext: "text",
  poll: "pick",
  vote: "pick",
  choose: "pick",
  oneword: "shout",
  word: "shout",
  scale: "rating",
  rate: "rating",
  circles: "ios",
  closeness: "ios",
  tap: "minigame",
  tapwar: "minigame",
  game: "minigame",
  pair: "pair_dare",
  pairdare: "pair_dare",
  pair_dare_round: "pair_dare",
  follow_up: "debrief",
  followup: "debrief",
};

const CODING_ALIASES: Record<string, PromptCoding> = {
  friends: "friendship",
  friendly: "friendship",
  friend: "friendship",
  romantic: "couple",
  romance: "couple",
  desire: "couple",
  rival: "rivalry",
  rivals: "rivalry",
  conflict: "friction",
  negative: "friction",
  tension: "friction",
  social: "status",
  socialstatus: "status",
  hierarchy: "status",
  none: "neutral",
  general: "neutral",
};

export interface CandidateShape {
  id?: unknown;
  phase?: unknown;
  kind?: unknown;
  text?: unknown;
  measures?: unknown;
  coding?: unknown;
  asksTarget?: unknown;
}

export type DropReason =
  | "schema"
  | "too-short"
  | "too-long"
  | "bad-placeholder"
  | "placeholder-range"
  | "player-count"
  | "phase"
  | "kind"
  | "coding"
  | "measures"
  | "banned"
  | "hard-block"
  | "not-room-directed"
  | "data-or-dead"
  | "id-used"
  | "duplicate";

export interface Dropped {
  index: number;
  reason: DropReason;
  detail?: string;
}

export interface Verdict {
  ok: boolean;
  reason?: DropReason;
  detail?: string;
}

/** Banned-pattern scan (spec §6). */
export function checkBanned(text: string): { rule: BannedRule } | null {
  for (const rule of BANNED_PATTERNS) if (rule.re.test(text)) return { rule };
  return null;
}

/** Hard-block scan (provider-policy envelope). */
export function checkHardBlocked(text: string): { rule: BannedRule } | null {
  for (const rule of HARD_BLOCKED) if (rule.re.test(text)) return { rule };
  return null;
}

/**
 * Placeholder hygiene: `{P1}..{P11}` only. Returns the first offending token,
 * if any (`{P12}`, `{P0}`, `{name}`, `{P1} {P2}` is fine).
 */
export function badPlaceholder(text: string): string | null {
  const valid = /\{P(\d{1,2})\}/g;
  const stripped = text.replace(valid, "");
  const left = stripped.match(ANY_BRACE_RE);
  if (left && left.length > 0) return left[0];
  for (const m of text.matchAll(valid)) {
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > MAX_PLAYERS) return m[0];
  }
  return null;
}

export function hasRoomReference(text: string): boolean {
  return ROOM_REFERENCES.some((re) => re.test(text));
}

/**
 * Is this prompt directed at someone in the room (or a pair / the group)?
 * The data-or-dead rule's first half.
 */
export function isRoomDirected(input: {
  kind: RoundKind;
  text: string;
  asksTarget?: boolean;
}): boolean {
  const { kind, text } = input;
  if (INHERENTLY_DIRECTED.has(kind)) return true;
  if (GROUP_SIGNAL.has(kind)) return true;
  if (hasRoomReference(text)) return true;
  // A peer-rating that names its subject is directed; a self-rating feeds the
  // blind-spot engine (evaluative traits), which is a signal too.
  if (kind === "rating") return true;
  return false;
}

/** Non-empty, non-placeholder measures that actually feed the engine. */
export function normalizeMeasures(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((m): m is string => typeof m === "string")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
  }
  if (typeof raw === "string") {
    return raw
      .split(/[;,\n]/)
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
  }
  return [];
}

/**
 * DATA-OR-DEAD. Coding + non-empty measures + a target-bearing signal, or the
 * prompt does not ship (spec §6, unhinged-tier header).
 */
export function checkDataOrDead(input: {
  kind: RoundKind;
  text: string;
  coding: PromptCoding;
  measures: string[];
  asksTarget?: boolean;
}): Verdict {
  if (!CODINGS.includes(input.coding)) {
    return { ok: false, reason: "coding", detail: String(input.coding) };
  }
  if (!Array.isArray(input.measures) || input.measures.length === 0) {
    return { ok: false, reason: "measures", detail: "no measures — measures nothing" };
  }
  if (!input.measures.some((m) => m.trim().length >= 2)) {
    return { ok: false, reason: "measures", detail: "measures are empty strings" };
  }
  if (!isRoomDirected({ kind: input.kind, text: input.text, asksTarget: input.asksTarget })) {
    return { ok: false, reason: "not-room-directed", detail: "targets nobody in the room" };
  }
  return { ok: true };
}

export function normalizeKind(raw: unknown): RoundKind | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if ((ROUND_KINDS as readonly string[]).includes(key)) return key as RoundKind;
  return KIND_ALIASES[key] ?? null;
}

export function normalizeCoding(raw: unknown): PromptCoding | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if ((CODINGS as readonly string[]).includes(key)) return key as PromptCoding;
  return CODING_ALIASES[key] ?? null;
}

export interface FilterContext {
  phase: PromptPhase;
  playerCount: number;
  /** Prompt ids already used tonight. */
  usedIds?: readonly string[];
  /** Existing texts to dedupe against: bank + already-generated. */
  usedTexts?: readonly string[];
  /** Id prefix for accepted prompts (default "grok"). */
  idPrefix?: string;
  /** Max accepted prompts (default 15). */
  limit?: number;
  minChars?: number;
  maxChars?: number;
}

export interface NormalizedCandidate {
  prompt: Prompt;
  index: number;
}

function deriveAsksTarget(kind: RoundKind, text: string): boolean {
  if (kind === "pick" || kind === "ios") return true;
  if (kind === "pair_dare" || kind === "debrief" || kind === "minigame" || kind === "shout") return false;
  return /\{P\d{1,2}\}/.test(text) || /\bPlayer\s+\d{1,2}\b/.test(text);
}

/**
 * Turn one raw model object into a contract `Prompt` — or drop it with a
 * reason. Deterministic normalization only (kind/coding aliases, measures
 * string→array, asksTarget derivation); everything else is validated strictly.
 */
export function normalizeCandidate(
  raw: unknown,
  ctx: FilterContext,
  index: number,
  seenTexts: string[],
  usedIds: Set<string>,
): { prompt: Prompt } | { reason: DropReason; detail?: string } {
  if (raw === null || typeof raw !== "object") return { reason: "schema", detail: "not an object" };
  const c = raw as CandidateShape;
  if (typeof c.text !== "string") return { reason: "schema", detail: "text missing" };
  const text = c.text.replace(/\s+/g, " ").trim();

  const minChars = ctx.minChars ?? MIN_PROMPT_CHARS;
  const maxChars = ctx.maxChars ?? MAX_PROMPT_CHARS;
  if (text.length < minChars) return { reason: "too-short", detail: `${text.length} < ${minChars}` };
  if (text.length > maxChars) return { reason: "too-long", detail: `${text.length} > ${maxChars}` };

  const bad = badPlaceholder(text);
  if (bad) return { reason: "bad-placeholder", detail: bad };
  const highest = Math.max(0, ...[...text.matchAll(/\{P(\d{1,2})\}/g)].map((m) => Number(m[1])));
  if (highest > MAX_PLAYERS) return { reason: "placeholder-range", detail: `{P${highest}}` };
  if (highest > ctx.playerCount) return { reason: "player-count", detail: `{P${highest}} > ${ctx.playerCount} players` };

  if (typeof c.phase === "string" && c.phase.trim().length > 0) {
    const phase = c.phase.trim().toLowerCase();
    if (phase !== ctx.phase) return { reason: "phase", detail: `${phase} ≠ ${ctx.phase}` };
  }

  const kind = normalizeKind(c.kind);
  if (!kind) return { reason: "kind", detail: String(c.kind) };
  if (!PHASE_KINDS[ctx.phase].includes(kind)) {
    return { reason: "kind", detail: `${kind} is not a ${ctx.phase} kind` };
  }

  const coding = normalizeCoding(c.coding);
  if (!coding) return { reason: "coding", detail: String(c.coding) };

  const measures = normalizeMeasures(c.measures);
  if (measures.length === 0) return { reason: "measures", detail: "empty measures" };

  const asksTarget = typeof c.asksTarget === "boolean" ? c.asksTarget : deriveAsksTarget(kind, text);
  if (asksTarget && !isRoomDirected({ kind, text, asksTarget })) {
    return { reason: "not-room-directed", detail: "asksTarget without a target" };
  }

  const banned = checkBanned(text);
  if (banned) return { reason: "banned", detail: banned.rule.why };
  const hard = checkHardBlocked(text);
  if (hard) return { reason: "hard-block", detail: hard.rule.why };

  const dead = checkDataOrDead({ kind, text, coding, measures, asksTarget });
  if (!dead.ok) return { reason: dead.reason ?? "data-or-dead", detail: dead.detail };

  const normalized = normalizeForDedupe(text);
  for (const existing of seenTexts) {
    if (normalizeForDedupe(existing) === normalized) return { reason: "duplicate", detail: "exact" };
    if (jaccard(existing, text) >= DUPLICATE_JACCARD) return { reason: "duplicate", detail: "near" };
  }

  const prefix = ctx.idPrefix ?? "grok";
  let id = `${prefix}-${ctx.phase}-${index + 1}`;
  let bump = 1;
  while (usedIds.has(id)) {
    id = `${prefix}-${ctx.phase}-${index + 1}-${bump}`;
    bump += 1;
  }

  return {
    prompt: { id, source: "grok", phase: ctx.phase, kind, text, measures, coding, asksTarget },
  };
}

/**
 * Filter a whole model batch. Dedupe covers usedIds, the bank's texts
 * (`usedTexts`) and within-batch near-duplicates, in that order.
 */
export function filterCandidates(
  raws: readonly unknown[],
  ctx: FilterContext,
): { prompts: Prompt[]; dropped: Dropped[] } {
  const limit = ctx.limit ?? 15;
  const usedIds = new Set<string>(ctx.usedIds ?? []);
  const seenTexts: string[] = [...(ctx.usedTexts ?? [])];
  const prompts: Prompt[] = [];
  const dropped: Dropped[] = [];

  raws.forEach((raw, index) => {
    if (prompts.length >= limit) {
      dropped.push({ index, reason: "duplicate", detail: "batch full" });
      return;
    }
    const result = normalizeCandidate(raw, ctx, index, seenTexts, usedIds);
    if ("prompt" in result) {
      prompts.push(result.prompt);
      seenTexts.push(result.prompt.text);
      usedIds.add(result.prompt.id);
    } else {
      dropped.push({ index, reason: result.reason, detail: result.detail });
    }
  });

  return { prompts, dropped };
}

/** True when `quote` appears verbatim inside `text` (callbacks must be real). */
export function containsVerbatimQuote(text: string, quote: string): boolean {
  const q = quote.trim();
  if (q.length < 8) return false;
  return text.toLowerCase().includes(q.toLowerCase());
}
