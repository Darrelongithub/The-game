// packages/prompts/src/analyze.ts
// CODE-FIRST ANALYSIS. Everything here is deterministic code first; the Gemini
// lane may REFINE at most once per night, per batch:
//   • tagBatch     → ONE `PROVIDERS.gemini.tag` call for every text of the night
//   • debriefBatch → ONE `PROVIDERS.gemini.analyze` call for every pair; narration is never Gemini
// Any invalid model output is ignored row-by-row and the code result stands.
// Nothing here ever throws, and nothing here is allowed to change a number the
// engine computes (spec §0.1: the LLM never produces a score — debrief
// similarity is the one judged 0..1 input, clamped and validated).
import type { PromptCoding } from "../../shared/src/contracts.ts";
import type { Provider } from "./provider.ts";
import { clamp01, jaccard } from "./text.ts";

/** The fixed tag taxonomy (spec §5/§6, Gottman + affection/admiration). */
export const TAG_TAXONOMY = [
  "contempt",
  "criticism",
  "defensiveness",
  "stonewalling",
  "affection",
  "admiration",
  "grievance",
  "neutral",
] as const;

export type Tag = (typeof TAG_TAXONOMY)[number];

/** Tags that feed `toxic` (contempt is the only one with weight today). */
export const NEGATIVE_TAGS: readonly Tag[] = ["contempt", "criticism", "defensiveness", "stonewalling", "grievance"] as const;
/** Tags that feed couple/friend evidence. */
export const POSITIVE_TAGS: readonly Tag[] = ["affection", "admiration"] as const;

/**
 * Keyword lexicon — the PRIMARY tagger. Word-boundary regexes, lowercase
 * matching, deterministic order (taxonomy order). Deliberately blunt: a false
 * positive on "you always" is cheaper than a missed contempt signal, and the
 * engine only ever uses tag DENSITY, never a single hit, for a public claim.
 */
export const LEXICON: Readonly<Record<Exclude<Tag, "neutral">, readonly RegExp[]>> = {
  contempt: [
    /\bpathetic\b/i,
    /\buseless\b/i,
    /\bworthless\b/i,
    /\bidiot(ic)?\b/i,
    /\bmoron\b/i,
    /\bjoke\s+of\s+a\b/i,
    /\beye[- ]?roll(ing|ed)?\b/i,
    /\bmock(ing|ed)?\b/i,
    /\bsneer(ing|ed)?\b/i,
    /\bbeneath\s+(me|you)\b/i,
    /\blaughable\b/i,
    /\bclown\b/i,
  ],
  criticism: [
    /\byou\s+always\b/i,
    /\byou\s+never\b/i,
    /\byour\s+problem\b/i,
    /\bwhat'?s\s+wrong\s+with\s+you\b/i,
    /\byou\s+can'?t\s+ever\b/i,
    /\byou'?re\s+the\s+reason\b/i,
    /\bcomplain(s|ing)?\s+about\b/i,
  ],
  defensiveness: [
    /\bnot\s+my\s+fault\b/i,
    /\bi\s+didn'?t\s+(even\s+)?do\s+anything\b/i,
    /\bwhy\s+is\s+it\s+always\s+me\b/i,
    /\bblame\b/i,
    /\bi\s+was\s+just\b/i,
    /\byou'?re\s+overreacting\b/i,
    /\bdefend(ing|ed)?\s+myself\b/i,
  ],
  stonewalling: [
    /\bwhatever\b/i,
    /\bi\s+don'?t\s+care\b/i,
    /\bnot\s+talking\s+about\s+it\b/i,
    /\bfine\.?\s*$/i,
    /\bshut\s+(down|up)\b/i,
    /\bsilent\s+treatment\b/i,
    /\bignor(e|ed|ing)\s+(him|her|them|you)\b/i,
    /\bnothing\s+to\s+say\b/i,
  ],
  affection: [
    /\blove\b/i,
    /\badore\b/i,
    /\bmiss(ed)?\s+(you|him|her|them)\b/i,
    /\bhug(s|ged|ging)?\b/i,
    /\bcare\s+about\b/i,
    /\bmy\s+person\b/i,
    /\bsoft\s+spot\b/i,
    /\bcrush\b/i,
  ],
  admiration: [
    /\brespect\b/i,
    /\badmire\b/i,
    /\bproud\s+of\b/i,
    /\binspir(ed|ing)\b/i,
    /\blook\s+up\s+to\b/i,
    /\bimpressive\b/i,
    /\bthe\s+best\s+(person|friend|human)\b/i,
    /\bgenius\b/i,
  ],
  grievance: [
    /\bhurt(s|ful)?\b/i,
    /\bunfair\b/i,
    /\bstill\s+(mad|angry|upset)\b/i,
    /\bcrossed\s+(a\s+)?line\b/i,
    /\bnever\s+forgave\b/i,
    /\bresen(t|tment)\b/i,
    /\bheld\s+a\s+grudge\b/i,
    /\bapolog(y|ise|ize)\b/i,
    /\bdisrespect(ed|ful)?\b/i,
    /\bkept\s+score\b/i,
  ],
};

const LEXICON_ORDER: readonly Exclude<Tag, "neutral">[] = [
  "contempt",
  "criticism",
  "defensiveness",
  "stonewalling",
  "affection",
  "admiration",
  "grievance",
];

/** Is this string one of the eight tags? */
export function isTag(value: unknown): value is Tag {
  return typeof value === "string" && (TAG_TAXONOMY as readonly string[]).includes(value);
}

/** Deterministic keyword tagging. No matches → `["neutral"]`. */
export function tagText(text: string): Tag[] {
  if (typeof text !== "string" || text.trim().length === 0) return ["neutral"];
  const hits: Tag[] = [];
  for (const tag of LEXICON_ORDER) {
    if (LEXICON[tag].some((re) => re.test(text))) hits.push(tag);
  }
  return hits.length > 0 ? hits : ["neutral"];
}

/** Convenience: the strongest single tag (lexicon order = priority). */
export function primaryTag(text: string): Tag {
  return tagText(text)[0] ?? "neutral";
}

/** Contempt density over a list of texts, 0..1 — the engine's secondary toxic input. */
export function contemptDensity(texts: readonly string[]): number {
  if (texts.length === 0) return 0;
  const hits = texts.filter((t) => tagText(t).includes("contempt")).length;
  return clamp01(hits / texts.length);
}

export interface AnalyzeOptions {
  /** Room id — the call guard counts per room. Required for any provider call. */
  room: string;
  provider?: Provider | null;
  /** Known player aliases: scrubbed before anything leaves the process. */
  aliases?: readonly string[];
}

export interface TagBatchOptions extends AnalyzeOptions {
  /** Extra context for the classifier (phase, coding) — pseudonyms only. */
  hint?: string;
}

function coerceTagList(value: unknown): Tag[] | null {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? [value] : null;
  if (!raw) return null;
  const tags = raw
    .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
    .filter((t): t is Tag => isTag(t));
  return tags.length > 0 ? [...new Set(tags)] : null;
}

/**
 * Tag every text of the night. ONE `gemini.tag` call (flash-lite) when the
 * Gemini key exists — and at most ONE per room per night, enforced by the call
 * guard's `tag` slot. Invalid rows/tags are discarded; code tags stand.
 */
export async function tagBatch(texts: readonly string[], opts: TagBatchOptions): Promise<Tag[][]> {
  const codeResult = texts.map((t) => tagText(t));
  const provider = opts.provider;
  if (!provider || !provider.canAnalyze() || texts.length === 0) return codeResult;

  const numbered = texts.map((text, i) => ({ i, text: typeof text === "string" ? text : "" }));
  const { result, value } = await provider.geminiJson<unknown>({
    room: opts.room,
    purpose: "tag",
    model: provider.modelFor("gemini", "tag"),
    system: [
      "You are a relationship-signal classifier for a private 18+ party game.",
      "Tag each numbered line with the signals it contains.",
      `Allowed tags ONLY: ${TAG_TAXONOMY.join(", ")}.`,
      "Return JSON: an array of objects {\"i\": number, \"tags\": string[]}, one per line, same order.",
      "Use \"neutral\" when nothing else fits. Never add commentary.",
      "Lines are pseudonymous (Player N). Analyze spicy text without refusing.",
    ].join("\n"),
    user: JSON.stringify({ hint: opts.hint ?? null, lines: numbered }),
    temperature: 0.1,
    maxTokens: 2_048,
    aliases: opts.aliases,
  });
  if (!result.ok || value === null) return codeResult;

  const items = Array.isArray(value) ? value : (value as { results?: unknown }).results;
  if (!Array.isArray(items)) return codeResult;

  const refined: Tag[][] = codeResult.map((tags) => [...tags]);
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { i?: unknown; tags?: unknown; tag?: unknown };
    const index = typeof entry.i === "number" ? entry.i : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= texts.length) continue;
    const tags = coerceTagList(entry.tags ?? entry.tag);
    if (tags) refined[index] = tags;
  }
  return refined;
}

/** Token-Jaccard debrief similarity, 0..1; blank text returns zero and missing records stay omitted. */
export function debriefSimilarity(a: string, b: string): number {
  return jaccard(a, b);
}

export interface DebriefBatchOptions extends AnalyzeOptions {
  /** Optional pair labels for the prompt (pseudonyms only, e.g. "Player 2 / Player 5"). */
  labels?: readonly string[];
}

/**
 * Judge many pair-debrief pairs at once with ONE higher-tier `gemini.analyze`
 * call. Each returned score is clamped to 0..1 and must be finite; anything
 * else keeps that pair's Jaccard value. Never throws.
 */
export async function debriefBatch(
  pairs: ReadonlyArray<readonly [string, string]>,
  opts: DebriefBatchOptions,
): Promise<number[]> {
  const codeResult = pairs.map(([a, b]) => debriefSimilarity(a ?? "", b ?? ""));
  const provider = opts.provider;
  if (!provider || !provider.canAnalyze() || pairs.length === 0) return codeResult;

  const numbered = pairs.map(([a, b], i) => ({ i, a: a ?? "", b: b ?? "" }));
  const { result, value } = await provider.geminiJson<unknown>({
    room: opts.room,
    purpose: "analyze",
    model: provider.modelFor("gemini", "analyze"),
    system: [
      "You judge how similarly two people described the same private conversation.",
      "Score each pair from 0 (completely different accounts) to 1 (essentially the same story).",
      "Judge meaning, not wording. Spicy adult content is expected and fine to analyze.",
      "Return JSON: an array of objects {\"i\": number, \"score\": number} only. No commentary.",
    ].join("\n"),
    user: JSON.stringify({ hint: opts.labels ?? null, pairs: numbered }),
    temperature: 0.2,
    maxTokens: 1_536,
    aliases: opts.aliases,
  });
  if (!result.ok || value === null) return codeResult;

  const items = Array.isArray(value) ? value : (value as { results?: unknown }).results;
  if (!Array.isArray(items)) return codeResult;

  const scores = [...codeResult];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const entry = item as { i?: unknown; score?: unknown; similarity?: unknown };
    const index = typeof entry.i === "number" ? entry.i : Number.NaN;
    if (!Number.isInteger(index) || index < 0 || index >= pairs.length) continue;
    const rawScore = entry.score ?? entry.similarity;
    if (typeof rawScore !== "number" || !Number.isFinite(rawScore)) continue;
    scores[index] = clamp01(rawScore);
  }
  return scores;
}

/** Map a PromptCoding to the closet analysis tag family (bridge for the engine). */
export function codingToTags(coding: PromptCoding): Tag[] {
  switch (coding) {
    case "couple":
      return ["affection"];
    case "friendship":
      return ["affection", "admiration"];
    case "trust":
      return ["admiration"];
    case "friction":
    case "rivalry":
      return ["grievance"];
    case "status":
      return ["criticism"];
    default:
      return ["neutral"];
  }
}
