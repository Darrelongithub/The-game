// Production integration of the finished packages. The small server-local
// implementations remain available as a last-resort fallback and test seam.
import {
  HEAT_ORDER, MAX_PROVIDER_CALLS_PER_NIGHT,
  type LogRecord, type NightDigest, type Prompt, type RoomMeta,
} from "../../../packages/shared/src/contracts.ts";
import {
  buildNightDigest, buildSecrets, computeResults, computeSignals, logRecordId,
} from "../../../packages/engine/src/index.ts";
import { buildSkeleton, writeFinale } from "../../../packages/narrator/src/index.ts";
import {
  CallGuard, Provider, createPromptProvider, maxPlaceholderIndex, selectFromBank, tagBatch, tagText,
  type FetchLike, type PromptProvider as PackagePromptProvider,
} from "../../../packages/prompts/src/index.ts";
import type { GameServices, HeatPhase, PromptProvider } from "./services.ts";

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
  private facade?: PackagePromptProvider;
  private playerCount = 4;
  private geminiKey: string;
  private readonly publicTags = new Map<string, string[]>();
  private analysis?: Promise<void>;
  private disposed = false;

  constructor(private readonly roomId: string) {
    this.geminiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
    this.provider = new Provider({ guard: new CallGuard(), fetchImpl: this.network.fetch as FetchLike });
  }

  async prepare(input: { playerCount: number; usedIds: string[]; digest: NightDigest }): Promise<void> {
    this.playerCount = input.playerCount;
    this.facade = createPromptProvider({
      room: this.roomId, playerCount: input.playerCount, usedIds: input.usedIds, provider: this.provider,
    });
    // No player names or custom prompts are included. Generation never blocks
    // play; each phase has one budgeted batch, and the bank is always ready.
    await Promise.all(HEAT_ORDER.map((phase) => this.facade!.generateInBackground(phase, { digest: input.digest })));
  }

  forPhase(phase: HeatPhase, n: number, usedIds: ReadonlySet<string>, playerCount = this.playerCount): Prompt[] {
    const bank = selectFromBank(phase, n, { playerCount, excludeIds: [...usedIds] });
    const generated = (this.facade?.generatedFor(phase) ?? [])
      .filter((p) => !usedIds.has(p.id) && maxPlaceholderIndex(p.text) <= playerCount);
    // Keep a bank prompt first while making validated generated prompts usable
    // before an entire phase bank has been exhausted.
    return bank.length ? [bank[0]!, ...generated, ...bank.slice(1)] : generated;
  }

  prepareAnalysis(log: LogRecord[]): Promise<void> {
    if (this.analysis || this.disposed) return this.analysis ?? Promise.resolve();
    // The caller supplies pseudonymized records. Only answers already revealed
    // publicly are eligible for classification; never classify private pair
    // debriefs or cover answers. Cover answers are used in the public digest.
    const records = log.filter((record) => record.roundKind !== "debrief" && record.decoy !== true && record.value.kind === "text");
    this.analysis = (async () => {
      const tags = await tagBatch(records.map((record) => record.value.kind === "text" ? record.value.text : ""),
        { room: this.roomId, provider: this.provider });
      if (!this.disposed) records.forEach((record, index) => this.publicTags.set(logRecordId(record), tags[index] ?? []));
    })();
    return this.analysis;
  }

  tagsFor(recordId: string): string[] | undefined { return this.publicTags.get(recordId); }

  narrationOptions(meta: RoomMeta) {
    // Model tags can suggest a gentle tone, never alter numeric results.
    // Forward only a fixed positive enum, not the original classifications.
    const warm = [...this.publicTags.values()].some((tags) => tags.includes("affection") || tags.includes("admiration"));
    return { apiKey: this.geminiKey, fetchImpl: this.network.fetch, roster: meta.players, publicToneHint: warm ? "warm" as const : undefined };
  }

  dispose(): void {
    this.disposed = true;
    this.network.dispose();
    this.publicTags.clear();
    this.geminiKey = "";
    this.facade = undefined;
  }
}

/** The optional observer is for in-process tests only; no client sees it. */
export function createProductionServices(onJokerWeights?: (roomId: string, weights: ReadonlyMap<string, number>) => void): GameServices {
  return {
    createPromptProvider: (context) => new IntegratedPromptProvider(typeof context === "string" ? context : context?.roomId ?? "unassigned"),
    computeSignals,
    computeResults(signals, log, meta) {
      // Scores are always deterministic local computations: a model response
      // (or its timing) must not change them. Private debriefs are not tagged.
      const tags = new Map(log.filter((r) => r.roundKind !== "debrief" && r.value.kind === "text")
        .map((r) => [logRecordId(r), r.value.kind === "text" ? tagText(r.value.text) : []]));
      return computeResults(signals, log, meta, undefined, (id) => tags.get(id) ?? [],
        onJokerWeights ? (weights) => onJokerWeights(meta.roomId, weights) : undefined);
    },
    buildNightDigest,
    buildSecrets,
    buildSkeleton: (results, digest, meta) => buildSkeleton(results, digest, meta?.players),
    writeFinale: (skeleton, decks, results, digest, meta, provider) =>
      writeFinale(skeleton, decks, results, digest,
        provider instanceof IntegratedPromptProvider && meta ? provider.narrationOptions(meta) : { apiKey: "", roster: meta?.players }),
  };
}

export const integratedServices = createProductionServices();
