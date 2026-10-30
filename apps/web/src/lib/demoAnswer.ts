// src/lib/demoAnswer.ts — DEMO ROOMS: a plausible answer for a puppeted seat.
//
// The host is holding every phone at once, so tapping "answer" for a demo seat
// should just work: this builds a legal value for the open round, aimed at
// the server-assigned subject/trait when the round carries them. Deterministic
// (seat index, not randomness) so a rehearsal replays the same way.
import type { PlayerId, PlayerView, ResponseValue, RoundView } from "@shared/contracts.ts";

const TEXTS = [
  "Answered from the host's laptop.",
  "Testing the whole night alone.",
  "Said on behalf of a demo seat.",
];
const WORDS = ["vibes", "chaos", "menace", "static"];

export function demoAnswerValue(round: RoundView, seat: PlayerId, players: PlayerView[]): ResponseValue | null {
  const others = players.filter((p) => p.id !== seat);
  const index = Math.max(0, players.findIndex((p) => p.id === seat));
  const target = others.length ? others[index % others.length]!.id : undefined;
  switch (round.kind) {
    case "pick":
    case "verdict":
      return target ? { kind: "pick", target } : null;
    case "shout":
      return { kind: "shout", word: WORDS[index % WORDS.length]! };
    case "rating":
      return round.trait && round.about ? { kind: "rating", trait: round.trait, about: round.about, value: 5 + (index % 5) } : null;
    case "ios":
      return round.about ? { kind: "ios", about: round.about, value: 2 + (index % 6) } : null;
    case "minigame":
      return { kind: "minigame", score: 12 + index * 7 };
    case "dare":
    case "pair_dare":
      return { kind: "dare", status: "done" };
    default:
      return { kind: "text", text: TEXTS[index % TEXTS.length]! };
  }
}
