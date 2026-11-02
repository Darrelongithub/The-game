import type { LogRecord } from "../../../packages/shared/src/contracts.ts";

// Only low-information group-language can be repeated mid-game. An allowlist
// avoids shipping names, identifying anecdotes, dates or other unique details.
const SAFE_WORDS = new Set(`a all always amazing and are as at be been best better big bright but can celebration chaos cheerful close energy enjoy enjoyed every everyone feel feels for friend friends fun funny game good great group happy has have here in is it just laugh laughing like lot love makes making more most much night no of on our people really room silly so some someone special story such that the their them there these this those time together tonight too very was we were what when where who will with wonderful yes you your`.split(" "));

/**
 * A finale-mode callback must be an identical, verbatim group sentiment from
 * at least three distinct respondents. Never use debrief/spotlight records,
 * names, player ids, digits or free-form identifying anecdotes. No source
 * round or author accompanies the quote. Conservative by design: most unique
 * answers stay private until the finale, even if that means no callbacks.
 */
export function safeCallbackQuotes(log: readonly LogRecord[], aliases: readonly string[]): string[] {
  const groups = new Map<string, Set<string>>();
  for (const r of log) {
    if (r.roundKind !== "text" || r.decoy || r.value.kind !== "text") continue;
    const quote = r.value.text.trim();
    if (quote.length < 20 || quote.length > 100 || !/^[a-zA-Z .,!?'-]+$/.test(quote)) continue;
    const lower = quote.toLocaleLowerCase();
    if (aliases.some((alias) => alias.trim() && lower.includes(alias.trim().toLocaleLowerCase()))) continue;
    const words = lower.match(/[a-z]+/g) ?? [];
    if (!words.length || words.some((word) => !SAFE_WORDS.has(word))) continue;
    const authors = groups.get(quote) ?? new Set<string>();
    authors.add(r.playerId); groups.set(quote, authors);
  }
  return [...groups].filter(([, authors]) => authors.size >= 3).map(([quote]) => quote);
}
