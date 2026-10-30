// packages/engine/src/signals.ts
// computeSignals — spec §5 pair components, every one in 0..1.
// Pure function of (log, meta). Pairs are emitted a < b in sorted-id order.
import {
  DEFAULT_WEIGHTS,
  TRAITS,
  type LogRecord,
  type PairSignal,
  type PlayerId,
  type RoomMeta,
} from "../../shared/src/contracts.ts";
import {
  assertScorableMeta,
  buildDebriefSims,
  buildIosIndex,
  buildRatingIndex,
  clamp01,
  getPicks,
  meanOf,
  pairKey,
  playerIdsSorted,
  pooledPairRate,
  NEGATIVE_CODINGS,
  POSITIVE_CODINGS,
  type RatingIndex,
} from "./internal.ts";

export interface PairWeights {
  pickOverlap: number;
  mutualPick: number;
  debriefSim: number;
  iosMean: number;
  traitAgreement: number;
}

/** Weighted pair_score from raw components (spec §5 formula). */
export function pairScoreOf(
  s: Pick<PairSignal, "pickOverlap" | "mutualPick" | "debriefSim" | "iosMean" | "traitAgreement" | "componentsUsed">,
  weights: PairWeights = DEFAULT_WEIGHTS,
): number {
  const used = s.componentsUsed;
  const denominator = used.reduce((sum, key) => sum + weights[key], 0);
  if (denominator <= 0) return 0;
  return clamp01(used.reduce((sum, key) => sum + weights[key] * s[key], 0) / denominator);
}

/** One direction of trait agreement: self-ratings of `of` vs peer ratings of `of` written by `by`. */
function traitAgreementDirection(index: RatingIndex, of: PlayerId, by: PlayerId): number | undefined {
  const selfMap = index.self.get(of);
  const peerMap = index.peerByRater.get(of);
  if (!selfMap || !peerMap) return undefined;
  const scores: number[] = [];
  for (const trait of TRAITS) {
    const self = selfMap.get(trait);
    const peer = peerMap.get(trait)?.get(by);
    if (self !== undefined && peer !== undefined) scores.push(1 - Math.abs(self - peer) / 9);
  }
  return scores.length === 0 ? undefined : meanOf(scores);
}

export function computeSignals(allRecords: LogRecord[], meta: RoomMeta): PairSignal[] {
  assertScorableMeta(meta);
  // Spotlight decoys answer a cover question, not the moment: they can never
  // move a signal. (The server also filters them out before calling us.)
  const log = allRecords.filter((rec) => rec.decoy !== true);
  const ids = playerIdsSorted(meta);
  const picks = getPicks(log);
  const ratings = buildRatingIndex(log);
  const ios = buildIosIndex(log);
  const debriefSims = buildDebriefSims(log);

  // pickOverlap needs, per round, who picked whom.
  const picksByRound = new Map<string, Map<PlayerId, PlayerId>>();
  for (const p of picks) {
    let round = picksByRound.get(p.roundId);
    if (!round) { round = new Map(); picksByRound.set(p.roundId, round); }
    round.set(p.picker, p.target);
  }

  const out: PairSignal[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i] as PlayerId;
      const b = ids[j] as PlayerId;

      // pickOverlap: share of rounds (both picked, neither picked the other)
      // where they chose the same third target. 0 when no such round.
      let eligible = 0;
      let same = 0;
      for (const round of picksByRound.values()) {
        const ta = round.get(a);
        const tb = round.get(b);
        if (ta === undefined || tb === undefined) continue;
        if (ta === b || tb === a) continue; // rounds where they chose each other are excluded
        eligible++;
        if (ta === tb) same++;
      }
      const pickOverlap = eligible === 0 ? 0 : same / eligible;

      const mutualPick = pooledPairRate(picks, a, b, (c) => POSITIVE_CODINGS.has(c));
      const coupleEvidence = pooledPairRate(picks, a, b, (c) => c === "couple");
      const friendEvidence = pooledPairRate(picks, a, b, (c) => c === "friendship");
      const negativeMutual = pooledPairRate(picks, a, b, (c) => NEGATIVE_CODINGS.has(c));

      const debriefSim = debriefSims.get(pairKey(a, b)) ?? 0;

      // Each direction contributes at most half: (ios(a→b) + ios(b→a)) / 14.
      // Missing responses contribute zero, rather than doubling one person's vote.
      const iab = ios.get(a)?.get(b) ?? 0;
      const iba = ios.get(b)?.get(a) ?? 0;
      const iosMean = (iab + iba) / 14;

      // traitAgreement: 1 − |self − peer|/9 per shared trait, both directions.
      const dirs: number[] = [];
      const dab = traitAgreementDirection(ratings, a, b);
      const dba = traitAgreementDirection(ratings, b, a);
      if (dab !== undefined) dirs.push(dab);
      if (dba !== undefined) dirs.push(dba);
      const traitAgreement = dirs.length === 0 ? 0 : meanOf(dirs);

      const components = {
        pickOverlap: clamp01(pickOverlap),
        mutualPick: clamp01(mutualPick),
        debriefSim: clamp01(debriefSim),
        iosMean: clamp01(iosMean),
        traitAgreement: clamp01(traitAgreement),
      };
      const componentsUsed: PairSignal["componentsUsed"] = [];
      if (eligible > 0) componentsUsed.push("pickOverlap");
      if (picks.some((p) => (p.picker === a || p.picker === b) && POSITIVE_CODINGS.has(p.coding))) componentsUsed.push("mutualPick");
      if (debriefSims.has(pairKey(a, b))) componentsUsed.push("debriefSim");
      if (iab !== undefined || iba !== undefined) componentsUsed.push("iosMean");
      if (dab !== undefined || dba !== undefined) componentsUsed.push("traitAgreement");
      out.push({
        room: meta.roomId,
        a,
        b,
        ...components,
        componentsUsed,
        pairScore: pairScoreOf({ ...components, componentsUsed }, DEFAULT_WEIGHTS),
        coupleEvidence: clamp01(coupleEvidence),
        friendEvidence: clamp01(friendEvidence),
        negativeMutual: clamp01(negativeMutual),
      });
    }
  }
  return out;
}
