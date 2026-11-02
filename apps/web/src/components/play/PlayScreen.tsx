"use client";
// components/play/PlayScreen.tsx — the phone's night.
//
//   generating → "Let's test your friendship"
//   play       → ONE question, one grey line, the answer controls
//   results    → the ONE ready gate
//   finale     → the reveal, then this phone's secret deck
import { motion } from "framer-motion";
import type { UseRoom } from "@/lib/useRoom";
import { QuestionScreen } from "./QuestionScreen";
import { FinaleScreen } from "@/components/FinaleScreen";
import { ReadyGate } from "@/components/ReadyGate";
import { LoadingScreen } from "@/components/LoadingScreen";
import { Flame } from "@/components/Flame";

export function PlayScreen({ room }: { room: UseRoom }) {
  const { view, you, round, beat, finale, secrets } = room;
  if (!view) return null;

  // The reveal owns the screen once it lands.
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

  if (view.phase === "generating") {
    return <LoadingScreen done={view.generation?.done ?? 0} total={view.generation?.total ?? 40} />;
  }

  if (view.phase === "results") {
    return (
      <ReadyGate
        players={view.players}
        you={you}
        youAreReady={room.youAreReady}
        onReady={room.ready}
      />
    );
  }

  if (round && you) {
    return (
      <QuestionScreen
        key={round.roundId + round.segmentId}
        round={round}
        view={view}
        you={you}
        onSubmit={async (value) => (await room.submit(value)).ok}
      />
    );
  }

  return (
    <HoldingScreen label={beat?.label ?? "Next question incoming…"} />
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
        data-testid="holding-label"
      >
        {label}
      </motion.p>
      <p className="text-sm text-white/40">Keep this tab open. The room moves without you.</p>
    </main>
  );
}
