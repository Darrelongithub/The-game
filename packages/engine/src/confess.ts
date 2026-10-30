// packages/engine/src/confess.ts
// CONFESS ROUNDS — THE SECOND VOICE. Pure, deterministic, zero I/O.
//
// Group rounds ("Who here…") capture the room's PERCEPTION. Confess rounds
// ("Have you ever…") capture REALITY: the same question to every player,
// answered privately about themselves, as yes/no + optional target + optional
// note. This module owns the deterministic machinery around them:
//
//   • the 50/50 style selector — group vs confess question rounds, seeded by
//     the round index and balanced to STYLE_MIX (error diffusion: the count can
//     never drift more than one round from the mix);
//   • twin planning — a confess seed may be scheduled 1–3 rounds after the
//     group seed on the SAME topic (perception, then reality);
//   • aggregation — counts, missing answers, yes-rates and the pair component;
//   • the mismatch line — the payoff. It may say the room was sure and how many
//     people said yes. It may NEVER expose a "no", in any wording, ever.
import {
  STYLE_MIX,
  TWIN_WINDOW,
  type LogRecord,
  type PlayerId,
  type PromptStyle,
  type RoomMeta,
} from "../../shared/src/contracts.ts";
import { clamp01, pseudoOf } from "./internal.ts";
import { mulberry32 } from "./rng.ts";

// ---------------------------------------------------------------------------
// THE 50/50 — style selection for QUESTION rounds
// ---------------------------------------------------------------------------

/** Group-style and confess-style QUESTION rounds served so far tonight. */
export interface StyleServed { group: number; confess: number }

export const emptyStyleServed = (): StyleServed => ({ group: 0, confess: 0 });
export const questionRoundsServed = (served: StyleServed): number => served.group + served.confess;

export const recordStyle = (served: StyleServed, style: PromptStyle): StyleServed =>
  style === "confess"
    ? { group: served.group, confess: served.confess + 1 }
    : { group: served.group + 1, confess: served.confess };

/**
 * Which voice does the next QUESTION round speak in?
 *
 * Error diffusion against STYLE_MIX: the next round's style is forced whenever
 * the running counts would otherwise drift more than one round from the mix;
 * inside that band the choice is a seeded draw. The result is both balanced
 * (±1 for the whole night) and replayable — `seed` is the round index.
 */
export function chooseStyle(served: StyleServed, seed: number): PromptStyle {
  const share = clamp01(STYLE_MIX.confess);
  const total = questionRoundsServed(served) + 1;
  const idealConfess = share * total;
  const deficit = idealConfess - served.confess; // >0 → behind on confessions
  if (deficit >= 1) return "confess";
  if (deficit <= 0) return "group";
  return mulberry32(seed >>> 0)() < deficit ? "confess" : "group";
}

/** Deal `n` styles as the server would, one round at a time (test/replay aid). */
export function planStyles(n: number, seedBase = 1, served: StyleServed = emptyStyleServed()): PromptStyle[] {
  const out: PromptStyle[] = [];
  let state = served;
  for (let i = 0; i < n; i++) {
    const style = chooseStyle(state, seedBase + i);
    out.push(style);
    state = recordStyle(state, style);
  }
  return out;
}

/** |group − confess| over a served pair — the ±1 balance assertion. */
export const styleDrift = (served: StyleServed): number => Math.abs(served.group - served.confess);

// ---------------------------------------------------------------------------
// TWIN SCHEDULING — perception, then reality
// ---------------------------------------------------------------------------

/** How often a group twin gets its confess twin scheduled (occasionally, not always). */
export const TWIN_RATE = 0.6;

export interface TwinPlan {
  /** the group seed that was just served */
  groupPromptId: string;
  /** the confess seed on the same topic */
  confessPromptId: string;
  /** round index at which the confess twin is due (rounds are 1-based) */
  dueAt: number;
}

export interface TwinInput {
  /** index of the round that just served the group seed */
  groupRoundIndex: number;
  groupPromptId: string;
  confessPromptId: string;
  /** deterministic seed — production uses the group round's index */
  seed: number;
  /** at most one twin per phase: the director is not a machine gun */
  scheduledThisPhase: boolean;
}

/**
 * Schedule the confess twin 1–3 rounds after its group twin, at most once per
 * phase, only sometimes (TWIN_RATE). Deterministic: same input, same plan.
 */
export function planTwin(input: TwinInput): TwinPlan | undefined {
  if (input.scheduledThisPhase) return undefined;
  const seed = input.seed >>> 0;
  if (mulberry32(seed ^ 0x51ed270b)() >= TWIN_RATE) return undefined;
  const span = TWIN_WINDOW.max - TWIN_WINDOW.min + 1;
  const offset = TWIN_WINDOW.min + Math.floor(mulberry32(seed ^ 0x2545f491)() * span);
  return { groupPromptId: input.groupPromptId, confessPromptId: input.confessPromptId, dueAt: input.groupRoundIndex + offset };
}

/** Is a scheduled twin due at the round index now being dealt? */
export const twinDue = (plan: TwinPlan, roundIndex: number): boolean => roundIndex >= plan.dueAt;

// ---------------------------------------------------------------------------
// ANSWERS — yes/no, optional target, optional note. Missing stays missing.
// ---------------------------------------------------------------------------

export interface ConfessAnswer {
  roundId: string;
  promptId: string;
  playerId: PlayerId;
  yes: boolean;
  target?: PlayerId;
  note?: string;
  at: number;
}

/** Every confess answer in the log, in log order. Decoys never answer. */
export function confessAnswers(log: readonly LogRecord[]): ConfessAnswer[] {
  const out: ConfessAnswer[] = [];
  for (const rec of log) {
    if (rec.decoy === true) continue;
    if (rec.value.kind !== "confess") continue;
    out.push({
      roundId: rec.roundId,
      promptId: rec.promptId,
      playerId: rec.playerId,
      yes: rec.value.yes,
      ...(rec.value.target !== undefined ? { target: rec.value.target } : {}),
      ...(rec.value.note !== undefined ? { note: rec.value.note } : {}),
      at: rec.at,
    });
  }
  return out;
}

export interface ConfessTally {
  /** how many players said yes */
  yes: number;
  /** how many players said no — COUNT ONLY, never who */
  no: number;
  /** answers actually received (yes + no) */
  answered: number;
  /** players in the room this round was asked of */
  of: number;
  /** phones that never answered: ∉ yes, ∉ no. NEVER folded into "no". */
  missing: number;
}

/** One confess round's aggregate. Missing answers are counted, not converted. */
export function confessTally(log: readonly LogRecord[], roundId: string, meta: RoomMeta): ConfessTally {
  let yes = 0;
  let no = 0;
  for (const answer of confessAnswers(log)) {
    if (answer.roundId !== roundId) continue;
    if (answer.yes) yes++;
    else no++;
  }
  const of = meta.players.length;
  const answered = yes + no;
  return { yes, no, answered, of, missing: Math.max(0, of - answered) };
}

/** Aggregate yes-rate across the night (0 when nobody answered). Never gating. */
export function confessYesRate(log: readonly LogRecord[]): number {
  const answers = confessAnswers(log);
  if (answers.length === 0) return 0;
  return answers.filter((a) => a.yes).length / answers.length;
}

/** A room that keeps saying yes is warm — a temperature read, never a gate. */
export const roomWarmth = (log: readonly LogRecord[]): number => clamp01(confessYesRate(log));

// ---------------------------------------------------------------------------
// THE PAIR COMPONENT — "confession"
// ---------------------------------------------------------------------------

/**
 * Self-report evidence for the pair (a, b): of the confess answers a or b gave
 * WITH a target, what share named the other? 0 when neither ever aimed one.
 *
 * EVIDENCE, never ground truth: the caller adds "confession" to
 * `componentsUsed` (so it counts toward the ≥3-independent-types rule) but the
 * pair formula gives it weight 0 — it is never sufficient alone.
 */
export function confessionComponent(
  log: readonly LogRecord[],
  a: PlayerId,
  b: PlayerId,
): { value: number; used: boolean } {
  let hits = 0;
  let total = 0;
  for (const answer of confessAnswers(log)) {
    if (answer.target === undefined) continue;
    if (answer.playerId !== a && answer.playerId !== b) continue;
    total++;
    if ((answer.playerId === a && answer.target === b) || (answer.playerId === b && answer.target === a)) hits++;
  }
  return { value: total === 0 ? 0 : clamp01(hits / total), used: total > 0 };
}

// ---------------------------------------------------------------------------
// THE PAYOFF — perception vs confession
// ---------------------------------------------------------------------------

/** A group seed and the confess seed that lives on the same topic. */
export interface TwinLink {
  groupPromptId: string;
  confessPromptId: string;
}

export interface ConfessMismatch {
  groupRoundId: string;
  confessRoundId: string;
  /** who the room was sure about */
  target: PlayerId;
  /** how many people said yes to themselves */
  yes: number;
  of: number;
  /** engine-written, pseudonymous: "The room was sure it was Player 3. Two people just said yes." */
  line: string;
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"] as const;
const numberWord = (n: number): string => NUMBER_WORDS[n] ?? String(n);

/**
 * Where the ROOM'S PERCEPTION and the ROOM'S REALITY disagree.
 *
 * Mismatch = the group twin's round produced a strict-majority answer about one
 * player (the room was "sure"), and at least two people then said yes about
 * themselves on the twin topic.
 *
 * HARD RULE: the line says what the room said and how many said yes. It never
 * says who said no, how many said no, or anything that could single a "no" out.
 */
export function confessMismatches(
  log: readonly LogRecord[],
  meta: RoomMeta,
  links: readonly TwinLink[],
): ConfessMismatch[] {
  const out: ConfessMismatch[] = [];
  for (const link of links) {
    const groupRecords = log.filter((rec) => rec.promptId === link.groupPromptId && rec.value.kind === "pick" && rec.decoy !== true);
    const confessRecords = log.filter((rec) => rec.promptId === link.confessPromptId && rec.value.kind === "confess" && rec.decoy !== true);
    if (groupRecords.length === 0 || confessRecords.length === 0) continue;
    const counts = new Map<PlayerId, number>();
    for (const rec of groupRecords) {
      if (rec.value.kind !== "pick") continue;
      counts.set(rec.value.target, (counts.get(rec.value.target) ?? 0) + 1);
    }
    let target: PlayerId | undefined;
    let votes = 0;
    for (const [id, count] of counts) {
      if (count > votes || (count === votes && (target === undefined || id < target))) { target = id; votes = count; }
    }
    if (target === undefined || votes < 2 || votes * 2 <= groupRecords.length) continue;
    const yes = confessRecords.filter((rec) => rec.value.kind === "confess" && rec.value.yes).length;
    if (yes < 2) continue;
    const roundIds = [...new Set(confessRecords.map((rec) => rec.roundId))];
    out.push({
      groupRoundId: groupRecords[0]!.roundId,
      confessRoundId: roundIds[0] ?? "",
      target,
      yes,
      of: confessRecords.length,
      line: `The room was sure it was ${pseudoOf(meta, target)}. ${numberWord(yes).replace(/^./, (c) => c.toUpperCase())} people just said yes.`,
    });
  }
  return out;
}
