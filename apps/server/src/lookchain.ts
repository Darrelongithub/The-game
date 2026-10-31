// apps/server/src/lookchain.ts
// THE LOOK CHAIN — a four-step live moment, revealed only at the end.
//
//   ACT    everybody looks at X. X's phone says "Look at someone you love."
//          X taps the person they are looking at. HIDDEN from the room.
//   GUESS  everybody else guesses who X is looking at. Also hidden.
//   WHY    X says why, in one line.
//   TRUTH  at the reveal: the real choice, how many guessed right, and why.
//
// The choice stays hidden all night. Nothing about it reaches a phone, the
// host laptop or the public finale until the results.
import { LOOK_CHAIN_CASES, LOOK_CHAIN_CASES_MAX, MAX_PLAYERS, MIN_PLAYERS } from "../../../packages/shared/src/contracts.ts";

export interface LookChainVariant {
  /** What the room is told. */
  announce: string;
  /** What the actor's phone says. */
  act: string;
  /** What everybody else's phone says. */
  guess: string;
  /** What the actor's phone says at the end of the chain. */
  why: string;
}

/**
 * Eight chain flavours. The night draws a fresh one per chain, so a chain
 * never repeats its copy inside one night.
 */
export const LOOK_CHAIN_VARIANTS: readonly LookChainVariant[] = [
  {
    announce: "Everybody look at {A}.",
    act: "Look at someone you love.",
    guess: "Who is {A} looking at?",
    why: "Why them?",
  },
  {
    announce: "Everybody look at {A}.",
    act: "Look at the person you would text at 3am.",
    guess: "Who is {A} looking at right now?",
    why: "Why that one?",
  },
  {
    announce: "Everybody look at {A}.",
    act: "Look at someone you would take home.",
    guess: "Who is {A} thinking about?",
    why: "Say why.",
  },
  {
    announce: "Everybody look at {A}.",
    act: "Look at the person you trust most in this room.",
    guess: "Who is {A} looking at?",
    why: "Why them?",
  },
  {
    announce: "Everybody look at {A}.",
    act: "Look at someone you have a secret with.",
    guess: "Who is {A} looking at?",
    why: "What is the secret?",
  },
  {
    announce: "Everybody look at {A}.",
    act: "Look at someone you would kiss if the lights went out.",
    guess: "Who is {A} looking at?",
    why: "Why them?",
  },
  {
    announce: "Everybody look at {A}.",
    act: "Look at the person you would call first if you were in trouble.",
    guess: "Who is {A} looking at?",
    why: "Why them?",
  },
  {
    announce: "Everybody look at {A}.",
    act: "Look at someone you cannot stop thinking about.",
    guess: "Who is {A} looking at?",
    why: "Why them?",
  },
];

/** The stage numbers a chain runs through. */
export const LOOK_STAGE_ACT = 1;
export const LOOK_STAGE_GUESS = 2;
export const LOOK_STAGE_WHY = 3;

/**
 * How many look chains tonight: six in a normal room, up to eight when the
 * room is big enough to keep them moving.
 */
export function lookChainsFor(playerCount: number): number {
  if (playerCount < MIN_PLAYERS) return 0;
  if (playerCount >= MAX_PLAYERS) return LOOK_CHAIN_CASES_MAX;
  if (playerCount >= 8) return LOOK_CHAIN_CASES + 1;
  return LOOK_CHAIN_CASES;
}
