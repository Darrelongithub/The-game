// packages/prompts/src/guard.ts
// ONE shared call counter for BOTH provider lanes, counted per room, in memory.
//
// Spec §6: "Hard cap: ≤ MAX_PROVIDER_CALLS_PER_NIGHT provider calls per night."
// The night spends: generation 4 (one batch per band) + the reveal 1 = 5.
// So the guard enforces two things:
//   1. a per-room TOTAL cap (MAX_PROVIDER_CALLS_PER_NIGHT), and
//   2. per-purpose slot caps (batching IS the budget: one generation batch per
//      band, one Gemini call for the finale copy).
// Both lanes spend from the same counter — an Ollama batch and a Gemini call
// each cost one call, and neither can starve past the cap.
import { MAX_PROVIDER_CALLS_PER_NIGHT } from "../../shared/src/contracts.ts";

export type CallPurpose = "generate" | "reveal";

/** Per-room, per-night slot caps. Sum = 5, well under the hard cap of 8. */
export const PURPOSE_SLOTS: Readonly<Record<CallPurpose, number>> = Object.freeze({
  generate: 4, // ONE batch per band (spicy / warmup / deep / dare)
  reveal: 1,   // finale slides + secret cards, ONE Gemini call
});

export interface GuardSnapshot {
  room: string;
  used: number;
  cap: number;
  remaining: number;
  byPurpose: Record<CallPurpose, number>;
}

/**
 * In-memory, per-room call ledger. Rooms are dropped with the room
 * (`guard.forget(roomId)`), so nothing survives a night's process.
 */
export class CallGuard {
  private readonly used = new Map<string, number>();
  private readonly byPurpose = new Map<string, Map<CallPurpose, number>>();
  private readonly cap: number;
  private readonly slots: Readonly<Record<CallPurpose, number>>;

  // Plain fields (no TS parameter properties) so the file runs under Node's
  // native type stripping as well as tsx.
  constructor(
    cap: number = MAX_PROVIDER_CALLS_PER_NIGHT,
    slots: Readonly<Record<CallPurpose, number>> = PURPOSE_SLOTS,
  ) {
    this.cap = cap;
    this.slots = slots;
  }

  /** Calls already spent in this room tonight. */
  count(room: string): number {
    return this.used.get(room) ?? 0;
  }

  purposeCount(room: string, purpose: CallPurpose): number {
    return this.byPurpose.get(room)?.get(purpose) ?? 0;
  }

  remaining(room: string): number {
    return Math.max(0, this.cap - this.count(room));
  }

  /** Cheap pre-flight check — does NOT consume. */
  canCall(room: string, purpose: CallPurpose): boolean {
    if (this.remaining(room) <= 0) return false;
    return this.purposeCount(room, purpose) < this.slots[purpose];
  }

  /**
   * Reserve one logical provider call. Returns false (and spends nothing) when
   * either the room total or this purpose's slot is exhausted.
   */
  tryConsume(room: string, purpose: CallPurpose): boolean {
    if (!this.canCall(room, purpose)) return false;
    this.used.set(room, this.count(room) + 1);
    let perRoom = this.byPurpose.get(room);
    if (!perRoom) {
      perRoom = new Map();
      this.byPurpose.set(room, perRoom);
    }
    perRoom.set(purpose, (perRoom.get(purpose) ?? 0) + 1);
    return true;
  }

  /** Give a call back (e.g. the request never left the process). */
  refund(room: string, purpose: CallPurpose): void {
    if (this.count(room) > 0) this.used.set(room, this.count(room) - 1);
    const perRoom = this.byPurpose.get(room);
    const current = perRoom?.get(purpose) ?? 0;
    if (perRoom && current > 0) perRoom.set(purpose, current - 1);
  }

  /** 48h purge / `delete_room` → forget this room's ledger. */
  forget(room: string): void {
    this.used.delete(room);
    this.byPurpose.delete(room);
  }

  reset(room: string): void {
    this.forget(room);
  }

  snapshot(room: string): GuardSnapshot {
    const byPurpose = {} as Record<CallPurpose, number>;
    for (const purpose of Object.keys(this.slots) as CallPurpose[]) {
      byPurpose[purpose] = this.purposeCount(room, purpose);
    }
    return {
      room,
      used: this.count(room),
      cap: this.cap,
      remaining: this.remaining(room),
      byPurpose,
    };
  }
}

/** Process-wide default ledger — one night, one process, one budget. */
export const callGuard = new CallGuard();
