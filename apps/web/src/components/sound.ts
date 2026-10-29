// components/sound.ts — WebAudio-synthesized stings ONLY (no audio assets, no
// network). Unlocks on the first user gesture (autoplay policies), mute toggle
// persists to localStorage and broadcasts via subscribeMuted.
//
// Stings: submit tick · reveal swell · land boom · secret card flip.
'use client'

export type Sting = 'tick' | 'swell' | 'boom' | 'flip'

const MUTE_KEY = 'reveal-muted'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noiseBuffer: AudioBuffer | null = null
let muted: boolean = readMuted()
const subscribers = new Set<() => void>()

function readMuted(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}

export function isMuted(): boolean {
  return muted
}

export function setMuted(value: boolean): void {
  muted = value
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(MUTE_KEY, value ? '1' : '0')
  } catch {
    /* private mode etc. */
  }
  subscribers.forEach((fn) => fn())
}

/** Subscribe to mute changes (for React, pair with useSyncExternalStore). */
export function subscribeMuted(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

/**
 * Create/resume the AudioContext — must run inside a user gesture on mobile.
 * Safe to call repeatedly; a no-op when WebAudio is unavailable (jsdom, SSR).
 */
export function unlockAudio(): void {
  if (typeof window === 'undefined') return
  try {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    if (!ctx) {
      ctx = new AC()
      master = ctx.createGain()
      master.gain.value = 0.85
      master.connect(ctx.destination)
    }
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {})
    }
  } catch {
    /* audio is a luxury, never a blocker */
  }
}

function getNoise(): AudioBuffer | null {
  if (!ctx) return null
  if (noiseBuffer) return noiseBuffer
  try {
    const len = Math.floor(ctx.sampleRate * 1.0)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    noiseBuffer = buf
    return buf
  } catch {
    return null
  }
}

function envGain(peak: number, startAt: number, dur: number): GainNode | null {
  if (!ctx || !master) return null
  try {
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, startAt)
    g.gain.exponentialRampToValueAtTime(peak, startAt + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, startAt + dur)
    g.connect(master)
    return g
  } catch {
    return null
  }
}

function synthTick(t0: number): void {
  if (!ctx) return
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(1150, t0)
  osc.frequency.exponentialRampToValueAtTime(640, t0 + 0.07)
  const g = envGain(0.16, t0, 0.09)
  if (!g) return
  osc.connect(g)
  osc.start(t0)
  osc.stop(t0 + 0.12)
}

function synthSwell(t0: number): void {
  if (!ctx) return
  const osc = ctx.createOscillator()
  osc.type = 'sawtooth'
  osc.frequency.setValueAtTime(180, t0)
  osc.frequency.exponentialRampToValueAtTime(540, t0 + 0.75)
  const lp = ctx.createBiquadFilter()
  lp.type = 'lowpass'
  lp.frequency.setValueAtTime(420, t0)
  lp.frequency.exponentialRampToValueAtTime(3400, t0 + 0.7)
  const g = ctx.createGain()
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(0.13, t0 + 0.45)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.85)
  osc.connect(lp)
  lp.connect(g)
  if (master) g.connect(master)
  osc.start(t0)
  osc.stop(t0 + 0.9)
}

function synthBoom(t0: number): void {
  if (!ctx) return
  const osc = ctx.createOscillator()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(150, t0)
  osc.frequency.exponentialRampToValueAtTime(42, t0 + 0.5)
  const g = envGain(0.5, t0, 0.85)
  if (g) {
    osc.connect(g)
    osc.start(t0)
    osc.stop(t0 + 0.9)
  }
  const noise = getNoise()
  if (noise) {
    const src = ctx.createBufferSource()
    src.buffer = noise
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 520
    const ng = envGain(0.22, t0, 0.3)
    if (ng) {
      src.connect(lp)
      lp.connect(ng)
      src.start(t0)
      src.stop(t0 + 0.32)
    }
  }
}

function synthFlip(t0: number): void {
  if (!ctx) return
  const noise = getNoise()
  if (!noise) return
  const src = ctx.createBufferSource()
  src.buffer = noise
  const bp = ctx.createBiquadFilter()
  bp.type = 'bandpass'
  bp.Q.value = 1.1
  bp.frequency.setValueAtTime(2600, t0)
  bp.frequency.exponentialRampToValueAtTime(520, t0 + 0.14)
  const g = envGain(0.2, t0, 0.16)
  if (!g) return
  src.connect(bp)
  bp.connect(g)
  src.start(t0)
  src.stop(t0 + 0.18)
}

/** Play a synthesized sting. Silent when muted, locked, or unsupported. */
export function play(sting: Sting): void {
  if (muted) return
  if (typeof window === 'undefined') return
  unlockAudio()
  if (!ctx || !master) return
  try {
    const t0 = ctx.currentTime + 0.001
    switch (sting) {
      case 'tick': synthTick(t0); break
      case 'swell': synthSwell(t0); break
      case 'boom': synthBoom(t0); break
      case 'flip': synthFlip(t0); break
    }
  } catch {
    /* never break gameplay over a sound */
  }
}

/** Convenience aliases matching the spec's sting names. */
export const sfx = {
  submitTick: () => play('tick'),
  revealSwell: () => play('swell'),
  landBoom: () => play('boom'),
  cardFlip: () => play('flip'),
} as const

// Unlock on the first user gesture anywhere (pointer OR keyboard), per
// autoplay policies. One-time listeners, cleaned up when either fires.
if (typeof document !== 'undefined') {
  const handler = () => {
    unlockAudio()
    document.removeEventListener('pointerdown', handler, true)
    document.removeEventListener('keydown', handler, true)
  }
  document.addEventListener('pointerdown', handler, { capture: true } as AddEventListenerOptions)
  document.addEventListener('keydown', handler, { capture: true } as AddEventListenerOptions)
}
