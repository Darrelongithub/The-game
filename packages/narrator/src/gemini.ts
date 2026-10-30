// packages/narrator/src/gemini.ts
// Legacy Gemini transport helper. Application finale narration is template-backed;
// production Gemini calls are restricted to tagging/debrief analysis in packages/prompts.
//
// Everything is injectable (fetch, timeout, base URL) so the whole package can
// be tested against a mocked fetch with zero real network calls.

import { resolveGeminiModel, SAFETY_OFF } from "../../shared/src/contracts.ts";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The contract's SAFETY_OFF uses the literal "OFF", which belongs to the newer
 * interactions API. Classic `v1beta:generateContent` expects `BLOCK_NONE`
 * (verified by agent D on the same endpoint in this repo). We send the classic
 * value first and retry once with the literal contract value if the endpoint
 * rejects the field — either way the narrator still analyses spicy text.
 */
export type SafetyThresholdMode = "classic" | "literal";

export function geminiSafetySettings(
  mode: SafetyThresholdMode = "classic",
): { category: string; threshold: string }[] {
  return SAFETY_OFF.map((entry) => ({
    category: entry.category,
    threshold:
      mode === "classic" && entry.threshold === "OFF" ? "BLOCK_NONE" : entry.threshold,
  }));
}

export interface GeminiRequest {
  apiKey: string;
  system: string;
  user: string;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export type GeminiResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/** A key counts only if it is non-empty after trimming. No key ⇒ templates. */
export function readGeminiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const value = env["GEMINI_API_KEY"];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface GeminiPayload {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { message?: string; status?: string };
}

export async function callGemini(request: GeminiRequest): Promise<GeminiResult> {
  const {
    apiKey,
    system,
    user,
    model = resolveGeminiModel(process.env.GEMINI_MODEL),
    temperature = 0.85,
    maxOutputTokens = 4096,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    baseUrl = GEMINI_API_BASE,
  } = request;

  if (!apiKey || apiKey.trim().length === 0) return { ok: false, reason: "no-key" };
  if (typeof fetchImpl !== "function") return { ok: false, reason: "no-fetch" };

  const url = `${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
  const deadline = Date.now() + Math.max(1, timeoutMs);

  const attempt = async (mode: SafetyThresholdMode): Promise<GeminiResult> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, reason: "timeout" };

    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: {
        temperature,
        responseMimeType: "application/json",
        maxOutputTokens,
      },
      // SAFETY_OFF: it must analyse spicy text without refusing (spec §6).
      safetySettings: geminiSafetySettings(mode),
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) return { ok: false, reason: `http-${response.status}` };

      const payload = (await response.json()) as GeminiPayload;
      if (payload.promptFeedback?.blockReason) {
        return { ok: false, reason: `blocked-${payload.promptFeedback.blockReason}` };
      }
      if (payload.error?.message) return { ok: false, reason: "api-error" };

      const text = (payload.candidates?.[0]?.content?.parts ?? [])
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("")
        .trim();

      if (text.length === 0) return { ok: false, reason: "empty-response" };
      return { ok: true, text };
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      return { ok: false, reason: name === "AbortError" ? "timeout" : "network" };
    } finally {
      clearTimeout(timer);
    }
  };

  const first = await attempt("classic");
  // A 400 here means the endpoint rejected the safety field (classic vs newer
  // API): retry once with the literal contract value, inside the same budget.
  if (!first.ok && first.reason === "http-400") return attempt("literal");
  return first;
}

/** Tolerant JSON extraction: fenced blocks, stray prose, partial wrapping. */
export function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const attempts: string[] = [trimmed];
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(trimmed.slice(first, last + 1));
  const arrFirst = trimmed.indexOf("[");
  const arrLast = trimmed.lastIndexOf("]");
  if (arrFirst !== -1 && arrLast > arrFirst) attempts.push(trimmed.slice(arrFirst, arrLast + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      // try the next slice
    }
  }
  return undefined;
}
