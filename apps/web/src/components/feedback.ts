// components/feedback.ts — environment feedback helpers:
// prefers-reduced-motion detection, feature-detected haptics, and the
// canvas-confetti land-beat bursts (lime/purple). All calls are safe in SSR
// and inside jsdom (guarded + try/catch) and all confetti honors
// prefers-reduced-motion (spec §11.9 / acceptance: reduced-motion kills confetti).
'use client'
import confetti from 'canvas-confetti'
import { prefersReducedMotion } from './deviceFeedback'
export { prefersReducedMotion, usePrefersReducedMotion, haptic } from './deviceFeedback'

const LIME = '#efb4ff'
const PURPLE = '#8b2fe0'
const WHITE = '#f5f3ff'

/** Lime/purple confetti burst for land beats. No-op under reduced motion. */
export function fireConfettiBurst(opts?: { particleCount?: number; spread?: number; y?: number }): void {
  if (prefersReducedMotion()) return
  if (typeof document === 'undefined') return
  try {
    confetti({
      particleCount: opts?.particleCount ?? 140,
      spread: opts?.spread ?? 82,
      startVelocity: 46,
      ticks: 240,
      decay: 0.92,
      origin: { y: opts?.y ?? 0.58 },
      colors: [LIME, PURPLE, WHITE],
      disableForReducedMotion: true,
    })
  } catch {
    /* never let a canvas failure break the finale */
  }
}

/** Side-salvo variant for the Group Announcement subject landing. */
export function fireConfettiSides(): void {
  if (prefersReducedMotion()) return
  if (typeof document === 'undefined') return
  const base = {
    particleCount: 90,
    spread: 70,
    startVelocity: 42,
    ticks: 220,
    decay: 0.92,
    colors: [LIME, PURPLE, WHITE] as string[],
    disableForReducedMotion: true,
  }
  try {
    confetti({ ...base, origin: { x: 0.18, y: 0.7 } })
    confetti({ ...base, origin: { x: 0.82, y: 0.7 } })
  } catch {
    /* ditto */
  }
}
