// packages/narrator/src/index.ts — public surface.
//
// The server needs exactly two calls:
//
//   const ps = derivePseudonyms(results, digest, meta.players);
//   const skeleton = buildSkeleton(results, digest, ps);
//   const { slides, decks } = await writeFinale(skeleton, decks, results, digest, { roster: meta.players });
//   emit finale { slides }  →  then per-socket secrets { cards }
//
// …or the one-call facade:
//
//   const { slides, decks } = await narrateNight(results, digest, decks, { roster: meta.players });
//
// `slides` are broadcast-safe: public only, "Player N" tokens only.
// `applyAliasesToSlides` / `applyAliasesToDecks` do the deterministic
// "Player N" → alias swap the server owns. `decks` must only ever be emitted
// to the owning socket.
export {
  buildSkeleton,
  clip,
  isNeverCouple,
  slideForLookChain,
  slideForVerdict,
  slideForQuote,
  slideForDodge,
  slideForStat,
  summaryFor,
  isPublishable,
  sourceOf,
  registerSource,
  conservativeSource,
  NARRATOR_TUNING,
  type SkeletonSource,
} from "./slides.ts";

export { writeFinale, narrateNight, flattenCards, buildRequestPayload, mergeSlides, mergeCards, normalizeTitle, SYSTEM_PROMPT } from "./write.ts";
export type { WriteOptions, FinaleCopy, FlatCard } from "./write.ts";

export {
  BANNED_PHRASES,
  LIMITS,
  digitTokens,
  digitsIn,
  findAlias,
  findBannedPhrase,
  findIllegalNumber,
  findIllegalPlayerReference,
  looksLikeRefusal,
  playerTokensIn,
  validateBody,
  validateCardTitle,
  validateCopy,
  validateFact,
  validateTitle,
} from "./validate.ts";
export type { CopyCheck, CopyLimits } from "./validate.ts";

export {
  collectPlayerIds,
  derivePseudonyms,
  naturalCompare,
  normAlias,
  pseudonymForAlias,
  pseudonymOf,
  scrubAliases,
  swapPseudonyms,
  toRoster,
} from "./roster.ts";
export type { Pseudonyms, RosterEntry, RosterInput } from "./roster.ts";

import type { FinaleSlide, PlayerId, SecretCard } from "../../shared/src/contracts.ts";
import { swapPseudonyms, type RosterEntry } from "./roster.ts";

/** "Player N" → alias for broadcast-safe public slides (server-side). */
export function applyAliasesToSlides(
  slides: readonly FinaleSlide[],
  roster: readonly RosterEntry[] | undefined,
): FinaleSlide[] {
  return slides.map((slide) => {
    const next: FinaleSlide = { ...slide, title: swapPseudonyms(slide.title, roster) };
    if (typeof slide.body === "string") next.body = swapPseudonyms(slide.body, roster);
    return next;
  });
}

/** "Player N" → alias inside secret-card copy. Emit to ONE socket only. */
export function applyAliasesToDecks(
  decks: Map<PlayerId, SecretCard[]>,
  roster: readonly RosterEntry[] | undefined,
): Map<PlayerId, SecretCard[]> {
  const out = new Map<PlayerId, SecretCard[]>();
  for (const [playerId, cards] of decks) {
    out.set(
      playerId,
      cards.map((card) => ({
        ...card,
        title: swapPseudonyms(card.title, roster),
        facts: card.facts.map((fact) => swapPseudonyms(fact, roster)),
      })),
    );
  }
  return out;
}
