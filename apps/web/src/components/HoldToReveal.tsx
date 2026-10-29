// components/HoldToReveal.tsx — press-and-hold gate for Secret Cards.
//
// Contract (spec §7 / §11.12 / agent brief):
//   • Face-down: glass + grain + lock/eye glyph on the heat gradient.
//   • Press-and-hold ramps over SECRET_HOLD_MS with a progress ring; the card
//     scales 1.02 while held; on completion the face opens (card flip sting).
//   • RELEASE hides it again — shoulder-surfers see nothing. The face is not
//     even mounted while closed (no text to copy/inspect).
//   • Quick tap = advance to the next card. Horizontal swipe = next/prev.
//   • Long-press callout/copy menus suppressed:
//     -webkit-touch-callout: none; user-select: none (plus contextmenu kill).
//   • Works with touch AND mouse via pointerdown/pointerup (capture).
//   • prefers-reduced-motion: hold opens instantly — still hides on release.
'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { SECRET_HOLD_MS } from '../../../../packages/shared/src/contracts.ts'
import { haptic, usePrefersReducedMotion } from './feedback'
import { sfx } from './sound'

const TAP_MS = 260
const TAP_SLOP_PX = 12
const SWIPE_PX = 48

const GRAIN_URL =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")"

export function HoldToReveal({
  face,
  onAdvance,
  holdMs = SECRET_HOLD_MS,
  className = '',
  cardLabel,
}: {
  /** Face content — mounted ONLY while held open (shoulder-surf safe). */
  face: ReactNode
  /** Called on quick tap (dir 1) or swipe (dir 1 / -1). */
  onAdvance?: (dir: 1 | -1) => void
  holdMs?: number
  className?: string
  /** Small caption on the face-down card, e.g. "SPARK · 1 of 3". */
  cardLabel?: string
}) {
  const reduced = usePrefersReducedMotion()
  const [open, setOpen] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [progress, setProgress] = useState(0)

  const pointer = useRef<{
    id: number
    x: number
    y: number
    t: number
    dx: number
    raf: number
    start: number
    opened: boolean
  } | null>(null)

  const stopRamp = () => {
    const p = pointer.current
    if (p && p.raf) {
      cancelAnimationFrame(p.raf)
      p.raf = 0
    }
  }

  // Unmount safety: never leave a rAF running.
  useEffect(() => () => stopRamp(), [])

  const beginRamp = () => {
    const p = pointer.current
    if (!p) return
    if (reduced) {
      // Reduced motion: hold opens INSTANTLY (still hides on release).
      p.opened = true
      setOpen(true)
      sfx.cardFlip()
      return
    }
    p.start = performance.now()
    const tick = () => {
      const cur = pointer.current
      if (!cur) return
      const t = Math.min(1, (performance.now() - cur.start) / holdMs)
      setProgress(t)
      if (t >= 1) {
        cur.opened = true
        setOpen(true)
        sfx.cardFlip()
        haptic(10)
        cur.raf = 0
        return
      }
      cur.raf = requestAnimationFrame(tick)
    }
    p.raf = requestAnimationFrame(tick)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (pointer.current) return // already tracking
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const el = e.currentTarget
    try {
      el.setPointerCapture?.(e.pointerId)
    } catch {
      /* not supported everywhere — pointer events still flow */
    }
    pointer.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: Date.now(), dx: 0, raf: 0, start: 0, opened: false }
    setPressed(true)
    setProgress(0)
    beginRamp()
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current
    if (!p || e.pointerId !== p.id) return
    p.dx = e.clientX - p.x
  }

  const release = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = pointer.current
    if (!p || e.pointerId !== p.id) return
    stopRamp()
    const dur = Date.now() - p.t
    const dx = p.dx
    const opened = p.opened || open
    pointer.current = null
    setPressed(false)
    setProgress(0)

    if (opened) {
      // Release hides it again — shoulder-surfers see nothing.
      setOpen(false)
      // Reduced motion opens instantly on pointerdown, so a quick tap there
      // flashes the face and must still navigate: hide + advance together.
      if (reduced && dur < TAP_MS && Math.abs(dx) <= TAP_SLOP_PX) onAdvance?.(1)
      return
    }
    if (Math.abs(dx) >= SWIPE_PX) {
      onAdvance?.(dx < 0 ? 1 : -1)
      return
    }
    if (dur < TAP_MS && Math.abs(dx) <= TAP_SLOP_PX) {
      // Quick tap → next card (a hold that never completed is NOT a tap
      // unless it was fast — mid-length presses just cancel).
      onAdvance?.(1)
    }
  }

  const ringLen = 1 // pathLength={1} → dash math is 0..1
  const ringOffset = ringLen - (pressed ? progress : 0)

  return (
    <div
      // Spec §11.12 — kill long-press callout/copy menus on BOTH engines:
      // inline style (works even without Tailwind) + utilities (assertable).
      className={`relative w-full max-w-[330px] select-none [-webkit-touch-callout:none] [-webkit-user-select:none] ${className}`}
      style={{
        WebkitTouchCallout: 'none',
        WebkitUserSelect: 'none',
        userSelect: 'none',
        touchAction: 'none',
        cursor: 'pointer',
      }}
      role="button"
      tabIndex={0}
      aria-label={open ? 'Secret card revealed — release to hide' : 'Secret card face-down — press and hold to reveal'}
      data-testid="hold-to-reveal"
      data-state={open ? 'open' : 'closed'}
      data-pressed={pressed ? '1' : '0'}
      data-progress={(pressed ? progress : 0).toFixed(2)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onAdvance?.(1)
        }
      }}
    >
      <div
        className="relative aspect-[3/4] w-full rounded-3xl overflow-hidden"
        style={{
          transform: pressed ? 'scale(1.02)' : 'scale(1)',
          transition: reduced ? 'none' : 'transform 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
          // Face-down: glass + grain + heat gradient
          background: open
            ? 'linear-gradient(140deg, #8b2fe0 0%, #2f5fe0 55%, #b6ff3c 145%)'
            : 'linear-gradient(150deg, rgba(139,47,224,0.55) 0%, rgba(47,95,224,0.4) 55%, rgba(182,255,60,0.22) 130%)',
          backdropFilter: 'blur(24px) saturate(140%)',
          WebkitBackdropFilter: 'blur(24px) saturate(140%)',
          border: '1px solid rgba(255,255,255,0.18)',
          borderTop: '1px solid rgba(255,255,255,0.32)',
          boxShadow: '0 24px 70px -18px rgba(76,29,149,0.85), inset 0 1px 0 rgba(255,255,255,0.14)',
        }}
      >
        {/* grain layer */}
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: GRAIN_URL, opacity: 0.14, mixBlendMode: 'overlay' }}
        />

        {/* ── face-down ─────────────────────────────────────────────── */}
        {!open && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-5">
            {/* lock glyph */}
            <svg width="76" height="76" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M7 10V7a5 5 0 0 1 10 0v3"
                stroke="#b6ff3c"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <rect
                x="4.7"
                y="10"
                width="14.6"
                height="10.3"
                rx="2.6"
                stroke="#b6ff3c"
                strokeWidth="1.6"
                fill="rgba(13,6,23,0.55)"
              />
              <circle cx="12" cy="14.6" r="1.5" fill="#b6ff3c" />
              <path d="M12 15.9v1.8" stroke="#b6ff3c" strokeWidth="1.5" strokeLinecap="round" />
            </svg>

            <span className="text-[11px] uppercase tracking-[0.28em] text-white/75 font-medium">
              hold to reveal
            </span>
            {cardLabel && (
              <span className="text-[10px] uppercase tracking-[0.2em] text-white/45" data-testid="hold-label">
                {cardLabel}
              </span>
            )}

            {/* progress ring */}
            <svg
              className="absolute inset-0 w-full h-full pointer-events-none"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden
            >
              <rect
                x="1.5"
                y="1.5"
                width="97"
                height="97"
                rx="7"
                fill="none"
                stroke="#b6ff3c"
                strokeWidth="1.6"
                pathLength={ringLen}
                strokeDasharray={ringLen}
                strokeDashoffset={ringOffset}
                opacity={pressed ? 0.95 : 0}
                style={{ transition: pressed ? 'none' : 'opacity 0.2s' }}
              />
            </svg>
          </div>
        )}

        {/* ── revealed (mounted only while held) ────────────────────── */}
        <AnimatePresence>
          {open && (
            <motion.div
              key="face"
              className="absolute inset-0 p-6 flex flex-col gap-3 overflow-hidden"
              initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1, transition: { duration: reduced ? 0 : 0.22 } }}
              exit={{ opacity: 0, transition: { duration: 0.12 } }}
              data-testid="hold-face"
            >
              {/* lime flash (§12: revealed = full heat gradient + lime flash) */}
              {!reduced && (
                <motion.div
                  className="absolute inset-0 bg-lime-accent pointer-events-none"
                  initial={{ opacity: 0.5 }}
                  animate={{ opacity: 0 }}
                  transition={{ duration: 0.35 }}
                />
              )}
              {face}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  )
}
