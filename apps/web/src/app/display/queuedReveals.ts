import type { Socket } from "socket.io-client";
import type { Phase, RevealView } from "@shared/contracts.ts";

// The array seam remains available for a single-batch delivery. H1 currently
// sends the same list as ordered `reveal` events while the room is in finale;
// `finale` marks the end of that stream (see createFinaleRevealBuffer below).
export const QUEUED_REVEALS_EVENT = "queued_reveals";

function isReveal(value: unknown): value is RevealView {
  if (!value || typeof value !== "object") return false;
  const reveal = value as Record<string, unknown>;
  return typeof reveal.roundId === "string" && typeof reveal.summary === "string" &&
    typeof reveal.holdMs === "number" && Number.isFinite(reveal.holdMs) &&
    (reveal.items === undefined || (Array.isArray(reveal.items) && reveal.items.every(item =>
      item && typeof item === "object" && typeof item.alias === "string" && typeof item.text === "string")));
}

export function subscribeToQueuedReveals(socket: Socket, receive: (reveals: RevealView[]) => void): void {
  socket.on(QUEUED_REVEALS_EVENT, (payload: unknown) => {
    if (Array.isArray(payload) && payload.every(isReveal)) receive(payload);
  });
}

/** Convert H1's finale-only reveal stream into one ordered list for the stage.
 * Wait for the finale event so a partial network delivery cannot skip reveals,
 * and clear partial replays on reconnect. Ordinary round reveals pass through.
 */
export function createFinaleRevealBuffer() {
  let phase: Phase | null = null;
  let pending: RevealView[] = [];
  const seen = new Set<string>();
  const clear = () => { pending = []; seen.clear(); };
  return {
    reset() { phase = null; clear(); },
    setPhase(next: Phase) {
      if (next !== "finale" || phase !== "finale") clear();
      phase = next;
    },
    capture(payload: unknown): boolean {
      if (phase !== "finale") return false;
      if (isReveal(payload) && !seen.has(payload.roundId)) {
        seen.add(payload.roundId);
        pending.push(payload);
      }
      return true;
    },
    take(): RevealView[] | null {
      const queue = pending.length ? pending : null;
      clear();
      return queue;
    },
  };
}
