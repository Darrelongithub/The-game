// packages/prompts/src/generate.ts
// THE GENERATION RUN — Ollama rewrites the night's bank prompts.
//
// FLOW (per GAME BRIEF v3.2):
//   • The host presses Start. The server generates the night's prompts with
//     the real names filled in at deal time, THEN plays.
//   • All four heat bands are covered in ONE run, SPICY FIRST.
//   • The safety cap (180s) cuts the run short; the missing prompts are
//     backfilled from the bank and the night starts anyway.
//   • The terminal prints, per batch:
//         Ollama: asked 15, accepted 12, dropped 3 (not-in-room:1, repeat:2)
//
// The bank carries the night. Ollama only makes it sharper: on any failure the
// bank prompt is used unchanged.
import {
    BAND_ORDER,
    type Band,
    type MetricKey,
    type Prompt,
} from "../../shared/src/contracts.ts";
import { BANK, metricOf, selectFromBank } from "./bank/index.ts";
import {
    BAND_BATCH_SIZE,
    GEN_SAFETY_CAP_MS,
    GEN_TARGET_PROMPTS,
    type OllamaBankPrompt,
    type OllamaBatchReport,
    type OllamaRunReport,
    generateNightWithOllama,
    ollamaConfig,
    type OllamaConfig,
    type OllamaFetch,
} from "./ollama.ts";

export type GenerateDrop =
    | "not-in-room"
    | "repeat"
    | "too-long"
    | "refusal"
    | "missing"
    | "extra"
    | "unavailable";

export interface GenerateBatchInput {
    /** Players in the room — placeholder slots must resolve to them. */
    playerCount: number;
    /** The night's seed (seeded shuffle). */
    seed: number;
    /** Room id for the call guard. */
    room?: string;
    /** The room's display names, in roster order. The lane is handed names. */
    aliases?: readonly string[];
    /** Overrides for tests. */
    config?: Partial<OllamaConfig>;
    fetchImpl?: OllamaFetch | null;
    now?: () => number;
    safetyCapMs?: number;
    log?: (line: string) => void;
}

export interface GenerateBatchReport {
    /** The prompts to play tonight: Ollama's where they passed, the bank elsewhere. */
    prompts: Prompt[];
    batches: OllamaBatchReport[];
    accepted: number;
    dropped: number;
    /** True when the safety cap cut the run short. */
    capped: boolean;
    /** True when Ollama was unreachable — the bank carries the night alone. */
    offline: boolean;
    /** How many prompts the loading screen counts towards ("14/40 ready"). */
    target: number;
}

/**
 * The bank prompts we hand to Ollama for rewriting, per band.
 * These are the prompts that will actually be PLAYED tonight, so the model
 * only ever sees questions we know we want.
 */
export function seedPromptsForBand(
    band: Band,
    count: number,
    opts: { playerCount: number; seed: number },
): OllamaBankPrompt[] {
    const prompts = selectFromBank(count, {
        bands: [band],
        playerCount: opts.playerCount,
        seed: opts.seed,
    });
    return prompts.map((p) => ({
        id: p.id,
        band: p.band,
        role: p.role,
        kind: p.kind,
        text: p.text,
        metric: metricOf(p),
    }));
}

/**
 * Run the whole night's generation.
 *
 * Returns the prompts to play: Ollama's accepted rephrases plus the bank
 * prompts that were not rewritten (unchanged). The caller never has to think
 * about which is which — a prompt with `source: "ollama"` came from the model,
 * everything else is the bank.
 */
export async function generateNight(input: GenerateBatchInput): Promise<GenerateBatchReport> {
    const config = { ...ollamaConfig(), ...(input.config ?? {}) };
    const seedByBand: Record<Band, OllamaBankPrompt[]> = {
        warmup: [],
        spicy: [],
        deep: [],
        dare: [],
    };
    for (const band of BAND_ORDER) {
        seedByBand[band] = seedPromptsForBand(band, BAND_BATCH_SIZE[band], {
            playerCount: input.playerCount,
            seed: input.seed + band.length * 7919,
        });
    }

    const run: OllamaRunReport = await generateNightWithOllama(seedByBand, {
        config,
        playerCount: input.playerCount,
        seed: input.seed,
        aliases: input.aliases ?? [],
        fetchImpl: input.fetchImpl ?? null,
        now: input.now,
        safetyCapMs: input.safetyCapMs ?? GEN_SAFETY_CAP_MS,
        log: input.log,
    });

    // Build the playable set: Ollama's accepted prompts, plus every bank
    // prompt that was NOT successfully rewritten (used unchanged).
    const accepted: Prompt[] = [];
    const acceptedIds = new Set<string>();
    for (const batch of run.batches) {
        for (const p of batch.prompts) {
            accepted.push(p);
            acceptedIds.add(p.id.replace(/-ollama$/, ""));
        }
    }

    const bankBackfill: Prompt[] = [];
    for (const band of BAND_ORDER) {
        for (const seed of seedByBand[band]) {
            if (acceptedIds.has(seed.id)) continue;
            const original = BANK.find((p) => p.id === seed.id);
            if (original) bankBackfill.push(original);
        }
    }

    // Anything else in the bank stays available for the case engine to draw
    // on (the night needs more prompts than the model rewrote).
    const usedIds = new Set([...acceptedIds, ...bankBackfill.map((p) => p.id)]);
    const rest = BANK.filter((p) => !usedIds.has(p.id));

    return {
        prompts: [...accepted, ...bankBackfill, ...rest],
        batches: run.batches,
        accepted: run.accepted,
        dropped: run.dropped,
        capped: run.capped,
        offline: run.offline,
        target: GEN_TARGET_PROMPTS,
    };
}

/** Re-exported so callers do not have to reach into two modules. */
export { BAND_BATCH_SIZE, GEN_SAFETY_CAP_MS, GEN_TARGET_PROMPTS };

/** The metrics the engine can read off a prompt. */
export type { MetricKey };

