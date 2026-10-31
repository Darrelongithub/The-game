// packages/engine/src/internal.ts
// Shared deterministic helpers for the scoring engine. Pure: no I/O, no
// network, no Date.now(), no unseeded randomness anywhere in this package.
import {
  CONFIDENCE_RULES,
  MIN_PLAYERS,
  pseudonym,
  type LogRecord,
  type MetricKey,
  type PlayerId,
  type PromptCoding,
  type ResponseValue,
  type RoomMeta,
  type TraitId,
} from "../../shared/src/contracts.ts";

/** Brute-force matching is only sane up to 12 players. */
export const MAX_MATCH_PLAYERS = 12;

/**
 * Engine-local tuning. These are judgement calls the contract leaves open;
 * the frozen contract constants are always honoured as-is. The thresholds sit
 * ABOVE chance level for a 4–11 player room so a uniform-random room does not
 * manufacture high-confidence verdicts.
 */
export const ENGINE_TUNING = {
  /** A signal "supports" a verdict when it clears these bars. */
  support: {
    pickOverlap: 0.5,
    mutualPick: 0.5,
    evidence: 0.5,
    traitAgreement: 0.8,
  },
  /** Rivals need a mid-range pair score: close enough to matter, not a ship. */
  rivalPairScoreMid: { min: 0.2, max: 0.65 },
  /** A public "hates" verdict needs at least this share of the room. */
  hatesMinShare: 0.5,
  /** …and at least this many distinct nominators. */
  hatesMinNominators: 2,
  /** A percent line needs at least this many voters behind it. */
  percentMinVoters: 2,
  /** A percent line needs at least this share of eligible players. */
  percentMinShare: 0.25,
  /** A couple verdict needs at least this many yes votes. */
  coupleMinYes: 2,
  /** …and this share of the voters. */
  coupleMinYesShare: 0.5,
  /** Blind spot: how far self-perception may sit from the room. */
  blindspotMinGap: 2,
  /** …and how many raters the room needs for a peer mean to count. */
  blindspotMinRaters: 2,
  /** Templates are chosen by data strength. */
  toneBands: { mild: 0.4, spicy: 0.65, filthy: 0.85 },
  /** A free agent needs zero picks across every couple-ish metric. */
  freeAgentMinNominators: 0,
} as const;

export const POSITIVE_CODINGS: ReadonlySet<PromptCoding> = new Set(["couple", "friendship"]);
export const NEGATIVE_CODINGS: ReadonlySet<PromptCoding> = new Set(["friction", "rivalry"]);

/** Metrics that name someone as attractive / desirable. */
export const DESIRE_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>([
  "sex-desire",
  "crush",
  "hookups",
  "body-count",
  "best-in-bed",
]);

/** Metrics that say someone is dangerous, fake, or untrustworthy. */
export const NEGATIVE_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>([
  "would-snitch",
  "would-cheat",
  "is-fake",
  "most-dangerous",
  "ruin-friendship",
  "betrayal",
]);

/** Metrics that name someone as a friend / core. */
export const CLOSENESS_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>([
  "closest",
  "trust",
  "couple-fit",
]);

/** Metrics that make someone a plausible romantic partner. */
export const COUPLE_METRICS: ReadonlySet<MetricKey> = new Set<MetricKey>([
  "couple-fit",
  "crush",
  "gay-hypothetical",
]);

export const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

export const meanOf = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

/** Player ids in the order the server listed them (Player 1 = first). */
export const playerIdsInOrder = (meta: RoomMeta): PlayerId[] => meta.players.map((p) => p.id);

/** Player ids sorted with `<` — the a < b convention for PairSignal. */
export const playerIdsSorted = (meta: RoomMeta): PlayerId[] =>
  [...playerIdsInOrder(meta)].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));

export const sortedPair = (x: PlayerId, y: PlayerId): [PlayerId, PlayerId] =>
  x < y ? [x, y] : [y, x];

export const pairKey = (x: PlayerId, y: PlayerId): string => {
  const [a, b] = sortedPair(x, y);
  return `${a}\u0000${b}`;
};

/** "Player N" for a player — engine evidence/facts never use real aliases. */
export const pseudoOf = (meta: RoomMeta, id: PlayerId): string => {
  const idx = meta.players.findIndex((p) => p.id === id);
  return idx >= 0 ? pseudonym(idx) : id;
};

/** Real alias — ONLY for NightDigest fields, whose contract shape is by alias. */
export const aliasOf = (meta: RoomMeta, id: PlayerId): string =>
  meta.players.find((p) => p.id === id)?.alias ?? id;

/** Stable id for a log record. */
export const logRecordId = (rec: LogRecord): string =>
  `${rec.roomId}:${rec.roundId}:${rec.promptId}:${rec.playerId}:${rec.at}`;

/** Throws unless the room can be scored at all (test: n=4 works, n<4 throws). */
export function assertScorableMeta(meta: RoomMeta): void {
  const n = meta.players.length;
  if (n < MIN_PLAYERS) {
    throw new Error(`engine: need at least ${MIN_PLAYERS} players to score a room, got ${n}`);
  }
  if (n > MAX_MATCH_PLAYERS) {
    throw new Error(`engine: matching is brute-forced for n<=${MAX_MATCH_PLAYERS}, got ${n}`);
  }
  const seen = new Set<PlayerId>();
  for (const p of meta.players) {
    if (seen.has(p.id)) throw new Error(`engine: duplicate player id ${p.id}`);
    seen.add(p.id);
  }
}

/** spec §5 confidence: high = ≥3 independent signal types, med = 2, low = 1 (or 0). */
export const confidenceFromCount = (independentSignals: number): "high" | "med" | "low" =>
  independentSignals >= CONFIDENCE_RULES.high.independentSignals
    ? "high"
    : independentSignals >= CONFIDENCE_RULES.med.independentSignals
      ? "med"
      : "low";

/** Incidentally presentational: "8" not "8.0", "8.3" for 8.25, etc. */
export const formatNumber = (x: number): string => {
  if (Number.isInteger(x)) return String(x);
  const s = x.toFixed(1);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
};

// ---------- picks ----------
export interface PickRec {
    roundId: string;
    picker: PlayerId;
    target: PlayerId;
    coding: PromptCoding;
    metric?: MetricKey | undefined;
    rec: LogRecord;
}

export const getPicks = (log: readonly LogRecord[]): PickRec[] => {
    const out: PickRec[] = [];
    for (const rec of log) {
        if (rec.value.kind === "pick") {
            out.push({
                roundId: rec.roundId,
                picker: rec.playerId,
                target: rec.value.target,
                coding: rec.coding,
                metric: rec.metric,
                rec,
            });
        }
    }
    return out;
};

// ---------- ratings ----------
export interface RatingIndex {
    /** self.get(player)?.get(trait) → averaged self rating. */
    self: Map<PlayerId, Map<TraitId, number>>;
    /** peerByRater.get(about)?.get(trait)?.get(rater) → that rater's rating of `about`. */
    peerByRater: Map<PlayerId, Map<TraitId, Map<PlayerId, number>>>;
}

export function buildRatingIndex(log: readonly LogRecord[]): RatingIndex {
    const selfAcc = new Map<string, number[]>();
    const peerAcc = new Map<string, number[]>();
    const push = (m: Map<string, number[]>, k: string, v: number) => {
        const arr = m.get(k);
        if (arr) arr.push(v);
        else m.set(k, [v]);
    };
    for (const rec of log) {
        if (rec.value.kind !== "rating") continue;
        if (rec.value.about === "self") {
            push(selfAcc, `${rec.playerId}\u0000${rec.value.trait}`, rec.value.value);
        } else {
            push(peerAcc, `${rec.value.about}\u0000${rec.value.trait}\u0000${rec.playerId}`, rec.value.value);
        }
    }
    const self = new Map<PlayerId, Map<TraitId, number>>();
    for (const [k, vs] of selfAcc) {
        const [player, trait] = k.split("\u0000") as [PlayerId, TraitId];
        let m = self.get(player);
        if (!m) { m = new Map(); self.set(player, m); }
        m.set(trait, meanOf(vs));
    }
    const peerByRater = new Map<PlayerId, Map<TraitId, Map<PlayerId, number>>>();
    for (const [k, vs] of peerAcc) {
        const [about, trait, rater] = k.split("\u0000") as [PlayerId, TraitId, PlayerId];
        let byTrait = peerByRater.get(about);
        if (!byTrait) { byTrait = new Map(); peerByRater.set(about, byTrait); }
        let byRater = byTrait.get(trait);
        if (!byRater) { byRater = new Map(); byTrait.set(trait, byRater); }
        byRater.set(rater, meanOf(vs));
    }
    return { self, peerByRater };
}

// ---------- token overlap ----------
export const tokenize = (text: string): Set<string> =>
    new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0));

/** Jaccard over lowercase alphanumeric token sets. */
export const tokenJaccard = (a: string, b: string): number => {
    const sa = tokenize(a);
    const sb = tokenize(b);
    if (sa.size === 0 && sb.size === 0) return 0;
    let inter = 0;
    for (const t of sa) if (sb.has(t)) inter++;
    const union = sa.size + sb.size - inter;
    return union === 0 ? 0 : inter / union;
};

/** Does this response carry a self-directed answer? (used by the engine) */
export const isSelfDirected = (value: ResponseValue): boolean =>
    value.kind === "rating" && value.about === "self";

/**
 * Pooled directed-pick rate between a pair for a metric filter:
 * (a→b hits + b→a hits) / (a's filtered picks + b's filtered picks).
 * 0 when neither player made a filtered pick. This is the single
 * normalisation behind mutualPick / coupleEvidence / friendEvidence /
 * negativeMutual, so every pair component is hand-computable the same way.
 */
export function pooledPairRate(
    picks: readonly PickRec[],
    a: PlayerId,
    b: PlayerId,
    include: (metric: MetricKey | undefined) => boolean,
): number {
    let hits = 0;
    let total = 0;
    for (const p of picks) {
        if (!include(p.metric)) continue;
        if (p.picker === a || p.picker === b) {
            total++;
            if ((p.picker === a && p.target === b) || (p.picker === b && p.target === a)) hits++;
        }
    }
    return total === 0 ? 0 : hits / total;
}

/** Directed hits a→b and a's total picks under a metric filter. */
export function directedPicks(
    picks: readonly PickRec[],
    from: PlayerId,
    to: PlayerId,
    include: (metric: MetricKey | undefined) => boolean,
): { hits: number; total: number; rate: number } {
    let hits = 0;
    let total = 0;
    for (const p of picks) {
        if (p.picker !== from || !include(p.metric)) continue;
        total++;
        if (p.target === to) hits++;
    }
    return total === 0 ? { hits, total, rate: 0 } : { hits, total, rate: hits / total };
}
