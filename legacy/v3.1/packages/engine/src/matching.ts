// packages/engine/src/matching.ts
// Maximum-weight matching by brute-force enumeration (spec §5): recursion
// either pairs the first remaining player with someone, or leaves them out.
// n ≤ 12 → at most 10,395 complete matchings — trivially fast, exactly
// optimal, and hand-verifiable. Tie-breaking is fully deterministic:
// higher total weight, then more pairs, then the lexicographically
// smallest canonical pair list.
import type { PlayerId } from "../../shared/src/contracts.ts";
import { pairKey, sortedPair } from "./internal.ts";

export interface Matching {
  pairs: [PlayerId, PlayerId][]; // each pair a < b, list sorted by pair string
  unmatched: PlayerId[];
  totalWeight: number;
}

const EPS = 1e-9;

const canonical = (pairs: readonly [PlayerId, PlayerId][]): string =>
  pairs.map(([a, b]) => `${a}+${b}`).sort().join("|");

function isBetter(cand: Matching, best: Matching): boolean {
  if (cand.totalWeight > best.totalWeight + EPS) return true;
  if (cand.totalWeight < best.totalWeight - EPS) return false;
  if (cand.pairs.length !== best.pairs.length) return cand.pairs.length > best.pairs.length;
  return canonical(cand.pairs) < canonical(best.pairs);
}

/**
 * @param players  player ids to match
 * @param weight   weight of an unordered pair (a < b is passed in)
 * @param allowed  optional constraint: only pairs returning true may form
 */
export function maximumWeightMatching(
  players: readonly PlayerId[],
  weight: (a: PlayerId, b: PlayerId) => number,
  allowed?: (a: PlayerId, b: PlayerId) => boolean,
): Matching {
  const start = [...players].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  let best: Matching = { pairs: [], unmatched: [...start], totalWeight: 0 };

  const walk = (remaining: PlayerId[], pairs: [PlayerId, PlayerId][], unmatched: PlayerId[], w: number): void => {
    if (remaining.length === 0) {
      const cand: Matching = {
        pairs: [...pairs].sort((p, q) => (pairKey(p[0], p[1]) < pairKey(q[0], q[1]) ? -1 : 1)),
        unmatched: [...unmatched],
        totalWeight: w,
      };
      if (isBetter(cand, best)) best = cand;
      return;
    }
    const [first, ...rest] = remaining as [PlayerId, ...PlayerId[]];
    // Branch 1: leave the first player out.
    walk(rest, pairs, [...unmatched, first], w);
    // Branch 2: pair the first player with each candidate partner.
    for (let i = 0; i < rest.length; i++) {
      const partner = rest[i] as PlayerId;
      const [a, b] = sortedPair(first, partner);
      if (allowed && !allowed(a, b)) continue;
      const next = [...rest.slice(0, i), ...rest.slice(i + 1)];
      walk(next, [...pairs, [a, b]], unmatched, w + weight(a, b));
    }
  };

  walk(start, [], [], 0);
  return best;
}

/**
 * Constrained-first matching, per Agent C's ship rule: run with the allowed
 * constraint; if that leaves more players out than parity requires (0 on
 * even n, exactly 1 free agent on odd n), rerun unconstrained.
 */
export function constrainedMatching(
  players: readonly PlayerId[],
  weight: (a: PlayerId, b: PlayerId) => number,
  allowed: (a: PlayerId, b: PlayerId) => boolean,
): Matching {
  const constrained = maximumWeightMatching(players, weight, allowed);
  const allowedUnmatched = players.length % 2;
  if (constrained.unmatched.length <= allowedUnmatched) return constrained;
  return maximumWeightMatching(players, weight);
}
