// packages/prompts/src/filter.ts
// THE GUARDRAIL.
//
// v3.2 rule: the filter may ONLY drop a generated prompt for FOUR reasons —
//   1. not about a person in the room
//   2. a repeat of something we already have
//   3. over 160 characters
//   4. a refusal (or an "as an AI" disclaimer)
//
// Everything else passes. The deterministic checks live in ollama.ts
// (validateGenerated); this file owns the shared constants and the
// room-directed checks the rest of the package uses.
//
// Pure functions only: no I/O, no randomness, no provider calls.
import {
    MAX_PROMPT_CHARS,
    MAX_PLAYERS,
    type Prompt,
    type PromptCoding,
    type RoundKind,
} from "../../shared/src/contracts.ts";
import { ANY_BRACE_RE } from "./bank/index.ts";

export const MIN_PROMPT_CHARS = 20;
export { MAX_PROMPT_CHARS };
/** Near-duplicate threshold for token-Jaccard between two prompt texts. */
export const DUPLICATE_JACCARD = 0.8;

export const CODINGS: readonly PromptCoding[] = [
    "couple",
    "friendship",
    "trust",
    "friction",
    "tease",
    "rivalry",
    "status",
    "neutral",
] as const;

export const ROUND_KINDS: readonly RoundKind[] = [
    "pick",
    "text",
    "longtext",
    "rating",
    "dare",
    "pair_vote",
    "pair_pick",
] as const;

/** Kinds a self-rating may use (they feed blind spots — evaluative traits only). */
export const EVALUATIVE_TRAITS = ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"] as const;

export interface BannedRule {
    id: string;
    re: RegExp;
    why: string;
}

/**
 * Patterns that never ship. The unhinged tier lives INSIDE this envelope;
 * anything past it never reaches a phone.
 */
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
 * Hard blocks: minors, non-consent, explicit sexual acts, real-person sexual
 * content, illegal acts.
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
    /\b(people|person|member|members)\s+here\b/i,
    /\bthe\s+group\b/i,
    /\byou\s+two\b/i,
    /\btwo\s+(people|of\s+you)\b/i,
    /\bthe\s+pair\b/i,
    /\beach\s+other\b/i,
    /\bnominate\b/i,
];

/** True when the text points at someone in this room. */
export function hasRoomReference(text: string): boolean {
    return ROOM_REFERENCES.some((re) => re.test(text));
}

/**
 * The DATA-OR-DEAD rule: a prompt that targets nobody and measures nothing is
 * random spectacle and does not ship.
 */
export function isRoomDirected(prompt: Prompt): boolean {
    if (prompt.role === "group" || prompt.role === "dare") return true;
    if (prompt.role === "observer_subject" || prompt.role === "observer_pair") return true;
    if (prompt.role === "subject" || prompt.role === "solo") {
        // A self-directed prompt is fine as long as it still measures something.
        return prompt.measures.length > 0;
    }
    return hasRoomReference(prompt.text);
}

/** Check a prompt against the banned + hard-blocked lists. */
export function checkBanned(text: string): BannedRule | undefined {
    return [...HARD_BLOCKED, ...BANNED_PATTERNS].find((rule) => rule.re.test(text));
}

/** Check a prompt against the hard blocks only. */
export function checkHardBlocked(text: string): BannedRule | undefined {
    return HARD_BLOCKED.find((rule) => rule.re.test(text));
}

/** Normalise a candidate prompt into the canonical shape. */
export function normalizeCandidate(raw: unknown): Prompt | null {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const text = typeof r.text === "string" ? r.text.trim() : "";
    if (text.length < MIN_PROMPT_CHARS) return null;
    if (text.length > MAX_PROMPT_CHARS) return null;
    const kind = normalizeKind(r.kind);
    if (!kind) return null;
    const role = r.role;
    if (role !== "subject" && role !== "observer_subject" && role !== "observer_pair" &&
        role !== "group" && role !== "solo" && role !== "dare") {
        return null;
    }
    const coding = normalizeCoding(r.coding);
    const measures = normalizeMeasures(r.measures);
    if (measures.length === 0) return null;
    const band = r.band === "warmup" || r.band === "spicy" || r.band === "deep" || r.band === "dare"
        ? r.band
        : "spicy";
    return {
        id: typeof r.id === "string" && r.id ? r.id : `gen-${Math.abs(hashString(text))}`,
        source: "ollama",
        band,
        role,
        kind,
        text,
        measures,
        coding,
        asksTarget: role === "observer_subject" || role === "observer_pair" || role === "group" || role === "dare",
    };
}

/** Normalise a round kind. */
export function normalizeKind(raw: unknown): RoundKind | null {
    if (raw === "pick" || raw === "text" || raw === "longtext" || raw === "rating" ||
        raw === "dare" || raw === "pair_vote" || raw === "pair_pick") {
        return raw;
    }
    return null;
}

/** Normalise a coding. */
export function normalizeCoding(raw: unknown): PromptCoding {
    return CODINGS.includes(raw as PromptCoding) ? (raw as PromptCoding) : "neutral";
}

/** Normalise measures into a non-empty list. */
export function normalizeMeasures(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    const out: string[] = [];
    for (const m of raw) {
        if (typeof m !== "string") continue;
        const trimmed = m.trim();
        if (!trimmed) continue;
        if (!out.includes(trimmed)) out.push(trimmed);
    }
    return out;
}

/** Every `{Pn}` index used by a text. */
export function placeholderIndexes(text: string): number[] {
    const found: number[] = [];
    for (const m of text.matchAll(/\{P(\d{1,2})\}/g)) {
        const n = Number(m[1]);
        if (Number.isInteger(n) && n >= 1 && n <= MAX_PLAYERS) found.push(n);
    }
    return [...new Set(found)].sort((a, b) => a - b);
}

/** True when the text contains a placeholder that no player could fill. */
export function badPlaceholder(text: string, playerCount: number): boolean {
    const indexes = placeholderIndexes(text);
    return indexes.some((i) => i > playerCount);
}

/** True when the text contains a brace token that is not a valid {Pn}. */
export function hasInvalidPlaceholder(text: string): boolean {
    for (const m of text.matchAll(ANY_BRACE_RE)) {
        if (!/^\{P\d{1,2}\}$/.test(m[0])) return true;
    }
    return false;
}

/** Stable string hash — used to mint ids for generated prompts. */
export function hashString(text: string): number {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
        h = (h << 5) - h + text.charCodeAt(i);
        h |= 0;
    }
    return h;
}
