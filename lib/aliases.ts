/** Pure alias-replacement policy shared by provider scrubbing and server recodes.
 * Kept outside the frozen shared contracts: R22 changes implementation policy,
 * not a wire contract. This is the single tunable for every alias matcher.
 */
export const ALIAS_REPLACE_MIN = 3;

export const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** ASCII names use literal \b boundaries. Unicode lookarounds extend the same
 * word-boundary semantics to accents and non-Latin names (JS \b is ASCII-only).
 * The extra guards also prevent `Ali` matching the prefix of `Aliénor`.
 */
export function aliasBodyPattern(alias: string): string | null {
  if (typeof alias !== "string") return null;
  const clean = alias.trim().normalize("NFC");
  if ([...clean].length < ALIAS_REPLACE_MIN) return null;
  const left = /^[A-Za-z0-9_]/u.test(clean) ? "\\b" : "";
  const right = /[A-Za-z0-9_]$/u.test(clean) ? "\\b" : "";
  return `${left}(?<![\\p{L}\\p{N}_])${escapeRegExp(clean)}(?![\\p{L}\\p{N}_])${right}`;
}

export function aliasPattern(alias: string): RegExp | null {
  const body = aliasBodyPattern(alias);
  return body === null ? null : new RegExp(body, "giu");
}

/** One combined pass: longest alias wins, and replacement text is never fed
 * back into another alias matcher. Replacement callbacks keep `$&` literal.
 */
export function replaceAliasTokens(text: string, replacements: readonly { alias: string; replacement: string }[]): string {
  const entries = replacements.flatMap((entry) => {
    const body = aliasBodyPattern(entry.alias);
    return body === null ? [] : [{ body, alias: entry.alias.trim().normalize("NFC"), replacement: entry.replacement }];
  }).sort((a, b) => b.alias.length - a.alias.length || a.alias.localeCompare(b.alias));
  if (!entries.length) return text;
  const pattern = new RegExp(entries.map((entry, index) => `(?<alias${index}>${entry.body})`).join("|"), "giu");
  return text.normalize("NFC").replace(pattern, (match, ...args) => {
    const groups = args.at(-1) as Record<string, string | undefined>;
    const index = entries.findIndex((_, i) => groups[`alias${i}`] !== undefined);
    return index < 0 ? match : entries[index]!.replacement;
  });
}
