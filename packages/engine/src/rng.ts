// packages/engine/src/rng.ts
// mulberry32 — tiny seeded PRNG. The ONLY source of "randomness" in the
// engine is the toxic Monte-Carlo percentile, and it is always seeded with
// a fixed constant so replaying a log reproduces identical Results.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
