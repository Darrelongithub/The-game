// packages/engine/src/index.ts
// Reveal Game scoring engine — PURE functions, zero I/O, zero network.
// Public API (Agent C contract):
//   computeSignals(log, meta)
//   computeResults(signals, log, meta, config = DEFAULT_WEIGHTS, tagOf?)
//   buildNightDigest(log, meta)
//   buildSecrets(results, digest, meta)
export { computeSignals, DEFAULT_PAIR_WEIGHTS, pairComponentValue, pairScoreOf, type PairComponent, type PairWeights } from "./signals.ts";
export { computeResults } from "./results.ts";
export { buildNightDigest } from "./digest.ts";
export { buildSecrets } from "./secrets.ts";

// CONFESS ROUNDS — the second voice (50/50 style mix, twins, aggregation).
export {
  chooseStyle,
  confessAnswers,
  confessMismatches,
  confessTally,
  confessYesRate,
  confessionComponent,
  emptyStyleServed,
  planStyles,
  planTwin,
  questionRoundsServed,
  recordStyle,
  roomWarmth,
  styleDrift,
  twinDue,
  TWIN_RATE,
  type ConfessAnswer,
  type ConfessMismatch,
  type ConfessTally,
  type StyleServed,
  type TwinLink,
  type TwinPlan,
} from "./confess.ts";
// Live moments (ROUND 3): name clustering + decoy pairing. Never a Claim.
export {
  clusterNames,
  decoyPairings,
  decoyQuote,
  detectNamedPlayers,
  nameClusterTeaser,
  normalizeName,
  type DecoyPairing,
  type NameCandidate,
  type NameCluster,
  type NameClusterResult,
} from "./live.ts";

// ROUND 4 — the Director. INTERNAL: hypotheses are game-direction hints and
// are never serialized to a client. Selection is deterministic (seeded).
export {
  assertNoHypothesisLeak,
  aboveBand,
  carryOver,
  consecutiveTouches,
  coverageCells,
  coverageCount,
  coverageKey,
  DIMENSIONS,
  directNextRound,
  emptyDirectorState,
  formHypotheses,
  HYPOTHESIS_DIMENSION,
  inBand,
  pickMode,
  planRound,
  recordSelection,
  starvedCells,
  subjectPairKey,
  updateHypotheses,
  type Coverage,
  type CoverageCell,
  type Dimension,
  type DirectedMode,
  type DirectedRound,
  type DirectorState,
  type HypothesisOptions,
  type HypothesisUpdate,
  type PlanInput,
} from "./director.ts";

// Exposed for tuning, tests and Agent Z's hand-verification:
export { maximumWeightMatching, constrainedMatching, type Matching } from "./matching.ts";
export { mulberry32 } from "./rng.ts";
export { ENGINE_TUNING, jokerNominationWeights, logRecordId, tokenJaccard } from "./internal.ts";
