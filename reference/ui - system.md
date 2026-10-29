 0. Setup

```bash
npm install framer-motion canvas-confetti clsx
```

In `app/layout.tsx`, load fonts properly via `next/font` (self-hosted, no FOUT, works identically across all platforms):

```tsx
// app/layout.tsx
import localFont from 'next/font/local'
import { Inter } from 'next/font/google'

const clashDisplay = localFont({
  src: '../public/fonts/ClashDisplay-Variable.woff2', // download from fontshare.com
  variable: '--font-display',
  display: 'swap',
})

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-body',
  display: 'swap',
})

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${clashDisplay.variable} ${inter.variable}`}>
      <body className="bg-base text-white antialiased overflow-x-hidden">
        {children}
      </body>
    </html>
  )
}
```

Grab **Clash Display** free from fontshare.com — variable woff2, works on every platform fine.

---

## 1. Design tokens — `app/globals.css`

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  --bg-base: #0d0617;
  --purple-primary: #8b2fe0;
  --purple-deep: #4c1d95;
  --blue-secondary: #2f5fe0;
  --blue-glow: #3b82f6;
  --lime-accent: #b6ff3c;
  --white-text: #f5f3ff;
  --muted-text: rgba(245, 243, 255, 0.65);

  --ease-out-expo: cubic-bezier(0.16, 1, 0.3, 1);
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-smooth: cubic-bezier(0.65, 0, 0.35, 1);
}

html, body {
  background: var(--bg-base);
  /* dvh fixes iOS Safari's broken 100vh with the address bar */
  min-height: 100dvh;
}

body {
  font-family: var(--font-body), sans-serif;
}

h1, h2, h3, .font-display {
  font-family: var(--font-display), sans-serif;
  font-feature-settings: 'ss01' 1, 'cv05' 1;
}

/* Tabular numerals for vote counts/percentages */
.tabular-nums {
  font-variant-numeric: tabular-nums;
}

/* Grain overlay — the single biggest "expensive app" trick */
.grain-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  pointer-events: none;
  opacity: 0.035;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
}

/* Drifting ambient blobs */
@keyframes drift1 {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33% { transform: translate(5%, -8%) scale(1.1); }
  66% { transform: translate(-6%, 4%) scale(0.95); }
}
@keyframes drift2 {
  0%, 100% { transform: translate(0, 0) scale(1); }
  50% { transform: translate(-8%, 6%) scale(1.15); }
}

.blob {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  will-change: transform;
}

/* Glass card base — reused everywhere */
.glass-card {
  background: linear-gradient(145deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03));
  backdrop-filter: blur(24px) saturate(140%);
  -webkit-backdrop-filter: blur(24px) saturate(140%); /* iOS Safari requires prefix */
  border: 1px solid rgba(255,255,255,0.12);
  border-top: 1px solid rgba(255,255,255,0.25);
  box-shadow:
    0 20px 60px -10px rgba(76,29,149,0.5),
    inset 0 1px 0 rgba(255,255,255,0.1);
  border-radius: 28px;
}

/* Perf: lower-end Android chokes on heavy blur. Reduce it there. */
@media (max-width: 768px) {
  .glass-card {
    backdrop-filter: blur(14px) saturate(130%);
    -webkit-backdrop-filter: blur(14px) saturate(130%);
  }
  .blob {
    filter: blur(50px); /* cheaper blur radius on mobile GPUs */
  }
}

/* Respect accessibility setting, also doubles as a low-power-mode fallback */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 2. Tailwind config additions — `tailwind.config.ts`

```ts
import type { Config } from 'tailwindcss'

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        base: '#0d0617',
        purple: { primary: '#8b2fe0', deep: '#4c1d95' },
        blue: { secondary: '#2f5fe0', glow: '#3b82f6' },
        lime: { accent: '#b6ff3c' },
      },
      fontFamily: {
        display: ['var(--font-display)'],
        body: ['var(--font-body)'],
      },
      fontSize: {
        // clamp() = fluid across phone/tablet/laptop without manual breakpoints
        'display-xl': ['clamp(2.5rem, 7vw, 4rem)', { lineHeight: '0.95', letterSpacing: '-0.04em' }],
        'display-lg': ['clamp(1.9rem, 5vw, 2.5rem)', { lineHeight: '1.0', letterSpacing: '-0.03em' }],
        heading: ['clamp(1.1rem, 3vw, 1.5rem)', { lineHeight: '1.2', letterSpacing: '-0.02em' }],
      },
    },
  },
  plugins: [],
} satisfies Config
```

---

## 3. Shared motion variants — `lib/motion.ts`

```ts
import { Variants, Transition } from 'framer-motion'

export const easeOutExpo = [0.16, 1, 0.3, 1] as const
export const easeSpring = [0.34, 1.56, 0.64, 1] as const
export const easeSmooth = [0.65, 0, 0.35, 1] as const

export const springPop: Transition = { type: 'spring', stiffness: 260, damping: 20 }
export const springDramatic: Transition = { type: 'spring', stiffness: 120, damping: 14 }

// Standard page/screen transition — exit small+fast, enter bigger+slow
export const pageVariants: Variants = {
  initial: { opacity: 0, scale: 0.97, y: 12, filter: 'blur(4px)' },
  animate: {
    opacity: 1, scale: 1, y: 0, filter: 'blur(0px)',
    transition: { duration: 0.45, ease: easeOutExpo },
  },
  exit: {
    opacity: 0, scale: 0.96,
    transition: { duration: 0.15, ease: easeSmooth },
  },
}

// Stagger container for lists/cards
export const staggerContainer: Variants = {
  animate: { transition: { staggerChildren: 0.07, delayChildren: 0.1 } },
}

export const staggerItem: Variants = {
  initial: { opacity: 0, y: 16, filter: 'blur(4px)' },
  animate: {
    opacity: 1, y: 0, filter: 'blur(0px)',
    transition: { duration: 0.4, ease: easeOutExpo },
  },
}

// Word-by-word reveal for headlines
export const wordContainer: Variants = {
  animate: { transition: { staggerChildren: 0.1 } },
}
export const wordItem: Variants = {
  initial: { opacity: 0, y: 14, filter: 'blur(6px)' },
  animate: {
    opacity: 1, y: 0, filter: 'blur(0px)',
    transition: { duration: 0.5, ease: easeOutExpo },
  },
}
```

```tsx
// components/AnimatedWords.tsx — reusable word-by-word text reveal
'use client'
import { motion } from 'framer-motion'
import { wordContainer, wordItem } from '@/lib/motion'

export function AnimatedWords({
  text,
  highlightWord,
  className = '',
}: { text: string; highlightWord?: string; className?: string }) {
  const words = text.split(' ')
  return (
    <motion.h1
      variants={wordContainer}
      initial="initial"
      animate="animate"
      className={`font-display font-semibold flex flex-wrap justify-center gap-x-3 ${className}`}
    >
      {words.map((word, i) => {
        const isHighlight = highlightWord && word.toLowerCase().includes(highlightWord.toLowerCase())
        return (
          <motion.span
            key={i}
            variants={wordItem}
            className={isHighlight ? 'text-lime-accent' : 'text-white'}
            style={isHighlight ? { textShadow: '0 0 24px rgba(182,255,60,0.6)' } : undefined}
          >
            {word}
          </motion.span>
        )
      })}
    </motion.h1>
  )
}
```

---

## 4. Ambient background — `components/AmbientBackground.tsx`

Handles the drifting blobs, grain, and the **desktop-only** cursor glow (disabled on touch devices automatically — no point tracking a mouse that doesn't exist).

```tsx
'use client'
import { useEffect, useRef, useState } from 'react'

export function AmbientBackground() {
  const [isTouch, setIsTouch] = useState(true)
  const glowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIsTouch(window.matchMedia('(pointer: coarse)').matches)
  }, [])

  useEffect(() => {
    if (isTouch) return
    const handleMove = (e: MouseEvent) => {
      if (glowRef.current) {
        glowRef.current.style.transform = `translate(${e.clientX - 200}px, ${e.clientY - 200}px)`
      }
    }
    window.addEventListener('mousemove', handleMove)
    return () => window.removeEventListener('mousemove', handleMove)
  }, [isTouch])

  return (
    <div className="fixed inset-0 overflow-hidden -z-10 bg-base">
      <div
        className="blob w-[50vw] h-[50vw] top-[-10%] left-[-10%]"
        style={{ background: 'radial-gradient(circle, var(--purple-primary), transparent 70%)', animation: 'drift1 18s ease-in-out infinite' }}
      />
      <div
        className="blob w-[45vw] h-[45vw] bottom-[-15%] right-[-10%]"
        style={{ background: 'radial-gradient(circle, var(--blue-secondary), transparent 70%)', animation: 'drift2 22s ease-in-out infinite' }}
      />
      <div
        className="blob w-[30vw] h-[30vw] top-[30%] left-[40%] opacity-40"
        style={{ background: 'radial-gradient(circle, var(--purple-deep), transparent 70%)', animation: 'drift1 25s ease-in-out infinite reverse' }}
      />
      {/* Desktop-only cursor glow */}
      {!isTouch && (
        <div
          ref={glowRef}
          className="absolute w-[400px] h-[400px] rounded-full pointer-events-none transition-transform duration-300 ease-out"
          style={{ background: 'radial-gradient(circle, rgba(182,255,60,0.08), transparent 70%)' }}
        />
      )}
      <div className="grain-overlay" />
    </div>
  )
}
```

Mount this once in the root layout, behind everything:
```tsx
<body>
  <AmbientBackground />
  {children}
</body>
```

---

## 5. The Flame — `components/Flame.tsx`

Pure CSS/SVG, no Lottie dependency (smaller bundle, renders identically on iOS/Android/desktop, no external asset to fail-load). Lime-to-purple gradient flame — your signature visual.

```tsx
'use client'
import { motion } from 'framer-motion'

export function Flame({ size = 140 }: { size?: number }) {
  return (
    <div className="relative flex items-center justify-center" style={{ width: size, height: size }}>
      {/* Glow bloom behind flame */}
      <motion.div
        className="absolute rounded-full"
        style={{
          width: size * 1.8, height: size * 1.8,
          background: 'radial-gradient(circle, rgba(182,255,60,0.35), rgba(139,47,224,0.2) 50%, transparent 75%)',
          filter: 'blur(20px)',
        }}
        animate={{ opacity: [0.6, 1, 0.6], scale: [0.9, 1.05, 0.9] }}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      />

      {/* Embers */}
      {Array.from({ length: 7 }).map((_, i) => (
        <motion.div
          key={i}
          className="absolute rounded-full bg-lime-accent"
          style={{ width: 3, height: 3, bottom: size * 0.3, left: `${45 + Math.random() * 10}%` }}
          animate={{
            y: [0, -size * 1.2],
            x: [0, (Math.random() - 0.5) * 40],
            opacity: [0, 1, 0],
          }}
          transition={{
            duration: 1.8 + Math.random(),
            repeat: Infinity,
            delay: i * 0.25,
            ease: 'easeOut',
          }}
        />
      ))}

      {/* Flame body — layered SVG paths animating independently for organic flicker */}
      <svg width={size} height={size} viewBox="0 0 100 140" className="relative z-10">
        <defs>
          <linearGradient id="flameGrad" x1="0%" y1="100%" x2="0%" y2="0%">
            <stop offset="0%" stopColor="#8b2fe0" />
            <stop offset="55%" stopColor="#b6ff3c" />
            <stop offset="100%" stopColor="#f5f3ff" />
          </linearGradient>
        </defs>

        <motion.path
          d="M50 140 C20 110 15 75 35 45 C40 65 50 65 48 45 C65 65 85 95 65 125 C75 110 72 95 65 90 C68 115 58 130 50 140 Z"
          fill="url(#flameGrad)"
          style={{ transformOrigin: '50% 100%' }}
          animate={{ scaleY: [1, 1.08, 0.96, 1.05, 1], scaleX: [1, 0.95, 1.04, 0.97, 1] }}
          transition={{ duration: 0.6, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.path
          d="M50 140 C30 115 28 85 42 55 C45 72 50 72 48 55 C60 75 72 100 58 125 Z"
          fill="#f5f3ff"
          opacity={0.5}
          style={{ transformOrigin: '50% 100%' }}
          animate={{ scaleY: [1, 0.92, 1.06, 0.98, 1], scaleX: [1, 1.05, 0.95, 1.02, 1] }}
          transition={{ duration: 0.45, repeat: Infinity, ease: 'easeInOut', delay: 0.1 }}
        />
      </svg>
    </div>
  )
}
```

---

## 6. The Opening Sequence — `components/OpeningSequence.tsx`

The full orchestrated flow: idle orb → press → circular wipe → words → flame → transition out. This is the centerpiece.

```tsx
'use client'
import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Flame } from './Flame'
import { AnimatedWords } from './AnimatedWords'
import { easeOutExpo } from '@/lib/motion'

type Beat = 'idle' | 'wipe' | 'words' | 'flame' | 'done'

export function OpeningSequence({ onComplete }: { onComplete: () => void }) {
  const [beat, setBeat] = useState<Beat>('idle')
  const [pressed, setPressed] = useState(false)

  const handlePress = () => {
    if ('vibrate' in navigator) {
      try { navigator.vibrate(10) } catch {} // iOS Safari lacks this — fails silently, that's fine
    }
    setPressed(true)
    setBeat('wipe')
    setTimeout(() => setBeat('words'), 650)
    setTimeout(() => setBeat('flame'), 2000)
    setTimeout(() => setBeat('done'), 3600)
    setTimeout(() => onComplete(), 4200)
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center overflow-hidden">
      <AnimatePresence mode="wait">
        {beat === 'idle' && (
          <motion.button
            key="orb"
            onClick={handlePress}
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            className="relative flex flex-col items-center gap-5 group"
            whileTap={{ scale: 0.9 }}
          >
            <div className="relative w-28 h-28 md:w-32 md:h-32 rounded-full glass-card flex items-center justify-center">
              <motion.div
                className="absolute inset-[-6px] rounded-full border border-lime-accent/40"
                animate={{ scale: [1, 1.08, 1], opacity: [0.6, 1, 0.6] }}
                transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
              />
              <motion.div
                className="w-full h-full rounded-full"
                animate={{ scale: [1, 1.02, 1] }}
                transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
              />
            </div>
            <span className="text-xs tracking-[0.2em] text-white/60 uppercase font-medium">
              Tap to begin
            </span>
          </motion.button>
        )}
      </AnimatePresence>

      {/* Circular wipe mask transition */}
      <AnimatePresence>
        {pressed && beat === 'wipe' && (
          <motion.div
            className="fixed rounded-full bg-purple-primary z-20"
            style={{ width: 40, height: 40 }}
            initial={{ scale: 0, opacity: 1 }}
            animate={{ scale: 60, opacity: 1 }}
            transition={{ duration: 0.65, ease: easeOutExpo }}
          />
        )}
      </AnimatePresence>

      {/* Words beat */}
      <AnimatePresence>
        {beat === 'words' && (
          <motion.div
            key="words"
            className="fixed inset-0 flex items-center justify-center z-30 px-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
          >
            <AnimatedWords
              text="Who's ready to get spicy"
              highlightWord="spicy"
              className="text-display-lg md:text-display-xl text-center max-w-xl"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Flame beat */}
      <AnimatePresence>
        {beat === 'flame' && (
          <motion.div
            key="flame"
            className="fixed inset-0 flex items-center justify-center z-30"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.3, transition: { duration: 0.4, ease: easeOutExpo } }}
          >
            <motion.div
              initial={{ scale: 0 }}
              animate={{ scale: [0, 1.15, 1] }}
              transition={{ duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
            >
              <Flame size={160} />
            </motion.div>
            {/* Lime vignette flash on flame impact */}
            <motion.div
              className="fixed inset-0 pointer-events-none"
              style={{ background: 'radial-gradient(circle, transparent 40%, rgba(182,255,60,0.15) 100%)' }}
              initial={{ opacity: 0 }}
              animate={{ opacity: [0, 0.6, 0] }}
              transition={{ duration: 0.5, delay: 0.3 }}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
```

Usage at the app root:
```tsx
'use client'
import { useState } from 'react'
import { OpeningSequence } from '@/components/OpeningSequence'
import { JoinScreen } from '@/components/JoinScreen'

export default function PlayPage() {
  const [opened, setOpened] = useState(false)
  return opened ? <JoinScreen /> : <OpeningSequence onComplete={() => setOpened(true)} />
}
```

---

## 7. Glass Card primitive — `components/GlassCard.tsx`

```tsx
'use client'
import { motion, HTMLMotionProps } from 'framer-motion'
import { clsx } from 'clsx'

export function GlassCard({ className, children, ...props }: HTMLMotionProps<'div'> & { className?: string }) {
  return (
    <motion.div
      className={clsx('glass-card p-6 md:p-8', className)}
      whileHover={{ y: -4, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } }}
      {...props}
    >
      {children}
    </motion.div>
  )
}
```

---

## 8. Tactile button with lime glow bloom — `components/GlowButton.tsx`

```tsx
'use client'
import { motion } from 'framer-motion'
import { useState } from 'react'
import { clsx } from 'clsx'

export function GlowButton({
  children, onClick, variant = 'primary', disabled, className,
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'primary' | 'accent'
  disabled?: boolean
  className?: string
}) {
  const [ripple, setRipple] = useState(false)

  const handleTap = () => {
    if (disabled) return
    setRipple(true)
    setTimeout(() => setRipple(false), 400)
    onClick?.()
  }

  return (
    <motion.button
      onClick={handleTap}
      disabled={disabled}
      whileTap={!disabled ? { scale: 0.96 } : undefined}
      transition={{ type: 'spring', stiffness: 400, damping: 15 }}
      className={clsx(
        'relative overflow-hidden rounded-2xl px-6 py-3.5 font-medium text-white min-h-[48px]', // 48px = comfortable touch target
        'transition-opacity',
        disabled && 'opacity-40 cursor-not-allowed',
        variant === 'primary' && 'bg-gradient-to-r from-purple-primary to-blue-secondary',
        variant === 'accent' && 'glass-card border-lime-accent/50 text-lime-accent',
        className
      )}
    >
      {ripple && (
        <motion.span
          className="absolute inset-0 rounded-2xl"
          style={{ background: 'radial-gradient(circle, rgba(182,255,60,0.4), transparent 70%)' }}
          initial={{ opacity: 0.5, scale: 0.5 }}
          animate={{ opacity: 0, scale: 1.8 }}
          transition={{ duration: 0.4 }}
        />
      )}
      <span className="relative z-10">{children}</span>
    </motion.button>
  )
}
```

---

## 9. Cross-platform checklist (give this straight to the agent as non-negotiable)

1. **Use `dvh` not `vh`** for any full-screen container — iOS Safari's address bar breaks `100vh`.
2. **All blur-heavy effects get a lighter mobile variant** via the `@media (max-width: 768px)` block already in globals.css — don't let anyone skip this, it's the #1 cause of janky frame rates on mid-range Android.
3. **Touch targets minimum 48x48px** on every tappable element (already baked into `GlowButton`).
4. **`-webkit-backdrop-filter` must always accompany `backdrop-filter`** — iOS Safari silently ignores glass effects otherwise.
5. **Feature-detect `navigator.vibrate`** — iOS Safari doesn't have it, wrap in try/catch (done above).
6. **Font sizes use `clamp()`**, never fixed px for headlines — already in the Tailwind config, so phone/tablet/laptop scale automatically without separate breakpoint rules.
7. **Test the opening sequence specifically on an actual iPhone and an actual Android** before tomorrow — the circular wipe + flame beat is layered animation and is the most likely place Safari's compositor behaves differently than Chrome.
8. **Cursor glow effect is desktop-only** (host laptop), gated by `matchMedia('(pointer: coarse)')` — don't let it run on touch devices, it's dead code there and wastes a mousemove listener.
9. **`prefers-reduced-motion`** fallback is in globals.css — don't remove it, it also acts as a safety net for very low-end devices even if the user hasn't set the OS setting.

---

