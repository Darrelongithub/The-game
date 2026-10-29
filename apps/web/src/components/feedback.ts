// components/feedback.ts — environment feedback helpers:
// prefers-reduced-motion detection, feature-detected haptics, and the
// canvas-confetti land-beat bursts (lime/purple). All calls are safe in SSR
// and inside jsdom (guarded + try/catch) and all confetti honors
// prefers-reduced-motion (spec §11.9 / acceptance: reduced-motion kills confetti).
'use client'
import { useEffect, useState } from 'react'
import confetti from 'canvas-confetti'

const LIME = '#b6ff3c'
const PURPLE = '#8b2fe0'
const WHITE = '#f5f3ff'

/** Synchronous reduced-motion probe (SSR- and jsdom-safe). */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** React hook form of prefersReducedMotion — tracks changes live. */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(prefersReducedMotion)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let mq: MediaQueryList
    try {
      mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    } catch {
      return
    }
    const onChange = () => setReduced(mq.matches)
    onChange()
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    // Older Safari
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])

  return reduced
}

/**
 * Feature-detected haptics (spec §11.5 — iOS Safari lacks navigator.vibrate;
 * failures are swallowed silently).
 */
export function haptic(pattern?: number | number[]): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return
  try {
    navigator.vibrate(pattern ?? 12)
  } catch {
    /* iOS Safari and friends — fine */
  }
}

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
