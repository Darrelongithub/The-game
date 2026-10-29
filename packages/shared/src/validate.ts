// packages/shared/src/validate.ts
// Minimal runtime guards shared by server, engine, mock transport, and selfcheck.
import {
  ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, MIN_PLAYERS, MAX_PLAYERS,
  TRAITS, type ResponseValue, type TraitId, type PlayerId,
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

export function isResponseValue(v: unknown): v is ResponseValue {
  if (v === null || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  switch (r.kind) {
    case "pick":
      return typeof r.target === "string" && r.target.length > 0;
    case "text":
      return typeof r.text === "string" && r.text.trim().length > 0 && r.text.length <= 280;
    case "shout":
      return typeof r.word === "string" && r.word.trim().length > 0 && r.word.length <= 24;
    case "rating":
      return TRAITS.includes(r.trait as TraitId) &&
        (r.about === "self" || typeof r.about === "string") &&
        intInRange(r.value, 1, 10);
    case "ios":
      return typeof r.about === "string" && intInRange(r.value, 1, 7);
    case "minigame":
      return typeof r.score === "number" && Number.isFinite(r.score) && r.score >= 0 && r.score < 1000;
    case "dare":
      return r.status === "done" ||
        (r.status === "passed" &&
          typeof r.reason === "string" && r.reason.trim().length > 0 && r.reason.length <= 140);
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
    case "ios":    return v.about !== self;
    case "rating": return v.about === "self" ? true : v.about !== self;
    default:       return true; // text / shout / minigame / dare are not directed
  }
}

/** Full submit check — the server runs this before accepting any answer. */
export function validSubmit(v: unknown, self: PlayerId): boolean {
  return isResponseValue(v) && targetsOther(v, self);
}
