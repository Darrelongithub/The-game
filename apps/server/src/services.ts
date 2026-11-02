// apps/server/src/services.ts
// The injectable service seam.
//
// The server owns the ROOM and the FLOW. The packages own the PROMPTS, the
// VERDICTS, the DIGEST and the CARDS. This file is the contract between
// them, so the server can be tested without a model and the packages can be
// tested without a server.
import {
  type FinaleSlide,
  type LogRecord,
  type NightDigest,
  type PairSignal,
  type PlayerId,
  type Prompt,
  type PromptRole,
  type Results,
  type RoomMeta,
  type RoundKind,
  type SecretCard,
} from "../../../packages/shared/src/contracts.ts";

export interface DrawRequest {
  role: PromptRole;
  count: number;
  kinds?: readonly RoundKind[];
  metric?: string;
}

export interface PromptProvider {
  /** Draw prompts for a case slot. Never blocks, never throws. */
  draw(request: DrawRequest): Prompt[];
  /** Every prompt id used tonight. */
  usedPromptIds(): string[];
  /** Run the generation (Ollama). Resolves when the run is done or capped. */
  generate?(): Promise<Prompt[]>;
  /** Progress for the loading screen: "14/40 ready". */
  generationProgress?(): { done: number; total: number };
  /**
   * The Gemini analysis lane: the night's pseudonymised data goes in, the
   * reveal and the secret-card copy come out. Null when Gemini has nothing to
   * say — the engine's own copy stands, always, with no retry.
   */
  analyse?(payload: Record<string, unknown>): Promise<unknown | null>;
  /** Cancel room-scoped provider work when the room is deleted or expires. */
  dispose?(): void;
}

/** What the server tells the provider about tonight. */
export interface PromptProviderContext {
  roomId: string;
  playerCount: number;
  /** The night's seed — the same seed gives the same shuffle. */
  seed: number;
  /** Aliases: written into the local lane's prompts, scrubbed from Gemini's. */
  aliases?: readonly string[];
  /** Where the provider's one-line-per-call report goes. */
  log?: (line: string) => void;
}

export interface GameServices {
  createPromptProvider(context: PromptProviderContext): PromptProvider;
  computeSignals(log: LogRecord[], meta: RoomMeta): PairSignal[];
  computeResults(log: LogRecord[], meta: RoomMeta): Results;
  buildNightDigest(log: LogRecord[], meta: RoomMeta): NightDigest;
  buildSecrets(results: Results, log: LogRecord[], meta: RoomMeta): Map<PlayerId, SecretCard[]>;
  buildSkeleton(results: Results, digest: NightDigest, meta: RoomMeta): FinaleSlide[];
  writeFinale(
    skeleton: FinaleSlide[],
    decks: Map<PlayerId, SecretCard[]>,
    results: Results,
    digest: NightDigest,
    meta: RoomMeta,
    /** The room's provider, so Gemini can be asked once. Optional: tests pass none. */
    provider?: PromptProvider,
  ): Promise<{
    slides: FinaleSlide[];
    decks: Map<PlayerId, SecretCard[]>;
    /** The three headline lines the share card draws. */
    summary: { couple?: string; core?: string; hates?: string };
  }>;
}
