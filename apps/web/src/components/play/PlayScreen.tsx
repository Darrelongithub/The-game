"use client";
// components/play/PlayScreen.tsx — Agent A's phase router for the night itself.
//
// Wiring (post-merge): it now renders OTHER AGENTS' real screens:
//   round     → src/screens/PromptScreen   (B1/B2 input surface, all 9 kinds,
//                                           onlyPlayers spectator handling)
//   interlude → src/screens/InterludeScreen
//   reveal    → src/screens/RevealScreen
//   finale    → src/components/FinaleScreen (B2: broadcast-safe story player,
//                                           GroupAnnouncement, ShareCard, and
//                                           the press-and-hold secret deck)
// Agent A still owns the routing, the server-authoritative ordering and the
// `secrets` privacy: the deck is only ever handed to FinaleScreen from the
// per-socket `secrets` event.
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { UseRoom } from "@/lib/useRoom";
import { PromptScreen } from "@/screens/PromptScreen";
import { InterludeScreen } from "@/screens/InterludeScreen";
import { RevealScreen } from "@/screens/RevealScreen";
import { FinaleScreen } from "@/components/FinaleScreen";
import { SecretDeck } from "@/components/SecretDeck";
import { Flame } from "@/components/Flame";

export function PlayScreen({ room }: { room: UseRoom }) {
  const {
    view, you, round, interlude, reveal, finale, secrets,
    submit, voteHeatDown,
  } = room;

  // Local "already watched this beat" markers — the beats are one-shot events
  // and each phone dismisses them independently.
  const [watchedInterlude, setWatchedInterlude] = useState<unknown>(null);
  const [watchedReveal, setWatchedReveal] = useState<string | null>(null);
  const [storyEnded, setStoryEnded] = useState(false);
  const [deckOpen, setDeckOpen] = useState(false);

  useEffect(() => setWatchedInterlude(null), [interlude]);
  useEffect(() => setWatchedReveal(null), [reveal]);

  if (!view) return null;

  // ── finale first: once it lands, it owns the screen until the player leaves
  if (finale) {
    return (
      <>
        <FinaleScreen
          view={finale}
          deck={secrets ?? undefined}
          roomCode={view.code}
          onStoryEnd={() => setStoryEnded(true)}
        />
        {/* Safety net: a phone that reconnects after the story ended can still
            reopen its private deck without replaying the slides. */}
        {storyEnded && secrets && !deckOpen && (
          <button
            type="button"
            onClick={() => setDeckOpen(true)}
            className="fixed bottom-4 left-1/2 z-40 min-h-[48px] -translate-x-1/2 rounded-2xl border border-lime-accent/50 bg-[#0d0617]/90 px-4 text-[11px] uppercase tracking-[0.2em] text-lime-accent"
          >
            {secrets.cards.length} secret{secrets.cards.length === 1 ? "" : "s"} · only on this phone
          </button>
        )}
        {deckOpen && secrets && <SecretDeck deck={secrets} onClose={() => setDeckOpen(false)} />}
      </>
    );
  }

  if (interlude && watchedInterlude !== interlude) {
    return (
      <InterludeScreen interlude={interlude} onComplete={() => setWatchedInterlude(interlude)} />
    );
  }

  if (reveal && watchedReveal !== reveal.roundId) {
    return <RevealScreen reveal={reveal} onComplete={() => setWatchedReveal(reveal.roundId)} />;
  }

  if (round) {
    // PromptScreen needs a resolved PlayerId for `you`; a resumed tab has it
    // from sessionStorage before the first snapshot lands.
    if (!you) return <HoldingScreen label="Finding your seat…" />;
    return (
      <PromptScreen
        key={round.roundId}
        round={round}
        room={view}
        you={you}
        onSubmit={async (value) => (await submit(value)).ok}
        onVoteHeatDown={voteHeatDown}
      />
    );
  }

  return (
    <HoldingScreen
      label={view.phase === "interlude" ? "Changing the temperature…" : "Next prompt incoming…"}
    />
  );
}

function HoldingScreen({ label }: { label: string }) {
  return (
    <main className="screen relative flex flex-col items-center justify-center gap-5 px-6 text-center">
      <Flame size={90} />
      <motion.p
        className="font-display text-heading text-white/80"
        animate={{ opacity: [0.55, 1, 0.55] }}
        transition={{ duration: 2, repeat: Infinity }}
      >
        {label}
      </motion.p>
      <p className="text-sm text-white/40">Keep this tab open. The room moves without you.</p>
    </main>
  );
}
