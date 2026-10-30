// components/FinaleScreen.tsx — the payoff: a Wrapped-style story player for
// the broadcast-safe FinaleView (spec §7).
//
//   • Full-screen slides; tap / space / arrow to advance (arrow-left steps back)
//   • Top progress bar + slide counter + mute toggle in the header
//   • Beat styling: tease (small, dim) → escalate (bigger, heat-colored) →
//     land (full-screen, huge type + Flame + lime/purple confetti + haptics)
//   • flavor styling: quote (giant quotation marks + attribution),
//     dodge (red-alert stamp), stat (tabular-nums big number),
//     group → <GroupAnnouncement> (the room's verdict)
//   • Closing slide (always the LAST slide) → end panel: ShareCard →
//     secret deck entry point ("You have N secrets — only on this phone.")
//   • prefers-reduced-motion: confetti + transforms die (MotionConfig "user"
//     + explicit gates); content still sequences through.
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, MotionConfig } from 'framer-motion'
import type { FinaleSlide, FinaleView, SecretDeckView } from '../../../../packages/shared/src/contracts.ts'
import { easeOutExpo, pageVariants } from '../lib/motion'
import { AnimatedWords } from './AnimatedWords'
import { Flame } from './Flame'
import { GlassCard } from './GlassCard'
import { GlowButton } from './GlowButton'
import { GroupAnnouncement } from './GroupAnnouncement'
import { SecretDeck } from './SecretDeck'
import { ShareCard } from './ShareCard'
import { SoundToggle } from './SoundToggle'
import { fireConfettiBurst, haptic, usePrefersReducedMotion } from './feedback'
import { sfx } from './sound'

/* ── small helpers ──────────────────────────────────────────────────── */

function useCountUp(target: number, run: boolean, reduced: boolean, durationMs = 750): number {
  const [p, setP] = useState(reduced ? 1 : 0)
  useEffect(() => {
    if (reduced) {
      setP(1)
      return
    }
    if (!run) return
    let raf = 0
    const start = performance.now()
    const tick = () => {
      const t = Math.min(1, (performance.now() - start) / durationMs)
      setP(1 - Math.pow(1 - t, 3))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, run, reduced, durationMs])
  return p
}

function statEntry(slide: FinaleSlide): [string, number] | null {
  const e = Object.entries(slide.numbers ?? {})[0]
  return e ? [e[0], e[1]] : null
}

const STAT_UNIT: Record<string, string> = {
  ms: 'ms',
  seconds: 's',
  sec: 's',
  count: '',
  points: 'pts',
}

/* ── slide renderers ────────────────────────────────────────────────── */

function TitleSlide({ slide }: { slide: FinaleSlide }) {
  return (
    <div className="flex flex-col items-center gap-5 max-w-xl" data-flavor="title">
      <AnimatedWords
        text={slide.title}
        className="text-display-lg md:text-display-xl text-center"
      />
      {slide.body && <p className="text-base md:text-lg text-white/70">{slide.body}</p>}
    </div>
  )
}

function QuoteSlide({ slide }: { slide: FinaleSlide }) {
  const titleIsLabel = slide.title.toLowerCase().includes('quote')
  return (
    <div className="relative flex flex-col items-center gap-4 max-w-2xl px-2" data-flavor="quote">
      {/* giant quotation marks */}
      <span
        aria-hidden
        className="pointer-events-none absolute select-none font-display font-bold leading-none"
        style={{
          fontSize: 'clamp(9rem, 30vw, 17rem)',
          color: 'var(--purple-primary)',
          opacity: 0.35,
          top: '-22%',
          left: '-6%',
        }}
      >
        “
      </span>
      <span
        aria-hidden
        className="pointer-events-none absolute select-none font-display font-bold leading-none"
        style={{
          fontSize: 'clamp(9rem, 30vw, 17rem)',
          color: 'var(--purple-primary)',
          opacity: 0.35,
          bottom: '-34%',
          right: '-4%',
        }}
      >
        ”
      </span>

      <span className="relative text-[10.5px] uppercase tracking-[0.35em] text-lime-accent">
        quote of the night
      </span>
      <p
        className="relative font-display italic font-semibold text-white text-display-lg text-center"
        data-testid="quote-body"
      >
        {slide.body ? `“${slide.body.replace(/^[“"]|[”"]$/g, '')}”` : slide.title}
      </p>
      {!titleIsLabel && slide.body && (
        <span className="relative text-sm tracking-wide text-lime-accent" data-testid="quote-attribution">
          — {slide.title}
        </span>
      )}
    </div>
  )
}

function DodgeSlide({ slide }: { slide: FinaleSlide }) {
  return (
    <div className="flex flex-col items-center gap-6 max-w-xl" data-flavor="dodge">
      <span
        className="text-[10.5px] uppercase tracking-[0.35em] font-semibold"
        style={{ color: 'var(--red-alert)' }}
      >
        dodge report
      </span>
      <div className="relative">
        <div
          className="px-7 py-3 border-[3.5px] rounded-md rotate-[-8deg] font-display font-bold uppercase tracking-[0.3em] text-heading"
          style={{
            borderColor: 'var(--red-alert)',
            color: 'var(--red-alert)',
            textShadow: '0 0 26px rgba(255,77,109,0.5)',
            boxShadow: '0 0 34px -8px rgba(255,77,109,0.55)',
          }}
          data-testid="dodge-stamp"
        >
          dodged
        </div>
      </div>
      <div className="flex flex-col items-center gap-2">
        <span className="font-display font-bold text-white text-display-lg text-center">{slide.title}</span>
        {slide.body && (
          <p
            className="text-base md:text-lg italic text-white/85 pl-4 text-center"
            style={{ borderLeft: '3px solid var(--red-alert)' }}
          >
            {slide.body}
          </p>
        )}
      </div>
    </div>
  )
}

function StatSlide({ slide, reduced }: { slide: FinaleSlide; reduced: boolean }) {
  const entry = statEntry(slide)
  const p = useCountUp(entry ? entry[1] : 0, Boolean(entry), reduced)
  const value = entry ? Math.round(entry[1] * p) : null
  const unit = entry ? (STAT_UNIT[entry[0].toLowerCase()] ?? '') : ''
  return (
    <div className="flex flex-col items-center gap-4 max-w-xl" data-flavor="stat">
      <span className="text-[10.5px] uppercase tracking-[0.35em] text-lime-accent">{slide.title}</span>
      {value !== null ? (
        <span
          className="tabular-nums font-display font-bold text-lime-accent leading-none"
          style={{ fontSize: 'clamp(4rem, 18vw, 8rem)', textShadow: '0 0 60px rgba(182,255,60,0.4)' }}
          data-testid="stat-number"
        >
          {value}
          <span className="text-display-lg align-top ml-1 text-white/70">{unit}</span>
        </span>
      ) : (
        <span className="text-display-xl font-display font-bold text-white">{slide.body}</span>
      )}
      {slide.body && value !== null && (
        <p className="text-sm md:text-base text-white/70 text-center max-w-sm">{slide.body}</p>
      )}
    </div>
  )
}

/* ── the screen ─────────────────────────────────────────────────────── */

export function FinaleScreen({
  view,
  deck,
  roomCode,
  onStoryEnd,
  onExit,
  className = '',
}: {
  view: FinaleView
  deck?: SecretDeckView
  roomCode?: string
  /** Fires exactly once when the story reaches the end panel. */
  onStoryEnd?: () => void
  /** Fires when the player presses Done on the end panel. */
  onExit?: () => void
  className?: string
}) {
  const slides = view.slides ?? []
  const total = slides.length
  const [index, setIndex] = useState(0)
  const [finished, setFinished] = useState(false)
  const [groupDone, setGroupDone] = useState(false)
  const [forceGroup, setForceGroup] = useState(false)
  const [deckOpen, setDeckOpen] = useState(false)
  const storyEndRef = useRef(false)
  const reduced = usePrefersReducedMotion()

  const slide: FinaleSlide | undefined = slides[index]
  const isLast = index >= total - 1
  const pct = finished || total === 0 ? 100 : ((index + 1) / total) * 100

  /* advance / back ─────────────────────────────────────────────────── */
  const advance = useCallback(() => {
    if (finished || !slide || deckOpen) return
    if (slide.flavor === 'group' && !groupDone) {
      // First tap completes the announcement (bars → land); next tap advances.
      setForceGroup(true)
      return
    }
    if (isLast) {
      setFinished(true)
      sfx.revealSwell()
      haptic([12, 30, 16])
      if (!storyEndRef.current) {
        storyEndRef.current = true
        onStoryEnd?.()
      }
      return
    }
    sfx.submitTick()
    setIndex((i) => Math.min(i + 1, total - 1))
  }, [finished, slide, deckOpen, groupDone, isLast, total, onStoryEnd])

  const back = useCallback(() => {
    if (finished || deckOpen || index === 0) return
    sfx.submitTick()
    setIndex((i) => Math.max(i - 1, 0))
  }, [finished, deckOpen, index])

  /* keyboard: space / arrows (spec: tap/space/arrow to advance) ────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const tag = target?.tagName
      // Never hijack typing, and let a focused button own space/enter.
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const buttonOwns = (e.key === ' ' || e.key === 'Enter') && tag === 'BUTTON'
      if (buttonOwns || finished) return
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault()
        advance()
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [advance, back, finished])

  /* land beats (claim/stat/quote/dodge land — NOT group, it self-fires) ─ */
  useEffect(() => {
    if (finished) return
    const s = slides[index]
    if (!s || s.beat !== 'land' || s.flavor === 'group') return
    fireConfettiBurst({ particleCount: 175, spread: 88 })
    haptic([14, 36, 20])
    sfx.landBoom()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, finished])

  /* reveal swell on mount — the story begins */
  useEffect(() => {
    sfx.revealSwell()
  }, [])

  /* reset group-skip flags on slide change */
  useEffect(() => {
    setGroupDone(false)
    setForceGroup(false)
  }, [index])

  const secretCount = deck?.cards.length ?? 0

  if (total === 0) {
    return (
      <div className={`fixed inset-0 flex items-center justify-center text-white/60 ${className}`} data-testid="finale-screen">
        The finale is being assembled…
      </div>
    )
  }

  /* ── slide body by beat + flavor ──────────────────────────────────── */
  const renderSlideBody = () => {
    if (!slide) return null

    if (slide.flavor === 'group') {
      return (
        <div className="w-full flex justify-center px-1" data-flavor="group">
          <GroupAnnouncement
            slide={slide}
            skipToEnd={forceGroup}
            onDone={() => setGroupDone(true)}
          />
        </div>
      )
    }
    if (slide.flavor === 'quote') return <QuoteSlide slide={slide} />
    if (slide.flavor === 'dodge') return <DodgeSlide slide={slide} />
    if (slide.flavor === 'stat') return <StatSlide slide={slide} reduced={reduced} />

    // claim flavor (or a bare slide) — the beat decides size/heat
    if (slide.beat === 'tease') {
      return (
        <div className="flex flex-col items-center gap-4 max-w-md" data-flavor="claim" data-beat="tease">
          <span className="text-[10.5px] uppercase tracking-[0.35em] text-white/45">{slide.title}</span>
          {slide.body && <p className="text-base md:text-lg text-white/70">{slide.body}</p>}
        </div>
      )
    }
    if (slide.beat === 'escalate') {
      return (
        <div className="flex flex-col items-center gap-5 max-w-2xl" data-flavor="claim" data-beat="escalate">
          <span className="text-[10.5px] uppercase tracking-[0.35em] text-white/50">it’s heating up</span>
          <h2
            className="font-display font-bold text-lime-accent text-display-lg text-center"
            style={{ textShadow: '0 0 34px rgba(182,255,60,0.35)' }}
          >
            {slide.title}
          </h2>
          {slide.body && <p className="text-base md:text-xl text-white/85">{slide.body}</p>}
        </div>
      )
    }
    // land
    return (
      <div className="flex flex-col items-center gap-6 max-w-3xl" data-flavor="claim" data-beat="land">
        <Flame size={116} />
        <h2
          className="font-display font-bold text-center leading-[0.95] tracking-[-0.04em] bg-gradient-to-b from-white via-lime-accent to-purple-primary bg-clip-text text-transparent"
          style={{ fontSize: 'clamp(2.6rem, 9vw, 5.2rem)' }}
        >
          {slide.title}
        </h2>
        {slide.body && <p className="text-lg md:text-xl text-white/90 text-center">{slide.body}</p>}
      </div>
    )
  }

  /* claim with beat but no flavor → treat as claim path above; handle the
     pure title slide (first slide, no flavor) via TitleSlide: */
  const isBareTitle = !slide?.flavor && index === 0

  return (
    <MotionConfig reducedMotion="user">
      <div
        className={`fixed inset-0 flex flex-col overflow-hidden ${className}`}
        style={{ background: 'rgba(13,6,23,0.94)', color: 'var(--white-text)' }}
        data-testid="finale-screen"
        data-index={index}
        data-finished={finished ? '1' : '0'}
      >
        {/* ── header: progress bar + counter + mute ───────────────────── */}
        <div className="absolute top-0 inset-x-0 z-20 px-4 pt-3 pb-2">
          <div className="flex items-center gap-3">
            <div
              className="flex-1 h-1.5 rounded-full bg-white/10 overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              data-testid="finale-progress"
            >
              <motion.div
                className="h-full rounded-full bg-gradient-to-r from-lime-accent to-purple-primary"
                initial={false}
                animate={{ width: `${pct}%` }}
                transition={{ duration: reduced ? 0 : 0.4, ease: easeOutExpo }}
              />
            </div>
            <span className="tabular-nums text-[11px] text-white/50" data-testid="finale-counter">
              {finished ? total : Math.min(index + 1, total)} / {total}
            </span>
            <SoundToggle className="shrink-0" />
          </div>
        </div>

        {!finished ? (
          /* ── story ─────────────────────────────────────────────────── */
          <div
            className="flex-1 flex items-center justify-center px-6 pt-16 pb-16 relative select-none"
            onClick={advance}
            data-testid="finale-tap-layer"
          >
            <AnimatePresence mode="wait">
              <motion.div
                key={index}
                variants={pageVariants}
                initial="initial"
                animate="animate"
                exit="exit"
                className="w-full flex flex-col items-center text-center"
              >
                {slide && (isBareTitle ? <TitleSlide slide={slide} /> : renderSlideBody())}
              </motion.div>
            </AnimatePresence>

            {/* tap hint */}
            {!finished && (
              <motion.span
                className="absolute bottom-6 left-0 right-0 text-center text-[11px] uppercase tracking-[0.3em] text-white/40 pointer-events-none"
                animate={reduced ? undefined : { opacity: [0.35, 0.8, 0.35] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
                data-testid="finale-hint"
              >
                {slide?.flavor === 'group' && !groupDone ? 'tap to land it' : isLast ? 'tap to finish' : 'tap to continue'}
              </motion.span>
            )}
          </div>
        ) : (
          /* ── end panel: share card → secrets → done ────────────────── */
          <div
            className="flex-1 overflow-y-auto flex flex-col items-center justify-center gap-6 px-6 pt-20 pb-10"
            data-testid="finale-end"
          >
            <AnimatedWords
              text="The room has spoken"
              highlightWord="spoken"
              className="text-display-lg text-center"
            />
            <ShareCard view={view} roomCode={roomCode} />

            {secretCount > 0 && (
              <GlassCard className="w-full max-w-[340px] !p-5 flex flex-col items-center gap-3 text-center">
                <p className="text-sm text-white/85" data-testid="secrets-entry">
                  You have {secretCount} secret{secretCount === 1 ? '' : 's'} — only on this phone.
                </p>
                <GlowButton variant="accent" onClick={() => setDeckOpen(true)}>
                  Open your secret deck
                </GlowButton>
              </GlassCard>
            )}

            <GlowButton onClick={() => { sfx.submitTick(); onExit?.() }}>
              Done
            </GlowButton>
          </div>
        )}

        {/* secret deck overlay (ONE phone only) */}
        {deckOpen && deck && <SecretDeck deck={deck} onClose={() => setDeckOpen(false)} />}
      </div>
    </MotionConfig>
  )
}
