// packages/prompts/src/index.ts
// Public surface of @reveal/prompts.
//
//   • bank/     179+ prompts, band + role tagged; the unhinged tier loads FIRST
//   • ollama.ts the local model that writes the night's questions and dares
//   • filter.ts the deterministic guardrail (four drop reasons, no more)
//   • generate.ts the batched generation run, spicy first, safety-capped
//   • facade.ts PromptProvider — bank-first, never blocks the game
export {
  CallGuard,
  PURPOSE_SLOTS,
  callGuard,
  type CallPurpose,
  type GuardSnapshot,
} from "./guard.ts";

export {
  Provider,
  containsAlias,
  extractText,
  geminiSafetySettings,
  parseJsonLoose,
  redactAliases,
  type ChatMessage,
  type FetchLike,
  type GeminiRequest,
  type Lane,
  type LaneResult,
  type ProviderFailReason,
  type ProviderOptions,
} from "./provider.ts";

export {
  BANK,
  BANK_BANDS,
  BAND_ORDER,
  BAND_KINDS,
  RAW_BANK,
  UNHINGED_IDS,
  bankCounts,
  bankForBand,
  bankTotal,
  loadBank,
  maxPlaceholderIndex,
  metricOf,
  placeholderIndexes,
  promptTypeKey,
  seededShuffle,
  selectBand,
  selectFromBank,
  spicyTierEnabled,
  type BankEntry,
  type BankOptions,
  type SelectOptions,
} from "./bank/index.ts";

export {
  BANNED_PATTERNS,
  CODINGS,
  DUPLICATE_JACCARD,
  EVALUATIVE_TRAITS,
  HARD_BLOCKED,
  MAX_PROMPT_CHARS,
  MIN_PROMPT_CHARS,
  ROOM_REFERENCES,
  ROUND_KINDS,
  badPlaceholder,
  checkBanned,
  checkHardBlocked,
  hasInvalidPlaceholder,
  hasRoomReference,
  hashString,
  isRoomDirected,
  normalizeCandidate,
  normalizeCoding,
  normalizeKind,
  normalizeMeasures,
  placeholderIndexes as filterPlaceholderIndexes,
} from "./filter.ts";

export {
  BAND_BATCH_SIZE,
  GEN_SAFETY_CAP_MS,
  GEN_TARGET_PROMPTS,
  OLLAMA_DEFAULT_BASE,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_TIMEOUT_MS,
  REFUSAL_PATTERNS,
  callOllama,
  formatReasons,
  generateNightWithOllama,
  isMetaCommentary,
  isRefusal,
  normalizeForMatch,
  ollamaConfig,
  parseLines,
  parseOllamaText,
  rephraseSystemPrompt,
  rephraseUserPrompt,
  validateGenerated,
  validateVerdictLine,
  verdictSystemPrompt,
  type OllamaBatchReport,
  type OllamaBankPrompt,
  type OllamaConfig,
  type OllamaDropReason,
  type OllamaFetch,
  type OllamaMessage,
  type OllamaRequest,
  type OllamaResult,
  type OllamaRunReport,
  type OllamaValidation,
} from "./ollama.ts";

export {
  generateNight,
  seedPromptsForBand,
  writeVerdictLines,
  type GenerateBatchInput,
  type GenerateBatchReport,
  type GenerateDrop,
} from "./generate.ts";

export {
  OPENING_SPICY_PROMPTS,
  PromptProvider,
  createPromptProvider,
  type GenerationState,
  type PromptProviderOptions,
} from "./facade.ts";

export {
  MAX_PROVIDER_CALLS_PER_NIGHT,
  OLLAMA,
  PROVIDERS,
  ROUND_TIMERS_MS,
  SECRET_DECK_MAX,
  SPICY_TIER,
  TRAITS,
  resolveGeminiModel,
  pseudonym,
  type Band,
  type MetricKey,
  type NightDigest,
  type Prompt,
  type PromptCoding,
  type PromptRole,
  type RoundKind,
  type TraitId,
} from "../../shared/src/contracts.ts";
