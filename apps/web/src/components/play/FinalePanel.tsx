"use client";
// components/play/FinalePanel.tsx — Agent A placeholder for the broadcast-safe
// finale walker. Every slide here is public and identical on every phone
// (spec §7); private material only ever arrives through `secrets`.
import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { FinaleView } from "@shared/contracts.ts";
import { AnimatedWords } from "@/components/AnimatedWords";
import { GlowButton } from "@/components/GlowButton";
import { easeOutExpo } from "@/lib/motion";

const SLIDE_HOLD_MS = 7000;

export function FinalePanel({
  view,
  secretCount,
  onOpenSecrets,
}: {
  view: FinaleView;
  secretCount: number;
  onOpenSecrets: () => void;
}) {
  const [index, setIndex] = useState(0);
  const confettiFired = useRef<number | null>(null);
  const slide = view.slides[index];
  const isLast = index >= view.slides.length - 1;

  const next = useCallback(() => {
    setIndex((i) => Math.min(i + 1, view.slides.length - 1));
  }, [view.slides.length]);

  // Auto-advance, so a room of phones stays roughly in sync without a host.
  useEffect(() => {
    if (isLast) return;
    const id = setTimeout(next, SLIDE_HOLD_MS);
    return () => clearTimeout(id);
  }, [index, isLast, next]);

  // The SHIP beat is the biggest moment of the night — confetti there only.
  useEffect(() => {
    if (!slide) return;
    const isShip = /ship/i.test(slide.title) || slide.flavor === "group";
    if (!isShip || confettiFired.current === index) return;
    confettiFired.current = index;
    let cancelled = false;
    import("canvas-confetti")
      .then(({ default: confetti }) => {
        if (cancelled) return;
        confetti({
          particleCount: 90,
          spread: 75,
          startVelocity: 42,
          origin: { y: 0.65 },
          colors: ["#b6ff3c", "#8b2fe0", "#3b82f6", "#ff4d6d", "#f5f3ff"],
          disableForReducedMotion: true,
        });
      })
      .catch(() => {
        /* confetti is garnish — never let it break the finale */
      });
    return () => {
      cancelled = true;
    };
  }, [index, slide]);

  if (!slide) return null;

  return (
    <main className="screen relative flex flex-col px-5 py-8">
      <div className="flex items-center gap-1.5 mb-6">
        {view.slides.map((_, i) => (
          <span
            key={i}
            className="h-1 flex-1 rounded-full transition-colors"
            style={{
              background: i <= index ? "var(--lime-accent)" : "rgba(255,255,255,0.12)",
            }}
          />
        ))}
      </div>

      <div className="flex-1 flex flex-col items-center justify-center text-center max-w-md mx-auto w-full">
        <AnimatePresence mode="wait">
          <motion.div
            key={index}
            initial={{ opacity: 0, y: 18, filter: "blur(6px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            exit={{ opacity: 0, y: -12, transition: { duration: 0.2 } }}
            transition={{ duration: 0.5, ease: easeOutExpo }}
            className="w-full flex flex-col items-center gap-4"
          >
            {slide.flavor === "group" && (
              <span className="text-[10px] uppercase tracking-[0.3em] text-alert">group announcement</span>
            )}

            <AnimatedWords
              text={slide.title}
              className="text-display-lg md:text-display-xl"
              highlightWord={slide.flavor === "group" ? undefined : "Player"}
            />

            {slide.body && (
              <p className="text-sm md:text-base text-white/65 leading-relaxed max-w-sm">{slide.body}</p>
            )}

            {slide.numbers && (
              <div className="flex items-end justify-center gap-6 mt-1">
                {Object.entries(slide.numbers).map(([k, v]) => (
                  <NumberStat key={k} label={k} value={v} accent={slide.flavor === "group"} />
                ))}
              </div>
            )}

            {slide.flavor === "quote" && (
              <p className="text-[10px] uppercase tracking-[0.22em] text-white/25">verbatim, from tonight</p>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      <div className="mt-8 flex flex-col items-center gap-3">
        {isLast ? (
          <>
            {secretCount > 0 ? (
              <>
                <p className="text-sm text-white/60 text-center">
                  You have {secretCount} secret{secretCount === 1 ? "" : "s"} — only on this phone.
                </p>
                <GlowButton className="w-full max-w-sm" onClick={onOpenSecrets}>
                  Open my secrets
                </GlowButton>
              </>
            ) : (
              <p className="text-sm text-white/45 text-center">
                No secrets for you tonight. Either you behaved, or you were boring.
              </p>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={() => {
              next();
            }}
            className="min-h-[48px] px-6 text-[10px] uppercase tracking-[0.25em] text-white/35"
          >
            next
          </button>
        )}
      </div>
    </main>
  );
}

function NumberStat({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  const [shown, setShown] = useState(0);
  const target = value;

  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const dur = 900;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(target <= 1 ? Number((target * eased).toFixed(2)) : Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target]);

  return (
    <div className="flex flex-col items-center">
      <span
        className="font-display text-3xl tabular-nums"
        style={{ color: accent ? "var(--lime-accent)" : "var(--white-text)" }}
      >
        {shown}
      </span>
      <span className="text-[10px] uppercase tracking-[0.18em] text-white/35">{label}</span>
    </div>
  );
}
