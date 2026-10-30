import { DEFAULT_WEIGHTS, type LogRecord } from "../../../packages/shared/src/contracts.ts";
import { buildNightDigest, buildSecrets, computeResults, computeSignals, logRecordId } from "../../../packages/engine/src/index.ts";
import { PromptProvider as FullPromptProvider, Provider, selectFromBank, tagText } from "../../../packages/prompts/src/index.ts";
import { buildSkeleton, SYSTEM_PROMPT, writeFinale } from "../../../packages/narrator/src/index.ts";
import type { GameServices, PromptProvider } from "./services.ts";

/** Production adapter. The room manager supplies pseudonymized inputs and keeps
 * private decks out of the public narrator. No calls are needed in no-key mode. */
export function createIntegratedServices(
  provider = Provider.fromEnv(),
  onJokerWeights?: (roomId: string, weights: ReadonlyMap<string, number>) => void,
): GameServices {
  return {
    createPromptProvider(roomId = "unassigned"): PromptProvider {
      let full: FullPromptProvider | undefined;
      let disposed = false;
      return {
        forPhase(phase, n, used) {
          if (!full) return selectFromBank(phase, n, { playerCount: 4, excludeIds: [...used] });
          // Selection here is a preview: only the room manager marks chosen
          // prompts used. The facade's forPhase would mark the entire pool used.
          const generated = full.generatedFor(phase).filter((p) => !used.has(p.id));
          const bank = selectFromBank(phase, n, { playerCount: full.playerCount, excludeIds: [...used] });
          return [...generated, ...bank].slice(0, n);
        },
        async prepare({ playerCount, usedIds, digest }) {
          full = new FullPromptProvider({ playerCount, usedIds, room: roomId, provider });
          // Launch once, in the lobby; the game never waits for these requests.
          await Promise.all((["warmup", "spicy", "deep", "dare"] as const).map((phase) =>
            full!.generateInBackground(phase, { playerCount, digest })));
          if (disposed) provider.guard.forget(roomId);
        },
        dispose() { disposed = true; provider.guard.forget(roomId); },
      };
    },
    computeSignals,
    computeResults(signals, log, meta) {
      const tags = new Map(log.map((record: LogRecord) => {
        const value = record.value;
        const text = value.kind === "text" ? value.text : value.kind === "shout" ? value.word : value.kind === "dare" ? value.reason ?? "" : "";
        return [logRecordId(record), tagText(text)] as const;
      }));
      return computeResults(signals, log, meta, DEFAULT_WEIGHTS, (id) => tags.get(id) ?? [],
        onJokerWeights ? (weights) => onJokerWeights(meta.roomId, weights) : undefined);
    },
    buildNightDigest,
    buildSecrets,
    buildSkeleton(results, digest, meta) { return buildSkeleton(results, digest, meta?.players); },
    async writeFinale(slides, decks, results, digest, meta) {
      return writeFinale(slides, decks, results, digest, {
        roster: meta?.players,
        grok: async (payload) => {
          const response = await provider.grokJson({
            room: meta?.roomId ?? "unassigned",
            purpose: "reveal",
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: JSON.stringify(payload) },
            ],
            temperature: 0.35,
            maxTokens: 4096,
            json: true,
          });
          return response.result.ok ? response.value : null;
        },
      });
    },
  };
}
