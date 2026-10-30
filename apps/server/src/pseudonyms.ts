import { pseudonym } from "../../../packages/shared/src/contracts.ts";

export interface AliasEntry { alias: string; id: string; }

/** Build a stable room-order crosswalk; replacement order handles contained names deterministically. */
export function aliasTable(players: AliasEntry[]): { alias: string; token: string }[] {
  return players.map((p, i) => ({ alias: p.alias.normalize("NFC"), token: pseudonym(i) }));
}

/** Replace whole alias tokens only. Unicode letters/digits/underscore count as word characters. */
export function pseudonymizeText(text: string, players: AliasEntry[]): string {
  text = text.normalize("NFC");
  const table = aliasTable(players).sort((a, b) => b.alias.length - a.alias.length || a.token.localeCompare(b.token));
  for (const entry of table) {
    const escaped = entry.alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu");
    text = text.replace(re, entry.token);
  }
  return text;
}

/** Swap provider pseudonyms back only when an entire Player N token matches. */
export function restoreAliases(text: string, players: AliasEntry[]): string {
  return text.replace(/\bPlayer (1[01]|[1-9])\b/g, (match, n: string) => players[Number(n) - 1]?.alias ?? match);
}
