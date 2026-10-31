"use client";
// components/LoadingScreen.tsx — the wait while the night's questions are
// written. It shows on every phone AND on the laptop.
//
// "Let's test your friendship" + "14/40 ready".
import { motion } from "framer-motion";
import { Flame } from "@/components/Flame";

export function LoadingScreen({
  done = 0,
  total = 40,
}: {
  done?: number;
  total?: number;
}) {
  const safeTotal = Math.max(1, total);
  const safeDone = Math.min(Math.max(0, done), safeTotal);
  const pct = Math.round((safeDone / safeTotal) * 100);

  return (
    <main className="screen relative flex min-h-[100dvh] flex-col items-center justify-center gap-6 px-6 text-center">
      <Flame size={96} />
      <motion.h1
        className="font-display text-display-lg md:text-display-xl text-center"
        animate={{ opacity: [0.75, 1, 0.75] }}
        transition={{ duration: 2.4, repeat: Infinity }}
        data-testid="loading-title"
      >
        Let&apos;s test your friendship
      </motion.h1>
      <p className="tabular-nums text-sm text-white/50" data-testid="loading-progress">
        {safeDone}/{safeTotal} ready
      </p>
      <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/10">
        <motion.div
          className="h-full rounded-full bg-gradient-to-r from-lime-accent to-purple-primary"
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.4 }}
        />
      </div>
      <p className="max-w-xs text-xs text-white/35">
        The night&apos;s questions are being written. This never hangs — the
        question bank takes over if it runs long.
      </p>
    </main>
  );
}
