import { pseudonym } from "../../../packages/shared/src/contracts.ts";

export interface AliasEntry { alias: string; id: string; }

/** Build a stable room-order crosswalk; replacement order handles contained names deterministically. */
export function aliasTable(players: AliasEntry[]): { alias: string; token: string }[] {
  return players.map((p, i) => ({ alias: p.alias.normalize("NFC"), token: pseudonym(i) }));
}

/**
 * Replace whole alias tokens only. Unicode letters/digits/underscore count as word characters.
 *
 * ONE pass over ONE alternation. Replacing aliases one at a time let a later
 * alias match a token an earlier alias had just written: a guest who picked a
 * gamertag shaped like a pseudonym ("Player 3") hijacked another guest's token,
 * so a mention of Samantha came back out of `restoreAliases` as "Player 3" —
 * the wrong name, in public finale copy. A single pass can never rescan its
 * own output.
 */
export function pseudonymizeText(text: string, players: AliasEntry[]): string {
  const normalized = text.normalize("NFC");
  const table = aliasTable(players)
    .filter((entry) => entry.alias.length > 0)
    .sort((a, b) => b.alias.length - a.alias.length || a.token.localeCompare(b.token));
  if (table.length === 0) return normalized;
  const tokenByAlias = new Map<string, string>();
  for (const entry of table) {
    const key = entry.alias.toLowerCase();
    if (!tokenByAlias.has(key)) tokenByAlias.set(key, entry.token);
  }
  const alternation = table.map((entry) => entry.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alternation})(?![\\p{L}\\p{N}_])`, "giu");
  return normalized.replace(re, (match) => tokenByAlias.get(match.normalize("NFC").toLowerCase()) ?? match);
}

/** Swap provider pseudonyms back only when an entire Player N token matches. */
export function restoreAliases(text: string, players: AliasEntry[]): string {
  return text.replace(/\bPlayer (1[01]|[1-9])\b/g, (match, n: string) => players[Number(n) - 1]?.alias ?? match);
}
