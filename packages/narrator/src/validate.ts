// packages/narrator/src/validate.ts
// The gate every model string must pass before it reaches a phone.
//
// Hard rules (spec §7 + agent-E scope):
//   • numbers ONLY from the claim's `numbers` (the "Player 3" token format is
//     stripped before the digit scan — that label is not a number);
//   • players ONLY as `Player \d+` (never "Player One", never a real alias);
//   • no clinical / psychology / rom-com vocabulary (banned phrases);
//   • title ≤ 6 words, body ≤ 140 chars, secret fact ≤ 120 chars;
//   • never empty, never a provider refusal masquerading as copy.
//
// Anything rejected falls back to the engine string for that slide/fact — the
// show never stops.

export const BANNED_PHRASES: readonly string[] = [
  // required by the agent-E scope
  "toxic person",
  "red flag",
  "soulmate",
  "science says",
  "love language",
  "diagnos", // diagnosis / diagnose / diagnostic
  "narcissis", // narcissist / narcissistic
  "therapy",
  // extensions: the narrator is "never clinical"
  "gaslight",
  "attachment style",
  "trauma bond",
  "abuser",
  "abusive",
  "clinical",
];

export const LIMITS = {
  titleMaxChars: 72,
  titleMaxWords: 6,
  bodyMaxChars: 140,
  factMaxChars: 120,
  cardTitleMaxChars: 60,
  factsPerCard: 4,
} as const;

export interface CopyLimits {
  maxChars: number;
  maxWords?: number;
  /** Digit strings the model is allowed to repeat (claim.numbers + engine text). */
  numbers?: ReadonlySet<string>;
  /** "Player N" tokens this particular slide may use. */
  players?: ReadonlySet<string>;
  /** Size of the roster — anything above it is invented. */
  maxPlayer?: number;
  /** Real aliases that must never appear in narration copy. */
  aliases?: readonly string[];
}

export type CopyCheck =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const PLAYER_TOKEN = /\bplayer\s+\d+\b/gi;
/** Any "player <something>" mention — used to reject non-pseudonym references. */
const PLAYER_MENTION = /\bplayer\s+([^\s,.;:!?)\]}"'…—–-]+)/gi;
const DIGITS = /\d+(?:[.,]\d+)?/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const WHITESPACE = /\s+/;

const REFUSALS: readonly string[] = [
  "as an ai",
  "i'm sorry, but",
  "im sorry, but",
  "i cannot help",
  "i can't help with",
  "i am unable to",
  "i'm unable to",
  "i can’t help with",
];

/** All digit tokens in free text, ignoring "Player N" labels. */
export function digitTokens(text: string): string[] {
  const stripped = text.replace(PLAYER_TOKEN, " ");
  return stripped.match(DIGITS) ?? [];
}

export function digitsIn(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) for (const token of digitTokens(text)) out.add(token);
  return out;
}

const canonicalPlayer = (match: string): string => {
  const digits = match.match(/\d+/) as RegExpMatchArray;
  return `Player ${digits[0]}`;
};

/** Every canonical "Player N" token in free text. */
export function playerTokensIn(texts: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const match of text.match(PLAYER_TOKEN) ?? []) out.add(canonicalPlayer(match));
  }
  return out;
}

export function findBannedPhrase(text: string): string | undefined {
  const haystack = text.toLowerCase();
  return BANNED_PHRASES.find((phrase) => haystack.includes(phrase));
}

/** First digit token that is not whitelisted (undefined = clean). */
export function findIllegalNumber(
  text: string,
  allowed: ReadonlySet<string> | undefined,
): string | undefined {
  if (!allowed) return undefined;
  return digitTokens(text).find((token) => !allowed.has(token));
}

/**
 * First player reference that is not a valid pseudonym:
 *   • "Player Eric", "Player One" → not the `Player \d+` format;
 *   • "Player 12" in a 6-player room → invented player;
 *   • "Player 5" on a slide about Players 2 and 3 → wrong subject.
 */
export function findIllegalPlayerReference(
  text: string,
  allowed: ReadonlySet<string> | undefined,
  maxPlayer: number | undefined,
): string | undefined {
  for (const match of text.matchAll(PLAYER_MENTION)) {
    const raw = match[0];
    const tail = match[1] ?? "";
    if (!/^\d+$/.test(tail)) return raw.trim();
    const n = Number(tail);
    if (maxPlayer !== undefined && (n < 1 || n > maxPlayer)) return raw.trim();
    const token = `Player ${n}`;
    if (allowed && allowed.size > 0 && !allowed.has(token)) return raw.trim();
    if (allowed && allowed.size === 0) return raw.trim();
  }
  return undefined;
}

/** First real alias found in narration copy (undefined = clean). */
export function findAlias(
  text: string,
  aliases: readonly string[] | undefined,
): string | undefined {
  if (!aliases || aliases.length === 0) return undefined;
  const haystack = text.toLowerCase();
  return aliases.find((alias) => {
    const needle = alias.trim().toLowerCase();
    if (needle.length < 2) return false;
    const at = haystack.indexOf(needle);
    if (at === -1) return false;
    const before = at === 0 ? " " : (haystack[at - 1] as string);
    const after = at + needle.length >= haystack.length ? " " : (haystack[at + needle.length] as string);
    const isWord = (ch: string) => /[a-z0-9]/.test(ch);
    return !isWord(before) && !isWord(after);
  });
}

export function looksLikeRefusal(text: string): boolean {
  const haystack = text.toLowerCase();
  return REFUSALS.some((phrase) => haystack.includes(phrase));
}

const words = (text: string): number =>
  text.split(WHITESPACE).filter((word) => word.length > 0).length;

/** Validate one model string. Returns the trimmed text or the rejection reason. */
export function validateCopy(raw: unknown, limits: CopyLimits): CopyCheck {
  if (typeof raw !== "string") return { ok: false, reason: "not-a-string" };
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length === 0) return { ok: false, reason: "empty" };
  if (CONTROL_CHARS.test(text)) return { ok: false, reason: "control-chars" };
  if (text.length > limits.maxChars) return { ok: false, reason: "too-long" };
  if (limits.maxWords !== undefined && words(text) > limits.maxWords) {
    return { ok: false, reason: "too-many-words" };
  }
  if (looksLikeRefusal(text)) return { ok: false, reason: "refusal" };

  const banned = findBannedPhrase(text);
  if (banned) return { ok: false, reason: `banned-phrase:${banned}` };

  const illegalNumber = findIllegalNumber(text, limits.numbers);
  if (illegalNumber) return { ok: false, reason: `invented-number:${illegalNumber}` };

  const illegalPlayer = findIllegalPlayerReference(text, limits.players, limits.maxPlayer);
  if (illegalPlayer) return { ok: false, reason: `bad-player-ref:${illegalPlayer}` };

  const alias = findAlias(text, limits.aliases);
  if (alias) return { ok: false, reason: `real-alias:${alias}` };

  return { ok: true, text };
}

export const validateTitle = (raw: unknown, limits: Omit<CopyLimits, "maxChars">): CopyCheck =>
  validateCopy(raw, {
    ...limits,
    maxChars: LIMITS.titleMaxChars,
    maxWords: limits.maxWords ?? LIMITS.titleMaxWords,
  });

export const validateBody = (raw: unknown, limits: Omit<CopyLimits, "maxChars">): CopyCheck =>
  validateCopy(raw, { ...limits, maxChars: LIMITS.bodyMaxChars });

export const validateFact = (raw: unknown, limits: Omit<CopyLimits, "maxChars">): CopyCheck =>
  validateCopy(raw, { ...limits, maxChars: LIMITS.factMaxChars });

export const validateCardTitle = (
  raw: unknown,
  limits: Omit<CopyLimits, "maxChars" | "maxWords">,
): CopyCheck => validateCopy(raw, { ...limits, maxChars: LIMITS.cardTitleMaxChars });
