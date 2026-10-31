// packages/narrator/src/slides.ts
// THE FINALE SKELETON — deterministic slides built from the night's VERDICTS.
//
// v3.2: the reveal is a list of data-backed verdicts, each one a slide. The
// skeleton is built entirely from code — no model, no invention. The model
// (Ollama) may only POLISH the wording of a slide; it can never add a claim.
//
// Every slide carries "Player N" pseudonyms only. The server swaps them for
// aliases after narration.
import {
  type FinaleSlide,
  type NightDigest,
  type PlayerId,
  type Results,
  type Verdict,
  type VerdictKind,
} from "../../shared/src/contracts.ts";
import { pseudonym } from "../../shared/src/contracts.ts";
import type { Pseudonyms } from "./roster.ts";

export const NARRATOR_TUNING = {
  /** How many slides the finale plays. */
  maxSlides: 14,
  /** Slide titles are short. */
  titleMaxWords: 6,
  titleMaxChars: 48,
  bodyMaxChars: 140,
  /** Verdicts weaker than this never make the show. */
  minStrength: 0.25,
  /** How many look chains the finale shows. */
  maxLookChains: 3,
} as const;

export interface SkeletonSource {
  kind: "verdict" | "quote" | "stat" | "dodge" | "group";
  verdictId?: string;
  verdictKind?: VerdictKind;
}

const SOURCES = new WeakMap<FinaleSlide, SkeletonSource>();

/** The provenance of a slide (used by the merge step and by tests). */
export const sourceOf = (slide: FinaleSlide): SkeletonSource | undefined => SOURCES.get(slide);

/** Tag a slide with its provenance. */
export const registerSource = (slide: FinaleSlide, source: SkeletonSource): FinaleSlide => {
  SOURCES.set(slide, source);
  return slide;
};

/** Conservative source for a slide the model produced. */
export const conservativeSource = (slide: FinaleSlide): SkeletonSource =>
  sourceOf(slide) ?? { kind: "group" };

/**
 * Is this slide publishable?
 *
 * A slide is publishable when it has real content AND real evidence behind
 * it. A slide with no numbers and no engine text is decoration — it never
 * ships. (The one-sided and spark claim types are gone in v3.2; a verdict is
 * publishable when the engine gave it strength.)
 */
export function isPublishable(verdict: Verdict): boolean {
  if (!verdict || typeof verdict.text !== "string" || verdict.text.trim().length === 0) return false;
  if (verdict.strength < NARRATOR_TUNING.minStrength) return false;
  const hasNumbers = Object.keys(verdict.numbers ?? {}).length > 0;
  const hasSubjects = verdict.subjects.length > 0;
  return hasNumbers && hasSubjects;
}

/** Clip a string to a maximum length on a word boundary. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** How a verdict is staged on the show. */
const BEAT_BY_KIND: Record<VerdictKind, FinaleSlide["beat"]> = {
  hates: "land",
  core: "tease",
  couple: "escalate",
  sex: "land",
  percent: "tease",
  gaycouple: "escalate",
  bodycount: "escalate",
  bestinbed: "escalate",
  besties: "tease",
  rivals: "land",
  freeagent: "tease",
  blindspot: "land",
};

/** The slide title for a verdict — the headline, short. */
const TITLE_BY_KIND: Record<VerdictKind, string> = {
  hates: "The verdict",
  core: "The core",
  couple: "The couple",
  sex: "Just do it",
  percent: "The numbers",
  gaycouple: "Hypothetically",
  bodycount: "Body count",
  bestinbed: "Best in bed",
  besties: "Besties",
  rivals: "Rivals",
  freeagent: "Free agent",
  blindspot: "Blind spot",
};

/**
 * Build the slide for one verdict.
 * The body IS the verdict text — it already names the data behind it.
 */
export function slideForVerdict(verdict: Verdict, ps: Pseudonyms): FinaleSlide {
  const subject = verdict.subjects[0];
  // The "never" couple is the same verdict type, the other way round.
  const heading = isNeverCouple(verdict) ? "Never happening" : TITLE_BY_KIND[verdict.kind];
  const title = subject !== undefined && ps.byId.has(subject)
    ? `${heading} · ${ps.byId.get(subject)}`
    : heading;
  const slide: FinaleSlide = {
    beat: BEAT_BY_KIND[verdict.kind],
    flavor: "claim",
    title: clip(title, NARRATOR_TUNING.titleMaxChars),
    body: clip(verdict.text, NARRATOR_TUNING.bodyMaxChars),
    numbers: verdict.numbers,
  };
  return registerSource(slide, { kind: "verdict", verdictId: verdict.id, verdictKind: verdict.kind });
}

/** Is this the "the room said no" half of the couple verdict? */
export function isNeverCouple(verdict: Verdict): boolean {
  return verdict.kind === "couple" && verdict.id.includes("-never-");
}

/** A slide built from a verbatim quote. */
export function slideForQuote(quote: NightDigest["quotes"][number], ps: Pseudonyms): FinaleSlide | undefined {
  const text = quote.text?.trim();
  if (!text || text.length < 12) return undefined;
  const who = ps.byAlias.get(quote.alias.trim().toLowerCase());
  if (!who) return undefined; // never guess an attribution
  const slide: FinaleSlide = {
    beat: "tease",
    flavor: "quote",
    title: `${who} said`,
    body: clip(`"${text}"`, NARRATOR_TUNING.bodyMaxChars),
  };
  return registerSource(slide, { kind: "quote" });
}

/** A slide built from a verbatim dodge reason. */
export function slideForDodge(dodge: NightDigest["dodges"][number], ps: Pseudonyms): FinaleSlide | undefined {
  const reason = dodge.reason?.trim();
  if (!reason) return undefined;
  const who = ps.byAlias.get(dodge.alias.trim().toLowerCase());
  if (!who) return undefined;
  const slide: FinaleSlide = {
    beat: "tease",
    flavor: "dodge",
    title: `${who} couldn't`,
    body: clip(`"${reason}"`, NARRATOR_TUNING.bodyMaxChars),
  };
  return registerSource(slide, { kind: "dodge" });
}

/** A slide built from a night stat. */
export function slideForStat(digest: NightDigest, ps: Pseudonyms): FinaleSlide | undefined {
  const fastest = digest.stats?.fastest;
  if (!fastest) return undefined;
  const who = ps.byAlias.get(fastest.alias.trim().toLowerCase());
  if (!who) return undefined;
  const slide: FinaleSlide = {
    beat: "tease",
    flavor: "stat",
    title: "Quickest in the room",
    body: clip(`${who} answered in ${formatSeconds(fastest.ms)}.`, NARRATOR_TUNING.bodyMaxChars),
    numbers: { ms: fastest.ms },
  };
  return registerSource(slide, { kind: "stat" });
}

/** Seconds, but never a silly "0.0s". */
function formatSeconds(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 0.1) return "less than a second";
  return `${seconds.toFixed(1)}s`;
}

/**
 * A slide for a look chain — the truth that was hidden all night.
 *
 * The body carries the real choice, how many guessed right and the reason.
 * It is built from the log, never invented.
 */
export function slideForLookChain(
  chain: NightDigest["lookChains"] extends (infer T)[] | undefined ? T : never,
  ps: Pseudonyms,
): FinaleSlide | undefined {
  const actor = ps.byId.get(chain.actorId);
  const target = ps.byId.get(chain.targetId);
  if (!actor || !target) return undefined; // never guess an attribution
  const guessed = chain.guessers > 0
    ? `${chain.guessedRight} of ${chain.guessers} guessed right.`
    : "Nobody even guessed.";
  const body = chain.reason
    ? `${actor} was looking at ${target}. ${guessed} "${chain.reason}"`
    : `${actor} was looking at ${target}. ${guessed}`;
  const slide: FinaleSlide = {
    beat: "escalate",
    flavor: "claim",
    title: "The look chain",
    body: clip(body, NARRATOR_TUNING.bodyMaxChars),
    numbers: { guessedRight: chain.guessedRight, guessers: chain.guessers },
  };
  return registerSource(slide, { kind: "group" });
}

/**
 * Build the whole skeleton: one slide per verdict, plus a quote and a stat
 * when there is real material for them. No invention, ever.
 */
export function buildSkeleton(
  results: Results,
  digest: NightDigest,
  ps: Pseudonyms,
): FinaleSlide[] {
  const slides: FinaleSlide[] = [];

  const verdicts = [...results.verdicts].sort((a, b) => b.strength - a.strength);
  for (const verdict of verdicts) {
    if (verdict.strength < NARRATOR_TUNING.minStrength) continue;
    slides.push(slideForVerdict(verdict, ps));
  }

  // A verbatim quote from the night, if there is one.
  for (const quote of digest.quotes ?? []) {
    if (slides.length >= NARRATOR_TUNING.maxSlides) break;
    const slide = slideForQuote(quote, ps);
    if (slide) {
      slides.push(slide);
      break;
    }
  }

  // A verbatim excuse, if there is one.
  for (const dodge of digest.dodges ?? []) {
    if (slides.length >= NARRATOR_TUNING.maxSlides) break;
    const slide = slideForDodge(dodge, ps);
    if (slide) {
      slides.push(slide);
      break;
    }
  }

  // The look chains — the truth that was hidden all night. The most
  // contested chains first, and never more than three: the reveal stays
  // tight, and every chain still has its own card on the actor's phone.
  const chains = [...(digest.lookChains ?? [])]
    .sort((a, b) => b.guessedRight - a.guessedRight || b.guessers - a.guessers)
    .slice(0, NARRATOR_TUNING.maxLookChains);
  for (const chain of chains) {
    if (slides.length >= NARRATOR_TUNING.maxSlides) break;
    const slide = slideForLookChain(chain, ps);
    if (slide) slides.push(slide);
  }

  // The quickest finger.
  if (slides.length < NARRATOR_TUNING.maxSlides) {
    const stat = slideForStat(digest, ps);
    if (stat) slides.push(stat);
  }

  return slides.slice(0, NARRATOR_TUNING.maxSlides);
}

/** The summary line the reveal header shows. */
export function summaryFor(results: Results, ps: Pseudonyms): { couple?: string; core?: string; hates?: string } {
  const out: { couple?: string; core?: string; hates?: string } = {};
  for (const verdict of results.verdicts) {
    const name = verdict.subjects[0];
    const token = name !== undefined ? ps.byId.get(name) : undefined;
    if (!token) continue;
    if (verdict.kind === "couple" && !out.couple && !isNeverCouple(verdict)) out.couple = token;
    if (verdict.kind === "core" && !out.core) out.core = token;
    if (verdict.kind === "hates" && !out.hates) out.hates = token;
  }
  return out;
}

export { pseudonym };
export type { PlayerId };
