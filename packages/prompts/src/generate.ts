// packages/prompts/src/generate.ts
// BATCHED GENERATION — ONE Grok call per phase, in the lobby background.
//
// Spec §6: "generation = ONE call per phase (~15 candidates per call) … in the
// lobby background — never in the gameplay loop". The provider is never on the
// critical path: any refusal, timeout, 429 or garbage returns `[]` and the bank
// carries the night. Generated prompts only AUGMENT the bank.
//
// The model proposes; deterministic code disposes: schema, dedupe, banned
// patterns, 20–160 chars, valid {P1}..{P11}, the data-or-dead rule, and the
// callback rule (verbatim digest quotes only — never an invented answer).
import type { NightDigest, Prompt, PromptStyle } from "../../shared/src/contracts.ts";
import { PHASE_KINDS, UNHINGED_IDS, maxPlaceholderIndex, type PromptPhase } from "./bank/index.ts";
import {
  containsVerbatimQuote,
  filterCandidates,
  normalizeKind,
  normalizeMeasures,
  type DropReason,
} from "./filter.ts";
import type { Provider, ProviderFailReason } from "./provider.ts";
import { redactAliases } from "./provider.ts";
import { BANK } from "./bank/index.ts";
import { inferTrait, TRAIT_MEASURE_PREFIX } from "./trait.ts";

export type GenerateDrop = DropReason | "invented-quote" | "no-quote" | "no-trait";

export interface GenerateBatchInput {
  phase: PromptPhase;
  playerCount: number;
  usedIds?: readonly string[];
  digest?: NightDigest | null;
  /** Room id for the call guard (defaults to a stable per-process label). */
  room?: string;
  /** Target number of candidates to ask for / keep (default 15). */
  count?: number;
  provider?: Provider | null;
  /** Known aliases — scrubbed from the payload and from any digested quote. */
  aliases?: readonly string[];
  /** Override the dedupe corpus (tests). Defaults to the whole bank. */
  bankTexts?: readonly string[];
  /**
   * THE SECOND VOICE: which register this request asks for. Omitted = BOTH
   * voices in one batch (the night needs a 50/50), which is what the lobby
   * background call uses; a targeted request can pin one register.
   */
  style?: PromptStyle;
}

export interface GenerateBatchReport {
  prompts: Prompt[];
  lane: "grok" | "bank";
  reason?: ProviderFailReason;
  /** Candidates the model returned. */
  candidates: number;
  accepted: number;
  dropped: { index: number; reason: GenerateDrop; detail?: string }[];
  /** Accepted prompts that quote a digest answer verbatim. */
  callbacks: number;
  /** True when a provider call was actually attempted (and budgeted). */
  called: boolean;
}

const DEFAULT_COUNT = 15;
const QUOTE_MAX = 6;

/** Strip every alias out of the digest before it is allowed near a provider. */
export function pseudonymizedDigest(
  digest: NightDigest | null | undefined,
  aliases: readonly string[] | undefined,
): Record<string, unknown> | null {
  if (!digest) return null;
  const scrub = (value: string) => redactAliases(value, aliases);
  return {
    quotes: (digest.quotes ?? []).slice(0, 12).map((q) => ({
      text: scrub(q.text ?? ""),
      context: scrub(q.context ?? ""),
    })),
    runningGags: (digest.runningGags ?? []).slice(0, 6).map((g) => ({ word: scrub(g.word ?? ""), count: g.count })),
    pickTeasers: (digest.pickTeasers ?? []).slice(0, 6).map(scrub),
    dodges: (digest.dodges ?? []).slice(0, 6).map((d) => ({ reason: scrub(d.reason ?? "") })),
    stats: {
      fastest: digest.stats?.fastest ? { ms: digest.stats.fastest.ms } : undefined,
      slowest: digest.stats?.slowest ? { ms: digest.stats.slowest.ms } : undefined,
      topDodger: digest.stats?.topDodger ? { count: digest.stats.topDodger.count } : undefined,
      tapWar: digest.stats?.tapWar ? { score: digest.stats.tapWar.score } : undefined,
    },
    selfVsRoom: (digest.selfVsRoom ?? []).slice(0, 8).map((s) => ({ trait: s.trait, self: s.self, roomMean: s.roomMean })),
  };
}

/** The verbatim answers a callback may quote (alias-scrubbed). */
export function callbackQuotes(digest: NightDigest | null | undefined, aliases: readonly string[] | undefined): string[] {
  if (!digest) return [];
  return (digest.quotes ?? [])
    .map((q) => redactAliases(String(q.text ?? ""), aliases).trim())
    .filter((q) => q.length >= 8)
    .slice(0, QUOTE_MAX);
}

const PHASE_BRIEF: Record<PromptPhase, string> = {
  warmup: "Warm-up: light, social, fast. Picks, one-word shouts, self-ratings, a tap-war.",
  spicy: "Spicy: flirty, teasing, status and desire reads. Adult banter inside an R-rated envelope.",
  deep: "Deep: vulnerability, trust, old grievances, who people really are to each other.",
  dare: "Dare: social-risk only (cringe, reveals, embarrassment) — never physical danger, never illegal.",
};

/**
 * THE SECOND VOICE — few-shots are loaded from the BANK at runtime, never
 * invented here. A register taught without examples produces off-voice output
 * (the live-testing lesson): ship both voices, with both example blocks.
 */
export function groupFewShots(phase: PromptPhase, limit = 3): Prompt[] {
  return BANK.filter((p) => p.phase === phase && (p.style ?? "group") === "group" && (p.kind === "pick" || p.kind === "text" || p.kind === "rating"))
    .slice(0, limit);
}

/** 4–6 confession few-shots, phase-first then any phase, in bank order. */
export function confessionFewShots(phase: PromptPhase, limit = 5): Prompt[] {
  const all = BANK.filter((p) => p.style === "confess" || p.kind === "confess");
  const first = all.filter((p) => p.phase === phase);
  const rest = all.filter((p) => p.phase !== phase);
  return [...first, ...rest].slice(0, Math.max(4, Math.min(6, limit)));
}

function voiceBlock(input: { phase: PromptPhase; style?: PromptStyle; playerCount: number }): string[] {
  const group = groupFewShots(input.phase, 3);
  const confess = confessionFewShots(input.phase, 5);
  const asked = input.style === undefined
    ? `Write BOTH voices: about ${Math.ceil(8 / 2)} group prompts and ${Math.floor(8 / 2)} confess prompts (roughly half each).`
    : input.style === "confess"
      ? "Write CONFESSION prompts only (every object: \"style\": \"confess\", \"kind\": \"confess\")."
      : "Write GROUP prompts only (every object: \"style\": \"group\").";
  return [
    "TWO VOICES — every prompt is written in exactly ONE voice and declares it in \"style\":",
    asked,
    "GROUP VOICE (\"style\":\"group\") — the room's PERCEPTION. Addressed to the room; the player names someone else.",
    "Examples of the exact register — group voice:",
    ...group.map((p) => `  - "${p.text}"`),
    "CONFESSION VOICE (\"style\":\"confess\") — REALITY. Second person, self-report: the player answers about THEMSELVES,",
    "privately, yes/no (an optional person in this room, an optional one-line note). kind MUST be \"confess\",",
    "asksTarget MUST be false, and there is NO skip option. Start with \"Have you ever\".",
    "Examples of the exact register — confession voice:",
    ...confess.map((p) => `  - "${p.text}"`),
    "A confess prompt that reads like a group prompt (\"Who here…\", \"Point at…\") is WRONG and is discarded.",
    "A group prompt that reads like a confession (\"Have you ever…\" about yourself) is WRONG and is discarded.",
  ];
}

function systemPrompt(input: {
  phase: PromptPhase;
  playerCount: number;
  count: number;
  quotes: string[];
  callbackTarget: number;
  style?: PromptStyle;
}): string {
  const kinds = PHASE_KINDS[input.phase].join(", ");
  // Never send the unhinged tier to a provider. Prefer this phase, and only
  // use other phases if the eligible phase bank cannot supply six examples.
  const eligible = BANK.filter((p) => !UNHINGED_IDS.includes(p.id) && maxPlaceholderIndex(p.text) <= input.playerCount);
  const seeds = [...eligible.filter((p) => p.phase === input.phase), ...eligible.filter((p) => p.phase !== input.phase)].slice(0, 6);
  const lines = [
    "You write prompts for a private 18+ party game: CLOSE FRIENDS in one room answering on phones.",
    "Prompts address the GROUP about the GROUP, with flirty, teasing, roast-your-friends, inside-joke energy.",
    "Be punchy: one sentence. No disclaimers, no moralizing. Reference players only via {P1}..{Pn} placeholders.",
    `Phase: ${input.phase}. ${PHASE_BRIEF[input.phase]}`,
    `There are exactly ${input.playerCount} players, addressed only as Player 1..Player ${input.playerCount} — never real names.`,
    "Bank examples for inspiration (do not copy):",
    ...seeds.map((p) => `  - ${p.text}`),
    `Return ONE JSON array of ${input.count} objects. No prose, no markdown.`,
    ...voiceBlock({ phase: input.phase, playerCount: input.playerCount, ...(input.style !== undefined ? { style: input.style } : {}) }),
    "Each object:",
    '  "text": string, 20-160 characters, second person, a single question or dare,',
    '  "style": "group" or "confess" (see the two voices above),',
    '  "kind": one of: ' + kinds + ', ("confess" is the ONLY kind a confess-voice prompt may use)',
    '  "coding": one of: couple, friendship, trust, friction, rivalry, status, neutral,',
    '  "measures": string[] with 1-3 short signal names this prompt extracts,',
    '  "asksTarget": boolean (true when the player must name someone in the room; ALWAYS false for confessions),',
    '  "callback": boolean (see below).',
    "DATA-OR-DEAD RULE: every prompt must be directed at someone in the room (or a pair, or the group)",
    "and must extract a real signal (a directed pick, a peer rating, closeness circles, a shout, a dare outcome,",
    "or a private self-report confession).",
    "Use placeholders {P1}..{P" + input.playerCount + "} where a player is named; never write 'Player 3' inline.",
    "BANNED: favorites, zombies, desert island, untwisted 'most likely to', generic icebreakers,",
    "anything involving minors, non-consent, explicit sexual acts, real people, or illegal acts.",
    "Never ask for physical danger. Dares always allow 'I can't' plus a reason.",
  ];
  if (input.quotes.length > 0 && input.phase !== "warmup") {
    lines.push(
      `CALLBACKS: exactly ${input.callbackTarget} of the ${input.count} prompts must quote one of these earlier`,
      "answers VERBATIM inside quotation marks (copy the words exactly; never invent an answer):",
      ...input.quotes.map((q) => `  - "${q}"`),
    );
  } else {
    lines.push("Set \"callback\": false on every prompt.");
  }
  return lines.join("\n");
}

function callbackTargetFor(phase: PromptPhase, count: number, quoteCount: number): number {
  if (phase === "warmup" || quoteCount === 0) return 0;
  return Math.max(1, Math.floor(count / 3));
}

function quotedSegments(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/["“]([^"”]{8,})["”]/g)) {
    const segment = m[1]?.trim();
    if (segment) out.push(segment);
  }
  return out;
}

/**
 * Callback integrity: any quoted segment in a generated prompt must be
 * VERBATIM from the digest. An invented quote kills the candidate (spec §6:
 * "quote verbatim, never invent").
 */
export function checkCallbackIntegrity(
  raw: unknown,
  quotes: readonly string[],
): { ok: true; isCallback: boolean } | { ok: false; reason: GenerateDrop; detail?: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "schema" };
  const candidate = raw as { text?: unknown; callback?: unknown };
  const text = typeof candidate.text === "string" ? candidate.text : "";
  const segments = quotedSegments(text);
  const matched = quotes.filter((q) => containsVerbatimQuote(text, q));
  if (segments.length > 0) {
    for (const segment of segments) {
      const found = quotes.some((q) => q.toLowerCase().includes(segment.toLowerCase()) || containsVerbatimQuote(q, segment));
      if (!found) return { ok: false, reason: "invented-quote", detail: segment.slice(0, 60) };
    }
  }
  if (candidate.callback === true) {
    if (matched.length === 0) return { ok: false, reason: "no-quote", detail: "callback without a verbatim quote" };
    return { ok: true, isCallback: true };
  }
  return { ok: true, isCallback: matched.length > 0 };
}

/**
 * Keep ~1 in 3 callbacks from spicy onward. When the model under-delivers we
 * append a REAL quote to a plain text prompt (still ≤160 chars) instead of
 * inventing one. Deterministic: first eligible prompts, digest order.
 */
export function ensureCallbackShare(
  prompts: Prompt[],
  quotes: readonly string[],
  target: number,
  isCallback: (p: Prompt) => boolean,
  maxChars = 160,
): Prompt[] {
  if (target <= 0 || quotes.length === 0) return prompts;
  let have = prompts.filter(isCallback).length;
  if (have >= target) return prompts;
  const out = [...prompts];
  let quoteIndex = 0;
  for (let i = 0; i < out.length && have < target; i += 1) {
    const prompt = out[i]!;
    if (isCallback(prompt)) continue;
    if (prompt.kind !== "text") continue;
    const quote = quotes[quoteIndex % quotes.length]!;
    quoteIndex += 1;
    const suffix = `Callback: someone here said "${quote}" — defend or deny it.`;
    const base = prompt.text.trim();
    const joiner = /[.?!]$/.test(base) ? " " : ". ";
    const text = `${base}${joiner}${suffix}`;
    if (text.length > maxChars) continue;
    out[i] = { ...prompt, text };
    have += 1;
  }
  return out;
}

function fallbackReason(reason: ProviderFailReason | undefined): ProviderFailReason {
  return reason ?? "http";
}

/**
 * ONE Grok call → filtered, deduped, data-or-dead-compliant prompts.
 * Returns `[]` (never throws) when the lane is silent or the output is unusable.
 */
export async function generateBatch(input: GenerateBatchInput): Promise<Prompt[]> {
  const report = await generateBatchReport(input);
  return report.prompts;
}

export async function generateBatchReport(input: GenerateBatchInput): Promise<GenerateBatchReport> {
  const provider = input.provider ?? null;
  const empty: GenerateBatchReport = {
    prompts: [],
    lane: "bank",
    candidates: 0,
    accepted: 0,
    dropped: [],
    callbacks: 0,
    called: false,
  };
  if (!provider || !provider.canGenerate()) {
    return { ...empty, reason: "no-key" };
  }

  const count = Math.max(1, Math.min(20, input.count ?? DEFAULT_COUNT));
  const room = input.room ?? "room-unknown";
  const quotes = callbackQuotes(input.digest, input.aliases);
  const cbTarget = callbackTargetFor(input.phase, count, quotes.length);
  const digestPayload = pseudonymizedDigest(input.digest, input.aliases);

  try {
    const { result, value } = await provider.grokJson({
      room,
      purpose: "generate",
      model: provider.modelFor("grok", "generate"),
      messages: [
        { role: "system", content: systemPrompt({ phase: input.phase, playerCount: input.playerCount, count, quotes,
          callbackTarget: cbTarget, ...(input.style !== undefined ? { style: input.style } : {}) }) },
        {
          role: "user",
          content: JSON.stringify({
            phase: input.phase,
            players: input.playerCount,
            count,
            ...(input.style !== undefined ? { style: input.style } : { styleMix: "group and confess, roughly half each" }),
            nightDigest: digestPayload,
            callbacksWanted: cbTarget,
          }),
        },
      ],
      temperature: 0.9,
      maxTokens: 2_400,
      aliases: input.aliases,
    });

    if (!result.ok) return { ...empty, reason: fallbackReason(result.reason), called: true };

    const raws = Array.isArray(value)
      ? value
      : Array.isArray((value as { prompts?: unknown }).prompts)
        ? ((value as { prompts: unknown[] }).prompts)
        : [];
    if (raws.length === 0) return { ...empty, reason: "empty", called: true };

    // Pre-pass 1: callbacks must be real — an invented quote is never shown.
    // Pre-pass 2: a rating round needs a readable trait (the Prompt contract
    // has no trait field yet), so stamp `trait:<id>` from the wording or drop.
    const dropped: GenerateBatchReport["dropped"] = [];
    const kept: unknown[] = [];
    for (let i = 0; i < raws.length; i += 1) {
      const verdict = checkCallbackIntegrity(raws[i], quotes);
      if (!verdict.ok) {
        dropped.push({ index: i, reason: verdict.reason, detail: verdict.detail });
        continue;
      }
      const candidate = { ...(raws[i] as Record<string, unknown>) };
      const kind = normalizeKind(candidate.kind);
      if (kind === "rating") {
        const text = typeof candidate.text === "string" ? candidate.text : "";
        const trait = inferTrait(text);
        if (!trait) {
          dropped.push({ index: i, reason: "no-trait", detail: "rating with no readable trait" });
          continue;
        }
        const measures = normalizeMeasures(candidate.measures);
        candidate.measures = [`${TRAIT_MEASURE_PREFIX}${trait}`, ...measures.filter((m) => !m.startsWith(TRAIT_MEASURE_PREFIX))];
      }
      kept.push(candidate);
    }

    const bankTexts = input.bankTexts ?? BANK.map((p) => p.text);
    const filtered = filterCandidates(kept, {
      phase: input.phase,
      playerCount: input.playerCount,
      usedIds: input.usedIds ?? [],
      usedTexts: bankTexts,
      idPrefix: "grok",
      limit: count,
      ...(input.style !== undefined ? { style: input.style } : {}),
    });

    const accepted: Prompt[] = filtered.prompts;
    // A prompt is a callback when it carries a real digest quote verbatim —
    // detection by content, not by the model's own flag (flags lie).
    const isCallback = (p: Prompt) => quotes.some((q) => containsVerbatimQuote(p.text, q));
    const topped = ensureCallbackShare(accepted, quotes, cbTarget, isCallback);

    return {
      prompts: topped,
      lane: "grok",
      candidates: raws.length,
      accepted: topped.length,
      dropped: [
        ...dropped,
        ...filtered.dropped.map((d) => ({ index: d.index, reason: d.reason as GenerateDrop, detail: d.detail })),
      ],
      callbacks: topped.filter(isCallback).length,
      called: true,
    };
  } catch {
    // Never throw into the lobby loop — the bank is always there.
    return { ...empty, reason: "network", called: true };
  }
}
