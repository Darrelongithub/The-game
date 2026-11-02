// packages/prompts/src/ollama.ts
// THE OLLAMA LANE — the local model that writes the night's questions.
//
// Wire-up (env, no code change needed):
//   GEN_BASE       default http://127.0.0.1:11434
//   GEN_MODEL      default dolphin-mistral
//   GEN_TIMEOUT_MS default 120000
//
// THE ROOM'S REAL NAMES ARE IN THE PROMPT. The bank writes {P1}..{Pn} slots;
// fillNames() writes the actual display names into them before the request, so
// the model reads "Do you think Wanjiru would sleep with Kofi?" — this is a
// party, not a form — and restoreNames() puts the slots back before a line is
// kept, so the deal can still bind it to whoever the case is about. A line that
// ends up naming nobody in the room is dropped. The name the model reads is
// the roster's own; the SLOT is what is stored, so the question stays true
// whoever it finally lands on — tonight the model is here for the wording, not
// for the casting.
//
// WHAT THE MODEL IS ALLOWED TO DO (and nothing else):
//   1. REPHRASE a bank prompt — the night's questions and its dares.
//
// WHAT IT MAY NOT DO:
//   • Invent a kind of question the bank does not play.
//   • Name a person who is not in the room.
//   • Emit a refusal, an "as an AI" disclaimer, a repeat, or a line over
//     MAX_PROMPT_CHARS.
//
// Reading the answers and writing the reveal is NOT this lane's job: that is
// Gemini (provider.ts, called by the narrator). ON ANY FAILURE the bank prompt
// is used unchanged — the bank carries the night, Ollama only sharpens it.
import {
  BAND_ORDER,
  MAX_PROMPT_CHARS,
  type Band,
  type MetricKey,
  type Prompt,
  type PromptRole,
  type RoundKind,
} from "../../shared/src/contracts.ts";
import { metricOf, placeholderIndexes, seededShuffle } from "./bank/index.ts";

export const OLLAMA_DEFAULT_BASE = "http://127.0.0.1:11434";
export const OLLAMA_DEFAULT_MODEL = "dolphin-mistral";
export const OLLAMA_DEFAULT_TIMEOUT_MS = 120_000;

/** The safety cap on the WHOLE generation run. After this we start anyway. */
export const GEN_SAFETY_CAP_MS = 180_000;

/** How many prompts the loading screen counts towards ("14/40 ready"). */
export const GEN_TARGET_PROMPTS = 40;

/** Per-band batch sizes. Spicy first, so a timeout still leaves the hot prompts. */
export const BAND_BATCH_SIZE: Record<Band, number> = {
  spicy: 15,
  warmup: 10,
  deep: 10,
  dare: 5,
};

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

/** Read the Ollama config from the environment, applying the defaults. */
export function ollamaConfig(env: Record<string, string | undefined> = {}): OllamaConfig {
  const read = (key: string): string | undefined => {
    const source = env[key] ?? (typeof process !== "undefined" ? process.env?.[key] : undefined);
    const value = typeof source === "string" ? source.trim() : "";
    return value.length > 0 ? value : undefined;
  };
  const timeoutRaw = read("GEN_TIMEOUT_MS");
  const parsed = timeoutRaw ? Number(timeoutRaw) : NaN;
  return {
    baseUrl: (read("GEN_BASE") ?? OLLAMA_DEFAULT_BASE).replace(/\/+$/, ""),
    model: read("GEN_MODEL") ?? OLLAMA_DEFAULT_MODEL,
    timeoutMs: Number.isFinite(parsed) && parsed > 0 ? parsed : OLLAMA_DEFAULT_TIMEOUT_MS,
  };
}

// ---------------------------------------------------------------------------
// refusals and self-reference
// ---------------------------------------------------------------------------

/** Phrases that mean "I won't do this" — the output is dropped. */
export const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bi\s+(?:can\s*not|can't|cannot|won't|will\s+not)\b/i,
  /\bi'?m\s+(?:sorry|unable|not\s+able)\b/i,
  /\bi\s+(?:must|have\s+to)\s+(?:decline|refuse)\b/i,
  /\bas\s+an?\s+ai\b/i,
  /\bi'?m\s+an?\s+ai\b/i,
  /\bas\s+a\s+language\s+model\b/i,
  /\bi\s+(?:do\s+not|don't)\s+(?:feel\s+comfortable|think\s+i\s+can)\b/i,
  /\bsorry[,.\s]/i,
  /\bunable\s+to\s+(?:comply|help|assist)\b/i,
  /\bthis\s+(?:request|prompt)\s+(?:violates|is\s+inappropriate)\b/i,
  /\bcontent\s+polic(?:y|ies)\b/i,
];

/** True when the text is a refusal, an AI disclaimer, or a policy statement. */
export function isRefusal(text: string): boolean {
  return REFUSAL_PATTERNS.some((re) => re.test(text));
}

/** True when the text promises to narrate instead of deliver a prompt. */
export function isMetaCommentary(text: string): boolean {
  return /^(?:here(?:'s| is)|sure[,!]|okay[,!]|certainly[,!])/i.test(text.trim());
}

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

export type OllamaDropReason =
  | "not-in-room"     // does not point at a person or pair in this room
  | "repeat"          // says the same thing as a prompt we already have
  | "too-long"        // over MAX_PROMPT_CHARS
  | "refusal";        // refused, or leaked "as an AI"

export interface OllamaValidationInput {
  text: string;
  /** Players actually in the room — the placeholder slots must resolve to them. */
  playerCount: number;
  /** Normalised texts already accepted tonight (for repeat detection). */
  seen: ReadonlySet<string>;
  /** The bank text this was rephrased from, if any. */
  sourceText?: string;
}

export interface OllamaValidation {
  ok: boolean;
  reason?: OllamaDropReason;
  detail?: string;
}

/** Normalise for repeat detection: lowercase, strip punctuation, collapse space. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Validate one generated line. ONLY these four reasons may drop it.
 */
export function validateGenerated(input: OllamaValidationInput): OllamaValidation {
  const raw = (input.text ?? "").trim();
  if (raw.length === 0) return { ok: false, reason: "refusal", detail: "empty" };

  // >160 chars.
  if (raw.length > MAX_PROMPT_CHARS) {
    return { ok: false, reason: "too-long", detail: `${raw.length} chars` };
  }

  // Refusals / AI disclaimers.
  if (isRefusal(raw)) {
    return { ok: false, reason: "refusal", detail: "refusal or AI disclaimer" };
  }
  if (isMetaCommentary(raw)) {
    return { ok: false, reason: "refusal", detail: "meta commentary instead of a prompt" };
  }

  // About a person in the room: a {Pn} slot that resolves to a real player,
  // or an explicit reference to the room.
  const indexes = placeholderIndexes(raw);
  const bindsToRealPlayer = indexes.some((i) => i >= 1 && i <= input.playerCount);
  const refersToRoom = /\b(in|of) this room\b|\bthis room\b|\bthe room\b|\beveryone here\b|\bwho here\b|\bsomeone here\b|\bthis group\b|\bthe group\b/i.test(raw);
  if (!bindsToRealPlayer && !refersToRoom) {
    return { ok: false, reason: "not-in-room", detail: "no player in the room is named" };
  }

  // Repeats — against tonight's accepted lines AND against the source prompt.
  const norm = normalizeForMatch(raw);
  if (input.seen.has(norm)) {
    return { ok: false, reason: "repeat", detail: "same as an earlier prompt" };
  }
  if (input.sourceText && normalizeForMatch(input.sourceText) === norm) {
    return { ok: false, reason: "repeat", detail: "unchanged from the bank prompt" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// the request
// ---------------------------------------------------------------------------

export interface OllamaMessage { role: "system" | "user" | "assistant"; content: string; }

export interface OllamaRequest {
  messages: OllamaMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export type OllamaFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OllamaResult {
  ok: boolean;
  text?: string;
  reason?: "network" | "timeout" | "http" | "empty" | "disabled";
  status?: number;
}

/**
 * Write the room's real display names into a bank line's {Pn} slots. Slots
 * outside the roster (a four-player room asked for {P7}) stay as slots, and the
 * validator will not accept them — the bank line stands instead.
 */
export function fillNames(text: string, names: readonly string[]): string {
  if (names.length === 0) return text;
  return text.replace(/\{P(\d+)\}/g, (whole, digits: string) => {
    const i = parseInt(digits, 10) - 1;
    return i >= 0 && i < names.length ? names[i] ?? whole : whole;
  });
}

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Put the {Pn} slots back wherever the model wrote a player's name. Longest
 * names first, so "Kamau" is matched before "Kam"; word-bounded, so "Or"
 * cannot carve up "orange". The slot number is the roster position.
 */
export function restoreNames(text: string, names: readonly string[]): string {
  let out = text;
  const ordered = names
    .map((name, i) => ({ name: name.trim(), slot: `{P${i + 1}}` }))
    .filter((entry) => entry.name.length >= 2)
    .sort((a, b) => b.name.length - a.name.length);
  for (const entry of ordered) {
    out = out.replace(
      new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(entry.name)}(?![\\p{L}\\p{N}_])`, "giu"),
      entry.slot,
    );
  }
  return out;
}

/** The system prompt for the rephrase job. It is deliberately narrow. */
export function rephraseSystemPrompt(): string {
  return [
    "You rewrite party-game questions for adults who all know each other.",
    "Rules:",
    "- Keep the meaning of the question you are given. Change only the wording.",
    "- Every line names real people in this room. Keep every one of those names, spelled exactly as given, and keep the question about the same people.",
    "- You may write {P1}, {P2} … instead of a name; those slots are the same players.",
    `- Output ONE question per line. No numbering, no bullets, no quotes, no explanation.`,
    `- Each line must be at most ${MAX_PROMPT_CHARS} characters.`,
    "- Ask about a person or people in the room. Never bring in anyone who is not in the room.",
    "- Be blunt, funny and a bit rude.",
    "- Never mention being an AI, never explain yourself, never refuse.",
    "- Never repeat a question that is already in the list.",
  ].join("\n");
}

/**
 * One batch request: the model rephrases the given bank prompts.
 * `slots` is the list of {Pn} indices the model may use.
 */
export function rephraseUserPrompt(seedTexts: readonly string[]): string {
  const lines = seedTexts.map((t, i) => `${i + 1}. ${t}`).join("\n");
  return [
    "Rewrite each of these questions. One rewritten question per line, same order, and keep every person's name.",
    "",
    lines,
  ].join("\n");
}

/** Parse the model's reply into one candidate per line. */
export function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// the HTTP client
// ---------------------------------------------------------------------------

/**
 * Call Ollama. Tries the native `/api/chat` endpoint first, then the
 * OpenAI-compatible `/v1/chat/completions`. Both shapes are parsed.
 */
export async function callOllama(
  config: OllamaConfig,
  req: OllamaRequest,
  fetchImpl: OllamaFetch | null = typeof fetch === "function" ? (fetch as unknown as OllamaFetch) : null,
): Promise<OllamaResult> {
  if (!fetchImpl) return { ok: false, reason: "disabled" };
  const timeoutMs = req.timeoutMs ?? config.timeoutMs;

  const attempts: { url: string; body: unknown }[] = [
    {
      url: `${config.baseUrl}/api/chat`,
      body: {
        model: config.model,
        messages: req.messages,
        stream: false,
        options: {
          temperature: req.temperature ?? 0.9,
          num_predict: req.maxTokens ?? 1_600,
        },
      },
    },
    {
      url: `${config.baseUrl}/v1/chat/completions`,
      body: {
        model: config.model,
        messages: req.messages,
        temperature: req.temperature ?? 0.9,
        max_tokens: req.maxTokens ?? 1_600,
        stream: false,
      },
    },
  ];

  let lastStatus: number | undefined;
  let lastReason: OllamaResult["reason"] = "network";

  for (const attempt of attempts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
    try {
      const response = await fetchImpl(attempt.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(attempt.body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        lastStatus = response.status;
        lastReason = "http";
        continue; // try the next shape
      }
      const text = parseOllamaText(raw);
      if (text && text.trim().length > 0) return { ok: true, text, status: response.status };
      lastReason = "empty";
      continue;
    } catch (error) {
      const name = (error as { name?: string } | null)?.name;
      if (name === "AbortError" || controller.signal.aborted) {
        lastReason = "timeout";
        lastStatus = undefined;
        break; // a timeout means the model is too slow — do not burn the other shape
      }
      lastReason = "network";
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, reason: lastReason, status: lastStatus };
}

/** Pull the text out of either Ollama response shape. */
export function parseOllamaText(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const body = parsed as Record<string, unknown>;

  // Native shape: { message: { content } }
  const message = body.message as Record<string, unknown> | undefined;
  if (message && typeof message.content === "string") return message.content;
  // Some native builds return `response` instead of `message`.
  if (typeof body.response === "string") return body.response;

  // OpenAI-compatible shape: { choices: [{ message: { content } }] }
  const choices = body.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    const m = first?.message as Record<string, unknown> | undefined;
    if (m && typeof m.content === "string") return m.content;
    if (typeof first?.text === "string") return first.text;
  }
  return null;
}

// ---------------------------------------------------------------------------
// the generation driver
// ---------------------------------------------------------------------------

export interface OllamaBankPrompt {
  id: string;
  band: Band;
  role: PromptRole;
  kind: RoundKind;
  text: string;
  metric?: MetricKey;
}

export interface OllamaBatchReport {
  band: Band;
  asked: number;
  accepted: number;
  dropped: number;
  /** Why each candidate was dropped. */
  reasons: Record<string, number>;
  /** The prompts that survived. */
  prompts: Prompt[];
}

export interface OllamaRunReport {
  batches: OllamaBatchReport[];
  accepted: number;
  dropped: number;
  /** True when the safety cap cut the run short. */
  capped: boolean;
  /** True when Ollama was not reachable at all — the bank carries the night. */
  offline: boolean;
}

/**
 * Rewrite the night's bank prompts with the local model.
 *
 * The run walks the bands in BAND_ORDER (spicy first) and stops at the
 * safety cap. Every batch reports how many candidates were asked, accepted
 * and dropped, with the reasons — that report is what the host terminal
 * prints.
 */
export async function generateNightWithOllama(
  seedByBand: Record<Band, OllamaBankPrompt[]>,
  opts: {
    config: OllamaConfig;
    playerCount: number;
    seed: number;
    /** The room's display names, in roster order — written into the request. */
    aliases?: readonly string[];
    fetchImpl?: OllamaFetch | null;
    now?: () => number;
    safetyCapMs?: number;
    log?: (line: string) => void;
  },
): Promise<OllamaRunReport> {
  const now = opts.now ?? (() => Date.now());
  const started = now();
  const cap = opts.safetyCapMs ?? GEN_SAFETY_CAP_MS;
  const batches: OllamaBatchReport[] = [];
  const seen = new Set<string>();
  let accepted = 0;
  let dropped = 0;
  let capped = false;
  let offline = false;

  for (const band of BAND_ORDER) {
    const seeds = seedByBand[band] ?? [];
    if (seeds.length === 0) continue;

    // Respect the safety cap BEFORE spending another (slow) model call.
    if (now() - started >= cap) {
      capped = true;
      break;
    }

    const asked = seeds.length;
    const shuffled = seededShuffle(seeds, opts.seed);
    const names = opts.aliases ?? [];
    const result = await callOllama(
      opts.config,
      {
        messages: [
          { role: "system", content: rephraseSystemPrompt() },
          {
            role: "user",
            content: rephraseUserPrompt(shuffled.map((s) => fillNames(s.text, names))),
          },
        ],
        temperature: 0.95,
        maxTokens: 1_600,
      },
      opts.fetchImpl ?? null,
    );

    const reasons: Record<string, number> = {};
    const prompts: Prompt[] = [];
    let acceptedHere = 0;

    if (!result.ok || !result.text) {
      if (result.reason === "network" || result.reason === "disabled") offline = true;
      reasons.unavailable = (reasons.unavailable ?? 0) + 1;
      dropped += asked;
      batches.push({ band, asked, accepted: 0, dropped: asked, reasons, prompts: [] });
      opts.log?.(
        `Ollama: asked ${asked}, accepted 0, dropped ${asked} (unavailable:${result.reason ?? "unknown"})`,
      );
      continue;
    }

    const lines = parseLines(result.text);
    for (let i = 0; i < shuffled.length; i++) {
      const seed = shuffled[i]!;
      const written = lines[i];
      // The model was handed real names and may have written them back; the
      // bank stores slots, so put the slots back before anything is kept.
      const candidate = written === undefined ? undefined : restoreNames(written, names);
      if (!candidate) {
        reasons["missing"] = (reasons["missing"] ?? 0) + 1;
        dropped += 1;
        continue;
      }
      const check = validateGenerated({
        text: candidate,
        playerCount: opts.playerCount,
        seen,
        sourceText: seed.text,
      });
      if (!check.ok) {
        reasons[check.reason ?? "unknown"] = (reasons[check.reason ?? "unknown"] ?? 0) + 1;
        dropped += 1;
        continue;
      }
      seen.add(normalizeForMatch(candidate));
      prompts.push({
        id: `${seed.id}-ollama`,
        source: "ollama",
        band: seed.band,
        role: seed.role,
        kind: seed.kind,
        text: candidate,
        measures: seed.metric ? [`metric:${seed.metric}`] : [],
        coding: "neutral",
        asksTarget: seed.role === "observer_subject" || seed.role === "observer_pair" || seed.role === "group" || seed.role === "dare",
      });
      acceptedHere += 1;
    }
    // A candidate the model produced but we had no seed for is dropped as a repeat/unknown.
    for (let i = shuffled.length; i < lines.length; i++) {
      reasons["extra"] = (reasons["extra"] ?? 0) + 1;
      dropped += 1;
    }

    accepted += acceptedHere;
    batches.push({ band, asked, accepted: acceptedHere, dropped: asked - acceptedHere, reasons, prompts });
    opts.log?.(
      `Ollama: asked ${asked}, accepted ${acceptedHere}, dropped ${asked - acceptedHere} (${formatReasons(reasons)})`,
    );

    if (now() - started >= cap) {
      capped = true;
      break;
    }
  }

  return { batches, accepted, dropped, capped, offline };
}

/** "not-in-room:1, repeat:2" — the reason summary the terminal prints. */
export function formatReasons(reasons: Record<string, number>): string {
  const entries = Object.entries(reasons).filter(([, n]) => n > 0);
  if (entries.length === 0) return "none";
  return entries.map(([reason, n]) => `${reason}:${n}`).join(", ");
}
