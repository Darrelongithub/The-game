// packages/prompts/src/provider.ts
// TWO INDEPENDENT LANES. Code carries the night; providers only garnish.
//
//   Local OpenAI-compatible generation (GEN_BASE / GEN_MODEL), no key.
//   Grok (XAI_API_KEY) → existing validated reveal call only.
//   Gemini (GEMINI_API_KEY) → analysis (tags, debrief similarity) + narration.
//
// Rules this file enforces:
//   • Cloud lanes check their own keys; a missing key means that lane returns
//     `no-key` without touching the network. Nothing here ever throws.
//   • Both lanes spend from ONE CallGuard (per room, MAX_PROVIDER_CALLS_PER_NIGHT).
//   • 8s AbortController timeout. Refusals / 429 / timeouts return a reason so
//     callers fall back to the bank or to deterministic code, silently.
//   • Only pseudonyms leave the server — `redactAliases` scrubs any alias a
//     caller forgot to strip before a payload is serialized.
import {
  PROVIDERS,
  SAFETY_OFF,
  resolveGeminiModel,
} from "../../shared/src/contracts.ts";
import { CallGuard, callGuard, type CallPurpose } from "./guard.ts";

export type Lane = "grok" | "gemini";

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
  /** Physical HTTP requests made (0 for no-key/budget; ≤2 with a schema/safety retry). */
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
  xaiApiKey?: string | null;
  geminiApiKey?: string | null;
  fetchImpl?: FetchLike;
  guard?: CallGuard;
  genBaseUrl?: string;
  genModel?: string;
  grokBaseUrl?: string;
  geminiBaseUrl?: string;
  grokModel?: string;
  geminiTagModel?: string;
  geminiAnalyzeModel?: string;
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const GROK_ENDPOINT = "/chat/completions";

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
 * body (which would corrupt the request AND leak nothing but still break it).
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
  if (
    status === 400 ||
    status === 403 ||
    status === 422
  ) {
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

export interface GrokRequest {
  room: string;
  messages: ChatMessage[];
  /** Default "generate" — Grok's only job. */
  purpose?: CallPurpose;
  temperature?: number;
  maxTokens?: number;
  /** Ask for `response_format: {type:"json_object"}` (retried without it on 400). */
  json?: boolean;
  model?: string;
  timeoutMs?: number;
  /** Any known player aliases to scrub before the payload leaves the process. */
  aliases?: readonly string[];
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
  private readonly xaiKey: string | null;
  private readonly geminiKey: string | null;
  private readonly fetchImpl: FetchLike | null;
  private readonly genBaseUrl: string;
  private readonly genModel: string;
  private readonly grokBaseUrl: string;
  private readonly geminiBaseUrl: string;
  private readonly grokModel: string;
  private readonly geminiTagModel: string;
  private readonly geminiAnalyzeModel: string;
  private readonly timeoutMs: number;

  constructor(opts: ProviderOptions = {}) {
    const env = envOf(opts);
    this.xaiKey = keyOf(opts.xaiApiKey !== undefined ? opts.xaiApiKey : env.XAI_API_KEY);
    this.geminiKey = keyOf(opts.geminiApiKey !== undefined ? opts.geminiApiKey : env.GEMINI_API_KEY);
    // The model id in contracts.ts is the contract default; XAI_MODEL lets the
    // host override it at game time without a contract change (ids drift).
    this.genBaseUrl = (keyOf(opts.genBaseUrl) ?? keyOf(env.GEN_BASE) ?? "http://localhost:11434/v1").replace(/\/+$/, "");
    this.genModel = keyOf(opts.genModel) ?? keyOf(env.GEN_MODEL) ?? keyOf(env.XAI_MODEL) ?? "dolphin-mistral";
    this.grokModel = opts.grokModel ?? keyOf(env.XAI_MODEL) ?? PROVIDERS.grok.generate;
    this.geminiTagModel = opts.geminiTagModel ?? resolveGeminiModel(keyOf(env.GEMINI_MODEL) ?? undefined);
    this.geminiAnalyzeModel = opts.geminiAnalyzeModel ?? resolveGeminiModel(keyOf(env.GEMINI_MODEL) ?? undefined);
    this.grokBaseUrl = (opts.grokBaseUrl ?? PROVIDERS.grok.baseUrl).replace(/\/+$/, "");
    this.geminiBaseUrl = (opts.geminiBaseUrl ?? "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, "");
    this.guard = opts.guard ?? callGuard;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchCandidate = opts.fetchImpl ?? (typeof fetch === "function" ? (fetch as unknown as FetchLike) : null);
    this.fetchImpl = fetchCandidate;
  }

  /** Explicit env-reading constructor (keys, XAI_MODEL override, timeouts). */
  static fromEnv(opts: ProviderOptions = {}): Provider {
    return new Provider(opts);
  }

  // ---------- lane probes ----------
  /** Grok generation lane; reveal purpose is reserved for one validated narration request. */
  canGenerate(): boolean {
    return this.fetchImpl !== null;
  }

  /** Gemini lane: tagging and debrief analysis only. */
  canAnalyze(): boolean {
    return this.geminiKey !== null && this.fetchImpl !== null;
  }

  lanes(): { grok: boolean; gemini: boolean } {
    return { grok: this.canGenerate(), gemini: this.canAnalyze() };
  }

  modelFor(lane: Lane, purpose: CallPurpose = "generate"): string {
    if (lane === "grok") return purpose === "generate" ? this.genModel : this.grokModel;
    if (purpose === "reveal") throw new Error("Gemini finale narration is disabled; use templates/Grok.");
    if (purpose === "tag") return this.geminiTagModel;
    return this.geminiAnalyzeModel;
  }

  // ---------- Grok lane ----------
  async grok(req: GrokRequest): Promise<LaneResult> {
    const purpose = req.purpose ?? "generate";
    const lane: Lane = "grok";
    const generating = purpose === "generate";
    const baseUrl = generating ? this.genBaseUrl : this.grokBaseUrl;
    const key = generating ? null : this.xaiKey;
    if ((!generating && key === null) || this.fetchImpl === null) return { ok: false, lane, reason: "no-key", requests: 0 };
    if (!this.guard.tryConsume(req.room, purpose)) return { ok: false, lane, reason: "budget", requests: 0 };

    const messages = req.messages.map((m) => ({
      role: m.role,
      content: redactAliases(m.content, req.aliases),
    }));
    const baseBody: Record<string, unknown> = {
      model: req.model ?? this.modelFor(lane, purpose),
      messages,
      temperature: req.temperature ?? 0.9,
      max_tokens: req.maxTokens ?? 1_600,
      stream: false,
    };

    let result = await this.postJsonLane(lane, `${baseUrl}${GROK_ENDPOINT}`, {
      body: req.json === false ? baseBody : { ...baseBody, response_format: { type: "json_object" } },
      key,
      timeoutMs: req.timeoutMs ?? this.timeoutMs,
    });

    // Some model builds reject `response_format`; retry once without it and
    // strict-parse the fenced JSON instead. Retries share the consumed slot.
    if (!result.ok && result.status === 400 && req.json !== false) {
      result = await this.postJsonLane(lane, `${baseUrl}${GROK_ENDPOINT}`, {
        body: baseBody,
        key,
        timeoutMs: req.timeoutMs ?? this.timeoutMs,
      });
    }
    return result;
  }

  /** Grok + loose JSON parse. Invalid JSON → ok:false, reason "parse". */
  async grokJson(req: GrokRequest): Promise<{ result: LaneResult; value: unknown }> {
    const result = await this.grok({ ...req, json: req.json ?? true });
    if (!result.ok) return { result, value: null };
    const value = parseJsonLoose(result.text);
    if (value === null) return { result: { ...result, ok: false, reason: "parse" }, value: null };
    return { result, value };
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
    // If the endpoint rejects the safety field (classic v1beta expects
    // BLOCK_NONE, the newer API expects the literal "OFF"), retry once with the
    // contract's literal thresholds. Either way this stays ONE budgeted call.
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
  if (lane === "grok") {
    const choices = body.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const first = choices[0] as Record<string, unknown>;
      const message = first?.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        // Some builds return content parts.
        const joined = content
          .map((part) => (part && typeof part === "object" ? String((part as Record<string, unknown>).text ?? "") : ""))
          .join("");
        if (joined) return joined;
      }
    }
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
    // Blocked / safety-filtered candidate: no text at all.
    return null;
  }
  return null;
}
