"use client";
// components/play/BeatPanels.tsx — Agent A placeholders for the interlude and
// per-round reveal beats (B2 owns the produced versions).
import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { InterludeView, RevealView } from "@shared/contracts.ts";
import { AnimatedWords } from "@/components/AnimatedWords";
import { GlassCard } from "@/components/GlassCard";
import { staggerContainer, staggerItem } from "@/lib/motion";

export function InterludePanel({ view, onDone }: { view: InterludeView; onDone: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDone, view.holdMs || 3200);
    return () => clearTimeout(id);
  }, [view, onDone]);

  return (
    <main className="screen relative flex flex-col items-center justify-center px-6">
      <AnimatePresence>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="w-full max-w-md text-center flex flex-col items-center gap-5"
        >
          <AnimatedWords text={view.headline} className="text-display-lg md:text-display-xl" />
          <p className="text-white/60 text-sm">{view.sub}</p>
          {view.teaser && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.6 }}
              className="glass-card px-4 py-3 text-left w-full"
            >
              <p className="text-[10px] uppercase tracking-[0.22em] text-lime-accent/80 mb-1">
                from tonight&apos;s data
              </p>
              <p className="text-sm text-white/80 leading-relaxed">{view.teaser}</p>
            </motion.div>
          )}
          <button
            type="button"
            onClick={onDone}
            className="min-h-[48px] px-4 text-[10px] uppercase tracking-[0.25em] text-white/30"
          >
            continue
          </button>
        </motion.div>
      </AnimatePresence>
    </main>
  );
}

export function RevealPanel({ view, onDone }: { view: RevealView; onDone: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDone, view.holdMs || 4200);
    return () => clearTimeout(id);
  }, [view, onDone]);

  return (
    <main className="screen relative flex flex-col items-center justify-center px-5 py-8">
      <motion.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="w-full max-w-md flex flex-col gap-4"
      >
        <motion.h2 variants={staggerItem} className="font-display text-heading text-center text-white">
          {view.summary}
        </motion.h2>

        {view.items && view.items.length > 0 && (
          <motion.div variants={staggerItem}>
            <GlassCard className="p-4">
              <ul className="flex flex-col gap-2.5">
                {view.items.map((item, i) => (
                  <motion.li
                    key={`${item.alias}-${i}`}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.15 + i * 0.08 }}
                    className="flex gap-2 text-sm"
                  >
                    <span className="text-lime-accent/80 shrink-0 max-w-[40%] truncate">{item.alias}</span>
                    <span className="text-white/70 leading-snug">{item.text}</span>
                  </motion.li>
                ))}
              </ul>
            </GlassCard>
          </motion.div>
        )}

        <button
          type="button"
          onClick={onDone}
          className="mx-auto min-h-[48px] px-4 text-[10px] uppercase tracking-[0.25em] text-white/30"
        >
          next
        </button>
      </motion.div>
    </main>
  );
}
