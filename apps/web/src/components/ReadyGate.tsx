"use client";
// components/ReadyGate.tsx — the ONE ready gate, at the very end of the night.
//
// There is no per-round gate and no per-round reveal. This is the only one:
// "Ready for the results?" — then the reveal.
import { motion } from "framer-motion";
import type { PlayerId } from "@shared/contracts.ts";
import { Flame } from "@/components/Flame";
import { GlowButton } from "@/components/GlowButton";

export function ReadyGate({
  players,
  you,
  youAreReady,
  onReady,
}: {
  players: { id: PlayerId; alias: string; connected: boolean }[];
  you: PlayerId | null;
  youAreReady: boolean;
  onReady: () => void;
}) {
  const here = players.filter((player) => player.connected);
  const waiting = here.filter((player) => player.id !== you).length;

  return (
    <main className="screen relative flex min-h-[100dvh] flex-col items-center justify-center gap-6 px-6 text-center">
      <Flame size={84} />
      <motion.h1
        className="font-display text-display-lg text-center"
        animate={{ opacity: [0.8, 1, 0.8] }}
        transition={{ duration: 2.2, repeat: Infinity }}
        data-testid="ready-gate-title"
      >
        Ready for the results?
      </motion.h1>
      <p className="max-w-xs text-sm text-white/55">
        {youAreReady
          ? "Locked in. Waiting for the room…"
          : "The night is done. Say it when you are ready."}
      </p>
      <GlowButton
        className="w-full max-w-xs"
        variant={youAreReady ? "primary" : "accent"}
        onClick={onReady}
        disabled={youAreReady}
        data-testid="ready-gate-button"
      >
        {youAreReady ? "Ready ✓" : "I'm ready"}
      </GlowButton>
      <p className="text-xs text-white/35">
        {waiting > 0 ? `${waiting} still thinking…` : "Everybody's in."}
      </p>
    </main>
  );
}
