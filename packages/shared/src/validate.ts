// packages/shared/src/validate.ts
// Minimal runtime guards shared by server, engine, mock transport, and selfcheck.
import {
  DARE_REASON_MAX_CHARS,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  MIN_PLAYERS,
  MAX_PLAYERS,
  SHORT_TEXT_MAX_CHARS,
  TEXT_MAX_CHARS,
  TRAITS,
  type Attraction,
  type Gender,
  type ProfileAnswers,
  type ResponseValue,
  type Sexuality,
  type TraitId,
  type PlayerId,
} from "./contracts.ts";

export const isRoomCode = (code: string): boolean =>
  typeof code === "string" &&
  code.length === ROOM_CODE_LENGTH &&
  [...code].every((c) => ROOM_CODE_ALPHABET.includes(c));

export const isAlias = (alias: string): boolean =>
  typeof alias === "string" && alias.trim().length >= 2 && alias.trim().length <= 14;

export const playerCountOk = (n: number): boolean =>
  Number.isInteger(n) && n >= MIN_PLAYERS && n <= MAX_PLAYERS;

const intInRange = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= lo && n <= hi;

export const GENDERS: readonly Gender[] = ["woman", "man", "nonbinary", "other", "undisclosed"];
export const SEXUALITIES: readonly Sexuality[] = ["straight", "gay", "bi", "pan", "queer", "asexual", "other", "undisclosed"];
export const ATTRACTIONS: readonly Attraction[] = ["women", "men", "everyone", "nobody", "undisclosed"];

export function isProfileAnswers(v: unknown): v is ProfileAnswers {
  if (!v || typeof v !== "object") return false;
  const p = v as ProfileAnswers;
  return (
    intInRange(p.age, 18, 120) &&
    GENDERS.includes(p.gender) &&
    SEXUALITIES.includes(p.sexuality) &&
    ATTRACTIONS.includes(p.attractedTo)
  );
}

export function isResponseValue(v: unknown): v is ResponseValue {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  switch (r.kind) {
    case "pick":
      return typeof r.target === "string" && r.target.length > 0;
    case "pair_pick":
      return Array.isArray(r.pair) && r.pair.length === 2 &&
        r.pair.every((p) => typeof p === "string" && p.length > 0);
    case "pair_vote":
      return Array.isArray(r.pair) && r.pair.length === 2 &&
        r.pair.every((p) => typeof p === "string" && p.length > 0) &&
        intInRange(r.value, 1, 5);
    case "text":
      return typeof r.text === "string" && r.text.trim().length > 0 && r.text.length <= TEXT_MAX_CHARS;
    case "rating":
      return TRAITS.includes(r.trait as TraitId) &&
        (r.about === "self" || typeof r.about === "string") &&
        intInRange(r.value, 1, 10);
    case "dare":
      return r.status === "done" ||
        (r.status === "passed" &&
          typeof r.reason === "string" &&
          r.reason.trim().length > 0 &&
          r.reason.length <= DARE_REASON_MAX_CHARS);
    default:
      return false;
  }
}

/**
 * Directed answers about others must target someone else — never yourself.
 * (PlayerId must never be the literal "self"; see contracts.ts.)
 */
export function targetsOther(v: ResponseValue, self: PlayerId): boolean {
  switch (v.kind) {
    case "pick":   return v.target !== self;
    case "rating": return v.about === "self" ? true : v.about !== self;
    case "pair_pick": return !v.pair.includes(self);
    case "pair_vote": return !v.pair.includes(self);
    default:       return true; // text / dare are not directed
  }
}

/** Full submit check — the server runs this before accepting any answer. */
export function validSubmit(v: unknown, self: PlayerId): boolean {
  return isResponseValue(v) && targetsOther(v, self);
}

export { SHORT_TEXT_MAX_CHARS };
