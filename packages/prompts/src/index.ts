// packages/prompts/src/index.ts
// Public surface of @reveal/prompts.
//
//   • bank/     193 prompts, band + role tagged; the unhinged tier loads FIRST
//   • ollama.ts the local model that writes the night's questions and dares —
//               and the only place a prompt may be dropped (four reasons)
//   • provider.ts the Gemini lane, which reads the night's data and writes
//               the reveal
//   • generate.ts the batched generation run, spicy first, safety-capped
//   • facade.ts PromptProvider — bank-first, never blocks the game
//
// There is no content filter. This is a party for the people in the room, not
// an app that ships: the only things that stop a line being played are that it
// names nobody in the room, repeats one already accepted, runs past
// MAX_PROMPT_CHARS, or is a refusal.
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
  type BankEntry,
  type SelectOptions,
} from "./bank/index.ts";

export {
  BAND_BATCH_SIZE,
  GEN_SAFETY_CAP_MS,
  GEN_TARGET_PROMPTS,
  OLLAMA_DEFAULT_BASE,
  OLLAMA_DEFAULT_MODEL,
  OLLAMA_DEFAULT_TIMEOUT_MS,
  REFUSAL_PATTERNS,
  callOllama,
  fillNames,
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
  restoreNames,
  validateGenerated,
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
