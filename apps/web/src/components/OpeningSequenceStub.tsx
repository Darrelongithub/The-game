"use client";
// components/OpeningSequenceStub.tsx
// PLACEHOLDER for Agent B2's `components/OpeningSequence.tsx` (the paste's
// full orchestrated orb → wipe → words → flame sequence). Agent A owns the
// GATE, not the animation: this stub keeps the shell runnable today and
// applies the same three fixes the real one must have (ui-system-FIXES #2,
// #4, #5). To swap in B2's component, change ONE import in app/page.tsx.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Flame } from "@/components/Flame";
import { AnimatedWords } from "@/components/AnimatedWords";
import { easeOutExpo } from "@/lib/motion";

type Beat = "idle" | "wipe" | "words" | "flame" | "done";

export function OpeningSequenceStub({ onComplete }: { onComplete: () => void }) {
  const [beat, setBeat] = useState<Beat>("idle");
  const [pressed, setPressed] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const done = useRef(false);

  const complete = useCallback(() => {
    if (done.current) return; // FIX #5: onComplete fires exactly once
    done.current = true;
    onComplete();
  }, [onComplete]);

  // FIX #5: no raw setTimeout chains — every id is tracked and cleared.
  useEffect(() => {
    return () => {
      timers.current.forEach(clearTimeout);
      timers.current = [];
    };
  }, []);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };

  const start = () => {
    if (pressed) return;
    if ("vibrate" in navigator) {
      try {
        navigator.vibrate(10); // iOS Safari lacks this — fails silently
      } catch {
        /* ignore */
      }
    }
    setPressed(true);
    setBeat("wipe");
    later(() => setBeat("words"), 550);
    later(() => setBeat("flame"), 1700);
    later(() => setBeat("done"), 3000);
    later(complete, 3400);
  };

  // FIX #2: any tap during the sequence skips straight to done.
  const skip = () => {
    if (beat === "idle") {
      start();
      return;
    }
    complete();
  };

  // FIX #4: the wipe scales from the viewport, not a magic 60.
  const wipeScale =
    typeof window === "undefined"
      ? 60
      : (Math.hypot(window.innerWidth, window.innerHeight) / 40) * 1.1;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-center justify-center overflow-hidden"
      onClick={skip}
      onTouchStart={skip}
      role="button"
      tabIndex={0}
      aria-label="Tap to skip the intro"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") skip();
      }}
    >
      <AnimatePresence mode="wait">
        {beat === "idle" && (
          <motion.div
            key="orb"
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="relative flex flex-col items-center gap-5"
          >
            <div className="relative w-28 h-28 md:w-32 md:h-32 rounded-full glass-card flex items-center justify-center">
              <motion.div
                className="absolute inset-[-6px] rounded-full border border-lime-accent/40"
                animate={{ scale: [1, 1.08, 1], opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
            <span className="text-xs tracking-[0.2em] text-white/60 uppercase font-medium">
              Tap to begin
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {pressed && beat === "wipe" && (
          <motion.div
            className="fixed rounded-full bg-purple-primary z-20"
            style={{ width: 40, height: 40 }}
            initial={{ scale: 0, opacity: 1 }}
            animate={{ scale: wipeScale, opacity: 1 }}
            transition={{ duration: 0.55, ease: easeOutExpo }}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {beat === "words" && (
          <motion.div
            key="words"
            className="fixed inset-0 flex items-center justify-center z-30 px-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
          >
            <AnimatedWords
              text="Who's ready to get spicy"
              highlightWord="spicy"
              className="text-display-lg md:text-display-xl text-center max-w-xl"
            />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {beat === "flame" && (
          <motion.div
            key="flame"
            className="fixed inset-0 flex items-center justify-center z-30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.3, transition: { duration: 0.4, ease: easeOutExpo } }}
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: [0, 1.15, 1] }}
              transition={{ duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
            >
              <Flame size={160} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <span className="absolute bottom-6 text-[10px] uppercase tracking-[0.25em] text-white/25">
        tap to skip
      </span>
    </div>
  );
}
