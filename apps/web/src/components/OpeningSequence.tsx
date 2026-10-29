// components/OpeningSequence.tsx — the orchestrated intro:
// idle orb → press → circular wipe → words → flame → transition out.
// Verbatim from reference/ui-system.md §6 WITH ui-system-FIXES applied:
//   FIX 2 (partial — the sessionStorage gate lives in Agent A's app shell):
//     any tap DURING the sequence skips straight to onComplete.
//   FIX 4: wipe scales from Math.hypot(innerWidth, innerHeight)/40 (×1.1).
//   FIX 5: all setTimeout ids tracked in a ref + cleared on unmount, and
//     onComplete fires exactly once (guarded flag).
'use client'
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Flame } from './Flame'
import { AnimatedWords } from './AnimatedWords'
import { easeOutExpo } from '../lib/motion'
import { haptic } from './feedback'

type Beat = 'idle' | 'wipe' | 'words' | 'flame' | 'done'

export function OpeningSequence({ onComplete }: { onComplete: () => void }) {
  const [beat, setBeat] = useState<Beat>('idle')
  const [pressed, setPressed] = useState(false)
  const [wipeScale, setWipeScale] = useState(60)

  const timers = useRef<number[]>([])
  const doneRef = useRef(false)
  const startedRef = useRef(false)

  const complete = () => {
    if (doneRef.current) return // FIX 5 — fire exactly once
    doneRef.current = true
    onComplete()
  }

  const clearTimers = () => {
    timers.current.forEach((id) => clearTimeout(id))
    timers.current = []
  }

  const schedule = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms))
  }

  // FIX 5 — never let timers fire on a dead component.
  useEffect(() => () => clearTimers(), [])

  const handlePress = () => {
    if (startedRef.current) return
    startedRef.current = true

    haptic(10) // feature-detected — iOS Safari fails silently, that's fine

    // FIX 4 — size the wipe from the actual viewport (×1.1 safety margin).
    const scale =
      typeof window !== 'undefined' && typeof window.innerWidth === 'number'
        ? (Math.hypot(window.innerWidth, window.innerHeight) / 40) * 1.1
        : 60
    setWipeScale(scale)

    setPressed(true)
    setBeat('wipe')
    schedule(() => setBeat('words'), 650)
    schedule(() => setBeat('flame'), 2000)
    schedule(() => setBeat('done'), 3600)
    schedule(() => complete(), 4200)
  }

  // FIX 2 — any tap after the first press skips straight to onComplete.
  const handleSkip = () => {
    if (!startedRef.current || doneRef.current) return
    clearTimers()
    setBeat('done')
    complete()
  }

  return (
    <div
      className="fixed inset-0 flex items-center justify-center overflow-hidden"
      onPointerDown={handleSkip}
      data-testid="opening-sequence"
      data-beat={beat}
    >
      <AnimatePresence mode="wait">
        {beat === 'idle' && (
          <motion.button
            key="orb"
            onClick={handlePress}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="relative flex flex-col items-center gap-5 group"
            whileTap={{ scale: 0.9 }}
          >
            <div className="relative w-28 h-28 md:w-32 md:h-32 rounded-full glass-card flex items-center justify-center">
              <motion.div
                className="absolute inset-[-6px] rounded-full border border-lime-accent/40"
                animate={{ scale: [1, 1.08, 1], opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <motion.div
                className="w-full h-full rounded-full"
                animate={{ scale: [1, 1.02, 1] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              />
            </div>
            <span className="text-xs tracking-[0.2em] text-white/60 uppercase font-medium">
              Tap to begin
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Circular wipe mask transition (viewport-scaled — FIX 4) */}
      <AnimatePresence>
        {pressed && beat === 'wipe' && (
          <motion.div
            className="fixed rounded-full bg-purple-primary z-20"
            style={{ width: 40, height: 40 }}
            initial={{ scale: 0, opacity: 1 }}
            animate={{ scale: wipeScale, opacity: 1 }}
            transition={{ duration: 0.65, ease: easeOutExpo }}
          />
        )}
      </AnimatePresence>

      {/* Words beat */}
      <AnimatePresence>
        {beat === 'words' && (
          <motion.div
            key="words"
            className="fixed inset-0 flex items-center justify-center z-30 px-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
          >
            <AnimatedWords
              text="Who's ready to get spicy"
              highlightWord="spicy"
              className="text-display-lg md:text-display-xl text-center max-w-xl"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Flame beat */}
      <AnimatePresence>
        {beat === 'flame' && (
          <motion.div
            key="flame"
            className="fixed inset-0 flex items-center justify-center z-30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.3, transition: { duration: 0.4, ease: easeOutExpo } }}
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: [0, 1.15, 1] }}
              transition={{ duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
            >
              <Flame size={160} />
            </motion.div>
            {/* Lime vignette flash on flame impact */}
            <motion.div
              className="fixed inset-0 pointer-events-none"
              style={{ background: 'radial-gradient(circle, transparent 40%, rgba(182,255,60,0.15) 100%)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.6, 0] }}
              transition={{ duration: 0.5, delay: 0.3 }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Skip hint (FIX 2) */}
      {pressed && !doneRef.current && beat !== 'done' && (
        <span
          className="absolute bottom-10 left-0 right-0 text-center text-[11px] uppercase tracking-[0.25em] text-white/40"
          data-testid="skip-hint"
        >
          tap to skip
        </span>
      )}
    </div>
  )
}
