// packages/engine/src/digest.ts
// NIGHT DIGEST — the data-milking layer.
//
// The digest never invents. It quotes what people actually said, counts what
// actually happened, and leaves the interpretation to the finale.
//
// Pure: no I/O, no randomness, no Date.now().
import {
    type DigestQuote,
    type DigestStats,
    type LogRecord,
    type NightDigest,
    type PlayerId,
    type RoomMeta,
    type TraitId,
} from "../../shared/src/contracts.ts";
import { aliasOf, buildRatingIndex, meanOf } from "./internal.ts";
import { METRIC_LOOKCHAIN, lookChains } from "./secrets.ts";

/** Stopwords dropped from quote mining. */
const STOPWORDS = new Set([
    "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "at", "for",
    "with", "is", "was", "are", "were", "be", "been", "it", "this", "that", "i",
    "you", "he", "she", "we", "they", "my", "your", "his", "her", "their", "me",
    "him", "them", "so", "not", "do", "did", "does", "have", "has", "had", "am",
]);

const tokenize = (text: string): string[] =>
    text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((t) => t.length > 2 && !STOPWORDS.has(t));

/** How interesting a quote is: longer, more specific, fewer filler words. */
function quoteScore(text: string): number {
    const tokens = tokenize(text);
    if (tokens.length === 0) return 0;
    const unique = new Set(tokens).size;
    return Math.min(1, tokens.length / 12) * 0.6 + (unique / tokens.length) * 0.4;
}

/** Verbatim quotes, best first. Never edited, never invented. */
export function collectQuotes(log: readonly LogRecord[], meta: RoomMeta): DigestQuote[] {
    const out: DigestQuote[] = [];
    for (const rec of log) {
        if (rec.value.kind !== "text") continue;
        // A look chain's "why" has its own slide — it is never mined as a quote.
        if (rec.metric === METRIC_LOOKCHAIN) continue;
        const text = rec.value.text.trim();
        if (text.length < 12) continue;
        out.push({
            alias: aliasOf(meta, rec.playerId),
            text,
            context: rec.promptId,
        });
    }
    return out
        .map((q) => ({ ...q, _score: quoteScore(q.text) }))
        .sort((a, b) => b._score - a._score)
        .slice(0, 12)
        .map(({ _score, ...q }) => q);
}

/** Quickest / slowest / most-dodging player. */
export function collectStats(log: readonly LogRecord[], meta: RoomMeta): DigestStats {
    const stats: DigestStats = {};
    let fastest: { alias: string; ms: number } | undefined;
    let slowest: { alias: string; ms: number } | undefined;
    const dodges = new Map<PlayerId, number>();

    for (const rec of log) {
        if (!fastest || rec.latencyMs < fastest.ms) {
            fastest = { alias: aliasOf(meta, rec.playerId), ms: rec.latencyMs };
        }
        if (!slowest || rec.latencyMs > slowest.ms) {
            slowest = { alias: aliasOf(meta, rec.playerId), ms: rec.latencyMs };
        }
        if (rec.value.kind === "dare" && rec.value.status === "passed") {
            dodges.set(rec.playerId, (dodges.get(rec.playerId) ?? 0) + 1);
        }
    }
    if (fastest) stats.fastest = fastest;
    if (slowest) stats.slowest = slowest;

    let top: { alias: string; count: number } | undefined;
    for (const [id, count] of dodges) {
        if (!top || count > top.count) top = { alias: aliasOf(meta, id), count };
    }
    if (top && top.count > 0) stats.topDodger = top;
    return stats;
}

/** The verbatim excuses people gave when they passed a dare. */
export function collectDodges(log: readonly LogRecord[], meta: RoomMeta): { alias: string; reason: string }[] {
    const out: { alias: string; reason: string }[] = [];
    for (const rec of log) {
        if (rec.value.kind !== "dare") continue;
        if (rec.value.status !== "passed" || !rec.value.reason) continue;
        out.push({ alias: aliasOf(meta, rec.playerId), reason: rec.value.reason });
    }
    return out;
}

/** Words that keep coming up across the room's answers. */
export function collectRunningGags(log: readonly LogRecord[]): { word: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const rec of log) {
        if (rec.value.kind !== "text") continue;
        for (const token of tokenize(rec.value.text)) {
            counts.set(token, (counts.get(token) ?? 0) + 1);
        }
    }
    return [...counts.entries()]
        .filter(([, n]) => n >= 2)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 5)
        .map(([word, count]) => ({ word, count }));
}

/** Self-rating vs the room's rating, per trait. */
export function selfVsRoom(log: readonly LogRecord[], meta: RoomMeta): NightDigest["selfVsRoom"] {
    const idx = buildRatingIndex(log);
    const out: NightDigest["selfVsRoom"] = [];
    const traits: TraitId[] = ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"];
    for (const id of meta.players.map((p) => p.id)) {
        const selfMap = idx.self.get(id);
        if (!selfMap) continue;
        for (const trait of traits) {
            const self = selfMap.get(trait);
            if (self === undefined) continue;
            const peerMap = idx.peerByRater.get(id)?.get(trait);
            if (!peerMap) continue;
            const roomMean = meanOf([...peerMap.values()]);
            out.push({ alias: aliasOf(meta, id), trait, self, roomMean });
        }
    }
    return out;
}

/**
 * The look chains played tonight.
 *
 * The choice was hidden all night — this is where it comes out: the real
 * person they were looking at, how many guessed right, and why.
 */
export function collectLookChains(log: readonly LogRecord[], meta: RoomMeta): NightDigest["lookChains"] {
    const chains = lookChains(log);
    if (chains.length === 0) return [];
    return chains.map((chain) => ({
        actorId: chain.actor,
        targetId: chain.target,
        actor: aliasOf(meta, chain.actor),
        target: aliasOf(meta, chain.target),
        guessedRight: chain.guessedRight,
        guessers: chain.guessers,
        ...(chain.reason ? { reason: chain.reason } : {}),
    }));
}

/** The whole digest for the night. */
export function buildNightDigest(log: readonly LogRecord[], meta: RoomMeta): NightDigest {
    return {
        quotes: collectQuotes(log, meta),
        stats: collectStats(log, meta),
        runningGags: collectRunningGags(log),
        pickTeasers: [],
        dodges: collectDodges(log, meta),
        selfVsRoom: selfVsRoom(log, meta),
        lookChains: collectLookChains(log, meta),
    };
}
