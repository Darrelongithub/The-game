// components/ShareCard.tsx — the shareable PNG (canvas 1080×1350):
// dark base + grain + heat gradient + summary lines (ship/besties/toxic/rivals
// from FinaleView.summary) + room code + "THE ROOM HAS SPOKEN".
// Download = canvas.toBlob → a[download]. NEVER includes secret card content
// (spec §7 — the share card is built from FinaleView.summary ONLY).
'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FinaleView } from '../../../../packages/shared/src/contracts.ts'
import { GlowButton } from './GlowButton'
import { haptic } from './feedback'

const W = 1080
const H = 1350

// Deterministic PRNG so the grain (and therefore the PNG) is stable redraws.
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function readFontVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch {
    return fallback
  }
}

function displayFont(weight: number, size: number): string {
  return `${weight} ${size}px ${readFontVar('--font-display', '"Clash Display", "Inter", system-ui, sans-serif')}`
}

function bodyFont(weight: number, size: number): string {
  return `${weight} ${size}px ${readFontVar('--font-body', '"Inter", system-ui, sans-serif')}`
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const probe = line ? `${line} ${word}` : word
    if (ctx.measureText(probe).width > maxWidth && line) {
      lines.push(line)
      line = word
    } else {
      line = probe
    }
  }
  if (line) lines.push(line)
  return lines
}

const SUMMARY_ORDER: { key: 'ship' | 'besties' | 'toxic' | 'rivals'; label: string }[] = [
  { key: 'ship', label: 'THE SHIP' },
  { key: 'besties', label: 'BESTIES' },
  { key: 'toxic', label: 'MOST TOXIC' },
  { key: 'rivals', label: 'RIVALS' },
]

export function ShareCard({
  view,
  roomCode,
  className = '',
}: {
  view: FinaleView
  roomCode?: string
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return // jsdom / context loss — degrade silently

    try {
      canvas.width = W
      canvas.height = H
      const rnd = mulberry32(0x5eed)

      // ── base ────────────────────────────────────────────────────────
      ctx.fillStyle = '#0d0617'
      ctx.fillRect(0, 0, W, H)

      // ── heat gradient + blobs ───────────────────────────────────────
      const diag = ctx.createLinearGradient(0, 0, W, H)
      diag.addColorStop(0, 'rgba(139,47,224,0.55)')
      diag.addColorStop(0.5, 'rgba(47,95,224,0.22)')
      diag.addColorStop(1, 'rgba(182,255,60,0.28)')
      ctx.fillStyle = diag
      ctx.fillRect(0, 0, W, H)

      const glowTL = ctx.createRadialGradient(80, 120, 0, 80, 120, 720)
      glowTL.addColorStop(0, 'rgba(139,47,224,0.65)')
      glowTL.addColorStop(1, 'rgba(139,47,224,0)')
      ctx.fillStyle = glowTL
      ctx.fillRect(0, 0, W, H)

      const glowBR = ctx.createRadialGradient(W - 60, H - 80, 0, W - 60, H - 80, 640)
      glowBR.addColorStop(0, 'rgba(182,255,60,0.35)')
      glowBR.addColorStop(1, 'rgba(182,255,60,0)')
      ctx.fillStyle = glowBR
      ctx.fillRect(0, 0, W, H)

      // ── grain (seeded) ──────────────────────────────────────────────
      ctx.fillStyle = 'rgba(245,243,255,0.05)'
      for (let i = 0; i < 5200; i++) {
        const x = rnd() * W
        const y = rnd() * H
        const s = rnd() < 0.85 ? 1.6 : 3
        ctx.fillRect(x, y, s, s)
      }

      // ── top chip ────────────────────────────────────────────────────
      ctx.font = bodyFont(600, 26)
      ctx.fillStyle = 'rgba(182,255,60,0.9)'
      ctx.textBaseline = 'alphabetic'
      try {
        ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '6px'
      } catch {
        /* letterSpacing unsupported — fine */
      }
      ctx.fillText('THE REVEAL GAME · 18+', 84, 130)
      try {
        ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px'
      } catch {
        /* fine */
      }

      // lime rule under the chip
      ctx.fillStyle = '#b6ff3c'
      ctx.fillRect(84, 158, 120, 6)

      // ── headline ────────────────────────────────────────────────────
      ctx.font = displayFont(700, 108)
      ctx.fillStyle = '#f5f3ff'
      let y = 300
      const headLines = wrapLines(ctx, 'THE ROOM HAS SPOKEN', W - 168)
      for (const line of headLines) {
        ctx.fillText(line, 84, y)
        y += 116
      }

      // ── summary lines ───────────────────────────────────────────────
      y = Math.max(y + 60, 560)
      const summary = view.summary ?? {}
      const blocks = SUMMARY_ORDER.filter(({ key }) => Boolean(summary[key]))
      if (blocks.length === 0) {
        ctx.font = bodyFont(500, 40)
        ctx.fillStyle = 'rgba(245,243,255,0.75)'
        for (const line of wrapLines(ctx, view.slides[0]?.title ?? 'A night to remember', W - 168)) {
          ctx.fillText(line, 84, y)
          y += 56
        }
      }
      for (const { key, label } of blocks) {
        const value = summary[key] as string
        ctx.font = bodyFont(700, 26)
        ctx.fillStyle = 'rgba(182,255,60,0.85)'
        try {
          ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '4px'
        } catch {
          /* fine */
        }
        ctx.fillText(label, 84, y)
        try {
          ;(ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = '0px'
        } catch {
          /* fine */
        }
        y += 46

        ctx.font = displayFont(600, 52)
        ctx.fillStyle = '#f5f3ff'
        for (const line of wrapLines(ctx, value, W - 200)) {
          ctx.fillText(line, 84, y)
          y += 62
        }
        y += 34
      }

      // ── footer: room code pill + tagline ────────────────────────────
      const pillText = roomCode ? `ROOM ${roomCode}` : 'THE ROOM HAS SPOKEN'
      ctx.font = bodyFont(700, 34)
      const pillW = ctx.measureText(pillText).width + 88
      const pillX = (W - pillW) / 2
      const pillY = H - 160
      ctx.strokeStyle = 'rgba(245,243,255,0.35)'
      ctx.lineWidth = 2
      ctx.beginPath()
      const r = 44
      ctx.moveTo(pillX + r, pillY)
      ctx.arcTo(pillX + pillW, pillY, pillX + pillW, pillY + 88, r)
      ctx.arcTo(pillX + pillW, pillY + 88, pillX, pillY + 88, r)
      ctx.arcTo(pillX, pillY + 88, pillX, pillY, r)
      ctx.arcTo(pillX, pillY, pillX + pillW, pillY, r)
      ctx.closePath()
      ctx.stroke()
      ctx.fillStyle = '#f5f3ff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(pillText, W / 2, pillY + 45)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'

      setReady(true)
    } catch {
      // Canvas hiccups must never block the finale.
      setReady(false)
    }
  }, [view, roomCode])

  useEffect(() => {
    draw()
  }, [draw])

  const download = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    setBusy(true)
    haptic(12)
    try {
      canvas.toBlob((blob) => {
        setBusy(false)
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `the-room-has-spoken${roomCode ? `-${roomCode}` : ''}.png`
        document.body.appendChild(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 4000)
      }, 'image/png')
    } catch {
      setBusy(false)
    }
  }

  return (
    <div className={`flex flex-col items-center gap-4 ${className}`} data-testid="share-card">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Share card: The room has spoken"
        className="w-full max-w-[320px] rounded-3xl border border-white/15 shadow-[0_24px_80px_-20px_rgba(76,29,149,0.8)]"
        data-testid="share-canvas"
      />
      <GlowButton onClick={download} disabled={!ready || busy} className="w-full max-w-[320px]">
        {busy ? 'Saving…' : 'Download PNG'}
      </GlowButton>
    </div>
  )
}
