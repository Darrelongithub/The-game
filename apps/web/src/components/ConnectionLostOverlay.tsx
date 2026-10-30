"use client";
// components/ConnectionLostOverlay.tsx — Agent A.
// Flaky mobile data is the default state at a party, so losing the socket is
// treated as routine: it retries on its own, says so calmly, and offers a
// manual retry for the case where the phone actually fell off the WiFi.
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { GlowButton } from "@/components/GlowButton";

export function ConnectionLostOverlay({
  connected,
  resuming,
  hasSession = false,
  onRetry,
}: {
  connected: boolean;
  resuming: boolean;
  hasSession?: boolean;
  onRetry: () => void;
}) {
  const [attempts, setAttempts] = useState(0);
  // Don't flash the overlay for a 300ms blip — only if we stay down.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (connected && !resuming) {
      setVisible(false);
      setAttempts(0);
      return;
    }
    const t = setTimeout(() => setVisible(true), 1200);
    return () => clearTimeout(t);
  }, [connected, resuming]);

  useEffect(() => {
    if (!visible) return;
    const id = setInterval(() => setAttempts((a) => a + 1), 2500);
    return () => clearInterval(id);
  }, [visible]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center px-5 no-callout"
          style={{ background: "rgba(13,6,23,0.82)", backdropFilter: "blur(10px)", WebkitBackdropFilter: "blur(10px)" }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          role="alertdialog"
          aria-live="polite"
          aria-label="Reconnecting"
        >
          <motion.div
            initial={{ scale: 0.95, y: 10 }}
            animate={{ scale: 1, y: 0 }}
            className="glass-card w-full max-w-sm p-6 text-center"
          >
            <motion.div
              className="mx-auto mb-4 h-12 w-12 rounded-full border-2 border-lime-accent/30 border-t-lime-accent"
              animate={{ rotate: 360 }}
              transition={{ duration: 1.4, repeat: Infinity, ease: "linear" }}
            />
            <h2 className="font-display text-heading text-white mb-2">
              {resuming ? "Getting you back in" : hasSession ? "You slipped off" : "Can't reach the game"}
            </h2>
            <p className="text-sm text-white/60 leading-relaxed">
              {resuming
                ? "Pulling the room back from the server."
                : hasSession
                  ? "Your phone lost the room. Retrying on its own — keep this tab open."
                  : "The game server isn't responding yet. Check the host's link or WiFi, then retry."}
            </p>
            <p className="mt-2 text-[11px] text-white/30 tabular-nums">
              {attempts > 0 ? `auto-retry ${attempts}× · ` : ""}same WiFi as the host?
            </p>
            <GlowButton className="mt-5 w-full" variant="accent" onClick={onRetry}>
              Retry now
            </GlowButton>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
