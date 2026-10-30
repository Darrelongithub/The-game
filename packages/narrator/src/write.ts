// packages/narrator/src/write.ts
// writeFinale — deterministic template output, no provider calls. Gemini is
// analysis-only; the server keeps public slides and private secret decks separate.
// The engine owns all claims, numbers, evidence, and card facts; this module
// validates/fills copy from that source and never sends secret data to a provider.

import {
  SECRET_DECK_MAX,
  type FinaleSlide,
  type NightDigest,
  type PlayerId,
  type Results,
  type SecretCard,
  type SecretKind,
} from "../../shared/src/contracts.ts";
import { conservativeSource, normalizeTitle } from "./slides.ts";
import { buildSkeleton, registerSource, sourceOf } from "./slides.ts";

import {
  derivePseudonyms,
  pseudonymForAlias,
  pseudonymOf,
  scrubAliases,
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
  /** Optional single Grok reveal call; validated copy is merged over deterministic engine text. */
  grok?: (payload: Record<string, unknown>) => Promise<unknown | null>;
  /** Legacy-compatible option; ignored because Gemini is analysis-only. */
  apiKey?: string;
  /** Legacy-compatible option; finale narration performs no network requests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  roster?: RosterInput;
  env?: Record<string, string | undefined>;
  /** Legacy-compatible option; ignored. */
  model?: string;
  /** Optional, bounded style hint from public-answer analysis; never a score. */
  publicToneHint?: "warm";
}

export interface FinaleCopy {
  slides: FinaleSlide[];
  decks: Map<PlayerId, SecretCard[]>;
}

const SECRET_KINDS: readonly SecretKind[] = [
  "spark",
  "onesided",
  "blindspot",
  "roomnote",
  "stat",
];

const CARD_TITLE_FALLBACK: Record<SecretKind, string> = {
  spark: "SPARK",
  onesided: "ONE-SIDED",
  blindspot: "BLIND SPOT",
  roomnote: "ROOM NOTE",
  stat: "YOUR NIGHT IN NUMBERS",
};

const TONE =
  "roast-warm, dry, never mean-spirited, never clinical. The room is laughing WITH each other. " +
  "Secret cards are KIND — they open on one phone, alone, at midnight.";

export const SYSTEM_PROMPT = `You are the narrator of "The Reveal Game": a private, 18+ friends' party game. You write the end-of-night reveal — a Wrapped-style story that plays on every phone at 2am — plus private secret cards that open on ONE phone only.

VOICE
- Roast-warm and dry. Funny because it is true, never because it is cruel.
- Short sentences, concrete nouns. No corporate mush, no therapy-speak, no clinical or psychology labels.
- Never explain the joke. Land it and move on.
- Secret cards lean KIND: they land on one phone, alone, at midnight. Warm, a little flattering, never a diagnosis.
- An optional publicToneHint is a style suggestion only, not a fact or a score.

HARD RULES — a validator checks every line and silently replaces anything that breaks them with the engine line:
1. NUMBERS: only repeat digits that already appear in that slide's "numbers" object or its "engine" text. Never compute, round, sum, average, or invent a number.
2. PEOPLE: refer to people ONLY as "Player N" (e.g. "Player 3"), exactly as listed in that slide's "players". Never use a real name, never invent a player, never rename anyone.
3. FACTS: never invent a quote, statistic, label or event. The engine text is the truth; you are polishing it. Text marked "verbatim" must be reproduced character for character — you only write what goes around it.
4. LENGTH: title <= 6 words. body <= 140 characters. Each secret-card fact <= 120 characters, 1-4 facts per card.
5. BANNED: "toxic person", "red flag", "soulmate", "science says", "love language", any form of "diagnos-", "narcissis-", "therapy", or clinical/psychology vocabulary.
6. Adults only, nobody outside this room, no real public figures.

OUTPUT — STRICT JSON only, no prose, no code fences:
{"slides":[{"i":0,"title":"...","body":"..."}],"secretCards":[{"i":0,"title":"...","facts":["..."]}]}
- One entry per slide and per card, keyed by the given "i".
- Beats stay exactly where they are; you only rewrite title/body (slides) and title/facts (cards).
- Shorter is funnier. If you have nothing better than the engine line, return it unchanged.`;

// --------------------------------------------------------------------------
// normalization — the "never empty text" guarantee
// --------------------------------------------------------------------------

function normalizeSlides(
  skeleton: readonly FinaleSlide[],
  results: Results,
  ps: Pseudonyms,
): FinaleSlide[] {
  return skeleton.map((slide, index) => {
    const copy: FinaleSlide = { ...slide };
    copy.title = normalizeTitle(slide.title, index);
    if (typeof slide.body === "string") {
      const body = slide.body.trim();
      if (body.length > 0) copy.body = body;
      else delete copy.body;
    }
    if (slide.numbers) copy.numbers = { ...slide.numbers };
    const source = sourceOf(slide) ?? conservativeSource(slide, results, ps);
    return registerSource(copy, source);
  });
}

function normalizeDecks(
  decks: Map<PlayerId, SecretCard[]> | undefined,
): Map<PlayerId, SecretCard[]> {
  const out = new Map<PlayerId, SecretCard[]>();
  if (!decks || typeof decks.forEach !== "function") return out;
  for (const [playerId, cards] of decks) {
    if (!Array.isArray(cards) || cards.length === 0) continue;
    const cleaned = cards.slice(0, SECRET_DECK_MAX).map((card, index) => {
      const kind = SECRET_KINDS.includes(card?.kind) ? card.kind : "stat";
      const title =
        typeof card?.title === "string" && card.title.trim().length > 0
          ? card.title.trim()
          : CARD_TITLE_FALLBACK[kind];
      const facts = (Array.isArray(card?.facts) ? card.facts : [])
        .filter((fact): fact is string => typeof fact === "string" && fact.trim().length > 0)
        .map((fact) => fact.trim())
        .slice(0, LIMITS.factsPerCard);
      const id =
        typeof card?.id === "string" && card.id.trim().length > 0
          ? card.id
          : `${playerId}-${kind}-${index}`;
      return {
        id,
        kind,
        title,
        facts: facts.length > 0 ? facts : ["The engine kept this one to itself."],
      } satisfies SecretCard;
    });
    if (cleaned.length > 0) out.set(playerId, cleaned);
  }
  return out;
}

// --------------------------------------------------------------------------
// the one request
// --------------------------------------------------------------------------

interface SlideBrief {
  i: number;
  beat: string;
  flavor?: string;
  claimType?: string;
  players: string[];
  numbers?: Record<string, number>;
  engine: { title: string; body: string };
  verbatim?: string;
}

interface CardBrief {
  i: number;
  owner: string;
  kind: string;
  engine: { title: string; facts: string[] };
}

interface FlatCard {
  playerId: PlayerId;
  cardIndex: number;
  card: SecretCard;
}

export function flattenCards(decks: Map<PlayerId, SecretCard[]>): FlatCard[] {
  const flat: FlatCard[] = [];
  for (const [playerId, cards] of decks) {
    cards.forEach((card, cardIndex) => flat.push({ playerId, cardIndex, card }));
  }
  return flat;
}

/** Digest material with every known alias turned into "Player N" (or nobody). */
function digestForModel(
  digest: NightDigest,
  ps: Pseudonyms,
  roster: readonly RosterEntry[] | undefined,
): Record<string, unknown> {
  const scrub = (text: string): string =>
    typeof text === "string" ? scrubAliases(text, ps, roster) : "";
  const who = (alias: string | undefined): string =>
    pseudonymForAlias(ps, alias) ?? "someone in the room";

  const stats = digest.stats ?? {};
  const statEntry = (
    entry: { alias: string; ms?: number; count?: number; score?: number } | undefined,
  ): Record<string, unknown> | undefined =>
    entry ? { who: who(entry.alias), ms: entry.ms, count: entry.count, score: entry.score } : undefined;

  return {
    quotes: (digest.quotes ?? []).slice(0, 12).map((quote) => ({
      said_by: who(quote.alias),
      text: scrub(quote.text),
      context: scrub(quote.context ?? ""),
    })),
    stats: {
      fastest: statEntry(stats.fastest),
      slowest: statEntry(stats.slowest),
      topDodger: statEntry(stats.topDodger),
      tapWar: statEntry(stats.tapWar),
    },
    runningGags: (digest.runningGags ?? []).slice(0, 6).map((gag) => ({ word: scrub(gag.word), count: gag.count })),
    dodges: (digest.dodges ?? []).slice(0, 6).map((dodge) => ({
      who: who(dodge.alias),
      reason: scrub(dodge.reason),
    })),
    selfVsRoom: (digest.selfVsRoom ?? []).slice(0, 6).map((row) => ({
      who: who(row.alias),
      trait: row.trait,
      self: row.self,
      roomMean: row.roomMean,
    })),
  };
}

export function buildRequestPayload(
  slides: readonly FinaleSlide[],
  flatCards: readonly FlatCard[],
  results: Results,
  digest: NightDigest,
  ps: Pseudonyms,
  roster: readonly RosterEntry[] | undefined,
  publicToneHint?: "warm",
): Record<string, unknown> {
  const scrub = (text: string) => scrubAliases(text, ps, roster);
  const referenced = new Set(
    slides.map((slide) => slide.claimId).filter((id): id is string => Boolean(id)),
  );
  // Public claims only: private material rides the secret cards, never here.
  const claims = results.claims
    .filter((claim) => referenced.has(claim.id) && claim.audience === "public")
    .map((claim) => ({
      id: claim.id,
      type: claim.type,
      subjects: claim.subjects.map((id) => pseudonymOf(ps, id) ?? "someone in the room"),
      confidence: claim.confidence,
      numbers: claim.numbers,
      evidence: claim.evidence.map(scrub),
    }));

  const slideBriefs: SlideBrief[] = slides.map((slide, index) => {
    const source = sourceOf(slide);
    const brief: SlideBrief = {
      i: index,
      beat: slide.beat,
      players: source ? [...source.players] : [],
      engine: { title: scrub(slide.title), body: scrub(slide.body ?? "") },
    };
    if (slide.flavor) brief.flavor = slide.flavor;
    if (source?.claimType) brief.claimType = source.claimType;
    if (slide.numbers) brief.numbers = { ...slide.numbers };
    if (source?.verbatim) brief.verbatim = scrub(source.verbatim);
    return brief;
  });

  const cardBriefs: CardBrief[] = flatCards.map(({ card }, index) => ({
    i: index,
    owner: card.kind === "spark" ? "one of the two" : "the owner",
    kind: card.kind,
    engine: { title: scrub(card.title), facts: card.facts.map(scrub) },
  }));

  return {
    night: { players: ps.order.length, tone: TONE, ...(publicToneHint === "warm" ? { publicToneHint: "warm" } : {}) },
    claims,
    digest: digestForModel(digest, ps, roster),
    slides: slideBriefs,
    secretCards: cardBriefs,
  };
}

// --------------------------------------------------------------------------
// response → merged copy
// --------------------------------------------------------------------------

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Lowercased, whitespace-collapsed, typographic quotes folded — for the
 *  "this must appear verbatim" check only. */
const normalizeForQuote = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** A quote/dodge slide must still contain its verbatim digest material. */
const keepsVerbatim = (body: string, verbatim: string | undefined): boolean => {
  if (!verbatim) return true;
  const needle = normalizeForQuote(verbatim).replace(/^"|"$/g, "");
  if (needle.length === 0) return true;
  return normalizeForQuote(body).includes(needle);
};

const privatePhraseLeak = (copy: string, privateFacts: readonly string[]): boolean => {
  const normalized = (value: string): string => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const target = ` ${normalized(copy)} `;
  return privateFacts.some((fact) => {
    const words = normalized(fact).split(/\s+/u).filter(Boolean);
    if (words.length < 4) return false;
    const exact = ` ${words.join(" ")} `;
    if (target.includes(exact)) return true;
    for (let i = 0; i + 6 <= words.length; i++) {
      if (target.includes(` ${words.slice(i, i + 6).join(" ")} `)) return true;
    }
    return false;
  });
};

export function mergeSlides(
  slides: FinaleSlide[],
  raw: unknown,
  ps: Pseudonyms,
  roster: readonly RosterEntry[] | undefined,
  results: Results,
  privateFacts: readonly string[] = [],
): FinaleSlide[] {
  const aliases = roster?.map((entry) => entry.alias);
  const maxPlayer = ps.order.length;
  const seen = new Set<number>();

  for (const entry of asArray(raw)) {
    const record = asRecord(entry);
    if (!record) continue;
    const index = Number(record["i"]);
    if (!Number.isInteger(index) || index < 0 || index >= slides.length) continue;
    if (seen.has(index)) continue;
    seen.add(index);

    const target = slides[index] as FinaleSlide;
    const source =
      sourceOf(target) ?? conservativeSource(target, results, ps);
    const limits = {
      numbers: source.numbers,
      players: source.players,
      maxPlayer,
      aliases,
    };

    const title = validateTitle(record["title"], limits);
    if (title.ok && !privatePhraseLeak(title.text, privateFacts)) target.title = title.text;

    const body = validateBody(record["body"], limits);
    // QUOTE OF THE NIGHT and the Dodge Report are quoted material: a
    // paraphrase is an invented quote, so it falls back to the engine line.
    if (body.ok && keepsVerbatim(body.text, source.verbatim ? scrubAliases(source.verbatim, ps, roster) : undefined) && !privatePhraseLeak(body.text, privateFacts)) target.body = body.text;
  }
  return slides;
}

export function mergeCards(
  decks: Map<PlayerId, SecretCard[]>,
  flat: readonly FlatCard[],
  raw: unknown,
  ps: Pseudonyms,
  roster: readonly RosterEntry[] | undefined,
): Map<PlayerId, SecretCard[]> {
  const aliases = roster?.map((entry) => entry.alias);
  const maxPlayer = ps.order.length;
  const seen = new Set<number>();
  const replacements = new Map<number, { title?: string; facts?: string[] }>();

  for (const entry of asArray(raw)) {
    const record = asRecord(entry);
    if (!record) continue;
    const index = Number(record["i"]);
    if (!Number.isInteger(index) || index < 0 || index >= flat.length) continue;
    if (seen.has(index)) continue;
    seen.add(index);

    const { card, playerId } = flat[index] as FlatCard;
    const engineTexts = [card.title, ...card.facts];
    const ownerToken = ps.byId.get(playerId);
    const limits = {
      numbers: digitsIn(engineTexts),
      players: new Set([
        ...playerTokensIn(engineTexts),
        ...(ownerToken ? [ownerToken] : []),
      ]),
      maxPlayer,
      aliases,
    };

    const patch: { title?: string; facts?: string[] } = {};
    const title = validateCardTitle(record["title"], limits);
    if (title.ok) patch.title = title.text;

    const rawFacts = asArray(record["facts"]).filter(
      (fact): fact is string => typeof fact === "string",
    );
    if (rawFacts.length > 0) {
      const checked = rawFacts.slice(0, LIMITS.factsPerCard).map((fact) => validateFact(fact, limits));
      // One bad fact keeps the whole engine card: a half-invented card is worse
      // than a plain one.
      if (checked.every((result) => result.ok)) {
        const facts = checked
          .filter((result): result is { ok: true; text: string } => result.ok)
          .map((result) => result.text);
        if (facts.length > 0) patch.facts = facts;
      }
    }
    replacements.set(index, patch);
  }

  if (replacements.size === 0) return decks;

  const indexByCard = new Map<SecretCard, number>();
  flat.forEach((item, flatIndex) => indexByCard.set(item.card, flatIndex));

  const merged = new Map<PlayerId, SecretCard[]>();
  for (const [playerId, cards] of decks) {
    merged.set(
      playerId,
      cards.map((card) => {
        const index = indexByCard.get(card);
        const patch = index !== undefined ? replacements.get(index) : undefined;
        if (!patch) return card;
        return {
          ...card,
          ...(patch.title ? { title: patch.title } : {}),
          ...(patch.facts ? { facts: patch.facts } : {}),
        } satisfies SecretCard;
      }),
    );
  }
  return merged;
}

// --------------------------------------------------------------------------
// public API
// --------------------------------------------------------------------------

export async function writeFinale(
  skeleton: readonly FinaleSlide[],
  decks: Map<PlayerId, SecretCard[]> | undefined,
  results: Results,
  digest: NightDigest,
  options: WriteOptions = {},
): Promise<FinaleCopy> {
  const roster = toRoster(options.roster);
  const ps = derivePseudonyms(results, digest, roster);
  const baseSlides = normalizeSlides(skeleton, results, ps);
  const baseDecks = normalizeDecks(decks);

  // One Grok reveal request may polish public slides and private cards together.
  // Every returned field is validated against its engine source; on missing key,
  // provider refusal, timeout, parse failure, or validation failure we keep the
  // deterministic engine-authored copy. Gemini is never used for reveals.
  if (options.grok) {
    try {
      const payload = buildRequestPayload(baseSlides, flattenCards(baseDecks), results, digest, ps, roster);
      const raw = await options.grok(payload);
      const record = asRecord(raw);
      if (record) {
        const flat = flattenCards(baseDecks);
        const privateFacts = flat.flatMap(({ card }) => [card.title, ...card.facts]);
        mergeSlides(baseSlides, record["slides"], ps, roster, results, privateFacts);
        mergeCards(baseDecks, flat, record["secretCards"], ps, roster);
      }
    } catch { /* deterministic engine copy remains valid */ }
  }
  return { slides: baseSlides, decks: baseDecks };

}

/**
 * One-call convenience for the server (Agent F):
 *   narrateNight({ results, digest, decks, roster: meta.players })
 * Builds the skeleton, then narrates it. Without a key it returns the engine
 * story + engine decks untouched.
 */
export async function narrateNight(input: {
  results: Results;
  digest: NightDigest;
  decks?: Map<PlayerId, SecretCard[]>;
  roster?: RosterInput;
  options?: Omit<WriteOptions, "roster">;
}): Promise<FinaleCopy> {
  const skeleton = buildSkeleton(input.results, input.digest, input.roster);
  return writeFinale(
    skeleton,
    input.decks ?? new Map<PlayerId, SecretCard[]>(),
    input.results,
    input.digest,
    { ...(input.options ?? {}), roster: input.roster },
  );
}
