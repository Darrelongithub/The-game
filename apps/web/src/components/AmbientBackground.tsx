'use client'
// components/AmbientBackground.tsx — verbatim from reference/ui-system.md §4
// + ui-system-FIXES #7 (mousemove writes are throttled to one pending frame).
import { useEffect, useRef, useState } from 'react'

export function AmbientBackground() {
  const [isTouch, setIsTouch] = useState(true)
  const glowRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<number | null>(null)
  const pendingRef = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    setIsTouch(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  useEffect(() => {
    if (isTouch) return

    // FIX #7: one pending rAF max — never write transform per raw mousemove.
    const flush = () => {
      frameRef.current = null
      const next = pendingRef.current
      pendingRef.current = null
      if (next && glowRef.current) {
        glowRef.current.style.transform = `translate(${next.x - 200}px, ${next.y - 200}px)`
      }
    }

    const handleMove = (e: MouseEvent) => {
      pendingRef.current = { x: e.clientX, y: e.clientY }
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush)
      }
    }

    window.addEventListener('mousemove', handleMove)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
      frameRef.current = null
      pendingRef.current = null
    }
  }, [isTouch])

  return (
    <div className="fixed inset-0 overflow-hidden -z-10 bg-base">
      <div
        className="blob w-[50vw] h-[50vw] top-[-10%] left-[-10%]"
        style={{ background: 'radial-gradient(circle, var(--purple-primary), transparent 70%)', animation: 'drift1 18s ease-in-out infinite' }}
      />
      <div
        className="blob w-[45vw] h-[45vw] bottom-[-15%] right-[-10%]"
        style={{ background: 'radial-gradient(circle, var(--blue-secondary), transparent 70%)', animation: 'drift2 22s ease-in-out infinite' }}
      />
      <div
        className="blob w-[30vw] h-[30vw] top-[30%] left-[40%] opacity-40"
        style={{ background: 'radial-gradient(circle, var(--purple-deep), transparent 70%)', animation: 'drift1 25s ease-in-out infinite reverse' }}
      />
      {/* Desktop-only cursor glow */}
      {!isTouch && (
        <div
          ref={glowRef}
          className="absolute w-[400px] h-[400px] rounded-full pointer-events-none transition-transform duration-300 ease-out"
          style={{ background: 'radial-gradient(circle, rgba(182,255,60,0.08), transparent 70%)' }}
        />
      )}
      <div className="grain-overlay" />
    </div>
  )
}
