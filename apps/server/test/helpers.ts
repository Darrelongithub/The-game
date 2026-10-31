// apps/server/test/helpers.ts
// Test doubles: a fake socket, a manual clock and a bank-only service seam.
import {
  buildNightDigest,
  buildSecrets,
  computeResults,
  computeSignals,
} from "../../../packages/engine/src/index.ts";
import {
  buildSkeleton,
  derivePseudonyms,
  writeFinale,
} from "../../../packages/narrator/src/index.ts";
import { BANK, selectFromBank } from "../../../packages/prompts/src/index.ts";
import type {
  FinaleSlide,
  LogRecord,
  MetricKey,
  NightDigest,
  PairSignal,
  PlayerId,
  Prompt,
  Results,
  RoomMeta,
  SecretCard,
} from "../../../packages/shared/src/contracts.ts";
import type {
  GameServices,
  PromptProvider,
  PromptProviderContext,
} from "../src/services.ts";

/** A fake socket that records everything the server sends it. */
export class FakeSocket {
  readonly sent: { event: string; payload: unknown }[] = [];
  readonly data: { roomCode?: string; playerId?: string; isHost?: boolean } = {};
  playerId: PlayerId | undefined;

  constructor(readonly id: string) {}

  emit = (event: string, payload?: unknown): void => {
    this.sent.push({ event, payload });
  };

  leave = (): void => {};
  join = (): void => {};

  /** The payloads of one event type. */
  payloads<T = unknown>(event: string): T[] {
    return this.sent.filter((s) => s.event === event).map((s) => s.payload as T);
  }

  /** The last payload of one event type. */
  last<T = unknown>(event: string): T | undefined {
    const list = this.payloads<T>(event);
    return list.length ? list[list.length - 1] : undefined;
  }
}

/**
 * A clock the test drives by hand. Timers fire in time order when the test
 * advances it, so a whole night runs in milliseconds.
 */
export class ManualClock {
  time: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = 1_700_000_000_000) {
    this.time = start;
  }

  now = (): number => this.time;

  setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn });
    return id;
  };

  clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Move time forward, firing every timer that comes due. */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Number.POSITIVE_INFINITY;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.time = timer.at;
      timer.fn();
    }
    this.time = target;
  }
}

/** A prompt provider that serves the bank and never calls a model. */
export function bankProvider(context: PromptProviderContext): PromptProvider {
  const used = new Set<string>();
  return {
    draw: ({ role, count, kinds, metric }) => {
      const picked = selectFromBank(count, {
        role,
        playerCount: context.playerCount,
        seed: (context.seed + used.size * 31) >>> 0,
        excludeIds: [...used],
        ...(kinds ? { kinds } : {}),
        ...(metric ? { metric: metric as MetricKey } : {}),
      });
      for (const p of picked) used.add(p.id);
      return picked;
    },
    usedPromptIds: () => [...used],
    generate: async () => [...BANK],
    generationProgress: () => ({ done: BANK.length, total: 40 }),
  };
}

/** The real engine, with the bank standing in for the model. */
export function testServices(): GameServices {
  return {
    createPromptProvider: (context: PromptProviderContext) => bankProvider(context),
    computeSignals: (log: LogRecord[], meta: RoomMeta): PairSignal[] => computeSignals(log, meta),
    computeResults: (log: LogRecord[], meta: RoomMeta): Results => computeResults(log, meta),
    buildNightDigest: (log: LogRecord[], meta: RoomMeta): NightDigest => buildNightDigest(log, meta),
    buildSecrets: (results: Results, log: LogRecord[], meta: RoomMeta): Map<PlayerId, SecretCard[]> =>
      buildSecrets(results, log, meta),
    buildSkeleton: (results: Results, digest: NightDigest, meta: RoomMeta): FinaleSlide[] =>
      buildSkeleton(results, digest, derivePseudonyms(results, digest, meta.players)),
    writeFinale: async (
      skeleton: FinaleSlide[],
      decks: Map<PlayerId, SecretCard[]>,
      results: Results,
      digest: NightDigest,
      meta: RoomMeta,
    ) => writeFinale(skeleton, decks, results, digest, { roster: meta.players }),
  };
}

/** A valid sign-up profile for an adult. */
export const adultProfile = {
  age: 27,
  gender: "woman" as const,
  sexuality: "straight" as const,
  attractedTo: "women" as const,
  lookingFor: "fun" as const,
};
