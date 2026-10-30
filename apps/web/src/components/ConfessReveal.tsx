// components/ConfessReveal.tsx — the CONFESS round's payoff.
//
// Two voices, two tiers, one hard rule: a NO is a NUMBER, forever.
//
//   WARM (warmup)      counts only. "4 of 7 said yes." No names, no hints — at
//                      this heat the room has not earned attribution yet.
//   SPICY (spicy/deep) YES answers only, by alias. A no is never named in any
//                      tier, and a note written next to a no stays anonymous.
//
// Missing answers are shown as missing: a pocketed phone never becomes a no.
'use client'
import React from 'react'
import type { ConfessRevealView } from '../../../../packages/shared/src/contracts.ts'
import { GlassCard } from './GlassCard'

export function ConfessReveal({ confess }: { confess: ConfessRevealView }) {
  const warm = confess.tier === 'warm'
  const attributed = confess.attributed ?? []
  const notes = confess.notes ?? []
  return (
    <main
      className="mx-auto flex min-h-[100dvh] w-full max-w-2xl flex-col justify-center gap-5 px-4 py-8 text-white"
      style={{ color: 'var(--white-text)' }}
      data-testid="confess-reveal"
      data-tier={confess.tier}
    >
      <p className="text-xs font-bold uppercase tracking-[.25em] text-lime-accent">
        {warm ? 'Confessions · counts only' : 'Confessions · yeses only'}
      </p>
      <h1 className="font-display font-bold leading-tight" style={{ fontSize: 'clamp(2rem, 9vw, 4rem)' }}>
        {confess.yes} of {confess.of} said yes.
      </h1>
      <p className="text-sm leading-relaxed text-white/65">
        {warm
          ? 'Nobody is named at this heat. The room gets the number and nothing else.'
          : 'Only the yeses are named. A no stays a number, forever.'}
      </p>
      {!warm && attributed.length > 0 && (
        <div className="grid gap-3" data-testid="confess-attributed">
          {attributed.map((entry) => (
            <GlassCard key={entry.alias}>
              <p className="text-sm font-bold text-lime-accent">{entry.alias}</p>
              <p className="mt-1 break-words">{entry.note ?? 'Said yes.'}</p>
            </GlassCard>
          ))}
        </div>
      )}
      {notes.length > 0 && (
        <div className="grid gap-3" data-testid="confess-notes">
          {notes.map((note, index) => (
            <GlassCard key={`${index}-${note.text}`}>
              <p className="text-sm text-white/60">{note.alias ? `${note.alias} wrote:` : 'Someone wrote:'}</p>
              <p className="mt-1 break-words">“{note.text}”</p>
            </GlassCard>
          ))}
        </div>
      )}
      {confess.missing > 0 && (
        <p className="text-xs text-white/45">
          {confess.missing} {confess.missing === 1 ? 'phone' : 'phones'} stayed quiet — a missing answer is not a no.
        </p>
      )}
    </main>
  )
}
