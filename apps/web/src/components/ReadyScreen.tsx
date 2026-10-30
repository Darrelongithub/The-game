"use client";
// components/ReadyScreen.tsx — ROUND 4: reveals wait for everyone.
//
// A round has closed and its reveal is PENDING. Every phone gets this screen
// and nobody sees the moment until each connected player taps ready (the server
// reveals anyway after REVEAL_READY_GRACE_MS, so one AFK phone never stalls the
// night). No hints about what is coming: the copy says nothing about the round.
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { PlayerId, PlayerView } from "@shared/contracts.ts";
import { Flame } from "@/components/Flame";
import { GlassCard } from "@/components/GlassCard";
import { GlowButton } from "@/components/GlowButton";
import { staggerContainer, staggerItem } from "@/lib/motion";

export function ReadyScreen({
  players,
  you,
  youAreReady,
  awaiting,
  onReady,
}: {
  players: PlayerView[];
  you: PlayerId | null;
  youAreReady: boolean;
  /** players who have not pressed ready yet */
  awaiting: PlayerId[];
  onReady: () => void;
}) {
  const waiting = awaiting
    .map((id) => players.find((p) => p.id === id)?.alias)
    .filter((alias): alias is string => Boolean(alias));
  // A short, deliberate beat before the button is tappable: nobody should
  // release the moment by reflex while the room is still putting phones up.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <main className="screen relative flex flex-col items-center justify-center gap-6 px-6 text-center">
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="flex w-full max-w-md flex-col items-center gap-5"
      >
        <motion.div variants={staggerItem}>
          <Flame size={88} />
        </motion.div>

        <motion.p variants={staggerItem} className="text-[11px] uppercase tracking-[0.28em] text-white/45">
          The moment is waiting
        </motion.p>

        <motion.h1 variants={staggerItem} className="font-display text-heading text-white">
          {youAreReady ? "Eyes up — almost everyone" : "Eyes up. Everyone at once."}
        </motion.h1>

        <motion.p variants={staggerItem} className="max-w-sm text-sm leading-relaxed text-white/60">
          {youAreReady
            ? "Nothing starts until the last phone looks up. Nobody misses this one."
            : "The reveal waits for every phone in the room. Tap when you're looking."}
        </motion.p>

        {youAreReady ? (
          <motion.div variants={staggerItem} className="w-full">
            <GlassCard className="w-full p-5">
              <p className="text-xs uppercase tracking-[0.18em] text-white/45">
                {waiting.length === 0 ? "Everyone is ready" : `Waiting on ${waiting.length}`}
              </p>
              {waiting.length > 0 && (
                <ul className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
                  {waiting.map((alias) => (
                    <li key={alias} className="flex items-center gap-2 text-sm text-white/70">
                      <motion.span
                        className="h-2 w-2 rounded-full bg-lime-accent"
                        animate={{ opacity: [0.25, 1, 0.25] }}
                        transition={{ duration: 1.4, repeat: Infinity }}
                        aria-hidden="true"
                      />
                      {alias}
                    </li>
                  ))}
                </ul>
              )}
            </GlassCard>
          </motion.div>
        ) : (
          <motion.div variants={staggerItem} className="w-full">
            <GlowButton className="w-full" onClick={onReady} disabled={!armed}>
              I&apos;m ready
            </GlowButton>
            <p className="mt-3 text-[11px] text-white/35">
              Waiting on {new Set([...awaiting, ...(you ? [you] : [])]).size || 1} phone
              {new Set([...awaiting, ...(you ? [you] : [])]).size === 1 ? "" : "s"}
            </p>
          </motion.div>
        )}
      </motion.div>
    </main>
  );
}
