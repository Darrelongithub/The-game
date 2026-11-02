// packages/prompts/src/bank/live/index.ts
// THE LIVE-MOMENT BANK — "spotlight" and "verdict" seeds (ROUND 3).
//
// These are NOT more questions. They are group theatre:
//   spotlight — a subject is chosen and everyone else answers a question about
//               the live moment. The subject gets a COVER round (a decoy
//               question or an idle screen) and never sees the real prompt.
//   verdict   — the room argues for 90s with phones face-down, then everyone
//               secretly picks at the same time. The reveal is a group moment.
//
// DATA-OR-DEAD still applies (spec §6):
//   spotlight seeds are TAGGABLE TEXTS about the subject (normal tagging) or
//               NAME-CLUSTER prompts (who did they look at). Name clusters are
//               never a formal engine claim — live observation is fun, not
//               evidence — they only fuel ONE digest teaser line per round.
//   verdict   seeds are normal coded picks and feed consensus / one-sided /
//               pick overlap like any other pick.
//
// The bank is code-first and offline: no provider ever generates a live seed.
import { readFileSync } from "node:fs";
import { HEAT_ORDER, type Prompt, type PromptCoding } from "../../../../shared/src/contracts.ts";
import { spicyTierEnabled, type PromptPhase } from "../index.ts";

export type LiveKind = "spotlight" | "verdict";

/** A live seed as authored in JSON. `phase` = the EARLIEST heat phase it may
 *  appear in (a seed stays eligible for every later phase of the night). */
export interface LiveSeed {
  id: string;
  phase: PromptPhase;
  kind: LiveKind;
  /** `{S}` = the subject's alias, substituted server-side for display only. */
  text: string;
  coding: PromptCoding;
  measures: string[];
  /** SPICY_TIER gate (spec §6: the unhinged tier), default false */
  spicy: boolean;
  /** spotlight only: does this prompt produce a name cluster or free text? */
  cluster?: "name" | "text";
  /** verdict only: couple-coded verdicts get confetti on the land beat */
  couple?: boolean;
}

/** The subject's COVER round. The server picks one at random per spotlight, so
 *  a repeat subject cannot pattern-match the disguise. */
export interface DecoySeed {
  id: string;
  text: string;
  kind: "text";
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as T;
}

export const RAW_LIVE: { spotlight: LiveSeed[]; verdict: LiveSeed[]; decoys: DecoySeed[] } = {
  spotlight: readJson<LiveSeed[]>("spotlight.json"),
  verdict: readJson<LiveSeed[]>("verdict.json"),
  decoys: readJson<DecoySeed[]>("decoys.json"),
};

/** Every decoy the cover round can wear. */
export const DECOYS: readonly DecoySeed[] = RAW_LIVE.decoys;

/** Idle cover screen text — used when the subject gets no question at all. */
export const SPOTLIGHT_IDLE_LINE = "Nothing for you right now. Soak it in.";

const HEAT_INDEX = (phase: PromptPhase): number => HEAT_ORDER.indexOf(phase);

export interface LiveOptions {
  /** SPICY_TIER (default: resolved like the rest of the bank) */
  spicy?: boolean;
  /** Ids already used tonight — live seeds never repeat in a night. */
  excludeIds?: ReadonlySet<string> | readonly string[];
}

function excluded(opts: LiveOptions): Set<string> {
  const raw = opts.excludeIds;
  if (!raw) return new Set();
  return raw instanceof Set ? (raw as Set<string>) : new Set(raw as readonly string[]);
}

/**
 * Eligible live seeds for a heat phase: everything authored for this phase or
 * any EARLIER one (spotlight runs from warmup on, verdict from spicy on), minus
 * ids already used tonight, minus the spicy-tier rows when the tier is off.
 * Deterministic order = authored order.
 */
export function liveSeeds(kind: LiveKind, phase: PromptPhase, opts: LiveOptions = {}): LiveSeed[] {
  const spicy = opts.spicy ?? spicyTierEnabled();
  const used = excluded(opts);
  const from = HEAT_INDEX(phase);
  return RAW_LIVE[kind].filter((seed) =>
    HEAT_INDEX(seed.phase) >= 0 && HEAT_INDEX(seed.phase) <= from &&
    !used.has(seed.id) && (spicy || !seed.spicy));
}

/** True when this phase is allowed to host the kind at all (spec §3 flow). */
export function liveKindInPhase(kind: LiveKind, phase: PromptPhase): boolean {
  // spotlight: from warmup on. verdict: from spicy on (after the room warms up).
  return kind === "spotlight" ? HEAT_INDEX(phase) >= HEAT_ORDER.indexOf("warmup")
    : HEAT_INDEX(phase) >= HEAT_ORDER.indexOf("spicy");
}

/** A live seed in Prompt shape, so the server can keep one Definition type.
 *  `{S}` is swapped for the subject alias at round start (see game.ts). */
export function livePrompt(seed: LiveSeed): Prompt {
  return {
    id: seed.id,
    source: "bank",
    phase: seed.phase,
    kind: seed.kind,
    text: seed.text,
    measures: [...seed.measures],
    coding: seed.coding,
    asksTarget: true,
  };
}

export function liveCounts(opts: LiveOptions = {}): Record<LiveKind, number> {
  const spicy = opts.spicy ?? spicyTierEnabled();
  const count = (seeds: LiveSeed[]): number => seeds.filter((s) => spicy || !s.spicy).length;
  return { spotlight: count(RAW_LIVE.spotlight), verdict: count(RAW_LIVE.verdict) };
}
