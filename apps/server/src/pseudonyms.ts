import { pseudonym } from "../../../packages/shared/src/contracts.ts";
import { replaceAliasTokens } from "../../../lib/aliases.ts";

export interface AliasEntry { alias: string; id: string; }

/** Build a stable room-order crosswalk; replacement order handles contained names deterministically. */
export function aliasTable(players: AliasEntry[]): { alias: string; token: string }[] {
  return players.map((p, i) => ({ alias: p.alias.normalize("NFC"), token: pseudonym(i) }));
}

/** Whole-word, escaped, case-insensitive replacement in one pass. The shared
 * ALIAS_REPLACE_MIN policy also protects short names from accidental recoding. */
export function pseudonymizeText(text: string, players: AliasEntry[]): string {
  return replaceAliasTokens(text, aliasTable(players).map(({ alias, token }) => ({ alias, replacement: token })));
}

/** One callback-based pass: aliases containing `$&` stay literal, and a newly
 * restored alias is never consumed by a later Player N replacement. */
export function restoreAliases(text: string, players: AliasEntry[]): string {
  return text.replace(/\bPlayer (1[01]|[1-9])\b/gi, (match, n: string) => players[Number(n) - 1]?.alias ?? match);
}
