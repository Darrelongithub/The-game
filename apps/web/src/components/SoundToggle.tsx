// components/SoundToggle.tsx — mute toggle for the header (48×48 touch target,
// spec §11.3). WebAudio stings are synthesized in ./sound; this flips muted
// state which broadcasts to every subscriber (and persists to localStorage).
'use client'
import { useSyncExternalStore } from 'react'
import { isMuted, setMuted, subscribeMuted } from './sound'
import { clsx } from 'clsx'

const serverSnapshot = () => false

export function useMuted(): boolean {
  return useSyncExternalStore(subscribeMuted, isMuted, serverSnapshot)
}

export function SoundToggle({ className }: { className?: string }) {
  const muted = useMuted()
  return (
    <button
      type="button"
      onClick={() => setMuted(!muted)}
      aria-pressed={muted}
      aria-label={muted ? 'Unmute sound' : 'Mute sound'}
      data-testid="sound-toggle"
      data-muted={muted ? '1' : '0'}
      className={clsx(
        'min-w-[48px] min-h-[48px] rounded-full glass-card flex items-center justify-center text-white/85',
        'hover:text-white transition-colors',
        className
      )}
    >
      {muted ? (
        // muted: speaker with slash
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M4 9v6h4l5 4V5L8 9H4z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M16.5 9.5l5 5m0-5l-5 5" stroke="#ff4d6d" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      ) : (
        // unmuted: speaker with waves
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path d="M4 9v6h4l5 4V5L8 9H4z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
          <path d="M16 9.5a4 4 0 0 1 0 5" stroke="#efb4ff" strokeWidth="1.7" strokeLinecap="round" />
          <path d="M18.5 7a7.5 7.5 0 0 1 0 10" stroke="#efb4ff" strokeWidth="1.7" strokeLinecap="round" />
        </svg>
      )}
    </button>
  )
}
