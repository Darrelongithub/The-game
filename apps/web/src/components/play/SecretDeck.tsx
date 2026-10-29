"use client";
// components/play/SecretDeck.tsx — Agent A placeholder deck (B2 owns the
// produced SecretDeck + HoldToReveal pair).
//
// Contract rules honoured here, because they are not negotiable:
//  • cards arrive ONLY through the private `secrets` event (this phone);
//  • face-down by default: glass + grain + glyph on the heat gradient;
//  • HOLD to open (SECRET_HOLD_MS ramp with a progress ring), release hides
//    it again — shoulder-surfers see nothing;
//  • tap/swipe goes to the next card;
//  • long-press callout/copy menus suppressed (cross-platform item 12).
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { SecretDeckView } from "@shared/contracts.ts";
import { SECRET_HOLD_MS } from "@shared/contracts.ts";
import { GlowButton } from "@/components/GlowButton";

export function SecretDeck({ deck, onClose }: { deck: SecretDeckView; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number>(0);
  const card = deck.cards[index];

  const stop = useCallback(() => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setProgress(0);
    setRevealed(false);
  }, []);

  useEffect(() => stop, [stop]);

  const beginHold = useCallback(() => {
    if (revealed) return;
    startRef.current = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - startRef.current) / SECRET_HOLD_MS);
      setProgress(t);
      if (t >= 1) {
        setRevealed(true);
        rafRef.current = null;
        if ("vibrate" in navigator) {
          try {
            navigator.vibrate(12);
          } catch {
            /* iOS Safari */
          }
        }
        return;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [revealed]);

  const go = (dir: 1 | -1) => {
    stop();
    setIndex((i) => Math.min(Math.max(i + dir, 0), deck.cards.length - 1));
  };

  if (!card) return null;

  return (
    <div
      className="fixed inset-0 z-[95] flex flex-col items-center justify-center px-5 py-8 no-callout"
      style={{ background: "rgba(13,6,23,0.94)" }}
    >
      <p className="text-[10px] uppercase tracking-[0.3em] text-lime-accent/80 mb-1">
        only on this phone
      </p>
      <p className="text-xs text-white/40 mb-6 tabular-nums">
        {index + 1} / {deck.cards.length}
      </p>

      <AnimatePresence mode="wait">
        <motion.div
          key={card.id}
          initial={{ opacity: 0, scale: 0.96, rotateY: -8 }}
          animate={{ opacity: 1, scale: revealed ? 1.02 : 1, rotateY: 0 }}
          exit={{ opacity: 0, scale: 0.94 }}
          transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
          className="relative w-full max-w-sm"
        >
          <div
            className="glass-card relative overflow-hidden p-6 min-h-[340px] flex flex-col justify-between select-none"
            style={{ touchAction: "none" }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              beginHold();
            }}
            onPointerUp={stop}
            onPointerCancel={stop}
            onPointerLeave={stop}
            onContextMenu={(e) => e.preventDefault()}
            role="button"
            tabIndex={0}
            aria-label={revealed ? `${card.title} revealed` : "Hold to reveal this secret card"}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault();
                beginHold();
              }
            }}
            onKeyUp={stop}
          >
            {/* face-down face */}
            <AnimatePresence>
              {!revealed && (
                <motion.div
                  className="absolute inset-0 heat-gradient opacity-[0.22]"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.22 }}
                  exit={{ opacity: 0 }}
                />
              )}
            </AnimatePresence>

            <div className="relative z-10 flex flex-col h-full min-h-[292px]">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase tracking-[0.24em] text-white/45">
                  {revealed ? card.kind : "sealed"}
                </span>
                {!revealed && <span className="text-lg" aria-hidden>🔒</span>}
              </div>

              {revealed ? (
                <motion.div
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25 }}
                  className="my-auto py-4"
                >
                  <h2 className="font-display text-[clamp(1.6rem,6vw,2.1rem)] leading-tight text-white mb-4">
                    {card.title}
                  </h2>
                  <ul className="flex flex-col gap-2.5">
                    {card.facts.map((f, i) => (
                      <li key={i} className="text-sm text-white/80 leading-relaxed flex gap-2">
                        <span className="text-lime-accent shrink-0">·</span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                </motion.div>
              ) : (
                <div className="my-auto text-center">
                  <motion.div
                    className="mx-auto mb-4 h-16 w-16 rounded-full border border-white/20 flex items-center justify-center"
                    animate={{ opacity: [0.6, 1, 0.6] }}
                    transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
                  >
                    <span className="text-2xl" aria-hidden>👁</span>
                  </motion.div>
                  <p className="text-sm text-white/55">Press and hold to open</p>
                  <p className="text-[11px] text-white/30 mt-1">Let go and it hides again.</p>
                </div>
              )}

              {/* hold progress ring / bar */}
              <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden mt-4">
                <div
                  className="h-full rounded-full bg-lime-accent transition-[width] duration-75"
                  style={{ width: `${(revealed ? 1 : progress) * 100}%` }}
                />
              </div>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => go(-1)}
          disabled={index === 0}
          className="h-12 w-12 rounded-full border border-white/15 text-white/60 disabled:opacity-25"
          aria-label="Previous card"
        >
          ‹
        </button>
        <GlowButton variant="accent" className="px-5" onClick={onClose}>
          Done
        </GlowButton>
        <button
          type="button"
          onClick={() => go(1)}
          disabled={index >= deck.cards.length - 1}
          className="h-12 w-12 rounded-full border border-white/15 text-white/60 disabled:opacity-25"
          aria-label="Next card"
        >
          ›
        </button>
      </div>

      <p className="mt-5 text-[10px] uppercase tracking-[0.2em] text-white/20 text-center max-w-xs">
        never broadcast · never on anyone else&apos;s screen · not in the share card
      </p>
    </div>
  );
}
