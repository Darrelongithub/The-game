// packages/engine/src/digest.ts
// buildNightDigest — spec §15, the data-milking layer. Every line traces to
// the log; the narrator never invents. Graceful on partial logs: the server
// calls this mid-game for interlude teasers, so (unlike the scoring entry
// points) it never throws on a small or sparse room.
import {
  TRAITS,
  type LogRecord,
  type NightDigest,
  type PlayerId,
  type RoomMeta,
} from "../../shared/src/contracts.ts";
import {
  aliasOf,
  buildRatingIndex,
  getPicks,
  meanOf,
} from "./internal.ts";
import { clusterNames, decoyPairings, decoyQuote, nameClusterTeaser } from "./live.ts";

const QUOTE_MIN_LEN = 20;
const QUOTE_MAX_LEN = 160;
const QUOTES_MAX = 12;
const GAGS_MAX = 10;

const hasLetterOrDigit = (s: string): boolean => /[\p{L}\p{N}]/u.test(s);

export function buildNightDigest(allRecords: LogRecord[], meta: RoomMeta): NightDigest {
  // Spotlight decoys answered a cover question: they never count as quotes,
  // latencies, gags or clusters on their own. They come back in through the
  // pairing line below, which is the whole point of them.
  const log = allRecords.filter((rec) => rec.decoy !== true);

  // ---------- quotes: ≤12, length 20–160, deduped, never emoji-only ----------
  // Debrief texts are private and are never quoted publicly.
  const seenQuoteText = new Set<string>();
  const quoteCandidates: { alias: string; text: string; context: string; index: number; words: number }[] = [];
  log.forEach((rec, index) => {
    if (rec.value.kind !== "text" || rec.roundKind === "debrief") return;
    const text = rec.value.text.trim();
    if (text.length < QUOTE_MIN_LEN || text.length > QUOTE_MAX_LEN) return;
    if (!hasLetterOrDigit(text)) return;
    const key = text.toLowerCase();
    if (seenQuoteText.has(key)) return;
    seenQuoteText.add(key);
    quoteCandidates.push({
      alias: aliasOf(meta, rec.playerId),
      text,
      context: `${rec.roundKind}:${rec.promptId}`,
      index,
      words: text.split(/\s+/).length,
    });
  });
  // "Best" = most substantive first (word count, then length, then earliest).
  const ranked = quoteCandidates
    .sort((x, y) => y.words - x.words || y.text.length - x.text.length || x.index - y.index)
    .map(({ alias, text, context }) => ({ alias, text, context }));
  // Decoy pairings lead the quote list: "While the room captioned X, X wrote…"
  const pairings = decoyPairings(allRecords, meta);
  const paired = pairings.map(decoyQuote);
  const quotes = [...paired, ...ranked].slice(0, QUOTES_MAX);

  // ---------- stats: latencies, dodges, minigame ----------
  let fastest: { alias: string; ms: number } | undefined;
  let slowest: { alias: string; ms: number } | undefined;
  let tapWar: { alias: string; score: number } | undefined;
  const dodgeCounts = new Map<PlayerId, number>();
  const dodges: { alias: string; reason: string }[] = [];
  for (const rec of log) {
    const alias = aliasOf(meta, rec.playerId);
    if (!fastest || rec.latencyMs < fastest.ms) fastest = { alias, ms: rec.latencyMs };
    if (!slowest || rec.latencyMs > slowest.ms) slowest = { alias, ms: rec.latencyMs };
    if (rec.value.kind === "minigame") {
      if (!tapWar || rec.value.score > tapWar.score) tapWar = { alias, score: rec.value.score };
    }
    if (rec.value.kind === "dare" && rec.value.status === "passed") {
      dodgeCounts.set(rec.playerId, (dodgeCounts.get(rec.playerId) ?? 0) + 1);
      if (rec.value.reason !== undefined && rec.value.reason.trim().length > 0) {
        dodges.push({ alias, reason: rec.value.reason }); // verbatim excuse
      }
    }
  }
  let topDodger: { alias: string; count: number } | undefined;
  for (const player of meta.players) {
    const count = dodgeCounts.get(player.id) ?? 0;
    if (count > 0 && (!topDodger || count > topDodger.count)) topDodger = { alias: player.alias, count };
  }
  const stats: NightDigest["stats"] = {
    ...(fastest ? { fastest } : {}),
    ...(slowest ? { slowest } : {}),
    ...(topDodger ? { topDodger } : {}),
    ...(tapWar ? { tapWar } : {}),
  };

  // ---------- running gags: shout words that keep coming back ----------
  const shoutCounts = new Map<string, number>();
  for (const rec of log) {
    if (rec.value.kind !== "shout") continue;
    const word = rec.value.word.trim().toLowerCase();
    if (word.length === 0) continue;
    shoutCounts.set(word, (shoutCounts.get(word) ?? 0) + 1);
  }
  const runningGags = [...shoutCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([word, count]) => ({ word, count }))
    .sort((x, y) => y.count - x.count || (x.word < y.word ? -1 : 1))
    .slice(0, GAGS_MAX);

  // ---------- name clusters: ONE teaser per spotlight round, never a claim ----------
  // "6 of 7 wrote the same name for X." Live observation is fun, not evidence.
  const clusterTeasers: string[] = [];
  for (const pairing of pairings) {
    const teaser = nameClusterTeaser(clusterNames(pairing.captions, meta.players), pairing.subjectAlias);
    if (teaser) clusterTeasers.push(teaser);
  }

  // ---------- pick-cluster teasers: counts only, never a finale spoiler ----------
  const pickTeasers: string[] = [...clusterTeasers];
  {
    const picks = getPicks(log);
    if (picks.length > 0) {
      pickTeasers.push(`The room has cast ${picks.length} picks so far.`);
      const received = new Map<PlayerId, number>();
      for (const p of picks) received.set(p.target, (received.get(p.target) ?? 0) + 1);
      const topReceived = Math.max(...received.values());
      if (topReceived >= 3) {
        pickTeasers.push(`One player has quietly collected ${topReceived} of those picks.`);
      }
      const byRound = new Map<string, Map<PlayerId, PlayerId>>();
      for (const p of picks) {
        let round = byRound.get(p.roundId);
        if (!round) { round = new Map(); byRound.set(p.roundId, round); }
        round.set(p.picker, p.target);
      }
      let halfAgreeRounds = 0;
      for (const round of byRound.values()) {
        const counts = new Map<PlayerId, number>();
        for (const target of round.values()) counts.set(target, (counts.get(target) ?? 0) + 1);
        if (Math.max(...counts.values()) * 2 >= round.size) halfAgreeRounds++;
      }
      if (halfAgreeRounds > 0) {
        pickTeasers.push(
          halfAgreeRounds === 1
            ? `In 1 round, at least half the room pointed at the same person.`
            : `In ${halfAgreeRounds} rounds, at least half the room pointed at the same person.`,
        );
      }
    }
  }

  // ---------- self vs room gaps, biggest first ----------
  const selfVsRoom: NightDigest["selfVsRoom"] = [];
  {
    const ratings = buildRatingIndex(log);
    for (const player of meta.players) {
      for (const trait of TRAITS) {
        const self = ratings.self.get(player.id)?.get(trait);
        const raters = ratings.peerByRater.get(player.id)?.get(trait);
        if (self === undefined || !raters || raters.size === 0) continue;
        selfVsRoom.push({ alias: player.alias, trait, self, roomMean: meanOf([...raters.values()]) });
      }
    }
    selfVsRoom.sort(
      (x, y) =>
        Math.abs(y.self - y.roomMean) - Math.abs(x.self - x.roomMean) ||
        (x.alias < y.alias ? -1 : x.alias > y.alias ? 1 : 0) ||
        TRAITS.indexOf(x.trait) - TRAITS.indexOf(y.trait),
    );
  }

  return { quotes, stats, runningGags, pickTeasers, dodges, selfVsRoom };
}
