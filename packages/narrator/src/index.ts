// packages/narrator/src/index.ts — Agent E public surface.
//
// The server (Agent F) needs exactly two calls:
//
//   const skeleton = buildSkeleton(results, digest, meta.players);
//   const { slides, decks } = await writeFinale(skeleton, secrets, results, digest, { roster: meta.players });
//   emit finale { slides, summary }  →  then per-socket secrets { cards }
//
// …or the one-call facade:
//
//   const { slides, decks } = await narrateNight({ results, digest, decks, roster: meta.players });
//
// `slides` are broadcast-safe: public only, "Player N" tokens only.
// `applyAliasesToSlides` / `applyAliasesToDecks` do the deterministic
// "Player N" → alias swap the server owns (spec §7). `decks` must only ever be
// emitted to the owning socket.

export {
  buildSkeleton,
  clip,
  bodyFromEvidence,
  isPublishable,
  pickContradiction,
  sourceOf,
  registerSource,
  conservativeSource,
  normalizeTitle,
  NARRATOR_TUNING,
} from "./slides.ts";
export type { SkeletonSource } from "./slides.ts";

export { writeFinale, narrateNight } from "./write.ts";
export type { WriteOptions, FinaleCopy } from "./write.ts";

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

export { callGemini, parseJsonLoose, readGeminiKey, GEMINI_API_BASE, DEFAULT_TIMEOUT_MS } from "./gemini.ts";
export type { GeminiRequest, GeminiResult } from "./gemini.ts";

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
