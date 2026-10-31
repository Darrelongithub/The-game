// packages/prompts/src/trait.ts
// Rating rounds are about ONE trait (spec §3/§5), but the Prompt contract has
// no `trait` field yet (contract request filed by Agent D). Until it lands,
// every rating prompt carries a `trait:<id>` measure — deterministic, readable
// by the server/UI, and harmless to the engine.
import { TRAITS, type TraitId } from "../../shared/src/contracts.ts";

export const TRAIT_MEASURE_PREFIX = "trait:";

const TRAIT_HINTS: Readonly<Record<TraitId, readonly RegExp[]>> = {
  loyalty: [/\bloyal\w*/i, /\bkeep(s|ing)?\s+a?\s*secret/i, /\bsecret[- ]keeper/i, /\bfaithful\b/i, /\bback(s|ed)?\s+you\b/i],
  chaos: [/\bchaos\b/i, /\bchaotic\b/i, /\bunpredictable\b/i, /\bwild\b/i, /\bmes(s|y)\b/i, /\breckless\b/i, /\bspontaneous\b/i],
  reliability: [/\breliab\w*/i, /\bdependab\w*/i, /\bshow(s|ed)?\s+up\b/i, /\bon\s+time\b/i, /\bconsistent\b/i, /\bflak(e|ey)\b/i],
  warmth: [/\bwarm\w*/i, /\bkind\w*/i, /\bcaring\b/i, /\baffectionate\b/i, /\bcold\b/i, /\bsoft\b/i, /\blisten(?:s|ing)?\b/i],
  honesty: [/\bhonest\w*/i, /\btruth\w*/i, /\blie(s|d)?\b/i, /\bhonesty\b/i, /\bbs\b/i],
  spice: [/\bspic\w*/i, /\bfreak\w*/i, /\brizz\b/i, /\bflirt\w*/i, /\bdesire\b/i, /\bsexual\b/i, /\btension\b/i, /\bcrush\w*/i],
};

/** Best-effort deterministic trait read from a prompt's wording. */
export function inferTrait(text: string): TraitId | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  let best: { trait: TraitId; hits: number } | null = null;
  for (const trait of TRAITS) {
    const hits = TRAIT_HINTS[trait].filter((re) => re.test(text)).length;
    if (hits > 0 && (!best || hits > best.hits)) best = { trait, hits };
  }
  return best?.trait ?? null;
}

/** The trait a prompt is about: explicit `trait:` measure first, wording second. */
export function traitOfPrompt(prompt: { measures?: readonly string[]; text?: string }): TraitId | null {
  for (const measure of prompt.measures ?? []) {
    const value = measure.trim().toLowerCase();
    if (value.startsWith(TRAIT_MEASURE_PREFIX)) {
      const trait = value.slice(TRAIT_MEASURE_PREFIX.length);
      if ((TRAITS as readonly string[]).includes(trait)) return trait as TraitId;
    }
  }
  return inferTrait(prompt.text ?? "");
}
