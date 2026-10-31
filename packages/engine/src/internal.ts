// packages/engine/src/internal.ts
// Shared deterministic helpers for the scoring engine. Pure: no I/O, no
// network, no Date.now(), no unseeded randomness anywhere in this package.
import {
  CONFIDENCE_RULES,
  CONSENSUS_MIN_PICKERS,
  JOKER_GUARD,
  MIN_PLAYERS,
  pseudonym,
  type Confidence,
  type LogRecord,
  type PlayerId,
  type PromptCoding,
  type RoomMeta,
  type TraitId,
} from "../../shared/src/contracts.ts";

/** Brute-force matching is only sane up to 12 players (spec §5: ≤10,395 matchings). */
export const MAX_MATCH_PLAYERS = 12;

/**
 * Engine-local tuning (spec §14: tuning = config, not logic). The frozen
 * contract constants (DEFAULT_WEIGHTS, TOXIC_WEIGHTS, CONFIDENCE_RULES,
 * JOKER_GUARD, MC_SIMULATIONS) are always honoured as-is; the values below
 * are the judgement calls the contract leaves open. They are set ABOVE
 * chance level for a 4–11 player room so a uniform-random room does not
 * manufacture high-confidence claims (see README for the arithmetic).
 */
export const ENGINE_TUNING = {
  /** A pair component "supports" a claim when it clears these bars. */
  support: {
    pickOverlap: 0.5,
    mutualPick: 0.5,
    evidence: 0.5,
    debriefSim: 0.6, // a measured similarity must clear this evidence bar
    iosMean: 0.65,
    traitAgreement: 0.8, // uniform-random ratings average ~0.633; 0.8 means mean |self-peer| <= 1.8
  },
  /** Rivals need a mid-range pair_score: close enough to matter, not a ship. */
  rivalPairScoreMid: { min: 0.2, max: 0.65 },
  /** A public "toxic" claim needs at least this Monte-Carlo percentile. */
  toxicEmitPercentile: 0.95,
  /** Fixed seed for the toxic Monte-Carlo percentile (deterministic replay). */
  mcSeed: 0xc0ffee,
  blindspotMinGap: 2,
  blindspotMinRaters: 2,
  blindspotSecretMinGap: 1,
  onesided: { minRate: 0.5, maxReverseRate: 0.25, minGap: 0.5, minPositivePicks: 2 },
  consensusMinVoters: CONSENSUS_MIN_PICKERS,
} as const;

export const POSITIVE_CODINGS: ReadonlySet<PromptCoding> = new Set(["couple", "friendship"]);
export const NEGATIVE_CODINGS: ReadonlySet<PromptCoding> = new Set(["friction", "rivalry"]);

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

/**
 * Stable id for a log record, used by the toxic tag seam `tagOf(recordId)`.
 * LogRecord carries no id field in the frozen contract, so the engine
 * derives this composite; a contract request for that gap is in NOTES/.
 */
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
export const confidenceFromCount = (independentSignals: number): Confidence =>
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
  rec: LogRecord;
}

export const getPicks = (log: readonly LogRecord[]): PickRec[] => {
  const out: PickRec[] = [];
  for (const rec of log) {
    if (rec.value.kind === "pick" && rec.value.target !== rec.playerId) {
      out.push({ roundId: rec.roundId, picker: rec.playerId, target: rec.value.target, coding: rec.coding, rec });
    }
  }
  return out;
};

/** Exact per-picker weights used by toxic scoring, also observable in tests. */
export function jokerNominationWeights(log: readonly LogRecord[], ids: readonly PlayerId[]): Map<PlayerId, number> {
  const pickerTargets = new Map<PlayerId, Map<PlayerId, number>>();
  for (const p of getPicks(log)) {
    let targets = pickerTargets.get(p.picker);
    if (!targets) { targets = new Map(); pickerTargets.set(p.picker, targets); }
    targets.set(p.target, (targets.get(p.target) ?? 0) + 1);
  }
  const weights = new Map<PlayerId, number>();
  for (const id of ids) {
    const targets = pickerTargets.get(id);
    const counts = targets ? [...targets.values()] : [];
    const total = counts.reduce((sum, count) => sum + count, 0);
    const maxShare = total ? Math.max(...counts) / total : 0;
    weights.set(id, maxShare > JOKER_GUARD.sameTargetShare ? JOKER_GUARD.downweight : 1);
  }
  return weights;
}

/**
 * Pooled directed-pick rate between a pair for a coding filter:
 * (a→b hits + b→a hits) / (a's filtered picks + b's filtered picks).
 * 0 when neither player made a filtered pick. This is the single
 * normalisation behind mutualPick / coupleEvidence / friendEvidence /
 * negativeMutual, so every pair component is hand-computable the same way.
 */
export function pooledPairRate(
  picks: readonly PickRec[],
  a: PlayerId,
  b: PlayerId,
  include: (coding: PromptCoding) => boolean,
): number {
  let hits = 0;
  let total = 0;
  for (const p of picks) {
    if (!include(p.coding)) continue;
    if (p.picker === a || p.picker === b) {
      total++;
      if ((p.picker === a && p.target === b) || (p.picker === b && p.target === a)) hits++;
    }
  }
  return total === 0 ? 0 : hits / total;
}

/** Directed hits a→b and a's total picks under a coding filter. */
export function directedPicks(
  picks: readonly PickRec[],
  from: PlayerId,
  to: PlayerId,
  include: (coding: PromptCoding) => boolean,
): { hits: number; total: number; rate: number } {
  let hits = 0;
  let total = 0;
  for (const p of picks) {
    if (p.picker !== from || !include(p.coding)) continue;
    total++;
    if (p.target === to) hits++;
  }
  return { hits, total, rate: total === 0 ? 0 : hits / total };
}

// ---------- ratings & IOS ----------

export interface RatingIndex {
  /** self.get(player)?.get(trait) → averaged self rating. */
  self: Map<PlayerId, Map<TraitId, number>>;
  /** peerByRater.get(about)?.get(trait)?.get(rater) → that rater's averaged rating of `about`. */
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

/** ios.get(from)?.get(to) → averaged IOS value 1..7. */
export function buildIosIndex(log: readonly LogRecord[]): Map<PlayerId, Map<PlayerId, number>> {
  const acc = new Map<string, number[]>();
  for (const rec of log) {
    if (rec.value.kind !== "ios") continue;
    const k = `${rec.playerId}\u0000${rec.value.about}`;
    const arr = acc.get(k);
    if (arr) arr.push(rec.value.value);
    else acc.set(k, [rec.value.value]);
  }
  const out = new Map<PlayerId, Map<PlayerId, number>>();
  for (const [k, vs] of acc) {
    const [from, to] = k.split("\u0000") as [PlayerId, PlayerId];
    let m = out.get(from);
    if (!m) { m = new Map(); out.set(from, m); }
    m.set(to, meanOf(vs));
  }
  return out;
}

// ---------- debrief similarity (token-Jaccard is PRIMARY, spec §5) ----------

export const tokenize = (text: string): Set<string> =>
  new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0));

/** Jaccard over lowercase alphanumeric token sets. Both empty score 0; missing pairs are omitted upstream. */
export function tokenJaccard(a: string, b: string): number {
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 && sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Which two players debriefed each other? LogRecord has no pair id, so the
 * engine groups deterministically, in this order:
 *  1. debrief records sharing a roundId with exactly 2 distinct players;
 *  2. else debrief records sharing a promptId with exactly 2 distinct players
 *     (pair not already found in step 1);
 *  3. else, if exactly 2 players in the whole log have debrief texts, them.
 * Pairs with no determination get debriefSim 0.5 ("unknown") upstream.
 */
export function buildDebriefSims(log: readonly LogRecord[]): Map<string, number> {
  const textsByPlayer = new Map<PlayerId, string[]>();
  const byRound = new Map<string, Map<PlayerId, string[]>>();
  const byPrompt = new Map<string, Map<PlayerId, string[]>>();
  const addText = (m: Map<PlayerId, string[]>, p: PlayerId, t: string) => {
    const arr = m.get(p);
    if (arr) arr.push(t);
    else m.set(p, [t]);
  };
  for (const rec of log) {
    if (rec.roundKind !== "debrief" || rec.value.kind !== "text") continue;
    addText(textsByPlayer, rec.playerId, rec.value.text);
    let r = byRound.get(rec.roundId);
    if (!r) { r = new Map(); byRound.set(rec.roundId, r); }
    addText(r, rec.playerId, rec.value.text);
    let pr = byPrompt.get(rec.promptId);
    if (!pr) { pr = new Map(); byPrompt.set(rec.promptId, pr); }
    addText(pr, rec.playerId, rec.value.text);
  }
  const acc = new Map<string, number[]>();
  const addSim = (m: Map<PlayerId, string[]>) => {
    if (m.size !== 2) return;
    const [[p1, t1], [p2, t2]] = [...m.entries()] as [[PlayerId, string[]], [PlayerId, string[]]];
    const sim = tokenJaccard(t1.join(" "), t2.join(" "));
    const k = pairKey(p1, p2);
    const arr = acc.get(k);
    if (arr) arr.push(sim);
    else acc.set(k, [sim]);
  };
  for (const m of byRound.values()) addSim(m);
  const roundPairs = new Set(acc.keys());
  for (const m of byPrompt.values()) {
    if (m.size !== 2) continue;
    const [p1, p2] = [...m.keys()] as [PlayerId, PlayerId];
    if (!roundPairs.has(pairKey(p1, p2))) addSim(m);
  }
  if (textsByPlayer.size === 2) addSim(textsByPlayer);
  const out = new Map<string, number>();
  for (const [k, sims] of acc) out.set(k, clamp01(meanOf(sims)));
  return out;
}
