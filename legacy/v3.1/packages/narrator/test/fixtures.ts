// test/fixtures.ts — a hand-built 7-player night (odd n → free agent).
// Every string here is ENGINE output: the narrator must polish it, never
// contradict it. Private claims (onesided / spark) exist to prove they can
// never reach a public slide.

import type {
  Claim,
  NightDigest,
  PairSignal,
  PlayerId,
  Results,
  RoomMeta,
  SecretCard,
} from "../../shared/src/contracts.ts";

export const ROSTER: RoomMeta["players"] = [
  { id: "p1", alias: "Maya" },
  { id: "p2", alias: "Zed" },
  { id: "p3", alias: "Kofi" },
  { id: "p4", alias: "Imani" },
  { id: "p5", alias: "Tunde" },
  { id: "p6", alias: "Wanjiru" },
  { id: "p7", alias: "Baraka" },
];

const pair = (
  a: PlayerId,
  b: PlayerId,
  pairScore: number,
  negativeMutual = 0,
): PairSignal => ({
  room: "AB2C",
  a,
  b,
  pickOverlap: 0.5,
  mutualPick: 0.5,
  debriefSim: 0,
  componentsUsed: ["pickOverlap", "mutualPick", "iosMean", "traitAgreement"],
  iosMean: 0.6,
  traitAgreement: 0.7,
  pairScore,
  coupleEvidence: pairScore > 0.6 ? 0.8 : 0.1,
  friendEvidence: 0.6,
  negativeMutual,
});

export const PRIVATE_CLAIM_IDS = ["c-onesided", "c-spark"] as const;

export const claims: Claim[] = [
  {
    id: "c-ship",
    type: "ship",
    subjects: ["p2", "p5"],
    audience: "public",
    confidence: "high",
    evidence: [
      "Player 2 and Player 5 picked each other on all three couple-coded rounds.",
      "Their closeness circles average 6 of 7 in both directions.",
      "Pair score 0.89 — the highest in the room.",
    ],
    numbers: { pairScore: 0.89 },
  },
  {
    id: "c-besties",
    type: "besties",
    subjects: ["p1", "p3"],
    audience: "public",
    confidence: "high",
    evidence: [
      "Player 1 and Player 3 keep choosing the same person, round after round.",
      "They rated each other's loyalty 9 out of 10.",
      "Friend-coded signals: 12 hits across the night.",
    ],
    numbers: { hits: 12 },
  },
  {
    id: "c-rival",
    type: "rival",
    subjects: ["p4", "p6"],
    audience: "public",
    confidence: "med",
    evidence: [
      "Player 4 and Player 6 traded friction-coded picks 3 times tonight.",
      "Pair score 0.41 — right in the danger zone.",
    ],
    numbers: { trades: 3 },
  },
  {
    id: "c-consensus",
    type: "consensus",
    subjects: ["p2"],
    audience: "public",
    confidence: "high",
    evidence: [
      "The room keeps saying Player 2 is the one who would survive a horror movie.",
      "6 of 8 picks landed on the same person.",
    ],
    numbers: { votes: 6, of: 8, share: 0.75 },
  },
  {
    id: "c-blind",
    type: "blindspot",
    subjects: ["p4"],
    audience: "public",
    confidence: "high",
    evidence: ["Player 4 rates their own chaos 9 out of 10; the room averages 5.2."],
    numbers: { self: 9, groupMean: 5.2, spread: 3.8 },
  },
  {
    id: "c-toxic",
    type: "toxic",
    subjects: ["p6"],
    audience: "public",
    confidence: "high",
    evidence: [
      "Player 6 collected 11 friction-coded nominations — the 93rd percentile for this room.",
    ],
    numbers: { percentile: 0.93, nominations: 11 },
  },
  // Private material — MUST never produce a public slide.
  {
    id: "c-onesided",
    type: "onesided",
    subjects: ["p1", "p2"],
    audience: "private",
    confidence: "med",
    evidence: ["Player 1 keeps picking Player 2 while Player 2 picks someone else."],
    numbers: { picks: 4 },
  },
  {
    id: "c-spark",
    type: "spark",
    subjects: ["p2", "p5"],
    audience: "private",
    confidence: "high",
    evidence: ["Mutual couple-coded picks and both players opted in."],
  },
  // Malformed upstream: a low-confidence negative marked public. Spec §5 says
  // it is NEVER public — the narrator must drop it too.
  {
    id: "c-toxic-low",
    type: "toxic",
    subjects: ["p1"],
    audience: "public",
    confidence: "low",
    evidence: ["Player 1 picked up one stray nomination."],
  },
];

export const results: Results = {
  roomId: "AB2C",
  claims,
  pairScores: [
    pair("p1", "p3", 0.62),
    pair("p2", "p5", 0.89),
    pair("p4", "p6", 0.41, 0.7),
    pair("p1", "p2", 0.3),
    pair("p6", "p7", 0.22),
  ],
  freeAgent: "p7",
  computedAt: 1_760_000_000_000,
};

export const digest: NightDigest = {
  quotes: [
    {
      alias: "Maya",
      text: "I would fight a bus for this group, and I would lose.",
      context: "during the loyalty rating",
    },
    { alias: "Zed", text: "I am only here for the snacks and the chaos.", context: "deep round" },
  ],
  stats: {
    fastest: { alias: "Kofi", ms: 940 },
    slowest: { alias: "Maya", ms: 89_000 },
    topDodger: { alias: "Zed", count: 2 },
    tapWar: { alias: "Kofi", score: 61 },
  },
  runningGags: [{ word: "unhinged", count: 4 }],
  pickTeasers: ["Someone keeps picking the same person."],
  dodges: [
    { alias: "Zed", reason: "my mother is watching this game" },
    { alias: "Maya", reason: "I have a thing. It is a real thing." },
  ],
  selfVsRoom: [{ alias: "Zed", trait: "honesty", self: 9, roomMean: 5 }],
};

/** What Agent C's buildSecrets() hands the narrator. */
export const decks = (): Map<PlayerId, SecretCard[]> =>
  new Map<PlayerId, SecretCard[]>([
    [
      "p2",
      [
        {
          id: "s-spark",
          kind: "spark",
          title: "SPARK: Player 2 + Player 5",
          facts: [
            "You both picked each other on all three couple-coded rounds.",
            "Closeness circles: 6 of 7 both ways.",
          ],
        },
        {
          id: "s-stat",
          kind: "stat",
          title: "YOUR NIGHT IN NUMBERS",
          facts: ["Fastest answer of the night: 940ms."],
        },
      ],
    ],
    [
      "p1",
      [
        {
          id: "s-onesided",
          kind: "onesided",
          title: "ONE-SIDED",
          facts: ["You kept picking Player 2. They kept picking Player 4."],
        },
      ],
    ],
    [
      "p6",
      [
        {
          id: "s-blindspot",
          kind: "blindspot",
          title: "BLIND SPOT",
          facts: ["You rate your own chaos 9 out of 10. The room averages 5.2."],
        },
      ],
    ],
  ]);

/** A fresh copy every call — tests must never share mutable state. */
export const night = (): { results: Results; digest: NightDigest; decks: Map<PlayerId, SecretCard[]> } => ({
  results: structuredClone(results),
  digest: structuredClone(digest),
  decks: decks(),
});
