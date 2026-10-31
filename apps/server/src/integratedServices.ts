// apps/server/src/integratedServices.ts
// Production integration of the finished packages.
//
// The Ollama lane is the ONLY generator: it writes the night's questions and
// dares. Gemini arranges the data (analysis only) and is not on the critical
// path. Every score is a deterministic local computation — a model response
// (or its timing) never changes a verdict.
import {
  MAX_PROVIDER_CALLS_PER_NIGHT,
  type FinaleSlide,
  type LogRecord,
  type NightDigest,
  type Prompt,
  type PlayerId,
  type Results,
  type RoomMeta,
  type SecretCard,
} from "../../../packages/shared/src/contracts.ts";
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
import {
  CallGuard,
  Provider,
  createPromptProvider,
  type FetchLike,
  type PromptProvider as PackagePromptProvider,
} from "../../../packages/prompts/src/index.ts";
import type {
  GameServices,
  PromptProvider,
  PromptProviderContext,
} from "./services.ts";

/** Count actual HTTP attempts, including retries, across both provider lanes. */
class RoomNetwork {
  private readonly lifetime = new AbortController();
  private attempts = 0;

  readonly fetch: typeof fetch = async (input, init = {}) => {
    if (this.lifetime.signal.aborted || this.attempts >= MAX_PROVIDER_CALLS_PER_NIGHT) {
      throw new Error("Room provider budget unavailable");
    }
    if (typeof globalThis.fetch !== "function") throw new Error("Fetch unavailable");
    this.attempts++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    this.lifetime.signal.addEventListener("abort", abort, { once: true });
    init.signal?.addEventListener("abort", abort, { once: true });
    if (this.lifetime.signal.aborted || init.signal?.aborted) controller.abort();
    try {
      return await globalThis.fetch(input, { ...init, signal: controller.signal });
    } finally {
      this.lifetime.signal.removeEventListener("abort", abort);
      init.signal?.removeEventListener("abort", abort);
    }
  };

  dispose(): void { this.lifetime.abort(); }
}

class IntegratedPromptProvider implements PromptProvider {
  private readonly network = new RoomNetwork();
  private readonly provider: Provider;
  private readonly facade: PackagePromptProvider;
  private disposed = false;

  constructor(context: PromptProviderContext) {
    this.provider = new Provider({ guard: new CallGuard(), fetchImpl: this.network.fetch as FetchLike });
    this.facade = createPromptProvider({
      room: context.roomId,
      playerCount: context.playerCount,
      seed: context.seed,
      aliases: context.aliases ?? [],
    });
  }

  draw(request: { role: Prompt["role"]; count: number; kinds?: readonly import("../../../packages/shared/src/contracts.ts").RoundKind[]; metric?: string }): Prompt[] {
    return this.facade.draw({
      role: request.role,
      count: request.count,
      kinds: request.kinds,
      metric: request.metric as never,
    });
  }

  usedPromptIds(): string[] {
    return this.facade.usedPromptIds();
  }

  async generate(): Promise<Prompt[]> {
    if (this.disposed) return [];
    return this.facade.generate();
  }

  generationProgress(): { done: number; total: number } {
    const state = this.facade.state;
    return { done: state.ready, total: state.target };
  }

  dispose(): void {
    this.disposed = true;
    this.network.dispose();
  }
}

/** The production wiring. The observer hook is for in-process tests only. */
export function createProductionServices(): GameServices {
  return {
    createPromptProvider: (context: PromptProviderContext) => new IntegratedPromptProvider(context),
    computeSignals,
    computeResults: (log: LogRecord[], meta: RoomMeta): Results => computeResults(log, meta),
    buildNightDigest,
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
    ) => {
      const ps = derivePseudonyms(results, digest, meta.players);
      return writeFinale(skeleton, decks, results, digest, { roster: meta.players });
    },
  };
}

export const integratedServices = createProductionServices();
