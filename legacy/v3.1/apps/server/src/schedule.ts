import { DARE_ROUNDS, type RoundKind } from "../../../packages/shared/src/contracts.ts";
import type { HeatPhase } from "./services.ts";

/** Question slots; live moments follow separately at the end of each phase. */
export function phaseSlots(phase: HeatPhase): RoundKind[] {
  return phase === "warmup" ? ["pick", "pick", "shout", "text"]
    : phase === "spicy" ? ["pick", "pick", "rating", "ios", "dare"]
    : phase === "deep" ? ["text", "minigame", "pick", "pick", "dare"]
    : [...Array<RoundKind>(DARE_ROUNDS).fill("dare"), "pair_dare"];
}
