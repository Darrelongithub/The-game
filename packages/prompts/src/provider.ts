// packages/prompts/src/provider.ts
// TWO INDEPENDENT LANES. Code carries the night; providers only garnish.
//
//   Ollama  (GEN_BASE / GEN_MODEL)  → the local model that writes the night's
//                                     questions and dares, and the one-line
//                                     verdicts. No API key, no cloud, no cost.
//   Gemini (GEMINI_API_KEY)         → analysis only (it arranges the data).
//
// Rules this file enforces:
//   • Each lane checks only its own key/config; a missing key means that lane
//     returns `no-key` without touching the network. Nothing here throws.
//   • Both lanes spend from ONE CallGuard (per room, MAX_PROVIDER_CALLS_PER_NIGHT).
//   • Only pseudonyms leave the server — `redactAliases` scrubs any alias a
//     caller forgot to strip before a payload is serialized.
import {
  PROVIDERS,
  SAFETY_OFF,
  resolveGeminiModel,
} from "../../shared/src/contracts.ts";
import { CallGuard, callGuard, type CallPurpose } from "./guard.ts";
import { ollamaConfig, type OllamaConfig } from "./ollama.ts";

export type Lane = "ollama" | "gemini";

export type ProviderFailReason =
  | "no-key"
  | "budget"
  | "timeout"
  | "refusal"
  | "rate-limit"
  | "http"
  | "network"
  | "empty"
  | "parse"
  | "disabled";

export interface LaneResult {
  ok: boolean;
  lane: Lane;
  /** Raw model text when ok. Never surfaced to players without validation. */
  text?: string;
  reason?: ProviderFailReason;
  status?: number;
  /** Physical HTTP requests made (0 for no-key/budget). */
  requests: number;
}

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json?(): Promise<unknown>;
}>;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderOptions {
  geminiApiKey?: string | null;
  fetchImpl?: FetchLike;
  guard?: CallGuard;
  geminiBaseUrl?: string;
  geminiTagModel?: string;
  geminiAnalyzeModel?: string;
  timeoutMs?: number;
  /** Ollama wiring — defaults to the GEN_* environment variables. */
  ollama?: Partial<OllamaConfig>;
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 8_000;

function envOf(opts: ProviderOptions): Record<string, string | undefined> {
  if (opts.env) return opts.env;
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function keyOf(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Alias matcher: whole-token, case-insensitive, unicode-aware. Word boundaries
 * matter — a two-letter alias like "Mo" must not rewrite `"model"` in a JSON
 * body.
 */
function aliasPattern(alias: string): RegExp | null {
  const clean = alias.trim().normalize("NFC");
  if (clean.length < 2) return null;
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "giu");
}

/** Rewrite any known alias to a neutral in-room reference (pseudonyms only). */
export function redactAliases(text: string, aliases: readonly string[] | undefined): string {
  if (!text || !aliases || aliases.length === 0) return text;
  let out = text.normalize("NFC");
  for (const alias of aliases) {
    const pattern = typeof alias === "string" ? aliasPattern(alias) : null;
    if (pattern) out = out.replace(pattern, "someone in the room");
  }
  return out;
}

/** True when a payload still contains a real alias (used by tests/asserts). */
export function containsAlias(text: string, aliases: readonly string[] | undefined): boolean {
  if (!text || !aliases) return false;
  const normalized = text.normalize("NFC");
  return aliases.some((alias) => {
    if (typeof alias !== "string") return false;
    const pattern = aliasPattern(alias);
    return pattern ? pattern.test(normalized) : false;
  });
}

/**
 * Loose JSON reader: accepts a bare array/object, a ```json fence, or prose
 * wrapped around one. Returns null instead of throwing — callers fall back.
 */
export function parseJsonLoose(text: string | undefined | null): unknown | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const candidates: string[] = [];
  const fence = trimmed.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      // fall through to bracket slicing
    }
    const firstArray = candidate.indexOf("[");
    const firstObject = candidate.indexOf("{");
    const starts = [firstArray, firstObject].filter((i) => i >= 0);
    if (starts.length === 0) continue;
    const start = Math.min(...starts);
    const open = candidate[start];
    const close = open === "[" ? "]" : "}";
    const end = candidate.lastIndexOf(close);
    if (end <= start) continue;
    const slice = candidate.slice(start, end + 1);
    try {
      return JSON.parse(slice) as unknown;
    } catch {
      // next candidate
    }
  }
  return null;
}

function classifyFailure(status: number, body: string): ProviderFailReason {
  if (status === 429) return "rate-limit";
  if (status === 408 || status === 504) return "timeout";
  const lower = body.toLowerCase();
  if (status === 400 || status === 403 || status === 422) {
    if (
      lower.includes("policy") ||
      lower.includes("safety") ||
      lower.includes("refus") ||
      lower.includes("blocked") ||
      lower.includes("content filter") ||
      lower.includes("moderation") ||
      lower.includes("not allowed")
    ) {
      return "refusal";
    }
  }
  return "http";
}

/**
 * Gemini thresholds: classic `v1beta:generateContent` uses `BLOCK_NONE`
 * (the literal "OFF" comes from the newer interactions API that SAFETY_OFF's
 * comment mentions). We send the classic value first and retry with the
 * literal contract value if the endpoint rejects the field.
 */
export function geminiSafetySettings(threshold: "classic" | "literal" = "classic"): Array<Record<string, string>> {
  return SAFETY_OFF.map((entry) => ({
    category: entry.category,
    threshold: threshold === "classic" && entry.threshold === "OFF" ? "BLOCK_NONE" : entry.threshold,
  }));
}

export interface GeminiRequest {
  room: string;
  purpose: CallPurpose;
  model: string;
  system?: string;
  user: string;
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  timeoutMs?: number;
  aliases?: readonly string[];
}

/**
 * The lane client. Construct one per server process (or per room harness in
 * tests) and pass it to `generateBatch` / `tagBatch` / `debriefBatch`.
 */
export class Provider {
  readonly guard: CallGuard;
  readonly ollama: OllamaConfig;
  private readonly geminiKey: string | null;
  private readonly fetchImpl: FetchLike | null;
  private readonly geminiBaseUrl: string;
  private readonly geminiTagModel: string;
  private readonly geminiAnalyzeModel: string;
  private readonly timeoutMs: number;

  constructor(opts: ProviderOptions = {}) {
    const env = envOf(opts);
    this.geminiKey = keyOf(opts.geminiApiKey !== undefined ? opts.geminiApiKey : env.GEMINI_API_KEY);
    this.geminiTagModel = opts.geminiTagModel ?? resolveGeminiModel(keyOf(env.GEMINI_MODEL) ?? undefined);
    this.geminiAnalyzeModel = opts.geminiAnalyzeModel ?? resolveGeminiModel(keyOf(env.GEMINI_MODEL) ?? undefined);
    this.geminiBaseUrl = (opts.geminiBaseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    this.guard = opts.guard ?? callGuard;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.ollama = { ...ollamaConfig(env), ...(opts.ollama ?? {}) };
    const fetchCandidate = opts.fetchImpl ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : null);
    this.fetchImpl = fetchCandidate;
  }

  /** Explicit env-reading constructor (keys, models, timeouts). */
  static fromEnv(opts: ProviderOptions = {}): Provider {
    return new Provider(opts);
  }

  // ---------- lane probes ----------
  /** The local model: always available in principle — it needs no key. */
  canGenerate(): boolean {
    return this.fetchImpl !== null;
  }

  /** Gemini lane: tagging and debrief analysis only. */
  canAnalyze(): boolean {
    return this.geminiKey !== null && this.fetchImpl !== null;
  }

  lanes(): { ollama: boolean; gemini: boolean } {
    return { ollama: this.canGenerate(), gemini: this.canAnalyze() };
  }

  modelFor(lane: Lane, purpose: CallPurpose = "generate"): string {
    if (lane === "ollama") return this.ollama.model;
    if (purpose === "reveal") throw new Error("Gemini finale narration is disabled; use templates/Ollama.");
    if (purpose === "tag") return this.geminiTagModel;
    return this.geminiAnalyzeModel;
  }

  // ---------- Ollama lane ----------
  /**
   * The local model. This is where the night's questions and dares come from.
   * A missing model, a refused request or a timeout returns a reason so the
   * caller falls back to the bank, silently.
   */
  async ollamaChat(req: {
    room: string;
    messages: ChatMessage[];
    purpose?: CallPurpose;
    temperature?: number;
    maxTokens?: number;
    timeoutMs?: number;
    aliases?: readonly string[];
  }): Promise<LaneResult> {
    const lane: Lane = "ollama";
    const purpose = req.purpose ?? "generate";
    if (this.fetchImpl === null) return { ok: false, lane, reason: "disabled", requests: 0 };
    if (!this.guard.tryConsume(req.room, purpose)) return { ok: false, lane, reason: "budget", requests: 0 };

    const messages = req.messages.map((m) => ({
      role: m.role,
      content: redactAliases(m.content, req.aliases),
    }));

    const controller = new AbortController();
    const timeoutMs = req.timeoutMs ?? this.ollama.timeoutMs;
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await this.fetchImpl(`${this.ollama.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.ollama.model,
          messages,
          temperature: req.temperature ?? 0.9,
          max_tokens: req.maxTokens ?? 1_600,
          stream: false,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        return { ok: false, lane, reason: classifyFailure(response.status, raw), status: response.status, requests: 1 };
      }
      const text = extractText(lane, raw);
      if (!text || text.trim().length === 0) {
        return { ok: false, lane, reason: "empty", status: response.status, requests: 1 };
      }
      return { ok: true, lane, text, status: response.status, requests: 1 };
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      const aborted = name === "AbortError" || controller.signal.aborted;
      return { ok: false, lane, reason: aborted ? "timeout" : "network", requests: 1 };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------- Gemini lane ----------
  async gemini(req: GeminiRequest): Promise<LaneResult> {
    const lane: Lane = "gemini";
    if (req.purpose === "reveal") return { ok: false, lane, reason: "disabled", requests: 0 };
    if (this.geminiKey === null || this.fetchImpl === null) return { ok: false, lane, reason: "no-key", requests: 0 };
    if (!this.guard.tryConsume(req.room, req.purpose)) return { ok: false, lane, reason: "budget", requests: 0 };

    const model = req.model || this.modelFor("gemini", req.purpose);
    const url = `${this.geminiBaseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(this.geminiKey)}`;
    const buildBody = (threshold: "classic" | "literal") => ({
      ...(req.system ? { systemInstruction: { parts: [{ text: redactAliases(req.system, req.aliases) }] } } : {}),
      contents: [{ role: "user", parts: [{ text: redactAliases(req.user, req.aliases) }] }],
      generationConfig: {
        temperature: req.temperature ?? 0.4,
        maxOutputTokens: req.maxTokens ?? 2_048,
        responseMimeType: req.json === false ? "text/plain" : "application/json",
      },
      safetySettings: geminiSafetySettings(threshold),
    });

    const result = await this.postGemini(url, buildBody("classic"), req.timeoutMs ?? this.timeoutMs);
    if (!result.ok && result.status === 400) {
      return this.postGemini(url, buildBody("literal"), req.timeoutMs ?? this.timeoutMs);
    }
    return result;
  }

  async geminiJson<T = unknown>(req: GeminiRequest): Promise<{ result: LaneResult; value: T | null }> {
    const result = await this.gemini({ ...req, json: req.json ?? true });
    if (!result.ok) return { result, value: null };
    const value = parseJsonLoose(result.text) as T | null;
    if (value === null) return { result: { ...result, ok: false, reason: "parse" }, value: null };
    return { result, value };
  }

  // ---------- transport ----------
  private async postGemini(url: string, body: unknown, timeoutMs: number): Promise<LaneResult> {
    return this.postJsonLane("gemini", url, { body, key: null, timeoutMs });
  }

  private async postJsonLane(
    lane: Lane,
    url: string,
    opts: { body: unknown; key: string | null; timeoutMs: number },
  ): Promise<LaneResult> {
    const fetchImpl = this.fetchImpl;
    if (!fetchImpl) return { ok: false, lane, reason: "no-key", requests: 0 };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, opts.timeoutMs));
    const requests = 1;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (opts.key) headers.authorization = `Bearer ${opts.key}`;
      const response = await fetchImpl(url, {
        method: "POST",
        headers,
        body: JSON.stringify(opts.body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        return {
          ok: false,
          lane,
          reason: classifyFailure(response.status, raw),
          status: response.status,
          requests,
        };
      }
      const text = extractText(lane, raw);
      if (!text || text.trim().length === 0) {
        return { ok: false, lane, reason: "empty", status: response.status, requests };
      }
      return { ok: true, lane, text, status: response.status, requests };
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      const aborted = name === "AbortError" || controller.signal.aborted;
      return { ok: false, lane, reason: aborted ? "timeout" : "network", requests };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Pull the assistant text out of an OpenAI-compatible or Gemini response body. */
export function extractText(lane: Lane, raw: string): string | null {
  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;
  if (lane === "ollama") {
    const choices = body.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      const message = first?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        const joined = content
          .map((part) => (part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : ""))
          .join("");
        if (joined) return joined;
      }
    }
    // Native Ollama shape.
    const nativeMessage = body.message as Record<string, unknown> | undefined;
    if (nativeMessage && typeof nativeMessage.content === "string") return nativeMessage.content;
    if (typeof body.response === "string") return body.response;
    return null;
  }
  const candidates = body.candidates;
  if (Array.isArray(candidates) && candidates.length > 0) {
    const first = candidates[0] as Record<string, unknown>;
    const content = first?.content as Record<string, unknown> | undefined;
    const parts = content?.parts;
    if (Array.isArray(parts)) {
      const joined = parts
        .map((part) => (part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : ""))
        .join("");
      if (joined.trim().length > 0) return joined;
    }
    return null;
  }
  return null;
}
