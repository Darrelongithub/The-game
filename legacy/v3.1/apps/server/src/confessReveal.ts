// apps/server/src/confessReveal.ts
// THE CONFESS REVEAL — pure, deterministic, and structurally incapable of
// leaking a no.
//
// It is handed only what a reveal may contain: an alias or nothing, a yes/no,
// an optional note. It never sees a PlayerId, so a warm reveal cannot name
// anyone even by accident, and a "no" is only ever a NUMBER.
//
//   WARM  (warmup)      → counts only. No names, no hints.
//   SPICY (spicy/deep)  → YES answers attributed by alias; notes attributed.
//                         A note attached to a NO stays anonymous, forever:
//                         "NOs are never attributed in any tier" outranks
//                         "notes are attributed at spicy".
import type { ConfessRevealView, Phase } from "../../../packages/shared/src/contracts.ts";

export type RevealTier = "warm" | "spicy";

/** Warmup is the warm tier; everything hotter reveals with attribution. */
export const confessTierFor = (phase: Phase): RevealTier => (phase === "warmup" ? "warm" : "spicy");

export interface ConfessAnswerLine {
  /** display alias ONLY — never a PlayerId */
  alias: string;
  yes: boolean;
  note?: string;
}

export function buildConfessReveal(input: {
  tier: RevealTier;
  /** players in the room the question was asked of */
  of: number;
  answers: readonly ConfessAnswerLine[];
}): ConfessRevealView {
  const yes = input.answers.filter((a) => a.yes);
  const no = input.answers.length - yes.length;
  const view: ConfessRevealView = {
    tier: input.tier,
    yes: yes.length,
    no,
    of: input.of,
    missing: Math.max(0, input.of - input.answers.length),
  };
  if (input.tier === "spicy") {
    view.attributed = yes.map((a) => ({
      alias: a.alias,
      ...(a.note !== undefined && a.note.trim().length > 0 ? { note: a.note } : {}),
    }));
  }
  // Notes: a yes-note at spicy rides on `attributed` (named, once). Everything
  // else — every warm note, and ANY note attached to a no, in any tier — is
  // anonymous. A note must never become the loophole that names a no.
  const notes: NonNullable<ConfessRevealView["notes"]> = [];
  for (const answer of input.answers) {
    if (answer.note === undefined || answer.note.trim().length === 0) continue;
    if (input.tier === "spicy" && answer.yes) continue;
    notes.push({ text: answer.note });
  }
  if (notes.length > 0) view.notes = notes;
  return view;
}

/** The line under the count. Counts only — it never says who said no. */
export const confessSummary = (view: ConfessRevealView): string =>
  view.tier === "warm"
    ? `${view.yes} of ${view.of} said yes.`
    : `${view.yes} of ${view.of} said yes. ${view.missing > 0 ? `${view.missing} stayed quiet.` : ""}`.trim();
