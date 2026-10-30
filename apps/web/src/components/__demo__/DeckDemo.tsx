// __demo__/DeckDemo.tsx — demonstrates the 3-card demo deck:
// hold-to-reveal (mouse AND touch), release re-hides, tap/swipe navigates,
// no long-press callout menu (handled inside HoldToReveal).
'use client'
import { useState } from 'react'
import { AnimatePresence } from 'framer-motion'
import { SecretDeck } from '../SecretDeck'
import { GlowButton } from '../GlowButton'
import { demoDeck } from './demoDeck'

export function DeckDemo() {
  const [open, setOpen] = useState(false)
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center gap-8 px-6">
      <div className="text-center flex flex-col gap-3">
        <h2 className="font-display font-bold text-display-lg text-white">Secret deck demo</h2>
        <p className="text-sm text-white/65 max-w-sm">
          Face-down, one phone only. Press and hold a card to open it — release hides it
          again. Quick tap = next card, swipe works too.
        </p>
      </div>
      <div className="glass-card px-5 py-4 text-center text-sm text-lime-accent" data-testid="deck-entry-demo">
        You have {demoDeck.cards.length} secrets — only on this phone.
      </div>
      <GlowButton onClick={() => setOpen(true)}>Open your secret deck</GlowButton>
      <AnimatePresence>
        {open && <SecretDeck deck={demoDeck} onClose={() => setOpen(false)} />}
      </AnimatePresence>
    </div>
  )
}
