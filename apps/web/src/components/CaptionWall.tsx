// components/CaptionWall.tsx — the spotlight reveal (ROUND 3).
//
// A RAPID CAPTION WALL: the room's one-liners stack one after another in big
// type under the subject's alias, and then the subject's OWN decoy answer lands
// LAST and biggest — the punchline. Nothing here prints the question: the wall
// is the joke, the prompt never is.
//
// Design rules (reference/ui-system.md):
//   • fluid type via clamp() so 320px phones and tablets both work
//   • framer-motion stagger, killed entirely by prefers-reduced-motion
//   • glass cards, grain and a soft purple accent for the punchline
'use client'
import React from 'react'
import { motion } from 'framer-motion'
import type { RevealItem } from '../../../../packages/shared/src/contracts.ts'
import { easeOutExpo } from '../lib/motion'
import { usePrefersReducedMotion } from './feedback'

const STAGGER_MS = 120
const PUNCH_DELAY_MS = 320

export function CaptionWall({
  subject,
  captions,
  punchline,
}: {
  subject: string
  captions: RevealItem[]
  punchline?: string
}) {
  const reduced = usePrefersReducedMotion()
  const punchDelay = reduced ? 0 : (captions.length * STAGGER_MS + PUNCH_DELAY_MS) / 1000

  return (
    <main
      className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col gap-5 px-4 py-8 text-white"
      style={{ color: 'var(--white-text)' }}
      data-testid="caption-wall"
      data-reduced={reduced ? 'true' : 'false'}
    >
      <header className="flex flex-col gap-1">
        <span className="text-[11px] font-bold uppercase tracking-[0.35em]" style={{ color: 'var(--lime-accent)' }}>
          Live · the caption wall
        </span>
        <h1
          className="font-display font-bold leading-[0.95] tracking-[-0.04em] break-words"
          style={{ fontSize: 'clamp(1.9rem, 9vw, 3.4rem)', textShadow: '0 0 40px rgba(139,47,224,0.45)' }}
          data-testid="caption-subject"
        >
          {subject}
        </h1>
        <p className="text-sm text-white/55">while everyone watched</p>
      </header>

      <ul className="flex flex-col gap-2.5" data-testid="caption-stack">
        {captions.map((caption, index) => (
          <motion.li
            key={`${reduced ? 'still' : 'animated'}-${index}-${caption.alias}`}
            className="glass-card min-w-0 break-words px-4 py-3"
            data-testid="caption-item"
            initial={reduced ? false : { opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: reduced ? 0 : 0.32, delay: reduced ? 0 : index * (STAGGER_MS / 1000), ease: easeOutExpo }}
          >
            <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-white/45">{caption.alias}</span>
            <p className="mt-1 break-words" style={{ fontSize: 'clamp(1rem, 4.4vw, 1.35rem)', lineHeight: 1.25 }}>
              {caption.text}
            </p>
          </motion.li>
        ))}
      </ul>

      {punchline && (
        <motion.section
          key={reduced ? 'still' : 'animated'}
          className="mt-auto rounded-2xl border px-4 py-6"
          data-testid="caption-punchline"
          style={{ borderColor: 'var(--lime-accent)', background: 'rgba(239,180,255,0.06)' }}
          initial={reduced ? false : { opacity: 0, scale: 0.94 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, scale: [0.94, 1.02, 1] }}
          transition={{ duration: reduced ? 0 : 0.5, delay: punchDelay, ease: easeOutExpo }}
        >
          <p className="text-[10px] font-bold uppercase tracking-[0.3em]" style={{ color: 'var(--lime-accent)' }}>
            {subject} wrote
          </p>
          <p
            className="mt-2 break-words font-display font-bold leading-[1.05] tracking-[-0.02em]"
            style={{ fontSize: 'clamp(1.6rem, 8vw, 3rem)', color: 'var(--lime-accent)' }}
          >
            “{punchline}”
          </p>
        </motion.section>
      )}
    </main>
  )
}
