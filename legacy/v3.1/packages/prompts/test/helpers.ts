// packages/prompts/test/helpers.ts
// Test doubles. ZERO real network: every lane call goes through a mock fetch.
import type { NightDigest } from "../../shared/src/contracts.ts";
import type { FetchLike, ProviderOptions } from "../src/provider.ts";
import { Provider } from "../src/provider.ts";
import { CallGuard } from "../src/guard.ts";

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  /** Raw body string, for "no alias leaked" assertions. */
  raw: string;
}

export interface MockResponse {
  status?: number;
  text: string;
}

export type Responder = (call: RecordedCall) => MockResponse | Promise<MockResponse>;

export interface MockFetch {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
}

/** A fetch double that records every call and answers from `responder`. */
export function mockFetch(responder: Responder): MockFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = async (
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ) => {
    const raw = init?.body ?? "";
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = { __unparsed: raw };
    }
    const call: RecordedCall = { url: input, headers: init?.headers ?? {}, body, raw };
    calls.push(call);
    const out = await responder(call);
    const status = out.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => out.text,
      json: async () => JSON.parse(out.text) as unknown,
    };
  };
  return { fetchImpl, calls: calls as RecordedCall[] };
}

/** A fetch double that never answers until its AbortSignal fires. */
export function hangingFetch(): MockFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl = (
    input: string,
    init?: { headers?: Record<string, string>; body?: string; signal?: AbortSignal },
  ) =>
    new Promise<never>((_resolve, reject) => {
      const raw = init?.body ?? "";
      calls.push({ url: input, headers: init?.headers ?? {}, body: {}, raw });
      const signal = init?.signal;
      if (signal) {
        if (signal.aborted) {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
          return;
        }
        signal.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      }
    });
  return { fetchImpl: fetchImpl as unknown as FetchLike, calls };
}

export const grokReply = (content: string): MockResponse => ({
  text: JSON.stringify({ choices: [{ message: { content } }], usage: { total_tokens: 10 } }),
});

export const geminiReply = (content: string): MockResponse => ({
  text: JSON.stringify({ candidates: [{ content: { parts: [{ text: content }] } }], usageMetadata: {} }),
});

/**
 * Provider with explicit keys/fetch and NO ambient env leakage.
 * Each call gets its OWN CallGuard so tests can't spend each other's budget
 * (production uses the shared per-process guard).
 */
export function makeProvider(opts: ProviderOptions = {}): Provider {
  return new Provider({ env: {}, timeoutMs: 50, guard: new CallGuard(), ...opts });
}

/** A valid generated-candidate shape (spicy phase, 4-player room). */
export function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: "Who here would you trust to lie for you without asking why? Point at them.",
    kind: "pick",
    coding: "trust",
    measures: ["trust network"],
    asksTarget: true,
    callback: false,
    ...overrides,
  };
}

export function makeDigest(overrides: Partial<NightDigest> = {}): NightDigest {
  return {
    quotes: [
      { alias: "Nadia", text: "I once drove to Mombasa to avoid a group chat", context: "warmup: chaos baseline" },
      { alias: "Tolu", text: "I have never actually finished a series in my life", context: "spicy: confession" },
    ],
    stats: {
      fastest: { alias: "Nadia", ms: 900 },
      slowest: { alias: "Tolu", ms: 79_000 },
      topDodger: { alias: "Mo", count: 3 },
      tapWar: { alias: "Kendi", score: 71 },
    },
    runningGags: [{ word: "unhinged", count: 4 }],
    pickTeasers: ["Somebody keeps picking the same person. Somebody."],
    dodges: [{ alias: "Mo", reason: "my mother is on this call" }],
    selfVsRoom: [{ alias: "Kendi", trait: "chaos", self: 9, roomMean: 4.5 }],
    ...overrides,
  };
}

export const ALIASES = ["Nadia", "Tolu", "Mo", "Kendi"];
