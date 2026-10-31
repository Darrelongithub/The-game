// packages/engine/src/signals.ts
// Pair signals — how strongly the room points at a relationship between two
// specific players. Pure: no I/O, no randomness.
//
// Every component is hand-computable from the log so a verdict can always be
// traced back to the answers behind it:
//
//   pickOverlap   how often A and B pick each other, relative to how often
//                 they pick anybody at all
//   mutualPick    the raw reciprocal-pick rate (both directions)
//   traitAgreement how closely A and B rate the same traits of each other
import {
    DEFAULT_WEIGHTS,
    type LogRecord,
    type MetricKey,
    type PairSignal,
    type PlayerId,
    type ResponseValue,
    type RoomMeta,
    type TraitId,
} from "../../shared/src/contracts.ts";
import {
    CLOSENESS_METRICS,
    COUPLE_METRICS,
    NEGATIVE_METRICS,
    clamp01,
    getPicks,
    meanOf,
    pairKey,
    playerIdsSorted,
    sortedPair,
} from "./internal.ts";

export interface PairWeights {
    pickOverlap: number;
    mutualPick: number;
    traitAgreement: number;
}

/** Picks whose metric marks a romantic / sexual pull. */
const desirePick = (metric: MetricKey | undefined): boolean =>
    metric === "sex-desire" || metric === "crush" || metric === "couple-fit" || metric === "gay-hypothetical";

/** Picks whose metric marks friendship or trust. */
const closenessPick = (metric: MetricKey | undefined): boolean =>
    metric !== undefined && CLOSENESS_METRICS.has(metric);

/** Picks whose metric marks friction. */
const negativePick = (metric: MetricKey | undefined): boolean =>
    metric !== undefined && NEGATIVE_METRICS.has(metric);

/** Every rating value in the log, keyed by (rater, about, trait). */
function ratingTriples(log: readonly LogRecord[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const rec of log) {
        if (rec.value.kind !== "rating") continue;
        const v = rec.value;
        if (v.about === "self") continue;
        out.set(`${rec.playerId}\u0000${v.about}\u0000${v.trait}`, v.value);
    }
    return out;
}

/**
 * How close two players rate each other on shared traits, 0..1.
 * 1 = identical ratings, 0 = maximum disagreement (|diff| of 9).
 */
export function traitAgreementOf(
    a: PlayerId,
    b: PlayerId,
    triples: Map<string, number>,
): number {
    const traits: TraitId[] = ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"];
    const diffs: number[] = [];
    for (const t of traits) {
        const ab = triples.get(`${a}\u0000${b}\u0000${t}`);
        const ba = triples.get(`${b}\u0000${a}\u0000${t}`);
        const vals = [ab, ba].filter((v): v is number => typeof v === "number");
        if (vals.length === 0) continue;
        diffs.push(Math.abs(vals[0]! - (vals[1] ?? vals[0]!)));
    }
    if (diffs.length === 0) return 0;
    return clamp01(1 - meanOf(diffs) / 9);
}

/**
 * Pair signals for every unordered pair of players in the room.
 * Deterministic: pairs come out in sorted id order.
 */
export function computeSignals(
    log: readonly LogRecord[],
    meta: RoomMeta,
    weights: PairWeights = DEFAULT_WEIGHTS,
): PairSignal[] {
    const picks = getPicks(log);
    const triples = ratingTriples(log);
    const ids = playerIdsSorted(meta);
    const out: PairSignal[] = [];

    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i]!;
            const b = ids[j]!;

            // --- pick overlap: how concentrated are A's and B's picks on each other?
            const aPicks = picks.filter((p) => p.picker === a);
            const bPicks = picks.filter((p) => p.picker === b);
            const aOnB = aPicks.filter((p) => p.target === b).length;
            const bOnA = bPicks.filter((p) => p.target === a).length;
            const denom = aPicks.length + bPicks.length;
            const pickOverlap = denom === 0 ? 0 : clamp01((aOnB + bOnA) / denom);

            // --- mutual pick: same thing, restricted to couple-ish picks
            const aDesire = aPicks.filter((p) => desirePick(p.metric));
            const bDesire = bPicks.filter((p) => desirePick(p.metric));
            const aOnBD = aDesire.filter((p) => p.target === b).length;
            const bOnAD = bDesire.filter((p) => p.target === a).length;
            const dDenom = aDesire.length + bDesire.length;
            const mutualPick = dDenom === 0 ? 0 : clamp01((aOnBD + bOnAD) / dDenom);

            // --- closeness and friction
            const aClose = aPicks.filter((p) => closenessPick(p.metric));
            const bClose = bPicks.filter((p) => closenessPick(p.metric));
            const aOnBC = aClose.filter((p) => p.target === b).length;
            const bOnAC = bClose.filter((p) => p.target === a).length;
            const cDenom = aClose.length + bClose.length;
            const friendEvidence = cDenom === 0 ? 0 : clamp01((aOnBC + bOnAC) / cDenom);

            const aNeg = aPicks.filter((p) => negativePick(p.metric));
            const bNeg = bPicks.filter((p) => negativePick(p.metric));
            const aOnBN = aNeg.filter((p) => p.target === b).length;
            const bOnAN = bNeg.filter((p) => p.target === a).length;
            const nDenom = aNeg.length + bNeg.length;
            const negativeMutual = nDenom === 0 ? 0 : clamp01((aOnBN + bOnAN) / nDenom);

            const coupleEvidence = Math.max(mutualPick, friendEvidence * 0.5);
            const traitAgreement = traitAgreementOf(a, b, triples);

            const pairScore = clamp01(
                weights.pickOverlap * pickOverlap +
                weights.mutualPick * mutualPick +
                weights.traitAgreement * traitAgreement,
            );

            const componentsUsed: PairSignal["componentsUsed"] = [];
            if (pickOverlap > 0) componentsUsed.push("pickOverlap");
            if (mutualPick > 0) componentsUsed.push("mutualPick");
            if (traitAgreement > 0) componentsUsed.push("traitAgreement");

            out.push({
                room: meta.roomId,
                a,
                b,
                pickOverlap,
                mutualPick,
                componentsUsed,
                traitAgreement,
                pairScore,
                coupleEvidence,
                friendEvidence,
                negativeMutual,
            });
        }
    }
    return out;
}

/** The signal for one specific pair, or undefined if they were never paired. */
export function pairSignalOf(
    signals: readonly PairSignal[],
    a: PlayerId,
    b: PlayerId,
): PairSignal | undefined {
    const key = pairKey(a, b);
    return signals.find((s) => pairKey(s.a, s.b) === key);
}

/** The pair with the strongest couple evidence. */
export function topCouple(signals: readonly PairSignal[]): PairSignal | undefined {
    return [...signals].sort((x, y) => y.coupleEvidence - x.coupleEvidence)[0];
}

/** The pair with the strongest friendship evidence. */
export function topFriends(signals: readonly PairSignal[]): PairSignal | undefined {
    return [...signals].sort((x, y) => y.friendEvidence - x.friendEvidence)[0];
}

/**
 * How many times each player was picked for a given metric.
 * Returns target → number of distinct pickers.
 */
export function pickTally(
    log: readonly LogRecord[],
    metric: MetricKey,
): Map<PlayerId, Set<PlayerId>> {
    const out = new Map<PlayerId, Set<PlayerId>>();
    for (const rec of log) {
        if (rec.value.kind !== "pick") continue;
        if (rec.metric !== metric) continue;
        let set = out.get(rec.value.target);
        if (!set) { set = new Set(); out.set(rec.value.target, set); }
        set.add(rec.playerId);
    }
    return out;
}

/** Distinct pickers per target across a set of metrics. */
export function tallyAcross(
    log: readonly LogRecord[],
    metrics: ReadonlySet<MetricKey>,
): Map<PlayerId, Set<PlayerId>> {
    const out = new Map<PlayerId, Set<PlayerId>>();
    for (const rec of log) {
        if (rec.value.kind !== "pick") continue;
        if (!rec.metric || !metrics.has(rec.metric)) continue;
        let set = out.get(rec.value.target);
        if (!set) { set = new Set(); out.set(rec.value.target, set); }
        set.add(rec.playerId);
    }
    return out;
}

/** All pair_vote responses in the log, with the pair they were about. */
export function pairVotes(log: readonly LogRecord[]): {
    pair: [PlayerId, PlayerId];
    voter: PlayerId;
    value: number;
    metric?: MetricKey | undefined;
}[] {
    const out: { pair: [PlayerId, PlayerId]; voter: PlayerId; value: number; metric?: MetricKey | undefined }[] = [];
    for (const rec of log) {
        if (rec.value.kind !== "pair_vote") continue;
        out.push({
            pair: sortedPair(rec.value.pair[0], rec.value.pair[1]),
            voter: rec.playerId,
            value: rec.value.value,
            metric: rec.metric,
        });
    }
    return out;
}

/** All pair_pick responses in the log. */
export function pairPicks(log: readonly LogRecord[]): {
    pair: [PlayerId, PlayerId];
    voter: PlayerId;
    metric?: MetricKey | undefined;
}[] {
    const out: { pair: [PlayerId, PlayerId]; voter: PlayerId; metric?: MetricKey | undefined }[] = [];
    for (const rec of log) {
        if (rec.value.kind !== "pair_pick") continue;
        out.push({
            pair: sortedPair(rec.value.pair[0], rec.value.pair[1]),
            voter: rec.playerId,
            metric: rec.metric,
        });
    }
    return out;
}

/** Every pick response in the log as a plain tuple. */
export function pickResponses(log: readonly LogRecord[]): {
    picker: PlayerId;
    target: PlayerId;
    metric?: MetricKey | undefined;
}[] {
    const out: { picker: PlayerId; target: PlayerId; metric?: MetricKey | undefined }[] = [];
    for (const rec of log) {
        if (rec.value.kind !== "pick") continue;
        out.push({ picker: rec.playerId, target: rec.value.target, metric: rec.metric });
    }
    return out;
}

/** True when the response is a directed answer about another person. */
export const isDirectedAboutOthers = (value: ResponseValue): boolean =>
    value.kind === "pick" ||
    (value.kind === "rating" && value.about !== "self") ||
    value.kind === "pair_pick" ||
    value.kind === "pair_vote";
