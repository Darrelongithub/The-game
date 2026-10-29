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

// Exposed for tuning, tests and Agent Z's hand-verification:
export { maximumWeightMatching, constrainedMatching, type Matching } from "./matching.ts";
export { mulberry32 } from "./rng.ts";
export { ENGINE_TUNING, logRecordId, tokenJaccard } from "./internal.ts";
