"use client";
// components/play/PlayScreen.tsx — Agent A's phase router for the night
// itself. It decides WHICH beat is on screen; the beats are replaceable.
import { useEffect, useState } from "react";
import type { UseRoom } from "@/lib/useRoom";
import { RoundPanel } from "./RoundPanel";
import { InterludePanel, RevealPanel } from "./BeatPanels";
import { FinalePanel } from "./FinalePanel";
import { SecretDeck } from "./SecretDeck";
import { Flame } from "@/components/Flame";
import { motion } from "framer-motion";

export function PlayScreen({ room }: { room: UseRoom }) {
  const { view, you, round, interlude, reveal, finale, secrets, mustAnswer, submit, darePass, skipRound, isHost } = room;
  const [dismissedInterlude, setDismissedInterlude] = useState<unknown>(null);
  const [dismissedReveal, setDismissedReveal] = useState<string | null>(null);
  const [deckOpen, setDeckOpen] = useState(false);

  // A new interlude/reveal resets the local "already watched" markers.
  useEffect(() => {
    setDismissedInterlude(null);
  }, [interlude]);
  useEffect(() => {
    setDismissedReveal(null);
  }, [reveal]);

  if (!view) return null;

  if (finale) {
    return (
      <>
        <FinalePanel
          view={finale}
          secretCount={secrets?.cards.length ?? 0}
          onOpenSecrets={() => setDeckOpen(true)}
        />
        {deckOpen && secrets && <SecretDeck deck={secrets} onClose={() => setDeckOpen(false)} />}
      </>
    );
  }

  if (interlude && dismissedInterlude !== interlude) {
    return <InterludePanel view={interlude} onDone={() => setDismissedInterlude(interlude)} />;
  }

  if (reveal && dismissedReveal !== reveal.roundId) {
    return <RevealPanel view={reveal} onDone={() => setDismissedReveal(reveal.roundId)} />;
  }

  if (round) {
    return (
      <RoundPanel
        key={round.roundId}
        round={round}
        players={view.players}
        you={you}
        mustAnswer={mustAnswer}
        submitted={round.youSubmitted || (reveal?.roundId === round.roundId)}
        onSubmit={(v) => {
          void submit(v);
        }}
        onDarePass={(reason) => {
          void darePass(reason);
        }}
        onSkip={skipRound}
        isHost={isHost}
      />
    );
  }

  // Between beats: a calm holding screen beats a blank one.
  return (
    <main className="screen relative flex flex-col items-center justify-center gap-5 px-6 text-center">
      <Flame size={90} />
      <motion.p
        className="font-display text-heading text-white/80"
        animate={{ opacity: [0.55, 1, 0.55] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        {view.phase === "interlude" ? "Changing the temperature…" : "Next prompt incoming…"}
      </motion.p>
      <p className="text-sm text-white/40">Keep this tab open. The room moves without you.</p>
      {secrets && (
        <button
          type="button"
          onClick={() => setDeckOpen(true)}
          className="min-h-[48px] text-[11px] uppercase tracking-[0.2em] text-lime-accent/70"
        >
          you have {secrets.cards.length} secrets
        </button>
      )}
      {deckOpen && secrets && <SecretDeck deck={secrets} onClose={() => setDeckOpen(false)} />}
    </main>
  );
}
