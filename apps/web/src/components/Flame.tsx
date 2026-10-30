'use client'
// A recognizable layered flame, with CSS-only flicker and stable SVG IDs.
import { useId } from 'react'

export function Flame({ size = 140 }: { size?: number }) {
  const id = useId().replace(/:/g, '')
  const outer = `flame-outer-${id}`
  const inner = `flame-inner-${id}`
  return (
    <div className="flame-mark" style={{ width: size, height: size }} role="img" aria-label="Flame">
      <div className="flame-glow" aria-hidden="true" />
      <svg className="flame-shape" width={size} height={size} viewBox="0 0 100 112" aria-hidden="true">
        <defs>
          <linearGradient id={outer} x1="15%" y1="100%" x2="75%" y2="0%">
            <stop offset="0%" stopColor="#7928ca" />
            <stop offset="48%" stopColor="#e83dc4" />
            <stop offset="100%" stopColor="#ffe1f9" />
          </linearGradient>
          <linearGradient id={inner} x1="50%" y1="100%" x2="50%" y2="0%">
            <stop offset="0%" stopColor="#f7a7f3" />
            <stop offset="100%" stopColor="#fff4fb" />
          </linearGradient>
        </defs>
        <path fill={`url(#${outer})`} d="M51 4c2 20 17 27 25 43 13 25 3 53-26 57-26 3-40-14-36-36 2-13 10-24 20-33-1 11 3 18 8 21 6-13 12-28 9-52Z" />
        <path fill={`url(#${inner})`} d="M50 99c-14 0-22-9-19-21 2-9 9-15 12-24 1 10 5 14 9 16 3-5 4-10 4-15 11 10 17 19 15 28-2 10-10 16-21 16Z" />
      </svg>
    </div>
  )
}
