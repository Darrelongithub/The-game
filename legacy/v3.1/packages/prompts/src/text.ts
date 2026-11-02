// packages/prompts/src/text.ts
// Deterministic text helpers shared by the filter (dedupe) and the code-first
// analysis layer (token-Jaccard debrief similarity). Pure, no I/O, no config.

/**
 * Short English stopword list. Token-Jaccard is the spec's PRIMARY similarity
 * measure; dropping function words keeps "we talked about the thing" and
 * "we discussed the thing" closer than two unrelated sentences that share
 * "the". Deterministic and documented — never model-dependent.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at",
  "be", "because", "been", "before", "being", "but", "by",
  "can", "could", "did", "do", "does", "doing", "dont", "don't", "down",
  "each", "even", "ever", "for", "from", "get", "got",
  "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how",
  "i", "if", "im", "i'm", "in", "into", "is", "it", "its", "it's",
  "just", "know", "like", "me", "more", "most", "my",
  "no", "not", "now", "of", "off", "on", "once", "one", "only", "or", "other", "our", "out", "over",
  "really", "said", "same", "say", "she", "should", "so", "some", "still", "such",
  "than", "that", "the", "their", "them", "then", "there", "these", "they", "thing", "things",
  "this", "those", "through", "to", "too", "under", "up", "us", "very", "was", "we", "were",
  "what", "when", "where", "which", "while", "who", "why", "will", "with", "would", "you",
  "your", "you're", "yours",
]);

/** Lowercase word tokens: punctuation stripped, stopwords and 1-char tokens dropped. */
export function tokenize(text: string): string[] {
  if (typeof text !== "string" || text.trim().length === 0) return [];
  const words = text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}'\s-]/gu, " ")
    .split(/\s+/);
  const out: string[] = [];
  for (const raw of words) {
    const token = raw.replace(/^-+|-+$/g, "").replace(/^'+|'+$/g, "");
    if (token.length < 2) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/** Token multiset → set, for Jaccard. */
export function tokenSet(text: string): Set<string> {
  return new Set(tokenize(text));
}

/**
 * Token-set Jaccard, 0..1. Blank inputs return zero; callers track missing
 * data separately rather than encoding it as an invented midpoint.
 */
export function jaccard(a: string, b: string): number {
  const textA = typeof a === "string" ? a : "";
  const textB = typeof b === "string" ? b : "";
  const setA = tokenSet(textA);
  const setB = tokenSet(textB);
  if (setA.size === 0 && setB.size === 0) return 0;
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const token of setA) if (setB.has(token)) inter += 1;
  const union = setA.size + setB.size - inter;
  if (union === 0) return 0;
  return clamp01(inter / union);
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Whitespace-, case- and punctuation-insensitive key for exact-duplicate checks. */
export function normalizeForDedupe(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
