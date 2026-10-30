'use client'
// components/GlowButton.tsx — verbatim from reference/ui-system.md §8
import { motion } from 'framer-motion'
import { useEffect, useRef, useState } from 'react'
import { clsx } from 'clsx'

export function GlowButton({
  children, onClick, variant = 'primary', disabled, className, type = 'button',
}: {
  children: React.ReactNode
  onClick?: () => void
  variant?: 'primary' | 'accent'
  disabled?: boolean
  className?: string
  type?: 'button' | 'submit'
}) {
  const [ripple, setRipple] = useState(false)
  const rippleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // timer cleanup: never leave a pending setState on an unmounted button
  useEffect(() => () => { if (rippleTimer.current) clearTimeout(rippleTimer.current) }, [])

  const handleTap = () => {
    if (disabled) return
    setRipple(true)
    if (rippleTimer.current) clearTimeout(rippleTimer.current)
    rippleTimer.current = setTimeout(() => setRipple(false), 400)
    onClick?.()
  }

  return (
    <motion.button
      type={type}
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
          style={{ background: 'radial-gradient(circle, rgba(255,195,255,0.4), transparent 70%)' }}
          initial={{ opacity: 0.5, scale: 0.5 }}
          animate={{ opacity: 0, scale: 1.8 }}
          transition={{ duration: 0.4 }}
        />
      )}
      <span className="relative z-10">{children}</span>
    </motion.button>
  )
}
