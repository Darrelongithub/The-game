// components/SecretDeck.tsx — the private card deck (ONE phone only).
// Unlocks after the public finale story ends, for players with secrets only
// (spec §7). Cards are face-down; HoldToReveal handles press-and-hold, tap and
// swipe. Face content never mounts while face-down. Card faces show the kind
// chip ONLY while revealed — the face-down card is pure glass + grain + glyph.
'use client'
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  SECRET_DECK_MAX,
  type SecretCard,
  type SecretDeckView,
} from '../../../../packages/shared/src/contracts.ts'
import { HoldToReveal } from './HoldToReveal'
import { usePrefersReducedMotion } from './feedback'
import { sfx } from './sound'

const KIND_LABEL: Record<SecretCard['kind'], string> = {
  crush: 'MUTUAL CRUSH',
  blindspot: 'BLIND SPOT',
  lookchain: 'LOOK CHAIN',
}

function CardFace({ card, index, total }: { card: SecretCard; index: number; total: number }) {
  return (
    <div className="absolute inset-0 p-6 flex flex-col gap-3 text-left" data-testid="secret-face">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.22em] px-2.5 py-1 rounded-full border border-white/40 text-white/90">
          {KIND_LABEL[card.kind]}
        </span>
        <span className="tabular-nums text-[11px] text-white/70">
          {index + 1} / {total}
        </span>
      </div>
      <div className="font-display font-bold text-white leading-tight text-heading">{card.title}</div>
      <div className="flex flex-col gap-2.5 mt-1">
        {card.facts.map((fact, i) => (
          <p key={i} className="text-[13.5px] leading-snug text-white/90">
            {fact}
          </p>
        ))}
      </div>
      <span className="mt-auto text-[9.5px] uppercase tracking-[0.2em] text-white/60">
        release to hide · tap for next
      </span>
    </div>
  )
}

export function SecretDeck({ deck, onClose }: { deck: SecretDeckView; onClose?: () => void }) {
  const reduced = usePrefersReducedMotion()
  const cards = deck.cards.slice(0, SECRET_DECK_MAX)
  const [index, setIndex] = useState(0)
  const [flip, setFlip] = useState(0) // increments to re-key the face animation

  if (cards.length === 0) return null
  const card = cards[Math.min(index, cards.length - 1)]

  const go = (dir: 1 | -1) => {
    setIndex((i) => (i + dir + cards.length) % cards.length)
    setFlip((f) => f + 1)
    sfx.submitTick()
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex flex-col items-center justify-between px-5 pt-5 pb-7"
      style={{ background: 'rgba(13,6,23,0.97)' }}
      initial={reduced ? { opacity: 1 } : { opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: reduced ? 0 : 0.25 } }}
      exit={reduced ? { opacity: 1 } : { opacity: 0, transition: { duration: 0.2 } }}
      data-testid="secret-deck"
    >
      {/* header */}
      <div className="w-full max-w-md flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path d="M7 10V7a5 5 0 0 1 10 0v3" stroke="#efb4ff" strokeWidth="2" strokeLinecap="round" />
              <rect x="4.7" y="10" width="14.6" height="10.3" rx="2.6" stroke="#efb4ff" strokeWidth="2" />
            </svg>
            <span className="font-display font-bold uppercase tracking-[0.18em] text-sm text-white">
              Your secret deck
            </span>
          </div>
          <span className="text-[11px] uppercase tracking-[0.16em] text-white/50" data-testid="deck-privacy">
            {cards.length} card{cards.length === 1 ? '' : 's'} · only on this phone
          </span>
        </div>
        <button
          onClick={() => {
            sfx.submitTick()
            onClose?.()
          }}
          aria-label="Close secret deck"
          className="min-w-[48px] min-h-[48px] rounded-full glass-card text-white/80 text-lg leading-none flex items-center justify-center"
          data-testid="deck-close"
        >
          ✕
        </button>
      </div>

      {/* card */}
      <div className="flex-1 flex items-center justify-center w-full py-4">
        <AnimatePresence mode="wait">
          <HoldToReveal
            key={`${card.id}-${flip}`}
            cardLabel={`${KIND_LABEL[card.kind]} · ${Math.min(index + 1, cards.length)} of ${cards.length}`}
            onAdvance={go}
            face={<CardFace card={card} index={Math.min(index, cards.length - 1)} total={cards.length} />}
          />
        </AnimatePresence>
      </div>

      {/* dots — 48×48 hit areas (spec §11.3), visual dot inside */}
      <div className="flex items-center justify-center" data-testid="deck-dots">
        {cards.map((c, i) => (
          <button
            key={c.id}
            aria-label={`Go to card ${i + 1}`}
            onClick={() => {
              setIndex(i)
              setFlip((f) => f + 1)
              sfx.submitTick()
            }}
            className="min-w-[48px] min-h-[48px] flex items-center justify-center"
          >
            <span
              className="block rounded-full transition-all"
              style={{
                width: i === index ? 26 : 8,
                height: 8,
                background: i === index ? 'var(--lime-accent)' : 'rgba(245,243,255,0.28)',
              }}
            />
          </button>
        ))}
      </div>

      <div className="text-[10px] uppercase tracking-[0.24em] text-white/35 mt-3">
        hold a card to peek · release to hide it again
      </div>
    </motion.div>
  )
}
