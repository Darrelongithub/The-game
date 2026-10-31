// packages/prompts/src/facade.ts
// THE PROMPT FACADE — one object the server talks to.
//
// v3.2: the night is a flat sequence of CASES, not phases. The facade hands
// the case engine whatever prompts it needs, from Ollama's rephrases when
// they exist and the bank otherwise. It never blocks the game: generation
// happens AFTER Start, and the safety cap means the night always starts.
import {
    BAND_ORDER,
    type Band,
    type MetricKey,
    type PlayerId,
    type Prompt,
    type PromptRole,
    type RoundKind,
} from "../../shared/src/contracts.ts";
import { BANK, loadBank, metricOf, promptTypeKey, seededShuffle, selectFromBank } from "./bank/index.ts";
import { generateNight, type GenerateBatchReport } from "./generate.ts";

/**
 * How many of the night's opening prompts come from the spicy tier.
 *
 * The night OPENS hot: the first dozen questions are the unhinged/spicy ones
 * while any are left for the role being drawn. After that the night is
 * shuffled freely, so the deeper prompts still get their turn.
 */
export const OPENING_SPICY_PROMPTS = 12;

export interface PromptProviderOptions {
    /** Players in the room. */
    playerCount: number;
    /** The night's seed. */
    seed: number;
    /** Room id for the call guard. */
    room?: string;
    /** Aliases scrubbed from anything sent to the model. */
    aliases?: readonly string[];
    /** Ollama wiring overrides. */
    config?: { baseUrl?: string; model?: string; timeoutMs?: number };
    fetchImpl?: Parameters<typeof generateNight>[0]["fetchImpl"];
    /** Print the per-batch report to the terminal. */
    log?: (line: string) => void;
    /** Skip the model entirely (tests, offline). */
    offline?: boolean;
}

export interface GenerationState {
    /** True while the run is in flight. */
    running: boolean;
    /** Prompts accepted so far. */
    ready: number;
    /** The target the loading screen counts towards ("14/40 ready"). */
    target: number;
    /** The last per-batch report line. */
    lastLine?: string;
    /** True when the run finished (or was capped). */
    done: boolean;
}

/**
 * The provider the server uses. `generate()` returns the prompts to play;
 * `state` drives the loading screen.
 */
export class PromptProvider {
    private readonly opts: PromptProviderOptions;
    private readonly usedIds = new Set<string>();
    private stateValue: GenerationState = { running: false, ready: 0, target: 0, done: false };
    private pool: Prompt[] = [];
    private report: GenerateBatchReport | undefined;
    /** The type of the last prompt handed out — never repeated back to back. */
    private lastType = "";
    /** How many opening prompts are still owed to the spicy tier. */
    private openingLeft = OPENING_SPICY_PROMPTS;

    constructor(opts: PromptProviderOptions) {
        this.opts = opts;
        this.pool = loadBank();
    }

    get state(): GenerationState {
        return this.stateValue;
    }

    get generationReport(): GenerateBatchReport | undefined {
        return this.report;
    }

    /**
     * Generate the night's prompts with Ollama, then play.
     *
     * The returned list always contains a full night's worth of prompts:
     * Ollama's accepted rephrases first, the bank behind them.
     */
    async generate(): Promise<Prompt[]> {
        this.stateValue = { running: true, ready: 0, target: 0, done: false };
        if (this.opts.offline) {
            this.pool = loadBank();
            this.stateValue = { running: false, ready: this.pool.length, target: this.pool.length, done: true };
            return this.pool;
        }
        const report = await generateNight({
            playerCount: this.opts.playerCount,
            seed: this.opts.seed,
            room: this.opts.room,
            aliases: this.opts.aliases,
            config: this.opts.config,
            fetchImpl: this.opts.fetchImpl,
            log: this.opts.log,
        });
        this.report = report;
        this.pool = report.prompts;
        this.stateValue = {
            running: false,
            ready: report.accepted,
            target: report.target,
            lastLine: report.batches.length
                ? `Ollama: asked ${report.batches.reduce((s, b) => s + b.asked, 0)}, accepted ${report.accepted}, dropped ${report.dropped}`
                : undefined,
            done: true,
        };
        return this.pool;
    }

    /** Update the loading-screen counter as batches land. */
    noteBatch(ready: number): void {
        this.stateValue = { ...this.stateValue, ready };
    }

    /**
     * Draw prompts for a case slot.
     *
     * `role` decides WHO answers; `excludeIds` guarantees a template is never
     * used twice in one night.
     */
    draw(opts: {
        role: PromptRole;
        count: number;
        kinds?: readonly RoundKind[];
        bands?: readonly Band[];
        metric?: MetricKey;
        /** Do not reuse these ids. */
        avoid?: readonly string[];
    }): Prompt[] {
        const avoid = new Set([...this.usedIds, ...(opts.avoid ?? [])]);
        let candidates = this.pool.filter((p) => {
            if (avoid.has(p.id)) return false;
            if (p.role !== opts.role) return false;
            if (opts.kinds && !opts.kinds.includes(p.kind)) return false;
            if (opts.bands && !opts.bands.includes(p.band)) return false;
            if (opts.metric && metricOf(p) !== opts.metric) return false;
            return true;
        });
        // The night opens hot: while the opening is still owed, take the spicy
        // tier for this role whenever it has anything left.
        if (this.openingLeft > 0) {
            const hot = candidates.filter((p) => p.band === "spicy");
            if (hot.length > 0) candidates = hot;
        }
        const chosen = candidates.length > 0
            ? this.pickSpread(candidates, opts.count)
            : [];
        // If the night's pool is exhausted for this role, fall back to the whole
        // bank so a round is never left without a question.
        if (chosen.length < opts.count) {
            const fallback = selectFromBank(opts.count - chosen.length, {
                role: opts.role,
                kinds: opts.kinds,
                bands: opts.bands,
                metric: opts.metric,
                playerCount: this.opts.playerCount,
                excludeIds: [...avoid],
                seed: this.opts.seed,
            });
            chosen.push(...fallback);
        }
        for (const p of chosen) this.usedIds.add(p.id);
        if (chosen.length) {
            this.lastType = promptTypeKey(chosen[chosen.length - 1]!);
            this.openingLeft = Math.max(0, this.openingLeft - chosen.length);
        }
        return chosen;
    }

    /**
     * Pick `count` prompts from the shuffled candidates, never repeating the
     * previous TYPE (kind + metric) back to back while the pool allows it.
     */
    private pickSpread(candidates: Prompt[], count: number): Prompt[] {
        const shuffled = seededShuffle(candidates, this.opts.seed + this.usedIds.size * 31);
        const picked: Prompt[] = [];
        const taken = new Set<string>();
        let lastType = this.lastType;
        const deferred: Prompt[] = [];
        for (const p of shuffled) {
            if (picked.length >= count) break;
            const key = promptTypeKey(p);
            if (key === lastType) { deferred.push(p); continue; }
            picked.push(p);
            taken.add(p.id);
            lastType = key;
        }
        for (const p of deferred) {
            if (picked.length >= count) break;
            if (taken.has(p.id)) continue;
            picked.push(p);
            taken.add(p.id);
        }
        return picked;
    }

    /** How many prompts are left in the pool for a role. */
    remainingFor(role: PromptRole): number {
        return this.pool.filter((p) => p.role === role && !this.usedIds.has(p.id)).length;
    }

    /** The ids used tonight. */
    usedPromptIds(): string[] {
        return [...this.usedIds];
    }
}

/** Factory. */
export function createPromptProvider(opts: PromptProviderOptions): PromptProvider {
    return new PromptProvider(opts);
}

/** The bank, for callers that just want the fallback set. */
export { BANK };

/** The band order the case engine walks. */
export { BAND_ORDER };

/** Every prompt id in the bank. */
export const bankPromptIds = (): string[] => BANK.map((p) => p.id);

/** Players in the room — helper for the engine. */
export const roomPlayerIds = (ids: readonly PlayerId[]): PlayerId[] => [...ids];
