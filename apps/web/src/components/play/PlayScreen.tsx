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
import { Flame } from "@/components/Flame";

export function PlayScreen({ room }: { room: UseRoom }) {
  if (!room.view) return null;
  return <><PlayContent room={room} /><PlayControls room={room} /></>;
}

function PlayContent({ room }: { room: UseRoom }) {
  const {
    view, you, round, interlude, reveal, finale, secrets,
    submit, voteHeatDown,
  } = room;

  // Local "already watched this beat" markers — the beats are one-shot events
  // and each phone dismisses them independently.
  const [watchedInterlude, setWatchedInterlude] = useState<unknown>(null);
  const [watchedReveal, setWatchedReveal] = useState<string | null>(null);

  useEffect(() => setWatchedInterlude(null), [interlude]);
  useEffect(() => setWatchedReveal(null), [reveal]);

  if (!view) return null;

  // ── finale first: once it lands, it owns the screen until the player leaves
  if (finale) {
    return (
      <FinaleScreen
        view={finale}
        deck={secrets ?? undefined}
        roomCode={view.code}
        onExit={room.reset}
      />
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

function PlayControls({ room }: { room: UseRoom }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <>
      <div className="fixed bottom-2 right-2 z-[60] flex gap-2" role="group" aria-label="Room controls">
        {room.isHost && room.round && !room.finale && (
          <button type="button" onClick={room.skipRound} className="min-h-[48px] rounded-xl border border-white/20 bg-[#0d0617]/95 px-3 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent">
            Skip round
          </button>
        )}
        <button type="button" onClick={() => setConfirmDelete(true)} className="min-h-[48px] rounded-xl border border-alert/40 bg-[#0d0617]/95 px-3 text-xs text-alert focus-visible:outline focus-visible:outline-2 focus-visible:outline-lime-accent">
          Delete room
        </button>
      </div>
      {confirmDelete && (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/80 p-4" role="alertdialog" aria-modal="true" aria-labelledby="play-delete-title" onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") setConfirmDelete(false); }}>
          <div className="glass-card w-full max-w-sm bg-[#0d0617] p-5">
            <h2 id="play-delete-title" className="text-lg font-bold text-white">Delete this room for everyone?</h2>
            <p className="mt-2 text-sm text-white/70">This immediately removes the room and its saved answers.</p>
            <div className="mt-4 flex gap-2">
              <button type="button" autoFocus onClick={() => setConfirmDelete(false)} className="min-h-[48px] rounded-xl border border-white/30 px-4 text-white">Keep it</button>
              <button type="button" onClick={room.deleteRoom} className="min-h-[48px] rounded-xl border border-alert px-4 text-alert">Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
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
