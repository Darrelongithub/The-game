// packages/engine/src/index.ts
// Reveal Game scoring engine — PURE functions, zero I/O, zero network.
//
// Public API:
//   computeSignals(log, meta)          pair signals
//   computeResults(log, meta)          the verdicts (data-backed only)
//   buildNightDigest(log, meta)        quotes, stats, dodges
//   buildSecrets(results, log, meta)   the private per-phone decks
export { computeSignals, pairSignalOf, topCouple, topFriends, pickTally, tallyAcross, pairVotes, pairPicks, pickResponses, traitAgreementOf, isDirectedAboutOthers, type PairWeights } from "./signals.ts";
export {
    assertNoOrientationLeak,
    computeResults,
    orientationLeak,
    resetVerdictIds,
    type ResultsConfig,
} from "./results.ts";
export { buildNightDigest, collectQuotes, collectStats, collectDodges, collectRunningGags, collectLookChains, selfVsRoom } from "./digest.ts";
export {
  buildSecrets,
  mutualCrushes,
  blindSpots,
  lookChains,
  deckViewOf,
  crushStrength,
  verdictsFor,
  METRIC_LOOKCHAIN,
  METRIC_LOOKCHAIN_GUESS,
  type CrushPair,
  type BlindSpotFinding,
  type LookChainOutcome,
} from "./secrets.ts";
export {
  ENGINE_TUNING,
  DESIRE_METRICS,
  NEGATIVE_METRICS,
  CLOSENESS_METRICS,
  COUPLE_METRICS,
  HISTORY_METRICS,
  RIVAL_METRICS,
  POINT_METRICS,
  SCORN_METRICS,
  clamp01,
  meanOf,
  pairKey,
  sortedPair,
  pseudoOf,
  aliasOf,
  getPicks,
  buildRatingIndex,
  pooledPairRate,
  directedPicks,
  tokenJaccard,
  formatNumber,
  confidenceFromCount,
  assertScorableMeta,
  playerIdsInOrder,
  playerIdsSorted,
  logRecordId,
} from "./internal.ts";
export { mulberry32 } from "./rng.ts";
