// packages/narrator/src/write.ts
// writeFinale — deterministic template output, with ONE optional Ollama polish.
//
// The engine owns every verdict, number and card fact. This module validates
// and fills copy from that source; it never invents a claim, and it never
// sends secret data to the model.
//
// Ollama may ONLY rewrite the wording of a slide (and the title of a card).
// Anything it produces that breaks a rule is silently replaced with the
// engine line — the show never stops.

import {
  SECRET_DECK_MAX,
  type FinaleSlide,
  type NightDigest,
  type PlayerId,
  type Results,
  type SecretCard,
  type SecretKind,
} from "../../shared/src/contracts.ts";
import { buildSkeleton, conservativeSource, registerSource, sourceOf } from "./slides.ts";
import {
  derivePseudonyms,
  toRoster,
  type Pseudonyms,
  type RosterEntry,
  type RosterInput,
} from "./roster.ts";
import {
  digitsIn,
  LIMITS,
  playerTokensIn,
  validateBody,
  validateCardTitle,
  validateFact,
  validateTitle,
} from "./validate.ts";

export interface WriteOptions {
  /** Optional single Ollama polish call; validated copy is merged over the engine text. */
  ollama?: (payload: Record<string, unknown>) => Promise<unknown | null>;
  /** Legacy-compatible option; ignored. */
  apiKey?: string;
  /** Legacy-compatible option; ignored. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  roster?: RosterInput;
  env?: Record<string, string | undefined>;
  /** Legacy-compatible option; ignored. */
  model?: string;
  /** Optional, bounded style hint; never a score. */
  publicToneHint?: "warm";
}

export interface FinaleCopy {
  slides: FinaleSlide[];
  decks: Map<PlayerId, SecretCard[]>;
}

const SECRET_KINDS: readonly SecretKind[] = ["crush", "blindspot", "lookchain"];

const CARD_TITLE_FALLBACK: Record<SecretKind, string> = {
  crush: "MUTUAL CRUSH",
  blindspot: "BLIND SPOT",
  lookchain: "LOOK CHAIN",
};

const TONE =
  "roast-warm, dry, never mean-spirited, never clinical. The room is laughing WITH each other. " +
  "Secret cards are KIND — they open on one phone, alone, at midnight.";

export const SYSTEM_PROMPT = `You are the narrator of "The Reveal Game": a private, 18+ friends' party game. You write the end-of-night reveal — a Wrapped-style story — plus private secret cards that open on ONE phone only.

VOICE
- Roast-warm and dry. Funny because it is true, never because it is cruel.
- Short sentences, concrete nouns. No corporate mush, no therapy-speak, no clinical or psychology labels.
- Never explain the joke. Land it and move on.
- Secret cards lean KIND: they land on one phone, alone, at midnight. Warm, a little flattering, never a diagnosis.

HARD RULES — a validator checks every line and silently replaces anything that breaks them with the engine line:
1. NUMBERS: only repeat digits that already appear in that slide's "numbers" object or its "engine" text. Never compute, round, sum, average, or invent a number.
2. PEOPLE: refer to people ONLY as "Player N" (e.g. "Player 3"), exactly as listed in that slide's "players". Never use a real name, never invent a player, never rename anyone.
3. FACTS: never invent a quote, statistic, label or event. The engine text is the truth; you are polishing it. Text marked "verbatim" must be reproduced character for character.
4. LENGTH: title <= 6 words. body <= 140 characters. Each secret-card fact <= 120 characters, 1-4 facts per card.
5. BANNED: "toxic person", "red flag", "soulmate", "science says", "love language", any form of "diagnos-", "narcissis-", "therapy", or clinical/psychology vocabulary.
6. NEVER print an orientation claim. Never write that anyone is gay, lesbian, bi, straight, or that anyone was named in a gay-hypothetical question. Only ever write the hypothetical phrasing the engine gave you.
7. Adults only, nobody outside this room, no real public figures.

OUTPUT — STRICT JSON only, no prose, no code fences:
{"slides":[{"i":0,"title":"...","body":"..."}],"secretCards":[{"i":0,"title":"...","facts":["..."]}]}
- One entry per slide and per card, keyed by the given "i".
- Beats stay exactly where they are; you only rewrite title/body (slides) and title/facts (cards).
- Shorter is funnier. If you have nothing better than the engine line, return it unchanged.`;

// --------------------------------------------------------------------------
// normalization — the "never empty text" guarantee
// --------------------------------------------------------------------------

export function normalizeTitle(title: string | undefined, index: number): string {
  const fallback = `Reveal ${index + 1}`;
  if (typeof title !== "string") return fallback;
  const trimmed = title.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return fallback;
  return trimmed;
}

function normalizeSlides(skeleton: readonly FinaleSlide[]): FinaleSlide[] {
  return skeleton.map((slide, index) => {
    const copy: FinaleSlide = { ...slide };
    copy.title = normalizeTitle(slide.title, index);
    if (typeof slide.body === "string") {
      const body = slide.body.trim();
      if (body.length > 0) copy.body = body;
      else delete copy.body;
    }
    if (slide.numbers) copy.numbers = { ...slide.numbers };
    const source = sourceOf(slide) ?? conservativeSource(slide);
    return registerSource(copy, source);
  });
}

function normalizeDecks(
  decks: Map<PlayerId, SecretCard[]> | undefined,
): Map<PlayerId, SecretCard[]> {
  const out = new Map<PlayerId, SecretCard[]>();
  if (!decks || typeof decks.forEach !== "function") return out;
  decks.forEach((cards, playerId) => {
    const list: SecretCard[] = [];
    for (const card of cards) {
      if (!SECRET_KINDS.includes(card.kind)) continue;
      if (list.length >= SECRET_DECK_MAX) break;
      const facts = (card.facts ?? [])
        .map((f) => (typeof f === "string" ? f.trim() : ""))
        .filter((f) => f.length > 0)
        .slice(0, LIMITS.factsPerCard);
      if (facts.length === 0) continue;
      list.push({
        id: card.id,
        kind: card.kind,
        title: normalizeTitle(card.title || CARD_TITLE_FALLBACK[card.kind], list.length),
        facts,
      });
    }
    if (list.length > 0) out.set(playerId, list);
  });
  return out;
}

// --------------------------------------------------------------------------
// the request payload
// --------------------------------------------------------------------------

/** Flatten every card so the model can address them by index. */
export function flattenCards(decks: Map<PlayerId, SecretCard[]>): FlatCard[] {
  const out: FlatCard[] = [];
  decks.forEach((cards, playerId) => {
    cards.forEach((card) => out.push({ playerId, card }));
  });
  return out;
}

export interface FlatCard { playerId: PlayerId; card: SecretCard; }

/** The data the model sees. Aliases are scrubbed; numbers stay. */
export function buildRequestPayload(
  slides: readonly FinaleSlide[],
  decks: Map<PlayerId, SecretCard[]>,
  results: Results,
  digest: NightDigest,
  ps: Pseudonyms,
): Record<string, unknown> {
  const publicSlides = slides.map((slide, i) => ({
    i,
    beat: slide.beat,
    title: slide.title,
    body: slide.body ?? "",
    numbers: slide.numbers ?? {},
    players: [...new Set((slide.body ?? "").match(/\bPlayer \d+\b/gi) ?? [])],
    engine: slide.body ?? "",
  }));
  const flat = flattenCards(decks);
  const secretCards = flat.map((entry, i) => ({
    i,
    kind: entry.card.kind,
    title: entry.card.title,
    facts: entry.card.facts,
    engine: entry.card.facts,
  }));
  return {
    tone: TONE,
    publicToneHint: "warm",
    players: ps.order.map((id) => ps.byId.get(id)).filter(Boolean),
    slides: publicSlides,
    secretCards,
    digest: {
      quotes: (digest.quotes ?? []).slice(0, 4).map((q) => ({ text: q.text, verbatim: true })),
      dodges: (digest.dodges ?? []).slice(0, 4).map((d) => ({ reason: d.reason, verbatim: true })),
    },
    results: { verdicts: results.verdicts.map((v) => ({ kind: v.kind, numbers: v.numbers, text: v.text })) },
  };
}

// --------------------------------------------------------------------------
// merging
// --------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const normalizeForQuote = (text: string): string =>
  text.replace(/\s+/g, " ").replace(/[“”]/g, '"').replace(/[‘’]/g, "'").trim();

const keepsVerbatim = (body: string, verbatim: string | undefined): boolean => {
  if (!verbatim) return true;
  return normalizeForQuote(body).includes(normalizeForQuote(verbatim));
};

const privatePhraseLeak = (copy: string, privateFacts: readonly string[]): boolean =>
  privateFacts.some((fact) => {
    const core = normalizeForQuote(fact).replace(/^["']|["']$/g, "");
    return core.length >= 12 && normalizeForQuote(copy).includes(core);
  });

/** Merge validated model copy over the deterministic slides. */
export function mergeSlides(
  slides: readonly FinaleSlide[],
  raw: unknown,
  ps: Pseudonyms,
  roster?: readonly RosterEntry[],
): FinaleSlide[] {
  const payload = asRecord(raw);
  const list = asArray(payload?.slides);
  if (list.length === 0) return [...slides];
  const maxPlayer = ps.order.length;
  return slides.map((slide, index) => {
    const entry = asRecord(list.find((item) => asRecord(item)?.i === index));
    if (!entry) return slide;
    const numbers = digitsIn([slide.body ?? "", ...Object.values(slide.numbers ?? {})]);
    const players = playerTokensIn([slide.title, slide.body ?? ""]);
    const titleCheck = validateTitle(entry.title, {
      maxWords: LIMITS.titleMaxWords,
      numbers,
      players,
      maxPlayer,
      aliases: roster?.map((r) => r.alias),
    });
    if (!titleCheck.ok) return slide;
    const bodyCheck = validateBody(entry.body, {
      numbers,
      players,
      maxPlayer,
      aliases: roster?.map((r) => r.alias),
    });
    if (!bodyCheck.ok) return slide;
    const verbatim = slide.flavor === "quote" || slide.flavor === "dodge" ? slide.body : undefined;
    if (verbatim && !keepsVerbatim(bodyCheck.text, verbatim)) return slide;
    if (privatePhraseLeak(bodyCheck.text, [])) return slide;
    const next: FinaleSlide = { ...slide, title: titleCheck.text, body: bodyCheck.text };
    return registerSource(next, sourceOf(slide) ?? conservativeSource(slide));
  });
}

/** Merge validated model copy over the deterministic cards. */
export function mergeCards(
  decks: Map<PlayerId, SecretCard[]>,
  raw: unknown,
  ps: Pseudonyms,
  roster?: readonly RosterEntry[],
): Map<PlayerId, SecretCard[]> {
  const payload = asRecord(raw);
  const list = asArray(payload?.secretCards);
  const flat = flattenCards(decks);
  const out = new Map<PlayerId, SecretCard[]>();
  decks.forEach((cards, playerId) => {
    out.set(playerId, cards.map((card) => {
      const globalIndex = flat.findIndex((f) => f.playerId === playerId && f.card.id === card.id);
      const entry = asRecord(list.find((item) => asRecord(item)?.i === globalIndex));
      if (!entry) return card;
      const numbers = digitsIn(card.facts);
      const players = playerTokensIn([card.title, ...card.facts]);
      const titleCheck = validateCardTitle(entry.title, {
        numbers,
        players,
        maxPlayer: ps.order.length,
        aliases: roster?.map((r) => r.alias),
      });
      if (!titleCheck.ok) return card;
      const rawFacts = asArray(entry.facts);
      if (rawFacts.length === 0) return card;
      const facts: string[] = [];
      for (const fact of rawFacts.slice(0, LIMITS.factsPerCard)) {
        const check = validateFact(fact, {
          numbers,
          players,
          maxPlayer: ps.order.length,
          aliases: roster?.map((r) => r.alias),
        });
        if (!check.ok) continue;
        if (!keepsVerbatim(check.text, card.facts[facts.length])) continue;
        facts.push(check.text);
      }
      if (facts.length === 0) return card;
      const next: SecretCard = { ...card, title: titleCheck.text, facts };
      return next;
    }));
  });
  return out;
}

// --------------------------------------------------------------------------
// the entry point
// --------------------------------------------------------------------------

/**
 * Build the finale. Deterministic by default; one optional Ollama call may
 * polish the wording. The decks are returned SEPARATELY from the slides —
 * the server emits each deck only to its own socket.
 */
export async function writeFinale(
  skeleton: readonly FinaleSlide[],
  decks: Map<PlayerId, SecretCard[]>,
  results: Results,
  digest: NightDigest,
  options: WriteOptions = {},
): Promise<FinaleCopy> {
  const roster = toRoster(options.roster);
  const ps = derivePseudonyms(results, digest, roster);
  const slides = normalizeSlides(skeleton);
  const cards = normalizeDecks(decks);

  if (!options.ollama) return { slides, decks: cards };

  let raw: unknown = null;
  try {
    const payload = buildRequestPayload(slides, cards, results, digest, ps);
    raw = await options.ollama(payload);
  } catch {
    raw = null;
  }
  if (!raw) return { slides, decks: cards };
  return {
    slides: mergeSlides(slides, raw, ps, roster),
    decks: mergeCards(cards, raw, ps, roster),
  };
}

/**
 * The one-call facade: build the skeleton and write it in one go.
 */
export async function narrateNight(
  results: Results,
  digest: NightDigest,
  decks: Map<PlayerId, SecretCard[]>,
  options: WriteOptions = {},
): Promise<FinaleCopy> {
  const roster = toRoster(options.roster);
  const ps = derivePseudonyms(results, digest, roster);
  const skeleton = buildSkeleton(results, digest, ps);
  return writeFinale(skeleton, decks, results, digest, options);
}
