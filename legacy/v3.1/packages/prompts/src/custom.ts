// packages/prompts/src/custom.ts
// HOST CUSTOM PROMPTS (spec §6): lobby only, ≤10 lines, ≤160 chars each,
// optional `spicy:` / `deep:` / `dare:` (or `warmup:`) prefix — tonight's bank
// only, deleted with the room. The DATA-OR-DEAD rule applies to the host too:
// a line that extracts no signal is rejected with a reason the host can see.
import type { Prompt, RoundKind } from "../../shared/src/contracts.ts";
import {
  checkBanned,
  checkHardBlocked,
  checkDataOrDead,
  isRoomDirected,
  normalizeMeasures,
  MAX_PROMPT_CHARS,
} from "./filter.ts";
import type { PromptPhase } from "./bank/index.ts";
import { inferTrait, TRAIT_MEASURE_PREFIX } from "./trait.ts";

export const MAX_HOST_LINES = 10;
export const MAX_HOST_CHARS = MAX_PROMPT_CHARS;
/** No prefix → spicy slot (an 18+ party host writing custom lines is aiming there). */
export const DEFAULT_HOST_PHASE: PromptPhase = "spicy";

const PREFIX_RE = /^\s*(spicy|deep|dare|warmup)\s*:\s*/i;

export interface HostPromptRejection {
  line: string;
  reason: "empty" | "too-long" | "too-many" | "banned" | "hard-block" | "not-room-directed" | "measures";
  detail?: string;
}

export interface HostPromptResult {
  prompts: Prompt[];
  rejected: HostPromptRejection[];
}

/** Deterministic kind inference for a host line. */
export function inferKind(text: string, phase: PromptPhase): RoundKind {
  if (phase === "dare") {
    if (/\b(two of you|you two|the pair|pair up)\b/i.test(text)) return "pair_dare";
    return "dare";
  }
  if (/\b(circles?|closeness|how close)\b/i.test(text)) return "ios";
  if (/\b(tap|tap[- ]war|fastest finger)\b/i.test(text)) return "minigame";
  if (/\b(rate|rating|\b1\s*[–\-to]{1,4}\s*10\b|out of 10)\b/i.test(text)) return "rating";
  if (/\b(shout|one word|yell)\b/i.test(text)) return "shout";
  if (/\b(point|pick|choose|who here|nominate|vote)\b/i.test(text)) return "pick";
  return "text";
}

/** Host lines can only name a target with a {Pn} placeholder — the host has no roster. */
function asksTargetFor(kind: RoundKind, text: string): boolean {
  if (kind === "pick" || kind === "ios") return true;
  return /\{P\d{1,2}\}/.test(text);
}

function measuresFor(kind: RoundKind, text: string): string[] {
  switch (kind) {
    case "pick":
      return ["directed pick", "pick overlap"];
    case "ios":
      return ["closeness circles"];
    case "rating": {
      const trait = inferTrait(text);
      return trait ? [`${TRAIT_MEASURE_PREFIX}${trait}`, "peer/self trait rating"] : ["trait rating"];
    }
    case "shout":
      return ["shout word", "running gag"];
    case "minigame":
      return ["minigame score"];
    case "dare":
      return ["dare compliance", "pass reason"];
    case "pair_dare":
      return ["debrief similarity"];
    case "debrief":
      return ["pair debrief"];
    default:
      return ["text tags"];
  }
}

/**
 * Parse host lines into tonight's prompts. Order is preserved; the first 10
 * usable lines win and the rest are reported (never silently dropped).
 */
export function parseHostLines(lines: readonly string[], opts: { playerCount?: number } = {}): HostPromptResult {
  const prompts: Prompt[] = [];
  const rejected: HostPromptRejection[] = [];
  let index = 0;

  for (const rawLine of lines) {
    if (typeof rawLine !== "string") continue;
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (index >= MAX_HOST_LINES) {
      rejected.push({ line, reason: "too-many", detail: `max ${MAX_HOST_LINES} lines` });
      continue;
    }
    const prefix = line.match(PREFIX_RE);
    const phase: PromptPhase = prefix ? (prefix[1]!.toLowerCase() as PromptPhase) : DEFAULT_HOST_PHASE;
    const text = (prefix ? line.slice(prefix[0].length) : line).trim();
    if (text.length === 0) {
      rejected.push({ line, reason: "empty" });
      continue;
    }
    if (text.length > MAX_HOST_CHARS) {
      rejected.push({ line, reason: "too-long", detail: `${text.length} > ${MAX_HOST_CHARS}` });
      continue;
    }
    const banned = checkBanned(text);
    if (banned) {
      rejected.push({ line, reason: "banned", detail: banned.rule.why });
      continue;
    }
    const hard = checkHardBlocked(text);
    if (hard) {
      rejected.push({ line, reason: "hard-block", detail: hard.rule.why });
      continue;
    }
    const kind = inferKind(text, phase);
    const measures = normalizeMeasures(measuresFor(kind, text));
    const coding: Prompt["coding"] =
      kind === "pair_dare" ? "couple" : kind === "dare" ? "friendship" : kind === "ios" ? "friendship" : "neutral";
    if (!isRoomDirected({ kind, text })) {
      rejected.push({
        line,
        reason: "not-room-directed",
        detail: "name someone in the room (e.g. 'Who here…', 'Rate {P2}…') so it measures something",
      });
      continue;
    }
    const dead = checkDataOrDead({ kind, text, coding, measures });
    if (!dead.ok) {
      rejected.push({ line, reason: "measures", detail: dead.detail });
      continue;
    }
    index += 1;
    prompts.push({
      id: `host-${index}`,
      source: "host",
      phase,
      kind,
      text,
      measures,
      coding,
      asksTarget: asksTargetFor(kind, text),
    });
  }

  // A rating prompt with no readable trait would be unrenderable → give it a
  // neutral-but-real trait stamp instead of dropping the host's words.
  const stamped = prompts.map((p) =>
    p.kind === "rating" && !p.measures.some((m) => m.startsWith(TRAIT_MEASURE_PREFIX))
      ? { ...p, measures: [`${TRAIT_MEASURE_PREFIX}${inferTrait(p.text) ?? "warmth"}`, ...p.measures] }
      : p,
  );

  return { prompts: stamped, rejected };
}
