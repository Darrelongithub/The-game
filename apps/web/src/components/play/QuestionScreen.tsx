"use client";
// components/play/QuestionScreen.tsx — THE phone screen.
//
// THE WHOLE SCREEN:
//   • ONE question, big, at the top.
//   • One small grey line under it: "About Wanjiru. They won't see this."
//   • The answer controls, below.
//   • Nothing else.
//
// A pick is FORCED — there is no skip, and you are never in your own list.
import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { PlayerId, ResponseValue, RoomView, RoundView } from "@shared/contracts.ts";
import { DARE_REASON_MAX_CHARS, SHORT_TEXT_MAX_CHARS, TEXT_MAX_CHARS } from "@shared/contracts.ts";
import { GlowButton } from "@/components/GlowButton";

const TRAITS: { key: NonNullable<RoundView["trait"]>; label: string }[] = [
  { key: "loyalty", label: "Loyal" },
  { key: "chaos", label: "Chaotic" },
  { key: "reliability", label: "Reliable" },
  { key: "warmth", label: "Warm" },
  { key: "honesty", label: "Honest" },
  { key: "spice", label: "Hot" },
];

export function QuestionScreen({
  round,
  view,
  you,
  onSubmit,
}: {
  round: RoundView;
  view: RoomView;
  you: PlayerId | null;
  onSubmit: (value: ResponseValue) => Promise<boolean>;
}) {
  const [text, setText] = useState("");
  const [dareReason, setDareReason] = useState("");
  // Tapping "I can't do it" does not end it: the reason is the answer.
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A new question resets the answer controls.
  useEffect(() => {
    setText("");
    setDareReason("");
    setDeclining(false);
    setSent(false);
    setError(null);
  }, [round.roundId, round.segmentId]);

  const aliasOf = useMemo(() => {
    const map = new Map<PlayerId, string>();
    for (const player of view.players) map.set(player.id, player.alias);
    return (id: PlayerId): string => map.get(id) ?? "someone";
  }, [view.players]);

  const pickable = useMemo(() => {
    const allowed = new Set(view.pickOptions ?? view.players.map((p) => p.id));
    return view.players.filter((player) => allowed.has(player.id) && player.id !== you);
  }, [view.players, view.pickOptions, you]);

  const answered = round.youSubmitted || sent;

  const send = async (value: ResponseValue): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const ok = await onSubmit(value);
      if (ok) setSent(true);
      else setError("That answer did not send. Try again.");
    } finally {
      setBusy(false);
    }
  };

  /* ---- a look chain stage this phone only WATCHES ---- */
  if (round.passive) {
    return (
      <main className="screen relative flex min-h-[100dvh] flex-col items-center px-5 pt-10 pb-8">
        <motion.div
          key={round.roundId + round.segmentId}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.22 }}
          className="flex w-full max-w-lg flex-1 flex-col items-center gap-6"
        >
          <h1
            className="text-center font-display font-bold leading-[1.05] text-white"
            style={{ fontSize: "clamp(1.9rem, 7.4vw, 3.2rem)" }}
            data-testid="question"
          >
            {round.promptText}
          </h1>
          <p className="text-center text-[13px] text-white/40" data-testid="question-note">
            {round.note}
          </p>
        </motion.div>
      </main>
    );
  }

  /* ---- the answer controls, per kind ---- */

  const controls = (() => {
    switch (round.kind) {
      case "pick":
        return (
          <ul className="flex flex-col gap-2" data-testid="pick-list">
            {pickable.map((player) => (
              <li key={player.id}>
                <button
                  type="button"
                  disabled={answered || busy}
                  onClick={() => void send({ kind: "pick", target: player.id })}
                  className="min-h-[48px] w-full rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-left text-base text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
                  data-testid="pick-option"
                >
                  {player.alias}
                </button>
              </li>
            ))}
          </ul>
        );

      case "rating": {
        const trait = round.trait ?? "chaos";
        const label = TRAITS.find((t) => t.key === trait)?.label ?? "Honest";
        return (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap justify-center gap-2" role="group" aria-label={`${label}, 1 to 10`}>
              {Array.from({ length: 10 }, (_, index) => index + 1).map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={answered || busy}
                  onClick={() => void send({ kind: "rating", trait, about: round.aboutSelf ? "self" : (round.subjectId ?? "self"), value })}
                  className="min-h-[48px] min-w-[48px] rounded-2xl border border-white/15 bg-white/5 text-lg text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
                >
                  {value}
                </button>
              ))}
            </div>
            <p className="text-center text-xs text-white/45">1 · {label.toLowerCase()} · 10</p>
          </div>
        );
      }

      case "pair_vote": {
        const pair = round.pair ?? [view.players[0]?.id ?? "", view.players[1]?.id ?? ""];
        const label = `${aliasOf(pair[0]!)} & ${aliasOf(pair[1]!)}`;
        return (
          <div className="flex flex-col gap-3">
            <p className="text-center text-sm text-white/70">{label}</p>
            <div className="flex flex-wrap justify-center gap-2" role="group" aria-label="Would they make a good couple?">
              {[1, 2, 3, 4, 5].map((value) => (
                <button
                  key={value}
                  type="button"
                  disabled={answered || busy}
                  onClick={() => void send({ kind: "pair_vote", pair, value })}
                  className="min-h-[48px] min-w-[48px] rounded-2xl border border-white/15 bg-white/5 text-lg text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
                >
                  {value}
                </button>
              ))}
            </div>
            <p className="text-center text-xs text-white/45">1 · no way · 5 · obviously</p>
          </div>
        );
      }

      case "pair_pick": {
        const options = round.options ?? [];
        return (
          <ul className="flex flex-col gap-2" data-testid="pair-options">
            {options.map((option) => (
              <li key={option.id}>
                <button
                  type="button"
                  disabled={answered || busy}
                  onClick={() => void send({ kind: "pair_pick", pair: option.members })}
                  className="min-h-[48px] w-full rounded-2xl border border-white/15 bg-white/5 px-4 py-3 text-left text-base text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
                >
                  {option.label}
                </button>
              </li>
            ))}
          </ul>
        );
      }

      case "dare":
        // Two answers, in order: you did it, or you did not — and if you did
        // not, you say why. No third way out, no pass button sitting below.
        return (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              disabled={answered || busy}
              onClick={() => void send({ kind: "dare", status: "done" })}
              className="min-h-[48px] w-full rounded-2xl bg-lime-accent px-4 py-3 text-base font-bold text-black disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
              data-testid="dare-done"
            >
              I did it
            </button>
            {declining ? (
              <div className="flex flex-col gap-2" data-testid="dare-why">
                <textarea
                  className="field min-h-[84px]"
                  value={dareReason}
                  maxLength={DARE_REASON_MAX_CHARS}
                  disabled={answered || busy}
                  placeholder="Why not?"
                  onChange={(e) => setDareReason(e.target.value)}
                  aria-label="Why you cannot do it"
                  data-testid="dare-reason"
                />
                <button
                  type="button"
                  disabled={answered || busy || dareReason.trim().length === 0}
                  onClick={() => void send({ kind: "dare", status: "passed", reason: dareReason.trim() })}
                  className="min-h-[48px] w-full rounded-2xl bg-lime-accent px-4 py-3 text-base font-bold text-black disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
                  data-testid="dare-send-why"
                >
                  Send it
                </button>
              </div>
            ) : (
              <button
                type="button"
                disabled={answered || busy}
                onClick={() => setDeclining(true)}
                className="min-h-[48px] w-full rounded-2xl border border-white/20 px-4 py-3 text-base text-white disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent"
                data-testid="dare-couldnt"
              >
                I can&apos;t do it
              </button>
            )}
          </div>
        );

      case "longtext":
      case "text":
      default: {
        const max = round.kind === "longtext" ? TEXT_MAX_CHARS : SHORT_TEXT_MAX_CHARS;
        return (
          <div className="flex flex-col gap-3">
            <textarea
              className="field min-h-[120px] resize-y"
              value={text}
              maxLength={max}
              disabled={answered || busy}
              placeholder="Say it like you mean it."
              onChange={(e) => setText(e.target.value)}
              aria-label="Your answer"
              data-testid="answer-box"
            />
            <div className="flex items-center justify-between gap-3">
              <span className="tabular-nums text-xs text-white/40">{text.length}/{max}</span>
              <GlowButton
                disabled={answered || busy || !text.trim()}
                onClick={() => void send({ kind: "text", text: text.trim() })}
                data-testid="send-answer"
              >
                {busy ? "Sending…" : "Lock it in"}
              </GlowButton>
            </div>
          </div>
        );
      }
    }
  })();

  return (
    <main className="screen relative flex min-h-[100dvh] flex-col items-center px-5 pt-10 pb-8">
      <motion.div
        key={round.roundId + round.segmentId}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.22 }}
        className="flex w-full max-w-lg flex-1 flex-col items-center gap-6"
      >
        {/* ONE question, big, at the top */}
        <h1
          className="text-center font-display font-bold leading-[1.05] text-white"
          style={{ fontSize: "clamp(1.9rem, 7.4vw, 3.2rem)" }}
          data-testid="question"
        >
          {round.promptText}
        </h1>

        {/* ONE small grey line under it */}
        <p className="text-center text-[13px] text-white/40" data-testid="question-note">
          {round.note}
        </p>

        {/* the answer controls */}
        <div className="mt-2 w-full max-w-md" data-testid="answer-controls">
          {answered ? (
            <p className="text-center text-sm text-lime-accent" data-testid="locked-in">
              Locked in.
            </p>
          ) : (
            controls
          )}
          {error && <p className="mt-3 text-center text-sm text-alert" role="alert">{error}</p>}
        </div>
      </motion.div>
    </main>
  );
}
