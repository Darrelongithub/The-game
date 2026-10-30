// packages/engine/src/index.ts
// Reveal Game scoring engine — PURE functions, zero I/O, zero network.
// Public API (Agent C contract):
//   computeSignals(log, meta)
//   computeResults(signals, log, meta, config = DEFAULT_WEIGHTS, tagOf?)
//   buildNightDigest(log, meta)
//   buildSecrets(results, digest, meta)
export { computeSignals, pairScoreOf, type PairWeights } from "./signals.ts";
export { computeResults } from "./results.ts";
export { buildNightDigest } from "./digest.ts";
export { buildSecrets } from "./secrets.ts";
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

// Exposed for tuning, tests and Agent Z's hand-verification:
export { maximumWeightMatching, constrainedMatching, type Matching } from "./matching.ts";
export { mulberry32 } from "./rng.ts";
export { ENGINE_TUNING, jokerNominationWeights, logRecordId, tokenJaccard } from "./internal.ts";
