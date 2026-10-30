"use client";
// src/lib/useCountdown.ts — one interval, cleaned up on unmount/re-target.
import { useEffect, useState } from "react";

/** Milliseconds left until `closesAt` (epoch ms), clamped at 0. */
export function useCountdown(closesAt: number | null | undefined): number {
  const [left, setLeft] = useState(() =>
    closesAt ? Math.max(0, closesAt - Date.now()) : 0
  );

  useEffect(() => {
    if (!closesAt) {
      setLeft(0);
      return;
    }
    const tick = () => setLeft(Math.max(0, closesAt - Date.now()));
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [closesAt]);

  return left;
}

/** mm:ss for anything over a minute, plain seconds under it. */
export function formatLeft(ms: number): string {
  const total = Math.ceil(ms / 1000);
  if (total >= 60) {
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  return `${total}s`;
}
