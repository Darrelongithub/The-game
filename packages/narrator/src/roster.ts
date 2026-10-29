// packages/narrator/src/roster.ts
// Pseudonymization crosswalk.
//
// Two halves of the contract speak different languages:
//   • claims / pairScores / freeAgent are keyed by PlayerId ("p3")
//   • NightDigest quotes / dodges / stats are keyed by REAL alias ("Maya")
// The narrator must emit "Player N" ONLY (spec §7), and the server swaps those
// tokens back to aliases after narration. This module is the crosswalk.
//
// Without a roster we refuse to guess: an alias that has no roster entry gets
// NO pseudonym (attribution is dropped) — a wrong "Player 3" on someone's
// phone is worse than no name at all.

import {
  pseudonym,
  type NightDigest,
  type PlayerId,
  type Results,
} from "../../shared/src/contracts.ts";

export interface RosterEntry {
  id: PlayerId;
  alias: string;
}

/** RoomMeta-ish objects are accepted directly so the server can pass `meta`. */
export type RosterInput =
  | readonly RosterEntry[]
  | { readonly players: readonly RosterEntry[] }
  | undefined
  | null;

export interface Pseudonyms {
  /** PlayerIds in pseudonym order: index i ↔ pseudonym(i) = `Player ${i + 1}`. */
  order: readonly PlayerId[];
  byId: ReadonlyMap<PlayerId, string>;
  byAlias: ReadonlyMap<string, string>;
}

export const normAlias = (alias: string): string => alias.trim().toLowerCase();

/** Deterministic, ICU-independent natural compare (p2 < p10). */
export function naturalCompare(a: string, b: string): number {
  const ta = a.match(/\d+|\D+/g) ?? [];
  const tb = b.match(/\d+|\D+/g) ?? [];
  const shared = Math.min(ta.length, tb.length);
  for (let i = 0; i < shared; i += 1) {
    const x = ta[i] as string;
    const y = tb[i] as string;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const delta = Number(x) - Number(y);
      if (delta !== 0) return delta;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ta.length - tb.length;
}

/** Every player the engine mentioned anywhere in Results. */
export function collectPlayerIds(results: Results): PlayerId[] {
  const seen = new Set<PlayerId>();
  for (const claim of results.claims) for (const id of claim.subjects) seen.add(id);
  for (const pair of results.pairScores) {
    seen.add(pair.a);
    seen.add(pair.b);
  }
  if (results.freeAgent) seen.add(results.freeAgent);
  return [...seen].sort(naturalCompare);
}

export function toRoster(input?: RosterInput): readonly RosterEntry[] | undefined {
  if (!input) return undefined;
  if (Array.isArray(input)) {
    const entries = input as readonly RosterEntry[];
    return entries.length > 0 ? entries : undefined;
  }
  const players = (input as { players?: readonly RosterEntry[] }).players;
  return Array.isArray(players) && players.length > 0 ? players : undefined;
}

/**
 * Build the PlayerId → "Player N" map.
 *
 * With a roster we trust the server's join order (that is what `pseudonym()`
 * means everywhere else). Without one we fall back to a natural sort of the
 * ids the engine touched — deterministic, and identical to the join order for
 * the server's `p1..p11` ids.
 */
export function derivePseudonyms(
  results: Results,
  _digest: NightDigest | undefined,
  input?: RosterInput,
): Pseudonyms {
  const roster = toRoster(input);
  const order: PlayerId[] = roster
    ? roster.map((entry) => entry.id)
    : collectPlayerIds(results);

  const byId = new Map<PlayerId, string>();
  order.forEach((id, index) => byId.set(id, pseudonym(index)));

  const byAlias = new Map<string, string>();
  if (roster) {
    for (const entry of roster) {
      const token = byId.get(entry.id);
      if (token && typeof entry.alias === "string" && entry.alias.trim().length > 0) {
        byAlias.set(normAlias(entry.alias), token);
      }
    }
  }

  return { order, byId, byAlias };
}

/** "Player 3" for a PlayerId, or undefined if the engine never mentioned them. */
export const pseudonymOf = (ps: Pseudonyms, id: PlayerId): string | undefined =>
  ps.byId.get(id);

/**
 * "Player 3" for a digest alias, or undefined when we have no honest mapping.
 * Never guesses: attribution is dropped rather than misattributed.
 */
export const pseudonymForAlias = (
  ps: Pseudonyms,
  alias: string | undefined,
): string | undefined =>
  typeof alias === "string" && alias.trim().length > 0
    ? ps.byAlias.get(normAlias(alias))
    : undefined;

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replace real aliases inside free text (player-typed quotes) with their
 * pseudonym before anything is sent to a provider. Unknown aliases cannot be
 * detected without a roster — the server should always pass one.
 */
export function scrubAliases(
  text: string,
  ps: Pseudonyms,
  roster?: readonly RosterEntry[],
): string {
  if (!roster || roster.length === 0) return text;
  const pairs = [...ps.byAlias.entries()]
    .filter(([alias]) => alias.length >= 2)
    .sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [alias, token] of pairs) {
    out = out.replace(
      new RegExp(`(?<![\\w])${escapeRegExp(alias)}(?![\\w])`, "gi"),
      token,
    );
  }
  return out;
}

/**
 * Server-side convenience: swap "Player N" tokens back to real aliases after
 * narration (spec §7). Longest token first so "Player 10" never becomes
 * "Maya0". Deterministic string replace — no provider involved.
 */
export function swapPseudonyms(
  text: string,
  roster: readonly RosterEntry[] | undefined,
): string {
  if (!roster || roster.length === 0 || text.length === 0) return text;
  const pairs = roster
    .map((entry, index) => ({ alias: entry.alias, token: pseudonym(index) }))
    .filter((pair) => typeof pair.alias === "string" && pair.alias.trim().length > 0)
    .sort((a, b) => b.token.length - a.token.length);
  let out = text;
  for (const { alias, token } of pairs) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(token)}\\b`, "g"), alias);
  }
  return out;
}
