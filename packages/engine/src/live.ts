// packages/engine/src/live.ts
// Live-moment helpers (ROUND 3). Pure, deterministic, zero I/O.
//
// Two jobs, both of which the spec insists are NOT formal claims:
//   1. NAME CLUSTERING — when the room's spotlight captions name the same
//      player, that is ONE digest teaser line ("6 of 7 wrote the same name …").
//      Live observation is fun, not evidence: no Claim is ever emitted from it.
//   2. DECOY PAIRING — the spotlight subject answered a throwaway cover
//      question instead of the real one. Their answer must never score; it
//      only pairs with the captions for the digest
//      ("While the room captioned X, X wrote: '…'").
import { type DigestQuote, type LogRecord, type PlayerId, type RoomMeta } from "../../shared/src/contracts.ts";
import { aliasOf } from "./internal.ts";

/** Words that must never be enough on their own to "name" a player. */
const COMMON_TOKENS: ReadonlySet<string> = new Set([
  "that", "this", "these", "those", "they", "them", "their", "there", "then",
  "than", "with", "have", "has", "had", "from", "just", "like", "love", "your",
  "yours", "about", "after", "again", "also", "always", "another", "anyone",
  "because", "before", "being", "both", "could", "does", "doing", "down",
  "each", "even", "every", "everything", "everyone", "feel", "feels", "girl",
  "guy", "here", "into", "know", "look", "looking", "made", "make", "many",
  "more", "most", "much", "must", "never", "nothing", "only", "other", "over",
  "really", "right", "room", "said", "same", "should", "some", "someone",
  "something", "still", "such", "sure", "take", "tell", "that's", "very",
  "want", "well", "were", "what", "when", "where", "which", "while", "who",
  "will", "with", "would", "yeah", "yourself", "player", "bot",
]);

const stripDiacritics = (s: string): string => s.normalize("NFD").replace(/[\u0300-\u036f]/gu, "");

/** Lowercase, diacritic-free, punctuation-free, single-spaced. */
export function normalizeName(s: string): string {
  return stripDiacritics(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

const tokensOf = (s: string): string[] => normalizeName(s).split(" ").filter((t) => t.length > 0);

export interface NameCandidate { id: PlayerId; alias: string; }

/**
 * Which players a caption names. Deliberately conservative:
 *  - the FULL alias as a bounded phrase ("wachuki great!" → "wachuki great");
 *  - a distinctive alias token (≥4 chars, not a common word) on its own, so
 *    "Wachuki" counts for "Wachuki Great!";
 *  - the "Player N" pseudonym (the server pseudonymizes text before scoring);
 *  - a ≥4-char prefix of a longer alias token ("wachu" for "wachuki").
 * A token that is only 2–3 characters ("bri", "sam") never counts alone.
 */
export function detectNamedPlayers(text: string, players: readonly NameCandidate[]): PlayerId[] {
  const padded = ` ${normalizeName(text)} `;
  if (padded.trim().length === 0) return [];
  const textTokens = new Set(tokensOf(text));
  const hits: PlayerId[] = [];
  for (const player of players) {
    const full = normalizeName(player.alias);
    if (full.length > 0 && padded.includes(` ${full} `)) { hits.push(player.id); continue; }
    const aliasTokens = full.split(" ").filter((t) => t.length >= 4 && !COMMON_TOKENS.has(t) && !/^\d+$/u.test(t));
    const named = aliasTokens.some((aliasToken) => {
      for (const token of textTokens) {
        if (token === aliasToken) return true;
        // Nickname/short form: a ≥4-char prefix of a clearly longer alias token.
        if (token.length >= 4 && token.length < aliasToken.length && aliasToken.startsWith(token)) return true;
      }
      return false;
    });
    if (named) hits.push(player.id);
  }
  return hits;
}

export interface NameCluster {
  playerId: PlayerId;
  alias: string;
  count: number;
}

export interface NameClusterResult {
  /** captions considered (blank ones never count) */
  total: number;
  /** one entry per named player, biggest cluster first, then alias */
  clusters: NameCluster[];
  /** the winner when there is one, otherwise undefined */
  top?: NameCluster;
}

/**
 * Same-name detection across spotlight captions. A caption that names two
 * different players is ambiguous and never counts for either — we would rather
 * miss a cluster than invent one.
 */
export function clusterNames(texts: readonly string[], players: readonly NameCandidate[]): NameClusterResult {
  const counts = new Map<PlayerId, number>();
  let total = 0;
  for (const text of texts) {
    if (normalizeName(text).length === 0) continue;
    total++;
    const named = detectNamedPlayers(text, players);
    if (named.length !== 1) continue;
    const id = named[0]!;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const clusters: NameCluster[] = [...counts.entries()]
    .map(([playerId, count]) => ({ playerId, alias: aliasOf(metaOf(players), playerId), count }))
    .sort((x, y) => y.count - x.count || (x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : 0));
  return { total, clusters, ...(clusters[0] ? { top: clusters[0] } : {}) };
}

const metaOf = (players: readonly NameCandidate[]): RoomMeta => ({
  roomId: "",
  players: players.map((p) => ({ id: p.id, alias: p.alias })),
  revealOptIn: [],
});

/**
 * Is this cluster worth a digest line? It must be a real room signal — at least
 * three matching answers AND a strict majority — so 2 of 7 never fires.
 * Live observation is a joke, never an engine claim (spec §3/§15).
 */
export function nameClusterTeaser(result: NameClusterResult, subjectAlias: string): string | undefined {
  const top = result.top;
  if (!top || result.total === 0) return undefined;
  if (top.count < 3 || top.count * 2 <= result.total) return undefined;
  return `${top.count} of ${result.total} wrote the same name for ${subjectAlias}.`;
}

/** A spotlight round's decoy record + the captions it was hiding behind. */
export interface DecoyPairing {
  roundId: string;
  subjectId: PlayerId;
  subjectAlias: string;
  /** The subject's cover answer — verbatim. */
  decoyText: string;
  /** Everyone else's captions, in log order. */
  captions: string[];
}

/**
 * Every spotlight decoy in the log, with the captions from the same round.
 * Decoy answers answer NOTHING, so this is the only consumer allowed to see
 * them (the digest pairing and the reveal punchline).
 */
export function decoyPairings(log: readonly LogRecord[], meta: RoomMeta): DecoyPairing[] {
  const byRound = new Map<string, { decoy?: LogRecord; captions: string[] }>();
  for (const rec of log) {
    if (rec.value.kind !== "text") continue;
    const entry = byRound.get(rec.roundId) ?? { captions: [] };
    byRound.set(rec.roundId, entry);
    if (rec.decoy === true) entry.decoy = rec;
    else if (rec.roundKind === "spotlight") entry.captions.push(rec.value.text.trim());
  }
  const out: DecoyPairing[] = [];
  for (const [roundId, entry] of byRound) {
    if (!entry.decoy || entry.decoy.value.kind !== "text") continue;
    const subjectId = entry.decoy.playerId;
    out.push({ roundId, subjectId, subjectAlias: aliasOf(meta, subjectId), decoyText: entry.decoy.value.text.trim(), captions: entry.captions });
  }
  return out;
}

/** The digest's gold line: the room wrote about them, they wrote about lunch. */
export function decoyQuote(pairing: DecoyPairing): DigestQuote {
  return {
    alias: pairing.subjectAlias,
    text: `While the room captioned ${pairing.subjectAlias}, ${pairing.subjectAlias} wrote: “${pairing.decoyText}”`,
    context: "spotlight:decoy",
  };
}
