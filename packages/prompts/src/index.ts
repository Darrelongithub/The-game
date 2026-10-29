// packages/prompts/src/index.ts
// Public surface of @reveal/prompts (Agent D — PROMPTS & PROVIDERS).
//
//   • bank/      the fallback bank: ≥15 prompts/phase, u1–u27 behind SPICY_TIER
//   • filter.ts  the deterministic guardrail (schema, dedupe, banned, data-or-dead)
//   • provider.ts two independent lanes (Grok generation / Gemini analysis)
//   • analyze.ts code-first tags + token-Jaccard, one optional Gemini refinement
//   • generate.ts ONE batched Grok call per phase, filtered, callbacks verified
//   • facade.ts  PromptProvider.forPhase(phase, n, used) — bank-first
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
  type GrokRequest,
  type Lane,
  type LaneResult,
  type ProviderFailReason,
  type ProviderOptions,
} from "./provider.ts";

export {
  BANK_PHASES,
  PHASE_KINDS,
  RAW_BANK,
  UNHINGED_IDS,
  bankCounts,
  bankForPhase,
  loadBank,
  maxPlaceholderIndex,
  placeholderIndexes,
  selectFromBank,
  spicyTierEnabled,
  type BankEntry,
  type BankOptions,
  type PromptPhase,
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
  checkDataOrDead,
  checkHardBlocked,
  containsVerbatimQuote,
  filterCandidates,
  hasRoomReference,
  isRoomDirected,
  normalizeCandidate,
  normalizeCoding,
  normalizeKind,
  normalizeMeasures,
  type BannedRule,
  type Dropped,
  type DropReason,
  type FilterContext,
  type Verdict,
} from "./filter.ts";

export {
  LEXICON,
  NEGATIVE_TAGS,
  POSITIVE_TAGS,
  TAG_TAXONOMY,
  codingToTags,
  contemptDensity,
  debriefBatch,
  debriefSimilarity,
  isTag,
  primaryTag,
  tagBatch,
  tagText,
  type AnalyzeOptions,
  type DebriefBatchOptions,
  type Tag,
  type TagBatchOptions,
} from "./analyze.ts";

export {
  callbackQuotes,
  checkCallbackIntegrity,
  ensureCallbackShare,
  generateBatch,
  generateBatchReport,
  pseudonymizedDigest,
  type GenerateBatchInput,
  type GenerateBatchReport,
  type GenerateDrop,
} from "./generate.ts";

export {
  DEFAULT_HOST_PHASE,
  MAX_HOST_CHARS,
  MAX_HOST_LINES,
  inferKind,
  parseHostLines,
  type HostPromptRejection,
  type HostPromptResult,
} from "./custom.ts";

export {
  TRAIT_MEASURE_PREFIX,
  inferTrait,
  traitOfPrompt,
} from "./trait.ts";

export {
  STOPWORDS,
  clamp01,
  jaccard,
  normalizeForDedupe,
  tokenSet,
  tokenize,
} from "./text.ts";

export {
  PromptProvider,
  createPromptProvider,
  type GenerationState,
  type PromptProviderOptions,
} from "./facade.ts";

export {
  DEFAULT_WEIGHTS,
  MAX_PROVIDER_CALLS_PER_NIGHT,
  PROVIDERS,
  ROUND_TIMERS_MS,
  SAFETY_OFF,
  SECRET_DECK_MAX,
  SPICY_TIER,
  TRAITS,
  pseudonym,
  type NightDigest,
  type Prompt,
  type PromptCoding,
  type RoundKind,
  type TraitId,
} from "../../shared/src/contracts.ts";
