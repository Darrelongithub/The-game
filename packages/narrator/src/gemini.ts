// packages/narrator/src/gemini.ts
// The narrator's own thin fetch helper — narration is Gemini's lane (spec §6).
//
// ONE call per night, ONCE, on `PROVIDERS.gemini.reveal` (higher tier) with
// SAFETY_OFF attached so it can analyse spicy text without refusing.
// Grok is never used here: generation is Grok's lane, narration is Gemini's.
//
// Everything is injectable (fetch, timeout, base URL) so the whole package can
// be tested against a mocked fetch with zero real network calls.

import { PROVIDERS, SAFETY_OFF } from "../../shared/src/contracts.ts";

export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_TIMEOUT_MS = 10_000;

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
    model = PROVIDERS.gemini.reveal,
    temperature = 0.85,
    maxOutputTokens = 4096,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
    baseUrl = GEMINI_API_BASE,
  } = request;

  if (!apiKey || apiKey.trim().length === 0) return { ok: false, reason: "no-key" };
  if (typeof fetchImpl !== "function") return { ok: false, reason: "no-fetch" };

  const url = `${baseUrl.replace(/\/+$/, "")}/models/${encodeURIComponent(model)}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature,
      responseMimeType: "application/json",
      maxOutputTokens,
    },
    // SAFETY_OFF: it must analyse spicy text without refusing (spec §6).
    safetySettings: SAFETY_OFF.map((setting) => ({
      category: setting.category,
      threshold: setting.threshold,
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

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
    if (payload.error?.message) return { ok: false, reason: `api-error` };

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
