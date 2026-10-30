// packages/engine/src/results.ts
// computeResults — spec §5 claims. Deterministic: the only randomness is
// the fixed-seed Monte-Carlo behind the toxic percentile, and
// `computedAt` is derived from the log itself (last record time) so the
// same log always produces deep-equal Results.
import {
  CONFIDENCE_RULES,
  SPARK_MIN_MUTUAL,
  DEFAULT_WEIGHTS,
  MC_SIMULATIONS,
  TOXIC_WEIGHTS,
  TRAITS,
  type Claim,
  type Confidence,
  type LogRecord,
  type PairSignal,
  type PlayerId,
  type PromptCoding,
  type Results,
  type RoomMeta,
} from "../../shared/src/contracts.ts";
import {
  ENGINE_TUNING,
  NEGATIVE_CODINGS,
  POSITIVE_CODINGS,
  assertScorableMeta,
  buildIosIndex,
  buildRatingIndex,
  confidenceFromCount,
  directedPicks,
  getPicks,
  jokerNominationWeights,
  logRecordId,
  meanOf,
  pairKey,
  playerIdsInOrder,
  playerIdsSorted,
  pooledPairRate,
  pseudoOf,
  sortedPair,
} from "./internal.ts";
import { maximumWeightMatching } from "./matching.ts";
import { mulberry32 } from "./rng.ts";
import { pairScoreOf, type PairWeights } from "./signals.ts";

const T = ENGINE_TUNING;

/** Count of pair components clearing the support bars (independent signal types). */
function pairSupportCount(s: PairSignal, pickEvidence: number): number {
  let n = 0;
  // Pick-derived supports must clear half STRICTLY: with only a handful of
  // rounds in a night, an exactly-half rate (2 of 4, 3 of 6, 5 of 10) is
  // chance-sized, not a signal.
  if (s.componentsUsed.includes("pickOverlap") && s.pickOverlap > T.support.pickOverlap) n++;
  if (s.componentsUsed.includes("mutualPick") && pickEvidence > T.support.mutualPick) n++;
  if (s.componentsUsed.includes("debriefSim") && s.debriefSim > T.support.debriefSim) n++;
  if (s.componentsUsed.includes("iosMean") && s.iosMean >= T.support.iosMean) n++;
  if (s.componentsUsed.includes("traitAgreement") && s.traitAgreement >= T.support.traitAgreement) n++;
  return n;
}

function pairEvidenceLines(meta: RoomMeta, s: PairSignal): string[] {
  const pa = pseudoOf(meta, s.a);
  const pb = pseudoOf(meta, s.b);
  const lines: string[] = [];
  if (s.mutualPick >= T.support.mutualPick) lines.push(`${pa} and ${pb} kept picking each other.`);
  if (s.pickOverlap >= T.support.pickOverlap) lines.push(`${pa} and ${pb} kept pointing at the same people.`);
  if (s.iosMean >= T.support.iosMean) lines.push(`${pa} and ${pb} rated each other close.`);
  if (s.traitAgreement >= T.support.traitAgreement) lines.push(`${pa} and ${pb} see each other clearly.`);
  if (s.debriefSim > T.support.debriefSim) lines.push(`Their separate accounts of time together matched closely.`);
  if (lines.length === 0) lines.push(`${pa} and ${pb} rose to the top of the room's overall pattern.`);
  return lines;
}

export function computeResults(
  signals: PairSignal[],
  allRecords: LogRecord[],
  meta: RoomMeta,
  config: PairWeights = DEFAULT_WEIGHTS,
  tagOf: (recordId: string) => string[] = () => [],
  onJokerWeights?: (weights: ReadonlyMap<PlayerId, number>) => void,
): Results {
  assertScorableMeta(meta);
  // Decoy answers (spotlight cover rounds) are not evidence about anyone.
  const log = allRecords.filter((rec) => rec.decoy !== true);
  const weights: PairWeights = { ...DEFAULT_WEIGHTS, ...config };
  const ids = playerIdsSorted(meta);
  const idsInOrder = playerIdsInOrder(meta);
  const picks = getPicks(log);
  const optIn = new Set(meta.revealOptIn);

  // Effective pair signals: pairScore re-weighted per `config` so replaying
  // a log against new weights (spec §14) actually changes the outcome.
  const byPair = new Map<string, PairSignal>();
  for (const s of signals) {
    byPair.set(pairKey(s.a, s.b), { ...s, pairScore: pairScoreOf(s, weights) });
  }
  const signalFor = (x: PlayerId, y: PlayerId): PairSignal => {
    const [a, b] = sortedPair(x, y);
    const found = byPair.get(pairKey(a, b));
    if (found) return found;
    const blank = {
      room: meta.roomId, a, b,
      pickOverlap: 0, mutualPick: 0, debriefSim: 0, iosMean: 0, traitAgreement: 0, componentsUsed: [],
      coupleEvidence: 0, friendEvidence: 0, negativeMutual: 0,
    };
    return { ...blank, pairScore: pairScoreOf(blank, weights) };
  };

  // ---------- consensus (computed early: toxic confidence references it) ----------
  const consensusClaims: Claim[] = [];
  const consensusCandidates: { roundId: string; coding: PromptCoding; target: PlayerId; votes: number; of: number; share: number }[] = [];
  const consensusTargetByCoding = new Set<string>(); // `${coding}\u0000${target}`
  {
    const byRound = new Map<string, { coding: PromptCoding; votes: Map<PlayerId, PlayerId> }>();
    for (const p of picks) {
      let round = byRound.get(p.roundId);
      if (!round) { round = { coding: p.coding, votes: new Map() }; byRound.set(p.roundId, round); }
      round.votes.set(p.picker, p.target);
    }
    for (const [roundId, round] of byRound) {
      if (round.coding === "neutral") continue; // consensus needs a coded prompt
      const of = round.votes.size;
      if (of === 0) continue;
      const counts = new Map<PlayerId, number>();
      for (const target of round.votes.values()) counts.set(target, (counts.get(target) ?? 0) + 1);
      let topTarget: PlayerId | undefined;
      let topVotes = 0;
      for (const [target, votes] of counts) {
        if (votes > topVotes || (votes === topVotes && (topTarget === undefined || target < topTarget))) {
          topTarget = target;
          topVotes = votes;
        }
      }
      if (topTarget === undefined) continue;
      const share = topVotes / of;
      if (of >= T.consensusMinVoters ? share < CONFIDENCE_RULES.high.consensusShare : share < 1) continue;
      consensusTargetByCoding.add(`${round.coding}\u0000${topTarget}`);
      consensusCandidates.push({ roundId, coding: round.coding, target: topTarget, votes: topVotes, of, share });
    }
    // Confidence: one 70% round is a single signal type (med). It only
    // earns high only after three independent repeated verdicts — the same
    // target on the same coding clearing the threshold in three rounds.
    // The n=4 Monte Carlo regression keeps random-night false highs below 2%.
    const verdictCounts = new Map<string, number>();
    for (const c of consensusCandidates) {
      const k = `${c.coding}\u0000${c.target}`;
      verdictCounts.set(k, (verdictCounts.get(k) ?? 0) + 1);
    }
    for (const c of consensusCandidates) {
      consensusClaims.push({
        id: `consensus-${c.roundId}-${c.target}`,
        type: "consensus",
        subjects: [c.target],
        audience: "public",
        confidence: c.of >= T.consensusMinVoters && (verdictCounts.get(`${c.coding}\u0000${c.target}`) ?? 0) >= 3 ? "high" : "med",
        evidence: [`On a ${c.coding}-coded prompt, the room kept choosing ${pseudoOf(meta, c.target)}.`],
        numbers: { votes: c.votes, of: c.of, share: c.share },
      });
    }
  }

  // ---------- ship & besties: maximum-weight matchings ----------
  // A one-way positive pick is private evidence, not a mutual public match.
  // If the eligible graph has no complete matching, keep it partial instead
  // of silently rerunning without the constraint and inventing pairings.
  const mutual = (a: PlayerId, b: PlayerId, include: (coding: PromptCoding) => boolean): boolean =>
    directedPicks(picks, a, b, include).hits > 0 && directedPicks(picks, b, a, include).hits > 0;
  const shipMatching = maximumWeightMatching(
    ids,
    (a, b) => signalFor(a, b).pairScore,
    (a, b) => mutual(a, b, (coding) => POSITIVE_CODINGS.has(coding)),
  );
  const bestiesMatching = maximumWeightMatching(
    ids,
    (a, b) => signalFor(a, b).friendEvidence,
    (a, b) => mutual(a, b, (coding) => coding === "friendship"),
  );

  const shipClaims: Claim[] = [];
  for (const [a, b] of shipMatching.pairs) {
    const s = signalFor(a, b);
    const supports = pairSupportCount(s, s.mutualPick);
    if (supports === 0 && s.coupleEvidence === 0 && s.friendEvidence === 0) continue; // no data, no ship
    shipClaims.push({
      id: `ship-${a}-${b}`,
      type: "ship",
      subjects: [a, b],
      audience: "public",
      confidence: confidenceFromCount(supports),
      evidence: pairEvidenceLines(meta, s),
      numbers: {
        pairScore: s.pairScore, pickOverlap: s.pickOverlap, mutualPick: s.mutualPick,
        debriefSim: s.debriefSim, iosMean: s.iosMean, traitAgreement: s.traitAgreement,
        coupleEvidence: s.coupleEvidence, friendEvidence: s.friendEvidence,
      },
    });
  }

  const bestiesClaims: Claim[] = [];
  for (const [a, b] of bestiesMatching.pairs) {
    const s = signalFor(a, b);
    if (s.friendEvidence === 0) continue;
    const supports = pairSupportCount(s, s.friendEvidence);
    bestiesClaims.push({
      id: `besties-${a}-${b}`,
      type: "besties",
      subjects: [a, b],
      audience: "public",
      confidence: confidenceFromCount(supports),
      evidence: pairEvidenceLines(meta, s),
      numbers: {
        pairScore: s.pairScore, friendEvidence: s.friendEvidence, mutualPick: s.mutualPick,
        pickOverlap: s.pickOverlap, iosMean: s.iosMean, traitAgreement: s.traitAgreement,
      },
    });
  }

  // ---------- spark: ship-pair + mutual couple picks + both opted in ----------
  const sparkClaims: Claim[] = [];
  for (const [a, b] of shipMatching.pairs) {
    if (!optIn.has(a) || !optIn.has(b)) continue;
    const ab = directedPicks(picks, a, b, (c) => c === "couple");
    const ba = directedPicks(picks, b, a, (c) => c === "couple");
    if (ab.hits < SPARK_MIN_MUTUAL || ba.hits < SPARK_MIN_MUTUAL) continue;
    const s = signalFor(a, b);
    // R27: a spark is an announcement, not a reward for two mutual picks.
    // Reuse the R18 confidence machinery: at least three INDEPENDENT measured
    // signal types (componentsUsed clearing the existing support bars) must
    // support the pair. No new score, weight or threshold is introduced.
    const supports = pairSupportCount(s, s.coupleEvidence);
    if (supports < CONFIDENCE_RULES.high.independentSignals) continue;
    sparkClaims.push({
      id: `spark-${a}-${b}`,
      type: "spark",
      subjects: [a, b],
      audience: "private", // ALWAYS private → Secret Cards
      confidence: confidenceFromCount(supports),
      evidence: [
        `${pseudoOf(meta, a)} and ${pseudoOf(meta, b)} picked each other on couple-coded rounds.`,
        ...pairEvidenceLines(meta, s).slice(0, 2),
      ],
      numbers: { pairScore: s.pairScore, coupleEvidence: s.coupleEvidence },
    });
  }

  // ---------- rivals: mutual negatives + rivalry hits, mid pair_score ----------
  let rivalClaim: Claim | undefined;
  {
    let bestScore = 0;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i] as PlayerId;
        const b = ids[j] as PlayerId;
        const s = signalFor(a, b);
        if (s.pairScore < T.rivalPairScoreMid.min || s.pairScore > T.rivalPairScoreMid.max) continue;
        const ab = directedPicks(picks, a, b, (c) => NEGATIVE_CODINGS.has(c));
        const ba = directedPicks(picks, b, a, (c) => NEGATIVE_CODINGS.has(c));
        if (ab.hits < SPARK_MIN_MUTUAL || ba.hits < SPARK_MIN_MUTUAL) continue; // rivalry must be mutual
        const rivalryRate = pooledPairRate(picks, a, b, (c) => c === "rivalry");
        const score = s.negativeMutual + rivalryRate;
        if (score <= bestScore) continue; // ties keep the lexicographically first pair
        // Strictly past half: with only a handful of negative rounds, an
        // exactly-half pooled rate (3 of 6, 6 of 12) is chance-sized. The
        // third signal type must come from OUTSIDE the pick data (they also
        // rate each other distant, or misread each other's traits) — the
        // rivalry subset of the same picks is not independent evidence.
        const distant = (s.iosMean > 0 && s.iosMean <= 0.35) || (s.traitAgreement > 0 && s.traitAgreement < 0.5);
        const supports =
          (s.negativeMutual > T.support.evidence ? 1 : 0) +
          (rivalryRate > T.support.evidence ? 1 : 0) +
          (distant ? 1 : 0);
        const confidence: Confidence = confidenceFromCount(supports);
        bestScore = score;
        rivalClaim = {
          id: `rival-${a}-${b}`,
          type: "rival",
          subjects: [a, b],
          audience: "public",
          confidence,
          evidence: [
            `${pseudoOf(meta, a)} and ${pseudoOf(meta, b)} kept naming each other when the prompts turned spiky.`,
          ],
          numbers: { negativeMutual: s.negativeMutual, rivalryRate, pairScore: s.pairScore, score },
        };
      }
    }
    // Low-confidence negative claims are never public — rivals are omitted, not softened.
    if (rivalClaim && rivalClaim.confidence === "low") rivalClaim = undefined;
  }

  // ---------- toxic: joker-guarded negative indegree vs seeded Monte-Carlo ----------
  let toxicClaim: Claim | undefined;
  {
    const negPicks = picks.filter((p) => NEGATIVE_CODINGS.has(p.coding));
    if (negPicks.length > 0) {
      // Joker guard: a picker naming the same target in >70% of ALL their
      // pick rounds gets every nomination downweighted.
      const pickerWeight = jokerNominationWeights(log, idsInOrder);

      // Optional in-process QA observer; never part of Results or socket data.
      onJokerWeights?.(new Map(pickerWeight));
      const rawIndegree = new Map<PlayerId, number>();
      const weightedIndegree = new Map<PlayerId, number>();
      const guardedWeighted = new Map<PlayerId, number>();
      const unguardedNominators = new Map<PlayerId, Set<PlayerId>>();
      for (const id of idsInOrder) {
        rawIndegree.set(id, 0);
        weightedIndegree.set(id, 0);
        guardedWeighted.set(id, 0);
        unguardedNominators.set(id, new Set());
      }
      for (const p of negPicks) {
        const w = pickerWeight.get(p.picker) ?? 1;
        rawIndegree.set(p.target, (rawIndegree.get(p.target) ?? 0) + 1);
        weightedIndegree.set(p.target, (weightedIndegree.get(p.target) ?? 0) + w);
        if (w < 1) guardedWeighted.set(p.target, (guardedWeighted.get(p.target) ?? 0) + w);
        else unguardedNominators.get(p.target)?.add(p.picker);
      }

      // Monte-Carlo null: uniform-random targets (≠ picker) over the same
      // negative-round structure, same per-picker joker weights. Seeded.
      const rng = mulberry32(T.mcSeed);
      const candidates = new Map<PlayerId, PlayerId[]>();
      for (const id of idsInOrder) candidates.set(id, idsInOrder.filter((x) => x !== id));
      const lessCount = new Map<PlayerId, number>(idsInOrder.map((id) => [id, 0]));
      for (let sim = 0; sim < MC_SIMULATIONS; sim++) {
        const totals = new Map<PlayerId, number>(idsInOrder.map((id) => [id, 0]));
        for (const p of negPicks) {
          const cands = candidates.get(p.picker) as PlayerId[];
          const target = cands[Math.floor(rng() * cands.length)] as PlayerId;
          totals.set(target, (totals.get(target) ?? 0) + (pickerWeight.get(p.picker) ?? 1));
        }
        for (const id of idsInOrder) {
          if ((totals.get(id) ?? 0) < (weightedIndegree.get(id) ?? 0)) {
            lessCount.set(id, (lessCount.get(id) ?? 0) + 1);
          }
        }
      }
      const percentileOf = (id: PlayerId): number => (lessCount.get(id) ?? 0) / MC_SIMULATIONS;

      // Contempt tag seam: density of contempt-tagged texts AUTHORED by the
      // player. tagOf defaults to empty → density 0 (spec: contemptTags = 0 for now).
      const densityOf = (id: PlayerId): number => {
        let authored = 0;
        let contempt = 0;
        for (const rec of log) {
          if (rec.playerId !== id || rec.value.kind !== "text") continue;
          authored++;
          if (tagOf(logRecordId(rec)).includes("contempt")) contempt++;
        }
        return authored === 0 ? 0 : contempt / authored;
      };

      let candidate: PlayerId | undefined;
      let candidateScore = -1;
      for (const id of ids) {
        const score = TOXIC_WEIGHTS.indegree * percentileOf(id) + TOXIC_WEIGHTS.contemptTags * densityOf(id);
        if (score > candidateScore) { candidateScore = score; candidate = id; }
      }
      if (candidate !== undefined) {
        const weighted = weightedIndegree.get(candidate) ?? 0;
        const pct = percentileOf(candidate);
        const guardedShare = weighted === 0 ? 0 : (guardedWeighted.get(candidate) ?? 0) / weighted;
        const frictionConsensus =
          consensusTargetByCoding.has(`friction\u0000${candidate}`) ||
          consensusTargetByCoding.has(`rivalry\u0000${candidate}`);
        let supports = 0;
        if (pct >= T.toxicEmitPercentile) supports++;
        if ((unguardedNominators.get(candidate)?.size ?? 0) >= 3) supports++;
        if (frictionConsensus) supports++;
        if (densityOf(candidate) > 0) supports++;
        // If most of the case rests on joker-guarded pickers, it is one
        // person's bit, not the room's verdict: cap at low → never public.
        const confidence: Confidence = guardedShare > 0.5 ? "low" : confidenceFromCount(supports);
        if (weighted > 0 && pct >= T.toxicEmitPercentile && confidence !== "low") {
          const raw = rawIndegree.get(candidate) ?? 0;
          toxicClaim = {
            id: `toxic-${candidate}`,
            type: "toxic",
            subjects: [candidate],
            audience: "public",
            confidence,
            evidence: [
              `In the spiky rounds the room pointed at ${pseudoOf(meta, candidate)} far beyond chance.`,
            ],
            numbers: {
              votes: raw,
              of: negPicks.length,
              share: negPicks.length === 0 ? 0 : raw / negPicks.length,
              weightedVotes: weighted,
              percentile: pct,
              score: candidateScore,
            },
          };
        }
      }
    }
  }

  // ---------- blind spots: |self − groupMean| per evaluative trait ----------
  const blindspotClaims: Claim[] = [];
  {
    const ratings = buildRatingIndex(log);
    for (const id of idsInOrder) {
      for (const trait of TRAITS) {
        const self = ratings.self.get(id)?.get(trait);
        const raters = ratings.peerByRater.get(id)?.get(trait);
        if (self === undefined || !raters || raters.size < T.blindspotMinRaters) continue;
        const peerValues = [...raters.values()];
        const groupMean = meanOf(peerValues);
        const spread = Math.max(...peerValues) - Math.min(...peerValues);
        const gap = Math.abs(self - groupMean);
        if (gap < T.blindspotMinGap) continue;
        // Peer agreement must be tight (range <= 1) to count: five random
        // ratings spanning 2 points happens by chance far too often.
        const supports =
          (raters.size >= 3 ? 1 : 0) + (spread <= 1 ? 1 : 0) + (gap >= 3 ? 1 : 0);
        const confidence = confidenceFromCount(supports);
        blindspotClaims.push({
          id: `blindspot-${id}-${trait}`,
          type: "blindspot",
          subjects: [id],
          // Factual self-vs-room numbers may travel privately at low
          // confidence (Secret Cards); they only go public at med+.
          audience: confidence === "low" ? "private" : "public",
          confidence,
          evidence: [`${pseudoOf(meta, id)} rates their own ${trait} differently from the room.`],
          numbers: { self, groupMean, spread, gap, raters: raters.size },
        });
      }
    }
  }

  // ---------- one-sided: high pick rate one way, low the other ----------
  const onesidedClaims: Claim[] = [];
  {
    const ios = buildIosIndex(log);
    for (const from of ids) {
      for (const to of ids) {
        if (from === to) continue;
        const fwd = directedPicks(picks, from, to, (c) => POSITIVE_CODINGS.has(c));
        if (fwd.total < T.onesided.minPositivePicks) continue;
        const rev = directedPicks(picks, to, from, (c) => POSITIVE_CODINGS.has(c));
        if (fwd.rate < T.onesided.minRate) continue;
        if (rev.rate > T.onesided.maxReverseRate) continue;
        if (fwd.rate - rev.rate < T.onesided.minGap) continue;
        const iosFwd = ios.get(from)?.get(to);
        const iosRev = ios.get(to)?.get(from);
        const iosAsym = iosFwd !== undefined && iosFwd >= 5 && (iosRev === undefined || iosRev <= 3);
        // Independent types only: the pick asymmetry itself, plus IOS
        // asymmetry when present. (Raw hit count is the same pick signal,
        // so it never double-counts toward confidence.)
        const supports = 1 + (iosAsym ? 1 : 0);
        onesidedClaims.push({
          id: `onesided-${from}-${to}`,
          type: "onesided",
          subjects: [from, to], // picker first — the card lands on the picker's phone
          audience: "private", // ALWAYS private
          confidence: confidenceFromCount(supports),
          evidence: [
            `${pseudoOf(meta, from)} kept choosing ${pseudoOf(meta, to)}; those picks rarely came back.`,
          ],
          numbers: { rate: fwd.rate, reverseRate: rev.rate, hits: fwd.hits, of: fwd.total },
        });
      }
    }
  }

  const claims: Claim[] = [
    ...shipClaims,
    ...bestiesClaims,
    ...sparkClaims,
    ...(rivalClaim ? [rivalClaim] : []),
    ...(toxicClaim ? [toxicClaim] : []),
    ...consensusClaims,
    ...blindspotClaims,
    ...onesidedClaims,
  ];

  const freeAgent = shipMatching.unmatched.length === 1 ? shipMatching.unmatched[0] : undefined;
  const computedAt = log.length === 0 ? 0 : Math.max(...log.map((r) => r.at));

  return {
    roomId: meta.roomId,
    claims,
    pairScores: signals.map((s) => signalFor(s.a, s.b)),
    ...(freeAgent !== undefined ? { freeAgent } : {}),
    computedAt,
  };
}
