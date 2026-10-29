// __demo__/SignaturePreview.tsx — standalone harness page (Agent B2's live
// demo). Tabs: INTRO (OpeningSequence with tap-skip) · FINALE (full story) ·
// SECRETS (hold-to-reveal deck). Includes a mute toggle in the header.
// The real app mounts these components from Agent A's shell; this page exists
// so the signature layer can run and be verified on its own.
'use client'
import { useState } from 'react'
import { OpeningSequence } from '../OpeningSequence'
import { SoundToggle } from '../SoundToggle'
import { FinaleDemo } from './FinaleDemo'
import { DeckDemo } from './DeckDemo'
import { clsx } from 'clsx'

type Tab = 'intro' | 'finale' | 'secrets'

function Backdrop() {
  return (
    <div className="fixed inset-0 overflow-hidden -z-10" style={{ background: 'var(--bg-base, #0d0617)' }} aria-hidden>
      <div
        className="blob w-[50vw] h-[50vw] top-[-10%] left-[-10%]"
        style={{ background: 'radial-gradient(circle, var(--purple-primary, #8b2fe0), transparent 70%)', animation: 'drift1 18s ease-in-out infinite' }}
      />
      <div
        className="blob w-[45vw] h-[45vw] bottom-[-15%] right-[-10%]"
        style={{ background: 'radial-gradient(circle, var(--blue-secondary, #2f5fe0), transparent 70%)', animation: 'drift2 22s ease-in-out infinite' }}
      />
      <div
        className="blob w-[30vw] h-[30vw] top-[30%] left-[40%] opacity-40"
        style={{ background: 'radial-gradient(circle, var(--purple-deep, #4c1d95), transparent 70%)', animation: 'drift1 25s ease-in-out infinite reverse' }}
      />
    </div>
  )
}

export function SignaturePreview() {
  const [tab, setTab] = useState<Tab>('intro')
  const [introRun, setIntroRun] = useState(0)
  const [introDone, setIntroDone] = useState(false)

  return (
    <div className="min-h-[100dvh] text-white">
      <Backdrop />

      {/* header — title + mute toggle (spec: mute toggle in the header) */}
      <header className="fixed top-0 inset-x-0 z-40 flex items-center justify-between px-4 py-3">
        <span className="font-display font-bold uppercase tracking-[0.2em] text-xs text-white/70">
          B2 · signature layer
        </span>
        <SoundToggle />
      </header>

      {/* tab bar */}
      <nav className="fixed bottom-0 inset-x-0 z-40 flex justify-center gap-2 px-4 py-4" role="tablist">
        {(['intro', 'finale', 'secrets'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={clsx(
              'min-h-[48px] px-5 rounded-full text-xs uppercase tracking-[0.18em] font-medium transition-colors',
              tab === t
                ? 'bg-gradient-to-r from-purple-primary to-blue-secondary text-white'
                : 'glass-card text-white/70 hover:text-white'
            )}
            data-testid={`tab-${t}`}
          >
            {t === 'intro' ? 'intro' : t === 'finale' ? 'finale story' : 'secrets'}
          </button>
        ))}
      </nav>

      <main className="pt-14 pb-20 min-h-[100dvh]">
        {tab === 'intro' && (
          <div className="relative min-h-[calc(100dvh-8rem)]">
            {!introDone ? (
              <OpeningSequence
                key={introRun}
                onComplete={() => setIntroDone(true)}
              />
            ) : (
              <div className="fixed inset-0 flex flex-col items-center justify-center gap-6 px-6">
                <p className="text-sm text-white/60">Intro complete (once per session is Agent A’s gate).</p>
                <button
                  onClick={() => {
                    setIntroDone(false)
                    setIntroRun((r) => r + 1)
                  }}
                  className="min-h-[48px] px-6 rounded-2xl glass-card text-white text-sm uppercase tracking-[0.18em]"
                >
                  replay intro
                </button>
              </div>
            )}
          </div>
        )}
        {tab === 'finale' && <FinaleDemo />}
        {tab === 'secrets' && <DeckDemo />}
      </main>
    </div>
  )
}
