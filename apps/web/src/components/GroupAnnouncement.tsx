// components/GroupAnnouncement.tsx — the room's verdict, cinematically.
// Renders FinaleSlides with flavor "group" (spec §7 + §12):
//   1. "GROUP ANNOUNCEMENT" title treatment
//   2. anonymous vote bars fill ONE BY ONE (staggered, count only — NEVER
//      voter names) while slide.numbers count up (tabular-nums)
//   3. the subject's name LANDS full-screen with confetti + haptics
// prefers-reduced-motion: bars render full instantly, numbers show the final
// value, no transforms, no confetti (fireConfettiBurst guards itself too).
'use client'
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { FinaleSlide } from '../../../../packages/shared/src/contracts.ts'
import { easeOutExpo } from '../lib/motion'
import { fireConfettiBurst, fireConfettiSides, haptic, usePrefersReducedMotion } from './feedback'
import { sfx } from './sound'

type Phase = 'title' | 'count' | 'land'

const TITLE_MS = 1000
const BAR_STAGGER_MS = 140
const COUNT_UP_MS = 950
const BAR_TAIL_MS = 420

function prettyLabel(key: string): string {
  const k = key.toLowerCase()
  if (k === 'votes') return 'VOTES'
  if (k === 'of' || k === 'ofroom') return 'OF THE ROOM'
  if (k === 'share' || k === 'pct' || k === 'percent') return 'SHARE'
  return key.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase()
}

function isPercentKey(key: string): boolean {
  const k = key.toLowerCase()
  return k === 'share' || k === 'pct' || k === 'percent'
}

/** Count-up progress: 0 → 1 over durationMs while running; 1 instantly when reduced. */
function useCountUp(running: boolean, instant: boolean, durationMs: number): number {
  const [p, setP] = useState(instant ? 1 : 0)

  useEffect(() => {
    if (instant) {
      setP(1)
      return
    }
    if (!running) return
    let raf = 0
    const start = performance.now()
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / durationMs)
      setP(1 - Math.pow(1 - t, 3)) // ease-out cubic
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [running, instant, durationMs])

  return p
}

export function GroupAnnouncement({
  slide,
  skipToEnd = false,
  celebrate = true,
  onDone,
}: {
  slide: FinaleSlide
  skipToEnd?: boolean
  /** confetti on the land beat — couple-coded verdicts only (spec §3) */
  celebrate?: boolean
  onDone?: () => void
}) {
  const reduced = usePrefersReducedMotion()
  const numbers = slide.numbers ?? {}
  const entries = Object.entries(numbers)
  const votes = entries.find(([k]) => k.toLowerCase() === 'votes')?.[1]
  const barCount = typeof votes === 'number' && votes > 0 ? Math.min(Math.round(votes), 11) : 4

  const [phase, setPhase] = useState<Phase>('title')
  const doneRef = useRef(false)
  const fireRef = useRef(false)

  const markDone = () => {
    if (doneRef.current) return
    doneRef.current = true
    onDone?.()
  }

  // Parent forces a skip (tap during the announcement) → land immediately.
  useEffect(() => {
    if (skipToEnd) setPhase('land')
  }, [skipToEnd])

  // Phase timeline — runs under reduced motion too (sequencing ≠ animation;
  // the CONTENT just renders without motion, see below).
  useEffect(() => {
    const ids: number[] = []
    if (phase === 'title') {
      ids.push(window.setTimeout(() => setPhase('count'), TITLE_MS))
    }
    if (phase === 'count') {
      ids.push(
        window.setTimeout(
          () => setPhase('land'),
          COUNT_UP_MS + barCount * BAR_STAGGER_MS + BAR_TAIL_MS
        )
      )
    }
    return () => ids.forEach((id) => clearTimeout(id))
  }, [phase, barCount])

  // Land beat: confetti + haptics + boom, exactly once.
  useEffect(() => {
    if (phase !== 'land' || fireRef.current) return
    fireRef.current = true
    if (celebrate) {
      fireConfettiBurst({ particleCount: 160, y: 0.5 })
      fireConfettiSides()
    }
    haptic([16, 40, 24])
    sfx.landBoom()
    markDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, celebrate])

  const running = phase === 'count'
  const count = useCountUp(running, reduced, COUNT_UP_MS)
  const shown = (v: number) => Math.round(v * count)
  const filled = reduced || phase !== 'title'

  return (
    <div
      className="w-full max-w-xl mx-auto flex flex-col items-center text-center"
      data-testid="group-announcement"
      data-phase={phase}
    >
      <AnimatePresence mode="wait">
        {/* ── 1. GROUP ANNOUNCEMENT title treatment ─────────────────── */}
        {phase === 'title' && (
          <motion.div
            key="ga-title"
            className="flex flex-col items-center gap-4"
            initial={{ opacity: 0, y: reduced ? 0 : 18 }}
            animate={{ opacity: 1, y: 0, transition: { duration: reduced ? 0 : 0.5, ease: easeOutExpo } }}
            exit={{ opacity: 0, y: reduced ? 0 : -14, transition: { duration: reduced ? 0 : 0.25 } }}
          >
            <div
              className="px-5 py-2.5 border-2 rounded-sm uppercase tracking-[0.3em] font-display font-bold text-display-lg"
              style={{
                borderColor: 'var(--red-alert)',
                color: 'var(--red-alert)',
                textShadow: '0 0 30px rgba(255,77,109,0.45)',
              }}
            >
              Group Announcement
            </div>
            <div className="text-[11px] uppercase tracking-[0.35em] text-white/50">the room voted</div>
          </motion.div>
        )}

        {/* ── 2. Vote bars + counting numbers ──────────────────────── */}
        {phase === 'count' && (
          <motion.div
            key="ga-count"
            className="w-full flex flex-col gap-6"
            initial={{ opacity: 0, scale: reduced ? 1 : 0.97 }}
            animate={{ opacity: 1, scale: 1, transition: { duration: reduced ? 0 : 0.4, ease: easeOutExpo } }}
          >
            <div
              className="text-[10px] uppercase tracking-[0.35em] font-semibold"
              style={{ color: 'var(--red-alert)' }}
            >
              Group Announcement
            </div>

            {/* anonymous vote bars — count only, NEVER names (spec §7) */}
            <div className="flex flex-col gap-2.5" data-testid="vote-bars">
              {Array.from({ length: barCount }, (_, i) => (
                <div key={i} className="h-2.5 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gradient-to-r from-lime-accent to-purple-primary"
                    data-testid="vote-bar-fill"
                    style={{
                      width: filled ? '100%' : '0%',
                      transition: reduced
                        ? 'none'
                        : `width 0.55s cubic-bezier(0.16, 1, 0.3, 1) ${i * BAR_STAGGER_MS}ms`,
                    }}
                  />
                </div>
              ))}
            </div>

            {/* count-up numbers from slide.numbers — tabular-nums */}
            {entries.length > 0 && (
              <div className="flex items-stretch justify-center gap-3 flex-wrap" data-testid="ga-numbers">
                {entries.map(([key, value]) => (
                  <div key={key} className="glass-card px-4 py-3 min-w-[92px] flex flex-col items-center gap-0.5">
                    <span
                      className="tabular-nums font-display font-bold text-display-lg text-lime-accent"
                      data-testid={`ga-num-${key.toLowerCase()}`}
                      style={{ textShadow: '0 0 22px rgba(239,180,255,0.45)' }}
                    >
                      {shown(value)}
                      {isPercentKey(key) ? '%' : ''}
                    </span>
                    <span className="text-[10px] uppercase tracking-[0.18em] text-white/55">
                      {prettyLabel(key)}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {slide.body && <p className="text-sm md:text-base text-white/70 max-w-md mx-auto">{slide.body}</p>}
          </motion.div>
        )}

        {/* ── 3. The subject LANDS full-screen ─────────────────────── */}
        {phase === 'land' && (
          <motion.div
            key="ga-land"
            className="flex flex-col items-center gap-5"
            initial={reduced ? { opacity: 1 } : { opacity: 0, scale: 0.55 }}
            animate={
              reduced
                ? { opacity: 1 }
                : { opacity: 1, scale: [0.55, 1.08, 1], transition: { duration: 0.55, ease: easeOutExpo } }
            }
          >
            <div className="text-[11px] uppercase tracking-[0.4em] text-white/50">the verdict</div>
            <div
              className="font-display font-bold text-center leading-[0.95] tracking-[-0.04em]"
              data-testid="ga-subject"
              data-confetti="land"
              style={{
                fontSize: 'clamp(3rem, 14vw, 7rem)',
                color: 'var(--white-text)',
                textShadow: '0 0 60px rgba(255,77,109,0.5), 0 0 24px rgba(239,180,255,0.25)',
              }}
            >
              {slide.title}
            </div>
            {slide.body && <p className="text-sm md:text-base text-white/70 max-w-md mx-auto">{slide.body}</p>}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
