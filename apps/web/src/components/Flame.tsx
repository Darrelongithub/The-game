'use client'
// components/Flame.tsx — reference/ui-system.md §5 verbatim
// + ui-system-FIXES #3: ember configs (Math.random) are computed ONCE in
// useMemo. Randomising inside render re-rolled every ember on every state
// change, so the embers teleported. FIXED.
import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { usePrefersReducedMotion } from './deviceFeedback'

export function Flame({ size = 140 }: { size?: number }) {
  const reduced = usePrefersReducedMotion()
  // Deterministic-per-mount ember configs (stable across re-renders).
  const embers = useMemo(
    () =>
      Array.from({ length: 7 }).map((_, i) => ({
        leftPct: 45 + Math.random() * 10,
        driftX: (Math.random() - 0.5) * 40,
        duration: 1.8 + Math.random(),
        delay: i * 0.25,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [size]
  )

  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {/* Glow bloom behind flame */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: size * 1.8, height: size * 1.8,
          background: 'radial-gradient(circle, rgba(182,255,60,0.35), rgba(139,47,224,0.2) 50%, transparent 75%)',
          filter: 'blur(20px)',
        }}
        animate={reduced ? { opacity: 0.8, scale: 1 } : { opacity: [0.6, 1, 0.6], scale: [0.9, 1.05, 0.9] }}
        transition={reduced ? { duration: 0 } : { duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Embers — stable configs, see FIX #3 */}
      {!reduced && embers.map((e, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full bg-lime-accent"
          style={{ width: 3, height: 3, bottom: size * 0.3, left: `${e.leftPct}%` }}
          animate={{
            y: [0, -size * 1.2],
            x: [0, e.driftX],
            opacity: [0, 1, 0],
          }}
          transition={{
            duration: e.duration,
            repeat: Infinity,
            delay: e.delay,
            ease: 'easeOut',
          }}
        />
      ))}

      {/* Flame body — layered SVG paths animating independently for organic flicker */}
      <svg width={size} height={size} viewBox="0 0 100 140" className="relative z-10">
        <defs>
          <linearGradient id="flameGrad" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#8b2fe0" />
            <stop offset="55%" stopColor="#b6ff3c" />
            <stop offset="100%" stopColor="#f5f3ff" />
          </linearGradient>
        </defs>

        <motion.path
          d="M50 140 C20 110 15 75 35 45 C40 65 50 65 48 45 C65 65 85 95 65 125 C75 110 72 95 65 90 C68 115 58 130 50 140 Z"
          fill="url(#flameGrad)"
          style={{ transformOrigin: '50% 100%' }}
          animate={reduced ? { scaleY: 1, scaleX: 1 } : { scaleY: [1, 1.08, 0.96, 1.05, 1], scaleX: [1, 0.95, 1.04, 0.97, 1] }}
          transition={reduced ? { duration: 0 } : { duration: 0.6, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.path
          d="M50 140 C30 115 28 85 42 55 C45 72 50 72 48 55 C60 75 72 100 58 125 Z"
          fill="#f5f3ff"
          opacity={0.5}
          style={{ transformOrigin: '50% 100%' }}
          animate={reduced ? { scaleY: 1, scaleX: 1 } : { scaleY: [1, 0.92, 1.06, 0.98, 1], scaleX: [1, 1.05, 0.95, 1.02, 1] }}
          transition={reduced ? { duration: 0 } : { duration: 0.45, repeat: Infinity, ease: 'easeInOut', delay: 0.1 }}
        />
      </svg>
    </div>
  )
}
