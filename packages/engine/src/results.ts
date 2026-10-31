// packages/engine/src/results.ts
// THE VERDICTS — the only things the reveal is allowed to say.
//
// Rules that are not negotiable:
//   • Every verdict is backed by data. If the data is weak, there is NO
//     verdict — a missing line is always better than an invented one.
//   • The allowed kinds are fixed: hates, core, couple, sex, percent,
//     gaycouple, bodycount, bestinbed, besties, rivals, freeagent, blindspot.
//   • Templates are picked by DATA STRENGTH (mild → spicy → filthy).
//   • Gay-hypothetical answers are HYPOTHETICAL ONLY. The reveal never prints
//     "X is gay" and never prints who was named in a gay-guess pick.
//   • Copy uses "Player N" pseudonyms. The server swaps them for aliases.
//
// Pure: no I/O, no randomness, no Date.now().
import {
    type LogRecord,
    type MetricKey,
    type PlayerId,
    type Results,
    type RoomMeta,
    type TraitId,
    type Verdict,
    type VerdictKind,
    type VerdictTone,
} from "../../shared/src/contracts.ts";
import {
    CLOSENESS_METRICS,
    DESIRE_METRICS,
    ENGINE_TUNING,
    NEGATIVE_METRICS,
    buildRatingIndex,
    clamp01,
    formatNumber,
    meanOf,
    pairKey,
    playerIdsInOrder,
    pseudoOf,
    sortedPair,
} from "./internal.ts";
import {
    pairPicks,
    pairVotes,
    pickTally,
    tallyAcross,
    type PairWeights,
} from "./signals.ts";
import { DEFAULT_WEIGHTS } from "../../shared/src/contracts.ts";

export interface ResultsConfig {
    weights?: PairWeights;
    /** How many verdicts of one kind to allow at most. */
    maxPerKind?: Partial<Record<VerdictKind, number>>;
}

const DEFAULTS_PER_KIND: Record<VerdictKind, number> = {
    hates: 1,
    core: 1,
    couple: 1,
    sex: 1,
    percent: 3,
    gaycouple: 1,
    bodycount: 1,
    bestinbed: 1,
    besties: 2,
    rivals: 1,
    freeagent: 1,
    blindspot: 2,
};

/** Tone by data strength. */
function toneFor(strength: number): VerdictTone {
    const b = ENGINE_TUNING.toneBands;
    if (strength >= b.filthy) return "filthy";
    if (strength >= b.spicy) return "spicy";
    if (strength >= b.mild) return "mild";
    return "mild";
}

/** Percentage string for a share 0..1. */
const pct = (share: number): string => `${Math.round(clamp01(share) * 100)}%`;

/** A stable id for a verdict. */
let verdictSeq = 0;
const vid = (kind: VerdictKind, ...parts: string[]): string =>
    `${kind}-${parts.join("-")}-${verdictSeq++}`;

/**
 * Reset the verdict id counter. Only used by tests so ids are reproducible.
 */
export function resetVerdictIds(): void {
    verdictSeq = 0;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Distinct players who picked `target` for any of `metrics`. */
function nominatorsFor(
    log: readonly LogRecord[],
    target: PlayerId,
    metrics: ReadonlySet<MetricKey>,
): Set<PlayerId> {
    const out = new Set<PlayerId>();
    for (const rec of log) {
        if (rec.value.kind !== "pick") continue;
        if (!rec.metric || !metrics.has(rec.metric)) continue;
        if (rec.value.target !== target) continue;
        out.add(rec.playerId);
    }
    return out;
}

/** How many distinct players answered a given metric at all. */
function votersFor(log: readonly LogRecord[], metrics: ReadonlySet<MetricKey>): Set<PlayerId> {
    const out = new Set<PlayerId>();
    for (const rec of log) {
        if (!rec.metric || !metrics.has(rec.metric)) continue;
        if (rec.value.kind === "pick" || rec.value.kind === "rating" || rec.value.kind === "text") {
            out.add(rec.playerId);
        }
    }
    return out;
}

/** Every pair that was voted on, with its yes/no tally. */
interface PairTally {
    pair: [PlayerId, PlayerId];
    yes: number;
    no: number;
    voters: number;
}

function tallyPairVotes(log: readonly LogRecord[], metric?: MetricKey): Map<string, PairTally> {
    const out = new Map<string, PairTally>();
    for (const v of pairVotes(log)) {
        if (metric && v.metric !== metric) continue;
        const key = pairKey(v.pair[0], v.pair[1]);
        let t = out.get(key);
        if (!t) {
            t = { pair: sortedPair(v.pair[0], v.pair[1]), yes: 0, no: 0, voters: 0 };
            out.set(key, t);
        }
        // 1..5 scale: 4 and 5 count as yes, 1 and 2 as no, 3 is a shrug.
        if (v.value >= 4) t.yes += 1;
        else if (v.value <= 2) t.no += 1;
        t.voters += 1;
    }
    return out;
}

// ---------------------------------------------------------------------------
// the compute
// ---------------------------------------------------------------------------

/**
 * Compute every verdict the night actually supports.
 * Returns an empty verdict list rather than inventing anything.
 */
export function computeResults(
    log: readonly LogRecord[],
    meta: RoomMeta,
    config: ResultsConfig = {},
): Results {
    const weights = config.weights ?? DEFAULT_WEIGHTS;
    const maxPerKind = { ...DEFAULTS_PER_KIND, ...(config.maxPerKind ?? {}) };
    const ids = playerIdsInOrder(meta);
    const playerCount = ids.length;
    const verdicts: Verdict[] = [];
    const push = (v: Verdict): void => {
        const limit = maxPerKind[v.kind] ?? 1;
        if (verdicts.filter((x) => x.kind === v.kind).length >= limit) return;
        verdicts.push(v);
    };

    // ---------------- HATES: the group turns on one person ----------------
    {
        const voters = votersFor(log, NEGATIVE_METRICS);
        const denom = Math.max(1, voters.size);
        let worst: { id: PlayerId; nominators: Set<PlayerId>; share: number } | undefined;
        for (const id of ids) {
            const nominators = nominatorsFor(log, id, NEGATIVE_METRICS);
            if (nominators.size < ENGINE_TUNING.hatesMinNominators) continue;
            const share = nominators.size / denom;
            if (share < ENGINE_TUNING.hatesMinShare) continue;
            if (!worst || nominators.size > worst.nominators.size) {
                worst = { id, nominators, share };
            }
        }
        if (worst) {
            const name = pseudoOf(meta, worst.id);
            const strength = clamp01(worst.share * (worst.nominators.size / Math.max(1, playerCount)));
            const text =
                toneFor(strength) === "filthy"
                    ? `Everyone in this room has a problem with ${name} and they all know it.`
                    : toneFor(strength) === "spicy"
                      ? `The group lowkey hates on ${name}.`
                      : `${name} is the one everybody is quietly keeping an eye on.`;
            push({
                id: vid("hates", worst.id),
                kind: "hates",
                subjects: [worst.id],
                tone: toneFor(strength),
                text,
                numbers: { nominators: worst.nominators.size, voters: voters.size, share: Number(worst.share.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- CORE: the two people the room orbits ----------------
    {
        const friendPicks = tallyAcross(log, CLOSENESS_METRICS);
        let best: { a: PlayerId; b: PlayerId; count: number; share: number } | undefined;
        for (const [a, setA] of friendPicks) {
            for (const b of setA) {
                if (a === b) continue;
                const setB = friendPicks.get(b);
                if (!setB || !setB.has(a)) continue; // needs BOTH directions
                const count = Math.min(setA.size, setB.size);
                const share = count / Math.max(1, playerCount - 1);
                if (!best || count > best.count) best = { a, b, count, share };
            }
        }
        if (best && best.count >= 2) {
            const an = pseudoOf(meta, best.a);
            const bn = pseudoOf(meta, best.b);
            const strength = clamp01(best.share);
            const text =
                toneFor(strength) === "filthy"
                    ? `${an} and ${bn} are the reason nobody else gets invited anywhere.`
                    : toneFor(strength) === "spicy"
                      ? `${an} and ${bn} are the core of this group.`
                      : `${an} and ${bn} are the core of this group.`;
            push({
                id: vid("core", best.a, best.b),
                kind: "core",
                subjects: [best.a, best.b],
                tone: toneFor(strength),
                text,
                numbers: { voters: best.count, share: Number(best.share.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- COUPLE: the random-pair ship vote ----------------
    {
        const tallies = tallyPairVotes(log);
        let best: PairTally | undefined;
        for (const t of tallies.values()) {
            if (t.yes < ENGINE_TUNING.coupleMinYes) continue;
            const share = t.yes / Math.max(1, t.voters);
            if (share < ENGINE_TUNING.coupleMinYesShare) continue;
            if (!best || share > best.yes / Math.max(1, best.voters)) best = t;
        }
        // "Who would make the best couple here?" pair picks also count as votes.
        if (!best) {
            const pp = pairPicks(log);
            const counts = new Map<string, { pair: [PlayerId, PlayerId]; n: number }>();
            for (const p of pp) {
                const key = pairKey(p.pair[0], p.pair[1]);
                const c = counts.get(key);
                if (c) c.n += 1;
                else counts.set(key, { pair: p.pair, n: 1 });
            }
            for (const c of counts.values()) {
                const share = c.n / Math.max(1, pp.length);
                if (share >= ENGINE_TUNING.coupleMinYesShare && (!best || c.n > (best?.yes ?? 0))) {
                    best = { pair: c.pair, yes: c.n, no: 0, voters: pp.length };
                }
            }
        }
        if (best) {
            const an = pseudoOf(meta, best.pair[0]);
            const bn = pseudoOf(meta, best.pair[1]);
            const share = best.yes / Math.max(1, best.voters);
            const strength = clamp01(share);
            const tone = toneFor(strength);
            const text =
                tone === "filthy"
                    ? `${an} and ${bn} would lowkey be a good couple (${pct(share)} said yes).`
                    : tone === "spicy"
                      ? `${an} and ${bn} would lowkey be a good couple (${pct(share)} said yes).`
                      : `${an} and ${bn} would make a good couple (${pct(share)} said yes).`;
            push({
                id: vid("couple", best.pair[0], best.pair[1]),
                kind: "couple",
                subjects: [best.pair[0], best.pair[1]],
                tone,
                text,
                numbers: { yes: best.yes, no: best.no, voters: best.voters, share: Number(share.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- SEX: two people who picked each other ----------------
    {
        const desire = pickTally(log, "sex-desire");
        let best: { a: PlayerId; b: PlayerId; n: number } | undefined;
        for (const [a, setA] of desire) {
            for (const b of setA) {
                if (a === b) continue;
                const setB = desire.get(b);
                if (!setB || !setB.has(a)) continue;
                const n = Math.min(setA.size, setB.size);
                if (!best || n > best.n) best = { a, b, n };
            }
        }
        if (best && best.n >= 1) {
            const an = pseudoOf(meta, best.a);
            const bn = pseudoOf(meta, best.b);
            const strength = clamp01(best.n / Math.max(1, playerCount - 1));
            const tone = toneFor(strength);
            const text =
                tone === "filthy"
                    ? `${an} and ${bn} should just have sex.`
                    : tone === "spicy"
                      ? `${an} and ${bn} should just have sex.`
                      : `${an} and ${bn} have a whole thing going on.`;
            push({
                id: vid("sex", best.a, best.b),
                kind: "sex",
                subjects: [best.a, best.b],
                tone,
                text,
                numbers: { voters: best.n, share: Number(strength.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- PERCENT: share of OTHER players who picked X ----------------
    {
        const metrics: { metric: MetricKey; label: string; hot: boolean }[] = [
            { metric: "sex-desire", label: "want to have sex with", hot: true },
            { metric: "crush", label: "have a crush on", hot: false },
            { metric: "body-count", label: "think has the highest body count", hot: true },
            { metric: "best-in-bed", label: "think is the best in bed", hot: true },
        ];
        const others = Math.max(1, playerCount - 1);
        for (const m of metrics) {
            const tally = pickTally(log, m.metric);
            const voters = votersFor(log, new Set([m.metric]));
            if (voters.size < ENGINE_TUNING.percentMinVoters) continue;
            for (const [target, pickers] of tally) {
                // Share of OTHER players: the target can never be their own voter.
                const share = pickers.size / others;
                if (share < ENGINE_TUNING.percentMinShare) continue;
                const name = pseudoOf(meta, target);
                const strength = clamp01(share);
                const tone = toneFor(strength);
                const text = m.hot && tone === "filthy"
                    ? `${pct(share)} of people here want to have sex with ${name}.`
                    : m.hot && tone === "spicy"
                      ? `${pct(share)} of people here want to have sex with ${name}.`
                      : `${pct(share)} of the room ${m.label} ${name}.`;
                push({
                    id: vid("percent", m.metric, target),
                    kind: "percent",
                    subjects: [target],
                    tone,
                    text,
                    numbers: { voters: pickers.size, eligible: others, share: Number(share.toFixed(3)) },
                    strength,
                });
            }
        }
    }

    // ---------------- GAY COUPLE: hypothetical only, never "X is gay" -------
    // Source: the "If {P1} and {P2} were gay, would they make a good couple?"
    // vote. The pair was on screen in the question itself, so naming it is not
    // revealing who was named in a gay-GUESS pick. Guesses are never printed.
    {
        const tallies = tallyPairVotes(log, "gay-hypothetical");
        let best: PairTally | undefined;
        for (const t of tallies.values()) {
            if (t.yes < ENGINE_TUNING.coupleMinYes) continue;
            const share = t.yes / Math.max(1, t.voters);
            if (share < ENGINE_TUNING.coupleMinYesShare) continue;
            if (!best || share > best.yes / Math.max(1, best.voters)) best = t;
        }
        if (best) {
            const an = pseudoOf(meta, best.pair[0]);
            const bn = pseudoOf(meta, best.pair[1]);
            const share = best.yes / Math.max(1, best.voters);
            const strength = clamp01(share);
            push({
                id: vid("gaycouple", best.pair[0], best.pair[1]),
                kind: "gaycouple",
                subjects: [best.pair[0], best.pair[1]],
                tone: toneFor(strength),
                text: `If ${an} and ${bn} were gay they'd be a good couple (${pct(share)} said yes).`,
                numbers: { yes: best.yes, voters: best.voters, share: Number(share.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- BODY COUNT: the room's champion ----------------
    {
        const tally = pickTally(log, "body-count");
        let best: { id: PlayerId; n: number } | undefined;
        for (const [id, pickers] of tally) {
            if (!best || pickers.size > best.n) best = { id, n: pickers.size };
        }
        if (best && best.n >= 2) {
            const strength = clamp01(best.n / Math.max(1, playerCount - 1));
            const name = pseudoOf(meta, best.id);
            const tone = toneFor(strength);
            push({
                id: vid("bodycount", best.id),
                kind: "bodycount",
                subjects: [best.id],
                tone,
                text:
                    tone === "filthy"
                        ? `The room thinks ${name} has the highest body count in here by a mile.`
                        : `The room thinks ${name} has the highest body count.`,
                numbers: { voters: best.n, share: Number(strength.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- BEST IN BED ----------------
    {
        const tally = pickTally(log, "best-in-bed");
        let best: { id: PlayerId; n: number } | undefined;
        for (const [id, pickers] of tally) {
            if (!best || pickers.size > best.n) best = { id, n: pickers.size };
        }
        if (best && best.n >= 2) {
            const strength = clamp01(best.n / Math.max(1, playerCount - 1));
            const name = pseudoOf(meta, best.id);
            const tone = toneFor(strength);
            push({
                id: vid("bestinbed", best.id),
                kind: "bestinbed",
                subjects: [best.id],
                tone,
                text:
                    tone === "filthy"
                        ? `The room thinks ${name} is the best in bed here. Ask them for details after.`
                        : `The room thinks ${name} is the best in bed here.`,
                numbers: { voters: best.n, share: Number(strength.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- BESTIES: mutual closeness ----------------
    {
        const closeness = tallyAcross(log, CLOSENESS_METRICS);
        const found: { a: PlayerId; b: PlayerId; n: number }[] = [];
        for (const [a, setA] of closeness) {
            for (const b of setA) {
                if (a === b) continue;
                const setB = closeness.get(b);
                if (!setB || !setB.has(a)) continue;
                found.push({ a, b, n: Math.min(setA.size, setB.size) });
            }
        }
        found.sort((x, y) => y.n - x.n);
        for (const f of found.slice(0, maxPerKind.besties ?? 2)) {
            if (f.n < 2) break;
            const an = pseudoOf(meta, f.a);
            const bn = pseudoOf(meta, f.b);
            const strength = clamp01(f.n / Math.max(1, playerCount - 1));
            push({
                id: vid("besties", f.a, f.b),
                kind: "besties",
                subjects: [f.a, f.b],
                tone: toneFor(strength),
                text: `${an} and ${bn} are inseparable.`,
                numbers: { voters: f.n, share: Number(strength.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- RIVALS: mutual friction ----------------
    {
        const neg = tallyAcross(log, NEGATIVE_METRICS);
        const found: { a: PlayerId; b: PlayerId; n: number }[] = [];
        for (const [a, setA] of neg) {
            for (const b of setA) {
                if (a === b) continue;
                const setB = neg.get(b);
                if (!setB || !setB.has(a)) continue;
                found.push({ a, b, n: Math.min(setA.size, setB.size) });
            }
        }
        found.sort((x, y) => y.n - x.n);
        const top = found[0];
        if (top && top.n >= 1) {
            const an = pseudoOf(meta, top.a);
            const bn = pseudoOf(meta, top.b);
            const strength = clamp01(top.n / Math.max(1, playerCount - 1));
            push({
                id: vid("rivals", top.a, top.b),
                kind: "rivals",
                subjects: [top.a, top.b],
                tone: toneFor(strength),
                text: `${an} and ${bn} cannot be in the same room.`,
                numbers: { voters: top.n, share: Number(strength.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- FREE AGENT: nobody is claiming X ----------------
    {
        const claimed = tallyAcross(log, DESIRE_METRICS);
        const candidates = ids.filter((id) => (claimed.get(id)?.size ?? 0) === 0);
        // Only fair if enough of the room had the chance to claim someone.
        // Everyone answers every case, so "answered a pick" is the right proxy.
        const asked = new Set<PlayerId>();
        for (const record of log) {
            if (record.value.kind === "pick") asked.add(record.playerId);
        }
        const askedCount = asked.size;
        if (candidates.length > 0 && askedCount >= Math.max(2, Math.ceil(playerCount / 2))) {
            const id = candidates[0]!;
            const name = pseudoOf(meta, id);
            const strength = clamp01(askedCount / Math.max(1, playerCount));
            push({
                id: vid("freeagent", id),
                kind: "freeagent",
                subjects: [id],
                tone: toneFor(strength),
                text: `Nobody in this room is claiming ${name}.`,
                numbers: { asked: askedCount, share: Number(strength.toFixed(3)) },
                strength,
            });
        }
    }

    // ---------------- BLIND SPOT: self-rating vs the room ----------------
    {
        const idx = buildRatingIndex(log);
        const traits: TraitId[] = ["loyalty", "chaos", "reliability", "warmth", "honesty", "spice"];
        const traitLabel: Record<TraitId, string> = {
            loyalty: "loyal",
            chaos: "chaotic",
            reliability: "reliable",
            warmth: "warm",
            honesty: "honest",
            spice: "hot",
        };
        const found: { id: PlayerId; trait: TraitId; self: number; room: number; raters: number }[] = [];
        for (const id of ids) {
            const selfMap = idx.self.get(id);
            if (!selfMap) continue;
            for (const trait of traits) {
                const self = selfMap.get(trait);
                if (self === undefined) continue;
                const peerMap = idx.peerByRater.get(id)?.get(trait);
                if (!peerMap) continue;
                const ratings = [...peerMap.values()];
                if (ratings.length < ENGINE_TUNING.blindspotMinRaters) continue;
                const room = meanOf(ratings);
                const gap = Math.abs(self - room);
                if (gap < ENGINE_TUNING.blindspotMinGap) continue;
                found.push({ id, trait, self, room, raters: ratings.length });
            }
        }
        found.sort((x, y) => Math.abs(y.self - y.room) - Math.abs(x.self - x.room));
        for (const f of found.slice(0, maxPerKind.blindspot ?? 2)) {
            const name = pseudoOf(meta, f.id);
            const gap = Math.abs(f.self - f.room);
            const strength = clamp01(gap / 9);
            const direction = f.self > f.room ? "overrated themselves" : "undersold themselves";
            push({
                id: vid("blindspot", f.id, f.trait),
                kind: "blindspot",
                subjects: [f.id],
                tone: toneFor(strength),
                text: `${name} thinks they're ${formatNumber(f.self)}/10 ${traitLabel[f.trait]}, the room said ${formatNumber(f.room)}.`,
                numbers: {
                    self: Number(f.self.toFixed(2)),
                    room: Number(f.room.toFixed(2)),
                    raters: f.raters,
                    gap: Number(gap.toFixed(2)),
                },
                strength,
            });
        }
    }

    const freeAgent = verdicts.find((v) => v.kind === "freeagent")?.subjects[0];
    return {
        roomId: meta.roomId,
        verdicts,
        pairScores: [],
        ...(freeAgent ? { freeAgent } : {}),
        computedAt: 0,
    };
}

/**
 * Assertion used by the server and the tests: no verdict may print "is gay"
 * or name a gay-guess target. The gay-guess metric never reaches this
 * function's outputs — the coupling path is the pair VOTE, not the guess.
 */
export function assertNoOrientationLeak(results: Results): void {
    for (const v of results.verdicts) {
        if (/\bis gay\b/i.test(v.text)) {
            throw new Error(`engine: verdict ${v.id} leaks an orientation claim`);
        }
    }
}
