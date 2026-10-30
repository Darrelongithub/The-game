'use client'
import { useEffect, useState } from 'react'

/** Synchronous reduced-motion probe, safe during SSR. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function usePrefersReducedMotion(): boolean {
  // Match the server's first render; the effect applies the browser setting
  // immediately after hydration. CSS also suppresses motion before that.
  const [reduced, setReduced] = useState(false)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let mq: MediaQueryList
    try { mq = window.matchMedia('(prefers-reduced-motion: reduce)') } catch { return }
    const onChange = () => setReduced(mq.matches)
    onChange()
    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    }
    mq.addListener(onChange)
    return () => mq.removeListener(onChange)
  }, [])
  return reduced
}

export function haptic(pattern?: number | number[]): void {
  if (typeof navigator === 'undefined' || !('vibrate' in navigator)) return
  try { navigator.vibrate(pattern ?? 12) } catch { /* unsupported device */ }
}
