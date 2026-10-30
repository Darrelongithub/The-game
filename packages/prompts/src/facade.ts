// packages/prompts/src/facade.ts
// THE FACADE the server talks to: `PromptProvider.forPhase(phase, n, used)`.
//
// Bank-first, ALWAYS. Generated (Grok) prompts only ever augment the bank —
// if the lane is silent, if the budget is spent, if the night is offline, the
// bank still fills every slot. Host custom lines sit in front of the bank for
// their phase because the host asked for them tonight.
import type { NightDigest, Prompt, PromptStyle } from "../../shared/src/contracts.ts";
import {
  bankCounts,
  loadBank,
  selectFromBank,
  spicyTierEnabled,
  type PromptPhase,
} from "./bank/index.ts";
import { parseHostLines, type HostPromptResult } from "./custom.ts";
import { generateBatchReport, type GenerateBatchReport } from "./generate.ts";
import { Provider } from "./provider.ts";

export interface PromptProviderOptions {
  playerCount?: number;
  /** Room id — required for the per-room provider budget. */
  room?: string;
  /** Lane client. Pass `null` for a bank-only provider (no keys, tests). */
  provider?: Provider | null;
  /** Include u1–u27 (default: SPICY_TIER / env). */
  spicy?: boolean;
  /** Host custom lines from the lobby (≤10, ≤160 chars each). */
  customPrompts?: readonly string[];
  /** Already-used prompt ids (e.g. restored from the room log). */
  usedIds?: readonly string[];
  /** Known aliases — scrubbed before any provider payload. */
  aliases?: readonly string[];
}

export interface GenerationState {
  lastReason?: GenerateBatchReport["reason"];
  lastPhase?: PromptPhase;
  callbacks: number;
  candidates: number;
  accepted: number;
  inFlight: boolean;
}

export class PromptProvider {
  readonly playerCount: number;
  readonly room: string;
  readonly provider: Provider | null;
  readonly spicy: boolean;
  readonly bank: readonly Prompt[];
  readonly host: HostPromptResult;

  private readonly custom: Prompt[];
  private readonly generated: Prompt[] = [];
  private readonly used = new Set<string>();
  private readonly generatedIds = new Set<string>();
  private readonly generationByPhase = new Map<PromptPhase, GenerationState>();
  private readonly aliases: readonly string[];

  constructor(opts: PromptProviderOptions = {}) {
    this.playerCount = Math.max(1, Math.min(11, opts.playerCount ?? 11));
    this.room = opts.room ?? "room-unknown";
    this.provider = opts.provider === undefined ? Provider.fromEnv() : opts.provider;
    this.spicy = opts.spicy ?? spicyTierEnabled();
    this.bank = loadBank({ spicy: this.spicy });
    this.host = parseHostLines(opts.customPrompts ?? [], { playerCount: this.playerCount });
    this.custom = this.host.prompts;
    this.aliases = opts.aliases ?? [];
    for (const id of opts.usedIds ?? []) this.used.add(id);
  }

  /** Bank + host inventory for this process (diagnostics / lobby preview). */
  counts(): Record<PromptPhase, number> {
    return bankCounts({ spicy: this.spicy });
  }

  canGenerate(): boolean {
    return this.provider?.canGenerate() ?? false;
  }

  canAnalyze(): boolean {
    return this.provider?.canAnalyze() ?? false;
  }

  /** Provider calls left in this room tonight (8 max, both lanes together). */
  remainingCalls(): number {
    return this.provider ? this.provider.guard.remaining(this.room) : 0;
  }

  /**
   * THE selection call. Host lines → bank → generated, deterministic order,
   * no repeats (ids are remembered). Returns fewer than `n` only if the phase
   * is genuinely exhausted.
   */
  forPhase(phase: PromptPhase, n = 3, used: readonly string[] = []): Prompt[] {
    const wanted = Math.max(0, n);
    if (wanted === 0) return [];
    const exclude = new Set<string>([...this.used, ...used]);
    const picked: Prompt[] = [];

    const eligible = (p: Prompt, filterPhase: PromptPhase = phase) =>
      p.phase === filterPhase && !exclude.has(p.id) && !picked.some((q) => q.id === p.id);

    for (const p of this.custom) {
      if (picked.length >= wanted) break;
      if (p.phase === phase && eligible(p)) picked.push(p);
    }

    for (const p of selectFromBank(phase, wanted - picked.length, {
      spicy: this.spicy,
      playerCount: this.playerCount,
      excludeIds: [...exclude, ...picked.map((q) => q.id)],
    })) {
      if (picked.length >= wanted) break;
      picked.push(p);
    }

    for (const p of this.generated) {
      if (picked.length >= wanted) break;
      if (eligible(p)) picked.push(p);
    }

    for (const p of picked) this.used.add(p.id);
    return picked;
  }

  /** Register generated prompts (from `generateInBackground` or a warm cache). */
  augment(prompts: readonly Prompt[]): void {
    for (const prompt of prompts) {
      if (this.generatedIds.has(prompt.id)) continue;
      this.generatedIds.add(prompt.id);
      this.generated.push(prompt);
    }
  }

  generatedFor(phase: PromptPhase): Prompt[] {
    return this.generated.filter((p) => p.phase === phase);
  }

  generationState(phase: PromptPhase): GenerationState {
    return (
      this.generationByPhase.get(phase) ?? {
        callbacks: 0,
        candidates: 0,
        accepted: 0,
        inFlight: false,
      }
    );
  }

  /**
   * Lobby background generation — ONE batch per phase, never awaited by the
   * gameplay loop. Returns [] on every failure and leaves the bank untouched.
   */
  async generateInBackground(
    phase: PromptPhase,
    opts: { count?: number; digest?: NightDigest | null; playerCount?: number; style?: PromptStyle } = {},
  ): Promise<Prompt[]> {
    const state = this.generationState(phase);
    if (state.inFlight) return [];
    if (!this.canGenerate()) return [];
    this.generationByPhase.set(phase, { ...state, inFlight: true });
    try {
      const report = await generateBatchReport({
        phase,
        playerCount: opts.playerCount ?? this.playerCount,
        usedIds: [...this.used, ...this.generated.map((p) => p.id)],
        digest: opts.digest ?? null,
        room: this.room,
        count: opts.count,
        provider: this.provider,
        aliases: this.aliases,
        ...(opts.style !== undefined ? { style: opts.style } : {}),
      });
      this.augment(report.prompts);
      this.generationByPhase.set(phase, {
        lastReason: report.reason,
        lastPhase: phase,
        callbacks: report.callbacks,
        candidates: report.candidates,
        accepted: report.accepted,
        inFlight: false,
      });
      return report.prompts;
    } catch {
      this.generationByPhase.set(phase, { ...this.generationState(phase), inFlight: false, lastReason: "network" });
      return [];
    }
  }
}

/** Convenience constructor for the server: reads keys from the environment. */
export function createPromptProvider(opts: PromptProviderOptions = {}): PromptProvider {
  return new PromptProvider(opts);
}
